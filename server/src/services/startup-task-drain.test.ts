import { createPluginWorkerManager } from "./plugin-worker-manager.js";
import { createPluginJobCoordinator, reconcilePluginJobsAfterStartupHold } from "./plugin-job-coordinator.js";
import { pluginLifecycleManager } from "./plugin-lifecycle.js";
import { pluginLoader } from "./plugin-loader.js";
import { createPluginJobScheduler } from "./plugin-job-scheduler.js";
import { pluginJobStore } from "./plugin-job-store.js";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, agentWakeupRequests, companies, createDb, heartbeatRuns, issues, plugins, pluginJobs, pluginJobRuns, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { getTaskDrainStatus, heartbeatService, resolveHeartbeatSchedulingSuppression, startTaskDrain, stopTaskDrain } from "./heartbeat.js";
import { initializeStartupTaskDrain, deferStartupTaskDrain } from "./startup-task-drain.js";

describe("explicit startup task drain", () => {
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("startup-task-drain-"); db = createDb(temp.connectionString); }, 60_000);
  afterEach(async () => { stopTaskDrain(); await db.execute(sql`TRUNCATE TABLE companies CASCADE`); await db.delete(plugins); });
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

  it("preserves actual due plugin job and run receipts until explicit release", async () => {
    const pluginId = randomUUID(), jobId = randomUUID();
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "synthetic", version: "1", status: "ready", manifestJson: {} as never });
    await db.insert(pluginJobs).values({ id: jobId, pluginId, jobKey: "synthetic", schedule: "* * * * *", nextRunAt: new Date("2026-01-01") });
    const worker = { isRunning: () => true, call: async () => undefined } as unknown as Parameters<typeof createPluginJobScheduler>[0]["workerManager"];
    const scheduler = createPluginJobScheduler({ db, jobStore: pluginJobStore(db), workerManager: worker });
    const snapshot = async () => ({ jobs: await db.select().from(pluginJobs), runs: await db.select().from(pluginJobRuns) });
    const before = await snapshot();
    initializeStartupTaskDrain({ PAPERCLIP_STARTUP_TASK_DRAIN: "1" });
    await expect(scheduler.triggerJob(jobId)).rejects.toMatchObject({ status: 409 });
    await scheduler.registerPlugin(pluginId);
    await scheduler.tick();
    expect(await snapshot()).toEqual(before);
    stopTaskDrain();
    await scheduler.tick();
    const after = await snapshot();
    expect(after.runs).toHaveLength(1);
    expect(after.runs[0].status).toBe("succeeded");
    await scheduler.stop();
  });

  it("cancels a stopped held app and reconstructs lifecycle side effects from current durable operator status only after release", async () => {
    const pluginId = randomUUID(), jobId = randomUUID();
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "synthetic", version: "1", status: "ready", manifestJson: { jobs: [{ jobKey: "synthetic", displayName: "Synthetic", schedule: "* * * * *" }] } as never });
    await db.insert(pluginJobs).values({ id: jobId, pluginId, jobKey: "synthetic", schedule: "* * * * *", nextRunAt: new Date("2026-01-01") });
    await db.insert(pluginJobRuns).values(["queued", "running"].map((status) => ({ pluginId, jobId, trigger: "manual" as const, status: status as "queued" | "running" })));
    const store = pluginJobStore(db);
    const worker = { isRunning: () => false } as unknown as Parameters<typeof createPluginJobScheduler>[0]["workerManager"];
    const scheduler = createPluginJobScheduler({ db, jobStore: store, workerManager: worker });
    const lifecycle = pluginLifecycleManager(db);
    const firstCoordinator = createPluginJobCoordinator({ db, lifecycle, scheduler, jobStore: store });
    const oldBoot = vi.fn(async () => { firstCoordinator.start(); await reconcilePluginJobsAfterStartupHold({ db, scheduler, jobStore: store }); });
    initializeStartupTaskDrain({ PAPERCLIP_STARTUP_TASK_DRAIN: "1" });
    const first = deferStartupTaskDrain(oldBoot);
    const snapshot = async () => ({ jobs: await db.select().from(pluginJobs), runs: await db.select().from(pluginJobRuns) });
    const before = await snapshot();
    // This is a real durable board configuration change while held. Its job
    // receipt side effects must wait; no stale ready payload is saved for later.
    await lifecycle.disable(pluginId, "Synthetic owner hold");
    expect(await snapshot()).toEqual(before);
    first.cancel(); await first.promise;
    const nextLifecycle = pluginLifecycleManager(db);
    const nextCoordinator = createPluginJobCoordinator({ db, lifecycle: nextLifecycle, scheduler, jobStore: store });
    initializeStartupTaskDrain({ PAPERCLIP_STARTUP_TASK_DRAIN: "1" });
    const next = deferStartupTaskDrain(async () => { nextCoordinator.start(); await reconcilePluginJobsAfterStartupHold({ db, scheduler, jobStore: store }); });
    expect(await snapshot()).toEqual(before);
    expect(oldBoot).not.toHaveBeenCalled();
    stopTaskDrain(); await next.promise;
    expect((await db.select().from(plugins).where(eq(plugins.id, pluginId)))[0].status).toBe("disabled");
    // A persisted inactive status is not proof that old foreign requests may
    // be discarded during reconstruction. Preserve those exact receipts.
    expect(await snapshot()).toEqual(before);
    await scheduler.tick();
    expect(await snapshot()).toEqual(before);
    // A new explicit, ordinary unheld lifecycle operation still has its normal
    // side effects; the hold does not permanently disable plugin administration.
    await nextLifecycle.enable(pluginId);
    await nextLifecycle.disable(pluginId, "Explicit post-release owner action");
    await vi.waitFor(async () => expect((await snapshot()).runs.every((run) => run.status === "cancelled")).toBe(true));
    firstCoordinator.stop(); nextCoordinator.stop(); await scheduler.stop();
  });

  it.each(["disabled", "uninstalled"] as const)("does not claim or advance %s plugin jobs after explicit release even with a stale registered worker", async (status) => {
    const pluginId = randomUUID(), jobId = randomUUID();
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "synthetic", version: "1", status, manifestJson: {} as never });
    await db.insert(pluginJobs).values({ id: jobId, pluginId, jobKey: "synthetic", schedule: "* * * * *", nextRunAt: new Date("2026-01-01") });
    await db.insert(pluginJobRuns).values(["queued", "running"].map((state) => ({ pluginId, jobId, trigger: "manual" as const, status: state as "queued" | "running" })));
    const calls = vi.fn(async () => undefined);
    const worker = { isRunning: () => true, call: calls } as unknown as Parameters<typeof createPluginJobScheduler>[0]["workerManager"];
    const scheduler = createPluginJobScheduler({ db, jobStore: pluginJobStore(db), workerManager: worker });
    const snapshot = async () => ({ jobs: await db.select().from(pluginJobs), runs: await db.select().from(pluginJobRuns) });
    const before = await snapshot();
    initializeStartupTaskDrain({ PAPERCLIP_STARTUP_TASK_DRAIN: "1" }); stopTaskDrain();
    await scheduler.tick();
    expect(await snapshot()).toEqual(before);
    expect(calls).not.toHaveBeenCalled();
    await scheduler.stop();
  });

  it("rechecks a plugin disabled after due selection before creating any run or advancing its schedule", async () => {
    const pluginId = randomUUID(), jobId = randomUUID();
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "synthetic", version: "1", status: "ready", manifestJson: {} as never });
    await db.insert(pluginJobs).values({ id: jobId, pluginId, jobKey: "synthetic", schedule: "* * * * *", nextRunAt: new Date("2026-01-01") });
    const calls = vi.fn(async () => undefined);
    const worker = { isRunning: () => true, call: calls } as unknown as Parameters<typeof createPluginJobScheduler>[0]["workerManager"];
    const raceDb = new Proxy(db, { get(target, key, receiver) {
      if (key === "transaction") return async (work: Parameters<typeof db.transaction>[0]) => {
        await db.update(plugins).set({ status: "disabled" }).where(eq(plugins.id, pluginId));
        return db.transaction(work);
      };
      return Reflect.get(target, key, receiver);
    } });
    const scheduler = createPluginJobScheduler({ db: raceDb, jobStore: pluginJobStore(db), workerManager: worker });
    const before = await db.select().from(pluginJobs);
    await scheduler.tick();
    expect(await db.select().from(pluginJobs)).toEqual(before);
    expect(await db.select().from(pluginJobRuns)).toEqual([]);
    expect(calls).not.toHaveBeenCalled();
    await scheduler.stop();
  });

  it("does not claim a second scheduled run while another scheduler owns the same durable job", async () => {
    const pluginId = randomUUID(), jobId = randomUUID();
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "synthetic", version: "1", status: "ready", manifestJson: {} as never });
    await db.insert(pluginJobs).values({ id: jobId, pluginId, jobKey: "synthetic", schedule: "* * * * *", nextRunAt: new Date("2026-01-01") });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const calls = vi.fn(() => pending);
    const worker = { isRunning: () => true, call: calls } as unknown as Parameters<typeof createPluginJobScheduler>[0]["workerManager"];
    const firstScheduler = createPluginJobScheduler({ db, jobStore: pluginJobStore(db), workerManager: worker });
    const secondScheduler = createPluginJobScheduler({ db, jobStore: pluginJobStore(db), workerManager: worker });
    const first = firstScheduler.tick();
    try {
      await vi.waitFor(() => expect(calls).toHaveBeenCalledOnce());
      const pointer = await db.select().from(pluginJobs);
      await secondScheduler.tick();
      expect(calls).toHaveBeenCalledOnce();
      expect(await db.select().from(pluginJobRuns)).toHaveLength(1);
      expect(await db.select().from(pluginJobs)).toEqual(pointer);
    } finally { release(); await first; await firstScheduler.stop(); await secondScheduler.stop(); }
  });

  it("does not advance ready but unregistered plugin schedules during reconstruction", async () => {
    const pluginId = randomUUID(), jobId = randomUUID();
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "synthetic", version: "1", status: "ready", manifestJson: {} as never });
    await db.insert(pluginJobs).values({ id: jobId, pluginId, jobKey: "synthetic", schedule: "* * * * *", nextRunAt: new Date("2026-01-01") });
    const worker = { isRunning: () => false } as unknown as Parameters<typeof createPluginJobScheduler>[0]["workerManager"];
    const scheduler = createPluginJobScheduler({ db, jobStore: pluginJobStore(db), workerManager: worker });
    const before = await db.select().from(pluginJobs);
    await scheduler.registerPlugin(pluginId); await scheduler.tick();
    expect(await db.select().from(pluginJobs)).toEqual(before);
    expect(await db.select().from(pluginJobRuns)).toEqual([]);
    await scheduler.stop();
  });

  it("refuses manual plugin activation and direct worker starts before runtime side effects", async () => {
    initializeStartupTaskDrain({ PAPERCLIP_STARTUP_TASK_DRAIN: "1" });
    const loader = pluginLoader(db);
    const pluginId = randomUUID();
    await expect(loader.loadAll()).rejects.toMatchObject({ status: 409 });
    await expect(loader.loadSingle(pluginId)).rejects.toMatchObject({ status: 409 });
    const manager = createPluginWorkerManager();
    await expect(manager.startWorker(pluginId, {} as Parameters<typeof manager.startWorker>[1])).rejects.toMatchObject({ status: 409 });
    expect(manager.isRunning(pluginId)).toBe(false);
    await manager.stopAll();
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
