/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import {
  FileManagedSessionHistory,
  ManagedHistoryQuery,
  ManagedHistoryUnavailableError,
} from './managed-session-history.js';
import {
  encodeHarnessCheckpointV1,
  parseHarnessCheckpointObject,
  parseHarnessCheckpointResidentObject,
  parseToolItem,
  parseRuntimeBinding,
  tryParseHarnessCheckpointV1,
  type HarnessCheckpointParseResult,
  type HarnessCheckpointV1,
  type HarnessRuntimeBinding,
  type HarnessToolItem,
} from './managed-harness-checkpoint.js';
import {
  MANAGED_SESSION_LIMITS,
  ManagedSessionRecordError,
  assertManagedSessionDurableRef,
  assertManagedSessionSequence,
  managedSessionKeysEqual,
  parseManagedSessionRecordJson,
  type ManagedSessionDurableRef,
  type ManagedSessionJsonValue,
} from './managed-session-records.js';
import type { ManagedSessionResourceStore } from './managed-session-storage.js';

export const CHECKPOINT_STORAGE_PROFILE = 'managed-checkpoint-paged/1';
export const CHECKPOINT_HISTORY_KIND = 'managed-checkpoint-history';
export const CHECKPOINT_HISTORY_PAGE_BYTES = 48 * 1024;
export const CHECKPOINT_HISTORY_PAGE_ITEMS = 32;
const MAX_HISTORY_PAGES = 4096;
const MAX_HISTORY_BYTES = 64 * 1024 * 1024;

interface History {
  readonly ref: ManagedSessionDurableRef;
  readonly toolCount: number;
  readonly bindingCount: number;
  readonly pageCount: number;
  readonly byteLength: number;
}

export interface PreparedHarnessCheckpoint {
  readonly bytes: Buffer;
  readonly checkpoint: HarnessCheckpointV1;
  readonly history?: History;
  readonly view: ManagedHarnessCheckpointView;
}

function requireHistory(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition)
    throw new ManagedSessionRecordError(`Checkpoint history: ${message}`);
}

function object(value: unknown): Record<string, ManagedSessionJsonValue> {
  requireHistory(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'expected an object.',
  );
  return value as Record<string, ManagedSessionJsonValue>;
}

function closed(
  record: Record<string, unknown>,
  keys: readonly string[],
): void {
  requireHistory(
    Object.keys(record).length === keys.length &&
      keys.every((key) => key in record),
    'fields conflict.',
  );
}

function json(
  bytes: Buffer,
  limit: number,
): Record<string, ManagedSessionJsonValue> {
  return object(parseManagedSessionRecordJson(bytes.toString('utf8'), limit));
}

function historyRef(value: ManagedSessionJsonValue): ManagedSessionDurableRef {
  const ref = assertManagedSessionDurableRef(value, 'checkpoint history');
  requireHistory(
    ref.kind === CHECKPOINT_HISTORY_KIND &&
      ref.schemaVersion === 1 &&
      ref.byteLength <= CHECKPOINT_HISTORY_PAGE_BYTES,
    'page reference conflicts.',
  );
  return ref;
}

export function isPagedHarnessCheckpoint(bytes: Buffer): boolean {
  try {
    return (
      json(bytes, MANAGED_SESSION_LIMITS.maxEventBytes)['storageProfile'] ===
      CHECKPOINT_STORAGE_PROFILE
    );
  } catch {
    return false;
  }
}

function physicalRoot(bytes: Buffer): {
  state: Record<string, ManagedSessionJsonValue>;
  history: History;
} {
  const record = json(bytes, MANAGED_SESSION_LIMITS.maxEventBytes);
  requireHistory(
    record['storageProfile'] === CHECKPOINT_STORAGE_PROFILE,
    'storage profile is unsupported.',
  );
  const history = object(record['history']);
  closed(history, ['ref', 'toolCount', 'bindingCount']);
  const result = {
    ref: historyRef(history['ref']),
    toolCount: assertManagedSessionSequence(
      history['toolCount'],
      'history.toolCount',
    ),
    bindingCount: assertManagedSessionSequence(
      history['bindingCount'],
      'history.bindingCount',
    ),
    pageCount: 0,
    byteLength: 0,
  };
  requireHistory(result.toolCount > 0, 'empty archive.');
  const { storageProfile: _profile, history: _history, ...state } = record;
  return { state, history: result };
}

