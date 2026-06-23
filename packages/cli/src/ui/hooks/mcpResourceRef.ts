/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Match the LONGEST configured MCP server name that prefixes `input` as
 * `<serverName>:`, returning that name plus the remainder after the colon.
 *
 * Longest-prefix (rather than splitting on the first `:`) so a server name
 * that itself contains a `:` — a valid `settings.json` key, e.g. `my:server`
 * — resolves correctly even when a shorter name like `my` is also configured.
 *
 * Iterates the provided names directly (no `in` / prototype walking), so
 * inherited object keys (`__proto__`, `constructor`, …) are never matched.
 *
 * Returns `null` when no configured server name prefixes `input`. The
 * remainder MAY be empty (e.g. the bare `@server:` autocomplete trigger);
 * callers that require a non-empty URI must check `rest` themselves.
 *
 * Shared by `parseMcpResourceRef` (the `@server:uri` injection path) and
 * `getMcpResourceSuggestions` (the `@server:` completion path) so the two
 * stay in lockstep.
 */
export function matchMcpServerPrefix(
  input: string,
  serverNames: Iterable<string>,
): { serverName: string; rest: string } | null {
  let serverName: string | null = null;
  for (const name of serverNames) {
    if (
      input.startsWith(`${name}:`) &&
      (serverName === null || name.length > serverName.length)
    ) {
      serverName = name;
    }
  }
  if (serverName === null) return null;
  return { serverName, rest: input.slice(serverName.length + 1) };
}

/**
 * Build the canonical `<serverName>:<uri>` reference for an MCP resource —
 * the exact inverse of {@link matchMcpServerPrefix} (without the leading `@`,
 * which is only the input trigger character). Use this everywhere a reference
 * is rendered or completed (the `@server:uri` hint, the `@server:` autocomplete
 * value) so the format has a single source of truth and can't drift away from
 * the parser: `matchMcpServerPrefix(buildMcpResourceRef(s, u), [s])` round-trips
 * back to `{ serverName: s, rest: u }`.
 */
export function buildMcpResourceRef(serverName: string, uri: string): string {
  return `${serverName}:${uri}`;
}
