/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, unlinkSync } from 'node:fs';
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

const transitionFault = vi.hoisted(() => ({
  renameFrom: undefined as string | undefined,
  renameTo: undefined as string | undefined,
  afterRename: undefined as (() => Promise<void>) | undefined,
  linkFrom: undefined as string | undefined,
  linkTo: undefined as string | undefined,
  afterLink: undefined as (() => Promise<void> | void) | undefined,
  throwAfterLink: false,
}));

const restoreLinkFault = vi.hoisted(() => ({
  linkTo: undefined as string | undefined,
  remainingFailures: 0,
}));

const unlinkFault = vi.hoisted(() => ({
  path: undefined as string | undefined,
  afterUnlink: undefined as (() => Promise<void> | void) | undefined,
  throwAfterUnlink: false,
}));

const writeFault = vi.hoisted(() => ({
  contains: undefined as string | undefined,
  onEntered: undefined as (() => void) | undefined,
  wait: undefined as Promise<void> | undefined,
}));

const claimInstallFault = vi.hoisted(() => ({
  path: undefined as string | undefined,
  afterInstall: undefined as (() => Promise<void> | void) | undefined,
}));

const readFileFault = vi.hoisted(() => ({
  path: undefined as string | undefined,
  triggerCall: 0,
  calls: 0,
  afterRead: undefined as (() => Promise<void> | void) | undefined,
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
    rename: async (
      oldPath: Parameters<typeof actual.rename>[0],
      newPath: Parameters<typeof actual.rename>[1],
    ) => {
      await actual.rename(oldPath, newPath);
      if (
        oldPath === transitionFault.renameFrom &&
        (transitionFault.renameTo === undefined ||
          newPath === transitionFault.renameTo)
      ) {
        await transitionFault.afterRename?.();
      }
    },
    link: async (
      existingPath: Parameters<typeof actual.link>[0],
      newPath: Parameters<typeof actual.link>[1],
    ) => {
      if (
        newPath === restoreLinkFault.linkTo &&
        restoreLinkFault.remainingFailures > 0
      ) {
        restoreLinkFault.remainingFailures--;
        throw Object.assign(new Error('injected restore link failure'), {
          code: 'EIO',
        });
      }
      await actual.link(existingPath, newPath);
      if (newPath === claimInstallFault.path) {
        await claimInstallFault.afterInstall?.();
      }
      if (
        existingPath === transitionFault.linkFrom &&
        newPath === transitionFault.linkTo
      ) {
        await transitionFault.afterLink?.();
      }
      if (
        transitionFault.throwAfterLink &&
        existingPath === transitionFault.linkFrom &&
        newPath === transitionFault.linkTo
      ) {
        throw Object.assign(new Error('injected error after link'), {
          code: 'EIO',
        });
      }
    },
    unlink: async (filePath: Parameters<typeof actual.unlink>[0]) => {
      await actual.unlink(filePath);
      if (filePath === unlinkFault.path) {
        await unlinkFault.afterUnlink?.();
      }
      if (unlinkFault.throwAfterUnlink && filePath === unlinkFault.path) {
        throw Object.assign(new Error('injected error after unlink'), {
          code: 'EIO',
        });
      }
    },
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const result = await actual.readFile(...args);
      if (args[0] === readFileFault.path) {
        readFileFault.calls++;
        if (readFileFault.calls === readFileFault.triggerCall) {
          await readFileFault.afterRead?.();
        }
      }
      return result;
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const writeFile = handle.writeFile.bind(handle);
      handle.writeFile = async (data, options) => {
        if (
          writeFault.contains &&
          Buffer.isBuffer(data) &&
          data.toString('utf8').includes(writeFault.contains)
        ) {
          writeFault.onEntered?.();
          await writeFault.wait;
        }
        return writeFile(data, options);
      };
      return handle;
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

afterEach(async () => {
  lstatFault.path = undefined;
  lstatFault.remainingFailures = 0;
  lstatFault.calls = 0;
  transitionFault.renameFrom = undefined;
  transitionFault.renameTo = undefined;
  transitionFault.afterRename = undefined;
  transitionFault.linkFrom = undefined;
  transitionFault.linkTo = undefined;
  transitionFault.afterLink = undefined;
  transitionFault.throwAfterLink = false;
  restoreLinkFault.linkTo = undefined;
  restoreLinkFault.remainingFailures = 0;
  unlinkFault.path = undefined;
  unlinkFault.afterUnlink = undefined;
  unlinkFault.throwAfterUnlink = false;
  writeFault.contains = undefined;
  writeFault.onEntered = undefined;
  writeFault.wait = undefined;
  claimInstallFault.path = undefined;
  claimInstallFault.afterInstall = undefined;
  readFileFault.path = undefined;
  readFileFault.triggerCall = 0;
  readFileFault.calls = 0;
  readFileFault.afterRead = undefined;
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

  it('hands a real managed ACP Config to a certified replacement', async () => {
    const fixture = await createFixture('managed-config-handoff-session');
    const createConfig = () =>
      Storage.runWithRuntimeBaseDir(
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
    const initialize = (config: Config) =>
      config.initialize({
        skipGeminiInitialization: true,
        skipHooks: true,
        skipMcpDiscovery: true,
        skipSkillManager: true,
        skipFileCheckpointing: true,
        lenientToolWarmup: true,
      });

    const first = createConfig();
    first.setSessionWriterReclaimPolicy('never');
    first.setSessionWriterTakeoverPolicy('certified');
    await initialize(first);
    first.getChatRecordingService()?.recordUserMessage('handoff tail');
    await first.closeSessionWriter({ handoff: true });
    expect(
      JSON.parse(
        await fs.readFile(
          getSessionWriterLockPath(
            fixture.runtimeBaseDir,
            fixture.options.sessionId,
          ),
          'utf8',
        ),
      ),
    ).toMatchObject({ schema_version: 2, state: 'sealed' });

    const replacement = createConfig();
    replacement.setSessionWriterReclaimPolicy('never');
    replacement.setSessionWriterTakeoverPolicy('certified');
    await initialize(replacement);
    expect(
      replacement.getResumedSessionData()?.conversation.messages.at(-1)?.message
        ?.parts,
    ).toEqual([{ text: 'handoff tail' }]);

    await first.shutdown({
      shutdownTelemetry: false,
      skipSessionWriter: true,
    });
    await replacement.shutdown({ shutdownTelemetry: false });
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

  it('rejects a dangling transcript symlink introduced before sealing', async () => {
    const fixture = await createFixture('dangling-seal-session');
    const lease = await SessionWriterLease.acquire(fixture.options);
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    const activeRaw = await fs.readFile(lockPath, 'utf8');
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.symlink(
      `${fixture.transcriptPath}.missing`,
      fixture.transcriptPath,
    );

    await expect(lease.sealForHandoff()).rejects.toBeInstanceOf(
      SessionWriterUnavailableError,
    );
    await expect(fs.readFile(lockPath, 'utf8')).resolves.toBe(activeRaw);
    await expect(fs.lstat(`${lockPath}.claim`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects a dangling transcript symlink before certified takeover', async () => {
    const fixture = await createFixture('dangling-takeover-session');
    const first = await SessionWriterLease.acquire(fixture.options);
    await first.sealForHandoff();
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    const sealedRaw = await fs.readFile(lockPath, 'utf8');
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.symlink(
      `${fixture.transcriptPath}.missing`,
      fixture.transcriptPath,
    );

    await expect(
      SessionWriterLease.acquire({
        ...fixture.options,
        reclaimPolicy: 'never',
        takeoverPolicy: 'certified',
      }),
    ).rejects.toBeInstanceOf(SessionWriterUnavailableError);
    await expect(fs.readFile(lockPath, 'utf8')).resolves.toBe(sealedRaw);
    await expect(fs.lstat(`${lockPath}.claim`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
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

  it('never treats a foreign-host active record as a certified handoff', async () => {
    const fixture = await createFixture('foreign-active-session');
    const first = await SessionWriterLease.acquire(fixture.options);
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    const active = JSON.parse(await fs.readFile(lockPath, 'utf8')) as Record<
      string,
      unknown
    >;
    await first.release();
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        ...active,
        hostname: 'retired-foreign-host',
        pid: 2_147_483_647,
      }),
    );

    await expect(
      SessionWriterLease.acquire({
        ...fixture.options,
        reclaimPolicy: 'never',
        takeoverPolicy: 'certified',
      }),
    ).rejects.toBeInstanceOf(SessionWriterConflictError);
    expect(JSON.parse(await fs.readFile(lockPath, 'utf8'))).toMatchObject({
      state: 'active',
      hostname: 'retired-foreign-host',
    });
  });

  it('keeps schema v1 records on the active-owner path', async () => {
    const fixture = await createFixture('legacy-active-session');
    const first = await SessionWriterLease.acquire(fixture.options);
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    const active = JSON.parse(await fs.readFile(lockPath, 'utf8')) as Record<
      string,
      unknown
    >;
    await first.release();
    delete active['state'];
    active['schema_version'] = 1;
    await fs.writeFile(lockPath, JSON.stringify(active));

    await expect(
      SessionWriterLease.acquire({
        ...fixture.options,
        takeoverPolicy: 'certified',
      }),
    ).rejects.toBeInstanceOf(SessionWriterConflictError);

    await fs.writeFile(
      lockPath,
      JSON.stringify({
        ...active,
        pid: 2_147_483_647,
      }),
    );
    const replacement = await SessionWriterLease.acquire(fixture.options);
    await replacement.release();
  });

  it('seals a transcript proof and permits only certified takeover', async () => {
    const fixture = await createFixture('sealed-session');
    const initial = `${JSON.stringify({ record: 'initial' })}\n`;
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.writeFile(fixture.transcriptPath, initial);
    const first = await SessionWriterLease.acquire(fixture.options);
    await first.appendJsonLine({ record: 'final' });
    const expectedTranscript = await fs.readFile(fixture.transcriptPath);

    await first.sealForHandoff();

    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    const sealed = JSON.parse(await fs.readFile(lockPath, 'utf8')) as {
      schema_version: number;
      state: string;
      transcript: {
        relative_path: string;
        exists: boolean;
        byte_length: number;
        sha256: string;
      };
    };
    expect(sealed).toMatchObject({
      schema_version: 2,
      state: 'sealed',
      transcript: {
        relative_path: path
          .relative(fixture.runtimeBaseDir, fixture.transcriptPath)
          .split(path.sep)
          .join('/'),
        exists: true,
        byte_length: expectedTranscript.byteLength,
        sha256: createHash('sha256').update(expectedTranscript).digest('hex'),
      },
    });
    await expect(
      first.appendJsonLine({ record: 'too-late' }),
    ).rejects.toBeInstanceOf(SessionWriterLostError);
    await expect(fs.readFile(fixture.transcriptPath)).resolves.toEqual(
      expectedTranscript,
    );
    await expect(
      SessionWriterLease.acquire(fixture.options),
    ).rejects.toBeInstanceOf(SessionWriterConflictError);

    const replacement = await SessionWriterLease.acquire({
      ...fixture.options,
      reclaimPolicy: 'never',
      takeoverPolicy: 'certified',
    });
    expect(replacement.ownerId).not.toBe(first.ownerId);
    expect(JSON.parse(await fs.readFile(lockPath, 'utf8'))).toMatchObject({
      schema_version: 2,
      state: 'active',
      owner_id: replacement.ownerId,
    });
    await replacement.assertOwnedAndUnchanged();
    await replacement.release();
  });

  it('waits for an accepted append before sealing the transcript', async () => {
    const fixture = await createFixture('sealed-append-race-session');
    const lease = await SessionWriterLease.acquire(fixture.options);
    let resumeWrite: (() => void) | undefined;
    writeFault.contains = '"late":true';
    writeFault.wait = new Promise<void>((resolve) => {
      resumeWrite = resolve;
    });
    const writeEntered = new Promise<void>((resolve) => {
      writeFault.onEntered = resolve;
    });

    const append = lease.appendJsonLine({ late: true });
    await writeEntered;
    const seal = lease.sealForHandoff();
    await expect(
      Promise.race([
        seal.then(
          () => 'settled',
          () => 'settled',
        ),
        new Promise<'pending'>((resolve) =>
          setTimeout(() => resolve('pending'), 50),
        ),
      ]),
    ).resolves.toBe('pending');

    resumeWrite?.();
    await append;
    await seal;
    const transcript = await fs.readFile(fixture.transcriptPath);
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    const sealed = JSON.parse(await fs.readFile(lockPath, 'utf8')) as {
      transcript: { byte_length: number; sha256: string };
    };
    expect(transcript.toString('utf8')).toBe('{"late":true}\n');
    expect(sealed.transcript).toMatchObject({
      byte_length: transcript.byteLength,
      sha256: createHash('sha256').update(transcript).digest('hex'),
    });
  });

  it('reconciles a sealing error reported after the sealed primary is installed', async () => {
    const fixture = await createFixture('sealed-after-effect-session');
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.writeFile(fixture.transcriptPath, '{"record":"tail"}\n');
    const first = await SessionWriterLease.acquire(fixture.options);
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    transitionFault.linkFrom = `${lockPath}.sealed-candidate.${encodeURIComponent(
      first.ownerId,
    )}`;
    transitionFault.linkTo = lockPath;
    transitionFault.throwAfterLink = true;

    await expect(first.sealForHandoff()).resolves.toBeUndefined();
    expect(JSON.parse(await fs.readFile(lockPath, 'utf8'))).toMatchObject({
      schema_version: 2,
      state: 'sealed',
    });
  });

  it('reconciles a sealing claim link error after effect', async () => {
    const fixture = await createFixture('sealed-claim-link-session');
    const first = await SessionWriterLease.acquire(fixture.options);
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    claimInstallFault.path = `${lockPath}.claim`;
    claimInstallFault.afterInstall = () => {
      throw Object.assign(new Error('injected error after claim link'), {
        code: 'EIO',
      });
    };

    await expect(first.sealForHandoff()).resolves.toBeUndefined();
    await expect(fs.lstat(`${lockPath}.claim`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(JSON.parse(await fs.readFile(lockPath, 'utf8'))).toMatchObject({
      state: 'sealed',
    });
  });

  it('reconciles a sealing claim unlink error after effect', async () => {
    const fixture = await createFixture('sealed-claim-unlink-session');
    const first = await SessionWriterLease.acquire(fixture.options);
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    unlinkFault.path = `${lockPath}.claim`;
    unlinkFault.throwAfterUnlink = true;

    await expect(first.sealForHandoff()).resolves.toBeUndefined();
    await expect(fs.lstat(`${lockPath}.claim`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(JSON.parse(await fs.readFile(lockPath, 'utf8'))).toMatchObject({
      state: 'sealed',
    });
  });

  it('does not roll back after the released claim is replaced', async () => {
    const fixture = await createFixture('sealed-replaced-claim-session');
    const first = await SessionWriterLease.acquire(fixture.options);
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    const successorClaim = '{"successorClaim":true}';
    unlinkFault.path = `${lockPath}.claim`;
    unlinkFault.afterUnlink = () =>
      fs.writeFile(`${lockPath}.claim`, successorClaim, 'utf8');
    unlinkFault.throwAfterUnlink = true;

    await expect(first.sealForHandoff()).resolves.toBeUndefined();
    await expect(fs.readFile(`${lockPath}.claim`, 'utf8')).resolves.toBe(
      successorClaim,
    );
    expect(JSON.parse(await fs.readFile(lockPath, 'utf8'))).toMatchObject({
      state: 'sealed',
    });
  });

  it('does not roll back sealing after claim ownership changes', async () => {
    const fixture = await createFixture('sealed-changed-claim-session');
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.writeFile(fixture.transcriptPath, '{"record":"tail"}\n');
    const first = await SessionWriterLease.acquire(fixture.options);
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    const successorClaim = '{"successorClaim":true}';
    transitionFault.linkFrom = `${lockPath}.sealed-candidate.${encodeURIComponent(
      first.ownerId,
    )}`;
    transitionFault.linkTo = lockPath;
    transitionFault.afterLink = async () => {
      await fs.unlink(`${lockPath}.claim`);
      await fs.writeFile(`${lockPath}.claim`, successorClaim, 'utf8');
      lstatFault.path = fixture.transcriptPath;
      lstatFault.remainingFailures = 1;
    };

    await expect(first.sealForHandoff()).rejects.toBeInstanceOf(
      SessionWriterUnavailableError,
    );
    await expect(fs.readFile(`${lockPath}.claim`, 'utf8')).resolves.toBe(
      successorClaim,
    );
    expect(JSON.parse(await fs.readFile(lockPath, 'utf8'))).toMatchObject({
      state: 'sealed',
    });
  });

  it('retains the claim when sealing rollback cannot restore the primary', async () => {
    const fixture = await createFixture('sealed-rollback-failure-session');
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.writeFile(fixture.transcriptPath, '{"record":"tail"}\n');
    const first = await SessionWriterLease.acquire(fixture.options);
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    const activeRaw = await fs.readFile(lockPath, 'utf8');
    transitionFault.linkFrom = `${lockPath}.sealed-candidate.${encodeURIComponent(
      first.ownerId,
    )}`;
    transitionFault.linkTo = lockPath;
    transitionFault.afterLink = () => {
      lstatFault.path = fixture.transcriptPath;
      lstatFault.remainingFailures = 1;
      restoreLinkFault.linkTo = lockPath;
      restoreLinkFault.remainingFailures = 1;
    };

    await expect(first.sealForHandoff()).rejects.toBeInstanceOf(
      SessionWriterUnavailableError,
    );
    await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.readFile(`${lockPath}.claim`, 'utf8')).resolves.toBe(
      activeRaw,
    );
    await expect(
      fs.readFile(
        `${lockPath}.handoff.${encodeURIComponent(first.ownerId)}`,
        'utf8',
      ),
    ).resolves.toBe(activeRaw);
    await fs.appendFile(fixture.transcriptPath, '{"external":true}\n');
    await expect(
      SessionWriterLease.acquire(fixture.options),
    ).rejects.toBeInstanceOf(SessionWriterUnavailableError);
    await expect(
      SessionWriterLease.acquire({
        ...fixture.options,
        takeoverPolicy: 'certified',
      }),
    ).rejects.toBeInstanceOf(SessionWriterUnavailableError);
  });

  it('removes the claim after sealing rollback restores the primary', async () => {
    const fixture = await createFixture('sealed-rollback-success-session');
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.writeFile(fixture.transcriptPath, '{"record":"tail"}\n');
    const first = await SessionWriterLease.acquire(fixture.options);
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    const activeRaw = await fs.readFile(lockPath, 'utf8');
    transitionFault.linkFrom = `${lockPath}.sealed-candidate.${encodeURIComponent(
      first.ownerId,
    )}`;
    transitionFault.linkTo = lockPath;
    transitionFault.afterLink = () => {
      lstatFault.path = fixture.transcriptPath;
      lstatFault.remainingFailures = 1;
    };

    await expect(first.sealForHandoff()).rejects.toBeInstanceOf(
      SessionWriterUnavailableError,
    );
    await expect(fs.readFile(lockPath, 'utf8')).resolves.toBe(activeRaw);
    await expect(fs.lstat(`${lockPath}.claim`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('waits for a claim-aware primary candidate before completing sealing', async () => {
    const fixture = await createFixture('sealed-primary-candidate-session');
    const first = await SessionWriterLease.acquire(fixture.options);
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    const active = JSON.parse(await fs.readFile(lockPath, 'utf8')) as Record<
      string,
      unknown
    >;
    const candidateRaw = JSON.stringify({
      ...active,
      owner_id: 'claim-aware-candidate',
    });
    transitionFault.renameFrom = lockPath;
    transitionFault.renameTo = `${lockPath}.handoff.${encodeURIComponent(
      first.ownerId,
    )}`;
    transitionFault.afterRename = async () => {
      await fs.writeFile(lockPath, candidateRaw, 'utf8');
      readFileFault.path = lockPath;
      readFileFault.triggerCall = 2;
      readFileFault.afterRead = () => fs.unlink(lockPath);
    };

    await expect(first.sealForHandoff()).resolves.toBeUndefined();
    expect(readFileFault.calls).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(await fs.readFile(lockPath, 'utf8'))).toMatchObject({
      state: 'sealed',
      owner_id: first.ownerId,
    });
    await expect(fs.lstat(`${lockPath}.claim`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('fails closed when a primary candidate is abandoned during sealing', async () => {
    const fixture = await createFixture('sealed-abandoned-candidate-session');
    const first = await SessionWriterLease.acquire(fixture.options);
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    const activeRaw = await fs.readFile(lockPath, 'utf8');
    const candidateRaw = JSON.stringify({
      ...(JSON.parse(activeRaw) as Record<string, unknown>),
      owner_id: 'abandoned-candidate',
    });
    const retiredPath = `${lockPath}.handoff.${encodeURIComponent(
      first.ownerId,
    )}`;
    transitionFault.renameFrom = lockPath;
    transitionFault.renameTo = retiredPath;
    transitionFault.afterRename = () =>
      fs.writeFile(lockPath, candidateRaw, 'utf8');

    await expect(first.sealForHandoff()).rejects.toBeInstanceOf(
      SessionWriterUnavailableError,
    );
    await expect(fs.readFile(lockPath, 'utf8')).resolves.toBe(candidateRaw);
    await expect(fs.readFile(`${lockPath}.claim`, 'utf8')).resolves.toBe(
      activeRaw,
    );
    await expect(fs.readFile(retiredPath, 'utf8')).resolves.toBe(activeRaw);
  });

  it('waits for a claim-aware primary candidate while rolling back sealing', async () => {
    const fixture = await createFixture('sealed-rollback-candidate-session');
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.writeFile(fixture.transcriptPath, '{"record":"tail"}\n');
    const first = await SessionWriterLease.acquire(fixture.options);
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    const activeRaw = await fs.readFile(lockPath, 'utf8');
    const active = JSON.parse(activeRaw) as Record<string, unknown>;
    const candidateRaw = JSON.stringify({
      ...active,
      owner_id: 'rollback-candidate',
    });
    transitionFault.linkFrom = `${lockPath}.sealed-candidate.${encodeURIComponent(
      first.ownerId,
    )}`;
    transitionFault.linkTo = lockPath;
    transitionFault.afterLink = () => {
      lstatFault.path = fixture.transcriptPath;
      lstatFault.remainingFailures = 1;
      unlinkFault.path = lockPath;
      unlinkFault.afterUnlink = async () => {
        unlinkFault.path = undefined;
        await fs.writeFile(lockPath, candidateRaw, 'utf8');
        readFileFault.path = lockPath;
        readFileFault.triggerCall = 2;
        readFileFault.afterRead = () => fs.unlink(lockPath);
      };
    };

    await expect(first.sealForHandoff()).rejects.toBeInstanceOf(
      SessionWriterUnavailableError,
    );
    await expect(fs.readFile(lockPath, 'utf8')).resolves.toBe(activeRaw);
    await expect(fs.lstat(`${lockPath}.claim`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      fs.lstat(`${lockPath}.handoff.${encodeURIComponent(first.ownerId)}`),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed when a primary candidate is abandoned during rollback', async () => {
    const fixture = await createFixture(
      'sealed-rollback-abandoned-candidate-session',
    );
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.writeFile(fixture.transcriptPath, '{"record":"tail"}\n');
    const first = await SessionWriterLease.acquire(fixture.options);
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    const activeRaw = await fs.readFile(lockPath, 'utf8');
    const candidateRaw = JSON.stringify({
      ...(JSON.parse(activeRaw) as Record<string, unknown>),
      owner_id: 'abandoned-rollback-candidate',
    });
    const retiredPath = `${lockPath}.handoff.${encodeURIComponent(
      first.ownerId,
    )}`;
    transitionFault.linkFrom = `${lockPath}.sealed-candidate.${encodeURIComponent(
      first.ownerId,
    )}`;
    transitionFault.linkTo = lockPath;
    transitionFault.afterLink = () => {
      lstatFault.path = fixture.transcriptPath;
      lstatFault.remainingFailures = 1;
      unlinkFault.path = lockPath;
      unlinkFault.throwAfterUnlink = true;
      unlinkFault.afterUnlink = async () => {
        unlinkFault.path = undefined;
        await fs.writeFile(lockPath, candidateRaw, 'utf8');
      };
    };

    await expect(first.sealForHandoff()).rejects.toBeInstanceOf(
      SessionWriterUnavailableError,
    );
    await expect(fs.readFile(lockPath, 'utf8')).resolves.toBe(candidateRaw);
    await expect(fs.readFile(`${lockPath}.claim`, 'utf8')).resolves.toBe(
      activeRaw,
    );
    await expect(fs.readFile(retiredPath, 'utf8')).resolves.toBe(activeRaw);
  });

  it('never overwrites a primary installed during the sealing transition', async () => {
    const fixture = await createFixture('sealed-successor-session');
    const first = await SessionWriterLease.acquire(fixture.options);
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    const successorRaw = '{"successor":true}';
    transitionFault.renameFrom = lockPath;
    transitionFault.renameTo = `${lockPath}.handoff.${encodeURIComponent(
      first.ownerId,
    )}`;
    transitionFault.afterRename = () =>
      fs.writeFile(lockPath, successorRaw, 'utf8');

    await expect(first.sealForHandoff()).rejects.toBeInstanceOf(
      SessionWriterUnavailableError,
    );
    expect(first.isReleased).toBe(true);
    await expect(fs.readFile(lockPath, 'utf8')).resolves.toBe(successorRaw);
    await expect(fs.lstat(`${lockPath}.claim`)).resolves.toBeDefined();
  });

  it('elects exactly one certified replacement for a sealed session', async () => {
    const fixture = await createFixture('sealed-race-session');
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.writeFile(fixture.transcriptPath, '{"record":"tail"}\n');
    const first = await SessionWriterLease.acquire(fixture.options);
    await first.sealForHandoff();

    const contenders = [startLeaseProcess(), startLeaseProcess()];
    const options = {
      ...fixture.options,
      reclaimPolicy: 'never' as const,
      takeoverPolicy: 'certified' as const,
    };
    const results = await Promise.all(
      contenders.map((child) =>
        requestChild(child, { type: 'acquire', options }),
      ),
    );
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const winner = contenders[results.findIndex((result) => result.ok)]!;
    expect(await requestChild(winner, { type: 'release' })).toMatchObject({
      ok: true,
    });
  });

  it('releases a losing takeover claim before its transition starts', async () => {
    const fixture = await createFixture(
      'takeover-pre-transition-loser-session',
    );
    const first = await SessionWriterLease.acquire(fixture.options);
    await first.sealForHandoff();
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    let winnerRaw = '';
    claimInstallFault.path = `${lockPath}.claim`;
    claimInstallFault.afterInstall = async () => {
      const contender = JSON.parse(
        await fs.readFile(`${lockPath}.claim`, 'utf8'),
      ) as Record<string, unknown>;
      winnerRaw = JSON.stringify({
        ...contender,
        owner_id: 'certified-winner',
      });
      await fs.unlink(lockPath);
      await fs.writeFile(lockPath, winnerRaw, 'utf8');
    };

    await expect(
      SessionWriterLease.acquire({
        ...fixture.options,
        reclaimPolicy: 'never',
        takeoverPolicy: 'certified',
      }),
    ).rejects.toBeInstanceOf(SessionWriterConflictError);
    await expect(fs.readFile(lockPath, 'utf8')).resolves.toBe(winnerRaw);
    await expect(fs.lstat(`${lockPath}.claim`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('reconciles a takeover error reported after the active primary is installed', async () => {
    const fixture = await createFixture('takeover-after-effect-session');
    const first = await SessionWriterLease.acquire(fixture.options);
    await first.sealForHandoff();
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    transitionFault.linkFrom = `${lockPath}.claim`;
    transitionFault.linkTo = lockPath;
    transitionFault.throwAfterLink = true;

    const replacement = await SessionWriterLease.acquire({
      ...fixture.options,
      reclaimPolicy: 'never',
      takeoverPolicy: 'certified',
    });
    expect(JSON.parse(await fs.readFile(lockPath, 'utf8'))).toMatchObject({
      schema_version: 2,
      state: 'active',
      owner_id: replacement.ownerId,
    });
    await replacement.release();
  });

  it('reconciles a takeover claim link error after effect', async () => {
    const fixture = await createFixture('takeover-claim-link-session');
    const first = await SessionWriterLease.acquire(fixture.options);
    await first.sealForHandoff();
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    claimInstallFault.path = `${lockPath}.claim`;
    claimInstallFault.afterInstall = () => {
      throw Object.assign(new Error('injected error after claim link'), {
        code: 'EIO',
      });
    };

    const replacement = await SessionWriterLease.acquire({
      ...fixture.options,
      reclaimPolicy: 'never',
      takeoverPolicy: 'certified',
    });
    await expect(fs.lstat(`${lockPath}.claim`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(JSON.parse(await fs.readFile(lockPath, 'utf8'))).toMatchObject({
      state: 'active',
      owner_id: replacement.ownerId,
    });
    await replacement.release();
  });

  it('reconciles a takeover claim unlink error after effect', async () => {
    const fixture = await createFixture('takeover-claim-unlink-session');
    const first = await SessionWriterLease.acquire(fixture.options);
    await first.sealForHandoff();
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    unlinkFault.path = `${lockPath}.claim`;
    unlinkFault.throwAfterUnlink = true;

    const replacement = await SessionWriterLease.acquire({
      ...fixture.options,
      reclaimPolicy: 'never',
      takeoverPolicy: 'certified',
    });
    await expect(fs.lstat(`${lockPath}.claim`)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(JSON.parse(await fs.readFile(lockPath, 'utf8'))).toMatchObject({
      state: 'active',
      owner_id: replacement.ownerId,
    });
    await replacement.release();
  });

  it('does not roll back takeover after claim ownership changes', async () => {
    const fixture = await createFixture('takeover-changed-claim-session');
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.writeFile(fixture.transcriptPath, '{"record":"tail"}\n');
    const first = await SessionWriterLease.acquire(fixture.options);
    await first.sealForHandoff();
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    const successorClaim = '{"successorClaim":true}';
    transitionFault.linkFrom = `${lockPath}.claim`;
    transitionFault.linkTo = lockPath;
    transitionFault.afterLink = async () => {
      await fs.unlink(`${lockPath}.claim`);
      await fs.writeFile(`${lockPath}.claim`, successorClaim, 'utf8');
      lstatFault.path = fixture.transcriptPath;
      lstatFault.remainingFailures = 1;
    };

    await expect(
      SessionWriterLease.acquire({
        ...fixture.options,
        reclaimPolicy: 'never',
        takeoverPolicy: 'certified',
      }),
    ).rejects.toBeInstanceOf(SessionWriterUnavailableError);
    await expect(fs.readFile(`${lockPath}.claim`, 'utf8')).resolves.toBe(
      successorClaim,
    );
    expect(JSON.parse(await fs.readFile(lockPath, 'utf8'))).toMatchObject({
      state: 'active',
    });
  });

  it('retains the claim when takeover rollback cannot restore the primary', async () => {
    const fixture = await createFixture('takeover-rollback-failure-session');
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.writeFile(fixture.transcriptPath, '{"record":"tail"}\n');
    const first = await SessionWriterLease.acquire(fixture.options);
    await first.sealForHandoff();
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    const sealedRaw = await fs.readFile(lockPath, 'utf8');
    transitionFault.linkFrom = `${lockPath}.claim`;
    transitionFault.linkTo = lockPath;
    transitionFault.afterLink = () => {
      lstatFault.path = fixture.transcriptPath;
      lstatFault.remainingFailures = 1;
      restoreLinkFault.linkTo = lockPath;
      restoreLinkFault.remainingFailures = 1;
    };

    await expect(
      SessionWriterLease.acquire({
        ...fixture.options,
        reclaimPolicy: 'never',
        takeoverPolicy: 'certified',
      }),
    ).rejects.toBeInstanceOf(SessionWriterUnavailableError);
    await expect(fs.lstat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const claimRaw = await fs.readFile(`${lockPath}.claim`, 'utf8');
    const claim = JSON.parse(claimRaw) as { owner_id: string; state: string };
    expect(claim.state).toBe('active');
    await expect(
      fs.readFile(
        `${lockPath}.sealed.${encodeURIComponent(
          first.ownerId,
        )}.${encodeURIComponent(claim.owner_id)}`,
        'utf8',
      ),
    ).resolves.toBe(sealedRaw);
    await fs.appendFile(fixture.transcriptPath, '{"external":true}\n');
    await expect(
      SessionWriterLease.acquire(fixture.options),
    ).rejects.toBeInstanceOf(SessionWriterUnavailableError);
    await expect(
      SessionWriterLease.acquire({
        ...fixture.options,
        reclaimPolicy: 'never',
        takeoverPolicy: 'certified',
      }),
    ).rejects.toBeInstanceOf(SessionWriterUnavailableError);
  });

  it('never overwrites a primary installed during the takeover transition', async () => {
    const fixture = await createFixture('takeover-successor-session');
    const first = await SessionWriterLease.acquire(fixture.options);
    await first.sealForHandoff();
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    const successorRaw = '{"successor":true}';
    transitionFault.renameFrom = lockPath;
    transitionFault.afterRename = () =>
      fs.writeFile(lockPath, successorRaw, 'utf8');

    await expect(
      SessionWriterLease.acquire({
        ...fixture.options,
        reclaimPolicy: 'never',
        takeoverPolicy: 'certified',
      }),
    ).rejects.toBeInstanceOf(SessionWriterUnavailableError);
    await expect(fs.readFile(lockPath, 'utf8')).resolves.toBe(successorRaw);
    await expect(fs.lstat(`${lockPath}.claim`)).resolves.toBeDefined();
  });

  it.each(['append', 'truncate', 'replace'] as const)(
    'retains a sealed lock when the transcript proof changes by %s',
    async (mutation) => {
      const fixture = await createFixture(`sealed-${mutation}-session`);
      await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
      await fs.writeFile(fixture.transcriptPath, '{"record":"tail"}\n');
      const first = await SessionWriterLease.acquire(fixture.options);
      await first.sealForHandoff();
      const lockPath = getSessionWriterLockPath(
        fixture.runtimeBaseDir,
        fixture.options.sessionId,
      );
      const sealedRaw = await fs.readFile(lockPath, 'utf8');
      if (mutation === 'append') {
        await fs.appendFile(fixture.transcriptPath, '{"external":true}\n');
      } else if (mutation === 'truncate') {
        await fs.truncate(fixture.transcriptPath, 0);
      } else {
        const replacementPath = `${fixture.transcriptPath}.replacement`;
        await fs.writeFile(replacementPath, '{"record":"evil"}\n');
        await fs.rename(replacementPath, fixture.transcriptPath);
      }

      await expect(
        SessionWriterLease.acquire({
          ...fixture.options,
          reclaimPolicy: 'never',
          takeoverPolicy: 'certified',
        }),
      ).rejects.toBeInstanceOf(SessionTranscriptChangedError);
      await expect(fs.readFile(lockPath, 'utf8')).resolves.toBe(sealedRaw);
    },
  );

  it.each([
    ['valid but mismatched', '0'.repeat(64), SessionTranscriptChangedError],
    ['malformed', 'invalid', SessionWriterUnavailableError],
  ])(
    'retains a sealed primary with a %s transcript digest',
    async (_description, sha256, ErrorType) => {
      const fixture = await createFixture('sealed-proof-session');
      const first = await SessionWriterLease.acquire(fixture.options);
      await first.sealForHandoff();
      const lockPath = getSessionWriterLockPath(
        fixture.runtimeBaseDir,
        fixture.options.sessionId,
      );
      const sealed = JSON.parse(await fs.readFile(lockPath, 'utf8')) as {
        transcript: { sha256: string };
      };
      sealed.transcript.sha256 = sha256;
      const sealedRaw = JSON.stringify(sealed);
      await fs.writeFile(lockPath, sealedRaw);

      await expect(
        SessionWriterLease.acquire({
          ...fixture.options,
          reclaimPolicy: 'never',
          takeoverPolicy: 'certified',
        }),
      ).rejects.toBeInstanceOf(ErrorType);
      await expect(fs.readFile(lockPath, 'utf8')).resolves.toBe(sealedRaw);
    },
  );

  it('fails closed without changing a sealed primary when a claim remains', async () => {
    const fixture = await createFixture('sealed-claim-session');
    const first = await SessionWriterLease.acquire(fixture.options);
    await first.sealForHandoff();
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    const sealedRaw = await fs.readFile(lockPath, 'utf8');
    await fs.writeFile(`${lockPath}.claim`, '{"residual":true}');

    await expect(
      SessionWriterLease.acquire({
        ...fixture.options,
        reclaimPolicy: 'never',
        takeoverPolicy: 'certified',
      }),
    ).rejects.toBeInstanceOf(SessionWriterUnavailableError);
    await expect(fs.readFile(lockPath, 'utf8')).resolves.toBe(sealedRaw);
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
