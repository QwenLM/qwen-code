// Runner-routing regression guards for ci.yml, serve-ab.yml, and the
// qwen-autofix.yml scan lane.
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
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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
const visualsDoc = parse(
  readFileSync(join(workflowsDir, 'web-shell-visuals.yml'), 'utf8'),
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
// The visuals parse and job dereference sit at module load, not inside a
// describe callback: on Node 22 a throw there reports zero failures and
// exits 0, silently darkening every guard below; here the same throw fails
// module load and exits 1.
const visualsCaptureJob = visualsDoc.jobs.capture;
const visualsCaptureRunsOn = String(visualsCaptureJob['runs-on']);

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

// Resolves a host executable by walking PATH. The exec tests below give the
// step a stub-only PATH, and spawnSync resolves the spawned command against
// that CHILD path, so the real bash and scan tools must be pinned by
// absolute path.
function hostToolPath(name) {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) {
      continue;
    }
    const candidate = join(dir, name);
    const stats = statSync(candidate, { throwIfNoEntry: false });
    if (stats && (stats.mode & 0o111) !== 0) {
      return candidate;
    }
  }
  return null;
}

function writeStub(dir, name, lines) {
  const file = join(dir, name);
  writeFileSync(file, `${lines.join('\n')}\n`);
  chmodSync(file, 0o755);
}

