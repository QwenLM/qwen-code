/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ContentBlock,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import {
  ToolCallStatus,
  type HistoryItemToolGroup,
  type HistoryItemWithoutId,
  type IndividualToolCallDisplay,
} from '../types.js';

export interface DaemonTuiEvent {
  id?: number;
  v: 1;
  type: string;
  data: unknown;
  originatorClientId?: string;
}

export interface DaemonTuiPromptResult {
  stopReason?: string;
  [key: string]: unknown;
}

export interface DaemonTuiSessionClient {
  readonly sessionId: string;
  readonly workspaceCwd: string;
  readonly lastEventId?: number;
  prompt(
    req: { prompt: ContentBlock[] },
    signal?: AbortSignal,
  ): Promise<DaemonTuiPromptResult>;
  events(opts?: {
    signal?: AbortSignal;
    lastEventId?: number;
    resume?: boolean;
  }): AsyncGenerator<DaemonTuiEvent>;
  cancel(): Promise<void>;
  setModel(modelId: string): Promise<Record<string, unknown>>;
  respondToPermission(
    requestId: string,
    response: RequestPermissionResponse,
  ): Promise<boolean>;
}

export type DaemonTuiUpdate =
  | {
      type: 'history';
      item: HistoryItemWithoutId;
      daemonEventId?: number;
    }
  | {
      type: 'permission_request';
      requestId: string;
      request: RequestPermissionRequest;
      daemonEventId?: number;
    }
  | {
      type: 'tool_group_update';
      item: HistoryItemToolGroup;
      daemonEventId?: number;
    }
  | {
      type: 'permission_resolved';
      requestId: string;
      outcome?: unknown;
      daemonEventId?: number;
    }
  | {
      type: 'model_switched';
      modelId: string;
      daemonEventId?: number;
    }
  | {
      type: 'disconnected';
      reason: string;
      daemonEventId?: number;
    };

export interface DaemonTuiAdapterOptions {
  session: DaemonTuiSessionClient;
  onUpdate: (update: DaemonTuiUpdate) => void;
}

export interface DaemonTuiReducerState {
  toolCallsById: Map<string, IndividualToolCallDisplay>;
  toolCallOrder: string[];
}

export function createDaemonTuiReducerState(): DaemonTuiReducerState {
  return { toolCallsById: new Map(), toolCallOrder: [] };
}

function clearDaemonTuiReducerState(state: DaemonTuiReducerState): void {
  state.toolCallsById.clear();
  state.toolCallOrder.length = 0;
}

const MAX_TOOL_CALLS = 128;
const MAX_DISPLAY_TEXT_LENGTH = 20_000;
const ESC = String.fromCharCode(27);
const OSC_RE = new RegExp(`${ESC}\\][\\s\\S]*?(?:\\x07|${ESC}\\\\)`, 'g');
const DCS_RE = new RegExp(`${ESC}[P^_][\\s\\S]*?${ESC}\\\\`, 'g');
const CSI_RE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g');
const C1_RE = new RegExp(`${ESC}[@-Z\\\\-_]`, 'g');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function getTextContent(content: unknown): string | undefined {
  if (!isRecord(content)) {
    return undefined;
  }
  return getString(content['text']);
}

function getSessionUpdate(data: unknown): Record<string, unknown> | undefined {
  if (!isRecord(data) || !isRecord(data['update'])) {
    return undefined;
  }
  return data['update'];
}

