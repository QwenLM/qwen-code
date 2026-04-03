/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Text, Box } from 'ink';
import { theme } from '../semantic-colors.js';
import { RenderInline, getPlainTextLength } from './InlineMarkdownRenderer.js';
import { getCachedStringWidth, toCodePoints } from './textUtils.js';

interface TableRendererProps {
  headers: string[];
  rows: string[][];
  contentWidth: number;
}

/**
 * Wrap text to fit within a specified width (in display columns).
 * Returns an array of lines, where each line fits within maxWidth.
 * Handles word-aware wrapping with fallback to character-level wrapping.
 */
function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) {
    return [''];
  }

  if (getCachedStringWidth(text) <= maxWidth) {
    return [text];
  }

  const lines: string[] = [];

  // Handle intentional newlines first
  const paragraphs = text.split('\n');

  for (const paragraph of paragraphs) {
    if (paragraph.length === 0) {
      lines.push('');
      continue;
    }

    // Split into words (by spaces)
    const words = paragraph.split(/\s+/);
    let currentLine = '';

    for (const word of words) {
      if (word.length === 0) continue;

      const wordWidth = getCachedStringWidth(word);
      const currentLineWidth = getCachedStringWidth(currentLine);
      const spaceWidth = currentLine.length > 0 ? 1 : 0;

      // Check if word fits on current line
      if (currentLineWidth + spaceWidth + wordWidth <= maxWidth) {
        currentLine = currentLine.length > 0 ? currentLine + ' ' + word : word;
      } else {
        // Push current line if not empty
        if (currentLine.length > 0) {
          lines.push(currentLine);
          currentLine = '';
        }

        // If word itself is too long, split it
        if (wordWidth > maxWidth) {
          // Split long word across multiple lines
          let remainingWord = word;
          while (remainingWord.length > 0) {
            let splitPoint = remainingWord.length;

            // Binary search for optimal split point
            let left = 0;
            let right = remainingWord.length;
            while (left <= right) {
              const mid = Math.floor((left + right) / 2);
              const candidate = toCodePoints(remainingWord)
                .slice(0, mid)
                .join('');
              const candidateWidth = getCachedStringWidth(candidate);

              if (candidateWidth <= maxWidth) {
                splitPoint = mid;
                left = mid + 1;
              } else {
                right = mid - 1;
              }
            }

            const lineContent = toCodePoints(remainingWord)
              .slice(0, splitPoint)
              .join('');
            lines.push(lineContent);
            remainingWord = toCodePoints(remainingWord)
              .slice(splitPoint)
              .join('');
          }
        } else {
          currentLine = word;
        }
      }
    }

    // Push remaining content
    if (currentLine.length > 0) {
      lines.push(currentLine);
    }
  }

  return lines.length > 0 ? lines : [''];
}

/**
 * Pad a line to the specified width with spaces.
 */
function padLine(line: string, targetWidth: number): string {
  const currentWidth = getCachedStringWidth(line);
  const paddingNeeded = Math.max(0, targetWidth - currentWidth);
  return line + ' '.repeat(paddingNeeded);
}

/**
 * Custom table renderer for markdown tables with multi-line cell support
 */
export const TableRenderer: React.FC<TableRendererProps> = ({
  headers,
  rows,
  contentWidth,
}) => {
  // Calculate column widths using actual display width after markdown processing
  const columnWidths = headers.map((header, index) => {
    const headerWidth = getPlainTextLength(header);
    const maxRowWidth = Math.max(
      0,
      ...rows.map((row) => getPlainTextLength(row[index] || '')),
    );
    return Math.max(headerWidth, maxRowWidth) + 2; // Add padding
  });

  // Ensure table fits within terminal width
  const totalWidth = columnWidths.reduce((sum, width) => sum + width + 1, 1);
  const scaleFactor = totalWidth > contentWidth ? contentWidth / totalWidth : 1;
  const adjustedWidths = columnWidths.map((width) =>
    Math.floor(width * scaleFactor),
  );

  // Pre-calculate wrapped content for all cells
  // wrappedHeaders: string[][] - array of lines for each header
  // wrappedRows: string[][][] - array of rows, each row is array of cells, each cell is array of lines
  const wrappedHeaders = headers.map((header, index) => {
    const cellWidth = Math.max(0, adjustedWidths[index] - 2);
    return wrapText(header, cellWidth);
  });

  const wrappedRows = rows.map((row) =>
    row.map((cell, index) => {
      const cellWidth = Math.max(0, adjustedWidths[index] - 2);
      return wrapText(cell || '', cellWidth);
    }),
  );

  // Calculate how many visual rows each logical row needs
  const headerRowCount = Math.max(
    1,
    ...wrappedHeaders.map((lines) => lines.length),
  );

  const rowHeights = wrappedRows.map((wrappedRow) =>
    Math.max(1, ...wrappedRow.map((lines) => lines.length)),
  );

  // Helper function to render a cell line with proper width
  const renderCellLine = (
    content: string,
    width: number,
    isHeader = false,
  ): React.ReactNode => {
    const cellContentWidth = Math.max(0, width - 2);
    const paddedContent = padLine(content, cellContentWidth);

    return (
      <Text>
        {isHeader ? (
          <Text bold color={theme.text.link}>
            <RenderInline text={paddedContent} />
          </Text>
        ) : (
          <RenderInline text={paddedContent} />
        )}
      </Text>
    );
  };

  // Helper function to render border
  const renderBorder = (type: 'top' | 'middle' | 'bottom'): React.ReactNode => {
    const chars = {
      top: { left: '┌', middle: '┬', right: '┐', horizontal: '─' },
      middle: { left: '├', middle: '┼', right: '┤', horizontal: '─' },
      bottom: { left: '└', middle: '┴', right: '┘', horizontal: '─' },
    };

    const char = chars[type];
    const borderParts = adjustedWidths.map((w) => char.horizontal.repeat(w));
    const border = char.left + borderParts.join(char.middle) + char.right;

    return <Text color={theme.border.default}>{border}</Text>;
  };

  // Helper function to render a visual row with cells at specific line index
  const renderVisualRow = (
    cells: string[][],
    lineIndex: number,
    isHeader = false,
  ): React.ReactNode => {
    const renderedCells = cells.map((cellLines, index) => {
      const width = adjustedWidths[index] || 0;
      const line = cellLines[lineIndex] || '';
      return renderCellLine(line, width, isHeader);
    });

    return (
      <Text color={theme.text.primary}>
        │{' '}
        {renderedCells.map((cell, index) => (
          <React.Fragment key={index}>
            {cell}
            {index < renderedCells.length - 1 ? ' │ ' : ''}
          </React.Fragment>
        ))}{' '}
        │
      </Text>
    );
  };

  return (
    <Box flexDirection="column" marginY={1}>
      {/* Top border */}
      {renderBorder('top')}

      {/* Header rows (may span multiple visual rows) */}
      {Array.from({ length: headerRowCount }, (_, lineIndex) =>
        renderVisualRow(wrappedHeaders, lineIndex, true),
      )}

      {/* Middle border */}
      {renderBorder('middle')}

      {/* Data rows (each may span multiple visual rows) */}
      {rows.map((row, rowIndex) => {
        const wrappedRow = wrappedRows[rowIndex];
        const height = rowHeights[rowIndex];

        return (
          <React.Fragment key={rowIndex}>
            {Array.from({ length: height }, (_, lineIndex) =>
              renderVisualRow(wrappedRow, lineIndex),
            )}
          </React.Fragment>
        );
      })}

      {/* Bottom border */}
      {renderBorder('bottom')}
    </Box>
  );
};
