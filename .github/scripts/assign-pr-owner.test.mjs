// Guards for path-driven PR assignment. Load-bearing pieces with no other
// test: the pure functions that decide *whether* and *to whom* a PR is
// assigned, the one-assignment-per-PR idempotency, and the workflow
// invariants that keep the pull_request_target trigger safe (trusted-base
// checkout, repository guard, job-scoped permissions, step-scoped token).
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

import { loadPolicy } from './assign-issue-owner.mjs';
import {
  alreadyCovered,
  matchAreaByPath,
  skipPrReason,
} from './assign-pr-owner.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptsDir, '..', '..');
const script = join(scriptsDir, 'assign-pr-owner.mjs');
const policy = loadPolicy(
  readFileSync(join(repoRoot, '.github', 'issue-owners.json'), 'utf8'),
);
const tempDirs = [];

const corePr = {
  state: 'OPEN',
  isDraft: false,
  author: { login: 'some-contributor' },
  assignees: [],
  latestReviews: [],
};

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('assign-pr-owner: pure routing', () => {
  it('routes module paths to their module area, everything else to the fallback', () => {
    const area = matchAreaByPath(policy, [{ path: 'packages/core/src/x.ts' }]);
    assert.equal(area?.name, 'core');
    const module = matchAreaByPath(policy, [
      { path: 'packages/core/src/skills/loader.ts' },
    ]);
    assert.equal(module?.name, 'core-skills');
    // A module entry overrides the coarser fallback even when the PR also
    // touches files only the fallback covers.
    const mixed = matchAreaByPath(policy, [
      { path: 'packages/core/src/index.ts' },
      { path: 'packages/core/src/goals/goal.ts' },
    ]);
    assert.equal(mixed?.name, 'core-goals');
  });

  it('never matches outside the mapped prefixes', () => {
    assert.equal(
      matchAreaByPath(policy, [{ path: 'packages/cli/src/x.ts' }]),
      null,
    );
    // A prefix string must be a directory prefix, not a substring.
    assert.equal(
      matchAreaByPath(policy, [{ path: 'packages/coredump/x.ts' }]),
      null,
    );
  });

  it('skips closed, draft, and bot-authored PRs', () => {
    assert.equal(skipPrReason(corePr), null);
    assert.ok(skipPrReason({ ...corePr, state: 'MERGED' }));
    assert.ok(skipPrReason({ ...corePr, isDraft: true }));
    assert.ok(
      skipPrReason({ ...corePr, author: { login: 'qwen-code-ci-bot' } }),
    );
    assert.ok(
      skipPrReason({ ...corePr, author: { login: 'dependabot[bot]' } }),
    );
  });

  it('treats a mapped assignee or reviewer as covered', () => {
    const owner = policy.areas[0].owners[0];
    assert.ok(
      alreadyCovered(policy, { ...corePr, assignees: [{ login: owner }] }),
    );
    assert.ok(
      alreadyCovered(policy, {
        ...corePr,
        latestReviews: [{ author: { login: owner }, state: 'APPROVED' }],
      }),
    );
    // Case-insensitively, and only for mapped owners.
    assert.ok(
      alreadyCovered(policy, {
        ...corePr,
        assignees: [{ login: owner.toUpperCase() }],
      }),
    );
    assert.equal(
      alreadyCovered(policy, {
        ...corePr,
        assignees: [{ login: 'random-person' }],
      }),
      false,
    );
  });
});

// The stub reports the zeroLoadOwner as the least loaded owner so the pick is
// unambiguous regardless of the rotation offset for PR 77.
function runAssign(dryRun, options = {}) {
  const {
    prJson = JSON.stringify(corePr),
    files = 'packages/core/src/foo.ts',
    zeroLoadOwner = 'DennisYu07',
    editExit = 0,
    editErr = '',
  } = options;
  const dir = mkdtempSync(join(tmpdir(), 'assign-pr-owner-'));
  tempDirs.push(dir);
  const log = join(dir, 'gh.log');
  const gh = join(dir, 'gh');
  writeFileSync(
    gh,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_STUB_LOG"
case "$*" in
  "pr view 77 "*) printf '%s' "$GH_STUB_PR" ;;
  *"pulls/77/files"*) printf '%s' "$GH_STUB_FILES" ;;
  *"/collaborators/"*"/permission"*) printf '%s' 'write' ;;
  *"--assignee ${zeroLoadOwner}"*"--json number"*) printf '%s' '0' ;;
  *"issue list"*"--json number"*) printf '%s' '5' ;;
  "pr edit "*) printf '%s' "$GH_STUB_EDIT_ERR" >&2; exit "$GH_STUB_EDIT_EXIT" ;;
