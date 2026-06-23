/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Part } from '@google/genai';
import {
  MAX_MCP_RESOURCE_BLOB_CHARS,
  MAX_MCP_RESOURCE_TEXT_CHARS,
  formatMcpResourceContents,
  summarizeMcpResource,
} from './mcp-resource-content.js';

const textOf = (parts: Part[]) =>
  parts.map((p) => (p as { text?: string }).text ?? '').join('');

describe('formatMcpResourceContents', () => {
  it('frames text content with attribution delimiters', () => {
    const out = formatMcpResourceContents(
      { contents: [{ uri: 'x://a', text: 'hello' }] },
      'srv:x://a',
    );
    expect(out.truncated).toBe(false);
    expect(out.textChars).toBe(5);
    expect(textOf(out.parts)).toBe(
      '\n--- Content from MCP resource srv:x://a ---\nhello\n--- End of MCP resource srv:x://a ---\n',
    );
  });

  it('caps text at MAX_MCP_RESOURCE_TEXT_CHARS and flags truncation', () => {
    const big = 'a'.repeat(MAX_MCP_RESOURCE_TEXT_CHARS + 100);
    const out = formatMcpResourceContents(
      { contents: [{ uri: 'x://a', text: big }] },
      'srv:x://a',
    );
    expect(out.truncated).toBe(true);
    expect(out.textChars).toBe(MAX_MCP_RESOURCE_TEXT_CHARS);
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
});
