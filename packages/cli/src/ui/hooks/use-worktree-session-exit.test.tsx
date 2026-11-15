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
  mkdir: vi.fn(),
  read: vi.fn(),
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, default: { ...actual, watch: seams.watch } };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, default: { ...actual, mkdir: seams.mkdir } };
});
vi.mock('@qwen-code/qwen-code-core/services/worktreeSessionService.js', () => ({
  readWorktreeSession: seams.read,
}));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let dispose: (() => void) | undefined;

beforeEach(() => {
  vi.resetModules();
  seams.watch.mockReset();
  seams.mkdir.mockReset().mockResolvedValue(undefined);
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

describe('worktree watcher final-exit policy', () => {
  it('closes an ordinary unmount even when no worktree sidecar exists', async () => {
    const handle = watcher();
    seams.watch.mockReturnValue(handle);
    const { view } = await mount();
    expect(seams.watch).toHaveBeenCalledOnce();
    expect(view.result.current).toBeNull();
    view.unmount();
    dispose = undefined;
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it('closes the old watcher on owner/session replacement and the new one on unmount', async () => {
    const first = watcher();
    const second = watcher();
    seams.watch.mockReturnValueOnce(first).mockReturnValueOnce(second);
    const { view, act } = await mount();
    view.rerender({ owner: config('second') });
    await act(async () => {
      await Promise.resolve();
    });
    expect(first.close).toHaveBeenCalledOnce();
    expect(seams.watch).toHaveBeenCalledTimes(2);
    expect(second.close).not.toHaveBeenCalled();
    view.unmount();
    dispose = undefined;
    expect(second.close).toHaveBeenCalledOnce();
  });

  it('honors the public final-exit policy instead of entering native close on unmount', async () => {
    const handle = watcher();
    seams.watch.mockReturnValue(handle);
    const { view } = await mount();
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
    expect(handle.close).not.toHaveBeenCalled();
  });
});
