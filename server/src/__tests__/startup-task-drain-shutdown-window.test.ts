import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";

const config = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const windowEvidence = vi.hoisted(() => ({ entered: vi.fn(), reconcile: vi.fn(), wait: () => Promise.resolve(), finish: () => {} }));
vi.mock("../shutdown.js", async (original) => {
  const mod = await original<typeof import("../shutdown.js")>();
  return { ...mod, closeHttpListenerForShutdown: async (...args: Parameters<typeof mod.closeHttpListenerForShutdown>) => {
    windowEvidence.entered(); await windowEvidence.wait(); return mod.closeHttpListenerForShutdown(...args);
  } };
});
vi.mock("../services/plugin-job-coordinator.js", async (original) => {
  const mod = await original<typeof import("../services/plugin-job-coordinator.js")>();
  return { ...mod, reconcilePluginJobsAfterStartupHold: (...args: Parameters<typeof mod.reconcilePluginJobsAfterStartupHold>) => {
    windowEvidence.reconcile(); return mod.reconcilePluginJobsAfterStartupHold(...args);
  } };
});
const appEvidence = vi.hoisted(() => ({ app: null as Awaited<ReturnType<typeof import("../app.js").createApp>> | null }));
const installBundles = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../config.js", () => ({ loadConfig: () => config.value }));
// Real HTTP app, routes, admission, managed-config parsing and disposable DB.
// Do not install/start external provider bundles in this fixture.
vi.mock("../services/bundled-plugins.js", async (original) => ({ ...await original<typeof import("../services/bundled-plugins.js")>(), ensureBundledPlugins: installBundles }));
vi.mock("../app.js", async (original) => {
  const mod = await original<typeof import("../app.js")>();
  return { ...mod, createApp: async (...args: Parameters<typeof mod.createApp>) => {
    const app = await mod.createApp(...args); appEvidence.app = app; return app;
  } };
});
import { startServer, type StartedServer } from "../index.js";
import { getStartupRecoveryState } from "../startup-recovery-state.js";
import { getStartupTaskDrain } from "../services/startup-task-drain.js";
import { stopTaskDrain } from "../services/heartbeat.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let started: StartedServer | undefined;
let boot: Promise<StartedServer> | undefined;
let port: number;
const folder = mkdtempSync(join(tmpdir(), "startup-hold-shutdown-close-window-"));
const envKeys = ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "PAPERCLIP_STARTUP_TASK_DRAIN", "PAPERCLIP_MANAGED_CONFIG", "PAPERCLIP_SECRETS_MASTER_KEY_FILE", "PAPERCLIP_DECISION_SIGNING_SECRET", "PAPERCLIP_AGENT_JWT_SECRET", "PAPERCLIP_OPEN_ON_LISTEN", "PAPERCLIP_API_URL", "PAPERCLIP_RUNTIME_API_URL", "PAPERCLIP_RUNTIME_API_CANDIDATES_JSON", "PAPERCLIP_LISTEN_HOST", "PAPERCLIP_LISTEN_PORT", "PAPERCLIP_SECRETS_PROVIDER", "PAPERCLIP_SECRETS_STRICT_MODE"] as const;
const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
let agentId: string;
let wakeId: string;
let wakeSnapshot: unknown;

