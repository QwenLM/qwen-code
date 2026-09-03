#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseNightlyVersion } from './lib/release-helpers.js';

const REQUIRED_JOBS = [
  'Quality Checks',
  'Integration Tests (No Sandbox)',
  'Integration Tests (Docker)',
  'Publish Release',
];

function exec(command, args) {
  return execFileSync(command, args, { encoding: 'utf8' }).trim();
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid ${label} response: ${error.message}`);
  }
}

export function verifyNightlyPromotion(input, repository, run = exec) {
  if (!repository) {
    throw new Error('GITHUB_REPOSITORY is required');
  }
  const parsed = parseNightlyVersion(input);
  const tag = parseJson(
    run('gh', ['api', `repos/${repository}/git/ref/tags/${parsed.nightlyTag}`]),
    'GitHub tag',
  );
  if (tag.object?.type !== 'commit' || !tag.object.sha) {
    throw new Error(`${parsed.nightlyTag} is not a lightweight commit tag`);
  }
  const releaseCommit = parseJson(
    run('gh', ['api', `repos/${repository}/commits/${tag.object.sha}`]),
    'GitHub release commit',
  );
  if (releaseCommit.parents?.length !== 1 || !releaseCommit.parents[0]?.sha) {
    throw new Error(
      `${parsed.nightlyTag} must point to a release commit with exactly one parent`,
    );
  }
  const sourceSha = releaseCommit.parents[0].sha;
  if (!sourceSha.startsWith(parsed.sourceShaPrefix)) {
    throw new Error(
      `${parsed.nightlyTag} names source ${parsed.sourceShaPrefix}, but its release commit points to ${sourceSha}`,
    );
  }
  const subject = releaseCommit.commit?.message?.split('\n', 1)[0];
  if (subject !== `chore(release): ${parsed.nightlyTag}`) {
    throw new Error(`${parsed.nightlyTag} does not point to a release commit`);
  }

  const release = parseJson(
    run('gh', [
      'release',
      'view',
      parsed.nightlyTag,
      '--repo',
      repository,
      '--json',
      'isPrerelease,publishedAt,tagName',
    ]),
    'GitHub release',
  );
  if (
    release.tagName !== parsed.nightlyTag ||
    release.isPrerelease !== true ||
    !release.publishedAt
  ) {
    throw new Error(`${parsed.nightlyTag} is not a published prerelease`);
  }

  const npmVersion = parseJson(
    run('npm', [
      'view',
      `@qwen-code/qwen-code@${parsed.nightlyVersion}`,
      'version',
      '--json',
    ]),
    'npm',
  );
  if (npmVersion !== parsed.nightlyVersion) {
    throw new Error(`${parsed.nightlyVersion} is not published on npm`);
  }

  const runs = parseJson(
    run('gh', [
      'api',
      `repos/${repository}/actions/workflows/release.yml/runs?status=completed&per_page=100`,
    ]),
    'workflow runs',
  ).workflow_runs;
  if (!Array.isArray(runs)) {
    throw new Error('Workflow runs response has no workflow_runs array');
  }

  const publishedAt = Date.parse(release.publishedAt);
  const candidates = runs.filter(
    (candidate) =>
      candidate.conclusion === 'success' &&
      candidate.run_attempt === 1 &&
      (candidate.event === 'schedule' ||
        candidate.event === 'workflow_dispatch') &&
      Date.parse(candidate.created_at) <= publishedAt &&
      publishedAt <= Date.parse(candidate.updated_at),
  );
  for (const candidate of candidates) {
    const artifacts = parseJson(
      run('gh', [
        'api',
        `repos/${repository}/actions/runs/${candidate.id}/artifacts?per_page=100`,
      ]),
      `artifacts for run ${candidate.id}`,
    ).artifacts;
    if (
      !Array.isArray(artifacts) ||
      !artifacts.some(
        (artifact) =>
          artifact.name === `release-source-${sourceSha}` &&
          artifact.expired === false,
      )
    ) {
      continue;
    }
    const jobs = parseJson(
      run('gh', [
        'api',
        `repos/${repository}/actions/runs/${candidate.id}/jobs?per_page=100`,
      ]),
      `jobs for run ${candidate.id}`,
    ).jobs;
    if (!Array.isArray(jobs)) continue;
    const conclusions = new Map(jobs.map((job) => [job.name, job.conclusion]));
    if (REQUIRED_JOBS.every((name) => conclusions.get(name) === 'success')) {
      return {
        ...parsed,
        sourceSha,
        validationRunId: candidate.id,
        validationRunUrl: candidate.html_url,
      };
    }
  }

  throw new Error(
    `${parsed.nightlyTag} has no matching successful Release run with every required validation job`,
  );
}

export function runCli(args = process.argv.slice(2)) {
  try {
    const result = verifyNightlyPromotion(
      args[0],
      process.env.GITHUB_REPOSITORY,
    );
    console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    console.error(`::error::${error.message}`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli();
}
