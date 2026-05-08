/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { MarkdownDisplay } from '../../utils/MarkdownDisplay.js';
import { theme } from '../../semantic-colors.js';
import {
  getCachedStringWidth,
  sliceTextByVisualHeight,
  toCodePoints,
} from '../../utils/textUtils.js';
import { MaxSizedBox } from '../shared/MaxSizedBox.js';
import {
  SCREEN_READER_MODEL_PREFIX,
  SCREEN_READER_USER_PREFIX,
} from '../../textConstants.js';
import {
  getTextRepeatDiagnostics,
  logTuiStreamMetric,
} from '../../utils/tuiStreamDiagnostics.js';

interface UserMessageProps {
  text: string;
}

interface UserShellMessageProps {
  text: string;
}

interface AssistantMessageProps {
  text: string;
  isPending: boolean;
  availableTerminalHeight?: number;
  contentWidth: number;
}

interface AssistantMessageContentProps {
  text: string;
  isPending: boolean;
  availableTerminalHeight?: number;
  contentWidth: number;
  previousAssistantText?: string;
}

interface ThinkMessageProps {
  text: string;
  isPending: boolean;
  availableTerminalHeight?: number;
  contentWidth: number;
}

interface ThinkMessageContentProps {
  text: string;
  isPending: boolean;
  availableTerminalHeight?: number;
  contentWidth: number;
  previousAssistantText?: string;
}

interface PrefixedTextMessageProps {
  text: string;
  prefix: string;
  prefixColor: string;
  textColor: string;
  ariaLabel?: string;
  marginTop?: number;
  alignSelf?: 'auto' | 'flex-start' | 'center' | 'flex-end';
}

interface PrefixedMarkdownMessageProps {
  text: string;
  prefix: string;
  prefixColor: string;
  isPending: boolean;
  availableTerminalHeight?: number;
  contentWidth: number;
  ariaLabel?: string;
  textColor?: string;
  previousAssistantText?: string;
}

interface ContinuationMarkdownMessageProps {
  text: string;
  isPending: boolean;
  availableTerminalHeight?: number;
  contentWidth: number;
  basePrefix: string;
  textColor?: string;
  previousAssistantText?: string;
}

