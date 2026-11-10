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
 * provides deterministic blocking (patterns plus a lexical `git commit
 * --amend` guard) that cannot be bypassed by
 * classifier failures on the denying call itself: the block is hard until
 * denial tracking reaches the consecutive-block or session-total cap, at which
 * point `applyAutoModeDecision` escalates to a confirmation only a human can
 * give — it marks the escalation `requiresHumanDecision`, so a
 * `PermissionRequest` hook returning `allow` cannot waive it.
 *
 * Only applies in AUTO mode — YOLO mode is an explicit opt-out of all guards.
 */

import type { Content, Part } from '@google/genai';
import { execSync } from 'node:child_process';

import { shellWords } from './shell-semantics.js';

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

const GIT_AMEND_MENTION =
  /\bgit(?:\.exe)?\s+commit\s+--am(?:e(?:n(?:d)?)?)?\b/i;

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
 * Strip one layer of shell quoting from a command string so destructive
 * patterns inside `bash -c "git reset --hard"` or `sh -c 'git clean -fd'`
 * are still detected.
 */
function stripShellQuotes(command: string): string {
  return command.replace(
    /(?:^|\s)(?:bash|sh|zsh|fish|dash|ksh)\s+-[a-zA-Z]*c\s+(?:"([^"]*)"|'([^']*)')/g,
    (_match, dq: string | undefined, sq: string | undefined) =>
      ' ' + (dq ?? sq ?? ''),
  );
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
 *
 * @deprecated The amend guard no longer reads the session-commit registry:
 * every `git commit --amend` mention now requires manual approval, because the
 * cwd-based exemption could not be bounded (R14-1/R23-2). The registry and its
 * shell/config wiring stay for API compatibility — `registerSessionCommit` is
 * a published export of this package — and removing them needs its own
 * follow-up.
 */
export function registerSessionCommit(sha: string): void {
  sessionCommitShas.add(sha.trim());
}

/**
 * Whether a text-recognisable `git commit --amend` mention must go to manual
 * approval.
 *
 * Always `true` for such a mention. Three kinds of call are structurally
 * invisible to a text guard and stay outside this contract: an encoded
 * assembly (`eval $(echo … | base64 -d)`) where neither `git` nor `commit`
 * appears, a git alias (`.gitconfig` `am = commit --amend`) invoked as
 * `git am`, and a renamed/wrapped binary or Makefile target. The guard cannot
 * prove that a mention inside shell text is
 * data rather than a program — hand-scanning shell syntax to prove inertness
 * was tried for seven rounds without converging (issue #13570) — and the
 * exemption for a commit this session created produced two leaks in a row
 * (R14-1, R23-2): it resolved the target from the decision-time `cwd`, which
 * wrappers (`env --chdir`, `sudo -D`) and same-repository history moves
 * (`git checkout HEAD~1 && git commit --amend`) can disagree with, and that
 * class of wrapper is not enumerable. So an amend is always an approval, and
 * the `cwd` parameter is gone with the exemption.
 *
 * This confirmation is human-only: AUTO mode marks the fallback
 * `requiresHumanDecision` and attaches a `message`, so the scheduler records
 * an `autoModeFallback` and hides "always allow"; a `PermissionRequest` hook
 * (or a stream-json host) answering `allow` cannot waive it. That is
 * deliberate — the guard exists to stop an unattended rewrite of a commit the
 * agent did not make, and a hook that could auto-allow it would restore
 * exactly the bypass the guard is for.
 */
export function amendNeedsApproval(command: string): boolean {
  return GIT_AMEND_MENTION.test(command) || mentionsGitCommitAmend(command);
}

function mentionsGitCommitAmend(command: string): boolean {
  let seenGit = false;
  let inCommit = false;
  // Rule 3 (R25-2): a `$` that can change the command's *structure* keeps the
  // mention unprovable. Only two positions qualify: before the first `commit`
  // word (program/subcommand/flag assembly), and a flag built from an
  // expansion (handled by `isUnprovableFlag`). A `$` in an ordinary argument
  // value — `-m "$msg"`, `-m "$(cat msg)"` — does not change what the guard
  // reads and must not ask.
  let dollarBeforeCommit = false;
  // `${IFS}`/`$IFS` expand to whitespace at run time, so a command that
  // assembles `git`, `commit` and `--amend` this way cannot be read from the
  // text; treat the expansion as whitespace so the words are seen (R25-2).
  for (const token of shellWords(command)) {
    const expanded = token.replace(/\$(?:\{IFS\}|IFS)/g, ' ');
    // A redirect glued to a word still splits it in bash (`git>|/dev/null`),
    // so split it here too before deciding what the word is (R25-2).
    for (const piece of expanded.split(/[<>|]/)) {
      for (const word of piece.split(/\s+/).filter(Boolean)) {
        const bare = bareShellWord(word);
        if (!bare) continue;
        if (inCommit) {
          if (isAmendFlag(bare)) return true;
          // A flag assembled by an expansion cannot be proven inert; ask.
          // The escalation stays gated on a seen `git` + `commit` prefix.
          if (isUnprovableFlag(bare)) return true;
        } else if (bare.includes('$')) {
          dollarBeforeCommit = true;
        }
        if (isGitWord(bare)) seenGit = true;
        else if (seenGit && bare === 'commit') inCommit = true;
      }
    }
  }
  return dollarBeforeCommit;
}

/** A word that expands at run time and starts like a flag (R25-2). */
function isUnprovableFlag(word: string): boolean {
  return /^-{1,2}/.test(word) && /[$`{]/.test(word);
}

function bareShellWord(word: string): string {
  return word
    .replace(/[^\w.-]+$/, '')
    .replace(/^(?:\$\(|[<(]\(|`)+/, '')
    .replace(/^[A-Za-z_]\w*\+?=/, '');
}

function isGitWord(word: string): boolean {
  const base = word.slice(word.lastIndexOf('/') + 1).toLowerCase();
  return base === 'git' || base === 'git.exe';
}

/**
 * `--amend` or a git-accepted unambiguous abbreviation of it. The prefix floor
 * is four characters (`--am`) because git resolves that prefix uniquely for
 * `commit`; `--a` is excluded because it is ambiguous with `--all`/`--author`.
 * A `--amend=…` spelling is read as its flag name.
 */
function isAmendFlag(word: string): boolean {
  const flag = word.split('=', 1)[0]!;
  return (
    flag.startsWith('--') && flag.length >= 4 && '--amend'.startsWith(flag)
  );
}

/**
 * Check whether a `git commit --amend` targets a commit made this session.
 *
 * @deprecated No longer consulted: `amendNeedsApproval` always asks for
 * approval (R23-2). Kept as a published export for API compatibility, together
 * with the registry it reads; removal is a separate follow-up.
 */
export function isAmendOfSessionCommit(cwd: string): boolean {
  if (sessionCommitShas.size === 0) return false;
  try {
    const headSha = execSync('git rev-parse HEAD', {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return sessionCommitShas.has(headSha);
  } catch {
    return false;
  }
}

/**
 * Clear all session commit tracking. Called on session end or mode switch.
 * Also bumps the generation counter, which is how a deferred writer
 * learns that the registry it decided against no longer exists.
 *
 * @deprecated The amend guard no longer reads this registry (R23-2: every
 * amend asks for approval), but this is a published export of
 * `@qwen-code/qwen-code-core` and its shell/config wiring stays. Removing it
 * needs a separate follow-up.
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
 * @returns Block result if the command is destructive, null otherwise
 */
export function isDestructiveCommand(
  command: string,
  userPrompt: string,
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

  return null;
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
