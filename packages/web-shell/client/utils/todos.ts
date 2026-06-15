import type { ACPToolCall, Message, TodoItem } from '../adapters/types';

/**
 * The todo tool is registered as `todo_write` on the wire, but older paths and
 * the ACP plan bridge use `todowrite`. Match both so detection never hinges on
 * the (unrelated) tool `kind`, which is `think` for this tool.
 */
export function isTodoWriteToolName(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === 'todo_write' || normalized === 'todowrite';
}

export function parseTodoItemsFromEntries(
  entries: readonly unknown[],
): TodoItem[] | undefined {
  const todos = entries.flatMap((entry, index): TodoItem[] => {
    const item = getRecord(entry);
    const content = getString(item, 'content');
    if (!content) return [];
    return [
      {
        id: getString(item, 'id') ?? `plan-${index}`,
        content,
        status: getTodoStatus(getString(item, 'status')),
        priority: getTodoPriority(getString(item, 'priority')),
      },
    ];
  });
  return todos.length > 0 ? todos : undefined;
}

export function extractTodosFromToolCall(
  tool: ACPToolCall,
): TodoItem[] | undefined {
  if (!isTodoWriteToolName(tool.toolName) && tool.kind !== 'other') {
    return undefined;
  }

  const argsTodos = getTodoArray(tool.args);
  if (argsTodos) {
    return parseTodoItemsFromEntries(argsTodos);
  }

  const rawOutput = getRecord(tool.rawOutput);
  const outputTodos = getTodoArray(rawOutput);
  if (outputTodos) {
    return parseTodoItemsFromEntries(outputTodos);
  }

  const entries = Array.isArray(rawOutput?.['entries'])
    ? rawOutput['entries']
    : undefined;
  return entries ? parseTodoItemsFromEntries(entries) : undefined;
}

export function hasActiveTodos(todos: readonly TodoItem[]): boolean {
  return todos.some(
    (todo) => todo.status === 'pending' || todo.status === 'in_progress',
  );
}

export function getTodoStatusIcon(status: TodoItem['status']): string {
  switch (status) {
    case 'completed':
      return '●';
    case 'in_progress':
      return '◐';
    case 'pending':
      return '○';
  }
}

export interface FloatingTodosState {
  todos: TodoItem[];
  /** Every item is completed — the panel shows a transient "all done" state. */
  allCompleted: boolean;
  /** Transcript message the latest todo update came from. */
  sourceMessageId: string | null;
  /** Tool call id within the source message, when it came from a tool call. */
  sourceCallId: string | null;
}

const EMPTY_FLOATING_TODOS: FloatingTodosState = {
  todos: [],
  allCompleted: false,
  sourceMessageId: null,
  sourceCallId: null,
};

export function getFloatingTodos(
  messages: readonly Message[],
): FloatingTodosState {
  let todos: TodoItem[] = [];
  let sourceMessageId: string | null = null;
  let sourceCallId: string | null = null;
  let userMessageAfter = false;

  for (const message of messages) {
    if (message.role === 'user') {
      userMessageAfter = true;
      continue;
    }
    if (message.role === 'plan') {
      todos = message.todos;
      sourceMessageId = message.id;
      sourceCallId = null;
      userMessageAfter = false;
      continue;
    }
    if (message.role !== 'tool_group') continue;

    for (const tool of message.tools) {
      const nextTodos = extractTodosFromToolCall(tool);
      if (nextTodos) {
        todos = nextTodos;
        sourceMessageId = message.id;
        sourceCallId = tool.callId;
        userMessageAfter = false;
      }
    }
  }

  if (todos.length === 0) return EMPTY_FLOATING_TODOS;
  const allCompleted = !hasActiveTodos(todos);
  // A finished list stays visible (the "all done" moment) only until the
  // user sends the next prompt.
  if (allCompleted && userMessageAfter) return EMPTY_FLOATING_TODOS;
  return { todos, allCompleted, sourceMessageId, sourceCallId };
}

/** A status transition surfaced for a single todo snapshot. */
export interface TodoEvent {
  kind: 'started' | 'completed';
  id: string;
  content: string;
}

/** What changed in one todo snapshot relative to the conversation so far. */
export interface TodoSnapshotDiff {
  events: TodoEvent[];
}

