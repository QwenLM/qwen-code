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
  tmpFile,
  tmpPrefix,
} from './lib/paths.js';

interface CleanupArgs {
  target: string;
}

/** An issue comment, as listed by `GET /issues/{n}/comments`. */
export interface RawIssueComment {
  id: number;
  user?: { login: string } | null;
  body?: string | null;
  created_at?: string;
  updated_at?: string;
  html_url?: string;
}

/**
 * Marker prefix every bot comment in this repo's own automation carries
 * (`<!-- qwen-review-ack -->`, `<!-- qwen-pr-precheck:… -->`,
 * `<!-- qwen-triage:… -->`, …). In CI the review runs under the same bot
 * account those workflows post from, and a push mid-review triggers them —
 * without this filter every such comment would be flagged as a bypass.
 */
const AUTOMATION_MARKER = '<!-- qwen-';

export interface WindowWrites {
  /** Created inside the window by the reviewing account — the incident shape. */
  posted: RawIssueComment[];
  /** Created before the window but edited inside it. Reactions do NOT bump
   * an issue comment's `updated_at` (verified empirically), so an entry here
   * is a real body edit. */
  edited: RawIssueComment[];
}

/**
 * Issue-comment writes by the reviewing account inside the review window.
 *
 * `qwen review submit` is the ONLY sanctioned write in `/review`, and it
 * posts a *review* — never an issue comment. So an issue comment the
 * reviewing account created (or edited — the Step 7 ban covers edits too,
 * and `?since=` filters on `updated_at`, so edited rows are already in the
 * response) inside the window is a write that bypassed the submit gate,
 * something the user did by hand from another terminal, or another workflow
 * running under the same account; the warning below names all three
 * readings and lets the human decide. Zero overlap with sanctioned output
 * means zero correlation bookkeeping. Comments carrying this repo's own
 * automation marker are dropped: in CI the reviewing account IS the bot
 * that precheck/triage post from.
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
): WindowWrites {
  const reviewerLc = reviewer.toLowerCase();
  const relevant = comments.filter(
    (c) =>
      (c.user?.login ?? '').toLowerCase() === reviewerLc &&
      typeof c.created_at === 'string' &&
      !(c.body ?? '').includes(AUTOMATION_MARKER),
  );
  return {
    posted: relevant.filter((c) => c.created_at! >= sinceIso),
    edited: relevant.filter(
      (c) =>
        c.created_at! < sinceIso &&
        typeof c.updated_at === 'string' &&
        c.updated_at >= sinceIso,
    ),
  };
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

const OWNER_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function readAuditWindow(
  target: string,
  expectedPrNumber: string,
): { window: AuditWindow } | { skip: string } {
  let raw: string;
  try {
    raw = readFileSync(tmpFile(target, 'fetch.json'), 'utf8');
  } catch {
    return { skip: 'no fetch report' };
  }
  try {
    const report = JSON.parse(raw) as Partial<AuditWindow>;
    if (typeof report.fetchedAt !== 'string') {
      return {
        skip: 'fetch report has no fetchedAt (written by an older CLI)',
      };
    }
    if (
      typeof report.prNumber !== 'string' ||
      typeof report.ownerRepo !== 'string'
    ) {
      return { skip: 'fetch report is missing prNumber/ownerRepo' };
    }
    // The report is a file on disk; before its values reach a gh api path,
    // hold them to the same standard the rest of this surface applies
    // (HOSTNAME_RE in setGhHost, safeTarget in paths). The cross-check
    // against the cleanup target is strictly stronger than a shape test.
    if (report.prNumber !== expectedPrNumber) {
      return {
        skip: `fetch report is for PR ${report.prNumber}, not ${expectedPrNumber}`,
      };
    }
    if (!OWNER_REPO_RE.test(report.ownerRepo)) {
      return { skip: 'fetch report ownerRepo is not owner/repo-shaped' };
    }
    return {
      window: {
        prNumber: report.prNumber,
        ownerRepo: report.ownerRepo,
        fetchedAt: report.fetchedAt,
        host: typeof report.host === 'string' ? report.host : null,
      },
    };
  } catch {
    return { skip: 'fetch report is not valid JSON' };
  }
}

/**
 * Best-effort by design: cleanup must stay idempotent and offline-safe, so
 * any failure here (no gh, no auth, no network, report missing) skips the
 * audit rather than failing the cleanup. Every skip is named on STDERR —
 * without that, a skipped audit and a clean window produce identical
 * output, and the tripwire's off state is indistinguishable from its
 * all-clear state.
 */
function auditPrWrites(target: string, prNumber: string): void {
  const skipNote = (reason: string) =>
    writeStderrLine(`note: bypass audit skipped (${reason})`);
  const read = readAuditWindow(target, prNumber);
  if ('skip' in read) {
    skipNote(read.skip);
    return;
  }
  const window = read.window;
  try {
    setGhHost(window.host ?? undefined);
    const comments = ghApiAll(
      `repos/${window.ownerRepo}/issues/${window.prNumber}/comments?since=${encodeURIComponent(window.fetchedAt)}&per_page=100`,
    ) as RawIssueComment[];
    // The common case; skipping currentUser() here saves a network round
    // trip on every clean cleanup.
    if (comments.length === 0) return;
    const { posted, edited } = findUnsanctionedIssueComments(
      comments,
      currentUser(),
      window.fetchedAt,
    );
    if (posted.length === 0 && edited.length === 0) return;
    writeStdoutLine(
      `warning: ${posted.length + edited.length} issue-comment write(s) by the reviewing account on ` +
        `${window.ownerRepo}#${window.prNumber} during this review window. ` +
        `The only sanctioned write in /review is \`qwen review submit\`, and it never touches issue comments:`,
    );
    for (const c of posted) {
      writeStdoutLine(
        `warning:   posted comment ${c.id} at ${c.created_at}${c.html_url ? ` — ${c.html_url}` : ''}`,
      );
    }
    for (const c of edited) {
      writeStdoutLine(
        `warning:   edited comment ${c.id} at ${c.updated_at}${c.html_url ? ` — ${c.html_url}` : ''}`,
      );
    }
    writeStdoutLine(
      `warning: if the user did this themselves — or another workflow posts under the same ` +
        `account — ignore this; otherwise a write bypassed the submit gate. ` +
        `Relay this warning verbatim in the terminal summary.`,
    );
  } catch (err) {
    skipNote(err instanceof Error ? err.message.split('\n')[0] : String(err));
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
    auditPrWrites(target, prNumber);

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