export function checkpointHistoryPage(bytes: Buffer) {
  const page = json(bytes, CHECKPOINT_HISTORY_PAGE_BYTES);
  closed(page, [
    'storageProfile',
    'sessionKey',
    'turnId',
    'promptId',
    'previous',
    'toolCount',
    'bindingCount',
    'items',
    'bindings',
  ]);
  requireHistory(
    page['storageProfile'] === `${CHECKPOINT_HISTORY_KIND}/1`,
    'page profile is unsupported.',
  );
  requireHistory(
    Array.isArray(page['items']) && Array.isArray(page['bindings']),
    'page arrays are missing.',
  );
  const items = page['items'];
  const bindings = page['bindings'];
  requireHistory(
    items.length <= CHECKPOINT_HISTORY_PAGE_ITEMS &&
      bindings.length <= CHECKPOINT_HISTORY_PAGE_ITEMS &&
      items.length + bindings.length > 0,
    'page item count conflicts.',
  );
  for (const item of items) {
    const tool = object(item);
    requireHistory(
      tool['state'] === 'settled' && tool['consumed'] === true,
      'unfinished or unconsumed tool was archived.',
    );
  }
  for (const item of bindings) {
    const binding = object(item);
    requireHistory(
      binding['state'] === 'settled' || binding['state'] === 'committed',
      'in-flight binding was archived.',
    );
  }
  return {
    sessionKey: page['sessionKey'],
    turnId: page['turnId'],
    promptId: page['promptId'],
    previous: page['previous'] === null ? null : historyRef(page['previous']),
    toolCount: assertManagedSessionSequence(
      page['toolCount'],
      'page.toolCount',
    ),
    bindingCount: assertManagedSessionSequence(
      page['bindingCount'],
      'page.bindingCount',
    ),
    items,
    bindings,
  };
}

/** Physical references, including archived outcome refs; admission decides which old pages to reuse. */
export function checkpointStorageBody(bytes: Buffer): ManagedSessionJsonValue {
  return isPagedHarnessCheckpoint(bytes)
    ? json(bytes, MANAGED_SESSION_LIMITS.maxEventBytes)
    : (parseHarnessCheckpointObject(
        json(bytes, MANAGED_SESSION_LIMITS.maxEventBytes),
      ) as unknown as ManagedSessionJsonValue);
}

async function verifiedRead(
  resources: Pick<ManagedSessionResourceStore, 'read'>,
  ref: ManagedSessionDurableRef,
): Promise<Buffer> {
  const bytes = Buffer.from(await resources.read(ref));
  requireHistory(
    bytes.byteLength === ref.byteLength &&
      createHash('sha256').update(bytes).digest('hex') === ref.digest,
    'resource length or digest conflicts.',
  );
  return bytes;
}

interface ItemLocator {
  readonly ref: ManagedSessionDurableRef;
  readonly index: number;
  readonly position: number;
}
interface PageProof extends History {
  readonly context: string;
  readonly maxOrdinal: number;
  readonly pendingBindings: number;
}
const key = (...parts: Array<string | number>) => JSON.stringify(parts);
const contextOf = (checkpoint: HarnessCheckpointV1) =>
  JSON.stringify([
    checkpoint.identity.sessionKey,
    checkpoint.identity.turnId,
    checkpoint.identity.promptId,
  ]);

async function toolAt(
  resources: Pick<ManagedSessionResourceStore, 'read'>,
  locator: ItemLocator,
  index: FileManagedSessionHistory,
): Promise<HarnessToolItem> {
  const page = checkpointHistoryPage(
    await index.loadBody(`checkpoint-page:${JSON.stringify(locator.ref)}`, () =>
      verifiedRead(resources, locator.ref),
    ),
  );
  requireHistory(locator.index < page.items.length, 'tool locator conflicts.');
  return parseToolItem(page.items[locator.index], 'checkpoint history tool');
}
async function bindingAt(
  resources: Pick<ManagedSessionResourceStore, 'read'>,
  locator: ItemLocator,
  index: FileManagedSessionHistory,
): Promise<HarnessRuntimeBinding> {
  const page = checkpointHistoryPage(
    await index.loadBody(`checkpoint-page:${JSON.stringify(locator.ref)}`, () =>
      verifiedRead(resources, locator.ref),
    ),
  );
  requireHistory(
    locator.index < page.bindings.length,
    'binding locator conflicts.',
  );
  return parseRuntimeBinding(
    page.bindings[locator.index],
    'checkpoint history binding',
  );
}

