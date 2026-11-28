#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The pre-publish guard for a local `/verify-pr` round.
 *
 * The skill asks the round to snapshot every review, review comment and issue
 * comment at the start, re-fetch immediately before posting, and abort on
 * anything new or edited. Hand-run, that rule fails open: a re-fetch that errors
 * returns no items, "is anything new?" answers "no", and the guard reads clean.
 * A round measured exactly that — 324 review comments at the start, 0 on the
 * re-fetch, because the call failed rather than the PR going quiet.
 *
 * So this script owns both halves. A failed fetch is fatal and writes no
 * snapshot, and a comparison treats a missing or short list as dirty. Neither
 * path can produce a clean verdict from an unanswered question.
 *
 * Usage:
 *   node verify-pr-guard.mjs --pr <n> --repo <owner>/<repo> --snapshot <file> [--no-clobber]
 *   node verify-pr-guard.mjs --compare --start <file> --now <file> [--out <verdict-file>]
 *
 * Exit codes: 0 clean / snapshot written, 1 dirty or fetch failed, 2 usage.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { isEntryPoint } from './lib/entry-point.js';
import { GUARD_VERDICT_SCHEMA } from './verify-pr-check.mjs';

export { GUARD_VERDICT_SCHEMA };

// Checked against live GitHub PRs (#18549, #18494, #18522): single
// non-paginated closing probe run after all paginated list fetches finish so
// any push, state transition, formal review addition/edit/dismissal (covering
// up to the last 100 reviews with body), new top-level comment, or in-place
// edit of an earlier top-level comment arriving during pagination is caught
// atomically before the snapshot is written.
export const GUARD_CONFIRM_QUERY =
  'query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { headRefOid state reviews(last: 100) { totalCount nodes { databaseId state submittedAt body } } comments(last: 1) { totalCount nodes { databaseId updatedAt } } latestEditedComment: comments(first: 1, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { databaseId updatedAt body } } } } }';

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const REPO_SLUG_RE = /^[\w.-]+\/[\w.-]+$/;

function isIsoUtcTimestamp(value) {
  if (typeof value !== 'string' || !ISO_UTC_RE.test(value)) return false;
  const ms = Date.parse(value);
  return (
    Number.isFinite(ms) &&
    new Date(ms).toISOString().startsWith(value.slice(0, 19))
  );
}

/**
 * The three lists the guard covers; `--paginate` or only the first 30 arrive.
 * The third column says whether the list's items carry a review state, which
 * only reviews do and which a dismissal changes on its own.
 */
const LISTS = [
  ['reviews', (pr) => `repos/{repo}/pulls/${pr}/reviews`, true],
  ['reviewComments', (pr) => `repos/{repo}/pulls/${pr}/comments`, false],
  ['issueComments', (pr) => `repos/{repo}/issues/${pr}/comments`, false],
];

const HELP = `Usage:
  node scripts/verify-pr-guard.mjs --pr <n> --repo <owner>/<repo> --snapshot <file> [--no-clobber]
  node scripts/verify-pr-guard.mjs --compare --start <file> --now <file> [--out <verdict-file>]

--snapshot fetches the head and PR state, paginates all three comment lists,
re-checks the earlier review/review-comment lists, then runs a single
non-paginated closing GraphQL probe after all paginated fetches complete to
confirm head, PR state, formal review count and recent reviews (state,
submittedAt, and body), top-level comment count/latest created comment, and
most-recently-updated top-level comment all remained unchanged. It writes the
file only when every call succeeded with valid JSON objects/arrays and the
opening and closing reads match. A failed fetch or failed write exits 1 and
leaves no stale regular snapshot behind (removing any stale regular snapshot
already at that path while refusing to touch symlinks, hardlinks, or
non-regular files), so a retry after a failed refresh cannot be mistaken for a
fresh snapshot.

With --no-clobber (for round-start snapshots in a per-round host directory),
--snapshot creates the file exclusively (O_EXCL) and exits 1 without touching
or deleting an existing file, preventing concurrent rounds from overwriting
each other's start snapshot.

--compare is fail-closed: a malformed snapshot, a moved head, a changed state, a
new or edited item, a vanished item, or a list shorter than the start snapshot
all report dirty. A short list is a failed fetch, not a quiet PR. Edits are read
from the body and the review state as well as the timestamp, because neither
editing nor dismissing a review moves a timestamp. Passing the same file (or an
alias to it) as both sides is a usage error, not a clean round.

With --out <verdict-file>, --compare writes a structured ${GUARD_VERDICT_SCHEMA}
record (both on clean and on dirty, so a stale clean record at the same path
cannot survive a dirty re-check; a write failure also invalidates any stale
regular verdict at that path). On a clean round it prints \`guard-sha256\` so
verify-pr-check.mjs --require-guard --guard <file> --guard-sha256 <digest> can
bind the verdict before posting.

Exit codes: 0 clean / written, 1 dirty or fetch failed, 2 usage.
`;

