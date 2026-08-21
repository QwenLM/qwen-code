/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * History fold for the OpenTUI backend: reduces neutral stream events (the
 * `ui/model/streaming-model` union plus the local lossless extensions
 * `tool-args` / `tool-result` / `confirm` / `segment-end` / `image`) into
 * render-ready history items. Tool cards additionally carry args text and
 * the approval state (pending → approved/rejected).
 */

import type { HistoryItem } from '../model/streaming-model.js';
import type { OpenTuiStreamEvent } from './event-adapter.js';

export type ToolConfirmState = 'pending' | 'approved' | 'rejected';

export type LiveToolItem = Extract<HistoryItem, { kind: 'tool' }> & {
  args?: string;
  confirm?: ToolConfirmState;
  /** Structured FileDiff result: the card renders colored diff lines inline
   * (ink DiffResultRenderer parity) instead of the flattened output text. */
  diff?: { fileDiff: string; fileName: string };
};

export type LiveThinkingItem = Extract<HistoryItem, { kind: 'thinking' }> & {
  startedAt?: number;
  durationMs?: number;
};

/** Inline image returned by the model (content part `inlineData`). */
export type LiveImageItem = {
  kind: 'image';
  id: string;
  mimeType: string;
  data: string;
};

export type LiveHistoryItem =
  | Exclude<HistoryItem, { kind: 'tool' } | { kind: 'thinking' }>
  | LiveThinkingItem
  | LiveToolItem
  | LiveImageItem;

let uid = 0;
const nid = (p: string) => `${p}${++uid}`;

function findToolIndex(items: readonly LiveHistoryItem[], id: string): number {
  return items.findIndex((it) => it.kind === 'tool' && it.id === id);
}

/**
 * Pure fold: returns the next items array for one event (input is never
 * mutated). Unknown tool ids in delta events are ignored.
 */
