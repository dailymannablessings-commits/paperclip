import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, plugins, pluginJobs, pluginJobRuns, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { createPluginJobScheduler } from "./plugin-job-scheduler.js";
import { pluginJobStore } from "./plugin-job-store.js";

let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
const schedulers: ReturnType<typeof createPluginJobScheduler>[] = [];
beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("manual-plugin-claim-"); db = createDb(temporary.connectionString); }, 60_000);
afterEach(async () => { for (const scheduler of schedulers.splice(0)) await scheduler.stop(); await db.delete(plugins); });
afterAll(async () => { await temporary?.cleanup(); });

async function fixture(status = "ready", jobStatus = "active") {
  const pluginId = randomUUID(), jobId = randomUUID();
  await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "synthetic", version: "1", status, manifestJson: {} as never });
  await db.insert(pluginJobs).values({ id: jobId, pluginId, jobKey: "synthetic", schedule: "* * * * *", status: jobStatus, nextRunAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01") });
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  const call = vi.fn(() => pending);
  const worker = { isRunning: () => true, call } as unknown as Parameters<typeof createPluginJobScheduler>[0]["workerManager"];
  const scheduler = () => { const result = createPluginJobScheduler({ db, jobStore: pluginJobStore(db), workerManager: worker }); schedulers.push(result); return result; };
  const snapshot = async () => ({ jobs: await db.select().from(pluginJobs), runs: await db.select().from(pluginJobRuns) });
  return { pluginId, jobId, call, finish, scheduler, snapshot };
}

it.each(["installed", "disabled", "uninstalled", "error"])("manual execution preserves %s plugin controls and receipts despite a stale worker", async (status) => {
  const f = await fixture(status);
  const before = await f.snapshot();
  try {
    await expect(f.scheduler().triggerJob(f.jobId)).rejects.toThrow();
    expect(await f.snapshot()).toEqual(before);
    expect(f.call).not.toHaveBeenCalled();
  } finally { f.finish(); }
});

it.each([["manual", "queued"], ["retry", "queued"], ["manual", "running"], ["retry", "running"]] as const)("%s execution preserves another producer's %s receipt", async (trigger, status) => {
  const f = await fixture();
  await db.insert(pluginJobRuns).values({ jobId: f.jobId, pluginId: f.pluginId, trigger: "manual", status });
  const before = await f.snapshot();
  try {
    await expect(f.scheduler().triggerJob(f.jobId, trigger)).rejects.toThrow();
    expect(await f.snapshot()).toEqual(before);
    expect(f.call).not.toHaveBeenCalled();
  } finally { f.finish(); }
});

async function waitForBlockedClaims(count: number) {
  await vi.waitFor(async () => {
    const rows = await db.execute(sql`select count(*)::int as total from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query ilike '%plugin_job%'`);
    expect(Number(rows[0]?.total)).toBeGreaterThanOrEqual(count);
  }, { timeout: 10_000 });
}

it.each(["manual", "schedule"] as const)("serializes a manual claim against a concurrent %s producer across scheduler instances", async (firstTrigger) => {
  const f = await fixture();
  let unlock!: () => void, locked!: () => void;
  const release = new Promise<void>((resolve) => { unlock = resolve; });
  const acquired = new Promise<void>((resolve) => { locked = resolve; });
  // Real PostgreSQL row contention makes both producers reach their claim
  // boundary before release; there are no mocked claim/store internals.
  const blocker = db.transaction(async (tx) => { await tx.select().from(pluginJobs).where(eq(pluginJobs.id, f.jobId)).for("update"); locked(); await release; });
  await acquired;
  const first = firstTrigger === "schedule" ? f.scheduler().tick() : f.scheduler().triggerJob(f.jobId);
  const settledFirst = first.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
  let second: ReturnType<ReturnType<typeof createPluginJobScheduler>["triggerJob"]> | undefined;
  let settledSecond: Promise<unknown> | undefined;
  try {
    await waitForBlockedClaims(1);
    second = f.scheduler().triggerJob(f.jobId, "retry");
    settledSecond = second.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
    await waitForBlockedClaims(2);
    unlock(); await blocker;
    await vi.waitFor(() => expect(f.call).toHaveBeenCalledOnce());
    await vi.waitFor(async () => expect(await db.select().from(pluginJobRuns)).toHaveLength(1));
    // Let the losing producer finish its locked authority check while the
    // admitted provider remains active, proving it cannot create a second run.
    await expect(settledSecond).resolves.toMatchObject({ ok: false });
    expect(f.call).toHaveBeenCalledOnce();
  } finally { unlock(); f.finish(); await blocker; await settledFirst; await settledSecond; }
});

it("rechecks a job paused while the manual claim waits on its row lock", async () => {
  const f = await fixture();
  let unlock!: () => void, locked!: () => void;
  const release = new Promise<void>((resolve) => { unlock = resolve; });
  const acquired = new Promise<void>((resolve) => { locked = resolve; });
  const blocker = db.transaction(async (tx) => {
    await tx.select().from(pluginJobs).where(eq(pluginJobs.id, f.jobId)).for("update");
    locked(); await release;
    await tx.update(pluginJobs).set({ status: "paused" }).where(eq(pluginJobs.id, f.jobId));
  });
  await acquired;
  const result = f.scheduler().triggerJob(f.jobId).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
  try {
    await waitForBlockedClaims(1); unlock(); await blocker;
    expect(await result).toMatchObject({ ok: false });
    expect((await f.snapshot()).jobs[0].status).toBe("paused");
    expect((await f.snapshot()).runs).toEqual([]);
    expect(f.call).not.toHaveBeenCalled();
  } finally { unlock(); f.finish(); await blocker; await result; }
});

it("manual execution succeeds without advancing or rewriting the cron pointer", async () => {
  const f = await fixture();
  const before = (await f.snapshot()).jobs;
  const result = await f.scheduler().triggerJob(f.jobId);
  await vi.waitFor(() => expect(f.call).toHaveBeenCalledOnce());
  f.finish();
  await vi.waitFor(async () => expect((await db.select().from(pluginJobRuns).where(eq(pluginJobRuns.id, result.runId)))[0].status).toBe("succeeded"));
  expect((await f.snapshot()).jobs).toEqual(before);
});
