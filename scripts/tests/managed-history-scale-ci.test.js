/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const workflow = parse(readFileSync('.github/workflows/sdk-java.yml', 'utf8'));
const job = workflow.jobs['managed-history-scale'];

describe('Managed native history scale qualification', () => {
  it('runs both engines once in the full tier at the selected immutable source', () => {
    expect(job.if).toBe("${{ inputs.tier != 'fast' }}");
    expect(job.strategy.matrix.engine).toEqual(['h2', 'mysql']);
    expect(job.strategy['fail-fast']).toBe(false);
    expect(job['runs-on']).toBe('ubuntu-latest');
    expect(
      job.steps.find((s) => s.uses?.startsWith('actions/checkout@')).with.ref,
    ).toBe('${{ inputs.ref || github.sha }}');
    const qualify = job.steps.find(
      (s) => s.name === 'Qualify native history residency',
    );
    expect(qualify.run).toContain('-Pmanaged-history-scale');
    expect(qualify.run).toContain('history_revision="$(git rev-parse HEAD)"');
    expect(qualify.run).toContain(
      '-Dqwen.managed.history.engine=${HISTORY_ENGINE}',
    );
    expect(qualify.run).toContain('verify checkstyle:check');
    expect(qualify.run).toContain(
      'node scripts/check-failsafe-reports.js managed-history-scale packages/managed-agent-server',
    );
    for (const filter of [
      '-Dtest=',
      '-Dit.test=',
      '-DskipTests',
      'continue-on-error',
    ]) {
      expect(qualify.run).not.toContain(filter);
    }
    expect(qualify['continue-on-error']).toBeUndefined();
    expect(job['timeout-minutes']).toBeGreaterThan(qualify['timeout-minutes']);
    expect(qualify['timeout-minutes'] * 60).toBeGreaterThan(7200);
  });

  it('builds runtime prerequisites and qualifies the disposable MySQL configuration', () => {
    const steps = job.steps;
    const build = steps.findIndex(
      (s) => s.name === 'Build native history JavaScript prerequisites',
    );
    const qualify = steps.findIndex(
      (s) => s.name === 'Qualify native history residency',
    );
    expect(steps[build].run).toContain(
      'corepack pnpm install --frozen-lockfile',
    );
    expect(steps[build].run).toContain('npm run build');
    expect(qualify).toBeGreaterThan(build);
    expect(
      steps.find((s) => s.uses?.startsWith('actions/setup-node@')).with[
        'node-version'
      ],
    ).toBe('22');
    expect(
      steps.find((s) => s.uses?.startsWith('actions/setup-java@')).with[
        'java-version'
      ],
    ).toBe('21');
    const database = steps.find(
      (s) => s.name === 'Start history qualification MySQL',
    );
    for (const flag of [
      'mysql:8.4.6',
      '--innodb-use-native-aio=0',
      '--skip-log-bin',
      '--max-allowed-packet=134217728',
      '@@max_allowed_packet',
    ]) {
      expect(database.run).toContain(flag);
    }
    expect(database.if).toBe("${{ matrix.engine == 'mysql' }}");
    const stop = steps.at(-1);
    expect(stop.if).toBe("${{ always() && matrix.engine == 'mysql' }}");
    expect(stop.run).toContain('docker rm --force "${MYSQL_CONTAINER}"');
  });

  it('resolves runner paths only in step environments', () => {
    expect(JSON.stringify(job.env)).not.toContain('${{ runner.');
    const install = job.steps.find(
      (s) => s.name === 'Install history qualification SDK dependency',
    );
    const qualify = job.steps.find(
      (s) => s.name === 'Qualify native history residency',
    );
    expect(install.env.MAVEN_ARGS).toBe(qualify.env.MAVEN_ARGS);
    expect(install.env.MAVEN_ARGS).toContain(
      '${{ runner.temp }}/m2-history-scale',
    );
    expect(install.env.MAVEN_ARGS).toContain(
      '--settings ${{ runner.temp }}/setup-java-m2/settings.xml',
    );
  });

  it('preserves successful and failed metrics plus unfiltered test reports', () => {
    const upload = job.steps.find(
      (s) => s.name === 'Upload history qualification evidence',
    );
    expect(upload.if).toBe('${{ always() }}');
    expect(upload.with.path).toContain('target/managed-history-scale/');
    expect(upload.with.path).toContain('target/failsafe-reports/');
    expect(upload.with.name).toContain('${{ matrix.engine }}');
  });

  it('keeps long cases in their own profile with both sizes required', () => {
    const pom = readFileSync('packages/managed-agent-server/pom.xml', 'utf8');
    const profile = pom
      .slice(pom.indexOf('<id>managed-history-scale</id>'))
      .split('</profile>')[0];
    expect(profile).toContain(
      '<include>**/ManagedSessionHistoryScaleGate.java</include>',
    );
    expect(profile).toContain('<failIfNoTests>true</failIfNoTests>');
    expect(profile).toContain(
      '<forkedProcessTimeoutInSeconds>7200</forkedProcessTimeoutInSeconds>',
    );
    expect(profile).toContain('<argLine>-Xmx512m</argLine>');
    const gate = readFileSync(
      'packages/managed-agent-server/src/test/java/com/alibaba/qwen/code/managedagent/ManagedSessionHistoryScaleGate.java',
      'utf8',
    );
    expect(gate).toContain('@ValueSource(ints = {10000, 100000})');
    expect(gate).toContain('@AfterAll');
    expect(gate).toContain('containsExactlyInAnyOrder(10000, 100000)');
    expect(gate).toContain('isLessThanOrEqualTo(HEAP_GROWTH_BYTES)');
    const fixture = readFileSync(
      'packages/managed-agent-server/src/test/java/com/alibaba/qwen/code/managedagent/ManagedSessionHistoryHttpFixture.java',
      'utf8',
    );
    expect(fixture).toContain('"--max-old-space-size=256", "--expose-gc"');
    expect(gate).toContain('jdbc:h2:file:');
    expect(gate).not.toContain('jdbc:h2:mem:');
    expect(fixture).toContain('Explicit GC completed');
    for (const filtered of ['@Disabled', 'assumeTrue(', 'assumeFalse('])
      expect(gate).not.toContain(filtered);
  });
});

