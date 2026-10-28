import {readdirSync,readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join,relative} from 'node:path';
import {describe,it,expect} from 'vitest';

const root=fileURLToPath(new URL('../../',import.meta.url));
function inventory(dir:string):Record<string,number>{
 const found:Record<string,number>={};
 for(const entry of readdirSync(dir,{withFileTypes:true})){
  if(['__tests__','test-support'].includes(entry.name))continue;
  const path=join(dir,entry.name);
  if(entry.isDirectory())Object.assign(found,inventory(path));
  else if(entry.name.endsWith('.ts')&&!entry.name.includes('.test.')){
   const count=[...readFileSync(path,'utf8').matchAll(/\.insert\(\s*(?:heartbeatRuns|agentWakeupRequests)\s*\)/g)].length;
   if(count)found[relative(root,path)]=count;
  }
 }
 return found;
}
describe('single-use board execution creation-origin inventory',()=>{
 it('requires a deliberate lineage/authority review for every new direct run or wake producer',()=>{
  // These are database producers, not just public enqueue calls. Runnable work
  // is also denied centrally at claim, provider preparation and native tools.
  expect(inventory(root)).toEqual({
   'services/execution-wait.ts':1, // skipped receipts only; cannot execute
   'services/heartbeat.ts':19, // generic admission + explicit retry/continuation guards
   'services/heartbeat/task-execution-lease-store.ts':2, // canonical board route only
   'services/native-runtime/native-safe-replacement.ts':2, // source + locked-source guard
   'services/native-runtime/status-decision-committer.ts':1, // all effect wakes retain sourceRunId
   'services/recovery/service.ts':4, // quota/disposition source guards
   'modules/wake-queue/adapters/postgres.ts':8, // promotion retains wake lineage; recovery guards
  });
 });
 it('retains source lineage on every native status effect wake, including notification/dependency effects',()=>{
  const source=readFileSync(join(root,'services/native-runtime/status-decision-committer.ts'),'utf8');
  const calls=[...source.matchAll(/await enqueueWake\(\{\s*sourceRunId: input\.runId,/g)];
  expect(calls).toHaveLength(6);
  expect([...source.matchAll(/await enqueueWake\(/g)]).toHaveLength(calls.length);
  expect(source).toContain('sourceRunId:input.sourceRunId');
 });
});
