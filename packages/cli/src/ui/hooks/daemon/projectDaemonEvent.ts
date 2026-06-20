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
 * Scope: covers the text turn (user echo, streamed thought + message, completion,
 * usage) AND tool-call display + the permission gate. The `tool_call` /
 * `tool_call_update` shapes + status strings (`in_progress`/`completed`) are
 * grounded in a captured tool turn; `permission_request` / `permission_resolved`
 * are built against the SDK's typed shapes (this daemon config auto-approves
 * builtin reads, so the gate is exercised with synthetic frames in tests). The
 * reducer produces DISPLAY + gate state only — the hook owns the actual vote.
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
  ToolCallStatus,
  type HistoryItemWithoutId,
  type IndividualToolCallDisplay,
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

/**
 * An in-flight tool-approval gate. The reducer records WHICH tool needs
 * approval and the daemon-defined option set; the hook builds the actual
 * vote (`respondToSessionPermission`) from this — the in-process
 * `ToolConfirmationOutcome` is NOT 1:1 with these opaque `optionId`s.
 */
export interface PendingPermission {
  requestId: string;
  toolCallId?: string;
  /** Human-readable tool title (e.g. "Writing to /tmp/x"); shown in the prompt. */
  title?: string;
  /**
   * Daemon-defined options. Each carries an ACP `kind`
   * (`allow_once`/`allow_always`/`reject_once`/`reject_always`) the hook maps a
   * `ToolConfirmationOutcome` onto — the opaque `optionId` is never hardcoded.
   */
  options: Array<{ optionId: string; kind?: string; [key: string]: unknown }>;
}

