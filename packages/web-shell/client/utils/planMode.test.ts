import { describe, expect, it } from 'vitest';
import { EXECUTION_APPROVAL_MODES, parsePlanCommand } from './planMode';

describe('Plan commands', () => {
  it('keeps workflow out of execution permissions', () => {
    expect(EXECUTION_APPROVAL_MODES).toEqual([
      'default',
      'auto-edit',
      'auto',
      'yolo',
    ]);
  });

  it.each([
    ['', false, { enabled: true }],
    ['', true, { enabled: false }],
    [' on ', true, { enabled: true }],
    ['OFF', true, { enabled: false }],
    ['exit', true, { enabled: false }],
    [
      'design this feature',
      false,
      { enabled: true, prompt: 'design this feature' },
    ],
  ])('parses %j from enabled=%s', (args, enabled, expected) => {
    expect(parsePlanCommand(args, enabled)).toEqual(expected);
  });
});
