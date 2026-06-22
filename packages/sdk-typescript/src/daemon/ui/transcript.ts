/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonPromptCancelledTranscriptBlock,
  DaemonShellTranscriptBlock,
  DaemonStatusTranscriptBlock,
  DaemonTextTranscriptBlock,
  DaemonToolTranscriptBlock,
  DaemonTranscriptBlock,
  DaemonTranscriptReducerOptions,
  DaemonTranscriptState,
  DaemonUiEvent,
  DaemonUiTextEvent,
  DaemonUserShellTranscriptBlock,
} from './types.js';
import { DAEMON_PLAN_TOOL_CALL_ID } from './types.js';
import { createDaemonToolPreview } from './toolPreview.js';
import { isRecord } from './utils.js';

const DEFAULT_MAX_BLOCKS = 1_000;
const TRIMMED_TOOL_BLOCK_ID = '__trimmed_tool_block__';
const TRIMMED_PERMISSION_BLOCK_ID = '__trimmed_permission_block__';
const MAX_TEXT_BLOCK_LENGTH = 100_000;
const TEXT_TRUNCATED_SUFFIX = '\n[truncated]\n';
const MAX_CLONE_DEPTH = 16;
type TimestampFormatOptions = {
  locale?: string;
  timeZone?: string;
  timeStyle?: 'short' | 'medium' | 'long' | 'full';
  dateStyle?: 'short' | 'medium' | 'long' | 'full';
};
const timestampFormatterCache = new Map<string, Intl.DateTimeFormat>();

export function createDaemonTranscriptState(
  opts: DaemonTranscriptReducerOptions = {},
): DaemonTranscriptState {
  return {
    blocks: [],
    blockIndexById: {},
    toolBlockByCallId: {},
    trimmedToolNotificationByCallId: {},
    permissionBlockByRequestId: {},
    activeAssistantBlockByParent: {},
    activeThoughtBlockByParent: {},
    // PR-E sidechannel: track current tool / approval mode / progress
    toolProgress: {},
    awaitingResync: false,
    resyncRequiredCount: 0,
    nextOrdinal: 1,
    now: opts.now ?? Date.now(),
    maxBlocks: opts.maxBlocks ?? DEFAULT_MAX_BLOCKS,
  };
}

/**
 * Tool statuses that count as "in-flight" — when one of these is set, the
 * tool block is considered active and `state.currentToolCallId` mirrors
 * its id. Closed list; daemon-side may emit other status values (e.g.,
 * future `'paused'`) — those are NOT treated as in-flight here.
 */
const IN_FLIGHT_TOOL_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'confirming',
  'running',
  'in_progress',
]);

/**
 * Tool statuses that terminate the in-flight phase. Any other status
 * (including unknown future ones) keeps the tool considered in-flight,
 * which is the forward-compat-friendly default — the alternative would
 * silently mark unknown states as terminal.
 */
const TERMINAL_TOOL_STATUSES: ReadonlySet<string> = new Set([
  'completed',
  'success',
  'failed',
  'error',
  'canceled',
  'cancelled',
]);
const RESYNC_PASSTHROUGH_TYPES: ReadonlySet<string> = new Set([
  'session.state_resync_required',
  'assistant.done',
  'status',
  'debug',
  'error',
]);

export function appendLocalUserTranscriptMessage(
  state: DaemonTranscriptState,
  text: string,
  opts: DaemonTranscriptReducerOptions & {
    images?: Array<{ data: string; mimeType: string }>;
  } = {},
): DaemonTranscriptState {
  const next = cloneTranscriptState(state, opts);
  finishAssistant(next);
  const block = createTextBlock(next, 'user', text);
  if (opts.images && opts.images.length > 0) {
    (block as DaemonTextTranscriptBlock).images = [...opts.images];
  }
  appendBlock(next, block);
  next.activeUserBlockId = block.id;
  return trimTranscriptState(next);
}

export function reduceDaemonTranscriptEvents(
  state: DaemonTranscriptState,
  events: readonly DaemonUiEvent[],
  opts: DaemonTranscriptReducerOptions = {},
): DaemonTranscriptState {
  if (events.length === 0) return state;
  const next = cloneTranscriptState(state, opts);
  for (const event of events) applyDaemonTranscriptEvent(next, event);
  const result = trimTranscriptState(next);
  // With lazy COW, `state.blocks` is shared across
  // sidechannel-only snapshots. A misbehaving consumer doing
  // `(state.blocks as DaemonTranscriptBlock[]).sort()` would corrupt
  // EVERY snapshot that shares the reference (previously only the
  // current one). Freeze the array at the dispatch boundary so external
  // in-place mutation throws in strict mode instead of silently
  // poisoning future snapshots. Internal reducer mutation goes through
  // `takeBlocksOwnership` which copies BEFORE mutating, so the frozen
  // shared reference is never touched in-place by the next dispatch.
  Object.freeze(result.blocks);
  return result;
}

export function rebuildDaemonTranscriptBlockIndex(
  blocks: readonly DaemonTranscriptBlock[],
): Record<string, number> {
  const blockIndexById: Record<string, number> = {};
  blocks.forEach((block, index) => {
    blockIndexById[block.id] = index;
  });
  return blockIndexById;
}

