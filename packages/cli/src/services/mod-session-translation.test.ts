/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import {
  BaseLlmClient,
  type GenerateTextOptions,
} from '@qwen-code/qwen-code-core/core/baseLlmClient.js';
import type {
  ModAssistantMessageInput,
  ModRenderSite,
} from '@qwen-code/qwen-code-core/mods/render-tree.js';
import { ChatRecordingService } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import type { LoadedSettings } from '../config/settings.js';
import type { JsonOutputAdapterInterface } from '../nonInteractive/io/BaseJsonOutputAdapter.js';
import type { translateDisplayText } from './display-translation-mod.js';
import { ModSession } from './mod-session.js';

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  dependencies: vi.fn(),
  create: vi.fn(),
  translate: vi.fn<typeof translateDisplayText>(),
}));
vi.mock('@qwen-code/qwen-code-core/mods/discovery.js', () => ({
  loadModSource: mocks.load,
  loadModDependencies: mocks.dependencies,
}));
vi.mock('@qwen-code/qwen-code-core/mods/runtime.js', () => ({
  ModRuntime: { createGroup: mocks.create },
}));
vi.mock('./display-translation-mod.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./display-translation-mod.js')>()),
  translateDisplayText: mocks.translate,
}));

const reply: ModAssistantMessageInput = {
  surface: 'terminal',
  component: 'AssistantMessage',
  requestId: 'reply-1',
  props: { text: 'Hello', isFirstOfReply: true },
};

