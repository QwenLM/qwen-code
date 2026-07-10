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
 * This slice honors `kind` + `sessionTag` (event-global), `scopeIn` +
 * `tokenIdsIn` (per-subscription, cycle 33), `urgencyAtLeast` (cycle 96), and
 * the deferred operators now implemented below.
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
  /**
   * Event-global (cycle 96): matches when the event's URGENCY (derived from its
   * kind — see {@link urgencyOf}) is at least this level. One of
   * 'low' | 'medium' | 'high'. e.g. `urgencyAtLeast: high` matches only
   * action-required events (permission.required); a `drop` rule using it sheds
   * exactly that band. Derivable from `kind` alone, so it needs no event content.
   */
  urgencyAtLeast?: RoutingUrgency;
  /**
   * Per-event: the scope of the token that originated the client request which
   * triggered this event (e.g. `'owner'`/`'write'`/`'share'`/…). Exact
   * string or list membership. Absent → matches any scope.
   */
  originatingClientScope?: string | string[];
  /**
   * Per-event: the policy decision source (e.g. `'file'`/`'default'`/`'api'`).
   * Exact string or list membership. Absent → matches any source.
   */
  'policy.decisionSource'?: string | string[];
  /**
   * Per-event: the policy action (`'allow'`/`'deny'`/`'ask'`). Exact string or
   * list membership. Absent → matches any action.
   */
  'policy.action'?: string | string[];
  /**
   * Per-event: the sub-actor identifier (bridge delegate id). Exact string or
   * list membership. Absent (or event carries no sub-actor) → not constrained.
   */
  subActor?: string | string[];
  /**
   * Per-subscription: when `true`, the rule additionally requires the
   * subscription's owning-token to be considered a "working device" (token
   * posted recently) for the match to fire. When `false` or absent, no
   * working-device constraint is applied.
   */
  suppressIfWorkingDevice?: boolean;
}

/** Routing urgency band, low→high. Derived from event kind (no content needed). */
export type RoutingUrgency = 'low' | 'medium' | 'high';
const URGENCY_LEVELS: readonly RoutingUrgency[] = ['low', 'medium', 'high'];

/**
 * Map an event kind to its urgency band. Action-required prompts are HIGH;
 * everything else (completions, digests, …) is LOW. A closed map with a LOW
 * default keeps this pure + content-free (the privacy-preserving notifier only
 * has the kind). Extend here as new kinds gain a natural urgency.
 */
function urgencyOf(kind: string): RoutingUrgency {
  return kind === 'permission.required' ? 'high' : 'low';
}

