/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CHECKPOINT_HISTORY_KIND,
  CHECKPOINT_HISTORY_PAGE_BYTES,
  ManagedCheckpointHistory,
  checkpointHistoryPage,
  readHarnessCheckpoint,
} from './managed-checkpoint-history.js';
import { createHttpManagedSessionStores } from './http-managed-session-store.js';
import {
  createInitialHarnessCheckpoint,
  encodeHarnessCheckpointV1,
  parseHarnessCheckpointV1,
  type HarnessCheckpointV1,
  type HarnessRuntimeBinding,
  type HarnessToolItem,
} from './managed-harness-checkpoint.js';
import type { ManagedSessionDurableRef } from './managed-session-records.js';
import type { ManagedSessionResourceStore } from './managed-session-storage.js';

const key = {
  tenantId: 'tenant',
  workspaceId: 'workspace',
  sessionId: 'session',
};
const digest = 'a'.repeat(64);

async function fixture() {
  const stores = createHttpManagedSessionStores({
    baseUrl: 'http://127.0.0.1:1',
    sessionKey: key,
    writerId: 'writer',
    fetchFn: async () => {
      throw new Error('This unit fixture has no remote server.');
    },
  });
  const http = stores.resourceStore as ManagedSessionResourceStore & {
    commitResources(
      refs: readonly ManagedSessionDurableRef[],
    ): Promise<Array<ManagedSessionDurableRef & { bytesBase64?: string }>>;
    releaseCommitted(refs: readonly ManagedSessionDurableRef[]): void;
  };
  const saved = new Map<string, Buffer>();
  const resources: ManagedSessionResourceStore = {
    publish: async (kind, bytes) => {
      const ref = await http.publish(kind, bytes);
      saved.set(ref.resourceId, Buffer.from(bytes));
      return ref;
    },
    read: async (ref) => {
      const bytes = saved.get(ref.resourceId);
      if (!bytes) throw new Error('Missing fixture resource.');
      return Buffer.from(bytes);
    },
  };
  const routeRef = await resources.publish('managed-route', Buffer.from('{}'));
  const initial = createInitialHarnessCheckpoint({
    sessionKey: key,
    checkpointId: 'checkpoint-0',
    coveredSequence: 0,
    activationId: 'activation',
    turnId: 'turn',
    promptId: 'prompt',
    definitionRevision: 'definition',
    configRevision: 'config',
    inputDigest: digest,
    previousCheckpointId: null,
  });
  const items: HarnessToolItem[] = [];
  const bindings: HarnessRuntimeBinding[] = [];
  const codec = new ManagedCheckpointHistory(resources);
  let currentRef: ManagedSessionDurableRef | undefined;
  let current = initial;
  let maximumCensus = 0;
  let maximumRoot = 0;
  async function grow(count: number) {
    while (items.length < count) {
      const index = items.length;
      const outcomeRef = await resources.publish(
        'managed-tool-outcome',
        Buffer.from(JSON.stringify({ result: index })),
      );
      items.push({
        functionCallId: `call-${index}`,
        toolName: 'read_file',
        executionCallId: `execution-${index}`,
        modelMessageId: `model-${index}`,
        partIndex: 0,
        ordinal: index,
        inputDigest: digest,
        outcomeSource: 'runtime',
        state: 'settled',
        outcomeRef,
        consumed: true,
      });
      bindings.push({
        executionCallId: `execution-${index}`,
        invocationBindingId: `binding-${index}`,
        capabilityVersion: 'capability',
        policyVersion: 'policy',
        mediaVersion: null,
        state: 'committed',
        progressCursor: null,
      });
    }
    current = {
      ...initial,
      identity: {
        ...initial.identity,
        checkpointId: `checkpoint-${count}`,
        coveredSequence: count,
        previousCheckpointId: current.identity.checkpointId,
      },
      resume: { ...initial.resume, throughSequence: count },
      continuation: { phase: 'results_ready', pendingEventIds: [] },
      attempt: {
        attemptId: 'attempt',
        routeRef,
        capabilityRef: null,
        samplingRef: null,
        outputState: 'output_committed',
        usageRef: null,
        budgetConsumed: 0,
      },
      tools: { batchId: 'batch', items: [...items] },
      runtime: { bindings: [...bindings] },
    };
    const prepared = await codec.prepare(current, currentRef);
    const ref = await resources.publish('managed-checkpoint', prepared.bytes);
    const census = await http.commitResources([ref]);
    maximumCensus = Math.max(maximumCensus, census.length);
    maximumRoot = Math.max(maximumRoot, prepared.bytes.byteLength);
    http.releaseCommitted(census);
    codec.remember(ref, prepared);
    currentRef = ref;
    return { ref, prepared, census };
  }
  return {
    resources,
    saved,
    codec,
    grow,
    items,
    bindings,
    initial,
    routeRef,
    current: () => current,
    currentRef: () => currentRef!,
    maxima: () => ({ census: maximumCensus, root: maximumRoot }),
  };
}

