/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';

const seams = vi.hoisted(() => ({
  watch: vi.fn(),
  watchFile: vi.fn(),
  unwatchFile: vi.fn(),
  read: vi.fn(),
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      watch: seams.watch,
      watchFile: seams.watchFile,
      unwatchFile: seams.unwatchFile,
    },
  };
});
vi.mock('@qwen-code/qwen-code-core/services/worktreeSessionService.js', () => ({
  readWorktreeSession: seams.read,
}));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let dispose: (() => void) | undefined;

beforeEach(() => {
  vi.resetModules();
  seams.watch.mockReset();
  seams.watchFile.mockReset();
  seams.unwatchFile.mockReset();
  seams.read.mockReset().mockResolvedValue(null);
  Object.defineProperty(process, 'platform', { value: 'darwin' });
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  Object.defineProperty(process, 'platform', platform);
  vi.resetModules();
});

function config(sessionId: string): Config {
  return {
    getSessionId: () => sessionId,
    getSessionService: () => ({
      getWorktreeSessionPath: (id: string) =>
        `/owned/chats/${id}.worktree.json`,
    }),
  } as unknown as Config;
}
function watcher() {
  return Object.assign(new EventEmitter(), { close: vi.fn() });
}
async function mount() {
  // The published pure.js entry avoids registering hooks inside a test.
  // Import after reset so both React consumers share one module owner.
  // eslint-disable-next-line import/no-internal-modules
  const { renderHook, act } = await import('@testing-library/react/pure.js');
  const { useWorktreeSession } = await import('./useWorktreeSession.js');
  const view = renderHook(
    ({ owner }: { owner: Config }) => useWorktreeSession(owner),
    {
      initialProps: { owner: config('first') },
    },
  );
  dispose = view.unmount;
  await act(async () => {
    await Promise.resolve();
  });
  return { view, act };
}

describe('worktree stat subscription cleanup', () => {
  it('unsubscribes an ordinary unmount even when no sidecar exists', async () => {
    const { view } = await mount();
    expect(seams.watchFile).toHaveBeenCalledExactlyOnceWith(
      '/owned/chats/first.worktree.json',
      { persistent: false, interval: 500 },
      expect.any(Function),
    );
    expect(view.result.current).toBeNull();
    const listener = seams.watchFile.mock.calls[0][2];
    view.unmount();
    dispose = undefined;
    expect(seams.unwatchFile).toHaveBeenCalledExactlyOnceWith(
      '/owned/chats/first.worktree.json',
      listener,
    );
    expect(seams.watch).not.toHaveBeenCalled();
  });

  it('unsubscribes the old owner and leaves the successor until its unmount', async () => {
    const { view, act } = await mount();
    const firstListener = seams.watchFile.mock.calls[0][2];
    view.rerender({ owner: config('second') });
    await act(async () => {
      await Promise.resolve();
    });
    expect(seams.unwatchFile).toHaveBeenCalledExactlyOnceWith(
      '/owned/chats/first.worktree.json',
      firstListener,
    );
    expect(seams.watchFile).toHaveBeenCalledTimes(2);
    const secondListener = seams.watchFile.mock.calls[1][2];
    view.unmount();
    dispose = undefined;
    expect(seams.unwatchFile).toHaveBeenLastCalledWith(
      '/owned/chats/second.worktree.json',
      secondListener,
    );
    expect(seams.watch).not.toHaveBeenCalled();
  });

  it('unsubscribes on final exit without creating a native FSWatcher', async () => {
    const { view } = await mount();
    const listener = seams.watchFile.mock.calls[0][2];
    const { closeFileWatcher, prepareFileWatchersForProcessExit } =
      await import('@qwen-code/qwen-code-core/utils/file-watcher-cleanup.js');
    const control = watcher();
    const onChange = vi.fn();
    control.on('change', onChange);
    prepareFileWatchersForProcessExit();
    await closeFileWatcher(control);
    control.emit('change', 'rename', 'session.worktree.json');
    expect(control.close).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();

    view.unmount();
    dispose = undefined;
    expect(seams.unwatchFile).toHaveBeenCalledExactlyOnceWith(
      '/owned/chats/first.worktree.json',
      listener,
    );
    expect(seams.watch).not.toHaveBeenCalled();
  });
});
