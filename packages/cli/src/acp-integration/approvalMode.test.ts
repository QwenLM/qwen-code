/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drift detector for the approval-mode triple-source contract:
 *   1. core's `ApprovalMode` enum (the source of truth — drives
 *      `Config.setApprovalMode` and the trust-gate check)
 *   2. core's `APPROVAL_MODES` const array (consumed by daemon route +
 *      ACP extMethod for body validation)
 *   3. SDK's `DAEMON_APPROVAL_MODES` literal tuple (mirrored for SDK
 *      consumers; shape of `DaemonApprovalMode` union)
 *
 * If any of the three drifts (e.g., a future fifth mode added to the
 * enum but not the SDK list), this test fires before runtime and
 * before the protocol docs go out of sync.
 *
 * #4175 Wave 4 PR 17.
 */
import { describe, expect, it } from 'vitest';
import { APPROVAL_MODES, ApprovalMode } from '@qwen-code/qwen-code-core';
import { DAEMON_APPROVAL_MODES } from '@qwen-code/sdk';

describe('approval-mode triple-source drift detection', () => {
  it('APPROVAL_MODES contains every ApprovalMode enum value', () => {
    const enumValues = Object.values(ApprovalMode);
    for (const value of enumValues) {
      expect(APPROVAL_MODES).toContain(value);
    }
    expect(APPROVAL_MODES.length).toBe(enumValues.length);
  });

  it('DAEMON_APPROVAL_MODES (SDK) mirrors core APPROVAL_MODES exactly', () => {
    // Order matters — the SDK test snapshots the advertised sequence so
    // diagnostic UIs that render modes in registration order stay
    // stable across SDK / daemon versions.
    expect([...DAEMON_APPROVAL_MODES]).toEqual([...APPROVAL_MODES]);
  });

  it('DAEMON_APPROVAL_MODES contains every ApprovalMode enum value', () => {
    // Belt-and-suspenders: even if APPROVAL_MODES drifts away from the
    // enum (caught above), this assertion keeps the SDK / enum invariant
    // intact independently.
    const enumValues = new Set<string>(Object.values(ApprovalMode));
    for (const value of DAEMON_APPROVAL_MODES) {
      expect(enumValues.has(value)).toBe(true);
    }
    expect(DAEMON_APPROVAL_MODES.length).toBe(enumValues.size);
  });
});
