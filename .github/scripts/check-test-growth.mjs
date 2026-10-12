#!/usr/bin/env node
/**
 * Report how much test code a pull request adds, and flag large additions.
 *
 * Nothing else counts test lines: the size rules in AGENTS.md and the triage
 * skill count production lines only. In September 2026, PRs added 1.84 test
 * lines per production line in core, cli and web-shell, and the 8% of PRs
 * adding 2,000 or more net test lines carried half of that growth (#13007
 * removed 178,000 Core test lines, a few weeks of it). This step writes the
 * numbers to the job summary on every PR and, at FLAG_THRESHOLD net test
 * lines, emits a warning annotation so authors and reviewers see them. It
 * reports only: nothing blocks on it.
 *
 * The diff is taken from the true merge base, which the compare API reports:
 * the PR's base.sha is the base tip, and diffing against it would count the
 * base's newer changes, reversed, on any branch that is behind. The lane's
 * checkout is shallow, so the merge base is fetched at depth 1.
 *
 * Advisory only: every error is a warning and the step exits 0.
 */
import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const FLAG_THRESHOLD = 2000;

export const PACKAGES = ['core', 'cli', 'web-shell'];

// Test code: test and spec files, test helpers, fixtures, mocks, snapshots.
const TEST_PATTERNS = [
  /\.(test|spec)\.[^/]+$/,
  /\.test-helper\.[^/]+$/,
  /\.fixtures\.json$/,
  /\.snap$/,
  /(^|\/)(test-setup|testUtils)\.ts$/,
  /(^|\/)test-utils\.[^/]+$/,
  /(^|\/)(__tests__|__mocks__|__fixtures__|__snapshots__|__e2e__|fixtures|test-utils|testUtils)\//,
  /^packages\/web-shell\/client\/(e2e|test)\//,
];
const GENERATED = /(\.schema\.(ts|json)|\.generated\.ts)$|(^|\/)generated\//;
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

/** The package a path belongs to, or null outside the three packages. */
export function packageOf(path) {
  const match = /^packages\/([^/]+)\//.exec(path);
  return match && PACKAGES.includes(match[1]) ? match[1] : null;
}

/** 'test', 'production' or 'other' (data, docs, styles, generated code). */
export function classify(path) {
  if (TEST_PATTERNS.some((pattern) => pattern.test(path))) return 'test';
  if (GENERATED.test(path) || !SOURCE.test(path)) return 'other';
  return 'production';
}

/** Parses `git diff --numstat`, skipping binary files ("-\t-\tpath"). */
export function parseNumstat(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    const match = /^(\d+)\t(\d+)\t(.+)$/.exec(line);
    if (match) {
      entries.push({ added: +match[1], deleted: +match[2], path: match[3] });
    }
  }
  return entries;
}

/** Added and deleted test and production lines per package, plus a total. */
export function tally(entries) {
  const zero = () => ({
    test: { added: 0, deleted: 0 },
    production: { added: 0, deleted: 0 },
  });
  const byPackage = Object.fromEntries(PACKAGES.map((name) => [name, zero()]));
  const total = zero();
  for (const { added, deleted, path } of entries) {
    const name = packageOf(path);
    const kind = classify(path);
    if (!name || kind === 'other') continue;
    for (const bucket of [byPackage[name][kind], total[kind]]) {
      bucket.added += added;
      bucket.deleted += deleted;
    }
  }
  return { byPackage, total };
}

const net = ({ added, deleted }) => added - deleted;
const fmt = (n) => Math.abs(n).toLocaleString('en-US');
const signed = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + fmt(n);
const cell = (counts) =>
  `+${fmt(counts.added)} / −${fmt(counts.deleted)} (net ${signed(net(counts))})`;

export function isFlagged({ total }) {
  return net(total.test) >= FLAG_THRESHOLD;
}

export function renderSummary(tallied) {
  const rows = PACKAGES.map(
    (name) =>
      `| ${name} | ${cell(tallied.byPackage[name].test)} | ` +
      `${cell(tallied.byPackage[name].production)} |`,
  );
  const lines = [
    '### Test growth',
    '',
    '| Package | Test lines | Production lines |',
    '| --- | ---: | ---: |',
    ...rows,
    `| **Total** | ${cell(tallied.total.test)} | ${cell(tallied.total.production)} |`,
    '',
  ];
  if (isFlagged(tallied)) {
    lines.push(
      `This PR adds ${fmt(net(tallied.total.test))} net test lines, at or ` +
        `above the ${fmt(FLAG_THRESHOLD)}-line flag. Consider whether shared ` +
        'fixtures, parameterized tables or whole-result expectations would ' +
        'cover the same behavior in less code.',
      '',
    );
  }
  return lines.join('\n');
}

