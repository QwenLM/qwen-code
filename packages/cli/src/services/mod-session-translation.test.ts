/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { ModRenderSite } from '@qwen-code/qwen-code-core/mods/render-tree.js';
import type { ModPlugin } from '@qwen-code/qwen-code-core/mods/types.js';
import type { LoadedSettings } from '../config/settings.js';
import type { JsonOutputAdapterInterface } from '../nonInteractive/io/BaseJsonOutputAdapter.js';
import { ModSession } from './mod-session.js';

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  dependencies: vi.fn(),
  create: vi.fn(),
}));
vi.mock('@qwen-code/qwen-code-core/mods/discovery.js', () => ({
  loadModSource: mocks.load,
  loadModDependencies: mocks.dependencies,
}));
vi.mock('@qwen-code/qwen-code-core/mods/runtime.js', () => ({
  ModRuntime: { createGroup: mocks.create },
}));

const settings = (
  general: Record<string, unknown>,
  experimental: Record<string, unknown> = {},
) =>
  ({
    merged: { general, experimental },
    systemDefaults: { settings: {} },
    user: { settings: {} },
    system: { settings: {} },
  }) as unknown as LoadedSettings;

describe('Mod session display translation', () => {
  const sessions: ModSession[] = [];

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
    vi.resetAllMocks();
  });

  function setup({
    mods = false,
    displayLanguage = 'zh-CN',
    sites = ['AssistantMessage', 'Thinking'],
    trusted = true,
    hooksDisabled = false,
    bare = false,
  }: {
    mods?: boolean;
    displayLanguage?: string;
    sites?: readonly ModRenderSite[];
    trusted?: boolean;
    hooksDisabled?: boolean;
    bare?: boolean;
  } = {}) {
    const extension = {
      id: 'ext-id',
      name: 'my-mod',
      version: '1.0.0',
      path: '/mod',
      isActive: true,
    };
    const config = {
      getSessionId: () => 'session-1',
      getTargetDir: () => '/workspace',
      getProjectRoot: () => '/workspace',
      getModel: () => 'model',
      getCliVersion: () => '1.2.3',
      getExtensions: vi.fn(() => [extension]),
      isInteractive: () => false,
      getExperimentalZedIntegration: () => true,
      isTrustedFolder: () => trusted,
      getDisableAllHooks: () => hooksDisabled,
      getBareMode: () => bare,
      isSafeMode: () => false,
      getExecutionEnvironment: () => undefined,
      getExecutionEnvironmentFactory: () => undefined,
      getHookSystem: () => undefined,
      getSandbox: () => undefined,
      isSessionAgentSession: () => false,
      getChatRecordingService: () => undefined,
      getContentGeneratorConfig: () => undefined,
      getResumedSessionData: () => undefined,
    };
    const runtime = {
      hasToolHooks: false,
      renderHooksFor: (site: ModRenderSite) =>
        sites.includes(site) ? ['display-translation'] : [],
      turnHooks: { start: false, complete: [] as string[] },
      getCommands: () => [],
      render: vi.fn(async () => ({
        tree: { type: 'engine' as const, ref: 0 },
        props: { text: '译文' },
        notes: [],
      })),
      end: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    mocks.load.mockResolvedValue({
      root: '/mod',
      entry: '/mod/entry.js',
      source: 'export function register() {}',
      dependencies: [],
    });
    mocks.dependencies.mockResolvedValue([]);
    mocks.create.mockResolvedValue(runtime);
    const session = ModSession.create(
      config as unknown as Config,
      settings({ displayLanguage }, { mods }),
      { surface: 'desktop', log: vi.fn(), sites: () => sites },
    );
    if (session) sessions.push(session);
    const plugins = () =>
      (mocks.create.mock.lastCall?.[0] as ModPlugin[] | undefined)?.map(
        (plugin) => [plugin.name, plugin.options],
      );
    return { config, runtime, session, plugins };
  }

  it('starts for the setting alone, only where rows are drawn', () => {
    expect(setup().session).toBeInstanceOf(ModSession);
    expect(setup({ displayLanguage: 'off' }).session).toBeUndefined();
    expect(setup({ displayLanguage: 'fr' }).session).toBeUndefined();
    // Headless output draws no rows.
    expect(
      ModSession.create(
        {} as Config,
        settings({ displayLanguage: 'en' }),
        {} as JsonOutputAdapterInterface,
      ),
    ).toBeUndefined();
  });

  it('loads the built-in Mod without experimental Mods or trust, and no installed Mod', async () => {
    const { session, config, plugins } = setup({
      displayLanguage: 'en',
      trusted: false,
    });
    await session!.initialize(new AbortController().signal);
    expect(config.getExtensions).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
    expect(plugins()).toEqual([['display-translation', { language: 'en' }]]);
    // Rows are asked for in the untrusted workspace.
    await expect(
      session!.askRow(
        'AssistantMessage',
        { text: 'Hello', isFirstOfReply: true },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ status: 'answered', props: { text: '译文' } });
  });

  it('runs after the installed Mods when both are on', async () => {
    const { session, plugins } = setup({ mods: true });
    await session!.initialize(new AbortController().signal);
    expect(plugins()).toEqual([
      ['my-mod', {}],
      ['display-translation', { language: 'zh-CN' }],
    ]);
  });

  it('keeps installed Mods behind workspace trust', async () => {
    const { session, plugins } = setup({ mods: true, trusted: false });
    await session!.initialize(new AbortController().signal);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(plugins()).toEqual([['display-translation', { language: 'zh-CN' }]]);
  });

  it.each([{ bare: true }, { hooksDisabled: true }])(
    'keeps the other gates: %o',
    async (gate) => {
      const { session } = setup(gate);
      await session!.initialize(new AbortController().signal);
      expect(mocks.create).not.toHaveBeenCalled();
    },
  );

  it('is not loaded by a host that draws no reply or thinking rows', async () => {
    const { session } = setup({ sites: [] });
    await session!.initialize(new AbortController().signal);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('leaves the session running untranslated when it alone fails to start', async () => {
    const { session } = setup();
    mocks.create.mockRejectedValueOnce(new Error('worker failed'));
    await expect(
      session!.initialize(new AbortController().signal),
    ).resolves.toBeUndefined();
    await expect(
      session!.askRow(
        'AssistantMessage',
        { text: 'Hello', isFirstOfReply: true },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ status: 'unhooked' });
  });

  it('still fails the Mods when they start with an installed one', async () => {
    const { session } = setup({ mods: true });
    mocks.create.mockRejectedValueOnce(new Error('worker failed'));
    await expect(
      session!.initialize(new AbortController().signal),
    ).rejects.toThrow('worker failed');
  });
});
