/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { stripControlSequences, tailSlice } from '../adaptor/adaptor-utils.js';
import {
  MAX_SUBAGENT_TASKS,
  MAX_SUBAGENTS_SNAPSHOT_BYTES,
  type SubagentActivity,
  type SubagentStatus,
  type SubagentTask,
  type SubagentsSnapshot,
} from './types.js';

const TERMINAL = new Set<SubagentStatus>([
  'completed',
  'failed',
  'cancelled',
  'interrupted',
]);
const OUTPUT_CHARS = 16_384;

function clean(value: string, max: number): string {
  const text = stripControlSequences(value);
  return text.length > max ? tailSlice(text, max) : text;
}

export class SubagentsLedger {
  private readonly states = new Map<string, SubagentStatus>();
  private readonly monitors = new Set<string>();
  private readonly details = new Map<string, SubagentTask>();
  private revision = 0;
  private readonly archived: SubagentsSnapshot['counts'] = {
    running: 0,
    completed: 0,
    needsAttention: 0,
    failed: 0,
    cancelled: 0,
    interrupted: 0,
  };
  private archivedCount = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(
    private readonly onChange?: (snapshot: SubagentsSnapshot) => void,
  ) {}

  upsert(
    value: Omit<SubagentTask, 'activity' | 'output' | 'events'> &
      Partial<Pick<SubagentTask, 'activity' | 'output' | 'events'>>,
  ): void {
    if (this.closed) return;
    const previous = this.details.get(value.id);
    const previousState = this.states.get(value.id);
    // Every producer registers an active task before its terminal transition.
    // A terminal-only replay after detail eviction must not count it again.
    if (!previousState && TERMINAL.has(value.status)) return;
    if (
      previousState &&
      previousState !== value.status &&
      TERMINAL.has(previousState) &&
      (previousState !== 'interrupted' || !TERMINAL.has(value.status))
    )
      return;
    const task: SubagentTask = {
      activity: '',
      output: '',
      events: [],
      ...previous,
      ...value,
      title: clean(value.title, 240),
      request: clean(value.request, 4096),
    };
    if (task.backend) task.backend = clean(task.backend, 256);
    if (task.sessionId) task.sessionId = clean(task.sessionId, 256);
    if (task.source) task.source = clean(task.source, 256);
    task.activity = clean(task.activity, 1024);
    if (task.output.length > OUTPUT_CHARS) task.outputTruncated = true;
    task.output = clean(task.output, OUTPUT_CHARS);
    task.events = task.events.slice(-24).map((event) => ({
      ...event,
      text: clean(event.text, 1024),
    }));
    this.states.set(task.id, task.status);
    if (task.kind === 'proactive' && task.source !== 'timer')
      this.monitors.add(task.id);
    else this.monitors.delete(task.id);
    this.details.set(task.id, task);
    this.trimDetails();
    this.changed();
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        SubagentTask,
        | 'status'
        | 'activity'
        | 'notification'
        | 'pendingNotifications'
        | 'triggerCount'
        | 'remainingSec'
      >
    >,
    event?: Omit<SubagentActivity, 'at'>,
  ): void {
    if (this.closed || !this.states.has(id)) return;
    const previousState = this.states.get(id)!;
    if (
      patch.status &&
      previousState !== patch.status &&
      TERMINAL.has(previousState) &&
      (previousState !== 'interrupted' || !TERMINAL.has(patch.status))
    )
      return;
    if (patch.status) this.states.set(id, patch.status);
    const task = this.details.get(id);
    if (task) {
      Object.assign(task, patch, { updatedAt: Date.now() });
      if (patch.activity !== undefined)
        task.activity = clean(patch.activity, 1024);
      if (event) this.pushEvent(task, event);
    }
    if (!task) this.archiveTerminal(id);
    this.changed();
  }

  append(id: string, kind: SubagentActivity['kind'], text: string): void {
    if (this.closed) return;
    const task = this.details.get(id);
    if (!task || TERMINAL.has(task.status)) return;
    const safe = stripControlSequences(text);
    if (!safe) return;
    const combined =
      kind === 'message'
        ? task.output + safe
        : `${task.output}${task.output ? '\n' : ''}${safe}\n`;
    if (combined.length > OUTPUT_CHARS) task.outputTruncated = true;
    task.output = clean(combined, OUTPUT_CHARS);
    task.activity = clean(safe.trim(), 1024);
    task.updatedAt = Date.now();
    this.pushEvent(task, { kind, text: safe });
    this.changed();
  }