function applyDaemonTranscriptEvent(
  next: DaemonTranscriptState,
  event: DaemonUiEvent,
): void {
  if (event.eventId !== undefined) {
    next.lastEventId = Math.max(next.lastEventId ?? 0, event.eventId);
  }
  if (next.awaitingResync && !RESYNC_PASSTHROUGH_TYPES.has(event.type)) {
    // Diagnostic for the "permanently frozen
    // transcript" case. Without this log, consumers debugging a stuck UI
    // had no signal that events were being dropped. The latch is
    // intentional — daemon's `state_resync_required` means the SSE ring
    // evicted past our cursor, and we cannot safely continue without an
    // explicit re-sync (typically via session reconnect with new id).
    // But silent drop made diagnosis difficult. Use console.warn (not
    // console.error) so it surfaces in DevTools but doesn't escalate as
    // an uncaught issue. Throttled at the call site is the consumer's
    // job — this fires once per dropped event.
    if (typeof console !== 'undefined') {
      // eslint-disable-next-line no-console -- intentional diagnostic for awaitingResync silent-drop
      console.warn?.(
        `[daemon-ui] dropping event \`${event.type}\` while awaitingResync; ` +
          `state may be stale until session reconnect (lastResyncRequired: ${
            next.lastResyncRequired
              ? JSON.stringify(next.lastResyncRequired)
              : 'unknown'
          })`,
      );
    }
    return;
  }

  switch (event.type) {
    case 'user.shell.command':
      next.pendingUserShellCommand = {
        command: event.command,
        ...(event.cwd ? { cwd: event.cwd } : {}),
      };
      break;
    case 'user.text.delta':
      if (!next.activeUserBlockId) {
        next.lastFollowupSuggestion = undefined;
      }
      appendTextDelta(next, 'user', 'activeUserBlockId', event.text, event);
      break;
    case 'user.image.delta': {
      if (!next.activeUserBlockId) {
        const block = createTextBlock(
          next,
          'user',
          '',
        ) as DaemonTextTranscriptBlock;
        block.images = [{ data: event.data, mimeType: event.mimeType }];
        appendBlock(next, block);
        next.activeUserBlockId = block.id;
      } else {
        // Use getWritableBlockById to ensure COW safety when mutating block.images
        const block = getWritableBlockById(next, next.activeUserBlockId) as
          | DaemonTextTranscriptBlock
          | undefined;
        if (block && block.kind === 'user') {
          // Use immutable update to avoid mutating a shared array reference
          block.images = [
            ...(block.images ?? []),
            { data: event.data, mimeType: event.mimeType },
          ];
        }
      }
      break;
    }
    case 'assistant.text.delta':
      appendTextDelta(
        next,
        'assistant',
        'activeAssistantBlockId',
        event.text,
        event,
      );
      break;
    case 'assistant.done':
      finishAssistant(next);
      // PR-E cancellation propagation: when the assistant turn ENDS
      // abnormally, any in-flight tool block whose status the daemon
      // never updated to a terminal state would otherwise spin forever.
      // Force them to 'cancelled' so renderers can clear spinners.
      //
      // Scope this to application-layer
      // terminations only. Transport-layer events (`stream_ended`,
      // `reconnected`) are NOT cancellations — the tool is still
      // running on the daemon side. Marking it cancelled here causes a
      // visible spinner-to-red flash when SSE replay later corrects
      // status back to `running`. Leave in-flight tools untouched for
      // those reasons; the post-reconnect `tool_call_update` stream
      // will deliver the real terminal status.
      if (event.reason === 'cancelled' || event.reason === 'error') {
        propagateCancellationToInFlightTools(next);
      }
      break;
    case 'assistant.usage':
      applyAssistantUsage(next, event);
      break;
    case 'thought.text.delta':
      appendTextDelta(
        next,
        'thought',
        'activeThoughtBlockId',
        event.text,
        event,
      );
      break;
    case 'tool.update':
      upsertToolBlock(next, event);
      break;
    case 'shell.output':
      appendShellBlock(next, event);
      break;
    case 'user.shell.output':
      appendUserShellBlock(next, event);
      break;
    case 'permission.request':
      upsertPermissionBlock(next, event);
      break;
    case 'permission.resolved':
      resolvePermissionBlock(next, event);
      break;
    case 'model.changed':
      appendStatusBlock(
        next,
        'status',
        `Model switched: ${event.modelId}`,
        event,
      );
      break;
    case 'status':
    case 'debug':
    case 'error':
      appendStatusBlock(next, event.type, event.text, event);
      break;
    // Session-meta / workspace / auth events do NOT push transcript blocks.
    // Renderers subscribe to the store and select them via separate
    // selectors (e.g., `selectApprovalMode`, `selectAvailableCommands`,
    // `selectAuthFlow`) — see `selectors.ts`. They are still observed by
    // the reducer so `lastEventId` advances monotonically, but the
    // chat-stream transcript stays focused on user/assistant/tool/shell/
    // permission content. PRs in the C/D series may opt some of these
    // into transcript projection as structured non-chat blocks.
    case 'session.approval_mode.changed':
      // PR-E sidechannel: mirror the new approval mode onto state so
      // renderers don't have to walk events.
      next.approvalMode = event.next;
      break;
    case 'session.metadata.changed':
    case 'session.available_commands':
      // Intentional no-op against `blocks[]`.
      break;
    case 'session.state_resync_required':
      handleStateResyncRequired(next, event);
      break;
    case 'prompt.cancelled':
      // Cross-client: a peer (or this client's own dropped connection)
      // cancelled the active prompt. Clear in-flight tool spinners the
      // same way an `assistant.done(cancelled)` would, so multi-client
      // UIs don't show a tool spinning forever after a peer cancel.
      // Idempotent — safe if the daemon also later emits terminal
      // tool_call_update frames.
      propagateCancellationToInFlightTools(next);
      if (event.reason !== 'forward_failed') {
        appendPromptCancelledBlock(next, event);
      }
      break;
    case 'followup.suggestion':
      // Sidechannel: latest assist hint replaces any prior one for the
      // session. No transcript block — adapters render the suggestion
      // as ghost-text in their input placeholder via the sidechannel
      // selector. Self-invalidated by the adapter on next sendPrompt
      // (no wire round-trip).
      next.lastFollowupSuggestion = {
        suggestion: event.suggestion,
        promptId: event.promptId,
      };
      break;
    case 'session.replay_complete':
      // Sidechannel signal only — consumers read it off the event
      // stream (or `selectors`) to drop a catch-up indicator. No
      // transcript mutation.
      break;
    case 'session.rewound':
      rewindTranscriptToUserTurn(next, event.targetTurnIndex);
      break;
    case 'session.branched':
      appendStatusBlock(
        next,
        'status',
        `Branched conversation "${event.displayName}". You are now in the branch.`,
        event,
      );
      break;
    case 'workspace.memory.changed':
    case 'workspace.agent.changed':
    case 'workspace.tool.toggled':
    case 'workspace.settings.changed':
    case 'workspace.initialized':
    case 'workspace.mcp.budget_warning':
    case 'workspace.mcp.child_refused':
    case 'workspace.mcp.server_restarted':
    case 'workspace.mcp.server_restart_refused':
    case 'auth.device_flow.started':
    case 'auth.device_flow.throttled':
    case 'auth.device_flow.authorized':
    case 'auth.device_flow.failed':
    case 'auth.device_flow.cancelled':
      // Intentional no-op against `blocks[]`. Sidechannel state machines
      // (introduced in PR-A follow-ups) consume these via `selectors.ts`.
      break;
    default:
      // Forward compatibility: ignore UI events from a newer daemon SDK that
      // this reducer does not project yet. `lastEventId` was already advanced.
      void event;
  }
}

function handleStateResyncRequired(
  state: DaemonTranscriptState,
  event: Extract<DaemonUiEvent, { type: 'session.state_resync_required' }>,
): void {
  state.awaitingResync = true;
  state.resyncRequiredCount += 1;
  state.lastResyncRequired = {
    reason: event.reason,
    lastDeliveredId: event.lastDeliveredId,
    earliestAvailableId: event.earliestAvailableId,
  };
  propagateCancellationToInFlightTools(state);
  appendStatusBlock(
    state,
    'error',
    `State resync required: ${formatMissedRange(event.lastDeliveredId, event.earliestAvailableId)}.`,
    event,
  );
}

/**
 * Format `missed daemon events X-Y` defensively. The naive formula
 * `lastDeliveredId+1 .. earliestAvailableId-1` produces inverted output
 * for `gap == 0` (next-id-is-next, no actual gap) and confusing
 * single-event range for `gap == 1`. Round all edge cases to natural
 * phrasing so the diagnostic stays readable.
 */
export function formatMissedRange(
  lastDeliveredId: number,
  earliestAvailableId: number,
): string {
  const first = lastDeliveredId + 1;
  const last = earliestAvailableId - 1;
  if (last < first) return 'no events lost (resync requested without gap)';
  if (last === first) return `missed 1 daemon event (id ${first})`;
  return `missed daemon events ${first}-${last}`;
}

export function selectTranscriptBlocks(
  state: DaemonTranscriptState,
): readonly DaemonTranscriptBlock[] {
  return state.blocks;
}

export function selectPendingPermissionBlocks(
  state: DaemonTranscriptState,
): ReadonlyArray<Extract<DaemonTranscriptBlock, { kind: 'permission' }>> {
  return state.blocks.filter(
    (block): block is Extract<DaemonTranscriptBlock, { kind: 'permission' }> =>
      block.kind === 'permission' && block.resolved === undefined,
  );
}

function finalizeStreamingTextBlock(
  state: DaemonTranscriptState,
  blockId: string | undefined,
): void {
  const block = getWritableBlockById(state, blockId);
  if (block?.kind === 'assistant' || block?.kind === 'thought') {
    block.streaming = false;
    block.updatedAt = state.now;
  }
}

function clearActiveAssistant(state: DaemonTranscriptState): void {
  finalizeStreamingTextBlock(state, state.activeAssistantBlockId);
  state.activeAssistantBlockId = undefined;
}

