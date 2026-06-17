/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure projection from daemon SSE frames → the TUI's history/streaming shapes.
 *
 * This is the heart of the (opt-in) daemon-client TUI mode: when the terminal
 * renders a *daemon-hosted* session instead of its own in-process agent, the
 * `useDaemonStream` hook drives this reducer with frames from
 * `DaemonSessionClient.events()` and feeds the result into the SAME UI contract
 * the in-process `useGeminiStream` produces (`addItem`, `pendingHistoryItems`,
 * `thought`, `streamingState`). See
 * `packages/rc-gateway/docs/phase2-daemon-tui.md`.
 *
 * Design choices (deliberate, see the spec):
 * - **The daemon is the source of truth, but echo is origin-aware.** A
 *   `user_message_chunk` is committed as a user history item ONLY when it
 *   originated on a DIFFERENT client (the phone) — so a turn typed elsewhere
 *   appears on the terminal identically (the point of handoff). The local
 *   submitter echoes its own input immediately (responsive, matching the
 *   in-process contract); the daemon tags each frame with `originatorClientId`
 *   (verified against a live daemon), so we drop the self-echo to avoid a
 *   double-render. With no `ownClientId` configured we project unconditionally
 *   (never silently swallow the user's input).
 * - **Read text from the raw frame stream**, never from a reduced "last update"
 *   snapshot — the SDK's `reduceDaemonSessionEvent` clobbers `lastSessionUpdate`
 *   to the latest frame, which would drop interim streamed text.
 * - **Pure, dependency-free.** The input is typed structurally (a SDK
 *   `DaemonEvent` satisfies {@link DaemonFrame}) so this module adds no
 *   cross-package dependency and is trivially unit-testable against captured
 *   frames.
 *
 * Scope: this first slice covers the PROVEN text turn (user echo, streamed
 * thought + message, turn completion, usage). Tool-call display and the
 * permission round-trip (`tool_call` / `tool_call_update` / `permission_request`)
 * are a following slice — built once a tool-triggering turn is captured so the
 * daemon status-string → ToolCallStatus mapping is grounded, not guessed.
 *
 * Known slice-1 gaps to reconcile at integration:
 * - **Only `turn_complete` clears the streaming state.** An errored/canceled
 *   turn (`stream_error`, `session_died`, or a failed prompt) would leave
 *   `streamingState` at `Responding` with orphaned `pendingText` — a stuck
 *   spinner. The terminal-error frames must reset state (and surface an error
 *   item) in a follow-up.
 * - **Thoughts are ephemeral** (shown live, never committed), and assistant
 *   text commits as `gemini` (not `gemini_content`); both are deliberate
 *   simplifications to revisit against the in-process path at integration.
 */
import {
  StreamingState,
  type HistoryItemWithoutId,
  type ThoughtSummary,
} from '../../types.js';

/**
 * Minimal structural shape of a daemon SSE frame. The SDK's `DaemonEvent`
 * ({ id?, v, type, data, originatorClientId? }) is a superset, so it is
 * assignable here without importing it.
 */
export interface DaemonFrame {
  type: string;
  id?: number;
  data?: unknown;
  /** Client that originated this frame's turn; used to drop self-echoes. */
  originatorClientId?: string;
}

/** Token/usage accounting carried by the terminal `agent_message_chunk`. */
export interface DaemonTurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  thoughtTokens?: number;
  cachedReadTokens?: number;
  durationMs?: number;
}

export interface DaemonProjectionState {
  streamingState: StreamingState;
  /** In-flight assistant text for the current turn (the pending `gemini` item). */
  pendingText: string;
  /** In-flight reasoning text for the current turn (shown live, not committed). */
  pendingThought: string;
  /** Usage from the most recent terminal `agent_message_chunk`, if any. */
  lastUsage?: DaemonTurnUsage;
  /**
   * This client's daemon clientId. When set, `user_message_chunk` frames whose
   * `originatorClientId` matches are treated as self-echoes and NOT committed
   * (the submitter already rendered its own input locally).
   */
  ownClientId?: string;
}

export interface ProjectionResult {
  state: DaemonProjectionState;
  /** History items to `addItem` as a result of this frame, in order. */
  committed: HistoryItemWithoutId[];
}

