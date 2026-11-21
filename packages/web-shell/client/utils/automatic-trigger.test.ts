import { describe, expect, it } from 'vitest';
import {
  isAutomaticTriggerSource,
  isDetailFreeAutomaticEcho,
} from './automatic-trigger';

const ECHOES = [
  'Autonomous loop tick',
  'Loop tick — tasks from project loop.md',
  'Loop tick — tasks from home loop.md',
  'Loop tick — loop.md temporarily unavailable',
];

describe('automatic-trigger guards', () => {
  it('shares the exact source vocabulary', () => {
    expect(['cron', 'loop'].every(isAutomaticTriggerSource)).toBe(true);
    expect(
      [undefined, 'goal_runtime', 'user'].every(isAutomaticTriggerSource),
    ).toBe(false);
  });

  it.each(ECHOES)('recognizes only the complete runtime echo %s', (content) => {
    expect(isDetailFreeAutomaticEcho(content)).toBe(true);
  });

  it.each([
    ...ECHOES.map((echo) => `${echo}\nFINAL-MARKER`),
    'Loop tick — tasks from an unknown source',
    'Loop tick — real instruction',
  ])('keeps details for non-echo input', (content) => {
    expect(isDetailFreeAutomaticEcho(content)).toBe(false);
  });
});
