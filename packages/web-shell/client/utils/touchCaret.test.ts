// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
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

describe('touch caret mirror lifecycle', () => {
  it('keeps one mirror per textarea across drafts and discards it on demand', () => {
    const el = host();
    const count = () =>
      document.querySelectorAll('div[aria-hidden="true"]').length;
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
    expect(document.querySelectorAll('div[aria-hidden="true"]').length).toBe(1);
    discardMirror(el);
    expect(document.querySelectorAll('div[aria-hidden="true"]').length).toBe(0);
    el.remove();
  });
});
