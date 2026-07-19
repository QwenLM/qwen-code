/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { fork, type ChildProcess } from 'node:child_process';
import { chmodSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../config/config.js';
import { Storage } from '../config/storage.js';
import {
  resetDebugLoggingState,
  setDebugLogSession,
} from '../utils/debugLogger.js';
import {
  ChatRecordingService,
  type ChatRecord,
} from './chatRecordingService.js';
import { SessionService } from './sessionService.js';
import {
  getSessionWriterLockPath,
  SessionTranscriptChangedError,
  SessionWriterConflictError,
  SessionWriterLease,
  SessionWriterLostError,
  SessionWriterUnavailableError,
  type AcquireSessionWriterLeaseOptions,
} from './session-writer-lease.js';
import type {
  SessionWriterLeaseTestCommandInput,
  SessionWriterLeaseTestResponse,
} from './session-writer-lease.test-helper.js';

const helperPath = fileURLToPath(
  new URL('./session-writer-lease.test-helper.ts', import.meta.url),
);

let nextRequestId = 0;
const children = new Set<ChildProcess>();
const temporaryDirectories = new Set<string>();

async function createFixture(sessionId = 'test-session'): Promise<{
  runtimeBaseDir: string;
  projectRoot: string;
  transcriptPath: string;
  options: AcquireSessionWriterLeaseOptions;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-writer-lease-'));
  temporaryDirectories.add(root);
  const runtimeBaseDir = path.join(root, 'runtime');
  const projectRoot = path.join(root, 'project');
  await fs.mkdir(projectRoot, { recursive: true });
  const storage = new Storage(projectRoot, runtimeBaseDir);
  const transcriptPath = path.join(
    storage.getProjectDir(),
    'chats',
    `${sessionId}.jsonl`,
  );
  return {
    runtimeBaseDir,
    projectRoot,
    transcriptPath,
    options: { runtimeBaseDir, sessionId, transcriptPath },
  };
}

function startLeaseProcess(env?: NodeJS.ProcessEnv): ChildProcess {
  const child = fork(helperPath, [], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  children.add(child);
  child.once('close', () => children.delete(child));
  return child;
}

async function requestChild(
  child: ChildProcess,
  command: SessionWriterLeaseTestCommandInput,
): Promise<SessionWriterLeaseTestResponse> {
  const id = ++nextRequestId;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for lease helper command ${id}`));
    }, 10_000);
    const onMessage = (message: SessionWriterLeaseTestResponse) => {
      if (message.id !== id) return;
      clearTimeout(timeout);
      child.off('message', onMessage);
      resolve(message);
    };
    child.on('message', onMessage);
    child.send({ ...command, id }, (error) => {
      if (!error) return;
      clearTimeout(timeout);
      child.off('message', onMessage);
      reject(error);
    });
  });
}

async function waitForClose(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once('close', () => resolve()));
}

function record(
  uuid: string,
  parentUuid: string | null,
  sessionId: string,
  cwd: string,
  type: 'user' | 'assistant',
  text: string,
): ChatRecord {
  return {
    uuid,
    parentUuid,
    sessionId,
    timestamp: '2026-01-01T00:00:00.000Z',
    type,
    cwd,
    version: 'test',
    message: {
      role: type === 'user' ? 'user' : 'model',
      parts: [{ text }],
    },
  };
}

afterEach(async () => {
  setDebugLogSession(null);
  resetDebugLoggingState();
  Storage.setRuntimeBaseDir(null);
  for (const child of children) child.kill('SIGKILL');
  await Promise.all([...children].map((child) => waitForClose(child)));
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
  children.clear();
  temporaryDirectories.clear();
});

describe('SessionWriterLease', () => {
  it('activates a real ACP Config from the authoritative physical tail', async () => {
    const fixture = await createFixture('config-authoritative-session');
    const firstUser = record(
      'user-1',
      null,
      fixture.options.sessionId,
      fixture.projectRoot,
      'user',
      'start',
    );
    const previewTail = record(
      'tool-tail',
      firstUser.uuid,
      fixture.options.sessionId,
      fixture.projectRoot,
      'assistant',
      'tool result',
    );
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.writeFile(
      fixture.transcriptPath,
      `${JSON.stringify(firstUser)}\n${JSON.stringify(previewTail)}\n`,
      'utf8',
    );
    const sessionService = new SessionService(fixture.projectRoot, {
      runtimeBaseDir: fixture.runtimeBaseDir,
    });
    const stalePreview = await sessionService.loadSession(
      fixture.options.sessionId,
    );
    expect(stalePreview?.lastCompletedUuid).toBe(previewTail.uuid);

    const physicalFinal = record(
      'physical-final',
      previewTail.uuid,
      fixture.options.sessionId,
      fixture.projectRoot,
      'assistant',
      'final answer',
    );
    await fs.writeFile(
      fixture.transcriptPath,
      `${JSON.stringify(firstUser)}\n${JSON.stringify(previewTail)}\n${JSON.stringify(physicalFinal)}\n`,
      'utf8',
    );
    const config = Storage.runWithRuntimeBaseDir(
      fixture.runtimeBaseDir,
      fixture.projectRoot,
      () =>
        new Config({
          sessionId: fixture.options.sessionId,
          sessionData: stalePreview,
          cwd: fixture.projectRoot,
          targetDir: fixture.projectRoot,
          debugMode: false,
          model: 'test-model',
          chatRecording: true,
          experimentalZedIntegration: true,
          bareMode: true,
          telemetry: { enabled: false },
          usageStatisticsEnabled: false,
        }),
    );

    await config.initialize({
      skipGeminiInitialization: true,
      skipHooks: true,
      skipMcpDiscovery: true,
      skipSkillManager: true,
      skipFileCheckpointing: true,
      lenientToolWarmup: true,
    });
    expect(config.getResumedSessionData()?.lastCompletedUuid).toBe(
      physicalFinal.uuid,
    );
    const recorder = config.getChatRecordingService();
    expect(recorder).toBeDefined();
    recorder?.recordUserMessage('next');
    await recorder?.flush();

    const written = (await fs.readFile(fixture.transcriptPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ChatRecord);
    expect(written.at(-1)).toMatchObject({
      type: 'user',
      parentUuid: physicalFinal.uuid,
      message: { parts: [{ text: 'next' }] },
    });

    await config.shutdown({ shutdownTelemetry: false });
    expect(config.hasSessionWriteOwnership()).toBe(false);
    await expect(
      fs.lstat(
        getSessionWriterLockPath(
          fixture.runtimeBaseDir,
          fixture.options.sessionId,
        ),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores and re-anchors a persisted title outside the active UUID chain', async () => {
    const fixture = await createFixture('11111111-1111-4111-8111-111111111111');
    const firstUser = record(
      'user-1',
      null,
      fixture.options.sessionId,
      fixture.projectRoot,
      'user',
      'start',
    );
    const titleRecord: ChatRecord = {
      uuid: 'title-1',
      parentUuid: firstUser.uuid,
      sessionId: fixture.options.sessionId,
      timestamp: '2026-01-01T00:00:01.000Z',
      type: 'system',
      subtype: 'custom_title',
      cwd: fixture.projectRoot,
      version: 'test',
      systemPayload: {
        customTitle: 'operator-title',
        titleSource: 'manual',
      },
    };
    const rewindRecord: ChatRecord = {
      uuid: 'rewind-1',
      parentUuid: firstUser.uuid,
      sessionId: fixture.options.sessionId,
      timestamp: '2026-01-01T00:00:02.000Z',
      type: 'system',
      subtype: 'rewind',
      cwd: fixture.projectRoot,
      version: 'test',
      systemPayload: { truncatedCount: 1 },
    };
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.writeFile(
      fixture.transcriptPath,
      `${JSON.stringify(firstUser)}\n${JSON.stringify(titleRecord)}\n${JSON.stringify(rewindRecord)}\n`,
      'utf8',
    );
    const sessionService = new SessionService(fixture.projectRoot, {
      runtimeBaseDir: fixture.runtimeBaseDir,
    });
    const preview = await sessionService.loadSession(fixture.options.sessionId);
    expect(
      preview?.conversation.messages.some(
        (message) => message.subtype === 'custom_title',
      ),
    ).toBe(false);
    expect(
      sessionService.getSessionTitleInfo(fixture.options.sessionId),
    ).toEqual({ title: 'operator-title', source: 'manual' });

    const config = Storage.runWithRuntimeBaseDir(
      fixture.runtimeBaseDir,
      fixture.projectRoot,
      () =>
        new Config({
          sessionId: fixture.options.sessionId,
          sessionData: preview,
          cwd: fixture.projectRoot,
          targetDir: fixture.projectRoot,
          debugMode: false,
          model: 'test-model',
          chatRecording: true,
          experimentalZedIntegration: true,
          bareMode: true,
          telemetry: { enabled: false },
          usageStatisticsEnabled: false,
        }),
    );

    await config.initialize({
      skipGeminiInitialization: true,
      skipHooks: true,
      skipMcpDiscovery: true,
      skipSkillManager: true,
      skipFileCheckpointing: true,
      lenientToolWarmup: true,
    });
    const recorder = config.getChatRecordingService();
    expect(recorder?.getCurrentCustomTitle()).toBe('operator-title');
    recorder?.recordUserMessage('after rewind');
    await recorder?.flush();

    const physicalRecords = (await fs.readFile(fixture.transcriptPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ChatRecord);
    expect(physicalRecords.at(-1)).toMatchObject({
      type: 'system',
      subtype: 'custom_title',
      systemPayload: {
        customTitle: 'operator-title',
        titleSource: 'manual',
      },
    });

    await config.shutdown({ shutdownTelemetry: false });
  });

  it('preserves transcript-changed during Config activation cleanup', async () => {
    const fixture = await createFixture('config-truncated-session');
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.writeFile(fixture.transcriptPath, '{"truncated":true}', 'utf8');
    const config = Storage.runWithRuntimeBaseDir(
      fixture.runtimeBaseDir,
      fixture.projectRoot,
      () =>
        new Config({
          sessionId: fixture.options.sessionId,
          cwd: fixture.projectRoot,
          targetDir: fixture.projectRoot,
          debugMode: false,
          model: 'test-model',
          chatRecording: true,
          experimentalZedIntegration: true,
          bareMode: true,
          telemetry: { enabled: false },
          usageStatisticsEnabled: false,
        }),
    );

    await expect(config.initialize()).rejects.toBeInstanceOf(
      SessionTranscriptChangedError,
    );
    expect(config.hasSessionWriteOwnership()).toBe(false);
    await expect(
      fs.lstat(
        getSessionWriterLockPath(
          fixture.runtimeBaseDir,
          fixture.options.sessionId,
        ),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.runIf(process.platform !== 'win32')(
    'exposes the owned lease when transcript inspection cleanup must be retried',
    async () => {
      const fixture = await createFixture();
      await fs.mkdir(fixture.transcriptPath, { recursive: true });
      const lockPath = getSessionWriterLockPath(
        fixture.runtimeBaseDir,
        fixture.options.sessionId,
      );
      const lockDir = path.dirname(lockPath);
      let recoveryLease: SessionWriterLease | undefined;

      try {
        await expect(
          SessionWriterLease.acquire({
            ...fixture.options,
            onOwnershipAcquired: (lease) => {
              recoveryLease = lease;
              chmodSync(lockDir, 0o500);
            },
          }),
        ).rejects.toBeInstanceOf(SessionWriterUnavailableError);
        expect(recoveryLease).toBeDefined();
        await expect(fs.readFile(lockPath, 'utf8')).resolves.toContain(
          fixture.options.sessionId,
        );
      } finally {
        chmodSync(lockDir, 0o700);
      }

      await recoveryLease?.release();
      await expect(fs.lstat(lockPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    },
  );

  it.runIf(process.platform === 'linux')(
    'uses a clock-independent Linux process identity',
    async () => {
      const fixture = await createFixture();
      const lease = await SessionWriterLease.acquire(fixture.options);
      const lockPath = getSessionWriterLockPath(
        fixture.runtimeBaseDir,
        fixture.options.sessionId,
      );
      const lockRecord = JSON.parse(await fs.readFile(lockPath, 'utf8')) as {
        process_start_identity?: string;
      };
      const [bootId, stat] = await Promise.all([
        fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
        fs.readFile(`/proc/${process.pid}/stat`, 'utf8'),
      ]);
      const startTicks = stat
        .slice(stat.lastIndexOf(')') + 1)
        .trim()
        .split(/\s+/)[19];

      expect(lockRecord.process_start_identity).toBe(
        `linux:${bootId.trim()}:${startTicks}`,
      );
      await lease.release();
    },
  );

  it.runIf(process.platform === 'darwin')(
    'does not reclaim a live Darwin owner across different time zones',
    async () => {
      const fixture = await createFixture();
      const owner = startLeaseProcess({ TZ: 'Pacific/Honolulu' });
      const contender = startLeaseProcess({ TZ: 'Asia/Shanghai' });
      expect(
        await requestChild(owner, {
          type: 'acquire',
          options: fixture.options,
        }),
      ).toMatchObject({ ok: true });

      expect(
        await requestChild(contender, {
          type: 'acquire',
          options: fixture.options,
        }),
      ).toMatchObject({
        ok: false,
        errorKind: 'session_writer_conflict',
      });
      expect(await requestChild(owner, { type: 'release' })).toMatchObject({
        ok: true,
      });
    },
  );

  it('rejects a second process and reclaims its lock after SIGKILL', async () => {
    const fixture = await createFixture();
    const child = startLeaseProcess();
    expect(
      await requestChild(child, { type: 'acquire', options: fixture.options }),
    ).toMatchObject({ ok: true });

    await expect(
      SessionWriterLease.acquire(fixture.options),
    ).rejects.toBeInstanceOf(SessionWriterConflictError);

    child.kill('SIGKILL');
    await waitForClose(child);
    const replacement = await SessionWriterLease.acquire(fixture.options);
    await replacement.release();
  });

  it('fails closed when process liveness cannot be determined', async () => {
    const fixture = await createFixture();
    const lease = await SessionWriterLease.acquire(fixture.options);
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    const lockRecord = await fs.readFile(lockPath, 'utf8');
    await lease.release();
    await fs.writeFile(lockPath, lockRecord);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('probe unavailable'), { code: 'EIO' });
    });

    try {
      await expect(
        SessionWriterLease.acquire(fixture.options),
      ).rejects.toBeInstanceOf(SessionWriterConflictError);
    } finally {
      killSpy.mockRestore();
      await fs.unlink(lockPath).catch(() => {});
    }
  });

  it('detects external transcript and lock changes', async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.writeFile(fixture.transcriptPath, '{"seed":true}\n');
    const lease = await SessionWriterLease.acquire(fixture.options);

    await fs.appendFile(fixture.transcriptPath, '{"external":true}\n');
    await expect(lease.assertOwnedAndUnchanged()).rejects.toBeInstanceOf(
      SessionTranscriptChangedError,
    );

    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    await fs.unlink(lockPath);
    await fs.writeFile(lockPath, '{"replacement":true}');
    await expect(lease.assertOwnedAndUnchanged()).rejects.toBeInstanceOf(
      SessionWriterLostError,
    );
    await expect(lease.release()).rejects.toBeInstanceOf(
      SessionWriterLostError,
    );
    await expect(fs.readFile(lockPath, 'utf8')).resolves.toBe(
      '{"replacement":true}',
    );
  });

  it.runIf(process.platform !== 'win32')(
    'classifies an unreadable owned lock as unavailable',
    async () => {
      const fixture = await createFixture();
      const lease = await SessionWriterLease.acquire(fixture.options);
      const lockPath = getSessionWriterLockPath(
        fixture.runtimeBaseDir,
        fixture.options.sessionId,
      );
      await fs.chmod(lockPath, 0o000);

      try {
        await expect(lease.assertOwnedAndUnchanged()).rejects.toBeInstanceOf(
          SessionWriterUnavailableError,
        );
      } finally {
        await fs.chmod(lockPath, 0o600);
        await lease.release();
      }
    },
  );

  it('fails closed on a malformed lock', async () => {
    const fixture = await createFixture();
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, 'not-json');

    await expect(
      SessionWriterLease.acquire(fixture.options),
    ).rejects.toBeInstanceOf(SessionWriterUnavailableError);
  });

  it('logs acquisition diagnostics without changing the public error', async () => {
    const fixture = await createFixture('diagnostic-session');
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, 'not-json');
    const previousDebugLogFile = process.env['QWEN_DEBUG_LOG_FILE'];
    process.env['QWEN_DEBUG_LOG_FILE'] = '1';
    Storage.setRuntimeBaseDir(fixture.runtimeBaseDir);
    resetDebugLoggingState();
    setDebugLogSession({
      getSessionId: () => fixture.options.sessionId,
    });

    try {
      let failure: unknown;
      try {
        await SessionWriterLease.acquire(fixture.options);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        errorKind: 'session_writer_unavailable',
        message: 'Session write ownership could not be verified.',
      });

      await vi.waitFor(async () => {
        const log = await fs.readFile(
          Storage.getDebugLogPath(fixture.options.sessionId),
          'utf8',
        );
        expect(log).toContain(
          'stage=acquire errorKind=session_writer_unavailable',
        );
        expect(log).toContain(`lockPath=${JSON.stringify(lockPath)}`);
        expect(log).toContain(
          'cause=Error: Existing session writer lock is malformed',
        );
      });
    } finally {
      setDebugLogSession(null);
      resetDebugLoggingState();
      Storage.setRuntimeBaseDir(null);
      if (previousDebugLogFile === undefined) {
        delete process.env['QWEN_DEBUG_LOG_FILE'];
      } else {
        process.env['QWEN_DEBUG_LOG_FILE'] = previousDebugLogFile;
      }
    }
  });

  it('fails closed on a non-regular lock', async () => {
    const fixture = await createFixture();
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    await fs.mkdir(lockPath, { recursive: true });

    await expect(
      SessionWriterLease.acquire(fixture.options),
    ).rejects.toBeInstanceOf(SessionWriterUnavailableError);
  });

  it('fails closed on a truncated transcript tail', async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.writeFile(
      fixture.transcriptPath,
      '{"complete":true}\n{"partial":',
    );

    await expect(
      SessionWriterLease.acquire(fixture.options),
    ).rejects.toBeInstanceOf(SessionTranscriptChangedError);
    await expect(
      fs.access(
        getSessionWriterLockPath(
          fixture.runtimeBaseDir,
          fixture.options.sessionId,
        ),
      ),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('detects an equal-length atomic transcript replacement', async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.writeFile(fixture.transcriptPath, '{"a":1}\n');
    const lease = await SessionWriterLease.acquire(fixture.options);
    const replacement = `${fixture.transcriptPath}.replacement`;
    await fs.writeFile(replacement, '{"b":2}\n');
    await fs.rename(replacement, fixture.transcriptPath);

    await expect(lease.assertOwnedAndUnchanged()).rejects.toBeInstanceOf(
      SessionTranscriptChangedError,
    );
    await lease.release();
  });

  it('accounts for UTF-8 bytes and releases concurrently without losing ownership', async () => {
    const fixture = await createFixture();
    const lease = await SessionWriterLease.acquire(fixture.options);
    const value = { text: '调度🙂' };
    const expectedBytes = Buffer.byteLength(`${JSON.stringify(value)}\n`);

    await lease.appendJsonLine(value);
    expect((await fs.readFile(fixture.transcriptPath)).byteLength).toBe(
      expectedBytes,
    );
    await expect(
      Promise.all([lease.release(), lease.release()]),
    ).resolves.toEqual([undefined, undefined]);
  });

  it.runIf(process.platform !== 'freebsd')(
    'retries release after a transient filesystem failure',
    async () => {
      const fixture = await createFixture();
      const lease = await SessionWriterLease.acquire(fixture.options);
      const lockPath = getSessionWriterLockPath(
        fixture.runtimeBaseDir,
        fixture.options.sessionId,
      );
      const backupPath = `${lockPath}.backup`;
      await fs.rename(lockPath, backupPath);
      await fs.mkdir(lockPath);

      await expect(lease.release()).rejects.toBeInstanceOf(
        SessionWriterUnavailableError,
      );

      await fs.rmdir(lockPath);
      await fs.rename(backupPath, lockPath);
      await expect(lease.release()).resolves.toBeUndefined();
    },
  );

  it('elects only one stale-lock reclaimer across processes', async () => {
    const fixture = await createFixture();
    const owner = startLeaseProcess();
    expect(
      await requestChild(owner, { type: 'acquire', options: fixture.options }),
    ).toMatchObject({ ok: true });
    owner.kill('SIGKILL');
    await waitForClose(owner);

    const contenders = [startLeaseProcess(), startLeaseProcess()];
    const results = await Promise.all(
      contenders.map((child) =>
        requestChild(child, { type: 'acquire', options: fixture.options }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const winner = contenders[results.findIndex((result) => result.ok)]!;
    expect(await requestChild(winner, { type: 'release' })).toMatchObject({
      ok: true,
    });
  });

  it('recovers after a stale-lock reclaimer dies while holding its guard', async () => {
    const fixture = await createFixture();
    const owner = startLeaseProcess();
    const acquired = await requestChild(owner, {
      type: 'acquire',
      options: fixture.options,
    });
    expect(acquired).toMatchObject({ ok: true });
    expect(acquired.ownerId).toBeDefined();
    owner.kill('SIGKILL');
    await waitForClose(owner);

    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    const reclaimPath = `${lockPath}.reclaim.${encodeURIComponent(
      acquired.ownerId!,
    )}`;
    await fs.copyFile(lockPath, reclaimPath);

    const replacement = await SessionWriterLease.acquire(fixture.options);
    await replacement.release();
  });

  it('reloads the authoritative tail before the next writer appends', async () => {
    const sessionId = 'incident-session';
    const fixture = await createFixture(sessionId);
    const firstUser = record(
      'user-1',
      null,
      sessionId,
      fixture.projectRoot,
      'user',
      '看下调度的 wiki',
    );
    const firstToolTail = record(
      'tool-tail',
      firstUser.uuid,
      sessionId,
      fixture.projectRoot,
      'assistant',
      'first tool result',
    );
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.writeFile(
      fixture.transcriptPath,
      `${JSON.stringify(firstUser)}\n${JSON.stringify(firstToolTail)}\n`,
    );

    const processA = startLeaseProcess();
    expect(
      await requestChild(processA, {
        type: 'acquire',
        options: fixture.options,
      }),
    ).toMatchObject({ ok: true });
    await expect(
      SessionWriterLease.acquire(fixture.options),
    ).rejects.toBeInstanceOf(SessionWriterConflictError);

    const finalAnswer = record(
      'final-answer',
      firstToolTail.uuid,
      sessionId,
      fixture.projectRoot,
      'assistant',
      '完整调度 Wiki 回答',
    );
    expect(
      await requestChild(processA, { type: 'append', value: finalAnswer }),
    ).toMatchObject({ ok: true });
    expect(await requestChild(processA, { type: 'release' })).toMatchObject({
      ok: true,
    });

    const processBLease = await SessionWriterLease.acquire(fixture.options);
    const sessionService = new SessionService(fixture.projectRoot, {
      runtimeBaseDir: fixture.runtimeBaseDir,
    });
    const authoritative = await sessionService.loadSession(sessionId);
    expect(authoritative?.lastCompletedUuid).toBe(finalAnswer.uuid);
    expect(
      authoritative?.conversation.messages.map((message) => message.uuid),
    ).toEqual([firstUser.uuid, firstToolTail.uuid, finalAnswer.uuid]);

    const config = {
      getSessionId: () => sessionId,
      getResumedSessionData: () => authoritative,
      getProjectRoot: () => fixture.projectRoot,
      getCliVersion: () => 'test',
      getFastModel: () => undefined,
      isInteractive: () => false,
    } as unknown as Config;
    const recorder = new ChatRecordingService(config);
    recorder.activate(processBLease, authoritative);
    recorder.recordUserMessage([{ text: '你好' }]);
    await recorder.flush();
    await recorder.close();

    const physicalRecords = (await fs.readFile(fixture.transcriptPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ChatRecord);
    expect(physicalRecords.at(-1)?.parentUuid).toBe(finalAnswer.uuid);
    const reloaded = await sessionService.loadSession(sessionId);
    expect(
      reloaded?.conversation.messages.map((message) => message.uuid),
    ).toEqual(physicalRecords.map((message) => message.uuid));
  });
});
