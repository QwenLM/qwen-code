/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Part } from '@google/genai';
import { ToolErrorType } from '../tool-error.js';
import type { NodeReplExecOutcome } from './kernel-manager.js';
import {
  convertOutcomeToToolResult,
  MAX_MODEL_TEXT_CHARS,
  MAX_MODEL_TEXT_TOKENS,
} from './result-converter.js';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const JPEG_HEADER_BASE64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]).toString(
  'base64',
);

function outcome(
  partial: Partial<NodeReplExecOutcome> = {},
): NodeReplExecOutcome {
  return {
    status: 'ok',
    events: [],
    rawTextTruncated: false,
    imagesDropped: 0,
    stats: {
      durationMs: 1,
      generation: 1,
      pid: 123,
      droppedStaleFrames: 0,
      kernelReplaced: false,
      rawTextBytes: 0,
      imageCount: 0,
    },
    ...partial,
  };
}

describe('convertOutcomeToToolResult', () => {
  it('renders ordered text events and prefixes warning streams', () => {
    const result = convertOutcomeToToolResult(
      outcome({
        events: [
          { type: 'text', kind: 'write', text: 'plain' },
          { type: 'text', kind: 'console', level: 'log', text: 'logged' },
          { type: 'text', kind: 'console', level: 'warn', text: 'careful' },
          { type: 'text', kind: 'stderr', text: 'raw' },
          { type: 'text', kind: 'result', text: 'done' },
        ],
      }),
    );
    expect(result.llmContent).toBe(
      'plain\nlogged\n[warn] careful\n[stderr] raw\ndone\n',
    );
    expect(result.error).toBeUndefined();
  });

  it('returns the no-output hint for a silent successful execution', () => {
    const result = convertOutcomeToToolResult(outcome());
    expect(result.llmContent).toBe('(no output)\n');
    expect(result.returnDisplay).toBe('(no output)');
  });

  it('truncates only model-facing text near 10k estimated tokens', () => {
    const result = convertOutcomeToToolResult(
      outcome({
        events: [
          {
            type: 'text',
            kind: 'write',
            text: 'x'.repeat(MAX_MODEL_TEXT_CHARS + 1000),
          },
        ],
      }),
    );
    const text = result.llmContent as string;
    expect(text.length).toBeLessThanOrEqual(MAX_MODEL_TEXT_CHARS);
    expect(text).toMatch(/^x+/);
    expect(text).toContain(
      `[node_repl text truncated near ${MAX_MODEL_TEXT_TOKENS} estimated tokens]`,
    );
  });

  it('preserves all valid images and their order after text truncation', () => {
    const events: NodeReplExecOutcome['events'] = [
      {
        type: 'text',
        kind: 'write',
        text: 'x'.repeat(MAX_MODEL_TEXT_CHARS + 1),
      },
    ];
    for (let index = 0; index < 20; index++) {
      events.push({ type: 'image', data: PNG_BASE64, mimeType: 'image/png' });
      events.push({
        type: 'text',
        kind: 'write',
        text: `after-${index}`,
      });
    }
    const result = convertOutcomeToToolResult(outcome({ events }));
    const parts = result.llmContent as Part[];
    expect(parts.filter((part) => part.inlineData !== undefined)).toHaveLength(
      20,
    );
    expect(
      parts
        .filter((part) => part.inlineData !== undefined)
        .every((part) => part.inlineData?.data === PNG_BASE64),
    ).toBe(true);
    expect(parts.at(-1)?.text).toContain('text truncated');
    expect(result.returnDisplay).toContain('[20 image(s)]');
  });

  it('rejects MIME mismatches, unsupported formats, and empty payloads', () => {
    const mismatch = convertOutcomeToToolResult(
      outcome({
        events: [
          { type: 'image', data: JPEG_HEADER_BASE64, mimeType: 'image/png' },
        ],
      }),
    );
    expect(mismatch.llmContent as string).toMatch(/declared image\/png/);

    const unsupported = convertOutcomeToToolResult(
      outcome({
        events: [
          { type: 'image', data: PNG_BASE64, mimeType: 'image/svg+xml' },
        ],
      }),
    );
    expect(unsupported.llmContent as string).toMatch(/unsupported image MIME/);

    const empty = convertOutcomeToToolResult(
      outcome({
        events: [{ type: 'image', data: '', mimeType: 'image/png' }],
      }),
    );
    expect(empty.llmContent as string).toMatch(/invalid base64 image payload/);
  });

  it('reports raw sanity-limit truncation and image drops', () => {
    const result = convertOutcomeToToolResult(
      outcome({ rawTextTruncated: true, imagesDropped: 3 }),
    );
    expect(result.llmContent as string).toContain('text truncated');
    expect(result.llmContent as string).toContain(
      '3 image(s) dropped by the raw sanity limit',
    );
  });

  it('serializes response metadata without adding automatic heap fields', () => {
    const result = convertOutcomeToToolResult(
      outcome({ responseMeta: { rows: 42 } }),
    );
    expect(result.llmContent).toBe('[responseMeta] {"rows":42}\n');
    expect(result.llmContent as string).not.toMatch(/heap|rss/i);
  });

  it('maps runtime failures to EXECUTION_FAILED with partial output', () => {
    const result = convertOutcomeToToolResult(
      outcome({
        status: 'error',
        events: [{ type: 'text', kind: 'write', text: 'before the failure' }],
        error: {
          name: 'TypeError',
          message: 'x is not a function',
          stack: 'TypeError: x is not a function\n  at <anonymous>',
        },
      }),
    );
    expect(result.error?.type).toBe(ToolErrorType.EXECUTION_FAILED);
    expect(result.llmContent as string).toContain('before the failure');
    expect(result.llmContent as string).toContain(
      'TypeError: x is not a function',
    );
    expect(result.returnDisplay).toMatch(/^Error \(error\):/);
  });

  it('maps timeout to EXECUTION_TIMEOUT and bounds hostile error text', () => {
    const result = convertOutcomeToToolResult(
      outcome({
        status: 'timeout',
        error: {
          name: 'TimeoutError',
          message: 'x'.repeat(100_000),
        },
      }),
    );
    expect(result.error?.type).toBe(ToolErrorType.EXECUTION_TIMEOUT);
    expect(result.error?.message.length).toBeLessThan(20_000);
    expect(result.returnDisplay).toMatch(/^Error \(timeout\):/);
  });

  it('keeps the complete model-facing text within the shared budget', () => {
    const result = convertOutcomeToToolResult(
      outcome({
        status: 'error',
        events: [
          {
            type: 'text',
            kind: 'write',
            text: 'x'.repeat(MAX_MODEL_TEXT_CHARS * 2),
          },
        ],
        responseMeta: { detail: 'm'.repeat(MAX_MODEL_TEXT_CHARS) },
        error: {
          name: 'RangeError',
          message: 'e'.repeat(MAX_MODEL_TEXT_CHARS),
          stack: 's'.repeat(MAX_MODEL_TEXT_CHARS),
        },
      }),
    );
    const text =
      typeof result.llmContent === 'string'
        ? result.llmContent
        : (result.llmContent as Part[]).map((part) => part.text ?? '').join('');
    expect(text.length).toBeLessThanOrEqual(MAX_MODEL_TEXT_CHARS);
    expect(text).toContain('text truncated');
    expect(text).toContain('[responseMeta]');
    expect(text).toContain('RangeError:');
  });
});
