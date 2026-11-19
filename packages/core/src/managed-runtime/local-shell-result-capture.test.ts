/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ShellExecutionService,
  type ShellRawCaptureSink,
} from '../services/shellExecutionService.js';
import { SessionWriterLease } from '../services/session-writer-lease.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import { LocalToolResultSegmentStore } from './local-managed-tool-result-store.js';
import { LocalShellResultCapture } from './local-shell-result-capture.js';
import { parseToolResultManifestBytes } from './managed-tool-result.js';
import type { ToolResultSegmentStore } from './managed-tool-result-store.js';

const sessionKey = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  sessionId: 'session-a',
};

const identity = {
  tenantId: sessionKey.tenantId,
  sessionId: sessionKey.sessionId,
  turnId: 'turn-a',
  executionCallId: 'execution-a',
  callId: 'call-a',
  invocationDigest: 'digest-a',
  bindingGeneration: '1',
  captureId: 'capture-a',
  revision: 1,
};

const roots = new Set<string>();
afterEach(async () => {
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  roots.clear();
});

async function createStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-shell-o1c-'));
  roots.add(root);
  const runtimeBaseDir = path.join(root, 'runtime');
  const transcriptPath = path.join(runtimeBaseDir, 'chats', 'session-a.jsonl');
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  const lease = await SessionWriterLease.acquire({
    runtimeBaseDir,
    sessionId: sessionKey.sessionId,
    transcriptPath,
  });
  const store = await LocalToolResultSegmentStore.openWritable({
    lease,
    sessionKey,
  });
  const resources = LocalManagedSessionResourceStore.create({
    runtimeBaseDir,
    sessionKey,
  });
  return { root, lease, store, resources };
}

