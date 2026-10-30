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

export interface SkillToggleBlock {
  reason: 'hard' | 'default';
  list: 'disabled' | 'defaultDisabled';
  entry: string;
  scope: 'SystemDefaults' | 'User' | 'Workspace' | 'System';
}

/** Settings scopes a skill toggle can write. */
export type SkillToggleTargetScope = SettingScope.User | SettingScope.Workspace;

/**
 * Decides whether a workspace toggle can change a skill's state at all, and
 * names the entry that forbids it when it cannot.
 *
 * A skill's registry identity carries its extension prefix while an entry
 * written before that prefix existed holds the authored spelling, so both
 * are checked — a miss here renders a locked skill as a toggleable row, or
 * lets a surface that writes settings report an enable the config still
 * forbids. Entries the toggle cannot cancel lock the row the same way a
 * higher scope does: a bare disablement keeps gating under either spelling,
 * and only an `enabled` entry identical to a `defaultDisabled` one cancels
 * it at resolve time. `lockedIn` labels the block for the picker row;
 * `blockIn` returns the same decision structured, for callers that persist
 * settings and must answer with more than a label. Workspace entries join
 * the inputs only while the workspace is trusted — the merge drops it
 * otherwise, so an untrusted repo's stale entries disable nothing.
 *
 * `target` is the scope the toggle writes. A User toggle answers for every
 * workspace at once, so Workspace entries never block it: they keep gating
 * only their own workspace, and the User file's own entries are the ones
 * the toggle edits rather than a higher lock.
 *
 * `writtenName` is the spelling the pending write records when it differs
 * from the catalog identity (`pdf` for `rust:pdf`). `writtenNames` lists the
 * spellings that write removes from the target scope; the self-removal
 * exemptions below key on them, so only an entry the write actually removes
 * or cancels may stop blocking, while every spelling of the identity is
 * still searched in the higher scopes.
 */
export function buildHigherDisabled(
  settings: LoadedSettings,
  target: SkillToggleTargetScope = SettingScope.Workspace,
): {
  lockedIn: (skill: { name: string; authoredName?: string }) => string | null;
  blockIn: (skill: {
    name: string;
    authoredName?: string;
    writtenName?: string;
    writtenNames?: readonly string[];
  }) => SkillToggleBlock | null;
} {
  const targetLabel: SkillToggleBlock['scope'] =
    target === SettingScope.User ? 'User' : 'Workspace';
  const includeWorkspace =
    target === SettingScope.Workspace && settings.isTrusted;
  // Inserted lowest-precedence first so the highest scope that names an
  // entry wins. SystemDefaults < User < Workspace < System matches the
  // merge order in `settings.ts`.
  const scopeOfEntry = new Map<string, SkillToggleBlock['scope']>();
  for (const [scope, label] of [
    [SettingScope.SystemDefaults, 'SystemDefaults'],
    [SettingScope.User, 'User'],
    [SettingScope.System, 'System'],
  ] as const) {
    if (scope === target) continue;
    for (const name of normalizeSkillNames(
      skillSettingStrings(settings, scope, 'disabled'),
    )) {
      scopeOfEntry.set(name, label);
    }
  }
  const hardEntries = new Map<string, SkillToggleBlock['scope']>();
  const defaultEntries = new Map<string, SkillToggleBlock['scope']>();
  for (const [scope, label] of [
    [SettingScope.SystemDefaults, 'SystemDefaults'],
    [SettingScope.User, 'User'],
    [SettingScope.Workspace, 'Workspace'],
    [SettingScope.System, 'System'],
  ] as const) {
    if (scope === SettingScope.Workspace && !includeWorkspace) continue;
    for (const name of normalizeSkillNames(
      skillSettingStrings(settings, scope, 'disabled'),
    )) {
      hardEntries.set(name, label);
    }
    for (const name of normalizeSkillNames(
      skillSettingStrings(settings, scope, 'defaultDisabled'),
    )) {
      defaultEntries.set(name, label);
    }
  }
  const enabledEntries = new Set(
    (
      [
        SettingScope.SystemDefaults,
        SettingScope.User,
        SettingScope.System,
        ...(includeWorkspace ? [SettingScope.Workspace] : []),
      ] as SettingScope[]
    ).flatMap((scope) => [
      ...normalizeSkillNames(skillSettingStrings(settings, scope, 'enabled')),
    ]),
  );
  const targetDisabled = new Set(
    target === SettingScope.User || includeWorkspace
      ? normalizeSkillNames(skillSettingStrings(settings, target, 'disabled'))
      : [],
  );
  const targetDefaultDisabled = new Set(
    target === SettingScope.User || includeWorkspace
      ? normalizeSkillNames(
          skillSettingStrings(settings, target, 'defaultDisabled'),
        )
      : [],
  );
  // Entries outside the target scope survive the write. A higher default
  // entry under the same spelling is cancelled only by an identically
  // spelled grant, so it still blocks once the target entry is removed.
  const higherDefaultScopes = new Map<string, SkillToggleBlock['scope']>();
  for (const [scope, label] of [
    [SettingScope.SystemDefaults, 'SystemDefaults'],
    [SettingScope.User, 'User'],
    [SettingScope.Workspace, 'Workspace'],
    [SettingScope.System, 'System'],
  ] as const) {
    if (
      scope === target ||
      (scope === SettingScope.Workspace && !includeWorkspace)
    ) {
      continue;
    }
    for (const name of normalizeSkillNames(
      skillSettingStrings(settings, scope, 'defaultDisabled'),
    )) {
      higherDefaultScopes.set(name, label);
    }
  }
  const blockIn = (skill: {
    name: string;
    authoredName?: string;
    writtenName?: string;
    writtenNames?: readonly string[];
  }): SkillToggleBlock | null => {
    const written = (skill.writtenName ?? skill.name).trim().toLowerCase();
    const writtenNames = new Set(
      (skill.writtenNames ?? [skill.writtenName ?? skill.name]).map((name) =>
        name.trim().toLowerCase(),
      ),
    );
    const spellings = skillRestrictionNames(skill);
    // A higher-scope hard entry wins the blame before any nearer one:
    // deleting the workspace file's copy cannot unlock while it stands.
    for (const spelling of spellings) {
      const scope = scopeOfEntry.get(spelling);
      if (scope) {
        return { reason: 'hard', list: 'disabled', entry: spelling, scope };
      }
    }
    for (const spelling of spellings) {
      const hard = hardEntries.get(spelling);
      // Removing a spelling the write names can expose a default entry the
      // same spelling carries, so the default check below still runs.
      if (
        hard &&
        !(writtenNames.has(spelling) && targetDisabled.has(spelling))
      ) {
        return {
          reason: 'hard',
          list: 'disabled',
          entry: spelling,
          scope: hard,
        };
      }
      const def = defaultEntries.get(spelling);
      if (def) {
        // A grant identical to the entry cancels it at resolve time — the
        // persisted qualified one, or any identical-spelling bare one.
        const cancelled = spelling === written || enabledEntries.has(spelling);
        const removed =
          writtenNames.has(spelling) && targetDefaultDisabled.has(spelling);
        const higher = higherDefaultScopes.get(spelling);
        if (cancelled || (removed && !higher)) continue;
        return {
          reason: 'default',
          list: 'defaultDisabled',
          entry: spelling,
          scope: higher ?? def,
        };
      }
    }
    return null;
  };
  return {
    blockIn,
    lockedIn: (skill) => {
      const block = blockIn(skill);
      if (!block) return null;
      // A higher-scope hard block labels as the scope alone: the entry
      // name adds nothing the user can act on in another file's list.
      if (block.reason === 'hard' && block.scope !== targetLabel) {
        return block.scope;
      }
      return `skills.${block.list} '${block.entry}' (${block.scope})`;
    },
  };
}

