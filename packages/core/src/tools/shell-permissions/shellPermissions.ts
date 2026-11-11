/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  PermissionBehavior,
  PermissionRule,
} from '../../permissions/manager/decision/index.js';
import type {
  PathPermissionContext,
  PermissionUpdate,
} from '../tool-checkers/checker-reasons.js';
import {
  applyManagedRuleResult,
  checkManagedContentRules,
  denyByRule,
  type ToolPermissionResult,
} from '../tool-checkers/rule-precedence.js';
import { posix } from 'node:path';
import { parse, type ParseEntry } from 'shell-quote';
import {
  PermissionModes,
  permissionRuleValueFromString,
} from '../../permissions/manager/decision/index.js';
import {
  parsePermissionRule,
  matchWildcardPattern,
  suggestionForExactCommand,
  suggestionForPrefix,
} from './shellRuleMatching.js';
import { isDangerousShellCommand } from './dangerousCommandDetection.js';
import { checkDangerousRemoval } from './dangerousRemoval.js';
import {
  classifyPathShape,
  isNetworkPathEnforced,
} from '../../utils/pathShape.js';
import {
  analyzeShellCommand,
  scanShellShape,
  type ShellCommandAnalysis,
} from './shellCommandAnalysis.js';
import { checkReadOnlyShellCommand } from './shellReadOnlyValidation.js';
import type { ShellReadOnlyContext } from './gitReadOnlySafety.js';
import { checkReadOnlyShellPathConstraints } from './shellPathConstraints.js';
import { checkWritePermissionForPath } from '../filesystem-permissions/filesystem.js';
import { isSpecialDeviceTarget } from '../../utils/specialDevicePaths.js';
import { expandTilde } from '../filesystem-permissions/pathValidation.js';
import { getPlatform } from '../../utils/platform.js';
import { windowsPathToPosixPath } from '../../utils/windowsPaths.js';

// Re-export analyzeShellCommand for external consumers
export { analyzeShellCommand } from './shellCommandAnalysis.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Input shape for shell/command tool permission checks.
 * Matches the subset of ShellToolParams needed for permission evaluation.
 */
export interface ShellPermissionInput extends Record<string, unknown> {
  command: string;
  description?: string;
  dir_path?: string;
  /** Backward-compatible cwd used for both execution and permission root. */
  cwd?: string;
  /** Real cwd used by shell execution; relative command paths resolve here. */
  executionCwd?: string;
  /** Permission boundary root; dir_path must not expand this. */
  permissionCwd?: string;
}

// ============================================================================
// Safe Environment Variables and Wrappers
// ============================================================================

/**
 * Regex to match environment variable assignment at the start of a command.
 * e.g., "NODE_ENV=prod" or "HOME=/tmp"
 */
const ENV_VAR_ASSIGN_RE = /^[A-Z_][A-Z0-9_]*=/;

/**
 * Set of env var names considered safe to skip when extracting prefixes
 * or stripping env vars. Only safe, non-privileged environment variables.
 */
const SAFE_ENV_VARS = new Set([
  'NODE_ENV',
  'CI',
  'DEBUG',
  'VERBOSE',
  'LANG',
  'LC_ALL',
  'TZ',
  'HOME',
  'PATH',
  'TERM',
  'SHELL',
  'EDITOR',
  'VISUAL',
  'PAGER',
  'FORCE_COLOR',
  'NO_COLOR',
  'NPM_CONFIG_YES',
]);

/**
 * Pattern for environment variables with safe character values.
 *
 * SECURITY: Trailing whitespace MUST be [ \t]+ (horizontal only), NOT \s+.
 * \s matches \n/\r which are command separators in bash. Matching across a
 * newline would strip the env var from one line and leave a different command
 * on the next line for bash to execute.
 *
 * SECURITY: Only matches unquoted values with safe characters (no $(), `, $var, ;|&).
 */
const ENV_VAR_PATTERN = /^([A-Za-z_][A-Za-z0-9_]*)=([A-Za-z0-9_./:-]+)[ \t]+/;

/**
 * Safe wrapper command patterns for stripping.
 *
 * These are commands that use execvp to run their arguments, so they
 * are transparent wrappers that don't change command semantics.
 *
 * SECURITY: Use [ \t]+ NOT \s+ — \s matches \n/\r which are command
 * separators in bash. Matching across a newline would strip the wrapper
 * from one line and leave a different command on the next line.
 *
 * SECURITY: `(?:--[ \t]+)?` consumes the wrapper's own `--` so
 * `nohup -- rm -- -/../foo` strips to `rm -- -/../foo`.
 */
const SAFE_WRAPPER_PATTERNS = [
  // timeout: enumerate GNU long flags — no-value (--foreground,
  // --preserve-status, --verbose), value-taking in both =fused and
  // space-separated forms (--kill-after=5, --signal=TERM).
  // Short: -v (no-arg), -k/-s with separate or fused value.
  // SECURITY: flag VALUES use allowlist [A-Za-z0-9_.+-] to prevent
  // injection via $(), `, etc.
  /^timeout[ \t]+(?:(?:--(?:foreground|preserve-status|verbose)|--(?:kill-after|signal)=[A-Za-z0-9_.+-]+|--(?:kill-after|signal)[ \t]+[A-Za-z0-9_.+-]+|-v|-[ks][ \t]+[A-Za-z0-9_.+-]+|-[ks][A-Za-z0-9_.+-]+)[ \t]+)*(?:--[ \t]+)?\d+(?:\.\d+)?[smhd]?[ \t]+/,
  /^time[ \t]+(?:--[ \t]+)?/,
  // nice: matches bare `nice cmd`, `nice -n N cmd`, `nice -N cmd`
  /^nice(?:[ \t]+-n[ \t]+-?\d+|[ \t]+-\d+)?[ \t]+(?:--[ \t]+)?/,
  // stdbuf: fused short flags only (-o0, -eL)
  /^stdbuf(?:[ \t]+-[ioe][LN0-9]+)+[ \t]+(?:--[ \t]+)?/,
  /^nohup[ \t]+(?:--[ \t]+)?/,
] as const;

/**
 * Wrappers whose real command NAME becomes visible once the wrapper head and
 * its options are skipped, but whose full argv/behavior is not statically
 * fixed:
 *   - `xargs` / `parallel` append arguments at runtime (stdin, or `:::` lists)
 *   - `watch` runs its command through `sh -c`, so metacharacters in it are
 *     shell-interpreted rather than passed verbatim
 *
 * SECURITY: deny/ask must see through all of them (a user who denies Bash(rm:*)
 * expects `find . | xargs rm` to be denied).
 */
const DENY_ASK_WRAPPERS = new Set(['xargs', 'parallel', 'watch']);

