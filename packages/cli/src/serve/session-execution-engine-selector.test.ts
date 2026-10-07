/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BridgeExecutionSelection,
  BridgeExecutionEngine,
} from '@qwen-code/acp-bridge/bridgeOptions';
import type { BridgeSpawnRequest } from '@qwen-code/acp-bridge/bridgeTypes';
import { SessionNotFoundError } from '@qwen-code/acp-bridge/bridgeErrors';
import type { ChannelFactory } from '@qwen-code/acp-bridge/channel';
import { SessionExecutionEngineError } from '@qwen-code/qwen-code-core/services/session-execution-engine.js';
import { SessionService } from '@qwen-code/qwen-code-core/services/sessionService.js';
import {
  createPairedExecutionEngines,
  createSessionExecutionEngineSelector,
  type ManagedExecutionEngine,
  type ManagedExecutionEngineCompatibility,
} from './session-execution-engine-selector.js';

const SESSION_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

let root: string;
let workspaceCwd: string;
let runtimeBaseDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'qwen-engine-selector-'));
  workspaceCwd = path.join(root, 'workspace');
  runtimeBaseDir = path.join(root, 'runtime');
  await mkdir(workspaceCwd);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function record(
  sessionId: string,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    uuid: crypto.randomUUID(),
    parentUuid: null,
    sessionId,
    timestamp: new Date().toISOString(),
    type: 'user',
    cwd: workspaceCwd,
    message: { role: 'user', parts: [{ text: 'hello' }] },
    ...fields,
  };
}

function owner(sessionId: string, engine: unknown, version: unknown = 1) {
  return record(sessionId, {
    type: 'system',
    subtype: 'session_execution_engine',
    systemPayload: { version, engine },
  });
}

// A record core writes through its recorder; ownership must not depend on it.
function textElements(sessionId = SESSION_ID) {
  return record(sessionId, {
    type: 'system',
    subtype: 'user_text_elements',
    systemPayload: { content: 'hello', textElements: [] },
  });
}

function transcriptPath(fileSessionId = SESSION_ID): string {
  return new SessionService(workspaceCwd, {
    runtimeBaseDir,
  }).getSessionTranscriptPath(fileSessionId);
}

async function writeTranscript(
  lines: Array<Record<string, unknown> | string>,
  fileSessionId = SESSION_ID,
): Promise<void> {
  const filePath = transcriptPath(fileSessionId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    lines
      .map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
      .join('\n') + (lines.length > 0 ? '\n' : ''),
  );
}

function managedEngine(
  result:
    | ManagedExecutionEngineCompatibility
    | (() =>
        | ManagedExecutionEngineCompatibility
        | Promise<ManagedExecutionEngineCompatibility>),
) {
  const evaluate = vi.fn((_selection: BridgeExecutionSelection) =>
    typeof result === 'function' ? result() : result,
  );
  const factory: ChannelFactory = async () => {
    throw new Error('not started in selector tests');
  };
  return { factory, evaluate } satisfies ManagedExecutionEngine;
}

const COMPATIBLE = { status: 'compatible' } as const;

function spawn(
  managed?: ManagedExecutionEngine,
  request: Partial<BridgeSpawnRequest> = {},
  daemonOwnedStandalone = false,
): Promise<BridgeExecutionEngine> {
  return createSessionExecutionEngineSelector({ runtimeBaseDir, managed })({
    operation: 'spawn',
    request: { workspaceCwd, ...request },
    daemonOwnedStandalone,
  });
}

function restore(
  operation: 'load' | 'resume',
  managed?: ManagedExecutionEngine,
  sessionId = SESSION_ID,
): Promise<BridgeExecutionEngine> {
  return createSessionExecutionEngineSelector({ runtimeBaseDir, managed })({
    operation,
    request: { workspaceCwd, sessionId },
    daemonOwnedStandalone: false,
  });
}

