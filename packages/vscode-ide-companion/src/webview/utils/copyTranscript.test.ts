/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
import {
  findBlockByRowKey,
  findLastAssistantText,
  formatBlocksForCopyAll,
  getBlockCopyText,
} from './copyTranscript.js';

type TextKind = 'user' | 'assistant' | 'thought';

function textBlock(kind: TextKind, id: string, text: string) {
  return {
    kind,
    id,
    text,
    clientReceivedAt: 0,
    createdAt: 0,
    updatedAt: 0,
  } satisfies DaemonTranscriptBlock;
}

function toolBlock(
  id: string,
  title: string,
  details?: string,
  toolKind?: string,
) {
  return {
    kind: 'tool',
    id,
    toolCallId: `${id}-call`,
    title,
    status: 'completed',
    preview: { kind: 'generic', summary: '' },
    details,
    toolKind,
    clientReceivedAt: 0,
    createdAt: 0,
    updatedAt: 0,
  } satisfies DaemonTranscriptBlock;
}

function shellBlock(id: string, text: string) {
  return {
    kind: 'shell',
    id,
    text,
    clientReceivedAt: 0,
    createdAt: 0,
    updatedAt: 0,
  } satisfies DaemonTranscriptBlock;
}

function userShellBlock(id: string, command: string, text: string) {
  return {
    kind: 'user_shell',
    id,
    command,
    text,
    clientReceivedAt: 0,
    createdAt: 0,
    updatedAt: 0,
  } satisfies DaemonTranscriptBlock;
}

function statusBlock(id: string, text: string) {
  return {
    kind: 'status',
    id,
    text,
    clientReceivedAt: 0,
    createdAt: 0,
    updatedAt: 0,
  } satisfies DaemonTranscriptBlock;
}

describe('getBlockCopyText', () => {
  it('copies text blocks', () => {
    expect(getBlockCopyText(textBlock('assistant', 'a-1', 'hello'))).toBe(
      'hello',
    );
  });

  it('skips whitespace-only blocks', () => {
    expect(getBlockCopyText(textBlock('user', 'u-1', '   '))).toBeNull();
  });

  it('copies tool title and details', () => {
    expect(getBlockCopyText(toolBlock('t-1', 'Ran ls', '2 files'))).toBe(
      'Ran ls\n2 files',
    );
    expect(getBlockCopyText(toolBlock('t-2', 'Ran ls'))).toBe('Ran ls');
  });
});

describe('formatBlocksForCopyAll', () => {
  it('labels conversation blocks like the pre-PR timeline, including tool and shell output', () => {
    const blocks = [
      textBlock('user', 'u-1', 'question'),
      toolBlock('t-1', 'Ran ls', '2 files', 'execute'),
      shellBlock('s-1', 'agent shell output'),
      userShellBlock('us-1', 'ls -la', 'user shell output'),
      statusBlock('st-1', 'Compacting context'),
      textBlock('thought', 'th-1', 'pondering'),
      textBlock('assistant', 'a-1', 'answer'),
    ];
    expect(formatBlocksForCopyAll(blocks)).toBe(
      [
        '**User:** question',
        '**[Tool: execute]**\n\nRan ls\n2 files',
        '**Shell:** agent shell output',
        '**User Shell:** ls -la\nuser shell output',
        '**Status:** Compacting context',
        '**Thinking:** pondering',
        '**Qwen Code:** answer',
      ].join('\n\n---\n\n'),
    );
  });

  it('falls back to the tool name or a generic label when no tool kind is set', () => {
    const namedTool: DaemonTranscriptBlock = {
      ...toolBlock('t-1', 'Read file'),
      toolName: 'read_file',
    };
    const blocks = [namedTool, toolBlock('t-2', 'Did work')];
    expect(formatBlocksForCopyAll(blocks)).toBe(
      '**[Tool: read_file]**\n\nRead file\n\n---\n\n**[Tool: tool]**\n\nDid work',
    );
  });

  it('skips tool, shell, and status blocks without copyable text', () => {
    const blocks = [
      toolBlock('t-1', '   '),
      shellBlock('s-1', '  '),
      statusBlock('st-1', ''),
      textBlock('assistant', 'a-1', 'answer'),
    ];
    expect(formatBlocksForCopyAll(blocks)).toBe('**Qwen Code:** answer');
  });

  it('returns an empty string when there is nothing to copy', () => {
    expect(formatBlocksForCopyAll([])).toBe('');
  });
});

describe('findLastAssistantText', () => {
  it('returns the most recent non-empty assistant block', () => {
    const blocks = [
      textBlock('assistant', 'a-1', 'first'),
      textBlock('user', 'u-1', 'next'),
      textBlock('assistant', 'a-2', 'second'),
      textBlock('assistant', 'a-3', '   '),
    ];
    expect(findLastAssistantText(blocks)).toBe('second');
  });

  it('returns null without an assistant block', () => {
    expect(findLastAssistantText([textBlock('user', 'u-1', 'hi')])).toBeNull();
  });
});

describe('findBlockByRowKey', () => {
  const blocks = [
    textBlock('user', 'u-1', 'question'),
    textBlock('assistant', 'a-1', 'answer'),
  ];

  it('matches an exact message key', () => {
    expect(findBlockByRowKey(blocks, 'msg:a-1')).toBe(blocks[1]);
  });

  it('matches projected message keys derived from a block id', () => {
    expect(findBlockByRowKey(blocks, 'msg:a-1-ip')).toBe(blocks[1]);
  });

  it('ignores non-message rows and unknown keys', () => {
    expect(findBlockByRowKey(blocks, 'slot:header')).toBeNull();
    expect(findBlockByRowKey(blocks, 'msg:zz-9')).toBeNull();
    expect(findBlockByRowKey(blocks, null)).toBeNull();
  });

  it('does not match across block id prefixes', () => {
    expect(findBlockByRowKey(blocks, 'msg:a-10')).toBeNull();
  });

  it('prefers the exact block when one id dash-prefixes a sibling id', () => {
    const ambiguous = [
      textBlock('user', 'a', 'first'),
      textBlock('assistant', 'a-1', 'second'),
    ];
    expect(findBlockByRowKey(ambiguous, 'msg:a-1')).toBe(ambiguous[1]);
    expect(findBlockByRowKey(ambiguous, 'msg:a')).toBe(ambiguous[0]);
  });

  it('matches projection suffixes against the longest block id, not the first', () => {
    const ambiguous = [
      textBlock('user', 'a', 'first'),
      textBlock('assistant', 'a-1', 'second'),
    ];
    expect(findBlockByRowKey(ambiguous, 'msg:a-1-ip')).toBe(ambiguous[1]);
    expect(findBlockByRowKey(ambiguous, 'msg:a-1-t-2')).toBe(ambiguous[1]);
    expect(findBlockByRowKey(ambiguous, 'msg:a-ip')).toBe(ambiguous[0]);
  });
});
