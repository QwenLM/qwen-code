/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  createPreapprovedHostChecker,
  isPreapprovedHost,
} from './web-fetch-preapproved.js';

describe('WebFetch preapproved host matching', () => {
  it('preapproves Qwen documentation and official code documentation', () => {
    for (const [hostname, pathname] of [
      ['qwenlm.github.io', '/'],
      ['qwen.readthedocs.io', '/'],
      ['github.com', '/QwenLM/Qwen'],
      ['raw.githubusercontent.com', '/QwenLM/Qwen/main/README.md'],
      ['modelcontextprotocol.io', '/'],
      ['docs.python.org', '/'],
      ['vercel.com', '/docs'],
    ]) {
      expect(isPreapprovedHost(hostname, pathname)).toBe(true);
    }
  });

  it('does not preapprove unrelated hosts or paths', () => {
    expect(isPreapprovedHost('example.com', '/docs')).toBe(false);
    expect(isPreapprovedHost('github.com', '/OtherOwner/repo')).toBe(false);
    expect(isPreapprovedHost('github.com', '/QwenLM-evil/repo')).toBe(false);
    expect(isPreapprovedHost('vercel.com', '/other')).toBe(false);
  });

  it('matches only exact hostnames and path segment boundaries', () => {
    const check = createPreapprovedHostChecker(
      new Set(['docs.example.com', 'example.com/docs']),
    );
    expect(check('docs.example.com', '/anything')).toBe(true);
    expect(check('sub.docs.example.com', '/')).toBe(false);
    expect(check('example.com', '/docs')).toBe(true);
    expect(check('example.com', '/docs/page')).toBe(true);
    expect(check('example.com', '/docs-evil')).toBe(false);
    expect(check('example.com', '/')).toBe(false);
    expect(check('other.example.com', '/docs')).toBe(false);
  });

  it('keeps independently configured matchers separate', () => {
    const first = createPreapprovedHostChecker(new Set(['first.example.com']));
    const second = createPreapprovedHostChecker(new Set(['second.example.com']));
    expect(first('first.example.com', '/')).toBe(true);
    expect(second('first.example.com', '/')).toBe(false);
    expect(isPreapprovedHost('first.example.com', '/')).toBe(false);
  });
});
