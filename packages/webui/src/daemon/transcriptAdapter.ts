/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  isDaemonUiSensitiveKey,
  sanitizeDaemonTerminalText,
  type DaemonTranscriptBlock,
  type DaemonToolTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import type { UnifiedMessage } from '../adapters/types.js';
import type {
  ToolCallData,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
} from '../components/toolcalls/shared/index.js';

export function daemonTranscriptToUnifiedMessages(
  blocks: readonly DaemonTranscriptBlock[],
): UnifiedMessage[] {
  const visibleBlocks = blocks.filter((block) => block.kind !== 'debug');
  return visibleBlocks.flatMap((block, index, arr): UnifiedMessage[] => {
    const prev = arr[index - 1];
    const next = arr[index + 1];
    const isFirst = !prev || prev.kind === 'user';
    const isLast = !next || next.kind === 'user';
    const timestamp = block.createdAt;

    switch (block.kind) {
      case 'user':
        return [
          {
            id: block.id,
            type: 'user',
            timestamp,
            content: sanitizeDisplayText(block.text),
            isFirst,
            isLast,
          },
        ];
      case 'assistant':
        return [
          {
            id: block.id,
            type: 'assistant',
            timestamp,
            content: sanitizeDisplayText(block.text),
            isFirst,
            isLast,
          },
        ];
      case 'thought':
        return [
          {
            id: block.id,
            type: 'thinking',
            timestamp,
            content: sanitizeDisplayText(block.text),
            isFirst,
            isLast,
          },
        ];
      case 'tool':
        return [
          {
            id: block.id,
            type: 'tool_call',
            timestamp,
            toolCall: daemonToolBlockToToolCallData(block),
            isFirst,
            isLast,
          },
        ];
      case 'permission':
        return [
          {
            id: block.id,
            type: 'tool_call',
            timestamp,
            toolCall: {
              toolCallId: block.requestId,
              kind: 'permission',
              title: sanitizeDisplayText(block.title),
              status: normalizePermissionStatus(block.resolved),
              rawInput: sanitizeDaemonValue(block.toolCall) as
                | object
                | undefined,
            },
            isFirst,
            isLast,
          },
        ];
      case 'shell':
        return [
          {
            id: block.id,
            type: 'tool_call',
            timestamp,
            toolCall: {
              toolCallId: block.id,
              kind: 'bash',
              title: 'Shell output',
              status: 'completed',
              rawOutput: sanitizeDisplayText(block.text),
              content: createTextContent(block.text),
            },
            isFirst,
            isLast,
          },
        ];
      case 'error':
        return [
          {
            id: block.id,
            type: 'tool_call',
            timestamp,
            toolCall: {
              toolCallId: block.id,
              kind: 'system_error',
              title: 'System error',
              status: 'failed',
              rawOutput: sanitizeDisplayText(block.text),
              content: [
                {
                  type: 'content',
                  content: {
                    type: 'error',
                    text: sanitizeDisplayText(block.text),
                    error: sanitizeDisplayText(block.text),
                  },
                },
              ],
            },
            isFirst,
            isLast,
          },
        ];
      case 'status':
        return [
          {
            id: block.id,
            type: 'tool_call',
            timestamp,
            toolCall: {
              toolCallId: block.id,
              kind: 'status',
              title: 'Status',
              status: 'completed',
              rawOutput: sanitizeDisplayText(block.text),
              content: createTextContent(block.text),
            },
            isFirst,
            isLast,
          },
        ];
      default:
        return [];
    }
  });
}

function daemonToolBlockToToolCallData(
  block: DaemonToolTranscriptBlock,
): ToolCallData {
  return {
    toolCallId: block.toolCallId,
    kind: block.toolKind ?? block.toolName ?? 'tool',
    title: sanitizeDisplayText(block.title),
    status: normalizeToolStatus(block.status),
    rawInput: sanitizeDaemonValue(block.rawInput) as
      | object
      | string
      | undefined,
    rawOutput: sanitizeDaemonValue(block.rawOutput),
    ...(block.content !== undefined
      ? { content: normalizeToolContent(block.content) }
      : {}),
    ...(block.locations !== undefined
      ? { locations: normalizeToolLocations(block.locations) }
      : {}),
  };
}

function normalizeToolStatus(status: string): ToolCallStatus {
  switch (status) {
    case 'pending':
    case 'confirming':
      return 'pending';
    case 'in_progress':
    case 'running':
      return 'in_progress';
    case 'completed':
    case 'success':
      return 'completed';
    case 'canceled':
    case 'cancelled':
    case 'skipped':
      return 'cancelled';
    case 'waiting':
    case 'waiting_for_input':
    case 'queued':
      return 'pending';
    case 'failed':
    case 'error':
    case 'timeout':
    case 'timed_out':
      return 'failed';
    default:
      return 'failed';
  }
}

