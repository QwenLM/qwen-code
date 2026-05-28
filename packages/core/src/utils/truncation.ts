/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { ReadFileTool } from '../tools/read-file.js';
import type { Config } from '../config/config.js';
import {
  logToolOutputTruncated,
  logToolOutputTruncationFailed,
} from '../telemetry/loggers.js';
import {
  ToolOutputTruncatedEvent,
  ToolOutputTruncationFailedEvent,
} from '../telemetry/types.js';
import { createDebugLogger } from './debugLogger.js';

const debugLogger = createDebugLogger('TRUNCATION');

/**
 * Sentinel used both as the first line of the truncation envelope and as
 * scheduler metadata via ToolResult.alreadyTruncated. Do not change the
 * wording without checking the scheduler double-truncation guards.
 */
export const TOOL_OUTPUT_TRUNCATED_PREFIX =
  'Tool output was too large and has been truncated.';

export function shouldTruncateContent(
  content: string,
  threshold: number,
  truncateLines: number,
): boolean {
  return (
    content.length > threshold || content.split('\n').length > truncateLines
  );
}

function truncateContentHeadTail(
  content: string,
  threshold: number,
  truncateLines: number,
): string {
  const lines = content.split('\n');

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

  return beginning.join('\n') + separator + end.join('\n');
}

function formatTruncatedContent(
  truncatedContent: string,
  contentLabel: string,
  outputFile?: string,
): string {
  const prefix =
    contentLabel === 'Tool output'
      ? TOOL_OUTPUT_TRUNCATED_PREFIX
      : `${contentLabel} was too large and has been truncated.`;

  if (!outputFile) {
    return `${prefix}
[Note: Could not save full ${contentLabel.toLowerCase()} to file]

Truncated part of the output:
${truncatedContent}`;
  }

  return `${prefix}
The full output has been saved to: ${outputFile}
To read the complete output, use the ${ReadFileTool.Name} tool with the absolute file path above.
The truncated output below shows the beginning and end of the content. The marker '... [CONTENT TRUNCATED] ...' indicates where content was removed.

Truncated part of the output:
${truncatedContent}`;
}

function sanitizeOutputFileName(fileName: string): string {
  return path
    .basename(fileName)
    .replace(/[<>:"/\\|?*]/g, '_')
    .split('')
    .map((char) => (char.charCodeAt(0) < 32 ? '_' : char))
    .join('');
}

export function truncateContentInMemory(
  content: string,
  threshold: number,
  truncateLines: number,
  contentLabel = 'Tool output',
): string {
  if (!shouldTruncateContent(content, threshold, truncateLines)) {
    return content;
  }
  return formatTruncatedContent(
    truncateContentHeadTail(content, threshold, truncateLines),
    contentLabel,
  );
}

/**
 * Truncates large tool output and saves the full content to a temp file.
 * Used to prevent excessively large outputs from being
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
  contentLabel = 'Tool output',
): Promise<{ content: string; outputFile?: string; saveError?: unknown }> {
  // Check both constraints: character threshold and line limit.
  if (!shouldTruncateContent(content, threshold, truncateLines)) {
    return { content };
  }

  const truncatedContent = truncateContentHeadTail(
    content,
    threshold,
    truncateLines,
  );

  // Sanitize fileName to prevent path traversal.
  const safeFileName = `${sanitizeOutputFileName(fileName)}.output`;
  const outputFile = path.join(projectTempDir, safeFileName);
  try {
    await fs.mkdir(projectTempDir, { recursive: true, mode: 0o700 });
    try {
      await fs.chmod(projectTempDir, 0o700);
    } catch (chmodError) {
      debugLogger.warn(
        `Failed to enforce private permissions on ${projectTempDir}: ` +
          (chmodError instanceof Error
            ? chmodError.message
            : String(chmodError)),
      );
    }
    await fs.writeFile(outputFile, content, { mode: 0o600 });

    return {
      content: formatTruncatedContent(
        truncatedContent,
        contentLabel,
        outputFile,
      ),
      outputFile,
    };
  } catch (error) {
    debugLogger.warn(
      `Failed to save truncated tool output to ${outputFile}: ` +
        (error instanceof Error ? error.message : String(error)),
    );
    return {
      content: formatTruncatedContent(truncatedContent, contentLabel),
      saveError: error,
    };
  }
}

/**
 * High-level truncation helper that reads thresholds from Config,
 * truncates if needed, saves full output to a temp file, and logs
 * telemetry. Returns the (possibly truncated) content and an optional
 * output file path.
 *
 * Callers no longer need to duplicate config extraction, file naming,
 * or telemetry logging.
 *
 * @param promptId Optional prompt id for telemetry. Scheduler-level callers
 * should pass the tool request prompt id when available; direct tool
 * implementations that do not receive scheduler context may omit it.
 */
export async function truncateToolOutput(
  config: Config,
  toolName: string,
  content: string,
  promptId = '',
  options: {
    threshold?: number;
    lines?: number;
    contentLabel?: string;
    callId?: string;
  } = {},
): Promise<{ content: string; outputFile?: string; saveError?: unknown }> {
  const threshold =
    options.threshold ?? config.getTruncateToolOutputThreshold();
  const lines = options.lines ?? config.getTruncateToolOutputLines();

  if (threshold <= 0 || lines <= 0) {
    return { content };
  }

  const originalLength = content.length;
  const fileName = `${toolName}_${crypto.randomBytes(6).toString('hex')}`;
  const result = await truncateAndSaveToFile(
    content,
    fileName,
    config.storage.getProjectTempDir(),
    threshold,
    lines,
    options.contentLabel,
  );

  const wasTruncated = shouldTruncateContent(content, threshold, lines);
  if (result.outputFile) {
    logToolOutputTruncated(
      config,
      new ToolOutputTruncatedEvent(promptId, {
        toolName,
        callId: options.callId ?? '',
        originalContentLength: originalLength,
        truncatedContentLength: result.content.length,
        threshold,
        lines,
        outputFile: result.outputFile,
      }),
    );
  } else if (wasTruncated) {
    logToolOutputTruncationFailed(
      config,
      new ToolOutputTruncationFailedEvent(promptId, {
        toolName,
        callId: options.callId ?? '',
        originalContentLength: originalLength,
        error:
          result.saveError ??
          new Error('failed to save full truncated content to file'),
      }),
    );
  }

  return result;
}
