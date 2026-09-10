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
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  type Stats,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  CAPTURE_SERVER_NAME_RE,
  isNothingToKill,
  isSocketDirUnusable,
  resolveOnPath,
} from './lib/tui-capture.js';
import {
  clearReviewWorktreeLease,
  isReviewLeaseFile,
  readReviewWorktreeLease,
  reviewLeaseHeldByAnotherSession,
  reviewLeasePath,
} from '../../services/review-worktree-lease.js';
import { redirectedAncestor, sanitizedGitEnv } from './lib/worktree.js';
import { currentUser, getGhHost, ghApiAll, setGhHost } from './lib/gh.js';
import { parseReceiptCommentIds, parseReceiptIds } from './lib/receipt.js';
import { detectPlatformKind } from './lib/platform/registry.js';
import { a1Json, aoneWhoamiAccount } from './lib/platform/aone-client.js';
import { refExists, releaseWorktree } from './lib/git.js';
import { readBudgetStopUnfenced } from './lib/deadline.js';
import { promptRecordDir, runEpochMs } from './lib/prompt-record.js';
import {
  worktreePath,
  probeWorktreePath,
  baseWorktreePath,
  scratchWorktreePrefix,
  reviewBranch,
  inertPath,
  REVIEW_TMP_DIR,
  tmpFile,
  tmpPrefix,
} from './lib/paths.js';
import { safeTarget } from '../../utils/paths.js';

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