/**
 * The subset of DENY_ASK_WRAPPERS that is ALSO safe to widen allow for
 * prefix/wildcard rules.
 *
 * SECURITY: `xargs` uses execvp — it runs the wrapped program unchanged and can
 * only append LITERAL argv from stdin (no shell). So a prefix rule that already
 * grants any arguments, like Bash(grep:*), soundly covers `xargs grep foo`.
 * `parallel` and `watch` run their command through a shell, so widening allow
 * through them could let injected metacharacters run — they must NEVER widen
 * allow and stay out of this set. Exact allow rules are never widened either
 * (xargs appends stdin args, so the command is not byte-equal to any exact
 * rule); see findMatchingContentRule.
 */
const ALLOW_WIDENING_WRAPPERS = new Set(['xargs']);

// Head must be a bare wrapper name followed by horizontal whitespace, on a
// single line. `([^\n\r]*)$` refuses to span a newline (a command separator),
// so `xargs\nrm` never strips.
const WRAPPER_HEAD_PATTERN = /^([A-Za-z][A-Za-z0-9_-]*)[ \t]+([^\n\r]*)$/;

// One leading option token: starts with `-`, runs until whitespace, and
// excludes shell metacharacters so a fused injection like `-d$(x)` fails to
// match (leaving the command unstripped rather than mis-parsed).
const LEADING_OPTION_PATTERN = /^-[^ \t\n\r$`;|&()<>'"\\]*[ \t]+([^\n\r]*)$/;

/**
 * Strips comment lines from a command string.
 * Keeps non-empty lines that don't start with #.
 * If all lines are comments/empty, returns the original.
 */
function stripCommentLines(command: string): string {
  const lines = command.split('\n');
  const nonCommentLines = lines.filter((line) => {
    const trimmed = line.trim();
    return trimmed !== '' && !trimmed.startsWith('#');
  });

  if (nonCommentLines.length === 0) {
    return command;
  }

  return nonCommentLines.join('\n');
}

/**
 * Strips safe wrappers and environment variables from a command string
 * for permission rule matching.
 *
 * Two-phase stripping (security: HackerOne #3543050):
 * - Phase 1: Strip leading env vars only (VAR=val before command)
 * - Phase 2: Strip wrapper commands only (timeout, time, nice, stdbuf, nohup)
 *
 * The separation prevents mismatch between what the parser sees and what
 * actually executes. After a wrapper, VAR=val is treated as the COMMAND
 * to execute, not as an env var assignment.
 *
 * @param command The shell command to normalize
 * @returns The command with safe wrappers and env vars stripped
 */
export function stripSafeWrappers(command: string): string {
  // Strip comments once upfront — stripping env vars and wrappers cannot
  // introduce new comment lines, so repeating inside the loop is wasted work.
  let stripped = stripCommentLines(command);
  let previousStripped = '';

  // Phase 1: Strip leading env vars only.
  // In bash, env var assignments before a command (VAR=val cmd) are genuine
  // shell-level assignments. These are safe to strip for permission matching.
  while (stripped !== previousStripped) {
    previousStripped = stripped;

    const envVarMatch = stripped.match(ENV_VAR_PATTERN);
    if (envVarMatch) {
      const varName = envVarMatch[1];
      if (SAFE_ENV_VARS.has(varName)) {
        stripped = stripped.replace(ENV_VAR_PATTERN, '');
      }
    }
  }

  // Phase 2: Strip wrapper commands only. Do NOT strip env vars.
  // Wrapper commands use execvp to run their arguments, so VAR=val after a
  // wrapper is treated as the COMMAND to execute, not as an env var assignment.
  previousStripped = '';
  while (stripped !== previousStripped) {
    previousStripped = stripped;

    for (const pattern of SAFE_WRAPPER_PATTERNS) {
      stripped = stripped.replace(pattern, '');
    }
  }

  return stripped.trim();
}

/**
 * Strips all leading environment variable assignments from a command.
 * Unlike stripSafeWrappers Phase 1, this strips ALL env vars, not just
 * safe ones. Used for deny-rule matching where we want to see through
 * env var prefixes.
 *
 * @param command The shell command to strip
 * @param blocklist Optional regex — if the var name matches, stop stripping
 * @returns The command with leading env vars stripped
 */
export function stripAllLeadingEnvVars(
  command: string,
  blocklist?: RegExp,
): string {
  // Broader value pattern for deny-rule stripping. Handles:
  // - Standard assignment (FOO=bar), append (FOO+=bar), array (FOO[0]=bar)
  // - Single-quoted values: '[^'\n\r]*'
  // - Double-quoted values with backslash escapes
  // - Unquoted values: excludes shell metacharacters
  // - Concatenated segments: FOO='x'y"z"
  //
  // SECURITY: Trailing whitespace MUST be [ \t]+ (horizontal only), NOT \s+.
  const BROAD_ENV_VAR_PATTERN =
    /^([A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?)\+?=(?:'[^'\n\r]*'|"(?:\\.|[^"$`\\\n\r])*"|\\.|[^ \t\n\r$`;|&()<>\\\\'"])*[ \t]+/;

  // Strip comments once upfront — env var stripping cannot introduce new
  // comment lines, so repeating inside the loop is wasted work.
  let stripped = stripCommentLines(command);
  let previousStripped = '';

  while (stripped !== previousStripped) {
    previousStripped = stripped;

    const m = stripped.match(BROAD_ENV_VAR_PATTERN);
    if (!m) continue;
    if (blocklist?.test(m[1])) break;
    stripped = stripped.slice(m[0].length);
  }

  return stripped.trim();
}

/**
 * Strips a recognized wrapper head (see DENY_ASK_WRAPPERS /
 * ALLOW_WIDENING_WRAPPERS) from the front of a command, revealing the wrapped
 * command name for rule matching. The caller passes which wrapper set applies
 * (deny/ask uses the full set; the allow path uses the narrower subset).
 *
 * Generic, not per-command: after a wrapper head it skips a run of leading
 * option tokens (anything starting with `-`) to reach the wrapped command. It
 * deliberately does NOT model per-option arity, so a separate-form option value
 * — the `1` in `xargs -n 1 rm` — halts stripping and the command is left
 * unstripped rather than mis-parsed. Fused forms (`xargs -n1 rm`) are covered.
 * Under-stripping only weakens a guardrail / narrows an allow; it never causes
 * a false match.
 *
 * @param command The shell command or segment to strip
 * @param wrappers The set of wrapper names eligible for stripping
 * @returns The command with a recognized wrapper prefix stripped
 */