interface TodoSnapshot {
  /** Key the diff is stored under: tool callId, or plan message id. */
  key: string;
  todos: TodoItem[];
  /** Cumulative-usage baseline the agent stamped on this snapshot, if any. */
  stats?: TodoStatsSnapshot;
}

/**
 * Identity used to track an item across snapshots. Folds content into the key
 * because todo ids are NOT globally unique: the ACP bridge assigns positional
 * ids (`plan-0`, `plan-1`, …) and models restart numbering at `1, 2, 3` for each
 * new `todo_write` plan, so a later, unrelated list reuses an earlier list's
 * ids. Keying on id alone would diff a new plan's items against a previous
 * plan's stale terminal status; id+content keeps distinct tasks separate, and —
 * unlike a user-turn reset — it still tracks a list correctly when it spans
 * turns (a "continue" turn that completes an item carried over from before).
 *
 * Two rare cases this trades for, affecting the collapsed diff and the per-task
 * detail ({@link computeTodoDetails}) but not the expanded list itself:
 * - A todo reworded on a stable id reads as a new task. Reworded while still
 *   `in_progress` it emits a spurious `started`; reworded straight to
 *   `completed` (`1 "Write report"` → `1 "Write the final report" completed`)
 *   the completion is treated as first-seen and dropped.
 * - Two unrelated plans that reuse both the id AND the exact content (a generic
 *   recurring todo like `"Run tests"`) still collide. computeTodoDetails resets
 *   a task's window when a completed key restarts as `in_progress`, so the
 *   common reuse keeps correct numbers; a reused id+content that goes *straight*
 *   to `completed` (never observed `in_progress`) still shares the earlier
 *   task's detail slot.
 */
export function todoStateKey(todo: TodoItem): string {
  return JSON.stringify([todo.id, todo.content]);
}

/**
 * The todo snapshots carried by one message, in order. In the web-shell daemon
 * path todos arrive as `todo_write` tool calls; the ACP bridge instead emits
 * `plan` messages. Handle both so the timeline works regardless of source.
 */
function todoSnapshotsOf(message: Message): TodoSnapshot[] {
  if (message.role === 'plan') {
    return [{ key: message.id, todos: message.todos }];
  }
  if (message.role === 'tool_group') {
    const snapshots: TodoSnapshot[] = [];
    for (const tool of message.tools) {
      const todos = extractTodosFromToolCall(tool);
      if (todos) {
        snapshots.push({
          key: tool.callId,
          todos,
          stats: extractTodoStats(tool),
        });
      }
    }
    return snapshots;
  }
  return [];
}

/**
 * Walk the todo snapshots in order and, for each one, derive what changed
 * relative to the running state: which items just started and which just
 * completed.
 *
 * Keyed by snapshot id (tool callId or plan message id) so a history row can
 * look up its own diff. Only transitions actually witnessed produce events — an
 * item first seen already completed (e.g. a restored session's opening
 * snapshot) is recorded silently so its old completion is not replayed as if it
 * just happened.
 */
export function computeTodoTimeline(
  messages: readonly Message[],
): Map<string, TodoSnapshotDiff> {
  const result = new Map<string, TodoSnapshotDiff>();
  const lastStatus = new Map<string, TodoItem['status']>();

  for (const message of messages) {
    for (const { key, todos } of todoSnapshotsOf(message)) {
      const events: TodoEvent[] = [];

      for (const todo of todos) {
        const stateKey = todoStateKey(todo);
        const prev = lastStatus.get(stateKey);
        if (todo.status === 'in_progress' && prev !== 'in_progress') {
          events.push({ kind: 'started', id: todo.id, content: todo.content });
        } else if (
          todo.status === 'completed' &&
          prev !== 'completed' &&
          prev !== undefined
        ) {
          events.push({
            kind: 'completed',
            id: todo.id,
            content: todo.content,
          });
        }
        lastStatus.set(stateKey, todo.status);
      }

      result.set(key, { events });
    }
  }

  return result;
}

/**
 * A cheap signature of the todo snapshots in a transcript: each snapshot's key
 * plus its items' id, status, and content. App memoizes the timeline on this so
 * the context provider value stays referentially stable across unrelated
 * streaming ticks (which would otherwise re-render every todo/plan row that
 * consumes the timeline).
 */