beforeAll(async () => {
  database = await startEmbeddedPostgresTestDatabase("startup-hold-shutdown-close-window-");
  const db = createDb(database.connectionString);
  const companyId = randomUUID(); agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Held boot synthetic", issuePrefix: "HHTTP" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Paused synthetic reviewer", role: "engineer", status: "paused", adapterType: "process", adapterConfig: { command: "/usr/bin/true", model: "fixture-model" } });
  wakeId = randomUUID();
  const [seededWake] = await db.insert(agentWakeupRequests).values({ id: wakeId, companyId, agentId, source: "on_demand", triggerDetail: "manual", reason: "issue_commented", status: "queued", requestedByActorType: "user", requestedByActorId: "synthetic-owner", payload: { note: "Preserve synthetic human request" } }).returning();
  wakeSnapshot = seededWake;
  await db.$client.end();
  const listener = createServer(); await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  Object.assign(process.env, { PAPERCLIP_HOME: folder, PAPERCLIP_INSTANCE_ID: "synthetic-startup-hold", PAPERCLIP_STARTUP_TASK_DRAIN: "1", PAPERCLIP_SECRETS_MASTER_KEY_FILE: join(folder, "master.key"), PAPERCLIP_DECISION_SIGNING_SECRET: "a".repeat(64), PAPERCLIP_AGENT_JWT_SECRET: "b".repeat(64), PAPERCLIP_OPEN_ON_LISTEN: "false", PAPERCLIP_MANAGED_CONFIG: JSON.stringify({ v: 1, mode: "cloud", catalogVersion: "fixture", features: {}, plugins: { autoInstall: ["kubernetes"] }, environments: [{ name: "Declared fixture provider", provider: "kubernetes", config: {} }] }) });
  config.value = { deploymentMode: "local_trusted", deploymentExposure: "private", bind: "loopback", host: "127.0.0.1", port, allowedHostnames: [], authBaseUrlMode: "auto", databaseMode: "postgres", databaseUrl: database.connectionString, embeddedPostgresPort: 54329, embeddedPostgresDataDir: join(folder, "unused"), databaseBackupEnabled: false, databaseBackupIntervalMinutes: 60, databaseBackupRetentionDays: 30, databaseBackupDir: join(folder, "backups"), serveUi: false, uiDevMiddleware: false, secretsProvider: "local_encrypted", secretsStrictMode: false, secretsMasterKeyFilePath: join(folder, "master.key"), storageProvider: "local_disk", storageLocalDiskBaseDir: join(folder, "storage"), heartbeatSchedulerEnabled: false, heartbeatSchedulerIntervalMs: 30000, telemetryEnabled: false, companyDeletionEnabled: false };
}, 60_000);

afterAll(async () => {
  windowEvidence.finish();
  // A failed assertion must not strand a held listener in this test process.
  stopTaskDrain();
  if (!started && boot) started = await boot.catch(() => undefined);
  await started?.shutdown();
  await database?.cleanup();
  for (const key of envKeys) { const value = oldEnv[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(folder, { recursive: true, force: true });
}, 60_000);

it("cancels deferred startup synchronously before an HTTP-drain release race can activate it", async () => {
  const before = new Set(process.listeners("SIGTERM"));
  boot = startServer();
  void boot.catch(() => undefined);
  const base = `http://127.0.0.1:${port}/api`;
  await vi.waitFor(async () => {
    const response = await fetch(`${base}/instance/task-drain`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ origin: "startup", draining: true });
  }, { timeout: 20_000 });
  expect(installBundles).not.toHaveBeenCalled();
  const ownedHandlers = process.listeners("SIGTERM").filter(handler => !before.has(handler));
  expect(ownedHandlers).toHaveLength(1);
  const closing = new Promise<void>(resolve => { windowEvidence.finish = resolve; });
  windowEvidence.wait = () => closing;
  const shutdownSpy = vi.spyOn(appEvidence.app!.locals, "paperclipShutdown");
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
  let stopping: Promise<unknown> | undefined;
  try {
    stopping = Promise.resolve(ownedHandlers[0]());
    await vi.waitFor(() => expect(windowEvidence.entered).toHaveBeenCalledTimes(1));
    // Simulate an already-admitted owner release while the HTTP drain is pending.
    stopTaskDrain();
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(windowEvidence.reconcile).not.toHaveBeenCalled();
    expect(installBundles).not.toHaveBeenCalled();
    windowEvidence.finish();
    await stopping;
    await expect(boot).rejects.toMatchObject({ name: "StartupShutdownError" });
    expect(exitSpy).toHaveBeenCalledExactlyOnceWith(0);
    expect(shutdownSpy).toHaveBeenCalledTimes(1);
    expect(installBundles).not.toHaveBeenCalled();
    expect(getStartupRecoveryState().phase).not.toBe("ready");
    await expect(fetch(`${base}/health`)).rejects.toThrow();
    // Inspect only this isolated fixture: the real runtime pool must be closed.
    const inspect = createDb(database.connectionString);
    try {
      const rows = await inspect.$client.unsafe("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()");
      expect(rows[0].count).toBe(0);
      expect((await inspect.select().from(agents)).find(row => row.id === agentId)).toMatchObject({ id: agentId, status: "paused" });
      expect(await inspect.select().from(agentWakeupRequests)).toEqual([wakeSnapshot]);
    } finally { await inspect.$client.end(); }
    // A second delivery shares the settled teardown; it cannot close services twice.
    await ownedHandlers[0]();
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(shutdownSpy).toHaveBeenCalledTimes(1);
  } finally { windowEvidence.finish(); await stopping?.catch(() => undefined); exitSpy.mockRestore(); shutdownSpy.mockRestore(); }
}, 60_000);
