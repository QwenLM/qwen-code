/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { DESKTOP_ORIGIN, parseListeningUrl, runtimeArguments } from './runtime';

describe('Electron desktop runtime', () => {
  it('starts an authenticated loopback daemon for the Electron origin', () => {
    expect(runtimeArguments('/workspace')).toEqual([
      'serve',
      '--port',
      '0',
      '--hostname',
      '127.0.0.1',
      '--require-auth',
      '--allow-origin',
      DESKTOP_ORIGIN,
      '--workspace',
      '/workspace',
      '--no-open',
    ]);
  });

  it('accepts only loopback listening URLs', () => {
    expect(
      parseListeningUrl(
        'qwen serve listening on http://127.0.0.1:49152 (workspace=/tmp)',
      ),
    ).toBe('http://127.0.0.1:49152');
    expect(
      parseListeningUrl('qwen serve listening on http://0.0.0.0:49152'),
    ).toBeUndefined();
    expect(parseListeningUrl('unrelated output')).toBeUndefined();
  });
});
