import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { globSync } from 'glob';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { LOCATIONS } from '../flyway-migration-utils.js';
import {
  CONTRACT_DOCUMENT,
  CONTRACT_DOCUMENT_PREDECESSOR,
} from '../contract-version-utils.js';

const brokerTestPattern = ['Test*', '*Test', '*Tests', '*TestCase']
  .map((pattern) => `com/alibaba/qwen/code/runtimebroker/**/${pattern}.java`)
  .join(',');

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
  it('builds native producer prerequisites before either Server test lane', () => {
    const jobs = parse(workflow).jobs;
    for (const name of ['mysql-integration', 'hosted-harness-mysql']) {
      const steps = jobs[name].steps;
      const install = steps.findIndex((s) =>
        s.run?.includes('corepack pnpm install --frozen-lockfile'),
      );
      const verify = steps.findIndex(
        (s) =>
          (s['working-directory'] === 'packages/managed-agent-server' ||
            s.run?.includes('-f packages/managed-agent-server/pom.xml')) &&
          s.run?.includes('clean verify'),
      );
      expect(install, name).toBeGreaterThan(-1);
      expect(verify, name).toBeGreaterThan(install);
      expect(steps[install].run, name).not.toContain('--ignore-scripts');
    }
  });

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
      "ref: '${{ inputs.ref || github.sha }}'",
    ]) {
      expect(block).toContain(fragment);
    }
  });

  it('sizes the daemon-e2e budget for the stretched setup on the fast tier', () => {
    // The fast tier runs this leg on every touched PR push instead of nightly
    // only, so it meets the ~44 min stretched-setup tail far more often than a
    // 45 ceiling leaves room for. This budget was originally sized for the
    // post-job Maven cache save, which #14396 has since suppressed on
    // self-hosted runners; a killed job concludes cancelled and reddens the
    // gate of a green suite either way. The full tier keeps the budget the
    // stretched-setup sizing below justifies.
    expect(parse(workflow).jobs['daemon-e2e']['timeout-minutes']).toBe(
      "${{ inputs.tier == 'fast' && 90 || 45 }}",
    );
  });

  it('serializes latency-sensitive tests on each physical ECS host', () => {
    const block = job('test');
    expect(block).toContain(
      'if: "${{ runner.environment == \'self-hosted\' }}"',
    );
    expect(block).toContain(
      'exec 9>"${HOME}/.cache/qwen-code-ci/sdk-java-tests.lock"',
    );
    expect(block).toContain('flock --wait 3600 9');
    expect(block).toContain(
      '::error::sdk-java host lock not acquired within 60 minutes',
    );
    expect(block).toContain(
      'if: "${{ runner.environment == \'github-hosted\' }}"',
    );
  });

  it('runs Broker tests from the combined Server after installing the SDK on self-hosted Java 21', () => {
    const block = step(job('test'), 'Run Java SDK tests (self-hosted)');
    expect(block).toContain("working-directory: 'packages/sdk-java/qwencode'");
    expect(block).toContain("MATRIX_JAVA: '${{ matrix.java }}'");
    expect(block).toContain("TIER: '${{ inputs.tier }}'");
    expect(block).toContain(
      'mvn --batch-mode --no-transfer-progress clean test\n' +
        '          if [ "${MATRIX_JAVA}" = "21" ]; then\n' +
        '            mvn --batch-mode --no-transfer-progress -DskipTests -Dgpg.skip=true -Dmaven.javadoc.skip=true install\n' +
        '            cd ../../managed-agent-server\n' +
        '            # The fast tier skips mysql-integration, which owns the full H2 unit suite.\n' +
        '            if [ "${TIER}" = "fast" ]; then\n' +
        '              mvn --batch-mode --no-transfer-progress clean test\n' +
        '            else\n' +
        `              mvn --batch-mode --no-transfer-progress '-Dtest=${brokerTestPattern}' clean test\n` +
        '            fi\n' +
        '          fi',
    );
  });

  it('runs the Broker suite on hosted Java 21 after installing its SDK dependency', () => {
    const block = step(job('test'), 'Run Runtime Broker state tests');
    const hosted = parse(workflow).jobs.test.steps.find(
      (candidate) => candidate.name === 'Run Runtime Broker state tests',
    );
    expect(hosted.shell).toBe('bash');
    expect(block).toContain(
      "working-directory: 'packages/managed-agent-server'",
    );
    expect(block).toContain("matrix.java == '21'");
    expect(block.indexOf('../sdk-java/qwencode/pom.xml')).toBeLessThan(
      block.indexOf('clean test'),
    );
    expect(block).toContain(`'-Dtest=${brokerTestPattern}'`);
    expect(block).toContain("TIER: '${{ inputs.tier }}'");
    expect(hosted.run).toContain(
      'if [ "${TIER}" = "fast" ]; then\n' +
        '  mvn --batch-mode --no-transfer-progress clean test\n' +
        'else\n' +
        `  mvn --batch-mode --no-transfer-progress '-Dtest=${brokerTestPattern}' clean test\n` +
        'fi',
    );
  });

  it('builds the JavaScript the full module suite loads before the fast tier runs it', () => {
    const steps = parse(workflow).jobs.test.steps;
    const names = steps.map((candidate) => candidate.name);
    const build = steps.find(
      (candidate) =>
        candidate.name ===
        'Build Managed Agent JavaScript prerequisites (fast tier)',
    );
    expect(build.if).toBe("${{ inputs.tier == 'fast' }}");
    expect(build.run).toBe(
      parse(workflow).jobs['mysql-integration'].steps.find(
        (candidate) => candidate.name === 'Build native producer prerequisites',
      ).run,
    );
    for (const later of [
      'Run Java SDK tests (self-hosted)',
      'Run Runtime Broker state tests',
    ]) {
      expect(names.indexOf(build.name)).toBeLessThan(names.indexOf(later));
    }
    expect(names.indexOf('Set up Node.js 22 (hosted)')).toBeLessThan(
      names.indexOf(build.name),
    );
  });

  it.skipIf(process.platform === 'win32').each([0, 23])(
    'gates the hosted Broker test command on SDK install exit %s',
    (installStatus) => {
      const hosted = parse(workflow).jobs.test.steps.find(
        (candidate) => candidate.name === 'Run Runtime Broker state tests',
      );
      expect(hosted.shell).toBe('bash');
      const result = spawnSync(
        hosted.shell,
        [
          '--noprofile',
          '--norc',
          '-e',
          '-o',
          'pipefail',
          '-c',
          `mvn() {
            printf 'ARG<%s>\\n' "$@"
            if [[ "$*" == *" install" ]]; then return "$SDK_INSTALL_STATUS"; fi
            printf 'BROKER_TESTS_RAN\\n'
          }
          ${hosted.run}`,
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, SDK_INSTALL_STATUS: String(installStatus) },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(installStatus);
      expect(result.stdout).toContain('ARG<-Dgpg.skip=true>');
      expect(result.stdout).toContain('ARG<-Dmaven.javadoc.skip=true>');
      expect(result.stdout.includes('BROKER_TESTS_RAN')).toBe(
        installStatus === 0,
      );
      if (installStatus === 0) {
        expect(result.stdout).toContain(`ARG<-Dtest=${brokerTestPattern}>`);
      }
    },
  );

  it('keeps the Broker matrix selector matched to every default test including nested packages', () => {
    const cwd = 'packages/managed-agent-server/src/test/java';
    const prefix = 'com/alibaba/qwen/code/runtimebroker';
    const selected = [
      ...new Set(
        brokerTestPattern
          .split(',')
          .flatMap((pattern) => globSync(pattern, { cwd })),
      ),
    ].sort();
    const defaults = globSync(
      `${prefix}/**/{Test*,*Test,*Tests,*TestCase}.java`,
      { cwd },
    ).sort();
    expect(selected.length).toBeGreaterThan(0);
    expect(selected).toEqual(defaults);
    expect(selected.some((file) => file.includes('/managedworkspace/'))).toBe(
      true,
    );
    expect(selected.some((file) => file.includes('/managedschema/'))).toBe(
      true,
    );
    expect(
      readFileSync('packages/managed-agent-server/pom.xml', 'utf8'),
    ).toContain('<failIfNoTests>true</failIfNoTests>');
  });

  it('checks both package rulesets in the standalone Checkstyle lane', () => {
    const block = step(job('test'), 'Run Managed Agent Server Checkstyle');
    expect(block).toContain(
      'checkstyle:check checkstyle:check@runtime-broker-checkstyle',
    );
  });

  it.each([
    'test',
    'mysql-integration',
    'daemon-e2e',
    'event-transport-broker',
    'event-transport-multi-node',
  ])('keeps setup-java Maven files job-local in the %s job', (name) => {
    const block = job(name);
    expect(block).toContain(
      "settings-path: '${{ runner.temp }}/setup-java-m2'",
    );
    // Two tail-anchored forms, no prefix match: mysql-integration appends
    // a job-local -Dmaven.repo.local to two of its three MAVEN_ARGS
    // (pinned by the 'installs and verifies against one job-local Maven
    // repository' test), the EventTransport lanes to both of theirs; the
    // other jobs must carry no suffix at all — an appended -DskipTests
    // would be word-split live by the mvn launcher.
    const exact = block.match(
      /MAVEN_ARGS: '--settings \$\{\{ runner\.temp \}\}\/setup-java-m2\/settings\.xml --toolchains \$\{\{ runner\.temp \}\}\/setup-java-m2\/toolchains\.xml'/g,
    );
    const jobLocal = block.match(
      /MAVEN_ARGS: '--settings \$\{\{ runner\.temp \}\}\/setup-java-m2\/settings\.xml --toolchains \$\{\{ runner\.temp \}\}\/setup-java-m2\/toolchains\.xml -Dmaven\.repo\.local=\$\{\{ runner\.temp \}\}\/m2-repo'/g,
    );
    expect((exact?.length ?? 0) + (jobLocal?.length ?? 0)).toBe(
      {
        test: 6,
        'mysql-integration': 2,
        'daemon-e2e': 1,
        'event-transport-broker': 2,
        'event-transport-multi-node': 2,
      }[name],
    );
    if (name.startsWith('event-transport-')) {
      expect(exact).toBeNull();
      expect(block).toContain(
        'cp -aln "${HOME}/.m2/repository" "${RUNNER_TEMP}/m2-repo"',
      );
    } else if (name !== 'mysql-integration') {
      expect(jobLocal).toBeNull();
    }
    expect(block).not.toContain('Drop shared Maven toolchains.xml');
    expect(block).not.toContain('rm -f "${HOME}/.m2/toolchains.xml"');
  });

  it('keeps the self-hosted Maven bootstrap byte-identical across pool jobs', () => {
    // A step copied between jobs and later fixed in only one is the #13506
    // drift class; the checksum gate in this body is the security-relevant
    // part, so pin the whole body equal — not just the step name.
    const parsed = parse(workflow);
    const reference = parse(
      readFileSync(
        '.github/workflows/release-managed-agent-reference.yml',
        'utf8',
      ),
    );
    const bodies = [
      ...[
        'test',
        'mysql-integration',
        'daemon-e2e',
        'event-transport-broker',
        'event-transport-multi-node',
      ].map((name) => parsed.jobs[name]),
      reference.jobs.build,
    ].map((pooledJob, index) => {
      const s = pooledJob.steps.find(
        (candidate) => candidate.name === 'Set up Maven (self-hosted)',
      );
      expect(s, String(index)).toBeDefined();
      expect(s.if, String(index)).toBe(
        "${{ runner.environment == 'self-hosted' }}",
      );
      return s.run;
    });
    for (const body of bodies.slice(1)) expect(body).toBe(bodies[0]);
    expect(reference.jobs.build.env).toEqual({
      MAVEN_VERSION: parsed.env.MAVEN_VERSION,
      MAVEN_SHA512: parsed.env.MAVEN_SHA512,
      MYSQL_CONTAINER:
        'qwen-code-reference-mysql-${{ github.run_id }}-${{ github.run_attempt }}',
    });
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
    // Every lane checks the release commit, or the event SHA on daily runs.
    expect(block).toContain('actions/checkout@');
    expect(block).not.toContain('refs/pull/');
    const steps = parsed.steps.map((s) => s.name);
    expect(steps.indexOf('Restore workspace ownership')).toBeLessThan(
      steps.indexOf('Checkout'),
    );
    expect(block).toContain(
      "run: 'node scripts/check-flyway-migrations.js packages/managed-agent-server packages/sdk-java/qwencode'",
    );
  });

  it('scans every Maven module that owns a registered migration directory', () => {
    const modules = [
      'packages/managed-agent-server',
      ...readdirSync('packages/sdk-java', { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `packages/sdk-java/${entry.name}`),
    ];
    const owners = modules.filter((module) =>
      LOCATIONS.some((location) => existsSync(join(module, ...location.dir))),
    );
    expect(owners.length).toBeGreaterThan(0);
    const block = job('flyway-migrations');
    for (const owner of owners) {
      expect(block).toContain(owner);
    }
  });

  it('runs the full suite daily or on demand', () => {
    const yml = parse(workflow);
    expect(Object.keys(yml.on).sort()).toEqual([
      'schedule',
      'workflow_call',
      'workflow_dispatch',
    ]);
    expect(yml.on.schedule).toEqual([{ cron: '47 19 * * *' }]);
  });

  it('keeps the cheap migration guard in PR and post-merge CI', () => {
    const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
    expect(ci.on.pull_request.branches).toContain('main');
    expect(ci.on.push.branches).toContain('main');
    expect(ci.on.pull_request.paths).toBeUndefined();
    expect(ci.on.push.paths).toBeUndefined();
    const guard = ci.jobs.lint_and_static.steps.find(
      (s) => s.name === 'Check Flyway migration versions are unique',
    );
    expect(guard.run).toBe(
      parse(workflow).jobs['flyway-migrations'].steps.find(
        (s) => s.name === 'Check Flyway migration versions are unique',
      ).run,
    );
    expect(guard.if).toBe(
      "${{ needs.classify_pr.outputs.skip_ci != 'true' && steps.ci_profile.outputs.ci_profile != 'docs_only' }}",
    );
  });
});

