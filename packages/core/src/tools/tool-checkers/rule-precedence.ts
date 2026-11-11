/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tool-level rule precedence, shared by every tool check.
 *
 * A tool-level rule is one written without parentheses — `Bash`, `Read`,
 * `mcp__server__*` — so it governs the whole tool regardless of arguments. It is
 * therefore answerable before a check looks at its input at all, and the answer
 * is the same for every tool: deny wins, then ask, then allow.
 *
 * Content-level rules (`Bash(git:*)`, `Read(//docs/**)`) are not decided here:
 * only the tool knows whether its input matches a rule's content.
 */

import type {
  PermissionBehavior,
  PermissionRule,
  PermissionRulesBySourceForTool,
  RulesForTool,
  ToolCheckResult,
  ToolCheckContext,
  PermissionMode,
} from '../../permissions/manager/decision/index.js';
import {
  PermissionModes,
  rulesForToolName,
  permissionRuleValueFromString,
  toolNameMatchesRule,
} from '../../permissions/manager/decision/index.js';
import { filterDangerousAllowRules } from '../../permissions/permission-modes/auto/dangerous-rules.js';
import type { PermissionPolicySnapshot } from '../../permissions/manager/policy.js';
import type {
  PermissionUpdate,
  ToolPermissionExtra,
  ToolPermissionReason,
} from './checker-reasons.js';

/** What every tool check in this host returns. */
export type ToolPermissionResult = ToolCheckResult<
  ToolPermissionReason,
  ToolPermissionExtra,
  PermissionUpdate
>;

/** Matching projection of the current read-only ManagedPolicy constraints. */
export interface HostToolCheckContext
  extends ToolCheckContext<ToolPermissionReason> {
  readonly globalRules?: PermissionPolicySnapshot['rules'];
}

/** What every tool check in this host is. */
export interface HostToolChecker {
  check(
    input: Record<string, unknown>,
    ctx: HostToolCheckContext,
  ): ToolPermissionResult | Promise<ToolPermissionResult>;
}

/** A managed ask is a requirement for this invocation, never a reusable grant. */
export function isManagedAsk(
  result: ToolCheckResult<ToolPermissionReason>,
): boolean {
  return (
    result.kind === 'ask' && result.reason.attribution.type === 'managedRule'
  );
}

/** Bare tool rules only. Each tool retains ownership of content matching. */
export function checkManagedToolRules(
  toolName: string,
  rules: PermissionPolicySnapshot['rules'],
): ToolPermissionResult | undefined {
  return checkManagedRules(toolName, rules, (content) => content === undefined);
}

/** Reuse a tool's existing syntax matcher for managed content rules. */
export function checkManagedContentRules(
  toolName: string,
  rules: PermissionPolicySnapshot['rules'],
  matches: (content: string) => boolean,
): ToolPermissionResult | undefined {
  return checkManagedRules(
    toolName,
    rules,
    (content) => content !== undefined && matches(content),
  );
}

function checkManagedRules(
  toolName: string,
  rules: PermissionPolicySnapshot['rules'],
  matches: (content: string | undefined) => boolean,
): ToolPermissionResult | undefined {
  for (const behavior of ['deny', 'ask'] as const) {
    for (const text of rules?.[behavior] ?? []) {
      const value = permissionRuleValueFromString(text);
      if (
        !toolNameMatchesRule(toolName, value.toolName) ||
        !matches(value.ruleContent)
      )
        continue;
      const reason: ToolPermissionReason = {
        message:
          behavior === 'deny'
            ? `Rule ${text} denies ${toolName}.`
            : `Rule ${text} requires your approval for this use of ${toolName}.`,
        attribution: { type: 'managedRule' },
        denialKind: 'permission-rule',
        decisionPoint: `managed.${value.ruleContent === undefined ? 'tool' : 'content'}.${behavior}`,
      };
      return behavior === 'deny'
        ? {
            kind: 'deny',
            extra: {
              denialReason: reason,
              decisionPoint: reason.decisionPoint,
            },
          }
        : { kind: 'ask', reason };
    }
  }
  return undefined;
}

/** Any refusal wins; managed confirmation outranks local allows and asks. */
export function applyManagedRuleResult<TExtra, TSuggestion>(
  result: ToolCheckResult<ToolPermissionReason, TExtra, TSuggestion>,
  managed: ToolPermissionResult | undefined,
  mode: PermissionMode,
): ToolCheckResult<
  ToolPermissionReason,
  TExtra | ToolPermissionExtra,
  TSuggestion | PermissionUpdate
