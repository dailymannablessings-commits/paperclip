import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {eq,and,sql} from 'drizzle-orm';
import {createDb,startEmbeddedPostgresTestDatabase,agents,companies,issues,agentWakeupRequests,heartbeatRuns,activityLog} from '@paperclipai/db';
import {createTaskExecutionLease,validTaskExecutionLease,releaseTaskExecutionLease,stripTaskExecutionLease} from './task-execution-lease-store.js';
import {executionControlHash,PAUSED_TASK_LEASE_KEY} from './paused-task-execution.js';

describe('task execution lease PostgreSQL admission',()=>{
 let temp:Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
 let db:ReturnType<typeof createDb>;
 beforeAll(async()=>{temp=await startEmbeddedPostgresTestDatabase('paperclip-task-lease-test-');db=createDb(temp.connectionString)},60_000);
 afterAll(async()=>{await temp?.cleanup()});
 async function fixture(status:'idle'|'paused'='paused'){
  const companyId=randomUUID(),agentId=randomUUID(),issueId=randomUUID();
  await db.insert(companies).values({id:companyId,name:'Synthetic lease fixture',issuePrefix:'T'+companyId.slice(0,7).toUpperCase()});
  await db.insert(agents).values({id:agentId,companyId,name:'Bounded fixture',role:'engineer',status,adapterType:'codex_local',adapterConfig:{model:'fixture-existing-model'},runtimeConfig:{heartbeat:{enabled:false,maxConcurrentRuns:1}},permissions:{}});
  await db.insert(issues).values({id:issueId,companyId,title:'Synthetic exact head review',description:'original',status:'backlog'});
  const [agent]=await db.select().from(agents).where(eq(agents.id,agentId));
  const request={issueId,idempotencyKey:randomUUID(),headSha:'a'.repeat(40),expectedModel:'fixture-existing-model',expectedControlHash:executionControlHash({id:agent.id,companyId:agent.companyId,status:agent.status,adapterType:agent.adapterType,adapterConfig:agent.adapterConfig,runtimeConfig:agent.runtimeConfig,budgetMonthlyCents:agent.budgetMonthlyCents,reportsTo:agent.reportsTo,permissions:agent.permissions}),scopeDescription:'Read exact head '+ 'a'.repeat(40),profile:{adapterConfig:{command:'/fixture/official-codex',extraArgs:['-c','tool_output_token_limit=1000']}},expiresAt:new Date(Date.now()+20*60_000).toISOString()};
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
 it('ordinary wake context/payload cannot smuggle a lease',()=>{const context={[PAUSED_TASK_LEASE_KEY]:{forged:true},issueId:'preserved'};const payload={[PAUSED_TASK_LEASE_KEY]:{forged:true},commentId:'preserved'};stripTaskExecutionLease(context,payload);expect(context).toEqual({issueId:'preserved'});expect(payload).toEqual({commentId:'preserved'})});
});