function stripWrapperHead(command: string, wrappers: Set<string>): string {
  const head = command.trim().match(WRAPPER_HEAD_PATTERN);
  if (!head || !wrappers.has(head[1])) return command.trim();

  let rest = head[2];
  for (;;) {
    const opt = rest.match(LEADING_OPTION_PATTERN);
    if (!opt) break;
    rest = opt[1];
  }

  rest = rest.trim();
  // The wrapped command must be a plain word. An empty or still-option-looking
  // remainder means we could not locate it (e.g. `xargs -d $(x) rm`, `xargs -n`
  // with a dangling value) — leave the command unstripped rather than guess.
  if (rest === '' || rest.startsWith('-')) return command.trim();
  return rest;
}

/**
 * Builds all candidate strings that deny/ask rules should match against
 * for a single command or segment.
 *
 * Uses an alternating fixed-point loop that interleaves:
 * 1. `stripSafeWrappers()` — strips safe env vars + wrapper commands
 * 2. `stripAllLeadingEnvVars()` — strips ALL env vars (broad, for deny/ask)
 * 3. `stripWrapperHead(_, DENY_ASK_WRAPPERS)` — strips name-transparent
 *    wrappers (xargs/parallel/watch), which reveal the real command name but
 *    not their full argv
 *
 * This handles interleaved wrappers and env assignments such as:
 *   `nohup FOO=bar timeout 5 BAZ=qux rm -rf x`
 *
 * SECURITY: deny/ask candidates use the broad `stripAllLeadingEnvVars()`
 * matcher. Allow candidates should NOT use this function — they must use
 * the safe-list-only `stripSafeWrappers()` to prevent env var hijack.
 *
 * @param command A single command or segment to generate candidates for
 * @returns De-duplicated array of candidate strings (original first)
 */
export function buildDenyAskCandidates(command: string): string[] {
  const seen = new Set<string>();
  const candidates: string[] = [];

  function add(s: string): void {
    const trimmed = s.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      candidates.push(trimmed);
    }
  }

  add(command);

  // Alternating fixed-point: keep stripping until nothing changes.
  let current = command.trim();
  let changed = true;
  while (changed) {
    changed = false;

    // Phase A: strip safe wrappers (safe env vars + wrapper commands)
    const afterWrappers = stripSafeWrappers(current);
    if (afterWrappers !== current) {
      add(afterWrappers);
      current = afterWrappers;
      changed = true;
    }

    // Phase B: strip ALL leading env vars (broad, for deny/ask).
    // No blocklist — deny/ask must see through all env var prefixes including
    // LD_PRELOAD, DYLD_*, PATH. A user who denies Bash(rm:*) expects
    // LD_PRELOAD=x rm -rf x to also be denied.
    const afterEnv = stripAllLeadingEnvVars(current);
    if (afterEnv !== current) {
      add(afterEnv);
      current = afterEnv;
      changed = true;
    }

    // Phase C: strip name-transparent wrappers (xargs/parallel/watch) for
    // deny/ask. The allow path strips only the ALLOW_WIDENING_WRAPPERS subset,
    // at its own call site — not here.
    const afterDenyAskWrappers = stripWrapperHead(current, DENY_ASK_WRAPPERS);
    if (afterDenyAskWrappers !== current) {
      add(afterDenyAskWrappers);
      current = afterDenyAskWrappers;
      changed = true;
    }
  }

  return candidates;
}

// ============================================================================
// Rule Collection Helpers
// ============================================================================

/**
 * Collects content-level rules for a tool from the permission context.
 *
 * @param context The permission context
 * @param toolName The tool name to match
 * @param behavior Which rule behavior to collect ('allow' | 'deny' | 'ask')
 * @returns Array of content rules with their parsed rule values
 */
function collectContentRulesForTool(
  context: PathPermissionContext,
  toolName: string,
  behavior: PermissionBehavior,
): PermissionRule[] {
  const rules: PermissionRule[] = [];
  const rulesBySource = context.rules[behavior];

  for (const [source, ruleStrings] of Object.entries(rulesBySource)) {
    if (!ruleStrings) continue;
    for (const ruleString of ruleStrings) {
      const parsed = permissionRuleValueFromString(ruleString);

      // Only content-level rules (must have ruleContent)
      if (!parsed.ruleContent) continue;

      // Must match the tool name
      if (parsed.toolName !== toolName && parsed.toolName !== '*') continue;

      rules.push({
        source: source as PermissionRule['source'],
        ruleBehavior: behavior,
        ruleValue: parsed,
      });
    }
  }

  return rules;
}

// ============================================================================
// Command Matching
// ============================================================================

/**
 * Checks whether a command matches a rule's content pattern.
 *
 * Uses the shellRuleMatching primitives to handle:
 * - Exact match
 * - Legacy prefix match (:*)
 * - Wildcard match (glob-style *)
 */
export function commandMatchesRule(
  command: string,
  ruleContent: string,
  blockCompound: boolean,
): boolean {
  const parsed = parsePermissionRule(ruleContent);

  switch (parsed.type) {
    case 'exact':
      return command === parsed.command;

    case 'prefix':
      // For allow rules, prefix must NOT match compound commands — a "cd:*"
      // allow rule should not auto-approve "cd /foo && rm -rf /".
      // Deny/ask rules still need to match so they can block or flag compounds.
      if (blockCompound) return false;
      return (
        command === parsed.prefix || command.startsWith(parsed.prefix + ' ')
      );

    case 'wildcard':
      // Same logic: only block compound matching for allow rules.
      if (blockCompound) return false;
      return matchWildcardPattern(parsed.pattern, command);

    default:
      return false;
  }
}

/**
 * Finds the first content-level rule that matches a command.
 * Matches against both the original command and the stripped (wrapper-free) version.
 *
 * @param blockCompound When true, prefix/wildcard rules skip compound commands.
 *   Pass true for allow rules, false for deny/ask rules.
 * @param strippedCommand Pre-computed wrapper-stripped version of command.
 */
function findMatchingContentRule(
  command: string,
  rules: PermissionRule[],
  blockCompound: boolean,
  strippedCommand: string,
  wrapperStripped?: string,
): PermissionRule | null {
  // The stripped variant inherits the caller's blockCompound flag. If the
  // original command blocks broad allow, stripping wrappers cannot make it
  // safe — the execution boundaries are still present. Re-scanning the
  // stripped variant would be both redundant and logically inconsistent.
  for (const rule of rules) {
    if (!rule.ruleValue.ruleContent) continue;
    // Match against original command
    if (
      commandMatchesRule(command, rule.ruleValue.ruleContent, blockCompound)
    ) {
      return rule;
    }
    // Match against stripped command (if different)
    if (
      strippedCommand !== command &&
      commandMatchesRule(
        strippedCommand,
        rule.ruleValue.ruleContent,
        blockCompound,
      )
    ) {
      return rule;
    }
    // Match against the allow-widening wrapper-stripped variant, e.g.
    // `xargs grep foo` -> `grep foo`. SECURITY: prefix/wildcard rules ONLY —
    // never exact. xargs appends stdin args at runtime, so the running command
    // is not byte-equal to any exact rule; only a rule that already grants
    // arbitrary arguments (Bash(grep:*)) soundly covers it.
    if (
      wrapperStripped !== undefined &&
      wrapperStripped !== command &&
      wrapperStripped !== strippedCommand &&
      parsePermissionRule(rule.ruleValue.ruleContent).type !== 'exact' &&
      commandMatchesRule(
        wrapperStripped,
        rule.ruleValue.ruleContent,
        blockCompound,
      )
    ) {
      return rule;
    }
  }
  return null;
}

