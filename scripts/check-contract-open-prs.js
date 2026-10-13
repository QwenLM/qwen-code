/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// check-contract-version.js checks a pull request's contract document
// against the base ref of the moment it ran, and nothing re-runs it when
// main later moves: a PR that declared the next version stays green after
// another PR takes that version, and whichever of them merges second
// publishes the number twice — 2026-10-09 saw four contract-changing PRs
// in flight at once with 1.34.0 claimed twice (#13804, mirroring #13742).
// This script runs against a checkout of main after every push that
// changes the contract document, and on a schedule. It reads each open
// PR's changed paths from the GraphQL API and each claiming PR's document
// through the contents API — one file, answered as text; no PR code is
// checked out or run — and sets a commit status on every PR head that
// declares a version: failure when the version does not advance past
// main's current one, success otherwise, naming the other open PRs that
// claim the same version, so the second of them turns red as soon as the
// first one lands. A head document that reads back byte-identical to
// main's declares nothing at all, even when the changed-paths list names
// the document. A PR whose file list or head document could not be read in
// full gets error unless the parts read already answer. A head that
// already carries the status is re-evaluated even when it no longer
// changes the document, so a stale failure is cleared; a head whose status
// already says the same is left alone, so a schedule does not pile
// statuses onto it.

import { appendFileSync, readFileSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  CONTRACT_DOCUMENT,
  compareVersions,
  documentVersion,
} from './contract-version-utils.js';

export const STATUS_CONTEXT = 'API contract version uniqueness (latest main)';

// GraphQL aborts a query after 10 s; 50 PRs with their file lists took ~5 s.
const PRS_QUERY = `query($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, baseRefName: "main", first: 25, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        headRefOid
        changedFiles
        commits(last: 1) {
          nodes {
            commit {
              oid
              status {
                context(name: "${STATUS_CONTEXT}") { state description }
              }
            }
          }
        }
        files(first: 100) {
          pageInfo { hasNextPage endCursor }
          nodes { path changeType }
        }
      }
    }
  }
}`;

const FILES_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      files(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { path changeType }
      }
    }
  }
}`;

// File pages and head-document reads share one budget, about four minutes
// of calls: a flood of huge PRs is reported as not checked instead of
// pushing every run past its timeout.
const API_PAGE_BUDGET = 100;

// The runner parses `::` and `##[` commands from the job log, and the
// error messages neutralized here come from the API.
const neutralize = (text) =>
  text.replace(/\s+/g, ' ').replace(/::/g, ';;').replace(/##\[/g, '##［');

// main's document text and declared version from the checkout. Comparing
// head documents byte-for-byte is what lets a PR whose edit lands nothing
// declare no claim at all. A main whose document did not read and parse
// must not compare anything: an empty stand-in would pass every claim, so
// the run refuses instead.
export function mainContract(root) {
  let text;
  try {
    text = readFileSync(path.join(root, CONTRACT_DOCUMENT), 'utf8').trim();
  } catch {
    throw new Error(
      `${CONTRACT_DOCUMENT}: the checkout of main has no contract document`,
    );
  }
  const { version, error } = documentVersion(text);
  if (!version) {
    throw new Error(`${CONTRACT_DOCUMENT} on main ${error}`);
  }
  return { text, version };
}

async function openPullRequests(repo, gh, budget) {
  const [owner, name] = repo.split('/');
  const query = async (text, variables) => {
    const args = ['api', 'graphql', '-f', `query=${text}`];
    for (const [key, value] of Object.entries({ owner, name, ...variables })) {
      if (value == null) continue;
      args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`);
    }
    return JSON.parse(await gh(args)).data.repository;
  };
  const prs = [];
  let exhausted = false;
  let cursor = null;
  do {
    const page = (await query(PRS_QUERY, { cursor })).pullRequests;
    for (const pr of page.nodes) {
      const files = [...pr.files.nodes];
      let next = pr.files.pageInfo;
      while (next.hasNextPage && budget.left > 0) {
        budget.left -= 1;
        const more = (
          await query(FILES_QUERY, {
            number: pr.number,
            cursor: next.endCursor,
          })
        ).pullRequest.files;
        files.push(...more.nodes);
        next = more.pageInfo;
      }
      if (next.hasNextPage) exhausted = true;
      // The last commit has always been the head. If it ever is not, the
      // head reads as carrying no status and is written on every run.
      const head = pr.commits.nodes[0]?.commit;
      const current = head?.oid === pr.headRefOid && head.status?.context;
      prs.push({
        number: pr.number,
        sha: pr.headRefOid,
        // Past the page budget, or the API's 3000-file cap.
        incomplete: files.length < pr.changedFiles,
        current: current && {
          state: current.state.toLowerCase(),
          description: current.description,
        },
        files,
      });
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return { prs, exhausted };
}

// The contents API answers the document at any commit in the repository
// network, including a fork's head — one file, answered as text; no PR
// code is checked out or run. Anything the API cannot answer (a deletion
// racing the file list, a symlike entry, a truncated read) is null, and
// the claim is reported as unread instead of guessed.
async function headDocument(repo, sha, gh) {
  try {
    const body = JSON.parse(
      await gh([
        'api',
        `repos/${repo}/contents/${CONTRACT_DOCUMENT}?ref=${sha}`,
      ]),
    );
    if (typeof body?.content !== 'string') return null;
    return Buffer.from(body.content, 'base64').toString('utf8').trim();
  } catch {
    return null;
  }
}

// Each PR's claim on the contract version: absent when it does not change
// the document or its copy reads back identical to main's; 'deleted',
// 'unread', the parse refusal, or the declared version otherwise. File
// pages and document reads draw the same remaining budget.
async function claims(repo, prs, main, budget, gh) {
  let exhausted = false;
  const byPr = new Map();
  for (const pr of prs) {
    const touched = pr.files.find((file) => file.path === CONTRACT_DOCUMENT);
    if (!touched) continue;
    if (touched.changeType === 'DELETED') {
      byPr.set(pr.number, 'deleted');
      continue;
    }
    if (budget.left <= 0) {
      exhausted = true;
      byPr.set(pr.number, 'unread');
      continue;
    }
    budget.left -= 1;
    const text = await headDocument(repo, pr.sha, gh);
    if (text === null) {
      byPr.set(pr.number, 'unread');
    } else if (text !== main.text) {
      const { version, error } = documentVersion(text);
      byPr.set(pr.number, version ? { version } : { error });
    }
    // Identical bytes to main's copy: no claim.
  }
  return { byPr, exhausted };
}

// One verdict per PR that changes the document, whose file list is cut
// short, or whose head already carries this status — which may need
// clearing.
function evaluate(prs, claimsByPr, mainVersion) {
  const claimedBy = new Map();
  for (const pr of prs) {
    const claim = claimsByPr.get(pr.number);
    if (!claim?.version) continue;
    claimedBy.set(claim.version, [
      ...(claimedBy.get(claim.version) ?? []),
      pr.number,
    ]);
  }
  return prs
    .filter((pr) => pr.incomplete || pr.current || claimsByPr.has(pr.number))
    .map((pr) => {
      const claim = claimsByPr.get(pr.number);
      let state;
      let text;
      if (claim?.version) {
        const order = compareVersions(claim.version, mainVersion);
        if (order > 0) {
          const others = (claimedBy.get(claim.version) ?? []).filter(
            (number) => number !== pr.number,
          );
          state = 'success';
          text = `${claim.version} is unique against main`;
          if (others.length > 0) {
            text += `; also claimed by open PRs: ${others
              .map((number) => `#${number}`)
              .join(' ')}`;
          }
        } else {
          state = 'failure';
          text =
            order === 0
              ? `${claim.version} does not advance past main's ${mainVersion}`
              : `${claim.version} regresses below main's ${mainVersion}`;
        }
      } else if (claim?.error) {
        state = 'failure';
        text = `Head document ${claim.error}`;
      } else if (claim === 'deleted') {
        state = 'success';
        text = 'Removes the contract document, so no version claim';
      } else if (claim === 'unread') {
        state = 'error';
        text = 'Could not read the head document, so not checked';
      } else if (pr.incomplete) {
        state = 'error';
        text = 'Could not list every changed file, so not checked against main';
      } else {
        state = 'success';
        text = 'No claim on the contract version';
      }
      return {
        number: pr.number,
        sha: pr.sha,
        current: pr.current,
        // A status description is plain text of at most 140 characters. It
        // leaves out main's commit so that an unchanged verdict reads the
        // same on every run.
        description: text.length > 140 ? `${text.slice(0, 137)}...` : text,
        state,
      };
    });
}

