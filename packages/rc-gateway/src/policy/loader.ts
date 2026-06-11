/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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

    // Only maxPerWindow is still deferred (timeOfDay/expiresAt are now
    // evaluated by the evaluator). Presence, not truthiness — a falsy-valued
    // maxPerWindow (e.g. `maxPerWindow: 0`) is still flagged.
    if (rule.maxPerWindow !== undefined) {
      if (!warnedDeferred) {
        warnedDeferred = true;
        // eslint-disable-next-line no-console
        console.warn(
          `[policy] rule ${rule.id ?? `[${i}]`} uses an unevaluated field ` +
            '(maxPerWindow); will downgrade to prompt',
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

/** The fail-closed fallback when no user policy.yaml exists: prompt everything. */
const DEFAULT_PROMPT_POLICY: Policy = {
  defaults: { action: 'prompt', requireScope: 'approve' },
  rules: [],
};

/**
 * Merge a workspace policy over a user policy by PREPENDING the workspace rules
 * (design D1: the evaluator breaks specificity/priority ties by earlier index, so
 * lower-indexed workspace rules win an equal-specificity tie — the spec's
 * workspace-override scenario). `workspace === null` returns `user` UNCHANGED, so
 * a workspace-less boot is byte-identical to today. The user `defaults` are kept;
 * a workspace `defaults` block is intentionally IGNORED (D3) so a workspace file
 * cannot silently flip the global fallback action. Pure.
 */
export function mergePolicies(workspace: Policy | null, user: Policy): Policy {
  if (!workspace) return user;
  return {
    defaults: user.defaults,
    rules: [...workspace.rules, ...user.rules],
  };
}

/**
 * Load the user policy and, when a workspace cwd is given, the workspace override
 * `<workspaceCwd>/.qwen/policy.yaml`, then merge (workspace prepended). The user
 * file is loaded with cycle-14 semantics UNCHANGED: absent (ENOENT) → the
 * default-prompt policy; malformed → THROWS {@link PolicyError} (boot fails — a
 * malformed user policy must not be silently downgraded). The WORKSPACE layer is
 * fail-CLOSED: a malformed or unreadable workspace file is logged via `warn` and
 * IGNORED (keep the user policy — never apply unparseable `allow`s, never crash
 * boot). So this function throws ONLY on a malformed user file. `warn` defaults to
 * a no-op (the CLI passes a `console.warn` wrapper).
 */
export async function loadLayeredPolicy(
  userPath: string,
  workspaceCwd: string | undefined,
  warn: (msg: string) => void = () => {},
): Promise<Policy> {
  const user = (await loadPolicyFile(userPath)) ?? DEFAULT_PROMPT_POLICY;
  let workspace: Policy | null = null;
  if (workspaceCwd) {
    try {
      workspace = await loadPolicyFile(
        join(workspaceCwd, '.qwen', 'policy.yaml'),
      );
    } catch (err) {
      warn(
        `[policy] ignoring workspace policy.yaml: ${(err as Error).message}`,
      );
      workspace = null;
    }
  }
  return mergePolicies(workspace, user);
}

/** Result of {@link lintPolicyFile}: a daemon-free schema check of one file. */
export interface PolicyLintResult {
  ok: boolean;
  /** Number of rules (valid files only). */
  ruleCount?: number;
  /**
   * Rule id (or `[index]`) of each rule that uses the still-deferred
   * `maxPerWindow` field — these downgrade to prompt at runtime (valid files).
   */
  deferred?: string[];
  /** Human-readable reason (invalid files only). */
  error?: string;
}

/**
 * Validate a policy file's schema WITHOUT loading it into a running gateway —
 * the `qwen-rc policy lint <file>` pre-flight check. Runs the SAME
 * {@link loadPolicy} validator the boot path uses (one schema, no drift). Never
 * throws: every failure is reported as `{ ok: false, error }`. A missing file is
 * a lint FAILURE (not the loader's "absent → default" pass) — an explicit
 * `lint <file>` target that does not exist is an error.
 */
export async function lintPolicyFile(path: string): Promise<PolicyLintResult> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return {
      ok: false,
      error:
        code === 'ENOENT'
          ? `file not found: ${path}`
          : `cannot read ${path}: ${(err as Error).message}`,
    };
  }
  let policy: Policy;
  try {
    policy = loadPolicy(text);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  const deferred = policy.rules
    .map((r, i) => (r.maxPerWindow !== undefined ? (r.id ?? `[${i}]`) : null))
    .filter((x): x is string => x !== null);
  return { ok: true, ruleCount: policy.rules.length, deferred };
}

/** Render a {@link PolicyLintResult} as a one/two-line human summary. */
export function formatPolicyLint(path: string, r: PolicyLintResult): string {
  if (!r.ok) return `✖ ${path}: ${r.error}`;
  const lines = [`✓ ${path}: valid (${r.ruleCount} rule(s))`];
  if (r.deferred && r.deferred.length > 0) {
    lines.push(
      `  note: ${r.deferred.length} rule(s) use the still-deferred ` +
        `maxPerWindow field (will downgrade to prompt): ${r.deferred.join(', ')}`,
    );
  }
  return lines.join('\n');
}
