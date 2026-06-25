/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
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
  /** Total base64 blob chars actually injected (after capping). */
  blobChars: number;
  /** True when any text/blob content was dropped or sliced by a cap. */
  truncated: boolean;
}

/** Options for {@link formatMcpResourceContents}. */
export interface FormatMcpResourceOptions {
  /**
   * Max cumulative base64 blob chars this call may inject. Defaults to
   * {@link MAX_MCP_RESOURCE_BLOB_CHARS}. The `read_mcp_resource` tool lowers
   * this to the remaining per-turn budget so many parallel calls can't inject
   * an unbounded total (see its per-turn blob budget).
   */
  maxBlobChars?: number;
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
 * `parts` are wrapped in `--- Content from MCP resource <label> [<nonce>] ---
 * ... --- End of MCP resource <label> [<nonce>] ---` delimiters, which bound
 * the model's view of untrusted server content. The per-call random `<nonce>`
 * makes the closing marker unforgeable: a hostile server cannot embed a fake
 * `--- End of MCP resource <label> ---` in its own content to smuggle text out
 * of the frame, since it cannot predict the nonce.
 */
export function formatMcpResourceContents(
  result: ReadResourceResult,
  label: string,
  opts?: FormatMcpResourceOptions,
): FormattedMcpResource {
  const maxBlobChars = opts?.maxBlobChars ?? MAX_MCP_RESOURCE_BLOB_CHARS;
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
      if (blobChars + content.blob.length > maxBlobChars) {
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

  // Per-call nonce so the closing delimiter can't be forged by server content.
  const nonce = randomUUID().slice(0, 8);
  // Generic on purpose: `truncated` is set by EITHER the text cap or a skipped
  // blob, so don't claim a specific char count that may not apply.
  const truncationNotice = truncated
    ? `\n[Content truncated — part of this resource exceeded size limits and was omitted.]`
    : '';
  const parts: Part[] =
    contentParts.length > 0
      ? [
          { text: `\n--- Content from MCP resource ${label} [${nonce}] ---\n` },
          ...contentParts,
          {
            text: `${truncationNotice}\n--- End of MCP resource ${label} [${nonce}] ---\n`,
          },
        ]
      : [];

  return { parts, textChars, blobCount, blobChars, truncated };
}

/**
 * Model-facing diagnostic injected when a read produced no content parts, so
 * the `@` path and the `read_mcp_resource` tool surface the same attributed
 * explanation instead of diverging (the `@` path would otherwise inject nothing
 * and leave a dangling `@server:uri` reference with no content).
 */
export function emptyMcpResourceText(
  formatted: FormattedMcpResource,
  label: string,
): string {
  return `\n--- MCP resource ${label}: ${summarizeMcpResource(formatted)} ---\n`;
}

/**
 * One-line summary of what a formatted read actually injected. Used as the `@`
 * resource card's `resultDisplay`, the `read_mcp_resource` tool's
 * `returnDisplay`, and — when no content parts were produced — as the seed of
 * its `llmContent` fallback (see {@link emptyMcpResourceText}), so a success
 * state never hides an empty/truncated read. Keep it display-and-model safe:
 * no ANSI color or markup that would corrupt `llmContent`.
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
