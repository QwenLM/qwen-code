/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// check-flyway-migrations.js checks a pull request merged with the main of
// the moment it ran, and nothing re-runs it when main later gains a
// migration: a PR that went green before another PR took its version stays
// green and turns main red once it merges (#13742 — duplicate V31s reached
// main that way). This script runs against a checkout of main after every
// push that touches a migration, and on a schedule. It reads each open PR's
// changed paths from the API — no PR code is fetched — and sets a commit
// status on every PR head that adds a migration: failure when a version it
// adds is taken in the merge result, success otherwise, naming the other open
// PRs that claim the same version, so the second of them turns red as soon as
// the first one lands. A PR whose file list could not be read in full gets
// error unless the files read already collide. A head that already carries
// the status is re-evaluated even when it no longer adds a migration, so a
// stale failure is cleared; a head whose status already says the same is
// left alone, so a schedule does not pile statuses onto it.

import { appendFileSync, existsSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  LOCATIONS,
  isMigrationFile,
  migrationFiles,
  migrationVersion,
} from './flyway-migration-utils.js';

export const STATUS_CONTEXT =
  'Flyway migration version uniqueness (latest main)';

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

// Extra file pages per run, about four minutes of calls: a flood of huge PRs
// is reported as not checked instead of pushing every run past its timeout.
const FILE_PAGE_BUDGET = 100;

const versionOf = (file) => migrationVersion(path.posix.basename(file));

// The runner parses `::` and `##[` commands from the job log, and the names
// come from the PR.
const nameOf = (file) =>
  path.posix.basename(file).replace(/[^A-Za-z0-9._-]/g, '?');
