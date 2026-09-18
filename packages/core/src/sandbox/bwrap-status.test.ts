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
  // payloadExitObserved is a three-way attestation and the test must
  // discriminate all three: true = the wire carries a well-formed bwrap
  // exit-code record (payload ran; retain), false = positively attested
  // no-exec (safe to clean up), undefined/absent = unknown (oversized or
  // partial wire — must never be collapsed into "did not run", PR #12067
  // review round 2).
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
      // Strict identity: an absent field must stay absent, not coerce to
      // false — the finalizer and the caller-facing message treat those
      // two differently.
      expect(observed).toBe(payloadExitObserved);
      expect('payloadExitObserved' in status).toBe(
        payloadExitObserved !== undefined,
      );
    },
  );
});
