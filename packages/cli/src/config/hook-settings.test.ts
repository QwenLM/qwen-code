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

  it('preserves legacy merged hooks not present in the workspace scope', () => {
    const resolved = resolveHookSettingsForConfig(
      merged,
      { userHooks: undefined, projectHooks: project },
      false,
    );

    expect(resolved.userHooks).toEqual(merged);
    expect(resolved.projectHooks).toBe(project);
  });

  it('preserves an explicitly empty project scope instead of falling back to merged hooks', () => {
    const resolved = resolveHookSettingsForConfig(
      user,
      { userHooks: user },
      false,
    );
    expect(resolved.projectHooks).toEqual({});
    expect(resolved.userHooks).toEqual(user);
  });

  it('keeps system hooks while excluding workspace hooks from the user fallback', () => {
    const systemDefinition = {
      hooks: [{ type: 'command', command: 'echo system' }],
    };
    const projectDefinition = {
      hooks: [{ type: 'command', command: 'echo workspace' }],
    };
    const projectHooks = { Stop: [projectDefinition] };
    const mergedHooks = { Stop: [systemDefinition, projectDefinition] };
    expect(
      resolveHookSettingsForConfig(mergedHooks, { projectHooks }, false),
    ).toEqual({
      hooks: mergedHooks,
      userHooks: { Stop: [systemDefinition] },
      projectHooks,
    });
    expect(
      resolveHookSettingsForConfig(projectHooks, { projectHooks }, false)
        .userHooks,
    ).toEqual({ Stop: [] });
    expect(
      resolveHookSettingsForConfig({ Stop: [systemDefinition] }, {}, false)
        .userHooks,
    ).toEqual({ Stop: [systemDefinition] });
  });

  it('falls back to the merged hooks when no separated hooks were supplied', () => {
    expect(resolveHookSettingsForConfig(merged, undefined, false)).toEqual({
      userHooks: merged,
      projectHooks: undefined,
      hooks: merged,
    });
  });
});
