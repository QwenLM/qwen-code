/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DatabaseSync } from 'node:sqlite';
import type { MemoryConfig, MemoryConnection, MemoryLogger } from './config.js';
import type { EmbeddingClient } from './embed.js';
import { loadPreload } from './preload.js';
import {
  DialogueRecorder,
  type DialogueSegment,
  type DialogueTurn,
  type RecordResult,
} from './recorder.js';
import {
  renderEnvResults,
  renderMemoryBlock,
  renderRetrievedBlock,
  renderRetrievedSection,
  renderSegmentBody,
  renderSegmentIndexText,
} from './render.js';
import { searchDialogue, searchEnv } from './retrieval.js';
import {
  ObserverClient,
  recordObservation,
  type MemoryVisualFrame,
  type MemoryVisualSource,
} from './observer.js';
import type { MemoryStore } from './store.js';
import { indexText } from './tokenize.js';
import {
  UpdaterClient,
  consolidateSnapshot,
  type ConsolidationSnapshot,
  type ConsolidationStatus,
} from './updater.js';
import {
  applyOperations,
  parseEntries,
  renderEntries,
  type WmApplyResult,
} from './wm.js';

export interface MemoryToolResult {
  receipt: string;
  changed?: boolean;
  count?: number;
}

export function renderWmReceipt(result: WmApplyResult): string {
  return result.succeeded
    ? 'Successfully updated memory.'
    : 'Failed to update memory.';
}

export interface MemorySessionOptions {
  store: MemoryStore;
  libraryId: string;
  sessionId: string;
  sessionName?: string;
  config: MemoryConfig;
  connection: MemoryConnection;
  embedder?: EmbeddingClient;
  log?: MemoryLogger;
  fetch?: typeof fetch;
  captureVision?: () => Promise<MemoryVisualFrame | undefined>;
  visualSource?: MemoryVisualSource;
  updater?: UpdaterClient;
  observer?: ObserverClient;
  enqueueEmbedding?: (segmentId: number, body: string) => void;
  maxPromptChars?: number;
}

export class MemorySession {
  readonly libraryId: string;
  readonly sessionId: string;
  readonly recorder: DialogueRecorder;
  private readonly database: DatabaseSync;
  private readonly log: MemoryLogger;
  private readonly updater: UpdaterClient;
  private readonly observer: ObserverClient;
  private readonly maxPromptChars: number;
  private wm: string[];
  private wmSeq: number;
  private userProfile = '';
  private recent = '';
  private retrieved = '';
  private retrievalTail: Promise<void> = Promise.resolve();
  private isClosed = false;
  private flushed = false;
  private readonly pendingPersistence: RecordResult[] = [];
  private observerStarted = false;
  private observerEnabled: boolean;
  private visualSource: MemoryVisualSource;
  private observerGeneration = 0;
  private observerController?: AbortController;
  private observerTimer?: ReturnType<typeof setTimeout>;
  private latestFrame?: MemoryVisualFrame & { capturedAt: number };

