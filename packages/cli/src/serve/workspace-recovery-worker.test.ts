/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  recoveryDigest,
  recoveryJson,
  type RecoveryRpc,
} from './workspace-recovery-bundle.js';
import {
  createRecoveryRpc,
  runRecoveryWorker,
} from './workspace-recovery-worker.js';
import type { RecoverySessionSource } from './workspace-recovery-session.js';

const temporary: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of temporary.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'w1b-worker-'));
  temporary.push(root);
  const sourceRoot = join(root, 'source');
  const bundleRoot = join(root, 'bundle');
  const fileHistoryRoot = join(root, 'history');
  await mkdir(sourceRoot);
  await mkdir(bundleRoot);
  await mkdir(fileHistoryRoot);
  await writeFile(join(sourceRoot, 'file'), 'preserved');
  await cp(sourceRoot, join(bundleRoot, 'workspace'), { recursive: true });
  const rows = Array.from({ length: 35 }, (_, ordinal) => {
    const sessionId = `session-${String(ordinal).padStart(3, '0')}`;
    const source: RecoverySessionSource = {
      sessionId,
      binding: {
        tenantId: 'tenant',
        workspaceId: `workspace-${ordinal % 2}`,
        workspaceGeneration: '1',
        storageId: 'storage',
        cwdRelative: '.',
        contextConfigRef: 'config',
        contextRevision: '1',
      },
      configRef: 'config',
      policyRef: 'policy',
      approvalMode: 'default',
      publicSession: {
        version: 1,
        status: ordinal % 2 ? 'ARCHIVED' : 'READY',
        lastSequence: 0,
        harnessBootId: null,
        harnessEventEpoch: 0,
        harnessLastEventId: 0,
        deletedAt: null,
      },
      creation: {
        actorIdHex: '01',
        idempotencyKey: sessionId,
        requestDigest: recoveryDigest(sessionId),
        turnId: null,
        createdAt: 1,
      },
      head: null,
      retirement: null,
    };
    const sourceJson = JSON.stringify(source);
    return {
      sessionId,
      source,
      sourceJson,
      sourceDigest: recoveryDigest(sourceJson),
    };
  });
  const context = {
    protocol: 'workspace-recovery/1',
    mode: 'capture',
    request: {
      operationId: '00000000-0000-4000-8000-000000000001',
      tenantId: 'tenant',
      storageId: 'storage',
      sourceRoot,
      bundleRoot,
      fileHistoryRoot,
      fenceOperationId: '00000000-0000-4000-8000-000000000002',
      mountRevision: 2,
    },
    registration: {
      tenantId: 'tenant',
      storageId: 'storage',
      mountRevision: 2,
    },
    sourceDigest: recoveryDigest(
      rows.map((row) => `${row.sourceJson}\n`).join(''),
    ),
    sessionCount: rows.length,
    capture: null as null | { operationId: string; manifestDigest: string },
  };
  const assets = new Map<string, unknown>();
  const calls: string[] = [];
  let failComplete = false;
  const rpc: RecoveryRpc = async (method, value) => {
    calls.push(method);
    const params = value as Record<string, unknown>;
    if (method === 'context') return context;
    if (method === 'sessions') {
      const pending = rows.filter(
        (row) => row.sessionId > String(params['afterSessionId'] ?? ''),
      );
      return {
        sessions: pending.slice(0, 32),
        nextSessionId: pending.length > 32 ? pending[31].sessionId : null,
      };
    }
    if (method === 'nextRef') return null;
    if (method === 'sessionComplete') {
      if (failComplete) {
        failComplete = false;
        throw new Error('injected_io_failure');
      }
      return { complete: true };
    }
    if (method === 'asset') {
      const key = String(params['key']);
      if (
        assets.has(key) &&
        recoveryJson(assets.get(key)) !== recoveryJson(params['metadata'])
      )
        throw new Error('asset_conflict');
      assets.set(key, params['metadata']);
      return params['metadata'];
    }
    if (method === 'assetLookup')
      return assets.get(String(params['key'])) ?? null;
    if (method === 'assetPage') {
      const pending = [...assets]
        .sort(([a], [b]) => a.localeCompare(b))
        .filter(([key]) => key > String(params['afterKey'] ?? ''));
      return {
        assets: pending
          .slice(0, 32)
          .map(([key, metadata]) => ({ key, metadata })),
        nextKey: pending.length > 32 ? pending[31][0] : null,
      };
    }
    if (method === 'finish')
      return {
        ...params,
        result: {
          ...(params['result'] as object),
          authorityCompatible: context.mode === 'capture',
          activation: false,
        },
      };
    throw new Error(`Unexpected authority mutation/read ${method}`);
  };
  return {
    context,
    rpc,
    calls,
    root,
    assets,
    interrupt: () => {
      failComplete = true;
    },
  };
}

