/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionWriterLease } from '../services/session-writer-lease.js';
import { LocalToolResultSegmentStore } from './local-managed-tool-result-store.js';

const fault = vi.hoisted(() => ({
  mode: '' as '' | 'write' | 'sync',
  target: '',
  missingOnce: undefined as undefined | (() => Promise<void>),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      if (fault.missingOnce && String(args[0]) === fault.target) {
        const beforeMissing = fault.missingOnce;
        fault.missingOnce = undefined;
        await beforeMissing();
        throw Object.assign(new Error('stale missing segment'), {
          code: 'ENOENT',
        });
      }
      return actual.lstat(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const [file, flags] = args;
      if (
        fault.mode === 'write' &&
        flags === 'wx' &&
        String(file).includes('.pending-') &&
        path.basename(String(file)) === 'bytes'
      ) {
        fault.mode = '';
        throw Object.assign(new Error('injected write failure'), {
          code: 'EIO',
        });
      }
      const handle = await actual.open(...args);
      if (
        fault.mode === 'sync' &&
        flags === 'r' &&
        String(file) === fault.target
      ) {
        fault.mode = '';
        vi.spyOn(handle, 'sync').mockRejectedValueOnce(
          Object.assign(new Error('injected sync failure'), { code: 'EIO' }),
        );
      }
      return handle;
    },
  };
});

const key = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  sessionId: 'session-a',
};
const opened: Array<{
  root: string;
  store: LocalToolResultSegmentStore;
  lease: SessionWriterLease;
}> = [];

async function harness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-o1b-fault-'));
  const runtimeBaseDir = path.join(root, 'runtime');
  const transcriptPath = path.join(
    runtimeBaseDir,
    'chats',
    `${key.sessionId}.jsonl`,
  );
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  const lease = await SessionWriterLease.acquire({
    runtimeBaseDir,
    sessionId: key.sessionId,
    transcriptPath,
  });
  const store = await LocalToolResultSegmentStore.openWritable({
    lease,
    sessionKey: key,
  });
  opened.push({ root, store, lease });
  return { store, runtimeBaseDir };
}

afterEach(async () => {
  fault.mode = '';
  fault.missingOnce = undefined;
  for (const { root, store, lease } of opened) {
    await store.close();
    await lease.release();
    await fs.rm(root, { recursive: true, force: true });
  }
  opened.length = 0;
});