export class ManagedHarnessCheckpointView {
  private reference: ManagedSessionDurableRef | undefined;
  readonly tools: ManagedHistoryQuery<HarnessToolItem>;
  readonly bindings: ManagedHistoryQuery<HarnessRuntimeBinding>;
  readonly toolCount: number;
  readonly bindingCount: number;
  readonly maxOrdinal: number;
  readonly allToolsSettled: boolean;
  readonly allToolsConsumed: boolean;
  readonly hasRuntimeDispatch: boolean;
  constructor(
    readonly checkpoint: HarnessCheckpointV1,
    private readonly resources: Pick<ManagedSessionResourceStore, 'read'>,
    private readonly index: FileManagedSessionHistory,
    readonly archive: PageProof | undefined,
    private readonly release = () => index.close(),
    private readonly bodyDigest?: string,
  ) {
    this.toolCount =
      (archive?.toolCount ?? 0) + (checkpoint.tools?.items.length ?? 0);
    this.bindingCount =
      (archive?.bindingCount ?? 0) + (checkpoint.runtime?.bindings.length ?? 0);
    this.maxOrdinal = (checkpoint.tools?.items ?? []).reduce(
      (maximum, item) => Math.max(maximum, item.ordinal),
      archive?.maxOrdinal ?? -1,
    );
    this.allToolsSettled = (checkpoint.tools?.items ?? []).every(
      (item) => item.state === 'settled',
    );
    this.allToolsConsumed = (checkpoint.tools?.items ?? []).every(
      (item) => item.state === 'settled' && item.consumed,
    );
    this.hasRuntimeDispatch = (checkpoint.runtime?.bindings ?? []).some(
      (binding) => binding.state === 'dispatch',
    );
    this.tools = new ManagedHistoryQuery(() => this.iterateTools());
    this.bindings = new ManagedHistoryQuery(() => this.iterateBindings());
  }
  private get context(): string {
    return contextOf(this.checkpoint);
  }
  async tool(executionCallId: string): Promise<HarnessToolItem | undefined> {
    const inline = this.checkpoint.tools?.items.find(
      (item) => item.executionCallId === executionCallId,
    );
    if (inline) return inline;
    const locator = await this.index.get<ItemLocator>(
      'resource',
      key('checkpoint-tool', this.context, executionCallId),
    );
    return locator && locator.position < (this.archive?.toolCount ?? 0)
      ? toolAt(this.resources, locator, this.index)
      : undefined;
  }
  async binding(
    executionCallId: string,
  ): Promise<HarnessRuntimeBinding | undefined> {
    const inline = this.checkpoint.runtime?.bindings.find(
      (item) => item.executionCallId === executionCallId,
    );
    if (inline) return inline;
    const locator = await this.index.get<ItemLocator>(
      'resource',
      key('checkpoint-binding', this.context, executionCallId),
    );
    return locator && locator.position < (this.archive?.bindingCount ?? 0)
      ? bindingAt(this.resources, locator, this.index)
      : undefined;
  }
  private async *iterateTools(): AsyncGenerator<HarnessToolItem> {
    for (
      let position = 0;
      position < (this.archive?.toolCount ?? 0);
      position++
    ) {
      const locator = await this.index.get<ItemLocator>(
        'event',
        key('checkpoint-tool', this.context, position),
      );
      requireHistory(
        locator !== undefined && locator.position === position,
        'tool directory is incomplete.',
      );
      yield await toolAt(this.resources, locator, this.index);
    }
    yield* this.checkpoint.tools?.items ?? [];
  }
  private async *iterateBindings(): AsyncGenerator<HarnessRuntimeBinding> {
    for (
      let position = 0;
      position < (this.archive?.bindingCount ?? 0);
      position++
    ) {
      const locator = await this.index.get<ItemLocator>(
        'event',
        key('checkpoint-binding', this.context, position),
      );
      requireHistory(
        locator !== undefined && locator.position === position,
        'binding directory is incomplete.',
      );
      yield await bindingAt(this.resources, locator, this.index);
    }
    yield* this.checkpoint.runtime?.bindings ?? [];
  }
  bindReference(ref: ManagedSessionDurableRef): void {
    if (this.reference && isDeepStrictEqual(this.reference, ref)) return;
    requireHistory(
      ref.kind === 'managed-checkpoint' &&
        ref.schemaVersion === 1 &&
        ref.digest === this.bodyDigest,
      'checkpoint source reference conflicts.',
    );
    this.reference = structuredClone(ref);
    const source = this.reference;
    this.index.setRebuilder(async (repair) => {
      const rebuilt = await viewOf(
        await verifiedRead(this.resources, source),
        this.resources,
        repair,
      );
      await rebuilt.view.close();
    });
  }
  forkIndex(): FileManagedSessionHistory {
    const fork = this.index.fork();
    fork.setRebuilder(async () => {
      throw new ManagedHistoryUnavailableError(
        'Checkpoint preparation must reopen its verified basis.',
      );
    });
    return fork;
  }
  close(): Promise<void> {
    return this.release();
  }
}

