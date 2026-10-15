/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  APPROVAL_MODE_INFO,
  APPROVAL_MODES,
  AuthType,
} from '@qwen-code/qwen-code-core';
import { DEFAULT_COMMAND_OPTIONS } from './top-level-options.js';

// top-level-options.ts mirrors core's ApprovalMode and AuthType as literals so
// the bootstrap entry never pulls the core barrel into its import closure. Its
// `satisfies` checks and Record witnesses catch a member core adds or removes,
// but not a member whose VALUE or description core rewords — that would ship a
// silently stale `qwen --help`. Tests carry no bootstrap cost, so they can
// import core directly and pin the copies against the real thing.
describe('shared option definitions stay in sync with core', () => {
  it('mirrors core ApprovalMode values in the --approval-mode choices', () => {
    expect(DEFAULT_COMMAND_OPTIONS['approval-mode'].choices).toEqual(
      APPROVAL_MODES,
    );
  });

  it('mirrors core approval-mode descriptions in the --approval-mode help', () => {
    const expected = `Set the approval mode: ${APPROVAL_MODES.map(
      (mode) => `${mode} (${APPROVAL_MODE_INFO[mode].description})`,
    ).join(', ')}`;

    expect(DEFAULT_COMMAND_OPTIONS['approval-mode'].description).toBe(expected);
  });

  it('mirrors core AuthType values in the --auth-type choices', () => {
    // Compared as sets: the help output deliberately lists these in a
    // different order than core declares them, and that order is part of the
    // pre-existing help text this PR keeps unchanged.
    const choices: readonly string[] =
      DEFAULT_COMMAND_OPTIONS['auth-type'].choices;

    expect([...choices].sort()).toEqual([...Object.values(AuthType)].sort());
  });
});
