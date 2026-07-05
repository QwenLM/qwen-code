/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Text, Box } from 'ink';
import { theme } from '../semantic-colors.js';
import { colorizeCode } from './CodeColorizer.js';
import { TableRenderer, type ColumnAlign } from './TableRenderer.js';
import { RenderInline } from './InlineMarkdownRenderer.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { MermaidDiagram } from './MermaidDiagram.js';
import { renderInlineLatex } from './latexRenderer.js';
import { useRenderMode } from '../contexts/RenderModeContext.js';
import {
  fitPendingSlice,
  splitMarkdownTableRow,
  TABLE_ROW_RE,
  TABLE_SEPARATOR_RE,
  CODE_FENCE_RE,
} from './pending-rendered-height.js';
// Minimum content lines to keep in a clipped live preview (own constant — not
// coupled to MaxSizedBox's floor).
const MIN_PENDING_CONTENT_LINES = 1;

// Rows reserved from the viewport when clamping a streaming table's height:
// marginY 2 + one row of wrapped-cell safety headroom. Tables under-estimate
// their rendered height the most (a wrapped cell), so they keep one more
// reserved row than the other blocks. Shared by the render-side clamp
// (RenderTable's `maxHeight`) and the slice-side estimate (`tableClampRows`)
// so the two never diverge and let a table overflow the render cap.
const TABLE_PENDING_RESERVED_ROWS = 3;

interface MarkdownDisplayProps {
  text: string;
  isPending: boolean;
  availableTerminalHeight?: number;
  contentWidth: number;
  textColor?: string;
  sourceCopyIndexOffsets?: MarkdownSourceCopyIndexOffsets;
}

export interface MarkdownSourceCopyIndexOffsets {
  codeBlockLanguageCounts: Map<string, number>;
  mathBlockCount: number;
}

export interface MarkdownSourceBlockCounts {
  codeBlockLanguageCounts: Map<string, number>;
  mathBlockCount: number;
}

export function countMarkdownSourceBlocks(
  text: string,
): MarkdownSourceBlockCounts {
  const codeBlockLanguageCounts = new Map<string, number>();
  const lines = text.split(/\r?\n/);
  const codeFenceRegex = CODE_FENCE_RE;
  const mathFenceRegex = /^ *\$\$ *$/;
  let activeCodeFence: string | null = null;
  let inMathBlock = false;
  let mathBlockCount = 0;

  for (const line of lines) {
    const codeFenceMatch = line.match(codeFenceRegex);
    if (activeCodeFence) {
      if (
        codeFenceMatch &&
        codeFenceMatch[1].startsWith(activeCodeFence[0]) &&
        codeFenceMatch[1].length >= activeCodeFence.length
      ) {
        activeCodeFence = null;
      }
      continue;
    }

    if (inMathBlock) {
      if (mathFenceRegex.test(line)) {
        inMathBlock = false;
      }
      continue;
    }

    if (codeFenceMatch) {
      activeCodeFence = codeFenceMatch[1];
      const lang =
        codeFenceMatch[2]?.trim().split(/\s+/)[0]?.toLowerCase() || null;
      if (lang) {
        codeBlockLanguageCounts.set(
          lang,
          (codeBlockLanguageCounts.get(lang) ?? 0) + 1,
        );
      }
      continue;
    }

    if (mathFenceRegex.test(line)) {
      inMathBlock = true;
      mathBlockCount += 1;
    }
  }

  return { codeBlockLanguageCounts, mathBlockCount };
}

// Constants for Markdown parsing and rendering

const EMPTY_LINE_HEIGHT = 1;
const CODE_BLOCK_PREFIX_PADDING = 1;
const LIST_ITEM_PREFIX_PADDING = 1;
const LIST_ITEM_TEXT_FLEX_GROW = 1;
const BLOCKQUOTE_PREFIX_PADDING = 1;
const MATH_BLOCK_PREFIX_PADDING = 1;

