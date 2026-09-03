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
    testTimeout?: number;
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

// Every workspace that `npm run test:ci --workspaces` runs lands on the same
// shared ECS pool, where the identical suite takes ~5x longer depending only on
// which host it draws (#10490). Five configs were given a raised ceiling there
// one at a time; the other fifteen were still on vitest's 5s default, so a
// contended host — not a defect — was enough to fail them. Three tests had
// already been hand-patched past 5s individually (auto-recall 12s,
// provider-extension-local 20s/30s, ChannelBase 8s), which is the shape this
// pin replaces. It sweeps the whole map so a new workspace cannot quietly join
// the lane on the 5s default.
const configModules: Record<
  string,
  () => Promise<{ default: ExemptionConfig }>
> = {
  'integrations/external-context': () =>
    import('../../integrations/external-context/vitest.config.js'),
  'integrations/external-context-mem0': () =>
    import('../../integrations/external-context-mem0/vitest.config.js'),
  'packages/acp-bridge': () =>
    import('../../packages/acp-bridge/vitest.config.js'),
  'packages/audio-capture': () =>
    import('../../packages/audio-capture/vitest.config.js'),
  'packages/channels/base': () =>
    import('../../packages/channels/base/vitest.config.js'),
  'packages/channels/dingtalk': () =>
    import('../../packages/channels/dingtalk/vitest.config.js'),
  'packages/channels/dws': () =>
    import('../../packages/channels/dws/vitest.config.js'),
  'packages/channels/feishu': () =>
    import('../../packages/channels/feishu/vitest.config.js'),
  'packages/channels/github': () =>
    import('../../packages/channels/github/vitest.config.js'),
  'packages/channels/gitlab': () =>
    import('../../packages/channels/gitlab/vitest.config.js'),
  'packages/channels/qqbot': () =>
    import('../../packages/channels/qqbot/vitest.config.js'),
  'packages/channels/telegram': () =>
    import('../../packages/channels/telegram/vitest.config.js'),
  'packages/channels/wecom': () =>
    import('../../packages/channels/wecom/vitest.config.js'),
  'packages/channels/weixin': () =>
    import('../../packages/channels/weixin/vitest.config.js'),
  'packages/chrome-extension': () =>
    import('../../packages/chrome-extension/vitest.config.js'),
  'packages/cli': () => import('../../packages/cli/vitest.config.js'),
  'packages/core': () => import('../../packages/core/vitest.config.js'),
  'packages/node-repl': () =>
    import('../../packages/node-repl/vitest.config.js'),
  // qwen-live's ceiling is unconditional (its config carries a flat 60s), so
  // it passes the on-pool floor from any runner name and stays out of the
  // off-pool sample below.
  'packages/qwen-live': () =>
    import('../../packages/qwen-live/vitest.config.js'),
  'packages/sdk-typescript': () =>
    import('../../packages/sdk-typescript/vitest.config.js'),
  'packages/vscode-ide-companion': () =>
    import('../../packages/vscode-ide-companion/vitest.config.js'),
  'packages/web-shell': () =>
    import('../../packages/web-shell/vitest.config.js'),
  'scripts/tests': () => import('./vitest.config.js'),
};

