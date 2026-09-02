/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import externalContextConfig from '../../integrations/external-context/vitest.config.js';
import externalContextMem0Config from '../../integrations/external-context-mem0/vitest.config.js';
import acpBridgeConfig from '../../packages/acp-bridge/vitest.config.js';
import audioCaptureConfig from '../../packages/audio-capture/vitest.config.js';
import channelsBaseConfig from '../../packages/channels/base/vitest.config.js';
import dingtalkConfig from '../../packages/channels/dingtalk/vitest.config.js';
import dwsConfig from '../../packages/channels/dws/vitest.config.js';
import feishuConfig from '../../packages/channels/feishu/vitest.config.js';
import githubConfig from '../../packages/channels/github/vitest.config.js';
import gitlabConfig from '../../packages/channels/gitlab/vitest.config.js';
import qqbotConfig from '../../packages/channels/qqbot/vitest.config.js';
import telegramConfig from '../../packages/channels/telegram/vitest.config.js';
import wecomConfig from '../../packages/channels/wecom/vitest.config.js';
import weixinConfig from '../../packages/channels/weixin/vitest.config.js';
import chromeExtensionConfig from '../../packages/chrome-extension/vitest.config.js';
import cliConfig from '../../packages/cli/vitest.config.js';
import coreConfig from '../../packages/core/vitest.config.js';
import nodeReplConfig from '../../packages/node-repl/vitest.config.js';
import sdkTypescriptConfig from '../../packages/sdk-typescript/vitest.config.js';
import vscodeCompanionConfig from '../../packages/vscode-ide-companion/vitest.config.js';
import webShellConfig from '../../packages/web-shell/vitest.config.js';
import webuiConfig from '../../packages/webui/vite.config.js';
import scriptsTestsConfig from './vitest.config.js';

// Every vitest project that `npm run test:ci` runs on the Windows/macOS
// platform lanes carries the off-Linux unhandled-error exemption: vitest's
// worker->main `onTaskUpdate` RPC has a fixed 60s budget, and under runner
// resource pressure a stall longer than that exits an all-green run red
// (the nightly failure class behind #10438 and its predecessors). This
// witness pins the flag in every guarded config so removing it from any
// one of them fails the scripts suite on every platform.
type ExemptionConfig = {
  test?: {
    dangerouslyIgnoreUnhandledErrors?: boolean;
    pool?: 'threads' | 'forks' | 'vmThreads';
    poolOptions?: { threads?: { maxThreads?: number } };
  };
};

const configs: Record<string, ExemptionConfig> = {
  'integrations/external-context': externalContextConfig,
  'integrations/external-context-mem0': externalContextMem0Config,
  'packages/acp-bridge': acpBridgeConfig,
  'packages/audio-capture': audioCaptureConfig,
  'packages/channels/base': channelsBaseConfig,
  'packages/channels/dingtalk': dingtalkConfig,
  'packages/channels/dws': dwsConfig,
  'packages/channels/feishu': feishuConfig,
  'packages/channels/github': githubConfig,
  'packages/channels/gitlab': gitlabConfig,
  'packages/channels/qqbot': qqbotConfig,
  'packages/channels/telegram': telegramConfig,
  'packages/channels/wecom': wecomConfig,
  'packages/channels/weixin': weixinConfig,
  'packages/chrome-extension': chromeExtensionConfig,
  'packages/cli': cliConfig,
  'packages/core': coreConfig,
  'packages/node-repl': nodeReplConfig,
  'packages/sdk-typescript': sdkTypescriptConfig,
  'packages/vscode-ide-companion': vscodeCompanionConfig,
  'packages/web-shell': webShellConfig,
  'scripts/tests': scriptsTestsConfig,
};

describe('unhandled-error exemption on the platform lanes', () => {
  for (const [name, config] of Object.entries(configs)) {
    it(`keeps unhandled errors fatal only on Linux in ${name}`, () => {
      // toBe, not toBeFalsy: a deleted flag is `undefined` and must fail
      // this pin on every platform, including Linux where the value is false.
      expect(config.test?.dangerouslyIgnoreUnhandledErrors).toBe(
        process.platform !== 'linux',
      );
    });
  }

  it('keeps unhandled errors fatal only on Linux in packages/webui', async () => {
    // webui's vitest configuration is the function-form vite.config.ts.
    const config = await webuiConfig({ command: 'serve', mode: 'test' });
    expect(config.test?.dangerouslyIgnoreUnhandledErrors).toBe(
      process.platform !== 'linux',
    );
  });
});

