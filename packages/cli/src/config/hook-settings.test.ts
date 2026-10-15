/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { resolveHookSettingsForConfig } from './hook-settings.js';

describe('resolveHookSettingsForConfig', () => {
  const merged = { Stop: [] };
  const system = { SessionStart: [] };
  const user = { PreToolUse: [] };
  const project = { PostToolUse: [] };

  it('loads no hooks when hooks are disabled by bare or safe mode', () => {
    expect(
      resolveHookSettingsForConfig(
        merged,
        { systemHooks: system, userHooks: user, projectHooks: project },
        true,
      ),
    ).toEqual({
      systemHooks: undefined,
      userHooks: undefined,
      projectHooks: undefined,
      hooks: undefined,
    });
  });

  it('passes every scope through and drops the merged hooks once scopes are supplied', () => {
    const resolved = resolveHookSettingsForConfig(
      merged,
      { systemHooks: system, userHooks: user, projectHooks: project },
      false,
    );

    expect(resolved).toEqual({
      systemHooks: system,
      userHooks: user,
      projectHooks: project,
      hooks: undefined,
    });
    expect(resolved.systemHooks).toBe(system);
    expect(resolved.userHooks).toBe(user);
    expect(resolved.projectHooks).toBe(project);
  });

  it('does not fill a scope without hooks from the merged hooks', () => {
    // The merged hooks contain the system and user scopes too; reading them
    // as user hooks mislabelled system hooks and registered them twice.
    const resolved = resolveHookSettingsForConfig(
      merged,
      { systemHooks: undefined, userHooks: undefined, projectHooks: project },
      false,
    );

    expect(resolved.userHooks).toBeUndefined();
    expect(resolved.systemHooks).toBeUndefined();
    expect(resolved.projectHooks).toBe(project);
    expect(resolved.hooks).toBeUndefined();
  });

  it('falls back to the merged hooks only when no separated hooks were supplied', () => {
    const resolved = resolveHookSettingsForConfig(merged, undefined, false);

    expect(resolved).toEqual({ hooks: merged });
    expect(resolved.hooks).toBe(merged);
    expect(resolved.systemHooks).toBeUndefined();
    expect(resolved.userHooks).toBeUndefined();
    expect(resolved.projectHooks).toBeUndefined();
  });
});
