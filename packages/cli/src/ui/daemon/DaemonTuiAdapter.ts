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
      type: 'turn_complete';
      stopReason?: string;
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
      return `${index + 1}. [${status}] ${content}`;
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
      return ToolCallStatus.Pending;
  }
}

function formatUnknown(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function toolUpdateToHistoryItem(
  update: Record<string, unknown>,
): HistoryItemWithoutId | undefined {
  const toolCallId = getString(update['toolCallId']);
  if (!toolCallId) {
    return undefined;
  }

  const title = getString(update['title']);
  const kind = getString(update['kind']);
  const rawOutput = formatUnknown(update['rawOutput']);
  const tool: IndividualToolCallDisplay = {
    callId: toolCallId,
    name: kind ?? title ?? toolCallId,
    description: title ?? kind ?? toolCallId,
    resultDisplay: rawOutput,
    status: mapToolStatus(update['status']),
    confirmationDetails: undefined,
  };

  return {
    type: 'tool_group',
    tools: [tool],
  };
}

export function reduceDaemonEventToTuiUpdates(
  event: DaemonTuiEvent,
): DaemonTuiUpdate[] {
  switch (event.type) {
    case 'session_update': {
      const update = getSessionUpdate(event.data);
      const sessionUpdate = getString(update?.['sessionUpdate']);
      const text = getTextContent(update?.['content']);

      if (sessionUpdate === 'user_message_chunk' && text) {
        return [
          {
            type: 'history',
            item: { type: 'user', text },
            daemonEventId: event.id,
          },
        ];
      }

      if (sessionUpdate === 'agent_message_chunk' && text) {
        return [
          {
            type: 'history',
            item: { type: 'gemini_content', text },
            daemonEventId: event.id,
          },
        ];
      }

      if (sessionUpdate === 'agent_thought_chunk' && text) {
        return [
          {
            type: 'history',
            item: { type: 'gemini_thought_content', text },
            daemonEventId: event.id,
          },
        ];
      }

      if (
        update &&
        (sessionUpdate === 'tool_call' || sessionUpdate === 'tool_call_update')
      ) {
        const item = toolUpdateToHistoryItem(update);
        return item ? [{ type: 'history', item, daemonEventId: event.id }] : [];
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
      if (
        !isRecord(event.data) ||
        typeof event.data['requestId'] !== 'string'
      ) {
        return [];
      }
      return [
        {
          type: 'permission_request',
          requestId: event.data['requestId'],
          request: event.data as unknown as RequestPermissionRequest,
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
      return [
        {
          type: 'model_switched',
          modelId: event.data['modelId'],
          daemonEventId: event.id,
        },
        {
          type: 'history',
          item: {
            type: 'info',
            text: `Model switched to ${event.data['modelId']}`,
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
      return [
        { type: 'disconnected', reason, daemonEventId: event.id },
        {
          type: 'history',
          item: {
            type: 'error',
            text: `Daemon session disconnected: ${reason}`,
          },
          daemonEventId: event.id,
        },
      ];
    }

    default:
      return [];
  }
}

export class DaemonTuiAdapter {
  private readonly session: DaemonTuiSessionClient;
  private readonly onUpdate: (update: DaemonTuiUpdate) => void;
  private eventController: AbortController | null = null;
  private eventPump: Promise<void> | null = null;
  private lastSeenEventId: number | undefined;

  constructor(options: DaemonTuiAdapterOptions) {
    this.session = options.session;
    this.onUpdate = options.onUpdate;
    this.lastSeenEventId = options.session.lastEventId;
  }

  start(): void {
    if (this.eventPump) {
      return;
    }
    this.eventController = new AbortController();
    this.eventPump = this.pumpEvents(this.eventController.signal);
  }

  stop(): void {
    this.eventController?.abort();
    this.eventController = null;
    this.eventPump = null;
  }

  async sendPrompt(
    prompt: string | ContentBlock[],
  ): Promise<DaemonTuiPromptResult> {
    const promptBlocks =
      typeof prompt === 'string'
        ? ([{ type: 'text', text: prompt }] as ContentBlock[])
        : prompt;
    const result = await this.session.prompt({ prompt: promptBlocks });
    this.onUpdate({ type: 'turn_complete', stopReason: result.stopReason });
    return result;
  }

  async cancel(): Promise<void> {
    await this.session.cancel();
  }

  async setModel(modelId: string): Promise<Record<string, unknown>> {
    return await this.session.setModel(modelId);
  }

  async approvePermission(
    requestId: string,
    optionId: string,
  ): Promise<boolean> {
    return await this.session.respondToPermission(requestId, {
      outcome: { outcome: 'selected', optionId },
    });
  }

  async rejectPermission(requestId: string): Promise<boolean> {
    return await this.session.respondToPermission(requestId, {
      outcome: { outcome: 'cancelled' },
    });
  }

  get currentSessionId(): string {
    return this.session.sessionId;
  }

  get workspaceCwd(): string {
    return this.session.workspaceCwd;
  }

  get lastEventId(): number | undefined {
    return this.session.lastEventId ?? this.lastSeenEventId;
  }

  private async pumpEvents(signal: AbortSignal): Promise<void> {
    try {
      for await (const event of this.session.events({ signal })) {
        if (event.id !== undefined) {
          this.lastSeenEventId = event.id;
        }
        for (const update of reduceDaemonEventToTuiUpdates(event)) {
          this.onUpdate(update);
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        const message = error instanceof Error ? error.message : String(error);
        this.onUpdate({ type: 'disconnected', reason: message });
      }
    }
  }
}
