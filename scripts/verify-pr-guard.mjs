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
 *   node verify-pr-guard.mjs --compare --start <file> --now <file>
 *
 * Exit codes: 0 clean / snapshot written, 1 dirty or fetch failed, 2 usage.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isEntryPoint } from './lib/entry-point.js';

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
  node scripts/verify-pr-guard.mjs --compare --start <file> --now <file>

--snapshot fetches the head, the PR state and all three comment lists with
--paginate, and writes them only when every call succeeded. A failed call exits
1 and leaves no file, so a retry cannot be mistaken for a snapshot.

--compare is fail-closed: a malformed snapshot, a moved head, a changed state, a
new or edited item, a vanished item, or a list shorter than the start snapshot
all report dirty. A short list is a failed fetch, not a quiet PR. Edits are read
from the body and the review state as well as the timestamp, because neither
editing nor dismissing a review moves a timestamp. Passing the same file as both
sides is a usage error, not a clean round.

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
export function fetchSnapshot({ pr, repo, run }) {
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

function parseArgs(argv) {
  const out = {
    pr: null,
    repo: null,
    snapshot: null,
    compare: false,
    start: null,
    now: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--compare') out.compare = true;
    else if (arg === '--pr') out.pr = Number(argv[++i]);
    else if (arg === '--repo') out.repo = argv[++i];
    else if (arg === '--snapshot') out.snapshot = argv[++i];
    else if (arg === '--start') out.start = argv[++i];
    else if (arg === '--now') out.now = argv[++i];
  }
  return out;
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

  if (args.compare) {
    if (!args.start || !args.now) {
      process.stderr.write(
        `verify-pr guard: --compare needs --start and --now\n\n${HELP}`,
      );
      return 2;
    }
    // Comparing a snapshot with itself answers nothing about what landed, and
    // a copy-pasted path would otherwise report the cleanest possible round.
    if (resolve(args.start) === resolve(args.now)) {
      process.stderr.write(
        'verify-pr guard: --start and --now are the same file; re-fetch into a second path before comparing\n',
      );
      return 2;
    }
    const { clean, reasons } = compareSnapshots(
      readSnapshot(args.start),
      readSnapshot(args.now),
    );
    const lines = [`verify-pr guard: ${clean ? 'clean' : 'dirty'}`];
    for (const reason of reasons) lines.push(`  ${reason}`);
    if (!clean) {
      lines.push(
        '  read what arrived, fold it into the report, refresh the snapshot, then re-run the guard',
      );
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    return clean ? 0 : 1;
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
  writeFileSync(args.snapshot, `${JSON.stringify(snapshot, null, 2)}\n`);
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