  result(id: string, status: SubagentStatus, text: string): void {
    const previous = this.states.get(id);
    if (
      this.closed ||
      (previous && TERMINAL.has(previous) && previous !== 'interrupted')
    )
      return;
    const task = this.details.get(id);
    if (task && text) {
      const safe = stripControlSequences(text);
      task.output = clean(safe, OUTPUT_CHARS);
      task.outputTruncated = safe.length > OUTPUT_CHARS;
    }
    this.update(id, { status, activity: text }, { kind: 'status', text });
  }

  snapshot(): SubagentsSnapshot {
    const counts: SubagentsSnapshot['counts'] = { ...this.archived };
    for (const [id, status] of this.states) {
      const completed =
        status === 'completed' ||
        (status === 'cancelled' && this.monitors.has(id));
      if (!TERMINAL.has(status)) counts.running += 1;
      if (completed) counts.completed += 1;
      if (status === 'failed') counts.failed += 1;
      if (status === 'cancelled' && !completed) counts.cancelled += 1;
      if (status === 'interrupted') counts.interrupted += 1;
      if (status === 'waiting') counts.needsAttention += 1;
    }
    const tasks = [...this.details.values()]
      .sort(
        (a, b) =>
          Number(TERMINAL.has(a.status)) - Number(TERMINAL.has(b.status)) ||
          b.updatedAt - a.updatedAt,
      )
      .map((task) => ({
        ...task,
        events: task.events.map((event) => ({ ...event })),
      }));
    const snapshot: SubagentsSnapshot = {
      revision: this.revision,
      counts,
      tasks,
      omitted: this.archivedCount + this.states.size - tasks.length,
    };
    // Trim terminal details before active ones; count every logical task even
    // when long Unicode/escaped output makes the retained view smaller.
    for (
      let index = tasks.length - 1;
      this.bytes(snapshot) > MAX_SUBAGENTS_SNAPSHOT_BYTES && index >= 0;
      index -= 1
    ) {
      const task = tasks[index]!;
      task.output = '';
      task.outputTruncated = true;
      task.events = [];
      task.request = clean(task.request, 512);
    }
    while (
      this.bytes(snapshot) > MAX_SUBAGENTS_SNAPSHOT_BYTES &&
      tasks.length
    ) {
      tasks.pop();
      snapshot.omitted += 1;
    }
    return snapshot;
  }

  dispose(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private pushEvent(
    task: SubagentTask,
    event: Omit<SubagentActivity, 'at'>,
  ): void {
    const text = clean(event.text, 1024);
    const last = task.events.at(-1);
    if (event.kind === 'message' && last?.kind === 'message') {
      last.text = clean(last.text + text, 1024);
      last.at = Date.now();
    } else if (last?.kind !== event.kind || last.text !== text) {
      task.events.push({ at: Date.now(), kind: event.kind, text });
      if (task.events.length > 24) task.events.shift();
    }
  }

  private trimDetails(): void {
    while (this.details.size > MAX_SUBAGENT_TASKS) {
      const sorted = [...this.details.values()].sort(
        (a, b) =>
          Number(TERMINAL.has(b.status)) - Number(TERMINAL.has(a.status)) ||
          a.updatedAt - b.updatedAt,
      );
      const removed = sorted[0]!;
      this.details.delete(removed.id);
      this.archiveTerminal(removed.id);
    }
  }

  private archiveTerminal(id: string): void {
    const state = this.states.get(id);
    if (!state || !TERMINAL.has(state)) return;
    const completed =
      state === 'completed' || (state === 'cancelled' && this.monitors.has(id));
    this.states.delete(id);
    this.monitors.delete(id);
    this.archivedCount += 1;
    if (completed) this.archived.completed += 1;
    if (state === 'failed') this.archived.failed += 1;
    if (state === 'cancelled' && !completed) this.archived.cancelled += 1;
    if (state === 'interrupted') this.archived.interrupted += 1;
  }

  private changed(): void {
    this.revision += 1;
    if (!this.onChange || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.closed) this.onChange?.(this.snapshot());
    }, 150);
    this.timer.unref?.();
  }

  private bytes(snapshot: SubagentsSnapshot): number {
    return Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
  }
}
