/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  writeWorktreeSession,
  clearWorktreeSession,
  type Config,
  type WorktreeSession,
} from '@qwen-code/qwen-code-core';
import { useWorktreeSession } from './useWorktreeSession.js';
import * as WorktreeSessionService from '@qwen-code/qwen-code-core/services/worktreeSessionService.js';

const SESSION_ID = 'test-session-id';

const watcherGate = vi.hoisted(() => ({
  active: undefined as
    | {
        directory: string;
        started: () => void;
        release: Promise<void>;
      }
    | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const wrapped = {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      const gate = watcherGate.active;
      if (gate && String(args[0]) === gate.directory) {
        watcherGate.active = undefined;
        gate.started();
        await gate.release;
      }
      return actual.mkdir(...args);
    },
  };
  return { ...wrapped, default: wrapped };
});

function makeMockConfig(sidecarPath: string): Config {
  return {
    getSessionId: () => SESSION_ID,
    getSessionService: () => ({
      getWorktreeSessionPath: (_id: string) => sidecarPath,
    }),
  } as unknown as Config;
}

const sample: WorktreeSession = {
  slug: 'my-feature',
  worktreePath: '/repo/.qwen/worktrees/my-feature',
  worktreeBranch: 'worktree-my-feature',
  originalCwd: '/repo',
  originalBranch: 'main',
  originalHeadCommit: 'a'.repeat(40),
};

