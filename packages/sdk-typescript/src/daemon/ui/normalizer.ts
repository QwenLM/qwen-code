/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonEvent } from '../types.js';
import type {
  DaemonUiEvent,
  DaemonUiPermissionOption,
  NormalizeDaemonEventOptions,
} from './types.js';
import {
  getFirstString,
  getOutputText,
  getString,
  getTextContent,
  isRecord,
  stringifyJson,
} from './utils.js';

const MAX_DETAILS_LENGTH = 4096;

export function normalizeDaemonEvent(
  event: DaemonEvent,
  opts: NormalizeDaemonEventOptions = {},
): DaemonUiEvent[] {
  const base = createBase(event, opts);
  switch (event.type) {
    case 'session_update':
      return normalizeSessionUpdate(event, base, opts);
    case 'shell_output': {
      const text = getOutputText(event.data);
      const stream = getShellStream(event.data);
      return text
        ? [
            {
              ...base,
              type: 'shell.output',
              text,
              ...(stream ? { stream } : {}),
            },
          ]
        : [];
    }
    case 'permission_request':
      return normalizePermissionRequest(event, base);
    case 'permission_resolved':
    case 'permission_already_resolved':
      return normalizePermissionResolved(event, base);
    case 'model_switched':
      return [
        {
          ...base,
          type: 'model.changed',
          modelId: getString(event.data, 'modelId') ?? 'unknown',
        },
      ];
    case 'model_switch_failed':
      return [
        {
          ...base,
          type: 'error',
          recoverable: true,
          text:
            getString(event.data, 'error') ??
            'Model switch failed (no details available)',
        },
      ];
    case 'session_died':
      return [
        {
          ...base,
          type: 'error',
          recoverable: false,
          text:
            getString(event.data, 'reason') ??
            'Session died (no details available)',
        },
      ];
    case 'session_closed':
      return [
        {
          ...base,
          type: 'error',
          recoverable: false,
          text: `Session closed: ${getString(event.data, 'reason') ?? 'closed'}`,
        },
      ];
    case 'client_evicted':
      return [
        {
          ...base,
          type: 'error',
          recoverable: true,
          text:
            getString(event.data, 'reason') ??
            'SSE client evicted (no details available)',
        },
      ];
    case 'slow_client_warning':
      return [
        {
          ...base,
          type: 'status',
          text: 'SSE stream is lagging',
        },
      ];
    case 'stream_error':
      return [
        {
          ...base,
          type: 'error',
          recoverable: true,
          text:
            getString(event.data, 'error') ??
            'SSE stream error (no details available)',
        },
      ];
    default:
      return [
        {
          ...base,
          type: 'status',
          text: `${event.type} (unrecognized daemon event)`,
        },
      ];
  }
}

function createBase(
  event: DaemonEvent,
  opts: NormalizeDaemonEventOptions,
): Pick<DaemonUiEvent, 'eventId' | 'originatorClientId' | 'rawEvent'> {
  return {
    ...(event.id !== undefined ? { eventId: event.id } : {}),
    ...(event.originatorClientId
      ? { originatorClientId: event.originatorClientId }
      : {}),
    ...(opts.includeRawEvent ? { rawEvent: event } : {}),
  };
}

function normalizeSessionUpdate(
  event: DaemonEvent,
  base: Pick<DaemonUiEvent, 'eventId' | 'originatorClientId' | 'rawEvent'>,
  opts: NormalizeDaemonEventOptions,
): DaemonUiEvent[] {
  const update = getSessionUpdatePayload(event.data);
  if (!update) {
    return [
      {
        ...base,
        type: 'debug',
        text: `session_update: ${stringifyJson(event.data)}`,
      },
    ];
  }

  const kind = getString(update, 'sessionUpdate');
  switch (kind) {
    case 'user_message_chunk': {
      if (
        opts.suppressOwnUserEcho &&
        opts.clientId &&
        event.originatorClientId === opts.clientId
      ) {
        return [];
      }
      const text = getTextContent(update['content']);
      return text ? [{ ...base, type: 'user.text.delta', text }] : [];
    }
    case 'agent_message_chunk': {
      const text = getTextContent(update['content']);
      return text ? [{ ...base, type: 'assistant.text.delta', text }] : [];
    }
    case 'agent_thought_chunk': {
      const text = getTextContent(update['content']);
      return text ? [{ ...base, type: 'thought.text.delta', text }] : [];
    }
    case 'tool_call':
    case 'tool_call_update':
      return [normalizeToolUpdate(update, base)];
    case 'shell_output':
    case 'tool_output': {
      const text = getOutputText(update);
      const stream = getShellStream(update) ?? getShellStream(event.data);
      return text
        ? [
            {
              ...base,
              type: 'shell.output',
              text,
              ...(stream ? { stream } : {}),
            },
          ]
        : [];
    }
    case 'available_commands_update': {
      const commands = Array.isArray(update['availableCommands'])
        ? update['availableCommands']
        : [];
      return [
        {
          ...base,
          type: 'status',
          text: `Available commands updated (${commands.length})`,
        },
      ];
    }
    default:
      return [
        {
          ...base,
          type: 'debug',
          text: `${kind ?? 'session_update'}: ${stringifyJson(update)}`,
        },
      ];
  }
}

