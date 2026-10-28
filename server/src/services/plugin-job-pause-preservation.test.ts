import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, plugins, pluginJobs, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";
import { pluginJobStore } from "./plugin-job-store.js";
import { createPluginJobScheduler } from "./plugin-job-scheduler.js";
import { createPluginJobCoordinator } from "./plugin-job-coordinator.js";
import { pluginLifecycleManager } from "./plugin-lifecycle.js";
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("plugin-job-pause-"); db = createDb(temp.connectionString); }, 60_000);
afterEach(async () => { await db.delete(plugins); });
afterAll(async () => { await temp?.cleanup(); });
  it("preserves explicit paused jobs through real lifecycle/coordinator manifest synchronization", async () => {
    const pluginId = randomUUID(), jobId = randomUUID();
    await db.insert(plugins).values({ id: pluginId, pluginKey: pluginId, packageName: "synthetic", version: "1", status: "installed", manifestJson: { jobs: [{ jobKey: "synthetic", displayName: "Synthetic", schedule: "* * * * *" }] } as never });
    await db.insert(pluginJobs).values({ id: jobId, pluginId, jobKey: "synthetic", schedule: "* * * * *", status: "paused", nextRunAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01") });
    const worker = { isRunning: () => false } as unknown as Parameters<typeof createPluginJobScheduler>[0]["workerManager"];
    const store = pluginJobStore(db);
    const scheduler = createPluginJobScheduler({ db, jobStore: store, workerManager: worker });
    const lifecycle = pluginLifecycleManager(db);
    const coordinator = createPluginJobCoordinator({ db, lifecycle, scheduler, jobStore: store });
    coordinator.start();
    try {
      await lifecycle.load(pluginId);
      await vi.waitFor(async () => { const [row] = await db.select().from(pluginJobs).where(eq(pluginJobs.id, jobId)); expect(row.updatedAt.getTime()).toBeGreaterThan(new Date("2026-01-01").getTime()); });
      const [job] = await db.select().from(pluginJobs).where(eq(pluginJobs.id, jobId));
      expect(job.status).toBe("paused");
      await store.updateJobStatus(jobId, "active");
      expect((await db.select().from(pluginJobs).where(eq(pluginJobs.id, jobId)))[0].status).toBe("active");
    } finally { coordinator.stop(); await scheduler.stop(); }
  });

