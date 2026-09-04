#!/usr/bin/env node

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseNightlyVersion } from './lib/release-helpers.js';

export const REQUIRED_JOBS = [
  'Quality Checks',
  'Integration Tests (No Sandbox)',
  'Integration Tests (Docker)',
  'Publish Release',
];

/**
 * Artifact name prefix written by the Release workflow's "Record release
 * source" step. The recorded SHA — not the nightly tag's name — is the
 * authoritative record of what `publish` checked out and built.
 */
const SOURCE_ARTIFACT_PREFIX = 'release-source-';

const WORKFLOW_PATH = '.github/workflows/release.yml';

/**
 * The publishing run must have been created before the nightly release was
 * published, so the candidate search is bounded to a window around that
 * publication instead of "the last 100 completed runs". Release runs are
 * frequent enough (873 runs in ~14 months, ~100 in the last five weeks) that
 * an unbounded head-of-list scan silently stops finding nightlies older than
 * about a month, long before their evidence artifacts expire.
 */
const RUN_WINDOW_DAYS_BEFORE = 3;
const RUN_WINDOW_DAYS_AFTER = 1;
const MAX_RUN_PAGES = 5;
const RUNS_PER_PAGE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Error code for a deterministic evidence refusal: the gate decided against
 * this nightly based on recorded state (no matching validated run, expired
 * or conflicting evidence, a tag/release/npm shape that is not a published
 * nightly). Retrying cannot change the outcome, so `runCli` marks the step
 * failure as a refusal and the workflow keeps it out of the release-failed
 * notification — probe failures carry no code and stay notifiable.
 */
const PROMOTION_REFUSED = 'PROMOTION_REFUSED';

function promotionRefusal(message) {
  const error = new Error(message);
  error.code = PROMOTION_REFUSED;
  return error;
}

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

function firstLine(value) {
  return String(value ?? '')
    .split('\n')
    .find((line) => line.trim().length > 0)
    ?.trim();
}

