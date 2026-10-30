// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { downloadManagedSession } from './managed-session-export';
import type { ManagedAgentProvider } from './managed-agent-provider';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('keeps an export download out of the embedding host link router and releases its URL', async () => {
  vi.useFakeTimers();
  const createObjectURL = vi.fn().mockReturnValue('blob:managed-export');
  const revokeObjectURL = vi.fn();
  vi.stubGlobal(
    'URL',
    class extends URL {
      static override createObjectURL = createObjectURL;
      static override revokeObjectURL = revokeObjectURL;
    },
  );
  const hostRouter = vi.fn((event: Event) => event.preventDefault());
  const preventNavigation = (event: Event) => event.preventDefault();
  document.addEventListener('click', hostRouter);
  document.body.addEventListener('click', preventNavigation, { capture: true });
  const provider = {
    getSession: vi
      .fn()
      .mockResolvedValue({ sessionId: 's', title: 'Title', lastSequence: 0 }),
    exportSnapshot: vi.fn().mockResolvedValue({
      items: [],
      hasMore: false,
      snapshotThroughSequence: 0,
    }),
  } as unknown as ManagedAgentProvider;
  try {
    await downloadManagedSession(
      provider,
      'c',
      's',
      'html',
      new AbortController().signal,
    );
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(hostRouter).not.toHaveBeenCalled();
    expect(document.querySelector('a[download]')).toBeNull();
    await vi.runAllTimersAsync();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:managed-export');
  } finally {
    document.removeEventListener('click', hostRouter);
    document.body.removeEventListener('click', preventNavigation, {
      capture: true,
    });
  }
});
