/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Post-review cleanup for /review Step 9.
//   - Audit the PR for writes that bypassed `qwen review submit` (PR targets).
//   - Remove the temporary worktree at .qwen/tmp/review-pr-<n>.
//   - Delete the local branch ref qwen-review/pr-<n>.
//   - Remove any .qwen/tmp/qwen-review-<target>-* side files.
//
// The command is idempotent — missing files / branches are silent OK.

import type { CommandModule } from 'yargs';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { clearReviewWorktreeLease } from '../../services/review-worktree-lease.js';
import { currentUser, ghApiAll, setGhHost } from './lib/gh.js';
import { refExists, releaseWorktree } from './lib/git.js';
import {
  worktreePath,
  probeWorktreePath,
  reviewBranch,
  REVIEW_TMP_DIR,
  tmpPrefix,
} from './lib/paths.js';

interface CleanupArgs {
  target: string;
}

/** An issue comment, as listed by `GET /issues/{n}/comments`. */
export interface RawIssueComment {
  id: number;
  user?: { login: string } | null;
  created_at?: string;
  html_url?: string;
}

/**
 * Issue comments the current user posted inside the review window.
 *
 * `qwen review submit` is the ONLY sanctioned write in `/review`, and it
 * posts a *review* — never an issue comment. So any issue comment by the
 * reviewing account created after `sinceIso` is either a write that bypassed
 * the submit gate, or something the user posted by hand from another
 * terminal; the warning below names both readings and lets the human decide.
 * Zero overlap with sanctioned output means zero correlation bookkeeping.
 *
 * This is a tripwire, not a wall. The gate itself lives in `submit` (it
 * refuses unauthorised posts), but a model that stops *calling* submit walks
 * around it — dogfooded: after four context compressions a run hand-posted
 * its summary with `gh pr comment`, printed no completion line, and nothing
 * anywhere noticed. Prose bans are exactly what compression loses, so the
 * detection has to live in the deterministic layer that always runs.
 */
export function findUnsanctionedIssueComments(
  comments: RawIssueComment[],
  reviewer: string,
  sinceIso: string,
): RawIssueComment[] {
  const reviewerLc = reviewer.toLowerCase();
  return comments.filter(
    (c) =>
      (c.user?.login ?? '').toLowerCase() === reviewerLc &&
      typeof c.created_at === 'string' &&
      c.created_at >= sinceIso,
  );
}

/**
 * Fields the audit needs from the fetch report. The report is the carrier
 * (not the worktree lease) because it is written on every PR run — the lease
 * only exists when the session env vars are set.
 */
interface AuditWindow {
  prNumber: string;
  ownerRepo: string;
  fetchedAt: string;
  host: string | null;
}

function readAuditWindow(target: string): AuditWindow | null {
  try {
    const raw = readFileSync(
      join(REVIEW_TMP_DIR, `${tmpPrefix(target)}fetch.json`),
      'utf8',
    );
    const report = JSON.parse(raw) as Partial<AuditWindow>;
    if (
      typeof report.prNumber !== 'string' ||
      typeof report.ownerRepo !== 'string' ||
      typeof report.fetchedAt !== 'string'
    ) {
      return null; // a report from before fetchedAt existed — nothing to audit
    }
    return {
      prNumber: report.prNumber,
      ownerRepo: report.ownerRepo,
      fetchedAt: report.fetchedAt,
      host: typeof report.host === 'string' ? report.host : null,
    };
  } catch {
    return null;
  }
}

/**
 * Best-effort by design: cleanup must stay idempotent and offline-safe, so
 * any failure here (no gh, no auth, no network, report missing) skips the
 * audit silently rather than failing the cleanup or nagging every offline
 * run. A skipped audit is the pre-existing state of the world, not an error.
 */
function auditPrWrites(target: string): void {
  try {
    const window = readAuditWindow(target);
    if (!window) return;
    setGhHost(window.host ?? undefined);
    const comments = ghApiAll(
      `repos/${window.ownerRepo}/issues/${window.prNumber}/comments?since=${encodeURIComponent(window.fetchedAt)}&per_page=100`,
    ) as RawIssueComment[];
    const suspects = findUnsanctionedIssueComments(
      comments,
      currentUser(),
      window.fetchedAt,
    );
    if (suspects.length === 0) return;
    writeStdoutLine(
      `warning: ${suspects.length} issue comment(s) by the reviewing account were posted to ` +
        `${window.ownerRepo}#${window.prNumber} during this review window. ` +
        `The only sanctioned write in /review is \`qwen review submit\`, and it never posts issue comments:`,
    );
    for (const c of suspects) {
      writeStdoutLine(
        `warning:   comment ${c.id} at ${c.created_at}${c.html_url ? ` — ${c.html_url}` : ''}`,
      );
    }
    writeStdoutLine(
      `warning: if the user posted these themselves, ignore this; otherwise a write bypassed the ` +
        `submit gate — relay this warning verbatim in the terminal summary.`,
    );
  } catch {
    /* audit is best-effort — see the doc comment above */
  }
}