function normalizePermissionStatus(
  resolved: string | undefined,
): ToolCallStatus {
  if (!resolved) return 'pending';
  const [primary = '', ...detailParts] = resolved.toLowerCase().split(':');
  switch (primary) {
    case 'cancel':
    case 'cancelled':
    case 'canceled':
    case 'abort':
    case 'aborted':
    case 'dismiss':
    case 'dismissed':
    case 'already resolved':
      return 'cancelled';
    case 'deny':
    case 'denied':
    case 'reject':
    case 'rejected':
    case 'blocked':
    case 'error':
    case 'failed':
    case 'fail':
      return 'failed';
    case 'allow':
    case 'allowed':
    case 'approve':
    case 'approved':
    case 'accept':
    case 'accepted':
    case 'confirm':
    case 'confirmed':
    case 'proceed':
    case 'success':
    case 'succeeded':
      return 'completed';
    case 'selected':
      // A selected option resolves the prompt even when the option id is a
      // domain value like a city name rather than allow/deny terminology.
      return classifyPermissionToken(detailParts.join(':')) ?? 'completed';
    default:
      return classifyPermissionToken(primary) ?? 'failed';
  }
}

function classifyPermissionToken(token: string): ToolCallStatus | undefined {
  if (!token) return undefined;
  const terms = new Set(
    token
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  if (hasAnyTerm(terms, FAILED_PERMISSION_TERMS)) {
    return 'failed';
  }
  if (hasAnyTerm(terms, CANCELLED_PERMISSION_TERMS)) {
    return 'cancelled';
  }
  if (hasAnyTerm(terms, COMPLETED_PERMISSION_TERMS)) {
    return 'completed';
  }
  return undefined;
}

const FAILED_PERMISSION_TERMS = new Set([
  'block',
  'blocked',
  'deny',
  'denied',
  'disallow',
  'disallowed',
  'error',
  'fail',
  'failed',
  'reject',
  'rejected',
]);

const CANCELLED_PERMISSION_TERMS = new Set([
  'abort',
  'aborted',
  'cancel',
  'cancelled',
  'canceled',
  'dismiss',
  'dismissed',
]);

const COMPLETED_PERMISSION_TERMS = new Set([
  'accept',
  'accepted',
  'allow',
  'allowed',
  'approve',
  'approved',
  'confirm',
  'confirmed',
  'grant',
  'granted',
  'proceed',
  'success',
  'succeeded',
  'unblock',
  'unblocked',
]);

function hasAnyTerm(
  terms: ReadonlySet<string>,
  expected: ReadonlySet<string>,
): boolean {
  for (const term of terms) {
    if (expected.has(term)) return true;
  }
  return false;
}

function sanitizeDaemonValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return sanitizeDisplayText(value);
  if (depth > 16) return '[truncated]';
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeDaemonValue(entry, depth + 1));
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      const sanitizedKey = sanitizeDisplayText(key);
      return [
        sanitizedKey,
        isDaemonUiSensitiveKey(key)
          ? '[redacted]'
          : sanitizeDaemonValue(entry, depth + 1),
      ];
    }),
  );
}

function normalizeToolContent(value: unknown): ToolCallContent[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ToolCallContent[] => {
    const sanitized = sanitizeDaemonValue(entry);
    if (!isRecord(sanitized)) return [];
    const type = sanitized['type'];
    if (type === 'diff') {
      const path = sanitized['path'];
      const newText = sanitized['newText'];
      return typeof path === 'string' && typeof newText === 'string'
        ? [
            {
              type: 'diff',
              path,
              oldText:
                typeof sanitized['oldText'] === 'string' ||
                sanitized['oldText'] === null
                  ? sanitized['oldText']
                  : null,
              newText,
            },
          ]
        : [];
    }
    if (type !== 'content') return [];
    const content = sanitized['content'];
    if (!isRecord(content) || typeof content['type'] !== 'string') return [];
    return [
      {
        type: 'content',
        content: {
          ...content,
          type: content['type'],
        },
      },
    ];
  });
}

function normalizeToolLocations(value: unknown): ToolCallLocation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): ToolCallLocation[] => {
    const sanitized = sanitizeDaemonValue(entry);
    if (!isRecord(sanitized) || typeof sanitized['path'] !== 'string') {
      return [];
    }
    const line = sanitized['line'];
    return [
      {
        path: sanitized['path'],
        ...(typeof line === 'number' || line === null ? { line } : {}),
      },
    ];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeDisplayText(text: string): string {
  return sanitizeDaemonTerminalText(text);
}

function createTextContent(text: string): ToolCallData['content'] {
  return [
    {
      type: 'content',
      content: {
        type: 'text',
        text: sanitizeDisplayText(text),
      },
    },
  ];
}
