/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Text, Box } from 'ink';
import stringWidth from 'string-width';
import { theme } from '../semantic-colors.js';
import { ICON } from '../constants.js';
import { colorizeCode } from './CodeColorizer.js';
import { TableRenderer, type ColumnAlign } from './TableRenderer.js';
import { RenderInline } from './InlineMarkdownRenderer.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { MermaidDiagram } from './MermaidDiagram.js';
import { renderInlineLatex } from './latexRenderer.js';
import { useRenderMode } from '../contexts/RenderModeContext.js';
import { parseCodeFenceInfo } from './markdown-utilities.js';
import { parseInkMarkdownBlocks } from './ink-markdown-blocks.js';
import {
  fitPendingSlice,
  splitMarkdownTableRow,
  TABLE_SEPARATOR_RE,
  CODE_FENCE_RE,
  isClosingCodeFence,
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
  /** Original Markdown when the row displays a rewrite. */
  sourceCopyText?: string;
  showSourceCopyHints?: boolean;
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
  /**
   * Give the wrapping text blocks — paragraphs, list items and blockquotes — an
   * explicit width instead of letting yoga measure the wrapping `<Text>`
   * implicitly. Without it a block that fills the terminal can overrun the right
   * margin and be hard-wrapped by the terminal mid-word. Pass it only where
   * `contentWidth` is exactly the width those blocks may use; callers whose
   * `contentWidth` already accounts for their own border and padding must not
   * opt in, or the block gets clipped instead of overflowing.
   */
  constrainBlockWidth?: boolean;
}

export interface MarkdownSourceCopyIndexOffsets {
  codeBlockLanguageCounts: Map<string, number>;
  mathBlockCount: number;
}

export interface MarkdownSourceBlockCounts {
  codeBlockLanguageCounts: Map<string, number>;
  mathBlockCount: number;
}

type SourceCopyKind = 'mermaid' | 'latex';
type OriginalCopyHint = (
  kind: SourceCopyKind,
  content: string[],
) => string | undefined;

export function countMarkdownSourceBlocks(
  text: string,
  onCopyableBlock?: (
    kind: SourceCopyKind,
    source: string,
    index: number,
  ) => void,
): MarkdownSourceBlockCounts {
  const codeBlockLanguageCounts = new Map<string, number>();
  const lines = text.split(/\r?\n/);
  const codeFenceRegex = CODE_FENCE_RE;
  const mathFenceRegex = /^ *\$\$ *$/;
  let activeCodeFence: string | null = null;
  let codeLanguage: string | undefined;
  let inMathBlock = false;
  let mathBlockCount = 0;
  let sourceStart = 0;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const codeFenceMatch = line.match(codeFenceRegex);
    if (activeCodeFence) {
      if (isClosingCodeFence(codeFenceMatch, activeCodeFence)) {
        activeCodeFence = null;
        if (codeLanguage === 'mermaid') {
          onCopyableBlock?.(
            'mermaid',
            lines.slice(sourceStart, index).join('\n'),
            codeBlockLanguageCounts.get(codeLanguage)!,
          );
        }
      }
      continue;
    }

    if (inMathBlock) {
      if (mathFenceRegex.test(line)) {
        inMathBlock = false;
        onCopyableBlock?.(
          'latex',
          lines.slice(sourceStart, index).join('\n'),
          mathBlockCount,
        );
      }
      continue;
    }

    if (codeFenceMatch) {
      activeCodeFence = codeFenceMatch[1];
      sourceStart = index + 1;
      codeLanguage = parseCodeFenceInfo(codeFenceMatch[2]).lang?.toLowerCase();
      if (codeLanguage) {
        codeBlockLanguageCounts.set(
          codeLanguage,
          (codeBlockLanguageCounts.get(codeLanguage) ?? 0) + 1,
        );
      }
      continue;
    }

    if (mathFenceRegex.test(line)) {
      inMathBlock = true;
      sourceStart = index + 1;
      mathBlockCount += 1;
    }
  }

  return { codeBlockLanguageCounts, mathBlockCount };
}

function originalCopyHint(
  text: string,
  offsets: MarkdownSourceCopyIndexOffsets | undefined,
): OriginalCopyHint {
  const hints = {
    mermaid: new Map<string, string | undefined>(),
    latex: new Map<string, string | undefined>(),
  };
  countMarkdownSourceBlocks(text, (kind, source, index) => {
    const offset =
      kind === 'mermaid'
        ? offsets?.codeBlockLanguageCounts.get(kind)
        : offsets?.mathBlockCount;
    const bySource = hints[kind];
    // A repeated source does not identify a unique position in the reply.
    bySource.set(
      source,
      bySource.has(source)
        ? undefined
        : `/copy ${kind} ${index + (offset ?? 0)}`,
    );
  });
  return (kind, content) => hints[kind].get(content.join('\n'));
}