export function todoTimelineSignature(messages: readonly Message[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    for (const { key, todos } of todoSnapshotsOf(message)) {
      parts.push(
        JSON.stringify([key, todos.map((t) => [t.id, t.status, t.content])]),
      );
    }
  }
  return parts.join('\n');
}

/**
 * Like {@link todoTimelineSignature} but folds in everything
 * {@link computeTodoDetails} reads beyond item status: each snapshot's message
 * timestamp and stamped stats, plus every non-todo tool span (whose durations
 * feed tool time). App memoizes the detail map on this so the TodoDetailContext
 * value stays referentially stable across streaming ticks that touch none of it.
 */
export function todoDetailSignature(messages: readonly Message[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role === 'tool_group') {
      for (const tool of message.tools) {
        if (
          !isTodoWriteToolName(tool.toolName) &&
          (tool.startTime !== undefined || tool.endTime !== undefined)
        ) {
          parts.push(
            JSON.stringify(['span', tool.callId, tool.startTime, tool.endTime]),
          );
        }
      }
    }
    for (const { key, todos, stats } of todoSnapshotsOf(message)) {
      parts.push(
        JSON.stringify([
          key,
          message.timestamp,
          todos.map((t) => [t.id, t.status, t.content]),
          stats,
        ]),
      );
    }
  }
  return parts.join('\n');
}

export interface TodoWindow {
  start: number;
  end: number;
}

/**
 * Natural-order window of up to maxVisible items anchored on the current
 * item (first in_progress, else first pending): one item of completed
 * context above the anchor, the rest of the budget below it.
 */
export function getTodoWindow(
  todos: readonly TodoItem[],
  maxVisible: number,
): TodoWindow {
  if (todos.length <= maxVisible) return { start: 0, end: todos.length };
  const inProgressIdx = todos.findIndex((t) => t.status === 'in_progress');
  const anchor =
    inProgressIdx >= 0
      ? inProgressIdx
      : todos.findIndex((t) => t.status === 'pending');
  let start = Math.max(0, Math.max(0, anchor) - 1);
  const end = Math.min(todos.length, start + maxVisible);
  start = Math.max(0, end - maxVisible);
  return { start, end };
}

/**
 * Cumulative-usage baseline the agent stamps onto each todo update
 * (`_meta.stats`, surfaced via the tool call's rawOutput). The web-shell diffs
 * consecutive snapshots to attribute a task's spend. `apiTimeMs` only advances
 * live — replayed sessions carry tokens but not per-turn durations.
 */
export interface TodoStatsSnapshot {
  promptTokens: number;
  cachedTokens: number;
  candidateTokens: number;
  apiTimeMs: number;
}

/**
 * Read the cumulative-usage snapshot the agent stamped onto a todo_write tool
 * call's rawOutput. Absent for snapshots emitted by an agent that predates the
 * stamping, or non-tool todo sources (plain plan messages).
 */
export function extractTodoStats(
  tool: ACPToolCall,
): TodoStatsSnapshot | undefined {
  const stats = getRecord(getRecord(tool.rawOutput)?.['stats']);
  if (!stats) return undefined;
  const num = (key: string): number | undefined => {
    const value = stats[key];
    return typeof value === 'number' && Number.isFinite(value)
      ? value
      : undefined;
  };
  const promptTokens = num('promptTokens');
  const cachedTokens = num('cachedTokens');
  const candidateTokens = num('candidateTokens');
  const apiTimeMs = num('apiTimeMs');
  if (
    promptTokens === undefined ||
    cachedTokens === undefined ||
    candidateTokens === undefined ||
    apiTimeMs === undefined
  ) {
    return undefined;
  }
  return { promptTokens, cachedTokens, candidateTokens, apiTimeMs };
}

/**
 * Resource usage consumed during a single todo's [start, end] window. Every
 * field is optional: tokens/API time come from the snapshot diff (absent on
 * sessions whose agent didn't stamp snapshots; API time is also absent on
 * replay), while tool time comes from transcript tool durations and is shown
 * whenever any tool ran in the window.
 */
