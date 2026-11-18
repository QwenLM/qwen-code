/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createContext,
  useEffect,
  useReducer,
  useState,
  type RefObject,
} from 'react';
import type { DaemonModRow, DaemonModRowAnswer } from '@qwen-code/sdk/daemon';
import type { Message } from '../../adapters/types.js';

/** Asks a session's Mods for one row this client draws. */
export type ModRowAsk = (row: DaemonModRow) => Promise<DaemonModRowAnswer>;

// Answers kept for rows scrolled away and back, per session.
const KEPT_ANSWERS = 500;
const rowKey = (row: DaemonModRow) =>
  `${row.component}\0${JSON.stringify(row.props)}`;

/**
 * The Mod rows of one session that this client draws. A row is asked once
 * per props, one ask at a time, since the session's Mods render one row at a
 * time anyway. A row that is no longer shown leaves the queue before it is
 * asked. An ask that fails or goes unanswered is not kept, so the row is
 * asked again the next time it is shown.
 */
export class ModRowAsker {
  private readonly answers = new Map<string, Record<string, unknown> | null>();
  private readonly unhooked = new Set<string>();
  private readonly waiting = new Map<
    string,
    { row: DaemonModRow; listeners: Set<() => void> }
  >();
  private asking = false;

  constructor(private readonly ask: ModRowAsk) {}

  /**
   * The props a row draws with: those its hooks rewrote, null to draw its
   * own, or undefined while it is not answered.
   */
  answer(row: DaemonModRow): Record<string, unknown> | null | undefined {
    return this.answers.get(rowKey(row));
  }

  /**
   * Shows a row until it is answered, calling `listener` once its answer is
   * known. Returns the release.
   */
  watch(row: DaemonModRow, listener: () => void): () => void {
    const key = rowKey(row);
    if (this.unhooked.has(row.component) || this.answers.has(key))
      return () => {};
    let entry = this.waiting.get(key);
    if (!entry) {
      entry = { row, listeners: new Set() };
      this.waiting.set(key, entry);
    }
    const listeners = entry.listeners;
    listeners.add(listener);
    this.pump();
    return () => {
      listeners.delete(listener);
    };
  }

  private pump(): void {
    if (this.asking) return;
    for (const [key, entry] of this.waiting) {
      if (!entry.listeners.size) {
        this.waiting.delete(key);
        continue;
      }
      this.asking = true;
      void this.ask(entry.row)
        .then(
          (answer) => this.settle(key, entry, answer),
          () => this.settle(key, entry, { status: 'unanswered' }),
        )
        .finally(() => {
          this.asking = false;
          this.pump();
        });
      return;
    }
  }

  private settle(
    key: string,
    entry: { row: DaemonModRow; listeners: Set<() => void> },
    answer: DaemonModRowAnswer,
  ): void {
    this.waiting.delete(key);
    if (answer.status === 'unhooked') {
      this.unhooked.add(entry.row.component);
      for (const [other, waiting] of this.waiting)
        if (waiting.row.component === entry.row.component)
          this.waiting.delete(other);
      return;
    }
    if (answer.status !== 'answered') return;
    this.answers.delete(key);
    this.answers.set(key, answer.props ?? null);
    if (this.answers.size > KEPT_ANSWERS)
      this.answers.delete(this.answers.keys().next().value!);
    for (const listener of entry.listeners) listener();
  }
}

export const ModRowAskerContext = createContext<ModRowAsker | undefined>(
  undefined,
);

/** Reply blocks and whether they open the reply. Ephemeral logs and thinking
 * are skipped so a row keeps its identity when the transcript is replayed. */
export function modReplyRows(
  messages: readonly Message[],
): Map<string, boolean> {
  const rows = new Map<string, boolean>();
  let previousIsReply = false;
  for (const message of messages) {
    if (
      message.role === 'thinking' ||
      (message.role === 'system' && message.source === 'mod_log')
    )
      continue;
    const isReply =
      message.role === 'assistant' &&
      message.source === undefined &&
      message.agentMessage === undefined &&
      message.author === undefined &&
      message.localCommandId === undefined;
    if (isReply) rows.set(message.id, !previousIsReply);
    previousIsReply = isReply;
  }
  return rows;
}

/**
 * Whether the element intersects the viewport, watched only while `enabled`.
 * Without IntersectionObserver a mounted element counts as shown.
 */
export function useOnScreen(
  ref: RefObject<Element | null>,
  enabled: boolean,
): boolean {
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!enabled || !element) {
      setOnScreen(false);
      return;
    }
    if (typeof IntersectionObserver === 'undefined') {
      setOnScreen(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setOnScreen(entry.isIntersecting);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, enabled]);
  return enabled && onScreen;
}

/**
 * The props the session's Mods drew a row with, once answered: undefined
 * while `row` is unset, unanswered, or drawn as it is. The row is asked for
 * only while `shown`; its answer stays drawn after it scrolls away, so the
 * rows above the viewport keep their height.
 */
export function useModRow(
  asker: ModRowAsker | undefined,
  row: DaemonModRow | undefined,
  shown: boolean,
): Record<string, unknown> | undefined {
  const key = row ? rowKey(row) : undefined;
  const answer = asker && row ? asker.answer(row) : undefined;
  const [, redraw] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    if (!asker || !row || !shown) return;
    const release = asker.watch(row, redraw);
    // Answered for another view of the row since this one rendered.
    if (asker.answer(row) !== answer) redraw();
    return release;
    // The key stands for the row and its answer at render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asker, key, shown]);
  return answer ?? undefined;
}
