/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runLogger } from '../utils/runLogger.js';
import { SessionStateStore } from './session-state-store.js';
import {
  getLegacyWorktreeState,
  projectLegacyWorktreeState,
  resolveSessionWorktreeState,
} from './legacyWorktreeSessionState.js';

describe('legacyWorktreeSessionState', () => {
  let tempDir: string;
  let store: SessionStateStore;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'test-legacy-wt-'));
    store = new SessionStateStore({
      projectRoot: '/workspace/demo',
      sessionId: 'session-legacy',
      configHomeDir: tempDir,
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns null when the historical sidecar does not exist', async () => {
    await expect(getLegacyWorktreeState(store)).resolves.toBeNull();
  });

  it('rejects a malformed historical sidecar instead of treating it as ordinary', async () => {
    await store.setSegment(
      'worktreeSession',
      {
        originalCwd: '/workspace/demo',
        worktreePath: '/workspace/demo/.qwen/worktrees/feature',
        worktreeName: 'feature',
        lifecycle: 'owner',
        sessionId: 42,
      },
      { encrypted: false },
    );

    await expect(getLegacyWorktreeState(store)).rejects.toThrow(
      /legacy worktree state/i,
    );
  });

  it('reads and projects the historical sidecar without inventing worktreeCwd', async () => {
    await store.setSegment(
      'worktreeSession',
      {
        originalCwd: '/workspace/demo/apps/desktop',
        worktreePath: '/workspace/demo/.qwen/worktrees/feature',
        worktreeName: 'feature',
        lifecycle: 'owner',
        sessionId: 'session-legacy',
      },
      { encrypted: false },
    );

    const persisted = await getLegacyWorktreeState(store);

    expect(persisted).not.toBeNull();
    expect(projectLegacyWorktreeState(persisted!)).toEqual({
      originalCwd: '/workspace/demo/apps/desktop',
      worktreePath: '/workspace/demo/.qwen/worktrees/feature',
      worktreeName: 'feature',
      sessionId: 'session-legacy',
      lifecycle: 'owner',
    });
    expect(projectLegacyWorktreeState(persisted!)).not.toHaveProperty(
      'worktreeCwd',
    );
  });

  it('restores a plaintext sidecar when an unrelated encrypted segment cannot be decrypted after a project path change', async () => {
    const sourceStore = new SessionStateStore({
      projectRoot: '/workspace/alpha/demo',
      sessionId: 'session-legacy',
      configHomeDir: tempDir,
    });
    await sourceStore.setSegment('s0', { inputTokens: 42 });
    await sourceStore.setSegment(
      'worktreeSession',
      {
        originalCwd: '/workspace/demo',
        worktreePath: '/workspace/demo/.qwen/worktrees/feature',
        worktreeName: 'feature',
        lifecycle: 'owner',
        sessionId: 'session-legacy',
      },
      { encrypted: false },
    );

    const resumedStore = new SessionStateStore({
      projectRoot: '/workspace/beta/demo',
      sessionId: 'session-legacy',
      configHomeDir: tempDir,
    });
    await fs.mkdir(path.dirname(resumedStore.getSessionStatePath()), {
      recursive: true,
    });
    await fs.copyFile(
      sourceStore.getSessionStatePath(),
      resumedStore.getSessionStatePath(),
    );
    await expect(resumedStore.getSegment('s0')).rejects.toThrow(
      /failed to read session state record/i,
    );

    const sessionPath = path.join(tempDir, 'session-legacy.jsonl');
    await fs.writeFile(sessionPath, '');

    await expect(
      resolveSessionWorktreeState(
        sessionPath,
        'session-legacy',
        resumedStore,
      ),
    ).resolves.toEqual({
      originalCwd: '/workspace/demo',
      worktreePath: '/workspace/demo/.qwen/worktrees/feature',
      worktreeName: 'feature',
      sessionId: 'session-legacy',
      lifecycle: 'owner',
    });
  });

  it('ignores an optional legacy sidecar when only its ciphertext authentication fails', async () => {
    const sourceStore = new SessionStateStore({
      projectRoot: '/workspace/alpha/demo',
      sessionId: 'session-legacy',
      configHomeDir: tempDir,
    });
    await sourceStore.setSegment('worktreeSession', {
      originalCwd: '/workspace/demo',
      worktreePath: '/workspace/demo/.qwen/worktrees/feature',
      worktreeName: 'feature',
      lifecycle: 'owner',
      sessionId: 'session-legacy',
    });

    const resumedStore = new SessionStateStore({
      projectRoot: '/workspace/beta/demo',
      sessionId: 'session-legacy',
      configHomeDir: tempDir,
    });
    await fs.mkdir(path.dirname(resumedStore.getSessionStatePath()), {
      recursive: true,
    });
    await fs.copyFile(
      sourceStore.getSessionStatePath(),
      resumedStore.getSessionStatePath(),
    );
    const warn = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});

    try {
      await expect(getLegacyWorktreeState(resumedStore)).resolves.toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('failed to decrypt legacy worktree sidecar'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ['nonce', 'n'],
    ['authentication tag', 't'],
  ] as const)(
    'rejects a legacy sidecar with an unsupported encrypted %s format',
    async (_label, field) => {
      await store.setSegment('worktreeSession', {
        originalCwd: '/workspace/demo',
        worktreePath: '/workspace/demo/.qwen/worktrees/feature',
        worktreeName: 'feature',
        lifecycle: 'owner',
        sessionId: 'session-legacy',
      });
      const statePath = store.getSessionStatePath();
      const stateFile = JSON.parse(await fs.readFile(statePath, 'utf8')) as {
        items: Record<string, Record<string, string>>;
      };
      stateFile.items['worktreeSession']![field] = '';
      await fs.writeFile(statePath, JSON.stringify(stateFile));

      await expect(getLegacyWorktreeState(store)).rejects.toThrow();
    },
  );

  it.each(['missing', 'ordinary', 'worktree'] as const)(
    'uses the sidecar only when JSONL state is absent: %s',
    async (kind) => {
      const legacy = {
        originalCwd: '/workspace/demo',
        worktreePath: '/workspace/demo/.qwen/worktrees/legacy',
        worktreeName: 'legacy',
        sessionId: 'session-legacy',
        lifecycle: 'owner' as const,
      };
      await store.setSegment('worktreeSession', legacy, { encrypted: false });
      const current = {
        ...legacy,
        worktreeName: 'current',
        lifecycle: 'attached' as const,
      };
      const sessionPath = path.join(tempDir, 'session-legacy.jsonl');
      await fs.writeFile(
        sessionPath,
        kind === 'missing'
          ? ''
          : JSON.stringify({
              type: 'worktree-state',
              sessionId: 'session-legacy',
              worktreeSession: kind === 'ordinary' ? null : current,
            }) + '\n',
      );

      const state = await resolveSessionWorktreeState(
        sessionPath,
        'session-legacy',
        store,
      );
      if (kind === 'ordinary') {
        expect(state).toBeNull();
      } else {
        expect(state).toMatchObject({
          worktreeName: kind === 'missing' ? 'legacy' : 'current',
          lifecycle: kind === 'missing' ? 'owner' : 'attached',
        });
      }
    },
  );
});
