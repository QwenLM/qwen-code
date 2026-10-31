/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ManagedExtensionRuntime,
  type ManagedExtensionRuntimeDependencies,
} from './managed-extension-runtime.js';

let temporary: string;
beforeEach(async () => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-runtime-'));
});
afterEach(async () => {
  await fs.rm(temporary, { recursive: true, force: true });
});

function dependencies(): ManagedExtensionRuntimeDependencies {
  return {
    executionMode: 'developer-process-group',
    directory: path.join(temporary, 'runtime'),
    admitted: vi.fn(async () => true),
    idle: vi.fn(() => true),
    compile: vi.fn(async () => ({
      skills: [],
      commands: [],
      agents: [],
      context: [],
      mcpServers: {},
      hooks: {},
      settings: [],
    })),
    drain: vi.fn(async () => undefined),
    install: vi.fn(async () => undefined),
  };
}
function command(expectedRevision = 0) {
  return {
    operationId: randomUUID(),
    actorKey: 'a'.repeat(64),
    expectedRevision,
    extensions: [],
  };
}

describe('ManagedExtensionRuntime', () => {
  it('uses Session revision CAS and drains only the selected Session', async () => {
    const deps = dependencies();
    const runtime = new ManagedExtensionRuntime(deps);
    const first = command();
    await runtime.prepare('a', first);
    expect(await runtime.status('a')).toMatchObject({ revision: 0 });
    await runtime.activate('a', first.operationId);
    expect(await runtime.status('a')).toMatchObject({ revision: 1 });
    expect(await runtime.status('b')).toMatchObject({ revision: 0 });
    expect(deps.drain).toHaveBeenCalledExactlyOnceWith('a', first);
    await expect(runtime.prepare('a', command())).rejects.toThrow('revision');
    await runtime.activate('a', first.operationId);
    expect(deps.install).toHaveBeenCalledTimes(1);
  });

  it('retains an unknown original operation across reconstruction without replaying install', async () => {
    const deps = dependencies();
    vi.mocked(deps.install).mockRejectedValue(new Error('reply lost'));
    const runtime = new ManagedExtensionRuntime(deps);
    const input = command();
    await runtime.prepare('a', input);
    await expect(runtime.activate('a', input.operationId)).rejects.toThrow(
      'reply lost',
    );
    const replacement = new ManagedExtensionRuntime(deps);
    expect(await replacement.status('a')).toMatchObject({
      revision: 0,
      pendingOperationId: input.operationId,
    });
    await expect(replacement.activate('a', input.operationId)).rejects.toThrow(
      'unknown',
    );
    await expect(replacement.prepare('a', command())).rejects.toThrow(
      'unknown',
    );
    expect(deps.install).toHaveBeenCalledTimes(1);
  });

  it('blocks concurrent activation while another Session stays available', async () => {
    const deps = dependencies();
    let release!: () => void;
    vi.mocked(deps.drain).mockImplementation(
      async () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const runtime = new ManagedExtensionRuntime(deps);
    const input = command();
    await runtime.prepare('a', input);
    const activation = runtime.activate('a', input.operationId);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expect(runtime.prepare('a', command())).rejects.toThrow('changing');
    expect(await runtime.status('b')).toMatchObject({ revision: 0 });
    release();
    await activation;
  });

  it('rehydrates active metadata after restart only through exact original prepare', async () => {
    const deps = dependencies();
    const original = new ManagedExtensionRuntime(deps);
    const input = command();
    await original.prepare('root', input);
    await original.activate('root', input.operationId);
    const restarted = new ManagedExtensionRuntime(deps);
    await expect(restarted.activate('root', input.operationId)).rejects.toThrow(
      'reprepare',
    );
    await restarted.prepare('root', input);
    await restarted.activate('root', input.operationId);
    expect(deps.drain).toHaveBeenCalledTimes(1);
    expect(deps.install).toHaveBeenCalledTimes(2);
  });

  it('rebuilds a missing active root through a new explicit apply without changing its definition paths', async () => {
    const source = path.join(temporary, 'source');
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'asset.txt'), 'authoritative');
    const archive = path.join(temporary, 'archive.tgz');
    await tar.c({ file: archive, cwd: source, gzip: true }, ['asset.txt']);
    const bytes = await fs.readFile(archive);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const deps = dependencies();
    const runtime = new ManagedExtensionRuntime(deps);
    await runtime.cache.upload(digest, Readable.from(bytes));
    const pin = {
      extensionId: 'one',
      packageRevision: 1,
      packageDigest: digest,
    };
    const first = { ...command(), extensions: [pin] };
    const initial = await runtime.prepare('a', first);
    await runtime.activate('a', first.operationId);
    const root = initial.packages[0]!.assetRoot;
    await fs.rm(root, { recursive: true });
    await expect(runtime.getToolContext('a', 1, pin)).rejects.toThrow();
    const next = { ...command(1), extensions: [pin] };
    const rebuilt = await runtime.prepare('a', next);
    expect(rebuilt.packages[0]!.assetRoot).toBe(root);
    expect(await fs.readFile(path.join(root, 'asset.txt'), 'utf8')).toBe(
      'authoritative',
    );
    await runtime.activate('a', next.operationId);
    expect(await runtime.readAsset('a', 2, 'one', 'asset.txt')).toEqual({
      path: 'asset.txt',
      content: 'authoritative',
    });
    expect((await runtime.getToolContext('a', 2, pin)).assetRoot).toBe(root);
    expect(deps.compile).toHaveBeenNthCalledWith(
      2,
      root,
      pin,
      {},
      'a',
      undefined,
    );
    await fs.writeFile(path.join(root, 'asset.txt'), 'drift');
    await expect(runtime.getToolContext('a', 2, pin)).rejects.toThrow(
      'drifted',
    );
    const repair = { ...command(2), extensions: [pin] };
    expect((await runtime.prepare('a', repair)).packages[0]!.assetRoot).toBe(
      root,
    );
    await runtime.activate('a', repair.operationId);
    expect(await runtime.readAsset('a', 3, 'one', 'asset.txt')).toEqual({
      path: 'asset.txt',
      content: 'authoritative',
    });
  });

  it('contains private assets to the active package and exact Session revision', async () => {
    const source = path.join(temporary, 'source');
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'asset.txt'), 'inside');
    const archive = path.join(temporary, 'archive.tgz');
    await tar.c({ file: archive, cwd: source, gzip: true }, ['asset.txt']);
    const bytes = await fs.readFile(archive);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const runtime = new ManagedExtensionRuntime(dependencies());
    await runtime.cache.upload(digest, Readable.from(bytes));
    const input = {
      ...command(),
      extensions: [
        { extensionId: 'one', packageRevision: 1, packageDigest: digest },
      ],
    };
    const prepared = await runtime.prepare('a', input, {
      baseMcpServers: [],
      baseHookCatalog: null,
      settings: { one: { TOKEN: 'private-secret' } },
    });
    expect(JSON.stringify(prepared)).not.toContain('private-secret');
    await runtime.activate('a', input.operationId);
    expect(
      (await runtime.getToolContext('a', 1, input.extensions[0])).environment,
    ).toMatchObject({ TOKEN: 'private-secret' });
    await expect(
      runtime.getToolContext('b', 1, input.extensions[0]),
    ).rejects.toThrow('unavailable');
    expect(await runtime.readAsset('a', 1, 'one', 'asset.txt')).toEqual({
      path: 'asset.txt',
      content: 'inside',
    });
    expect(await runtime.globAssets('a', 1, 'one', '**/*.txt')).toEqual([
      'asset.txt',
    ]);
    await expect(runtime.readAsset('a', 0, 'one', 'asset.txt')).rejects.toThrow(
      'unavailable',
    );
    await expect(runtime.readAsset('b', 1, 'one', 'asset.txt')).rejects.toThrow(
      'unavailable',
    );
    await expect(
      runtime.readAsset('a', 1, 'one', '../../archive.tgz'),
    ).rejects.toThrow();
    const unchanged = await runtime.prepare(
      'a',
      { ...command(1), extensions: input.extensions },
      {
        baseMcpServers: [],
        baseHookCatalog: null,
        settings: { one: { TOKEN: 'private-secret' } },
      },
    );
    expect(unchanged.packages[0]!.assetRoot).toBe(
      prepared.packages[0]!.assetRoot,
    );
    await fs.writeFile(
      path.join(prepared.packages[0]!.assetRoot, 'asset.txt'),
      'drift',
    );
    await expect(
      runtime.getToolContext('a', 1, input.extensions[0]),
    ).rejects.toThrow('drifted');
    await expect(runtime.readAsset('a', 1, 'one', 'asset.txt')).rejects.toThrow(
      'drifted',
    );
  });
});

