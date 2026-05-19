/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonTranscriptBlock,
  DaemonToolTranscriptBlock,
} from '@qwen-code/sdk/daemon';
import type { UnifiedMessage } from '../adapters/types.js';
import type {
  ToolCallData,
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
      return 'cancelled';
    case 'failed':
    case 'error':
      return 'failed';
    default:
      return 'in_progress';
  }
}

function normalizePermissionStatus(
  resolved: string | undefined,
): ToolCallStatus {
  if (!resolved) return 'pending';
  const normalized = resolved.toLowerCase();
  if (
    normalized.includes('cancel') ||
    normalized.includes('abort') ||
    normalized.includes('dismiss')
  ) {
    return 'cancelled';
  }
  if (
    normalized.includes('deny') ||
    normalized.includes('denied') ||
    normalized.includes('reject') ||
    normalized.includes('blocked') ||
    normalized.includes('error') ||
    normalized.includes('fail')
  ) {
    return 'failed';
  }
  return 'completed';
}

function sanitizeDaemonValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return sanitizeDisplayText(value);
  if (depth > 16) return value;
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeDaemonValue(entry, depth + 1));
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      sanitizeDaemonValue(entry, depth + 1),
    ]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeDisplayText(text: string): string {
  return text
    .replace(BIDI_CONTROL_PATTERN, '')
    .replace(OSC_SEQUENCE_PATTERN, '')
    .replace(DCS_SEQUENCE_PATTERN, '')
    .replace(CSI_SEQUENCE_PATTERN, '')
    .replace(CONTROL_CHARACTERS_PATTERN, '');
}

const nul = String.fromCharCode(0x00);
const backspace = String.fromCharCode(0x08);
const verticalTab = String.fromCharCode(0x0b);
const formFeed = String.fromCharCode(0x0c);
const shiftOut = String.fromCharCode(0x0e);
const unitSeparator = String.fromCharCode(0x1f);
const deleteChar = String.fromCharCode(0x7f);
const c1End = String.fromCharCode(0x9f);
const escapeChar = String.fromCharCode(0x1b);
const bell = String.fromCharCode(0x07);

const CONTROL_CHARACTERS_PATTERN = new RegExp(
  `[${nul}-${backspace}${verticalTab}${formFeed}${shiftOut}-${unitSeparator}${deleteChar}-${c1End}]`,
  'g',
);
const OSC_SEQUENCE_PATTERN = new RegExp(
  `${escapeChar}\\][\\s\\S]*?(?:${bell}|${escapeChar}\\\\)`,
  'g',
);
const DCS_SEQUENCE_PATTERN = new RegExp(
  `${escapeChar}P[\\s\\S]*?${escapeChar}\\\\`,
  'g',
);
const CSI_SEQUENCE_PATTERN = new RegExp(
  `${escapeChar}\\[[0-?]*[ -/]*[@-~]`,
  'g',
);
const BIDI_CONTROL_PATTERN = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
