/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

export type PolicyAction = 'allow' | 'deny' | 'prompt';

export interface PolicyRuleMatch {
  tool?: string;
  argsGlob?: string | string[];
  pathGlob?: string | string[];
  originScope?: string;
  sessionTag?: string;
  // Deferred (parsed, not evaluated this cycle):
  timeOfDay?: unknown;
}

export interface PolicyRule {
  id?: string;
  match: PolicyRuleMatch;
  action: PolicyAction;
  requireScope?: string;
  reason?: string;
  priority?: number;
  // Deferred (parsed, not evaluated this cycle):
  maxPerWindow?: unknown;
  expiresAt?: unknown;
}

export interface Policy {
  version?: number;
  defaults: { action: PolicyAction; requireScope?: string };
  rules: PolicyRule[];
}

/** Thrown when a policy document fails schema validation. */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

const ACTIONS: readonly PolicyAction[] = ['allow', 'deny', 'prompt'];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isAction(v: unknown): v is PolicyAction {
  return typeof v === 'string' && (ACTIONS as readonly string[]).includes(v);
}

let warnedDeferred = false;

/**
 * Parse and validate a policy YAML document. Throws {@link PolicyError} when
 * the doc is not a plain object, when `defaults.action` (if present) is not an
 * allowed action, or when any rule is not an object / lacks an object `match` /
 * has an action not in {allow,deny,prompt}. Unknown fields are ignored
 * (forward-compat). The returned `defaults` is filled with
 * `{ action:'prompt', requireScope:'approve' }` when omitted.
 */
export function loadPolicy(text: string): Policy {
  const doc = parse(text) ?? {};
  if (!isPlainObject(doc)) {
    throw new PolicyError('policy document must be a mapping');
  }

  const defaultsRaw = doc['defaults'];
  let defaultsObj: Record<string, unknown> = {};
  if (defaultsRaw !== undefined) {
    if (!isPlainObject(defaultsRaw)) {
      throw new PolicyError('defaults must be a mapping');
    }
    defaultsObj = defaultsRaw;
  }
  const defaultAction = defaultsObj['action'] ?? 'prompt';
  if (!isAction(defaultAction)) {
    throw new PolicyError(
      `defaults.action must be allow/deny/prompt (got ${String(defaultAction)})`,
    );
  }
  const defaultScope =
    defaultsObj['requireScope'] === undefined
      ? 'approve'
      : String(defaultsObj['requireScope']);

  const rulesRaw = doc['rules'] ?? [];
  if (!Array.isArray(rulesRaw)) {
    throw new PolicyError('rules must be a sequence');
  }

  const rules: PolicyRule[] = rulesRaw.map((raw, i) => {
    if (!isPlainObject(raw)) {
      throw new PolicyError(`rule[${i}] must be a mapping`);
    }
    if (!isPlainObject(raw['match'])) {
      throw new PolicyError(`rule[${i}].match must be a mapping`);
    }
    if (!isAction(raw['action'])) {
      throw new PolicyError(
        `rule[${i}].action must be allow/deny/prompt (got ${String(raw['action'])})`,
      );
    }
    const match = raw['match'] as Record<string, unknown>;
    const rule: PolicyRule = {
      match: match as PolicyRuleMatch,
      action: raw['action'],
    };
    if (raw['id'] !== undefined) rule.id = String(raw['id']);
    if (raw['requireScope'] !== undefined) {
      rule.requireScope = String(raw['requireScope']);
    }
    if (raw['reason'] !== undefined) rule.reason = String(raw['reason']);
    if (typeof raw['priority'] === 'number') rule.priority = raw['priority'];
    // Deferred rule-level fields kept through, not evaluated.
    if (raw['maxPerWindow'] !== undefined)
      rule.maxPerWindow = raw['maxPerWindow'];
    if (raw['expiresAt'] !== undefined) rule.expiresAt = raw['expiresAt'];

    if (match['timeOfDay'] || rule.maxPerWindow || rule.expiresAt) {
      if (!warnedDeferred) {
        warnedDeferred = true;
        // eslint-disable-next-line no-console
        console.warn(
          `[policy] rule ${rule.id ?? `[${i}]`} uses an unevaluated field ` +
            '(timeOfDay/expiresAt/maxPerWindow); will downgrade to prompt',
        );
      }
    }
    return rule;
  });

  const policy: Policy = {
    defaults: { action: defaultAction, requireScope: defaultScope },
    rules,
  };
  if (typeof doc['version'] === 'number') policy.version = doc['version'];
  return policy;
}

/**
 * Load and validate a policy file. Returns `null` when the file is absent
 * (ENOENT) so callers can fall back to pure default-prompt behavior; otherwise
 * delegates to {@link loadPolicy} (which may throw {@link PolicyError}).
 */
export async function loadPolicyFile(path: string): Promise<Policy | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
  return loadPolicy(text);
}
