/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpathSync } from 'node:fs';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AcpSessionBridge } from '@qwen-code/acp-bridge/bridgeTypes';
import { SessionService } from '@qwen-code/qwen-code-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSubSessionLauncher } from '../create-sub-session.js';
import { ConversationWorkspace } from '../conversations/conversation-workspace.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function createConversationWorkspace(): Promise<{
  workspace: ConversationWorkspace;
  root: string;
}> {
  const home = await mkdtemp(
    join(realpathSync.native(tmpdir()), 'qwen-live-worker-'),
  );
  temporaryDirectories.push(home);
  const workspace = new ConversationWorkspace({ homeDir: home });
  const root = (await workspace.getRoot()).canonicalRoot;
  return { workspace, root };
}

function createBridge(options: {
  boundWorkspace: string;
  failCwdChange?: boolean;
  attached?: boolean;
  killSessionResult?: boolean;
}) {
  const operations: string[] = [];
  const cwdChanges: Array<{
    sessionId: string;
    path: string;
    allowedRoots: string[];
    managedRelocation?: 'live-conversation';
  }> = [];
  const prompts: string[] = [];
  const killed: string[] = [];
  const detached: Array<{ sessionId: string; clientId?: string }> = [];
  const promptIds = new Map<string, string>();
  let sequence = 0;

  const bridge = {
    getSessionSummary: (sessionId: string) => ({ sessionId }),
    spawnOrAttach: async () => {
      const sessionId = `worker-${++sequence}`;
      operations.push(`spawn:${sessionId}`);
      return {
        sessionId,
        workspaceCwd: options.boundWorkspace,
        attached: options.attached === true,
        ...(options.attached ? { clientId: `client-${sessionId}` } : {}),
      };
    },
    changeSessionCwd: async (
      sessionId: string,
      request: {
        path: string;
        allowedRoots: string[];
        managedRelocation?: 'live-conversation';
      },
    ) => {
      operations.push(`cwd:${sessionId}`);
      cwdChanges.push({ sessionId, ...request });
      if (options.failCwdChange) throw new Error('cwd relocation failed');
      return {
        sessionId,
        previousCwd: options.boundWorkspace,
        newCwd: request.path,
        warnings: [],
      };
    },
    updateSessionMetadata: () => undefined,
    getSessionLastEventId: () => 0,
    sendPrompt: (
      sessionId: string,
      _request: unknown,
      _signal: unknown,
      context: { promptId: string },
    ) => {
      operations.push(`prompt:${sessionId}`);
      prompts.push(sessionId);
      promptIds.set(sessionId, context.promptId);
      return new Promise<never>(() => {});
    },
    async *subscribeEvents(sessionId: string) {
      yield {
        type: 'turn_complete',
        data: {
          sessionId,
          promptId: promptIds.get(sessionId),
          stopReason: 'end_turn',
        },
      };
    },
    killSession: async (sessionId: string) => {
      operations.push(`kill:${sessionId}`);
      killed.push(sessionId);
      return options.killSessionResult ?? true;
    },
    detachClient: async (sessionId: string, clientId?: string) => {
      operations.push(`detach:${sessionId}`);
      detached.push({ sessionId, clientId });
    },
    closeSession: async () => undefined,
  } as unknown as AcpSessionBridge;

  return { bridge, operations, cwdChanges, prompts, killed, detached };
}

