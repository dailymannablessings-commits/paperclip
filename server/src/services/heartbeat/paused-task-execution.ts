import type { TaskExecutionLeaseRequest } from "@paperclipai/shared";
import { createHash } from 'node:crypto';

export const PAUSED_TASK_LEASE_KEY = 'pausedTaskExecutionLease';
export const MAX_PAUSED_TASK_LEASE_MS = 30 * 60_000;
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export type JsonObject = Record<string, unknown>;
export function canonicalHash(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (input instanceof Date) return input.toISOString();
    if (Array.isArray(input)) return input.map(canonical);
    if (input !== null && typeof input === 'object') return Object.fromEntries(
      Object.entries(input).sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v]) => [k,canonical(v)]),
    );
    return input;
  };
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function preservesRoleModelArgs(args: unknown[]): boolean {
  const allowed = /^(model_auto_compact_token_limit|tool_output_token_limit|skills\.max_context_tokens|memories\.generate_memories|plugins\.[A-Za-z0-9_.-]+\.enabled|default_permissions|features\.network_proxy|permissions|shell_environment_policy\.set)\s*=/;
  for (let i=0;i<args.length;i++) {
    if (args[i]==='--skip-git-repo-check') continue;
    if (args[i]!=='-c' || typeof args[i+1]!=='string') return false;
    const setting = args[++i] as string;
    if (/[\r\n]/.test(setting) || !allowed.test(setting)) return false;
  }
  return true;
}
export type PausedExecutionAgent = {
  id: string; companyId: string; status: string; adapterType: string;
  role: string; capabilities: string | null; pauseReason: string | null; pausedAt: Date | string | null;
  adapterConfig: JsonObject; runtimeConfig: JsonObject; budgetMonthlyCents: number;
  reportsTo: string | null; permissions: JsonObject;
};
export function executionControlHash(agent: PausedExecutionAgent): string {
  const {status: _status,...controls} = agent;
  return canonicalHash(controls);
}
export type PausedExecutionIssue = {
  id: string; companyId: string; status: string; description: string | null;
  assigneeAgentId: string | null; assigneeUserId: string | null;
  assigneeAdapterOverrides: JsonObject | null; executionPolicy: JsonObject | null;
  executionRunId: string | null; checkoutRunId: string | null;
};
export type PausedTaskLease = {
  version: 1; id: string; runId: string; companyId: string; agentId: string; issueId: string; originalStatus: 'idle' | 'paused';
  actorUserId: string; idempotencyKey: string; headSha: string; controlHash: string;
  profileHash: string; scopeHash: string; createdAt: string; expiresAt: string;
};
export type PausedExecutionRequest = TaskExecutionLeaseRequest;
export type LeaseAdmission = {
  lease: PausedTaskLease; profile: JsonObject; scopeDescription: string;
};
export function admitPausedTaskExecution(input: {
  agent: PausedExecutionAgent; issue: PausedExecutionIssue; request: PausedExecutionRequest;
  actorUserId: string; wakeId: string; runId: string; now: Date; hasRunningWork: boolean;
  originalInvokability: {invokable:boolean;reason?:string}; pausedOnlyInvokability: {invokable:boolean};
}): LeaseAdmission {
  const {agent,issue,request:r,now} = input;
  const expires = Date.parse(r.expiresAt);
  if (!UUID.test(input.wakeId) || !UUID.test(input.runId) || !UUID.test(agent.id) || !UUID.test(issue.id) ||
      !UUID.test(agent.companyId) || issue.companyId !== agent.companyId || issue.id !== r.issueId ||
      !input.actorUserId || !SHA.test(r.headSha) || !HASH.test(r.expectedControlHash) ||
      !/^[a-zA-Z0-9:_-]{8,160}$/.test(r.idempotencyKey)) throw Error('Invalid bounded execution identity');
  if (!((agent.status==='paused' && !input.originalInvokability.invokable && input.originalInvokability.reason==='paused' && input.pausedOnlyInvokability.invokable) ||
      (agent.status==='idle' && input.originalInvokability.invokable)))
    throw Error('Bounded execution requires an otherwise eligible idle or paused agent');
  if (!Number.isFinite(expires) || !Number.isFinite(now.getTime()) || expires <= now.getTime() ||
      expires-now.getTime() > MAX_PAUSED_TASK_LEASE_MS) throw Error('Invalid bounded execution expiry');
  if (input.hasRunningWork) throw Error('Agent execution has not settled');
  if (executionControlHash(agent) !== r.expectedControlHash || agent.adapterConfig.model !== r.expectedModel)
    throw Error('Agent execution controls changed');
  if (issue.status !== 'backlog' || issue.assigneeAgentId !== null || issue.assigneeUserId !== null ||
      issue.assigneeAdapterOverrides !== null || issue.executionPolicy !== null ||
      issue.executionRunId !== null || issue.checkoutRunId !== null)
    throw Error('Bounded task staging changed');
  if (!r.scopeDescription.includes(r.headSha) || r.scopeDescription.length > 100_000)
    throw Error('Exact source scope is required');
  // A lease inherits the role model/budget. A task may bind its existing transport,
  // but cannot select a different model or alter role-level controls here.
  if (Object.keys(r.profile).some(key => key !== 'adapterConfig')) throw Error('Unsupported bounded profile');
  const config = r.profile.adapterConfig;
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error('Invalid bounded profile');
  if (Object.keys(config).some(key => key !== 'command' && key !== 'extraArgs')) throw Error('Unsupported bounded transport override');
  const transport = config as JsonObject;
  if (typeof transport.command !== 'string' || !transport.command.startsWith('/') ||
      !Array.isArray(transport.extraArgs) || transport.extraArgs.some(arg => typeof arg !== 'string') ||
      !preservesRoleModelArgs(transport.extraArgs))
    throw Error('Bounded transport must preserve the role model');
  return {profile:structuredClone(r.profile),scopeDescription:r.scopeDescription,lease:{
    version:1,originalStatus:agent.status as 'idle' | 'paused',id:input.wakeId,runId:input.runId,companyId:agent.companyId,agentId:agent.id,
    issueId:issue.id,actorUserId:input.actorUserId,idempotencyKey:r.idempotencyKey,headSha:r.headSha,
    controlHash:r.expectedControlHash,profileHash:canonicalHash(r.profile),scopeHash:canonicalHash(r.scopeDescription),
    createdAt:now.toISOString(),expiresAt:new Date(expires).toISOString(),
  }};
}
export function verifyPausedTaskExecution(input: {
  lease: PausedTaskLease; canonicalLease: unknown; agent: PausedExecutionAgent;
  issue: PausedExecutionIssue; runId: string; wakeId: string | null; now: Date;
  canonicalActorType: string | null; canonicalActorId: string | null;
  otherwiseEligible: boolean;
}): boolean {
  try {
  const {lease:l,agent,issue,now} = input;
  return l.version===1 && UUID.test(l.id) && UUID.test(l.runId) && SHA.test(l.headSha) &&
    HASH.test(l.controlHash) && HASH.test(l.profileHash) && HASH.test(l.scopeHash) &&
    canonicalHash(l)===canonicalHash(input.canonicalLease) &&
    input.canonicalActorType==='user' && input.canonicalActorId===l.actorUserId &&
    (l.originalStatus==='paused' ? agent.status==='paused' : l.originalStatus==='idle' && ['idle','running'].includes(agent.status)) && input.otherwiseEligible &&
    input.runId===l.runId && input.wakeId===l.id && agent.id===l.agentId &&
    agent.companyId===l.companyId && issue.companyId===l.companyId && issue.id===l.issueId &&
    issue.assigneeAgentId===l.agentId && issue.assigneeUserId===null && issue.executionPolicy===null &&
    !['done','cancelled'].includes(issue.status) &&
    executionControlHash(agent)===l.controlHash && canonicalHash(issue.assigneeAdapterOverrides)===l.profileHash &&
    canonicalHash(issue.description)===l.scopeHash &&
    Number.isFinite(Date.parse(l.createdAt)) && Number.isFinite(Date.parse(l.expiresAt)) &&
    Date.parse(l.createdAt)<=now.getTime() && Date.parse(l.expiresAt)>now.getTime() &&
    Date.parse(l.expiresAt)-Date.parse(l.createdAt)<=MAX_PAUSED_TASK_LEASE_MS;
  } catch { return false; }
}

/** Internal receipt readers must reject malformed or foreign JSON before evaluating authority. */
export function taskLeaseFromContext(context: unknown): PausedTaskLease | null {
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null;
  const value=(context as JsonObject)[PAUSED_TASK_LEASE_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const r=value as JsonObject;
  if(r.version!==1 || !['idle','paused'].includes(String(r.originalStatus)) ||
   !['id','runId','companyId','agentId','issueId'].every(k=>typeof r[k]==='string'&&UUID.test(r[k])) ||
   typeof r.actorUserId!=='string'||!r.actorUserId || typeof r.idempotencyKey!=='string'||
   typeof r.headSha!=='string'||!SHA.test(r.headSha)||
   !['controlHash','profileHash','scopeHash'].every(k=>typeof r[k]==='string'&&HASH.test(r[k]))||
   typeof r.createdAt!=='string'||typeof r.expiresAt!=='string')return null;
  return r as PausedTaskLease;
}
