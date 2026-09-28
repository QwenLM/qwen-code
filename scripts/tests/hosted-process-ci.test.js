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
    expect(pkg.scripts[focused]).toContain(
      '--config ./vitest.hosted.config.ts',
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
    // turn both platform smokes into silent no-ops.
    const source = read('integration-tests/cli/hosted-harness-process.test.ts');
    expect(source.match(/\bit\(\s*'portable startup:/g)).toHaveLength(2);
  });

  it.each(['test_macos', 'test_windows'])(
    'runs portable startup and cleanup on %s',
    (name) => {
      const steps = ci.jobs[name].steps;
      const index = steps.findIndex(
        (step) => step.name === 'Hosted portable process smoke',
      );
      expect(index).toBeGreaterThan(
        steps.findIndex((step) =>
          /Install dependencies/i.test(step.name ?? ''),
        ),
      );
      expect(steps[index].run).toBe(
        `npm run ${focused} -- -t 'portable startup'`,
      );
      expect(steps[index]['timeout-minutes']).toBe(5);
      expect(steps[index]['continue-on-error']).toBeUndefined();
    },
  );

  it('keeps real MySQL separate from the existing MariaDB slice and fails on missing tests', () => {
    const job = java.jobs['hosted-harness-mysql'];
    expect(job.services.mysql.image).toBe('mysql:8.4.6');
    expect(job.services.mysql.ports).toEqual(['3306/tcp']);
    expect(job.if).toBeUndefined();
    expect(java.jobs['mysql-integration'].services.mariadb.image).toMatch(
      /^mariadb:/,
    );
    for (const event of ['pull_request', 'push']) {
      for (const path of [
        'packages/sdk-java/**',
        'packages/cli/src/serve/**',
        'packages/core/src/managed-runtime/**',
        'packages/cli/src/config/**',
        'packages/core/src/config/**',
        'packages/core/src/core/**',
        'pnpm-lock.yaml',
      ]) {
        expect(java.on[event].paths).toContain(path);
      }
    }
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
    expect(run.run).toContain('verify checkstyle:check');
    expect(run.run).not.toContain('skip');
    expect(run['continue-on-error']).toBeUndefined();
    const pom = read('packages/sdk-java/managed-agent-server/pom.xml').replace(
      /<!--[\s\S]*?-->/g,
      '',
    );
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
    // Keep the existing integration tests in their families: a renamed Hosted
    // test would move to MariaDB, a renamed MariaDB test to the Hosted job.
    const its = readdirSync(
      new URL(
        '../../packages/sdk-java/managed-agent-server/src/test/java/',
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
    const upload = job.steps.find(
      (step) => step.name === 'Upload Hosted process reports',
    );
    expect(upload.if).toBe('always()');
    expect(upload.with.path).toContain('failsafe-reports');
  });
});