describe('autofix gate load clamps', () => {
  // The gate launches vitest through an `env -i` allowlist that drops
  // RUNNER_NAME, so these configs' ECS branches deactivate in there and the
  // gate passes the same numbers on the command line instead — where they
  // outrank the config. That makes the shell array the effective ceiling
  // for every gate round, so it has to track the configs: raising an ECS
  // ceiling here to shelter a heavier test would otherwise leave the gate
  // enforcing the old one and rejecting a fix that is green in normal CI.
  it('carries the same values as the ECS branch of the configs they stand in for', async () => {
    vi.stubEnv('RUNNER_NAME', 'ecs-qwen-parity');
    vi.resetModules();
    // Re-imported under the stub: the configs read the env at import time,
    // and the static imports above already resolved the non-ECS branch.
    const [core, cli, acpBridge] = await Promise.all([
      import('../../packages/core/vitest.config.js'),
      import('../../packages/cli/vitest.config.js'),
      import('../../packages/acp-bridge/vitest.config.js'),
    ]);
    vi.unstubAllEnvs();

    const script = readFileSync(
      fileURLToPath(
        new URL(
          '../../.github/scripts/run-autofix-review-verification.sh',
          import.meta.url,
        ),
      ),
      'utf8',
    );
    const body = script.match(/^VITEST_LOAD_CLAMPS=\(\n([\s\S]*?)\n\)$/m)?.[1];
    expect(
      body,
      'VITEST_LOAD_CLAMPS not found in the gate script',
    ).toBeTruthy();
    const clamps = Object.fromEntries(
      body!
        .split('\n')
        .map((line) => line.trim().replace(/^--/, ''))
        .filter(Boolean)
        .map((flag) => flag.split('=') as [string, string]),
    );

    // 60_000 / 60_000 / '25%' on the ECS branch of core and cli;
    // acp-bridge sets the two timeouts but defines no maxWorkers.
    for (const config of [core.default, cli.default, acpBridge.default]) {
      expect(String(config.test?.testTimeout)).toBe(clamps['testTimeout']);
      expect(String(config.test?.hookTimeout)).toBe(clamps['hookTimeout']);
    }
    for (const config of [core.default, cli.default]) {
      expect(config.test?.maxWorkers).toBe(clamps['maxWorkers']);
    }
    // Nothing in the gate or its report path consumes coverage, and
    // collecting it was the bulk of the 60-minute overruns.
    expect(clamps['coverage.enabled']).toBe('false');
  });

  it('pins the numeric thread cap that shields vitest-1.x legs from --maxWorkers', () => {
    // The clamps pass --maxWorkers=25% to every vitest the gate launches.
    // vitest 1.x coerces that value with Number('25%') -> NaN, and its
    // tinypool then builds new Array(NaN): RangeError, zero tests
    // collected, exit 1. The pool builder reads a numeric
    // poolOptions.threads.maxThreads before ctx.config.maxWorkers, so
    // that cap is the shield keeping a 1.x workspace's legs alive under
    // the clamps — pin it here so removing it fails the suite instead of
    // crashing every gate leg for the workspace.
    const lock = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../package-lock.json', import.meta.url)),
        'utf8',
      ),
    ) as { packages: Record<string, { version?: string }> };
    const hoisted = lock.packages['node_modules/vitest']?.version ?? '';
    // Nested lockfile copies under workspace dirs are exactly the
    // workspaces whose pinned vitest differs from the hoisted one; if the
    // hoisted copy itself were 1.x this filter would go blind, so pin the
    // premise.
    expect(Number(hoisted.split('.')[0])).toBeGreaterThanOrEqual(2);
    const legacyWorkspaces = Object.entries(lock.packages)
      .filter(
        ([path, entry]) =>
          path.endsWith('/node_modules/vitest') &&
          (path.startsWith('packages/') || path.startsWith('integrations/')) &&
          Number(entry.version?.split('.')[0] ?? 99) < 2,
      )
      .map(([path]) => path.slice(0, -'/node_modules/vitest'.length));
    for (const workspace of legacyWorkspaces) {
      if (!(workspace in configs)) {
        throw new Error(
          `${workspace} pins vitest 1.x; add its config to the registry above so the shield is pinned`,
        );
      }
      const config = configs[workspace];
      // forks reads poolOptions.forks, which these configs do not set —
      // only the threads pool carries the shield.
      expect(config.test?.pool ?? 'threads', workspace).toBe('threads');
      expect(
        typeof config.test?.poolOptions?.threads?.maxThreads,
        workspace,
      ).toBe('number');
    }
  });
});

describe('bundle-guard timeout ceiling', () => {
  it('keeps the bundle-guard timeout ceiling in packages/vscode-ide-companion', async () => {
    // The config reads RUNNER_NAME at import time, so re-import it under
    // each stub to pin both branches, not only the ambient one.
    for (const [runnerName, expected] of [
      ['ecs-qwen-parity', 60_000],
      ['ubuntu-latest-runner', 15_000],
    ] as const) {
      vi.stubEnv('RUNNER_NAME', runnerName);
      vi.resetModules();
      const mod = await import(
        '../../packages/vscode-ide-companion/vitest.config.js'
      );
      expect(mod.default.test?.testTimeout, `RUNNER_NAME=${runnerName}`).toBe(
        expected,
      );
      vi.unstubAllEnvs();
    }
  });
});
