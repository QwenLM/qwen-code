/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drift detector for `buildAuthPreflightCell`'s env-key map.
 *
 * `AUTH_PREFLIGHT_ENV_KEYS` in `acpAgent.ts` is a hand-maintained mirror of
 * `AUTH_ENV_MAPPINGS` in `core/src/models/constants.ts` — core's table isn't
 * on the public package surface, so cli copies the relevant subset. When a
 * new provider lands in core, this map must be updated (or the new auth
 * method explicitly waived as non-env-based) — otherwise preflight silently
 * reports `status: 'unknown'` for a working provider.
 *
 * This test walks the public `AuthType` enum and asserts every value is
 * either keyed in `AUTH_PREFLIGHT_ENV_KEYS` or listed in
 * `AUTH_PREFLIGHT_WAIVED_AUTH_TYPES`. Adding a new `AuthType` without
 * triaging it here breaks CI loudly instead of degrading silently.
 *
 * Lives in its own file so it can `import` the real `AuthType` enum without
 * fighting the heavy `vi.mock('@qwen-code/qwen-code-core', ...)` block in
 * `acpAgent.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import {
  AUTH_PREFLIGHT_ENV_KEYS,
  AUTH_PREFLIGHT_WAIVED_AUTH_TYPES,
} from './acpAgent.js';

describe('AUTH_PREFLIGHT_ENV_KEYS drift detection', () => {
  it('covers every public AuthType value (either keyed or explicitly waived)', () => {
    const allAuthTypes = Object.values(AuthType) as string[];
    const keyed = new Set(Object.keys(AUTH_PREFLIGHT_ENV_KEYS));

    const uncovered = allAuthTypes.filter(
      (authType) =>
        !keyed.has(authType) && !AUTH_PREFLIGHT_WAIVED_AUTH_TYPES.has(authType),
    );

    // Failure here means a new AuthType value landed in core that hasn't
    // been triaged for the preflight env-key map. For each uncovered
    // entry, either:
    //   - add it to AUTH_PREFLIGHT_ENV_KEYS (env-based auth), OR
    //   - add it to AUTH_PREFLIGHT_WAIVED_AUTH_TYPES (oauth / file-based)
    // in packages/cli/src/acp-integration/acpAgent.ts.
    expect(uncovered).toEqual([]);
  });

  it('does not list waived auth types as keyed', () => {
    // A misconfiguration where a type is in BOTH maps would mean ambiguity.
    const keyed = Object.keys(AUTH_PREFLIGHT_ENV_KEYS);
    const overlap = keyed.filter((k) =>
      AUTH_PREFLIGHT_WAIVED_AUTH_TYPES.has(k),
    );
    expect(overlap).toEqual([]);
  });

  it('every keyed entry has at least one env var candidate', () => {
    // An entry with an empty array is a sentinel for "non-env-based" —
    // belongs in AUTH_PREFLIGHT_WAIVED_AUTH_TYPES instead.
    const empty = Object.entries(AUTH_PREFLIGHT_ENV_KEYS).filter(
      ([, vars]) => vars.length === 0,
    );
    expect(empty).toEqual([]);
  });
});
