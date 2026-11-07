/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The macOS and Windows lanes, and the gate that decides when they run.
//
// They were gated on `merge_group` alone while no merge queue was enabled, so
// they had not run since 2026-07-02: reported as "skipped" on every pull
// request — which reads as agreement — and never reached afterwards. The
// repository's only non-Linux, non-GNU signal was silently off, and a macOS
// failure shipped and sat in `main` (#9220). Nothing here can prove a lane
// ran; what these tests hold is the wiring that lets it: the triggers, the
// nightly's blast radius, and the alerting that makes a nightly failure
// visible.
//
// The pull-request trigger and its platform-sensitivity classifier are OFF
// while the standing Windows failures are being fixed (see the note above
// test_macos in ci.yml): on pull requests the Windows lane was reporting
// failures on every PR for defects no PR caused, and neither lane gates a
// merge. That leaves the nightly as the lanes' ONLY live trigger, so the
// assertions here are the wiring that keeps it alive — the schedule exists,
// both lanes accept it, nothing else rides it, and its failure files an
// issue. Restoring the pull-request path means reverting the commit that
// carried this change; the classifier script and its tests were left in
// place so that stays a revert.

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
const failureIssue = parse(
  readFileSync('.github/workflows/main-ci-failure-issue.yml', 'utf8'),
);
// `on:` parses as the boolean true in YAML 1.1.
const triggers = ci[true] ?? ci['on'];
const LANES = ['test_macos_shards', 'test_windows'];
const PUSH_JOBS = [
  'classify_pr',
  'test_build',
  'test',
  'test_ubuntu',
  'lint_and_static',
];
const condOf = (job) => String(ci.jobs[job].if ?? '');

describe('complete macOS test groups', () => {
  it('partitions both heavy suites and retains every remaining test group', () => {
    const job = ci.jobs.test_macos_shards;
    expect(job.strategy['fail-fast']).toBe(false);
    expect(job.strategy.matrix.include).toEqual([
      { group: 'cli', shard: '1/3' },
      { group: 'cli', shard: '2/3' },
      { group: 'cli', shard: '3/3' },
      { group: 'core', shard: '1/2' },
      { group: 'core', shard: '2/2' },
      { group: 'rest', shard: '' },
      { group: 'scripts', shard: '' },
    ]);
    const step = job.steps.find(
      (candidate) => candidate.name === 'Run tests and generate reports',
    );
    expect(step.env.MACOS_TEST_GROUP).toBe('${{ matrix.group }}');
    expect(step.env.MACOS_TEST_SHARD).toBe('${{ matrix.shard }}');
    expect(step.run).toContain(
      'node scripts/run-macos-ci-group.js "$MACOS_TEST_GROUP" "$MACOS_TEST_SHARD"',
    );
  });

  it('keeps the original check name and rejects incomplete matrix results', () => {
    const aggregate = ci.jobs.test_macos;
    expect(aggregate.name).toBe('Test (macos-latest, Node 22.x)');
    expect(aggregate.needs).toBe('test_macos_shards');
    expect(aggregate.if).toContain('always()');
    const [step] = aggregate.steps;
    expect(step.env.MACOS_RESULT).toBe('${{ needs.test_macos_shards.result }}');
    expect(step.run).toBe('test "$MACOS_RESULT" = success');
    for (const result of ['failure', 'cancelled', 'skipped', '']) {
      expect(() =>
        execFileSync('bash', ['-c', step.run], {
          env: { ...process.env, MACOS_RESULT: result },
          stdio: 'pipe',
        }),
      ).toThrow();
    }
  });

  it('keeps the aggregate gate on exactly the events the shards run on', () => {
    // The aggregate only reads `needs.test_macos_shards.result`, so a gate
    // that drifts from the shards' makes the preserved check name report
    // `skipped` while the seven legs run and fail.
    for (const event of ['merge_group', 'schedule', 'workflow_dispatch']) {
      expect(gateRunsOn(condOf('test_macos'), event)).toBe(
        gateRunsOn(condOf('test_macos_shards'), event),
      );
    }
    expect(gateRunsOn(condOf('test_macos'), 'pull_request')).toBe(false);
  });
});

