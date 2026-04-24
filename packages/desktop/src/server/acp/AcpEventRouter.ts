/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AvailableCommand,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import type {
  DesktopAvailableCommand,
  DesktopServerMessage,
  DesktopToolCallUpdate,
  DesktopUsageStats,
} from '../../shared/desktopProtocol.js';

export interface AcpEventRouterOptions {
  broadcast(sessionId: string, message: DesktopServerMessage): void;
}

export class AcpEventRouter {
  constructor(private readonly options: AcpEventRouterOptions) {}

  handleSessionUpdate(notification: SessionNotification): void {
    const messages = normalizeSessionUpdate(notification);
    for (const message of messages) {
      this.options.broadcast(notification.sessionId, message);
    }
  }
}

export function normalizeSessionUpdate(
  notification: SessionNotification,
): DesktopServerMessage[] {
  const { update } = notification;
  const messages: DesktopServerMessage[] = [];

  switch (update.sessionUpdate) {
    case 'user_message_chunk': {
      const text = getTextContent(update.content);
      if (text) {
        messages.push({ type: 'message_delta', role: 'user', text });
      }
      messages.push(...getUsageMessages(update._meta));
      break;
    }

    case 'agent_message_chunk': {
      const text = getTextContent(update.content);
      if (text) {
        messages.push({ type: 'message_delta', role: 'assistant', text });
      }
      messages.push(...getUsageMessages(update._meta));
      break;
    }

    case 'agent_thought_chunk': {
      const text = getTextContent(update.content);
      if (text) {
        messages.push({ type: 'message_delta', role: 'thinking', text });
      }
      messages.push(...getUsageMessages(update._meta));
      break;
    }

    case 'tool_call':
    case 'tool_call_update':
      messages.push({
        type: 'tool_call',
        data: normalizeToolCall(update),
      });
      break;

    case 'plan':
      messages.push({
        type: 'plan',
        entries: update.entries.map((entry) => ({
          content: entry.content,
          priority: entry.priority,
          status: entry.status,
        })),
      });
      break;

    case 'current_mode_update':
      messages.push({
        type: 'mode_changed',
        mode: update.currentModeId,
      });
      break;

    case 'available_commands_update':
      messages.push({
        type: 'available_commands',
        commands: update.availableCommands.map(normalizeAvailableCommand),
        skills: getStringArray(getRecord(update._meta)?.['availableSkills']),
      });
      break;

    case 'usage_update':
      messages.push({
        type: 'usage',
        data: {
          usage: { totalTokens: update.used },
          tokenLimit: update.size,
          cost: update.cost ?? undefined,
        },
      });
      break;

    case 'config_option_update':
    case 'session_info_update':
      break;

    default:
      break;
  }

  return messages;
}

function getTextContent(content: { type: string } | undefined): string {
  if (content?.type !== 'text') {
    return '';
  }

  const text = (content as { text?: unknown }).text;
  return typeof text === 'string' ? text : '';
}

function normalizeToolCall(
  update: Extract<
    SessionNotification['update'],
    { sessionUpdate: 'tool_call' | 'tool_call_update' }
  >,
): DesktopToolCallUpdate {
  const meta = getRecord(update._meta);
  const timestamp = getOptionalNumber(meta?.['timestamp']);

  return {
    toolCallId: update.toolCallId,
    kind: getOptionalString(update.kind),
    title: getOptionalString(update.title),
    status: getOptionalString(update.status),
    rawInput: update.rawInput,
    rawOutput: update.rawOutput,
    content: update.content ?? undefined,
    locations: update.locations ?? undefined,
    ...(timestamp !== undefined && { timestamp }),
  };
}

function normalizeAvailableCommand(
  command: AvailableCommand,
): DesktopAvailableCommand {
  return {
    name: command.name,
    description: command.description,
    input: command.input ?? undefined,
  };
}

function getUsageMessages(
  meta: Record<string, unknown> | null | undefined,
): DesktopServerMessage[] {
  const usage = getUsageStats(meta);
  return usage ? [{ type: 'usage', data: usage }] : [];
}

function getUsageStats(
  meta: Record<string, unknown> | null | undefined,
): DesktopUsageStats | null {
  if (!meta) {
    return null;
  }

  const rawUsage = getRecord(meta['usage']);
  const durationMs = getNullableNumber(meta['durationMs']);
  if (!rawUsage && durationMs === undefined) {
    return null;
  }

  return {
    usage: rawUsage
      ? {
          inputTokens:
            getNullableNumber(rawUsage['inputTokens']) ??
            getNullableNumber(rawUsage['promptTokens']),
          outputTokens:
            getNullableNumber(rawUsage['outputTokens']) ??
            getNullableNumber(rawUsage['completionTokens']),
          thoughtTokens:
            getNullableNumber(rawUsage['thoughtTokens']) ??
            getNullableNumber(rawUsage['thoughtsTokens']),
          totalTokens: getNullableNumber(rawUsage['totalTokens']),
          cachedReadTokens:
            getNullableNumber(rawUsage['cachedReadTokens']) ??
            getNullableNumber(rawUsage['cachedTokens']),
          cachedWriteTokens: getNullableNumber(rawUsage['cachedWriteTokens']),
          promptTokens:
            getNullableNumber(rawUsage['promptTokens']) ??
            getNullableNumber(rawUsage['inputTokens']),
          completionTokens:
            getNullableNumber(rawUsage['completionTokens']) ??
            getNullableNumber(rawUsage['outputTokens']),
          thoughtsTokens:
            getNullableNumber(rawUsage['thoughtsTokens']) ??
            getNullableNumber(rawUsage['thoughtTokens']),
          cachedTokens:
            getNullableNumber(rawUsage['cachedTokens']) ??
            getNullableNumber(rawUsage['cachedReadTokens']),
        }
      : undefined,
    ...(durationMs !== undefined && { durationMs }),
  };
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function getOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function getOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function getNullableNumber(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }

  return getOptionalNumber(value);
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string');
}
