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
    nextOrdinal: 1,
    now: opts.now ?? Date.now(),
    maxBlocks: opts.maxBlocks ?? DEFAULT_MAX_BLOCKS,
  };
}

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

  const block = createTextBlock(state, kind, text, event.eventId);
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
    createdAt: state.now,
    updatedAt: state.now,
    ...(event.eventId !== undefined ? { eventId: event.eventId } : {}),
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
  clearActiveText(state);
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
    createdAt: state.now,
    updatedAt: state.now,
    ...(event.eventId !== undefined ? { eventId: event.eventId } : {}),
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
    createdAt: state.now,
    updatedAt: state.now,
    ...(event.eventId !== undefined ? { eventId: event.eventId } : {}),
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
    createdAt: state.now,
    updatedAt: state.now,
    ...(event.eventId !== undefined ? { eventId: event.eventId } : {}),
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
    createdAt: state.now,
    updatedAt: state.now,
    ...(event?.eventId !== undefined ? { eventId: event.eventId } : {}),
  };
  appendBlock(state, block);
  if (opts.clearActiveText !== false) clearActiveText(state);
}

function createTextBlock(
  state: DaemonTranscriptState,
  kind: 'user' | 'assistant' | 'thought',
  text: string,
  eventId?: number,
): DaemonTextTranscriptBlock {
  return {
    id: allocateBlockId(state, kind),
    kind,
    text: truncateText(text),
    createdAt: state.now,
    updatedAt: state.now,
    ...(eventId !== undefined ? { eventId } : {}),
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