/**
 * Fold a round's token usage onto the active top-level assistant block. The
 * daemon emits usage right after that round's assistant text, so the active
 * block is the one it belongs to; multiple rounds accumulate, and renderers sum
 * a turn's blocks for the total.
 *
 * Sub-agent rounds (which arrive with a parentToolCallId) are folded in too:
 * their tokens are part of the spawning turn's real cost, and the parent is
 * blocked on the Task call while they run, so the top-level active block is
 * still that turn's. Excluding them made the turn under-count badly against
 * /stats. The sub-agent's own *text* still lives on its parent-keyed block; only
 * the usage counter rides the top-level block.
 *
 * No active block (a rare usage frame with no preceding top-level assistant
 * text) drops the count rather than minting a stray empty block.
 */
function applyAssistantUsage(
  state: DaemonTranscriptState,
  event: Extract<DaemonUiEvent, { type: 'assistant.usage' }>,
): void {
  const block = getWritableBlockById(state, state.activeAssistantBlockId);
  if (!block || block.kind !== 'assistant') return;
  const prev = block.usage;
  block.usage = {
    inputTokens: (prev?.inputTokens ?? 0) + event.usage.inputTokens,
    outputTokens: (prev?.outputTokens ?? 0) + event.usage.outputTokens,
    cachedTokens: (prev?.cachedTokens ?? 0) + (event.usage.cachedTokens ?? 0),
  };
  block.updatedAt = state.now;
}

function clearActiveThought(state: DaemonTranscriptState): void {
  finalizeStreamingTextBlock(state, state.activeThoughtBlockId);
  state.activeThoughtBlockId = undefined;
}

function clearActiveAssistantForParent(
  state: DaemonTranscriptState,
  parentToolCallId: string,
): void {
  finalizeStreamingTextBlock(
    state,
    state.activeAssistantBlockByParent[parentToolCallId],
  );
  delete state.activeAssistantBlockByParent[parentToolCallId];
}

function clearActiveThoughtForParent(
  state: DaemonTranscriptState,
  parentToolCallId: string,
): void {
  finalizeStreamingTextBlock(
    state,
    state.activeThoughtBlockByParent[parentToolCallId],
  );
  delete state.activeThoughtBlockByParent[parentToolCallId];
}

// Keyed (parentToolCallId) and scalar paths are independent, but replacing an
// active assistant/thought with another text kind must finalize the old block
// before clearing its active pointer.
function appendTextDelta(
  state: DaemonTranscriptState,
  kind: 'user' | 'assistant' | 'thought',
  activeKey:
    | 'activeUserBlockId'
    | 'activeAssistantBlockId'
    | 'activeThoughtBlockId',
  text: string,
  event: DaemonUiEvent,
): void {
  const parentId =
    kind !== 'user' && 'parentToolCallId' in event
      ? (event as DaemonUiTextEvent).parentToolCallId
      : undefined;

  const parentMap =
    parentId != null
      ? kind === 'assistant'
        ? state.activeAssistantBlockByParent
        : kind === 'thought'
          ? state.activeThoughtBlockByParent
          : undefined
      : undefined;

  const effectiveId =
    parentMap && parentId != null ? parentMap[parentId] : state[activeKey];

  const existing = getWritableBlockById(state, effectiveId);
  if (existing && existing.kind === kind) {
    existing.text = appendBoundedText(existing.text, text);
    existing.updatedAt = state.now;
    if (event.eventId !== undefined) existing.eventId = event.eventId;
    if (event.serverTimestamp !== undefined) {
      existing.serverTimestamp = event.serverTimestamp;
    }
    if (kind === 'assistant' || kind === 'thought') existing.streaming = true;
    return;
  }

  const block = createTextBlock(
    state,
    kind,
    text,
    event.eventId,
    event.serverTimestamp,
  );
  if (kind === 'assistant' || kind === 'thought') block.streaming = true;
  if (kind === 'thought') block.collapsed = true;
  if (parentId != null) {
    (block as DaemonTextTranscriptBlock).parentToolCallId = parentId;
  }
  appendBlock(state, block);

  if (parentMap && parentId != null) {
    parentMap[parentId] = block.id;
  } else {
    state[activeKey] = block.id;
  }

  if (parentId != null) {
    if (kind === 'assistant') {
      clearActiveThoughtForParent(state, parentId);
    }
    if (kind === 'thought') {
      clearActiveAssistantForParent(state, parentId);
    }
  } else {
    if (kind !== 'user') state.activeUserBlockId = undefined;
    if (kind !== 'assistant') clearActiveAssistant(state);
    if (kind !== 'thought') clearActiveThought(state);
  }
}

function finishAssistant(state: DaemonTranscriptState): void {
  clearActiveAssistant(state);

  for (const parentId of Object.keys(state.activeAssistantBlockByParent)) {
    clearActiveAssistantForParent(state, parentId);
  }
  for (const parentId of Object.keys(state.activeThoughtBlockByParent)) {
    clearActiveThoughtForParent(state, parentId);
  }
  clearActiveThought(state);
}

function upsertToolBlock(
  state: DaemonTranscriptState,
  event: Extract<DaemonUiEvent, { type: 'tool.update' }>,
): void {
  const existingId = state.toolBlockByCallId[event.toolCallId];
  if (existingId === TRIMMED_TOOL_BLOCK_ID) {
    if (shouldRecreateTrimmedToolBlock(event)) {
      delete state.toolBlockByCallId[event.toolCallId];
      delete state.trimmedToolNotificationByCallId[event.toolCallId];
      return upsertToolBlock(state, event);
    }
    if (!state.trimmedToolNotificationByCallId[event.toolCallId]) {
      state.trimmedToolNotificationByCallId[event.toolCallId] = true;
      appendStatusBlock(
        state,
        'error',
        `Tool ${event.toolCallId} output trimmed (max blocks reached)`,
        event,
        { clearActiveText: false },
      );
    }
    return;
  }
  const existing = getWritableBlockById(state, existingId);
  if (existing?.kind === 'tool') {
    if (event.title !== undefined) existing.title = event.title;
    if (event.status !== undefined) existing.status = event.status;
    if (event.rawInput !== undefined) {
      existing.preview = createDaemonToolPreview(event.rawInput, {
        title: event.title,
        toolName: event.toolName,
        toolKind: event.toolKind,
      });
    }
    existing.updatedAt = state.now;
    if (event.eventId !== undefined) existing.eventId = event.eventId;
    if (event.details) existing.details = event.details;
    if (event.content !== undefined) existing.content = event.content;
    if (event.locations !== undefined) existing.locations = event.locations;
    if (event.rawInput !== undefined) existing.rawInput = event.rawInput;
    if (event.rawOutput !== undefined) existing.rawOutput = event.rawOutput;
    if (event.toolName) existing.toolName = event.toolName;
    if (event.toolKind) existing.toolKind = event.toolKind;
    // PR-K subagent nesting — daemon may stamp parent context on later
    // updates (e.g., when SubAgentTracker first sees the call) AND the
    // parent block may also appear later than the child. Track two
    // resolutions independently:
    //   (a) parentToolCallId: adopt first non-empty stamp; never overwrite
    //   (b) parentBlockId: back-fill whenever the parent block becomes
    //       visible AND we don't yet have it, regardless of when (a)
    //       happened. This handles the out-of-order case where the child
    //       arrived with parent stamp before the parent block existed.
    if (event.parentToolCallId && !existing.parentToolCallId) {
      existing.parentToolCallId = event.parentToolCallId;
    }
    if (existing.parentToolCallId && !existing.parentBlockId) {
      const candidateId = state.toolBlockByCallId[existing.parentToolCallId];
      if (candidateId && candidateId !== TRIMMED_TOOL_BLOCK_ID) {
        existing.parentBlockId = candidateId;
      }
    }
    if (event.subagentType && !existing.subagentType) {
      existing.subagentType = event.subagentType;
    }
    updateCurrentToolPointer(state, event.toolCallId, event.status);
    return;
  }

  // PR-K subagent nesting — resolve `parentBlockId` at create time when
  // the parent's tool block already exists in state. Falls back to
  // undefined when the parent hasn't been seen yet (out-of-order events);
  // selectors fall back to `parentToolCallId` lookup in that case.
  const parentBlockId =
    event.parentToolCallId &&
    state.toolBlockByCallId[event.parentToolCallId] !== TRIMMED_TOOL_BLOCK_ID
      ? state.toolBlockByCallId[event.parentToolCallId]
      : undefined;
  const block: DaemonToolTranscriptBlock = {
    id: allocateBlockId(state, 'tool'),
    kind: 'tool',
    toolCallId: event.toolCallId,
    title: event.title ?? event.toolName ?? event.toolKind ?? 'Tool',
    status: event.status ?? 'pending',
    preview: createDaemonToolPreview(event.rawInput, {
      title: event.title,
      toolName: event.toolName,
      toolKind: event.toolKind,
    }),
    clientReceivedAt: state.now,
    createdAt: state.now,
    updatedAt: state.now,
    ...(event.eventId !== undefined ? { eventId: event.eventId } : {}),
    ...(event.serverTimestamp !== undefined
      ? { serverTimestamp: event.serverTimestamp }
      : {}),
    ...(event.details ? { details: event.details } : {}),
    ...(event.content !== undefined ? { content: event.content } : {}),
    ...(event.locations !== undefined ? { locations: event.locations } : {}),
    ...(event.rawInput !== undefined ? { rawInput: event.rawInput } : {}),
    ...(event.rawOutput !== undefined ? { rawOutput: event.rawOutput } : {}),
    ...(event.toolName ? { toolName: event.toolName } : {}),
    ...(event.toolKind ? { toolKind: event.toolKind } : {}),
    ...(event.parentToolCallId
      ? { parentToolCallId: event.parentToolCallId }
      : {}),
    ...(event.subagentType ? { subagentType: event.subagentType } : {}),
    ...(parentBlockId ? { parentBlockId } : {}),
  };
  appendBlock(state, block);
  state.toolBlockByCallId[event.toolCallId] = block.id;
  // PR-K back-fill: if any previously created child block recorded this
  // tool call as its parent (child-before-parent ordering) but couldn't
  // resolve `parentBlockId` at the time, fill it in now. Cheap O(n) scan;
  // only walks the live block array (no trimmed entries). Skipped entirely
  // for the common case (top-level tool with no children waiting).
  for (const candidate of state.blocks) {
    if (
      candidate.kind === 'tool' &&
      candidate.parentToolCallId === event.toolCallId &&
      !candidate.parentBlockId
    ) {
      const writable = getWritableBlockById(state, candidate.id);
      if (writable?.kind === 'tool') {
        writable.parentBlockId = block.id;
      }
    }
  }
  // Pass the EFFECTIVE status — the block
  // was just created with `event.status ?? 'pending'`. If we pass
  // raw `event.status === undefined`, `updateCurrentToolPointer` early-
  // returns and the block sits as visually-pending but currentToolCallId
  // never points at it. Effective-status keeps the pointer in sync
  // with what was actually written to the block.
  updateCurrentToolPointer(state, event.toolCallId, event.status ?? 'pending');
  clearActiveText(state, event.parentToolCallId);
}

