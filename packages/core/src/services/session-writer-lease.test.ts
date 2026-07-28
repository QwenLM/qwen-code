/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import {
  appendFileSync,
  constants as fsConstants,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import type { Mode, PathLike } from 'node:fs';
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

const lstatFault = vi.hoisted(() => ({
  path: undefined as string | undefined,
  remainingFailures: 0,
  calls: 0,
}));

const fsOpenTestHook = vi.hoisted(() => ({
  beforeOpen: undefined as
    | ((filePath: PathLike, flags: string | number) => void | Promise<void>)
    | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (filePath: Parameters<typeof actual.lstat>[0]) => {
      if (filePath === lstatFault.path) {
        lstatFault.calls++;
        if (lstatFault.remainingFailures > 0) {
          lstatFault.remainingFailures--;
          throw Object.assign(new Error('temporary I/O failure'), {
            code: 'EIO',
          });
        }
      }
      return actual.lstat(filePath);
    },
    open: async (filePath: PathLike, flags: string | number, mode?: Mode) => {
      await fsOpenTestHook.beforeOpen?.(filePath, flags);
      return actual.open(filePath, flags, mode);
    },
  };
});

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

function positionalReadLength(args: unknown): number | undefined {
  const values = args as readonly unknown[];
  return typeof values[2] === 'number' ? values[2] : undefined;
}

afterEach(async () => {
  lstatFault.path = undefined;
  lstatFault.remainingFailures = 0;
  lstatFault.calls = 0;
  fsOpenTestHook.beforeOpen = undefined;
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
          sessionWriterLeaseEnabled: true,
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
          sessionWriterLeaseEnabled: true,
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
          sessionWriterLeaseEnabled: true,
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

  it('keeps failed acquisition cleanup terminal without retrying the primary lock', async () => {
    const fixture = await createFixture();
    await fs.mkdir(fixture.transcriptPath, { recursive: true });
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    let recoveryLease: SessionWriterLease | undefined;
    let retiredPath: string | undefined;

    const failure = await SessionWriterLease.acquire({
      ...fixture.options,
      onOwnershipAcquired: (lease) => {
        recoveryLease = lease;
        retiredPath = `${lockPath}.released.${encodeURIComponent(lease.ownerId)}`;
        mkdirSync(retiredPath);
      },
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: 'SessionWriterUnavailableError',
      cause: expect.any(AggregateError),
    });
    expect(
      (failure as Error & { cause: AggregateError }).cause.errors,
    ).toHaveLength(2);
    const releaseFailure = (failure as Error & { cause: AggregateError }).cause
      .errors[1];
    expect(recoveryLease).toBeDefined();
    await expect(fs.readFile(lockPath, 'utf8')).resolves.toContain(
      fixture.options.sessionId,
    );

    const firstRetry = recoveryLease!.release();
    const secondRetry = recoveryLease!.release();
    expect(secondRetry).toBe(firstRetry);
    await expect(firstRetry).rejects.toBe(releaseFailure);
    await fs.rmdir(retiredPath!);
    await fs.unlink(lockPath);
  });

  it('does not retry failed cleanup after reclaiming a stale lock', async () => {
    const fixture = await createFixture();
    const deadOwner = startLeaseProcess();
    expect(
      await requestChild(deadOwner, {
        type: 'acquire',
        options: fixture.options,
      }),
    ).toMatchObject({ ok: true });
    deadOwner.kill('SIGKILL');
    await waitForClose(deadOwner);
    await fs.mkdir(fixture.transcriptPath, { recursive: true });
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    let recoveryLease: SessionWriterLease | undefined;
    let retiredPath: string | undefined;

    const failure = await SessionWriterLease.acquire({
      ...fixture.options,
      onOwnershipAcquired: (lease) => {
        recoveryLease = lease;
        retiredPath = `${lockPath}.released.${encodeURIComponent(lease.ownerId)}`;
        mkdirSync(retiredPath);
      },
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: 'SessionWriterUnavailableError',
      cause: expect.any(AggregateError),
    });
    const releaseFailure = (failure as Error & { cause: AggregateError }).cause
      .errors[1];
    expect(recoveryLease).toBeDefined();
    await expect(fs.readFile(lockPath, 'utf8')).resolves.toContain(
      fixture.options.sessionId,
    );

    await expect(recoveryLease!.release()).rejects.toBe(releaseFailure);
    await fs.rmdir(retiredPath!);
    await fs.unlink(lockPath);
  });

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

  it.runIf(process.platform !== 'win32')(
    'reconciles timestamp-only metadata changes before appending',
    async () => {
      const fixture = await createFixture();
      await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
      await fs.writeFile(fixture.transcriptPath, '{"seed":true}\n');
      const lease = await SessionWriterLease.acquire(fixture.options);
      const initial = await fs.stat(fixture.transcriptPath);

      await fs.chmod(fixture.transcriptPath, initial.mode);
      const afterChmod = await fs.stat(fixture.transcriptPath);
      expect(afterChmod.ctimeMs).not.toBe(initial.ctimeMs);
      await expect(lease.assertOwnedAndUnchanged()).resolves.toBeUndefined();

      await fs.utimes(
        fixture.transcriptPath,
        afterChmod.atime,
        afterChmod.mtime,
      );
      await expect(lease.assertOwnedAndUnchanged()).resolves.toBeUndefined();
      await expect(
        lease.appendJsonLine({ afterMetadataChange: true }),
      ).resolves.toBeUndefined();
      await expect(fs.readFile(fixture.transcriptPath, 'utf8')).resolves.toBe(
        '{"seed":true}\n{"afterMetadataChange":true}\n',
      );
      await lease.release();
    },
  );

  it.runIf(process.platform === 'linux')(
    'reconciles a same-owner chown',
    async () => {
      const fixture = await createFixture();
      await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
      await fs.writeFile(fixture.transcriptPath, '{"seed":true}\n');
      const lease = await SessionWriterLease.acquire(fixture.options);
      const initial = await fs.stat(fixture.transcriptPath);

      await fs.chown(fixture.transcriptPath, initial.uid, initial.gid);
      const afterChown = await fs.stat(fixture.transcriptPath);
      expect(afterChown.ctimeMs).not.toBe(initial.ctimeMs);
      await expect(lease.assertOwnedAndUnchanged()).resolves.toBeUndefined();
      await lease.release();
    },
  );

  it('detects an equal-length in-place overwrite with restored mtime', async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    const anchoredTime = new Date('2024-01-02T03:04:05.000Z');
    await fs.writeFile(fixture.transcriptPath, '{"seed":true}\n');
    await fs.utimes(fixture.transcriptPath, anchoredTime, anchoredTime);
    const lease = await SessionWriterLease.acquire(fixture.options);

    await fs.writeFile(fixture.transcriptPath, '{"sEEd":true}\n');
    await fs.utimes(fixture.transcriptPath, anchoredTime, anchoredTime);
    await expect(lease.assertOwnedAndUnchanged()).rejects.toBeInstanceOf(
      SessionTranscriptChangedError,
    );
    await lease.release();
  });

  it.runIf(process.platform !== 'win32')(
    'rejects actual permission and hard-link changes',
    async () => {
      const fixture = await createFixture();
      await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
      await fs.writeFile(fixture.transcriptPath, '{"seed":true}\n');
      const permissionLease = await SessionWriterLease.acquire(fixture.options);
      const initial = await fs.stat(fixture.transcriptPath);

      await fs.chmod(fixture.transcriptPath, initial.mode ^ 0o040);
      await expect(
        permissionLease.assertOwnedAndUnchanged(),
      ).rejects.toBeInstanceOf(SessionTranscriptChangedError);
      await fs.chmod(fixture.transcriptPath, initial.mode);
      await permissionLease.release();

      const linkLease = await SessionWriterLease.acquire(fixture.options);
      const linkPath = `${fixture.transcriptPath}.link`;
      await fs.link(fixture.transcriptPath, linkPath);
      await expect(linkLease.assertOwnedAndUnchanged()).rejects.toBeInstanceOf(
        SessionTranscriptChangedError,
      );
      await fs.unlink(linkPath);
      await linkLease.release();
    },
  );

  it.runIf(process.getuid?.() === 0)(
    'rejects an actual owner change',
    async () => {
      const fixture = await createFixture();
      await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
      await fs.writeFile(fixture.transcriptPath, '{"seed":true}\n');
      const lease = await SessionWriterLease.acquire(fixture.options);
      const initial = await fs.stat(fixture.transcriptPath);
      const changedUid = initial.uid === 0 ? 1 : 0;

      try {
        await fs.chown(fixture.transcriptPath, changedUid, initial.gid);
        await expect(lease.assertOwnedAndUnchanged()).rejects.toBeInstanceOf(
          SessionTranscriptChangedError,
        );
      } finally {
        await fs.chown(fixture.transcriptPath, initial.uid, initial.gid);
        await lease.release();
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'classifies an unreadable transcript symlink replacement as changed',
    async () => {
      const fixture = await createFixture();
      await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
      await fs.writeFile(fixture.transcriptPath, '{"seed":true}\n');
      const lease = await SessionWriterLease.acquire(fixture.options);
      const originalPath = `${fixture.transcriptPath}.original`;
      const initialMode = (await fs.stat(fixture.transcriptPath)).mode;
      await fs.rename(fixture.transcriptPath, originalPath);
      await fs.chmod(originalPath, 0);
      await fs.symlink(originalPath, fixture.transcriptPath);

      try {
        await expect(lease.assertOwnedAndUnchanged()).rejects.toBeInstanceOf(
          SessionTranscriptChangedError,
        );
      } finally {
        await fs.unlink(fixture.transcriptPath);
        await fs.chmod(originalPath, initialMode);
        await fs.rename(originalPath, fixture.transcriptPath);
        await lease.release();
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'does not follow a symlink installed between transcript inspection and open',
    async () => {
      const fixture = await createFixture();
      await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
      await fs.writeFile(fixture.transcriptPath, '{"seed":true}\n');
      const lease = await SessionWriterLease.acquire(fixture.options);
      const originalPath = `${fixture.transcriptPath}.original`;
      let replaced = false;
      let transcriptOpenFlags: number | undefined;
      fsOpenTestHook.beforeOpen = async (filePath, flags) => {
        if (!replaced && filePath === fixture.transcriptPath) {
          replaced = true;
          transcriptOpenFlags = typeof flags === 'number' ? flags : undefined;
          await fs.rename(fixture.transcriptPath, originalPath);
          await fs.symlink(originalPath, fixture.transcriptPath);
        }
      };

      try {
        await expect(lease.assertOwnedAndUnchanged()).rejects.toBeInstanceOf(
          SessionTranscriptChangedError,
        );
        expect(replaced).toBe(true);
        expect(transcriptOpenFlags! & fsConstants.O_NOFOLLOW).not.toBe(0);
        expect(transcriptOpenFlags! & fsConstants.O_NONBLOCK).not.toBe(0);
      } finally {
        fsOpenTestHook.beforeOpen = undefined;
        await fs.unlink(fixture.transcriptPath);
        await fs.rename(originalPath, fixture.transcriptPath);
        await lease.release();
      }
    },
  );

  it.runIf(process.platform !== 'win32')(
    'classifies a transcript FIFO replacement as changed without a peer',
    async () => {
      const fixture = await createFixture();
      await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
      await fs.writeFile(fixture.transcriptPath, '{"seed":true}\n');
      const lease = await SessionWriterLease.acquire(fixture.options);
      const originalPath = `${fixture.transcriptPath}.original`;
      await fs.rename(fixture.transcriptPath, originalPath);
      execFileSync('mkfifo', [fixture.transcriptPath]);

      try {
        await expect(lease.assertOwnedAndUnchanged()).rejects.toBeInstanceOf(
          SessionTranscriptChangedError,
        );
      } finally {
        await fs.unlink(fixture.transcriptPath);
        await fs.rename(originalPath, fixture.transcriptPath);
        await lease.release();
      }
    },
  );

  it('classifies transcript deletion as changed', async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.writeFile(fixture.transcriptPath, '{"seed":true}\n');
    const lease = await SessionWriterLease.acquire(fixture.options);
    await fs.unlink(fixture.transcriptPath);

    await expect(lease.assertOwnedAndUnchanged()).rejects.toBeInstanceOf(
      SessionTranscriptChangedError,
    );
    await lease.release();
  });

  it('detects a size change between handle and path stat', async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.writeFile(fixture.transcriptPath, '{"seed":true}\n');
    const lease = await SessionWriterLease.acquire(fixture.options);
    const initial = await fs.stat(fixture.transcriptPath);
    const probe = await fs.open(fixture.transcriptPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      stat: typeof probe.stat;
    };
    await probe.close();
    const originalStat = fileHandlePrototype.stat;
    let injected = false;
    const stat = vi
      .spyOn(fileHandlePrototype, 'stat')
      .mockImplementation(async function (this: fs.FileHandle, ...args) {
        if (!injected) {
          injected = true;
          appendFileSync(fixture.transcriptPath, '{"external":true}\n');
          return initial;
        }
        return originalStat.apply(this, args);
      });

    try {
      await expect(lease.assertOwnedAndUnchanged()).rejects.toBeInstanceOf(
        SessionTranscriptChangedError,
      );
      expect(injected).toBe(true);
    } finally {
      stat.mockRestore();
      await lease.release();
    }
  });

  it('detects an equal-length overwrite between handle and path stat', async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.writeFile(fixture.transcriptPath, '{"seed":true}\n');
    const lease = await SessionWriterLease.acquire(fixture.options);
    const initial = await fs.stat(fixture.transcriptPath);
    const probe = await fs.open(fixture.transcriptPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      stat: typeof probe.stat;
    };
    await probe.close();
    const originalStat = fileHandlePrototype.stat;
    let injected = false;
    const stat = vi
      .spyOn(fileHandlePrototype, 'stat')
      .mockImplementation(async function (this: fs.FileHandle, ...args) {
        if (!injected) {
          injected = true;
          writeFileSync(fixture.transcriptPath, '{"sEEd":true}\n');
          utimesSync(
            fixture.transcriptPath,
            initial.atime,
            new Date(initial.mtimeMs + 10_000),
          );
          return initial;
        }
        return originalStat.apply(this, args);
      });

    try {
      await expect(lease.assertOwnedAndUnchanged()).rejects.toBeInstanceOf(
        SessionTranscriptChangedError,
      );
      expect(injected).toBe(true);
    } finally {
      stat.mockRestore();
      await lease.release();
    }
  });

  it('does not rescan the transcript on ordinary appends', async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.writeFile(fixture.transcriptPath, '{"seed":true}\n');
    const probe = await fs.open(fixture.transcriptPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      read: typeof probe.read;
    };
    await probe.close();
    const read = vi.spyOn(fileHandlePrototype, 'read');

    try {
      const lease = await SessionWriterLease.acquire(fixture.options);
      const baselineReads = read.mock.calls.filter(
        (call) => (positionalReadLength(call) ?? 0) > 1,
      ).length;
      expect(baselineReads).toBeGreaterThan(0);

      await lease.appendJsonLine({ first: true });
      await lease.appendJsonLine({ second: true });
      expect(
        read.mock.calls.filter((call) => (positionalReadLength(call) ?? 0) > 1),
      ).toHaveLength(baselineReads);
      await lease.release();
    } finally {
      read.mockRestore();
    }
  });

  it('continues hashing after a short regular-file read', async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    const transcript = Buffer.alloc(2 * 1024 * 1024, 0x20);
    transcript[transcript.byteLength - 1] = 0x0a;
    await fs.writeFile(fixture.transcriptPath, transcript);
    const lease = await SessionWriterLease.acquire(fixture.options);
    const initial = await fs.stat(fixture.transcriptPath);
    await fs.chmod(fixture.transcriptPath, initial.mode);
    const probe = await fs.open(fixture.transcriptPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      read: typeof probe.read;
    };
    await probe.close();
    const originalRead = fileHandlePrototype.read;
    let shortened = false;
    let hashReads = 0;
    const read = vi
      .spyOn(fileHandlePrototype, 'read')
      .mockImplementation(async function (this: fs.FileHandle, ...args) {
        const requestedLength = positionalReadLength(args);
        if ((requestedLength ?? 0) > 1) hashReads++;
        if (!shortened && requestedLength === 1024 * 1024) {
          shortened = true;
          const [buffer, offset, length, position] = args as unknown as [
            Buffer,
            number,
            number,
            number,
          ];
          return (
            originalRead as unknown as (
              buffer: Buffer,
              offset: number,
              length: number,
              position: number,
            ) => Promise<{ bytesRead: number; buffer: Buffer }>
          ).call(this, buffer, offset, Math.floor(length / 2), position);
        }
        return originalRead.apply(this, args);
      });

    try {
      await expect(lease.assertOwnedAndUnchanged()).resolves.toBeUndefined();
      expect(shortened).toBe(true);
      expect(hashReads).toBe(3);
    } finally {
      read.mockRestore();
      await lease.release();
    }
  });

  it('retries a timestamp change during content verification', async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.writeFile(fixture.transcriptPath, '{"seed":true}\n');
    const lease = await SessionWriterLease.acquire(fixture.options);
    const initial = await fs.stat(fixture.transcriptPath);
    await fs.chmod(fixture.transcriptPath, initial.mode);
    const probe = await fs.open(fixture.transcriptPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      read: typeof probe.read;
    };
    await probe.close();
    const originalRead = fileHandlePrototype.read;
    let fullReads = 0;
    const read = vi
      .spyOn(fileHandlePrototype, 'read')
      .mockImplementation(async function (this: fs.FileHandle, ...args) {
        const result = await originalRead.apply(this, args);
        if ((positionalReadLength(args) ?? 0) > 1 && ++fullReads === 1) {
          await fs.utimes(
            fixture.transcriptPath,
            initial.atime,
            new Date(initial.mtimeMs + 1_000),
          );
        }
        return result;
      });

    try {
      await expect(lease.assertOwnedAndUnchanged()).resolves.toBeUndefined();
      expect(fullReads).toBe(2);
    } finally {
      read.mockRestore();
      await lease.release();
    }
  });

  it('fails bounded when transcript timestamps never stabilize', async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.writeFile(fixture.transcriptPath, '{"seed":true}\n');
    const lease = await SessionWriterLease.acquire(fixture.options);
    const initial = await fs.stat(fixture.transcriptPath);
    await fs.chmod(fixture.transcriptPath, initial.mode);
    const probe = await fs.open(fixture.transcriptPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      read: typeof probe.read;
    };
    await probe.close();
    const originalRead = fileHandlePrototype.read;
    let fullReads = 0;
    const read = vi
      .spyOn(fileHandlePrototype, 'read')
      .mockImplementation(async function (this: fs.FileHandle, ...args) {
        const result = await originalRead.apply(this, args);
        if ((positionalReadLength(args) ?? 0) > 1) {
          fullReads++;
          await fs.utimes(
            fixture.transcriptPath,
            initial.atime,
            new Date(initial.mtimeMs + fullReads * 1_000),
          );
        }
        return result;
      });

    try {
      await expect(lease.assertOwnedAndUnchanged()).rejects.toBeInstanceOf(
        SessionWriterUnavailableError,
      );
      expect(fullReads).toBe(3);
    } finally {
      read.mockRestore();
      await lease.release();
    }
  });

  it('detects an atomic replacement during content verification', async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.writeFile(fixture.transcriptPath, '{"seed":true}\n');
    const lease = await SessionWriterLease.acquire(fixture.options);
    const initial = await fs.stat(fixture.transcriptPath);
    await fs.chmod(fixture.transcriptPath, initial.mode);
    const replacement = `${fixture.transcriptPath}.replacement`;
    await fs.writeFile(replacement, '{"sEEd":true}\n');
    const probe = await fs.open(fixture.transcriptPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      read: typeof probe.read;
    };
    await probe.close();
    const originalRead = fileHandlePrototype.read;
    let replaced = false;
    const read = vi
      .spyOn(fileHandlePrototype, 'read')
      .mockImplementation(async function (this: fs.FileHandle, ...args) {
        const result = await originalRead.apply(this, args);
        if ((positionalReadLength(args) ?? 0) > 1 && !replaced) {
          replaced = true;
          await fs.rename(replacement, fixture.transcriptPath);
        }
        return result;
      });

    try {
      await expect(lease.assertOwnedAndUnchanged()).rejects.toBeInstanceOf(
        SessionTranscriptChangedError,
      );
      expect(replaced).toBe(true);
    } finally {
      read.mockRestore();
      await lease.release();
    }
  });

  it('detects truncation during content verification', async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.writeFile(fixture.transcriptPath, '{"seed":true}\n');
    const lease = await SessionWriterLease.acquire(fixture.options);
    const initial = await fs.stat(fixture.transcriptPath);
    await fs.chmod(fixture.transcriptPath, initial.mode);
    const probe = await fs.open(fixture.transcriptPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      read: typeof probe.read;
    };
    await probe.close();
    const originalRead = fileHandlePrototype.read;
    let truncated = false;
    const read = vi
      .spyOn(fileHandlePrototype, 'read')
      .mockImplementation(async function (this: fs.FileHandle, ...args) {
        const result = await originalRead.apply(this, args);
        if ((positionalReadLength(args) ?? 0) > 1 && !truncated) {
          truncated = true;
          await fs.truncate(fixture.transcriptPath, 0);
        }
        return result;
      });

    try {
      await expect(lease.assertOwnedAndUnchanged()).rejects.toBeInstanceOf(
        SessionTranscriptChangedError,
      );
      expect(truncated).toBe(true);
    } finally {
      read.mockRestore();
      await lease.release();
    }
  });

  it('detects deletion during content verification', async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.writeFile(fixture.transcriptPath, '{"seed":true}\n');
    const lease = await SessionWriterLease.acquire(fixture.options);
    const initial = await fs.stat(fixture.transcriptPath);
    await fs.chmod(fixture.transcriptPath, initial.mode);
    const probe = await fs.open(fixture.transcriptPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      read: typeof probe.read;
    };
    await probe.close();
    const originalRead = fileHandlePrototype.read;
    let deleted = false;
    const read = vi
      .spyOn(fileHandlePrototype, 'read')
      .mockImplementation(async function (this: fs.FileHandle, ...args) {
        const result = await originalRead.apply(this, args);
        if ((positionalReadLength(args) ?? 0) > 1 && !deleted) {
          deleted = true;
          await fs.unlink(fixture.transcriptPath);
        }
        return result;
      });

    try {
      await expect(lease.assertOwnedAndUnchanged()).rejects.toBeInstanceOf(
        SessionTranscriptChangedError,
      );
      expect(deleted).toBe(true);
    } finally {
      read.mockRestore();
      await lease.release();
    }
  });

  it('detects owner loss during content verification', async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.writeFile(fixture.transcriptPath, '{"seed":true}\n');
    const lease = await SessionWriterLease.acquire(fixture.options);
    const initial = await fs.stat(fixture.transcriptPath);
    await fs.chmod(fixture.transcriptPath, initial.mode);
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    const probe = await fs.open(fixture.transcriptPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      read: typeof probe.read;
    };
    await probe.close();
    const originalRead = fileHandlePrototype.read;
    let replacedOwner = false;
    const read = vi
      .spyOn(fileHandlePrototype, 'read')
      .mockImplementation(async function (this: fs.FileHandle, ...args) {
        const result = await originalRead.apply(this, args);
        if ((positionalReadLength(args) ?? 0) > 1 && !replacedOwner) {
          replacedOwner = true;
          await fs.writeFile(lockPath, '{"successor":true}\n');
        }
        return result;
      });

    try {
      await expect(lease.assertOwnedAndUnchanged()).rejects.toBeInstanceOf(
        SessionWriterLostError,
      );
      expect(replacedOwner).toBe(true);
    } finally {
      read.mockRestore();
      await fs.unlink(lockPath);
    }
  });

  it.runIf(process.platform !== 'win32')(
    'reconciles metadata touched between the barrier and append handle stat',
    async () => {
      const fixture = await createFixture();
      await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
      await fs.writeFile(fixture.transcriptPath, '{"seed":true}\n');
      const lease = await SessionWriterLease.acquire(fixture.options);
      const initial = await fs.stat(fixture.transcriptPath);
      const probe = await fs.open(fixture.transcriptPath, 'r');
      const fileHandlePrototype = Object.getPrototypeOf(probe) as {
        stat: typeof probe.stat;
      };
      await probe.close();
      const originalStat = fileHandlePrototype.stat;
      let statCalls = 0;
      const stat = vi
        .spyOn(fileHandlePrototype, 'stat')
        .mockImplementation(async function (this: fs.FileHandle, ...args) {
          statCalls++;
          if (statCalls === 2) {
            await fs.chmod(fixture.transcriptPath, initial.mode);
          }
          return originalStat.apply(this, args);
        });

      try {
        await expect(
          lease.appendJsonLine({ afterMetadataRace: true }),
        ).resolves.toBeUndefined();
        expect((await fs.stat(fixture.transcriptPath)).ctimeMs).not.toBe(
          initial.ctimeMs,
        );
      } finally {
        stat.mockRestore();
        await lease.release();
      }
    },
  );

  it('does not commit a candidate digest after post-write validation fails', async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    const seed = '{"seed":true}\n';
    await fs.writeFile(fixture.transcriptPath, seed);
    const lease = await SessionWriterLease.acquire(fixture.options);
    const probe = await fs.open(fixture.transcriptPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      stat: typeof probe.stat;
    };
    await probe.close();
    const originalStat = fileHandlePrototype.stat;
    let invalidated = false;
    const stat = vi
      .spyOn(fileHandlePrototype, 'stat')
      .mockImplementation(async function (this: fs.FileHandle, ...args) {
        const result = await originalStat.apply(this, args);
        if (
          !invalidated &&
          typeof result.size === 'number' &&
          result.size > Buffer.byteLength(seed)
        ) {
          invalidated = true;
          Object.defineProperty(result, 'size', {
            value: result.size + 1,
          });
        }
        return result;
      });

    try {
      await expect(
        lease.appendJsonLine({ rejected: true }),
      ).rejects.toBeInstanceOf(SessionTranscriptChangedError);
      expect(invalidated).toBe(true);
    } finally {
      stat.mockRestore();
    }

    await fs.writeFile(fixture.transcriptPath, seed);
    await expect(lease.assertOwnedAndUnchanged()).resolves.toBeUndefined();
    await expect(
      lease.appendJsonLine({ accepted: true }),
    ).resolves.toBeUndefined();
    await expect(fs.readFile(fixture.transcriptPath, 'utf8')).resolves.toBe(
      `${seed}{"accepted":true}\n`,
    );
    await lease.release();
  });

  it('detects an equal-length overwrite after the post-write handle stat', async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    const seed = '{"seed":true}\n';
    await fs.writeFile(fixture.transcriptPath, seed);
    const lease = await SessionWriterLease.acquire(fixture.options);
    const probe = await fs.open(fixture.transcriptPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      stat: typeof probe.stat;
    };
    await probe.close();
    const originalStat = fileHandlePrototype.stat;
    let overwritten = false;
    const stat = vi
      .spyOn(fileHandlePrototype, 'stat')
      .mockImplementation(async function (this: fs.FileHandle, ...args) {
        const result = await originalStat.apply(this, args);
        if (!overwritten && result.size > Buffer.byteLength(seed)) {
          overwritten = true;
          const transcript = readFileSync(fixture.transcriptPath, 'utf8');
          writeFileSync(
            fixture.transcriptPath,
            transcript.replace('"seed"', '"sEEd"'),
          );
          utimesSync(
            fixture.transcriptPath,
            result.atime,
            new Date(Number(result.mtimeMs) + 10_000),
          );
        }
        return result;
      });

    try {
      await expect(
        lease.appendJsonLine({ afterPostWrite: true }),
      ).rejects.toBeInstanceOf(SessionTranscriptChangedError);
      expect(overwritten).toBe(true);
    } finally {
      stat.mockRestore();
      await lease.release();
    }
  });

  it('detects an equal-length overwrite during the post-write tail read', async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    const seed = '{"seed":true}\n';
    await fs.writeFile(fixture.transcriptPath, seed);
    const lease = await SessionWriterLease.acquire(fixture.options);
    const probe = await fs.open(fixture.transcriptPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      read: typeof probe.read;
    };
    await probe.close();
    const originalRead = fileHandlePrototype.read;
    let overwritten = false;
    const read = vi
      .spyOn(fileHandlePrototype, 'read')
      .mockImplementation(async function (this: fs.FileHandle, ...args) {
        const result = await originalRead.apply(this, args);
        if (
          !overwritten &&
          positionalReadLength(args) === 1 &&
          readFileSync(fixture.transcriptPath).byteLength >
            Buffer.byteLength(seed)
        ) {
          overwritten = true;
          const transcript = readFileSync(fixture.transcriptPath, 'utf8');
          writeFileSync(
            fixture.transcriptPath,
            transcript.replace('"seed"', '"sEEd"'),
          );
          const current = statSync(fixture.transcriptPath);
          utimesSync(
            fixture.transcriptPath,
            current.atime,
            new Date(current.mtimeMs + 10_000),
          );
        }
        return result;
      });

    try {
      await expect(
        lease.appendJsonLine({ afterPostWrite: true }),
      ).rejects.toBeInstanceOf(SessionTranscriptChangedError);
      expect(overwritten).toBe(true);
    } finally {
      read.mockRestore();
      await lease.release();
    }
  });

  it.runIf(process.platform !== 'win32')(
    'reconciles metadata touched after the post-write handle stat',
    async () => {
      const fixture = await createFixture();
      await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
      const seed = '{"seed":true}\n';
      await fs.writeFile(fixture.transcriptPath, seed);
      const lease = await SessionWriterLease.acquire(fixture.options);
      const probe = await fs.open(fixture.transcriptPath, 'r');
      const fileHandlePrototype = Object.getPrototypeOf(probe) as {
        stat: typeof probe.stat;
      };
      await probe.close();
      const originalStat = fileHandlePrototype.stat;
      let touched = false;
      const stat = vi
        .spyOn(fileHandlePrototype, 'stat')
        .mockImplementation(async function (this: fs.FileHandle, ...args) {
          const result = await originalStat.apply(this, args);
          if (!touched && result.size > Buffer.byteLength(seed)) {
            touched = true;
            await fs.chmod(fixture.transcriptPath, Number(result.mode));
          }
          return result;
        });

      try {
        await expect(
          lease.appendJsonLine({ afterPostWrite: true }),
        ).resolves.toBeUndefined();
        expect(touched).toBe(true);
        await expect(fs.readFile(fixture.transcriptPath, 'utf8')).resolves.toBe(
          `${seed}{"afterPostWrite":true}\n`,
        );
      } finally {
        stat.mockRestore();
        await lease.release();
      }
    },
  );

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

  it.runIf(process.platform !== 'win32')(
    'creates the transcript directory with owner-only permissions',
    async () => {
      const fixture = await createFixture();
      const lease = await SessionWriterLease.acquire(fixture.options);

      await lease.appendJsonLine({ text: 'private' });

      const [directoryStat, transcriptStat] = await Promise.all([
        fs.stat(path.dirname(fixture.transcriptPath)),
        fs.stat(fixture.transcriptPath),
      ]);
      expect(directoryStat.mode & 0o777).toBe(0o700);
      expect(transcriptStat.mode & 0o777).toBe(0o600);
      await lease.release();
    },
  );

  it.runIf(process.platform !== 'freebsd')(
    'keeps a failed release terminal stable instead of retrying the primary path',
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

      const firstRelease = lease.release();
      const secondRelease = lease.release();
      expect(secondRelease).toBe(firstRelease);
      await expect(firstRelease).rejects.toBeInstanceOf(SessionWriterLostError);

      await fs.rmdir(lockPath);
      await fs.rename(backupPath, lockPath);
      await expect(lease.release()).rejects.toBeInstanceOf(
        SessionWriterLostError,
      );
      await fs.unlink(lockPath);
    },
  );

  it('retries a transient ownership precheck failure before release', async () => {
    const fixture = await createFixture();
    const lease = await SessionWriterLease.acquire(fixture.options);
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    lstatFault.path = lockPath;
    lstatFault.remainingFailures = 1;

    await expect(lease.release()).resolves.toBeUndefined();
    expect(lstatFault.calls).toBe(2);
    expect(lease.isReleased).toBe(true);
    lstatFault.path = undefined;
    await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never reclaims a dead local owner when managed policy is enabled', async () => {
    const fixture = await createFixture();
    const owner = startLeaseProcess();
    expect(
      await requestChild(owner, { type: 'acquire', options: fixture.options }),
    ).toMatchObject({ ok: true });
    owner.kill('SIGKILL');
    await waitForClose(owner);

    await expect(
      SessionWriterLease.acquire({
        ...fixture.options,
        reclaimPolicy: 'never',
      }),
    ).rejects.toBeInstanceOf(SessionWriterConflictError);
  });

  it('cannot remove a successor lock after release commits', async () => {
    const fixture = await createFixture();
    const first = await SessionWriterLease.acquire(fixture.options);
    await first.release();
    const successor = await SessionWriterLease.acquire(fixture.options);

    await expect(first.release()).resolves.toBeUndefined();
    await expect(successor.appendJsonLine({ successor: true })).resolves.toBe(
      undefined,
    );
    await successor.release();
  });

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

  it('keeps the primary lock when reclaim guard cleanup is already complete', async () => {
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
    const replacement = await SessionWriterLease.acquire({
      ...fixture.options,
      onOwnershipAcquired: () => unlinkSync(reclaimPath),
    });

    expect((await fs.lstat(lockPath)).isFile()).toBe(true);
    await expect(
      SessionWriterLease.acquire(fixture.options),
    ).rejects.toBeInstanceOf(SessionWriterConflictError);
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
