/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isGeneratedUiStateRecord,
  selectActiveGeneratedUiStateRecordUuids,
  type TranscriptRecordInput,
} from '../utils/transcript-records.js';

/**
 * Persistent view state for Generated UI cards. Each save is a side record in
 * the session transcript, so state follows the conversation branch: a rewind
 * past a save drops it, and a fork carries the saves on the copied branch.
 */

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

export type GeneratedUiStateRestore =
  | {
      states: ReadonlyMap<string, { revision: number; value: unknown }>;
      /** The highest saved revision, including on abandoned branches. */
      maxRevision: number;
    }
  | { unavailable: true };

type StateRecordLike = Pick<
  TranscriptRecordInput,
  'type' | 'subtype' | 'uuid' | 'parentUuid' | 'systemPayload'
>;

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

/** Restore active values and the revision floor from the entire transcript. */
export function restoreGeneratedUiStates(
  records: readonly StateRecordLike[],
  activeRecordUuids: readonly string[],
) {
  const selected = new Set(
    selectActiveGeneratedUiStateRecordUuids(records, activeRecordUuids),
  );
  const states = new Map<string, { revision: number; value: unknown }>();
  let maxRevision = 0;
  for (const record of records) {
    if (!isGeneratedUiStateRecord(record)) continue;
    const payload = parsePayload(record.systemPayload);
    if (!payload) continue;
    maxRevision = Math.max(maxRevision, payload.revision);
    if (!selected.has(record.uuid)) continue;
    states.set(payload.cardId, {
      revision: payload.revision,
      value: payload.value,
    });
  }
  return { states, maxRevision };
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
  private maxRevision = 0;
  private loadedGeneration: number | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly options: {
      load: () => Promise<GeneratedUiStateRestore>;
      persist: (
        payload: GeneratedUiStateRecordPayload,
        generation: number,
      ) => Promise<void>;
      /** Changes whenever the active branch is replaced, e.g. by a rewind. */
      branchGeneration: () => number;
    },
  ) {}

  private serial<T>(
    operation: (generation: number) => T | Promise<T>,
  ): Promise<T> {
    const result = this.queue.then(async () => {
      for (;;) {
        const generation = this.options.branchGeneration();
        if (this.loadedGeneration === generation) return operation(generation);
        let restored: GeneratedUiStateRestore;
        try {
          restored = await this.options.load();
        } catch {
          restored = { unavailable: true };
        }
        if (this.options.branchGeneration() !== generation) continue;
        if ('unavailable' in restored)
          throw new GeneratedUiStateError(
            'state_unavailable',
            'Saved view state could not be read',
          );
        this.states = new Map(
          [...restored.states].map(([cardId, state]) => [
            cardId,
            { revision: state.revision, json: serialize(state.value) },
          ]),
        );
        this.maxRevision = restored.maxRevision;
        this.loadedGeneration = generation;
        return operation(generation);
      }
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  get(cardId: unknown): Promise<GeneratedUiStateSnapshot> {
    const id = assertGeneratedUiCardId(cardId);
    return this.serial(() => {
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
    return this.serial(async (generation) => {
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
      const next = this.maxRevision + 1;
      if (!Number.isSafeInteger(next))
        throw new GeneratedUiStateError(
          'state_unavailable',
          'View state revisions are exhausted',
        );
      try {
        await this.options.persist(
          {
            version: 1,
            cardId: id,
            revision: next,
            value: JSON.parse(json),
          },
          generation,
        );
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
      this.maxRevision = next;
      return { outcome: 'saved', cardId: id, revision: next };
    });
  }
}
