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

/**
 * Every settings-list spelling a skill can match: its registry name and,
 * when collision qualification renamed it to `<extensionName>:<name>`
 * (#9408), the pre-rename bare manifest name. The qualified spelling comes
 * first so a precise entry wins over the legacy one.
 */
export function skillSettingKeys(skill: {
  name: string;
  extensionName?: string;
}): string[] {
  const lowered = skill.name.trim().toLowerCase();
  const owner = skill.extensionName?.trim().toLowerCase();
  if (owner && lowered.startsWith(`${owner}:`)) {
    return [lowered, lowered.slice(owner.length + 1)];
  }
  return [lowered];
}

export function skillMatchesSettingName(
  skill: { name: string; extensionName?: string },
  names: ReadonlySet<string>,
): boolean {
  return skillSettingKeys(skill).some((key) => names.has(key));
}

/**
 * The command names a `skills.disabled` filter withholds from a command list:
 * both spellings of every skill it hides, plus the entries themselves.
 *
 * `CommandService` reserves these when renaming a colliding command (#9408).
 * A loader that filters its own output drops the disabled skill before any
 * rename happens, so its name reads as free to the collision probe; without
 * this the probe can hand a renamed sibling exactly the name the user
 * disabled, and nothing checks `skills.disabled` again after the rename. The
 * raw entries are included because a disabled name need not be held by a
 * currently-loaded skill to stay forbidden.
 */
export function disabledSkillReservedNames(
  skills: ReadonlyArray<{ name: string; extensionName?: string }>,
  disabled: ReadonlySet<string>,
): Set<string> {
  const reserved = new Set<string>(disabled);
  for (const skill of skills) {
    if (skillMatchesSettingName(skill, disabled)) {
      for (const key of skillSettingKeys(skill)) reserved.add(key);
    }
  }
  return reserved;
}

/**
 * Whether a resolved setting set applies to the skill named by `skillName`,
 * judged on that skill's own spellings rather than a bare-suffix match against
 * any entry (#9408).
 *
 * This answers "is the skill default-disabled, or already opted in", so it has
 * to use the same identity the runtime disables by. A qualified name still sees
 * the bare spelling it persisted under before a collision rename, while a bare
 * name sees only itself. Matching on suffix alone would let an entry belonging
 * to `other:pdf` decide the state of an unrelated `pdf`, the same over-reach
 * R3-1 removed from the write path.
 */
export function skillSettingEntriesApply(
  names: ReadonlySet<string>,
  skillName: string,
  extensionName?: string,
): boolean {
  const keys = toggledSkillSettingKeys(skillName, extensionName);
  return [...names].some((name) => keys.includes(name.trim().toLowerCase()));
}

/**
 * `skillMatchesSettingName` for a slash command whose name may have been
 * rewritten by `CommandService`'s collision suffixing (#9408).
 *
 * The denylist runs after that rename, so `cmd.name` can be `demo:chat1` while
 * the skill's own registry identity is still `demo:chat`. Deriving the legacy
 * bare key from the renamed form yields `chat1`, which no setting was ever
 * written under, and a `skills.disabled` or `slashCommands.disabled` entry for
 * the name the user actually sees silently stops applying. `skillDetail.name`
 * carries the pre-rename identity, so it is the thing to match on.
 */
export function skillCommandMatchesSettingName(
  cmd: {
    name: string;
    extensionName?: string;
    skillDetail?: { name: string };
  },
  names: ReadonlySet<string>,
): boolean {
  return skillMatchesSettingName(
    {
      name: cmd.skillDetail?.name ?? cmd.name,
      extensionName: cmd.extensionName,
    },
    names,
  );
}

export function lookupSkillDisablement(
  skill: { name: string; extensionName?: string },
  disablements: ReadonlyMap<string, SkillDisablement>,
): SkillDisablement | undefined {
  for (const key of skillSettingKeys(skill)) {
    const hit = disablements.get(key);
    if (hit !== undefined) return hit;
  }
  return undefined;
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
    // An opt-in expressed in either spelling lifts the default
    // disablement; an exact-string check would ignore a qualified opt-in
    // for a legacy bare entry (and vice versa) (#9408).
    if (!skillSettingEntriesMatchAny(enabled, name)) {
      disablements.set(name, { reason: 'default' });
    }
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
 * Whether two `skills.*` list entries refer to the same skill: identical
 * spellings, or one entry spelled as the qualified `<extension>:<name>`
 * form of the other's bare name. Mirrors the dual spelling that
 * `skillSettingKeys` derives from an actual skill, so opt-ins and removals
 * reach legacy entries written before a collision rename (#9408).
 */
export function skillSettingEntriesMatch(a: string, b: string): boolean {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  if (left === right) return true;
  const leftSuffix = left.slice(left.indexOf(':') + 1);
  if (left.includes(':') && leftSuffix === right) return true;
  const rightSuffix = right.slice(right.indexOf(':') + 1);
  return right.includes(':') && rightSuffix === left;
}

export function skillSettingEntriesMatchAny(
  entries: Iterable<string>,
  skillName: string,
): boolean {
  for (const entry of entries) {
    if (skillSettingEntriesMatch(entry, skillName)) return true;
  }
  return false;
}

/**
 * The settings-list spellings that belong to a toggled skill: its canonical
 * registry name plus, for a collision-qualified `<owner>:<name>`, the pre-rename
 * bare form it used to persist under (#9408). A bare name yields only itself, so
 * a bare toggle never reaches a qualified entry another skill owns (R3-1). The
 * owner is read from the name's prefix when the caller has no explicit
 * `extensionName` (e.g. the daemon, which resolves skills by canonical name).
 */
function toggledSkillSettingKeys(
  skillName: string,
  extensionName?: string,
): string[] {
  const lowered = skillName.trim().toLowerCase();
  const owner =
    extensionName?.trim().toLowerCase() ??
    (lowered.includes(':')
      ? lowered.slice(0, lowered.indexOf(':'))
      : undefined);
  return skillSettingKeys({ name: skillName, extensionName: owner });
}

function updateTarget(
  names: string[],
  skillName: string,
  include: boolean,
  extensionName: string | undefined,
): string[] {
  const keys = new Set(toggledSkillSettingKeys(skillName, extensionName));
  const next: string[] = [];
  let found = false;
  for (const name of names) {
    if (!keys.has(name.trim().toLowerCase())) {
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
  extensionName?: string,
): WorkspaceSkillSettingLists {
  const hadExplicitEnable = lists.enabled.some((name) =>
    toggledSkillSettingKeys(skillName, extensionName).includes(
      name.trim().toLowerCase(),
    ),
  );

  if (enabled) {
    return {
      disabled: updateTarget(lists.disabled, skillName, false, extensionName),
      enabled:
        defaultDisabled || hadExplicitEnable
          ? updateTarget(lists.enabled, skillName, true, extensionName)
          : lists.enabled,
    };
  }

  return {
    disabled: updateTarget(lists.disabled, skillName, true, extensionName),
    enabled: updateTarget(lists.enabled, skillName, false, extensionName),
  };
}

export interface WorkspaceSkillListToggle {
  name: string;
  wasEnabled: boolean;
  isEnabled: boolean;
  /** Record an explicit `skills.enabled` opt-in when enabling this skill. */
  defaultDisabled: boolean;
  /** The toggled skill's extension owner, if it is an extension skill. */
  extensionName?: string;
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
      toggle.defaultDisabled,
      toggle.extensionName,
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
