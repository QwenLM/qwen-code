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
import { ensureAuthenticated, gh, ghApiAll, setGhHost } from './lib/gh.js';
import { gitOpt } from './lib/git.js';
import { worktreePath } from './lib/paths.js';
import { carriesBlockerSignal, findRootId } from './pr-context.js';

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
    threads.push({
      rootId: root.id,
      path: root.path ?? '',
      author: root.user?.login ?? 'unknown',
      createdAt: root.created_at ?? '',
      isBlocker: carriesBlockerSignal(root.body),
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
}

async function runCommentStatus(args: CommentStatusArgs): Promise<void> {
  const { pr_number: prNumber, owner_repo: ownerRepo, out } = args;
  if (ownerRepo.indexOf('/') < 0) {
    throw new Error('owner_repo must look like "owner/repo"');
  }
  const [owner, repo] = ownerRepo.split('/');

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

  const liveHeadAfter =
    (
      JSON.parse(
        gh('pr', 'view', prNumber, '--repo', ownerRepo, '--json', 'headRefOid'),
      ) as { headRefOid?: string }
    ).headRefOid ?? '';

  const worktree = worktreePath(prNumber);
  const worktreeHeadSha = gitOpt('-C', worktree, 'rev-parse', 'HEAD');
  // Anchor facts (`line`, outdated) describe the LIVE head — GitHub maps
  // comments against the latest diff it serves. Code facts (`touchedBy`,
  // changedSinceComment) describe the WORKTREE head — the code this review
  // rules on. Drift when the worktree lags the live head, OR when the head
  // moved between the two samples (a push raced the fetch).
  const headMovedDuringFetch =
    liveHeadBefore !== '' &&
    liveHeadAfter !== '' &&
    liveHeadBefore !== liveHeadAfter;
  const worktreeStale =
    worktreeHeadSha !== null &&
    liveHeadAfter !== '' &&
    worktreeHeadSha !== liveHeadAfter;
  const headDrift = headMovedDuringFetch || worktreeStale;

  const threads = buildThreadStatuses(
    comments,
    prAuthor,
    makeGitProbe(worktree),
  );
  if (headDrift) {
    // Denormalize the drift onto every thread: the code facts describe a
    // superseded checkout, and a jq consumer of threads[] must not need to
    // remember a top-level flag to see that.
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
          'GitHub host for this PR (GitHub Enterprise). Routes every gh call in this command via GH_HOST; omit for github.com.',
      }),
  handler: async (argv) => {
    setGhHost((argv as { host?: string }).host);
    await runCommentStatus(argv as unknown as CommentStatusArgs);
  },
};