/**
 * PR-E: maintain `state.currentToolCallId`. Sets when tool enters in-flight
 * status; clears when tool enters terminal status; leaves untouched for
 * unknown statuses (forward-compat).
 */
function updateCurrentToolPointer(
  state: DaemonTranscriptState,
  toolCallId: string,
  status: string | undefined,
): void {
  if (status === undefined) return;
  if (IN_FLIGHT_TOOL_STATUSES.has(status)) {
    state.currentToolCallId = toolCallId;
    return;
  }
  if (TERMINAL_TOOL_STATUSES.has(status)) {
    if (state.currentToolCallId === toolCallId) {
      state.currentToolCallId = findLatestInFlightToolCallId(state);
    }
    return;
  }
  // Unknown status (forward-compat): leave pointer as-is.
}

function findLatestInFlightToolCallId(
  state: DaemonTranscriptState,
): string | undefined {
  for (let index = state.blocks.length - 1; index >= 0; index -= 1) {
    const block = state.blocks[index];
    if (block?.kind !== 'tool') continue;
    if (IN_FLIGHT_TOOL_STATUSES.has(block.status)) return block.toolCallId;
  }
  return undefined;
}

/**
 * PR-E cancellation propagation: walk every tool block whose status is
 * still in-flight and force it to `'cancelled'`. Triggered when
 * `assistant.done.reason === 'cancelled'` since the daemon does not
 * guarantee a terminal `tool_call_update` for every in-flight tool when
 * the parent prompt is cancelled.
 */
function propagateCancellationToInFlightTools(
  state: DaemonTranscriptState,
): void {
  // Skip trimmed sentinels up front. Without this filter
  // each cancellation walked the entire historical tool-call index (which
  // can hold up to `maxBlocks` trimmed sentinels in long sessions), even
  // though only 1-3 tools are typically in-flight. The `block.kind` check
  // would correctly reject sentinels later, but only after a redundant
  // index dereference.
  for (const blockId of Object.values(state.toolBlockByCallId)) {
    if (blockId === TRIMMED_TOOL_BLOCK_ID) continue;
    const block = getWritableBlockById(state, blockId);
    if (!block || block.kind !== 'tool') continue;
    if (!IN_FLIGHT_TOOL_STATUSES.has(block.status)) continue;
    block.status = 'cancelled';
    block.updatedAt = state.now;
  }
  state.currentToolCallId = undefined;
}

function appendShellBlock(
  state: DaemonTranscriptState,
  event: Extract<DaemonUiEvent, { type: 'shell.output' }>,
): void {
  if (!event.text) return;
  const last = state.blocks[state.blocks.length - 1];
  if (last?.kind === 'shell' && last.stream === event.stream) {
    const writable = getWritableBlockById(state, last.id);
    if (writable?.kind === 'shell') {
      writable.text = appendBoundedText(writable.text, event.text);
      writable.updatedAt = state.now;
      if (event.eventId !== undefined) writable.eventId = event.eventId;
    }
    return;
  }

  const block: DaemonShellTranscriptBlock = {
    id: allocateBlockId(state, 'shell'),
    kind: 'shell',
    text: truncateText(event.text),
    clientReceivedAt: state.now,
    createdAt: state.now,
    updatedAt: state.now,
    ...(event.eventId !== undefined ? { eventId: event.eventId } : {}),
    ...(event.serverTimestamp !== undefined
      ? { serverTimestamp: event.serverTimestamp }
      : {}),
    ...(event.stream ? { stream: event.stream } : {}),
  };
  appendBlock(state, block);
  clearActiveText(state);
}

function appendUserShellBlock(
  state: DaemonTranscriptState,
  event: Extract<DaemonUiEvent, { type: 'user.shell.output' }>,
): void {
  if (!event.text) return;
  const last = state.blocks[state.blocks.length - 1];
  if (
    last?.kind === 'user_shell' &&
    last.stream === event.stream &&
    !state.pendingUserShellCommand
  ) {
    const writable = getWritableBlockById(state, last.id);
    if (writable?.kind === 'user_shell') {
      writable.text = appendBoundedText(writable.text, event.text);
      writable.updatedAt = state.now;
      if (event.eventId !== undefined) writable.eventId = event.eventId;
    }
    return;
  }

  const pending = state.pendingUserShellCommand;
  const previous = last?.kind === 'user_shell' ? last : undefined;
  const block: DaemonUserShellTranscriptBlock = {
    id: allocateBlockId(state, 'user-shell'),
    kind: 'user_shell',
    text: truncateText(event.text),
    command: pending?.command ?? previous?.command ?? '',
    ...(pending?.cwd || previous?.cwd
      ? { cwd: pending?.cwd ?? previous?.cwd }
      : {}),
    clientReceivedAt: state.now,
    createdAt: state.now,
    updatedAt: state.now,
    ...(event.eventId !== undefined ? { eventId: event.eventId } : {}),
    ...(event.serverTimestamp !== undefined
      ? { serverTimestamp: event.serverTimestamp }
      : {}),
    ...(event.stream ? { stream: event.stream } : {}),
  };
  state.pendingUserShellCommand = undefined;
  appendBlock(state, block);
  clearActiveText(state);
}

