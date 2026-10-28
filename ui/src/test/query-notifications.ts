import { defaultScheduler, notifyManager } from '@tanstack/react-query';

/** Test-only scheduler: callers must await React act and restore after unmount/clear. */
export function installQueryTestNotifications(): () => void {
  notifyManager.setScheduler(queueMicrotask);
  return () => notifyManager.setScheduler(defaultScheduler);
}
