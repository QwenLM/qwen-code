/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Transcript adapter for the daemon-direct side panel (issue #5626).
 *
 * Converts the daemon's normalized `DaemonTranscriptBlock[]` (from
 * `useDaemonTranscriptBlocks`) into the flat, time-ordered timeline the side
 * panel renders with the webui presentational components (`UserMessage`,
 * `AssistantMessage`, `ThinkingMessage`, and tool-call cards).
 *
 * This is intentionally a lightweight projection: the side panel shows the
 * conversation as a simple chat, so sub-agent nesting, todo timelines, shell
 * streaming groups, and other web-shell-only affordances are flattened to
 * their top-level equivalents. Pending permissions are excluded here because
 * they are rendered separately by the `PermissionDrawer`.
 */

import type {
  DaemonTranscriptBlock,
  DaemonTextTranscriptBlock,
  DaemonToolTranscriptBlock,
} from '@qwen-code/webui/daemon-react-sdk';
import type { ToolCallData } from '@qwen-code/webui';

/** A rendered chat message (user prompt, assistant reply, or thinking). */
export interface TranscriptMessageItem {
  type: 'message';
  /** Stable key for React. */
  id: string;
  role: 'user' | 'assistant' | 'thinking';
  content: string;
  timestamp: number;
}

/** A rendered tool-call card. */
export interface TranscriptToolItem {
  type: 'toolCall';
  /** Stable key for React. */
  id: string;
  timestamp: number;
  toolCall: ToolCallData;
}

export type TranscriptItem = TranscriptMessageItem | TranscriptToolItem;

/**
 * Map a daemon tool-block status string onto the webui `ToolCallStatus` union.
 * The daemon uses a wider vocabulary (`running`, `confirming`, `canceled`…),
 * so normalize it to what the tool-call components understand.
 */
function mapToolStatus(status: string): ToolCallData['status'] {
  switch (status) {
    case 'running':
    case 'in_progress':
      return 'in_progress';
    case 'pending':
    case 'confirming':
    case 'background':
      return 'pending';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'cancelled':
    case 'canceled':
      return 'cancelled';
    default:
      return 'in_progress';
  }
}

/**
 * Extract the tool-call `content` array (text / diff entries) in the shape the
 * webui tool-call components expect. The daemon types `content` as `unknown`,
 * so validate defensively and drop anything malformed.
 */
function normalizeToolContent(
  value: unknown,
): ToolCallData['content'] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items: NonNullable<ToolCallData['content']> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (record.type === 'content') {
      const body = record.content as
        | { type?: string; text?: string }
        | undefined;
      items.push({
        type: 'content',
        content: body
          ? { ...body, type: typeof body.type === 'string' ? body.type : '' }
          : undefined,
      });
    } else if (record.type === 'diff') {
      items.push({
        type: 'diff',
        path: typeof record.path === 'string' ? record.path : undefined,
        oldText: typeof record.oldText === 'string' ? record.oldText : undefined,
        newText: typeof record.newText === 'string' ? record.newText : '',
      });
    }
  }
  return items.length > 0 ? items : undefined;
}

/** Convert a daemon `tool` block into a `ToolCallData` for the card components. */
function toToolCallData(block: DaemonToolTranscriptBlock): ToolCallData {
  const timestamp = block.serverTimestamp ?? block.clientReceivedAt;
  return {
    toolCallId: block.toolCallId,
    kind: block.toolKind || block.toolName || 'other',
    title: block.title || block.toolName || 'Tool Call',
    status: mapToolStatus(block.status),
    rawInput: block.rawInput as string | object | undefined,
    rawOutput: block.rawOutput,
    content: normalizeToolContent(block.content),
    locations: Array.isArray(block.locations)
      ? (block.locations as ToolCallData['locations'])
      : undefined,
    timestamp,
  };
}

/**
 * Project daemon transcript blocks into the side panel's render timeline.
 *
 * Consecutive `assistant` / `thought` blocks are coalesced into a single
 * message so streaming deltas don't fan out into many cards; a tool call (or a
 * user turn) breaks the run so later text starts a fresh card. Pending
 * permission blocks are skipped — they surface through the `PermissionDrawer`.
 */
export function transcriptBlocksToItems(
  blocks: readonly DaemonTranscriptBlock[],
): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  // Index of the most recent coalescible message (assistant text or thinking),
  // or null when the next text block must start a fresh card.
  let assistantIdx: number | null = null;
  let thinkingIdx: number | null = null;

  for (const block of blocks) {
    const timestamp = block.serverTimestamp ?? block.clientReceivedAt;

    switch (block.kind) {
      case 'user': {
        const text = (block as DaemonTextTranscriptBlock).text;
        assistantIdx = null;
        thinkingIdx = null;
        if (!text) break;
        items.push({
          type: 'message',
          id: block.id,
          role: 'user',
          content: text,
          timestamp,
        });
        break;
      }

      case 'assistant': {
        const text = (block as DaemonTextTranscriptBlock).text;
        if (!text) break;
        thinkingIdx = null;
        const target =
          assistantIdx !== null
            ? (items[assistantIdx] as TranscriptMessageItem | undefined)
            : undefined;
        if (target && target.type === 'message' && target.role === 'assistant') {
          target.content += text;
        } else {
          items.push({
            type: 'message',
            id: block.id,
            role: 'assistant',
            content: text,
            timestamp,
          });
          assistantIdx = items.length - 1;
        }
        break;
      }

      case 'thought': {
        const text = (block as DaemonTextTranscriptBlock).text;
        if (!text) break;
        assistantIdx = null;
        const target =
          thinkingIdx !== null
            ? (items[thinkingIdx] as TranscriptMessageItem | undefined)
            : undefined;
        if (target && target.type === 'message' && target.role === 'thinking') {
          target.content += text;
        } else {
          items.push({
            type: 'message',
            id: block.id,
            role: 'thinking',
            content: text,
            timestamp,
          });
          thinkingIdx = items.length - 1;
        }
        break;
      }

      case 'tool': {
        assistantIdx = null;
        thinkingIdx = null;
        items.push({
          type: 'toolCall',
          id: block.id,
          timestamp,
          toolCall: toToolCallData(block as DaemonToolTranscriptBlock),
        });
        break;
      }

      // shell / status / debug / error / permission / prompt_cancelled /
      // user_shell are not surfaced as chat cards in the side panel. Pending
      // permissions render via the PermissionDrawer; the rest are daemon-level
      // diagnostics the simplified panel omits.
      default:
        break;
    }
  }

  return items;
}
