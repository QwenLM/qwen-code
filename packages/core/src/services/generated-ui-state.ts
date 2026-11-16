/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isTranscriptConversationRecord,
  type TranscriptRecordInput,
} from '../utils/transcript-records.js';

/**
 * Persistent view state for Generated UI cards. Each save is a side record in
 * the session transcript, so state follows the conversation branch: a rewind
 * past a save drops it, and a fork carries the saves on the copied branch.
 */

export const GENERATED_UI_STATE_SUBTYPE = 'generated_ui_state';
/** Serialized UTF-8 size of one card's state. */
export const GENERATED_UI_STATE_MAX_BYTES = 16 * 1024;
/** Distinct cards with saved state in one session. */
export const GENERATED_UI_STATE_MAX_CARDS = 128;
/** Card ids are minted by the Generated UI server and recorded in its result. */
export const GENERATED_UI_CARD_ID_PATTERN = /^gc_[A-Za-z0-9_-]{16,64}$/;

export interface GeneratedUiStateRecordPayload {
  version: 1;
  cardId: string;
  revision: number;
  value: unknown;
}

export interface GeneratedUiStateSnapshot {
  cardId: string;
  /** 0 when the card has never been saved. */
  revision: number;
  /** `null` when the card has never been saved. */
  value: unknown;
}

export type GeneratedUiStateWriteResult =
  | { outcome: 'saved'; cardId: string; revision: number }
  | { outcome: 'stale'; cardId: string; revision: number; value: unknown }
  | { outcome: 'too_large'; cardId: string; limitBytes: number };

export class GeneratedUiStateError extends Error {
  constructor(
    readonly code:
      | 'invalid_card_id'
      | 'invalid_state'
      | 'state_card_limit'
      | 'state_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'GeneratedUiStateError';
  }
}

export interface GeneratedUiStateRestore {
  states?: ReadonlyMap<string, { revision: number; value: unknown }>;
  /** The transcript could not be read completely. */
  unavailable?: true;
}

type StateRecordLike = Pick<
  TranscriptRecordInput,
  'type' | 'subtype' | 'uuid' | 'parentUuid' | 'systemPayload'
>;

export function isGeneratedUiStateRecord(record: {
  readonly type?: unknown;
  readonly subtype?: unknown;
}): boolean {
  return (
    record.type === 'system' && record.subtype === GENERATED_UI_STATE_SUBTYPE
  );
}

export function assertGeneratedUiCardId(cardId: unknown): string {
  if (typeof cardId !== 'string' || !GENERATED_UI_CARD_ID_PATTERN.test(cardId))
    throw new GeneratedUiStateError('invalid_card_id', 'Invalid card id');
  return cardId;
}

function parsePayload(value: unknown): GeneratedUiStateRecordPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (
    payload['version'] !== 1 ||
    typeof payload['cardId'] !== 'string' ||
    !GENERATED_UI_CARD_ID_PATTERN.test(payload['cardId']) ||
    !Number.isSafeInteger(payload['revision']) ||
    (payload['revision'] as number) < 1 ||
    !('value' in payload)
  )
    return null;
  return payload as unknown as GeneratedUiStateRecordPayload;
}

/**
 * The state saves that belong to the active branch, in transcript order. A
 * save is written beside the active tail without moving it, so it belongs to
 * the branch when the conversation record it hangs from is on that branch;
 * records between them that are not conversation records are skipped.
 */
export function selectActiveGeneratedUiStateRecordUuids(
  records: readonly StateRecordLike[],
  activeRecordUuids: readonly string[],
): string[] {
  const active = new Set(activeRecordUuids);
  const byUuid = new Map<string, StateRecordLike>();
  for (const record of records) {
    if (!byUuid.has(record.uuid)) byUuid.set(record.uuid, record);
  }
  const selected: string[] = [];
  for (const record of records) {
    if (!isGeneratedUiStateRecord(record)) continue;
    let parent = record.parentUuid;
    const seen = new Set<string>();
    while (parent !== null && !active.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      const next = byUuid.get(parent);
      if (!next || isTranscriptConversationRecord(next)) break;
      parent = next.parentUuid;
    }
    if (parent !== null && active.has(parent)) selected.push(record.uuid);
  }
  return selected;
}

