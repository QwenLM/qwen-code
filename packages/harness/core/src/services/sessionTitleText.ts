/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Message, UserMessage } from '../protocol/transcript/message.js';
import {
  isReplayableUserMessage,
  isSyntheticPromptText,
  parseBashInputPromptText,
  parseCommandPromptText,
  parseLocalCommandStdoutText,
} from '../protocol/transcript/message-utils.js';
import { isCommandStyleUserPromptText } from '../utils/commandStyleText.js';

const INTERNAL_TAGS = new Set([
  'system-reminder',
  'hook_context',
  'local-command-caveat',
  'loaded_context',
]);

interface Token {
  start: number;
  end: number;
  value: string;
  name?: string;
  closing: boolean;
  selfClosing: boolean;
  lineStart: number;
  lineEnd: number;
  indentedCode: boolean;
  escaped: boolean;
}

interface Block {
  open: number;
  close: number;
}

/** 标题专用规则，不改变历史展示或模型执行正文。 */
export function extractSessionTitleText(text: string): string {
  const clean = removeInternalBlocks(text);
  const { tokens, blocks, markup } = scanTitleWrappers(clean);

  let start = 0;
  let end = clean.length;
  for (const block of blocks) {
    const open = tokens[block.open]!;
    const close = tokens[block.close]!;
    if (
      !isStandalone(clean, open, close) ||
      clean.slice(start, open.start).trim()
    )
      break;
    start = close.end;
  }
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]!;
    const open = tokens[block.open]!;
    const close = tokens[block.close]!;
    if (
      open.start < start ||
      !isStandalone(clean, open, close) ||
      clean.slice(close.end, end).trim()
    )
      break;
    end = open.start;
  }
  const outside = clean.slice(start, end).trim();
  if (outside) return outside;
  // 没有外围正文时只去掉配对标记；代码区域和不完整标签不在 markup 中。
  return omitRanges(
    clean,
    tokens.filter((_, index) => markup.has(index)),
  ).trim();
}

export function getSessionTitleUserText(message: Message): string | null {
  if (
    !isReplayableUserMessage(message) ||
    (message.origin && message.origin.kind !== 'human')
  )
    return null;
  const blocks = getRawUserTextBlocks(message).filter(
    (text) => !isNonPromptText(removeInternalBlocks(text).trim()),
  );
  const text = extractSessionTitleText(blocks.join('\n'));
  return text && !isNonPromptText(text) ? text : null;
}

function getRawUserTextBlocks(message: UserMessage): string[] {
  // 通用展示工具会 trim 每个 block，标题代码区识别必须先保留首行缩进。
  const content = message.message.content;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) =>
    block.type === 'text' && typeof block.text === 'string' ? [block.text] : [],
  );
}

function scanTitleWrappers(text: string) {
  const tokens = tokenize(text);
  const nextTicks = nextBackticks(tokens);
  const stack: number[] = [];
  const blocks: Block[] = [];
  const markup = new Set<number>();

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const codeEnd = codeEndIndex(text, tokens, nextTicks, i);
    if (codeEnd !== undefined) {
      i = codeEnd;
    } else if (token.name) {
      if (token.selfClosing) {
        markup.add(i);
        if (!stack.length) blocks.push({ open: i, close: i });
      } else if (!token.closing) {
        stack.push(i);
      } else {
        const open = stack.pop();
        if (open === undefined || tokens[open]!.name !== token.name) {
          // 交错标签不是包装；保留整个异常区域的原文。
          stack.length = 0;
          continue;
        }
        markup.add(open);
        markup.add(i);
        if (!stack.length) blocks.push({ open, close: i });
      }
    }
  }

  return { tokens, blocks, markup };
}

function isNonPromptText(text: string): boolean {
  const commandEnvelope =
    /^<(?:command-name|command-message|bash-input|local-command-stdout)(?:\s|>)/.test(
      text,
    );
  return (
    isSyntheticPromptText(text) ||
    isCommandStyleUserPromptText(text) ||
    /^<bash-(?:stdout|stderr)(?:\s|>)/.test(text) ||
    (commandEnvelope &&
      (parseCommandPromptText(text) !== null ||
        parseBashInputPromptText(text) !== null ||
        parseLocalCommandStdoutText(text) !== null))
  );
}

