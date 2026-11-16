/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MEASURED_WORKSPACE_CAPABILITY_DIGEST,
  MEASURED_WORKSPACE_TERMINAL_CAPABILITY_DIGEST,
  WORKSPACE_CAPABILITY_DIGEST,
  isMeasuredWorkspaceCapability,
  isWorkspaceToolCapability,
} from './managed-workspace-activation.js';

describe('measured workspace capability predicates', () => {
  it('admits both measured profiles and only those', () => {
    expect(
      isMeasuredWorkspaceCapability(MEASURED_WORKSPACE_CAPABILITY_DIGEST),
    ).toBe(true);
    expect(
      isMeasuredWorkspaceCapability(
        MEASURED_WORKSPACE_TERMINAL_CAPABILITY_DIGEST,
      ),
    ).toBe(true);
    expect(isMeasuredWorkspaceCapability(WORKSPACE_CAPABILITY_DIGEST)).toBe(
      false,
    );
    expect(
      isMeasuredWorkspaceCapability(
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ),
    ).toBe(false);
  });

  it('treats the terminal profile as a workspace tool capability', () => {
    expect(
      isWorkspaceToolCapability(MEASURED_WORKSPACE_TERMINAL_CAPABILITY_DIGEST),
    ).toBe(true);
    expect(isWorkspaceToolCapability(WORKSPACE_CAPABILITY_DIGEST)).toBe(true);
  });

  it('derives the terminal digest from the canonical capability string', () => {
    // The Java control plane pins the same hex; a drift here would make the
    // relay refuse every terminal-capable binding.
    expect(MEASURED_WORKSPACE_TERMINAL_CAPABILITY_DIGEST).toBe(
      `sha256:${createHash('sha256')
        .update('managed-workspace-execution/2;web-terminal/1')
        .digest('hex')}`,
    );
  });
});
