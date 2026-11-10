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

/** Runs a row's `ui.render` chain: the props to draw, or none to keep its own. */
export type ModRowRender = (
  input: ModRenderInput,
) => Promise<ModRenderInput['props'] | undefined>;

interface Row {
  input: ModRenderInput;
  key: string;
  answerKey?: string;
  answer?: ModRenderInput['props'];
  // Its answer is drawn until the render asked for answers again.
  stale?: boolean;
  queued: boolean;
  readonly listeners: Set<() => void>;
}

// Rows answered and no longer shown are kept for a remount up to this many.
const KEPT_ROWS = 1_000;

const rowId = (component: string, requestId: string) =>
  `${component}\0${requestId}`;

/**
 * The transcript rows a terminal asks the Mods to draw. Each row renders once
 * per input, one at a time, so a slow hook holds the session's other Mod
 * dispatches up behind one row, never behind every row waiting to be drawn.
 * A row no longer shown leaves the queue; its answer is kept for a remount.
 */
export class ModRows {
  private readonly rows = new Map<string, Row>();
  private readonly queue: string[] = [];
  private running = false;

  constructor(
    // Runs a task in the session's dispatch queue.
    private readonly schedule: (task: () => Promise<void>) => void,
    private readonly render: ModRowRender,
  ) {}

  /**
   * Shows a row: renders it unless its answer for this input is known, and
   * calls `listener` when the answer changes. Returns the release.
   */
  watch(input: ModRenderInput, listener: () => void): () => void {
    const id = rowId(input.component, input.requestId);
    const key = stableJson({ ...input, viewport: undefined });
    let row = this.rows.get(id);
    if (row) {
      this.rows.delete(id);
      row.input = input;
      row.key = key;
    } else
      row = { input, key, queued: false, listeners: new Set<() => void>() };
    this.rows.set(id, row);
    row.listeners.add(listener);
    if (this.due(row)) this.enqueue(id, row);
    this.prune();
    return () => {
      row.listeners.delete(listener);
    };
  }

  /** The props a row draws with, once its hooks answered its input. */
  get(
    component: ModRenderSite,
    requestId: string,
  ): ModRenderInput['props'] | undefined {
    const row = this.rows.get(rowId(component, requestId));
    return row && row.answerKey === row.key ? row.answer : undefined;
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

  /**
   * Forgets every answer: they belonged to a session that ended. A row still
   * shown, as after a branch, renders again for the session that follows.
   */
  clear(): void {
    const rows = [...this.rows];
    this.rows.clear();
    this.queue.length = 0;
    for (const [id, old] of rows) {
      if (!old.listeners.size) continue;
      // A fresh row, so a render of the old session in flight keeps no answer.
      const row: Row = {
        input: old.input,
        key: old.key,
        queued: false,
        listeners: old.listeners,
      };
      this.rows.set(id, row);
      this.enqueue(id, row);
      if (old.answer) for (const listener of row.listeners) listener();
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
    if (!row || id === undefined) return;
    const ready = row;
    const readyId = id;
    this.running = true;
    this.schedule(async () => {
      const { input, key } = ready;
      // An invalidate while it renders asks for this row once more.
      ready.stale = false;
      try {
        let answer: ModRenderInput['props'] | undefined;
        try {
          answer = await this.render(input);
        } catch {
          answer = undefined;
        }
        // A row cleared away while it rendered keeps no answer.
        if (this.rows.get(readyId) === ready) {
          const changed = ready.answer !== answer;
          ready.answer = answer;
          ready.answerKey = key;
          if (this.due(ready) && ready.listeners.size)
            this.enqueue(readyId, ready);
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
