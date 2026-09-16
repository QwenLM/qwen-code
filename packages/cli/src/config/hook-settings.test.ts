/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { resolveHookSettingsForConfig } from './hook-settings.js';

describe('resolveHookSettingsForConfig', () => {
  const merged = { Stop: [] };
  const user = { PreToolUse: [] };
  const project = { PostToolUse: [] };

  it('loads no hooks when hooks are disabled by bare or safe mode', () => {
    expect(
      resolveHookSettingsForConfig(
        merged,
        { userHooks: user, projectHooks: project },
        true,
      ),
    ).toEqual({
      userHooks: undefined,
      projectHooks: undefined,
      hooks: undefined,
    });
  });

  it('passes separated hooks through and keeps the merged hooks as the legacy field', () => {
    expect(
      resolveHookSettingsForConfig(
        merged,
        { userHooks: user, projectHooks: project },
        false,
      ),
    ).toEqual({ userHooks: user, projectHooks: project, hooks: merged });
  });

  it('falls back to the merged hooks for user hooks when user settings have none', () => {
    const resolved = resolveHookSettingsForConfig(
      merged,
      { userHooks: undefined, projectHooks: project },
      false,
    );

    expect(resolved.userHooks).toBe(merged);
    expect(resolved.projectHooks).toBe(project);
  });

  it('falls back to the merged hooks when no separated hooks were supplied', () => {
    expect(resolveHookSettingsForConfig(merged, undefined, false)).toEqual({
      userHooks: merged,
      projectHooks: undefined,
      hooks: merged,
    });
  });
});
