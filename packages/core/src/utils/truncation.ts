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
  const lines = content.split('\n');

  // Check both constraints: character threshold and line limit.
  if (content.length <= threshold && lines.length <= truncateLines) {
    return { content };
  }

  // Build head and tail within both line and character budgets.
  const effectiveLines = Math.min(truncateLines, lines.length);
  const headCount = Math.max(Math.floor(effectiveLines / 5), 1);
  const tailCount = effectiveLines - headCount;
  const separator = '\n\n---\n... [CONTENT TRUNCATED] ...\n---\n\n';
  const ellipsis = '...';

  // Collect head lines within budget. If a single line exceeds the
  // remaining budget, include a truncated slice of it.
  const headBudget = Math.floor(threshold / 5);
  const beginning: string[] = [];
  let headChars = 0;
  for (let i = 0; i < Math.min(headCount, lines.length); i++) {
    const remaining = headBudget - headChars;
    if (remaining <= 0) break;
    if (lines[i].length + 1 > remaining) {
      const sliceLen = Math.max(remaining - ellipsis.length, 0);
      beginning.push(lines[i].slice(0, sliceLen) + ellipsis);
      headChars = headBudget;
      break;
    }
    beginning.push(lines[i]);
    headChars += lines[i].length + 1; // +1 for newline
  }

  // Collect tail lines within remaining budget. If a single line exceeds
  // the remaining budget, include a truncated slice of it.
  const tailBudget = Math.max(threshold - headChars - separator.length, 0);
  const end: string[] = [];
  let tailChars = 0;
  const tailStart = Math.max(lines.length - tailCount, beginning.length);
  for (let i = lines.length - 1; i >= tailStart; i--) {
    const remaining = tailBudget - tailChars;
    if (remaining <= 0) break;
    if (lines[i].length + 1 > remaining) {
      const sliceLen = Math.max(remaining - ellipsis.length, 0);
      end.unshift(ellipsis + lines[i].slice(-sliceLen));
      tailChars = tailBudget;
      break;
    }
    end.unshift(lines[i]);
    tailChars += lines[i].length + 1;
  }

  const truncatedContent = beginning.join('\n') + separator + end.join('\n');

  // Sanitize fileName to prevent path traversal.
  const safeFileName = `${path.basename(fileName)}.output`;
  const outputFile = path.join(projectTempDir, safeFileName);
  try {
    await fs.writeFile(outputFile, content);

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
