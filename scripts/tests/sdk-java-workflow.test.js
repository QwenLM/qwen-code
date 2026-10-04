import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

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
// trigger — no self-hosted routing, no Java, no database.
describe('SDK Java Flyway migration version guard', () => {
  it('runs the uniqueness check as an unconditional job', () => {
    const block = job('flyway-migrations');
    expect(block).toContain("runs-on: 'ubuntu-latest'");
    expect(block).toContain('actions/checkout@');
    expect(block).not.toContain('if:');
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
    }
  });
});

describe('SDK Java Hosted latency baseline CI contract', () => {
  it('includes latency paths in pull_request and push triggers', () => {
    const yml = parse(workflow);
    const paths = [
      'integration-tests/cli/hosted-latency-baseline.test.ts',
      'integration-tests/baselines/hosted-latency.json',
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
