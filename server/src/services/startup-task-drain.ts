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
  for (const release of releaseWaiters) release();
  releaseWaiters.clear();
}

export function startupTaskDrainConfigured(): boolean { return configured; }

const releaseWaiters = new Set<() => void>();

/** Defer automatic service initialization, reading durable state only when run.
 * Cancellation prevents an app stopped while held from starting later. */
export function deferStartupTaskDrain(work: () => Promise<void>): { promise: Promise<void>; cancel: () => void } {
  let cancelled = false;
  let release: (() => void) | undefined;
  const run = async () => {
    while (!cancelled && getStartupTaskDrain()) {
      await new Promise<void>((resolve) => { release = resolve; releaseWaiters.add(resolve); });
    }
    if (!cancelled) await work();
  };
  return {
    promise: run(),
    cancel: () => { cancelled = true; if (release) { releaseWaiters.delete(release); release(); } },
  };
}
