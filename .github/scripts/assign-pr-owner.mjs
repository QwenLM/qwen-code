#!/usr/bin/env node
// Assign a PR to one area owner, derived purely from the PR's changed file
// paths.
//
// PR-side companion to assign-issue-owner.mjs. The script never reads PR
// title, body, or comments, so untrusted PR text cannot steer who gets
// assigned. The diff's file paths are matched against the optional `paths`
// list of each area in .github/issue-owners.json; the longest matching
// prefix wins, so a module-level entry overrides the coarser fallback area
// that contains it. The assignee is the area's least loaded eligible
// owner, rotated by PR number on ties — the same load metric and rotation as
// issue assignment. Push access is re-verified against the live collaborator
// API before the write, coverage is re-checked against the live PR
// immediately before it, and the run no-ops once any mapped owner is already
// an assignee or has reviewed, so repeated pushes never stack assignments.
import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  loadPolicy,
  openIssueCount,
  pickOwner,
} from './assign-issue-owner.mjs';

const OWNERS_FILE = '.github/issue-owners.json';
const WRITE_PERMISSIONS = new Set(['admin', 'maintain', 'write']);
const BOT_LOGIN = /(\[bot\]|-bot)$/;

function gh(args) {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `gh ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

function record(lines) {
  const body = `${lines.join('\n')}\n`;
  process.stdout.write(body);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, body);
  }
}

export function skipPrReason(pr) {
  if (pr.state !== 'OPEN') return 'PR is not open';
  if (pr.isDraft) return 'PR is a draft';
  // `gh pr view --json author` exports `"author": null` once the account is
  // deleted; skip gracefully like the other skip reasons instead of throwing
  // on the null dereference and failing the check on every later trigger.
  const authorLogin = pr.author?.login;
  if (!authorLogin) return 'PR author account was deleted';
  if (BOT_LOGIN.test(authorLogin)) return 'authored by a bot';
  return null;
}

// The longest matching prefix wins, so a module entry overrides the coarser
// area that contains it; ties keep the earlier area in file order. Areas
// without a paths list never match.
export function matchedAreasByPath(policy, files) {
  const ranked = [];
  for (const area of policy.areas) {
    let length = 0;
    for (const prefix of area.paths ?? []) {
      if (files.some((file) => file.path.startsWith(prefix))) {
        length = Math.max(length, prefix.length);
      }
    }
    if (length > 0) ranked.push({ area, length });
  }
  ranked.sort((a, b) => b.length - a.length);
  return ranked.map((entry) => entry.area);
}

export function matchAreaByPath(policy, files) {
  return matchedAreasByPath(policy, files)[0] ?? null;
}

// An assignee or a submitted review by any mapped owner means this routing
// already happened; never stack a second assignment.
export function alreadyCovered(policy, pr) {
  const pool = new Set(
    policy.areas
      .flatMap((area) => area.owners)
      .map((login) => login.toLowerCase()),
  );
  const involved = [
    ...pr.assignees.map((assignee) => assignee.login),
    ...pr.latestReviews.map((review) => review.author?.login),
  ];
  return involved.some((login) => login && pool.has(login.toLowerCase()));
}

// Same stale-entry tolerance as the issue script: a candidate who lost push
// access is dropped with a warning, not a failed run.
function canWrite(repository, login) {
  try {
    return WRITE_PERMISSIONS.has(
      gh([
        'api',
        `repos/${repository}/collaborators/${login}/permission`,
        '--jq',
        '.permission',
      ]),
    );
  } catch (error) {
    console.warn(
      `::warning::Cannot verify push access for @${login}: ${error.message}`,
    );
    return false;
  }
}

// Same warn-and-continue tolerance as canWrite(): the load fan-out is one
// `gh issue list` per eligible owner (up to 15 for the core pool), and one
// transient failure — secondary rate limit, 5xx, issues disabled — must not
// fail the run on the contributor's PR. Retry once, then degrade to a zero
// load so the rotation still lands an owner; the load metric is a tie-break
// heuristic, not a gate on assigning.
function ownerLoad(repository, login) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return openIssueCount(repository, login);
    } catch (error) {
      lastError = error;
    }
  }
  console.warn(
    `::warning::Cannot read open-issue load for @${login}: ${lastError.message}`,
  );
  return 0;
}

// `gh pr view --json files` caps at 100 entries, so the REST files endpoint
// pages through every changed file instead. Each filename is decoded from
// base64 because changed filenames are attacker-controlled on fork PRs and
// git accepts newlines in path components: splitting the rendered text on
// newlines would let a name like "x<LF>packages/core/poc" inject a phantom
// "packages/core/poc" entry that steers which area owner gets assigned.
export function changedFiles(repository, prNumber) {
  return gh([
    'api',
    `repos/${repository}/pulls/${prNumber}/files`,
    '--paginate',
    '--jq',
    '.[] | (.filename, (.previous_filename // empty)) | @base64',
  ])
    .split('\n')
    .filter(Boolean)
    .map((line) => ({
      path: Buffer.from(line, 'base64').toString('utf8'),
    }));
}

function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const prNumber = Number(process.env.PR_NUMBER);
  const dryRun = process.env.DRY_RUN === 'true';
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error('Invalid repository');
  }
  if (!Number.isSafeInteger(prNumber) || prNumber < 1) {
    throw new Error('Invalid PR number');
  }

  const policy = loadPolicy(readFileSync(OWNERS_FILE, 'utf8'));
  const pr = JSON.parse(
    gh([
      'pr',
      'view',
      String(prNumber),
      '--repo',
      repository,
      '--json',
      'state,isDraft,author,assignees,latestReviews,headRefOid',
    ]),
  );
  pr.files = changedFiles(repository, prNumber);

  const skip = skipPrReason(pr);
  if (skip) {
    record([`Assignment: skipped — ${skip}`]);
    return;
  }
  if (alreadyCovered(policy, pr)) {
    record(['Assignment: skipped — a mapped owner is already on the PR']);
    return;
  }
  const matched = matchedAreasByPath(policy, pr.files);
  if (matched.length === 0) {
    record(['Assignment: skipped — no area path matched']);
    return;
  }

  // Never assign the PR author to their own work. When a module's owner
  // cannot take the PR (they authored it, or lost push access), fall back
  // to the next coarser matching area instead of leaving the PR unassigned.
  // The null guard mirrors skipPrReason's: a deleted account exports as
  // `"author": null` and can exclude no one.
  const authorLogin = (pr.author?.login ?? '').toLowerCase();
  let area;
  let eligible;
  for (area of matched) {
    eligible = area.owners.filter(
      (owner) =>
        owner.toLowerCase() !== authorLogin && canWrite(repository, owner),
    );
    if (eligible.length > 0) break;
  }
  if (!eligible || eligible.length === 0) {
    console.warn(
      `::warning::No eligible owner for the areas touched by this PR; check ${OWNERS_FILE}.`,
    );
    record(['Assignment: skipped — no eligible owner for the matched areas']);
    return;
  }
  if (area !== matched[0]) {
    record([
      `Area ${matched[0].name} has no eligible owner (author or no push access); falling back to ${area.name}`,
    ]);
  }

  const loadByOwner = new Map(
    eligible.map((owner) => [owner, ownerLoad(repository, owner)]),
  );
  const assignee = pickOwner(eligible, loadByOwner, prNumber);

  if (dryRun) {
    record([
      `Area: ${area.name}`,
      `Assignment: dry-run — would assign @${assignee} (${loadByOwner.get(assignee)} open)`,
    ]);
    return;
  }

  // Between the opening snapshot and this write sit up to ~30 sequential API
  // calls (permission and load per candidate), and during that window a
  // human or a concurrent run may already have put a mapped owner on the PR
  // or closed it. Re-check the live PR immediately before mutating,
  // mirroring the sibling issue script's pre-write re-fetch, so a covered PR
  // is never assigned twice.
  const latestPr = JSON.parse(
    gh([
      'pr',
      'view',
      String(prNumber),
      '--repo',
      repository,
      '--json',
      'state,isDraft,author,assignees,latestReviews,headRefOid',
    ]),
  );
  const latestSkip = skipPrReason(latestPr);
  if (latestSkip) {
    record([`Assignment: skipped — ${latestSkip}`]);
    return;
  }
  if (latestPr.headRefOid !== pr.headRefOid) {
    record(['Assignment: skipped — PR head changed during routing']);
    return;
  }
  if (alreadyCovered(policy, latestPr)) {
    record(['Assignment: skipped — a mapped owner is already on the PR']);
    return;
  }

  try {
    gh([
      'pr',
      'edit',
      String(prNumber),
      '--repo',
      repository,
      '--add-assignee',
      assignee,
    ]);
  } catch (error) {
    if (/assigning agents is not supported/i.test(error.message)) {
      // A PR that already carries a coding-agent assignee can only change
      // its actor list through replaceActorsForAssignable, which GitHub
      // refuses for GitHub App installation tokens. The PR already has an
      // accountable actor, so skip like the other token-limit cases instead
      // of failing the check on the contributor's PR.
      record([
        'Assignment: skipped — token cannot assign PRs with agent assignees',
      ]);
      return;
    }
    if (
      /permission|403|resource not accessible by integration/i.test(
        error.message,
      )
    ) {
      record(['Assignment: skipped — token cannot assign PRs']);
      return;
    }
    throw error;
  }
  record([
    `Area: ${area.name}`,
    `Assignment: assigned @${assignee} (${loadByOwner.get(assignee)} open)`,
  ]);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
