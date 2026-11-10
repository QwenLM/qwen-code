/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Mutex } from 'async-mutex';
import lockfile from 'proper-lockfile';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import { isNodeError } from '../utils/errors.js';

/** All of one plugin's store, as JSON text. */
export const MOD_STORE_MAX_BYTES = 4 * 1024 * 1024;

// Two sessions of one plugin write the same file, so a write holds a lock
// on it across processes and re-reads it under that lock. A lock a crashed
// process left goes stale after five seconds and is taken over; the retries
// wait longer than that.
const LOCK_OPTIONS: lockfile.LockOptions = {
  realpath: false,
  retries: { retries: 80, minTimeout: 5, maxTimeout: 100, randomize: true },
  stale: 5000,
};

const fileLocks = new Map<string, Mutex>();

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

  async set(plugin: string, key: string, value: unknown): Promise<void> {
    await this.change(plugin, (entries) => {
      entries.set(key, value);
      return true;
    });
  }

  async delete(plugin: string, key: string): Promise<void> {
    await this.change(plugin, (entries) => entries.delete(key));
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
      text = await fs.readFile(file, 'utf8');
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
    apply: (entries: Map<string, unknown>) => boolean,
  ): Promise<void> {
    const file = this.file(plugin);
    let mutex = fileLocks.get(file);
    if (!mutex) fileLocks.set(file, (mutex = new Mutex()));
    await mutex.runExclusive(async () => {
      await fs.mkdir(this.dir, { recursive: true });
      const release = await lockfile.lock(file, LOCK_OPTIONS);
      try {
        const entries = await this.read(file);
        if (!apply(entries)) return;
        const stored: StoreFile = { version: 1, entries: [...entries] };
        const text = JSON.stringify(stored);
        if (Buffer.byteLength(text) > MOD_STORE_MAX_BYTES)
          throw new Error(
            `Mod store: the store would be over ${MOD_STORE_MAX_BYTES} bytes of JSON.`,
          );
        await atomicWriteFile(file, text, { mode: 0o600 });
      } finally {
        await release();
      }
    });
  }
}
