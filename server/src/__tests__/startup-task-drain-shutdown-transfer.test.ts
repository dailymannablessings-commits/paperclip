import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, heartbeatRuns, environmentLeases, createDb, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";

const stopEvidence = vi.hoisted(() => ({ entered: vi.fn(), lost: vi.fn(), wait: () => Promise.resolve(), finish: () => {} }));
vi.mock("../services/local-service-supervisor.js", async (original) => {
  const mod = await original<typeof import("../services/local-service-supervisor.js")>();
  return { ...mod, terminateLocalService: async (...args: Parameters<typeof mod.terminateLocalService>) => {
    if (args[1]?.beforeSignal) {
      stopEvidence.entered(); await stopEvidence.wait();
      try { return await mod.terminateLocalService(...args); }
      catch (error) { stopEvidence.lost(); throw error; }
    }
    return mod.terminateLocalService(...args);
  } };
});
const config = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const phaseEvidence = vi.hoisted(() => ({ entered: vi.fn(), completed: vi.fn(), managedCalled: vi.fn(), reconcile: vi.fn(), wait: () => Promise.resolve(), finish: () => {} }));
vi.mock("../adapters/registry.js", async (original) => {
  const mod = await original<typeof import("../adapters/registry.js")>();
  return { ...mod, waitForExternalAdapters: async () => {
    phaseEvidence.entered(); await phaseEvidence.wait(); phaseEvidence.completed();
  } };
});
vi.mock("../services/adapter-registry-bootstrap.js", async (original) => {
  const mod = await original<typeof import("../services/adapter-registry-bootstrap.js")>();
  return { ...mod, reconcileAdapterAvailability: (...args: Parameters<typeof mod.reconcileAdapterAvailability>) => {
    phaseEvidence.reconcile(); return mod.reconcileAdapterAvailability(...args);
  } };
});
const appEvidence = vi.hoisted(() => ({ app: null as Awaited<ReturnType<typeof import("../app.js").createApp>> | null, db: null as Parameters<typeof import("../app.js").createApp>[0] | null }));
const installBundles = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../config.js", () => ({ loadConfig: () => config.value }));
// Real HTTP app, routes, admission, managed-config parsing and disposable DB.
// Do not install/start external provider bundles in this fixture.
vi.mock("../services/bundled-plugins.js", async (original) => ({ ...await original<typeof import("../services/bundled-plugins.js")>(), ensureBundledPlugins: installBundles }));
vi.mock("../app.js", async (original) => {
  const mod = await original<typeof import("../app.js")>();
  return { ...mod, createApp: async (...args: Parameters<typeof mod.createApp>) => {
    const app = await mod.createApp(...args); appEvidence.app = app; appEvidence.db = args[0]; return app;
  } };
});
import { startServer, type StartedServer } from "../index.js";
import { getStartupRecoveryState } from "../startup-recovery-state.js";
import { getStartupTaskDrain } from "../services/startup-task-drain.js";
import { stopTaskDrain, heartbeatService } from "../services/heartbeat.js";
import { eq } from "drizzle-orm";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let started: StartedServer | undefined;
let boot: Promise<StartedServer> | undefined;
let port: number;
const folder = mkdtempSync(join(tmpdir(), "startup-hold-adapters-shutdown-"));
const envKeys = ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "PAPERCLIP_STARTUP_TASK_DRAIN", "PAPERCLIP_MANAGED_CONFIG", "PAPERCLIP_SECRETS_MASTER_KEY_FILE", "PAPERCLIP_DECISION_SIGNING_SECRET", "PAPERCLIP_AGENT_JWT_SECRET", "PAPERCLIP_OPEN_ON_LISTEN", "PAPERCLIP_API_URL", "PAPERCLIP_RUNTIME_API_URL", "PAPERCLIP_RUNTIME_API_CANDIDATES_JSON", "PAPERCLIP_LISTEN_HOST", "PAPERCLIP_LISTEN_PORT", "PAPERCLIP_SECRETS_PROVIDER", "PAPERCLIP_SECRETS_STRICT_MODE"] as const;
const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
let agentId: string;
let wakeId: string;
let wakeSnapshot: unknown;
let ownedAgentId: string;
let ownedRunId: string;

