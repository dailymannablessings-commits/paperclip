import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("http");
vi.unmock("node:http");

const agentId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const keyId = "33333333-3333-4333-8333-333333333333";

const baseAgent = {
  id: agentId,
  companyId,
  name: "Builder",
  urlKey: "builder",
  role: "engineer",
  title: "Builder",
  icon: null,
  status: "idle",
  reportsTo: null,
  capabilities: null,
  adapterType: "process",
  adapterConfig: {},
  runtimeConfig: {},
  budgetMonthlyCents: 0,
  spentMonthlyCents: 0,
  pauseReason: null,
  pausedAt: null,
  permissions: { canCreateAgents: false },
  lastHeartbeatAt: null,
  metadata: null,
  createdAt: new Date("2026-04-11T00:00:00.000Z"),
  updatedAt: new Date("2026-04-11T00:00:00.000Z"),
};

const baseKey = {
  id: keyId,
  agentId,
  companyId,
  name: "exploit",
  createdAt: new Date("2026-04-11T00:00:00.000Z"),
  revokedAt: null,
};

let currentKeyAgentId = agentId;
let currentAccessCanUser = false;

const mockAgentService = vi.hoisted(() => ({
  getById: vi.fn(),
  pause: vi.fn(),
  resume: vi.fn(),
  clearError: vi.fn(),
  terminate: vi.fn(),
  remove: vi.fn(),
  listKeys: vi.fn(),
  createApiKey: vi.fn(),
  getKeyById: vi.fn(),
  revokeKey: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  decide: vi.fn(),
  hasPermission: vi.fn(),
  getMembership: vi.fn(),
  ensureMembership: vi.fn(),
  listPrincipalGrants: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  invokeTaskExecutionLease: vi.fn(),
  cancelActiveForAgent: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));

const mockIssueService = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(),
  resolveAdapterConfigForRuntime: vi.fn(),
}));

const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));

const mockWorkspaceOperationService = vi.hoisted(() => ({}));
const mockLogActivity = vi.hoisted(() => vi.fn());
const mockGetTelemetryClient = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/shared/telemetry", () => ({
  trackAgentCreated: vi.fn(),
  trackErrorHandlerCrash: vi.fn(),
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: mockGetTelemetryClient,
}));

vi.mock("../routes/authz.js", async () => {
  const { forbidden, unauthorized } = await vi.importActual<typeof import("../errors.js")>("../errors.js");
  function assertAuthenticated(req: Express.Request) {
    if (req.actor.type === "none") {
      throw unauthorized();
    }
  }

  function assertBoard(req: Express.Request) {
    if (req.actor.type !== "board") {
      throw forbidden("Board access required");
    }
  }

  function assertCompanyAccess(req: Express.Request, expectedCompanyId: string) {
    assertAuthenticated(req);
    if (req.actor.type === "agent" && req.actor.companyId !== expectedCompanyId) {
      throw forbidden("Agent key cannot access another company");
    }
    if (req.actor.type === "board" && req.actor.source !== "local_implicit") {
      const allowedCompanies = req.actor.companyIds ?? [];
      if (!allowedCompanies.includes(expectedCompanyId)) {
        throw forbidden("User does not have access to this company");
      }
    }
  }

  function hasCompanyAccess(req: Express.Request, expectedCompanyId: string): boolean {
    if (req.actor.type === "none") return false;
    if (req.actor.type === "agent") return req.actor.companyId === expectedCompanyId;
    if (req.actor.source === "local_implicit") return true;
    return (req.actor.companyIds ?? []).includes(expectedCompanyId);
  }

  async function getAccessibleResource<T extends { companyId: string }>(
    req: Express.Request,
    res: { status(code: number): { json(body: unknown): unknown } },
    resource: T | null | undefined | Promise<T | null | undefined>,
    notFoundMessage: string,
  ): Promise<T | null> {
    const resolved = await resource;
    if (!resolved || !hasCompanyAccess(req, resolved.companyId)) {
      res.status(404).json({ error: notFoundMessage });
      return null;
    }
    assertCompanyAccess(req, resolved.companyId);
    return resolved;
  }

  function assertInstanceAdmin(req: Express.Request) {
    assertBoard(req);
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    throw forbidden("Instance admin access required");
  }

  function getActorInfo(req: Express.Request) {
    assertAuthenticated(req);
    if (req.actor.type === "agent") {
      return {
        actorType: "agent" as const,
        actorId: req.actor.agentId ?? "unknown-agent",
        agentId: req.actor.agentId ?? null,
        runId: req.actor.runId ?? null,
        agentApiKeyId: req.actor.keyId ?? null,
      };
    }
    return {
      actorType: "user" as const,
      actorId: req.actor.userId ?? "board",
      agentId: null,
      runId: req.actor.runId ?? null,
      agentApiKeyId: null,
    };
  }

  return {
    assertAuthenticated,
    assertBoard,
    assertCompanyAccess,
    assertInstanceAdmin,
    getAccessibleResource,
    getActorInfo,
    hasCompanyAccess,
  };
});

