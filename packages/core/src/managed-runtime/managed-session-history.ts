/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  rename,
  rmdir,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { openNoFollow } from '../utils/no-follow-open.js';

export const MANAGED_HISTORY_LIMITS = Object.freeze({
  pageBytes: 64 * 1024,
  cacheBytes: 4 * 1024 * 1024,
  cacheEntries: 2048,
  eventBytes: 8 * 1024 * 1024,
  eventEntries: 1024,
});

export type ManagedHistoryFamily =
  | 'catalog'
  | 'event'
  | 'event-id'
  | 'event-correlation'
  | 'event-link'
  | 'command'
  | 'command-id'
  | 'receipt'
  | 'checkpoint'
  | 'hook-activation'
  | 'domain-event'
  | 'extension-event'
  | 'extension'
  | 'extension-version'
  | 'opening-operation'
  | 'hook-once'
  | 'hook-occurrence'
  | 'hook-ordinal'
  | 'hook-definition'
  | 'child-continuation'
  | 'action'
  | 'resource'
  | 'resource-pending'
  | 'activation'
  | 'epoch'
  | 'inbox'
  | 'input-state';

type Entry = readonly [key: string, value: string, byteLength: number];
type Page =
  | { readonly type: 'leaf'; readonly entries: readonly Entry[] }
  | {
      readonly type: 'branch';
      readonly children: ReadonlyArray<string | null>;
    };

export class ManagedHistoryUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ManagedHistoryUnavailableError';
  }
}

export class ManagedHistoryCache<T> {
  private readonly entries = new Map<string, { value: T; bytes: number }>();
  private bytes = 0;

  get size(): number {
    return this.entries.size;
  }

  get byteLength(): number {
    return this.bytes;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, bytes: number): void {
    const previous = this.entries.get(key);
    if (previous) {
      this.entries.delete(key);
      this.bytes -= previous.bytes;
    }
    if (bytes > MANAGED_HISTORY_LIMITS.cacheBytes) return;
    this.entries.set(key, { value, bytes });
    this.bytes += bytes;
    while (
      this.entries.size > MANAGED_HISTORY_LIMITS.cacheEntries ||
      this.bytes > MANAGED_HISTORY_LIMITS.cacheBytes
    ) {
      const oldest = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(oldest)!.bytes;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}

function digest(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function requireHistory(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new ManagedHistoryUnavailableError(message);
}

class HistoryOwner {
  readonly cache = new ManagedHistoryCache<Buffer>();
  closing = false;
  closed = false;
  private active = 0;
  private drained: (() => void) | undefined;
  private closingPromise: Promise<void> | undefined;

  async run<T>(read: () => Promise<T>): Promise<T> {
    requireHistory(!this.closing, 'History view is closing.');
    this.active++;
    try {
      return await read();
    } finally {
      if (--this.active === 0) this.drained?.();
    }
  }

  close(directory: string): Promise<void> {
    this.closingPromise ??= (async () => {
      this.closing = true;
      if (this.active > 0)
        await new Promise<void>((resolve) => {
          this.drained = resolve;
        });
      this.closed = true;
      this.cache.clear();
      let entries;
      try {
        entries = await opendir(directory, { bufferSize: 32 });
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw cause;
      }
      let pending: Array<Promise<void>> = [];
      for await (const entry of entries) {
        requireHistory(
          !entry.isDirectory(),
          'History scratch contains an unexpected directory.',
        );
        pending.push(
          unlink(path.join(directory, entry.name)).catch(
            (cause: NodeJS.ErrnoException) => {
              if (cause.code !== 'ENOENT') throw cause;
            },
          ),
        );
        if (pending.length === 32) {
          await Promise.all(pending);
          pending = [];
        }
      }
      await Promise.all(pending);
      await rmdir(directory).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code !== 'ENOENT') throw cause;
      });
    })();
    return this.closingPromise;
  }
}

