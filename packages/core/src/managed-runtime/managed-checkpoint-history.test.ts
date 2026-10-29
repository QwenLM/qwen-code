/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';
import {
  FileManagedSessionHistory,
  MANAGED_HISTORY_LIMITS,
} from './managed-session-history.js';
import {
  CHECKPOINT_HISTORY_KIND,
  CHECKPOINT_HISTORY_PAGE_BYTES,
  ManagedCheckpointHistory,
  checkpointHistoryPage,
  readHarnessCheckpoint,
  readHarnessCheckpointView,
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
const owners: FileManagedSessionHistory[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close();
});

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
  const scratch = await FileManagedSessionHistory.create(
    path.join(os.tmpdir(), 'qwen-checkpoint-view-tests'),
  );
  owners.push(scratch);
  const codec = new ManagedCheckpointHistory(resources, () =>
    scratch.emptyView(),
  );
  let archivedTools = 0;
  let archivedBindings = 0;
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
    const prepared = await codec.prepare(
      {
        ...current,
        tools: { ...current.tools!, items: items.slice(archivedTools) },
        runtime: {
          ...current.runtime!,
          bindings: bindings.slice(archivedBindings),
        },
      },
      currentRef,
    );
    const ref = await resources.publish('managed-checkpoint', prepared.bytes);
    const census = await http.commitResources([ref]);
    maximumCensus = Math.max(maximumCensus, census.length);
    maximumRoot = Math.max(maximumRoot, prepared.bytes.byteLength);
    http.releaseCommitted(census);
    codec.remember(ref, prepared);
    currentRef = ref;
    archivedTools = prepared.history?.toolCount ?? 0;
    archivedBindings = prepared.history?.bindingCount ?? 0;
    return { ref, prepared, census };
  }
  return {
    resources,
    saved,
    codec,
    scratch,
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
    const cold = new ManagedCheckpointHistory(f.resources, () =>
      f.scratch.emptyView(),
    );
    const restored = await cold.read(f.currentRef());
    expect(restored.checkpoint.tools!.items).toHaveLength(32);
    expect(restored.view.toolCount).toBe(2560);
    expect(await restored.view.tools.collect(2560)).toEqual(
      logical.tools!.items,
    );
    expect(await restored.view.tool(f.items[0].executionCallId)).toEqual(
      f.items[0],
    );
    expect(f.scratch.cacheUsage.bytes).toBeLessThanOrEqual(
      MANAGED_HISTORY_LIMITS.cacheBytes,
    );
    for await (const tool of restored.view.tools) {
      expect(await f.resources.read(tool.outcomeRef!)).toEqual(
        f.saved.get(tool.outcomeRef!.resourceId),
      );
    }
    // Builds and cold-validates real disk indexes for 2,560 completed calls.
  }, 180_000);

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
  it('keeps old prefix queries fixed and the committed cache compact across batches', async () => {
    const f = await fixture();
    await f.grow(64);
    const old = await readHarnessCheckpointView(
      f.resources,
      f.currentRef(),
      f.scratch,
    );
    const first = await old.tool('execution-0');
    expect(old.toolCount).toBe(64);
    expect(await old.tool('call-0')).toBeUndefined();
    expect(
      await old.tools.find((item) => item.functionCallId === 'call-0'),
    ).toEqual(first);
    expect(old.checkpoint.tools!.items.length).toBeLessThanOrEqual(63);
    expect(old.allToolsConsumed).toBe(true);
    await f.grow(128);
    const current = await f.codec.tryRead(f.currentRef());
    if (!current.ok) throw new Error(current.message);
    expect(current.history.toolCount).toBe(128);
    expect(current.checkpoint.tools!.items.length).toBeLessThanOrEqual(63);
    expect(current.history.maxOrdinal).toBe(127);
    expect(await current.history.tool('execution-0')).toEqual(first);
    expect(await old.tool('execution-127')).toBeUndefined();
    expect(await old.binding('execution-127')).toBeUndefined();
    expect(await old.tools.reduce((count) => count + 1, 0)).toBe(64);
    const resident = Reflect.get(f.codec, 'committed');
    expect(resident.bytes).toBeUndefined();
    expect(resident.checkpoint.tools.items.length).toBeLessThanOrEqual(63);
    expect(f.scratch.cacheUsage.bytes).toBeLessThanOrEqual(
      MANAGED_HISTORY_LIMITS.cacheBytes,
    );
    await old.close();
  });

  it('reuses verified archive pages instead of reading the complete prefix for each batch', async () => {
    const f = await fixture();
    await f.grow(64);
    const oldRef = JSON.parse(
      f.saved.get(f.currentRef().resourceId)!.toString(),
    ).history.ref;
    const read = vi.spyOn(f.resources, 'read');
    await f.grow(96);
    expect(
      read.mock.calls.filter(([ref]) => ref.resourceId === oldRef.resourceId),
    ).toHaveLength(0);
    const current = await f.codec.tryRead(f.currentRef());
    if (!current.ok) throw new Error(current.message);
    expect(await current.history.tool('execution-0')).toEqual(f.items[0]);
    expect(current.history.toolCount).toBe(96);
  });

  it.each(['missing', 'corrupt'] as const)(
    'rebuilds a %s query index from the same immutable checkpoint',
    async (damage) => {
      const f = await fixture();
      await f.grow(64);
      const view = await readHarnessCheckpointView(
        f.resources,
        f.currentRef(),
        f.scratch,
      );
      const index = Reflect.get(view, 'index') as FileManagedSessionHistory;
      Reflect.get(index, 'owner').cache.clear();
      const file = path.join(index.directory, index.rootDigest!);
      if (damage === 'missing') await unlink(file);
      else await writeFile(file, 'damaged');
      expect(await view.tool('execution-0')).toEqual(f.items[0]);
      expect(await view.tool('not-present')).toBeUndefined();
      expect(view.toolCount).toBe(64);
      await view.close();
    },
  );

  it('rejects canonical page damage during index repair instead of proving absence', async () => {
    const f = await fixture();
    await f.grow(64);
    const view = await readHarnessCheckpointView(
      f.resources,
      f.currentRef(),
      f.scratch,
    );
    const root = JSON.parse(f.saved.get(f.currentRef().resourceId)!.toString());
    f.saved.set(root.history.ref.resourceId, Buffer.from('damaged'));
    const index = Reflect.get(view, 'index') as FileManagedSessionHistory;
    Reflect.get(index, 'owner').cache.clear();
    await unlink(path.join(index.directory, index.rootDigest!));
    await expect(view.tool('not-present')).rejects.toThrow('digest');
    await view.close();
  });

  it('keeps archive-only roots valid and refuses an archive hidden behind before_model', async () => {
    const f = await fixture();
    await f.grow(64);
    const root = JSON.parse(f.saved.get(f.currentRef().resourceId)!.toString());
    root.tools.items = [];
    root.runtime.bindings = [];
    const ref = await f.resources.publish(
      'managed-checkpoint',
      Buffer.from(JSON.stringify(root)),
    );
    const view = await readHarnessCheckpointView(f.resources, ref, f.scratch);
    expect(view.toolCount).toBe(32);
    expect(view.checkpoint.tools!.items).toHaveLength(0);
    expect(view.allToolsConsumed).toBe(true);
    const next = await f.codec.prepare(view.checkpoint, ref);
    expect(next.checkpoint.tools!.items).toHaveLength(0);
    expect(next.view.toolCount).toBe(32);
    expect(await next.view.tool('execution-0')).toEqual(f.items[0]);
    await view.close();
    root.continuation.phase = 'before_model';
    root.attempt = null;
    const invalid = await f.resources.publish(
      'managed-checkpoint',
      Buffer.from(JSON.stringify(root)),
    );
    await expect(
      readHarnessCheckpointView(f.resources, invalid, f.scratch),
    ).rejects.toThrow('before_model');
  });
  it.each(['archive', 'inline'] as const)(
    'rejects a repeated invocation identity across %s boundaries',
    async (location) => {
      const f = await fixture();
      await f.grow(64);
      const root = JSON.parse(
        f.saved.get(f.currentRef().resourceId)!.toString(),
      );
      if (location === 'inline') {
        root.runtime.bindings[0].invocationBindingId = 'binding-0';
      } else {
        const page = JSON.parse(
          f.saved.get(root.history.ref.resourceId)!.toString(),
        );
        page.bindings[1].invocationBindingId =
          page.bindings[0].invocationBindingId;
        root.history.ref = await f.resources.publish(
          CHECKPOINT_HISTORY_KIND,
          Buffer.from(JSON.stringify(page)),
        );
      }
      const forged = await f.resources.publish(
        'managed-checkpoint',
        Buffer.from(JSON.stringify(root)),
      );
      await expect(
        readHarnessCheckpointView(f.resources, forged),
      ).rejects.toThrow(/binding identity|binding repeats/);
    },
  );
  it.each(['tools', 'runtime'] as const)(
    'rejects a paged root that loses its %s group',
    async (group) => {
      const f = await fixture();
      await f.grow(64);
      const root = JSON.parse(
        f.saved.get(f.currentRef().resourceId)!.toString(),
      );
      root[group] = null;
      const forged = await f.resources.publish(
        'managed-checkpoint',
        Buffer.from(JSON.stringify(root)),
      );
      await expect(
        readHarnessCheckpointView(f.resources, forged),
      ).rejects.toThrow('group is missing');
    },
  );
  it('captures the source reference before awaiting an advancing head', async () => {
    const f = await fixture();
    await f.grow(64);
    const ref = structuredClone(f.currentRef());
    const originalId = ref.resourceId;
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = readHarnessCheckpointView(
      {
        read: async (source) => {
          if (source.resourceId === originalId) {
            entered();
            await blocked;
          }
          return f.resources.read(source);
        },
      },
      ref,
      f.scratch,
    );
    await started;
    await f.grow(128);
    Object.assign(ref, f.currentRef());
    release();
    const view = await reading;
    expect(view.toolCount).toBe(64);
    expect(await view.tool('execution-127')).toBeUndefined();
    expect(await view.tool('execution-0')).toEqual(f.items[0]);
    await view.close();
  });
});
