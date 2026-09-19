/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { isDeepStrictEqual } from 'node:util';

/**
 * Whether this session takes part in cross-session messaging.
 *
 * On unless the user turned it off. The schema defaults the setting to
 * `true`, but merged settings carry only what some scope actually wrote,
 * so an unset key reaches every reader as `undefined` and has to be read
 * as the default here rather than as "off". Anything that is not a
 * boolean fails closed: a value the reader does not recognize must not
 * open a socket, which is also the rank `WORKSPACE_TIGHTEN_ONLY_SETTINGS`
 * gives it.
 *
 * The one place this question is answered, so the interactive UI, the
 * ACP agent and `/peers` cannot drift on what "on" means.
 */
export function isCrossSessionMessagingEnabled(
  settings: { agents?: { crossSessionMessaging?: unknown } } | undefined,
): boolean {
  const value = settings?.agents?.crossSessionMessaging;
  return value === undefined || value === true;
}

/** One settings file, as the scope readers below see it. */
interface CrossSessionScopeFile {
  settings: { agents?: { crossSessionMessaging?: unknown } };
}

/**
 * The per-scope view of settings these readers need. `LoadedSettings`
 * satisfies it; tests pass only the scopes they care about.
 */
export interface CrossSessionSettingsScopes {
  merged: { agents?: { crossSessionMessaging?: unknown } };
  system?: CrossSessionScopeFile;
  systemDefaults?: CrossSessionScopeFile;
  user?: CrossSessionScopeFile;
  workspace?: CrossSessionScopeFile;
  isTrusted?: boolean;
  workspaceSettingsActive?: boolean;
}

function switchIn(file: CrossSessionScopeFile | undefined): unknown {
  return file?.settings.agents?.crossSessionMessaging;
}

function workspaceCounts(settings: CrossSessionSettingsScopes): boolean {
  return (
    settings.isTrusted === true && settings.workspaceSettingsActive === true
  );
}

/**
 * Whether a person wrote `true` for the switch: in their own user
 * settings, or in this workspace's settings when those are in force.
 *
 * A different question from {@link isCrossSessionMessagingEnabled}, which an
 * unset key also answers yes. Merged settings cannot answer it: they have
 * already folded in the operator scopes, and a fleet's system-defaults file
 * that says `true` was not written by the person sitting at this session.
 * Only the scopes a user edits count.
 */
export function isCrossSessionMessagingOptedIn(
  settings: CrossSessionSettingsScopes,
): boolean {
  if (switchIn(settings.user) === true) return true;
  return workspaceCounts(settings) && switchIn(settings.workspace) === true;
}

/**
 * Which scope turned messaging off, so the remedy can name the file.
 *
 * `system-defaults` is kept apart from `system` because the remedy differs:
 * a user-scope `true` overrides a system default, but nothing overrides
 * System settings, and a workspace value may only tighten, so a user `true`
 * cannot undo a workspace `false`. Scopes are checked in the order the
 * merge lets them win, and a scope counts only when its value is the one in
 * force — the same reading `inboundPolicyScope` gives the sibling setting.
 *
 * Undefined when messaging is on, or when the value in force cannot be
 * traced to a scope (a context that carries merged settings only).
 */
export type CrossSessionMessagingOffScope =
  | 'system'
  | 'system-defaults'
  | 'user'
  | 'workspace';

export function crossSessionMessagingOffScope(
  settings: CrossSessionSettingsScopes,
): CrossSessionMessagingOffScope | undefined {
  if (isCrossSessionMessagingEnabled(settings.merged)) return undefined;
  const merged = settings.merged.agents?.crossSessionMessaging;
  if (switchIn(settings.system) !== undefined) return 'system';
  if (isDeepStrictEqual(switchIn(settings.user), merged)) return 'user';
  if (isDeepStrictEqual(switchIn(settings.systemDefaults), merged)) {
    return 'system-defaults';
  }
  if (
    workspaceCounts(settings) &&
    isDeepStrictEqual(switchIn(settings.workspace), merged)
  ) {
    return 'workspace';
  }
  return undefined;
}
