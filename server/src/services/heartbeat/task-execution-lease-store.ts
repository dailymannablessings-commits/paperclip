import {randomUUID} from 'node:crypto';
import {and,eq,inArray,or,sql} from 'drizzle-orm';
import type {Db} from '@paperclipai/db';
import {activityLog,agents,agentWakeupRequests,heartbeatRuns,issues,issueComments,nativeRunFinalizations} from '@paperclipai/db';
import {evaluateAgentInvokabilityFromDb} from '../agent-invokability.js';
import {conflict} from '../../errors.js';
import {admitPausedTaskExecution,canonicalHash,executionControlHash,PAUSED_TASK_LEASE_KEY,verifyPausedTaskExecution,taskLeaseFromContext,type PausedExecutionAgent,type PausedExecutionRequest,type PausedTaskLease} from './paused-task-execution.js';

type Run=typeof heartbeatRuns.$inferSelect;
function object(value:unknown):Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};}
function controls(agent:typeof agents.$inferSelect):PausedExecutionAgent{return {
 id:agent.id,companyId:agent.companyId,status:agent.status,adapterType:agent.adapterType,
 role:agent.role,capabilities:agent.capabilities,pauseReason:agent.pauseReason,pausedAt:agent.pausedAt,
 adapterConfig:object(agent.adapterConfig),runtimeConfig:object(agent.runtimeConfig),budgetMonthlyCents:agent.budgetMonthlyCents,
 reportsTo:agent.reportsTo,permissions:object(agent.permissions),
};}
export function taskExecutionControlSeal(agent:typeof agents.$inferSelect){
 const authoritative=controls(agent);
 return {agentId:agent.id,companyId:agent.companyId,status:agent.status,expectedControlHash:executionControlHash(authoritative),expectedModel:typeof authoritative.adapterConfig.model==='string'?authoritative.adapterConfig.model:null};
}
/** Public service projections normalize permissions. Seal only fresh persisted controls. */
export async function readTaskExecutionControlSeal(db:Db,agentId:string,companyId:string){
 const [agent]=await db.select().from(agents).where(and(eq(agents.id,agentId),eq(agents.companyId,companyId)));
 if(!agent||agent.id!==agentId||agent.companyId!==companyId)return null;
 return taskExecutionControlSeal(agent);
}
export function hasTaskExecutionLease(run:Pick<Run,'contextSnapshot'>):boolean{return Object.hasOwn(object(run.contextSnapshot),PAUSED_TASK_LEASE_KEY);}
export async function validTaskExecutionLease(db:Db,run:Run,now=new Date()):Promise<boolean>{
 try{
  if(!hasTaskExecutionLease(run)||!run.wakeupRequestId||run.retryOfRunId)return false;
  const lease=taskLeaseFromContext(run.contextSnapshot);if(!lease)return false;
  // Callers may hold a pre-terminalization snapshot (PRP requests and provider
  // startup both cross awaits). A copied receipt is not the canonical run.
  const [currentRun]=await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,run.id),eq(heartbeatRuns.companyId,run.companyId),eq(heartbeatRuns.agentId,run.agentId)));
  if(!currentRun || !['queued','running'].includes(currentRun.status) || currentRun.retryOfRunId ||
   currentRun.processLossRetryCount!==0 || currentRun.scheduledRetryAttempt!==0 || currentRun.continuationAttempt!==0 || currentRun.scheduledRetryReason!==null ||
   currentRun.wakeupRequestId!==run.wakeupRequestId || currentRun.invocationSource!=='on_demand' ||
   currentRun.triggerDetail!=='manual' || currentRun.responsibleUserId!==lease.actorUserId ||
   canonicalHash(taskLeaseFromContext(currentRun.contextSnapshot))!==canonicalHash(lease))return false;
  const [agent]=await db.select().from(agents).where(and(eq(agents.id,run.agentId),eq(agents.companyId,run.companyId)));
  const [issue]=await db.select().from(issues).where(and(eq(issues.id,lease.issueId),eq(issues.companyId,run.companyId)));
  const [wake]=await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.id,run.wakeupRequestId),eq(agentWakeupRequests.companyId,run.companyId),eq(agentWakeupRequests.agentId,run.agentId),eq(agentWakeupRequests.runId,run.id)));
  if(!agent||!issue||!wake||wake.reason!=='bounded_task_execution'||!['queued','claimed'].includes(wake.status)||wake.finishedAt!==null||wake.source!=='on_demand'||wake.triggerDetail!=='manual'||run.invocationSource!=='on_demand'||run.triggerDetail!=='manual')return false;
  const otherwise=await evaluateAgentInvokabilityFromDb(db,agent.status==='paused'?{...agent,status:'idle'}:agent);
  return verifyPausedTaskExecution({lease,canonicalLease:object(wake.payload)[PAUSED_TASK_LEASE_KEY],agent:controls(agent),issue,
   runId:run.id,wakeId:wake.id,now,canonicalActorType:wake.requestedByActorType,canonicalActorId:wake.requestedByActorId,otherwiseEligible:otherwise.invokable});
 }catch{return false;}
}
/** Board route only. Agent lock serializes idempotency, task staging and active-work admission. */
export async function createTaskExecutionLease(db:Db,input:{companyId:string;agentId:string;actorUserId:string;request:PausedExecutionRequest;now?:Date}):Promise<Run>{
 const now=input.now??new Date();
 return db.transaction(async raw=>{
  const tx=raw as unknown as Db;
  await tx.execute(sql`select set_config('statement_timeout','10000',true),set_config('lock_timeout','1000',true)`);
  const [agent]=await tx.select().from(agents).where(and(eq(agents.id,input.agentId),eq(agents.companyId,input.companyId))).for('update');
  if(!agent)throw conflict('Agent no longer exists');
  const existing=await tx.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId,input.companyId),eq(agentWakeupRequests.agentId,input.agentId),eq(agentWakeupRequests.idempotencyKey,'bounded-task:'+input.request.idempotencyKey)));
  if(existing.length){
   if(existing.length!==1)throw conflict('Ambiguous bounded execution receipt');
   const wake=existing[0];const lease=object(wake.payload)[PAUSED_TASK_LEASE_KEY] as PausedTaskLease|undefined;
   if(!lease||wake.reason!=='bounded_task_execution'||wake.requestedByActorType!=='user'||wake.requestedByActorId!==input.actorUserId||
    lease.issueId!==input.request.issueId||lease.headSha!==input.request.headSha||lease.controlHash!==input.request.expectedControlHash||
    lease.scopeHash!==canonicalHash(input.request.scopeDescription)||lease.profileHash!==canonicalHash(input.request.profile)||lease.expiresAt!==new Date(input.request.expiresAt).toISOString())throw conflict('Bounded execution request identity changed');
   const [run]=await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,lease.runId),eq(heartbeatRuns.companyId,input.companyId),eq(heartbeatRuns.agentId,input.agentId),eq(heartbeatRuns.wakeupRequestId,wake.id)));
   if(!run||wake.runId!==run.id)throw conflict('Bounded execution receipt is incomplete');
   return run; // Lost-response recovery never creates another wake or changes the original clock.
  }
  const [issue]=await tx.select().from(issues).where(and(eq(issues.id,input.request.issueId),eq(issues.companyId,input.companyId))).for('update');
  if(!issue)throw conflict('Task no longer exists');
  const active=await tx.select({id:heartbeatRuns.id}).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId,input.companyId),eq(heartbeatRuns.agentId,input.agentId),or(eq(heartbeatRuns.status,'running'),and(inArray(heartbeatRuns.status,['queued','scheduled_retry']),sql`${heartbeatRuns.contextSnapshot}->${PAUSED_TASK_LEASE_KEY} is not null`)))).limit(1);
  const original=await evaluateAgentInvokabilityFromDb(tx,agent);
  const otherwise=await evaluateAgentInvokabilityFromDb(tx,agent.status==='paused'?{...agent,status:'idle'}:agent);
  let admitted;
  try{admitted=admitPausedTaskExecution({agent:controls(agent),issue,request:input.request,actorUserId:input.actorUserId,wakeId:randomUUID(),runId:randomUUID(),now,hasRunningWork:active.length>0,originalInvokability:original,pausedOnlyInvokability:otherwise});}
  catch{throw conflict('Bounded execution admission failed; staging, controls, eligibility or expiry changed');}
  const lease=admitted.lease;
  await tx.insert(agentWakeupRequests).values({id:lease.id,companyId:input.companyId,agentId:input.agentId,source:'on_demand',triggerDetail:'manual',reason:'bounded_task_execution',payload:{issueId:issue.id,[PAUSED_TASK_LEASE_KEY]:lease},status:'queued',requestedByActorType:'user',requestedByActorId:input.actorUserId,idempotencyKey:'bounded-task:'+input.request.idempotencyKey,runId:lease.runId,requestedAt:now});
  const [run]=await tx.insert(heartbeatRuns).values({id:lease.runId,companyId:input.companyId,agentId:input.agentId,status:'queued',invocationSource:'on_demand',triggerDetail:'manual',wakeupRequestId:lease.id,responsibleUserId:input.actorUserId,contextSnapshot:{issueId:issue.id,taskId:issue.id,taskKey:issue.id,forceFreshSession:true,wakeReason:'bounded_task_execution',wakeSource:'on_demand',wakeTriggerDetail:'manual',[PAUSED_TASK_LEASE_KEY]:lease}}).returning();
  await tx.update(issues).set({assigneeAgentId:input.agentId,assigneeAdapterOverrides:admitted.profile,description:admitted.scopeDescription,status:'in_progress',startedAt:issue.startedAt??now,updatedAt:now}).where(and(eq(issues.id,issue.id),eq(issues.companyId,input.companyId)));
  await tx.insert(activityLog).values({companyId:input.companyId,actorType:'user',actorId:input.actorUserId,action:'heartbeat.bounded_execution_created',entityType:'heartbeat_run',entityId:run.id,runId:run.id,details:{issueId:issue.id,agentId:input.agentId,headSha:lease.headSha,expiresAt:lease.expiresAt,originalStatus:lease.originalStatus}});
  return run;
 });
}
/** Reserved context cannot be granted by ordinary wake callers or copied into a retry. */
export function stripTaskExecutionLease(context:Record<string,unknown>,payload:Record<string,unknown>|null):void{
 delete context[PAUSED_TASK_LEASE_KEY];if(payload)delete payload[PAUSED_TASK_LEASE_KEY];
}

