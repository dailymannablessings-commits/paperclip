// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { AGENT_ADAPTER_TYPES, getEnvironmentCapabilities } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanyEnvironments } from "./CompanyEnvironments";
import { installQueryTestNotifications } from "@/test/query-notifications";
import { TooltipProvider } from "@/components/ui/tooltip";

const mockCompaniesApi = vi.hoisted(() => ({
  update: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({
  createOpenClawInvitePrompt: vi.fn(),
  getInviteOnboarding: vi.fn(),
}));

const mockAssetsApi = vi.hoisted(() => ({
  uploadCompanyLogo: vi.fn(),
}));

const mockEnvironmentsApi = vi.hoisted(() => ({
  list: vi.fn(),
  capabilities: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  probe: vi.fn(),
  probeConfig: vi.fn(),
  archive: vi.fn(),
}));

const mockInstanceSettingsApi = vi.hoisted(() => ({
  get: vi.fn(),
  getExperimental: vi.fn(),
}));

const mockSecretsApi = vi.hoisted(() => ({
  list: vi.fn(),
}));

const mockPushToast = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockSetSelectedCompanyId = vi.hoisted(() => vi.fn());

vi.mock("../api/companies", () => ({
  companiesApi: mockCompaniesApi,
}));

vi.mock("../api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("../api/assets", () => ({
  assetsApi: mockAssetsApi,
}));

vi.mock("../api/environments", () => ({
  environmentsApi: mockEnvironmentsApi,
}));

vi.mock("../api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("../api/secrets", () => ({
  secretsApi: mockSecretsApi,
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
  }),
}));

