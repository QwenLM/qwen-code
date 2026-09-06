/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies the OpenTUI compaction notice reproduces the ink
 * CompressionMessage texts exactly: pending spinner text, compressed token
 * counts, the two inflated-token branches around the 50k boundary, the
 * token-counting error, NOOP, and the pending/settled color + marker view.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

import { CompressionStatus } from '@qwen-code/qwen-code-core';
import { compactionText, compactionView } from './session-compaction.js';
import { C } from './theme.js';
import type { CompactionViewProps } from './session-compaction.js';

function props(
  overrides: Partial<CompactionViewProps> = {},
): CompactionViewProps {
  return {
    isPending: false,
    originalTokenCount: 1000,
    newTokenCount: 200,
    compressionStatus: CompressionStatus.COMPRESSED,
    ...overrides,
  };
}

describe('session-compaction texts (CompressionMessage parity)', () => {
  it('shows the pending text while compressing', () => {
    expect(compactionText(props({ isPending: true }))).toBe(
      'Compressing chat history',
    );
  });

  it('reports the compressed token counts', () => {
    expect(
      compactionText(props({ originalTokenCount: 12000, newTokenCount: 3000 })),
    ).toBe('Chat history compressed from 12000 to 3000 tokens.');
  });

  it('defaults missing token counts to zero', () => {
    expect(
      compactionText(props({ originalTokenCount: null, newTokenCount: null })),
    ).toBe('Chat history compressed from 0 to 0 tokens.');
  });

  it('reports "not beneficial" for small inflated histories', () => {
    expect(
      compactionText(
        props({
          originalTokenCount: 49999,
          compressionStatus:
            CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT,
        }),
      ),
    ).toBe('Compression was not beneficial for this history size.');
  });

  it('reports the prompt issue for large inflated histories', () => {
    expect(
      compactionText(
        props({
          originalTokenCount: 50000,
          compressionStatus:
            CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT,
        }),
      ),
    ).toBe(
      'Chat history compression did not reduce size. This may indicate issues with the compression prompt.',
    );
  });

  it('reports the token counting error', () => {
    expect(
      compactionText(
        props({
          compressionStatus:
            CompressionStatus.COMPRESSION_FAILED_TOKEN_COUNT_ERROR,
        }),
      ),
    ).toBe('Could not compress chat history due to a token counting error.');
  });

  it('reports NOOP', () => {
    expect(
      compactionText(props({ compressionStatus: CompressionStatus.NOOP })),
    ).toBe('Nothing to compress.');
  });

  it('reports the empty summary failure', () => {
    expect(
      compactionText(
        props({
          compressionStatus: CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY,
        }),
      ),
    ).toBe(
      'Could not compress chat history because the compression summary was empty.',
    );
  });

  it('reports the truncated output failure', () => {
    expect(
      compactionText(
        props({
          compressionStatus:
            CompressionStatus.COMPRESSION_FAILED_OUTPUT_TRUNCATED,
        }),
      ),
    ).toBe(
      'Could not compress chat history because the compression summary was truncated.',
    );
  });

  it('reports the API error failure', () => {
    expect(
      compactionText(
        props({
          compressionStatus: CompressionStatus.COMPRESSION_FAILED_API_ERROR,
        }),
      ),
    ).toBe('Could not compress chat history due to an API error.');
  });

  it('returns an empty text for null', () => {
    expect(compactionText(props({ compressionStatus: null }))).toBe('');
  });
});

describe('session-compaction view model', () => {
  it('uses the accent color and spinner state while pending', () => {
    const view = compactionView(props({ isPending: true }));
    expect(view.pending).toBe(true);
    expect(view.color).toBe(C.accent);
  });

  it('switches to the success color and diamond marker once settled', () => {
    const view = compactionView(props());
    expect(view.pending).toBe(false);
    expect(view.color).toBe(C.green);
    expect(view.marker).toBe('diamond');
    expect(view.iconGlyph.length).toBeGreaterThan(0);
    expect(view.text).toContain('compressed');
  });
});