describe('local tool-result disk faults', () => {
  it('rechecks a sealed prefix across consecutive stale gaps', async () => {
    const { store, runtimeBaseDir } = await harness();
    const bytes = Buffer.from('first');
    const later = Buffer.from('later');
    const last = Buffer.from('last');
    const request = { captureId: 'capture', streamId: 'stdout' };
    expect(
      (await store.publish({ ...request, ordinal: 0, bytes })).status,
    ).toBe('ok');
    const reader = await LocalToolResultSegmentStore.openReadOnly({
      runtimeBaseDir,
      sessionKey: key,
    });
    fault.target = path.join(
      store.root,
      'capture-capture',
      'stream-stdout',
      'segment-00001',
    );
    fault.missingOnce = async () => {
      expect(
        (await store.publish({ ...request, ordinal: 1, bytes: later })).status,
      ).toBe('ok');
      fault.target = path.join(
        store.root,
        'capture-capture',
        'stream-stdout',
        'segment-00002',
      );
      fault.missingOnce = async () => {
        expect(
          (await store.publish({ ...request, ordinal: 2, bytes: last })).status,
        ).toBe('ok');
        expect(
          (
            await store.seal({
              ...request,
              segmentCount: 3,
              byteLength: bytes.byteLength + later.byteLength + last.byteLength,
              digest: createHash('sha256')
                .update(bytes)
                .update(later)
                .update(last)
                .digest('hex'),
            })
          ).status,
        ).toBe('ok');
      };
    };
    expect(await reader.prefix(request)).toMatchObject({
      status: 'ok',
      result: { segmentCount: 3, sealed: true },
    });
    await fs.writeFile(
      path.join(
        store.root,
        'capture-capture',
        'stream-stdout',
        'segment-00000',
        'bytes',
      ),
      'wrong',
    );
    expect(await reader.prefix(request)).toEqual({
      status: 'refused',
      code: 'managed_tool_result_digest_mismatch',
    });
    await reader.close();
  });

  it('retries syncing a parent after its child directory already exists', async () => {
    const { store } = await harness();
    const request = {
      captureId: 'capture',
      streamId: 'stdout',
      ordinal: 0,
      bytes: Buffer.from('first'),
    };
    fault.target = store.root;
    fault.mode = 'sync';
    await expect(store.publish(request)).rejects.toThrow(
      'injected sync failure',
    );
    await expect(
      fs.stat(path.join(store.root, 'capture-capture')),
    ).resolves.toBeDefined();
    fault.mode = 'sync';
    await expect(store.publish(request)).rejects.toThrow(
      'injected sync failure',
    );
    expect((await store.publish(request)).status).toBe('ok');
  });

  it('does not publish a segment when staging write fails', async () => {
    const { store } = await harness();
    fault.mode = 'write';
    await expect(
      store.publish({
        captureId: 'capture',
        streamId: 'stdout',
        ordinal: 0,
        bytes: Buffer.from('first'),
      }),
    ).rejects.toThrow('injected write failure');
    expect(
      await store.prefix({ captureId: 'capture', streamId: 'stdout' }),
    ).toMatchObject({
      status: 'ok',
      result: { segmentCount: 0, sealed: false },
    });
    expect(
      (
        await store.publish({
          captureId: 'capture',
          streamId: 'stdout',
          ordinal: 0,
          bytes: Buffer.from('first'),
        })
      ).status,
    ).toBe('ok');
  });

  it('retries the directory sync before acknowledging an already installed segment', async () => {
    const { store } = await harness();
    fault.target = path.join(store.root, 'capture-capture', 'stream-stdout');
    fault.mode = 'sync';
    const request = {
      captureId: 'capture',
      streamId: 'stdout',
      ordinal: 0,
      bytes: Buffer.from('first'),
    };
    await expect(store.publish(request)).rejects.toThrow(
      'injected sync failure',
    );
    expect(
      await fs.readFile(
        path.join(fault.target, 'segment-00000', 'bytes'),
        'utf8',
      ),
    ).toBe('first');
    fault.mode = 'sync';
    await expect(store.publish(request)).rejects.toThrow(
      'injected sync failure',
    );
    expect((await store.publish(request)).status).toBe('ok');
    expect(
      await store.seal({
        captureId: 'capture',
        streamId: 'stdout',
        segmentCount: 1,
        byteLength: 5,
        digest: createHash('sha256').update('first').digest('hex'),
      }),
    ).toMatchObject({ status: 'ok' });
  });

  it('retries the directory sync before acknowledging an already installed seal', async () => {
    const { store } = await harness();
    const bytes = Buffer.from('first');
    expect(
      (
        await store.publish({
          captureId: 'capture',
          streamId: 'stdout',
          ordinal: 0,
          bytes,
        })
      ).status,
    ).toBe('ok');
    const request = {
      captureId: 'capture',
      streamId: 'stdout',
      segmentCount: 1,
      byteLength: bytes.byteLength,
      digest: createHash('sha256').update(bytes).digest('hex'),
    };
    fault.target = path.join(store.root, 'capture-capture', 'stream-stdout');
    fault.mode = 'sync';
    await expect(store.seal(request)).rejects.toThrow('injected sync failure');
    await expect(
      fs.stat(path.join(fault.target, 'seal', 'receipt.json')),
    ).resolves.toBeDefined();
    fault.mode = 'sync';
    await expect(store.seal(request)).rejects.toThrow('injected sync failure');
    expect((await store.seal(request)).status).toBe('ok');
  });
});
