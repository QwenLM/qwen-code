/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { SettingScope } from './settings.js';
import { getPersistScopeForModelSelection } from './modelProvidersScope.js';

function makeSettings({
  isTrusted,
  userModelProviders,
  workspaceModelProviders,
}: {
  isTrusted: boolean;
  userModelProviders?: unknown;
  workspaceModelProviders?: unknown;
}) {
  const userSettings: Record<string, unknown> = {};
  const workspaceSettings: Record<string, unknown> = {};

  // When undefined, treat as "not present in this scope" (the key is omitted),
  // matching how LoadedSettings is shaped when a settings file doesn't define it.
  if (userModelProviders !== undefined) {
    userSettings['modelProviders'] = userModelProviders;
  }
  if (workspaceModelProviders !== undefined) {
    workspaceSettings['modelProviders'] = workspaceModelProviders;
  }

  return {
    isTrusted,
    user: { settings: userSettings },
    workspace: { settings: workspaceSettings },
  } as unknown as import('./settings.js').LoadedSettings;
}

describe('getPersistScopeForModelSelection', () => {
  it('prefers workspace when trusted and workspace defines modelProviders', () => {
    const settings = makeSettings({
      isTrusted: true,
      workspaceModelProviders: {},
      userModelProviders: { anything: true },
    });

    expect(getPersistScopeForModelSelection(settings)).toBe(
      SettingScope.Workspace,
    );
  });

  it('falls back to user when workspace does not define modelProviders', () => {
    const settings = makeSettings({
      isTrusted: true,
      workspaceModelProviders: undefined,
      userModelProviders: {},
    });

    expect(getPersistScopeForModelSelection(settings)).toBe(SettingScope.User);
  });

  it('ignores workspace modelProviders when workspace is untrusted', () => {
    const settings = makeSettings({
      isTrusted: false,
      workspaceModelProviders: {},
      userModelProviders: undefined,
    });

    expect(getPersistScopeForModelSelection(settings)).toBe(SettingScope.User);
  });

  it('falls back to legacy trust heuristic when neither scope defines modelProviders', () => {
    const trusted = makeSettings({
      isTrusted: true,
      userModelProviders: undefined,
      workspaceModelProviders: undefined,
    });
    expect(getPersistScopeForModelSelection(trusted)).toBe(SettingScope.User);

    const untrusted = makeSettings({
      isTrusted: false,
      userModelProviders: undefined,
      workspaceModelProviders: undefined,
    });
    expect(getPersistScopeForModelSelection(untrusted)).toBe(SettingScope.User);
  });
});