export interface DaemonProjectionState {
  streamingState: StreamingState;
  /** In-flight assistant text for the current turn (the pending `gemini` item). */
  pendingText: string;
  /** In-flight reasoning text for the current turn (shown live, not committed). */
  pendingThought: string;
  /** Usage from the most recent terminal `agent_message_chunk`, if any. */
  lastUsage?: DaemonTurnUsage;
  /** Tool calls seen this turn, in arrival order (live display + tool_group). */
  tools: IndividualToolCallDisplay[];
  /** The active approval gate, if a `permission_request` is outstanding. */
  pendingPermission?: PendingPermission;
  /**
   * This client's daemon clientId. When set, `user_message_chunk` frames whose
   * `originatorClientId` matches are treated as self-echoes and NOT committed
   * (the submitter already rendered its own input locally).
   */
  ownClientId?: string;
  /**
   * Highest daemon event `id` folded in so far (monotonic watermark). Frames with
   * an `id` at or below this are skipped as duplicates — a defense against a
   * double-subscribe / ring re-replay (e.g. React StrictMode remount) delivering
   * already-seen frames. Locally-synthesized frames (no `id`) are never deduped.
   */
  lastEventId?: number;
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
    tools: [],
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

/**
 * Map the daemon's ACP tool status string → the UI's {@link ToolCallStatus}.
 * Values grounded in a captured tool turn (`in_progress`, `completed`); the
 * remaining ACP states (`pending`, `failed`) round out the set.
 */
function mapToolStatus(s: unknown): ToolCallStatus {
  switch (s) {
    case 'pending':
      return ToolCallStatus.Pending;
    case 'in_progress':
      return ToolCallStatus.Executing;
    case 'completed':
      return ToolCallStatus.Success;
    case 'failed':
      return ToolCallStatus.Error;
    case 'canceled':
    case 'cancelled':
      return ToolCallStatus.Canceled;
    default:
      return ToolCallStatus.Pending;
  }
}

/** Join the text of ACP content blocks (`[{content:{text}}]`) into a string. */
function resultTextOf(update: Record<string, unknown>): string | undefined {
  const content = update['content'];
  if (Array.isArray(content)) {
    const text = content
      .map((b) => {
        const inner = asRecord(asRecord(b)['content']);
        return typeof inner['text'] === 'string'
          ? (inner['text'] as string)
          : '';
      })
      .filter(Boolean)
      .join('\n');
    if (text) return text;
  }
  return typeof update['rawOutput'] === 'string'
    ? (update['rawOutput'] as string)
    : undefined;
}

/** Upsert a tool-call display from a `tool_call` / `tool_call_update` frame. */
function upsertTool(
  tools: IndividualToolCallDisplay[],
  update: Record<string, unknown>,
): IndividualToolCallDisplay[] {
  const callId = String(update['toolCallId'] ?? '');
  if (!callId) return tools;
  const meta = asRecord(update['_meta']);
  const title =
    typeof update['title'] === 'string'
      ? (update['title'] as string)
      : undefined;
  const name =
    (typeof meta['toolName'] === 'string' && (meta['toolName'] as string)) ||
    title ||
    'tool';
  const description =
    title ??
    (update['rawInput'] !== undefined
      ? JSON.stringify(update['rawInput'])
      : name);
  const result = resultTextOf(update);

  const prev = tools.find((t) => t.callId === callId);
  const next: IndividualToolCallDisplay = {
    callId,
    name,
    description: prev?.description ?? description,
    status: mapToolStatus(update['status']),
    // The reducer never builds the imperative onConfirm closure; the hook fills
    // confirmationDetails when a permission_request targets this call.
    confirmationDetails: prev?.confirmationDetails,
    resultDisplay: result ?? prev?.resultDisplay,
    renderOutputAsMarkdown: true,
  };
  return prev
    ? tools.map((t) => (t.callId === callId ? next : t))
    : [...tools, next];
}

/** Set a tool's status by id (used by the permission gate transitions). */
function setToolStatus(
  tools: IndividualToolCallDisplay[],
  callId: string | undefined,
  status: ToolCallStatus,
): IndividualToolCallDisplay[] {
  if (!callId) return tools;
  return tools.map((t) => (t.callId === callId ? { ...t, status } : t));
}

/**
 * Commit the in-flight turn (tool group, then assistant message) and clear the
 * pending buffers. Shared by `turn_complete` and the replay turn-segmentation in
 * `user_message_chunk` (history replay sends no `turn_complete` between turns, so
 * a new user message marks the previous assistant turn done). Reasoning stays
 * ephemeral.
 */
function flushPendingTurn(state: DaemonProjectionState): {
  committed: HistoryItemWithoutId[];
  state: DaemonProjectionState;
} {
  const committed: HistoryItemWithoutId[] = [];
  if (state.tools.length > 0) {
    committed.push({ type: 'tool_group', tools: state.tools });
  }
  if (state.pendingText.trim().length > 0) {
    committed.push({ type: 'gemini', text: state.pendingText });
  }
  return {
    committed,
    state: { ...state, pendingText: '', pendingThought: '', tools: [] },
  };
}

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
      // A new user message ends the previous assistant turn — flush it first
      // (replay sends no `turn_complete` between turns). In the live path the
      // previous turn already committed, so the flush is a no-op.
      const flushed = flushPendingTurn(state);
      // Drop our OWN echo (the submitter rendered it locally); render turns that
      // originated on another client (the phone) or on replay (the original
      // originator, not us). Unknown origin → render.
      const isSelfEcho =
        state.ownClientId !== undefined &&
        originatorClientId === state.ownClientId;
      const committed = [...flushed.committed];
      if (text && !isSelfEcho) committed.push({ type: 'user', text });
      return {
        state: { ...flushed.state, streamingState: StreamingState.Responding },
        committed,
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

    case 'tool_call':
    case 'tool_call_update':
      return {
        state: {
          ...state,
          streamingState: StreamingState.Responding,
          tools: upsertTool(state.tools, update),
        },
        committed: [],
      };

    // `available_commands_update` (and any other update kind) does not affect
    // the streamed turn in this slice.
    default:
      return { state, committed: [] };
  }
}

/** Extract a `toolCallId` from an opaque ACP `toolCall` object if present. */
function toolCallIdOf(toolCall: unknown): string | undefined {
  const tc = asRecord(toolCall);
  const id = tc['toolCallId'] ?? tc['callId'] ?? tc['id'];
  return typeof id === 'string' ? id : undefined;
}

/**
 * Fold one daemon frame into the projection state, returning the next state and
 * any history items to commit. Pure: same input → same output, no side effects.
 *
 * Dedups by the monotonic event `id`: a frame at or below the watermark was
 * already folded in (a double-subscribe / ring re-replay can re-deliver it), so it
 * is skipped. Frames without an `id` (locally-synthesized `turn_complete`) always
 * apply. On apply, the watermark advances to the frame's `id`.
 */
export function projectDaemonEvent(
  state: DaemonProjectionState,
  frame: DaemonFrame,
): ProjectionResult {
  if (
    typeof frame.id === 'number' &&
    state.lastEventId !== undefined &&
    frame.id <= state.lastEventId
  ) {
    return { state, committed: [] };
  }
  const result = projectFrame(state, frame);
  if (typeof frame.id === 'number') {
    result.state = {
      ...result.state,
      lastEventId: Math.max(state.lastEventId ?? 0, frame.id),
    };
  }
  return result;
}

