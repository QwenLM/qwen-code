// Runner-routing regression guards for ci.yml, serve-ab.yml, e2e.yml, and
// the qwen-autofix.yml scan lane.
//
// classify_pr carries the routing logic TWICE — the `runs-on` expression
// (which selects the classify job's own runner) and the `pick_runner` shell
// step (which publishes `ubuntu_runner` for every downstream Linux job). If
// they drift, classify and the Test job land on different pools. These tests
// evaluate BOTH against the same event matrix — including the negative
// associations that must stay hosted — and assert they agree.
//
// test_windows carries a deliberately different policy. A pull_request run
// executes the workflow YAML from the PR's own merge commit, so any trust
// clause a PR can read it can also rewrite. The matrix evaluates the real
// expression text and asserts the only enforceable shape: every pull request
// stays hosted, and only the merge queue, schedule and dispatch reach the
// persistent pool.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const workflowsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'workflows',
);
const ciDoc = parse(readFileSync(join(workflowsDir, 'ci.yml'), 'utf8'));
const serveAbDoc = parse(
  readFileSync(join(workflowsDir, 'serve-ab.yml'), 'utf8'),
);

const TRUSTED = ['OWNER', 'MEMBER', 'COLLABORATOR'];
const ECS = '["self-hosted", "linux", "x64", "ecs-qwen"]';
const HOSTED = '["ubuntu-latest"]';
const WIN_ECS = ['self-hosted', 'Windows', 'X64', 'ecs-win'];
const WIN_HOSTED = ['windows-2022'];

const classifyRunsOn = String(ciDoc.jobs.classify_pr['runs-on']);
const windowsRunsOn = String(ciDoc.jobs.test_windows['runs-on']);
const pickRunner = ciDoc.jobs.classify_pr.steps.find(
  (s) => s.id === 'pick_runner',
);

// GitHub expression semantics for the classify runs-on, restricted to the
// routing-relevant inputs: contains(list, '') is false, a missing
// pull_request (merge_group / dispatch) yields '' for both head.repo and
// author_association.
function simulateRunsOn({ ecsDisabled, sameRepo, assoc, mergeGroup }) {
  const trusted = TRUSTED.includes(assoc);
  const ecs = !ecsDisabled && (sameRepo || trusted || mergeGroup);
  return ecs ? ECS : HOSTED;
}

