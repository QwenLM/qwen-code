/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo } from 'react';
import { Box, Text, useIsScreenReaderEnabled } from 'ink';
import { type Hunk } from '../../utils/color-diff.js';
import { RawAnsi } from '../shared/RawAnsi.js';
import {
  theme as semanticTheme,
  getThemeType,
  getThemeName,
} from '../../semantic-colors.js';
import { useAlternateBuffer } from '../../hooks/useAlternateBuffer.js';
import {
  getHunksFromDiffString,
  renderHunkCached,
  renderNewFileCached,
  type DiffRenderCacheEntry,
} from './diffRenderCore.js';

/**
 * Map our theme to color-diff's theme name string.
 * color-diff uses substring matching: 'dark' → Monokai, 'ansi' → 16-color,
 * anything else → GitHub Light.
 *
 * ANSI themes have type='dark'/'light' but need the 'ansi' color-diff path,
 * so we check the theme name first.
 */
export function getColorDiffThemeName(): string {
  const name = getThemeName();
  if (/ansi/i.test(name)) return 'ansi';
  const type = getThemeType();
  return type === 'light' ? 'light' : 'dark';
}

// ---------------------------------------------------------------------------
// DiffLine / parseDiffWithLineNumbers (screen reader path)
// ---------------------------------------------------------------------------

interface DiffLine {
  type: 'add' | 'del' | 'context' | 'hunk' | 'other';
  oldLine?: number;
  newLine?: number;
  content: string;
}

export function parseDiffWithLineNumbers(diffContent: string): DiffLine[] {
  const lines = diffContent.split(/\r?\n/);
  const result: DiffLine[] = [];
  let currentOldLine = 0;
  let currentNewLine = 0;
  let inHunk = false;
  const hunkHeaderRegex = /^@@ -(\d+),?\d* \+(\d+),?\d* @@/;

  for (const line of lines) {
    const hunkMatch = line.match(hunkHeaderRegex);
    if (hunkMatch) {
      currentOldLine = parseInt(hunkMatch[1], 10);
      currentNewLine = parseInt(hunkMatch[2], 10);
      inHunk = true;
      result.push({ type: 'hunk', content: line });
      currentOldLine--;
      currentNewLine--;
      continue;
    }
    if (!inHunk) {
      continue;
    }
    if (line.startsWith('+')) {
      currentNewLine++;
      result.push({
        type: 'add',
        newLine: currentNewLine,
        content: line.substring(1),
      });
    } else if (line.startsWith('-')) {
      currentOldLine++;
      result.push({
        type: 'del',
        oldLine: currentOldLine,
        content: line.substring(1),
      });
    } else if (line.startsWith(' ')) {
      currentOldLine++;
      currentNewLine++;
      result.push({
        type: 'context',
        oldLine: currentOldLine,
        newLine: currentNewLine,
        content: line.substring(1),
      });
    } else if (line.startsWith('\\')) {
      result.push({ type: 'other', content: line });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// isNewFile resolution
// ---------------------------------------------------------------------------

/**
 * Heuristic fallback: a diff is "new file" when every content line is an addition.
 */
function isNewFileDiffHeuristic(hunks: Hunk[]): boolean {
  if (hunks.length === 0) return false;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      const marker = line.charAt(0);
      if (marker === ' ' || marker === '-') return false;
    }
  }
  return true;
}

/**
 * Check patch headers for /dev/null or "new file mode".
 */
function isNewFileFromHeaders(diffContent: string): boolean | undefined {
  const headerEnd = diffContent.indexOf('@@');
  if (headerEnd === -1) return undefined;
  const header = diffContent.slice(0, headerEnd);
  if (/^---\s+\/dev\/null/m.test(header)) return true;
  if (/^new file mode/m.test(header)) return true;
  return undefined;
}

/**
 * Priority: explicit prop > patch headers > hunk heuristic.
 */
function resolveIsNewFile(
  hunks: Hunk[],
  diffContent: string,
  isNewFileProp?: boolean,
): boolean {
  if (isNewFileProp === true) return true;
  if (isNewFileProp === false) return false;
  const fromHeaders = isNewFileFromHeaders(diffContent);
  if (fromHeaders !== undefined) return fromHeaders;
  return isNewFileDiffHeuristic(hunks);
}

// ---------------------------------------------------------------------------
// Hunk helpers
// ---------------------------------------------------------------------------

function extractFirstLine(hunks: Hunk[]): string | null {
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      const marker = line.charAt(0);
      if (marker === '+' || marker === ' ') {
        return line.slice(1);
      }
    }
  }
  return null;
}

