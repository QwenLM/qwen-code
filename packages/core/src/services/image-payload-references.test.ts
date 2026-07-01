/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import { describe, expect, it } from 'vitest';
import {
  InMemoryImagePayloadStore,
  prepareImagePayloadsForRequest,
} from './image-payload-references.js';

function toolImageTurn(data: string): Content {
  return {
    role: 'user',
    parts: [
      {
        functionResponse: {
          id: `call-${data}`,
          name: 'screenshot',
          response: { output: `captured ${data}` },
          parts: [{ inlineData: { mimeType: 'image/png', data } }],
        },
      },
    ],
  };
}

function imageParts(contents: Content[]): Part[] {
  const result: Part[] = [];
  for (const content of contents) {
    for (const part of content.parts ?? []) {
      if (part.inlineData?.mimeType?.startsWith('image/')) {
        result.push(part);
      }
      const nested = part.functionResponse?.parts as Part[] | undefined;
      for (const inner of nested ?? []) {
        if (inner.inlineData?.mimeType?.startsWith('image/')) {
          result.push(inner);
        }
      }
    }
  }
  return result;
}

describe('prepareImagePayloadsForRequest', () => {
  it('replaces historical image positions with stable refs and reattaches only the most recent images', () => {
    const store = new InMemoryImagePayloadStore();
    const history: Content[] = [
      toolImageTurn('old-shot'),
      toolImageTurn('new-shot'),
      { role: 'user', parts: [{ text: 'continue' }] },
    ];

    const prepared = prepareImagePayloadsForRequest(history, {
      maxRecentImages: 1,
      store,
    });

    const serialized = JSON.stringify(prepared);
    expect(serialized).toMatch(
      /\[Image #[a-f0-9]{12}: image\/png, \d+ bytes\]/,
    );
    expect(serialized).not.toContain('"data":"old-shot"');
    expect(imageParts(prepared).map((part) => part.inlineData?.data)).toEqual([
      'new-shot',
    ]);
    expect(prepared).toHaveLength(history.length);
    expect(prepared.at(-1)?.role).toBe('user');
    expect(prepared.at(-1)?.parts?.[0]?.text).toBe('continue');
    expect(prepared.at(-1)?.parts?.[1]?.text).toContain(
      'Recent images reattached',
    );
  });

  it('reattaches an older image when the current request explicitly references its stable id', () => {
    const store = new InMemoryImagePayloadStore();
    const oldImage = toolImageTurn('old-shot');
    const firstPass = prepareImagePayloadsForRequest(
      [oldImage, { role: 'model', parts: [{ text: 'ok' }] }],
      {
        maxRecentImages: 0,
        store,
      },
    );
    const id = JSON.stringify(firstPass).match(/Image #([a-f0-9]{12})/)?.[1];
    expect(id).toBeDefined();

    const prepared = prepareImagePayloadsForRequest(
      [
        oldImage,
        toolImageTurn('new-shot'),
        { role: 'user', parts: [{ text: `inspect Image #${id}` }] },
      ],
      {
        maxRecentImages: 0,
        store,
      },
    );

    expect(imageParts(prepared).map((part) => part.inlineData?.data)).toEqual([
      'old-shot',
    ]);
  });

  it('reattaches the most recent unique historical images', () => {
    const store = new InMemoryImagePayloadStore();
    const prepared = prepareImagePayloadsForRequest(
      [
        toolImageTurn('shot-a'),
        toolImageTurn('shot-b'),
        toolImageTurn('shot-c'),
        toolImageTurn('shot-c'),
        toolImageTurn('shot-c'),
        { role: 'user', parts: [{ text: 'continue' }] },
      ],
      {
        maxRecentImages: 3,
        store,
      },
    );

    expect(imageParts(prepared).map((part) => part.inlineData?.data)).toEqual([
      'shot-a',
      'shot-b',
      'shot-c',
    ]);
  });

  it('preserves images in the current user request when maxRecentImages is zero', () => {
    const store = new InMemoryImagePayloadStore();
    const prepared = prepareImagePayloadsForRequest(
      [
        toolImageTurn('old-shot'),
        {
          role: 'user',
          parts: [
            { text: 'inspect this' },
            { inlineData: { mimeType: 'image/png', data: 'current-shot' } },
          ],
        },
      ],
      {
        maxRecentImages: 0,
        preserveLastUserImagePartCount: 2,
        store,
      },
    );

    const serialized = JSON.stringify(prepared);
    expect(serialized).not.toContain('"data":"old-shot"');
    expect(imageParts(prepared).map((part) => part.inlineData?.data)).toEqual([
      'current-shot',
    ]);
  });
});
