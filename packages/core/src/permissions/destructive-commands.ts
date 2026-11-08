/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Deterministic pre-filter for destructive git and IaC commands in AUTO mode.
 *
 * Runs BEFORE the L5.3 LLM classifier as a Layer 0 guard. The classifier is
 * non-deterministic and can fail due to API unavailability, timeout, or poor
 * judgment on ambiguous prompts like "clean up the git state". This module
 * provides deterministic regex-based blocking that cannot be bypassed by
 * classifier failures on the denying call itself: the block is hard until
 * denial tracking reaches the consecutive-block or session-total cap, at which
 * point `applyAutoModeDecision` escalates to a confirmation only a human can
 * give — it marks the escalation `requiresHumanDecision`, so a
 * `PermissionRequest` hook returning `allow` cannot waive it.
 *
 * Only applies in AUTO mode — YOLO mode is an explicit opt-out of all guards.
 */

import type { Content, Part } from '@google/genai';
import { execFileSync, execSync } from 'node:child_process';
import {
  amendSegmentRelocations,
  amendSegmentsForExemption,
  classifyGitAmend,
  stripShellQuotes,
  type AmendSegmentAnalysis,
} from './shell-semantics.js';

/**
 * Destructive git commands that discard local work.
 * These are blocked unless the user explicitly mentions discarding work.
 */
const DESTRUCTIVE_GIT_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+checkout\s+--\s+\./,
  /\bgit\s+clean\s+-[a-zA-Z]*f/,
  /\bgit\s+stash\s+drop\b/,
]);

/**
 * IaC destroy commands that tear down infrastructure.
 * Blocked unless the user explicitly mentions the target stack/resource.
 */
const IAC_DESTROY_PATTERNS: readonly RegExp[] = Object.freeze([
  /\bterraform\s+destroy\b/,
  /\bpulumi\s+destroy\b/,
  /\bcdk\s+destroy\b/,
]);

/**
 * Keywords in the user prompt that indicate intentional discarding of work.
 * Case-insensitive matching.
 */
const DISCARD_KEYWORDS: readonly RegExp[] = Object.freeze([
  /\bdiscard\b/i,
  /\bthrow\s+away\b/i,
  /\bwipe\b/i,
  /\bclean\s+up\b/i,
  /\breset\s+everything\b/i,
  /\bdrop\s+all\b/i,
  /\bforce\s+reset\b/i,
  /\bstart\s+over\b/i,
  /\bstart\s+fresh\b/i,
  /\bclean\s+slate\b/i,
  /丢弃/,
  /清除/,
  /重置/,
]);

/**
 * Check if the user prompt explicitly mentions discarding local work.
 */
export function userMentionsDiscard(userPrompt: string): boolean {
  return DISCARD_KEYWORDS.some((kw) => kw.test(userPrompt));
}

/**
 * Extract the last user-role text from the conversation messages.
 * Used to determine whether the user explicitly requested destructive actions.
 */
export function extractLastUserPrompt(
  messages: readonly Content[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== 'user') continue;
    const texts = (msg.parts ?? [])
      .filter((p): p is Part => typeof (p as Part).text === 'string')
      .map((p) => (p as Part).text!);
    if (texts.length > 0) return texts.join(' ');
  }
  return undefined;
}

/** Result of a destructive command check. */
export interface DestructiveCommandResult {
  blocked: boolean;
  /**
   * Third outcome (#16075 maintainer stopgap, round-15 assessment): route the
   * command to the normal approval prompt instead of hard-denying it or
   * silently allowing it. Set when the guard recognises amend text but cannot
   * positively identify a dangerous amend — inert-unprovable mentions and
   * amends whose target commit cannot be attributed. Hard denial stays
   * reserved for positively identified dangerous amends. Never set together
   * with `blocked: true`.
   */
  ask?: boolean;
  reason: string;
}

// ─── Session commit tracking (for git commit --amend) ─────────────────────

const sessionCommitShas = new Set<string>();