function removeInternalBlocks(text: string): string {
  const tokens = tokenize(text);
  const nextTicks = nextBackticks(tokens);
  const opens = new Map<string, number[]>();
  const pairs = new Map<number, number>();
  // 内部块按标签配对，块内 Markdown 不参与结束位置判定。
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!token.name || !INTERNAL_TAGS.has(token.name)) continue;
    const stack = opens.get(token.name) ?? [];
    opens.set(token.name, stack);
    if (token.selfClosing) pairs.set(i, i);
    else if (!token.closing) stack.push(i);
    else {
      const open = stack.pop();
      if (open !== undefined) pairs.set(open, i);
    }
  }
  const removed: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < tokens.length; i++) {
    const codeEnd = codeEndIndex(text, tokens, nextTicks, i);
    if (codeEnd !== undefined) {
      i = codeEnd;
      continue;
    }
    const close = pairs.get(i);
    if (close !== undefined) {
      removed.push({ start: tokens[i]!.start, end: tokens[close]!.end });
      i = close;
    }
  }
  return omitRanges(text, removed);
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const indentedLines = indentedCodeLines(text);
  const pattern =
    /<\/([A-Za-z][\w:.-]*)\s*>|<([A-Za-z][\w:.-]*)(?=[\s/>])(?:[^<>"'`]|"[^"]*"|'[^']*')*>|`+|~{3,}/g;
  let lineStart = 0;
  let lineEnd = text.indexOf('\n');
  if (lineEnd < 0) lineEnd = text.length;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    while (lineEnd < start) {
      lineStart = lineEnd + 1;
      lineEnd = text.indexOf('\n', lineStart);
      if (lineEnd < 0) lineEnd = text.length;
    }
    const startLine = lineStart;
    const end = start + match[0].length;
    while (lineEnd < end) {
      lineStart = lineEnd + 1;
      lineEnd = text.indexOf('\n', lineStart);
      if (lineEnd < 0) lineEnd = text.length;
    }
    tokens.push({
      start,
      end,
      value: match[0],
      name: match[1] ?? match[2],
      closing: match[0].startsWith('</'),
      selfClosing: match[0].endsWith('/>'),
      lineStart: startLine,
      lineEnd,
      indentedCode: indentedLines.has(startLine),
      escaped: match[0].startsWith('`') && isEscaped(text, start),
    });
  }
  return tokens;
}

function indentedCodeLines(text: string): Set<number> {
  const lines = new Set<number>();
  let offset = 0;
  let previousBlank = true;
  let inCode = false;
  for (const line of text.split('\n')) {
    const blank = !line.trim();
    let indent = 0;
    for (const char of line) {
      if (char === ' ') indent++;
      else if (char === '\t') indent += 4 - (indent % 4);
      else break;
      if (indent >= 4) break;
    }
    if (!blank) inCode = indent >= 4 && (previousBlank || inCode);
    if (inCode) lines.add(offset);
    previousBlank = blank;
    offset += line.length + 1;
  }
  return lines;
}

function isEscaped(text: string, start: number): boolean {
  let slashes = 0;
  for (let i = start - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
  return slashes % 2 === 1;
}

function nextBackticks(tokens: readonly Token[]): Map<number, number> {
  const next = new Map<number, number>();
  const lengths = new Map<number, number>();
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i]!;
    if (!token.value.startsWith('`')) continue;
    const match = lengths.get(token.value.length);
    if (match !== undefined) next.set(i, match);
    lengths.set(token.value.length, i);
  }
  return next;
}

function codeEndIndex(
  text: string,
  tokens: readonly Token[],
  nextTicks: ReadonlyMap<number, number>,
  index: number,
): number | undefined {
  const token = tokens[index]!;
  if (token.indentedCode) return index;
  if (token.name || token.escaped) return undefined;
  if (
    token.value.length >= 3 &&
    token.start - token.lineStart <= 3 &&
    !text.slice(token.lineStart, token.start).trim() &&
    // 反引号围栏的 info 不能带反引号；同行闭合应按行内代码配对。
    (token.value.startsWith('~') ||
      !text.slice(token.end, token.lineEnd).includes('`'))
  ) {
    for (let i = index + 1; i < tokens.length; i++) {
      const end = tokens[i]!;
      if (
        !end.name &&
        end.value[0] === token.value[0] &&
        end.value.length >= token.value.length &&
        end.start - end.lineStart <= 3 &&
        isStandalone(text, end, end)
      )
        return i;
    }
    return tokens.length - 1;
  }
  return token.value.startsWith('`') ? nextTicks.get(index) : undefined;
}

function isStandalone(text: string, open: Token, close: Token): boolean {
  return (
    !text.slice(open.lineStart, open.start).trim() &&
    !text.slice(close.end, close.lineEnd).trim()
  );
}

function omitRanges(
  text: string,
  ranges: ReadonlyArray<{ start: number; end: number }>,
): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    parts.push(text.slice(cursor, range.start));
    cursor = range.end;
  }
  parts.push(text.slice(cursor));
  return parts.join(' ');
}
