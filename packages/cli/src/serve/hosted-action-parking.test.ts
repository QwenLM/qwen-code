/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { hostedApprovalResumeShapeRefusal } from './hosted-action-parking.js';

describe('hostedApprovalResumeShapeRefusal', () => {
  const broker = {};
  const files = { toolProfile: 'hosted-workspace-files/1' };

  it('admits a tool profile with a Broker and a memory-only Session', () => {
    expect(hostedApprovalResumeShapeRefusal(files, broker)).toBeUndefined();
    expect(
      hostedApprovalResumeShapeRefusal({ memory: {} }, undefined),
    ).toBeUndefined();
  });

  it('names Hooks before MCP, and both before the tool owner', () => {
    expect(
      hostedApprovalResumeShapeRefusal({ hooks: {}, mcp: {} }, undefined),
    ).toBe('hooks');
    expect(
      hostedApprovalResumeShapeRefusal({ ...files, mcp: {} }, broker),
    ).toBe('mcp');
  });

  it('refuses a Session with no tool owner to resume through', () => {
    expect(hostedApprovalResumeShapeRefusal(files, undefined)).toBe(
      'no_tool_owner',
    );
    expect(hostedApprovalResumeShapeRefusal({}, broker)).toBe('no_tool_owner');
  });
});