> {
  if (result.kind === 'deny' || !managed) return result;
  if (managed.kind === 'ask' && mode === PermissionModes.DontAsk) {
    return {
      kind: 'deny',
      extra: {
        denialReason: managed.reason,
        decisionPoint: 'managed.dont_ask.deny',
      },
    };
  }
  if (isManagedAsk(result)) return result;
  if (managed.kind === 'ask') {
    return {
      ...managed,
      // Preserve safe prompt projections and warnings from the tool itself.
      ...(result.extra === undefined ? {} : { extra: result.extra }),
      reason:
        result.kind === 'ask' && isBypassImmune(result)
          ? {
              ...managed.reason,
              message: `${result.reason.message}\n${managed.reason.message}`,
            }
          : managed.reason,
    };
  }
  return managed;
}

/** The first rule in any source of this bucket, or undefined. */
export function firstRule(
  bucket: PermissionRulesBySourceForTool,
): PermissionRule | undefined {
  for (const rules of Object.values(bucket)) {
    if (rules && rules.length > 0) {
      return rules[0];
    }
  }
  return undefined;
}

/** A rule as written, for citing in prompt copy: `Bash` or `Bash(git:*)`. */
export function ruleText(rule: PermissionRule): string {
  const { toolName, ruleContent } = rule.ruleValue;
  return ruleContent === undefined ? toolName : `${toolName}(${ruleContent})`;
}

/** Refuse the call, attributing it to a rule. */
export function denyByRule(
  toolName: string,
  rule: PermissionRule,
): ToolPermissionResult {
  return {
    kind: 'deny',
    extra: {
      denialReason: {
        message: `Permission to use ${toolName} has been denied by rule ${ruleText(rule)}.`,
        attribution: { type: 'rule', rule },
        denialKind: 'permission-rule',
      },
    },
  };
}

/** Ask about the call, attributing the requirement to a rule. */
export function askByRule(
  toolName: string,
  rule: PermissionRule,
): ToolPermissionResult {
  return {
    kind: 'ask',
    reason: {
      message: `${toolName} requires approval by rule ${ruleText(rule)}.`,
      attribution: { type: 'rule', rule },
    },
  };
}

/**
 * Apply the tool-level deny and ask rules, which settle a call before the tool
 * looks at its input at all. Returns `undefined` when neither matched — an allow
 * rule is deliberately not handled here; see {@link withToolLevelRules}.
 */
export function checkToolLevelRules(
  toolName: string,
  rulesForTool: RulesForTool,
): ToolPermissionResult | undefined {
  const deny = firstRule(rulesForTool.toolLevel.deny);
  if (deny) {
    return denyByRule(toolName, deny);
  }

  const ask = firstRule(rulesForTool.toolLevel.ask);
  if (ask) {
    return askByRule(toolName, ask);
  }

  return undefined;
}

/**
 * Whether an ask states an objection rather than an absent permission.
 *
 * The distinction is what a bare allow rule may and may not override: "nobody
 * has said anything about this call" is a gap an allow rule fills, while "this
 * path is dangerous", "this is outside the workspace" and "a rule says ask" are
 * findings it must not erase.
 */
export function isSafetyObjection(
  ask: Extract<ToolPermissionResult, { kind: 'ask' }>,
): boolean {
  const { attribution, blockedPath } = ask.reason;
  if (blockedPath) {
    return true;
  }
  if (
    attribution.type === 'safetyCheck' ||
    attribution.type === 'interaction'
  ) {
    return true;
  }
  return attribution.type === 'rule' && attribution.rule.ruleBehavior === 'ask';
}

/**
 * Whether an ask is one nothing in the pipeline may replace: not a rule ask,
 * not a hook ask, and not the Yolo allow. The check says so in its attribution
 * (`bypassImmune`), and only the catastrophic-removal check does.
 */
export function isBypassImmune(
  result: ToolCheckResult<ToolPermissionReason>,
): boolean {
  if (result.kind !== 'ask') {
    return false;
  }
  const { attribution } = result.reason;
  return (
    attribution.type === 'safetyCheck' && attribution.bypassImmune === true
  );
}

/**
 * A PreToolUse hook's ask takes precedence over rule and self-check asks.
 * The mode layer still resolves it (Yolo skips, DontAsk refuses); only a
 * deny on the merits outranks it.
 */
export function withHookAsk(checker: HostToolChecker): HostToolChecker {
  return {
    async check(input, ctx) {
      const result = await checker.check(input, ctx);
      const verdict = ctx.preToolUseHookVerdict;
      if (
        verdict?.behavior !== 'ask' ||
        result.kind === 'deny' ||
        isManagedAsk(result)
      ) {
        return result;
      }
      // A catastrophic finding keeps its own attribution: the hook's ask would
      // be resolved by the mode layer like any other ask, and under Yolo that
      // is an allow.
      if (isBypassImmune(result)) {
        return result;
      }
      return {
        kind: 'ask',
        reason: {
          message:
            verdict.message ??
            'A PreToolUse hook requires confirmation before this call.',
          attribution: { type: 'hook', hookName: 'PreToolUse' },
          decisionPoint: 'hook.pre_tool_use.ask',
        },
      };
    },
  };
}

