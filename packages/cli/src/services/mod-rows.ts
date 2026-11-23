/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ModRenderInput,
  ModRenderSite,
} from '@qwen-code/qwen-code-core/mods/render-tree.js';
import { stableJson } from '@qwen-code/qwen-code-core/services/execution-environment.js';

/** Props to draw, undefined to keep the original, or null when skipped. */
export type ModRowRender = (
  input: ModRowInput,
  wanted: () => boolean,
) => Promise<ModRenderInput['props'] | undefined | null>;

/** Authorization from the host, never part of the Mod render event. */
export type ModRowInput = ModRenderInput & { translationAllowed?: boolean };

interface Row {
  input: ModRowInput;
  key: string;
  answerKey?: string;
  answer?: ModRenderInput['props'];
  // Its answer is drawn until the render asked for answers again.
  stale?: boolean;
  queued: boolean;
  readonly listeners: Set<() => void>;
  // Hear each render of the row end, whatever it answered.
  readonly settles: Set<(answered: boolean) => void>;
}

// Rows answered and no longer shown are kept for a remount up to this many.
const KEPT_ROWS = 1_000;

const rowId = (input: ModRowInput) =>
  `${input.component}\0${input.requestId}\0${input.translationAllowed !== false}`;

const rowKey = (input: ModRowInput) =>
  stableJson({ ...input, viewport: undefined });

/**
 * The transcript rows a terminal asks the Mods to draw. Each row renders once
 * per input, one at a time. Installed Mod hooks hold the session's other
 * Mod dispatches up behind at most one row.
 * A row no longer shown leaves the queue; its answer is kept for a remount.
 */
export class ModRows {
  private readonly rows = new Map<string, Row>();
  private readonly queue: string[] = [];
  private running = false;

  constructor(
    // Starts a task when no other row is rendering.
    private readonly schedule: (task: () => Promise<void>) => void,
    private readonly render: ModRowRender,
  ) {}

  /**
   * Shows a row: renders it unless its answer for this input is known, and
   * calls `listener` when the answer changes. Returns the release.
   */
  watch(input: ModRowInput, listener: () => void): () => void {
    const id = rowId(input);
    const key = rowKey(input);
    let row = this.rows.get(id);
    if (row) {
      this.rows.delete(id);
      row.input = input;
      row.key = key;
    } else
      row = {
        input,
        key,
        queued: false,
        listeners: new Set<() => void>(),
        settles: new Set(),
      };
    this.rows.set(id, row);
    row.listeners.add(listener);
    if (this.due(row)) this.enqueue(id, row);
    this.prune();
    return () => {
      row.listeners.delete(listener);
      if (!this.running) this.prune();
    };
  }

  /**
   * Shows a row until its hooks answered its input, for a client that asks
   * once: resolves to the answer, `props` absent where the row keeps its own,
   * or to none if the render failed or did not finish.
   */
  ask(
    input: ModRowInput,
    signal: AbortSignal,
  ): Promise<{ props?: ModRenderInput['props'] } | undefined> {
    const id = rowId(input);
    return new Promise((resolve) => {
      if (signal.aborted) return resolve(undefined);
      const release = this.watch(input, () => {});
      const row = this.rows.get(id)!;
      const finish = (answer?: { props?: ModRenderInput['props'] }) => {
        row.settles.delete(settled);
        signal.removeEventListener('abort', aborted);
        release();
        resolve(answer);
      };
      const answered = () => finish(row.answer ? { props: row.answer } : {});
      const settled = (completed: boolean) => {
        if (!completed) finish(undefined);
        else if (!this.due(row)) answered();
      };
      const aborted = () => finish(undefined);
      if (!this.due(row)) return answered();
      row.settles.add(settled);
      signal.addEventListener('abort', aborted, { once: true });
    });
  }

  /** The props a row draws with, once its hooks answered its input. */
  get(input: ModRowInput): ModRenderInput['props'] | undefined {
    const row = this.rows.get(rowId(input));
    return row?.answer && row.answerKey === rowKey(input)
      ? row.answer
      : undefined;
  }

  /**
   * Renders a site's rows again: each row shown now, the others once shown.
   * A row draws its answer until the new one arrives.
   */
  invalidate(component: ModRenderSite): void {
    for (const [id, row] of this.rows) {
      if (row.input.component !== component) continue;
      row.stale = true;
      if (row.listeners.size) this.enqueue(id, row);
    }
  }

  /** Drops the previous session's rows and their queued renders. */
  clear(): void {
    const rows = [...this.rows.values()];
    this.rows.clear();
    this.queue.length = 0;
    for (const row of rows) {
      for (const settled of [...row.settles]) settled(false);
      if (row.answer) for (const listener of row.listeners) listener();
    }
  }

  private enqueue(id: string, row: Row): void {
    if (row.queued) return;
    row.queued = true;
    this.queue.push(id);
    this.pump();
  }

  private pump(): void {
    if (this.running) return;
    let id: string | undefined;
    let row: Row | undefined;
    while ((id = this.queue.shift()) !== undefined) {
      const next = this.rows.get(id);
      if (!next) continue;
      next.queued = false;
      if (next.listeners.size && this.due(next)) {
        row = next;
        break;
      }
    }
    this.prune();
    if (!row || id === undefined) return;
    const ready = row;
    const readyId = id;
    const wanted = () =>
      this.rows.get(readyId) === ready && ready.listeners.size > 0;
    this.running = true;
    this.schedule(async () => {
      try {
        // A row can be hidden or cleared while it waits.
        if (!wanted()) return;
        const { input, key } = ready;
        // An invalidate while it renders asks for this row once more.
        ready.stale = false;
        let result: Awaited<ReturnType<ModRowRender>>;
        try {
          result = await this.render(
            input,
            () => wanted() && ready.key === key,
          );
        } catch {
          result = null;
        }
        // A row cleared away while it rendered keeps no answer.
        if (this.rows.get(readyId) === ready) {
          if (
            result === null &&
            (input.surface === 'desktop' || !ready.listeners.size)
          ) {
            // The next client request can retry, including after invalidation.
            ready.stale = true;
            for (const settled of [...ready.settles]) settled(false);
            return;
          }
          const answer = result ?? undefined;
          const changed = ready.answer !== answer;
          ready.answer = answer;
          ready.answerKey = key;
          if (this.due(ready) && ready.listeners.size)
            this.enqueue(readyId, ready);
          for (const settled of [...ready.settles]) settled(true);
          if (changed) for (const listener of ready.listeners) listener();
        }
      } finally {
        // The next row is queued even when a listener threw.
        this.running = false;
        this.pump();
      }
    });
  }

  private due(row: Row): boolean {
    return row.stale === true || row.answerKey !== row.key;
  }

  private prune(): void {
    if (this.rows.size <= KEPT_ROWS) return;
    for (const [id, row] of this.rows) {
      if (this.rows.size <= KEPT_ROWS) break;
      if (!row.listeners.size && !row.queued) this.rows.delete(id);
    }
  }
}
