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
import {
  isToolResultManifestChainLink,
  isToolResultManifestSuccessor,
  isToolResultPageAt,
  MANAGED_TOOL_RESULT_KINDS,
  type ToolResultSegmentReceipt,
  type ToolResultStoreOutcome,
} from './managed-tool-result.js';
import type { ManagedSessionDurableRef } from './managed-session-records.js';
import type { ManagedSessionResourceStore } from './managed-session-storage.js';
import type { ToolResultSegmentStore } from './managed-tool-result-store.js';
import { LocalManagedSessionResourceStore } from './managed-session-resources.js';
import { LocalShellStreamCapture } from './local-shell-stream-capture.js';

const sessionKey = {
  tenantId: 'tenant-1',
  workspaceId: 'workspace-1',
  sessionId: '550e8400-e29b-41d4-a716-446655440000',
};

const temporaryDirectories = new Set<string>();
afterEach(async () => {
  for (const directory of temporaryDirectories) {
    await fs.rm(directory, { recursive: true, force: true });
  }
  temporaryDirectories.clear();
});

interface Rig {
  captured: LocalShellStreamCapture;
  readonly segments: Array<{
    ordinal: number;
    streamId: string;
    bytes: Buffer;
  }>;
  readonly sealed: Array<{ streamId: string; segmentCount: number }>;
  readonly pages: Buffer[];
  readonly manifests: Array<Record<string, unknown>>;
  readonly resources: LocalManagedSessionResourceStore;
  failManifestPublishesAfter: number;
  refuseSegments: boolean;
  refusePagePublishes: number;
  refuseSegmentCalls: number;
  holdFirstStderrPage(): void;
  readonly firstStderrPageSeen: Promise<void>;
  releaseFirstStderrPage(): void;
  holdFirstManifestPublish(): void;
  readonly firstManifestPublishSeen: Promise<void>;
  releaseFirstManifestPublish(): void;
}

const IDENTITY = {
  tenantId: sessionKey.tenantId,
  sessionId: sessionKey.sessionId,
  turnId: 'turn-1',
  executionCallId: 'call-1',
  callId: 'binding-1',
  invocationDigest: 'd'.repeat(64),
  bindingGeneration: '1',
  captureId: 'capture-1',
  revision: 1,
} as const;

