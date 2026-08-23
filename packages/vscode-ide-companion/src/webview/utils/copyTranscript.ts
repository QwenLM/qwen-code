/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Clipboard copy support for the WebShell transcript timeline.
 *
 * The contributed `qwen-code.copyMessage` / `copyAllMessages` /
 * `copyLastReply` commands route through the extension host
 * (`WebViewProvider.sendCopyCommand`) and land back in the webview as a
 * `copyCommand` message. The pre-PR timeline copied from the legacy
 * `allMessages` list; the transcript timeline copies from the reduced
 * `DaemonTranscriptBlock`s instead.
 */

import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';

/** Plain-text payload of one block, or null when it carries no copyable text. */
export function getBlockCopyText(block: DaemonTranscriptBlock): string | null {
  switch (block.kind) {
    case 'user':
    case 'assistant':
    case 'thought':
    case 'status':
    case 'error':
    case 'debug':
    case 'shell': {
      const text = block.text.trim();
      return text ? text : null;
    }
    case 'user_shell': {
      const parts = [block.command, block.text].filter(
        (part) => typeof part === 'string' && part.trim().length > 0,
      );
      const text = parts.join('\n').trim();
      return text ? text : null;
    }
    case 'tool': {
      const parts: string[] = [];
      if (block.title.trim()) {
        parts.push(block.title.trim());
      }
      if (typeof block.details === 'string' && block.details.trim()) {
        parts.push(block.details.trim());
      }
      const text = parts.join('\n');
      return text ? text : null;
    }
    case 'prompt_cancelled':
      return null;
    default:
      return null;
  }
}

/**
 * Conversation-formatted copy of all message blocks (the "Copy All Messages"
 * command). Labels match the pre-PR timeline output, which included tool
 * call details alongside the text messages; shell output and status notices
 * are copied through the same `getBlockCopyText` helper so the transcript
 * timeline's extra block kinds are not silently dropped.
 */
export function formatBlocksForCopyAll(
  blocks: readonly DaemonTranscriptBlock[],
): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (
      block.kind === 'tool' ||
      block.kind === 'shell' ||
      block.kind === 'user_shell' ||
      block.kind === 'status'
    ) {
      const content = getBlockCopyText(block);
      if (!content) {
        continue;
      }
      if (block.kind === 'tool') {
        const label = block.toolKind ?? block.toolName ?? 'tool';
        parts.push(`**[Tool: ${label}]**\n\n${content}`);
      } else if (block.kind === 'status') {
        parts.push(`**Status:** ${content}`);
      } else if (block.kind === 'user_shell') {
        parts.push(`**User Shell:** ${content}`);
      } else {
        parts.push(`**Shell:** ${content}`);
      }
      continue;
    }
    if (
      block.kind !== 'user' &&
      block.kind !== 'assistant' &&
      block.kind !== 'thought'
    ) {
      continue;
    }
    const content = block.text.trim();
    if (!content) {
      continue;
    }
    if (block.kind === 'user') {
      parts.push(`**User:** ${content}`);
    } else if (block.kind === 'thought') {
      parts.push(`**Thinking:** ${content}`);
    } else {
      parts.push(`**Qwen Code:** ${content}`);
    }
  }
  return parts.join('\n\n---\n\n');
}

/** Text of the most recent non-empty assistant block ("Copy Last Reply"). */
export function findLastAssistantText(
  blocks: readonly DaemonTranscriptBlock[],
): string | null {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block && block.kind === 'assistant' && block.text.trim()) {
      return block.text;
    }
  }
  return null;
}

/**
 * Map a captured `data-message-row-key` value to its transcript block.
 * MessageList keys message rows as `msg:<message id>`; the message id is the
 * block id, optionally with a projection suffix (e.g. `-ip`, `-t-2`). An
 * exact id match always wins; among projection prefixes the longest block id
 * matches, so one block's id can never shadow a sibling whose id extends it
 * (e.g. block `a` must not capture keys belonging to block `a-1`).
 */
export function findBlockByRowKey(
  blocks: readonly DaemonTranscriptBlock[],
  rowKey: string | null,
): DaemonTranscriptBlock | null {
  if (!rowKey || !rowKey.startsWith('msg:')) {
    return null;
  }
  const messageKey = rowKey.slice('msg:'.length);
  let best: DaemonTranscriptBlock | null = null;
  for (const block of blocks) {
    if (messageKey === block.id) {
      return block;
    }
    if (
      messageKey.startsWith(`${block.id}-`) &&
      (best === null || block.id.length > best.id.length)
    ) {
      best = block;
    }
  }
  return best;
}