// Executes the REAL 'Install Playwright Chromium' step under GitHub's
// default bash wrapper with apt-get absent from PATH, so the non-apt lane
// runs. Its external world is stubbed: npx/sudo/dnf/yum/ldd are scripts in
// a stub dir, the browser tree is a real tmp ${HOME}, and machine state is
// a file the dnf/yum stubs write — the same side effect a real provision
// has. machine: 'provisioned' — every library resolves before the first
// scan; 'provisionable' — the first scan finds missing libraries and dnf
// fixes them; 'unprovisionable' — nothing resolves and dnf/yum both fail.
function runInstallStep(machine) {
  const install = visualsCaptureJob.steps.find(
    (s) => s.name === 'Install Playwright Chromium',
  );
  assert.ok(install, 'the Playwright install step must exist');
  const bashPath = hostToolPath('bash');
  assert.ok(bashPath, 'bash must be resolvable to execute the step');
  const root = mkdtempSync(join(tmpdir(), 'visuals-install-'));
  try {
    const stubDir = join(root, 'stubs');
    const binDir = join(root, 'bin');
    const stubState = join(root, 'stub-state');
    for (const dir of [stubDir, binDir, stubState]) {
      mkdirSync(dir);
    }
    for (const tool of ['grep', 'sort', 'find']) {
      const toolPath = hostToolPath(tool);
      assert.ok(toolPath, `${tool} must be resolvable for the scan pipeline`);
      symlinkSync(toolPath, join(binDir, tool));
    }
    writeStub(stubDir, 'npx', [
      '#!/bin/sh',
      'printf \'npx %s\\n\' "$*" >> "$STUB_DIR/calls.log"',
    ]);
    writeStub(stubDir, 'sudo', [
      '#!/bin/sh',
      'printf \'sudo %s\\n\' "$*" >> "$STUB_DIR/calls.log"',
      'while [ $# -gt 0 ]; do case "$1" in -*) shift ;; *) break ;; esac; done',
      'exec "$@"',
    ]);
    for (const tool of ['dnf', 'yum']) {
      writeStub(stubDir, tool, [
        '#!/bin/sh',
        `printf '${tool} %s\\n' "$*" >> "$STUB_DIR/calls.log"`,
        '[ "$STUB_PROVISION" = ok ] || exit 1',
        'printf \'provisioned\\n\' > "$STUB_DIR/state"',
      ]);
    }
    writeStub(stubDir, 'ldd', [
      '#!/bin/sh',
      "state=''",
      '[ -f "$STUB_DIR/state" ] && read -r state < "$STUB_DIR/state"',
      '[ "$state" = provisioned ] && exit 0',
      'case "$1" in *chrome*) printf \'\\tlibnss3.so => not found\\n\' ;; esac',
    ]);
    const fakeHome = join(root, 'home');
    const browserDir = join(
      fakeHome,
      '.cache',
      'ms-playwright',
      'chromium-1187',
    );
    mkdirSync(browserDir, { recursive: true });
    for (const bin of ['headless_shell', 'chrome']) {
      const file = join(browserDir, bin);
      writeFileSync(file, '#!/bin/sh\n');
      chmodSync(file, 0o755);
    }
    if (machine === 'provisioned') {
      writeFileSync(join(stubState, 'state'), 'provisioned\n');
    }
    const result = spawnSync(
      bashPath,
      ['--noprofile', '--norc', '-eo', 'pipefail', '-c', install.run],
      {
        env: {
          PATH: `${stubDir}:${binDir}`,
          HOME: fakeHome,
          STUB_DIR: stubState,
          STUB_PROVISION: machine === 'provisionable' ? 'ok' : 'fail',
        },
        encoding: 'utf8',
      },
    );
    const callsFile = join(stubState, 'calls.log');
    const calls = existsSync(callsFile) ? readFileSync(callsFile, 'utf8') : '';
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      calls,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

describe('web-shell-visuals.yml capture runner routing', () => {
  // The capture job builds and renders PR code, so it follows the fleet's
  // trust split exactly as serve-ab does: same-repo PRs and write-access
  // fork authors reach the persistent pool, every other fork PR keeps the
  // ephemeral hosted runner, and the kill-switch forces everything hosted.
  // evalRunsOn unwraps the winning fromJSON label to the array it names.
  const ECS_LABELS = ['self-hosted', 'linux', 'x64', 'ecs-qwen'];
  const HOSTED_LABELS = ['ubuntu-latest'];

  it('routes pull requests by fork trust', () => {
    assert.deepEqual(
      evalRunsOn(visualsCaptureRunsOn, {
        ecsDisabled: false,
        eventName: 'pull_request',
        sameRepo: true,
        assoc: 'NONE',
      }),
      ECS_LABELS,
      'same-repo PRs must render on the pool',
    );
    assert.deepEqual(
      evalRunsOn(visualsCaptureRunsOn, {
        ecsDisabled: false,
        eventName: 'pull_request',
        sameRepo: false,
        assoc: 'MEMBER',
      }),
      ECS_LABELS,
      'write-access fork authors must render on the pool',
    );
    for (const assoc of ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'NONE', '']) {
      assert.deepEqual(
        evalRunsOn(visualsCaptureRunsOn, {
          ecsDisabled: false,
          eventName: 'pull_request',
          sameRepo: false,
          assoc,
        }),
        HOSTED_LABELS,
        `assoc '${assoc}' fork PRs must stay on ephemeral hosted runners`,
      );
    }
  });

  it('obeys the kill-switch', () => {
    assert.deepEqual(
      evalRunsOn(visualsCaptureRunsOn, {
        ecsDisabled: true,
        eventName: 'pull_request',
        sameRepo: true,
        assoc: 'OWNER',
      }),
      HOSTED_LABELS,
      'kill-switch must force the capture back to hosted',
    );
  });

  it('matches serve-ab routing byte for byte', () => {
    // One trust split, one edit site: a clause change on either side must
    // touch both or fail here.
    assert.equal(visualsCaptureRunsOn, String(serveAbDoc.jobs.ab['runs-on']));
  });

  it('clears stale capture dirs before any capture', () => {
    // On the persistent pool ${RUNNER_TEMP} outlives a run (see serve-ab.yml's
    // step of the same name): a leftover capture set from an earlier run would
    // be composited and uploaded as this run's preview, or silently become its
    // diff baseline. Unconditional — hosted runners get a fresh temp, so it is
    // a no-op there.
    const steps = visualsCaptureJob.steps;
    const clear = steps.findIndex((s) => s.name === 'Clear stale capture dirs');
    assert.ok(clear !== -1, 'the stale-capture clear must exist');
    assert.ok(
      !('if' in steps[clear]),
      'the clear must run on BOTH lanes, not only the pool',
    );
    assert.ok(
      !('continue-on-error' in steps[clear]),
      'a failed clear must fail the job, not publish a leaked preview',
    );
    assert.match(
      steps[clear].run,
      /rm -rf "\$\{RUNNER_TEMP\}\/web-shell-visuals" "\$\{RUNNER_TEMP\}\/web-shell-before"/,
      'the clear must remove BOTH the after and the before capture trees',
    );
    const afterCapture = steps.findIndex((s) => s.id === 'after_capture');
    const beforeCapture = steps.findIndex(
      (s) => s.name === 'Capture before (base) screenshots',
    );
    assert.ok(
      afterCapture !== -1 && beforeCapture !== -1,
      'both capture steps must exist',
    );
    assert.ok(
      clear < afterCapture && clear < beforeCapture,
      'the clear must precede every capture that writes those trees',
    );
  });

  it('heals workspace ownership before the first checkout', () => {
    const steps = visualsCaptureJob.steps;
    const heal = steps.findIndex(
      (s) => s.name === 'Restore workspace ownership',
    );
    const checkout = steps.findIndex((s) =>
      String(s.uses || '').startsWith('actions/checkout'),
    );
    assert.ok(heal !== -1, 'the ownership heal must exist');
    assert.equal(steps[heal].if, "${{ runner.environment == 'self-hosted' }}");
    assert.match(steps[heal].run, /chown -R .* "\$GITHUB_WORKSPACE"/);
    assert.ok(heal < checkout, 'the heal must precede the checkout');
  });

  it('keeps the capture job free of ambient secrets', () => {
    // The security-model header promises the render job holds no secrets of
    // its own; the merge-base resolve step's read-only GITHUB_TOKEN is the
    // one permitted exception. Every expression-interpolating surface is
    // scanned — step env, with inputs, run text, and job- and workflow-level
    // env — a step-env-only scan lets a secret passed through any other
    // surface slip past.
    const surfaces = visualsCaptureJob.steps.flatMap((step) =>
      [
        ...Object.values(step.env ?? {}),
        ...Object.values(step.with ?? {}),
        step.run,
      ].map((value) => [`step '${step.name}'`, value]),
    );
    surfaces.push(
      ...Object.values(visualsCaptureJob.env ?? {}).map((value) => [
        'job-level env',
        value,
      ]),
      ...Object.values(visualsDoc.env ?? {}).map((value) => [
        'workflow-level env',
        value,
      ]),
    );
    for (const [where, value] of surfaces) {
      const refs = String(value ?? '').match(/secrets\.[A-Za-z_]+/g) ?? [];
      for (const ref of refs) {
        assert.equal(
          ref,
          'secrets.GITHUB_TOKEN',
          `capture ${where} references ${ref}; the render side must stay secret-free`,
        );
      }
    }
  });

  it('keeps setup-node off the pool', () => {
    // The action's post step uploads the npm cache to GitHub; on the
    // pool's slow egress that save ran 14+ minutes and timed out
    // security-checks' first pool run (2026-08-26). Hosted keeps the
    // action; the pool reuses the machine's Node and its persistent npm
    // cache, exactly as ci.yml does.
    const setup = visualsCaptureJob.steps.find((s) =>
      String(s.uses || '').startsWith('actions/setup-node'),
    );
    assert.ok(setup, 'the hosted setup-node step must exist');
    assert.equal(setup.if, "${{ runner.environment == 'github-hosted' }}");
    const preflight = visualsCaptureJob.steps.find(
      (s) => s.uses === './.github/actions/self-hosted-node',
    );
    assert.ok(preflight, 'the pool lane must use the pre-installed Node');
    assert.equal(preflight.if, "${{ runner.environment == 'self-hosted' }}");
  });

  it('keeps the install step wired into the job', () => {
    // The exec tests below run the step's non-apt lane in isolation; these
    // are the job-level facts no isolated run can see: the lane resolves
    // Playwright from the repo lockfile (a registry download would pair a
    // different browser revision with the lockfile's), runs before the
    // capture it serves, and its failure fails the job.
    const steps = visualsCaptureJob.steps;
    const install = steps.findIndex(
      (s) => s.name === 'Install Playwright Chromium',
    );
    const npmCi = steps.findIndex((s) => s.name === 'Install dependencies');
    const afterCapture = steps.findIndex((s) => s.id === 'after_capture');
    assert.ok(install !== -1, 'the Playwright install step must exist');
    assert.ok(
      npmCi !== -1 && npmCi < install,
      'npx must resolve the lockfile Playwright, not a registry release with a different browser revision',
    );
    assert.ok(
      install < afterCapture,
      'the browser must be installed before the capture that drives it',
    );
    assert.ok(
      !('continue-on-error' in steps[install]),
      'a failed install or gate must fail the job, not publish an empty preview',
    );
    assert.ok(
      !('continue-on-error' in visualsCaptureJob),
      'a job-level continue-on-error would mask the gate too',
    );
    // The hosted apt lane is not exec-tested here (apt-get may not exist on
    // the machine running the suite); pin its one line. The non-apt lane is
    // exec-tested by the tests below.
    const lines = steps[install].run.split('\n');
    const ifIndex = lines.findIndex((l) =>
      l.trim().startsWith('if command -v apt-get'),
    );
    const elseIndex = lines.findIndex((l) => l.trim() === 'else');
    assert.ok(
      ifIndex !== -1 && elseIndex > ifIndex,
      'the apt probe must branch into a non-apt lane',
    );
    assert.equal(
      lines[ifIndex + 1].trim(),
      'npx playwright install --with-deps chromium',
      'the hosted lane must keep apt-driven dependency installation',
    );
    // An env override at any of these levels moves the ground under the
    // pinned steps: HOME relocates the library scan, RUNNER_TEMP the stale
    // clear, GITHUB_WORKSPACE the heal, PATH/BASH_ENV re-resolve (or
    // pre-load) every command.
    for (const envMap of [
      steps[install].env,
      visualsCaptureJob.env,
      visualsDoc.env,
    ]) {
      for (const key of [
        'BASH_ENV',
        'PATH',
        'HOME',
        'RUNNER_TEMP',
        'GITHUB_WORKSPACE',
      ]) {
        assert.ok(
          !envMap || envMap[key] === undefined,
          `${key} must not be overridden around the capture steps`,
        );
      }
    }
  });

  it('passes a fully provisioned machine without provisioning anything', () => {
    const { status, stdout, stderr, calls } = runInstallStep('provisioned');
    assert.equal(
      status,
      0,
      `a provisioned machine must pass the gate: ${stdout}${stderr}`,
    );
    assert.match(
      stdout,
      /Chromium shared libraries all resolve on this runner\./,
    );
    assert.match(
      calls,
      /^npx playwright install chromium$/m,
      'the lane must download the browser',
    );
    assert.ok(
      !calls.includes('--with-deps'),
      'the non-apt lane must not take the apt-only flag — swapped branch bodies would',
    );
    assert.ok(
      !/^(sudo|dnf|yum) /m.test(calls),
      'nothing may be provisioned when the first scan resolves',
    );
  });

  it('provisions a fixable machine and judges the rescan', () => {
    const { status, stdout, stderr, calls } = runInstallStep('provisionable');
    assert.equal(
      status,
      0,
      `a machine dnf can fix must pass the gate: ${stdout}${stderr}`,
    );
    assert.match(
      stdout,
      /Chromium shared libraries all resolve on this runner\./,
    );
    assert.match(
      calls,
      /^sudo -n dnf install -y --skip-broken .*mesa-libgbm/m,
      'the lane must provision the known Chromium runtime set non-interactively',
    );
    assert.ok(!/yum/m.test(calls), 'yum is only a fallback after dnf fails');
  });

  it('fails an unfixable machine with the concrete missing list', () => {
    const { status, stdout, stderr, calls } = runInstallStep('unprovisionable');
    assert.equal(
      status,
      1,
      `an unprovisionable machine must fail the gate: ${stdout}${stderr}`,
    );
    assert.match(
      stdout,
      /libnss3\.so => not found/,
      'the concrete missing list must surface',
    );
    assert.match(
      stdout,
      /::error::/,
      'the failure must carry the actionable annotation',
    );
    assert.match(calls, /^sudo -n yum /m, 'yum must be tried once dnf fails');
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
