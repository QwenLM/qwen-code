/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Permission mode behaviour — the host's half of the mode contract.
 *
 * The five mode *names* belong to `../manager/decision/index.js`; what each
 * name means for this host belongs here: which predicate a call site should
 * ask, how loose user input is parsed, what Shift+Tab does next, and how a
 * subagent's declaration merges with its parent's mode.
 *
 * Call sites must never compare a mode against a string literal. Import a
 * predicate, or `PermissionModes` from the component.
 */

import {
  PERMISSION_MODES,
  PermissionModes,
  type PermissionMode,
} from '../manager/decision/index.js';

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/** Default mode. `undefined` counts as default: it is the absence of a choice. */
export function isDefaultMode(mode: PermissionMode | undefined): boolean {
  return mode === undefined || mode === PermissionModes.Default;
}

export function isAcceptEditsMode(mode: PermissionMode | undefined): boolean {
  return mode === PermissionModes.AcceptEdits;
}

export function isAutoMode(mode: PermissionMode | undefined): boolean {
  return mode === PermissionModes.Auto;
}

export function isDontAskMode(mode: PermissionMode | undefined): boolean {
  return mode === PermissionModes.DontAsk;
}

export function isYoloMode(mode: PermissionMode | undefined): boolean {
  return mode === PermissionModes.Yolo;
}

// ---------------------------------------------------------------------------
// Parsing loose input
// ---------------------------------------------------------------------------

/**
 * Extra spellings accepted from user-authored input, on top of the canonical
 * names. `bypassPermissions` is the old name for Yolo; `accepting_edits` the
 * old name for AcceptEdits.
 */
const MODE_ALIASES: Readonly<Record<string, PermissionMode>> = {
  bypasspermissions: PermissionModes.Yolo,
  acceptingedits: PermissionModes.AcceptEdits,
};

/**
 * Lookup keyed by the canonical names reduced to their loose form, so that
 * `acceptEdits`, `accept-edits`, `ACCEPT_EDITS` and `accept edits` all resolve.
 * Derived from the component's list: a mode added there works here for free.
 */
const MODE_BY_LOOSE_KEY: Readonly<Record<string, PermissionMode>> = {
  ...Object.fromEntries(PERMISSION_MODES.map((mode) => [looseKey(mode), mode])),
  ...MODE_ALIASES,
};

/** Lowercase, non-alphanumerics stripped. */
function looseKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Parse user-authored input — agent frontmatter, `--permission-mode`, a settings
 * file — into a mode. Returns `undefined` when the string names no mode, so the
 * caller decides between a fallback and an error.
 */
export function parsePermissionMode(
  value: string | undefined,
): PermissionMode | undefined {
  if (!value) {
    return undefined;
  }
  return MODE_BY_LOOSE_KEY[looseKey(value)];
}

// ---------------------------------------------------------------------------
// Shift+Tab cycle
// ---------------------------------------------------------------------------

/**
 * The order Shift+Tab walks: strict → permissive, so the next step is
 * predictable. Deliberately its own array rather than the component's
 * `PERMISSION_MODES`, which is a vocabulary and carries no ordering promise.
 */
export const PERMISSION_MODE_CYCLE: readonly PermissionMode[] = [
  PermissionModes.DontAsk,
  PermissionModes.Default,
  PermissionModes.AcceptEdits,
  PermissionModes.Yolo,
  PermissionModes.Auto,
] as const;

/** The mode after `current` in the cycle. Unknown input restarts at Default. */
export function getNextPermissionMode(
  current: PermissionMode | undefined,
): PermissionMode {
  const index = current ? PERMISSION_MODE_CYCLE.indexOf(current) : -1;
  if (index === -1) {
    return PermissionModes.Default;
  }
  return PERMISSION_MODE_CYCLE[(index + 1) % PERMISSION_MODE_CYCLE.length];
}