function upsertPermissionBlock(
  state: DaemonTranscriptState,
  event: Extract<DaemonUiEvent, { type: 'permission.request' }>,
): void {
  const existingId = state.permissionBlockByRequestId[event.requestId];
  if (existingId === TRIMMED_PERMISSION_BLOCK_ID) return;
  const existing = getWritableBlockById(state, existingId);
  const preview = createDaemonToolPreview(event.toolCall, {
    title: event.title,
  });
  if (existing?.kind === 'permission') {
    existing.title = event.title;
    existing.options = event.options.map((option) => ({ ...option }));
    existing.toolCall = event.toolCall;
    existing.preview = preview;
    existing.updatedAt = state.now;
    if (event.eventId !== undefined) existing.eventId = event.eventId;
    return;
  }

  const block: Extract<DaemonTranscriptBlock, { kind: 'permission' }> = {
    id: allocateBlockId(state, 'permission'),
    kind: 'permission',
    requestId: event.requestId,
    title: event.title,
    options: event.options.map((option) => ({ ...option })),
    preview,
    clientReceivedAt: state.now,
    createdAt: state.now,
    updatedAt: state.now,
    ...(event.eventId !== undefined ? { eventId: event.eventId } : {}),
    ...(event.serverTimestamp !== undefined
      ? { serverTimestamp: event.serverTimestamp }
      : {}),
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(event.toolCall !== undefined ? { toolCall: event.toolCall } : {}),
  };
  appendBlock(state, block);
  state.permissionBlockByRequestId[event.requestId] = block.id;
  clearActiveText(state);
}

function resolvePermissionBlock(
  state: DaemonTranscriptState,
  event: Extract<DaemonUiEvent, { type: 'permission.resolved' }>,
): void {
  // Mirror the `upsertPermissionBlock` guard at
  // line ~544. When `maxBlocks` trimming has already evicted the original
  // permission request block, the index still carries the
  // `TRIMMED_PERMISSION_BLOCK_ID` sentinel for that requestId. Without
  // this guard, the `permission.resolved` event would (a) fail the
  // `getWritableBlockById` lookup (sentinel is not a real block id) and
  // (b) fall through to create a brand-new orphan resolution block, which
  // wastes a slot, accelerates further trimming, and violates the
  // trimmed-block contract.
  // The prior fix guarded only the sentinel.
  // After `pruneTrimmedPermissionIndexes` deletes a sentinel (long
  // sessions), a late `permission.resolved` for that requestId hits
  // `existingId === undefined`, bypasses the sentinel check, falls
  // through to the create branch, and produces an orphan resolution
  // block. Reject both sentinel AND undefined: an unknown requestId at
  // resolution time means either it was trimmed long ago OR the
  // daemon is buggy — in either case, do NOT manifest a new block.
  const existingId = state.permissionBlockByRequestId[event.requestId];
  if (existingId === undefined || existingId === TRIMMED_PERMISSION_BLOCK_ID) {
    return;
  }
  const existing = getWritableBlockById(state, existingId);
  if (existing?.kind === 'permission') {
    existing.resolved = event.outcome;
    existing.updatedAt = state.now;
    if (event.eventId !== undefined) existing.eventId = event.eventId;
    return;
  }
  const block: Extract<DaemonTranscriptBlock, { kind: 'permission' }> = {
    id: allocateBlockId(state, 'permission'),
    kind: 'permission',
    requestId: event.requestId,
    title: `Permission resolved: ${event.requestId}`,
    options: [],
    preview: { kind: 'generic', summary: event.outcome },
    resolved: event.outcome,
    clientReceivedAt: state.now,
    createdAt: state.now,
    updatedAt: state.now,
    ...(event.eventId !== undefined ? { eventId: event.eventId } : {}),
    ...(event.serverTimestamp !== undefined
      ? { serverTimestamp: event.serverTimestamp }
      : {}),
  };
  appendBlock(state, block);
  state.permissionBlockByRequestId[event.requestId] = block.id;
  clearActiveText(state);
}

function appendStatusBlock(
  state: DaemonTranscriptState,
  kind: 'status' | 'error' | 'debug',
  text: string,
  event?: DaemonUiEvent,
  opts: { clearActiveText?: boolean } = {},
): void {
  const block: DaemonStatusTranscriptBlock = {
    id: allocateBlockId(state, kind),
    kind,
    text: truncateText(text),
    clientReceivedAt: state.now,
    createdAt: state.now,
    updatedAt: state.now,
    ...(event?.eventId !== undefined ? { eventId: event.eventId } : {}),
    ...(event?.serverTimestamp !== undefined
      ? { serverTimestamp: event.serverTimestamp }
      : {}),
    ...(event?.type === 'error' && event.code ? { code: event.code } : {}),
    ...(event?.type === 'error' && event.promptId
      ? { promptId: event.promptId }
      : {}),
    ...(event?.type === 'error' && event.source
      ? { source: event.source }
      : {}),
    ...((event?.type === 'status' || event?.type === 'debug') && event.source
      ? { source: event.source }
      : {}),
    ...((event?.type === 'status' || event?.type === 'debug') &&
    event.data !== undefined
      ? { data: event.data }
      : {}),
    ...(event?.type === 'session.branched'
      ? {
          source: 'session_branched',
          data: {
            sourceSessionId: event.sourceSessionId,
            newSessionId: event.newSessionId,
            displayName: event.displayName,
          },
        }
      : {}),
  };
  appendBlock(state, block);
  if (opts.clearActiveText !== false) clearActiveText(state);
}

function appendPromptCancelledBlock(
  state: DaemonTranscriptState,
  event: Extract<DaemonUiEvent, { type: 'prompt.cancelled' }>,
): void {
  const block: DaemonPromptCancelledTranscriptBlock = {
    id: allocateBlockId(state, 'prompt_cancelled'),
    kind: 'prompt_cancelled',
    clientReceivedAt: state.now,
    createdAt: state.now,
    updatedAt: state.now,
    ...(event.reason ? { reason: event.reason } : {}),
    ...(event.eventId !== undefined ? { eventId: event.eventId } : {}),
    ...(event.serverTimestamp !== undefined
      ? { serverTimestamp: event.serverTimestamp }
      : {}),
  };
  appendBlock(state, block);
  clearActiveText(state);
}

function createTextBlock(
  state: DaemonTranscriptState,
  kind: 'user' | 'assistant' | 'thought',
  text: string,
  eventId?: number,
  serverTimestamp?: number,
): DaemonTextTranscriptBlock {
  return {
    id: allocateBlockId(state, kind),
    kind,
    text: truncateText(text),
    clientReceivedAt: state.now,
    createdAt: state.now,
    updatedAt: state.now,
    ...(eventId !== undefined ? { eventId } : {}),
    ...(serverTimestamp !== undefined ? { serverTimestamp } : {}),
  };
}