/** A disposable query view, rebuilt from this owner's verified source. */
export class FileManagedSessionHistory {
  private root: string | null = null;
  private batch: Map<string, Buffer> | undefined;
  private readonly counts = new Map<ManagedHistoryFamily, number>();
  private previousCounts: Map<ManagedHistoryFamily, number> | undefined;
  private writes: Promise<void> = Promise.resolve();
  private rebuilder?: (view: FileManagedSessionHistory) => Promise<void>;
  private rebuilding?: Promise<string | null>;
  private repairedRoot?: { before: string | null; after: string | null };
  private repairGeneration = 0;

  private constructor(
    readonly directory: string,
    private readonly owner = new HistoryOwner(),
    private readonly ownsDirectory = true,
    private readonly repairWrites = false,
  ) {}
  private released = false;

  fork(): FileManagedSessionHistory {
    requireHistory(
      !this.batch,
      'An unfinished history overlay must settle first.',
    );
    requireHistory(
      !this.released && !this.owner.closing,
      'History view is closing.',
    );
    const fork = new FileManagedSessionHistory(
      this.directory,
      this.owner,
      this.ownsDirectory,
      this.repairWrites,
    );
    fork.root = this.root;
    fork.rebuilder = this.rebuilder;
    fork.repairedRoot = this.repairedRoot;
    for (const [family, count] of this.counts) fork.counts.set(family, count);
    return fork;
  }

  snapshot(): FileManagedSessionHistory {
    requireHistory(
      !this.released && !this.owner.closing,
      'History view is closing.',
    );
    const snapshot = new FileManagedSessionHistory(
      this.directory,
      this.owner,
      false,
      this.repairWrites,
    );
    snapshot.root = this.root;
    snapshot.rebuilder = this.rebuilder;
    snapshot.repairedRoot = this.repairedRoot;
    snapshot.batch = this.batch && new Map(this.batch);
    for (const [family, count] of this.counts)
      snapshot.counts.set(family, count);
    return snapshot;
  }

  emptyView(): FileManagedSessionHistory {
    requireHistory(
      !this.released && !this.owner.closing,
      'History view is closing.',
    );
    return new FileManagedSessionHistory(
      this.directory,
      this.owner,
      false,
      this.repairWrites,
    );
  }

  setRebuilder(
    rebuild: (view: FileManagedSessionHistory) => Promise<void>,
  ): void {
    requireHistory(
      !this.released && !this.owner.closing,
      'History view is closing.',
    );
    this.rebuilder = rebuild;
    this.repairedRoot = undefined;
  }

  private async withRepair<T>(
    operation: (repairedRoot?: string | null) => Promise<T>,
    root = this.root,
    rebuild = this.rebuilder,
    generation = this.repairGeneration,
  ): Promise<T> {
    try {
      return await operation();
    } catch (cause) {
      if (
        !(cause instanceof ManagedHistoryUnavailableError) ||
        !rebuild ||
        this.released ||
        this.owner.closing
      )
        throw cause;
      if (generation !== this.repairGeneration) {
        const repaired = this.repairedRoot;
        requireHistory(
          this.rebuilder === rebuild &&
            repaired !== undefined &&
            this.root === repaired.after,
          'History prefix advanced while rebuilding; reopen the query.',
        );
        return operation(repaired.after);
      }
      if (!this.rebuilding) {
        this.rebuilding = (async () => {
          requireHistory(
            this.root === root && this.rebuilder === rebuild,
            'History prefix advanced while rebuilding; reopen the query.',
          );
          const repair = new FileManagedSessionHistory(
            this.directory,
            this.owner,
            false,
            true,
          );
          this.owner.cache.clear();
          try {
            await rebuild(repair);
            requireHistory(
              this.root === root &&
                this.rebuilder === rebuild &&
                !this.owner.closing,
              'History prefix advanced while rebuilding; reopen the query.',
            );
            const rebuiltRoot = repair.root;
            const originalRoot =
              this.repairedRoot?.after === root
                ? this.repairedRoot.before
                : root;
            this.root = rebuiltRoot;
            this.repairedRoot = { before: originalRoot, after: rebuiltRoot };
            this.repairGeneration++;
            if (!this.batch) {
              this.counts.clear();
              for (const [family, count] of repair.counts)
                this.counts.set(family, count);
            }
            return rebuiltRoot;
          } finally {
            await repair.close();
          }
        })();
      }
      const repairing = this.rebuilding;
      let rebuiltRoot: string | null;
      try {
        rebuiltRoot = await repairing;
      } finally {
        if (this.rebuilding === repairing) this.rebuilding = undefined;
      }
      return operation(rebuiltRoot);
    }
  }

