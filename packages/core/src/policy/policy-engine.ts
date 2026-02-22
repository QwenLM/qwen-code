/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FunctionCall } from '@google/genai';
import stableStringify from 'fast-json-stable-stringify';
import type { CheckerRunner } from '../safety/checker-runner.js';
import { SafetyCheckDecision } from '../safety/protocol.js';
import {
  ApprovalMode,
  PolicyDecision,
  type CheckResult,
  type HookCheckerRule,
  type PolicyEngineConfig,
  type PolicyRule,
  type SafetyCheckerRule,
} from './types.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('POLICY_ENGINE');

/**
 * List of tool names that are considered shell commands.
 */
const SHELL_TOOL_NAMES = ['run_shell_command', 'shell', 'execute_command'];

/**
 * Check if a pattern is a wildcard pattern (contains * or ?).
 */
function isWildcardPattern(pattern: string): boolean {
  return pattern.includes('*') || pattern.includes('?');
}

/**
 * Match a tool name against a wildcard pattern.
 */
function matchesWildcard(pattern: string, toolName: string): boolean {
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexPattern}$`).test(toolName);
}

/**
 * Get all aliases for a tool name (for backwards compatibility).
 */
function getToolAliases(toolName: string): string[] {
  const aliases: string[] = [toolName];

  // Add common aliases
  const aliasMap: Record<string, string[]> = {
    run_shell_command: ['shell', 'execute_command'],
    shell: ['run_shell_command', 'execute_command'],
    execute_command: ['run_shell_command', 'shell'],
  };

  if (aliasMap[toolName]) {
    aliases.push(...aliasMap[toolName]);
  }

  return aliases;
}

/**
 * Check if a rule matches a tool call.
 */
function ruleMatches(
  rule: PolicyRule | SafetyCheckerRule,
  toolCall: FunctionCall,
  stringifiedArgs: string | undefined,
  serverName: string | undefined,
  approvalMode: ApprovalMode,
): boolean {
  // Check approval mode
  if ('modes' in rule && rule.modes && rule.modes.length > 0) {
    if (!rule.modes.includes(approvalMode)) {
      return false;
    }
  }

  // Check tool name
  if (rule.toolName) {
    const toolName = toolCall.name || '';

    if (isWildcardPattern(rule.toolName)) {
      if (!matchesWildcard(rule.toolName, toolName)) {
        return false;
      }
    } else if (rule.toolName !== toolName) {
      // Also check with server prefix
      if (serverName && rule.toolName !== `${serverName}__${toolName}`) {
        return false;
      } else if (!serverName) {
        return false;
      }
    }
  }

  // Check args pattern
  if (rule.argsPattern && stringifiedArgs) {
    if (!rule.argsPattern.test(stringifiedArgs)) {
      return false;
    }
  }

  return true;
}

/**
 * Policy engine for managing tool execution permissions.
 */
export class PolicyEngine {
  private rules: PolicyRule[] = [];
  private checkers: SafetyCheckerRule[] = [];
  private hookCheckers: HookCheckerRule[] = [];
  private readonly defaultDecision: PolicyDecision;
  private readonly nonInteractive: boolean;
  private readonly approvalMode: ApprovalMode;
  private readonly checkerRunner?: CheckerRunner;

  constructor(config: PolicyEngineConfig = {}, checkerRunner?: CheckerRunner) {
    this.rules = [...(config.rules ?? [])];
    this.checkers = [...(config.checkers ?? [])];
    this.hookCheckers = [...(config.hookCheckers ?? [])];
    this.defaultDecision = config.defaultDecision ?? PolicyDecision.ASK_USER;
    this.nonInteractive = config.nonInteractive ?? false;
    this.approvalMode = config.approvalMode ?? ApprovalMode.DEFAULT;
    this.checkerRunner = checkerRunner;

    // Sort rules by priority (higher first)
    this.rules.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    this.checkers.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    this.hookCheckers.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  /**
   * Check shell command for additional security considerations.
   */
  private async checkShellCommand(
    toolName: string,
    command: string | undefined,
    ruleDecision: PolicyDecision,
    serverName: string | undefined,
    shellDirPath: string | undefined,
    allowRedirection?: boolean,
    rule?: PolicyRule,
  ): Promise<CheckResult> {
    let aggregateDecision = ruleDecision;
    let responsibleRule: PolicyRule | undefined;

    // Check for command redirection
    if (command && !allowRedirection) {
      const redirectionPatterns = [
        /[|&;`$()]/,
        />\s*/,
        /<\s*/,
        /\$\(/,
        /`[^`]*`/,
      ];

      for (const pattern of redirectionPatterns) {
        if (pattern.test(command)) {
          if (ruleDecision === PolicyDecision.ALLOW) {
            debugLogger.debug(
              `[PolicyEngine.checkShellCommand] Downgrading ALLOW to ASK_USER due to redirection pattern: ${pattern}`,
            );
            aggregateDecision = PolicyDecision.ASK_USER;
            break;
          }
        }
      }
    }

    return {
      decision: this.applyNonInteractiveMode(aggregateDecision),
      // If we stayed at ALLOW, we return the original rule (if any).
      // If we downgraded, we return the responsible rule (or undefined if implicit).
      rule: aggregateDecision === ruleDecision ? rule : responsibleRule,
    };
  }

  /**
   * Check if a tool call is allowed based on the configured policies.
   * Returns the decision and the matching rule (if any).
   */
  async check(
    toolCall: FunctionCall,
    serverName: string | undefined,
  ): Promise<CheckResult> {
    let stringifiedArgs: string | undefined;
    // Compute stringified args once before the loop
    if (
      toolCall.args &&
      (this.rules.some((rule) => rule.argsPattern) ||
        this.checkers.some((checker) => checker.argsPattern))
    ) {
      stringifiedArgs = stableStringify(toolCall.args);
    }

    debugLogger.debug(
      `[PolicyEngine.check] toolCall.name: ${toolCall.name}, stringifiedArgs: ${stringifiedArgs}`,
    );

    // Check for shell commands upfront to handle splitting
    let isShellCommand = false;
    let command: string | undefined;
    let shellDirPath: string | undefined;

    const toolName = toolCall.name;

    if (toolName && SHELL_TOOL_NAMES.includes(toolName)) {
      isShellCommand = true;

      const args = toolCall.args as { command?: string; dir_path?: string };
      command = args?.command;
      shellDirPath = args?.dir_path;
    }

    // Find the first matching rule (already sorted by priority)
    let matchedRule: PolicyRule | undefined;
    let decision: PolicyDecision | undefined;

    // For tools with a server name, we want to try matching both the
    // original name and the fully qualified name (server__tool).
    // We also want to check legacy aliases for the tool name.
    const toolNamesToTry = toolCall.name ? getToolAliases(toolCall.name) : [];

    const toolCallsToTry: FunctionCall[] = [];
    for (const name of toolNamesToTry) {
      toolCallsToTry.push({ ...toolCall, name });
      if (serverName && !name.includes('__')) {
        toolCallsToTry.push({
          ...toolCall,
          name: `${serverName}__${name}`,
        });
      }
    }

    for (const rule of this.rules) {
      const match = toolCallsToTry.some((tc) =>
        ruleMatches(rule, tc, stringifiedArgs, serverName, this.approvalMode),
      );

      if (match) {
        debugLogger.debug(
          `[PolicyEngine.check] MATCHED rule: toolName=${rule.toolName}, decision=${rule.decision}, priority=${rule.priority}, argsPattern=${rule.argsPattern?.source || 'none'}`,
        );

        if (isShellCommand && toolName) {
          const shellResult = await this.checkShellCommand(
            toolName,
            command,
            rule.decision,
            serverName,
            shellDirPath,
            rule.allowRedirection,
            rule,
          );
          decision = shellResult.decision;
          if (shellResult.rule) {
            matchedRule = shellResult.rule;
            break;
          }
        } else {
          decision = this.applyNonInteractiveMode(rule.decision);
          matchedRule = rule;
          break;
        }
      }
    }

    // Default if no rule matched
    if (decision === undefined) {
      debugLogger.debug(
        `[PolicyEngine.check] NO MATCH - using default decision: ${this.defaultDecision}`,
      );
      if (toolName && SHELL_TOOL_NAMES.includes(toolName)) {
        const shellResult = await this.checkShellCommand(
          toolName,
          command,
          this.defaultDecision,
          serverName,
          shellDirPath,
        );
        decision = shellResult.decision;
        matchedRule = shellResult.rule;
      } else {
        decision = this.applyNonInteractiveMode(this.defaultDecision);
      }
    }

    // Safety checks
    if (decision !== PolicyDecision.DENY && this.checkerRunner) {
      for (const checkerRule of this.checkers) {
        if (
          ruleMatches(
            checkerRule,
            toolCall,
            stringifiedArgs,
            serverName,
            this.approvalMode,
          )
        ) {
          debugLogger.debug(
            `[PolicyEngine.check] Running safety checker: ${checkerRule.checker.name}`,
          );
          try {
            const result = await this.checkerRunner.runChecker(
              toolCall,
              checkerRule.checker,
            );
            if (result.decision === SafetyCheckDecision.DENY) {
              debugLogger.debug(
                `[PolicyEngine.check] Safety checker '${checkerRule.checker.name}' denied execution: ${result.reason}`,
              );
              return {
                decision: PolicyDecision.DENY,
                rule: matchedRule,
              };
            } else if (result.decision === SafetyCheckDecision.ASK_USER) {
              debugLogger.debug(
                `[PolicyEngine.check] Safety checker requested ASK_USER: ${result.reason}`,
              );
              decision = PolicyDecision.ASK_USER;
            }
          } catch (error) {
            debugLogger.debug(
              `[PolicyEngine.check] Safety checker '${checkerRule.checker.name}' threw an error:`,
              error,
            );
            return {
              decision: PolicyDecision.DENY,
              rule: matchedRule,
            };
          }
        }
      }
    }

    return {
      decision: this.applyNonInteractiveMode(decision),
      rule: matchedRule,
    };
  }

  /**
   * Add a new rule to the policy engine.
   */
  addRule(rule: PolicyRule): void {
    this.rules.push(rule);
    // Re-sort rules by priority
    this.rules.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  addChecker(checker: SafetyCheckerRule): void {
    this.checkers.push(checker);
    this.checkers.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  /**
   * Remove rules matching a specific tier (priority band).
   */
  removeRulesByTier(tier: number): void {
    this.rules = this.rules.filter(
      (rule) => Math.floor(rule.priority ?? 0) !== tier,
    );
  }

  /**
   * Remove checkers matching a specific tier (priority band).
   */
  removeCheckersByTier(tier: number): void {
    this.checkers = this.checkers.filter(
      (checker) => Math.floor(checker.priority ?? 0) !== tier,
    );
  }

  /**
   * Remove rules for a specific tool.
   * If source is provided, only rules matching that source are removed.
   */
  removeRulesForTool(toolName: string, source?: string): void {
    this.rules = this.rules.filter(
      (rule) =>
        rule.toolName !== toolName ||
        (source !== undefined && rule.source !== source),
    );
  }

  /**
   * Get all current rules.
   */
  getRules(): readonly PolicyRule[] {
    return this.rules;
  }

  /**
   * Check if a rule for a specific tool already exists.
   * If ignoreDynamic is true, it only returns true if a rule exists that was NOT added by AgentRegistry.
   */
  hasRuleForTool(toolName: string, ignoreDynamic = false): boolean {
    return this.rules.some(
      (rule) =>
        rule.toolName === toolName &&
        (!ignoreDynamic || rule.source !== 'AgentRegistry (Dynamic)'),
    );
  }

  getCheckers(): readonly SafetyCheckerRule[] {
    return this.checkers;
  }

  /**
   * Add a new hook checker to the policy engine.
   */
  addHookChecker(checker: HookCheckerRule): void {
    this.hookCheckers.push(checker);
    this.hookCheckers.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  /**
   * Get all current hook checkers.
   */
  getHookCheckers(): readonly HookCheckerRule[] {
    return this.hookCheckers;
  }

  /**
   * Check if a hook execution is allowed based on the configured policies.
   * Returns the decision for the hook execution request.
   */
  async checkHook(hookRequest: {
    eventName: string;
    input: Record<string, unknown>;
  }): Promise<PolicyDecision> {
    debugLogger.debug(
      `[PolicyEngine.checkHook] eventName: ${hookRequest.eventName}`,
    );

    // For now, allow all hooks by default
    // In the future, this can be extended to check hook-specific policies
    return this.applyNonInteractiveMode(PolicyDecision.ALLOW);
  }

  /**
   * Get tools that are effectively denied by the current rules.
   * This takes into account:
   * 1. Global rules (no argsPattern)
   * 2. Priority order (higher priority wins)
   * 3. Non-interactive mode (ASK_USER becomes DENY)
   */
  getExcludedTools(): Set<string> {
    const excludedTools = new Set<string>();
    const processedTools = new Set<string>();
    let globalVerdict: PolicyDecision | undefined;

    for (const rule of this.rules) {
      if (rule.argsPattern) {
        if (rule.toolName && rule.decision !== PolicyDecision.DENY) {
          processedTools.add(rule.toolName);
        }
        continue;
      }

      // Check if rule applies to current approval mode
      if (rule.modes && rule.modes.length > 0) {
        if (!rule.modes.includes(this.approvalMode)) {
          continue;
        }
      }

      // Handle Global Rules
      if (!rule.toolName) {
        if (globalVerdict === undefined) {
          globalVerdict = rule.decision;
          if (globalVerdict !== PolicyDecision.DENY) {
            // Global ALLOW/ASK found.
            // Since rules are sorted by priority, this overrides any lower-priority rules.
            // We can stop processing because nothing else will be excluded.
            break;
          }
          // If Global DENY, we continue to find specific tools to add to excluded set
        }
        continue;
      }

      const toolName = rule.toolName;

      // Check if already processed (exact match)
      if (processedTools.has(toolName)) {
        continue;
      }

      // Check if covered by a processed wildcard
      let coveredByWildcard = false;
      for (const processed of processedTools) {
        if (
          isWildcardPattern(processed) &&
          matchesWildcard(processed, toolName)
        ) {
          // It's covered by a higher-priority wildcard rule.
          // If that wildcard rule resulted in exclusion, this tool should also be excluded.
          if (excludedTools.has(processed)) {
            excludedTools.add(toolName);
          }
          coveredByWildcard = true;
          break;
        }
      }
      if (coveredByWildcard) {
        continue;
      }

      processedTools.add(toolName);

      // Determine decision
      let decision: PolicyDecision;
      if (globalVerdict !== undefined) {
        decision = globalVerdict;
      } else {
        decision = rule.decision;
      }

      if (decision === PolicyDecision.DENY) {
        excludedTools.add(toolName);
      }
    }
    return excludedTools;
  }

  private applyNonInteractiveMode(decision: PolicyDecision): PolicyDecision {
    // In non-interactive mode, ASK_USER becomes DENY
    if (this.nonInteractive && decision === PolicyDecision.ASK_USER) {
      return PolicyDecision.DENY;
    }
    return decision;
  }
}