const neutralize = (text) =>
  text.replace(/\s+/g, ' ').replace(/::/g, ';;').replace(/##\[/g, '##［');

// Flyway scans each location's subdirectories too.
const isTracked = (modules, file) =>
  modules.some((module) =>
    LOCATIONS.some(
      (location) =>
        file.startsWith(`${[module, ...location.dir].join('/')}/`) &&
        isMigrationFile(path.posix.basename(file), location.suffix),
    ),
  );

// Repository-relative paths, the same shape as the API's PR file paths.
export function mainMigrations(root, modules) {
  for (const module of modules) {
    if (!existsSync(path.join(root, module))) {
      throw new Error(`${module}: no such Maven module directory`);
    }
  }
  const files = modules.flatMap((module) =>
    LOCATIONS.flatMap((location) =>
      migrationFiles(path.join(root, module, ...location.dir), location.suffix),
    ),
  );
  // An empty scan would let every claim pass.
  if (files.length === 0) {
    throw new Error(`found no migration under ${modules.join(', ')}`);
  }
  return files.map((file) =>
    path.relative(root, file).split(path.sep).join('/'),
  );
}

async function openPullRequests(repo, gh) {
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
  let budget = FILE_PAGE_BUDGET;
  let cursor = null;
  do {
    const page = (await query(PRS_QUERY, { cursor })).pullRequests;
    for (const pr of page.nodes) {
      const files = [...pr.files.nodes];
      let next = pr.files.pageInfo;
      while (next.hasNextPage && budget > 0) {
        budget -= 1;
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

// One verdict per PR that adds a migration, whose file list is cut short, or
// whose head already carries this status — which may need clearing.
function evaluate(modules, mainFiles, prs) {
  const onMain = new Set(mainFiles);
  const claims = prs.map((pr) => {
    const touched = pr.files.filter((file) => isTracked(modules, file.path));
    const deleted = new Set(
      touched
        .filter((file) => file.changeType === 'DELETED')
        .map((file) => file.path),
    );
    const kept = touched
      .filter((file) => file.changeType !== 'DELETED')
      .map((file) => file.path);
    return {
      pr,
      // The merge result. The API does not name a renamed file's old path,
      // so a migration the PR renames away from main still counts here —
      // which can only over-report.
      merged: [
        ...new Set([
          ...mainFiles.filter((file) => !deleted.has(file)),
          ...kept,
        ]),
      ],
      added: kept.filter((file) => !onMain.has(file)),
    };
  });
  const claimedBy = new Map();
  for (const { pr, added } of claims) {
    for (const file of added) {
      const version = versionOf(file);
      claimedBy.set(version, [
        ...(claimedBy.get(version) ?? []),
        { number: pr.number, file },
      ]);
    }
  }
  return claims
    .filter(({ pr, added }) => pr.incomplete || pr.current || added.length > 0)
    .map(({ pr, merged, added }) => {
      const versions = [...new Set(added.map(versionOf))];
      return {
        number: pr.number,
        sha: pr.sha,
        incomplete: pr.incomplete,
        current: pr.current,
        collisions: versions
          .map((version) => ({
            version,
            files: merged.filter((file) => versionOf(file) === version),
          }))
          .filter(({ files }) => files.length > 1),
        // The same path added by two PRs (a stacked or cherry-picked commit)
        // is one file once both land, not a collision.
        shared: versions
          .map((version) => ({
            version,
            prs: [
              ...new Set(
                claimedBy
                  .get(version)
                  .filter(
                    (claim) =>
                      claim.number !== pr.number && !added.includes(claim.file),
                  )
                  .map((claim) => claim.number),
              ),
            ],
          }))
          .filter(({ prs }) => prs.length > 0),
      };
    });
}

// A status description is plain text of at most 140 characters. It leaves
// out main's commit so that an unchanged verdict reads the same on every run.
function statusFor(verdict) {
  let state;
  let text;
  if (verdict.collisions.length > 0) {
    state = 'failure';
    text = `Version collision when merged into main: ${verdict.collisions
      .map(
        ({ version, files }) =>
          `V${version} = ${files.map(nameOf).join(' + ')}`,
      )
      .join('; ')}`;
  } else if (verdict.incomplete) {
    state = 'error';
    text = 'Could not list every changed file, so not checked against main';
  } else {
    state = 'success';
    text = 'No collision with main';
    if (verdict.shared.length > 0) {
      text += `; also claimed by open PRs: ${verdict.shared
        .map(
          ({ version, prs }) =>
            `V${version} ${prs.map((number) => `#${number}`).join(' ')}`,
        )
        .join('; ')}`;
    }
  }
  return {
    state,
    description: text.length > 140 ? `${text.slice(0, 137)}...` : text,
  };
}

export async function run({
  root,
  modules,
  repo,
  mainSha,
  targetUrl,
  dryRun,
  gh,
}) {
  const mainFiles = mainMigrations(root, modules);
  const { prs, exhausted } = await openPullRequests(repo, gh);
  const verdicts = evaluate(modules, mainFiles, prs);
  const lines = [
    `### Flyway versions of open PRs against main@${mainSha.slice(0, 7)}`,
    '',
  ];
  if (exhausted) {
    lines.push(
      `Read ${FILE_PAGE_BUDGET} extra file pages, the budget; PRs past it are reported as not checked.`,
      '',
    );
  }
  if (verdicts.length === 0) {
    lines.push('No open pull request against main adds a migration.');
  }
  let failed = 0;
  for (const verdict of verdicts) {
    const { state, description } = statusFor(verdict);
    const unchanged =
      verdict.current?.state === state &&
      verdict.current.description === description;
    lines.push(
      `- #${verdict.number} ${state}: ${description}${unchanged ? ' (unchanged)' : ''}`,
    );
    if (dryRun || unchanged) continue;
    try {
      await gh([
        'api',
        '--method',
        'POST',
        `repos/${repo}/statuses/${verdict.sha}`,
        '-f',
        `state=${state}`,
        '-f',
        `context=${STATUS_CONTEXT}`,
        '-f',
        `description=${description}`,
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
  const modules = [
    ...new Set(
      args
        .filter((arg) => arg !== '--dry-run')
        .map((arg) => path.posix.normalize(arg).replace(/\/+$/, '')),
    ),
  ];
  const {
    GITHUB_REPOSITORY: repo,
    GITHUB_SERVER_URL: server,
    GITHUB_RUN_ID: runId,
  } = process.env;
  if (modules.length === 0 || !repo) {
    console.error(
      'usage: GITHUB_REPOSITORY=<owner/name> node scripts/check-flyway-open-prs.js ' +
        '[--dry-run] <maven-module-dir>...  (run from a checkout of main)',
    );
    process.exit(2);
  }
  const { lines, failed } = await run({
    root: '.',
    modules,
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