/** Release only this executor's task pointers; never promote old comments or queue recovery. */
export async function releaseTaskExecutionLease(db:Db,run:Run):Promise<void>{
 if(!hasTaskExecutionLease(run)||!run.wakeupRequestId||!['succeeded','failed','cancelled','timed_out','interrupted'].includes(run.status))return;
 const lease=object(run.contextSnapshot)[PAUSED_TASK_LEASE_KEY] as PausedTaskLease;
 await db.transaction(async raw=>{
  const tx=raw as unknown as Db;
  const [issue]=await tx.select().from(issues).where(and(eq(issues.companyId,run.companyId),eq(issues.id,lease.issueId))).for('update');
  const [wake]=await tx.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId,run.companyId),eq(agentWakeupRequests.id,run.wakeupRequestId!),eq(agentWakeupRequests.runId,run.id),eq(agentWakeupRequests.reason,'bounded_task_execution')));
  if(!issue||!wake||lease.runId!==run.id||lease.id!==wake.id||canonicalHash(object(wake.payload)[PAUSED_TASK_LEASE_KEY])!==canonicalHash(lease))throw conflict('Bounded execution release identity changed');
  await tx.update(issues).set({executionRunId:null,executionAgentNameKey:null,executionLockedAt:null}).where(and(eq(issues.companyId,run.companyId),eq(issues.id,issue.id),eq(issues.executionRunId,run.id)));
  await tx.update(issues).set({checkoutRunId:null}).where(and(eq(issues.companyId,run.companyId),eq(issues.id,issue.id),eq(issues.checkoutRunId,run.id)));
 });
}