esac
`,
  );
  chmodSync(gh, 0o755);
  const result = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      GH_STUB_LOG: log,
      GH_STUB_PR: prJson,
      GH_STUB_FILES: files,
      GH_STUB_EDIT_EXIT: String(editExit),
      GH_STUB_EDIT_ERR: editErr,
      GITHUB_REPOSITORY: 'QwenLM/qwen-code',
      GITHUB_STEP_SUMMARY: '',
      PR_NUMBER: '77',
      DRY_RUN: String(dryRun),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return { log: readFileSync(log, 'utf8'), stdout: result.stdout };
}

describe('assign-pr-owner: apply boundary', () => {
  it('assigns the least loaded eligible owner', () => {
    const { log, stdout } = runAssign(false);
    assert.match(log, /pr edit 77 .*--add-assignee DennisYu07/);
    assert.match(stdout, /assigned @DennisYu07/);
  });

  it('performs no mutation in dry-run mode', () => {
    const { log, stdout } = runAssign(true);
    assert.doesNotMatch(log, /pr edit/);
    assert.match(stdout, /dry-run — would assign @DennisYu07/);
  });

  it('never assigns the PR author to their own work', () => {
    const { log, stdout } = runAssign(false, {
      prJson: JSON.stringify({ ...corePr, author: { login: 'DennisYu07' } }),
      // Without the exclusion the zero-load author would win outright.
    });
    assert.doesNotMatch(log, /--add-assignee DennisYu07\b/);
    assert.match(stdout, /assigned @/);
  });

  it('no-ops once a mapped owner is already on the PR', () => {
    const owner = policy.areas[0].owners[0];
    const { log, stdout } = runAssign(false, {
      prJson: JSON.stringify({
        ...corePr,
        assignees: [{ login: owner }],
      }),
    });
    assert.doesNotMatch(log, /pr edit/);
    assert.match(stdout, /already on the PR/);
  });

  it('skips when no area path matches', () => {
    const { log, stdout } = runAssign(false, {
      files: 'packages/cli/src/index.ts',
    });
    assert.doesNotMatch(log, /pr edit/);
    assert.match(stdout, /no area path matched/);
  });

  it('falls back to the coarser area when the module owner authored the PR', () => {
    const module = policy.areas.find((area) => area.name === 'core-skills');
    const { log, stdout } = runAssign(false, {
      prJson: JSON.stringify({
        ...corePr,
        author: { login: module.owners[0] },
      }),
      files: 'packages/core/src/skills/loader.ts',
    });
    assert.match(stdout, /falling back to core/);
    assert.match(log, /pr edit 77 .*--add-assignee DennisYu07/);
  });

  it('tolerates a read-only token instead of failing', () => {
    const { log, stdout } = runAssign(false, {
      editExit: 1,
      editErr: 'HTTP 403: Resource not accessible by integration',
    });
    assert.doesNotMatch(stdout, /assigned @/);
    assert.match(stdout, /token cannot assign/);
    assert.match(log, /pr edit/);
  });
});

const doc = parse(
  readFileSync(
    join(repoRoot, '.github', 'workflows', 'assign-pr-owner.yml'),
    'utf8',
  ),
);
// YAML 1.1 parses the bare key `on` as boolean true.
const triggers = doc.on ?? doc[true];
const assignJob = doc.jobs.assign;

describe('assign-pr-owner: workflow invariants', () => {
  it('runs only on the canonical repository', () => {
    assert.match(assignJob.if, /github\.repository == 'QwenLM\/qwen-code'/);
  });

  it('scopes the write permission to the job and the token to the step', () => {
    assert.equal(doc.permissions['pull-requests'], undefined);
    assert.equal(assignJob.permissions['pull-requests'], 'write');
    const runStep = assignJob.steps.find((step) => step.run);
    assert.ok(runStep.env.GH_TOKEN);
    assert.equal(doc.env?.GH_TOKEN, undefined);
  });

  it('checks out the trusted base, credential-free and sparse', () => {
    const checkout = assignJob.steps.find((step) =>
      step.uses?.startsWith('actions/checkout@'),
    );
    assert.match(checkout.with.ref, /pull_request\.base\.sha/);
    assert.equal(checkout.with['persist-credentials'], false);
    assert.match(checkout.with['sparse-checkout'], /issue-owners\.json/);
    // Nothing from the PR head can execute: the checkout never follows it.
    assert.doesNotMatch(checkout.with.ref, /head\.sha/);
  });

  it('defaults a manual dispatch to dry-run', () => {
    assert.equal(triggers.workflow_dispatch.inputs.dry_run.default, true);
  });
});
