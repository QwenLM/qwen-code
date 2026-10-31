/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import { describe, expect, it } from 'vitest';
import {
  appendAutoMemoryContext,
  appendAutoMemorySnapshot,
  getAutoMemorySnapshot,
  withoutAutoMemorySnapshots,
} from './request-context.js';
import { REATTACH_BOUNDARY_METADATA } from '../services/image-payload-references.js';

const catalog = 'current memory catalog';
// The catalog part is request-only, so it must carry the volatile-boundary
// marker that keeps the providers' per-turn cache breakpoint off it.
const catalogPart = (text: string) => ({
  text,
  partMetadata: { [REATTACH_BOUNDARY_METADATA]: true },
});

describe('retained memory snapshots', () => {
  it('deduplicates retries against the latest surviving snapshot and preserves shared user parts', () => {
    const image = { inlineData: { mimeType: 'image/png', data: 'pixels' } };
    const user = { role: 'user', parts: [{ text: 'question' }, image] };
    const history: Content[] = [user];
    const first = getAutoMemorySnapshot(history, 'A')!;
    appendAutoMemorySnapshot(history, first);
    expect(history).toHaveLength(1);
    expect(user.parts).toHaveLength(2);
    expect(history[0].parts?.[1]).toBe(image);
    expect(getAutoMemorySnapshot(history, 'A')).toBeUndefined();
    const second = getAutoMemorySnapshot(history, 'B')!;
    appendAutoMemorySnapshot(history, second);
    expect(getAutoMemorySnapshot(history, 'A')).toEqual(first);
    expect(history[0].parts?.slice(-2)).toEqual([first, second]);
    expect(getAutoMemorySnapshot([user], 'A')).toEqual(first);
  });

  it('filters only marked parts and removes snapshot-only entries without mutating history', () => {
    const snapshot = getAutoMemorySnapshot([], 'catalog')!;
    const history: Content[] = [
      { role: 'user', parts: [{ text: snapshot.text }, snapshot] },
      { role: 'model', parts: [{ text: 'reply' }] },
      { role: 'user', parts: [snapshot] },
    ];
    const original = structuredClone(history);
    expect(withoutAutoMemorySnapshots(history)).toEqual([
      { role: 'user', parts: [{ text: snapshot.text }] },
      history[1],
    ]);
    expect(history).toEqual(original);
  });
});

describe('appendAutoMemoryContext', () => {
  it('keeps input history unchanged across catalog revisions and repeated requests', () => {
    const contents: Content[] = [
      { role: 'user', parts: [{ text: 'earlier question' }] },
      { role: 'model', parts: [{ text: 'earlier answer' }] },
      { role: 'user', parts: [{ text: 'current question' }] },
    ];
    const original = structuredClone(contents);
    const first = appendAutoMemoryContext(contents, catalog);
    const updated = appendAutoMemoryContext(contents, 'updated catalog');
    expect(contents).toEqual(original);
    expect(first.slice(0, -1)).toEqual(original.slice(0, -1));
    expect(first.at(-1)?.parts).toEqual([
      { text: 'current question' },
      catalogPart(catalog),
    ]);
    expect(updated.at(-1)?.parts).toEqual([
      { text: 'current question' },
      catalogPart('updated catalog'),
    ]);
    expect(appendAutoMemoryContext(contents, catalog)).toEqual(first);
    expect(appendAutoMemoryContext(contents, '')).toBe(contents);
  });

  it('places catalog data after tool responses without changing the tool pair', () => {
    const contents: Content[] = [
      {
        role: 'model',
        parts: [{ functionCall: { id: 'a', name: 'read_file', args: {} } }],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'a',
              name: 'read_file',
              response: { output: 'ok' },
            },
          },
        ],
      },
    ];
    const result = appendAutoMemoryContext(contents, catalog);
    expect(result[0]).toBe(contents[0]);
    expect(result[1].parts?.[0]).toBe(contents[1].parts?.[0]);
    expect(result[1].parts?.at(-1)).toEqual(catalogPart(catalog));
    expect(contents[1].parts).toHaveLength(1);
  });

  it('uses a trailing user entry for empty history and a model tail', () => {
    const tail = { role: 'user', parts: [catalogPart(catalog)] };
    expect(appendAutoMemoryContext([], catalog)).toEqual([tail]);
    const contents: Content[] = [
      { role: 'model', parts: [{ text: 'answer' }] },
    ];
    expect(appendAutoMemoryContext(contents, catalog)).toEqual([
      ...contents,
      tail,
    ]);
    expect(contents).toHaveLength(1);
  });
});
