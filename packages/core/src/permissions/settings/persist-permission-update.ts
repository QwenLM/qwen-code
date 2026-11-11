/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Writing a remembered permission change to disk, and reporting that it happened.
 *
 * This is the persistence half of what an ask handler does when the user picks
 * "always allow": the handler double-writes — the host settings file through
 * here, and the live rule set through the module's own setters. The module never
 * touches settings files and this file never judges a call; keeping the two apart
 * is what lets a choice be remembered without the decision engine knowing
 * anything about disks.
 *
 * The transient destinations have nothing to persist, which is what
 * `supportsPersistence` answers.
 */

import type {
  PermissionUpdate,
  PermissionUpdateDestination,
} from '../../tools/tool-checkers/checker-reasons.js';
import type {
  PermissionBehavior,
  PermissionMode,
  PermissionRules,
  PermissionRuleValue,
} from '../manager/decision/index.js';
import { permissionRuleValueToString } from '../manager/decision/index.js';
import {
  addPermissionRulesToSettings,
  type EditableSettingSource,
  type SettingsWriter,
} from './permissionsLoader.js';

// ============================================================================
// Rule Extraction
// ============================================================================

/**
 * Extracts all rule values from a list of permission updates.
 * Only considers 'addRules' updates — other update types are skipped.
 */
export function extractRules(
  updates: PermissionUpdate[] | undefined,
): PermissionRuleValue[] {
  if (!updates) return [];

  return updates.flatMap((update) => {
    switch (update.type) {
      case 'addRules':
        return update.rules;
      default:
        return [];
    }
  });
}

/**
 * Returns whether any of the updates contain permission rules.
 */
export function hasRules(updates: PermissionUpdate[] | undefined): boolean {
  if (!updates) return false;
  return updates.some(
    (update) => update.type === 'addRules' && update.rules.length > 0,
  );
}

// ============================================================================
// Persistence Helpers
// ============================================================================

/**
 * Destinations that support writing to disk (settings files).
 * Session and CLI arg rules are transient and cannot be persisted.
 */
export type PersistableDestination =
  | 'localSettings'
  | 'userSettings'
  | 'projectSettings';

/**
 * Type guard: returns true if the destination supports persistence to disk.
 */
export function supportsPersistence(
  destination: PermissionUpdateDestination,
): destination is PersistableDestination {
  return (
    destination === 'localSettings' ||
    destination === 'userSettings' ||
    destination === 'projectSettings'
  );
}

/**
 * Persists a single permission update to the appropriate settings source.
 *
 * For 'addRules' updates to editable destinations, this writes the rules
 * to the settings JSON file via the provided SettingsWriter.
 * For 'session' destination or non-rule updates, only in-memory context
 * transformation is needed (handled by applyPermissionUpdate).
 *
 * @param update The permission update to persist
 * @param writer Optional SettingsWriter for disk I/O. When absent, persistence is skipped.
 */
export function persistPermissionUpdate(
  update: PermissionUpdate,
  writer?: SettingsWriter,
): boolean | void {
  if (!supportsPersistence(update.destination) || !writer) {
    return;
  }

  const destination = update.destination as EditableSettingSource;

  switch (update.type) {
    case 'addRules':
    case 'replaceRules':
      if (
        !addPermissionRulesToSettings(
          {
            ruleValues: update.rules,
            ruleBehavior: update.behavior,
          },
          destination,
          writer,
        )
      )
        return false;
      break;

    case 'removeRules':
      // Remove rules persistence: read existing rules, filter out the ones to remove,
      // then write the filtered set back via replaceRules semantics.
      // For now, removeRules persistence is handled at the in-memory layer
      // (applyPermissionUpdate). Disk persistence requires reading the current
      // settings file, which is not yet supported by the SettingsWriter interface.
      break;

    case 'setMode':
      // setMode persistence: write the mode to the settings file.
      // Requires SettingsWriter support for mode changes — currently handled
      // at the in-memory layer (applyPermissionUpdate).
      break;

    case 'addDirectories':
    case 'removeDirectories':
      // Directory persistence: write/remove directories in settings.
      // Currently handled at the in-memory layer (applyPermissionUpdate).
      break;

    default:
      break;
  }
}

/**
 * Persists multiple permission updates, batching writes by destination and behavior
 * to minimize file I/O.
 *
 * @param updates The permission updates to persist
 * @param writer Optional SettingsWriter for disk I/O
 */
export function persistPermissionUpdates(
  updates: PermissionUpdate[],
  writer?: SettingsWriter,
): void {
  if (!writer) return;

  // Group rules by (destination, behavior) to batch writes
  const batches = new Map<
    string,
    {
      destination: EditableSettingSource;
      behavior: PermissionBehavior;
      rules: PermissionRuleValue[];
    }
  >();

  for (const update of updates) {
    if (!supportsPersistence(update.destination)) continue;

    const destination = update.destination as EditableSettingSource;

    switch (update.type) {
      case 'addRules':
      case 'replaceRules': {
        const key = `${destination}:${update.behavior}`;
        const batch = batches.get(key);
        if (batch) {
          batch.rules.push(...update.rules);
        } else {
          batches.set(key, {
            destination,
            behavior: update.behavior,
            rules: [...update.rules],
          });
        }
        break;
      }
      case 'removeRules':
      case 'setMode':
      case 'addDirectories':
      case 'removeDirectories':
        // These types are persisted individually via persistPermissionUpdate
        persistPermissionUpdate(update, writer);
        break;
      default:
        break;
    }
  }

  for (const { destination, behavior, rules } of batches.values()) {
    addPermissionRulesToSettings(
      { ruleValues: rules, ruleBehavior: behavior },
      destination,
      writer,
    );
  }
}