function cloneTranscriptState(
  state: DaemonTranscriptState,
  opts: DaemonTranscriptReducerOptions,
): DaemonTranscriptState {
  return {
    ...state,
    now: opts.now ?? Date.now(),
    maxBlocks: opts.maxBlocks ?? state.maxBlocks,
    // Lazy copy-on-write for
    // `blocks` + `blockIndexById`. Eager `[...state.blocks]` defeated the
    // `sortedBlocksCache` / `childrenIndexCache` WeakMaps — every dispatch
    // (even sidechannel-only events that don't touch blocks) produced a
    // fresh `blocks` reference, so the caches never hit. Now share the
    // reference; `takeBlocksOwnership` below copies just-in-time at the
    // first mutation. Identical behavior; the only observable diff is
    // that snapshots for non-block-mutating events keep the same
    // `state.blocks` identity, which is exactly what `useSyncExternalStore`
    // consumers + the WeakMap caches want.
    blocks: state.blocks,
    blockIndexById: state.blockIndexById,
    toolBlockByCallId: { ...state.toolBlockByCallId },
    activeAssistantBlockByParent: { ...state.activeAssistantBlockByParent },
    activeThoughtBlockByParent: { ...state.activeThoughtBlockByParent },
    trimmedToolNotificationByCallId: {
      ...state.trimmedToolNotificationByCallId,
    },
    permissionBlockByRequestId: { ...state.permissionBlockByRequestId },
    // Deep-clone the inner progress records.
    // The outer spread alone shares `{ ratio?, step? }` references between
    // snapshots — once `tool.progress` event handlers start mutating in
    // place, the prior snapshot leaks. Pre-empt that here; cost is bounded
    // by `Object.keys(state.toolProgress).length` which is small (only
    // in-flight tools).
    toolProgress: Object.fromEntries(
      Object.entries(state.toolProgress).map(([k, v]) => [k, { ...v }]),
    ),
    lastResyncRequired:
      state.lastResyncRequired !== undefined
        ? { ...state.lastResyncRequired }
        : undefined,
    // Share the reference — the reducer assigns a new object when
    // updating (never mutates in-place), so reference stability across
    // unrelated dispatches lets `useSyncExternalStore` subscribers
    // (e.g. `useDaemonFollowupSuggestion`) skip re-renders for events
    // that don't touch the suggestion.
    lastFollowupSuggestion: state.lastFollowupSuggestion,
  };
}

function trimTranscriptState(
  state: DaemonTranscriptState,
): DaemonTranscriptState {
  if (state.blocks.length <= state.maxBlocks) return state;
  const blocks = state.blocks.slice(-state.maxBlocks);
  const keptIds = new Set(blocks.map((block) => block.id));
  state.blocks = blocks;
  state.blockIndexById = rebuildDaemonTranscriptBlockIndex(blocks);
  // Trim replaces both arrays with fresh objects; register that this
  // state now owns its blocks so future appends in the same dispatch
  // don't double-copy.
  ownedBlocks.set(state, state.blocks);
  for (const [toolCallId, blockId] of Object.entries(state.toolBlockByCallId)) {
    if (!keptIds.has(blockId)) {
      state.toolBlockByCallId[toolCallId] = TRIMMED_TOOL_BLOCK_ID;
    }
  }
  pruneTrimmedToolIndexes(state);
  for (const [toolCallId] of Object.entries(
    state.trimmedToolNotificationByCallId,
  )) {
    if (state.toolBlockByCallId[toolCallId] !== TRIMMED_TOOL_BLOCK_ID) {
      delete state.trimmedToolNotificationByCallId[toolCallId];
    }
  }
  for (const [requestId, blockId] of Object.entries(
    state.permissionBlockByRequestId,
  )) {
    if (!keptIds.has(blockId)) {
      state.permissionBlockByRequestId[requestId] = TRIMMED_PERMISSION_BLOCK_ID;
    }
  }
  pruneTrimmedPermissionIndexes(state);
  // PR-K: tool blocks that survived trimming may still reference a
  // `parentBlockId` whose parent was just trimmed. The dangling id no
  // longer resolves via `blockIndexById`. Null it to give renderers a
  // clear "parent gone" signal. `parentToolCallId` stays — selectors keyed
  // on tool call id (not block id) survive trimming, and a downstream
  // re-fetch could resurrect the relationship if the parent ever
  // re-enters state via replay.
  for (const block of state.blocks) {
    if (block.kind !== 'tool') continue;
    if (block.parentBlockId && !keptIds.has(block.parentBlockId)) {
      const writable = getWritableBlockById(state, block.id);
      if (writable?.kind === 'tool') {
        writable.parentBlockId = undefined;
      }
    }
  }
  if (!keptIds.has(state.activeUserBlockId ?? '')) {
    state.activeUserBlockId = undefined;
  }
  if (!keptIds.has(state.activeAssistantBlockId ?? '')) {
    state.activeAssistantBlockId = undefined;
  }
  if (!keptIds.has(state.activeThoughtBlockId ?? '')) {
    state.activeThoughtBlockId = undefined;
  }
  for (const [parentId, blockId] of Object.entries(
    state.activeAssistantBlockByParent,
  )) {
    if (!keptIds.has(blockId)) {
      delete state.activeAssistantBlockByParent[parentId];
    }
  }
  for (const [parentId, blockId] of Object.entries(
    state.activeThoughtBlockByParent,
  )) {
    if (!keptIds.has(blockId)) {
      delete state.activeThoughtBlockByParent[parentId];
    }
  }
  return state;
}

function shouldRecreateTrimmedToolBlock(
  event: Extract<DaemonUiEvent, { type: 'tool.update' }>,
): boolean {
  return (
    event.toolCallId === DAEMON_PLAN_TOOL_CALL_ID ||
    event.toolKind === 'updated_plan'
  );
}

/**
 * Lazy copy-on-write for `state.blocks` / `state.blockIndexById`.
 *
 * `cloneTranscriptState` shares the parent's `blocks` reference (not
 * eager-copies) so non-block-mutating events keep the same array
 * identity — enabling the `sortedBlocksCache` / `childrenIndexCache`
 * WeakMaps to actually hit across dispatches. The first call to this
 * helper within a given reducer pass converts the shared reference into
 * an owned copy; subsequent calls in the same dispatch are no-ops
 * (already owned).
 *
 * Ownership is tracked via the module-level `ownedBlocks` WeakMap keyed
 * on the state object. The WeakMap value matches `state.blocks` once
 * the state has taken ownership of that array.
 */
const ownedBlocks = new WeakMap<
  DaemonTranscriptState,
  readonly DaemonTranscriptBlock[]
>();

function takeBlocksOwnership(state: DaemonTranscriptState): void {
  if (ownedBlocks.get(state) === state.blocks) return;
  state.blocks = [...state.blocks];
  state.blockIndexById = { ...state.blockIndexById };
  ownedBlocks.set(state, state.blocks);
}

// Applies a daemon rewind event to this in-memory transcript only. The target
// user turn and everything after it are removed so the rendered session view
// matches the already-rewound backend state.
function rewindTranscriptToUserTurn(
  state: DaemonTranscriptState,
  targetTurnIndex: number,
): void {
  let userTurn = 0;
  let lastUserIndex = -1;
  for (let index = 0; index < state.blocks.length; index += 1) {
    if (state.blocks[index]?.kind !== 'user') continue;
    lastUserIndex = index;
    if (userTurn === targetTurnIndex) {
      truncateTranscriptBeforeBlock(state, index);
      return;
    }
    userTurn += 1;
  }
  if (lastUserIndex >= 0 && targetTurnIndex >= userTurn) {
    truncateTranscriptBeforeBlock(state, lastUserIndex);
  }
}

function truncateTranscriptBeforeBlock(
  state: DaemonTranscriptState,
  blockIndex: number,
): void {
  takeBlocksOwnership(state);
  state.blocks = state.blocks.slice(0, blockIndex);
  ownedBlocks.set(state, state.blocks);
  state.blockIndexById = rebuildDaemonTranscriptBlockIndex(state.blocks);
  state.toolBlockByCallId = {};
  state.permissionBlockByRequestId = {};
  for (const block of state.blocks) {
    if (block.kind === 'tool')
      state.toolBlockByCallId[block.toolCallId] = block.id;
    if (block.kind === 'permission') {
      state.permissionBlockByRequestId[block.requestId] = block.id;
    }
  }
  state.trimmedToolNotificationByCallId = {};
  state.activeUserBlockId = undefined;
  state.activeAssistantBlockId = undefined;
  state.activeThoughtBlockId = undefined;
  state.activeAssistantBlockByParent = {};
  state.activeThoughtBlockByParent = {};
  state.currentToolCallId = undefined;
  state.pendingUserShellCommand = undefined;
  state.lastFollowupSuggestion = undefined;
  state.toolProgress = {};
}

