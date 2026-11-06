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
  commandContainsGitAmend,
  stripShellQuotes,
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
 * Resolve the repository an amend targets from the raw command's
 * repo-relocation flags (`-C`, `--git-dir`, `--work-tree`, `GIT_DIR=`,
 * `GIT_WORK_TREE=`). Commands without those flags keep the historical
 * cwd-only answer, byte for byte.
 *
 * Deliberately narrow: exactly one relocation flag, with a static literal
 * absolute path. Stacked or mixed flags (`-C a -C b`, `--git-dir` plus
 * `--work-tree`), relative paths, and quoted-but-not-literal values all
 * refuse the exemption rather than guess which HEAD gets amended.
 */
function resolveAmendTarget(cwd: string, command: string): AmendTarget | null {
  const words = command.split(/\s+/);
  const relocations: Array<{ flag: string; value: string | undefined }> = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const next = words[i + 1];
    if (w === '-C') relocations.push({ flag: '-C', value: next });
    else if (w.startsWith('-C') && w.length > 2)
      relocations.push({ flag: '-C', value: w.slice(2) });
    else if (w === '--git-dir')
      relocations.push({ flag: '--git-dir', value: next });
    else if (w.startsWith('--git-dir='))
      relocations.push({ flag: '--git-dir', value: w.slice(10) });
    else if (w === '--work-tree')
      relocations.push({ flag: '--work-tree', value: next });
    else if (w.startsWith('--work-tree='))
      relocations.push({ flag: '--work-tree', value: w.slice(12) });
    else if (w.startsWith('GIT_DIR='))
      relocations.push({ flag: '--git-dir', value: w.slice(8) });
    else if (w.startsWith('GIT_WORK_TREE='))
      relocations.push({ flag: '--work-tree', value: w.slice(14) });
  }
  if (relocations.length === 0) return { cwd };
  if (relocations.length > 1) return null;
  const { flag, value } = relocations[0]!;
  if (value === undefined) return null;
  // One layer of single quotes around an otherwise literal path is still a
  // static literal; any other quoting is not.
  const unquoted =
    value.length >= 2 && value.startsWith("'") && value.endsWith("'")
      ? value.slice(1, -1)
      : value;
  if (!STATIC_ABSOLUTE_PATH.test(unquoted)) return null;
  if (flag === '-C') return { cwd: unquoted };
  if (flag === '--git-dir') return { cwd, gitDir: unquoted };
  // --work-tree moves the checkout, not HEAD: the amended repository is
  // still the one discovered from cwd.
  return { cwd };
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
  if (sessionCommitShas.size === 0) return false;
  const target =
    command === undefined ? { cwd } : resolveAmendTarget(cwd, command);
  if (target === null) return false;
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
    return sessionCommitShas.has(headSha);
  } catch {
    return false;
  }
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
 * @returns Block result if the command is destructive, null otherwise
 */
export function isDestructiveCommand(
  command: string,
  userPrompt: string,
  cwd: string = process.cwd(),
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

  if (
    commandContainsGitAmend(command) &&
    !isAmendOfSessionCommit(cwd, command)
  ) {
    return {
      blocked: true,
      reason:
        'Blocked "git commit --amend": the target commit was not made by the agent in this session. To proceed, use manual approval.',
    };
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