describe('foreground Shell local result capture', () => {
  it('retains 100 MiB or 1 GiB of raw pipe bytes with bounded memory', async () => {
    const { root, lease, store, resources } = await createStore();
    try {
      const count = process.env['O1C_STRESS'] === '1' ? 1024 : 100;
      let inFlight = 0;
      let peakInFlight = 0;
      const observedStore: ToolResultSegmentStore = {
        publish: async (request) => {
          inFlight++;
          peakInFlight = Math.max(peakInFlight, inFlight);
          try {
            if (process.env['O1C_STRESS'] === '1') {
              await new Promise((resolve) => setTimeout(resolve, 2));
            }
            return await store.publish(request);
          } finally {
            inFlight--;
          }
        },
        seal: (request) => store.seal(request),
        prefix: (request) => store.prefix(request),
        readRange: (request) => store.readRange(request),
        close: () => store.close(),
      };
      const capture = new LocalShellResultCapture(
        observedStore,
        resources,
        identity,
      );
      const unit = Buffer.alloc(1024 * 1024, 0x91);
      const expected = createHash('sha256');
      for (let index = 0; index < count; index++) expected.update(unit);
      const initialBuffers = process.memoryUsage().arrayBuffers;
      let peakBuffers = initialBuffers;
      const initialRss = process.memoryUsage().rss;
      let peakRss = initialRss;
      const sample = setInterval(() => {
        const usage = process.memoryUsage();
        peakBuffers = Math.max(peakBuffers, usage.arrayBuffers);
        peakRss = Math.max(peakRss, usage.rss);
      }, 25);
      const source = `
        const { once } = require('node:events');
        (async () => {
          const bytes = Buffer.alloc(1024 * 1024, 0x91);
          for (let index = 0; index < ${count}; index++) {
            if (!process.stdout.write(bytes)) await once(process.stdout, 'drain');
          }
          process.stderr.write(Buffer.from([0, 255, 192, 0, 169]));
        })().catch(() => process.exit(1));
      `;
      const handle = await ShellExecutionService.executeLaunch(
        {
          executable: process.execPath,
          args: ['-e', source],
          cwd: root,
          env: Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
        },
        () => {},
        new AbortController().signal,
        false,
        { maxBufferedOutputBytes: 64 * 1024 },
        { rawCapture: capture },
      );
      expect(handle.pid).toBeGreaterThan(0);
      capture.setStarted(handle.pid!);
      let result;
      try {
        result = await handle.result;
      } finally {
        clearInterval(sample);
      }
      capture.setProcessResult(result);
      expect(result.rawOutput.byteLength).toBeLessThanOrEqual(64 * 1024);
      const envelope = await capture.finalize('success', []);
      expect(envelope.capture?.captureStatus).toBe('complete');
      const manifestRef = envelope.capture?.manifest;
      expect(manifestRef).not.toBeNull();
      const manifest = parseToolResultManifestBytes(
        await resources.read(manifestRef!),
      );
      const stdout = manifest.contents.find(
        (item) => item.streamId === 'stdout',
      )!;
      const stderr = manifest.contents.find(
        (item) => item.streamId === 'stderr',
      )!;
      expect(stdout.byteLength).toBe(count * 1024 * 1024);
      expect(stdout.digest).toBe(expected.digest('hex'));
      expect(stderr.byteLength).toBe(5);
      expect(peakInFlight).toBeLessThanOrEqual(2);
      expect(peakBuffers - initialBuffers).toBeLessThan(80 * 1024 * 1024);
      expect(peakRss - initialRss).toBeLessThan(256 * 1024 * 1024);
      expect(
        await store.readRange({
          manifestRef: manifestRef!,
          expectedIdentity: identity,
          streamId: 'stdout',
          offset: stdout.byteLength - 5,
          length: 5,
        }),
      ).toEqual({ status: 'ok', result: Buffer.alloc(5, 0x91) });
      expect(
        await store.readRange({
          manifestRef: manifestRef!,
          expectedIdentity: identity,
          streamId: 'stderr',
          offset: 0,
          length: 5,
        }),
      ).toEqual({
        status: 'ok',
        result: Buffer.from([0, 255, 192, 0, 169]),
      });
    } finally {
      await store.close();
      await lease.release();
    }
  }, 180_000);

  it('does not count slow persistence against the post-exit pipe drain', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-shell-drain-'));
    roots.add(root);
    const finished: Array<[string, boolean]> = [];
    const sink: ShellRawCaptureSink = {
      write: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      },
      finish: async (streamId, complete) => {
        finished.push([streamId, complete]);
      },
      setStarted: () => {},
      setProcessResult: () => {},
    };
    const handle = await ShellExecutionService.executeLaunch(
      {
        executable: process.execPath,
        args: ['-e', 'process.stdout.write("last bytes")'],
        cwd: root,
        env: {},
      },
      () => {},
      new AbortController().signal,
      false,
      { maxBufferedOutputBytes: 64 * 1024 },
      { rawCapture: sink },
    );
    await handle.result;
    expect(finished).toContainEqual(['stdout', true]);
    expect(finished).toContainEqual(['stderr', true]);
  }, 10_000);

  it('marks an inherited pipe tail incomplete after the drain boundary', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-shell-inherit-'),
    );
    roots.add(root);
    const finished: Array<[string, boolean]> = [];
    const sink: ShellRawCaptureSink = {
      write: async () => {},
      finish: async (streamId, complete) => {
        finished.push([streamId, complete]);
      },
      setStarted: () => {},
      setProcessResult: () => {},
    };
    const source = `
      const { spawn } = require('node:child_process');
      spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2500)'], {
        stdio: ['ignore', 'inherit', 'ignore'],
      }).unref();
      process.stdout.write('prefix');
    `;
    const handle = await ShellExecutionService.executeLaunch(
      {
        executable: process.execPath,
        args: ['-e', source],
        cwd: root,
        env: {},
      },
      () => {},
      new AbortController().signal,
      false,
      { maxBufferedOutputBytes: 64 * 1024 },
      { rawCapture: sink },
    );
    await handle.result;
    expect(finished).toContainEqual(['stdout', false]);
  }, 10_000);

  it('can seal accepted bytes when a running process is cancelled', async () => {
    const { root, lease, store, resources } = await createStore();
    try {
      const capture = new LocalShellResultCapture(store, resources, identity);
      const cancellation = new AbortController();
      let firstWrite!: () => void;
      const wrote = new Promise<void>((resolve) => {
        firstWrite = resolve;
      });
      const sink: ShellRawCaptureSink = {
        write: async (streamId, chunk) => {
          await capture.write(streamId, chunk);
          firstWrite();
        },
        finish: (streamId, complete) => capture.finish(streamId, complete),
        setStarted: (pid) => capture.setStarted(pid),
        setProcessResult: (result) => capture.setProcessResult(result),
      };
      const handle = await ShellExecutionService.executeLaunch(
        {
          executable: process.execPath,
          args: [
            '-e',
            'process.stdout.write("prefix"); setInterval(() => {}, 1000)',
          ],
          cwd: root,
          env: {},
        },
        () => {},
        cancellation.signal,
        false,
        { maxBufferedOutputBytes: 64 * 1024 },
        { rawCapture: sink },
      );
      sink.setStarted(handle.pid!);
      await wrote;
      cancellation.abort();
      const result = await handle.result;
      sink.setProcessResult(result);
      expect(result.aborted).toBe(true);
      const envelope = await capture.finalize('cancelled', []);
      expect(envelope.capture?.captureStatus).toBe('complete');
    } finally {
      await store.close();
      await lease.release();
    }
  }, 10_000);

  it('serializes overlapping writes that reach a segment boundary', async () => {
    const { lease, store, resources } = await createStore();
    try {
      const published: string[] = [];
      const observedStore: ToolResultSegmentStore = {
        publish: async (request) => {
          const { streamId, ordinal } = request as {
            streamId: string;
            ordinal: number;
          };
          published.push(`${streamId}#${ordinal}`);
          return store.publish(request);
        },
        seal: (request) => store.seal(request),
        prefix: (request) => store.prefix(request),
        readRange: (request) => store.readRange(request),
        close: () => store.close(),
      };
      const capture = new LocalShellResultCapture(
        observedStore,
        resources,
        identity,
      );
      capture.setStarted(42);
      // Node resumes a paused pipe when the child exits, so a second chunk
      // can arrive while the boundary publication is still in flight.
      const first = Buffer.alloc(1024 * 1024, 0x41);
      const second = Buffer.alloc(9, 0x42);
      await Promise.all([
        capture.write('stdout', first),
        capture.write('stdout', second),
      ]);
      await capture.finish('stdout', true);
      await capture.finish('stderr', true);
      capture.setProcessResult({
        rawOutput: Buffer.alloc(0),
        output: '',
        exitCode: 0,
        signal: null,
        error: null,
        aborted: false,
        pid: 42,
        executionMethod: 'child_process',
      });
      const envelope = await capture.finalize('success', []);
      expect(published).toEqual(['stdout#0', 'stdout#1']);
      expect(envelope.capture?.captureStatus).toBe('complete');
      const stdout = parseToolResultManifestBytes(
        await resources.read(envelope.capture!.manifest!),
      ).contents.find((item) => item.streamId === 'stdout')!;
      expect(stdout.byteLength).toBe(first.byteLength + second.byteLength);
      expect(stdout.digest).toBe(
        createHash('sha256').update(first).update(second).digest('hex'),
      );
    } finally {
      await store.close();
      await lease.release();
    }
  });

  it('seals a real pipe that ends just past a segment boundary', async () => {
    const { root, lease, store, resources } = await createStore();
    try {
      const capture = new LocalShellResultCapture(store, resources, identity);
      const size = 1024 * 1024 + 64 * 1024;
      const handle = await ShellExecutionService.executeLaunch(
        {
          executable: process.execPath,
          args: ['-e', `process.stdout.write(Buffer.alloc(${size}, 0x61))`],
          cwd: root,
          env: {},
        },
        () => {},
        new AbortController().signal,
        false,
        { maxBufferedOutputBytes: 64 * 1024 },
        { rawCapture: capture },
      );
      capture.setStarted(handle.pid!);
      capture.setProcessResult(await handle.result);
      const envelope = await capture.finalize('success', []);
      expect(envelope.capture?.captureStatus).toBe('complete');
      const stdout = parseToolResultManifestBytes(
        await resources.read(envelope.capture!.manifest!),
      ).contents.find((item) => item.streamId === 'stdout')!;
      expect(stdout.byteLength).toBe(size);
    } finally {
      await store.close();
      await lease.release();
    }
  }, 30_000);

  it('stops publishing after the Session writer lease is lost', async () => {
    const { root, lease, store, resources } = await createStore();
    try {
      const capture = new LocalShellResultCapture(store, resources, identity);
      capture.setStarted(42);
      await capture.write('stdout', Buffer.alloc(1024 * 1024, 0x41));
      await lease.release();
      await capture.write('stdout', Buffer.alloc(1024 * 1024, 0x42));
      await capture.finish('stdout', true);
      await capture.finish('stderr', true);
      capture.setProcessResult({
        rawOutput: Buffer.alloc(0),
        output: '',
        exitCode: 0,
        signal: null,
        error: null,
        aborted: false,
        pid: 42,
        executionMethod: 'child_process',
      });
      const envelope = await capture.finalize('success', []);
      expect(envelope.capture?.captureStatus).toBe('unavailable');
      expect(envelope.capture?.captureReason).toBe('storage_failed');
      const reader = await LocalToolResultSegmentStore.openReadOnly({
        runtimeBaseDir: path.join(root, 'runtime'),
        sessionKey,
      });
      try {
        expect(
          await reader.prefix({ captureId: 'capture-a', streamId: 'stdout' }),
        ).toMatchObject({
          status: 'ok',
          result: { byteLength: 1024 * 1024 },
        });
      } finally {
        await reader.close();
      }
    } finally {
      await store.close();
      await lease.release();
    }
  });

  it.each([
    'managed_tool_result_digest_mismatch',
    'managed_tool_result_invalid',
  ] as const)(
    'keeps a successful physical outcome when segment storage refuses %s',
    async (code) => {
      const { store, lease, resources } = await createStore();
      try {
        const capture = new LocalShellResultCapture(
          {
            publish: async () => ({
              status: 'refused',
              code,
            }),
            seal: (request) => store.seal(request),
            prefix: (request) => store.prefix(request),
            readRange: (request) => store.readRange(request),
            close: () => store.close(),
          },
          resources,
          identity,
        );
        capture.setStarted(42);
        await capture.write('stdout', Buffer.alloc(1024 * 1024, 0x41));
        await capture.finish('stdout', true);
        await capture.finish('stderr', true);
        capture.setProcessResult({
          rawOutput: Buffer.alloc(0),
          output: '',
          exitCode: 0,
          signal: null,
          error: null,
          aborted: false,
          pid: 42,
          executionMethod: 'child_process',
        });
        const envelope = await capture.finalize('success', []);
        expect(envelope.executionStatus).toBe('success');
        expect(envelope.capture).toMatchObject({
          captureStatus: 'unavailable',
          captureReason: 'storage_failed',
        });
      } finally {
        await store.close();
        await lease.release();
      }
    },
  );
});
