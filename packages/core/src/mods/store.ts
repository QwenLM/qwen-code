/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  openSync,
  readFileSync,
  statfsSync,
  statSync,
} from 'node:fs';
import * as fs from 'node:fs/promises';
import { hostname } from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Mutex } from 'async-mutex';
import { renameWithRetry } from '../utils/atomicFileWrite.js';
import { isNodeError } from '../utils/errors.js';
import { openNoFollow } from '../utils/no-follow-open.js';
import {
  isZombie,
  readLocalBootId,
  readPidNamespaceId,
  readProcStartToken,
} from '../utils/process-liveness.js';
import { MOD_MAX_BYTES } from './types.js';

/** All of one plugin's store, as JSON text. */
export const MOD_STORE_MAX_BYTES = 4 * 1024 * 1024;

// Leave room for the worker reply and the nested next(e) result envelope.
const MAX_KEY_LIST_BYTES = MOD_MAX_BYTES - 64;
const LOCK_WAIT_MS = 8_000;
const PROC_SUPER_MAGIC = 0x9fa0;
const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';
const lockHost = hostname();
const pidNamespace = readPidNamespaceId();
const bootId = process.platform === 'linux' ? readLocalBootId() : null;
const startPrefix = pidNamespace === null ? null : readStartPrefix();
const lockScope = scopeForBoot(bootId);
const machineScope =
  bootId !== null && pidNamespace !== null && hasKernelBootId(bootId)
    ? readMachineScope()
    : null;
const fileLocks = new Map<string, Mutex>();

function scopeForBoot(id: string | null): string {
  return createHash('sha256')
    .update(JSON.stringify([lockHost, pidNamespace, id]))
    .digest('hex')
    .slice(0, 16);
}