export async function canonicalTaskExecutionLease(db:Db,run:Run):Promise<PausedTaskLease|null>{
 const lease=taskLeaseFromContext(run.contextSnapshot);
 if(!lease||lease.runId!==run.id||lease.id!==run.wakeupRequestId||lease.companyId!==run.companyId||lease.agentId!==run.agentId||run.retryOfRunId||run.invocationSource!=='on_demand'||run.triggerDetail!=='manual'||run.responsibleUserId!==lease.actorUserId)return null;
 const [wake]=await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.id,lease.id),eq(agentWakeupRequests.companyId,run.companyId),eq(agentWakeupRequests.agentId,run.agentId),eq(agentWakeupRequests.runId,run.id),eq(agentWakeupRequests.reason,'bounded_task_execution'),eq(agentWakeupRequests.requestedByActorType,'user'),eq(agentWakeupRequests.requestedByActorId,lease.actorUserId)));
 return wake&&wake.source==='on_demand'&&wake.triggerDetail==='manual'&&canonicalHash(object(wake.payload)[PAUSED_TASK_LEASE_KEY])===canonicalHash(lease)?lease:null;
}

/** Receipt lineage is authority evidence even after the canonical parent finishes.
 * Direct database producers must not turn a single-use board run into an ordinary
 * child, including a child assigned to another agent. This is read-only: foreign
 * or ambiguous rows are never cancelled merely because they resemble a receipt.
 */
