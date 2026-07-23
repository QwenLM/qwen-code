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
import { parseCodeFenceInfo } from './markdownUtilities.js';
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
  /**
   * When true, enforce the rendered-height budget from `availableTerminalHeight`
   * even for non-pending content. Normally the height-aware pre-slice
   * (`fitPendingSlice`) only engages while streaming (`isPending`), because
   * committed content is rendered by `<Static>` and does not risk the
   * scroll-to-top lock. However, MainContent wraps the live pending region in
   * `maxHeight` + `overflow="hidden"` as an Ink backstop, and Ink clips the
   * BOTTOM (newest content) — so a non-pending item that renders inside that
   * wrapper (e.g. the `exit_plan_mode` confirmation dialog's plan body) gets
   * silently clipped without the pre-slice's clamp/indicator. Callers that
   * render inside such a bounded container should pass `true` so the plan body
   * respects the same viewport budget the outer wrapper enforces. See #6867.
   */
  enforceHeightBudget?: boolean;
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
      const lang = parseCodeFenceInfo(codeFenceMatch[2]).lang?.toLowerCase();
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
  enforceHeightBudget = false,
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
  //
  // Non-pending callers that render inside a bounded parent (e.g. the
  // `exit_plan_mode` confirmation dialog inside MainContent's `maxHeight` +
  // `overflow="hidden"` wrapper) can opt in via `enforceHeightBudget` so their
  // content is pre-sliced the same way, avoiding silent bottom-clipping.
  const pendingRenderedBudget =
    (isPending || enforceHeightBudget) && availableTerminalHeight !== undefined
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
  // Track how many source lines were dropped by the pre-slice so a non-streaming
  // caller (e.g. the `exit_plan_mode` confirmation dialog) can render a visible
  // "N more lines" cue. For streaming content the cue is intentionally omitted:
  // the rest is still on its way. But when the caller opts into the budget for
  // a COMPLETE plan (`enforceHeightBudget && !isPending`), silently dropping the
  // tail means the user is asked to approve a plan whose remainder never
  // appears — a model could hide steps past the budget. See #6867.
  let droppedSourceLines = 0;
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
      droppedSourceLines = allLines.length - keptLines;
    }
  }
  const showTruncationCue =
    enforceHeightBudget && !isPending && droppedSourceLines > 0;

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
      // Don't touch pipe-lines that are actually fenced code-block OR display-math
      // (`$$ … $$`) content: the main parser pushes those verbatim, never as a
      // table (a `| a | b |` norm/matrix line inside `$$` would otherwise be held
      // back as a forming table and blank until the block closes). Track the OPEN
      // code fence's delimiter, not a naive toggle: a closing fence must use the
      // same char and be at least as long (mirrors the main parser), or a nested
      // fence (```` inside ```` ) mis-toggles and a real code line like `| A | B |`
      // gets held back. Mirror the main parser's precedence — a code block wins,
      // then a math block — so a `$$` inside a code fence does not open math.
      let activeCodeFence = '';
      let insideMathBlock = false;
      for (let i = 0; i < start; i++) {
        const line = lines[i]!;
        if (activeCodeFence) {
          const fenceMatch = line.match(codeFenceRegex);
          if (
            fenceMatch &&
            fenceMatch[1]!.startsWith(activeCodeFence[0]!) &&
            fenceMatch[1]!.length >= activeCodeFence.length
          ) {
            activeCodeFence = '';
          }
          continue;
        }
        if (insideMathBlock) {
          if (mathFenceRegex.test(line)) insideMathBlock = false;
          continue;
        }
        const fenceMatch = line.match(codeFenceRegex);
        if (fenceMatch) {
          activeCodeFence = fenceMatch[1]!;
        } else if (mathFenceRegex.test(line)) {
          insideMathBlock = true;
        }
      }
      const insideCodeFence = activeCodeFence !== '';
      // Only hold back a plausible forming TABLE, not arbitrary pipe text. A
      // table header has ≥2 columns; a single-pipe line (an un-fenced shell
      // pipeline `| grep foo`, a pipe-prefixed log line) has one cell and must
      // render. Count cells on the first line whether or not it is closed yet,
      // so a multi-column header held mid-type does not flash in cell by cell
      // before its separator arrives. (A header still typing its very first
      // cell — one cell so far — is indistinguishable from a single-pipe line,
      // so it renders briefly until the second column appears; that is the
      // narrowest flash we can allow without hiding real non-table text.)
      // Count header cells the way the main table detector does (strip the
      // outer pipes, split WITHOUT dropping empty cells) so an empty-named
      // column like `| A || B |` — which the renderer treats as a real table —
      // agrees between this hold-back and the renderer, instead of being held
      // back for the whole stream. The trailing pipe is stripped only when
      // present, so a still-forming header (`| A | B`) is counted mid-type.
      let headerCells = 0;
      if (!insideCodeFence && !insideMathBlock) {
        let hdr = lines[start]!.replace(/^\s*\|/, '');
        if (/\|\s*$/.test(hdr)) hdr = hdr.replace(/\|\s*$/, '');
        headerCells = splitMarkdownTableRow(hdr).length;
      }
      if (headerCells >= 2) {
        const rest = lines.slice(start + 1);
        const hasMatchingSeparator = rest.some((l) => {
          if (!tableSeparatorRegex.test(l)) return false;
          const cols = splitMarkdownTableRow(l).filter(
            (c) => c.length > 0,
          ).length;
          return cols === headerCells;
        });
        // A markdown table's separator is the line IMMEDIATELY after the header.
        // So once a line follows the header and it is not a (possibly still
        // forming) separator row, this pipe run is decided: NOT a forming table —
        // a multi-cell shell pipeline (`| grep foo | wc -l`), a log excerpt
        // (`| 200 | OK | GET /x`), an options table whose first cell starts with
        // a dash (`| --verbose | … |`), or an ASCII-art border. Release it rather
        // than hiding it for the whole stream. `tableSeparatorRegex` matches a
        // partial separator (`|--`) so a real header whose separator is still
        // being typed stays held; it rejects a dash-led data cell like
        // `--verbose` (trailing letters), which a looser "starts with a dash"
        // test would wrongly hold. While only the header exists (no line after it
        // yet) keep holding so a multi-column header does not flash in cell by
        // cell before its separator arrives.
        const lineAfterHeader = rest[0];
        const separatorIsTrailing = rest.length === 1;
        // The separator's first characters may arrive as a bare `|` or `| ` with
        // no dash yet — not matched by tableSeparatorRegex, but a valid separator
        // PREFIX. While it is the trailing line (still being typed) and contains
        // only separator characters, treat it as a still-forming separator so the
        // header does not flash raw for the frame between the header's newline and
        // the separator's first dash.
        const looksLikeSeparatorPrefix =
          lineAfterHeader !== undefined &&
          lineAfterHeader.includes('|') &&
          /^[\s|:-]*$/.test(lineAfterHeader);
        let couldStillBeTable =
          lineAfterHeader === undefined ||
          tableSeparatorRegex.test(lineAfterHeader) ||
          (separatorIsTrailing && looksLikeSeparatorPrefix);
        // A COMPLETE separator whose column count already differs from the header
        // will never become a valid table — the main parser treats it as plain
        // text — so release it instead of holding the run for the rest of the
        // stream. The catch: a separator is typed one group at a time and, BETWEEN
        // groups, momentarily ends with `|` at an intermediate count
        // (`| --- | --- |` on the way to seven columns). "Ends with `|`" alone
        // therefore does NOT mean "complete" while it is still streaming. A
        // streaming separator only ever GAINS columns, so treat it as a final
        // mismatch only when it can no longer become valid: it OVERSHOT the
        // header's column count, or a further line has already committed it (it is
        // not the trailing line, so it will not grow). While it is the trailing
        // line and still short of the header, keep holding — releasing there makes
        // the header flash as raw `| … |` text on every closed-group frame.
        if (
          couldStillBeTable &&
          lineAfterHeader !== undefined &&
          /\|\s*$/.test(lineAfterHeader)
        ) {
          const sepCols = splitMarkdownTableRow(lineAfterHeader).filter(
            (c) => c.length > 0,
          ).length;
          if (
            sepCols !== headerCells &&
            (sepCols > headerCells || !separatorIsTrailing)
          ) {
            couldStillBeTable = false;
          }
        }
        if (!hasMatchingSeparator && couldStillBeTable) {
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
  // Gutter start line for the current block: >1 when it continues a block that
  // streaming split across commits (see splitFencedMarkdown).
  let currentCodeBlockStartLine = 1;
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
            startLineNumber={currentCodeBlockStartLine}
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
      const fenceInfo = parseCodeFenceInfo(codeFenceMatch[2]);
      codeBlockLang = fenceInfo.lang;
      currentCodeBlockStartLine = fenceInfo.startLine;
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
            // A following non-table line closed this table: it is COMPLETE and
            // will gain no more rows, so it is not the streaming frontier. Decide
            // its format from all rows (not just the first) so it does not flip
            // horizontal→vertical when the message finally commits.
            isFrontier={false}
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
        startLineNumber={currentCodeBlockStartLine}
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
  // While PENDING, defer a table that has no COMPLETE data row yet. A zero-row
  // table can only render horizontally (the vertical fallback needs rows to lay
  // out), so drawing the empty header box and then flipping to the vertical
  // `label: value` format once a long first row lands is a visible format change
  // — and the format genuinely cannot be known from the header alone (column
  // names are short; the width comes from the values). Waiting for the first
  // complete row means the table first appears ALREADY in its final format, with
  // no flip. Cost: the table area stays blank while the header + first row stream
  // (the pre-loop trim already hid the header text, so this just extends that
  // blank until the first row terminates). The `tableRows.length > 0` guard also
  // matches the mid-content end-of-table handler above, so a degenerate zero-row
  // table renders (or not) the same whether it ends the message or is followed by
  // more text — pending or committed.
  if (inTable && tableHeaders.length > 0 && tableRows.length > 0) {
    addContentBlock(
      <RenderTable
        key={`table-${contentBlocks.length}`}
        headers={tableHeaders}
        rows={tableRows}
        contentWidth={contentWidth}
        aligns={tableAligns}
        enableInlineMath={renderVisualBlocks}
        isPending={isPending}
        // End of content: this table is at the streaming frontier and may still
        // gain rows, so anchor its format to the first row while pending.
        isFrontier={true}
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
  //
  // For non-streaming callers that opted in via `enforceHeightBudget` (currently
  // the `exit_plan_mode` confirmation dialog), the tail is NOT still on its way
  // — the rest of the plan simply won't render. Show a dim, single-line cue so
  // the approver knows content was cut and cannot be tricked into approving a
  // plan whose dangerous steps sit past the budget. See #6867.
  if (showTruncationCue) {
    contentBlocks.push(
      <Text
        key={`truncation-cue-${contentBlocks.length}`}
        color={theme.text.secondary}
        wrap="truncate-end"
      >
        {`... ${droppedSourceLines} more line${droppedSourceLines === 1 ? '' : 's'} not shown (viewport too small) ...`}
      </Text>,
    );
  }
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
  /** Gutter number for the first line; >1 when the block continues a block
   * that streaming split across commits (see splitFencedMarkdown). */
  startLineNumber?: number;
}

const RenderCodeBlockInternal: React.FC<RenderCodeBlockProps> = ({
  content,
  lang,
  codeBlockIndex,
  codeBlockLangIndex,
  isPending,
  availableTerminalHeight,
  contentWidth,
  startLineNumber = 1,
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
        { settings, startLineNumber },
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
    { settings, startLineNumber },
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
  /** True while the whole message is still streaming — drives the height clamp. */
  isPending?: boolean;
  /**
   * True only for the table at the streaming frontier (end of content, may still
   * gain rows). A completed mid-content table passes false so its format is
   * decided from all rows and does not flip when the message commits. Defaults
   * true so a bare RenderTable behaves like the frontier.
   */
  isFrontier?: boolean;
  availableTerminalHeight?: number;
}

const RenderTableInternal: React.FC<RenderTableProps> = ({
  headers,
  rows,
  contentWidth,
  aligns,
  enableInlineMath = false,
  isPending = false,
  isFrontier = true,
  availableTerminalHeight,
}) => {
  // The height clamp tracks whether the MESSAGE is streaming (overflow can grow
  // on any tick). The format anchor tracks whether THIS TABLE is still streaming
  // — only the frontier table anchors its format to the first row; a completed
  // mid-content table measures all rows. Keeping the clamp on isPending (not
  // isFrontier) means a mid-content table is still bounded, so the estimator's
  // clamped cost still matches the render and cannot under-estimate.
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
      isStreaming={isPending && isFrontier}
      maxHeight={maxHeight}
    />
  );
};

const RenderTable = React.memo(RenderTableInternal);

export const MarkdownDisplay = React.memo(MarkdownDisplayInternal);
