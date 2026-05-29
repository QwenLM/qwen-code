/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Returns whether the daemon should expose verbose error context in
 * HTTP responses. Mirrors `isServeDebugLoggingEnabled` in
 * `httpAcpBridge.ts` (which gates stderr-side debug log output).
 *
 * Extracted into its own module in fold-in 2i so route files
 * (`workspaceMemory.ts`, `workspaceAgents.ts`, future Wave 4 mutation
 * routes) can share one canonical predicate when deciding whether to
 * include `errorMessage` / `filePath` in their response bodies.
 * Without the toggle, error responses carry only structured fields
 * (`code` / `scope` / `mode` / `osCode` / ...) so absolute filesystem
 * paths from Node's fs error messages don't leak to authenticated
 * remote callers.
 *
 * Accepts any non-falsy value for the env var; explicit literals
 * `"0" / "false" / "off" / "no"` (case-insensitive, with surrounding
 * whitespace trimmed) disable. Matches the bridge's existing
 * `isServeDebugLoggingEnabled` semantics so the two toggles move in
 * lockstep — operators set `QWEN_SERVE_DEBUG=1` and get both stderr
 * verbosity and response-body detail.
 */
export function isServeDebugMode(): boolean {
  const value = process.env['QWEN_SERVE_DEBUG'];
  if (!value) return false;
  return !['0', 'false', 'off', 'no'].includes(value.trim().toLowerCase());
}