async function indexArchive(
  resources: Pick<ManagedSessionResourceStore, 'read'>,
  checkpoint: HarnessCheckpointV1,
  history: History,
  index: FileManagedSessionHistory,
): Promise<PageProof> {
  const context = contextOf(checkpoint);
  const queueKey = key('checkpoint-queue', context, history.ref.digest);
  let next: ManagedSessionDurableRef | null = history.ref;
  let tools = history.toolCount;
  let bindings = history.bindingCount;
  let queued = 0;
  let known: PageProof | undefined;
  while (next !== null) {
    const proof = await index.get<PageProof>(
      'checkpoint',
      key('checkpoint-page', context, next.digest),
    );
    if (proof) {
      requireHistory(
        proof.context === context &&
          isDeepStrictEqual(proof.ref, next) &&
          proof.toolCount === tools &&
          proof.bindingCount === bindings,
        'cached page coverage conflicts.',
      );
      known = proof;
      break;
    }
    requireHistory(queued < MAX_HISTORY_PAGES, 'page capacity exceeded.');
    const bytes = await verifiedRead(resources, next);
    const page = checkpointHistoryPage(bytes);
    requireHistory(
      isDeepStrictEqual(page.sessionKey, checkpoint.identity.sessionKey) &&
        page.turnId === checkpoint.identity.turnId &&
        page.promptId === checkpoint.identity.promptId,
      'page belongs to another Session or Turn.',
    );
    requireHistory(
      page.toolCount === tools && page.bindingCount === bindings,
      'page counts conflict.',
    );
    const toolStart = tools - page.items.length;
    const bindingStart = bindings - page.bindings.length;
    requireHistory(
      toolStart >= 0 && bindingStart >= 0,
      'page counts conflict.',
    );
    index.begin();
    try {
      for (let itemIndex = 0; itemIndex < page.items.length; itemIndex++) {
        const item = parseToolItem(
          page.items[itemIndex],
          'checkpoint history tool',
        );
        const locator: ItemLocator = {
          ref: next,
          index: itemIndex,
          position: toolStart + itemIndex,
        };
        for (const [family, identity] of [
          ['resource', key('checkpoint-tool', context, item.executionCallId)],
          ['resource', key('checkpoint-call', context, item.functionCallId)],
          ['resource', key('checkpoint-ordinal', context, item.ordinal)],
          ['event', key('checkpoint-tool', context, locator.position)],
        ] as const) {
          const old = await index.get<ItemLocator>(family, identity);
          requireHistory(
            !old ||
              (old.position === locator.position &&
                isDeepStrictEqual(await toolAt(resources, old, index), item)),
            'historical tool identity conflicts.',
          );
          await index.set(family, identity, locator);
        }
      }
      for (let itemIndex = 0; itemIndex < page.bindings.length; itemIndex++) {
        const binding = parseRuntimeBinding(
          page.bindings[itemIndex],
          'checkpoint history binding',
        );
        const locator: ItemLocator = {
          ref: next,
          index: itemIndex,
          position: bindingStart + itemIndex,
        };
        for (const [family, identity] of [
          [
            'resource',
            key('checkpoint-binding', context, binding.executionCallId),
          ],
          [
            'resource',
            key('checkpoint-invocation', context, binding.invocationBindingId),
          ],
          ['event', key('checkpoint-binding', context, locator.position)],
        ] as const) {
          const old = await index.get<ItemLocator>(family, identity);
          requireHistory(
            !old ||
              (old.position === locator.position &&
                isDeepStrictEqual(
                  await bindingAt(resources, old, index),
                  binding,
                )),
            'historical binding identity conflicts.',
          );
          await index.set(family, identity, locator);
        }
      }
      await index.set('resource-pending', key(queueKey, queued++), {
        ref: next,
        bytes: bytes.byteLength,
      });
      await index.flush();
    } catch (cause) {
      index.discard();
      throw cause;
    }
    tools = toolStart;
    bindings = bindingStart;
    next = page.previous;
    requireHistory(
      next !== null || tools + bindings === 0,
      'history is incomplete.',
    );
  }
  let proof = known;
  for (let offset = queued - 1; offset >= 0; offset--) {
    const queuedPage = await index.get<{
      ref: ManagedSessionDurableRef;
      bytes: number;
    }>('resource-pending', key(queueKey, offset));
    requireHistory(queuedPage !== undefined, 'page queue is incomplete.');
    const page = checkpointHistoryPage(
      await verifiedRead(resources, queuedPage.ref),
    );
    let pendingBindings = 0;
    const pendingKey = (digest: string, position: number) =>
      key('checkpoint-pending-binding', context, digest, position);
    const keepPending = async (locator: ItemLocator) => {
      const binding = await bindingAt(resources, locator, index);
      const tool = await index.get<ItemLocator>(
        'resource',
        key('checkpoint-tool', context, binding.executionCallId),
      );
      if (!tool || tool.position >= page.toolCount)
        await index.set(
          'resource-pending',
          pendingKey(queuedPage.ref.digest, pendingBindings++),
          locator,
        );
    };
    for (
      let position = 0;
      position < (proof?.pendingBindings ?? 0);
      position++
    ) {
      const locator = await index.get<ItemLocator>(
        'resource-pending',
        pendingKey(proof!.ref.digest, position),
      );
      requireHistory(locator !== undefined, 'binding directory is incomplete.');
      await keepPending(locator);
    }
    for (let position = 0; position < page.bindings.length; position++)
      await keepPending({
        ref: queuedPage.ref,
        index: position,
        position: page.bindingCount - page.bindings.length + position,
      });
    const maxOrdinal = page.items.reduce<number>(
      (maximum, raw) =>
        Math.max(
          maximum,
          parseToolItem(raw, 'checkpoint history tool').ordinal,
        ),
      proof?.maxOrdinal ?? -1,
    );
    const nextProof: PageProof = {
      ref: queuedPage.ref,
      toolCount: page.toolCount,
      bindingCount: page.bindingCount,
      pageCount: (proof?.pageCount ?? 0) + 1,
      byteLength: (proof?.byteLength ?? 0) + queuedPage.bytes,
      context,
      maxOrdinal,
      pendingBindings,
    };
    requireHistory(
      nextProof.pageCount <= MAX_HISTORY_PAGES &&
        nextProof.byteLength <= MAX_HISTORY_BYTES,
      'decoded history capacity exceeded.',
    );
    await index.set(
      'checkpoint',
      key('checkpoint-page', context, queuedPage.ref.digest),
      nextProof,
    );
    proof = nextProof;
  }
  requireHistory(
    proof !== undefined &&
      isDeepStrictEqual(proof.ref, history.ref) &&
      proof.toolCount === history.toolCount &&
      proof.bindingCount === history.bindingCount,
    'history coverage conflicts.',
  );
  return proof;
}

