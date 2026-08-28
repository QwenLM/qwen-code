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
  changedFiles,
  matchAreaByPath,
  matchedAreasByPath,
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
  headRefOid: 'head-1',
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

  it('routes a probe file under every mapped prefix back to its area', () => {
    // Fixed probe prefixes, deliberately independent of the policy: a typo'd
    // prefix in issue-owners.json must fail here instead of silently
    // rerouting that module's PRs to the generic fallback while the suite
    // stays green (the earlier tests only pinned core-skills and core-goals).
    // Probes derived from the policy itself would shift with the typo and
    // stay green, so the expected prefixes are spelled out.
    const probes = {
      core: ['packages/core/'],
      'core-skills': ['packages/core/src/skills/'],
      'core-memory': ['packages/core/src/memory/'],
      'core-goals': ['packages/core/src/goals/'],
      'core-telemetry': ['packages/core/src/telemetry/'],
      'core-extension': ['packages/core/src/extension/'],
      'core-agents': ['packages/core/src/agents/'],
      'core-config': ['packages/core/src/config/'],
      'core-runtime': [
        'packages/core/src/core/',
        'packages/core/src/services/',
        'packages/core/src/tools/',
        'packages/core/src/utils/',
      ],
    };
    const mapped = policy.areas.filter((area) => area.paths?.length);
    for (const area of mapped) {
      const prefixes = probes[area.name];
      assert.ok(prefixes, `area ${area.name} has no probe prefixes`);
      assert.deepEqual(
        area.paths,
        prefixes,
        `area ${area.name} changed its paths — update the probes`,
      );
      for (const prefix of prefixes) {
        assert.equal(
          matchedAreasByPath(policy, [{ path: `${prefix}routing-probe.ts` }])[0]
            ?.name,
          area.name,
          `probe under ${prefix} does not route to ${area.name}`,
        );
      }
    }
    // Stale probes for areas that lost their paths list must fail too.
    assert.deepEqual(
      new Set(Object.keys(probes)),
      new Set(mapped.map((area) => area.name)),
    );
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

  it('skips areas without a paths list instead of matching them', () => {
    // paths stays optional in loadPolicy, so a label-only area is valid
    // config; path routing must skip it rather than crash on the missing
    // list.
    const labelOnly = {
      name: 'label-only',
      labels: ['area: core'],
      owners: [policy.areas[0].owners[0]],
    };
    const synthetic = {
      requireLabels: [],
      skipLabels: [],
      areas: [labelOnly, ...policy.areas],
    };
    const area = matchAreaByPath(synthetic, [
      { path: 'packages/core/src/x.ts' },
    ]);
    assert.equal(area?.name, 'core');
    assert.equal(
      matchAreaByPath({ ...synthetic, areas: [labelOnly] }, [
        { path: 'packages/core/src/x.ts' },
      ]),
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
    // A deleted account exports as "author": null — skip with a reason,
    // never throw on the null dereference.
    assert.ok(skipPrReason({ ...corePr, author: null }));
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
    // When set, the second `pr view` (the pre-write re-fetch) sees this PR
    // state instead of prJson, so a test can simulate the PR changing while
    // the run is in flight.
    prLatestJson = '',
    files = 'packages/core/src/foo.ts',
    // Raw filename list; overrides `files` when a test needs names a
    // newline-joined string cannot carry (git allows newlines in paths).
    fileList,
    previousFiles = [],
    zeroLoadOwner = 'DennisYu07',
    // What every collaborator permission lookup answers; 'error' fails the
    // lookup outright instead of answering.
    permission = 'write',
    // When set, this one login's lookup answers denyPerm instead, so a test
    // can drop a single owner out of the eligible set.
    denyLogin = '',
    denyPerm = 'read',
    editExit = 0,
    editErr = '',
    expectExit = 0,
  } = options;
  const fileNames = fileList ?? files.split('\n').filter(Boolean);
  const dir = mkdtempSync(join(tmpdir(), 'assign-pr-owner-'));
  tempDirs.push(dir);
  const log = join(dir, 'gh.log');
  const gh = join(dir, 'gh');
  writeFileSync(
    gh,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$GH_STUB_LOG"
case "$*" in
  "pr view 77 "*)
    # The log line for this call is already appended, so the first view
    # counts 1 and the pre-write re-fetch counts 2.
    if [ -n "$GH_STUB_PR_LATEST" ] && [ "$(grep -c 'pr view' "$GH_STUB_LOG")" -gt 1 ]; then
      printf '%s' "$GH_STUB_PR_LATEST"
    else
      printf '%s' "$GH_STUB_PR"
    fi
    ;;
  *"pulls/77/files"*"previous_filename"*"@base64"*)
    printf '%s' "$GH_STUB_FILES_B64"
    if [ -n "$GH_STUB_PREVIOUS_FILES_B64" ]; then
      printf '\n%s' "$GH_STUB_PREVIOUS_FILES_B64"
    fi
    ;;
  *"pulls/77/files"*"@base64"*) printf '%s' "$GH_STUB_FILES_B64" ;;
  *"pulls/77/files"*) printf '%s' "$GH_STUB_FILES" ;;
  *"/collaborators/$GH_STUB_DENY_LOGIN/permission"*) printf '%s' "$GH_STUB_DENY_PERM" ;;
  *"/collaborators/"*"/permission"*)
    if [ "$GH_STUB_PERMISSION" = "error" ]; then
      printf '%s' 'permission lookup failed' >&2
      exit 1
    fi
    printf '%s' "$GH_STUB_PERMISSION"
    ;;
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
      GH_STUB_PR_LATEST: prLatestJson,
      // What the legacy text-rendering filter would print: one filename per
      // line, so an embedded newline forges extra entries.
      GH_STUB_FILES: fileNames.join('\n'),
      // What the fixed `| @base64` filter prints: one base64 token per
      // filename, so an embedded newline stays inside one entry.
      GH_STUB_FILES_B64: fileNames
        .map((name) => Buffer.from(name, 'utf8').toString('base64'))
        .join('\n'),
      GH_STUB_PREVIOUS_FILES_B64: previousFiles
        .map((name) => Buffer.from(name, 'utf8').toString('base64'))
        .join('\n'),
      GH_STUB_PERMISSION: permission,
      // The stub's deny branch pattern-expands this login; '__none__' can
      // never collide with a real collaborator lookup.
      GH_STUB_DENY_LOGIN: denyLogin || '__none__',
      GH_STUB_DENY_PERM: denyPerm,
      GH_STUB_EDIT_EXIT: String(editExit),
      GH_STUB_EDIT_ERR: editErr,
      GITHUB_REPOSITORY: 'QwenLM/qwen-code',
      GITHUB_STEP_SUMMARY: '',
      PR_NUMBER: '77',
      DRY_RUN: String(dryRun),
    },
  });
  assert.equal(result.status, expectExit, result.stderr);
  return {
    log: readFileSync(log, 'utf8'),
    stdout: result.stdout,
    stderr: result.stderr,
  };
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

  it('skips gracefully when the PR author account was deleted', () => {
    // `gh pr view --json author` exports `"author": null` for deleted
    // accounts. Every later trigger (synchronize/reopened/ready_for_review/
    // manual) must skip with a clean exit instead of throwing on the null
    // dereference, which would run the assignment check red on every push.
    const { log, stdout } = runAssign(false, {
      prJson: JSON.stringify({ ...corePr, author: null }),
    });
    assert.doesNotMatch(log, /pr edit/);
    assert.match(stdout, /skipped — PR author account was deleted/);
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

  it('re-checks coverage against the live PR immediately before the write', () => {
    // Up to ~30 sequential API calls sit between the opening snapshot and
    // the write; a mapped owner landing on the PR in that window must stop
    // the assignment instead of stacking a second one.
    const owner = policy.areas[0].owners[0];
    const { log, stdout } = runAssign(false, {
      prLatestJson: JSON.stringify({
        ...corePr,
        assignees: [{ login: owner }],
      }),
    });
    assert.doesNotMatch(log, /pr edit/);
    assert.match(stdout, /already on the PR/);
  });

  it('skips the write when the PR closes mid-run', () => {
    const { log, stdout } = runAssign(false, {
      prLatestJson: JSON.stringify({ ...corePr, state: 'MERGED' }),
    });
    assert.doesNotMatch(log, /pr edit/);
    assert.match(stdout, /skipped — PR is not open/);
  });

  it('skips the write when the PR head changes mid-run', () => {
    const { log, stdout } = runAssign(false, {
      prLatestJson: JSON.stringify({ ...corePr, headRefOid: 'head-2' }),
    });
    assert.equal((log.match(/headRefOid/g) ?? []).length, 2);
    assert.doesNotMatch(log, /pr edit/);
    assert.match(stdout, /skipped — PR head changed during routing/);
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

  it('drops an owner who lost push access and falls back to the coarser area', () => {
    const module = policy.areas.find((area) => area.name === 'core-skills');
    const { log, stdout } = runAssign(false, {
      denyLogin: module.owners[0],
      files: 'packages/core/src/skills/loader.ts',
    });
    assert.match(stdout, /falling back to core/);
    assert.doesNotMatch(
      log,
      new RegExp(`--add-assignee ${module.owners[0]}\\b`),
    );
    assert.match(log, /pr edit 77 .*--add-assignee DennisYu07/);
  });

  it('exits without assigning when no owner passes the push-access check', () => {
    // 'read' answers every lookup with a non-write permission; 'error' fails
    // the lookup outright (the canWrite catch branch). Both routes must land
    // on the same terminal skip with a clean exit — never a failed run, and
    // never a blind assignment past the collaborator check.
    for (const permission of ['read', 'error']) {
      const { log, stdout, stderr } = runAssign(false, { permission });
      assert.doesNotMatch(log, /pr edit/);
      assert.match(stdout, /no eligible owner for the matched areas/);
      if (permission === 'error') {
        assert.match(stderr, /Cannot verify push access/);
      }
    }
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

  it('re-throws a non-permission pr edit failure instead of swallowing it', () => {
    const { log } = runAssign(false, {
      editExit: 1,
      editErr: 'network error',
      expectExit: 1,
    });
    assert.match(log, /pr edit/);
  });

  it('skips gracefully when GitHub refuses agent-assignee edits for App tokens', () => {
    // A PR that already carries a coding-agent assignee can only change its
    // actor list through replaceActorsForAssignable, which GitHub refuses
    // for GitHub App installation tokens. That refusal must land on the
    // graceful skip — a rethrow here runs the assignment check red on the
    // contributor's own PR (@wenshao's F1).
    const { log, stdout } = runAssign(false, {
      editExit: 1,
      editErr:
        'GraphQL: Assigning agents is not supported with GitHub App installation tokens (HTTP 400)',
    });
    assert.doesNotMatch(stdout, /assigned @/);
    assert.match(
      stdout,
      /skipped — token cannot assign PRs with agent assignees/,
    );
    assert.match(log, /pr edit/);
  });
});

describe('assign-pr-owner: untrusted filename decoding', () => {
  it('includes both paths for renamed files', () => {
    const { log, stdout } = runAssign(false, {
      files: 'packages/cli/src/new.ts',
      previousFiles: ['packages/core/src/old.ts'],
    });
    assert.match(log, /previous_filename/);
    assert.match(log, /pr edit 77 .*--add-assignee DennisYu07/);
    assert.match(stdout, /Area: core/);
  });

  it('keeps a newline inside a changed filename from forging a second path', () => {
    // Changed filenames are attacker-controlled on fork PRs, and git accepts
    // newlines in path components. Decoding each filename structurally must
    // keep "x<LF>packages/core/poc" one entry; splitting the rendered text
    // on newlines would turn it into a phantom "packages/core/poc" that a
    // fork author could use to steer which area owner gets assigned.
    const forged = 'x\npackages/core/poc';
    const fileNames = [forged, 'packages/core/src/foo.ts'];

    // Decode boundary, probed directly through a stub that renders what the
    // real files endpoint would for each jq filter.
    const dir = mkdtempSync(join(tmpdir(), 'assign-pr-owner-'));
    tempDirs.push(dir);
    const ghPath = join(dir, 'gh');
    writeFileSync(
      ghPath,
      `#!/bin/sh
case "$*" in
  *"pulls/77/files"*"@base64"*) printf '%s' '${fileNames
    .map((name) => Buffer.from(name, 'utf8').toString('base64'))
    .join('\n')}' ;;
  *"pulls/77/files"*) printf '%s' '${fileNames.join('\n')}' ;;
  *) printf 'unexpected gh call: %s\\n' "$*" >&2; exit 1 ;;
esac
`,
    );
    chmodSync(ghPath, 0o755);
    const prevPath = process.env.PATH;
    process.env.PATH = `${dir}:${prevPath}`;
    let decoded;
    try {
      decoded = changedFiles('QwenLM/qwen-code', 77);
    } finally {
      process.env.PATH = prevPath;
    }
    // The forged name arrives as exactly one entry, newline intact.
    assert.deepEqual(decoded, [
      { path: forged },
      { path: 'packages/core/src/foo.ts' },
    ]);
    // On its own it matches no area prefix...
    assert.equal(matchAreaByPath(policy, [decoded[0]]), null);
    // ...while the legit core file still routes the PR to core.
    assert.equal(matchAreaByPath(policy, decoded)?.name, 'core');

    // End to end: a PR carrying only the forged name is skipped instead of
    // being routed to core through the phantom split entry...
    const alone = runAssign(false, { fileList: [forged] });
    assert.doesNotMatch(alone.log, /pr edit/);
    assert.match(alone.stdout, /no area path matched/);
    // ...and adding a legit core file routes to core for that file's sake.
    const mixed = runAssign(false, { fileList: fileNames });
    assert.match(mixed.log, /pr edit 77 .*--add-assignee DennisYu07/);
    assert.match(mixed.stdout, /Area: core/);
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

  it('keeps the privileged pull_request_target trigger and never cancels in flight', () => {
    // pull_request_target is the whole safety case: fork PRs get owners
    // while the checkout stays on the trusted base. Flipping it to
    // pull_request makes the token read-only on fork PRs, and the
    // permission-tolerance catch then records a skip — routing silently
    // disabled for every fork PR with green checks. Dropping
    // ready_for_review leaves drafts ownerless after they are marked
    // ready, and cancel-in-progress would kill an in-flight assignment
    // mid-write on a synchronize burst.
    assert.deepEqual(triggers.pull_request_target.types, [
      'opened',
      'synchronize',
      'reopened',
      'ready_for_review',
    ]);
    assert.equal(
      doc.concurrency.group,
      'assign-pr-owner-${{ github.event.pull_request.number || inputs.number }}',
    );
    assert.equal(doc.concurrency['cancel-in-progress'], false);
  });

  it('scopes the write permission to the job and the token to the step', () => {
    assert.equal(doc.permissions['pull-requests'], undefined);
    assert.equal(assignJob.permissions['pull-requests'], 'write');
    const runStep = assignJob.steps.find((step) => step.run);
    assert.ok(runStep.env.GH_TOKEN);
    assert.equal(doc.env?.GH_TOKEN, undefined);
    assert.equal(
      assignJob.env,
      undefined,
      'job-level env exposes GH_TOKEN to every step',
    );
    // Same pin as the issue script: a hardcoded or dropped DRY_RUN turns
    // event-triggered runs into permanent no-ops, and breaking the
    // inputs.number fallback breaks every manual dispatch.
    assert.equal(
      runStep.env.PR_NUMBER,
      '${{ github.event.pull_request.number || inputs.number }}',
    );
    assert.equal(runStep.env.DRY_RUN, "${{ inputs.dry_run || 'false' }}");
  });

  it('checks out the trusted base, credential-free and sparse', () => {
    const checkout = assignJob.steps.find((step) =>
      step.uses?.startsWith('actions/checkout@'),
    );
    assert.match(checkout.with.ref, /pull_request\.base\.sha/);
    assert.equal(checkout.with['persist-credentials'], false);
    assert.match(checkout.with['sparse-checkout'], /issue-owners\.json/);
    // The run step's guard skips when this entry is dropped, so pin the
    // membership — otherwise routing could be silently disabled forever.
    assert.match(
      checkout.with['sparse-checkout'],
      /^\.github\/scripts\/assign-pr-owner\.mjs$/m,
    );
    // The entry script statically imports assign-issue-owner.mjs, and the
    // bootstrap guard only checks for assign-pr-owner.mjs — dropping this
    // entry makes node fail on the missing module after the guard passed.
    assert.match(
      checkout.with['sparse-checkout'],
      /^\.github\/scripts\/assign-issue-owner\.mjs$/m,
    );
    // Nothing from the PR head can execute: the checkout never follows it.
    assert.doesNotMatch(checkout.with.ref, /head\.sha/);
  });

  it('bootstrap-skips on a base without the script, before running node', () => {
    const runStep = assignJob.steps.find((step) => step.run);
    // Pin the guard's shape and ordering: an inverted guard turns every run
    // into a silent no-op, a non-zero exit re-breaks the bootstrap PR's own
    // check, and a node call ahead of the guard fails on the base checkout.
    assert.match(
      runStep.run,
      /if \[ ! -f \.github\/scripts\/assign-pr-owner\.mjs \]; then[\s\S]*?exit 0[\s\S]*?fi[\s\S]*?node \.github\/scripts\/assign-pr-owner\.mjs\s*$/,
    );
  });

  it('defaults a manual dispatch to dry-run', () => {
    assert.equal(triggers.workflow_dispatch.inputs.dry_run.default, true);
  });
});
