/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review comment-status`: one deterministic pass over a PR's existing
// inline comments, emitting a per-thread status index — anchor validity at the
// live head, whether the anchored file changed in the reviewed worktree since
// the comment was filed (and which commits touched it), reply participation,
// and the blocker signal.
//
// This exists because the questions it answers used to be re-derived by the
// orchestrating model one `gh api` call at a time. Measured on a real
// heavily-discussed PR (#7632, 72 inline comments), a single review run made
// 20+ individual `gh api repos/…/pulls/comments/<id>` fetches — each a whole
// model turn — asking only "is this comment outdated?", "did the code move
// since?", "did anyone answer it?". Those are facts, not judgments; a
// subcommand answers all of them in one call. Bodies are NOT here: they stay
// in the pr-context file, which renders them under its untrusted-data
// preamble with per-comment fetch refs for anything it truncated.

import type { CommandModule } from 'yargs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD } from '@qwen-code/qwen-code-core';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import {
  currentUser,
  ensureAuthenticated,
  gh,
  ghApiAll,
  setGhHost,
} from './lib/gh.js';
import { gitOpt } from './lib/git.js';
import { worktreePath } from './lib/paths.js';
import {
  anyRootCarriesCriticalMarker,
  isBlockerBody,
  findRootId,
} from './pr-context.js';
import { detectPlatformKind } from './lib/platform/registry.js';
import { ensureAoneAuthenticated } from './lib/platform/aone-client.js';
import {
  aoneAccountName,
  aoneWhoami,
  getMrAuthorAndHead,
  listMrComments,
  type AoneMrComment,
} from './lib/platform/aone.js';

/** Inline review comment, as listed by `GET /pulls/{n}/comments`. */
export interface RawStatusComment {
  id: number;
  user?: { login: string } | null;
  body?: string;
  path?: string;
  /** Line in the PR's LATEST diff; null when GitHub cannot map the comment
   * to it (the anchor is outdated). File-level comments are always null. */
  line?: number | null;
  original_line?: number | null;
  /** SHA GitHub currently anchors the comment to. */
  commit_id?: string;
  /** SHA the comment was filed against. */
  original_commit_id?: string;
  in_reply_to_id?: number | null;
  created_at?: string;
  /** 'line' for ordinary comments, 'file' for file-level ones. */
  subject_type?: string;
}

/**
 * Answers "did `path` change between `sinceSha` and the worktree HEAD, and
 * which commits touched it?" — injected so the classification core stays
 * pure. `'unknown'` when the question cannot be answered (no worktree, the
 * comment's commit absent from the object store, path outside the repo).
 *
 * Force-push caveat: the worktree shares the main clone's object database,
 * so a force-pushed-away commit is often still PRESENT — the range then
 * spans the whole re-pushed branch rather than the intended window. That
 * errs fail-safe (it can over-report `changed: true`, never hide a change),
 * so it is accepted rather than special-cased.
 */
export type CodeChangeProbe = (
  path: string,
  sinceSha: string | undefined,
) => {
  changed: boolean | 'unknown';
  touchedBy: string[];
  touchedByTotal: number;
};

export interface ThreadStatus {
  rootId: number;
  path: string;
  author: string;
  createdAt: string;
  /** The root body asserts a blocking defect (same semantic test pr-context
   * uses to build its "Blockers to re-check" section). */
  isBlocker: boolean;
  anchor: {
    /** Current-diff line at the LIVE head; null = not mappable. */
    line: number | null;
    originalLine: number | null;
    /** line === null on a line-scoped comment: the anchor no longer maps to
     * the latest diff. File-level comments are never outdated. */
    outdated: boolean;
    isFileLevel: boolean;
    /** SHA the comment was filed against (falls back to the current anchor
     * SHA when the API omits original_commit_id). */
    commitId: string;
  };
  code: {
    /** Did the anchored file change between the comment's commit and the
     * WORKTREE head (the code this review is ruling on)? */
    changedSinceComment: boolean | 'unknown';
    /** Short SHAs of commits in that range touching the file, newest first,
     * capped — the candidate "fixed by" commits for the re-check. */
    touchedBy: string[];
    /** Real count before the cap — when it exceeds `touchedBy.length`, the
     * list was cut and a fix commit may be among the ones not shown. */
    touchedByTotal: number;
    /** True when the worktree HEAD no longer matches the live PR head: the
     * code facts above describe a superseded checkout. Denormalized onto
     * every thread so a `jq` filter over `threads[]` cannot skip the
     * top-level drift flag by construction. */
    staleWorktree: boolean;
  };
  replies: Array<{ id: number; author: string; createdAt: string }>;
  /** The PR author replied somewhere in this thread — the strongest cheap
   * signal that the concern has been seen (NOT that it is fixed). */
  authorReplied: boolean;
  participants: string[];
}

const TOUCHED_BY_CAP = 10;

/**
 * Pure classification core: group the flat comment list into threads and
 * compute each thread's status. Replies whose root was deleted (the id no
 * longer appears in the list) are dropped, matching pr-context's rendering
 * of the same data.
 */
export function buildThreadStatuses(
  comments: RawStatusComment[],
  prAuthor: string,
  probe: CodeChangeProbe,
  me: string = '',
): ThreadStatus[] {
  const byId = new Map<number, RawStatusComment>();
  for (const c of comments) byId.set(c.id, c);

  const repliesByRoot = new Map<number, RawStatusComment[]>();
  for (const c of comments) {
    if (c.in_reply_to_id === undefined || c.in_reply_to_id === null) continue;
    const rootId = findRootId(c.in_reply_to_id, byId);
    if (rootId === c.id) continue;
    if (!repliesByRoot.has(rootId)) repliesByRoot.set(rootId, []);
    repliesByRoot.get(rootId)!.push(c);
  }
  for (const replies of repliesByRoot.values()) {
    replies.sort((a, b) => a.id - b.id);
  }

  const authorLc = prAuthor.toLowerCase();
  const meLc = me.toLowerCase();
  const threads: ThreadStatus[] = [];
  for (const root of comments) {
    if (root.in_reply_to_id !== undefined && root.in_reply_to_id !== null) {
      continue;
    }
    const replies = repliesByRoot.get(root.id) ?? [];
    const isFileLevel = root.subject_type === 'file';
    const anchorSha = root.original_commit_id || root.commit_id || '';
    const probed = probe(root.path ?? '', anchorSha || undefined);
    const participants = [
      ...new Set([root, ...replies].map((c) => c.user?.login ?? 'unknown')),
    ];
    // The pipeline's own review summary posts as a pathless global comment:
    // Aone's flat comment list carries it into this index, while a GitHub
    // review body is not an inline comment, so only the Aone path can hand
    // one in. Compose renders its body-listed Criticals with the literal
    // **[Critical]** prefix, which carriesBlockerSignal's ungated channel
    // promotes — but a pathless thread never goes outdated and gives Step 6
    // no location to re-read, so the re-check can never rule it fixed: a
    // permanent, self-made blocker every round. Drop pathless own-account
    // roots from blocker promotion. Path-bearing own findings stay
    // re-checkable and keep theirs, and another account's pathless blocker
    // keeps its promotion through the ungated channel.
    const ownPathlessRoot =
      meLc !== '' &&
      (root.path ?? '') === '' &&
      (root.user?.login ?? '').toLowerCase() === meLc;
    threads.push({
      rootId: root.id,
      path: root.path ?? '',
      author: root.user?.login ?? 'unknown',
      createdAt: root.created_at ?? '',
      isBlocker: ownPathlessRoot
        ? false
        : isBlockerBody(root.body, root.user?.login, me),
      anchor: {
        line: root.line ?? null,
        originalLine: root.original_line ?? null,
        outdated:
          !isFileLevel && (root.line === null || root.line === undefined),
        isFileLevel,
        commitId: anchorSha,
      },
      code: {
        changedSinceComment: probed.changed,
        touchedBy: probed.touchedBy,
        touchedByTotal: probed.touchedByTotal,
        staleWorktree: false,
      },
      replies: replies.map((r) => ({
        id: r.id,
        author: r.user?.login ?? 'unknown',
        createdAt: r.created_at ?? '',
      })),
      // Guard the empty-author case: a deleted PR-author account and a
      // deleted reply account would otherwise match as '' === ''.
      authorReplied:
        authorLc !== '' &&
        replies.some((r) => (r.user?.login ?? '').toLowerCase() === authorLc),
      participants,
    });
  }

  threads.sort((a, b) => {
    const p = a.path.localeCompare(b.path);
    if (p !== 0) return p;
    const l = (a.anchor.originalLine ?? 0) - (b.anchor.originalLine ?? 0);
    if (l !== 0) return l;
    return a.rootId - b.rootId;
  });
  return threads;
}

export interface ThreadSummary {
  threads: number;
  outdated: number;
  blockers: number;
  changedSinceComment: number;
  changeUnknown: number;
  withReplies: number;
  authorReplied: number;
}

export function summarizeThreads(threads: ThreadStatus[]): ThreadSummary {
  return {
    threads: threads.length,
    outdated: threads.filter((t) => t.anchor.outdated).length,
    blockers: threads.filter((t) => t.isBlocker).length,
    changedSinceComment: threads.filter(
      (t) => t.code.changedSinceComment === true,
    ).length,
    changeUnknown: threads.filter(
      (t) => t.code.changedSinceComment === 'unknown',
    ).length,
    withReplies: threads.filter((t) => t.replies.length > 0).length,
    authorReplied: threads.filter((t) => t.authorReplied).length,
  };
}

/**
 * Git-backed probe. Every call is scoped to `worktree` with `git -C`, NOT to
 * the process CWD: the command runs from the trusted main checkout (so its
 * `--out` cannot be redirected through a symlink an untrusted PR planted in
 * its own tree), while the code facts must come from the PR's checked-out
 * worktree. Memoized per (path, sinceSha): several threads routinely anchor
 * to the same file at the same commit.
 */
export function makeGitProbe(worktree: string): CodeChangeProbe {
  const inRepo =
    gitOpt('-C', worktree, 'rev-parse', '--is-inside-work-tree') === 'true';
  const memo = new Map<string, ReturnType<CodeChangeProbe>>();
  // Ancestry depends on the SHA alone (HEAD is fixed for the run); memoizing
  // it apart from the (path, sha) results roughly halves the git spawns on a
  // thread-heavy PR where many threads share one anchor commit.
  const isAncestor = new Map<string, boolean>();
  return (path, sinceSha) => {
    if (!inRepo || !sinceSha || !path) {
      return { changed: 'unknown', touchedBy: [], touchedByTotal: 0 };
    }
    const key = `${sinceSha}\0${path}`;
    const hit = memo.get(key);
    if (hit) return hit;
    let result: ReturnType<CodeChangeProbe>;
    // `sinceSha..HEAD` is only meaningful when sinceSha is an ANCESTOR of the
    // worktree HEAD. After a force-push the comment's commit can survive in
    // the shared object database without being on the current history: the
    // range is then empty even though the trees differ, which would report a
    // changed file as `changed: false` — the one direction this index must
    // never fail in. `merge-base --is-ancestor` is exit 0 for an ancestor,
    // non-zero for a non-ancestor OR a missing commit (both → `null` here),
    // so this one call replaces the old existence check and closes that hole.
    let ancestor = isAncestor.get(sinceSha);
    if (ancestor === undefined) {
      ancestor =
        gitOpt(
          '-C',
          worktree,
          'merge-base',
          '--is-ancestor',
          sinceSha,
          'HEAD',
        ) !== null;
      isAncestor.set(sinceSha, ancestor);
    }
    if (!ancestor) {
      result = { changed: 'unknown', touchedBy: [], touchedByTotal: 0 };
    } else {
      // `:(top,literal)` anchors the pathspec at the repo root (so a subdir
      // CWD cannot silently mis-scope it) AND takes `path` literally — a
      // GitHub-supplied path is untrusted, and a value like `:(exclude)a.ts`
      // or `:(glob)**` would otherwise be read as pathspec magic and inspect
      // unrelated files.
      const log = gitOpt(
        '-C',
        worktree,
        'log',
        '--format=%h',
        `${sinceSha}..HEAD`,
        '--',
        `:(top,literal)${path}`,
      );
      if (log === null) {
        result = { changed: 'unknown', touchedBy: [], touchedByTotal: 0 };
      } else {
        const shas = log.split('\n').filter(Boolean);
        result = {
          changed: shas.length > 0,
          touchedBy: shas.slice(0, TOUCHED_BY_CAP),
          touchedByTotal: shas.length,
        };
      }
    }
    memo.set(key, result);
    return result;
  };
}

interface CommentStatusArgs {
  pr_number: string;
  owner_repo: string;
  out: string;
  // Read by the handler via setGhHost before runCommentStatus. Declared here so
  // the full contract is visible at the type level: if a future cleanup moves
  // the setGhHost call inside runCommentStatus, dropping host becomes a type
  // error rather than a silent runtime regression.
  host?: string;
}

/** The platform facts both runners collect before the shared report tail.
 *  `resolveMe` is the identity lookup the blocker-marker gate calls (and
 *  only calls) when a comment exists — a throw and an empty answer both
 *  count as unknown there. */
interface StatusRunFacts {
  prAuthor: string;
  liveHeadBefore: string;
  liveHeadAfter: string;
  comments: RawStatusComment[];
  resolveMe: () => string;
}

/**
 * One `a1 repo mr comment list` entry mapped into the GitHub-shaped input
 * the pure classification core reads. The two shape differences that matter:
 * a1 comments carry NO commit anchor (code facts degrade to `unknown` — the
 * probe is never handed a SHA), and a1's explicit `outdated` flag IS
 * GitHub's `line: null` (the anchor no longer maps to the live head's
 * diff). A pathless comment is an MR-level one (summaries ride the same
 * flat list) — file-level in the report's vocabulary, so it never reads as
 * outdated. A path-bearing comment with no line that the platform does NOT
 * call outdated is file-scoped the same way: the core derives `outdated`
 * from a null line on non-file-level threads, so letting it ride `line`
 * would fabricate a rewrite the platform never reported.
 */
export function aoneCommentToStatusComment(c: AoneMrComment): RawStatusComment {
  const line = typeof c.line === 'number' ? c.line : null;
  return {
    id: c.id,
    user: { login: aoneAccountName(c.author) },
    body: c.note ?? c.body ?? '',
    path: c.path,
    line: c.outdated === true ? null : line,
    original_line: line,
    commit_id: undefined,
    original_commit_id: undefined,
    in_reply_to_id: c.parentNoteId ?? undefined,
    created_at:
      typeof c.createdAt === 'string'
        ? c.createdAt
        : typeof c.created_at === 'string'
          ? c.created_at
          : '',
    subject_type:
      c.path && (line !== null || c.outdated === true) ? 'line' : 'file',
  };
}

/** Shared report tail: worktree/drift facts, the identity gate, thread
 *  classification, and the write + warnings. Both platform runners feed it
 *  the same shape, so the report contract has one implementation. */
function writeCommentStatusReport(
  args: { pr_number: string; owner_repo: string; out: string },
  facts: StatusRunFacts,
): void {
  const { pr_number: prNumber, owner_repo: ownerRepo, out } = args;
  const { prAuthor, liveHeadBefore, liveHeadAfter, comments } = facts;

  const worktree = worktreePath(prNumber);
  const worktreeHeadSha = gitOpt('-C', worktree, 'rev-parse', 'HEAD');
  // A null HEAD means the worktree is absent (comment-status run before
  // fetch-pr, or after cleanup) — every thread's code facts then degrade to
  // 'unknown', which must not pass silently as if the files were unchanged.
  const worktreeMissing = worktreeHeadSha === null;
  // Anchor facts (`line`, outdated) describe the LIVE head — the platform
  // maps comments against the latest diff it serves. Code facts
  // (`touchedBy`, changedSinceComment) describe the WORKTREE head — the
  // code this review rules on. Two distinct conditions:
  //  - worktreeStale: the checked-out code lags the live head, so the code
  //    facts describe a SUPERSEDED checkout (this is what staleWorktree means
  //    per-thread — NOT the union below).
  //  - headMovedDuringFetch: the head moved between the two samples, so the
  //    anchor facts may be mixed across commits even if the worktree happens
  //    to match the final head; that is a separate warning, not staleness.
  const headMovedDuringFetch =
    liveHeadBefore !== '' &&
    liveHeadAfter !== '' &&
    liveHeadBefore !== liveHeadAfter;
  const worktreeStale =
    !worktreeMissing &&
    liveHeadAfter !== '' &&
    worktreeHeadSha !== liveHeadAfter;
  const headDrift = headMovedDuringFetch || worktreeStale;

  // The reviewing account gates the comment marker's blocker promotion —
  // the same gate pr-context applies, so this report and the context file
  // agree on what is a blocker. Both unknown shapes fail closed
  // identically — a thrown lookup AND an empty login (a stubbed or
  // proxied transport exiting 0 with no output) — when a posted root comment
  // carries a critical marker: an index that silently undercounts
  // blockers reads as complete, while the report's degradation contract
  // is an `error` a consumer sees.
  let me = '';
  if (comments.length) {
    let lookupError: unknown = null;
    try {
      me = facts.resolveMe();
    } catch (err) {
      lookupError = err;
    }
    if (me === '' && anyRootCarriesCriticalMarker(comments)) {
      throw new Error(
        `cannot determine the reviewing account (${
          lookupError === null
            ? 'empty login'
            : lookupError instanceof Error
              ? lookupError.message
              : String(lookupError)
        }) while a posted root comment carries a Qwen critical marker — ` +
          'the blocker signal depends on it; re-run',
      );
    }
  }

  const threads = buildThreadStatuses(
    comments,
    prAuthor,
    makeGitProbe(worktree),
    me,
  );
  if (worktreeStale) {
    // Denormalize onto every thread: the code facts describe a superseded
    // checkout, and a jq consumer of threads[] must not need to remember a
    // top-level flag to see that. Keyed on worktreeStale specifically — a
    // head that merely moved mid-fetch while the worktree matches the final
    // head is NOT a superseded checkout.
    for (const t of threads) t.code.staleWorktree = true;
  }
  const summary = summarizeThreads(threads);

  const report = {
    prNumber,
    ownerRepo,
    prAuthor,
    liveHeadSha: liveHeadAfter,
    liveHeadBefore,
    worktreeHeadSha,
    worktreeMissing,
    headDrift,
    headMovedDuringFetch,
    inlineComments: comments.length,
    summary,
    threads,
  };

  mkdirSync(dirname(out), { recursive: true });
  const json = JSON.stringify(report, null, 2) + '\n';
  writeFileSync(out, json, 'utf8');
  writeStdoutLine(
    `Wrote comment-status report to ${out} (${comments.length} inline comments in ${summary.threads} threads: ` +
      `${summary.outdated} outdated, ${summary.blockers} blocker(s), ` +
      `${summary.changedSinceComment} on files changed since their comment, ` +
      `${summary.withReplies} with replies, ${summary.authorReplied} answered by the PR author)`,
  );
  if (worktreeMissing) {
    writeStdoutLine(
      `warning: no worktree at ${worktree} — run \`qwen review fetch-pr\` first. ` +
        `Every thread's code facts (changedSinceComment, touchedBy) are \`unknown\`; ` +
        `only the anchor and reply facts are usable.`,
    );
  }
  if (headMovedDuringFetch) {
    writeStdoutLine(
      `warning: PR head moved during the comments fetch (${liveHeadBefore.slice(0, 8)} → ${liveHeadAfter.slice(0, 8)}) — ` +
        `anchor facts may be mixed across commits. Re-run after the push settles.`,
    );
  } else if (worktreeStale) {
    writeStdoutLine(
      `warning: worktree HEAD ${(worktreeHeadSha ?? '').slice(0, 8)} != live PR head ${liveHeadAfter.slice(0, 8)} — ` +
        `the PR advanced since fetch-pr. Anchor facts describe the live head; ` +
        `code facts describe the worktree.`,
    );
  }
  // Same silent-tail hazard pr-context already warns about, with sharper
  // teeth here: `threads` is sorted by path, so a truncated read drops the
  // alphabetically-later files WHOLESALE (measured on a 71-thread PR: one
  // read showed 35 threads and lost 24 blocker-flagged ones), and cut JSON
  // is not merely incomplete but unparseable.
  if (json.length > DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD) {
    writeStdoutLine(
      `warning: ${out} is ${json.length} chars; read_file returns the first ` +
        `${DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD} and sets isTruncated — cut JSON does not parse. ` +
        `Query it with jq (it is machine-shaped), or page with offset/limit until isTruncated is false.`,
    );
  }
}