describe('createSessionExecutionEngineSelector: new sessions', () => {
  it('creates every session on Legacy while no Managed engine exists', async () => {
    await expect(spawn()).resolves.toBe('legacy');
    await expect(spawn(undefined, { sourceType: 'default' })).resolves.toBe(
      'legacy',
    );
  });

  it.each([
    ['no source', {}],
    ['the default source without an id', { sourceType: 'default' }],
  ])(
    'selects Managed for %s when the engine proves it compatible',
    async (_name, request) => {
      const managed = managedEngine(COMPATIBLE);
      await expect(spawn(managed, request)).resolves.toBe('managed');
      expect(managed.evaluate).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'spawn',
          request: expect.objectContaining({ workspaceCwd }),
        }),
      );
    },
  );

  it.each([
    ['a sub-session', { parentSessionId: SESSION_ID }],
    [
      'a worktree session',
      { worktree: { slug: 's', path: '/w/s', branch: 'b' } },
    ],
    ['a Git branch session', { branch: { name: 'b', baseBranch: 'main' } }],
    ['a channel', { sourceType: 'channel', sourceId: 'feishu-main' }],
    ['a scheduled task controller', { sourceType: 'scheduled_task' }],
    [
      'a scheduled task run',
      { sourceType: 'default', sourceId: 'scheduled_task_run:t1' },
    ],
    [
      'a Live conversation',
      { sourceType: 'default', sourceId: 'realtime_voice:c1' },
    ],
    ['a side task', { sourceType: 'side_task' }],
    ['a Tool-only gateway session', { sourceType: 'managed-gateway' }],
    ['an unknown source', { sourceType: 'future_source' }],
  ])('keeps %s on Legacy without asking the engine', async (_name, request) => {
    const managed = managedEngine(COMPATIBLE);
    await expect(
      spawn(managed, request as Partial<BridgeSpawnRequest>),
    ).resolves.toBe('legacy');
    expect(managed.evaluate).not.toHaveBeenCalled();
  });

  it('keeps daemon-owned standalone creation on Legacy', async () => {
    const managed = managedEngine(COMPATIBLE);
    await expect(
      spawn(managed, { sourceType: 'standalone' }, true),
    ).resolves.toBe('legacy');
    await expect(spawn(managed, {}, true)).resolves.toBe('legacy');
    expect(managed.evaluate).not.toHaveBeenCalled();
  });

  it.each([
    ['deferred', { status: 'deferred', reason: 'MCP servers' }],
    ['unknown', { status: 'unknown', reason: 'unreadable settings' }],
  ] as const)('creates a %s configuration on Legacy', async (_name, result) => {
    await expect(spawn(managedEngine(result))).resolves.toBe('legacy');
  });

  it('creates on Legacy when the compatibility check fails', async () => {
    const managed = managedEngine(() => {
      throw new Error('evaluation crashed');
    });
    await expect(spawn(managed)).resolves.toBe('legacy');
  });

  it('creates on Legacy when an asynchronous compatibility check rejects', async () => {
    const managed = managedEngine(async () => {
      throw new Error('evaluation rejected');
    });
    await expect(spawn(managed)).resolves.toBe('legacy');
  });
});

