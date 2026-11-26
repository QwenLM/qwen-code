import { describe, expect, it } from 'vitest';
import {
  BROWSER_LAYOUT_TOLERANCE_PX,
  rectanglesAreDisjoint,
} from './rectangles';

const goal = { x: 0, y: 20, width: 10, height: 10 };

describe('rectanglesAreDisjoint', () => {
  it.each([
    {
      name: 'right',
      other: { x: 15, y: 20, width: 10, height: 10 },
      expected: true,
    },
    {
      name: 'left',
      other: { x: -15, y: 20, width: 10, height: 10 },
      expected: true,
    },
    {
      name: 'above',
      other: { x: 0, y: 0, width: 10, height: 10 },
      expected: true,
    },
    {
      name: 'below',
      other: { x: 0, y: 35, width: 10, height: 10 },
      expected: true,
    },
    {
      name: 'overlap',
      other: { x: 5, y: 25, width: 10, height: 10 },
      expected: false,
    },
  ])('handles $name independently', ({ other, expected }) => {
    expect(rectanglesAreDisjoint(goal, other)).toBe(expected);
  });

  it.each([
    {
      name: 'horizontal subpixel overlap',
      other: { x: 9.75, y: 20, width: 10, height: 10 },
    },
    {
      name: 'vertical subpixel overlap',
      other: { x: 0, y: 29.75, width: 10, height: 10 },
    },
  ])('requires an explicit tolerance for $name', ({ other }) => {
    expect(rectanglesAreDisjoint(goal, other)).toBe(false);
    expect(
      rectanglesAreDisjoint(goal, other, BROWSER_LAYOUT_TOLERANCE_PX),
    ).toBe(true);
  });

  it('does not hide a full-pixel overlap behind the tolerance', () => {
    expect(
      rectanglesAreDisjoint(
        goal,
        { x: 9, y: 20, width: 10, height: 10 },
        BROWSER_LAYOUT_TOLERANCE_PX,
      ),
    ).toBe(false);
  });
});