export function renderAnnotation(tallied) {
  if (!isFlagged(tallied)) return null;
  return (
    `::warning title=Test growth::This PR adds ` +
    `${fmt(net(tallied.total.test))} net test lines in core, cli and ` +
    `web-shell (flag at ${fmt(FLAG_THRESHOLD)}). ` +
    'Consider shared fixtures or parameterized tables; see the job summary.'
  );
}

/**
 * curl, not fetch: it honours HTTPS_PROXY on the ECS runners' egress, which
 * node's global fetch does not (see check-lint-gate-freshness.mjs).
 */
export async function curlJson(path, token, run = execFileAsync) {
  try {
    const { stdout } = await run(
      'curl',
      [
        '-sS',
        '-fL',
        '--max-time',
        '30',
        '-H',
        `Authorization: Bearer ${token}`,
        '-H',
        'Accept: application/vnd.github+json',
        '-H',
        'X-GitHub-Api-Version: 2022-11-28',
        `https://api.github.com${path}`,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    );
    return JSON.parse(stdout);
  } catch (error) {
    // execFile's message embeds the full argv, bearer token included, so
    // rebuild the error from the exit code and curl's last stderr line.
    const stderr = String(error.stderr ?? '')
      .trim()
      .split('\n')
      .pop();
    throw new Error(
      `GET ${path} failed (curl exit ${error.code ?? '?'})${stderr ? `: ${stderr}` : ''}`,
    );
  }
}

async function git(...args) {
  const { stdout } = await execFileAsync('git', args, {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  return stdout;
}

// For one command at a time: fetch the merge base's commit and trees only,
// and let `git diff` pull just the blobs it compares. A plain depth-1 fetch
// would transfer the whole tree again, about 60 MiB, on every PR.
const PARTIAL = [
  '-c',
  'extensions.partialClone=origin',
  '-c',
  'remote.origin.promisor=true',
];

/** Net test and production lines between the PR's merge base and its head. */
export async function measure({ fetchJson, runGit, repo, baseSha, headSha }) {
  const compare = await fetchJson(
    `/repos/${repo}/compare/${baseSha}...${headSha}?per_page=1`,
  );
  const mergeBase = compare?.merge_base_commit?.sha;
  if (!mergeBase) throw new Error('compare API returned no merge base');
  let partial = false;
  try {
    await runGit('cat-file', '-e', `${mergeBase}^{commit}`);
  } catch {
    const fetch = ['fetch', '--no-tags', '--depth=1'];
    try {
      await runGit(
        ...PARTIAL,
        ...fetch,
        '--filter=blob:none',
        'origin',
        mergeBase,
      );
      partial = true;
    } catch {
      await runGit(...fetch, 'origin', mergeBase);
    }
  }
  try {
    const numstat = await runGit(
      ...(partial ? PARTIAL : []),
      'diff',
      '--numstat',
      '--no-renames',
      mergeBase,
      headSha,
      '--',
      ...PACKAGES.map((name) => `packages/${name}`),
    );
    return { mergeBase, tallied: tally(parseNumstat(numstat)) };
  } finally {
    // The filtered fetch records its filter on the remote; drop it so later
    // fetches in this checkout stay ordinary.
    if (partial) {
      await runGit(
        'config',
        '--unset',
        'remote.origin.partialclonefilter',
      ).catch(() => {});
    }
  }
}

async function main() {
  const { GITHUB_TOKEN, BASE_SHA, HEAD_SHA, GITHUB_REPOSITORY } = process.env;
  if (!GITHUB_TOKEN || !BASE_SHA || !HEAD_SHA || !GITHUB_REPOSITORY) {
    console.log(
      '::warning::test growth: BASE_SHA, HEAD_SHA, GITHUB_REPOSITORY or ' +
        'GITHUB_TOKEN missing; skipping the check',
    );
    return;
  }
  try {
    const { mergeBase, tallied } = await measure({
      fetchJson: (path) => curlJson(path, GITHUB_TOKEN),
      runGit: git,
      repo: GITHUB_REPOSITORY,
      baseSha: BASE_SHA,
      headSha: HEAD_SHA,
    });
    const summary = renderSummary(tallied);
    console.log(`Merge base ${mergeBase.slice(0, 12)}\n\n${summary}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
    }
    const annotation = renderAnnotation(tallied);
    if (annotation) console.log(annotation);
  } catch (error) {
    // One line: an annotation ends at the first newline.
    const reason = String(error.message).split('\n')[0];
    console.log(
      `::warning::test growth check could not run (${reason}); skipping it`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
