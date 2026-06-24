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
 * classifier failures.
 *
 * Only applies in AUTO mode — YOLO mode is an explicit opt-out of all guards.
 */

import type { Content, Part } from '@google/genai';
import { execSync } from 'node:child_process';

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
 * `git commit --amend` is blocked unless the target commit was made by the
 * agent in this session. Session tracking is managed externally via
 * {@link registerSessionCommit} and {@link isAmendOfSessionCommit}.
 */
const GIT_AMEND_PATTERN = /\bgit\s+commit\s+--amend\b/;

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
 * Register a commit SHA made by the agent during this session.
 * Used to allow `git commit --amend` when the target commit was made
 * by the agent in the current session.
 */
export function registerSessionCommit(sha: string): void {
  sessionCommitShas.add(sha.trim());
}

/**
 * Check whether a `git commit --amend` targets a commit made this session.
 * Reads the current HEAD commit SHA and checks against registered session commits.
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
 */
export function clearSessionCommits(): void {
  sessionCommitShas.clear();
}

// ─── Main guard function ──────────────────────────────────────────────────

/**
 * Check whether a shell command is destructively blocked by the deterministic
 * guard. Runs before the L5.3 classifier — failures here are hard blocks
 * regardless of classifier availability.
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
      const matched = command.match(pattern)?.[0] ?? command;
      return {
        blocked: true,
        reason: `Blocked destructive git command: "${matched}". To proceed, explicitly mention discarding local work in your prompt.`,
      };
    }
  }

  if (GIT_AMEND_PATTERN.test(expanded) && !isAmendOfSessionCommit(cwd)) {
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
