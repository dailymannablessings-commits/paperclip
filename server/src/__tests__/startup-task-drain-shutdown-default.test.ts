import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { agents, agentWakeupRequests, companies, createDb, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";

const config = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const phaseEvidence = vi.hoisted(() => ({ entered: vi.fn(), completed: vi.fn(), managedCalled: vi.fn(), reconcile: vi.fn(), wait: () => Promise.resolve(), finish: () => {} }));
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
import { stopTaskDrain } from "../services/heartbeat.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let started: StartedServer | undefined;
let boot: Promise<StartedServer> | undefined;
let port: number;
const folder = mkdtempSync(join(tmpdir(), "startup-default-shutdown-"));
const envKeys = ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "PAPERCLIP_STARTUP_TASK_DRAIN", "PAPERCLIP_MANAGED_CONFIG", "PAPERCLIP_SECRETS_MASTER_KEY_FILE", "PAPERCLIP_DECISION_SIGNING_SECRET", "PAPERCLIP_AGENT_JWT_SECRET", "PAPERCLIP_OPEN_ON_LISTEN", "PAPERCLIP_API_URL", "PAPERCLIP_RUNTIME_API_URL", "PAPERCLIP_RUNTIME_API_CANDIDATES_JSON", "PAPERCLIP_LISTEN_HOST", "PAPERCLIP_LISTEN_PORT", "PAPERCLIP_SECRETS_PROVIDER", "PAPERCLIP_SECRETS_STRICT_MODE"] as const;
const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
let agentId: string;
let wakeId: string;
let wakeSnapshot: unknown;

beforeAll(async () => {
  database = await startEmbeddedPostgresTestDatabase("startup-default-shutdown-");
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
  Object.assign(process.env, { PAPERCLIP_HOME: folder, PAPERCLIP_INSTANCE_ID: "synthetic-startup-hold", PAPERCLIP_STARTUP_TASK_DRAIN: "0", PAPERCLIP_SECRETS_MASTER_KEY_FILE: join(folder, "master.key"), PAPERCLIP_DECISION_SIGNING_SECRET: "a".repeat(64), PAPERCLIP_AGENT_JWT_SECRET: "b".repeat(64), PAPERCLIP_OPEN_ON_LISTEN: "false", PAPERCLIP_MANAGED_CONFIG: JSON.stringify({ v: 1, mode: "cloud", catalogVersion: "fixture", features: {}, plugins: { autoInstall: ["kubernetes"] }, environments: [{ name: "Declared fixture provider", provider: "kubernetes", config: {} }] }) });
  delete process.env.PAPERCLIP_MANAGED_CONFIG;
  config.value = { deploymentMode: "local_trusted", deploymentExposure: "private", bind: "loopback", host: "127.0.0.1", port, allowedHostnames: [], authBaseUrlMode: "auto", databaseMode: "postgres", databaseUrl: database.connectionString, embeddedPostgresPort: 54329, embeddedPostgresDataDir: join(folder, "unused"), databaseBackupEnabled: false, databaseBackupIntervalMinutes: 60, databaseBackupRetentionDays: 30, databaseBackupDir: join(folder, "backups"), serveUi: false, uiDevMiddleware: false, secretsProvider: "local_encrypted", secretsStrictMode: false, secretsMasterKeyFilePath: join(folder, "master.key"), storageProvider: "local_disk", storageLocalDiskBaseDir: join(folder, "storage"), heartbeatSchedulerEnabled: false, heartbeatSchedulerIntervalMs: 30000, telemetryEnabled: false, companyDeletionEnabled: false };
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

it("keeps ordinary unconfigured shutdown independent of a hung installer", async () => {
  const before = new Set(process.listeners("SIGTERM"));
  const blocked = new Promise<void>(resolve => { phaseEvidence.finish = resolve; });
  installBundles.mockImplementation(() => blocked);
  boot = startServer(); void boot.catch(() => undefined); started = await boot;
  await vi.waitFor(() => expect(installBundles).toHaveBeenCalledTimes(1));
  const handlers = process.listeners("SIGTERM").filter(h => !before.has(h)); expect(handlers).toHaveLength(1);
  const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as typeof process.exit);
  let stopping: Promise<unknown> | undefined;
  try {
    stopping = Promise.resolve(handlers[0]());
    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(0), { timeout: 5000 });
    await stopping;
    expect(getStartupTaskDrain()).toBeNull();
    const db = createDb(database.connectionString);
    try { expect((await db.$client.unsafe("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()"))[0].count).toBe(0); } finally { await db.$client.end(); }
  } finally { phaseEvidence.finish(); await stopping?.catch(() => undefined); exit.mockRestore(); }
}, 60_000);