vi.mock("../services/index.js", () => ({
  agentService: () => mockAgentService,
  agentInstructionsService: () => mockAgentInstructionsService,
  accessService: () => mockAccessService,
  approvalService: () => mockApprovalService,
  builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
  companySkillService: () => mockCompanySkillService,
  budgetService: () => mockBudgetService,
  heartbeatService: () => mockHeartbeatService,
  issueApprovalService: () => mockIssueApprovalService,
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  secretService: () => mockSecretService,
  syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
  workspaceOperationService: () => mockWorkspaceOperationService,
}));

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
  }),
}));

let routeModules:
  | Promise<[
    typeof import("../middleware/index.js"),
    typeof import("../routes/agents.js"),
  ]>
  | null = null;

async function loadRouteModules() {
  routeModules ??= Promise.all([
    import("../middleware/index.js"),
    import("../routes/agents.js"),
  ]);
  return routeModules;
}

async function createApp(actor: Record<string, unknown>, db: unknown = {}) {
  const [{ errorHandler }, { agentRoutes }] = await loadRouteModules();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      ...actor,
      companyIds: Array.isArray(actor.companyIds) ? [...actor.companyIds] : actor.companyIds,
    };
    next();
  });
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

function resetMockDefaults() {
  vi.clearAllMocks();
  for (const mock of Object.values(mockAgentService)) mock.mockReset();
  for (const mock of Object.values(mockAccessService)) mock.mockReset();
  for (const mock of Object.values(mockApprovalService)) mock.mockReset();
  for (const mock of Object.values(mockBudgetService)) mock.mockReset();
  for (const mock of Object.values(mockHeartbeatService)) mock.mockReset();
  for (const mock of Object.values(mockIssueApprovalService)) mock.mockReset();
  for (const mock of Object.values(mockIssueService)) mock.mockReset();
  for (const mock of Object.values(mockSecretService)) mock.mockReset();
  for (const mock of Object.values(mockAgentInstructionsService)) mock.mockReset();
  for (const mock of Object.values(mockCompanySkillService)) mock.mockReset();
  mockLogActivity.mockReset();
  mockGetTelemetryClient.mockReset();
  mockGetTelemetryClient.mockReturnValue({ track: vi.fn() });
  currentKeyAgentId = agentId;
  currentAccessCanUser = false;
  mockAgentService.getById.mockImplementation(async () => ({ ...baseAgent }));
  mockAgentService.pause.mockImplementation(async () => ({ ...baseAgent }));
  mockAgentService.resume.mockImplementation(async () => ({ ...baseAgent }));
  mockAgentService.clearError.mockImplementation(async () => ({ ...baseAgent, status: "idle" }));
  mockAgentService.terminate.mockImplementation(async () => ({ ...baseAgent }));
  mockAgentService.remove.mockImplementation(async () => ({ ...baseAgent }));
  mockAgentService.listKeys.mockImplementation(async () => []);
  mockAgentService.createApiKey.mockImplementation(async () => ({
    id: keyId,
    name: baseKey.name,
    token: "pcp_test_token",
    createdAt: baseKey.createdAt,
  }));
  mockAgentService.getKeyById.mockImplementation(async () => ({
    ...baseKey,
    agentId: currentKeyAgentId,
  }));
  mockAgentService.revokeKey.mockImplementation(async () => ({
    ...baseKey,
    revokedAt: new Date("2026-04-11T00:05:00.000Z"),
  }));
  mockAccessService.canUser.mockImplementation(async () => currentAccessCanUser);
  mockAccessService.decide.mockImplementation(async (input: { actor?: { type?: string; source?: string }; action?: string }) => {
    const allowed = input.actor?.type === "board" && input.actor.source === "local_implicit"
      ? true
      : currentAccessCanUser;
    return {
      allowed,
      action: input.action,
      reason: allowed ? "allow_explicit_grant" : "deny_missing_grant",
      explanation: allowed ? "Allowed by test grant." : `Missing permission: ${input.action ?? "action"}`,
    };
  });
  mockAccessService.hasPermission.mockImplementation(async () => false);
  mockAccessService.getMembership.mockImplementation(async () => null);
  mockAccessService.listPrincipalGrants.mockImplementation(async () => []);
  mockAccessService.ensureMembership.mockImplementation(async () => undefined);
  mockAccessService.setPrincipalPermission.mockImplementation(async () => undefined);
  mockHeartbeatService.cancelActiveForAgent.mockImplementation(async () => undefined);
  mockLogActivity.mockImplementation(async () => undefined);
}

