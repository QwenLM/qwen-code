/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { resolveGithubWebOrigin } from './web-origin.js';

describe('resolveGithubWebOrigin', () => {
  it.each([
    [undefined, 'https://github.com'],
    ['', 'https://github.com'],
    ['   ', 'https://github.com'],
    ['https://api.github.com', 'https://github.com'],
    ['https://api.github.com/', 'https://github.com'],
    // baseUrl is env-resolvable, so stray whitespace is reachable.
    [' https://api.github.com/ ', 'https://github.com'],
    ['https://ghe.example.com/api/v3', 'https://ghe.example.com'],
    ['https://ghe.example.com/api/v3/', 'https://ghe.example.com'],
    ['https://ghe.example.com/', 'https://ghe.example.com'],
    ['https://ghe.example.com:8443/api/v3', 'https://ghe.example.com:8443'],
    ['https://api.tenant.ghe.com', 'https://tenant.ghe.com'],
    ['https://api.tenant.ghe.com/', 'https://tenant.ghe.com'],
    // A self-hosted GHE Server may serve web and API from an api.-prefixed
    // host; only single-label .ghe.com tenants are remapped.
    ['https://api.ghe.example.com/api/v3', 'https://api.ghe.example.com'],
  ])('maps %j to %s', (baseUrl, expected) => {
    expect(resolveGithubWebOrigin(baseUrl)).toBe(expected);
  });

  it('never emits a trailing slash that would double the path separator', () => {
    for (const baseUrl of [
      'https://api.github.com///',
      'https://ghe.example.com//',
    ]) {
      expect(resolveGithubWebOrigin(baseUrl).endsWith('/')).toBe(false);
    }
  });
});