// ---------------------------------------------------------------------------
// Parent / child resolution
// ---------------------------------------------------------------------------

/**
 * Modes a child agent may not walk back. Each is a deliberate parent-level
 * decision: DontAsk is a zero-popup contract, and the other three are
 * already at least as permissive as anything a child could ask for.
 */
const PARENT_MODES_CHILDREN_CANNOT_DEMOTE: readonly PermissionMode[] = [
  PermissionModes.DontAsk,
  PermissionModes.Yolo,
  PermissionModes.AcceptEdits,
  PermissionModes.Auto,
];

/**
 * The mode a subagent actually runs under. A child may be *more* permissive
 * than a plain-default parent; it may never loosen or tighten a parent that
 * already made one of the decisions above.
 */
export function resolveEffectiveMode(
  parentMode: PermissionMode,
  childMode: PermissionMode | undefined,
): PermissionMode {
  if (childMode === undefined) {
    return parentMode;
  }
  if (PARENT_MODES_CHILDREN_CANNOT_DEMOTE.includes(parentMode)) {
    return parentMode;
  }
  return childMode;
}

// ---------------------------------------------------------------------------
// Plan state exclusion
// ---------------------------------------------------------------------------

/**
 * Whether the active mode forbids plan state. DontAsk denies every request that
 * would prompt, so a plan session under it could never get its exit approved —
 * the two are mutually exclusive.
 *
 * Consumers: the permission checks, and the plan entry points that bypass them
 * (slash command, goal resume).
 */
export function isPlanStateBlockedByMode(
  mode: PermissionMode | undefined,
): boolean {
  return isDontAskMode(mode);
}

/** Shown when plan entry is refused because the active mode forbids it. */
export const PLAN_MODE_BLOCKED_MESSAGE =
  'Plan mode is unavailable while the "Don\'t ask" permission mode is active. ' +
  'Switch to another permission mode to use plan mode.';

/** Shown when an active plan session is force-exited by a mode switch. */
export const PLAN_MODE_FORCE_EXITED_MESSAGE =
  'Plan mode exited: the "Don\'t ask" permission mode is mutually exclusive ' +
  'with plan mode.';

/** Shown when Yolo is refused because settings turned it off. */
export const BYPASS_PERMISSIONS_DISABLED_MESSAGE =
  'Bypass permissions mode is disabled by settings.';

/**
 * Shown when entry into auto mode is refused because no classifier model is
 * available. Auto mode hands every tool decision to that model, so without one
 * it could only fail closed on every call — refusing entry is clearer than
 * admitting the user to a mode that cannot approve anything.
 */
export const AUTO_MODE_UNSUPPORTED_MESSAGE =
  'Auto mode needs a classifier model, which is not available for this ' +
  'session. Other permission modes are unaffected.';

/**
 * What switching to a mode does to permission requests already waiting.
 *
 * One rule that two places have to agree on: the TUI acts on it, and the
 * mode-change notification reports it. The notification fires inside setPermissionMode,
 * before the queue is touched, so it can only report this by asking the same
 * question the UI will — a second copy of the predicate at the reporting site
 * would drift, and the data would then describe behaviour the code no longer has.
 *
 * - Auto, DontAsk and AcceptEdits re-run what is pending, which then answers
 *   allow or deny per item from the tool and the rules.
 * - Yolo approves what is pending outright, apart from the asks no mode can skip.
 * - Every other mode leaves the queue alone.
 */
export function permissionModeQueueEffect(mode: PermissionMode | undefined): {
  producedRecheck: boolean;
  resolvedPrompt: boolean;
} {
  if (isAutoMode(mode) || isDontAskMode(mode) || isAcceptEditsMode(mode)) {
    return { producedRecheck: true, resolvedPrompt: false };
  }
  if (isYoloMode(mode)) {
    return { producedRecheck: false, resolvedPrompt: true };
  }
  return { producedRecheck: false, resolvedPrompt: false };
}