/**
 * Bumped by every `clearSessionCommits()` so a writer that decided to
 * register *before* a clear can tell that the registry it is about to
 * write into is not the one it decided against.
 *
 * The deferred writer this exists for is the Ctrl+B promote path in
 * `shell.ts`: it registers when the backgrounded child exits,
 * arbitrarily later than the promote, and an approval-mode transition
 * in between clears the registry on purpose (`Config.setApprovalMode`,
 * whose stated contract is that exemptions must not carry across that
 * boundary). Without a generation check the settle writes the exemption
 * straight back.
 *
 * Deliberately not `Config.getApprovalModeRevision()`: that counter
 * moves on every mode change, including the AUTO → PLAN → AUTO
 * excursion `clearSessionCommits()` is explicitly gated off, so it
 * would drop registrations the clear never touched.
 */
let sessionCommitGeneration = 0;

/** The registry generation counter; see `sessionCommitGeneration`. */
export function getSessionCommitGeneration(): number {
  return sessionCommitGeneration;
}

/**
 * Register a commit SHA made by the agent during this session.
 * Used to allow `git commit --amend` when the target commit was made
 * by the agent in the current session.
 */
export function registerSessionCommit(sha: string): void {
  sessionCommitShas.add(sha.trim());
}

/**
 * Which repository a recognised amend actually targets (#16075 R9, B2).
 * `null` means the command relocates the repository in a way this guard
 * cannot statically resolve — the session exemption must then fail closed.
 */
interface AmendTarget {
  /** Directory to run `git rev-parse HEAD` in. */
  cwd: string;
  /** Explicit git directory, when the command names one. */
  gitDir?: string;
}

/**
 * A static literal absolute path: no quotes, spaces, variables, tildes, or
 * shell metacharacters. Anything else cannot be resolved without running
 * shell expansion, which this guard must not do.
 */
const STATIC_ABSOLUTE_PATH = /^\/[A-Za-z0-9._/-]+$/;

/**
 * Resolve the repository an amend targets. Relocations are read ONLY from
 * the compound segment that carries the amend, quote-aware: a `-C` inside a
 * commit message, in an adjacent segment, or in a heredoc body is not a
 * relocation, and a `-C` after the `commit` subcommand is git-commit's own
 * reuse-message option. `cd`/`pushd` segments shift the cwd the amend runs
 * under; subshells and dynamic cd targets fail closed (#16075 review, R7-2
 * fix-induced).
 *
 * Deliberately narrow: exactly one relocation flag, with a static literal
 * absolute path. Stacked or mixed flags (`-C a -C b`, `--git-dir` plus
 * `--work-tree`), relative paths, and non-literal values all refuse the
 * exemption rather than guess which HEAD gets amended. Commands without
 * relocations keep the historical cwd-only answer.
 */
function resolveAmendTarget(
  cwd: string,
  analysis: Extract<AmendSegmentAnalysis, { kind: 'segments' }>,
): AmendTarget | null {
  let target: AmendTarget;
  if (analysis.segments.length === 0) {
    // The amend lives in a carrier the exemption walk does not attribute
    // (su -c, env -S, xargs, find -exec, a process substitution, …). Its
    // repository cannot be resolved to a registered HEAD, so the exemption
    // fails closed rather than guess (#16075 review, R7-2).
    return null;
  } else {
    const perSegment = analysis.segments.map(
      ({ segment, cwd: segCwd, inherited }) => ({
        // A carrier's prefix relocation (`GIT_DIR=B/.git bash -c '…'`) applies
        // to the inner amend exactly as if it were spelled there; merge it with
        // the segment's own relocations before the exactly-one rule (#16075
        // review, R7-2).
        relocations: [
          ...(inherited ?? []),
          ...amendSegmentRelocations(segment),
        ],
        cwd: segCwd,
      }),
    );
    const relocated = perSegment.filter((s) => s.relocations.length > 0);
    if (relocated.length === 0) {
      // Plain amends: every one must run under the same cwd.
      if (new Set(perSegment.map((s) => s.cwd)).size !== 1) return null;
      target = { cwd: perSegment[0]!.cwd };
    } else if (
      perSegment.length === 1 &&
      relocated[0]!.relocations.length === 1
    ) {
      const { flag, value } = relocated[0]!.relocations[0]!;
      if (!STATIC_ABSOLUTE_PATH.test(value)) return null;
      if (flag === '-C') target = { cwd: value };
      else if (flag === '--git-dir') target = { cwd, gitDir: value };
      // --work-tree moves the checkout, not HEAD: the amended repository is
      // still the one discovered from the segment's cwd, which a leading
      // `cd` may have moved (#16075 R11-1).
      else target = { cwd: perSegment[0]!.cwd };
    } else {
      // Several amending segments, or stacked relocations: ambiguous.
      return null;
    }
  }
  return target;
}

