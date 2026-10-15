#!/usr/bin/env node
/**
 * Ratchet the PR-stage CI budget: job count, declared timeout minutes, and
 * count of jobs with no timeout at all.
 *
 * The other two ratchets in this repo measure workflow file BYTES
 * (check-workflow-size.sh + .size-baseline) and test LINE COUNT
 * (check-test-growth.mjs). Neither measures what a contributor actually pays:
 * how many checks a single PR push fans out into, and how long they are
 * allowed to run. On main today that is 18 PR-stage workflows, 60 jobs and
 * 2185 declared timeout minutes (36.4 h), with 14 jobs declaring no
 * timeout-minutes at all — GitHub's 360-minute default, so one hung job can
 * hold a self-hosted runner for six hours. A new lane can be added and none
 * of the existing gates objects.
 *
 * The measured cost is worse than the declared one, because the self-hosted
 * pool serialises: PR #13219's SDK Java run took 102.7 min wall for 102.0 min
 * of summed job execution, with individual jobs queueing 50-91 min before
 * starting. This gate does not fix queueing; it stops the thing that makes
 * queueing worse from growing unreviewed.
 *
 * Same contract as check-workflow-size.sh: growing a workflow past its
 * recorded budget requires bumping .ci-budget IN THE SAME PR, which turns
 * invisible drift into one reviewed line. Growth is allowed deliberately —
 * bump the number and say why. The ratchet fails closed, never open.
 *
 * Dep-free by design (node: builtins only) so it runs in the fast lane of
 * lint_and_static, before any dependency install.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename } from 'node:path';

export const WORKFLOW_DIR = '.github/workflows';
export const BASELINE_FILE = join(WORKFLOW_DIR, '.ci-budget');
/** Slack before a growth trips the gate; mirrors GROWTH_ALLOWANCE's intent. */
export const GROWTH_ALLOWANCE = 0;

/** Triggers that make a workflow run during PR review. */
export const PR_STAGE_TRIGGERS = [
  'pull_request',
  'pull_request_target',
  'merge_group',
];

/**
 * Extract the top-level `on:` trigger names from workflow source.
 *
 * YAML parses a bare `on` key as boolean true, so a workflow written as
 * `true:` is the same trigger block — both spellings appear in this repo.
 */
export function parseTriggers(source) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => /^(on|true):\s*$/.test(l));
  if (start === -1) return [];
  const triggers = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const m = /^ {2}([a-z_]+)\s*:/.exec(line);
    if (m) triggers.push(m[1]);
  }
  return triggers;
}

/**
 * Collect the jobs a workflow declares, with their timeout-minutes.
 *
 * Returns null when the jobs block cannot be located, so callers fail closed
 * rather than silently recording a budget of zero for a real workflow.
 */
export function parseJobs(source) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start === -1) return null;
  const jobs = [];
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const jobMatch = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobMatch) {
      current = { name: jobMatch[1], timeoutMinutes: null };
      jobs.push(current);
      continue;
    }
    if (!current) continue;
    // Only the job-level key counts. A step's own timeout-minutes is a
    // per-step bound, not the job budget this gate is ratcheting.
    const timeoutMatch = /^ {4}timeout-minutes:\s*(\d+)\s*$/.exec(line);
    if (timeoutMatch && current.timeoutMinutes === null) {
      current.timeoutMinutes = Number(timeoutMatch[1]);
    }
  }
  return jobs;
}

/** Per-workflow PR-stage budget, or null when the workflow is not PR-stage. */
export function measureWorkflow(source) {
  const triggers = parseTriggers(source);
  const prStage = triggers.filter((t) => PR_STAGE_TRIGGERS.includes(t));
  if (prStage.length === 0) return null;
  const jobs = parseJobs(source);
  if (jobs === null) return null;
  return {
    triggers: prStage,
    jobCount: jobs.length,
    timeoutMinutes: jobs.reduce((sum, j) => sum + (j.timeoutMinutes ?? 0), 0),
    jobsWithoutTimeout: jobs
      .filter((j) => j.timeoutMinutes === null)
      .map((j) => j.name),
  };
}

