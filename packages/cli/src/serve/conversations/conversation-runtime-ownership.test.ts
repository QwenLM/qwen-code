/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createConversationRuntimeOwnership,
  getConversationRuntimeOwnerPath,
} from './conversation-runtime-ownership.js';
import { ConversationRuntimeOwnershipError } from './conversation-runtime-errors.js';
import {
  getLiveDiscoveryPath,
  writeLiveDiscoveryFile,
} from '../live/discovery.js';
import { LIVE_HOST_PROTOCOL_VERSION } from '../live/types.js';

const recordReadFailure = vi.hoisted(() => ({
  path: undefined as string | undefined,
  operation: undefined as 'open' | 'readFile' | undefined,
  code: undefined as string | undefined,
  injected: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: vi.fn(async (...args: Parameters<typeof actual.open>) => {
      const matches = String(args[0]) === recordReadFailure.path;
      if (
        matches &&
        !recordReadFailure.injected &&
        recordReadFailure.operation === 'open'
      ) {
        recordReadFailure.injected = true;
        throw Object.assign(new Error(recordReadFailure.code), {
          code: recordReadFailure.code,
        });
      }
      const handle = await actual.open(...args);
      if (
        matches &&
        !recordReadFailure.injected &&
        recordReadFailure.operation === 'readFile'
      ) {
        recordReadFailure.injected = true;
        vi.spyOn(handle, 'readFile').mockRejectedValueOnce(
          Object.assign(new Error(recordReadFailure.code), {
            code: recordReadFailure.code,
          }),
        );
      }
      return handle;
    }),
  };
});

const temporaryDirectories: string[] = [];
const childProcesses = new Set<ChildProcess>();
const currentNonce = 'conversation_owner_nonce_current_01';

async function temporaryStableBase(): Promise<string> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'qwen-conversation-owner-'),
  );
  temporaryDirectories.push(root);
  return path.join(root, '.qwen');
}

async function readRecord(stableBaseDir: string) {
  return JSON.parse(
    await fs.readFile(getConversationRuntimeOwnerPath(stableBaseDir), 'utf8'),
  ) as { version: number; pid: number; instanceNonce: string };
}

function failRecordReadOnce(
  recordPath: string,
  operation: 'open' | 'readFile',
  code: string,
): void {
  recordReadFailure.path = recordPath;
  recordReadFailure.operation = operation;
  recordReadFailure.code = code;
  recordReadFailure.injected = false;
}

async function writeForeignRecord(
  stableBaseDir: string,
  kind: 'ownership' | 'Live discovery',
): Promise<string> {
  if (kind === 'ownership') {
    const previous = createConversationRuntimeOwnership({
      stableBaseDir,
      pid: 999_998,
      instanceNonce: 'conversation_owner_nonce_read_failure',
      isProcessAlive: () => false,
    });
    await previous.acquire();
    return getConversationRuntimeOwnerPath(stableBaseDir);
  }
  await fs.mkdir(stableBaseDir, { recursive: true, mode: 0o700 });
  await writeLiveDiscoveryFile(stableBaseDir, {
    url: 'http://127.0.0.1:3210',
    protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
    pid: 999_997,
    instanceNonce: 'legacy_live_owner_nonce_read_failure',
  });
  return getLiveDiscoveryPath(stableBaseDir);
}

