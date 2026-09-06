/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
    const [core, cli, acpBridge, webShell] = await Promise.all([
      import('../../packages/core/vitest.config.js'),
      import('../../packages/cli/vitest.config.js'),
      import('../../packages/acp-bridge/vitest.config.js'),
      import('../../packages/web-shell/vitest.config.js'),
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
    // acp-bridge and web-shell set the two timeouts but define no maxWorkers.
    for (const config of [
      core.default,
      cli.default,
      acpBridge.default,
      webShell.default,
    ]) {
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

describe('scripts suite timeout', () => {
  it('gives the scripts suite room for a contended host, and a knob', async () => {
    // 30s was the quiet-host figure. Release run 33725742855 lost its Quality
    // Checks (Scripts) job to two files at once — qwen-autofix-workflow, whose
    // heaviest case measures ~14s idle, and acp-serve-boundary-guard — neither
    // slow, both past 30s under contention. A per-file `vi.setConfig` cannot
    // fix it: these cases register their timeout at collection.
    for (const [stub, expected] of [
      [undefined, 90_000],
      ['5000', 5_000],
      ['', 90_000],
      ['abc', 90_000],
      ['-5', 90_000],
    ] as const) {
      if (stub === undefined) {
        vi.stubEnv('QWEN_SCRIPTS_TEST_TIMEOUT_MS', '');
        vi.unstubAllEnvs();
      } else {
        vi.stubEnv('QWEN_SCRIPTS_TEST_TIMEOUT_MS', stub);
      }
      vi.resetModules();
      const mod = await import('./vitest.config.js');
      expect(mod.default.test?.testTimeout, `stub=${stub}`).toBe(expected);
      vi.unstubAllEnvs();
    }
  });

  it('keeps the floor the config sets unlowered by any file in the suite', () => {
    // Release run 33957952281 lost Quality Checks (Scripts) to two files that
    // still carried quiet-host figures of their own: install-script.test.js
    // capped itself at 30s with a per-file setConfig, so a packaging case
    // that costs 3s idle timed out at exactly 30000ms, and
    // qwen-autofix-workflow.test.js bounded a subprocess at 30s, where the
    // kill truncated the stub's recording and the timeout surfaced as a
    // content mismatch. The config above owns testTimeout; a per-file
    // override of it can only lower it.
    const tests = fileURLToPath(new URL('.', import.meta.url));
    // vitest lowers a file's budget three ways: re-declaring testTimeout in
    // a setConfig call, a timeout option object on a describe, it, or test
    // registration, and a trailing numeric timeout argument. Ban the first
    // two spellings suite-wide — neither survives anywhere today — and the
    // third in the two files whose quiet-host figures lost the release
    // run. The option-object pattern cannot reach inside a callback body
    // (the callback's own parens stop it), so spawnSync option objects
    // and their deliberate small bounds are not matched.
    for (const file of readdirSync(tests)) {
      if (!/\.test\.[jt]s$/.test(file)) continue;
      expect(
        readFileSync(join(tests, file), 'utf8'),
        `${file} overrides the suite testTimeout`,
      ).not.toMatch(
        /vi\.setConfig\(\{[^)]*?testTimeout|\b(?:describe|it|test)(?:\.\w+)*\([^()]*,\s*\{\s*timeout:/,
      );
    }
    // The two close shapes a re-added per-test timeout takes; binding the
    // figure to the call's own closing lines keeps stub fixture strings (a
    // setTimeout inside a spawned child) from matching.
    for (const file of [
      'install-script.test.js',
      'qwen-autofix-workflow.test.js',
    ]) {
      expect(
        readFileSync(join(tests, file), 'utf8'),
        `${file} re-caps a test below the suite floor`,
      ).not.toMatch(
        /^\s*\},\s*\d[\d_]*,?\s*\);$|\},\s*\n\s*\d[\d_]*,?\s*\n\s*\);/m,
      );
    }

    // The deferred-findings harness consumes the suite's resolved figure for
    // its subprocess bound instead of re-reading the knob, and stays
    // strictly below it: a bound equal to the suite timeout can never fire
    // first, so the kill would surface as vitest's generic timeout with no
    // attribution. Pin the single ownership, the bound sites, and the
    // headroom.
    const harness = readFileSync(
      join(tests, 'qwen-autofix-workflow.test.js'),
      'utf8',
    );
    expect(
      harness,
      'the deferred-findings harness re-reads the suite knob instead of consuming the resolved config',
    ).not.toContain('QWEN_SCRIPTS_TEST_TIMEOUT_MS');
    expect(
      (harness.match(/timeout: subprocessTimeoutMs/g) ?? []).length,
      'a spawnSync bound in the deferred-findings harness drifted off the knob',
    ).toBeGreaterThanOrEqual(4);
    const factor = harness.match(
      /subprocessTimeoutMs = Math\.floor\(\s*scriptsTestsConfig\.test\.testTimeout \* ([\d.]+),?\s*\)/,
    )?.[1];
    expect(
      factor,
      'the harness bound no longer derives from the resolved suite testTimeout',
    ).toBeTruthy();
    const floor = scriptsTestsConfig.test?.testTimeout;
    if (typeof floor !== 'number') {
      throw new Error('the suite config resolved no testTimeout');
    }
    expect(
      Math.floor(floor * Number(factor)),
      'the subprocess bound must stay strictly below the suite timeout so a kill fires first and stays attributable',
    ).toBeLessThan(floor);
  });
});
