/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSettleTimeout } from '../test-utils/settle-timeout.js';

const api = pathToFileURL(
  createRequire(import.meta.url).resolve('tsx/esm/api'),
).href;
const source = new URL('./managed-runtime-bootstrap.ts', import.meta.url).href;
const tsconfig = fileURLToPath(new URL('../../tsconfig.json', import.meta.url));

describe('Managed Workspace upload bootstrap processes', () => {
  let temporary: string;
  let root: string;
  let entry: string;
  let envelope: Record<string, unknown>;
  const children = new Set<ChildProcessWithoutNullStreams>();

  beforeEach(async () => {
    temporary = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-upload-process-')),
    );
    root = path.join(temporary, 'workspace');
    await fs.mkdir(root);
    const stat = await fs.stat(root, { bigint: true });
    envelope = {
      protocolVersion: 1,
      operation: 'probe',
      nodeId: 'node-a',
      root,
      stateDirectory: path.join(temporary, 'private'),
      allowedRoots: [temporary],
      localRootIdentity: { device: String(stat.dev), inode: String(stat.ino) },
      cwdRelative: '.',
    };
    entry = path.join(temporary, 'entry.mjs');
    await fs.writeFile(
      entry,
      `import {register} from ${JSON.stringify(api)};\nregister({tsconfig:${JSON.stringify(tsconfig)}});\nawait (await import(${JSON.stringify(source)})).runManagedRuntimeBootstrap(process.argv.includes('--help'),process.argv.includes('--workspace-file-upload'));\n`,
    );
  });

  afterEach(async () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await new Promise((resolve) => child.once('exit', resolve));
      }
    }
    children.clear();
    await fs.rm(temporary, { recursive: true, force: true });
  });

  function metadata(bytes: Buffer) {
    return {
      protocolVersion: 1,
      uploadId: randomUUID(),
      path: 'file.bin',
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  function launch(
    input: string,
    args = ['--workspace-file-upload'],
    executable = entry,
  ) {
    const child = spawn(process.execPath, [executable, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdin.on('error', () => {
      /* A bounded reader may close before a rejected oversized write finishes. */
    });
    child.stdin.end(input);
    const finished = new Promise<Record<string, unknown>>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code !== 0)
          return reject(new Error(`Bootstrap exited ${code}: ${stderr}`));
        try {
          expect(Buffer.byteLength(stdout)).toBeLessThan(64 * 1024);
          expect(stdout.trim().split('\n')).toHaveLength(1);
          resolve(JSON.parse(stdout) as Record<string, unknown>);
        } catch (error) {
          reject(error);
        }
      });
    });
    return { child, finished };
  }

  // The child must boot Node, register the tsx loader and import the
  // bootstrap before it reaches the unlink hook. A fixed iteration count
  // races that real I/O under CI contention (#16580), so poll against a
  // wall-clock deadline instead. Capture the budget once: the helper's
  // second argument caps the magnitude it returns, not elapsed time, so
  // re-reading it as a predicate would let the cap go inert and poll to the
  // lane ceiling. The helper already reserves the reporting second, and a
  // disabled test timeout still yields the finite cap here.
  async function waitForCleanupMarker(
    entered: string,
    testTimeoutMs: number,
    capMs = 30_000,
  ) {
    const cleanupBudgetMs = createSettleTimeout(testTimeoutMs, capMs)();
    const cleanupDeadline = performance.now() + cleanupBudgetMs;
    for (;;) {
      if (
        await fs.access(entered).then(
          () => true,
          () => false,
        )
      )
        return;
      if (performance.now() >= cleanupDeadline)
        throw new Error('Original upload did not reach cleanup.');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it('advertises the upload handshake separately from read access', async () => {
    const response = await launch('', ['--help']).finished;
    expect(response).toEqual({
      protocolVersion: 1,
      capabilities: { workspaceFiles: 1, workspaceFileUpload: 1 },
    });
  });

  it('accepts a large binary payload only through the bounded dedicated entry', async () => {
    const bytes = Buffer.alloc(128 * 1024, 0xfa);
    const info = metadata(bytes);
    const request = JSON.stringify({
      ...envelope,
      files: { ...info, operation: 'upload', data: bytes.toString('base64') },
    });
    expect(await launch(request, []).finished).toMatchObject({ ok: false });
    expect(await fs.readdir(root)).toEqual([]);
    expect(await launch(request).finished).toMatchObject({
      ok: true,
      result: { files: { ...info, state: 'completed' } },
    });
    expect(await fs.readFile(path.join(root, info.path))).toEqual(bytes);
  });

  it('rejects non-upload operations and transport input beyond 12 MiB', async () => {
    expect(await launch(JSON.stringify(envelope)).finished).toMatchObject({
      ok: false,
    });
    expect(
      await launch(' '.repeat(12 * 1024 * 1024 + 1)).finished,
    ).toMatchObject({ ok: false });
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('tombstones a never-started upload before a later process can mutate', async () => {
    const bytes = Buffer.from('late');
    const info = metadata(bytes);
    const status = {
      ...envelope,
      files: { ...info, operation: 'upload-status' },
    };
    const response = await launch(JSON.stringify(status)).finished;
    expect(response).toMatchObject({
      ok: true,
      result: {
        files: { state: 'failed', code: 'ssh_runtime_file_upload_not_started' },
      },
    });
    expect(
      await launch(
        JSON.stringify({
          ...envelope,
          files: {
            ...info,
            operation: 'upload',
            data: bytes.toString('base64'),
          },
        }),
      ).finished,
    ).toEqual(response);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('keeps a live writer pending and recovers the original path after its process dies', async ({
    task,
  }) => {
    const bytes = Buffer.from([0, 0xff, 0x80, 10]);
    const info = metadata(bytes);
    const entered = path.join(temporary, 'before-cleanup');
    const paused = path.join(temporary, 'paused.mjs');
    await fs.writeFile(
      paused,
      `import {register} from ${JSON.stringify(api)};\nimport {promises as fs} from 'node:fs';\nregister({tsconfig:${JSON.stringify(tsconfig)}});\nconst unlink=fs.unlink.bind(fs);\nfs.unlink=async function(file){if(String(file).endsWith(${JSON.stringify(`.qwen-managed-upload-${info.uploadId}.tmp`)})){await fs.writeFile(${JSON.stringify(entered)},'ready');await new Promise(()=>setInterval(()=>{},1000));}return unlink(file);};\nawait (await import(${JSON.stringify(source)})).runManagedRuntimeBootstrap(false,true);\n`,
    );
    const original = launch(
      JSON.stringify({
        ...envelope,
        files: { ...info, operation: 'upload', data: bytes.toString('base64') },
      }),
      [],
      paused,
    );
    const stopped = original.finished.catch(() => undefined);
    await waitForCleanupMarker(entered, task.timeout);
    const status = JSON.stringify({
      ...envelope,
      files: { ...info, operation: 'upload-status' },
    });
    expect(await launch(status).finished).toMatchObject({
      ok: true,
      result: { files: { state: 'pending' } },
    });
    original.child.kill('SIGKILL');
    await stopped;
    expect(await launch(status).finished).toMatchObject({
      ok: true,
      result: { files: { state: 'completed', ...info } },
    });
    expect(await fs.readFile(path.join(root, info.path))).toEqual(bytes);
    expect(await fs.readdir(root)).toEqual([info.path]);
  });

  it(
    'reports the descriptive cleanup error before the runner timeout',
    { timeout: 3_000 },
    async ({ task }) => {
      // Park a child that never writes the marker so the poll must exhaust
      // its budget. This ceiling is deliberately small: deriving the budget
      // from `task.timeout` leaves a second to report, while ignoring it
      // would let the runner timeout fire first and lose the descriptive
      // error that #16580's lane depends on.
      const parked = path.join(temporary, 'parked.mjs');
      await fs.writeFile(
        parked,
        'await new Promise(()=>setInterval(()=>{},1000));\n',
      );
      const child = launch('', [], parked);
      child.finished.catch(() => undefined);
      await expect(
        waitForCleanupMarker(
          path.join(temporary, 'never-written'),
          task.timeout,
        ),
      ).rejects.toThrow('Original upload did not reach cleanup.');
    },
  );

  it(
    'caps the cleanup poll at the budget rather than the lane ceiling',
    { timeout: 5_000 },
    async ({ task }) => {
      // A cap below the ceiling separates a captured budget from re-reading
      // the helper as a predicate: the predicate stays above its floor until
      // the ceiling, so the throw would land near 4s instead of near 1s.
      const startedAt = performance.now();
      await expect(
        waitForCleanupMarker(
          path.join(temporary, 'never-written'),
          task.timeout,
          1_000,
        ),
      ).rejects.toThrow('Original upload did not reach cleanup.');
      expect(performance.now() - startedAt).toBeLessThan(2_500);
    },
  );
});
