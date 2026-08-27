/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
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
  SessionTranscriptIdentityUnavailableError,
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

const zeroInodeFault = vi.hoisted(() => ({
  underRoot: undefined as string | undefined,
}));

const fsOpenTestHook = vi.hoisted(() => ({
  beforeOpen: undefined as
    | ((filePath: PathLike, flags: string | number) => void | Promise<void>)
    | undefined,
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
    stat: async (
      filePath: Parameters<typeof actual.stat>[0],
      ...rest: unknown[]
    ) => {
      const result = await (
        actual.stat as (...args: unknown[]) => ReturnType<typeof actual.stat>
      )(filePath, ...rest);
      if (
        zeroInodeFault.underRoot !== undefined &&
        typeof filePath === 'string' &&
        filePath.startsWith(zeroInodeFault.underRoot)
      ) {
        Object.defineProperty(result, 'ino', { value: 0 });
      }
      return result;
    },
    open: async (filePath: PathLike, flags: string | number, mode?: Mode) => {
      await fsOpenTestHook.beforeOpen?.(filePath, flags);
      const handle = await actual.open(filePath, flags, mode);
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
  };
});

const helperPath = fileURLToPath(
  new URL('./session-writer-lease.test-helper.ts', import.meta.url),
);

let nextRequestId = 0;
const children = new Set<ChildProcess>();
const temporaryDirectories = new Set<string>();

/**
 * Inode ctime/mtime come from the kernel's coarse clock (4ms granularity on
 * the Linux CI kernels), so a *same-value* chmod/chown very often produces NO
 * observable timestamp change: the injected condition simply does not happen
 * and the test asserting it fails. Repeat the operation until the drift is
 * actually published, which keeps the condition under test intact.
 */
async function withObservedTimestampDrift(
  filePath: string,
  op: () => Promise<void>,
): Promise<import('node:fs').Stats> {
  const before = await fs.stat(filePath);
  for (let attempt = 0; attempt < 200; attempt++) {
    await op();
    const after = await fs.stat(filePath);
    if (
      after.ctimeMs !== before.ctimeMs ||
      after.mtimeMs !== before.mtimeMs ||
      after.birthtimeMs !== before.birthtimeMs
    ) {
      return after;
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`no timestamp drift observed for ${filePath}`);
}

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
  const pid = child.pid;
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolve) => child.once('close', () => resolve()));
  }
  if (pid === undefined) return;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      // ESRCH means gone; EPERM means the PID was already recycled by a
      // process this test cannot signal. Either way the child is gone.
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  // On Windows PIDs recycle aggressively, so a still-answerable signal 0
  // almost always means a reused PID, not a leaked child; do not turn that
  // teardown observation into a test failure.
  console.warn(`Process ${pid} remained live after close`);
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

type FileHandlePrototypeMethods = {
  read: fs.FileHandle['read'];
  stat: fs.FileHandle['stat'];
};

let fileHandlePrototype: FileHandlePrototypeMethods;
let nativeFileHandleRead: FileHandlePrototypeMethods['read'];
let nativeFileHandleStat: FileHandlePrototypeMethods['stat'];

beforeAll(async () => {
  const probePath = path.join(os.tmpdir(), `qwen-fh-probe-${process.pid}`);
  writeFileSync(probePath, '');
  const probe = await fs.open(probePath, 'r');
  fileHandlePrototype = Object.getPrototypeOf(
    probe,
  ) as FileHandlePrototypeMethods;
  nativeFileHandleRead = fileHandlePrototype.read;
  nativeFileHandleStat = fileHandlePrototype.stat;
  await probe.close();
  unlinkSync(probePath);
});