describe('Managed checkpoint history', () => {
  it('retains histories beyond both old limits with bounded physical roots and incremental census', async () => {
    const f = await fixture();
    for (let count = 32; count <= 2560; count += 32) await f.grow(count);
    const logical = f.current();
    expect(encodeHarnessCheckpointV1(logical).byteLength).toBeGreaterThan(
      1024 * 1024,
    );
    expect(() =>
      parseHarnessCheckpointV1(encodeHarnessCheckpointV1(logical)),
    ).toThrow();
    expect(f.maxima().census).toBeLessThan(40);
    expect(f.maxima().root).toBeLessThan(64 * 1024);
    const root = JSON.parse(f.saved.get(f.currentRef().resourceId)!.toString());
    expect(root.tools.items).toHaveLength(32);
    expect(root.history.toolCount).toBe(2528);
    const pages = [...f.saved.values()].filter((bytes) =>
      bytes.includes(
        Buffer.from('"storageProfile":"managed-checkpoint-history/1"'),
      ),
    );
    expect(pages).toHaveLength(79);
    expect(
      pages.every((bytes) => bytes.length <= CHECKPOINT_HISTORY_PAGE_BYTES),
    ).toBe(true);
    const cold = new ManagedCheckpointHistory(f.resources);
    const restored = await cold.read(f.currentRef());
    expect(restored.checkpoint).toEqual(logical);
    expect(restored.checkpoint.tools?.items[0]).toEqual(f.items[0]);
    for (const tool of restored.checkpoint.tools!.items) {
      expect(await f.resources.read(tool.outcomeRef!)).toEqual(
        f.saved.get(tool.outcomeRef!.resourceId),
      );
    }
  }, 30_000);

  it('keeps pending and unconsumed calls inline and restores their original execution mapping', async () => {
    const f = await fixture();
    for (let count = 32; count <= 192; count += 32) await f.grow(count);
    const prior = f.current();
    const item: HarnessToolItem = {
      ...f.items[0],
      functionCallId: 'pending-call',
      executionCallId: 'pending-execution',
      modelMessageId: 'pending-model',
      ordinal: 192,
      state: 'in_progress',
      consumed: false,
      outcomeRef: null,
    };
    const binding: HarnessRuntimeBinding = {
      ...f.bindings[0],
      executionCallId: item.executionCallId,
      invocationBindingId: 'pending-binding',
      state: 'dispatch',
    };
    const pending: HarnessCheckpointV1 = {
      ...prior,
      continuation: { phase: 'await_runtime', pendingEventIds: [] },
      tools: { ...prior.tools!, items: [...prior.tools!.items, item] },
      runtime: { bindings: [...prior.runtime!.bindings, binding] },
    };
    const prepared = await f.codec.prepare(pending, f.currentRef());
    expect(JSON.parse(prepared.bytes.toString()).tools.items.at(-1)).toEqual(
      item,
    );
    const ref = await f.resources.publish('managed-checkpoint', prepared.bytes);
    expect(await readHarnessCheckpoint(f.resources, ref)).toEqual(pending);
    const unconsumed: HarnessCheckpointV1 = {
      ...pending,
      continuation: { phase: 'results_ready', pendingEventIds: [] },
      tools: {
        ...pending.tools!,
        items: [
          ...prior.tools!.items,
          { ...item, state: 'settled', outcomeRef: f.items[0].outcomeRef },
        ],
      },
      runtime: {
        bindings: [
          ...prior.runtime!.bindings,
          { ...binding, state: 'settled' },
        ],
      },
    };
    const settled = await f.codec.prepare(unconsumed, f.currentRef());
    expect(
      JSON.parse(settled.bytes.toString()).tools.items.at(-1).consumed,
    ).toBe(false);
  });

  it('refuses historical-prefix substitution before publishing another page', async () => {
    const f = await fixture();
    await f.grow(32);
    await f.grow(64);
    const prior = f.current();
    const count = f.saved.size;
    await expect(
      f.codec.prepare(
        {
          ...prior,
          tools: {
            ...prior.tools!,
            items: [
              { ...prior.tools!.items[0], toolName: 'substitution' },
              ...prior.tools!.items.slice(1),
            ],
          },
        },
        f.currentRef(),
      ),
    ).rejects.toThrow('committed prefix');
    expect(f.saved.size).toBe(count);
  });

  it('reuses paged orchestration receipts without a Runtime binding group', async () => {
    const f = await fixture();
    await f.grow(64);
    const logical: HarnessCheckpointV1 = {
      ...f.current(),
      runtime: null,
      tools: {
        ...f.current().tools!,
        items: f.items.map((item) => ({
          ...item,
          outcomeSource: 'orchestration',
        })),
      },
    };
    const prepared = await f.codec.prepare(logical);
    const ref = await f.resources.publish('managed-checkpoint', prepared.bytes);
    f.codec.remember(ref, prepared);
    const next = await f.codec.prepare(logical, ref);
    expect(next.history?.ref).toEqual(prepared.history?.ref);
    expect(await readHarnessCheckpoint(f.resources, ref)).toEqual(logical);
  });

  it('does not adopt a prepared but uncommitted history root', async () => {
    const f = await fixture();
    await f.grow(32);
    const ref = f.currentRef();
    const prior = f.current();
    const proposed = {
      ...prior,
      tools: {
        ...prior.tools!,
        items: [
          ...prior.tools!.items,
          ...prior.tools!.items.map((item, i) => ({
            ...item,
            functionCallId: `next-call-${i}`,
            executionCallId: `next-execution-${i}`,
            ordinal: i + 32,
          })),
        ],
      },
    };
    const staged = await f.codec.prepare(proposed, ref);
    expect(staged.history).toBeDefined();
    expect((await f.codec.read(ref)).checkpoint).toEqual(prior);
  });

  it('blocks corrupt or cross-scope pages and preserves inline v1 compatibility', async () => {
    const f = await fixture();
    const inline = await f.grow(32);
    expect(parseHarnessCheckpointV1(inline.prepared.bytes)).toEqual(
      f.current(),
    );
    const paged = await f.grow(64);
    expect(() => parseHarnessCheckpointV1(paged.prepared.bytes)).toThrow();
    const root = JSON.parse(paged.prepared.bytes.toString());
    const pageRef = root.history.ref as ManagedSessionDurableRef;
    const original = f.saved.get(pageRef.resourceId)!;
    f.saved.set(pageRef.resourceId, Buffer.from('corrupt'));
    await expect(readHarnessCheckpoint(f.resources, paged.ref)).rejects.toThrow(
      'digest',
    );
    const page = JSON.parse(original.toString());
    page.sessionKey.tenantId = 'another-tenant';
    root.history.ref = await f.resources.publish(
      CHECKPOINT_HISTORY_KIND,
      Buffer.from(JSON.stringify(page)),
    );
    const forged = await f.resources.publish(
      'managed-checkpoint',
      Buffer.from(JSON.stringify(root)),
    );
    await expect(readHarnessCheckpoint(f.resources, forged)).rejects.toThrow(
      'another Session',
    );
    page.items[0].consumed = false;
    expect(() =>
      checkpointHistoryPage(Buffer.from(JSON.stringify(page))),
    ).toThrow('unconsumed');
    expect(createHash('sha256').update(original).digest('hex')).toBe(
      pageRef.digest,
    );
  });
});
