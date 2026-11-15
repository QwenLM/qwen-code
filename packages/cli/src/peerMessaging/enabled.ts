/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { isDeepStrictEqual } from 'node:util';

/**
 * What the `agents.crossSessionMessaging` setting says — not the whole
 * answer to whether this session takes part, which is
 * {@link isCrossSessionMessagingActive}.
 *
 * On unless the user turned it off. The schema defaults the setting to
 * `true`, but merged settings carry only what some scope actually wrote,
 * so an unset key reaches every reader as `undefined` and has to be read
 * as the default here rather than as "off". Anything that is not a
 * boolean fails closed: a value the reader does not recognize must not
 * open a socket, which is also the rank `WORKSPACE_TIGHTEN_ONLY_SETTINGS`
 * gives it.
 */
export function isCrossSessionMessagingEnabled(
  settings: { agents?: { crossSessionMessaging?: unknown } } | undefined,
): boolean {
  const value = settings?.agents?.crossSessionMessaging;
  return value === undefined || value === true;
}

/**
 * The two session-level suppressions, read off the `Config` that already
 * carries them. Both calls are optional because a reader's config may be
 * absent (`CommandContext['services']['config']` is `Config | null`) or a
 * test double that models neither flag; a config that cannot answer is
 * treated as not suppressing, which is what such a reader sees on `main`.
 */
export interface CrossSessionRuntime {
  getBareMode?(): boolean;
  isSafeMode?(): boolean;
}

/** Which startup suppression turned messaging off for this session. */
export type CrossSessionMessagingSuppression = 'bare' | 'safe-mode';

/**
 * Which session-level suppression is in force, if any.
 *
 * A peer inbox is exactly the kind of surface `--safe-mode`
 * (`QWEN_CODE_SAFE_MODE`) exists to close: a socket another local process
 * can write to, plus a registry record telling every other session where
 * to find it. `--bare` (`QWEN_CODE_SIMPLE`) reaches the same verdict for a
 * different reason — it is the minimal-startup mode, and binding a socket
 * and writing a record is neither minimal nor free. Neither flag is visible
 * to the setting, so the setting alone cannot answer the question.
 *
 * The two channels are not symmetric across a process boundary, though the
 * paragraph above reads as if they were: `spawnChannel.ts` scrubs
 * `QWEN_CODE_SIMPLE` out of the environment of a `qwen --acp` child it
 * spawns (so a daemon's own bare mode does not leak into the sessions it
 * hosts), leaves `QWEN_CODE_SAFE_MODE` alone, and nothing in `packages/`
 * writes that variable. An *inherited* `QWEN_CODE_SAFE_MODE` therefore
 * suppresses messaging in every session a daemon or editor hosts, and those
 * sessions register no record at all — silently, because the explanation
 * `/peers` gives is not reachable from a driven session.
 *
 * Safe mode is reported first when both are on: it is the stronger claim
 * about what this session may touch, and naming it is the more useful
 * answer.
 */
export function crossSessionMessagingSuppression(
  config: CrossSessionRuntime | null | undefined,
): CrossSessionMessagingSuppression | undefined {
  if (config?.isSafeMode?.() === true) return 'safe-mode';
  if (config?.getBareMode?.() === true) return 'bare';
  return undefined;
}

/**
 * Whether this session takes part in cross-session messaging: the setting's
 * own answer, narrowed by the session-level suppressions.
 *
 * The one place this question is answered, so the interactive UI, the ACP
 * agent's hosted-session registration and `/peers` cannot drift on what
 * "on" means — including on the flags, which the setting reader cannot see
 * and which are why a session can be off with the setting on.
 */
export function isCrossSessionMessagingActive(
  settings: { agents?: { crossSessionMessaging?: unknown } } | undefined,
  config: CrossSessionRuntime | null | undefined,
): boolean {
  return (
    isCrossSessionMessagingEnabled(settings) &&
    crossSessionMessagingSuppression(config) === undefined
  );
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
