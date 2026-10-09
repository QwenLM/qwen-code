import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { LOCATIONS } from '../flyway-migration-utils.js';

const workflow = readFileSync('.github/workflows/sdk-java.yml', 'utf8');
const job = (name) => {
  const start = workflow.indexOf(`  ${name}:`);
  const next = workflow.slice(start + 1).search(/\n {2}[a-z0-9-]+:\n/);
  return workflow.slice(start, next < 0 ? undefined : start + 1 + next);
};

const step = (block, name) => {
  const marker = `      - name: '${name}'`;
  const start = block.indexOf(marker);
  if (start < 0) throw new Error(`Missing workflow step: ${name}`);
  const next = block.slice(start + 1).search(/\n {6}- name:/);
  return block.slice(start, next < 0 ? undefined : start + 1 + next);
};

describe('SDK Java self-hosted workflow guards', () => {
  it.each(['test', 'daemon-e2e'])('protects the %s job', (name) => {
    const block = job(name);
    for (const fragment of [
      "github.repository == ''QwenLM/qwen-code''",
      'github.event.pull_request.head.repo.full_name == github.repository',
      "vars.MAINTAINER_ECS_RUNNER_DISABLED != ''true''",
      // Write-access fork authors route to ECS too; the association list is
      // the repo's established trusted set. Negative associations (CONTRIBUTOR,
      // NONE, '') fail contains() and stay hosted.
      'contains(fromJSON(\'\'["OWNER","MEMBER","COLLABORATOR"]\'\'), github.event.pull_request.author_association)',
      'fromJSON(\'\'["self-hosted", "linux", "x64", "ecs-qwen"]\'\')',
      "format('refs/pull/{0}/head', github.event.pull_request.number)",
      "EXPECTED_SHA: '${{ github.event.pull_request.head.sha }}'",
      'git merge-base --is-ancestor "${EXPECTED_SHA}" HEAD',
      'exit 1',
    ]) {
      expect(block).toContain(fragment);
    }
  });

  it('serializes latency-sensitive tests on each physical ECS host', () => {
    const block = job('test');
    expect(block).toContain(
      'if: "${{ runner.environment == \'self-hosted\' }}"',
    );
    expect(block).toContain(
      'exec 9>"${HOME}/.cache/qwen-code-ci/sdk-java-tests.lock"',
    );
    expect(block).toContain('flock --wait 1200 9');
    expect(block).toContain(
      '::error::sdk-java host lock not acquired within 20 minutes',
    );
    expect(block).toContain(
      'if: "${{ runner.environment == \'github-hosted\' }}"',
    );
  });

  it('runs Runtime Broker tests from the sibling module on self-hosted Java 21', () => {
    const block = step(job('test'), 'Run Java SDK tests (self-hosted)');
    expect(block).toContain("working-directory: 'packages/sdk-java/qwencode'");
    expect(block).toContain("MATRIX_JAVA: '${{ matrix.java }}'");
    expect(block).toContain(
      'mvn --batch-mode --no-transfer-progress clean test\n' +
        '          if [ "${MATRIX_JAVA}" = "21" ]; then\n' +
        '            cd ../runtime-broker\n' +
        '            mvn --batch-mode --no-transfer-progress clean test\n' +
        '          fi',
    );
  });

  it.each(['test', 'daemon-e2e'])(
    'keeps setup-java Maven files job-local in the %s job',
    (name) => {
      const block = job(name);
      expect(block).toContain(
        "settings-path: '${{ runner.temp }}/setup-java-m2'",
      );
      expect(
        block.match(
          /MAVEN_ARGS: '--settings \$\{\{ runner\.temp \}\}\/setup-java-m2\/settings\.xml --toolchains \$\{\{ runner\.temp \}\}\/setup-java-m2\/toolchains\.xml'/g,
        ),
      ).toHaveLength(name === 'test' ? 6 : 1);
      expect(block).not.toContain('Drop shared Maven toolchains.xml');
      expect(block).not.toContain('rm -f "${HOME}/.m2/toolchains.xml"');
    },
  );
});