describe('createSessionExecutionEngineSelector: cold restore', () => {
  it.each(['load', 'resume'] as const)(
    'keeps a complete history without an owner record on Legacy for %s',
    async (operation) => {
      await writeTranscript([record(SESSION_ID)]);
      await expect(restore(operation)).resolves.toBe('legacy');
      await expect(restore(operation, managedEngine(COMPATIBLE))).resolves.toBe(
        'legacy',
      );
    },
  );

  it.each([
    ['without an owner record', () => [record(SESSION_ID), textElements()]],
    [
      'with a Legacy owner',
      () => [owner(SESSION_ID, 'legacy'), record(SESSION_ID), textElements()],
    ],
  ])(
    'restores a Legacy history that recorded text elements %s',
    async (_name, lines) => {
      await writeTranscript(lines());
      await expect(restore('load', managedEngine(COMPATIBLE))).resolves.toBe(
        'legacy',
      );
    },
  );

  it('restores a Legacy owner on Legacy whatever the engine says', async () => {
    await writeTranscript([
      owner(SESSION_ID, 'legacy'),
      record(SESSION_ID, { parentUuid: 'root' }),
    ]);
    const managed = managedEngine(COMPATIBLE);
    await expect(restore('load', managed)).resolves.toBe('legacy');
    expect(managed.evaluate).not.toHaveBeenCalled();
  });

  it.each(['load', 'resume'] as const)(
    'refuses to %s a Managed owner while no Managed engine exists',
    async (operation) => {
      await writeTranscript([
        owner(SESSION_ID, 'managed'),
        record(SESSION_ID, { parentUuid: 'root' }),
      ]);
      const before = await readFile(transcriptPath(), 'utf8');
      const selection = restore(operation);
      await expect(selection).rejects.toBeInstanceOf(
        SessionExecutionEngineError,
      );
      await expect(selection).rejects.toMatchObject({
        errorKind: 'session_execution_engine_unavailable',
        message: expect.stringContaining('no Managed engine is available'),
      });
      expect(await readFile(transcriptPath(), 'utf8')).toBe(before);
    },
  );

  // Restores carry the session's creation metadata, but the owner already
  // reflects its purpose, so none of it is evaluated again.
  const RESTORE_PURPOSES = [
    ['a parent', { parentSessionId: 'parent-session' }, false],
    ['a channel source', { sourceType: 'channel' }, false],
    [
      'a scheduled run source',
      { sourceType: 'default', sourceId: 'scheduled_task_run:task-1' },
      false,
    ],
    ['daemon-owned standalone restore', {}, true],
  ] as const;

  it.each(RESTORE_PURPOSES)(
    'restores a Managed owner with %s on Managed without re-checking its purpose',
    async (_name, metadata, daemonOwnedStandalone) => {
      await writeTranscript([owner(SESSION_ID, 'managed'), record(SESSION_ID)]);
      const managed = managedEngine(COMPATIBLE);
      await expect(
        createSessionExecutionEngineSelector({ runtimeBaseDir, managed })({
          operation: 'load',
          request: { workspaceCwd, sessionId: SESSION_ID, ...metadata },
          daemonOwnedStandalone,
        }),
      ).resolves.toBe('managed');
    },
  );

  it.each(RESTORE_PURPOSES)(
    'refuses a Managed owner with %s while no Managed engine exists',
    async (_name, metadata, daemonOwnedStandalone) => {
      await writeTranscript([owner(SESSION_ID, 'managed'), record(SESSION_ID)]);
      await expect(
        createSessionExecutionEngineSelector({ runtimeBaseDir })({
          operation: 'load',
          request: { workspaceCwd, sessionId: SESSION_ID, ...metadata },
          daemonOwnedStandalone,
        }),
      ).rejects.toBeInstanceOf(SessionExecutionEngineError);
    },
  );

  it('restores a Managed owner on a compatible Managed engine', async () => {
    await writeTranscript([owner(SESSION_ID, 'managed'), record(SESSION_ID)]);
    const managed = managedEngine(COMPATIBLE);
    await expect(restore('resume', managed)).resolves.toBe('managed');
    expect(managed.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'resume',
        request: expect.objectContaining({ sessionId: SESSION_ID }),
      }),
    );
  });

  it.each([
    ['deferred', () => ({ status: 'deferred', reason: 'MCP servers' })],
    ['unknown', () => ({ status: 'unknown', reason: 'unreadable settings' })],
    [
      'failing',
      () => {
        throw new Error('evaluation crashed');
      },
    ],
    [
      'rejecting',
      async () => {
        throw new Error('evaluation rejected');
      },
    ],
  ] as const)(
    'refuses a Managed owner whose configuration is %s instead of using Legacy',
    async (_name, result) => {
      await writeTranscript([owner(SESSION_ID, 'managed'), record(SESSION_ID)]);
      const selection = restore(
        'load',
        managedEngine(
          result as () =>
            | ManagedExecutionEngineCompatibility
            | Promise<ManagedExecutionEngineCompatibility>,
        ),
      );
      await expect(selection).rejects.toBeInstanceOf(
        SessionExecutionEngineError,
      );
      await expect(selection).rejects.toMatchObject({
        errorKind: 'session_execution_engine_unavailable',
      });
    },
  );

  it.each([
    [
      'conflicting owners',
      () => [owner(SESSION_ID, 'legacy'), owner(SESSION_ID, 'managed')],
    ],
    ['an unknown owner version', () => [owner(SESSION_ID, 'legacy', 2)]],
    ['an unknown engine', () => [owner(SESSION_ID, 'hosted')]],
    ['a torn record', () => [record(SESSION_ID), '{"uuid":']],
  ])('rejects %s instead of guessing an engine', async (_name, lines) => {
    await writeTranscript(lines());
    const selection = restore('resume', managedEngine(COMPATIBLE));
    await expect(selection).rejects.toBeInstanceOf(SessionExecutionEngineError);
    await expect(selection).rejects.toMatchObject({
      errorKind: 'session_execution_engine_unavailable',
    });
  });

  it.each([
    ['a missing transcript', undefined],
    ['an empty transcript', []],
  ] as const)('reports %s as not found', async (_name, lines) => {
    if (lines) await writeTranscript([...lines]);
    await expect(restore('load')).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('reads the transcript spelling the ACP child restores', async () => {
    const persisted = SESSION_ID.toUpperCase();
    await writeTranscript(
      [owner(persisted, 'managed'), record(persisted)],
      persisted,
    );
    await expect(
      restore('load', managedEngine(COMPATIBLE), SESSION_ID),
    ).resolves.toBe('managed');
  });
});

describe('createPairedExecutionEngines', () => {
  const legacy: ChannelFactory = async () => {
    throw new Error('not started');
  };

  it('pairs the Legacy factory with an unavailable Managed factory', async () => {
    const engines = createPairedExecutionEngines({ legacy, runtimeBaseDir });
    expect(engines.legacy).toBe(legacy);
    await expect(engines.managed(workspaceCwd)).rejects.toThrow(
      'No Managed execution engine is available in this host.',
    );
    await expect(
      engines.select({
        operation: 'spawn',
        request: { workspaceCwd },
        daemonOwnedStandalone: false,
      }),
    ).resolves.toBe('legacy');
  });

  it('uses a registered Managed engine factory and rule', async () => {
    const managed = managedEngine(COMPATIBLE);
    const engines = createPairedExecutionEngines({
      legacy,
      runtimeBaseDir,
      managed,
    });
    expect(engines.managed).toBe(managed.factory);
    await expect(
      engines.select({
        operation: 'spawn',
        request: { workspaceCwd },
        daemonOwnedStandalone: false,
      }),
    ).resolves.toBe('managed');
  });
});
