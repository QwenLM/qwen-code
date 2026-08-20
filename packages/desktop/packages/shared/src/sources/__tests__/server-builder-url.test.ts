/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, test } from 'bun:test';
import { normalizeMcpUrl } from '../server-builder.ts';

describe('normalizeMcpUrl', () => {
  test('removes trailing slashes from the URL pathname', () => {
    expect(normalizeMcpUrl('https://api.example.com/mcp/')).toBe(
      'https://api.example.com/mcp',
    );
    expect(normalizeMcpUrl('https://api.example.com/mcp///')).toBe(
      'https://api.example.com/mcp',
    );
  });

  test('preserves trailing slashes inside query parameters', () => {
    expect(normalizeMcpUrl('https://api.example.com/mcp?key=/')).toBe(
      'https://api.example.com/mcp?key=/',
    );
    expect(normalizeMcpUrl('https://api.example.com/mcp/?key=value/')).toBe(
      'https://api.example.com/mcp?key=value/',
    );
  });

  test('preserves trailing slashes inside URL fragments', () => {
    expect(normalizeMcpUrl('https://api.example.com/mcp#/')).toBe(
      'https://api.example.com/mcp#/',
    );
    expect(normalizeMcpUrl('https://api.example.com/mcp/#/route/')).toBe(
      'https://api.example.com/mcp#/route/',
    );
  });

  test('keeps legacy fallback behavior for non-parseable URLs', () => {
    expect(normalizeMcpUrl('not a url///')).toBe('not a url');
  });
});
