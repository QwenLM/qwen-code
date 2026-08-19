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
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  clearReviewWorktreeLease,
  isReviewLeaseFile,
  readReviewWorktreeLease,
  reviewLeaseHeldByAnotherSession,
  reviewLeasePath,
} from '../../services/review-worktree-lease.js';
import { currentUser, getGhHost, ghApiAll, setGhHost } from './lib/gh.js';
import { parseReceiptIds } from './lib/receipt.js';
import { refExists, releaseWorktree } from './lib/git.js';
import { readBudgetStopUnfenced } from './lib/deadline.js';
import { promptRecordDir, runEpochMs } from './lib/prompt-record.js';
import {
  worktreePath,
  probeWorktreePath,
  baseWorktreePath,
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

/**
 * The bot workflows put their marker on the FIRST line of the body; anchoring
 * the test there keeps a hand-posted summary that merely QUOTES a marked
 * comment (or deliberately embeds the marker mid-body to hide) visible to
 * the tripwire.
 */
function isAutomationComment(body: string | null | undefined): boolean {
  return (body ?? '').trimStart().startsWith(AUTOMATION_MARKER);
}

/**
 * Clock-skew allowance subtracted from the recorded window opening before it
 * is used as the audit boundary. `fetchedAt` is a LOCAL timestamp compared
 * against GitHub's SERVER timestamps: a fast local clock would otherwise
 * hide bypass writes made in the first moments of the review. Two minutes
 * errs toward over-flagging (fail-safe — the warning copy frames a flagged
 * write as most likely an external same-account one, not a bypass).
 */
const CLOCK_SKEW_MS = 2 * 60 * 1000;

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
      !isAutomationComment(c.body),
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
  /** Earliest window opening across drift restarts (fetch-pr preserves it);
   * falls back to fetchedAt for reports written before it existed. A restart
   * must not blind the audit to writes made during the abandoned attempt. */
  auditSince: string;
  host: string | null;
}

/** A review, as listed by `GET /pulls/{n}/reviews`. */
export interface RawReview {
  id: number;
  user?: { login: string } | null;
  state?: string;
  submitted_at?: string;
  html_url?: string;
}

/**
 * Reviews the reviewing account submitted inside the window that the submit
 * receipt does not vouch for. Step 7's ban covers this channel too (`gh pr
 * review`, direct POSTs to `pulls/<n>/reviews`), and unlike issue comments
 * a review CAN legitimately appear here — the sanctioned submit posts one —
 * so sanctioned-vs-bypass is decided by id against the receipt submit wrote.
 * The receipt vouches for a SET of ids, not one: the window spans drift
 * restarts, so two sanctioned submits can fall in it, and excluding only the
 * last would flag the earlier legitimate review as a bypass. No receipt
 * vouches for nothing: with zero sanctioned writes recorded, every in-window
 * review by the account is flagged (fail-safe).
 */
export function findUnsanctionedReviews(
  reviews: RawReview[],
  reviewer: string,
  sinceIso: string,
  receiptReviewIds: ReadonlySet<number>,
): RawReview[] {
  const reviewerLc = reviewer.toLowerCase();
  return reviews.filter(
    (r) =>
      (r.user?.login ?? '').toLowerCase() === reviewerLc &&
      typeof r.submitted_at === 'string' &&
      r.submitted_at >= sinceIso &&
      !receiptReviewIds.has(r.id),
  );
}

const OWNER_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function readAuditWindow(
  target: string,
  expectedPrNumber: string,
): { window: AuditWindow } | { skip: string } {
  let raw: string;
  try {
    raw = readFileSync(tmpFile(target, 'fetch.json'), 'utf8');
  } catch (err) {
    // Only ENOENT means "no report"; any other failure (permissions, EISDIR,
    // I/O) is a different problem and pointing the operator at "no fetch
    // report" sends them the wrong way.
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT'
      ? { skip: 'no fetch report' }
      : {
          skip: `cannot read fetch report (${code ?? (err as Error).message})`,
        };
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
    const auditSince =
      typeof report.auditSince === 'string' &&
      !Number.isNaN(Date.parse(report.auditSince))
        ? report.auditSince
        : report.fetchedAt;
    if (Number.isNaN(Date.parse(auditSince))) {
      return { skip: 'fetch report fetchedAt is not a timestamp' };
    }
    return {
      window: {
        prNumber: report.prNumber,
        ownerRepo: report.ownerRepo,
        fetchedAt: report.fetchedAt,
        auditSince,
        host: typeof report.host === 'string' ? report.host : null,
      },
    };
  } catch {
    return { skip: 'fetch report is not valid JSON' };
  }
}