describe('shared-pool test timeout', () => {
  // 60s is the ceiling the five already-raised configs settled on. Assert a
  // floor rather than equality so the configs that legitimately sit higher
  // (scripts/tests at 90s, sdk-typescript at E2E_TIMEOUT_MINUTES x 60s) pass
  // without pinning their own numbers here.
  const POOL_FLOOR_MS = 60_000;
  // Two names that share only the documented prefix: a gate narrowed past
  // `ecs-qwen-` (e.g. to the first stub itself) passes one name and fails the
  // other. Real pool runners look like `ecs-qwen-runner-64c-23`.
  const POOL_RUNNER_NAMES = ['ecs-qwen-parity', 'ecs-qwen-hk1-01'] as const;

  for (const [name, load] of Object.entries(configModules)) {
    it(`raises the ceiling on the shared pool in ${name}`, async () => {
      for (const runnerName of POOL_RUNNER_NAMES) {
        // The configs read RUNNER_NAME at import time and the static imports
        // at the top of this file already resolved the off-pool branch, so
        // stub first and re-import. scripts/tests and sdk-typescript derive
        // their ceiling from ambient env knobs rather than a literal, so pin
        // those too — the test must read the configs' logic, not whatever
        // the surrounding environment happens to carry. `?? 90_000` makes
        // '' read as 0, so stub a real number at the documented default.
        vi.stubEnv('RUNNER_NAME', runnerName);
        vi.stubEnv('QWEN_SCRIPTS_TEST_TIMEOUT_MS', '90000');
        vi.stubEnv('E2E_TIMEOUT_MINUTES', '3');
        vi.resetModules();
        try {
          const mod = await load();
          expect(
            mod.default.test?.testTimeout,
            `${name} (${runnerName})`,
          ).toBeGreaterThanOrEqual(POOL_FLOOR_MS);
        } finally {
          vi.unstubAllEnvs();
        }
      }
    });
  }

  it('raises the ceiling on the shared pool in packages/webui', async () => {
    // webui's vitest configuration is the function-form vite.config.ts.
    for (const runnerName of POOL_RUNNER_NAMES) {
      vi.stubEnv('RUNNER_NAME', runnerName);
      vi.resetModules();
      try {
        const mod = await import('../../packages/webui/vite.config.js');
        const config = await mod.default({ command: 'serve', mode: 'test' });
        expect(
          config.test?.testTimeout,
          `packages/webui (${runnerName})`,
        ).toBeGreaterThanOrEqual(POOL_FLOOR_MS);
      } finally {
        vi.unstubAllEnvs();
      }
    }
  });

  it('leaves the off-pool default alone', async () => {
    // The point of the ternary is that only the pool lane moves. Off it these
    // configs must stay on vitest's own default, so a hang on a developer
    // machine still fails in 5s rather than 60s. Sample every gated ternary:
    // a flat `testTimeout: 60_000` in any of them must fail here. The other
    // map entries stay out on purpose: cli/core/vscode-ide-companion pin a
    // lower off-pool value (15s), node-repl/sdk-typescript/scripts/tests
    // carry flat ceilings, and qwen-live's ceiling is unconditional.
    vi.stubEnv('RUNNER_NAME', 'ubuntu-latest-runner');
    vi.resetModules();
    try {
      for (const name of [
        'integrations/external-context',
        'integrations/external-context-mem0',
        'packages/acp-bridge',
        'packages/audio-capture',
        'packages/channels/base',
        'packages/channels/dingtalk',
        'packages/channels/dws',
        'packages/channels/feishu',
        'packages/channels/github',
        'packages/channels/gitlab',
        'packages/channels/qqbot',
        'packages/channels/telegram',
        'packages/channels/wecom',
        'packages/channels/weixin',
        'packages/chrome-extension',
        'packages/web-shell',
      ]) {
        const mod = await configModules[name]!();
        expect(mod.default.test?.testTimeout, name).toBeUndefined();
      }
      // webui's vitest configuration is the function-form vite.config.ts.
      const webui = await import('../../packages/webui/vite.config.js');
      const config = await webui.default({ command: 'serve', mode: 'test' });
      expect(config.test?.testTimeout, 'packages/webui').toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
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
    ] as const) {
      if (stub === undefined) {
        // `undefined` deletes the variable even when the ambient environment
        // sets it, so `?? 90_000` gets its say; unstubAllEnvs below restores
        // the ambient value for the next iteration.
        vi.stubEnv('QWEN_SCRIPTS_TEST_TIMEOUT_MS', undefined);
      } else {
        vi.stubEnv('QWEN_SCRIPTS_TEST_TIMEOUT_MS', stub);
      }
      vi.resetModules();
      const mod = await import('./vitest.config.js');
      expect(mod.default.test?.testTimeout, `stub=${stub}`).toBe(expected);
      vi.unstubAllEnvs();
    }
  });
});
