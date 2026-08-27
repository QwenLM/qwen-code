/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Framework-neutral streaming state machine: folds agent-loop stream events
 * into render-ready history items. Extracted from the OpenTUI POC's applyEvent
 * reducer so any renderer binding (ink today, OpenTUI tomorrow) shares one
 * source of truth for history.
 *
 * This module must not import react / solid / ink / @opentui — the rule is
 * enforced by `scripts/check-tui-dep-direction.mjs` (wired into CI via
 * `npm run check:tui-dep-direction`).
 */

export type StreamEvent =
  | {
      type: 'user';
      text: string;
      /** Stable turn key (`sessionId########promptCount`) — file checkpoints
       * are keyed by it, so /rewind needs it on the user item. */
      promptId?: string;
      /** False when the echoed command was handled locally (never sent). */
      sentToModel?: boolean;
    }
  | { type: 'thinking'; delta: string }
  | { type: 'thinking-end' }
  | { type: 'text'; delta: string }
  | { type: 'tool-start'; id: string; tool: string; title: string }
  | { type: 'tool-output'; id: string; delta: string }
  | { type: 'tool-end'; id: string; success: boolean; summary: string }
  | { type: 'task-start'; id: string; name: string; description: string }
  | { type: 'task-progress'; id: string; line: string }
  | {
      type: 'task-end';
      id: string;
      tools: number;
      seconds: number;
      tokens: string;
    }
  | { type: 'done' };

export type HistoryItem =
  | {
      kind: 'user';
      id: string;
      text: string;
      promptId?: string;
      sentToModel?: boolean;
    }
  | { kind: 'thinking'; id: string; text: string; done: boolean }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean }
  | {
      kind: 'tool';
      id: string;
      tool: string;
      title: string;
      output: string;
      done: boolean;
      success?: boolean;
      summary?: string;
    }
  | {
      kind: 'task';
      id: string;
      name: string;
      description: string;
      progress: string[];
      done: boolean;
      stats?: string;
    };

/**
 * Fold state of the streamed history. Named distinctly from the UI
 * lifecycle enum `StreamingState` (ui/types.ts) — this one tracks history
 * items, that one tracks Idle/Responding/WaitingForConfirmation.
 */
export interface StreamingModelState {
  readonly items: readonly HistoryItem[];
  readonly streaming: boolean;
  readonly done: boolean;
  /** Bookkeeping: id source for items whose events carry no id. */
  readonly nextSeq: number;
}

export const initialStreamingModelState: StreamingModelState = {
  items: [],
  streaming: false,
  done: false,
  nextSeq: 0,
};

const TASK_PROGRESS_TAIL = 3;

function findItemIndex(
  items: readonly HistoryItem[],
  kind: 'tool' | 'task',
  id: string,
): number {
  return items.findIndex((item) => item.kind === kind && item.id === id);
}

/**
 * Pure reducer: apply one stream event to the history state.
 * Never mutates the input state.
 */
export function reduceStreamEvent(
  state: StreamingModelState,
  event: StreamEvent,
): StreamingModelState {
  const items = [...state.items];
  const last = items[items.length - 1];
  let nextSeq = state.nextSeq;

  const closeTrailingAssistant = () => {
    if (last?.kind === 'assistant' && last.streaming) {
      items[items.length - 1] = { ...last, streaming: false };
    }
  };

  switch (event.type) {
    case 'user': {
      closeTrailingAssistant();
      items.push({
        kind: 'user',
        id: `user-${nextSeq++}`,
        text: event.text,
        promptId: event.promptId,
        sentToModel: event.sentToModel,
      });
      break;
    }
    case 'thinking': {
      if (last?.kind === 'thinking' && !last.done) {
        items[items.length - 1] = { ...last, text: last.text + event.delta };
      } else {
        items.push({
          kind: 'thinking',
          id: `thinking-${nextSeq++}`,
          text: event.delta,
          done: false,
        });
      }
      break;
    }
    case 'thinking-end': {
      if (last?.kind === 'thinking') {
        items[items.length - 1] = { ...last, done: true };
      }
      break;
    }
    case 'text': {
      if (last?.kind === 'assistant' && last.streaming) {
        items[items.length - 1] = { ...last, text: last.text + event.delta };
      } else {
        items.push({
          kind: 'assistant',
          id: `assistant-${nextSeq++}`,
          text: event.delta,
          streaming: true,
        });
      }
      break;
    }
    case 'tool-start': {
      closeTrailingAssistant();
      items.push({
        kind: 'tool',
        id: event.id,
        tool: event.tool,
        title: event.title,
        output: '',
        done: false,
      });
      break;
    }
    case 'tool-output': {
      const index = findItemIndex(items, 'tool', event.id);
      if (index >= 0) {
        const tool = items[index] as Extract<HistoryItem, { kind: 'tool' }>;
        items[index] = { ...tool, output: tool.output + event.delta };
      }
      break;
    }
    case 'tool-end': {
      const index = findItemIndex(items, 'tool', event.id);
      if (index >= 0) {
        const tool = items[index] as Extract<HistoryItem, { kind: 'tool' }>;
        items[index] = {
          ...tool,
          done: true,
          success: event.success,
          summary: event.summary,
        };
      }
      break;
    }
    case 'task-start': {
      closeTrailingAssistant();
      items.push({
        kind: 'task',
        id: event.id,
        name: event.name,
        description: event.description,
        progress: [],
        done: false,
      });
      break;
    }
    case 'task-progress': {
      const index = findItemIndex(items, 'task', event.id);
      if (index >= 0) {
        const task = items[index] as Extract<HistoryItem, { kind: 'task' }>;
        items[index] = {
          ...task,
          progress: [
            ...task.progress.slice(-(TASK_PROGRESS_TAIL - 1)),
            event.line,
          ],
        };
      }
      break;
    }
    case 'task-end': {
      const index = findItemIndex(items, 'task', event.id);
      if (index >= 0) {
        const task = items[index] as Extract<HistoryItem, { kind: 'task' }>;
        items[index] = {
          ...task,
          done: true,
          stats: `${event.tools} tools · ${event.seconds}s · ${event.tokens} tokens`,
        };
      }
      break;
    }
    case 'done': {
      closeTrailingAssistant();
      break;
    }
    default: {
      // Exhaustiveness guard: a new StreamEvent variant without a reducer
      // case must fail compilation, not silently drop from history.
      const unhandled: never = event;
      throw new Error(
        `unhandled stream event: ${(unhandled as { type: string }).type}`,
      );
    }
  }

  return {
    items,
    streaming: event.type !== 'done',
    done: event.type === 'done',
    nextSeq,
  };
}

/** Fold a sequence of events over a starting state. */
export function reduceStreamEvents(
  state: StreamingModelState,
  events: readonly StreamEvent[],
): StreamingModelState {
  return events.reduce(reduceStreamEvent, state);
}

export function selectItems(
  state: StreamingModelState,
): readonly HistoryItem[] {
  return state.items;
}

export function selectIsStreaming(state: StreamingModelState): boolean {
  return state.streaming;
}

export function selectIsDone(state: StreamingModelState): boolean {
  return state.done;
}

export function selectItemById(
  state: StreamingModelState,
  id: string,
): HistoryItem | undefined {
  return state.items.find((item) => item.id === id);
}