// Constants for Markdown parsing and rendering

const EMPTY_LINE_HEIGHT = 1;
const CODE_BLOCK_PREFIX_PADDING = 1;
const LIST_ITEM_PREFIX_PADDING = 1;
const LIST_ITEM_TEXT_FLEX_GROW = 1;
const BLOCKQUOTE_PREFIX_PADDING = 1;
const BLOCKQUOTE_PREFIX = '│ ';
const MATH_BLOCK_PREFIX_PADDING = 1;

const MarkdownDisplayInternal: React.FC<MarkdownDisplayProps> = ({
  text,
  isPending,
  availableTerminalHeight,
  contentWidth,
  textColor = theme.text.primary,
  sourceCopyIndexOffsets,
  sourceCopyText,
  showSourceCopyHints = true,
  enforceHeightBudget = false,
  constrainBlockWidth = false,
}) => {
  const { renderMode } = useRenderMode();
  const copyHint = React.useMemo(() => {
    if (!showSourceCopyHints) return () => undefined;
    return sourceCopyText === undefined
      ? undefined
      : originalCopyHint(sourceCopyText, sourceCopyIndexOffsets);
  }, [showSourceCopyHints, sourceCopyText, sourceCopyIndexOffsets]);
  if (!text) return <></>;

  const renderVisualBlocks = renderMode === 'render';
  const blockWidth = constrainBlockWidth
    ? Math.max(0, contentWidth)
    : undefined;
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
  const codeFenceRegex = CODE_FENCE_RE;
  const mathFenceRegex = /^ *\$\$ *$/;
  const tableSeparatorRegex = TABLE_SEPARATOR_RE;

  // Rendered-height-aware slice of the pending preview (shared with
  // useLlmStream's incremental commit — see pending-rendered-height.ts — so the
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
          if (isClosingCodeFence(fenceMatch, activeCodeFence)) {
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

  const contentBlocks: React.ReactNode[] = [];
  const codeBlockLanguageCounts = new Map(
    sourceCopyIndexOffsets?.codeBlockLanguageCounts,
  );
  let codeBlockIndex = 0;
  let mathBlockIndex = sourceCopyIndexOffsets?.mathBlockCount ?? 0;
  let lastLineEmpty = true;

  function addContentBlock(block: React.ReactNode) {
    contentBlocks.push(block);
    lastLineEmpty = false;
  }

  for (const block of parseInkMarkdownBlocks(
    lines,
    renderVisualBlocks,
    isPending,
  )) {
    const atEnd = block.index === lines.length;
    const key = `line-${block.index}`;
    switch (block.kind) {
      case 'code': {
        const { lang, startLine } = parseCodeFenceInfo(block.info);
        const normalizedLang = lang?.toLowerCase();
        let languageIndex = 0;
        if (normalizedLang) {
          languageIndex =
            (codeBlockLanguageCounts.get(normalizedLang) ?? 0) + 1;
          codeBlockLanguageCounts.set(normalizedLang, languageIndex);
        }
        codeBlockIndex += 1;
        addContentBlock(
          <RenderCodeBlock
            key={atEnd ? 'line-eof' : key}
            content={block.content}
            lang={lang}
            codeBlockIndex={codeBlockIndex}
            codeBlockLangIndex={languageIndex}
            originalCopyHint={copyHint}
            isPending={isPending}
            availableTerminalHeight={availableTerminalHeight}
            contentWidth={contentWidth}
            startLineNumber={startLine}
          />,
        );
        break;
      }
      case 'math':
        mathBlockIndex += 1;
        addContentBlock(
          <RenderMathBlock
            key={atEnd ? 'math-eof' : key}
            content={block.content}
            sourceCopyCommand={
              copyHint
                ? copyHint('latex', block.content)
                : `/copy latex ${mathBlockIndex}`
            }
            contentWidth={contentWidth}
            isPending={isPending}
            availableTerminalHeight={availableTerminalHeight}
          />,
        );
        break;
      case 'table':
        addContentBlock(
          <RenderTable
            key={`table-${contentBlocks.length}`}
            headers={block.headers}
            rows={block.rows}
            aligns={block.aligns}
            contentWidth={contentWidth}
            enableInlineMath={renderVisualBlocks}
            isPending={isPending}
            isFrontier={block.frontier}
            availableTerminalHeight={availableTerminalHeight}
          />,
        );
        break;
      case 'rule':
        addContentBlock(
          <Box key={key}>
            <Text dimColor>---</Text>
          </Box>,
        );
        break;
      case 'quote':
        addContentBlock(
          <RenderBlockquote
            key={key}
            quoteText={block.text}
            textColor={textColor}
            enableInlineMath={renderVisualBlocks}
            availableWidth={blockWidth}
          />,
        );
        break;
      case 'heading':
        addContentBlock(
          <Box key={key} maxWidth={blockWidth}>
            <Text
              bold={block.level <= 3}
              italic={block.level === 4}
              color={textColor}
            >
              <RenderInline
                text={block.text}
                textColor={textColor}
                enableInlineMath={renderVisualBlocks}
              />
            </Text>
          </Box>,
        );
        break;
      case 'list':
        addContentBlock(
          <RenderListItem
            key={key}
            itemText={block.text}
            ordered={block.ordered}
            marker={block.marker}
            indentation={block.indentation}
            checked={block.checked}
            textColor={textColor}
            renderVisualBlocks={renderVisualBlocks}
            availableWidth={blockWidth}
          />,
        );
        break;
      case 'text':
        if (block.text.trim().length === 0) {
          if (!lastLineEmpty) {
            contentBlocks.push(
              <Box key={`spacer-${block.index}`} height={EMPTY_LINE_HEIGHT} />,
            );
            lastLineEmpty = true;
          }
          break;
        }
        addContentBlock(
          <Box key={key} maxWidth={blockWidth}>
            <Text
              wrap="wrap"
              color={block.tableFallback ? undefined : textColor}
            >
              <RenderInline
                text={block.text}
                textColor={textColor}
                enableInlineMath={renderVisualBlocks}
              />
            </Text>
          </Box>,
        );
        break;
      default:
        block satisfies never;
    }
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
  originalCopyHint?: OriginalCopyHint;
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
  originalCopyHint,
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
        sourceCopyCommand={
          originalCopyHint
            ? originalCopyHint('mermaid', content)
            : `/copy mermaid ${codeBlockLangIndex || codeBlockIndex}`
        }
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
  sourceCopyCommand?: string;
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
  const title = sourceCopyCommand
    ? `LaTeX block · source: ${sourceCopyCommand}`
    : 'LaTeX block';
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
            {title}
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
        {title}
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
  /**
   * Width the whole quote may use, the `│ ` marker included. Pass it only where
   * `contentWidth` is exactly the width the quote may use; without it the text
   * box is measured implicitly by yoga and can consume the right margin.
   */
  availableWidth?: number;
}

const RenderBlockquoteInternal: React.FC<RenderBlockquoteProps> = ({
  quoteText,
  textColor = theme.text.primary,
  enableInlineMath = true,
  availableWidth,
}) => {
  const textWidth =
    availableWidth === undefined
      ? undefined
      : Math.max(
          0,
          availableWidth -
            BLOCKQUOTE_PREFIX_PADDING -
            stringWidth(BLOCKQUOTE_PREFIX),
        );
  const textContainerProps =
    textWidth === undefined
      ? { flexGrow: LIST_ITEM_TEXT_FLEX_GROW }
      : { width: textWidth };

  return (
    <Box paddingLeft={BLOCKQUOTE_PREFIX_PADDING} flexDirection="row">
      <Text color={theme.text.secondary}>{BLOCKQUOTE_PREFIX}</Text>
      <Box {...textContainerProps}>
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
};

const RenderBlockquote = React.memo(RenderBlockquoteInternal);

interface RenderListItemProps {
  itemText: string;
  ordered: boolean;
  marker: string;
  indentation: number;
  checked?: boolean;
  textColor?: string;
  renderVisualBlocks?: boolean;
  /**
   * Width the whole item may use, marker and indentation included. Pass it only
   * where `contentWidth` is exactly the width the item may use; without it the
   * text box is measured implicitly by yoga and can consume the right margin.
   */
  availableWidth?: number;
}

const RenderListItemInternal: React.FC<RenderListItemProps> = ({
  itemText,
  ordered,
  marker,
  indentation,
  checked,
  textColor = theme.text.primary,
  renderVisualBlocks = true,
  availableWidth,
}) => {
  const prefix =
    checked !== undefined
      ? `${checked ? '✓' : ICON.CIRCLE_EMPTY} `
      : ordered
        ? `${marker}. `
        : `${marker} `;
  const prefixWidth = stringWidth(prefix);
  const textWidth =
    availableWidth === undefined
      ? undefined
      : Math.max(
          0,
          availableWidth - indentation - LIST_ITEM_PREFIX_PADDING - prefixWidth,
        );
  const textContainerProps =
    textWidth === undefined
      ? { flexGrow: LIST_ITEM_TEXT_FLEX_GROW }
      : { width: textWidth };

  return (
    <Box
      paddingLeft={indentation + LIST_ITEM_PREFIX_PADDING}
      flexDirection="row"
    >
      <Box width={prefixWidth}>
        <Text color={textColor}>{prefix}</Text>
      </Box>
      <Box {...textContainerProps}>
        <Text wrap="wrap" color={textColor}>
          <RenderInline
            text={itemText}
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