/**
 * Finds the first rule whose content is an exact match for the command.
 * Used as a fast-path before building deny/ask candidates (which involves
 * expensive stripping). Exact rules don't need stripping since they match
 * the full command string literally.
 */
function findExactMatchRule(
  command: string,
  rules: PermissionRule[],
): PermissionRule | null {
  for (const rule of rules) {
    if (!rule.ruleValue.ruleContent) continue;
    const parsed = parsePermissionRule(rule.ruleValue.ruleContent);
    if (parsed.type === 'exact' && command === parsed.command) return rule;
  }
  return null;
}

/**
 * Finds the first deny/ask rule matching any of the given candidate strings.
 *
 * For deny/ask rules, `blockCompound` is always false (deny/ask rules must
 * fire even on compound commands). Each candidate is checked against each
 * rule, and candidates include the original command plus all aggressively
 * stripped variants from `buildDenyAskCandidates()`.
 *
 * @param candidates Array of candidate strings to match against rules
 * @param rules The deny/ask rules to check
 * @returns The first matching rule, or null
 */
function findMatchingDenyAskRule(
  candidates: string[],
  rules: PermissionRule[],
): PermissionRule | null {
  for (const rule of rules) {
    if (!rule.ruleValue.ruleContent) continue;
    for (const candidate of candidates) {
      if (commandMatchesRule(candidate, rule.ruleValue.ruleContent, false)) {
        return rule;
      }
    }
  }
  return null;
}

// ============================================================================
// Suggestion Generation
// ============================================================================

/**
 * Bare shell prefixes that must NOT be suggested as permission rule prefixes.
 *
 * Rationale:
 * - Shell interpreters: `bash:*`, `sh:*`, etc. would allow arbitrary code via `-c`.
 * - Exec wrappers: `env:*`, `xargs:*` can run arbitrary commands.
 * - Process wrappers: `nice:*`, `nohup:*`, `timeout:*`, `time:*`, `stdbuf:*`
 *   are transparent wrappers — suggesting them effectively grants `Bash(*)`.
 * - Privilege escalation: `sudo:*`, `doas:*`, `pkexec:*` would elevate any command.
 */
const BARE_SHELL_PREFIXES = new Set([
  // Shell interpreters
  'sh',
  'bash',
  'zsh',
  'fish',
  'csh',
  'tcsh',
  'ksh',
  'dash',
  'cmd',
  'powershell',
  'pwsh',
  // Wrappers that exec their args as a command
  'env',
  'xargs',
  // Process wrappers (transparent — suggesting them is equivalent to Bash(*))
  'nice',
  'stdbuf',
  'nohup',
  'timeout',
  'time',
  // Privilege escalation
  'sudo',
  'doas',
  'pkexec',
]);

/**
 * Regex to validate that a token looks like a valid subcommand name:
 * lowercase alphanumeric with optional hyphens (e.g., "commit", "run", "list-files").
 * Rejects flags (-v), paths (/usr), URLs, numbers, etc.
 */
const SUBCOMMAND_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

// ============================================================================
// Compound Command Detection (Compatibility Wrappers)
// ============================================================================

/**
 * Compatibility wrapper: detects whether a command has any execution boundary
 * that should block broad prefix/wildcard allow rules.
 *
 * Delegates to `analyzeShellCommand().blocksBroadAllow`. New code should use
 * `analyzeShellCommand()` directly.
 *
 * @deprecated Use `analyzeShellCommand(command).blocksBroadAllow` instead.
 */
export function isCompoundCommand(command: string): boolean {
  return scanShellShape(command).blocksBroadAllow;
}

/**
 * Compatibility wrapper: splits a command at top-level shell operators.
 *
 * Delegates to `analyzeShellCommand().topLevelSegments`. New code should use
 * `analyzeShellCommand()` directly.
 *
 * @deprecated Use `analyzeShellCommand(command).topLevelSegments` instead.
 */
export function splitCommandSync(command: string): string[] {
  return scanShellShape(command).topLevelSegments;
}

// ============================================================================
// Shell Output Redirection Targets
// ============================================================================

const OUTPUT_REDIRECTION_OPS = new Set(['>', '>>']);

type ShellOutputWriteTarget = {
  path: string;
  ruleContent: string;
};

function parseShellEntries(command: string): ParseEntry[] | null {
  try {
    return parse(command, (env) => `$${env}`);
  } catch {
    return null;
  }
}

function shellOperator(entry: ParseEntry | undefined): string | undefined {
  return typeof entry === 'object' &&
    entry !== null &&
    'op' in entry &&
    typeof (entry as { op?: unknown }).op === 'string'
    ? (entry as { op: string }).op
    : undefined;
}

function hasDynamicPathSyntax(pathValue: string): boolean {
  return /(^|[^\\])\$/.test(pathValue) || pathValue.includes('`');
}

function resolveShellWritePath(
  pathValue: string,
  executionCwd: string,
): string {
  let target = pathValue;
  let cwd = executionCwd;
  if (getPlatform() === 'windows') {
    target = windowsPathToPosixPath(target);
    cwd = windowsPathToPosixPath(cwd);
  }
  if (target.startsWith('~') || posix.isAbsolute(target)) {
    return target;
  }
  return posix.resolve(expandTilde(cwd), target);
}

function ruleContentForOutputRedirection(
  command: string,
  redirectionIndex: number,
): string {
  const beforeRedirection = command.slice(0, redirectionIndex).trim();
  return beforeRedirection ? `${beforeRedirection} *` : command;
}

