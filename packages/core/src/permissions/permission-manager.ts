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
  SHELL_TOOL_NAMES,
  toolMatchesRuleToolName,
} from './rule-parser.js';
import type { PathMatchContext } from './rule-parser.js';
import { extractShellOperationsAcrossCommand } from './shell-semantics.js';
import type { ShellOperation } from './shell-semantics.js';
import {
  isShellCommandReadOnlyAST,
  isShellCommandReadOnlyASTInDirectory,
} from '../utils/shellAstParser.js';
import { normalizeMonitorCommand } from '../utils/shell-utils.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import {
  findDangerousAllowRules,
  isDangerousAllowRule,
} from './dangerousRules.js';
import { ToolNames } from '../tools/tool-names.js';
import type {
  PermissionCheckContext,
  PermissionDecision,
  PermissionRule,
  PermissionRuleSet,
  RuleType,
  RuleWithSource,
  RuleScope,
} from './types.js';

const debugLogger = createDebugLogger('PERMISSIONS');

/**
 * How a tool participates in the registry for this session.
 *
 * - `registered`: fully registered; its schema is sent in the eager model
 *   request.
 * - `deferred`: registered but hidden from the eager model request — the
 *   same treatment `shouldDefer` tools get. The tool stays listed in
 *   `/tools`, discoverable and loadable via ToolSearch, and a call to it
 *   goes through the normal approval flow. This is what happens to
 *   built-in tools not covered by an active `permissions.allow` registry
 *   allowlist: their schemas stay out of the eager request (#9827) without
 *   the tools silently disappearing from the session (#10075).
 * - `disabled`: not registered at all (whole-tool deny rule, or unlisted in
 *   the legacy `coreTools` allowlist).
 */
