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
import { renderTerminalMathBlock } from './TerminalMathRenderer.js';

interface MarkdownDisplayProps {
  text: string;
  isPending: boolean;
  availableTerminalHeight?: number;
  contentWidth: number;
  textColor?: string;
}

// Constants for Markdown parsing and rendering

const EMPTY_LINE_HEIGHT = 1;
const CODE_BLOCK_PREFIX_PADDING = 1;
const LIST_ITEM_PREFIX_PADDING = 1;
const LIST_ITEM_TEXT_FLEX_GROW = 1;

const MarkdownDisplayInternal: React.FC<MarkdownDisplayProps> = ({
  text,
  isPending,
  availableTerminalHeight,
  contentWidth,
  textColor = theme.text.primary,
}) => {
  if (!text) return <></>;

  const lines = text.split(/\r?\n/);
  const headerRegex = /^ *(#{1,4}) +(.*)/;
  const codeFenceRegex = /^ *(`{3,}|~{3,}) *(\w*?) *$/;
  const ulItemRegex = /^([ \t]*)([-*+]) +(.*)/;
  const olItemRegex = /^([ \t]*)(\d+)\. +(.*)/;
  const hrRegex = /^ *([-*_] *){3,} *$/;
  const tableRowRegex = /^\s*\|(.+)\|\s*$/;
  const tableSeparatorRegex =
    /^(?=.*\|)\s*\|?\s*(:?-+:?)\s*(\|\s*(:?-+:?)\s*)*\|?\s*$/;
  const mathBlockStartRegex = /^ *(\$\$|\\\[)(.*)$/;

  /** Parse column alignments from a markdown table separator like `|:---|:---:|---:|` */
  const parseTableAligns = (line: string): ColumnAlign[] =>
    line
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim())
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
  let lastLineEmpty = true;
  let codeBlockContent: string[] = [];
  let codeBlockLang: string | null = null;
  let codeBlockFence = '';
  let inTable = false;
  let tableRows: string[][] = [];
  let tableHeaders: string[] = [];
  let tableAligns: ColumnAlign[] = [];
  let inMathBlock = false;
  let mathBlockContent: string[] = [];
  let mathBlockClose = '$$';

  function addContentBlock(block: React.ReactNode) {
    if (block) {
      contentBlocks.push(block);
      lastLineEmpty = false;
    }
  }

  const getMathBlockStart = (
    line: string,
  ): { content: string; close: string; isClosed: boolean } | null => {
    const match = line.match(mathBlockStartRegex);
    if (!match) return null;

    const delimiter = match[1];
    const close = delimiter === '$$' ? '$$' : '\\]';
    const rest = match[2] ?? '';
    const closeIndex = rest.lastIndexOf(close);
    const isClosed =
      closeIndex >= 0 && rest.slice(closeIndex + close.length).trim() === '';

    return {
      content: isClosed ? rest.slice(0, closeIndex).trim() : rest.trimStart(),
      close,
      isClosed,
    };
  };

  const addTextLine = (line: string, key: string) => {
    addContentBlock(
      <Box key={key}>
        <Text wrap="wrap">
          <RenderInline text={line} textColor={textColor} />
        </Text>
      </Box>,
    );
  };

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
            isPending={isPending}
            availableTerminalHeight={availableTerminalHeight}
            contentWidth={contentWidth}
          />,
        );
        inCodeBlock = false;
        codeBlockContent = [];
        codeBlockLang = null;
        codeBlockFence = '';
      } else {
        codeBlockContent.push(line);
      }
      return;
    }

    if (inMathBlock) {
      const closeIndex = line.indexOf(mathBlockClose);
      if (closeIndex >= 0) {
        const beforeClose = line.slice(0, closeIndex);
        if (beforeClose.trim().length > 0) {
          mathBlockContent.push(beforeClose);
        }
        addContentBlock(
          <RenderMathBlock
            key={key}
            content={mathBlockContent}
            contentWidth={contentWidth}
            textColor={textColor}
          />,
        );
        inMathBlock = false;
        mathBlockContent = [];

        const trailing = line.slice(closeIndex + mathBlockClose.length).trim();
        if (trailing.length > 0) {
          addTextLine(trailing, `${key}-trailing`);
        }
      } else {
        mathBlockContent.push(line);
      }
      return;
    }

    const codeFenceMatch = line.match(codeFenceRegex);
    const headerMatch = line.match(headerRegex);
    const ulMatch = line.match(ulItemRegex);
    const olMatch = line.match(olItemRegex);
    const hrMatch = line.match(hrRegex);
    const tableRowMatch = line.match(tableRowRegex);
    const tableSeparatorMatch = line.match(tableSeparatorRegex);

    if (codeFenceMatch) {
      inCodeBlock = true;
      codeBlockFence = codeFenceMatch[1];
      codeBlockLang = codeFenceMatch[2] || null;
    } else if (!inTable) {
      const mathBlockStart = getMathBlockStart(line);
      if (mathBlockStart) {
        if (mathBlockStart.isClosed) {
          addContentBlock(
            <RenderMathBlock
              key={key}
              content={[mathBlockStart.content]}
              contentWidth={contentWidth}
              textColor={textColor}
            />,
          );
        } else {
          inMathBlock = true;
          mathBlockClose = mathBlockStart.close;
          mathBlockContent = mathBlockStart.content
            ? [mathBlockStart.content]
            : [];
        }
      } else if (tableRowMatch && !inTable) {
        // Potential table start - check if next line is separator with matching column count
        const potentialHeaders = tableRowMatch[1]
          .split(/(?<!\\)\|/)
          .map((cell) => cell.trim().replaceAll('\\|', '|'));
        const nextLine = index + 1 < lines.length ? lines[index + 1]! : '';
        const sepMatch = nextLine.match(tableSeparatorRegex);
        const sepColCount = sepMatch
          ? nextLine
              .split(/(?<!\\)\|/)
              .map((c) => c.trim())
              .filter((c) => c.length > 0).length
          : 0;

        if (sepMatch && sepColCount === potentialHeaders.length) {
          inTable = true;
          tableHeaders = potentialHeaders;
          tableRows = [];
        } else {
          // Not a table, treat as regular text
          addTextLine(line, key);
        }
      } else if (hrMatch) {
        addContentBlock(
          <Box key={key}>
            <Text dimColor>---</Text>
          </Box>,
        );
      } else if (headerMatch) {
        const level = headerMatch[1].length;
        const headerText = headerMatch[2];
        let headerNode: React.ReactNode = null;
        switch (level) {
          case 1:
            headerNode = (
              <Text bold color={textColor}>
                <RenderInline text={headerText} textColor={textColor} />
              </Text>
            );
            break;
          case 2:
            headerNode = (
              <Text bold color={textColor}>
                <RenderInline text={headerText} textColor={textColor} />
              </Text>
            );
            break;
          case 3:
            headerNode = (
              <Text bold color={textColor}>
                <RenderInline text={headerText} textColor={textColor} />
              </Text>
            );
            break;
          case 4:
            headerNode = (
              <Text italic color={textColor}>
                <RenderInline text={headerText} textColor={textColor} />
              </Text>
            );
            break;
          default:
            headerNode = (
              <Text color={textColor}>
                <RenderInline text={headerText} textColor={textColor} />
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
                <RenderInline text={line} textColor={textColor} />
              </Text>
            </Box>,
          );
        }
      }
    } else if (inTable && tableSeparatorMatch) {
      // Parse alignment from separator line
      tableAligns = parseTableAligns(line);
    } else if (inTable && tableRowMatch) {
      // Add table row
      const cells = tableRowMatch[1]
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim().replaceAll('\\|', '|'));
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
          />,
        );
      }
      inTable = false;
      tableRows = [];
      tableHeaders = [];
      tableAligns = [];

      // Process current line as normal
      if (line.trim().length > 0) {
        const mathBlockStart = getMathBlockStart(line);
        if (mathBlockStart) {
          if (mathBlockStart.isClosed) {
            addContentBlock(
              <RenderMathBlock
                key={key}
                content={[mathBlockStart.content]}
                contentWidth={contentWidth}
                textColor={textColor}
              />,
            );
          } else {
            inMathBlock = true;
            mathBlockClose = mathBlockStart.close;
            mathBlockContent = mathBlockStart.content
              ? [mathBlockStart.content]
              : [];
          }
        } else {
          addTextLine(line, key);
        }
      }
    }
  });

  if (inCodeBlock) {
    addContentBlock(
      <RenderCodeBlock
        key="line-eof"
        content={codeBlockContent}
        lang={codeBlockLang}
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
        contentWidth={contentWidth}
        textColor={textColor}
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
      />,
    );
  }

  return <>{contentBlocks}</>;
};

// Helper functions (adapted from static methods of MarkdownRenderer)

interface RenderCodeBlockProps {
  content: string[];
  lang: string | null;
  isPending: boolean;
  availableTerminalHeight?: number;
  contentWidth: number;
}

const RenderCodeBlockInternal: React.FC<RenderCodeBlockProps> = ({
  content,
  lang,
  isPending,
  availableTerminalHeight,
  contentWidth,
}) => {
  const settings = useSettings();
  const MIN_LINES_FOR_MESSAGE = 1; // Minimum lines to show before the "generating more" message
  const RESERVED_LINES = 2; // Lines reserved for the message itself and potential padding

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

  const fullContent = content.join('\n');
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

interface RenderMathBlockProps {
  content: string[];
  contentWidth: number;
  textColor?: string;
}

const RenderMathBlockInternal: React.FC<RenderMathBlockProps> = ({
  content,
  contentWidth,
  textColor = theme.text.primary,
}) => {
  const renderedLines = renderTerminalMathBlock(content.join('\n'));

  return (
    <Box
      paddingLeft={CODE_BLOCK_PREFIX_PADDING}
      flexDirection="column"
      width={contentWidth}
      flexShrink={0}
    >
      {renderedLines.map((line, index) => (
        <Text key={`math-${index}`} color={textColor}>
          {line}
        </Text>
      ))}
    </Box>
  );
};

const RenderMathBlock = React.memo(RenderMathBlockInternal);

interface RenderListItemProps {
  itemText: string;
  type: 'ul' | 'ol';
  marker: string;
  leadingWhitespace?: string;
  textColor?: string;
}

const RenderListItemInternal: React.FC<RenderListItemProps> = ({
  itemText,
  type,
  marker,
  leadingWhitespace = '',
  textColor = theme.text.primary,
}) => {
  const prefix = type === 'ol' ? `${marker}. ` : `${marker} `;
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
          <RenderInline text={itemText} textColor={textColor} />
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
}

const RenderTableInternal: React.FC<RenderTableProps> = ({
  headers,
  rows,
  contentWidth,
  aligns,
}) => (
  <TableRenderer
    headers={headers}
    rows={rows}
    contentWidth={contentWidth}
    aligns={aligns}
  />
);

const RenderTable = React.memo(RenderTableInternal);

export const MarkdownDisplay = React.memo(MarkdownDisplayInternal);
