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
import { MAX_INLINE_IMAGES_PER_ITEM } from '../utils/inline-image-parts.js';
import { stripSuppressOnRestore } from '../utils/resumeHistoryUtils.js';
import { isSyntheticHistoryItem } from '../utils/historyUtils.js';
import { ToolCallStatus } from '../types.js';
import type { AnsiToken } from '@qwen-code/qwen-code-core';
import type {
  ArenaAgentCardData,
  CompressionProps,
  HistoryItem as CanonicalHistoryItem,
  HistoryItemWithoutId as CanonicalHistoryItemWithoutId,
} from '../types.js';

export type ToolConfirmState = 'pending' | 'approved' | 'rejected';

export type LiveToolItem = Extract<HistoryItem, { kind: 'tool' }> & {
  renderId?: string;
  args?: string;
  /** Real invocation description (scheduler's getDescription, ink
   * mapToDisplay parity) — takes precedence over the args-based fallback. */
  description?: string;
  detailedDisplay?: string;
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
  historyIsSynthetic?: false;
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

type LiveHistoryItemData =
  | Exclude<
      HistoryItem,
      | { kind: 'tool' }
      | { kind: 'thinking' }
      | { kind: 'assistant' }
      | { kind: 'user' }
    >
  | (Extract<HistoryItem, { kind: 'user' }> & {
      recallText?: string;
    })
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

export type LiveHistoryItem = LiveHistoryItemData & {
  historyId?: number;
  canonicalHistoryItem?: CanonicalHistoryItem;
  canonicalOnly?: true;
  canonicalPending?: boolean;
  canonicalResponseEnded?: true;
  display?: CanonicalHistoryItem['display'];
};

let uid = 0;
const nid = (p: string) => `${p}${++uid}`;

function findToolIndex(items: readonly LiveHistoryItem[], id: string): number {
  return items.findLastIndex((it) => it.kind === 'tool' && it.id === id);
}

/**
 * Pure fold: returns the next items array for one event (input is never
 * mutated). Unknown tool ids are ignored.
 */
function foldLiveEventData(
  prev: readonly LiveHistoryItem[],
  ev: OpenTuiStreamEvent,
): readonly LiveHistoryItem[] {
  const items = [...prev];
  const last = items[items.length - 1];

  switch (ev.type) {
    case 'history-expanded':
      return items
        .filter((item) => item.display?.kind !== 'collapse-summary')
        .map(stripSuppressOnRestore);
    case 'user': {
      if (ev.historyId !== undefined) {
        const index = items.findIndex(
          (item) => item.kind === 'user' && item.historyId === ev.historyId,
        );
        const existing = items[index];
        if (existing?.kind === 'user') {
          items[index] = {
            ...existing,
            text: ev.text,
            recallText: ev.recallText,
            promptId: ev.promptId,
            sentToModel: ev.sentToModel,
          };
          return items;
        }
      }
      // Repeated echoes can collapse; distinct identified turns cannot.
      if (
        last?.kind === 'user' &&
        last.text === ev.text &&
        last.recallText === ev.recallText &&
        last.promptId === ev.promptId &&
        last.historyId === ev.historyId
      ) {
        return prev;
      }
      if (last?.kind === 'assistant' && last.streaming)
        items[items.length - 1] = { ...last, streaming: false };
      items.push({
        kind: 'user',
        id: nid('u'),
        text: ev.text,
        ...(ev.recallText === undefined ? {} : { recallText: ev.recallText }),
        promptId: ev.promptId,
        sentToModel: ev.sentToModel,
        ...(ev.historyId === undefined ? {} : { historyId: ev.historyId }),
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
      if (last?.kind === 'thinking' && !last.done)
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
      if (i >= 0 && !(items[i] as LiveToolItem).done) {
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
        ...(i >= 0 ? { renderId: nid('tool-card') } : {}),
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
          detailedDisplay: structured?.detailedDisplay,
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
      if (i >= 0 && !(items[i] as LiveToolItem).done) {
        const t = items[i] as LiveToolItem;
        items[i] = { ...t, title: ev.title, confirm: 'pending' };
        return items;
      }
      if (last?.kind === 'assistant' && last.streaming)
        items[items.length - 1] = { ...last, streaming: false };
      items.push({
        kind: 'tool',
        id: ev.id,
        ...(i >= 0 ? { renderId: nid('tool-card') } : {}),
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
      items.push({
        kind: 'info',
        id: nid('info'),
        text: ev.text,
        ...(ev.historyIsSynthetic !== undefined
          ? { historyIsSynthetic: ev.historyIsSynthetic }
          : {}),
      });
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

/** Snapshot-only rewind boundary: IDs remain positions in the full live list. */
export function rewindBoundaryHistory(
  items: readonly LiveHistoryItem[],
): CanonicalHistoryItem[] {
  return items.flatMap((item, id): CanonicalHistoryItem[] => {
    if (item.kind === 'user')
      return [
        {
          id,
          type: 'user',
          text: item.text,
          promptId: item.promptId,
          ...(item.canonicalHistoryItem?.type === 'user' &&
          item.canonicalHistoryItem.rewindId
            ? { rewindId: item.canonicalHistoryItem.rewindId }
            : {}),
          sentToModel: item.sentToModel,
          display: item.display,
        },
      ];
    if (item.kind === 'compaction')
      return [
        {
          id,
          type: 'compression',
          compression: item.compression,
          display: item.display,
        },
      ];
    return [];
  });
}

export function foldLiveEvent(
  prev: readonly LiveHistoryItem[],
  event: OpenTuiStreamEvent,
): readonly LiveHistoryItem[] {
  if (event.type === 'tool-history') {
    const callIds = new Set(event.item.tools.map((tool) => tool.callId));
    return prev.map((item) =>
      item.kind === 'tool' &&
      callIds.has(item.id) &&
      (!item.canonicalHistoryItem ||
        item.canonicalHistoryItem.id === event.item.id)
        ? {
            ...item,
            historyId: event.item.id,
            canonicalHistoryItem: event.item,
            canonicalPending: event.pending,
          }
        : item,
    );
  }
  if (event.type === 'canonical-history-replace') {
    const first = prev.findIndex(
      (item) => item.canonicalHistoryItem?.id === event.item.id,
    );
    const retained = prev.filter(
      (item) => item.canonicalHistoryItem?.id !== event.item.id,
    );
    let replacement: readonly LiveHistoryItem[] = [];
    for (const projected of event.events)
      replacement = foldLiveEvent(replacement, {
        ...projected,
        historyId: event.item.id,
        canonicalHistoryItem: event.item,
      });
    if (replacement.length === 0)
      replacement = foldLiveEvent([], {
        type: 'canonical-history',
        historyId: event.item.id,
        canonicalHistoryItem: event.item,
      });
    const index = first < 0 ? retained.length : first;
    return [
      ...retained.slice(0, index),
      ...replacement,
      ...retained.slice(index),
    ];
  }
  const source = event.canonicalHistoryItem;
  if (source) {
    if (source.id <= nextCanonicalId) nextCanonicalId = source.id - 1;
    const previous =
      prev.at(-1)?.canonicalHistoryItem?.id === source.id
        ? prev
        : foldLiveEventData(foldLiveEventData(prev, { type: 'segment-end' }), {
            type: 'thinking-end',
          });
    const first = previous.findIndex(
      (item) => item.canonicalHistoryItem?.id === source.id,
    );
    const block = previous.filter(
      (item) => item.canonicalHistoryItem?.id === source.id,
    );
    const retained = previous.filter(
      (item) => item.canonicalHistoryItem?.id !== source.id,
    );
    const next =
      event.type === 'canonical-history'
        ? block.length
          ? block
          : [
              {
                kind: 'info' as const,
                id: nid('canonical'),
                text: '',
                canonicalOnly: true as const,
                ...(isSyntheticHistoryItem(source)
                  ? {}
                  : { historyIsSynthetic: false as const }),
              },
            ]
        : foldLiveEventData(block, event);
    const captured = next.map((item) => ({
      ...item,
      ...(item.kind === 'tool'
        ? { renderId: item.renderId ?? `history-${source.id}` }
        : {}),
      historyId: source.id,
      canonicalHistoryItem: source,
      ...(event.historyDisplay ? { display: event.historyDisplay } : {}),
    }));
    const index = first < 0 ? retained.length : first;
    return [...retained.slice(0, index), ...captured, ...retained.slice(index)];
  }
  const next = retainNativeCanonicalHistory(
    prev,
    foldLiveEventData(prev, event),
    event,
  );
  if (event.type === 'history-expanded')
    return next.map((item) => {
      const source = item.canonicalHistoryItem;
      if (!source) return item;
      const expanded = stripSuppressOnRestore(source);
      return expanded === source
        ? item
        : { ...item, canonicalHistoryItem: expanded };
    });
  if (event.historyId === undefined) return next;
  const changed = next.findLastIndex((item, index) => item !== prev[index]);
  if (changed < 0) return next;
  return next.map((item, index) =>
    index === changed
      ? {
          ...item,
          historyId: event.historyId,
          ...(event.historyDisplay ? { display: event.historyDisplay } : {}),
        }
      : item,
  );
}

export function snapshotCanonicalHistory(
  items: readonly LiveHistoryItem[],
): CanonicalHistoryItem[] {
  const seen = new Set<number>();
  const history: CanonicalHistoryItem[] = [];
  for (const item of items) {
    // Countdown and running background-task cards are not committed history.
    if (item.kind === 'retry' || item.kind === 'task') continue;
    const source = item.canonicalHistoryItem;
    if (!source)
      throw new Error(`Checkpoint history missing canonical ${item.kind}`);
    if (seen.has(source.id)) continue;
    seen.add(source.id);
    history.push(source);
  }
  return history;
}

let nextCanonicalId = 0;

export function allocateCanonicalHistoryId(
  items: readonly LiveHistoryItem[] = [],
): number {
  for (const item of items) {
    const id = item.canonicalHistoryItem?.id ?? item.historyId;
    if (id !== undefined && id <= nextCanonicalId) nextCanonicalId = id - 1;
  }
  return --nextCanonicalId;
}

function retainNativeCanonicalHistory(
  prev: readonly LiveHistoryItem[],
  next: readonly LiveHistoryItem[],
  event: OpenTuiStreamEvent,
): readonly LiveHistoryItem[] {
  if (next === prev) return prev;
  const targetIndex = next.findLastIndex((item, index) => item !== prev[index]);
  let source: CanonicalHistoryItem | undefined;
  let pending = false;
  const target = next[targetIndex];
  const existing = target?.canonicalHistoryItem;
  const stamp = (
    item: CanonicalHistoryItemWithoutId,
  ): CanonicalHistoryItem => ({
    ...item,
    id: existing?.id ?? event.historyId ?? allocateCanonicalHistoryId(next),
  });
  const turnStart = prev.findLastIndex((item) => item.kind === 'user');
  const responseEnd = prev.findLastIndex((item) => item.canonicalResponseEnded);
  const turn = prev.slice(Math.max(0, turnStart, responseEnd + 1));
  const continuation = turn.some((item) => {
    const source = item.canonicalHistoryItem;
    return (
      (source?.type === 'gemini' || source?.type === 'gemini_content') &&
      Boolean(
        source.text.trim() || source.images?.length || source.omittedImageCount,
      )
    );
  });
  switch (event.type) {
    case 'user':
      source = stamp({
        type: 'user',
        text: event.text,
        promptId: event.promptId,
        sentToModel: event.sentToModel,
      });
      break;
    case 'text': {
      if (target?.kind !== 'assistant') break;
      const previousText =
        existing?.type === 'gemini' || existing?.type === 'gemini_content'
          ? existing.text
          : '';
      const text = (previousText + event.delta).replace(
        /^(?:[ \t]*\r?\n)+/,
        '',
      );
      const type =
        existing?.type === 'gemini' || existing?.type === 'gemini_content'
          ? existing.type
          : continuation
            ? 'gemini_content'
            : 'gemini';
      source = stamp(
        type === 'gemini'
          ? {
              type,
              text,
              timestamp:
                existing?.type === 'gemini'
                  ? existing.timestamp
                  : target.timestamp,
            }
          : { type, text },
      );
      pending = true;
      break;
    }
    case 'thinking': {
      if (target?.kind !== 'thinking') break;
      const text = (
        (existing?.type === 'gemini_thought' ? existing.text : '') + event.delta
      ).replace(/^(?:[ \t]*\r?\n)+/, '');
      source = stamp({ type: 'gemini_thought', text, durationMs: 0 });
      pending = true;
      break;
    }
    case 'thinking-end':
      if (target?.kind === 'thinking' && existing?.type === 'gemini_thought') {
        source = { ...existing, durationMs: target.durationMs };
      }
      break;
    case 'tool-end': {
      if (
        target?.kind !== 'tool' ||
        !target.canonicalPending ||
        existing?.type !== 'tool_group'
      )
        break;
      const terminal = [
        ToolCallStatus.Success,
        ToolCallStatus.Error,
        ToolCallStatus.Canceled,
      ];
      const tools = existing.tools.map((tool) =>
        tool.callId !== event.id || terminal.includes(tool.status)
          ? tool
          : {
              ...tool,
              status: event.success
                ? ToolCallStatus.Success
                : event.summary === 'cancelled'
                  ? ToolCallStatus.Canceled
                  : ToolCallStatus.Error,
            },
      );
      source = { ...existing, tools };
      pending = tools.some((tool) => !terminal.includes(tool.status));
      break;
    }
    case 'image': {
      const seen = new Set<number>();
      let displayed = 0;
      for (const item of turn) {
        const source = item.canonicalHistoryItem;
        if (!source || seen.has(source.id)) continue;
        seen.add(source.id);
        if (source.type === 'gemini' || source.type === 'gemini_content')
          displayed += source.images?.length ?? 0;
      }
      const previous = prev.at(-1)?.canonicalHistoryItem;
      if (
        displayed >= MAX_INLINE_IMAGES_PER_ITEM &&
        (previous?.type === 'gemini' || previous?.type === 'gemini_content') &&
        previous.omittedImageCount &&
        !previous.text &&
        !previous.images?.length
      ) {
        source = {
          ...previous,
          omittedImageCount: previous.omittedImageCount + 1,
        };
      } else {
        const body =
          displayed < MAX_INLINE_IMAGES_PER_ITEM
            ? { images: [{ mimeType: event.mimeType, data: event.data }] }
            : { omittedImageCount: 1 };
        source = stamp(
          continuation
            ? { type: 'gemini_content', text: '', ...body }
            : { type: 'gemini', text: '', timestamp: Date.now(), ...body },
        );
      }
      pending = true;
      break;
    }
    case 'info':
      source = stamp({ type: 'info', text: event.text });
      break;
    case 'error':
      source = stamp({ type: 'error', text: event.text, hint: event.hint });
      break;
    case 'warning':
      source = stamp({ type: 'warning', text: event.text });
      break;
    case 'compaction':
      source = stamp({ type: 'compression', compression: event.compression });
      break;
    case 'stop-hook-message':
      source = stamp({
        type: 'stop_hook_system_message',
        message: event.message,
      });
      break;
    case 'away-recap':
      source = stamp({ type: 'away_recap', text: event.text });
      break;
    case 'user-shell':
      source = stamp({ type: 'user_shell', text: event.text });
      break;
    case 'advisor':
      source = stamp({ type: 'advisor', text: event.text, model: event.model });
      break;
    case 'arena-agent':
      source = stamp({ type: 'arena_agent_complete', agent: event.agent });
      break;
    case 'arena-session':
      source = stamp({
        type: 'arena_session_complete',
        sessionStatus: event.sessionStatus,
        task: event.task,
        totalDurationMs: event.totalDurationMs,
        agents: event.agents,
      });
      break;
    default:
      break;
  }
  const retained = next.map((item, index) => {
    const sameSource = source && item.canonicalHistoryItem?.id === source.id;
    if (source && (index === targetIndex || sameSource)) {
      return {
        ...item,
        canonicalHistoryItem: source,
        canonicalPending: pending,
      };
    }
    const canonical = item.canonicalHistoryItem;
    if (
      item.canonicalPending &&
      (canonical?.type === 'gemini' || canonical?.type === 'gemini_content') &&
      !canonical.text.trim() &&
      !canonical.images?.length &&
      !canonical.omittedImageCount
    )
      return { ...item, canonicalPending: true };
    if (
      item.canonicalPending &&
      item.kind === 'thinking' &&
      item.done &&
      canonical?.type === 'gemini_thought'
    )
      return {
        ...item,
        canonicalHistoryItem: { ...canonical, durationMs: item.durationMs },
        canonicalPending: false,
      };
    if (
      item.canonicalPending &&
      ((item.kind === 'assistant' && !item.streaming) ||
        (item.kind === 'thinking' && item.done) ||
        (item.kind === 'image' && event.type !== 'image'))
    )
      return { ...item, canonicalPending: false };
    return item;
  });
  if (event.type === 'segment-end' && retained.length > 0)
    return retained.map((item, index) =>
      index === retained.length - 1
        ? { ...item, canonicalResponseEnded: true }
        : item,
    );
  return retained;
}
