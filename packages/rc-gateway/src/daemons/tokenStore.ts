/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Per-daemon token storage (`add-multi-workspace-client`: "Token storage").
 *
 * The spec calls for an OS keyring with a file fallback. No keyring binding is
 * in this repo's dependency tree (a native `keytar`-class addon would have to
 * be added deliberately), so this module ships the FILE store directly: tokens
 * live under `~/.qwen/rc/tokens/<sanitised-key>.tok` at mode 0600, and the
 * first write in a process emits a one-time stderr notice that the OS keyring
 * is unavailable. The `TokenStore` interface is the seam a future keyring
 * backend would implement.
 *
 * Keys are the registry's `tokenStorageKey`. They are sanitised to a flat
 * path-safe segment before use so a hand-edited registry can never smuggle a
 * `../` traversal or a path separator into the tokens dir.
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface TokenStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Default token dir: `~/.qwen/rc/tokens`. */
export function defaultTokensDir(): string {
  return join(homedir(), '.qwen', 'rc', 'tokens');
}

/**
 * Reduce a tokenStorageKey to a single flat filename-safe segment: keep
 * `[A-Za-z0-9._-]`, replace every other byte (spaces, `/`, `\`, unicode, …)
 * with `_`. Never yields an empty string, a leading dot, or a path separator.
 */
export function sanitizeKey(key: string): string {
  const flat = key.replace(/[^A-Za-z0-9._-]/g, '_');
  // Strip leading dots so `..`/`.` style keys can't become hidden/relative.
  const stripped = flat.replace(/^\.+/, '');
  return stripped.length > 0 ? stripped : 'key';
}

/**
 * File-backed TokenStore. Every token file is 0600; the dir is 0700. A single
 * process-level stderr notice is emitted the first time a token is written.
 */
export class FileTokenStore implements TokenStore {
  private warned = false;

  constructor(
    private readonly dir: string = defaultTokensDir(),
    private readonly warn: (msg: string) => void = (m) =>
      process.stderr.write(m + '\n'),
  ) {}

  private pathFor(key: string): string {
    return join(this.dir, sanitizeKey(key) + '.tok');
  }

  private maybeWarn(): void {
    if (!this.warned) {
      this.warned = true;
      // The `os_keyring_unavailable_using_file_fallback` token is load-bearing:
      // the spec requires the one-time stderr warning to carry that literal so
      // scripts can detect the fallback mode.
      this.warn(
        'qwen-rc: os_keyring_unavailable_using_file_fallback — no OS keyring ' +
          'available, storing daemon tokens as 0600 files ' +
          `under ${this.dir}`,
      );
    }
  }

  async get(key: string): Promise<string | undefined> {
    try {
      const raw = await fs.readFile(this.pathFor(key), 'utf8');
      return raw.length > 0 ? raw : undefined;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  }

  async set(key: string, value: string): Promise<void> {
    this.maybeWarn();
    await fs.mkdir(this.dir, { mode: 0o700, recursive: true });
    await fs.writeFile(this.pathFor(key), value, { mode: 0o600 });
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(this.pathFor(key));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
}
