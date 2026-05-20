/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonShellTranscriptBlock,
  DaemonStatusTranscriptBlock,
  DaemonTextTranscriptBlock,
  DaemonToolTranscriptBlock,
  DaemonTranscriptBlock,
  DaemonTranscriptReducerOptions,
  DaemonTranscriptState,
  DaemonUiEvent,
} from './types.js';
import { DAEMON_PLAN_TOOL_CALL_ID } from './types.js';
import { createDaemonToolPreview } from './toolPreview.js';
import { isRecord } from './utils.js';

const DEFAULT_MAX_BLOCKS = 1_000;
const TRIMMED_TOOL_BLOCK_ID = '__trimmed_tool_block__';
const MAX_TEXT_BLOCK_LENGTH = 100_000;
const TEXT_TRUNCATED_SUFFIX = '\n[truncated]\n';
const MAX_CLONE_DEPTH = 16;

export function createDaemonTranscriptState(
  opts: DaemonTranscriptReducerOptions = {},
): DaemonTranscriptState {
  return {
    blocks: [],
    blockIndexById: {},
    toolBlockByCallId: {},
    trimmedToolNotificationByCallId: {},
    permissionBlockByRequestId: {},
    // PR-E sidechannel: track current tool / approval mode / progress
    toolProgress: {},
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

export function appendLocalUserTranscriptMessage(
  state: DaemonTranscriptState,
  text: string,
  opts: DaemonTranscriptReducerOptions = {},
): DaemonTranscriptState {
  const next = cloneTranscriptState(state, opts);
  const block = createTextBlock(next, 'user', text);
  appendBlock(next, block);
  next.activeUserBlockId = block.id;
  next.activeAssistantBlockId = undefined;
  next.activeThoughtBlockId = undefined;
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
  return trimTranscriptState(next);
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

  switch (event.type) {
    case 'user.text.delta':
      appendTextDelta(next, 'user', 'activeUserBlockId', event.text, event);
      break;
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
      // PR-E cancellation propagation: when the assistant turn was
      // cancelled, any in-flight tool block whose status the daemon
      // never updated to a terminal state would otherwise spin forever.
      // Force them to 'cancelled' so renderers can clear spinners.
      if (event.reason === 'cancelled') {
        propagateCancellationToInFlightTools(next);
      }
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
    case 'workspace.memory.changed':
    case 'workspace.agent.changed':
    case 'workspace.tool.toggled':
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
      assertNever(event);
  }
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
  const existing = getWritableBlockById(state, state[activeKey]);
  if (existing && existing.kind === kind) {
    existing.text = appendBoundedText(existing.text, text);
    existing.updatedAt = state.now;
    if (event.eventId !== undefined) existing.eventId = event.eventId;
    if (kind === 'assistant') existing.streaming = true;
    return;
  }

  const block = createTextBlock(
    state,
    kind,
    text,
    event.eventId,
    event.serverTimestamp,
  );
  if (kind === 'assistant') block.streaming = true;
  if (kind === 'thought') block.collapsed = true;
  appendBlock(state, block);
  state[activeKey] = block.id;
  if (kind !== 'user') state.activeUserBlockId = undefined;
  if (kind !== 'assistant') state.activeAssistantBlockId = undefined;
  if (kind !== 'thought') state.activeThoughtBlockId = undefined;
}

function finishAssistant(state: DaemonTranscriptState): void {
  const existing = getWritableBlockById(state, state.activeAssistantBlockId);
  if (existing?.kind === 'assistant') {
    existing.streaming = false;
    existing.updatedAt = state.now;
  }
  state.activeAssistantBlockId = undefined;
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
    updateCurrentToolPointer(state, event.toolCallId, event.status);
    return;
  }

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
  };
  appendBlock(state, block);
  state.toolBlockByCallId[event.toolCallId] = block.id;
  updateCurrentToolPointer(state, event.toolCallId, event.status);
  clearActiveText(state);
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
      state.currentToolCallId = undefined;
    }
    return;
  }
  // Unknown status (forward-compat): leave pointer as-is.
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
  for (const blockId of Object.values(state.toolBlockByCallId)) {
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

function upsertPermissionBlock(
  state: DaemonTranscriptState,
  event: Extract<DaemonUiEvent, { type: 'permission.request' }>,
): void {
  const existingId = state.permissionBlockByRequestId[event.requestId];
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
  const existing = getWritableBlockById(
    state,
    state.permissionBlockByRequestId[event.requestId],
  );
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
  };
  appendBlock(state, block);
  if (opts.clearActiveText !== false) clearActiveText(state);
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
    blocks: [...state.blocks],
    blockIndexById: { ...state.blockIndexById },
    toolBlockByCallId: { ...state.toolBlockByCallId },
    trimmedToolNotificationByCallId: {
      ...state.trimmedToolNotificationByCallId,
    },
    permissionBlockByRequestId: { ...state.permissionBlockByRequestId },
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
    if (!keptIds.has(blockId))
      delete state.permissionBlockByRequestId[requestId];
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

function appendBlock(
  state: DaemonTranscriptState,
  block: DaemonTranscriptBlock,
): void {
  state.blockIndexById[block.id] = state.blocks.length;
  state.blocks.push(block);
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
  state.blocks[index] = cloned;
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

function clearActiveText(state: DaemonTranscriptState): void {
  finishAssistant(state);
  state.activeUserBlockId = undefined;
  state.activeThoughtBlockId = undefined;
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

function assertNever(value: never): never {
  throw new Error(
    `Unhandled daemon transcript event: ${JSON.stringify(value)}`,
  );
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
export function selectTranscriptBlocksOrderedByEventId(
  state: DaemonTranscriptState,
): readonly DaemonTranscriptBlock[] {
  return [...state.blocks].sort(compareBlocksByEventOrder);
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
 * Per-tool progress query. Returns `undefined` if no progress has been
 * recorded for the given toolCallId. The shape `{ ratio?, step? }` matches
 * the eventual `tool.progress` event payload (daemon-side emission
 * pending — SDK is ready to consume).
 */
export function selectToolProgress(
  state: DaemonTranscriptState,
  toolCallId: string,
): { ratio?: number; step?: string } | undefined {
  return state.toolProgress[toolCallId];
}

function compareBlocksByEventOrder(
  a: DaemonTranscriptBlock,
  b: DaemonTranscriptBlock,
): number {
  // Primary: eventId (monotonic when present).
  if (a.eventId !== undefined && b.eventId !== undefined) {
    return a.eventId - b.eventId;
  }
  if (a.eventId !== undefined) return -1;
  if (b.eventId !== undefined) return 1;
  // Fallback: serverTimestamp.
  if (a.serverTimestamp !== undefined && b.serverTimestamp !== undefined) {
    return a.serverTimestamp - b.serverTimestamp;
  }
  if (a.serverTimestamp !== undefined) return -1;
  if (b.serverTimestamp !== undefined) return 1;
  // Last resort: client clock at the moment of receipt.
  return a.clientReceivedAt - b.clientReceivedAt;
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
  opts: {
    locale?: string;
    timeZone?: string;
    timeStyle?: 'short' | 'medium' | 'long' | 'full';
    dateStyle?: 'short' | 'medium' | 'long' | 'full';
  } = {},
): string {
  const ts = block.serverTimestamp ?? block.clientReceivedAt;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '';
  const formatter = new Intl.DateTimeFormat(opts.locale, {
    ...(opts.timeZone ? { timeZone: opts.timeZone } : {}),
    ...(opts.dateStyle
      ? { dateStyle: opts.dateStyle }
      : { dateStyle: 'short' }),
    ...(opts.timeStyle
      ? { timeStyle: opts.timeStyle }
      : { timeStyle: 'medium' }),
  });
  return formatter.format(new Date(ts));
}
