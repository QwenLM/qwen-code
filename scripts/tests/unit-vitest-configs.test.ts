/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// Every vitest project that `npm run test:ci` runs on the unit lanes carries
// the RPC-timeout unhandled-error exemption: vitest's worker->main
// `onTaskUpdate` RPC runs on a fixed 60s budget, and under runner resource
// pressure a stall longer than that surfaces as an unhandled error that
// exits an all-green run red with no `FAIL` line anywhere in the log — the
// failure class behind #10438 (the Windows/macOS lanes) and #10488 (the
// post-merge unit lane on the shared self-hosted pool). The exemption keeps
// that infrastructure class from masking the lane: it covers every platform
// on self-hosted runners and every non-Linux platform elsewhere, while
// github-hosted Linux and local runs keep the unhandled-error signal (the
// same split integration-tests/vitest.config.ts draws). Real test failures
// stay fatal everywhere.
//
// The flag reads RUNNER_ENVIRONMENT at config import time (ci.yml's unit
// test step exports it from `${{ runner.environment }}`), so each case
// re-imports every config under a controlled value instead of trusting the
// ambient one.

type ExemptionConfig = {
  test?: { dangerouslyIgnoreUnhandledErrors?: boolean };
};

const savedRunnerEnvironment = process.env['RUNNER_ENVIRONMENT'];

afterEach(() => {
  if (savedRunnerEnvironment === undefined) {
    delete process.env['RUNNER_ENVIRONMENT'];
  } else {
    process.env['RUNNER_ENVIRONMENT'] = savedRunnerEnvironment;
  }
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

async function configsFor(
  runnerEnvironment: string | undefined,
): Promise<Record<string, ExemptionConfig>> {
  vi.resetModules();
  if (runnerEnvironment === undefined) {
    delete process.env['RUNNER_ENVIRONMENT'];
  } else {
    process.env['RUNNER_ENVIRONMENT'] = runnerEnvironment;
  }
  const configs = await loadConfigs();
  // webui's vitest configuration is the function-form vite.config.ts.
  const { default: webuiConfig } = await import(
    '../../packages/webui/vite.config.js'
  );
  configs['packages/webui'] = await webuiConfig({
    command: 'serve',
    mode: 'test',
  });
  return configs;
}

describe('unhandled-error exemption on the unit lanes', () => {
  it('exempts self-hosted pool runners on every platform', async () => {
    // Dropping the self-hosted clause lets the shared pool's pressure flakes
    // exit all-green unit runs red again (#10488).
    const configs = await configsFor('self-hosted');
    for (const [name, config] of Object.entries(configs)) {
      expect(config.test?.dangerouslyIgnoreUnhandledErrors, name).toBe(true);
    }
  });

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
    }
  });
});
