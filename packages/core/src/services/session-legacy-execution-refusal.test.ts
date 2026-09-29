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
import { LocalManagedSessionAuthority } from '../managed-runtime/managed-session-authority.js';
import { ChatRecordingService } from './chatRecordingService.js';
import { SessionExecutionEngineError } from './session-execution-engine.js';
import { readSessionTranscriptSnapshot } from './session-transcript-reader.js';
import { SessionWriterLease } from './session-writer-lease.js';
import {
  isManagedExecutionTranscriptSync,
  isManagedOwnerRecord,
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
  Storage.setRuntimeBaseDir(runtimeDir());
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

function runtimeDir(): string {
  return path.join(root, 'runtime');
}

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

function durableRef(kind: string) {
  return {
    resourceId: kind,
    kind,
    schemaVersion: 1,
    byteLength: 4,
    digest: 'b'.repeat(64),
  };
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
  it('refuses to execute, fork, record or rename a transcript whose only Managed evidence is its owner record', async () => {
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

    await expect(
      service.renameSession(SESSION_ID, 'renamed on Legacy'),
    ).rejects.toThrow(
      'belongs to managed, rename must go through its session authority',
    );
    await expect(
      service.renameSessionForLifecycle(
        SESSION_ID,
        'renamed on Legacy',
        'manual',
        'active',
      ),
    ).rejects.toThrow(
      'belongs to managed, rename must go through its session authority',
    );

    expect(await readFile(transcriptPath, 'utf8')).toBe(before);
  });

  it('refuses to rename an archived transcript whose only Managed evidence is its owner record', async () => {
    const archivedPath = path.join(
      path.dirname(
        config.getSessionService().getSessionTranscriptPath(SESSION_ID),
      ),
      'archive',
      `${SESSION_ID}.jsonl`,
    );
    await mkdir(path.dirname(archivedPath), { recursive: true });
    await writeFile(archivedPath, `${owner('managed')}\n`);
    const before = await readFile(archivedPath, 'utf8');

    await expect(
      config
        .getSessionService()
        .renameSession(SESSION_ID, 'renamed on Legacy', 'manual', 'archived'),
    ).rejects.toThrow(SessionExecutionEngineError);
    expect(await readFile(archivedPath, 'utf8')).toBe(before);
  });

  it('keeps a Managed create that stopped before its header completable', async () => {
    // What a Managed create leaves when it stops between its owner record and
    // its header.
    const transcriptPath = await writeTranscript(`${owner('managed')}\n`);

    await expect(
      config.getSessionService().renameSession(SESSION_ID, 'renamed on Legacy'),
    ).rejects.toThrow(SessionExecutionEngineError);

    // A Legacy record after the owner would make the next Managed open refuse
    // the transcript as history it cannot import.
    const lease = await SessionWriterLease.acquire({
      runtimeBaseDir: runtimeDir(),
      sessionId: SESSION_ID,
      transcriptPath,
    });
    try {
      const authority = await LocalManagedSessionAuthority.open({
        lease,
        sessionKey: {
          tenantId: 'local',
          workspaceId: 'workspace',
          sessionId: SESSION_ID,
        },
        cwd: projectDir,
        version: 'test',
        create: {
          definitionRef: durableRef('managed-definition'),
          rootSnapshotRef: durableRef('managed-root'),
          createdBy: 'test',
        },
      });
      expect(authority.sessionHeader.engine).toBe('managed');
    } finally {
      await lease.release();
    }
    expect(isManagedSessionTranscriptSync(transcriptPath)).toBe(true);
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
      'an owner record that does not parse whole',
      // Cut just before its closing braces, so the line still names the
      // Managed engine.
      () => `${userMessage('hello')}\n${owner('managed').slice(0, -2)}`,
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
    'keeps executing and renaming a transcript with %s on Legacy',
    async (_name, content) => {
      const transcriptPath = await writeTranscript(content());
      const service = config.getSessionService();

      expect(isManagedExecutionTranscriptSync(transcriptPath)).toBe(false);
      expect(() =>
        service.assertLegacySessionExecution(SESSION_ID),
      ).not.toThrow();
      await expect(
        service.renameSession(SESSION_ID, 'renamed on Legacy'),
      ).resolves.toBe(true);
    },
  );

  it('forks a Legacy-owned transcript', async () => {
    await writeTranscript(`${owner('legacy')}\n${userMessage('hello')}\n`);

    await expect(
      config.getSessionService().forkSession(SESSION_ID, FORK_ID),
    ).resolves.toMatchObject({ copiedCount: expect.any(Number) });
  });
});

describe('Managed owner evidence', () => {
  const ownerRecord = (fields: Record<string, unknown>) =>
    JSON.parse(
      line({ type: 'system', subtype: 'session_execution_engine', ...fields }),
    ) as Record<string, unknown>;

  // The owner reader decides which engine may open a session; the evidence
  // decides what Legacy refuses. Within the head window, a record the reader
  // verifies as Managed must be evidence, and evidence the reader rejects must
  // leave the owner unavailable, never Legacy.
  it.each<[string, Record<string, unknown>, boolean, string]>([
    [
      'the owner record a Managed create writes',
      { systemPayload: { version: 1, engine: 'managed' } },
      true,
      'managed',
    ],
    [
      'a Managed owner without a version',
      { systemPayload: { engine: 'managed' } },
      true,
      'unavailable',
    ],
    [
      'a Managed owner of another version',
      { systemPayload: { version: 2, engine: 'managed' } },
      true,
      'unavailable',
    ],
    [
      'a Legacy owner',
      { systemPayload: { version: 1, engine: 'legacy' } },
      false,
      'legacy',
    ],
    [
      'an owner-shaped record that is not a system record',
      {
        type: 'user',
        systemPayload: { version: 1, engine: 'managed' },
      },
      false,
      'unavailable',
    ],
    [
      'an owner record without a payload',
      { engine: 'managed' },
      false,
      'unavailable',
    ],
  ])(
    'agrees with the owner reader on %s',
    async (_name, fields, evidence, readOwner) => {
      // Built here, after beforeEach, so the record carries the project
      // directory as a real one does.
      const record = ownerRecord(fields);
      expect(isManagedOwnerRecord(record)).toBe(evidence);

      const transcriptPath = await writeTranscript(
        `${JSON.stringify(record)}\n${userMessage('hello')}\n`,
      );
      expect(isManagedExecutionTranscriptSync(transcriptPath)).toBe(evidence);
      const snapshot = await readSessionTranscriptSnapshot(
        transcriptPath,
        SESSION_ID,
      );
      const state = snapshot!.executionEngine;
      expect(state.status === 'verified' ? state.engine : state.status).toBe(
        readOwner,
      );
    },
  );

  // The owner reader parses each line tolerantly: objects written back to back
  // on one line count separately, a leading byte-order mark is skipped, and
  // JSON escapes decode. Legacy reads the head lines the same way.
  it.each<[string, (ownerLine: string) => string]>([
    [
      'on a line of its own',
      (ownerLine) => `${ownerLine}\n${userMessage('hello')}\n`,
    ],
    [
      'followed by another record on its line',
      (ownerLine) => `${ownerLine}${userMessage('hello')}\n`,
    ],
    [
      'preceded by another record on its line',
      (ownerLine) => `${userMessage('hello')}${ownerLine}\n`,
    ],
    [
      'on a later head line',
      (ownerLine) => `${userMessage('hello')}\n${ownerLine}\n`,
    ],
    [
      'after a byte-order mark',
      (ownerLine) => `\uFEFF${ownerLine}\n${userMessage('hello')}\n`,
    ],
    [
      'whose subtype is written with JSON escapes',
      (ownerLine) =>
        `${ownerLine.replace(
          '"session_execution_engine"',
          '"session\\u005fexecution\\u005fengine"',
        )}\n${userMessage('hello')}\n`,
    ],
  ])(
    'agrees with the owner reader on a Managed owner record %s',
    async (_name, layout) => {
      const transcriptPath = await writeTranscript(layout(owner('managed')));
      const snapshot = await readSessionTranscriptSnapshot(
        transcriptPath,
        SESSION_ID,
      );
      expect(snapshot!.executionEngine).toMatchObject({
        status: 'verified',
        engine: 'managed',
      });

      expect(isManagedExecutionTranscriptSync(transcriptPath)).toBe(true);
      expect(() =>
        config.getSessionService().assertLegacySessionExecution(SESSION_ID),
      ).toThrow(SessionExecutionEngineError);
      await expect(
        config
          .getSessionService()
          .renameSession(SESSION_ID, 'renamed on Legacy'),
      ).rejects.toThrow(SessionExecutionEngineError);
    },
  );
});
