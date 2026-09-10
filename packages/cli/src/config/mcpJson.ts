/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type MCPServerConfig,
  normalizeClaudeMcpServer,
} from '@qwen-code/qwen-code-core';
import { resolveEnvVarsInObject } from '@qwen-code/qwen-code-core/envVarResolver';
import stripJsonComments from 'strip-json-comments';

/** Project-scoped MCP config filename, read from the workspace root. */
export const PROJECT_MCP_FILENAME = '.mcp.json';

/**
 * Fields whose values are expanded for `$VAR` / `${VAR}`. Deliberately an
 * ALLOWLIST of transport fields — the ones that decide what gets executed or
 * connected to, i.e. the only ones a checked-in `.mcp.json` needs a secret in.
 *
 * Metadata (`description`, `extensionName`, `includeTools`, …) is left verbatim:
 * it was never expanded before this loader learned to expand anything, a `$`
 * there is far likelier to be literal text than a placeholder, and those two
 * fields in particular are exactly what `hashMcpServerConfig` treats as
 * non-behavioral — expanding them would make a cosmetic label able to pull a
 * value out of the environment for no benefit.
 */
const ENV_EXPANDED_TRANSPORT_FIELDS = [
  // stdio
  'command',
  'args',
  'env',
  'cwd',
  // sse / streamable http
  'url',
  'httpUrl',
  'headers',
  // websocket
  'tcp',
  // OAuth: `clientSecret` is exactly the kind of value a checked-in file has to
  // reference rather than embed, and every settings scope already expands it.
  'oauth',
  // Google auth: these select WHICH identity is impersonated and which audience
  // the token is minted for, so they decide what the connection authenticates
  // as just as much as `url` decides where it goes. They are also exactly the
  // values that differ per environment — project number, service-account name —
  // which is what a checked-in file needs a placeholder for.
  'targetAudience',
  'targetServiceAccount',
  // Deliberately absent: `authProviderType`. It selects a provider from a fixed
  // enum rather than carrying an environment-specific value, so a placeholder
  // there could only ever resolve to a name the enum already has to contain.
] as const;

/**
 * Maximum object/array nesting accepted for a single server entry. A real
 * server config nests two or three levels (`env`, `headers`, `args`); this cap
 * is generous by orders of magnitude and exists only to keep a hostile or
 * generated `.mcp.json` from reaching recursive consumers — `resolveEnvVarsInObject`
 * and the `JSON.stringify` inside `hashMcpServerConfig` are both recursive and
 * blow the call stack with `RangeError` well before any legitimate config does.
 * Exceeding it is reported through `errors` and the entry is skipped, so a
 * pathological file degrades one server instead of crashing `qwen`,
 * `qwen mcp list` and `qwen mcp approve`.
 */
export const MAX_MCP_SERVER_CONFIG_DEPTH = 64;

/**
 * Whether `root` nests objects/arrays deeper than `maxDepth`.
 *
 * Iterative on purpose: a recursive depth probe would itself overflow on the
 * input it is meant to reject.
 *
 * A repeated reference — a cycle, or the same object reachable by two paths —
 * counts as EXCEEDING. That is the fail-closed direction and it matters: an
 * earlier version skipped repeats instead, which let a cyclic graph finish the
 * walk reporting "within limit" and then hand the very same object to the
 * recursive resolver. Rejecting costs nothing here, because `JSON.parse` output
 * is always a tree — it can produce neither a cycle nor a shared subtree — so
 * for both of its callers — this loader and `parseMcpConfig` — the branch is
 * unreachable. It exists so the helper is safe for a caller whose input did not
 * come from `JSON.parse`, and it also keeps the walk's work bounded, which
 * dropping the set would not.
 */
export function exceedsMaxDepth(root: unknown, maxDepth: number): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [
    { value: root, depth: 1 },
  ];
  const seen = new Set<object>();
  while (stack.length > 0) {
    const { value, depth } = stack.pop()!;
    if (value === null || typeof value !== 'object') {
      continue;
    }
    if (depth > maxDepth) {
      return true;
    }
    if (seen.has(value)) {
      // Cyclic or shared — unbounded depth, or at least not a tree. Fail closed.
      return true;
    }
    seen.add(value);
    const children = Array.isArray(value) ? value : Object.values(value);
    for (const child of children) {
      stack.push({ value: child, depth: depth + 1 });
    }
  }
  return false;
}