/**
 * Parse the baseline ledger. Malformed lines are reported rather than
 * skipped: a silently dropped entry makes the ratchet fail open.
 */
export function parseBaseline(source) {
  const entries = new Map();
  const errors = [];
  source.split('\n').forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    const parts = trimmed.split(/\s+/);
    if (parts.length !== 5) {
      errors.push(
        `${BASELINE_FILE}:${index + 1} expected '<jobs> <timeout-min> <no-timeout-jobs> <triggers> <file>', got '${trimmed}'`,
      );
      return;
    }
    const [jobCount, timeoutMinutes, noTimeout, triggers, file] = parts;
    if (
      ![jobCount, timeoutMinutes, noTimeout].every((v) =>
        /^(0|[1-9][0-9]*)$/.test(v),
      )
    ) {
      errors.push(
        `${BASELINE_FILE}:${index + 1} numeric fields must be decimal integers without leading zeros, got '${trimmed}'`,
      );
      return;
    }
    entries.set(file, {
      jobCount: Number(jobCount),
      timeoutMinutes: Number(timeoutMinutes),
      jobsWithoutTimeout: Number(noTimeout),
      triggers,
    });
  });
  return { entries, errors };
}

/**
 * True when this PR did not touch the workflow, meaning a budget overrun is
 * main-side drift from a missing baseline bump rather than this PR's growth.
 * Mirrors check-workflow-size.sh's file_matches_base: unrelated PRs get a
 * warning, the PR that grew the file gets an error.
 */
