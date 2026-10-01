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
      await expect(
        f.bundle.compareTree(f.source, 'workspace'),
      ).rejects.toThrow();
    },
  );

  it.each(['absolute', 'escape', 'loop', 'dangling', 'hardlink'])(
    'rejects %s entries before sealing',
    async (kind) => {
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
                : 'absent',
          join(f.source, 'other'),
        );
      await cp(f.source, join(f.candidate, 'workspace'), {
        recursive: true,
        verbatimSymlinks: true,
      });
      await expect(
        f.bundle.compareTree(f.source, 'workspace'),
      ).rejects.toThrow();
    },
  );

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