export function foldLiveEvent(
  prev: readonly LiveHistoryItem[],
  ev: OpenTuiStreamEvent,
): LiveHistoryItem[] {
  const items = [...prev];
  const last = items[items.length - 1];

  switch (ev.type) {
    case 'user': {
      if (last?.kind === 'assistant' && last.streaming)
        items[items.length - 1] = { ...last, streaming: false };
      items.push({ kind: 'user', id: nid('u'), text: ev.text });
      return items;
    }
    case 'thinking': {
      if (last?.kind === 'thinking' && !last.done) {
        items[items.length - 1] = { ...last, text: last.text + ev.delta };
      } else {
        items.push({
          kind: 'thinking',
          id: nid('th'),
          text: ev.delta,
          done: false,
          startedAt: Date.now(),
        });
      }
      return items;
    }
    case 'thinking-end': {
      if (last?.kind === 'thinking')
        items[items.length - 1] = {
          ...last,
          done: true,
          durationMs: Date.now() - (last.startedAt ?? Date.now()),
        };
      return items;
    }
    case 'text': {
      if (last?.kind === 'assistant' && last.streaming) {
        items[items.length - 1] = { ...last, text: last.text + ev.delta };
      } else {
        items.push({
          kind: 'assistant',
          id: nid('as'),
          text: ev.delta,
          streaming: true,
        });
      }
      return items;
    }
    case 'tool-start': {
      const i = findToolIndex(items, ev.id);
      if (i >= 0) {
        // A confirmation card for this call already exists → approved.
        const t = items[i] as LiveToolItem;
        items[i] = {
          ...t,
          tool: ev.tool,
          title: ev.title,
          confirm: t.confirm === 'pending' ? 'approved' : t.confirm,
        };
        return items;
      }
      if (last?.kind === 'assistant' && last.streaming)
        items[items.length - 1] = { ...last, streaming: false };
      items.push({
        kind: 'tool',
        id: ev.id,
        tool: ev.tool,
        title: ev.title,
        output: '',
        done: false,
      });
      return items;
    }
    case 'tool-args': {
      const i = findToolIndex(items, ev.id);
      if (i >= 0) {
        const t = items[i] as LiveToolItem;
        items[i] = { ...t, args: ev.args };
      }
      return items;
    }
    case 'tool-output':
    case 'tool-result': {
      const i = findToolIndex(items, ev.id);
      if (i >= 0) {
        const t = items[i] as LiveToolItem;
        const delta = ev.type === 'tool-output' ? ev.delta : ev.display;
        const next: LiveToolItem = { ...t, output: t.output + delta };
        if (ev.type === 'tool-result' && ev.diff) next.diff = ev.diff;
        items[i] = next;
      }
      return items;
    }
    case 'tool-end': {
      const i = findToolIndex(items, ev.id);
      if (i >= 0) {
        const t = items[i] as LiveToolItem;
        items[i] = {
          ...t,
          done: true,
          success: ev.success,
          summary: ev.summary,
        };
      }
      return items;
    }
    case 'confirm': {
      const i = findToolIndex(items, ev.id);
      if (i >= 0) {
        const t = items[i] as LiveToolItem;
        items[i] = { ...t, title: ev.title, confirm: 'pending' };
        return items;
      }
      if (last?.kind === 'assistant' && last.streaming)
        items[items.length - 1] = { ...last, streaming: false };
      items.push({
        kind: 'tool',
        id: ev.id,
        tool: ev.tool,
        title: ev.title,
        output: '',
        done: false,
        confirm: 'pending',
      });
      return items;
    }
    case 'task-start':
      if (last?.kind === 'assistant' && last.streaming)
        items[items.length - 1] = { ...last, streaming: false };
      items.push({
        kind: 'task',
        id: ev.id,
        name: ev.name,
        description: ev.description,
        progress: [],
        done: false,
      });
      return items;
    case 'task-progress': {
      const i = items.findIndex((it) => it.kind === 'task' && it.id === ev.id);
      if (i >= 0 && items[i].kind === 'task') {
        const t = items[i] as Extract<HistoryItem, { kind: 'task' }>;
        items[i] = { ...t, progress: [...t.progress.slice(-2), ev.line] };
      }
      return items;
    }
    case 'task-end': {
      const i = items.findIndex((it) => it.kind === 'task' && it.id === ev.id);
      if (i >= 0 && items[i].kind === 'task') {
        const t = items[i] as Extract<HistoryItem, { kind: 'task' }>;
        items[i] = {
          ...t,
          done: true,
          stats: `${ev.tools} tools · ${ev.seconds}s · ${ev.tokens} tokens`,
        };
      }
      return items;
    }
    case 'image': {
      if (last?.kind === 'assistant' && last.streaming)
        items[items.length - 1] = { ...last, streaming: false };
      items.push({
        kind: 'image',
        id: nid('img'),
        mimeType: ev.mimeType,
        data: ev.data,
      });
      return items;
    }
    case 'segment-end': {
      // Close the streaming assistant block only — tools keep running and
      // the turn stays in flight (`done` is the sole turn-end event).
      if (last?.kind === 'assistant' && last.streaming)
        items[items.length - 1] = { ...last, streaming: false };
      return items;
    }
    case 'done': {
      if (last?.kind === 'assistant' && last.streaming)
        items[items.length - 1] = { ...last, streaming: false };
      return settleOpenTools(items, 'skipped');
    }
    default:
      return items;
  }
}

/**
 * Closes anything still open: running tools and unresolved approvals cannot
 * outlive the stream that produced them (turn end, Esc interrupt, error).
 */
export function settleOpenTools(
  prev: LiveHistoryItem[],
  summary: string,
): LiveHistoryItem[] {
  let changed = false;
  const items = prev.map((it): LiveHistoryItem => {
    if (it.kind !== 'tool') return it;
    const t = it as LiveToolItem;
    if (t.done && t.confirm !== 'pending') return it;
    changed = true;
    return {
      ...t,
      done: true,
      success: t.success ?? false,
      summary: t.summary ?? summary,
      confirm: t.confirm === 'pending' ? 'rejected' : t.confirm,
    };
  });
  return changed ? items : prev;
}

export type LivePhase =
  | 'idle'
  | 'thinking'
  | 'tool'
  | 'approving'
  | 'responding';

/** Streaming phase exposed to the status bar / spinner / border. */
export function livePhase(
  items: readonly LiveHistoryItem[],
  streaming: boolean,
): LivePhase {
  if (!streaming) return 'idle';
  const last = items[items.length - 1];
  if (last?.kind === 'thinking' && !last.done) return 'thinking';
  if (last?.kind === 'tool' && !last.done)
    return last.confirm === 'pending' ? 'approving' : 'tool';
  if (last?.kind === 'task' && !last.done) return 'tool';
  return 'responding';
}
