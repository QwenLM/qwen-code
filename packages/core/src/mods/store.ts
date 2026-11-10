/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { hostname } from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Mutex } from 'async-mutex';
import { renameWithRetry } from '../utils/atomicFileWrite.js';
import { isNodeError } from '../utils/errors.js';
import { openNoFollow } from '../utils/no-follow-open.js';
import {
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
const pidNamespace = readPidNamespaceId();
const bootId = process.platform === 'linux' ? readLocalBootId() : null;
const lockScope = createHash('sha256')
  .update(JSON.stringify([hostname(), pidNamespace, bootId]))
  .digest('hex')
  .slice(0, 16);
const machineScope = readMachineScope();
const fileLocks = new Map<string, Mutex>();

function readMachineScope(): string | null {
  if (process.platform !== 'linux') return null;
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

function processStart(pid: number): string {
  const token = readProcStartToken(pid);
  return token === null ? '-' : Buffer.from(token).toString('base64url');
}

function deadOwner(owner: string): boolean {
  const match =
    /^([a-f0-9]{16})\.([1-9]\d{0,9})\.([\w-]+)\.[a-f0-9-]{36}(?:\.([a-f0-9]{32})\.([a-f0-9-]+))?$/.exec(
      owner,
    );
  if (!match) return false;
  if (match[1] !== lockScope) {
    // A PID is meaningful only within its boot and namespace. A verified
    // earlier boot of this machine is already gone, regardless of its PID.
    return (
      machineScope !== null &&
      bootId !== null &&
      match[4] === machineScope &&
      match[5] !== bootId
    );
  }
  if (
    process.platform === 'linux' &&
    (pidNamespace === null || bootId === null)
  )
    return false;
  const pid = Number(match[2]);
  if (pid > 2_147_483_647) return false;
  try {
    process.kill(pid, 0);
  } catch (error) {
    return isNodeError(error) && error.code === 'ESRCH';
  }
  const start = processStart(pid);
  return match[3] !== '-' && start !== '-' && match[3] !== start;
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
  const recovery = machineScope && bootId ? `.${machineScope}.${bootId}` : '';
  const owner = `${lockScope}.${process.pid}.${processStart(process.pid)}.${nonce}${recovery}`;
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
    if (!/^[a-z0-9_.-]{1,128}$/.test(name) || /^\.+$/.test(name))
      throw new Error(`Mod store: no store for the plugin name "${plugin}".`);
    return path.join(this.dir, `${name}.json`);
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
