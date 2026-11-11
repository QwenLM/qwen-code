/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import { runLogger } from '../utils/runLogger.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import {
  readBrandEnv,
  ENV_MAX_MCP_OUTPUT_TOKENS,
  BRAND_CLI_SLUG,
} from '../config/brand.js';
import { READ_FILE_TOOL_NAME } from '../tools/tool-names.js';

/**
 * Default maximum token count for MCP tool output.
 * Can be overridden via ENV_MAX_MCP_OUTPUT_TOKENS env var.
 */
const DEFAULT_MAX_MCP_OUTPUT_TOKENS = 25000;

/**
 * Approximate ratio of characters to tokens for estimation.
 * Used for the fast "skip" heuristic: if estimated tokens are below
 * 50% of the threshold, we skip the more expensive precise count.
 *
 * Conservative estimate: ~4 chars per token for English/code,
 * ~1.5 chars per token for CJK/compressed text. We use 3 as a
 * balanced middle ground.
 */
const CHARS_PER_TOKEN_ESTIMATE = 3;

/**
 * Threshold multiplier for the fast skip heuristic.
 * If estimated tokens < maxTokens * SKIP_THRESHOLD_RATIO, skip precise counting.
 */
const SKIP_THRESHOLD_RATIO = 0.5;

/**
 * Maximum size of the preview snippet sent to the model when output is truncated.
 * The model receives this preview plus a file path to read the full content.
 */
const PREVIEW_BYTES = 2000;

/**
 * Above this size, reflowing costs a full parse plus an inflated copy while the
 * model could never read the result line by line anyway.
 */
const REFLOW_MAX_CHARS = 4 * 1024 * 1024;

export interface McpTextOutputValidationResult {
  parts: Part[];
  truncated: boolean;
}

/**
 * Directory for persisting full MCP output when truncation occurs. Callers pass
 * the session-scoped spill dir so the persisted path stays inside the project
 * temp dir that tool path validation allows; the tmpdir fallback only serves
 * contexts without a session.
 */
