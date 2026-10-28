import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {runnerPrpCoordinator} from '../native-runtime/runner-prp-coordinator.js';
import {setupRunnerPrpWebSocketServer,runnerPrpWebSocketInternals} from '../../realtime/runner-prp-ws.js';
import {processAdapter} from '../../adapters/process/index.js';
import {heartbeatService} from '../heartbeat.js';
import {PaperclipRunnerSemanticAuthority} from '../native-runtime/runner-semantic-authority.js';
import {reconcileSafeNativeReplacements} from '../native-runtime/native-safe-replacement.js';
import {beforeAll,afterAll,afterEach,describe,it,expect} from 'vitest';
import {eq,and,sql} from 'drizzle-orm';
import {createDb,startEmbeddedPostgresTestDatabase,agents,companies,issues,agentWakeupRequests,heartbeatRuns,activityLog,completionContracts,nativeRunFinalizations,agentTaskSessions,issueComments} from '@paperclipai/db';
import {hasTaskExecutionLeaseAncestor,settleOwnedInvalidTaskExecutionChild,createTaskExecutionLease,validTaskExecutionLease,releaseTaskExecutionLease,stripTaskExecutionLease} from './task-execution-lease-store.js';
import {executionControlHash,PAUSED_TASK_LEASE_KEY} from './paused-task-execution.js';