export interface TodoResources {
  inputTokens?: number;
  cachedTokens?: number;
  outputTokens?: number;
  apiTimeMs?: number;
  toolTimeMs?: number;
}

/** Per-todo timing and resource breakdown. */
export interface TodoDetail {
  /** Wall-clock ms when the item first became in_progress. */
  startTs?: number;
  /** Wall-clock ms when the item became completed. */
  endTs?: number;
  /**
   * Tokens and time spent while this item was the active task. Tokens and API
   * time come from diffing the cumulative-usage snapshots stamped on its start
   * and end todo boundaries; tool time is summed from the transcript's tool
   * durations in the window. Undefined when nothing could be measured.
   */
  resources?: TodoResources;
}

interface ToolSpan {
  start: number;
  end: number;
}

/**
 * Wall-clock spans of every non-todo tool call that has both a start and end
 * time, sorted by start. Used to attribute tool time to the task window a tool
 * ran in; sorting once lets {@link sumToolTimeInWindow} binary-search each
 * window rather than scan every span per task.
 */
function collectToolSpans(messages: readonly Message[]): ToolSpan[] {
  const spans: ToolSpan[] = [];
  for (const message of messages) {
    if (message.role !== 'tool_group') continue;
    for (const tool of message.tools) {
      if (isTodoWriteToolName(tool.toolName)) continue;
      const { startTime, endTime } = tool;
      if (
        typeof startTime === 'number' &&
        typeof endTime === 'number' &&
        endTime >= startTime
      ) {
        spans.push({ start: startTime, end: endTime });
      }
    }
  }
  spans.sort((a, b) => a.start - b.start);
  return spans;
}

/**
 * Total duration of tool spans whose start falls within [startTs, endTs].
 * `sortedSpans` must be sorted by start (see {@link collectToolSpans}); binary
 * search finds the window's first span, then we walk until past its end —
 * O(log S + matched) instead of a full scan per task.
 */
function sumToolTimeInWindow(
  sortedSpans: readonly ToolSpan[],
  startTs: number,
  endTs: number,
): number {
  let lo = 0;
  let hi = sortedSpans.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedSpans[mid].start < startTs) lo = mid + 1;
    else hi = mid;
  }
  let total = 0;
  for (
    let i = lo;
    i < sortedSpans.length && sortedSpans[i].start <= endTs;
    i++
  ) {
    total += sortedSpans[i].end - sortedSpans[i].start;
  }
  return total;
}

interface TokenDiff {
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  apiTimeMs: number;
}

function diffStats(
  start: TodoStatsSnapshot,
  end: TodoStatsSnapshot,
): TokenDiff {
  // Clamp to zero: snapshots are cumulative, so a smaller end (a reset, or two
  // snapshots that coincided) must never surface a negative count.
  const nonNeg = (a: number, b: number) => Math.max(0, b - a);
  return {
    inputTokens: nonNeg(start.promptTokens, end.promptTokens),
    cachedTokens: nonNeg(start.cachedTokens, end.cachedTokens),
    outputTokens: nonNeg(start.candidateTokens, end.candidateTokens),
    apiTimeMs: nonNeg(start.apiTimeMs, end.apiTimeMs),
  };
}

/**
 * Combine the token snapshot diff and the windowed tool time into the resource
 * fields to show. Token fields are included only when the diff measured
 * something (a coincident diff of all zeros reads as not-captured, not a row of
 * zeros); API time only when it advanced (live); tool time only when nonzero.
 * Returns undefined when nothing was measured.
 */
function buildResources(
  tokenDiff: TokenDiff | undefined,
  toolTimeMs: number | undefined,
): TodoResources | undefined {
  const resources: TodoResources = {};
  if (
    tokenDiff &&
    (tokenDiff.inputTokens > 0 ||
      tokenDiff.outputTokens > 0 ||
      tokenDiff.cachedTokens > 0 ||
      tokenDiff.apiTimeMs > 0)
  ) {
    resources.inputTokens = tokenDiff.inputTokens;
    resources.cachedTokens = tokenDiff.cachedTokens;
    resources.outputTokens = tokenDiff.outputTokens;
    if (tokenDiff.apiTimeMs > 0) resources.apiTimeMs = tokenDiff.apiTimeMs;
  }
  if (toolTimeMs !== undefined && toolTimeMs > 0) {
    resources.toolTimeMs = toolTimeMs;
  }
  return Object.keys(resources).length > 0 ? resources : undefined;
}