function formatPlan(entries: unknown): string | undefined {
  if (!Array.isArray(entries)) {
    return undefined;
  }
  const lines = entries
    .filter(isRecord)
    .map((entry, index) => {
      const content = getString(entry['content']) ?? '';
      const status = getString(entry['status']) ?? 'pending';
      return `${index + 1}. [${sanitizeDisplayText(status)}] ${sanitizeDisplayText(content)}`;
    })
    .filter((line) => line.trim().length > 0);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

function mapToolStatus(status: unknown): ToolCallStatus {
  switch (status) {
    case 'pending':
      return ToolCallStatus.Pending;
    case 'confirming':
      return ToolCallStatus.Confirming;
    case 'in_progress':
    case 'running':
      return ToolCallStatus.Executing;
    case 'completed':
    case 'success':
      return ToolCallStatus.Success;
    case 'failed':
    case 'error':
      return ToolCallStatus.Error;
    case 'canceled':
    case 'cancelled':
      return ToolCallStatus.Canceled;
    default:
      return ToolCallStatus.Error;
  }
}

function sanitizeReason(reason: string): string {
  const withoutAnsi = stripControlSequences(reason);
  let sanitized = '';
  for (const char of withoutAnsi) {
    const code = char.charCodeAt(0);
    if ((code < 32 && code !== 10) || code === 127) {
      continue;
    }
    sanitized += char;
    if (sanitized.length >= 500) {
      break;
    }
  }
  return sanitized;
}

function sanitizeDisplayText(text: string): string {
  const stripped = stripControlSequences(text);
  let sanitized = '';
  for (const char of stripped) {
    const code = char.charCodeAt(0);
    if (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      code === 127
    ) {
      continue;
    }
    sanitized += char;
    if (sanitized.length >= MAX_DISPLAY_TEXT_LENGTH) {
      break;
    }
  }
  return sanitized;
}

function stripControlSequences(value: string): string {
  return value
    .replace(OSC_RE, '')
    .replace(DCS_RE, '')
    .replace(CSI_RE, '')
    .replace(C1_RE, '');
}

function formatToolResultDisplay(
  value: unknown,
): IndividualToolCallDisplay['resultDisplay'] {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return sanitizeDisplayText(value);
  }
  if (
    isRecord(value) &&
    (typeof value['fileDiff'] === 'string' ||
      'ansiOutput' in value ||
      value['type'] === 'todo_list' ||
      value['type'] === 'plan_summary' ||
      value['type'] === 'task_execution' ||
      value['type'] === 'mcp_tool_progress')
  ) {
    return value as unknown as IndividualToolCallDisplay['resultDisplay'];
  }
  try {
    return sanitizeDisplayText(JSON.stringify(value));
  } catch {
    return sanitizeDisplayText(String(value));
  }
}

function formatToolContentText(value: unknown): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value
    .map((item) => {
      if (!isRecord(item)) {
        return undefined;
      }
      const content = item['content'];
      if (isRecord(content)) {
        const text = getString(content['text']);
        return text === undefined ? undefined : sanitizeDisplayText(text);
      }
      const text = getString(item['text']);
      return text === undefined ? undefined : sanitizeDisplayText(text);
    })
    .filter((part): part is string => part !== undefined && part.length > 0);
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function terminalUpdates(
  event: DaemonTuiEvent,
  reason: string,
): DaemonTuiUpdate[] {
  const sanitizedReason = sanitizeReason(reason);
  return [
    {
      type: 'disconnected',
      reason: sanitizedReason,
      daemonEventId: event.id,
    },
    {
      type: 'history',
      item: {
        type: 'error',
        text: `Daemon session disconnected: ${sanitizedReason}`,
      },
      daemonEventId: event.id,
    },
  ];
}

function toolUpdateToHistoryItem(
  update: Record<string, unknown>,
  state?: DaemonTuiReducerState,
): HistoryItemToolGroup | undefined {
  const toolCallId = getString(update['toolCallId']);
  if (!toolCallId) {
    return undefined;
  }

  const title = getString(update['title']);
  const kind = getString(update['kind']);
  const safeToolCallId = sanitizeDisplayText(toolCallId);
  const safeTitle =
    title === undefined ? undefined : sanitizeDisplayText(title);
  const safeKind = kind === undefined ? undefined : sanitizeDisplayText(kind);
  const rawOutput = formatToolResultDisplay(update['rawOutput']);
  const contentOutput = formatToolContentText(update['content']);
  const previous = state?.toolCallsById.get(toolCallId);
  const tool: IndividualToolCallDisplay = {
    callId: safeToolCallId,
    name: safeKind ?? safeTitle ?? previous?.name ?? safeToolCallId,
    description:
      safeTitle ?? safeKind ?? previous?.description ?? safeToolCallId,
    resultDisplay: rawOutput ?? contentOutput ?? previous?.resultDisplay,
    status:
      update['status'] === undefined
        ? (previous?.status ?? ToolCallStatus.Pending)
        : mapToolStatus(update['status']),
    // Confirmation UI is driven by daemon permission_request events. The
    // in-process ToolCallConfirmationDetails shape contains callbacks and is
    // not directly serializable across the daemon boundary.
    confirmationDetails: previous?.confirmationDetails,
  };

  if (state && !state.toolCallsById.has(toolCallId)) {
    state.toolCallOrder.push(toolCallId);
  }
  state?.toolCallsById.set(toolCallId, tool);
  if (state) {
    while (state.toolCallOrder.length > MAX_TOOL_CALLS) {
      const oldest = state.toolCallOrder.shift();
      if (oldest !== undefined) {
        state.toolCallsById.delete(oldest);
      }
    }
  }
  return {
    type: 'tool_group',
    tools: Array.from(state?.toolCallsById.values() ?? [tool]),
  };
}

