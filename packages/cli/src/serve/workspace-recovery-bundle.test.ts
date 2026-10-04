/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chmod,
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LocalRecoveryBundle,
  recoveryJson,
  recoveryDigest,
  type RecoveryRpc,
} from './workspace-recovery-bundle.js';

const temporary: string[] = [];
afterEach(async () => {
  for (const root of temporary.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'w1b-bundle-'));
  temporary.push(root);
  const source = join(root, 'source');
  const history = join(root, 'history');
  const candidate = join(root, 'candidate');
  await mkdir(source);
  await mkdir(history);
  await mkdir(candidate);
  await mkdir(join(candidate, 'workspace'));
  const assets = new Map<string, unknown>();
  const rpc: RecoveryRpc = async (method, value) => {
    const params = value as {
      key: string;
      metadata: unknown;
      afterKey: string | null;
    };
    if (method === 'asset') {
      if (
        assets.has(params.key) &&
        recoveryJson(assets.get(params.key)) !== recoveryJson(params.metadata)
      )
        throw new Error('asset_conflict');
      assets.set(params.key, params.metadata);
      return params.metadata;
    }
    if (method === 'assetLookup') return assets.get(params.key) ?? null;
    if (method === 'assetPage') {
      const rows = [...assets]
        .sort(([a], [b]) => a.localeCompare(b))
        .filter(([key]) => key > (params.afterKey ?? ''));
      return {
        assets: rows.slice(0, 32).map(([key, metadata]) => ({ key, metadata })),
        nextKey: rows.length > 32 ? rows[31][0] : null,
      };
    }
    throw new Error(method);
  };
  const bundle = new LocalRecoveryBundle(
    candidate,
    '00000000-0000-4000-8000-000000000001',
    'capture',
    rpc,
  );
  await bundle.initialize(source, history);
  return { root, source, history, candidate, assets, rpc, bundle };
}

