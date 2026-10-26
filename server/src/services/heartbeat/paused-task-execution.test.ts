import { describe, it, expect } from 'vitest';
import {admitPausedTaskExecution,executionControlHash,verifyPausedTaskExecution,preservesRoleModelArgs,type PausedExecutionAgent,type PausedExecutionIssue} from './paused-task-execution.js';
const companyId='00000000-0000-0000-0000-000000000001';
const agentId='00000000-0000-0000-0000-000000000002';
const issueId='00000000-0000-0000-0000-000000000003';
const wakeId='00000000-0000-0000-0000-000000000004';
const runId='00000000-0000-0000-0000-000000000005';
const now=new Date('2026-01-01T00:00:00Z');
function fixture(){
 const agent:PausedExecutionAgent={id:agentId,companyId,status:'paused',adapterType:'codex_local',adapterConfig:{model:'existing-role-model'},runtimeConfig:{heartbeat:{enabled:false}},budgetMonthlyCents:100,reportsTo:null,permissions:{}};
 const issue:PausedExecutionIssue={id:issueId,companyId,status:'backlog',description:'original',assigneeAgentId:null,assigneeUserId:null,assigneeAdapterOverrides:null,executionPolicy:null,executionRunId:null,checkoutRunId:null};
 const request={issueId,idempotencyKey:'bounded:test-001',headSha:'a'.repeat(40),expectedControlHash:executionControlHash(agent),expectedModel:'existing-role-model',scopeDescription:'Read exact head '+ 'a'.repeat(40),profile:{adapterConfig:{command:'/fixed/official-codex',extraArgs:['-c','tool_output_token_limit=1000']}},expiresAt:'2026-01-01T00:20:00Z'};
 return{agent,issue,request,actorUserId:'board-user',wakeId,runId,now,hasRunningWork:false,originalInvokability:{invokable:false,reason:'paused'},pausedOnlyInvokability:{invokable:true}};
}
function admitted(){const f=fixture();const admission=admitPausedTaskExecution(f);return{f,admission,input:{lease:admission.lease,canonicalLease:admission.lease,agent:f.agent,issue:{...f.issue,status:'in_progress',description:admission.scopeDescription,assigneeAgentId:agentId,assigneeAdapterOverrides:admission.profile},runId,wakeId,now,canonicalActorType:'user',canonicalActorId:'board-user',otherwiseEligible:true}};}
describe('paused task execution receipt',()=>{
 it('binds exact task/run/head/profile without changing role or staged input',()=>{const f=fixture();const before=structuredClone(f);const a=admitPausedTaskExecution(f);expect(f).toEqual(before);expect(a.lease.runId).toBe(runId);expect(a.lease.headSha).toBe(f.request.headSha);expect(verifyPausedTaskExecution(admitted().input)).toBe(true)});
 it('admits an otherwise eligible idle role without pausing it',()=>{const f=fixture();f.agent.status='idle';f.originalInvokability.invokable=true;const a=admitPausedTaskExecution(f);expect(a.lease.originalStatus).toBe('idle');expect(f.agent.status).toBe('idle')});
 it('rejects budget/org/permissions eligibility failure despite paused status',()=>{const f=fixture();f.pausedOnlyInvokability.invokable=false;expect(()=>admitPausedTaskExecution(f)).toThrow();expect(verifyPausedTaskExecution({...admitted().input,otherwiseEligible:false})).toBe(false)});
 it('rejects active foreign work before assignment',()=>{const f=fixture();f.hasRunningWork=true;expect(()=>admitPausedTaskExecution(f)).toThrow()});
 it.each(['running','terminated','pending_approval'])('never resumes or impersonates %s role',status=>{const f=fixture();f.agent.status=status;expect(()=>admitPausedTaskExecution(f)).toThrow()});
 it.each(['assigneeAgentId','assigneeUserId','executionRunId','checkoutRunId'] as const)('rejects changed staged %s',key=>{const f=fixture();f.issue[key]=agentId;expect(()=>admitPausedTaskExecution(f)).toThrow()});
 it('rejects task policy/profile changes',()=>{for(const key of ['executionPolicy','assigneeAdapterOverrides'] as const){const f=fixture();f.issue[key]={other:true};expect(()=>admitPausedTaskExecution(f)).toThrow()}});
 it('rejects model/control drift',()=>{const f=fixture();f.agent.adapterConfig.model='different';expect(()=>admitPausedTaskExecution(f)).toThrow();const x=admitted();x.input.agent.permissions={other:true};expect(verifyPausedTaskExecution(x.input)).toBe(false)});
 it('rejects crosscompany and unsupported source identities',()=>{const f=fixture();f.issue.companyId=runId;expect(()=>admitPausedTaskExecution(f)).toThrow();f.issue.companyId=companyId;f.request.headSha='main';expect(()=>admitPausedTaskExecution(f)).toThrow()});
 it('binds canonical receipt and exact linked wake/run, not inherited retry context',()=>{const x=admitted();expect(verifyPausedTaskExecution({...x.input,runId:issueId})).toBe(false);expect(verifyPausedTaskExecution({...x.input,wakeId:issueId})).toBe(false);expect(verifyPausedTaskExecution({...x.input,canonicalLease:{...x.admission.lease,headSha:'b'.repeat(40)}})).toBe(false)});
 it('rejects forged agent-origin and malformed receipts',()=>{const x=admitted();expect(verifyPausedTaskExecution({...x.input,canonicalActorType:'agent'})).toBe(false);expect(verifyPausedTaskExecution({...x.input,canonicalLease:undefined})).toBe(false)});
 it('requires stillpaused exact task/profile/scope after admission',()=>{for(const change of [{status:'done'},{description:'foreign'},{assigneeAgentId:runId},{assigneeAdapterOverrides:{other:true}}]){const x=admitted();expect(verifyPausedTaskExecution({...x.input,issue:{...x.input.issue,...change}})).toBe(false)}const x=admitted();x.input.agent.status='idle';expect(verifyPausedTaskExecution(x.input)).toBe(false)});
 it('expires bounded authority and rejects future/overlong creation',()=>{const x=admitted();expect(verifyPausedTaskExecution({...x.input,now:new Date(x.admission.lease.expiresAt)})).toBe(false);for(const expiresAt of ['invalid','2025-12-31T23:59:00Z','2026-01-01T00:31:00Z']){const f=fixture();f.request.expiresAt=expiresAt;expect(()=>admitPausedTaskExecution(f)).toThrow()}});
 it.each([['--model','other'],['-m','other'],['-c','model="other"'],['--config','model="other"'],['-c','tool_output_token_limit=1\nmodel="other"'],['--profile','unreviewed']])('rejects transport model/config escape %j',(...args)=>expect(preservesRoleModelArgs(args)).toBe(false));
});