function projectFrame(
  state: DaemonProjectionState,
  frame: DaemonFrame,
): ProjectionResult {
  const data = asRecord(frame.data);
  switch (frame.type) {
    case 'session_update':
      return projectSessionUpdate(state, data, frame.originatorClientId);

    case 'permission_request': {
      // A tool wants approval. Mark the targeted call Confirming and record the
      // gate so the hook can render options + post a vote. (Typed-shape based:
      // this daemon config auto-approves builtin reads, so it's exercised with
      // synthetic frames; the shape is the SDK's DaemonPermissionRequestData.)
      const requestId = String(data['requestId'] ?? '');
      if (!requestId) return { state, committed: [] };
      const toolCall = asRecord(data['toolCall']);
      const toolCallId = toolCallIdOf(data['toolCall']);
      const title =
        typeof toolCall['title'] === 'string'
          ? (toolCall['title'] as string)
          : undefined;
      const options = Array.isArray(data['options'])
        ? (data['options'] as PendingPermission['options'])
        : [];
      // Seed the tool display from the request's OWN toolCall, then mark it
      // Confirming. Edits arrive ONLY as a permission_request — no preceding
      // `tool_call` frame (verified against a live daemon) — so without this the
      // gated tool would never render. A run_shell_command DOES send a prior
      // `tool_call`; there `upsertTool` just refreshes the existing entry.
      let tools = state.tools;
      if (toolCallId) {
        tools = setToolStatus(
          upsertTool(tools, toolCall),
          toolCallId,
          ToolCallStatus.Confirming,
        );
      }
      return {
        state: {
          ...state,
          streamingState: StreamingState.WaitingForConfirmation,
          tools,
          pendingPermission: { requestId, toolCallId, title, options },
        },
        committed: [],
      };
    }

    case 'permission_resolved':
    case 'permission_already_resolved': {
      const requestId = String(data['requestId'] ?? '');
      if (
        state.pendingPermission &&
        requestId &&
        state.pendingPermission.requestId !== requestId
      ) {
        // A different gate resolved — leave ours intact.
        return { state, committed: [] };
      }
      const outcome = asRecord(data['outcome'])['outcome'] ?? data['outcome'];
      const cancelled = outcome === 'cancelled';
      const callId = state.pendingPermission?.toolCallId;
      return {
        state: {
          ...state,
          streamingState: StreamingState.Responding,
          tools: setToolStatus(
            state.tools,
            callId,
            cancelled ? ToolCallStatus.Canceled : ToolCallStatus.Executing,
          ),
          pendingPermission: undefined,
        },
        committed: [],
      };
    }

    case 'turn_complete': {
      // Commit this turn (tool group, then assistant message) and go Idle.
      const flushed = flushPendingTurn(state);
      return {
        state: {
          ...flushed.state,
          streamingState: StreamingState.Idle,
          pendingPermission: undefined,
        },
        committed: flushed.committed,
      };
    }

    // `replay_complete` and unknown frame types are inert for this slice.
    default:
      return { state, committed: [] };
  }
}

/** Live tool-call display for the current turn (the UI's `pendingToolCalls`). */
export function pendingToolCallsOf(
  state: DaemonProjectionState,
): IndividualToolCallDisplay[] {
  return state.tools;
}

/** The outstanding approval gate, if any (the hook turns this into a prompt). */
export function activePermissionOf(
  state: DaemonProjectionState,
): PendingPermission | undefined {
  return state.pendingPermission;
}

/**
 * The live (uncommitted) history items for the current turn — fed to the UI's
 * pending-section the same way `useGeminiStream.pendingHistoryItems` is.
 */
export function pendingHistoryItemsOf(
  state: DaemonProjectionState,
): HistoryItemWithoutId[] {
  // Mirror the `turn_complete` commit order (`[tool_group, gemini]`) so the live
  // view matches the committed history exactly: tools render above the streaming
  // assistant text, both updating in place as frames arrive.
  const items: HistoryItemWithoutId[] = [];
  if (state.tools.length > 0) {
    items.push({ type: 'tool_group', tools: state.tools });
  }
  if (state.pendingText) {
    items.push({ type: 'gemini', text: state.pendingText });
  }
  return items;
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
