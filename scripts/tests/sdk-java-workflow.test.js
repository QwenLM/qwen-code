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

  it.each(['test', 'mysql-integration', 'daemon-e2e'])(
    'keeps setup-java Maven files job-local in the %s job',
    (name) => {
      const block = job(name);
      expect(block).toContain(
        "settings-path: '${{ runner.temp }}/setup-java-m2'",
      );
      // Two tail-anchored forms, no prefix match: mysql-integration appends
      // a job-local -Dmaven.repo.local to two of its three MAVEN_ARGS
      // (pinned by the 'installs and verifies against one job-local Maven
      // repository' test); the other jobs must carry no suffix at all — an
      // appended -DskipTests would be word-split live by the mvn launcher.
      const exact = block.match(
        /MAVEN_ARGS: '--settings \$\{\{ runner\.temp \}\}\/setup-java-m2\/settings\.xml --toolchains \$\{\{ runner\.temp \}\}\/setup-java-m2\/toolchains\.xml'/g,
      );
      const jobLocal = block.match(
        /MAVEN_ARGS: '--settings \$\{\{ runner\.temp \}\}\/setup-java-m2\/settings\.xml --toolchains \$\{\{ runner\.temp \}\}\/setup-java-m2\/toolchains\.xml -Dmaven\.repo\.local=\$\{\{ runner\.temp \}\}\/m2-repo'/g,
      );
      expect((exact?.length ?? 0) + (jobLocal?.length ?? 0)).toBe(
        { test: 6, 'mysql-integration': 3, 'daemon-e2e': 1 }[name],
      );
      if (name !== 'mysql-integration') expect(jobLocal).toBeNull();
      expect(block).not.toContain('Drop shared Maven toolchains.xml');
      expect(block).not.toContain('rm -f "${HOME}/.m2/toolchains.xml"');
    },
  );

  it('keeps the self-hosted Maven bootstrap byte-identical across pool jobs', () => {
    // A step copied between jobs and later fixed in only one is the #13506
    // drift class; the checksum gate in this body is the security-relevant
    // part, so pin the whole body equal — not just the step name.
    const parsed = parse(workflow);
    const bodies = ['test', 'mysql-integration', 'daemon-e2e'].map((name) => {
      const s = parsed.jobs[name].steps.find(
        (candidate) => candidate.name === 'Set up Maven (self-hosted)',
      );
      expect(s, name).toBeDefined();
      expect(s.if, name).toBe("${{ runner.environment == 'self-hosted' }}");
      return s.run;
    });
    expect(bodies[1]).toBe(bodies[0]);
    expect(bodies[2]).toBe(bodies[0]);
    expect(bodies[0]).toContain('sha512sum --check');
    expect(bodies[0]).toContain('>> "${GITHUB_PATH}"');
  });
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

