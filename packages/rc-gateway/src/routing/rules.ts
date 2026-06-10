/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { matchesAny } from '../policy/glob.js';

/**
 * The match clause of a routing rule. Both fields are optional; an absent field
 * does not constrain (AND semantics across present fields).
 *
 * This slice honors only `kind` + `sessionTag`; later cycles add
 * `policy.decisionSource`/`originatingClientScope`/`subActor`/`mentionPatterns`/
 * `urgencyAtLeast` (see the design's deferred list).
 */
export interface RoutingRuleMatch {
  /** Event kind: a single kind (equality) or a list (membership). */
  kind?: string | string[];
  /** Glob(s) matched against the session name (via the ReDoS-safe globMatch). */
  sessionTag?: string | string[];
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

/** A compiled, pure decision over the event-global fields the notifier has. */
export interface RoutingMatcher {
  /**
   * The id of the first `drop` rule matching this event, or `null` when no drop
   * rule matches. An unnamed matching rule reports `'<unnamed>'`.
   */
  firstDrop(ev: { kind: string; sessionName?: string }): string | null;
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

const MATCH_HONORED = new Set(['kind', 'sessionTag']);
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
        `${[...unhonored].sort().join(', ')} (only kind/sessionTag + route.drop ` +
        `are honored this version)`,
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
 * Compile a config into a {@link RoutingMatcher}. Only `route.drop === true`
 * rules participate; rules are evaluated in document order and the first match
 * wins.
 */
export function compileRouting(config: RoutingConfig): RoutingMatcher {
  const dropRules = config.rules.filter((r) => r.route.drop === true);
  return {
    firstDrop(ev) {
      for (const r of dropRules) {
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
  };
}