export interface WindowWrites<T> {
  /** Created inside the window by the reviewing account — the incident shape. */
  posted: T[];
  /** Created before the window but edited inside it. On GitHub, reactions do
   * NOT bump an issue comment's `updated_at` (verified empirically), so an
   * entry here is a real body edit. On Aone the edited arm additionally sees
   * only UNRESOLVED comments — a resolution bumps `updatedAt` exactly like
   * an edit, so a resolved comment's `updatedAt` is not an edit signal (see
   * findUnsanctionedAoneComments); what else bumps it there is unverified. */
  edited: T[];
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
): WindowWrites<RawIssueComment> {
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

/** An MR comment, as listed by `a1 repo mr comment list --format json`. */
export interface RawAoneComment {
  id: number;
  note?: string;
  author?: { username?: string } | null;
  /** ISO-8601 with a NUMERIC utc offset — Aone stamps `+08:00`, not `Z`. */
  createdAt?: string;
  updatedAt?: string;
  /** 1 when the discussion is resolved. The DEFAULT comment list excludes
   * resolved comments; the `--resolved` query returns (only) the resolved
   * root inline ones (measured). */
  closed?: number;
  /** Present on inline comments, absent on global ones. */
  path?: string;
  line?: number;
}

/**
 * MR-comment writes by the authenticated account inside the review window
 * that the submit receipt does not vouch for — the Aone twin of
 * {@link findUnsanctionedIssueComments}, differing where the platform
 * differs. One: on Aone the sanctioned submit POSTS COMMENTS (the inline
 * findings and the summary — Aone has no review object), so
 * sanctioned-vs-bypass is decided by id against the receipt submit wrote;
 * the GitHub twin needs no receipt for comments because submit never posts
 * one there. (The vouch is post-time only: an EDIT of a vouched comment
 * inside the window is outside this tripwire's sight — its `updatedAt`
 * bump cannot be told from a resolution or other state flip, so detecting
 * it would flag healthy runs; aone has no comment-edit subcommand to begin
 * with. Disclosed residual, design doc #9617.) Two: Aone timestamps carry a
 * numeric utc offset (`+08:00`), so the window comparison parses to epoch
 * milliseconds — a lexicographic comparison across differing offsets orders
 * by local wall clock, not by instant (`07:30+08:00` is 23:30Z the PREVIOUS
 * day, yet sorts after any `…T23:00Z` boundary string). Three: a resolved
 * comment's `updatedAt` is the resolution instant, indistinguishable from a
 * body edit — so the edited arm skips resolved comments entirely; a
 * posted-then-resolved bypass is still caught by the posted arm. That skip
 * opens the third disclosed residual: an EDIT of an UNVOUCHED pre-window
 * comment is invisible once its discussion is resolved — the `--resolved`
 * union lists it, but the posted arm keys on creation inside the window and
 * the edited arm drops resolved comments, so a resolved comment is judged
 * by creation only (design doc #9617).
 */
export function findUnsanctionedAoneComments(
  comments: RawAoneComment[],
  account: string,
  sinceMs: number,
  receiptCommentIds: ReadonlySet<number>,
): WindowWrites<RawAoneComment> {
  const accountLc = account.toLowerCase();
  const relevant = comments.filter(
    (c) =>
      typeof c.id === 'number' &&
      (c.author?.username ?? '').toLowerCase() === accountLc &&
      typeof c.createdAt === 'string' &&
      !Number.isNaN(Date.parse(c.createdAt)) &&
      !isAutomationComment(c.note) &&
      !receiptCommentIds.has(c.id),
  );
  return {
    posted: relevant.filter((c) => Date.parse(c.createdAt!) >= sinceMs),
    edited: relevant.filter(
      (c) =>
        Date.parse(c.createdAt!) < sinceMs &&
        c.closed !== 1 &&
        typeof c.updatedAt === 'string' &&
        Date.parse(c.updatedAt) >= sinceMs,
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
 * One receipt-read axis: parse the shared receipt file through the given
 * axis parser and collect the ids. Absent or unreadable is an EMPTY set —
 * vouching for nothing (fail-safe), never a throw.
 */
function readReceiptAxis(
  target: string,
  parse: (raw: string) => number[],
): Set<number> {
  try {
    return new Set(
      parse(readFileSync(tmpFile(target, 'submit-receipt.json'), 'utf8')),
    );
  } catch {
    return new Set();
  }
}

/**
 * The set of review ids sanctioned submits recorded this session — empty when
 * none did. The shape parse is shared with submit's writer
 * (`lib/receipt.ts`); only the empty-case wrapper (a `Set` here, `[]` there)
 * differs.
 */
function readSubmitReceipt(target: string): Set<number> {
  return readReceiptAxis(target, parseReceiptIds);
}

/**
 * The comment ids Aone submits recorded this session — empty when none did.
 * The same file as {@link readSubmitReceipt}, read through the comment-id
 * half of the shared parse: on Aone the sanctioned write posts COMMENTS, so
 * the audit's sanctioned-vs-bypass ruling keys on comment ids. Empty
 * vouches for nothing: every in-window comment by the account is flagged
 * (fail-safe), exactly as an empty review-id set does on GitHub.
 */
function readAoneSubmitReceipt(target: string): Set<number> {
  return readReceiptAxis(target, parseReceiptCommentIds);
}

/** First line that actually says something: gh puts the HTTP/auth/DNS cause
 * on stderr while `err.message` is often the generic "Command failed" wrap.
 * a1 fails differently — a pretty-printed JSON error OBJECT on stderr whose
 * first non-empty line is the opening brace; the `message` field is the
 * cause there, so it wins when present, and an object carrying no usable
 * one is flattened whole — the line scan would render just the brace. */
function briefErrorLine(err: unknown): string {
  const stderr = (err as { stderr?: unknown }).stderr;
  if (typeof stderr === 'string') {
    try {
      const parsed = JSON.parse(stderr) as { message?: unknown };
      if (typeof parsed.message === 'string' && parsed.message.trim() !== '') {
        return parsed.message.trim();
      }
      return JSON.stringify(parsed);
    } catch {
      // Not a JSON error object — fall through to the line scan.
    }
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
  // The platform the FETCH ran on decides the audit's backend. The recorded
  // host is the primary evidence (the skill passes --host to every
  // platform-talking subcommand); a hostless report falls back to the cwd
  // clone's origin — the registry's own fall-through — so a bare-number Aone
  // run that omitted --host is still audited through a1 instead of querying
  // github.com's same-named repo. The misroute this replaced audited Aone
  // MRs against GitHub: a hostless report hit github.com, a recorded Aone
  // host pointed gh at a host it has no auth on — both skipped the audit,
  // leaving Aone with no tripwire at all (#9617).
  if (detectPlatformKind({ host: window.host ?? undefined }) === 'aone') {
    try {
      auditAoneMrWrites(target, window);
    } catch (err) {
      skipNote(briefErrorLine(err));
    }
    return;
  }
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
    writeStdoutLine(bypassAuditFooter(me, 'PR'));
  } catch (err) {
    skipNote(briefErrorLine(err));
  } finally {
    setGhHost(prevHost);
  }
}

/**
 * Reap the capture servers capture-tui's own reap could not reach: a
 * SIGKILL'd or OOM'd harness skips finally and the signal net alike, and
 * the private server then lives until its pane holder's bounded hold loop
 * expires (up to three hours) — the config-free server has nothing else to
 * destroy it, so this sweep (or a hand kill-server) is the only reaper in
 * that window. The launcher's pid rides in the socket name for exactly
 * this — a socket whose pid is dead is an orphan. A reap that fails is
 * noted on stderr and suppresses the "Nothing to clean" claim — but does
 * NOT hold the target-scoped worktree lease: the sweep is host-wide, and
 * an unrelated review's orphan would otherwise wedge this review's lease
 * with nothing connecting the two in the output.
 *
 * The orphan test is NAME plus a dead launcher pid, and that is sound only
 * for the model capture-tui states (see its header): absent an active
 * same-uid adversary, nothing but a crashed capture leaves a capture-named
 * socket whose launcher pid is dead. A same-uid process that RENAMES a live
 * foreign socket into a capture-shaped name with a chosen-dead pid defeats
 * it — the entry is then a plain socket indistinguishable from a real
 * orphan by every signal a name-addressed sweep can read, and no signal it
 * could add is out of that adversary's reach (an on-disk pid record is
 * same-uid writable; a live server's shape is same-uid craftable). That is
 * the stated non-goal, hardened in #9274, not a defect this sweep can close
 * from here. The type guard below rejects the redirections that arise
 * WITHOUT such a rename; it does not pretend to more.
 */
function reapOrphanedCaptureServers(): { reaped: boolean; failed: boolean } {
  const uid = process.getuid?.();
  // tmux is POSIX-only, and so is the socket dir layout below.
  if (uid === undefined) return { reaped: false, failed: false };
  // BOTH candidate socket dirs, not one: tmux's own resolution takes the
  // first USABLE base (TMUX_TMPDIR, else /tmp) — a stale profile-exported
  // TMUX_TMPDIR pointing at an unusable path means the real sockets live
  // under /tmp while a single-base sweep scans the wrong directory forever
  // (measured end-to-end: 'Nothing to clean' with a live orphan).
  // UNTRIMMED, matching tmux: a whitespace-padded TMUX_TMPDIR is used
  // verbatim by tmux (measured: socket under '/tmp/x /tmux-<uid>'), so a
  // trimming sweep scanned a directory tmux never used.
  const envBase = process.env['TMUX_TMPDIR'];
  // De-duplicated by the directory the scan actually opens, not the raw
  // string: an alias of /tmp (`/tmp/`, `/tmp/.`, `//tmp` — the same
  // profile-exported family this fallback exists for) survived a
  // string-keyed Set, so both entries joined to the same tmux-<uid> dir and
  // every socket in it was listed, killed and reported TWICE.
  const bases: string[] = [];
  const seen = new Set<string>();
  for (const base of [envBase || '/tmp', '/tmp']) {
    const dir = join(base, `tmux-${uid}`);
    // Keyed on the RESOLVED directory: string normalization collapses
    // `/tmp/`, `/tmp/.` and `//tmp`, but a TMUX_TMPDIR that is a symlink to
    // /tmp still named a different string while opening the same directory,
    // so every socket in it was listed, killed and reported twice.
    let key = dir;
    try {
      key = realpathSync(dir);
    } catch {
      // Not there (or unreadable): the raw path is a fine key, and the
      // scan below reports what it cannot read.
    }
    if (seen.has(key)) continue;
    seen.add(key);
    bases.push(base);
  }
  let reapedAny = false;
  let failedAny = false;
  let entries: Array<{ dir: string; name: string }> = [];
  for (const base of bases) {
    const dir = join(base, `tmux-${uid}`);
    try {
      // readdirSync FIRST, with ENOENT as the only quiet answer: existsSync
      // swallows EACCES and returns false, so an untraversable ANCESTOR of
      // this directory made the base look absent and skipped it silently —
      // past the catch below that exists precisely to be loud about a
      // directory that could be hiding an orphan, and against both nearby
      // comments. "Not there" and "not allowed to look" are different
      // answers and only one of them is safe to ignore.
      entries = entries.concat(readdirSync(dir).map((name) => ({ dir, name })));
    } catch (e) {
      // ENOENT, ENOTDIR and ELOOP are all definite "this base cannot hold a
      // socket" answers — a TMUX_TMPDIR that is a regular file or a symlink
      // loop is not a scan failure, and reporting it as one set sweepFailed
      // permanently and suppressed "Nothing to clean" on a host where there
      // was, in fact, nothing to clean. EACCES stays loud: that one CAN be
      // hiding an orphan.
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') continue;
      // A directory we cannot READ can be hiding an orphan — that is a
      // failure to surface, not a silent nothing (the doc contract above:
      // noted on stderr AND surfaced as failed).
      failedAny = true;
      writeStderrLine(
        `note: could not scan ${dir} for orphaned capture servers: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
  // The producer's own anchored shape, not a prefix — see its declaration
  // for why the whole name has to be matched and why the nonce is pinned by
  // alphabet rather than length.
  const orphanRe = CAPTURE_SERVER_NAME_RE;
  for (const { dir, name } of entries) {
    const m = orphanRe.exec(name);
    if (!m) continue;
    // The sweep matches by NAME; inspect the entry's TYPE before anything
    // connects to it. A planted entry under a capture-shaped name
    // redirects the pinned kill-server to whatever socket it resolves to —
    // including the user's own tmux server — and the exit-0 success branch
    // then reports "Reaped" while the victim is destroyed (probe-verified
    // end to end; the planter class is this PR's own documented
    // daemonized descendant). Three entrances, all rejected here: a
    // SYMLINK (kill-server follows it to the target), a HARD LINK to a
    // foreign socket — link() succeeds on a socket and connect(2) is
    // inode-addressed, so the kill lands on the foreign server race-free
    // (measured on Linux) — and any non-socket entry. A tmux-created
    // socket has exactly one link, so nlink > 1 is never an orphan. A
    // gone entry is nothing to reap.
    //
    // What these checks do NOT catch, and cannot: a same-uid process that
    // RENAMEs a live foreign socket into a capture-shaped name BEFORE the
    // scan. The result is a plain socket, one link, sitting stably at the
    // name — nothing here distinguishes it from a real orphan, and nothing
    // could, because every identity signal is within that adversary's
    // reach (an on-disk server-pid record is same-uid writable; the
    // answering server's own shape is same-uid craftable). This is the
    // active-same-uid boundary capture-tui's header states as a non-goal
    // (#9274), not a hole these type checks leak: they close the
    // redirections that need no rename, which is all a name-addressed
    // sweep can close. The post-kill re-check below is for the narrower
    // TOCTOU where a swap WINS the race between this lstat and tmux's
    // connect() after the fork+exec — a rename already in place at scan
    // time changes nothing between the two reads, so that re-check is
    // silent on it by design, not by oversight.
    let entryStat: Stats;
    try {
      entryStat = lstatSync(join(dir, name));
    } catch {
      continue;
    }
    if (
      entryStat.isSymbolicLink() ||
      !entryStat.isSocket() ||
      entryStat.nlink > 1
    ) {
      writeStderrLine(
        `note: not reaping ${name}: not a plain socket — kill-server ` +
          'would connect whatever this entry resolves to, which may be ' +
          'an unrelated server',
      );
      continue;
    }
    let alive = true;
    try {
      process.kill(Number(m[1]), 0);
    } catch (e) {
      // ESRCH = the pid is dead (the orphan signal). EPERM means the pid
      // is alive under another user. Both mean "leave it alone" here: the
      // socket named for it lives in this uid's mode-0700 tmux directory,
      // so a cross-user pid at that number is pid REUSE, not the launcher —
      // and reaping on that assumption would kill a server this sweep
      // cannot prove is ours. Anything else (an EINVAL, a host that
      // answers oddly) is likewise treated as alive: this sweep only ever
      // acts on a pid it positively knows is dead.
      alive = (e as NodeJS.ErrnoException).code !== 'ESRCH';
    }
    if (alive) continue;
    // Same rules as capture-tui's own reap: unlink the socket ONLY when
    // the server is known dead — a kill that throws can leave it alive,
    // and an unlinked socket makes a live server unreachable forever — and
    // one retry before giving up: a transient client-spawn failure (EMFILE
    // after a long review's many spawns) is the named shape, and the
    // identical second attempt reaps what otherwise lives out the holder's
    // bounded three-hour window.
    // Resolved, never bare — the half the comment below used to claim from
    // capture-tui's control calls without carrying it. execvp honours the
    // empty-PATH-element → cwd rule, and `cleanup` runs with the reviewed
    // worktree as its cwd: on a host whose PATH has an empty element, a
    // `tmux` committed to the PR under review is what this kill executes,
    // with the reviewer's environment. Resolved HERE rather than at sweep
    // start so a host with no tmux and no orphans stays silent.
    const tmuxBin = resolveOnPath('tmux');
    if (tmuxBin === undefined) {
      failedAny = true;
      writeStderrLine(
        `note: could not reap orphaned capture server ${name}: tmux is not ` +
          'reachable at any absolute PATH element, and this sweep will not ' +
          'resolve it through the current directory',
      );
      continue;
    }
    let serverDead = false;
    let dirUnusable = false;
    for (let attempt = 0; attempt < 2 && !serverDead; attempt++) {
      try {
        execFileSync(tmuxBin, ['-L', name, 'kill-server'], {
          stdio: 'pipe',
          // The scan finds sockets under BOTH bases, but `-L` re-resolves
          // the socket directory from THIS process's environment — and tmux
          // does not fall back when the env base exists (it creates it).
          // The two sides then disagree: an orphan found under /tmp while a
          // stale profile-exported TMUX_TMPDIR points elsewhere answered
          // `error connecting to <env>/tmux-<uid>/<name>` and survived
          // (measured on 3.3a, with the same call succeeding under the base
          // it was found in). Kill it where it was FOUND — `dir` is
          // `<base>/tmux-<uid>`, so its parent is the base tmux wants.
          env: { ...process.env, TMUX_TMPDIR: dirname(dir) },
          // Same belt as capture-tui's own control calls: a wedged server
          // must not hang the whole cleanup behind one socket — SIGKILL,
          // because a TERM-immune child blocks the sync call past any belt.
          timeout: 15_000,
          killSignal: 'SIGKILL',
        });
        serverDead = true;
      } catch (e) {
        const stderrText = String((e as { stderr?: unknown }).stderr ?? '');
        // Same rule as capture-tui's own reap: a client-side refusal
        // establishes nothing about the server, so it must not reach the
        // unlink below — a live orphan sits behind that socket, and
        // removing it makes the server unreachable forever while this
        // sweep reports "Reaped".
        serverDead = isNothingToKill(stderrText);
        // ACCUMULATED, like capture-tui's own reap: the reassignment this
        // replaces let a second attempt that failed for another reason (an
        // EMFILE spawn failure, the 15s belt) reset the flag and drop the
        // note's one actionable parenthetical.
        if (isSocketDirUnusable(stderrText)) dirUnusable = true;
      }
    }
    if (!serverDead) {
      failedAny = true;
      writeStderrLine(
        `note: could not reap orphaned capture server ${name}` +
          (dirUnusable
            ? ' (tmux refused before reaching the socket directory — its ' +
              'permissions or type, not the server)'
            : '') +
          ' ' +
          // WITH the base override: `-L` re-resolves the socket directory
          // from the invoking environment and does not fall back, so on
          // the very hosts where this note appears the bare command
          // resolves elsewhere and answers 'no server running' — reading
          // as "already gone" while the orphan runs out its window.
          // Shell-single-quoted, never JSON.stringify: a base carrying $
          // or a backtick expands at paste time and resolves the wrong
          // base — the same confusion this note exists to prevent.
          `(TMUX_TMPDIR='${dirname(dir).replaceAll("'", "'\\''")}' ` +
          // The name is quoted for the same reason the base above it is, and
          // belt-and-braces on top of the anchored `orphanRe`: this line is
          // built to be PASTED, so anything reaching it that a shell would
          // read runs in the operator's cwd. The regex is the gate; this is
          // the second wall behind it.
          `tmux -L '${name.replaceAll("'", "'\\''")}' kill-server to reap it by hand)`,
      );
      continue;
    }
    // tmux re-resolves the entry at connect(), after the fork+exec, so a
    // racer can swap it between the guard's lstat and the kill — no
    // portable close exists on the connect itself. When the entry the
    // kill ran under is not the one the guard inspected, "Reaped" would
    // assert a certainty the sweep does not have; name the swap instead.
    let entryChanged = false;
    try {
      const postKill = lstatSync(join(dir, name));
      entryChanged =
        postKill.ino !== entryStat.ino || postKill.mode !== entryStat.mode;
    } catch {
      // Gone between the kill and the re-check — only a racer removes an
      // entry this sweep has not unlinked yet.
      entryChanged = true;
    }
    if (entryChanged) {
      // NEVER unlink here. The entry is no longer the plain socket the guard
      // inspected — a racer renamed something onto the name in the
      // connect→re-check window, and that something may be a live server
      // whose socket, once unlinked, is unreachable forever (no attach, no
      // `-L` control): the exact harm this function's own unlink rule
      // ("ONLY when the server is known dead") forbids. Leaving the entry is
      // self-healing — the next sweep re-examines it — so the WARNING stands
      // and the socket is left alone.
      failedAny = true;
      writeStderrLine(
        `WARNING: ${name} changed between the type guard and the kill — ` +
          'the server killed may not be the orphan this sweep matched, so ' +
          'its socket was left in place; check your tmux servers',
      );
    } else {
      try {
        rmSync(join(dir, name), { force: true });
      } catch {
        // Litter is cosmetic; the server itself is already gone.
      }
      writeStdoutLine(`Reaped orphaned capture server: ${name}`);
    }
    reapedAny = true;
  }
  return { reaped: reapedAny, failed: failedAny };
}

/**
 * The tripwire's closing guidance, shared by both platform halves — the
 * relay instruction is contract text SKILL.md tells the model to carry
 * verbatim, so it lives in one place (only the target noun differs).
 */
function bypassAuditFooter(me: string, target: 'PR' | 'MR'): string {
  return (
    `warning: The likely cause is benign — the user (from another terminal), ` +
    `another workflow, or a bot posting under the same account (${me}) produces ` +
    `exactly this shape. ` +
    `\`/review\` writes to the ${target} only through \`qwen review submit\`; a write ` +
    `here is a real bypass of that gate only if its content is this review's own ` +
    `output. Relay this warning verbatim in the terminal summary so a human can judge.`
  );
}

/**
 * One `a1 repo mr comment list` query, shape-checked. a1 signals command
 * failure by exit code (execFileSync throws), but it can also answer a
 * well-formed `a1.error/v1` error OBJECT with exit 0 (a backend auth
 * failure or a client timeout — measured) — returning that silently would
 * read exactly like a clean window, so it throws instead, surfacing the
 * error object's `message` when it carries one (the difference between
 * "auth outage" and "schema drift" for the paged human).
 */
function a1CommentList(...flags: string[]): RawAoneComment[] {
  const out = a1Json<unknown>('repo', 'mr', 'comment', 'list', ...flags);
  if (!Array.isArray(out)) {
    const cause = (out as { message?: unknown } | null)?.message;
    throw new Error(
      'a1 mr comment list returned an unexpected shape' +
        (typeof cause === 'string' && cause.trim() !== ''
          ? `: ${cause.trim()}`
          : ''),
    );
  }
  return out as RawAoneComment[];
}

/**
 * The Aone half of the tripwire (design D8: `cleanup`'s bypass audit maps
 * to `comment list` filtered by the authenticated account within the audit
 * window). Lists the MR's comments through a1 and flags every one the
 * account created — or edited — inside the window that the submit receipt
 * does not vouch for. Coverage stops at the comment channel: `a1 repo mr
 * approve` and `a1 repo mr edit` are banned by Step 7's write ban but
 * invisible here — the recorded a1 surface exposes no listing an audit
 * could query for them (disclosed residual, design doc #9617). Throws on
 * any failure; the caller names the skip, so a skipped audit is never
 * mistaken for a clean one (same contract as the gh half).
 */
function auditAoneMrWrites(target: string, window: AuditWindow): void {
  // The same boundary the gh half applies, in epoch milliseconds: Aone
  // timestamps carry a numeric utc offset, so the window comparison is
  // numeric (see findUnsanctionedAoneComments).
  const boundaryMs = Date.parse(window.auditSince) - CLOCK_SKEW_MS;
  // The DEFAULT list excludes RESOLVED comments (measured: the MR's
  // `comments` minus `closedComments` is exactly what it returns), so a
  // bypass posted-then-resolved inside the window would hide there. The
  // `--resolved` query returns the resolved ROOT INLINE comments — union
  // the two, dedupe by id. Resolved replies stay invisible: a1 exposes no
  // listing that includes them (disclosed residual, design doc #9617).
  // Both queries are one UNPAGED `comment list` each: a1 documents no
  // page-size guarantee, so if a cap exists, comments past it stay
  // invisible too (disclosed residual, design doc #9617).
  const listed = a1CommentList(
    '--mr',
    window.prNumber,
    '--repo',
    window.ownerRepo,
  );
  const resolved = a1CommentList(
    '--mr',
    window.prNumber,
    '--repo',
    window.ownerRepo,
    '--resolved',
  );
  const byId = new Map<number, RawAoneComment>();
  for (const c of [...listed, ...resolved]) {
    if (typeof c.id === 'number' && !byId.has(c.id)) byId.set(c.id, c);
  }
  // The common case; skipping whoami here saves an a1 call on every clean
  // cleanup — the same fast path the gh half applies to currentUser().
  if (byId.size === 0) return;
  const me = aoneWhoamiAccount();
  const { posted, edited } = findUnsanctionedAoneComments(
    [...byId.values()],
    me,
    boundaryMs,
    readAoneSubmitReceipt(target),
  );
  const total = posted.length + edited.length;
  if (total === 0) return;
  writeStdoutLine(
    `warning: ${total} comment(s) by the reviewing account on ` +
      `${window.ownerRepo} MR ${window.prNumber} during this review window were not made by ` +
      `\`qwen review submit\` — the only sanctioned write in /review:`,
  );
  // The path is an MR-author-controlled filename reaching a terminal —
  // flatten it the way every other reviewer-facing path rendering does
  // (a legal git filename can carry control sequences).
  const where = (c: RawAoneComment): string =>
    typeof c.path === 'string' && c.path !== ''
      ? ` on ${inertPath(c.path)}${typeof c.line === 'number' ? `:${c.line}` : ''}`
      : '';
  for (const c of posted) {
    writeStdoutLine(
      `warning:   posted comment ${c.id} at ${c.createdAt}${where(c)}`,
    );
  }
  for (const c of edited) {
    writeStdoutLine(
      `warning:   edited comment ${c.id} at ${c.updatedAt}${where(c)}`,
    );
  }
  writeStdoutLine(bypassAuditFooter(me, 'MR'));
}

/**
 * Every scratch worktree standing beside `worktree`, in name order.
 *
 * A verifier's scratch tree is named for the shard that owns it, so the sweeper
 * cannot reconstruct the names — it recognises the family instead. Reading the
 * directory rather than trusting a pattern is deliberate: these are paths this
 * function is about to delete, and a real directory entry that starts with the
 * review's own `<worktree>-scratch-` prefix is a much narrower thing than any
 * string that matches a glob.
 */
function scratchWorktreesOf(worktree: string): {
  paths: string[];
  failed: boolean;
} {
  const prefix = scratchWorktreePrefix(worktree);
  const parent = dirname(resolve(worktree));
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch (err) {
    // ENOENT is the ordinary case: a review whose worktree was never created,
    // or one already cleaned. Anything else means the sweep did not happen —
    // and a silent skip leaks a full checkout per shard while stdout goes on to
    // announce "Nothing to clean", so it is disclosed the way the side-file
    // sweep below discloses its own read failures.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      writeStderrLine(
        `Failed to read ${parent} for scratch worktrees: ${(err as Error).message}`,
      );
      // Not merely disclosed: the caller must not go on to announce "Nothing to
      // clean" and clear the lease while N full checkouts stand unswept.
      return { paths: [], failed: true };
    }
    return { paths: [], failed: false };
  }
  // The LEAF checks below cannot see an ancestor: a symlink at `.qwen/tmp`
  // resolves for every path built under it, so the whole sweep — the `existsSync`
  // probes, `git worktree remove`, `releaseWorktree`'s recursive `rmSync` —
  // would run inside wherever that link points. Refusing the whole family is the
  // only answer that scopes: one entry cannot be trusted more than its parent.
  if (redirectedAncestor(parent) !== null) {
    return { paths: [], failed: true };
  }
  return {
    paths: entries
      .map((name) => join(parent, name))
      .filter((path) => path.startsWith(prefix))
      .sort(),
    failed: false,
  };
}

/**
 * Clear registrations whose worktree directory is gone. A no-op when none are.
 *
 * `releaseWorktree` runs this after its own unlink and says why: a
 * registration whose tree once stood at a path wedges the next
 * `git worktree add` there with `already exists`, and holds its branch checked
 * out against `branch -D`. Best-effort like every other step on the cleanup
 * path — a prune that fails must not mask the error that got us here.
 */
function pruneWorktrees(): void {
  try {
    execFileSync('git', ['worktree', 'prune'], {
      stdio: 'pipe',
      env: sanitizedGitEnv(),
    });
  } catch {
    // Reported by the next `worktree add` if it mattered.
  }
}

export function runCleanup(target: string): void {
  // --- Orphaned capture servers (capture-tui) ---------------------------
  // Host-wide and target-agnostic, run BEFORE the lease gate: a SIGKILL'd
  // or OOM'd harness — the shape this sweep exists for — leaves BOTH the
  // orphan and a lease held by the dead session, and the lease check is
  // session-id only, so a gated sweep skipped on exactly the cleanup calls
  // meant to reclaim the orphan and it lived out its bounded three hours
  // (probe-reproduced). The sweep only touches servers whose launcher pid
  // is dead — never a leased worktree — so hoisting it takes nothing from
  // the lease holder. Its reaps stay off removedAny: they are not
  // target-scoped facts, and a `cleanup pr-N` that found nothing of
  // pr-N's still answers "Nothing to clean" for pr-N beside the
  // host-wide "Reaped" line. Its failures DO still suppress that claim —
  // stderr saying "could not reap" next to stdout's "nothing to clean" is
  // the two streams contradicting each other, and stdout is the one a
  // script reads — but never gate the target-scoped lease release, which
  // keys on failedDestruction alone. It precedes the temp-dir refusal below
  // for that same reason: the sockets it reaps live under tmux's own socket
  // directory, never under REVIEW_TMP_DIR, so a redirected temp dir says
  // nothing about them — and a refusal there must not strand an orphan for
  // the whole of its bounded window.
  const { failed: sweepFailed } = reapOrphanedCaptureServers();

  // A bare `pr` target's sweep prefix (`qwen-review-pr-`) is a strict prefix
  // of EVERY PR family, and the lease guard lives inside the `pr-<n>` branch
  // below — which a bare `pr` never enters — so one `cleanup pr` deleted
  // every PR round's artifacts at once, unguarded (R20-4 follow-up: a
  // repo-root file literally named `pr` derives exactly this token). Refused
  // outright: no target legitimately owns that family prefix.
  if (safeTarget(target) === 'pr') {
    writeStderrLine(
      `Refusing to clean target "pr": its sweep prefix would match every ` +
        `PR review's artifacts (qwen-review-pr-<n>-*), and PR leases are ` +
        `checked per-number. For a file review of a path named "pr", remove ` +
        `only the plan you wrote and its -prompts directory.`,
    );
    process.exitCode = 1;
    return;
  }
  // Before anything is deleted: the whole temp dir hangs off one path, and a
  // symlink anywhere above it redirects EVERY sweep below — the scratch family,
  // the base-tree lock, the side files. The scratch sweep alone used to answer
  // this, which announced the hazard and then kept deleting under it.
  const redirected = redirectedAncestor(REVIEW_TMP_DIR);
  if (redirected !== null) {
    writeStderrLine(
      `Refusing to clean: ${redirected} is a symlink, so every delete under ` +
        `${REVIEW_TMP_DIR} would land wherever it points. Remove the link by ` +
        'hand, then re-run.',
    );
    process.exitCode = 1;
    return;
  }
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

    // The audit is network-bound (seconds) — and the ancestor gate at the top
    // of this function ran BEFORE it. A link that appears at any component of
    // the temp path during that window redirects every delete below it, so the
    // same refusal is re-taken here rather than assumed to still hold.
    const redirectedAfterAudit = redirectedAncestor(REVIEW_TMP_DIR);
    if (redirectedAfterAudit !== null) {
      writeStderrLine(
        `Refusing to clean: ${redirectedAfterAudit} became a symlink during ` +
          `the write audit, so every delete under ${REVIEW_TMP_DIR} would ` +
          'land wherever it points. Remove the link by hand, then re-run.',
      );
      process.exitCode = 1;
      return;
    }

    // A lease can appear during the same window (a review that started after
    // the gate above read none). Re-check before destroying anything and take
    // the same skip path (#9205).
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
      // A symlink at ANY family path must never reach `releaseWorktree`: its
      // `existsSync` follows a LIVE link, and `git worktree remove --force`
      // resolves it — together they delete whichever registered worktree the
      // link points at (the user's own, another review's live tree) while
      // reporting this path as swept, measured against the real function. A
      // DANGLING link is invisible to it for the opposite reason (`existsSync`
      // reports "never existed"), survives, and wedges the next review's
      // `worktree add` with `already exists`. `lstatSync` sees the link
      // itself, and `rmSync` unlinks it rather than following it — the same
      // reasoning `discardWorktree` documents for its own leftovers.
      let symlink = false;
      try {
        symlink = lstatSync(path).isSymbolicLink();
      } catch {
        // Absent, or gone between the two calls: `releaseWorktree` answers
        // both.
      }
      if (symlink) {
        try {
          rmSync(path, { force: true });
          // The registration outlives the link. `releaseWorktree` prunes after
          // its own unlink for this exact reason — "a registration whose tree
          // once stood at this path must not wedge the next `worktree add` or
          // hold the branch checked out" — and this branch returns before ever
          // reaching it, so the family paths were unlinked and reported swept
          // while their admin entries stayed behind. It is the only prune in
          // this function, and a no-op when nothing is stale.
          pruneWorktrees();
          writeStdoutLine(`Removed ${label} link: ${path}`);
          removedAny = true;
        } catch (err) {
          // `force` suppresses ENOENT, not EACCES/EBUSY — and a link left at a
          // family path still wedges the next review's `worktree add`, which is
          // the same "something that should be gone is still there" the three
          // sibling branches hold the lease for.
          failedDestruction = true;
          writeStderrLine(
            `Failed to remove ${label} link ${path}: ${(err as Error).message}`,
          );
          failedAny = true;
        }
        return;
      }
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

    // The Step 4 verifiers' scratch trees (#9207). One per verifier shard, and
    // the count is not knowable here — the label half is the shard's record key
    // — so this is the one sibling family swept by PREFIX rather than by name.
    // Listing the parent directory is what makes that safe: a glob over
    // `<wt>-scratch-*` is matched against real entries, never expanded into a
    // path that does not exist, and nothing outside the review's own temp dir
    // can match the prefix.
    const scratch = scratchWorktreesOf(wt);
    if (scratch.failed) {
      failedAny = true;
      // A family that could not even be LISTED means whole checkouts may still
      // stand, registered — the same class as a worktree that would not free,
      // so the lease stays held rather than releasing over an unswept review.
      failedDestruction = true;
    }
    for (const path of scratch.paths) {
      report('scratch worktree', path);
    }
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
        execFileSync('git', ['branch', '-D', branch], {
          stdio: 'pipe',
          // The CHECK that gates this delete resolves the real repository
          // (`refExists` goes through the sanitized helpers); an exported
          // `GIT_DIR` here would verify one repo and delete in another.
          env: sanitizedGitEnv(),
        });
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
    // THIS run's stop sidecar outlives its own cleanup: the PR stop path
    // writes the sidecar and runs cleanup in the same breath, and the
    // parent's first poll is up to 250 ms away — swept here, neither the
    // in-run snapshot nor the post-close fallback could ever observe the
    // decision, and an already-decided up-to-date/empty-diff round exited 1
    // "Review did not complete" (human review on #9659). The sidecar is
    // kept only when its runId matches the environment the parent stamped —
    // a foreign or unstamped one is residue and sweeps as before; the NEXT
    // run's cleanup (different nonce) collects this one.
    if (file === `${prefix}stop.json`) {
      const envRunId = process.env['QWEN_REVIEW_RUN_ID'];
      if (envRunId) {
        try {
          const sidecar = JSON.parse(
            readFileSync(join(REVIEW_TMP_DIR, file), 'utf8'),
          ) as { runId?: unknown };
          if (sidecar.runId === envRunId) {
            writeStdoutLine(
              `Kept ${join(REVIEW_TMP_DIR, file)}: this run's stop verdict — ` +
                `the parent reads it after the child exits; the next run's ` +
                `cleanup collects it.`,
            );
            continue;
          }
        } catch {
          // Unreadable or malformed: residue, swept below.
        }
      }
    }
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
  // not get rid of it, not when an entry was deliberately kept, and not when
  // a base could not be scanned at all — an unreadable directory can be
  // hiding exactly the thing this claim denies.
  if (!removedAny && !failedAny && !sweepFailed && preserved.size === 0) {
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