/**
 * Expand `$VAR` / `${VAR}` in the transport fields of one server entry, leaving
 * every other field byte-identical. Returns the input unchanged when it has no
 * expandable field, so untouched entries keep their object identity.
 */
function resolveTransportEnvVars(config: MCPServerConfig): MCPServerConfig {
  const source = config as unknown as Record<string, unknown>;
  let resolved: Record<string, unknown> | undefined;
  for (const field of ENV_EXPANDED_TRANSPORT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) {
      continue;
    }
    const original = source[field];
    const value = resolveEnvVarsInObject(original);
    if (value === original) {
      continue;
    }
    resolved ??= { ...source };
    resolved[field] = value;
  }
  return (resolved ?? config) as unknown as MCPServerConfig;
}

export interface LoadProjectMcpServersResult {
  /**
   * Servers declared in `.mcp.json`, each tagged `scope: 'project'`. These are
   * UNTRUSTED until the user approves them — loading is side-effect-free and
   * MUST NOT trigger any connection (see issue #4615). Empty when no readable
   * `.mcp.json` exists.
   */
  servers: Record<string, MCPServerConfig>;
  /** Absolute path of the `.mcp.json` that was read, if any. */
  path: string | undefined;
  /** Non-fatal problems (missing/malformed file, bad shape). Never throws. */
  errors: string[];
}

/**
 * Load project-scoped MCP servers from `<projectRoot>/.mcp.json`.
 *
 * This is a pure read: it parses JSON and tags each server with
 * `scope: 'project'` so the discovery layer can gate it behind approval. It
 * never spawns a process, opens a transport, or runs a health check. A missing
 * file is normal (returns empty); a malformed file is reported via `errors` and
 * otherwise ignored so it can never crash startup.
 *
 * `$VAR` / `${VAR}` placeholders are expanded with the same resolver every
 * settings scope uses, so a checked-in `.mcp.json` can reference a secret
 * instead of embedding it.
 *
 * This is deliberately NOT full parity with a settings scope. `loadSettings`
 * hands the whole document to the resolver, so every string in it expands;
 * here only {@link ENV_EXPANDED_TRANSPORT_FIELDS} does. A `.mcp.json` is
 * repository-supplied, and expanding a cosmetic `description` or a provenance
 * `extensionName` buys nothing while widening what a committed file can pull
 * out of the environment — so this loader expands the fields that decide what
 * runs and what it connects to, and leaves the rest byte-identical.
 *
 * Expansion is per-source, not global: `--mcp-config` documents go through
 * `parseMcpConfig`, which resolves the whole object, so the same bytes expand
 * differently depending on which of the two supplied them. There is no escape
 * for a literal `$` — a value that must survive verbatim cannot currently be
 * written in an expanded field, and the resolver has no `$$` form. A `${VAR}`
 * with no matching variable is left in place as text, silently: the loader
 * emits no diagnostic for it, so a typo'd name reaches the transport as a
 * literal rather than as an error. That is the shared resolver's behaviour,
 * relied on so an unset variable cannot collapse a value to the empty string.
 * A variable set but EMPTY does collapse it, which for `command` or `url`
 * yields `''`. Because a resolved value participates in the approval digest,
 * changing one of these variables re-prompts for approval even though the file
 * on disk is untouched — see `mcpApprovals.ts` for why that is the intended
 * end of the tradeoff.
 *
 * A server entry nested deeper than {@link MAX_MCP_SERVER_CONFIG_DEPTH} is
 * reported via `errors` and skipped instead of being handed to the recursive
 * resolver, and any unexpected throw while processing one entry is likewise
 * demoted to an `errors` line. One hostile entry therefore costs that one
 * server, never the process. Note the scope of that guarantee: it covers this
 * loader and the `.mcp.json` path only. It is not a process-wide bound on
 * `resolveEnvVarsInObject`, which stays unbounded for every other caller —
 * `parseMcpConfig` applies its own equivalent check, and settings scopes have
 * none.
 *
 * Deliberately NO `getHomeEnvFallbackVars()` here, unlike `loadSettings`.
 * Settings need that fallback because they resolve before `loadEnvironment()`
 * runs; `.mcp.json` is read only from `assembleMcpServers`, which every caller
 * reaches after `loadSettings()` has already run `loadEnvironment()` and put
 * every `.env` that discovery accepts into `process.env` — not just the
 * user-level `<QWEN_HOME>/.env`, `~/.qwen/.env` and `~/.env`, but the workspace
 * ones `findEnvFiles` walks up to from the project directory, i.e.
 * `<repo>/.qwen/.env` and `<repo>/.env`, whenever the workspace is trusted.
 * That repo-level `.env` matters here: it means a checked-out repository can
 * already supply the values its own `.mcp.json` placeholders resolve to, which
 * is the intended workflow, not a bypass — the trust gate on it is workspace
 * trust, and the approval gate still applies to the server itself. The only
 * keys the fallback would add on top of
 * `process.env` are the ones `loadEnvironment` deliberately REFUSED to apply —
 * loader-affecting keys (`isLoaderEnvKey`, e.g. `NODE_OPTIONS`) and private
 * provenance markers. Passing it would let a repository-supplied `.mcp.json`
 * read exactly the values the env loader withholds, which is the #8653 vector
 * rather than a fix.
 *
 * `resolveEnvVarsInObject` keeps the internal-secret guard, so a repo-supplied
 * `.mcp.json` still cannot read Qwen's own secret env vars. Resolution happens
 * before approval hashing, so the user approves the config that will actually
 * be used — matching gated workspace-scope servers, whose settings are already
 * resolved by the time `assembleMcpServers` sees them.
 */
