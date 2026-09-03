/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { skillRestrictionNames } from '@qwen-code/qwen-code-core';
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

/**
 * Finds the settings entry a surface should blame for a skill, in a map keyed
 * by settings-entry name.
 *
 * A restriction blocks a skill under either spelling — `name` is the registry
 * identity and carries the extension prefix, `authoredName` is what an existing
 * entry may hold from before that prefix existed — so a lookup that keys on one
 * of them silently reports "nothing blocks this". The wrong reason, or no
 * reason, on a row the config has already gated: the picker then offers a
 * toggle that appears to do nothing. `skillRestrictionNames` already returns
 * both spellings normalized and registry-first, so there is nothing to
 * re-normalize here and the registry-name entry wins a tie.
 */
export function lookupSkillSetting<T>(
  entries: ReadonlyMap<string, T>,
  skill: { name: string; authoredName?: string },
): T | undefined {
  for (const name of skillRestrictionNames(skill)) {
    const found = entries.get(name);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function lookupSkillDisablement(
  disablements: ReadonlyMap<string, SkillDisablement>,
  skill: { name: string; authoredName?: string },
): SkillDisablement | undefined {
  // A hard block beats a default one whichever spelling carries it; the
  // registry-first walk would otherwise report the weaker entry in
  // mixed-spelling states. Among hard entries, one carrying lockedScope
  // names the scope the user has to edit, so it wins over an unlocked
  // hard entry either spelling holds.
  let fallback: SkillDisablement | undefined;
  let hard: SkillDisablement | undefined;
  for (const name of skillRestrictionNames(skill)) {
    const found = disablements.get(name);
    if (found?.reason === 'hard') {
      if (found.lockedScope) return found;
      hard ??= found;
      continue;
    }
    fallback ??= found;
  }
  return hard ?? fallback;
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
): WorkspaceSkillSettingLists {
  if (enabled) {
    return {
      disabled: updateTarget(lists.disabled, skillName, false),
      enabled: updateTarget(lists.enabled, skillName, true),
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
 * The seed lists are the workspace's current entries. Orphaned entries and
 * declarations duplicated at a higher scope are preserved verbatim: only the
 * toggled, currently-loaded skills passed in `toggles` mutate the lists.
 */
export function computeWorkspaceSkillListUpdates(
  workspaceDisabled: readonly string[],
  workspaceEnabled: readonly string[],
  toggles: readonly WorkspaceSkillListToggle[],
): WorkspaceSkillListUpdates {
  const previousDisabled = [...workspaceDisabled];
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
