/**
 * Todo timeline / detail types — the value types behind `TodoTimelineContext`
 * and `TodoDetailContext`. Pure data the panel renders; the host computes the
 * maps and injects them (web-shell's `utils/todos.ts` re-exports these types).
 */

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

/** Resource usage consumed during a single todo's [start, end] window. */
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
  resources?: TodoResources;
}
