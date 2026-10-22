/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  opendir,
  readlink,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';

export type RecoveryRpc = (method: string, params: unknown) => Promise<unknown>;
export interface BundleEntry {
  type: 'entry';
  path: string;
  entryType: 'file' | 'directory' | 'symlink';
  mode: number;
  byteLength?: number;
  digest?: string;
  target?: string;
}
export interface BundleIndex {
  path: string;
  count: number;
  byteLength: number;
  digest: string;
}

export function recoveryDigest(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function recoveryJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(recoveryJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${recoveryJson(record[key])}`)
      .join(',')}}`;
  }
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('invalid_metadata');
  return result;
}

export function recoveryAssetKey(type: string, ...identity: string[]): string {
  return recoveryDigest(
    JSON.stringify(['qwen-workspace-recovery-asset-v1', type, ...identity]),
  );
}

function inside(root: string, path: string): boolean {
  const name = relative(root, path);
  return (
    name === '' ||
    (!isAbsolute(name) && name !== '..' && !name.startsWith('../'))
  );
}

function safeRelative(name: string): void {
  if (
    !name ||
    name.includes('\0') ||
    isAbsolute(name) ||
    name.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('invalid_bundle_path');
  }
}

async function fileDigest(
  path: string,
): Promise<{ byteLength: number; digest: string }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1)
      throw new Error('unsupported_file_type');
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(1024 * 1024);
    let byteLength = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      byteLength += bytesRead;
      hash.update(chunk.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (
      before.size !== byteLength ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error('file_changed_during_read');
    }
    return { byteLength, digest: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

class UnsupportedEntryError extends Error {
  constructor(
    code: string,
    readonly entryPath: string,
  ) {
    super(code);
  }
}

export class UnsupportedSourceEntryError extends Error {
  constructor(
    readonly entryPath: string,
    readonly reason: string,
  ) {
    super('unsupported_source_entry');
  }
}

async function entry(
  root: string,
  name: string,
  boundary = root,
): Promise<BundleEntry> {
  safeRelative(name);
  const path = join(root, name);
  const stat = await lstat(path);
  const common = {
    type: 'entry' as const,
    path: name,
    mode: stat.mode & 0o7777,
  };
  if (stat.isDirectory()) return { ...common, entryType: 'directory' };
  if (stat.isFile()) {
    try {
      return { ...common, entryType: 'file', ...(await fileDigest(path)) };
    } catch (error) {
      if (error instanceof Error && error.message === 'unsupported_file_type')
        throw new UnsupportedEntryError(error.message, name);
      throw error;
    }
  }
  if (stat.isSymbolicLink()) {
    const target = await readlink(path);
    if (isAbsolute(target))
      throw new UnsupportedEntryError('unsupported_symlink', name);
    let resolved: string;
    try {
      resolved = await realpath(path);
    } catch (error) {
      if (
        ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(
          (error as NodeJS.ErrnoException).code ?? '',
        ) &&
        (await lstat(path)).isSymbolicLink()
      )
        throw new UnsupportedEntryError('unsupported_symlink', name);
      throw error;
    }
    if (!inside(boundary, resolved))
      throw new UnsupportedEntryError('unsupported_symlink', name);
    return { ...common, entryType: 'symlink', target };
  }
  throw new UnsupportedEntryError('unsupported_file_type', name);
}

async function* tree(
  root: string,
  name: string,
  boundary = join(root, name),
): AsyncGenerator<BundleEntry> {
  const current = await entry(root, name, boundary);
  yield current;
  if (current.entryType !== 'directory') return;
  const directory = await opendir(join(root, name));
  for await (const child of directory) {
    yield* tree(root, `${name}/${child.name}`, boundary);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function sourceReadDrift(error: unknown): boolean {
  return (
    ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(
      (error as NodeJS.ErrnoException).code ?? '',
    ) ||
    (error instanceof Error &&
      [
        'missing_bundle_asset',
        'file_changed_during_read',
        'unsupported_symlink',
        'unsupported_file_type',
        'invalid_source_root',
      ].includes(error.message))
  );
}

async function* sourceTree(
  root: string,
  unpinned?: (entryPath: string) => Promise<boolean>,
): AsyncGenerator<BundleEntry> {
  try {
    yield* tree(dirname(root), basename(root));
  } catch (error) {
    if (
      error instanceof UnsupportedEntryError &&
      (await unpinned?.(error.entryPath))
    )
      throw new UnsupportedSourceEntryError(error.entryPath, error.message);
    if (sourceReadDrift(error)) throw new Error('source_drift');
    throw error;
  }
}

async function sourceExists(path: string): Promise<boolean> {
  try {
    return await exists(path);
  } catch (error) {
    if (sourceReadDrift(error)) throw new Error('source_drift');
    throw error;
  }
}

export class LocalRecoveryBundle {
  constructor(
    readonly root: string,
    readonly operationId: string,
    readonly mode: 'capture' | 'verify',
    private readonly rpc: RecoveryRpc,
  ) {}

  async initialize(sourceRoot: string, historyRoot: string): Promise<void> {
    if ((await realpath(this.root)) !== this.root)
      throw new Error('invalid_bundle_root');
    if (!(await lstat(this.root)).isDirectory())
      throw new Error('invalid_bundle_root');
    for (const source of [sourceRoot, historyRoot]) {
      if (
        resolve(source) !== source ||
        inside(source, this.root) ||
        inside(this.root, source)
      )
        throw new Error('overlapping_roots');
      if (this.mode === 'capture') {
        try {
          if (source !== sourceRoot && !(await exists(source))) continue;
          if (
            (await realpath(source)) !== source ||
            !(await lstat(source)).isDirectory()
          )
            throw new Error('invalid_source_root');
        } catch (error) {
          if (
            source === sourceRoot &&
            sourceReadDrift(error) &&
            (await this.rpc('assetLookup', {
              key: recoveryAssetKey('entry', 'workspace'),
            })) !== null
          )
            throw new Error('source_drift');
          if (source === historyRoot && sourceReadDrift(error)) {
            let afterKey: string | null = null;
            do {
              const page = (await this.rpc('assetPage', { afterKey })) as {
                assets: Array<{ metadata: Record<string, unknown> }>;
                nextKey: string | null;
              };
              if (
                page.assets.some(
                  ({ metadata }) =>
                    metadata['type'] === 'entry' &&
                    typeof metadata['path'] === 'string' &&
                    metadata['path'].startsWith('file-history/'),
                )
              )
                throw new Error('source_drift');
              afterKey = page.nextKey;
            } while (afterKey !== null);
          }
          throw error;
        }
      }
    }
    if (inside(sourceRoot, historyRoot) || inside(historyRoot, sourceRoot))
      throw new Error('overlapping_roots');
    if (this.mode === 'capture') {
      for (const path of [
        'file-history',
        'authority',
        'authority/objects',
        '.w1-recovery',
      ]) {
        await mkdir(join(this.root, path), { mode: 0o700 }).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== 'EEXIST') throw error;
          },
        );
        if (!(await lstat(join(this.root, path))).isDirectory())
          throw new Error('invalid_bundle_path');
      }
      for (const path of ['file-history', 'authority', 'authority/objects'])
        await this.recordEntry(await entry(this.root, path));
      for (const name of [
        'sessions.ndjson',
        'assets.ndjson',
        'manifest.json',
      ]) {
        const temporary = join(
          this.root,
          '.w1-recovery',
          `${name}.partial-${this.operationId}`,
        );
        if (await exists(temporary)) {
          const stat = await lstat(temporary);
          if (!stat.isFile() || stat.nlink !== 1)
            throw new Error('invalid_temporary_file');
          await unlink(temporary);
        }
      }
    } else {
      for (const path of [
        'workspace',
        'file-history',
        'authority',
        'authority/objects',
        '.w1-recovery',
      ]) {
        if (!(await lstat(join(this.root, path))).isDirectory())
          throw new Error('invalid_bundle_path');
      }
    }
  }

  async asset(
    type: string,
    identity: string[],
    metadata: unknown,
  ): Promise<void> {
    const key = recoveryAssetKey(type, ...identity);
    const saved = await this.rpc('asset', { key, metadata });
    if (recoveryJson(saved) !== recoveryJson(metadata))
      throw new Error('asset_conflict');
  }

  async lookup(
    type: string,
    ...identity: string[]
  ): Promise<Record<string, unknown>> {
    const saved = await this.rpc('assetLookup', {
      key: recoveryAssetKey(type, ...identity),
    });
    if (saved === null || typeof saved !== 'object' || Array.isArray(saved))
      throw new Error('missing_bundle_asset');
    return saved as Record<string, unknown>;
  }

  private async recordEntry(value: BundleEntry): Promise<void> {
    await this.asset('entry', [value.path], value);
  }

  async compareTree(sourceRoot: string, candidate: string): Promise<void> {
    const candidateRoot = join(this.root, candidate);
    if (!(await lstat(candidateRoot)).isDirectory())
      throw new Error('missing_bundle_tree');
    if (
      (await this.rpc('assetLookup', {
        key: recoveryAssetKey('tree', candidate),
      })) !== null
    )
      await this.recheckTree(sourceRoot, candidate);
    else if (
      (await this.rpc('assetLookup', {
        key: recoveryAssetKey('entry', candidate),
      })) !== null
    ) {
      let afterKey: string | null = null;
      do {
        const page = (await this.rpc('assetPage', { afterKey })) as {
          assets: Array<{ metadata: Record<string, unknown> }>;
          nextKey: string | null;
        };
        for (const { metadata: saved } of page.assets) {
          const path = saved['path'];
          if (
            saved['type'] !== 'entry' ||
            typeof path !== 'string' ||
            !(path === candidate || path.startsWith(`${candidate}/`))
          )
            continue;
          let original: BundleEntry;
          try {
            original = await entry(
              dirname(sourceRoot),
              `${basename(sourceRoot)}${path.slice(candidate.length)}`,
              sourceRoot,
            );
          } catch (error) {
            if (sourceReadDrift(error)) throw new Error('source_drift');
            throw error;
          }
          if (recoveryJson(saved) !== recoveryJson({ ...original, path }))
            throw new Error('source_drift');
        }
        afterKey = page.nextKey;
      } while (afterKey !== null);
    }
    let count = 0;
    const unpinned = async (entryPath: string) =>
      (await this.rpc('assetLookup', {
        key: recoveryAssetKey(
          'entry',
          `${candidate}${entryPath.slice(basename(sourceRoot).length)}`,
        ),
      })) === null;
    // Symlink resolution is relative to the complete tree, not to each parent.
    for await (const original of sourceTree(sourceRoot, unpinned)) {
      const suffix = original.path.slice(basename(sourceRoot).length);
      const name = `${candidate}${suffix}`;
      const saved = await this.rpc('assetLookup', {
        key: recoveryAssetKey('entry', name),
      });
      if (
        saved !== null &&
        recoveryJson(saved) !== recoveryJson({ ...original, path: name })
      )
        throw new Error('source_drift');
      let copy: BundleEntry;
      try {
        copy = await entry(this.root, name, candidateRoot);
      } catch (error) {
        if (
          ['ENOENT', 'ENOTDIR'].includes(
            (error as NodeJS.ErrnoException).code ?? '',
          )
        )
          throw new Error('snapshot_source_mismatch');
        throw error;
      }
      if (recoveryJson({ ...original, path: name }) !== recoveryJson(copy))
        throw new Error('snapshot_source_mismatch');
      await this.recordEntry(copy);
      count++;
    }
    // Each candidate-only path must already have an original entry.
    for await (const copy of tree(this.root, candidate)) {
      const suffix = copy.path.slice(candidate.length);
      let original: BundleEntry;
      try {
        original = await entry(
          dirname(sourceRoot),
          `${basename(sourceRoot)}${suffix}`,
          sourceRoot,
        );
      } catch (error) {
        if (sourceReadDrift(error)) {
          const pinned = await this.rpc('assetLookup', {
            key: recoveryAssetKey('entry', copy.path),
          });
          throw new Error(
            pinned === null ? 'snapshot_source_mismatch' : 'source_drift',
          );
        }
        throw error;
      }
      if (recoveryJson({ ...original, path: copy.path }) !== recoveryJson(copy))
        throw new Error('snapshot_source_mismatch');
    }
    await this.asset('tree', [candidate], {
      type: 'tree',
      path: candidate,
      count,
    });
  }

  async history(sessionId: string, historyRoot: string): Promise<void> {
    safeRelative(sessionId);
    if (sessionId.includes('/')) throw new Error('invalid_session_id');
    const source = join(historyRoot, sessionId);
    const candidate = `file-history/${sessionId}`;
    if (await sourceExists(source)) await this.compareTree(source, candidate);
    else if (
      (await this.rpc('assetLookup', {
        key: recoveryAssetKey('entry', candidate),
      })) !== null
    )
      throw new Error('source_drift');
    else if (await exists(join(this.root, candidate)))
      throw new Error('snapshot_source_mismatch');
  }

  async recheckTree(sourceRoot: string, candidate: string): Promise<void> {
    let count = 0;
    for await (const original of sourceTree(sourceRoot)) {
      const name = `${candidate}${original.path.slice(basename(sourceRoot).length)}`;
      let saved: Record<string, unknown>;
      try {
        saved = await this.lookup('entry', name);
      } catch (error) {
        if (sourceReadDrift(error)) throw new Error('source_drift');
        throw error;
      }
      if (recoveryJson(saved) !== recoveryJson({ ...original, path: name }))
        throw new Error('source_drift');
      count++;
    }
    const expected = await this.lookup('tree', candidate);
    if (count !== expected['count']) throw new Error('source_drift');
  }

  async recheckHistory(sessionId: string, historyRoot: string): Promise<void> {
    safeRelative(sessionId);
    if (sessionId.includes('/')) throw new Error('invalid_session_id');
    const source = join(historyRoot, sessionId);
    const candidate = `file-history/${sessionId}`;
    const saved = await this.rpc('assetLookup', {
      key: recoveryAssetKey('entry', candidate),
    });
    if (await sourceExists(source)) await this.recheckTree(source, candidate);
    else if (saved !== null) throw new Error('source_drift');
  }

  async verifyMigrationTree(
    root: string,
    candidate: string,
    marker?: { digest: string; byteLength: number },
  ): Promise<void> {
    const mismatch = marker ? 'migration_tree_mismatch' : 'source_drift';
    try {
      if ((await realpath(root)) !== root || !(await lstat(root)).isDirectory())
        throw new Error('invalid_source_root');
      let count = 0;
      for await (const actual of tree(dirname(root), basename(root), root)) {
        const name = `${candidate}${actual.path.slice(basename(root).length)}`;
        const saved = await this.lookup('entry', name);
        let expected = saved;
        if (marker && name === 'workspace/.qwen-managed-storage.json') {
          const original =
            recoveryJson({ ...actual, path: name }) === recoveryJson(saved);
          if (!original) expected = { ...saved, ...marker };
        }
        if (recoveryJson(expected) !== recoveryJson({ ...actual, path: name }))
          throw new Error(mismatch);
        count++;
      }
      const expected = await this.lookup('tree', candidate);
      if (expected['count'] !== count) throw new Error(mismatch);
    } catch (error) {
      if (sourceReadDrift(error)) throw new Error(mismatch);
      throw error;
    }
  }

  async backup(ownerSessionId: string, backupFileName: string): Promise<void> {
    safeRelative(ownerSessionId);
    safeRelative(backupFileName);
    if (ownerSessionId.includes('/') || backupFileName.includes('/'))
      throw new Error('invalid_backup_path');
    const name = `file-history/${ownerSessionId}/${backupFileName}`;
    const actual = await entry(this.root, name);
    if (actual.entryType !== 'file') throw new Error('missing_history_backup');
    const expected = await this.lookup('entry', name);
    if (recoveryJson(expected) !== recoveryJson(actual))
      throw new Error('history_backup_mismatch');
    await this.recordEntry(actual);
  }

  async blob(bytes: Buffer): Promise<string> {
    const name = `authority/objects/${recoveryDigest(bytes)}`;
    if (this.mode === 'capture')
      await this.publish(
        name,
        (async function* () {
          yield bytes;
        })(),
      );
    const actual = await entry(this.root, name);
    if (
      actual.entryType !== 'file' ||
      actual.byteLength !== bytes.length ||
      actual.digest !== recoveryDigest(bytes)
    )
      throw new Error('bundle_digest_mismatch');
    await this.recordEntry(actual);
    return name;
  }

  async readBlob(
    name: unknown,
    digest: string,
    byteLength: number,
  ): Promise<Buffer> {
    if (
      typeof name !== 'string' ||
      name !== `authority/objects/${digest}` ||
      byteLength < 0 ||
      byteLength > 16 * 1024 * 1024
    )
      throw new Error('invalid_bundle_blob');
    const handle = await open(
      join(this.root, name),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size !== byteLength)
        throw new Error('bundle_digest_mismatch');
      const bytes = await handle.readFile();
      if (bytes.length !== byteLength || recoveryDigest(bytes) !== digest)
        throw new Error('bundle_digest_mismatch');
      await this.recordEntry(await entry(this.root, name));
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async publish(
    name: string,
    chunks: AsyncIterable<Buffer>,
  ): Promise<BundleIndex> {
    safeRelative(name);
    const target = join(this.root, name);
    const temporary = `${target}.partial-${this.operationId}`;
    if (await exists(temporary)) {
      if (
        !(await lstat(temporary)).isFile() ||
        (await lstat(temporary)).nlink !== 1
      )
        throw new Error('invalid_temporary_file');
      await unlink(temporary);
    }
    const handle = await open(
      temporary,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    const hash = createHash('sha256');
    let byteLength = 0;
    let count = 0;
    try {
      for await (const bytes of chunks) {
        hash.update(bytes);
        byteLength += bytes.length;
        count++;
        await handle.writeFile(bytes);
      }
      await handle.sync();
      await handle.close();
      const digest = hash.digest('hex');
      if (await exists(target)) {
        const saved = await fileDigest(target);
        if (saved.digest !== digest || saved.byteLength !== byteLength)
          throw new Error('bundle_object_conflict');
        await unlink(temporary);
      } else await rename(temporary, target);
      const directory = await open(
        dirname(target),
        constants.O_RDONLY | constants.O_DIRECTORY,
      );
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return { path: name, count, byteLength, digest };
    } finally {
      await handle.close().catch(() => undefined);
      if (await exists(temporary)) await unlink(temporary);
    }
  }

  async census(): Promise<number> {
    let count = 0;
    const directory = await opendir(this.root);
    for await (const child of directory) {
      if (child.name === '.w1-recovery') {
        if (!child.isDirectory()) throw new Error('invalid_metadata_directory');
        for await (const metadata of await opendir(
          join(this.root, child.name),
        )) {
          if (
            !['manifest.json', 'sessions.ndjson', 'assets.ndjson'].includes(
              metadata.name,
            ) ||
            !metadata.isFile()
          )
            throw new Error('undeclared_bundle_entry');
        }
        continue;
      }
      if (!['workspace', 'file-history', 'authority'].includes(child.name))
        throw new Error('undeclared_bundle_entry');
      for await (const actual of tree(this.root, child.name)) {
        const saved = await this.lookup('entry', actual.path);
        if (recoveryJson(saved) !== recoveryJson(actual))
          throw new Error('bundle_entry_mismatch');
        await this.recordEntry(actual);
        count++;
      }
    }
    let expectedCount = 0;
    let afterKey: string | null = null;
    do {
      const page = (await this.rpc('assetPage', { afterKey })) as {
        assets: Array<{ key: string; metadata: Record<string, unknown> }>;
        nextKey: string | null;
      };
      for (const asset of page.assets)
        if (asset.metadata['type'] === 'entry') expectedCount++;
      afterKey = page.nextKey;
    } while (afterKey !== null);
    if (count !== expectedCount) throw new Error('missing_bundle_entry');
    return count;
  }

  async checkIndex(expected: BundleIndex): Promise<void> {
    safeRelative(expected.path);
    const actual = await fileDigest(join(this.root, expected.path));
    if (
      actual.digest !== expected.digest ||
      actual.byteLength !== expected.byteLength
    )
      throw new Error('bundle_index_mismatch');
  }

  async readManifest(digest: string): Promise<Record<string, unknown>> {
    const path = join(this.root, '.w1-recovery/manifest.json');
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024)
        throw new Error('invalid_manifest');
      const bytes = await handle.readFile();
      if (recoveryDigest(bytes) !== digest)
        throw new Error('bundle_manifest_mismatch');
      return JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    } finally {
      await handle.close();
    }
  }
}