/**
 * Three-way session-exemption outcome for a recognised amend invocation
 * (#16075 maintainer stopgap, round-15 assessment):
 *  - `exempt`: the target HEAD is a registered session commit.
 *  - `foreign`: positively identified dangerous amend — no session commits
 *    exist, the resolved target HEAD is not registered, or a preceding
 *    segment positively moves HEAD so the amend rewrites an unregistered
 *    commit. Hard denial.
 *  - `unattributable`: an amend invocation whose target repository/commit the
 *    walk cannot prove. Approval, not denial — never a silent allow.
 */
type AmendExemptionOutcome = 'exempt' | 'foreign' | 'unattributable';

function amendExemptionOutcome(
  cwd: string,
  command: string | undefined,
): AmendExemptionOutcome {
  if (sessionCommitShas.size === 0) return 'foreign';
  let target: AmendTarget | null;
  if (command === undefined) {
    target = { cwd };
  } else {
    const analysis = amendSegmentsForExemption(command, cwd);
    if (analysis.kind === 'untrackable') {
      return analysis.headMayMove === true ? 'foreign' : 'unattributable';
    }
    target = resolveAmendTarget(cwd, analysis);
  }
  if (target === null) return 'unattributable';
  try {
    const headSha =
      target.gitDir !== undefined
        ? execFileSync(
            'git',
            ['--git-dir', target.gitDir, 'rev-parse', 'HEAD'],
            {
              cwd: target.cwd,
              encoding: 'utf-8',
              timeout: 5000,
              stdio: ['ignore', 'pipe', 'ignore'],
            },
          ).trim()
        : execSync('git rev-parse HEAD', {
            cwd: target.cwd,
            encoding: 'utf-8',
            timeout: 5000,
            stdio: ['ignore', 'pipe', 'ignore'],
          }).trim();
    return sessionCommitShas.has(headSha) ? 'exempt' : 'foreign';
  } catch {
    // HEAD cannot be read: no proof the target is a session commit. Keep the
    // historical fail-closed answer for this positively-unresolvable case.
    return 'foreign';
  }
}

/**
 * Check whether a `git commit --amend` targets a commit made this session.
 * Reads the current HEAD commit SHA of the repository the command actually
 * targets and checks against registered session commits. Without a command,
 * or with no repo-relocation flags, that is `cwd`'s HEAD exactly as before;
 * a relocation this guard cannot resolve statically refuses the exemption
 * (#16075 R9, B2).
 */
export function isAmendOfSessionCommit(cwd: string, command?: string): boolean {
  return amendExemptionOutcome(cwd, command) === 'exempt';
}

/**
 * Clear all session commit tracking. Called on session end or mode switch.
 * Also bumps the generation counter, which is how a deferred writer
 * learns that the registry it decided against no longer exists.
 */
export function clearSessionCommits(): void {
  sessionCommitShas.clear();
  sessionCommitGeneration++;
}

// ─── Main guard function ──────────────────────────────────────────────────

/**
 * Check whether a shell command is destructively blocked by the deterministic
 * guard. Runs before the L5.3 classifier — failures here are hard blocks
 * regardless of classifier availability, until denial tracking reaches the
 * consecutive-block or session-total cap; at a cap `applyAutoModeDecision`
 * escalates to a human-only confirmation instead (`requiresHumanDecision`).
 *
 * @param command - The raw shell command string
 * @param userPrompt - The user's most recent prompt text
 * @param cwd - Working directory for git operations (amend check)
 * @returns Block result if the command is positively destructive, an `ask`
 *   result if it must go to manual approval, null otherwise
 */