// #13804: the OpenAPI document's info.version must strictly advance past
// the base ref's whenever the document changed. Consumers key capability
// detection on it, and a regressed or stalled number breaks nothing at
// runtime to be caught by — both modes were seen in flight on 2026-10-09.
// The lightweight checks share the existing PR lint job.
describe('SDK Java contract version guard', () => {
  it('runs the advance check in PR CI before dependency installation', () => {
    const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
    expect(ci.on.pull_request.branches).toContain('main');
    expect(ci.on.pull_request.paths).toBeUndefined();
    const parsed = ci.jobs.lint_and_static;
    const names = parsed.steps.map((s) => s.name);
    const index = names.indexOf('Check the API contract version advances');
    expect(index).toBeGreaterThan(names.indexOf('Checkout'));
    const step = parsed.steps[index];
    // A push has no base ref to compare against; the races that remain
    // after a pull request's check are the re-check workflow's below.
    expect(step.if).toBe(
      "${{ needs.classify_pr.outputs.skip_ci != 'true' && github.event_name == 'pull_request' && steps.ci_profile.outputs.ci_profile != 'docs_only' }}",
    );
    expect(index).toBeGreaterThan(names.indexOf('Check lint gate freshness'));
    expect(
      names.indexOf('Check Flyway migration versions are unique'),
    ).toBeGreaterThan(names.indexOf('Check lint gate freshness'));
    expect(index).toBeLessThan(
      parsed.steps.findIndex((s) => s.run?.includes('pnpm install')),
    );
    expect(step.env).toEqual({
      BASE_REF: '${{ github.event.pull_request.base.ref }}',
      GH_TOKEN: '${{ github.token }}',
      REPO: '${{ github.repository }}',
      PR_NUMBER: '${{ github.event.pull_request.number }}',
    });
    // The default checkout is one commit deep, so the comparison copy comes
    // from a depth-one fetch of the base branch's head — not of a stale
    // merge base.
    expect(step.run).toContain(
      'git fetch --quiet --depth=1 --filter=blob:none origin "refs/heads/${BASE_REF}"',
    );
    expect(step.run).toContain(CONTRACT_DOCUMENT);
    expect(parsed.permissions['pull-requests']).toBe('read');
    expect(step.run).toContain('--paginate');
    expect(step.run).toContain(
      "--jq '.[] | .filename, .previous_filename // empty'",
    );
    expect(step.run).toContain(
      'grep -qxF "${DOCUMENT}" "${RUNNER_TEMP}/contract-pr-files.txt"',
    );
    expect(step.run).toContain('node scripts/check-contract-version.js');
  });

  it.skipIf(process.platform === 'win32').each([
    { changed: false, version: '1.2.0', status: 0 },
    { changed: true, version: '1.2.0', status: 1 },
    { changed: true, version: '1.3.0', status: 0 },
  ])(
    'compares a renamed contract with its predecessor: changed=$changed version=$version',
    ({ changed, version, status }) => {
      const root = mkdtempSync(join(tmpdir(), 'contract-rename-'));
      try {
        const bin = join(root, 'bin');
        mkdirSync(bin);
        const base = join(root, 'base.json');
        writeFileSync(base, JSON.stringify({ info: { version: '1.2.0' } }));
        const document = join(root, CONTRACT_DOCUMENT);
        mkdirSync(dirname(document), { recursive: true });
        writeFileSync(
          document,
          JSON.stringify({
            info: { version },
            ...(changed ? { paths: {} } : {}),
          }),
        );
        symlinkSync(resolve('scripts'), join(root, 'scripts'), 'dir');
        for (const [name, body] of [
          ['gh', 'printf \'%s\\n\' "$PREDECESSOR"'],
          [
            'git',
            'if [ "$1" = fetch ]; then exit 0; fi\n' +
              'if [ "$1" = show ] && [ "$2" = "FETCH_HEAD:$PREDECESSOR" ]; then cat "$BASE_FIXTURE"; else exit 1; fi',
          ],
        ]) {
          writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
          chmodSync(join(bin, name), 0o755);
        }
        const run = parse(
          readFileSync('.github/workflows/ci.yml', 'utf8'),
        ).jobs.lint_and_static.steps.find(
          (step) => step.name === 'Check the API contract version advances',
        ).run;
        const result = spawnSync(
          'bash',
          [
            '-euc',
            `DOCUMENT='${CONTRACT_DOCUMENT}'\n${run.slice(run.indexOf('BASE_DOCUMENT='))}`,
          ],
          {
            cwd: root,
            encoding: 'utf8',
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH}`,
              RUNNER_TEMP: root,
              BASE_REF: 'main',
              REPO: 'QwenLM/qwen-code',
              PR_NUMBER: '1',
              BASE_FIXTURE: base,
              PREDECESSOR: CONTRACT_DOCUMENT_PREDECESSOR,
            },
          },
        );
        expect(result.status, result.stdout + result.stderr).toBe(status);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
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
      ...['packages/sdk-java/*', 'packages/managed-agent-server'].flatMap(
        (module) =>
          LOCATIONS.map((location) => `${module}/${location.dir.join('/')}/**`),
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

  it('scans the same Maven modules as the guard', () => {
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
      expect(module).toMatch(
        /^packages\/(?:sdk-java\/[^/]+|managed-agent-server)$/,
      );
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
    ).toHaveLength(1);
    // The consumer is the link that carries the random port into the tests:
    // the mvn line must interpolate ${MYSQL_PORT}, or the declaration is
    // dead and the fixed-port collision returns. hosted-harness-mysql's two
    // -Dmysql.url lines read job.services.mysql and live outside this block.
    expect(
      block.match(
        /-Dmysql\.url="jdbc:mysql:\/\/127\.0\.0\.1:\$\{MYSQL_PORT\}\//g,
      ),
    ).toHaveLength(1);
  });

  it('keeps the MariaDB datadir on tmpfs so a pool run strands no anonymous volume', () => {
    // mariadb declares VOLUME /var/lib/mysql, and the runner's service
    // teardown is `docker rm --force` without -v: an unmounted datadir
    // leaks one anonymous volume per pool run. tmpfs dies with the
    // container, cancelled runs included.
    const mariadb = parse(workflow).jobs['mysql-integration'].services.mariadb;
    expect(mariadb.options).toContain(
      '--mount type=tmpfs,destination=/var/lib/mysql',
    );
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
      'Install Managed Agent dependencies',
      'Run Managed Agent tests, Checkstyle, and MySQL integration',
    ]);
    const lockWaits = mavenSteps.map((s) => {
      expect(s.run, s.name).toContain(
        'exec 9>"${HOME}/.cache/qwen-code-ci/sdk-java-tests.lock"',
      );
      const seconds = Number(s.run.match(/flock --wait (\d+) 9/)?.[1]);
      expect(seconds, s.name).toBeGreaterThanOrEqual(50 * 60);
      return seconds;
    });
    // The ceiling must absorb one full lock wait per acquisition — this job
    // takes the lock once per Maven step — plus the ~50 minutes of measured
    // Maven work. Run 39097018288 held it for 47m26s, longer than the old
    // 40-minute acquisition budget. Derive the ceiling from the step count
    // so another locked step cannot silently overdraw it.
    expect(
      parsed.jobs['mysql-integration']['timeout-minutes'] * 60,
    ).toBeGreaterThanOrEqual(
      lockWaits.reduce((total, seconds) => total + seconds, 0) + 50 * 60,
    );
    // The sibling test job shares the same per-host lock: its ceiling must
    // cover one full wait plus its own measured locked work (~5 minutes on
    // the Java 21 leg of run 37743332082) and setup headroom. This job's holds
    // now consume part of that wait budget.
    expect(parsed.jobs.test['timeout-minutes'] * 60).toBeGreaterThanOrEqual(
      3600 + 10 * 60,
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
    expect(install.run).toContain(
      'cp -aln "${HOME}/.m2/repository" "${RUNNER_TEMP}/m2-repo"',
    );
    // The write-back closes the host-shared ~/.m2 loop — the seed above only
    // reads that repository, so without it a pom key rotation leaves a
    // thin entry that never recaptures the managed-agent-server tree. The
    // excludes name the two in-house fixed release coordinates, not the
    // whole com/alibaba group, so third-party artifacts under it (druid)
    // still recapture. The pipeline is best-effort like the seed: the
    // warning arm keeps a copy failure from reddening the gate after mvn
    // has already passed, and pipefail keeps a failing left-hand tar from
    // being masked by the extractor's exit 0.
    expect(verify.run).toContain('set -o pipefail');
    expect(verify.run).toContain('mkdir -p "${HOME}/.m2/repository"');
    expect(verify.run).toContain(
      'tar -C "${RUNNER_TEMP}/m2-repo" --exclude=./com/alibaba/qwencode-sdk --exclude=./com/alibaba/qwen-managed-agent-server -cf - .',
    );
    expect(verify.run).toContain(
      'tar -C "${HOME}/.m2/repository" --skip-old-files -xf -',
    );
    expect(verify.run).toContain(
      '|| echo "::warning::Maven cache write-back failed; the gate result above is unaffected"',
    );
  });
});

// #13804: the advance check above sees each pull request against the base
// branch of the moment it ran. This workflow re-checks every open PR when
// main gains a contract change, from the API's file lists and the claiming
// PRs' documents — no PR code is fetched or run — and marks each PR head
// with the 'API contract version uniqueness (latest main)' status, the
// #13770 shape for the version number instead of the migrations.
describe('SDK Java contract re-check of open PRs', () => {
  const recheck = parse(
    readFileSync('.github/workflows/sdk-java-contract-open-prs.yml', 'utf8'),
  );
  const job = recheck.jobs.recheck;

  it('runs after every push to main that changes the document, and on a schedule', () => {
    expect(Object.keys(recheck.on).sort()).toEqual([
      'push',
      'schedule',
      'workflow_dispatch',
    ]);
    expect(recheck.on.schedule).toEqual([{ cron: '13,43 * * * *' }]);
    expect(recheck.on.push.branches).toEqual(['main']);
    expect(recheck.on.push.paths).toEqual([
      CONTRACT_DOCUMENT,
      'scripts/check-contract-open-prs.js',
      'scripts/contract-version-utils.js',
      '.github/workflows/sdk-java-contract-open-prs.yml',
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
      group: 'sdk-java-contract-open-prs-${{ github.ref }}',
      'cancel-in-progress': false,
    });
  });

  it('routes to the ECS pool behind the kill-switch', () => {
    expect(job['runs-on']).toBe(
      '${{ (github.repository == \'QwenLM/qwen-code\' && vars.MAINTAINER_ECS_RUNNER_DISABLED != \'true\') && fromJSON(\'["self-hosted", "linux", "x64", "ecs-qwen"]\') || fromJSON(\'["ubuntu-latest"]\') }}',
    );
  });

  it('re-checks from the one script, reading main from the checkout', () => {
    const run = job.steps.find((s) => s.name === 'Re-check open pull requests');
    expect(run.run).toBe('node scripts/check-contract-open-prs.js');
    expect(run.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
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
    'sdk-java-contract-open-prs.yml': parse(
      readFileSync('.github/workflows/sdk-java-contract-open-prs.yml', 'utf8'),
    ),
    'release-managed-agent-reference.yml': parse(
      readFileSync(
        '.github/workflows/release-managed-agent-reference.yml',
        'utf8',
      ),
    ),
    'managed-agent-gate.yml': parse(
      readFileSync('.github/workflows/managed-agent-gate.yml', 'utf8'),
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
    ['sdk-java.yml', 'event-transport-broker'],
    ['sdk-java.yml', 'event-transport-multi-node'],
    ['sdk-java.yml', 'daemon-e2e'],
    ['sdk-java-flyway-open-prs.yml', 'recheck'],
    ['sdk-java-contract-open-prs.yml', 'recheck'],
    ['release-managed-agent-reference.yml', 'build'],
    ['managed-agent-gate.yml', 'scope'],
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

describe('Java SDK release validation gate', () => {
  const checks = parse(workflow);
  const release = parse(
    readFileSync('.github/workflows/release-sdk-java.yml', 'utf8'),
  );

  it('checks the prepared source in every lane before publishing', () => {
    expect(checks.on.workflow_call.inputs.ref).toMatchObject({
      required: true,
      type: 'string',
    });
    // The only lane condition is the fast-tier skip, and the release caller
    // passes no tier, so the default 'full' runs every lane.
    expect(checks.on.workflow_call.inputs.tier).toMatchObject({
      required: false,
      default: 'full',
    });
    for (const lane of Object.values(checks.jobs)) {
      const checkout = lane.steps.find((entry) =>
        entry.uses?.startsWith('actions/checkout@'),
      );
      expect(checkout.with.ref).toBe('${{ inputs.ref || github.sha }}');
      expect([undefined, "${{ inputs.tier != 'fast' }}"]).toContain(lane.if);
      expect(lane['continue-on-error']).toBeUndefined();
    }
    expect(release.jobs.java_checks).toMatchObject({
      needs: 'prepare',
      uses: './.github/workflows/sdk-java.yml',
      with: { ref: '${{ needs.prepare.outputs.release_sha }}' },
    });
    expect(release.jobs.java_checks.with.tier).toBeUndefined();
    expect(release.jobs.java_checks['continue-on-error']).toBeUndefined();
    expect(release.jobs.release.needs).toEqual(['prepare', 'java_checks']);
    expect(release.jobs.release.if).toBeUndefined();
    const checkout = release.jobs.release.steps.find((entry) =>
      entry.uses?.startsWith('actions/checkout@'),
    );
    expect(checkout.with.ref).toBe('${{ needs.prepare.outputs.release_sha }}');
  });

  it('resolves an existing tag before checks and refuses a changed tag', () => {
    const prepare = release.jobs.prepare;
    expect(prepare.permissions).toEqual({ contents: 'read' });
    expect(prepare.environment).toBeUndefined();
    const preflight = prepare.steps.find((entry) => entry.id === 'preflight');
    expect(prepare.outputs.release_sha).toBe(
      '${{ steps.preflight.outputs.release_sha }}',
    );
    expect(preflight.run.indexOf('echo "release_sha=')).toBeGreaterThan(
      preflight.run.indexOf('git checkout --detach "${tag_commit}"'),
    );
    const steps = release.jobs.release.steps;
    const guard = steps.findIndex(
      (entry) => entry.name === 'Verify release tag has not changed',
    );
    expect(guard).toBeGreaterThan(-1);
    expect(steps[guard].run).toContain('"${peeled_tag}" != "${RELEASE_SHA}"');
    expect(steps[guard].run).toContain('exit 1');
    expect(steps[guard].env.RELEASE_SHA).toBe(
      '${{ needs.prepare.outputs.release_sha }}',
    );
    expect(guard).toBeLessThan(
      steps.findIndex((entry) => entry.name === 'Create and push release tag'),
    );
  });
});

// An ECS host keeps ~/.m2 between jobs, and setup-java's post-job save tars
// that whole shared repository before reserving the key: 14 to 37 minutes per
// job on 2026-10-16, discarded when a parallel job wins the reservation.
//
// The corpus is derived, not listed: a lane joins the pool with a one-line
// runs-on ternary (3bddf6e0bb moved three), and a closed file list stays
// green through exactly that move. Only pool-capable lanes are pinned — a
// hosted-literal runs-on never lands there, so release-sdk-java.yml keeps
// cache: 'maven' and mobile-shell.yml declares no cache at all.
describe('setup-java Maven cache stays on hosted runners', () => {
  const hostedOnly =
    "${{ runner.environment == 'github-hosted' && 'maven' || '' }}";
  const sites = globSync('.github/workflows/*.{yml,yaml}').flatMap((file) =>
    Object.entries(parse(readFileSync(file, 'utf8')).jobs).flatMap(
      ([name, job]) =>
        (job.steps ?? [])
          .filter((s) => String(s.uses ?? '').startsWith('actions/setup-java'))
          .map((s) => [`${file} ${name}`, s, job['runs-on']]),
    ),
  );
  const poolCapable = sites.filter(([, , runsOn]) =>
    String(runsOn ?? '').includes('self-hosted'),
  );
  it('finds every pool-capable setup-java step', () => {
    expect(poolCapable.length).toBe(6);
  });
  it.each(poolCapable)('%s caches Maven only on hosted runners', (_, step) => {
    expect(step.with?.cache).toBe(hostedOnly);
  });
});