function appendBlock(
  state: DaemonTranscriptState,
  block: DaemonTranscriptBlock,
): void {
  takeBlocksOwnership(state);
  state.blockIndexById[block.id] = state.blocks.length;
  (state.blocks as DaemonTranscriptBlock[]).push(block);
}

function getWritableBlockById(
  state: DaemonTranscriptState,
  blockId: string | undefined,
): DaemonTranscriptBlock | undefined {
  if (!blockId) return undefined;
  const index = state.blockIndexById[blockId];
  if (index === undefined) return undefined;
  const block = state.blocks[index];
  if (!block || block.id !== blockId) return undefined;
  const cloned = cloneBlockForWrite(block);
  // Lazy COW: this writes to `state.blocks[index]`. Without ownership,
  // we'd mutate the parent state's array. Take ownership first.
  takeBlocksOwnership(state);
  (state.blocks as DaemonTranscriptBlock[])[index] = cloned;
  return cloned;
}

function cloneBlockForWrite(
  block: DaemonTranscriptBlock,
): DaemonTranscriptBlock {
  if (block.kind === 'permission') {
    return {
      ...block,
      options: block.options.map((option) => cloneJsonLike(option)),
      toolCall: cloneJsonLike(block.toolCall),
      preview: cloneJsonLike(block.preview),
    };
  }
  if (block.kind === 'tool') {
    return {
      ...block,
      preview: cloneJsonLike(block.preview),
      content: cloneJsonLike(block.content),
      locations: cloneJsonLike(block.locations),
      rawInput: cloneJsonLike(block.rawInput),
      rawOutput: cloneJsonLike(block.rawOutput),
    };
  }
  return { ...block };
}

function allocateBlockId(state: DaemonTranscriptState, prefix: string): string {
  const id = `${prefix}-${state.nextOrdinal}`;
  state.nextOrdinal += 1;
  return id;
}

function clearActiveText(
  state: DaemonTranscriptState,
  parentToolCallId?: string,
): void {
  if (parentToolCallId) {
    clearActiveAssistantForParent(state, parentToolCallId);
    clearActiveThoughtForParent(state, parentToolCallId);
  } else {
    finishAssistant(state);
    state.activeUserBlockId = undefined;
  }
}

function appendBoundedText(existing: string, text: string): string {
  if (existing.length >= MAX_TEXT_BLOCK_LENGTH) return existing;
  return truncateText(existing + text);
}

function truncateText(text: string): string {
  if (text.length <= MAX_TEXT_BLOCK_LENGTH) return text;
  const keepLength = Math.max(
    0,
    MAX_TEXT_BLOCK_LENGTH - TEXT_TRUNCATED_SUFFIX.length,
  );
  return `${text.slice(0, keepLength)}${TEXT_TRUNCATED_SUFFIX}`;
}

function pruneTrimmedToolIndexes(state: DaemonTranscriptState): void {
  const maxTrimmedEntries = Math.max(0, state.maxBlocks);
  const trimmedToolCallIds = Object.entries(state.toolBlockByCallId)
    .filter(([, blockId]) => blockId === TRIMMED_TOOL_BLOCK_ID)
    .map(([toolCallId]) => toolCallId);
  const overflow = trimmedToolCallIds.length - maxTrimmedEntries;
  if (overflow <= 0) return;
  for (const toolCallId of trimmedToolCallIds.slice(0, overflow)) {
    delete state.toolBlockByCallId[toolCallId];
    delete state.trimmedToolNotificationByCallId[toolCallId];
  }
}

/**
 * Mirror `pruneTrimmedToolIndexes` for the
 * permission index. In long sessions where many permission requests are
 * trimmed out, `permissionBlockByRequestId` would grow unboundedly
 * because the trimmed sentinel `TRIMMED_PERMISSION_BLOCK_ID` is written
 * by `trimTranscriptState` but never deleted. Cap to `maxBlocks` worth
 * of trimmed entries — beyond that, the historical record of
 * "this requestId was once seen" stops being useful (any later resolved
 * event will fall through and we'd still rather drop it than orphan).
 */
function pruneTrimmedPermissionIndexes(state: DaemonTranscriptState): void {
  const maxTrimmedEntries = Math.max(0, state.maxBlocks);
  const trimmedRequestIds = Object.entries(state.permissionBlockByRequestId)
    .filter(([, blockId]) => blockId === TRIMMED_PERMISSION_BLOCK_ID)
    .map(([requestId]) => requestId);
  const overflow = trimmedRequestIds.length - maxTrimmedEntries;
  if (overflow <= 0) return;
  for (const requestId of trimmedRequestIds.slice(0, overflow)) {
    delete state.permissionBlockByRequestId[requestId];
  }
}

function cloneJsonLike<T>(value: T, depth = 0): T {
  if (depth > MAX_CLONE_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => cloneJsonLike(entry, depth + 1)) as T;
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        cloneJsonLike(entry, depth + 1),
      ]),
    ) as T;
  }
  return value;
}

/* ──────────────────────────────────────────────────────────────────────────
 * PR-B helpers: timestamp ordering + formatting
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Return transcript blocks sorted by **daemon-authoritative** ordering. Use
 * this instead of `state.blocks` when displaying a long session where event
 * id 5 may arrive AFTER event id 7 (typical in SSE replay-after-reconnect).
 *
 * Ordering precedence:
 *   1. `eventId` (daemon-monotonic SSE cursor) — primary key
 *   2. `serverTimestamp` (daemon wall clock) — fallback for synthetic frames
 *   3. `clientReceivedAt` (local clock) — last resort
 *
 * Returns a new array — callers can rely on referential stability of
 * untouched blocks (structural sharing in the reducer) but the array
 * itself is fresh.
 */
/**
 * Memoize by `state.blocks` array reference. The reducer
 * already preserves the same array reference for non-block-mutating events
 * (approval_mode change, session metadata, status, etc.), so this WeakMap
 * cache returns the same sorted array across renders that don't touch
 * `blocks`. Frees React `useSyncExternalStore`-style consumers from the
 * O(n log n) re-sort on every dispatch.
 */
const sortedBlocksCache = new WeakMap<
  readonly DaemonTranscriptBlock[],
  readonly DaemonTranscriptBlock[]
>();

export function selectTranscriptBlocksOrderedByEventId(
  state: DaemonTranscriptState,
): readonly DaemonTranscriptBlock[] {
  const cached = sortedBlocksCache.get(state.blocks);
  if (cached) return cached;
  const orderKeyByBlockId = buildEventOrderKeys(state.blocks);
  const sorted = [...state.blocks].sort((a, b) =>
    compareBlocksByEventOrder(a, b, orderKeyByBlockId),
  );
  sortedBlocksCache.set(state.blocks, sorted);
  return sorted;
}

/* ──────────────────────────────────────────────────────────────────────────
 * PR-E selectors — sidechannel state queries
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Return the currently-running tool block, or `undefined` when no tool is
 * in flight. Used by UI to render a "正在运行 X" header without scanning
 * `blocks[]`.
 */
export function selectCurrentTool(
  state: DaemonTranscriptState,
): Extract<DaemonTranscriptBlock, { kind: 'tool' }> | undefined {
  const id = state.currentToolCallId;
  if (!id) return undefined;
  const blockId = state.toolBlockByCallId[id];
  if (!blockId || blockId === TRIMMED_TOOL_BLOCK_ID) return undefined;
  const index = state.blockIndexById[blockId];
  if (index === undefined) return undefined;
  const block = state.blocks[index];
  return block?.kind === 'tool' ? block : undefined;
}