// Evaluates a real `runs-on` expression text with the routing inputs
// substituted, leaving only the &&/||/parenthesis skeleton — which matches
// GitHub's operator semantics closely enough for this fixed shape: both
// return the winning operand, and the winning operand is a fromJSON runner
// label, unwrapped here to the array it names. Any term the substitutions
// do not recognise fails loud, so an edited expression is re-read here
// instead of silently outgrowing the matrix.
function evalRunsOn(expression, { ecsDisabled, eventName, sameRepo, assoc }) {
  const substitutions = [
    [/vars\.MAINTAINER_ECS_RUNNER_DISABLED != 'true'/, String(!ecsDisabled)],
    [
      /github\.event_name == 'merge_group'/,
      String(eventName === 'merge_group'),
    ],
    // Longest term first as a convention; both patterns are quote-anchored
    // (the closing quote is part of each regex), so neither can match
    // inside the other and the substitution order is behaviorally inert.
    [
      /github\.event_name != 'pull_request_review'/,
      String(eventName !== 'pull_request_review'),
    ],
    [
      /github\.event_name != 'pull_request'/,
      String(eventName !== 'pull_request'),
    ],
    [/github\.repository == 'QwenLM\/qwen-code'/, 'true'],
    [
      /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
      String(sameRepo),
    ],
    [
      /contains\(fromJSON\('\["OWNER","MEMBER","COLLABORATOR"\]'\), github\.event\.pull_request\.author_association\)/,
      String(TRUSTED.includes(assoc)),
    ],
    [/github\.repository == 'QwenLM\/qwen-code'/, 'true'],
  ];
  let expr = expression.replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '');
  for (const [term, value] of substitutions) {
    expr = expr.replace(term, value);
  }
  expr = expr.replace(/fromJSON\('(\[[^\]]*\])'\)/g, '$1');
  assert.doesNotMatch(
    expr,
    /github\.|vars\.|contains\(|fromJSON\(/,
    `routing expression carries a term the matrix does not model: ${expr}`,
  );
  const selected = new Function(`return (${expr});`)();
  assert.ok(Array.isArray(selected), `no runner label selected: ${expr}`);
  return selected;
}

// Executes the real pick_runner shell with the same inputs and returns the
// selected runner exactly as CI would publish it.
function runPickRunner({ ecsDisabled, sameRepo, assoc, eventName, dispatch }) {
  const tmp = mkdtempSync(join(tmpdir(), 'pick-runner-'));
  const outputFile = join(tmp, 'github_output');
  const result = spawnSync('bash', ['-c', pickRunner.run], {
    env: {
      SAME_REPO: sameRepo ? 'true' : 'false',
      AUTHOR_ASSOCIATION: assoc,
      ECS_DISABLED: ecsDisabled ? 'true' : '',
      EVENT_NAME: eventName,
      DISPATCH_LINUX_RUNNER: dispatch ?? '',
      GITHUB_OUTPUT: outputFile,
    },
    encoding: 'utf8',
  });
  rmSync(tmp, { recursive: true, force: true });
  assert.equal(result.status, 0, `pick_runner failed: ${result.stderr}`);
  const line = result.stdout
    .split('\n')
    .find((l) => l.startsWith('Selected Linux runner: '));
  assert.ok(line, `no selection in pick_runner output: ${result.stdout}`);
  return line.slice('Selected Linux runner: '.length);
}

const ASSOCIATIONS = [
  ...TRUSTED,
  'CONTRIBUTOR',
  'FIRST_TIME_CONTRIBUTOR',
  'FIRST_TIMER',
  'NONE',
  '',
];

describe('ci.yml classify_pr runner routing', () => {
  it('the expression and the shell step agree on every association', () => {
    for (const sameRepo of [true, false]) {
      for (const assoc of ASSOCIATIONS) {
        const expected = simulateRunsOn({
          ecsDisabled: false,
          sameRepo,
          assoc,
          mergeGroup: false,
        });
        const actual = runPickRunner({
          ecsDisabled: false,
          sameRepo,
          assoc,
          eventName: 'pull_request',
        });
        assert.equal(
          actual,
          expected,
          `drift for sameRepo=${sameRepo} assoc='${assoc}'`,
        );
      }
    }
  });

  it('only write-access associations leave the hosted pool', () => {
    for (const assoc of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE', '']) {
      assert.equal(
        runPickRunner({
          ecsDisabled: false,
          sameRepo: false,
          assoc,
          eventName: 'pull_request',
        }),
        HOSTED,
        `assoc '${assoc}' must stay hosted`,
      );
    }
    for (const assoc of TRUSTED) {
      assert.equal(
        runPickRunner({
          ecsDisabled: false,
          sameRepo: false,
          assoc,
          eventName: 'pull_request',
        }),
        ECS,
        `assoc '${assoc}' must route to ECS`,
      );
    }
  });

  it('merge queue and explicit dispatch still reach ECS; the kill-switch wins', () => {
    assert.equal(
      runPickRunner({
        ecsDisabled: false,
        sameRepo: false,
        assoc: '',
        eventName: 'merge_group',
      }),
      ECS,
    );
    assert.equal(
      runPickRunner({
        ecsDisabled: false,
        sameRepo: false,
        assoc: '',
        eventName: 'workflow_dispatch',
        dispatch: 'self-hosted',
      }),
      ECS,
    );
    assert.equal(
      runPickRunner({
        ecsDisabled: true,
        sameRepo: true,
        assoc: 'OWNER',
        eventName: 'pull_request',
      }),
      HOSTED,
      'kill-switch must revert even trusted runs to hosted',
    );
  });

  it('a push to main reaches ECS, and the kill-switch still wins', () => {
    // The post-merge fast signal (Classify PR + Test on `main`) runs the same
    // ten-plus-minute Test job a pull request does, in the most trusted
    // context there is: the code is already merged and the YAML is main's
    // own. Route it to the pool instead of spending a scarce hosted Linux
    // runner on every merge. A push carries no author association, so this
    // arm is necessarily event-based.
    assert.equal(
      runPickRunner({
        ecsDisabled: false,
        sameRepo: false,
        assoc: '',
        eventName: 'push',
      }),
      ECS,
    );
    assert.equal(
      runPickRunner({
        ecsDisabled: true,
        sameRepo: false,
        assoc: '',
        eventName: 'push',
      }),
      HOSTED,
      'kill-switch must revert post-merge runs to hosted',
    );
  });

  it('keeps the push arm out of the classify runs-on expression', () => {
    // classify_pr routes twice, and on a push the two halves deliberately
    // disagree: the shell step sends downstream Linux jobs to ECS while this
    // expression leaves classify_pr itself hosted. Pin the asymmetry so a
    // future "drift fix" has to read why first — this expression is the
    // canonical association-routing text that sdk-java.yml and serve-ab.yml
    // mirror, a push has no association to route on, and classify_pr is a
    // seconds-long job whose pool costs nothing either way. The drift guard
    // above evaluates both halves on pull_request, where they must agree.
    assert.doesNotMatch(classifyRunsOn, /github\.event_name == 'push'/);
  });

  it('the runs-on expression keeps the trusted clause and kill-switch', () => {
    // Structural pins for the expression half of the drift guard — the
    // simulation above re-implements it, so pin the real text too.
    assert.match(
      classifyRunsOn,
      /contains\(fromJSON\('\["OWNER","MEMBER","COLLABORATOR"\]'\), github\.event\.pull_request\.author_association\)/,
    );
    assert.match(
      classifyRunsOn,
      /vars\.MAINTAINER_ECS_RUNNER_DISABLED != 'true'/,
    );
    assert.match(classifyRunsOn, /github\.event_name == 'merge_group'/);
  });
});

describe('ci.yml test_windows runner routing', () => {
  it('keeps every pull request hosted, whoever opens it', () => {
    // A pull_request run executes the workflow YAML from the PR's own merge
    // commit: any PR this lane admits could rewrite `runs-on` in the same
    // diff (editing this file is what classifies it platform-sensitive), so
    // no trust clause evaluated on that event is enforceable. The enforceable
    // shape is unconditional — pull requests never reach the persistent pool.
    for (const sameRepo of [true, false]) {
      for (const assoc of ASSOCIATIONS) {
        assert.deepEqual(
          evalRunsOn(windowsRunsOn, {
            ecsDisabled: false,
            eventName: 'pull_request',
            sameRepo,
            assoc,
          }),
          WIN_HOSTED,
          `pull_request sameRepo=${sameRepo} assoc='${assoc}' must stay hosted`,
        );
      }
    }
  });

  it('keeps the pool for every non-pull-request trigger', () => {
    // The denial form exists so the queue, the nightly and dispatch runs stay
    // on the pool without a pull_request context to read; an && / || flip in
    // the gate must not exile them to hosted runners.
    for (const eventName of ['merge_group', 'schedule', 'workflow_dispatch']) {
      assert.deepEqual(
        evalRunsOn(windowsRunsOn, {
          ecsDisabled: false,
          eventName,
          sameRepo: false,
          assoc: '',
        }),
        WIN_ECS,
        `${eventName} must keep the pool`,
      );
    }
  });

  it('the kill-switch wins on every event', () => {
    for (const eventName of [
      'pull_request',
      'merge_group',
      'schedule',
      'workflow_dispatch',
    ]) {
      assert.deepEqual(
        evalRunsOn(windowsRunsOn, {
          ecsDisabled: true,
          eventName,
          sameRepo: true,
          assoc: 'OWNER',
        }),
        WIN_HOSTED,
        `kill-switch must win on ${eventName}`,
      );
    }
  });
});

describe('serve-ab.yml runner routing', () => {
  const runsOn = String(serveAbDoc.jobs.ab['runs-on']);

  it('admits same-repo and write-access fork PRs, guarded by the kill-switch', () => {
    assert.match(runsOn, /head\.repo\.full_name == github\.repository/);
    assert.match(
      runsOn,
      /contains\(fromJSON\('\["OWNER","MEMBER","COLLABORATOR"\]'\), github\.event\.pull_request\.author_association\)/,
    );
    assert.match(runsOn, /vars\.MAINTAINER_ECS_RUNNER_DISABLED != 'true'/);
    assert.match(runsOn, /ecs-qwen/);
    assert.match(runsOn, /ubuntu-latest/);
  });

  it('wipes the reused workspace except the shared root .git before checking out PR code', () => {
    const steps = serveAbDoc.jobs.ab.steps;
    const wipeIndex = steps.findIndex(
      (s) =>
        s.name ===
        'Wipe stale workspace except the shared .git before checkout',
    );
    assert.ok(
      wipeIndex !== -1,
      'self-hosted reuse must not bleed one PR into the next',
    );
    const wipe = steps[wipeIndex];
    assert.equal(wipe.if, "${{ runner.environment == 'self-hosted' }}");
    // The script text alone does not decide whether the wipe runs: the
    // shell wrapper, continue-on-error (step and job level), and env
    // overrides (BASH_ENV, PATH, GITHUB_WORKSPACE) — at step, job, and
    // workflow level — all control whether the pinned command executes
    // and whether its failure fails the job.
    const shell =
      wipe.shell ??
      serveAbDoc.jobs.ab.defaults?.run?.shell ??
      serveAbDoc.defaults?.run?.shell;
    assert.ok(
      shell === undefined || shell === 'bash',
      'the wipe must run under the default bash wrapper',
    );
    assert.ok(
      !('continue-on-error' in wipe),
      'a failed wipe must fail the job, not bleed into the next PR',
    );
    assert.ok(
      !('continue-on-error' in serveAbDoc.jobs.ab),
      'a job-level continue-on-error would mask a failed wipe',
    );
    for (const envMap of [wipe.env, serveAbDoc.jobs.ab.env, serveAbDoc.env]) {
      assert.ok(
        !envMap ||
          (envMap.BASH_ENV === undefined &&
            envMap.PATH === undefined &&
            envMap.GITHUB_WORKSPACE === undefined),
        'BASH_ENV, PATH, or GITHUB_WORKSPACE can shadow the pinned wipe command',
      );
    }
    // The sudo-less wipe only works because ownership-restore ran first,
    // and it must precede the checkouts or it deletes the freshly
    // checked-out code instead of stale leftovers.
    const stepIndex = (name) => steps.findIndex((s) => s.name === name);
    const ownershipIndex = stepIndex('Restore workspace ownership');
    assert.ok(
      ownershipIndex !== -1,
      'the wipe depends on the ownership-restore step existing',
    );
    assert.match(
      steps[ownershipIndex].run,
      /chown -R .* "\$GITHUB_WORKSPACE"/,
      'ownership-restore must actually chown the workspace',
    );
    assert.ok(
      ownershipIndex < wipeIndex,
      'the wipe depends on ownership-restore running first',
    );
    const checkouts = steps.filter((s) =>
      String(s.uses || '').startsWith('actions/checkout'),
    );
    for (const checkout of checkouts) {
      assert.ok(
        steps.indexOf(checkout) > wipeIndex,
        'the wipe must run before every checkout it protects',
      );
    }
    assert.ok(checkouts.length >= 2, 'expected at least two checkouts');
    // Wiping the shared root .git forces the next job on this runner to
    // re-fetch the full history from github.com — on the ECS pool's slow
    // link that is the "hung runner" pathology. The checkout-heal path
    // guard (#9220, #9265) ahead of it is pinned and exec-verified by
    // scripts/tests/serve-ab-workflow.test.js; here pin that the guard is
    // present and hands off to the kept-.git tail, line by line, so any
    // change forces a deliberate test update.
    assert.match(
      wipe.run,
      /refusing to wipe suspicious workspace path/,
      'the wipe must keep the checkout-heal path guard',
    );
    const executed = wipe.run
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));
    assert.equal(executed[0], 'set -uo pipefail');
    const tail = executed.slice(-5);
    assert.equal(
      tail[0],
      'find "$WS" -mindepth 1 -maxdepth 1 ! \\( -name \'.git\' -type d \\) -exec rm -rf {} +',
      'the wipe must keep only a REAL .git directory — a symlink or gitfile named .git can point outside the workspace — and only the guarded $WS may reach the rm',
    );
    assert.equal(
      tail[1],
      'rm -rf "$WS/.git/hooks" "$WS/.git/info/attributes"',
      'the kept .git must lose its hooks and info/attributes exec vectors',
    );
    assert.equal(
      tail[2],
      'rm -f "$(git --git-dir="$WS/.git" rev-parse --git-path config.worktree 2>/dev/null || echo /nonexistent)" 2>/dev/null || true',
      "extensions.worktreeConfig activates .git/config.worktree, a second local file that git config --local neither lists nor unsets — delete it like qwen-triage.yml's hardened config-sanitize",
    );
    assert.equal(
      tail[3],
      'git --git-dir="$WS/.git" config --local --unset-all extensions.worktreeConfig 2>/dev/null || true',
      'drop the extension that re-activates the split config file',
    );
    assert.equal(
      tail[4],
      '{ git --git-dir="$WS/.git" config --local --name-only --list 2>/dev/null || true; } | { grep -ivE \'^(core\\.(repositoryformatversion|bare|filemode|symlinks|ignorecase|precomposeunicode|logallrefupdates|worktree|hidedotfiles|protecthfs|protectntfs)|remote\\.|branch\\.|extensions\\.|gc\\.|pack\\.|fetch\\.|index\\.|safe\\.|submodule\\.[^.]+\\.(url|active|branch))\' || true; } | while IFS= read -r key; do git --git-dir="$WS/.git" config --local --unset-all "$key" 2>/dev/null || true; done',
      "the kept .git config must be scrubbed to the qwen-triage.yml config-sanitize allowlist, anchored to $WS/.git so a healed symlinked root never scrubs the link's target",
    );
  });
});

