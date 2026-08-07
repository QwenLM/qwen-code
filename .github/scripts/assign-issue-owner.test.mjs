// Guards for label-driven issue assignment. Two things are load-bearing and
// have no other test: the pure policy functions that decide *whether* and *to
// whom* an issue is assigned, and the workflow invariants (repository guard,
// permission split, step-scoped token) that keep the write token narrow.
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

import {
  loadPolicy,
  matchArea,
  pickOwner,
  skipReason,
} from './assign-issue-owner.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptsDir, '..', '..');
const script = join(scriptsDir, 'assign-issue-owner.mjs');
const ownersRaw = readFileSync(
  join(repoRoot, '.github', 'issue-owners.json'),
  'utf8',
);
const policy = loadPolicy(ownersRaw);
const tempDirs = [];

const coreIssue = {
  state: 'OPEN',
  assignees: [],
  labels: [{ name: 'category/core' }, { name: 'need-discussion' }],
};

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('assign-issue-owner: owner map', () => {
  it('parses the checked-in map', () => {
    assert.ok(policy.areas.length > 0);
    assert.ok(policy.areas.every((area) => area.owners.length > 0));
  });

  it('lists only logins that CODEOWNERS already trusts', () => {
    const codeowners = readFileSync(
      join(repoRoot, '.github', 'CODEOWNERS'),
      'utf8',
    );
    const known = new Set(
      [...codeowners.matchAll(/@([A-Za-z0-9][A-Za-z0-9-]*)/g)].map(
        (match) => match[1],
      ),
    );
    for (const area of policy.areas) {
      for (const owner of area.owners) {
        assert.ok(known.has(owner), `${owner} is not in CODEOWNERS`);
      }
    }
  });

  it('rejects a malformed login rather than passing it to gh', () => {
    const broken = JSON.parse(ownersRaw);
    broken.areas[0].owners = ['not a login'];
    assert.throws(() => loadPolicy(JSON.stringify(broken)), /invalid login/);
  });

  it('rejects an area with no labels', () => {
    const broken = JSON.parse(ownersRaw);
    broken.areas[0].labels = [];
    assert.throws(() => loadPolicy(JSON.stringify(broken)), /needs labels/);
  });
});

describe('assign-issue-owner: skip policy', () => {
  it('assigns an open, unassigned, correctly labelled issue', () => {
    assert.equal(skipReason(policy, coreIssue), null);
  });

  it('leaves a closed issue alone', () => {
    assert.match(
      skipReason(policy, { ...coreIssue, state: 'CLOSED' }),
      /not open/,
    );
  });

  it('never reassigns an issue that already has an assignee', () => {
    assert.match(
      skipReason(policy, { ...coreIssue, assignees: [{ login: 'someone' }] }),
      /already has an assignee/,
    );
  });

  it('leaves community-facing issues to the community', () => {
    assert.match(
      skipReason(policy, {
        ...coreIssue,
        labels: [...coreIssue.labels, { name: 'welcome-pr' }],
      }),
      /welcome-pr/,
    );
  });

  it('waits for every required label', () => {
    assert.match(
      skipReason(policy, { ...coreIssue, labels: [{ name: 'category/core' }] }),
      /missing need-discussion/,
    );
  });
});

describe('assign-issue-owner: area matching', () => {
  it('matches an area on any of its labels', () => {
    assert.equal(matchArea(policy, coreIssue).name, 'core');
    assert.equal(
      matchArea(policy, { ...coreIssue, labels: [{ name: 'scope/core' }] })
        .name,
      'core',
    );
  });

  it('returns no area when nothing matches', () => {
    assert.equal(
      matchArea(policy, { ...coreIssue, labels: [{ name: 'category/ui' }] }),
      null,
    );
  });
});