export async function run({
  root,
  repo,
  mainSha,
  targetUrl,
  dryRun,
  gh,
  budget = { left: API_PAGE_BUDGET },
}) {
  const main = mainContract(root);
  const listed = await openPullRequests(repo, gh, budget);
  const read = await claims(repo, listed.prs, main, budget, gh);
  const verdicts = evaluate(listed.prs, read.byPr, main.version);
  const lines = [
    `### Contract versions of open PRs against main@${mainSha.slice(0, 7)}`,
    '',
  ];
  if (listed.exhausted || read.exhausted) {
    lines.push(
      `Read ${API_PAGE_BUDGET} API pages, the budget; PRs past it are reported as not checked.`,
      '',
    );
  }
  if (verdicts.length === 0) {
    lines.push(
      'No open pull request against main changes the contract document.',
    );
  }
  let failed = 0;
  for (const verdict of verdicts) {
    const unchanged =
      verdict.current?.state === verdict.state &&
      verdict.current.description === verdict.description;
    lines.push(
      `- #${verdict.number} ${verdict.state}: ${verdict.description}${unchanged ? ' (unchanged)' : ''}`,
    );
    if (dryRun || unchanged) continue;
    try {
      await gh([
        'api',
        '--method',
        'POST',
        `repos/${repo}/statuses/${verdict.sha}`,
        '-f',
        `state=${verdict.state}`,
        '-f',
        `context=${STATUS_CONTEXT}`,
        '-f',
        `description=${verdict.description}`,
        ...(targetUrl ? ['-f', `target_url=${targetUrl}`] : []),
      ]);
    } catch (error) {
      failed += 1;
      lines.push(`  - could not set the status: ${neutralize(error.message)}`);
    }
  }
  return { lines, failed };
}

const execFileAsync = promisify(execFile);

async function gh(args) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const { stdout } = await execFileAsync('gh', args, {
        maxBuffer: 64 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      if (attempt === 3) {
        throw new Error(error.stderr?.trim() || error.message);
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const {
    GITHUB_REPOSITORY: repo,
    GITHUB_SERVER_URL: server,
    GITHUB_RUN_ID: runId,
  } = process.env;
  if (args.some((arg) => arg !== '--dry-run') || !repo) {
    console.error(
      'usage: GITHUB_REPOSITORY=<owner/name> node scripts/check-contract-open-prs.js ' +
        '[--dry-run]  (run from a checkout of main)',
    );
    process.exit(2);
  }
  const { lines, failed } = await run({
    root: '.',
    repo,
    mainSha: execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    targetUrl: server && runId && `${server}/${repo}/actions/runs/${runId}`,
    dryRun: args.includes('--dry-run'),
    gh,
  });
  const report = `${lines.join('\n')}\n`;
  process.stdout.write(report);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  }
  process.exitCode = failed > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(neutralize(error.message));
    process.exitCode = 1;
  });
}
