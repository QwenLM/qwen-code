/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type {
  DaemonGeneratedUiState,
  DaemonGeneratedUiStateWriteResult,
} from '@qwen-code/sdk/daemon';

/** The App frame asks for these; the host answers for the card it mounted. */
export const VIEW_STATE_CAPABILITY = 'qwen-code/generated-ui-state';
export const VIEW_STATE_LOAD = 'qwen-code/generated-ui-state/load';
export const VIEW_STATE_SAVE = 'qwen-code/generated-ui-state/save';

const MAX_STATE_BYTES = 16 * 1024;
const CARD_ID = /^gc_[A-Za-z0-9_-]{16,64}$/;

export interface ViewStateStore {
  sessionId: string;
  get(cardId: string): Promise<DaemonGeneratedUiState>;
  set(
    cardId: string,
    write: { baseRevision: number; value: unknown },
  ): Promise<DaemonGeneratedUiStateWriteResult>;
  /** Admits a save now and binds its eventual write to the current owner. */
  captureWrite?(): ViewStateStore['set'];
}

export type ViewStateStatus =
  | 'saving'
  | 'saved'
  | 'stale'
  | 'too_large'
  | 'failed'
  | 'unavailable';

/** The card id the bundled Generated UI server minted into its result. */
export function generatedUiCardId(toolResult: unknown): string | undefined {
  const meta = (toolResult as { _meta?: Record<string, unknown> } | undefined)
    ?._meta?.['qwen/generated-ui'];
  const cardId = (meta as { cardId?: unknown } | undefined)?.cardId;
  return typeof cardId === 'string' && CARD_ID.test(cardId)
    ? cardId
    : undefined;
}

// A remounted card must not read its state while an earlier mount's write is
// still landing, or its first save would be rejected as stale.
const writes = new Map<string, Promise<void>>();

async function waitForWrites(key: string, signal?: AbortSignal): Promise<void> {
  while (writes.has(key)) {
    signal?.throwIfAborted();
    await writes.get(key);
  }
}

/**
 * One mounted card's saved state. Saves are sent as soon as the previous one
 * settles, so only changes made while a write is in flight are coalesced.
 */
export class ViewStateCoordinator {
  private revision?: number;
  private saved?: string;
  private pending?: { json: string; set: ViewStateStore['set'] };
  // The value of the write in flight; `saved` changes only when it lands.
  private inFlight?: string;
  private stale = false;
  // An older write can still finish after the latest save was refused.
  private latestSaveFailure?: 'failed' | 'too_large';
  private last?: ViewStateStatus;
  private readonly key: string;

  constructor(
    private readonly store: ViewStateStore,
    private readonly cardId: string,
    private readonly onStatus: (status: ViewStateStatus) => void,
  ) {
    this.key = JSON.stringify([store.sessionId, cardId]);
  }

  async load(signal?: AbortSignal): Promise<unknown> {
    const reportUnavailable = () => this.report('unavailable');
    signal?.addEventListener('abort', reportUnavailable, { once: true });
    try {
      await waitForWrites(this.key, signal);
      signal?.throwIfAborted();
      const state = await this.store.get(this.cardId);
      signal?.throwIfAborted();
      this.revision = state.revision;
      this.saved = JSON.stringify(state.value ?? null);
      return state.value ?? null;
    } catch (error) {
      reportUnavailable();
      throw error;
    } finally {
      signal?.removeEventListener('abort', reportUnavailable);
    }
  }

  save(value: unknown): void {
    if (this.revision === undefined || this.stale) return;
    let set: ViewStateStore['set'];
    try {
      set = this.store.captureWrite?.() ?? this.store.set.bind(this.store);
    } catch (error) {
      this.latestSaveFailure = 'failed';
      this.report('failed');
      throw error;
    }
    const json = JSON.stringify(value ?? null);
    this.latestSaveFailure =
      new TextEncoder().encode(json).byteLength > MAX_STATE_BYTES
        ? 'too_large'
        : undefined;
    this.pending = undefined;
    if (this.inFlight !== undefined) this.report('saving');
    if (this.latestSaveFailure) {
      if (this.inFlight === undefined) this.report(this.latestSaveFailure);
      return;
    }
    // Compare with what the store will hold once the write in flight lands,
    // so changing a value back during a write is still sent.
    if (json === (this.inFlight ?? this.saved)) {
      if (this.inFlight === undefined && this.last) this.report('saved');
      return;
    }
    this.pending = { json, set };
    this.pump();
  }

  /**
   * Clears the saved state for the host's reset. This mount saves nothing
   * afterwards; the reset mounts the card again. It reads the current
   * revision first, so it also works after a stale write or a failed load.
   */
  async clear(): Promise<boolean> {
    this.pending = undefined;
    this.stale = true;
    await waitForWrites(this.key);
    const clearing = (async () => {
      const state = await this.store.get(this.cardId);
      if (state.value === null) return true;
      const result = await this.store.set(this.cardId, {
        baseRevision: state.revision,
        value: null,
      });
      return result.outcome === 'saved';
    })().catch(() => false);
    const settled = clearing.then(() => {});
    writes.set(this.key, settled);
    const cleared = await clearing;
    if (writes.get(this.key) === settled) writes.delete(this.key);
    if (!cleared) this.report('failed');
    return cleared;
  }

  private pump(): void {
    if (this.inFlight !== undefined || this.pending === undefined) return;
    const { json, set } = this.pending;
    this.pending = undefined;
    this.inFlight = json;
    if (this.latestSaveFailure !== 'failed') this.report('saving');
    let status: ViewStateStatus = 'failed';
    let request: Promise<DaemonGeneratedUiStateWriteResult>;
    try {
      request = set(this.cardId, {
        baseRevision: this.revision!,
        value: JSON.parse(json) as unknown,
      });
    } catch (error) {
      request = Promise.reject(error);
    }
    const write = request
      .then(
        (result) => {
          if (result.outcome === 'saved') {
            this.revision = result.revision;
            this.saved = json;
            status = 'saved';
          } else if (result.outcome === 'stale') {
            this.stale = true;
            this.pending = undefined;
            status = 'stale';
          } else status = 'too_large';
        },
        () => {
          // The write may have landed even if its response didn't arrive.
          this.saved = undefined;
        },
      )
      .finally(() => {
        this.inFlight = undefined;
        if (writes.get(this.key) === write) writes.delete(this.key);
        if (this.pending !== undefined) this.pump();
        else
          this.report(
            status === 'stale' ? status : (this.latestSaveFailure ?? status),
          );
      });
    writes.set(this.key, write);
  }

  private report(status: ViewStateStatus): void {
    if (status === this.last) return;
    this.last = status;
    this.onStatus(status);
  }
}