// #12940: the duplicate-version guard is the fast lane for a collision two
// green PRs can only produce in the merge result, so it runs on every
// trigger — no job-level condition, no Java, no database. #13245 moved its
// trusted runs onto the ECS pool (a seconds-long scan sat 26 minutes in the
// hosted queue); untrusted fork PRs stay hosted.
describe('SDK Java Flyway migration version guard', () => {
  it('runs the uniqueness check as an unconditional job', () => {
    const block = job('flyway-migrations');
    const parsed = parse(workflow).jobs['flyway-migrations'];
    expect(parsed.if).toBeUndefined();
    for (const fragment of [
      "github.event_name != ''pull_request''",
      'github.event.pull_request.head.repo.full_name == github.repository',
      "vars.MAINTAINER_ECS_RUNNER_DISABLED != ''true''",
      'fromJSON(\'\'["self-hosted", "linux", "x64", "ecs-qwen"]\'\')',
      "fromJSON(''[\"ubuntu-latest\"]'')",
    ]) {
      expect(block).toContain(fragment);
    }
    // The merge result is the point: keep the default merge-ref checkout on
    // the pool too, never the refs/pull/N/head the build lanes use.
    expect(block).toContain('actions/checkout@');
    expect(block).not.toContain('refs/pull/');
    const steps = parsed.steps.map((s) => s.name);
    expect(steps.indexOf('Restore workspace ownership')).toBeLessThan(
      steps.indexOf('Checkout'),
    );
    expect(block).toContain(
      "run: 'node scripts/check-flyway-migrations.js packages/sdk-java/managed-agent-server packages/sdk-java/runtime-broker packages/sdk-java/qwencode'",
    );
  });

  it('scans every sdk-java module that owns a db/migration directory', () => {
    // The guard's premise is the shared classpath:db/migration namespace —
    // managed-agent-server depends on runtime-broker, so one invocation must
    // name every module that owns a migration sequence. Derive the
    // expectation from the tree: a module that grows a db/migration without
    // joining the invocation turns this red.
    const owners = new Set();
    for (const entry of readdirSync('packages/sdk-java', {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      for (const location of [
        'src/main/resources/db/migration',
        'src/main/java/db/migration',
      ]) {
        if (existsSync(join('packages/sdk-java', entry.name, location))) {
          owners.add(`packages/sdk-java/${entry.name}`);
        }
      }
    }
    expect(owners.size).toBeGreaterThan(0);
    const block = job('flyway-migrations');
    for (const owner of owners) {
      expect(block).toContain(owner);
    }
  });

  it('triggers the workflow when the guard script itself changes', () => {
    const yml = parse(workflow);
    for (const event of ['pull_request', 'push']) {
      expect(yml.on[event].paths).toContain(
        'scripts/check-flyway-migrations.js',
      );
      expect(yml.on[event].paths).toContain(
        'scripts/flyway-migration-utils.js',
      );
    }
  });
});

// #13742: the guard above sees each PR merged with the main of the moment it
// ran. This workflow re-checks every open PR whenever main gains a
// migration, from the API's file lists, and marks each PR head with a status.
describe('SDK Java Flyway re-check of open PRs', () => {
  const recheck = parse(
    readFileSync('.github/workflows/sdk-java-flyway-open-prs.yml', 'utf8'),
  );
  const job = recheck.jobs.recheck;
  const moduleArgs = (run) =>
    run.replace(/^node scripts\/check-flyway-[a-z-]+\.js /, '').split(' ');

  it('runs after every push to main that changes a migration, and on a schedule', () => {
    expect(Object.keys(recheck.on).sort()).toEqual([
      'push',
      'schedule',
      'workflow_dispatch',
    ]);
    expect(recheck.on.schedule).toEqual([{ cron: '7,37 * * * *' }]);
    expect(recheck.on.push.branches).toEqual(['main']);
    // Every location the scripts scan, so a new one cannot go unwatched.
    expect(recheck.on.push.paths).toEqual([
      ...LOCATIONS.map(
        (location) => `packages/sdk-java/*/${location.dir.join('/')}/**`,
      ),
      'scripts/check-flyway-open-prs.js',
      'scripts/flyway-migration-utils.js',
      '.github/workflows/sdk-java-flyway-open-prs.yml',
    ]);
    // A dispatch from another branch would run that branch's workflow.
    expect(job.if).toBe(
      "${{ github.repository == 'QwenLM/qwen-code' && github.ref == 'refs/heads/main' }}",
    );
  });

  it('holds only the token scopes the status write needs', () => {
    expect(recheck.permissions).toEqual({ contents: 'read' });
    expect(job.permissions).toEqual({
      contents: 'read',
      'pull-requests': 'read',
      statuses: 'write',
    });
    const checkout = job.steps.find((s) =>
      String(s.uses ?? '').startsWith('actions/checkout'),
    );
    // main, not the triggering commit: a re-run must not write statuses
    // computed against an older main over a newer run's.
    expect(checkout.with).toEqual({
      ref: 'main',
      'persist-credentials': false,
    });
  });

  it('lets a newer main queue behind a running re-check instead of cancelling it', () => {
    // Keyed by ref: a skipped dispatch from another branch must not replace
    // a pending main run.
    expect(recheck.concurrency).toEqual({
      group: 'sdk-java-flyway-open-prs-${{ github.ref }}',
      'cancel-in-progress': false,
    });
  });

  it('routes to the ECS pool behind the kill-switch', () => {
    expect(job['runs-on']).toBe(
      '${{ (github.repository == \'QwenLM/qwen-code\' && vars.MAINTAINER_ECS_RUNNER_DISABLED != \'true\') && fromJSON(\'["self-hosted", "linux", "x64", "ecs-qwen"]\') || fromJSON(\'["ubuntu-latest"]\') }}',
    );
  });

  it('scans the same modules as the guard, each one level under packages/sdk-java', () => {
    const guard = parse(workflow).jobs['flyway-migrations'].steps.find(
      (s) => s.name === 'Check Flyway migration versions are unique',
    ).run;
    const run = job.steps.find((s) => s.name === 'Re-check open pull requests');
    expect(run.run.startsWith('node scripts/check-flyway-open-prs.js ')).toBe(
      true,
    );
    expect(run.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
    expect(moduleArgs(run.run)).toEqual(moduleArgs(guard));
    // The push filter's `*` matches one path segment.
    for (const module of moduleArgs(run.run)) {
      expect(module).toMatch(/^packages\/sdk-java\/[^/]+$/);
    }
  });
});

describe('SDK Java Hosted latency baseline CI contract', () => {
  it('includes latency paths in pull_request and push triggers', () => {
    const yml = parse(workflow);
    const paths = [
      'integration-tests/cli/hosted-latency-baseline.test.ts',
      'integration-tests/baselines/hosted-latency.json',
      'integration-tests/helpers/hosted-*',
      'integration-tests/fake-openai-server.ts',
      'packages/sdk-typescript/src/daemon/**',
    ];
    for (const event of ['pull_request', 'push']) {
      for (const p of paths) {
        expect(yml.on[event].paths).toContain(p);
      }
    }
  });

  it('checks hosted latency measurements directly after failsafe reports', () => {
    const block = job('hosted-harness-mysql');
    const failsafeStep = step(
      block,
      'Check that every Hosted integration test class ran',
    );
    const latencyStep = step(block, 'Check Hosted latency measurements');

    const failsafeIndex = block.indexOf(failsafeStep);
    const latencyIndex = block.indexOf(latencyStep);
    // Assert adjacency: latency step must immediately follow the failsafe step
    expect(latencyIndex).toBeGreaterThan(failsafeIndex);
    const between = block.slice(
      failsafeIndex + failsafeStep.length,
      latencyIndex,
    );
    expect(between).not.toContain('- name:');

    expect(failsafeStep).toContain(
      'node scripts/check-failsafe-reports.js hosted packages/sdk-java/managed-agent-server',
    );
    expect(latencyStep).toContain(
      'test -s packages/sdk-java/managed-agent-server/target/hosted-latency-baseline.json',
    );
    expect(latencyStep).toContain(
      'npx vitest run cli/hosted-latency-baseline.test.ts',
    );
  });

  it('uploads the hosted-latency-baseline.json artifact', () => {
    const block = job('hosted-harness-mysql');
    const uploadStep = step(block, 'Upload Hosted process reports');
    expect(uploadStep).toContain('actions/upload-artifact@');
    expect(uploadStep).toContain(
      'packages/sdk-java/managed-agent-server/target/hosted-latency-baseline.json',
    );
  });
});

// #13506: the pool-routed legs inherited only the bare ownership restore
// while ci.yml grew the rest of its pre-checkout hygiene across
// recorded incidents — the safe.directory trust after #12648 and the
// stale-.qwen sweep after the 33146730771 checkout poisoning. A leftover
// review/autofix residue on a shared ECS host failed this workflow's
// Checkout step on main. Pin every pool job to restore → sweep → checkout
// and pin both step bodies byte-identical to the ci.yml copies so the two
// files cannot drift apart (ci.yml's own copies are pinned the same way in
// scripts/tests/review-worktree-cleanup-workflow.test.js).
describe('SDK Java pre-checkout hygiene on the ECS pool', () => {
  const docs = {
    'sdk-java.yml': parse(workflow),
    'sdk-java-flyway-open-prs.yml': parse(
      readFileSync('.github/workflows/sdk-java-flyway-open-prs.yml', 'utf8'),
    ),
  };
  const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const ciSteps = Object.values(ci.jobs).flatMap((job) => job.steps ?? []);
  const ciSweep = ciSteps.find(
    (s) => s.name === 'Clean stale .qwen before checkout',
  )?.run;
  const ciRestore = ciSteps.find(
    (s) => s.name === 'Restore workspace ownership',
  )?.run;
  const poolJobs = [
    ['sdk-java.yml', 'test'],
    ['sdk-java.yml', 'flyway-migrations'],
    ['sdk-java.yml', 'daemon-e2e'],
    ['sdk-java-flyway-open-prs.yml', 'recheck'],
  ];

  it.each(poolJobs)(
    'restores ownership, sweeps stale .qwen, then checks out in %s %s',
    (file, name) => {
      const steps = docs[file].jobs[name].steps;
      const names = steps.map((s) => s.name);
      const restoreIdx = names.indexOf('Restore workspace ownership');
      const sweepIdx = names.indexOf('Clean stale .qwen before checkout');
      const checkoutIdx = steps.findIndex((s) =>
        String(s.uses ?? '').includes('actions/checkout'),
      );
      expect(restoreIdx, name).toBeGreaterThanOrEqual(0);
      expect(sweepIdx, name).toBeGreaterThan(restoreIdx);
      expect(sweepIdx, name).toBeLessThan(checkoutIdx);
      // The matrix legs on fresh hosted VMs never take this branch, and
      // Windows would run it under pwsh — the recipe is bash.
      expect(steps[sweepIdx].if).toBe(
        "${{ runner.environment == 'self-hosted' }}",
      );
    },
  );

  it.each(poolJobs)(
    'keeps the %s %s restore and sweep bodies byte-identical to ci.yml',
    (file, name) => {
      const steps = docs[file].jobs[name].steps;
      const restore = steps.find(
        (s) => s.name === 'Restore workspace ownership',
      )?.run;
      const sweep = steps.find(
        (s) => s.name === 'Clean stale .qwen before checkout',
      )?.run;
      expect(ciRestore).toBeDefined();
      expect(ciSweep).toBeDefined();
      expect(restore, name).toBe(ciRestore);
      expect(sweep, name).toBe(ciSweep);
    },
  );

  it.each(poolJobs)(
    'trusts the workspace as a git safe.directory in %s %s',
    (file, name) => {
      const restore = docs[file].jobs[name].steps.find(
        (s) => s.name === 'Restore workspace ownership',
      )?.run;
      expect(restore).toContain(
        'git config --global --add safe.directory "$GITHUB_WORKSPACE"',
      );
    },
  );
});
