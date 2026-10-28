import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issues, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { getTaskDrainStatus, heartbeatService, resolveHeartbeatSchedulingSuppression, startTaskDrain, stopTaskDrain } from "./heartbeat.js";
import { initializeStartupTaskDrain } from "./startup-task-drain.js";

describe("explicit startup task drain", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("startup-task-drain-"); db = createDb(temp.connectionString); }, 60_000);
  afterEach(async () => { stopTaskDrain(); await db.execute(sql`TRUNCATE TABLE companies CASCADE`); });
  afterAll(async () => { await temp?.cleanup(); });

  it.each(["idle", "paused"] as const)("preserves actual %s agent, deferred human receipt and queued run across startup and periodic admissions", async (status) => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Startup hold synthetic", issuePrefix: `H${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Foreign request owner", status, role: "engineer", adapterType: "process", adapterConfig: { command: "/usr/bin/true" }, runtimeConfig: { heartbeat: { enabled: true } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Preserve owner input", status: "todo", assigneeAgentId: agentId });
    await db.insert(agentWakeupRequests).values({ companyId, agentId, source: "on_demand", status: "deferred_issue_execution", reason: "issue_commented", requestedByActorType: "user", requestedByActorId: "synthetic-board", payload: { issueId, _paperclipWakeContext: { wakeCommentIds: [randomUUID()] } }, updatedAt: new Date("2026-01-01") });
    await db.insert(heartbeatRuns).values({ companyId, agentId, status: "queued", invocationSource: "on_demand", responsibleUserId: "synthetic-board", contextSnapshot: { issueId } });
    const snapshot = async () => ({ agents: await db.select().from(agents), issues: await db.select().from(issues), wakes: await db.select().from(agentWakeupRequests), runs: await db.select().from(heartbeatRuns) });
    const before = await snapshot();
    initializeStartupTaskDrain({ PAPERCLIP_STARTUP_TASK_DRAIN: "1" });
    // Simulate the old process disappearing: process-local drain is absent,
    // while the independently initialized new-process startup hold remains.
    const heartbeat = heartbeatService(db, { runtimeEnv: {} });
    expect(await heartbeat.resolveSchedulingSuppression()).toEqual({ suppressed: true, reason: "task_drain" });
    await heartbeat.resumeQueuedRuns();
    await heartbeat.tickTimers();
    expect(await snapshot()).toEqual(before);
    expect(getTaskDrainStatus()).toMatchObject({ draining: true, origin: "startup", expiresAt: null, rearmOnRestart: true });
  });

  it("requires explicit stop, cannot downgrade to a TTL, and re-arms on configured restart", () => {
    initializeStartupTaskDrain({ PAPERCLIP_STARTUP_TASK_DRAIN: "1" });
    expect(() => startTaskDrain({ ttlMs: 1 })).toThrow("explicit board stop");
    expect(stopTaskDrain()).toEqual({ wasActive: true });
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({ suppressed: false, reason: null });
    expect(getTaskDrainStatus()).toMatchObject({ draining: false, origin: null, rearmOnRestart: true });
    initializeStartupTaskDrain({ PAPERCLIP_STARTUP_TASK_DRAIN: "1" });
    expect(resolveHeartbeatSchedulingSuppression({})).toEqual({ suppressed: true, reason: "task_drain" });
  });

  it("rejects malformed configuration before startup instead of silently admitting work", () => {
    expect(() => initializeStartupTaskDrain({ PAPERCLIP_STARTUP_TASK_DRAIN: "maybe" })).toThrow("refusing startup");
  });
});