/** The degraded report both runners fall back to. */
function writeDegradedCommentStatusReport(
  args: { pr_number: string; owner_repo: string; out: string },
  msg: string,
): void {
  const { pr_number: prNumber, owner_repo: ownerRepo, out } = args;
  writeStdoutLine(
    `warning: comment-status failed: ${msg}. It is an index, not the ` +
      `evidence — re-derive thread statuses per-comment if needed.`,
  );
  mkdirSync(dirname(out), { recursive: true });
  // Emit the SAME shape as the success report (with an added `error`), not a
  // stripped one: a consumer reading `report.headDrift` on a stripped report
  // gets `undefined` (falsy = "no drift"), silently mistaking a total index
  // failure for a clean "nothing moved". Safe defaults + `error` let a
  // consumer that checks `error` see the failure and one that reads a fact
  // get a neutral value, never a misleading one.
  writeFileSync(
    out,
    JSON.stringify(
      {
        prNumber,
        ownerRepo,
        error: msg,
        // null, not '': the success path emits '' only for a legitimately
        // absent author (deleted account). A degraded run knows nothing about
        // the author, so a structural null (matching worktreeHeadSha below)
        // keeps a consumer that displays the author name from rendering a
        // blank as if it were a real empty value.
        prAuthor: null,
        liveHeadSha: '',
        liveHeadBefore: '',
        worktreeHeadSha: null,
        // Consistent with `worktreeHeadSha: null` (the success path derives
        // worktreeMissing from exactly that) and fail-safe: a degraded run
        // has no usable worktree, so `true` reads code facts as unavailable
        // rather than falsely asserting the worktree is present.
        worktreeMissing: true,
        headDrift: false,
        headMovedDuringFetch: false,
        inlineComments: 0,
        summary: summarizeThreads([]),
        threads: [],
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
}

async function runCommentStatus(args: CommentStatusArgs): Promise<void> {
  const { pr_number: prNumber, owner_repo: ownerRepo } = args;
  if (ownerRepo.indexOf('/') < 0) {
    throw new Error('owner_repo must look like "owner/repo"');
  }
  const [owner, repo] = ownerRepo.split('/');

  // Graceful degradation per SKILL.md: this command is an index, not the
  // evidence — a runtime failure (auth, network, gh) must not kill the
  // review. On any throw, write a minimal empty report so downstream jq
  // still parses, warn, and exit 0; Step 6 then re-derives statuses per
  // comment.
  try {
    ensureAuthenticated();

    // Sample the live head BEFORE the comments fetch and AGAIN after: GitHub
    // maps comment lines against whatever head is current when the list is
    // served, so a push landing mid-fetch would pair anchor facts from a newer
    // head with a stale drift comparison. If the two samples disagree the PR is
    // moving right now — treat it as drift.
    const meta = JSON.parse(
      gh(
        'pr',
        'view',
        prNumber,
        '--repo',
        ownerRepo,
        '--json',
        'author,headRefOid',
      ),
    ) as { author?: { login?: string } | null; headRefOid?: string };
    const prAuthor = meta.author?.login ?? '';
    const liveHeadBefore = meta.headRefOid ?? '';

    const comments = ghApiAll(
      `repos/${owner}/${repo}/pulls/${prNumber}/comments`,
    ) as RawStatusComment[];

    // Second head sample for race detection (headMovedDuringFetch). This is an
    // enhancement, not a core fact: if it fails transiently AFTER the comments
    // were already fetched, fall back to liveHeadBefore instead of discarding
    // the whole report (comments + anchor facts are already in hand). With the
    // fallback, headMovedDuringFetch reads false — the safe default (assume the
    // head did not move) — and worktreeStale still compares the worktree against
    // liveHeadBefore, so a usable drift signal survives.
    let liveHeadAfter = liveHeadBefore;
    try {
      liveHeadAfter =
        (
          JSON.parse(
            gh(
              'pr',
              'view',
              prNumber,
              '--repo',
              ownerRepo,
              '--json',
              'headRefOid',
            ),
          ) as { headRefOid?: string }
        ).headRefOid ?? liveHeadBefore;
    } catch {
      // Race-detection sample unavailable; liveHeadBefore is a usable fallback.
    }

    writeCommentStatusReport(args, {
      prAuthor,
      liveHeadBefore,
      liveHeadAfter,
      comments,
      resolveMe: currentUser,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeDegradedCommentStatusReport(args, msg);
  }
}

/** The Aone runner. Same report contract and degradation harness as the
 *  GitHub path; the platform differences are the data source (a1), the
 *  comment mapping (no commit anchors, explicit `outdated`), and the
 *  identity lookup (`a1 auth whoami`). */
async function runCommentStatusAone(args: CommentStatusArgs): Promise<void> {
  const { pr_number: prNumber, owner_repo: ownerRepo } = args;
  if (ownerRepo.indexOf('/') < 0) {
    throw new Error('owner_repo must look like "owner/repo"');
  }
  // Validate the raw token BEFORE coercing, with the same grammar fetch-pr
  // uses: Number() alone accepts '012'/'1e3'/' 12'/'12.0' and would query a
  // different MR than the caller's label (and the worktree path) carries.
  // The skill path rides parse-args' digit grammar; this is the direct-CLI
  // surface.
  if (!/^[1-9]\d*$/.test(prNumber)) {
    throw new Error(
      'pr_number must be a positive integer (the Aone global MR id)',
    );
  }
  const mrId = Number(prNumber);

  try {
    // The gate doubles as the account read (presubmit's twin consumes it
    // the same way): a SECOND whoami wired into the identity gate would
    // re-run the lookup after the MR fetch, where a transient a1 outage
    // throws and discards a fully fetched index over a query already
    // answered. The truthy form keeps the gate's legitimate empty-string
    // answer falling back to a fresh whoami.
    const gateAccount = ensureAoneAuthenticated();

    // The same two-sample race detection as the GitHub path: the provider
    // resolves either AGit's source SHA or a branch MR's exact head ref, and
    // a push between the sample and the comment list would stale the facts.
    const before = getMrAuthorAndHead(mrId, ownerRepo);
    const prAuthor = before.author;
    const liveHeadBefore = before.headSha;

    const comments = listMrComments(mrId, ownerRepo).map(
      aoneCommentToStatusComment,
    );

    let liveHeadAfter = liveHeadBefore;
    try {
      liveHeadAfter =
        getMrAuthorAndHead(mrId, ownerRepo).headSha || liveHeadBefore;
    } catch {
      // Race-detection sample unavailable; liveHeadBefore is a usable fallback.
    }

    writeCommentStatusReport(args, {
      prAuthor,
      liveHeadBefore,
      liveHeadAfter,
      comments,
      resolveMe: gateAccount ? () => gateAccount : aoneWhoami,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    writeDegradedCommentStatusReport(args, msg);
  }
}

export const commentStatusCommand: CommandModule = {
  command: 'comment-status <pr_number> <owner_repo>',
  describe:
    "Emit a per-thread status index for a PR's existing inline comments (anchor validity, code drift since each comment, replies, blocker signal)",
  builder: (yargs) =>
    yargs
      .positional('pr_number', {
        type: 'string',
        demandOption: true,
        describe: 'PR number',
      })
      .positional('owner_repo', {
        type: 'string',
        demandOption: true,
        describe: 'GitHub "owner/repo"',
      })
      .option('out', {
        type: 'string',
        demandOption: true,
        describe: 'Output JSON path (will be overwritten)',
      })
      .option('host', {
        type: 'string',
        describe:
          "The host the target lives on. An Aone host (*.alibaba-inc.com) selects the a1 backend; omitted: detected from the clone's origin, else GitHub (GH_HOST, then github.com).",
      }),
  handler: async (argv) => {
    const host = (argv as { host?: string }).host;
    if (detectPlatformKind({ host }) === 'aone') {
      await runCommentStatusAone(argv as unknown as CommentStatusArgs);
      return;
    }
    setGhHost(host);
    await runCommentStatus(argv as unknown as CommentStatusArgs);
  },
};
