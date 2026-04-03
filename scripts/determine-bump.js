/**
 * Analyzes conventional commits since the last git tag and outputs the
 * appropriate semver bump type: "major", "minor", "patch", or "skip".
 *
 * Conventional commit rules:
 *   BREAKING CHANGE footer or ! suffix → major
 *   feat:                              → minor
 *   fix: / perf:                       → patch
 *   chore: / docs: / test: / refactor: / style: / ci: / build: → patch
 *   Merge commits, non-conventional    → patch (conservative default)
 *
 * Commits that are skipped entirely (no bump):
 *   - "chore: release v*"  (version bump commits themselves)
 *   - No commits since last tag
 */

import { execSync } from 'node:child_process';

function getLastTag() {
  try {
    return execSync('git describe --tags --abbrev=0', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function getCommitsSinceTag(tag) {
  const range = tag ? `${tag}..HEAD` : 'HEAD';
  try {
    const output = execSync(`git log ${range} --pretty=format:%s`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return output
      .trim()
      .split('\n')
      .filter((l) => l.trim());
  } catch {
    return [];
  }
}

function determineBump(commits) {
  // Filter out release commits and empty lines
  const meaningful = commits.filter(
    (msg) => msg && !msg.match(/^chore: release v\d/),
  );

  if (meaningful.length === 0) {
    return 'skip';
  }

  let bump = 'patch'; // conservative default

  for (const msg of meaningful) {
    // Breaking change: footer "BREAKING CHANGE" or type with "!" (feat!: / fix!:)
    if (msg.match(/^[a-z]+(\(.+\))?!:/) || msg.includes('BREAKING CHANGE')) {
      return 'major'; // can't go higher, return immediately
    }

    // New feature
    if (msg.match(/^feat(\(.+\))?:/)) {
      bump = 'minor';
    }
  }

  return bump;
}

const lastTag = getLastTag();
const commits = getCommitsSinceTag(lastTag);
const bump = determineBump(commits);

if (process.env.VERBOSE) {
  const tag = lastTag ?? '(no tags)';
  process.stderr.write(`Last tag: ${tag}\n`);
  process.stderr.write(`Commits since tag: ${commits.length}\n`);
  if (commits.length > 0) {
    commits.forEach((c) => process.stderr.write(`  ${c}\n`));
  }
  process.stderr.write(`Determined bump: ${bump}\n`);
}

process.stdout.write(bump);
