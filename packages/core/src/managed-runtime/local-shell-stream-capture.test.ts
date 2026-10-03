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
  isToolResultManifestSuccessor,
  MANAGED_TOOL_RESULT_KINDS,
} from './managed-tool-result.js';
import type {
  ToolResultSegmentReceipt,
  ToolResultStoreOutcome,
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
  readonly captured: LocalShellStreamCapture;
  readonly segments: Array<{
    ordinal: number;
    streamId: string;
    bytes: Buffer;
  }>;
  readonly sealed: Array<{ streamId: string; segmentCount: number }>;
  readonly pages: Buffer[];
  readonly manifests: Array<Record<string, unknown>>;
  readonly resources: LocalManagedSessionResourceStore;
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

async function rig(
  options: {
    segmentsPerPage?: number;
    store?: Partial<ToolResultSegmentStore>;
  } = {},
): Promise<Rig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-shell-stream-'));
  temporaryDirectories.add(root);
  const real = LocalManagedSessionResourceStore.create({
    runtimeBaseDir: root,
    sessionKey,
  });
  const pages: Buffer[] = [];
  const manifests: Array<Record<string, unknown>> = [];
  const resources = {
    publish: async (kind: string, bytes: Buffer) => {
      const ref = await real.publish(kind, bytes);
      if (kind === MANAGED_TOOL_RESULT_KINDS.page) pages.push(bytes);
      if (kind === MANAGED_TOOL_RESULT_KINDS.manifest) {
        manifests.push(JSON.parse(bytes.toString()) as Record<string, unknown>);
      }
      return ref;
    },
    read: (ref: ManagedSessionDurableRef) => real.read(ref),
  } as unknown as ManagedSessionResourceStore;
  const segments: Rig['segments'] = [];
  const sealed: Rig['sealed'] = [];
  const store = {
    async publish(request: {
      streamId: string;
      ordinal: number;
      bytes: Buffer;
    }) {
      segments.push({
        ordinal: request.ordinal,
        streamId: request.streamId,
        bytes: request.bytes,
      });
      return {
        status: 'ok' as const,
        result: {
          byteLength: request.bytes.byteLength,
          digest: createHash('sha256').update(request.bytes).digest('hex'),
        },
      };
    },
    async seal(request: { streamId: string; segmentCount: number }) {
      sealed.push({
        streamId: request.streamId,
        segmentCount: request.segmentCount,
      });
      return { status: 'ok' as const, result: { sealed: true } };
    },
    async prefix() {
      return { status: 'ok' as const, result: { byteLength: 0 } };
    },
    async readRange() {
      return { status: 'ok' as const, result: Buffer.alloc(0) };
    },
    async close() {},
    ...options.store,
  } as unknown as ToolResultSegmentStore;
  return {
    captured: new LocalShellStreamCapture(
      store,
      resources,
      IDENTITY,
      async () => {},
      { segmentsPerPage: options.segmentsPerPage ?? 512 },
    ),
    segments,
    sealed,
    pages,
    manifests,
    resources: real,
  };
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

  it('latches a storage failure and never admits the lost bytes', async () => {
    const r = await rig({
      store: {
        publish: async (): Promise<
          ToolResultStoreOutcome<ToolResultSegmentReceipt>
        > => ({ status: 'refused', code: 'managed_tool_result_conflict' }),
      },
    });
    r.captured.setStarted(1);
    await r.captured.write('stdout', Buffer.alloc(1_100_000, 1));
    const final = await r.captured.finalize(
      'error',
      [],
      { message: 'gone.' },
      { exitCode: null, signalName: 'SIGKILL' },
    );
    expect(r.captured.brokenReason).toEqual({ reason: 'storage_failed' });
    expect(['partial', 'unavailable']).toContain(final.capture?.captureStatus);
    const last = r.manifests.at(-1)!;
    expect(last['executionStatus']).toBe('error');
    expect(last['signal']).toBe('SIGKILL');
    expect(last['captureReason']).toBe('storage_failed');
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