  static async create(parent: string): Promise<FileManagedSessionHistory> {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const stat = await lstat(parent);
    requireHistory(
      stat.isDirectory() && !stat.isSymbolicLink(),
      'History scratch must be a real directory.',
    );
    return new FileManagedSessionHistory(
      await mkdtemp(path.join(parent, 'view-')),
    );
  }

  map<T>(family: ManagedHistoryFamily): ManagedHistoryMap<T> {
    return new ManagedHistoryMap<T>(this, family);
  }

  count(family: ManagedHistoryFamily): number {
    requireHistory(
      !this.released && !this.owner.closing,
      'History view is closing.',
    );
    return this.counts.get(family) ?? 0;
  }

  get rootDigest(): string | null {
    return this.root;
  }

  get cacheUsage(): { entries: number; bytes: number } {
    return {
      entries: this.owner.cache.size,
      bytes: this.owner.cache.byteLength,
    };
  }

  loadBody(key: string, read: () => Promise<Buffer>): Promise<Buffer> {
    if (this.released)
      return Promise.reject(
        new ManagedHistoryUnavailableError('History view has closed.'),
      );
    return this.owner.run(async () => {
      const cacheKey = `body:${key}`;
      const cached = this.owner.cache.get(cacheKey);
      if (cached) return cached;
      const bytes = await read();
      this.owner.cache.set(cacheKey, bytes, bytes.byteLength);
      return bytes;
    });
  }

  writeBlock(bytes: Buffer): Promise<string> {
    if (this.released)
      return Promise.reject(
        new ManagedHistoryUnavailableError('History view has closed.'),
      );
    return this.owner.run(() => this.withRepair(() => this.writeBlob(bytes)));
  }

  readBlock(ref: string, byteLength: number): Promise<Buffer> {
    if (this.released)
      return Promise.reject(
        new ManagedHistoryUnavailableError('History view has closed.'),
      );
    return this.owner.run(() =>
      this.withRepair(() => this.readBlob(ref, byteLength)),
    );
  }

  begin(): void {
    requireHistory(
      !this.released && !this.owner.closing,
      'History view is closing.',
    );
    requireHistory(this.batch === undefined, 'History batch is already open.');
    this.batch = new Map();
    this.previousCounts = new Map(this.counts);
  }

  flush(): Promise<void> {
    return this.owner.run(() => this.withRepair(() => this.flushOnce()));
  }

  private async flushOnce(): Promise<void> {
    const batch = this.batch;
    if (!batch) return;
    const entries: Entry[] = [];
    for (const [key, value] of batch) {
      const bytes = Buffer.from(
        JSON.stringify({
          key,
          value: JSON.parse(value.toString('utf8')) as unknown,
        }),
      );
      entries.push([
        digest(key),
        await this.writeBlob(bytes),
        bytes.byteLength,
      ]);
    }
    const root = await this.insertMany(this.root, entries, 0);
    this.root = root;
    this.batch = undefined;
    this.previousCounts = undefined;
  }

  discard(): void {
    if (this.previousCounts) {
      this.counts.clear();
      for (const [family, count] of this.previousCounts)
        this.counts.set(family, count);
    }
    this.batch = undefined;
    this.previousCounts = undefined;
  }

