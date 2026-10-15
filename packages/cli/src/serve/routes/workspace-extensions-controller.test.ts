/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExtensionManager } from '@qwen-code/qwen-code-core';
import type { Response } from 'express';
import type { AcpSessionBridge } from '../acp-session-bridge.js';
import type { DaemonWorkspaceService } from '../workspace-service/types.js';
import { resolveLanguageSetting } from '../../i18n/index.js';
import {
  CORRUPTED_SUFFIX,
  ENV_CORRUPTED_PATH,
  ENV_WAS_RECOVERED,
  getUserSettingsPath,
  loadSettings,
} from '../../config/settings.js';
import {
  createExtensionsController,
  redactExtensionDisplaySource,
} from './workspace-extensions-controller.js';

vi.mock('../../i18n/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../i18n/index.js')>();
  return {
    ...actual,
    resolveLanguageSetting: vi.fn().mockReturnValue('en'),
  };
});

// Spied (not stubbed) so tests can count settings loads. The file-wide
// afterEach restoreAllMocks clears vi.fn implementations, so the describe
// beforeEach re-installs the real one.
const actualLoadSettings = vi.hoisted(() => ({
  fn: undefined as unknown as typeof import('../../config/settings.js').loadSettings,
}));

vi.mock('../../config/settings.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../config/settings.js')>();
  actualLoadSettings.fn = actual.loadSettings;
  return {
    ...actual,
    loadSettings: vi.fn(actual.loadSettings),
  };
});

describe('redactExtensionDisplaySource', () => {
  it('keeps uploaded filenames readable while hiding their identity token', () => {
    expect(
      redactExtensionDisplaySource(
        'upload:v1:550e8400-e29b-41d4-a716-446655440000:扩展?#.zip',
      ),
    ).toBe('upload:扩展?#.zip');
    expect(redactExtensionDisplaySource('upload:legacy?#.zip')).toBe(
      'upload:legacy?#.zip',
    );
  });
});

