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
  const codeFenceRegex = /^ *(`{3,}|~{3,}) *([^`]*)$/;
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
const INLINE_MATH_MAX_CHARS = 1024;
const TABLE_INLINE_MATH_SPAN_RE = new RegExp(
  String.raw`(?<![\w$])\$(?![\s\d$])(?=[^$\n]{1,${INLINE_MATH_MAX_CHARS}}\S\$)[^$\n]{1,${INLINE_MATH_MAX_CHARS}}\$(?![\w$])`,
  'y',
);

function readTableInlineMathSpan(row: string, index: number): string | null {
  TABLE_INLINE_MATH_SPAN_RE.lastIndex = index;
  return TABLE_INLINE_MATH_SPAN_RE.exec(row)?.[0] ?? null;
}

function splitMarkdownTableRow(row: string): string[] {
  const cells: string[] = [];
  let current = '';
  let activeCodeFenceLength = 0;

  for (let index = 0; index < row.length; index++) {
    const char = row[index]!;
    if (char === '\\') {
      const next = row[index + 1];
      if (next === '|') {
        current += '|';
        index += 1;
        continue;
      }
      current += char;
      continue;
    }

    if (char === '`') {
      let runLength = 1;
      while (row[index + runLength] === '`') {
        runLength += 1;
      }
      if (activeCodeFenceLength === 0) {
        activeCodeFenceLength = runLength;
      } else if (runLength === activeCodeFenceLength) {
        activeCodeFenceLength = 0;
      }
      current += '`'.repeat(runLength);
      index += runLength - 1;
      continue;
    }

    if (char === '$' && activeCodeFenceLength === 0) {
      const mathSpan = readTableInlineMathSpan(row, index);
      if (mathSpan) {
        current += mathSpan;
        index += mathSpan.length - 1;
        continue;
      }
    }

    if (char === '|' && activeCodeFenceLength === 0) {
      cells.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

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
  const lines = displayText.split(/\r?\n/);
  const headerRegex = /^ *(#{1,4}) +(.*)/;
  const codeFenceRegex = /^ *(`{3,}|~{3,}) *([^`]*)$/;
  const ulItemRegex = /^([ \t]*)([-*+]) +(.*)/;
  const olItemRegex = /^([ \t]*)(\d+)\. +(.*)/;
  const hrRegex = /^ *([-*_] *){3,} *$/;
  const blockquoteRegex = /^ *> ?(.*)$/;
  const mathFenceRegex = /^ *\$\$ *$/;
  const tableRowRegex = /^\s*\|(.+)\|\s*$/;
  const tableSeparatorRegex =
    /^(?=.*\|)\s*\|?\s*(:?-+:?)\s*(\|\s*(:?-+:?)\s*)*\|?\s*$/;

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
      // End of table
      if (tableHeaders.length > 0 && tableRows.length > 0) {
        addContentBlock(
          <RenderTable
            key={`table-${contentBlocks.length}`}
            headers={tableHeaders}
            rows={tableRows}
            contentWidth={contentWidth}
            aligns={tableAligns}
            enableInlineMath={renderVisualBlocks}
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

  // Handle table at end of content
  if (inTable && tableHeaders.length > 0 && tableRows.length > 0) {
    addContentBlock(
      <RenderTable
        key={`table-${contentBlocks.length}`}
        headers={tableHeaders}
        rows={tableRows}
        contentWidth={contentWidth}
        aligns={tableAligns}
        enableInlineMath={renderVisualBlocks}
      />,
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
  const MIN_LINES_FOR_MESSAGE = 1; // Minimum lines to show before the "generating more" message
  const RESERVED_LINES = 2; // Lines reserved for the message itself and potential padding

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
      if (MAX_CODE_LINES_WHEN_PENDING < MIN_LINES_FOR_MESSAGE) {
        // Not enough space to even show the message meaningfully
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
          <Text color={theme.text.secondary}>... generating more ...</Text>
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
  const maxPreviewLines =
    availableTerminalHeight === undefined
      ? 6
      : Math.max(0, availableTerminalHeight - 2);
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
      {content.length > previewLines.length && (
        <Text color={theme.text.secondary}>... generating more ...</Text>
      )}
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
  const RESERVED_LINES = 3;
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
          <Text color={theme.text.secondary}>... generating more ...</Text>
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
}

const RenderTableInternal: React.FC<RenderTableProps> = ({
  headers,
  rows,
  contentWidth,
  aligns,
  enableInlineMath = false,
}) => (
  <TableRenderer
    headers={headers}
    rows={rows}
    contentWidth={contentWidth}
    aligns={aligns}
    enableInlineMath={enableInlineMath}
  />
);

const RenderTable = React.memo(RenderTableInternal);

export const MarkdownDisplay = React.memo(MarkdownDisplayInternal);
