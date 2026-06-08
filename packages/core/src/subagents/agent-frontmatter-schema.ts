/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Declarative-agent frontmatter schema constants and parsers.
 *
 * Mirrors Claude Code 2.1.168's `.claude/agents/<name>.md` schema verbatim so
 * a user can drop a Claude Code agent file into `.qwen/agents/` and have it
 * parse identically. The internal verification source (DL7 / Ig5 / GN / kc /
 * P37 / _Y) is documented in `docs/declarative-agents-port.md`.
 *
 * Parsing follows DL7's "lenient" posture: invalid optional fields are dropped
 * to undefined rather than thrown — the caller layer is responsible for
 * deciding whether a dropped field surfaces a warning. This intentionally
 * differs from the strict throw-on-invalid posture used for `approvalMode`
 * elsewhere in the loader, because that field predates this port and changing
 * its semantics would break existing `.qwen/agents/*.md` files.
 */

/** Permission mode enum (DL7 `$E` / `kc` constant). */
export const PERMISSION_MODE_VALUES = [
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
] as const;
export type PermissionModeValue = (typeof PERMISSION_MODE_VALUES)[number];

/** Color allowlist (DL7 `_Y` constant). Values outside this list are silently dropped. */
export const COLOR_VALUES = [
  'red',
  'blue',
  'green',
  'yellow',
  'purple',
  'orange',
  'pink',
  'cyan',
] as const;
export type ColorValue = (typeof COLOR_VALUES)[number];

/**
 * Mapping from Claude Code permissionMode → qwen-code approvalMode.
 *
 * Note: Claude's `dontAsk` denies any tool call that would prompt the user,
 * making it restrictive. We map it to `default` (which also requires approval)
 * rather than `auto-edit` (which auto-approves), preserving the restrictive
 * intent. `bypassPermissions` is the Claude mode that auto-approves everything.
 */
const PERMISSION_MODE_TO_APPROVAL_MODE: Readonly<Record<string, string>> = {
  default: 'default',
  plan: 'plan',
  acceptEdits: 'auto-edit',
  auto: 'auto-edit',
  bypassPermissions: 'yolo',
  dontAsk: 'default',
};

/**
 * Map a Claude Code `permissionMode` frontmatter value to a qwen-code
 * `approvalMode` value. Returns `undefined` for unknown / falsy input.
 *
 * Disambiguated from `packages/core/src/tools/agent/agent.ts`'s internal
 * `permissionModeToApprovalMode`, which maps the qwen `PermissionMode` enum
 * to the qwen `ApprovalMode` enum (different domain entirely). Importing the
 * wrong symbol via IDE auto-complete would silently return `undefined` for
 * every qwen enum value, hence the longer name.
 */
export function claudePermissionModeToApprovalMode(
  permissionMode: string | undefined,
): string | undefined {
  if (!permissionMode) return undefined;
  return PERMISSION_MODE_TO_APPROVAL_MODE[permissionMode];
}

/**
 * Parse a value that may be a comma-separated string OR an array of strings.
 * Returns `undefined` for any other shape. Matches DL7's lenient posture for
 * `tools`, `disallowedTools`, and `skills`.
 */
export function parseStringOrArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry));
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return undefined;
}

/**
 * Parse a background value. Accepts boolean `true` / string `"true"` and
 * returns `true`. Returns `undefined` for everything else (including `false`
 * and `"false"`) — matching DL7 (`eiH`/`EL8`), which only normalises truthy
 * values to `true`.
 */
export function parseBackground(value: unknown): true | undefined {
  if (value === true || value === 'true') return true;
  return undefined;
}

/**
 * Parse a maxTurns value. Accepts a positive integer number or numeric string.
 * Returns `undefined` for anything else (matches DL7 `W46`).
 */
export function parseMaxTurns(value: unknown): number | undefined {
  let candidate: number;
  if (typeof value === 'number') {
    candidate = value;
  } else if (typeof value === 'string' && value.length > 0) {
    candidate = Number(value);
    if (Number.isNaN(candidate)) return undefined;
  } else {
    return undefined;
  }
  if (!Number.isFinite(candidate)) return undefined;
  if (!Number.isInteger(candidate)) return undefined;
  if (candidate <= 0) return undefined;
  return candidate;
}

/** Type guard: value is a valid PERMISSION_MODE_VALUES literal. */
export function isPermissionMode(value: unknown): value is PermissionModeValue {
  return (
    typeof value === 'string' &&
    (PERMISSION_MODE_VALUES as readonly string[]).includes(value)
  );
}

/** Type guard: value is a valid COLOR_VALUES literal. */
export function isColor(value: unknown): value is ColorValue {
  return (
    typeof value === 'string' &&
    (COLOR_VALUES as readonly string[]).includes(value)
  );
}