export function runCleanup(target: string): void {
  let removedAny = false;
  // Tracked separately from `removedAny`, because a failure is neither. Without
  // it, a run that could not delete something goes on to announce "Nothing to
  // clean" on stdout while stderr says it failed to remove a thing that is very
  // much still there — the two streams contradicting each other, and the stdout
  // half being the one a script reads.
  let failedAny = false;

  // --- Worktree + branch (only for PR targets) -------------------------
  const prMatch = /^pr-(\d+)$/.exec(target);
  if (prMatch) {
    const prNumber = prMatch[1];

    // Before the sweep below deletes the fetch report (the audit window's
    // carrier), check the PR for writes that bypassed `qwen review submit`.
    auditPrWrites(target);

    // Report what actually happened, in both directions. Announcing "Removed …"
    // off a path that is still on disk is a lie; saying nothing at all when we
    // could not remove it leaves a leftover that will wedge the next run's
    // `git worktree add` with nobody told why. Both have been shipped here.
    const report = (label: string, path: string) => {
      const { existed, freed, reason } = releaseWorktree(path);
      if (freed) {
        writeStdoutLine(`Removed ${label}: ${path}`);
        removedAny = true;
      } else if (existed) {
        writeStderrLine(`Failed to remove ${label} ${path}: ${reason}`);
        failedAny = true;
      }
    };

    const wt = worktreePath(prNumber);
    // Prunes a registration left behind by a hand-deleted directory, which is
    // also what unblocks the `git branch -D` below.
    report('worktree', wt);

    // The test-efficacy probe runs in a disposable sibling worktree and removes
    // it itself; sweep one a crashed probe left behind so it does not block the
    // next run's `git worktree add` (see #6832 / test-efficacy.ts). Shares the
    // path helper with the probe so the suffix cannot drift between the two.
    report('probe worktree', probeWorktreePath(wt));

    const branch = reviewBranch(prNumber);
    if (refExists(branch)) {
      try {
        execFileSync('git', ['branch', '-D', branch], { stdio: 'pipe' });
        writeStdoutLine(`Deleted ref: ${branch}`);
        removedAny = true;
      } catch (err) {
        writeStderrLine(
          `Failed to delete branch ${branch}: ${(err as Error).message}`,
        );
        failedAny = true;
      }
    }
  }

  // --- Per-target side files (under .qwen/tmp/) -------------------------
  const prefix = tmpPrefix(target);
  let tmpEntries: string[] = [];
  try {
    tmpEntries = existsSync(REVIEW_TMP_DIR) ? readdirSync(REVIEW_TMP_DIR) : [];
  } catch (err) {
    writeStderrLine(
      `Failed to read ${REVIEW_TMP_DIR}: ${(err as Error).message}`,
    );
  }

  for (const file of tmpEntries) {
    if (!file.startsWith(prefix)) continue;
    const full = join(REVIEW_TMP_DIR, file);
    try {
      // Not every side file is a file. `agent-prompt` records what it handed each
      // agent in `<plan>-prompts/`, a directory under this same prefix, and
      // `unlinkSync` on a directory is an EISDIR — which this loop would have
      // reported as a cleanup failure on every single review.
      rmSync(full, { recursive: true, force: true });
      writeStdoutLine(`Removed temp file: ${full}`);
      removedAny = true;
    } catch (err) {
      writeStderrLine(`Failed to remove ${full}: ${(err as Error).message}`);
      failedAny = true;
    }
  }

  if (!failedAny) {
    clearReviewWorktreeLease(process.cwd(), target);
  }

  // "Nothing to clean" is a claim about the tree, not about this run's luck. It
  // is only true when there was nothing there — not when there was and we could
  // not get rid of it.
  if (!removedAny && !failedAny) {
    writeStdoutLine(`Nothing to clean for target "${target}".`);
  }
}

export const cleanupCommand: CommandModule = {
  command: 'cleanup <target>',
  describe:
    'Post-review cleanup: remove worktree, branch ref, and per-target temp files',
  builder: (yargs) =>
    yargs.positional('target', {
      type: 'string',
      demandOption: true,
      describe:
        'Review target — "pr-<n>" for a PR review, "local" for an uncommitted review, or a filename for a file review',
    }),
  handler: (argv) => {
    runCleanup((argv as unknown as CleanupArgs).target);
  },
};