describe('local offline recovery bundle', () => {
  it('streams the complete copied tree with unusual names and internal relative links', async () => {
    const f = await fixture();
    await mkdir(join(f.source, 'nested'));
    const bytes = Buffer.alloc(5 * 1024 * 1024 + 17, 0x6b);
    await writeFile(join(f.source, 'constructor\n文件'), bytes);
    await symlink('../constructor\n文件', join(f.source, 'nested', 'link'));
    await cp(f.source, join(f.candidate, 'workspace'), {
      recursive: true,
      verbatimSymlinks: true,
      force: true,
    });
    await f.bundle.compareTree(f.source, 'workspace');
    const count = await f.bundle.census();
    expect(count).toBe(7);
    await f.bundle.compareTree(f.source, 'workspace');
    expect(await f.bundle.census()).toBe(count);
  });

  it.each(['extra', 'missing', 'bytes', 'mode'])(
    'refuses a %s candidate difference',
    async (difference) => {
      const f = await fixture();
      await writeFile(join(f.source, 'file'), 'original');
      await cp(f.source, join(f.candidate, 'workspace'), { recursive: true });
      if (difference === 'extra')
        await writeFile(join(f.candidate, 'workspace', 'extra'), 'x');
      if (difference === 'missing')
        await rm(join(f.candidate, 'workspace', 'file'));
      if (difference === 'bytes')
        await writeFile(join(f.candidate, 'workspace', 'file'), 'changed');
      if (difference === 'mode')
        await chmod(join(f.candidate, 'workspace', 'file'), 0o700);
      await expect(f.bundle.compareTree(f.source, 'workspace')).rejects.toThrow(
        'snapshot_source_mismatch',
      );
      expect(await readFile(join(f.source, 'file'), 'utf8')).toBe('original');
      await rm(join(f.candidate, 'workspace'), { recursive: true });
      await cp(f.source, join(f.candidate, 'workspace'), { recursive: true });
      await f.bundle.compareTree(f.source, 'workspace');
      await f.bundle.census();
    },
  );

  it.each(['removed', 'added'])(
    'refuses a %s source entry after the complete tree was pinned',
    async (change) => {
      const f = await fixture();
      await writeFile(join(f.source, 'file'), 'original');
      await cp(f.source, join(f.candidate, 'workspace'), { recursive: true });
      await f.bundle.compareTree(f.source, 'workspace');
      if (change === 'removed') await rm(join(f.source, 'file'));
      else await writeFile(join(f.source, 'new'), 'new');
      await expect(f.bundle.compareTree(f.source, 'workspace')).rejects.toThrow(
        'source_drift',
      );
    },
  );

  it('refuses a pinned original removed between forward and reverse inventory', async () => {
    const f = await fixture();
    await writeFile(join(f.source, 'file'), 'original');
    await cp(f.source, join(f.candidate, 'workspace'), { recursive: true });
    const bundle = new LocalRecoveryBundle(
      f.candidate,
      f.bundle.operationId,
      'capture',
      async (method, params) => {
        const result = await f.rpc(method, params);
        const value = params as { metadata?: { path?: string } };
        if (method === 'asset' && value.metadata?.path === 'workspace/file')
          await rm(join(f.source, 'file'));
        return result;
      },
    );
    await expect(bundle.compareTree(f.source, 'workspace')).rejects.toThrow(
      'source_drift',
    );
  });

  it.each([
    'absolute',
    'escape',
    'loop',
    'dangling',
    'not-directory',
    'hardlink',
  ])('rejects %s entries before sealing', async (kind) => {
    const f = await fixture();
    await writeFile(join(f.source, 'regular'), 'x');
    if (kind === 'hardlink')
      await link(join(f.source, 'regular'), join(f.source, 'other'));
    else
      await symlink(
        kind === 'absolute'
          ? join(f.source, 'regular')
          : kind === 'escape'
            ? '../history'
            : kind === 'loop'
              ? 'other'
              : kind === 'not-directory'
                ? 'regular/child'
                : 'absent',
        join(f.source, 'other'),
      );
    await cp(f.source, join(f.candidate, 'workspace'), {
      recursive: true,
      verbatimSymlinks: true,
    });
    await expect(f.bundle.compareTree(f.source, 'workspace')).rejects.toThrow(
      'unsupported_source_entry',
    );
  });

  it('pins every retained history backup and treats a missing referenced backup as corruption', async () => {
    const f = await fixture();
    await mkdir(join(f.history, 'session'));
    await writeFile(join(f.history, 'session', 'old.bak'), 'old');
    await cp(
      join(f.history, 'session'),
      join(f.candidate, 'file-history', 'session'),
      { recursive: true },
    );
    await f.bundle.history('session', f.history);
    await f.bundle.backup('session', 'old.bak');
    await rm(join(f.candidate, 'file-history', 'session', 'old.bak'));
    await expect(f.bundle.backup('session', 'old.bak')).rejects.toThrow();
  });

  it('atomically reuses matching exports and refuses conflicting bytes without overwriting them', async () => {
    const f = await fixture();
    const bytes = Buffer.from('authority bytes');
    const name = await f.bundle.blob(bytes);
    await writeFile(
      join(f.candidate, `${name}.partial-${f.bundle.operationId}`),
      'interrupted',
    );
    expect(await f.bundle.blob(bytes)).toBe(name);
    await writeFile(join(f.candidate, name), 'corrupt');
    await expect(f.bundle.blob(bytes)).rejects.toThrow(
      'bundle_object_conflict',
    );
    expect((await readFile(join(f.candidate, name))).toString()).toBe(
      'corrupt',
    );
  });

  it.each(['sessions.ndjson', 'assets.ndjson', 'manifest.json'])(
    'resumes capture after an interrupted %s publication',
    async (name) => {
      const f = await fixture();
      await f.bundle.compareTree(f.source, 'workspace');
      const partial = join(
        f.candidate,
        '.w1-recovery',
        `${name}.partial-${f.bundle.operationId}`,
      );
      await writeFile(partial, 'interrupted');
      await f.bundle.initialize(f.source, f.history);
      await expect(readFile(partial)).rejects.toMatchObject({ code: 'ENOENT' });
      await f.bundle.census();
    },
  );

  it.each(['foreign-operation', 'unknown-name'])(
    'preserves and refuses a %s metadata temporary',
    async (kind) => {
      const f = await fixture();
      await f.bundle.compareTree(f.source, 'workspace');
      const partial = join(
        f.candidate,
        '.w1-recovery',
        kind === 'foreign-operation'
          ? 'assets.ndjson.partial-00000000-0000-4000-8000-000000000002'
          : `unknown.partial-${f.bundle.operationId}`,
      );
      await writeFile(partial, 'foreign');
      await f.bundle.initialize(f.source, f.history);
      await expect(f.bundle.census()).rejects.toThrow(
        'undeclared_bundle_entry',
      );
      expect(await readFile(partial, 'utf8')).toBe('foreign');
    },
  );

  it.each(['symlink', 'hardlink', 'directory'])(
    'refuses an owned %s temporary without touching its target',
    async (kind) => {
      const f = await fixture();
      const original = join(f.source, 'original');
      await writeFile(original, 'original');
      const partial = join(
        f.candidate,
        '.w1-recovery',
        `manifest.json.partial-${f.bundle.operationId}`,
      );
      if (kind === 'symlink') await symlink(original, partial);
      else if (kind === 'hardlink') await link(original, partial);
      else await mkdir(partial);
      await expect(f.bundle.initialize(f.source, f.history)).rejects.toThrow(
        'invalid_temporary_file',
      );
      expect(await readFile(original, 'utf8')).toBe('original');
    },
  );

  it('does not remove metadata temporaries during verification', async () => {
    const f = await fixture();
    await f.bundle.compareTree(f.source, 'workspace');
    const partial = join(
      f.candidate,
      '.w1-recovery',
      `assets.ndjson.partial-${f.bundle.operationId}`,
    );
    await writeFile(partial, 'interrupted');
    const verifier = new LocalRecoveryBundle(
      f.candidate,
      f.bundle.operationId,
      'verify',
      f.rpc,
    );
    await verifier.initialize(f.source, f.history);
    await expect(verifier.census()).rejects.toThrow('undeclared_bundle_entry');
    expect(await readFile(partial, 'utf8')).toBe('interrupted');
  });

  it('verifies sealed files after source loss and rejects any undeclared artifact', async () => {
    const f = await fixture();
    await writeFile(join(f.source, 'file'), 'x');
    await cp(f.source, join(f.candidate, 'workspace'), { recursive: true });
    await f.bundle.compareTree(f.source, 'workspace');
    await rm(f.source, { recursive: true });
    const verifier = new LocalRecoveryBundle(
      f.candidate,
      f.bundle.operationId,
      'verify',
      f.rpc,
    );
    await verifier.initialize(f.source, f.history);
    await verifier.census();
    await writeFile(join(f.candidate, 'authority', 'extra'), 'x');
    await expect(verifier.census()).rejects.toThrow('missing_bundle_asset');
  });
});