/**
 * Reviews carry `submitted_at`, not `updated_at`, so reading one field name
 * across all three lists leaves one of them comparing `undefined` with
 * `undefined`. Neither stamp moves when a review body is edited, or when a
 * review is dismissed — measured against this repo's API — so the body and the
 * review state travel with the stamp and are compared too. These are the
 * fields that change what a reviewer said or decided; reaction counts and
 * other metadata are deliberately left out, so a thumbs-up is not a dirty
 * round.
 */
function stampOf(item) {
  return item?.updated_at ?? item?.submitted_at ?? null;
}

function normalize(items, carriesState) {
  return items.map((item) => ({
    id: item.id,
    stamp: stampOf(item),
    body: item.body,
    ...(carriesState ? { state: item.state } : {}),
  }));
}

/**
 * Fetches every list. `run` is injected so tests can drive the failure paths
 * without a network; it returns a spawnSync-shaped result.
 */
export function fetchSnapshot({ pr, repo, run, now = () => new Date() }) {
  const errors = [];
  const call = (args, label) => {
    const result = run(args);
    if (result.status !== 0) {
      errors.push(
        `${label}: gh exited ${result.status ?? 'null'}${result.stderr ? ` — ${result.stderr.trim().split('\n')[0]}` : ''}`,
      );
      return { ok: false, value: null };
    }
    try {
      return { ok: true, value: JSON.parse(result.stdout) };
    } catch {
      errors.push(`${label}: response was not JSON`);
      return { ok: false, value: null };
    }
  };

  const isPlainObject = (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const describeType = (value) =>
    value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

  const capturedAt = now().toISOString();
  const metaRes = call(
    ['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid,state'],
    'pr view',
  );
  if (metaRes.ok && !isPlainObject(metaRes.value)) {
    errors.push(
      `pr view: expected an object, got ${describeType(metaRes.value)}`,
    );
  }
  const metaObj =
    metaRes.ok && isPlainObject(metaRes.value) ? metaRes.value : null;
  const snapshot = {
    pr,
    repo,
    headRefOid: metaObj?.headRefOid ?? null,
    state: metaObj?.state ?? null,
    capturedAt,
  };

  const canonicalListKey = (list) =>
    JSON.stringify([...list].sort((a, b) => (a.id ?? 0) - (b.id ?? 0)));

  for (const [key, path, carriesState] of LISTS) {
    // `--paginate` merges array pages into one JSON array (verified on gh
    // 2.103.0: 17 comments over 4 pages parsed as a single array). `--slurp`
    // would instead nest one array per page and break the normalize below.
    const itemsRes = call(
      ['api', '--paginate', path(pr).replace('{repo}', repo)],
      key,
    );
    if (!itemsRes.ok) continue;
    if (!Array.isArray(itemsRes.value)) {
      errors.push(
        `${key}: expected an array, got ${describeType(itemsRes.value)}`,
      );
      continue;
    }
    if (!itemsRes.value.every(isPlainObject)) {
      errors.push(`${key}: expected an array of objects`);
      continue;
    }
    snapshot[key] = normalize(itemsRes.value, carriesState);
  }

  if (errors.length > 0) return { ok: false, errors, snapshot: null };
  if (!isSnapshot(snapshot)) {
    return {
      ok: false,
      errors: [
        'fetched snapshot failed validation: a head OID, a state, or an id, body or review state in one of the lists is missing or malformed',
      ],
      snapshot: null,
    };
  }

  // First re-check the earlier paginated lists (`reviews` and `reviewComments`)
  // so edits, dismissals, or additions during the first pass are caught, then
  // run one lightweight non-paginated GraphQL closing probe AFTER all
  // paginated fetches finish so any push, state change, formal review, or
  // top-level comment arriving during the second pagination pass is rejected.
  for (const [key, path, carriesState] of LISTS.slice(0, -1)) {
    const confirmListRes = call(
      ['api', '--paginate', path(pr).replace('{repo}', repo)],
      `${key} (confirm)`,
    );
    if (!confirmListRes.ok) continue;
    if (!Array.isArray(confirmListRes.value)) {
      errors.push(
        `${key} (confirm): expected an array, got ${describeType(confirmListRes.value)}`,
      );
      continue;
    }
    if (!confirmListRes.value.every(isPlainObject)) {
      errors.push(`${key} (confirm): expected an array of objects`);
      continue;
    }
    const confirmed = normalize(confirmListRes.value, carriesState);
    if (canonicalListKey(confirmed) !== canonicalListKey(snapshot[key])) {
      errors.push(
        `${key} changed during snapshot fetch; re-fetch before comparing`,
      );
    }
  }

  if (errors.length === 0) {
    const [owner, name] = repo.split('/');
    const confirmRes = call(
      [
        'api',
        'graphql',
        '-f',
        `owner=${owner}`,
        '-f',
        `name=${name}`,
        '-F',
        `number=${pr}`,
        '-f',
        `query=${GUARD_CONFIRM_QUERY}`,
      ],
      'guard confirm',
    );
    if (confirmRes.ok) {
      if (
        isPlainObject(confirmRes.value) &&
        Array.isArray(confirmRes.value.errors) &&
        confirmRes.value.errors.length > 0
      ) {
        errors.push('guard confirm: GraphQL response returned errors');
      } else {
        const pull = isPlainObject(confirmRes.value)
          ? confirmRes.value?.data?.repository?.pullRequest
          : undefined;
        if (!isPlainObject(pull)) {
          errors.push(
            `guard confirm: expected pullRequest object, got ${describeType(pull ?? confirmRes.value)}`,
          );
        } else {
          if (pull.headRefOid !== metaObj.headRefOid) {
            errors.push(
              `PR head moved during snapshot fetch (${metaObj.headRefOid} -> ${pull.headRefOid}); re-fetch before comparing`,
            );
          }
          if (pull.state !== metaObj.state) {
            errors.push(
              `PR state changed during snapshot fetch (${metaObj.state} -> ${pull.state}); re-fetch before comparing`,
            );
          }

          const latestById = (list) =>
            list.length === 0
              ? null
              : list.reduce((max, item) => (item.id > max.id ? item : max));

          const checkConnection = (conn, list, label, extraFields) => {
            if (
              !isPlainObject(conn) ||
              !Number.isInteger(conn.totalCount) ||
              conn.totalCount < 0 ||
              !Array.isArray(conn.nodes) ||
              !conn.nodes.every(isPlainObject)
            ) {
              errors.push(
                `guard confirm: malformed ${label} summary in closing probe`,
              );
              return;
            }
            if (conn.totalCount !== list.length) {
              errors.push(
                `${label} changed during snapshot fetch (${list.length} -> ${conn.totalCount}); re-fetch before comparing`,
              );
              return;
            }
            if (conn.totalCount === 0) {
              if (conn.nodes.length !== 0) {
                errors.push(
                  `guard confirm: malformed ${label} summary in closing probe`,
                );
              }
              return;
            }
            if (conn.nodes.length !== 1) {
              errors.push(
                `guard confirm: missing latest ${label} node in closing probe`,
              );
              return;
            }
            const latest = latestById(list);
            const node = conn.nodes[0];
            if (node.databaseId !== latest.id || !extraFields(node, latest)) {
              errors.push(
                `${label} changed during snapshot fetch; re-fetch before comparing`,
              );
            }
          };

          const normalizeNewlines = (text) => text.replace(/\r\n/g, '\n');

          // Check formal reviews (last 100, with state/submittedAt/body) so
          // edits or state changes to earlier reviews and body-only edits to
          // the latest review arriving during the final pagination pass are
          // caught atomically.
          const reviewsConn = pull.reviews;
          if (
            !isPlainObject(reviewsConn) ||
            !Number.isInteger(reviewsConn.totalCount) ||
            reviewsConn.totalCount < 0 ||
            !Array.isArray(reviewsConn.nodes) ||
            !reviewsConn.nodes.every(isPlainObject)
          ) {
            errors.push(
              'guard confirm: malformed reviews summary in closing probe',
            );
          } else if (reviewsConn.totalCount !== snapshot.reviews.length) {
            errors.push(
              `reviews changed during snapshot fetch (${snapshot.reviews.length} -> ${reviewsConn.totalCount}); re-fetch before comparing`,
            );
          } else {
            const expectedReviewNodes = Math.min(100, snapshot.reviews.length);
            if (reviewsConn.nodes.length !== expectedReviewNodes) {
              errors.push(
                `guard confirm: expected ${expectedReviewNodes} review node(s) in closing probe, got ${reviewsConn.nodes.length}`,
              );
            } else {
              const reviewsById = new Map(
                snapshot.reviews.map((item) => [item.id, item]),
              );
              const seenReviewIds = new Set();
              let reviewChanged = false;
              let malformedReviewBody = false;
              for (const node of reviewsConn.nodes) {
                if (typeof node.body !== 'string') {
                  malformedReviewBody = true;
                  break;
                }
                if (seenReviewIds.has(node.databaseId)) {
                  reviewChanged = true;
                  break;
                }
                seenReviewIds.add(node.databaseId);
                const matched = reviewsById.get(node.databaseId);
                if (
                  !matched ||
                  node.state !== matched.state ||
                  (node.submittedAt ?? null) !== matched.stamp ||
                  normalizeNewlines(node.body) !==
                    normalizeNewlines(matched.body)
                ) {
                  reviewChanged = true;
                  break;
                }
              }
              if (malformedReviewBody) {
                errors.push(
                  'guard confirm: malformed review body in closing probe',
                );
              } else if (reviewChanged) {
                errors.push(
                  'reviews changed during snapshot fetch; re-fetch before comparing',
                );
              }
            }
          }

          checkConnection(
            pull.comments,
            snapshot.issueComments,
            'issueComments',
            (node, latest) => (node.updatedAt ?? null) === latest.stamp,
          );

          // Catch in-place edits of an earlier top-level comment (such as a
          // bot updating an older status comment to P1 while comment count and
          // last-created comment stay unchanged).
          const editedConn = pull.latestEditedComment;
          if (
            !isPlainObject(editedConn) ||
            !Array.isArray(editedConn.nodes) ||
            !editedConn.nodes.every(isPlainObject)
          ) {
            errors.push(
              'guard confirm: malformed latestEditedComment summary in closing probe',
            );
          } else if (snapshot.issueComments.length === 0) {
            if (editedConn.nodes.length !== 0) {
              errors.push(
                'issueComments changed during snapshot fetch; re-fetch before comparing',
              );
            }
          } else if (editedConn.nodes.length !== 1) {
            errors.push(
              'guard confirm: missing latestEditedComment node in closing probe',
            );
          } else {
            const editedNode = editedConn.nodes[0];
            if (typeof editedNode.body !== 'string') {
              errors.push(
                'guard confirm: malformed latestEditedComment body in closing probe',
              );
            } else {
              const matched = snapshot.issueComments.find(
                (comment) => comment.id === editedNode.databaseId,
              );
              const editedStamp = editedNode.updatedAt ?? null;
              const stampTimes = snapshot.issueComments
                .map((comment) =>
                  comment.stamp === null ? NaN : Date.parse(comment.stamp),
                )
                .filter((ms) => Number.isFinite(ms));
              const maxStampMs =
                stampTimes.length > 0 ? Math.max(...stampTimes) : null;
              const editedStampMs =
                editedStamp === null ? NaN : Date.parse(editedStamp);
              if (
                !matched ||
                editedStamp !== matched.stamp ||
                normalizeNewlines(editedNode.body) !==
                  normalizeNewlines(matched.body) ||
                (maxStampMs !== null &&
                  (!Number.isFinite(editedStampMs) ||
                    editedStampMs !== maxStampMs))
              ) {
                errors.push(
                  'issueComments changed during snapshot fetch; re-fetch before comparing',
                );
              }
            }
          }
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors, snapshot: null };
  return { ok: true, errors: [], snapshot };
}

/** A snapshot is only usable when every list is present and well-formed. */
export function isSnapshot(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  if (!Number.isInteger(value.pr) || value.pr <= 0) return false;
  if (typeof value.repo !== 'string' || !REPO_SLUG_RE.test(value.repo)) {
    return false;
  }
  if (!/^[0-9a-f]{40}$/.test(value.headRefOid ?? '')) return false;
  if (typeof value.state !== 'string' || value.state === '') return false;
  if (value.capturedAt !== undefined && !isIsoUtcTimestamp(value.capturedAt)) {
    return false;
  }
  return LISTS.every(([key, , carriesState]) => {
    const list = value[key];
    return (
      Array.isArray(list) &&
      list.every(
        (item) =>
          item &&
          Number.isInteger(item.id) &&
          (item.stamp === null || typeof item.stamp === 'string') &&
          // A list that cannot answer "was anything edited?" or "was a review
          // dismissed?" is refused, not compared as if the answer were no.
          typeof item.body === 'string' &&
          (carriesState
            ? typeof item.state === 'string'
            : item.state === undefined),
      )
    );
  });
}

/**
 * Compares two snapshots. Every reason is reported, not just the first: the
 * round has to read what arrived and fold it in, so a truncated list of
 * reasons costs another fetch.
 */
export function compareSnapshots(start, now) {
  const reasons = [];
  for (const [label, snapshot] of [
    ['start', start],
    ['now', now],
  ]) {
    if (!isSnapshot(snapshot)) {
      reasons.push(`${label} snapshot is missing or malformed`);
    }
  }
  if (reasons.length > 0) return { clean: false, reasons };

  if (start.pr !== now.pr || start.repo !== now.repo) {
    reasons.push(
      `snapshots describe different PRs: ${start.repo}#${start.pr} vs ${now.repo}#${now.pr}`,
    );
  }
  if (
    start.capturedAt !== undefined &&
    now.capturedAt !== undefined &&
    Date.parse(now.capturedAt) < Date.parse(start.capturedAt)
  ) {
    reasons.push(
      `now snapshot (${now.capturedAt}) is older than start snapshot (${start.capturedAt})`,
    );
  }
  if (start.headRefOid !== now.headRefOid) {
    reasons.push(`head moved ${start.headRefOid} -> ${now.headRefOid}`);
  }
  if (start.state !== now.state) {
    reasons.push(`PR state changed ${start.state} -> ${now.state}`);
  }

  for (const [key] of LISTS) {
    const before = start[key];
    const after = now[key];
    const short = after.length < before.length;
    if (short) {
      reasons.push(
        `${key}: re-fetch returned ${after.length} of ${before.length} items — a short list is a failed fetch, not a quiet PR`,
      );
    }
    const byId = new Map(after.map((item) => [item.id, item]));
    const startIds = new Set(before.map((item) => item.id));
    let missing = 0;
    for (const item of before) {
      const seen = byId.get(item.id);
      if (!seen) {
        // A short list already says the fetch was truncated. Naming every
        // absent id buries that one actionable line under hundreds of echoes.
        if (short) missing++;
        else reasons.push(`${key}: ${item.id} disappeared`);
      } else if (seen.stamp !== item.stamp) {
        reasons.push(
          `${key}: ${item.id} was edited (${item.stamp} -> ${seen.stamp})`,
        );
      } else if (seen.body !== item.body) {
        reasons.push(`${key}: ${item.id} was edited (body changed)`);
      } else if (seen.state !== item.state) {
        reasons.push(
          `${key}: ${item.id} changed state (${item.state} -> ${seen.state})`,
        );
      }
    }
    if (missing > 0) {
      reasons.push(
        `${key}: ${missing} ids absent from the re-fetch (implied by the short list)`,
      );
    }
    for (const item of after) {
      if (!startIds.has(item.id)) reasons.push(`${key}: ${item.id} is new`);
    }
  }

  return { clean: reasons.length === 0, reasons };
}

/**
 * Builds the machine-readable verdict record written by `--compare --out`.
 * `verify-pr-check.mjs --guard` verifies this record's schema, PR coordinates,
 * head OID, OPEN state, clean status, and snapshot freshness before posting.
 */
export function buildGuardVerdict({
  start,
  now,
  result,
  comparedAt = new Date().toISOString(),
}) {
  const validStart = isSnapshot(start);
  const validNow = isSnapshot(now);
  return {
    schema: GUARD_VERDICT_SCHEMA,
    clean: Boolean(result?.clean),
    repo: (validNow ? now.repo : validStart ? start.repo : null) ?? null,
    pr: (validNow ? now.pr : validStart ? start.pr : null) ?? null,
    startHeadRefOid: validStart ? start.headRefOid : null,
    nowHeadRefOid: validNow ? now.headRefOid : null,
    startState: validStart ? start.state : null,
    nowState: validNow ? now.state : null,
    startCapturedAt: validStart ? (start.capturedAt ?? null) : null,
    nowCapturedAt: validNow ? (now.capturedAt ?? null) : null,
    comparedAt,
    reasons: Array.isArray(result?.reasons) ? [...result.reasons] : [],
  };
}

function parseArgs(argv) {
  const out = {
    pr: null,
    repo: null,
    snapshot: null,
    noClobber: false,
    compare: false,
    start: null,
    now: null,
    out: null,
    unknown: null,
    missingValue: null,
  };
  const nextVal = (flag, i) => {
    if (i + 1 >= argv.length || argv[i + 1] === '') {
      out.missingValue = flag;
      return null;
    }
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--compare') out.compare = true;
    else if (arg === '--no-clobber') out.noClobber = true;
    else if (arg === '--pr') {
      const val = nextVal(arg, i);
      if (val === null) break;
      out.pr = Number(val);
      i++;
    } else if (arg === '--repo') {
      const val = nextVal(arg, i);
      if (val === null) break;
      out.repo = val;
      i++;
    } else if (arg === '--snapshot') {
      const val = nextVal(arg, i);
      if (val === null) break;
      out.snapshot = val;
      i++;
    } else if (arg === '--start') {
      const val = nextVal(arg, i);
      if (val === null) break;
      out.start = val;
      i++;
    } else if (arg === '--now') {
      const val = nextVal(arg, i);
      if (val === null) break;
      out.now = val;
      i++;
    } else if (arg === '--out') {
      const val = nextVal(arg, i);
      if (val === null) break;
      out.out = val;
      i++;
    } else if (arg.startsWith('-')) {
      out.unknown = arg;
      break;
    } else {
      out.unknown = arg;
      break;
    }
  }
  return out;
}

function canonicalizeForIdentity(p) {
  try {
    return realpathSync(p);
  } catch {
    try {
      return join(realpathSync(dirname(p)), basename(p));
    } catch {
      return resolve(p);
    }
  }
}

function sameFilePath(a, b) {
  if (resolve(a) === resolve(b)) return true;
  if (canonicalizeForIdentity(a) === canonicalizeForIdentity(b)) return true;
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    if (
      sa.ino !== 0 &&
      sb.ino !== 0 &&
      sa.dev === sb.dev &&
      sa.ino === sb.ino
    ) {
      return true;
    }
  } catch {
    // Missing files cannot share an inode.
  }
  return false;
}

function inspectWritableTarget(filePath, { noClobber = false } = {}) {
  try {
    const st = lstatSync(filePath);
    if (noClobber) {
      return {
        ok: false,
        existedRegular: false,
        error: `refusing to overwrite existing snapshot ${filePath} (--no-clobber); use a dedicated per-round host directory`,
      };
    }
    if (st.isSymbolicLink()) {
      return {
        ok: false,
        existedRegular: false,
        error: `refusing to write through symbolic link ${filePath}`,
      };
    }
    if (!st.isFile()) {
      return {
        ok: false,
        existedRegular: false,
        error: `refusing to write to non-regular file ${filePath}`,
      };
    }
    if (st.nlink !== 1) {
      return {
        ok: false,
        existedRegular: false,
        error: `refusing to write through hard link ${filePath} (${st.nlink} names)`,
      };
    }
    return { ok: true, existedRegular: true };
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return {
        ok: false,
        existedRegular: false,
        error: `cannot inspect output path ${filePath}: ${error.message}`,
      };
    }
    return { ok: true, existedRegular: false };
  }
}

function removeStaleSnapshot(filePath) {
  const checked = inspectWritableTarget(filePath);
  if (!checked.ok) return { removed: false, error: checked.error };
  if (!checked.existedRegular) return { removed: false, error: null };
  try {
    unlinkSync(filePath);
    return { removed: true, error: null };
  } catch (error) {
    if (error?.code === 'ENOENT') return { removed: false, error: null };
    return {
      removed: false,
      error: `could not remove stale snapshot ${filePath}: ${error.message}`,
    };
  }
}

function safeWriteFile(filePath, content, { noClobber = false } = {}) {
  const checked = inspectWritableTarget(filePath, { noClobber });
  if (!checked.ok) {
    return { ok: false, error: checked.error };
  }
  try {
    writeFileSync(filePath, content, noClobber ? { flag: 'wx' } : undefined);
    const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
    return { ok: true, sha256 };
  } catch (error) {
    if (noClobber && error?.code === 'EEXIST') {
      return {
        ok: false,
        error: `refusing to overwrite existing snapshot ${filePath} (--no-clobber); use a dedicated per-round host directory`,
      };
    }
    // On refresh/verdict overwrites, invalidate any stale regular file left
    // behind (for example a chmod-444 snapshot in a writable directory, or a
    // partial write on ENOSPC) so subsequent compares cannot pass on old data.
    if (!noClobber) {
      const cleaned = removeStaleSnapshot(filePath);
      if (cleaned.removed) {
        return {
          ok: false,
          error: `cannot write ${filePath}: ${error.message} (removed stale ${filePath})`,
        };
      }
      if (cleaned.error) {
        return {
          ok: false,
          error: `cannot write ${filePath}: ${error.message}; ${cleaned.error}`,
        };
      }
    }
    return {
      ok: false,
      error: `cannot write ${filePath}: ${error.message}`,
    };
  }
}

function readSnapshot(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  const args = parseArgs(argv);
  if (args.missingValue) {
    process.stderr.write(
      `verify-pr guard: ${args.missingValue} requires a value\n\n${HELP}`,
    );
    return 2;
  }
  if (args.unknown) {
    process.stderr.write(
      `verify-pr guard: unknown option ${args.unknown}\n\n${HELP}`,
    );
    return 2;
  }

  if (args.compare) {
    if (args.noClobber) {
      process.stderr.write(
        `verify-pr guard: --no-clobber is only valid with --snapshot\n\n${HELP}`,
      );
      return 2;
    }
    if (!args.start || !args.now) {
      process.stderr.write(
        `verify-pr guard: --compare needs --start and --now\n\n${HELP}`,
      );
      return 2;
    }
    // Comparing a snapshot with itself (directly or via a symlink/hardlink)
    // answers nothing about what landed, and a copy-pasted path would
    // otherwise report the cleanest possible round.
    if (sameFilePath(args.start, args.now)) {
      process.stderr.write(
        'verify-pr guard: --start and --now are the same file; re-fetch into a second path before comparing\n',
      );
      return 2;
    }
    if (
      args.out &&
      (sameFilePath(args.out, args.start) || sameFilePath(args.out, args.now))
    ) {
      process.stderr.write(
        'verify-pr guard: --out must not point to the --start or --now snapshot file\n',
      );
      return 2;
    }
    const startSnap = readSnapshot(args.start);
    const nowSnap = readSnapshot(args.now);
    const result = compareSnapshots(startSnap, nowSnap);
    const { clean, reasons } = result;
    let verdictSha256 = null;
    if (args.out) {
      const verdict = buildGuardVerdict({
        start: startSnap,
        now: nowSnap,
        result,
      });
      const serialized = `${JSON.stringify(verdict, null, 2)}\n`;
      const written = safeWriteFile(args.out, serialized);
      if (!written.ok) {
        process.stderr.write(`verify-pr guard: ${written.error}\n`);
        return 1;
      }
      verdictSha256 = written.sha256;
    }
    const lines = [`verify-pr guard: ${clean ? 'clean' : 'dirty'}`];
    if (clean && args.out && verdictSha256) {
      lines.push(`  guard-verdict  ${args.out}`);
      lines.push(`  guard-sha256  ${verdictSha256}`);
    }
    for (const reason of reasons) lines.push(`  ${reason}`);
    if (!clean) {
      lines.push(
        '  read what arrived, fold it into the report, refresh the snapshot, then re-run the guard',
      );
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    return clean ? 0 : 1;
  }

  if (args.out) {
    process.stderr.write(
      `verify-pr guard: --out is only valid with --compare\n\n${HELP}`,
    );
    return 2;
  }

  if (
    !Number.isInteger(args.pr) ||
    args.pr <= 0 ||
    !args.repo ||
    !REPO_SLUG_RE.test(args.repo) ||
    !args.snapshot
  ) {
    process.stderr.write(
      `verify-pr guard: --pr, --repo (<owner>/<repo>) and --snapshot are required\n\n${HELP}`,
    );
    return 2;
  }
  const targetCheck = inspectWritableTarget(args.snapshot, {
    noClobber: args.noClobber,
  });
  if (!targetCheck.ok) {
    process.stderr.write(`verify-pr guard: ${targetCheck.error}\n`);
    return 1;
  }
  const run = (ghArgs) =>
    spawnSync('gh', ghArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const { ok, errors, snapshot } = fetchSnapshot({
    pr: args.pr,
    repo: args.repo,
    run,
  });
  if (!ok) {
    const cleaned = args.noClobber
      ? { removed: false, error: null }
      : removeStaleSnapshot(args.snapshot);
    const statusNote = cleaned.removed
      ? `removed stale ${args.snapshot}`
      : 'nothing written';
    const extra = cleaned.error ? `  ${cleaned.error}\n` : '';
    process.stderr.write(
      `verify-pr guard: snapshot refused, ${statusNote}\n${errors.map((e) => `  ${e}\n`).join('')}${extra}`,
    );
    return 1;
  }
  const written = safeWriteFile(
    args.snapshot,
    `${JSON.stringify(snapshot, null, 2)}\n`,
    { noClobber: args.noClobber },
  );
  if (!written.ok) {
    process.stderr.write(`verify-pr guard: ${written.error}\n`);
    return 1;
  }
  const counts = LISTS.map(([key]) => `${key} ${snapshot[key].length}`).join(
    ', ',
  );
  process.stdout.write(
    `verify-pr guard: wrote ${args.snapshot} (${counts}) at ${snapshot.headRefOid}\n`,
  );
  return 0;
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
