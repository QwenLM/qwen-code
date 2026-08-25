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

  // Deliberately NOT asserted against CODEOWNERS: that file answers "who owns
  // this code path", which is a narrower question than "who may be assigned an
  // issue in this area". The repository has ~44 collaborators with push access
  // and only 4 CODEOWNERS path rules, so that check would reject legitimate
  // additions. Push access is verified against the live API at write time.
  it('rejects a duplicated owner that would skew load balancing', () => {
    const broken = JSON.parse(ownersRaw);
    broken.areas[0].owners = ['wenshao', 'WENSHAO'];
    assert.throws(() => loadPolicy(JSON.stringify(broken)), /duplicate owner/);
  });

  it('rejects two areas sharing a name', () => {
    const broken = JSON.parse(ownersRaw);
    broken.areas = [...broken.areas, structuredClone(broken.areas[0])];
    assert.throws(() => loadPolicy(JSON.stringify(broken)), /duplicate area/);
  });

  it('rejects a malformed login rather than passing it to gh', () => {
    // GitHub logins cannot start or end with a hyphen or contain consecutive
    // hyphens; a typo'd owner is only dropped at the runtime permission
    // check, so reject the whole config up front instead.
    for (const login of ['not a login', 'alice-', '-alice', 'a--b']) {
      const broken = JSON.parse(ownersRaw);
      broken.areas[0].owners = [login];
      assert.throws(() => loadPolicy(JSON.stringify(broken)), /invalid login/);
    }
  });

  it('rejects an empty label entry that could never match', () => {
    const requireBroken = JSON.parse(ownersRaw);
    requireBroken.requireLabels = [''];
    assert.throws(
      () => loadPolicy(JSON.stringify(requireBroken)),
      /non-empty strings/,
    );

    const skipBroken = JSON.parse(ownersRaw);
    skipBroken.skipLabels = ['welcome-pr', ''];
    assert.throws(
      () => loadPolicy(JSON.stringify(skipBroken)),
      /non-empty strings/,
    );

    const areaBroken = JSON.parse(ownersRaw);
    areaBroken.areas[0].labels = [''];
    assert.throws(() => loadPolicy(JSON.stringify(areaBroken)), /needs labels/);
  });

  it('rejects an area with no labels', () => {
    const broken = JSON.parse(ownersRaw);
    broken.areas[0].labels = [];
    assert.throws(() => loadPolicy(JSON.stringify(broken)), /needs labels/);
  });

  it('rejects a root that is not an object', () => {
    for (const raw of ['null', '[]', '"policy"']) {
      assert.throws(() => loadPolicy(raw), /not an object/);
    }
  });

  it('rejects non-array label lists', () => {
    for (const key of ['requireLabels', 'skipLabels']) {
      const broken = JSON.parse(ownersRaw);
      broken[key] = 'need-discussion';
      assert.throws(
        () => loadPolicy(JSON.stringify(broken)),
        /non-empty strings/,
      );
    }
  });

  it('rejects a missing, empty, or non-array areas list', () => {
    for (const areas of [undefined, [], 'core']) {
      const broken = JSON.parse(ownersRaw);
      broken.areas = areas;
      assert.throws(
        () => loadPolicy(JSON.stringify(broken)),
        /areas must be a non-empty array/,
      );
    }
  });

  it('rejects an unnamed area or an area with no owners', () => {
    const nameless = JSON.parse(ownersRaw);
    delete nameless.areas[0].name;
    assert.throws(() => loadPolicy(JSON.stringify(nameless)), /needs a name/);

    const ownerless = JSON.parse(ownersRaw);
    ownerless.areas[0].owners = [];
    assert.throws(() => loadPolicy(JSON.stringify(ownerless)), /needs owners/);
  });

  it('rejects a non-string owner entry', () => {
    const broken = JSON.parse(ownersRaw);
    broken.areas[0].owners = [42];
    assert.throws(() => loadPolicy(JSON.stringify(broken)), /invalid login/);
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

  it('leaves autofix-owned issues to autofix', () => {
    for (const label of ['autofix/approved', 'autofix/in-progress']) {
      assert.equal(
        skipReason(policy, {
          ...coreIssue,
          labels: [...coreIssue.labels, { name: label }],
        }),
        `carries ${label}`,
      );
    }
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
function runAssign(dryRun, secondIssueJson = '') {
  const dir = mkdtempSync(join(tmpdir(), 'assign-issue-owner-'));
  tempDirs.push(dir);
  const log = join(dir, 'gh.log');
  const gh = join(dir, 'gh');
  writeFileSync(
    gh,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_STUB_LOG"
case "$*" in
  "issue view 42 "*)
    count=$(cat "$GH_STUB_VIEW_COUNT" 2>/dev/null || echo 0)
    count=$((count + 1))
    printf '%s' "$count" > "$GH_STUB_VIEW_COUNT"
    if [ "$count" = 2 ] && [ -n "$GH_STUB_SECOND_ISSUE" ]; then
      printf '%s' "$GH_STUB_SECOND_ISSUE"
    else
      printf '%s' '{"state":"OPEN","labels":[{"name":"category/core"},{"name":"need-discussion"}],"assignees":[]}'
    fi
    ;;
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
      GH_STUB_VIEW_COUNT: join(dir, 'view-count'),
      GH_STUB_SECOND_ISSUE: secondIssueJson,
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

  it('re-checks issue state immediately before assigning', () => {
    const { log, stdout } = runAssign(
      false,
      '{"state":"OPEN","labels":[{"name":"category/core"},{"name":"need-discussion"}],"assignees":[{"login":"someone"}]}',
    );
    assert.doesNotMatch(log, /issue edit/);
    assert.match(stdout, /skipped — issue already has an assignee/);
  });

  it('re-checks area labels immediately before assigning', () => {
    const { log, stdout } = runAssign(
      false,
      '{"state":"OPEN","labels":[{"name":"category/ui"},{"name":"need-discussion"}],"assignees":[]}',
    );
    assert.doesNotMatch(log, /issue edit/);
    assert.match(stdout, /skipped — issue labels changed/);
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
    assert.equal(
      String(assignJob.if),
      "${{ github.repository == 'QwenLM/qwen-code' }}",
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
    assert.equal(assignStep.env.GH_TOKEN, '${{ github.token }}');
    assert.equal(assignStep.env.DRY_RUN, "${{ inputs.dry_run || 'false' }}");
    assert.equal(
      assignStep.env.ISSUE_NUMBER,
      '${{ github.event.issue.number || inputs.number }}',
    );
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
    assert.deepEqual(doc.on.issues.types, ['labeled', 'unlabeled']);
    assert.equal(
      doc.concurrency.group,
      'assign-issue-owner-${{ github.event.issue.number || inputs.number }}',
    );
    assert.equal(doc.concurrency['cancel-in-progress'], false);
  });
});