describe('useWorktreeSession', () => {
  let tmpDir: string;
  let sidecarPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'use-wt-session-'));
    sidecarPath = path.join(tmpDir, 'session.worktree.json');
    watcherGate.active = undefined;
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('ignores worktree sidecars and skips watcher setup in tool sandbox', async () => {
    await writeWorktreeSession(sidecarPath, sample);
    const config = makeMockConfig(sidecarPath);
    config.getShellExecutionSandbox = vi
      .fn()
      .mockReturnValue({ backend: 'bwrap' });
    const sessionService = vi.spyOn(config, 'getSessionService');
    const { result } = renderHook(() => useWorktreeSession(config));
    expect(result.current).toBeNull();
    expect(sessionService).not.toHaveBeenCalled();
    expect(await fs.readFile(sidecarPath, 'utf8')).toContain(sample.slug);
  });

  it('returns null when no sidecar exists', async () => {
    const config = makeMockConfig(sidecarPath);
    const { result } = renderHook(() => useWorktreeSession(config));
    // No sidecar yet → load() resolves to null on mount.
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current).toBeNull();
  });

  it('returns the parsed sidecar when one exists at mount time', async () => {
    await writeWorktreeSession(sidecarPath, sample);
    const config = makeMockConfig(sidecarPath);
    const { result } = renderHook(() => useWorktreeSession(config));
    // Wait for the initial async load to complete + flush React state.
    await vi.waitFor(
      () => {
        expect(result.current).not.toBeNull();
      },
      { timeout: 1000 },
    );
    expect(result.current?.slug).toBe(sample.slug);
    expect(result.current?.worktreePath).toBe(sample.worktreePath);
  });

  it('does not expose a retained-removal binding as an active worktree', async () => {
    await writeWorktreeSession(sidecarPath, sample);
    const config = makeMockConfig(sidecarPath);
    const { result } = renderHook(() => useWorktreeSession(config));
    await vi.waitFor(() => {
      expect(result.current?.slug).toBe(sample.slug);
    });

    await writeWorktreeSession(sidecarPath, {
      ...sample,
      worktreeRemoved: {
        archiveKey: 'session.1.1.worktree-snapshot.tar.gz',
      },
    });

    await vi.waitFor(() => {
      expect(result.current).toBeNull();
    });
    await expect(fs.readFile(sidecarPath, 'utf8')).resolves.toContain(
      'session.1.1.worktree-snapshot.tar.gz',
    );
  });

  it('refreshes after a retained binding is written before watcher registration', async () => {
    await writeWorktreeSession(sidecarPath, sample);
    let unblockWatcher!: () => void;
    let notifyWatcherBlocked!: () => void;
    const watcherBlocked = new Promise<void>((resolve) => {
      notifyWatcherBlocked = resolve;
    });
    const releaseWatcher = new Promise<void>((resolve) => {
      unblockWatcher = resolve;
    });
    watcherGate.active = {
      directory: path.dirname(sidecarPath),
      started: notifyWatcherBlocked,
      release: releaseWatcher,
    };

    try {
      const config = makeMockConfig(sidecarPath);
      const { result } = renderHook(() => useWorktreeSession(config));
      await watcherBlocked;
      await vi.waitFor(() => {
        expect(result.current?.slug).toBe(sample.slug);
      });
      await writeWorktreeSession(sidecarPath, {
        ...sample,
        worktreeRemoved: {
          archiveKey: 'session.1.1.worktree-snapshot.tar.gz',
        },
      });
      unblockWatcher();

      await vi.waitFor(() => {
        expect(result.current).toBeNull();
      });
      await expect(fs.readFile(sidecarPath, 'utf8')).resolves.toContain(
        'session.1.1.worktree-snapshot.tar.gz',
      );
    } finally {
      unblockWatcher();
      watcherGate.active = undefined;
    }
  });

  it('does not let a late older read publish an active worktree over a retained binding', async () => {
    await writeWorktreeSession(sidecarPath, sample);
    const readActual = WorktreeSessionService.readWorktreeSession;
    let releaseFirst!: () => void;
    let releaseLater!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const laterGate = new Promise<void>((resolve) => {
      releaseLater = resolve;
    });
    const read = vi
      .spyOn(WorktreeSessionService, 'readWorktreeSession')
      .mockImplementation(async (filePath, options) => {
        const invocation = read.mock.calls.length;
        const observed = await readActual(filePath, options);
        if (invocation === 1) {
          await firstGate;
        } else {
          await laterGate;
        }
        return observed;
      });
    const { result } = renderHook(() =>
      useWorktreeSession(makeMockConfig(sidecarPath)),
    );
    await vi.waitFor(() => {
      expect(read).toHaveBeenCalledOnce();
    });

    await writeWorktreeSession(sidecarPath, {
      ...sample,
      worktreeRemoved: {
        archiveKey: 'session.1.1.worktree-snapshot.tar.gz',
      },
    });
    await vi.waitFor(() => {
      expect(read.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    releaseLater();
    await Promise.all(read.mock.results.slice(1).map((entry) => entry.value));

    expect(result.current).toBeNull();
    releaseFirst();
    await act(async () => {
      await read.mock.results[0]!.value;
    });
    expect(result.current).toBeNull();
    await expect(fs.readFile(sidecarPath, 'utf8')).resolves.toContain(
      'session.1.1.worktree-snapshot.tar.gz',
    );
    read.mockRestore();
  });

  it('reacts to sidecar deletion (clear)', async () => {
    await writeWorktreeSession(sidecarPath, sample);
    const config = makeMockConfig(sidecarPath);
    const { result } = renderHook(() => useWorktreeSession(config));
    await vi.waitFor(
      () => {
        expect(result.current?.slug).toBe(sample.slug);
      },
      { timeout: 1000 },
    );
    // Simulate exit_worktree clearing the sidecar.
    await clearWorktreeSession(sidecarPath);
    await vi.waitFor(
      () => {
        expect(result.current).toBeNull();
      },
      { timeout: 2000 },
    );
  });

  it('reacts to sidecar creation (enter_worktree after mount)', async () => {
    const config = makeMockConfig(sidecarPath);
    const { result } = renderHook(() => useWorktreeSession(config));
    // Starts null because no sidecar at mount.
    await new Promise((r) => setTimeout(r, 50));
    expect(result.current).toBeNull();

    // Simulate enter_worktree writing the sidecar after the hook mounted.
    await writeWorktreeSession(sidecarPath, sample);

    await vi.waitFor(
      () => {
        expect(result.current?.slug).toBe(sample.slug);
      },
      { timeout: 2000 },
    );
  });
});
