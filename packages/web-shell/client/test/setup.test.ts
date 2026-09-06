// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

describe('web-shell test setup', () => {
  it('provides range layout methods used by CodeMirror', () => {
    const range = document.createRange();

    expect(typeof range.getClientRects).toBe('function');
    expect(typeof range.getBoundingClientRect).toBe('function');
    expect(range.getClientRects()).toHaveLength(0);
    expect(range.getBoundingClientRect()).toMatchObject({
      bottom: 0,
      height: 0,
      left: 0,
      right: 0,
      top: 0,
      width: 0,
      x: 0,
      y: 0,
    });
  });
});