afterEach(async () => {
  vi.restoreAllMocks();
  fileHandlePrototype.read = nativeFileHandleRead;
  fileHandlePrototype.stat = nativeFileHandleStat;
  lstatFault.path = undefined;
  lstatFault.remainingFailures = 0;
  lstatFault.calls = 0;
  zeroInodeFault.underRoot = undefined;
  fsOpenTestHook.beforeOpen = undefined;
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
    expect(() => lease.assertCleanupOwned()).not.toThrow();
    await expect(lease.assertOwnedAndUnchanged()).rejects.toBeInstanceOf(
      SessionTranscriptChangedError,
    );

    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    await fs.unlink(lockPath);
    await fs.writeFile(lockPath, '{"replacement":true}');
    expect(() => lease.assertCleanupOwned()).toThrow(SessionWriterLostError);
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
    'rejects a symlinked cleanup lock',
    async () => {
      const fixture = await createFixture();
      const lease = await SessionWriterLease.acquire(fixture.options);
      const lockPath = getSessionWriterLockPath(
        fixture.runtimeBaseDir,
        fixture.options.sessionId,
      );
      const targetPath = `${lockPath}.replacement`;
      const lockRecord = await fs.readFile(lockPath, 'utf8');
      await fs.writeFile(targetPath, lockRecord);
      await fs.unlink(lockPath);
      await fs.symlink(targetPath, lockPath);

      expect(() => lease.assertCleanupOwned()).toThrow(SessionWriterLostError);
      await expect(lease.release()).rejects.toBeInstanceOf(
        SessionWriterLostError,
      );
      await fs.unlink(lockPath);
      await fs.unlink(targetPath);
    },
  );

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

  it.runIf(process.platform !== 'win32')(
    'reconciles timestamp-only metadata changes before appending',
    async () => {
      const fixture = await createFixture();
      await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
      await fs.writeFile(fixture.transcriptPath, '{"seed":true}\n');
      const lease = await SessionWriterLease.acquire(fixture.options);
      const initial = await fs.stat(fixture.transcriptPath);

      const afterChmod = await withObservedTimestampDrift(
        fixture.transcriptPath,
        () => fs.chmod(fixture.transcriptPath, initial.mode),
      );
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

      const afterChown = await withObservedTimestampDrift(
        fixture.transcriptPath,
        () => fs.chown(fixture.transcriptPath, initial.uid, initial.gid),
      );
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

    await withObservedTimestampDrift(fixture.transcriptPath, async () => {
      await fs.writeFile(fixture.transcriptPath, '{"sEEd":true}\n');
      await fs.utimes(fixture.transcriptPath, anchoredTime, anchoredTime);
    });
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
    'does not follow a symlink installed between transcript inspection and append open',
    async () => {
      const fixture = await createFixture();
      await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
      await fs.writeFile(fixture.transcriptPath, '{"seed":true}\n');
      const lease = await SessionWriterLease.acquire(fixture.options);
      const originalPath = `${fixture.transcriptPath}.original`;
      let replaced = false;
      let appendOpenFlags: number | undefined;
      fsOpenTestHook.beforeOpen = async (filePath, flags) => {
        if (
          !replaced &&
          filePath === fixture.transcriptPath &&
          typeof flags === 'number' &&
          (flags & fsConstants.O_APPEND) !== 0
        ) {
          replaced = true;
          appendOpenFlags = flags;
          await fs.rename(fixture.transcriptPath, originalPath);
          await fs.symlink(originalPath, fixture.transcriptPath);
        }
      };

      try {
        await expect(
          lease.appendJsonLine({ appended: true }),
        ).rejects.toBeInstanceOf(SessionTranscriptChangedError);
        expect(replaced).toBe(true);
        expect(appendOpenFlags! & fsConstants.O_NOFOLLOW).not.toBe(0);
        expect(appendOpenFlags! & fsConstants.O_NONBLOCK).not.toBe(0);
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

  it('rejects a new session up front when the filesystem cannot number inodes', async () => {
    const fixture = await createFixture();
    // Brand-new session: the transcript file does not exist yet, so the
    // probe stands in for it with the nearest existing ancestor directory.
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    zeroInodeFault.underRoot = fixture.runtimeBaseDir;

    await expect(
      SessionWriterLease.acquire(fixture.options),
    ).rejects.toBeInstanceOf(SessionTranscriptIdentityUnavailableError);
    await expect(fs.access(fixture.transcriptPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('acquires normally when the transcript directory does not exist yet', async () => {
    const fixture = await createFixture();

    const lease = await SessionWriterLease.acquire(fixture.options);
    await lease.appendJsonLine({ hello: 'world' });
    await lease.release();

    await expect(fs.readFile(fixture.transcriptPath, 'utf8')).resolves.toBe(
      '{"hello":"world"}\n',
    );
  });

  it('rejects a transcript with an unverifiable inode before writing', async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    const seed = '{"seed":true}\n';
    await fs.writeFile(fixture.transcriptPath, seed);
    const originalStat = nativeFileHandleStat;
    const stat = vi
      .spyOn(fileHandlePrototype, 'stat')
      .mockImplementation(async function (this: fs.FileHandle, ...args) {
        const result = await originalStat.apply(this, args);
        return Object.defineProperty(result, 'ino', { value: 0 });
      });

    try {
      await expect(
        SessionWriterLease.acquire(fixture.options),
      ).rejects.toBeInstanceOf(SessionTranscriptIdentityUnavailableError);
      await expect(fs.readFile(fixture.transcriptPath, 'utf8')).resolves.toBe(
        seed,
      );
    } finally {
      stat.mockRestore();
    }
  });

  it('detects a size change between handle and path stat', async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.writeFile(fixture.transcriptPath, '{"seed":true}\n');
    const lease = await SessionWriterLease.acquire(fixture.options);
    const initial = await fs.stat(fixture.transcriptPath);
    const originalStat = nativeFileHandleStat;
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
    const originalStat = nativeFileHandleStat;
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
    await fs.utimes(
      fixture.transcriptPath,
      initial.atime,
      new Date(initial.mtimeMs + 1000),
    );
    const originalRead = nativeFileHandleRead;
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
    await fs.utimes(
      fixture.transcriptPath,
      initial.atime,
      new Date(initial.mtimeMs + 500),
    );
    const originalRead = nativeFileHandleRead;
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

  it('resizes the hash buffer when an empty transcript grows between retries', async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.writeFile(fixture.transcriptPath, '');
    const initial = await fs.stat(fixture.transcriptPath);
    const originalStat = nativeFileHandleStat;
    let statCalls = 0;
    let lease: SessionWriterLease | undefined;
    const stat = vi
      .spyOn(fileHandlePrototype, 'stat')
      .mockImplementation(async function (this: fs.FileHandle, ...args) {
        const call = ++statCalls;
        if (call === 3) {
          await fs.writeFile(fixture.transcriptPath, '{"seed":true}\n');
        }
        const result = await originalStat.apply(this, args);
        if (call === 2) {
          await fs.utimes(
            fixture.transcriptPath,
            initial.atime,
            new Date(initial.mtimeMs + 1_000),
          );
        }
        return result;
      });

    try {
      lease = await SessionWriterLease.acquire(fixture.options);
      expect(statCalls).toBeGreaterThanOrEqual(4);
      await expect(fs.readFile(fixture.transcriptPath, 'utf8')).resolves.toBe(
        '{"seed":true}\n',
      );
    } finally {
      stat.mockRestore();
      await lease?.release();
    }
  });

  it('requires a stable scan when an already-read prefix changes', async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    const transcript = Buffer.alloc(2 * 1024 * 1024, 0x20);
    transcript[transcript.byteLength - 1] = 0x0a;
    await fs.writeFile(fixture.transcriptPath, transcript);
    const lease = await SessionWriterLease.acquire(fixture.options);
    const initial = await fs.stat(fixture.transcriptPath);
    await fs.utimes(
      fixture.transcriptPath,
      initial.atime,
      new Date(initial.mtimeMs + 1_000),
    );
    const originalRead = nativeFileHandleRead;
    let injected = false;
    let scanStarts = 0;
    const read = vi
      .spyOn(fileHandlePrototype, 'read')
      .mockImplementation(async function (this: fs.FileHandle, ...args) {
        const result = await originalRead.apply(this, args);
        const values = args as readonly unknown[];
        if ((positionalReadLength(args) ?? 0) > 1 && values[3] === 0) {
          scanStarts++;
        }
        if (!injected && values[2] === 1024 * 1024 && values[3] === 0) {
          injected = true;
          const mutator = await fs.open(fixture.transcriptPath, 'r+');
          try {
            await mutator.write(Buffer.from('!'), 0, 1, 0);
            await mutator.sync();
          } finally {
            await mutator.close();
          }
        }
        return result;
      });

    try {
      await expect(lease.assertOwnedAndUnchanged()).rejects.toBeInstanceOf(
        SessionTranscriptChangedError,
      );
      expect(injected).toBe(true);
      expect(scanStarts).toBe(2);
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
    await fs.utimes(
      fixture.transcriptPath,
      initial.atime,
      new Date(initial.mtimeMs + 500),
    );
    const originalRead = nativeFileHandleRead;
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

  it.skipIf(process.platform === 'win32')(
    'detects an atomic replacement during content verification',
    async () => {
      const fixture = await createFixture();
      await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
      await fs.writeFile(fixture.transcriptPath, '{"seed":true}\n');
      const lease = await SessionWriterLease.acquire(fixture.options);
      const initial = await fs.stat(fixture.transcriptPath);
      await fs.utimes(
        fixture.transcriptPath,
        initial.atime,
        new Date(initial.mtimeMs + 1000),
      );
      const replacement = `${fixture.transcriptPath}.replacement`;
      await fs.writeFile(replacement, '{"sEEd":true}\n');
      const originalRead = nativeFileHandleRead;
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
    },
  );

  it('detects truncation during content verification', async () => {
    const fixture = await createFixture();
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.writeFile(fixture.transcriptPath, '{"seed":true}\n');
    const lease = await SessionWriterLease.acquire(fixture.options);
    const initial = await fs.stat(fixture.transcriptPath);
    await fs.utimes(
      fixture.transcriptPath,
      initial.atime,
      new Date(initial.mtimeMs + 1000),
    );
    const originalRead = nativeFileHandleRead;
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
    await fs.utimes(
      fixture.transcriptPath,
      initial.atime,
      new Date(initial.mtimeMs + 1000),
    );
    const originalRead = nativeFileHandleRead;
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
    await fs.utimes(
      fixture.transcriptPath,
      initial.atime,
      new Date(initial.mtimeMs + 1000),
    );
    const lockPath = getSessionWriterLockPath(
      fixture.runtimeBaseDir,
      fixture.options.sessionId,
    );
    const originalRead = nativeFileHandleRead;
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
      const originalStat = nativeFileHandleStat;
      let statCalls = 0;
      let injectedMtimeMs: number | undefined;
      const stat = vi
        .spyOn(fileHandlePrototype, 'stat')
        .mockImplementation(async function (this: fs.FileHandle, ...args) {
          statCalls++;
          if (statCalls === 2) {
            await fs.utimes(
              fixture.transcriptPath,
              initial.atime,
              new Date(initial.mtimeMs + 1000),
            );
            injectedMtimeMs = (await fs.stat(fixture.transcriptPath)).mtimeMs;
          }
          return originalStat.apply(this, args);
        });

      try {
        await expect(
          lease.appendJsonLine({ afterMetadataRace: true }),
        ).resolves.toBeUndefined();
        expect(injectedMtimeMs).not.toBe(initial.mtimeMs);
        await expect(fs.readFile(fixture.transcriptPath, 'utf8')).resolves.toBe(
          '{"seed":true}\n{"afterMetadataRace":true}\n',
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
    const originalStat = nativeFileHandleStat;
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
    const originalStat = nativeFileHandleStat;
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
    const originalRead = nativeFileHandleRead;
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
      const originalStat = nativeFileHandleStat;
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
