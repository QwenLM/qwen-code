/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  convertOutcomeToMcpResult,
  MAX_MODEL_TEXT_TOKENS,
} from './output-adapter.js';
import {
  estimateTextTokenUnits,
  TOKEN_ESTIMATE_UNITS_PER_TOKEN,
} from './tokenizer.js';
import type { NodeReplExecOutcome } from './kernel-manager.js';

// 1x1 PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function outcome(
  partial: Partial<NodeReplExecOutcome> & Pick<NodeReplExecOutcome, 'status'>,
): NodeReplExecOutcome {
  return {
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
  } as NodeReplExecOutcome;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }) {
  return result.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
}

describe('convertOutcomeToMcpResult', () => {
  it('maps write text to a text content block, no isError on ok', () => {
    const result = convertOutcomeToMcpResult(
      outcome({
        status: 'ok',
        events: [{ type: 'text', kind: 'write', text: 'hello' }],
      }),
    );
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('hello');
  });

  it('maps an image event to an image content block', () => {
    const result = convertOutcomeToMcpResult(
      outcome({
        status: 'ok',
        events: [{ type: 'image', data: PNG_BASE64, mimeType: 'image/png' }],
      }),
    );
    const image = result.content.find((b) => b.type === 'image') as
      | { type: 'image'; data: string; mimeType: string }
      | undefined;
    expect(image).toBeDefined();
    expect(image?.mimeType).toBe('image/png');
    expect(image?.data).toBe(PNG_BASE64);
  });

  it('rejects an image whose bytes do not match the declared MIME', () => {
    const result = convertOutcomeToMcpResult(
      outcome({
        status: 'ok',
        events: [{ type: 'image', data: PNG_BASE64, mimeType: 'image/jpeg' }],
      }),
    );
    expect(result.content.some((b) => b.type === 'image')).toBe(false);
    expect(textOf(result)).toContain('image rejected');
  });

  it('folds non-ok status into isError with a leading status note', () => {
    const result = convertOutcomeToMcpResult(
      outcome({
        status: 'error',
        error: { name: 'TypeError', message: 'boom' },
      }),
    );
    expect(result.isError).toBe(true);
    const text = textOf(result);
    expect(text).toContain('[node_repl error]');
    expect(text).toContain('boom');
  });

  it('marks timeout as isError and preserves the status label', () => {
    const result = convertOutcomeToMcpResult(
      outcome({
        status: 'timeout',
        error: { name: 'Error', message: 'exceeded' },
      }),
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('[node_repl timeout]');
  });

  it('truncates very large text and appends a truncation notice', () => {
    const huge = 'x'.repeat(500_000); // ~2.5M token-units >> 200k budget
    const result = convertOutcomeToMcpResult(
      outcome({
        status: 'ok',
        events: [{ type: 'text', kind: 'write', text: huge }],
      }),
    );
    const text = textOf(result);
    expect(text.length).toBeLessThan(huge.length);
    expect(text).toContain('truncated');
  });

  it('surfaces a dropped-images notice', () => {
    const result = convertOutcomeToMcpResult(
      outcome({ status: 'ok', imagesDropped: 3 }),
    );
    expect(textOf(result)).toContain('3 image(s) dropped');
  });

  it('always returns at least one content block with real guidance', () => {
    const result = convertOutcomeToMcpResult(outcome({ status: 'ok' }));
    expect(result.content.length).toBeGreaterThanOrEqual(1);
    // Must not be an empty text block — several model APIs reject those, and it
    // gives the model no signal that the cell succeeded silently.
    const text = textOf(result);
    expect(text.trim().length).toBeGreaterThan(0);
    expect(text).toMatch(/no output/i);
  });

  it('caps the number of emitted images and reports the omissions', () => {
    const events = Array.from({ length: 20 }, () => ({
      type: 'image' as const,
      data: PNG_BASE64,
      mimeType: 'image/png',
    }));
    const result = convertOutcomeToMcpResult(outcome({ status: 'ok', events }));
    const images = result.content.filter((b) => b.type === 'image');
    expect(images.length).toBe(8); // MAX_MODEL_IMAGES
    expect(textOf(result)).toMatch(/12 image\(s\) omitted/);
  });

  it('rejects a single image above the per-image byte cap', () => {
    // A valid PNG header followed by >4 MiB of payload.
    const header = Buffer.from(PNG_BASE64, 'base64');
    const big = Buffer.concat([header, Buffer.alloc(5 * 1024 * 1024)]);
    const result = convertOutcomeToMcpResult(
      outcome({
        status: 'ok',
        events: [
          {
            type: 'image',
            data: big.toString('base64'),
            mimeType: 'image/png',
          },
        ],
      }),
    );
    expect(result.content.some((b) => b.type === 'image')).toBe(false);
    expect(textOf(result)).toMatch(/exceeds/);
  });

  it('keeps the whole result within the token budget when every notice fires', () => {
    const huge = 'x'.repeat(400_000);
    const events = [
      { type: 'text' as const, kind: 'write' as const, text: huge },
      ...Array.from({ length: 20 }, () => ({
        type: 'image' as const,
        data: PNG_BASE64,
        mimeType: 'image/png',
      })),
    ];
    const result = convertOutcomeToMcpResult(
      outcome({
        status: 'error',
        events,
        rawTextTruncated: true,
        imagesDropped: 2,
        error: { name: 'Error', message: 'boom' },
      }),
    );
    const units = estimateTextTokenUnits(textOf(result));
    expect(units).toBeLessThanOrEqual(
      MAX_MODEL_TEXT_TOKENS * TOKEN_ESTIMATE_UNITS_PER_TOKEN,
    );
    // All three notices present.
    expect(textOf(result)).toMatch(/truncated/);
    expect(textOf(result)).toMatch(/2 image\(s\) dropped/);
    expect(textOf(result)).toMatch(/omitted/);
  });

  it('does not split a surrogate pair when capping an error message', () => {
    const result = convertOutcomeToMcpResult(
      outcome({
        status: 'error',
        error: { name: 'Error', message: '😀'.repeat(20_000) },
      }),
    );
    const text = textOf(result);
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(i + 1);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
        i++;
      } else {
        // No lone low surrogate either.
        expect(code >= 0xdc00 && code <= 0xdfff).toBe(false);
      }
    }
  });
});