const MIN_PENDING_PREVIEW_HEIGHT = 1;
const DEFAULT_PENDING_PREVIEW_HEIGHT = 16;
const MAX_PENDING_PREVIEW_HEIGHT = 24;
const COMPACT_PENDING_PREVIEW_HEIGHT = 10;
const MEDIUM_PENDING_PREVIEW_HEIGHT = 14;
const MAX_PENDING_PREVIEW_REPEAT_LINES = 2;
const STREAMING_DISPLAY_FIX_VERSION = 'streaming-display-v4';
const markdownFenceDelimiterRegex = /^ {0,3}(`{3,}|~{3,}).*$/;
const FINGERPRINT_TAIL_CHARS = 2000;

interface PendingPreviewDiagnostics {
  rawSourceFingerprint: string;
  sourceTailFingerprint: string;
  renderedTailFingerprint: string;
  rawSourceChars: number;
  sourceTailChars: number;
  renderedTailChars: number;
  rawSourceLines: number;
  sourceTailLines: number;
  renderedTailLines: number;
  sourceVisualRows: number;
  renderedVisualRows: number;
  sourceMaxLineRepeatCount: number;
  sourceMaxLineRepeatFingerprint: string | null;
  renderedMaxLineRepeatCount: number;
  renderedMaxLineRepeatFingerprint: string | null;
  unclosedFenceStripped: boolean;
  strippedUnclosedFenceChars: number;
  strippedUnclosedFenceLines: number;
  strippedUnclosedTableChars: number;
  strippedUnclosedTableLines: number;
  unstableStructuralStripped: boolean;
  strippedUnstableStructuralChars: number;
  strippedUnstableStructuralLines: number;
  narrowStructuralPreviewDeferred: boolean;
  deferredNarrowStructuralChars: number;
  deferredNarrowStructuralLines: number;
  strippedIncompleteLineChars: number;
  strippedBoundaryBlankLines: number;
  collapsedBlankLines: number;
  collapsedStructuralRepeatLines: number;
  collapsedGenericRepeatLines: number;
  trimmedSliceBoundaryBlankLines: number;
  hiddenLinesCount: number;
  maxHeight: number | undefined;
  maxWidth: number;
}

interface PendingPreviewViewport {
  viewportHeight: number;
  maxViewportHeight: number;
  visualRows: number;
  containsStructuralLine: boolean;
}

interface DuplicateLineStats {
  maxLineRepeatCount: number;
  maxLineRepeatFingerprint: string | null;
}

interface PendingTextSlice {
  text: string;
  hiddenLinesCount: number;
  diagnostics: PendingPreviewDiagnostics;
}

interface UnclosedFenceStripResult {
  text: string;
  unclosedFenceStripped: boolean;
  strippedUnclosedFenceChars: number;
  strippedUnclosedFenceLines: number;
}

interface UnclosedTableStripResult {
  text: string;
  unclosedTableStripped: boolean;
  strippedUnclosedTableChars: number;
  strippedUnclosedTableLines: number;
}

interface UnstableStructuralStripResult {
  text: string;
  unstableStructuralStripped: boolean;
  strippedUnstableStructuralChars: number;
  strippedUnstableStructuralLines: number;
}

interface NarrowStructuralPreviewResult {
  text: string;
  narrowStructuralPreviewDeferred: boolean;
  deferredNarrowStructuralChars: number;
  deferredNarrowStructuralLines: number;
}

interface PendingPreviewNormalizationResult {
  text: string;
  strippedBoundaryBlankLines: number;
  collapsedBlankLines: number;
  collapsedStructuralRepeatLines: number;
  collapsedGenericRepeatLines: number;
  trimmedSliceBoundaryBlankLines: number;
}

interface TrailingRepeatState {
  lineKey: string;
  repeatCount: number;
}

type AssistantDisplayKind = 'prefixed' | 'continuation';

function getPrefixWidth(prefix: string): number {
  // Reserve one extra column so text never touches the prefix glyph.
  return stringWidth(prefix) + 1;
}

function isStreamDebugEnabled(): boolean {
  const value =
    process.env['QWEN_TUI_STREAM_DEBUG'] ?? process.env['QWEN_STREAM_DEBUG'];
  if (!value) {
    return false;
  }

  return !['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase());
}

function fingerprintText(text: string): string {
  let hash = 2166136261;
  for (const char of toCodePoints(text)) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }

  return `${text.length}:${(hash >>> 0).toString(16)}`;
}

function fingerprintTail(text: string): string {
  return fingerprintText(
    text.length > FINGERPRINT_TAIL_CHARS
      ? text.slice(-FINGERPRINT_TAIL_CHARS)
      : text,
  );
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split('\n').length;
}

function countVisualRows(text: string, maxWidth: number): number {
  if (text.length === 0) {
    return 0;
  }

  const visualWidth = Math.max(1, Math.floor(maxWidth));
  let visualRows = 1;
  let currentLineWidth = 0;

  for (const char of toCodePoints(text)) {
    if (char === '\n') {
      visualRows += 1;
      currentLineWidth = 0;
      continue;
    }

    const charWidth = Math.max(getCachedStringWidth(char), 1);
    if (currentLineWidth > 0 && currentLineWidth + charWidth > visualWidth) {
      visualRows += 1;
      currentLineWidth = 0;
    }

    currentLineWidth += charWidth;
  }

  return visualRows;
}

function getDuplicateLineStats(text: string): DuplicateLineStats {
  const counts = new Map<string, number>();
  let maxLine = '';
  let maxLineRepeatCount = 0;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    if (line.length === 0) {
      continue;
    }

    const count = (counts.get(line) ?? 0) + 1;
    counts.set(line, count);

    if (count > maxLineRepeatCount) {
      maxLine = line;
      maxLineRepeatCount = count;
    }
  }

  return {
    maxLineRepeatCount,
    maxLineRepeatFingerprint:
      maxLineRepeatCount > 1 ? fingerprintText(maxLine) : null,
  };
}

function trimBoundaryBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;

  while (start < end && isBlankLine(lines[start] ?? '')) {
    start += 1;
  }
  while (end > start && isBlankLine(lines[end - 1] ?? '')) {
    end -= 1;
  }

  return lines.slice(start, end);
}

function getPreviewLines(
  sourceText: string,
  sourceLines: string[],
  includeTrailingPartialLine = false,
): string[] {
  const previewLines =
    sourceText.endsWith('\n') || includeTrailingPartialLine
      ? sourceLines
      : sourceLines.slice(0, -1);

  return trimBoundaryBlankLines(
    previewLines.filter((line) => !markdownFenceDelimiterRegex.test(line)),
  );
}

function joinPreviewParts(prefixText: string, previewLines: string[]): string {
  const previewText = trimBoundaryBlankLines(previewLines).join('\n');
  return [prefixText.trimEnd(), previewText]
    .filter((part) => part.length > 0)
    .join('\n');
}

function stripUnclosedFenceSuffix(text: string): UnclosedFenceStripResult {
  const lines = text.split('\n');
  let openFence:
    | {
        char: string;
        length: number;
        lineIndex: number;
      }
    | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(markdownFenceDelimiterRegex);
    const delimiter = match?.[1];
    if (!delimiter) {
      continue;
    }

    const fenceChar = delimiter[0];
    if (!openFence) {
      openFence = {
        char: fenceChar,
        length: delimiter.length,
        lineIndex: index,
      };
      continue;
    }

    if (fenceChar === openFence.char && delimiter.length >= openFence.length) {
      openFence = undefined;
    }
  }

  if (!openFence) {
    return {
      text,
      unclosedFenceStripped: false,
      strippedUnclosedFenceChars: 0,
      strippedUnclosedFenceLines: 0,
    };
  }

  const prefixText = lines.slice(0, openFence.lineIndex).join('\n').trimEnd();
  const suffixText = lines.slice(openFence.lineIndex).join('\n');
  const previewLines = getPreviewLines(
    text,
    lines.slice(openFence.lineIndex + 1),
    true,
  );
  const previewText = previewLines.join('\n');
  const strippedText = joinPreviewParts(prefixText, previewLines);

  return {
    text: strippedText,
    unclosedFenceStripped: true,
    strippedUnclosedFenceChars: Math.max(
      0,
      suffixText.length - previewText.length,
    ),
    strippedUnclosedFenceLines: Math.max(
      0,
      lines.length - openFence.lineIndex - previewLines.length,
    ),
  };
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) {
    return false;
  }

  const cells = trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());

  return cells.length >= 2 && cells.some((cell) => cell.length > 0);
}

function isMarkdownTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) {
    return false;
  }

  const cells = trimmed
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim())
    .filter((cell) => cell.length > 0);

  return (
    cells.length > 0 &&
    cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s+/g, '')))
  );
}

function isMermaidDiagramBodyLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return false;
  }

  return (
    /^(?:class|interface|namespace|state|participant|actor)\b/.test(trimmed) ||
    /^%%/.test(trimmed) ||
    /(?:-->|---|-.->|==>|<\|--|<\|\.\.|\*--|o--|--\*|--o|\.\.>|->>|-->>|=>)/.test(
      trimmed,
    ) ||
    /^[A-Za-z][\w-]*(?:\[|\(|\{|>|\{)/.test(trimmed)
  );
}

function isUnstableStructuralPreviewLine(line: string): boolean {
  return (
    isRepeatedStructuralPreviewLine(line) ||
    isMarkdownTableRow(line) ||
    isMarkdownTableSeparator(line) ||
    isMermaidDiagramBodyLine(line)
  );
}

function stripUnclosedTableSuffix(text: string): UnclosedTableStripResult {
  const lines = text.split('\n');
  let tableStartIndex: number | undefined;
  let previousTableRowIndex: number | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';

    if (isMarkdownTableSeparator(line) && previousTableRowIndex !== undefined) {
      tableStartIndex = previousTableRowIndex;
      previousTableRowIndex = index;
      continue;
    }

    if (tableStartIndex !== undefined) {
      if (isMarkdownTableRow(line)) {
        previousTableRowIndex = index;
        continue;
      }

      tableStartIndex = undefined;
      previousTableRowIndex = undefined;
      continue;
    }

    previousTableRowIndex = isMarkdownTableRow(line) ? index : undefined;
  }

  if (tableStartIndex === undefined) {
    return {
      text,
      unclosedTableStripped: false,
      strippedUnclosedTableChars: 0,
      strippedUnclosedTableLines: 0,
    };
  }

  const prefixText = lines.slice(0, tableStartIndex).join('\n').trimEnd();
  const suffixText = lines.slice(tableStartIndex).join('\n');
  const previewLines = getPreviewLines(text, lines.slice(tableStartIndex));
  const previewText = previewLines.join('\n');
  const strippedText = joinPreviewParts(prefixText, previewLines);

  return {
    text: strippedText,
    unclosedTableStripped: true,
    strippedUnclosedTableChars: Math.max(
      0,
      suffixText.length - previewText.length,
    ),
    strippedUnclosedTableLines: Math.max(
      0,
      lines.length - tableStartIndex - previewLines.length,
    ),
  };
}

function stripUnstableStructuralSuffix(
  text: string,
): UnstableStructuralStripResult {
  const lines = text.split('\n');
  let contentEndIndex = lines.length;
  while (contentEndIndex > 0 && isBlankLine(lines[contentEndIndex - 1] ?? '')) {
    contentEndIndex -= 1;
  }

  let blockStartIndex = contentEndIndex;
  while (
    blockStartIndex > 0 &&
    !isBlankLine(lines[blockStartIndex - 1] ?? '')
  ) {
    blockStartIndex -= 1;
  }

  const blockLines = lines.slice(blockStartIndex, contentEndIndex);
  if (blockLines.length < 3) {
    return {
      text,
      unstableStructuralStripped: false,
      strippedUnstableStructuralChars: 0,
      strippedUnstableStructuralLines: 0,
    };
  }

  const structuralLineCount = blockLines.filter(
    isUnstableStructuralPreviewLine,
  ).length;
  const hasTableLine = blockLines.some(
    (line) => isMarkdownTableRow(line) || isMarkdownTableSeparator(line),
  );
  const hasDiagramLine = blockLines.some(isMermaidDiagramBodyLine);
  const hasStructuralLeader = blockLines.some(isRepeatedStructuralPreviewLine);
  const isMostlyStructural =
    structuralLineCount / Math.max(1, blockLines.length) >= 0.6;

  if (
    !isMostlyStructural ||
    (!hasTableLine && !hasDiagramLine && !hasStructuralLeader)
  ) {
    return {
      text,
      unstableStructuralStripped: false,
      strippedUnstableStructuralChars: 0,
      strippedUnstableStructuralLines: 0,
    };
  }

  return {
    text,
    unstableStructuralStripped: false,
    strippedUnstableStructuralChars: 0,
    strippedUnstableStructuralLines: 0,
  };
}

function isBlankLine(line: string): boolean {
  return line.trim().length === 0;
}

function isRepeatedStructuralPreviewLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    /^#{1,6}\s+\S/.test(trimmed) ||
    /^\|/.test(trimmed) ||
    /\|$/.test(trimmed) ||
    /^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|mindmap|timeline)\b/.test(
      trimmed,
    )
  );
}

function isProgressiveStructuralPreviewLine(
  previousLine: string,
  line: string,
): boolean {
  const previousKey = previousLine.trim();
  const lineKey = line.trim();
  if (
    previousKey.length < 4 ||
    lineKey.length < 4 ||
    previousKey === lineKey ||
    (!isUnstableStructuralPreviewLine(previousKey) &&
      !isUnstableStructuralPreviewLine(lineKey))
  ) {
    return false;
  }

  return previousKey.startsWith(lineKey) || lineKey.startsWith(previousKey);
}

function getRepeatedLineLimit(line: string): number {
  return isUnstableStructuralPreviewLine(line)
    ? 1
    : MAX_PENDING_PREVIEW_REPEAT_LINES;
}

function getTrailingRepeatState(
  text: string | undefined,
): TrailingRepeatState | undefined {
  if (!text) {
    return undefined;
  }

  const lines = text.split('\n');
  let index = lines.length - 1;
  while (index >= 0 && isBlankLine(lines[index])) {
    index -= 1;
  }

  if (index < 0) {
    return undefined;
  }

  const lineKey = lines[index].trim();
  let repeatCount = 0;
  while (index >= 0 && lines[index].trim() === lineKey) {
    repeatCount += 1;
    index -= 1;
  }

  return { lineKey, repeatCount };
}

function getPriorLineCounts(text: string | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  if (!text) {
    return counts;
  }

  for (const line of text.split('\n')) {
    const lineKey = line.trim();
    if (lineKey.length === 0) {
      continue;
    }

    counts.set(lineKey, (counts.get(lineKey) ?? 0) + 1);
  }

  return counts;
}

function stripIncompletePendingLineSuffix(text: string): {
  text: string;
  strippedIncompleteLineChars: number;
} {
  if (text.length === 0 || text.endsWith('\n')) {
    return { text, strippedIncompleteLineChars: 0 };
  }

  const lastNewlineIndex = text.lastIndexOf('\n');
  if (lastNewlineIndex === -1) {
    return { text, strippedIncompleteLineChars: 0 };
  }

  const finalLine = text.slice(lastNewlineIndex + 1).trim();
  const isLikelyIncompleteStructuralLine =
    finalLine.startsWith('|') && !finalLine.endsWith('|');
  if (!isLikelyIncompleteStructuralLine) {
    return { text, strippedIncompleteLineChars: 0 };
  }

  const strippedText = text.slice(0, lastNewlineIndex + 1);
  return {
    text: strippedText,
    strippedIncompleteLineChars: text.length - strippedText.length,
  };
}

function normalizePendingPreviewText(
  text: string,
  previousAssistantText?: string,
): PendingPreviewNormalizationResult {
  const sourceLines = text
    .split('\n')
    .filter((line) => !markdownFenceDelimiterRegex.test(line));
  let start = 0;
  let end = sourceLines.length;

  while (start < end && isBlankLine(sourceLines[start])) {
    start += 1;
  }
  while (end > start && isBlankLine(sourceLines[end - 1])) {
    end -= 1;
  }

  const strippedBoundaryBlankLines = start + (sourceLines.length - end);
  const normalizedLines: string[] = [];
  let lastNormalizedLineIndex = -1;
  let previousWasBlank = false;
  const previousAssistantLineState = getTrailingRepeatState(
    previousAssistantText,
  );
  let previousLine: string | null = previousAssistantLineState?.lineKey ?? null;
  let previousLineRepeatCount = previousAssistantLineState?.repeatCount ?? 0;
  const lineCounts = getPriorLineCounts(previousAssistantText);
  let collapsedBlankLines = 0;
  let collapsedStructuralRepeatLines = 0;
  let collapsedGenericRepeatLines = 0;

  for (const line of sourceLines.slice(start, end)) {
    const isBlank = isBlankLine(line);
    if (isBlank) {
      if (previousWasBlank) {
        collapsedBlankLines += 1;
        continue;
      }
      normalizedLines.push('');
      lastNormalizedLineIndex = normalizedLines.length - 1;
      previousWasBlank = true;
      previousLine = null;
      previousLineRepeatCount = 0;
      continue;
    }

    previousWasBlank = false;
    const lineKey = line.trim();
    previousLineRepeatCount =
      lineKey === previousLine ? previousLineRepeatCount + 1 : 1;

    if (
      previousLine !== null &&
      isProgressiveStructuralPreviewLine(previousLine, lineKey)
    ) {
      collapsedStructuralRepeatLines += 1;
      if (
        lineKey.length > previousLine.length &&
        lastNormalizedLineIndex >= 0
      ) {
        normalizedLines[lastNormalizedLineIndex] = line;
      }
      previousLine = lineKey;
      previousLineRepeatCount = 1;
      continue;
    }

    previousLine = lineKey;

    const repeatLimit = getRepeatedLineLimit(line);
    const lineRepeatCount = (lineCounts.get(lineKey) ?? 0) + 1;
    lineCounts.set(lineKey, lineRepeatCount);
    if (lineRepeatCount > repeatLimit) {
      if (repeatLimit === 1) {
        collapsedStructuralRepeatLines += 1;
      } else {
        collapsedGenericRepeatLines += 1;
      }
      continue;
    }

    if (previousLineRepeatCount > repeatLimit) {
      if (repeatLimit === 1) {
        collapsedStructuralRepeatLines += 1;
      } else {
        collapsedGenericRepeatLines += 1;
      }
      continue;
    }

    normalizedLines.push(line);
    lastNormalizedLineIndex = normalizedLines.length - 1;
  }

  return {
    text: normalizedLines.join('\n'),
    strippedBoundaryBlankLines,
    collapsedBlankLines,
    collapsedStructuralRepeatLines,
    collapsedGenericRepeatLines,
    trimmedSliceBoundaryBlankLines: 0,
  };
}

function normalizeAssistantDisplayText(
  text: string,
  previousAssistantText?: string,
): string {
  const sourceLines = text.split('\n');
  let start = 0;
  let end = sourceLines.length;

  while (start < end && isBlankLine(sourceLines[start])) {
    start += 1;
  }
  while (end > start && isBlankLine(sourceLines[end - 1])) {
    end -= 1;
  }

  const normalizedLines: string[] = [];
  let lastNormalizedLineIndex = -1;
  let previousWasBlank = false;
  const previousAssistantLineState = getTrailingRepeatState(
    previousAssistantText,
  );
  let previousLine: string | null = previousAssistantLineState?.lineKey ?? null;
  let previousLineRepeatCount = previousAssistantLineState?.repeatCount ?? 0;
  const lineCounts = getPriorLineCounts(previousAssistantText);

  for (const line of sourceLines.slice(start, end)) {
    if (isBlankLine(line)) {
      if (previousWasBlank) {
        continue;
      }
      normalizedLines.push('');
      lastNormalizedLineIndex = normalizedLines.length - 1;
      previousWasBlank = true;
      previousLine = null;
      previousLineRepeatCount = 0;
      continue;
    }

    previousWasBlank = false;
    const lineKey = line.trim();
    previousLineRepeatCount =
      lineKey === previousLine ? previousLineRepeatCount + 1 : 1;

    if (
      previousLine !== null &&
      isProgressiveStructuralPreviewLine(previousLine, lineKey)
    ) {
      if (
        lineKey.length > previousLine.length &&
        lastNormalizedLineIndex >= 0
      ) {
        normalizedLines[lastNormalizedLineIndex] = line;
      }
      previousLine = lineKey;
      previousLineRepeatCount = 1;
      continue;
    }

    previousLine = lineKey;

    const repeatLimit = getRepeatedLineLimit(line);
    const lineRepeatCount = (lineCounts.get(lineKey) ?? 0) + 1;
    lineCounts.set(lineKey, lineRepeatCount);
    if (lineRepeatCount > repeatLimit) {
      continue;
    }

    if (previousLineRepeatCount > repeatLimit) {
      continue;
    }

    normalizedLines.push(line);
    lastNormalizedLineIndex = normalizedLines.length - 1;
  }

  return normalizedLines.join('\n');
}

function createPendingPreviewDiagnostics(
  rawSourceText: string,
  sourceTailText: string,
  renderedTailText: string,
  hiddenLinesCount: number,
  maxHeight: number | undefined,
  maxWidth: number,
  unclosedFenceStrip: UnclosedFenceStripResult,
  unclosedTableStrip: UnclosedTableStripResult,
  unstableStructuralStrip: UnstableStructuralStripResult,
  narrowStructuralPreview: NarrowStructuralPreviewResult,
  pendingPreviewNormalization: PendingPreviewNormalizationResult,
  strippedIncompleteLineChars: number,
): PendingPreviewDiagnostics {
  const sourceDuplicateStats = getDuplicateLineStats(sourceTailText);
  const renderedDuplicateStats = getDuplicateLineStats(renderedTailText);

  return {
    rawSourceFingerprint: fingerprintTail(rawSourceText),
    sourceTailFingerprint: fingerprintTail(sourceTailText),
    renderedTailFingerprint: fingerprintTail(renderedTailText),
    rawSourceChars: rawSourceText.length,
    sourceTailChars: sourceTailText.length,
    renderedTailChars: renderedTailText.length,
    rawSourceLines: countLines(rawSourceText),
    sourceTailLines: countLines(sourceTailText),
    renderedTailLines: countLines(renderedTailText),
    sourceVisualRows: countVisualRows(sourceTailText, maxWidth),
    renderedVisualRows: countVisualRows(renderedTailText, maxWidth),
    sourceMaxLineRepeatCount: sourceDuplicateStats.maxLineRepeatCount,
    sourceMaxLineRepeatFingerprint:
      sourceDuplicateStats.maxLineRepeatFingerprint,
    renderedMaxLineRepeatCount: renderedDuplicateStats.maxLineRepeatCount,
    renderedMaxLineRepeatFingerprint:
      renderedDuplicateStats.maxLineRepeatFingerprint,
    unclosedFenceStripped: unclosedFenceStrip.unclosedFenceStripped,
    strippedUnclosedFenceChars: unclosedFenceStrip.strippedUnclosedFenceChars,
    strippedUnclosedFenceLines: unclosedFenceStrip.strippedUnclosedFenceLines,
    strippedUnclosedTableChars: unclosedTableStrip.strippedUnclosedTableChars,
    strippedUnclosedTableLines: unclosedTableStrip.strippedUnclosedTableLines,
    unstableStructuralStripped:
      unstableStructuralStrip.unstableStructuralStripped,
    strippedUnstableStructuralChars:
      unstableStructuralStrip.strippedUnstableStructuralChars,
    strippedUnstableStructuralLines:
      unstableStructuralStrip.strippedUnstableStructuralLines,
    narrowStructuralPreviewDeferred:
      narrowStructuralPreview.narrowStructuralPreviewDeferred,
    deferredNarrowStructuralChars:
      narrowStructuralPreview.deferredNarrowStructuralChars,
    deferredNarrowStructuralLines:
      narrowStructuralPreview.deferredNarrowStructuralLines,
    strippedIncompleteLineChars,
    strippedBoundaryBlankLines:
      pendingPreviewNormalization.strippedBoundaryBlankLines,
    collapsedBlankLines: pendingPreviewNormalization.collapsedBlankLines,
    collapsedStructuralRepeatLines:
      pendingPreviewNormalization.collapsedStructuralRepeatLines,
    collapsedGenericRepeatLines:
      pendingPreviewNormalization.collapsedGenericRepeatLines,
    trimmedSliceBoundaryBlankLines:
      pendingPreviewNormalization.trimmedSliceBoundaryBlankLines,
    hiddenLinesCount,
    maxHeight,
    maxWidth,
  };
}

function useAssistantDisplayDiagnostics(
  kind: AssistantDisplayKind,
  rawText: string,
  displayedText: string,
  isPending: boolean,
  previousAssistantText: string | undefined,
): void {
  useEffect(() => {
    if (!isStreamDebugEnabled()) {
      return;
    }

    logTuiStreamMetric('ASSISTANT_DISPLAY', 'assistant_display_metrics', {
      kind,
      isPending,
      hasPreviousAssistantText: previousAssistantText !== undefined,
      rawText: getTextRepeatDiagnostics(rawText),
      displayedText: getTextRepeatDiagnostics(displayedText),
      previousAssistantText:
        previousAssistantText === undefined
          ? undefined
          : getTextRepeatDiagnostics(previousAssistantText),
    });
  }, [displayedText, isPending, kind, previousAssistantText, rawText]);
}

export function hasVisiblePendingAssistantMarkdown(
  text: string,
  availableTerminalHeight: number | undefined,
  contentWidth: number,
  previousAssistantText?: string,
): boolean {
  const markdownWidth = Math.max(1, contentWidth - getPrefixWidth('✦'));
  const pendingPreviewHeight = getPendingPreviewHeight(availableTerminalHeight);
  return (
    slicePendingTextForHeight(
      text,
      pendingPreviewHeight,
      markdownWidth,
      previousAssistantText,
    ).text.length > 0
  );
}

export function hasRenderablePendingAssistantSignal(text: string): boolean {
  const normalizedLines = trimBoundaryBlankLines(text.split('\n')).filter(
    (line) => !markdownFenceDelimiterRegex.test(line),
  );

  return normalizedLines.some((line) => line.trim().length > 0);
}

function slicePendingTextForHeight(
  text: string,
  maxHeight: number | undefined,
  maxWidth: number,
  previousAssistantText?: string,
): PendingTextSlice {
  const narrowStructuralPreview: NarrowStructuralPreviewResult = {
    text,
    narrowStructuralPreviewDeferred: false,
    deferredNarrowStructuralChars: 0,
    deferredNarrowStructuralLines: 0,
  };
  const unclosedFenceStrip = stripUnclosedFenceSuffix(text);
  const unclosedTableStrip = unclosedFenceStrip.unclosedFenceStripped
    ? {
        text: unclosedFenceStrip.text,
        unclosedTableStripped: false,
        strippedUnclosedTableChars: 0,
        strippedUnclosedTableLines: 0,
      }
    : stripUnclosedTableSuffix(unclosedFenceStrip.text);
  const unstableStructuralStrip =
    unclosedFenceStrip.unclosedFenceStripped ||
    unclosedTableStrip.unclosedTableStripped
      ? {
          text: unclosedTableStrip.text,
          unstableStructuralStripped: false,
          strippedUnstableStructuralChars: 0,
          strippedUnstableStructuralLines: 0,
        }
      : stripUnstableStructuralSuffix(unclosedTableStrip.text);
  const incompleteLineStrip = stripIncompletePendingLineSuffix(
    unstableStructuralStrip.text,
  );
  // Some models stream long runs of blank lines around useful content. Keep
  // those out of the live viewport so blank rows do not push stable streaming
  // text into scrollback on every repaint. The committed transcript still
  // renders the full assistant message through MarkdownDisplay.
  const pendingPreviewNormalization = normalizePendingPreviewText(
    incompleteLineStrip.text,
    previousAssistantText,
  );
  const previewText = pendingPreviewNormalization.text;

  const slice = sliceTextByVisualHeight(previewText, maxHeight, maxWidth, {
    minHeight: MIN_PENDING_PREVIEW_HEIGHT,
    reservedRows: 0,
    overflowDirection: 'top',
  });
  const slicedLines = slice.text.split('\n');
  const trimmedSlicedLines = trimBoundaryBlankLines(slicedLines);
  const trimmedSliceBoundaryBlankLines = Math.max(
    0,
    slicedLines.length - trimmedSlicedLines.length,
  );
  const trimmedSliceText = trimmedSlicedLines.join('\n');
  const normalizedSlice = {
    text: trimmedSliceText,
    hiddenLinesCount: slice.hiddenLinesCount,
  };

  return {
    ...normalizedSlice,
    diagnostics: createPendingPreviewDiagnostics(
      text,
      previewText,
      normalizedSlice.text,
      normalizedSlice.hiddenLinesCount,
      maxHeight,
      maxWidth,
      unclosedFenceStrip,
      unclosedTableStrip,
      unstableStructuralStrip,
      narrowStructuralPreview,
      {
        ...pendingPreviewNormalization,
        trimmedSliceBoundaryBlankLines,
      },
      incompleteLineStrip.strippedIncompleteLineChars,
    ),
  };
}

function getPendingPreviewHeight(
  availableTerminalHeight: number | undefined,
): number | undefined {
  if (availableTerminalHeight === undefined) {
    return DEFAULT_PENDING_PREVIEW_HEIGHT;
  }

  if (availableTerminalHeight <= COMPACT_PENDING_PREVIEW_HEIGHT) {
    return availableTerminalHeight;
  }

  if (availableTerminalHeight <= 16) {
    return COMPACT_PENDING_PREVIEW_HEIGHT;
  }

  if (availableTerminalHeight <= 24) {
    return MEDIUM_PENDING_PREVIEW_HEIGHT;
  }

  return Math.min(
    MAX_PENDING_PREVIEW_HEIGHT,
    Math.max(MEDIUM_PENDING_PREVIEW_HEIGHT, availableTerminalHeight - 6),
  );
}

function getPendingPreviewViewport(
  text: string,
  maxHeight: number | undefined,
  maxWidth: number,
): PendingPreviewViewport {
  const maxViewportHeight = Math.max(
    MIN_PENDING_PREVIEW_HEIGHT,
    maxHeight ?? MAX_PENDING_PREVIEW_HEIGHT,
  );
  const visualRows = countVisualRows(text, maxWidth);
  return {
    viewportHeight: Math.max(
      MIN_PENDING_PREVIEW_HEIGHT,
      Math.min(maxViewportHeight, visualRows),
    ),
    maxViewportHeight,
    visualRows,
    containsStructuralLine: text
      .split('\n')
      .some(isUnstableStructuralPreviewLine),
  };
}

// Streaming pending output is always rendered as plain text (not through
// MarkdownDisplay) so that the visual height we use for slicing matches the
// height that actually reaches Ink/Yoga. MarkdownDisplay's code blocks,
// tables, and list items can each render taller than their source text
// (line-number prefixes, table borders, paddingLeft narrowing the wrap
// width), and that gap was letting pending output exceed the viewport on
// narrow terminals — which made Ink leak the topmost row into scrollback
// every frame, producing the duplicate output in #3279. Once a stable
// prefix is promoted into <Static>, the committed message is rendered
// through MarkdownDisplay with full formatting; only the still-streaming
// tail stays plain. The pre-sliced tail is capped to a small live viewport and
// still wrapped in MaxSizedBox as a hard guard, so any remaining source-vs-Ink
// measurement mismatch cannot grow the dynamic region enough to scroll the
// terminal and leak previous frames into scrollback. The live preview also
// suppresses synthetic hidden-line banners and Markdown fence delimiters. Claude
// Code uses a richer streaming Markdown path for the same reason: control rows
// and syntax delimiter rows should not be written into the main-screen
// scrollback on every streaming frame. Qwen keeps the final transcript rich by
// rendering committed messages through MarkdownDisplay after they move into
// Static.
const PendingTextPreview: React.FC<{
  text: string;
  hiddenLinesCount: number;
  textColor: string;
  maxHeight: number;
  maxWidth: number;
}> = ({ text, hiddenLinesCount, textColor, maxHeight, maxWidth }) => {
  if (text.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" justifyContent="flex-start" flexShrink={0}>
      <MaxSizedBox
        maxHeight={maxHeight}
        maxWidth={maxWidth}
        additionalHiddenLinesCount={hiddenLinesCount}
        showHiddenLinesMessage={false}
      >
        {text.split('\n').map((line, index) => (
          <Box key={index}>
            <Text wrap="wrap" color={textColor}>
              {line}
            </Text>
          </Box>
        ))}
      </MaxSizedBox>
    </Box>
  );
};

const PendingMarkdownContent: React.FC<{
  text: string;
  hiddenLinesCount: number;
  diagnostics: PendingPreviewDiagnostics | undefined;
  textColor: string;
  availableTerminalHeight: number | undefined;
  contentWidth: number;
}> = ({
  text,
  hiddenLinesCount,
  diagnostics,
  textColor,
  availableTerminalHeight,
  contentWidth,
}) => {
  const previewHeight = getPendingPreviewHeight(availableTerminalHeight);
  const previewViewport = getPendingPreviewViewport(
    text,
    previewHeight,
    contentWidth,
  );
  const previousFingerprintsRef = useRef({
    sourceTailFingerprint: '',
    renderedTailFingerprint: '',
    sameSourceTailRenderCount: 0,
    sameRenderedTailRenderCount: 0,
  });

  useEffect(() => {
    if (!diagnostics || !isStreamDebugEnabled()) {
      return;
    }

    const previous = previousFingerprintsRef.current;
    const sameSourceTailRenderCount =
      previous.sourceTailFingerprint === diagnostics.sourceTailFingerprint
        ? previous.sameSourceTailRenderCount + 1
        : 1;
    const sameRenderedTailRenderCount =
      previous.renderedTailFingerprint === diagnostics.renderedTailFingerprint
        ? previous.sameRenderedTailRenderCount + 1
        : 1;

    previousFingerprintsRef.current = {
      sourceTailFingerprint: diagnostics.sourceTailFingerprint,
      renderedTailFingerprint: diagnostics.renderedTailFingerprint,
      sameSourceTailRenderCount,
      sameRenderedTailRenderCount,
    };

    logTuiStreamMetric('PENDING_PREVIEW', 'pending_preview_metrics', {
      ...diagnostics,
      sameSourceTailRenderCount,
      sameRenderedTailRenderCount,
      availableTerminalHeight,
      previewHeight,
      previewViewport,
      contentWidth,
      fixVersion: STREAMING_DISPLAY_FIX_VERSION,
    });
  }, [
    availableTerminalHeight,
    contentWidth,
    diagnostics,
    previewHeight,
    previewViewport,
  ]);

  return (
    <PendingTextPreview
      text={text}
      hiddenLinesCount={hiddenLinesCount}
      textColor={textColor}
      maxHeight={previewViewport.viewportHeight}
      maxWidth={contentWidth}
    />
  );
};

const PrefixedTextMessage: React.FC<PrefixedTextMessageProps> = ({
  text,
  prefix,
  prefixColor,
  textColor,
  ariaLabel,
  marginTop = 0,
  alignSelf,
}) => {
  const prefixWidth = getPrefixWidth(prefix);

  return (
    <Box
      flexDirection="row"
      paddingY={0}
      marginTop={marginTop}
      alignSelf={alignSelf}
    >
      <Box width={prefixWidth}>
        <Text color={prefixColor} aria-label={ariaLabel}>
          {prefix}
        </Text>
      </Box>
      <Box flexGrow={1}>
        <Text wrap="wrap" color={textColor}>
          {text}
        </Text>
      </Box>
    </Box>
  );
};

const PrefixedMarkdownMessage: React.FC<PrefixedMarkdownMessageProps> = ({
  text,
  prefix,
  prefixColor,
  isPending,
  availableTerminalHeight,
  contentWidth,
  ariaLabel,
  textColor,
  previousAssistantText,
}) => {
  const prefixWidth = getPrefixWidth(prefix);
  const markdownWidth = Math.max(1, contentWidth - prefixWidth);
  const pendingPreviewHeight = getPendingPreviewHeight(availableTerminalHeight);
  const effectiveTextColor = textColor ?? theme.text.primary;
  const pendingSlice = isPending
    ? slicePendingTextForHeight(
        text,
        pendingPreviewHeight,
        markdownWidth,
        previousAssistantText,
      )
    : {
        text: normalizeAssistantDisplayText(text, previousAssistantText),
        hiddenLinesCount: 0,
        diagnostics: undefined,
      };

  useAssistantDisplayDiagnostics(
    'prefixed',
    text,
    pendingSlice.text,
    isPending,
    previousAssistantText,
  );

  if (pendingSlice.text.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="row">
      <Box width={prefixWidth}>
        <Text color={prefixColor} aria-label={ariaLabel}>
          {prefix}
        </Text>
      </Box>
      <Box width={markdownWidth} flexShrink={1} flexDirection="column">
        {isPending ? (
          <PendingMarkdownContent
            text={pendingSlice.text}
            hiddenLinesCount={pendingSlice.hiddenLinesCount}
            diagnostics={pendingSlice.diagnostics}
            textColor={effectiveTextColor}
            availableTerminalHeight={availableTerminalHeight}
            contentWidth={markdownWidth}
          />
        ) : (
          <MarkdownDisplay
            text={pendingSlice.text}
            isPending={isPending}
            availableTerminalHeight={availableTerminalHeight}
            contentWidth={markdownWidth}
            textColor={textColor}
          />
        )}
      </Box>
    </Box>
  );
};

const ContinuationMarkdownMessage: React.FC<
  ContinuationMarkdownMessageProps
> = ({
  text,
  isPending,
  availableTerminalHeight,
  contentWidth,
  basePrefix,
  textColor,
  previousAssistantText,
}) => {
  const prefixWidth = getPrefixWidth(basePrefix);
  const markdownWidth = Math.max(1, contentWidth - prefixWidth);
  const pendingPreviewHeight = getPendingPreviewHeight(availableTerminalHeight);
  const effectiveTextColor = textColor ?? theme.text.primary;
  const pendingSlice = isPending
    ? slicePendingTextForHeight(
        text,
        pendingPreviewHeight,
        markdownWidth,
        previousAssistantText,
      )
    : {
        text: normalizeAssistantDisplayText(text, previousAssistantText),
        hiddenLinesCount: 0,
        diagnostics: undefined,
      };

  useAssistantDisplayDiagnostics(
    'continuation',
    text,
    pendingSlice.text,
    isPending,
    previousAssistantText,
  );

  if (pendingSlice.text.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" paddingLeft={prefixWidth}>
      {isPending ? (
        <PendingMarkdownContent
          text={pendingSlice.text}
          hiddenLinesCount={pendingSlice.hiddenLinesCount}
          diagnostics={pendingSlice.diagnostics}
          textColor={effectiveTextColor}
          availableTerminalHeight={availableTerminalHeight}
          contentWidth={markdownWidth}
        />
      ) : (
        <MarkdownDisplay
          text={pendingSlice.text}
          isPending={isPending}
          availableTerminalHeight={availableTerminalHeight}
          contentWidth={markdownWidth}
          textColor={textColor}
        />
      )}
    </Box>
  );
};

export const UserMessage: React.FC<UserMessageProps> = ({ text }) => (
  <PrefixedTextMessage
    text={text}
    prefix=">"
    prefixColor={theme.text.accent}
    textColor={theme.text.accent}
    ariaLabel={SCREEN_READER_USER_PREFIX}
    alignSelf="flex-start"
  />
);

export const UserShellMessage: React.FC<UserShellMessageProps> = ({ text }) => {
  const commandToDisplay = text.startsWith('!') ? text.substring(1) : text;

  return (
    <PrefixedTextMessage
      text={commandToDisplay}
      prefix="$"
      prefixColor={theme.text.link}
      textColor={theme.text.primary}
    />
  );
};

export const AssistantMessage: React.FC<AssistantMessageProps> = ({
  text,
  isPending,
  availableTerminalHeight,
  contentWidth,
}) => (
  <PrefixedMarkdownMessage
    text={text}
    prefix="✦"
    prefixColor={theme.text.accent}
    ariaLabel={SCREEN_READER_MODEL_PREFIX}
    isPending={isPending}
    availableTerminalHeight={availableTerminalHeight}
    contentWidth={contentWidth}
  />
);

export const PendingAssistantPlaceholder: React.FC = () => (
  <PrefixedTextMessage
    text="Generating response..."
    prefix="✦"
    prefixColor={theme.text.accent}
    textColor={theme.text.secondary}
  />
);

export const AssistantMessageContent: React.FC<
  AssistantMessageContentProps
> = ({
  text,
  isPending,
  availableTerminalHeight,
  contentWidth,
  previousAssistantText,
}) => (
  <ContinuationMarkdownMessage
    text={text}
    isPending={isPending}
    availableTerminalHeight={availableTerminalHeight}
    contentWidth={contentWidth}
    basePrefix="✦"
    previousAssistantText={previousAssistantText}
  />
);

export const ThinkMessage: React.FC<ThinkMessageProps> = ({
  text,
  isPending,
  availableTerminalHeight,
  contentWidth,
}) => (
  <PrefixedMarkdownMessage
    text={text}
    prefix="✦"
    prefixColor={theme.text.secondary}
    isPending={isPending}
    availableTerminalHeight={availableTerminalHeight}
    contentWidth={contentWidth}
    textColor={theme.text.secondary}
  />
);

export const ThinkMessageContent: React.FC<ThinkMessageContentProps> = ({
  text,
  isPending,
  availableTerminalHeight,
  contentWidth,
  previousAssistantText,
}) => (
  <ContinuationMarkdownMessage
    text={text}
    isPending={isPending}
    availableTerminalHeight={availableTerminalHeight}
    contentWidth={contentWidth}
    basePrefix="✦"
    textColor={theme.text.secondary}
    previousAssistantText={previousAssistantText}
  />
);
