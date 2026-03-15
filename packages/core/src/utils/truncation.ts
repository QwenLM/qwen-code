/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { ReadFileTool } from '../tools/read-file.js';

/**
 * Truncates large tool output and saves the full content to a temp file.
 * Used by the shell tool to prevent excessively large outputs from being
 * sent to the LLM context.
 *
 * If content length is within the threshold, returns it unchanged.
 * Otherwise, saves full content to a file and returns a truncated version
 * with head/tail lines and a pointer to the saved file.
 */
export async function truncateAndSaveToFile(
  content: string,
  fileName: string,
  projectTempDir: string,
  threshold: number,
  truncateLines: number,
): Promise<{ content: string; outputFile?: string }> {
  let lines = content.split('\n');
  let fileContent = content;

  // Check both constraints: character threshold and line limit.
  const exceedsThreshold = content.length > threshold;
  const exceedsLineLimit = lines.length > truncateLines;

  if (!exceedsThreshold && !exceedsLineLimit) {
    return { content };
  }

  // If the content is long but has few lines, wrap it to enable line-based truncation.
  if (exceedsThreshold && !exceedsLineLimit) {
    const wrapWidth = 120; // A reasonable width for wrapping.
    const wrappedLines: string[] = [];
    for (const line of lines) {
      if (line.length > wrapWidth) {
        for (let i = 0; i < line.length; i += wrapWidth) {
          wrappedLines.push(line.substring(i, i + wrapWidth));
        }
      } else {
        wrappedLines.push(line);
      }
    }
    lines = wrappedLines;
    fileContent = lines.join('\n');
  }

  // Compute effective line limit that respects both constraints.
  // If the average line length would cause truncateLines to exceed the
  // character threshold, reduce the number of lines to fit.
  let effectiveLines = truncateLines;
  if (lines.length > 0) {
    const totalChars = lines.reduce((sum, line) => sum + line.length, 0);
    const avgLineLength = totalChars / lines.length;
    if (avgLineLength > 0) {
      const linesFittingThreshold = Math.floor(threshold / avgLineLength);
      effectiveLines = Math.min(truncateLines, linesFittingThreshold);
      // Ensure at least a small number of lines are kept.
      effectiveLines = Math.max(effectiveLines, 10);
    }
  }

  const head = Math.floor(effectiveLines / 5);
  const beginning = lines.slice(0, head);
  const end = lines.slice(-(effectiveLines - head));
  const truncatedContent =
    beginning.join('\n') +
    '\n\n---\n... [CONTENT TRUNCATED] ...\n---\n\n' +
    end.join('\n');

  // Sanitize fileName to prevent path traversal.
  const safeFileName = `${path.basename(fileName)}.output`;
  const outputFile = path.join(projectTempDir, safeFileName);
  try {
    await fs.writeFile(outputFile, fileContent);

    return {
      content: `Tool output was too large and has been truncated.
The full output has been saved to: ${outputFile}
To read the complete output, use the ${ReadFileTool.Name} tool with the absolute file path above.
The truncated output below shows the beginning and end of the content. The marker '... [CONTENT TRUNCATED] ...' indicates where content was removed.

Truncated part of the output:
${truncatedContent}`,
      outputFile,
    };
  } catch (_error) {
    return {
      content:
        truncatedContent + `\n[Note: Could not save full output to file]`,
    };
  }
}
