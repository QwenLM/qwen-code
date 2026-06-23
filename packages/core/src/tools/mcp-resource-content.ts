/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Cap injected resource text so a misbehaving/hostile MCP server can't blow the
 * context window (files are capped by readManyFiles; resource content was
 * previously uncapped).
 */
export const MAX_MCP_RESOURCE_TEXT_CHARS = 100_000;

/** Cap CUMULATIVE base64 blob payload per resource (~6 MB binary). */
export const MAX_MCP_RESOURCE_BLOB_CHARS = 8_000_000; // ~6 MB binary as base64

export interface FormattedMcpResource {
  /**
   * Content parts framed with attribution delimiters, or `[]` when the read
   * yielded no text/blob content. Inject (or return as `llmContent`) verbatim.
   */
  parts: Part[];
  /** Total text chars actually injected (after capping). */
  textChars: number;
  /** Number of blob attachments actually injected (after capping). */
  blobCount: number;
  /** True when any text/blob content was dropped or sliced by a cap. */
  truncated: boolean;
}

/**
 * Turn a raw MCP `resources/read` result into model-ready parts. Shared by the
 * `@server:uri` injection path and the `read_mcp_resource` tool so the two
 * can't drift.
 *
 * Text is capped at {@link MAX_MCP_RESOURCE_TEXT_CHARS}, cumulative blob payload
 * at {@link MAX_MCP_RESOURCE_BLOB_CHARS} (a server returning many sub-limit
 * blobs in one response could otherwise still inject unbounded data); blobs
 * become `inlineData` media parts rather than raw base64 text. The returned
 * `parts` are wrapped in `--- Content from MCP resource <label> --- ... --- End
 * of MCP resource <label> ---` delimiters, which both bound the model's view of
 * untrusted server content and give it a clear boundary between the user's
 * prompt and server-supplied content.
 */
export function formatMcpResourceContents(
  result: ReadResourceResult,
  label: string,
): FormattedMcpResource {
  const contentParts: Part[] = [];
  let textChars = 0;
  let blobChars = 0;
  let blobCount = 0;
  let truncated = false;

  for (const content of result.contents ?? []) {
    if ('text' in content && typeof content.text === 'string') {
      const remaining = MAX_MCP_RESOURCE_TEXT_CHARS - textChars;
      if (remaining <= 0) {
        truncated = content.text.length > 0 || truncated;
        continue;
      }
      const text =
        content.text.length > remaining
          ? content.text.slice(0, remaining)
          : content.text;
      if (text.length < content.text.length) {
        truncated = true;
      }
      if (text.length > 0) {
        contentParts.push({ text });
        textChars += text.length;
      }
    } else if ('blob' in content && typeof content.blob === 'string') {
      if (blobChars + content.blob.length > MAX_MCP_RESOURCE_BLOB_CHARS) {
        truncated = true;
        continue;
      }
      blobChars += content.blob.length;
      contentParts.push({
        inlineData: {
          mimeType:
            typeof content.mimeType === 'string'
              ? content.mimeType
              : 'application/octet-stream',
          data: content.blob,
        },
      });
      blobCount += 1;
    }
  }

  const parts: Part[] =
    contentParts.length > 0
      ? [
          { text: `\n--- Content from MCP resource ${label} ---\n` },
          ...contentParts,
          { text: `\n--- End of MCP resource ${label} ---\n` },
        ]
      : [];

  return { parts, textChars, blobCount, truncated };
}

/**
 * One-line summary of what a formatted read actually injected, shared by the
 * `@` resource tool-card and the `read_mcp_resource` tool's `returnDisplay`, so
 * a success state never hides an empty/truncated read.
 */
export function summarizeMcpResource(formatted: FormattedMcpResource): string {
  const { textChars, blobCount, truncated } = formatted;
  const summary: string[] = [];
  if (textChars > 0) {
    summary.push(`${textChars} chars`);
  }
  if (blobCount > 0) {
    summary.push(`${blobCount} attachment${blobCount === 1 ? '' : 's'}`);
  }
  if (summary.length > 0) {
    return `Injected ${summary.join(' + ')}${truncated ? ' (truncated)' : ''}`;
  }
  return truncated ? '(content too large — skipped)' : '(no readable content)';
}
