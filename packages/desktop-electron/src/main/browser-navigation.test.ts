/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { isSafeBrowserUrl, normalizeBrowserUrl } from './browser-navigation';

describe('embedded browser navigation', () => {
  it('normalizes bare hostnames to HTTPS', () => {
    expect(normalizeBrowserUrl('example.com/docs')).toBe(
      'https://example.com/docs',
    );
  });

  it('accepts canonical HTTP and HTTPS URLs', () => {
    expect(isSafeBrowserUrl('https://example.com/')).toBe(true);
    expect(isSafeBrowserUrl('http://127.0.0.1:4173/page')).toBe(true);
  });

  it('rejects credentials, non-web schemes, and search-like input', () => {
    expect(normalizeBrowserUrl('https://user:secret@example.com')).toBe(
      undefined,
    );
    expect(normalizeBrowserUrl('file:///tmp/secret')).toBe(undefined);
    expect(normalizeBrowserUrl('hello world')).toBe(undefined);
  });
});
