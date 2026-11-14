// Runner-routing regression guards for ci.yml, serve-ab.yml, e2e.yml, the
// qwen-autofix.yml scan lane, the trusted-PR lanes of #13245, and the
// control-plane jobs that run no PR code.
//
// classify_pr's own runner is association-gated ECS (kill-switch excepted):
// a pull_request run executes the PR's own YAML, so the clause is throughput
// policy, not an enforceable trust boundary. The policy is stated once, in
// docs/design/2026-10-31-lint-static-ecs-routing.md; this file pins its shape —
// including the repository-name guard, which keeps a fork named `qwen-code`
// from being sent to a pool it cannot reach.
// The association routing for DOWNSTREAM lanes lives in the `pick_runner`
// shell step, which publishes `ubuntu_runner` (association-gated) and
// `lint_runner` (untrusted forks use the disposable ARM64 pool). Every
// self-hosted branch also requires the canonical repository name: a fork
// named `qwen-code` otherwise satisfies SAME_REPO on its own PRs and takes
// labels for a pool it cannot reach (#17222). The matrix below pins the
// gate's association-gated routing AND that ubuntu_runner keeps the
// association gate for the test/integration lanes.
//
// test_windows carries a deliberately different policy. A pull_request run
// executes the workflow YAML from the PR's own merge commit, so any trust
// clause a PR can read it can also rewrite. The matrix evaluates the real
// expression text and asserts the only enforceable shape: every pull request
// stays hosted, and only the merge queue, schedule and dispatch reach the
// persistent pool.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

// GitHub expression semantics for the runs-on expressions, restricted to
// the routing-relevant inputs: contains(list, '') is false, a missing
// pull_request (merge_group / dispatch) yields '' for both head.repo and
// author_association.

