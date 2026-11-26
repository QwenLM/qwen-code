/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { ManagedSessionDurableRef } from './managed-session-records.js';
import {
  parseToolResultManifestBytes,
  type ToolResultManifest,
} from './managed-tool-result.js';
import { ResourceToolResultSegmentStore } from './resource-tool-result-store.js';
import {
  LocalShellStreamCapture,
  type LocalShellStreamCaptureOptions,
} from './local-shell-stream-capture.js';
import {
  BACKGROUND_SEGMENT_BYTES,
  BACKGROUND_SEGMENTS_PER_PAGE,
} from './managed-delivery-entry.js';

// Phase 3b characterization (design §10 "Capture equivalence"): the
// worker-owned background capture runs the shipped delivery geometry (128 KiB
// segments, 256 per page, a revision per segment) where the Harness foreground
// capture uses 1 MiB and 512. The granularity differs, but the content must
// not: the same input bytes produce the same per-stream running digest and the
// same reconstructable output, and the same final execution status. This pins
// that the move into the worker changes no observable Artifact content.

const IDENTITY = {
  tenantId: 'tenant-1',
  sessionId: '550e8400-e29b-41d4-a716-446655440000',
  turnId: 'turn-1',
  executionCallId: 'call-1',
  callId: 'binding-1',
  invocationDigest: 'd'.repeat(64),
  bindingGeneration: '1',
  captureId: 'capture-equivalence',
  revision: 1,
} as const;

function memoryResources() {
  const bytes = new Map<string, Buffer>();
  return {
    bytes,
    async publish(kind: string, body: Buffer, resourceId = randomUUID()) {
      const ref: ManagedSessionDurableRef = {
        resourceId,
        kind,
        schemaVersion: 1,
        byteLength: body.byteLength,
        digest: createHash('sha256').update(body).digest('hex'),
      };
      const prior = bytes.get(resourceId);
      if (prior && !prior.equals(body)) {
        throw new Error('resource identity conflicts');
      }
      bytes.set(resourceId, Buffer.from(body));
      return ref;
    },
    async read(ref: ManagedSessionDurableRef) {
      const body = bytes.get(ref.resourceId);
      if (!body) throw new Error('resource unavailable');
      return Buffer.from(body);
    },
  };
}

interface Captured {
  readonly manifest: ToolResultManifest;
  readonly manifestRef: ManagedSessionDurableRef;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly segmentCount: number;
  readonly pageCount: number;
}

async function capture(
  chunks: ReadonlyArray<{ stream: 'stdout' | 'stderr'; bytes: Buffer }>,
  options: LocalShellStreamCaptureOptions,
): Promise<Captured> {
  const resources = memoryResources();
  const segmentStore = new ResourceToolResultSegmentStore(resources);
  const sink = new LocalShellStreamCapture(
    segmentStore,
    resources,
    IDENTITY,
    async () => {},
    options,
  );
  sink.setStarted(42);
  for (const chunk of chunks) {
    await sink.write(chunk.stream, chunk.bytes);
  }
  await sink.finish('stdout', true);
  await sink.finish('stderr', true);
  sink.setProcessResult({ exitCode: 0, signal: null });
  const envelope = await sink.finalize(
    'success',
    [{ text: 'done' }],
    undefined,
  );
  const manifestRef = envelope.capture!.manifest!;
  const manifest = parseToolResultManifestBytes(
    await resources.read(manifestRef),
  );
  const read = async (streamId: 'stdout' | 'stderr') => {
    const entry = manifest.contents.find((c) => c.streamId === streamId)!;
    const result = await segmentStore.readRange({
      manifestRef,
      expectedIdentity: { ...IDENTITY, revision: manifest.revision },
      streamId,
      offset: 0,
      length: entry.byteLength,
    });
    if (result.status !== 'ok') throw new Error('readRange refused');
    return result.result;
  };
  let segmentCount = 0;
  let pageCount = 0;
  for (const entry of manifest.contents) {
    if ('pages' in entry.body) {
      pageCount += entry.body.pages.length;
      segmentCount += entry.body.pages.reduce((n, p) => n + p.segmentCount, 0);
    }
  }
  return {
    manifest,
    manifestRef,
    stdout: await read('stdout'),
    stderr: await read('stderr'),
    segmentCount,
    pageCount,
  };
}

