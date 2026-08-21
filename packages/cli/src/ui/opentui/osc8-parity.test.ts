/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies the OpenTUI OSC 8 parity module keeps the ink hyperlink security
 * constraints intact: scheme allowlist, whitespace rejection, legacy
 * `label (url)` fallback, the label-deception suffix, and bare-URL target
 * trimming that leaves visible bytes untouched.
 */

import { describe, it, expect } from 'vitest';
import {
  renderMarkdownLink,
  renderBareUrl,
  osc8Open,
  osc8Close,
  isSafeOscScheme,
  shouldWrapMarkdownLink,
  labelMayDeceive,
} from './osc8-parity.js';

describe('osc8-parity renderMarkdownLink', () => {
  it('wraps an allowlisted URL in an OSC 8 envelope when hyperlinks are available', () => {
    const out = renderMarkdownLink('click me', 'https://example.com', true);
    expect(out.wrapped).toBe(true);
    expect(out.deceptionSuffix).toBe(false);
    expect(out.text).toBe(
      `${osc8Open('https://example.com')}click me${osc8Close()}`,
    );
  });

  it('shows the URL as the label when the markdown label is empty', () => {
    const out = renderMarkdownLink('', 'https://example.com', true);
    expect(out.text).toBe(
      `${osc8Open('https://example.com')}https://example.com${osc8Close()}`,
    );
  });

  it('falls back to legacy `label (url)` when the terminal cannot hyperlink', () => {
    const out = renderMarkdownLink('click me', 'https://example.com', false);
    expect(out).toEqual({
      text: 'click me (https://example.com)',
      wrapped: false,
      deceptionSuffix: false,
    });
  });

  it('falls back to legacy spelling for a disallowed scheme', () => {
    const out = renderMarkdownLink('trap', 'javascript:alert(1)', true);
    expect(out.wrapped).toBe(false);
    expect(out.text).toBe('trap (javascript:alert(1))');
  });

  it('falls back to legacy spelling when the URL contains whitespace', () => {
    const out = renderMarkdownLink('docs', 'https://example.com/a b', true);
    expect(out.wrapped).toBe(false);
    expect(out.text).toBe('docs (https://example.com/a b)');
  });

  it('appends the real target when the label spoofs a different host', () => {
    const out = renderMarkdownLink(
      'https://google.com',
      'https://attacker.com',
      true,
    );
    expect(out.wrapped).toBe(true);
    expect(out.deceptionSuffix).toBe(true);
    expect(out.text.endsWith(' (https://attacker.com)')).toBe(true);
  });

  it('appends the target for a bare-host spoof label too', () => {
    const out = renderMarkdownLink('google.com', 'https://attacker.com', true);
    expect(out.deceptionSuffix).toBe(true);
  });

  it('does not append the suffix when the label matches the target host', () => {
    const out = renderMarkdownLink(
      'example.com docs',
      'https://example.com/docs',
      true,
    );
    expect(out.wrapped).toBe(true);
    expect(out.deceptionSuffix).toBe(false);
  });

  it('strips escape bytes a model embedded in the label before emitting', () => {
    const out = renderMarkdownLink('lbl\x1b[31m', 'https://example.com', true);
    expect(out.text).not.toContain('\x1b[31m');
  });
});

describe('osc8-parity renderBareUrl', () => {
  it('wraps the trimmed target while keeping the visible bytes untouched', () => {
    const out = renderBareUrl('https://example.com/page.', true);
    expect(out.wrapped).toBe(true);
    expect(out.text).toBe(
      `${osc8Open('https://example.com/page')}https://example.com/page.${osc8Close()}`,
    );
  });

  it('emits the URL as-is when hyperlinks are unavailable', () => {
    const out = renderBareUrl('https://example.com/page.', false);
    expect(out).toEqual({
      text: 'https://example.com/page.',
      wrapped: false,
      deceptionSuffix: false,
    });
  });

  it('rebalances a trailing paren against opens in the URL', () => {
    const out = renderBareUrl('https://en.wikipedia.org/wiki/Foo_(bar)', true);
    expect(out.text).toBe(
      `${osc8Open('https://en.wikipedia.org/wiki/Foo_(bar)')}https://en.wikipedia.org/wiki/Foo_(bar)${osc8Close()}`,
    );
  });
});

describe('osc8-parity re-exported primitives', () => {
  it('exposes the scheme allowlist', () => {
    expect(isSafeOscScheme('https://x.com')).toBe(true);
    expect(isSafeOscScheme('mailto:a@b.com')).toBe(true);
    expect(isSafeOscScheme('file:///etc/passwd')).toBe(false);
    expect(isSafeOscScheme('data:text/html,hi')).toBe(false);
    expect(isSafeOscScheme('relative/path')).toBe(false);
  });

  it('exposes the wrap predicate (scheme + whitespace)', () => {
    expect(shouldWrapMarkdownLink('https://x.com', true)).toBe(true);
    expect(shouldWrapMarkdownLink('https://x.com', false)).toBe(false);
    expect(shouldWrapMarkdownLink('file:///x', true)).toBe(false);
    expect(shouldWrapMarkdownLink('https://x.com/a b', true)).toBe(false);
  });

  it('exposes the label-deception heuristic', () => {
    expect(labelMayDeceive('https://google.com', 'https://evil.com')).toBe(
      true,
    );
    expect(labelMayDeceive('https://evil.com', 'https://evil.com')).toBe(false);
  });
});
