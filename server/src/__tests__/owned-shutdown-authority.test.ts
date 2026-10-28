import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq, gt, sql } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, completionContracts, createDb, heartbeatRuns, issues, nativeRunFinalizations, nativeRunResults, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { commitOwnedNativeShutdown, type OwnedNativeShutdownReceipt } from "../services/owned-native-shutdown.js";
import { terminalizeLegacyExecution } from "../services/legacy-execution-recovery.js";
let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("owned-shutdown-authority-"); db = createDb(database.connectionString); }, 60_000);
afterAll(async () => { await db?.$client.end(); await database?.cleanup(); }, 60_000);
async function seed(runtimeMode = "native") {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), contractId = randomUUID(), wakeId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Synthetic shutdown authority", issuePrefix: `S${runId.slice(0,7)}` });
  await db.insert(agents).values({ id: agentId, companyId, name: "Synthetic paused role", role: "engineer", status: "paused", adapterType: runtimeMode === "native" ? "paperclip_runner" : "process" });
  await db.insert(issues).values({ id: issueId, companyId, title: "Synthetic owned task", assigneeAgentId: agentId });
  await db.insert(completionContracts).values({ id: contractId, companyId, issueId, revision: 1, schemaVersion: "fixture", policyVersion: "fixture", risk: "low", completionAuthority: "agent", incompleteCriteriaPolicy: "hold", contractJson: {}, canonicalSha256: "a".repeat(64), createdByActorType: "user", createdByActorId: "synthetic-owner" });
  await db.insert(agentWakeupRequests).values({ id: wakeId, companyId, agentId, source: "on_demand", status: "queued", reason: "issue_commented", requestedByActorType: "user", requestedByActorId: "synthetic-owner" });
  const receipt: OwnedNativeShutdownReceipt = { leaseOwner: "owned-synthetic-lease", attempt: 1, controllerGeneration: 2, controllerBootId: randomUUID(), controllerPid: 12345, controllerProcessStartedAt: new Date("2026-01-01T00:00:00Z") };
  const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode, nativeIssueId: issueId, completionContractId: contractId, wakeupRequestId: wakeId, controllerBootId: receipt.controllerBootId, controllerLeaseExpiresAt: new Date(Date.now()+600000) }).returning();
  await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
  await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed", ...receipt, leaseExpiresAt: new Date(Date.now()+600000) });
  return { companyId, issueId, runId, contractId, wakeId, receipt, run: run! };
}
async function snapshot(f: Awaited<ReturnType<typeof seed>>) {
  return { run: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id,f.runId)), finalization: await db.select().from(nativeRunFinalizations).where(eq(nativeRunFinalizations.runId,f.runId)), wake: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id,f.wakeId)), issue: await db.select().from(issues).where(eq(issues.id,f.issueId)) };
}
function commit(f: Awaited<ReturnType<typeof seed>>) { return commitOwnedNativeShutdown({ db, runId: f.runId, companyId: f.companyId, issueId: f.issueId, receipt: f.receipt, now: new Date(), historyEntry: { disposition: "restart_suspended", source: "synthetic-owned-shutdown" } }); }
it("does not commit native handoff after the selected controller and attempt transfer", async () => {
  const f = await seed();
  await db.update(nativeRunFinalizations).set({ controllerBootId: randomUUID(), controllerPid: 67890, controllerProcessStartedAt: new Date(), leaseOwner: "foreign-lease", attempt: 3, controllerGeneration: 4 }).where(eq(nativeRunFinalizations.runId,f.runId));
  const before = await snapshot(f); expect(await commit(f)).toBeNull(); expect(await snapshot(f)).toEqual(before);
});
it("does not commit native handoff after a provider result wins the race", async () => {
  const f = await seed(); const resultId = randomUUID();
  await db.insert(nativeRunResults).values({ id: resultId, companyId:f.companyId, issueId:f.issueId, runId:f.runId, completionContractId:f.contractId, serverFingerprint:"synthetic", schemaStatus:"accepted", resultJson:{ fixture:true }, canonicalSha256:"b".repeat(64) });
  await db.update(nativeRunFinalizations).set({ resultId }).where(eq(nativeRunFinalizations.runId,f.runId));
  const before = await snapshot(f); expect(await commit(f)).toBeNull(); expect(await snapshot(f)).toEqual(before);
});
it("does not commit native handoff after the heartbeat left running", async () => {
  const f = await seed(); await db.update(heartbeatRuns).set({ status:"succeeded" }).where(eq(heartbeatRuns.id,f.runId));
  const before = await snapshot(f); expect(await commit(f)).toBeNull(); expect(await snapshot(f)).toEqual(before);
});
it("does not commit native handoff after canonical lease expiry", async () => {
  const f = await seed(); await db.update(nativeRunFinalizations).set({ leaseExpiresAt:new Date(0) }).where(eq(nativeRunFinalizations.runId,f.runId));
  const before = await snapshot(f); expect(await commit(f)).toBeNull(); expect(await snapshot(f)).toEqual(before);
});
it("records one native handoff for the exact live controller without cancelling the heartbeat or human wake", async () => {
  const f = await seed(); const before = await snapshot(f); const committed = await commit(f);
  expect(committed?.recoveryState).toBe("awaiting_runner_reattach"); expect(committed?.recoveryHistory).toHaveLength(1);
  const after = await snapshot(f); expect(after.run).toEqual(before.run); expect(after.wake).toEqual(before.wake); expect(after.issue).toEqual(before.issue);
});
it("atomically refuses legacy terminalization and task lock release after ownership transfer", async () => {
  const f = await seed("legacy"); await db.update(heartbeatRuns).set({ controllerBootId:randomUUID() }).where(eq(heartbeatRuns.id,f.runId));
  const before = await snapshot(f);
  const result = await terminalizeLegacyExecution({ db, run:f.run, status:"interrupted", fromStatuses:["running"], ownershipCondition:and(eq(heartbeatRuns.controllerBootId,f.receipt.controllerBootId),gt(heartbeatRuns.controllerLeaseExpiresAt,sql`clock_timestamp()`)) });
  expect(result).toBeNull(); expect(await snapshot(f)).toEqual(before);
});