  get<T>(
    family: ManagedHistoryFamily,
    identity: string,
    root = this.root,
  ): Promise<T | undefined> {
    if (this.released)
      return Promise.reject(
        new ManagedHistoryUnavailableError('History view has closed.'),
      );
    const resolvedRoot =
      this.repairedRoot?.before === root ? this.repairedRoot.after : root;
    return this.owner.run(() =>
      this.withRepair(
        (repairedRoot) =>
          this.getOnce<T>(
            family,
            identity,
            repairedRoot === undefined ? resolvedRoot : repairedRoot,
          ),
        resolvedRoot,
      ),
    );
  }

  private async getOnce<T>(
    family: ManagedHistoryFamily,
    identity: string,
    root: string | null,
  ): Promise<T | undefined> {
    const key = JSON.stringify([family, identity]);
    const pending = root === this.root ? this.batch?.get(key) : undefined;
    if (pending) return JSON.parse(pending.toString('utf8')) as T;
    const hash = digest(key);
    let ref = root;
    let depth = 0;
    while (ref !== null) {
      const page = await this.readPage(ref);
      if (page.type === 'leaf') {
        const entry = page.entries.find(([stored]) => stored === hash);
        if (!entry) return undefined;
        const stored = JSON.parse(
          (await this.readBlob(entry[1], entry[2])).toString('utf8'),
        ) as { key: string; value: T };
        requireHistory(
          stored.key === key,
          'History identity conflicts with its key digest.',
        );
        return stored.value;
      }
      requireHistory(depth < hash.length, 'History branch exceeds key depth.');
      ref = page.children[Number.parseInt(hash[depth++], 16)];
    }
    return undefined;
  }

  set<T>(
    family: ManagedHistoryFamily,
    identity: string,
    value: T,
  ): Promise<void> {
    if (this.released)
      return Promise.reject(
        new ManagedHistoryUnavailableError('History view has closed.'),
      );
    const result = this.owner.run(() =>
      this.writes.then(() =>
        this.withRepair(() => this.setOnce(family, identity, value)),
      ),
    );
    this.writes = result.catch(() => undefined);
    return result;
  }

  private async setOnce<T>(
    family: ManagedHistoryFamily,
    identity: string,
    value: T,
  ): Promise<void> {
    const implicit = this.batch === undefined;
    if (implicit) this.begin();
    try {
      if ((await this.getOnce(family, identity, this.root)) === undefined) {
        const count = this.counts.get(family) ?? 0;
        const catalogKey = `${family}\u0000${Math.floor(count / 100)}`;
        const page =
          (await this.getOnce<Array<readonly [string, number]>>(
            'catalog',
            catalogKey,
            this.root,
          )) ?? [];
        const identityBytes = Buffer.from(JSON.stringify(identity));
        const identityRef = await this.writeBlob(identityBytes);
        await this.setValue('catalog', catalogKey, [
          ...page,
          [identityRef, identityBytes.byteLength],
        ]);
        this.counts.set(family, count + 1);
      }
      await this.setValue(family, identity, value);
      if (implicit) await this.flushOnce();
    } catch (error) {
      if (implicit) this.discard();
      throw error;
    }
  }

  private async setValue<T>(
    family: ManagedHistoryFamily,
    identity: string,
    value: T,
  ): Promise<void> {
    const key = JSON.stringify([family, identity]);
    const bytes = Buffer.from(JSON.stringify(value));
    if (this.batch) {
      this.batch.set(key, bytes);
      return;
    }
    throw new ManagedHistoryUnavailableError(
      'History mutation has no transaction overlay.',
    );
  }

  entries<T>(
    family: ManagedHistoryFamily,
    root = this.root,
  ): AsyncGenerator<readonly [string, T]> {
    const count = this.counts.get(family) ?? 0;
    const view = this.snapshot();
    return view.readEntries(family, root, count);
  }

