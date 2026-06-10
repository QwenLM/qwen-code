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
import { logToolOutputTruncated } from '../telemetry/loggers.js';
import { ToolOutputTruncatedEvent } from '../telemetry/types.js';

export const TOOL_OUTPUT_TRUNCATED_PREFIX =
  'Tool output was too large and has been truncated.';

type TruncationLimits = {
  threshold?: number;
  lines?: number;
  callId?: string;
  contentLabel?: string;
};

type TruncationResult = {
  content: string;
  outputFile?: string;
  saveErrorCode?: string;
  saveErrorMessage?: string;
};

function shouldTruncateContent(
  content: string,
  threshold: number,
  truncateLines: number,
): boolean {
  return (
    threshold > 0 &&
    truncateLines > 0 &&
    (content.length > threshold || content.split('\n').length > truncateLines)
  );
}

export function truncateContentInMemory(
  content: string,
  threshold: number,
  truncateLines: number,
): string {
  if (!shouldTruncateContent(content, threshold, truncateLines)) {
    return content;
  }

  const lines = content.split('\n');
  const effectiveLines = Math.min(truncateLines, lines.length);
  const headCount = Math.max(Math.floor(effectiveLines / 5), 1);
  const tailCount = effectiveLines - headCount;
  const separator = '\n\n---\n... [CONTENT TRUNCATED] ...\n---\n\n';
  const ellipsis = '...';

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
    headChars += lines[i].length + 1;
  }

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

export function formatTruncatedContent(
  truncatedContent: string,
  options: {
    contentLabel?: string;
    outputFile?: string;
    saveFailed?: boolean;
  } = {},
): string {
  const contentLabel = options.contentLabel ?? 'Tool output';
  const completeContentLabel = contentLabel.toLowerCase();
  const prefix =
    contentLabel === 'Tool output'
      ? TOOL_OUTPUT_TRUNCATED_PREFIX
      : `${contentLabel} was too large and has been truncated.`;
  const saveNotice = options.outputFile
    ? `The full ${completeContentLabel} has been saved to: ${options.outputFile}
To read the complete ${completeContentLabel}, use the ${ReadFileTool.Name} tool with the absolute file path above.`
    : options.saveFailed
      ? '[Note: Could not save full output to file]'
      : undefined;

  return `${prefix}
${saveNotice ? `${saveNotice}\n` : ''}The truncated output below shows the beginning and end of the content. The marker '... [CONTENT TRUNCATED] ...' indicates where content was removed.

Truncated part of the output:
${truncatedContent}`;
}

function sanitizeOutputFileName(fileName: string): string {
  const baseName = path
    .basename(fileName)
    .replace(/[<>:"/\\|?*]/g, '_')
    .split('')
    .map((char) => (char.charCodeAt(0) < 32 ? '_' : char))
    .join('');
  return baseName || 'tool-output';
}

function getErrorCode(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return error.code;
  }
  if (error instanceof Error && error.name) {
    return error.name;
  }
  return 'unknown';
}

export function sanitizeTelemetryErrorMessage(message: string): string {
  return message
    .replace(/[A-Za-z]:[\\/][^\r\n]*/g, '[path]')
    .replace(/\\\\[^\r\n]*/g, '[path]')
    .replace(/(^|\s)\/[^\r\n]*/g, '$1[path]');
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return sanitizeTelemetryErrorMessage(error.message);
  }
  return sanitizeTelemetryErrorMessage(String(error));
}

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
  contentLabel = 'Tool output',
): Promise<TruncationResult> {
  if (!shouldTruncateContent(content, threshold, truncateLines)) {
    return { content };
  }

  const truncatedContent = truncateContentInMemory(
    content,
    threshold,
    truncateLines,
  );

  // Sanitize fileName to prevent path traversal.
  const safeFileName = `${sanitizeOutputFileName(fileName)}.output`;
  const outputFile = path.join(projectTempDir, safeFileName);
  try {
    await fs.mkdir(projectTempDir, { recursive: true });
    await fs.writeFile(outputFile, content);

    return {
      content: formatTruncatedContent(truncatedContent, {
        contentLabel,
        outputFile,
      }),
      outputFile,
    };
  } catch (error) {
    return {
      content: formatTruncatedContent(truncatedContent, {
        contentLabel,
        saveFailed: true,
      }),
      saveErrorCode: getErrorCode(error),
      saveErrorMessage: getErrorMessage(error),
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
 */
export async function truncateToolOutput(
  config: Config,
  toolName: string,
  content: string,
  limits?: TruncationLimits,
): Promise<{ content: string; outputFile?: string }> {
  const threshold =
    limits?.threshold ?? config.getTruncateToolOutputThreshold();
  const lines = limits?.lines ?? config.getTruncateToolOutputLines();

  if (threshold <= 0 || lines <= 0) {
    return { content };
  }

  const originalLength = content.length;
  const fileName = `${toolName}_${crypto.randomBytes(6).toString('hex')}`;
  let result: TruncationResult;
  try {
    result = await truncateAndSaveToFile(
      content,
      fileName,
      config.storage.getProjectTempDir(),
      threshold,
      lines,
      limits?.contentLabel,
    );
  } catch (error) {
    const truncatedContent = truncateContentInMemory(content, threshold, lines);
    result =
      truncatedContent === content
        ? { content }
        : {
            content: formatTruncatedContent(truncatedContent, {
              contentLabel: limits?.contentLabel,
              saveFailed: true,
            }),
            saveErrorCode: getErrorCode(error),
            saveErrorMessage: getErrorMessage(error),
          };
  }

  if (result.content !== content) {
    logToolOutputTruncated(
      config,
      new ToolOutputTruncatedEvent('', {
        callId: limits?.callId,
        toolName,
        originalContentLength: originalLength,
        truncatedContentLength: result.content.length,
        threshold,
        lines,
        outputFileSaved: Boolean(result.outputFile),
        saveErrorCode: result.saveErrorCode,
        saveErrorMessage: result.saveErrorMessage,
      }),
    );
  }

  return result;
}