/**
 * Apply tool-level rules in front of a tool's own check.
 *
 * - deny: terminal, evaluated before the tool analyses its input.
 * - ask: recorded but non-terminal; only a content-level deny outranks it.
 *   A self-check allow does not silence the rule ask.
 * - allow: a voucher only; it never erases other findings. It does fill a
 *   gap-shaped ask (`fillableByAllow`) that exists only because nobody
 *   consented or objected.
 */
export function withToolLevelRules(
  toolName: string,
  checker: HostToolChecker,
): HostToolChecker {
  return {
    async check(input, ctx) {
      if (ctx.mode === PermissionModes.Auto) {
        const rules = filterDangerousAllowRules(ctx.rules);
        if (rules !== ctx.rules) {
          // Overlays can grant permissions after Auto's entry-time stripping.
          ctx = {
            ...ctx,
            rules,
            rulesForTool: rulesForToolName(rules, toolName),
          };
        }
      }
      const deny = firstRule(ctx.rulesForTool.toolLevel.deny);
      const managed = checkManagedToolRules(toolName, ctx.globalRules);
      if (deny) {
        // Merged policySettings are still managed rules, not ordinary user rules.
        if (deny.source === 'policySettings' && managed?.kind === 'deny') {
          return managed;
        }
        return denyByRule(toolName, deny);
      }
      if (managed?.kind === 'deny') return managed;
      const ruleAsk = firstRule(ctx.rulesForTool.toolLevel.ask);
      const result = applyManagedRuleResult(
        await checker.check(input, ctx),
        managed,
        ctx.mode,
      );

      // A content-level deny outranks everything the rules said.
      if (result.kind === 'deny') {
        return result;
      }

      // A catastrophic finding outranks the rule ask too: shown as a rule ask
      // it would lose the attribution that keeps it alive under Yolo.
      if (isBypassImmune(result) || isManagedAsk(result)) {
        return result;
      }

      if (result.kind === 'allow') {
        // The rule ask still stands: the user asked to be prompted about this
        // tool, and a self-check that merely allows is not an objection that
        // may overrule them.
        return ruleAsk ? askByRule(toolName, ruleAsk) : result;
      }

      // A tool-level allow fills the gap-shaped ask (`fillableByAllow`);
      // every other ask is a finding the allow may never erase. An explicit
      // rule ask outranks the gap fill.
      const vouched = firstRule(ctx.rulesForTool.toolLevel.allow);
      // A hook's approval is for this call, not a reusable broad grant.
      const hookVouched =
        ctx.mode === PermissionModes.Auto &&
        ctx.preToolUseHookVerdict?.behavior === 'allow';
      if (
        !ruleAsk &&
        (vouched || hookVouched) &&
        result.extra?.fillableByAllow
      ) {
        return {
          kind: 'allow',
          extra: { ...result.extra, decisionPoint: 'rule.tool_allow.allow' },
        };
      }

      return ruleAsk ? askByRule(toolName, ruleAsk) : result;
    },
  };
}

/**
 * The first content-level rule of this behaviour whose content the tool accepts.
 * The predicate belongs to the tool: only it knows whether `Skill(review:*)`
 * covers `review-pr`, or whether a URL matches a host rule.
 */
export function findContentRule(
  rulesForTool: RulesForTool,
  behavior: PermissionBehavior,
  matches: (ruleContent: string) => boolean,
): PermissionRule | undefined {
  for (const rules of Object.values(rulesForTool.toolDetailLevel[behavior])) {
    for (const rule of rules ?? []) {
      const content = rule.ruleValue.ruleContent;
      if (content !== undefined && matches(content)) {
        return rule;
      }
    }
  }
  return undefined;
}

/**
 * Any content deny wins, then managed ask, then the existing local ask/allow.
 * Returns `undefined` when nothing matched the tool's content.
 */
export function checkContentRules(
  toolName: string,
  context: Pick<HostToolCheckContext, 'rulesForTool' | 'globalRules'>,
  matches: (ruleContent: string) => boolean,
  decisionPoints?: { deny?: string; ask?: string; allow?: string },
): ToolPermissionResult | undefined {
  const { rulesForTool, globalRules } = context;
  const managed = checkManagedContentRules(toolName, globalRules, matches);
  if (managed?.kind === 'deny') return managed;
  const deny = findContentRule(rulesForTool, 'deny', matches);
  if (deny) {
    return stampPoint(denyByRule(toolName, deny), decisionPoints?.deny);
  }
  if (managed) return managed;

  const ask = findContentRule(rulesForTool, 'ask', matches);
  if (ask) {
    return stampPoint(askByRule(toolName, ask), decisionPoints?.ask);
  }

  if (findContentRule(rulesForTool, 'allow', matches)) {
    return stampPoint({ kind: 'allow' }, decisionPoints?.allow);
  }

  return undefined;
}

