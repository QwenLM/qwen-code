/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { matchesAny } from '../policy/glob.js';

/**
 * The match clause of a routing rule. Both fields are optional; an absent field
 * does not constrain (AND semantics across present fields).
 *
 * This slice honors `kind` + `sessionTag` (event-global) and `scopeIn` +
 * `tokenIdsIn` (per-subscription, cycle 33); later cycles add
 * `policy.decisionSource`/`originatingClientScope`/`subActor`/`mentionPatterns`/
 * `urgencyAtLeast`/`deviceTagsIn` (see the design's deferred list).
 */
export interface RoutingRuleMatch {
  /** Event kind: a single kind (equality) or a list (membership). */
  kind?: string | string[];
  /** Glob(s) matched against the session name (via the ReDoS-safe globMatch). */
  sessionTag?: string | string[];
  /**
   * Per-subscription (cycle 33): the subscription's owning-token scope(s). A
   * rule matches a subscription when its token holds AT LEAST ONE listed scope.
   * Exact string membership (scopes are a closed enum) — NOT a glob.
   */
  scopeIn?: string | string[];
  /**
   * Per-subscription (cycle 33): the subscription's owning-token id(s). Matches
   * when `subscription.tokenId` is one of the listed ids (exact membership).
   */
  tokenIdsIn?: string | string[];
}

/**
 * One routing rule. `route` keeps the design's nesting so later cycles add
 * `scopeIn`/`urgency`/… under it without a format break; this slice acts only on
 * `route.drop === true`.
 */
export interface RoutingRule {
  id?: string;
  match: RoutingRuleMatch;
  route: { drop?: boolean };
}

export interface RoutingConfig {
  version?: number;
  rules: RoutingRule[];
}

/** Thrown when a routing document fails schema validation. */
export class RoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutingError';
  }
}

/**
 * A subscription as seen by the per-subscription routing pass: its owning-token
 * id and that token's resolved scopes (already in hand in the notifier loop).
 */
export interface RoutingSubscription {
  tokenId: string;
  scopes: readonly string[];
}