  private async *readEntries<T>(
    family: ManagedHistoryFamily,
    root: string | null,
    count: number,
  ): AsyncGenerator<readonly [string, T]> {
    for (let offset = 0; offset < count; offset += 100) {
      const identities = await this.get<Array<readonly [string, number]>>(
        'catalog',
        `${family}\u0000${offset / 100}`,
        root,
      );
      requireHistory(
        Array.isArray(identities) &&
          identities.length === Math.min(100, count - offset),
        'History identity catalog is incomplete.',
      );
      for (const [ref, length] of identities) {
        requireHistory(
          /^[0-9a-f]{64}$/.test(ref) &&
            Number.isSafeInteger(length) &&
            length > 0,
          'History identity catalog has an invalid reference.',
        );
        const identity: unknown = JSON.parse(
          (await this.readBlock(ref, length)).toString('utf8'),
        );
        requireHistory(
          typeof identity === 'string',
          'History identity catalog contains an invalid key.',
        );
        const value = await this.get<T>(family, identity, root);
        requireHistory(
          value !== undefined,
          'History identity value is missing.',
        );
        yield [identity, value];
      }
    }
  }

  close(): Promise<void> {
    if (!this.ownsDirectory) {
      this.released = true;
      return this.writes.then(() => {
        this.batch = undefined;
        this.root = null;
        this.counts.clear();
      });
    }
    return this.owner.close(this.directory);
  }

  private async insertMany(
    ref: string | null,
    updates: readonly Entry[],
    depth: number,
  ): Promise<string | null> {
    if (updates.length === 0) return ref;
    const page: Page =
      ref === null ? { type: 'leaf', entries: [] } : await this.readPage(ref);
    if (page.type === 'branch') {
      requireHistory(depth < 64, 'History key collision exceeds depth.');
      const children = [...page.children];
      for (let slot = 0; slot < 16; slot++) {
        const group = updates.filter(
          ([key]) => Number.parseInt(key[depth], 16) === slot,
        );
        children[slot] = await this.insertMany(
          children[slot],
          group,
          depth + 1,
        );
      }
      return this.writePage({ type: 'branch', children });
    }
    const changed = new Set(updates.map(([key]) => key));
    const entries = page.entries.filter(([key]) => !changed.has(key));
    entries.push(...updates);
    entries.sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    const leaf: Page = { type: 'leaf', entries };
    if (Buffer.byteLength(JSON.stringify(leaf)) <= 2048)
      return this.writePage(leaf);
    if (depth === 64) return this.writePage(leaf);
    const groups: Entry[][] = Array.from({ length: 16 }, () => []);
    for (const item of entries)
      groups[Number.parseInt(item[0][depth], 16)].push(item);
    const children: Array<string | null> = [];
    for (const group of groups) {
      if (group.length === 0) {
        children.push(null);
      } else {
        children.push(await this.insertMany(null, group, depth + 1));
      }
    }
    return this.writePage({ type: 'branch', children });
  }

  private writePage(page: Page): Promise<string> {
    const bytes = Buffer.from(JSON.stringify(page));
    requireHistory(
      bytes.byteLength <= MANAGED_HISTORY_LIMITS.pageBytes,
      'History page exceeds its byte budget.',
    );
    return this.writeBlob(bytes);
  }

  private async readPage(ref: string): Promise<Page> {
    const bytes = await this.readBlob(ref, MANAGED_HISTORY_LIMITS.pageBytes);
    const page = JSON.parse(bytes.toString('utf8')) as Page;
    requireHistory(
      page.type === 'leaf'
        ? Array.isArray(page.entries) &&
            page.entries.every(
              (entry) =>
                Array.isArray(entry) &&
                entry.length === 3 &&
                /^[0-9a-f]{64}$/.test(entry[0]) &&
                /^[0-9a-f]{64}$/.test(entry[1]) &&
                Number.isSafeInteger(entry[2]) &&
                entry[2] > 0,
            )
        : page.type === 'branch' &&
            Array.isArray(page.children) &&
            page.children.length === 16 &&
            page.children.every(
              (child) => child === null || /^[0-9a-f]{64}$/.test(child),
            ),
      'History page has an invalid shape.',
    );
    return page;
  }

