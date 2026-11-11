/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import type {
  Entry,
  TranscriptMessage,
  TranscriptWorktreeSession,
} from '../../protocol/transcript/entry.js';
import type { Message } from '../../protocol/transcript/message.js';
import {
  getDisplayablePromptText,
  getRealUserPromptText,
  getUserPromptFallbackText,
  getUserTextBlocks,
  isHiddenUserMessageInDefaultHistory,
  parseBashInputPromptText,
} from '../../protocol/transcript/message-utils.js';
import { decodeTranscriptLine } from './entry-codec.js';

export const SESSION_CATALOG_CHUNK_BYTES = 64 * 1024;
export const SESSION_CATALOG_MAX_READ_BYTES = SESSION_CATALOG_CHUNK_BYTES * 2;

export type CatalogResumability = 'yes' | 'no' | 'unknown';

export interface TranscriptSessionCatalogMetadata {
  startTime?: string;
  displayName: string;
  firstUserMessage: string;
  summary?: string;
  customTitle?: string;
  aiTitle?: string;
  lastPrompt?: string;
  directories?: string[];
  forkedFrom?: {
    sessionId: string;
    messageUuid: string;
  };
  gitBranch?: string;
  cwd?: string;
  worktreeSession?: TranscriptWorktreeSession | null;
  resumability: CatalogResumability;
  bytesRead: number;
}

interface CatalogAccumulator {
  startTime?: string;
  firstRealPrompt?: string;
  firstFallbackPrompt?: string;
  summary?: string;
  customTitle?: string;
  aiTitle?: string;
  lastPrompt?: string;
  directories?: string[];
  forkedFrom?: {
    sessionId: string;
    messageUuid: string;
  };
  gitBranch?: string;
  messageCwd?: string;
  relocatedCwd?: string;
  worktreeSession?: TranscriptWorktreeSession | null;
  hasWorktreeState: boolean;
  hasResumableMessage: boolean;
}

interface BoundedTranscriptRead {
  head: string;
  completeText: string;
  tailText: string;
  isCompleteFile: boolean;
  bytesRead: number;
}

function createAccumulator(): CatalogAccumulator {
  return {
    hasWorktreeState: false,
    hasResumableMessage: false,
  };
}

function normalizeCatalogLabel(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return undefined;
  }
  const codePoints = Array.from(normalized);
  return codePoints.length <= 400
    ? normalized
    : `${codePoints.slice(0, 400).join('')}…`;
}

function isResumableMessage(message: Message): boolean {
  if (message.type === 'assistant') {
    return true;
  }
  if (message.type === 'system') {
    return message.isCompactSummary === true;
  }
  if (message.type !== 'user') {
    return false;
  }
  if (message.isCompactSummary === true) {
    return true;
  }
  if (isHiddenUserMessageInDefaultHistory(message)) {
    return false;
  }
  if (
    getRealUserPromptText(message) !== null ||
    (message.origin?.kind === 'human' && message.message !== undefined)
  ) {
    return true;
  }
  return getUserTextBlocks(message).some(
    (text) => parseBashInputPromptText(text) !== null,
  );
}

function consumeMessage(
  accumulator: CatalogAccumulator,
  message: TranscriptMessage,
): void {
  if (message.isSidechain) {
    return;
  }

  accumulator.startTime ??= message.timestamp;
  if (message.gitBranch) {
    accumulator.gitBranch = message.gitBranch;
  }
  if (message.cwd) {
    accumulator.messageCwd = message.cwd;
  }
  if (message.forkedFrom) {
    accumulator.forkedFrom = message.forkedFrom;
  }
  if (isResumableMessage(message)) {
    accumulator.hasResumableMessage = true;
  }

  if (message.type !== 'user') {
    return;
  }
  accumulator.firstRealPrompt ??= normalizeCatalogLabel(
    getRealUserPromptText(message) ?? undefined,
  );
  accumulator.firstFallbackPrompt ??= normalizeCatalogLabel(
    getUserPromptFallbackText(message) ?? undefined,
  );
}

