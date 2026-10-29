/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  encodeHarnessCheckpointV1,
  parseHarnessCheckpointObject,
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
  const bytes = await resources.read(ref);
  requireHistory(
    bytes.byteLength === ref.byteLength &&
      createHash('sha256').update(bytes).digest('hex') === ref.digest,
    'resource length or digest conflicts.',
  );
  return bytes;
}

async function load(
  resources: Pick<ManagedSessionResourceStore, 'read'>,
  ref: ManagedSessionDurableRef,
): Promise<PreparedHarnessCheckpoint> {
  requireHistory(
    ref.kind === 'managed-checkpoint' && ref.schemaVersion === 1,
    'checkpoint reference conflicts.',
  );
  const bytes = await verifiedRead(resources, ref);
  if (!isPagedHarnessCheckpoint(bytes)) {
    const parsed = tryParseHarnessCheckpointV1(bytes);
    requireHistory(
      parsed.ok,
      parsed.ok ? '' : (parsed.message ?? 'invalid inline checkpoint.'),
    );
    return { bytes, checkpoint: parsed.checkpoint };
  }
  const root = physicalRoot(bytes);
  const identity = object(root.state['identity']);
  const pages: Array<ReturnType<typeof checkpointHistoryPage>> = [];
  const visited = new Set<string>();
  let next: ManagedSessionDurableRef | null = root.history.ref;
  let toolCount = root.history.toolCount;
  let bindingCount = root.history.bindingCount;
  let totalBytes = 0;
  while (next !== null) {
    requireHistory(
      !visited.has(next.resourceId) && visited.size < MAX_HISTORY_PAGES,
      'page cycle or capacity exceeded.',
    );
    visited.add(next.resourceId);
    const part = await verifiedRead(resources, next);
    totalBytes += part.byteLength;
    requireHistory(
      totalBytes <= MAX_HISTORY_BYTES,
      'decoded history capacity exceeded.',
    );
    const page = checkpointHistoryPage(part);
    requireHistory(
      isDeepStrictEqual(page.sessionKey, identity['sessionKey']) &&
        page.turnId === identity['turnId'] &&
        page.promptId === identity['promptId'],
      'page belongs to another Session or Turn.',
    );
    requireHistory(
      page.toolCount === toolCount && page.bindingCount === bindingCount,
      'page counts conflict.',
    );
    toolCount -= page.items.length;
    bindingCount -= page.bindings.length;
    requireHistory(
      toolCount >= 0 &&
        bindingCount >= 0 &&
        (page.previous !== null || toolCount + bindingCount === 0),
      'page coverage conflicts.',
    );
    pages.push(page);
    next = page.previous;
  }
  requireHistory(
    toolCount === 0 && bindingCount === 0,
    'history is incomplete.',
  );
  const tools = object(root.state['tools']);
  const runtime =
    root.state['runtime'] === null ? null : object(root.state['runtime']);
  requireHistory(
    Array.isArray(tools['items']) &&
      (runtime === null || Array.isArray(runtime['bindings'])),
    'active arrays conflict.',
  );
  pages.reverse();
  const items = pages.flatMap((page) => page.items);
  const bindings = pages.flatMap((page) => page.bindings);
  const checkpoint = parseHarnessCheckpointObject({
    ...root.state,
    tools: { ...tools, items: [...items, ...tools['items']] },
    runtime:
      runtime === null
        ? null
        : {
            ...runtime,
            bindings: [
              ...bindings,
              ...(runtime['bindings'] as ManagedSessionJsonValue[]),
            ],
          },
  });
  requireHistory(
    root.history.bindingCount === 0 || runtime !== null,
    'archived bindings lost their group.',
  );
  return {
    bytes,
    checkpoint,
    history: {
      ...root.history,
      pageCount: pages.length,
      byteLength: totalBytes,
    },
  };
}

export async function readHarnessCheckpoint(
  resources: Pick<ManagedSessionResourceStore, 'read'>,
  ref: ManagedSessionDurableRef,
): Promise<HarnessCheckpointV1> {
  return (await load(resources, ref)).checkpoint;
}

/** One committed basis only; uncertain writes never advance this cache. */
export class ManagedCheckpointHistory {
  private committed?: PreparedHarnessCheckpoint & {
    readonly ref: ManagedSessionDurableRef;
  };

  constructor(private readonly resources: ManagedSessionResourceStore) {}

  async read(
    ref: ManagedSessionDurableRef,
  ): Promise<PreparedHarnessCheckpoint> {
    if (this.committed && isDeepStrictEqual(this.committed.ref, ref))
      return this.committed;
    return load(this.resources, ref);
  }

  async tryRead(
    ref: ManagedSessionDurableRef,
  ): Promise<HarnessCheckpointParseResult> {
    if (this.committed && isDeepStrictEqual(this.committed.ref, ref))
      return { ok: true, checkpoint: this.committed.checkpoint };
    const bytes = await verifiedRead(this.resources, ref);
    if (!isPagedHarnessCheckpoint(bytes)) {
      const parsed = tryParseHarnessCheckpointV1(bytes);
      if (parsed.ok)
        this.remember(ref, { bytes, checkpoint: parsed.checkpoint });
      return parsed;
    }
    try {
      const prepared = await load(this.resources, ref);
      this.remember(ref, prepared);
      return { ok: true, checkpoint: prepared.checkpoint };
    } catch (error) {
      if (!(error instanceof ManagedSessionRecordError)) throw error;
      return { ok: false, reason: 'invalid', message: error.message };
    }
  }

