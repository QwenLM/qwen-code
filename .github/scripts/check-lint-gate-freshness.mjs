#!/usr/bin/env node
/**
 * Fail a PR's Lint & Static lane when the base branch changed the lint gate
 * after this branch last incorporated it.
 *
 * The lane checks out refs/pull/N/head — the branch alone, a deliberate
 * trade-off recorded above the Checkout step in ci.yml (GitHub rebuilds the
 * merge ref asynchronously and can serve it stale for minutes). A green run
 * therefore proves "the branch passes the gate AS THE BRANCH DEFINES IT",
 * not as the base defines it. When the base changes the gate between branch
 * point and merge, the branch keeps validating with the old gate: #11117
 * flipped the Prettier lane from --write to --check on main while #11216's
 * branch still ran --write; its green was real, the merged tree was red,
 * and every later full-profile PR failed lint for a reason outside its own
 * diff (#11378 cleaned up). Nothing else catches this: main's ruleset
 * requires reviews, not status checks, and the merge queue has been off
 * since 2026-07-02.
 *
 * Gate-defining files only, deliberately NOT package.json /
 * package-lock.json: at 50-100 merges a day a dependency bump lands almost
 * daily, and forcing every in-flight PR to rebase behind one recreates the
 * "require up-to-date branch" treadmill. A prettier/eslint version bump
 * cannot sneak changed semantics past a branch either — both run repo-wide
 * (`--check .`, `eslint .`), so the bumping PR must bring the whole tree
 * under the new semantics in its own run. What can sneak is a change to
 * how the gate RUNS (the lane definitions in lint.js, the configs they
 * read, this check), which is exactly the list below. Rare enough — lint.js
 * saw five commits in the months before this check — that an occasional
 * "rebase, the gate moved" is cheap.
 *
 * Fail-open on API errors: with no required status checks this step is
 * advisory by convention (red means do not merge), and a GitHub API
 * brownout must not hold every PR hostage. The warning stays in the log.
 *
 * Cost: two API calls per gate file (latest base-side commit, then a
 * containment compare). The per-file `commits?path=` lookup is exact where
 * the alternative — scanning one swapped compare's file list — caps at 300
 * files, and a branch a few days behind a repo merging 50-100 PRs a day
 * blows past that, silently dropping gate files from the scan.
 */
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const GATE_FILES = [
  'scripts/lint.js',
  'eslint.config.js',
  'eslint.legacy-filenames.mjs',
  '.prettierrc.json',
  '.prettierignore',
  '.github/workflows/ci.yml',
  // This check is itself part of the gate: a base-side change to it must
  // not be validated by the branch's older copy.
  '.github/scripts/check-lint-gate-freshness.mjs',
];

/**
 * curl honours HTTPS_PROXY/NO_PROXY on the ECS runners' squid egress;
 * node's global fetch does not (undici needs a ProxyAgent that builtins
 * alone cannot construct). `-f` turns HTTP errors into a non-zero exit,
 * which execFile rejects — the caller's fail-open catches both shapes.
 */
async function curlJson(path, token) {
  try {
    const { stdout } = await execFileAsync(
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
      { maxBuffer: 16 * 1024 * 1024 },
    );
    return JSON.parse(stdout);
  } catch (error) {
    // execFile's message embeds the full argv — including the bearer token.
    // Actions masks the exact secret in logs, but a local run would print
    // it, so rebuild the error from the exit code and curl's own stderr.
    const stderr = String(error.stderr ?? '')
      .trim()
      .split('\n')
      .pop();
    throw new Error(
      `GET ${path} failed (curl exit ${error.code ?? '?'})${stderr ? `: ${stderr}` : ''}`,
    );
  }
}

function firstLine(message) {
  return message.split('\n', 1)[0];
}

/**
 * Return the gate files whose latest base-side change this branch does not
 * contain. `fetchJson(path)` is injected so tests never touch the network.
 *
 * Containment uses the swapped three-dot compare `S...head`: its status is
 * "ahead"/"identical" exactly when S is an ancestor of (or equal to) head;
 * "diverged"/"behind" mean the base's gate change never reached the branch.
 */
export async function findStaleGateFiles({
  fetchJson,
  repo,
  baseRef,
  headSha,
  gateFiles = GATE_FILES,
}) {
  const latest = await Promise.all(
    gateFiles.map(async (file) => {
      const commits = await fetchJson(
        `/repos/${repo}/commits?path=${encodeURIComponent(file)}` +
          `&sha=${encodeURIComponent(baseRef)}&per_page=1`,
      );
      const commit = commits[0];
      // Never existed on the base: nothing to be stale against.
      if (!commit) return null;
      return {
        file,
        sha: commit.sha,
        message: firstLine(commit.commit.message),
        date: commit.commit.committer.date,
        url: commit.html_url,
      };
    }),
  );
  const candidates = latest.filter((entry) => entry !== null);
  const verdicts = await Promise.all(
    candidates.map(async (candidate) => {
      const comparison = await fetchJson(
        `/repos/${repo}/compare/${candidate.sha}...${headSha}`,
      );
      return {
        ...candidate,
        contained:
          comparison.status === 'ahead' || comparison.status === 'identical',
      };
    }),
  );
  return verdicts.filter((verdict) => !verdict.contained);
}

export function renderReport(stale, baseRef) {
  const lines = stale.map(
    (entry) =>
      `  - ${entry.file}: ${entry.sha.slice(0, 12)} ${entry.message} ` +
      `(${entry.date.slice(0, 10)})\n    ${entry.url}`,
  );
  return [
    `The lint gate changed on '${baseRef}' after this branch last incorporated it:`,
    '',
    ...lines,
    '',
    'This lane checks out the branch head alone, so its green proves the branch',
    'passes the gate AS THE BRANCH DEFINES IT — with the files above, that gate',
    `is stale. Merge or rebase '${baseRef}' into this branch and push to`,
    're-validate under the current gate.',
  ].join('\n');
}

async function main() {
  const { GITHUB_TOKEN, BASE_REF, HEAD_SHA, GITHUB_REPOSITORY } = process.env;
  if (!GITHUB_TOKEN || !BASE_REF || !HEAD_SHA || !GITHUB_REPOSITORY) {
    console.log(
      '::warning::lint gate freshness: BASE_REF, HEAD_SHA, ' +
        'GITHUB_REPOSITORY or GITHUB_TOKEN missing; skipping the check',
    );
    return;
  }
  try {
    const fetchJson = (path) => curlJson(path, GITHUB_TOKEN);
    const stale = await findStaleGateFiles({
      fetchJson,
      repo: GITHUB_REPOSITORY,
      baseRef: BASE_REF,
      headSha: HEAD_SHA,
    });
    if (stale.length === 0) {
      console.log(
        `Lint gate freshness OK: this branch contains every '${BASE_REF}' ` +
          `change to the ${GATE_FILES.length} gate files.`,
      );
      return;
    }
    console.error(renderReport(stale, BASE_REF));
    process.exitCode = 1;
  } catch (error) {
    console.log(
      `::warning::lint gate freshness check could not run ` +
        `(${error.message}); treating the branch as fresh`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
