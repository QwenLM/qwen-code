/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  ResourceToolResultSegmentStore,
  type DurableToolResultResourceStore,
} from './resource-tool-result-store.js';
import { LocalShellResultCapture } from './local-shell-result-capture.js';
import type { ManagedSessionDurableRef } from './managed-session-records.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const hash = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
async function resources(): Promise<DurableToolResultResourceStore> {
  const root = await mkdtemp(path.join(tmpdir(), 'hosted-result-store-'));
  roots.push(root);
  return {
    async publish(kind, bytes, resourceId = randomUUID()) {
      const ref = {
        resourceId,
        kind,
        schemaVersion: 1,
        byteLength: bytes.length,
        digest: hash(bytes),
      };
      const file = path.join(root, resourceId);
      try {
        await writeFile(file, bytes, { flag: 'wx' });
      } catch {
        const prior = await readFile(file);
        if (!prior.equals(bytes)) throw new Error('Resource conflict.');
      }
      return ref;
    },
    async read(ref: ManagedSessionDurableRef) {
      return readFile(path.join(root, ref.resourceId));
    },
  };
}

const identity = {
  tenantId: 'tenant',
  sessionId: 'session',
  turnId: 'turn',
  executionCallId: 'execution',
  callId: 'call',
  invocationDigest: 'digest',
  bindingGeneration: '1',
  captureId: 'capture',
  revision: 1,
};

it('verifies raw bytes, seals and pages with a fresh reader after the producer closes', async () => {
  const durable = await resources();
  const store = new ResourceToolResultSegmentStore(durable);
  const capture = new LocalShellResultCapture(store, durable, identity);
  const unit = Buffer.alloc(1024 * 1024, 0x91);
  const tail = Buffer.from('independent-tail\0');
  capture.setStarted(1);
  await capture.write('stdout', unit);
  await capture.write('stdout', unit);
  await capture.write('stdout', tail);
  await capture.write('stderr', Buffer.from('separate stderr'));
  await capture.finish('stdout', true);
  await capture.finish('stderr', true);
  capture.setProcessResult({
    rawOutput: Buffer.alloc(8192),
    output: '',
    exitCode: 0,
    signal: null,
    error: null,
    aborted: false,
    pid: 1,
    executionMethod: 'child_process',
  });
  const result = await capture.finalize('success', [{ text: 'preview' }]);
  expect(result.capture).toMatchObject({
    captureStatus: 'complete',
    previewTruncated: true,
  });
  const manifestRef = result.capture!.manifest!;
  await store.close();
  const reader = new ResourceToolResultSegmentStore(durable);
  const read = await reader.readRange({
    manifestRef,
    expectedIdentity: identity,
    streamId: 'stdout',
    offset: unit.length * 2 - 3,
    length: tail.length + 3,
  });
  expect(read.status).toBe('ok');
  if (read.status === 'ok')
    expect(read.result).toEqual(Buffer.concat([unit.subarray(0, 3), tail]));
  expect(
    (
      await reader.readRange({
        manifestRef,
        expectedIdentity: { ...identity, sessionId: 'foreign' },
        streamId: 'stdout',
        offset: 0,
        length: 1,
      })
    ).status,
  ).toBe('refused');
  const original = durable.read.bind(durable);
  vi.spyOn(durable, 'read').mockImplementation(async (ref) => {
    const bytes = await original(ref);
    if (ref.byteLength === unit.length) bytes[0] ^= 1;
    return bytes;
  });
  await expect(
    reader.readRange({
      manifestRef,
      expectedIdentity: identity,
      streamId: 'stdout',
      offset: 0,
      length: 1,
    }),
  ).rejects.toThrow('Corrupt');
  await reader.close();
});

it('does not advance its prefix on a lost publication reply and safely retries the same immutable ID', async () => {
  const durable = await resources();
  const publish = durable.publish.bind(durable);
  let fail = true;
  vi.spyOn(durable, 'publish').mockImplementation(async (...args) => {
    const ref = await publish(...args);
    if (fail) {
      fail = false;
      throw new Error('reply lost');
    }
    return ref;
  });
  const store = new ResourceToolResultSegmentStore(durable);
  const request = {
    captureId: 'capture',
    streamId: 'stdout',
    ordinal: 0,
    bytes: Buffer.from('abc'),
  };
  await expect(store.publish(request)).rejects.toThrow('reply lost');
  expect(
    await store.prefix({ captureId: 'capture', streamId: 'stdout' }),
  ).toMatchObject({ result: { segmentCount: 0 } });
  expect(await store.publish(request)).toMatchObject({
    status: 'ok',
    result: { byteLength: 3 },
  });
  expect(
    await store.publish({ ...request, bytes: Buffer.from('changed') }),
  ).toMatchObject({ status: 'refused' });
  expect(await store.publish({ ...request, ordinal: 2 })).toMatchObject({
    status: 'refused',
  });
  expect(
    await store.seal({
      captureId: 'capture',
      streamId: 'stdout',
      segmentCount: 1,
      byteLength: 3,
      digest: hash(request.bytes),
    }),
  ).toMatchObject({ status: 'ok' });
  expect(
    await store.seal({
      captureId: 'capture',
      streamId: 'stdout',
      segmentCount: 1,
      byteLength: 3,
      digest: hash(Buffer.from('changed')),
    }),
  ).toMatchObject({ status: 'refused', code: 'managed_tool_result_conflict' });
  expect(await store.publish({ ...request, ordinal: 1 })).toMatchObject({
    status: 'refused',
  });
  await store.close();
});