async function rig(options: { segmentsPerPage?: number } = {}): Promise<Rig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-shell-stream-'));
  temporaryDirectories.add(root);
  const real = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: root,
    sessionKey,
  });
  const pages: Buffer[] = [];
  const manifests: Array<Record<string, unknown>> = [];
  let holdStderrPage = false;
  let markFirstStderrPageSeen: () => void = () => undefined;
  let releaseFirstStderrPage: () => void = () => undefined;
  const firstStderrPageSeen = new Promise<void>((resolve) => {
    markFirstStderrPageSeen = resolve;
  });
  const firstStderrPageReleased = new Promise<void>((resolve) => {
    releaseFirstStderrPage = resolve;
  });
  let holdManifestPublish = false;
  let markFirstManifestPublishSeen: () => void = () => undefined;
  let releaseFirstManifestPublish: () => void = () => undefined;
  const firstManifestPublishSeen = new Promise<void>((resolve) => {
    markFirstManifestPublishSeen = resolve;
  });
  const firstManifestPublishReleased = new Promise<void>((resolve) => {
    releaseFirstManifestPublish = resolve;
  });
  const rigState: Rig = {
    captured: null as unknown as LocalShellStreamCapture,
    segments: [],
    sealed: [],
    pages,
    manifests,
    resources: real,
    failManifestPublishesAfter: Number.POSITIVE_INFINITY,
    refuseSegments: false,
    refusePagePublishes: 0,
    refuseSegmentCalls: 0,
    holdFirstStderrPage: () => {
      holdStderrPage = true;
    },
    firstStderrPageSeen,
    releaseFirstStderrPage: () => {
      releaseFirstStderrPage();
    },
    holdFirstManifestPublish: () => {
      holdManifestPublish = true;
    },
    firstManifestPublishSeen,
    releaseFirstManifestPublish: () => {
      releaseFirstManifestPublish();
    },
  };
  let manifestPublishes = 0;
  const resources: ManagedSessionResourceStore = {
    publish: (kind: string, bytes: Buffer) => {
      if (
        kind === MANAGED_TOOL_RESULT_KINDS.manifest &&
        ++manifestPublishes > rigState.failManifestPublishesAfter
      ) {
        return Promise.reject(new Error('writable store is gone'));
      }
      const persist = () => {
        if (
          kind === MANAGED_TOOL_RESULT_KINDS.page &&
          rigState.refusePagePublishes > 0
        ) {
          rigState.refusePagePublishes -= 1;
          return Promise.reject(new Error('writable store is gone'));
        }
        return real.publish(kind, bytes).then((ref) => {
          if (kind === MANAGED_TOOL_RESULT_KINDS.page) pages.push(bytes);
          if (kind === MANAGED_TOOL_RESULT_KINDS.manifest) {
            manifests.push(
              JSON.parse(bytes.toString()) as Record<string, unknown>,
            );
          }
          return ref;
        });
      };
      if (
        kind === MANAGED_TOOL_RESULT_KINDS.page &&
        holdStderrPage &&
        bytes.includes('"streamId":"stderr"')
      ) {
        holdStderrPage = false;
        markFirstStderrPageSeen();
        return firstStderrPageReleased.then(persist);
      }
      if (kind === MANAGED_TOOL_RESULT_KINDS.manifest && holdManifestPublish) {
        holdManifestPublish = false;
        markFirstManifestPublishSeen();
        return firstManifestPublishReleased.then(persist);
      }
      return persist();
    },
    read: (ref: ManagedSessionDurableRef) => real.read(ref),
  };
  const store: ToolResultSegmentStore = {
    publish: (request: unknown) => {
      const typed = request as {
        captureId: string;
        streamId: 'stdout' | 'stderr';
        ordinal: number;
        bytes: Buffer;
      };
      if (rigState.refuseSegments || rigState.refuseSegmentCalls > 0) {
        if (rigState.refuseSegmentCalls > 0) rigState.refuseSegmentCalls -= 1;
        return Promise.resolve<
          ToolResultStoreOutcome<ToolResultSegmentReceipt>
        >({ status: 'refused', code: 'managed_tool_result_conflict' });
      }
      rigState.segments.push({
        ordinal: typed.ordinal,
        streamId: typed.streamId,
        // The class hands a subarray view of its reused buffer; a real store
        // persists bytes, so the double copies before remembering.
        bytes: Buffer.from(typed.bytes),
      });
      return Promise.resolve<ToolResultStoreOutcome<ToolResultSegmentReceipt>>({
        status: 'ok',
        result: {
          ordinal: typed.ordinal,
          byteLength: typed.bytes.byteLength,
          digest: createHash('sha256').update(typed.bytes).digest('hex'),
        },
      });
    },
    seal: (request: unknown) => {
      const typed = request as {
        streamId: 'stdout' | 'stderr';
        segmentCount: number;
        byteLength: number;
        digest: string;
      };
      if (rigState.refuseSegments) {
        return Promise.resolve({
          status: 'refused' as const,
          code: 'managed_tool_result_conflict' as const,
        });
      }
      rigState.sealed.push({
        streamId: typed.streamId,
        segmentCount: typed.segmentCount,
      });
      return Promise.resolve({
        status: 'ok' as const,
        result: {
          segmentCount: typed.segmentCount,
          byteLength: typed.byteLength,
          digest: typed.digest,
        },
      });
    },
    prefix: () =>
      Promise.resolve({
        status: 'ok' as const,
        result: {
          segmentCount: 0,
          byteLength: 0,
          digest: '0'.repeat(64),
          sealed: false,
        },
      }),
    readRange: () =>
      Promise.resolve({
        status: 'ok' as const,
        result: Buffer.alloc(0),
      }),
    close: () => Promise.resolve(),
  };
  rigState.captured = new LocalShellStreamCapture(
    store,
    resources,
    IDENTITY,
    async () => {},
    { segmentsPerPage: options.segmentsPerPage ?? 512 },
  );
  return rigState;
}