describe('assign-issue-owner: owner selection', () => {
  const owners = ['a', 'b', 'c'];

  it('picks the least loaded owner', () => {
    const load = new Map([
      ['a', 7],
      ['b', 1],
      ['c', 4],
    ]);
    assert.equal(pickOwner(owners, load, 1), 'b');
    assert.equal(pickOwner(owners, load, 2), 'b');
  });

  it('rotates between equally loaded owners instead of always picking the first', () => {
    const load = new Map(owners.map((owner) => [owner, 0]));
    const picks = [0, 1, 2, 3].map((n) => pickOwner(owners, load, n));
    assert.deepEqual(picks, ['a', 'b', 'c', 'a']);
  });
});

// The stub reports wenshao as the least loaded owner so the pick is
// unambiguous regardless of the rotation offset for issue 42.
function runAssign(dryRun) {
  const dir = mkdtempSync(join(tmpdir(), 'assign-issue-owner-'));
  tempDirs.push(dir);
  const log = join(dir, 'gh.log');
  const gh = join(dir, 'gh');
  writeFileSync(
    gh,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_STUB_LOG"
case "$*" in
  "issue view 42 "*) printf '%s' '{"state":"OPEN","labels":[{"name":"category/core"},{"name":"need-discussion"}],"assignees":[]}' ;;
  *"/collaborators/"*"/permission"*) printf '%s' 'write' ;;
  *"--assignee wenshao"*"--json number"*) printf '%s' '0' ;;
  *"issue list"*"--json number"*) printf '%s' '5' ;;
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
      GITHUB_REPOSITORY: 'QwenLM/qwen-code',
      GITHUB_STEP_SUMMARY: '',
      ISSUE_NUMBER: '42',
      DRY_RUN: String(dryRun),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return { log: readFileSync(log, 'utf8'), stdout: result.stdout };
}

describe('assign-issue-owner: apply boundary', () => {
  it('verifies push access before assigning', () => {
    const { log } = runAssign(false);
    assert.match(log, /collaborators\/wenshao\/permission/);
  });

  it('performs no mutation in dry-run mode', () => {
    const { log, stdout } = runAssign(true);
    assert.doesNotMatch(log, /issue edit/);
    assert.match(stdout, /dry-run — would assign @wenshao/);
  });

  it('assigns the least loaded eligible owner', () => {
    const { log, stdout } = runAssign(false);
    assert.match(log, /issue edit 42 .*--add-assignee wenshao/);
    assert.match(stdout, /assigned @wenshao/);
  });
});

const doc = parse(
  readFileSync(
    join(repoRoot, '.github', 'workflows', 'assign-issue-owner.yml'),
    'utf8',
  ),
);
const assignJob = doc.jobs.assign;
const checkoutStep = assignJob.steps.find((s) =>
  s.uses?.startsWith('actions/checkout@'),
);
const assignStep = assignJob.steps.find((s) => s.name === 'Assign area owner');

describe('assign-issue-owner: workflow invariants', () => {
  it('runs only on the canonical repository', () => {
    assert.match(
      String(assignJob.if),
      /github\.repository == 'QwenLM\/qwen-code'/,
    );
  });

  it('grants issues:write to the job, not the whole workflow', () => {
    assert.deepEqual(doc.permissions, { contents: 'read' });
    assert.deepEqual(assignJob.permissions, {
      contents: 'read',
      issues: 'write',
    });
  });

  it('scopes the write token to the step and keeps checkout credential-free', () => {
    assert.equal(
      assignJob.env,
      undefined,
      'job-level env exposes GH_TOKEN to every step',
    );
    assert.ok(assignStep.env.GH_TOKEN.includes('QWEN_CODE_BOT_TOKEN'));
    assert.equal(checkoutStep.with['persist-credentials'], false);
  });

  it('never runs a model or reads issue text', () => {
    const serialized = JSON.stringify(doc);
    assert.doesNotMatch(
      serialized,
      /OPENAI_API_KEY|qwen --|github\.event\.issue\.(title|body)/,
    );
  });

  it('fires on label changes without cancelling an in-flight assignment', () => {
    assert.deepEqual(doc.on.issues.types, ['labeled', 'reopened']);
    assert.equal(doc.concurrency['cancel-in-progress'], false);
  });
});
