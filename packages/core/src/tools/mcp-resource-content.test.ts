/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Part } from '@google/genai';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import {
  MAX_MCP_RESOURCE_BLOB_CHARS,
  MAX_MCP_RESOURCE_TEXT_CHARS,
  formatMcpResourceContents,
  summarizeMcpResource,
} from './mcp-resource-content.js';

const textOf = (parts: Part[]) =>
  parts.map((p) => (p as { text?: string }).text ?? '').join('');

const noncesOf = (joined: string) =>
  [...joined.matchAll(/\[([0-9a-f]{8})\]/g)].map((m) => m[1]);

describe('formatMcpResourceContents', () => {
  it('frames text content with nonce-attributed delimiters', () => {
    const out = formatMcpResourceContents(
      { contents: [{ uri: 'x://a', text: 'hello' }] },
      'srv:x://a',
    );
    expect(out.truncated).toBe(false);
    expect(out.textChars).toBe(5);
    const joined = textOf(out.parts);
    expect(joined).toContain('--- Content from MCP resource srv:x://a [');
    expect(joined).toContain('hello');
    expect(joined).toContain('--- End of MCP resource srv:x://a [');
    // The same per-call nonce appears in both delimiters and is unforgeable by
    // server content (it can't predict the random value).
    const nonces = noncesOf(joined);
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).toBe(nonces[1]);
  });

  it('caps text at MAX_MCP_RESOURCE_TEXT_CHARS and flags truncation', () => {
    const big = 'a'.repeat(MAX_MCP_RESOURCE_TEXT_CHARS + 100);
    const out = formatMcpResourceContents(
      { contents: [{ uri: 'x://a', text: big }] },
      'srv:x://a',
    );
    expect(out.truncated).toBe(true);
    expect(out.textChars).toBe(MAX_MCP_RESOURCE_TEXT_CHARS);
    // The closing delimiter carries a truncation notice so the model knows the
    // content is incomplete despite seeing an "End of MCP resource" marker.
    expect(textOf(out.parts)).toContain('[Content truncated');
  });

  it('does not flag truncation when text is exactly at the cap', () => {
    const exact = 'a'.repeat(MAX_MCP_RESOURCE_TEXT_CHARS);
    const out = formatMcpResourceContents(
      { contents: [{ uri: 'x://a', text: exact }] },
      'srv',
    );
    expect(out.truncated).toBe(false);
    expect(out.textChars).toBe(MAX_MCP_RESOURCE_TEXT_CHARS);
    expect(textOf(out.parts)).not.toContain('[Content truncated');
  });

  it('accumulates text chars across items and caps cumulatively', () => {
    const half = Math.ceil(MAX_MCP_RESOURCE_TEXT_CHARS / 2) + 100;
    const out = formatMcpResourceContents(
      {
        contents: [
          { uri: 'x://1', text: 'a'.repeat(half) },
          { uri: 'x://2', text: 'b'.repeat(half) },
        ],
      },
      'srv',
    );
    expect(out.textChars).toBe(MAX_MCP_RESOURCE_TEXT_CHARS);
    expect(out.truncated).toBe(true);
  });

  it('skips blobs once the cumulative cap is exceeded', () => {
    const half = Math.ceil(MAX_MCP_RESOURCE_BLOB_CHARS / 2) + 1;
    const blob = 'b'.repeat(half);
    const out = formatMcpResourceContents(
      {
        contents: [
          { uri: 'x://1', blob, mimeType: 'image/png' },
          { uri: 'x://2', blob, mimeType: 'image/png' }, // pushes over the cap
        ],
      },
      'srv',
    );
    // Only the first blob fits.
    expect(out.blobCount).toBe(1);
    expect(out.truncated).toBe(true);
    const inline = out.parts.filter((p) => 'inlineData' in (p as object));
    expect(inline).toHaveLength(1);
  });

  it('returns no parts for a read with no text/blob content', () => {
    const out = formatMcpResourceContents({ contents: [] }, 'srv');
    expect(out.parts).toEqual([]);
    expect(summarizeMcpResource(out)).toBe('(no readable content)');
  });

  it('summarizes injected text and attachments', () => {
    const out = formatMcpResourceContents(
      {
        contents: [
          { uri: 'x://t', text: 'hi' },
          { uri: 'x://b', blob: 'aGk=', mimeType: 'image/png' },
        ],
      },
      'srv',
    );
    expect(summarizeMcpResource(out)).toBe('Injected 2 chars + 1 attachment');
  });

  it('pluralizes the attachment count in the summary', () => {
    const out = formatMcpResourceContents(
      {
        contents: [
          { uri: 'x://1', blob: 'aGk=', mimeType: 'image/png' },
          { uri: 'x://2', blob: 'aGk=', mimeType: 'image/png' },
        ],
      },
      'srv',
    );
    expect(out.blobCount).toBe(2);
    expect(summarizeMcpResource(out)).toBe('Injected 2 attachments');
  });

  it('defaults to application/octet-stream when a blob has no mimeType', () => {
    const out = formatMcpResourceContents(
      { contents: [{ uri: 'x://b', blob: 'aGk=' }] },
      'srv',
    );
    const inline = out.parts.find((p) => 'inlineData' in (p as object)) as {
      inlineData?: { mimeType: string; data: string };
    };
    expect(inline?.inlineData?.mimeType).toBe('application/octet-stream');
  });

  it('silently skips content items that are neither text nor blob', () => {
    // A resource link / metadata entry: no `text`, no `blob`. The SDK type
    // requires one of them, so cast to model the wire-level shape we defend
    // against.
    const out = formatMcpResourceContents(
      { contents: [{ uri: 'x://link' }] } as unknown as ReadResourceResult,
      'srv',
    );
    expect(out.parts).toEqual([]);
    expect(out.truncated).toBe(false);
    expect(summarizeMcpResource(out)).toBe('(no readable content)');
  });

  it('summarizes as "(content too large — skipped)" when only a blob exceeded the cap', () => {
    const out = formatMcpResourceContents(
      {
        contents: [
          {
            uri: 'x://b',
            blob: 'A'.repeat(MAX_MCP_RESOURCE_BLOB_CHARS + 1),
            mimeType: 'image/png',
          },
        ],
      },
      'srv',
    );
    expect(out.blobCount).toBe(0);
    expect(out.blobChars).toBe(0);
    expect(out.truncated).toBe(true);
    expect(summarizeMcpResource(out)).toBe('(content too large — skipped)');
  });

  it('reports blobChars for injected blobs', () => {
    const out = formatMcpResourceContents(
      { contents: [{ uri: 'x://b', blob: 'aGk=', mimeType: 'image/png' }] },
      'srv',
    );
    expect(out.blobChars).toBe(4); // 'aGk=' is 4 base64 chars
  });

  it('honors the maxBlobChars budget and skips blobs over it', () => {
    const out = formatMcpResourceContents(
      {
        contents: [
          { uri: 'x://b', blob: 'b'.repeat(100), mimeType: 'image/png' },
        ],
      },
      'srv',
      { maxBlobChars: 50 },
    );
    expect(out.blobCount).toBe(0);
    expect(out.blobChars).toBe(0);
    expect(out.truncated).toBe(true);
  });
});
