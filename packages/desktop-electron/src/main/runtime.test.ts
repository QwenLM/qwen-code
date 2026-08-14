/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  createAuthenticatedWebUrl,
  parseListeningUrl,
  runtimeArguments,
} from './runtime';

describe('Electron desktop runtime', () => {
  it('starts an authenticated loopback daemon that serves Web Shell', () => {
    expect(runtimeArguments('/workspace')).toEqual([
      'serve',
      '--port',
      '0',
      '--hostname',
      '127.0.0.1',
      '--require-auth',
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

  it('passes the daemon token through the standard Web Shell hash', () => {
    const url = createAuthenticatedWebUrl(
      'http://127.0.0.1:49152',
      'token with spaces',
    );

    expect(url).toBe('http://127.0.0.1:49152/#token=token+with+spaces');
    expect(new URL(url).origin).toBe('http://127.0.0.1:49152');
    expect(new URL(url).search).toBe('');
  });
});