function findOutputWriteTargets(
  command: string,
  executionCwd: string,
): ShellOutputWriteTarget[] | null {
  const entries = parseShellEntries(command);
  if (!entries) {
    return null;
  }

  const targets: ShellOutputWriteTarget[] = [];
  let searchFrom = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const op = shellOperator(entry);
    if (!op || !OUTPUT_REDIRECTION_OPS.has(op)) {
      continue;
    }

    let targetIndex = i + 1;
    // shell-quote tokenizes >| as ">" followed by "|".
    if (shellOperator(entries[targetIndex]) === '|') {
      targetIndex++;
    }

    const target = entries[targetIndex];
    if (typeof target !== 'string' || target.length === 0) {
      return null;
    }
    if (hasDynamicPathSyntax(target)) {
      return null;
    }

    const redirectionIndex = command.indexOf(op, searchFrom);
    if (redirectionIndex < 0) {
      return null;
    }
    searchFrom = redirectionIndex + op.length;

    // Special devices (e.g. /dev/null, NUL) don't write to the real
    // filesystem — skip them as write targets.
    if (isSpecialDeviceTarget(target)) {
      continue;
    }

    targets.push({
      path: resolveShellWritePath(target, executionCwd),
      ruleContent: ruleContentForOutputRedirection(command, redirectionIndex),
    });
  }

  return targets.length > 0 ? targets : [];
}

function suggestionForShellRuleContent(
  toolName: string,
  ruleContent: string,
): PermissionUpdate[] {
  return [
    {
      type: 'addRules',
      rules: [{ toolName, ruleContent }],
      behavior: 'allow',
      destination: 'localSettings',
    },
  ];
}

function suggestionsForShellOutputWrite(
  toolName: string,
  command: string,
  blocksBroadAllow: boolean,
  targets: readonly ShellOutputWriteTarget[],
  writeSuggestions: readonly PermissionUpdate[] | undefined,
): PermissionUpdate[] {
  const shellSuggestions = blocksBroadAllow
    ? suggestionForExactCommand(toolName, command)
    : targets.flatMap((target) =>
        suggestionForShellRuleContent(toolName, target.ruleContent),
      );
  const pathSuggestions = (writeSuggestions ?? []).filter(
    (suggestion) => suggestion.type !== 'setMode',
  );
  return [...shellSuggestions, ...pathSuggestions];
}

// ============================================================================
// Prefix Extraction
// ============================================================================

/**
 * Extracts a 2-word command prefix suitable for permission rule suggestions.
 *
 * Handles leading safe env var assignments, validates the second token as a
 * subcommand (not a flag, path, or URL), and returns `command subcommand`.
 *
 * @example
 * getSimpleCommandPrefix('git commit -m "fix"') // => 'git commit'
 * getSimpleCommandPrefix('NODE_ENV=prod npm run build') // => 'npm run'
 * getSimpleCommandPrefix('ls -la') // => null (flag, not subcommand)
 * getSimpleCommandPrefix('echo hello') // => null ('hello' is not a subcommand)
 */
export function getSimpleCommandPrefix(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;

  // Skip leading safe env var assignments
  let i = 0;
  while (i < tokens.length && ENV_VAR_ASSIGN_RE.test(tokens[i])) {
    const varName = tokens[i].split('=')[0];
    if (!SAFE_ENV_VARS.has(varName)) {
      return null; // Unsafe env var — don't generate prefix suggestions
    }
    i++;
  }

  const remaining = tokens.slice(i);
  // Need at least 2 tokens (command + subcommand) for a meaningful prefix
  if (remaining.length < 2) return null;

  const subcmd = remaining[1];
  // Validate the second token looks like a subcommand
  if (!SUBCOMMAND_RE.test(subcmd)) return null;

  return remaining.slice(0, 2).join(' ');
}

/**
 * Extracts a single-word command prefix as a fallback.
 * Used for the editable suggestion field when 2-word extraction fails.
 *
 * Only returns a prefix when the command has arguments (at least 2 tokens),
 * since a bare command doesn't need a prefix rule.
 *
 * Applies the same env var safety gate and blocks dangerous bare commands
 * via BARE_SHELL_PREFIXES.
 *
 * @example
 * getFirstWordPrefix('npm install foo') // => 'npm'
 * getFirstWordPrefix('bash -c "evil"') // => null (blocked by BARE_SHELL_PREFIXES)
 * getFirstWordPrefix('sudo rm -rf /') // => null (blocked by BARE_SHELL_PREFIXES)
 * getFirstWordPrefix('ls') // => null (single-word, no prefix needed)
 */
export function getFirstWordPrefix(command: string): string | null {
  const tokens = command.trim().split(/\s+/).filter(Boolean);

  // Skip leading safe env var assignments
  let i = 0;
  while (i < tokens.length && ENV_VAR_ASSIGN_RE.test(tokens[i])) {
    const varName = tokens[i].split('=')[0];
    if (!SAFE_ENV_VARS.has(varName)) {
      return null;
    }
    i++;
  }

  const remaining = tokens.slice(i);
  // Need at least 2 tokens for a prefix to be meaningful
  if (remaining.length < 2) return null;

  const cmd = remaining[0];
  // Must look like a command name
  if (!SUBCOMMAND_RE.test(cmd)) return null;
  // Block dangerous bare prefixes
  if (BARE_SHELL_PREFIXES.has(cmd)) return null;
  return cmd;
}

// ============================================================================
// Dangerous Command Override
// ============================================================================

/**
 * Returns an 'ask' result if the command is dangerous (rm -rf, git push --force,
 * etc.), otherwise null. Used as a guard after any allow decision — even explicit
 * allow rules must not silently permit destructive operations.
 */
function dangerousCommandOverride(
  command: string,
  toolName: string,
  analysis?: ShellCommandAnalysis,
): ToolPermissionResult | null {
  const warning = isDangerousShellCommand({ command }, analysis);
  if (!warning) return null;
  return {
    kind: 'ask',
    reason: {
      message: `Dangerous command detected (${warning}): ${command}`,
      attribution: {
        type: 'safetyCheck',
        reason: `Dangerous command: ${warning}`,
        safetyCheckKind: 'dangerousCommand',
        classifierApprovable: false,
      },
      decisionPoint: 'shell.dangerous_command.ask',
    },
    suggestions: suggestionForExactCommand(toolName, command),
  };
}

// ============================================================================
// Shell Permission Check
// ============================================================================

/**
 * Checks permission for a shell command.
 *
 * This is the tool-specific permission check for shell/command execution tools.
 * It evaluates content-level rules (rules with ruleContent) against the
 * command string using shell-aware matching:
 *
 * Pipeline:
 * 1. Check content-level deny rules
 * 2. Check content-level ask rules
 * 3. Check content-level allow rules → passthrough (let pipeline decide)
 * 4. Default: passthrough with suggestions
 *
 * Note: Tool-level rules (without content) are handled by the outer pipeline
 * in `hasPermissionsToUseToolInner`. This function only handles content-level
 * matching specific to shell commands.
 *
 * @param input The shell command input
 * @param context The permission context
 * @param toolName The tool name (e.g., 'Bash')
 * @returns Permission result
 */