async function viewOf(
  bytes: Buffer,
  resources: Pick<ManagedSessionResourceStore, 'read'>,
  index: FileManagedSessionHistory,
  release?: () => Promise<void>,
): Promise<PreparedHarnessCheckpoint> {
  bytes = Buffer.from(bytes);
  const paged = isPagedHarnessCheckpoint(bytes);
  const physical = paged ? physicalRoot(bytes) : undefined;
  const checkpoint = physical
    ? parseHarnessCheckpointResidentObject(
        physical.state,
        physical.history.toolCount,
      )
    : (() => {
        const parsed = tryParseHarnessCheckpointV1(bytes);
        requireHistory(parsed.ok, parsed.ok ? '' : parsed.message);
        return parsed.checkpoint;
      })();
  if (physical)
    requireHistory(
      checkpoint.tools !== null &&
        (physical.history.bindingCount === 0 || checkpoint.runtime !== null),
      'archived checkpoint group is missing.',
    );
  const history = physical
    ? await indexArchive(resources, checkpoint, physical.history, index)
    : undefined;
  const context = contextOf(checkpoint);
  for (const item of checkpoint.tools?.items ?? []) {
    for (const identity of [
      key('checkpoint-tool', context, item.executionCallId),
      key('checkpoint-call', context, item.functionCallId),
      key('checkpoint-ordinal', context, item.ordinal),
    ]) {
      const old = await index.get<ItemLocator>('resource', identity);
      requireHistory(
        !old || old.position >= (history?.toolCount ?? 0),
        'inline tool repeats archived identity.',
      );
    }
  }
  for (
    let position = 0;
    position < (history?.pendingBindings ?? 0);
    position++
  ) {
    const locator = await index.get<ItemLocator>(
      'resource-pending',
      key('checkpoint-pending-binding', context, history!.ref.digest, position),
    );
    requireHistory(locator !== undefined, 'binding directory is incomplete.');
    const binding = await bindingAt(resources, locator, index);
    requireHistory(
      checkpoint.tools?.items.some(
        (item) => item.executionCallId === binding.executionCallId,
      ),
      'binding has no matching tool.',
    );
  }
  for (const binding of checkpoint.runtime?.bindings ?? []) {
    for (const identity of [
      key('checkpoint-binding', context, binding.executionCallId),
      key('checkpoint-invocation', context, binding.invocationBindingId),
    ]) {
      const old = await index.get<ItemLocator>('resource', identity);
      requireHistory(
        !old || old.position >= (history?.bindingCount ?? 0),
        'inline binding repeats archived identity.',
      );
    }
    const tool = await index.get<ItemLocator>(
      'resource',
      key('checkpoint-tool', context, binding.executionCallId),
    );
    requireHistory(
      (tool !== undefined && tool.position < (history?.toolCount ?? 0)) ||
        checkpoint.tools?.items.some(
          (item) => item.executionCallId === binding.executionCallId,
        ),
      'binding has no matching tool.',
    );
  }
  const snapshot = index.snapshot();
  snapshot.setRebuilder(async (repair) => {
    const rebuilt = await viewOf(bytes, resources, repair);
    await rebuilt.view.close();
  });
  const view = new ManagedHarnessCheckpointView(
    checkpoint,
    resources,
    snapshot,
    history,
    release,
    createHash('sha256').update(bytes).digest('hex'),
  );
  return { bytes, checkpoint, history, view };
}

