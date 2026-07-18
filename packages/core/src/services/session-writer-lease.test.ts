/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Storage } from '../config/storage.js';
import { writeRuntimeStatus } from '../utils/runtimeStatus.js';
import type { ChatRecord } from './chatRecordingService.js';
import { SessionService } from './sessionService.js';
import {
  getSessionWriterLockPath,
  SessionTranscriptChangedError,
  SessionWriterConflictError,
  SessionWriterLease,
  SessionWriterLostError,
  SessionWriterUnavailableError,
} from './session-writer-lease.js';

describe('SessionWriterLease', () => {
  let runtimeBaseDir: string;
  let transcriptPath: string;
  let sessionId: string;

  beforeEach(async () => {
    runtimeBaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-lease-'));
    sessionId = randomUUID();
    transcriptPath = path.join(
      runtimeBaseDir,
      'projects',
      'project',
      'chats',
      `${sessionId}.jsonl`,
    );
  });

  afterEach(async () => {
    await fs.rm(runtimeBaseDir, { recursive: true, force: true });
  });

  async function acquire(): Promise<SessionWriterLease> {
    return SessionWriterLease.acquire({
      runtimeBaseDir,
      sessionId,
      transcriptPath,
      processKind: 'interactive',
      qwenVersion: 'test',
    });
  }

  function lockRecord(overrides: Record<string, unknown> = {}) {
    return {
      schema_version: 1,
      session_id: sessionId,
      owner_id: randomUUID(),
      pid: process.pid,
      hostname: os.hostname(),
      process_kind: 'interactive',
      acquired_at: new Date().toISOString(),
      qwen_version: 'test',
      ...overrides,
    };
  }

  async function writeLock(value: unknown): Promise<string> {
    const lockPath = getSessionWriterLockPath(runtimeBaseDir, sessionId);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, JSON.stringify(value), { mode: 0o600 });
    return lockPath;
  }

  it('allows only one owner in the same process', async () => {
    const lease = await acquire();
    await expect(acquire()).rejects.toBeInstanceOf(SessionWriterConflictError);
    await lease.release();
  });

  it('rejects a live owner from another process', async () => {
    await writeLock(lockRecord({ pid: 1 }));
    await expect(acquire()).rejects.toBeInstanceOf(SessionWriterConflictError);
  });

  it('rejects a lock held by a live child process', async () => {
    const lockPath = getSessionWriterLockPath(runtimeBaseDir, sessionId);
    const script = `
      const fs = require('node:fs');
      const os = require('node:os');
      const path = require('node:path');
      const [lockPath, sessionId] = process.argv.slice(1);
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, JSON.stringify({
        schema_version: 1,
        session_id: sessionId,
        owner_id: 'child-owner',
        pid: process.pid,
        hostname: os.hostname(),
        process_kind: 'interactive',
        acquired_at: new Date().toISOString(),
        qwen_version: 'test',
      }), { mode: 0o600 });
      process.stdout.write('ready\\n');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ['-e', script, lockPath, sessionId], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await Promise.race([
        once(child.stdout, 'data'),
        once(child, 'error').then(([error]) => Promise.reject(error)),
      ]);
      await expect(acquire()).rejects.toBeInstanceOf(
        SessionWriterConflictError,
      );
    } finally {
      child.kill('SIGTERM');
      if (child.exitCode === null) await once(child, 'exit');
    }
  });

  it('reclaims a dead local owner', async () => {
    await writeLock(lockRecord({ pid: 2_147_483_647 }));
    const lease = await acquire();
    expect(lease.ownerId).toBeTruthy();
    await lease.release();
  });

  it('reclaims a live PID whose process start identity changed', async () => {
    await writeLock(
      lockRecord({
        pid: process.pid,
        process_start_time_ms: 1,
      }),
    );

    const lease = await acquire();

    expect(lease.ownerId).toBeTruthy();
    await lease.release();
  });

  it('never reclaims a foreign-host owner', async () => {
    await writeLock(
      lockRecord({ hostname: 'another-host.invalid', pid: 2_147_483_647 }),
    );
    await expect(acquire()).rejects.toBeInstanceOf(SessionWriterConflictError);
  });

  it('fails closed when a lock record names another session', async () => {
    await writeLock(lockRecord({ session_id: randomUUID() }));
    await expect(acquire()).rejects.toBeInstanceOf(
      SessionWriterUnavailableError,
    );
  });

  it('honors the grace period for malformed locks', async () => {
    const lockPath = await writeLock('not a lock');
    await expect(acquire()).rejects.toBeInstanceOf(SessionWriterConflictError);

    const old = new Date(Date.now() - 10_000);
    await fs.utimes(lockPath, old, old);
    const lease = await acquire();
    await lease.release();
  });

  it('does not reclaim an old malformed lock with a live runtime sidecar', async () => {
    const lockPath = await writeLock('not a lock');
    const old = new Date(Date.now() - 10_000);
    await fs.utimes(lockPath, old, old);
    await writeRuntimeStatus(
      path.join(
        runtimeBaseDir,
        'projects',
        'project',
        'chats',
        `${sessionId}.runtime.json`,
      ),
      { sessionId, workDir: '/workspace', pid: process.pid },
    );
    await expect(acquire()).rejects.toBeInstanceOf(SessionWriterConflictError);
  });

  it('reclaims an old malformed lock whose runtime PID was reused', async () => {
    const lockPath = await writeLock('not a lock');
    const old = new Date(Date.now() - 10_000);
    await fs.utimes(lockPath, old, old);
    const statusPath = path.join(
      runtimeBaseDir,
      'projects',
      'project',
      'chats',
      `${sessionId}.runtime.json`,
    );
    await fs.mkdir(path.dirname(statusPath), { recursive: true });
    await fs.writeFile(
      statusPath,
      JSON.stringify({
        schema_version: 1,
        pid: process.pid,
        session_id: sessionId,
        work_dir: '/workspace',
        hostname: os.hostname(),
        started_at: 1,
        qwen_version: null,
        active: true,
      }),
    );

    const lease = await acquire();

    await lease.release();
  });

  it('does not reclaim an old malformed lock with a foreign runtime sidecar', async () => {
    const lockPath = await writeLock('not a lock');
    const old = new Date(Date.now() - 10_000);
    await fs.utimes(lockPath, old, old);
    const statusPath = path.join(
      runtimeBaseDir,
      'projects',
      'project',
      'chats',
      `${sessionId}.runtime.json`,
    );
    await fs.mkdir(path.dirname(statusPath), { recursive: true });
    await fs.writeFile(
      statusPath,
      JSON.stringify({
        schema_version: 1,
        pid: 2_147_483_647,
        session_id: sessionId,
        work_dir: '/workspace',
        hostname: 'another-host.invalid',
        started_at: Date.now() / 1000,
        qwen_version: null,
      }),
    );

    await expect(acquire()).rejects.toBeInstanceOf(SessionWriterConflictError);
  });

  it('fails closed when a matching runtime sidecar cannot be verified', async () => {
    const lockPath = await writeLock('not a lock');
    const old = new Date(Date.now() - 10_000);
    await fs.utimes(lockPath, old, old);
    const statusPath = path.join(
      runtimeBaseDir,
      'projects',
      'project',
      'chats',
      `${sessionId}.runtime.json`,
    );
    await fs.mkdir(statusPath, { recursive: true });

    await expect(acquire()).rejects.toBeInstanceOf(
      SessionWriterUnavailableError,
    );
  });

  it('refuses non-regular lock files', async () => {
    const lockPath = getSessionWriterLockPath(runtimeBaseDir, sessionId);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.symlink(transcriptPath, lockPath);
    await expect(acquire()).rejects.toBeInstanceOf(
      SessionWriterUnavailableError,
    );
  });

  it('removes its lock when transcript inspection fails after acquisition', async () => {
    await fs.mkdir(transcriptPath, { recursive: true });

    await expect(acquire()).rejects.toBeInstanceOf(
      SessionWriterUnavailableError,
    );
    await expect(
      fs.stat(getSessionWriterLockPath(runtimeBaseDir, sessionId)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('only releases its own fencing token', async () => {
    const lease = await acquire();
    const lockPath = getSessionWriterLockPath(runtimeBaseDir, sessionId);
    await fs.writeFile(lockPath, JSON.stringify(lockRecord()));
    await expect(lease.release()).rejects.toBeInstanceOf(
      SessionWriterLostError,
    );
    await expect(fs.stat(lockPath)).resolves.toBeTruthy();
    await expect(lease.release()).resolves.toBeUndefined();
    await expect(fs.stat(lockPath)).resolves.toBeTruthy();
  });

  it('fails closed when its lock disappears before release', async () => {
    const lease = await acquire();
    const lockPath = getSessionWriterLockPath(runtimeBaseDir, sessionId);
    await fs.unlink(lockPath);

    await expect(lease.release()).rejects.toBeInstanceOf(
      SessionWriterLostError,
    );
    await expect(lease.release()).resolves.toBeUndefined();
  });

  it('keeps an unverifiable release retryable', async () => {
    const lease = await acquire();
    const lockPath = getSessionWriterLockPath(runtimeBaseDir, sessionId);
    const ownedLock = await fs.readFile(lockPath, 'utf8');
    await fs.writeFile(lockPath, '{');

    await expect(lease.release()).rejects.toBeInstanceOf(
      SessionWriterUnavailableError,
    );
    await fs.writeFile(lockPath, ownedLock);
    await expect(lease.release()).resolves.toBeUndefined();
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('tracks UTF-8 bytes and detects an external append', async () => {
    const lease = await acquire();
    await lease.appendJsonLine({ text: '调度 Wiki 👋' });
    expect(lease.expectedByteLength).toBe(
      Buffer.byteLength(`${JSON.stringify({ text: '调度 Wiki 👋' })}\n`),
    );

    await fs.appendFile(transcriptPath, '{}\n');
    await expect(lease.appendJsonLine({ text: 'next' })).rejects.toBeInstanceOf(
      SessionTranscriptChangedError,
    );
    await lease.release();
  });

  it('publishes a new transcript atomically without leaving its staging file', async () => {
    const lease = await acquire();
    const lines = [{ text: '调度 Wiki' }, { text: '完整返回值' }];

    await lease.writeNewTranscript(lines);

    await expect(fs.readFile(transcriptPath, 'utf8')).resolves.toBe(
      `${JSON.stringify(lines[0])}\n${JSON.stringify(lines[1])}\n`,
    );
    await expect(
      fs.stat(
        path.join(
          path.dirname(transcriptPath),
          `.${path.basename(transcriptPath)}.${lease.ownerId}.tmp`,
        ),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await lease.release();
  });

  it('preserves one linear Wiki answer across conflict, handoff, and restart', async () => {
    const workspace = path.join(runtimeBaseDir, 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    transcriptPath = path.join(
      new Storage(workspace, runtimeBaseDir).getProjectDir(),
      'chats',
      `${sessionId}.jsonl`,
    );
    const timestamp = new Date().toISOString();
    const records: ChatRecord[] = [
      {
        uuid: 'user-1',
        parentUuid: null,
        sessionId,
        timestamp,
        type: 'user',
        cwd: workspace,
        version: 'test',
        message: { role: 'user', parts: [{ text: '查看调度的 Wiki' }] },
      },
      {
        uuid: 'tool-1',
        parentUuid: 'user-1',
        sessionId,
        timestamp,
        type: 'tool_result',
        cwd: workspace,
        version: 'test',
        message: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'kb_query',
                response: { output: '调度 Wiki 的具体知识库返回值' },
              },
            },
          ],
        },
      },
      {
        uuid: 'assistant-1',
        parentUuid: 'tool-1',
        sessionId,
        timestamp,
        type: 'assistant',
        cwd: workspace,
        version: 'test',
        message: {
          role: 'model',
          parts: [{ text: '调度 Wiki：这是完整的知识库答案。' }],
        },
      },
    ];

    const writerA = await acquire();
    await writerA.appendJsonLine(records[0]);
    await writerA.appendJsonLine(records[1]);

    const conflict = await acquire().catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(SessionWriterConflictError);
    expect(conflict).toMatchObject({ httpStatus: 409 });

    await writerA.appendJsonLine(records[2]);
    await writerA.release();

    const writerB = await acquire();
    const firstHandoff = await writerB.readStableTranscript();
    expect(firstHandoff.toString('utf8')).toContain(
      '调度 Wiki：这是完整的知识库答案。',
    );
    await writerB.release();

    const service = new SessionService(workspace, { runtimeBaseDir });
    const resumedAfterHandoff = await service.loadSession(sessionId);
    expect(resumedAfterHandoff?.conversation.messages).toHaveLength(3);
    expect(resumedAfterHandoff?.lastCompletedUuid).toBe('assistant-1');

    const writerAfterRestart = await acquire();
    await expect(writerAfterRestart.readStableTranscript()).resolves.toEqual(
      firstHandoff,
    );
    await writerAfterRestart.release();

    const resumedAfterRestart = await service.loadSession(sessionId);
    expect(resumedAfterRestart?.conversation.messages.at(-1)?.message).toEqual(
      records[2].message,
    );
    const childrenByParent = new Map<string | null, number>();
    for (const record of resumedAfterRestart?.conversation.messages ?? []) {
      childrenByParent.set(
        record.parentUuid,
        (childrenByParent.get(record.parentUuid) ?? 0) + 1,
      );
    }
    expect([...childrenByParent.values()].every((count) => count === 1)).toBe(
      true,
    );
  });

  it('detects a replaced lock and a deleted transcript', async () => {
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    await fs.writeFile(transcriptPath, '{}\n');
    const lease = await acquire();
    const lockPath = getSessionWriterLockPath(runtimeBaseDir, sessionId);
    await fs.writeFile(lockPath, JSON.stringify(lockRecord()));
    await expect(lease.assertOwnedAndUnchanged()).rejects.toBeInstanceOf(
      SessionWriterLostError,
    );

    const secondSessionId = randomUUID();
    const secondTranscript = path.join(
      path.dirname(transcriptPath),
      `${secondSessionId}.jsonl`,
    );
    await fs.writeFile(secondTranscript, '{}\n');
    const second = await SessionWriterLease.acquire({
      runtimeBaseDir,
      sessionId: secondSessionId,
      transcriptPath: secondTranscript,
    });
    await fs.unlink(secondTranscript);
    await expect(second.assertOwnedAndUnchanged()).rejects.toBeInstanceOf(
      SessionTranscriptChangedError,
    );
    await second.release();
  });

  it('detects deletion of an empty transcript', async () => {
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    await fs.writeFile(transcriptPath, '');
    const lease = await acquire();

    await fs.unlink(transcriptPath);

    await expect(lease.assertOwnedAndUnchanged()).rejects.toBeInstanceOf(
      SessionTranscriptChangedError,
    );
    await lease.release();
  });
});