afterEach(async () => {
  vi.restoreAllMocks();
  recordReadFailure.path = undefined;
  recordReadFailure.operation = undefined;
  recordReadFailure.code = undefined;
  recordReadFailure.injected = false;
  for (const child of childProcesses) {
    child.kill('SIGKILL');
  }
  childProcesses.clear();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

interface OwnershipWorkerMessage {
  ok: boolean;
  result?: { reclaimed: boolean; elapsedMs: number };
  error?: { code?: string; message: string };
}

function waitForWorkerMessage(
  child: ChildProcess,
): Promise<OwnershipWorkerMessage> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.off('error', onError);
      child.off('exit', onExit);
      child.off('message', onMessage);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Ownership worker exited before reporting (code=${String(code)}, signal=${String(signal)}).`,
        ),
      );
    };
    const onMessage = (message: unknown) => {
      cleanup();
      resolve(message as OwnershipWorkerMessage);
    };
    child.once('error', onError);
    child.once('exit', onExit);
    child.once('message', onMessage);
  });
}

describe('Conversation runtime ownership', () => {
  it('arbitrates real child processes and reclaims a crashed owner after grace', async () => {
    const stableBaseDir = await temporaryStableBase();
    const workerPath = path.join(
      path.dirname(stableBaseDir),
      'owner-worker.mjs',
    );
    const moduleUrl = pathToFileURL(
      path.resolve('src/serve/conversations/conversation-runtime-ownership.ts'),
    ).href;
    await fs.writeFile(
      workerPath,
      `import { createConversationRuntimeOwnership } from ${JSON.stringify(moduleUrl)};
const [stableBaseDir, instanceNonce, mode] = process.argv.slice(2);
const ownership = createConversationRuntimeOwnership({
  stableBaseDir,
  pid: process.pid,
  instanceNonce,
  handoffGraceMs: 120,
});
const startedAt = Date.now();
try {
  const acquired = await ownership.acquire();
  process.send?.({ ok: true, result: { ...acquired, elapsedMs: Date.now() - startedAt } });
  if (mode === 'hold') {
    process.on('message', async (message) => {
      if (message === 'release') {
        await ownership.release();
        process.exit(0);
      }
    });
  } else {
    await ownership.release();
  }
} catch (error) {
  process.send?.({
    ok: false,
    error: {
      code: typeof error === 'object' && error !== null ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error),
    },
  });
}
`,
      { mode: 0o600 },
    );
    const spawnWorker = (nonce: string, mode: 'hold' | 'once') => {
      const child = fork(workerPath, [stableBaseDir, nonce, mode], {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
      });
      childProcesses.add(child);
      return child;
    };

    const holder = spawnWorker('conversation_owner_child_holder_01', 'hold');
    await expect(waitForWorkerMessage(holder)).resolves.toMatchObject({
      ok: true,
      result: { reclaimed: false },
    });

    const contender = spawnWorker(
      'conversation_owner_child_contender_01',
      'once',
    );
    await expect(waitForWorkerMessage(contender)).resolves.toEqual({
      ok: false,
      error: {
        code: 'conversation_runtime_in_use',
        message: 'The Conversations runtime is owned by another daemon.',
      },
    });

    const holderExited = new Promise<void>((resolve) => {
      holder.once('exit', () => resolve());
    });
    holder.kill('SIGKILL');
    await holderExited;
    childProcesses.delete(holder);

    const successor = spawnWorker(
      'conversation_owner_child_successor_01',
      'once',
    );
    const successorMessage = await waitForWorkerMessage(successor);
    expect(successorMessage).toMatchObject({
      ok: true,
      result: { reclaimed: true },
    });
    expect(successorMessage.result?.elapsedMs).toBeGreaterThanOrEqual(100);
  });

  it('creates one exact private record and makes acquire/release idempotent', async () => {
    const stableBaseDir = await temporaryStableBase();
    const ownership = createConversationRuntimeOwnership({
      stableBaseDir,
      pid: process.pid,
      instanceNonce: currentNonce,
    });

    await expect(ownership.acquire()).resolves.toEqual({ reclaimed: false });
    await expect(ownership.acquire()).resolves.toEqual({ reclaimed: false });
    expect(await readRecord(stableBaseDir)).toEqual({
      version: 1,
      pid: process.pid,
      instanceNonce: currentNonce,
    });

    if (process.platform !== 'win32') {
      const directory = path.dirname(
        getConversationRuntimeOwnerPath(stableBaseDir),
      );
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
      expect(
        (await fs.stat(getConversationRuntimeOwnerPath(stableBaseDir))).mode &
          0o777,
      ).toBe(0o600);
    }

    await expect(ownership.release()).resolves.toBe(true);
    await expect(ownership.release()).resolves.toBe(false);
    await expect(
      fs.stat(getConversationRuntimeOwnerPath(stableBaseDir)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('one-flights concurrent acquisition', async () => {
    const stableBaseDir = await temporaryStableBase();
    const wait = vi.fn(async () => undefined);
    const ownership = createConversationRuntimeOwnership({
      stableBaseDir,
      pid: process.pid,
      instanceNonce: currentNonce,
      wait,
    });

    const first = ownership.acquire();
    const second = ownership.acquire();
    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ reclaimed: false });
    expect(wait).not.toHaveBeenCalled();
  });

  it('fails closed for an active foreign owner and permits a later retry', async () => {
    const stableBaseDir = await temporaryStableBase();
    const previous = createConversationRuntimeOwnership({
      stableBaseDir,
      pid: 999_998,
      instanceNonce: 'conversation_owner_nonce_previous_01',
    });
    await previous.acquire();
    const isProcessAlive = vi.fn(() => true);
    const ownership = createConversationRuntimeOwnership({
      stableBaseDir,
      pid: process.pid,
      instanceNonce: currentNonce,
      isProcessAlive,
    });

    const first = ownership.acquire();
    await expect(first).rejects.toMatchObject({
      code: 'conversation_runtime_in_use',
      retryable: true,
    });
    expect(isProcessAlive).toHaveBeenCalledWith(999_998);
    expect((await readRecord(stableBaseDir)).instanceNonce).toBe(
      'conversation_owner_nonce_previous_01',
    );

    isProcessAlive.mockReturnValue(false);
    await expect(ownership.acquire()).resolves.toEqual({ reclaimed: true });
    expect((await readRecord(stableBaseDir)).instanceNonce).toBe(currentNonce);
  });

  it('treats the same pid with a different nonce as active PID reuse', async () => {
    const stableBaseDir = await temporaryStableBase();
    const previous = createConversationRuntimeOwnership({
      stableBaseDir,
      pid: process.pid,
      instanceNonce: 'conversation_owner_nonce_previous_03',
    });
    await previous.acquire();
    const isProcessAlive = vi.fn(() => false);
    const ownership = createConversationRuntimeOwnership({
      stableBaseDir,
      pid: process.pid,
      instanceNonce: currentNonce,
      isProcessAlive,
    });

    await expect(ownership.acquire()).rejects.toMatchObject({
      code: 'conversation_runtime_in_use',
    });
    expect(isProcessAlive).not.toHaveBeenCalled();
    expect((await readRecord(stableBaseDir)).instanceNonce).toBe(
      'conversation_owner_nonce_previous_03',
    );
  });

  it('reclaims a dead foreign owner only after exactly one drain grace', async () => {
    const stableBaseDir = await temporaryStableBase();
    const previous = createConversationRuntimeOwnership({
      stableBaseDir,
      pid: 999_999,
      instanceNonce: 'conversation_owner_nonce_previous_02',
      isProcessAlive: () => false,
    });
    await previous.acquire();
    const wait = vi.fn(async () => undefined);
    const ownership = createConversationRuntimeOwnership({
      stableBaseDir,
      pid: process.pid,
      instanceNonce: currentNonce,
      isProcessAlive: () => false,
      wait,
      handoffGraceMs: 37,
    });

    await expect(ownership.acquire()).resolves.toEqual({ reclaimed: true });
    expect(wait).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith(37);
    await ownership.acquire();
    expect(wait).toHaveBeenCalledOnce();
  });

  it.each([
    ['ownership', 'open'],
    ['ownership', 'readFile'],
    ['Live discovery', 'open'],
    ['Live discovery', 'readFile'],
  ] as const)(
    'recovers after a transient %s record %s failure',
    async (kind, operation) => {
      const stableBaseDir = await temporaryStableBase();
      const recordPath = await writeForeignRecord(stableBaseDir, kind);
      const ownership = createConversationRuntimeOwnership({
        stableBaseDir,
        pid: process.pid,
        instanceNonce: currentNonce,
        isProcessAlive: () => false,
        handoffGraceMs: 0,
      });

      failRecordReadOnce(
        recordPath,
        operation,
        operation === 'open' ? 'EMFILE' : 'EIO',
      );
      await expect(ownership.acquire()).rejects.toMatchObject({
        code: 'conversation_runtime_unavailable',
        retryable: true,
      });

      await expect(ownership.acquire()).resolves.toEqual({ reclaimed: true });
    },
  );

  it.each(['ownership', 'Live discovery'] as const)(
    'treats an ELOOP opening the %s record as terminal compromise',
    async (kind) => {
      const stableBaseDir = await temporaryStableBase();
      const recordPath = await writeForeignRecord(stableBaseDir, kind);
      const ownership = createConversationRuntimeOwnership({
        stableBaseDir,
        pid: process.pid,
        instanceNonce: currentNonce,
        isProcessAlive: () => false,
      });

      failRecordReadOnce(recordPath, 'open', 'ELOOP');
      await expect(ownership.acquire()).rejects.toMatchObject({
        code: 'conversation_runtime_ownership_compromised',
        retryable: false,
      });
    },
  );

  it('rejects an active foreign legacy Live owner before writing its record', async () => {
    const stableBaseDir = await temporaryStableBase();
    await fs.mkdir(stableBaseDir, { recursive: true, mode: 0o700 });
    await writeLiveDiscoveryFile(stableBaseDir, {
      url: 'http://127.0.0.1:3210',
      protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
      pid: 999_997,
      instanceNonce: 'legacy_live_owner_nonce_active_01',
    });
    const ownership = createConversationRuntimeOwnership({
      stableBaseDir,
      pid: process.pid,
      instanceNonce: currentNonce,
      isProcessAlive: () => true,
    });

    await expect(ownership.acquire()).rejects.toMatchObject({
      code: 'conversation_runtime_in_use',
    });
    await expect(
      fs.stat(getConversationRuntimeOwnerPath(stableBaseDir)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('commits before removing a dead legacy Live owner and waits one grace', async () => {
    const stableBaseDir = await temporaryStableBase();
    await fs.mkdir(stableBaseDir, { recursive: true, mode: 0o700 });
    await writeLiveDiscoveryFile(stableBaseDir, {
      url: 'http://127.0.0.1:3210',
      protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
      pid: 999_996,
      instanceNonce: 'legacy_live_owner_nonce_dead_0001',
    });
    const wait = vi.fn(async () => undefined);
    const ownership = createConversationRuntimeOwnership({
      stableBaseDir,
      pid: process.pid,
      instanceNonce: currentNonce,
      isProcessAlive: () => false,
      wait,
      handoffGraceMs: 41,
    });

    await expect(ownership.acquire()).resolves.toEqual({ reclaimed: true });
    expect(await readRecord(stableBaseDir)).toMatchObject({
      pid: process.pid,
      instanceNonce: currentNonce,
    });
    await expect(
      fs.stat(getLiveDiscoveryPath(stableBaseDir)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(wait).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith(41);
  });

  it('waits one grace after reclaiming both ownership records', async () => {
    const stableBaseDir = await temporaryStableBase();
    const previous = createConversationRuntimeOwnership({
      stableBaseDir,
      pid: 999_995,
      instanceNonce: 'conversation_owner_nonce_previous_04',
      isProcessAlive: () => false,
    });
    await previous.acquire();
    await writeLiveDiscoveryFile(stableBaseDir, {
      url: 'http://127.0.0.1:3210',
      protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
      pid: 999_994,
      instanceNonce: 'legacy_live_owner_nonce_dead_0002',
    });
    const wait = vi.fn(async () => undefined);
    const ownership = createConversationRuntimeOwnership({
      stableBaseDir,
      pid: process.pid,
      instanceNonce: currentNonce,
      isProcessAlive: () => false,
      wait,
      handoffGraceMs: 43,
    });

    await expect(ownership.acquire()).resolves.toEqual({ reclaimed: true });
    expect(wait).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith(43);
    expect(await readRecord(stableBaseDir)).toMatchObject({
      pid: process.pid,
      instanceNonce: currentNonce,
    });
    await expect(
      fs.stat(getLiveDiscoveryPath(stableBaseDir)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never overwrites malformed or unknown-version state', async () => {
    const stableBaseDir = await temporaryStableBase();
    const ownerPath = getConversationRuntimeOwnerPath(stableBaseDir);
    await fs.mkdir(path.dirname(ownerPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(ownerPath, '{"version":2}', { mode: 0o600 });
    const ownership = createConversationRuntimeOwnership({
      stableBaseDir,
      pid: process.pid,
      instanceNonce: currentNonce,
    });

    await expect(ownership.acquire()).rejects.toMatchObject({
      code: 'conversation_runtime_ownership_compromised',
      retryable: false,
    });
    await expect(ownership.acquire()).rejects.toBeInstanceOf(
      ConversationRuntimeOwnershipError,
    );
    await expect(fs.readFile(ownerPath, 'utf8')).resolves.toBe('{"version":2}');
    await expect(ownership.release()).resolves.toBe(false);
  });

  it.each(['symlink', 'hardlink', 'oversized', 'mode'] as const)(
    'rejects an unsafe %s owner file without replacing it',
    async (kind) => {
      if (
        process.platform === 'win32' &&
        (kind === 'symlink' || kind === 'mode')
      ) {
        return;
      }
      const stableBaseDir = await temporaryStableBase();
      const ownerPath = getConversationRuntimeOwnerPath(stableBaseDir);
      const ownerDirectory = path.dirname(ownerPath);
      const targetPath = path.join(
        path.dirname(stableBaseDir),
        `owner-${kind}`,
      );
      await fs.mkdir(ownerDirectory, { recursive: true, mode: 0o700 });
      const validRecord = `${JSON.stringify({
        version: 1,
        pid: 999_995,
        instanceNonce: 'conversation_owner_nonce_unsafe_01',
      })}\n`;
      if (kind === 'symlink') {
        await fs.writeFile(targetPath, validRecord, { mode: 0o600 });
        await fs.symlink(targetPath, ownerPath);
      } else if (kind === 'hardlink') {
        await fs.writeFile(targetPath, validRecord, { mode: 0o600 });
        await fs.link(targetPath, ownerPath);
      } else if (kind === 'oversized') {
        await fs.writeFile(ownerPath, 'x'.repeat(4 * 1024 + 1), {
          mode: 0o600,
        });
      } else {
        await fs.writeFile(ownerPath, validRecord, { mode: 0o644 });
        await fs.chmod(ownerPath, 0o644);
      }
      const ownership = createConversationRuntimeOwnership({
        stableBaseDir,
        pid: process.pid,
        instanceNonce: currentNonce,
      });

      await expect(ownership.acquire()).rejects.toMatchObject({
        code: 'conversation_runtime_ownership_compromised',
        retryable: false,
      });
      const stat = await fs.lstat(ownerPath);
      if (kind === 'symlink') expect(stat.isSymbolicLink()).toBe(true);
      if (kind === 'hardlink') expect(stat.nlink).toBe(2);
      if (kind === 'oversized') expect(stat.size).toBe(4 * 1024 + 1);
      if (kind === 'mode') expect(stat.mode & 0o777).toBe(0o644);
    },
  );

  it('turns missing or foreign state after acquire into terminal compromise', async () => {
    const stableBaseDir = await temporaryStableBase();
    const ownerPath = getConversationRuntimeOwnerPath(stableBaseDir);
    const ownership = createConversationRuntimeOwnership({
      stableBaseDir,
      pid: process.pid,
      instanceNonce: currentNonce,
    });
    await ownership.acquire();
    await fs.unlink(ownerPath);

    await expect(ownership.acquire()).rejects.toMatchObject({
      code: 'conversation_runtime_ownership_compromised',
      retryable: false,
    });
    await expect(ownership.release()).rejects.toMatchObject({
      code: 'conversation_runtime_ownership_compromised',
    });
    await expect(fs.stat(ownerPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not recreate a missing ownership directory after acquire', async () => {
    const stableBaseDir = await temporaryStableBase();
    const ownerDirectory = path.dirname(
      getConversationRuntimeOwnerPath(stableBaseDir),
    );
    const ownership = createConversationRuntimeOwnership({
      stableBaseDir,
      pid: process.pid,
      instanceNonce: currentNonce,
    });
    await ownership.acquire();
    await fs.rm(ownerDirectory, { recursive: true });

    await expect(ownership.acquire()).rejects.toMatchObject({
      code: 'conversation_runtime_ownership_compromised',
      retryable: false,
    });
    await expect(fs.stat(ownerDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not unlink a record that changes before release', async () => {
    const stableBaseDir = await temporaryStableBase();
    const ownerPath = getConversationRuntimeOwnerPath(stableBaseDir);
    const ownership = createConversationRuntimeOwnership({
      stableBaseDir,
      pid: process.pid,
      instanceNonce: currentNonce,
    });
    await ownership.acquire();
    const foreign = {
      version: 1,
      pid: process.pid,
      instanceNonce: 'conversation_owner_nonce_foreign_01',
    };
    await fs.writeFile(ownerPath, `${JSON.stringify(foreign)}\n`, {
      mode: 0o600,
    });

    await expect(ownership.release()).rejects.toMatchObject({
      code: 'conversation_runtime_ownership_compromised',
    });
    expect(await readRecord(stableBaseDir)).toEqual(foreign);
  });

  it('rejects an unsafe existing ownership directory without repairing it', async () => {
    if (process.platform === 'win32') return;
    const stableBaseDir = await temporaryStableBase();
    const ownerDirectory = path.dirname(
      getConversationRuntimeOwnerPath(stableBaseDir),
    );
    await fs.mkdir(ownerDirectory, { recursive: true, mode: 0o755 });
    await fs.chmod(ownerDirectory, 0o755);
    const ownership = createConversationRuntimeOwnership({
      stableBaseDir,
      pid: process.pid,
      instanceNonce: currentNonce,
    });

    await expect(ownership.acquire()).rejects.toMatchObject({
      code: 'conversation_runtime_ownership_compromised',
    });
    expect((await fs.stat(ownerDirectory)).mode & 0o777).toBe(0o755);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'treats transient directory inspection failures as retryable',
    async () => {
      const stableBaseDir = await temporaryStableBase();
      const parent = path.dirname(stableBaseDir);
      const ownership = createConversationRuntimeOwnership({
        stableBaseDir,
        pid: process.pid,
        instanceNonce: currentNonce,
      });

      await fs.chmod(parent, 0o000);
      try {
        await expect(ownership.acquire()).rejects.toMatchObject({
          code: 'conversation_runtime_unavailable',
          retryable: true,
        });
      } finally {
        await fs.chmod(parent, 0o700);
      }

      await expect(ownership.acquire()).resolves.toEqual({
        reclaimed: false,
      });
    },
  );

  it('rejects an unsafe ownership lock shape without replacing it', async () => {
    const stableBaseDir = await temporaryStableBase();
    const ownerDirectory = path.dirname(
      getConversationRuntimeOwnerPath(stableBaseDir),
    );
    const lockPath = path.join(ownerDirectory, '.runtime-owner.lock');
    await fs.mkdir(ownerDirectory, { recursive: true, mode: 0o700 });
    await fs.writeFile(lockPath, 'unsafe', { mode: 0o600 });
    const ownership = createConversationRuntimeOwnership({
      stableBaseDir,
      pid: process.pid,
      instanceNonce: currentNonce,
    });

    await expect(ownership.acquire()).rejects.toMatchObject({
      code: 'conversation_runtime_ownership_compromised',
      retryable: false,
    });
    await expect(fs.readFile(lockPath, 'utf8')).resolves.toBe('unsafe');
  });

  it('rejects a symlinked ownership directory', async () => {
    if (process.platform === 'win32') return;
    const stableBaseDir = await temporaryStableBase();
    const ownerDirectory = path.dirname(
      getConversationRuntimeOwnerPath(stableBaseDir),
    );
    const target = path.join(path.dirname(stableBaseDir), 'target');
    await fs.mkdir(target, { mode: 0o700 });
    await fs.mkdir(stableBaseDir, { mode: 0o700 });
    await fs.symlink(target, ownerDirectory);
    const ownership = createConversationRuntimeOwnership({
      stableBaseDir,
      pid: process.pid,
      instanceNonce: currentNonce,
    });

    await expect(ownership.acquire()).rejects.toMatchObject({
      code: 'conversation_runtime_ownership_compromised',
    });
    await expect(fs.readdir(target)).resolves.toEqual([]);
  });

  it('rejects an ownership directory below a symlinked stable base', async () => {
    if (process.platform === 'win32') return;
    const stableBaseDir = await temporaryStableBase();
    const target = path.join(path.dirname(stableBaseDir), 'stable-target');
    await fs.mkdir(path.join(target, 'conversations'), {
      recursive: true,
      mode: 0o700,
    });
    await fs.symlink(target, stableBaseDir);
    const ownership = createConversationRuntimeOwnership({
      stableBaseDir,
      pid: process.pid,
      instanceNonce: currentNonce,
    });

    await expect(ownership.acquire()).rejects.toMatchObject({
      code: 'conversation_runtime_ownership_compromised',
    });
    await expect(
      fs.readdir(path.join(target, 'conversations')),
    ).resolves.toEqual([]);
  });
});
