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
  test?: { dangerouslyIgnoreUnhandledErrors?: boolean };
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
});