describe.sequential("agent cross-tenant route authorization", () => {
  beforeEach(() => {
    resetMockDefaults();
  });

  it("enforces company boundaries before mutating or reading agent keys", async () => {
    const crossTenantActor = {
      type: "board",
      userId: "mallory",
      companyIds: [],
      source: "session",
      isInstanceAdmin: false,
    };
    const deniedCases = [
      {
        label: "pause",
        request: (app: express.Express) =>
          requestApp(app, (baseUrl) => request(baseUrl).post(`/api/agents/${agentId}/pause`).send({})),
        untouched: [mockAgentService.pause, mockHeartbeatService.cancelActiveForAgent],
      },
      {
        label: "clear error",
        request: (app: express.Express) =>
          requestApp(app, (baseUrl) => request(baseUrl).post(`/api/agents/${agentId}/clear-error`).send({})),
        untouched: [mockAgentService.clearError],
      },
      {
        label: "list keys",
        request: (app: express.Express) =>
          requestApp(app, (baseUrl) => request(baseUrl).get(`/api/agents/${agentId}/keys`)),
        untouched: [mockAgentService.listKeys],
      },
      {
        label: "create key",
        request: (app: express.Express) =>
          requestApp(app, (baseUrl) => request(baseUrl).post(`/api/agents/${agentId}/keys`).send({ name: "exploit" })),
        untouched: [mockAgentService.createApiKey],
      },
      {
        label: "revoke key",
        request: (app: express.Express) =>
          requestApp(app, (baseUrl) => request(baseUrl).delete(`/api/agents/${agentId}/keys/${keyId}`)),
        untouched: [mockAgentService.getKeyById, mockAgentService.revokeKey],
      },
    ];

    for (const deniedCase of deniedCases) {
      resetMockDefaults();
      const app = await createApp(crossTenantActor);
      const res = await deniedCase.request(app);

      expect(res.status, `${deniedCase.label}: ${JSON.stringify(res.body)}`).toBe(404);
      expect(res.body.error).toBe("Agent not found");
      expect(mockAgentService.getById).toHaveBeenCalledWith(agentId);
      for (const mock of deniedCase.untouched) {
        expect(mock).not.toHaveBeenCalled();
      }
    }

    resetMockDefaults();
    currentKeyAgentId = "44444444-4444-4444-8444-444444444444";
    currentAccessCanUser = true;

    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "session",
      isInstanceAdmin: false,
    });

    const res = await requestApp(app, (baseUrl) => request(baseUrl).delete(`/api/agents/${agentId}/keys/${keyId}`));

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("Key not found");
    expect(mockAgentService.getKeyById).toHaveBeenCalledWith(keyId);
    expect(mockAgentService.revokeKey).not.toHaveBeenCalled();
  });

  it("requires board access before clearing an agent error", async () => {
    const app = await createApp({
      type: "agent",
      agentId,
      companyId,
      runId: "run-1",
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${agentId}/clear-error`).send({}),
    );

    expect(res.status).toBe(403);
    expect(res.body.error).toContain("Board access required");
    expect(mockAgentService.clearError).not.toHaveBeenCalled();
  });

  it("preserves board resume access", async () => {
    const pausedAgent = { ...baseAgent, status: "paused", pauseReason: "manual", pausedAt: new Date() };
    mockAgentService.getById.mockResolvedValue(pausedAgent);
    mockAgentService.resume.mockResolvedValue({
      ...pausedAgent,
      status: "idle",
      pauseReason: null,
      pausedAt: null,
    });
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${agentId}/resume`).send({}),
    );

    expect(res.status).toBe(200);
    expect(mockAgentService.resume).toHaveBeenCalledWith(agentId);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId,
      actorType: "user",
      actorId: "board-user",
      agentId: null,
      runId: null,
      agentApiKeyId: null,
      action: "agent.resumed",
      entityType: "agent",
      entityId: agentId,
    }));
  });

  it("allows a same-company agent with a direct agents:configure grant to resume", async () => {
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "agent_config:update",
      reason: "allow_direct_change",
      explanation: "Allowed by direct configuration grant.",
      grant: { permissionKey: "agents:configure" },
    });
    const app = await createApp({
      type: "agent",
      agentId: "44444444-4444-4444-8444-444444444444",
      companyId,
      runId: "55555555-5555-4555-8555-555555555555",
      keyId: "66666666-6666-4666-8666-666666666666",
      source: "agent_key",
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${agentId}/resume`).send({}),
    );

    expect(res.status).toBe(200);
    expect(mockAccessService.decide).toHaveBeenCalledWith(expect.objectContaining({
      action: "agent_config:update",
      resource: { type: "agent", companyId, agentId },
      scope: { requiresChangeGrant: true },
    }));
    expect(mockAgentService.resume).toHaveBeenCalledWith(agentId);
  });

  it.each([
    ["an ungranted peer", "44444444-4444-4444-8444-444444444444"],
    ["an ungranted self", agentId],
  ])("denies resume for %s", async (_label, actorAgentId) => {
    mockAccessService.decide.mockResolvedValue({
      allowed: false,
      action: "agent_config:update",
      reason: "deny_no_grant",
      explanation: "No direct agent configuration grant.",
    });
    const app = await createApp({
      type: "agent",
      agentId: actorAgentId,
      companyId,
      runId: "55555555-5555-4555-8555-555555555555",
      source: "agent_key",
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${agentId}/resume`).send({}),
    );

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      error: "No direct agent configuration grant.",
      details: { reason: "deny_no_grant" },
    });
    expect(mockAgentService.resume).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("denies resume when the agent only has agents:suggest-changes", async () => {
    mockAccessService.decide.mockResolvedValue({
      allowed: false,
      action: "agent_config:update",
      reason: "deny_missing_consent",
      explanation: "Accepted consent is required for this suggested change.",
      grant: { permissionKey: "agents:suggest-changes" },
    });
    const app = await createApp({
      type: "agent",
      agentId: "44444444-4444-4444-8444-444444444444",
      companyId,
      runId: "55555555-5555-4555-8555-555555555555",
      source: "agent_key",
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${agentId}/resume`).send({}),
    );

    expect(res.status).toBe(403);
    expect(res.body.details).toEqual({ reason: "deny_missing_consent" });
    expect(mockAgentService.resume).not.toHaveBeenCalled();
  });

  it("does not disclose a cross-company resume target", async () => {
    const app = await createApp({
      type: "agent",
      agentId: "44444444-4444-4444-8444-444444444444",
      companyId: "77777777-7777-4777-8777-777777777777",
      runId: "55555555-5555-4555-8555-555555555555",
      source: "agent_key",
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${agentId}/resume`).send({}),
    );

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Agent not found");
    expect(mockAccessService.decide).not.toHaveBeenCalled();
    expect(mockAgentService.resume).not.toHaveBeenCalled();
  });

  it("keeps the invalid-org-chain guard for granted agent resume", async () => {
    mockAgentService.getById.mockResolvedValue({
      ...baseAgent,
      status: "paused",
      orgChainHealth: {
        status: "invalid_org_chain",
        reason: "missing_manager",
        repairGuidance: "Repair the reporting chain first.",
      },
    });
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "agent_config:update",
      reason: "allow_direct_change",
      explanation: "Allowed by direct configuration grant.",
      grant: { permissionKey: "agents:configure" },
    });
    const app = await createApp({
      type: "agent",
      agentId: "44444444-4444-4444-8444-444444444444",
      companyId,
      runId: "55555555-5555-4555-8555-555555555555",
      source: "agent_key",
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${agentId}/resume`).send({}),
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Repair the reporting chain first.");
    expect(mockAgentService.resume).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("attributes agent resume activity to the acting agent, run, and API key", async () => {
    const actorAgentId = "44444444-4444-4444-8444-444444444444";
    const runId = "55555555-5555-4555-8555-555555555555";
    const actorKeyId = "66666666-6666-4666-8666-666666666666";
    mockAccessService.decide.mockResolvedValue({
      allowed: true,
      action: "agent_config:update",
      reason: "allow_direct_change",
      explanation: "Allowed by direct configuration grant.",
      grant: { permissionKey: "agents:configure" },
    });
    const app = await createApp({
      type: "agent",
      agentId: actorAgentId,
      companyId,
      runId,
      keyId: actorKeyId,
      source: "agent_key",
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${agentId}/resume`).send({}),
    );

    expect(res.status).toBe(200);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), {
      companyId,
      actorType: "agent",
      actorId: actorAgentId,
      agentId: actorAgentId,
      runId,
      agentApiKeyId: actorKeyId,
      action: "agent.resumed",
      entityType: "agent",
      entityId: agentId,
    });
  });

  it("clears error agents and records a distinct audit action", async () => {
    const errorAgent = {
      ...baseAgent,
      status: "error",
      pauseReason: "system",
      pausedAt: new Date("2026-04-11T00:02:00.000Z"),
    };
    mockAgentService.getById.mockImplementation(async () => ({ ...errorAgent }));
    mockAgentService.clearError.mockImplementation(async () => ({
      ...errorAgent,
      status: "idle",
      pauseReason: null,
      pausedAt: null,
      updatedAt: new Date("2026-04-11T00:03:00.000Z"),
    }));
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${agentId}/clear-error`).send({}),
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: agentId,
      status: "idle",
      pauseReason: null,
      pausedAt: null,
    });
    expect(mockAgentService.clearError).toHaveBeenCalledWith(agentId);
    expect(mockLogActivity).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      companyId,
      actorType: "user",
      actorId: "board-user",
      action: "agent.error_cleared",
      entityType: "agent",
      entityId: agentId,
    }));
  });

  it("returns 409 and does not mutate when the agent org chain is invalid", async () => {
    mockAgentService.getById.mockImplementation(async () => ({
      ...baseAgent,
      status: "error",
      orgChainHealth: {
        status: "invalid_org_chain",
        reason: "missing_manager",
        repairGuidance: "Repair the reporting chain first.",
      },
    }));
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${agentId}/clear-error`).send({}),
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Repair the reporting chain first");
    expect(mockAgentService.clearError).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("returns a clear 409 for non-error agents", async () => {
    const { conflict } = await import("../errors.js");
    mockAgentService.getById.mockImplementation(async () => ({ ...baseAgent, status: "idle" }));
    mockAgentService.clearError.mockImplementation(async () => {
      throw conflict("Only agents in error status can have their error cleared");
    });
    const app = await createApp({
      type: "board",
      userId: "board-user",
      companyIds: [companyId],
      source: "local_implicit",
      isInstanceAdmin: true,
    });

    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).post(`/api/agents/${agentId}/clear-error`).send({}),
    );

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Only agents in error status can have their error cleared");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });
});