export function loadProjectMcpServers(
  projectRoot: string,
): LoadProjectMcpServersResult {
  const filePath = path.join(projectRoot, PROJECT_MCP_FILENAME);

  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    // Missing/unreadable file is the common case — not an error.
    return { servers: {}, path: undefined, errors: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch (e) {
    return {
      servers: {},
      path: filePath,
      errors: [`Failed to parse ${filePath}: ${(e as Error).message}`],
    };
  }

  const mcpServers = (parsed as { mcpServers?: unknown })?.mcpServers;
  if (
    !mcpServers ||
    typeof mcpServers !== 'object' ||
    Array.isArray(mcpServers)
  ) {
    return {
      servers: {},
      path: filePath,
      errors: [`${filePath} has no "mcpServers" object`],
    };
  }

  const servers: Record<string, MCPServerConfig> = Object.create(null);
  const errors: string[] = [];
  for (const [name, value] of Object.entries(
    mcpServers as Record<string, unknown>,
  )) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${filePath}: server "${name}" is not an object — skipped`);
      continue;
    }
    if (exceedsMaxDepth(value, MAX_MCP_SERVER_CONFIG_DEPTH)) {
      errors.push(
        `${filePath}: server "${name}" nests deeper than ` +
          `${MAX_MCP_SERVER_CONFIG_DEPTH} levels — skipped`,
      );
      continue;
    }
    try {
      // `.mcp.json` is the Claude Code convention, so entries may use Claude's
      // `type`-based transport shape; normalize them to Qwen's field-based shape.
      servers[name] = {
        ...normalizeClaudeMcpServer(
          resolveTransportEnvVars(value as MCPServerConfig),
        ),
        scope: 'project',
      };
    } catch (e) {
      // Last-resort net so no single entry can take down startup: the depth cap
      // above already covers the known stack-overflow path, but this loader is
      // reached by `qwen`, `qwen mcp list` and `qwen mcp approve` alike and must
      // stay total. "Never throws" is this function's stated contract — see the
      // `errors` field above and the malformed-file paragraph in its docstring,
      // both of which predate this guard; the parse `try/catch` already applies
      // it to the whole-file case, and this extends it per entry.
      errors.push(
        `${filePath}: server "${name}" could not be processed: ` +
          `${(e as Error).message} — skipped`,
      );
    }
  }

  return { servers, path: filePath, errors };
}