/** A compiled, pure decision over the fields the notifier has. */
export interface RoutingMatcher {
  /**
   * The id of the first EVENT-GLOBAL `drop` rule matching this event, or `null`
   * when none matches. An unnamed matching rule reports `'<unnamed>'`. Rules
   * carrying a per-subscription field (`scopeIn`/`tokenIdsIn`) are EXCLUDED here
   * by construction — they can never suppress the whole fan-out.
   */
  firstDrop(ev: { kind: string; sessionName?: string }): string | null;
  /**
   * The id of the first PER-SUBSCRIPTION `drop` rule matching this (event,
   * subscription) pair, or `null`. Only rules carrying `scopeIn`/`tokenIdsIn`
   * participate; any event-global fields (`kind`/`sessionTag`) on such a rule
   * must also match (AND). Optional so a matcher predating this method still
   * satisfies the interface (the notifier calls it with `?.`).
   */
  firstDropForSubscription?(
    ev: { kind: string; sessionName?: string },
    sub: RoutingSubscription,
  ): string | null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** True when `v` is a string or an array of strings (the kind/sessionTag shape). */
function isStringOrStringArray(v: unknown): v is string | string[] {
  return (
    typeof v === 'string' ||
    (Array.isArray(v) && v.every((e) => typeof e === 'string'))
  );
}

const MATCH_HONORED = new Set(['kind', 'sessionTag', 'scopeIn', 'tokenIdsIn']);
const ROUTE_HONORED = new Set(['drop']);

let warnedDeferred = false;

/**
 * Parse and validate a routing YAML document. Throws {@link RoutingError} when
 * the doc is not a mapping, when `rules` is not a sequence, when any rule lacks
 * an object `match`/`route`, when `match.kind`/`match.sessionTag` is not a
 * string-or-string-array, or when `route.drop` is not a boolean. Unknown fields
 * are ignored (forward-compat); a once-per-process warning fires if a rule uses
 * a match/route field this slice does not yet honor.
 */
export function loadRoutingConfig(text: string): RoutingConfig {
  const doc = parse(text) ?? {};
  if (!isPlainObject(doc)) {
    throw new RoutingError('routing document must be a mapping');
  }

  const rulesRaw = doc['rules'] ?? [];
  if (!Array.isArray(rulesRaw)) {
    throw new RoutingError('rules must be a sequence');
  }

  const unhonored = new Set<string>();

  const rules: RoutingRule[] = rulesRaw.map((raw, i) => {
    if (!isPlainObject(raw)) {
      throw new RoutingError(`rule[${i}] must be a mapping`);
    }
    if (!isPlainObject(raw['match'])) {
      throw new RoutingError(`rule[${i}].match must be a mapping`);
    }
    if (!isPlainObject(raw['route'])) {
      throw new RoutingError(`rule[${i}].route must be a mapping`);
    }
    const matchRaw = raw['match'];
    const routeRaw = raw['route'];

    const match: RoutingRuleMatch = {};
    if (matchRaw['kind'] !== undefined) {
      if (!isStringOrStringArray(matchRaw['kind'])) {
        throw new RoutingError(
          `rule[${i}].match.kind must be a string or string list`,
        );
      }
      match.kind = matchRaw['kind'];
    }
    if (matchRaw['sessionTag'] !== undefined) {
      if (!isStringOrStringArray(matchRaw['sessionTag'])) {
        throw new RoutingError(
          `rule[${i}].match.sessionTag must be a string or string list`,
        );
      }
      match.sessionTag = matchRaw['sessionTag'];
    }
    if (matchRaw['scopeIn'] !== undefined) {
      if (!isStringOrStringArray(matchRaw['scopeIn'])) {
        throw new RoutingError(
          `rule[${i}].match.scopeIn must be a string or string list`,
        );
      }
      match.scopeIn = matchRaw['scopeIn'];
    }
    if (matchRaw['tokenIdsIn'] !== undefined) {
      if (!isStringOrStringArray(matchRaw['tokenIdsIn'])) {
        throw new RoutingError(
          `rule[${i}].match.tokenIdsIn must be a string or string list`,
        );
      }
      match.tokenIdsIn = matchRaw['tokenIdsIn'];
    }

    const route: { drop?: boolean } = {};
    if (routeRaw['drop'] !== undefined) {
      if (typeof routeRaw['drop'] !== 'boolean') {
        throw new RoutingError(`rule[${i}].route.drop must be a boolean`);
      }
      route.drop = routeRaw['drop'];
    }

    // Forward-compat: surface (once) any match/route field we don't yet honor,
    // so an operator's scopeIn/urgency/policy rule isn't silently inert.
    for (const k of Object.keys(matchRaw)) {
      if (!MATCH_HONORED.has(k)) unhonored.add(`match.${k}`);
    }
    for (const k of Object.keys(routeRaw)) {
      if (!ROUTE_HONORED.has(k)) unhonored.add(`route.${k}`);
    }

    const rule: RoutingRule = { match, route };
    if (raw['id'] !== undefined) rule.id = String(raw['id']);
    return rule;
  });

  if (unhonored.size > 0 && !warnedDeferred) {
    warnedDeferred = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[routing] ignoring not-yet-supported rule field(s): ` +
        `${[...unhonored].sort().join(', ')} (only match.kind/sessionTag/scopeIn/` +
        `tokenIdsIn + route.drop are honored this version)`,
    );
  }

  const config: RoutingConfig = { rules };
  if (typeof doc['version'] === 'number') config.version = doc['version'];
  return config;
}

/**
 * Load and validate a routing file. Returns `null` when the file is absent
 * (ENOENT) so callers can fall back to no routing (full fan-out); otherwise
 * delegates to {@link loadRoutingConfig} (which may throw {@link RoutingError}).
 */
export async function loadRoutingConfigFile(
  path: string,
): Promise<RoutingConfig | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
  return loadRoutingConfig(text);
}

/**
 * Merge two routing configs by PREPENDING the workspace rules to the user rules
 * (design D1 / spec.md:8-10: workspace rules evaluate first; both sets active).
 * A single {@link compileRouting} over the returned config then preserves
 * document-order first-match across the layer boundary. Pure; returns `null`
 * only when BOTH inputs are `null` (neither file present).
 */
export function mergeRoutingConfigs(
  workspace: RoutingConfig | null,
  user: RoutingConfig | null,
): RoutingConfig | null {
  if (!workspace && !user) return null;
  const merged: RoutingConfig = {
    rules: [...(workspace?.rules ?? []), ...(user?.rules ?? [])],
  };
  const version = workspace?.version ?? user?.version;
  if (version !== undefined) merged.version = version;
  return merged;
}

/**
 * Load one routing file FAIL-OPEN: a missing file (ENOENT) yields `null`, and a
 * malformed file ({@link RoutingError}) is logged via `warn` and ALSO yields
 * `null` — routing only suppresses, so the safe default on misconfig is more
 * notifications, never a missed prompt. Never throws.
 */
async function loadOneFailOpen(
  path: string,
  label: string,
  warn: (msg: string) => void,
): Promise<RoutingConfig | null> {
  try {
    return await loadRoutingConfigFile(path);
  } catch (err) {
    warn(`[routing] ignoring ${label}: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Load the user-level routing file and, when a workspace cwd is given, the
 * workspace override `<workspaceCwd>/.qwen/routing.yaml`, merge them (workspace
 * rules PREPENDED — design D1), and compile a single {@link RoutingMatcher}.
 *
 * Per-file FAIL-OPEN + NEVER-THROW (design D4): each layer is loaded
 * independently; a malformed file at either layer is logged and ignored while
 * the other layer still applies (`compileRouting` is total). Returns
 * `{ matcher: undefined, ruleCount: 0 }` when neither file exists. `warn`
 * defaults to a no-op (the CLI passes a `console.warn` wrapper).
 */
export async function loadLayeredRoutingMatcher(
  userPath: string,
  workspaceCwd: string | undefined,
  warn: (msg: string) => void = () => {},
): Promise<{ matcher: RoutingMatcher | undefined; ruleCount: number }> {
  const user = await loadOneFailOpen(userPath, 'routing.yaml', warn);
  const workspace = workspaceCwd
    ? await loadOneFailOpen(
        join(workspaceCwd, '.qwen', 'routing.yaml'),
        'workspace routing.yaml',
        warn,
      )
    : null;
  const merged = mergeRoutingConfigs(workspace, user);
  if (!merged) return { matcher: undefined, ruleCount: 0 };
  return { matcher: compileRouting(merged), ruleCount: merged.rules.length };
}

/** A present `kind` spec matches by equality (string) or membership (list). */
function matchKind(spec: string | string[] | undefined, kind: string): boolean {
  if (spec === undefined) return true;
  return Array.isArray(spec) ? spec.includes(kind) : spec === kind;
}

/**
 * A present `sessionTag` requires a known session name to match against; an
 * event with no name cannot satisfy the constraint (fail to NOT-suppress).
 */
function matchSessionTag(
  spec: string | string[] | undefined,
  name: string | undefined,
): boolean {
  if (spec === undefined) return true;
  if (name === undefined) return false;
  return matchesAny(spec, name);
}

/**
 * A present `scopeIn` requires the subscription's token to hold AT LEAST ONE
 * listed scope (exact membership; an empty list matches nobody — see D5).
 */
function matchScopeIn(
  spec: string | string[] | undefined,
  scopes: readonly string[],
): boolean {
  if (spec === undefined) return true;
  const wanted = Array.isArray(spec) ? spec : [spec];
  return scopes.some((s) => wanted.includes(s));
}

/** A present `tokenIdsIn` requires exact membership of the subscription's token id. */
function matchTokenIdsIn(
  spec: string | string[] | undefined,
  tokenId: string,
): boolean {
  if (spec === undefined) return true;
  return Array.isArray(spec) ? spec.includes(tokenId) : spec === tokenId;
}

/** A rule targets specific subscriptions iff it carries scopeIn or tokenIdsIn. */
function hasPerSubMatch(r: RoutingRule): boolean {
  return r.match.scopeIn !== undefined || r.match.tokenIdsIn !== undefined;
}

/**
 * Compile a config into a {@link RoutingMatcher}. Only `route.drop === true`
 * rules participate; rules are evaluated in document order and the first match
 * wins. Drop rules are PARTITIONED: those with no per-subscription field
 * participate in the event-global {@link RoutingMatcher.firstDrop} pass; those
 * carrying `scopeIn`/`tokenIdsIn` participate ONLY in the per-subscription
 * {@link RoutingMatcher.firstDropForSubscription} pass — so a per-subscription
 * rule can never suppress the whole fan-out.
 */
export function compileRouting(config: RoutingConfig): RoutingMatcher {
  const dropRules = config.rules.filter((r) => r.route.drop === true);
  const globalDropRules = dropRules.filter((r) => !hasPerSubMatch(r));
  const perSubDropRules = dropRules.filter(hasPerSubMatch);
  return {
    firstDrop(ev) {
      for (const r of globalDropRules) {
        if (
          matchKind(r.match.kind, ev.kind) &&
          matchSessionTag(r.match.sessionTag, ev.sessionName)
        ) {
          // `||` not `??`: a non-null return signals "matched", and the notifier
          // gates on truthiness — an empty-string id (`id: ""`) must still
          // suppress, reported under the '<unnamed>' label.
          return r.id || '<unnamed>';
        }
      }
      return null;
    },
    firstDropForSubscription(ev, sub) {
      for (const r of perSubDropRules) {
        if (
          matchKind(r.match.kind, ev.kind) &&
          matchSessionTag(r.match.sessionTag, ev.sessionName) &&
          matchScopeIn(r.match.scopeIn, sub.scopes) &&
          matchTokenIdsIn(r.match.tokenIdsIn, sub.tokenId)
        ) {
          return r.id || '<unnamed>';
        }
      }
      return null;
    },
  };
}