export type ToolRegistrationStatus = 'registered' | 'deferred' | 'disabled';

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

  /**
   * Returns the allow rules sourced from `settings.permissions.allow` only
   * (NOT `--allowed-tools`, the SDK `allowedTools` param, or the legacy
   * `tools.allowed` key — those stay pure auto-approval grants).
   *
   * When this list contains at least one valid rule, the registry-level
   * allowlist activates: built-in tools not covered by ANY in-force allow
   * rule are demoted to deferred — registered and callable, but hidden
   * from the eager model request so their schemas are not sent (#9827,
   * #10075).
   */
  getRegistryAllowList?(): string[] | undefined;
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
   * Allow rules temporarily removed while the user is in AUTO mode.
   * Populated by `stripDangerousRulesForAutoMode` (called from
   * `Config.setApprovalMode` on AUTO entry) and drained by
   * `restoreDangerousRules` (called on AUTO exit). `undefined` means
   * "not currently in AUTO mode" — distinct from "no rules stripped".
   */
  private strippedAllowRules?: {
    persistent: PermissionRule[];
    session: PermissionRule[];
  };

  /**
   * Canonical tool names from the legacy `coreTools` allowlist.
   * When non-null, `isToolEnabled()` rejects any tool not in this set.
   * Populated during `initialize()` from `config.getCoreTools()`.
   */
  private coreToolsAllowList: Set<string> | null = null;

  /**
   * Whether the `permissions.allow` registry allowlist is active.
   *
   * Snapshotted once in `initialize()`: the allowlist activates only when
   * `settings.permissions.allow` (exposed via `getRegistryAllowList()`)
   * contains at least one VALID rule. Pure auto-approval sources —
   * `--allowed-tools`, the SDK `allowedTools` param, the legacy
   * `tools.allowed` key — deliberately do NOT activate it; they keep their
   * documented "bypass the confirmation dialog" semantics (#9827).
   *
   * Activation is not re-evaluated later: rules granted mid-session
   * ("Always allow", skill `allowedTools`, `/permissions` writes) extend
   * allowlist MEMBERSHIP but must never activate the allowlist under a
   * running session, or approving one tool would suddenly
   * permission-error every tool not on the list. Registry composition is
   * a startup decision, consistent with the "Requires restart" semantics
   * of the other tool-availability settings.
   */
  private permissionsAllowListActive = false;

  /**
   * Frozen snapshot of the allow rules in force at startup, captured at
   * the end of `initialize()`.
   *
   * Registry membership must be monotonic within a session: activation and
   * registration are snapshotted at startup ("Requires restart"), so
   * REMOVING an allow rule mid-session — `/permissions` →
   * `removePersistentRule`, or a `qwen serve` settings edit →
   * `syncLivePermissionManagers` — must not hard-block a tool that was
   * legitimately registered (it is still listed in `/tools` and its schema
   * is still sent to the model; blocking every call with EXECUTION_DENIED
   * until restart contradicts the restart-scoped contract). Removals take
   * effect at restart; membership is the union of this frozen startup set
   * and the live rule set, so mid-session GRANTS still extend coverage
   * (#9827).
   */
  private startupAllowRules: PermissionRule[] = [];

  /**
   * Frozen snapshot of the ask rules in force at startup.
   *
   * Ask rules count toward registry-allowlist membership: a tool the user
   * configured to always be prompted for must stay usable, so "always ask"
   * must not silently become "unregistered" whenever an allowlist is
   * active (#9827). Membership is monotonic within the session for the
   * same reason as `startupAllowRules`: removing an ask rule mid-session
   * must not deregister a tool that was legitimately registered.
   */
  private startupAskRules: PermissionRule[] = [];

  /**
   * Set once the restart caveat for session allow-rule grants under an
   * active registry allowlist has been logged, so repeated skill
   * `allowedTools` grants do not pile identical warnings into the log.
   */
  private sessionGrantAllowlistCaveatLogged = false;

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

    // When the session starts in AUTO (via `tools.approvalMode: 'auto'` in
    // settings.json or `--approval-mode auto` on the CLI), the constructor
    // sets approvalMode before PermissionManager is wired up. Catch that
    // case here so AUTO-on-startup sessions get dangerous allow rules
    // stripped, same as sessions that switch to AUTO via Shift+Tab.
    if (this.config.getApprovalMode?.() === 'auto') {
      this.stripDangerousRulesForAutoMode();
    }

    // Snapshot the `permissions.allow` registry allowlist activation.
    // Only `settings.permissions.allow` rules activate it (see the
    // `permissionsAllowListActive` field). Requiring at least one VALID
    // rule keeps a malformed entry from gating the entire toolset.
    this.permissionsAllowListActive = parseRules(
      this.config.getRegistryAllowList?.() ?? [],
    ).some((rule) => !rule.invalid);

    // Freeze the startup allow-rule set AFTER the AUTO-mode strip above so
    // stripped (stashed) rules count toward membership too. Registry
    // membership is the union of this frozen set and the live rule set —
    // monotonic within the session, removals take effect at restart (see
    // `startupAllowRules`, #9827).
    this.startupAllowRules = this.getEffectiveAllowRules();

    // Ask rules count toward membership too (see
    // `isCoveredByAllowOrAskRule`); freeze them for the same
    // restart-scoped monotonicity. AUTO mode only strips allow rules, so
    // the live ask set is never stashed.
    this.startupAskRules = this.getEffectiveAskRules();
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
    ctx = this.normalizePermissionContext(ctx);
    const { command, toolName } = ctx;

    // ── Cross-command virtual-op pass (shell tools only) ─────────────────
    // Run the compound-aware extractor on the FULL original command before
    // splitting. This is the single source of truth for cd tracking and
    // recursive shell-wrapper unwrapping — without it, splitting first
    // would discard the cd context, so a rule like
    // `deny: ["Write(.qwen/settings.json)"]` would miss
    // `cd .qwen && bash -lc 'echo > settings.json'`.
    //
    // Virtual-op verdicts can only ESCALATE the overall decision; a
    // 'default' here means "shell semantics have no opinion" and we still
    // need to consult Bash rules below.
    let virtualDecision: PermissionDecision = 'default';
    if (command !== undefined && SHELL_TOOL_NAMES.has(toolName)) {
      const pathCtx: PathMatchContext | undefined =
        this.config.getProjectRoot && this.config.getCwd
          ? {
              projectRoot: this.config.getProjectRoot(),
              cwd: ctx.cwd ?? this.config.getCwd(),
            }
          : undefined;
      const cwd = pathCtx?.cwd ?? process.cwd();
      const ops = extractShellOperationsAcrossCommand(command, cwd);
      virtualDecision = this.evaluateShellVirtualOps(ops, pathCtx);
      // deny short-circuits — most restrictive verdict possible.
      if (virtualDecision === 'deny') return 'deny';
    }

    // ── Bash-rule pass: split compound commands and evaluate each
    // sub-command independently against Bash(...) patterns, returning the
    // most restrictive result. Priority: deny > ask > allow.
    let bashDecision: PermissionDecision;
    if (command !== undefined) {
      const subCommands = splitCompoundCommand(command);
      if (subCommands.length > 1) {
        bashDecision = await this.evaluateCompoundCommand(ctx, subCommands);
      } else {
        bashDecision = this.evaluateSingle(ctx);
        // For shell commands, resolve 'default' to actual permission via AST
        // analysis so the caller always sees a concrete verdict.
        if (
          bashDecision === 'default' &&
          SHELL_TOOL_NAMES.has(toolName) &&
          command !== undefined
        ) {
          bashDecision = await this.resolveDefaultPermission(
            command,
            ctx.cwd ?? this.config.getCwd?.(),
          );
        }
      }
    } else {
      bashDecision = this.evaluateSingle(ctx);
    }

    // ── Merge: virtual-op verdict can ESCALATE the bash verdict (to ask /
    // deny) but a 'default' virtual result means "shell semantics have no
    // opinion" and must never override an explicit allow from a Bash
    // rule. (DECISION_PRIORITY.default > DECISION_PRIORITY.allow so the
    // guard is load-bearing.)
    if (
      virtualDecision !== 'default' &&
      DECISION_PRIORITY[virtualDecision] > DECISION_PRIORITY[bashDecision]
    ) {
      return virtualDecision;
    }
    return bashDecision;
  }

  /**
   * Evaluate a single (non-compound) context against all rules.
   *
   * For shell commands (run_shell_command), the result is the most restrictive
   * of:
   *   1. The base decision from Bash / command-pattern rules.
   *   2. The decision derived from virtual file / network operations extracted
   *      via `extractShellOperationsAcrossCommand` — allows Read/Edit/Write/WebFetch rules
   *      to match equivalent shell commands (e.g. `cat` → Read, `curl` → WebFetch).
   */
  private evaluateSingle(ctx: PermissionCheckContext): PermissionDecision {
    const {
      toolName,
      toolAliases,
      command,
      cwd,
      filePath,
      domain,
      specifier,
      toolParams,
    } = ctx;

    // Build path context for resolving relative path patterns
    const pathCtx: PathMatchContext | undefined =
      this.config.getProjectRoot && this.config.getCwd
        ? {
            projectRoot: this.config.getProjectRoot(),
            cwd: cwd ?? this.config.getCwd(),
          }
        : undefined;

    const matchArgs = [
      toolName,
      command,
      filePath,
      domain,
      pathCtx,
      specifier,
      toolParams,
      toolAliases,
    ] as const;

    // Compute the base decision from explicit Bash/file/domain rules.
    // Using an IIFE to keep the priority-cascade logic clean.
    const baseDecision: PermissionDecision = (() => {
      // Restrictive rules follow canonical destinations; allow rules stay
      // lexical so a symlink cannot widen what the user explicitly allowed.
      // Priority 1: deny rules (session first, then persistent)
      for (const rule of [
        ...this.sessionRules.deny,
        ...this.persistentRules.deny,
      ]) {
        if (matchesRule(rule, ...matchArgs, 'canonical')) return 'deny';
      }
      // Priority 2: ask rules
      for (const rule of [
        ...this.sessionRules.ask,
        ...this.persistentRules.ask,
      ]) {
        if (matchesRule(rule, ...matchArgs, 'canonical')) return 'ask';
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
    if (SHELL_TOOL_NAMES.has(toolName) && command !== undefined) {
      const cwd = pathCtx?.cwd ?? process.cwd();
      // Use the compound-aware extractor here too so a single
      // `evaluateSingle` call on a segment like
      // `bash -lc 'echo > .qwen/settings.json'` still surfaces the inner
      // write to virtual-op rules. The cross-command cd-tracking pass at
      // the top of `evaluate()` handles `cd && wrapper` patterns —
      // per-segment unwrapping handles wrappers in isolation.
      const virtualDecision = this.evaluateShellVirtualOps(
        extractShellOperationsAcrossCommand(command, cwd),
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
    pathCtx: PathMatchContext | undefined,
  ): PermissionDecision {
    if (ops.length === 0) return 'default';

    let worst: PermissionDecision = 'default';

    for (const op of ops) {
      // Evaluate the virtual operation using the standard rule-matching path.
      // Since op.virtualTool ≠ 'run_shell_command', this will not recurse back
      // into the shell-semantics branch.
      let opDecision = this.evaluateSingle({
        toolName: op.virtualTool,
        cwd: pathCtx?.cwd,
        filePath: op.filePath,
        domain: op.domain,
      });

      if (
        op.cwdUnknown &&
        op.pathMayDependOnCwd &&
        DECISION_PRIORITY[opDecision] < DECISION_PRIORITY.ask &&
        this.hasDenyOrAskRuleForTool(op.virtualTool)
      ) {
        debugLogger.info(
          `PermissionManager: cwdUnknown escalation to 'ask' for virtualTool=${op.virtualTool} filePath=${op.filePath}`,
        );
        opDecision = 'ask';
      }

      if (DECISION_PRIORITY[opDecision] > DECISION_PRIORITY[worst]) {
        worst = opDecision;
        if (worst === 'deny') return 'deny'; // short-circuit
      }
    }

    return worst;
  }

  private hasDenyOrAskRuleForTool(toolName: string): boolean {
    return [
      ...this.sessionRules.ask,
      ...this.persistentRules.ask,
      ...this.sessionRules.deny,
      ...this.persistentRules.deny,
    ].some(
      (rule) =>
        !rule.invalid && toolMatchesRuleToolName(rule.toolName, toolName),
    );
  }

  /**
   * Evaluate a compound command by splitting it into sub-commands,
   * evaluating each independently, and returning the most restrictive result.
   *
   * Restriction order: deny > ask > allow
   *
   * When a sub-command returns 'default' (no rule matches), it is resolved to
   * the actual default permission using AST analysis:
   *   - Read-only command (cd, ls, git status, etc.) → 'allow'
   *   - Otherwise (including command substitution) → 'ask'
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
    const changesDirectory = subCommands.some((command) =>
      /^\s*(?:cd|pushd)(?:\s|$)/.test(command),
    );

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
          ? await this.resolveDefaultPermission(
              changesDirectory ? ctx.command! : subCmd,
              ctx.cwd ?? this.config.getCwd?.(),
            )
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
   * Command substitution ($(), ``, <(), >()) is NOT a hard deny here — it
   * falls through to 'ask' along with every other non-read-only command, so
   * the user (or YOLO mode) can decide. The user-facing warning is surfaced
   * by ShellToolInvocation.getConfirmationDetails so the confirmation prompt
   * still flags the substitution clearly. See issue #4093 for why a hard
   * deny here is wrong: it (a) cannot be overridden by YOLO mode and (b)
   * fires inconsistently based on whether the PermissionManager has
   * "relevant" rules for the surrounding compound command.
   *
   * @param command - The shell command to analyze.
   * @returns 'allow' for read-only, 'ask' otherwise.
   */
  private async resolveDefaultPermission(
    command: string,
    cwd?: string,
  ): Promise<'allow' | 'ask'> {
    try {
      const isReadOnly = cwd
        ? await isShellCommandReadOnlyASTInDirectory(command, cwd)
        : await isShellCommandReadOnlyAST(command);
      if (isReadOnly) {
        return 'allow';
      }
    } catch (e) {
      // Mirror the equivalent logging in `ShellToolInvocation.getDefaultPermission`
      // (shell.ts) and `MonitorToolInvocation.getDefaultPermission` (monitor.ts).
      // Pre-#4386 we had a regex `detectCommandSubstitution` safety net here;
      // with that gone, the AST check is the sole gatekeeper, so a silent
      // catch makes parser regressions invisible.
      debugLogger.warn('AST read-only check failed, falling back to ask:', e);
    }

    return 'ask';
  }

  private normalizePermissionContext(
    ctx: PermissionCheckContext,
  ): PermissionCheckContext {
    if (ctx.toolName !== 'monitor' || ctx.command === undefined) {
      return ctx;
    }

    // Note on cwd: callers wired through `buildPermissionCheckContext`
    // already populate `ctx.cwd` from the monitor's `directory` parameter
    // (see permission-helpers.ts), and the spread below preserves it. That
    // is what makes relative-path rules — including those derived from
    // virtual shell ops in evaluateSingle() — resolve against the monitor's
    // working directory rather than the global config cwd. Direct callers
    // of `evaluate()` that bypass that helper must pass `cwd` themselves.
    return {
      ...ctx,
      command: normalizeMonitorCommand(ctx.command).safetyCommand,
    };
  }

  // ---------------------------------------------------------------------------
  // Registry-level helper
  // ---------------------------------------------------------------------------

  /**
   * Core tools that are subject to the coreTools allowlist check.
   *
   * Tools NOT in this set bypass the check. Two categories live outside:
   * - Dynamically discovered tools (MCP, Skill).
   * - Synthetic system tools that the framework injects when a feature is
   *   opted into and that have no meaning when missing — `agent`,
   *   `exit_plan_mode`, `ask_user_question`, `task_stop`, `send_message`,
   *   `structured_output` (registered only when `--json-schema` is set).
   *   Excluding `structured_output` from `--core-tools` would leave a
   *   `--json-schema` run with no terminal contract, so the synthetic
   *   tool stays available regardless of the allowlist (deny rules still
   *   apply).
   */
  private static readonly CORE_TOOLS = new Set([
    'read_file',
    'zoom_image',
    'write_file',
    'edit',
    'notebook_edit',
    'glob',
    'grep_search',
    'run_shell_command',
    'list_directory',
    'read_mcp_resource',
    'web_fetch',
    'web_search',
    'todo_write',
    'save_memory',
    'lsp',
    'cron_create',
    'cron_list',
    'cron_delete',
    'loop_wakeup',
    'create_sub_session',
    'monitor',
  ]);

  /**
   * Synthetic plan-mode lifecycle tools that must stay registered even under
   * an active `permissions.allow` registry allowlist. The plan-mode system
   * reminder instructs the model to present its plan by calling
   * `exit_plan_mode`, and `enter_plan_mode` / `ask_user_question` are the
   * sanctioned plan-flow entry and clarification tools; dropping their
   * schemas makes the plan flow impossible to complete (#9827). They belong
   * to the same exemption class as `structured_output` and the "synthetic
   * system tools" the CORE_TOOLS docstring names — deny rules still apply.
   */
  private static readonly PLAN_LIFECYCLE_TOOLS: ReadonlySet<string> = new Set([
    ToolNames.EXIT_PLAN_MODE,
    ToolNames.ENTER_PLAN_MODE,
    ToolNames.ASK_USER_QUESTION,
  ]);

  /**
   * Check if a tool is a core tool subject to the coreTools allowlist check.
   */
  private isCoreTool(toolName: string): boolean {
    return PermissionManager.CORE_TOOLS.has(toolName);
  }

  /**
   * Determine whether a tool is callable in this session.
   *
   * Returns `true` for `registered` AND `deferred` tools: a deferred tool
   * is still registered — it is merely hidden from the eager model request
   * and loadable via ToolSearch — so a call to it must flow through the
   * normal approval evaluation, not a permission error (#10075). Only
   * `disabled` tools (whole-tool deny rule, or unlisted in the legacy
   * `coreTools` allowlist) return `false`.
   *
   * Specifier-based deny rules such as `"Bash(rm -rf *)"` never disable the
   * tool — they only deny specific invocations at runtime. Likewise,
   * specifier-based allow rules such as `"Bash(npm test)"` cover the tool
   * for allowlist membership — the allowlist is tool-level, not
   * invocation-level.
   *
   * Non-core tools (MCP, Skill, Agent, etc.) skip the coreTools allowlist
   * check because they are dynamically discovered or essential for system
   * operation, but they ARE subject to the `permissions.allow` registry
   * allowlist (except the exempt families, see
   * {@link getToolRegistrationStatus}) — that is the documented migration
   * semantic of the legacy `tools.core` whitelist, and the only way to keep
   * e.g. `send_message` / `update_goal` schemas out of the eager model
   * request (#9827).
   */
  async isToolEnabled(toolName: string): Promise<boolean> {
    return (await this.getToolRegistrationStatus(toolName)) !== 'disabled';
  }

  /**
   * Whether a tool is excluded by the legacy `coreTools` allowlist
   * (`--core-tools` / `tools.core`). Unlike the `permissions.allow`
   * registry allowlist — which demotes uncovered tools to `deferred` —
   * the legacy coreTools knob keeps its documented hard-disable semantic:
   * an unlisted core tool is not registered at all.
   */
  isToolDisabledByCoreToolsAllowList(toolName: string): boolean {
    const canonicalName = resolveToolName(toolName);
    return (
      this.isCoreTool(canonicalName) &&
      this.coreToolsAllowList !== null &&
      this.coreToolsAllowList.size > 0 &&
      !this.coreToolsAllowList.has(canonicalName)
    );
  }

  /**
   * Built-in/system tools that are exempt from the `permissions.allow`
   * registry allowlist — always `registered` (subject to deny rules). See
   * {@link getToolRegistrationStatus} for the per-family rationale.
   */
  private isExemptFromPermissionsAllowList(canonicalName: string): boolean {
    return (
      canonicalName === ToolNames.STRUCTURED_OUTPUT ||
      PermissionManager.PLAN_LIFECYCLE_TOOLS.has(canonicalName) ||
      canonicalName === ToolNames.TASK_STOP ||
      canonicalName === ToolNames.TOOL_SEARCH ||
      canonicalName === ToolNames.DEFERRED_TOOL_CALL ||
      canonicalName.startsWith('mcp__') ||
      canonicalName.startsWith('computer_use__')
    );
  }

  /**
   * Determine how a tool participates in the registry for this session.
   *
   * While the `permissions.allow` registry allowlist is active (see
   * `isPermissionsAllowListActive`), a built-in tool not covered by any
   * allow or ask rule is `deferred`, NOT `disabled`: it stays registered —
   * listed in `/tools`, discoverable and loadable via ToolSearch — but its
   * schema is kept out of the eager model request, which is the #9827
   * guarantee. Call-time approval for such a tool falls back to the normal
   * permission evaluation (ask / approval-mode), the pre-allowlist
   * behaviour, so existing allowlist users never lose capability silently
   * (#10075). Ask rules cover a tool for membership so "always require
   * confirmation" never becomes "not in the eager request" either.
   *
   * Exempt from the allowlist (always `registered` unless denied):
   * - MCP tools (`mcp__*`): dynamically discovered and filtered via the
   *   per-server `includeTools` / `excludeTools` and `tools.disabled`
   *   knobs instead — same bypass the legacy coreTools allowlist had.
   * - `structured_output`: the synthetic terminal contract for
   *   `--json-schema` runs; removing it leaves such runs with no way to
   *   finish (deny rules still apply to it).
   * - Plan-mode lifecycle tools (`exit_plan_mode` / `enter_plan_mode` /
   *   `ask_user_question`): the plan-mode system reminder tells the model
   *   to call `exit_plan_mode` to present a plan, so their schemas must
   *   reach the model for the sanctioned plan flow to complete (#9827).
   * - `task_stop`: registered tools advertise it to the model —
   *   `run_shell_command`'s schema says to use `task_stop` to stop a
   *   background command (and not to use broad process-name kills), and
   *   the background-promotion result instructs `task_stop({ task_id })`
   *   verbatim. It is `shouldDefer=true` (task-stop.ts), the exact
   *   property the computer_use__* exemption below cites: deferred
   *   schemas never enter the eager model request, so gating it buys
   *   nothing for the schema-shrink goal and only strips the sanctioned
   *   stop flow while the tool that advertises it stays listed (#9827).
   * - Computer Use tools (`computer_use__*`): the generated cua-driver
   *   surface (35 tools, `computerUseEnabled` defaults to true) has no
   *   alias entry, meta-category, or wildcard rule form — the wire names
   *   churn on every cua-driver version bump (see tool-names.ts), so no
   *   concise allow rule can keep the family listed. Every member is
   *   `shouldDefer=true`, so the schemas never enter the eager model
   *   request anyway: gating them buys nothing for the schema-shrink
   *   goal and only strips capability, including ToolSearch
   *   discoverability. The legacy `tools.core` gate never dropped them
   *   either (non-core tools bypassed it) (#9827).
   * - `tool_search`: the deferred-tool discovery surface itself. When
   *   ToolSearch is absent from the registry, client.ts
   *   (`resolveDeferredToolsForReminder`) eagerly force-reveals EVERY
   *   registered deferred tool — all `mcp__*` tools and the deferred
   *   `computer_use__*` family — into the eager model request, and
   *   `preloadDeferredToolsWithinBudget` early-returns without it, so
   *   gating tool_search under a narrow allowlist inverts the
   *   schema-shrink goal into maximal schema bloat for exactly the
   *   deferred families the exemptions above preserve for ToolSearch
   *   discoverability. tool_search itself is never `shouldDefer`
   *   (tool-search.ts), so its own schema cost is unchanged by keeping
   *   it listed. Pre-#9827 it always bypassed the legacy coreTools gate
   *   as a non-core tool (#9827). ToolSearch is precisely what makes the
   *   deferred-not-disabled semantic usable (#10075).
   * - `tool_call`: the bridge that executes what tool_search finds. config.ts
   *   registers tool_search and tool_call as a pair and unregisters
   *   tool_search when tool_call is unavailable, so gating tool_call under a
   *   narrow allowlist degrades the discovery pair the tool_search exemption
   *   above preserves. Exempting it grants no execution — normalization
   *   rewrites the request to the real target before scheduling, so the
   *   target's own allow/deny rules still gate the call.
   *
   * `disabled` is reserved for the hard gates: a whole-tool deny rule
   * (deny always wins over allowlist membership), or the legacy
   * `coreTools` allowlist, whose documented semantic is hard exclusion
   * and which — unlike `permissions.allow` — predates the deferred
   * demotion and is set deliberately (#9827).
   */
  async getToolRegistrationStatus(
    toolName: string,
  ): Promise<ToolRegistrationStatus> {
    const canonicalName = resolveToolName(toolName);

    // Deny rules win over everything: a whole-tool deny removes the tool
    // from the session regardless of allowlist coverage.
    // evaluate({ toolName }) without a command will only match rules that
    // have no specifier, which is the correct registry-level check.
    const decision = await this.evaluate({ toolName: canonicalName });
    if (decision === 'deny') {
      return 'disabled';
    }

    // The legacy coreTools allowlist keeps its hard-disable semantic.
    if (this.isToolDisabledByCoreToolsAllowList(canonicalName)) {
      return 'disabled';
    }

    if (
      this.permissionsAllowListActive &&
      !this.isExemptFromPermissionsAllowList(canonicalName) &&
      !this.isCoveredByAllowOrAskRule(canonicalName)
    ) {
      return 'deferred';
    }

    return 'registered';
  }

  /**
   * Whether the `permissions.allow` registry allowlist is active for this
   * session. See the `permissionsAllowListActive` field for the activation
   * contract (snapshot at `initialize()`, restart-scoped).
   */
  isPermissionsAllowListActive(): boolean {
    return this.permissionsAllowListActive;
  }

  /**
   * All allow rules currently in force: persistent + session + any rules
   * the AUTO-mode strip moved to the stash (they are configured rules,
   * merely suspended for runtime auto-approval purposes).
   */
  private getEffectiveAllowRules(): PermissionRule[] {
    return [
      ...this.sessionRules.allow,
      ...this.persistentRules.allow,
      ...(this.strippedAllowRules?.session ?? []),
      ...(this.strippedAllowRules?.persistent ?? []),
    ];
  }

  /**
   * All ask rules currently in force: persistent + session. AUTO mode
   * strips only allow rules (the stash in `strippedAllowRules`), so ask
   * rules are never suspended and no stash applies here.
   */
  private getEffectiveAskRules(): PermissionRule[] {
    return [...this.sessionRules.ask, ...this.persistentRules.ask];
  }

  /**
   * Registry-membership check for the `permissions.allow` allowlist: true
   * when any in-force allow OR ask rule mentions the tool. Ask rules count
   * because they express "this tool must stay usable, with confirmation" —
   * a tool covered only by an ask rule must not be silently deregistered
   * whenever an allowlist is active, or the documented "always require
   * user confirmation" would become "tool unavailable" and the ask rule
   * could never fire (#9827). Tool-name matching is specifier-agnostic
   * (`Bash(npm test)` keeps `run_shell_command` registered) and honours
   * meta-categories (`Read` covers grep/glob/..., `Bash` covers monitor)
   * via `toolMatchesRuleToolName`.
   *
   * Membership is monotonic within the session: the union of the frozen
   * startup rule sets (`startupAllowRules` / `startupAskRules`) and the
   * live rule sets. Removing a STARTUP rule mid-session therefore never
   * deregisters an already-registered tool (removals take effect at
   * restart, matching the documented "Requires restart" contract), while
   * rules granted mid-session — skill `allowedTools`, "Always allow",
   * `/permissions` writes — extend membership live even though they can
   * never ACTIVATE the allowlist (#9827).
   *
   * Caveat: extending membership flips this runtime predicate only. A
   * mid-session grant can never PROMOTE a tool the startup allowlist left
   * uncovered into the eager model request — the registry is built once in
   * `Config.initialize` and such a tool stays permission-deferred (still
   * registered and callable, loadable via ToolSearch, but its schema not
   * sent eagerly) until the rule is added to settings `permissions.allow`
   * and the session restarts (#9827, #10075).
   *
   * Public so the scheduler can tell an allowlist miss (tool genuinely
   * uncovered) apart from a rejection by a different gate — e.g. the
   * legacy `coreTools` allowlist — for a tool that IS covered, where
   * "add a permissions.allow rule" advice would be a no-op (#9827).
   */
  isCoveredByAllowOrAskRule(toolName: string): boolean {
    const canonicalName = resolveToolName(toolName);
    const covered = (rule: PermissionRule): boolean =>
      !rule.invalid && toolMatchesRuleToolName(rule.toolName, canonicalName);
    return (
      this.startupAllowRules.some(covered) ||
      this.getEffectiveAllowRules().some(covered) ||
      this.startupAskRules.some(covered) ||
      this.getEffectiveAskRules().some(covered)
    );
  }

  /**
   * Find the first deny rule that matches the given context.
   * Returns the raw rule string if found, or undefined if no deny rule matches.
   *
   * Useful for providing user-visible feedback about which rule caused a denial.
   */
  findMatchingDenyRule(ctx: PermissionCheckContext): string | undefined {
    ctx = this.normalizePermissionContext(ctx);
    const {
      toolName,
      toolAliases,
      command,
      cwd,
      filePath,
      domain,
      specifier,
      toolParams,
    } = ctx;

    const pathCtx: PathMatchContext | undefined =
      this.config.getProjectRoot && this.config.getCwd
        ? {
            projectRoot: this.config.getProjectRoot(),
            cwd: cwd ?? this.config.getCwd(),
          }
        : undefined;

    const matchArgs = [
      toolName,
      command,
      filePath,
      domain,
      pathCtx,
      specifier,
      toolParams,
      toolAliases,
    ] as const;

    for (const rule of [
      ...this.sessionRules.deny,
      ...this.persistentRules.deny,
    ]) {
      if (matchesRule(rule, ...matchArgs, 'canonical')) {
        return rule.raw;
      }
    }
    return undefined;
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
  async isCommandAllowed(
    command: string,
    cwd?: string,
  ): Promise<PermissionDecision> {
    return this.evaluate({
      toolName: 'run_shell_command',
      command,
      cwd,
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
    ctx = this.normalizePermissionContext(ctx);
    const {
      toolName,
      toolAliases,
      command,
      cwd,
      filePath,
      domain,
      specifier,
      toolParams,
    } = ctx;

    const pathCtx: PathMatchContext | undefined =
      this.config.getProjectRoot && this.config.getCwd
        ? {
            projectRoot: this.config.getProjectRoot(),
            cwd: cwd ?? this.config.getCwd(),
          }
        : undefined;

    const allowRules = [
      ...this.sessionRules.allow,
      ...this.persistentRules.allow,
    ];
    const restrictiveRules = [
      ...this.sessionRules.ask,
      ...this.persistentRules.ask,
      ...this.sessionRules.deny,
      ...this.persistentRules.deny,
    ];

    // ── Cross-command virtual-op pass (shell tools only) ─────────────────
    // Run before the splitCompound recursion so cd tracking and recursive
    // wrapper unwrapping see the FULL original command. Required so
    // rules like `Write(.qwen/settings.json)` are recognised as relevant
    // for `cd .qwen && bash -lc 'echo > settings.json'`.
    if (SHELL_TOOL_NAMES.has(toolName) && command !== undefined) {
      const cwdForOps = pathCtx?.cwd ?? process.cwd();
      const ops = extractShellOperationsAcrossCommand(command, cwdForOps);
      if (
        ops.some((op) => {
          if (
            op.cwdUnknown &&
            op.pathMayDependOnCwd &&
            this.hasDenyOrAskRuleForTool(op.virtualTool)
          ) {
            return true;
          }

          const opMatchArgs = [
            op.virtualTool,
            undefined,
            op.filePath,
            op.domain,
            pathCtx,
            undefined,
          ] as const;
          return (
            restrictiveRules.some((rule) =>
              matchesRule(
                rule,
                ...opMatchArgs,
                undefined,
                undefined,
                'canonical',
              ),
            ) ||
            allowRules.some((rule) =>
              matchesRule(rule, ...opMatchArgs, undefined),
            )
          );
        })
      ) {
        return true;
      }
    }

    if (SHELL_TOOL_NAMES.has(ctx.toolName) && command !== undefined) {
      const subCommands = splitCompoundCommand(command);
      if (subCommands.length > 1) {
        return subCommands.some((subCmd) =>
          this.hasRelevantRules({ ...ctx, command: subCmd }),
        );
      }
    }

    const matchArgs = [
      toolName,
      command,
      filePath,
      domain,
      pathCtx,
      specifier,
      toolParams,
      toolAliases,
    ] as const;

    return (
      restrictiveRules.some((rule) =>
        matchesRule(rule, ...matchArgs, 'canonical'),
      ) || allowRules.some((rule) => matchesRule(rule, ...matchArgs))
    );
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
    ctx = this.normalizePermissionContext(ctx);
    const {
      toolName,
      toolAliases,
      command,
      cwd,
      filePath,
      domain,
      specifier,
      toolParams,
    } = ctx;

    const pathCtx: PathMatchContext | undefined =
      this.config.getProjectRoot && this.config.getCwd
        ? {
            projectRoot: this.config.getProjectRoot(),
            cwd: cwd ?? this.config.getCwd(),
          }
        : undefined;

    const askRules = [...this.sessionRules.ask, ...this.persistentRules.ask];

    // ── Cross-command virtual-op pass (shell tools only) ─────────────────
    // See `hasRelevantRules` for the rationale; same cd-tracking and
    // wrapper-unwrapping requirement applies to ask rules.
    if (SHELL_TOOL_NAMES.has(toolName) && command !== undefined) {
      const cwdForOps = pathCtx?.cwd ?? process.cwd();
      const ops = extractShellOperationsAcrossCommand(command, cwdForOps);
      if (
        ops.some((op) => {
          if (
            op.cwdUnknown &&
            op.pathMayDependOnCwd &&
            this.hasAskRuleForTool(op.virtualTool)
          ) {
            return true;
          }

          const opMatchArgs = [
            op.virtualTool,
            undefined,
            op.filePath,
            op.domain,
            pathCtx,
            undefined,
          ] as const;
          return askRules.some((rule) =>
            matchesRule(
              rule,
              ...opMatchArgs,
              undefined,
              undefined,
              'canonical',
            ),
          );
        })
      ) {
        return true;
      }
    }

    if (SHELL_TOOL_NAMES.has(ctx.toolName) && command !== undefined) {
      const subCommands = splitCompoundCommand(command);
      if (subCommands.length > 1) {
        return subCommands.some((subCmd) =>
          this.hasMatchingAskRule({ ...ctx, command: subCmd }),
        );
      }
    }

    const matchArgs = [
      toolName,
      command,
      filePath,
      domain,
      pathCtx,
      specifier,
      toolParams,
      toolAliases,
    ] as const;

    return askRules.some((rule) =>
      matchesRule(rule, ...matchArgs, 'canonical'),
    );
  }

  private hasAskRuleForTool(toolName: string): boolean {
    return [...this.sessionRules.ask, ...this.persistentRules.ask].some(
      (rule) =>
        !rule.invalid && toolMatchesRuleToolName(rule.toolName, toolName),
    );
  }

  // ---------------------------------------------------------------------------
  // Session rule management
  // ---------------------------------------------------------------------------

  /**
   * Add a session-level allow rule (in-memory, cleared when the session ends).
   * Used when the user clicks "Always allow for this session".
   *
   * Under an active `permissions.allow` registry allowlist the grant
   * auto-approves matching calls and extends allowlist MEMBERSHIP, but it
   * cannot promote a permission-deferred tool into the eager model request
   * — registry composition is restart-scoped. The first such grant logs a
   * caveat pointing at the restart path (#9827, #10075).
   *
   * @param raw - The raw rule string, e.g. "Bash(git status)".
   */
  addSessionAllowRule(raw: string): void {
    if (raw && raw.trim()) {
      const rule = parseRule(raw);
      if (rule.invalid) {
        debugLogger.warn(
          `Ignoring malformed allow rule (unbalanced parentheses): ${rule.raw}`,
        );
        return;
      }
      if (
        this.permissionsAllowListActive &&
        !this.sessionGrantAllowlistCaveatLogged
      ) {
        this.sessionGrantAllowlistCaveatLogged = true;
        debugLogger.warn(
          'Session allow rule granted while the permissions.allow registry allowlist is active: ' +
            'the grant auto-approves matching calls and extends allowlist membership, but it cannot ' +
            'promote a deferred tool into the eager model request — a tool the startup allowlist left ' +
            'uncovered stays deferred (loadable via ToolSearch, schema not sent eagerly) until the ' +
            'rule is added to settings permissions.allow and the session restarts (#9827, #10075).',
        );
      }
      // AUTO mode invariant: while dangerous allow rules are stripped,
      // any newly added allow rule that is itself dangerous must be
      // stashed alongside the strip rather than made active. Without
      // this, a user clicking "Always allow" on a fallback prompt for
      // a Bash invocation could persist `Bash` or `Bash(python *)` and
      // every subsequent AUTO call would bypass the classifier. See
      // dangerousRules.ts for the classifier-bypass criteria.
      if (this.strippedAllowRules && isDangerousAllowRule(rule)) {
        // Deduplicate on raw string — matches the persistent-stash branch
        // in addPersistentRule. A repeated "Always allow" choice for the
        // same rule must not pile copies into the session stash.
        const exists = this.strippedAllowRules.session.some(
          (r) => r.raw === rule.raw,
        );
        if (!exists) {
          this.strippedAllowRules.session.push(rule);
        }
        debugLogger.info(
          `Stashed newly added dangerous allow rule while in AUTO mode: ${rule.raw}`,
        );
        return;
      }
      // Deduplicate on raw string — mirrors addPersistentRule and the
      // dangerous-stash branch above. Reload cycles (e.g. /unskill +
      // re-invoke) re-run applySkillAllowedTools; without this guard the
      // skill's allowedTools list would accumulate on every cycle.
      if (this.sessionRules.allow.some((r) => r.raw === rule.raw)) {
        return;
      }
      this.sessionRules.allow.push(rule);
    }
  }

  /**
   * Add a session-level deny rule (in-memory, cleared when the session ends).
   */
  addSessionDenyRule(raw: string): void {
    if (raw && raw.trim()) {
      const rule = parseRule(raw);
      if (rule.invalid) {
        debugLogger.warn(
          `Ignoring malformed deny rule (unbalanced parentheses): ${rule.raw}`,
        );
        return;
      }
      this.sessionRules.deny.push(rule);
    }
  }

  /**
   * Add a session-level ask rule (in-memory, cleared when the session ends).
   */
  addSessionAskRule(raw: string): void {
    if (raw && raw.trim()) {
      const rule = parseRule(raw);
      if (rule.invalid) {
        debugLogger.warn(
          `Ignoring malformed ask rule (unbalanced parentheses): ${rule.raw}`,
        );
        return;
      }
      this.sessionRules.ask.push(rule);
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
    if (rule.invalid) {
      debugLogger.warn(
        `Ignoring malformed ${type} rule (unbalanced parentheses): ${rule.raw}`,
      );
      return rule;
    }
    // AUTO mode invariant: see addSessionAllowRule above. A dangerous
    // allow rule persisted while in AUTO must not become active until
    // the user exits AUTO — otherwise an "Always allow" choice on a
    // fallback prompt would bypass the classifier from that point on.
    // The settings.json write is still performed by the caller (this
    // method only manages the in-memory ruleset), so the rule reaches
    // disk and will activate normally on the next non-AUTO start.
    if (
      type === 'allow' &&
      this.strippedAllowRules &&
      isDangerousAllowRule(rule)
    ) {
      const exists = this.strippedAllowRules.persistent.some(
        (r) => r.raw === rule.raw,
      );
      if (!exists) {
        this.strippedAllowRules.persistent.push(rule);
      }
      debugLogger.info(
        `Stashed newly added dangerous persistent allow rule while in AUTO mode: ${rule.raw}`,
      );
      return rule;
    }
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
        if (!rule.invalid) {
          result.push({ rule, type, scope });
        }
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

  // ---------------------------------------------------------------------------
  // AUTO mode dangerous-rule stash
  // ---------------------------------------------------------------------------

  /**
   * Remove any allow rules whose breadth would defeat the AUTO classifier
   * (see {@link findDangerousAllowRules}) and stash them for restore.
   * Idempotent — calling twice while in AUTO is a no-op. Deny rules are
   * never stripped; users intend deny rules as hard blocks regardless of
   * mode.
   */
  stripDangerousRulesForAutoMode(): {
    persistent: PermissionRule[];
    session: PermissionRule[];
  } {
    if (this.strippedAllowRules) {
      return this.strippedAllowRules;
    }

    const persistentDangerous = findDangerousAllowRules(
      this.persistentRules.allow,
    );
    const sessionDangerous = findDangerousAllowRules(this.sessionRules.allow);

    if (persistentDangerous.length === 0 && sessionDangerous.length === 0) {
      this.strippedAllowRules = { persistent: [], session: [] };
      return this.strippedAllowRules;
    }

    const persistentDangerousSet = new Set(persistentDangerous);
    const sessionDangerousSet = new Set(sessionDangerous);

    this.persistentRules.allow = this.persistentRules.allow.filter(
      (r) => !persistentDangerousSet.has(r),
    );
    this.sessionRules.allow = this.sessionRules.allow.filter(
      (r) => !sessionDangerousSet.has(r),
    );

    this.strippedAllowRules = {
      persistent: persistentDangerous,
      session: sessionDangerous,
    };
    return this.strippedAllowRules;
  }

  /**
   * Reverse of {@link stripDangerousRulesForAutoMode}: re-attach previously
   * stripped allow rules to their original scope. Idempotent when not
   * currently in AUTO.
   */
  restoreDangerousRules(): void {
    if (!this.strippedAllowRules) return;
    if (this.strippedAllowRules.persistent.length > 0) {
      this.persistentRules.allow = [
        ...this.persistentRules.allow,
        ...this.strippedAllowRules.persistent,
      ];
    }
    if (this.strippedAllowRules.session.length > 0) {
      this.sessionRules.allow = [
        ...this.sessionRules.allow,
        ...this.strippedAllowRules.session,
      ];
    }
    this.strippedAllowRules = undefined;
  }

  /**
   * Return a snapshot of currently-stashed dangerous allow rules.
   * Used by the UI to surface a "the following rules are disabled in AUTO
   * mode" notice. Returns `undefined` when not currently in AUTO.
   */
  getStrippedDangerousRules():
    | {
        persistent: readonly PermissionRule[];
        session: readonly PermissionRule[];
      }
    | undefined {
    return this.strippedAllowRules;
  }
}