describe('e2e.yml e2e-test-linux runner routing', () => {
  // Every trigger is a trusted context (push to in-repo branches, schedule,
  // dispatch — no pull_request), so the lane routes to the persistent pool
  // whenever routing is enabled, with the kill-switch as the only fallback.
  const e2eDoc = parse(readFileSync(join(workflowsDir, 'e2e.yml'), 'utf8'));
  // evalRunsOn unwraps the winning fromJSON label to the array it names.
  const ECS_LABELS = ['self-hosted', 'linux', 'x64', 'ecs-qwen'];
  const HOSTED_LABELS = ['ubuntu-latest'];
  const job = e2eDoc.jobs['e2e-test-linux'];
  const runsOn = String(job['runs-on']);

  it('pins the repository guard clause the matrix substitutes away', () => {
    // evalRunsOn substitutes the repo clause with a constant; deleting it
    // from the workflow would leave every evaluation green while fork runs
    // queue on a label no fork registers. Pin the real text.
    assert.match(runsOn, /github\.repository == 'QwenLM\/qwen-code'/);
  });

  it('reaches the persistent pool on every trusted trigger', () => {
    for (const eventName of ['push', 'schedule', 'workflow_dispatch']) {
      assert.deepEqual(
        evalRunsOn(runsOn, {
          ecsDisabled: false,
          eventName,
          sameRepo: false,
          assoc: '',
        }),
        ECS_LABELS,
        `e2e-test-linux must run from the pool on ${eventName}`,
      );
    }
  });

  it('obeys the kill-switch', () => {
    assert.deepEqual(
      evalRunsOn(runsOn, {
        ecsDisabled: true,
        eventName: 'push',
        sameRepo: true,
        assoc: 'OWNER',
      }),
      HOSTED_LABELS,
      'kill-switch must force the lane back to hosted',
    );
  });

  it('keeps the workflow free of pull_request triggers', () => {
    // The simple repo+kill-switch expression above is only safe because no
    // lane of this workflow ever runs PR-authored workflow code. Adding a
    // pull_request trigger must force a deliberate routing rework.
    // `on:` is equally valid as a map, a sequence, or a scalar; normalize
    // before enumerating, or a non-map form enumerates indices, not names.
    const onMap = e2eDoc.on ?? e2eDoc[true] ?? {};
    const triggers = Array.isArray(onMap)
      ? onMap.map(String)
      : typeof onMap === 'string'
        ? [onMap]
        : Object.keys(onMap);
    assert.ok(triggers.length > 0, 'could not read the trigger map');
    for (const trigger of triggers) {
      assert.ok(
        !trigger.startsWith('pull_request'),
        `e2e.yml gained a ${trigger} trigger; the pool routing needs the fork-trust clause before this can land`,
      );
    }
  });

  it('carries the pool hygiene and capability steps in order', () => {
    const names = job.steps.map((s) => s.name);
    const preflight = names.indexOf('Check container runtime');
    const heal = names.indexOf('Restore workspace ownership');
    const checkout = job.steps.findIndex((s) =>
      String(s.uses || '').startsWith('actions/checkout'),
    );
    const prune = names.indexOf('Prune dangling docker images');
    // GitHub's default is 360 minutes; a wedged shard would hold a pool
    // runner for all of it. Pin the ci.yml pool precedent.
    assert.equal(job['timeout-minutes'], 60);
    // Fail-fast daemon probe (#9556) before any expensive step, only on the
    // docker leg.
    assert.ok(preflight !== -1, 'the docker preflight must exist');
    assert.match(job.steps[preflight].if, /sandbox:docker/);
    assert.match(job.steps[preflight].run, /docker info/);
    assert.match(job.steps[preflight].run, /exit 1/);
    assert.ok(
      preflight < names.indexOf('Install dependencies'),
      'the docker preflight must fail fast, before any expensive step',
    );
    assert.ok(
      !('continue-on-error' in job.steps[preflight]) &&
        !('continue-on-error' in job),
      'a failed docker probe must fail the job, not downgrade to a warning',
    );
    // Ownership heal before checkout, self-hosted only.
    assert.ok(heal !== -1, 'the ownership heal must exist');
    assert.equal(
      job.steps[heal].if,
      "${{ runner.environment == 'self-hosted' }}",
    );
    assert.match(job.steps[heal].run, /chown -R .* "\$GITHUB_WORKSPACE"/);
    assert.match(job.steps[heal].run, /chmod -R u\+rwX/);
    assert.ok(heal < checkout, 'the heal must precede the checkout');
    // Cleanup at the end: always(), docker leg, pool only. Tagged cleanup is
    // restricted to old workflow-owned images; the general cleanup remains
    // dangling-only so it cannot remove images from unrelated jobs.
    assert.ok(prune !== -1, 'the dangling prune must exist');
    assert.match(job.steps[prune].if, /always\(\)/);
    assert.match(job.steps[prune].if, /sandbox:docker/);
    assert.match(job.steps[prune].if, /runner\.environment == 'self-hosted'/);
    assert.match(
      job.steps[prune].run,
      /docker image prune --all --force --filter 'label=org\.qwen-code\.ci\.sandbox=true' --filter 'until=24h'/,
    );
    assert.match(job.steps[prune].run, /docker image prune --force/);
    assert.match(job.steps[prune].run, /until=24h/);
    // A failing prune must stay diagnosable: surface a warning instead of a
    // silent `|| true`, and keep the daemon's error out of /dev/null.
    assert.match(job.steps[prune].run, /\|\| echo "::warning::/);
    assert.doesNotMatch(job.steps[prune].run, /\/dev\/null/);
    assert.ok(
      prune === job.steps.length - 1,
      'the prune must be the final step so nothing dirties the pool after it',
    );
  });

  it('fails a dead-egress host fast and wipes the workspace for the next job', () => {
    // The shape this PR picks, per the cited runs: a host whose egress
    // to github.com is dead (runs 34088422718 and 34098892239 — one host
    // each while peer hosts checked out fine) recovered ONLY by
    // re-dispatch to another host, and a job's runner is fixed at
    // pickup, so no in-job retry can escape that class. The earlier
    // tolerated-primary + same-host retry pair paid three more ~135s
    // connect timeouts on the dead host (~16 of the job's 60 minutes,
    // eating the 2100s shard-retry reserve run-e2e-tests.sh gates on)
    // and still failed. What a retry COULD have healed — a corrupt
    // object in the reused workspace's .git (run 33851931669, #11016) —
    // the reset heals for the NEXT job on this runner instead: the
    // failed checkout fails the job fast at ~8 minutes, and the guarded
    // wipe leaves a clean workspace for the next occupant.
    const checkouts = job.steps.filter((s) =>
      String(s.uses || '').startsWith('actions/checkout'),
    );
    assert.equal(
      checkouts.length,
      1,
      'a same-host retry cannot escape dead egress — exactly one attempt',
    );
    const [primary] = checkouts;
    assert.equal(
      primary.id,
      'checkout',
      'the reset gate reads steps.checkout.outcome',
    );
    assert.ok(
      !('continue-on-error' in primary),
      'a failed checkout must fail the job fast, not linger on a dead host',
    );
    assert.equal(
      primary.uses,
      'actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10', // v6.0.3
    );
    assert.ok(
      !('with' in primary),
      'no checkout inputs — an unpinned one would change the fetch unreviewed',
    );
    assert.ok(
      !job.steps.some((s) => String(s.name).startsWith('Checkout (')),
      'no same-host retry step',
    );
    const names = job.steps.map((s) => s.name);
    const reset = names.indexOf('Reset workspace after failed checkout');
    assert.ok(reset !== -1, 'the workspace reset must exist');
    const step = job.steps[reset];
    assert.equal(
      step.if,
      "${{ runner.environment == 'self-hosted' && failure() && steps.checkout.outcome == 'failure' }}",
      'pool-only (a hosted workspace dies with its VM), only once the job is already failing, and only on a CHECKOUT failure — after a test failure the workspace is not the suspect',
    );
    // The reset aims a root-capable recursive delete at the shared pool
    // workspace, so it carries the pool-wipe guard set: the `:?` aborts
    // and the symlinked-component refusal from qwen-code-pr-review.yml's
    // reset step, plus the suspicious-path denylist and the
    // $RUNNER_WORKSPACE allowlist from serve-ab.yml / qwen-triage.yml /
    // release.yml. Unlike qwen-code-pr-review.yml — which refuses a
    // symlinked workspace leaf and so wedges the runner on it (#9480) —
    // this step heals the leaf first, the way serve-ab.yml and
    // release.yml do. A refusal must stay a hard job failure, never
    // degrade to a warning. The guards themselves are exec-witnessed
    // below; only what no exec case can reach stays text-pinned here.
    assert.ok(
      !('continue-on-error' in step),
      'a guard refusal must fail the job, not downgrade to a warning',
    );
    // The exec harness below reproduces `bash -e`, so the step must run
    // under the default bash wrapper. The resolution pins every level
    // at once: a `shell:` or `defaults.run.shell:` override — step, job,
    // or workflow — either resolves to a non-bash value and fails this
    // assertion, or names bash and stays the lane the exec cases
    // witness.
    const shell =
      step.shell ?? job.defaults?.run?.shell ?? e2eDoc.defaults?.run?.shell;
    assert.ok(
      shell === undefined || shell === 'bash',
      'the reset must run under the default bash wrapper the exec harness reproduces',
    );
    // The exec cases build the script's environment themselves, so they
    // cannot see an env override shadowing the pinned commands (PATH,
    // BASH_ENV) or moving the containment boundary (GITHUB_WORKSPACE,
    // RUNNER_WORKSPACE) — at step, job, or workflow level. The sibling
    // wipe in serve-ab.yml carries the same pin.
    for (const envMap of [step.env, job.env, e2eDoc.env]) {
      assert.ok(
        !envMap ||
          (envMap.BASH_ENV === undefined &&
            envMap.PATH === undefined &&
            envMap.GITHUB_WORKSPACE === undefined &&
            envMap.RUNNER_WORKSPACE === undefined),
        'BASH_ENV, PATH, GITHUB_WORKSPACE, or RUNNER_WORKSPACE can shadow the pinned reset guards',
      );
    }
    // Contents-only, like the siblings: the runner owns the directory
    // node, so the wipe empties it in place and never removes the node
    // itself; the heal branch recreates the leaf only when it was a
    // symlink or a non-directory, never a healthy node.
    assert.doesNotMatch(
      step.run,
      /rm -rf -- "\$(GITHUB_WORKSPACE|WS)"/,
      'stands in for the exec-witnessed contract that the wipe keeps the workspace node',
    );
    assert.match(
      step.run,
      /if \[ -L "\$WS" \] \|\| \[ ! -d "\$WS" \]/,
      'a symlinked or non-directory leaf must be healed, not refused (#9480)',
    );
    assert.doesNotMatch(
      step.run,
      /mkdir -p/,
      'only the heal branch may recreate the leaf, never a healthy node',
    );
    // No retry follows the wipe, so the warnings must say who inherits
    // its outcome — a message still promising a retry describes a
    // construct that is gone.
    assert.match(
      step.run,
      /wiping the workspace so the next job on this runner starts clean/,
    );
    assert.doesNotMatch(
      step.run,
      /retrying once|checkout retry proceeds|retry runs against/,
      'no retry follows the wipe — the warnings must not promise one',
    );
    assert.ok(
      job.steps.indexOf(primary) < reset,
      'the reset reads the checkout outcome, so it must follow the checkout',
    );
  });

  // Executes the REAL reset script under GitHub's default Linux step
  // shell (`bash -e`) plus the pipefail the script sets for itself: the
  // implicit errexit is what would kill a heal step ending on a nonzero
  // status in production, so the exec tests reproduce it instead of
  // asserting the script's shape. The shell premise is pinned by the
  // resolution in the test above: a `shell:` or `defaults.run.shell:`
  // override at any level either fails its assertion or names bash, the
  // lane these cases reproduce.
  const resetStep = job.steps.find(
    (s) => s.name === 'Reset workspace after failed checkout',
  );
  const runReset = (env) =>
    spawnSync('bash', ['-e', '-o', 'pipefail', '-c', resetStep.run], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    });
  const makePool = () => {
    // realpathSync: /tmp resolves through a symlink on some lanes (macOS
    // -> /private/tmp), and the guard refuses any workspace whose path
    // does not resolve to itself. GITHUB_WORKSPACE must sit inside
    // RUNNER_WORKSPACE or the allowlist refuses the wipe.
    const rws = realpathSync(
      mkdtempSync(join(tmpdir(), 'e2e-checkout-reset-')),
    );
    const ws = join(rws, 'qwen-code');
    mkdirSync(ws);
    return { rws, ws };
  };

  it('executes the reset: heals in place and refuses bad paths', () => {
    // Green path: a warm workspace (hidden .git included) must come back
    // empty with the directory node itself kept, and the heal must name
    // the machine — the only durable signal a silently degrading pool
    // leaves. A clean wipe must not cry survivors.
    {
      const { rws, ws } = makePool();
      try {
        mkdirSync(join(ws, '.git'));
        writeFileSync(join(ws, '.git', 'HEAD'), 'x');
        writeFileSync(join(ws, 'leftover'), 'x');
        const r = runReset({ GITHUB_WORKSPACE: ws, RUNNER_WORKSPACE: rws });
        assert.equal(r.status, 0, r.stderr);
        assert.ok(existsSync(ws), 'the wipe must keep the directory node');
        assert.deepEqual(readdirSync(ws), []);
        assert.match(r.stdout, /::warning::checkout failed on /);
        assert.match(
          r.stdout,
          /next job on this runner starts clean/,
          'no retry follows — the warning must say who inherits the wipe',
        );
        assert.doesNotMatch(r.stdout, /workspace wipe left survivors/);
      } finally {
        rmSync(rws, { recursive: true, force: true });
      }
    }
    // Heal: a previous job replaced the workspace leaf with a symlink —
    // here pointing OUTSIDE the runner workspace while its parent stays
    // inside. Refusing the leaf removes nothing and wedges every later
    // job on this runner (#9480), and judging the canonicalized PARENT
    // is what lets the heal proceed: resolving the leaf instead would
    // follow the link and refuse the very repair that must succeed. The
    // step unlinks and recreates the leaf; the foreign target keeps its
    // content because rm -f never follows the link.
    {
      const { rws, ws } = makePool();
      const outside = realpathSync(
        mkdtempSync(join(tmpdir(), 'e2e-checkout-outside-')),
      );
      try {
        rmSync(ws, { recursive: true });
        writeFileSync(join(outside, 'keep.txt'), 'x');
        symlinkSync(outside, ws);
        const r = runReset({ GITHUB_WORKSPACE: ws, RUNNER_WORKSPACE: rws });
        assert.equal(r.status, 0, r.stderr);
        assert.ok(existsSync(ws), 'the heal must recreate the leaf');
        assert.equal(
          lstatSync(ws).isSymbolicLink(),
          false,
          'the leaf must be a real directory after the heal',
        );
        assert.deepEqual(readdirSync(ws), []);
        assert.match(r.stdout, /::warning::healing workspace /);
        assert.ok(
          existsSync(join(outside, 'keep.txt')),
          'rm -f on the link must never follow it',
        );
      } finally {
        rmSync(rws, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    }
    // The link target is bytes a previous job on this shared pool chose,
    // and the runner splits step stdout on \r as well as \n — an
    // unflattened target would let the heal line spawn a forged
    // workflow command, and an uncapped one floods the log. These two
    // fixtures witness the flatten and the cap.
    {
      const { rws, ws } = makePool();
      try {
        rmSync(ws, { recursive: true });
        const forged = join(rws, 'tgt\r::error::forged');
        mkdirSync(forged);
        symlinkSync(forged, ws);
        const r = runReset({ GITHUB_WORKSPACE: ws, RUNNER_WORKSPACE: rws });
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /::warning::healing workspace /);
        assert.doesNotMatch(
          r.stdout,
          /\r/,
          'the heal line must flatten CR as well as LF',
        );
        for (const line of r.stdout.split('\n')) {
          assert.ok(
            !line.startsWith('::error::'),
            `a forged workflow command reached stdout: ${line}`,
          );
        }
      } finally {
        rmSync(rws, { recursive: true, force: true });
      }
    }
    {
      const { rws, ws } = makePool();
      try {
        rmSync(ws, { recursive: true });
        const longTarget = join(rws, 'x'.repeat(250));
        mkdirSync(longTarget);
        symlinkSync(longTarget, ws);
        const r = runReset({ GITHUB_WORKSPACE: ws, RUNNER_WORKSPACE: rws });
        assert.equal(r.status, 0, r.stderr);
        const healLine = r.stdout
          .split('\n')
          .find((l) => l.includes('pointed at'));
        assert.ok(healLine, 'the heal must still report its target');
        assert.equal(
          healLine.split('pointed at ')[1].length,
          200,
          'the printed target is capped at 200 characters',
        );
      } finally {
        rmSync(rws, { recursive: true, force: true });
      }
    }
    // Heal: the other half of the predicate — a leftover regular file
    // where the workspace should be wedges the step exactly the same
    // way, and takes the non-symlink arm of the announce.
    {
      const { rws, ws } = makePool();
      try {
        rmSync(ws, { recursive: true });
        writeFileSync(ws, 'not a directory');
        const r = runReset({ GITHUB_WORKSPACE: ws, RUNNER_WORKSPACE: rws });
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /it was not a directory/);
        assert.ok(
          lstatSync(ws).isDirectory(),
          'the leaf must be recreated as a real directory',
        );
        assert.deepEqual(readdirSync(ws), []);
      } finally {
        rmSync(rws, { recursive: true, force: true });
      }
    }
    // Refusal: the heal judges the canonicalized PARENT — a leaf that
    // is a symlink UNDER a symlinked intermediate resolves to a parent
    // outside the runner workspace, and the refusal must fire BEFORE
    // the rm/mkdir, or the heal deletes and recreates a path on foreign
    // storage (the mutation the guard exists for). The wipe guards
    // below would still refuse afterwards, but a report is not a
    // prevention.
    {
      const { rws, ws } = makePool();
      const outside = realpathSync(
        mkdtempSync(join(tmpdir(), 'e2e-checkout-outside-')),
      );
      try {
        rmSync(ws, { recursive: true });
        symlinkSync(outside, join(rws, 'link'));
        symlinkSync('target-that-need-not-exist', join(outside, 'leaf'));
        const r = runReset({
          GITHUB_WORKSPACE: join(rws, 'link', 'leaf'),
          RUNNER_WORKSPACE: rws,
        });
        assert.equal(r.status, 1, `expected a loud refusal: ${r.stdout}`);
        assert.match(
          r.stdout,
          /::error::refusing to heal workspace outside the runner workspace/,
        );
        assert.ok(
          lstatSync(join(outside, 'leaf')).isSymbolicLink(),
          'the refusal precedes the rm/mkdir — the foreign leaf keeps its type',
        );
      } finally {
        rmSync(rws, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    }
    // Refusal: a symlinked INTERMEDIATE path component redirects the
    // delete outside the runner workspace (the threat the guard exists
    // for). The step must fail loud and delete nothing.
    {
      const { rws, ws } = makePool();
      const outside = realpathSync(
        mkdtempSync(join(tmpdir(), 'e2e-checkout-outside-')),
      );
      try {
        mkdirSync(join(outside, 'ws'));
        writeFileSync(join(outside, 'ws', 'keep.txt'), 'x');
        rmSync(ws, { recursive: true });
        symlinkSync(outside, join(rws, 'link'));
        const r = runReset({
          GITHUB_WORKSPACE: join(rws, 'link', 'ws'),
          RUNNER_WORKSPACE: rws,
        });
        assert.equal(r.status, 1, `expected a loud refusal: ${r.stdout}`);
        assert.match(
          r.stdout,
          /::error::refusing to wipe: workspace resolves through a symlinked component/,
        );
        assert.ok(
          existsSync(join(outside, 'ws', 'keep.txt')),
          'nothing outside the runner workspace may be deleted',
        );
      } finally {
        rmSync(rws, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    }
    // Refusal: the denylist can only enumerate known roots — the
    // $RUNNER_WORKSPACE allowlist is what closes every other one.
    {
      const { rws } = makePool();
      const foreign = realpathSync(
        mkdtempSync(join(tmpdir(), 'e2e-checkout-foreign-')),
      );
      try {
        writeFileSync(join(foreign, 'keep.txt'), 'x');
        const r = runReset({
          GITHUB_WORKSPACE: foreign,
          RUNNER_WORKSPACE: rws,
        });
        assert.equal(r.status, 1, `expected a loud refusal: ${r.stdout}`);
        assert.match(
          r.stdout,
          /::error::refusing to wipe workspace outside the runner workspace/,
        );
        assert.ok(existsSync(join(foreign, 'keep.txt')));
      } finally {
        rmSync(rws, { recursive: true, force: true });
        rmSync(foreign, { recursive: true, force: true });
      }
    }
    // Refusal: the denylist arm comes first, so a known root is refused
    // even when it sits inside the claimed runner workspace. The
    // PATH-fronted find stub keeps a regressed guard from ever reaching
    // a real wipe of /var.
    {
      const bin = mkdtempSync(join(tmpdir(), 'e2e-checkout-reset-bin-'));
      writeFileSync(join(bin, 'find'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(bin, 'find'), 0o755);
      try {
        const r = runReset({
          GITHUB_WORKSPACE: '/var',
          RUNNER_WORKSPACE: '/var',
          PATH: `${bin}:${process.env.PATH}`,
        });
        assert.equal(r.status, 1, `expected a loud refusal: ${r.stdout}`);
        assert.match(
          r.stdout,
          /::error::refusing to wipe suspicious workspace path: \/var/,
        );
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
    }
    // Abort: `:?` fails the step on a null GITHUB_WORKSPACE even though
    // the variable is set — an empty expansion must never reach the
    // guard cases as "".
    {
      const { rws } = makePool();
      try {
        const r = runReset({ GITHUB_WORKSPACE: '', RUNNER_WORKSPACE: rws });
        assert.notEqual(r.status, 0, 'an empty GITHUB_WORKSPACE must abort');
        assert.match(r.stderr, /GITHUB_WORKSPACE/);
      } finally {
        rmSync(rws, { recursive: true, force: true });
      }
    }
  });

  it(
    'executes the reset: a failed wipe warns, names survivors, and exits 0',
    // Root bypasses the 0o500 lock (CAP_DAC_OVERRIDE), so the fixture
    // cannot fail the wipe there.
    { skip: process.getuid?.() === 0 },
    () => {
      const { rws, ws } = makePool();
      // A sudo stub keeps the sudo leg deterministic on every lane: the
      // real pool splits between members with passwordless sudo and
      // members without.
      const bin = mkdtempSync(join(tmpdir(), 'e2e-checkout-reset-bin-'));
      // The stub answers with the real sudo's refusal text so the test
      // also pins that the leg's stderr reaches the log.
      writeFileSync(
        join(bin, 'sudo'),
        "#!/bin/sh\necho 'sudo: a password is required' >&2\nexit 1\n",
      );
      chmodSync(join(bin, 'sudo'), 0o755);
      try {
        writeFileSync(join(ws, 'leftover'), 'x');
        // A survivor whose name carries a CR: the runner splits step
        // stdout on \r as well as \n, so an unflattened CR would let a
        // leftover filename begin a new line with `::` and forge a
        // workflow command.
        writeFileSync(join(ws, 'x\r::error::forged'), 'x');
        chmodSync(ws, 0o500);
        const r = runReset({
          GITHUB_WORKSPACE: ws,
          RUNNER_WORKSPACE: rws,
          PATH: `${bin}:${process.env.PATH}`,
        });
        // The step has no continue-on-error, so its own never-fail exit
        // is what keeps the heal chain alive: a wipe that cannot
        // complete must warn and exit 0 so the retry checkout still
        // runs against the survivors — a double checkout failure is
        // what turns the job red, not the heal step.
        assert.equal(r.status, 0, r.stderr);
        assert.ok(existsSync(ws));
        assert.deepEqual(readdirSync(ws).sort(), [
          'leftover',
          'x\r::error::forged',
        ]);
        assert.match(r.stdout, /could not clear the workspace/);
        assert.match(r.stdout, /workspace wipe left survivors/);
        assert.match(r.stdout, /leftover/);
        assert.doesNotMatch(
          r.stdout,
          /\r/,
          'the survivors line must flatten CR as well as LF',
        );
        // A failed wipe must stay diagnosable: the sudo leg keeps its
        // stderr instead of sinking it to /dev/null, so the log names
        // the cause (EACCES, missing passwordless sudo, ENOSPC), not
        // just the survivors.
        assert.match(r.stderr, /Permission denied|password is required/);
      } finally {
        chmodSync(ws, 0o755);
        rmSync(rws, { recursive: true, force: true });
        rmSync(bin, { recursive: true, force: true });
      }
    },
  );

  it(
    'executes the reset: the sudo leg clears what the user cannot',
    // Root bypasses the 0o500 lock (CAP_DAC_OVERRIDE), so the user-mode
    // leg would succeed there and the escalation would never run.
    { skip: process.getuid?.() === 0 },
    () => {
      // The failure case above stubs sudo to fail; this case pins the
      // success branch — the leg's presence, its target, and its
      // effect — so deleting or repointing the leg cannot ship green.
      // The stub records its argv (compared as exact entries: a drifted
      // target like "$WS/nope" still CONTAINS the workspace path as a
      // substring), then lifts the 0o500 lock and re-execs the wipe the
      // way passwordless sudo would.
      const { rws, ws } = makePool();
      const bin = mkdtempSync(join(tmpdir(), 'e2e-checkout-reset-bin-'));
      const marker = join(bin, 'sudo-argv');
      writeFileSync(
        join(bin, 'sudo'),
        `#!/bin/sh\nprintf '%s\\n' "$@" > '${marker}'\nshift\nchmod u+rwx "$2"\nexec "$@"\n`,
      );
      chmodSync(join(bin, 'sudo'), 0o755);
      try {
        writeFileSync(join(ws, 'leftover'), 'x');
        chmodSync(ws, 0o500);
        const r = runReset({
          GITHUB_WORKSPACE: ws,
          RUNNER_WORKSPACE: rws,
          PATH: `${bin}:${process.env.PATH}`,
        });
        assert.equal(r.status, 0, r.stderr);
        assert.ok(existsSync(ws));
        assert.deepEqual(readdirSync(ws), []);
        assert.doesNotMatch(r.stdout, /could not clear the workspace/);
        assert.doesNotMatch(r.stdout, /workspace wipe left survivors/);
        assert.ok(existsSync(marker), 'the sudo leg must have been reached');
        assert.ok(
          readFileSync(marker, 'utf8').split('\n').includes(ws),
          'the sudo leg must target the workspace itself',
        );
      } finally {
        chmodSync(ws, 0o755);
        rmSync(rws, { recursive: true, force: true });
        rmSync(bin, { recursive: true, force: true });
      }
    },
  );

  it('keeps setup-node off the pool', () => {
    // The action's post step uploads the npm cache to GitHub; on the
    // pool's slow egress that save ran 14+ minutes and timed out
    // security-checks' first pool run (2026-08-26). Hosted keeps the
    // action; the pool reuses the machine's Node and its persistent npm
    // cache, exactly as ci.yml does.
    const setup = job.steps.find((s) =>
      String(s.uses || '').startsWith('actions/setup-node'),
    );
    assert.ok(setup, 'the hosted setup-node step must exist');
    assert.equal(setup.if, "${{ runner.environment == 'github-hosted' }}");
    const preflight = job.steps.find(
      (s) => s.uses === './.github/actions/self-hosted-node',
    );
    assert.ok(preflight, 'the pool lane must use the pre-installed Node');
    assert.equal(preflight.if, "${{ runner.environment == 'self-hosted' }}");
  });
});

describe('qwen-autofix.yml scan-lane runner routing', () => {
  // route and review-scan gate the WHOLE fan-out: while they sit queued no
  // review-address leg starts. A hosted-runner backlog queued them past the
  // cron period, and the cron supersede rule then starved every scan round
  // (2026-08-25) — so pin the lane on the persistent pool, with the
  // fork-trust clause and the kill-switch intact.
  const autofixDoc = parse(
    readFileSync(join(workflowsDir, 'qwen-autofix.yml'), 'utf8'),
  );
  // evalRunsOn unwraps the winning fromJSON label to the array it names, so
  // compare against arrays, not the ECS/HOSTED string constants above.
  const ECS_LABELS = ['self-hosted', 'linux', 'x64', 'ecs-qwen'];
  const HOSTED_LABELS = ['ubuntu-latest'];

  for (const jobName of ['route', 'review-scan']) {
    const runsOn = String(autofixDoc.jobs[jobName]['runs-on']);

    it(`${jobName} reaches the persistent pool on schedule, dispatch, issue_comment, and issues`, () => {
      // issue_comment is route's /takeover and /retry lane, issues its
      // label/assign trigger lane for issue-autofix — pin both beside the
      // cron and dispatch triggers so a later event-allowlist narrowing of
      // the pool clause cannot silently demote either back to hosted.
      for (const eventName of [
        'schedule',
        'workflow_dispatch',
        'issue_comment',
        'issues',
      ]) {
        assert.deepEqual(
          evalRunsOn(runsOn, {
            ecsDisabled: false,
            eventName,
            sameRepo: false,
            assoc: '',
          }),
          ECS_LABELS,
          `${jobName} must scan from the pool on ${eventName}`,
        );
      }
    });

    it(`${jobName} keeps untrusted fork PR lanes hosted`, () => {
      for (const eventName of ['pull_request', 'pull_request_review']) {
        assert.deepEqual(
          evalRunsOn(runsOn, {
            ecsDisabled: false,
            eventName,
            sameRepo: false,
            assoc: 'NONE',
          }),
          HOSTED_LABELS,
          `${jobName} fork lane (${eventName}) must stay hosted`,
        );
        assert.deepEqual(
          evalRunsOn(runsOn, {
            ecsDisabled: false,
            eventName,
            sameRepo: true,
            assoc: 'NONE',
          }),
          ECS_LABELS,
          `${jobName} same-repo lane (${eventName}) must reach the pool`,
        );
      }
    });

    it(`${jobName} obeys the kill-switch on every event`, () => {
      for (const eventName of [
        'schedule',
        'workflow_dispatch',
        'issue_comment',
        'pull_request',
        'pull_request_review',
      ]) {
        assert.deepEqual(
          evalRunsOn(runsOn, {
            ecsDisabled: true,
            eventName,
            sameRepo: true,
            assoc: 'OWNER',
          }),
          HOSTED_LABELS,
          `kill-switch must win on ${eventName}`,
        );
      }
    });
  }
});