export async function readHarnessCheckpointView(
  resources: Pick<ManagedSessionResourceStore, 'read'>,
  ref: ManagedSessionDurableRef,
  scratch?: FileManagedSessionHistory,
): Promise<ManagedHarnessCheckpointView> {
  ref = structuredClone(ref);
  requireHistory(
    ref.kind === 'managed-checkpoint' && ref.schemaVersion === 1,
    'checkpoint reference conflicts.',
  );
  const index =
    scratch ??
    (await FileManagedSessionHistory.create(
      path.join(os.tmpdir(), 'qwen-checkpoint-query'),
    ));
  try {
    const view = (
      await viewOf(
        await verifiedRead(resources, ref),
        resources,
        index,
        scratch ? undefined : () => index.close(),
      )
    ).view;
    view.bindReference(ref);
    return view;
  } catch (cause) {
    if (!scratch) await index.close();
    throw cause;
  }
}

/** Explicit complete materialization; production recovery uses the fixed-prefix view. */
export async function readHarnessCheckpoint(
  resources: Pick<ManagedSessionResourceStore, 'read'>,
  ref: ManagedSessionDurableRef,
): Promise<HarnessCheckpointV1> {
  const view = await readHarnessCheckpointView(resources, ref);
  try {
    return parseHarnessCheckpointObject({
      ...view.checkpoint,
      tools: view.checkpoint.tools && {
        ...view.checkpoint.tools,
        items: await view.tools.collect(
          MAX_HISTORY_PAGES * CHECKPOINT_HISTORY_PAGE_ITEMS + 65536,
        ),
      },
      runtime: view.checkpoint.runtime && {
        bindings: await view.bindings.collect(
          MAX_HISTORY_PAGES * CHECKPOINT_HISTORY_PAGE_ITEMS + 65536,
        ),
      },
    } as unknown as ManagedSessionJsonValue);
  } finally {
    await view.close();
  }
}

export type ManagedHarnessCheckpointParseResult =
  | {
      readonly ok: true;
      readonly checkpoint: HarnessCheckpointV1;
      readonly history: ManagedHarnessCheckpointView;
    }
  | Extract<HarnessCheckpointParseResult, { ok: false }>;

