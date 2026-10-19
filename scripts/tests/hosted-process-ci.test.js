/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { classifyChangedFiles } from '../../.github/scripts/ci/classify-profile.mjs';

const read = (file) =>
  readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
const ci = parse(read('.github/workflows/ci.yml'));
const java = parse(read('.github/workflows/sdk-java.yml'));
const pkg = JSON.parse(read('package.json'));
const focused = 'test:integration:hosted:sandbox:none';
const windowsRun = [
  `npm run ${focused} -- --reporter=default --reporter=json --outputFile.json=hosted-process-suite.json`,
  `node -e "const r = require('./integration-tests/hosted-process-suite.json'); if (r.numTotalTests === 0 || r.numPassedTests !== r.numTotalTests) { console.error('::error::' + r.numPassedTests + ' of ' + r.numTotalTests + ' Hosted cases passed; Windows must run every case'); process.exit(1); }"`,
].join('\n');

// One row per failover arm the Hosted failover job runs: step name, npm
// script, and the runner flags that make the row a different arm.
const failoverArms = [
  [
    'Run in-flight owner failover E2E',
    'test:e2e:managed-inflight-failover',
    ['--inflight-failover'],
  ],
  [
    'Run continuation owner failover E2E',
    'test:e2e:managed-continuation-failover',
    ['--continuation-failover'],
  ],
  [
    'Run session owner failover E2E',
    'test:e2e:managed-session-failover',
    ['--session-failover'],
  ],
  [
    'Run long-answer persistence E2E',
    'test:e2e:managed-big-output',
    ['--big-output'],
  ],
  [
    'Run Harness-restart session failover E2E',
    'test:e2e:managed-harness-restart-failover',
    ['--session-failover', '--harness-only'],
  ],
  [
    'Run Harness-restart in-flight failover E2E',
    'test:e2e:managed-harness-restart-inflight-failover',
    ['--inflight-failover', '--harness-only'],
  ],
  [
    'Run Harness-restart continuation failover E2E',
    'test:e2e:managed-harness-restart-continuation-failover',
    ['--continuation-failover', '--harness-only'],
  ],
  [
    'Run frozen former-owner fencing E2E',
    'test:e2e:managed-continuation-frozen-owner-failover',
    ['--continuation-failover', '--freeze'],
  ],
  [
    'Run Harness-restart approval Allow recovery E2E',
    'test:e2e:managed-harness-restart-approval-allow',
    ['--continuation-failover', '--harness-only', '--g3-verify allow'],
  ],
  [
    'Run Harness-restart approval Deny recovery E2E',
    'test:e2e:managed-harness-restart-approval-deny',
    ['--continuation-failover', '--harness-only', '--g3-verify deny'],
  ],
  [
    'Run Harness-restart approval Cancel recovery E2E',
    'test:e2e:managed-harness-restart-approval-cancel',
    ['--continuation-failover', '--harness-only', '--g3-verify cancel'],
  ],
  [
    'Run Harness-restart approval expiry recovery E2E',
    'test:e2e:managed-harness-restart-approval-expiry',
    ['--continuation-failover', '--harness-only', '--g3-verify expiry'],
  ],
  [
    'Run Harness-restart continuation closeout E2E',
    'test:e2e:managed-harness-restart-continuation-closeout',
    ['--continuation-failover', '--harness-only', '--g3-verify continuation'],
  ],
  [
    'Run Harness-restart model-round failover E2E',
    'test:e2e:managed-harness-restart-model-round-failover',
    ['--model-round-failover', '--harness-only'],
  ],
  [
    'Run frozen former control-plane fencing E2E',
    'test:e2e:managed-frozen-control-plane-failover',
    ['--model-round-failover', '--frozen-control-plane'],
  ],
];

