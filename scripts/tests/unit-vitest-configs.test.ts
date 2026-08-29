/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWorkspacePackageJsonPaths } from '../workspaces.js';

// Every vitest project that `npm run test:ci` runs on the unit lanes carries
// the RPC-timeout unhandled-error exemption exported by
// scripts/vitest-unhandled-error-exemption.js, and the integration lane's
// config is pinned here as well. The unit-lane project inventory is derived
// from the workspaces that define a `test:ci` script, so a workspace joining
// the lane fails this suite until its config is imported below — and a
// config the lane does not run cannot be pinned silently.
//
// The flag reads RUNNER_ENVIRONMENT at config import time (ci.yml's unit
// test step exports it from `${{ runner.environment }}`), so each case
// re-imports every config under a controlled value instead of trusting the
// ambient one.

type ExemptionConfig = {
  test?: { dangerouslyIgnoreUnhandledErrors?: boolean };
};

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

const savedRunnerEnvironment = process.env['RUNNER_ENVIRONMENT'];

function setRunnerEnvironment(runnerEnvironment: string | undefined) {
  if (runnerEnvironment === undefined) {
    delete process.env['RUNNER_ENVIRONMENT'];
  } else {
    process.env['RUNNER_ENVIRONMENT'] = runnerEnvironment;
  }
}

afterEach(() => {
  setRunnerEnvironment(savedRunnerEnvironment);
  vi.resetModules();
});

async function loadConfigs(): Promise<Record<string, ExemptionConfig>> {
  return {
    'integrations/external-context': (
      await import('../../integrations/external-context/vitest.config.js')
    ).default,
    'integrations/external-context-mem0': (
      await import('../../integrations/external-context-mem0/vitest.config.js')
    ).default,
    'packages/acp-bridge': (
      await import('../../packages/acp-bridge/vitest.config.js')
    ).default,
    'packages/audio-capture': (
      await import('../../packages/audio-capture/vitest.config.js')
    ).default,
    'packages/channels/base': (
      await import('../../packages/channels/base/vitest.config.js')
    ).default,
    'packages/channels/dingtalk': (
      await import('../../packages/channels/dingtalk/vitest.config.js')
    ).default,
    'packages/channels/dws': (
      await import('../../packages/channels/dws/vitest.config.js')
    ).default,
    'packages/channels/feishu': (
      await import('../../packages/channels/feishu/vitest.config.js')
    ).default,
    'packages/channels/github': (
      await import('../../packages/channels/github/vitest.config.js')
    ).default,
    'packages/channels/gitlab': (
      await import('../../packages/channels/gitlab/vitest.config.js')
    ).default,
    'packages/channels/qqbot': (
      await import('../../packages/channels/qqbot/vitest.config.js')
    ).default,
    'packages/channels/telegram': (
      await import('../../packages/channels/telegram/vitest.config.js')
    ).default,
    'packages/channels/wecom': (
      await import('../../packages/channels/wecom/vitest.config.js')
    ).default,
    'packages/channels/weixin': (
      await import('../../packages/channels/weixin/vitest.config.js')
    ).default,
    'packages/chrome-extension': (
      await import('../../packages/chrome-extension/vitest.config.js')
    ).default,
    'packages/cli': (await import('../../packages/cli/vitest.config.js'))
      .default,
    'packages/core': (await import('../../packages/core/vitest.config.js'))
      .default,
    'packages/node-repl': (
      await import('../../packages/node-repl/vitest.config.js')
    ).default,
    'packages/sdk-typescript': (
      await import('../../packages/sdk-typescript/vitest.config.js')
    ).default,
    'packages/vscode-ide-companion': (
      await import('../../packages/vscode-ide-companion/vitest.config.js')
    ).default,
    'packages/web-shell': (
      await import('../../packages/web-shell/vitest.config.js')
    ).default,
    'scripts/tests': (await import('./vitest.config.js')).default,
  };
}

// The projects `npm run test:ci` runs: the root script runs
// `test:ci --workspaces --if-present --parallel` plus `test:scripts`, so the
// set is every workspace whose package.json defines a `test:ci` script plus
// the scripts/tests lane. Workspaces with only a `test` script (such as
// packages/channels/plugin-example) are not part of the lane.
function unitLaneProjects(): string[] {
  const rootManifest = JSON.parse(
    readFileSync(join(repoRoot, 'package.json'), 'utf8'),
  );
  const projects = getWorkspacePackageJsonPaths(
    repoRoot,
    rootManifest.workspaces,
  )
    .map((packageJsonPath: string) => dirname(packageJsonPath))
    .filter((workspaceDir: string) => {
      const manifest = JSON.parse(
        readFileSync(join(repoRoot, workspaceDir, 'package.json'), 'utf8'),
      );
      return manifest.scripts?.['test:ci'] !== undefined;
    });
  projects.push('scripts/tests');
  return projects;
}

async function configsFor(
  runnerEnvironment: string | undefined,
): Promise<Record<string, ExemptionConfig>> {
  vi.resetModules();
  setRunnerEnvironment(runnerEnvironment);
  const configs = await loadConfigs();
  // webui's vitest configuration is the function-form vite.config.ts.
  const { default: webuiConfig } = await import(
    '../../packages/webui/vite.config.js'
  );
  configs['packages/webui'] = await webuiConfig({
    command: 'serve',
    mode: 'test',
  });
  // The inventory must cover exactly the projects the unit lanes run: a
  // missing entry would let a suite join the lane unexempted, and an extra
  // one would pin a config the lane never runs.
  expect(
    Object.keys(configs).sort(),
    'config inventory vs workspaces with a test:ci script',
  ).toEqual([...unitLaneProjects()].sort());
  return configs;
}

async function integrationConfigFor(
  runnerEnvironment: string | undefined,
): Promise<ExemptionConfig> {
  vi.resetModules();
  setRunnerEnvironment(runnerEnvironment);
  return (await import('../../integration-tests/vitest.config.js')).default;
}

describe('unhandled-error exemption', () => {
  // The cold imports of all 25 configs can outrun the lane's 30s
  // testTimeout under runner resource pressure, so these cases carry an
  // explicit bound (#10488).
  it('exempts self-hosted pool runners on every platform', async () => {
    // Dropping the self-hosted clause lets the shared pool's pressure flakes
    // exit all-green unit runs red again (#10488).
    const configs = await configsFor('self-hosted');
    for (const [name, config] of Object.entries(configs)) {
      expect(config.test?.dangerouslyIgnoreUnhandledErrors, name).toBe(true);
    }
    expect(
      (await integrationConfigFor('self-hosted')).test
        ?.dangerouslyIgnoreUnhandledErrors,
      'integration-tests',
    ).toBe(true);
  }, 120_000);

  it('keeps unhandled errors fatal on github-hosted Linux and local runs', async () => {
    // toBe, not toBeFalsy: a deleted flag is `undefined` and must fail this
    // pin on every platform, including Linux where the value is false.
    for (const environment of ['github-hosted', undefined]) {
      const configs = await configsFor(environment);
      for (const [name, config] of Object.entries(configs)) {
        expect(config.test?.dangerouslyIgnoreUnhandledErrors, name).toBe(
          process.platform !== 'linux',
        );
      }
      expect(
        (await integrationConfigFor(environment)).test
          ?.dangerouslyIgnoreUnhandledErrors,
        'integration-tests',
      ).toBe(process.platform !== 'linux');
    }
  }, 120_000);
});
