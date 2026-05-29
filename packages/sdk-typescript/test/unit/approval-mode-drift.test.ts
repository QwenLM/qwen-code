/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drift detector for the SDK ↔ core approval-mode contract.
 *
 * Two sources of truth converge here:
 *   1. core's `APPROVAL_MODES` const array (= `Object.values(ApprovalMode)`,
 *      consumed by `Config.setApprovalMode` and the daemon route's body
 *      validator)
 *   2. SDK's `DAEMON_APPROVAL_MODES` literal tuple (mirrored for SDK
 *      consumers; backs the `DaemonApprovalMode` union)
 *
 * The third source — the `ApprovalMode` enum itself — is structurally
 * tied to `APPROVAL_MODES` via `Object.values(ApprovalMode)` at the
 * core's definition site, so there's no separate assertion needed for
 * it: `APPROVAL_MODES` is always a 1:1 mirror by construction.
 *
 * If `DAEMON_APPROVAL_MODES` drifts away from `APPROVAL_MODES` (e.g. a
 * future fifth mode added to the enum but not the SDK list), this test
 * fires before runtime and before the protocol docs go out of sync.
 *
 * Lives in the SDK package (not the CLI) because the SDK already
 * depends on `@qwen-code/qwen-code-core`, so all three identifiers are
 * visible — and this is the package whose contract the test is
 * actually pinning.
 *
 * #4175 Wave 4 PR 17 (#4282 fold-in 1, wenshao review).
 */
import { describe, expect, it } from 'vitest';
import { APPROVAL_MODES } from '@qwen-code/qwen-code-core';
import { DAEMON_APPROVAL_MODES } from '../../src/index.js';

describe('approval-mode SDK ↔ core drift detection', () => {
  it('DAEMON_APPROVAL_MODES (SDK) mirrors core APPROVAL_MODES exactly', () => {
    // Order matters — diagnostic UIs that render modes in registration
    // order stay stable across SDK / daemon versions only when the two
    // tuples are sequence-equal, not just set-equal.
    expect([...DAEMON_APPROVAL_MODES]).toEqual([...APPROVAL_MODES]);
  });
});
