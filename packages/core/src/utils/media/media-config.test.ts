/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { Config } from '../../config/config.js';
import { DEFAULT_MEDIA_CONFIG, resolveMediaConfig } from './media-config.js';

function fakeConfig(
  media: Partial<import('./media-config.js').MediaConfig> | undefined,
): Config {
  return { getMediaConfig: () => media } as unknown as Config;
}

describe('media-config', () => {
  it('returns defaults when nothing is configured', () => {
    expect(resolveMediaConfig(fakeConfig(undefined))).toEqual(
      DEFAULT_MEDIA_CONFIG,
    );
  });

  it('merges the user decision policy over defaults', () => {
    const resolved = resolveMediaConfig(
      fakeConfig({ decisionPolicy: { fps: 'model' } }),
    );
    expect(resolved.decisionPolicy['fps']).toBe('model');
    // Unspecified knobs keep their scaffold default.
    expect(resolved.decisionPolicy['range']).toBe('scaffold');
  });

  it('keeps default readers when the user list is empty', () => {
    const resolved = resolveMediaConfig(fakeConfig({ readers: [] }));
    expect(resolved.readers).toEqual(DEFAULT_MEDIA_CONFIG.readers);
  });

  it('uses declared readers when provided', () => {
    const resolved = resolveMediaConfig(
      fakeConfig({
        readers: [
          { id: 'native-inline', kind: 'native' },
          {
            id: 'ocr',
            kind: 'delegated',
            via: 'command',
            ref: 'ocr {path}',
          },
        ],
      }),
    );
    expect(resolved.readers).toHaveLength(2);
    expect(resolved.readers[1].id).toBe('ocr');
  });
});