function dateOnly(timestampMs) {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

/**
 * Confirm the nightly version is on npm. `npm view pkg@<absent version>`
 * exits non-zero, so the absent case arrives as a thrown error rather than
 * a parseable payload; only an E404 means "absent", anything else means the
 * probe itself could not run and must not read as either answer.
 */
function assertPublishedOnNpm(version, run) {
  let output;
  try {
    output = run('npm', [
      'view',
      `@qwen-code/qwen-code@${version}`,
      'version',
      '--json',
    ]);
  } catch (error) {
    const text = `${error?.stdout ?? ''}\n${error?.stderr ?? ''}\n${error?.message ?? ''}`;
    if (text.includes('E404')) {
      throw promotionRefusal(`${version} is not published on npm`);
    }
    throw new Error(
      `Cannot verify ${version} on npm: ${firstLine(text) ?? 'npm view failed'}`,
    );
  }
  if (parseJson(output, 'npm') !== version) {
    throw promotionRefusal(`${version} is not published on npm`);
  }
}

/**
 * Resolve the nightly tag to the source revision its release commit was
 * built on top of. `publish` creates `chore(release): <tag>` directly on the
 * checked-out source, so the release commit's single parent is that source.
 */
function resolveTaggedSource(parsed, repository, run) {
  const tag = parseJson(
    run('gh', ['api', `repos/${repository}/git/ref/tags/${parsed.nightlyTag}`]),
    'GitHub tag',
  );
  if (tag.object?.type !== 'commit' || !tag.object.sha) {
    throw promotionRefusal(
      `${parsed.nightlyTag} is not a lightweight commit tag`,
    );
  }
  const releaseCommit = parseJson(
    run('gh', ['api', `repos/${repository}/commits/${tag.object.sha}`]),
    'GitHub release commit',
  );
  if (releaseCommit.parents?.length !== 1 || !releaseCommit.parents[0]?.sha) {
    throw promotionRefusal(
      `${parsed.nightlyTag} must point to a release commit with exactly one parent`,
    );
  }
  const subject = releaseCommit.commit?.message?.split('\n', 1)[0];
  if (subject !== `chore(release): ${parsed.nightlyTag}`) {
    throw promotionRefusal(
      `${parsed.nightlyTag} does not point to a release commit`,
    );
  }
  return releaseCommit.parents[0].sha;
}

function listCandidateRuns(repository, publishedAtMs, run) {
  const from = dateOnly(publishedAtMs - RUN_WINDOW_DAYS_BEFORE * DAY_MS);
  const to = dateOnly(publishedAtMs + RUN_WINDOW_DAYS_AFTER * DAY_MS);
  const runs = [];
  let total = 0;
  for (let page = 1; page <= MAX_RUN_PAGES; page += 1) {
    const response = parseJson(
      run('gh', [
        'api',
        `repos/${repository}/actions/workflows/release.yml/runs?status=completed&created=${from}..${to}&per_page=${RUNS_PER_PAGE}&page=${page}`,
      ]),
      'workflow runs',
    );
    if (!Array.isArray(response.workflow_runs)) {
      throw new Error('Workflow runs response has no workflow_runs array');
    }
    runs.push(...response.workflow_runs);
    total = Number.isInteger(response.total_count)
      ? response.total_count
      : runs.length;
    if (response.workflow_runs.length < RUNS_PER_PAGE || runs.length >= total) {
      break;
    }
  }
  if (runs.length < total) {
    throw promotionRefusal(
      `Found ${total} completed Release runs between ${from} and ${to}, more than the ${MAX_RUN_PAGES * RUNS_PER_PAGE} this check pages through; the evidence search would be incomplete rather than fail-closed`,
    );
  }
  return runs.filter(
    (candidate) =>
      candidate.conclusion === 'success' &&
      (candidate.event === 'schedule' ||
        candidate.event === 'workflow_dispatch') &&
      Date.parse(candidate.created_at) <= publishedAtMs &&
      publishedAtMs <= Date.parse(candidate.updated_at),
  );
}

/**
 * The recorded source SHA for a run, or a reason it cannot be used. Only
 * first-attempt runs are eligible: the artifacts API carries no attempt
 * attribution, so on a re-run the recorded SHA and the job conclusions can
 * come from different attempts and cannot be tied together.
 */
function recordedSourceSha(repository, candidate, run) {
  if (candidate.run_attempt !== 1) {
    return {
      reason: `run_attempt is ${candidate.run_attempt}, not a first attempt`,
    };
  }
  const artifacts = parseJson(
    run('gh', [
      'api',
      `repos/${repository}/actions/runs/${candidate.id}/artifacts?per_page=100`,
    ]),
    `artifacts for run ${candidate.id}`,
  ).artifacts;
  if (!Array.isArray(artifacts)) {
    return { reason: 'artifacts response has no artifacts array' };
  }
  const recorded = [
    ...new Set(
      artifacts
        .filter(
          (artifact) =>
            typeof artifact.name === 'string' &&
            artifact.name.startsWith(SOURCE_ARTIFACT_PREFIX) &&
            artifact.expired === false,
        )
        .map((artifact) => artifact.name.slice(SOURCE_ARTIFACT_PREFIX.length))
        .filter((sha) => /^[0-9a-f]{40}$/.test(sha)),
    ),
  ];
  if (recorded.length === 0) {
    return {
      reason: `no unexpired ${SOURCE_ARTIFACT_PREFIX}<sha> artifact (runs predating that step, or evidence past its retention window, cannot be promoted)`,
    };
  }
  if (recorded.length > 1) {
    return { reason: `recorded ${recorded.length} conflicting source SHAs` };
  }
  return { sha: recorded[0] };
}

function jobFailureReason(repository, candidate, run) {
  const jobs = parseJson(
    run('gh', [
      'api',
      `repos/${repository}/actions/runs/${candidate.id}/jobs?per_page=100`,
    ]),
    `jobs for run ${candidate.id}`,
  ).jobs;
  if (!Array.isArray(jobs)) return 'jobs response has no jobs array';
  const conclusions = new Map(jobs.map((job) => [job.name, job.conclusion]));
  const unmet = REQUIRED_JOBS.filter(
    (name) => conclusions.get(name) !== 'success',
  ).map((name) => `${name}=${conclusions.get(name) ?? 'absent'}`);
  return unmet.length > 0
    ? `required jobs not successful: ${unmet.join(', ')}`
    : undefined;
}

function workflowDefinitionSha(repository, ref, run) {
  try {
    return parseJson(
      run('gh', [
        'api',
        `repos/${repository}/contents/${WORKFLOW_PATH}?ref=${ref}`,
      ]),
      'workflow definition',
    ).sha;
  } catch {
    return undefined;
  }
}

export function verifyNightlyPromotion(
  input,
  repository,
  run = exec,
  currentSha = process.env.GITHUB_SHA,
) {
  if (!repository) {
    throw new Error('GITHUB_REPOSITORY is required');
  }
  const parsed = parseNightlyVersion(input);
  const taggedSourceSha = resolveTaggedSource(parsed, repository, run);

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
    throw promotionRefusal(
      `${parsed.nightlyTag} is not a published prerelease`,
    );
  }

  assertPublishedOnNpm(parsed.nightlyVersion, run);

  const publishedAtMs = Date.parse(release.publishedAt);
  const candidates = listCandidateRuns(repository, publishedAtMs, run);
  const rejections = [];
  for (const candidate of candidates) {
    const recorded = recordedSourceSha(repository, candidate, run);
    if (!recorded.sha) {
      rejections.push(`run ${candidate.id}: ${recorded.reason}`);
      continue;
    }
    // Two independent records of what was built must agree: the SHA the run
    // recorded before building, and the parent of the release commit the tag
    // points at. A disagreement means the run's `prepare` and `publish`
    // resolved different revisions, so nothing here can say which one the
    // published nightly actually contains.
    if (recorded.sha !== taggedSourceSha) {
      rejections.push(
        `run ${candidate.id}: recorded source ${recorded.sha} does not match the tagged release parent ${taggedSourceSha}`,
      );
      continue;
    }
    const jobReason = jobFailureReason(repository, candidate, run);
    if (jobReason) {
      rejections.push(`run ${candidate.id}: ${jobReason}`);
      continue;
    }

    const warnings = [];
    // The nightly version's short SHA is a human-readable label produced by
    // `prepare`; it is not evidence. It can legitimately lag the revision
    // that was built (a re-run whose `prepare` outputs were reused), so a
    // mismatch is reported rather than treated as a rejection — the recorded
    // artifact and the tagged parent above are what bind the source.
    if (!taggedSourceSha.startsWith(parsed.sourceShaPrefix)) {
      warnings.push(
        `${parsed.nightlyTag} is labelled with source ${parsed.sourceShaPrefix}, but it was built from ${taggedSourceSha}`,
      );
    }
    // Validation is reused from a run that used the release workflow as it
    // stood then. If the workflow has since gained checks, promotion skips
    // them; say so rather than letting the gap pass unremarked.
    const validationWorkflowSha = workflowDefinitionSha(
      repository,
      candidate.head_sha,
      run,
    );
    const currentWorkflowSha = currentSha
      ? workflowDefinitionSha(repository, currentSha, run)
      : undefined;
    if (
      validationWorkflowSha &&
      currentWorkflowSha &&
      validationWorkflowSha !== currentWorkflowSha
    ) {
      warnings.push(
        `${WORKFLOW_PATH} changed since run ${candidate.id} validated this source; any validation added after it is skipped by this promotion`,
      );
    }

    return {
      ...parsed,
      sourceSha: recorded.sha,
      taggedSourceSha,
      validationRunId: candidate.id,
      validationRunUrl: candidate.html_url,
      validationWorkflowSha,
      currentWorkflowSha,
      warnings,
    };
  }

  const detail =
    rejections.length > 0
      ? ` Rejected: ${rejections.join('; ')}.`
      : ` No completed Release run published ${parsed.nightlyTag}.`;
  throw promotionRefusal(
    `${parsed.nightlyTag} has no matching successful Release run with every required validation job.${detail}`,
  );
}

