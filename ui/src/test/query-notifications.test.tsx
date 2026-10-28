// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery, notifyManager } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { installQueryTestNotifications } from './query-notifications';

it('settles real query promise and DOM notifications through act without host-clock polling', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const restore = installQueryTestNotifications();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  let release!: (value: string) => void;
  const result = new Promise<string>(resolve => { release = resolve; });
  function Consumer() {
    const query = useQuery({ queryKey: ['controlled-notification'], queryFn: () => result });
    return <div>{query.data ?? 'waiting'}</div>;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><Consumer /></QueryClientProvider>));
    expect(container.textContent).toBe('waiting');
    await act(async () => release('confirmed'));
    expect(container.textContent).toBe('confirmed');
    await act(async () => client.setQueryData(['controlled-notification'], 'next confirmed'));
    expect(container.textContent).toBe('next confirmed');
  } finally {
    try {
      await act(async () => root.unmount());
    } finally {
      restore();
      client.clear();
      container.remove();
      vi.useRealTimers();
    }
  }
});

it('restores the library host-clock scheduler after the fixture scope ends', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const restore = installQueryTestNotifications();
  try {
    const immediate = vi.fn();
    notifyManager.schedule(immediate);
    await Promise.resolve();
    expect(immediate).toHaveBeenCalledTimes(1);
    restore();
    const ordinary = vi.fn();
    notifyManager.schedule(ordinary);
    await Promise.resolve();
    expect(ordinary).not.toHaveBeenCalled();
    await vi.runOnlyPendingTimersAsync();
    expect(ordinary).toHaveBeenCalledTimes(1);
  } finally {
    restore();
    vi.useRealTimers();
  }
});
