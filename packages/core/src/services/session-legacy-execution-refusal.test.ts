/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Config } from '../config/config.js';
import { Storage } from '../config/storage.js';
import { ChatRecordingService } from './chatRecordingService.js';
import { SessionExecutionEngineError } from './session-execution-engine.js';
import {
  isManagedExecutionTranscriptSync,
  isManagedSessionTranscriptSync,
} from '../utils/sessionStorageUtils.js';

const SESSION_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const FORK_ID = '650e8400-e29b-41d4-a716-446655440000';

let root: string;
let projectDir: string;
let config: Config;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'qwen-legacy-refusal-'));
  projectDir = path.join(root, 'project');
  await mkdir(projectDir, { recursive: true });
  Storage.setRuntimeBaseDir(path.join(root, 'runtime'));
  config = new Config({
    sessionId: SESSION_ID,
    cwd: projectDir,
    targetDir: projectDir,
    debugMode: false,
    model: 'test-model',
    chatRecording: true,
    usageStatisticsEnabled: false,
    overrideExtensions: [],
  });
});

afterEach(async () => {
  Storage.setRuntimeBaseDir(null);
  await rm(root, { recursive: true, force: true });
});

function line(fields: Record<string, unknown>): string {
  return JSON.stringify({
    uuid: randomUUID(),
    parentUuid: null,
    sessionId: SESSION_ID,
    timestamp: new Date().toISOString(),
    cwd: projectDir,
    version: 'test',
    ...fields,
  });
}

function owner(engine: 'legacy' | 'managed'): string {
  return line({
    type: 'system',
    subtype: 'session_execution_engine',
    systemPayload: { version: 1, engine },
  });
}

function userMessage(text: string): string {
  return line({ type: 'user', message: { role: 'user', parts: [{ text }] } });
}

async function writeTranscript(content: string): Promise<string> {
  const transcriptPath = config
    .getSessionService()
    .getSessionTranscriptPath(SESSION_ID);
  await mkdir(path.dirname(transcriptPath), { recursive: true });
  await writeFile(transcriptPath, content);
  return transcriptPath;
}

describe('Legacy refusal of Managed-owned transcripts', () => {
  it('refuses to execute, fork or record a transcript whose only Managed evidence is its owner record', async () => {
    const transcriptPath = await writeTranscript(
      `${owner('managed')}\n${userMessage('hello')}\n`,
    );
    const before = await readFile(transcriptPath, 'utf8');
    const service = config.getSessionService();

    // Not a Managed Session log, so format-specific paths keep treating it as
    // an ordinary transcript; only its owner makes it Managed.
    expect(isManagedSessionTranscriptSync(transcriptPath)).toBe(false);
    expect(isManagedExecutionTranscriptSync(transcriptPath)).toBe(true);

    expect(() => service.assertLegacySessionExecution(SESSION_ID)).toThrow(
      SessionExecutionEngineError,
    );
    expect(() => service.assertLegacySessionExecution(SESSION_ID)).toThrow(
      'belongs to managed, cannot execute with legacy',
    );

    await expect(service.forkSession(SESSION_ID, FORK_ID)).rejects.toThrow(
      'belongs to managed, cannot fork with the legacy session service',
    );
    await expect(
      stat(path.join(path.dirname(transcriptPath), `${FORK_ID}.jsonl`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const recorder = new ChatRecordingService(config, undefined, false);
    await expect(recorder.recordExecutionEngine('legacy')).rejects.toThrow(
      'belongs to managed, cannot record with legacy',
    );

    expect(await readFile(transcriptPath, 'utf8')).toBe(before);
  });

  it('still refuses a transcript that carries only the Managed Session header', async () => {
    const transcriptPath = await writeTranscript(
      `${line({
        type: 'system',
        subtype: 'managed_session_header_v1',
        managedSession: { engine: 'managed' },
      })}\n`,
    );

    expect(isManagedExecutionTranscriptSync(transcriptPath)).toBe(true);
    expect(() =>
      config.getSessionService().assertLegacySessionExecution(SESSION_ID),
    ).toThrow('belongs to managed, cannot execute with legacy');
  });

  it.each([
    ['a Legacy owner', () => `${owner('legacy')}\n${userMessage('hello')}\n`],
    ['no owner record', () => `${userMessage('hello')}\n`],
    [
      'a line that does not parse whole',
      () => `${userMessage('hello')}\n{"type":"assistant","mess`,
    ],
    [
      'an owner record quoted in message text',
      () =>
        `${userMessage(owner('managed'))}\n${userMessage('"engine":"managed"')}\n`,
    ],
    [
      'a system record of another subtype that mentions the owner',
      () =>
        `${line({
          type: 'system',
          subtype: 'slash_command',
          systemPayload: {
            engine: 'managed',
            args: 'session_execution_engine',
          },
        })}\n`,
    ],
    [
      'an owner-shaped record that is not a system record',
      () =>
        `${line({
          type: 'user',
          subtype: 'session_execution_engine',
          systemPayload: { version: 1, engine: 'managed' },
        })}\n${userMessage('hello')}\n`,
    ],
  ])(
    'keeps executing a transcript with %s on Legacy',
    async (_name, content) => {
      const transcriptPath = await writeTranscript(content());
      const service = config.getSessionService();

      expect(isManagedExecutionTranscriptSync(transcriptPath)).toBe(false);
      expect(() =>
        service.assertLegacySessionExecution(SESSION_ID),
      ).not.toThrow();
    },
  );

  it('forks a Legacy-owned transcript', async () => {
    await writeTranscript(`${owner('legacy')}\n${userMessage('hello')}\n`);

    await expect(
      config.getSessionService().forkSession(SESSION_ID, FORK_ID),
    ).resolves.toMatchObject({ copiedCount: expect.any(Number) });
  });
});