describe('task execution lease PostgreSQL admission',()=>{
 let temp:Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
 let db:ReturnType<typeof createDb>;
 beforeAll(async()=>{temp=await startEmbeddedPostgresTestDatabase('paperclip-task-lease-test-');db=createDb(temp.connectionString)},60_000);
 afterAll(async()=>{await temp?.cleanup()});
 // Each scheduler integration test must see only its own synthetic queue.
 // Otherwise resumeQueuedRuns could dispatch stale fixtures from earlier cases.
 afterEach(async()=>{await db.execute(sql`TRUNCATE TABLE companies CASCADE`)});
 async function fixture(status:'idle'|'paused'='paused',heartbeat:Record<string,unknown>={},adapterType='codex_local'){
  const companyId=randomUUID(),agentId=randomUUID(),issueId=randomUUID();
  await db.insert(companies).values({id:companyId,name:'Synthetic lease fixture',issuePrefix:'T'+companyId.slice(0,7).toUpperCase()});
  await db.insert(agents).values({id:agentId,companyId,name:'Bounded fixture',role:'engineer',status,adapterType,adapterConfig:{model:'fixture-existing-model',...(adapterType==='process'?{command:'/usr/bin/true'}:{})},runtimeConfig:{heartbeat:{enabled:false,maxConcurrentRuns:1,...heartbeat}},permissions:{}});
  await db.insert(issues).values({id:issueId,companyId,title:'Synthetic exact head review',description:'original',status:'backlog'});
  const [agent]=await db.select().from(agents).where(eq(agents.id,agentId));
  const request={issueId,idempotencyKey:randomUUID(),headSha:'a'.repeat(40),expectedModel:'fixture-existing-model',expectedControlHash:executionControlHash({id:agent.id,companyId:agent.companyId,status:agent.status,adapterType:agent.adapterType,role:agent.role,capabilities:agent.capabilities,pauseReason:agent.pauseReason,pausedAt:agent.pausedAt,adapterConfig:agent.adapterConfig,runtimeConfig:agent.runtimeConfig,budgetMonthlyCents:agent.budgetMonthlyCents,reportsTo:agent.reportsTo,permissions:agent.permissions}),scopeDescription:'Read exact head '+ 'a'.repeat(40),profile:{adapterConfig:{command:adapterType==='process'?'/usr/bin/true':'/fixture/official-codex',extraArgs:adapterType==='process'?[]:['-c','tool_output_token_limit=1000']}},expiresAt:new Date(Date.now()+20*60_000).toISOString()};
  return{companyId,agentId,actorUserId:'synthetic-board-user',request};
 }
 it.each(['paused','idle'] as const)('atomically binds one exact %s task and preserves all foreign queued input',async status=>{
  const f=await fixture(status);
  const [foreign]=await db.insert(agentWakeupRequests).values({companyId:f.companyId,agentId:f.agentId,source:'automation',reason:'issue_commented',status:'deferred_issue_execution',payload:{issueId:randomUUID(),commentId:randomUUID()},requestedByActorType:'user'}).returning();
  const run=await createTaskExecutionLease(db,f);
  expect(await validTaskExecutionLease(db,run)).toBe(true);
  const [agent]=await db.select().from(agents).where(eq(agents.id,f.agentId));expect(agent.status).toBe(status);expect(agent.adapterConfig.model).toBe('fixture-existing-model');
  const [issue]=await db.select().from(issues).where(eq(issues.id,f.request.issueId));expect(issue.assigneeAgentId).toBe(f.agentId);expect(issue.assigneeAdapterOverrides).toEqual(f.request.profile);
  const [preserved]=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,foreign.id));expect(preserved).toEqual(foreign);
  const [wake]=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,run.wakeupRequestId!));expect(wake.runId).toBe(run.id);expect(wake.payload?.[PAUSED_TASK_LEASE_KEY]).toEqual(run.contextSnapshot?.[PAUSED_TASK_LEASE_KEY]);
 });
 it('recovers a lost response and concurrent replay without duplicate runs or renewing expiry',async()=>{
  const f=await fixture();const [first,replayed]=await Promise.all([createTaskExecutionLease(db,f),createTaskExecutionLease(db,f)]);
  expect(first.id).toBe(replayed.id);expect(first.contextSnapshot).toEqual(replayed.contextSnapshot);
  const rows=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,f.agentId));expect(rows).toHaveLength(1);
  await expect(createTaskExecutionLease(db,{...f,request:{...f.request,scopeDescription:'changed '+f.request.headSha}})).rejects.toThrow();
 });
 it('defers foreign running work without assigning or changing the new task',async()=>{
  const f=await fixture();await db.insert(heartbeatRuns).values({companyId:f.companyId,agentId:f.agentId,status:'running',invocationSource:'automation'});
  await expect(createTaskExecutionLease(db,f)).rejects.toThrow();
  const [task]=await db.select().from(issues).where(eq(issues.id,f.request.issueId));expect(task.status).toBe('backlog');expect(task.assigneeAgentId).toBeNull();expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId,f.agentId))).toHaveLength(0);
 });
 it('rejects staging tamper and current control/TTL drift',async()=>{
  const f=await fixture();await db.update(issues).set({status:'todo'}).where(eq(issues.id,f.request.issueId));await expect(createTaskExecutionLease(db,f)).rejects.toThrow();
  const g=await fixture();const run=await createTaskExecutionLease(db,g);expect(await validTaskExecutionLease(db,run,new Date(g.request.expiresAt))).toBe(false);
  await db.update(agents).set({permissions:{canCreateAgents:true}}).where(eq(agents.id,g.agentId));expect(await validTaskExecutionLease(db,run)).toBe(false);
 });
 it('cannot copy authority to a retry run, foreign wake or changed profile',async()=>{
  const f=await fixture();const run=await createTaskExecutionLease(db,f);
  expect(await validTaskExecutionLease(db,{...run,id:randomUUID()})).toBe(false);
  expect(await validTaskExecutionLease(db,{...run,retryOfRunId:randomUUID()})).toBe(false);
  await db.update(issues).set({assigneeAdapterOverrides:{adapterConfig:{command:'/changed'}}}).where(eq(issues.id,f.request.issueId));expect(await validTaskExecutionLease(db,run)).toBe(false);
 });
 it('releases only owned terminal executor pointers without clearing strict profile or promoting foreign work',async()=>{
  const f=await fixture();const run=await createTaskExecutionLease(db,f);await db.update(heartbeatRuns).set({status:'succeeded'}).where(eq(heartbeatRuns.id,run.id));
  const [terminal]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,run.id));
  await db.update(issues).set({executionRunId:run.id,checkoutRunId:run.id}).where(eq(issues.id,f.request.issueId));await releaseTaskExecutionLease(db,terminal);await releaseTaskExecutionLease(db,terminal);
  const [task]=await db.select().from(issues).where(eq(issues.id,f.request.issueId));expect(task.executionRunId).toBeNull();expect(task.checkoutRunId).toBeNull();expect(task.assigneeAdapterOverrides).toEqual(f.request.profile);
  const [foreign]=await db.insert(heartbeatRuns).values({companyId:f.companyId,agentId:f.agentId,status:'queued',invocationSource:'automation'}).returning();await db.update(issues).set({executionRunId:foreign.id}).where(eq(issues.id,f.request.issueId));await releaseTaskExecutionLease(db,terminal);
  const [preserved]=await db.select().from(issues).where(eq(issues.id,f.request.issueId));expect(preserved.executionRunId).toBe(foreign.id);
 });
 it('rolls back assignment, receipt and run if audit persistence fails',async()=>{
  const f=await fixture();
  await db.execute(sql`CREATE FUNCTION reject_synthetic_lease_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'heartbeat.bounded_execution_created' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END; $$`);
  await db.execute(sql`CREATE TRIGGER reject_synthetic_lease_audit BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION reject_synthetic_lease_audit()`);
  try{await expect(createTaskExecutionLease(db,f)).rejects.toThrow();}finally{await db.execute(sql`DROP TRIGGER reject_synthetic_lease_audit ON activity_log`);await db.execute(sql`DROP FUNCTION reject_synthetic_lease_audit()`)}
  const [task]=await db.select().from(issues).where(eq(issues.id,f.request.issueId));expect(task.assigneeAgentId).toBeNull();expect(task.status).toBe('backlog');expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,f.agentId))).toHaveLength(0);expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId,f.agentId))).toHaveLength(0);
 });
 it('rejects a cached run after canonical run authority was revoked or rebound',async()=>{
  const f=await fixture();const run=await createTaskExecutionLease(db,f);
  await db.update(heartbeatRuns).set({status:'cancelled'}).where(eq(heartbeatRuns.id,run.id));
  expect(await validTaskExecutionLease(db,run)).toBe(false);
  await db.update(heartbeatRuns).set({status:'queued',contextSnapshot:{issueId:f.request.issueId}}).where(eq(heartbeatRuns.id,run.id));
  expect(await validTaskExecutionLease(db,run)).toBe(false);
 });
 it('rejects a revoked canonical wake even while its copied receipt remains intact',async()=>{
  const f=await fixture();const run=await createTaskExecutionLease(db,f);
  await db.update(agentWakeupRequests).set({status:'cancelled',finishedAt:new Date()}).where(eq(agentWakeupRequests.id,run.wakeupRequestId!));
  expect(await validTaskExecutionLease(db,run)).toBe(false);
 });
 it('authorizes native semantic reads only for the exact leased paused run and rechecks revocation',async()=>{
  const f=await fixture();const run=await createTaskExecutionLease(db,f);
  await db.update(heartbeatRuns).set({runtimeMode:'native',nativeIssueId:f.request.issueId,status:'running'}).where(eq(heartbeatRuns.id,run.id));
  await db.update(issues).set({executionRunId:run.id}).where(eq(issues.id,f.request.issueId));
  const authority=new PaperclipRunnerSemanticAuthority(db,{companyId:f.companyId,agentId:f.agentId,issueId:f.request.issueId,runId:run.id});
  const call={callId:'leased-read',operationId:'get_task_context',correlation:{runId:run.id,normalizedSessionId:randomUUID(),turnId:'turn-1',itemId:'item-1'},input:{}};
  expect(await authority.dispatch(call)).toMatchObject({ok:true,operationId:'get_task_context'});
  const [agent]=await db.select().from(agents).where(eq(agents.id,f.agentId));expect(agent.status).toBe('paused');
  await db.update(agentWakeupRequests).set({status:'cancelled'}).where(eq(agentWakeupRequests.id,run.wakeupRequestId!));
  expect(await authority.dispatch({...call,callId:'revoked-read'})).toMatchObject({ok:false});
 });
 it('native PRP preparation admits only canonical paused-task authority and rejects a cancelled receipt',async()=>{
  const f=await fixture();const run=await createTaskExecutionLease(db,f);
  const completionContractId=randomUUID(),runnerInstanceId=randomUUID(),nativeSessionId=randomUUID(),digest='a'.repeat(64);
  await db.insert(completionContracts).values({id:completionContractId,companyId:f.companyId,issueId:f.request.issueId,revision:1,schemaVersion:'paperclip.completion-contract.v1',policyVersion:'synthetic-policy',risk:'low',completionAuthority:'runner',incompleteCriteriaPolicy:'fail_closed',contractJson:{criteria:[]},canonicalSha256:digest,createdByActorType:'system',createdByActorId:'synthetic-test'});
  await db.update(heartbeatRuns).set({runtimeMode:'native',nativeIssueId:f.request.issueId,status:'running',driverKind:'codex',driverVersion:'0.3.0',completionContractId,completionContractSha256:digest,runnerInstanceId,nativeSessionId,nativePhase:'observed'}).where(eq(heartbeatRuns.id,run.id));
  await db.update(issues).set({executionRunId:run.id}).where(eq(issues.id,f.request.issueId));
  const server=createServer(),stateRoot=mkdtempSync(join(tmpdir(),'synthetic-task-lease-prp-'));
  setupRunnerPrpWebSocketServer(server,{apiUrl:'http://127.0.0.1:3213'});
  const coordinator=runnerPrpCoordinator(db,{stateRoot});
  const input={companyId:f.companyId,agentId:f.agentId,issueId:f.request.issueId,runId:run.id,runnerInstanceId,normalizedSessionId:nativeSessionId,environmentLeaseId:'synthetic-environment',turnId:'turn-1',itemId:'item-1',runnerVersion:'0.3.0',runnerDigest:'sha256:'+digest};
  try {
   const prepared=await coordinator.prepare(input);
   expect(prepared.semanticTools.map(t=>t.name)).toContain('get_task_context');
   await prepared.release();
   await db.update(agentWakeupRequests).set({status:'cancelled'}).where(eq(agentWakeupRequests.id,run.wakeupRequestId!));
   await expect(coordinator.prepare(input)).rejects.toThrow('runner_prp_run_not_authorized');
   const [agent]=await db.select().from(agents).where(eq(agents.id,f.agentId));expect(agent.status).toBe('paused');
  }finally{runnerPrpWebSocketInternals.resetForTests();server.close();rmSync(stateRoot,{recursive:true,force:true})}
 });
 it('actual heartbeat claim keeps daily budget caps and foreign paused queues intact',async()=>{
  const f=await fixture('paused',{maxDailyRuns:0});
  const [foreign]=await db.insert(agentWakeupRequests).values({companyId:f.companyId,agentId:f.agentId,source:'automation',reason:'issue_commented',status:'deferred_issue_execution',payload:{issueId:randomUUID(),commentId:randomUUID()},requestedByActorType:'user'}).returning();
  const service=heartbeatService(db,{runtimeEnv:{}});
  try{
   const run=await service.invokeTaskExecutionLease(f.agentId,f.actorUserId,f.request);
   await service.drainActiveRunExecutions();
   expect(run.status).toBe('cancelled');
   const [current]=await db.select().from(agents).where(eq(agents.id,f.agentId));expect(current.status).toBe('paused');
   const [unchanged]=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,foreign.id));expect(unchanged).toEqual(foreign);
   const retry=await service.scheduleBoundedRetry(run.id);expect(retry).toMatchObject({outcome:'not_scheduled',errorCode:'bounded_task_lease_no_retry'});
   expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,f.agentId))).toHaveLength(1);
  }finally{await service.drainActiveRunExecutions()}
 });
 it('actual heartbeat entry point preserves global scheduling suppression without staging a task',async()=>{
  const f=await fixture();const service=heartbeatService(db,{runtimeEnv:{PAPERCLIP_DATABASE_RESTORE_IN_PROGRESS:'true'}});
  await expect(service.invokeTaskExecutionLease(f.agentId,f.actorUserId,f.request)).rejects.toThrow('Execution scheduling is suppressed');
  expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,f.agentId))).toHaveLength(0);
  const [task]=await db.select().from(issues).where(eq(issues.id,f.request.issueId));expect(task.status).toBe('backlog');expect(task.assigneeAgentId).toBeNull();
 });
 it.each(['processLossRetryCount','scheduledRetryAttempt','continuationAttempt'] as const)('cannot reopen canonical authority by incrementing %s',async key=>{
  const f=await fixture();const run=await createTaskExecutionLease(db,f);
  await db.update(heartbeatRuns).set({[key]:1}).where(eq(heartbeatRuns.id,run.id));
  expect(await validTaskExecutionLease(db,run)).toBe(false);
 });
 it('restart reaper expires only the exact leased task without promoting its old comments',async()=>{
  const f=await fixture();f.request.expiresAt=new Date(Date.now()-60_000).toISOString();
  const run=await createTaskExecutionLease(db,{...f,now:new Date(Date.now()-21*60_000)});
  const [foreign]=await db.insert(agentWakeupRequests).values({companyId:f.companyId,agentId:f.agentId,source:'automation',reason:'issue_commented',status:'deferred_issue_execution',payload:{issueId:randomUUID(),commentId:randomUUID()},requestedByActorType:'user'}).returning();
  const service=heartbeatService(db,{runtimeEnv:{}});
  await service.reapOrphanedRuns();await service.drainActiveRunExecutions();
  const [terminal]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,run.id));expect(terminal.status).toBe('cancelled');
  const [agent]=await db.select().from(agents).where(eq(agents.id,f.agentId));expect(agent.status).toBe('paused');
  const [task]=await db.select().from(issues).where(eq(issues.id,f.request.issueId));expect(task.assigneeAdapterOverrides).toEqual(f.request.profile);
  const [unchanged]=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,foreign.id));expect(unchanged).toEqual(foreign);
 });
 it.each(['paused','idle'] as const)('executes one harmless process through the full %s heartbeat lifecycle without draining foreign input',async status=>{
  const f=await fixture(status,{},'process');
  const [foreign]=await db.insert(agentWakeupRequests).values({companyId:f.companyId,agentId:f.agentId,source:'automation',reason:'issue_commented',status:'deferred_issue_execution',payload:{issueId:randomUUID(),commentId:randomUUID()},requestedByActorType:'user'}).returning();
  const service=heartbeatService(db,{runtimeEnv:{}});
  try{
   const run=await service.invokeTaskExecutionLease(f.agentId,f.actorUserId,f.request);
   await service.drainActiveRunExecutions();
   const terminal=await service.getRun(run.id);
   expect(terminal).toMatchObject({status:'succeeded',exitCode:0});
   const [agent]=await db.select().from(agents).where(eq(agents.id,f.agentId));expect(agent.status).toBe(status);
   const [unchanged]=await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,foreign.id));expect(unchanged).toEqual(foreign);
   expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,f.agentId))).toHaveLength(1);
   const [task]=await db.select().from(issues).where(eq(issues.id,f.request.issueId));expect(task.executionRunId).toBeNull();expect(task.checkoutRunId).toBeNull();expect(task.assigneeAdapterOverrides).toEqual(f.request.profile);
  }finally{await service.drainActiveRunExecutions()}
 },20_000);
 it('serializes concurrent distinct lease requests for one agent before task assignment',async()=>{
  const f=await fixture();const secondId=randomUUID();
  await db.insert(issues).values({id:secondId,companyId:f.companyId,title:'Second synthetic task',description:'original',status:'backlog'});
  const second={...f,request:{...f.request,issueId:secondId,idempotencyKey:randomUUID()}};
  const results=await Promise.allSettled([createTaskExecutionLease(db,f),createTaskExecutionLease(db,second)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
  expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,f.agentId))).toHaveLength(1);
  const staged=await db.select().from(issues).where(eq(issues.companyId,f.companyId));
  expect(staged.filter(i=>i.status==='backlog'&&i.assigneeAgentId===null)).toHaveLength(1);
 });
 it.each([{role:'ceo'},{capabilities:'Changed role scope'},{pauseReason:'budget'},{pausedAt:new Date('2026-01-01T00:00:00.000Z')}])('revokes a lease when another owner changes role or pause controls %j',async change=>{
  const f=await fixture();const run=await createTaskExecutionLease(db,f);
  await db.update(agents).set(change).where(eq(agents.id,f.agentId));
  expect(await validTaskExecutionLease(db,run)).toBe(false);
 });
 it('actual native retry dispatcher cannot open a replacement provider under the same leased run',async()=>{
  const f=await fixture('idle');const run=await createTaskExecutionLease(db,f);
  await db.update(heartbeatRuns).set({status:'running',runtimeMode:'native',nativeIssueId:f.request.issueId,nativePhase:'observed',runnerProfileJson:{nativeExecutionInput:{syntheticEnvelope:true},sessionCheckpoint:{providerSessionId:'synthetic-existing-provider'}},controllerLeaseExpiresAt:new Date(Date.now()+60_000)}).where(eq(heartbeatRuns.id,run.id));
  await db.update(issues).set({executionRunId:run.id}).where(eq(issues.id,f.request.issueId));
  await db.insert(nativeRunFinalizations).values({runId:run.id,companyId:f.companyId,issueId:f.request.issueId,phase:'retryable_failure',attempt:1,nextAttemptAt:new Date(Date.now()-1000)});
  let providerStarts=0;
  const service=heartbeatService(db,{runtimeEnv:{},nativeSessionBackendFactory:()=>{providerStarts++;throw Error('Replacement provider must not start')}});
  try{
   await service.reapOrphanedRuns();await service.drainActiveRunExecutions();
   const terminal=await service.getRun(run.id);
   expect(providerStarts).toBe(0);
   const [agent]=await db.select().from(agents).where(eq(agents.id,f.agentId));expect(agent.status).toBe('idle');
   expect(terminal).toMatchObject({status:'cancelled',error:'Single-use task execution lease cannot restart a provider attempt'});
   expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,f.agentId))).toHaveLength(1);
  }finally{await service.drainActiveRunExecutions()}
 });
 it('keeps an actual foreign queued heartbeat untouched while an idle-role lease owns a second available slot',async()=>{
  const f=await fixture('idle',{maxConcurrentRuns:2},'process');const leased=await createTaskExecutionLease(db,f);
  await db.update(heartbeatRuns).set({status:'running',controllerLeaseExpiresAt:new Date(Date.now()+60_000)}).where(eq(heartbeatRuns.id,leased.id));
  await db.update(agents).set({status:'running'}).where(eq(agents.id,f.agentId));
  const [foreign]=await db.insert(heartbeatRuns).values({companyId:f.companyId,agentId:f.agentId,responsibleUserId:f.actorUserId,status:'queued',invocationSource:'on_demand',triggerDetail:'manual',contextSnapshot:{syntheticForeignWork:true}}).returning();
  const service=heartbeatService(db,{runtimeEnv:{}});
  try{
   await service.resumeQueuedRuns();await service.drainActiveRunExecutions();
   const [unchanged]=await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,foreign.id));
   expect(unchanged).toEqual(foreign);
   expect(await validTaskExecutionLease(db,leased)).toBe(true);
  }finally{await service.drainActiveRunExecutions()}
 });
 it('successful bounded work cannot roll an active goal into another run',async()=>{
  const f=await fixture('idle',{},'process');
  await db.insert(agentTaskSessions).values({companyId:f.companyId,agentId:f.agentId,adapterType:'process',taskKey:f.request.issueId,goalJson:{objective:'Synthetic continuing goal',status:'active'},goalStatus:'active',goalDesiredState:'active'});
  const original=processAdapter.execute;
  processAdapter.execute=async()=>({exitCode:0,signal:null,timedOut:false,resultJson:{summary:'Synthetic bounded completion',goalRolloverRequired:true}});
  const service=heartbeatService(db,{runtimeEnv:{}});
  try{
   const run=await service.invokeTaskExecutionLease(f.agentId,f.actorUserId,f.request);await service.drainActiveRunExecutions();
   expect(await service.getRun(run.id)).toMatchObject({status:'succeeded'});
   expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,f.agentId))).toHaveLength(1);
   expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.agentId,f.agentId))).toHaveLength(1);
  }finally{await service.drainActiveRunExecutions();processAdapter.execute=original}
 });
 it.each(['sourceRunId','parentRunId','predecessorRunId','goalRolloverFromRunId'])('canonical leased %s cannot authorize a cross-agent automatic child',async alias=>{
  const f=await fixture('idle',{},'process');const parent=await createTaskExecutionLease(db,f);
  await db.update(heartbeatRuns).set({status:'succeeded'}).where(eq(heartbeatRuns.id,parent.id));
  await db.update(companies).set({defaultResponsibleUserId:f.actorUserId}).where(eq(companies.id,f.companyId));
  const targetId=randomUUID();await db.insert(agents).values({id:targetId,companyId:f.companyId,name:'Synthetic other worker',role:'engineer',status:'idle',adapterType:'process',adapterConfig:{command:'/usr/bin/true'},runtimeConfig:{heartbeat:{enabled:false}},permissions:{}});
  const service=heartbeatService(db,{runtimeEnv:{}});
  try{
   const child=await service.wakeup(targetId,{source:'automation',triggerDetail:'system',reason:'synthetic_continuation',requestedByActorType:'system',requestedByActorId:'synthetic-system',payload:{[alias]:parent.id},contextSnapshot:{[alias]:parent.id}});
   await service.drainActiveRunExecutions();expect(child).toBeNull();
   expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,targetId))).toHaveLength(0);
  }finally{await service.drainActiveRunExecutions()}
 });
 it('ordinary wake context/payload cannot smuggle a lease',()=>{const context={[PAUSED_TASK_LEASE_KEY]:{forged:true},issueId:'preserved'};const payload={[PAUSED_TASK_LEASE_KEY]:{forged:true},commentId:'preserved'};stripTaskExecutionLease(context,payload);expect(context).toEqual({issueId:'preserved'});expect(payload).toEqual({commentId:'preserved'})});
 it.each(['idle','paused'] as const)('native safe replacement cannot manufacture a child of a canonical %s board lease',async status=>{
  const f=await fixture(status);const parent=await createTaskExecutionLease(db,f);
  await db.update(heartbeatRuns).set({status:'failed',runtimeMode:'native',nativeIssueId:f.request.issueId,runnerProfileJson:{recoveryEventInventoryVersion:1,nativeExecutionInput:{provider:{kind:'codex'},workspace:{cwd:tmpdir()}}}}).where(eq(heartbeatRuns.id,parent.id));
  await db.insert(nativeRunFinalizations).values({runId:parent.id,companyId:f.companyId,issueId:f.request.issueId,phase:'terminal_failure',attempt:1,failureCode:'native_provider_terminal_failed',failureDetail:{originalFailureCode:'fixture_checkpoint_unusable'}});
  const beforeTask=(await db.select().from(issues).where(eq(issues.id,f.request.issueId)))[0];
  const beforeWake=(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,parent.wakeupRequestId!)))[0];
  await reconcileSafeNativeReplacements(db);await reconcileSafeNativeReplacements(db);
  expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId,parent.id))).toHaveLength(0);
  expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,f.agentId))).toHaveLength(1);
  expect((await db.select().from(issues).where(eq(issues.id,f.request.issueId)))[0]).toEqual(beforeTask);
  expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,parent.wakeupRequestId!)))[0]).toEqual(beforeWake);
 });
 it('refuses a second board lease while prior lease-shaped work is scheduled for retry',async()=>{
  const f=await fixture();const parent=await createTaskExecutionLease(db,f);
  await db.update(heartbeatRuns).set({status:'scheduled_retry'}).where(eq(heartbeatRuns.id,parent.id));
  const issueId=randomUUID();await db.insert(issues).values({id:issueId,companyId:f.companyId,title:'Second synthetic task',status:'backlog'});
  await expect(createTaskExecutionLease(db,{...f,request:{...f.request,issueId,idempotencyKey:randomUUID()}})).rejects.toThrow();
  expect((await db.select().from(issues).where(eq(issues.id,issueId)))[0]).toMatchObject({status:'backlog',assigneeAgentId:null,assigneeAdapterOverrides:null});
  expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId,f.agentId))).toHaveLength(1);
 });
 it.each(['retryOfRunId','sourceRunId','parentRunId','predecessorRunId','goalRolloverFromRunId'])('blocks actual cross-agent unmarked queued descendants through %s after the board run finishes',async alias=>{
  const f=await fixture('idle',{},'process');const parent=await createTaskExecutionLease(db,f);
  await db.update(heartbeatRuns).set({status:'succeeded',finishedAt:new Date()}).where(eq(heartbeatRuns.id,parent.id));
  const childAgentId=randomUUID();
  await db.insert(agents).values({id:childAgentId,companyId:f.companyId,name:'Synthetic foreign child',role:'engineer',status:'idle',adapterType:'process',adapterConfig:{command:'/usr/bin/true'},runtimeConfig:{heartbeat:{enabled:false}},permissions:{}});
  const [wake]=await db.insert(agentWakeupRequests).values({companyId:f.companyId,agentId:childAgentId,source:'automation',triggerDetail:'system',reason:'synthetic-direct-producer',status:'queued',payload:{[alias]:parent.id},requestedByActorType:'system'}).returning();
  const [child]=await db.insert(heartbeatRuns).values({companyId:f.companyId,agentId:childAgentId,status:'queued',responsibleUserId:f.actorUserId,invocationSource:'automation',triggerDetail:'system',wakeupRequestId:wake.id,contextSnapshot:{syntheticDirectProducer:true}}).returning();
  await db.update(agentWakeupRequests).set({runId:child.id}).where(eq(agentWakeupRequests.id,wake.id));
  const service=heartbeatService(db,{runtimeEnv:{}});
  try{
   await service.resumeQueuedRuns();await service.drainActiveRunExecutions();
   expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,child.id)))[0]).toEqual(child);
   expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,wake.id)))[0]).toMatchObject({status:'queued',runId:child.id});
  }finally{await service.drainActiveRunExecutions()}
 });
 it.each(['retryOfRunId','sourceRunId','parentRunId','predecessorRunId','goalRolloverFromRunId'])('executes an ordinary non-leased source descendant through %s',async alias=>{
  const f=await fixture('idle',{},'process');
  const [parent]=await db.insert(heartbeatRuns).values({companyId:f.companyId,agentId:f.agentId,status:'succeeded',responsibleUserId:f.actorUserId,invocationSource:'automation',finishedAt:new Date(),contextSnapshot:{ordinarySource:true}}).returning();
  const [wake]=await db.insert(agentWakeupRequests).values({companyId:f.companyId,agentId:f.agentId,source:'automation',triggerDetail:'system',reason:'synthetic-ordinary-producer',status:'queued',payload:{[alias]:parent.id},requestedByActorType:'system'}).returning();
  const [child]=await db.insert(heartbeatRuns).values({companyId:f.companyId,agentId:f.agentId,status:'queued',responsibleUserId:f.actorUserId,invocationSource:'automation',triggerDetail:'system',wakeupRequestId:wake.id,contextSnapshot:{syntheticOrdinaryProducer:true}}).returning();
  await db.update(agentWakeupRequests).set({runId:child.id}).where(eq(agentWakeupRequests.id,wake.id));
  expect(await hasTaskExecutionLeaseAncestor(db,child)).toBe(false);
  const service=heartbeatService(db,{runtimeEnv:{}});
  try{await service.resumeQueuedRuns();await service.drainActiveRunExecutions();expect(await service.getRun(child.id)).toMatchObject({status:'succeeded',exitCode:0});}finally{await service.drainActiveRunExecutions()}
 },20_000);
 it('denies native semantic authority to an already-running unmarked descendant of a terminal board run',async()=>{
  const f=await fixture('idle');const parent=await createTaskExecutionLease(db,f);
  await db.update(heartbeatRuns).set({status:'succeeded'}).where(eq(heartbeatRuns.id,parent.id));
  const [child]=await db.insert(heartbeatRuns).values({companyId:f.companyId,agentId:f.agentId,status:'running',invocationSource:'automation',triggerDetail:'system',runtimeMode:'native',nativeIssueId:f.request.issueId,retryOfRunId:parent.id,contextSnapshot:{issueId:f.request.issueId}}).returning();
  await db.update(issues).set({executionRunId:child.id}).where(eq(issues.id,f.request.issueId));
  const authority=new PaperclipRunnerSemanticAuthority(db,{companyId:f.companyId,agentId:f.agentId,issueId:f.request.issueId,runId:child.id});
  expect(await authority.dispatch({callId:'forbidden-child-read',operationId:'get_task_context',correlation:{runId:child.id,normalizedSessionId:randomUUID(),turnId:'turn-1',itemId:'item-1'},input:{}})).toMatchObject({ok:false});
 });

 it.each(['owned','foreign_actor','foreign_wake','changed_receipt','live_pid','live_native','started','manual','forged_parent','missing_native_receipt','wrong_native_receipt'] as const)('settles only proven unstarted native copied children: %s',async variant=>{
  const f=await fixture();const parent=await createTaskExecutionLease(db,f);
  await db.update(heartbeatRuns).set({status:'failed',runtimeMode:'native',nativeIssueId:f.request.issueId}).where(eq(heartbeatRuns.id,parent.id));
  const payload={...parent.contextSnapshot,retryOfRunId:parent.id};
  const [wake]=await db.insert(agentWakeupRequests).values({companyId:f.companyId,agentId:f.agentId,source:'automation',triggerDetail:'system',reason:'native_safe_replacement',status:'queued',requestedByActorType:variant==='foreign_actor'?'user':'system',idempotencyKey:'native-safe-replacement:'+parent.id,payload}).returning();
  const [child]=await db.insert(heartbeatRuns).values({companyId:f.companyId,agentId:f.agentId,status:'scheduled_retry',invocationSource:variant==='manual'?'on_demand':'automation',triggerDetail:'system',wakeupRequestId:wake.id,retryOfRunId:parent.id,scheduledRetryReason:'native_safe_replacement',responsibleUserId:f.actorUserId,contextSnapshot:payload,...(variant==='live_pid'?{processPid:12345}:{}),...(variant==='live_native'?{nativeSessionId:randomUUID()}:{}),...(variant==='started'?{startedAt:new Date()}: {})}).returning();
  if(variant!=='missing_native_receipt')await db.insert(nativeRunFinalizations).values({runId:parent.id,companyId:f.companyId,issueId:f.request.issueId,phase:'terminal_failure',attempt:1,failureDetail:{successorRunId:variant==='wrong_native_receipt'?randomUUID():child.id}});
  await db.update(agentWakeupRequests).set({runId:variant==='foreign_wake'?parent.id:child.id,...(variant==='changed_receipt'?{payload:{...payload,[PAUSED_TASK_LEASE_KEY]:{forged:true}}}:{})}).where(eq(agentWakeupRequests.id,wake.id));
  if(variant==='forged_parent')await db.update(agentWakeupRequests).set({source:'automation'}).where(eq(agentWakeupRequests.id,parent.wakeupRequestId!));
  const beforeRun=(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,child.id)))[0];
  const beforeWake=(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,wake.id)))[0];
  expect(await settleOwnedInvalidTaskExecutionChild(db,child.id)).toBe(variant==='owned');
  if(variant==='owned'){
   expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,child.id)))[0]).toMatchObject({status:'cancelled',errorCode:'bounded_task_lease_automatic_child_forbidden'});
   expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,wake.id)))[0]).toMatchObject({status:'cancelled'});
   expect(await settleOwnedInvalidTaskExecutionChild(db,child.id)).toBe(false);
  }else{
   expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,child.id)))[0]).toEqual(beforeRun);
   expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,wake.id)))[0]).toEqual(beforeWake);
  }
 });

 it.each(['commentId','wakeCommentId'] as const)('blocks persisted pre-fix route wakes via canonical %s comment attribution',async alias=>{
  const f=await fixture('idle',{},'process');const parent=await createTaskExecutionLease(db,f);
  await db.update(heartbeatRuns).set({status:'succeeded'}).where(eq(heartbeatRuns.id,parent.id));
  const [comment]=await db.insert(issueComments).values({companyId:f.companyId,issueId:f.request.issueId,authorAgentId:f.agentId,createdByRunId:parent.id,body:'Synthetic historical mention'}).returning();
  const [wake]=await db.insert(agentWakeupRequests).values({companyId:f.companyId,agentId:f.agentId,source:'automation',triggerDetail:'system',reason:'issue_comment_mentioned',status:'queued',requestedByActorType:'agent',payload:{[alias]:comment.id}}).returning();
  const [child]=await db.insert(heartbeatRuns).values({companyId:f.companyId,agentId:f.agentId,status:'queued',responsibleUserId:f.actorUserId,invocationSource:'automation',triggerDetail:'system',wakeupRequestId:wake.id,contextSnapshot:{syntheticHistoricalMention:true}}).returning();
  await db.update(agentWakeupRequests).set({runId:child.id}).where(eq(agentWakeupRequests.id,wake.id));
  const service=heartbeatService(db,{runtimeEnv:{}});
  try{await service.resumeQueuedRuns();await service.drainActiveRunExecutions();expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,child.id)))[0]).toEqual(child);}finally{await service.drainActiveRunExecutions()}
 });

 it('preserves an unproven raw lease-shaped queued run without provider authority',async()=>{
  const f=await fixture('idle',{},'process');
  const [wake]=await db.insert(agentWakeupRequests).values({companyId:f.companyId,agentId:f.agentId,source:'automation',triggerDetail:'system',status:'queued',reason:'foreign-owned-input',payload:{[PAUSED_TASK_LEASE_KEY]:{unproven:true}},requestedByActorType:'user'}).returning();
  const [run]=await db.insert(heartbeatRuns).values({companyId:f.companyId,agentId:f.agentId,status:'queued',responsibleUserId:f.actorUserId,invocationSource:'automation',triggerDetail:'system',wakeupRequestId:wake.id,contextSnapshot:{[PAUSED_TASK_LEASE_KEY]:{unproven:true}}}).returning();
  await db.update(agentWakeupRequests).set({runId:run.id}).where(eq(agentWakeupRequests.id,wake.id));
  const service=heartbeatService(db,{runtimeEnv:{}});
  try{await service.resumeQueuedRuns();await service.drainActiveRunExecutions();expect(await service.getRun(run.id)).toEqual(run);expect((await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,wake.id)))[0]).toMatchObject({status:'queued',runId:run.id});}finally{await service.drainActiveRunExecutions()}
 });
 it.each(['distinct','malformed','duplicate'] as const)('denies overlarge %s comment ancestry without assigning it cancellation ownership',async variant=>{
  const f=await fixture('idle',{},'process');
  const [run]=await db.insert(heartbeatRuns).values({companyId:f.companyId,agentId:f.agentId,status:'queued',invocationSource:'automation',contextSnapshot:{commentIds:variant==='distinct'?Array.from({length:65},()=>randomUUID()):Array(66).fill(variant==='malformed'?'invalid-id':randomUUID())}}).returning();
  expect(await hasTaskExecutionLeaseAncestor(db,run)).toBe(true);
  expect(await settleOwnedInvalidTaskExecutionChild(db,run.id)).toBe(false);
  expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,run.id)))[0]).toEqual(run);
 });

});
