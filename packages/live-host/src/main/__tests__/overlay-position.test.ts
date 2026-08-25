import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { overlayPosition } from '../overlay-position.ts';

describe('overlayPosition', () => {
  it('anchors to the bottom right of the selected display work area', () => {
    assert.deepEqual(
      overlayPosition(
        { x: -1_920, y: 23, width: 1_920, height: 1_057 },
        420,
        300,
      ),
      { x: -440, y: 760 },
    );
  });

  it('does not place a window before a tiny work area origin', () => {
    assert.deepEqual(
      overlayPosition({ x: 100, y: 200, width: 200, height: 100 }, 420, 300),
      { x: 100, y: 200 },
    );
  });
});