// ============================================================================
// Applying updates to the live rule set
// ============================================================================

/**
 * Fold a batch of updates into a rule set and return the result.
 *
 * The module has setters, not an update language, because "add these rules" and
 * "stop asking about this directory" are host vocabulary. This translates the
 * one into the other. It is pure: the caller decides whether to hand the result
 * to `setRules` / `setPermissionMode`, and whether to persist it as well.
 *
 * `setMode` and the directory updates are not rule changes, so they are reported
 * back separately rather than folded in — the caller applies those through their
 * own setters.
 */
export function applyUpdatesToRules(
  rules: PermissionRules,
  updates: PermissionUpdate[],
): {
  rules: PermissionRules;
  mode?: PermissionMode;
  addedDirectories: string[];
  removedDirectories: string[];
} {
  const next: PermissionRules = {
    allow: { ...rules.allow },
    deny: { ...rules.deny },
    ask: { ...rules.ask },
  };
  let mode: PermissionMode | undefined;
  const addedDirectories: string[] = [];
  const removedDirectories: string[] = [];

  for (const update of updates) {
    switch (update.type) {
      case 'addRules': {
        const bucket = next[update.behavior];
        const strings = update.rules.map(permissionRuleValueToString);
        bucket[update.destination] = [
          ...(bucket[update.destination] ?? []),
          ...strings,
        ];
        break;
      }
      case 'replaceRules': {
        const bucket = next[update.behavior];
        bucket[update.destination] = update.rules.map(
          permissionRuleValueToString,
        );
        break;
      }
      case 'removeRules': {
        const bucket = next[update.behavior];
        const doomed = new Set(update.rules.map(permissionRuleValueToString));
        bucket[update.destination] = (
          bucket[update.destination] ?? []
        ).filter((rule) => !doomed.has(rule));
        break;
      }
      case 'setMode':
        mode = update.mode;
        break;
      case 'addDirectories':
        addedDirectories.push(...update.directories);
        break;
      case 'removeDirectories':
        removedDirectories.push(...update.directories);
        break;
      default:
        break;
    }
  }

  return { rules: next, mode, addedDirectories, removedDirectories };
}

/** Rules and additional-directory access shared by permission stores. */
export interface PermissionRuleStore {
  getRules(): PermissionRules;
  setRules(rules: PermissionRules): void;
  getAdditionalDirectories(): string[];
  setAdditionalDirectories(dirs: string[]): void;
}

/**
 * Apply updates to a live rule store. The mode is returned, not applied:
 * callers must route it through Config so entering/leaving Auto can strip and
 * restore allow rules.
 */
export function applyUpdatesToModule(
  permission: PermissionRuleStore,
  updates: PermissionUpdate[],
): { mode?: PermissionMode } {
  const result = applyUpdatesToRules(permission.getRules(), updates);
  permission.setRules(result.rules);

  if (
    result.addedDirectories.length > 0 ||
    result.removedDirectories.length > 0
  ) {
    const removed = new Set(result.removedDirectories);
    const kept = permission
      .getAdditionalDirectories()
      .filter((dir) => !removed.has(dir));
    const seen = new Set(kept);
    permission.setAdditionalDirectories([
      ...kept,
      ...result.addedDirectories.filter((dir) => !seen.has(dir)),
    ]);
  }

  return result.mode ? { mode: result.mode } : {};
}

// ============================================================================
// What a prompt option means
// ============================================================================

/**
 * The rule changes an approval scope implies.
 *
 * A prompt offers "allow once", "allow for this session", "always allow", and the
 * difference between the last two is only *where* the rule is written. The
 * suggestions come from the tool check, which knows what rule would cover this
 * call; the scope comes from the user, who knows how long they mean it for.
 *
 * `undefined` means "grant nothing" — once-only and cancel change no rules.
 */
export function updatesForApprovalScope(
  scope: 'once' | 'session' | 'persist' | 'cancel',
  suggestions: PermissionUpdate[] | undefined,
): PermissionUpdate[] | undefined {
  if (scope === 'once' || scope === 'cancel') {
    return undefined;
  }

  if (!suggestions || suggestions.length === 0) {
    return undefined;
  }

  if (scope === 'persist') {
    // A suggestion that defaults to `session` would be dropped by the persister,
    // so "always" has to name a real file to write to.
    return suggestions.map((suggestion) =>
      suggestion.destination === 'session'
        ? { ...suggestion, destination: 'localSettings' as const }
        : suggestion,
    );
  }

  return suggestions.map((suggestion) => ({
    ...suggestion,
    destination: 'session' as const,
  }));
}