/**
 * Report the verdict to the Release run: the source SHA and the
 * validation-reuse flag as step outputs, the evidence as a step summary, and
 * any soft finding as an annotation. Writing these here rather than piping
 * the JSON through `jq` in the workflow keeps the reporting testable and
 * keeps release.yml from carrying another block of shell.
 */
export function reportPromotion(result, env = process.env) {
  for (const warning of result.warnings ?? []) {
    console.error(`::warning::${warning}`);
  }
  if (env.GITHUB_OUTPUT) {
    appendFileSync(
      env.GITHUB_OUTPUT,
      ['source_sha=' + result.sourceSha, 'reuse_validation=true', ''].join(
        '\n',
      ),
    );
  }
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      [
        '### Nightly promotion',
        '',
        `- Nightly: \`${result.nightlyTag}\``,
        `- Source: \`${result.sourceSha}\``,
        `- Validation: ${result.validationRunUrl}`,
        ...(result.warnings ?? []).map((warning) => `- :warning: ${warning}`),
        '',
      ].join('\n'),
    );
  }
}

/**
 * Mark the step failure as a decisive refusal for the workflow's failure
 * notifier: a deterministic evidence refusal is a correct outcome, not a
 * release failure, so it must not open a "Release Failed" issue or
 * dispatch autofix. Probe failures carry no marker and stay notifiable.
 */
export function reportRefusal(env = process.env) {
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, 'promotion_refusal=true\n');
  }
}

export function runCli(args = process.argv.slice(2), env = process.env) {
  try {
    reportPromotion(
      verifyNightlyPromotion(args[0], env.GITHUB_REPOSITORY),
      env,
    );
    return 0;
  } catch (error) {
    // stdout, not stderr: the runner parses workflow commands from
    // stdout only, so ::error:: on stderr would never annotate.
    console.log(`::error::${error.message}`);
    if (error.code === PROMOTION_REFUSED) {
      reportRefusal(env);
    }
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli();
}