describe('Managed history scale report enforcement', () => {
  const roots = [];
  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });
  const check = (
    body,
    properties = '<property name="qwen.managed.history.engine" value="h2"/>',
  ) => {
    const root = mkdtempSync(path.join(tmpdir(), 'qwen-history-report-'));
    roots.push(root);
    mkdirSync(path.join(root, 'src/test/java'), { recursive: true });
    writeFileSync(
      path.join(root, 'src/test/java/ManagedSessionHistoryScaleGate.java'),
      'class ManagedSessionHistoryScaleGate {}',
    );
    mkdirSync(path.join(root, 'target/failsafe-reports'), { recursive: true });
    writeFileSync(
      path.join(
        root,
        'target/failsafe-reports/TEST-ManagedSessionHistoryScaleGate.xml',
      ),
      `<testsuite><properties>${properties}</properties>${body}</testsuite>`,
    );
    return spawnSync(
      process.execPath,
      ['scripts/check-failsafe-reports.js', 'managed-history-scale', root],
      { encoding: 'utf8' },
    );
  };

  it('accepts a pre-feature release ref but refuses a missing gate on feature source', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'qwen-history-scope-'));
    roots.push(root);
    const qualify = job.steps.find(
      (s) => s.name === 'Qualify native history residency',
    );
    const guard = qualify.run.split(
      'history_revision="$(git rev-parse HEAD)"',
    )[0];
    const run = () =>
      spawnSync('bash', ['-eo', 'pipefail', '-c', guard], {
        cwd: root,
        encoding: 'utf8',
      });
    const old = run();
    expect(old.status, old.stderr).toBe(0);
    expect(old.stdout).toContain('not applicable');
    const history = path.join(
      root,
      'packages/core/src/managed-runtime/managed-session-history.ts',
    );
    mkdirSync(path.dirname(history), { recursive: true });
    writeFileSync(history, 'export class FileManagedSessionHistory {}');
    expect(run().status).not.toBe(0);
    const gate = path.join(
      root,
      'packages/managed-agent-server/src/test/java/com/alibaba/qwen/code/managedagent/ManagedSessionHistoryScaleGate.java',
    );
    mkdirSync(path.dirname(gate), { recursive: true });
    writeFileSync(gate, 'class ManagedSessionHistoryScaleGate {}');
    const pom = path.join(root, 'packages/managed-agent-server/pom.xml');
    writeFileSync(pom, '<project/>');
    expect(run().status).not.toBe(0);
    writeFileSync(
      pom,
      '<project><profile><id>managed-history-scale</id></profile></project>',
    );
    expect(run().status).toBe(0);
  });

  it('accepts the unfiltered gate report', () => {
    expect(
      check('<testcase name="10000"/><testcase name="100000"/>').status,
    ).toBe(0);
  });

  it('refuses a skipped or failed qualification', () => {
    for (const element of ['skipped', 'failure', 'error']) {
      const result = check(
        `<testcase name="10000"/><testcase name="100000"><${element}/></testcase>`,
      );
      expect(result.status, result.stderr).toBe(1);
    }
  });

  it('refuses method or class selectors even if a case ran', () => {
    const result = check(
      '<testcase name="10000"/>',
      '<property name="it.test" value="ManagedSessionHistoryScaleGate#small"/>',
    );
    expect(result.status, result.stderr).toBe(1);
  });
});