/**
 * Approval mode currently active for the session, mirrored from
 * `session.approval_mode.changed` events. `undefined` until the daemon
 * emits at least one change event.
 */
export function selectApprovalMode(
  state: DaemonTranscriptState,
): string | undefined {
  return state.approvalMode;
}

/**
 * Most recent follow-up suggestion observed for the session, mirrored
 * from `followup.suggestion` events. Adapters render the `suggestion`
 * as ghost-text in their input placeholder. Returns `undefined` until
 * the daemon emits at least one suggestion, or after the consumer
 * clears it via `clearFollowupSuggestion` (typically on sendPrompt).
 */
export function selectLastFollowupSuggestion(
  state: DaemonTranscriptState,
): { suggestion: string; promptId: string } | undefined {
  return state.lastFollowupSuggestion;
}

/**
 * Per-tool progress query. Returns `undefined` if no progress has been
 * recorded for the given toolCallId. The shape `{ ratio?, step? }` matches
 * the eventual `tool.progress` event payload (daemon-side emission
 * pending — SDK is ready to consume).
 *
 * @alpha The daemon does not emit `tool.progress` yet, so this selector is
 * provisional until that event lands.
 */
export function selectToolProgress(
  state: DaemonTranscriptState,
  toolCallId: string,
): { ratio?: number; step?: string } | undefined {
  return state.toolProgress[toolCallId];
}

/**
 * PR-K (post-rebase): return the **direct** child tool blocks of a given
 * sub-agent delegation, identified by the parent tool call id (the
 * `toolCallId` of the `Task`-equivalent tool the main agent called).
 *
 * Renderers use this to draw a nested view: render the parent tool block
 * as a folder header and the children as indented descendants. To walk
 * transitive descendants (nested sub-agents), call recursively on each
 * child's `toolCallId`.
 *
 * Returns an empty array when the parent has no recorded children, e.g.,
 * the daemon hasn't seen any sub-agent activity yet or the children were
 * already trimmed by `maxBlocks`. Blocks are returned in insertion order
 * (i.e., the order the reducer accumulated them).
 *
 * Daemon does not emit cycles, but a hypothetical buggy emit (A→B, B→A)
 * would surface as mutual children here; renderers walking parents must
 * detect cycles defensively.
 */
/**
 * Memoized reverse index. The naive `state.blocks.filter`
 * was O(n) per call; in a render tree with m parent blocks each querying
 * their children, total work was O(n*m). Now we build a single
 * `Map<parentToolCallId, DaemonToolTranscriptBlock[]>` lazily per
 * `state.blocks` reference (via WeakMap) — each lookup becomes O(1)
 * after the first call for a given snapshot.
 */
const childrenIndexCache = new WeakMap<
  readonly DaemonTranscriptBlock[],
  Map<string, readonly DaemonToolTranscriptBlock[]>
>();

const EMPTY_CHILD_LIST: readonly DaemonToolTranscriptBlock[] = Object.freeze(
  [],
);

function getOrBuildChildrenIndex(
  blocks: readonly DaemonTranscriptBlock[],
): Map<string, readonly DaemonToolTranscriptBlock[]> {
  const cached = childrenIndexCache.get(blocks);
  if (cached) return cached;
  const mutable = new Map<string, DaemonToolTranscriptBlock[]>();
  for (const block of blocks) {
    if (block.kind !== 'tool' || !block.parentToolCallId) continue;
    const list = mutable.get(block.parentToolCallId);
    if (list) list.push(block);
    else mutable.set(block.parentToolCallId, [block]);
  }
  // Freeze each child list at build time so
  // consumers can hold the cached reference across renders (React.memo /
  // useMemo identity remains stable) without risk of in-place mutation
  // corrupting other consumers sharing the same `state.blocks`
  // snapshot. Supersedes the earlier "[...cached]" shallow copy from
  // glm-5.1 — that defended against mutation but defeated identity
  // stability; freezing achieves both.
  const frozen = new Map<string, readonly DaemonToolTranscriptBlock[]>();
  for (const [parentId, list] of mutable) {
    frozen.set(parentId, Object.freeze(list));
  }
  childrenIndexCache.set(blocks, frozen);
  return frozen;
}

export function selectSubagentChildBlocks(
  state: DaemonTranscriptState,
  parentToolCallId: string,
): readonly DaemonToolTranscriptBlock[] {
  return (
    getOrBuildChildrenIndex(state.blocks).get(parentToolCallId) ??
    EMPTY_CHILD_LIST
  );
}

/**
 * Return whether a given tool block was invoked inside a sub-agent
 * delegation (has `parentToolCallId` set). Convenience for renderers
 * dispatching on flat-vs-nested rendering.
 */
export function isSubagentChildBlock(
  block: DaemonTranscriptBlock,
): block is DaemonToolTranscriptBlock {
  return block.kind === 'tool' && block.parentToolCallId !== undefined;
}

function compareBlocksByEventOrder(
  a: DaemonTranscriptBlock,
  b: DaemonTranscriptBlock,
  orderKeyByBlockId: ReadonlyMap<string, number>,
): number {
  const orderDelta =
    (orderKeyByBlockId.get(a.id) ?? 0) - (orderKeyByBlockId.get(b.id) ?? 0);
  if (orderDelta !== 0) return orderDelta;
  if (a.serverTimestamp !== undefined && b.serverTimestamp !== undefined) {
    return a.serverTimestamp - b.serverTimestamp;
  }
  // Last resort: client clock at the moment of receipt.
  return a.clientReceivedAt - b.clientReceivedAt;
}

function buildEventOrderKeys(
  blocks: readonly DaemonTranscriptBlock[],
): ReadonlyMap<string, number> {
  const orderKeyByBlockId = new Map<string, number>();
  let lastDaemonEventId: number | undefined;
  blocks.forEach((block, index) => {
    if (block.eventId !== undefined) {
      lastDaemonEventId = block.eventId;
      orderKeyByBlockId.set(block.id, block.eventId);
      return;
    }
    const syntheticBase =
      lastDaemonEventId === undefined
        ? Number.MIN_SAFE_INTEGER
        : lastDaemonEventId + 0.5;
    orderKeyByBlockId.set(block.id, syntheticBase + index / 1_000_000);
  });
  return orderKeyByBlockId;
}

/**
 * Format the most authoritative timestamp on a block as a localized
 * string. Prefers `serverTimestamp` (cross-client consistent), falls back
 * to `clientReceivedAt` (always set, but client-clock).
 *
 * Returns `''` if the block has neither — defensive against future block
 * types that may not carry timestamps.
 *
 * @example
 *   formatBlockTimestamp(block) // "2026-05-20 14:32:18"
 *   formatBlockTimestamp(block, { locale: 'zh-CN', timeStyle: 'short' })
 */
export function formatBlockTimestamp(
  block: DaemonTranscriptBlock,
  opts: TimestampFormatOptions = {},
): string {
  const ts = block.serverTimestamp ?? block.clientReceivedAt;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '';
  return getTimestampFormatter(opts).format(new Date(ts));
}

function getTimestampFormatter(
  opts: TimestampFormatOptions,
): Intl.DateTimeFormat {
  const key = JSON.stringify([
    opts.locale ?? '',
    opts.timeZone ?? '',
    opts.dateStyle ?? 'short',
    opts.timeStyle ?? 'medium',
  ]);
  const cached = timestampFormatterCache.get(key);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat(opts.locale, {
    ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
    dateStyle: opts.dateStyle ?? 'short',
    timeStyle: opts.timeStyle ?? 'medium',
  });
  timestampFormatterCache.set(key, formatter);
  return formatter;
}