export function checkShellPermission(
  input: ShellPermissionInput,
  context: PathPermissionContext,
  toolName: string,
  readOnlyContext?: ShellReadOnlyContext,
): ToolPermissionResult {
  const analysis = analyzeShellCommand(input.command);
  const runLocal = () =>
    checkShellPermissionInner(
      input,
      context,
      toolName,
      analysis,
      readOnlyContext,
    );
  if (!context.globalRules) return runLocal();

  // The same full-command and executable-segment candidates used by local deny/ask.
  const candidates = [
    ...new Set([
      ...buildDenyAskCandidates(input.command),
      ...analysis.executableSegments.flatMap(buildDenyAskCandidates),
    ]),
  ];
  const managed = checkManagedContentRules(
    toolName,
    context.globalRules,
    (content) =>
      candidates.some((candidate) =>
        commandMatchesRule(candidate, content, false),
      ),
  );
  if (!managed) return runLocal();
  if (managed.kind === 'deny') return managed;

  // A local deny must not be hidden by an exact-ask or safety-ask fast path.
  const localDeny = findMatchingDenyAskRule(
    candidates,
    collectContentRulesForTool(context, toolName, 'deny'),
  );
  if (localDeny) return denyByRule(toolName, localDeny);
  // This layer matches rules; the outer mode layer decides whether prompting is possible.
  return applyManagedRuleResult(runLocal(), managed, PermissionModes.Default);
}