export function initialDaemonProjectionState(
  ownClientId?: string,
): DaemonProjectionState {
  return {
    streamingState: StreamingState.Idle,
    pendingText: '',
    pendingThought: '',
    ownClientId,
  };
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

const textOf = (update: Record<string, unknown>): string => {
  const content = asRecord(update['content']);
  return typeof content['text'] === 'string' ? (content['text'] as string) : '';
};

const readUsage = (
  update: Record<string, unknown>,
): DaemonTurnUsage | undefined => {
  const meta = asRecord(update['_meta']);
  const usage = asRecord(meta['usage']);
  if (Object.keys(usage).length === 0 && meta['durationMs'] === undefined) {
    return undefined;
  }
  const num = (v: unknown): number | undefined =>
    typeof v === 'number' ? v : undefined;
  return {
    inputTokens: num(usage['inputTokens']),
    outputTokens: num(usage['outputTokens']),
    totalTokens: num(usage['totalTokens']),
    thoughtTokens: num(usage['thoughtTokens']),
    cachedReadTokens: num(usage['cachedReadTokens']),
    durationMs: num(usage['durationMs'] ?? meta['durationMs']),
  };
};

function projectSessionUpdate(
  state: DaemonProjectionState,
  data: Record<string, unknown>,
  originatorClientId: string | undefined,
): ProjectionResult {
  const update = asRecord(data['update']);
  const kind = update['sessionUpdate'];
  const text = textOf(update);

  switch (kind) {
    case 'user_message_chunk': {
      // Drop our OWN echo (the submitter rendered it locally); render turns
      // that originated on another client (the phone). Unknown origin → render.
      const isSelfEcho =
        state.ownClientId !== undefined &&
        originatorClientId === state.ownClientId;
      return {
        state: { ...state, streamingState: StreamingState.Responding },
        committed: text && !isSelfEcho ? [{ type: 'user', text }] : [],
      };
    }

    case 'agent_thought_chunk':
      return {
        state: {
          ...state,
          streamingState: StreamingState.Responding,
          pendingThought: state.pendingThought + text,
        },
        committed: [],
      };

    case 'agent_message_chunk': {
      const usage = readUsage(update);
      return {
        state: {
          ...state,
          streamingState: StreamingState.Responding,
          // Concatenate verbatim — a terminal chunk may carry empty text plus
          // `_meta.usage`; appending '' is a no-op.
          pendingText: state.pendingText + text,
          lastUsage: usage ?? state.lastUsage,
        },
        committed: [],
      };
    }

    // `available_commands_update` (and any other update kind) does not affect
    // the streamed turn in this slice.
    default:
      return { state, committed: [] };
  }
}

/**
 * Fold one daemon frame into the projection state, returning the next state and
 * any history items to commit. Pure: same input → same output, no side effects.
 */
export function projectDaemonEvent(
  state: DaemonProjectionState,
  frame: DaemonFrame,
): ProjectionResult {
  const data = asRecord(frame.data);
  switch (frame.type) {
    case 'session_update':
      return projectSessionUpdate(state, data, frame.originatorClientId);

    case 'turn_complete': {
      // Commit the assembled assistant message; reasoning stays ephemeral.
      const committed: HistoryItemWithoutId[] =
        state.pendingText.trim().length > 0
          ? [{ type: 'gemini', text: state.pendingText }]
          : [];
      return {
        state: {
          ...state,
          streamingState: StreamingState.Idle,
          pendingText: '',
          pendingThought: '',
        },
        committed,
      };
    }

    // `replay_complete` and unknown frame types are inert for this slice.
    default:
      return { state, committed: [] };
  }
}

/**
 * The live (uncommitted) history items for the current turn — fed to the UI's
 * pending-section the same way `useGeminiStream.pendingHistoryItems` is.
 */
export function pendingHistoryItemsOf(
  state: DaemonProjectionState,
): HistoryItemWithoutId[] {
  return state.pendingText ? [{ type: 'gemini', text: state.pendingText }] : [];
}

/**
 * Project the in-flight reasoning into a {@link ThoughtSummary} for the loading
 * indicator. Convention (matching the in-process path): the subject is the
 * first `**bold**` span; the remainder is the description.
 */
export function thoughtOf(state: DaemonProjectionState): ThoughtSummary | null {
  const raw = state.pendingThought.trim();
  if (!raw) return null;
  const m = raw.match(/\*\*(.+?)\*\*/s);
  if (m) {
    return {
      subject: m[1].trim(),
      description: raw.replace(m[0], '').trim(),
    };
  }
  return { subject: '', description: raw };
}
