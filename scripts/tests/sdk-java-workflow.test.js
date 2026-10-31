import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
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

const writeBackFind =
  "timeout 300 find . \\( -path '*/com/alibaba/qwencode-sdk' -o -path '*/com/alibaba/qwen-managed-agent-parent' -o -path '*/com/alibaba/qwen-managed-agent-contracts' -o -path '*/com/alibaba/qwen-managed-agent-control-plane' -o -path '*/com/alibaba/qwen-managed-agent-runtime-broker' -o -path '*/com/alibaba/qwen-managed-agent-persistence' -o -path '*/com/alibaba/qwen-managed-agent-adapters' -o -path '*/com/alibaba/qwen-managed-agent-server' -o -path '*/com/alibaba/qwen-managed-agent-verification' \\) -prune -o -type f -links 1 ! -name '_remote.repositories' ! -name 'maven-metadata-local.xml' ! -name 'resolver-status.properties' ! -name '*.lastUpdated' ! -name '*.tmp' -exec cp -ln --parents -t \"${HOME}/.m2/repository\" {} + 9>&- || write_back=$?";

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
  it('runs both ordinary dependency host modes from the verified local reactor', () => {
    const steps = parse(workflow).jobs['mysql-integration'].steps;
    const verify = steps.find((candidate) =>
      candidate.name.startsWith(
        'Install and verify Managed Agent dependencies',
      ),
    );
    const embedding = steps.find(
      (candidate) =>
        candidate.name === 'Verify ordinary and enabled embedding hosts',
    );
    expect(steps.indexOf(embedding)).toBeGreaterThan(steps.indexOf(verify));
    expect(embedding['working-directory']).toBe(
      'packages/managed-agent-server',
    );
    expect(embedding.env.MAVEN_ARGS).toBe(verify.env.MAVEN_ARGS);
    expect(embedding.run).toBe(
      'bash ../../.github/scripts/verify-managed-agent-embedding.sh',
    );
    const embeddingScript = readFileSync(
      '.github/scripts/verify-managed-agent-embedding.sh',
      'utf8',
    );
    expect(embeddingScript).toContain('set -euo pipefail');
    expect(embeddingScript).toContain('-pl server -am -DskipTests');
    expect(embeddingScript).toContain('-Dexpression=project.version');
    const hostRuns = embeddingScript
      .split('\n')
      .filter((line) =>
        line.includes('-f verification/src/test/embedding-host/pom.xml'),
      );
    expect(hostRuns).toHaveLength(2);
    for (const line of hostRuns) {
      expect(line).toContain('-Dmanaged-agent.version="${managed_version}"');
      expect(line).toContain('-DfailIfNoTests=true');
      expect(line).not.toContain('-DskipTests');
    }
    expect(hostRuns[0]).toContain('-Dtest=EmbeddingHostTest');
    expect(hostRuns[0]).not.toContain('-Pembedded');
    expect(hostRuns[1]).toContain('-Dtest=EnabledHostTest');
    expect(hostRuns[1]).toContain('-Pembedded');
    expect(
      steps.find(
        (candidate) =>
          candidate.name === 'Upload Maven test reports on failure',
      ).with.path,
    ).toContain('embedding-host/target/surefire-reports/*');
    expect(
      readFileSync(
        'packages/managed-agent-server/verification/src/test/embedding-host/pom.xml',
        'utf8',
      ),
    ).toContain('<version>${managed-agent.version}</version>');
  });

  it('builds native producer prerequisites before either Server test lane', () => {
    const jobs = parse(workflow).jobs;
    for (const name of ['mysql-integration', 'hosted-harness-mysql']) {
      const steps = jobs[name].steps;
      const install = steps.findIndex((s) =>
        s.run?.includes('corepack pnpm install --frozen-lockfile'),
      );
      const verify = steps.findIndex(
        (s) =>
          (s.run?.includes('-f packages/managed-agent-server/pom.xml') ||
            s.run?.includes('cd packages/managed-agent-server')) &&
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

  it('keeps the daemon E2E install from rebuilding what its next steps build', () => {
    // prepare would build and bundle the tree during install, then the two
    // explicit steps below repeat both. #14861 failed inside that install-path
    // build, so the install stays an install and the build steps below stay
    // the only place this job compiles.
    const steps = parse(workflow).jobs['daemon-e2e'].steps;
    const install = steps.find(
      (s) => s.name === 'Install Node.js dependencies',
    );
    expect(install.env?.QWEN_SKIP_PREPARE).toBe('1');
    expect(steps.map((s) => s.name).indexOf('Build Qwen Code')).toBeGreaterThan(
      steps.map((s) => s.name).indexOf('Install Node.js dependencies'),
    );
  });

  it.each([
    ['.github/workflows/sdk-java.yml', 'daemon-e2e'],
    ['.github/workflows/release-sdk-java.yml', 'release'],
  ])('%s %s pins the explicit Build/Bundle/Run steps', (file, jobName) => {
    const steps = parse(readFileSync(file, 'utf8')).jobs[jobName].steps;
    const names = steps.map((s) => s.name);
    let previous = -1;
    for (const [name, run] of [
      ['Build Qwen Code', 'npm run build'],
      ['Bundle Qwen Code', 'npm run bundle'],
      ['Run Java daemon E2E', 'npx tsx scripts/run-java-daemon-sdk-e2e.ts'],
    ]) {
      const index = names.indexOf(name);
      expect(index, `${jobName}: ${name}`).toBeGreaterThan(previous);
      previous = index;
      expect(steps[index].run, name).toBe(run);
      expect(steps[index]['continue-on-error'], name).toBeUndefined();
      expect(steps[index].if, name).toBeUndefined();
    }
  });

  it('keeps the pinned build steps pointed at files that exist', () => {
    const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
    expect(existsSync('scripts/run-java-daemon-sdk-e2e.ts')).toBe(true);
    expect(scripts.build).toBeTruthy();
    expect(scripts.bundle).toBeTruthy();
  });

  it('serializes the host-shared Maven cache write-back on each physical ECS host', () => {
    const block = job('test');
    expect(block).toContain(
      'if: "${{ runner.environment == \'self-hosted\' }}"',
    );
    // The suite resolves from a job-local repository; only the cache
    // write-back mutates the host-shared ~/.m2. The ticketed queue orders
    // that one wait and keeps the fast class ahead of full-tier tickets, so
    // the pin is the sourced helper, its budget, and the tier argument. The
    // 9600 s budget is carried from the pre-split topology where a test lane
    // could queue behind several suite holds; with the suite unlocked it is
    // a conservative bound, not a measured need (#14566, #15031). Run
    // 39754359013 burned the old 5400 s behind the MariaDB lane's verify
    // hold, a shape #15128 removed.
    expect(block).toContain(
      'source "${GITHUB_WORKSPACE}/.github/scripts/sdk-java-lock.sh"',
    );
    expect(block).toContain('sdk_java_lock_acquire "${lock_wait}" "${TIER}"');
    // release-sdk-java.yml resumes an existing tag by checking out that
    // immutable commit, which may predate this helper; the guarded bare-lock
    // fallback keeps acquisition independent of the checkout's ref.
    expect(block).toContain('flock --wait "${lock_wait}" 9');
    expect(block).toContain(
      '::warning::Maven cache write-back skipped: the sdk-java host lock stayed busy for the full wait budget',
    );
    expect(block).toContain(
      'if: "${{ runner.environment == \'github-hosted\' }}"',
    );
  });

  it('keeps the host lock out of every locked child', () => {
    const jobs = parse(workflow).jobs;
    const lockedSteps = ['test', 'mysql-integration'].flatMap((name) =>
      jobs[name].steps.filter((s) => s.run?.includes('sdk-java-tests.lock')),
    );
    // The MariaDB lane's two Maven steps are one step now (#14903), so the
    // lock-bearing steps are the test job's and this job's single one. Both
    // lock only their cache write-back: every Maven run is above the
    // acquisition, and the write-back children drop fd 9 so a cancelled
    // job's survivor cannot retain the lock.
    expect(lockedSteps).toHaveLength(2);
    for (const locked of lockedSteps) {
      const lockAt = locked.run.indexOf(
        'source "${GITHUB_WORKSPACE}/.github/scripts/sdk-java-lock.sh"',
      );
      expect(lockAt, locked.name).toBeGreaterThan(-1);
      const seedAt = locked.run.indexOf('cp -aln "${HOME}/.m2/repository/."');
      expect(seedAt, locked.name).toBeGreaterThan(-1);
      expect(seedAt, locked.name).toBeLessThan(lockAt);
      // Assert on the region below the acquisition, not on first-occurrence
      // indices: a duplicated Maven run below the lock shares its text with
      // the legitimate run above it, so indexOf would resolve to the wrong
      // one. Comments are stripped because the MariaDB step's post-lock
      // comment names mvn.
      const belowCode = locked.run
        .slice(lockAt)
        .split('\n')
        .filter((line) => !line.trim().startsWith('#'))
        .join('\n');
      expect(belowCode, locked.name).not.toMatch(/\bmvn\b/);
      expect(locked.run).toContain('mkdir -p "${HOME}/.m2/repository" 9>&-');
      expect(locked.run).toMatch(
        /timeout 300 find \..*-exec cp -ln --parents -t "\$\{HOME\}\/\.m2\/repository" \{\} \+ 9>&- \|\| write_back=\$\?/,
      );
    }
    // The MariaDB lane keeps its two specific Maven runs above the lock.
    const integration = lockedSteps.find((lockedStep) =>
      lockedStep.run.includes('-Pmysql-integration'),
    ).run;
    const integrationLockAt = integration.indexOf(
      'source "${GITHUB_WORKSPACE}/.github/scripts/sdk-java-lock.sh"',
    );
    const integrationInstallAt = integration.indexOf(
      '-f packages/sdk-java/qwencode/pom.xml',
    );
    expect(integrationInstallAt).toBeGreaterThan(-1);
    expect(integrationInstallAt).toBeLessThan(integrationLockAt);
    expect(integration.indexOf('-Pmysql-integration')).toBeGreaterThan(-1);
  });

  it('keeps the cache write-back byte-identical across both lock sites', () => {
    // The test job's write-back prelude and tail were cloned from
    // mysql-integration's, and the wildcard pin above would not notice one
    // copy losing an errexit probe, -links 1 or its -prune excludes. That is
    // the #13506 drift class: a later fix applied to only one copy
    // republishes the whole seeded tree, publishes the in-house fixed
    // coordinates into the host cache the next seed reads, or reintroduces
    // the fatal setup path this PR warns past.
    const runs = ['test', 'mysql-integration'].map(
      (name) =>
        parse(workflow).jobs[name].steps.find((candidate) =>
          candidate.run?.includes('sdk-java-tests.lock'),
        ).run,
    );
    const preludes = runs.map((run) => {
      const start = run.indexOf('lock_setup_fault() {');
      const end = run.indexOf('\nfi\n', start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return run.slice(start, end + '\nfi\n'.length);
    });
    // The test job alone passes its tier, owns the deferred status and
    // clamps its wait on a red leg; the prelude must otherwise stay
    // byte-identical. The comment block between the prelude and the
    // write-back differs by site, so the tail is pinned from its first
    // command instead.
    expect(preludes[0]).toContain(
      'sdk_java_lock_acquire "${lock_wait}" "${TIER}"',
    );
    expect(preludes[1]).toContain('sdk_java_lock_acquire 5400 >&7');
    expect(preludes[0]).toContain('flock --wait "${lock_wait}" 9');
    expect(preludes[1]).toContain('flock --wait 5400 9');
    // The test job alone defers its Maven status to the end of the step, so
    // its tolerated-skip arms report that status and name the failed stage;
    // the MariaDB lane's suites fail inline and never reach those arms with a
    // status to report. Normalize both intended differences before comparing
    // the rest byte for byte.
    const normalizeTestPrelude = (text) =>
      text
        .replaceAll('exit "${mvn_status}"', 'exit 0')
        .replaceAll(/\n[ \t]+mvn_report_failed_suite(?=\n)/g, '');
    expect(
      preludes[1]
        .replace(
          'sdk_java_lock_acquire 5400 >&7',
          'sdk_java_lock_acquire "${lock_wait}" "${TIER}" >&7',
        )
        .replace('flock --wait 5400 9', 'flock --wait "${lock_wait}" 9'),
    ).toBe(normalizeTestPrelude(preludes[0]));
    // A red leg waits only as long as the copy itself may run: a failure
    // that is already decided must not spend the green lane's queue budget.
    expect(runs[0]).toMatch(
      /lock_wait=9600[\s\S]{0,80}if \[ "\$\{mvn_status:-0\}" -ne 0 \]; then\s+lock_wait=300/,
    );
    expect(runs[1]).not.toContain('lock_wait');
    const tails = runs.map((run) => {
      const start = run.indexOf('write_back=0');
      expect(start).toBeGreaterThan(-1);
      return run.slice(start);
    });
    // The test job appends the deferred exit after the write-back; the
    // MariaDB lane's steps fail inline and keep their inline exits.
    const deferredAt = tails[0].indexOf('\n# Deferred so a failed suite');
    expect(deferredAt).toBeGreaterThan(-1);
    expect(tails[1]).toBe(tails[0].slice(0, deferredAt));
    expect(tails[0].slice(deferredAt)).toContain('exit "${mvn_status}"');
  });

  it('keeps the seeded coordinate drops and write-back prunes in step', () => {
    // The in-house coordinate set is spelled by hand at every seed site and
    // at both write-back prunes. A set that drifts on one side leaves a
    // seeded hardlink alive, so the unlocked Maven run rewrites the host
    // cache through it; compare every spelling instead of one pinned pair.
    const parsed = parse(workflow);
    const drops = [];
    const prunes = [];
    // Maven's resolver tracking markers are spelled twice too: the seed
    // deletes them, and a write-back that forgets them publishes a failed
    // resolution into the host cache every consumer reads. Compare both
    // spellings instead of pinning one.
    const markersOf = (text) =>
      [...text.matchAll(/-name '([^']+)'/g)].map((match) => match[1]).sort();
    const seedMarkers = [];
    const pruneMarkers = [];
    for (const [jobName, job] of Object.entries(parsed.jobs)) {
      for (const candidate of job.steps ?? []) {
        const run = candidate.run;
        if (typeof run !== 'string') continue;
        const seedAt = run.indexOf('cp -aln "${HOME}/.m2/repository/."');
        if (seedAt !== -1) {
          const seedEnd = run.indexOf('\nmvn --batch-mode', seedAt);
          expect(seedEnd, jobName).toBeGreaterThan(seedAt);
          const seed = run.slice(seedAt, seedEnd);
          drops.push([
            jobName,
            [
              ...seed.matchAll(
                /"\$\{RUNNER_TEMP\}\/m2-repo\/com\/alibaba\/([^"]+)"/g,
              ),
            ]
              .map((match) => match[1])
              .sort(),
          ]);
          seedMarkers.push([jobName, markersOf(seed)]);
        }
        const pruneAt = run.indexOf('timeout 300 find .');
        if (pruneAt === -1) continue;
        const prune = run.slice(pruneAt, run.indexOf('\n', pruneAt));
        prunes.push([
          jobName,
          [...prune.matchAll(/-path '\*\/com\/alibaba\/([^']+)'/g)]
            .map((match) => match[1])
            .sort(),
        ]);
        pruneMarkers.push([jobName, markersOf(prune)]);
      }
    }
    const expected = [
      'qwen-managed-agent-adapters',
      'qwen-managed-agent-contracts',
      'qwen-managed-agent-control-plane',
      'qwen-managed-agent-parent',
      'qwen-managed-agent-persistence',
      'qwen-managed-agent-runtime-broker',
      'qwen-managed-agent-server',
      'qwen-managed-agent-verification',
      'qwencode-sdk',
    ];
    expect(drops.length).toBeGreaterThan(0);
    expect(prunes.length).toBeGreaterThan(0);
    for (const [jobName, set] of [...drops, ...prunes]) {
      expect(set, jobName).toEqual(expected);
    }
    const expectedMarkers = [
      '*.lastUpdated',
      '*.tmp',
      '_remote.repositories',
      'maven-metadata-local.xml',
      'resolver-status.properties',
    ];
    expect(seedMarkers.length).toBe(drops.length);
    expect(pruneMarkers.length).toBe(prunes.length);
    for (const [jobName, set] of [...seedMarkers, ...pruneMarkers]) {
      expect(set, jobName).toEqual(expectedMarkers);
    }
  });

  it('binds the lock and queue probes to the helper paths', () => {
    // Both call sites spell the helper's lock/queue paths by hand. Read
    // them from the helper so a rename cannot leave a probe watching a
    // path the helper never creates.
    const helper = readFileSync('.github/scripts/sdk-java-lock.sh', 'utf8');
    const lockPath = helper.match(/local lock="\$\{HOME\}\/([^"]+)"/)?.[1];
    expect(lockPath).toBeDefined();
    expect(helper).toContain('local queue="${lock}.queue"');
    const separator = lockPath.lastIndexOf('/');
    const cacheDir = lockPath.slice(0, separator);
    const lockName = lockPath.slice(separator + 1);
    const runs = Object.values(parse(workflow).jobs)
      .flatMap((job) => (job.steps ?? []).map((step) => step.run))
      .filter(
        (run) => typeof run === 'string' && run.includes('sdk-java-tests.lock'),
      );
    expect(runs).toHaveLength(2);
    for (const run of runs) {
      expect(run).toContain(`cache_dir="\${HOME}/${cacheDir}"`);
      expect(run).toContain(`queue_dir="\${cache_dir}/${lockName}.queue"`);
      expect(run).toContain(`[ ! -d "\${cache_dir}/${lockName}" ]`);
      expect(run).toContain(`exec 9>"\${cache_dir}/${lockName}"`);
    }
  });

  it.skipIf(process.platform !== 'linux')(
    'runs the Maven suite before taking the host lock',
    () => {
      const run = step(job('test'), 'Run Java SDK tests (self-hosted)');
      const suite = run.slice(
        run.indexOf('cp -aln "${HOME}/.m2/repository/."'),
        run.indexOf('# Only the write-back mutates host-shared state'),
      );
      expect(suite).toContain(
        'mvn --batch-mode --no-transfer-progress clean test',
      );
      const dir = mkdtempSync(join(tmpdir(), 'sdk-java-lock-'));
      mkdirSync(join(dir, 'home', '.cache', 'qwen-code-ci'), {
        recursive: true,
      });
      try {
        const result = spawnSync(
          'bash',
          [
            '-e',
            '-c',
            `
            mvn() { :; }
            ${suite}
            flock --nonblock "$HOME/.cache/qwen-code-ci/sdk-java-tests.lock" true
          `,
          ],
          {
            encoding: 'utf8',
            timeout: 5000,
            env: {
              ...process.env,
              HOME: join(dir, 'home'),
              RUNNER_TEMP: join(dir, 'temp'),
              GITHUB_WORKSPACE: process.cwd(),
              MATRIX_JAVA: '11',
              TIER: 'fast',
            },
          },
        );
        expect(result.error, suite).toBeUndefined();
        expect(result.status, suite + result.stderr).toBe(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'drops seeded in-house coordinates so Maven writes fresh inodes',
    () => {
      const jobs = parse(workflow).jobs;
      const seeds = Object.entries(jobs).flatMap(([name, job]) =>
        (job.steps ?? [])
          .filter((candidate) =>
            candidate.run?.includes('cp -aln "${HOME}/.m2/repository/."'),
          )
          .map((candidate) => [name, candidate.run]),
      );
      expect(seeds.map(([name]) => name).sort()).toEqual([
        'event-transport-broker',
        'event-transport-multi-node',
        'mysql-integration',
        'test',
      ]);
      for (const [name, seedRun] of seeds) {
        const start = seedRun.indexOf('cp -aln "${HOME}/.m2/repository/."');
        const end = seedRun.indexOf('\nmvn --batch-mode', start);
        expect(start, name).toBeGreaterThan(-1);
        expect(end, name).toBeGreaterThan(start);
        const seed = seedRun.slice(start, end);
        expect(seed, name).toContain(
          'rm -rf -- "${RUNNER_TEMP}/m2-repo/com/alibaba/qwencode-sdk"',
        );
        expect(seed, name).toContain(
          '${RUNNER_TEMP}/m2-repo/com/alibaba/qwen-managed-agent-server',
        );
        const dir = mkdtempSync(join(tmpdir(), 'sdk-java-seed-'));
        const home = join(dir, 'home');
        const runnerTemp = join(dir, 'runner-temp');
        mkdirSync(runnerTemp, { recursive: true });
        const hostRepo = join(home, '.m2', 'repository');
        const hostJars = [
          ...[
            'qwen-managed-agent-parent',
            'qwen-managed-agent-contracts',
            'qwen-managed-agent-control-plane',
            'qwen-managed-agent-runtime-broker',
            'qwen-managed-agent-persistence',
            'qwen-managed-agent-adapters',
            'qwen-managed-agent-server',
            'qwen-managed-agent-verification',
          ]
            .filter((name) => name !== 'qwen-managed-agent-server')
            .map((name) => [
              'com',
              'alibaba',
              name,
              '0.1.0-alpha',
              'module.jar',
            ]),
          ['com', 'alibaba', 'qwencode-sdk', '0.1.0-alpha', 'sdk.jar'],
          [
            'com',
            'alibaba',
            'qwen-managed-agent-server',
            '0.1.0-alpha',
            'server.jar',
          ],
          ['org', 'example', 'third-party', '1.0', 'third-party.jar'],
        ].map((parts) => join(hostRepo, ...parts));
        for (const jar of hostJars) {
          mkdirSync(dirname(jar), { recursive: true });
          writeFileSync(jar, 'host');
        }
        // Maven rewrites these tracking files in place, so a seeded hardlink
        // would let the unlocked run mutate the host cache through it.
        const hostMarkers = [
          ['resolver-status.properties'],
          ['_remote.repositories'],
          ['maven-metadata-local.xml'],
          ['third-party-1.0.pom.lastUpdated'],
        ].map((parts) =>
          join(hostRepo, 'org', 'example', 'third-party', '1.0', ...parts),
        );
        for (const marker of hostMarkers) {
          writeFileSync(marker, 'host');
        }
        try {
          const result = spawnSync('bash', ['-e', '-c', seed], {
            encoding: 'utf8',
            timeout: 5000,
            env: {
              ...process.env,
              HOME: home,
              RUNNER_TEMP: runnerTemp,
            },
          });
          expect(result.error, name).toBeUndefined();
          expect(result.status, name + result.stderr).toBe(0);
          for (const coordinate of [
            'qwen-managed-agent-parent',
            'qwen-managed-agent-contracts',
            'qwen-managed-agent-control-plane',
            'qwen-managed-agent-runtime-broker',
            'qwen-managed-agent-persistence',
            'qwen-managed-agent-adapters',
            'qwen-managed-agent-server',
            'qwen-managed-agent-verification',
            'qwencode-sdk',
          ]) {
            expect(
              existsSync(
                join(runnerTemp, 'm2-repo', 'com', 'alibaba', coordinate),
              ),
              `${name}/${coordinate}`,
            ).toBe(false);
          }
          expect(
            existsSync(
              join(
                runnerTemp,
                'm2-repo',
                'org',
                'example',
                'third-party',
                '1.0',
                'third-party.jar',
              ),
            ),
            name,
          ).toBe(true);
          for (const jar of hostJars.slice(0, 2)) {
            expect(readFileSync(jar, 'utf8'), name).toBe('host');
            // The job-local copy held the only extra link; dropping it must
            // leave the host file exactly as seeded.
            expect(statSync(jar).nlink, name).toBe(1);
          }
          for (const marker of hostMarkers) {
            expect(
              existsSync(
                join(runnerTemp, 'm2-repo', marker.slice(hostRepo.length + 1)),
              ),
              `${name}/${marker}`,
            ).toBe(false);
            expect(readFileSync(marker, 'utf8'), name).toBe('host');
            expect(statSync(marker).nlink, name).toBe(1);
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'releases the host lock when a write-back child survives the step',
    () => {
      const jobs = parse(workflow).jobs;
      for (const jobName of ['test', 'mysql-integration']) {
        const step = jobs[jobName].steps.find((s) =>
          s.run?.includes('sdk-java-tests.lock'),
        );
        const start = step.run.indexOf('write_back=0');
        expect(start, step.name).toBeGreaterThan(-1);
        // Bound the probe to the write-back stanza: an unbounded slice would
        // execute whatever a future edit places below it and report that
        // failure as an opaque filesystem error.
        const stanza = step.run
          .slice(start)
          .match(
            /^write_back=0[\s\S]*?cache write-back failed; the gate result above is unaffected"\n\s*fi/,
          )?.[0];
        expect(stanza, step.name).toBeTruthy();
        // The test job defers its Maven status to the end of the step, so its
        // stanza calls a reporter and needs the status defined; the MariaDB
        // lane ends at its own `fi` and needs neither.
        const reporterAt = step.run.indexOf('mvn_report_failed_suite() {');
        const writeBack = step.run.includes('mvn_report_failed_suite() {')
          ? `mvn_status=0\n${step.run.slice(
              reporterAt,
              step.run.indexOf('lock_setup_fault() {', reporterAt),
            )}${stanza}`
          : stanza;
        // Derive the children from the write-back itself: a command added
        // without a fd 9 close must get its own survivor, or this guard
        // stays green while a cancelled job's child keeps the host lock.
        const builtins = new Set([
          'cd',
          'echo',
          '[',
          'test',
          'if',
          'then',
          'else',
          'elif',
          'fi',
        ]);
        const shimNames = [
          ...new Set(
            stanza
              .replace(/"[^"]*"/g, '""')
              .split(/\|\||&&|[|;\n]/)
              .map((segment) => segment.trim())
              .filter((segment) => !/^[A-Za-z_]\w*=/.test(segment))
              .map((segment) => segment.match(/^([a-z][\w.-]*)/)?.[1])
              .filter((name) => name && !builtins.has(name)),
          ),
        ];
        expect(shimNames, step.name).toEqual(['rm', 'mkdir', 'timeout']);
        const dir = mkdtempSync(join(tmpdir(), 'sdk-java-write-back-'));
        const shims = join(dir, 'bin');
        const home = join(dir, 'home');
        const runnerTemp = join(dir, 'runner-temp');
        const pidFile = join(dir, 'children.pid');
        mkdirSync(shims);
        mkdirSync(join(runnerTemp, 'm2-repo'), { recursive: true });
        // A child that outlives the step: if it inherits fd 9, the host lock
        // stays held after the step shell exits. Each derived command gets
        // one, and the mkdir shim creates the directory it stands in for.
        for (const name of shimNames) {
          writeFileSync(
            join(shims, name),
            '#!/bin/sh\n' +
              (name === 'mkdir' ? '/bin/mkdir -p "$@"\n' : '') +
              'sleep 30 </dev/null >/dev/null 2>&1 &\n' +
              'printf \'%s\\n\' "$!" >> "$CHILD_PID_FILE"\n' +
              'exit 0\n',
            { mode: 0o755 },
          );
        }
        try {
          const result = spawnSync(
            'bash',
            [
              '-e',
              '-c',
              `
              exec 9>"$LOCK_FILE"
              flock --nonblock 9
              ${writeBack}
            `,
            ],
            {
              encoding: 'utf8',
              timeout: 5000,
              env: {
                ...process.env,
                PATH: `${shims}:${process.env.PATH}`,
                HOME: home,
                RUNNER_TEMP: runnerTemp,
                CHILD_PID_FILE: pidFile,
                LOCK_FILE: join(dir, 'tests.lock'),
              },
            },
          );
          expect(result.error, step.name).toBeUndefined();
          expect(result.status, step.name + result.stderr).toBe(0);
          expect(existsSync(join(home, '.m2', 'repository')), step.name).toBe(
            true,
          );
          const children = readFileSync(pidFile, 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean);
          expect(children.length, step.name).toBe(shimNames.length);
          // The step shell has exited. A survivor that inherited fd 9 would
          // still hold the lock; the closures are what keep it free.
          const free = spawnSync(
            'flock',
            ['--nonblock', join(dir, 'tests.lock'), 'true'],
            { encoding: 'utf8' },
          );
          expect(free.status, step.name + free.stderr).toBe(0);
        } finally {
          if (existsSync(pidFile)) {
            for (const pid of readFileSync(pidFile, 'utf8').split('\n')) {
              if (pid.trim()) {
                try {
                  process.kill(Number(pid), 'SIGKILL');
                } catch {
                  // Already gone.
                }
              }
            }
          }
          rmSync(dir, { recursive: true, force: true });
        }
      }
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'keeps a failed write-back cache-directory creation from reddening the gate',
    () => {
      const jobs = parse(workflow).jobs;
      for (const jobName of ['test', 'mysql-integration']) {
        const step = jobs[jobName].steps.find((candidate) =>
          candidate.run?.includes('sdk-java-tests.lock'),
        );
        const start = step.run.indexOf('write_back=0');
        const mkdirAt = step.run.indexOf('mkdir -p "${HOME}/.m2/repository"');
        expect(start, step.name).toBeGreaterThan(-1);
        expect(start, step.name).toBeLessThan(mkdirAt);
        const writeBack = step.run
          .slice(start)
          .match(
            /^write_back=0[\s\S]*?cache write-back failed; the gate result above is unaffected"\n\s*fi/,
          )?.[0];
        expect(writeBack, step.name).toBeTruthy();
        const dir = mkdtempSync(join(tmpdir(), 'sdk-java-mkdir-'));
        const home = join(dir, 'home');
        const runnerTemp = join(dir, 'runner-temp');
        mkdirSync(home);
        mkdirSync(join(runnerTemp, 'm2-repo'), { recursive: true });
        // A regular file where the cache directory belongs: `mkdir -p`
        // cannot succeed, and the step used to die before its warning arm.
        writeFileSync(join(home, '.m2'), 'not a directory');
        try {
          const result = spawnSync('bash', ['-e', '-c', writeBack], {
            encoding: 'utf8',
            timeout: 10000,
            env: { ...process.env, HOME: home, RUNNER_TEMP: runnerTemp },
          });
          expect(result.status, step.name + result.stderr).toBe(0);
          expect(result.stdout, step.name).toContain(
            '::warning::Maven cache write-back failed; the gate result above is unaffected',
          );
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'prunes the in-house SDK coordinates at any depth in the write-back',
    () => {
      const jobs = parse(workflow).jobs;
      for (const jobName of ['test', 'mysql-integration']) {
        const locked = jobs[jobName].steps.find((candidate) =>
          candidate.run?.includes('sdk-java-tests.lock'),
        );
        const findLine = locked.run
          .split('\n')
          .find((line) => line.trim().startsWith('timeout 300 find'));
        expect(findLine, locked.name).toBeTruthy();
        const dir = mkdtempSync(join(tmpdir(), 'sdk-java-prune-'));
        const repo = join(dir, 'm2-repo');
        const home = join(dir, 'home');
        const host = join(home, '.m2', 'repository');
        try {
          for (const [path, body] of [
            ['com/alibaba/qwencode-sdk/0.1.0-alpha/flat.jar', 'flat'],
            [
              'repository/com/alibaba/qwencode-sdk/0.1.0-alpha/nested.jar',
              'nested',
            ],
            ['org/example/lib/kept.jar', 'kept'],
          ]) {
            mkdirSync(dirname(join(repo, path)), { recursive: true });
            writeFileSync(join(repo, path), body);
          }
          // A seeded artifact is already a host inode. Asserting on the end
          // state cannot see the delta filter: `cp -n` skips an nlink-2 seed
          // because its host path exists. The candidate set can.
          mkdirSync(dirname(join(host, 'org/example/lib/seeded.jar')), {
            recursive: true,
          });
          writeFileSync(join(host, 'org/example/lib/seeded.jar'), 'seeded');
          linkSync(
            join(host, 'org/example/lib/seeded.jar'),
            join(repo, 'org/example/lib/seeded.jar'),
          );
          const candidates = findLine
            .trim()
            .replace(/^timeout 300 /, '')
            .replace(/ -exec .*$/, ' -print');
          const printed = spawnSync(
            'bash',
            ['-e', '-c', `cd "${repo}"\n${candidates}`],
            {
              encoding: 'utf8',
              timeout: 5000,
              env: { ...process.env, HOME: home },
            },
          );
          expect(printed.status, locked.name + printed.stderr).toBe(0);
          const candidatePaths = printed.stdout.trim().split('\n');
          expect(candidatePaths, locked.name).toContain(
            './org/example/lib/kept.jar',
          );
          expect(candidatePaths, locked.name).not.toContain(
            './org/example/lib/seeded.jar',
          );
          const result = spawnSync(
            'bash',
            ['-e', '-c', `cd "${repo}"\n${findLine.trim()}`],
            {
              encoding: 'utf8',
              timeout: 5000,
              env: { ...process.env, HOME: home },
            },
          );
          expect(result.status, locked.name + result.stderr).toBe(0);
          expect(
            existsSync(
              join(home, '.m2', 'repository', 'org/example/lib/kept.jar'),
            ),
            locked.name,
          ).toBe(true);
          expect(
            existsSync(
              join(home, '.m2', 'repository', 'com/alibaba/qwencode-sdk'),
            ),
            locked.name,
          ).toBe(false);
          expect(
            existsSync(join(home, '.m2', 'repository', 'repository')),
            locked.name,
          ).toBe(false);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'removes the in-house coordinates from the host cache in the write-back',
    () => {
      const jobs = parse(workflow).jobs;
      for (const jobName of ['test', 'mysql-integration']) {
        const locked = jobs[jobName].steps.find((candidate) =>
          candidate.run?.includes('sdk-java-tests.lock'),
        );
        const lockAt = locked.run.indexOf(
          'source "${GITHUB_WORKSPACE}/.github/scripts/sdk-java-lock.sh"',
        );
        const start = locked.run.indexOf('write_back=0');
        expect(start, locked.name).toBeGreaterThan(lockAt);
        const rmLine = locked.run
          .split('\n')
          .find((line) =>
            line
              .trim()
              .startsWith(
                'rm -rf -- "${HOME}/.m2/repository/com/alibaba/qwencode-sdk"',
              ),
          );
        expect(rmLine, locked.name).toBeTruthy();
        const rmAt = locked.run.indexOf(rmLine);
        expect(rmAt, locked.name).toBeGreaterThan(lockAt);
        const writeBack = locked.run
          .slice(start)
          .match(
            /^write_back=0[\s\S]*?cache write-back failed; the gate result above is unaffected"\n\s*fi/,
          )?.[0];
        expect(writeBack, locked.name).toBeTruthy();
        const dir = mkdtempSync(join(tmpdir(), 'sdk-java-host-prune-'));
        const home = join(dir, 'home');
        const runnerTemp = join(dir, 'runner-temp');
        const host = join(home, '.m2', 'repository');
        const repo = join(runnerTemp, 'm2-repo');
        try {
          for (const [path, body] of [
            ['com/alibaba/qwencode-sdk/0.1.0-alpha/old.jar', 'sdk'],
            [
              'com/alibaba/qwen-managed-agent-server/0.1.0-alpha/old.jar',
              'server',
            ],
            [
              'com/alibaba/qwen-managed-agent-contracts/0.1.0-alpha/old.jar',
              'contracts',
            ],
            ['org/example/lib/kept.jar', 'kept'],
          ]) {
            mkdirSync(dirname(join(host, path)), { recursive: true });
            writeFileSync(join(host, path), body);
          }
          mkdirSync(join(repo, 'org/example/lib/1.0'), { recursive: true });
          writeFileSync(join(repo, 'org/example/lib/new.jar'), 'new');
          // Resolver bookkeeping is job-local by design: a hardlinked
          // _remote.repositories or *.lastUpdated would be rewritten in place
          // by the next job's Maven outside the lock (issue #15281).
          for (const name of [
            '_remote.repositories',
            'maven-metadata-local.xml',
            'resolver-status.properties',
            'new.jar.lastUpdated',
          ]) {
            writeFileSync(join(repo, 'org/example/lib/1.0', name), name);
          }
          const result = spawnSync('bash', ['-e', '-c', writeBack], {
            encoding: 'utf8',
            timeout: 10000,
            env: { ...process.env, HOME: home, RUNNER_TEMP: runnerTemp },
          });
          expect(result.status, locked.name + result.stderr).toBe(0);
          // The stanza starts at write_back=0; without that initialization
          // both status checks compare an empty string and pass on the `[`
          // error rather than on a clean write-back.
          expect(result.stderr, locked.name).not.toContain(
            'integer expression expected',
          );
          expect(
            existsSync(join(host, 'com/alibaba/qwencode-sdk')),
            locked.name,
          ).toBe(false);
          expect(
            existsSync(join(host, 'com/alibaba/qwen-managed-agent-server')),
            locked.name,
          ).toBe(false);
          // The purge globs every qwen-managed-agent-* module, not just the
          // pre-split server coordinate (#15871).
          expect(
            existsSync(join(host, 'com/alibaba/qwen-managed-agent-contracts')),
            locked.name,
          ).toBe(false);
          expect(
            existsSync(join(host, 'org/example/lib/kept.jar')),
            locked.name,
          ).toBe(true);
          expect(
            existsSync(join(host, 'org/example/lib/new.jar')),
            locked.name,
          ).toBe(true);
          for (const name of [
            '_remote.repositories',
            'maven-metadata-local.xml',
            'resolver-status.properties',
            'new.jar.lastUpdated',
          ]) {
            expect(
              existsSync(join(host, 'org/example/lib/1.0', name)),
              locked.name + name,
            ).toBe(false);
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'seeds the in-house coordinates without hardlinked metadata',
    () => {
      // Maven's resolver rewrites its bookkeeping in place, so a hardlinked
      // seed would mutate the host cache above the lock. Every seed (four in
      // `sdk-java.yml` and the release lane's) must drop those names across
      // the job-local copy and leave Maven to create them fresh.
      const reference = parse(
        readFileSync(
          '.github/workflows/release-managed-agent-reference.yml',
          'utf8',
        ),
      );
      const sdkJavaSeeds = Object.values(parse(workflow).jobs)
        .flatMap((entry) => entry.steps ?? [])
        .filter((candidate) =>
          candidate.run?.includes('cp -aln "${HOME}/.m2/repository/."'),
        );
      const referenceSeeds = Object.values(reference.jobs)
        .flatMap((entry) => entry.steps ?? [])
        .filter((candidate) =>
          candidate.run?.includes('cp -aln "${HOME}/.m2/repository/."'),
        );
      expect(sdkJavaSeeds).toHaveLength(4);
      expect(referenceSeeds).toHaveLength(1);
      // The release lane has no write-back and takes no lock; its isolation
      // is the rm -rf of every in-house tree, so pin it explicitly.
      for (const candidate of referenceSeeds) {
        expect(candidate.run, candidate.name).toContain(
          'rm -rf -- "${repo}/com/alibaba/qwencode-sdk" "${repo}/com/alibaba/"qwen-managed-agent-*',
        );
      }
      const seeding = [...sdkJavaSeeds, ...referenceSeeds];
      for (const candidate of seeding) {
        const lines = candidate.run.split('\n');
        const cpAt = lines.findIndex((line) =>
          line.includes('cp -aln "${HOME}/.m2/repository/."'),
        );
        expect(cpAt, candidate.name).toBeGreaterThan(0);
        expect(lines[cpAt - 1].trim(), candidate.name).toMatch(/^mkdir -p /);
        const mvn = lines.findIndex(
          (line, index) => index > cpAt && /^\s*mvn /.test(line),
        );
        expect(mvn, candidate.name).toBeGreaterThan(cpAt);
        const seedLines = lines.slice(cpAt - 1, mvn);
        // The release lane's seed sits inside an `if` whose closing `fi`
        // precedes its first Maven run; the slice runs the body alone.
        if (seedLines.at(-1)?.trim() === 'fi') seedLines.pop();
        const seed = seedLines.join('\n');
        const dir = mkdtempSync(join(tmpdir(), 'sdk-java-seed-'));
        const home = join(dir, 'home');
        const runnerTemp = join(dir, 'runner-temp');
        const host = join(home, '.m2', 'repository');
        const local = join(runnerTemp, 'm2-repo');
        const metadata = [
          'com/alibaba/qwencode-sdk/0.1.0-alpha/_remote.repositories',
          'com/alibaba/qwencode-sdk/maven-metadata-local.xml',
          'com/alibaba/qwen-managed-agent-server/0.1.0-alpha/_remote.repositories',
          'com/alibaba/qwen-managed-agent-server/maven-metadata-local.xml',
          'org/example/lib/1.0/_remote.repositories',
          'org/example/lib/1.0/resolver-status.properties',
          'org/example/lib/1.0/artifact.lastUpdated',
        ];
        const artifacts = [
          'com/alibaba/qwencode-sdk/0.1.0-alpha/qwencode-sdk.jar',
          'com/alibaba/qwencode-sdk/0.1.0-alpha/qwencode-sdk.pom',
          'org/example/lib/kept.jar',
        ];
        try {
          for (const path of [...metadata, ...artifacts]) {
            mkdirSync(dirname(join(host, path)), { recursive: true });
            writeFileSync(join(host, path), path);
          }
          const result = spawnSync('bash', ['-e', '-c', seed], {
            encoding: 'utf8',
            timeout: 10000,
            env: {
              ...process.env,
              HOME: home,
              RUNNER_TEMP: runnerTemp,
              repo: local,
            },
          });
          expect(result.status, candidate.name + result.stderr).toBe(0);
          // Left in the job-local copy these are the host inodes, and Maven
          // would rewrite them without the lock.
          for (const path of metadata) {
            expect(existsSync(join(local, path)), candidate.name + path).toBe(
              false,
            );
            expect(readFileSync(join(host, path), 'utf8'), path).toBe(path);
          }
          // Every seed removes the in-house coordinate trees, so their
          // artifacts are absent; everything else is still seeded and
          // still hardlinked.
          for (const path of artifacts) {
            if (path.startsWith('com/alibaba/')) {
              expect(existsSync(join(local, path)), candidate.name + path).toBe(
                false,
              );
            } else {
              expect(existsSync(join(local, path)), candidate.name + path).toBe(
                true,
              );
              expect(statSync(join(local, path)).nlink, path).toBe(2);
            }
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    },
  );

  it.skipIf(process.platform !== 'linux')(
    'skips the cache write-back when the host lock cannot be acquired',
    () => {
      const signatures = new RegExp(
        parse(
          readFileSync('.github/workflows/qwen-autofix.yml', 'utf8'),
        ).env.INFRA_FAILURE_SIGNATURES,
        'i',
      );
      const helperSource = readFileSync(
        '.github/scripts/sdk-java-lock.sh',
        'utf8',
      );
      // Derive the stub's timeout line from the real helper: a wording or
      // casing drift in the helper must not leave this arm passing against
      // a hand-copied line the call site's sed rewrite no longer matches.
      const timeoutLine = helperSource
        .split('\n')
        .find((line) =>
          line.includes('::error::sdk-java host lock not acquired within'),
        );
      expect(timeoutLine).toBeDefined();
      const jobs = parse(workflow).jobs;
      for (const name of ['test', 'mysql-integration']) {
        const run = jobs[name].steps.find((candidate) =>
          candidate.run?.includes('sdk-java-tests.lock'),
        ).run;
        // The test job's exits name the deferred stage behind a red-path
        // budget clamp, both of which sit above the shared prelude; the
        // MariaDB lane fails inline and keeps neither.
        const clampAt = run.indexOf('lock_wait=9600');
        const start =
          clampAt === -1 ? run.indexOf('lock_setup_fault() {') : clampAt;
        expect(start, name).toBeGreaterThan(-1);
        const slice = run.slice(start);
        // The test job defers its Maven status to the end of the step, so its
        // skip arms read `mvn_status` while the slice starts below that
        // assignment. Run those arms green and red: a tolerated skip must
        // report the suite's status instead of turning a red suite green.
        // The MariaDB lane's suites fail inline, so its arms are always green.
        const deferred = slice.includes('exit "${mvn_status}"');
        const arms = [
          'helper',
          'helper-capitalised',
          'helper-no-flock',
          'fallback',
          'fallback-no-flock',
          'setup-fault',
          'queue-fault',
          'lock-fault',
          'fallback-setup-fault',
          'fallback-fault',
        ];
        for (const [status, arm] of (deferred ? [0, 7] : [0]).flatMap((value) =>
          arms.map((candidate) => [value, candidate]),
        )) {
          const acquisitionAndWriteBack = deferred
            ? `mvn_status=${status}\nmvn_stage='sdk-java test'\n${slice}`
            : slice;
          const noFlock =
            arm === 'helper-no-flock' || arm === 'fallback-no-flock';
          const dir = mkdtempSync(join(tmpdir(), 'sdk-java-lock-skip-'));
          const workspace = join(dir, 'workspace');
          const home = join(dir, 'home');
          const runnerTemp = join(dir, 'runner-temp');
          const shims = join(dir, 'bin');
          mkdirSync(join(workspace, '.github', 'scripts'), { recursive: true });
          mkdirSync(join(home, '.m2', 'repository'), { recursive: true });
          mkdirSync(join(runnerTemp, 'm2-repo'), { recursive: true });
          mkdirSync(shims);
          // A publishable delta (nlink 1, outside the pruned coordinates):
          // if the skip falls through into the write-back, it lands in the
          // host cache and the assertion below catches it.
          writeFileSync(join(runnerTemp, 'm2-repo', 'delta.marker'), 'x');
          if (arm === 'helper' || arm === 'helper-capitalised') {
            // The slot the slice sources is this stub, built from the real
            // helper's own timeout annotation. The capitalised arm pins the
            // sed rewrite's case-insensitivity against the classifiers,
            // which are all case-insensitive.
            const stubLine =
              arm === 'helper-capitalised'
                ? timeoutLine.replace(
                    /lock not acquired within/i,
                    'Lock not acquired within',
                  )
                : timeoutLine;
            writeFileSync(
              join(workspace, '.github', 'scripts', 'sdk-java-lock.sh'),
              'sdk_java_lock_acquire() {\n' +
                '  local wait_seconds=5400 seq=1 class=fast head="(no other ticket queued)"\n' +
                '  printf \'%s\\n\' "$1" >> "${RUNNER_TEMP}/lock-wait"\n' +
                `  ${stubLine.trim()}\n` +
                '  return 1\n' +
                '}\n',
            );
          } else if (arm === 'helper-no-flock') {
            // The real helper without flock on PATH: the probe must skip in
            // seconds instead of spinning out the whole wait budget.
            writeFileSync(
              join(workspace, '.github', 'scripts', 'sdk-java-lock.sh'),
              helperSource,
            );
          } else if (
            arm === 'setup-fault' ||
            arm === 'queue-fault' ||
            arm === 'lock-fault'
          ) {
            // The real helper with a broken setup: a mkdir fault, a stray
            // file at the queue path, and a directory at the lock path are
            // the shapes the parent-directory probe could not see.
            writeFileSync(
              join(workspace, '.github', 'scripts', 'sdk-java-lock.sh'),
              helperSource,
            );
            if (arm === 'setup-fault') {
              writeFileSync(join(shims, 'mkdir'), '#!/bin/sh\nexit 1\n', {
                mode: 0o755,
              });
            } else if (arm === 'queue-fault') {
              mkdirSync(join(home, '.cache', 'qwen-code-ci'), {
                recursive: true,
              });
              writeFileSync(
                join(
                  home,
                  '.cache',
                  'qwen-code-ci',
                  'sdk-java-tests.lock.queue',
                ),
                'stray',
              );
            } else {
              mkdirSync(
                join(home, '.cache', 'qwen-code-ci', 'sdk-java-tests.lock'),
                { recursive: true },
              );
            }
          } else if (arm === 'fallback-setup-fault') {
            // The fallback's own cache probe: without it a read-only HOME
            // would redden the step after the gate already passed.
            writeFileSync(join(shims, 'mkdir'), '#!/bin/sh\nexit 1\n', {
              mode: 0o755,
            });
          } else if (arm === 'fallback-fault') {
            writeFileSync(join(shims, 'flock'), '#!/bin/sh\nexit 127\n', {
              mode: 0o755,
            });
          } else if (arm === 'fallback') {
            writeFileSync(join(shims, 'flock'), '#!/bin/sh\nexit 1\n', {
              mode: 0o755,
            });
          }
          if (noFlock) {
            // Keep mkdir and sed available so the queue and rewrite paths
            // still run; flock is the only missing command this arm tests.
            for (const command of ['mkdir', 'sed']) {
              writeFileSync(
                join(shims, command),
                `#!/bin/sh\nexec /bin/${command} "$@"\n`,
                { mode: 0o755 },
              );
            }
          }
          try {
            const result = spawnSync(
              '/bin/bash',
              ['-e', '-c', acquisitionAndWriteBack],
              {
                encoding: 'utf8',
                timeout: 5000,
                env: {
                  ...process.env,
                  PATH: noFlock ? shims : `${shims}:${process.env.PATH}`,
                  HOME: home,
                  RUNNER_TEMP: runnerTemp,
                  GITHUB_WORKSPACE: workspace,
                  TIER: 'fast',
                },
              },
            );
            expect(result.error, `${name}/${arm}/${status}`).toBeUndefined();
            // A genuine timeout and a known host fault warn and skip; an
            // unexpected flock status is not a fault this call site knows,
            // so it stays fatal. A skip reports the suite's own status: a
            // red suite must not turn green because the copy was skipped.
            const label = `${name}/${arm}/${status}`;
            if (arm === 'fallback-fault') {
              expect(result.status, `${label}${result.stderr}`).toBe(1);
              expect(result.stdout, label).toContain(
                'Maven cache write-back setup failed',
              );
            } else {
              expect(result.status, `${label}${result.stderr}`).toBe(status);
              expect(result.stdout, label).toContain(
                '::warning::Maven cache write-back skipped',
              );
            }
            // Neither the call-site warning nor the helper's timeout line
            // (rewritten at the call site) may carry a rerun-classifier
            // signature onto this now-green step.
            expect(result.stdout, label).not.toMatch(signatures);
            // A red skip names the stage that failed, so the skip warning is
            // not the last word on a red step; the red-path budget clamp
            // keeps that failure from spending the green lane's queue budget.
            if (status === 0) {
              expect(result.stdout, label).not.toContain(
                '::error::Maven suite',
              );
            } else {
              expect(result.stdout, label).toContain(
                "::error::Maven suite 'sdk-java test' failed with status 7",
              );
            }
            if (arm === 'helper' || arm === 'helper-capitalised') {
              const expectedWait = deferred
                ? status === 0
                  ? '9600'
                  : '300'
                : '5400';
              expect(
                readFileSync(join(runnerTemp, 'lock-wait'), 'utf8').trim(),
                label,
              ).toBe(expectedWait);
            }
            const reasons = {
              'setup-fault':
                '::warning::Maven cache write-back skipped: the write-back queue directory cannot be created',
              'queue-fault':
                '::warning::Maven cache write-back skipped: the write-back queue directory cannot be created',
              'lock-fault':
                '::warning::Maven cache write-back skipped: the write-back lock path is a directory',
              'fallback-setup-fault':
                '::warning::Maven cache write-back skipped: ' +
                join(home, '.cache', 'qwen-code-ci') +
                ' cannot be created',
            };
            if (reasons[arm]) {
              expect(result.stdout, `${name}/${arm}`).toContain(reasons[arm]);
            }
            // The skip must not fall through into an unlocked write-back.
            expect(
              existsSync(join(home, '.m2', 'repository', 'delta.marker')),
              `${name}/${arm}`,
            ).toBe(false);
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
      }
    },
  );

  it('runs Broker tests from the combined Server after installing the SDK on self-hosted Java 21', () => {
    const block = step(job('test'), 'Run Java SDK tests (self-hosted)');
    expect(block).toContain("working-directory: 'packages/sdk-java/qwencode'");
    expect(block).toContain("MATRIX_JAVA: '${{ matrix.java }}'");
    expect(block).toContain("TIER: '${{ inputs.tier }}'");
    expect(block).toContain(
      'mvn_status=0\n' +
        "          mvn_stage='sdk-java test'\n" +
        '          mvn --batch-mode --no-transfer-progress clean test || mvn_status=$?\n' +
        '          if [ "${mvn_status}" -eq 0 ] && [ "${MATRIX_JAVA}" = "21" ]; then\n' +
        "            mvn_stage='sdk-java install'\n" +
        '            mvn --batch-mode --no-transfer-progress -DskipTests -Dgpg.skip=true -Dmaven.javadoc.skip=true install || mvn_status=$?\n' +
        '            if [ "${mvn_status}" -eq 0 ]; then\n' +
        '              cd ../../managed-agent-server\n' +
        '              # The fast tier skips mysql-integration, which owns the full H2 unit suite.\n' +
        '              if [ "${TIER}" = "fast" ]; then\n' +
        "                mvn_stage='runtime-broker H2 suite'\n" +
        '                mvn --batch-mode --no-transfer-progress clean test || mvn_status=$?\n' +
        '              else\n' +
        "                mvn_stage='runtime-broker suite'\n" +
        `                mvn --batch-mode --no-transfer-progress '-Dtest=${brokerTestPattern}' clean test || mvn_status=$?\n` +
        '              fi\n' +
        '            fi\n' +
        '          fi',
    );
  });

  it('defers the Maven status so a red suite still reaches the write-back', () => {
    const block = step(job('test'), 'Run Java SDK tests (self-hosted)');
    const mvnLines = block
      .split('\n')
      .filter((line) => /^\s+mvn --batch-mode/.test(line));
    expect(mvnLines).toHaveLength(4);
    for (const line of mvnLines) {
      // A bare `mvn` would stop the step under errexit, so the write-back
      // below never ran for a red suite — the downloads of that run were
      // then re-fetched by the next leg.
      expect(line).toMatch(/ \|\| mvn_status=\$\?$/);
    }
    // Every tolerated skip reports the deferred suite status instead of
    // turning a red suite green: the fault handler, both timeout arms, and
    // the end of the step.
    expect(block).not.toMatch(/^\s+exit 0$/m);
    expect(block.match(/exit "\$\{mvn_status\}"/g)).toHaveLength(4);
    expect(block.trimEnd().endsWith('exit "${mvn_status}"')).toBe(true);
    // Each Maven run names its stage, and every exit that can end a red step
    // reports it through the one reporter: the write-back output is the log
    // tail, so the tail alone cannot tell three suites apart.
    expect(block.match(/mvn_stage='[^']+'/g)).toHaveLength(4);
    expect(block.match(/mvn_report_failed_suite/g)).toHaveLength(6);
    expect(block).toContain(
      "echo \"::error::Maven suite '${mvn_stage}' failed with status ${mvn_status}",
    );
    expect(block).not.toContain('the cache write-back above ran after it');
  });

  it.skipIf(process.platform !== 'linux')(
    'publishes the job-local repository when the Maven suite fails',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'sdk-java-failed-suite-'));
      const workspace = join(dir, 'workspace');
      const home = join(dir, 'home');
      const runnerTemp = join(dir, 'runner-temp');
      const shims = join(dir, 'bin');
      const cwd = join(dir, 'repo', 'packages', 'sdk-java', 'qwencode');
      mkdirSync(join(workspace, '.github', 'scripts'), { recursive: true });
      mkdirSync(join(home, '.m2', 'repository'), { recursive: true });
      mkdirSync(cwd, { recursive: true });
      mkdirSync(shims);
      // Create the directory itself, not `m2-repo`: with the copy target
      // already present the seed would copy *into* it and bypass the path
      // the write-back publishes from.
      mkdirSync(runnerTemp, { recursive: true });
      writeFileSync(
        join(workspace, '.github', 'scripts', 'sdk-java-lock.sh'),
        'sdk_java_lock_acquire() {\n' +
          '  printf \'%s\\n\' "$1" >> "${RUNNER_TEMP}/lock-wait"\n' +
          '  return 0\n' +
          '}\n',
      );
      // A failing suite that still downloaded one artifact: the write-back
      // must publish it, the step must keep Maven's status, and the later
      // suites must not run. The marker and *.tmp names are what a failed
      // resolution and an interrupted transfer leave behind; both must stay
      // out of the host cache, which nothing ever deletes from.
      writeFileSync(
        join(shims, 'mvn'),
        '#!/bin/sh\n' +
          'printf "%s\\n" "$*" >> "${RUNNER_TEMP}/mvn-calls"\n' +
          'mkdir -p "${RUNNER_TEMP}/m2-repo/org/example/newdep/1.0"\n' +
          'printf data > "${RUNNER_TEMP}/m2-repo/org/example/newdep/1.0/newdep-1.0.jar"\n' +
          'printf err > "${RUNNER_TEMP}/m2-repo/org/example/newdep/1.0/newdep-1.0.jar.lastUpdated"\n' +
          'printf central > "${RUNNER_TEMP}/m2-repo/org/example/newdep/1.0/_remote.repositories"\n' +
          'printf fragment > "${RUNNER_TEMP}/m2-repo/org/example/newdep/1.0/newdep-1.0.jar.1234.5678.tmp"\n' +
          'exit 7\n',
        { mode: 0o755 },
      );
      try {
        const stepBlock = parse(workflow).jobs.test.steps.find(
          (candidate) => candidate.name === 'Run Java SDK tests (self-hosted)',
        );
        const result = spawnSync(
          'bash',
          ['--noprofile', '--norc', '-eo', 'pipefail', '-c', stepBlock.run],
          {
            encoding: 'utf8',
            cwd,
            timeout: 30_000,
            env: {
              ...process.env,
              PATH: `${shims}:${process.env.PATH}`,
              GITHUB_WORKSPACE: workspace,
              HOME: home,
              RUNNER_TEMP: runnerTemp,
              MATRIX_JAVA: '21',
              TIER: 'fast',
            },
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(7);
        // The write-back output is the log tail now, so the deferred exit
        // names the stage that failed instead of leaving only the runner's
        // bare "process completed with exit code".
        expect(result.stdout).toContain(
          "::error::Maven suite 'sdk-java test' failed with status 7",
        );
        // That annotation lands where the rerun classifiers grep, so it must
        // stay clear of INFRA_FAILURE_SIGNATURES like every other line this
        // step emits — otherwise a genuine test failure auto-reruns.
        expect(result.stdout).not.toMatch(
          new RegExp(
            parse(
              readFileSync('.github/workflows/qwen-autofix.yml', 'utf8'),
            ).env.INFRA_FAILURE_SIGNATURES,
            'i',
          ),
        );
        // A red leg does not spend the green lane's 9600 s queue budget.
        expect(readFileSync(join(runnerTemp, 'lock-wait'), 'utf8').trim()).toBe(
          '300',
        );
        const published = (...parts) =>
          join(
            home,
            '.m2',
            'repository',
            'org',
            'example',
            'newdep',
            '1.0',
            ...parts,
          );
        expect(existsSync(published('newdep-1.0.jar'))).toBe(true);
        // The marker and interrupted-transfer names record a resolution
        // outcome rather than an artifact: published, every later seed would
        // hardlink them and nothing ever deletes from the host cache.
        for (const name of [
          'newdep-1.0.jar.lastUpdated',
          '_remote.repositories',
          'newdep-1.0.jar.1234.5678.tmp',
        ]) {
          expect(existsSync(published(name)), name).toBe(false);
        }
        // The failure stops the remaining suites instead of letting a red
        // lane spend the install and H2 suite on top of it.
        expect(
          readFileSync(join(runnerTemp, 'mvn-calls'), 'utf8')
            .trim()
            .split('\n'),
        ).toHaveLength(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

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

  it.each([
    {
      name: 'test',
      artifact:
        'sdk-java-test-reports-${{ matrix.os }}-java-${{ matrix.java }}',
      paths: [
        'packages/sdk-java/qwencode/target/surefire-reports/*.txt',
        'packages/sdk-java/qwencode/target/surefire-reports/*.dumpstream',
        'packages/managed-agent-server/verification/target/surefire-reports/*.txt',
        'packages/managed-agent-server/verification/target/surefire-reports/*.dumpstream',
      ],
      testStep: 'Run Runtime Broker state tests',
    },
    {
      name: 'mysql-integration',
      artifact: 'sdk-java-test-reports-mysql-integration-java-21',
      paths: [
        'packages/managed-agent-server/verification/src/test/embedding-host/target/surefire-reports/*',
        'packages/managed-agent-server/verification/target/surefire-reports/*.txt',
        'packages/managed-agent-server/verification/target/surefire-reports/*.dumpstream',
        'packages/managed-agent-server/verification/target/failsafe-reports/*.txt',
        'packages/managed-agent-server/verification/target/failsafe-reports/*.dumpstream',
      ],
      testStep:
        'Install and verify Managed Agent dependencies, tests, Checkstyle, and MySQL integration',
    },
  ])(
    'preserves Surefire text reports on $name test failure',
    ({ name, artifact, paths, testStep }) => {
      const steps = parse(workflow).jobs[name].steps;
      const upload = steps.find(
        (s) => s.name === 'Upload Maven test reports on failure',
      );
      expect(upload.if).toBe('failure() || cancelled()');
      expect(upload.uses).toBe(
        'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
      );
      expect(upload.with.name).toBe(artifact);
      const matrix = parse(workflow).jobs[name].strategy?.matrix;
      const legs = matrix?.include;
      if (matrix && (!Array.isArray(legs) || legs.length > 1)) {
        expect(artifact).toMatch(/\$\{\{\s*matrix\./);
      } else {
        expect(artifact).not.toMatch(/\$\{\{\s*matrix\./);
      }
      expect(upload.with.path.trim().split('\n')).toEqual(paths);
      expect(upload.with['if-no-files-found']).toBe('ignore');
      expect(upload.with['retention-days']).toBe(7);
      const testIndex = steps.findIndex((s) => s.name === testStep);
      expect(testIndex).toBeGreaterThan(-1);
      expect(steps.indexOf(upload)).toBeGreaterThan(testIndex);
    },
  );

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
    const cwd = 'packages/managed-agent-server/verification/src/test/java';
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
      readFileSync(
        'packages/managed-agent-server/verification/pom.xml',
        'utf8',
      ),
    ).toContain('<failIfNoTests>true</failIfNoTests>');
  });

  it('checks both package rulesets in the standalone Checkstyle lane', () => {
    const block = step(job('test'), 'Run Managed Agent Server Checkstyle');
    expect(block).toContain(
      'checkstyle:check checkstyle:check@runtime-broker-checkstyle',
    );
    // The self-hosted SDK install populates the job-local repository, so the
    // ECS leg must resolve from it; without the suffix Checkstyle reads the
    // host-shared ~/.m2, where another run's same-coordinate jar can sit.
    // The hosted leg's state-test step populates the default repository.
    expect(block).toContain(
      'if [ "${RUNNER_ENVIRONMENT}" = "self-hosted" ]; then',
    );
    expect(block).toContain(
      'export MAVEN_ARGS="${MAVEN_ARGS} -Dmaven.repo.local=${RUNNER_TEMP}/m2-repo"',
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
    // a job-local -Dmaven.repo.local to both Maven-bearing steps
    // (pinned by the 'installs and verifies against one job-local Maven
    // repository' test), the EventTransport lanes to both of theirs, and
    // the test job to its self-hosted suite; the other jobs must carry no
    // suffix at all — an appended -DskipTests would be word-split live by
    // the mvn launcher.
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
        'cp -aln "${HOME}/.m2/repository/." "${RUNNER_TEMP}/m2-repo/"',
      );
    } else if (name === 'test') {
      // The self-hosted suite resolves from a job-local repository; only the
      // cache write-back takes the host lock. Bind the suffix to the step,
      // not just its count: moving it to another step leaves the suite on
      // the host-shared ~/.m2 and the write-back with no delta to publish.
      expect(jobLocal?.length ?? 0).toBe(1);
      const selfHosted = parse(workflow).jobs[name].steps.find(
        (candidate) => candidate.name === 'Run Java SDK tests (self-hosted)',
      );
      expect(selfHosted?.env?.MAVEN_ARGS).toContain(
        '-Dmaven.repo.local=${{ runner.temp }}/m2-repo',
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
// while the pool legs passed. The MySQL lane is pool-safe (per-job
// container, no host installs), so its trusted runs route to the ECS pool the
// way the flyway guard's do; untrusted fork PRs stay hosted.
describe('SDK Java MySQL lane on the ECS pool', () => {
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

  it('runs the complete non-Hosted family on MySQL only', () => {
    const mysql = parse(workflow).jobs['mysql-integration'];
    expect(mysql.name).toBe('Runtime Broker and Managed Agent MySQL / Java 21');
    expect(mysql.services).toBeUndefined();
    expect(mysql.strategy).toBeUndefined();
    expect(JSON.stringify(mysql)).not.toMatch(/mariadb|matrix\./i);
    expect(mysql.env).toEqual({
      MYSQL_CONTAINER:
        'qwen-code-sdk-java-mysql-${{ github.run_id }}-${{ github.run_attempt }}',
    });
    const start = mysql.steps.find(
      (s) => s.name === 'Start the database without native AIO',
    );
    const configure = mysql.steps.find(
      (s) =>
        s.name ===
        'Configure the database packet budget for large-object tests',
    );
    const verify = mysql.steps.find((s) =>
      s.run?.includes('-Pmysql-integration'),
    );
    const guard = mysql.steps.find(
      (step) =>
        step.name === 'Check that every non-Hosted integration test class ran',
    );
    expect(guard.run).toBe(
      'node scripts/check-failsafe-reports.js non-hosted packages/managed-agent-server',
    );
    const command = verify.run
      .replace(/\\\n/g, ' ')
      .match(/^\s*mvn .*-Pmysql-integration.*$/m)[0];
    expect(command).toContain('clean verify checkstyle:check');
    expect(command).not.toMatch(
      /-D(?:skipTests|skipITs|test|it\.test)(?:=|\s)/,
    );
    const cleanup = mysql.steps.at(-1);
    expect(start.shell).toBe('bash');
    // The shell tests below execute this body verbatim.
    expect(start.run).not.toContain('${{');
    expect(start.run).toContain(
      'mysql:8.4.6 --innodb-use-native-aio=0 --skip-log-bin',
    );
    expect(start.run).toContain("--publish '127.0.0.1::3306'");
    expect(start.run).toContain(
      '--mount type=tmpfs,destination=/var/lib/mysql',
    );
    // The lane's only consumer is the JDBC URL below, which owns its schema
    // through createDatabaseIfNotExist; a declared-but-unconsumed database
    // here would invite dropping that flag and dying on first connect.
    expect(start.run).not.toContain('MYSQL_DATABASE');
    expect(start.run).toContain("--env MYSQL_ROOT_PASSWORD='runtime-broker'");
    expect(start.run).toContain('for fork in 1 2');
    expect(start.run).toContain('for attempt in {1..60}');
    expect(start.run).toContain('sleep 2');
    expect(start.run).toContain(
      'mysqladmin ping --host=127.0.0.1 --user=root --password=runtime-broker --silent',
    );
    expect(start.run).toContain(
      'echo "MYSQL_PORT_${fork}=${port}" >> "${GITHUB_ENV}"',
    );
    expect(configure.env?.MYSQL_CONTAINER).toBeUndefined();
    expect(configure.run).toContain('for fork in 1 2');
    expect(configure.run).toContain(
      'docker exec "${MYSQL_CONTAINER}-${fork}" sh -c',
    );
    expect(configure.run).toContain('MYSQL_PWD="${MYSQL_ROOT_PASSWORD}" mysql');
    expect(configure.run).toContain('SET GLOBAL max_allowed_packet=134217728');
    expect(verify.env.MYSQL_PORT).toBeUndefined();
    expect(verify.run).toContain(
      '-Dmysql.url="jdbc:mysql://127.0.0.1:${MYSQL_PORT_1}/managed_agent_test?createDatabaseIfNotExist=true&allowPublicKeyRetrieval=true&useSSL=false"',
    );
    expect(verify.run).toContain('-Dmysql.integration.forks=2');
    for (const fork of [1, 2]) {
      expect(verify.run).toContain(
        `-Dmysql.url.${fork}="jdbc:mysql://127.0.0.1:\${MYSQL_PORT_${fork}}/managed_agent_test?createDatabaseIfNotExist=true&allowPublicKeyRetrieval=true&useSSL=false"`,
      );
    }
    expect(mysql.steps.indexOf(start)).toBeLessThan(
      mysql.steps.indexOf(configure),
    );
    expect(mysql.steps.indexOf(configure)).toBeLessThan(
      mysql.steps.indexOf(verify),
    );
    expect(cleanup.name).toBe('Remove the database containers');
    // The shell probe below cannot establish Actions cancellation scheduling.
    expect(cleanup.if).toBe('${{ always() }}');
    expect(cleanup.shell).toBe('bash');
  });

  it
    .skipIf(process.platform === 'win32')
    .each(['ready', 'dead', 'timeout', 'dead-second', 'timeout-second'])(
    'executes MySQL startup and consumers with a %s container',
    (mode) => {
      const mysql = parse(workflow).jobs['mysql-integration'];
      const start = mysql.steps.find(
        (s) => s.name === 'Start the database without native AIO',
      );
      const configure = mysql.steps.find(
        (s) =>
          s.name ===
          'Configure the database packet budget for large-object tests',
      );
      const verify = mysql.steps.find((s) =>
        s.run?.includes('-Pmysql-integration'),
      );
      // The step also stages the SDK with `-DskipTests install`, so pick the
      // integration command rather than the step's first Maven line.
      const command = verify.run
        .replace(/\\\n/g, ' ')
        .match(/^\s*mvn .*-Pmysql-integration.*$/m)[0];
      const dir = mkdtempSync(join(tmpdir(), 'sdk-java-mysql-'));
      const container = 'qwen-code-sdk-java-mysql-123-2';
      try {
        const result = spawnSync(
          'bash',
          [
            '-e',
            '-o',
            'pipefail',
            '-c',
            `
          attempts=0
          docker() {
            printf 'DOCKER<%s>\\n' "$*" >> "$TRACE"
            printf 'ARGC<%s>\\n' "$#" >> "$TRACE"
            case "$1" in
              run) attempts=0; return 0 ;;
              exec)
                if [[ "$3" == mysqladmin ]]; then
                  attempts=$((attempts + 1))
                  if [[ ( "$MODE" == ready || ( "$MODE" == *-second && "$2" == *-1 ) ) && "$attempts" -eq 3 ]]; then
                    return 0
                  fi
                  echo 'PROBE_SAYS_NO' >&2
                  return 1
                fi
                [[ "$3" == sh && "$5" == *'SET GLOBAL max_allowed_packet=134217728'* ]] ;;
              inspect)
                if [[ "$3" == *State.Running* ]]; then
                  [[ "$MODE" == dead || ( "$MODE" == dead-second && "$4" == *-2 ) ]] && echo false || echo true
                else
                  [[ "$4" == *-1 ]] && echo 43219 || echo 43220
                fi ;;
              logs) echo MYSQL_FAILURE_LOG ;;
              *) return 92 ;;
            esac
          }
          sleep() { printf 'SLEEP<%s>\\n' "$*" >> "$TRACE"; }
          ${start?.run}
          ${configure?.run}
          set -a
          source "$GITHUB_ENV"
          set +a
          mvn() { printf 'MAVEN<%s>\\n' "$@"; }
          ${command}
        `,
          ],
          {
            encoding: 'utf8',
            timeout: 5000,
            env: {
              ...process.env,
              MODE: mode,
              MYSQL_CONTAINER: container,
              GITHUB_ENV: join(dir, 'env'),
              RUNNER_TEMP: dir,
              TRACE: join(dir, 'trace'),
            },
          },
        );
        expect(result.error).toBeUndefined();
        const trace = readFileSync(join(dir, 'trace'), 'utf8');
        expect(trace).toContain(
          `run --detach --name ${container}-1 --publish 127.0.0.1::3306 --mount type=tmpfs,destination=/var/lib/mysql --env MYSQL_ROOT_PASSWORD=runtime-broker mysql:8.4.6 --innodb-use-native-aio=0 --skip-log-bin`,
        );
        expect(trace).toContain('ARGC<13>');
        expect(trace).toContain(`exec ${container}-1 mysqladmin`);
        if (mode === 'ready' || mode.endsWith('-second')) {
          expect(trace).toContain(
            `run --detach --name ${container}-2 --publish 127.0.0.1::3306 --mount type=tmpfs,destination=/var/lib/mysql --env MYSQL_ROOT_PASSWORD=runtime-broker mysql:8.4.6 --innodb-use-native-aio=0 --skip-log-bin`,
          );
          expect(trace).toContain(`exec ${container}-2 mysqladmin`);
        }
        if (mode === 'ready') {
          expect(result.status, result.stderr).toBe(0);
          expect(readFileSync(join(dir, 'env'), 'utf8')).toBe(
            'MYSQL_PORT_1=43219\nMYSQL_PORT_2=43220\n',
          );
          expect(trace.match(/SLEEP<2>/g)).toHaveLength(4);
          expect(result.stdout).toContain(
            'MAVEN<-Dmysql.url=jdbc:mysql://127.0.0.1:43219/managed_agent_test?createDatabaseIfNotExist=true&allowPublicKeyRetrieval=true&useSSL=false>',
          );
          expect(result.stdout).toContain('MAVEN<-Dmysql.integration.forks=2>');
          for (const fork of [1, 2]) {
            expect(result.stdout).toContain(
              `MAVEN<-Dmysql.url.${fork}=jdbc:mysql://127.0.0.1:${43218 + fork}/managed_agent_test?createDatabaseIfNotExist=true&allowPublicKeyRetrieval=true&useSSL=false>`,
            );
            expect(trace).toContain(`exec ${container}-${fork} sh -c`);
          }
          expect(result.stdout).not.toContain('MYSQL_FAILURE_LOG');
          expect(result.stdout).not.toContain('PROBE_SAYS_NO');
        } else {
          expect(result.status, result.stderr).toBe(1);
          expect(result.stdout).toContain('MYSQL_FAILURE_LOG');
          // The probe's own output must reach the log: a broken probe is
          // otherwise indistinguishable from a server still starting.
          expect(result.stdout).toContain('PROBE_SAYS_NO');
          const second = mode.endsWith('-second');
          if (second) {
            expect(readFileSync(join(dir, 'env'), 'utf8')).toBe(
              'MYSQL_PORT_1=43219\n',
            );
          } else {
            expect(existsSync(join(dir, 'env'))).toBe(false);
          }
          expect(trace.match(/exec \S+ mysqladmin/g)).toHaveLength(
            (second ? 3 : 0) + (mode.startsWith('dead') ? 1 : 60),
          );
          expect(trace.match(/SLEEP<2>/g) ?? []).toHaveLength(
            (second ? 2 : 0) + (mode.startsWith('dead') ? 0 : 59),
          );
          expect(result.stdout).not.toContain('MAVEN<');
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it
    .skipIf(process.platform === 'win32')
    .each([
      'exists',
      'missing',
      'removal-fails',
      'first-missing',
      'first-removal-fails',
    ])('executes owned MySQL cleanup when the container %s', (mode) => {
    const cleanup = parse(workflow).jobs['mysql-integration'].steps.at(-1);
    const result = spawnSync(
      'bash',
      [
        '-e',
        '-c',
        `
        docker() {
          printf 'DOCKER<%s>\\n' "$*"
          if [[ "$1" == inspect ]]; then [[ "$MODE" != missing && ! ( "$MODE" == first-missing && "$2" == *-1 ) ]];
          elif [[ "$1" == rm ]]; then [[ "$MODE" != removal-fails && ! ( "$MODE" == first-removal-fails && "$3" == *-1 ) ]];
          else return 92; fi
        }
        ${cleanup.run}
      `,
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          ...process.env,
          MODE: mode,
          MYSQL_CONTAINER: 'qwen-code-sdk-java-mysql-123-2',
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    for (const fork of [1, 2]) {
      expect(
        result.stdout.includes(
          `DOCKER<rm --force qwen-code-sdk-java-mysql-123-2-${fork}>`,
        ),
      ).toBe(mode !== 'missing' && !(mode === 'first-missing' && fork === 1));
      expect(
        result.stdout.includes(
          `::warning::could not remove qwen-code-sdk-java-mysql-123-2-${fork}; the host cleanup service reaps it within ~48h`,
        ),
      ).toBe(
        mode === 'removal-fails' ||
          (mode === 'first-removal-fails' && fork === 1),
      );
    }
  });

  it('holds the per-host sdk-java lock once around the cache write-back', () => {
    // The Maven runs resolve from the job-local repository, so the lock now
    // guards only the host-shared cache write-back. Run 39627609266's
    // fast-tier job burned its full 90-minute wait while the previous
    // whole-suite hold ran from 15:54 to 18:57 (run 39628985638); a
    // multi-hour verify must not sit between the fast tier and its hold.
    const parsed = parse(workflow);
    const mavenSteps = parsed.jobs['mysql-integration'].steps.filter(
      (s) =>
        typeof s.run === 'string' &&
        (s.run.includes('mvn ') ||
          s.run.includes('verify-managed-agent-embedding.sh')),
    );
    expect(mavenSteps.map((s) => s.name)).toEqual([
      'Install and verify Managed Agent dependencies, tests, Checkstyle, and MySQL integration',
      'Verify ordinary and enabled embedding hosts',
    ]);
    expect(mavenSteps[1].run).not.toContain('sdk_java_lock_acquire');
    expect(
      readFileSync('.github/scripts/verify-managed-agent-embedding.sh', 'utf8'),
    ).not.toContain('sdk_java_lock_acquire');
    expect(mavenSteps[1].env.MAVEN_ARGS).toBe(mavenSteps[0].env.MAVEN_ARGS);
    const [step] = mavenSteps;
    expect(step.run).toContain(
      'source "${GITHUB_WORKSPACE}/.github/scripts/sdk-java-lock.sh"',
    );
    // Same ref-independence guard as the test job: a resumed release tag may
    // predate the helper, so this site must also keep the bare-lock arm.
    expect(step.run).toContain('flock --wait 5400 9');
    expect(step.run).toContain(
      '::warning::Maven cache write-back skipped: the sdk-java host lock stayed busy for the full wait budget',
    );
    const seconds = Number(step.run.match(/sdk_java_lock_acquire (\d+)/)?.[1]);
    // The fast tier owns the same lock: it overtakes this job only while
    // this ticket still waits, then waits out its hold. This write-back
    // keeps the shorter budget because its hold is the bounded copy and it
    // waits after the ~3-hour verify; the sibling test lane carries the
    // longer budget pinned below. Run 39229303984 died at the old 60-minute
    // wait before Maven started.
    expect(seconds).toBe(90 * 60);
    // This site stays in the normal class: a tier argument here would put
    // full-tier MariaDB holds ahead of fast PR-feedback work.
    expect(step.run).toContain(
      'sdk_java_lock_acquire 5400 >&7 2>&1 || lock_rc=$?',
    );
    // Promotion must fire strictly inside the acquisition budget; at or
    // above it the rename lands in the iteration whose timeout arm deletes
    // the ticket, and no test would see the anti-starvation arm go dead.
    const helper = readFileSync('.github/scripts/sdk-java-lock.sh', 'utf8');
    const promoteAfter = Number(
      helper.match(/SDK_JAVA_LOCK_PROMOTE_AFTER:-(\d+)/)?.[1],
    );
    expect(promoteAfter).toBeGreaterThan(0);
    expect(promoteAfter).toBeLessThan(seconds);
    const lockWait = step.run.match(/sdk_java_lock_acquire \d+/)?.[0];
    expect(lockWait).toBeDefined();
    const lockAt = step.run.indexOf(lockWait);
    const installAt = step.run.indexOf('-f packages/sdk-java/qwencode/pom.xml');
    // The deleted `working-directory:` applied to the whole step; its `cd`
    // replacement only applies from where it sits, so pin it between the two
    // Maven runs: above the install it breaks the SDK `-f` path, below the
    // verify it runs `clean verify` in the wrong module.
    const cdAt = step.run.indexOf('cd packages/managed-agent-server');
    const verifyAt = step.run.indexOf('-Pmysql-integration');
    const writeBackAt = step.run.indexOf('cd "${RUNNER_TEMP}/m2-repo"');
    expect(lockAt).toBeGreaterThan(-1);
    expect(installAt).toBeGreaterThan(-1);
    expect(installAt).toBeLessThan(lockAt);
    expect(cdAt).toBeGreaterThan(installAt);
    expect(verifyAt).toBeGreaterThan(cdAt);
    expect(verifyAt).toBeLessThan(lockAt);
    expect(writeBackAt).toBeGreaterThan(lockAt);
    // The ceiling must absorb one full lock wait, the ~3-hour Maven run,
    // the write-back backstop and ~30 minutes of uncapped setup; 310 leaves
    // a few minutes of margin.
    const writeBackBound = Number(
      step.run.match(/timeout (\d+) find \. /)?.[1],
    );
    expect(writeBackBound).toBe(300);
    expect(
      parsed.jobs['mysql-integration']['timeout-minutes'] * 60,
    ).toBeGreaterThanOrEqual(seconds + 3 * 60 * 60 + writeBackBound + 30 * 60);
    // The sibling test job carries the longer, now-conservative 9600 s
    // budget; its ceiling must cover that full wait, its worst measured
    // whole-step suite at this head (1205 s; the 925 s suite-alone figure
    // from #14801 is a lower bound), the bounded write-back it guards and
    // ~11 minutes of setup.
    const testBudget = Number(
      parsed.jobs.test.steps
        .map((s) => s.run?.match(/lock_wait=(\d+)/)?.[1])
        .find(Boolean),
    );
    expect(testBudget).toBe(9600);
    expect(testBudget).toBeGreaterThan(seconds);
    expect(parsed.jobs.test['timeout-minutes'] * 60).toBeGreaterThanOrEqual(
      testBudget + 1205 + writeBackBound + 11 * 60,
    );
  });

  it('installs and verifies against one job-local Maven repository', () => {
    // The fixed 0.1.0-alpha release coordinates must not resolve from the
    // host-shared ~/.m2: the job-local repo is seeded from that cache, and
    // both Maven runs resolve from the same copy.
    const steps = parse(workflow).jobs['mysql-integration'].steps;
    const step = steps.find(
      (s) =>
        s.name ===
        'Install and verify Managed Agent dependencies, tests, Checkstyle, and MySQL integration',
    );
    expect(step?.env?.MAVEN_ARGS).toContain(
      '-Dmaven.repo.local=${{ runner.temp }}/m2-repo',
    );
    expect(step.run).toContain(
      'cp -aln "${HOME}/.m2/repository/." "${RUNNER_TEMP}/m2-repo/"',
    );
    // The write-back closes the host-shared ~/.m2 loop — the seed above only
    // reads that repository, so without it a pom key rotation leaves a
    // thin entry that never recaptures the managed-agent-server tree. The
    // excludes name the in-house fixed release coordinates, not the
    // whole com/alibaba group, so third-party artifacts under it (druid)
    // still recapture. The write-back is best-effort like the seed: its
    // warning arms keep a copy failure from reddening the gate after mvn
    // has already passed.
    expect(step.run).toContain('mkdir -p "${HOME}/.m2/repository"');
    // This lane's Maven runs fail inline, so only a green run reaches the
    // copy. Growing the test lane's deferred status here without its exit
    // would turn a red suite green and publish it, so the premise the two
    // lanes' asymmetry rests on stays pinned.
    expect(step.run).not.toContain('mvn_status');
    // Run 39563394993 spent 60 minutes streaming the whole seeded tree and
    // was cancelled at the job ceiling. Only the nlink == 1 delta Maven
    // fetched in this job is published, by per-file hardlinks that never
    // replace a host file, so the 300 s backstop cannot leave a truncated
    // artifact in the shared cache the next seed hardlinks from.
    expect(step.run).toContain('cd "${RUNNER_TEMP}/m2-repo"');
    expect(step.run).toContain(writeBackFind);
    expect(step.run).not.toMatch(/tar [^\n]*-xf/);
    expect(step.run).toContain(
      'if [ "${write_back}" -eq 124 ]; then\n  echo "::warning::Maven cache write-back stopped after 300 s;',
    );
    expect(step.run).toContain(
      'elif [ "${write_back}" -ne 0 ]; then\n  echo "::warning::Maven cache write-back failed; the gate result above is unaffected"',
    );
    // One body replaced the two-step split, so only these positions still
    // order the phases: the write-back runs against a directory the seed has
    // not created yet if hoisted above it, and its warning arm swallows the
    // failure instead of reddening the gate.
    const seedAt = step.run.indexOf('cp -aln "${HOME}/.m2/repository/."');
    const installAt = step.run.indexOf('-f packages/sdk-java/qwencode/pom.xml');
    const verifyAt = step.run.indexOf('-Pmysql-integration');
    const writeBackAt = step.run.indexOf('cd "${RUNNER_TEMP}/m2-repo"');
    expect(seedAt).toBeGreaterThan(-1);
    expect(installAt).toBeGreaterThan(seedAt);
    expect(verifyAt).toBeGreaterThan(installAt);
    expect(writeBackAt).toBeGreaterThan(verifyAt);
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

// A bare `corepack pnpm install` has no retry. Run 39348512071's daemon E2E
// lane died in that step before any test ran, inside the workspace build the
// install's `prepare` re-enters: packages/cli's `tsc --build` exhausted V8's
// heap. The network class of that failure is what e2e.yml, repo-hygiene.yml
// and qwen-autofix.yml already absorb (#11726); the heap class is capped in
// pnpm-workspace.yaml, and a retry only offers it a quieter host. Pin the
// recipe on every install so a new bare step fails here instead of on main.
// For the five installs that do not set QWEN_SKIP_PREPARE, each attempt
// re-runs prepare's build (~4m32s observed), not just backoff; daemon-e2e
// skips the build and only runs `npm run generate` on each attempt.
// Scope is sdk-java.yml: release-sdk-java.yml's install is a bare one-liner
// with no retry loop or prepare skip, so these assertions do not describe it;
// its explicit Build/Bundle/Run steps are pinned separately above.
describe('SDK Java install-transient retry', () => {
  // Mirrors scripts/prepare.js, which skips on '1' or 'true' case-insensitively;
  // Actions merges workflow/job env into the step environment.
  const installSkipsPrepare = (step, inheritedEnv = {}) =>
    ['1', 'true'].includes(
      String(
        { ...inheritedEnv, ...step.env }.QWEN_SKIP_PREPARE ?? '',
      ).toLowerCase(),
    );

  const parsedWorkflow = parse(workflow);
  const installs = Object.entries(parsedWorkflow.jobs).flatMap(
    ([jobName, job]) =>
      (job.steps ?? [])
        .filter(
          (s) => typeof s.run === 'string' && s.run.includes('pnpm install'),
        )
        .map((s) => [jobName, s, { ...parsedWorkflow.env, ...job.env }]),
  );

  it('finds every install step', () => {
    expect(installs.map(([jobName]) => jobName).sort()).toEqual([
      'daemon-e2e',
      'event-transport-multi-node',
      'hosted-failover-e2e',
      'hosted-harness-mysql',
      'mysql-integration',
      'test',
    ]);
  });

  it.each(installs)(
    "%s install warning matches the step's prepare behaviour",
    (jobName, step, inheritedEnv) => {
      const skips = installSkipsPrepare(step, inheritedEnv);
      expect(step.run, jobName).toMatch(
        new RegExp(
          '::warning::[^\\n]*' +
            (skips
              ? "this step skips prepare's build"
              : "this step also runs prepare's build"),
        ),
      );
    },
  );

  it('classifies prepare-skip spellings the way scripts/prepare.js does', () => {
    for (const value of ['1', 'true', 'TRUE', 1]) {
      expect(installSkipsPrepare({ env: { QWEN_SKIP_PREPARE: value } })).toBe(
        true,
      );
      expect(installSkipsPrepare({}, { QWEN_SKIP_PREPARE: value })).toBe(true);
    }
    for (const value of [undefined, '', '0', 'false']) {
      expect(installSkipsPrepare({ env: { QWEN_SKIP_PREPARE: value } })).toBe(
        false,
      );
    }
  });

  it.each(installs)('%s retries a transient install', (jobName, step) => {
    for (const fragment of [
      'for attempt in 1 2 3; do',
      'if corepack pnpm install --frozen-lockfile --prefer-offline --reporter=append-only; then',
      'if [[ "${attempt}" != "1" ]]; then',
      'echo "::warning::corepack pnpm install',
      'break',
      'if [[ "${attempt}" == "3" ]]; then',
      'exit 1',
      'sleep $((attempt * 15))',
    ]) {
      expect(step.run, jobName).toContain(fragment);
    }
    expect(step.run, jobName).not.toMatch(/^\s*corepack pnpm install/m);
  });

  it.skipIf(process.platform === 'win32')(
    'retries a failed install and exits 1 only after the third attempt',
    () => {
      const [, installStep] = installs.find(
        ([jobName]) => jobName === 'daemon-e2e',
      );
      const runInstall = (failures) =>
        spawnSync(
          'bash',
          [
            '--noprofile',
            '--norc',
            '-e',
            '-o',
            'pipefail',
            '-c',
            [
              'attempts=0',
              `corepack() {
                attempts=$((attempts + 1))
                echo "ATTEMPT $attempts"
                if (( attempts < ${failures} )); then return 1; fi
                return 0
              }`,
              'sleep() { echo "SLEEP $1"; }',
              installStep.run,
            ].join('\n'),
          ],
          { encoding: 'utf8' },
        );

      const absorbed = runInstall(2);
      expect(absorbed.error).toBeUndefined();
      expect(absorbed.status, absorbed.stderr).toBe(0);
      expect(absorbed.stdout.match(/ATTEMPT/g)).toHaveLength(2);
      expect(absorbed.stdout).toContain('SLEEP 15');
      expect(absorbed.stdout).toContain('failed 1 time(s)');

      const firstTry = runInstall(1);
      expect(firstTry.status, firstTry.stderr).toBe(0);
      expect(firstTry.stdout.match(/ATTEMPT/g)).toHaveLength(1);
      expect(firstTry.stdout).not.toContain('::warning::');
      expect(firstTry.stdout).not.toContain('SLEEP');

      const exhausted = runInstall(4);
      expect(exhausted.error).toBeUndefined();
      expect(exhausted.status, exhausted.stderr).toBe(1);
      expect(exhausted.stdout.match(/ATTEMPT/g)).toHaveLength(3);
      expect(exhausted.stdout).toContain('SLEEP 30');
      expect(exhausted.stdout).not.toContain('::warning::');
    },
  );
});