const translatedReply = { ...reply.props, text: '译文' };
const authorize = () => true;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const translateWithFakeModel: typeof translateDisplayText = async (
  text,
  _target,
  complete,
  signal,
) => {
  const result = await complete({ model: 'haiku', prompt: text }, signal);
  return result.isAnswered ? result.text : undefined;
};

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
    terminal = false,
    extensions = 1,
  }: {
    mods?: boolean;
    displayLanguage?: string;
    sites?: readonly ModRenderSite[];
    trusted?: boolean;
    hooksDisabled?: boolean;
    bare?: boolean;
    terminal?: boolean;
    extensions?: number;
  } = {}) {
    const generateText = vi.fn().mockResolvedValue({ text: '译文' });
    const config = {
      getSessionId: vi.fn(() => 'session-1'),
      getTargetDir: () => '/workspace',
      getProjectRoot: () => '/workspace',
      getModel: () => 'model',
      getCliVersion: () => '1.2.3',
      getExtensions: vi.fn(() =>
        Array.from({ length: extensions }, (_, index) => ({
          id: `ext-${index}`,
          name: `my-mod-${index}`,
          version: '1.0.0',
          path: '/mod',
          isActive: true,
        })),
      ),
      isInteractive: () => terminal,
      getExperimentalZedIntegration: () => !terminal,
      isTrustedFolder: () => trusted,
      getDisableAllHooks: () => hooksDisabled,
      getBareMode: () => bare,
      isSafeMode: () => false,
      getExecutionEnvironment: () => undefined,
      getExecutionEnvironmentFactory: () => undefined,
      getHookSystem: () => undefined,
      getSandbox: () => undefined,
      isSessionAgentSession: () => false,
      getChatRecordingService: vi.fn<Config['getChatRecordingService']>(),
      getContentGeneratorConfig: () => undefined,
      getResumedSessionData: () => undefined,
      getLlmClient: () => undefined,
      getAllConfiguredModels: vi.fn(() => []),
      getBaseLlmClient: () => ({ generateText }),
    };
    const runtime = {
      hasToolHooks: false,
      renderHooksFor: (site: ModRenderSite) =>
        sites.includes(site) ? ['my-mod-0'] : [],
      promptHooks: ['my-mod-0'],
      submitPrompt: vi.fn().mockResolvedValue({ text: 'Next prompt' }),
      turnHooks: { start: false, complete: [] as string[] },
      getCommands: () => [],
      render: vi.fn(async () => ({
        tree: { type: 'engine' as const, ref: 0 },
        props: { ...reply.props, text: 'Rewritten by an installed Mod' },
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
    mocks.translate.mockResolvedValue('译文');
    const session = ModSession.create(
      config as unknown as Config,
      settings({ displayLanguage }, { mods }),
      terminal
        ? {
            surface: 'terminal',
            presentation: () => ({ isFullscreen: true, columns: 80 }),
            sites: () => sites,
            prompts: () => true,
            log: vi.fn(),
          }
        : { surface: 'desktop', log: vi.fn(), sites: () => sites },
    );
    if (session) sessions.push(session);
    return { config, runtime, session, generateText };
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

  it('translates without installed Mods, including in an untrusted workspace', async () => {
    const { session, config } = setup({
      displayLanguage: 'en',
      trusted: false,
    });
    await session!.initialize(new AbortController().signal);
    expect(config.getExtensions).not.toHaveBeenCalled();
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(session!.canTranslateRow('AssistantMessage')).toBe(true);
    await expect(
      session!.askRow(
        'AssistantMessage',
        reply.props,
        new AbortController().signal,
        authorize,
      ),
    ).resolves.toEqual({
      status: 'answered',
      props: { ...reply.props, text: '译文' },
    });
  });

  it('translates what installed Mods drew and leaves all 32 installed slots available', async () => {
    const { session } = setup({ mods: true, extensions: 32 });
    await session!.initialize(new AbortController().signal);
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.create.mock.calls[0][0]).toHaveLength(32);
    const signal = new AbortController().signal;
    await expect(
      session!.askRow('AssistantMessage', reply.props, signal, authorize),
    ).resolves.toEqual({
      status: 'answered',
      props: { ...reply.props, text: '译文' },
    });
    expect(mocks.translate.mock.calls[0][0]).toBe(
      'Rewritten by an installed Mod',
    );
  });

  it('keeps installed Mods behind workspace trust', async () => {
    const { session } = setup({ mods: true, trusted: false });
    await session!.initialize(new AbortController().signal);
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(session!.canTranslateRow('AssistantMessage')).toBe(true);
  });

  it.each([{ bare: true }, { hooksDisabled: true }])(
    'keeps the other gates: %o',
    async (gate) => {
      const { session } = setup(gate);
      await session!.initialize(new AbortController().signal);
      expect(session!.canTranslateRow('AssistantMessage')).toBe(false);
    },
  );

  it('is not loaded by a host that draws no reply or thinking rows', async () => {
    const { session } = setup({ sites: [] });
    await session!.initialize(new AbortController().signal);
    expect(session!.canTranslateRow('AssistantMessage')).toBe(false);
  });

  it('keeps installed rewrites when translation returns no result', async () => {
    const { session } = setup({ mods: true });
    mocks.translate.mockResolvedValueOnce(undefined);
    await session!.initialize(new AbortController().signal);
    await expect(
      session!.askRow(
        'AssistantMessage',
        reply.props,
        new AbortController().signal,
        authorize,
      ),
    ).resolves.toEqual({
      status: 'answered',
      props: { ...reply.props, text: 'Rewritten by an installed Mod' },
    });
  });

  it('still reports failures to load installed Mods', async () => {
    const { session } = setup({ mods: true });
    mocks.create.mockRejectedValueOnce(new Error('worker failed'));
    await expect(
      session!.initialize(new AbortController().signal),
    ).rejects.toThrow('worker failed');
  });

  it('admits a terminal prompt while translation is pending', async () => {
    const { session, runtime } = setup({ mods: true, terminal: true });
    const translation = deferred<string>();
    mocks.translate.mockReturnValueOnce(translation.promise);
    await session!.initialize(new AbortController().signal);
    const unwatch = session!.watchRow('session-1', reply, () => {});
    try {
      await vi.waitFor(() => expect(mocks.translate).toHaveBeenCalledOnce());
      const prompt = session!.submitPrompt(
        'Next prompt',
        new AbortController().signal,
      );
      try {
        await vi.waitFor(() => expect(runtime.submitPrompt).toHaveBeenCalled());
      } finally {
        translation.resolve('译文');
      }
      await expect(prompt).resolves.toEqual({ text: 'Next prompt' });
    } finally {
      translation.resolve('译文');
      unwatch?.();
    }
  });

  it('does not let an unauthorized row ask suppress a later translation', async () => {
    const { session } = setup();
    const signal = new AbortController().signal;
    await session!.initialize(signal);
    await expect(
      session!.askRow('AssistantMessage', reply.props, signal),
    ).resolves.toEqual({ status: 'unanswered' });
    expect(mocks.translate).not.toHaveBeenCalled();
    await expect(
      session!.askRow('AssistantMessage', reply.props, signal, authorize),
    ).resolves.toMatchObject({ props: { text: '译文' } });
  });

  it('cancels a translation on session switch and ignores its late answer', async () => {
    const { config, session } = setup();
    const translation = deferred<string>();
    mocks.translate.mockReturnValueOnce(translation.promise);
    const signal = new AbortController().signal;
    await session!.initialize(signal);
    const ask = () =>
      session!.askRow('AssistantMessage', reply.props, signal, authorize);
    const original = ask();
    try {
      await vi.waitFor(() => expect(mocks.translate).toHaveBeenCalledOnce());
      const originalSignal = mocks.translate.mock.calls[0][3];
      config.getSessionId.mockReturnValue('session-2');
      await session!.syncSession('resume');
      expect(originalSignal.aborted).toBe(true);
      await expect(original).resolves.toEqual({ status: 'unanswered' });
    } finally {
      translation.resolve('旧译文');
    }
    await expect(ask()).resolves.toMatchObject({ props: { text: '译文' } });
  });

  it('keeps installed Mod answers and translation answers distinct for remote asks', async () => {
    const { session } = setup({ mods: true });
    const signal = new AbortController().signal;
    await session!.initialize(signal);
    const authorized = () =>
      session!.askRow('AssistantMessage', reply.props, signal, authorize);
    await expect(authorized()).resolves.toMatchObject({
      props: { text: '译文' },
    });
    await expect(
      session!.askRow('AssistantMessage', reply.props, signal),
    ).resolves.toMatchObject({
      props: { text: 'Rewritten by an installed Mod' },
    });
    await expect(authorized()).resolves.toMatchObject({
      props: { text: '译文' },
    });
    expect(mocks.translate).toHaveBeenCalledOnce();
  });

  it('drops the pending and queued translations when their transcript branch changes', async () => {
    const { session, generateText } = setup();
    const firstModelReply = deferred<{ text: string }>();
    generateText.mockReturnValueOnce(firstModelReply.promise);
    mocks.translate.mockImplementation(translateWithFakeModel);
    const signal = new AbortController().signal;
    let branch = 1;
    const authorizeFirstBranch = () => branch === 1;
    const secondReply = { ...reply.props, text: 'Another reply' };
    await session!.initialize(signal);
    const pending = session!.askRow(
      'AssistantMessage',
      reply.props,
      signal,
      authorizeFirstBranch,
    );
    try {
      await vi.waitFor(() => expect(generateText).toHaveBeenCalledOnce());
      const queued = session!.askRow(
        'AssistantMessage',
        secondReply,
        signal,
        authorizeFirstBranch,
      );
      branch++;
      firstModelReply.resolve({ text: '旧译文' });
      await expect(pending).resolves.toEqual({ status: 'unanswered' });
      await expect(queued).resolves.toEqual({ status: 'unanswered' });
      expect(generateText).toHaveBeenCalledOnce();
    } finally {
      firstModelReply.resolve({ text: '旧译文' });
    }
    await expect(
      session!.askRow('AssistantMessage', secondReply, signal, authorize),
    ).resolves.toEqual({ status: 'answered', props: translatedReply });
    expect(generateText).toHaveBeenCalledTimes(2);
  });

  it('rechecks remote authorization after preparing the model request', async () => {
    const { session, generateText } = setup();
    const parsing = deferred<void>();
    mocks.translate.mockImplementationOnce(async (...args) => {
      await parsing.promise;
      return translateWithFakeModel(...args);
    });
    const signal = new AbortController().signal;
    let authorized = true;
    await session!.initialize(signal);
    const pending = session!.askRow(
      'AssistantMessage',
      reply.props,
      signal,
      () => authorized,
    );
    try {
      await vi.waitFor(() => expect(mocks.translate).toHaveBeenCalledOnce());
      authorized = false;
    } finally {
      parsing.resolve();
    }
    await expect(pending).resolves.toEqual({ status: 'unanswered' });
    expect(generateText).not.toHaveBeenCalled();
  });

  it('rechecks authorization before starting asynchronous model routing', async () => {
    const { config, session, generateText } = setup();
    mocks.translate.mockImplementation(translateWithFakeModel);
    let authorized = true;
    config.getAllConfiguredModels.mockImplementationOnce(() => {
      queueMicrotask(() => {
        authorized = false;
      });
      return [];
    });
    const signal = new AbortController().signal;
    await session!.initialize(signal);
    await expect(
      session!.askRow(
        'AssistantMessage',
        reply.props,
        signal,
        () => authorized,
      ),
    ).resolves.toEqual({ status: 'unanswered' });
    expect(config.getAllConfiguredModels).toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
  });

  it('cancels the provider request if the recorded branch changes during routing', async () => {
    const { config, session, generateText } = setup();
    const recorder = new ChatRecordingService(config as unknown as Config);
    config.getChatRecordingService.mockReturnValue(recorder);
    mocks.translate.mockImplementation(translateWithFakeModel);
    const routingStarted = deferred<void>();
    const finishRouting = deferred<void>();
    const generateContent = vi.fn(async () => ({
      candidates: [{ content: { parts: [{ text: '译文' }] } }],
    }));
    const client = {
      config,
      async resolveForModel() {
        routingStarted.resolve();
        await finishRouting.promise;
        return {
          contentGenerator: { generateContent },
          contentGeneratorConfig: {},
          model: 'model',
        };
      },
    };
    generateText.mockImplementation((options: GenerateTextOptions) =>
      BaseLlmClient.prototype.generateText.call(client, options),
    );
    const signal = new AbortController().signal;
    const branch = recorder.getBranchGeneration();
    await session!.initialize(signal);
    const pending = session!.askRow(
      'AssistantMessage',
      reply.props,
      signal,
      () => recorder.getBranchGeneration() === branch,
    );
    await routingStarted.promise;
    recorder.rebuildTurnBoundaries([]);
    finishRouting.resolve();
    await expect(pending).resolves.toEqual({ status: 'unanswered' });
    await expect(generateText.mock.results[0].value).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(generateContent).not.toHaveBeenCalled();

    await expect(
      session!.askRow('AssistantMessage', reply.props, signal, authorize),
    ).resolves.toEqual({ status: 'answered', props: translatedReply });
    expect(generateContent).toHaveBeenCalledOnce();
  });

  it('does not return a cached translation after authorization expires', async () => {
    const { session } = setup();
    const signal = new AbortController().signal;
    await session!.initialize(signal);
    await expect(
      session!.askRow('AssistantMessage', reply.props, signal, authorize),
    ).resolves.toEqual({ status: 'answered', props: translatedReply });
    const expiringAuthorization = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);
    await expect(
      session!.askRow(
        'AssistantMessage',
        reply.props,
        signal,
        expiringAuthorization,
      ),
    ).resolves.toEqual({ status: 'unanswered' });
    expect(mocks.translate).toHaveBeenCalledOnce();
  });
});
