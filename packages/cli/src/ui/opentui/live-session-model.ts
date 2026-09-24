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
import type {
  GoalSnapshotLike,
  OpenTuiStreamEvent,
  SubagentSummary,
} from './event-adapter.js';
import type { TodoItem } from '../components/TodoDisplay.js';
import type { GoalLegacyCardData } from '../utils/goal-card-view.js';
import type { AnsiToken } from '@qwen-code/qwen-code-core';
import type { ArenaAgentCardData, CompressionProps } from '../types.js';

export type ToolConfirmState = 'pending' | 'approved' | 'rejected';

export type LiveToolItem = Extract<HistoryItem, { kind: 'tool' }> & {
  args?: string;
  /** Real invocation description (scheduler's getDescription, ink
   * mapToDisplay parity) — takes precedence over the args-based fallback. */
  description?: string;
  confirm?: ToolConfirmState;
  /** The scheduler reports the call as 'scheduled' — approved, but not
   * started because the batch still holds another approval. ink reads the
   * same status and draws its pending glyph instead of the executing one. */
  queued?: boolean;
  /** Structured FileDiff result: the card renders colored diff lines inline
   * (ink DiffResultRenderer parity) instead of the flattened output text. */
  diff?: { fileDiff: string; fileName: string };
  /** Structured TodoWrite result: the card renders the status-icon list
   * (ink TodoDisplay parity) instead of the flattened output text. */
  todos?: TodoItem[];
  /** Structured AnsiOutputDisplay result: the card renders the styled token
   * grid (ink AnsiOutputText parity) instead of the color-stripped output. */
  ansi?: {
    grid: AnsiToken[][];
    totalLines?: number;
    totalBytes?: number;
  };
  /** Structured subagent summary: the card renders ink's three coloured runs
   * (SubagentScrollbackSummary parity) instead of the flattened output. */
  subagentSummary?: SubagentSummary;
  /** Vision-bridge egress disclosure (ink ToolMessage renders the notice
   * under the result): tells the user their image/prompt left the machine
   * via the vision model. */
  visionBridgeNotice?: string;
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

/** Compression history row (ink HistoryItemCompression + CompressionMessage). */
export type LiveCompactionItem = {
  kind: 'compaction';
  id: string;
  compression: CompressionProps;
};

/** Info notice row (ink HistoryItemInfo + InfoMessage: `●` + primary text). */
export type LiveInfoItem = {
  kind: 'info';
  id: string;
  text: string;
};

/** Error notice row (ink HistoryItemError + ErrorMessage: `✕` + error color,
 * optional inline hint). */
export type LiveErrorItem = {
  kind: 'error';
  id: string;
  text: string;
  hint?: string;
};

/** Warning block (ink user_prompt_submit_blocked: no prefix, warning color). */
export type LiveWarningItem = {
  kind: 'warning';
  id: string;
  text: string;
};

/** Retry countdown (ink startRetryCountdown): two rows — the retry error
 * line (with the short-format countdown hint) and the `↻` countdown — both
 * recomputed from `startedAt`/`delayMs` every second until the delay
 * elapses. */
export type LiveRetryItem = {
  kind: 'retry';
  id: string;
  attempt: number;
  maxRetries: number;
  delayMs: number;
  startedAt: number;
  message?: string;
  /** Resolves the core delay promise early (ink skipRetryDelayRef). */
  skipDelay?: () => void;
  /** Continuation retries keep the failed attempt's streamed content. */
  isContinuation?: boolean;
};

/** Stop-hook system message (ink stop_hook_system_message:
 * `⎿ Stop says:` header + indented markdown body). */
export type LiveStopHookItem = {
  kind: 'stop-hook';
  id: string;
  message: string;
};

/** Away-summary recap (ink away_recap → AwayRecapMessage). */
export type LiveAwayRecapItem = {
  kind: 'away-recap';
  id: string;
  text: string;
};

/** User `!`-shell command row (ink user_shell → UserShellMessage). */
export type LiveUserShellItem = {
  kind: 'user-shell';
  id: string;
  text: string;
};

/** Advisor review card (ink advisor → AdvisorMessage). */
export type LiveAdvisorItem = {
  kind: 'advisor';
  id: string;
  text: string;
  model: string;
};

/** Arena agent card (ink arena_agent_complete → ArenaAgentCard). */
export type LiveArenaAgentItem = {
  kind: 'arena-agent';
  id: string;
  agent: ArenaAgentCardData;
};

/** Arena session summary card (ink arena_session_complete →
 * ArenaSessionCard). */
export type LiveArenaSessionItem = {
  kind: 'arena-session';
  id: string;
  sessionStatus: string;
  task: string;
  totalDurationMs: number;
  agents: ArenaAgentCardData[];
};

/** Goal lifecycle card (ink goal_state → GoalStatusMessage/GoalStateCard).
 * `snapshot` is the v2 stream form; `legacy` is the /goal command's
 * goal_status kind form — both render through the describe* helpers. */
export type LiveGoalItem = {
  kind: 'goal';
  id: string;
  snapshot?: GoalSnapshotLike;
  cause?: string;
  legacy?: LiveGoalLegacyData;
};

/** Fields of an ink goal_status history item (kind form). */
export type LiveGoalLegacyData = GoalLegacyCardData;

export type LiveAssistantItem = Extract<HistoryItem, { kind: 'assistant' }> & {
  /** When the block opened: the record's own time on a resume replay, the fold
   * time live. Rendered by `output.showTimestamps`. */
  timestamp?: number;
};

export type LiveHistoryItem =
  | Exclude<
      HistoryItem,
      { kind: 'tool' } | { kind: 'thinking' } | { kind: 'assistant' }
    >
  | LiveAssistantItem
  | LiveThinkingItem
  | LiveToolItem
  | LiveImageItem
  | LiveCompactionItem
  | LiveInfoItem
  | LiveErrorItem
  | LiveWarningItem
  | LiveRetryItem
  | LiveStopHookItem
  | LiveAwayRecapItem
  | LiveUserShellItem
  | LiveAdvisorItem
  | LiveArenaAgentItem
  | LiveArenaSessionItem
  | LiveGoalItem;

let uid = 0;
const nid = (p: string) => `${p}${++uid}`;

function findToolIndex(items: readonly LiveHistoryItem[], id: string): number {
  return items.findIndex((it) => it.kind === 'tool' && it.id === id);
}

/**
 * Pure fold: returns the next items array for one event (input is never
 * mutated). Unknown tool ids are ignored.
 */
export function foldLiveEvent(
  prev: readonly LiveHistoryItem[],
  ev: OpenTuiStreamEvent,
): readonly LiveHistoryItem[] {
  const items = [...prev];
  const last = items[items.length - 1];

  switch (ev.type) {
    case 'user': {
      // Both `addItem` implementations collapse a user item identical to the
      // one before it, and this is the chokepoint the projected and live
      // echoes share: two identical steers in a row are one row.
      if (last?.kind === 'user' && last.text === ev.text) return prev;
      if (last?.kind === 'assistant' && last.streaming)
        items[items.length - 1] = { ...last, streaming: false };
      items.push({
        kind: 'user',
        id: nid('u'),
        text: ev.text,
        promptId: ev.promptId,
        sentToModel: ev.sentToModel,
      });
      return items;
    }
    case 'thinking': {
      if (last?.kind === 'thinking' && !last.done) {
        items[items.length - 1] = { ...last, text: last.text + ev.delta };
      } else {
        // A second thought burst after streamed content (the adapter resets
        // thoughtClosed for exactly this interleaving) settles the trailing
        // streaming assistant like every other push branch — `done` only
        // settles the last item, so the earlier block would stream forever.
        if (last?.kind === 'assistant' && last.streaming)
          items[items.length - 1] = { ...last, streaming: false };
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
          timestamp: ev.timestamp ?? Date.now(),
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
    case 'tool-description': {
      const i = findToolIndex(items, ev.id);
      if (i >= 0) {
        const t = items[i] as LiveToolItem;
        items[i] = { ...t, description: ev.description };
      }
      return items;
    }
    case 'tool-output':
    case 'tool-result': {
      const i = findToolIndex(items, ev.id);
      if (i >= 0) {
        const t = items[i] as LiveToolItem;
        const structured = ev.type === 'tool-result' ? ev : undefined;
        // Both events carry the whole display, so the card replaces rather than
        // accumulates — appending would paint the streamed snapshot twice. The
        // structured payloads replace for the same reason, and clearing them
        // matters: ToolCardBody prefers them over the text unconditionally, so
        // a shell run that streams ANSI and then trips binary detection would
        // otherwise freeze on the stale grid and never show the plain-text
        // notice that replaced it.
        const next: LiveToolItem = {
          ...t,
          output: ev.type === 'tool-output' ? ev.output : ev.display,
          diff: structured?.diff,
          todos: structured?.todos,
          ansi: structured?.ansi,
          subagentSummary: structured?.subagentSummary,
        };
        if (ev.type === 'tool-result' && ev.visionBridgeNotice) {
          next.visionBridgeNotice = ev.visionBridgeNotice;
        }
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
    case 'confirm-resolved': {
      const i = findToolIndex(items, ev.id);
      if (i >= 0) {
        const t = items[i] as LiveToolItem;
        // Every resolution clears 'pending' (transcript-view gates the
        // awaiting marker on it); the outcome only picks the recorded state.
        if (t.confirm === 'pending') {
          items[i] = { ...t, confirm: ev.outcome };
        }
      }
      return items;
    }
    case 'tool-queued': {
      const i = findToolIndex(items, ev.id);
      if (i >= 0) {
        const t = items[i] as LiveToolItem;
        items[i] = { ...t, queued: ev.queued };
      }
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
      // ink drops the roster row the moment a subagent turns terminal; the
      // tool card's own one-line summary is the only record left, so keeping
      // this card would print the same stats twice.
      const i = items.findIndex((it) => it.kind === 'task' && it.id === ev.id);
      if (i >= 0) items.splice(i, 1);
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
    case 'compaction': {
      items.push({
        kind: 'compaction',
        id: nid('cmp'),
        compression: ev.compression,
      });
      return items;
    }
    case 'info': {
      // ink parity: handleChatCompressionEvent flushes the buffered stream
      // content before addItem — settle a still-streaming assistant block.
      if (last?.kind === 'assistant' && last.streaming)
        items[items.length - 1] = { ...last, streaming: false };
      items.push({ kind: 'info', id: nid('info'), text: ev.text });
      return items;
    }
    case 'error': {
      // ink handleErrorEvent clears the retry countdown before showing the
      // error item.
      if (last?.kind === 'retry') items.pop();
      const afterRetry = items[items.length - 1];
      if (afterRetry?.kind === 'assistant' && afterRetry.streaming)
        items[items.length - 1] = { ...afterRetry, streaming: false };
      items.push({
        kind: 'error',
        id: nid('err'),
        text: ev.text,
        hint: ev.hint,
      });
      return items;
    }
    case 'warning': {
      if (last?.kind === 'assistant' && last.streaming)
        items[items.length - 1] = { ...last, streaming: false };
      items.push({ kind: 'warning', id: nid('warn'), text: ev.text });
      return items;
    }
    case 'retry-countdown': {
      // ink parity: a fresh (non-continuation) retry discards the failed
      // attempt's pending content (discardBufferedStreamEvents +
      // setPendingAssistantItems([])); a continuation keeps it and appends.
      if (!ev.isContinuation) {
        while (items.length > 0) {
          const tail = items[items.length - 1];
          if (tail?.kind === 'assistant' && tail.streaming) {
            items.pop();
            continue;
          }
          if (tail?.kind === 'tool' && !tail.done) {
            items.pop();
            continue;
          }
          break;
        }
      }
      // ink parity: startRetryCountdown overwrites the pending error item,
      // so the countdown's own error row supersedes a just-pushed error.
      if (items[items.length - 1]?.kind === 'error') items.pop();
      // ink startRetryCountdown restarts the countdown in place; the two
      // rows recompute from startedAt/delayMs on every render.
      const retryLast = items[items.length - 1];
      if (retryLast?.kind === 'retry') {
        items[items.length - 1] = {
          ...retryLast,
          attempt: ev.attempt,
          maxRetries: ev.maxRetries,
          delayMs: ev.delayMs,
          message: ev.message,
          skipDelay: ev.skipDelay,
          isContinuation: ev.isContinuation,
          startedAt: Date.now(),
        };
        return items;
      }
      if (retryLast?.kind === 'assistant' && retryLast.streaming)
        items[items.length - 1] = { ...retryLast, streaming: false };
      items.push({
        kind: 'retry',
        id: nid('rtry'),
        attempt: ev.attempt,
        maxRetries: ev.maxRetries,
        delayMs: ev.delayMs,
        message: ev.message,
        skipDelay: ev.skipDelay,
        isContinuation: ev.isContinuation,
        startedAt: Date.now(),
      });
      return items;
    }
    case 'retry-countdown-clear': {
      // ink clearRetryCountdown: the retry attempt is starting now, so any
      // prior retry UI is stale.
      if (last?.kind === 'retry') items.pop();
      return items;
    }
    case 'goal':
    case 'goal-legacy': {
      if (last?.kind === 'assistant' && last.streaming)
        items[items.length - 1] = { ...last, streaming: false };
      items.push(
        ev.type === 'goal'
          ? {
              kind: 'goal',
              id: nid('goal'),
              snapshot: ev.snapshot,
              cause: ev.cause,
            }
          : {
              kind: 'goal',
              id: nid('goal'),
              legacy: {
                kind: ev.kind,
                condition: ev.condition,
                iterations: ev.iterations,
                durationMs: ev.durationMs,
                lastReason: ev.lastReason,
              },
            },
      );
      return items;
    }
    case 'stop-hook-message': {
      if (last?.kind === 'assistant' && last.streaming)
        items[items.length - 1] = { ...last, streaming: false };
      items.push({ kind: 'stop-hook', id: nid('shk'), message: ev.message });
      return items;
    }
    case 'away-recap': {
      if (last?.kind === 'assistant' && last.streaming)
        items[items.length - 1] = { ...last, streaming: false };
      items.push({ kind: 'away-recap', id: nid('recap'), text: ev.text });
      return items;
    }
    case 'user-shell': {
      if (last?.kind === 'assistant' && last.streaming)
        items[items.length - 1] = { ...last, streaming: false };
      items.push({ kind: 'user-shell', id: nid('ushl'), text: ev.text });
      return items;
    }
    case 'advisor': {
      if (last?.kind === 'assistant' && last.streaming)
        items[items.length - 1] = { ...last, streaming: false };
      items.push({
        kind: 'advisor',
        id: nid('advisor'),
        text: ev.text,
        model: ev.model,
      });
      return items;
    }
    case 'arena-agent': {
      if (last?.kind === 'assistant' && last.streaming)
        items[items.length - 1] = { ...last, streaming: false };
      items.push({ kind: 'arena-agent', id: nid('arena'), agent: ev.agent });
      return items;
    }
    case 'arena-session': {
      if (last?.kind === 'assistant' && last.streaming)
        items[items.length - 1] = { ...last, streaming: false };
      items.push({
        kind: 'arena-session',
        id: nid('arena'),
        sessionStatus: ev.sessionStatus,
        task: ev.task,
        totalDurationMs: ev.totalDurationMs,
        agents: ev.agents,
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
      // ink clears the retry countdown UI when the stream ends.
      if (last?.kind === 'retry') items.pop();
      const afterRetry = items[items.length - 1];
      if (afterRetry?.kind === 'assistant' && afterRetry.streaming)
        items[items.length - 1] = { ...afterRetry, streaming: false };
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

export {
  describeGoalCard,
  describeLegacyGoalCard,
  type GoalCardColor,
  type GoalCardView,
  type LegacyGoalCardView,
} from '../utils/goal-card-view.js';
