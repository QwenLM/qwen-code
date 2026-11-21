// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { discardMirror, visualLineStartsAround } from './touchCaret';

function host(): HTMLTextAreaElement {
  const el = document.createElement('textarea');
  Object.defineProperty(el, 'clientWidth', {
    value: 300,
    configurable: true,
  });
  document.body.appendChild(el);
  return el;
}

describe('grapheme fallback', () => {
  it('does not pair a high surrogate with an ordinary code unit', async () => {
    vi.stubGlobal('Intl', { ...Intl, Segmenter: undefined });
    vi.resetModules();
    try {
      const { graphemeBoundaries, nextGraphemeBoundary } = await import(
        './touchCaret'
      );
      expect(graphemeBoundaries('\uD800A')).toEqual([0, 1, 2]);
      expect(nextGraphemeBoundary('\uD800A', 0)).toBe(1);
      expect(graphemeBoundaries('\uD800\uDC00A')).toEqual([0, 2, 3]);
      expect(nextGraphemeBoundary('\uD800\uDC00A', 0)).toBe(2);
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});

describe('touch caret mirror lifecycle', () => {
  it('replaces the mirror when font readiness changes', () => {
    const el = host();
    const oldDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
    const state = { status: 'loading' };
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      get: () => state,
    });
    const mirror = () =>
      document.querySelector('[data-web-shell-caret-mirror]');
    try {
      visualLineStartsAround(el, 'abc', 3);
      const first = mirror();
      state.status = 'loaded';
      visualLineStartsAround(el, 'abc', 3);
      expect(first).not.toBeNull();
      expect(mirror()).not.toBe(first);
      expect(
        document.querySelectorAll('[data-web-shell-caret-mirror]'),
      ).toHaveLength(1);
    } finally {
      discardMirror(el);
      el.remove();
      if (oldDescriptor) {
        Object.defineProperty(document, 'fonts', oldDescriptor);
      } else {
        Reflect.deleteProperty(document, 'fonts');
      }
    }
  });

  it('keeps one mirror per textarea across drafts and discards it on demand', () => {
    const el = host();
    const count = () =>
      document.querySelectorAll('[data-web-shell-caret-mirror]').length;
    expect(count()).toBe(0);
    visualLineStartsAround(el, 'abc', 3);
    expect(count()).toBe(1);
    visualLineStartsAround(el, 'abcd', 4);
    expect(count()).toBe(1);
    visualLineStartsAround(el, 'a'.repeat(500), 50);
    expect(count()).toBe(1);
    const second = host();
    visualLineStartsAround(second, 'other', 2);
    expect(count()).toBe(2);
    discardMirror(el);
    discardMirror(second);
    expect(count()).toBe(0);
    el.remove();
    second.remove();
  });

  it('tolerates an empty draft and discards it too', () => {
    const el = host();
    visualLineStartsAround(el, '', 0);
    expect(
      document.querySelectorAll('[data-web-shell-caret-mirror]').length,
    ).toBe(1);
    discardMirror(el);
    expect(
      document.querySelectorAll('[data-web-shell-caret-mirror]').length,
    ).toBe(0);
    el.remove();
  });
});