/** One committed basis; its resident body contains active work and a fixed tail. */
export class ManagedCheckpointHistory {
  private committed?: Omit<PreparedHarnessCheckpoint, 'bytes'> & {
    readonly ref: ManagedSessionDurableRef;
  };
  private index?: FileManagedSessionHistory;
  constructor(
    private readonly resources: ManagedSessionResourceStore,
    private readonly createIndex?: () => FileManagedSessionHistory,
  ) {}
  private async currentIndex(): Promise<FileManagedSessionHistory> {
    this.index ??=
      this.createIndex?.() ??
      (await FileManagedSessionHistory.create(
        path.join(os.tmpdir(), 'qwen-checkpoint-query'),
      ));
    return this.index;
  }
  async read(
    ref: ManagedSessionDurableRef,
  ): Promise<PreparedHarnessCheckpoint> {
    ref = structuredClone(ref);
    if (this.committed && isDeepStrictEqual(this.committed.ref, ref))
      return {
        ...this.committed,
        bytes: await verifiedRead(this.resources, ref),
      };
    return viewOf(
      await verifiedRead(this.resources, ref),
      this.resources,
      await this.currentIndex(),
    );
  }
  async tryRead(
    ref: ManagedSessionDurableRef,
  ): Promise<ManagedHarnessCheckpointParseResult> {
    ref = structuredClone(ref);
    if (this.committed && isDeepStrictEqual(this.committed.ref, ref))
      return {
        ok: true,
        checkpoint: this.committed.checkpoint,
        history: this.committed.view,
      };
    try {
      const prepared = await this.read(ref);
      this.remember(ref, prepared);
      return {
        ok: true,
        checkpoint: prepared.checkpoint,
        history: prepared.view,
      };
    } catch (cause) {
      if (!(cause instanceof ManagedSessionRecordError)) throw cause;
      const bytes = await verifiedRead(this.resources, ref);
      const parsed = tryParseHarnessCheckpointV1(bytes);
      return parsed.ok
        ? { ok: false, reason: 'invalid', message: cause.message }
        : parsed;
    }
  }
  remember(
    ref: ManagedSessionDurableRef,
    prepared: PreparedHarnessCheckpoint,
  ): void {
    prepared.view.bindReference(ref);
    const { bytes: _bytes, ...resident } = prepared;
    this.committed = { ...resident, ref: structuredClone(ref) };
    this.index = prepared.view.forkIndex();
  }
  async prepare(
    checkpoint: HarnessCheckpointV1,
    previousRef?: ManagedSessionDurableRef,
  ): Promise<PreparedHarnessCheckpoint> {
    const previous = previousRef ? await this.read(previousRef) : undefined;
    let state = parseHarnessCheckpointResidentObject(
      checkpoint as unknown as ManagedSessionJsonValue,
      checkpoint.continuation.phase === 'before_model'
        ? 0
        : (previous?.history?.toolCount ?? 0),
    );
    let items = state.tools?.items ?? [];
    let bindings = state.runtime?.bindings ?? [];
    let history: History | undefined;
    let index =
      previousRef && state.continuation.phase !== 'before_model'
        ? (await this.currentIndex()).fork()
        : (await this.currentIndex()).emptyView();
    if (previous && state.continuation.phase !== 'before_model') {
      if (
        previous.history &&
        managedSessionKeysEqual(
          previous.checkpoint.identity.sessionKey,
          state.identity.sessionKey,
        ) &&
        previous.checkpoint.identity.turnId === state.identity.turnId &&
        previous.checkpoint.identity.promptId === state.identity.promptId
      ) {
        history = previous.history;
        index = previous.view.forkIndex();
        const firstIsInline =
          items[0] &&
          previous.checkpoint.tools?.items.some(
            (item) => item.executionCallId === items[0].executionCallId,
          );
        const archivedFirst =
          !firstIsInline && items[0]
            ? await previous.view.tools.at(0)
            : undefined;
        if (
          archivedFirst &&
          archivedFirst.executionCallId === items[0]?.executionCallId
        ) {
          let offset = 0;
          for await (const item of previous.view.tools.slice(
            0,
            history.toolCount,
          ))
            requireHistory(
              isDeepStrictEqual(item, items[offset++]),
              'committed prefix was changed.',
            );
          offset = 0;
          for await (const binding of previous.view.bindings.slice(
            0,
            history.bindingCount,
          ))
            requireHistory(
              isDeepStrictEqual(binding, bindings[offset++]),
              'committed prefix was changed.',
            );
          items = items.slice(history.toolCount);
          bindings = bindings.slice(history.bindingCount);
          state = {
            ...state,
            tools: state.tools && { ...state.tools, items },
            runtime: state.runtime && { bindings },
          };
        }
      }
    }
    let eligible = 0;
    while (
      eligible < items.length &&
      items[eligible].state === 'settled' &&
      items[eligible].consumed
    )
      eligible++;
    const toolTarget =
      Math.floor(
        Math.max(0, eligible - CHECKPOINT_HISTORY_PAGE_ITEMS) /
          CHECKPOINT_HISTORY_PAGE_ITEMS,
      ) * CHECKPOINT_HISTORY_PAGE_ITEMS;
    const context = contextOf(state);
    const archivedIds = new Set(
      items.slice(0, toolTarget).map((item) => item.executionCallId),
    );
    let bindingTarget = 0;
    while (
      bindingTarget < bindings.length &&
      bindings[bindingTarget].state !== 'dispatch'
    ) {
      const id = bindings[bindingTarget].executionCallId;
      const old = await index.get<ItemLocator>(
        'resource',
        key('checkpoint-tool', context, id),
      );
      if (
        !archivedIds.has(id) &&
        !(old && old.position < (history?.toolCount ?? 0))
      )
        break;
      bindingTarget++;
    }
    let toolsArchived = 0;
    let bindingsArchived = 0;
    while (toolsArchived < toolTarget || bindingsArchived < bindingTarget) {
      const pageItems: HarnessToolItem[] = [];
      const pageBindings: HarnessRuntimeBinding[] = [];
      const body = () => ({
        storageProfile: `${CHECKPOINT_HISTORY_KIND}/1`,
        sessionKey: state.identity.sessionKey,
        turnId: state.identity.turnId,
        promptId: state.identity.promptId,
        previous: history?.ref ?? null,
        toolCount: (history?.toolCount ?? 0) + pageItems.length,
        bindingCount: (history?.bindingCount ?? 0) + pageBindings.length,
        items: pageItems,
        bindings: pageBindings,
      });
      const fits = () =>
        Buffer.byteLength(JSON.stringify(body())) <=
        CHECKPOINT_HISTORY_PAGE_BYTES;
      while (
        toolsArchived + pageItems.length < toolTarget &&
        pageItems.length < CHECKPOINT_HISTORY_PAGE_ITEMS
      ) {
        pageItems.push(items[toolsArchived + pageItems.length]);
        if (!fits()) {
          pageItems.pop();
          break;
        }
      }
      while (
        bindingsArchived + pageBindings.length < bindingTarget &&
        pageBindings.length < CHECKPOINT_HISTORY_PAGE_ITEMS
      ) {
        pageBindings.push(bindings[bindingsArchived + pageBindings.length]);
        if (!fits()) {
          pageBindings.pop();
          break;
        }
      }
      requireHistory(
        pageItems.length + pageBindings.length > 0,
        'one history entry exceeds the page budget.',
      );
      const bytes = Buffer.from(JSON.stringify(body()));
      const pageCount = (history?.pageCount ?? 0) + 1;
      const byteLength = (history?.byteLength ?? 0) + bytes.byteLength;
      requireHistory(
        pageCount <= MAX_HISTORY_PAGES && byteLength <= MAX_HISTORY_BYTES,
        'decoded history capacity exceeded.',
      );
      const ref = await this.resources.publish(CHECKPOINT_HISTORY_KIND, bytes);
      history = {
        ref,
        toolCount: (history?.toolCount ?? 0) + pageItems.length,
        bindingCount: (history?.bindingCount ?? 0) + pageBindings.length,
        pageCount,
        byteLength,
      };
      toolsArchived += pageItems.length;
      bindingsArchived += pageBindings.length;
    }
    const tail = {
      ...state,
      tools: state.tools && {
        ...state.tools,
        items: items.slice(toolsArchived),
      },
      runtime: state.runtime && {
        ...state.runtime,
        bindings: bindings.slice(bindingsArchived),
      },
    };
    const bytes = history
      ? Buffer.from(
          JSON.stringify({
            ...tail,
            storageProfile: CHECKPOINT_STORAGE_PROFILE,
            history: {
              ref: history.ref,
              toolCount: history.toolCount,
              bindingCount: history.bindingCount,
            },
          }),
        )
      : encodeHarnessCheckpointV1(tail);
    requireHistory(
      bytes.byteLength <= MANAGED_SESSION_LIMITS.maxEventBytes,
      'active checkpoint exceeds its physical budget.',
    );
    return viewOf(bytes, this.resources, index);
  }
}
