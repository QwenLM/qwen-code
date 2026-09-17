/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseBwrapStatus, sandboxStatusError } from './bwrap-status.js';

describe('bwrap execution receipts', () => {
  it('turns uncertain and interrupted completion into errors, preserving confirmed nonzero exits', () => {
    expect(sandboxStatusError({ state: 'unconfirmed' })?.message).toContain(
      'may have run; do not automatically retry',
    );
    expect(sandboxStatusError({ state: 'interrupted' })).toBeInstanceOf(Error);
    expect(
      sandboxStatusError({ state: 'confirmed', exitCode: 0 }),
    ).toBeUndefined();
    expect(
      sandboxStatusError({ state: 'confirmed', exitCode: 42 }),
    ).toBeUndefined();
    expect(sandboxStatusError({ state: 'running' })).toBeUndefined();
  });
  it.each([0, 1, 42, 255])(
    'confirms successful exec even when the payload exits %s',
    (code) => {
      expect(
        parseBwrapStatus(
          `{ "child-pid": 120, "pid-namespace": 456 }\n{ "exit-code": ${code} }\n`,
          code,
        ),
      ).toEqual({ state: 'confirmed', exitCode: code });
    },
  );
  it.each([
    '',
    '{ "child-pid": 120 }\n',
    '{ "exit-code": 0 }\n',
    '{ "child-pid": 120 }\n{ "exit-code": 0 }',
    '{ "child-pid": 120 }\n{ "exit-code": 42 }\n',
    '{ "child-pid": 120 }\n{ "exit-code": 0 }\n{ "exit-code": 0 }\n',
    'null\nnull\n',
    '[]\n[]\n',
    'x'.repeat(16385),
  ])(
    'does not infer execution from missing, truncated or conflicting evidence: %s',
    (wire) => {
      expect(parseBwrapStatus(wire, 0)).toEqual({ state: 'unconfirmed' });
    },
  );
});
