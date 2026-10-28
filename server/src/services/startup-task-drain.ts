/** Explicit operator startup hold. Restart re-arms it while configured. */
let configured = false;
let startupDrain: { startedAt: Date } | null = null;

export function initializeStartupTaskDrain(env: Record<string, string | undefined> = process.env): void {
  const value = env.PAPERCLIP_STARTUP_TASK_DRAIN?.trim().toLowerCase();
  if (value === undefined || value === "" || ["0", "false", "no", "off"].includes(value)) return;
  if (!["1", "true", "yes", "on"].includes(value)) {
    throw new Error("Invalid PAPERCLIP_STARTUP_TASK_DRAIN; refusing startup without a known admission hold state");
  }
  configured = true;
  startupDrain = { startedAt: new Date() };
}

export function getStartupTaskDrain(): { startedAt: Date } | null {
  return startupDrain;
}

export function releaseStartupTaskDrain(): void {
  startupDrain = null;
}

export function startupTaskDrainConfigured(): boolean { return configured; }
