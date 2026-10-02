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
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import type { Mode, PathLike, Stats } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Config, type ConfigParameters } from '../config/config.js';
import { Storage } from '../config/storage.js';
import {
  resetDebugLoggingState,
  setDebugLogSession,
} from '../utils/debugLogger.js';
import {
  ChatRecordingService,
  type ChatRecord,
} from './chatRecordingService.js';
import * as processLiveness from '../utils/process-liveness.js';
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

const directorySyncFault = vi.hoisted(() => ({
  path: undefined as string | undefined,
  remainingFailures: 0,
}));

const zeroInodeFault = vi.hoisted(() => ({
  underRoot: undefined as string | undefined,
}));

const pathZeroInodeFault = vi.hoisted(() => ({
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

const descriptorReadHook = vi.hoisted(() => ({
  afterRead: undefined as (() => void) | undefined,
}));

const lockIdentityPrecisionFault = vi.hoisted(() => ({
  path: undefined as string | undefined,
  replaced: false,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readFileSyncWithHook = ((...args: unknown[]) => {
    const result = (actual.readFileSync as (...readArgs: unknown[]) => unknown)(
      ...args,
    );
    if (typeof args[0] === 'number') {
      const afterRead = descriptorReadHook.afterRead;
      descriptorReadHook.afterRead = undefined;
      afterRead?.();
    }
    return result;
  }) as typeof actual.readFileSync;
  const applyLockIdentityFault = (
    result: unknown,
    bigint: boolean,
    replaced: boolean,
  ): unknown => {
    if (typeof result !== 'object' || result === null) return result;
    const base = 9_007_199_254_740_992n;
    Object.defineProperty(result, 'dev', {
      value: bigint ? 1n : 1,
    });
    Object.defineProperty(result, 'ino', {
      value: bigint
        ? base + (replaced ? 1n : 0n)
        : Number(base + (replaced ? 1n : 0n)),
    });
    return result;
  };
  const fstatSyncWithHook = ((...args: unknown[]) => {
    const result = (actual.fstatSync as (...callArgs: unknown[]) => unknown)(
      ...args,
    );
    if (lockIdentityPrecisionFault.path === undefined) return result;
    const bigint =
      typeof args[1] === 'object' &&
      args[1] !== null &&
      (args[1] as { bigint?: boolean }).bigint === true;
    return applyLockIdentityFault(result, bigint, false);
  }) as typeof actual.fstatSync;
  const lstatSyncWithHook = ((...args: unknown[]) => {
    const result = (actual.lstatSync as (...callArgs: unknown[]) => unknown)(
      ...args,
    );
    if (args[0] !== lockIdentityPrecisionFault.path) return result;
    const bigint =
      typeof args[1] === 'object' &&
      args[1] !== null &&
      (args[1] as { bigint?: boolean }).bigint === true;
    return applyLockIdentityFault(
      result,
      bigint,
      lockIdentityPrecisionFault.replaced,
    );
  }) as typeof actual.lstatSync;
  return {
    ...actual,
    fstatSync: fstatSyncWithHook,
    lstatSync: lstatSyncWithHook,
    readFileSync: readFileSyncWithHook,
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (...args: unknown[]) => {
      const filePath = args[0] as Parameters<typeof actual.lstat>[0];
      if (filePath === lstatFault.path) {
        lstatFault.calls++;
        if (lstatFault.remainingFailures > 0) {
          lstatFault.remainingFailures--;
          throw Object.assign(new Error('temporary I/O failure'), {
            code: 'EIO',
          });
        }
      }
      const result = await (
        actual.lstat as (...callArgs: unknown[]) => Promise<unknown>
      )(...args);
      if (filePath !== lockIdentityPrecisionFault.path) return result;
      const bigint =
        typeof args[1] === 'object' &&
        args[1] !== null &&
        (args[1] as { bigint?: boolean }).bigint === true;
      if (typeof result !== 'object' || result === null) return result;
      const base = 9_007_199_254_740_992n;
      Object.defineProperty(result, 'dev', {
        value: bigint ? 1n : 1,
      });
      Object.defineProperty(result, 'ino', {
        value: bigint
          ? base + (lockIdentityPrecisionFault.replaced ? 1n : 0n)
          : Number(base + (lockIdentityPrecisionFault.replaced ? 1n : 0n)),
      });
      return result;
    },
    stat: async (
      filePath: Parameters<typeof actual.stat>[0],
      ...rest: unknown[]
    ) => {
      const result = await (
        actual.stat as (...args: unknown[]) => ReturnType<typeof actual.stat>
      )(filePath, ...rest);
      if (
        typeof filePath === 'string' &&
        ((zeroInodeFault.underRoot !== undefined &&
          filePath.startsWith(zeroInodeFault.underRoot)) ||
          (pathZeroInodeFault.underRoot !== undefined &&
            filePath.startsWith(pathZeroInodeFault.underRoot)))
      ) {
        Object.defineProperty(result, 'ino', { value: 0 });
      }
      return result;
    },
    open: async (filePath: PathLike, flags: string | number, mode?: Mode) => {
      await fsOpenTestHook.beforeOpen?.(filePath, flags);
      const handle = await actual.open(filePath, flags, mode);
      if (
        zeroInodeFault.underRoot !== undefined &&
        typeof filePath === 'string' &&
        filePath.startsWith(zeroInodeFault.underRoot)
      ) {
        const handleStat = handle.stat.bind(handle);
        handle.stat = (async (...args) => {
          const result = await handleStat(...args);
          Object.defineProperty(result, 'ino', { value: 0 });
          return result;
        }) as typeof handle.stat;
      }
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        if (
          filePath === directorySyncFault.path &&
          directorySyncFault.remainingFailures > 0
        ) {
          directorySyncFault.remainingFailures--;
          throw Object.assign(new Error('directory sync failure'), {
            code: 'EIO',
          });
        }
        await sync();
      };
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
 * Inode timestamps use the kernel's coarse clock (4ms on the Linux CI
 * kernels), so a *same-value* chmod/chown often changes nothing observable and
 * the injected condition never happens; repeat `op` until the drift shows.
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

async function createFixture(sessionId = 'test-session') {
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
    lockPath: getSessionWriterLockPath(runtimeBaseDir, sessionId),
    options: { runtimeBaseDir, sessionId, transcriptPath },
  };
}

type Fixture = Awaited<ReturnType<typeof createFixture>>;

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
  // Windows recycles PIDs aggressively: a signal-0 answer almost always means
  // a reused PID, not a leaked child, so do not fail teardown over it.
  console.warn(`Process ${pid} remained live after close`);
}

async function childOk(
  child: ChildProcess,
  command: SessionWriterLeaseTestCommandInput,
): Promise<SessionWriterLeaseTestResponse> {
  const response = await requestChild(child, command);
  expect(response).toMatchObject({ ok: true });
  return response;
}

/** Acquires in a helper process, then SIGKILLs it, orphaning its lock. */
async function crashedOwner(fixture: Fixture) {
  const owner = startLeaseProcess();
  const acquired = await childOk(owner, {
    type: 'acquire',
    options: fixture.options,
  });
  owner.kill('SIGKILL');
  await waitForClose(owner);
  return acquired;
}

/** Races two helper processes for `options`: exactly one wins, then releases. */
async function expectOneWinner(options: AcquireSessionWriterLeaseOptions) {
  const contenders = [startLeaseProcess(), startLeaseProcess()];
  const results = await Promise.all(
    contenders.map((child) =>
      requestChild(child, { type: 'acquire', options }),
    ),
  );
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  const winner = contenders[results.findIndex((result) => result.ok)]!;
  await childOk(winner, { type: 'release' });
}

// Orphans a real lock via `crashedOwner` and rewrites its record through
// `mutate`, so Linux cases can craft missing or foreign boot/namespace IDs.
async function deadOwnerRecord(
  mutate?: (record: Record<string, unknown>) => void,
): Promise<Fixture> {
  const fixture = await createFixture();
  await crashedOwner(fixture);
  const record = await readJson(fixture.lockPath);
  mutate?.(record);
  await fs.writeFile(fixture.lockPath, JSON.stringify(record));
  return fixture;
}

function record(
  fixture: Fixture,
  uuid: string,
  parentUuid: string | null,
  type: 'user' | 'assistant',
  text: string,
): ChatRecord {
  return {
    uuid,
    parentUuid,
    sessionId: fixture.options.sessionId,
    timestamp: '2026-01-01T00:00:00.000Z',
    type,
    cwd: fixture.projectRoot,
    version: 'test',
    message: {
      role: type === 'user' ? 'user' : 'model',
      parts: [{ text }],
    },
  };
}

const SEED = '{"seed":true}\n';
const TAIL = '{"record":"tail"}\n';
const itPosix = it.runIf(process.platform !== 'win32');
const itLinux = it.runIf(process.platform === 'linux');

const rejectsAs =
  (ErrorType: new (...args: never[]) => Error) => (promise: Promise<unknown>) =>
    expect(promise).rejects.toBeInstanceOf(ErrorType);
const expectLost = rejectsAs(SessionWriterLostError);
const expectChanged = rejectsAs(SessionTranscriptChangedError);
const expectUnavailable = rejectsAs(SessionWriterUnavailableError);
const expectConflict = rejectsAs(SessionWriterConflictError);
const expectIdentityUnavailable = rejectsAs(
  SessionTranscriptIdentityUnavailableError,
);
const expectOk = (promise: Promise<unknown>) =>
  expect(promise).resolves.toBeUndefined();
const enoent = (promise: Promise<unknown>) =>
  expect(promise).rejects.toMatchObject({ code: 'ENOENT' });
const expectFile = (filePath: string, text: string) =>
  expect(fs.readFile(filePath, 'utf8')).resolves.toBe(text);

async function readJson<T = Record<string, unknown>>(filePath: string) {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

async function writeTranscript(fixture: Fixture, data: string | Buffer) {
  await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
  await fs.writeFile(fixture.transcriptPath, data);
}

const acquire = (options: AcquireSessionWriterLeaseOptions) =>
  SessionWriterLease.acquire(options);
const ownedPath = (lockPath: string, kind: string, ownerId: string) =>
  `${lockPath}.${kind}.${encodeURIComponent(ownerId)}`;

/** Creates a fixture, seeds its transcript when given, and acquires. */
async function leaseFor(sessionId?: string, transcript?: string | Buffer) {
  const fixture = await createFixture(sessionId);
  if (transcript !== undefined) await writeTranscript(fixture, transcript);
  const lease = await acquire(fixture.options);
  return { fixture, lease, lockPath: fixture.lockPath };
}
const seededLease = () => leaseFor(undefined, SEED);

/** `leaseFor`, then seals the lease for a certified handoff. */
async function sealedLease(sessionId: string, transcript?: string) {
  const sealed = await leaseFor(sessionId, transcript);
  await sealed.lease.sealForHandoff();
  return sealed;
}

// A directory at the transcript path fails activation and one at the retired
// lock path fails its cleanup; returns the lease handed to the hook + errors.
async function acquireWithBlockedRelease(fixture: Fixture) {
  await fs.mkdir(fixture.transcriptPath, { recursive: true });
  let recoveryLease: SessionWriterLease | undefined;
  let retiredPath: string | undefined;
  const failure = await acquire({
    ...fixture.options,
    onOwnershipAcquired: (lease) => {
      recoveryLease = lease;
      retiredPath = ownedPath(fixture.lockPath, 'released', lease.ownerId);
      mkdirSync(retiredPath);
    },
  }).catch((error: unknown) => error);
  expect(failure).toMatchObject({
    name: 'SessionWriterUnavailableError',
    cause: expect.any(AggregateError),
  });
  expect(recoveryLease).toBeDefined();
  await expect(fs.readFile(fixture.lockPath, 'utf8')).resolves.toContain(
    fixture.options.sessionId,
  );
  return {
    errors: (failure as Error & { cause: AggregateError }).cause.errors,
    recoveryLease: recoveryLease!,
    retiredPath: retiredPath!,
  };
}

const certified = (fixture: Fixture): AcquireSessionWriterLeaseOptions => ({
  ...fixture.options,
  reclaimPolicy: 'never',
  takeoverPolicy: 'certified',
});

const jsonl = (...records: ChatRecord[]) =>
  records.map((entry) => `${JSON.stringify(entry)}\n`).join('');

async function readRecords(filePath: string): Promise<ChatRecord[]> {
  return (await fs.readFile(filePath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as ChatRecord);
}

const sessionServiceFor = (fixture: Fixture) =>
  new SessionService(fixture.projectRoot, {
    runtimeBaseDir: fixture.runtimeBaseDir,
  });

/** A real ACP-mode Config over the fixture with the writer lease enabled. */
function createConfig(fixture: Fixture, extra: Partial<ConfigParameters> = {}) {
  return Storage.runWithRuntimeBaseDir(
    fixture.runtimeBaseDir,
    fixture.projectRoot,
    () =>
      new Config({
        sessionId: fixture.options.sessionId,
        ...extra,
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
}

const initializeConfig = (config: Config) =>
  config.initialize({
    skipLlmInitialization: true,
    skipHooks: true,
    skipMcpDiscovery: true,
    skipSkillManager: true,
    skipFileCheckpointing: true,
    lenientToolWarmup: true,
  });

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

/** Moves the mtime `ms` ahead to force a content rescan; returns prior stat. */
async function bumpMtime(filePath: string, ms: number) {
  const initial = await fs.stat(filePath);
  await shiftMtime(filePath, initial, ms);
  return initial;
}

const shiftMtime = (filePath: string, from: Stats, ms: number) =>
  fs.utimes(filePath, from.atime, new Date(from.mtimeMs + ms));

/** Wraps FileHandle#read; `after` sees each call's args once it resolves. */
const afterHandleRead = (after: (args: readonly unknown[]) => unknown) =>
  vi.spyOn(fileHandlePrototype, 'read').mockImplementation(async function (
    this: fs.FileHandle,
    ...args
  ) {
    const result = await nativeFileHandleRead.apply(this, args);
    await after(args);
    return result;
  });

/** Wraps FileHandle#stat; `after` may inspect or patch each native result. */
const afterHandleStat = (
  after: (result: Awaited<ReturnType<fs.FileHandle['stat']>>) => unknown,
) =>
  vi.spyOn(fileHandlePrototype, 'stat').mockImplementation(async function (
    this: fs.FileHandle,
    ...args
  ) {
    const result = await nativeFileHandleStat.apply(this, args);
    await after(result);
    return result;
  });

// Runs `inject` once, after the first full-content transcript read; the
// ownership check must then reject. `cleanup` replaces the final release.
async function expectContentReadRace(
  lease: SessionWriterLease,
  inject: () => Promise<unknown>,
  expectRejection = expectChanged,
  cleanup = () => lease.release(),
) {
  let injected = false;
  const read = afterHandleRead(async (args) => {
    if ((positionalReadLength(args) ?? 0) > 1 && !injected) {
      injected = true;
      await inject();
    }
  });

  try {
    await expectRejection(lease.assertOwnedAndUnchanged());
    expect(injected).toBe(true);
  } finally {
    read.mockRestore();
    await cleanup();
  }
}

// Mutates the seeded transcript inside the first handle stat but returns the
// pre-mutation stat, so the handle and path views disagree.
async function expectHandleStatRace(
  mutate: (transcriptPath: string, initial: Stats) => void,
) {
  const { fixture, lease } = await seededLease();
  const initial = await fs.stat(fixture.transcriptPath);
  let injected = false;
  const stat = vi
    .spyOn(fileHandlePrototype, 'stat')
    .mockImplementation(async function (this: fs.FileHandle, ...args) {
      if (!injected) {
        injected = true;
        mutate(fixture.transcriptPath, initial);
        return initial;
      }
      return nativeFileHandleStat.apply(this, args);
    });

  await restoreAfter(stat, lease, async () => {
    await expectChanged(lease.assertOwnedAndUnchanged());
    expect(injected).toBe(true);
  });
}

// Swaps the seeded transcript for a symlink at the first open `matches`
// accepts; `operate` must report the change and the open must not follow it.
async function expectSymlinkOpenRace(
  matches: (flags: number | undefined) => boolean,
  operate: (lease: SessionWriterLease) => Promise<unknown>,
) {
  const { fixture, lease } = await seededLease();
  const originalPath = `${fixture.transcriptPath}.original`;
  let replaced = false;
  let openFlags: number | undefined;
  fsOpenTestHook.beforeOpen = async (filePath, flags) => {
    const numericFlags = typeof flags === 'number' ? flags : undefined;
    if (
      !replaced &&
      filePath === fixture.transcriptPath &&
      matches(numericFlags)
    ) {
      replaced = true;
      openFlags = numericFlags;
      await fs.rename(fixture.transcriptPath, originalPath);
      await fs.symlink(originalPath, fixture.transcriptPath);
    }
  };

  try {
    await expectChanged(operate(lease));
    expect(replaced).toBe(true);
    expect(openFlags! & fsConstants.O_NOFOLLOW).not.toBe(0);
    expect(openFlags! & fsConstants.O_NONBLOCK).not.toBe(0);
  } finally {
    fsOpenTestHook.beforeOpen = undefined;
    await fs.unlink(fixture.transcriptPath);
    await fs.rename(originalPath, fixture.transcriptPath);
    await lease.release();
  }
}

/** Runs `check`, then always restores `spy` and releases `lease` if given. */
async function restoreAfter(
  spy: { mockRestore(): void },
  lease: SessionWriterLease | undefined,
  check: () => Promise<void>,
) {
  try {
    await check();
  } finally {
    spy.mockRestore();
    await lease?.release();
  }
}

function failLstat(filePath: string, failures: number) {
  lstatFault.path = filePath;
  lstatFault.remainingFailures = failures;
}

function onRename(
  renameFrom: string,
  renameTo: string | undefined,
  afterRename: () => Promise<void>,
) {
  Object.assign(transitionFault, { renameFrom, renameTo, afterRename });
}

function onLink(
  linkFrom: string,
  linkTo: string,
  fault: Pick<typeof transitionFault, 'afterLink'> | { throwAfterLink: true },
) {
  Object.assign(transitionFault, { linkFrom, linkTo, ...fault });
}

/** Makes the claim's install (link) or removal (unlink) fail after effect. */
function failClaimAfterEffect(lockPath: string, operation: 'link' | 'unlink') {
  if (operation === 'unlink') {
    unlinkFault.path = `${lockPath}.claim`;
    unlinkFault.throwAfterUnlink = true;
    return;
  }
  claimInstallFault.path = `${lockPath}.claim`;
  claimInstallFault.afterInstall = () => {
    throw Object.assign(new Error('injected error after claim link'), {
      code: 'EIO',
    });
  };
}

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

// Pristine copies of the hoisted fault hooks, restored after every test.
const faultHooks = [
  lstatFault,
  directorySyncFault,
  zeroInodeFault,
  pathZeroInodeFault,
  fsOpenTestHook,
  transitionFault,
  restoreLinkFault,
  unlinkFault,
  writeFault,
  claimInstallFault,
  readFileFault,
  descriptorReadHook,
  lockIdentityPrecisionFault,
].map((hook) => [hook, { ...hook }] as const);

afterEach(async () => {
  vi.restoreAllMocks();
  fileHandlePrototype.read = nativeFileHandleRead;
  fileHandlePrototype.stat = nativeFileHandleStat;
  for (const [hook, pristine] of faultHooks) Object.assign(hook, pristine);
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
    const firstUser = record(fixture, 'user-1', null, 'user', 'start');
    const previewTail = record(
      fixture,
      'tool-tail',
      firstUser.uuid,
      'assistant',
      'tool result',
    );
    await writeTranscript(fixture, jsonl(firstUser, previewTail));
    const sessionService = sessionServiceFor(fixture);
    const stalePreview = await sessionService.loadSession(
      fixture.options.sessionId,
    );
    expect(stalePreview?.lastCompletedUuid).toBe(previewTail.uuid);

    const physicalFinal = record(
      fixture,
      'physical-final',
      previewTail.uuid,
      'assistant',
      'final answer',
    );
    await fs.writeFile(
      fixture.transcriptPath,
      jsonl(firstUser, previewTail, physicalFinal),
      'utf8',
    );
    const config = createConfig(fixture, { sessionData: stalePreview });

    await initializeConfig(config);
    expect(config.getResumedSessionData()?.lastCompletedUuid).toBe(
      physicalFinal.uuid,
    );
    const recorder = config.getChatRecordingService();
    expect(recorder).toBeDefined();
    recorder?.recordUserMessage('next');
    await recorder?.flush();

    const written = await readRecords(fixture.transcriptPath);
    expect(written.at(-1)).toMatchObject({
      type: 'user',
      parentUuid: physicalFinal.uuid,
      message: { parts: [{ text: 'next' }] },
    });

    await config.shutdown({ shutdownTelemetry: false });
    expect(config.hasSessionWriteOwnership()).toBe(false);
    await enoent(fs.lstat(fixture.lockPath));
  });

  it('hands a real managed ACP Config to a certified replacement', async () => {
    const fixture = await createFixture('managed-config-handoff-session');
    const first = createConfig(fixture);
    first.setSessionWriterReclaimPolicy('never');
    first.setSessionWriterTakeoverPolicy('certified');
    await initializeConfig(first);
    first.getChatRecordingService()?.recordUserMessage('handoff tail');
    await first.closeSessionWriter({ handoff: true });
    expect(await readJson(fixture.lockPath)).toMatchObject({
      schema_version: 2,
      state: 'sealed',
    });

    const replacement = createConfig(fixture);
    replacement.setSessionWriterReclaimPolicy('never');
    replacement.setSessionWriterTakeoverPolicy('certified');
    await initializeConfig(replacement);
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
    const firstUser = record(fixture, 'user-1', null, 'user', 'start');
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
    await writeTranscript(fixture, jsonl(firstUser, titleRecord, rewindRecord));
    const sessionService = sessionServiceFor(fixture);
    const preview = await sessionService.loadSession(fixture.options.sessionId);
    expect(
      preview?.conversation.messages.some(
        (message) => message.subtype === 'custom_title',
      ),
    ).toBe(false);
    expect(
      sessionService.getSessionTitleInfo(fixture.options.sessionId),
    ).toEqual({ title: 'operator-title', source: 'manual' });

    const config = createConfig(fixture, { sessionData: preview });

    await initializeConfig(config);
    const recorder = config.getChatRecordingService();
    expect(recorder?.getCurrentCustomTitle()).toBe('operator-title');
    recorder?.recordUserMessage('after rewind');
    await recorder?.flush();

    const physicalRecords = await readRecords(fixture.transcriptPath);
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
    await writeTranscript(fixture, '{"truncated":true}');
    const config = createConfig(fixture);

    await expectChanged(config.initialize());
    expect(config.hasSessionWriteOwnership()).toBe(false);
    await enoent(fs.lstat(fixture.lockPath));
  });

  it('keeps failed acquisition cleanup terminal without retrying the primary lock', async () => {
    const fixture = await createFixture();
    const { errors, recoveryLease, retiredPath } =
      await acquireWithBlockedRelease(fixture);
    expect(errors).toHaveLength(2);

    const firstRetry = recoveryLease.release();
    const secondRetry = recoveryLease.release();
    expect(secondRetry).toBe(firstRetry);
    await expect(firstRetry).rejects.toBe(errors[1]);
    await fs.rmdir(retiredPath);
    await fs.unlink(fixture.lockPath);
  });

  it('does not retry failed cleanup after reclaiming a stale lock', async () => {
    const fixture = await createFixture();
    await crashedOwner(fixture);
    const { errors, recoveryLease, retiredPath } =
      await acquireWithBlockedRelease(fixture);

    await expect(recoveryLease.release()).rejects.toBe(errors[1]);
    await fs.rmdir(retiredPath);
    await fs.unlink(fixture.lockPath);
  });

  itLinux('uses a clock-independent Linux process identity', async () => {
    const { lease, lockPath } = await leaseFor();
    const lockRecord = await readJson<{ process_start_identity?: string }>(
      lockPath,
    );
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
  });

  itLinux('records the PID namespace identity on Linux', async () => {
    const { lease, lockPath } = await leaseFor();
    const lockRecord = await readJson<{ pid_namespace_id?: number }>(lockPath);
    expect(lockRecord.pid_namespace_id).toBe(
      processLiveness.readPidNamespaceId(),
    );
    await lease.release();
  });

  itLinux(
    'reclaims a dead writer only inside the same Linux identity domain',
    async () => {
      const reclaimable = await deadOwnerRecord();
      const reclaimed = await acquire(reclaimable.options);
      await reclaimed.release();

      const missingNamespace = await deadOwnerRecord((record) => {
        delete record['pid_namespace_id'];
      });
      await expectConflict(acquire(missingNamespace.options));

      const foreignNamespace = await deadOwnerRecord((record) => {
        record['pid_namespace_id'] = (record['pid_namespace_id'] as number) + 1;
      });
      await expectConflict(acquire(foreignNamespace.options));

      const foreignBoot = await deadOwnerRecord((record) => {
        record['process_start_identity'] =
          'linux:00000000-0000-0000-0000-000000000000:1';
      });
      await expectConflict(acquire(foreignBoot.options));
    },
  );

  itLinux.each([
    ['an unparseable identity', () => 'linux:zz'],
    [
      'an identity truncated before the start ticks',
      () => `linux:${processLiveness.readLocalBootId()}`,
    ],
    [
      'a darwin identity read by a Linux reader',
      () => 'darwin:Tue Sep 1 00:00:00 2026',
    ],
    [
      'a win32 identity read by a Linux reader',
      () => 'win32:638000000000000000',
    ],
  ])('fences a dead writer carrying %s', async (_label, identity) => {
    const fenced = await deadOwnerRecord((record) => {
      record['process_start_identity'] = identity();
    });
    await expectConflict(acquire(fenced.options));
  });

  itLinux(
    'fences a dead writer when the local identity domain is indeterminate',
    async () => {
      const bootFenced = await deadOwnerRecord();
      vi.spyOn(processLiveness, 'readLocalBootId').mockReturnValue(null);
      await expectConflict(acquire(bootFenced.options));
      vi.restoreAllMocks();

      const namespaceFenced = await deadOwnerRecord();
      vi.spyOn(processLiveness, 'readPidNamespaceId').mockReturnValue(null);
      await expectConflict(acquire(namespaceFenced.options));
    },
  );

  it.runIf(process.platform === 'darwin')(
    'does not reclaim a live Darwin owner across different time zones',
    async () => {
      const { options } = await createFixture();
      const owner = startLeaseProcess({ TZ: 'Pacific/Honolulu' });
      const contender = startLeaseProcess({ TZ: 'Asia/Shanghai' });
      await childOk(owner, { type: 'acquire', options });

      expect(
        await requestChild(contender, { type: 'acquire', options }),
      ).toMatchObject({ ok: false, errorKind: 'session_writer_conflict' });
      await childOk(owner, { type: 'release' });
    },
  );

  it('rejects a second process and reclaims its lock after SIGKILL', async () => {
    const fixture = await createFixture();
    const child = startLeaseProcess();
    await childOk(child, { type: 'acquire', options: fixture.options });

    await expectConflict(acquire(fixture.options));

    child.kill('SIGKILL');
    await waitForClose(child);
    const replacement = await acquire(fixture.options);
    await replacement.release();
  });

  it('fails closed when process liveness cannot be determined', async () => {
    const { fixture, lease, lockPath } = await leaseFor();
    const lockRecord = await fs.readFile(lockPath, 'utf8');
    await lease.release();
    await fs.writeFile(lockPath, lockRecord);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('probe unavailable'), { code: 'EIO' });
    });

    try {
      await expectConflict(acquire(fixture.options));
    } finally {
      killSpy.mockRestore();
      await fs.unlink(lockPath).catch(() => {});
    }
  });

  it('detects external transcript and lock changes', async () => {
    const { fixture, lease, lockPath } = await seededLease();

    await fs.appendFile(fixture.transcriptPath, '{"external":true}\n');
    expect(() => lease.assertCleanupOwned()).not.toThrow();
    await expectChanged(lease.assertOwnedAndUnchanged());

    await fs.unlink(lockPath);
    await fs.writeFile(lockPath, '{"replacement":true}');
    expect(() => lease.assertCleanupOwned()).toThrow(SessionWriterLostError);
    await expectLost(lease.assertOwnedAndUnchanged());
    await expectLost(lease.release());
    await expectFile(lockPath, '{"replacement":true}');
  });

  itPosix(
    'rejects a byte-identical atomic replacement during cleanup',
    async () => {
      const { lease, lockPath } = await leaseFor();
      const replacementPath = `${lockPath}.replacement`;
      const lockRecord = await fs.readFile(lockPath, 'utf8');
      await fs.writeFile(replacementPath, lockRecord);
      await fs.rename(replacementPath, lockPath);

      expect(() => lease.assertCleanupOwned()).toThrow(SessionWriterLostError);
      await expectLost(lease.release());
    },
  );

  itPosix(
    'rejects a byte-identical replacement during an asynchronous ownership read',
    async () => {
      const { lease, lockPath } = await leaseFor();
      const replacementPath = `${lockPath}.replacement`;
      await fs.writeFile(replacementPath, await fs.readFile(lockPath, 'utf8'));
      readFileFault.path = lockPath;
      readFileFault.triggerCall = 1;
      readFileFault.afterRead = () => fs.rename(replacementPath, lockPath);

      await expectLost(lease.assertOwnedAndUnchanged());
      await expectLost(lease.release());
    },
  );

  it('compares lock identities without losing large inode precision', async () => {
    const fixture = await createFixture();
    const { lockPath } = fixture;
    lockIdentityPrecisionFault.path = lockPath;
    const lease = await acquire(fixture.options);
    lockIdentityPrecisionFault.replaced = true;

    expect(() => lease.assertCleanupOwned()).toThrow(SessionWriterLostError);
    await expectLost(lease.release());
  });

  itPosix(
    'rejects a lock replaced while cleanup ownership is being verified',
    async () => {
      const { lease, lockPath } = await leaseFor();
      const replacementPath = `${lockPath}.replacement`;
      writeFileSync(replacementPath, readFileSync(lockPath));
      descriptorReadHook.afterRead = () => {
        renameSync(replacementPath, lockPath);
      };

      expect(() => lease.assertCleanupOwned()).toThrow(SessionWriterLostError);
      await expectLost(lease.release());
    },
  );

  itPosix(
    'rejects a byte-identical atomic replacement during acquisition',
    async () => {
      const fixture = await createFixture();
      const { lockPath } = fixture;
      const replacementPath = `${lockPath}.replacement`;

      await expectUnavailable(
        acquire({
          ...fixture.options,
          onOwnershipAcquired: () => {
            writeFileSync(replacementPath, readFileSync(lockPath));
            renameSync(replacementPath, lockPath);
          },
        }),
      );
      await fs.unlink(lockPath);
    },
  );

  itPosix('rejects a symlinked cleanup lock', async () => {
    const { lease, lockPath } = await leaseFor();
    const targetPath = `${lockPath}.replacement`;
    const lockRecord = await fs.readFile(lockPath, 'utf8');
    await fs.writeFile(targetPath, lockRecord);
    await fs.unlink(lockPath);
    await fs.symlink(targetPath, lockPath);

    expect(() => lease.assertCleanupOwned()).toThrow(SessionWriterLostError);
    await expectLost(lease.release());
    await fs.unlink(lockPath);
    await fs.unlink(targetPath);
  });

  itPosix('classifies an unreadable owned lock as unavailable', async () => {
    const { lease, lockPath } = await leaseFor();
    await fs.chmod(lockPath, 0o000);

    try {
      await expectUnavailable(lease.assertOwnedAndUnchanged());
    } finally {
      await fs.chmod(lockPath, 0o600);
      await lease.release();
    }
  });

  it('fails closed on a malformed lock', async () => {
    const fixture = await createFixture();
    const { lockPath } = fixture;
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    await fs.writeFile(lockPath, 'not-json');

    await expectUnavailable(acquire(fixture.options));
  });

  it('logs acquisition diagnostics without changing the public error', async () => {
    const fixture = await createFixture('diagnostic-session');
    const { lockPath } = fixture;
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
        await acquire(fixture.options);
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
        expect(log).toContain('it does not prove that a writer is still alive');
        expect(log).toContain('docs/users/conversations-recovery.md');
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
    const { lockPath } = fixture;
    await fs.mkdir(lockPath, { recursive: true });

    await expectUnavailable(acquire(fixture.options));
  });

  it('fails closed on a truncated transcript tail', async () => {
    const fixture = await createFixture();
    await writeTranscript(fixture, '{"complete":true}\n{"partial":');

    await expectChanged(acquire(fixture.options));
    await enoent(fs.access(fixture.lockPath));
  });

  it('rejects a dangling transcript symlink introduced before sealing', async () => {
    const { fixture, lease, lockPath } = await leaseFor(
      'dangling-seal-session',
    );
    const activeRaw = await fs.readFile(lockPath, 'utf8');
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.symlink(
      `${fixture.transcriptPath}.missing`,
      fixture.transcriptPath,
    );

    await expectUnavailable(lease.sealForHandoff());
    await expectFile(lockPath, activeRaw);
    await enoent(fs.lstat(`${lockPath}.claim`));
  });

  it('rejects a dangling transcript symlink before certified takeover', async () => {
    const { fixture, lease, lockPath } = await leaseFor(
      'dangling-takeover-session',
    );
    await lease.sealForHandoff();
    const sealedRaw = await fs.readFile(lockPath, 'utf8');
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    await fs.symlink(
      `${fixture.transcriptPath}.missing`,
      fixture.transcriptPath,
    );

    await expectUnavailable(acquire(certified(fixture)));
    await expectFile(lockPath, sealedRaw);
    await enoent(fs.lstat(`${lockPath}.claim`));
  });

  it('detects an equal-length atomic transcript replacement', async () => {
    const { fixture, lease } = await leaseFor(undefined, '{"a":1}\n');
    const replacement = `${fixture.transcriptPath}.replacement`;
    await fs.writeFile(replacement, '{"b":2}\n');
    await fs.rename(replacement, fixture.transcriptPath);

    await expectChanged(lease.assertOwnedAndUnchanged());
    await lease.release();
  });

  itPosix(
    'reconciles timestamp-only metadata changes before appending',
    async () => {
      const { fixture, lease } = await seededLease();
      const initial = await fs.stat(fixture.transcriptPath);

      const afterChmod = await withObservedTimestampDrift(
        fixture.transcriptPath,
        () => fs.chmod(fixture.transcriptPath, initial.mode),
      );
      expect(afterChmod.ctimeMs).not.toBe(initial.ctimeMs);
      await expectOk(lease.assertOwnedAndUnchanged());

      await fs.utimes(
        fixture.transcriptPath,
        afterChmod.atime,
        afterChmod.mtime,
      );
      await expectOk(lease.assertOwnedAndUnchanged());
      await expectOk(lease.appendJsonLine({ afterMetadataChange: true }));
      await expectFile(
        fixture.transcriptPath,
        '{"seed":true}\n{"afterMetadataChange":true}\n',
      );
      await lease.release();
    },
  );

  itLinux('reconciles a same-owner chown', async () => {
    const { fixture, lease } = await seededLease();
    const initial = await fs.stat(fixture.transcriptPath);

    const afterChown = await withObservedTimestampDrift(
      fixture.transcriptPath,
      () => fs.chown(fixture.transcriptPath, initial.uid, initial.gid),
    );
    expect(afterChown.ctimeMs).not.toBe(initial.ctimeMs);
    await expectOk(lease.assertOwnedAndUnchanged());
    await lease.release();
  });

  it('detects an equal-length in-place overwrite with restored mtime', async () => {
    const fixture = await createFixture();
    const anchoredTime = new Date('2024-01-02T03:04:05.000Z');
    await writeTranscript(fixture, SEED);
    await fs.utimes(fixture.transcriptPath, anchoredTime, anchoredTime);
    const lease = await acquire(fixture.options);

    await withObservedTimestampDrift(fixture.transcriptPath, async () => {
      await fs.writeFile(fixture.transcriptPath, '{"sEEd":true}\n');
      await fs.utimes(fixture.transcriptPath, anchoredTime, anchoredTime);
    });
    await expectChanged(lease.assertOwnedAndUnchanged());
    await lease.release();
  });

  itPosix('rejects actual permission and hard-link changes', async () => {
    const { fixture, lease } = await seededLease();
    const initial = await fs.stat(fixture.transcriptPath);

    await fs.chmod(fixture.transcriptPath, initial.mode ^ 0o040);
    await expectChanged(lease.assertOwnedAndUnchanged());
    await fs.chmod(fixture.transcriptPath, initial.mode);
    await lease.release();

    const linkLease = await acquire(fixture.options);
    const linkPath = `${fixture.transcriptPath}.link`;
    await fs.link(fixture.transcriptPath, linkPath);
    await expectChanged(linkLease.assertOwnedAndUnchanged());
    await fs.unlink(linkPath);
    await linkLease.release();
  });

  it.runIf(process.getuid?.() === 0)(
    'rejects an actual owner change',
    async () => {
      const { fixture, lease } = await seededLease();
      const initial = await fs.stat(fixture.transcriptPath);
      const changedUid = initial.uid === 0 ? 1 : 0;

      try {
        await fs.chown(fixture.transcriptPath, changedUid, initial.gid);
        await expectChanged(lease.assertOwnedAndUnchanged());
      } finally {
        await fs.chown(fixture.transcriptPath, initial.uid, initial.gid);
        await lease.release();
      }
    },
  );

  itPosix(
    'classifies an unreadable transcript symlink replacement as changed',
    async () => {
      const { fixture, lease } = await seededLease();
      const originalPath = `${fixture.transcriptPath}.original`;
      const initialMode = (await fs.stat(fixture.transcriptPath)).mode;
      await fs.rename(fixture.transcriptPath, originalPath);
      await fs.chmod(originalPath, 0);
      await fs.symlink(originalPath, fixture.transcriptPath);

      try {
        await expectChanged(lease.assertOwnedAndUnchanged());
      } finally {
        await fs.unlink(fixture.transcriptPath);
        await fs.chmod(originalPath, initialMode);
        await fs.rename(originalPath, fixture.transcriptPath);
        await lease.release();
      }
    },
  );

  itPosix(
    'does not follow a symlink installed between transcript inspection and open',
    () =>
      expectSymlinkOpenRace(
        () => true,
        (lease) => lease.assertOwnedAndUnchanged(),
      ),
  );

  itPosix(
    'does not follow a symlink installed between transcript inspection and append open',
    () =>
      expectSymlinkOpenRace(
        (flags) => flags !== undefined && (flags & fsConstants.O_APPEND) !== 0,
        (lease) => lease.appendJsonLine({ appended: true }),
      ),
  );

  itPosix(
    'classifies a transcript FIFO replacement as changed without a peer',
    async () => {
      const { fixture, lease } = await seededLease();
      const originalPath = `${fixture.transcriptPath}.original`;
      await fs.rename(fixture.transcriptPath, originalPath);
      execFileSync('mkfifo', [fixture.transcriptPath]);

      try {
        await expectChanged(lease.assertOwnedAndUnchanged());
      } finally {
        await fs.unlink(fixture.transcriptPath);
        await fs.rename(originalPath, fixture.transcriptPath);
        await lease.release();
      }
    },
  );

  it('classifies transcript deletion as changed', async () => {
    const { fixture, lease } = await seededLease();
    await fs.unlink(fixture.transcriptPath);

    await expectChanged(lease.assertOwnedAndUnchanged());
    await lease.release();
  });

  it('rejects a new session up front when the filesystem cannot number inodes', async () => {
    const fixture = await createFixture();
    // Brand-new session: the transcript file does not exist yet, so the
    // probe stands in for it with the nearest existing ancestor directory.
    await fs.mkdir(path.dirname(fixture.transcriptPath), { recursive: true });
    zeroInodeFault.underRoot = fixture.runtimeBaseDir;

    await expectIdentityUnavailable(acquire(fixture.options));
    await enoent(fs.access(fixture.transcriptPath));
  });

  it('acquires normally when the transcript directory does not exist yet', async () => {
    const { fixture, lease } = await leaseFor();
    await lease.appendJsonLine({ hello: 'world' });
    await lease.release();

    await expectFile(fixture.transcriptPath, '{"hello":"world"}\n');
  });

  it('rejects a transcript with an unverifiable inode before writing', async () => {
    const fixture = await createFixture();
    await writeTranscript(fixture, SEED);
    zeroInodeFault.underRoot = fixture.runtimeBaseDir;
    const stat = afterHandleStat((result) =>
      Object.defineProperty(result, 'ino', { value: 0 }),
    );

    await restoreAfter(stat, undefined, async () => {
      await expectIdentityUnavailable(acquire(fixture.options));
      await expectFile(fixture.transcriptPath, SEED);
    });
  });

  it('detects a size change between handle and path stat', () =>
    expectHandleStatRace((transcriptPath) =>
      appendFileSync(transcriptPath, '{"external":true}\n'),
    ));

  it('detects an equal-length overwrite between handle and path stat', () =>
    expectHandleStatRace((transcriptPath, initial) => {
      writeFileSync(transcriptPath, '{"sEEd":true}\n');
      utimesSync(
        transcriptPath,
        initial.atime,
        new Date(initial.mtimeMs + 10_000),
      );
    }));

  it('does not rescan the transcript on ordinary appends', async () => {
    const fixture = await createFixture();
    await writeTranscript(fixture, SEED);
    const read = vi.spyOn(fileHandlePrototype, 'read');

    await restoreAfter(read, undefined, async () => {
      const lease = await acquire(fixture.options);
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
    });
  });

  it('continues hashing after a short regular-file read', async () => {
    const transcript = Buffer.alloc(2 * 1024 * 1024, 0x20);
    transcript[transcript.byteLength - 1] = 0x0a;
    const { fixture, lease } = await leaseFor(undefined, transcript);
    await bumpMtime(fixture.transcriptPath, 1000);
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
            nativeFileHandleRead as unknown as (
              buffer: Buffer,
              offset: number,
              length: number,
              position: number,
            ) => Promise<{ bytesRead: number; buffer: Buffer }>
          ).call(this, buffer, offset, Math.floor(length / 2), position);
        }
        return nativeFileHandleRead.apply(this, args);
      });

    await restoreAfter(read, lease, async () => {
      await expectOk(lease.assertOwnedAndUnchanged());
      expect(shortened).toBe(true);
      expect(hashReads).toBe(3);
    });
  });

  it('retries a timestamp change during content verification', async () => {
    const { fixture, lease } = await seededLease();
    const initial = await bumpMtime(fixture.transcriptPath, 500);
    let fullReads = 0;
    const read = afterHandleRead(async (args) => {
      if ((positionalReadLength(args) ?? 0) > 1 && ++fullReads === 1) {
        await shiftMtime(fixture.transcriptPath, initial, 1_000);
      }
    });

    await restoreAfter(read, lease, async () => {
      await expectOk(lease.assertOwnedAndUnchanged());
      expect(fullReads).toBe(2);
    });
  });

  it('resizes the hash buffer when an empty transcript grows between retries', async () => {
    const fixture = await createFixture();
    await writeTranscript(fixture, '');
    const initial = await fs.stat(fixture.transcriptPath);
    let statCalls = 0;
    let lease: SessionWriterLease | undefined;
    const stat = vi
      .spyOn(fileHandlePrototype, 'stat')
      .mockImplementation(async function (this: fs.FileHandle, ...args) {
        const call = ++statCalls;
        if (call === 3) {
          await fs.writeFile(fixture.transcriptPath, SEED);
        }
        const result = await nativeFileHandleStat.apply(this, args);
        if (call === 2) {
          await shiftMtime(fixture.transcriptPath, initial, 1_000);
        }
        return result;
      });

    try {
      lease = await acquire(fixture.options);
      expect(statCalls).toBeGreaterThanOrEqual(4);
      await expectFile(fixture.transcriptPath, SEED);
    } finally {
      stat.mockRestore();
      await lease?.release();
    }
  });

  it('requires a stable scan when an already-read prefix changes', async () => {
    const transcript = Buffer.alloc(2 * 1024 * 1024, 0x20);
    transcript[transcript.byteLength - 1] = 0x0a;
    const { fixture, lease } = await leaseFor(undefined, transcript);
    await bumpMtime(fixture.transcriptPath, 1_000);
    let injected = false;
    let scanStarts = 0;
    const read = afterHandleRead(async (values) => {
      if ((positionalReadLength(values) ?? 0) > 1 && values[3] === 0) {
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
    });

    await restoreAfter(read, lease, async () => {
      await expectChanged(lease.assertOwnedAndUnchanged());
      expect(injected).toBe(true);
      expect(scanStarts).toBe(2);
    });
  });

  it('fails bounded when transcript timestamps never stabilize', async () => {
    const { fixture, lease } = await seededLease();
    const initial = await bumpMtime(fixture.transcriptPath, 500);
    let fullReads = 0;
    const read = afterHandleRead(async (args) => {
      if ((positionalReadLength(args) ?? 0) > 1) {
        fullReads++;
        await shiftMtime(fixture.transcriptPath, initial, fullReads * 1_000);
      }
    });

    await restoreAfter(read, lease, async () => {
      await expectUnavailable(lease.assertOwnedAndUnchanged());
      expect(fullReads).toBe(3);
    });
  });

  it.skipIf(process.platform === 'win32')(
    'detects an atomic replacement during content verification',
    async () => {
      const { fixture, lease } = await seededLease();
      await bumpMtime(fixture.transcriptPath, 1000);
      const replacement = `${fixture.transcriptPath}.replacement`;
      await fs.writeFile(replacement, '{"sEEd":true}\n');
      await expectContentReadRace(lease, () =>
        fs.rename(replacement, fixture.transcriptPath),
      );
    },
  );

  it('detects truncation during content verification', async () => {
    const { fixture, lease } = await seededLease();
    await bumpMtime(fixture.transcriptPath, 1000);
    await expectContentReadRace(lease, () =>
      fs.truncate(fixture.transcriptPath, 0),
    );
  });

  it('detects deletion during content verification', async () => {
    const { fixture, lease } = await seededLease();
    await bumpMtime(fixture.transcriptPath, 1000);
    await expectContentReadRace(lease, () => fs.unlink(fixture.transcriptPath));
  });

  it('detects owner loss during content verification', async () => {
    const { fixture, lease, lockPath } = await seededLease();
    await bumpMtime(fixture.transcriptPath, 1000);
    await expectContentReadRace(
      lease,
      () => fs.writeFile(lockPath, '{"successor":true}\n'),
      expectLost,
      () => fs.unlink(lockPath),
    );
  });

  itPosix(
    'reconciles metadata touched between the barrier and append handle stat',
    async () => {
      const { fixture, lease } = await seededLease();
      const initial = await fs.stat(fixture.transcriptPath);
      let statCalls = 0;
      let injectedMtimeMs: number | undefined;
      const stat = vi
        .spyOn(fileHandlePrototype, 'stat')
        .mockImplementation(async function (this: fs.FileHandle, ...args) {
          statCalls++;
          if (statCalls === 2) {
            await shiftMtime(fixture.transcriptPath, initial, 1000);
            injectedMtimeMs = (await fs.stat(fixture.transcriptPath)).mtimeMs;
          }
          return nativeFileHandleStat.apply(this, args);
        });

      await restoreAfter(stat, lease, async () => {
        await expectOk(lease.appendJsonLine({ afterMetadataRace: true }));
        expect(injectedMtimeMs).not.toBe(initial.mtimeMs);
        await expectFile(
          fixture.transcriptPath,
          '{"seed":true}\n{"afterMetadataRace":true}\n',
        );
      });
    },
  );

  it('does not commit a candidate digest after post-write validation fails', async () => {
    const { fixture, lease } = await seededLease();
    let invalidated = false;
    const stat = afterHandleStat((result) => {
      if (
        !invalidated &&
        typeof result.size === 'number' &&
        result.size > Buffer.byteLength(SEED)
      ) {
        invalidated = true;
        Object.defineProperty(result, 'size', { value: result.size + 1 });
      }
    });

    await restoreAfter(stat, undefined, async () => {
      await expectChanged(lease.appendJsonLine({ rejected: true }));
      expect(invalidated).toBe(true);
    });

    await fs.writeFile(fixture.transcriptPath, SEED);
    await expectOk(lease.assertOwnedAndUnchanged());
    await expectOk(lease.appendJsonLine({ accepted: true }));
    await expectFile(fixture.transcriptPath, `${SEED}{"accepted":true}\n`);
    await lease.release();
  });

  it('detects an equal-length overwrite after the post-write handle stat', async () => {
    const { fixture, lease } = await seededLease();
    let overwritten = false;
    const stat = afterHandleStat((result) => {
      if (!overwritten && result.size > Buffer.byteLength(SEED)) {
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
    });

    await restoreAfter(stat, lease, async () => {
      await expectChanged(lease.appendJsonLine({ afterPostWrite: true }));
      expect(overwritten).toBe(true);
    });
  });

  it('detects an equal-length overwrite during the post-write tail read', async () => {
    const { fixture, lease } = await seededLease();
    let overwritten = false;
    const read = afterHandleRead((args) => {
      if (
        !overwritten &&
        positionalReadLength(args) === 1 &&
        readFileSync(fixture.transcriptPath).byteLength >
          Buffer.byteLength(SEED)
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
    });

    await restoreAfter(read, lease, async () => {
      await expectChanged(lease.appendJsonLine({ afterPostWrite: true }));
      expect(overwritten).toBe(true);
    });
  });

  itPosix(
    'reconciles metadata touched after the post-write handle stat',
    async () => {
      const { fixture, lease } = await seededLease();
      let touched = false;
      const stat = afterHandleStat(async (result) => {
        if (!touched && result.size > Buffer.byteLength(SEED)) {
          touched = true;
          await fs.chmod(fixture.transcriptPath, Number(result.mode));
        }
      });

      await restoreAfter(stat, lease, async () => {
        await expectOk(lease.appendJsonLine({ afterPostWrite: true }));
        expect(touched).toBe(true);
        await expectFile(
          fixture.transcriptPath,
          `${SEED}{"afterPostWrite":true}\n`,
        );
      });
    },
  );

  it('accounts for UTF-8 bytes and releases concurrently without losing ownership', async () => {
    const { fixture, lease } = await leaseFor();
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

  itPosix(
    'creates the transcript directory with owner-only permissions',
    async () => {
      const { fixture, lease } = await leaseFor();

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
      const { lease, lockPath } = await leaseFor();
      const backupPath = `${lockPath}.backup`;
      await fs.rename(lockPath, backupPath);
      await fs.mkdir(lockPath);

      const firstRelease = lease.release();
      const secondRelease = lease.release();
      expect(secondRelease).toBe(firstRelease);
      await expectLost(firstRelease);

      await fs.rmdir(lockPath);
      await fs.rename(backupPath, lockPath);
      await expectLost(lease.release());
      await fs.unlink(lockPath);
    },
  );

  it('retries release when a completed lease still exactly owns the primary lock', async () => {
    const { fixture, lease, lockPath } = await leaseFor();
    const retiredPath = ownedPath(lockPath, 'released', lease.ownerId);
    await fs.mkdir(retiredPath);

    await expectUnavailable(lease.release());
    expect(lease.isReleased).toBe(false);
    await expect(fs.readFile(lockPath, 'utf8')).resolves.toContain(
      fixture.options.sessionId,
    );

    await fs.rmdir(retiredPath);
    await expectOk(lease.release());
    expect(lease.isReleased).toBe(true);
    await enoent(fs.lstat(lockPath));
  });

  it('retries a transient ownership precheck failure before release', async () => {
    const { lease, lockPath } = await leaseFor();
    failLstat(lockPath, 1);

    await expectOk(lease.release());
    expect(lstatFault.calls).toBe(3);
    expect(lease.isReleased).toBe(true);
    lstatFault.path = undefined;
    await enoent(fs.lstat(lockPath));
  });

  it('retries release after ownership checks are temporarily unavailable', async () => {
    const { lease, lockPath } = await leaseFor();
    failLstat(lockPath, 4);

    await expectUnavailable(lease.release());
    await expectOk(lease.release());

    expect(lease.isReleased).toBe(true);
    expect(lstatFault.calls).toBeGreaterThanOrEqual(5);
    await enoent(fs.lstat(lockPath));
  });

  it('retries release durability after the primary lock is removed', async () => {
    const { lease, lockPath } = await leaseFor();
    directorySyncFault.path = path.dirname(lockPath);
    directorySyncFault.remainingFailures = 1;

    await expectUnavailable(lease.release());
    expect(lease.isReleased).toBe(true);
    expect(lease.isReleaseDurabilityPending).toBe(true);
    await enoent(fs.lstat(lockPath));

    await expectOk(lease.release());
    expect(lease.isReleased).toBe(true);
    expect(lease.isReleaseDurabilityPending).toBe(false);
  });

  it('reconciles a release rename error after the rename took effect', async () => {
    const { lease, lockPath } = await leaseFor();
    onRename(lockPath, ownedPath(lockPath, 'released', lease.ownerId), () => {
      throw Object.assign(new Error('rename result unavailable'), {
        code: 'EIO',
      });
    });

    await expectOk(lease.release());

    expect(lease.isReleased).toBe(true);
    await enoent(fs.lstat(lockPath));
  });

  it('does not confirm release through a replacement lock directory', async () => {
    const { lease, lockPath } = await leaseFor();
    const lockDirectory = path.dirname(lockPath);
    const originalDirectory = `${lockDirectory}.original`;
    const retiredPath = ownedPath(lockPath, 'released', lease.ownerId);
    onRename(lockPath, retiredPath, async () => {
      await fs.rename(lockDirectory, originalDirectory);
      await fs.mkdir(lockDirectory);
    });

    try {
      await expectUnavailable(lease.release());

      expect(lease.isReleased).toBe(true);
      expect(lease.isReleaseDurabilityPending).toBe(true);
      await expect(
        fs.stat(path.join(originalDirectory, path.basename(retiredPath))),
      ).resolves.toBeDefined();
      await enoent(fs.lstat(lockPath));
    } finally {
      await fs.rmdir(lockDirectory);
      await fs.rename(originalDirectory, lockDirectory);
      await lease.release();
      await fs.unlink(retiredPath).catch(() => undefined);
    }
  });

  it('rejects release when lock directory inode verifiability changes', async () => {
    const { lease, lockPath } = await leaseFor();
    pathZeroInodeFault.underRoot = path.dirname(lockPath);

    await expectUnavailable(lease.release());
    await expect(fs.stat(lockPath)).resolves.toBeDefined();

    pathZeroInodeFault.underRoot = undefined;
    await expectOk(lease.release());
  });

  it('retries release durability before discarding a failed acquisition', async () => {
    const fixture = await createFixture();
    const { lockPath } = fixture;
    const activationFailure = new Error('activation failed');
    directorySyncFault.path = path.dirname(lockPath);
    directorySyncFault.remainingFailures = 1;

    await expect(
      acquire({
        ...fixture.options,
        onOwnershipAcquired: () => {
          throw activationFailure;
        },
      }),
    ).rejects.toBe(activationFailure);

    expect(directorySyncFault.remainingFailures).toBe(0);
    await enoent(fs.lstat(lockPath));
  });

  it('never reclaims a dead local owner when managed policy is enabled', async () => {
    const fixture = await createFixture();
    await crashedOwner(fixture);

    await expectConflict(
      acquire({ ...fixture.options, reclaimPolicy: 'never' }),
    );
  });

  it('never treats a foreign-host active record as a certified handoff', async () => {
    const { fixture, lease, lockPath } = await leaseFor(
      'foreign-active-session',
    );
    const active = await readJson(lockPath);
    await lease.release();
    await fs.writeFile(
      lockPath,
      JSON.stringify({
        ...active,
        hostname: 'retired-foreign-host',
        pid: 2_147_483_647,
      }),
    );

    await expectConflict(acquire(certified(fixture)));
    expect(await readJson(lockPath)).toMatchObject({
      state: 'active',
      hostname: 'retired-foreign-host',
    });
  });

  it('keeps schema v1 records on the active-owner path', async () => {
    const { fixture, lease, lockPath } = await leaseFor(
      'legacy-active-session',
    );
    const active = await readJson(lockPath);
    await lease.release();
    delete active['state'];
    active['schema_version'] = 1;
    await fs.writeFile(lockPath, JSON.stringify(active));

    await expectConflict(
      acquire({ ...fixture.options, takeoverPolicy: 'certified' }),
    );

    await fs.writeFile(
      lockPath,
      JSON.stringify({ ...active, pid: 2_147_483_647 }),
    );
    const replacement = await acquire(fixture.options);
    await replacement.release();
  });

  it('seals a transcript proof and permits only certified takeover', async () => {
    const initial = `${JSON.stringify({ record: 'initial' })}\n`;
    const { fixture, lease, lockPath } = await leaseFor(
      'sealed-session',
      initial,
    );
    await lease.appendJsonLine({ record: 'final' });
    const expectedTranscript = await fs.readFile(fixture.transcriptPath);

    await lease.sealForHandoff();

    expect(await readJson(lockPath)).toMatchObject({
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
    await expectLost(lease.appendJsonLine({ record: 'too-late' }));
    await expect(fs.readFile(fixture.transcriptPath)).resolves.toEqual(
      expectedTranscript,
    );
    await expectConflict(acquire(fixture.options));

    const replacement = await acquire(certified(fixture));
    expect(replacement.ownerId).not.toBe(lease.ownerId);
    expect(await readJson(lockPath)).toMatchObject({
      schema_version: 2,
      state: 'active',
      owner_id: replacement.ownerId,
    });
    await replacement.assertOwnedAndUnchanged();
    await replacement.release();
  });

  describe('managed lock schema 3', () => {
    const managedSchema = { schemaVersion: 3 as const, formatVersion: 1 };
    const commitProof = {
      last_commit_sequence: 7,
      committed_prefix_hash: 'a'.repeat(64),
    };

    it('pins the format version into active and sealed records', async () => {
      const fixture = await createFixture('managed-schema-session');
      const lease = await SessionWriterLease.acquire({
        ...fixture.options,
        lockSchema: managedSchema,
      });
      const lockPath = getSessionWriterLockPath(
        fixture.runtimeBaseDir,
        fixture.options.sessionId,
      );
      expect(JSON.parse(await fs.readFile(lockPath, 'utf8'))).toMatchObject({
        schema_version: 3,
        state: 'active',
        format_version: 1,
      });

      await lease.appendJsonLine({ record: 'managed' });
      await lease.sealForHandoff(commitProof);

      const sealed = JSON.parse(await fs.readFile(lockPath, 'utf8'));
      expect(sealed).toMatchObject({
        schema_version: 3,
        state: 'sealed',
        format_version: 1,
        last_commit_sequence: 7,
        committed_prefix_hash: 'a'.repeat(64),
      });
      expect(sealed.transcript.sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it('refuses to seal a managed lease without the commit proof', async () => {
      const fixture = await createFixture('managed-seal-proof-session');
      const lease = await SessionWriterLease.acquire({
        ...fixture.options,
        lockSchema: managedSchema,
      });
      const lockPath = getSessionWriterLockPath(
        fixture.runtimeBaseDir,
        fixture.options.sessionId,
      );
      await lease.appendJsonLine({ record: 'managed' });
      const activeRaw = await fs.readFile(lockPath, 'utf8');
      let transcriptOpens = 0;
      fsOpenTestHook.beforeOpen = (filePath) => {
        if (filePath === fixture.options.transcriptPath) transcriptOpens++;
      };

      await expect(lease.sealForHandoff()).rejects.toBeInstanceOf(
        SessionWriterUnavailableError,
      );
      await expect(fs.readFile(lockPath, 'utf8')).resolves.toBe(activeRaw);
      expect(transcriptOpens).toBe(0);
      // A failed seal is terminal for the lease; the active lock is left for
      // the owning process, which this test then abandons.
      await lease.release().catch(() => undefined);
    });

    it('blocks a baseline writer from a sealed managed lock', async () => {
      const fixture = await createFixture('managed-takeover-guard-session');
      const first = await SessionWriterLease.acquire({
        ...fixture.options,
        lockSchema: managedSchema,
      });
      await first.appendJsonLine({ record: 'sealed' });
      await first.sealForHandoff(commitProof);

      await expect(
        SessionWriterLease.acquire(fixture.options),
      ).rejects.toBeInstanceOf(SessionWriterConflictError);
      await expect(
        SessionWriterLease.acquire({
          ...fixture.options,
          takeoverPolicy: 'certified',
        }),
      ).rejects.toBeInstanceOf(SessionWriterUnavailableError);
    });

    it('hands the sealed commit proof to a certified managed takeover', async () => {
      const fixture = await createFixture('managed-takeover-session');
      const first = await SessionWriterLease.acquire({
        ...fixture.options,
        lockSchema: managedSchema,
      });
      await first.appendJsonLine({ record: 'sealed' });
      await first.sealForHandoff(commitProof);

      const replacement = await SessionWriterLease.acquire({
        ...fixture.options,
        takeoverPolicy: 'certified',
        lockSchema: managedSchema,
      });
      expect(replacement.ownerId).not.toBe(first.ownerId);
      expect(replacement.takeoverCommitProof).toEqual(commitProof);
      const lockPath = getSessionWriterLockPath(
        fixture.runtimeBaseDir,
        fixture.options.sessionId,
      );
      expect(JSON.parse(await fs.readFile(lockPath, 'utf8'))).toMatchObject({
        schema_version: 3,
        state: 'active',
        owner_id: replacement.ownerId,
      });
      await replacement.release();
    });

    it('rebuilds the transcript proof after discarding an uncommitted tail', async () => {
      const fixture = await createFixture('managed-truncate-session');
      const lease = await SessionWriterLease.acquire({
        ...fixture.options,
        lockSchema: managedSchema,
      });
      await lease.appendJsonLine({ record: 'committed' });
      const prefix = await fs.readFile(fixture.options.transcriptPath);
      await lease.appendJsonLine({ record: 'uncommitted' });
      await lease.truncateTo(prefix.byteLength);
      await lease.appendJsonLine({ record: 'replacement' });
      await lease.sealForHandoff(commitProof);

      const replacement = await SessionWriterLease.acquire({
        ...fixture.options,
        lockSchema: managedSchema,
        takeoverPolicy: 'certified',
      });
      expect(await fs.readFile(fixture.options.transcriptPath, 'utf8')).toBe(
        `${prefix.toString('utf8')}{"record":"replacement"}\n`,
      );
      expect(replacement.takeoverCommitProof).toEqual(commitProof);
      await replacement.release();
    });

    it('rejects truncation after the transcript changes outside the writer', async () => {
      const fixture = await createFixture('managed-truncate-changed-session');
      const lease = await SessionWriterLease.acquire({
        ...fixture.options,
        lockSchema: managedSchema,
      });
      await lease.appendJsonLine({ record: 'committed' });
      await fs.appendFile(fixture.options.transcriptPath, '{"foreign":true}\n');
      const changed = await fs.readFile(fixture.options.transcriptPath);

      await expect(lease.truncateTo(0)).rejects.toBeInstanceOf(
        SessionTranscriptChangedError,
      );
      expect(await fs.readFile(fixture.options.transcriptPath)).toEqual(
        changed,
      );
      await lease.release();
    });

    it('does not reclaim a stale managed lock for a baseline writer', async () => {
      const fixture = await createFixture('managed-stale-session');
      const owner = startLeaseProcess();
      expect(
        await requestChild(owner, {
          type: 'acquire',
          options: { ...fixture.options, lockSchema: managedSchema },
        }),
      ).toMatchObject({ ok: true });
      owner.kill('SIGKILL');
      await waitForClose(owner);

      await expect(
        SessionWriterLease.acquire(fixture.options),
      ).rejects.toBeInstanceOf(SessionWriterUnavailableError);

      const managed = await SessionWriterLease.acquire({
        ...fixture.options,
        lockSchema: managedSchema,
      });
      await managed.release();
    });
  });

  it('waits for an accepted append before sealing the transcript', async () => {
    const { fixture, lease, lockPath } = await leaseFor(
      'sealed-append-race-session',
    );
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
    const sealed = await readJson<{
      transcript: { byte_length: number; sha256: string };
    }>(lockPath);
    expect(transcript.toString('utf8')).toBe('{"late":true}\n');
    expect(sealed.transcript).toMatchObject({
      byte_length: transcript.byteLength,
      sha256: createHash('sha256').update(transcript).digest('hex'),
    });
  });

  it('reconciles a sealing error reported after the sealed primary is installed', async () => {
    const { lease, lockPath } = await leaseFor(
      'sealed-after-effect-session',
      TAIL,
    );
    onLink(ownedPath(lockPath, 'sealed-candidate', lease.ownerId), lockPath, {
      throwAfterLink: true,
    });

    await expectOk(lease.sealForHandoff());
    expect(await readJson(lockPath)).toMatchObject({
      schema_version: 2,
      state: 'sealed',
    });
  });

  it('reconciles a sealing claim link error after effect', async () => {
    const { lease, lockPath } = await leaseFor('sealed-claim-link-session');
    failClaimAfterEffect(lockPath, 'link');

    await expectOk(lease.sealForHandoff());
    await enoent(fs.lstat(`${lockPath}.claim`));
    expect(await readJson(lockPath)).toMatchObject({ state: 'sealed' });
  });

  it('reconciles a sealing claim unlink error after effect', async () => {
    const { lease, lockPath } = await leaseFor('sealed-claim-unlink-session');
    failClaimAfterEffect(lockPath, 'unlink');

    await expectOk(lease.sealForHandoff());
    await enoent(fs.lstat(`${lockPath}.claim`));
    expect(await readJson(lockPath)).toMatchObject({ state: 'sealed' });
  });

  it('does not roll back after the released claim is replaced', async () => {
    const { lease, lockPath } = await leaseFor('sealed-replaced-claim-session');
    const successorClaim = '{"successorClaim":true}';
    unlinkFault.path = `${lockPath}.claim`;
    unlinkFault.afterUnlink = () =>
      fs.writeFile(`${lockPath}.claim`, successorClaim, 'utf8');
    unlinkFault.throwAfterUnlink = true;

    await expectOk(lease.sealForHandoff());
    await expectFile(`${lockPath}.claim`, successorClaim);
    expect(await readJson(lockPath)).toMatchObject({ state: 'sealed' });
  });

  it('does not roll back sealing after claim ownership changes', async () => {
    const { fixture, lease, lockPath } = await leaseFor(
      'sealed-changed-claim-session',
      TAIL,
    );
    const successorClaim = '{"successorClaim":true}';
    onLink(ownedPath(lockPath, 'sealed-candidate', lease.ownerId), lockPath, {
      afterLink: async () => {
        await fs.unlink(`${lockPath}.claim`);
        await fs.writeFile(`${lockPath}.claim`, successorClaim, 'utf8');
        failLstat(fixture.transcriptPath, 1);
      },
    });

    await expectUnavailable(lease.sealForHandoff());
    await expectFile(`${lockPath}.claim`, successorClaim);
    expect(await readJson(lockPath)).toMatchObject({ state: 'sealed' });
  });

  it('retains the claim when sealing rollback cannot restore the primary', async () => {
    const { fixture, lease, lockPath } = await leaseFor(
      'sealed-rollback-failure-session',
      TAIL,
    );
    const activeRaw = await fs.readFile(lockPath, 'utf8');
    onLink(ownedPath(lockPath, 'sealed-candidate', lease.ownerId), lockPath, {
      afterLink: () => {
        failLstat(fixture.transcriptPath, 1);
        restoreLinkFault.linkTo = lockPath;
        restoreLinkFault.remainingFailures = 1;
      },
    });

    await expectUnavailable(lease.sealForHandoff());
    await enoent(fs.lstat(lockPath));
    await expectFile(`${lockPath}.claim`, activeRaw);
    await expectFile(ownedPath(lockPath, 'handoff', lease.ownerId), activeRaw);
    await fs.appendFile(fixture.transcriptPath, '{"external":true}\n');
    await expectUnavailable(acquire(fixture.options));
    await expectUnavailable(
      acquire({ ...fixture.options, takeoverPolicy: 'certified' }),
    );
  });

  it('removes the claim after sealing rollback restores the primary', async () => {
    const { fixture, lease, lockPath } = await leaseFor(
      'sealed-rollback-success-session',
      TAIL,
    );
    const activeRaw = await fs.readFile(lockPath, 'utf8');
    onLink(ownedPath(lockPath, 'sealed-candidate', lease.ownerId), lockPath, {
      afterLink: () => failLstat(fixture.transcriptPath, 1),
    });

    await expectUnavailable(lease.sealForHandoff());
    await expectFile(lockPath, activeRaw);
    await enoent(fs.lstat(`${lockPath}.claim`));
  });

  it('waits for a claim-aware primary candidate before completing sealing', async () => {
    const { lease, lockPath } = await leaseFor(
      'sealed-primary-candidate-session',
    );
    const active = await readJson(lockPath);
    const candidateRaw = JSON.stringify({
      ...active,
      owner_id: 'claim-aware-candidate',
    });
    onRename(
      lockPath,
      ownedPath(lockPath, 'handoff', lease.ownerId),
      async () => {
        await fs.writeFile(lockPath, candidateRaw, 'utf8');
        readFileFault.path = lockPath;
        readFileFault.triggerCall = 2;
        readFileFault.afterRead = () => fs.unlink(lockPath);
      },
    );

    await expectOk(lease.sealForHandoff());
    expect(readFileFault.calls).toBeGreaterThanOrEqual(2);
    expect(await readJson(lockPath)).toMatchObject({
      state: 'sealed',
      owner_id: lease.ownerId,
    });
    await enoent(fs.lstat(`${lockPath}.claim`));
  });

  it('fails closed when a primary candidate is abandoned during sealing', async () => {
    const { lease, lockPath } = await leaseFor(
      'sealed-abandoned-candidate-session',
    );
    const activeRaw = await fs.readFile(lockPath, 'utf8');
    const candidateRaw = JSON.stringify({
      ...(JSON.parse(activeRaw) as Record<string, unknown>),
      owner_id: 'abandoned-candidate',
    });
    const retiredPath = ownedPath(lockPath, 'handoff', lease.ownerId);
    onRename(lockPath, retiredPath, () =>
      fs.writeFile(lockPath, candidateRaw, 'utf8'),
    );

    await expectUnavailable(lease.sealForHandoff());
    await expectFile(lockPath, candidateRaw);
    await expectFile(`${lockPath}.claim`, activeRaw);
    await expectFile(retiredPath, activeRaw);
  });

  it('waits for a claim-aware primary candidate while rolling back sealing', async () => {
    const { fixture, lease, lockPath } = await leaseFor(
      'sealed-rollback-candidate-session',
      TAIL,
    );
    const activeRaw = await fs.readFile(lockPath, 'utf8');
    const active = JSON.parse(activeRaw) as Record<string, unknown>;
    const candidateRaw = JSON.stringify({
      ...active,
      owner_id: 'rollback-candidate',
    });
    onLink(ownedPath(lockPath, 'sealed-candidate', lease.ownerId), lockPath, {
      afterLink: () => {
        failLstat(fixture.transcriptPath, 1);
        unlinkFault.path = lockPath;
        unlinkFault.afterUnlink = async () => {
          unlinkFault.path = undefined;
          await fs.writeFile(lockPath, candidateRaw, 'utf8');
          readFileFault.path = lockPath;
          readFileFault.triggerCall = 2;
          readFileFault.afterRead = () => fs.unlink(lockPath);
        };
      },
    });

    await expectUnavailable(lease.sealForHandoff());
    await expectFile(lockPath, activeRaw);
    await enoent(fs.lstat(`${lockPath}.claim`));
    await enoent(fs.lstat(ownedPath(lockPath, 'handoff', lease.ownerId)));
  });

  it('fails closed when a primary candidate is abandoned during rollback', async () => {
    const { fixture, lease, lockPath } = await leaseFor(
      'sealed-rollback-abandoned-candidate-session',
      TAIL,
    );
    const activeRaw = await fs.readFile(lockPath, 'utf8');
    const candidateRaw = JSON.stringify({
      ...(JSON.parse(activeRaw) as Record<string, unknown>),
      owner_id: 'abandoned-rollback-candidate',
    });
    const retiredPath = ownedPath(lockPath, 'handoff', lease.ownerId);
    onLink(ownedPath(lockPath, 'sealed-candidate', lease.ownerId), lockPath, {
      afterLink: () => {
        failLstat(fixture.transcriptPath, 1);
        unlinkFault.path = lockPath;
        unlinkFault.throwAfterUnlink = true;
        unlinkFault.afterUnlink = async () => {
          unlinkFault.path = undefined;
          await fs.writeFile(lockPath, candidateRaw, 'utf8');
        };
      },
    });

    await expectUnavailable(lease.sealForHandoff());
    await expectFile(lockPath, candidateRaw);
    await expectFile(`${lockPath}.claim`, activeRaw);
    await expectFile(retiredPath, activeRaw);
  });

  it('never overwrites a primary installed during the sealing transition', async () => {
    const { lease, lockPath } = await leaseFor('sealed-successor-session');
    const successorRaw = '{"successor":true}';
    onRename(lockPath, ownedPath(lockPath, 'handoff', lease.ownerId), () =>
      fs.writeFile(lockPath, successorRaw, 'utf8'),
    );

    await expectUnavailable(lease.sealForHandoff());
    expect(lease.isReleased).toBe(true);
    await expectFile(lockPath, successorRaw);
    await expect(fs.lstat(`${lockPath}.claim`)).resolves.toBeDefined();
  });

  it('elects exactly one certified replacement for a sealed session', async () => {
    const { fixture } = await sealedLease('sealed-race-session', TAIL);
    await expectOneWinner(certified(fixture));
  });

  it('releases a losing takeover claim before its transition starts', async () => {
    const { fixture, lockPath } = await sealedLease(
      'takeover-pre-transition-loser-session',
    );
    let winnerRaw = '';
    claimInstallFault.path = `${lockPath}.claim`;
    claimInstallFault.afterInstall = async () => {
      const contender = await readJson(`${lockPath}.claim`);
      winnerRaw = JSON.stringify({
        ...contender,
        owner_id: 'certified-winner',
      });
      await fs.unlink(lockPath);
      await fs.writeFile(lockPath, winnerRaw, 'utf8');
    };

    await expectConflict(acquire(certified(fixture)));
    await expectFile(lockPath, winnerRaw);
    await enoent(fs.lstat(`${lockPath}.claim`));
  });

  it('reconciles a takeover error reported after the active primary is installed', async () => {
    const { fixture, lockPath } = await sealedLease(
      'takeover-after-effect-session',
    );
    onLink(`${lockPath}.claim`, lockPath, { throwAfterLink: true });

    const replacement = await acquire(certified(fixture));
    expect(await readJson(lockPath)).toMatchObject({
      schema_version: 2,
      state: 'active',
      owner_id: replacement.ownerId,
    });
    await replacement.release();
  });

  it('reconciles a takeover claim link error after effect', async () => {
    const { fixture, lockPath } = await sealedLease(
      'takeover-claim-link-session',
    );
    failClaimAfterEffect(lockPath, 'link');

    const replacement = await acquire(certified(fixture));
    await enoent(fs.lstat(`${lockPath}.claim`));
    expect(await readJson(lockPath)).toMatchObject({
      state: 'active',
      owner_id: replacement.ownerId,
    });
    await replacement.release();
  });

  it('reconciles a takeover claim unlink error after effect', async () => {
    const { fixture, lockPath } = await sealedLease(
      'takeover-claim-unlink-session',
    );
    failClaimAfterEffect(lockPath, 'unlink');

    const replacement = await acquire(certified(fixture));
    await enoent(fs.lstat(`${lockPath}.claim`));
    expect(await readJson(lockPath)).toMatchObject({
      state: 'active',
      owner_id: replacement.ownerId,
    });
    await replacement.release();
  });

  it('does not roll back takeover after claim ownership changes', async () => {
    const { fixture, lockPath } = await sealedLease(
      'takeover-changed-claim-session',
      TAIL,
    );
    const successorClaim = '{"successorClaim":true}';
    onLink(`${lockPath}.claim`, lockPath, {
      afterLink: async () => {
        await fs.unlink(`${lockPath}.claim`);
        await fs.writeFile(`${lockPath}.claim`, successorClaim, 'utf8');
        failLstat(fixture.transcriptPath, 1);
      },
    });

    await expectUnavailable(acquire(certified(fixture)));
    await expectFile(`${lockPath}.claim`, successorClaim);
    expect(await readJson(lockPath)).toMatchObject({ state: 'active' });
  });

  it('retains the claim when takeover rollback cannot restore the primary', async () => {
    const { fixture, lease, lockPath } = await sealedLease(
      'takeover-rollback-failure-session',
      TAIL,
    );
    const sealedRaw = await fs.readFile(lockPath, 'utf8');
    onLink(`${lockPath}.claim`, lockPath, {
      afterLink: () => {
        failLstat(fixture.transcriptPath, 1);
        restoreLinkFault.linkTo = lockPath;
        restoreLinkFault.remainingFailures = 1;
      },
    });

    await expectUnavailable(acquire(certified(fixture)));
    await enoent(fs.lstat(lockPath));
    const claim = await readJson<{ owner_id: string; state: string }>(
      `${lockPath}.claim`,
    );
    expect(claim.state).toBe('active');
    await expectFile(
      `${ownedPath(lockPath, 'sealed', lease.ownerId)}.${encodeURIComponent(
        claim.owner_id,
      )}`,
      sealedRaw,
    );
    await fs.appendFile(fixture.transcriptPath, '{"external":true}\n');
    await expectUnavailable(acquire(fixture.options));
    await expectUnavailable(acquire(certified(fixture)));
  });

  it('never overwrites a primary installed during the takeover transition', async () => {
    const { fixture, lockPath } = await sealedLease(
      'takeover-successor-session',
    );
    const successorRaw = '{"successor":true}';
    onRename(lockPath, undefined, () =>
      fs.writeFile(lockPath, successorRaw, 'utf8'),
    );

    await expectUnavailable(acquire(certified(fixture)));
    await expectFile(lockPath, successorRaw);
    await expect(fs.lstat(`${lockPath}.claim`)).resolves.toBeDefined();
  });

  it.each(['append', 'truncate', 'replace'] as const)(
    'retains a sealed lock when the transcript proof changes by %s',
    async (mutation) => {
      const { fixture, lockPath } = await sealedLease(
        `sealed-${mutation}-session`,
        TAIL,
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

      await expectChanged(acquire(certified(fixture)));
      await expectFile(lockPath, sealedRaw);
    },
  );

  it.each([
    ['valid but mismatched', '0'.repeat(64), SessionTranscriptChangedError],
    ['malformed', 'invalid', SessionWriterUnavailableError],
  ])(
    'retains a sealed primary with a %s transcript digest',
    async (_description, sha256, ErrorType) => {
      const { fixture, lockPath } = await sealedLease('sealed-proof-session');
      const sealed = await readJson<{ transcript: { sha256: string } }>(
        lockPath,
      );
      sealed.transcript.sha256 = sha256;
      const sealedRaw = JSON.stringify(sealed);
      await fs.writeFile(lockPath, sealedRaw);

      await rejectsAs(ErrorType)(acquire(certified(fixture)));
      await expectFile(lockPath, sealedRaw);
    },
  );

  it('fails closed without changing a sealed primary when a claim remains', async () => {
    const { fixture, lockPath } = await sealedLease('sealed-claim-session');
    const sealedRaw = await fs.readFile(lockPath, 'utf8');
    await fs.writeFile(`${lockPath}.claim`, '{"residual":true}');

    await expectUnavailable(acquire(certified(fixture)));
    await expectFile(lockPath, sealedRaw);
  });

  it('cannot remove a successor lock after release commits', async () => {
    const { fixture, lease } = await leaseFor();
    await lease.release();
    const successor = await acquire(fixture.options);

    await expectOk(lease.release());
    await expect(successor.appendJsonLine({ successor: true })).resolves.toBe(
      undefined,
    );
    await successor.release();
  });

  it('elects only one stale-lock reclaimer across processes', async () => {
    const fixture = await createFixture();
    await crashedOwner(fixture);
    await expectOneWinner(fixture.options);
  });

  it('recovers after a stale-lock reclaimer dies while holding its guard', async () => {
    const fixture = await createFixture();
    const acquired = await crashedOwner(fixture);
    expect(acquired.ownerId).toBeDefined();

    const reclaimPath = ownedPath(
      fixture.lockPath,
      'reclaim',
      acquired.ownerId!,
    );
    await fs.copyFile(fixture.lockPath, reclaimPath);

    const replacement = await acquire(fixture.options);
    await replacement.release();
  });

  it('keeps the primary lock when reclaim guard cleanup is already complete', async () => {
    const fixture = await createFixture();
    const acquired = await crashedOwner(fixture);
    expect(acquired.ownerId).toBeDefined();

    const reclaimPath = ownedPath(
      fixture.lockPath,
      'reclaim',
      acquired.ownerId!,
    );
    const replacement = await acquire({
      ...fixture.options,
      onOwnershipAcquired: () => unlinkSync(reclaimPath),
    });

    expect((await fs.lstat(fixture.lockPath)).isFile()).toBe(true);
    await expectConflict(acquire(fixture.options));
    await replacement.release();
  });

  it('reloads the authoritative tail before the next writer appends', async () => {
    const sessionId = 'incident-session';
    const fixture = await createFixture(sessionId);
    const firstUser = record(
      fixture,
      'user-1',
      null,
      'user',
      '看下调度的 wiki',
    );
    const firstToolTail = record(
      fixture,
      'tool-tail',
      firstUser.uuid,
      'assistant',
      'first tool result',
    );
    await writeTranscript(fixture, jsonl(firstUser, firstToolTail));

    const processA = startLeaseProcess();
    await childOk(processA, { type: 'acquire', options: fixture.options });
    await expectConflict(acquire(fixture.options));

    const finalAnswer = record(
      fixture,
      'final-answer',
      firstToolTail.uuid,
      'assistant',
      '完整调度 Wiki 回答',
    );
    await childOk(processA, { type: 'append', value: finalAnswer });
    await childOk(processA, { type: 'release' });

    const processBLease = await acquire(fixture.options);
    const sessionService = sessionServiceFor(fixture);
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

    const physicalRecords = await readRecords(fixture.transcriptPath);
    expect(physicalRecords.at(-1)?.parentUuid).toBe(finalAnswer.uuid);
    const reloaded = await sessionService.loadSession(sessionId);
    expect(
      reloaded?.conversation.messages.map((message) => message.uuid),
    ).toEqual(physicalRecords.map((message) => message.uuid));
  });
});