  private async writeBlob(bytes: Buffer): Promise<string> {
    requireHistory(!this.owner.closed, 'History view is closed.');
    const hash = digest(bytes);
    if (this.owner.cache.get(hash)?.equals(bytes)) return hash;
    const target = path.join(this.directory, hash);
    const pending = path.join(
      this.directory,
      `.pending-${randomBytes(16).toString('hex')}`,
    );
    try {
      const handle = await open(pending, 'wx', 0o600);
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      try {
        await link(pending, target);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
        let existing: Buffer;
        try {
          existing = await this.readBlob(hash, bytes.byteLength);
        } catch (cause) {
          if (!this.repairWrites) throw cause;
          await rename(pending, target);
          existing = bytes;
        }
        requireHistory(existing.equals(bytes), 'History blob conflicts.');
      }
    } finally {
      await unlink(pending).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code !== 'ENOENT') throw cause;
      });
    }
    this.owner.cache.set(hash, bytes, bytes.byteLength);
    return hash;
  }

  private async readBlob(
    ref: string,
    maximum = 65 * 1024 * 1024,
  ): Promise<Buffer> {
    requireHistory(
      !this.owner.closed && /^[0-9a-f]{64}$/.test(ref),
      'History reference is invalid or closed.',
    );
    const cached = this.owner.cache.get(ref);
    if (cached) {
      requireHistory(
        cached.byteLength <= maximum,
        'History blob exceeds its limit.',
      );
      return cached;
    }
    let handle;
    try {
      handle = await openNoFollow(path.join(this.directory, ref));
      const stat = await handle.stat();
      requireHistory(
        stat.isFile() && stat.size <= maximum,
        'History blob exceeds its limit or is not a file.',
      );
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesRead } = await handle.read(
          bytes,
          offset,
          bytes.byteLength - offset,
          offset,
        );
        requireHistory(bytesRead > 0, 'History blob is truncated.');
        offset += bytesRead;
      }
      requireHistory(
        (await handle.stat()).size === stat.size && digest(bytes) === ref,
        'History blob is truncated or corrupt.',
      );
      this.owner.cache.set(ref, bytes, bytes.byteLength);
      return bytes;
    } catch (cause) {
      throw new ManagedHistoryUnavailableError(
        'History page cannot be verified.',
        { cause },
      );
    } finally {
      await handle?.close();
    }
  }
}

export interface ManagedHistoryReader<T>
  extends AsyncIterable<readonly [string, T]> {
  readonly size: number;
  get(key: string | number): Promise<T | undefined>;
  keys(): AsyncGenerator<string>;
  values(): AsyncGenerator<T>;
}

export function emptyManagedHistoryReader<T>(): ManagedHistoryReader<T> {
  return {
    size: 0,
    async get() {
      return undefined;
    },
    async *keys() {
      /* Empty verified catalog. */
    },
    async *values() {
      /* Empty verified catalog. */
    },
    async *[Symbol.asyncIterator]() {
      /* Empty verified catalog. */
    },
  };
}

export class ManagedHistoryMap<T> implements ManagedHistoryReader<T> {
  constructor(
    private readonly store: FileManagedSessionHistory,
    private readonly family: ManagedHistoryFamily,
  ) {}

  get size(): number {
    return this.store.count(this.family);
  }

  get(key: string | number): Promise<T | undefined> {
    return this.store.get<T>(this.family, String(key));
  }

  async has(key: string | number): Promise<boolean> {
    return (await this.get(key)) !== undefined;
  }

  set(key: string | number, value: T): Promise<void> {
    return this.store.set(this.family, String(key), value);
  }

