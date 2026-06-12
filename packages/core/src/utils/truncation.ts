/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Part, PartListUnion } from '@google/genai';
import { ReadFileTool } from '../tools/read-file.js';
import type { Config } from '../config/config.js';
import { logToolOutputTruncated } from '../telemetry/loggers.js';
import { ToolOutputTruncatedEvent } from '../telemetry/types.js';

/**
 * Stable prefix every truncated tool output starts with. Used as an
 * idempotency sentinel so content that was already truncated (by a tool's own
 * path — e.g. MCP `truncateTextParts` — or by a prior pass) is not truncated
 * again, which would nest headers and spill a duplicate file.
 */
export const TOOL_OUTPUT_TRUNCATED_PREFIX =
  'Tool output was too large and has been truncated';

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
  keep: 'head' | 'tail' | 'both' = 'both',
): Promise<{ content: string; outputFile?: string }> {
  // Fast path: when no line cap applies (per-tool char budgets pass
  // truncateLines = Infinity) and content is within the char threshold, return
  // early without splitting. read-file (Infinity threshold) and other
  // self-managed tools otherwise allocate a full line array on every call only
  // to reach a guaranteed no-op.
  if (content.length <= threshold && !Number.isFinite(truncateLines)) {
    return { content };
  }

  const lines = content.split('\n');

  // Check both constraints: character threshold and line limit.
  if (content.length <= threshold && lines.length <= truncateLines) {
    return { content };
  }

  // Build head and tail within both line and character budgets. The `keep`
  // direction decides how the line/character budget is split:
  //   - 'both' (default): head 1/5 + tail 4/5 (preserves first & last).
  //   - 'head': all budget to the beginning (mirrors CC's Bash tool).
  //   - 'tail': all budget to the end (mirrors CC's Task tool).
  const effectiveLines = Math.min(truncateLines, lines.length);
  let headCount: number;
  let tailCount: number;
  if (keep === 'head') {
    headCount = effectiveLines;
    tailCount = 0;
  } else if (keep === 'tail') {
    headCount = 0;
    tailCount = effectiveLines;
  } else {
    headCount = Math.max(Math.floor(effectiveLines / 5), 1);
    tailCount = effectiveLines - headCount;
  }
  const separator = '\n\n---\n... [CONTENT TRUNCATED] ...\n---\n\n';
  const ellipsis = '...';

  // Collect head lines within budget. If a single line exceeds the
  // remaining budget, include a truncated slice of it.
  const headBudget =
    keep === 'head'
      ? threshold
      : keep === 'tail'
        ? 0
        : Math.floor(threshold / 5);
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
  const tailBudget =
    keep === 'head' ? 0 : Math.max(threshold - headChars - separator.length, 0);
  const end: string[] = [];
  let tailChars = 0;
  const tailStart = Math.max(lines.length - tailCount, beginning.length);
  for (let i = lines.length - 1; i >= tailStart; i--) {
    const remaining = tailBudget - tailChars;
    if (remaining <= 0) break;
    if (lines[i].length + 1 > remaining) {
      const sliceLen = Math.max(remaining - ellipsis.length, 0);
      // slice(-0) === slice(0) returns the WHOLE line, so guard the zero case
      // explicitly: sliceLen === 0 means no budget for any tail chars (the head
      // branch's slice(0, 0) already yields '' correctly).
      end.unshift(ellipsis + (sliceLen > 0 ? lines[i].slice(-sliceLen) : ''));
      tailChars = tailBudget;
      break;
    }
    end.unshift(lines[i]);
    tailChars += lines[i].length + 1;
  }

  // Compose by direction: head-only ends with the separator (content
  // removed after), tail-only starts with it (content removed before),
  // both keeps the existing head+separator+tail shape.
  const truncatedContent =
    keep === 'head'
      ? beginning.join('\n') + separator
      : keep === 'tail'
        ? separator + end.join('\n')
        : beginning.join('\n') + separator + end.join('\n');

  // Sanitize fileName to prevent path traversal.
  const safeFileName = `${path.basename(fileName)}.output`;
  const outputFile = path.join(projectTempDir, safeFileName);
  const wrappedMessage = `${TOOL_OUTPUT_TRUNCATED_PREFIX}.
The full output has been saved to: ${outputFile}
To read the complete output, use the ${ReadFileTool.Name} tool with the absolute file path above.
The truncated output below shows the beginning and end of the content. The marker '... [CONTENT TRUNCATED] ...' indicates where content was removed.

Truncated part of the output:
${truncatedContent}`;

  // Token-aware fallback: if the wrapped (truncated + instructions) output is
  // not actually smaller than the original, truncating wastes effort and
  // loses recoverability for no benefit — keep the original untouched.
  if (wrappedMessage.length >= content.length) {
    return { content };
  }

  try {
    // Restrictive perms: tool output can contain secrets, and this PR widens
    // persistence to every string-returning tool. The spilled file is created
    // owner-only (0o600). We don't set a mode on the temp dir: it is shared
    // with the logger/checkpoints and is normally created earlier without one,
    // and mkdir would not tighten an already-existing directory anyway.
    await fs.mkdir(projectTempDir, { recursive: true });
    await fs.writeFile(outputFile, content, { mode: 0o600 });

    return {
      content: wrappedMessage,
      outputFile,
    };
  } catch (_error) {
    return {
      content:
        truncatedContent + `\n[Note: Could not save full output to file]`,
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
  limits?: {
    threshold?: number;
    lines?: number;
    keep?: 'head' | 'tail' | 'both';
  },
  promptId?: string,
): Promise<{ content: string; outputFile?: string }> {
  // Per-call `limits` override the global config thresholds. Used for
  // per-tool budgets (maxOutputChars) and the combined second-pass that runs
  // a 2x budget after hook/reminder metadata is appended.
  const threshold =
    limits?.threshold ?? config.getTruncateToolOutputThreshold();
  const lines = limits?.lines ?? config.getTruncateToolOutputLines();
  const keep = limits?.keep ?? 'both';

  if (threshold <= 0 || lines <= 0) {
    return { content };
  }

  // Fast path: when no line cap applies (char-only budgets pass lines:Infinity)
  // and content is within the char threshold, there is nothing to spill —
  // return before resolving the temp dir, so callers that never truncate (e.g.
  // small MCP outputs) don't require storage to be configured.
  if (content.length <= threshold && !Number.isFinite(lines)) {
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
    keep,
  );

  if (result.outputFile) {
    try {
      logToolOutputTruncated(
        config,
        new ToolOutputTruncatedEvent(promptId ?? '', {
          toolName,
          originalContentLength: originalLength,
          truncatedContentLength: result.content.length,
          threshold,
          lines,
        }),
      );
    } catch {
      // Telemetry must never break a successful truncation.
    }
  }

  return result;
}

/**
 * Unified truncation entry for the tool scheduler. Handles both string and
 * Part[] `llmContent`:
 *   - string is truncated directly;
 *   - Part[] has its text parts merged and truncated, while media parts
 *     (inlineData/fileData) are preserved verbatim;
 *   - empty output is replaced with a no-output marker;
 *   - already-truncated content passes through unchanged (idempotent).
 */
export async function truncateLlmContent(
  config: Config,
  toolName: string,
  content: PartListUnion,
  limits?: {
    threshold?: number;
    lines?: number;
    keep?: 'head' | 'tail' | 'both';
  },
  promptId?: string,
): Promise<{ content: PartListUnion; outputFile?: string }> {
  // --- string path ---
  if (typeof content === 'string') {
    if (content.trim() === '') {
      return { content: `(${toolName} completed with no output)` };
    }
    // Idempotency: a genuine truncation prefix sits at position 0. Use
    // startsWith (not includes) so a tool whose own output merely contains the
    // phrase mid-stream is still bounded rather than passing through unbounded.
    if (content.startsWith(TOOL_OUTPUT_TRUNCATED_PREFIX)) {
      return { content };
    }
    return truncateToolOutput(config, toolName, content, limits, promptId);
  }

  // --- Part[] / single Part path ---
  const parts: Part[] = (Array.isArray(content) ? content : [content]).map(
    (p) => (typeof p === 'string' ? ({ text: p } as Part) : p),
  );
  const textParts = parts.filter((p) => p.text !== undefined);
  const mediaParts = parts.filter((p) => p.text === undefined);
  const combined = textParts.map((p) => p.text).join('\n');

  if (combined.trim() === '' && mediaParts.length === 0) {
    return { content: `(${toolName} completed with no output)` };
  }
  // Idempotency, mirroring the string path: a part counts as already-truncated
  // only if it STARTS with the sentinel (MCP's truncateTextParts emits such a
  // part). Checking each part's prefix — not `combined.includes` — preserves
  // the multi-part dedup intent while preventing a part that merely contains
  // the phrase mid-stream from bypassing the budget.
  if (textParts.some((p) => p.text?.startsWith(TOOL_OUTPUT_TRUNCATED_PREFIX))) {
    return { content };
  }

  const result = await truncateToolOutput(
    config,
    toolName,
    combined,
    limits,
    promptId,
  );

  // Unchanged (within budget or token-aware fallback): leave the original
  // Part[] untouched so part structure and ordering are preserved. Compare
  // content identity rather than `outputFile` so a truncated-but-unsaved
  // result (a disk-write failure returns a bounded preview with no file) still
  // bounds the output, matching the string path.
  if (result.content === combined) {
    return { content };
  }

  // Truncated: collapse text into a single truncated part, then re-append the
  // preserved media parts.
  return {
    content: [{ text: result.content } as Part, ...mediaParts],
    outputFile: result.outputFile,
  };
}
