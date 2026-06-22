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
import { createDebugLogger } from '@qwen-code/qwen-code-core';
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
const MAX_PLAN_ENTRIES = 200;
const MAX_DISPLAY_TEXT_LENGTH = 20_000;
const MAX_UNKNOWN_EVENT_TYPES = 100;
const MAX_UNSUPPORTED_PROTOCOL_VERSIONS = 20;
const STOP_TIMEOUT_MS = 5_000;
const ESC = String.fromCharCode(27);
const OSC_RE = new RegExp(`${ESC}\\][\\s\\S]*?(?:\\x07|${ESC}\\\\)`, 'g');
const DCS_RE = new RegExp(`${ESC}[PX^_][\\s\\S]*?${ESC}\\\\`, 'g');
const CSI_RE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g');
const C1_RE = new RegExp(`${ESC}[@-Z\\\\-_]`, 'g');
const C1_CSI_RE = /\x9b[0-?]*[ -/]*[@-~]/g;
const C1_STRING_RE = /[\x90\x98\x9e\x9f][\s\S]*?\x9c/g;
const BIDI_CONTROL_RE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const UNKNOWN_EVENT_TYPES = new Set<string>();
const UNSUPPORTED_PROTOCOL_VERSIONS = new Set<string>();
const debugLogger = createDebugLogger('DAEMON_TUI_ADAPTER');

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
    .slice(0, MAX_PLAN_ENTRIES)
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
    if ((code < 32 && code !== 10) || code === 127 || isC1Control(code)) {
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
      (code < 32 && code !== 9 && code !== 10) ||
      code === 127 ||
      isC1Control(code)
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
    .replace(BIDI_CONTROL_RE, '')
    .replace(OSC_RE, '')
    .replace(DCS_RE, '')
    .replace(C1_STRING_RE, '')
    .replace(C1_CSI_RE, '')
    .replace(CSI_RE, '')
    .replace(C1_RE, '');
}

function isC1Control(code: number): boolean {
  return code >= 0x80 && code <= 0x9f;
}

function sanitizeDaemonValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeDisplayText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDaemonValue(item));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [
        key,
        sanitizeDaemonValue(entryValue),
      ]),
    );
  }
  return value;
}

function createSanitizedDaemonError(error: unknown): Error {
  const message = sanitizeReason(
    error instanceof Error ? error.message : String(error),
  );
  return new Error(`Daemon RPC failed: ${message}`);
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
    return sanitizeDaemonValue(
      value,
    ) as IndividualToolCallDisplay['resultDisplay'];
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
      update['status'] == null
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
    typeof value['sessionId'] === 'string' &&
    isRecord(value['toolCall']) &&
    typeof value['toolCall']['toolCallId'] === 'string' &&
    typeof value['toolCall']['kind'] === 'string' &&
    Array.isArray(value['options']) &&
    value['options'].every(
      (option) => isRecord(option) && typeof option['optionId'] === 'string',
    )
  );
}

function sanitizePermissionRequest(
  request: RequestPermissionRequest & { requestId: string },
): RequestPermissionRequest & { requestId: string } {
  const sanitizedToolCall = sanitizeDaemonValue(
    request.toolCall,
  ) as typeof request.toolCall;
  return {
    ...request,
    toolCall: {
      ...sanitizedToolCall,
      toolCallId: request.toolCall.toolCallId,
    },
    options: request.options.map((option) => ({
      ...option,
      name:
        typeof option.name === 'string'
          ? sanitizeDisplayText(option.name)
          : option.name,
    })),
  };
}

function sanitizePermissionOutcome(value: unknown): unknown | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const outcome = value['outcome'];
  if (outcome === 'cancelled') {
    return { outcome };
  }
  if (outcome === 'selected' && typeof value['optionId'] === 'string') {
    return { outcome, optionId: sanitizeDisplayText(value['optionId']) };
  }
  return undefined;
}

function warnUnknownEventTypeOnce(event: DaemonTuiEvent): void {
  const eventType = sanitizeDisplayText(event.type);
  if (UNKNOWN_EVENT_TYPES.has(eventType)) {
    return;
  }
  if (UNKNOWN_EVENT_TYPES.size >= MAX_UNKNOWN_EVENT_TYPES) {
    return;
  }
  UNKNOWN_EVENT_TYPES.add(eventType);
  debugLogger.warn('[DaemonTuiAdapter] Unknown daemon event type:', {
    eventType,
    eventId: event.id,
  });
}

