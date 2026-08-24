/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockShowInputBox, mockShowQuickPick } = vi.hoisted(() => ({
  mockShowInputBox: vi.fn(),
  mockShowQuickPick: vi.fn(),
}));

vi.mock('vscode', () => ({
  window: {
    showQuickPick: mockShowQuickPick,
    showInputBox: mockShowInputBox,
  },
  QuickPickItemKind: {
    Separator: -1,
    Default: 0,
  },
}));

import { AuthMessageHandler } from './AuthMessageHandler.js';
import { AuthType, generateCustomEnvKey } from '@qwen-code/qwen-code-core';

describe('AuthMessageHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends authCancelled when the provider picker is dismissed', async () => {
    mockShowQuickPick.mockResolvedValue(undefined);
    const sendToWebView = vi.fn();
    const handler = new AuthMessageHandler(
      {} as never,
      {} as never,
      null,
      sendToWebView,
    );

    await handler.handle({ type: 'auth' });

    expect(mockShowQuickPick).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ ignoreFocusOut: true }),
    );
    expect(sendToWebView).toHaveBeenCalledWith({ type: 'authCancelled' });
  });

  it('sends authCancelled when the api key input is dismissed mid-flow', async () => {
    // First pick: select provider (coding-plan)
    // Second pick: select base URL region
    mockShowQuickPick
      .mockResolvedValueOnce({ value: 'coding-plan' })
      .mockResolvedValueOnce({
        value: 'https://coding.dashscope.aliyuncs.com/v1',
      });
    // API key input: user cancels
    mockShowInputBox.mockResolvedValue(undefined);

    const sendToWebView = vi.fn();
    const handler = new AuthMessageHandler(
      {} as never,
      {} as never,
      null,
      sendToWebView,
    );

    await handler.handle({ type: 'auth' });

    expect(mockShowInputBox).toHaveBeenCalledWith(
      expect.objectContaining({ ignoreFocusOut: true }),
    );
    expect(sendToWebView).toHaveBeenCalledWith({ type: 'authCancelled' });
  });

  it('drives a fixed-baseUrl third-party provider through to authInteractiveHandler', async () => {
    // Provider pick → DeepSeek (fixed baseUrl, models step shown)
    mockShowQuickPick.mockResolvedValueOnce({ value: 'deepseek' });
    // API key input + comma-separated model IDs
    mockShowInputBox
      .mockResolvedValueOnce('sk-deepseek')
      .mockResolvedValueOnce('deepseek-v4-flash, deepseek-v4-pro');

    const sendToWebView = vi.fn();
    const handler = new AuthMessageHandler(
      {} as never,
      {} as never,
      null,
      sendToWebView,
    );
    const authInteractiveHandler = vi.fn().mockResolvedValue(undefined);
    handler.setAuthInteractiveHandler(authInteractiveHandler);

    await handler.handle({ type: 'auth' });

    // No base URL picker should have been shown (DeepSeek baseUrl is a string)
    expect(mockShowQuickPick).toHaveBeenCalledTimes(1);
    expect(authInteractiveHandler).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'deepseek' }),
      expect.objectContaining({
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-deepseek',
        modelIds: ['deepseek-v4-flash', 'deepseek-v4-pro'],
      }),
    );
    expect(sendToWebView).not.toHaveBeenCalledWith({ type: 'authCancelled' });
  });

  it('restores proxy custom models for a non-merge provider', async () => {
    const seeded = ['deepseek-v4-pro', 'deepseek-v4-flash', 'legacy-custom'];
    const proxyCustom = {
      id: 'proxy-custom',
      name: '[DeepSeek] proxy-custom',
      baseUrl: 'https://corp-proxy.example/v1',
      envKey: 'DEEPSEEK_API_KEY',
      generationConfig: { contextWindowSize: 12345 },
    };
    const legacyCustom = {
      id: 'legacy-custom',
      name: '[DeepSeek] legacy-custom',
      envKey: 'DEEPSEEK_API_KEY',
      generationConfig: { contextWindowSize: 54321 },
    };
    mockShowQuickPick.mockResolvedValueOnce({ value: 'deepseek' });
    mockShowInputBox
      .mockResolvedValueOnce('sk-deepseek')
      .mockResolvedValueOnce(seeded.join(','));

    const handler = new AuthMessageHandler(
      {} as never,
      {} as never,
      null,
      vi.fn(),
      () => ({
        openai: [
          {
            id: 'deepseek-v4-flash',
            name: '[DeepSeek] deepseek-v4-flash',
            baseUrl: 'https://api.deepseek.com',
            envKey: 'DEEPSEEK_API_KEY',
          },
          proxyCustom,
          legacyCustom,
        ],
      }),
    );
    const authInteractiveHandler = vi.fn().mockResolvedValue(undefined);
    handler.setAuthInteractiveHandler(authInteractiveHandler);

    await handler.handle({ type: 'auth' });

    expect(mockShowInputBox.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ value: seeded.join(',') }),
    );
    expect(authInteractiveHandler).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'deepseek' }),
      expect.objectContaining({
        preserveModels: [
          proxyCustom,
          { ...legacyCustom, baseUrl: 'https://api.deepseek.com' },
        ],
      }),
    );
  });

  it('sends authError and aborts when validateApiKey rejects the key', async () => {
    // coding-plan validateApiKey requires keys starting with sk-sp-
    mockShowQuickPick
      .mockResolvedValueOnce({ value: 'coding-plan' })
      .mockResolvedValueOnce({
        value: 'https://coding.dashscope.aliyuncs.com/v1',
      });
    mockShowInputBox.mockResolvedValueOnce('not-a-coding-plan-key');

    const sendToWebView = vi.fn();
    const handler = new AuthMessageHandler(
      {} as never,
      {} as never,
      null,
      sendToWebView,
    );
    const authInteractiveHandler = vi.fn().mockResolvedValue(undefined);
    handler.setAuthInteractiveHandler(authInteractiveHandler);

    await handler.handle({ type: 'auth' });

    expect(sendToWebView).toHaveBeenCalledWith({
      type: 'authError',
      data: { message: expect.stringContaining('Coding Plan') },
    });
    expect(authInteractiveHandler).not.toHaveBeenCalled();
  });

  it('shows a baseUrl picker for providers with BaseUrlOption arrays', async () => {
    // coding-plan has baseUrl: BaseUrlOption[] (China / Singapore)
    mockShowQuickPick
      .mockResolvedValueOnce({ value: 'coding-plan' })
      .mockResolvedValueOnce({
        value: 'https://coding-intl.dashscope.aliyuncs.com/v1',
      });
    // User cancels at API key step to keep the test focused on the picker call
    mockShowInputBox.mockResolvedValueOnce(undefined);

    const sendToWebView = vi.fn();
    const handler = new AuthMessageHandler(
      {} as never,
      {} as never,
      null,
      sendToWebView,
    );

    await handler.handle({ type: 'auth' });

    // Second pick is the base URL selector; verify it was shown with the
    // BaseUrlOption entries (China + Singapore international).
    const baseUrlPickerCall = mockShowQuickPick.mock.calls[1];
    expect(baseUrlPickerCall?.[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          description: 'https://coding.dashscope.aliyuncs.com/v1',
        }),
        expect.objectContaining({
          description: 'https://coding-intl.dashscope.aliyuncs.com/v1',
        }),
      ]),
    );
  });

  it('uses endpoint-specific defaults for a multi-endpoint provider', async () => {
    mockShowQuickPick
      .mockResolvedValueOnce({ value: 'kimi' })
      .mockResolvedValueOnce({ value: 'https://api.moonshot.ai/v1' });
    mockShowInputBox
      .mockResolvedValueOnce('sk-kimi')
      .mockResolvedValueOnce(
        'kimi-k3,kimi-k2.7-code,kimi-k2.7-code-highspeed,kimi-k2.6',
      );

    const sendToWebView = vi.fn();
    const handler = new AuthMessageHandler(
      {} as never,
      {} as never,
      null,
      sendToWebView,
    );
    const authInteractiveHandler = vi.fn().mockResolvedValue(undefined);
    handler.setAuthInteractiveHandler(authInteractiveHandler);

    await handler.handle({ type: 'auth' });

    expect(mockShowInputBox.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        value: 'kimi-k3,kimi-k2.7-code,kimi-k2.7-code-highspeed,kimi-k2.6',
      }),
    );
    expect(authInteractiveHandler).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'kimi' }),
      expect.objectContaining({
        baseUrl: 'https://api.moonshot.ai/v1',
        apiKey: 'sk-kimi',
        modelIds: [
          'kimi-k3',
          'kimi-k2.7-code',
          'kimi-k2.7-code-highspeed',
          'kimi-k2.6',
        ],
      }),
    );
  });

  it('restores saved endpoint custom models into the models step', async () => {
    const codingUrl = 'https://api.kimi.com/coding/v1';
    const defaults = [
      'k3-256k',
      'k3',
      'kimi-for-coding',
      'kimi-for-coding-highspeed',
    ];
    const seeded = [...defaults, 'my-custom'];
    const savedCustom = {
      id: 'my-custom',
      name: '[Kimi Code] my-custom',
      baseUrl: codingUrl,
      envKey: 'KIMI_CODE_API_KEY',
      generationConfig: { contextWindowSize: 12345 },
    };
    mockShowQuickPick
      .mockResolvedValueOnce({ value: 'kimi' })
      .mockResolvedValueOnce({ value: codingUrl });
    mockShowInputBox
      .mockResolvedValueOnce('sk-kimi')
      .mockResolvedValueOnce(seeded.join(','));

    const sendToWebView = vi.fn();
    const handler = new AuthMessageHandler(
      {} as never,
      {} as never,
      null,
      sendToWebView,
      () => ({
        openai: [
          {
            id: 'k3-256k',
            name: '[Kimi Code] k3-256k',
            baseUrl: codingUrl,
            envKey: 'KIMI_CODE_API_KEY',
          },
          savedCustom,
          {
            ...savedCustom,
            baseUrl: `${codingUrl}/`,
            generationConfig: { contextWindowSize: 99999 },
          },
          {
            id: 'legacy-custom',
            name: '[Kimi Code] legacy-custom',
            envKey: 'KIMI_CODE_API_KEY',
          },
          {
            id: 'api-custom',
            name: '[Kimi API] api-custom',
            baseUrl: 'https://api.moonshot.ai/v1',
            envKey: 'MOONSHOT_API_KEY',
          },
        ],
      }),
    );
    const authInteractiveHandler = vi.fn().mockResolvedValue(undefined);
    handler.setAuthInteractiveHandler(authInteractiveHandler);

    await handler.handle({ type: 'auth' });

    expect(mockShowInputBox.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ value: seeded.join(',') }),
    );
    expect(authInteractiveHandler).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'kimi' }),
      expect.objectContaining({
        baseUrl: codingUrl,
        modelIds: seeded,
        preserveModels: [savedCustom],
      }),
    );
  });

  it('stamps a selected ATTRIBUTABLE baseUrl-less legacy model for a merge provider (R34-4 × R45-5)', async () => {
    // R34-4: custom-openai-compatible is mergeModelsByIdentity. A restored
    // legacy model without baseUrl must be stamped with the submitted
    // endpoint before identity merging, matching the non-merge branch and
    // the CLI/ACP/serve surfaces — otherwise buildInstallPlan writes a
    // duplicate regenerated entry and strands the rich generationConfig on
    // an orphan. R45-5: the entry must be ATTRIBUTABLE (its env key names the
    // submitted endpoint) so the install plan can claim the stored original;
    // it is then threaded through migratedLegacyModelIds for the collapse.
    const customUrl = 'https://my-proxy.example.com/v1';
    const legacyCustom = {
      id: 'legacy-custom',
      name: 'legacy-custom',
      envKey: generateCustomEnvKey(AuthType.USE_OPENAI, customUrl),
      generationConfig: { contextWindowSize: 54321 },
    };
    mockShowQuickPick
      .mockResolvedValueOnce({ value: 'custom-openai-compatible' })
      .mockResolvedValueOnce({ value: 'openai' })
      .mockResolvedValueOnce({ value: 'no' });
    mockShowInputBox
      .mockResolvedValueOnce(customUrl)
      .mockResolvedValueOnce('sk-custom-openai')
      .mockResolvedValueOnce('legacy-custom');

    const sendToWebView = vi.fn();
    const handler = new AuthMessageHandler(
      {} as never,
      {} as never,
      null,
      sendToWebView,
      () => ({ openai: [legacyCustom] }),
    );
    const authInteractiveHandler = vi.fn().mockResolvedValue(undefined);
    handler.setAuthInteractiveHandler(authInteractiveHandler);

    await handler.handle({ type: 'auth' });

    expect(authInteractiveHandler).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'custom-openai-compatible' }),
      expect.objectContaining({
        baseUrl: customUrl,
        modelIds: ['legacy-custom'],
        preserveModels: [
          expect.objectContaining({
            id: 'legacy-custom',
            baseUrl: customUrl,
            generationConfig: { contextWindowSize: 54321 },
          }),
        ],
        migratedLegacyModelIds: ['legacy-custom'],
      }),
    );
  });

  it('does NOT seed or stamp a floating baseUrl-less legacy model for a merge provider (R45-5)', async () => {
    // A floating env key (prefix-only, names NO endpoint) can never be claimed
    // by buildInstallPlan, so the wizard must not seed it (the user cannot
    // meaningfully select it) and must not stamp it — stamping it would write
    // a copy the install plan can never reconcile with the stored original, a
    // permanent duplicate. The entry is left untouched (merge ownsModel is
    // scoped, so an unclaimed entry survives).
    const customUrl = 'https://my-proxy.example.com/v1';
    const floatingCustom = {
      id: 'legacy-custom',
      name: 'legacy-custom',
      envKey: 'QWEN_CUSTOM_API_KEY_OPENAI', // prefix-only: names no endpoint
      generationConfig: { contextWindowSize: 54321 },
    };
    mockShowQuickPick
      .mockResolvedValueOnce({ value: 'custom-openai-compatible' })
      .mockResolvedValueOnce({ value: 'openai' })
      .mockResolvedValueOnce({ value: 'no' });
    mockShowInputBox
      .mockResolvedValueOnce(customUrl)
      .mockResolvedValueOnce('sk-custom-openai')
      // The floating entry is NOT seeded, so the field shows only what the
      // user types; they pick an unrelated model id.
      .mockResolvedValueOnce('some-new-model');

    const sendToWebView = vi.fn();
    const handler = new AuthMessageHandler(
      {} as never,
      {} as never,
      null,
      sendToWebView,
      () => ({ openai: [floatingCustom] }),
    );
    const authInteractiveHandler = vi.fn().mockResolvedValue(undefined);
    handler.setAuthInteractiveHandler(authInteractiveHandler);

    await handler.handle({ type: 'auth' });

    const inputs = authInteractiveHandler.mock.calls[0][1] as {
      modelIds: string[];
      preserveModels?: Array<Record<string, unknown>>;
      migratedLegacyModelIds?: string[];
    };
    // The floating id is neither seeded (not in modelIds) nor preserved/stamped.
    expect(inputs.modelIds).not.toContain('legacy-custom');
    expect(inputs.preserveModels ?? []).toEqual([]);
    expect(inputs.migratedLegacyModelIds).toBeUndefined();
  });

  it('carries a fail-closed shared-key baseUrl-less entry through UNSTAMPED on a non-merge provider (R45-4)', async () => {
    // minimax is non-merge, array-baseUrl, and shares ONE static env key
    // (MINIMAX_API_KEY) across both region endpoints. A baseUrl-less legacy
    // entry carrying it fails attribution CLOSED (namesSelectedEndpoint false,
    // namesSiblingEndpoint true), so the wizard must neither seed it nor stamp
    // it: a non-merge plan carries the provider's UNSCOPED ownsModel, so
    // stamping would re-home it to the picked region and dropping it would
    // delete it. Carry it through UNSTAMPED — mirroring ACP/serve/CLI (R45-4).
    const failClosed = {
      id: 'my-model',
      name: '[MiniMax] my-model',
      envKey: 'MINIMAX_API_KEY',
    };
    mockShowQuickPick
      .mockResolvedValueOnce({ value: 'minimax' })
      .mockResolvedValueOnce({ value: 'https://api.minimaxi.com/v1' });
    mockShowInputBox
      .mockResolvedValueOnce('sk-minimax')
      .mockResolvedValueOnce('MiniMax-M3');

    const sendToWebView = vi.fn();
    const handler = new AuthMessageHandler(
      {} as never,
      {} as never,
      null,
      sendToWebView,
      () => ({ openai: [failClosed] }),
    );
    const authInteractiveHandler = vi.fn().mockResolvedValue(undefined);
    handler.setAuthInteractiveHandler(authInteractiveHandler);

    await handler.handle({ type: 'auth' });

    const inputs = authInteractiveHandler.mock.calls[0][1] as {
      modelIds: string[];
      preserveModels?: Array<Record<string, unknown>>;
    };
    // The fail-closed entry is NOT seeded (not offered in the models field)...
    expect(inputs.modelIds).not.toContain('my-model');
    // ...and is carried through UNSTAMPED (no baseUrl added) so the install's
    // unscoped ownsModel writes it back byte-identical instead of re-homing or
    // deleting it.
    expect(inputs.preserveModels).toEqual([failClosed]);
  });

  // -- Custom provider flow ------------------------------------------------
  // The custom provider exercises every step in runProviderSetupFlow:
  // protocol pick, free-form URL input + scheme validation, API key,
  // comma-split model IDs + empty-input guard, and advanced config.

  it('drives custom provider through protocol + url + key + models + advanced', async () => {
    const customUrl = 'https://my-proxy.example.com/v1';
    // 1) Provider pick → custom (custom-openai-compatible)
    // 2) Protocol pick → Anthropic
    // 3) Advanced config pick → modality-only (no thinking)
    mockShowQuickPick
      .mockResolvedValueOnce({ value: 'custom-openai-compatible' })
      .mockResolvedValueOnce({ value: 'anthropic' })
      .mockResolvedValueOnce({ value: 'no' });
    // URL → API key → model IDs (advanced is a separate pick already mocked)
    mockShowInputBox
      .mockResolvedValueOnce(customUrl)
      .mockResolvedValueOnce('sk-custom-anthropic')
      .mockResolvedValueOnce('claude-3-opus, claude-3-sonnet');

    const sendToWebView = vi.fn();
    const handler = new AuthMessageHandler(
      {} as never,
      {} as never,
      null,
      sendToWebView,
      () => ({
        openai: [
          {
            id: 'openai-saved',
            baseUrl: customUrl,
            envKey: 'QWEN_CUSTOM_API_KEY_OPENAI',
          },
        ],
        anthropic: [
          {
            id: 'anthropic-saved',
            baseUrl: customUrl,
            envKey: 'QWEN_CUSTOM_API_KEY_ANTHROPIC',
          },
        ],
      }),
    );
    const authInteractiveHandler = vi.fn().mockResolvedValue(undefined);
    handler.setAuthInteractiveHandler(authInteractiveHandler);

    await handler.handle({ type: 'auth' });

    expect(authInteractiveHandler).toHaveBeenCalledTimes(1);
    expect(mockShowInputBox.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({ value: 'anthropic-saved' }),
    );
    const [providerConfig, inputs] = authInteractiveHandler.mock.calls[0]!;
    expect(providerConfig.id).toBe('custom-openai-compatible');
    expect(inputs).toMatchObject({
      // Protocol from the picker is threaded through.
      protocol: 'anthropic',
      baseUrl: customUrl,
      apiKey: 'sk-custom-anthropic',
      modelIds: ['claude-3-opus', 'claude-3-sonnet'],
    });
  });

  it('rejects a non-http(s) custom base URL with authError', async () => {
    mockShowQuickPick
      .mockResolvedValueOnce({ value: 'custom-openai-compatible' })
      .mockResolvedValueOnce({ value: 'openai' });
    // file:// URL must be rejected before reaching authInteractiveHandler.
    mockShowInputBox.mockResolvedValueOnce('file:///etc/passwd');

    const sendToWebView = vi.fn();
    const handler = new AuthMessageHandler(
      {} as never,
      {} as never,
      null,
      sendToWebView,
    );
    const authInteractiveHandler = vi.fn().mockResolvedValue(undefined);
    handler.setAuthInteractiveHandler(authInteractiveHandler);

    await handler.handle({ type: 'auth' });

    expect(sendToWebView).toHaveBeenCalledWith({
      type: 'authError',
      data: { message: expect.stringContaining('http') },
    });
    expect(authInteractiveHandler).not.toHaveBeenCalled();
  });

  it('falls back to the protocol-specific default when custom URL input is blank', async () => {
    // User picks Anthropic protocol and hits Enter on the URL with no input.
    mockShowQuickPick
      .mockResolvedValueOnce({ value: 'custom-openai-compatible' })
      .mockResolvedValueOnce({ value: 'anthropic' })
      .mockResolvedValueOnce({ value: 'no' });
    mockShowInputBox
      .mockResolvedValueOnce('') // blank URL → fallback to Anthropic default
      .mockResolvedValueOnce('sk-anthropic')
      .mockResolvedValueOnce('claude-3-opus');

    const sendToWebView = vi.fn();
    const handler = new AuthMessageHandler(
      {} as never,
      {} as never,
      null,
      sendToWebView,
    );
    const authInteractiveHandler = vi.fn().mockResolvedValue(undefined);
    handler.setAuthInteractiveHandler(authInteractiveHandler);

    await handler.handle({ type: 'auth' });

    expect(authInteractiveHandler).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'custom-openai-compatible' }),
      expect.objectContaining({
        // Empty input resolved to Anthropic's default, not the OpenAI one.
        baseUrl: 'https://api.anthropic.com/v1',
        protocol: 'anthropic',
      }),
    );
  });

  it('rejects whitespace-only model IDs with authError', async () => {
    mockShowQuickPick
      .mockResolvedValueOnce({ value: 'custom-openai-compatible' })
      .mockResolvedValueOnce({ value: 'openai' });
    mockShowInputBox
      .mockResolvedValueOnce('https://api.example.com/v1')
      .mockResolvedValueOnce('sk-test')
      // Only whitespace + commas — must not reach authInteractiveHandler.
      .mockResolvedValueOnce(' , , ,');

    const sendToWebView = vi.fn();
    const handler = new AuthMessageHandler(
      {} as never,
      {} as never,
      null,
      sendToWebView,
    );
    const authInteractiveHandler = vi.fn().mockResolvedValue(undefined);
    handler.setAuthInteractiveHandler(authInteractiveHandler);

    await handler.handle({ type: 'auth' });

    expect(sendToWebView).toHaveBeenCalledWith({
      type: 'authError',
      data: { message: expect.stringContaining('Model IDs') },
    });
    expect(authInteractiveHandler).not.toHaveBeenCalled();
  });

  it('does not send authCancelled after a validation authError (would clear the message)', async () => {
    // Pick custom + openai, then enter a non-http(s) URL → scheme validation
    // fails. The webview clears the error on authCancelled, so a validation
    // failure must send ONLY authError, never a trailing authCancelled.
    mockShowQuickPick
      .mockResolvedValueOnce({ value: 'custom-openai-compatible' })
      .mockResolvedValueOnce({ value: 'openai' });
    mockShowInputBox.mockResolvedValueOnce('file:///etc/passwd');

    const sendToWebView = vi.fn();
    const handler = new AuthMessageHandler(
      {} as never,
      {} as never,
      null,
      sendToWebView,
    );
    handler.setAuthInteractiveHandler(vi.fn().mockResolvedValue(undefined));

    await handler.handle({ type: 'auth' });

    const types = sendToWebView.mock.calls.map((c) => c[0]?.type);
    expect(types).toContain('authError');
    expect(types).not.toContain('authCancelled');
  });
});
