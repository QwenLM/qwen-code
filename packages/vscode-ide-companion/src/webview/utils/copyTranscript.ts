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
      // `details` summarizes the tool input, not its result — also copy the
      // content parts the timeline renders (output text and diffs), matching
      // the pre-PR `formatToolCallForCopy` output.
      for (const contentPart of getToolContentCopyParts(block)) {
        if (contentPart.trim()) {
          parts.push(contentPart);
        }
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
      block.kind === 'status' ||
      block.kind === 'error' ||
      block.kind === 'debug'
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
      } else if (block.kind === 'error') {
        parts.push(`**Error:** ${content}`);
      } else if (block.kind === 'debug') {
        parts.push(`**Debug:** ${content}`);
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
 * Copy-text of a tool block's `content` entries (output text and diffs).
 * Mirrors the shapes `normalizeToolContent` accepts in web-shell and the
 * `---/+++` diff rendering of the pre-PR `formatToolCallForCopy`.
 */
function getToolContentCopyParts(block: { content?: unknown }): string[] {
  if (!Array.isArray(block.content)) {
    return [];
  }
  const parts: string[] = [];
  for (const entry of block.content) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (record.type === 'content') {
      const body = record.content;
      if (
        body &&
        typeof body === 'object' &&
        typeof (body as Record<string, unknown>).text === 'string'
      ) {
        parts.push((body as Record<string, unknown>).text as string);
      }
      continue;
    }
    if (record.type === 'diff' && typeof record.newText === 'string') {
      const filePath = typeof record.path === 'string' ? record.path : '';
      const oldText = record.oldText;
      if (typeof oldText === 'string' && oldText.length > 0) {
        const oldLines = oldText
          .split('\n')
          .map((line) => `-${line}`)
          .join('\n');
        const newLines = record.newText
          .split('\n')
          .map((line) => `+${line}`)
          .join('\n');
        parts.push(
          `--- ${filePath}\n+++ ${filePath}\n${oldLines}\n${newLines}`,
        );
      } else {
        parts.push(`${filePath}:\n${record.newText}`);
      }
    }
  }
  return parts;
}

/**
 * Map a captured `data-message-row-key` value to its transcript block.
 * MessageList keys message rows as `msg:<message id>`; the message id is the
 * block id, optionally with a projection suffix (e.g. `-ip`, `-t-2`). Tool
 * rows carry the web-shell tool-group prefix `msg:tg-<block id>`; the prefix
 * is stripped before matching. Merged tool groups share the first block's
 * group key and the row key cannot identify a later tool inside the group
 * box, so a group row resolves to the group's first tool block. An exact id
 * match always wins; among projection prefixes the longest block id matches,
 * so one block's id can never shadow a sibling whose id extends it (e.g.
 * block `a` must not capture keys belonging to block `a-1`).
 */
export function findBlockByRowKey(
  blocks: readonly DaemonTranscriptBlock[],
  rowKey: string | null,
): DaemonTranscriptBlock | null {
  if (!rowKey || !rowKey.startsWith('msg:')) {
    return null;
  }
  let messageKey = rowKey.slice('msg:'.length);
  if (messageKey.startsWith('tg-')) {
    messageKey = messageKey.slice('tg-'.length);
  }
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