/** A present `urgencyAtLeast` matches when the kind's urgency ≥ the threshold. */
function matchUrgencyAtLeast(
  spec: RoutingUrgency | undefined,
  kind: string,
): boolean {
  if (spec === undefined) return true;
  return (
    URGENCY_LEVELS.indexOf(urgencyOf(kind)) >= URGENCY_LEVELS.indexOf(spec)
  );
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

/**
 * Event-level context available at routing-decision time. Extends the bare
 * `{ kind, sessionName }` shape with per-event metadata for the deferred
 * operators so matching is still pure / context-free from the notifier's POV.
 */
export interface RoutingEvent {
  kind: string;
  sessionName?: string;
  /** Scope of the token that originated the request (for originatingClientScope). */
  originatingClientScope?: string;
  /** Policy decision source (`'file'`/`'default'`/`'api'`). */
  policyDecisionSource?: string;
  /** Policy action (`'allow'`/`'deny'`/`'ask'`). */
  policyAction?: string;
  /** Sub-actor identifier (bridge delegate). */
  subActor?: string;
}

/** A compiled, pure decision over the fields the notifier has. */
export interface RoutingMatcher {
  /**
   * The id of the first EVENT-GLOBAL `drop` rule matching this event, or `null`
   * when none matches. An unnamed matching rule reports `'<unnamed>'`. Rules
   * carrying a per-subscription field (`scopeIn`/`tokenIdsIn`) are EXCLUDED here
   * by construction — they can never suppress the whole fan-out.
   */
  firstDrop(
    ev: RoutingEvent | { kind: string; sessionName?: string },
  ): string | null;
  /**
   * The id of the first PER-SUBSCRIPTION `drop` rule matching this (event,
   * subscription) pair, or `null`. Only rules carrying `scopeIn`/`tokenIdsIn`
   * participate; any event-global fields (`kind`/`sessionTag`) on such a rule
   * must also match (AND). Optional so a matcher predating this method still
   * satisfies the interface (the notifier calls it with `?.`).
   */
  firstDropForSubscription?(
    ev: RoutingEvent | { kind: string; sessionName?: string },
    sub: RoutingSubscription,
    isWorkingDevice?: boolean,
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

const MATCH_HONORED = new Set([
  'kind',
  'sessionTag',
  'scopeIn',
  'tokenIdsIn',
  'urgencyAtLeast',
  'originatingClientScope',
  'policy.decisionSource',
  'policy.action',
  'subActor',
  'suppressIfWorkingDevice',
]);
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
    if (matchRaw['urgencyAtLeast'] !== undefined) {
      const u = matchRaw['urgencyAtLeast'];
      if (
        typeof u !== 'string' ||
        !URGENCY_LEVELS.includes(u as RoutingUrgency)
      ) {
        throw new RoutingError(
          `rule[${i}].match.urgencyAtLeast must be one of low|medium|high`,
        );
      }
      match.urgencyAtLeast = u as RoutingUrgency;
    }
    if (matchRaw['originatingClientScope'] !== undefined) {
      if (!isStringOrStringArray(matchRaw['originatingClientScope'])) {
        throw new RoutingError(
          `rule[${i}].match.originatingClientScope must be a string or string list`,
        );
      }
      match.originatingClientScope = matchRaw['originatingClientScope'] as
        | string
        | string[];
    }
    if (matchRaw['policy.decisionSource'] !== undefined) {
      if (!isStringOrStringArray(matchRaw['policy.decisionSource'])) {
        throw new RoutingError(
          `rule[${i}].match.'policy.decisionSource' must be a string or string list`,
        );
      }
      match['policy.decisionSource'] = matchRaw['policy.decisionSource'] as
        | string
        | string[];
    }
    if (matchRaw['policy.action'] !== undefined) {
      if (!isStringOrStringArray(matchRaw['policy.action'])) {
        throw new RoutingError(
          `rule[${i}].match.'policy.action' must be a string or string list`,
        );
      }
      match['policy.action'] = matchRaw['policy.action'] as string | string[];
    }
    if (matchRaw['subActor'] !== undefined) {
      if (!isStringOrStringArray(matchRaw['subActor'])) {
        throw new RoutingError(
          `rule[${i}].match.subActor must be a string or string list`,
        );
      }
      match.subActor = matchRaw['subActor'] as string | string[];
    }
    if (matchRaw['suppressIfWorkingDevice'] !== undefined) {
      if (typeof matchRaw['suppressIfWorkingDevice'] !== 'boolean') {
        throw new RoutingError(
          `rule[${i}].match.suppressIfWorkingDevice must be a boolean`,
        );
      }
      match.suppressIfWorkingDevice = matchRaw[
        'suppressIfWorkingDevice'
      ] as boolean;
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
 * Load one routing file FAIL-OPEN: a missing file (ENOENT) yields `null`, and
 * ANY other failure — a {@link RoutingError} (malformed schema), a YAML parse
 * error, or an fs error like EACCES/EISDIR — is logged via `warn` and ALSO
 * yields `null`. Routing only suppresses, so the safe default on misconfig is
 * more notifications, never a missed prompt. This broad catch is what makes the
 * function (and its caller) never throw.
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
 * Load both routing layers FAIL-OPEN: the user file first, then (when a workspace
 * cwd is given) the workspace override `<workspaceCwd>/.qwen/routing.yaml`. Each
 * is independently caught (a malformed file → logged + null). Returns the two
 * configs plus the resolved workspace file path (undefined when no cwd). Shared
 * by {@link loadLayeredRoutingMatcher} (runtime) and {@link loadResolvedRoutingRules}
 * (the `routing rules` inspector) so they never drift. Never throws.
 */
async function loadBothRoutingLayers(
  userPath: string,
  workspaceCwd: string | undefined,
  warn: (msg: string) => void,
): Promise<{
  workspace: RoutingConfig | null;
  user: RoutingConfig | null;
  workspacePath: string | undefined;
}> {
  const user = await loadOneFailOpen(userPath, 'routing.yaml', warn);
  const workspacePath = workspaceCwd
    ? join(workspaceCwd, '.qwen', 'routing.yaml')
    : undefined;
  const workspace = workspacePath
    ? await loadOneFailOpen(workspacePath, 'workspace routing.yaml', warn)
    : null;
  return { workspace, user, workspacePath };
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
  const { workspace, user } = await loadBothRoutingLayers(
    userPath,
    workspaceCwd,
    warn,
  );
  const merged = mergeRoutingConfigs(workspace, user);
  if (!merged) return { matcher: undefined, ruleCount: 0 };
  return { matcher: compileRouting(merged), ruleCount: merged.rules.length };
}

/**
 * STRICT variant of {@link loadLayeredRoutingMatcher} for HOT-RELOAD: a malformed
 * file at EITHER layer THROWS ({@link RoutingError}/YAML/fs error) instead of
 * being logged-and-ignored. A reload must RETAIN the previously-compiled ruleset
 * on a parse error (spec: "Parse failure preserves prior rules" + emits
 * `routing_reload_failed`) — silently dropping a bad layer would instead WIDEN
 * the fan-out (fewer drops) on a half-typed save, the opposite of the spec. A
 * MISSING file (ENOENT) at either layer is NOT an error: it resolves to no rules
 * for that layer (an intended removal), matching the boot loader. Returns
 * `{ matcher: undefined, ruleCount: 0 }` when neither file exists.
 */
export async function loadLayeredRoutingMatcherStrict(
  userPath: string,
  workspaceCwd: string | undefined,
): Promise<{ matcher: RoutingMatcher | undefined; ruleCount: number }> {
  const user = await loadRoutingConfigFile(userPath);
  const workspace = workspaceCwd
    ? await loadRoutingConfigFile(join(workspaceCwd, '.qwen', 'routing.yaml'))
    : null;
  const merged = mergeRoutingConfigs(workspace, user);
  if (!merged) return { matcher: undefined, ruleCount: 0 };
  return { matcher: compileRouting(merged), ruleCount: merged.rules.length };
}

/** One rule of the resolved (merged) routing ruleset, with its source file path. */
export interface ResolvedRoutingRule {
  /** The file the rule was loaded from (workspace or user routing.yaml path). */
  source: string;
  rule: RoutingRule;
}

/**
 * The effective (merged) routing ruleset for the `routing rules` inspector:
 * workspace rules FIRST (each tagged with the workspace file path), then user
 * rules (tagged with the user file path) — mirroring cycle-36's prepend and the
 * spec's "workspace first" ordering. `workspaceCwd` undefined → user rules only.
 * Per-file FAIL-OPEN (a malformed layer is logged + omitted); never throws.
 */
export async function loadResolvedRoutingRules(
  userPath: string,
  workspaceCwd: string | undefined,
  warn: (msg: string) => void = () => {},
): Promise<ResolvedRoutingRule[]> {
  const { workspace, user, workspacePath } = await loadBothRoutingLayers(
    userPath,
    workspaceCwd,
    warn,
  );
  const out: ResolvedRoutingRule[] = [];
  if (workspace && workspacePath) {
    for (const rule of workspace.rules)
      out.push({ source: workspacePath, rule });
  }
  if (user) {
    for (const rule of user.rules) out.push({ source: userPath, rule });
  }
  return out;
}

/** Render a `kind`/`sessionTag`/`scopeIn`/`tokenIdsIn` spec for display. */
function fmtSpec(spec: string | string[]): string {
  return Array.isArray(spec) ? `[${spec.join(',')}]` : spec;
}

/**
 * Render the resolved ruleset as one line per rule (source path, id, a compact
 * match summary — `any` when the match is empty — and the drop flag). An empty
 * ruleset renders `(no routing rules)`. Pure, no I/O.
 */
export function formatResolvedRouting(rules: ResolvedRoutingRule[]): string {
  if (rules.length === 0) return '(no routing rules)';
  return rules
    .map(({ source, rule }) => {
      const id = rule.id || '<unnamed>';
      const m = rule.match;
      const parts: string[] = [];
      if (m.kind !== undefined) parts.push(`kind=${fmtSpec(m.kind)}`);
      if (m.sessionTag !== undefined)
        parts.push(`sessionTag=${fmtSpec(m.sessionTag)}`);
      if (m.scopeIn !== undefined) parts.push(`scopeIn=${fmtSpec(m.scopeIn)}`);
      if (m.tokenIdsIn !== undefined)
        parts.push(`tokenIdsIn=${fmtSpec(m.tokenIdsIn)}`);
      if (m.urgencyAtLeast !== undefined)
        parts.push(`urgencyAtLeast=${m.urgencyAtLeast}`);
      if (m.originatingClientScope !== undefined)
        parts.push(
          `originatingClientScope=${fmtSpec(m.originatingClientScope)}`,
        );
      if (m['policy.decisionSource'] !== undefined)
        parts.push(
          `policy.decisionSource=${fmtSpec(m['policy.decisionSource'])}`,
        );
      if (m['policy.action'] !== undefined)
        parts.push(`policy.action=${fmtSpec(m['policy.action'])}`);
      if (m.subActor !== undefined)
        parts.push(`subActor=${fmtSpec(m.subActor)}`);
      if (m.suppressIfWorkingDevice !== undefined)
        parts.push(`suppressIfWorkingDevice=${m.suppressIfWorkingDevice}`);
      const match = parts.length > 0 ? parts.join(' ') : 'any';
      return `${source}  ${id}  match: ${match}  drop:${rule.route.drop === true}`;
    })
    .join('\n');
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

/** Match a string-or-list spec against a value (exact string or membership). */
function matchStringSpec(
  spec: string | string[] | undefined,
  value: string | undefined,
): boolean {
  if (spec === undefined) return true;
  if (value === undefined) return false;
  return Array.isArray(spec) ? spec.includes(value) : spec === value;
}

/** A rule targets specific subscriptions iff it carries scopeIn, tokenIdsIn, or suppressIfWorkingDevice. */
function hasPerSubMatch(r: RoutingRule): boolean {
  return (
    r.match.scopeIn !== undefined ||
    r.match.tokenIdsIn !== undefined ||
    r.match.suppressIfWorkingDevice !== undefined
  );
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

  function matchEventFields(r: RoutingRule, ev: RoutingEvent): boolean {
    return (
      matchKind(r.match.kind, ev.kind) &&
      matchSessionTag(r.match.sessionTag, ev.sessionName) &&
      matchUrgencyAtLeast(r.match.urgencyAtLeast, ev.kind) &&
      matchStringSpec(
        r.match.originatingClientScope,
        ev.originatingClientScope,
      ) &&
      matchStringSpec(
        r.match['policy.decisionSource'],
        ev.policyDecisionSource,
      ) &&
      matchStringSpec(r.match['policy.action'], ev.policyAction) &&
      matchStringSpec(r.match.subActor, ev.subActor)
    );
  }

  return {
    firstDrop(ev) {
      const richEv = ev as RoutingEvent;
      for (const r of globalDropRules) {
        if (matchEventFields(r, richEv)) {
          // `||` not `??`: a non-null return signals "matched", and the notifier
          // gates on truthiness — an empty-string id (`id: ""`) must still
          // suppress, reported under the '<unnamed>' label.
          return r.id || '<unnamed>';
        }
      }
      return null;
    },
    firstDropForSubscription(ev, sub, isWorkingDevice = false) {
      const richEv = ev as RoutingEvent;
      for (const r of perSubDropRules) {
        if (
          matchEventFields(r, richEv) &&
          matchScopeIn(r.match.scopeIn, sub.scopes) &&
          matchTokenIdsIn(r.match.tokenIdsIn, sub.tokenId) &&
          // suppressIfWorkingDevice: true → only suppresses when the device IS working
          (r.match.suppressIfWorkingDevice === undefined ||
            r.match.suppressIfWorkingDevice === isWorkingDevice)
        ) {
          return r.id || '<unnamed>';
        }
      }
      return null;
    },
  };
}