const MarkdownDisplayInternal: React.FC<MarkdownDisplayProps> = ({
  text,
  isPending,
  availableTerminalHeight,
  contentWidth,
  textColor = theme.text.primary,
  sourceCopyIndexOffsets,
}) => {
  const { renderMode } = useRenderMode();
  if (!text) return <></>;

  const renderVisualBlocks = renderMode === 'render';
  // Some models stream long runs of trailing newlines after useful content.
  // Trim them from the live preview so blank rows do not push stable streaming
  // text into scrollback on every repaint. The committed transcript still
  // renders the full message via MarkdownDisplay with isPending=false.
  const displayText = isPending ? text.trimEnd() : text;
  const allLines = displayText.split(/\r?\n/);
  // Bound the live (non-`<Static>`) markdown to the viewport budget. A long
  // streaming message otherwise renders ALL its lines, pushing the dynamic
  // frame past the terminal height — at which point ink clears the terminal and
  // re-streams the whole frame from the top on every repaint (the "scroll-to-
  // top lock"). The rendered-height-aware slice below keeps a CONTIGUOUS head of
  // source lines whose RENDERED height fits the budget; a contiguous slice
  // (rather than ink `overflow="hidden"`) avoids decimating interspersed rows
  // and preserves a code block's own truncation. The full message still
  // renders once it commits to `<Static>`. Only while pending and when a budget
  // is known (constrainHeight on — both non-VP and VP pending items pass one).
  //
  // Reserve 2 rows of headroom below the viewport so the live frame stays bound
  // even when a retained code/math block's own rendered height slightly exceeds
  // the source-line estimate.
  //
  // This is a SAFETY NET on top of incremental scrollback commit: it guarantees
  // the live frame never exceeds the viewport regardless of how the streaming
  // layer chunks content, because rendered height ≠ source-line count (a table
  // renders ~2 rows per data row; a wide/CJK line wraps to multiple rows).
  const pendingRenderedBudget =
    isPending && availableTerminalHeight !== undefined
      ? Math.max(MIN_PENDING_CONTENT_LINES, availableTerminalHeight - 2)
      : undefined;
  const headerRegex = /^ *(#{1,4}) +(.*)/;
  const codeFenceRegex = CODE_FENCE_RE;
  const ulItemRegex = /^([ \t]*)([-*+]) +(.*)/;
  const olItemRegex = /^([ \t]*)(\d+)\. +(.*)/;
  const hrRegex = /^ *([-*_] *){3,} *$/;
  const blockquoteRegex = /^ *> ?(.*)$/;
  const mathFenceRegex = /^ *\$\$ *$/;
  // Single source of truth for table detection (shared with pending-rendered-
  // height.ts so the height estimator and the renderer never diverge).
  const tableRowRegex = TABLE_ROW_RE;
  const tableSeparatorRegex = TABLE_SEPARATOR_RE;

  // Rendered-height-aware slice of the pending preview (shared with
  // useGeminiStream's incremental commit — see pending-rendered-height.ts — so the
  // two agree on how tall the content renders). Guarantees the live frame never
  // exceeds the viewport, so ink cannot fall into its from-top full-redraw path
  // (the scroll-to-top lock). Note keptLines can be 0 when even the first
  // line/table alone overflows (e.g. a single very wide/CJK line that wraps past
  // the budget): render nothing rather than an oversized row.
  let lines = allLines;
  if (pendingRenderedBudget !== undefined) {
    const tableClampRows =
      availableTerminalHeight !== undefined
        ? Math.max(2, availableTerminalHeight - TABLE_PENDING_RESERVED_ROWS)
        : Number.MAX_SAFE_INTEGER;
    const { keptLines } = fitPendingSlice(
      allLines,
      contentWidth,
      pendingRenderedBudget,
      tableClampRows,
    );
    if (keptLines < allLines.length) {
      lines = allLines.slice(0, keptLines);
    }
  }

  // Hold back a still-forming table at the streaming frontier. A table is only
  // recognized once its separator line (matching the header's column count) has
  // arrived; until then the header — and any partial separator — would render as
  // raw `| a | b |` text and stream in character by character before snapping
  // into a table box. So while pending, trim a trailing run of pipe-lines that
  // does not yet contain a matching separator: nothing renders for it until it
  // can render as a table. (A run that IS a recognizable table is kept — the
  // per-row hold-back below then handles its unterminated frontier row.)
  if (isPending && renderVisualBlocks && lines.length > 0) {
    let start = lines.length;
    while (start > 0 && /^\s*\|/.test(lines[start - 1]!)) start--;
    if (start < lines.length) {
      // Don't touch pipe-lines that are actually fenced code-block content.
      let insideCodeFence = false;
      for (let i = 0; i < start; i++) {
        if (codeFenceRegex.test(lines[i]!)) insideCodeFence = !insideCodeFence;
      }
      // Only hold back a plausible forming TABLE, not arbitrary pipe text. A
      // table header has ≥2 columns; a single-pipe line (an un-fenced shell
      // pipeline `| grep foo`, a pipe-prefixed log line) has one cell and must
      // render. Count cells on the first line whether or not it is closed yet,
      // so a multi-column header held mid-type does not flash in cell by cell
      // before its separator arrives. (A header still typing its very first
      // cell — one cell so far — is indistinguishable from a single-pipe line,
      // so it renders briefly until the second column appears; that is the
      // narrowest flash we can allow without hiding real non-table text.)
      const headerCells = insideCodeFence
        ? 0
        : splitMarkdownTableRow(lines[start]!).filter((c) => c.length > 0)
            .length;
      if (headerCells >= 2) {
        const hasMatchingSeparator = lines.slice(start + 1).some((l) => {
          if (!tableSeparatorRegex.test(l)) return false;
          const cols = splitMarkdownTableRow(l).filter(
            (c) => c.length > 0,
          ).length;
          return cols === headerCells;
        });
        if (!hasMatchingSeparator) {
          lines = lines.slice(0, start);
        }
      }
    }
  }

  /** Parse column alignments from a markdown table separator like `|:---|:---:|---:|` */
  const parseTableAligns = (line: string): ColumnAlign[] =>
    splitMarkdownTableRow(line)
      .filter((cell) => cell.length > 0)
      .map((cell) => {
        const startsWithColon = cell.startsWith(':');
        const endsWithColon = cell.endsWith(':');
        if (startsWithColon && endsWithColon) return 'center';
        if (endsWithColon) return 'right';
        return 'left';
      });

  const contentBlocks: React.ReactNode[] = [];
  let inCodeBlock = false;
  let codeBlockIndex = 0;
  let currentCodeBlockIndex = 0;
  let currentCodeBlockLangIndex = 0;
  const codeBlockLanguageCounts = new Map<string, number>(
    sourceCopyIndexOffsets?.codeBlockLanguageCounts,
  );
  let lastLineEmpty = true;
  let codeBlockContent: string[] = [];
  let codeBlockLang: string | null = null;
  let codeBlockFence = '';
  let inMathBlock = false;
  let mathBlockIndex = sourceCopyIndexOffsets?.mathBlockCount ?? 0;
  let currentMathBlockIndex = 0;
  let mathBlockContent: string[] = [];
  let inTable = false;
  let tableRows: string[][] = [];
  let tableHeaders: string[] = [];
  let tableAligns: ColumnAlign[] = [];

  function addContentBlock(block: React.ReactNode) {
    if (block) {
      contentBlocks.push(block);
      lastLineEmpty = false;
    }
  }

  lines.forEach((line, index) => {
    const key = `line-${index}`;

    if (inCodeBlock) {
      const fenceMatch = line.match(codeFenceRegex);
      if (
        fenceMatch &&
        fenceMatch[1].startsWith(codeBlockFence[0]) &&
        fenceMatch[1].length >= codeBlockFence.length
      ) {
        addContentBlock(
          <RenderCodeBlock
            key={key}
            content={codeBlockContent}
            lang={codeBlockLang}
            codeBlockIndex={currentCodeBlockIndex}
            codeBlockLangIndex={currentCodeBlockLangIndex}
            isPending={isPending}
            availableTerminalHeight={availableTerminalHeight}
            contentWidth={contentWidth}
          />,
        );
        inCodeBlock = false;
        currentCodeBlockIndex = 0;
        currentCodeBlockLangIndex = 0;
        codeBlockContent = [];
        codeBlockLang = null;
        codeBlockFence = '';
      } else {
        codeBlockContent.push(line);
      }
      return;
    }

    if (inMathBlock) {
      if (mathFenceRegex.test(line)) {
        addContentBlock(
          <RenderMathBlock
            key={key}
            content={mathBlockContent}
            sourceCopyCommand={`/copy latex ${currentMathBlockIndex}`}
            contentWidth={contentWidth}
            isPending={isPending}
            availableTerminalHeight={availableTerminalHeight}
          />,
        );
        inMathBlock = false;
        currentMathBlockIndex = 0;
        mathBlockContent = [];
      } else {
        mathBlockContent.push(line);
      }
      return;
    }

    const codeFenceMatch = line.match(codeFenceRegex);
    const mathFenceMatch = line.match(mathFenceRegex);
    const headerMatch = line.match(headerRegex);
    const ulMatch = line.match(ulItemRegex);
    const olMatch = line.match(olItemRegex);
    const hrMatch = line.match(hrRegex);
    const blockquoteMatch = line.match(blockquoteRegex);
    const tableRowMatch = line.match(tableRowRegex);
    const tableSeparatorMatch = line.match(tableSeparatorRegex);

    if (codeFenceMatch) {
      inCodeBlock = true;
      codeBlockIndex += 1;
      currentCodeBlockIndex = codeBlockIndex;
      codeBlockFence = codeFenceMatch[1];
      codeBlockLang = codeFenceMatch[2]?.trim().split(/\s+/)[0] || null;
      if (codeBlockLang) {
        const normalizedLang = codeBlockLang.toLowerCase();
        const nextLangIndex =
          (codeBlockLanguageCounts.get(normalizedLang) ?? 0) + 1;
        codeBlockLanguageCounts.set(normalizedLang, nextLangIndex);
        currentCodeBlockLangIndex = nextLangIndex;
      } else {
        currentCodeBlockLangIndex = 0;
      }
    } else if (mathFenceMatch && renderVisualBlocks) {
      inMathBlock = true;
      mathBlockIndex += 1;
      currentMathBlockIndex = mathBlockIndex;
      mathBlockContent = [];
    } else if (tableRowMatch && !inTable && renderVisualBlocks) {
      // Potential table start - check if next line is separator with matching column count
      const potentialHeaders = splitMarkdownTableRow(tableRowMatch[1]);
      const nextLine = index + 1 < lines.length ? lines[index + 1]! : '';
      const sepMatch = nextLine.match(tableSeparatorRegex);
      const sepColCount = sepMatch
        ? splitMarkdownTableRow(nextLine).filter((c) => c.length > 0).length
        : 0;

      if (sepMatch && sepColCount === potentialHeaders.length) {
        inTable = true;
        tableHeaders = potentialHeaders;
        tableRows = [];
      } else {
        // Not a table, treat as regular text
        addContentBlock(
          <Box key={key}>
            <Text wrap="wrap">
              <RenderInline
                text={line}
                textColor={textColor}
                enableInlineMath={renderVisualBlocks}
              />
            </Text>
          </Box>,
        );
      }
    } else if (inTable && tableSeparatorMatch) {
      // Parse alignment from separator line
      tableAligns = parseTableAligns(line);
    } else if (
      isPending &&
      inTable &&
      index === lines.length - 1 &&
      tableHeaders.length > 0 &&
      /^\s*\|/.test(line) &&
      (!tableRowMatch ||
        splitMarkdownTableRow(tableRowMatch[1]).length < tableHeaders.length)
    ) {
      // Live streaming frontier: the final line is a row still being typed —
      // either mid-cell (`| a | b` with no closing `|` yet) or closed but with
      // fewer cells than the header (`| a |` while `| a | b | c |` is coming, an
      // intermediate that itself matches the row regex). Both would otherwise
      // render as a padded row that fills in cell by cell and flips as the
      // closing `|`/columns arrive, jittering the frame. Hold the row back until
      // it has all its columns: skip it so `inTable` stays set and the
      // end-of-content handler renders only the COMPLETE rows as a live table.
      // The whole row (border + all cells) then appears in one step. Guarded on
      // `tableHeaders.length > 0` so the header + separator never blank out with
      // a stray partial line beneath them while the first row is typed.
    } else if (inTable && tableRowMatch) {
      // Add table row
      const cells = splitMarkdownTableRow(tableRowMatch[1]);
      // Ensure row has same column count as headers
      while (cells.length < tableHeaders.length) {
        cells.push('');
      }
      if (cells.length > tableHeaders.length) {
        cells.length = tableHeaders.length;
      }
      tableRows.push(cells);
    } else if (inTable && !tableRowMatch) {
      // End of table — a following line closes it, so this table is COMPLETE
      // and renders in full (the rendered-aware slice guarantees a completed
      // table that would overflow was cut before it; `maxHeight` clamps the
      // residual wrapped-cell case).
      if (tableHeaders.length > 0 && tableRows.length > 0) {
        addContentBlock(
          <RenderTable
            key={`table-${contentBlocks.length}`}
            headers={tableHeaders}
            rows={tableRows}
            contentWidth={contentWidth}
            aligns={tableAligns}
            enableInlineMath={renderVisualBlocks}
            isPending={isPending}
            availableTerminalHeight={availableTerminalHeight}
          />,
        );
      }
      inTable = false;
      tableRows = [];
      tableHeaders = [];
      tableAligns = [];

      // Process current line as normal
      if (line.trim().length > 0) {
        addContentBlock(
          <Box key={key}>
            <Text wrap="wrap">
              <RenderInline
                text={line}
                textColor={textColor}
                enableInlineMath={renderVisualBlocks}
              />
            </Text>
          </Box>,
        );
      }
    } else if (hrMatch) {
      addContentBlock(
        <Box key={key}>
          <Text dimColor>---</Text>
        </Box>,
      );
    } else if (blockquoteMatch && renderVisualBlocks) {
      addContentBlock(
        <RenderBlockquote
          key={key}
          quoteText={blockquoteMatch[1]}
          textColor={textColor}
          enableInlineMath={renderVisualBlocks}
        />,
      );
    } else if (headerMatch) {
      const level = headerMatch[1].length;
      const headerText = headerMatch[2];
      let headerNode: React.ReactNode = null;
      switch (level) {
        case 1:
          headerNode = (
            <Text bold color={textColor}>
              <RenderInline
                text={headerText}
                textColor={textColor}
                enableInlineMath={renderVisualBlocks}
              />
            </Text>
          );
          break;
        case 2:
          headerNode = (
            <Text bold color={textColor}>
              <RenderInline
                text={headerText}
                textColor={textColor}
                enableInlineMath={renderVisualBlocks}
              />
            </Text>
          );
          break;
        case 3:
          headerNode = (
            <Text bold color={textColor}>
              <RenderInline
                text={headerText}
                textColor={textColor}
                enableInlineMath={renderVisualBlocks}
              />
            </Text>
          );
          break;
        case 4:
          headerNode = (
            <Text italic color={textColor}>
              <RenderInline
                text={headerText}
                textColor={textColor}
                enableInlineMath={renderVisualBlocks}
              />
            </Text>
          );
          break;
        default:
          headerNode = (
            <Text color={textColor}>
              <RenderInline
                text={headerText}
                textColor={textColor}
                enableInlineMath={renderVisualBlocks}
              />
            </Text>
          );
          break;
      }
      if (headerNode) addContentBlock(<Box key={key}>{headerNode}</Box>);
    } else if (ulMatch) {
      const leadingWhitespace = ulMatch[1];
      const marker = ulMatch[2];
      const itemText = ulMatch[3];
      addContentBlock(
        <RenderListItem
          key={key}
          itemText={itemText}
          type="ul"
          marker={marker}
          leadingWhitespace={leadingWhitespace}
          textColor={textColor}
          renderVisualBlocks={renderVisualBlocks}
        />,
      );
    } else if (olMatch) {
      const leadingWhitespace = olMatch[1];
      const marker = olMatch[2];
      const itemText = olMatch[3];
      addContentBlock(
        <RenderListItem
          key={key}
          itemText={itemText}
          type="ol"
          marker={marker}
          leadingWhitespace={leadingWhitespace}
          textColor={textColor}
          renderVisualBlocks={renderVisualBlocks}
        />,
      );
    } else {
      if (line.trim().length === 0 && !inCodeBlock) {
        if (!lastLineEmpty) {
          contentBlocks.push(
            <Box key={`spacer-${index}`} height={EMPTY_LINE_HEIGHT} />,
          );
          lastLineEmpty = true;
        }
      } else {
        addContentBlock(
          <Box key={key}>
            <Text wrap="wrap" color={textColor}>
              <RenderInline
                text={line}
                textColor={textColor}
                enableInlineMath={renderVisualBlocks}
              />
            </Text>
          </Box>,
        );
      }
    }
  });

  if (inCodeBlock) {
    addContentBlock(
      <RenderCodeBlock
        key="line-eof"
        content={codeBlockContent}
        lang={codeBlockLang}
        codeBlockIndex={currentCodeBlockIndex}
        codeBlockLangIndex={currentCodeBlockLangIndex}
        isPending={isPending}
        availableTerminalHeight={availableTerminalHeight}
        contentWidth={contentWidth}
      />,
    );
  }

  if (inMathBlock) {
    addContentBlock(
      <RenderMathBlock
        key="math-eof"
        content={mathBlockContent}
        sourceCopyCommand={`/copy latex ${currentMathBlockIndex}`}
        contentWidth={contentWidth}
        isPending={isPending}
        availableTerminalHeight={availableTerminalHeight}
      />,
    );
  }

  // Handle table at end of content — the table still being written. Draw it live
  // (growing each tick); the `maxHeight` clamp caps it at the viewport and the
  // slice above keeps preceding content within budget, so it can never overflow
  // and lock the terminal. Renders in full once the message commits to <Static>
  // (isPending=false → no clamp).
  //
  // No `tableRows.length > 0` guard: once the header + separator are recognized
  // draw the empty table box right away (its data rows fill in as they complete
  // via the per-row hold-back). Otherwise the whole table area stays blank from
  // the moment it is recognized until the first row terminates — if generation
  // stalls in that window it looks like a hang (no box, no cue). The header does
  // NOT flash char by char: the pre-loop trim holds it until the separator lands,
  // so the box appears atomically. Committed (isPending=false) tables always have
  // rows, so this only affects the live frontier.
  if (inTable && tableHeaders.length > 0) {
    addContentBlock(
      <RenderTable
        key={`table-${contentBlocks.length}`}
        headers={tableHeaders}
        rows={tableRows}
        contentWidth={contentWidth}
        aligns={tableAligns}
        enableInlineMath={renderVisualBlocks}
        isPending={isPending}
        isStreamingFrontier={true}
        availableTerminalHeight={availableTerminalHeight}
      />,
    );
  }

  // Safety-net clip: when the pending preview exceeds the rendered-height
  // budget, slice it to keep the live frame within the viewport. The clipping
  // still happens (prevents scroll-to-top lock), but we no longer show the
  // "... generating more ..." cue — incremental scrollback commit (PR #6170)
  // already streams content to <Static> in real-time, so clipped content is
  // not "delayed output" but rather "still streaming".
  return <>{contentBlocks}</>;
};

// Helper functions (adapted from static methods of MarkdownRenderer)

interface RenderCodeBlockProps {
  content: string[];
  lang: string | null;
  codeBlockIndex: number;
  codeBlockLangIndex: number;
  isPending: boolean;
  availableTerminalHeight?: number;
  contentWidth: number;
}

const RenderCodeBlockInternal: React.FC<RenderCodeBlockProps> = ({
  content,
  lang,
  codeBlockIndex,
  codeBlockLangIndex,
  isPending,
  availableTerminalHeight,
  contentWidth,
}) => {
  const settings = useSettings();
  const { renderMode } = useRenderMode();
  // Below this many usable rows there is no room for a meaningful code
  // preview, so we fall back to the "... code is being written ..." notice.
  const MIN_PREVIEW_LINES = 1;
  // One row of headroom below availableTerminalHeight. This used to also hold a
  // "... generating more ..." cue (removed with PR #6170's incremental commit),
  // so the reclaimed row now shows an extra code line at the same total height.
  const RESERVED_LINES = 1;

  if (lang?.toLowerCase() === 'mermaid' && renderMode === 'render') {
    if (isPending) {
      return (
        <RenderPendingMermaidBlock
          content={content}
          availableTerminalHeight={availableTerminalHeight}
          contentWidth={contentWidth}
        />
      );
    }

    return (
      <MermaidDiagram
        source={content.join('\n')}
        sourceCopyCommand={`/copy mermaid ${codeBlockLangIndex || codeBlockIndex}`}
        isPending={isPending}
        availableTerminalHeight={availableTerminalHeight}
        contentWidth={contentWidth}
      />
    );
  }

  const fullContent = content.join('\n');

  if (isPending && availableTerminalHeight !== undefined) {
    const MAX_CODE_LINES_WHEN_PENDING = Math.max(
      0,
      availableTerminalHeight - RESERVED_LINES,
    );

    if (content.length > MAX_CODE_LINES_WHEN_PENDING) {
      if (MAX_CODE_LINES_WHEN_PENDING < MIN_PREVIEW_LINES) {
        // Not enough space to even show a truncated preview meaningfully
        return (
          <Box paddingLeft={CODE_BLOCK_PREFIX_PADDING}>
            <Text color={theme.text.secondary}>
              ... code is being written ...
            </Text>
          </Box>
        );
      }
      const truncatedContent = content.slice(0, MAX_CODE_LINES_WHEN_PENDING);
      const colorizedTruncatedCode = colorizeCode(
        truncatedContent.join('\n'),
        lang,
        availableTerminalHeight,
        contentWidth - CODE_BLOCK_PREFIX_PADDING,
        undefined,
        settings,
      );
      return (
        <Box paddingLeft={CODE_BLOCK_PREFIX_PADDING} flexDirection="column">
          {colorizedTruncatedCode}
        </Box>
      );
    }
  }

  const colorizedCode = colorizeCode(
    fullContent,
    lang,
    availableTerminalHeight,
    contentWidth - CODE_BLOCK_PREFIX_PADDING,
    undefined,
    settings,
  );

  return (
    <Box
      paddingLeft={CODE_BLOCK_PREFIX_PADDING}
      flexDirection="column"
      width={contentWidth}
      flexShrink={0}
    >
      {colorizedCode}
    </Box>
  );
};

const RenderCodeBlock = React.memo(RenderCodeBlockInternal);

interface RenderPendingMermaidBlockProps {
  content: string[];
  availableTerminalHeight?: number;
  contentWidth: number;
}

const RenderPendingMermaidBlockInternal: React.FC<
  RenderPendingMermaidBlockProps
> = ({ content, availableTerminalHeight, contentWidth }) => {
  // Reserve one row for the "Mermaid diagram is being written..." header. The
  // second reserved row used to hold a "... generating more ..." cue (removed
  // with PR #6170); reclaiming it shows an extra preview line at the same height.
  const maxPreviewLines =
    availableTerminalHeight === undefined
      ? 6
      : Math.max(0, availableTerminalHeight - 1);
  const previewLines = content.slice(0, maxPreviewLines);
  return (
    <Box
      paddingLeft={CODE_BLOCK_PREFIX_PADDING}
      flexDirection="column"
      width={contentWidth}
      flexShrink={0}
    >
      <Text color={theme.text.accent}>Mermaid diagram is being written...</Text>
      {previewLines.map((line, index) => (
        <Text key={index} color={theme.text.secondary} wrap="truncate-end">
          {line || ' '}
        </Text>
      ))}
    </Box>
  );
};

const RenderPendingMermaidBlock = React.memo(RenderPendingMermaidBlockInternal);

interface RenderMathBlockProps {
  content: string[];
  sourceCopyCommand: string;
  contentWidth: number;
  isPending: boolean;
  availableTerminalHeight?: number;
}

const RenderMathBlockInternal: React.FC<RenderMathBlockProps> = ({
  content,
  sourceCopyCommand,
  contentWidth,
  isPending,
  availableTerminalHeight,
}) => {
  // One row for the "LaTeX block · source:" header plus one row of headroom.
  // The third row used to hold a "... generating more ..." cue (removed with PR
  // #6170); reclaiming it shows an extra preview line at the same total height.
  const RESERVED_LINES = 2;
  if (isPending && availableTerminalHeight !== undefined) {
    const maxPreviewLines = Math.max(
      0,
      availableTerminalHeight - RESERVED_LINES,
    );
    if (content.length > maxPreviewLines) {
      const previewLines = content.slice(0, maxPreviewLines);
      return (
        <Box
          paddingLeft={MATH_BLOCK_PREFIX_PADDING}
          flexDirection="column"
          width={contentWidth}
          flexShrink={0}
        >
          <Text bold color={theme.text.accent}>
            LaTeX block · source: {sourceCopyCommand}
          </Text>
          {previewLines.map((line, index) => (
            <Text key={index} color={theme.text.secondary} wrap="truncate-end">
              {line || ' '}
            </Text>
          ))}
        </Box>
      );
    }
  }

  const rendered = renderInlineLatex(content.join(' '));
  return (
    <Box
      paddingLeft={MATH_BLOCK_PREFIX_PADDING}
      flexDirection="column"
      width={contentWidth}
      flexShrink={0}
    >
      <Text bold color={theme.text.accent}>
        LaTeX block · source: {sourceCopyCommand}
      </Text>
      <Text color={theme.text.accent} wrap="wrap">
        {rendered}
      </Text>
    </Box>
  );
};

const RenderMathBlock = React.memo(RenderMathBlockInternal);

interface RenderBlockquoteProps {
  quoteText: string;
  textColor?: string;
  enableInlineMath?: boolean;
}

const RenderBlockquoteInternal: React.FC<RenderBlockquoteProps> = ({
  quoteText,
  textColor = theme.text.primary,
  enableInlineMath = true,
}) => (
  <Box paddingLeft={BLOCKQUOTE_PREFIX_PADDING} flexDirection="row">
    <Text color={theme.text.secondary}>│ </Text>
    <Box flexGrow={LIST_ITEM_TEXT_FLEX_GROW}>
      <Text wrap="wrap" color={textColor} italic>
        <RenderInline
          text={quoteText}
          textColor={textColor}
          enableInlineMath={enableInlineMath}
        />
      </Text>
    </Box>
  </Box>
);

const RenderBlockquote = React.memo(RenderBlockquoteInternal);

interface RenderListItemProps {
  itemText: string;
  type: 'ul' | 'ol';
  marker: string;
  leadingWhitespace?: string;
  textColor?: string;
  renderVisualBlocks?: boolean;
}

const RenderListItemInternal: React.FC<RenderListItemProps> = ({
  itemText,
  type,
  marker,
  leadingWhitespace = '',
  textColor = theme.text.primary,
  renderVisualBlocks = true,
}) => {
  const taskMatch = itemText.match(/^\[([ xX])\]\s+(.*)$/);
  const isTaskItem = taskMatch !== null && renderVisualBlocks;
  const isTaskChecked = taskMatch?.[1]?.toLowerCase() === 'x';
  const effectiveItemText = isTaskItem ? taskMatch[2] : itemText;
  const prefix = isTaskItem
    ? `${isTaskChecked ? '✓' : '○'} `
    : type === 'ol'
      ? `${marker}. `
      : `${marker} `;
  const prefixWidth = prefix.length;
  const indentation = leadingWhitespace.length;

  return (
    <Box
      paddingLeft={indentation + LIST_ITEM_PREFIX_PADDING}
      flexDirection="row"
    >
      <Box width={prefixWidth}>
        <Text color={textColor}>{prefix}</Text>
      </Box>
      <Box flexGrow={LIST_ITEM_TEXT_FLEX_GROW}>
        <Text wrap="wrap" color={textColor}>
          <RenderInline
            text={effectiveItemText}
            textColor={textColor}
            enableInlineMath={renderVisualBlocks}
          />
        </Text>
      </Box>
    </Box>
  );
};

const RenderListItem = React.memo(RenderListItemInternal);

interface RenderTableProps {
  headers: string[];
  rows: string[][];
  contentWidth: number;
  aligns?: ColumnAlign[];
  enableInlineMath?: boolean;
  isPending?: boolean;
  /**
   * True only for the table at the live streaming frontier — the one still
   * being written at the end of a pending message. A table closed earlier in
   * the same (still pending) message is already COMPLETE, so it must size its
   * columns from every row immediately (isStreaming false) instead of staying
   * frozen to the first row until the whole message finishes.
   */
  isStreamingFrontier?: boolean;
  availableTerminalHeight?: number;
}

const RenderTableInternal: React.FC<RenderTableProps> = ({
  headers,
  rows,
  contentWidth,
  aligns,
  enableInlineMath = false,
  isPending = false,
  isStreamingFrontier = false,
  availableTerminalHeight,
}) => {
  const maxHeight =
    isPending && availableTerminalHeight !== undefined
      ? Math.max(2, availableTerminalHeight - TABLE_PENDING_RESERVED_ROWS)
      : undefined;
  return (
    <TableRenderer
      headers={headers}
      rows={rows}
      contentWidth={contentWidth}
      aligns={aligns}
      enableInlineMath={enableInlineMath}
      maxHeight={maxHeight}
      isStreaming={isPending && isStreamingFrontier}
    />
  );
};

const RenderTable = React.memo(RenderTableInternal);

export const MarkdownDisplay = React.memo(MarkdownDisplayInternal);