/**
 * Per-todo detail keyed by {@link todoStateKey}: when each item started and
 * completed, plus the resources spent in that window.
 *
 * Mirrors {@link computeTodoTimeline}'s state machine — a todo's start is its
 * first in_progress transition and its end the completed transition — but
 * records timestamps, the snapshot diff (tokens + API time) between the start
 * and end boundaries, and the transcript tool time in the window. An item first
 * seen already completed (a restored opening snapshot) yields no detail, exactly
 * as it produces no timeline event.
 */
export function computeTodoDetails(
  messages: readonly Message[],
): Map<string, TodoDetail> {
  const result = new Map<string, TodoDetail>();
  const lastStatus = new Map<string, TodoItem['status']>();
  const startStatsByKey = new Map<string, TodoStatsSnapshot | undefined>();
  // Keys that have reached `completed`. Going active again afterwards (directly,
  // or via an intervening `pending`) is a re-activation that must start a fresh
  // window rather than diff against the prior completion's baseline.
  const completedKeys = new Set<string>();
  const toolSpans = collectToolSpans(messages);

  const ensure = (stateKey: string): TodoDetail => {
    let detail = result.get(stateKey);
    if (!detail) {
      detail = {};
      result.set(stateKey, detail);
    }
    return detail;
  };

  for (const message of messages) {
    const ts = message.timestamp;
    for (const { todos, stats } of todoSnapshotsOf(message)) {
      for (const todo of todos) {
        const stateKey = todoStateKey(todo);
        const prev = lastStatus.get(stateKey);
        if (todo.status === 'in_progress' && prev !== 'in_progress') {
          // Re-activated after a completion (a reopened task, or a new task
          // reusing a positional `plan-N` id) — reset so its window diffs
          // against its own start, not the prior completion's far-earlier
          // boundary, which would render a window spanning both with wildly
          // inflated token/time numbers. Keyed on "ever completed" so an
          // intervening `pending` (completed → pending → in_progress) still
          // resets, while a pause/resume that never completed
          // (in_progress → pending → in_progress) keeps its first baseline.
          if (completedKeys.has(stateKey)) {
            completedKeys.delete(stateKey);
            startStatsByKey.delete(stateKey);
            result.delete(stateKey);
          }
          // First start within a task's lifecycle wins: record the start
          // snapshot for the resource diff even when this message has no
          // timestamp.
          if (!startStatsByKey.has(stateKey)) {
            startStatsByKey.set(stateKey, stats);
            if (ts !== undefined) ensure(stateKey).startTs = ts;
          }
        } else if (
          todo.status === 'completed' &&
          prev !== 'completed' &&
          prev !== undefined
        ) {
          const startStats = startStatsByKey.get(stateKey);
          const tokenDiff =
            startStats && stats ? diffStats(startStats, stats) : undefined;
          const startTs = result.get(stateKey)?.startTs;
          const toolTimeMs =
            startTs !== undefined && ts !== undefined
              ? sumToolTimeInWindow(toolSpans, startTs, ts)
              : undefined;
          const resources = buildResources(tokenDiff, toolTimeMs);
          if (ts !== undefined || resources) {
            const detail = ensure(stateKey);
            if (ts !== undefined) detail.endTs = ts;
            if (resources) detail.resources = resources;
          }
        }
        if (todo.status === 'completed') completedKeys.add(stateKey);
        lastStatus.set(stateKey, todo.status);
      }
    }
  }

  return result;
}

function getTodoArray(
  record: Record<string, unknown> | undefined,
): readonly unknown[] | undefined {
  const todos = record?.['todos'];
  return Array.isArray(todos) ? todos : undefined;
}

function getTodoStatus(value: string | undefined): TodoItem['status'] {
  return value === 'completed' || value === 'in_progress' || value === 'pending'
    ? value
    : 'pending';
}

function getTodoPriority(
  value: string | undefined,
): TodoItem['priority'] | undefined {
  return value === 'high' || value === 'medium' || value === 'low'
    ? value
    : undefined;
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function getString(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
