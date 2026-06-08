/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { applySkillAllowedTools } from './skill-utils.js';
import type { PermissionManager } from '../permissions/permission-manager.js';

function mockPermissionManager(): {
  pm: PermissionManager;
  addSessionAllowRule: ReturnType<typeof vi.fn>;
} {
  const addSessionAllowRule = vi.fn();
  return {
    pm: { addSessionAllowRule } as unknown as PermissionManager,
    addSessionAllowRule,
  };
}

describe('applySkillAllowedTools', () => {
  it('adds one session allow rule per entry, verbatim and in order', () => {
    const { pm, addSessionAllowRule } = mockPermissionManager();

    applySkillAllowedTools(pm, ['Bash(git *)', 'Edit', 'mcp__server__tool']);

    expect(addSessionAllowRule).toHaveBeenCalledTimes(3);
    expect(addSessionAllowRule).toHaveBeenNthCalledWith(1, 'Bash(git *)');
    expect(addSessionAllowRule).toHaveBeenNthCalledWith(2, 'Edit');
    expect(addSessionAllowRule).toHaveBeenNthCalledWith(3, 'mcp__server__tool');
  });

  it('no-ops when allowedTools is undefined', () => {
    const { pm, addSessionAllowRule } = mockPermissionManager();
    applySkillAllowedTools(pm, undefined);
    expect(addSessionAllowRule).not.toHaveBeenCalled();
  });

  it('no-ops when allowedTools is empty', () => {
    const { pm, addSessionAllowRule } = mockPermissionManager();
    applySkillAllowedTools(pm, []);
    expect(addSessionAllowRule).not.toHaveBeenCalled();
  });

  it('no-ops without throwing when there is no permission manager', () => {
    expect(() => applySkillAllowedTools(null, ['Bash(git *)'])).not.toThrow();
    expect(() =>
      applySkillAllowedTools(undefined, ['Bash(git *)']),
    ).not.toThrow();
  });

  it('delegates malformed-entry handling to the permission manager (does not pre-filter)', () => {
    // The permission manager is the single authority on rule validity; the
    // helper forwards every entry and lets addSessionAllowRule log/skip bad
    // ones. This keeps validation in one place.
    const { pm, addSessionAllowRule } = mockPermissionManager();
    applySkillAllowedTools(pm, ['Bash(unbalanced', 'Read']);
    expect(addSessionAllowRule).toHaveBeenCalledTimes(2);
    expect(addSessionAllowRule).toHaveBeenNthCalledWith(1, 'Bash(unbalanced');
    expect(addSessionAllowRule).toHaveBeenNthCalledWith(2, 'Read');
  });
});
