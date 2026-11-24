import { describe, expect, it } from 'vitest';
import {
  EXECUTION_APPROVAL_MODES,
  parsePlanCommand,
  resolveApprovalModes,
} from './planMode';

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

describe('approval mode choices', () => {
  it.each([undefined, null, 'auto', {}])(
    'defaults malformed or absent %j to all modes',
    (value) => {
      expect(resolveApprovalModes(value)).toEqual([
        'default',
        'auto-edit',
        'auto',
        'yolo',
      ]);
    },
  );

  it('keeps canonical order and ignores duplicates, unknown values and Plan', () => {
    expect(
      resolveApprovalModes(['auto', 'plan', 'default', 'auto', 'bogus']),
    ).toEqual(['default', 'auto']);
  });

  it.each([{ values: [] }, { values: ['plan', 'bogus'] }])(
    'offers no modes for $values',
    ({ values }) => {
      expect(resolveApprovalModes(values)).toEqual([]);
    },
  );

  // Host-skew pin: the vocabulary is a build-time mirror of the SDK list, so
  // a host SDK advertising an extra mode has it dropped by the sanitizing
  // intersection (same rule as 'bogus' above). In-repo drift is pinned by
  // constants/approvalModes.test.ts; cross-version skew is a documented
  // limitation, not a silent surprise.
  it('drops modes a newer host SDK advertises beyond the mirror', () => {
    expect(resolveApprovalModes(['plan', 'readonly'])).toEqual([]);
    expect(resolveApprovalModes(['default', 'readonly'])).toEqual(['default']);
  });
});