function extractAddedContentFromHunks(hunks: Hunk[]): string {
  return hunks
    .flatMap((h) => h.lines)
    .filter((l) => l.charAt(0) === '+')
    .map((l) => l.slice(1))
    .join('\n');
}

const NO_CHANGES = (
  <Box padding={1}>
    <Text dimColor>No changes detected.</Text>
  </Box>
);

// ---------------------------------------------------------------------------
// Plain-text fallback when ColorDiff.render() returns null
// ---------------------------------------------------------------------------

function renderFallbackHunk(
  hunk: Hunk,
  hunkIndex: number,
  disableColor: boolean,
): React.ReactNode[] {
  return hunk.lines.map((line, i) => {
    const marker = line.charAt(0);
    const color =
      marker === '+'
        ? semanticTheme.status.success
        : marker === '-'
          ? semanticTheme.status.error
          : undefined;
    return (
      <Text
        key={`fb-h${hunkIndex}-${i}`}
        color={color}
        dimColor={disableColor}
        wrap="truncate-end"
      >
        {line}
      </Text>
    );
  });
}

// ---------------------------------------------------------------------------
// Unified hunk rendering core
// ---------------------------------------------------------------------------

/**
 * Strategy callback: converts a cached render entry into React nodes.
 * Called once per hunk after cache lookup.
 */
type HunkEntryRenderer = (
  entry: DiffRenderCacheEntry,
  hi: number,
  width: number,
) => React.ReactNode[];

/**
 * Shared scaffold for iterating hunks: separator insertion, cache lookup,
 * fallback on miss, and delegation to a strategy for final React output.
 */
function renderHunksCore(
  hunks: Hunk[],
  firstLine: string | null,
  resolvedPath: string,
  colorDiffTheme: string,
  width: number,
  disableColor: boolean,
  splitGutter: boolean,
  renderEntry: HunkEntryRenderer,
): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  for (let hi = 0; hi < hunks.length; hi++) {
    const hunk = hunks[hi];
    if (hi > 0) {
      out.push(
        <Text key={`sep-${hi}`} dimColor>
          ...
        </Text>,
      );
    }

    const cached = renderHunkCached(
      hunk,
      firstLine,
      resolvedPath,
      colorDiffTheme,
      width,
      disableColor,
      splitGutter,
    );

    if (!cached) {
      out.push(...renderFallbackHunk(hunk, hi, disableColor));
      continue;
    }

    out.push(...renderEntry(cached, hi, width));
  }
  return out;
}

// Strategy: one React node per line (for ScrollableList)
const lineEntryRenderer: HunkEntryRenderer = (entry, hi, width) => {
  const { lines, gutterWidth, gutters, contents } = entry;
  const out: React.ReactNode[] = [];

  if (gutterWidth > 0 && gutters && contents) {
    for (let i = 0; i < gutters.length; i++) {
      out.push(
        <Box key={`h${hi}-${i}`} flexDirection="row">
          <Box noSelect="from-left-edge">
            <RawAnsi lines={[gutters[i]]} width={gutterWidth} />
          </Box>
          <RawAnsi lines={[contents[i]]} width={width - gutterWidth} />
        </Box>,
      );
    }
  } else if (lines) {
    for (let i = 0; i < lines.length; i++) {
      out.push(
        <RawAnsi key={`h${hi}-${i}`} lines={[lines[i]]} width={width} />,
      );
    }
  }
  return out;
};

// Strategy: bulk nodes (one RawAnsi per hunk) for message stream
const blockEntryRenderer: HunkEntryRenderer = (entry, hi, width) => {
  const { lines, gutterWidth, gutters, contents } = entry;

  if (gutterWidth > 0 && gutters && contents) {
    return [
      <Box key={`blk-${hi}`} flexDirection="row">
        <Box noSelect="from-left-edge">
          <RawAnsi lines={gutters} width={gutterWidth} />
        </Box>
        <RawAnsi lines={contents} width={width - gutterWidth} />
      </Box>,
    ];
  }
  if (lines) {
    return [<RawAnsi key={`blk-${hi}`} lines={lines} width={width} />];
  }
  return [];
};

// ---------------------------------------------------------------------------
// New-file rendering
// ---------------------------------------------------------------------------

