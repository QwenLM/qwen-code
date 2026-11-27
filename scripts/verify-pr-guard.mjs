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
 *   node verify-pr-guard.mjs --pr <n> --repo <owner>/<repo> --snapshot <file>
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
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { isEntryPoint } from './lib/entry-point.js';
import { GUARD_VERDICT_SCHEMA } from './verify-pr-check.mjs';

export { GUARD_VERDICT_SCHEMA };

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

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
  node scripts/verify-pr-guard.mjs --pr <n> --repo <owner>/<repo> --snapshot <file>
  node scripts/verify-pr-guard.mjs --compare --start <file> --now <file> [--out <verdict-file>]

--snapshot fetches the head, the PR state and all three comment lists with
--paginate, and writes them only when every call succeeded. A failed call exits
1 and leaves no file, so a retry cannot be mistaken for a snapshot.

--compare is fail-closed: a malformed snapshot, a moved head, a changed state, a
new or edited item, a vanished item, or a list shorter than the start snapshot
all report dirty. A short list is a failed fetch, not a quiet PR. Edits are read
from the body and the review state as well as the timestamp, because neither
editing nor dismissing a review moves a timestamp. Passing the same file (or an
alias to it) as both sides is a usage error, not a clean round.

With --out <verdict-file>, --compare writes a structured ${GUARD_VERDICT_SCHEMA}
record (both on clean and on dirty, so a stale clean record at the same path
cannot survive a dirty re-check). On a clean round it prints \`guard-sha256\` so
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
      return null;
    }
    try {
      return JSON.parse(result.stdout);
    } catch {
      errors.push(`${label}: response was not JSON`);
      return null;
    }
  };

  const meta = call(
    ['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefOid,state'],
    'pr view',
  );
  const snapshot = {
    pr,
    repo,
    headRefOid: meta?.headRefOid ?? null,
    state: meta?.state ?? null,
    capturedAt: now().toISOString(),
  };

  for (const [key, path, carriesState] of LISTS) {
    // `--paginate` merges array pages into one JSON array (verified on gh
    // 2.103.0: 17 comments over 4 pages parsed as a single array). `--slurp`
    // would instead nest one array per page and break the normalize below.
    const items = call(
      ['api', '--paginate', path(pr).replace('{repo}', repo)],
      key,
    );
    if (items === null) continue;
    if (!Array.isArray(items)) {
      errors.push(`${key}: expected an array, got ${typeof items}`);
      continue;
    }
    snapshot[key] = normalize(items, carriesState);
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
  return { ok: true, errors: [], snapshot };
}

/** A snapshot is only usable when every list is present and well-formed. */
export function isSnapshot(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  if (!Number.isInteger(value.pr) || value.pr <= 0) return false;
  if (typeof value.repo !== 'string' || !value.repo.includes('/')) return false;
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
    compare: false,
    start: null,
    now: null,
    out: null,
    unknown: null,
    missingValue: null,
  };
  const nextVal = (flag, i) => {
    if (i + 1 >= argv.length) {
      out.missingValue = flag;
      return null;
    }
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--compare') out.compare = true;
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

function safeWriteFile(filePath, content) {
  try {
    const st = lstatSync(filePath);
    if (st.isSymbolicLink()) {
      return {
        ok: false,
        error: `refusing to write through symbolic link ${filePath}`,
      };
    }
    if (!st.isFile()) {
      return {
        ok: false,
        error: `refusing to write to non-regular file ${filePath}`,
      };
    }
    if (st.nlink !== 1) {
      return {
        ok: false,
        error: `refusing to write through hard link ${filePath} (${st.nlink} names)`,
      };
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return {
        ok: false,
        error: `cannot inspect output path ${filePath}: ${error.message}`,
      };
    }
  }
  try {
    writeFileSync(filePath, content);
    const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
    return { ok: true, sha256 };
  } catch (error) {
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
    !args.snapshot
  ) {
    process.stderr.write(
      `verify-pr guard: --pr, --repo and --snapshot are required\n\n${HELP}`,
    );
    return 2;
  }
  const run = (ghArgs) =>
    spawnSync('gh', ghArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const { ok, errors, snapshot } = fetchSnapshot({
    pr: args.pr,
    repo: args.repo,
    run,
  });
  if (!ok) {
    process.stderr.write(
      `verify-pr guard: snapshot refused, nothing written\n${errors.map((e) => `  ${e}\n`).join('')}`,
    );
    return 1;
  }
  const written = safeWriteFile(
    args.snapshot,
    `${JSON.stringify(snapshot, null, 2)}\n`,
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