export async function hasTaskExecutionLeaseAncestor(db:Db,run:Run):Promise<boolean>{
 const keys=['retryOfRunId','sourceRunId','parentRunId','predecessorRunId','goalRolloverFromRunId','livenessContinuationSourceRunId'];
 const pending:string[]=[];
 const commentIds=new Set<string>();
 let uncertain=false;
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
 const collect=(value:unknown)=>{
  const context=object(value);
  for(const key of keys)if(typeof context[key]==='string'&&context[key])pending.push(context[key] as string);
  for(const value of [context,object(context._paperclipWakeContext)])for(const key of ["commentId","wakeCommentId"])if(typeof value[key]==="string"&&uuid.test(value[key] as string))commentIds.add(value[key] as string);
  for(const value of [context,object(context._paperclipWakeContext)])for(const key of ["commentIds","wakeCommentIds"]){
   const ids=value[key];
   if(!Array.isArray(ids))continue;
   // Bound the raw input, before filtering or deduplication can hide omitted lineage.
   if(ids.length>64){uncertain=true;continue;}
   for(const id of ids)if(typeof id==="string"&&uuid.test(id))commentIds.add(id);
  }
  const nested=object(context._paperclipWakeContext);
  for(const key of keys)if(typeof nested[key]==='string'&&nested[key])pending.push(nested[key] as string);
 };
 const inspect=async(current:Run)=>{
  if(current.retryOfRunId)pending.push(current.retryOfRunId);
  collect(current.contextSnapshot);
  if(current.wakeupRequestId){
   const [wake]=await db.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.id,current.wakeupRequestId),eq(agentWakeupRequests.companyId,current.companyId),eq(agentWakeupRequests.agentId,current.agentId),eq(agentWakeupRequests.runId,current.id)));
   if(wake)collect(wake.payload);
  }
  if(commentIds.size){
   if(commentIds.size>64){uncertain=true;return;}
   const comments=await db.select({sourceRunId:issueComments.createdByRunId}).from(issueComments).where(and(eq(issueComments.companyId,run.companyId),inArray(issueComments.id,[...commentIds])));
   for(const comment of comments)if(comment.sourceRunId)pending.push(comment.sourceRunId);
   commentIds.clear();
  }
 };
 await inspect(run);
 if(uncertain)return true;
 const visited=new Set<string>([run.id]);
 while(pending.length){
  const id=pending.pop()!;
  if(visited.has(id))continue;
  if(!uuid.test(id))continue;
  // An unbounded lineage is not sufficient evidence to grant provider/tools.
  if(visited.size>=64)return true;
  visited.add(id);
  const [parent]=await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,id),eq(heartbeatRuns.companyId,run.companyId)));
  if(!parent)continue;
  if(hasTaskExecutionLease(parent))return true;
  await inspect(parent);
  if(uncertain)return true;
 }
 return false;
}