  constructor(private readonly options: MemorySessionOptions) {
    this.maxPromptChars = options.maxPromptChars ?? 80_000;
    if (!Number.isSafeInteger(this.maxPromptChars) || this.maxPromptChars < 0) {
      throw new RangeError(
        'Memory prompt budget must be a non-negative integer.',
      );
    }
    this.libraryId = options.libraryId;
    this.sessionId = options.sessionId;
    this.log = options.log ?? (() => {});
    this.database = options.store.database(options.libraryId);
    this.visualSource = options.visualSource ?? 'screen';
    this.observerEnabled = options.config.observer.enabled;
    this.updater =
      options.updater ??
      new UpdaterClient({
        config: options.config.updater,
        connection: options.connection,
        log: this.log,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
    this.observer =
      options.observer ??
      new ObserverClient({
        config: options.config.observer,
        connection: options.connection,
        log: this.log,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
    const row = this.database
      .prepare(
        'SELECT COALESCE(MAX(turn_idx), -1) + 1 AS next FROM turns WHERE session_id = ?',
      )
      .get(this.sessionId);
    this.recorder = new DialogueRecorder(
      options.config.segment,
      Number(row?.['next'] ?? 0),
    );
    const snapshot = this.database
      .prepare(
        'SELECT seq, wm_json FROM wm_snapshots WHERE session_id = ? ORDER BY seq DESC LIMIT 1',
      )
      .get(this.sessionId);
    this.wm = parseEntries(snapshot?.['wm_json']);
    this.wmSeq = Number(snapshot?.['seq'] ?? 0);
    const now = new Date().toISOString();
    this.database
      .prepare(
        'INSERT INTO library_sessions(session_id, session_name, first_seen_at, last_seen_at, n_turns, n_segments, active) VALUES(?, ?, ?, ?, 0, 0, 1) ON CONFLICT(session_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, session_name = COALESCE(excluded.session_name, session_name)',
      )
      .run(this.sessionId, options.sessionName ?? null, now, now);
    try {
      const preload = loadPreload(
        this.database,
        this.sessionId,
        options.config.preload,
        undefined,
        this.log,
      );
      this.userProfile = preload.userProfile;
      this.recent = preload.recent;
    } catch (error) {
      this.failure('memory.preload.failed', error);
    }
    if (this.promptBlocks().length > this.maxPromptChars) {
      throw new RangeError(
        'Restored memory exceeds the available prompt budget.',
      );
    }
  }

  get closed(): boolean {
    return this.isClosed;
  }
  get wmEntries(): string[] {
    return [...this.wm];
  }

  recordUser(text: unknown, options: { moment?: Date } = {}): void {
    if (this.isClosed) return;
    try {
      this.persist(this.recorder.onUserText(text, options.moment));
    } catch (error) {
      this.failure('memory.record.failed', error);
    }
  }

  recordAssistant(
    text: unknown,
    options: { source?: string; interrupted?: boolean; moment?: Date } = {},
  ): void {
    if (this.isClosed) return;
    try {
      this.persist(this.recorder.onAssistantText(text, options));
    } catch (error) {
      this.failure('memory.record.failed', error);
    }
  }

  applyOmnibio(operations: unknown): WmApplyResult {
    if (this.isClosed) {
      const { result } = applyOperations(
        this.wm,
        undefined,
        this.options.config.wm,
      );
      result.reasons = ['session is closed'];
      return result;
    }
    const { entries, result } = applyOperations(
      this.wm,
      operations,
      this.options.config.wm,
      this.log,
    );
    if (!result.changed) return result;
    if (
      this.renderPrompt(entries, this.retrieved).length > this.maxPromptChars
    ) {
      this.log('memory.wm.prompt_budget', { limit: this.maxPromptChars });
      return {
        ...result,
        added: 0,
        updated: 0,
        deleted: 0,
        skipped:
          result.skipped + result.added + result.updated + result.deleted,
        nAfter: this.wm.length,
        changed: false,
        succeeded: false,
        reasons: [
          ...result.reasons,
          'working memory exceeds the prompt budget',
        ],
      };
    }
    const nextSeq = this.wmSeq + 1;
    try {
      this.database
        .prepare(
          'INSERT INTO wm_snapshots(session_id, seq, wm_json, ops_json, applied_json, created_at) VALUES(?, ?, ?, ?, ?, ?)',
        )
        .run(
          this.sessionId,
          nextSeq,
          JSON.stringify(entries),
          JSON.stringify(operations),
          JSON.stringify(result),
          new Date().toISOString(),
        );
    } catch (error) {
      this.failure('memory.wm.snapshot_failed', error);
      return {
        ...result,
        added: 0,
        updated: 0,
        deleted: 0,
        skipped:
          result.skipped + result.added + result.updated + result.deleted,
        nAfter: this.wm.length,
        changed: false,
        succeeded: false,
        reasons: [...result.reasons, 'working memory could not be saved'],
      };
    }
    this.wm = entries;
    this.wmSeq = nextSeq;
    return result;
  }

  retrieve(options: {
    query: unknown;
    source?: unknown;
    timeRange?: unknown;
  }): Promise<MemoryToolResult> {
    const pending = this.retrievalTail.then(() =>
      this.performRetrieve(options),
    );
    this.retrievalTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  private async performRetrieve(options: {
    query: unknown;
    source?: unknown;
    timeRange?: unknown;
  }): Promise<MemoryToolResult> {
    if (
      this.isClosed ||
      typeof options.query !== 'string' ||
      !options.query.trim()
    )
      return { receipt: 'Failed to search memory.' };
    const source = options.source ?? 'dialogue';
    if (source !== 'dialogue' && source !== 'env')
      return { receipt: 'Failed to search memory.' };
    const before = this.retrieved;
    try {
      const args = {
        database: this.database,
        query: options.query,
        timeRange: options.timeRange,
        config: this.options.config.retrieve,
        ...(this.options.embedder ? { embedder: this.options.embedder } : {}),
        vectors: this.options.store.vectorRows(
          this.libraryId,
          source,
          this.options.config.retrieve.model,
        ),
        log: this.log,
      };
      let rendered: string;
      let count: number;
      if (source === 'dialogue') {
        const result = await searchDialogue({
          ...args,
          tailTurns: this.recorder.tailTurns,
        });
        count = result.segments.length;
        rendered = renderRetrievedBlock(
          result.segments,
          this.options.config.retrieve.retrievedMaxChars,
        );
      } else {
        const result = await searchEnv(args);
        count = result.segments.length;
        const lines = renderRetrievedSection(
          renderEnvResults(result.segments),
          'env',
        ).split('\n');
        while (
          lines.length &&
          [...lines.join('\n')].length >
            this.options.config.retrieve.retrievedMaxChars
        )
          lines.pop();
        rendered = lines.join('\n');
      }
      if (this.isClosed) return { receipt: 'Failed to search memory.' };
      if (this.renderPrompt(this.wm, rendered).length > this.maxPromptChars) {
        this.log('memory.retrieve.prompt_budget', {
          limit: this.maxPromptChars,
        });
        return { receipt: 'Failed to search memory.' };
      }
      this.retrieved = rendered;
      this.log('memory.retrieve.completed', {
        source,
        count,
        chars: rendered.length,
      });
      return {
        receipt: `Successfully searched past ${source === 'env' ? 'visual observations' : 'conversations'}. ${count} matched.`,
        count,
        changed: before !== rendered,
      };
    } catch (error) {
      this.failure('memory.retrieve.failed', error);
      return { receipt: 'Failed to search memory.' };
    }
  }

  promptBlocks(): string {
    return this.renderPrompt(this.wm, this.retrieved);
  }

  private renderPrompt(entries: readonly string[], retrieved: string): string {
    return renderMemoryBlock({
      userProfile: this.userProfile,
      recent: this.recent,
      retrieved,
      personalizedUserMemories: renderEntries(entries),
    });
  }

  feedImage(image: string, source: MemoryVisualSource): void {
    if (
      this.isClosed ||
      !this.observerEnabled ||
      source !== this.visualSource ||
      !image
    )
      return;
    this.latestFrame = { image, source, capturedAt: Date.now() };
  }

  setVisualSource(source: MemoryVisualSource): void {
    if (source === this.visualSource) return;
    this.stopObserver();
    this.visualSource = source;
    this.scheduleObserver(0);
  }

  setObserverEnabled(enabled: boolean): void {
    if (enabled === this.observerEnabled) return;
    this.observerEnabled = enabled;
    this.stopObserver();
    this.scheduleObserver(0);
  }

  startObserver(): void {
    if (this.observerStarted || this.isClosed) return;
    this.observerStarted = true;
    this.scheduleObserver(0);
  }

  private scheduleObserver(delayMs: number): void {
    if (
      this.isClosed ||
      !this.observerStarted ||
      !this.observerEnabled ||
      !this.observer.available ||
      this.options.config.observer.intervalSec <= 0 ||
      this.observerTimer !== undefined
    )
      return;
    const generation = this.observerGeneration;
    this.observerTimer = setTimeout(() => {
      this.observerTimer = undefined;
      void this.observeNext(generation);
    }, delayMs);
    this.observerTimer.unref?.();
  }

  private async observeNext(generation: number): Promise<void> {
    const current = () =>
      !this.isClosed &&
      this.observerEnabled &&
      generation === this.observerGeneration;
    if (!current()) return;
    const controller = new AbortController();
    this.observerController = controller;
    let frame = this.latestFrame;
    let interval = Math.min(
      2000,
      this.options.config.observer.intervalSec * 1000,
    );
    try {
      if (this.options.captureVision) {
        const captured = await this.options.captureVision();
        if (!current()) return;
        if (captured && captured.source === this.visualSource) {
          frame = { ...captured, capturedAt: Date.now() };
          this.latestFrame = frame;
        }
      }
      if (!frame || frame.source !== this.visualSource || !current()) return;
      interval = this.options.config.observer.intervalSec * 1000;
      const ageMs = Date.now() - frame.capturedAt;
      if (
        this.options.config.observer.maxFrameAgeSec > 0 &&
        ageMs > this.options.config.observer.maxFrameAgeSec * 1000
      ) {
        this.log('memory.observer.stale_frame', { ageMs });
        return;
      }
      const content = await this.observer.observe(frame, controller.signal);
      if (!content || !current()) return;
      const id = recordObservation(
        this.database,
        content,
        this.sessionId,
        new Date(frame.capturedAt),
        this.log,
      );
      if (id !== undefined && this.options.embedder?.available) {
        const vectors = await this.options.embedder.embedDocuments([content]);
        if (!current()) return;
        const vector = vectors[0];
        if (vector)
          this.options.store.writeVector(
            this.libraryId,
            'env',
            id,
            vector,
            this.options.config.retrieve.model,
          );
      }
    } catch (error) {
      this.failure('memory.observer.failed', error);
    } finally {
      if (this.observerController === controller)
        this.observerController = undefined;
      if (current()) this.scheduleObserver(interval);
    }
  }

  private stopObserver(): void {
    this.observerGeneration++;
    this.latestFrame = undefined;
    if (this.observerTimer !== undefined) clearTimeout(this.observerTimer);
    this.observerTimer = undefined;
    this.observerController?.abort();
    this.observerController = undefined;
  }

  flush(): void {
    if (this.flushed) return;
    const final = this.recorder.flush();
    if (final.turn || final.segment) this.pendingPersistence.push(final);
    const tail = this.recorder.cutTail();
    if (tail) this.pendingPersistence.push({ segment: tail });
    this.persist({});
  }

  close(): void {
    if (this.flushed) return;
    this.isClosed = true;
    this.stopObserver();
    try {
      this.flush();
    } catch (error) {
      this.failure('memory.flush.failed', error);
      throw error;
    }
    this.flushed = true;
  }

  consolidationSnapshot(): ConsolidationSnapshot {
    return {
      libraryId: this.libraryId,
      sessionId: this.sessionId,
      wmSeq: this.wmSeq,
      wmEntries: [...this.wm],
      database: this.database,
      config: this.options.config,
      client: this.updater,
      log: this.log,
    };
  }

  consolidate(): Promise<ConsolidationStatus> {
    return consolidateSnapshot(this.consolidationSnapshot());
  }

  private persist(result: RecordResult): void {
    if (result.turn || result.segment) this.pendingPersistence.push(result);
    while (this.pendingPersistence.length) {
      const next = this.pendingPersistence[0]!;
      if (next.segment) {
        this.writeSegment(next.segment);
        delete next.segment;
      }
      if (next.turn) {
        this.writeTurn(next.turn);
        delete next.turn;
      }
      this.pendingPersistence.shift();
    }
    this.refreshCounters();
  }

  private writeTurn(turn: DialogueTurn): void {
    this.database
      .prepare(
        'INSERT INTO turns(session_id, turn_idx, user_text, user_ts, user_epoch, asst_text, asst_ts, asst_epoch, interrupted) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, turn_idx) DO UPDATE SET user_text = excluded.user_text, user_ts = excluded.user_ts, user_epoch = excluded.user_epoch, asst_text = excluded.asst_text, asst_ts = excluded.asst_ts, asst_epoch = excluded.asst_epoch, interrupted = excluded.interrupted',
      )
      .run(
        this.sessionId,
        turn.turnIdx,
        turn.userText,
        turn.userTs,
        turn.userEpoch,
        turn.asstText,
        turn.asstTs || turn.userTs,
        turn.asstEpoch || turn.userEpoch,
        turn.interrupted ? 1 : 0,
      );
  }

  private writeSegment(segment: DialogueSegment): void {
    const first = segment.turns[0];
    const last = segment.turns[segment.turns.length - 1];
    if (!first || !last) return;
    const body = renderSegmentBody(segment.turns);
    this.database.exec('BEGIN IMMEDIATE');
    let id: number;
    try {
      this.database
        .prepare(
          'INSERT INTO dialogue_segments(session_id, turn_from, turn_to, n_turns, start_ts, end_ts, start_epoch, end_epoch, body, cut_reason, n_chars) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, turn_from) DO UPDATE SET turn_to = excluded.turn_to, n_turns = excluded.n_turns, end_ts = excluded.end_ts, end_epoch = excluded.end_epoch, body = excluded.body, cut_reason = excluded.cut_reason, n_chars = excluded.n_chars',
        )
        .run(
          this.sessionId,
          first.turnIdx,
          last.turnIdx,
          segment.turns.length,
          first.userTs,
          last.asstTs || last.userTs,
          first.userEpoch,
          last.asstEpoch || last.userEpoch,
          body,
          segment.cutReason,
          [...body].length,
        );
      const row = this.database
        .prepare(
          'SELECT id FROM dialogue_segments WHERE session_id = ? AND turn_from = ?',
        )
        .get(this.sessionId, first.turnIdx);
      if (!row) throw new Error('Memory segment missing');
      id = Number(row['id']);
      this.database
        .prepare('DELETE FROM dialogue_fts WHERE seg_id = ?')
        .run(id);
      this.database
        .prepare('INSERT INTO dialogue_fts(index_text, seg_id) VALUES(?, ?)')
        .run(indexText(renderSegmentIndexText(segment.turns)), id);
      this.database
        .prepare(
          'UPDATE turns SET seg_id = ? WHERE session_id = ? AND turn_idx BETWEEN ? AND ?',
        )
        .run(id, this.sessionId, first.turnIdx, last.turnIdx);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    try {
      this.options.enqueueEmbedding?.(id, body);
    } catch (error) {
      this.failure('memory.embed.enqueue_failed', error);
    }
  }

  private refreshCounters(): void {
    this.database
      .prepare(
        'UPDATE library_sessions SET n_turns = (SELECT COUNT(*) FROM turns WHERE session_id = ?), n_segments = (SELECT COUNT(*) FROM dialogue_segments WHERE session_id = ?), last_seen_at = ? WHERE session_id = ?',
      )
      .run(
        this.sessionId,
        this.sessionId,
        new Date().toISOString(),
        this.sessionId,
      );
  }

  private failure(event: string, error: unknown): void {
    this.log(event, { kind: error instanceof Error ? error.name : 'unknown' });
  }
}