describe('LocalShellStreamCapture', () => {
  it('publishes the open manifest as revision 1 with open streams', async () => {
    const r = await rig();
    const ref = await r.captured.open();
    const manifest = JSON.parse((await r.resources.read(ref)).toString()) as {
      revision: number;
      executionStatus: string;
      captureStatus: string;
      contents: Array<{ state: string }>;
    };
    expect(manifest.revision).toBe(1);
    expect(manifest.executionStatus).toBe('unknown');
    expect(manifest.captureStatus).toBe('pending');
    expect(manifest.contents.map((each) => each.state)).toEqual([
      'open',
      'open',
    ]);
    expect(r.manifests).toHaveLength(1);
  });

  it('publishes each page with the next revision and never rewinds', async () => {
    const r = await rig({ segmentsPerPage: 2 });
    await r.captured.open();
    r.captured.setStarted(1);
    await r.captured.write('stdout', Buffer.alloc(2 * 1024 * 1024, 7));
    expect(r.segments).toHaveLength(2);
    expect(r.pages).toHaveLength(1);
    await r.captured.finish('stdout', true);
    await r.captured.finish('stderr', true);
    const final = await r.captured.finalize('success', [], undefined, {
      exitCode: 0,
      signalName: null,
    });
    expect(final.executionStatus).toBe('success');
    expect(final.capture).toMatchObject({
      captureStatus: 'complete',
      deliveryStatus: 'pending',
    });
    expect(r.manifests.map((each) => each['revision'])).toEqual([1, 2, 3]);
    for (let index = 1; index < r.manifests.length; index++) {
      expect(
        isToolResultManifestSuccessor(
          r.manifests[index - 1],
          r.manifests[index],
        ),
      ).toBe(true);
    }
    expect(r.manifests.at(-1)).toMatchObject({
      executionStatus: 'success',
      captureStatus: 'complete',
      exitCode: 0,
      signal: null,
    });
    expect(r.sealed).toEqual([
      { streamId: 'stdout', segmentCount: 2 },
      { streamId: 'stderr', segmentCount: 0 },
    ]);
    expect(
      r.segments.reduce(
        (length, segment) => length + segment.bytes.byteLength,
        0,
      ),
    ).toBe(2 * 1024 * 1024);
  });

  it('seals the tail page before publishing its revision', async () => {
    // A tail flush that closes the page at end time must publish the sealed
    // descriptor: the descriptor of an ended stream may never change again.
    const r = await rig({ segmentsPerPage: 2 });
    await r.captured.open();
    r.captured.setStarted(1);
    await r.captured.write('stdout', Buffer.alloc(1024 * 1024 + 16, 3));
    await r.captured.finish('stdout', true);
    const atEnd = r.manifests.at(-1)!;
    const stdout = (atEnd['contents'] as Array<Record<string, unknown>>)[0]!;
    expect(stdout['state']).toBe('sealed');
    expect(stdout['missingRanges']).toEqual([]);
    await r.captured.finish('stderr', true);
    const final = await r.captured.finalize('success', [], undefined, {
      exitCode: 0,
      signalName: null,
    });
    expect(final.capture).toMatchObject({ captureStatus: 'complete' });
    for (let index = 1; index < r.manifests.length; index++) {
      expect(
        isToolResultManifestSuccessor(
          r.manifests[index - 1],
          r.manifests[index],
        ),
      ).toBe(true);
    }
  });

  it('freezes the revision at its own flush boundary while a mid-flush segment opens its own next page', async () => {
    // A manifest revision flushes both streams, so the reviser's await can
    // straddle an append on the flushed stream's own queue. The segment
    // arriving in that window must begin a fresh pending page — folding it
    // into the in-flight page would count it into accounting the page does
    // not carry; the frozen descriptor never has to learn that broken.
    const r = await rig({ segmentsPerPage: 10 });
    await r.captured.open();
    r.captured.setStarted(1);
    const mib = (fill: number) => Buffer.alloc(1024 * 1024, fill);
    const digest = (fill: number) =>
      createHash('sha256').update(mib(fill)).digest('hex');
    await r.captured.write('stdout', mib(1));
    await r.captured.write('stderr', mib(2));
    r.holdFirstStderrPage();
    const finishingOut = r.captured.finish('stdout', true);
    // finish('stdout') revises the manifest, which flushes stderr's first
    // pending page; the hold stops at the flush's own publish await.
    await r.firstStderrPageSeen;
    await r.captured.write('stderr', mib(3));
    r.releaseFirstStderrPage();
    await finishingOut;
    const firstStderrPage = r.pages
      .map(
        (page) =>
          JSON.parse(page.toString()) as {
            streamId: string;
            segments: Array<{ digest: string }>;
          },
      )
      .find((page) => page.streamId === 'stderr')!;
    expect(firstStderrPage.streamId).toBe('stderr');
    expect(firstStderrPage.segments.map((segment) => segment.digest)).toEqual([
      digest(2),
    ]);
    // F4 R1/R2: the straddled segment opens its own next page instead of
    // poisoning the revision flushed behind it — no latch, no storage_failed.
    expect(r.captured.brokenReason).toBeNull();
    await r.captured.finish('stderr', true);
    const final = await r.captured.finalize('success', [], undefined, {
      exitCode: 0,
      signalName: null,
    });
    expect(final.capture).toMatchObject({
      captureStatus: 'complete',
      captureReason: null,
    });
    const stderrSegments = r.pages
      .map(
        (page) =>
          JSON.parse(page.toString()) as {
            streamId: string;
            segments: Array<{ digest: string }>;
          },
      )
      .filter((page) => page.streamId === 'stderr')
      .flatMap((page) => page.segments.map((segment) => segment.digest));
    expect(stderrSegments).toEqual([digest(2), digest(3)]);
  });

  it('serializes overlapping publishes so revision numbers walk exactly one step each (F4 R2)', async () => {
    // A manifest held at its own publish proves the single-flight slot:
    // the sibling publish's work lands its number exactly one step later,
    // never sharing the stale counter a non-serialized chain would leak.
    const r = await rig({ segmentsPerPage: 1 });
    await r.captured.open();
    r.captured.setStarted(1);
    await r.captured.write('stdout', Buffer.alloc(64 * 1024, 1));
    await r.captured.write('stderr', Buffer.alloc(64 * 1024, 2));
    r.holdFirstManifestPublish();
    const finishingStdOut = r.captured.finish('stdout', false);
    const finishingStdErr = r.captured.finish('stderr', false);
    await r.firstManifestPublishSeen;
    r.releaseFirstManifestPublish();
    await Promise.all([finishingStdOut, finishingStdErr]);
    const revisions = r.manifests.map(
      (manifest) => manifest['revision'] as number,
    );
    expect(revisions).toEqual(revisions.map((_, index) => index + 1));
  });

  it('continues the page cursor and links every page to its manifest slot', async () => {
    const r = await rig({ segmentsPerPage: 2 });
    await r.captured.open();
    r.captured.setStarted(1);
    await r.captured.write('stdout', Buffer.alloc(5 * 1024 * 1024, 9));
    await r.captured.finish('stdout', true);
    await r.captured.finish('stderr', true);
    await r.captured.finalize('success', [], undefined, {
      exitCode: 0,
      signalName: null,
    });
    expect(r.pages).toHaveLength(3);
    const parsed = r.pages.map(
      (bytes) =>
        JSON.parse(bytes.toString()) as {
          firstOrdinal: number;
          offset: number;
          segments: Array<{ byteLength: number }>;
        },
    );
    expect(parsed.map((page) => page.firstOrdinal)).toEqual([0, 2, 4]);
    expect(parsed.map((page) => page.offset)).toEqual([
      0,
      2 * 1024 * 1024,
      4 * 1024 * 1024,
    ]);
    const finalManifest = r.manifests.at(-1)!;
    r.pages.forEach((bytes, index) => {
      expect(
        isToolResultPageAt(
          finalManifest,
          0,
          index,
          JSON.parse(bytes.toString()),
        ),
      ).toBe(true);
    });
    // The same cursor space answers continuity: no gap, no overlap.
    const ordinals = parsed.flatMap((page) =>
      page.segments.map((segment, index) => ({
        ordinal: page.firstOrdinal + index,
        byteLength: segment.byteLength,
      })),
    );
    expect(ordinals.map((entry) => entry.ordinal)).toEqual([0, 1, 2, 3, 4]);
    expect(
      ordinals.reduce((length, entry) => length + entry.byteLength, 0),
    ).toBe(5 * 1024 * 1024);
  });

  it('flushes a healthy sibling at its own boundary when a revision arrives mid-flush', async () => {
    // Round-17 P2: stderr's page flush is held mid-publish with its batch
    // already spliced and its counters already advanced; a queue of
    // further stderr bytes parks behind it; then stdout's own revision
    // builds the manifest. The manifest's per-stream flush must run on
    // stderr's own boundary chain — freezing the live digest/byte length
    // against pages the held flush has not committed yet throws the
    // manifest validator, latches storage_failed through no storage
    // failure, and silently drops the queued tail.
    const r = await rig({ segmentsPerPage: 1 });
    await r.captured.open();
    r.captured.setStarted(1);
    const mib = (fill: number) => Buffer.alloc(1024 * 1024, fill);
    r.holdFirstStderrPage();
    const held = r.captured.write('stderr', mib(2));
    await r.firstStderrPageSeen;
    const queued = r.captured.write('stderr', mib(3));
    const sibling = r.captured.write('stdout', mib(1));
    // The sibling reaches its manifest build right after its own page
    // lands; from there the cross-stream consult is pure microtasks, so
    // one turn is every world it can take: the boundary chain parks it
    // behind the held flush, while without it the empty-pending branch
    // freezes live counters, the manifest validator throws and the
    // capture latches storage_failed through no storage failure.
    await vi.waitFor(() => {
      expect(
        r.pages.filter(
          (page) =>
            (JSON.parse(page.toString()) as { streamId: string }).streamId ===
            'stdout',
        ),
      ).toHaveLength(1);
    });
    await new Promise((resolve) => setImmediate(resolve));
    r.releaseFirstStderrPage();
    await Promise.all([held, queued, sibling]);
    // No latch and no drop: the sibling's revision froze stderr at its
    // own completed boundary, and the queued segment got its own page.
    expect(r.captured.brokenReason).toBeNull();
    await r.captured.finish('stdout', true);
    await r.captured.finish('stderr', true);
    const final = await r.captured.finalize('success', [], undefined, {
      exitCode: 0,
      signalName: null,
    });
    expect(final.capture).toMatchObject({
      captureStatus: 'complete',
      captureReason: null,
    });
    const digest = (fill: number) =>
      createHash('sha256').update(mib(fill)).digest('hex');
    const stderrSegments = r.pages
      .map(
        (page) =>
          JSON.parse(page.toString()) as {
            streamId: string;
            segments: Array<{ digest: string }>;
          },
      )
      .filter((page) => page.streamId === 'stderr')
      .flatMap((page) => page.segments.map((segment) => segment.digest));
    expect(stderrSegments).toEqual([digest(2), digest(3)]);
    expect(
      r.segments.reduce(
        (length, segment) => length + segment.bytes.byteLength,
        0,
      ),
    ).toBe(3 * 1024 * 1024);
    const settled = r.manifests.at(-1)!;
    const stderr = (settled['contents'] as Array<Record<string, unknown>>).find(
      (each) => each['streamId'] === 'stderr',
    )!;
    expect(stderr['byteLength']).toBe(2 * 1024 * 1024);
    for (let index = 1; index < r.manifests.length; index++) {
      expect(
        isToolResultManifestSuccessor(
          r.manifests[index - 1],
          r.manifests[index],
        ),
      ).toBe(true);
    }
  });

  it('succeeds the pending chain after a late storage failure', async () => {
    const r = await rig({ segmentsPerPage: 2 });
    await r.captured.open();
    r.captured.setStarted(1);
    await r.captured.write('stdout', Buffer.alloc(4 * 1024 * 1024, 5));
    expect(r.pages).toHaveLength(2);
    const pendingLast = r.manifests.at(-1)!;
    expect(pendingLast['captureStatus']).toBe('pending');
    r.refuseSegments = true;
    const lost = Buffer.alloc(1024 * 1024, 6);
    await r.captured.write('stdout', lost);
    const final = await r.captured.finalize(
      'error',
      [],
      { message: 'gone.' },
      {
        exitCode: null,
        signalName: 'SIGKILL',
      },
    );
    expect(r.captured.brokenReason).toEqual({ reason: 'storage_failed' });
    expect(final.capture).toMatchObject({
      captureStatus: 'partial',
      captureReason: 'storage_failed',
    });
    // The latch announces itself as its own revision between the pending
    // chain and the settled one, so the manifest never reads healthy-open
    // over a blind stream.
    const announced = r.manifests.at(-2)!;
    expect(announced['executionStatus']).toBe('unknown');
    expect(announced['captureStatus']).toBe('partial');
    expect(announced['captureReason']).toBe('storage_failed');
    const settled = r.manifests.at(-1)!;
    expect(settled['executionStatus']).toBe('error');
    expect(settled['signal']).toBe('SIGKILL');
    expect(isToolResultManifestChainLink(pendingLast, settled)).toBe(true);
    // Byte-level: the lost tail never entered any published page or segment.
    const lostDigest = createHash('sha256').update(lost).digest('hex');
    expect(
      r.segments.some(
        (segment) =>
          createHash('sha256').update(segment.bytes).digest('hex') ===
          lostDigest,
      ),
    ).toBe(false);
    expect(
      JSON.stringify(r.pages.map((bytes) => bytes.toString())),
    ).not.toContain(lostDigest);
  });

  it('degrades the settle envelope when its revision cannot be written', async () => {
    const r = await rig();
    await r.captured.open();
    r.captured.setStarted(1);
    await r.captured.write('stderr', Buffer.from('boom'));
    const lastPublished = r.manifests.at(-1)!;
    r.failManifestPublishesAfter = r.manifests.length;
    const final = await r.captured.finalize('error', [], undefined, {
      exitCode: 7,
      signalName: null,
    });
    expect(r.captured.brokenReason).toEqual({ reason: 'storage_failed' });
    expect(final.capture).toMatchObject({
      captureStatus: 'unavailable',
      captureReason: 'storage_failed',
      manifest: null,
    });
    // The last published revision stands — nothing rewinds and nothing fake
    // terminal was committed.
    expect(r.manifests.at(-1)).toEqual(lastPublished);
    expect(lastPublished['captureStatus']).toBe('pending');
  });

  it('latches a storage failure and never admits the lost bytes', async () => {
    const r = await rig();
    await r.captured.open();
    r.refuseSegments = true;
    r.captured.setStarted(1);
    const lost = Buffer.alloc(1_100_000, 1);
    await r.captured.write('stdout', lost);
    const final = await r.captured.finalize(
      'error',
      [],
      { message: 'gone.' },
      { exitCode: null, signalName: 'SIGKILL' },
    );
    expect(r.captured.brokenReason).toEqual({ reason: 'storage_failed' });
    // Nothing was ever stored: both streams are incomplete at zero bytes,
    // which the contract calls unavailable, never partial.
    expect(final.capture?.captureStatus).toBe('unavailable');
    const last = r.manifests.at(-1)!;
    expect(last['executionStatus']).toBe('error');
    expect(last['signal']).toBe('SIGKILL');
    expect(last['captureReason']).toBe('storage_failed');
    expect(last['captureStatus']).toBe('unavailable');
    expect(r.segments).toHaveLength(0);
    expect(
      JSON.stringify(r.pages.map((bytes) => bytes.toString())),
    ).not.toContain(createHash('sha256').update(lost).digest('hex'));
    expect(
      (last['contents'] as Array<Record<string, unknown>>).map(
        (entry) => entry['byteLength'],
      ),
    ).toEqual([0, 0]);
  });

  it('announces the degradation the moment a page publish refuses, ahead of finalize', async () => {
    // One refused page publish blinds the whole capture: the manifest must
    // name that now, not at the next writable publish, or a reader keeps
    // seeing a healthy open capture over a stream that went blind mid-run.
    const r = await rig({ segmentsPerPage: 1 });
    await r.captured.open();
    r.captured.setStarted(1);
    expect(r.manifests).toHaveLength(1);
    r.refusePagePublishes = 1;
    await r.captured.write('stdout', Buffer.alloc(1024 * 1024, 3));
    expect(r.captured.brokenReason).toEqual({ reason: 'storage_failed' });
    // The announcement rides its owner's queue, ahead of finalize.
    await r.captured.finish('stdout', false);
    expect(r.manifests).toHaveLength(2);
    const announced = r.manifests.at(-1)!;
    expect(announced['executionStatus']).toBe('unknown');
    expect(announced['captureStatus']).toBe('partial');
    expect(announced['captureReason']).toBe('storage_failed');

    const final = await r.captured.finalize('success', [], undefined, {
      exitCode: 0,
      signalName: null,
    });
    expect(final.capture?.captureStatus).toBe('partial');
    // The announced revision is never the settled envelope's manifest: the
    // settle publish writes its own revision and owns that ref.
    const settled = r.manifests.at(-1)!;
    expect(settled['executionStatus']).toBe('success');
    expect(settled['revision']).toBe(3);
  });

  it('retries a transient conflict before it ever latches', async () => {
    const r = await rig({ segmentsPerPage: 1 });
    await r.captured.open();
    r.captured.setStarted(1);
    r.refuseSegmentCalls = 1;
    await r.captured.write('stdout', Buffer.alloc(1024 * 1024, 7));
    expect(r.captured.brokenReason).toBeNull();
    expect(r.segments).toHaveLength(1);
    await r.captured.finish('stdout', true);
    await r.captured.finish('stderr', true);
    const final = await r.captured.finalize('success', [], undefined, {
      exitCode: 0,
      signalName: null,
    });
    expect(final.capture?.captureStatus).toBe('complete');
  });

  it('settles exit evidence set through the process result', async () => {
    const r = await rig();
    r.captured.setStarted(1);
    r.captured.setProcessResult({ exitCode: 7, signal: null });
    await r.captured.write('stderr', Buffer.from('boom'));
    await r.captured.finish('stderr', true);
    const final = await r.captured.finalize('error', [], undefined);
    expect(final.executionStatus).toBe('error');
    expect(r.manifests.at(-1)).toMatchObject({
      executionStatus: 'error',
      exitCode: 7,
    });
  });
});
