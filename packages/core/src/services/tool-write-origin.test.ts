/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildToolWriteOriginMeta,
  parseToolWriteOriginMeta,
} from './tool-write-origin.js';

describe('tool write origin metadata', () => {
  it('round-trips each supported source', () => {
    for (const source of [
      'write_file',
      'edit',
      'notebook_edit',
      'shell_sed_edit',
    ] as const) {
      const meta = buildToolWriteOriginMeta({ bom: true }, source);
      expect(parseToolWriteOriginMeta(meta)).toBe(source);
      expect(meta?.['bom']).toBe(true);
    }
  });

  it('replaces caller-supplied provenance', () => {
    const meta = buildToolWriteOriginMeta(
      {
        'qwen-code/tool-write-origin': {
          version: 1,
          source: 'write_file',
        },
      },
      'edit',
    );

    expect(meta?.['qwen-code/tool-write-origin']).toEqual({
      version: 1,
      source: 'edit',
    });
  });

  it.each([
    undefined,
    null,
    [],
    { version: 2, source: 'write_file' },
    { version: 1, source: 'unknown' },
    { version: 1, source: 'write_file', extra: true },
    { source: 'write_file' },
  ])('rejects malformed marker %j', (marker) => {
    expect(
      parseToolWriteOriginMeta({
        'qwen-code/tool-write-origin': marker,
      }),
    ).toBeUndefined();
  });
});