function consumeEntry(
  accumulator: CatalogAccumulator,
  entry: Entry,
  sessionId: string,
): void {
  if (
    entry.type === 'user' ||
    entry.type === 'assistant' ||
    entry.type === 'system'
  ) {
    consumeMessage(accumulator, entry);
    return;
  }

  switch (entry.type) {
    case 'active-leaf':
      if (
        entry.sessionId === sessionId &&
        entry.explicit &&
        entry.leafUuid === null
      ) {
        accumulator.hasResumableMessage = true;
      }
      break;
    case 'summary':
      accumulator.summary = normalizeCatalogLabel(entry.summary);
      break;
    case 'custom-title':
      if (entry.sessionId === sessionId) {
        accumulator.customTitle = normalizeCatalogLabel(entry.customTitle);
      }
      break;
    case 'ai-title':
      if (entry.sessionId === sessionId) {
        accumulator.aiTitle = normalizeCatalogLabel(entry.aiTitle);
      }
      break;
    case 'last-prompt':
      if (entry.sessionId === sessionId) {
        accumulator.lastPrompt = normalizeCatalogLabel(
          getDisplayablePromptText(entry.lastPrompt),
        );
      }
      break;
    case 'workspace-directories':
      if (entry.sessionId === sessionId) {
        accumulator.directories = [...entry.directories];
      }
      break;
    case 'relocated':
      if (entry.sessionId === sessionId) {
        accumulator.relocatedCwd = entry.relocatedCwd;
      }
      break;
    case 'worktree-state':
      if (entry.sessionId === sessionId) {
        accumulator.hasWorktreeState = true;
        accumulator.worktreeSession = entry.worktreeSession;
      }
      break;
    default:
      break;
  }
}

function consumeLines(
  accumulator: CatalogAccumulator,
  text: string,
  sessionId: string,
): void {
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      continue;
    }
    const decoded = decodeTranscriptLine(line);
    if (decoded.kind === 'entry') {
      consumeEntry(accumulator, decoded.entry, sessionId);
    }
  }
}

function decodeJsonStringPrefix(
  text: string,
  valueStart: number,
  maxCodePoints = 400,
): string | undefined {
  let result = '';
  let cursor = valueStart;
  let codePoints = 0;

  while (cursor < text.length && codePoints < maxCodePoints) {
    const character = text[cursor]!;
    if (character === '"') {
      break;
    }
    if (character !== '\\') {
      result += character;
      cursor++;
      codePoints++;
      continue;
    }

    const escape = text[cursor + 1];
    if (escape === undefined) {
      break;
    }
    const simpleEscapes: Record<string, string> = {
      '"': '"',
      '\\': '\\',
      '/': '/',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
    };
    if (escape in simpleEscapes) {
      result += simpleEscapes[escape];
      cursor += 2;
      codePoints++;
      continue;
    }
    if (escape === 'u') {
      const hex = text.slice(cursor + 2, cursor + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
        break;
      }
      result += String.fromCharCode(Number.parseInt(hex, 16));
      cursor += 6;
      codePoints++;
      continue;
    }
    break;
  }

  return normalizeCatalogLabel(result);
}

function findStringValueStart(
  text: string,
  key: 'content' | 'text',
  from: number,
): number | undefined {
  const marker = `"${key}"`;
  const markerIndex = text.indexOf(marker, from);
  if (markerIndex < 0) {
    return undefined;
  }
  let cursor = markerIndex + marker.length;
  while (cursor < text.length && /\s/.test(text[cursor]!)) cursor++;
  if (text[cursor] !== ':') return undefined;
  cursor++;
  while (cursor < text.length && /\s/.test(text[cursor]!)) cursor++;
  return text[cursor] === '"' ? cursor + 1 : undefined;
}

function extractPartialHeadPrompt(head: string): string | undefined {
  // Writer-produced JSONL records place `type` first. Non-canonical legacy
  // records with another key order deliberately skip partial extraction; a
  // large inconclusive session stays visible and is fully validated on select.
  const markers = ['{"type":"user"', '\n{"type":"user"'];
  let lineStart = -1;
  for (const marker of markers) {
    const index = head.indexOf(marker);
    if (index >= 0 && (lineStart < 0 || index < lineStart)) {
      lineStart = index + (marker.startsWith('\n') ? 1 : 0);
    }
  }
  if (lineStart < 0) {
    return undefined;
  }

  const messageIndex = head.indexOf('"message"', lineStart);
  if (messageIndex < 0) {
    return undefined;
  }
  const contentMarker = head.indexOf('"content"', messageIndex);
  if (contentMarker < 0) {
    return undefined;
  }
  const contentValueStart = findStringValueStart(
    head,
    'content',
    contentMarker,
  );
  if (contentValueStart !== undefined) {
    return decodeJsonStringPrefix(head, contentValueStart);
  }
  const textValueStart = findStringValueStart(head, 'text', contentMarker);
  return textValueStart === undefined
    ? undefined
    : decodeJsonStringPrefix(head, textValueStart);
}