beforeAll(async () => {
  database = await startEmbeddedPostgresTestDatabase("startup-hold-adapters-shutdown-");
  const db = createDb(database.connectionString);
  const companyId = randomUUID(); agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Held boot synthetic", issuePrefix: "HHTTP" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Paused synthetic reviewer", role: "engineer", status: "paused", adapterType: "process", adapterConfig: { command: "/usr/bin/true", model: "fixture-model" } });
  wakeId = randomUUID();
  const [seededWake] = await db.insert(agentWakeupRequests).values({ id: wakeId, companyId, agentId, source: "on_demand", triggerDetail: "manual", reason: "issue_commented", status: "queued", requestedByActorType: "user", requestedByActorId: "synthetic-owner", payload: { note: "Preserve synthetic human request" } }).returning();
  wakeSnapshot = seededWake;
  ownedAgentId = randomUUID();
  await db.insert(agents).values({ id: ownedAgentId, companyId, name: "Owned release-race process", role: "engineer", status: "idle", adapterType: "process", adapterConfig: { command: process.execPath, args: ["-e", "console.log('owned-ready');setInterval(() => {},1000)"], graceSec: 1 }, runtimeConfig: {}, permissions: {} });
  await db.$client.end();
  const listener = createServer(); await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  Object.assign(process.env, { PAPERCLIP_HOME: folder, PAPERCLIP_INSTANCE_ID: "synthetic-startup-hold", PAPERCLIP_STARTUP_TASK_DRAIN: "1", PAPERCLIP_SECRETS_MASTER_KEY_FILE: join(folder, "master.key"), PAPERCLIP_DECISION_SIGNING_SECRET: "a".repeat(64), PAPERCLIP_AGENT_JWT_SECRET: "b".repeat(64), PAPERCLIP_OPEN_ON_LISTEN: "false", PAPERCLIP_MANAGED_CONFIG: JSON.stringify({ v: 1, mode: "cloud", catalogVersion: "fixture", features: {}, plugins: { autoInstall: ["kubernetes"] }, environments: [{ name: "Declared fixture provider", provider: "kubernetes", config: {} }] }) });
  config.value = { deploymentMode: "local_trusted", deploymentExposure: "private", bind: "loopback", host: "127.0.0.1", port, allowedHostnames: [], authBaseUrlMode: "auto", databaseMode: "postgres", databaseUrl: database.connectionString, embeddedPostgresPort: 54329, embeddedPostgresDataDir: join(folder, "unused"), databaseBackupEnabled: false, databaseBackupIntervalMinutes: 60, databaseBackupRetentionDays: 30, databaseBackupDir: join(folder, "backups"), serveUi: false, uiDevMiddleware: false, secretsProvider: "local_encrypted", secretsStrictMode: false, secretsMasterKeyFilePath: join(folder, "master.key"), storageProvider: "local_disk", storageLocalDiskBaseDir: join(folder, "storage"), heartbeatSchedulerEnabled: true, heartbeatSchedulerIntervalMs: 30000, telemetryEnabled: false, companyDeletionEnabled: false };
}, 60_000);

afterAll(async () => {
  phaseEvidence.finish();
  // A failed assertion must not strand a held listener in this test process.
  stopTaskDrain();
  if (!started && boot) started = await boot.catch(() => undefined);
  await started?.shutdown();
  await database?.cleanup();
  for (const key of envKeys) { const value = oldEnv[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(folder, { recursive: true, force: true });
}, 60_000);

it("preserves transferred run, human wake and lease receipts after actual child shutdown admission", async () => {
  const before = new Set(process.listeners("SIGTERM"));
  phaseEvidence.wait = () => new Promise<void>(resolve => { phaseEvidence.finish = resolve; });
  stopEvidence.wait = () => new Promise<void>(resolve => { stopEvidence.finish = resolve; });
  boot = startServer(); void boot.catch(() => undefined);
  const url = `http://127.0.0.1:${port}/api`;
  await vi.waitFor(async () => { const r = await fetch(`${url}/instance/task-drain`); expect(r.status).toBe(200); await r.json(); }, { timeout: 20_000 });
  const released = await fetch(`${url}/instance/task-drain`, { method: "DELETE" }); expect(released.status).toBe(200); await released.json();
  await vi.waitFor(() => expect(phaseEvidence.entered).toHaveBeenCalledTimes(1), { timeout: 20_000 });
  const heartbeat = heartbeatService(appEvidence.db!);
  const invoked = await heartbeat.invoke(ownedAgentId, "on_demand", {}, "manual"); expect(invoked).not.toBeNull(); ownedRunId = invoked!.id;
  let fixturePid = 0;
  await vi.waitFor(async () => {
    const [run] = await appEvidence.db!.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ownedRunId));
    expect(run?.status).toBe("running"); expect(run?.processPid).toBeGreaterThan(0);
    fixturePid = run!.processPid!; expect(await heartbeat.claimOwnedShutdownRunIds()).toContain(ownedRunId);
  }, { timeout: 20_000 });
  const handlers = process.listeners("SIGTERM").filter(h => !before.has(h)); expect(handlers).toHaveLength(1);
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
  let stopping: Promise<unknown> | undefined;
  const inspection = createDb(database.connectionString);
  try {
    stopping = Promise.resolve(handlers[0]());
    await vi.waitFor(async () => { await expect(fetch(`${url}/health`)).rejects.toThrow(); });
    phaseEvidence.finish();
    await vi.waitFor(() => expect(stopEvidence.entered).toHaveBeenCalledTimes(1), { timeout: 20_000 });
    const [foreign] = await inspection.update(heartbeatRuns).set({ controllerBootId: randomUUID(), controllerLeaseExpiresAt: new Date(Date.now()+600000) })
      .where(eq(heartbeatRuns.id, ownedRunId)).returning();
    const wakes = await inspection.select().from(agentWakeupRequests).orderBy(agentWakeupRequests.id);
    const leases = await inspection.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, ownedRunId));
    stopEvidence.finish();
    await vi.waitFor(() => expect(stopEvidence.lost).toHaveBeenCalledTimes(1), { timeout: 20_000 });
    expect((await inspection.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ownedRunId)))[0]).toEqual(foreign);
    expect(await inspection.select().from(agentWakeupRequests).orderBy(agentWakeupRequests.id)).toEqual(wakes);
    expect(await inspection.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, ownedRunId))).toEqual(leases);
    // This is solely the independently captured synthetic fixture child, not a production process.
    process.kill(fixturePid, "SIGTERM"); fixturePid = 0;
    await stopping; await expect(boot).rejects.toMatchObject({ name: "StartupShutdownError" });
    expect((await inspection.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, ownedRunId)))[0]).toEqual(foreign);
    expect(await inspection.select().from(agentWakeupRequests).orderBy(agentWakeupRequests.id)).toEqual(wakes);
    expect(await inspection.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, ownedRunId))).toEqual(leases);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  } finally {
    phaseEvidence.finish(); stopEvidence.finish();
    if (fixturePid) { try { process.kill(fixturePid, "SIGKILL"); } catch {} }
    await stopping?.catch(() => undefined); exit.mockRestore(); await inspection.$client.end();
  }
}, 60_000);