describe('workspace recovery private worker', () => {
  it.each(['canonical', 'trailing-slash', 'doubled-slash'])(
    'accepts %s QWEN_HOME at the migration environment gate',
    async (kind) => {
      const f = await fixture();
      const home = join(f.root, 'home');
      const history = join(home, 'file-history');
      await mkdir(history, { recursive: true });
      for (const path of [
        'workspace',
        'file-history',
        'authority/objects',
        '.w1-recovery',
      ])
        await mkdir(join(f.context.request.bundleRoot, path), {
          recursive: true,
        });
      vi.stubEnv(
        'QWEN_HOME',
        kind === 'trailing-slash'
          ? `${home}/`
          : kind === 'doubled-slash'
            ? `${home.replace('/home', '//home')}//`
            : home,
      );
      const rpc: RecoveryRpc = async (method, params) =>
        method === 'context'
          ? {
              ...f.context,
              mode: 'verify',
              request: { ...f.context.request, fileHistoryRoot: history },
              migration: {
                targetRoot: join(f.root, 'target'),
                targetMarker: {
                  digest: recoveryDigest('marker'),
                  byteLength: 6,
                },
              },
            }
          : f.rpc(method, params);
      await expect(runRecoveryWorker(rpc)).rejects.toThrow(
        'capture_not_sealed',
      );
      expect(f.calls).not.toContain('finish');
    },
  );

  it.each([
    'unset',
    'relative',
    'symlink',
    'different-history',
    'dot',
    'parent',
  ])(
    'refuses the migration before completion with %s QWEN_HOME',
    async (kind) => {
      const f = await fixture();
      const home = join(f.root, 'home');
      const history = join(home, 'file-history');
      await mkdir(history, { recursive: true });
      await mkdir(join(home, 'child'));
      if (kind === 'symlink') await symlink(home, join(f.root, 'alias'));
      vi.stubEnv(
        'QWEN_HOME',
        kind === 'unset'
          ? undefined
          : kind === 'relative'
            ? '.'
            : kind === 'symlink'
              ? join(f.root, 'alias')
              : kind === 'dot'
                ? `${home}/.`
                : kind === 'parent'
                  ? `${home}/child/..`
                  : home,
      );
      const rpc: RecoveryRpc = async (method, params) =>
        method === 'context'
          ? {
              ...f.context,
              request: {
                ...f.context.request,
                fileHistoryRoot:
                  kind === 'different-history'
                    ? f.context.request.fileHistoryRoot
                    : history,
              },
              migration: {
                targetRoot: join(f.root, 'target'),
                targetMarker: {
                  digest: recoveryDigest('marker'),
                  byteLength: 6,
                },
              },
            }
          : f.rpc(method, params);
      await expect(runRecoveryWorker(rpc)).rejects.toThrow(
        'migration_history_environment_mismatch',
      );
      expect(f.calls).not.toContain('finish');
    },
  );

  it.each(['absolute', 'dangling', 'not-directory', 'hardlink'])(
    'invalidates a fresh unsupported %s entry with its own code and private path',
    async (kind) => {
      const f = await fixture();
      const source = f.context.request.sourceRoot;
      const name = 'unsupported\nentry';
      if (kind === 'hardlink')
        await link(join(source, 'file'), join(source, name));
      else
        await symlink(
          kind === 'absolute'
            ? join(source, 'file')
            : kind === 'not-directory'
              ? 'file/child'
              : 'absent',
          join(source, name),
        );
      let invalidatedCode: unknown;
      const rpc: RecoveryRpc = async (method, params) => {
        if (method === 'invalidate') {
          f.calls.push(method);
          invalidatedCode = (params as { code: unknown }).code;
          return { state: 'INVALIDATED' };
        }
        return f.rpc(method, params);
      };
      await expect(runRecoveryWorker(rpc)).rejects.toMatchObject({
        message: 'unsupported_source_entry',
        entryPath:
          kind === 'hardlink'
            ? expect.stringMatching(/^source\/(file|unsupported\nentry)$/)
            : `source/${name}`,
        reason:
          kind === 'hardlink' ? 'unsupported_file_type' : 'unsupported_symlink',
      });
      expect(invalidatedCode).toBe('unsupported_source_entry');
      expect(f.calls.filter((method) => method === 'invalidate')).toHaveLength(
        1,
      );
      expect(f.calls).not.toContain('finish');
    },
  );

  it.each(['file', 'nested'])(
    'invalidates original %s removed after its entry commit in the same capture pass',
    async (name) => {
      const f = await fixture();
      if (name === 'nested') {
        const original = join(f.context.request.sourceRoot, name);
        await mkdir(original);
        await writeFile(join(original, 'child'), 'retained');
        await cp(
          original,
          join(f.context.request.bundleRoot, 'workspace', name),
          {
            recursive: true,
          },
        );
      }
      const rpc: RecoveryRpc = async (method, params) => {
        if (method === 'invalidate') {
          f.calls.push(method);
          return { state: 'INVALIDATED' };
        }
        const result = await f.rpc(method, params);
        if (
          method === 'asset' &&
          (params as { metadata: { path?: string } }).metadata.path ===
            `workspace/${name}`
        )
          await rm(join(f.context.request.sourceRoot, name), {
            recursive: true,
          });
        return result;
      };
      await expect(runRecoveryWorker(rpc)).rejects.toThrow('source_drift');
      expect(f.calls).toContain('invalidate');
      expect(f.calls).not.toContain('finish');
    },
  );

  it.each(
    ['entry', 'session'].flatMap((boundary) =>
      [
        'changed',
        'missing',
        'missing-both',
        'missing-root',
        'root-alias',
        'root-file',
        'hardlink',
      ].map((mutation) => [boundary, mutation]),
    ),
  )(
    'invalidates a source on retry after an interrupted %s commit (%s)',
    async (boundary, mutation) => {
      const f = await fixture();
      let interrupted = false;
      if (boundary === 'session') f.interrupt();
      const rpc: RecoveryRpc = async (method, params) => {
        if (method === 'invalidate') {
          f.calls.push(method);
          return { state: 'INVALIDATED' };
        }
        const result = await f.rpc(method, params);
        if (boundary === 'entry' && method === 'asset' && !interrupted) {
          const metadata = (params as { metadata: { path?: string } }).metadata;
          if (metadata.path === 'workspace/file') {
            interrupted = true;
            throw new Error('injected_io_failure');
          }
        }
        return result;
      };
      await expect(runRecoveryWorker(rpc)).rejects.toThrow(
        'injected_io_failure',
      );
      const original = join(f.context.request.sourceRoot, 'file');
      if (mutation === 'changed') await writeFile(original, 'changed');
      else if (mutation === 'missing-root')
        await rm(f.context.request.sourceRoot, { recursive: true });
      else if (mutation.startsWith('root-')) {
        const retained = join(f.root, 'retained-source');
        await rename(f.context.request.sourceRoot, retained);
        if (mutation === 'root-alias')
          await symlink(retained, f.context.request.sourceRoot);
        else await writeFile(f.context.request.sourceRoot, 'replacement');
      } else if (mutation.startsWith('missing')) {
        await rm(original);
        if (mutation === 'missing-both')
          await rm(join(f.context.request.bundleRoot, 'workspace/file'));
      } else await link(original, join(f.root, 'other-link'));
      await expect(runRecoveryWorker(rpc)).rejects.toThrow('source_drift');
      expect(f.calls).toContain('invalidate');
      expect(f.calls).not.toContain('finish');
    },
  );

  it.each(['session-000', 'session-034'])(
    'invalidates a history parent replaced after %s completes in the same pass',
    async (sessionId) => {
      const f = await fixture();
      const original = join(f.context.request.fileHistoryRoot, 'session-000');
      await mkdir(original);
      await writeFile(join(original, 'preimage'), 'retained');
      await mkdir(join(f.context.request.bundleRoot, 'file-history'));
      await cp(
        original,
        join(f.context.request.bundleRoot, 'file-history/session-000'),
        { recursive: true },
      );
      const rpc: RecoveryRpc = async (method, params) => {
        if (method === 'invalidate') {
          f.calls.push(method);
          return { state: 'INVALIDATED' };
        }
        const result = await f.rpc(method, params);
        if (
          method === 'sessionComplete' &&
          (params as { sessionId: string }).sessionId === sessionId
        ) {
          await rename(
            f.context.request.fileHistoryRoot,
            join(f.root, 'retained-history'),
          );
          await writeFile(f.context.request.fileHistoryRoot, 'replacement');
        }
        return result;
      };
      await expect(runRecoveryWorker(rpc)).rejects.toThrow('source_drift');
      expect(f.calls).toContain('invalidate');
      expect(f.calls).not.toContain('finish');
    },
  );

  it.each(
    ['entry', 'session'].flatMap((boundary) =>
      ['missing', 'parent-alias', 'parent-file'].map((mutation) => [
        boundary,
        mutation,
      ]),
    ),
  )(
    'invalidates a changed history root on retry after an interrupted %s commit (%s)',
    async (boundary, mutation) => {
      const f = await fixture();
      const source = join(f.context.request.fileHistoryRoot, 'session-000');
      await mkdir(source);
      await writeFile(join(source, 'preimage'), 'retained');
      await mkdir(join(f.context.request.bundleRoot, 'file-history'));
      await cp(
        source,
        join(f.context.request.bundleRoot, 'file-history/session-000'),
        {
          recursive: true,
        },
      );
      let interrupted = false;
      if (boundary === 'session') f.interrupt();
      const rpc: RecoveryRpc = async (method, params) => {
        if (method === 'invalidate') {
          f.calls.push(method);
          return { state: 'INVALIDATED' };
        }
        const result = await f.rpc(method, params);
        if (boundary === 'entry' && method === 'asset' && !interrupted) {
          const metadata = (params as { metadata: { path?: string } }).metadata;
          if (metadata.path === 'file-history/session-000/preimage') {
            interrupted = true;
            throw new Error('injected_io_failure');
          }
        }
        return result;
      };
      await expect(runRecoveryWorker(rpc)).rejects.toThrow(
        'injected_io_failure',
      );
      if (mutation === 'missing') await rm(source, { recursive: true });
      else {
        const retained = join(f.root, 'retained-history');
        await rename(f.context.request.fileHistoryRoot, retained);
        if (mutation === 'parent-alias')
          await symlink(retained, f.context.request.fileHistoryRoot);
        else await writeFile(f.context.request.fileHistoryRoot, 'replacement');
      }
      await expect(runRecoveryWorker(rpc)).rejects.toThrow('source_drift');
      expect(f.calls).toContain('invalidate');
      expect(f.calls).not.toContain('finish');
    },
  );

  it('invalidates a file source changed after its initial inventory', async () => {
    const f = await fixture();
    let changed = false;
    const rpc: RecoveryRpc = async (method, params) => {
      if (method === 'sessionComplete' && !changed) {
        changed = true;
        await writeFile(
          join(f.context.request.sourceRoot, 'file'),
          'late change',
        );
      }
      if (method === 'invalidate') {
        f.calls.push(method);
        return { state: 'INVALIDATED' };
      }
      return f.rpc(method, params);
    };
    await expect(runRecoveryWorker(rpc)).rejects.toThrow('source_drift');
    expect(f.calls).toContain('invalidate');
    expect(f.calls).not.toContain('finish');
  });
  it('resumes a paginated capture and produces the same pinned manifest without authority writes', async () => {
    const f = await fixture();
    f.interrupt();
    await expect(runRecoveryWorker(f.rpc)).rejects.toThrow(
      'injected_io_failure',
    );
    expect(f.calls).not.toContain('finish');
    const receipt = await runRecoveryWorker(f.rpc);
    const original = await readFile(
      join(f.context.request.bundleRoot, '.w1-recovery/manifest.json'),
    );
    expect(await runRecoveryWorker(f.rpc)).toEqual(receipt);
    expect(
      await readFile(
        join(f.context.request.bundleRoot, '.w1-recovery/manifest.json'),
      ),
    ).toEqual(original);
    expect(
      f.calls.filter((call) => call === 'sessions').length,
    ).toBeGreaterThan(3);
    expect(f.calls).not.toContain('transaction');
    expect(f.calls).not.toContain('resource');
  });

  it('checks sealed content after source loss and keeps compatibility separate', async () => {
    const f = await fixture();
    const captured = (await runRecoveryWorker(f.rpc)) as {
      manifestDigest: string;
    };
    f.context.capture = {
      operationId: f.context.request.operationId,
      manifestDigest: captured.manifestDigest,
    };
    f.context.request.operationId = '00000000-0000-4000-8000-000000000003';
    f.context.mode = 'verify';
    await rm(f.context.request.sourceRoot, { recursive: true });
    const receipt = (await runRecoveryWorker(f.rpc)) as {
      result: Record<string, unknown>;
    };
    expect(receipt.result).toMatchObject({
      contentVerified: true,
      authorityCompatible: false,
      activation: false,
      sessionCount: 35,
    });
    await writeFile(
      join(f.context.request.bundleRoot, 'workspace/file'),
      'corrupted',
    );
    await expect(runRecoveryWorker(f.rpc)).rejects.toThrow(
      'bundle_entry_mismatch',
    );
  });

  it('refuses a self-consistent replaced manifest that does not match the SQL receipt', async () => {
    const f = await fixture();
    const captured = (await runRecoveryWorker(f.rpc)) as {
      manifestDigest: string;
    };
    f.context.capture = {
      operationId: f.context.request.operationId,
      manifestDigest: captured.manifestDigest,
    };
    f.context.mode = 'verify';
    await writeFile(
      join(f.context.request.bundleRoot, '.w1-recovery/manifest.json'),
      '{}\n',
    );
    await expect(runRecoveryWorker(f.rpc)).rejects.toThrow(
      'bundle_manifest_mismatch',
    );
  });

  it('correlates one bounded pipe response and rejects wrong IDs', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const rpc = createRecoveryRpc(input, output);
    output.on('data', (bytes: Buffer) => {
      const request = JSON.parse(bytes.toString()) as { id: number };
      input.write(`${JSON.stringify({ id: request.id + 1, result: {} })}\n`);
    });
    await expect(rpc('context', {})).rejects.toThrow(
      'unexpected_recovery_response',
    );
    input.end();
    output.end();
  });
});
