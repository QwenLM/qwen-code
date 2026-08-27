/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Part } from '@google/genai';
import {
  detectNestedFunctionResponseMedia,
  replaceNestedFunctionResponseMedia,
  clampNestedFunctionResponseMedia,
} from './nested-function-response-media.js';

/** A functionResponse part nesting one media carrier with the given MIME. */
function nestedMediaCarrier(mimeType: string | undefined, data = 'QUJD') {
  const inlineData: Record<string, unknown> = { data };
  if (mimeType !== undefined) inlineData['mimeType'] = mimeType;
  return {
    functionResponse: {
      name: 'custom_tool',
      response: { output: 'tool output' },
      parts: [{ inlineData }],
    },
  } as unknown as Part;
}

describe('detectNestedFunctionResponseMedia', () => {
  it('classifies image and audio carriers case-insensitively', () => {
    expect(
      detectNestedFunctionResponseMedia([
        nestedMediaCarrier('IMAGE/PNG'),
        nestedMediaCarrier('audio/WAV'),
      ]),
    ).toEqual({
      hasImage: true,
      hasAudio: true,
      hasUntyped: false,
      hasForeign: false,
    });
  });

  it('reports MIME-less carriers as untyped', () => {
    expect(
      detectNestedFunctionResponseMedia([nestedMediaCarrier(undefined)]),
    ).toEqual({
      hasImage: false,
      hasAudio: false,
      hasUntyped: true,
      hasForeign: false,
    });
  });

  it.each([
    'video/mp4',
    'application/pdf',
    'application/octet-stream',
    '', // empty-string MIME: defined, but matches no modality
    'text/plain',
  ])('reports %s carriers as foreign (no routable modality)', (mime) => {
    expect(
      detectNestedFunctionResponseMedia([nestedMediaCarrier(mime)]),
    ).toEqual({
      hasImage: false,
      hasAudio: false,
      hasUntyped: false,
      hasForeign: true,
    });
  });

  it('detects fileData carriers too', () => {
    const part = {
      functionResponse: {
        name: 'custom_tool',
        response: { output: 'x' },
        parts: [
          { fileData: { fileUri: 'gs://bucket/clip.mp4', mimeType: 'video/mp4' } },
        ],
      },
    } as unknown as Part;
    expect(detectNestedFunctionResponseMedia([part]).hasForeign).toBe(true);
  });

  it('never throws on malformed part lists (null entries, null inner parts)', () => {
    const malformed = [
      null,
      'plain text',
      { functionResponse: { name: 't', response: {}, parts: [null, undefined, 'str'] } },
      { functionResponse: { name: 't', response: {}, parts: null } },
    ] as unknown as Part[];
    expect(() => detectNestedFunctionResponseMedia(malformed)).not.toThrow();
    expect(detectNestedFunctionResponseMedia(malformed)).toEqual({
      hasImage: false,
      hasAudio: false,
      hasUntyped: false,
      hasForeign: false,
    });
  });

  it('reports media-less payloads as all-false', () => {
    expect(
      detectNestedFunctionResponseMedia([
        { text: 'hello' },
        { functionResponse: { name: 't', response: { output: 'no media' } } },
      ] as Part[]),
    ).toEqual({
      hasImage: false,
      hasAudio: false,
      hasUntyped: false,
      hasForeign: false,
    });
  });
});

describe('replaceNestedFunctionResponseMedia', () => {
  it('substitutes only foreign carriers for the foreign match', () => {
    const parts = [
      nestedMediaCarrier('video/mp4', 'VklERU8='),
      nestedMediaCarrier('image/png', 'SU1BR0U='),
    ];
    const replaced = replaceNestedFunctionResponseMedia(
      parts,
      'foreign',
      '[foreign media not sent]',
    );
    const serialized = JSON.stringify(replaced);
    expect(serialized).not.toContain('VklERU8=');
    expect(serialized).toContain('[foreign media not sent]');
    // The image carrier is not a foreign match and survives untouched.
    expect(serialized).toContain('SU1BR0U=');
  });

  it('substitutes empty-string-MIME carriers for the foreign match', () => {
    const replaced = replaceNestedFunctionResponseMedia(
      [nestedMediaCarrier('', 'RU1QVFk=')],
      'foreign',
      '[foreign media not sent]',
    );
    const serialized = JSON.stringify(replaced);
    expect(serialized).not.toContain('RU1QVFk=');
    expect(serialized).toContain('[foreign media not sent]');
  });

  it('preserves structured tool output when substituting', () => {
    const replaced = replaceNestedFunctionResponseMedia(
      [nestedMediaCarrier('application/pdf', 'UERG')],
      'foreign',
      '[foreign media not sent]',
    );
    const fr = (replaced[0] as Part).functionResponse as {
      response: { output: string };
    };
    expect(fr.response.output).toContain('tool output');
    expect(fr.response.output).toContain('[foreign media not sent]');
  });

  it('does not throw on malformed part lists', () => {
    const malformed = [
      null,
      { functionResponse: { name: 't', response: {}, parts: [null] } },
    ] as unknown as Part[];
    expect(() =>
      replaceNestedFunctionResponseMedia(malformed, 'foreign', 'note'),
    ).not.toThrow();
  });
});

describe('clampNestedFunctionResponseMedia', () => {
  it('does not throw on malformed part lists', () => {
    const malformed = [
      null,
      { functionResponse: { name: 't', response: {}, parts: [null] } },
    ] as unknown as Part[];
    expect(() => clampNestedFunctionResponseMedia(malformed)).not.toThrow();
  });

  it('returns the input unchanged when nothing is oversized', () => {
    const parts = [nestedMediaCarrier('image/png', 'SU1BR0U=')];
    expect(clampNestedFunctionResponseMedia(parts)).toBe(parts);
  });
});