  remember(
    ref: ManagedSessionDurableRef,
    prepared: PreparedHarnessCheckpoint,
  ): void {
    this.committed = { ...prepared, ref };
  }

  async prepare(
    checkpoint: HarnessCheckpointV1,
    previousRef?: ManagedSessionDurableRef,
  ): Promise<PreparedHarnessCheckpoint> {
    const state = parseHarnessCheckpointObject(
      checkpoint as unknown as ManagedSessionJsonValue,
    );
    const items = state.tools?.items ?? [];
    const bindings = state.runtime?.bindings ?? [];
    let history: History | undefined;
    if (previousRef && state.continuation.phase !== 'before_model') {
      const previous = await this.read(previousRef);
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
        requireHistory(
          isDeepStrictEqual(
            items.slice(0, history.toolCount),
            previous.checkpoint.tools?.items.slice(0, history.toolCount),
          ) &&
            isDeepStrictEqual(
              bindings.slice(0, history.bindingCount),
              previous.checkpoint.runtime?.bindings.slice(
                0,
                history.bindingCount,
              ) ?? [],
            ),
          'committed prefix was changed.',
        );
      }
    }
    let eligible = 0;
    while (
      eligible < items.length &&
      items[eligible].state === 'settled' &&
      items[eligible].consumed
    )
      eligible++;
    const toolTarget = Math.max(
      history?.toolCount ?? 0,
      Math.floor(
        Math.max(0, eligible - CHECKPOINT_HISTORY_PAGE_ITEMS) /
          CHECKPOINT_HISTORY_PAGE_ITEMS,
      ) * CHECKPOINT_HISTORY_PAGE_ITEMS,
    );
    const archivedIds = new Set(
      items.slice(0, toolTarget).map((item) => item.executionCallId),
    );
    let bindingTarget = 0;
    while (
      bindingTarget < bindings.length &&
      bindings[bindingTarget].state !== 'dispatch' &&
      archivedIds.has(bindings[bindingTarget].executionCallId)
    )
      bindingTarget++;
    let toolCount = history?.toolCount ?? 0;
    let bindingCount = history?.bindingCount ?? 0;
    requireHistory(
      eligible >= toolCount && bindingTarget >= bindingCount,
      'committed history became unfinished.',
    );
    while (toolCount < toolTarget || bindingCount < bindingTarget) {
      const pageItems: HarnessToolItem[] = [];
      const pageBindings: HarnessRuntimeBinding[] = [];
      const body = () => ({
        storageProfile: `${CHECKPOINT_HISTORY_KIND}/1`,
        sessionKey: state.identity.sessionKey,
        turnId: state.identity.turnId,
        promptId: state.identity.promptId,
        previous: history?.ref ?? null,
        toolCount: toolCount + pageItems.length,
        bindingCount: bindingCount + pageBindings.length,
        items: pageItems,
        bindings: pageBindings,
      });
      const fits = () =>
        Buffer.byteLength(JSON.stringify(body()), 'utf8') <=
        CHECKPOINT_HISTORY_PAGE_BYTES;
      while (
        toolCount + pageItems.length < toolTarget &&
        pageItems.length < CHECKPOINT_HISTORY_PAGE_ITEMS
      ) {
        pageItems.push(items[toolCount + pageItems.length]);
        if (!fits()) {
          pageItems.pop();
          break;
        }
      }
      while (
        bindingCount + pageBindings.length < bindingTarget &&
        pageBindings.length < CHECKPOINT_HISTORY_PAGE_ITEMS
      ) {
        pageBindings.push(bindings[bindingCount + pageBindings.length]);
        if (!fits()) {
          pageBindings.pop();
          break;
        }
      }
      requireHistory(
        pageItems.length + pageBindings.length > 0,
        'one history entry exceeds the page budget.',
      );
      const bytes = Buffer.from(JSON.stringify(body()), 'utf8');
      const pageCount = (history?.pageCount ?? 0) + 1;
      const byteLength = (history?.byteLength ?? 0) + bytes.byteLength;
      requireHistory(
        pageCount <= MAX_HISTORY_PAGES && byteLength <= MAX_HISTORY_BYTES,
        'decoded history capacity exceeded.',
      );
      const ref = await this.resources.publish(CHECKPOINT_HISTORY_KIND, bytes);
      toolCount += pageItems.length;
      bindingCount += pageBindings.length;
      history = { ref, toolCount, bindingCount, pageCount, byteLength };
    }
    if (!history)
      return { bytes: encodeHarnessCheckpointV1(state), checkpoint: state };
    const tail: HarnessCheckpointV1 = {
      ...state,
      tools: state.tools && { ...state.tools, items: items.slice(toolCount) },
      runtime: state.runtime && {
        ...state.runtime,
        bindings: bindings.slice(bindingCount),
      },
    };
    const bytes = Buffer.from(
      JSON.stringify({
        ...JSON.parse(encodeHarnessCheckpointV1(tail).toString('utf8')),
        storageProfile: CHECKPOINT_STORAGE_PROFILE,
        history: {
          ref: history.ref,
          toolCount: history.toolCount,
          bindingCount: history.bindingCount,
        },
      }),
      'utf8',
    );
    requireHistory(
      bytes.byteLength <= MANAGED_SESSION_LIMITS.maxEventBytes,
      'active checkpoint exceeds its physical budget.',
    );
    return { bytes, checkpoint: state, history };
  }
}
