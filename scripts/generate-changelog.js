#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Generate `CHANGELOG.md` from the project's GitHub Releases.
 *
 * The changelog only lists *stable* releases (`vX.Y.Z`); nightly and preview
 * pre-releases are intentionally omitted because they ship daily and would
 * drown out the signal. Each release's auto-generated "What's Changed" list is
 * re-grouped into Keep a Changelog sections (Added / Changed / Fixed / ...) by
 * the conventional-commit prefix every PR title uses in this repo.
 *
 * The file is fully derived from the GitHub Releases API, so it is safe to
 * regenerate at any time and should not be edited by hand.
 *
 * Usage:
 *   node scripts/generate-changelog.js                # write ./CHANGELOG.md
 *   node scripts/generate-changelog.js --dry-run      # print to stdout instead
 *   node scripts/generate-changelog.js --repo=owner/name --output=path.md
 *
 * Requires the GitHub CLI (`gh`) to be installed and authenticated.
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './lib/release-helpers.js';
import { isMainModule, parseArgs } from './release-script-utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Keep a Changelog sections, in render order, each listing the
 * conventional-commit types that feed it. `Other` is the catch-all for unmapped
 * types. This is the single source of truth — `TYPE_TO_SECTION` and
 * `SECTION_ORDER` are derived from it so the two can never drift apart.
 */
const SECTIONS = [
  { name: 'Added', types: ['feat'] },
  { name: 'Changed', types: ['refactor', 'revert'] },
  { name: 'Fixed', types: ['fix'] },
  { name: 'Performance', types: ['perf'] },
  { name: 'Documentation', types: ['docs'] },
  { name: 'Other', types: [] },
];

const TYPE_TO_SECTION = Object.fromEntries(
  SECTIONS.flatMap((section) =>
    section.types.map((type) => [type, section.name]),
  ),
);

const SECTION_ORDER = SECTIONS.map((section) => section.name);

/** Matches a stable `vX.Y.Z` tag (no `-preview` / `-nightly` suffix). */
const STABLE_TAG_RE = /^v?(\d+)\.(\d+)\.(\d+)$/;

/**
 * Matches a GitHub "What's Changed" bullet, e.g.
 *   * fix(core): do a thing by @octocat in https://github.com/o/r/pull/42
 * The title is captured greedily so a trailing " by @user in <pr-url>" binds to
 * the last occurrence, and "New Contributors" / "Full Changelog" lines (which
 * lack the " by @… in …/pull/N" tail) are skipped. The author group allows a
 * trailing `[bot]` so GitHub App authors (e.g. `@dependabot[bot]`) still match.
 */
const ENTRY_RE =
  /^[*-]\s+(.+)\s+by\s+@([A-Za-z0-9-]+(?:\[bot\])?)\s+in\s+(https?:\/\/\S+\/pull\/(\d+))\s*$/;

/**
 * Splits a conventional-commit subject into
 * `{ type, scope, description, breaking }`. The `!` breaking-change marker
 * (e.g. `feat(core)!: …`) is captured so it can be surfaced in the output.
 */
export function categorize(title) {
  const match = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/.exec(title.trim());
  if (!match) {
    return {
      type: null,
      scope: null,
      description: title.trim(),
      breaking: false,
    };
  }
  return {
    type: match[1].toLowerCase(),
    scope: match[2] || null,
    description: match[4],
    breaking: Boolean(match[3]),
  };
}

/**
 * Pure version-bump commits the release bot makes (`chore(release): vX.Y.Z`)
 * are noise in a user-facing changelog, so they are dropped. Takes a parsed
 * `categorize()` result so callers that already parsed the title don't re-parse.
 */
export function isNoiseEntry({ type, scope }) {
  return type === 'chore' && scope === 'release';
}

/** Parse the "What's Changed" bullets out of a release body. */
export function parseReleaseEntries(body) {
  const entries = [];
  for (const line of (body || '').split(/\r?\n/)) {
    const match = ENTRY_RE.exec(line);
    if (!match) {
      continue;
    }
    entries.push({
      title: match[1].trim(),
      author: match[2],
      prUrl: match[3],
      prNumber: match[4],
    });
  }
  return entries;
}

/** Render a single "What's Changed" entry as a changelog list item. */
export function formatEntry(entry, cat = categorize(entry.title)) {
  const { type, scope, description, breaking } = cat;
  let text;
  if (TYPE_TO_SECTION[type]) {
    // Recognised type: drop the redundant leading keyword (the section heading
    // already conveys it) but keep the scope for context.
    text = scope ? `${scope}: ${description}` : description;
  } else {
    // Unknown or prefix-less title: keep it verbatim.
    text = entry.title;
  }
  if (breaking) {
    text = `**BREAKING** ${text}`;
  }
  return `- ${text} ([#${entry.prNumber}](${entry.prUrl}))`;
}