function shouldReportUnsupportedProtocolVersion(version: unknown): boolean {
  const sanitizedVersion = sanitizeDisplayText(String(version));
  if (UNSUPPORTED_PROTOCOL_VERSIONS.has(sanitizedVersion)) {
    return false;
  }
  if (UNSUPPORTED_PROTOCOL_VERSIONS.size >= MAX_UNSUPPORTED_PROTOCOL_VERSIONS) {
    return false;
  }
  UNSUPPORTED_PROTOCOL_VERSIONS.add(sanitizedVersion);
  return true;
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

      if (sessionUpdate === 'agent_thought_chunk') {
        return [];
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
      const request = sanitizePermissionRequest(event.data);
      return [
        {
          type: 'permission_request',
          requestId: request.requestId,
          request,
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
      const outcome = sanitizePermissionOutcome(event.data['outcome']);
      return [
        {
          type: 'permission_resolved',
          requestId: event.data['requestId'],
          outcome,
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
      warnUnknownEventTypeOnce(event);
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
  private pumpGeneration = 0;
  private busy = false;

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
    const generation = ++this.pumpGeneration;
    this.eventPump = this.pumpEvents(this.eventController.signal, generation);
  }

  async stop(): Promise<void> {
    if (this.lifecycle === 'idle') {
      return;
    }
    this.lifecycle = 'stopping';
    this.eventController?.abort();
    if (this.eventPump) {
      try {
        const drained = await this.waitForPumpToDrain(this.eventPump);
        if (!drained && this.lifecycle === 'stopping') {
          debugLogger.error(
            '[DaemonTuiAdapter] Event pump did not drain within timeout; forcing idle',
          );
          this.forceIdleAfterPumpTimeout();
        }
      } catch {
        /* pump errors are converted into updates */
      }
    }
  }

  async sendPrompt(
    prompt: string | ContentBlock[],
  ): Promise<DaemonTuiPromptResult> {
    this.assertRunning();
    if (this.busy) {
      throw new Error('A prompt is already in progress');
    }
    this.busy = true;
    clearDaemonTuiReducerState(this.reducerState);
    const promptBlocks =
      typeof prompt === 'string'
        ? ([{ type: 'text', text: prompt }] as ContentBlock[])
        : prompt;
    try {
      const result = await this.session.prompt(
        { prompt: promptBlocks },
        this.eventController?.signal,
      );
      return typeof result.stopReason === 'string'
        ? { ...result, stopReason: sanitizeReason(result.stopReason) }
        : result;
    } catch (error) {
      this.reportDaemonFailure(error, { disconnect: true });
      throw createSanitizedDaemonError(error);
    } finally {
      this.busy = false;
    }
  }

  async cancel(): Promise<void> {
    this.assertRunning();
    try {
      await this.session.cancel();
    } catch (error) {
      this.reportDaemonFailure(error);
      throw createSanitizedDaemonError(error);
    }
  }

  async setModel(modelId: string): Promise<Record<string, unknown>> {
    this.assertRunning();
    try {
      return await this.session.setModel(modelId);
    } catch (error) {
      this.reportDaemonFailure(error);
      throw createSanitizedDaemonError(error);
    }
  }

  async approvePermission(
    requestId: string,
    optionId: string,
  ): Promise<boolean> {
    this.assertRunning();
    try {
      return await this.session.respondToPermission(requestId, {
        outcome: { outcome: 'selected', optionId },
      });
    } catch (error) {
      this.reportDaemonFailure(error);
      throw createSanitizedDaemonError(error);
    }
  }

  async rejectPermission(requestId: string): Promise<boolean> {
    this.assertRunning();
    try {
      return await this.session.respondToPermission(requestId, {
        outcome: { outcome: 'cancelled' },
      });
    } catch (error) {
      this.reportDaemonFailure(error);
      throw createSanitizedDaemonError(error);
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

  private async pumpEvents(
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    try {
      const resumeId = this.lastSeenEventId ?? this.session.lastEventId;
      for await (const event of this.session.events({
        signal,
        lastEventId: resumeId,
        resume: true,
      })) {
        if (signal.aborted) {
          break;
        }
        if (event.id !== undefined) {
          this.lastSeenEventId = event.id;
        }
        if ((event as { v?: unknown }).v !== 1) {
          if (
            !shouldReportUnsupportedProtocolVersion(
              (event as { v?: unknown }).v,
            )
          ) {
            continue;
          }
          this.emit({
            type: 'history',
            item: {
              type: 'error',
              text: `Unsupported daemon protocol version: ${sanitizeDisplayText(
                String((event as { v?: unknown }).v),
              )}`,
            },
            daemonEventId: event.id,
          });
          continue;
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
        this.emit({
          type: 'history',
          item: { type: 'info', text: 'Daemon event stream ended' },
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
      if (this.pumpGeneration === generation) {
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
  }

  private reportDaemonFailure(
    error: unknown,
    options: { disconnect?: boolean } = {},
  ): void {
    const message = sanitizeReason(
      error instanceof Error ? error.message : String(error),
    );
    if (options.disconnect && this.lifecycle === 'running') {
      this.lifecycle = 'stopping';
      this.eventController?.abort();
      this.emit({ type: 'disconnected', reason: message });
      return;
    }
    this.emit({
      type: 'history',
      item: { type: 'error', text: `Daemon RPC failed: ${message}` },
    });
  }

  private emit(update: DaemonTuiUpdate): void {
    try {
      this.onUpdate(update);
    } catch {
      /* isolate renderer callback failures from the daemon event pump */
    }
  }

  private assertRunning(): void {
    if (this.lifecycle !== 'running') {
      throw new Error('Daemon TUI adapter is not running');
    }
  }

  private async waitForPumpToDrain(pump: Promise<void>): Promise<boolean> {
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        pump.then(
          () => undefined,
          () => undefined,
        ),
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            timedOut = true;
            resolve();
          }, STOP_TIMEOUT_MS);
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
    return !timedOut;
  }

  private forceIdleAfterPumpTimeout(): void {
    const staleController = this.eventController;
    staleController?.abort();
    this.pumpGeneration += 1;
    const shouldRestart = this.restartAfterStop;
    this.restartAfterStop = false;
    this.eventController = null;
    this.eventPump = null;
    this.lifecycle = 'idle';
    if (shouldRestart) {
      this.start();
    }
  }
}