/** The latest valid save per card among the given records. */
export function restoreGeneratedUiStates(
  records: ReadonlyArray<
    Pick<TranscriptRecordInput, 'type' | 'subtype' | 'systemPayload'>
  >,
): Map<string, { revision: number; value: unknown }> {
  const states = new Map<string, { revision: number; value: unknown }>();
  for (const record of records) {
    if (!isGeneratedUiStateRecord(record)) continue;
    const payload = parsePayload(record.systemPayload);
    if (!payload) continue;
    states.set(payload.cardId, {
      revision: payload.revision,
      value: payload.value,
    });
  }
  return states;
}

function serialize(value: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    json = undefined;
  }
  if (json === undefined)
    throw new GeneratedUiStateError(
      'invalid_state',
      'State must be a JSON value',
    );
  return json;
}

export class GeneratedUiStateService {
  private states = new Map<string, { revision: number; json: string }>();
  private loadedGeneration: number | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly options: {
      load: () => Promise<GeneratedUiStateRestore>;
      persist: (payload: GeneratedUiStateRecordPayload) => Promise<void>;
      /** Changes whenever the active branch is replaced, e.g. by a rewind. */
      branchGeneration: () => number;
    },
  ) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      const generation = this.options.branchGeneration();
      if (this.loadedGeneration !== generation) {
        let restored: GeneratedUiStateRestore;
        try {
          restored = await this.options.load();
        } catch {
          restored = { unavailable: true };
        }
        if (restored.unavailable)
          throw new GeneratedUiStateError(
            'state_unavailable',
            'Saved view state could not be read',
          );
        this.states = new Map(
          [...(restored.states ?? [])].map(([cardId, state]) => [
            cardId,
            { revision: state.revision, json: serialize(state.value) },
          ]),
        );
        this.loadedGeneration = generation;
      }
      return operation();
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  get(cardId: unknown): Promise<GeneratedUiStateSnapshot> {
    const id = assertGeneratedUiCardId(cardId);
    return this.serial(async () => {
      const state = this.states.get(id);
      return state
        ? {
            cardId: id,
            revision: state.revision,
            value: JSON.parse(state.json),
          }
        : { cardId: id, revision: 0, value: null };
    });
  }

  set(
    cardId: unknown,
    baseRevision: unknown,
    value: unknown,
  ): Promise<GeneratedUiStateWriteResult> {
    const id = assertGeneratedUiCardId(cardId);
    if (!Number.isSafeInteger(baseRevision) || (baseRevision as number) < 0)
      throw new GeneratedUiStateError(
        'invalid_state',
        'baseRevision must be a non-negative integer',
      );
    const json = serialize(value);
    if (Buffer.byteLength(json, 'utf8') > GENERATED_UI_STATE_MAX_BYTES)
      return Promise.resolve({
        outcome: 'too_large',
        cardId: id,
        limitBytes: GENERATED_UI_STATE_MAX_BYTES,
      });
    return this.serial(async () => {
      const current = this.states.get(id);
      const revision = current?.revision ?? 0;
      if (baseRevision !== revision)
        return {
          outcome: 'stale',
          cardId: id,
          revision,
          value: current ? JSON.parse(current.json) : null,
        };
      // Re-saving the same value acknowledges without growing the transcript.
      if (current && current.json === json)
        return { outcome: 'saved', cardId: id, revision };
      if (!current && this.states.size >= GENERATED_UI_STATE_MAX_CARDS)
        throw new GeneratedUiStateError(
          'state_card_limit',
          `At most ${GENERATED_UI_STATE_MAX_CARDS} cards can save state in one session`,
        );
      const next = revision + 1;
      try {
        await this.options.persist({
          version: 1,
          cardId: id,
          revision: next,
          value: JSON.parse(json),
        });
      } catch {
        // The recorder may or may not have the record; reload before trusting
        // the cache again.
        this.loadedGeneration = undefined;
        throw new GeneratedUiStateError(
          'state_unavailable',
          'View state could not be saved',
        );
      }
      this.states.set(id, { revision: next, json });
      return { outcome: 'saved', cardId: id, revision: next };
    });
  }
}