function checkShellPermissionInner(
  input: ShellPermissionInput,
  context: PathPermissionContext,
  toolName: string,
  analysis: ReturnType<typeof analyzeShellCommand>,
  readOnlyContext?: ShellReadOnlyContext,
): ToolPermissionResult {
  const command = input.command;

  // The boundary and the execution directory, for every step that resolves a
  // path. `cwd` is the backward-compatible single value.
  const permissionCwd = input.permissionCwd ?? input.cwd;
  const executionCwd = input.executionCwd ?? input.cwd ?? permissionCwd;

  // ── Command string must not carry a network location ──
  // Intentionally use the original whitespace-delimited scan. Parsing quoted,
  // fused, or nested payloads here can mistake heredoc/source text for a path.
  // Keep the Windows-only enforcement and ask behavior below unchanged.
  if (isNetworkPathEnforced()) {
    for (const token of stripCommentLines(command).split(/\s+/)) {
      const shape = classifyPathShape(token);
      if (shape.network.kind === 'network' && shape.network.host !== null) {
        // This ask is not bypass-immune, so a catastrophic removal sharing
        // the command must answer first or Yolo would wave both through.
        const removal = checkDangerousRemoval(command, analysis, {
          executionCwd,
          permissionCwd,
          additionalDirectories: context.additionalDirectories,
        });
        if (removal) return removal;
        return {
          kind: 'ask',
          reason: {
            message: `Command contains a UNC path that requires confirmation: ${token}`,
            attribution: {
              type: 'other',
              reason:
                'Command contains a UNC path that could trigger network requests',
            },
            decisionPoint: 'shell.network_path.ask',
          },
        };
      }
    }
  }

  // topLevelSegments for allow: only top-level splits, no nested extraction.
  const topLevelSubs = analysis.topLevelSegments;
  const hasMultipleTopLevel = topLevelSubs.length > 1;

  // ── Fast-path: exact deny → exact ask before expensive stripping ──
  // Exact rules match the full command string literally and don't need
  // candidate building or stripping. This avoids buildDenyAskCandidates()
  // cost for the common case where an exact deny/ask rule matches.
  const denyRules = collectContentRulesForTool(context, toolName, 'deny');
  const exactDeny = findExactMatchRule(command, denyRules);
  if (exactDeny) {
    return {
      kind: 'deny',
      extra: {
        denialReason: {
          message: `Command denied by ${exactDeny.source} rule: ${command}`,
          attribution: { type: 'rule', rule: exactDeny },
          denialKind: 'permission-rule',
          decisionPoint: 'shell.rule_exact.deny',
        },
        decisionPoint: 'shell.rule_exact.deny',
      },
    };
  }

  const askRules = collectContentRulesForTool(context, toolName, 'ask');
  const exactAsk = findExactMatchRule(command, askRules);
  if (exactAsk) {
    return {
      kind: 'ask',
      reason: {
        message: `Command requires confirmation per ${exactAsk.source} rule: ${command}`,
        attribution: { type: 'rule', rule: exactAsk },
        decisionPoint: 'shell.rule_exact.ask',
      },
      suggestions: suggestionForExactCommand(toolName, command),
    };
  }

  // ── Build deny/ask candidates for full command and all executable segments ──
  // Uses aggressive stripping (all env vars + wrapper interleave) so deny/ask
  // rules can see through wrappers and env var prefixes.
  const fullCmdCandidates = buildDenyAskCandidates(command);
  // Skip per-segment candidate building when executable segments are just the
  // original command — the full-command candidates already cover it.
  const segmentCandidateSets: string[][] = [];
  const trimmedCmd = command.trim();
  for (const seg of analysis.executableSegments) {
    if (seg === trimmedCmd) continue;
    segmentCandidateSets.push(buildDenyAskCandidates(seg));
  }

  // Step 1: Prefix/wildcard deny rules — check full command candidates first,
  // then per-segment candidates. This ensures Bash(rm:*) deny catches both
  // "rm -rf x && echo ok" and "echo ok && rm -rf x", as well as
  // "FOO=bar rm -rf x" and "nohup FOO=bar timeout 5 rm -rf x".
  const denyMatch = findMatchingDenyAskRule(fullCmdCandidates, denyRules);
  if (denyMatch) {
    return {
      kind: 'deny',
      extra: {
        denialReason: {
          message: `Command denied by ${denyMatch.source} rule: ${command}`,
          attribution: { type: 'rule', rule: denyMatch },
          denialKind: 'permission-rule',
          decisionPoint: 'shell.rule_prefix.deny',
        },
        decisionPoint: 'shell.rule_prefix.deny',
      },
    };
  }

  // Step 1b: Per-segment deny — check all executable segments with their
  // aggressively stripped candidates.
  for (const segCandidates of segmentCandidateSets) {
    const subDenyMatch = findMatchingDenyAskRule(segCandidates, denyRules);
    if (subDenyMatch) {
      return {
        kind: 'deny',
        extra: {
          denialReason: {
            message: `Command denied by ${subDenyMatch.source} rule: ${command}`,
            attribution: { type: 'rule', rule: subDenyMatch },
            denialKind: 'permission-rule',
            decisionPoint: 'shell.rule_segment.deny',
          },
          decisionPoint: 'shell.rule_segment.deny',
        },
      };
    }
  }

  // Step 1c: Catastrophic removal. Judged before any ask rule so that its
  // attribution — the one thing that keeps the prompt alive under Yolo and
  // out of reach of allow rules — is not replaced by a rule ask. Deny rules
  // above still win.
  const removal = checkDangerousRemoval(command, analysis, {
    executionCwd,
    permissionCwd,
    additionalDirectories: context.additionalDirectories,
  });
  if (removal) return removal;

  // Step 2: Content-level ask rules — same aggressive matching as deny.
  const askMatch = findMatchingDenyAskRule(fullCmdCandidates, askRules);
  if (askMatch) {
    return {
      kind: 'ask',
      reason: {
        message: `Command requires confirmation per ${askMatch.source} rule: ${command}`,
        attribution: { type: 'rule', rule: askMatch },
        decisionPoint: 'shell.rule_prefix.ask',
      },
      suggestions: suggestionForExactCommand(toolName, command),
    };
  }

  // Step 2b: Per-segment ask.
  for (const segCandidates of segmentCandidateSets) {
    const subAskMatch = findMatchingDenyAskRule(segCandidates, askRules);
    if (subAskMatch) {
      return {
        kind: 'ask',
        reason: {
          message: `Command requires confirmation per ${subAskMatch.source} rule: ${command}`,
          attribution: { type: 'rule', rule: subAskMatch },
          decisionPoint: 'shell.rule_segment.ask',
        },
        suggestions: suggestionForExactCommand(toolName, command),
      };
    }
  }

  // SECURITY: Cold-start safety fallback.
  // Nested execution + missing parser segments means deny/ask rules weren't
  // checked against inner commands. Force bypass-immune ask to prevent
  // tool-level allow from silently consuming passthrough or exact allow.
  if (
    analysis.features.hasNestedExecution &&
    !analysis.hasParserSegments &&
    denyRules.length + askRules.length > 0
  ) {
    return {
      kind: 'ask',
      reason: {
        message: `Command contains nested execution that could not be fully analyzed for deny/ask rules: ${command}`,
        attribution: {
          type: 'safetyCheck',
          reason:
            'Parser unavailable during cold start; nested commands not checked against deny/ask rules',
          classifierApprovable: false,
        },
        decisionPoint: 'shell.nested_execution.ask',
      },
      suggestions: suggestionForExactCommand(toolName, command),
    };
  }

  // Step 3: Content-level allow rules.
  // Exact allow is checked first as an escape hatch from blocksBroadAllow
  // (e.g., allowing `echo $(date)` with an exact rule), but it comes AFTER
  // all deny/ask checks and the cold-start safety fallback.
  const allowRules = collectContentRulesForTool(context, toolName, 'allow');
  const exactAllow = findExactMatchRule(command, allowRules);
  if (exactAllow) {
    const override = dangerousCommandOverride(command, toolName, analysis);
    if (override) return override;
    return {
      kind: 'allow',
      extra: { decisionPoint: 'shell.rule_exact.allow' },
    };
  }

  // Step 3b: Prefix/wildcard allow — must NOT match when blocksBroadAllow is
  // true (compound commands, command substitution, process substitution,
  // eval-like builtins, etc.)
  // strippedCommand is only needed for the allow path.
  const strippedCommand = stripSafeWrappers(command);
  // Allow-widening variant: `xargs grep foo` -> `grep foo` (xargs only; see
  // ALLOW_WIDENING_WRAPPERS). Matched against prefix/wildcard rules only.
  const allowWrapperStripped = stripWrapperHead(
    command,
    ALLOW_WIDENING_WRAPPERS,
  );
  const allowMatch = findMatchingContentRule(
    command,
    allowRules,
    analysis.blocksBroadAllow,
    strippedCommand,
    allowWrapperStripped,
  );
  if (allowMatch) {
    const override = dangerousCommandOverride(command, toolName, analysis);
    if (override) return override;

    return {
      kind: 'allow',
      extra: { decisionPoint: 'shell.rule_prefix.allow' },
    };
  }

  // Step 3c: Per-subcommand allow — ALL top-level segments must be
  // independently allowed. Uses topLevelSegments (not executableSegments)
  // to ensure nested command substitutions like $(rm -rf /) are not
  // extracted as separate allow candidates.
  if (analysis.blocksBroadAllow && hasMultipleTopLevel) {
    let allAllowed = true;
    const subResults = new Map<string, ToolPermissionResult>();

    for (const sub of topLevelSubs) {
      const strippedSub = stripSafeWrappers(sub);
      // SECURITY: Each sub-segment may itself contain execution boundaries
      // (e.g., command substitution). Must check per-segment blocksBroadAllow
      // so that `echo $(rm -rf x) | grep foo` is not allowed by echo:* + grep:*.
      const subBlockCompound = scanShellShape(sub).blocksBroadAllow;
      const subWrapperStripped = stripWrapperHead(sub, ALLOW_WIDENING_WRAPPERS);
      const subAllowMatch = findMatchingContentRule(
        sub,
        allowRules,
        subBlockCompound,
        strippedSub,
        subWrapperStripped,
      );
      if (subAllowMatch) {
        subResults.set(sub, {
          kind: 'allow',
          extra: { decisionPoint: 'shell.subcommand_rule.allow' },
        });
      } else {
        allAllowed = false;
        break;
      }
    }

    if (allAllowed) {
      const override = dangerousCommandOverride(command, toolName, analysis);
      if (override) return override;

      return {
        kind: 'allow',
        extra: { decisionPoint: 'shell.subcommand_all.allow' },
      };
    }
  }

  // Step 4: Read-only command auto-allow.
  // Before falling through to passthrough, check if the command is provably
  // read-only. This runs AFTER all deny/ask/allow rules and dangerous command
  // checks, so explicit rules always take precedence.
  // Pass pre-computed analysis to avoid redundant shell-shape scanning.
  const readOnlyDecision = checkReadOnlyShellCommand(
    command,
    analysis,
    readOnlyContext,
  );
  if (readOnlyDecision.readonly) {
    // Final safety net: check dangerous command override even for read-only
    const override = dangerousCommandOverride(command, toolName, analysis);
    if (override) return override;

    // Path constraints: if cwd is provided, verify all read paths are within
    // allowed working directories. This prevents auto-allowing commands that
    // read sensitive files outside the workspace (e.g., cat ~/.ssh/id_rsa).
    if (permissionCwd && executionCwd) {
      const segments = readOnlyDecision.segments;
      let allPathsAllowed = true;
      let denyDecision:
        | Extract<ToolPermissionResult, { kind: 'deny' }>
        | undefined;
      let askDecision:
        | Extract<ToolPermissionResult, { kind: 'ask' }>
        | undefined;

      // Must check ALL segments (not short-circuit) to find the strictest behavior
      for (const segment of segments) {
        const trimmed = segment.trim();
        if (!trimmed) continue;
        const r = checkReadOnlyShellPathConstraints(
          trimmed,
          context,
          executionCwd,
          permissionCwd,
        );
        if (r.allowed === false) {
          allPathsAllowed = false;
          if (r.decision?.kind === 'deny') {
            denyDecision ??= r.decision;
          } else if (r.decision?.kind === 'ask') {
            askDecision ??= r.decision;
          } else if (r.behavior === 'deny') {
            denyDecision ??= {
              kind: 'deny',
              extra: {
                denialReason: {
                  message: r.reason,
                  attribution: {
                    type: 'other',
                    reason: 'Path constraint: read target denied',
                  },
                  denialKind: 'permission-rule',
                  decisionPoint: 'shell.readonly_path.deny',
                },
                decisionPoint: 'shell.readonly_path.deny',
              },
            };
          }
        }
      }

      if (allPathsAllowed) {
        return {
          kind: 'allow',
          extra: { decisionPoint: 'shell.readonly.allow' },
        };
      }
      // Path constraint failed — honor deny if any segment targeted a denied path
      if (denyDecision) {
        // The decision may come from the path check itself, which names its own
        // point; only unnamed ones are attributed here.
        return {
          ...denyDecision,
          extra: {
            ...denyDecision.extra,
            decisionPoint:
              denyDecision.extra?.decisionPoint ?? 'shell.readonly_path.deny',
          },
        };
      }
      if (askDecision) {
        const suggestions = [
          ...suggestionForExactCommand(toolName, command),
          ...(askDecision.suggestions ?? []),
        ];
        // A workingDir attribution says "outside the working directory", which is
        // the reason this step is asking at all — keep the shell-level framing.
        const keepAttribution =
          askDecision.reason.attribution.type !== 'workingDir';
        return {
          ...askDecision,
          reason: {
            ...askDecision.reason,
            message:
              askDecision.reason.message ||
              `Read-only command reads a path that requires confirmation: ${command}`,
            attribution: keepAttribution
              ? askDecision.reason.attribution
              : {
                  type: 'other',
                  reason: 'Read-only command reads outside the workspace',
                },
            decisionPoint:
              askDecision.reason.decisionPoint ?? 'shell.readonly_path.ask',
          },
          suggestions,
        };
      }
      // Ambiguous path extraction failures fall through to the normal Bash prompt.
      return {
        kind: 'ask',
        reason: {
          message: `Read-only command reads paths outside workspace: ${command}`,
          attribution: {
            type: 'other',
            reason: 'Read-only command path extraction was ambiguous',
          },
          decisionPoint: 'shell.readonly_outside_workspace.ask',
        },
        suggestions: suggestionForExactCommand(toolName, command),
      };
    } else {
      // No cwd provided — allow without path constraints (backward compat)
      return {
        kind: 'allow',
        extra: { decisionPoint: 'shell.readonly_no_cwd.allow' },
      };
    }
  }

  // Step 4.5: Shell output redirection writes a file, so permission must be
  // checked against the write-path domain before falling back to a plain Bash
  // prompt.
  if (permissionCwd && executionCwd) {
    const writeTargets = findOutputWriteTargets(command, executionCwd);
    if (writeTargets === null) {
      // Same hole as the no-match fallback: an 'other' ask is endorsable, so a
      // dangerous command must leave as a safety objection instead.
      const override = dangerousCommandOverride(command, toolName, analysis);
      if (override) return override;
      return {
        kind: 'ask',
        reason: {
          message: `Allow ${toolName} to run: ${command}?`,
          attribution: {
            type: 'other',
            reason: 'Shell redirection targets could not be determined',
          },
          decisionPoint: 'shell.write_target_unknown.ask',
        },
        extra: { fillableByAllow: true },
        suggestions: suggestionForExactCommand(toolName, command),
      };
    }

    let denyDecision:
      | Extract<ToolPermissionResult, { kind: 'deny' }>
      | undefined;
    let askDecision: Extract<ToolPermissionResult, { kind: 'ask' }> | undefined;

    for (const target of writeTargets) {
      const decision = checkWritePermissionForPath(
        target.path,
        context,
        permissionCwd,
      );
      if (decision.kind === 'deny') {
        denyDecision ??= decision;
      } else if (decision.kind === 'ask') {
        askDecision ??= {
          ...decision,
          reason: {
            ...decision.reason,
            blockedPath: decision.reason.blockedPath ?? target.path,
          },
        };
      }
    }

    if (denyDecision) {
      return {
        ...denyDecision,
        extra: {
          ...denyDecision.extra,
          decisionPoint:
            denyDecision.extra?.decisionPoint ?? 'shell.write_path.deny',
        },
      };
    }

    if (askDecision) {
      return {
        ...askDecision,
        reason: {
          ...askDecision.reason,
          message:
            askDecision.reason.message ||
            `Shell command writes to a path that requires confirmation: ${command}`,
          decisionPoint:
            askDecision.reason.decisionPoint ?? 'shell.write_path.ask',
        },
        suggestions: suggestionsForShellOutputWrite(
          toolName,
          command,
          analysis.blocksBroadAllow,
          writeTargets,
          askDecision.suggestions,
        ),
      };
    }
  }

  // Step 5: Nothing matched — ask, offering the narrowest rule that would cover
  // this command next time. A dangerous command must not ride a tool-level
  // allow endorsement out of this fallback: the override makes the ask a safety
  // objection, so the prompt always happens (the old outer guard did this for
  // recorded allows).
  const fallbackOverride = dangerousCommandOverride(
    command,
    toolName,
    analysis,
  );
  if (fallbackOverride) return fallbackOverride;

  let suggestions;
  if (analysis.blocksBroadAllow) {
    // Commands with execution boundaries: only suggest exact match.
    suggestions = suggestionForExactCommand(toolName, command);
  } else {
    // Single commands: prefer prefix rule (broader, covers future invocations
    // with same root), fall back to exact command if no prefix can be extracted.
    const twoWordPrefix = getSimpleCommandPrefix(command);
    if (twoWordPrefix) {
      suggestions = suggestionForPrefix(toolName, twoWordPrefix);
    } else {
      const oneWordPrefix = getFirstWordPrefix(command);
      if (oneWordPrefix) {
        suggestions = suggestionForPrefix(toolName, oneWordPrefix);
      } else {
        suggestions = suggestionForExactCommand(toolName, command);
      }
    }
  }

  return {
    kind: 'ask',
    reason: {
      message: `Allow ${toolName} to run: ${command}?`,
      attribution: { type: 'other', reason: 'No rule covers this command' },
      decisionPoint: 'shell.no_match.ask',
    },
    extra: { fillableByAllow: true },
    suggestions,
  };
}