it('reconciles the exact active operation after restart and does not replay its stop', async () => {
  const deps: ManagedExtensionRuntimeDependencies = {
    ...dependencies(),
    reconcile: vi.fn(async () => [
      {
        ownerId: 'original-owner',
        sessionId: 'a',
        configRevision: 1,
        mode: 'developer-process-group' as const,
        scope: 'process_group' as const,
        state: 'stopped' as const,
      },
    ]),
  };
  const runtime = new ManagedExtensionRuntime(deps);
  const input = command();
  await runtime.prepare('a', input);
  await runtime.activate('a', input.operationId);
  expect(await runtime.operationStatus('a', input.operationId)).toMatchObject({
    state: 'active',
    revision: 1,
  });
  const restarted = new ManagedExtensionRuntime(deps);
  await expect(
    restarted.reconcile('a', input.operationId, 0, 1),
  ).resolves.toMatchObject({
    state: 'stopped',
    operationId: input.operationId,
  });
  await expect(
    restarted.reconcile('a', input.operationId, 0, 1),
  ).resolves.toMatchObject({
    state: 'stopped',
    operationId: input.operationId,
  });
  expect(deps.reconcile).toHaveBeenCalledExactlyOnceWith('a');
  expect(deps.install).toHaveBeenCalledOnce();
});