function consumePartialHead(
  accumulator: CatalogAccumulator,
  head: string,
): void {
  const prompt = extractPartialHeadPrompt(head);
  if (!prompt) {
    return;
  }
  const syntheticMessage = {
    type: 'user',
    uuid: 'catalog-partial-user',
    timestamp: '',
    message: { role: 'user', content: prompt },
  } as Message;
  accumulator.firstRealPrompt ??= normalizeCatalogLabel(
    getRealUserPromptText(syntheticMessage) ?? undefined,
  );
  accumulator.firstFallbackPrompt ??= normalizeCatalogLabel(
    getUserPromptFallbackText(syntheticMessage) ?? undefined,
  );
  if (isResumableMessage(syntheticMessage)) {
    accumulator.hasResumableMessage = true;
  }
}

async function readAt(
  handle: fs.FileHandle,
  length: number,
  position: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

async function readBoundedTranscript(
  filePath: string,
  fileSize: number,
): Promise<BoundedTranscriptRead> {
  const handle = await fs.open(filePath, 'r');
  try {
    if (fileSize <= SESSION_CATALOG_MAX_READ_BYTES) {
      const buffer = await readAt(handle, fileSize, 0);
      const text = buffer.toString('utf8');
      return {
        head: text,
        completeText: text,
        tailText: '',
        isCompleteFile: true,
        bytesRead: buffer.length,
      };
    }

    const headBuffer = await readAt(handle, SESSION_CATALOG_CHUNK_BYTES, 0);
    const tailStart = Math.max(0, fileSize - SESSION_CATALOG_CHUNK_BYTES);
    const tailBuffer = await readAt(
      handle,
      SESSION_CATALOG_CHUNK_BYTES,
      tailStart,
    );
    const head = headBuffer.toString('utf8');
    const tail = tailBuffer.toString('utf8');
    const headBoundary = head.lastIndexOf('\n');
    const tailBoundary = tail.indexOf('\n');

    return {
      head,
      completeText: headBoundary < 0 ? '' : head.slice(0, headBoundary + 1),
      tailText: tailBoundary < 0 ? '' : tail.slice(tailBoundary + 1),
      isCompleteFile: false,
      bytesRead: headBuffer.length + tailBuffer.length,
    };
  } finally {
    await handle.close();
  }
}

export async function readTranscriptSessionCatalogMetadata(
  filePath: string,
  sessionId: string,
  fileSize: number,
): Promise<TranscriptSessionCatalogMetadata> {
  const bounded = await readBoundedTranscript(filePath, fileSize);
  const accumulator = createAccumulator();
  consumeLines(accumulator, bounded.completeText, sessionId);
  if (!bounded.isCompleteFile) {
    consumePartialHead(accumulator, bounded.head);
  }
  consumeLines(accumulator, bounded.tailText, sessionId);

  const firstUserMessage =
    accumulator.firstRealPrompt ??
    accumulator.firstFallbackPrompt ??
    'Empty conversation';
  const displayName =
    accumulator.customTitle ??
    accumulator.aiTitle ??
    accumulator.lastPrompt ??
    accumulator.summary ??
    firstUserMessage;
  const resumability: CatalogResumability = accumulator.hasResumableMessage
    ? 'yes'
    : bounded.isCompleteFile
      ? 'no'
      : 'unknown';

  return {
    startTime: accumulator.startTime,
    displayName,
    firstUserMessage,
    summary: accumulator.summary,
    customTitle: accumulator.customTitle,
    aiTitle: accumulator.aiTitle,
    lastPrompt: accumulator.lastPrompt,
    directories: accumulator.directories,
    forkedFrom: accumulator.forkedFrom,
    gitBranch:
      accumulator.worktreeSession?.worktreeBranch ?? accumulator.gitBranch,
    cwd:
      accumulator.worktreeSession?.worktreePath ??
      accumulator.relocatedCwd ??
      accumulator.messageCwd,
    ...(accumulator.hasWorktreeState
      ? { worktreeSession: accumulator.worktreeSession ?? null }
      : {}),
    resumability,
    bytesRead: bounded.bytesRead,
  };
}