vi.mock("../context/ToastContext", () => ({
  useToast: () => ({
    pushToast: mockPushToast,
  }),
  useToastActions: () => ({ pushToast: mockPushToast }),
  useOptionalToastActions: () => ({ pushToast: mockPushToast }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", name: "Paperclip", issuePrefix: "PAP" }],
    selectedCompany: null,
    selectedCompanyId: "company-1",
    setSelectedCompanyId: mockSetSelectedCompanyId,
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).ResizeObserver = (globalThis as any).ResizeObserver ?? ResizeObserverStub;

async function flushReact() {
  await act(async () => { await Promise.resolve(); });
}

async function assertAfterReact(assertion: () => void) {
  await flushReact();
  assertion();
}

const ENVIRONMENTS_PATH = "/company/settings/instance/environments";

function getEnvironmentFormPage(): HTMLElement | null {
  return document.body.querySelector("[data-testid='environment-form-page']");
}

function findAction(root: ParentNode, label: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>("button,a")).find((element) => element.textContent?.trim() === label);
}

function click(element: Element | null | undefined) {
  element?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function renderCompanyEnvironments(queryClient: QueryClient, initialPath = ENVIRONMENTS_PATH) {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <TooltipProvider>
          <Routes>
            <Route path={ENVIRONMENTS_PATH} element={<CompanyEnvironments />} />
            <Route path={`${ENVIRONMENTS_PATH}/new`} element={<CompanyEnvironments mode="create" />} />
            <Route path={`${ENVIRONMENTS_PATH}/:environmentId/edit`} element={<CompanyEnvironments mode="edit" />} />
          </Routes>
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("CompanyEnvironments", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let restoreNotifications: () => void;

  beforeEach(() => {
    restoreNotifications = installQueryTestNotifications();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    mockInstanceSettingsApi.getExperimental.mockResolvedValue({
      enableEnvironments: true,
    });
    mockInstanceSettingsApi.get.mockResolvedValue({ defaultEnvironmentId: null });
    mockEnvironmentsApi.list.mockResolvedValue([]);
    mockEnvironmentsApi.capabilities.mockResolvedValue(
      getEnvironmentCapabilities(AGENT_ADAPTER_TYPES),
    );
    mockSecretsApi.list.mockResolvedValue([]);
    mockCompaniesApi.update.mockResolvedValue({
      id: "company-1",
      name: "Paperclip",
      description: null,
      logoUrl: null,
      issuePrefix: "PAP",
    });
  });

  afterEach(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      restoreNotifications();
      queryClient.clear();
      container.remove();
      document.body.innerHTML = "";
      vi.clearAllMocks();
    }
  });

  it("hides sandbox creation when no run-capable sandbox provider plugins are installed", async () => {

    await act(async () => {
      root.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();
    await flushReact();

    const optionLabels = Array.from(container.querySelectorAll("option")).map((option) => option.textContent?.trim());

    expect(optionLabels).not.toContain("Sandbox");
    expect(container.textContent).not.toContain("Fake sandbox");
    expect(container.textContent).not.toContain("Fake is the deterministic test provider");

  });

  it("omits the Local driver option and lists Sandbox before SSH", async () => {
    mockEnvironmentsApi.capabilities.mockResolvedValue(
      getEnvironmentCapabilities(AGENT_ADAPTER_TYPES, {
        sandboxProviders: {
          "secure-plugin": {
            status: "supported",
            supportsSavedProbe: true,
            supportsUnsavedProbe: true,
            supportsRunExecution: true,
            supportsReusableLeases: true,
            displayName: "Secure Sandbox",
            configSchema: { type: "object", properties: {} },
          },
        },
      }),
    );

    await act(async () => {
      root.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();
    await flushReact();

    const addEnvironmentButton = container.querySelector('[aria-label="Add environment"]');
    expect(addEnvironmentButton).toBeTruthy();

    await act(async () => {
      click(addEnvironmentButton);
    });

    await assertAfterReact(() => expect(getEnvironmentFormPage()).toBeTruthy());
    const dialog = getEnvironmentFormPage();

    const driverSelect = Array.from(dialog?.querySelectorAll("select") ?? [])
      .find((select) => Array.from(select.options).some((option) => option.value === "ssh")) as
      | HTMLSelectElement
      | undefined;
    expect(driverSelect).toBeTruthy();

    const driverOptionValues = Array.from(driverSelect!.options).map((option) => option.value);
    expect(driverOptionValues).not.toContain("local");
    expect(driverOptionValues).toEqual(["sandbox", "ssh"]);

  });

  it("shows the Local driver option when editing an existing local environment", async () => {
    mockEnvironmentsApi.list.mockResolvedValue([
      {
        id: "env-local",
        companyId: "company-1",
        name: "Local host",
        description: null,
        driver: "local",
        status: "active",
        config: {},
        metadata: null,
        createdAt: new Date("2026-04-25T00:00:00.000Z"),
        updatedAt: new Date("2026-04-25T00:00:00.000Z"),
      },
    ]);

    await act(async () => {
      root.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();
    await flushReact();

    const editButton = findAction(container, "Edit");
    expect(editButton).toBeTruthy();

    await act(async () => {
      click(editButton);
    });

    await assertAfterReact(() => expect(getEnvironmentFormPage()).toBeTruthy());
    const dialog = getEnvironmentFormPage();

    const driverSelect = Array.from(dialog?.querySelectorAll("select") ?? [])
      .find((select) => Array.from(select.options).some((option) => option.value === "ssh")) as
      | HTMLSelectElement
      | undefined;
    expect(driverSelect).toBeTruthy();

    const driverOptionValues = Array.from(driverSelect!.options).map((option) => option.value);
    expect(driverOptionValues).toContain("local");
    expect(driverSelect!.value).toBe("local");

  });

  it("preserves sandbox config when re-selecting the same provider while editing", async () => {
    mockEnvironmentsApi.list.mockResolvedValue([
      {
        id: "env-1",
        companyId: "company-1",
        name: "Secure Sandbox",
        description: null,
        driver: "sandbox",
        status: "active",
        config: {
          provider: "secure-plugin",
          template: "saved-template",
        },
        metadata: null,
        createdAt: new Date("2026-04-25T00:00:00.000Z"),
        updatedAt: new Date("2026-04-25T00:00:00.000Z"),
      },
    ]);
    mockEnvironmentsApi.capabilities.mockResolvedValue(
      getEnvironmentCapabilities(AGENT_ADAPTER_TYPES, {
        sandboxProviders: {
          "secure-plugin": {
            status: "supported",
            supportsSavedProbe: true,
            supportsUnsavedProbe: true,
            supportsRunExecution: true,
            supportsReusableLeases: true,
            displayName: "Secure Sandbox",
            configSchema: {
              type: "object",
              properties: {
                template: { type: "string", title: "Template" },
              },
            },
          },
        },
      }),
    );

    await act(async () => {
      root.render(renderCompanyEnvironments(queryClient));
    });
    await flushReact();
    await flushReact();

    expect(container.textContent).toContain("Secure Sandbox");

    const editButton = findAction(container, "Edit");
    expect(editButton).toBeTruthy();

    await act(async () => {
      click(editButton);
    });

    await assertAfterReact(() => expect(getEnvironmentFormPage()).toBeTruthy());
    const dialog = getEnvironmentFormPage();

    const providerSelect = Array.from(dialog?.querySelectorAll("select") ?? []).find((select) =>
      Array.from(select.options).some((option) => option.value === "secure-plugin"),
    ) as HTMLSelectElement | undefined;
    expect(providerSelect).toBeTruthy();

    await act(async () => {
      providerSelect!.value = "secure-plugin";
      providerSelect!.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();

    const templateInput = Array.from(dialog?.querySelectorAll("input") ?? [])
      .find((input) => (input as HTMLInputElement).value === "saved-template") as HTMLInputElement | undefined;
    expect(templateInput?.value).toBe("saved-template");

  });
});