describe.sequential("board task execution lease authorization", () => {
  beforeEach(resetMockDefaults);
  const body = {issueId:keyId,idempotencyKey:"synthetic-bounded-task",headSha:"a".repeat(40),expectedControlHash:"b".repeat(64),expectedModel:"existing-model",scopeDescription:"Review "+"a".repeat(40),profile:{adapterConfig:{command:"/synthetic/codex",extraArgs:[]}},expiresAt:"2030-01-01T00:20:00.000Z"};
  const board = {type:"board",userId:"synthetic-board",companyIds:[companyId],source:"session"};
  const path = `/api/agents/${agentId}/task-execution-lease`;
  const task = {id:keyId,companyId,projectId:null,parentId:null,assigneeAgentId:null,assigneeUserId:null,status:"backlog"};
  function dbWithTask(row:typeof task|null=task) {return {select:()=>({from:()=>({where:async()=>row?[row]:[]})})};}
  function dbWithAgent(row: Record<string, unknown> | null | (() => Record<string, unknown> | null)) {
    return { select: vi.fn(() => ({ from: () => ({ where: async () => { const current = typeof row === "function" ? row() : row; return current ? [current] : []; } }) })) };
  }
  function permitExcept(denied:string|null) {
    mockAccessService.decide.mockImplementation(async ({action}:{action:string})=>({allowed:action!==denied,action,reason:action===denied?"deny_missing_grant":"allow_explicit_grant",explanation:"Synthetic permission check"}));
  }
  it("rejects agent actors without invoking a lease",async()=>{
    const app=await createApp({type:"agent",agentId,companyId,companyIds:[companyId]});
    const response=await requestApp(app,url=>request(url).post(path).send(body));
    expect(response.status).toBe(403);expect(mockHeartbeatService.invokeTaskExecutionLease).not.toHaveBeenCalled();
  });
  it("hides cross-company agents before creating a receipt",async()=>{
    const app=await createApp({...board,companyIds:[]});
    const response=await requestApp(app,url=>request(url).post(path).send(body));
    expect(response.status).toBe(404);expect(mockHeartbeatService.invokeTaskExecutionLease).not.toHaveBeenCalled();
  });
  it.each(["agent:wake","agents:create","issue:mutate"])("preserves the %s permission boundary",async denied=>{
    permitExcept(denied);const app=await createApp(board,dbWithTask());
    const response=await requestApp(app,url=>request(url).post(path).send(body));
    expect(response.status).toBe(403);expect(mockHeartbeatService.invokeTaskExecutionLease).not.toHaveBeenCalled();
  });
  it("requires a same-company task before lease admission",async()=>{
    permitExcept(null);const app=await createApp(board,dbWithTask(null));
    const response=await requestApp(app,url=>request(url).post(path).send(body));
    expect(response.status).toBe(404);expect(mockHeartbeatService.invokeTaskExecutionLease).not.toHaveBeenCalled();
  });
  it("passes the exact validated request only after all existing permissions allow",async()=>{
    permitExcept(null);mockHeartbeatService.invokeTaskExecutionLease.mockResolvedValue({id:"synthetic-run",status:"queued"});
    const app=await createApp(board,dbWithTask());
    const response=await requestApp(app,url=>request(url).post(path).send(body));
    expect(response.status).toBe(202);expect(mockHeartbeatService.invokeTaskExecutionLease).toHaveBeenCalledExactlyOnceWith(agentId,board.userId,body);
    expect(mockAccessService.decide.mock.calls.map(([input])=>input.action)).toEqual(["agent:wake","agents:create","issue:mutate"]);
  });
  it("returns a raw-control seal for redacted role configuration without exposing it or creating work",async()=>{
    permitExcept(null);
    const rawAgent={...baseAgent,adapterType:"codex_local",adapterConfig:{model:"inherited-model",env:{CODEX_HOME:"synthetic-private-home"}}};
    mockAgentService.getById.mockResolvedValue(rawAgent);
    const app=await createApp(board,dbWithAgent(rawAgent));
    const response=await requestApp(app,url=>request(url).get(`${path}/controls`));
    expect(response.status).toBe(200);
    const {executionControlHash}=await import("../services/heartbeat/paused-task-execution.js");
    const {redactAgentAdapterConfig}=await import("../redaction.js");
    const controls={id:rawAgent.id,companyId:rawAgent.companyId,status:rawAgent.status,adapterType:rawAgent.adapterType,role:rawAgent.role,capabilities:rawAgent.capabilities,pauseReason:rawAgent.pauseReason,pausedAt:rawAgent.pausedAt,adapterConfig:rawAgent.adapterConfig,runtimeConfig:rawAgent.runtimeConfig,budgetMonthlyCents:rawAgent.budgetMonthlyCents,reportsTo:rawAgent.reportsTo,permissions:rawAgent.permissions};
    expect(response.body).toEqual({agentId,companyId,status:"idle",expectedModel:"inherited-model",expectedControlHash:executionControlHash(controls)});
    expect(response.body.expectedControlHash).not.toBe(executionControlHash({...controls,adapterConfig:redactAgentAdapterConfig(rawAgent.adapterConfig)}));
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(JSON.stringify(response.body)).not.toContain("synthetic-private-home");
    expect(JSON.stringify(response.body)).not.toContain("adapterConfig");
    expect(mockHeartbeatService.invokeTaskExecutionLease).not.toHaveBeenCalled();
    expect(mockAccessService.decide.mock.calls.map(([input])=>input.action)).toEqual(["agent:wake","agents:create"]);
  });
  it.each(["agent:wake","agents:create"])("protects control seals with the existing %s permission",async denied=>{
    permitExcept(denied);const app=await createApp(board);
    const response=await requestApp(app,url=>request(url).get(`${path}/controls`));
    expect(response.status).toBe(403);expect(mockHeartbeatService.invokeTaskExecutionLease).not.toHaveBeenCalled();
  });
  it("rejects agent actors from control seals",async()=>{
    const app=await createApp({type:"agent",agentId,companyId,companyIds:[companyId]});
    const response=await requestApp(app,url=>request(url).get(`${path}/controls`));
    expect(response.status).toBe(403);
  });
  it("hides cross-company control seals",async()=>{
    const app=await createApp({...board,companyIds:[]});
    const response=await requestApp(app,url=>request(url).get(`${path}/controls`));
    expect(response.status).toBe(404);
  });
  it("changes the seal when a hidden environment binding changes",async()=>{
    permitExcept(null);
    let rawAgent={...baseAgent,adapterConfig:{model:"inherited-model",env:{CODEX_HOME:"synthetic-first-home"}}};
    const app=await createApp(board,dbWithAgent(()=>rawAgent));
    mockAgentService.getById.mockResolvedValue(rawAgent);
    const first=await requestApp(app,url=>request(url).get(`${path}/controls`));
    rawAgent={...rawAgent,adapterConfig:{model:"inherited-model",env:{CODEX_HOME:"synthetic-second-home"}}};
    mockAgentService.getById.mockResolvedValue(rawAgent);
    const second=await requestApp(app,url=>request(url).get(`${path}/controls`));
    expect(first.status).toBe(200);expect(second.status).toBe(200);
    expect(first.body.expectedControlHash).not.toBe(second.body.expectedControlHash);
    expect(JSON.stringify([first.body,second.body])).not.toContain("synthetic-first-home");
    expect(JSON.stringify([first.body,second.body])).not.toContain("synthetic-second-home");
  });

  it.each([{}, { canCreateAgents: true }])("seals raw legacy permissions despite the actual service projection: %j", async permissions => {
    permitExcept(null);
    const rawAgent = { ...baseAgent, permissions };
    const db = { select: () => ({ from: () => ({ where: () => Object.assign(Promise.resolve([rawAgent]), { groupBy: async () => [] }) }) }) };
    const { agentService: actualAgentService } = await vi.importActual<typeof import("../services/agents.js")>("../services/agents.js");
    const projected = await actualAgentService(db as any).getById(agentId);
    expect(projected!.permissions).not.toEqual(rawAgent.permissions);
    mockAgentService.getById.mockResolvedValue(projected);
    const app = await createApp(board, db);
    const response = await requestApp(app, url => request(url).get(`${path}/controls`));
    const { taskExecutionControlSeal } = await import("../services/heartbeat/task-execution-lease-store.js");
    expect(response.status).toBe(200);
    expect(response.body).toEqual(taskExecutionControlSeal(rawAgent as any));
    expect(response.body.expectedControlHash).not.toBe(taskExecutionControlSeal(projected as any).expectedControlHash);
  });

  it.each([null, { ...baseAgent, companyId: "44444444-4444-4444-8444-444444444444" }])("hides a disappeared or moved raw agent after permission checks", async row => {
    permitExcept(null);
    const app = await createApp(board, dbWithAgent(row));
    const response = await requestApp(app, url => request(url).get(`${path}/controls`));
    expect(response.status).toBe(404);
    expect(mockAccessService.decide.mock.calls.map(([input]) => input.action)).toEqual(["agent:wake", "agents:create"]);
    expect(mockHeartbeatService.invokeTaskExecutionLease).not.toHaveBeenCalled();
  });
  it("reads fresh raw status and controls only after authorization", async () => {
    permitExcept(null);
    const fresh = { ...baseAgent, status: "paused", permissions: {}, adapterConfig: { model: "fresh-model" } };
    const db = dbWithAgent(fresh);
    const app = await createApp(board, db);
    db.select.mockClear();
    const response = await requestApp(app, url => request(url).get(`${path}/controls`));
    const { taskExecutionControlSeal } = await import("../services/heartbeat/task-execution-lease-store.js");
    expect(response.status).toBe(200);
    expect(response.body).toEqual(taskExecutionControlSeal(fresh as any));
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(mockAccessService.decide.mock.invocationCallOrder.at(-1)).toBeLessThan(db.select.mock.invocationCallOrder[0]);
  });
  it("does not read authoritative raw controls when management permission denies", async () => {
    permitExcept("agents:create");
    const db = dbWithAgent(baseAgent);
    const app = await createApp(board, db);
    db.select.mockClear();
    const response = await requestApp(app, url => request(url).get(`${path}/controls`));
    expect(response.status).toBe(403);
    expect(db.select).not.toHaveBeenCalled();
  });

});