describe('Live worker workspace isolation', () => {
  it('relocates each worker before its first prompt and keeps deletion recoverable', async () => {
    const { workspace, root } = await createConversationWorkspace();
    const fake = createBridge({ boundWorkspace: root });
    const launcher = createSubSessionLauncher({
      getBridge: () => fake.bridge,
      boundWorkspace: root,
      isolatedWorkspace: {
        materializeDirectory: (sessionId) =>
          workspace.materializeConversationDirectory(sessionId),
        discardEmptyDirectory: (sessionId) =>
          workspace.discardEmptyConversationDirectory(sessionId),
      },
    });

    const first = await launcher.launch({
      prompt: 'first task',
      completion: 'first-turn',
      callerSessionId: 'coordinator-1',
    });
    const second = await launcher.launch({
      prompt: 'second task',
      completion: 'first-turn',
      callerSessionId: 'coordinator-1',
    });

    expect(fake.operations).toEqual([
      `spawn:${first.sessionId}`,
      `cwd:${first.sessionId}`,
      `prompt:${first.sessionId}`,
      `spawn:${second.sessionId}`,
      `cwd:${second.sessionId}`,
      `prompt:${second.sessionId}`,
    ]);
    expect(fake.cwdChanges).toHaveLength(2);
    expect(fake.cwdChanges[0]!.allowedRoots).toEqual([root]);
    expect(fake.cwdChanges[1]!.allowedRoots).toEqual([root]);
    expect(fake.cwdChanges[0]!.managedRelocation).toBe('live-conversation');
    expect(fake.cwdChanges[1]!.managedRelocation).toBe('live-conversation');
    expect(fake.cwdChanges[0]!.path).not.toBe(fake.cwdChanges[1]!.path);
    expect(dirname(fake.cwdChanges[0]!.path)).toBe(root);
    expect(dirname(fake.cwdChanges[1]!.path)).toBe(root);

    expect((await lstat(fake.cwdChanges[1]!.path)).isDirectory()).toBe(true);
  });

  it('does not relocate workers for an ordinary runtime', async () => {
    const fake = createBridge({ boundWorkspace: '/ordinary/workspace' });
    const launcher = createSubSessionLauncher({
      getBridge: () => fake.bridge,
      boundWorkspace: '/ordinary/workspace',
    });

    await launcher.launch({
      prompt: 'ordinary task',
      completion: 'first-turn',
      callerSessionId: 'ordinary-parent',
    });

    expect(fake.cwdChanges).toEqual([]);
    expect(fake.operations).toEqual(['spawn:worker-1', 'prompt:worker-1']);
  });

  it.each([
    {
      attached: false,
      killSessionResult: true,
      expectedOperation: 'kill:worker-1',
      directoryRetained: false,
    },
    {
      attached: true,
      killSessionResult: true,
      expectedOperation: 'detach:worker-1',
      directoryRetained: true,
    },
    {
      attached: false,
      killSessionResult: false,
      expectedOperation: 'kill:worker-1',
      directoryRetained: true,
    },
  ])(
    'only discards a failed worker directory after a confirmed kill (attached=$attached, killed=$killSessionResult)',
    async ({
      attached,
      killSessionResult,
      expectedOperation,
      directoryRetained,
    }) => {
      const { workspace, root } = await createConversationWorkspace();
      const removeSession = vi
        .spyOn(SessionService.prototype, 'removeSession')
        .mockResolvedValue(true);
      const fake = createBridge({
        boundWorkspace: root,
        failCwdChange: true,
        attached,
        killSessionResult,
      });
      const launcher = createSubSessionLauncher({
        getBridge: () => fake.bridge,
        boundWorkspace: root,
        isolatedWorkspace: {
          materializeDirectory: (sessionId) =>
            workspace.materializeConversationDirectory(sessionId),
          discardEmptyDirectory: (sessionId) =>
            workspace.discardEmptyConversationDirectory(sessionId),
        },
      });

      await expect(
        launcher.launch({
          prompt: 'failing task',
          completion: 'first-turn',
          callerSessionId: 'coordinator-1',
        }),
      ).rejects.toThrow('cwd relocation failed');

      expect(fake.operations).toEqual([
        'spawn:worker-1',
        'cwd:worker-1',
        expectedOperation,
      ]);
      expect(fake.prompts).toEqual([]);
      if (attached) {
        expect(fake.detached).toEqual([
          { sessionId: 'worker-1', clientId: 'client-worker-1' },
        ]);
        expect(fake.killed).toEqual([]);
      } else {
        expect(fake.killed).toEqual(['worker-1']);
        expect(fake.detached).toEqual([]);
      }
      if (!attached && killSessionResult) {
        expect(removeSession).toHaveBeenCalledWith('worker-1');
      } else {
        expect(removeSession).not.toHaveBeenCalled();
      }
      if (directoryRetained) {
        expect((await lstat(fake.cwdChanges[0]!.path)).isDirectory()).toBe(
          true,
        );
      } else {
        await expect(lstat(fake.cwdChanges[0]!.path)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
    },
  );
});
