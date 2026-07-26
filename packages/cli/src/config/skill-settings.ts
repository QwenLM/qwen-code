/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { SettingScope, type LoadedSettings } from './settings.js';

export interface SkillDisablement {
  reason: 'hard' | 'default';
  lockedScope?: 'system' | 'user' | 'systemDefaults';
}

export type SkillSettingListKey = 'disabled' | 'defaultDisabled' | 'enabled';

export interface ResolvedSkillSettings {
  disabledNames: ReadonlySet<string>;
  defaultDisabledNames: ReadonlySet<string>;
  enabledNames: ReadonlySet<string>;
  disablements: ReadonlyMap<string, SkillDisablement>;
}

interface WorkspaceSkillSettingLists {
  disabled: string[];
  enabled: string[];
}

export function normalizeSkillNames(value: unknown): Set<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value
      .filter((name): name is string => typeof name === 'string')
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function skillSettingStrings(
  settings: LoadedSettings,
  scope: SettingScope,
  key: SkillSettingListKey,
): string[] {
  const value = settings.forScope(scope).settings.skills?.[key];
  return Array.isArray(value)
    ? value.filter((name): name is string => typeof name === 'string')
    : [];
}

export function resolveSkillSettings(
  settings: LoadedSettings,
): ResolvedSkillSettings {
  const hardDisabled = normalizeSkillNames(settings.merged.skills?.disabled);
  const defaultDisabled = normalizeSkillNames(
    settings.merged.skills?.defaultDisabled,
  );
  const enabled = normalizeSkillNames(settings.merged.skills?.enabled);
  const disablements = new Map<string, SkillDisablement>();

  for (const name of defaultDisabled) {
    if (!enabled.has(name)) disablements.set(name, { reason: 'default' });
  }

  const lockedScopes = [
    [SettingScope.SystemDefaults, 'systemDefaults'],
    [SettingScope.User, 'user'],
    [SettingScope.System, 'system'],
  ] as const;
  const lockedByName = new Map<
    string,
    NonNullable<SkillDisablement['lockedScope']>
  >();
  for (const [scope, label] of lockedScopes) {
    for (const name of normalizeSkillNames(
      skillSettingStrings(settings, scope, 'disabled'),
    )) {
      lockedByName.set(name, label);
    }
  }

  for (const name of hardDisabled) {
    const lockedScope = lockedByName.get(name);
    disablements.set(name, {
      reason: 'hard',
      ...(lockedScope ? { lockedScope } : {}),
    });
  }

  return {
    disabledNames: new Set(disablements.keys()),
    defaultDisabledNames: defaultDisabled,
    enabledNames: enabled,
    disablements,
  };
}

function updateTarget(
  names: string[],
  skillName: string,
  include: boolean,
): string[] {
  const normalizedName = skillName.trim().toLowerCase();
  const next: string[] = [];
  let found = false;
  for (const name of names) {
    if (name.trim().toLowerCase() !== normalizedName) {
      next.push(name);
    } else if (include && !found) {
      next.push(skillName);
      found = true;
    }
  }
  if (include && !found) next.push(skillName);
  return next;
}

export function updateWorkspaceSkillSettingLists(
  lists: WorkspaceSkillSettingLists,
  skillName: string,
  enabled: boolean,
  defaultDisabled: boolean,
): WorkspaceSkillSettingLists {
  const normalizedName = skillName.trim().toLowerCase();
  const hadExplicitEnable = lists.enabled.some(
    (name) => name.trim().toLowerCase() === normalizedName,
  );

  if (enabled) {
    return {
      disabled: updateTarget(lists.disabled, skillName, false),
      enabled:
        defaultDisabled || hadExplicitEnable
          ? updateTarget(lists.enabled, skillName, true)
          : lists.enabled,
    };
  }

  return {
    disabled: updateTarget(lists.disabled, skillName, true),
    enabled: updateTarget(lists.enabled, skillName, false),
  };
}

export interface WorkspaceSkillListToggle {
  name: string;
  wasEnabled: boolean;
  isEnabled: boolean;
  /** Record an explicit `skills.enabled` opt-in when enabling this skill. */
  defaultDisabled: boolean;
}

export interface WorkspaceSkillListUpdates {
  disabled: string[];
  enabled: string[];
  disabledChanged: boolean;
  enabledChanged: boolean;
}

/**
 * Computes the workspace `skills.disabled` / `skills.enabled` lists the skills
 * picker should persist after a set of toggle changes.
 *
 * The seed lists are the workspace's current entries. Locked skills (disabled
 * at a higher scope) are dropped from the seed so we never re-emit redundant
 * entries the higher scope already enforces. Orphaned entries — workspace
 * disables for skills not currently loaded (a different git branch, an
 * uninstalled extension, a deleted skills dir) — are preserved verbatim: only
 * the toggled, currently-loaded skills passed in `toggles` mutate the lists.
 * That preservation is load-bearing; the orphan case is pinned by a test in
 * `skill-settings.test.ts`.
 */
export function computeWorkspaceSkillListUpdates(
  workspaceDisabled: readonly string[],
  lockedNames: ReadonlySet<string>,
  workspaceEnabled: readonly string[],
  toggles: readonly WorkspaceSkillListToggle[],
): WorkspaceSkillListUpdates {
  const previousDisabled = workspaceDisabled.filter(
    (name) => !lockedNames.has(name.trim().toLowerCase()),
  );
  const previousEnabled = [...workspaceEnabled];
  let next: WorkspaceSkillSettingLists = {
    disabled: previousDisabled,
    enabled: previousEnabled,
  };
  for (const toggle of toggles) {
    if (toggle.wasEnabled === toggle.isEnabled) continue;
    next = updateWorkspaceSkillSettingLists(
      next,
      toggle.name,
      toggle.isEnabled,
      toggle.defaultDisabled,
    );
  }
  return {
    disabled: next.disabled,
    enabled: next.enabled,
    disabledChanged:
      JSON.stringify(previousDisabled) !== JSON.stringify(next.disabled),
    enabledChanged:
      JSON.stringify(previousEnabled) !== JSON.stringify(next.enabled),
  };
}
