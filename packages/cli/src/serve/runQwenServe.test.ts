/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  extractContextFilename,
  InvalidPolicyConfigError,
  validatePolicyConfig,
} from './runQwenServe.js';

/**
 * #4297 fold-in 7 (deepseek S1, addresses #3262690842). Lock the
 * `context.fileName` extraction logic so a regression doesn't
 * silently re-enable the P2-1 bug (init writes default `QWEN.md`
 * even when the workspace configured `AGENTS.md` etc.). The four
 * branches the suggestion called out are exercised explicitly here;
 * the runQwenServe boot path itself stays integration-tested
 * end-to-end via the daemon-process tests in
 * `integration-tests/cli/qwen-serve-routes.test.ts`.
 */
describe('extractContextFilename (#4297 fold-in 7 P2-1 helper)', () => {
  it('returns a trimmed string when given a non-empty string', () => {
    expect(extractContextFilename('AGENTS.md')).toBe('AGENTS.md');
    expect(extractContextFilename('  CUSTOM.md  ')).toBe('CUSTOM.md');
  });

  it('returns undefined for empty / whitespace-only strings', () => {
    expect(extractContextFilename('')).toBeUndefined();
    expect(extractContextFilename('   ')).toBeUndefined();
    expect(extractContextFilename('\n\t')).toBeUndefined();
  });

  it('returns the first non-empty string when given an array', () => {
    expect(extractContextFilename(['AGENTS.md', 'BACKUP.md'])).toBe(
      'AGENTS.md',
    );
    // Skips empty and whitespace entries to find the first valid name.
    expect(extractContextFilename(['', '  ', 'PRIMARY.md', 'OTHER.md'])).toBe(
      'PRIMARY.md',
    );
    // Trims the picked element.
    expect(extractContextFilename(['  CUSTOM.md  '])).toBe('CUSTOM.md');
  });

  it('returns undefined when the array has no string entries', () => {
    expect(extractContextFilename([])).toBeUndefined();
    expect(extractContextFilename(['', '  ', '\n'])).toBeUndefined();
    // Non-string entries are filtered out — when nothing valid remains,
    // the bridge falls back to its own default.
    expect(
      extractContextFilename([null, undefined, 42, { a: 1 }] as unknown[]),
    ).toBeUndefined();
  });

  it('returns undefined for non-string non-array inputs', () => {
    // Hand-edited `settings.json` could land any of these shapes;
    // the helper must NOT coerce (avoids the literal `[object Object]`
    // filename that the previous `String(...)` cast produced).
    expect(extractContextFilename(undefined)).toBeUndefined();
    expect(extractContextFilename(null)).toBeUndefined();
    expect(extractContextFilename(42)).toBeUndefined();
    expect(extractContextFilename(true)).toBeUndefined();
    expect(extractContextFilename({ fileName: 'AGENTS.md' })).toBeUndefined();
  });
});

/**
 * Wenshao review #4335 / 3272493818 — positive tests for the
 * `validatePolicyConfig` helper. Lock the contract so a future
 * refactor can't silently remove the `InvalidPolicyConfigError`
 * class or the validation paths.
 */
describe('validatePolicyConfig (#4335 boot validation)', () => {
  it('returns undefined for both fields when policyConfig is empty', () => {
    expect(validatePolicyConfig()).toEqual({
      permissionPolicy: undefined,
      permissionConsensusQuorum: undefined,
    });
    expect(validatePolicyConfig({})).toEqual({
      permissionPolicy: undefined,
      permissionConsensusQuorum: undefined,
    });
  });

  it.each([['first-responder'], ['designated'], ['consensus'], ['local-only']])(
    'accepts the %s permissionStrategy literal',
    (literal) => {
      expect(validatePolicyConfig({ permissionStrategy: literal })).toEqual({
        permissionPolicy: literal,
        permissionConsensusQuorum: undefined,
      });
    },
  );

  it('throws InvalidPolicyConfigError for an unknown permissionStrategy', () => {
    expect(() => validatePolicyConfig({ permissionStrategy: 'bogus' })).toThrow(
      InvalidPolicyConfigError,
    );
    expect(() => validatePolicyConfig({ permissionStrategy: 'bogus' })).toThrow(
      /invalid policy.permissionStrategy/,
    );
  });

  it.each([0, -1, 1.5, Number.NaN])(
    'throws InvalidPolicyConfigError for non-positive-integer consensusQuorum (%s)',
    (badValue) => {
      expect(() =>
        validatePolicyConfig({
          permissionStrategy: 'consensus',
          consensusQuorum: badValue,
        }),
      ).toThrow(InvalidPolicyConfigError);
    },
  );

  it('accepts a positive-integer consensusQuorum with consensus strategy', () => {
    expect(
      validatePolicyConfig({
        permissionStrategy: 'consensus',
        consensusQuorum: 3,
      }),
    ).toEqual({
      permissionPolicy: 'consensus',
      permissionConsensusQuorum: 3,
    });
  });

  it('warns AND drops consensusQuorum when strategy is not consensus (#4335 / 3273077270)', () => {
    // Wenshao review #4335 / 3273077270 — public contract now
    // matches the warning text: when the operator sets
    // consensusQuorum alongside a non-consensus strategy, the
    // override is dropped (returned as undefined) so the
    // BridgeOptions surface stays consistent with what the warning
    // tells them. Pre-fix the function still propagated the value;
    // the downstream mediator ignored it but the function-level
    // contract contradicted itself.
    const warnings: string[] = [];
    const onWarning = vi.fn((m: string) => warnings.push(m));
    const result = validatePolicyConfig(
      {
        permissionStrategy: 'designated',
        consensusQuorum: 2,
      },
      onWarning,
    );
    expect(result).toEqual({
      permissionPolicy: 'designated',
      permissionConsensusQuorum: undefined,
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('consensusQuorum is set');
    expect(warnings[0]).toContain('not "consensus"');
  });

  it('does not warn when consensusQuorum is set with consensus strategy', () => {
    const onWarning = vi.fn();
    validatePolicyConfig(
      { permissionStrategy: 'consensus', consensusQuorum: 2 },
      onWarning,
    );
    expect(onWarning).not.toHaveBeenCalled();
  });

  it('error messages name the field that failed (operator-debugging signal)', () => {
    expect(() => validatePolicyConfig({ permissionStrategy: 'oops' })).toThrow(
      /permissionStrategy/,
    );
    expect(() => validatePolicyConfig({ consensusQuorum: 0 })).toThrow(
      /consensusQuorum/,
    );
  });
});
