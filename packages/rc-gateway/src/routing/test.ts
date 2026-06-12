/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RoutingMatcher } from './rules.js';

/** A hypothetical subscription described on the CLI via `--sub=<scopes>[@id]`. */
export interface RoutingTestSub {
  /** The raw `--sub` spec, shown verbatim in the output row. */
  label: string;
  /** Optional token id (after `@`); without one, `tokenIdsIn` rules can't match. */
  tokenId?: string;
  /** The token scopes (comma-separated before any `@`). */
  scopes: string[];
}

/** The parsed `routing test` request: the synthetic event + hypothetical subs. */
export interface RoutingTestRequest {
  event: { kind: string; sessionName?: string };
  subs: RoutingTestSub[];
  /** `--resolved`: overlay the workspace routing.yaml on the user file. */
  resolved: boolean;
}

/** Parse outcome; `ok:false` carries a usage message and maps to exit code 2. */
export type RoutingTestParse =
  | { ok: true; request: RoutingTestRequest }
  | { ok: false; error: string };

/**
 * Parse the argv AFTER `routing test` plus pre-read `stdin` text into a
 * {@link RoutingTestRequest}. The synthetic event is the first positional token
 * (JSON), else `stdin`. Flags: `--sub=<scopes>[@<tokenId>]` (repeatable),
 * `--resolved`. Unknown flags are ignored (lenient, matching `parseExplainArgs`).
 *
 * Honored event fields are `kind` (required non-empty string) and `sessionName`
 * (optional string) — exactly what the compiled matcher consumes; any other
 * field is accepted and ignored, so a fuller daemon event also works. Hard
 * errors (→ exit 2): no event, unparseable JSON, a non-object event, or a
 * missing/empty `kind`.
 */
export function parseRoutingTest(
  argv: string[],
  stdin: string | null,
): RoutingTestParse {
  let positional: string | undefined;
  let resolved = false;
  const subSpecs: string[] = [];
  for (const a of argv) {
    if (a === '--resolved') {
      resolved = true;
    } else if (a.startsWith('--sub=')) {
      subSpecs.push(a.slice('--sub='.length));
    } else if (a.startsWith('--')) {
      // Unknown flag: ignored (lenient, like the policy-explain inspector).
    } else if (positional === undefined) {
      positional = a;
    }
  }

  const eventText = (positional ?? stdin ?? '').trim();
  if (!eventText) {
    return {
      ok: false,
      error:
        'routing test: no event JSON (pass it as an argument or on stdin, ' +
        'e.g. {"kind":"permission.required"})',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(eventText);
  } catch {
    return { ok: false, error: 'routing test: event is not valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'routing test: event JSON must be an object' };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj['kind'] !== 'string' || obj['kind'] === '') {
    return {
      ok: false,
      error: 'routing test: event JSON must have a non-empty string "kind"',
    };
  }
  const event: { kind: string; sessionName?: string } = { kind: obj['kind'] };
  if (typeof obj['sessionName'] === 'string') {
    event.sessionName = obj['sessionName'];
  }

  const subs: RoutingTestSub[] = subSpecs.map((spec) => {
    const at = spec.indexOf('@');
    const scopesPart = at >= 0 ? spec.slice(0, at) : spec;
    const tokenId = at >= 0 ? spec.slice(at + 1) : '';
    const scopes = scopesPart
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return { label: spec, scopes, ...(tokenId ? { tokenId } : {}) };
  });

  return { ok: true, request: { event, subs, resolved } };
}

/** One row of the decisions table. */
export interface RoutingTestDecision {
  /** The `--sub` label, or `(all subscriptions)` for the event-global row. */
  label: string;
  decision: 'send' | 'suppress';
  /** The matching drop rule's id when suppressed. */
  ruleId?: string;
  scope?: 'event_global' | 'per_subscription';
}

/** The whole dry-run result the formatter renders. */
export interface RoutingTestResult {
  kind: string;
  sessionName?: string;
  ruleCount: number;
  /** False when no routing file was loaded (matcher undefined). */
  rulesLoaded: boolean;
  /** False when no `--sub` was given (only the event-global pass ran). */
  perSubEvaluated: boolean;
  decisions: RoutingTestDecision[];
}

/**
 * Compute the routing-layer DROP decisions for the request. An event-global
 * `firstDrop` match suppresses ALL subscriptions; otherwise each sub is checked
 * against the per-subscription pass. With no `--sub`, only the event-global pass
 * runs (one `(all subscriptions)` row). A `matcher` of `undefined` (no routing
 * file) means nothing is dropped — every row is `send`.
 */
export function evaluateRoutingTest(
  matcher: RoutingMatcher | undefined,
  request: RoutingTestRequest,
  ruleCount: number,
): RoutingTestResult {
  const { event, subs } = request;
  const eventGlobal = matcher ? matcher.firstDrop(event) : null;
  const base = {
    kind: event.kind,
    ...(event.sessionName !== undefined
      ? { sessionName: event.sessionName }
      : {}),
    ruleCount,
    rulesLoaded: matcher !== undefined,
  };

  if (subs.length === 0) {
    const decision: RoutingTestDecision = eventGlobal
      ? {
          label: '(all subscriptions)',
          decision: 'suppress',
          ruleId: eventGlobal,
          scope: 'event_global',
        }
      : { label: '(all subscriptions)', decision: 'send' };
    return { ...base, perSubEvaluated: false, decisions: [decision] };
  }

  const decisions = subs.map((sub): RoutingTestDecision => {
    if (eventGlobal) {
      return {
        label: sub.label,
        decision: 'suppress',
        ruleId: eventGlobal,
        scope: 'event_global',
      };
    }
    const perSub =
      matcher?.firstDropForSubscription?.(event, {
        tokenId: sub.tokenId ?? '',
        scopes: sub.scopes,
      }) ?? null;
    if (perSub) {
      return {
        label: sub.label,
        decision: 'suppress',
        ruleId: perSub,
        scope: 'per_subscription',
      };
    }
    return { label: sub.label, decision: 'send' };
  });
  return { ...base, perSubEvaluated: true, decisions };
}

/** The honesty footer — see the design's "must-get-right" note. */
const SCOPE_NOTE =
  'NOTE: this evaluates ONLY routing.yaml drop rules. snooze, per-subscription\n' +
  'prefs, quiet-hours, working-device suppression, and the rate limiter are NOT\n' +
  'considered - a routing-layer "would_send" can still be dropped downstream.';

/** Render a {@link RoutingTestResult} as the operator-facing decisions table. */
export function formatRoutingTest(r: RoutingTestResult): string {
  const lines: string[] = [];
  lines.push(
    `routing test: kind=${r.kind} session=${r.sessionName ?? '(any)'} ` +
      `rules=${r.ruleCount}`,
  );
  lines.push('');
  for (const d of r.decisions) {
    const verdict = d.decision === 'send' ? 'would_send' : 'would_suppress';
    const suffix =
      d.decision === 'suppress' ? `  rule=${d.ruleId} (${d.scope})` : '';
    lines.push(`  routing-layer: ${verdict.padEnd(14)}  ${d.label}${suffix}`);
  }
  lines.push('');
  if (!r.rulesLoaded) {
    lines.push(
      'no routing rules loaded - nothing is dropped at the routing layer.',
    );
  } else if (!r.perSubEvaluated) {
    lines.push(
      'no --sub given; per-subscription drop rules not evaluated ' +
        '(event-global only).',
    );
  }
  lines.push(SCOPE_NOTE);
  return lines.join('\n');
}