it('refuses compensation when a newer active operation owns the Session', async () => {
  const deps = { ...dependencies(), reconcile: vi.fn() };
  const runtime = new ManagedExtensionRuntime(deps);
  const first = command();
  await runtime.prepare('a', first);
  await runtime.activate('a', first.operationId);
  const next = command(1);
  await runtime.prepare('a', next);
  await runtime.activate('a', next.operationId);
  await expect(runtime.reconcile('a', first.operationId, 0, 1)).rejects.toThrow(
    'conflicts',
  );
  expect(deps.reconcile).not.toHaveBeenCalled();
  expect(await runtime.status('a')).toMatchObject({
    operationId: next.operationId,
    revision: 2,
  });
});

it.each([false, true])(
  'reconciles a committed prepared operation before activation with prior configuration: %s',
  async (previous) => {
    const deps: ManagedExtensionRuntimeDependencies = {
      ...dependencies(),
      reconcile: vi.fn(async () => [
        {
          ownerId: 'original-owner',
          sessionId: 'a',
          configRevision: previous ? 2 : 1,
          mode: 'developer-process-group' as const,
          scope: 'process_group' as const,
          state: 'stopped' as const,
        },
      ]),
    };
    const runtime = new ManagedExtensionRuntime(deps);
    if (previous) {
      const initial = command();
      await runtime.prepare('a', initial);
      await runtime.activate('a', initial.operationId);
    }
    const input = command(previous ? 1 : 0);
    await runtime.prepare('a', input);
    const restarted = new ManagedExtensionRuntime(deps);
    await expect(
      restarted.reconcile(
        'a',
        input.operationId,
        input.expectedRevision,
        input.expectedRevision + 1,
      ),
    ).resolves.toMatchObject({
      state: 'stopped',
      operationId: input.operationId,
    });
    expect(deps.install).toHaveBeenCalledTimes(previous ? 1 : 0);
    const recovery = command(input.expectedRevision + 1);
    await restarted.prepare('a', recovery);
    await restarted.activate('a', recovery.operationId);
    expect(await restarted.status('a')).toMatchObject({
      revision: input.expectedRevision + 2,
      operationId: recovery.operationId,
    });
  },
);

it('retains an unknown stop for the active original owner until evidence arrives', async () => {
  const reconcile = vi.fn(async () => [
    {
      ownerId: 'original-owner',
      sessionId: 'a',
      configRevision: 1,
      mode: 'developer-process-group' as const,
      scope: 'process_group' as const,
      state: 'outcome_unknown' as 'outcome_unknown' | 'stopped',
    },
  ]);
  const runtime = new ManagedExtensionRuntime({ ...dependencies(), reconcile });
  const input = command();
  await runtime.prepare('a', input);
  await runtime.activate('a', input.operationId);
  await expect(
    runtime.reconcile('a', input.operationId, 0, 1),
  ).resolves.toMatchObject({ state: 'outcome_unknown' });
  expect(await runtime.operationStatus('a', input.operationId)).toMatchObject({
    state: 'active',
  });
  reconcile.mockResolvedValueOnce([
    {
      ownerId: 'original-owner',
      sessionId: 'a',
      configRevision: 1,
      mode: 'developer-process-group',
      scope: 'process_group',
      state: 'stopped',
    },
  ]);
  await expect(
    runtime.reconcile('a', input.operationId, 0, 1),
  ).resolves.toMatchObject({ state: 'stopped' });
});