// The extended ceilings below, except the test lane's, are scoped to the
// self-hosted pool: `runs-on` falls back to ubuntu-latest when
// MAINTAINER_ECS_RUNNER_DISABLED=true (and, for the association-gated lanes,
// for fork PRs from untrusted authors — lint_and_static reads lint_runner,
// which routes every PR to the pool), so those hosted paths keep the
// pre-contention ceiling. The ARM64 fleet renders
// `["self-hosted", "linux", "arm64"]` — no `ecs-qwen` label — so the scope
// cannot key on the x64 fleet's name. Evaluate the real timeout expression for
// each routing instead of pinning a bare number -- the same
// substitute-then-evaluate technique
// `.github/scripts/ci-runner-routing.test.mjs` uses on `runs-on` -- so a
// regression to an unconditional ceiling fails here instead of reading as a
// passing constant.
const ECS_RUNNER = '["self-hosted", "linux", "x64", "ecs-qwen"]';
const ARM_RUNNER = '["self-hosted", "linux", "arm64"]';
const HOSTED_RUNNER = '["ubuntu-latest"]';
// The classifier output a job's own `runs-on` reads. Deriving it is what makes
// a ceiling pointed at the OTHER output red: only this name is substituted, so
// `lint_runner` left inside a gate that runs on `ubuntu_runner` survives the
// substitution and trips the unmodelled-term throw below.
const runnerOutputOf = (job) => {
  const names = [
    ...new Set(
      [
        ...String(ci.jobs[job]['runs-on']).matchAll(
          /needs\.classify_pr\.outputs\.(\w+)/g,
        ),
      ].map((match) => match[1]),
    ),
  ];
  if (names.length !== 1) {
    throw new Error(
      `${job} runs-on names ${names.length} classifier outputs: ${names}`,
    );
  }
  return names[0];
};
const timeoutMinutesOn = (job, runner) => {
  // The same `|| '["ubuntu-latest"]'` default the runs-on expression carries:
  // a missing output (classify_pr skipped) is the hosted routing. The caller
  // passes the value of the output the job itself reads — ubuntu_runner for
  // the association-gated lanes, lint_runner for lint_and_static and
  // integration_no_ak.
  const effective = runner || HOSTED_RUNNER;
  const output = runnerOutputOf(job);
  let expr = String(ci.jobs[job]['timeout-minutes'])
    .replace(/^\$\{\{\s*/, '')
    .replace(/\s*\}\}$/, '')
    .replace(
      new RegExp(
        `contains\\(needs\\.classify_pr\\.outputs\\.${output} \\|\\| '\\["ubuntu-latest"\\]', 'self-hosted'\\)`,
        'g',
      ),
      String(effective.includes('self-hosted')),
    )
    .replace(/fromJSON\(/g, '(');
  if (/needs\.|contains\(|fromJSON\(/.test(expr)) {
    throw new Error(
      `${job} timeout carries a term this guard does not model: ${expr}`,
    );
  }
  return Number(new Function(`return (${expr});`)());
};

describe('raw JUnit report retention', () => {
  const steps = ci.jobs.test.steps;
  const upload = steps.find(
    (step) => step.name === 'Upload Test Results Artifact',
  );
  // The rule `gateRunsOn` states for itself applies here too: a context term
  // these stubs do not model must throw rather than read as `undefined`,
  // where an inequality such as `x != true` would silently evaluate true.
  const loud = (value, path) =>
    typeof value !== 'object' || value === null
      ? value
      : new Proxy(value, {
          get: (target, key) => {
            if (typeof key === 'symbol' || key in target) {
              return loud(target[key], `${path}${String(key)}.`);
            }
            throw new Error(
              `gate carries a term this guard does not model: ${path}${String(key)}`,
            );
          },
        });

  const evaluate = (expression, event, headRepo, skipCi, profile) =>
    new Function(
      'github',
      'needs',
      'steps',
      'always',
      `return (${expression.replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '')});`,
    )(
      loud(
        {
          event_name: event,
          repository: 'QwenLM/qwen-code',
          event: { pull_request: { head: { repo: { full_name: headRepo } } } },
        },
        'github.',
      ),
      loud({ classify_pr: { outputs: { skip_ci: skipCi } } }, 'needs.'),
      loud({ ci_profile: { outputs: { ci_profile: profile } } }, 'steps.'),
      () => true,
    );

  it.each([
    [
      'pull_request',
      'contributor/qwen-code',
      'test-results-fork-22.x-ubuntu-latest',
    ],
    ['pull_request', 'QwenLM/qwen-code', 'test-results-22.x-ubuntu-latest'],
    ['push', '', 'test-results-22.x-ubuntu-latest'],
  ])(
    'retains reports for %s from %s, including failed runs',
    (event, repo, name) => {
      expect(upload.if).toContain('always()');
      expect(evaluate(upload.if, event, repo, 'false', 'full')).toBe(true);
      // Each shard uploads under its own name: upload-artifact v4+ rejects
      // a duplicate within the run.
      const shardSuffix = '-shard-${{ matrix.shard }}';
      expect(upload.with.name.endsWith(shardSuffix)).toBe(true);
      const prefix = upload.with.name.slice(0, -shardSuffix.length);
      expect(evaluate(prefix, event, repo, 'false', 'full')).toBe(name);
      expect(evaluate(upload.if, event, repo, 'true', 'full')).toBe(false);
      expect(evaluate(upload.if, event, repo, 'false', 'web-shell-only')).toBe(
        false,
      );
      expect(evaluate(upload.if, event, repo, 'false', '')).toBe(false);
    },
  );

  it('uploads raw XML for seven days without requiring a report to exist', () => {
    // Pinned to the 40-hex SHA, not the bare action name: this step now runs
    // on every full-profile lane inside a job holding `checks: write`, so a
    // relaxation to a mutable tag must not pass unnoticed.
    expect(upload.uses).toMatch(/^actions\/upload-artifact@[0-9a-f]{40}$/);
    expect(upload.with.path).toBe('packages/*/junit.xml');
    expect(upload.with['retention-days']).toBe(7);
    expect(upload.with['if-no-files-found']).toBe('ignore');
  });

  it('throws on a context term the stubs do not model', () => {
    // An inequality over an unmodelled term would otherwise read `undefined`
    // and pass: `undefined != true` is true, so all three rows above would
    // stay green while asserting nothing about the new term.
    expect(() =>
      evaluate(
        '${{ github.event.pull_request.draft != true }}',
        'push',
        '',
        'false',
        'full',
      ),
    ).toThrow(/does not model/);
  });

  it('keeps report publication advisory and unit-test failures blocking', () => {
    const publisher = steps.find(
      (step) => step.name === 'Publish Test Report (for non-forks)',
    );
    const unitTests = steps.find((step) => step.id === 'unit_tests');
    expect(publisher['continue-on-error']).toBe(true);
    expect(publisher.with['fail-on-error']).toBe('false');
    expect(upload['continue-on-error']).toBe(true);
    expect(unitTests['continue-on-error']).not.toBe(true);
    expect(unitTests.run).toContain('exit "$RC"');
    expect(steps.indexOf(upload)).toBeGreaterThan(steps.indexOf(publisher));
  });
});

// The smoke lane keeps the classifier's trust decision and hosted overrides
// but picks its own architecture, so its `runs-on` cannot be compared with
// another lane's. Evaluate the real expression the way
// `.github/scripts/ci-runner-routing.test.mjs` does.
const runnerOn = (job, runner) => {
  const output = runnerOutputOf(job);
  const expression = String(ci.jobs[job]['runs-on'])
    .replace(/^\$\{\{\s*/, '')
    .replace(/\s*\}\}$/, '');
  return new Function(
    'needs',
    'fromJSON',
    'contains',
    `return (${expression});`,
  )(
    { classify_pr: { outputs: { [output]: runner } } },
    JSON.parse,
    (labels, label) => labels.includes(label),
  );
};

it('gives the shared Linux test lane one ceiling on both pools', () => {
  // The unsharded suite outgrew 60 minutes on hosted runners: on 2026-10-17,
  // 17 of the 30 hosted runs that ended on their own were cancelled at 60.
  // Each shard runs an eighth of it, beside one build of the tree.
  for (const runner of [ECS_RUNNER, HOSTED_RUNNER, '']) {
    expect(timeoutMinutesOn('test_build', runner)).toBe(45);
    expect(timeoutMinutesOn('test', runner)).toBe(60);
  }
  expect(ci.jobs.test.strategy['fail-fast']).toBe(false);
  expect(ci.jobs.test.strategy.matrix.shard).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

it('skips every build-consuming shard step when test_build failed', () => {
  // `!cancelled()` is true when a needed job fails, so without this term a
  // failed build still starts all eight shards: each pays a full install and
  // then dies at the missing artifact, and every shard reports artifact
  // plumbing as its failing step instead of the build that broke. The steps
  // are gated, not the job or the matrix: `test_ubuntu` compares
  // `needs.test.result` to `success`, so a shard must still conclude success
  // when the build failed and let the aggregate report the failure.
  const steps = new Map(
    (ci.jobs.test.steps ?? []).map((step) => [step.name, step]),
  );
  for (const name of [
    'Install dependencies',
    'Download the built tree',
    'Unpack the built tree',
    'Run tests and generate reports',
    'Package and scan Chrome extension artifacts',
  ]) {
    expect(String(steps.get(name)?.if ?? ''), name).toContain(
      "needs.test_build.result == 'success'",
    );
  }
});

it('keeps every blocking test_build step under the job ceiling', () => {
  // The job cap cancels the job, and a cancelled job skips the failure-gated
  // collectors at the end — the file they upload is the reason this job has
  // them. A step cap fails only that step, so the collectors still run. Each
  // cap therefore has to fire before the job's.
  const jobCap = Number(ci.jobs.test_build['timeout-minutes']);
  const steps = new Map(
    (ci.jobs.test_build.steps ?? []).map((step) => [step.name, step]),
  );
  for (const name of [
    'Install dependencies',
    'Build',
    'Pack the build cache',
    'Archive the built tree',
  ]) {
    const minutes = steps.get(name)?.['timeout-minutes'];
    expect(typeof minutes, `${name} has no step timeout`).toBe('number');
    expect(minutes, `${name} cannot outlast the job`).toBeLessThan(jobCap);
  }
});

it('keeps every shard step cap under the job ceiling', () => {
  // Same reason as the build job: the job cap cancels the job, and a cancelled
  // job skips the failure-gated disk-pressure collector at the end. The caps
  // are pinned one by one rather than summed — they are alternatives in
  // practice, since a step only runs when the previous one left work to do,
  // and install plus the test step already add up past the ceiling by design.
  // The job cap therefore stays the outer backstop, not the sum of the parts.
  const jobCap = Number(ci.jobs.test['timeout-minutes']);
  const steps = new Map(
    (ci.jobs.test.steps ?? []).map((step) => [step.name, step]),
  );
  for (const name of [
    'Install dependencies',
    'Download the built tree',
    'Retry downloading the built tree',
    'Run tests and generate reports',
  ]) {
    const minutes = steps.get(name)?.['timeout-minutes'];
    expect(typeof minutes, `${name} has no step timeout`).toBe('number');
    expect(minutes, `${name} cannot outlast the job`).toBeLessThan(jobCap);
  }
});

it('reports the required Linux check only when the build and every shard pass', () => {
  const gate = ci.jobs.test_ubuntu;
  expect(gate.name).toBe('Test (ubuntu-latest, Node 22.x)');
  expect(gate.needs).toEqual(['classify_pr', 'test_build', 'test']);
  // On the shards' runners, not a hosted one that can queue it for minutes.
  expect(gate['runs-on']).toBe(ci.jobs.test['runs-on']);
  expect(condOf('test_ubuntu')).toBe(condOf('test'));
  expect(gate.steps[0].run).toBe(
    'test "$BUILD_RESULT" = success && test "$SHARDS_RESULT" = success',
  );
  // The shard count in the step's --shard has to match the matrix.
  const run = ci.jobs.test.steps.find(
    (step) => step.name === 'Run tests and generate reports',
  );
  expect(run.env.UNIT_TEST_SHARD).toBe(
    `\${{ matrix.shard }}/${ci.jobs.test.strategy.matrix.shard.length}`,
  );
});

it('pins the build-to-shard artifact handoff on both ends', () => {
  const built = new Map(
    (ci.jobs.test_build.steps ?? []).map((step) => [step.name, step]),
  );
  const shard = new Map(
    (ci.jobs.test.steps ?? []).map((step) => [step.name, step]),
  );

  // The shards install with QWEN_SKIP_PREPARE and never build packages/*/dist
  // themselves, so the archive must define the tree with the same path list
  // `pack` uses — a local copy that drifts ships a tree nothing tested.
  const archive = built.get('Archive the built tree').run;
  expect(archive).toContain('node scripts/ci-build-cache.mjs paths');
  expect(archive).not.toContain('git ls-files');

  // Four coupled literals tie the producer to the consumers. Renaming any one
  // fails all eight shards at unpack after a full build, on the required
  // check, so the name has to be pinned in one place.
  const name = built.get('Upload the built tree').with.name;
  expect(name).toBeTruthy();
  expect(shard.get('Download the built tree').with.name).toBe(name);
  expect(shard.get('Retry downloading the built tree').with.name).toBe(name);
  // Both attempts have to outlast the slow tail, not the median: eight shards
  // fetch this same artifact at once, the slowest completed one on main took
  // just under five minutes, and one exceeded the old five-minute cap on two
  // runs in a row, skipping the unpack entirely.
  for (const step of [
    'Download the built tree',
    'Retry downloading the built tree',
  ]) {
    expect(shard.get(step)?.['timeout-minutes'], step).toBe(15);
  }
  expect(shard.get('Unpack the built tree').run).toContain(
    `\${RUNNER_TEMP}/${name}/${name}.tgz`,
  );
});

it
  .skipIf(process.platform === 'win32')
  .each(['test', 'web_shell_e2e_smoke', 'integration_no_ak'])(
  'refreshes host assets on older PR checkouts in %s',
  (job) => {
    const root = mkdtempSync(join(tmpdir(), 'ci-host-assets-'));
    try {
      mkdirSync(join(root, 'scripts'));
      mkdirSync(join(root, 'dist', 'opentui-assets'), { recursive: true });
      writeFileSync(join(root, 'package.json'), '{"type":"module"}');
      writeFileSync(
        join(root, 'scripts', 'ci-build-cache.mjs'),
        'throw new Error("usage: ci-build-cache.mjs key | build <dir> | pack <dir> | paths");',
      );
      writeFileSync(
        join(root, 'scripts', 'copy_bundle_assets.js'),
        `import { copyFileSync } from 'node:fs';
export function copyOpenTuiAssets() {
  copyFileSync('host-native.so', 'dist/opentui-assets/native.so');
}
`,
      );
      writeFileSync(join(root, 'host-native.so'), 'consumer-host');
      writeFileSync(join(root, 'dist', 'cli.js'), 'built-bundle');
      writeFileSync(
        join(root, 'dist', 'opentui-assets', 'native.so'),
        'build-host',
      );
      const runnerTemp = join(root, 'runner-temp');
      const artifact = join(runnerTemp, 'unit-test-tree');
      mkdirSync(artifact, { recursive: true });
      execFileSync(
        'tar',
        ['-czf', join(artifact, 'unit-test-tree.tgz'), 'dist'],
        {
          cwd: root,
        },
      );
      rmSync(join(root, 'dist'), { recursive: true });

      const unpack = ci.jobs[job].steps.find(
        (step) => step.name === 'Unpack the built tree',
      );
      execFileSync('bash', ['-e', '-o', 'pipefail', '-c', unpack.run], {
        cwd: root,
        env: { ...process.env, RUNNER_TEMP: runnerTemp },
      });

      expect(readFileSync(join(root, 'dist', 'cli.js'), 'utf8')).toBe(
        'built-bundle',
      );
      expect(
        readFileSync(join(root, 'dist', 'opentui-assets', 'native.so'), 'utf8'),
      ).toBe('consumer-host');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it('keeps the no-AK gate above its dependency-install budget on ECS', () => {
  expect(timeoutMinutesOn('integration_no_ak', ECS_RUNNER)).toBe(60);
});

it('keeps the no-AK gate on its pre-contention ceiling when hosted', () => {
  expect(timeoutMinutesOn('integration_no_ak', HOSTED_RUNNER)).toBe(30);
  expect(timeoutMinutesOn('integration_no_ak', '')).toBe(30);
});

it('keeps lint_and_static sized for cold-cache pool runs', () => {
  // Both numbers are measured, not predicted: a flat 45 was tried first and
  // the lane was beheaded twice running honestly on cold-cache hk3 pool
  // runners — at 30 flat (install 892s vs the sibling Test job's 347s) and
  // again at 45 (install 940s, bundle closure 681s vs a warm 171s, every
  // step 2–4x). Routed like test's 120/60 and no_ak's 60/30 for the same
  // pool-contention reason; hosted keeps the tighter ceiling so a genuine
  // hang there does not burn the ECS allowance.
  expect(timeoutMinutesOn('lint_and_static', ECS_RUNNER)).toBe(90);
  expect(timeoutMinutesOn('lint_and_static', HOSTED_RUNNER)).toBe(45);
  expect(timeoutMinutesOn('lint_and_static', '')).toBe(45);
});

it('gives the ARM64 fleet the same contended-pool ceilings as the x64 pool', () => {
  // `LINUX_RUNNER_FLEET=arm64` renders ["self-hosted", "linux", "arm64"] — the
  // same reserved, shared hosts without the x64 fleet's `ecs-qwen` label. A
  // fleet-name scope would price them as hosted and behead lint at 45 / no_ak
  // at 30, which reads as an ARM compatibility failure.
  expect(timeoutMinutesOn('lint_and_static', ARM_RUNNER)).toBe(90);
  expect(timeoutMinutesOn('integration_no_ak', ARM_RUNNER)).toBe(60);
});

it('routes the browser smoke to ARM64 independently of the shared Linux test lane', () => {
  // The lane keeps the classifier's trust decision and hosted overrides, but
  // it no longer inherits the ordinary Linux fleet's architecture.
  expect(runnerOn('web_shell_e2e_smoke', ECS_RUNNER)).toEqual([
    'self-hosted',
    'linux',
    'arm64',
  ]);
  expect(runnerOn('web_shell_e2e_smoke', HOSTED_RUNNER)).toEqual([
    'ubuntu-latest',
  ]);
  // A missing classifier output (classify_pr skipped) is the hosted routing.
  expect(runnerOn('web_shell_e2e_smoke', '')).toEqual(['ubuntu-latest']);
  const smoke = ci.jobs.web_shell_e2e_smoke.steps.find(
    (step) => step.name === 'Run web-shell browser smoke',
  );
  // Each of the four shards runs a quarter of the smoke at the hosted
  // worker count; the transcript gate runs once, on the first shard.
  expect(smoke.run).toMatch(
    / -- --shard=\$\{\{ matrix\.shard \}\}\/4 --workers=2$/,
  );
  expect(ci.jobs.web_shell_e2e_smoke.strategy.matrix.shard).toEqual([
    1, 2, 3, 4,
  ]);
  expect(ci.jobs.web_shell_e2e_smoke.strategy['fail-fast']).toBe(false);
  const result = ci.jobs.web_shell_e2e_smoke_result;
  expect(result.name).toBe('web-shell E2E Smoke (ubuntu-latest, Node 22.x)');
  expect(result.needs).toEqual([
    'classify_pr',
    'test_build',
    'web_shell_e2e_smoke',
  ]);
  // The smoke tests test_build's tree instead of building its own, and a
  // draft skips it along with the no-AK integration gate.
  expect(ci.jobs.web_shell_e2e_smoke.needs).toEqual([
    'classify_pr',
    'test_build',
  ]);
  expect(condOf('web_shell_e2e_smoke')).toContain(
    "needs.test_build.result == 'success'",
  );
  expect(condOf('web_shell_e2e_smoke')).toContain(
    '!github.event.pull_request.draft',
  );
  const smokeSteps = ci.jobs.web_shell_e2e_smoke.steps.map((x) => x.name);
  expect(smokeSteps).not.toContain('Build');
  expect(smokeSteps).toContain('Unpack the built tree');
  expect(result['runs-on']).toBe(ci.jobs.web_shell_e2e_smoke['runs-on']);
  expect(condOf('web_shell_e2e_smoke_result')).toBe(
    condOf('web_shell_e2e_smoke'),
  );
  expect(result.steps[0].run).toBe('test "$SMOKE_RESULT" = success');
  expect(smoke.env.TMPDIR).toBe('${{ runner.temp }}');
  const transcript = ci.jobs.web_shell_e2e_smoke.steps.find(
    (step) => step.name === 'Run transcript document browser gate',
  );
  expect(transcript.env.TMPDIR).toBe('${{ runner.temp }}');
  expect(transcript.if).toBe('${{ matrix.shard == 1 }}');
  // Slow hosted browser installs took over 23 min, so reserve time in the
  // 60-minute job for transcript/smoke tests and artifact upload, while the
  // install step itself stays bounded.
  expect(timeoutMinutesOn('web_shell_e2e_smoke', ECS_RUNNER)).toBe(60);
  expect(timeoutMinutesOn('web_shell_e2e_smoke', HOSTED_RUNNER)).toBe(60);
  expect(timeoutMinutesOn('web_shell_e2e_smoke', '')).toBe(60);
  const hostedInstall = ci.jobs.web_shell_e2e_smoke.steps.find(
    (step) => step.name === 'Install Playwright Chromium and WebKit (hosted)',
  );
  expect(hostedInstall['timeout-minutes']).toBe(30);
});

// One helper for both "an <event> run reaches exactly these jobs" invariants.
//
// It decides by EVALUATING each gate for the event, not by looking for tokens
// in it — the same substitute-then-evaluate technique
// `.github/scripts/ci-runner-routing.test.mjs` uses on `runs-on`. Token
// probes are connective-blind: an `&&`→`||` flip inside an excluded job, or an
// allowlisted equality paired with an event-neutral disjunct under `||`,
// changes which jobs run while every substring stays exactly where it was.
// Evaluation sees the change because it computes the answer instead of
// pattern-matching the question, and it needs no expression parser of our own.
//
// Any context term the substitutions do not model throws rather than reading
// as false, so a gate that grows a new input is re-read here instead of
// silently degrading this guard.
const gateRunsOn = (cond, event, linuxUnitContainer = false) => {
  if (String(cond ?? '').trim() === '') return true;
  let e = String(cond)
    .replace(/\$\{\{/g, ' ')
    .replace(/\}\}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const subs = [
    [/!cancelled\(\)/g, 'true'],
    [/cancelled\(\)/g, 'false'],
    [/always\(\)/g, 'true'],
    [/github\.event_name/g, `"${event}"`],
    [
      /github\.event\.inputs\.linux_unit_container/g,
      JSON.stringify(String(linuxUnitContainer)),
    ],
    // These pins model a normal run: a gate keyed on any other value of a
    // modeled output (e.g. `ci_profile != 'full'`, `skip_ci == 'true'`)
    // evaluates here at the pin and may mis-report its reachability —
    // re-derive this helper's verdict before adding such a gate.
    [/needs\.classify_pr\.outputs\.skip_ci/g, '"false"'],
    [/needs\.classify_pr\.outputs\.ci_profile/g, '"full"'],
    // A normal run: the build passed and the pull request is not a draft.
    [/needs\.test_build\.result/g, '"success"'],
    [/github\.event\.pull_request\.draft/g, 'false'],
    [
      /github\.event\.pull_request\.head\.repo\.full_name/g,
      event === 'pull_request' ? '"QwenLM/qwen-code"' : '""',
    ],
    [/github\.repository/g, '"QwenLM/qwen-code"'],
  ];
  for (const [re, v] of subs) e = e.replace(re, v);
  e = e
    .replace(/!==/g, '@NE@')
    .replace(/===/g, '@EQ@')
    .replace(/!=/g, '@NE@')
    .replace(/==/g, '@EQ@')
    .replace(/@NE@/g, '!==')
    .replace(/@EQ@/g, '===');
  if (/github\.|needs\.|steps\.|vars\.|inputs\./.test(e)) {
    throw new Error(`gate carries a term this guard does not model: ${e}`);
  }
  return Boolean(new Function(`return (${e});`)());
};

// Asserts both directions: the jobs that must run on `event` do, and every
// other job does not. The positive half matters as much — a gate that stops
// admitting its own event turns the lane off with nothing else going red.
const assertEventReachesOnly = (event, allowedJobs) => {
  for (const [name, job] of Object.entries(ci.jobs)) {
    const reached = gateRunsOn(job.if, event);
    expect(
      reached,
      allowedJobs.includes(name)
        ? `${name} no longer runs on ${event}`
        : `${name} would also run on ${event}`,
    ).toBe(allowedJobs.includes(name));
  }
};

it('keeps the container PoC restricted to an explicit dispatch input', () => {
  const condition = ci.jobs.linux_unit_poc.if;
  expect(gateRunsOn(condition, 'workflow_dispatch')).toBe(false);
  expect(gateRunsOn(condition, 'workflow_dispatch', true)).toBe(true);
  for (const event of ['schedule', 'push', 'pull_request', 'merge_group']) {
    expect(gateRunsOn(condition, event, true)).toBe(false);
  }
});

describe('platform lanes — triggers', () => {
  it('gives the workflow a scheduled trigger', () => {
    // Without it the lanes have no path to `main` at all: `ci.yml`'s push
    // trigger is accepted only by `test`, `lint_and_static`, and the
    // `classify_pr` they depend on,
    // so a merge-queue-only gate on a repository with no merge queue is an off
    // switch for these two.
    expect(triggers.schedule).toBeDefined();
    expect(Array.isArray(triggers.schedule)).toBe(true);
    expect(triggers.schedule[0].cron).toMatch(/^\S+ \S+ \S+ \S+ \S+$/);
  });

  for (const lane of LANES) {
    it(`${lane} runs on the schedule, the queue, and a dispatch`, () => {
      const cond = condOf(lane);
      // Presence AND the disjunction between clauses: an `&&` where a `||`
      // belongs leaves the gate unsatisfiable for a trigger (event_name is
      // single-valued) while a presence-only check stays green.
      expect(cond).toMatch(/event_name == 'merge_group'\s*\|\|/);
      expect(cond).toMatch(/event_name == 'schedule'\s*\|\|/);
      expect(cond).toContain("github.event_name == 'workflow_dispatch'");
    });

    it(`${lane} stays off the pull-request path while it is red there`, () => {
      // Half a restoration is worse than none: a pull_request arm put back
      // without its classifier (or the reverse) either runs the lanes on
      // every PR or consults an output no job produces. Restore the trigger
      // by reverting the commit that removed it, not by editing one side.
      const cond = condOf(lane);
      expect(cond).not.toContain("'pull_request'");
      expect(cond).not.toContain('platform_sensitive');
      expect(ci.jobs[lane].needs).not.toContain('classify_platform');
    });

    it(`${lane}'s triggers are alternatives, not requirements`, () => {
      // The clause-presence assertions above survive a connective mutation:
      // `||` → `&&` between two event clauses leaves every string in place
      // and makes the gate unsatisfiable for every trigger, silently turning
      // both lanes off again — the exact state this PR exists to end. Read
      // the event group and require it to be a disjunction.
      const cond = condOf(lane).replace(/\s+/g, ' ');
      // From the first event clause to the close of the group — not from the
      // first `(`, which belongs to `!cancelled()`.
      const group = cond.slice(
        cond.indexOf('github.event_name'),
        cond.lastIndexOf(')'),
      );
      expect(group).toContain("github.event_name == 'schedule'");
      expect(group.split('||').length).toBeGreaterThanOrEqual(3);
      for (const clause of group.split('||')) {
        expect(
          clause,
          `event clause is conjoined: ${clause.trim()}`,
        ).not.toContain('&&');
      }
    });

    it(`${lane} survives an upstream skip`, () => {
      // classify_pr is still a `needs` edge; without `!cancelled()` a skip
      // or failure there would skip the lane on the nightly too.
      expect(condOf(lane)).toContain('!cancelled()');
    });
  }

  for (const lane of LANES) {
    it(`${lane} is bounded so a hang cannot burn the 360-minute default`, () => {
      // The nightly's alert fires only when the run completes; a lane hung
      // on a host-specific prompt otherwise sits out GitHub's default
      // timeout before it fails and anyone is told.
      expect(ci.jobs[lane]['timeout-minutes'], lane).toBe(60);
    });
  }

  for (const lane of LANES) {
    it(`${lane}'s steps are gated for every trigger it now has`, () => {
      // The first thing the revived triggers hit was not a test failure but
      // the lane's own plumbing: a `verify-checkout-head` step written when
      // this lane ran in the merge queue alone, with `expected_sha` naming
      // only `github.event.merge_group.head_sha`. On a pull request that
      // input is empty and the step fails the lane before a single test
      // runs. A step whose inputs name one event must be gated to that
      // event — for every step in a job that now runs on four.
      for (const step of ci.jobs[lane].steps ?? []) {
        // Every place a step can read an event context, not just `with:` —
        // an interpolation in `run:` or `env:` is the same defect wearing a
        // different key.
        const inputs = JSON.stringify({
          with: step.with ?? {},
          env: step.env ?? {},
          run: step.run ?? '',
        });
        const gate = String(step.if ?? '');
        for (const [context, event] of [
          ['github.event.merge_group', "'merge_group'"],
          ['github.event.pull_request', "'pull_request'"],
        ]) {
          if (!inputs.includes(context)) continue;
          const guarded =
            inputs.includes(`github.event_name == ${event}`) ||
            gate.includes(`github.event_name == ${event}`);
          expect(
            guarded,
            `${lane} step "${step.name}" reads ${context} on every trigger`,
          ).toBe(true);
        }
      }
    });
  }

  it('keeps a nightly run to exactly the two lanes', () => {
    // A `schedule:` trigger fires the whole workflow. Every other job must
    // therefore either exclude `schedule` outright or gate on an event
    // allowlist that cannot contain it — otherwise the nightly quietly
    // becomes a full CI run every day.
    assertEventReachesOnly('schedule', [...LANES, 'test_macos']);
  });
});

// The post-merge push lane on `main`.
//
// `ci.yml` carried no push trigger while no merge queue was enabled, so
// nothing validated the merged tree before it landed and the only check after
// it was the ~40-minute E2E — a regression could sit in `main` for hours. The
// trigger is back, taken by `test`, `lint_and_static`, and the `classify_pr`
// they depend on.
//
// The runner-routing tests in `.github/scripts/ci-runner-routing.test.mjs`
// cannot reach any of this: they drive `pick_runner`'s shell directly with
// EVENT_NAME=push, bypassing the trigger and all three job gates, so they stay
// green if either loses its push arm. What is pinned here is the YAML half —
// the same class of invariant as `keeps a nightly run to exactly the two
// lanes` above, and for the same reason: every mutation below leaves the whole
// suite green while silently turning the lane off, widening it, or pointing it
// at the wrong tree.
describe('post-merge push lane', () => {
  const stepOf = (job, name) =>
    (ci.jobs[job].steps ?? []).find((s) => s.name === name);

  it('is triggered on main and nowhere else', () => {
    // Drop the trigger and the post-merge signal is gone with it; widen the
    // branch list and every dev branch push spends a pool runner.
    // The whole object, not just `branches`: a sibling `tags:` key would
    // widen the lane to every tag push while `branches` still read `['main']`.
    // That also breaks the size ratchet — on a tag-creation push
    // `github.event.before` is all zeros, so WORKFLOW_SIZE_BASE_SHA is
    // unresolvable and both enforcers take their strict arm — and
    // main-ci-failure-issue.yml's `head_branch == 'main'` filter means no
    // issue is filed for tag runs: a silent red on release day.
    expect(triggers.push).toEqual({ branches: ['main'] });
  });

  it("lint_and_static shares test's exact gate", () => {
    // The split exists so this job can become a required check on its own;
    // its gate is therefore as security-relevant as test's. One equality
    // rides on test's whole-literal pin below: if the two gates ever
    // diverge — someone widening or narrowing the lint lane independently —
    // this fails before the divergence ships, and the literal pin still
    // guards the shared shape.
    expect(condOf('lint_and_static')).toBe(condOf('test'));
  });

  it('routes lint_and_static through the classify_pr lint output', () => {
    // runs-on is where the contributor code this describe's other pins talk
    // about actually executes. classify_pr's pick_runner publishes TWO
    // routings: ubuntu_runner keeps the fork-trust boundary for test and
    // integration_cli, while lint_runner routes every pull request —
    // untrusted forks included — to the fleet (maintainer decision
    // 2026-10-31, shared-pool code-execution risk accepted, extended to
    // integration_no_ak 2026-11-02). A literal pool
    // label array here would bypass the classifier indirection whole (and
    // desync from timeout-minutes, which reads the same output), and reading
    // ubuntu_runner would silently restore the hosted fork lane. Whole-
    // expression match, as no-ak-integration-ci does for test_windows.
    expect(String(ci.jobs.lint_and_static['runs-on'])).toBe(
      '${{ fromJSON(needs.classify_pr.outputs.lint_runner || \'["ubuntu-latest"]\') }}',
    );
    // The needs edge is what makes every needs.classify_pr.outputs.* this
    // describe relies on non-empty at runtime. Drop it and the lane silently
    // decouples from the classifier: runs-on falls through the `|| '…'` to
    // hosted runners, skip_ci reads '' so a release-sync PR promised a no-op
    // pass runs the full battery, and `Use trusted CI profile` takes its
    // documented degraded empty→full fallback.
    expect(
      [].concat(ci.jobs.lint_and_static.needs ?? []),
      'lint_and_static must consume the classifier',
    ).toContain('classify_pr');
  });

  it('keeps test on the association-gated output', () => {
    // Nothing else reads test's runs-on: switching it to lint_runner would
    // hand every untrusted fork the pool while the timeout pins above stayed
    // green — timeoutMinutesOn derives each lane's output from its own
    // runs-on, so it cannot catch a lane pointed at the wrong output. Pin the
    // expression, not an equality with lint_and_static — the two are meant
    // to differ.
    expect(String(ci.jobs.test['runs-on'])).toBe(
      '${{ fromJSON(needs.classify_pr.outputs.ubuntu_runner || \'["ubuntu-latest"]\') }}',
    );
  });

  it('lint_and_static keeps the minimal token its required-check role needs', () => {
    // This block overrides the workflow-level `checks: write` /
    // `statuses: write` grant. The lane runs contributor code (`npm ci`
    // executes the PR's lifecycle scripts) on same-repo PRs, merge_group,
    // dispatch and push; widening this — say by copying `test`'s block when
    // adding a reporter — hands write tokens to that code. `test`'s own
    // wider block is legitimate: dorny/test-reporter needs `checks: write`.
    // The contract guard reads the PR file list; it needs no write access.
    expect(ci.jobs.lint_and_static.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'read',
    });
  });

  it('keeps every shared prelude step identical between test and lint_and_static', () => {
    // The split copied the checkout/node/install prelude into the new job,
    // and copies drift: the first merge after the split brought #10799's
    // trusted-classifier rework, which updated `test`'s copy and left the
    // lint one stale — resolved by hand that time. Field-for-field equality
    // over every same-named step turns the next drift into a red test
    // instead of a review archaeology exercise.
    // Recursive canonicalisation — NOT JSON.stringify's array replacer,
    // which is a property allowlist applied at every nesting level: with it,
    // each step's nested `with:` and `env:` serialised as `{}`, so the guard
    // was blind to drift in Checkout's ref/fetch-depth, setup-node's
    // versions, and — the consequential one — `Use trusted CI profile`'s
    // TRUSTED_CI_PROFILE binding, whose drift to a literal would skip every
    // profile-gated step while reporting green.
    const canon = (v) =>
      Array.isArray(v)
        ? v.map(canon)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.keys(v)
                .sort()
                .map((k) => [k, canon(v[k])]),
            )
          : v;
    // Exempt the FIELD that must differ, not the whole step: the collector's
    // artifact name is per-job (upload-artifact v4+ rejects duplicates when
    // both jobs fail in one run; ci-disk-pressure.test.mjs asserts the
    // notEqual), but a whole-step exemption left its `uses:` revision — the
    // one action pin in the job — compared by nothing.
    const byName = (job) =>
      new Map(
        (ci.jobs[job].steps ?? []).map((s) => {
          const { name: _artifactName, ...restWith } = s.with ?? {};
          // Both install without the prepare build: lint needs none, and
          // the test shards unpack the one test_build made. Their `if`s now
          // differ on purpose — a shard's install must not run when the
          // build failed, while lint has no such dependency — so it is
          // stripped here and each side is pinned explicitly below.
          if (job !== 'test_build' && s.name === 'Install dependencies') {
            if (job === 'test') {
              expect(s.env).toEqual({
                QWEN_SKIP_PREPARE: '1',
                QWEN_SKIP_NOTICE_GENERATION: '1',
                // The shards' test step overrides HOME, which would hide the
                // corepack cache install warms here; pin COREPACK_HOME to a
                // fixed path under runner.temp so the warmup hits it (the
                // install body clears that exact path first). lint_and_static
                // routes HOME and COREPACK_HOME together via GITHUB_ENV, so
                // its install needs no step-level override.
                COREPACK_HOME: '${{ runner.temp }}/qwen-ci-corepack',
              });
            } else {
              expect(s.env).toEqual({
                QWEN_SKIP_PREPARE: '1',
                QWEN_SKIP_NOTICE_GENERATION: '1',
              });
            }
            const { env: _installEnv, if: _installIf, ...install } = s;
            return [
              s.name,
              JSON.stringify(canon({ ...install, with: restWith })),
            ];
          }
          return [s.name, JSON.stringify(canon({ ...s, with: restWith }))];
        }),
      );
    const t = byName('test');
    const l = byName('lint_and_static');
    // test_build carries the test shards' whole prelude, up to the install.
    const b = byName('test_build');
    const buildShared = [...b.keys()].filter((n) => t.has(n));
    // The number is the real intersection, not a floor to drift above: with
    // 15 written here while the intersection is 16, renaming one shared step
    // in `test` alone drops it back to 15, the loop stops comparing it, and
    // `test_build`'s copy can change freely. Raise it with the membership.
    expect(buildShared.length).toBeGreaterThanOrEqual(16);
    for (const n of buildShared) {
      if (n === 'Install dependencies') continue;
      expect(b.get(n), `step "${n}" drifted between test_build and test`).toBe(
        t.get(n),
      );
    }
    // The one step pair the loop above skips is the only body duplicated
    // verbatim between the two jobs: the sampler, the kill trap and the
    // install command must stay identical, or the shards install differently
    // from how the build installed. Only `env` and `if` may differ, and each
    // difference is stated below instead of hidden by the skip.
    const install = (job) =>
      (ci.jobs[job].steps ?? []).find(
        (candidate) => candidate.name === 'Install dependencies',
      );
    const withoutVariants = (job) => {
      const { env: _env, if: _if, ...rest } = install(job);
      return JSON.stringify(canon(rest));
    };
    expect(
      withoutVariants('test_build'),
      'Install dependencies drifted between test_build and test',
    ).toBe(withoutVariants('test'));
    expect(install('test_build').env).toEqual({ QWEN_SKIP_PREPARE: '1' });
    expect(install('test').env).toEqual({
      QWEN_SKIP_PREPARE: '1',
      QWEN_SKIP_NOTICE_GENERATION: '1',
      // The test step's HOME override would hide the corepack cache install
      // warms here; pin COREPACK_HOME to a fixed path under runner.temp so
      // the warmup hits it (the install body clears that exact path first).
      COREPACK_HOME: '${{ runner.temp }}/qwen-ci-corepack',
    });
    // Observed on the fleet: the pinned cache entry existed with its pnpm
    // binary missing, corepack trusts an existing entry without re-verifying
    // its files, and Install dependencies died instantly with
    // MODULE_NOT_FOUND (main runs 41876940141, 41889761157, 41927887452).
    // What left the entry incomplete is undetermined; _work/_temp survives
    // across jobs on self-hosted runners (the lint job's isolated-HOME step
    // documents the same fact), so such state persists. Every copy of the
    // shared install body must clear the cache before corepack runs, and the
    // guard must match ONLY the shard-owned path: a runner-exported shared
    // COREPACK_HOME (test_build) and lint's run-unique home — already warmed
    // by the hosted pnpm-store step — must never be deletion targets. The
    // execution test below holds the semantics; these pins hold the spelling.
    for (const job of ['test_build', 'test', 'lint_and_static']) {
      const body = String(install(job).run ?? '');
      expect(
        body,
        `${job} must scope the reset to the shard-owned path`,
      ).toContain(
        'if [ -n "${RUNNER_TEMP:-}" ] && [ "${COREPACK_HOME:-}" = "${RUNNER_TEMP:-}/qwen-ci-corepack" ]; then',
      );
      const reset = body.indexOf('rm -rf -- "${COREPACK_HOME}"');
      expect(
        reset,
        `${job} must reset the pinned corepack cache`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        body.indexOf('corepack pnpm install'),
        `${job} must reset the cache before corepack runs`,
      ).toBeGreaterThan(reset);
    }
    // The test step must keep sharing the cache install warms: a drifted
    // COREPACK_HOME sends the vitest globalSetup warmup back to the cold
    // npmjs download whose ETIMEDOUT flake #16328 removed.
    expect(
      ci.jobs.test.steps.find(
        (s) => s.name === 'Run tests and generate reports',
      ).env.COREPACK_HOME,
    ).toBe(install('test').env.COREPACK_HOME);
    const namesIn = (job) => (ci.jobs[job].steps ?? []).map((x) => x.name);
    // Values alone are order-blind, and order is load-bearing here: `steps`
    // exposes only steps that already ran, and a missing property reads as
    // ''. Moving `Use trusted CI profile` below its consumers changes no
    // serialized value while every `ci_profile == 'full'` gate reads '' and
    // the lane completes green having built and uploaded nothing.
    const buildSharedSet = new Set(buildShared);
    expect(
      namesIn('test_build').filter((n) => t.has(n)),
      'shared prelude reordered between test_build and test',
    ).toEqual(namesIn('test').filter((n) => buildSharedSet.has(n)));
    // The serializer is the guard's eyes: both sides of every comparison below
    // flow through it, so a regression that drops nested fields compares `{}`
    // to `{}` and the drift loop reports green — the exact array-replacer blind
    // spot the recursion above replaced. Pin a known nested key on the
    // serialized OUTPUT rather than on canon alone, because the regression that
    // matters is a call site swapped back to an allowlist, which a canon-only
    // fixture cannot see.
    expect(t.get('Checkout')).toContain('"fetch-depth":1');
    const shared = [...t.keys()].filter((n) => l.has(n));
    // The prelude is what is duplicated; if this floor ever drops, steps
    // were renamed apart and the guard is no longer guarding anything. 13 and
    // not 12: the collector is deliberately in both jobs, so it is in the
    // intersection, and a floor below the real count lets any one shared step
    // be deleted out of either job without turning this red.
    expect(shared.length).toBeGreaterThanOrEqual(13);
    // One deliberate divergence: lint maps java_only to its full payload
    // and adds the scripts/tests lane, where every other job skips. The
    // step must equal test's in everything else.
    const profileStep = 'Use trusted CI profile';
    const stepOf = (job, name) =>
      (ci.jobs[job].steps ?? []).find((x) => x.name === name);
    const lintProfile = stepOf('lint_and_static', profileStep);
    const testProfile = stepOf('test', profileStep);
    const { run: lintRun, ...lintRest } = lintProfile;
    const { run: testRun, ...testRest } = testProfile;
    expect(lintRest).toEqual(testRest);
    expect(lintRun).toContain(
      'java_only)\n    profile=full\n    scripts_unit=true',
    );
    expect(testRun).toContain('docs_only|github_ci_only|java_only|full) ;;');
    // Strip lint's java_only additions; what is left is test's step.
    const lintBase = lintRun
      .replace('scripts_unit=false\n', '')
      .replace(/\n {2}# A change confined[\s\S]*?java_only\)\n[\s\S]*?;;/, '')
      .replace(
        'docs_only|github_ci_only|full',
        'docs_only|github_ci_only|java_only|full',
      )
      .replace(
        'echo "scripts_unit=${scripts_unit}" >> "${GITHUB_OUTPUT}"\n',
        '',
      );
    expect(lintBase).toBe(testRun);
    for (const n of shared) {
      if (n === profileStep) continue;
      expect(l.get(n), `step "${n}" drifted between the two jobs`).toBe(
        t.get(n),
      );
    }
    // The exemption above is only for the field that must differ: the shard
    // install carries the build guard, and the lint install must not.
    expect(String(install('test')?.if ?? '')).toContain(
      "needs.test_build.result == 'success'",
    );
    expect(String(install('lint_and_static')?.if ?? '')).not.toContain(
      'needs.test_build',
    );
    // Name-keyed maps are order-blind, and order is load-bearing here: the
    // `steps` context only exposes steps that have already run, and a
    // nonexistent property reads as '' — so if `Use trusted CI profile`
    // (id: ci_profile) ever lands below its consumers, every
    // `ci_profile == 'full'` gate evaluates '' == 'full' and the lane
    // completes green having executed nothing.
    const sharedSet = new Set(shared);
    expect(
      namesIn('lint_and_static').filter((n) => sharedSet.has(n)),
      'shared prelude reordered between the two jobs',
    ).toEqual(namesIn('test').filter((n) => sharedSet.has(n)));
    const lintNames = namesIn('lint_and_static');
    expect(ci.jobs.lint_and_static.env?.QWEN_SKIP_PREPARE).toBeUndefined();
    expect(
      ci.jobs.lint_and_static.env?.QWEN_SKIP_NOTICE_GENERATION,
    ).toBeUndefined();
    expect(
      lintNames.indexOf('Check serve fast-path bundle closure'),
    ).toBeLessThan(lintNames.indexOf('Run i18n check'));
    expect(lintNames.indexOf('Use trusted CI profile')).toBeLessThan(
      lintNames.indexOf('Install dependencies'),
    );
    // The incremental opt-in is two pieces — the job-level LINT_BASE_SHA
    // binding and the history fetch — and neither was pinned: dropping the
    // env, deleting the step or reordering it left every suite green while
    // each PR quietly paid for the whole-repository scan this feature exists
    // to remove (full scanning IS the designed fallback).
    expect(String(ci.jobs.lint_and_static.env?.LINT_BASE_SHA)).toContain(
      'github.event.pull_request.base.sha',
    );
    const lintStep = (name) => {
      const index = lintNames.indexOf(name);
      expect(index, `step "${name}" is missing`).toBeGreaterThan(-1);
      return index;
    };
    // Both steps above refetch shallow history, and a depth-1 fetch of the
    // base ref grafts the very commit LINT_BASE_SHA names: `merge-base` then
    // has no ancestry to walk and lint-scope falls back to a full scan.
    for (const refetch of [
      'Check the API contract version advances',
      'Report test growth',
    ]) {
      expect(
        lintStep('Fetch incremental lint history'),
        `"Fetch incremental lint history" must stay below "${refetch}"`,
      ).toBeGreaterThan(lintStep(refetch));
    }
    expect(lintStep('Fetch incremental lint history')).toBeLessThan(
      lintStep('Install linters'),
    );
    // Blobless is load-bearing, not an optimization: the job may already hold
    // a blobless merge base from `Report test growth`, and a plain fetch then
    // dies with `fatal: missing blob object` — silently, because this step is
    // continue-on-error — leaving every lane on the full scan.
    const fetchStep = (ci.jobs.lint_and_static.steps ?? []).find(
      (s) => s.name === 'Fetch incremental lint history',
    );
    // Comments stripped: the rationale above the command names the flag too,
    // and a pin satisfied by prose would go green with the flag deleted.
    const fetchCode = String(fetchStep?.run)
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(fetchCode).toContain(
      'fetch --no-tags --depth=100 --filter=blob:none',
    );
    expect(fetchCode).toContain(
      'git config --unset remote.origin.partialclonefilter',
    );
    // A fixed window is not enough: main moves 50-100 commits a day, so a
    // 100-commit depth expires in about a day and every longer-lived PR paid
    // for a full scan. The deepen retry is what keeps them incremental.
    expect(fetchCode).toContain('--deepen=');
    // Pin the mechanism, not the flag: each of these can be deleted while a
    // bare `--deepen=` substring survives.
    expect(fetchCode).toContain(
      'fetch --no-tags --deepen=300 --filter=blob:none',
    );
    expect(fetchCode).toContain('git merge-base --all "${LINT_BASE_SHA}" HEAD');
    expect(fetchCode).toContain('history_usable || state=$?');
    expect(fetchCode).toContain("reason='deepen fetch aborted'; break;");
    expect(fetchCode).toContain(
      'git rev-list "${merge_base}..HEAD" "${merge_base}..${LINT_BASE_SHA}"',
    );
    expect(fetchCode).toContain('grep -qxF -f "${shallow}" <<< "${above}"');
    expect(fetchCode).toMatch(/for _attempt in 1 2 3/);
    expect(fetchCode).toContain('Incremental lint history:');
  });

  it.skipIf(process.platform === 'win32')(
    'executes the shared corepack reset only against the shard-owned path',
    () => {
      // Semantic witness for the reset guard. The string pins above hold its
      // spelling, but a guard that never executes satisfies every one of
      // them (the verify-pr round on 01d2b116 survived exactly that mutant),
      // so run the shipped fragment — sliced from the real install body, not
      // a copy — and watch what it deletes. The environment is built from
      // scratch: this suite also runs inside CI shards that export their own
      // COREPACK_HOME and RUNNER_TEMP, and inheriting those would point the
      // cleanup at the running job's own directories.
      const step = ci.jobs.test.steps.find(
        (s) => s.name === 'Install dependencies',
      );
      const body = String(step.run ?? '');
      const start = body.indexOf('if [ -n "${RUNNER_TEMP:-}" ]');
      const end = body.indexOf('corepack pnpm install');
      expect(
        start,
        'reset guard is missing from the install body',
      ).toBeGreaterThanOrEqual(0);
      expect(end, 'reset must sit before the corepack install').toBeGreaterThan(
        start,
      );
      const fragment = body.slice(start, end);
      const cells = [
        {
          name: 'shard-owned cache is cleared',
          home: (temp) => join(temp, 'qwen-ci-corepack'),
          cleared: true,
        },
        {
          name: 'runner-exported shared cache survives',
          home: (_temp, root) => join(root, 'shared-corepack'),
          cleared: false,
        },
        {
          name: 'lint run-unique warmed home survives',
          home: (temp) =>
            join(temp, 'qwen-lint-home-42-1', '.cache', 'node', 'corepack'),
          cleared: false,
        },
        {
          name: 'unset variable leaves the default cache alone',
          home: null,
          cleared: false,
        },
        {
          name: 'empty variable is not a deletion target',
          home: () => '',
          cleared: false,
        },
      ];
      for (const cell of cells) {
        const root = mkdtempSync(join(tmpdir(), 'corepack-reset-'));
        try {
          const temp = join(root, 'temp');
          const home = join(root, 'home');
          mkdirSync(temp, { recursive: true });
          mkdirSync(home, { recursive: true });
          // With no COREPACK_HOME the default cache is the deletion target
          // a naive guard would reach; give every cell a marker to watch.
          const target =
            cell.home === null
              ? join(home, '.cache', 'node', 'corepack')
              : cell.home(temp, root);
          const marker = join(target, 'v1', 'pnpm', '11.24.0', '.corepack');
          if (target) {
            mkdirSync(join(target, 'v1', 'pnpm', '11.24.0'), {
              recursive: true,
            });
            writeFileSync(marker, '{}');
          }
          const bystander = join(root, 'bystander');
          mkdirSync(bystander, { recursive: true });
          writeFileSync(join(bystander, 'sentinel'), 'keep');
          const env = {
            PATH: process.env.PATH,
            HOME: home,
            RUNNER_TEMP: temp,
          };
          if (cell.home !== null) env.COREPACK_HOME = target;
          execFileSync(
            'bash',
            ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', fragment],
            { env, cwd: root },
          );
          if (cell.cleared) {
            expect(existsSync(target), cell.name).toBe(false);
          } else if (target) {
            expect(existsSync(marker), cell.name).toBe(true);
          }
          expect(existsSync(join(bystander, 'sentinel')), cell.name).toBe(true);
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      }
    },
  );

  it.each([
    ['first fetch aborts', 1, 99, 99, 1, 0, 'deepen fetch aborted'],
    ['third fetch aborts', 3, 99, 99, 3, 2, 'deepen fetch aborted'],
    ['cap exhausted', 0, 99, 99, 3, 3, 'deepen cap reached'],
    ['initially ambiguous', 0, 99, 0, 0, 0, 'ambiguous merge base'],
    ['ambiguous after final deepen', 0, 99, 3, 3, 3, 'ambiguous merge base'],
    ['already usable', 0, 0, 99, 0, 0, null],
    ['shallow boundary recovered', 0, 1, 99, 1, 1, null],
  ])(
    'reports incremental history: %s',
    (
      _label,
      abortAt,
      readyAfter,
      ambiguousAfter,
      attempts,
      deepens,
      reason,
    ) => {
      const dir = mkdtempSync(join(tmpdir(), 'qwen-lint-history-'));
      try {
        const summary = join(dir, 'summary');
        const shallow = join(dir, 'shallow');
        writeFileSync(summary, '');
        writeFileSync(shallow, `${'e'.repeat(40)}\n`);
        const run = ci.jobs.lint_and_static.steps.find(
          (step) => step.name === 'Fetch incremental lint history',
        ).run;
        const gitShim = String.raw`
          attempts=0
          successes=0
          git() {
            case "$*" in
              *'fetch --no-tags --depth=100'*) return 0 ;;
              *'fetch --no-tags --deepen=300'*)
                attempts=$((attempts + 1))
                [ "$attempts" -ne "$ABORT_AT" ] || return 1
                successes=$((successes + 1)) ;;
              'merge-base --all '*)
                printf '%s\n' "$MERGE_BASE"
                if [ "$successes" -ge "$AMBIGUOUS_AFTER" ]; then
                  printf '%s\n' "$LINT_BASE_SHA"
                fi ;;
              'rev-parse --is-shallow-repository')
                if [ "$successes" -ge "$READY_AFTER" ]; then
                  echo false
                else
                  echo true
                fi ;;
              'rev-parse --git-path shallow') echo "$SHALLOW_PATH" ;;
              'rev-list --count '*) echo "$((100 + 300 * successes))" ;;
              'rev-list '*) printf '%s\n' "$BOUNDARY" ;;
              'config --unset remote.origin.partialclonefilter') return 0 ;;
              *) echo "unexpected git command: $*" >&2; return 97 ;;
            esac
          }
        `;
        const output = execFileSync(
          'bash',
          [
            '--noprofile',
            '--norc',
            '-e',
            '-o',
            'pipefail',
            '-c',
            `${gitShim}\n${run}\nprintf 'attempts=%s\\n' "$attempts"`,
          ],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              LINT_BASE_SHA: 'a'.repeat(40),
              LINT_HEAD_SHA: 'b'.repeat(40),
              MERGE_BASE: 'c'.repeat(40),
              BOUNDARY: 'e'.repeat(40),
              SHALLOW_PATH: shallow,
              GITHUB_STEP_SUMMARY: summary,
              ABORT_AT: String(abortAt),
              READY_AFTER: String(readyAfter),
              AMBIGUOUS_AFTER: String(ambiguousAfter),
            },
          },
        );
        expect(output).toContain(`attempts=${attempts}\n`);
        if (reason) {
          const message = `Incremental lint history: ${deepens} deepen(s), base depth ${100 + 300 * deepens} — ${reason}`;
          expect(output).toContain(`::warning::${message}\n`);
          expect(readFileSync(summary, 'utf8')).toBe(`- ${message}\n`);
        } else {
          expect(output).not.toContain('::warning::');
          expect(readFileSync(summary, 'utf8')).toBe('');
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it("pins the disk-pressure collector's upload-artifact revision", () => {
    // The equality loop above compares the two jobs to EACH OTHER, so it is
    // structurally blind to both collectors moving together — exempting only
    // `with.name` put `uses:` back in scope for the one-sided case, but a
    // coordinated re-pin leaves both serializations equal and reports green.
    // The SHA-format regex on `Upload Test Results Artifact` is not a witness
    // either: it accepts any 40-hex revision, on a different step. Pin the
    // literal revision, resolved per job rather than through a single
    // name-keyed map, because the step carries the SAME name in both jobs.
    const PIN =
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a';
    for (const job of ['test', 'lint_and_static']) {
      const collector = (ci.jobs[job].steps ?? []).find(
        (s) => s.name === 'Upload disk-pressure samples',
      );
      expect(
        collector?.uses,
        `${job}: 'Upload disk-pressure samples' must stay on ${PIN}`,
      ).toBe(PIN);
      // Same coordinated-edit blindness, second field: no suite pins the
      // sample window. Literal 14, not a shared constant — the JUnit
      // `Upload Test Results Artifact` step deliberately retains 7.
      expect(
        collector?.with?.['retention-days'],
        `${job}: disk-pressure samples must stay retained for 14 days`,
      ).toBe(14);
    }
  });

  it('keeps the moved lint/static payload present, gated, and out of test', () => {
    // The shared-prelude equality above only sees the name INTERSECTION; the
    // twenty moved steps — the payload this job exists to run — were pinned
    // by nothing: deleting `Run Prettier`, flipping its gate to
    // `docs_only`, or re-adding a copy to `test` all left every suite
    // green. A required check that silently stops running ESLint or the
    // lockfile audit still reports green on every PR; pin the payload by
    // name, order and gate. Two members deliberately carry different gates
    // and are asserted as such below — do not "normalise" them: the size
    // gate must run on github_ci_only PRs (a .github/-only PR is exactly
    // the one most likely to breach the 500 KB workflow limit), and the
    // helper-checks step IS the github_ci_only fast path.
    const FULL_PAYLOAD = [
      'Audit critical runtime dependencies',
      'Check lockfile',
      'Check desktop workspace isolation',
      'Check TUI dependency direction',
      'Install linters',
      'Run ESLint',
      'Run actionlint',
      'Run shellcheck',
      'Run yamllint',
      'Run Prettier',
      'Run sensitive keyword linter',
      'Run i18n check',
      'Generate Web Shell and VS Code companion notices',
      'Check Web Shell and VS Code companion notices are up-to-date',
      'Run .github/scripts helper tests',
    ];
    const steps = ci.jobs.lint_and_static.steps ?? [];
    const stepByName = new Map(steps.map((x) => [x.name, x]));
    // The two checks that read the built tree moved to test_build, which
    // builds it anyway; Lint & Static used to build and bundle the CLI a
    // second time for them. They stay full-gated and required through
    // `Test (ubuntu-latest, Node 22.x)`.
    const buildSteps = new Map(
      (ci.jobs.test_build.steps ?? []).map((x) => [x.name, x]),
    );
    for (const [name, command] of [
      [
        'Check serve fast-path bundle closure',
        'node scripts/check-serve-fast-path-bundle.js',
      ],
      [
        'Check core subpath exports resolve',
        'npm run check:core-subpath-exports',
      ],
      // The generator imports core's dist.
      ['Generate settings schema', 'npm run generate:settings-schema'],
      [
        'Check settings schema is up-to-date',
        'git status --porcelain packages/vscode-ide-companion/schemas/settings.schema.json',
      ],
    ]) {
      expect(stepByName.has(name), name).toBe(false);
      expect(buildSteps.get(name)?.run, name).toContain(command);
      expect(buildSteps.get(name)?.if, name).toContain("ci_profile == 'full'");
    }
    expect(buildSteps.get('Build').env?.DEV).toBe('true');
    const buildOrder = [...buildSteps.keys()];
    expect(buildOrder.indexOf('Check serve fast-path bundle closure')).toBe(
      buildOrder.indexOf('Build') + 1,
    );
    // A java_only change runs scripts/tests here instead of in the shards.
    const javaSuites = stepByName.get(
      'Run scripts/tests for a Java-only change',
    );
    expect(javaSuites.if).toBe(
      "${{ needs.classify_pr.outputs.skip_ci != 'true' && steps.ci_profile.outputs.scripts_unit == 'true' }}",
    );
    expect(javaSuites.run).toContain(
      "git grep -l -E 'managed-agent-server/|sdk-java/' -- 'scripts/tests/*.test.*'",
    );
    expect(javaSuites.run).toContain(
      'npm run test:scripts:unit -- "${suites[@]}"',
    );
    const testNames = new Set((ci.jobs.test.steps ?? []).map((x) => x.name));
    const prelude = new Set((ci.jobs.test.steps ?? []).map((x) => x.name));
    // Order and completeness in one shot: the full-gated steps that are not
    // part of the shared prelude must be exactly this list, in this order.
    expect(
      steps
        .filter(
          (x) =>
            String(x.if ?? '').includes("ci_profile == 'full'") &&
            !prelude.has(x.name),
        )
        .map((x) => x.name),
    ).toEqual(FULL_PAYLOAD);
    const generateNotices = stepByName.get(
      'Generate Web Shell and VS Code companion notices',
    ).run;
    expect(generateNotices).toContain(
      'npm run generate:notices --workspace=@qwen-code/web-shell',
    );
    expect(generateNotices).toContain(
      'npm run generate:notices --workspace=qwen-code-vscode-ide-companion',
    );
    expect(
      stepByName.get(
        'Check Web Shell and VS Code companion notices are up-to-date',
      ).run,
    ).toContain(
      'git status --porcelain packages/vscode-ide-companion/NOTICES.txt packages/web-shell/NOTICES.txt',
    );
    const checkNotices = stepByName.get(
      'Check Web Shell and VS Code companion notices are up-to-date',
    );
    expect(checkNotices['continue-on-error']).toBeUndefined();
    expect(checkNotices.run).toContain(
      'if [[ -n $(git status --porcelain packages/vscode-ide-companion/NOTICES.txt packages/web-shell/NOTICES.txt) ]]; then',
    );
    expect(checkNotices.run).toContain('exit 1');
    // Name, order and gate were pinned, but only the two notices steps had a
    // command body pinned: emptying `Run ESLint`'s `run:` or repointing it at
    // `true` left every suite green while the required check stopped running
    // the tool it is named for. Pin the load-bearing substring of each body —
    // NOT whitespace-exact text, so reformatting one of the multi-line blocks
    // stays benign. Totality is asserted below, not left to a missing key:
    // `toContain` coerces `undefined` to the literal string "undefined", so a
    // body containing that word would pass with its command unpinned.
    const LOAD_BEARING_RUN = {
      'Audit critical runtime dependencies': 'npm run audit:runtime:critical',
      'Check lockfile': 'npm run check:lockfile',
      'Check desktop workspace isolation': 'npm run check:desktop-isolation',
      'Check TUI dependency direction': 'npm run check:tui-dep-direction',
      'Install linters': 'node scripts/lint.js --setup',
      'Run ESLint': 'node scripts/lint.js --eslint',
      'Run actionlint': 'node scripts/lint.js --actionlint',
      'Run shellcheck': 'node scripts/lint.js --shellcheck',
      'Run yamllint': 'node scripts/lint.js --yamllint',
      'Run Prettier': 'node scripts/lint.js --prettier',
      'Run sensitive keyword linter':
        'node scripts/lint.js --sensitive-keywords',
      'Run i18n check': 'npm run check-i18n',
      'Generate Web Shell and VS Code companion notices':
        'npm run generate:notices --workspace=@qwen-code/web-shell',
      'Check Web Shell and VS Code companion notices are up-to-date':
        'git status --porcelain packages/vscode-ide-companion/NOTICES.txt',
      'Run .github/scripts helper tests':
        'node --test --test-concurrency=1 ${{ env.HELPER_TESTS }}',
    };
    expect(
      Object.keys(LOAD_BEARING_RUN).sort(),
      'LOAD_BEARING_RUN drifted from FULL_PAYLOAD',
    ).toEqual([...FULL_PAYLOAD].sort());
    // Whole literal, not the `ci_profile == 'full'` substring filtered above:
    // an appended `&&` clause still matches that substring while dropping the
    // step from the unattended post-merge lane. All 15 gates are identical.
    const FULL_GATE =
      "${{ needs.classify_pr.outputs.skip_ci != 'true' && steps.ci_profile.outputs.ci_profile == 'full' }}";
    for (const n of FULL_PAYLOAD) {
      const step = stepByName.get(n);
      expect(testNames.has(n), `${n} leaked back into test`).toBe(false);
      expect(String(step.if), `${n} gate drifted`).toBe(FULL_GATE);
      expect(
        String(step.run ?? ''),
        `${n} no longer runs its load-bearing command`,
      ).toContain(LOAD_BEARING_RUN[n]);
      // Containment says the command is present, not that its failure reaches
      // the job. The body guard is `|| true`/`|| :`, not a bare `||`: the
      // helper-tests retry legitimately uses `|| {`. Both stay inside this
      // loop — two non-payload steps set continue-on-error on purpose.
      expect(
        step['continue-on-error'],
        `${n} must not swallow its own failure`,
      ).toBeUndefined();
      expect(
        String(step.run ?? ''),
        `${n} swallows its exit status`,
      ).not.toMatch(/\|\|\s*(true|:)/);
    }
    expect(
      String(buildSteps.get('Check settings schema is up-to-date').run),
      'settings-schema gate lost its exit 1',
    ).toContain('exit 1');
    // The two deliberately-different gates, pinned as they are.
    expect(String(stepByName.get('Check workflow file size').if)).toBe(
      "${{ needs.classify_pr.outputs.skip_ci != 'true' }}",
    );
    expect(String(stepByName.get('GitHub CI helper checks').if)).toContain(
      "ci_profile == 'github_ci_only'",
    );
    expect(testNames.has('Check workflow file size')).toBe(false);
    expect(testNames.has('GitHub CI helper checks')).toBe(false);
  });

  it('classify_pr admits push in its event allowlist', () => {
    // `test` reads `needs.classify_pr.outputs.ubuntu_runner`. If classify_pr
    // stops accepting push, `test` still runs but that output is empty and
    // `fromJSON(... || '["ubuntu-latest"]')` silently demotes every
    // post-merge run to a scarce hosted runner.
    // Whole-literal, not a substring: `||`→`&&` anywhere in this allowlist
    // keeps every token in place while skipping classify_pr on a push. `test`
    // would still run (its own gate is `!cancelled()`-shaped), but with
    // `ubuntu_runner` empty it falls back through
    // `fromJSON(... || '["ubuntu-latest"]')` — every post-merge run silently
    // demoted to a scarce hosted runner, and `skip_ci`/`ci_profile` empty.
    expect(condOf('classify_pr')).toBe(
      "${{ github.event_name == 'pull_request' || github.event_name == 'merge_group' || github.event_name == 'workflow_dispatch' || github.event_name == 'push' }}",
    );
  });

  it('test accepts push while still excluding the nightly', () => {
    // The allowlist rewrite this guard exists to foreclose — `!cancelled()
    // && event != 'schedule' && (event == 'pull_request' || event ==
    // 'merge_group' || event == 'workflow_dispatch')` — contains no
    // `!= 'push'`, so it passes any exclusion-shaped check; the exclusivity
    // helper's positive half catches it instead (test is in PUSH_JOBS, so it
    // must reach push). The literal pin below covers what the evaluator
    // cannot: `!cancelled()` is substituted to a constant, so a gate that
    // loses that clause evaluates identically on every event and only the
    // whole-literal pin catches the change.
    expect(condOf('test')).toBe(
      "${{ !cancelled() && github.event_name != 'schedule' }}",
    );
  });

  it('keeps a post-merge run to exactly its expected jobs', () => {
    // The mirror of the nightly assertion, through the same helper: a `push:`
    // trigger fires the whole workflow, so every other job must exclude push
    // outright or gate on an allowlist that cannot contain it. Otherwise a
    // merge quietly becomes a full CI run — desktop_shell's cargo build
    // included.
    assertEventReachesOnly('push', PUSH_JOBS);
  });

  it('checks out the commit the push reported, not the branch tip', () => {
    // `github.ref` resolves `refs/heads/main` at fetch time — a moving tip —
    // while the check run attaches to `github.sha`. Without a push arm the
    // lane can validate a tree it does not report on, and nothing detects it:
    // `Verify checkout includes expected head commit` is gated to
    // pull_request / merge_group, and its `merge-base --is-ancestor` check
    // passes for a newer tip regardless. Order matters as much as presence —
    // the arm has to sit before the `github.ref` fallback to ever be reached.
    for (const job of ['test', 'lint_and_static']) {
      const checkout = (ci.jobs[job].steps ?? []).find((s) =>
        String(s.uses ?? '').startsWith('actions/checkout'),
      );
      expect(checkout, job).toBeDefined();
      expect(String(checkout.with?.ref ?? ''), job).toBe(
        "${{ github.event.inputs.branch_ref || (github.event_name == 'pull_request' && github.event.pull_request.head.sha) || (github.event_name == 'merge_group' && github.event.merge_group.head_sha) || (github.event_name == 'push' && github.sha) || github.ref }}",
      );
    }
  });

  it('pins the two PR-only lanes to their whole checkout ref', () => {
    // Same order contract as above, for the two lanes that carry no push arm
    // and so cannot join that loop. Whole literal, not a substring: moving
    // `|| github.ref` ahead of the pull-request arm keeps every token in
    // place — `toContain(head.sha)` and `not.toContain('refs/pull/')` both
    // stay green — while the lane silently checks out the asynchronously
    // rebuilt merge ref this PR exists to avoid, and the ancestor guard still
    // passes because a newer merge tree contains the expected head.
    const expectedRefs = {
      web_shell_e2e_smoke:
        "${{ github.event.inputs.branch_ref || (github.event_name == 'pull_request' && github.event.pull_request.head.sha) || github.ref }}",
      integration_no_ak:
        "${{ (github.event_name == 'pull_request' && github.event.pull_request.head.sha) || (github.event_name == 'merge_group' && github.event.merge_group.head_sha) || github.ref }}",
    };
    for (const [job, ref] of Object.entries(expectedRefs)) {
      const checkout = (ci.jobs[job].steps ?? []).find((s) =>
        String(s.uses ?? '').startsWith('actions/checkout'),
      );
      expect(checkout, job).toBeDefined();
      expect(String(checkout.with?.ref ?? ''), job).toBe(ref);
    }
  });

  it('collects and uploads coverage only from the post-merge run', () => {
    // Coverage is switched on by QWEN_CI_COVERAGE, which the unit-test step
    // sets only for push (main): pull-request runs had no reader for the
    // reports and paid about a fifth of the suite's wall time collecting
    // them. The upload gate must agree with the switch, or a PR run uploads
    // an empty artifact and a push run collects reports nobody keeps.
    const run = stepOf('test', 'Run tests and generate reports');
    expect(run).toBeDefined();
    expect(String(run.env?.QWEN_CI_COVERAGE)).toBe(
      "${{ github.event_name == 'push' && '1' || '' }}",
    );
    const step = stepOf('test', 'Upload coverage reports');
    expect(step).toBeDefined();
    expect(String(step.if)).toBe(
      "${{ always() && needs.classify_pr.outputs.skip_ci != 'true' && steps.ci_profile.outputs.ci_profile == 'full' && github.event_name == 'push' }}",
    );
    // The pull-request coverage comment was the artifact's only reader; with
    // no PR-side reports it has nothing to post and must stay gone.
    expect(ci.jobs.post_coverage_comment).toBeUndefined();
  });

  it('scopes the concurrency group and keeps main uncancellable', () => {
    expect(String(ci.concurrency.group).trim()).toBe(
      "${{ github.workflow }}-${{ github.event_name }}-${{ github.event.pull_request.head.repo.full_name || github.repository }}-${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && github.sha || github.head_ref || github.ref }}",
    );
    expect(String(ci.concurrency['cancel-in-progress']).trim()).toBe(
      "${{ github.ref != 'refs/heads/main' && !startsWith(github.ref, 'refs/heads/release/') }}",
    );
  });

  it.each([
    ['push', 'refs/heads/main', '', true],
    ['push', 'refs/heads/feat/e2e/example', '', false],
    ['push', 'refs/heads/release/example', '', false],
    ['schedule', 'refs/heads/main', '', false],
    ['workflow_dispatch', 'refs/heads/main', '', false],
    ['workflow_dispatch', 'refs/heads/release/example', '', false],
    ['pull_request', 'refs/pull/1/merge', 'feature', false],
    ['merge_group', 'refs/heads/gh-readonly-queue/main/pr-1', '', false],
  ])(
    'groups %s on %s without changing other events',
    (event, ref, headRef, perSha) => {
      const workflows = [ci];
      if (['push', 'schedule', 'workflow_dispatch'].includes(event)) {
        workflows.push(
          parse(readFileSync('.github/workflows/e2e.yml', 'utf8')),
        );
      }
      for (const workflow of workflows) {
        for (const sourceRepo of event === 'pull_request'
          ? ['one/fork', 'two/fork']
          : ['']) {
          for (const sha of ['a'.repeat(40), 'b'.repeat(40)]) {
            for (const attempt of [1, 2]) {
              const github = {
                workflow: workflow.name,
                repository: 'QwenLM/qwen-code',
                event_name: event,
                event: {
                  pull_request: { head: { repo: { full_name: sourceRepo } } },
                },
                ref,
                ref_name: ref.replace('refs/heads/', ''),
                head_ref: headRef,
                sha,
                run_id: attempt,
                run_attempt: attempt,
              };
              // Evaluate the actual YAML's string/boolean expressions. Exact
              // expression pins above and in e2e-workflow constrain this subset.
              const group = workflow.concurrency.group
                .trim()
                .replace(/\$\{\{(.*?)\}\}/g, (_, expression) =>
                  new Function('github', `return (${expression});`)(github),
                );
              const isCi = workflow === ci;
              const repoPart = isCi
                ? `${sourceRepo || github.repository}-`
                : '';
              const refPart = headRef || (isCi ? ref : github.ref_name);
              expect(group).toBe(
                `${workflow.name}-${event}-${repoPart}${perSha ? sha : refPart}`,
              );
            }
          }
        }
      }
    },
  );
});

describe('platform lanes — the retired sensitivity classifier', () => {
  it('is gone from the workflow, whole', () => {
    // Off with the pull-request trigger it fed: nothing consumes its output,
    // so a surviving job would spend a hosted runner per pull request on a
    // classification no gate reads — and a surviving reference would consult
    // a job that no longer exists. Deleted means deleted everywhere.
    expect(ci.jobs.classify_platform).toBeUndefined();
    expect(JSON.stringify(ci)).not.toContain('classify_platform');
  });

  it('keeps its classifier script tested for the restoration', () => {
    // The script layer stayed in place precisely so restoring the
    // pull-request trigger is a revert. A classifier that rotted untested in
    // the meantime would make that revert a regression instead.
    expect(ci.env.HELPER_TESTS).toContain(
      '.github/scripts/ci/classify-platform-sensitivity.test.mjs',
    );
    expect(ci.env.HELPER_TESTS).toContain(
      '.github/scripts/ci/classify-pr-profile.test.mjs',
    );
  });
});

describe('GitHub helper tests', () => {
  it('includes the disk-pressure contract suite', () => {
    expect(ci.env.HELPER_TESTS).toContain(
      '.github/scripts/ci-disk-pressure.test.mjs',
    );
  });

  it('runs every invocation serially', () => {
    const helperSteps = Object.values(ci.jobs)
      .flatMap((job) => job.steps ?? [])
      .filter((step) => String(step.run ?? '').includes('env.HELPER_TESTS'));
    expect(helperSteps).not.toHaveLength(0);
    for (const step of helperSteps) {
      // Split at each `node --test` occurrence, not per line: a second
      // invocation on the SAME line still gets its own segment.
      const invocations = String(step.run)
        .split(/(?=node --test)/)
        .filter((segment) => segment.startsWith('node --test'));
      expect(invocations, step.name).not.toHaveLength(0);
      for (const invocation of invocations) {
        expect(invocation, step.name).toContain('--test-concurrency=1');
      }
    }
  });

  it('routes the battery tmpdir off the host /tmp tmpfs', () => {
    // #15965: e2e-build.test.mjs mkdtemps thousands of chunk files via
    // os.tmpdir(); on the ECS pool that defaulted to the shared /tmp tmpfs,
    // whose ~1M inode quota filled up and failed the lane with ENOSPC while
    // 202G of capacity stayed free. RUNNER_TEMP sits on the roomy data disk,
    // same routing the unit lanes already use (#10035).
    const step = (ci.jobs.lint_and_static.steps ?? []).find(
      (candidate) => candidate.name === 'Run .github/scripts helper tests',
    );
    expect(step, 'helper-tests step missing').toBeDefined();
    // Comments stripped: the rationale above the export names it too, so a pin
    // satisfied by prose would stay green with the routing commented out.
    const run = String(step.run)
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    expect(run).toContain('export TMPDIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"');
    expect(run.indexOf('export TMPDIR')).toBeLessThan(
      run.indexOf('node --test'),
    );
    // The routed dir is private to the run and reaped on exit: RUNNER_TEMP
    // itself is shared with every other job on the host.
    expect(run).toContain('mktemp -d "${TMPDIR}/helper-tests-XXXXXX"');
    expect(run).toContain('trap \'rm -rf "$HELPER_TMPDIR"\' EXIT');
  });

  it('retries the full-profile battery once against pool contention', () => {
    // #12772: the battery spawns real subprocess loops on the shared ECS
    // pool, and a push to main has no flaky-rerun patrol — one host hiccup
    // failed the lane on a CSS-only commit. The unit lane got VITEST_RETRY
    // for the same fleet condition (#10868); this lane retries inline. The
    // github_ci_only fast lane stays single-attempt: it runs only on PRs, so
    // a red check is visible to its author and manually re-runnable. (The
    // flaky-rerun patrol is PR-scoped but best-effort — do not rely on it.)
    const step = (ci.jobs.lint_and_static.steps ?? []).find(
      (candidate) => candidate.name === 'Run .github/scripts helper tests',
    );
    expect(step, 'helper-tests step missing').toBeDefined();
    const invocations =
      String(step.run).match(/node --test --test-concurrency=1/g) ?? [];
    expect(invocations).toHaveLength(2);
    expect(String(step.run)).toContain('||');
    // The retry re-runs the SAME battery, not a cheaper subset.
    expect(String(step.run)).not.toContain('HELPER_TESTS_DEP_FREE');
    // The retry's exit status decides the step: nothing swallows it.
    expect(String(step.run)).not.toMatch(/\|\|\s*(true|:)/);
    expect(String(step.run).trimEnd().endsWith('}')).toBe(true);
    expect(step['continue-on-error']).toBeUndefined();
    // The warning fires only when the retry absorbed the flake, and names
    // the attempt-1 failures (the datum #12772 asked for).
    expect(String(step.run)).toMatch(/&&\s+echo "::warning::/);
    expect(String(step.run)).toMatch(
      /tee "\$\{RUNNER_TEMP\}\/helper-attempt1\.log"/,
    );
    expect(String(step.run)).toMatch(/::warning::.*\$\(/);
  });

  it('keeps the dependency-free fast lane off npm-package suites', () => {
    // The github_ci_only helper step runs before ANY dependency install (the
    // setup-node and `npm ci` steps are gated on the full profile), so every
    // suite it lists must import node: builtins only. These 11 suites import
    // the `yaml` npm package; letting the fast lane run the full list made an
    // ECS-updater-only fork PR fail closed with ERR_MODULE_NOT_FOUND on a
    // fresh hosted runner (#10548 review R6-1). The full-profile helper step
    // still runs every suite after `npm ci`, and a push to main always
    // classifies `full`, so what the fast lane skips is re-checked there.
    const depFree = String(ci.env.HELPER_TESTS_DEP_FREE).trim();
    const fullSuites = String(ci.env.HELPER_TESTS).trim().split(/\s+/);
    expect(depFree).not.toBe('');
    expect(depFree).not.toBe('undefined');
    const depFreeSuites = depFree.split(/\s+/);
    for (const suite of depFreeSuites) {
      expect(fullSuites, suite).toContain(suite);
    }
    const yamlSuites = [
      '.github/scripts/classify-release-notes.test.mjs',
      '.github/scripts/resolve-sandbox-image.test.mjs',
      '.github/scripts/web-shell-visuals-publish.test.mjs',
      '.github/scripts/qwen-triage-workflow.test.mjs',
      '.github/scripts/assign-issue-owner.test.mjs',
      '.github/scripts/auto-minimize-spam.test.mjs',
      '.github/scripts/ci-runner-routing.test.mjs',
      '.github/scripts/assign-pr-owner.test.mjs',
      '.github/scripts/ci-disk-pressure.test.mjs',
      '.github/scripts/e2e-build.test.mjs',
      '.github/scripts/ecs-runner/review-scratch-cleanup.test.mjs',
    ];
    for (const suite of yamlSuites) {
      expect(depFreeSuites, suite).not.toContain(suite);
      expect(fullSuites, suite).toContain(suite);
    }
    // The fast lane must consume the dep-free list, not the full one. Select
    // it by its GATE, never by the list it already consumes: a step that
    // regressed back to env.HELPER_TESTS would drop out of a content-based
    // filter, and the hole the filter exists to catch would report green
    // (#10548 review R6-1 — the first version of this assertion filtered on
    // `HELPER_TESTS_DEP_FREE` and so pinned the incomplete fix in place while
    // the sibling `lint_and_static` step still ran the full list with nothing
    // installed).
    const fastLaneSteps = Object.entries(ci.jobs)
      .flatMap(([jobName, job]) =>
        (job.steps ?? []).map((step) => ({ jobName, step })),
      )
      .filter(
        ({ step }) =>
          String(step.if ?? '').includes("ci_profile == 'github_ci_only'") &&
          String(step.run ?? '').includes('node --test'),
      );
    // One job owns the fast lane; a second copy is duplicated lint bootstrap
    // and, when it shares the name, a byte-identity break against the shared
    // prelude guard above.
    expect(fastLaneSteps).toHaveLength(1);
    for (const { jobName, step } of fastLaneSteps) {
      const where = `${jobName}/${step.name}`;
      expect(String(step.run), where).toContain('env.HELPER_TESTS_DEP_FREE');
      // Strip the dep-free name first: `env.HELPER_TESTS` is a substring of
      // `env.HELPER_TESTS_DEP_FREE`, so an unstripped check is vacuous.
      expect(
        String(step.run).replaceAll('HELPER_TESTS_DEP_FREE', ''),
        where,
      ).not.toContain('env.HELPER_TESTS');
    }
  });
});

describe('platform lanes — a failing nightly is visible', () => {
  it('files an issue when the scheduled CI run fails on main', () => {
    // A nightly nobody is told about is the same silence the merge-queue gate
    // produced: the run goes red on a branch nobody watches and the lane is
    // effectively off again.
    const wr = (failureIssue[true] ?? failureIssue['on']).workflow_run;
    expect(wr.workflows).toContain('Qwen Code CI');
    // Both sides of the binding: `workflow_run.workflows` matches the watched
    // workflow's `name:`, so renaming ci.yml silently unhooks the watcher and
    // the nightly goes back to failing where nobody is told.
    expect(ci.name).toBe('Qwen Code CI');
    // `workflow_run.workflows` matches the watched workflow's `name:` key:
    // pin the coupling itself, so renaming ci.yml's name fails here instead
    // of silently stopping the nightly's workflow_run events.
    expect(wr.workflows).toContain(ci.name);
    const cond = String(failureIssue.jobs.analyze.if);
    expect(cond).toContain("workflow_run.event == 'schedule'");
    expect(cond).toContain("workflow_run.head_branch == 'main'");
    expect(cond).toContain("workflow_run.conclusion == 'failure'");
  });
});

describe('run-local pnpm cache startup', () => {
  const install = ci.jobs.test.steps.find(
    (step) => step.name === 'Install dependencies',
  );
  const version = JSON.parse(
    readFileSync('package.json', 'utf8'),
  ).packageManager.match(/^pnpm@([^+]+)/)[1];
  // Exercise installation without the unrelated Linux disk sampler.
  const [, commandChain] = install.run.split(/\ntrap [^\n]*\n/);

  for (const scenario of [
    {
      name: 'recreates a broken run-local cache before installing',
      local: true,
      healthy: false,
      succeeds: true,
    },
    {
      name: 'recreates a healthy run-local cache before installing',
      local: true,
      healthy: true,
      succeeds: true,
    },
    {
      name: 'fails installation when the fresh package manager is unavailable',
      local: true,
      healthy: false,
      bootstrapFails: true,
      succeeds: false,
    },
    {
      name: 'leaves a broken shared cache untouched',
      local: false,
      healthy: false,
      succeeds: false,
    },
    {
      name: 'installs from a healthy shared cache without rewriting it',
      local: false,
      healthy: true,
      succeeds: true,
    },
  ]) {
    it(scenario.name, () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'pnpm-startup-')));
      const runnerTemp = join(root, 'runner-temp');
      const home = scenario.local
        ? `${runnerTemp}/qwen-ci-corepack`
        : join(root, 'shared-corepack');
      const cache = join(home, 'v1', 'pnpm', version);
      const entry = join(cache, 'bin', 'pnpm.mjs');
      const bin = join(root, 'bin');
      const seed = join(root, 'pnpm.mjs');
      const marker = join(root, 'installed');
      const trace = join(root, 'trace.jsonl');
      const oldEntryMarker = join(root, 'old-entry-ran');
      const sentinel = join(root, 'bystander');
      const cacheNeighbor = join(home, 'v1', 'pnpm', 'other-version');
      try {
        mkdirSync(join(cache, 'bin'), { recursive: true });
        mkdirSync(runnerTemp, { recursive: true });
        mkdirSync(bin);
        writeFileSync(
          join(cache, '.corepack'),
          '{"bin":{"pnpm":"bin/pnpm.mjs"}}',
        );
        writeFileSync(sentinel, 'keep');
        writeFileSync(cacheNeighbor, 'old-cache');
        writeFileSync(
          seed,
          String.raw`
import { appendFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify({ stage: 'pnpm', args }) + '\n');
if (args.length === 1 && args[0] === '--version') {
  console.log(process.env.FIXTURE_PINNED_VERSION);
} else if (JSON.stringify(args) === JSON.stringify(['install', '--frozen-lockfile', '--prefer-offline', '--reporter=append-only'])) {
  writeFileSync(process.env.FIXTURE_INSTALL_MARKER, 'installed');
} else {
  process.exit(2);
}
`,
        );
        if (scenario.healthy) {
          writeFileSync(
            entry,
            `${readFileSync(seed, 'utf8')}\nwriteFileSync(process.env.FIXTURE_OLD_ENTRY_MARKER, 'ran');\n`,
          );
        }
        writeFileSync(
          join(bin, 'corepack'),
          String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = fs.realpathSync(process.env.FIXTURE_ROOT);
const configuredHome = path.resolve(process.env.COREPACK_HOME);
const parent = fs.realpathSync(path.dirname(configuredHome));
if (parent !== root && !parent.startsWith(root + path.sep)) throw new Error('Not a private fixture parent');
fs.mkdirSync(configuredHome, { recursive: true });
const home = fs.realpathSync(configuredHome);
if (!home.startsWith(root + path.sep)) throw new Error('Not a private fixture');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify({ stage: 'corepack', args }) + '\n');
if (args[0] !== 'pnpm') throw new Error('Unexpected package manager');
const cache = path.join(home, 'v1', 'pnpm', process.env.FIXTURE_PINNED_VERSION);
const entry = path.join(cache, 'bin', 'pnpm.mjs');
if (!fs.existsSync(cache)) {
  fs.appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify({ stage: 'hydrate' }) + '\n');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(path.join(cache, '.corepack'), '{"bin":{"pnpm":"bin/pnpm.mjs"}}');
  if (process.env.FIXTURE_BOOTSTRAP_FAILS !== '1') fs.copyFileSync(process.env.FIXTURE_SEED, entry);
}
const result = spawnSync(process.execPath, [entry, ...args.slice(1)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
`,
        );
        chmodSync(join(bin, 'corepack'), 0o755);
        writeFileSync(
          join(bin, 'corepack.cmd'),
          `@"${process.execPath}" "%~dp0corepack" %*\r\n`,
        );
        const before = statSync(cache).ino;
        const run = () =>
          execFileSync('bash', ['-e', '-o', 'pipefail', '-c', commandChain], {
            cwd: process.cwd(),
            env: {
              ...process.env,
              PATH: `${bin}${delimiter}${process.env.PATH}`,
              COREPACK_ENABLE_NETWORK: '0',
              COREPACK_HOME: home,
              RUNNER_TEMP: runnerTemp,
              FIXTURE_ROOT: root,
              FIXTURE_TRACE: trace,
              FIXTURE_OLD_ENTRY_MARKER: oldEntryMarker,
              FIXTURE_PINNED_VERSION: version,
              FIXTURE_INSTALL_MARKER: marker,
              FIXTURE_SEED: seed,
              FIXTURE_BOOTSTRAP_FAILS: scenario.bootstrapFails ? '1' : '0',
            },
            stdio: 'pipe',
          });
        expect(commandChain).toBeTruthy();
        if (scenario.succeeds) expect(run).not.toThrow();
        else expect(run).toThrow();
        expect(existsSync(marker)).toBe(scenario.succeeds);
        expect(readFileSync(sentinel, 'utf8')).toBe('keep');
        expect(existsSync(cacheNeighbor)).toBe(!scenario.local);
        expect(existsSync(oldEntryMarker)).toBe(
          !scenario.local && scenario.healthy,
        );
        const installArgs = [
          'install',
          '--frozen-lockfile',
          '--prefer-offline',
          '--reporter=append-only',
        ];
        const events = readFileSync(trace, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(events).toEqual([
          { stage: 'corepack', args: ['pnpm', ...installArgs] },
          ...(scenario.local ? [{ stage: 'hydrate' }] : []),
          ...(scenario.succeeds ? [{ stage: 'pnpm', args: installArgs }] : []),
        ]);
        if (!scenario.local) {
          expect(statSync(cache).ino).toBe(before);
          expect(readFileSync(join(cache, '.corepack'), 'utf8')).toBe(
            '{"bin":{"pnpm":"bin/pnpm.mjs"}}',
          );
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});