/** Render one release as a Markdown block. */
export function formatRelease(release) {
  const lines = [];
  const heading = release.htmlUrl
    ? `## [${release.version}](${release.htmlUrl}) - ${release.date}`
    : `## [${release.version}] - ${release.date}`;
  lines.push(heading, '');

  const buckets = new Map();
  for (const entry of release.entries) {
    const cat = categorize(entry.title);
    if (isNoiseEntry(cat)) {
      continue;
    }
    const section = TYPE_TO_SECTION[cat.type] || 'Other';
    if (!buckets.has(section)) {
      buckets.set(section, []);
    }
    buckets.get(section).push(formatEntry(entry, cat));
  }

  let rendered = false;
  for (const section of SECTION_ORDER) {
    const items = buckets.get(section);
    if (!items || items.length === 0) {
      continue;
    }
    rendered = true;
    lines.push(`### ${section}`, '', ...items, '');
  }

  if (!rendered) {
    const link = release.htmlUrl
      ? `[GitHub release](${release.htmlUrl})`
      : 'the GitHub release';
    lines.push(`_See ${link} for details._`, '');
  }

  return lines.join('\n');
}

const HEADER = `# Changelog

All notable changes to [Qwen Code](https://github.com/QwenLM/qwen-code) are
documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Only stable releases
are listed; nightly and preview pre-releases are intentionally omitted.

> **This file is generated automatically** from
> [GitHub Releases](https://github.com/QwenLM/qwen-code/releases). Do not edit it
> by hand — run \`npm run changelog\` to regenerate.
`;

/** Build the full CHANGELOG.md contents from an ordered list of releases. */
export function buildChangelog(releases) {
  const blocks = releases.map((release) => formatRelease(release));
  const body = `${HEADER}\n${blocks.join('\n')}`;
  // Collapse any run of blank lines and guarantee a single trailing newline.
  return `${body.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')}\n`;
}

/** Convert a raw GitHub Releases API object into our release model. */
export function toReleaseModel(raw) {
  const match = STABLE_TAG_RE.exec(raw.tag || '');
  return {
    tag: raw.tag,
    version: match ? `${match[1]}.${match[2]}.${match[3]}` : null,
    date: (raw.date || '').slice(0, 10),
    htmlUrl: raw.url || '',
    entries: parseReleaseEntries(raw.body),
  };
}

/** Keep only stable releases, newest first. */
export function selectStableReleases(rawReleases) {
  return rawReleases
    .filter((raw) => !raw.prerelease && !raw.draft)
    .map(toReleaseModel)
    .filter((release) => release.version)
    .sort((a, b) => {
      // Newest first, comparing numeric semver components.
      const x = a.version.split('.').map(Number);
      const y = b.version.split('.').map(Number);
      return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
    });
}

/** Fetch every release (paginated) as newline-delimited JSON via the gh CLI. */
function fetchReleasesJsonl(repo) {
  // Validate before shelling out, and pass args via execFileSync (no shell) so
  // a `repo` value can never be interpreted as a shell command.
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`Invalid repository "${repo}"; expected "owner/name".`);
  }
  return execFileSync(
    'gh',
    [
      'api',
      `repos/${repo}/releases?per_page=100`,
      '--paginate',
      '--jq',
      '.[] | {tag: .tag_name, date: .published_at, prerelease: .prerelease, draft: .draft, url: .html_url, body: .body}',
    ],
    { encoding: 'utf-8', maxBuffer: 256 * 1024 * 1024 },
  );
}

/** Parse newline-delimited JSON (one release object per line). */
export function parseJsonl(jsonl) {
  return jsonl
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Resolve the default `owner/repo` from the environment or package.json. */
function getDefaultRepo() {
  if (process.env.GITHUB_REPOSITORY) {
    return process.env.GITHUB_REPOSITORY;
  }
  const url = readJson(path.join(REPO_ROOT, 'package.json'))?.repository?.url;
  const match = /github\.com[/:]([^/]+\/[^/.]+)/.exec(url || '');
  return match ? match[1] : 'QwenLM/qwen-code';
}

const HELP = `Generate CHANGELOG.md from GitHub Releases.

Usage:
  node scripts/generate-changelog.js [options]

Options:
  --repo=<owner/name>  Source repository (default: $GITHUB_REPOSITORY or package.json).
  --output=<path>      Output file (default: ./CHANGELOG.md).
  --dry-run            Print to stdout instead of writing the file.
  -h, --help           Show this help.
`;

function main() {
  // parseArgs rejects unknown options (so a `--dryrun` typo errors instead of
  // silently overwriting) and handles `-h`/`--help` natively.
  const args = parseArgs(process.argv.slice(2), {
    '--repo': { key: 'repo', type: 'value' },
    '--output': { key: 'output', type: 'value' },
    '--dry-run': { key: 'dry-run', type: 'flag' },
  });
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const repo = args.repo || getDefaultRepo();
  const output = args.output || path.join(REPO_ROOT, 'CHANGELOG.md');

  const rawReleases = parseJsonl(fetchReleasesJsonl(repo));
  const releases = selectStableReleases(rawReleases);
  if (releases.length === 0) {
    // A populated repo returning zero stable releases means the fetch failed
    // (rate limit, auth expiry, transient 5xx). Refuse to overwrite a good
    // CHANGELOG with an empty stub; the next release run regenerates it.
    console.error(
      `ERROR: no stable releases found for ${repo}; refusing to overwrite ${path.basename(output)}.`,
    );
    process.exit(1);
  }
  const changelog = buildChangelog(releases);

  if (args['dry-run']) {
    process.stdout.write(changelog);
    return;
  }

  writeFileSync(output, changelog);
  console.error(
    `Wrote ${releases.length} stable releases to ${path.relative(process.cwd(), output)}`,
  );
}

if (isMainModule(import.meta.url)) {
  main();
}
