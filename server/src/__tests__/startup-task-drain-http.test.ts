import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { agents, companies, createDb, startEmbeddedPostgresTestDatabase } from "@paperclipai/db";

const config = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
const installBundles = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../config.js", () => ({ loadConfig: () => config.value }));
// Real HTTP app, routes, admission, managed-config parsing and disposable DB.
// Do not install/start external provider bundles in this fixture.
vi.mock("../services/bundled-plugins.js", async (original) => ({ ...await original<typeof import("../services/bundled-plugins.js")>(), ensureBundledPlugins: installBundles }));
import { startServer, type StartedServer } from "../index.js";
import { stopTaskDrain } from "../services/heartbeat.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let started: StartedServer | undefined;
let boot: Promise<StartedServer> | undefined;
let port: number;
const folder = mkdtempSync(join(tmpdir(), "startup-hold-http-"));
const envKeys = ["PAPERCLIP_HOME", "PAPERCLIP_INSTANCE_ID", "PAPERCLIP_STARTUP_TASK_DRAIN", "PAPERCLIP_MANAGED_CONFIG", "PAPERCLIP_SECRETS_MASTER_KEY_FILE", "PAPERCLIP_DECISION_SIGNING_SECRET", "PAPERCLIP_AGENT_JWT_SECRET", "PAPERCLIP_OPEN_ON_LISTEN", "PAPERCLIP_API_URL", "PAPERCLIP_RUNTIME_API_URL", "PAPERCLIP_RUNTIME_API_CANDIDATES_JSON", "PAPERCLIP_LISTEN_HOST", "PAPERCLIP_LISTEN_PORT", "PAPERCLIP_SECRETS_PROVIDER", "PAPERCLIP_SECRETS_STRICT_MODE"] as const;
const oldEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
let agentId: string;

beforeAll(async () => {
  database = await startEmbeddedPostgresTestDatabase("startup-hold-http-");
  const db = createDb(database.connectionString);
  const companyId = randomUUID(); agentId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Held boot synthetic", issuePrefix: "HHTTP" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Paused synthetic reviewer", role: "engineer", status: "paused", adapterType: "process", adapterConfig: { command: "/usr/bin/true", model: "fixture-model" } });
  await db.$client.end();
  const listener = createServer(); await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  port = (listener.address() as { port: number }).port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  Object.assign(process.env, { PAPERCLIP_HOME: folder, PAPERCLIP_INSTANCE_ID: "synthetic-startup-hold", PAPERCLIP_STARTUP_TASK_DRAIN: "1", PAPERCLIP_SECRETS_MASTER_KEY_FILE: join(folder, "master.key"), PAPERCLIP_DECISION_SIGNING_SECRET: "a".repeat(64), PAPERCLIP_AGENT_JWT_SECRET: "b".repeat(64), PAPERCLIP_OPEN_ON_LISTEN: "false", PAPERCLIP_MANAGED_CONFIG: JSON.stringify({ v: 1, mode: "cloud", catalogVersion: "fixture", features: {}, plugins: { autoInstall: ["kubernetes"] }, environments: [{ name: "Declared fixture provider", provider: "kubernetes", config: {} }] }) });
  config.value = { deploymentMode: "local_trusted", deploymentExposure: "private", bind: "loopback", host: "127.0.0.1", port, allowedHostnames: [], authBaseUrlMode: "auto", databaseMode: "postgres", databaseUrl: database.connectionString, embeddedPostgresPort: 54329, embeddedPostgresDataDir: join(folder, "unused"), databaseBackupEnabled: false, databaseBackupIntervalMinutes: 60, databaseBackupRetentionDays: 30, databaseBackupDir: join(folder, "backups"), serveUi: false, uiDevMiddleware: false, secretsProvider: "local_encrypted", secretsStrictMode: false, secretsMasterKeyFilePath: join(folder, "master.key"), storageProvider: "local_disk", storageLocalDiskBaseDir: join(folder, "storage"), heartbeatSchedulerEnabled: false, heartbeatSchedulerIntervalMs: 30000, telemetryEnabled: false, companyDeletionEnabled: false };
}, 60_000);

afterAll(async () => {
  // A failed assertion must not strand a held listener in this test process.
  stopTaskDrain();
  if (!started && boot) started = await boot.catch(() => undefined);
  await started?.shutdown();
  await database?.cleanup();
  for (const key of envKeys) { const value = oldEnv[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(folder, { recursive: true, force: true });
}, 60_000);

it("keeps real board HTTP controls reachable while declared managed-provider readiness awaits explicit release", async () => {
  let ready = false;
  boot = startServer().then((server) => { ready = true; return server; });
  const base = `http://127.0.0.1:${port}/api`;
  let drain: Response | undefined;
  await vi.waitFor(async () => { drain = await fetch(`${base}/instance/task-drain`); expect(drain.status).toBe(200); }, { timeout: 20_000 });
  expect(await drain!.json()).toMatchObject({ draining: true, origin: "startup", rearmOnRestart: true });
  expect(ready).toBe(false);
  expect(installBundles).not.toHaveBeenCalled();
  const health = await fetch(`${base}/health`);
  expect(health.status).toBe(200);
  expect(await health.json()).toMatchObject({ status: "starting", startupRecovery: { phase: "recovering" } });
  const seal = await fetch(`${base}/agents/${agentId}/task-execution-lease/controls`);
  expect(seal.status).toBe(200);
  expect(await seal.json()).toMatchObject({ agentId, status: "paused", expectedModel: "fixture-model" });
  const release = await fetch(`${base}/instance/task-drain`, { method: "DELETE" });
  expect(release.status).toBe(200);
  expect(await release.json()).toEqual({ wasActive: true });
  started = await boot;
  expect(installBundles).toHaveBeenCalledOnce();
  expect((await (await fetch(`${base}/health`)).json()).startupRecovery.phase).toBe("ready");
}, 60_000);
