/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BridgeExecutionEngine } from '@qwen-code/acp-bridge/bridgeOptions';
import { SessionNotFoundError } from '@qwen-code/acp-bridge/bridgeErrors';
import { SessionExecutionEngineError } from '@qwen-code/qwen-code-core/services/session-execution-engine.js';
import { SessionService } from '@qwen-code/qwen-code-core/services/sessionService.js';
import { createSessionExecutionEngineSelector } from './session-execution-engine-selector.js';

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

async function writeTranscript(
  lines: Array<Record<string, unknown> | string>,
  fileSessionId = SESSION_ID,
): Promise<void> {
  const filePath = new SessionService(workspaceCwd, {
    runtimeBaseDir,
  }).getSessionTranscriptPath(fileSessionId);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    lines
      .map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
      .join('\n') + (lines.length > 0 ? '\n' : ''),
  );
}

function select(
  operation: 'spawn' | 'load' | 'resume',
  newSessionEngine: BridgeExecutionEngine = 'managed',
  sessionId = SESSION_ID,
) {
  const selector = createSessionExecutionEngineSelector({
    newSessionEngine,
    runtimeBaseDir,
  });
  return operation === 'spawn'
    ? selector({
        operation,
        request: { workspaceCwd },
        daemonOwnedStandalone: false,
      })
    : selector({
        operation,
        request: { workspaceCwd, sessionId },
        daemonOwnedStandalone: false,
      });
}

describe('createSessionExecutionEngineSelector', () => {
  it.each(['legacy', 'managed'] as const)(
    'creates new sessions on the host engine %s',
    async (engine) => {
      await expect(select('spawn', engine)).resolves.toBe(engine);
    },
  );

  it.each(['load', 'resume'] as const)(
    'keeps a complete history without an owner record on Legacy for %s',
    async (operation) => {
      await writeTranscript([record(SESSION_ID)]);
      await expect(select(operation, 'managed')).resolves.toBe('legacy');
    },
  );

  it.each([
    ['legacy', 'managed'],
    ['managed', 'legacy'],
  ] as const)(
    'restores the recorded %s owner when new sessions use %s',
    async (recorded, newSessionEngine) => {
      await writeTranscript([
        owner(SESSION_ID, recorded),
        record(SESSION_ID, { parentUuid: 'root' }),
      ]);
      await expect(select('load', newSessionEngine)).resolves.toBe(recorded);
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
    const selection = select('resume', 'legacy');
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
    await expect(select('load', 'legacy')).rejects.toBeInstanceOf(
      SessionNotFoundError,
    );
  });

  it('reads the transcript spelling the ACP child restores', async () => {
    const persisted = SESSION_ID.toUpperCase();
    await writeTranscript(
      [owner(persisted, 'managed'), record(persisted)],
      persisted,
    );
    await expect(select('load', 'legacy', SESSION_ID)).resolves.toBe('managed');
  });
});