export async function taskExecutionLeaseBlocksAutomaticChild(db:Db,companyId:string,sourceRunId:string):Promise<boolean>{
 const [source]=await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,sourceRunId),eq(heartbeatRuns.companyId,companyId)));
 return !!source && (hasTaskExecutionLease(source)||await hasTaskExecutionLeaseAncestor(db,source));
}

/** Converge only the exact copied receipt created by the historical native
 * replacement defect. Other queued work, unknown lineage and live ownership
 * remain untouched. No process is signalled by this metadata-only settlement.
 */
export async function settleOwnedInvalidTaskExecutionChild(db:Db,childId:string):Promise<boolean>{
 const [candidate]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,childId));
 if(!candidate?.retryOfRunId)return false;
 return db.transaction(async raw=>{
  const tx=raw as unknown as Db;
  await tx.select({id:agents.id}).from(agents).where(and(eq(agents.id,candidate.agentId),eq(agents.companyId,candidate.companyId))).for('update');
  // Native replacement locks finalization before its source run. Preserve that order.
  const [finalization]=await tx.select().from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId,candidate.retryOfRunId!),eq(nativeRunFinalizations.companyId,candidate.companyId))).for('update');
  if(!finalization||finalization.phase!=='terminal_failure'||object(finalization.failureDetail).successorRunId!==childId)return false;
  const [parent]=await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,candidate.retryOfRunId!),eq(heartbeatRuns.companyId,candidate.companyId),eq(heartbeatRuns.agentId,candidate.agentId))).for('update');
  if(!parent||!['succeeded','failed','cancelled','timed_out','interrupted'].includes(parent.status)||!parent.wakeupRequestId)return false;
  await tx.select({id:agentWakeupRequests.id}).from(agentWakeupRequests).where(eq(agentWakeupRequests.id,parent.wakeupRequestId)).for('update');
  const lease=await canonicalTaskExecutionLease(tx,parent);if(!lease||parent.runtimeMode!=='native'||parent.nativeIssueId!==lease.issueId||finalization.issueId!==lease.issueId)return false;
  const [child]=await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id,childId),eq(heartbeatRuns.companyId,parent.companyId),eq(heartbeatRuns.agentId,parent.agentId))).for('update');
  if(!child||child.retryOfRunId!==parent.id||!['queued','scheduled_retry'].includes(child.status)||child.invocationSource!=='automation'||child.triggerDetail!=='system'||child.scheduledRetryReason!=='native_safe_replacement'||!child.wakeupRequestId||child.startedAt||child.processPid||child.processGroupId||child.processStartedAt||child.controllerBootId||child.controllerLeaseExpiresAt||child.runnerInstanceId||child.nativeSessionId||child.externalRunId||child.driverKind||child.completionContractId||child.nativeIssueId||child.runtimeMode!=='legacy'||child.sessionIdBefore||child.sessionIdAfter||child.responsibleUserId!==parent.responsibleUserId)return false;
  const [wake]=await tx.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.id,child.wakeupRequestId),eq(agentWakeupRequests.companyId,child.companyId),eq(agentWakeupRequests.agentId,child.agentId),eq(agentWakeupRequests.runId,child.id))).for('update');
  if(!wake||wake.source!=='automation'||wake.triggerDetail!=='system'||wake.requestedByActorType!=='system'||wake.reason!=='native_safe_replacement'||wake.status!=='queued'||wake.finishedAt||wake.idempotencyKey!=='native-safe-replacement:'+parent.id||object(wake.payload).retryOfRunId!==parent.id||object(child.contextSnapshot).retryOfRunId!==parent.id||canonicalHash(taskLeaseFromContext(child.contextSnapshot))!==canonicalHash(lease)||canonicalHash(taskLeaseFromContext(wake.payload))!==canonicalHash(lease))return false;
  const now=new Date();
  await tx.update(heartbeatRuns).set({status:'cancelled',finishedAt:now,error:'Single-use board execution cannot create a native replacement',errorCode:'bounded_task_lease_automatic_child_forbidden'}).where(eq(heartbeatRuns.id,child.id));
  await tx.update(agentWakeupRequests).set({status:'cancelled',finishedAt:now,error:'Single-use board execution cannot create a native replacement'}).where(eq(agentWakeupRequests.id,wake.id));
  return true;
 });
}