function normalizeToolUpdate(
  update: Record<string, unknown>,
  base: Pick<DaemonUiEvent, 'eventId' | 'originatorClientId' | 'rawEvent'>,
): DaemonUiEvent {
  const metadata = isRecord(update['_meta']) ? update['_meta'] : undefined;
  const toolName =
    getString(update, 'toolName') ??
    getString(update, 'name') ??
    (metadata ? getString(metadata, 'toolName') : undefined) ??
    (metadata ? getString(metadata, 'name') : undefined);
  const toolKind = getString(update, 'kind');
  const title = getString(update, 'title') ?? toolName ?? toolKind;
  const rawInput = update['rawInput'] ?? update['input'] ?? update['args'];
  const rawOutput = update['rawOutput'] ?? update['output'] ?? update['result'];
  const toolCallId = getString(update, 'toolCallId');
  const status = getString(update, 'status');
  if (!toolCallId) {
    return {
      ...base,
      type: 'error',
      recoverable: true,
      text: `Tool update missing toolCallId${title ? ` (${title})` : ''}`,
    };
  }
  return {
    ...base,
    type: 'tool.update',
    toolCallId,
    ...(status ? { status } : {}),
    ...(title ? { title } : {}),
    ...(toolName ? { toolName } : {}),
    ...(toolKind ? { toolKind } : {}),
    ...(rawInput !== undefined ? { rawInput } : {}),
    ...(rawOutput !== undefined ? { rawOutput } : {}),
    ...(rawInput !== undefined
      ? { details: capDetails(stringifyJson(rawInput)) }
      : rawOutput !== undefined
        ? { details: capDetails(getOutputText(rawOutput)) }
        : {}),
  };
}

function capDetails(details: string): string {
  if (details.length <= MAX_DETAILS_LENGTH) return details;
  return `${details.slice(0, MAX_DETAILS_LENGTH)}... [truncated]`;
}

function normalizePermissionRequest(
  event: DaemonEvent,
  base: Pick<DaemonUiEvent, 'eventId' | 'originatorClientId' | 'rawEvent'>,
): DaemonUiEvent[] {
  if (!isRecord(event.data)) {
    return [
      {
        ...base,
        type: 'debug',
        text: `permission_request: ${stringifyJson(event.data)}`,
      },
    ];
  }

  const requestId = getString(event.data, 'requestId');
  if (!requestId) {
    return [
      {
        ...base,
        type: 'debug',
        text: `permission_request: ${stringifyJson(event.data)}`,
      },
    ];
  }

  const toolCall = event.data['toolCall'];
  return [
    {
      ...base,
      type: 'permission.request',
      requestId,
      sessionId: getString(event.data, 'sessionId'),
      title: describeToolCall(toolCall),
      options: normalizePermissionOptions(event.data['options']),
      toolCall,
    },
  ];
}

function normalizePermissionResolved(
  event: DaemonEvent,
  base: Pick<DaemonUiEvent, 'eventId' | 'originatorClientId' | 'rawEvent'>,
): DaemonUiEvent[] {
  const requestId = getString(event.data, 'requestId');
  if (!requestId) {
    return [
      {
        ...base,
        type: 'debug',
        text: `${event.type}: ${stringifyJson(event.data)}`,
      },
    ];
  }
  return [
    {
      ...base,
      type: 'permission.resolved',
      requestId,
      outcome: describePermissionOutcome(event.data),
    },
  ];
}

export function getSessionUpdatePayload(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const update = value['update'];
  return isRecord(update) ? update : value;
}

function normalizePermissionOptions(
  value: unknown,
): DaemonUiPermissionOption[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((option): DaemonUiPermissionOption[] => {
    if (!isRecord(option)) return [];
    const optionId = getString(option, 'optionId');
    if (!optionId) return [];
    return [
      {
        optionId,
        label:
          getString(option, 'label') ??
          getString(option, 'title') ??
          getString(option, 'name') ??
          optionId,
        ...(getString(option, 'description')
          ? { description: getString(option, 'description') }
          : {}),
        raw: option,
      },
    ];
  });
}

function describePermissionOutcome(value: unknown): string {
  if (!isRecord(value)) return stringifyJson(value);
  const outcome = value['outcome'];
  if (typeof outcome === 'string') return outcome;
  if (isRecord(outcome)) {
    const kind = getString(outcome, 'outcome') ?? 'selected';
    const optionId = getString(outcome, 'optionId');
    return optionId ? `${kind}:${optionId}` : kind;
  }
  return getFirstString(value, ['status', 'reason']) ?? stringifyJson(value);
}

function describeToolCall(value: unknown): string {
  if (!isRecord(value)) return 'Tool permission';
  return (
    getString(value, 'title') ??
    getString(value, 'name') ??
    getString(value, 'kind') ??
    getString(value, 'toolName') ??
    'Tool permission'
  );
}

function getShellStream(value: unknown): 'stdout' | 'stderr' | undefined {
  const stream = getString(value, 'stream');
  return stream === 'stdout' || stream === 'stderr' ? stream : undefined;
}