describe('Hosted real-process gates', () => {
  it('runs the packaged suite on relevant PRs without credentials or optional prerequisites', () => {
    const job = ci.jobs.integration_no_ak;
    expect(ci.on).toHaveProperty('pull_request');
    expect(job.if).toContain("github.event_name == 'pull_request'");
    expect(job.if).toContain("github.event_name == 'merge_group'");
    const install = job.steps.find(
      (step) => step.name === 'Install Dependencies',
    );
    expect(install.run).toContain('corepack pnpm install --frozen-lockfile');
    expect(install.env?.QWEN_SKIP_PREPARE).toBeUndefined();
    expect(pkg.scripts.prepare).toBe('node scripts/prepare.js');
    const prepare = read('scripts/prepare.js');
    expect(prepare).toContain("run('npm', ['run', 'build'])");
    expect(prepare).toContain("run('npm', ['run', 'bundle'])");
    const run = job.steps.find(
      (step) => step.name === 'Run required no-AK integration gate',
    );
    expect(run.if).toContain("ci_profile == 'full'");
    expect(run.run).toContain('npm run test:integration:no-ak:sandbox:none');
    expect(run['continue-on-error']).toBeUndefined();
    expect(run.run).not.toContain('|| true');
    expect(pkg.scripts['test:integration:no-ak:sandbox:none']).toContain(
      './cli/hosted-harness-process.test.ts',
    );
    expect(pkg.scripts[focused]).toBe(
      'cross-env QWEN_SANDBOX=false vitest run --root ./integration-tests --config ./vitest.hosted.config.ts',
    );
    expect(read('integration-tests/vitest.hosted.config.ts')).not.toContain(
      'testNamePattern',
    );
    // Any unlisted path classifies as full, so the check means something only
    // for paths that exist: none of them may take a PR out of the full profile.
    expect(
      classifyChangedFiles([
        'docs/design/2026-09-26-hosted-no-tool-process-gate.md',
      ]),
    ).toBe('docs_only');
    for (const file of [
      'integration-tests/cli/hosted-harness-process.test.ts',
      'integration-tests/helpers/hosted-harness-process.ts',
      'integration-tests/helpers/hosted-session-store.ts',
      'packages/cli/src/serve/hosted-harness-model.ts',
      '.github/workflows/ci.yml',
    ]) {
      expect(existsSync(new URL(`../../${file}`, import.meta.url)), file).toBe(
        true,
      );
      expect(classifyChangedFiles([file]), file).toBe('full');
    }
  });

  it('keeps the portable smoke filter matched to real cases', () => {
    // vitest exits 0 when -t matches nothing, so renaming these titles would
    // turn the macOS smoke into a silent no-op.
    const source = read('integration-tests/cli/hosted-harness-process.test.ts');
    expect(source.match(/\bit\(\s*'portable startup:/g)).toHaveLength(2);
    // The Windows lane runs every case, so none may skip itself, by a
    // modifier or an options object.
    expect(source).not.toMatch(
      /\.(skip|skipIf|runIf|todo|only)\b|\b(skip|todo|only)\s*:/,
    );
  });

  it.each([
    {
      name: 'test_macos',
      step: 'Hosted portable process smoke',
      after: /Install dependencies/i,
      condition: "${{ needs.classify_pr.outputs.skip_ci != 'true' }}",
      run: `npm run ${focused} -- -t 'portable startup'`,
      minutes: 5,
    },
    {
      // After the unit tests, so that a Hosted failure cannot skip them, and
      // failing unless every collected case passed.
      name: 'test_windows',
      step: 'Hosted process suite',
      after: /^Run tests and generate reports$/,
      condition:
        "${{ !cancelled() && needs.classify_pr.outputs.skip_ci != 'true' }}",
      run: windowsRun,
      minutes: 10,
    },
  ])(
    'runs the Hosted process cases on $name',
    ({ name, step: stepName, after, condition, run, minutes }) => {
      const steps = ci.jobs[name].steps;
      const index = steps.findIndex((step) => step.name === stepName);
      expect(index).toBeGreaterThan(
        steps.findIndex((step) => after.test(step.name ?? '')),
      );
      expect(steps[index].if).toBe(condition);
      expect(steps[index].run).toBe(run);
      expect(steps[index]['timeout-minutes']).toBe(minutes);
      expect(steps[index]['continue-on-error']).toBeUndefined();
    },
  );

  it('keeps real MySQL separate from the existing MariaDB slice and fails on missing tests', () => {
    const job = java.jobs['hosted-harness-mysql'];
    expect(job.services.mysql.image).toBe('mysql:8.4.6');
    expect(job.services.mysql.ports).toEqual(['3306/tcp']);
    expect(job.if).toBe("${{ inputs.tier != 'fast' }}");
    expect(java.jobs['mysql-integration'].services.mariadb.image).toMatch(
      /^mariadb:/,
    );
    // Keep daily coverage and run the same suite before Java publication.
    expect(Object.keys(java.on).sort()).toEqual([
      'schedule',
      'workflow_call',
      'workflow_dispatch',
    ]);
    const run = job.steps.find(
      (step) => step.name === 'Verify Hosted Java, Spring and MySQL processes',
    );
    expect(run.run).toContain('-Phosted-harness-mysql');
    expect(run.run).toContain('-Dnode.executable="$(command -v node)"');
    // The profile's include selects the tests; -Dit.test would override it.
    expect(run.run).not.toContain('-Dit.test');
    expect(run.run).toContain(
      '-Dqwen.cli.entry="${GITHUB_WORKSPACE}/dist/cli.js"',
    );
    expect(run.run).toContain('clean verify checkstyle:check');
    expect(run.run).not.toContain('skip');
    expect(run['continue-on-error']).toBeUndefined();
    // The relay-header filter otherwise surfaces only as an intermittent
    // socket-reuse failure in the Maven gate below, so the direct check must
    // keep running first.
    const relay = job.steps.findIndex(
      (step) => step.name === 'Check Hosted proxy header relay',
    );
    expect(relay).toBeGreaterThan(-1);
    expect(job.steps[relay].run).toBe(
      'cd integration-tests\n' +
        'npx vitest run helpers/hosted-relay-headers.test.ts',
    );
    expect(job.steps[relay]['continue-on-error']).toBeUndefined();
    expect(job.steps[relay].if).toBeUndefined();
    expect(job.steps[relay].shell).toBeUndefined();
    expect(job.steps[relay]['working-directory']).toBeUndefined();
    expect(relay).toBeLessThan(job.steps.indexOf(run));
    const pom = read('packages/managed-agent-server/pom.xml').replace(
      /<!--[\s\S]*?-->/g,
      '',
    );
    // The report check sees a test selection only when Maven passes it as a
    // user property. Set in the workflow (MAVEN_OPTS included) or in a POM,
    // it would narrow the run unrecorded.
    const selection = /it\.test|includesFile|excludesFile|<test>/;
    expect(read('.github/workflows/sdk-java.yml')).not.toMatch(selection);
    expect(pom).not.toMatch(selection);
    const [mariadb, hosted] = pom.split('<id>hosted-harness-mysql</id>');
    expect(mariadb).toContain('<id>mysql-integration</id>');
    expect(mariadb).toContain('<exclude>**/Hosted*IT.java</exclude>');
    expect(hosted).toContain('<include>**/Hosted*IT.java</include>');
    expect(hosted).toContain('<failIfNoTests>true</failIfNoTests>');
    // The MariaDB job must not narrow its selection either, or an IT outside
    // the Hosted family would silently run nowhere.
    const mariadbRun = java.jobs['mysql-integration'].steps.find(
      (step) =>
        step.name ===
        'Run Managed Agent tests, Checkstyle, and MySQL integration',
    );
    expect(mariadbRun.run).toContain('-Pmysql-integration');
    expect(mariadbRun.run).not.toContain('-Dit.test');
    // The H2 unit suite runs once, in the MariaDB job: the Hosted job's three
    // Maven steps would each repeat it, and the MariaDB job must keep it.
    const profile = (id) =>
      pom.split(`<id>${id}</id>`)[1].split('</profile>')[0];
    const skipsUnits =
      /<artifactId>maven-surefire-plugin<\/artifactId>\s*<configuration><skipTests>true<\/skipTests><\/configuration>/;
    for (const id of [
      'hosted-harness-mysql',
      'hosted-harness-gates',
      'o4-mysql-gates',
    ]) {
      expect(profile(id), id).toMatch(skipsUnits);
    }
    expect(profile('mysql-integration')).not.toContain('maven-surefire-plugin');
    expect(mariadbRun.run).not.toMatch(/-D(skipTests|maven\.test\.skip)/);
    // Those checks read only the command lines, so each job also compares
    // the reports of its run with the source tree, right after its last
    // integration-test step.
    for (const [name, after, check] of [
      [
        'mysql-integration',
        mariadbRun.name,
        'non-hosted packages/managed-agent-server',
      ],
      [
        'hosted-harness-mysql',
        run.name,
        'hosted packages/managed-agent-server',
      ],
    ]) {
      const steps = java.jobs[name].steps;
      const index = steps.findIndex((step) => step.name === after) + 1;
      expect(steps[index].run, name).toBe(
        `node scripts/check-failsafe-reports.js ${check}`,
      );
      expect(steps[index].if, name).toBeUndefined();
      expect(steps[index]['continue-on-error'], name).toBeUndefined();
    }
    // Keep the existing integration tests in their families: a renamed Hosted
    // test would move to MariaDB, a renamed MariaDB test to the Hosted job.
    const its = readdirSync(
      new URL(
        '../../packages/managed-agent-server/src/test/java/',
        import.meta.url,
      ),
      { recursive: true },
    )
      .map((file) => path.basename(String(file)))
      .filter((file) => file.endsWith('IT.java'));
    expect(its.filter((file) => /^Hosted.*IT\.java$/.test(file))).toContain(
      'HostedHarnessMySqlIT.java',
    );
    expect(its.filter((file) => !/^Hosted.*IT\.java$/.test(file))).toContain(
      'ManagedAgentMySqlIT.java',
    );
    expect(its.filter((file) => !/^Hosted.*IT\.java$/.test(file))).toContain(
      'JdbcRuntimeBrokerMySqlIT.java',
    );
    const upload = job.steps.find(
      (step) => step.name === 'Upload Hosted process reports',
    );
    expect(upload.if).toBe('always()');
    expect(upload.with.path).toContain('failsafe-reports');
    // The admission and O4 steps both run `clean verify` on the module, so
    // an upload below either ships an empty artifact with only a warning.
    for (const name of [
      'Verify Hosted admission gates',
      'Verify O4 filesystem process and capacity gates',
    ]) {
      const cleaning = job.steps.findIndex((step) => step.name === name);
      expect(job.steps[cleaning].run, name).toContain('clean verify');
      expect(job.steps.indexOf(upload), name).toBeLessThan(cleaning);
    }
    // The FG7 lane moved its per-case evidence out of @TempDir into this
    // module-relative directory precisely so an artifact can carry it; the
    // writer and the upload path must not drift.
    expect(upload.with.path).toContain(
      'packages/managed-agent-server/target/fg7-cases/',
    );
    // FG8 follows the same precedent: its per-case evidence lives in
    // target/fg8-cases/.
    expect(upload.with.path).toContain(
      'packages/managed-agent-server/target/fg8-cases/',
    );
    // FG9's session-relay fault gates keep theirs in target/fg9-cases/.
    expect(upload.with.path).toContain(
      'packages/managed-agent-server/target/fg9-cases/',
    );
    // FG10 follows the same precedent: its per-case evidence lives in
    // target/fg10-cases/.
    expect(upload.with.path).toContain(
      'packages/managed-agent-server/target/fg10-cases/',
    );
    // FG11a's automation lost-reply evidence lives in target/fg11-cases/.
    expect(upload.with.path).toContain(
      'packages/managed-agent-server/target/fg11-cases/',
    );
    // FG12a's MCP reply-loss evidence lives in target/fg12-cases/.
    expect(upload.with.path).toContain(
      'packages/managed-agent-server/target/fg12-cases/',
    );
    // The runner writes the Step 3 gate evidence under .qwen/, a hidden
    // path that upload-artifact drops silently without the flag. The arms
    // that write it run in the failover job, so the upload lives there.
    const evidence = java.jobs['hosted-failover-e2e'].steps.find(
      (step) => step.name === 'Upload G3 Step 3 gate evidence',
    );
    expect(evidence.if).toBe('always()');
    expect(evidence.with.path).toBe(
      '.qwen/investigations/g3-step3-implementation/',
    );
    expect(evidence.with['include-hidden-files']).toBe(true);
    expect(upload.with.path).not.toContain('.qwen/');
    // The writer side of the same path: the runner's default report
    // directory must stay under what the step uploads, or the artifact
    // goes empty with only a warning.
    expect(read('scripts/run-managed-agent-server-e2e.ts')).toContain(
      `\`${evidence.with.path}packaged-\${verificationMode}-`,
    );
  });

  it('pins the cgroup v2 delegation the FG8 monitor/run gates need', () => {
    const job = java.jobs['hosted-harness-mysql'];
    const delegate = job.steps.find(
      (step) => step.name === 'Delegate a cgroup v2 root for the process gates',
    );
    const verify = job.steps.find(
      (step) => step.name === 'Verify Hosted Java, Spring and MySQL processes',
    );
    expect(delegate, 'the cgroup delegation step').toBeDefined();
    // Without the root the gates refuse admission and burn their full
    // driver budget before red — so the delegation must land first.
    expect(job.steps.indexOf(delegate)).toBeLessThan(job.steps.indexOf(verify));
    expect(verify.env.QWEN_MANAGED_HOOK_CGROUP_ROOT).toBe('/sys/fs/cgroup/fg8');
    // Create/export coupling: a path rename on only one side fails the gates
    // as a missing root, never as a red pin.
    expect(delegate.run).toContain('mkdir -p /sys/fs/cgroup/fg8');
    expect(delegate.run).toContain('test -f /sys/fs/cgroup/fg8/cgroup.kill');
    // The Verify shell must be born inside the subtree: a process outside
    // it cannot migrate into fg8 — the common ancestor's cgroup.procs is
    // root-owned (kernel delegation containment).
    expect(verify.run).toContain('sudo tee /sys/fs/cgroup/fg8/cgroup.procs');
    // The delegation step smoke-tests admission with a real child joining a
    // unit — cgroup.kill existing alone proves nothing about migration.
    expect(delegate.run).toContain('/sys/fs/cgroup/fg8/smoke/cgroup.procs');
  });

  it.each([
    // Step ceilings today (134 + 10 + 20 + 50): Verify, the Broker fault
    // gates, admission and O4. The failover arms moved to their own job.
    ['hosted-harness-mysql', 214, 227],
    // Fifteen failover arms at 10 each.
    ['hosted-failover-e2e', 150, 165],
  ])(
    'keeps the %s job ceiling above its summed step ceilings',
    (name, steps, ceiling) => {
      const job = java.jobs[name];
      const summed = job.steps.reduce(
        (total, step) => total + (step['timeout-minutes'] ?? 0),
        0,
      );
      // The uncapped setup steps need their own allowance — the job
      // comment estimates it at ~13, so the enforced floor moves with that
      // estimate, not the older 10.
      expect(summed).toBe(steps);
      expect(job['timeout-minutes']).toBeGreaterThanOrEqual(summed + 13);
      expect(job['timeout-minutes']).toBe(ceiling);
    },
  );

  it('runs the failover arms in their own job, apart from the Hosted MySQL verify', () => {
    const hosted = java.jobs['hosted-harness-mysql'];
    const job = java.jobs['hosted-failover-e2e'];
    // A failing integration test in the Hosted MySQL job must not skip an
    // arm, so no arm, MySQL binaries install or runner-only env stays there,
    // and the failover job neither waits for it nor shares its services.
    expect(
      hosted.steps.filter((step) => / E2E$/.test(step.name ?? '')),
    ).toEqual([]);
    expect(hosted.env?.QWEN_E2E_REGISTER_STORAGE).toBeUndefined();
    expect(job.needs).toBeUndefined();
    // Its only condition is the fast-tier skip the Hosted MySQL job has.
    expect(job.if).toBe("${{ inputs.tier != 'fast' }}");
    expect(job.services).toBeUndefined();
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(job.env.QWEN_E2E_REGISTER_STORAGE).toBe('1');
    // Every arm the job runs has a row above, so none runs unpinned.
    expect(
      job.steps
        .filter((step) => /^Run .* E2E$/.test(step.name ?? ''))
        .map((step) => step.name)
        .sort(),
    ).toEqual(failoverArms.map(([name]) => name).sort());
    // The arms run the bundle and the packaged jar the job builds itself.
    const index = (pattern) =>
      job.steps.findIndex((step) => pattern.test(step.run ?? ''));
    const bundle = index(/corepack pnpm install --frozen-lockfile/);
    const sdk = index(/-f packages\/sdk-java\/qwencode\/pom\.xml .* install$/);
    const pack = index(
      /-f packages\/managed-agent-server\/pom\.xml\s+-DskipTests package$/,
    );
    const install = job.steps.findIndex(
      (step) => step.name === 'Install MySQL binaries for the failover E2E',
    );
    expect(bundle).toBeGreaterThan(-1);
    expect(job.steps[bundle].run).not.toContain('--ignore-scripts');
    expect(sdk).toBeGreaterThan(bundle);
    expect(pack).toBeGreaterThan(sdk);
    expect(install).toBeGreaterThan(pack);
    for (const step of [bundle, sdk, pack, install]) {
      expect(job.steps[step].if).toBeUndefined();
      expect(job.steps[step]['continue-on-error']).toBeUndefined();
    }
    expect(job.steps[install].id).toBe('failover_prerequisites');
  });

  it('runs every failover arm with its own runner arguments', () => {
    const commands = failoverArms.map(([, script]) => pkg.scripts[script]);
    expect(new Set(commands).size).toBe(failoverArms.length);
    expect(new Set(failoverArms.map(([name]) => name)).size).toBe(
      failoverArms.length,
    );
  });

  it.each(failoverArms)(
    'pins the %s arm into the Hosted failover job',
    (stepName, script, flags) => {
      const job = java.jobs['hosted-failover-e2e'];
      const install = job.steps.find(
        (step) => step.name === 'Install MySQL binaries for the failover E2E',
      );
      const step = job.steps.find((s) => s.name === stepName);
      expect(step, stepName).toBeDefined();
      expect(install, 'the MySQL binaries install step').toBeDefined();
      expect(
        job.steps.indexOf(step),
        `${stepName} must run after the MySQL binaries install`,
      ).toBeGreaterThan(job.steps.indexOf(install));
      expect(step.run).toContain(`npm run ${script}`);
      expect(step['timeout-minutes'], stepName).toBe(10);
      // An earlier arm's failure must not skip this one; a failed setup
      // step still does, through the install step's outcome.
      expect(step.if, stepName).toBe(
        "${{ !cancelled() && steps.failover_prerequisites.outcome == 'success' }}",
      );
      expect(step['continue-on-error'], stepName).toBeUndefined();
      // A renamed or deleted npm script would leave the step failing for
      // the wrong reason; pin that it drives the failover runner — with
      // the flags that make each row a different arm.
      expect(pkg.scripts[script], script).toContain(
        'run-managed-agent-server-e2e',
      );
      for (const flag of flags) {
        expect(pkg.scripts[script], `${script} carries ${flag}`).toContain(
          flag,
        );
      }
      // Each row must also be the only row with its mode flag, or two CI
      // steps silently run the same arm. A valued flag ('--g3-verify allow')
      // carries the flag name, and its value tells the rows apart.
      for (const flag of [
        '--session-failover',
        '--inflight-failover',
        '--continuation-failover',
        '--model-round-failover',
        '--harness-only',
        '--freeze',
        '--frozen-control-plane',
        '--g3-verify',
        '--big-output',
      ]) {
        if (!flags.some((entry) => entry.split(' ')[0] === flag)) {
          expect(pkg.scripts[script], `${script} omits ${flag}`).not.toContain(
            flag,
          );
        }
      }
    },
  );

  it.each([
    ['Verify Hosted Java, Spring and MySQL processes', 'hosted-harness-mysql'],
    ['Verify O4 filesystem process and capacity gates', 'o4-mysql-gates'],
  ])(
    'keeps the %s step ceiling above its failsafe fork timeout',
    (stepName, profile) => {
      const run = java.jobs['hosted-harness-mysql'].steps.find(
        (step) => step.name === stepName,
      );
      // Tie the asserted ceiling to the profile the step actually runs: a
      // re-pointed -P flag must not leave the row reading the old profile.
      expect(run.run).toContain(`-P${profile}`);
      const forkSeconds = Number(
        read('packages/managed-agent-server/pom.xml')
          .split(`<id>${profile}</id>`)[1]
          .match(/<forkedProcessTimeoutInSeconds>(\d+)</)[1],
      );
      // A step killed before its fork leaves no per-test failure lines, so
      // the main-CI failure analyzer can only file an undiagnosable
      // per-commit issue (#13503 for the Hosted verify step, #13684 for the
      // O4 gates). The ceiling must cover the fork plus the wrapped
      // compile/spotbugs/checkstyle work — 600 s is the wrap both
      // steps actually carry, so a step trim or fork bump reddens this row.
      expect(run['timeout-minutes'] * 60).toBeGreaterThanOrEqual(
        forkSeconds + 600,
      );
      // The hosted fork bumps were deliberate (FG7a,b,d–f plus the FG7c
      // crash class, ~150 s of wall clock at 2x headroom; then the L4
      // recovery class's four real-process cuts, ~300 s more the FG7
      // sizing never covered — #14125's per-commit kill; the FG8
      // monitor/run letters grew to five letters / twenty-one cases in
      // #14334, whose lane (run 38848525079 at fee23d2d3c) saw four
      // letters finish by ~700 s into the fork while the old 1800 s
      // budget killed the fork before the last letter reported, so the
      // fork doubles to 3600 in the same diff; the FG9 session/relay
      // letters, ~170 s measured locally for slice 1 and ~314 s for the
      // class with slice 2, fit inside that same lane-measured envelope;
      // and FG9 slice 3's store-failure and crash letters bring the class
      // to ~557 s, which with FG8c and FG10a inside the healthy allowance
      // no longer leaves one 600 s ceiling room in 3600, so the fork moves
      // to 3990 and the Verify step to 80 minutes; the FG10b/FG10f
      // workflow relay letters add ~82 s, so the fork moves to 4155 and
      // the Verify step to 85 minutes; their slice 2 (FG10c/FG10e) brings
      // the class to ~182 s, so the fork moves to 4353 and the Verify step
      // to 90 minutes; slice 3 (FG10d) brings it to ~247 s, so the fork
      // moves to 4484, still inside those 90 minutes; the FG12a MCP
      // reply-loss letter adds ~15 s, so the fork moves to 4499; the FG12c
      // restart matrix (five cases) adds ~49 s and the FG13c Hook
      // owner-restart cells add 300 s, so the fork moves to 4848 and the
      // Verify step stays at 95 minutes; the FG13d cancel/timeout cells add
      // two cases budgeted at 200 s, so the fork moves to 5048; the FG11a
      // automation lost-reply letter adds ~170 s, so the fork moves to 5218
      // and the Verify step to 100 minutes; the FG13d worker-stop cancel
      // cell adds 150 s, so the fork moves to 5368; FG11b's store faults add
      // ~130 s, so the fork moves to 5498 and the Verify step to 105
      // minutes; FG11b slice 2's Harness-side store faults add ~145 s, so
      // the fork moves to 5643, still inside those 105 minutes; the
      // event-stream liveness gates add ~440 s, so the fork moves to 6083;
      // the FG13d dropped-reply cancel cell adds 150 s, so the fork moves to
      // 6233; the FG12b store-failure class adds ~120 s (49.6 s measured
      // locally on JDK 21 + MySQL 8.0.46), so the fork moves to 6353 and the
      // Verify step to 116 minutes; the FG12f stream-gap class adds ~242 s
      // (121.1 s measured on the merged base), so the fork moves to 6585;
      // the FG13a execute lost-reply cell adds 150 s, so the fork moves to
      // 6735; the FG13a status lost-reply cell adds 150 s, so the fork moves
      // to 6885 and the Verify step to 125 minutes; the FG11c Harness-crash
      // method (144.8 s measured, 550 s budgeted) moves the fork to 7435 and
      // the Verify step to 134 minutes):
      // the relational check above tolerates
      // anything up to step*60, so the value is pinned literally here —
      // an unnoticed raise has no other red to land on.
      if (profile === 'hosted-harness-mysql') {
        expect(forkSeconds).toBe(7435);
      }
    },
  );

  // The Hosted*IT classes share one failsafe fork, so a case stalled to its
  // @Timeout must still leave the fork its healthy runtime: on main the
  // classes measured 437–546s with HostedTeamLeadMySqlIT adding ~65s, the
  // FG8 monitor/run letters grew from two letters / seven cases to five
  // letters / twenty-one cases in #14334 — on that PR's lane (run
  // 38848525079 at fee23d2d3c) four letters finished by ~700s into the
  // fork, the fork was still killed at the old 1800s budget before the last
  // letter reported, and the fork now sits at 3600s for the same 2×
  // headroom — and the FG9 session/relay letters, six since slice 3,
  // measure 528–557s for the class locally on JDK 21 + MySQL 8.4 across
  // three acceptance runs (~950s budgeted at >1.7x the heaviest measured
  // run, up from slice 2's ~534s; the class ran 310s on lane run
  // 38957583765 with four letters, as locally) in the same envelope, the
  // FG8c process-crash letter adds 144s measured locally on JDK 21 +
  // MySQL 8.4.6 (~290s budgeted at 2x), and the FG10a workflow digest
  // letter — four cases since #14390 — measures 15.9–16.2s for the letter
  // locally on macOS JDK 26 + MySQL 8.4.6 across four acceptance runs
  // (~33s budgeted at 2x), and the FG10b–f workflow relay letters
  // (HostedWorkflowRelayFaultGatesIT, five letters since slice 3's FG10d)
  // measure 246.1–246.8s for the class locally on JDK 21 + MySQL 8.4.6
  // across three acceptance runs (~494s budgeted at 2x, as FG10a, up from
  // slice 2's ~363s); with the fork itself ~14s, 3874s (3545s after slice
  // 1, plus slice 2's ~198s and slice 3's ~131s) covers them; FG12a's
  // ~15s budgeted at 2x raises it to 3889s. On the lane (run 39087108383
  // at a029896eff, FG10d's head, before FG12a) the nineteen classes then
  // in the fork ran 3085s from the first class's start to the last
  // class's end. FG12c's five-case restart matrix measures ~49s healthy
  // locally (~98s budgeted at 2x); the FG13c Hook owner-restart cells
  // (issue #14449, three cases) are budgeted at 300s until the lane
  // measures them. The healthy sum becomes 4238s; the FG13d cancel/timeout
  // cells (issue #14449, two cases) add 200s, so it becomes 4438s. The FG11a
  // automation lost-reply letter (HostedAutomationFaultGatesIT, eight cases
  // sharing one minute boundary) measures 46.3-85.0s locally on JDK 21 +
  // MySQL 8.4.6 across four acceptance runs (~170s budgeted at 2x), so it
  // becomes 4608s; the FG13d worker-stop cancel cell adds 150s, so it
  // becomes 4758s. FG11b's Spring-side store faults, a second method of the
  // automation class (six cases sharing one minute boundary), measure
  // 30.8-64.5s across three acceptance runs (~130s budgeted at 2x), so it
  // becomes 4888s. FG11b slice 2's Harness-side store faults, a third method
  // of the class (four cases, three cold restarts), measure 62.1-72.4s across
  // three acceptance runs (~145s budgeted at 2x), so it becomes 5033s. The
  // event-stream liveness gates (HostedEventStreamLivenessIT, four cases on
  // the shipped 15s keepalive and 45s bound) measure 214.4–215.0s for the
  // class locally on JDK 21 and 25 + MySQL 8.4.6 across four acceptance runs
  // (~440s budgeted at 2x), so it becomes 5473s; the FG13d dropped-reply
  // cancel cell adds 150s, so it becomes 5623s; the FG12b store-failure
  // class adds ~120s (49.6s measured on JDK 21 + MySQL 8.0.46), so it
  // becomes 5743s; the FG12f stream-gap class (HostedMcpStreamGapIT, three
  // cases, three cold boots) measures 121.1s locally on the merged base
  // (~242s budgeted), so it becomes 5985s; the FG13a execute lost-reply
  // cell adds 150s, so it becomes 6135s; the FG13a status lost-reply cell
  // adds 150s, so it becomes 6285s; the FG11c Harness-crash method (144.8s
  // measured, ~550s budgeted at 2x) becomes 6835s. The largest ceiling
  // (600s) plus
  // that healthy sum still fits the fork. A larger ceiling lets failsafe
  // kill the fork mid-run, and the classes left unrun never report, failing
  // the gate undiagnosably (#13780).
  const hostedForkHealthySeconds = 6835;
  const hostedForkSeconds = () =>
    Number(
      read('packages/managed-agent-server/pom.xml')
        .split('<id>hosted-harness-mysql</id>')[1]
        .match(/<forkedProcessTimeoutInSeconds>(\d+)</)[1],
    );
  const hostedTestPath = (className) =>
    'packages/managed-agent-server/src/test/java/' +
    `com/alibaba/qwen/code/managedagent/${className}.java`;
  // Every class the fork's **/Hosted*IT.java include picks up, in any
  // package.
  const hostedTestClasses = () => {
    const root = 'packages/managed-agent-server/src/test/java/';
    return readdirSync(new URL(`../../${root}`, import.meta.url), {
      recursive: true,
    })
      .map(String)
      .filter((file) => /^Hosted\w*IT\.java$/.test(path.basename(file)))
      .map((file) => ({
        name: path.basename(file, '.java'),
        file: root + file.split(path.sep).join('/'),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  };
  // Java code without its string literals and comments, so neither a
  // commented-out annotation nor a "/*" inside a string skews the counts.
  // One pass, so whichever of a literal or a comment opens first wins.
  const javaCode = (source) =>
    source.replace(
      /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\/\*[\s\S]*?\*\/|\/\/.*$/gm,
      (token) =>
        token.startsWith('"') ? '""' : token.startsWith("'") ? "''" : '',
    );
  const hostedTestSource = (className) =>
    javaCode(read(hostedTestPath(className)));
  const ceilingsOf = (source) =>
    [...source.matchAll(/@(?:[\w.]+\.)?Timeout\((\d+)\)/g)].map((m) =>
      Number(m[1]),
    );

  const casesOf = (source) =>
    [
      ...source.matchAll(
        /@(?:[\w.]+\.)?(Test|RepeatedTest|ParameterizedTest|TestFactory|TestTemplate)\b/g,
      ),
    ].length;
  // A regression in these classes stalls every case at once; the summed
  // rule below holds them.
  const hostedSummedClasses = [
    'HostedTeamLeadMySqlIT',
    'HostedTeamMemberCommandMySqlIT',
  ];

  it('budgets every Hosted*IT class the shared fork runs', () => {
    // A new class adds its runtime to hostedForkHealthySeconds in the same
    // diff; pinning the list puts that on a red here, not on a fork kill
    // on main (#14148).
    expect(hostedTestClasses().map(({ name }) => name)).toEqual([
      'HostedAutomationFaultGatesIT',
      'HostedChannelFaultGatesIT',
      'HostedChannelProcessCrashIT',
      'HostedCommittedEventLineReplayIT',
      'HostedConcurrentTurnBurstMySqlIT',
      'HostedEventStreamLivenessIT',
      'HostedExtensionsIT',
      'HostedHarnessMySqlIT',
      'HostedHookCancelFaultGatesIT',
      'HostedHookFaultGatesIT',
      'HostedHookReplyLossFaultGatesIT',
      'HostedMcpReplyLossIT',
      'HostedMcpRestartFaultGatesIT',
      'HostedMcpStoreFaultGatesIT',
      'HostedMcpStreamGapIT',
      'HostedMonitorRunFaultGatesIT',
      'HostedProcessCrashIT',
      'HostedPublicWorkspaceIT',
      'HostedSessionRelayFaultGatesIT',
      'HostedShellLifecycleRecoveryIT',
      'HostedTeamLeadMySqlIT',
      'HostedTeamMemberCommandMySqlIT',
      'HostedWorkflowFaultGatesIT',
      'HostedWorkflowRelayFaultGatesIT',
      'HostedWorkspaceConcurrencyIT',
      'HostedWorkspaceRecoveryWorkerIT',
      'HostedWorkspaceStorageGuardMySqlIT',
      'HostedWorkspaceToolTurnIT',
    ]);
  });

  it.each(
    hostedTestClasses()
      .filter(({ name }) => !hostedSummedClasses.includes(name))
      .map(({ name, file }) => [name, file]),
  )('keeps each %s ceiling inside the shared fork budget', (name, file) => {
    // A stalled case fails alone and the fork runs on, so each ceiling
    // must leave the fork its healthy runtime — the shape the FG7–FG10
    // letters, independent fixtures sharing the fork, were first held
    // to. A case with no ceiling can stall until failsafe kills the fork.
    const source = javaCode(read(file));
    const ceilings = ceilingsOf(source);
    expect(casesOf(source), name).toBeGreaterThan(0);
    expect(ceilings, name).toHaveLength(casesOf(source));
    for (const ceiling of ceilings) {
      expect(ceiling + hostedForkHealthySeconds, name).toBeLessThanOrEqual(
        hostedForkSeconds(),
      );
    }
  });

  it.each(hostedSummedClasses)(
    'keeps every %s ceiling together inside the shared fork budget',
    (className) => {
      const source = hostedTestSource(className);
      const cases = casesOf(source);
      const ceilings = ceilingsOf(source);
      expect(cases).toBeGreaterThan(0);
      expect(ceilings).toHaveLength(cases);
      // A regression such as a lost wake Turn or a stalled message relay
      // leaves no failed row for the cases to stop on, so every case may
      // stall to its ceiling at once.
      const total = ceilings.reduce((sum, ceiling) => sum + ceiling, 0);
      expect(total + hostedForkHealthySeconds).toBeLessThanOrEqual(
        hostedForkSeconds(),
      );
      // Awaitility ignores the interrupt a @Timeout sends, so a ceiling
      // holds only when every wait goes through the helper that fails on
      // it.
      expect([...source.matchAll(/\bawait\(\)/g)]).toHaveLength(1);
      expect(read(hostedTestPath(className))).toContain(
        'await().failFast("The case\'s @Timeout interrupted it"',
      );
    },
  );

  // The Hosted*IT classes share one fork, and Spring caches a test context
  // for the rest of it. A Managed Agent context's recovery scans cover
  // every tenant of its schema, so one left open on the shared MySQL schema
  // claims the work of the classes that run after it. A context inherited
  // from a base class or a meta-annotation is not seen here; none exists.
  it('closes the Spring test context each Hosted IT class declares', () => {
    const contexts = hostedTestClasses()
      .map(({ name, file }) => {
        const code = javaCode(read(file));
        const declaration = code.search(new RegExp(`\\bclass\\s+${name}\\b`));
        expect(declaration, name).toBeGreaterThan(0);
        // Only the annotations on the test class itself: the header starts
        // where a type declared before it ends, a brace closed outside any
        // parentheses (an annotation's array initializer sits inside them).
        let start = 0;
        for (let i = 0, braces = 0, parens = 0; i < declaration; i++) {
          if (code[i] === '(') parens++;
          else if (code[i] === ')') parens--;
          else if (code[i] === '{') braces++;
          else if (code[i] === '}' && --braces === 0 && parens === 0)
            start = i + 1;
        }
        return { name, header: code.slice(start, declaration) };
      })
      .filter(({ header }) =>
        /@\s*(?:[\w.]+\.)?(?:SpringBootTest|SpringJUnitConfig|SpringJUnitWebConfig|ContextConfiguration)\b/.test(
          header,
        ),
      );
    expect(contexts.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        'HostedConcurrentTurnBurstMySqlIT',
        'HostedWorkspaceRecoveryWorkerIT',
      ]),
    );
    for (const { name, header } of contexts) {
      const dirties = header.match(
        /@\s*(?:[\w.]+\.)?DirtiesContext\b(?:\s*\(([^)]*)\))?/,
      );
      expect(dirties, name).not.toBeNull();
      // classMode defaults to AFTER_CLASS; AFTER_EACH_TEST_METHOD also
      // closes the context before the next class starts.
      const mode = (dirties[1] ?? '').match(
        /\bclassMode\s*=\s*(?:[\w.]+\s*\.\s*)*(\w+)/,
      );
      if (mode !== null) {
        expect(['AFTER_CLASS', 'AFTER_EACH_TEST_METHOD'], name).toContain(
          mode[1],
        );
      }
    }
  });
});