function isPermissionRequestData(
  value: unknown,
): value is RequestPermissionRequest & { requestId: string } {
  return (
    isRecord(value) &&
    typeof value['requestId'] === 'string' &&
    isRecord(value['toolCall']) &&
    Array.isArray(value['options'])
  );
}

export function reduceDaemonEventToTuiUpdates(
  event: DaemonTuiEvent,
  state?: DaemonTuiReducerState,
): DaemonTuiUpdate[] {
  switch (event.type) {
    case 'session_update': {
      const update = getSessionUpdate(event.data);
      const sessionUpdate = getString(update?.['sessionUpdate']);
      const text = getTextContent(update?.['content']);

      if (sessionUpdate === 'user_message_chunk') {
        return [];
      }

      if (sessionUpdate === 'agent_message_chunk' && text) {
        return [
          {
            type: 'history',
            item: { type: 'gemini_content', text: sanitizeDisplayText(text) },
            daemonEventId: event.id,
          },
        ];
      }

      if (sessionUpdate === 'agent_thought_chunk' && text) {
        return [
          {
            type: 'history',
            item: {
              type: 'gemini_thought_content',
              text: sanitizeDisplayText(text),
            },
            daemonEventId: event.id,
          },
        ];
      }

      if (
        update &&
        (sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update')
      ) {
        const item = toolUpdateToHistoryItem(update, state);
        return item
          ? [{ type: 'tool_group_update', item, daemonEventId: event.id }]
          : [];
      }

      if (sessionUpdate === 'plan') {
        const text = formatPlan(update?.['entries']);
        return text
          ? [
              {
                type: 'history',
                item: { type: 'info', text },
                daemonEventId: event.id,
              },
            ]
          : [];
      }

      return [];
    }

    case 'permission_request': {
      if (!isPermissionRequestData(event.data)) {
        return [];
      }
      return [
        {
          type: 'permission_request',
          requestId: event.data['requestId'],
          request: event.data,
          daemonEventId: event.id,
        },
      ];
    }

    case 'permission_resolved': {
      if (
        !isRecord(event.data) ||
        typeof event.data['requestId'] !== 'string'
      ) {
        return [];
      }
      return [
        {
          type: 'permission_resolved',
          requestId: event.data['requestId'],
          outcome: event.data['outcome'],
          daemonEventId: event.id,
        },
      ];
    }

    case 'model_switched': {
      if (!isRecord(event.data) || typeof event.data['modelId'] !== 'string') {
        return [];
      }
      const modelId = sanitizeDisplayText(event.data['modelId']);
      return [
        {
          type: 'model_switched',
          modelId,
          daemonEventId: event.id,
        },
        {
          type: 'history',
          item: {
            type: 'info',
            text: `Model switched to ${modelId}`,
          },
          daemonEventId: event.id,
        },
      ];
    }

    case 'session_died': {
      const reason =
        isRecord(event.data) && typeof event.data['reason'] === 'string'
          ? event.data['reason']
          : 'session_died';
      return terminalUpdates(event, reason);
    }

    case 'client_evicted': {
      const reason =
        isRecord(event.data) && typeof event.data['reason'] === 'string'
          ? event.data['reason']
          : 'client_evicted';
      return terminalUpdates(event, reason);
    }

    case 'stream_error': {
      const reason =
        isRecord(event.data) && typeof event.data['error'] === 'string'
          ? event.data['error']
          : 'stream_error';
      return terminalUpdates(event, reason);
    }

    default:
      return [];
  }
}

export class DaemonTuiAdapter {
  private readonly session: DaemonTuiSessionClient;
  private readonly onUpdate: (update: DaemonTuiUpdate) => void;
  private readonly reducerState = createDaemonTuiReducerState();
  private eventController: AbortController | null = null;
  private eventPump: Promise<void> | null = null;
  private lastSeenEventId: number | undefined;
  private lifecycle: 'idle' | 'running' | 'stopping' = 'idle';
  private restartAfterStop = false;

  constructor(options: DaemonTuiAdapterOptions) {
    this.session = options.session;
    this.onUpdate = options.onUpdate;
    this.lastSeenEventId = options.session.lastEventId;
  }

  start(): void {
    if (this.lifecycle === 'running') {
      return;
    }
    if (this.lifecycle === 'stopping') {
      this.restartAfterStop = true;
      return;
    }
    this.startPump();
  }

  private startPump(): void {
    this.eventController = new AbortController();
    this.lifecycle = 'running';
    this.eventPump = this.pumpEvents(this.eventController.signal);
  }

  async stop(): Promise<void> {
    if (this.lifecycle === 'idle') {
      return;
    }
    this.lifecycle = 'stopping';
    this.eventController?.abort();
    if (this.eventPump) {
      try {
        await this.eventPump;
      } catch {
        /* pump errors are converted into updates */
      }
    }
  }

  async sendPrompt(
    prompt: string | ContentBlock[],
  ): Promise<DaemonTuiPromptResult> {
    clearDaemonTuiReducerState(this.reducerState);
    const promptBlocks =
      typeof prompt === 'string'
        ? ([{ type: 'text', text: prompt }] as ContentBlock[])
        : prompt;
    try {
      return await this.session.prompt({ prompt: promptBlocks });
    } catch (error) {
      this.reportDaemonFailure(error);
      throw error;
    }
  }

  async cancel(): Promise<void> {
    try {
      await this.session.cancel();
    } catch (error) {
      this.reportDaemonFailure(error);
      throw error;
    }
  }

  async setModel(modelId: string): Promise<Record<string, unknown>> {
    try {
      return await this.session.setModel(modelId);
    } catch (error) {
      this.reportDaemonFailure(error);
      throw error;
    }
  }

  async approvePermission(
    requestId: string,
    optionId: string,
  ): Promise<boolean> {
    try {
      return await this.session.respondToPermission(requestId, {
        outcome: { outcome: 'selected', optionId },
      });
    } catch (error) {
      this.reportDaemonFailure(error);
      throw error;
    }
  }

  async rejectPermission(requestId: string): Promise<boolean> {
    try {
      return await this.session.respondToPermission(requestId, {
        outcome: { outcome: 'cancelled' },
      });
    } catch (error) {
      this.reportDaemonFailure(error);
      throw error;
    }
  }

  get currentSessionId(): string {
    return this.session.sessionId;
  }

  get workspaceCwd(): string {
    return this.session.workspaceCwd;
  }

  get lastEventId(): number | undefined {
    return this.lastSeenEventId ?? this.session.lastEventId;
  }

  private async pumpEvents(signal: AbortSignal): Promise<void> {
    try {
      const resumeId = this.lastSeenEventId ?? this.session.lastEventId;
      for await (const event of this.session.events({
        signal,
        lastEventId: resumeId,
        resume: true,
      })) {
        if (event.id !== undefined) {
          this.lastSeenEventId = event.id;
        }
        for (const update of reduceDaemonEventToTuiUpdates(
          event,
          this.reducerState,
        )) {
          this.emit(update);
        }
      }
      if (!signal.aborted) {
        this.emit({
          type: 'disconnected',
          reason: 'event stream ended',
        });
      }
    } catch (error) {
      if (!signal.aborted) {
        const message = sanitizeReason(
          error instanceof Error ? error.message : String(error),
        );
        this.emit({ type: 'disconnected', reason: message });
      }
    } finally {
      this.eventController = null;
      this.eventPump = null;
      const shouldRestart = this.restartAfterStop;
      this.restartAfterStop = false;
      this.lifecycle = 'idle';
      if (shouldRestart) {
        this.start();
      }
    }
  }

  private reportDaemonFailure(error: unknown): void {
    if (this.lifecycle === 'running') {
      this.lifecycle = 'stopping';
      this.eventController?.abort();
    }
    const message = sanitizeReason(
      error instanceof Error ? error.message : String(error),
    );
    this.emit({ type: 'disconnected', reason: message });
  }

  private emit(update: DaemonTuiUpdate): void {
    try {
      this.onUpdate(update);
    } catch {
      /* isolate renderer callback failures from the daemon event pump */
    }
  }
}
