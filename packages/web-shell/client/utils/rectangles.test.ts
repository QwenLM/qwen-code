import { describe, expect, it } from 'vitest';
import { rectanglesAreDisjoint } from './rectangles';

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
});
