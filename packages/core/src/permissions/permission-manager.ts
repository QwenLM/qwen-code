/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  parseRules,
  parseRule,
  matchesRule,
  resolveToolName,
  splitCompoundCommand,
} from './rule-parser.js';
import type { PathMatchContext } from './rule-parser.js';
import { extractShellOperations } from './shell-semantics.js';
import type { ShellOperation } from './shell-semantics.js';
import { isShellCommandReadOnlyAST } from '../utils/shellAstParser.js';
import { detectCommandSubstitution } from '../utils/shell-utils.js';
import type {
  PermissionCheckContext,
  PermissionDecision,
  PermissionRule,
  PermissionRuleSet,
  RuleType,
  RuleWithSource,
  RuleScope,
} from './types.js';

/**
 * Numeric priority for each PermissionDecision.
 * Higher number = more restrictive. Used to combine decisions by taking
 * the most restrictive result across base rules + virtual shell operations.
 */
const DECISION_PRIORITY: Readonly<Record<PermissionDecision, number>> = {
  deny: 3,
  ask: 2,
  default: 1,
  allow: 0,
};

/**
 * Minimal interface for the parts of Config used by PermissionManager.
 * Keeps the dependency explicit and avoids a circular import on the
 * full Config class.
 *
 * Each getter already returns a fully-merged list: persistent settings rules
 * plus any SDK / CLI params that have been folded in by the Config layer.
 * PermissionManager therefore only needs these three getters.
 */
export interface PermissionManagerConfig {
  /** Merged allow-rules (settings + coreTools + allowedTools). */
  getPermissionsAllow(): string[] | undefined;
  /** Merged ask-rules (settings only). */
  getPermissionsAsk(): string[] | undefined;
  /** Merged deny-rules (settings + excludeTools). */
  getPermissionsDeny(): string[] | undefined;
  /** Project root directory (for resolving path patterns). */
  getProjectRoot?(): string;
  /** Current working directory (for resolving path patterns). */
  getCwd?(): string;
  /**
   * Returns the current approval mode (plan/default/auto-edit/yolo).
   * Used by `getDefaultMode()` to determine the fallback when no rule matches.
   */
  getApprovalMode?(): string;
  /**
   * Returns the legacy coreTools allowlist.
   *
   * When non-empty, only the tools in this list will be considered enabled at
   * the registry level — all other tools will be excluded from registration.
   * This preserves the original `tools.core` whitelist semantic inside
   * PermissionManager, so `createToolRegistry` can use a single
   * `pm.isToolEnabled()` check without any legacy fallback.
   *
   * @deprecated Configure tool availability via `permissions.deny` rules
   *             (e.g. `"Bash"` to block all shell commands) instead.
   */
  getCoreTools?(): string[] | undefined;
}

/**
 * Manages tool and command permissions by evaluating a set of
 * prioritised rules against allow / ask / deny lists.
 *
 * Rule evaluation order (highest priority first):
 *   1. deny rules  → PermissionDecision.deny
 *   2. ask  rules  → PermissionDecision.ask
 *   3. allow rules → PermissionDecision.allow
 *   4. (no match)  → PermissionDecision.default
 *
 * Rules can come from three sources, checked in order within each type:
 *   - Session rules  (in-memory only, added during the current session)
 *   - Persistent rules (from settings files, passed via ConfigParameters)
 *
 * Legacy params (coreTools / allowedTools / excludeTools) are converted
 * to in-memory rules for backward compatibility with the SDK API.
 */
export class PermissionManager {
  /** Persistent rules loaded from settings (all scopes merged). */
  private persistentRules: PermissionRuleSet = {
    allow: [],
    ask: [],
    deny: [],
  };

  /** In-memory rules added for the current session only. */
  private sessionRules: PermissionRuleSet = {
    allow: [],
    ask: [],
    deny: [],
  };

  /**
   * Canonical tool names from the legacy `coreTools` allowlist.
   * When non-null, `isToolEnabled()` rejects any tool not in this set.
   * Populated during `initialize()` from `config.getCoreTools()`.
   */
  private coreToolsAllowList: Set<string> | null = null;