function hasKernelBootId(expected: string): boolean {
  try {
    const fd = openSync(
      BOOT_ID_PATH,
      constants.O_RDONLY | constants.O_NONBLOCK,
    );
    try {
      // Containers can bind-mount a per-container boot ID over this file.
      return (
        statfsSync(`/proc/self/fd/${fd}`).type === PROC_SUPER_MAGIC &&
        readFileSync(fd, 'utf8').trim() === expected
      );
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

function readMachineScope(): string | null {
  try {
    const id = readFileSync('/etc/machine-id', 'utf8').trim();
    if (!/^[a-f0-9]{32}$/i.test(id) || /^0+$/.test(id)) return null;
    return createHmac('sha256', 'Qwen-Code/ModStore/lock-host')
      .update(Buffer.from(id, 'hex'))
      .digest('hex')
      .slice(0, 32);
  } catch {
    return null;
  }
}

function hasLocalProcPids(): boolean {
  if (pidNamespace === null) return false;
  try {
    const status = readFileSync('/proc/self/status', 'utf8');
    // A procfs mounted in an ancestor PID namespace lists multiple IDs.
    return (
      /^NStgid:[ \t]+(\d+)[ \t]*$/m.exec(status)?.[1] === String(process.pid)
    );
  } catch {
    return false;
  }
}

function readStartPrefix(): string | null {
  try {
    // Procfs reports starttime in the reader's time namespace. The separator
    // also keeps older reapers from interpreting this as a bare start token.
    return `${statSync('/proc/self/ns/time').ino}~`;
  } catch {
    return null;
  }
}

function processStart(pid: number): string {
  if (startPrefix === null) return '-';
  const token = readProcStartToken(pid);
  return token === null
    ? '-'
    : `${startPrefix}${Buffer.from(token).toString('base64url')}`;
}

function deadOwner(owner: string): boolean {
  const identity =
    /^(?<scope>[a-f0-9]{16})\.(?<pid>[1-9]\d{0,9})\.(?<start>(?:\d+~)?[\w-]+)\.[a-f0-9-]{36}(?:(?<kernel>\.k)?\.(?<machine>[a-f0-9]{32})\.(?<boot>[a-f0-9-]+))?$/.exec(
      owner,
    )?.groups;
  if (!identity) return false;
  const {
    scope,
    pid: rawPid,
    start: recordedStart,
    kernel,
    machine,
    boot,
  } = identity;
  if (scope !== lockScope) {
    return (
      kernel !== undefined &&
      machineScope !== null &&
      machine === machineScope &&
      boot !== undefined &&
      boot !== bootId &&
      scope === scopeForBoot(boot)
    );
  }
  if (
    process.platform === 'linux' &&
    (pidNamespace === null || bootId === null)
  )
    return false;
  const pid = Number(rawPid);
  if (pid > 2_147_483_647) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return isNodeError(error) && error.code === 'ESRCH';
  }
  if (!hasLocalProcPids()) return false;
  if (isZombie(pid)) return true;
  if (startPrefix === null || !recordedStart.startsWith(startPrefix))
    return false;
  const start = processStart(pid);
  return start !== '-' && recordedStart !== start;
}

async function removeLock(lock: string, owner?: string): Promise<void> {
  if (owner)
    await fs.rm(path.join(lock, owner), { recursive: true, force: true });
  try {
    // A contender may already have published a new nonempty directory here.
    await fs.rmdir(lock);
  } catch (error) {
    if (
      !isNodeError(error) ||
      !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code ?? '')
    )
      throw error;
  }
}

async function acquireLock(
  lock: string,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const nonce = randomUUID();
  const staging = `${lock}.${nonce}`;
  const recovery = machineScope && bootId ? `.k.${machineScope}.${bootId}` : '';
  const start = hasLocalProcPids() ? processStart(process.pid) : '-';
  const owner = `${lockScope}.${process.pid}.${start}.${nonce}${recovery}`;
  await fs.mkdir(staging, { mode: 0o700 });
  let acquired = false;
  try {
    await fs.mkdir(path.join(staging, owner));
    const deadline = performance.now() + LOCK_WAIT_MS;
    do {
      signal?.throwIfAborted();
      try {
        // Publish ownership in one rename. A held lock is nonempty and
        // cannot be replaced, even if the owner has stopped running.
        await fs.rename(staging, lock);
        acquired = true;
        return path.join(lock, owner);
      } catch (error) {
        if (
          !isNodeError(error) ||
          !['ENOTEMPTY', 'EEXIST', 'EPERM', 'EACCES'].includes(error.code ?? '')
        )
          throw error;
        const owners = await fs
          .lstat(lock)
          .then((stat) => {
            if (!stat.isDirectory()) throw error;
            return fs.readdir(lock);
          })
          .catch((cause: unknown) => {
            if (isNodeError(cause) && cause.code === 'ENOENT') return [];
            throw cause;
          });
        if (owners.length === 0) await removeLock(lock);
        else if (owners.length === 1 && deadOwner(owners[0]))
          await removeLock(lock, owners[0]);
      }
      await delay(50, undefined, { signal });
    } while (performance.now() < deadline);
    throw new Error(`Mod store: timed out waiting for ${lock}.`);
  } finally {
    if (!acquired)
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

function acquireLocalLock(
  mutex: Mutex,
  signal?: AbortSignal,
): Promise<() => void> {
  if (!signal) return mutex.acquire();
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    void mutex.acquire().then(
      (release) => {
        signal.removeEventListener('abort', abort);
        // A cancelled waiter still reaches the mutex's front eventually.
        if (signal.aborted) release();
        else resolve(release);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

// Entries are kept as pairs, so a key such as "10" keeps its place and
// "__proto__" is a key like any other.
interface StoreFile {
  version: 1;
  entries: Array<[string, unknown]>;
}

/**
 * Each plugin's key-value store, kept between sessions: one JSON file per
 * plugin under `dir`, named after the plugin.
 */
export class ModStore {
  constructor(private readonly dir: string) {}

  async get(plugin: string, key: string): Promise<unknown> {
    return (await this.read(this.file(plugin))).get(key);
  }

  async keys(plugin: string): Promise<string[]> {
    return [...(await this.read(this.file(plugin))).keys()];
  }

  async set(
    plugin: string,
    key: string,
    value: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.change(plugin, signal, (entries) => {
      if (
        !entries.has(key) &&
        Buffer.byteLength(JSON.stringify([...entries.keys(), key])) >
          MAX_KEY_LIST_BYTES
      )
        throw new Error(
          `Mod store: the key list would be over ${MAX_KEY_LIST_BYTES} bytes of JSON.`,
        );
      entries.set(key, value);
      return true;
    });
  }

  async delete(
    plugin: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.change(plugin, signal, (entries) => entries.delete(key));
  }

  private file(plugin: string): string {
    // Extension names are letters, digits, `-`, `_` and `.`, and match
    // without case; one of dots alone would leave the directory.
    const name = plugin.toLowerCase();
    if (!/^[a-z0-9_.-]+$/.test(name) || /^\.+$/.test(name))
      throw new Error(`Mod store: no store for the plugin name "${plugin}".`);
    // The hash prefix cannot collide with a short extension name.
    const stem =
      name.length > 128
        ? `~${createHash('sha256').update(name).digest('hex')}`
        : name;
    return path.join(this.dir, `${stem}.json`);
  }

  private async read(file: string): Promise<Map<string, unknown>> {
    let text: string;
    try {
      const handle = await openNoFollow(file, { nonBlocking: true }).catch(
        (error: unknown) => {
          // The no-follow fallback can observe a regular file being replaced.
          if (isNodeError(error) && error.code === 'ELOOP')
            return openNoFollow(file, { nonBlocking: true });
          throw error;
        },
      );
      try {
        if (!(await handle.stat()).isFile())
          throw new Error('The store is not a regular file.');
        text = await handle.readFile('utf8');
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') return new Map();
      throw new Error(
        `Mod store: cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const stored = parsed as Partial<StoreFile> | undefined;
    if (
      !stored ||
      stored.version !== 1 ||
      !Array.isArray(stored.entries) ||
      !stored.entries.every(
        (entry) =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          typeof entry[0] === 'string',
      )
    )
      // Left as it is: a write would lose what the file still holds.
      throw new Error(
        `Mod store: ${file} is not a store this version reads; it is left unchanged.`,
      );
    return new Map(stored.entries);
  }

  private async change(
    plugin: string,
    signal: AbortSignal | undefined,
    apply: (entries: Map<string, unknown>) => boolean,
  ): Promise<void> {
    const file = this.file(plugin);
    let mutex = fileLocks.get(file);
    if (!mutex) fileLocks.set(file, (mutex = new Mutex()));
    const release = await acquireLocalLock(mutex, signal);
    try {
      signal?.throwIfAborted();
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      const lock = `${file}.lock`;
      const owner = await acquireLock(lock, signal);
      try {
        signal?.throwIfAborted();
        const entries = await this.read(file);
        if (!apply(entries)) return;
        const stored: StoreFile = { version: 1, entries: [...entries] };
        const text = JSON.stringify(stored);
        if (Buffer.byteLength(text) > MOD_STORE_MAX_BYTES)
          throw new Error(
            `Mod store: the store would be over ${MOD_STORE_MAX_BYTES} bytes of JSON.`,
          );
        const temporary = path.join(owner, 'store.json');
        await fs.writeFile(temporary, text, {
          flag: 'wx',
          mode: 0o600,
          flush: true,
        });
        await renameWithRetry(temporary, file, 3, 50);
      } finally {
        await removeLock(lock, path.basename(owner));
      }
    } finally {
      release();
    }
  }
}