export function skillToggleBlockForName(
  settings: LoadedSettings,
  skill: {
    name: string;
    authoredName?: string;
    writtenName?: string;
    writtenNames?: readonly string[];
  },
  target: SkillToggleTargetScope = SettingScope.Workspace,
): SkillToggleBlock | null {
  return buildHigherDisabled(settings, target).blockIn(skill);
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

/**
 * How a disable is recorded: `hard` writes `skills.disabled`, which no other
 * scope can lift; `default` writes `skills.defaultDisabled`, which an
 * identically spelled `skills.enabled` entry in any scope cancels.
 */
export type SkillDisableMode = 'hard' | 'default';

export interface SkillActivationSettingLists {
  disabled: string[];
  defaultDisabled: string[];
  enabled: string[];
}

/**
 * Applies one activation change to a scope's three skill lists so the name
 * ends up in exactly one of them: `enabled` when enabling, `disabled` or
 * `defaultDisabled` (per `mode`) when disabling.
 *
 * `aliases` names the same skill under its other spellings (`pdf` for
 * `rust:pdf`), verified by the caller not to restrict another identity.
 * Each change drops them from both disable lists so a leftover hard alias
 * cannot defeat an enable or conversion to default mode. Only `skillName`
 * is recorded; other spellings and unrelated entries are preserved verbatim.
 */
export function updateSkillActivationLists(
  lists: SkillActivationSettingLists,
  skillName: string,
  enabled: boolean,
  mode: SkillDisableMode = 'hard',
  aliases: readonly string[] = [],
): SkillActivationSettingLists {
  let disabled = lists.disabled;
  let defaultDisabled = lists.defaultDisabled;
  for (const alias of aliases) {
    disabled = updateTarget(disabled, alias, false);
    defaultDisabled = updateTarget(defaultDisabled, alias, false);
  }
  return {
    disabled: updateTarget(disabled, skillName, !enabled && mode === 'hard'),
    defaultDisabled: updateTarget(
      defaultDisabled,
      skillName,
      !enabled && mode === 'default',
    ),
    enabled: updateTarget(lists.enabled, skillName, enabled),
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
