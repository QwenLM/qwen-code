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
    // A receipt that positively attests the payload never exec'd gets the
    // actionable setup-failure message instead (PR #12067 review N4).
    expect(
      sandboxStatusError({ state: 'unconfirmed', payloadExitObserved: false })
        ?.message,
    ).toContain('did not run');
    expect(
      sandboxStatusError({ state: 'unconfirmed', payloadExitObserved: true })
        ?.message,
    ).toContain('may have run');
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
  // payloadExitObserved marks whether the wire carries a well-formed bwrap
  // exit-code record — bwrap only emits it once the payload is past exec,
  // so it separates "payload ran but evidence is inconclusive" (retain the
  // dirs) from "setup failed before exec" (safe to clean up).
  it.each([
    ['', undefined],
    ['{ "child-pid": 120 }\n', false],
    ['{ "exit-code": 0 }\n', true],
    ['{ "child-pid": 120 }\n{ "exit-code": 0 }', undefined],
    ['{ "child-pid": 120 }\n{ "exit-code": 42 }\n', true],
    ['{ "child-pid": 120 }\n{ "exit-code": 0 }\n{ "exit-code": 0 }\n', true],
    ['null\nnull\n', false],
    ['[]\n[]\n', false],
    ['x'.repeat(16385), undefined],
  ])(
    'does not infer execution from missing, truncated or conflicting evidence: %s',
    (wire, payloadExitObserved) => {
      const status = parseBwrapStatus(wire, 0);
      expect(status.state).toBe('unconfirmed');
      const observed =
        status.state === 'unconfirmed' ? status.payloadExitObserved : undefined;
      expect(observed ?? false).toBe(payloadExitObserved ?? false);
    },
  );
});