  constructor(private readonly config: PermissionManagerConfig) {}

  /**
   * Initialise from the config's permission parameters.
   * Must be called once before any rule lookups.
   *
   * The config getters already return fully-merged lists (settings + SDK params),
   * so we simply parse them into typed rules.
   */
  initialize(): void {
    this.persistentRules = {
      allow: parseRules(this.config.getPermissionsAllow() ?? []),
      ask: parseRules(this.config.getPermissionsAsk() ?? []),
      deny: parseRules(this.config.getPermissionsDeny() ?? []),
    };

    // Build the coreTools allowlist (legacy whitelist semantic).
    // Each entry may be a bare name ("Bash", "read_file") or include a specifier
    // ("Bash(ls -l)") – we normalise to canonical tool names and ignore specifiers
    // because the registry check is at the tool level, not the invocation level.
    const rawCoreTools = this.config.getCoreTools?.();
    if (rawCoreTools && rawCoreTools.length > 0) {
      this.coreToolsAllowList = new Set(
        rawCoreTools.map((t) => parseRule(t).toolName),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Core evaluation
  // ---------------------------------------------------------------------------

  /**
   * Evaluate the permission decision for a given tool invocation context.
   *
   * @param ctx - The context containing the tool name and optional command.
   * @returns A PermissionDecision indicating how to handle this tool call.
   */
  async evaluate(ctx: PermissionCheckContext): Promise<PermissionDecision> {
    const { command, toolName } = ctx;

    // For shell commands, split compound commands and evaluate each
    // sub-command independently, then return the most restrictive result.
    // Priority order (most to least restrictive): deny > ask > allow
    if (command !== undefined) {
      const subCommands = splitCompoundCommand(command);
      if (subCommands.length > 1) {
        return this.evaluateCompoundCommand(ctx, subCommands);
      }
    }

    const decision = this.evaluateSingle(ctx);

    // For shell commands, resolve 'default' to actual permission using AST analysis
    // This ensures 'default' is never returned for shell commands - they always get
    // a concrete permission (deny/ask/allow) based on the command's readonly status.
    if (
      decision === 'default' &&
      toolName === 'run_shell_command' &&
      command !== undefined
    ) {
      return this.resolveDefaultPermission(command);
    }

    return decision;
  }

  /**
   * Evaluate a single (non-compound) context against all rules.
   *
   * For shell commands (run_shell_command), the result is the most restrictive
   * of:
   *   1. The base decision from Bash / command-pattern rules.
   *   2. The decision derived from virtual file / network operations extracted
   *      via `extractShellOperations` — allows Read/Edit/Write/WebFetch rules
   *      to match equivalent shell commands (e.g. `cat` → Read, `curl` → WebFetch).
   */
  private evaluateSingle(ctx: PermissionCheckContext): PermissionDecision {
    const { toolName, command, filePath, domain, specifier } = ctx;

    // Build path context for resolving relative path patterns
    const pathCtx: PathMatchContext | undefined =
      this.config.getProjectRoot && this.config.getCwd
        ? {
            projectRoot: this.config.getProjectRoot(),
            cwd: this.config.getCwd(),
          }
        : undefined;

    const matchArgs = [
      toolName,
      command,
      filePath,
      domain,
      pathCtx,
      specifier,
    ] as const;

    // Compute the base decision from explicit Bash/file/domain rules.
    // Using an IIFE to keep the priority-cascade logic clean.
    const baseDecision: PermissionDecision = (() => {
      // Priority 1: deny rules (session first, then persistent)
      for (const rule of [
        ...this.sessionRules.deny,
        ...this.persistentRules.deny,
      ]) {
        if (matchesRule(rule, ...matchArgs)) return 'deny';
      }
      // Priority 2: ask rules
      for (const rule of [
        ...this.sessionRules.ask,
        ...this.persistentRules.ask,
      ]) {
        if (matchesRule(rule, ...matchArgs)) return 'ask';
      }
      // Priority 3: allow rules
      for (const rule of [
        ...this.sessionRules.allow,
        ...this.persistentRules.allow,
      ]) {
        if (matchesRule(rule, ...matchArgs)) return 'allow';
      }
      return 'default';
    })();

    // `deny` is the most restrictive result — no further checks needed.
    if (baseDecision === 'deny') return 'deny';

    // For shell commands: evaluate virtual file/network operations extracted
    // from the command string against Read/Edit/Write/WebFetch/ListFiles rules.
    //
    // Virtual ops can only ESCALATE a decision (to 'ask' or 'deny').
    // A 'default' virtual result means "shell semantics have no opinion" — it
    // must never downgrade an explicit 'allow' decision from a Bash rule.
    // Example: `git status` has no file ops; an allow rule for `Bash(git *)`
    // should return 'allow', not be downgraded to 'default'.
    if (toolName === 'run_shell_command' && command !== undefined) {
      const cwd = pathCtx?.cwd ?? process.cwd();
      const virtualDecision = this.evaluateShellVirtualOps(
        extractShellOperations(command, cwd),
        pathCtx,
      );
      if (
        virtualDecision !== 'default' &&
        DECISION_PRIORITY[virtualDecision] > DECISION_PRIORITY[baseDecision]
      ) {
        return virtualDecision;
      }
    }

    return baseDecision;
  }

  /**
   * Evaluate a list of virtual operations (derived from shell command analysis)
   * against all current rules.  Returns the most restrictive matching decision,
   * or `'default'` if no rule matches any operation.
   *
   * Each operation is evaluated as if it were a direct invocation of its
   * `virtualTool` (e.g. `read_file`, `web_fetch`, `edit`), so Read/Edit/etc.
   * rules are applied naturally.
   */
  private evaluateShellVirtualOps(
    ops: ShellOperation[],
    _pathCtx: PathMatchContext | undefined,
  ): PermissionDecision {
    if (ops.length === 0) return 'default';

    let worst: PermissionDecision = 'default';

    for (const op of ops) {
      // Evaluate the virtual operation using the standard rule-matching path.
      // Since op.virtualTool ≠ 'run_shell_command', this will not recurse back
      // into the shell-semantics branch.
      const opDecision = this.evaluateSingle({
        toolName: op.virtualTool,
        filePath: op.filePath,
        domain: op.domain,
      });

      if (DECISION_PRIORITY[opDecision] > DECISION_PRIORITY[worst]) {
        worst = opDecision;
        if (worst === 'deny') return 'deny'; // short-circuit
      }
    }

    return worst;
  }

  /**
   * Evaluate a compound command by splitting it into sub-commands,
   * evaluating each independently, and returning the most restrictive result.
   *
   * Restriction order: deny > ask > allow
   *
   * When a sub-command returns 'default' (no rule matches), it is resolved to
   * the actual default permission using AST analysis:
   *   - Command substitution detected → 'deny'
   *   - Read-only command (cd, ls, git status, etc.) → 'allow'
   *   - Otherwise → 'ask'
   *
   * Example: with rules `allow: [git checkout *]`
   *   - "cd /path && git checkout -b feature" → allow (cd) + allow (rule) → allow
   *   - "rm /path && git checkout -b feature" → ask (rm) + allow (rule) → ask
   *   - "evil-cmd && git checkout" (deny: [evil-cmd]) → deny + allow → deny
   */
  private async evaluateCompoundCommand(
    ctx: PermissionCheckContext,
    subCommands: string[],
  ): Promise<PermissionDecision> {
    // Type for resolved decisions (excludes 'default' since it's resolved)
    type ResolvedDecision = 'allow' | 'ask' | 'deny';
    const PRIORITY: Record<ResolvedDecision, number> = {
      deny: 3,
      ask: 2,
      allow: 0,
    };

    let mostRestrictive: ResolvedDecision = 'allow';

    for (const subCmd of subCommands) {
      const subCtx: PermissionCheckContext = {
        ...ctx,
        command: subCmd,
      };
      const rawDecision = this.evaluateSingle(subCtx);

      // Resolve 'default' to actual permission using AST analysis
      // (same logic as ShellToolInvocation.getDefaultPermission)
      const decision: ResolvedDecision =
        rawDecision === 'default'
          ? await this.resolveDefaultPermission(subCmd)
          : (rawDecision as ResolvedDecision);

      if (PRIORITY[decision] > PRIORITY[mostRestrictive]) {
        mostRestrictive = decision;
      }

      // Short-circuit: deny is the most restrictive possible
      if (mostRestrictive === 'deny') {
        return 'deny';
      }
    }

    return mostRestrictive;
  }

  /**
   * Resolve 'default' permission to actual permission using AST analysis.
   * This mirrors the logic in ShellToolInvocation.getDefaultPermission().
   *
   * @param command - The shell command to analyze.
   * @returns 'deny' for command substitution, 'allow' for read-only, 'ask' otherwise.
   */
  private async resolveDefaultPermission(
    command: string,
  ): Promise<'allow' | 'ask' | 'deny'> {
    // Security: command substitution ($(), ``, <(), >()) → deny
    if (detectCommandSubstitution(command)) {
      return 'deny';
    }

    // AST-based read-only detection
    try {
      const isReadOnly = await isShellCommandReadOnlyAST(command);
      if (isReadOnly) {
        return 'allow';
      }
    } catch {
      // AST check failed, fall back to 'ask'
    }

    return 'ask';
  }

  // ---------------------------------------------------------------------------
  // Registry-level helper
  // ---------------------------------------------------------------------------

  /**
   * Determine whether a tool should be present in the tool registry.
   *
   * A tool is disabled (returns false) when a `deny` rule without a specifier
   * (i.e. a whole-tool deny) matches.  Specifier-based deny rules such as
   * `"Bash(rm -rf *)"` do NOT remove the tool from the registry – they only
   * deny specific invocations at runtime.
   */
  async isToolEnabled(toolName: string): Promise<boolean> {
    const canonicalName = resolveToolName(toolName);

    // If a coreTools allowlist is active, only explicitly listed tools are
    // registered. This mirrors the legacy `tools.core` whitelist semantic:
    // any tool NOT in the allowlist is excluded from the registry entirely.
    if (this.coreToolsAllowList !== null && this.coreToolsAllowList.size > 0) {
      if (!this.coreToolsAllowList.has(canonicalName)) {
        return false;
      }
    }

    // evaluate({ toolName }) without a command will only match rules that have
    // no specifier, which is the correct registry-level check.
    const decision = await this.evaluate({ toolName: canonicalName });
    return decision !== 'deny';
  }

  // ---------------------------------------------------------------------------
  // Shell command helper
  // ---------------------------------------------------------------------------

  /**
   * Determine the permission decision for a specific shell command string.
   *
   * @param command - The shell command to evaluate.
   * @returns The PermissionDecision for this command.
   */
  async isCommandAllowed(command: string): Promise<PermissionDecision> {
    return this.evaluate({
      toolName: 'run_shell_command',
      command,
    });
  }

  // ---------------------------------------------------------------------------
  // Relevance check
  // ---------------------------------------------------------------------------

  /**
   * Check whether any rule (allow, ask, or deny) in the current rule set
   * matches the given invocation context.
   *
   * This allows the scheduler to skip the full `evaluate()` call when no
   * rules are relevant, preserving the tool's `getDefaultPermission()` result
   * as-is.
   *
   * "Relevant" means at least one rule's toolName matches AND, if the rule
   * has a specifier, it also matches the context's command/filePath/domain.
   *
   * Examples for Shell executing `git clone xxx`:
   *   - "Bash"               → matches (tool-level rule, no specifier)
   *   - "Bash(git *)"        → matches (git sub-command wildcard)
   *   - "Bash(git clone *)"  → matches (exact sub-command wildcard)
   *   - "Bash(git add *)"    → no match (different sub-command)
   *   - "Edit"               → no match (different tool)
   *
   * @param ctx - Permission check context.
   * @returns true if at least one rule matches.
   */
  hasRelevantRules(ctx: PermissionCheckContext): boolean {
    const { toolName, command, filePath, domain, specifier } = ctx;

    if (ctx.toolName === 'run_shell_command' && command !== undefined) {
      const subCommands = splitCompoundCommand(command);
      if (subCommands.length > 1) {
        return subCommands.some((subCmd) =>
          this.hasRelevantRules({ ...ctx, command: subCmd }),
        );
      }
    }

    const pathCtx: PathMatchContext | undefined =
      this.config.getProjectRoot && this.config.getCwd
        ? {
            projectRoot: this.config.getProjectRoot(),
            cwd: this.config.getCwd(),
          }
        : undefined;

    const matchArgs = [
      toolName,
      command,
      filePath,
      domain,
      pathCtx,
      specifier,
    ] as const;

    const allRules = [
      ...this.sessionRules.allow,
      ...this.persistentRules.allow,
      ...this.sessionRules.ask,
      ...this.persistentRules.ask,
      ...this.sessionRules.deny,
      ...this.persistentRules.deny,
    ];

    if (allRules.some((rule) => matchesRule(rule, ...matchArgs))) return true;

    // For shell commands: also check whether any virtual file/network operation
    // extracted from the command has a relevant rule. This ensures the PM is
    // consulted (and the confirmation dialog shown) when Read/Edit/etc. rules
    // would match equivalent shell commands.
    if (ctx.toolName === 'run_shell_command' && ctx.command !== undefined) {
      const cwd = pathCtx?.cwd ?? process.cwd();
      const ops = extractShellOperations(ctx.command, cwd);
      if (
        ops.some((op) => {
          const opMatchArgs = [
            op.virtualTool,
            undefined,
            op.filePath,
            op.domain,
            pathCtx,
            undefined,
          ] as const;
          return allRules.some((rule) => matchesRule(rule, ...opMatchArgs));
        })
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Returns true when the invocation is matched by an explicit `ask` rule.
   *
   * This is intentionally narrower than `evaluate(ctx) === 'ask'`. Shell
   * commands can resolve to `ask` simply because they are non-read-only and no
   * explicit allow/deny rule matched. That fallback should still allow users to
   * create new allow rules, so callers must only hide "Always allow" when a
   * real ask rule matched.
   */
  hasMatchingAskRule(ctx: PermissionCheckContext): boolean {
    const { toolName, command, filePath, domain, specifier } = ctx;

    if (ctx.toolName === 'run_shell_command' && command !== undefined) {
      const subCommands = splitCompoundCommand(command);
      if (subCommands.length > 1) {
        return subCommands.some((subCmd) =>
          this.hasMatchingAskRule({ ...ctx, command: subCmd }),
        );
      }
    }

    const pathCtx: PathMatchContext | undefined =
      this.config.getProjectRoot && this.config.getCwd
        ? {
            projectRoot: this.config.getProjectRoot(),
            cwd: this.config.getCwd(),
          }
        : undefined;

    const matchArgs = [
      toolName,
      command,
      filePath,
      domain,
      pathCtx,
      specifier,
    ] as const;

    const askRules = [...this.sessionRules.ask, ...this.persistentRules.ask];

    if (askRules.some((rule) => matchesRule(rule, ...matchArgs))) {
      return true;
    }

    if (ctx.toolName === 'run_shell_command' && ctx.command !== undefined) {
      const cwd = pathCtx?.cwd ?? process.cwd();
      const ops = extractShellOperations(ctx.command, cwd);
      return ops.some((op) => {
        const opMatchArgs = [
          op.virtualTool,
          undefined,
          op.filePath,
          op.domain,
          pathCtx,
          undefined,
        ] as const;
        return askRules.some((rule) => matchesRule(rule, ...opMatchArgs));
      });
    }

    return false;
  }

  // ---------------------------------------------------------------------------
  // Session rule management
  // ---------------------------------------------------------------------------

  /**
   * Add a session-level allow rule (in-memory, cleared when the session ends).
   * Used when the user clicks "Always allow for this session".
   *
   * @param raw - The raw rule string, e.g. "Bash(git status)".
   */
  addSessionAllowRule(raw: string): void {
    if (raw && raw.trim()) {
      this.sessionRules.allow.push(parseRule(raw));
    }
  }

  /**
   * Add a session-level deny rule (in-memory, cleared when the session ends).
   */
  addSessionDenyRule(raw: string): void {
    if (raw && raw.trim()) {
      this.sessionRules.deny.push(parseRule(raw));
    }
  }

  /**
   * Add a session-level ask rule (in-memory, cleared when the session ends).
   */
  addSessionAskRule(raw: string): void {
    if (raw && raw.trim()) {
      this.sessionRules.ask.push(parseRule(raw));
    }
  }

  // ---------------------------------------------------------------------------
  // Persistent rule management
  // ---------------------------------------------------------------------------

  /**
   * Add a single persistent rule to the specified type.
   * This modifies the in-memory rule set; the caller is responsible for
   * persisting the change to disk (e.g. by writing to settings.json).
   *
   * @param raw - The raw rule string, e.g. "Bash(git *)"
   * @param type - 'allow' | 'ask' | 'deny'
   * @returns The parsed rule that was added.
   */
  addPersistentRule(raw: string, type: RuleType): PermissionRule {
    const rule = parseRule(raw);
    // Deduplicate: skip if a rule with the same raw string already exists
    const exists = this.persistentRules[type].some((r) => r.raw === rule.raw);
    if (!exists) {
      this.persistentRules[type].push(rule);
    }
    return rule;
  }

  /**
   * Remove a persistent rule matching the given raw string from the
   * specified type.  Removes the first match only.
   *
   * @returns true if a rule was removed, false if no matching rule was found.
   */
  removePersistentRule(raw: string, type: RuleType): boolean {
    const rules = this.persistentRules[type];
    const idx = rules.findIndex((r) => r.raw === raw);
    if (idx !== -1) {
      rules.splice(idx, 1);
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Default mode
  // ---------------------------------------------------------------------------

  /**
   * Return the current default approval mode from config.
   * This is used by the UI layer when `evaluate()` returns 'default' to
   * determine the actual behavior (ask vs allow).
   */
  getDefaultMode(): string {
    return this.config.getApprovalMode?.() ?? 'default';
  }

  /**
   * Update the persistent deny rules (called after migrating settings).
   * Replaces the persistent deny rule set entirely.
   */
  updatePersistentRules(ruleSet: Partial<PermissionRuleSet>): void {
    if (ruleSet.allow !== undefined) {
      this.persistentRules.allow = ruleSet.allow;
    }
    if (ruleSet.ask !== undefined) {
      this.persistentRules.ask = ruleSet.ask;
    }
    if (ruleSet.deny !== undefined) {
      this.persistentRules.deny = ruleSet.deny;
    }
  }

  // ---------------------------------------------------------------------------
  // Listing rules (for /permissions UI)
  // ---------------------------------------------------------------------------

  /**
   * Return all active rules with their types and scopes, suitable for
   * display in the /permissions dialog.
   */
  listRules(): RuleWithSource[] {
    const result: RuleWithSource[] = [];

    const addRules = (
      rules: PermissionRule[],
      type: RuleType,
      scope: RuleScope,
    ) => {
      for (const rule of rules) {
        result.push({ rule, type, scope });
      }
    };

    addRules(this.sessionRules.deny, 'deny', 'session');
    addRules(this.persistentRules.deny, 'deny', 'user');
    addRules(this.sessionRules.ask, 'ask', 'session');
    addRules(this.persistentRules.ask, 'ask', 'user');
    addRules(this.sessionRules.allow, 'allow', 'session');
    addRules(this.persistentRules.allow, 'allow', 'user');

    return result;
  }

  /**
   * Return a summary of active allow rules (raw strings), including
   * both session and persistent rules.  Used for telemetry.
   */
  getAllowRawStrings(): string[] {
    return [
      ...this.sessionRules.allow.map((r) => r.raw),
      ...this.persistentRules.allow.map((r) => r.raw),
    ];
  }
}