function renderNewFile(
  hunks: Hunk[],
  filePath: string,
  colorDiffTheme: string,
  width: number,
  disableColor: boolean,
  bulk: boolean,
): React.ReactNode[] {
  const code = extractAddedContentFromHunks(hunks);
  const rendered = renderNewFileCached(
    code,
    filePath,
    colorDiffTheme,
    width,
    disableColor,
  );
  if (!rendered) return [];

  if (bulk) {
    return [<RawAnsi key="new-file-block" lines={rendered} width={width} />];
  }
  return rendered.map((line, i) => (
    <RawAnsi key={i} lines={[line]} width={width} />
  ));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RenderDiffParams {
  diffContent: string;
  filePath?: string;
  colorDiffTheme: string;
  terminalWidth: number;
  disableColor?: boolean;
  splitGutter?: boolean;
  isNewFile?: boolean;
}

/**
 * Renders diff as per-line ReactNode[] for ScrollableList.
 */
export function renderDiffToLines(params: RenderDiffParams): React.ReactNode[] {
  return renderDiffImpl(params, false);
}

/**
 * Renders diff as block-level ReactNode[] (one RawAnsi per hunk).
 */
export function renderDiffToBlocks(
  params: RenderDiffParams,
): React.ReactNode[] {
  return renderDiffImpl(params, true);
}

function renderDiffImpl(
  {
    diffContent,
    filePath,
    colorDiffTheme,
    terminalWidth,
    disableColor = false,
    splitGutter = false,
    isNewFile,
  }: RenderDiffParams,
  bulk: boolean,
): React.ReactNode[] {
  const hunks = getHunksFromDiffString(diffContent);
  if (hunks.length === 0) return [];

  const resolvedPath = filePath ?? '';

  if (resolveIsNewFile(hunks, diffContent, isNewFile)) {
    return renderNewFile(
      hunks,
      resolvedPath,
      colorDiffTheme,
      terminalWidth,
      disableColor,
      bulk,
    );
  }

  return renderHunksCore(
    hunks,
    extractFirstLine(hunks),
    resolvedPath,
    colorDiffTheme,
    terminalWidth,
    disableColor,
    splitGutter,
    bulk ? blockEntryRenderer : lineEntryRenderer,
  );
}

// ---------------------------------------------------------------------------
// DiffRenderer component
// ---------------------------------------------------------------------------

interface DiffRendererProps {
  diffContent: string;
  filePath?: string;
  terminalWidth: number;
  disableColor?: boolean;
  /** When provided, overrides hunk-based heuristic for new-file detection. */
  isNewFile?: boolean;
}

export const DiffRenderer: React.FC<DiffRendererProps> = ({
  diffContent,
  filePath,
  terminalWidth,
  disableColor = false,
  isNewFile,
}) => {
  const screenReaderEnabled = useIsScreenReaderEnabled();
  const isAlternateBuffer = useAlternateBuffer();

  const colorDiffTheme = getColorDiffThemeName();

  const renderedOutput = useMemo(() => {
    if (!diffContent || typeof diffContent !== 'string') {
      return <Text color={semanticTheme.status.warning}>No diff content.</Text>;
    }

    if (screenReaderEnabled) {
      const parsedLines = parseDiffWithLineNumbers(diffContent);
      return (
        <Box flexDirection="column">
          {parsedLines.map((line, index) => (
            <Text key={index}>
              {line.type}: {line.content}
            </Text>
          ))}
        </Box>
      );
    }

    const renderWidth = Math.max(1, terminalWidth);

    try {
      const blocks = renderDiffToBlocks({
        diffContent,
        filePath,
        colorDiffTheme,
        terminalWidth: renderWidth,
        disableColor,
        splitGutter: isAlternateBuffer,
        isNewFile,
      });

      if (blocks.length === 0) return NO_CHANGES;

      return (
        <Box flexDirection="column" width={renderWidth}>
          {blocks}
        </Box>
      );
    } catch {
      // If diff rendering fails (e.g. corrupted diff from a restored session),
      // fall back to displaying the raw diff text instead of crashing the UI.
      return (
        <Box flexDirection="column" width={renderWidth}>
          <Text color={semanticTheme.status.warning}>
            Failed to render diff. Raw content:
          </Text>
          <Text>{diffContent}</Text>
        </Box>
      );
    }
  }, [
    diffContent,
    screenReaderEnabled,
    isAlternateBuffer,
    colorDiffTheme,
    filePath,
    terminalWidth,
    disableColor,
    isNewFile,
  ]);

  return renderedOutput;
};