/**
 * The set of review ids sanctioned submits recorded this session — empty when
 * none did. The shape parse is shared with submit's writer
 * (`lib/receipt.ts`); only the empty-case wrapper (a `Set` here, `[]` there)
 * differs.
 */
function readSubmitReceipt(target: string): Set<number> {
  try {
    return new Set(
      parseReceiptIds(
        readFileSync(tmpFile(target, 'submit-receipt.json'), 'utf8'),
      ),
    );
  } catch {
    return new Set();
  }
}

/** First line that actually says something: gh puts the HTTP/auth/DNS cause
 * on stderr while `err.message` is often the generic "Command failed" wrap. */
function briefErrorLine(err: unknown): string {
  const stderr = (err as { stderr?: unknown }).stderr;
  if (typeof stderr === 'string') {
    const line = stderr.split('\n').find((l) => l.trim().length > 0);
    if (line) return line.trim();
  }
  return err instanceof Error
    ? (err.message.split('\n')[0] ?? String(err))
    : String(err);
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
  // The audit routes gh at the PR's host, but that override must not leak out
  // of this block — cleanup runs last today, but a future caller after it (or
  // a second auditPrWrites) would otherwise inherit the Enterprise host. Save
  // and restore around the block.
  const prevHost = getGhHost();
  try {
    setGhHost(window.host ?? undefined);
    // The boundary backs off from the recorded opening: fetchedAt is local
    // time compared against GitHub's server timestamps (see CLOCK_SKEW_MS),
    // and auditSince already reaches back across drift restarts.
    const boundary = new Date(
      Date.parse(window.auditSince) - CLOCK_SKEW_MS,
    ).toISOString();
    const comments = ghApiAll(
      `repos/${window.ownerRepo}/issues/${window.prNumber}/comments?since=${encodeURIComponent(boundary)}&per_page=100`,
    ) as RawIssueComment[];
    const reviews = (
      ghApiAll(
        `repos/${window.ownerRepo}/pulls/${window.prNumber}/reviews?per_page=100`,
      ) as RawReview[]
    ).filter(
      (r) => typeof r.submitted_at === 'string' && r.submitted_at >= boundary,
    );
    // The common case; skipping currentUser() here saves a network round
    // trip on every clean cleanup.
    if (comments.length === 0 && reviews.length === 0) return;
    const me = currentUser();
    const { posted, edited } = findUnsanctionedIssueComments(
      comments,
      me,
      boundary,
    );
    const rogueReviews = findUnsanctionedReviews(
      reviews,
      me,
      boundary,
      readSubmitReceipt(target),
    );
    const total = posted.length + edited.length + rogueReviews.length;
    if (total === 0) return;
    writeStdoutLine(
      `warning: ${total} write(s) by the reviewing account on ` +
        `${window.ownerRepo}#${window.prNumber} during this review window were not made by ` +
        `\`qwen review submit\` — the only sanctioned write in /review:`,
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
    for (const r of rogueReviews) {
      writeStdoutLine(
        `warning:   review ${r.id} (${r.state ?? 'UNKNOWN'}) at ${r.submitted_at}${r.html_url ? ` — ${r.html_url}` : ''} — no submit receipt vouches for it`,
      );
    }
    writeStdoutLine(
      `warning: The likely cause is benign — the user (from another terminal), ` +
        `another workflow, or a bot posting under the same account (${me}) produces ` +
        `exactly this shape. ` +
        `\`/review\` writes to the PR only through \`qwen review submit\`; a write ` +
        `here is a real bypass of that gate only if its content is this review's own ` +
        `output. Relay this warning verbatim in the terminal summary so a human can judge.`,
    );
  } catch (err) {
    skipNote(briefErrorLine(err));
  } finally {
    setGhHost(prevHost);
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
  // The lease guards the worktree and branch, so it releases once THOSE steps
  // are done: a side file that will not delete (EACCES on a read-only entry,
  // a Windows file handle) must not keep the lock held — a leftover lease
  // refuses every later fetch-pr of this PR and skips every later cleanup,
  // and nothing sweeps a finished session's lease automatically.
  let failedDestruction = false;

  // --- Worktree + branch (only for PR targets) -------------------------
  const prMatch = /^pr-(\d+)$/.exec(target);
  if (prMatch) {
    const prNumber = prMatch[1];

    // The lease is also a lock (#9205). The worktree path, the side files,
    // and the fetch report carrying the audit window are all fixed per PR
    // number, so cleaning while ANOTHER session reviews the same PR deletes
    // its worktree, diff, and plan mid-run — and audits ITS window against
    // receipts it never wrote. Skip the whole target: worktree, siblings,
    // branch, side files, audit, and the lease itself all belong to the
    // holder until its own cleanup releases them.
    const holder = readReviewWorktreeLease(process.cwd(), target);
    if (reviewLeaseHeldByAnotherSession(holder)) {
      writeStdoutLine(
        `note: skipped cleanup for "${target}" — another review session ` +
          `(session ${holder.sessionId}) still holds the worktree lease at ` +
          `${reviewLeasePath(process.cwd(), target)}. Its own cleanup ` +
          `releases the lease when it finishes; if that session is gone, ` +
          `delete the lease file and re-run to force cleanup.`,
      );
      return;
    }

    // Before the sweep below deletes the fetch report (the audit window's
    // carrier), check the PR for writes that bypassed `qwen review submit`.
    auditPrWrites(target, prNumber);

    // The audit is network-bound (seconds) — a lease can appear during it (a
    // review that started after the gate above read none). Re-check before
    // destroying anything and take the same skip path (#9205).
    const holderAfterAudit = readReviewWorktreeLease(process.cwd(), target);
    if (reviewLeaseHeldByAnotherSession(holderAfterAudit)) {
      writeStdoutLine(
        `note: skipped cleanup for "${target}" — a review session ` +
          `(session ${holderAfterAudit.sessionId}) acquired the lease ` +
          `during the audit; its own cleanup releases it.`,
      );
      return;
    }

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
        failedDestruction = true;
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

    // The A/B base tree is the same story: `base-tree` leaves it standing for
    // the rest of the review (a verifier may run against it at any point, and a
    // base that failed to build is kept deliberately, as evidence), so this is
    // its only removal — not just a crash sweep. Same shared path helper, same
    // reason: the suffix must not drift between creator and sweeper.
    report('base worktree', baseWorktreePath(wt));
    // The base-tree build lock is a plain directory (`mkdirSync` test-and-set),
    // not a git worktree, so `releaseWorktree` above does not touch it. A builder
    // killed mid-build leaves it behind (its `finally` rmSync never runs), and every
    // later base-tree probe for this PR then hits EEXIST and reports "another probe
    // is building" until a manual rm. Sweep it here, at the end of the review when no
    // builder is active. Best effort only — a lock that will not delete is an
    // operational paper-cut, never a wrong verdict, so it does not fail the cleanup.
    try {
      rmSync(`${baseWorktreePath(wt)}.lock`, { recursive: true, force: true });
    } catch (err) {
      writeStderrLine(
        `note: could not remove base lock ${baseWorktreePath(wt)}.lock: ${(err as Error).message}`,
      );
    }

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
        failedDestruction = true;
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

  // #9206: a prompt-record directory whose loop STOPPED WITHOUT CONVERGING
  // is the only certification history there is — the evidence a
  // never-retiring reverse-audit loop needs to diagnose itself, which the
  // sweep would otherwise destroy unread. Two signals name such a stop,
  // and neither implies the other:
  //
  // - A stop MARKER on disk, from ANY run. The loop writes one inside the
  //   record directory when a round is refused (round-cap or budget), and
  //   a clean convergence clears only its OWN run's marker — so a marker
  //   that is still there is a stop that never converged. Retention reads
  //   it WITHOUT the run-epoch fence the verdict consumers read through:
  //   that fence keeps a previous run's stop from capping THIS run's
  //   verdict, but here a previous run's marker is exactly the evidence
  //   to keep — the CI retry re-captures the plan at the same path, and
  //   fencing the marker out would re-create the loss #9206 reports.
  // - Records this run cannot have written: a loop KILLED or crashed
  //   mid-round stops without converging and leaves NO marker (only
  //   refusals write one), but its records predate the retry's fresh plan
  //   capture — nothing clears the record dir between runs. A file older
  //   than the plan's own mtime is a previous run's.
  // - A record directory whose plan file is GONE — the shape the signals
  //   above leave behind. A previous cleanup kept the directory and swept
  //   the plan beside it (retention preserves only the -prompts entry), so
  //   the mtime comparison can no longer run — an unstatable plan reads
  //   epoch -Infinity and no record is older than it. A directory that
  //   survived one cleanup on this evidence must survive the next; the
  //   Kept line's manual-removal instruction is the exit (#9213 on #9206).
  //
  // The decision is made BEFORE the sweep runs: the plan file the epoch
  // reads is itself one of the swept entries.
  const preserved = new Set<string>();
  for (const file of tmpEntries) {
    if (!file.startsWith(prefix) || !file.endsWith('-prompts')) continue;
    const planCandidate = join(
      REVIEW_TMP_DIR,
      `${file.slice(0, -'-prompts'.length)}.json`,
    );
    if (
      readBudgetStopUnfenced(planCandidate) !== null ||
      hasPreviousRunRecords(planCandidate) ||
      !existsSync(planCandidate)
    ) {
      preserved.add(file);
    }
  }

  for (const file of tmpEntries) {
    // The lease doubles as the review's lock (#9205), so live PR leases must
    // not be swept. Skip only the real lease shape (…-pr-<n>.json), not the
    // bare prefix: a file-review target named "lease" flattens to this same
    // prefix, and its OWN side files still need removal — nothing else removes
    // them. Lease removal itself belongs to clearReviewWorktreeLease below.
    if (isReviewLeaseFile(file)) {
      continue;
    }
    if (!file.startsWith(prefix)) continue;
    const full = join(REVIEW_TMP_DIR, file);
    if (preserved.has(file)) {
      writeStdoutLine(
        `Kept ${full}: a review run stopped here without converging — ` +
          `the record directory is the evidence for diagnosing it; remove ` +
          `it manually once done.`,
      );
      continue;
    }
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

  if (!failedDestruction) {
    clearReviewWorktreeLease(process.cwd(), target);
  }

  // "Nothing to clean" is a claim about the tree, not about this run's luck. It
  // is only true when there was nothing there — not when there was and we could
  // not get rid of it, and not when an entry was deliberately kept.
  if (!removedAny && !failedAny && preserved.size === 0) {
    writeStdoutLine(`Nothing to clean for target "${target}".`);
  }
}

/**
 * Whether the plan's record directory holds files older than the plan's
 * own capture — records a PREVIOUS run wrote. Every run rewrites the plan
 * at its Step 1 capture and nothing clears the record dir, so a file this
 * run wrote is always newer than the plan; anything older belongs to a
 * run that stopped and never cleaned up (#9206). Unreadable directory or
 * plan → false: the sweep proceeds as it always did. One unreadable
 * ENTRY is skipped instead: the check is existential — ANY file older
 * than the plan — and a single unstatable entry (a vanished file, a
 * broken symlink planted in the record dir) must not veto the older
 * evidence beside it (#9213).
 */
function hasPreviousRunRecords(planPath: string): boolean {
  try {
    const epoch = runEpochMs(planPath);
    const dir = promptRecordDir(planPath);
    return readdirSync(dir).some((name) => {
      try {
        return statSync(join(dir, name)).mtimeMs < epoch;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
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
