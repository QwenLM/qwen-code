// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

describe('web-shell test setup', () => {
  // Pins the ownership the sidebar harness now relies on: setup.ts (which
  // runs before every test module) is the sole installer of the act
  // environment flag and the scrollIntoView shim. The sidebar suites no
  // longer set either themselves, so deleting these from setup.ts would
  // silently strip their "not wrapped in act" detector while staying
  // green — this case goes red instead. jsdom-docblock-only: setup.ts
  // guards the scroll shim with an Element-availability check.
  it('probes the act environment and the scroll shim', () => {
    expect(globalThis.IS_REACT_ACT_ENVIRONMENT).toBe(true);
    expect(typeof Element.prototype.scrollIntoView).toBe('function');
  });

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