function ensureOutputDir(baseDir?: string): string {
  const dir = baseDir ?? path.join(os.tmpdir(), `${BRAND_CLI_SLUG.split('-')[0]}-mcp-outputs`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Reflow a single-line JSON payload into indented, line-readable form.
 *
 * Read slices by line and truncates any line past its per-line cap, so a
 * one-line blob loses everything after that cap. Skipped above
 * REFLOW_MAX_CHARS, where parsing costs more than line reads can repay.
 */
function reflowJsonForLineReads(text: string): string {
  const trimmed = text.trim();
  if (trimmed.includes('\n') || trimmed.length > REFLOW_MAX_CHARS) {
    return text;
  }
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return text;
  }
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

/**
 * Persists the full text content to disk so the model can read it later.
 * Returns the file path where content was saved.
 */
function persistFullOutput(
  fullText: string,
  serverName: string,
  toolName: string,
  baseDir?: string,
): string {
  const hash = crypto
    .createHash('sha256')
    .update(fullText)
    .digest('hex')
    .slice(0, 12);
  const safeName = `${serverName}_${toolName}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  const filename = `${safeName}_${hash}.txt`;
  const filePath = path.join(ensureOutputDir(baseDir), filename);

  try {
    fs.writeFileSync(filePath, fullText, 'utf-8');
    runLogger.debug(`Persisted full MCP output to: ${filePath}`);
  } catch (err) {
    runLogger.warn(`Failed to persist MCP output: ${String(err)}`);
  }

  return filePath;
}

/**
 * Gets the configured maximum MCP output token limit.
 */
export function getMaxMcpOutputTokens(): number {
  const envValue = readBrandEnv(ENV_MAX_MCP_OUTPUT_TOKENS);
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_MAX_MCP_OUTPUT_TOKENS;
}

/**
 * Estimates the token count for a string using character-based heuristic.
 * This is intentionally conservative (overestimates) to avoid missing
 * cases that need truncation.
 */
function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE);
}

/**
 * Estimates total token count across all text Parts.
 */
function estimateTextPartsTokens(parts: Part[]): number {
  let total = 0;
  for (const part of parts) {
    if (typeof part.text === 'string') {
      total += estimateTokenCount(part.text);
    }
  }
  return total;
}

/**
 * Validates and optionally truncates MCP output Parts to stay within the
 * configured text token budget. Non-text Parts do not count toward the text
 * budget and remain in their original positions.
 *
 * Strategy:
 * 1. Fast path: estimate total tokens; if well below threshold, return as-is.
 * 2. If over budget, persist full text to disk and return a small preview
 *    with the file path and reading instructions so the model can access
 *    the full content via Read. Mixed text/media results retain their original
 *    interleaving while text is reduced to the preview budget.
 *
 * Design: persist full output → return file path + preview + instructions
 * for chunked reading. The model uses Read with offset/limit to
 * access specific portions of the saved file.
 *
 * @param parts The transformed text and image Parts from MCP tool output.
 * @param serverName The MCP server name (for logging).
 * @param toolName The tool name (for logging).
 * @returns The (possibly truncated) Parts array.
 */
export function validateAndTruncateMcpTextOutputWithResult(
  parts: Part[],
  serverName: string,
  toolName: string,
  spillDir?: string,
): McpTextOutputValidationResult {
  if (parts.length === 0) {
    return { parts, truncated: false };
  }

  const maxTokens = getMaxMcpOutputTokens();
  const estimatedTokens = estimateTextPartsTokens(parts);

  // Fast path: if estimated tokens are well below threshold, skip truncation
  if (estimatedTokens < maxTokens * SKIP_THRESHOLD_RATIO) {
    return { parts, truncated: false };
  }

  // If estimated tokens are within budget, return as-is
  if (estimatedTokens <= maxTokens) {
    return { parts, truncated: false };
  }

  // Over budget — need to truncate
  runLogger.log(
    `MCP output from '${serverName}/${toolName}' exceeds token budget ` +
      `(estimated ${estimatedTokens} > ${maxTokens}). Truncating.`,
  );

  // 1. Collect all text from Parts for persistence
  const fullTextPieces: string[] = [];
  for (const part of parts) {
    if (typeof part.text === 'string') {
      fullTextPieces.push(reflowJsonForLineReads(part.text));
    }
  }
  const fullText = fullTextPieces.join('\n');

  // 2. Persist full output to disk so the model can read it via Read
  const outputFile = persistFullOutput(
    fullText,
    serverName,
    toolName,
    spillDir,
  );

  // 3. Build preview + instructions for the model
  const preview = fullText.slice(0, PREVIEW_BYTES);
  const previewTruncated = preview.length < fullText.length;
  // Describe the persisted file the model will read, not the pre-reflow text.
  const persistedTokens = estimateTokenCount(fullText);
  const truncationNotice =
    `[OUTPUT TRUNCATED - MCP tool '${toolName}' from server '${serverName}' ` +
    `produced ~${persistedTokens} tokens (${fullText.length.toLocaleString()} characters), ` +
    `exceeding the ${maxTokens} token limit]\n\n` +
    `Full output has been saved to: ${outputFile}\n\n` +
    `Use the ${READ_FILE_TOOL_NAME} tool with offset and limit parameters to read ` +
    `specific portions of the file. If the MCP server provides pagination ` +
    `or filtering tools, prefer using those to retrieve targeted data.\n\n`;

  const instructions =
    truncationNotice +
    `Preview (first ${PREVIEW_BYTES.toLocaleString()} bytes):\n` +
    `${preview}` +
    (previewTruncated ? '\n...' : '');

  const containsNonTextParts = parts.some(
    (part) => typeof part.text !== 'string',
  );
  if (containsNonTextParts) {
    const interleavedPreview: Part[] = [];
    let remainingPreviewChars = PREVIEW_BYTES;

    for (const part of parts) {
      if (typeof part.text !== 'string') {
        interleavedPreview.push(part);
        continue;
      }
      if (remainingPreviewChars <= 0 || part.text.length === 0) {
        continue;
      }

      const previewText = part.text.slice(0, remainingPreviewChars);
      interleavedPreview.push({ ...part, text: previewText });
      remainingPreviewChars -= previewText.length;
    }

    interleavedPreview.push({
      text:
        truncationNotice +
        `The text blocks above contain the first ${PREVIEW_BYTES.toLocaleString()} characters ` +
        `in their original positions; image positions are preserved.`,
    });
    return { parts: interleavedPreview, truncated: true };
  }

  return { parts: [{ text: instructions }], truncated: true };
}

export function validateAndTruncateMcpTextOutput(
  parts: Part[],
  serverName: string,
  toolName: string,
  spillDir?: string,
): Part[] {
  return validateAndTruncateMcpTextOutputWithResult(
    parts,
    serverName,
    toolName,
    spillDir,
  ).parts;
}