  [Symbol.asyncIterator](): AsyncGenerator<readonly [string, T]> {
    return this.store.entries<T>(this.family);
  }

  async *values(): AsyncGenerator<T> {
    for await (const [, value] of this) yield value;
  }

  async *keys(): AsyncGenerator<string> {
    for await (const [key] of this) yield key;
  }
}

/** Lazy history operators; terminal operations consume one item at a time. */
export class ManagedHistoryQuery<T> implements AsyncIterable<T> {
  constructor(private readonly source: () => AsyncIterable<T>) {}

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this.source()[Symbol.asyncIterator]();
  }

  filter<S extends T>(
    predicate: (value: T, index: number) => value is S,
  ): ManagedHistoryQuery<S>;
  filter(
    predicate: (value: T, index: number) => boolean | Promise<boolean>,
  ): ManagedHistoryQuery<T>;
  filter(
    predicate: (value: T, index: number) => boolean | Promise<boolean>,
  ): ManagedHistoryQuery<T> {
    const source = () => this.source();
    return new ManagedHistoryQuery(async function* () {
      let index = 0;
      for await (const value of source())
        if (await predicate(value, index++)) yield value;
    });
  }

  map<U>(
    project: (value: T, index: number) => U | Promise<U>,
  ): ManagedHistoryQuery<U> {
    const source = () => this.source();
    return new ManagedHistoryQuery(async function* () {
      let index = 0;
      for await (const value of source()) yield await project(value, index++);
    });
  }

  async find(
    predicate: (value: T) => boolean | Promise<boolean>,
  ): Promise<T | undefined> {
    for await (const value of this) if (await predicate(value)) return value;
    return undefined;
  }

  async findLast(
    predicate: (value: T) => boolean | Promise<boolean>,
  ): Promise<T | undefined> {
    let result: T | undefined;
    for await (const value of this) if (await predicate(value)) result = value;
    return result;
  }

  async some(
    predicate: (value: T) => boolean | Promise<boolean>,
  ): Promise<boolean> {
    return (await this.find(predicate)) !== undefined;
  }

  async every(
    predicate: (value: T) => boolean | Promise<boolean>,
  ): Promise<boolean> {
    return !(await this.some(async (value) => !(await predicate(value))));
  }

  async count(): Promise<number> {
    let count = 0;
    for await (const _value of this) count++;
    return count;
  }

  slice(start: number, end = Number.MAX_SAFE_INTEGER): ManagedHistoryQuery<T> {
    requireHistory(
      Number.isSafeInteger(start) &&
        Number.isSafeInteger(end) &&
        (start >= 0 || start >= -256) &&
        end >= 0,
      'History slice is outside its bounds.',
    );
    const source = () => this.source();
    return new ManagedHistoryQuery(async function* () {
      if (start < 0) {
        const tail: T[] = [];
        for await (const value of source()) {
          tail.push(value);
          if (tail.length > -start) tail.shift();
        }
        for (const value of tail.slice(0, end)) yield value;
      } else {
        let index = 0;
        for await (const value of source()) {
          if (index >= end) break;
          if (index++ >= start) yield value;
        }
      }
    });
  }

  async at(index: number): Promise<T | undefined> {
    for await (const value of this.slice(index, index < 0 ? -index : index + 1))
      return value;
    return undefined;
  }

  async reduce<U>(
    reduce: (result: U, value: T) => U | Promise<U>,
    initial: U,
  ): Promise<U> {
    let result = initial;
    for await (const value of this) result = await reduce(result, value);
    return result;
  }

  async collect(limit: number): Promise<T[]> {
    requireHistory(
      Number.isSafeInteger(limit) && limit >= 0,
      'History collection needs a finite limit.',
    );
    const result: T[] = [];
    for await (const value of this) {
      requireHistory(
        result.length < limit,
        'History result exceeds its collection budget.',
      );
      result.push(value);
    }
    return result;
  }
}