/** Record which branch produced a verdict, in whichever slot its kind has. */
export function stampPoint(
  result: ToolPermissionResult,
  decisionPoint: string | undefined,
): ToolPermissionResult {
  if (decisionPoint === undefined) {
    return result;
  }
  if (result.kind === 'ask') {
    return { ...result, reason: { ...result.reason, decisionPoint } };
  }
  const denialReason = result.extra?.denialReason;
  return {
    ...result,
    extra: {
      ...result.extra,
      decisionPoint,
      ...(denialReason
        ? { denialReason: { ...denialReason, decisionPoint } }
        : {}),
    },
  };
}

/**
 * A tool with no effect outside the session — reading its own task list, writing
 * a todo. Rules still apply, so a user can deny one; absent a rule it runs.
 * `decisionPoint` lets a tool keep a distinct reporting label for its default
 * allow instead of merging into `no_check.default.allow`.
 */
export function alwaysAllowChecker(
  toolName: string,
  decisionPoint = 'no_check.default.allow',
): HostToolChecker {
  return {
    check(_input, ctx) {
      const byRule = checkToolLevelRules(toolName, ctx.rulesForTool);
      if (byRule) {
        return byRule;
      }
      return {
        kind: 'allow',
        extra: { decisionPoint },
      };
    },
  };
}

/**
 * A tool whose whole purpose is the prompt: asking the user a question, or
 * leaving plan mode. Nothing is offered to remember — "always allow" would mean
 * "never ask", which would remove the feature — and an allow rule cannot skip
 * it either. Only a deny rule can stop the call.
 */
export function alwaysAskChecker(
  toolName: string,
  message: string,
): HostToolChecker {
  return {
    check(_input, ctx) {
      const byRule = checkToolLevelRules(toolName, ctx.rulesForTool);
      if (byRule && byRule.kind === 'deny') {
        return byRule;
      }
      return {
        kind: 'ask',
        reason: {
          message,
          attribution: {
            type: 'interaction',
            reason: 'the prompt is what this tool does',
          },
          decisionPoint: `${toolName}.interaction.ask`,
        },
      };
    },
  };
}

/**
 * A tool that reaches outside the session but has no finer key than its own
 * name — a web search, an image generation. Asks once, and the prompt offers to
 * allow the tool from then on.
 */
export function askWithSelfAllowChecker(
  toolName: string,
  message: string,
  decisionPoint: string,
  opts: { unskippable?: boolean } = {},
): HostToolChecker {
  return {
    check(_input, ctx) {
      const byRule = checkToolLevelRules(toolName, ctx.rulesForTool);
      if (byRule) {
        return byRule;
      }
      // unskippable：弹窗本身是用户要看到的行为（如进入 plan 模式），
      // 归入 interaction，任何模式都不能静默跳过。
      const attribution = opts.unskippable
        ? {
            type: 'interaction' as const,
            reason: 'the prompt is what this tool does',
          }
        : { type: 'other' as const, reason: 'no rule covers this tool' };
      return {
        kind: 'ask',
        reason: {
          message,
          attribution,
          decisionPoint,
        },
        // No self-check behind this ask, so a recorded tool-level allow
        // can fill the gap instead of prompting.
        extra: { fillableByAllow: true },
        suggestions: [
          {
            type: 'addRules',
            destination: 'localSettings',
            rules: [{ toolName }],
            behavior: 'allow',
          },
        ],
      };
    },
  };
}

/**
 * A checker with its pure read-probe variant attached.
 *
 * The association rides on the checker object rather than in a side table: the
 * wrapper every caller passes in is freshly composed (each of `withToolLevelRules`,
 * `withHookAsk` and `withCheckLog` returns a new object literal) and is
 * then owned by exactly one manager's checker table, so the object identity is
 * already the right key and a process-wide map buys nothing.
 */
type CheckerWithReadProbe = HostToolChecker & {
  readProbeChecker?: HostToolChecker;
};

export function withReadProbe(
  checker: HostToolChecker,
  pure: HostToolChecker,
): HostToolChecker {
  (checker as CheckerWithReadProbe).readProbeChecker = pure;
  return checker;
}
export function getReadProbeChecker(
  checker: object | undefined,
): HostToolChecker | undefined {
  return (checker as CheckerWithReadProbe | undefined)?.readProbeChecker;
}
