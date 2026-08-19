/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The multi-daemon registry (`add-multi-workspace-client`: "Daemons registry
 * file" + "Registry CLI"). Persists the operator's list of remote-control
 * daemons to `~/.qwen/rc/clients.toml` as a `[[daemon]]` array-of-tables —
 * the exact shape the daemon-side `GET /ui/clients-manifest.json` route reads
 * (see routes/clientsManifest.ts).
 *
 * The parsing / validation / normalisation here is kept pure (parseRegistry /
 * assertValid / serializeRegistry / resolveDefault) so it is unit-tested
 * without touching the filesystem; DaemonRegistry is the thin fs I/O wrapper
 * that does atomic temp-and-rename writes with mode 0600.
 *
 * Invariants (enforced on every read and write):
 *  - `name` is unique across entries;
 *  - `url` is unique across entries;
 *  - at most one entry carries `default = true`; when none does, the FIRST
 *    entry is the effective default (matching the client-side rule the
 *    manifest documents: "no explicit default → first entry is default").
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomInt } from 'node:crypto';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

export interface DaemonEntry {
  name: string;
  url: string;
  /** Key under which this daemon's token is stored (see tokenStore). */
  tokenStorageKey: string;
  /** At most one entry may set this; the effective default falls back to the first entry. */
  default?: boolean;
}

/** Default registry location: `~/.qwen/rc/clients.toml`. */
export function defaultRegistryPath(): string {
  return join(homedir(), '.qwen', 'rc', 'clients.toml');
}

/**
 * Parse `clients.toml` text into entries. Strict: malformed TOML or a
 * non-array `daemon`, or an entry missing a required string field, throws.
 * An empty/absent document yields `[]`.
 */
export function parseRegistry(text: string | null): DaemonEntry[] {
  if (text === null || text.trim() === '') return [];
  const parsed = parseToml(text) as { daemon?: unknown };
  const arr = parsed.daemon;
  if (arr !== undefined && !Array.isArray(arr)) {
    throw new Error('clients.toml: `daemon` must be an array of tables');
  }
  const raw = (arr ?? []) as unknown[];
  return raw.map((row, i) => {
    if (typeof row !== 'object' || row === null) {
      throw new Error(`clients.toml: daemon[${i}] must be a table`);
    }
    const e = row as Record<string, unknown>;
    const name = e.name;
    const url = e.url;
    const tokenStorageKey = e.tokenStorageKey;
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(
        `clients.toml: daemon[${i}].name must be a non-empty string`,
      );
    }
    if (typeof url !== 'string' || url.length === 0) {
      throw new Error(
        `clients.toml: daemon[${i}].url must be a non-empty string`,
      );
    }
    if (typeof tokenStorageKey !== 'string' || tokenStorageKey.length === 0) {
      throw new Error(
        `clients.toml: daemon[${i}].tokenStorageKey must be a non-empty string`,
      );
    }
    const def = e.default;
    return {
      name,
      url,
      tokenStorageKey,
      ...(def === true ? { default: true } : {}),
    };
  });
}

/** Serialize entries back to `[[daemon]]` TOML. */
export function serializeRegistry(entries: DaemonEntry[]): string {
  return stringifyToml({ daemon: entries });
}

/**
 * Assert the cross-entry invariants (name/url uniqueness, ≤1 default). Throws
 * with a descriptive message on violation.
 */
export function assertValid(entries: DaemonEntry[]): void {
  const names = new Set<string>();
  const urls = new Set<string>();
  let defaults = 0;
  for (const e of entries) {
    if (names.has(e.name)) throw new Error(`duplicate daemon name: ${e.name}`);
    names.add(e.name);
    if (urls.has(e.url)) throw new Error(`duplicate daemon url: ${e.url}`);
    urls.add(e.url);
    if (e.default) defaults += 1;
  }
  if (defaults > 1) {
    throw new Error('at most one daemon may be marked `default`');
  }
}

/**
 * The effective default: the single entry with `default = true`, else the
 * first entry, else `undefined`. Never mutates.
 */
export function resolveDefault(
  entries: DaemonEntry[],
): DaemonEntry | undefined {
  return entries.find((e) => e.default) ?? entries[0];
}

/**
 * Normalise the default flag: if exactly one is already set, keep it; if none
 * is set and there is ≥1 entry, mark the first. Returns a NEW array (does not
 * mutate the input).
 */
export function normalizeDefaults(entries: DaemonEntry[]): DaemonEntry[] {
  if (entries.length === 0) return [];
  if (entries.some((e) => e.default)) return entries.map((e) => ({ ...e }));
  return entries.map((e, i) => (i === 0 ? { ...e, default: true } : { ...e }));
}

export class DaemonRegistry {
  constructor(private readonly path: string = defaultRegistryPath()) {}

  /** Read + parse the file; a missing file yields `[]`. Throws on bad TOML. */
  async load(): Promise<DaemonEntry[]> {
    let text: string;
    try {
      text = await fs.readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const entries = parseRegistry(text);
    assertValid(entries);
    return entries;
  }

  async list(): Promise<DaemonEntry[]> {
    return this.load();
  }

  async getByName(name: string): Promise<DaemonEntry | undefined> {
    return (await this.load()).find((e) => e.name === name);
  }

  async getDefault(): Promise<DaemonEntry | undefined> {
    return resolveDefault(await this.load());
  }

  /**
   * Insert or replace an entry by name. `url`/`tokenStorageKey` are updated on
   * replace. Validates uniqueness after the change. If the result has no
   * explicit default, the first entry becomes default. Returns the new list.
   */
  async upsert(
    entry: Omit<DaemonEntry, 'default'> & { default?: boolean },
  ): Promise<DaemonEntry[]> {
    const current = await this.load();
    const idx = current.findIndex((e) => e.name === entry.name);
    const next = [...current];
    if (idx >= 0) {
      next[idx] = { ...entry, ...(entry.default ? { default: true } : {}) };
    } else {
      next.push({ ...entry });
    }
    assertValid(next);
    const normalized = normalizeDefaults(next);
    await this.save(normalized);
    return normalized;
  }

  /** Remove by name; no-op if absent. Promotes the first remaining entry to default. */
  async remove(name: string): Promise<DaemonEntry[]> {
    const current = await this.load();
    const next = current.filter((e) => e.name !== name);
    assertValid(next);
    const normalized = normalizeDefaults(next);
    await this.save(normalized);
    return normalized;
  }

  /** Flip `default` to the named entry (clearing it from all others). */
  async setDefault(name: string): Promise<DaemonEntry[]> {
    const current = await this.load();
    if (!current.some((e) => e.name === name)) {
      throw new Error(`no such daemon: ${name}`);
    }
    const next = current.map((e) =>
      e.name === name ? { ...e, default: true } : { ...e, default: undefined },
    );
    assertValid(next);
    await this.save(next);
    return next;
  }

  /** Atomic write: temp file (mode 0600) in the same dir, then rename. */
  async save(entries: DaemonEntry[]): Promise<void> {
    assertValid(entries);
    await fs.mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp.${process.pid}.${randomInt(0x10000000).toString(16)}`;
    await fs.writeFile(tmp, serializeRegistry(entries), { mode: 0o600 });
    try {
      await fs.rename(tmp, this.path);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }
}