// Evaluates a real `runs-on` expression text with the routing inputs
// substituted, leaving only the &&/||/parenthesis skeleton — which matches
// GitHub's operator semantics closely enough for this fixed shape: both
// return the winning operand, and the winning operand is a fromJSON runner
// label, unwrapped here to the array it names. Any term the substitutions
// do not recognise fails loud, so an edited expression is re-read here
// instead of silently outgrowing the matrix.
function evalRunsOn(
  expression,
  {
    ecsDisabled,
    eventName,
    sameRepo,
    assoc,
    repoName = 'QwenLM/qwen-code',
    dispatchRunner = 'self-hosted',
  },
) {
  const substitutions = [
    [/vars\.MAINTAINER_ECS_RUNNER_DISABLED != 'true'/, String(!ecsDisabled)],
    [
      /github\.event_name == 'merge_group'/,
      String(eventName === 'merge_group'),
    ],
    [/github\.event_name == 'push'/, String(eventName === 'push')],
    [
      /github\.event_name == 'workflow_dispatch'/,
      String(eventName === 'workflow_dispatch'),
    ],
    // Longest term first as a convention; both patterns are quote-anchored
    // (the closing quote is part of each regex), so neither can match
    // inside the other and the substitution order is behaviorally inert.
    [
      /github\.event_name != 'pull_request_review'/,
      String(eventName !== 'pull_request_review'),
    ],
    [
      /github\.event_name != 'pull_request_target'/,
      String(eventName !== 'pull_request_target'),
    ],
    [
      /github\.event_name != 'pull_request'/,
      String(eventName !== 'pull_request'),
    ],
    [
      /github\.event_name == 'pull_request'/,
      String(eventName === 'pull_request'),
    ],
    [
      /github\.repository == 'QwenLM\/qwen-code'/,
      String(repoName === 'QwenLM/qwen-code'),
    ],
    [
      /github\.event\.inputs\.linux_runner != 'hosted'/,
      String(dispatchRunner !== 'hosted'),
    ],
    [
      /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
      String(sameRepo),
    ],
    [
      /github\.event\.pull_request\.head\.repo\.full_name != github\.repository/,
      String(!sameRepo),
    ],
    [
      /contains\(fromJSON\('\["OWNER","MEMBER","COLLABORATOR"\]'\), github\.event\.pull_request\.author_association\)/,
      String(TRUSTED.includes(assoc)),
    ],
    [
      /github\.repository == 'QwenLM\/qwen-code'/,
      String(repoName === 'QwenLM/qwen-code'),
    ],
    [
      /github\.event\.inputs\.linux_runner != 'hosted'/,
      String(dispatchRunner !== 'hosted'),
    ],
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
// selected runners exactly as CI would publish them.
function runPickRunnerOutputs({
  ecsDisabled,
  sameRepo,
  assoc,
  eventName,
  dispatch,
  fleet,
  repoName = 'QwenLM/qwen-code',
}) {
  const tmp = mkdtempSync(join(tmpdir(), 'pick-runner-'));
  const outputFile = join(tmp, 'github_output');
  const result = spawnSync('bash', ['-c', pickRunner.run], {
    env: {
      SAME_REPO: sameRepo ? 'true' : 'false',
      AUTHOR_ASSOCIATION: assoc,
      ECS_DISABLED: ecsDisabled ? 'true' : '',
      EVENT_NAME: eventName,
      LINUX_RUNNER_FLEET: fleet ?? '',
      DISPATCH_LINUX_RUNNER: dispatch ?? '',
      REPO_NAME: repoName,
      GITHUB_OUTPUT: outputFile,
    },
    encoding: 'utf8',
  });
  const outputs = existsSync(outputFile)
    ? readFileSync(outputFile, 'utf8')
    : '';
  rmSync(tmp, { recursive: true, force: true });
  assert.equal(result.status, 0, `pick_runner failed: ${result.stderr}`);
  const select = (prefix) => {
    const line = result.stdout.split('\n').find((l) => l.startsWith(prefix));
    assert.ok(line, `no selection in pick_runner output: ${result.stdout}`);
    return line.slice(prefix.length);
  };
  const ubuntuRunner = select('Selected Linux runner: ');
  const lintRunner = select('Selected lint runner: ');
  // The stdout echo and the published output must agree — a rename of the
  // GITHUB_OUTPUT key would otherwise pass the echo parse and break every
  // downstream runs-on at runtime.
  assert.ok(
    outputs.split('\n').includes(`ubuntu_runner=${ubuntuRunner}`),
    `ubuntu_runner not published: ${outputs}`,
  );
  assert.ok(
    outputs.split('\n').includes(`lint_runner=${lintRunner}`),
    `lint_runner not published: ${outputs}`,
  );
  const prTest = outputs
    .split('\n')
    .find((line) => line.startsWith('pr_test_runner='));
  assert.ok(prTest, 'pr_test_runner not published');
  return {
    ubuntuRunner,
    lintRunner,
    prTestRunner: prTest.slice('pr_test_runner='.length),
  };
}

function runPickRunner(inputs) {
  return runPickRunnerOutputs(inputs).ubuntuRunner;
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
  it('the gate routes trusted authors and same-repo to ECS; untrusted forks stay hosted', () => {
    // Pins the DEFAULT routing (the header carries the threat model): trusted
    // associations and same-repo PRs land on ECS, everything else stays hosted
    // — not a boundary a fork cannot cross. The kill-switch wins for everyone.
    for (const sameRepo of [true, false]) {
      for (const assoc of ASSOCIATIONS) {
        const isTrusted = sameRepo || TRUSTED.includes(assoc);
        assert.deepEqual(
          evalRunsOn(classifyRunsOn, {
            ecsDisabled: false,
            eventName: 'pull_request',
            sameRepo,
            assoc,
          }),
          JSON.parse(isTrusted ? ECS : HOSTED),
          `gate sameRepo=${sameRepo} assoc='${assoc}' must ${isTrusted ? 'reach ECS' : 'stay hosted'}`,
        );
        assert.deepEqual(
          evalRunsOn(classifyRunsOn, {
            ecsDisabled: true,
            eventName: 'pull_request',
            sameRepo,
            assoc,
          }),
          JSON.parse(HOSTED),
          `kill-switch must revert the gate (assoc='${assoc}')`,
        );
      }
    }
    // dispatch reaches ECS too ("the merge queue, pushes to main, and dispatch"
    // above). An earlier revision of this PR gated on the PR clauses alone, so
    // dispatch — whose github.event.pull_request is empty — fell to hosted.
    // Only users with write access can dispatch, and they already reach ECS via
    // same-repo PRs and push, so this adds no reachability (unchanged vs base).
    for (const assoc of ['', 'NONE', 'OWNER']) {
      assert.deepEqual(
        evalRunsOn(classifyRunsOn, {
          ecsDisabled: false,
          eventName: 'workflow_dispatch',
          sameRepo: false,
          assoc,
        }),
        JSON.parse(ECS),
        `dispatch (assoc='${assoc}') must reach ECS`,
      );
    }
    assert.deepEqual(
      evalRunsOn(classifyRunsOn, {
        ecsDisabled: true,
        eventName: 'workflow_dispatch',
        sameRepo: false,
        assoc: 'OWNER',
      }),
      JSON.parse(HOSTED),
      'dispatch kill-switch must revert to hosted',
    );
    // A maintainer who asks for hosted gets hosted here too: `pick_runner`
    // treats the `linux_runner` input as authoritative for the downstream
    // lanes, and a gate that ignored it would sit on the pool the maintainer
    // just drained. (The arm64 option is a residual with no bound: the gate has
    // no arm64 labels, so it asks the x64 pool, and `timeout-minutes` cannot
    // cover the wait because its clock starts only at pickup — with no x64
    // runner online, `classify_pr` queues unbounded.)
    assert.deepEqual(
      evalRunsOn(classifyRunsOn, {
        ecsDisabled: false,
        eventName: 'workflow_dispatch',
        sameRepo: false,
        assoc: '',
        dispatchRunner: 'hosted',
      }),
      JSON.parse(HOSTED),
      'dispatch with linux_runner=hosted must stay hosted',
    );
    // Only THIS repository. A fork named `qwen-code` satisfies
    // `head.repo.full_name == github.repository`, and without the name guard it
    // routes to a pool it cannot reach: classify_pr never finishes, so no lane
    // gets a verdict at all.
    assert.deepEqual(
      evalRunsOn(classifyRunsOn, {
        ecsDisabled: false,
        eventName: 'pull_request',
        sameRepo: true,
        assoc: 'OWNER',
        repoName: 'alice/qwen-code',
      }),
      JSON.parse(HOSTED),
      'a fork named qwen-code must not reach the pool',
    );
    // merge_group has an empty PR context too. Pin it against the gate's own
    // runs-on — the pick_runner shell tests below cover the downstream lanes,
    // not this expression. Without these rows, deleting the merge_group clause
    // silently demotes the queue to hosted with every test still green.
    for (const ecsDisabled of [false, true]) {
      assert.deepEqual(
        evalRunsOn(classifyRunsOn, {
          ecsDisabled,
          eventName: 'merge_group',
          sameRepo: false,
          assoc: '',
        }),
        JSON.parse(ecsDisabled ? HOSTED : ECS),
        `merge_group (ecsDisabled=${ecsDisabled})`,
      );
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

  it('routes the push classifier and downstream jobs to the same pool', () => {
    for (const ecsDisabled of [false, true]) {
      const inputs = {
        ecsDisabled,
        sameRepo: false,
        assoc: '',
        eventName: 'push',
      };
      const expected = ecsDisabled ? HOSTED : ECS;
      assert.deepEqual(
        evalRunsOn(classifyRunsOn, inputs),
        JSON.parse(expected),
      );
      assert.equal(runPickRunner(inputs), expected);
    }
  });

  it('the gate expression requires trusted author or same-repo for self-hosted', () => {
    // Structural pins for the DEFAULT routing: the gate keeps the association
    // and head-repo clauses so unreviewed forks stay off the pool by default —
    // throughput policy, not a fence (a fork can rewrite this whole YAML in the
    // same diff; see the header). The kill-switch must stay as an escape hatch.
    assert.match(classifyRunsOn, /author_association/);
    assert.match(classifyRunsOn, /head\.repo\.full_name/);
    assert.match(
      classifyRunsOn,
      /vars\.MAINTAINER_ECS_RUNNER_DISABLED != 'true'/,
    );
    assert.match(classifyRunsOn, /ecs-qwen/);
  });
});

describe('ci.yml lint_runner routing', () => {
  const ARM = '["self-hosted", "linux", "arm64"]';
  const lintRunner = (inputs) => runPickRunnerOutputs(inputs).lintRunner;

  // The disposable-pool config and the CI selectors are one contract: a label
  // rename on either side leaves every fork PR queued forever with no failed
  // check to point at. Pin them together (#16551 review).
  it('publishes exactly the labels the disposable-pool config registers', () => {
    const config = JSON.parse(
      readFileSync(
        join(
          workflowsDir,
          '..',
          '..',
          'scripts',
          'ci',
          'ephemeral-runner',
          'config.example.json',
        ),
        'utf8',
      ),
    );
    const fork = runPickRunnerOutputs({
      eventName: 'pull_request',
      sameRepo: false,
      assoc: 'NONE',
    });
    assert.deepEqual(JSON.parse(fork.prTestRunner), config.labels);
    assert.deepEqual(JSON.parse(fork.lintRunner), config.labels);
  });

  it('routes untrusted fork lint to the disposable pool without variables', () => {
    for (const sameRepo of [true, false]) {
      for (const assoc of ASSOCIATIONS) {
        assert.equal(
          lintRunner({
            ecsDisabled: false,
            sameRepo,
            assoc,
            eventName: 'pull_request',
          }),
          sameRepo || TRUSTED.includes(assoc)
            ? ECS
            : '["self-hosted", "ecs-qwen-ephemeral"]',
          `lint sameRepo=${sameRepo} assoc='${assoc}'`,
        );
      }
    }
  });

  it('keeps the kill-switch and hosted-fleet overrides', () => {
    for (const assoc of ASSOCIATIONS) {
      assert.equal(
        lintRunner({
          ecsDisabled: true,
          sameRepo: true,
          assoc,
          eventName: 'pull_request',
        }),
        HOSTED,
        'kill-switch must revert even lint to hosted',
      );
      assert.equal(
        lintRunner({
          ecsDisabled: false,
          sameRepo: false,
          assoc,
          eventName: 'pull_request',
          fleet: 'hosted',
        }),
        HOSTED,
        'LINUX_RUNNER_FLEET=hosted must keep lint hosted',
      );
    }
  });

  it('follows the arm64 fleet selector', () => {
    assert.equal(
      lintRunner({
        ecsDisabled: false,
        sameRepo: false,
        assoc: 'MEMBER',
        eventName: 'pull_request',
        fleet: 'arm64',
      }),
      ARM,
    );
  });

  it('inherits ubuntu_runner on non-PR events and dispatch inputs', () => {
    for (const eventName of ['merge_group', 'push']) {
      assert.equal(
        lintRunner({
          ecsDisabled: false,
          sameRepo: false,
          assoc: '',
          eventName,
        }),
        ECS,
      );
    }
    assert.equal(
      lintRunner({
        ecsDisabled: false,
        sameRepo: false,
        assoc: '',
        eventName: 'workflow_dispatch',
        dispatch: 'self-hosted',
      }),
      ECS,
    );
    assert.equal(
      lintRunner({
        ecsDisabled: false,
        sameRepo: false,
        assoc: '',
        eventName: 'workflow_dispatch',
        dispatch: 'hosted',
      }),
      HOSTED,
    );
    assert.equal(
      lintRunner({
        ecsDisabled: true,
        sameRepo: false,
        assoc: '',
        eventName: 'workflow_dispatch',
        dispatch: 'self-hosted',
      }),
      HOSTED,
    );
  });

  it('classify_pr publishes lint_runner from pick_runner', () => {
    assert.equal(
      ciDoc.jobs.classify_pr.outputs.lint_runner,
      '${{ steps.pick_runner.outputs.lint_runner }}',
    );
  });

  it('lint_and_static consumes lint_runner for runs-on and timeout', () => {
    assert.equal(
      String(ciDoc.jobs.lint_and_static['runs-on']),
      '${{ fromJSON(needs.classify_pr.outputs.lint_runner || \'["ubuntu-latest"]\') }}',
    );
    assert.match(
      String(ciDoc.jobs.lint_and_static['timeout-minutes']),
      /needs\.classify_pr\.outputs\.lint_runner/,
    );
  });

  it('keeps both outputs on one fleet ladder', () => {
    // The lint arm assigns from the same resolved fleet labels as
    // ubuntu_runner; a fleet value neither models must not split them when
    // the trust clause is satisfied (a second literal ladder drifts silently
    // because the timeout reads lint_runner and still reports a pool ceiling).
    for (const fleet of ['', 'x64', 'arm64', 'future-fleet']) {
      const out = runPickRunnerOutputs({
        ecsDisabled: false,
        sameRepo: true,
        assoc: 'NONE',
        eventName: 'pull_request',
        fleet,
      });
      assert.equal(out.lintRunner, out.ubuntuRunner, `fleet='${fleet}'`);
    }
  });
});

describe('ci.yml pick_runner canonical-repo guard', () => {
  // #17222: pick_runner knew SAME_REPO and the author association but not
  // which repository it was running in, so a PR inside a fork named
  // `qwen-code` took the self-hosted labels for all three outputs and
  // queued forever. Every self-hosted branch now requires the canonical
  // repository name as well.
  const FORK = 'alice/qwen-code';

  it('keeps a fork-internal PR on hosted runners for all three outputs', () => {
    const out = runPickRunnerOutputs({
      ecsDisabled: false,
      sameRepo: true,
      assoc: 'OWNER',
      eventName: 'pull_request',
      repoName: FORK,
    });
    assert.equal(out.ubuntuRunner, HOSTED);
    assert.equal(out.prTestRunner, HOSTED);
    assert.equal(out.lintRunner, HOSTED);
  });

  it('keeps a fork dispatch and a cross-fork PR off the self-hosted pools', () => {
    const dispatched = runPickRunnerOutputs({
      ecsDisabled: false,
      sameRepo: false,
      assoc: '',
      eventName: 'workflow_dispatch',
      dispatch: 'self-hosted',
      repoName: FORK,
    });
    assert.equal(dispatched.ubuntuRunner, HOSTED);
    assert.equal(dispatched.prTestRunner, HOSTED);
    assert.equal(dispatched.lintRunner, HOSTED);
    // The ephemeral branch fires on a PR from a *different* fork
    // (SAME_REPO=false, untrusted author); in a fork that pool is just as
    // unreachable as the fleet.
    const crossFork = runPickRunnerOutputs({
      ecsDisabled: false,
      sameRepo: false,
      assoc: 'NONE',
      eventName: 'pull_request',
      repoName: FORK,
    });
    assert.equal(crossFork.ubuntuRunner, HOSTED);
    assert.equal(crossFork.prTestRunner, HOSTED);
    assert.equal(crossFork.lintRunner, HOSTED);
  });

  it('keeps the canonical repository on the fleet for the same inputs', () => {
    const out = runPickRunnerOutputs({
      ecsDisabled: false,
      sameRepo: true,
      assoc: 'OWNER',
      eventName: 'pull_request',
      repoName: 'QwenLM/qwen-code',
    });
    assert.equal(out.ubuntuRunner, ECS);
    assert.equal(out.prTestRunner, ECS);
    assert.equal(out.lintRunner, ECS);
  });

  it('wires the repository name into pick_runner', () => {
    assert.equal(pickRunner.env.REPO_NAME, '${{ github.repository }}');
  });
});

describe('ci.yml disposable runner routing', () => {
  it('selects the formal ARM64 pool when repository variables are empty', () => {
    const selected = runPickRunnerOutputs({
      eventName: 'pull_request',
      sameRepo: false,
      assoc: 'NONE',
    });
    const arm = '["self-hosted", "ecs-qwen-ephemeral"]';
    assert.equal(selected.prTestRunner, arm);
    assert.equal(selected.lintRunner, arm);
    assert.equal(selected.ubuntuRunner, HOSTED);
    const genericArm = JSON.parse(
      runPickRunnerOutputs({
        eventName: 'workflow_dispatch',
        dispatch: 'self-hosted-arm64',
      }).ubuntuRunner,
    );
    assert.equal(
      genericArm.every((label) => JSON.parse(arm).includes(label)),
      false,
      'generic ARM64 jobs must not match the disposable pool',
    );
    assert.equal(pickRunner.env.EPHEMERAL_ENABLED, undefined);
    assert.equal(pickRunner.env.EPHEMERAL_ARCH, undefined);
    assert.equal(
      existsSync(join(workflowsDir, 'ephemeral-runner-smoke.yml')),
      false,
    );
    assert.equal(
      existsSync(join(workflowsDir, 'ci-runner-routing.yml')),
      false,
    );
    const example = JSON.parse(
      readFileSync(
        join(
          dirname(fileURLToPath(import.meta.url)),
          '..',
          '..',
          'scripts',
          'ci',
          'ephemeral-runner',
          'config.example.json',
        ),
        'utf8',
      ),
    );
    assert.deepEqual(
      example.labels,
      JSON.parse(arm),
      'the example runner registration must match the fork routing selector',
    );
  });
  it('routes only untrusted fork jobs to the disposable pool', () => {
    const ephemeral = '["self-hosted", "ecs-qwen-ephemeral"]';
    for (const eventName of [
      'pull_request',
      'push',
      'merge_group',
      'workflow_dispatch',
    ]) {
      for (const sameRepo of [true, false]) {
        for (const assoc of ASSOCIATIONS) {
          for (const ecsDisabled of [true, false]) {
            for (const fleet of ['', 'hosted', 'arm64']) {
              const inputs = { eventName, sameRepo, assoc, ecsDisabled, fleet };
              const baseline = runPickRunnerOutputs(inputs);
              const selected =
                eventName === 'pull_request' &&
                !sameRepo &&
                !TRUSTED.includes(assoc) &&
                !ecsDisabled &&
                fleet !== 'hosted';
              assert.equal(
                baseline.prTestRunner,
                selected ? ephemeral : baseline.ubuntuRunner,
                JSON.stringify(inputs),
              );
              assert.equal(
                baseline.lintRunner,
                selected ? ephemeral : baseline.ubuntuRunner,
                JSON.stringify(inputs),
              );
            }
          }
        }
      }
    }
  });

  it('routes only the intended jobs through the new output', () => {
    assert.equal(
      ciDoc.jobs.classify_pr.outputs.pr_test_runner,
      '${{ steps.pick_runner.outputs.pr_test_runner }}',
    );
    for (const name of ['test_build', 'test'])
      assert.match(ciDoc.jobs[name]['runs-on'], /pr_test_runner/);
    for (const name of ['lint_and_static', 'integration_no_ak'])
      assert.match(ciDoc.jobs[name]['runs-on'], /lint_runner/);
    for (const [name, job] of Object.entries(ciDoc.jobs)) {
      if (!['classify_pr', 'test_build', 'test'].includes(name))
        assert.doesNotMatch(String(job['runs-on']), /pr_test_runner/, name);
    }
  });
});

describe('ci.yml lint HOME isolation', () => {
  // This guard lives in the routing battery (HELPER_TESTS) because it gates
  // every full-profile PR; the scripts/tests vitest suites only run after the
  // merge queue. lint_runner admits untrusted forks to a pool where
  // RUNNER_TEMP survives across jobs, so the isolated HOME must be run-unique
  // and cleared before use — a fixed path hands a fork's ~/.npmrc to the next
  // job on the registration. The ubuntu_runner lanes' association clause is
  // throughput policy, not an enforceable boundary (a pull_request run
  // executes the PR's own YAML); their pre-existing HOME properties are
  // separately owned.
  const ungated = Object.entries(ciDoc.jobs).filter(([, job]) =>
    /outputs\.lint_runner/.test(String(job['runs-on'] ?? '')),
  );

  // The one run-unique path per lane. create, the gate's QWEN_HOME and the
  // cleanup must all name it: a `home=` that drifts at one site leaves the
  // others pointing at a directory this run never cleared.
  const HOME_TEMPLATE = {
    lint_and_static: 'qwen-lint-home-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}',
    integration_no_ak: 'qwen-no-ak-home-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}',
  };

  // The `$GITHUB_ENV` writers, by value. It is last-write-wins, so an added
  // HOME/USERPROFILE writer (or a dropped `HOME=%s`) must break equality;
  // COREPACK_HOME stays inside the run-unique home (corepack does not
  // re-verify entries on cache hit — a shared home is a poisoning channel)
  // and XDG_CACHE_HOME rides the SHA-256-verified linter-archive cache.
  const ENV_WRITES = [
    'printf \'HOME=%s\\nUSERPROFILE=%s\\n\' "$home" "$home" >> "${GITHUB_ENV}"',
    'printf \'XDG_CACHE_HOME=%s\\n\' "${RUNNER_TOOL_CACHE}/qwen-ci-cache" >> "${GITHUB_ENV}"',
    'printf \'COREPACK_HOME=%s\\n\' "${home}/.cache/node/corepack" >> "${GITHUB_ENV}"',
  ];

  it('scopes the ungated routing to the recorded lanes', () => {
    // The decision record scopes the boundary change to Lint & Static and
    // (2026-11-02, same trust class — PR code on the pool, zero secrets by
    // construction) the no-AK integration lane; a superset must force a
    // deliberate record update, not pass silently.
    assert.deepEqual(
      ungated.map(([id]) => id),
      ['lint_and_static', 'integration_no_ak'],
    );
  });

  it('integration_no_ak isolates from its first step, zero-secrets at the gate', () => {
    // no_ak's fork code starts at the checkout action and the install
    // (lifecycle scripts AND scripts/prepare.js — build+bundle), not at the
    // gate step, so the whole job needs lint's first-step isolation:
    // GITHUB_ENV-published run-unique HOME, COREPACK_HOME inside it (corepack
    // does not re-verify entries on cache hit — a shared home is a
    // cross-job poisoning channel), XDG_CACHE_HOME on the shared verified
    // tool cache. The gate keeps the model-key scrub.
    // The routing decision's premise is that this job carries no secrets
    // because its only grant is the read-only checkout. Nothing else pins it:
    // adding any other scope would leave every assertion below green while
    // the accepted-risk argument went stale.
    assert.deepEqual(
      ciDoc.jobs.integration_no_ak.permissions,
      { contents: 'read' },
      'no_ak must keep only the read-only checkout grant',
    );

    const steps = ciDoc.jobs.integration_no_ak.steps ?? [];
    assert.equal(
      steps[0]?.name,
      'Create isolated HOME',
      'no_ak must isolate HOME from its first step',
    );
    // The create/cleanup step text is pinned by VALUE in the two shared tests
    // below, which iterate every ungated lane; looped substring checks used to
    // survive a `-v2` path drift, a dropped `HOME=%s` and an added HOME writer.
    // Job env must stay empty of HOME (the runner context is illegal there).
    assert.equal(ciDoc.jobs.integration_no_ak.env?.HOME, undefined);

    const gate = steps.find(
      (s) => s.name === 'Run required no-AK integration gate',
    );
    assert.ok(gate, 'integration gate step missing');
    // By value, not by prefix: a drifted create path or a `-v2` suffix would
    // satisfy `startsWith` while QWEN_HOME pointed at a directory this run
    // never cleared.
    assert.equal(
      gate.env?.QWEN_HOME,
      '${{ runner.temp }}/qwen-no-ak-home-${{ github.run_id }}-${{ github.run_attempt }}/.qwen',
      'QWEN_HOME must be the run-unique home the create step built',
    );
    // Zero-secrets contract, enforced by VALUE not by name: every env key
    // outside QWEN_HOME must be the empty string, and the step must
    // reference no secrets.* anywhere. A name-based regex inherits the
    // implementation's own premise about which names are credentials, so a
    // secret under any other name (CI_BOT_PAT, *_DSN, *_BEARER) shipped
    // green — falsifying the contract that justifies routing untrusted-fork
    // PR code onto the shared pool.
    const PATH_KEYS = new Set(['QWEN_HOME']);
    for (const [key, value] of Object.entries(gate.env ?? {})) {
      if (!PATH_KEYS.has(key)) {
        assert.equal(
          value,
          '',
          `${key} must be empty in the no-AK PR-code step`,
        );
      }
    }
    assert.ok(
      !JSON.stringify(gate).includes('secrets.'),
      'the no-AK PR-code step must not reference any secrets.* context',
    );
    // The value whitelist above only iterates PRESENT keys, so a deleted
    // scrub key escapes it (verified by mutation: dropping
    // ANTHROPIC_AUTH_TOKEN left both suites green). Pin a floor on the
    // known-dangerous set — the SDK back-fills this one from env.
    assert.equal(
      gate.env?.ANTHROPIC_AUTH_TOKEN,
      '',
      'ANTHROPIC_AUTH_TOKEN must be present and empty (SDK auth-resolver ' +
        'back-fill; deleting the scrub key escapes the value whitelist)',
    );
  });

  it('publishes a run-unique HOME from the first step, not job env', () => {
    // Both ungated lanes now share lint's shape: fork code runs from early
    // steps, so the first step publishes HOME/USERPROFILE via GITHUB_ENV for
    // every later step. no_ak's specifics (gate key scrub, reclamation) are
    // covered by its own test above.
    for (const [id, job] of ungated) {
      // jobs.<job_id>.env cannot read the runner context — GitHub rejects the
      // whole workflow file (actionlint 1.7.12 witnesses it).
      assert.equal(job.env?.HOME, undefined, `${id} job-level HOME`);
      assert.equal(
        job.env?.USERPROFILE,
        undefined,
        `${id} job-level USERPROFILE`,
      );
      const steps = job.steps ?? [];
      assert.equal(steps[0]?.name, 'Create isolated HOME', id);
      const run = String(steps[0]?.run ?? '');
      const lines = run.split('\n').map((line) => line.trim());
      // The declared `home=` by value: a `-v2` suffix here leaves the gate's
      // QWEN_HOME and the cleanup aimed at a directory this run never built.
      assert.ok(
        lines.includes(`home="\${RUNNER_TEMP}/${HOME_TEMPLATE[id]}"`),
        `${id} must build its run-unique HOME from the lane template`,
      );
      assert.ok(
        run.includes('rm -rf') && run.indexOf('rm -rf') < run.indexOf('mkdir'),
        `${id} must clear the path before creating it`,
      );
      assert.deepEqual(
        lines.filter((line) => line.includes('${GITHUB_ENV}')),
        ENV_WRITES,
        `${id} must publish exactly HOME/USERPROFILE, XDG_CACHE_HOME and COREPACK_HOME via GITHUB_ENV`,
      );
      // GITHUB_ENV is last-write-wins, so the guard cannot stop at step 0: a
      // later step that republishes an isolated key silently reverts the home
      // for the steps that run PR code while step 0 still matches. The npm
      // cache step is a legitimate later writer, so only the isolated keys
      // are banned — not every later `$GITHUB_ENV` append.
      // `[^\w]`, not `\s`: the realistic form is `printf 'HOME=%s\n'` inside
      // quotes, which a whitespace-only prefix let through.
      const ISOLATED_KEY =
        /(^|[^\w])(HOME|USERPROFILE|COREPACK_HOME|XDG_CACHE_HOME)=/;
      for (const [index, step] of steps.entries()) {
        if (index === 0) continue;
        for (const line of String(step.run ?? '')
          .split('\n')
          .map((l) => l.trim())) {
          assert.ok(
            !(line.includes('${GITHUB_ENV}') && ISOLATED_KEY.test(line)),
            `${id} step ${index} (${step.name}) must not republish an isolated HOME key via GITHUB_ENV`,
          );
        }
        for (const key of Object.keys(step.env ?? {})) {
          assert.ok(
            !/^(HOME|USERPROFILE|COREPACK_HOME|XDG_CACHE_HOME)$/.test(key),
            `${id} step ${index} (${step.name}) must not override ${key} for a single step`,
          );
        }
      }
    }
  });

  it('reclaims the isolated HOME before the failure collector', () => {
    // Both ungated lanes reclaim: no_ak's cleanup is its last step (it has
    // no collector); lint's sits before the failure collector, which must
    // stay last.
    for (const [id, job] of ungated) {
      const steps = job.steps ?? [];
      const names = steps.map((s) => s.name);
      const clean = steps.find((s) => s.name === 'Clean isolated HOME');
      assert.ok(clean, `${id} cleanup step missing`);
      assert.equal(clean.if, '${{ always() }}', id);
      const collectorIndex = names.indexOf('Upload disk-pressure samples');
      if (collectorIndex !== -1) {
        assert.ok(
          names.indexOf('Clean isolated HOME') < collectorIndex,
          `${id} collector must stay last`,
        );
      } else {
        // No collector (no_ak): the cleanup itself is the last step.
        assert.equal(
          names[names.length - 1],
          'Clean isolated HOME',
          `${id} cleanup must be the final step`,
        );
      }
      // The realized removal by value, never $HOME: any `qwen-*` path passes a
      // substring check, so a retargeted `rm -rf` (or an `echo` stand-in)
      // would leave the run-unique home to accumulate on this persistent pool.
      //
      // The reap runs BEFORE the removal and in the SAME step: a daemon that
      // outlived the suite recreates entries under the home while `rm -rf`
      // unlinks them, and rmdir loses with ENOTEMPTY (job 130495062334: 223
      // tests passed, then the required check went red on the cleanup). A
      // separate step could be skipped by an `if`, and the cleanup must stay
      // this lane's last step, so the ordering is pinned inside the run body.
      //
      // The helper owns the removal so the workflow does not grow past the size
      // ratchet. The fallback matters: `always()` reaches this step with no
      // checkout, or one predating the helper, and neither may redden the job.
      assert.equal(
        String(clean.run),
        `h="\${RUNNER_TEMP}/${HOME_TEMPLATE[id]}"; ` +
          '{ [ -f .github/scripts/ci/reap-isolated-home.sh ] && ' +
          'bash .github/scripts/ci/reap-isolated-home.sh "$h"; } || ' +
          'rm -rf -- "$h" || true',
        `${id} must reap this run's daemons, then reclaim the exact run-unique HOME the create step built`,
      );
    }
  });
});

describe('credential-free jobs on the disposable pool', () => {
  // The label's single source of truth is the pool config the classifier
  // contract test already reads: a rename on either side must red this
  // suite, not leave the capture requesting a label no runner advertises.
  const EPHEMERAL = JSON.parse(
    readFileSync(
      join(
        workflowsDir,
        '..',
        '..',
        'scripts',
        'ci',
        'ephemeral-runner',
        'config.example.json',
      ),
      'utf8',
    ),
  ).labels;

  it('ci.yml test_ubuntu: the checkout-free gate follows the shards fleet', () => {
    // A REQUIRED context must not sit behind a manually sized pool: pinned
    // to ecs-qwen-ephemeral it queued 110 minutes with an empty runner_name
    // (job 128729488158) while its sibling jobs were served in ~3. It now
    // reads the classifier's ubuntu_runner, so it lands wherever the
    // shards ran and the kill-switch keeps working through the classifier
    // — including on fork runs, where repository variables arrive empty.
    const job = ciDoc.jobs.test_ubuntu;
    assert.equal(
      String(job['runs-on']),
      '${{ fromJSON(needs.classify_pr.outputs.ubuntu_runner || \'["ubuntu-latest"]\') }}',
    );
    for (const eventName of ['pull_request', 'push', 'merge_group']) {
      for (const sameRepo of [true, false]) {
        for (const assoc of ASSOCIATIONS) {
          assert.deepEqual(
            JSON.parse(
              runPickRunner({ eventName, sameRepo, assoc, ecsDisabled: true }),
            ),
            JSON.parse(HOSTED),
            `kill-switch must revert the gate on ${eventName} sameRepo=${sameRepo} assoc='${assoc}'`,
          );
        }
      }
    }
    // The gate must never queue on the disposable pool, and it must sit
    // with the shards: hosted for untrusted forks, persistent fleet for
    // trusted events.
    assert.deepEqual(
      JSON.parse(
        runPickRunner({
          eventName: 'pull_request',
          sameRepo: false,
          assoc: 'NONE',
          ecsDisabled: false,
        }),
      ),
      JSON.parse(HOSTED),
    );
    assert.deepEqual(
      JSON.parse(
        runPickRunner({
          eventName: 'push',
          sameRepo: true,
          assoc: 'OWNER',
          ecsDisabled: false,
        }),
      ),
      JSON.parse(ECS),
    );
    assert.ok(
      !job.steps.some((s) =>
        String(s.uses || '').startsWith('actions/checkout'),
      ),
      'the gate must stay checkout-free wherever it is routed',
    );
  });

  it('web-shell-visuals.yml capture: all PR renders ride the disposable pool', () => {
    // The capture builds and renders untrusted PR code with a read-only
    // token and no secrets — the disposable pool's exact security model.
    // Same-repo and fork PRs use the same isolated execution boundary.
    const doc = parse(
      readFileSync(join(workflowsDir, 'web-shell-visuals.yml'), 'utf8'),
    );
    const runsOn = String(doc.jobs.capture['runs-on']);
    assert.match(runsOn, /github\.repository == 'QwenLM\/qwen-code'/);
    assert.doesNotMatch(
      runsOn,
      /github\.event\.pull_request\.head\.repo\.full_name/,
      'capture must not exclude same-repository PRs from the disposable pool',
    );
    for (const assoc of ASSOCIATIONS) {
      // Fork PR: the disposable pool, whoever authored it.
      assert.deepEqual(
        evalRunsOn(runsOn, {
          ecsDisabled: false,
          eventName: 'pull_request',
          sameRepo: false,
          assoc,
        }),
        EPHEMERAL,
        `capture fork assoc='${assoc}'`,
      );
      // Same-repo PR: uses the disposable pool while the switch is enabled.
      assert.deepEqual(
        evalRunsOn(runsOn, {
          ecsDisabled: false,
          eventName: 'pull_request',
          sameRepo: true,
          assoc,
        }),
        EPHEMERAL,
        `capture same-repo assoc='${assoc}'`,
      );
      assert.deepEqual(
        evalRunsOn(runsOn, {
          ecsDisabled: true,
          eventName: 'pull_request',
          sameRepo: true,
          assoc,
        }),
        JSON.parse(HOSTED),
        `kill-switch must revert same-repo capture to hosted assoc='${assoc}'`,
      );
      // Kill-switch reverts fork runs to hosted too.
      assert.deepEqual(
        evalRunsOn(runsOn, {
          ecsDisabled: true,
          eventName: 'pull_request',
          sameRepo: false,
          assoc,
        }),
        JSON.parse(HOSTED),
        `kill-switch must revert fork capture to hosted assoc='${assoc}'`,
      );
    }
    // The pool image bakes Chromium and its system libraries, and it keeps the
    // tree root-owned so a job cannot rewrite a browser. A job's own
    // `playwright install` cannot even verify there: playwright writes a lock
    // and a `.links` entry into the registry before it checks what is present.
    // The pool image is what sets PLAYWRIGHT_BROWSERS_PATH, so the install step
    // must skip on it.
    const install = doc.jobs.capture.steps.find(
      (step) => step.name === 'Install Playwright Chromium',
    );
    assert.ok(install, 'the capture job must keep its browser install step');
    assert.ok(
      String(install.run).includes(
        'if [ -n "${PLAYWRIGHT_BROWSERS_PATH:-}" ]; then',
      ),
      'the browser install must skip on the pool image',
    );
    // Only the event-scoped read-only GITHUB_TOKEN may reach the disposable
    // pool through this workflow; any other secret reference breaks the
    // pool's no-long-lived-secrets boundary. Walk every parsed ${{ … }}
    // expression instead of regexing raw text: `toJSON(secrets)` and
    // bracket forms must fail too, while the header's prose ("NO
    // secrets") stays invisible. One rule: an expression may mention the
    // secrets context only as exactly `secrets.GITHUB_TOKEN`.
    const expressions = [];
    const walk = (node) => {
      if (typeof node === 'string') {
        for (const m of node.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
          expressions.push(m[1]);
        }
      } else if (Array.isArray(node)) {
        node.forEach(walk);
      } else if (node && typeof node === 'object') {
        Object.values(node).forEach(walk);
      }
    };
    walk(doc);
    const assertNoForeignSecrets = (exprs) => {
      for (const expr of exprs) {
        if (!/\bsecrets\b/.test(expr)) continue;
        const stripped = expr.replaceAll('secrets.GITHUB_TOKEN', '');
        assert.ok(
          !/\bsecrets\b/.test(stripped),
          `expression reaches beyond the read-only event token: ${expr}`,
        );
      }
    };
    assertNoForeignSecrets(expressions);
    // Sensitivity fixtures: the forms the old raw-text regexes missed.
    for (const bad of [
      "${{ secrets['MODEL_KEY'] }}",
      '${{ secrets["MODEL_KEY"] }}',
      '${{ toJSON(secrets) }}',
    ]) {
      assert.throws(
        () => assertNoForeignSecrets([bad.slice(3, -3)]),
        /read-only event token/,
        `guard must reject ${bad}`,
      );
    }
    assertNoForeignSecrets([' secrets.GITHUB_TOKEN ']);
    assert.equal(doc.permissions.contents, 'read');
    // A job-level permissions block REPLACES the workflow-level one, so
    // workflow-level 'read' alone does not bound the capture's token.
    for (const [id, job] of Object.entries(doc.jobs)) {
      for (const scope of Object.values(job.permissions ?? {})) {
        assert.ok(
          scope === 'read' || scope === 'none',
          `job ${id} must not widen its token beyond read/none`,
        );
      }
    }
    // The pool half of the nodejs.org split (the tui-parity shape): the
    // hosted setup-node download and pnpm cache stay hosted-only, the pool
    // reuses the image's Node behind the preflight, and the disk floor
    // fails fast before two full installs on a shared host.
    const steps = doc.jobs.capture.steps;
    const hostedOnly = steps.filter(
      (s) =>
        String(s.uses || '').startsWith('actions/setup-node') ||
        s.uses === './.github/actions/pnpm-store-cache',
    );
    assert.equal(hostedOnly.length, 2);
    for (const s of hostedOnly) {
      assert.equal(s.if, "${{ runner.environment == 'github-hosted' }}");
    }
    const preflight = steps.find(
      (s) => s.uses === './.github/actions/self-hosted-node',
    );
    assert.equal(preflight?.if, "${{ runner.environment == 'self-hosted' }}");
    const diskFloor = steps.find((s) =>
      String(s.run || '').includes('check-disk-floor.sh'),
    );
    assert.equal(diskFloor?.if, "${{ runner.environment == 'self-hosted' }}");
    // The shared 2 GiB default passed a slot with 14.6 GB free / 89% used
    // and pnpm died on ENOSPC minutes later (run 42478651795). This lane
    // carries its own floor AND a percent ceiling that refuses that shape;
    // deleting either override must red this pin.
    assert.equal(diskFloor?.env?.DISK_FLOOR_MIN_FREE_KB, '8388608');
    assert.ok(
      Number(diskFloor?.env?.DISK_FLOOR_MAX_USED_PCT) < 89,
      'the ceiling must refuse the measured 89%-used failure slot',
    );
    // The pool pays two cold installs (measured: 22m18s install,
    // Chromium still downloading at 36m48s), so the hosted 45-minute cap
    // cancels the job before any render. The ceiling is routed like
    // runs-on — runner.environment is not available in timeout-minutes —
    // keyed off the same switch term: pool (not disabled) 90, else 45.
    assert.equal(
      String(doc.jobs.capture['timeout-minutes']),
      "${{ vars.MAINTAINER_ECS_RUNNER_DISABLED != 'true' && 90 || 45 }}",
    );
    // Unpinned workers size Chromium from the HOST's cores inside a 4-CPU
    // container: the first pooled run lost its runner to CPU/memory
    // starvation mid-render (run 42494910412). Both render passes must
    // carry the smoke lane's --workers=2.
    const renders = steps.filter((s) =>
      String(s.run || '').includes('test:e2e:visuals'),
    );
    assert.equal(renders.length, 2);
    for (const s of renders) {
      assert.match(String(s.run), /--workers=2/);
    }
    // The slim image needs the DejaVu baseline and ffmpeg at runtime; the
    // install must stay best-effort so its own failure degrades the
    // preview instead of sinking it. Pin the WHOLE package list: the
    // warning prose also says "ffmpeg", and re-adding fonts-dejavu-mono
    // (no bookworm build) fails the entire apt transaction — a mutation
    // that survived every earlier revision of this suite.
    const fonts = steps.find((s) =>
      String(s.run || '').includes('fonts-dejavu-core'),
    );
    assert.equal(fonts?.if, "${{ runner.environment == 'self-hosted' }}");
    assert.match(
      String(fonts.run),
      /apt-get install -y --no-install-recommends fonts-dejavu-core ffmpeg; then/,
    );
    assert.ok(
      !String(fonts.run).includes('fonts-dejavu-mono'),
      'fonts-dejavu-mono has no bookworm build and sinks the transaction',
    );
    // Bounded apt calls: a blackholed mirror must land in the warning
    // branch, not hang until the job cap (Acquire::* + lock timeout, the
    // pooled-apt convention). And verify the baseline after installing —
    // a half-applied transaction otherwise renders drifted shots green.
    assert.match(String(fonts.run), /Acquire::http::Timeout/);
    assert.match(String(fonts.run), /DPkg::Lock::Timeout/);
    assert.match(String(fonts.run), /fc-match[^\n]*sans-serif/);
    assert.match(String(fonts.run), /fc-match[^\n]*monospace/);
    // The step carries no continue-on-error: what keeps a failed install from
    // sinking the job is the shell guard, and the warning has to sit in that
    // guard's failure branch (`else` today, `||` would do). Asserting only
    // /::warning:: would pin the prose, not the degradation path.
    assert.match(
      String(fonts.run),
      /(?:else\s*\n\s*|\|\|\s*)echo "::warning::/,
    );
  });

  it('web-shell-managed-host.yml build: only PR events ride the disposable pool', () => {
    // Same credential-free boundary as the capture, but this lane also runs on
    // post-merge push and manual dispatch, and those witnesses must stay
    // hosted. Assert the effect per event rather than comparing the selector
    // text to a copy of itself: flipping the event term and updating a pinned
    // literal in the same commit leaves a text-only pin green. The pool label
    // comes from the same config the capture case reads, so a config-only
    // rename reds this lane too instead of leaving it requesting a label no
    // runner advertises.
    const doc = parse(
      readFileSync(join(workflowsDir, 'web-shell-managed-host.yml'), 'utf8'),
    );
    const runsOn = String(doc.jobs.build['runs-on']);
    for (const eventName of ['push', 'workflow_dispatch', 'merge_group']) {
      for (const ecsDisabled of [false, true]) {
        assert.deepEqual(
          evalRunsOn(runsOn, { eventName, ecsDisabled, sameRepo: true }),
          JSON.parse(HOSTED),
          `managed-host ${eventName} must stay hosted ecsDisabled=${ecsDisabled}`,
        );
      }
    }
    // The selector carries no sameRepo term: same-repository and fork PRs are
    // both PR events, so pin both arms instead of only the same-repo one.
    for (const sameRepo of [true, false]) {
      assert.deepEqual(
        evalRunsOn(runsOn, {
          eventName: 'pull_request',
          ecsDisabled: false,
          sameRepo,
        }),
        EPHEMERAL,
        `managed-host PR builds ride the disposable pool sameRepo=${sameRepo}`,
      );
      assert.deepEqual(
        evalRunsOn(runsOn, {
          eventName: 'pull_request',
          ecsDisabled: true,
          sameRepo,
        }),
        JSON.parse(HOSTED),
        `kill-switch must revert managed-host PR builds to hosted sameRepo=${sameRepo}`,
      );
    }
  });
});

describe('ci.yml web_shell_e2e_smoke runner routing', () => {
  const expression = String(ciDoc.jobs.web_shell_e2e_smoke['runs-on'])
    .replace(/^\$\{\{\s*/, '')
    .replace(/\s*\}\}$/, '');
  const selectSmokeRunner = new Function(
    'needs',
    'fromJSON',
    'contains',
    `return (${expression});`,
  );

  it('uses ARM64 for self-hosted runs while preserving every hosted fallback', () => {
    for (const ecsDisabled of [false, true]) {
      for (const fleet of ['', 'x64', 'arm64', 'hosted']) {
        for (const sameRepo of [false, true]) {
          for (const assoc of ASSOCIATIONS) {
            for (const dispatch of [
              undefined,
              'self-hosted',
              'self-hosted-arm64',
              'hosted',
            ]) {
              const runner = runPickRunner({
                ecsDisabled,
                fleet,
                sameRepo,
                assoc,
                dispatch,
                eventName: dispatch ? 'workflow_dispatch' : 'pull_request',
              });
              assert.deepEqual(
                selectSmokeRunner(
                  { classify_pr: { outputs: { ubuntu_runner: runner } } },
                  JSON.parse,
                  (labels, label) => labels.includes(label),
                ),
                JSON.parse(runner).includes('self-hosted')
                  ? ['self-hosted', 'linux', 'arm64']
                  : JSON.parse(HOSTED),
                JSON.stringify({
                  ecsDisabled,
                  fleet,
                  sameRepo,
                  assoc,
                  dispatch,
                  runner,
                }),
              );
            }
          }
        }
      }
    }
  });

  it('stays hosted when the classifier output is missing', () => {
    assert.deepEqual(
      selectSmokeRunner(
        { classify_pr: { outputs: {} } },
        JSON.parse,
        (labels, label) => labels.includes(label),
      ),
      JSON.parse(HOSTED),
    );
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

describe('trusted-PR lanes moved off the hosted queue (#13245)', () => {
  // Each lane reaches the pool for in-repo heads, write-access authors and
  // its non-PR triggers; an untrusted fork stays hosted (these either build
  // PR code or hold a write token), and the kill-switch wins everywhere.
  const ECS_LABELS = ['self-hosted', 'linux', 'x64', 'ecs-qwen'];
  const HOSTED_LABELS = ['ubuntu-latest'];
  const lanes = [
    ['tui-parity.yml', 'parity', 'pull_request', ['workflow_dispatch']],
    ['tui-parity.yml', 'noflicker', 'pull_request', ['workflow_dispatch']],
    [
      'sdk-java.yml',
      'flyway-migrations',
      'pull_request',
      ['push', 'workflow_dispatch'],
    ],
    // managed-agent-gate.yml calls sdk-java.yml on an approval, whose event
    // a fork PR can raise too: approving one must not put it on the pool.
    [
      'sdk-java.yml',
      'mysql-integration',
      'pull_request_review',
      ['push', 'merge_group', 'workflow_dispatch'],
    ],
    // The gate's own jobs report the would-be required check, so a starved
    // hosted queue must not hold them; fork PRs and fork approvals stay hosted.
    [
      'managed-agent-gate.yml',
      'scope',
      'pull_request',
      ['push', 'merge_group'],
    ],
    [
      'managed-agent-gate.yml',
      'scope',
      'pull_request_review',
      ['push', 'merge_group'],
    ],
    [
      'sdk-java.yml',
      'event-transport-broker',
      'pull_request',
      ['schedule', 'workflow_dispatch'],
    ],
    [
      'sdk-java.yml',
      'event-transport-multi-node',
      'pull_request',
      ['schedule', 'workflow_dispatch'],
    ],
    // Both gate lanes also run in the gate's approval-triggered full tier.
    [
      'sdk-java.yml',
      'event-transport-broker',
      'pull_request_review',
      ['schedule', 'workflow_dispatch'],
    ],
    [
      'sdk-java.yml',
      'event-transport-multi-node',
      'pull_request_review',
      ['schedule', 'workflow_dispatch'],
    ],
    [
      'assign-pr-owner.yml',
      'assign',
      'pull_request_target',
      ['workflow_dispatch'],
    ],
  ];

  for (const [file, jobName, prEvent, otherEvents] of lanes) {
    const doc = parse(readFileSync(join(workflowsDir, file), 'utf8'));
    const job = doc.jobs[jobName];
    const runsOn = String(job['runs-on']);
    const route = (eventName, sameRepo, assoc, ecsDisabled = false) =>
      evalRunsOn(runsOn, { ecsDisabled, eventName, sameRepo, assoc });

    it(`${file} ${jobName}: trusted PRs and non-PR triggers reach the pool`, () => {
      assert.match(runsOn, /github\.repository == 'QwenLM\/qwen-code'/);
      assert.deepEqual(route(prEvent, true, 'NONE'), ECS_LABELS);
      for (const assoc of TRUSTED) {
        assert.deepEqual(route(prEvent, false, assoc), ECS_LABELS, assoc);
      }
      for (const eventName of otherEvents) {
        assert.deepEqual(route(eventName, false, ''), ECS_LABELS, eventName);
      }
    });

    it(`${file} ${jobName}: untrusted forks stay hosted`, () => {
      for (const assoc of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE']) {
        assert.deepEqual(route(prEvent, false, assoc), HOSTED_LABELS, assoc);
      }
    });

    it(`${file} ${jobName}: the kill-switch wins on every event`, () => {
      for (const eventName of [prEvent, ...otherEvents]) {
        assert.deepEqual(
          route(eventName, true, 'OWNER', true),
          HOSTED_LABELS,
          eventName,
        );
      }
    });

    it(`${file} ${jobName}: restores pool workspace ownership before checkout`, () => {
      const names = job.steps.map((s) => s.name);
      const heal = names.indexOf('Restore workspace ownership');
      const checkout = job.steps.findIndex((s) =>
        String(s.uses || '').startsWith('actions/checkout'),
      );
      assert.ok(heal !== -1 && heal < checkout);
      assert.equal(
        job.steps[heal].if,
        "${{ runner.environment == 'self-hosted' }}",
      );
    });
  }

  it('release-managed-agent-reference.yml build: only trusted PR dry runs reach the pool', () => {
    const doc = parse(
      readFileSync(
        join(workflowsDir, 'release-managed-agent-reference.yml'),
        'utf8',
      ),
    );
    const runsOn = String(doc.jobs.build['runs-on']);
    const route = (eventName, sameRepo, assoc, ecsDisabled = false) =>
      evalRunsOn(runsOn, { ecsDisabled, eventName, sameRepo, assoc });
    assert.deepEqual(route('pull_request', true, 'NONE'), ECS_LABELS);
    for (const assoc of TRUSTED) {
      assert.deepEqual(route('pull_request', false, assoc), ECS_LABELS, assoc);
    }
    for (const assoc of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE']) {
      assert.deepEqual(route('pull_request', false, assoc), HOSTED_LABELS);
    }
    // The dispatch build produces the published assets.
    assert.deepEqual(route('workflow_dispatch', true, ''), HOSTED_LABELS);
    assert.deepEqual(route('pull_request', true, 'OWNER', true), HOSTED_LABELS);
    assert.equal(doc.jobs.publish['runs-on'], 'ubuntu-latest');
  });

  it('release-managed-agent-reference.yml build is safe on a shared pool host', () => {
    const text = readFileSync(
      join(workflowsDir, 'release-managed-agent-reference.yml'),
      'utf8',
    );
    const build = parse(text).jobs.build;
    // A service container cannot take a command, so it always reserves native
    // AIO contexts and can exhaust the pool host's fs.aio-max-nr (#14416).
    assert.equal(build.services, undefined);
    const start = build.steps.find(
      (s) => s.name === 'Start MySQL without native AIO',
    );
    assert.match(start.run, /--publish '127\.0\.0\.1::3306'/);
    assert.match(start.run, /type=tmpfs,destination=\/var\/lib\/mysql/);
    assert.match(start.run, /--innodb-use-native-aio=0/);
    assert.match(start.run, /MYSQL_PORT=.*GITHUB_ENV/);
    const remove = build.steps.find(
      (s) => s.name === 'Remove the MySQL container',
    );
    assert.match(remove.if, /always\(\)/);
    const run = (name) => build.steps.find((s) => s.name === name).run;
    const buildJava = run('Build Java components');
    assert.match(buildJava, /-Dmaven\.repo\.local=/);
    assert.match(buildJava, /find "\$\{repo\}" -depth -type d/);
    assert.match(
      buildJava,
      /-path '\*\/com\/alibaba\/qwencode-sdk' -o -path '\*\/com\/alibaba\/qwen-managed-agent-\*'/,
    );
    assert.match(buildJava, /-exec rm -rf \{\} \+/);
    assert.match(
      run('Assemble reference distribution'),
      /rm -rf -- "\$\{RUNNER_TEMP\}\/managed-agent-reference"\n\s*node scripts\/package-managed-agent-reference\.mjs/,
    );
    const boot = run('Verify and boot the exact archive');
    assert.match(boot, /SERVER_PORT="\$\{server_port\}"/);
    assert.doesNotMatch(boot, /:8080|:3306\//);
    const setupNode = build.steps.find((s) =>
      String(s.uses || '').startsWith('actions/setup-node'),
    );
    assert.equal(setupNode.if, "${{ runner.environment == 'github-hosted' }}");
    const setupJava = build.steps.find((s) =>
      String(s.uses || '').startsWith('actions/setup-java'),
    );
    const cache = setupJava.with.cache;
    for (const [environment, expected] of [
      ['github-hosted', 'maven'],
      ['self-hosted', ''],
    ]) {
      const actual = cache.startsWith('${{')
        ? new Function('runner', `return (${cache.slice(3, -2)});`)({
            environment,
          })
        : cache;
      assert.equal(actual, expected, environment);
    }
  });

  it('tui-parity keeps setup-node and the pnpm cache off the pool', () => {
    // nodejs.org may be unreachable through the pool's egress proxy, and the
    // pool keeps its pnpm store on local disk — the ci.yml split.
    const doc = parse(
      readFileSync(join(workflowsDir, 'tui-parity.yml'), 'utf8'),
    );
    for (const jobName of ['parity', 'noflicker']) {
      const steps = doc.jobs[jobName].steps;
      const hostedOnly = steps.filter(
        (s) =>
          String(s.uses || '').startsWith('actions/setup-node') ||
          s.uses === './.github/actions/pnpm-store-cache',
      );
      assert.equal(hostedOnly.length, 2, jobName);
      for (const s of hostedOnly) {
        assert.equal(s.if, "${{ runner.environment == 'github-hosted' }}");
      }
      const preflight = steps.find(
        (s) => s.uses === './.github/actions/self-hosted-node',
      );
      assert.equal(preflight?.if, "${{ runner.environment == 'self-hosted' }}");
      assert.ok(
        steps.some((s) => String(s.run || '').includes('check-disk-floor.sh')),
        `${jobName} must fail fast on a saturated host`,
      );
    }
    // accept-noflicker.sh defaults its report to a fixed /tmp path; one ECS
    // host runs many jobs at once, so the report must be runner-scoped.
    const gate = doc.jobs.noflicker.steps.find((s) =>
      String(s.run || '').includes('accept-noflicker.sh'),
    );
    assert.equal(gate.env?.OUT, '${{ runner.temp }}/opentui-noflicker-out');
  });

  it('tui-parity changes gate is routed like the lanes it guards', () => {
    // The changes job is the door to parity/noflicker: a 40-minute hosted
    // queue wait behind it starves two pool-routed lanes. Route it like them;
    // it runs no checkout, so the workspace-restore pin does not apply.
    const doc = parse(
      readFileSync(join(workflowsDir, 'tui-parity.yml'), 'utf8'),
    );
    const job = doc.jobs.changes;
    const runsOn = String(job['runs-on']);
    const route = (eventName, sameRepo, assoc, ecsDisabled = false) =>
      evalRunsOn(runsOn, { ecsDisabled, eventName, sameRepo, assoc });
    assert.match(runsOn, /github\.repository == 'QwenLM\/qwen-code'/);
    assert.deepEqual(route('pull_request', true, 'NONE'), ECS_LABELS);
    for (const assoc of TRUSTED) {
      assert.deepEqual(route('pull_request', false, assoc), ECS_LABELS, assoc);
    }
    assert.deepEqual(route('workflow_dispatch', false, ''), ECS_LABELS);
    for (const assoc of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE']) {
      assert.deepEqual(
        route('pull_request', false, assoc),
        HOSTED_LABELS,
        assoc,
      );
    }
    for (const eventName of ['pull_request', 'workflow_dispatch']) {
      assert.deepEqual(
        route(eventName, true, 'OWNER', true),
        HOSTED_LABELS,
        eventName,
      );
    }
    // Byte-identity with the lanes it guards is this change's own acceptance
    // criterion: the gate is their door, so drift here is what re-starves
    // them behind a hosted queue.
    for (const lane of ['parity', 'noflicker']) {
      assert.equal(
        runsOn,
        String(doc.jobs[lane]['runs-on']),
        `the gate must be routed by the same expression as ${lane}`,
      );
    }
    // Any added step would run on the reused pool workspace with no hygiene
    // step before it, so the whole step list is pinned, not just checkouts.
    assert.deepEqual(
      job.steps.map((s) => s.uses),
      ['actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3'],
      'changes gate must stay checkout-free and shell-free; adding a step re-adds the pool-hygiene requirement',
    );
  });
});

describe('control-plane jobs moved off the hosted queue', () => {
  // None of these checks out or runs PR code, so each reaches the pool on
  // every trigger, fork-raised events included; the kill-switch wins.
  const ECS_LABELS = ['self-hosted', 'linux', 'x64', 'ecs-qwen'];
  const HOSTED_LABELS = ['ubuntu-latest'];
  const jobs = [
    [
      'qwen-code-pr-review.yml',
      'delay-automatic-review',
      ['pull_request_target'],
    ],
    ['assign-issue-owner.yml', 'assign', ['issues', 'workflow_dispatch']],
    [
      'auto-minimize-spam.yml',
      'minimize',
      [
        'issue_comment',
        'pull_request_review_comment',
        'schedule',
        'push',
        'workflow_dispatch',
      ],
    ],
  ];

  for (const [file, jobName, events] of jobs) {
    const job = parse(readFileSync(join(workflowsDir, file), 'utf8')).jobs[
      jobName
    ];
    const runsOn = String(job['runs-on']);
    const route = (eventName, assoc, ecsDisabled = false) =>
      evalRunsOn(runsOn, { ecsDisabled, eventName, sameRepo: false, assoc });
    const checkouts = job.steps.filter((s) =>
      String(s.uses || '').startsWith('actions/checkout'),
    );

    it(`${file} ${jobName}: every trigger reaches the pool, forks included`, () => {
      assert.match(runsOn, /github\.repository == 'QwenLM\/qwen-code'/);
      for (const eventName of events) {
        for (const assoc of ASSOCIATIONS) {
          assert.deepEqual(route(eventName, assoc), ECS_LABELS, eventName);
        }
      }
    });

    it(`${file} ${jobName}: the kill-switch wins on every event`, () => {
      for (const eventName of events) {
        assert.deepEqual(route(eventName, 'OWNER', true), HOSTED_LABELS);
      }
    });

    it(`${file} ${jobName}: checks out only the default branch`, () => {
      // An omitted ref is the default branch on issues events and the
      // write-access dispatcher's choice on workflow_dispatch.
      for (const step of checkouts) {
        assert.ok(
          [undefined, '${{ github.event.repository.default_branch }}'].includes(
            step.with?.ref,
          ),
          String(step.with?.ref),
        );
      }
    });

    if (checkouts.length > 0) {
      it(`${file} ${jobName}: checkout is safe on a reused pool workspace`, () => {
        const heal = job.steps.findIndex(
          (s) => s.name === 'Restore workspace ownership',
        );
        assert.ok(heal !== -1 && heal < job.steps.indexOf(checkouts[0]));
        assert.equal(
          job.steps[heal].if,
          "${{ runner.environment == 'self-hosted' }}",
        );
        // Cone mode rejects a file entry the reused index holds as a file,
        // and a reused workspace can inherit non-cone mode from another
        // job, so the pattern must cover the owner map under either mode.
        for (const step of checkouts) {
          assert.equal(step.with['sparse-checkout'], '.github');
          assert.equal(step.with['sparse-checkout-cone-mode'], undefined);
        }
      });
    }
  }
});

describe('credential-free release fanout routing (#15465)', () => {
  const reference = parse(
    readFileSync(join(workflowsDir, 'repo-hygiene.yml'), 'utf8'),
  ).jobs.dedup['runs-on'];
  it('keeps the Desktop reusable caller limited to schedule and dispatch', () => {
    const caller = parse(
      readFileSync(join(workflowsDir, 'desktop-packaging-check.yml'), 'utf8'),
    );
    assert.deepEqual(Object.keys(caller.on).sort(), [
      'schedule',
      'workflow_dispatch',
    ]);
    assert.equal(
      caller.jobs.package.uses,
      './.github/workflows/desktop-release.yml',
    );
  });
  for (const [file, jobId, events] of [
    ['desktop-release.yml', 'prepare', ['release', 'workflow_dispatch']],
    ['live-host-release.yml', 'prepare', ['workflow_dispatch']],
    [
      'dsw-swe-verified-release.yml',
      'release_gate',
      ['release', 'workflow_dispatch'],
    ],
    [
      'release-managed-runtime.yml',
      'prepare',
      ['release', 'workflow_dispatch'],
    ],
  ]) {
    const doc = parse(readFileSync(join(workflowsDir, file), 'utf8'));
    const job = doc.jobs[jobId];
    const expression = job['runs-on'];
    it(`${file}: routes release preparation to ECS with hosted fallbacks`, () => {
      assert.equal(
        expression,
        file === 'live-host-release.yml'
          ? reference.replace(
              "vars.MAINTAINER_ECS_RUNNER_DISABLED != 'true'",
              "vars.MAINTAINER_ECS_RUNNER_DISABLED != 'true' && github.event_name != 'pull_request'",
            )
          : reference,
      );
      for (const eventName of events) {
        assert.ok(Object.hasOwn(doc.on, eventName));
        assert.deepEqual(
          evalRunsOn(expression, { eventName, ecsDisabled: false }),
          JSON.parse(ECS),
        );
        assert.deepEqual(
          evalRunsOn(expression, { eventName, ecsDisabled: true }),
          JSON.parse(HOSTED),
        );
        assert.deepEqual(
          evalRunsOn(
            expression.replace(
              "github.repository == 'QwenLM/qwen-code'",
              'false',
            ),
            { eventName, ecsDisabled: false },
          ),
          JSON.parse(HOSTED),
        );
      }
    });
    it(`${file}: keeps release secrets and PR execution outside this migration`, () => {
      assert.doesNotMatch(JSON.stringify([doc.env, job]), /secrets(?:\.|\[)/);
      assert.equal(job.environment, undefined);
      assert.equal((job.permissions ?? doc.permissions).contents, 'read');
      assert.doesNotMatch(
        expression,
        /ECS_RELEASE_HOST_RUNNER_ENABLED|ecs-qwen-release-host/,
      );
      if (file === 'live-host-release.yml') {
        assert.ok(Object.hasOwn(doc.on, 'pull_request'));
        assert.deepEqual(
          evalRunsOn(expression, {
            eventName: 'pull_request',
            ecsDisabled: false,
            sameRepo: true,
            assoc: 'OWNER',
          }),
          JSON.parse(HOSTED),
        );
        assert.deepEqual(
          evalRunsOn(expression, {
            eventName: 'pull_request',
            ecsDisabled: false,
            sameRepo: false,
            assoc: 'NONE',
          }),
          JSON.parse(HOSTED),
        );
      } else {
        assert.ok(
          !Object.keys(doc.on).some((event) =>
            event.startsWith('pull_request'),
          ),
        );
      }
    });
  }
});

// The patrol holds CI_BOT_PAT and runs a sandboxed agent, so its routing is
// evaluated here rather than left to substring pins: `== 'true'` contains
// every term a `includes("!= 'true'")` style assertion looks for, and an
// inverted kill switch would send every round to the pool it just disabled.
describe('CI failure patrol routing (#16462)', () => {
  const doc = parse(
    readFileSync(join(workflowsDir, 'qwen-ci-flaky-rerun.yml'), 'utf8'),
  );
  const events = Object.keys(doc.on);
  it('reaches the pool only for this repository with the switch off', () => {
    assert.deepEqual(events.sort(), ['schedule', 'workflow_dispatch']);
    for (const jobName of ['classify', 'act']) {
      const expression = doc.jobs[jobName]['runs-on'];
      for (const eventName of events) {
        assert.deepEqual(
          evalRunsOn(expression, { eventName, ecsDisabled: false }),
          JSON.parse(ECS),
          `${jobName} on ${eventName} with the fleet enabled`,
        );
        assert.deepEqual(
          evalRunsOn(expression, { eventName, ecsDisabled: true }),
          JSON.parse(HOSTED),
          `${jobName} on ${eventName} with the fleet disabled`,
        );
        assert.deepEqual(
          evalRunsOn(
            expression.replace(
              "github.repository == 'QwenLM/qwen-code'",
              'false',
            ),
            { eventName, ecsDisabled: false },
          ),
          JSON.parse(HOSTED),
          `${jobName} on ${eventName} in a fork`,
        );
      }
    }
  });
});