describe('migration target evidence', () => {
  it.each(['bytes', 'extra', 'missing', 'hardlink'])(
    'distinguishes source drift from a retryable target %s mismatch',
    async (mutation) => {
      const f = await fixture();
      await writeFile(join(f.source, 'file'), 'original');
      await cp(f.source, join(f.candidate, 'workspace'), { recursive: true });
      await f.bundle.compareTree(f.source, 'workspace');
      const target = join(f.root, 'target');
      await cp(f.source, target, { recursive: true });
      for (const root of [f.source, target]) {
        if (mutation === 'bytes')
          await writeFile(join(root, 'file'), 'changed');
        if (mutation === 'extra') await writeFile(join(root, 'extra'), 'extra');
        if (mutation === 'missing') await rm(join(root, 'file'));
        if (mutation === 'hardlink')
          await link(join(root, 'file'), join(root, 'alias'));
      }
      await expect(
        f.bundle.verifyMigrationTree(f.source, 'workspace'),
      ).rejects.toThrow('source_drift');
      await expect(
        f.bundle.verifyMigrationTree(target, 'workspace', {
          digest: recoveryDigest('marker'),
          byteLength: 6,
        }),
      ).rejects.toThrow('migration_tree_mismatch');
    },
  );

  it('allows only the pinned root marker replacement and checks every other entry', async () => {
    const f = await fixture();
    await writeFile(
      join(f.source, '.qwen-managed-storage.json'),
      'source-marker',
    );
    await writeFile(join(f.source, '.qwen-extra'), 'retained');
    await cp(f.source, join(f.candidate, 'workspace'), { recursive: true });
    await f.bundle.compareTree(f.source, 'workspace');
    const target = join(f.root, 'target');
    await cp(f.source, target, { recursive: true });
    const bytes = Buffer.from('target-marker');
    const marker = { digest: recoveryDigest(bytes), byteLength: bytes.length };
    await f.bundle.verifyMigrationTree(target, 'workspace', marker);
    await writeFile(join(target, '.qwen-managed-storage.json'), bytes);
    await f.bundle.verifyMigrationTree(target, 'workspace', marker);
    await writeFile(join(target, '.qwen-extra'), 'tampered');
    await expect(
      f.bundle.verifyMigrationTree(target, 'workspace', marker),
    ).rejects.toThrow('migration_tree_mismatch');
    await writeFile(join(target, '.qwen-extra'), 'retained');
    await writeFile(join(target, 'extra'), 'undeclared');
    await expect(
      f.bundle.verifyMigrationTree(target, 'workspace', marker),
    ).rejects.toThrow('migration_tree_mismatch');
    await rm(join(target, 'extra'));
    await rm(join(target, '.qwen-extra'));
    await expect(
      f.bundle.verifyMigrationTree(target, 'workspace', marker),
    ).rejects.toThrow('migration_tree_mismatch');
  });

  it('rejects arbitrary marker bytes and leaves sealed evidence unchanged', async () => {
    const f = await fixture();
    await writeFile(join(f.source, '.qwen-managed-storage.json'), 'source');
    await cp(f.source, join(f.candidate, 'workspace'), { recursive: true });
    await f.bundle.compareTree(f.source, 'workspace');
    const target = join(f.root, 'target');
    await cp(f.source, target, { recursive: true });
    await writeFile(join(target, '.qwen-managed-storage.json'), 'conflict');
    await expect(
      f.bundle.verifyMigrationTree(target, 'workspace', {
        digest: recoveryDigest('target'),
        byteLength: 6,
      }),
    ).rejects.toThrow('migration_tree_mismatch');
    expect(
      await readFile(
        join(f.candidate, 'workspace', '.qwen-managed-storage.json'),
        'utf8',
      ),
    ).toBe('source');
    await f.bundle.recheckTree(f.source, 'workspace');
  });
});
