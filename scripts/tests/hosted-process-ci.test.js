/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
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
    for (const file of [
      'integration-tests/cli/hosted-harness-process.test.ts',
      'integration-tests/helpers/hosted-session-store.ts',
      'packages/cli/src/serve/hosted-harness-model.ts',
      '.github/workflows/ci.yml',
    ]) {
      expect(classifyChangedFiles([file])).toBe('full');
    }
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
    expect(run.run).toContain(
      '-Phosted-harness-mysql -Dit.test=HostedHarnessMySqlIT',
    );
    expect(run.run).toContain(
      '-Dqwen.cli.entry="${GITHUB_WORKSPACE}/dist/cli.js"',
    );
    expect(run.run).toContain('verify checkstyle:check');
    expect(run.run).not.toContain('skip');
    expect(run['continue-on-error']).toBeUndefined();
    const pom = read('packages/sdk-java/managed-agent-server/pom.xml');
    const profile = pom.split('<id>hosted-harness-mysql</id>')[1];
    expect(profile).toContain(
      '<include>**/HostedHarnessMySqlIT.java</include>',
    );
    expect(profile).toContain('<failIfNoTests>true</failIfNoTests>');
    expect(pom.split('<id>hosted-harness-mysql</id>')[0]).toContain(
      '<exclude>**/HostedHarnessMySqlIT.java</exclude>',
    );
    const upload = job.steps.find(
      (step) => step.name === 'Upload Hosted process reports',
    );
    expect(upload.if).toBe('always()');
    expect(upload.with.path).toContain('failsafe-reports');
  });
});
