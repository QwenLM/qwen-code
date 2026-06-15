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
 *
 * Use `Map` instead of a plain `Record` so a caller passing `'__proto__'` or
 * `'constructor'` cannot walk the prototype chain and get back a non-string
 * value (e.g. `Object.prototype`).
 */
const PERMISSION_MODE_TO_APPROVAL_MODE = new Map<string, string>([
  ['default', 'default'],
  ['plan', 'plan'],
  ['acceptEdits', 'auto-edit'],
  ['auto', 'auto-edit'],
  ['bypassPermissions', 'yolo'],
  ['dontAsk', 'default'],
]);

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
  return PERMISSION_MODE_TO_APPROVAL_MODE.get(permissionMode);
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

/**
 * Parse a frontmatter `mcpServers` value into the record-of-specs shape
 * qwen-code's MCP layer expects. Matches CC `gS8`'s shallow validation:
 *
 *   - non-object / array / null → undefined (whole field dropped)
 *   - string (CC's server-name reference form) → undefined; qwen-code does
 *     not support the reference form yet, so it is rejected at this layer
 *     rather than silently passed through and later confusing the MCP loader
 *   - record-of-records → keep entries whose value is a plain object,
 *     drop entries whose value is a scalar / array / null
 *
 * The deep `{ type, command, args, ... }` validation per spec is intentionally
 * deferred to the runtime MCP loader (which already owns the union for
 * stdio/sse/http/etc.). This mirrors CC, where Ig5 keeps mcpServers as
 * `z.unknown()` at parse time and gS8 / DL7 run per-item `safeParse` at
 * registration time. Drop-the-whole-field is preferred over throw so a
 * malformed mcpServers block doesn't kill the entire agent.
 */
export function parseAgentMcpServers(
  value: unknown,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  // `Object.create(null)` so a YAML key of literal `__proto__` lands as a
  // plain own property (instead of triggering the `__proto__` setter on
  // `Object.prototype` and silently mutating the result's prototype chain).
  // Matches the null-prototype guarantee `yaml-parser.ts:stripNullValues`
  // already enforces on the input record we receive from yaml.parse.
  const result = Object.create(null) as Record<string, unknown>;
  for (const [name, spec] of Object.entries(record)) {
    if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)) {
      result[name] = spec;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Parse a frontmatter `hooks` value into the record-of-event-matchers shape
 * qwen-code's hook layer expects. Matches CC `TKO` / `_u`'s shallow
 * validation:
 *
 *   - non-object / array / null → undefined (whole field dropped)
 *   - record → keep entries whose value is an array, drop entries whose
 *     value is a non-array (a scalar / object / null is never a valid
 *     HookMatcher list)
 *
 * Per-matcher / per-hook `{ type, command, ... }` validation is deferred to
 * the runtime hook subsystem (`SessionHooksManager` already owns the discriminated
 * union for command/http/function/prompt). Drop-the-whole-field is preferred
 * over throw, matching the rest of the DL7 lenient posture.
 */
export function parseAgentHooks(
  value: unknown,
): Record<string, unknown> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  // See `parseAgentMcpServers` for why this uses a null-prototype object.
  const result = Object.create(null) as Record<string, unknown>;
  for (const [eventName, matchers] of Object.entries(record)) {
    if (Array.isArray(matchers)) {
      result[eventName] = matchers;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