function unchangedFromBase(file, baseSha) {
  if (!baseSha) return false;
  try {
    execFileSync(
      'git',
      ['rev-parse', '--verify', '--quiet', `${baseSha}^{commit}`],
      {
        stdio: 'ignore',
      },
    );
  } catch {
    try {
      execFileSync(
        'git',
        ['fetch', '--depth=1', '--quiet', 'origin', baseSha],
        {
          stdio: 'ignore',
        },
      );
    } catch {
      return null; // unresolvable base — callers fail strict
    }
  }
  try {
    const base = execFileSync('git', ['show', `${baseSha}:${file}`], {
      encoding: 'utf8',
    });
    return base === readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

const DIMENSIONS = [
  { key: 'jobCount', label: 'PR-stage jobs' },
  { key: 'timeoutMinutes', label: 'declared timeout-minutes' },
  { key: 'jobsWithoutTimeout', label: 'jobs with no timeout-minutes' },
];

export function checkBudget({
  workflowDir = WORKFLOW_DIR,
  baselineFile = BASELINE_FILE,
  baseSha = '',
} = {}) {
  const errors = [];
  const warnings = [];

  if (!existsSync(baselineFile)) {
    return {
      errors: [
        `${baselineFile} is missing or unreadable — the CI budget ratchet cannot run`,
      ],
      warnings,
      ledger: [],
    };
  }
  const { entries, errors: baselineErrors } = parseBaseline(
    readFileSync(baselineFile, 'utf8'),
  );
  errors.push(...baselineErrors);

  const ledger = [];
  for (const name of readdirSync(workflowDir).sort()) {
    if (!/\.ya?ml$/.test(name)) continue;
    const file = join(workflowDir, name);
    const measured = measureWorkflow(readFileSync(file, 'utf8'));
    if (measured === null) continue;

    const recorded = entries.get(name);
    const noTimeoutCount = measured.jobsWithoutTimeout.length;
    ledger.push({
      file: name,
      ...measured,
      jobsWithoutTimeoutCount: noTimeoutCount,
    });

    if (!recorded) {
      const match = unchangedFromBase(file, baseSha);
      const entry = `${measured.jobCount} ${measured.timeoutMinutes} ${noTimeoutCount} ${measured.triggers.join('+')} ${name}`;
      if (match === true) {
        warnings.push(
          `${file} has no entry in ${baselineFile}, but is unchanged from this PR's base — add '${entry}' on main so its budget is tracked; unrelated PRs are not blocked.`,
        );
      } else {
        errors.push(
          `${file} has no entry in ${baselineFile}. Add '${entry}' so its PR-stage budget is tracked.`,
        );
        if (match === null)
          warnings.push(
            `base ${baseSha} could not be resolved (git fetch failed?) — failing strict; if this PR did not touch ${file}, re-run the job.`,
          );
      }
      continue;
    }

    const actual = {
      jobCount: measured.jobCount,
      timeoutMinutes: measured.timeoutMinutes,
      jobsWithoutTimeout: noTimeoutCount,
    };
    const grown = DIMENSIONS.filter(
      ({ key }) => actual[key] > recorded[key] + GROWTH_ALLOWANCE,
    );
    if (grown.length > 0) {
      const detail = grown
        .map(({ key, label }) => `${label} ${recorded[key]} → ${actual[key]}`)
        .join(', ');
      const match = unchangedFromBase(file, baseSha);
      if (match === true) {
        warnings.push(
          `${file} exceeds its recorded budget (${detail}), but is unchanged from this PR's base — the baseline went stale on main, not in this PR. Bump ${baselineFile} on main; unrelated PRs are not blocked.`,
        );
      } else {
        errors.push(
          `${file} grew its PR-stage CI budget: ${detail} (recorded in ${baselineFile}). Split the lane, gate it on paths, or move it to merge_group/post-merge — or, if the growth is real, update ${baselineFile} in this PR and say why.`,
        );
        if (match === null)
          warnings.push(
            `base ${baseSha} could not be resolved (git fetch failed?) — failing strict; if this PR did not touch ${file}, re-run the job.`,
          );
      }
      continue;
    }

    const shrunk = DIMENSIONS.filter(({ key }) => actual[key] < recorded[key]);
    if (shrunk.length > 0) {
      const entry = `${actual.jobCount} ${actual.timeoutMinutes} ${noTimeoutCount} ${measured.triggers.join('+')} ${name}`;
      warnings.push(
        `${file} is under its recorded budget (${shrunk.map(({ label, key }) => `${label} ${recorded[key]} → ${actual[key]}`).join(', ')}) — lower its ${baselineFile} entry to '${entry}' so the slack is not banked.`,
      );
    }
  }

  // An entry for a workflow that stopped being PR-stage, or was deleted,
  // silently stops ratcheting anything. Surface it instead of letting the
  // ledger drift.
  for (const [name] of entries) {
    if (!ledger.some((l) => l.file === name)) {
      if (!existsSync(join(workflowDir, name))) {
        warnings.push(
          `${baselineFile} still records ${name}, which no longer exists — drop the entry.`,
        );
      } else {
        warnings.push(
          `${baselineFile} records ${name} as PR-stage, but it no longer triggers on ${PR_STAGE_TRIGGERS.join(' / ')} — drop the entry.`,
        );
      }
    }
  }

  return { errors, warnings, ledger };
}

function main() {
  const { errors, warnings, ledger } = checkBudget({
    baseSha: process.env.CI_BUDGET_BASE_SHA || '',
  });
  for (const w of warnings) console.log(`::warning::${w}`);
  for (const e of errors) console.log(`::error::${e}`);
  if (errors.length === 0) {
    const jobs = ledger.reduce((s, l) => s + l.jobCount, 0);
    const minutes = ledger.reduce((s, l) => s + l.timeoutMinutes, 0);
    console.log(
      `✅ PR-stage CI budget holds: ${ledger.length} workflows, ${jobs} jobs, ${minutes} declared timeout-minutes${warnings.length ? ' (stale-baseline warnings above)' : ''}`,
    );
  }
  process.exit(errors.length === 0 ? 0 : 1);
}

if (process.argv[1] && basename(process.argv[1]) === 'check-ci-budget.mjs')
  main();
