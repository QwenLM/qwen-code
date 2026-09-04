#!/usr/bin/env node
// Assign an issue to an area owner, derived purely from the issue's labels.
//
// This script never reads issue title, body, or comments, so untrusted issue
// text cannot steer the assignment. The triage agent's only influence is the
// labels it applies, drawn from the repository's existing label taxonomy; the
// label -> owner map lives in .github/issue-owners.json and is reviewed like
// any other checked-in file. Push access is re-verified against the live
// collaborator API before every write, so an edit to that map cannot assign
// someone who does not already have permission.
import { appendFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const OWNERS_FILE = '.github/issue-owners.json';
const WRITE_PERMISSIONS = new Set(['admin', 'maintain', 'write']);
const LOGIN = /^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

function isStringArray(value) {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

// A changed-file prefix for assign-pr-owner.mjs: relative, no `//`, no
// backslash, no `.`/`..` segments, and ending in `/` so startsWith cannot
// leak into a sibling directory (packages/core matching packages/coredump/).
function isPathPrefix(prefix) {
  if (typeof prefix !== 'string' || prefix.length === 0) return false;
  if (prefix.startsWith('/') || prefix.startsWith('./')) return false;
  if (!prefix.endsWith('/')) return false;
  if (prefix.includes('\\') || prefix.includes('//')) return false;
  return !prefix
    .split('/')
    .some((segment) => segment === '.' || segment === '..');
}

export function loadPolicy(raw) {
  const policy = JSON.parse(raw);
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error(`${OWNERS_FILE}: not an object`);
  }
  // An empty label entry can never match; in requireLabels it would silently
  // skip every issue on a green run, so reject it like other malformed config.
  if (
    !isStringArray(policy.requireLabels) ||
    !isStringArray(policy.skipLabels) ||
    policy.requireLabels.some((label) => label.length === 0) ||
    policy.skipLabels.some((label) => label.length === 0)
  ) {
    throw new Error(
      `${OWNERS_FILE}: requireLabels/skipLabels must be non-empty strings`,
    );
  }
  if (!Array.isArray(policy.areas) || policy.areas.length === 0) {
    throw new Error(`${OWNERS_FILE}: areas must be a non-empty array`);
  }
  const areaNames = new Set();
  for (const area of policy.areas) {
    if (typeof area?.name !== 'string' || area.name.length === 0) {
      throw new Error(`${OWNERS_FILE}: every area needs a name`);
    }
    // First match wins, so two areas sharing a name silently shadow one another.
    if (areaNames.has(area.name)) {
      throw new Error(`${OWNERS_FILE}: duplicate area ${area.name}`);
    }
    areaNames.add(area.name);
    if (
      !isStringArray(area.labels) ||
      area.labels.length === 0 ||
      area.labels.some((label) => label.length === 0)
    ) {
      throw new Error(`${OWNERS_FILE}: area ${area.name} needs labels`);
    }
    if (!Array.isArray(area.owners) || area.owners.length === 0) {
      throw new Error(`${OWNERS_FILE}: area ${area.name} needs owners`);
    }
    const seen = new Set();
    for (const owner of area.owners) {
      // Rejected here rather than at the gh call so a typo fails the config,
      // not a single assignment attempt.
      if (typeof owner !== 'string' || !LOGIN.test(owner)) {
        throw new Error(`${OWNERS_FILE}: invalid login in ${area.name}`);
      }
      // A repeated login would be counted twice and win ties unfairly.
      const normalizedOwner = owner.toLowerCase();
      if (seen.has(normalizedOwner)) {
        throw new Error(`${OWNERS_FILE}: duplicate owner ${owner}`);
      }
      seen.add(normalizedOwner);
    }
    // A never-matching paths entry silently unroutes the area from PR
    // assignment, so reject it here like other malformed config.
    if (area.paths !== undefined && !Array.isArray(area.paths)) {
      throw new Error(
        `${OWNERS_FILE}: area ${area.name} paths must be an array`,
      );
    }
    // An explicitly empty list can never route the area either, yet the
    // entry loop below cannot catch it — reject it like the sibling
    // labels/owners checks do.
    if (Array.isArray(area.paths) && area.paths.length === 0) {
      throw new Error(
        `${OWNERS_FILE}: area ${area.name} paths must not be empty; omit paths for a label-only area`,
      );
    }
    for (const prefix of area.paths ?? []) {
      if (!isPathPrefix(prefix)) {
        throw new Error(
          `${OWNERS_FILE}: invalid paths entry in ${area.name}: ${JSON.stringify(prefix)}`,
        );
      }
    }
  }
  return policy;
}

// Returns a human-readable reason to skip, or null to proceed. Ordered so the
// most informative reason wins when several apply.
export function skipReason(policy, issue) {
  const labels = new Set(issue.labels.map((label) => label.name));
  if (issue.state !== 'OPEN') return 'issue is not open';
  if (issue.assignees.length > 0) return 'issue already has an assignee';
  const skipped = policy.skipLabels.filter((label) => labels.has(label));
  if (skipped.length > 0) return `carries ${skipped.join(', ')}`;
  const missing = policy.requireLabels.filter((label) => !labels.has(label));
  if (missing.length > 0) return `missing ${missing.join(', ')}`;
  return null;
}

// First matching area wins, so file order is the documented precedence.
export function matchArea(policy, issue) {
  const labels = new Set(issue.labels.map((label) => label.name));
  return (
    policy.areas.find((area) =>
      area.labels.some((label) => labels.has(label)),
    ) ?? null
  );
}

// Rotate by issue number before the stable minimum so a set of equally loaded
// owners spreads round-robin instead of always landing on the first entry.
export function pickOwner(owners, loadByOwner, issueNumber) {
  const offset = issueNumber % owners.length;
  const rotated = [...owners.slice(offset), ...owners.slice(0, offset)];
  return rotated.reduce((best, owner) =>
    loadByOwner.get(owner) < loadByOwner.get(best) ? owner : best,
  );
}

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

// A candidate who lost push access, renamed, or deleted their account makes
// the permission lookup fail; warn and drop them rather than failing the run
// over one stale entry.
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

export function openIssueCount(repository, login) {
  return Number(
    gh([
      'issue',
      'list',
      '--repo',
      repository,
      '--state',
      'open',
      '--assignee',
      login,
      '--limit',
      '100',
      '--json',
      'number',
      '--jq',
      'length',
    ]),
  );
}

function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const issueNumber = Number(process.env.ISSUE_NUMBER);
  const dryRun = process.env.DRY_RUN === 'true';
  if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error('Invalid repository');
  }
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
    throw new Error('Invalid issue number');
  }

  const policy = loadPolicy(readFileSync(OWNERS_FILE, 'utf8'));
  const issue = JSON.parse(
    gh([
      'issue',
      'view',
      String(issueNumber),
      '--repo',
      repository,
      '--json',
      'state,labels,assignees',
    ]),
  );

  const skip = skipReason(policy, issue);
  if (skip) {
    record([`Assignment: skipped — ${skip}`]);
    return;
  }

  const area = matchArea(policy, issue);
  if (!area) {
    record(['Assignment: skipped — no area label matched']);
    return;
  }

  const eligible = area.owners.filter((owner) => canWrite(repository, owner));
  if (eligible.length === 0) {
    console.warn(
      `::warning::No owner of area ${area.name} has push access; check ${OWNERS_FILE}.`,
    );
    record([`Assignment: skipped — no eligible owner for area ${area.name}`]);
    return;
  }

  const loadByOwner = new Map(
    eligible.map((owner) => [owner, openIssueCount(repository, owner)]),
  );
  const assignee = pickOwner(eligible, loadByOwner, issueNumber);

  if (dryRun) {
    record([
      `Area: ${area.name}`,
      `Assignment: dry-run — would assign @${assignee} (${loadByOwner.get(assignee)} open)`,
    ]);
    return;
  }

  const latestIssue = JSON.parse(
    gh([
      'issue',
      'view',
      String(issueNumber),
      '--repo',
      repository,
      '--json',
      'state,labels,assignees',
    ]),
  );
  const latestSkip = skipReason(policy, latestIssue);
  if (latestSkip) {
    record([`Assignment: skipped — ${latestSkip}`]);
    return;
  }
  if (matchArea(policy, latestIssue)?.name !== area.name) {
    record(['Assignment: skipped — issue labels changed']);
    return;
  }

  gh([
    'issue',
    'edit',
    String(issueNumber),
    '--repo',
    repository,
    '--add-assignee',
    assignee,
  ]);
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