// #13623: three main runs lost their GitHub-hosted lanes to runner-queue
// starvation — every failed job recorded zero steps and no assigned runner
// while the pool legs passed. The MariaDB lane is pool-safe (per-job service
// container, no host installs), so its trusted runs route to the ECS pool the
// way the flyway guard's do; untrusted fork PRs stay hosted.
describe('SDK Java MariaDB lane on the ECS pool', () => {
  it('routes trusted mysql-integration runs to the pool', () => {
    const block = job('mysql-integration');
    for (const fragment of [
      "github.repository == ''QwenLM/qwen-code''",
      "vars.MAINTAINER_ECS_RUNNER_DISABLED != ''true''",
      "github.event_name != ''pull_request''",
      'github.event.pull_request.head.repo.full_name == github.repository',
      'contains(fromJSON(\'\'["OWNER","MEMBER","COLLABORATOR"]\'\'), github.event.pull_request.author_association)',
      'fromJSON(\'\'["self-hosted", "linux", "x64", "ecs-qwen"]\'\')',
      "fromJSON(''[\"ubuntu-latest\"]'')",
    ]) {
      expect(block).toContain(fragment);
    }
    // The lane stays character-identical to the flyway guard's, which the
    // evaluated routing inventory (.github/scripts/ci-runner-routing.test.mjs)
    // covers: a restructured expression (e.g. a flipped connective, invisible
    // to the fragment pins above) breaks the tie and turns this red.
    expect(parse(workflow).jobs['mysql-integration']['runs-on']).toBe(
      parse(workflow).jobs['flyway-migrations']['runs-on'],
    );
    // The default merge-ref checkout is deliberate (recorded at the job's
    // Checkout step): never the refs/pull/N/head the build lanes use.
    expect(block).toContain('actions/checkout@');
    expect(block).not.toContain('refs/pull/');
  });

  it('keeps the MariaDB service on a random host port', () => {
    // A fixed 3306:3306 mapping collides between jobs sharing one pool host;
    // the steps read the mapped port from job.services.mariadb.ports.
    const parsed = parse(workflow);
    expect(parsed.jobs['mysql-integration'].services.mariadb.ports).toEqual([
      '3306/tcp',
    ]);
    const block = job('mysql-integration');
    expect(block).not.toContain('3306:3306');
    expect(block).not.toContain('127.0.0.1:3306');
    expect(
      block.match(
        /MYSQL_PORT: "\$\{\{ job\.services\.mariadb\.ports\['3306'\] \}\}"/g,
      ),
    ).toHaveLength(2);
    // The consumer is the link that carries the random port into the tests:
    // both mvn lines must interpolate ${MYSQL_PORT}, or the declaration is
    // dead and the fixed-port collision returns. hosted-harness-mysql's two
    // -Dmysql.url lines read job.services.mysql and live outside this block.
    expect(
      block.match(
        /-Dmysql\.url="jdbc:mysql:\/\/127\.0\.0\.1:\$\{MYSQL_PORT\}\//g,
      ),
    ).toHaveLength(2);
  });

  it('holds the per-host sdk-java lock around every Maven run', () => {
    // Derived from the parsed steps, not a string count: every Maven-bearing
    // step must open the test job's per-host lock — the shared path pinned
    // for the test job above is what makes the two jobs mutually exclusive
    // on one ECS host — and wait on it with the pinned literal.
    const parsed = parse(workflow);
    const mavenSteps = parsed.jobs['mysql-integration'].steps.filter(
      (s) => typeof s.run === 'string' && s.run.includes('mvn '),
    );
    expect(mavenSteps.map((s) => s.name)).toEqual([
      'Run Runtime Broker MySQL integration tests',
      'Install Managed Agent dependencies',
      'Run Managed Agent tests, Checkstyle, and MySQL integration',
    ]);
    for (const s of mavenSteps) {
      expect(s.run, s.name).toContain(
        'exec 9>"${HOME}/.cache/qwen-code-ci/sdk-java-tests.lock"',
      );
      expect(s.run, s.name).toContain('flock --wait 1200 9');
    }
    // The ceiling must absorb one full lock wait per acquisition — this job
    // takes the lock once per Maven step — plus the ~14 minutes of measured
    // Maven work: pool run 37743332082 recorded 1193 s of waits and 818 s of
    // holds, and 25 minutes already cancelled this lane once (run
    // 37692037879). Derived from the step count so a fourth locked step
    // turns this red instead of silently over-drawing the budget.
    expect(
      parsed.jobs['mysql-integration']['timeout-minutes'] * 60,
    ).toBeGreaterThanOrEqual(mavenSteps.length * 1200 + 14 * 60);
    // The sibling test job shares the same per-host lock: its ceiling must
    // cover one full wait plus its own measured locked work (~5 minutes on
    // the Java 21 leg of run 37743332082) — this job's holds now consume
    // part of that wait budget, and nothing else asserts the headroom.
    expect(parsed.jobs.test['timeout-minutes'] * 60).toBeGreaterThanOrEqual(
      1200 + 5 * 60,
    );
  });

  it('installs and verifies against one job-local Maven repository', () => {
    // The per-step lock releases at each step boundary, so the fixed
    // 0.1.0-alpha release coordinates must not round-trip through the
    // host-shared ~/.m2: the install step and the verify step resolve from
    // the same job-local repo, seeded from the shared cache inside the lock.
    const steps = parse(workflow).jobs['mysql-integration'].steps;
    const install = steps.find(
      (s) => s.name === 'Install Managed Agent dependencies',
    );
    const verify = steps.find(
      (s) =>
        s.name === 'Run Managed Agent tests, Checkstyle, and MySQL integration',
    );
    for (const s of [install, verify]) {
      expect(s?.env?.MAVEN_ARGS, s?.name).toContain(
        '-Dmaven.repo.local=${{ runner.temp }}/m2-repo',
      );
    }
    // The runtime-broker step must not join them: Maven creates the
    // job-local directory the moment any goal runs with the override, so the
    // seed's cp -aln would hit an existing destination and nest one level
    // down (m2-repo/repository/…), and the write-back would extract that
    // bogus tree into the host-shared repo. The per-job count pin above is
    // invariant under moving the override between this job's steps, so pin
    // the step.
    const broker = steps.find(
      (s) => s.name === 'Run Runtime Broker MySQL integration tests',
    );
    expect(broker?.env?.MAVEN_ARGS, broker?.name).not.toContain(
      '-Dmaven.repo.local',
    );
    expect(install.run).toContain(
      'cp -aln "${HOME}/.m2/repository" "${RUNNER_TEMP}/m2-repo"',
    );
    // The write-back closes the cache: 'maven' loop — the seed above only
    // reads the cache-saved ~/.m2, so without it a pom key rotation saves a
    // thin entry that never recaptures the managed-agent-server tree. The
    // excludes name the three in-house fixed release coordinates, not the
    // whole com/alibaba group, so third-party artifacts under it (druid)
    // still recapture. The pipeline is best-effort like the seed: the
    // warning arm keeps a copy failure from reddening the gate after mvn
    // has already passed, and pipefail keeps a failing left-hand tar from
    // being masked by the extractor's exit 0.
    expect(verify.run).toContain('set -o pipefail');
    expect(verify.run).toContain(
      'tar -C "${RUNNER_TEMP}/m2-repo" --exclude=./com/alibaba/qwencode-sdk --exclude=./com/alibaba/qwen-managed-runtime-broker --exclude=./com/alibaba/qwen-managed-agent-server -cf - .',
    );
    expect(verify.run).toContain(
      'tar -C "${HOME}/.m2/repository" --skip-old-files -xf -',
    );
    expect(verify.run).toContain(
      '|| echo "::warning::Maven cache write-back failed; the gate result above is unaffected"',
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
    ['sdk-java.yml', 'mysql-integration'],
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