export function isDestructiveCommand(
  command: string,
  userPrompt: string,
  cwd: string = process.cwd(),
): DestructiveCommandResult | null {
  try {
    return isDestructiveCommandUnchecked(command, userPrompt, cwd);
  } catch {
    // A permission guard must never crash on command data: R15-3 witnessed
    // an IFS value spliced into a regex throwing SyntaxError out of the
    // evaluation. Whatever the cause, fail to manual approval — never to a
    // silent allow (#16075 maintainer stopgap).
    return {
      blocked: false,
      ask: true,
      reason:
        'The destructive-command guard could not evaluate this command safely. Routed to manual approval (issue #13570).',
    };
  }
}

function isDestructiveCommandUnchecked(
  command: string,
  userPrompt: string,
  cwd: string,
): DestructiveCommandResult | null {
  const expanded = command + ' ' + stripShellQuotes(command);

  for (const pattern of DESTRUCTIVE_GIT_PATTERNS) {
    if (pattern.test(expanded) && !userMentionsDiscard(userPrompt)) {
      // `git clean -[a-zA-Z]*f` matches an unbounded run, and the fallback is
      // the whole model-authored command. Bound the echoed fragment: the reason
      // is clamped to 200 chars at the permission boundary, and a longer match
      // would push this template's own recovery instruction past the clamp.
      const match = command.match(pattern)?.[0] ?? command;
      const matched = match.length > 80 ? `${match.slice(0, 79)}…` : match;
      return {
        blocked: true,
        reason: `Blocked destructive git command: "${matched}". To proceed, explicitly mention discarding local work in your prompt.`,
      };
    }
  }

  // Amend guard (#16075 maintainer stopgap, round-15 assessment): hard denial
  // is reserved for positively identified dangerous amends. Text that merely
  // mentions the amend without a recognised invocation, and invocations whose
  // target commit cannot be attributed, route to the approval prompt instead
  // — issue #13570 accepts "allowed, or at worst an approval prompt".
  // The ask is held, not returned: a command that also matches the IaC
  // destroy floor below must stay hard-blocked, so only a positive block
  // returns early (R16-3). The ask is returned after the IaC loop finds no
  // match.
  let amendAsk: DestructiveCommandResult | null = null;
  const recognition = classifyGitAmend(command);
  if (recognition === 'unprovable-text') {
    amendAsk = {
      blocked: false,
      ask: true,
      reason:
        'This command mentions "git commit --amend" in text the guard cannot prove inert. Routed to manual approval instead of blocking (issue #13570).',
    };
  } else if (recognition === 'invocation') {
    const outcome = amendExemptionOutcome(cwd, command);
    if (outcome === 'foreign') {
      return {
        blocked: true,
        reason:
          'Blocked "git commit --amend": the target commit was not made by the agent in this session. To proceed, use manual approval.',
      };
    }
    if (outcome === 'unattributable') {
      amendAsk = {
        blocked: false,
        ask: true,
        reason:
          'This command invokes "git commit --amend" but the guard cannot prove which commit it rewrites. Routed to manual approval (issue #13570).',
      };
    }
  }

  for (const pattern of IAC_DESTROY_PATTERNS) {
    if (pattern.test(expanded)) {
      const toolName =
        command.match(pattern)?.[0]?.split(/\s+/)[0] ?? 'unknown';
      if (!userMentionsStack(userPrompt, toolName)) {
        return {
          blocked: true,
          reason: `Blocked infrastructure destroy command: "${toolName} destroy". To proceed, explicitly specify the target stack/resource in your prompt.`,
        };
      }
    }
  }

  return amendAsk;
}

function userMentionsStack(userPrompt: string, toolName: string): boolean {
  if (!userPrompt) return false;
  const lower = userPrompt.toLowerCase();
  return (
    lower.includes(toolName) &&
    (lower.includes('destroy') ||
      lower.includes('tear down') ||
      lower.includes('delete stack') ||
      lower.includes('remove stack') ||
      lower.includes('销毁') ||
      lower.includes('删除'))
  );
}