describe('createExtensionsController', () => {
  // The daemon shares one process.env across every hosted workspace; pin the
  // keys these tests read out of the assertions so the runner's own env does
  // not decide the outcome.
  const AMBIENT_ENV_KEYS = [
    'QWEN_USAGE_STATISTICS_ENABLED',
    'HTTPS_PROXY',
    'https_proxy',
    'HTTP_PROXY',
    'http_proxy',
  ];
  const pinAmbientEnvCleared = (): (() => void) => {
    const saved = AMBIENT_ENV_KEYS.map(
      (key) => [key, process.env[key]] as [string, string | undefined],
    );
    for (const key of AMBIENT_ENV_KEYS) delete process.env[key];
    return () => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    };
  };

  beforeEach(() => {
    vi.mocked(resolveLanguageSetting).mockReturnValue('en');
    vi.mocked(loadSettings).mockImplementation(actualLoadSettings.fn);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not impose a public-only extension network policy', () => {
    const controller = createExtensionsController({
      boundWorkspace: '/work/bound',
      bridge: {} as AcpSessionBridge,
      workspace: {} as DaemonWorkspaceService,
      isWorkspaceTrusted: () => true,
    });

    const manager = controller.createExtensionManager() as unknown as {
      networkPolicy?: string;
    };

    expect(manager.networkPolicy).toBeUndefined();
  });

  it('does not spend the one-shot settings-corruption markers on the status poll', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'qwen-ext-corruption-'));
    const emptyHome = await mkdtemp(join(tmpdir(), 'qwen-ext-home-'));
    vi.stubEnv('QWEN_HOME', emptyHome);
    // The env pair is only read when the user settings file exists, so give it
    // one, and derive the marker from the same helper `loadSettings` uses.
    await writeFile(join(emptyHome, 'settings.json'), '{}');
    const marker = `${getUserSettingsPath()}${CORRUPTED_SUFFIX}`;
    const saved = [ENV_CORRUPTED_PATH, ENV_WAS_RECOVERED].map(
      (key) => [key, process.env[key]] as [string, string | undefined],
    );
    process.env[ENV_CORRUPTED_PATH] = marker;
    process.env[ENV_WAS_RECOVERED] = '1';
    vi.spyOn(ExtensionManager.prototype, 'refreshCache').mockResolvedValue(
      undefined,
    );
    vi.spyOn(ExtensionManager.prototype, 'getLoadedExtensions').mockReturnValue(
      [],
    );
    try {
      // The status poll is the most frequently hit load in the daemon and it
      // surfaces neither the corruption marker nor the recovery notice, so it
      // must not spend the one-shot pair that `acpAgent.ts` reports from.
      await createExtensionsController({
        boundWorkspace: workspaceDir,
        bridge: {} as AcpSessionBridge,
        workspace: {} as DaemonWorkspaceService,
        isWorkspaceTrusted: () => true,
      }).buildLocalExtensionsStatus();

      expect(process.env[ENV_CORRUPTED_PATH]).toBe(marker);
      expect(process.env[ENV_WAS_RECOVERED]).toBe('1');
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      vi.unstubAllEnvs();
      await rm(workspaceDir, { recursive: true, force: true });
      await rm(emptyHome, { recursive: true, force: true });
    }
  });

  it('does not publish the workspace env to the daemon while building status', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'qwen-ext-status-env-'));
    const emptyHome = await mkdtemp(join(tmpdir(), 'qwen-ext-home-'));
    vi.stubEnv('QWEN_HOME', emptyHome);
    await mkdir(join(workspaceDir, '.qwen'), { recursive: true });
    // The status route is trust-free and answers a single GET, so any repo can
    // ship these values. Loading them without `skipLoadEnvironment` writes
    // them into the process.env every other hosted workspace resolves against,
    // for the process lifetime — nothing restores them.
    await writeFile(
      join(workspaceDir, '.qwen', '.env'),
      'HTTPS_PROXY=http://workspace-env:8080\nQWEN_USAGE_STATISTICS_ENABLED=1\n',
    );
    vi.spyOn(ExtensionManager.prototype, 'refreshCache').mockResolvedValue(
      undefined,
    );
    vi.spyOn(ExtensionManager.prototype, 'getLoadedExtensions').mockReturnValue(
      [],
    );
    const restoreEnv = pinAmbientEnvCleared();
    try {
      const controller = createExtensionsController({
        boundWorkspace: workspaceDir,
        bridge: {} as AcpSessionBridge,
        workspace: {} as DaemonWorkspaceService,
        isWorkspaceTrusted: () => true,
      });

      await controller.buildLocalExtensionsStatus();

      expect(process.env['HTTPS_PROXY']).toBeUndefined();
      expect(process.env['QWEN_USAGE_STATISTICS_ENABLED']).toBeUndefined();
    } finally {
      restoreEnv();
      vi.unstubAllEnvs();
      await rm(workspaceDir, { recursive: true, force: true });
      await rm(emptyHome, { recursive: true, force: true });
    }
  });

  it('does not let an untrusted workspace pick the status locale', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'qwen-ext-locale-'));
    const emptyHome = await mkdtemp(join(tmpdir(), 'qwen-ext-home-'));
    vi.stubEnv('QWEN_HOME', emptyHome);
    await mkdir(join(workspaceDir, '.qwen'), { recursive: true });
    await writeFile(
      join(workspaceDir, '.qwen', 'settings.json'),
      JSON.stringify({ general: { language: 'zh-CN' } }),
    );
    vi.spyOn(ExtensionManager.prototype, 'refreshCache').mockResolvedValue(
      undefined,
    );
    vi.spyOn(ExtensionManager.prototype, 'getLoadedExtensions').mockReturnValue(
      [],
    );
    try {
      const languageSetting = vi.mocked(resolveLanguageSetting);
      const untrusted = createExtensionsController({
        boundWorkspace: workspaceDir,
        bridge: {} as AcpSessionBridge,
        workspace: {} as DaemonWorkspaceService,
        isWorkspaceTrusted: () => false,
      });
      await untrusted.buildLocalExtensionsStatus();
      // The untrusted branch re-loads with `skipWorkspaceSettings`, so the
      // workspace's own `general.language` never reaches the locale resolve.
      expect(languageSetting).toHaveBeenCalledWith(undefined);
      expect(languageSetting).not.toHaveBeenCalledWith('zh-CN');

      languageSetting.mockClear();
      const trusted = createExtensionsController({
        boundWorkspace: workspaceDir,
        bridge: {} as AcpSessionBridge,
        workspace: {} as DaemonWorkspaceService,
        isWorkspaceTrusted: () => true,
      });
      await trusted.buildLocalExtensionsStatus();
      expect(languageSetting).toHaveBeenCalledWith('zh-CN');
    } finally {
      vi.unstubAllEnvs();
      await rm(workspaceDir, { recursive: true, force: true });
      await rm(emptyHome, { recursive: true, force: true });
    }
  });

  it('never parses or rewrites an untrusted workspace settings file from the status poll', async () => {
    const workspaceDir = await mkdtemp(
      join(tmpdir(), 'qwen-ext-untrusted-poll-'),
    );
    const emptyHome = await mkdtemp(join(tmpdir(), 'qwen-ext-home-'));
    vi.stubEnv('QWEN_HOME', emptyHome);
    await writeFile(join(emptyHome, 'settings.json'), '{}');
    await mkdir(join(workspaceDir, '.qwen'), { recursive: true });
    const settingsPath = join(workspaceDir, '.qwen', 'settings.json');
    // Truncated JSON. Parsing it runs the corruption-recovery path, which
    // resets the file to `{}` and writes a `.corrupted` sibling beside it — a
    // recovery designed to run at startup with a dialog, here inside a daemon
    // that answers a trust-free GET. The poll must not parse it at all.
    await writeFile(settingsPath, '{');
    vi.spyOn(ExtensionManager.prototype, 'refreshCache').mockResolvedValue(
      undefined,
    );
    vi.spyOn(ExtensionManager.prototype, 'getLoadedExtensions').mockReturnValue(
      [],
    );
    try {
      const controller = createExtensionsController({
        boundWorkspace: workspaceDir,
        bridge: {} as AcpSessionBridge,
        workspace: {} as DaemonWorkspaceService,
        isWorkspaceTrusted: () => false,
      });
      const loadSettingsSpy = vi.mocked(loadSettings);
      const languageSetting = vi.mocked(resolveLanguageSetting);
      loadSettingsSpy.mockClear();
      languageSetting.mockClear();

      const status = await controller.buildLocalExtensionsStatus();

      // The poll still answers, with a user-scope locale.
      expect(status).toBeDefined();
      expect(languageSetting).toHaveBeenCalledWith(undefined);
      // The untrusted workspace's own file is byte-identical, with no
      // `.corrupted` sibling written next to it.
      expect(await readFile(settingsPath, 'utf8')).toBe('{');
      expect((await readdir(join(workspaceDir, '.qwen'))).sort()).toEqual([
        'settings.json',
      ]);
      // Two loads, not three: the status builder's own gated load plus the one
      // `createExtensionManager` performs inside `loadLocalExtensionsStatus`.
      // The discarded ungated probe is gone (ungating it makes this 3).
      expect(loadSettingsSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllEnvs();
      await rm(workspaceDir, { recursive: true, force: true });
      await rm(emptyHome, { recursive: true, force: true });
    }
  });

  it('keeps the workspace env unpublished and the corruption markers unspent when trust is unresolved', async () => {
    const workspaceDir = await mkdtemp(
      join(tmpdir(), 'qwen-ext-undefined-trust-'),
    );
    const emptyHome = await mkdtemp(join(tmpdir(), 'qwen-ext-home-'));
    vi.stubEnv('QWEN_HOME', emptyHome);
    // The marker pair is only read when the user settings file exists, so give
    // it one — and derive the marker AFTER the QWEN_HOME stub, since
    // `getUserSettingsPath()` resolves through it at call time.
    await writeFile(join(emptyHome, 'settings.json'), '{}');
    const marker = `${getUserSettingsPath()}${CORRUPTED_SUFFIX}`;
    await mkdir(join(workspaceDir, '.qwen'), { recursive: true });
    await writeFile(
      join(workspaceDir, '.qwen', '.env'),
      'HTTPS_PROXY=http://workspace-env:8080\n',
    );
    const saved = [ENV_CORRUPTED_PATH, ENV_WAS_RECOVERED].map(
      (key) => [key, process.env[key]] as [string, string | undefined],
    );
    process.env[ENV_CORRUPTED_PATH] = marker;
    process.env[ENV_WAS_RECOVERED] = '1';
    const restoreEnv = pinAmbientEnvCleared();
    try {
      // No `isWorkspaceTrusted` dep — the direct `createServeApp` embed shape —
      // so a no-override `createExtensionManager()` takes the
      // `workspaceTrusted === undefined` arm of the load.
      const controller = createExtensionsController({
        boundWorkspace: workspaceDir,
        bridge: {} as AcpSessionBridge,
        workspace: {} as DaemonWorkspaceService,
      });

      controller.createExtensionManager(workspaceDir);

      expect(process.env['HTTPS_PROXY']).toBeUndefined();
      expect(process.env[ENV_CORRUPTED_PATH]).toBe(marker);
      expect(process.env[ENV_WAS_RECOVERED]).toBe('1');
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      restoreEnv();
      vi.unstubAllEnvs();
      await rm(workspaceDir, { recursive: true, force: true });
      await rm(emptyHome, { recursive: true, force: true });
    }
  });

  it('loads settings once per manager and resolves consent and proxy from that same merge', async () => {
    const extensionDir = await mkdtemp(
      join(tmpdir(), 'qwen-ext-controller-telemetry-'),
    );
    const emptyHome = await mkdtemp(join(tmpdir(), 'qwen-ext-home-'));
    vi.stubEnv('QWEN_HOME', emptyHome);
    const restoreEnv = pinAmbientEnvCleared();
    try {
      await mkdir(join(extensionDir, '.qwen'));
      await writeFile(
        join(extensionDir, '.qwen', 'settings.json'),
        JSON.stringify({
          privacy: { usageStatisticsEnabled: false },
          proxy: 'http://workspace-settings:8080',
        }),
      );
      const controller = createExtensionsController({
        boundWorkspace: extensionDir,
        bridge: {} as AcpSessionBridge,
        workspace: {} as DaemonWorkspaceService,
      });
      const loadSettingsSpy = vi.mocked(loadSettings);
      loadSettingsSpy.mockClear();

      const manager = controller.createExtensionManager(
        extensionDir,
        true,
      ) as unknown as {
        usageStatisticsEnabled?: boolean;
        proxy?: string;
      };

      // One load total: the locale read must reuse the same merged object
      // instead of loading again (#12770 follow-up).
      expect(loadSettingsSpy).toHaveBeenCalledTimes(1);
      expect(manager.usageStatisticsEnabled).toBe(false);
      expect(manager.proxy).toBe('http://workspace-settings:8080');
    } finally {
      restoreEnv();
      vi.unstubAllEnvs();
      await rm(extensionDir, { recursive: true, force: true });
      await rm(emptyHome, { recursive: true, force: true });
    }
  });

  it('resolves telemetry proxy and consent from the workspace settings only', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'qwen-ext-telemetry-'));
    // The untrusted branch loads with `skipWorkspaceSettings`, so its merged
    // proxy comes from the SystemDefaults → User → System scopes of the home
    // directory: point QWEN_HOME at an empty one or a developer's real
    // `~/.qwen/settings.json` proxy decides this assertion.
    const emptyHome = await mkdtemp(join(tmpdir(), 'qwen-ext-home-'));
    vi.stubEnv('QWEN_HOME', emptyHome);
    await mkdir(join(workspaceDir, '.qwen'), { recursive: true });
    await writeFile(
      join(workspaceDir, '.qwen', 'settings.json'),
      JSON.stringify({ proxy: 'http://workspace-settings:8080' }),
    );
    // A workspace's own env file must never be written into the daemon's
    // shared process.env, and the daemon's ambient proxy env must never
    // become this workspace's telemetry proxy.
    await writeFile(
      join(workspaceDir, '.qwen', '.env'),
      'HTTPS_PROXY=http://workspace-env:8080\n',
    );

    const restoreEnv = pinAmbientEnvCleared();
    try {
      const controller = createExtensionsController({
        boundWorkspace: workspaceDir,
        bridge: {} as AcpSessionBridge,
        workspace: {} as DaemonWorkspaceService,
        isWorkspaceTrusted: () => true,
      });
      const readProxy = (manager: unknown): string | undefined =>
        (manager as { proxy?: string }).proxy;

      expect(
        readProxy(controller.createExtensionManager(workspaceDir, true)),
      ).toBe('http://workspace-settings:8080');
      expect(process.env['HTTPS_PROXY']).toBeUndefined();

      process.env['HTTPS_PROXY'] = 'http://daemon-ambient:8080';
      expect(
        readProxy(controller.createExtensionManager(workspaceDir, true)),
      ).toBe('http://workspace-settings:8080');

      // The settings load is trust-gated, so an untrusted workspace's
      // settings.proxy cannot reach the telemetry Config.
      expect(
        readProxy(controller.createExtensionManager(workspaceDir, false)),
      ).toBeUndefined();
    } finally {
      restoreEnv();
      vi.unstubAllEnvs();
      await rm(workspaceDir, { recursive: true, force: true });
      await rm(emptyHome, { recursive: true, force: true });
    }
  });

  it('resolves telemetry consent from the owning runtime env, not the ambient one', async () => {
    const optedOutDir = await mkdtemp(join(tmpdir(), 'qwen-ext-consent-off-'));
    const optedInDir = await mkdtemp(join(tmpdir(), 'qwen-ext-consent-on-'));
    const emptyHome = await mkdtemp(join(tmpdir(), 'qwen-ext-home-'));
    vi.stubEnv('QWEN_HOME', emptyHome);
    for (const [dir, usageStatisticsEnabled] of [
      [optedOutDir, false],
      [optedInDir, true],
    ] as const) {
      await mkdir(join(dir, '.qwen'), { recursive: true });
      await writeFile(
        join(dir, '.qwen', 'settings.json'),
        JSON.stringify({ privacy: { usageStatisticsEnabled } }),
      );
    }
    const restoreEnv = pinAmbientEnvCleared();
    const readConsent = (
      dir: string,
      env?: Readonly<NodeJS.ProcessEnv>,
    ): boolean | undefined =>
      (
        createExtensionsController({
          boundWorkspace: dir,
          bridge: {} as AcpSessionBridge,
          workspace: {} as DaemonWorkspaceService,
          ...(env ? { env } : {}),
        }).createExtensionManager(dir, true) as unknown as {
          usageStatisticsEnabled?: boolean;
        }
      ).usageStatisticsEnabled;
    try {
      // A value some other workspace published process-wide: the ambient env
      // is shared by every workspace the daemon hosts, so it is not this one's.
      process.env['QWEN_USAGE_STATISTICS_ENABLED'] = '1';

      // This workspace's own opt-out survives the ambient `1` because the
      // consent read resolves against the injected runtime env (#12770).
      expect(readConsent(optedOutDir, {})).toBe(false);
      // The runtime's own env still outranks its settings, exactly as it does
      // for a session Config, so an operator opt-out reaches this path too.
      expect(
        readConsent(optedInDir, { QWEN_USAGE_STATISTICS_ENABLED: '0' }),
      ).toBe(false);
      expect(readConsent(optedInDir, {})).toBe(true);
      // With no injected env (a non-primary workspace controller) the ambient
      // term still applies: dropping it would re-open telemetry an operator
      // switched off daemon-wide.
      process.env['QWEN_USAGE_STATISTICS_ENABLED'] = '0';
      expect(readConsent(optedInDir)).toBe(false);
    } finally {
      restoreEnv();
      vi.unstubAllEnvs();
      await rm(optedOutDir, { recursive: true, force: true });
      await rm(optedInDir, { recursive: true, force: true });
      await rm(emptyHome, { recursive: true, force: true });
    }
  });

  it('resolves the telemetry proxy from the owning runtime env when settings declare none', async () => {
    const workspaceDir = await mkdtemp(join(tmpdir(), 'qwen-ext-proxy-env-'));
    const emptyHome = await mkdtemp(join(tmpdir(), 'qwen-ext-home-'));
    vi.stubEnv('QWEN_HOME', emptyHome);
    await mkdir(join(workspaceDir, '.qwen'), { recursive: true });
    await writeFile(
      join(workspaceDir, '.qwen', 'settings.json'),
      JSON.stringify({ privacy: { usageStatisticsEnabled: false } }),
    );
    const restoreEnv = pinAmbientEnvCleared();
    const readProxy = (env?: Readonly<NodeJS.ProcessEnv>): string | undefined =>
      (
        createExtensionsController({
          boundWorkspace: workspaceDir,
          bridge: {} as AcpSessionBridge,
          workspace: {} as DaemonWorkspaceService,
          ...(env ? { env } : {}),
        }).createExtensionManager(workspaceDir, true) as unknown as {
          proxy?: string;
        }
      ).proxy;
    try {
      process.env['HTTPS_PROXY'] = 'http://daemon-ambient:8080';

      // The runtime's own resolved proxy reaches the upload, so lifecycle
      // events honour the same egress control the session telemetry does.
      expect(readProxy({ HTTPS_PROXY: 'http://runtime:3128' })).toBe(
        'http://runtime:3128',
      );
      // The ambient value is still never attributed to this workspace.
      expect(readProxy({})).toBeUndefined();
      expect(readProxy()).toBeUndefined();
    } finally {
      restoreEnv();
      vi.unstubAllEnvs();
      await rm(workspaceDir, { recursive: true, force: true });
      await rm(emptyHome, { recursive: true, force: true });
    }
  });

  it('attributes the injected runtime env only to its own workspace and never throws out of a route', async () => {
    const boundDir = await mkdtemp(join(tmpdir(), 'qwen-ext-env-bound-'));
    const otherDir = await mkdtemp(join(tmpdir(), 'qwen-ext-env-other-'));
    const emptyHome = await mkdtemp(join(tmpdir(), 'qwen-ext-home-'));
    vi.stubEnv('QWEN_HOME', emptyHome);
    for (const dir of [boundDir, otherDir]) {
      await mkdir(join(dir, '.qwen'), { recursive: true });
      await writeFile(
        join(dir, '.qwen', 'settings.json'),
        JSON.stringify({ privacy: { usageStatisticsEnabled: false } }),
      );
    }
    const restoreEnv = pinAmbientEnvCleared();
    const readTelemetry = (
      env: Readonly<NodeJS.ProcessEnv>,
      dir: string,
    ): { usageStatisticsEnabled?: boolean; proxy?: string } =>
      createExtensionsController({
        boundWorkspace: boundDir,
        bridge: {} as AcpSessionBridge,
        workspace: {} as DaemonWorkspaceService,
        env,
      }).createExtensionManager(dir, true) as unknown as {
        usageStatisticsEnabled?: boolean;
        proxy?: string;
      };
    try {
      const primaryEnv = {
        QWEN_USAGE_STATISTICS_ENABLED: '1',
        HTTPS_PROXY: 'http://primary-runtime:3128',
      };

      // The bound workspace reads the injected runtime env: its `1` outranks
      // that workspace's own opt-out, and its proxy reaches the upload.
      const bound = readTelemetry(primaryEnv, boundDir);
      expect(bound.usageStatisticsEnabled).toBe(true);
      expect(bound.proxy).toBe('http://primary-runtime:3128');

      // A manager for ANOTHER hosted workspace, built by that same controller,
      // inherits neither term: both resolve from that directory's own settings,
      // which opt out and declare no proxy.
      const other = readTelemetry(primaryEnv, otherDir);
      expect(other.usageStatisticsEnabled).toBe(false);
      expect(other.proxy).toBeUndefined();

      // `deps.env` is a live delegate over a runtime the trust reconciler can
      // move out of `active`, after which every read throws. A property read
      // must not be able to fail a route, so the bound workspace still
      // resolves — from its own settings.
      const closed = (): never => {
        throw Object.assign(new Error('Workspace runtime is not active.'), {
          name: 'WorkspaceGenerationClosedError',
          code: 'workspace_generation_closed',
        });
      };
      const throwingEnv = new Proxy({} as Readonly<NodeJS.ProcessEnv>, {
        get: closed,
        ownKeys: closed,
        getOwnPropertyDescriptor: closed,
      });
      const throwing = readTelemetry(throwingEnv, boundDir);
      expect(throwing.usageStatisticsEnabled).toBe(false);
      expect(throwing.proxy).toBeUndefined();
    } finally {
      restoreEnv();
      vi.unstubAllEnvs();
      await rm(boundDir, { recursive: true, force: true });
      await rm(otherDir, { recursive: true, force: true });
      await rm(emptyHome, { recursive: true, force: true });
    }
  });

  it('refuses an ambient opt-in this workspace did not choose, without injected env', async () => {
    const boundDir = await mkdtemp(join(tmpdir(), 'qwen-ext-ambient-bound-'));
    const otherDir = await mkdtemp(join(tmpdir(), 'qwen-ext-ambient-other-'));
    const emptyHome = await mkdtemp(join(tmpdir(), 'qwen-ext-home-'));
    vi.stubEnv('QWEN_HOME', emptyHome);
    for (const dir of [boundDir, otherDir]) {
      await mkdir(join(dir, '.qwen'), { recursive: true });
      await writeFile(
        join(dir, '.qwen', 'settings.json'),
        JSON.stringify({ privacy: { usageStatisticsEnabled: false } }),
      );
    }
    // Deliberately NOT `pinAmbientEnvCleared()`: an ambient opt-in some other
    // hosted repo published process-wide is exactly the leak being pinned.
    // `resolveUsageStatisticsEnabled`'s `env` parameter defaults to
    // `process.env`, so a manager with no attributable runtime env must not be
    // handed that default — otherwise this workspace's own opt-out loses to a
    // value that is not its own.
    vi.stubEnv('QWEN_USAGE_STATISTICS_ENABLED', '1');
    const readConsent = (manager: unknown): boolean | undefined =>
      (manager as { usageStatisticsEnabled?: boolean }).usageStatisticsEnabled;
    try {
      // A manager for ANOTHER hosted workspace, built by a controller that
      // does have the primary's env: nothing is attributable to `otherDir`, so
      // its own settings must decide.
      expect(
        readConsent(
          createExtensionsController({
            boundWorkspace: boundDir,
            bridge: {} as AcpSessionBridge,
            workspace: {} as DaemonWorkspaceService,
            env: {},
          }).createExtensionManager(otherDir, true),
        ),
      ).toBe(false);

      // The bound workspace whose runtime env delegate throws (the runtime
      // left `active`): same absence of an attributable env, same answer.
      const closed = (): never => {
        throw Object.assign(new Error('Workspace runtime is not active.'), {
          name: 'WorkspaceGenerationClosedError',
          code: 'workspace_generation_closed',
        });
      };
      const throwingEnv = new Proxy({} as Readonly<NodeJS.ProcessEnv>, {
        get: closed,
        ownKeys: closed,
        getOwnPropertyDescriptor: closed,
      });
      expect(
        readConsent(
          createExtensionsController({
            boundWorkspace: boundDir,
            bridge: {} as AcpSessionBridge,
            workspace: {} as DaemonWorkspaceService,
            env: throwingEnv,
          }).createExtensionManager(boundDir, true),
        ),
      ).toBe(false);

      // The narrowing is one-directional: an ambient OPT-OUT still closes the
      // gate, because that one is an operator decision about this daemon.
      vi.stubEnv('QWEN_USAGE_STATISTICS_ENABLED', '0');
      await writeFile(
        join(otherDir, '.qwen', 'settings.json'),
        JSON.stringify({ privacy: { usageStatisticsEnabled: true } }),
      );
      expect(
        readConsent(
          createExtensionsController({
            boundWorkspace: boundDir,
            bridge: {} as AcpSessionBridge,
            workspace: {} as DaemonWorkspaceService,
            env: {},
          }).createExtensionManager(otherDir, true),
        ),
      ).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await rm(boundDir, { recursive: true, force: true });
      await rm(otherDir, { recursive: true, force: true });
      await rm(emptyHome, { recursive: true, force: true });
    }
  });

  it('delivers the primary runtime env to the controller the routes build', async () => {
    // Pins the delivery hop in `routes/workspace-extensions.ts`: without
    // `env: deps.env` in `controllerDeps`, `deps.env` is undefined for the
    // primary controller, `runtimeEnv` is undefined for every manager it
    // builds, and consent silently falls back to ambient env — the #12770
    // leak shape — while the whole suite stays green.
    const runtimeEnv = Object.freeze({ QWEN_USAGE_STATISTICS_ENABLED: '1' });
    const controllerDepsSeen: unknown[] = [];
    vi.doMock(
      './workspace-extensions-controller.js',
      async (importOriginal) => {
        const actual =
          await importOriginal<
            typeof import('./workspace-extensions-controller.js')
          >();
        return {
          ...actual,
          createExtensionsController: (
            deps: Parameters<typeof actual.createExtensionsController>[0],
          ) => {
            controllerDepsSeen.push(deps);
            return actual.createExtensionsController(deps);
          },
        };
      },
    );
    try {
      const { registerWorkspaceExtensionRoutes } = await import(
        './workspace-extensions.js'
      );
      type RoutesDeps = Parameters<typeof registerWorkspaceExtensionRoutes>[1];
      const noop = () => undefined;
      const app = {
        get: noop,
        post: noop,
        put: noop,
        delete: noop,
        use: noop,
        locals: {},
      } as unknown as Parameters<typeof registerWorkspaceExtensionRoutes>[0];
      registerWorkspaceExtensionRoutes(app, {
        boundWorkspace: '/work/bound',
        bridge: {},
        workspace: {},
        mutate: () => noop,
        safeBody: (req: { body?: unknown }) =>
          (req.body ?? {}) as Record<string, unknown>,
        sendBridgeError: noop,
        env: runtimeEnv,
      } as unknown as RoutesDeps);

      expect(controllerDepsSeen).toEqual([
        expect.objectContaining({ env: runtimeEnv }),
      ]);
    } finally {
      vi.doUnmock('./workspace-extensions-controller.js');
    }
  });

  it('releases the commit lane when a manual refresh times out', async () => {
    vi.useFakeTimers();
    let refreshCalls = 0;
    let releaseRefresh:
      | ((result: { refreshed: number; failed: number }) => void)
      | undefined;
    const controller = createExtensionsController({
      boundWorkspace: '/work/bound',
      bridge: {} as AcpSessionBridge,
      workspace: {
        refreshExtensionsForAllSessions: () => {
          refreshCalls += 1;
          if (refreshCalls > 1) {
            return Promise.resolve({ refreshed: 1, failed: 0 });
          }
          return new Promise<{ refreshed: number; failed: number }>(
            (resolve) => {
              releaseRefresh = resolve;
            },
          );
        },
      } as unknown as DaemonWorkspaceService,
    });

    const outcome = controller.refreshExtensionsForAllSessions().then(
      () => 'resolved',
      (error: unknown) => (error instanceof Error ? error.message : 'error'),
    );
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await Promise.race([outcome, Promise.resolve('pending')])).toBe(
      'extension refresh timed out after 30000ms',
    );

    const nextOutcome = controller.refreshExtensionsForAllSessions().then(
      (result) => result,
      (error: unknown) => (error instanceof Error ? error.message : 'error'),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshCalls).toBe(2);
    await expect(nextOutcome).resolves.toEqual({ refreshed: 1, failed: 0 });

    releaseRefresh?.({ refreshed: 0, failed: 0 });
    await vi.advanceTimersByTimeAsync(0);
  });

  it('releases the commit lane at the durable commit boundary', async () => {
    let finishPostCommit!: () => void;
    const postCommit = new Promise<void>((resolve) => {
      finishPostCommit = resolve;
    });
    const controller = createExtensionsController({
      boundWorkspace: '/work/bound',
      bridge: {} as AcpSessionBridge,
      workspace: {} as DaemonWorkspaceService,
    });
    const manager = {
      refreshCache: vi.fn(async () => undefined),
    } as unknown as ExtensionManager;
    const response = () =>
      ({
        status: vi.fn().mockReturnThis(),
        location: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
        json: vi.fn(),
      }) as unknown as Response;
    let firstCommitted!: () => void;
    const durableCommit = new Promise<void>((resolve) => {
      firstCommitted = resolve;
    });
    let finishFirstOperation!: () => void;
    const firstOperationFinished = new Promise<void>((resolve) => {
      finishFirstOperation = resolve;
    });
    let finishSecondOperation!: () => void;
    const secondOperationFinished = new Promise<void>((resolve) => {
      finishSecondOperation = resolve;
    });
    let secondStarted = false;

    controller.runQueuedExtensionMutation(
      'install',
      { name: 'first' },
      response(),
      async (_extensionManager, _signal, context) => {
        await context!.commit(async (onCommitted) => {
          onCommitted(1);
          firstCommitted();
          await postCommit;
          return { generation: 1 };
        });
        finishFirstOperation();
        return { status: 'installed', name: 'first' };
      },
      { manager, skipRefresh: true },
    );
    await durableCommit;

    controller.runQueuedExtensionMutation(
      'enable',
      { name: 'second' },
      response(),
      async (_extensionManager, _signal, context) => {
        await context!.commit(async (onCommitted) => {
          secondStarted = true;
          onCommitted(2);
          return { generation: 2 };
        });
        finishSecondOperation();
        return { status: 'enabled', name: 'second' };
      },
      { manager, skipRefresh: true },
    );

    await vi.waitFor(() => expect(secondStarted).toBe(true));
    finishPostCommit();
    await Promise.all([firstOperationFinished, secondOperationFinished]);
  });

  it('does not commit after the captured runtime generation closes', async () => {
    let generationOpen = true;
    const controller = createExtensionsController({
      boundWorkspace: '/work/bound',
      bridge: {} as AcpSessionBridge,
      workspace: {} as DaemonWorkspaceService,
      captureGenerationAssertion: () => () => {
        if (!generationOpen) throw new Error('generation closed');
      },
    });
    const manager = {
      refreshCache: vi.fn(async () => undefined),
    } as unknown as ExtensionManager;
    const responseBody = vi.fn();
    const response = {
      status: vi.fn().mockReturnThis(),
      location: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      json: responseBody,
    } as unknown as Response;
    const commit = vi.fn(async () => ({ generation: 1 }));

    controller.runQueuedExtensionMutation(
      'install',
      { name: 'demo' },
      response,
      async (_extensionManager, _signal, context) => {
        await context!.commit(commit);
        return { status: 'installed', name: 'demo' };
      },
      { manager, skipRefresh: true },
    );
    generationOpen = false;
    const operationId = responseBody.mock.calls[0]?.[0].operationId as string;

    await vi.waitFor(() =>
      expect(controller.getOperation(operationId)).toMatchObject({
        status: 'failed',
        error: 'generation closed',
      }),
    );
    expect(commit).not.toHaveBeenCalled();
  });

  it('starts the status cache lifetime after a slow refresh completes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const refreshCache = vi
      .spyOn(ExtensionManager.prototype, 'refreshCache')
      .mockImplementation(async () => {
        vi.setSystemTime(3_000);
      });
    vi.spyOn(ExtensionManager.prototype, 'getLoadedExtensions').mockReturnValue(
      [],
    );
    const controller = createExtensionsController({
      boundWorkspace: '/work/bound',
      bridge: {} as AcpSessionBridge,
      workspace: {} as DaemonWorkspaceService,
    });

    await controller.buildLocalExtensionsStatus();
    await controller.buildLocalExtensionsStatus();

    expect(refreshCache).toHaveBeenCalledOnce();
  });

  it('coalesces cold and expired status loads while preserving cache hits', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let release!: () => void;
    const refresh = vi
      .spyOn(ExtensionManager.prototype, 'refreshCache')
      .mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
    vi.spyOn(ExtensionManager.prototype, 'getLoadedExtensions').mockReturnValue(
      [],
    );
    const controller = createExtensionsController({
      boundWorkspace: '/work/bound',
      bridge: {} as AcpSessionBridge,
      workspace: {} as DaemonWorkspaceService,
      isWorkspaceTrusted: () => true,
    });
    for (const expectedLoads of [1, 2]) {
      const requests = Array.from({ length: 5 }, () =>
        controller.buildLocalExtensionsStatus(),
      );
      expect(refresh).toHaveBeenCalledTimes(expectedLoads);
      release();
      const statuses = await Promise.all(requests);
      expect(statuses.every((status) => status === statuses[0])).toBe(true);
      expect(await controller.buildLocalExtensionsStatus()).toBe(statuses[0]);
      expect(refresh).toHaveBeenCalledTimes(expectedLoads);
      vi.setSystemTime(Date.now() + 2_001);
    }
  });

  it('shares a failed load and retries on the next request', async () => {
    let reject!: (error: Error) => void;
    const refresh = vi
      .spyOn(ExtensionManager.prototype, 'refreshCache')
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, rejectLoad) => {
            reject = rejectLoad;
          }),
      )
      .mockResolvedValue(undefined);
    vi.spyOn(ExtensionManager.prototype, 'getLoadedExtensions').mockReturnValue(
      [],
    );
    const controller = createExtensionsController({
      boundWorkspace: '/work/bound',
      bridge: {} as AcpSessionBridge,
      workspace: {} as DaemonWorkspaceService,
      isWorkspaceTrusted: () => true,
    });
    const requests = Promise.allSettled([
      controller.buildLocalExtensionsStatus(),
      controller.buildLocalExtensionsStatus(),
    ]);
    const error = new Error('load failed');
    reject(error);
    expect(await requests).toEqual([
      { status: 'rejected', reason: error },
      { status: 'rejected', reason: error },
    ]);
    await expect(
      controller.buildLocalExtensionsStatus(),
    ).resolves.toMatchObject({ initialized: true });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it.each(['locale', 'trust', 'controller'] as const)(
    'does not share pending status loads across %s changes',
    async (change) => {
      const releases: Array<() => void> = [];
      const refresh = vi
        .spyOn(ExtensionManager.prototype, 'refreshCache')
        .mockImplementation(
          () =>
            new Promise<void>((resolve) => {
              releases.push(resolve);
            }),
        );
      vi.spyOn(
        ExtensionManager.prototype,
        'getLoadedExtensions',
      ).mockReturnValue([]);
      let trusted = true;
      const deps = {
        boundWorkspace: '/work/bound',
        bridge: {} as AcpSessionBridge,
        workspace: {} as DaemonWorkspaceService,
        isWorkspaceTrusted: () => trusted,
      };
      const controller = createExtensionsController(deps);
      const first = controller.buildLocalExtensionsStatus();
      if (change === 'locale')
        vi.mocked(resolveLanguageSetting).mockReturnValue('zh');
      if (change === 'trust') trusted = false;
      const nextController =
        change === 'controller'
          ? createExtensionsController({
              ...deps,
              boundWorkspace: '/work/other',
            })
          : controller;
      const second = nextController.buildLocalExtensionsStatus();
      expect(refresh).toHaveBeenCalledTimes(2);
      releases[1]!();
      const fresh = await second;
      releases[0]!();
      await first;
      expect(await nextController.buildLocalExtensionsStatus()).toBe(fresh);
      expect(refresh).toHaveBeenCalledTimes(2);
    },
  );

  it('invalidates a completed status cache when trust changes', async () => {
    let trusted = true;
    const refresh = vi
      .spyOn(ExtensionManager.prototype, 'refreshCache')
      .mockResolvedValue(undefined);
    vi.spyOn(ExtensionManager.prototype, 'getLoadedExtensions').mockReturnValue(
      [],
    );
    const controller = createExtensionsController({
      boundWorkspace: '/work/bound',
      bridge: {} as AcpSessionBridge,
      workspace: {} as DaemonWorkspaceService,
      isWorkspaceTrusted: () => trusted,
    });
    await controller.buildLocalExtensionsStatus();
    trusted = false;
    await controller.buildLocalExtensionsStatus();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it.each(['old-first', 'new-first', 'old-fails'] as const)(
    'does not let an invalidated status load overwrite or clear its replacement (%s)',
    async (order) => {
      const releases: Array<{
        resolve: () => void;
        reject: (error: Error) => void;
      }> = [];
      const refresh = vi
        .spyOn(ExtensionManager.prototype, 'refreshCache')
        .mockImplementation(
          () =>
            new Promise<void>((resolve, reject) => {
              releases.push({ resolve, reject });
            }),
        );
      vi.spyOn(
        ExtensionManager.prototype,
        'getLoadedExtensions',
      ).mockReturnValue([]);
      const controller = createExtensionsController({
        boundWorkspace: '/work/bound',
        bridge: {} as AcpSessionBridge,
        workspace: {
          refreshExtensionsForAllSessions: vi
            .fn()
            .mockResolvedValue({ refreshed: 0, failed: 0 }),
        } as unknown as DaemonWorkspaceService,
        isWorkspaceTrusted: () => true,
      });
      const old = controller
        .buildLocalExtensionsStatus()
        .catch(() => undefined);
      await controller.refreshExtensionsForAllSessions();
      const fresh = controller.buildLocalExtensionsStatus();
      expect(refresh).toHaveBeenCalledTimes(2);
      if (order === 'new-first') {
        releases[1]!.resolve();
        await fresh;
      }
      if (order === 'old-fails') releases[0]!.reject(new Error('old failure'));
      else releases[0]!.resolve();
      await old;
      const joined = controller.buildLocalExtensionsStatus();
      expect(refresh).toHaveBeenCalledTimes(2);
      releases[1]!.resolve();
      expect(await joined).toBe(await fresh);
      expect(await controller.buildLocalExtensionsStatus()).toBe(await fresh);
    },
  );

  it.each([false, true])(
    'invalidates pending status after a committed mutation (post-commit failure: %s)',
    async (failAfterCommit) => {
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      let release!: () => void;
      const refresh = vi
        .spyOn(ExtensionManager.prototype, 'refreshCache')
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        )
        .mockResolvedValue(undefined);
      vi.spyOn(
        ExtensionManager.prototype,
        'getLoadedExtensions',
      ).mockReturnValue([]);
      const controller = createExtensionsController({
        boundWorkspace: '/work/bound',
        bridge: {
          broadcastExtensionsChanged: vi.fn(),
        } as unknown as AcpSessionBridge,
        workspace: {} as DaemonWorkspaceService,
        isWorkspaceTrusted: () => true,
      });
      const old = controller.buildLocalExtensionsStatus();
      const json = vi.fn();
      const response = {
        status: vi.fn().mockReturnThis(),
        location: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
        json,
      } as unknown as Response;
      controller.runQueuedExtensionMutation(
        'enable',
        { name: 'demo' },
        response,
        async (_manager, _signal, context) => {
          await context!.commit(async (onCommitted) => {
            onCommitted(1);
            if (failAfterCommit) throw new Error('post-commit failure');
            return { generation: 1 };
          });
          return { status: 'enabled', name: 'demo' };
        },
        {
          manager: {
            refreshCache: vi.fn().mockResolvedValue(undefined),
          } as unknown as ExtensionManager,
          skipRefresh: true,
        },
      );
      const operationId = json.mock.calls[0]![0].operationId as string;
      await vi.waitFor(() =>
        expect(controller.getOperation(operationId)?.status).toBe(
          failAfterCommit ? 'succeeded_with_warnings' : 'succeeded',
        ),
      );
      const fresh = await controller.buildLocalExtensionsStatus();
      expect(refresh).toHaveBeenCalledTimes(2);
      release();
      await old;
      expect(await controller.buildLocalExtensionsStatus()).toBe(fresh);
      expect(refresh).toHaveBeenCalledTimes(2);
    },
  );

  it('normalizes the current language when resolving extension metadata', async () => {
    vi.mocked(resolveLanguageSetting).mockImplementation((language) =>
      language === 'zh_TW' ? 'zh_TW' : 'en',
    );
    const extensionDir = await mkdtemp(
      join(tmpdir(), 'qwen-localized-extension-'),
    );

    try {
      await mkdir(join(extensionDir, '.qwen'));
      await writeFile(
        join(extensionDir, '.qwen', 'settings.json'),
        JSON.stringify({ general: { language: 'zh_TW' } }),
      );
      await writeFile(
        join(extensionDir, 'qwen-extension.json'),
        JSON.stringify({
          name: 'localized-extension',
          displayName: { en: 'English name', 'zh-TW': '繁體名稱' },
        }),
      );
      const controller = createExtensionsController({
        boundWorkspace: extensionDir,
        bridge: {} as AcpSessionBridge,
        workspace: {} as DaemonWorkspaceService,
      });

      const config = controller
        .createExtensionManager(extensionDir, true)
        .loadExtensionConfig({ extensionDir });

      expect(config.displayName).toBe('繁體名稱');
      expect(resolveLanguageSetting).toHaveBeenCalledWith('zh_TW');
    } finally {
      await rm(extensionDir, { recursive: true, force: true });
    }
  });

  it('invalidates the status cache when the current language changes', async () => {
    const refreshCache = vi
      .spyOn(ExtensionManager.prototype, 'refreshCache')
      .mockResolvedValue(undefined);
    vi.spyOn(ExtensionManager.prototype, 'getLoadedExtensions').mockReturnValue(
      [],
    );
    const controller = createExtensionsController({
      boundWorkspace: '/work/bound',
      bridge: {} as AcpSessionBridge,
      workspace: {} as DaemonWorkspaceService,
    });

    await controller.buildLocalExtensionsStatus();
    await controller.buildLocalExtensionsStatus();
    vi.mocked(resolveLanguageSetting).mockReturnValue('zh');
    await controller.buildLocalExtensionsStatus();

    expect(refreshCache).toHaveBeenCalledTimes(2);
  });

  it('reports an accepted operation as running while its cache refreshes', async () => {
    let finishRefresh!: () => void;
    const refreshPending = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    const manager = {
      refreshCache: vi.fn(async () => await refreshPending),
    } as unknown as ExtensionManager;
    const responseBody = vi.fn();
    const response = {
      status: vi.fn().mockReturnThis(),
      location: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      json: responseBody,
    } as unknown as Response;
    const controller = createExtensionsController({
      boundWorkspace: '/work/bound',
      bridge: {} as AcpSessionBridge,
      workspace: {} as DaemonWorkspaceService,
    });

    controller.runQueuedExtensionMutation(
      'install',
      { name: 'demo' },
      response,
      async () => ({ status: 'installed', name: 'demo', updated: false }),
      { manager, skipRefresh: true },
    );
    const operationId = responseBody.mock.calls[0]?.[0].operationId as string;

    await vi.waitFor(() => expect(manager.refreshCache).toHaveBeenCalledOnce());
    expect(controller.getOperation(operationId)).toMatchObject({
      status: 'running',
      phase: 'preparing',
    });

    finishRefresh();
    await vi.waitFor(() =>
      expect(controller.getOperation(operationId)?.status).toBe('succeeded'),
    );
  });

  it('reports an operation as preparing while any parallel preparation is active', async () => {
    let releaseBlocker!: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstActive = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const controller = createExtensionsController({
      boundWorkspace: '/work/bound',
      bridge: {} as AcpSessionBridge,
      workspace: {} as DaemonWorkspaceService,
    });
    const manager = {
      refreshCache: vi.fn(async () => undefined),
    } as unknown as ExtensionManager;
    const responseBody = vi.fn();
    const response = {
      status: vi.fn().mockReturnThis(),
      location: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      json: responseBody,
    } as unknown as Response;
    const held = controller.preparationQueue.run(async () => await blocker);

    controller.runQueuedExtensionMutation(
      'install',
      { name: 'demo' },
      response,
      async (_extensionManager, _signal, context) => {
        await Promise.all([
          context!.prepare(async () => {
            firstStarted();
            await first;
          }),
          context!.prepare(async () => undefined),
        ]);
        return { status: 'installed', name: 'demo', updated: false };
      },
      { manager, skipRefresh: true },
    );
    const operationId = responseBody.mock.calls[0]?.[0].operationId as string;

    await firstActive;
    expect(controller.getOperation(operationId)).toMatchObject({
      status: 'running',
      phase: 'preparing',
    });

    releaseFirst();
    releaseBlocker();
    await held;
    await vi.waitFor(() =>
      expect(controller.getOperation(operationId)).toMatchObject({
        status: 'succeeded',
        phase: undefined,
      }),
    );
  });

  it('clears phase from every terminal operation state', async () => {
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const controller = createExtensionsController({
      boundWorkspace: '/work/bound',
      bridge: {
        broadcastExtensionsChanged: vi.fn(),
      } as unknown as AcpSessionBridge,
      workspace: {} as DaemonWorkspaceService,
    });
    const manager = {
      refreshCache: vi.fn(async () => undefined),
    } as unknown as ExtensionManager;
    const response = () => {
      const responseBody = vi.fn();
      return {
        responseBody,
        value: {
          status: vi.fn().mockReturnThis(),
          location: vi.fn().mockReturnThis(),
          set: vi.fn().mockReturnThis(),
          json: responseBody,
        } as unknown as Response,
      };
    };
    const run = async (
      operation: Parameters<typeof controller.runQueuedExtensionMutation>[3],
    ) => {
      const res = response();
      controller.runQueuedExtensionMutation(
        'install',
        { name: 'demo' },
        res.value,
        operation,
        { manager, skipRefresh: true },
      );
      const operationId = res.responseBody.mock.calls[0]?.[0]
        .operationId as string;
      await vi.waitFor(() =>
        expect(controller.getOperation(operationId)?.status).toMatch(
          /^(succeeded|succeeded_with_warnings|failed)$/,
        ),
      );
      return controller.getOperation(operationId);
    };

    await expect(
      run(async () => ({
        status: 'installed',
        name: 'demo',
        updated: false,
      })),
    ).resolves.toMatchObject({ status: 'succeeded', phase: undefined });
    await expect(
      run(async (_extensionManager, _signal, context) => {
        await context!.commit(async () => ({
          generation: 1,
          warnings: [{ code: 'cleanup_failed', error: 'cleanup failed' }],
        }));
        return { status: 'installed', name: 'demo', updated: false };
      }),
    ).resolves.toMatchObject({
      status: 'succeeded_with_warnings',
      phase: undefined,
    });
    await expect(
      run(async () => {
        throw new Error('prepare failed');
      }),
    ).resolves.toMatchObject({ status: 'failed', phase: undefined });
  });

  it('aborts timed-out preparation without committing and releases its slot', async () => {
    vi.useFakeTimers();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    let releaseBlocker!: () => void;
    const blocker = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    const controller = createExtensionsController({
      boundWorkspace: '/work/bound',
      bridge: {
        broadcastExtensionsChanged: vi.fn(),
      } as unknown as AcpSessionBridge,
      workspace: {} as DaemonWorkspaceService,
    });
    const manager = {
      refreshCache: vi.fn(async () => undefined),
    } as unknown as ExtensionManager;
    const responseBody = vi.fn();
    const response = {
      status: vi.fn().mockReturnThis(),
      location: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      json: responseBody,
    } as unknown as Response;
    const commit = vi.fn(async () => ({ generation: 1 }));
    const held = controller.preparationQueue.run(async () => await blocker);

    controller.runQueuedExtensionMutation(
      'install',
      { name: 'demo' },
      response,
      async (_extensionManager, _signal, context) => {
        await context!.prepare(
          async (signal) =>
            await new Promise<void>((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), {
                once: true,
              });
            }),
        );
        await context!.commit(commit);
        return { status: 'installed', name: 'demo' };
      },
      { manager, deadlineMs: 100 },
    );
    await vi.advanceTimersByTimeAsync(0);
    const operationId = responseBody.mock.calls[0]?.[0].operationId as string;
    let probeStarted = false;
    const probe = controller.preparationQueue.run(async () => {
      probeStarted = true;
    });
    expect(probeStarted).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    await probe;

    expect(controller.getOperation(operationId)).toMatchObject({
      status: 'failed',
      code: 'extension_prepare_timeout',
    });
    expect(commit).not.toHaveBeenCalled();
    expect(probeStarted).toBe(true);

    releaseBlocker();
    await held;
  });

  it('does not commit preparation that settles after its deadline', async () => {
    vi.useFakeTimers();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    let finishPreparation!: () => void;
    const preparation = new Promise<void>((resolve) => {
      finishPreparation = resolve;
    });
    const controller = createExtensionsController({
      boundWorkspace: '/work/bound',
      bridge: {
        broadcastExtensionsChanged: vi.fn(),
      } as unknown as AcpSessionBridge,
      workspace: {} as DaemonWorkspaceService,
    });
    const manager = {
      refreshCache: vi.fn(async () => undefined),
    } as unknown as ExtensionManager;
    const responseBody = vi.fn();
    const response = {
      status: vi.fn().mockReturnThis(),
      location: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      json: responseBody,
    } as unknown as Response;
    const commit = vi.fn(async () => ({ generation: 1 }));

    controller.runQueuedExtensionMutation(
      'install',
      { name: 'demo' },
      response,
      async (_extensionManager, _signal, context) => {
        await context!.prepare(async () => await preparation);
        await context!.commit(commit);
        return { status: 'installed', name: 'demo' };
      },
      { manager, deadlineMs: 100 },
    );
    await vi.advanceTimersByTimeAsync(0);
    const operationId = responseBody.mock.calls[0]?.[0].operationId as string;

    await vi.advanceTimersByTimeAsync(100);
    finishPreparation();
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() =>
      expect(controller.getOperation(operationId)).toMatchObject({
        status: 'failed',
        code: 'extension_prepare_timeout',
      }),
    );
    expect(commit).not.toHaveBeenCalled();
  });

  it('releases the operation slot when the acceptance response throws', () => {
    let operationId: string | undefined;
    const throwingResponse = {
      status: vi.fn().mockReturnThis(),
      location: vi.fn().mockReturnThis(),
      set: vi.fn().mockReturnThis(),
      json: vi.fn((body: { operationId: string }) => {
        operationId = body.operationId;
        throw new Error('socket closed');
      }),
    } as unknown as Response;
    const controller = createExtensionsController({
      boundWorkspace: '/work/bound',
      bridge: {} as AcpSessionBridge,
      workspace: {} as DaemonWorkspaceService,
    });

    expect(() =>
      controller.runQueuedExtensionMutation(
        'install',
        {},
        throwingResponse,
        async () => ({ status: 'installed' }),
      ),
    ).not.toThrow();
    expect(operationId).toBeDefined();
    expect(controller.getOperation(operationId!)).toBeUndefined();

    const response = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as unknown as Response;
    const releases = Array.from({ length: 10 }, () =>
      controller.acquireOperationSlot(response),
    );
    expect(releases.every(Boolean)).toBe(true);
    releases.forEach((release) => release?.());
  });
});