function streamSummary(manifest: ToolResultManifest, streamId: string) {
  const entry = manifest.contents.find((c) => c.streamId === streamId)!;
  return {
    byteLength: entry.byteLength,
    digest: entry.digest,
    state: entry.state,
  };
}

it('worker and Harness captures produce identical content for the same bytes', async () => {
  // ~3 MiB of deterministic stdout crosses several 1 MiB Harness segments and
  // many 128 KiB worker segments; stderr is smaller; a multi-byte UTF-8 char is
  // split across two chunks to prove byte-level (not character-level) capture.
  const big = Buffer.alloc(3 * 1024 * 1024 + 17);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
  const euro = Buffer.from('€', 'utf8'); // 3 bytes
  const stderr = Buffer.concat([Buffer.from('warn: '), euro.subarray(0, 1)]);
  const stderrTail = Buffer.concat([euro.subarray(1), Buffer.from('\n')]);
  const chunks = [
    { stream: 'stdout' as const, bytes: big.subarray(0, 1024 * 1024) },
    { stream: 'stderr' as const, bytes: stderr },
    {
      stream: 'stdout' as const,
      bytes: big.subarray(1024 * 1024, 2 * 1024 * 1024 + 5),
    },
    { stream: 'stderr' as const, bytes: stderrTail },
    { stream: 'stdout' as const, bytes: big.subarray(2 * 1024 * 1024 + 5) },
    { stream: 'stdout' as const, bytes: Buffer.alloc(0) },
  ];
  const expectedStdout = big;
  const expectedStderr = Buffer.concat([stderr, stderrTail]);

  const harness = await capture(chunks, {});
  const worker = await capture(chunks, {
    segmentBytes: BACKGROUND_SEGMENT_BYTES,
    segmentsPerPage: BACKGROUND_SEGMENTS_PER_PAGE,
    revisionPerSegment: true,
  });

  // Same final content per stream, regardless of segment/page granularity.
  for (const streamId of ['stdout', 'stderr']) {
    expect(streamSummary(worker.manifest, streamId)).toEqual(
      streamSummary(harness.manifest, streamId),
    );
  }
  expect(worker.manifest.executionStatus).toBe(
    harness.manifest.executionStatus,
  );
  expect(worker.manifest.executionStatus).toBe('success');

  // Reconstructable bytes are exactly the input, and equal across both lanes.
  expect(harness.stdout.equals(expectedStdout)).toBe(true);
  expect(worker.stdout.equals(expectedStdout)).toBe(true);
  expect(harness.stderr.equals(expectedStderr)).toBe(true);
  expect(worker.stderr.equals(expectedStderr)).toBe(true);
  expect(worker.stdout.equals(harness.stdout)).toBe(true);
  expect(worker.stderr.equals(harness.stderr)).toBe(true);

  // The granularity genuinely differs (the worker segments more finely), so
  // the equivalence above is not a trivial same-configuration comparison.
  expect(worker.segmentCount).toBeGreaterThan(harness.segmentCount);
});

it('equivalence holds for an empty stream and a single partial segment', async () => {
  const chunks = [
    { stream: 'stdout' as const, bytes: Buffer.from('only a little\n') },
  ];
  const harness = await capture(chunks, {});
  const worker = await capture(chunks, {
    segmentBytes: BACKGROUND_SEGMENT_BYTES,
    segmentsPerPage: BACKGROUND_SEGMENTS_PER_PAGE,
    revisionPerSegment: true,
  });
  for (const streamId of ['stdout', 'stderr']) {
    expect(streamSummary(worker.manifest, streamId)).toEqual(
      streamSummary(harness.manifest, streamId),
    );
  }
  expect(worker.stdout.equals(harness.stdout)).toBe(true);
  expect(worker.stdout.toString()).toBe('only a little\n');
  expect(worker.stderr.byteLength).toBe(0);
});
