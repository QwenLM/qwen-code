/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AvailableModel } from '@qwen-code/qwen-code-core';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import { QWEN_SUBSCRIPTION_BASE_URL } from '@qwen-code/qwen-code-core/qwen/oauth-config.js';
import type { SubscriptionModelCatalog } from '@qwen-code/qwen-code-core/qwen/subscription-models.js';
import { QwenSubscriptionSession } from '@qwen-code/qwen-code-core/qwen/subscription-session.js';
import { SUBSCRIPTION_SIGN_IN_REQUIRED_MESSAGE } from '@qwen-code/qwen-code-core/qwen/subscription-errors.js';
import type { LoadedSettings } from '../config/settings.js';
import {
  findVoiceModels,
  getVoiceModelSelector,
  isSelectableVoiceModel,
  resolveVoiceModelTransport,
} from './voice-model.js';
import {
  isStreamingVoiceModel,
  resolveVoiceTranscriptionConfig,
  transcribeVoiceAudio,
} from './voice-transcriber.js';
import {
  listAvailableVoiceModels,
  validateWorkspaceVoiceConfig,
} from './voice-service.js';

const { request, catalog } = vi.hoisted(() => ({
  request: vi.fn(),
  catalog: vi.fn<() => SubscriptionModelCatalog>(),
}));
vi.mock('@qwen-code/qwen-code-core/qwen/subscription-request.js', () => ({
  fetchSubscriptionInference: request,
}));
vi.mock(
  '@qwen-code/qwen-code-core/qwen/subscription-models.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('@qwen-code/qwen-code-core/qwen/subscription-models.js')
    >()),
    readCachedSubscriptionCatalog: catalog,
  }),
);

const subscriptionModel: AvailableModel = {
  id: 'server-asr-model',
  label: 'Server ASR',
  authType: AuthType.QWEN_SUBSCRIPTION,
  baseUrl: QWEN_SUBSCRIPTION_BASE_URL,
  subscriptionScenes: ['voice'],
};
const apiModel: AvailableModel = {
  ...subscriptionModel,
  id: 'qwen3-asr-flash',
  authType: AuthType.USE_OPENAI,
  baseUrl: 'https://api.example/v1',
  subscriptionScenes: undefined,
};
const settings = { merged: {} } as LoadedSettings;
const lookupHost = async () => ({ address: '8.8.8.8' });

describe('subscription voice', () => {
  beforeEach(() => {
    vi.spyOn(QwenSubscriptionSession.prototype, 'isSignedIn').mockReturnValue(
      true,
    );
    catalog.mockReturnValue({ models: [] });
    request.mockReset();
    request.mockImplementation(async () =>
      Response.json({
        choices: [{ message: { content: 'transcribed text' } }],
      }),
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it('uses server voice eligibility rather than a model-name allowlist', () => {
    expect(isSelectableVoiceModel(subscriptionModel)).toBe(true);
    expect(resolveVoiceModelTransport(subscriptionModel)).toBe('qwen-asr-chat');
    expect(
      isSelectableVoiceModel({ ...subscriptionModel, subscriptionScenes: [] }),
    ).toBe(false);
  });

  it('asks to sign in for a saved account selector after logout removed the catalog', () => {
    vi.mocked(QwenSubscriptionSession.prototype.isSignedIn).mockReturnValue(
      false,
    );
    expect(() =>
      resolveVoiceTranscriptionConfig({
        config: { getAllConfiguredModels: () => [] },
        settings,
        voiceModel: 'qwen-subscription:qwen3-asr-flash',
      }),
    ).toThrow(SUBSCRIPTION_SIGN_IN_REQUIRED_MESSAGE);
    expect(() =>
      validateWorkspaceVoiceConfig(
        settings,
        'qwen-subscription:qwen3-asr-flash',
      ),
    ).toThrow(SUBSCRIPTION_SIGN_IN_REQUIRED_MESSAGE);
    expect(request).not.toHaveBeenCalled();
  });

  it('exposes both same-name routes through Serve and validates the selected account route', () => {
    catalog.mockReturnValue({
      models: [],
      scenes: { voice: [{ id: 'qwen3-asr-flash' }] },
    });
    const workspaceSettings = {
      merged: {
        modelProviders: {
          openai: [
            { id: 'qwen3-asr-flash', baseUrl: 'https://api.example/v1' },
          ],
        },
      },
    } as unknown as LoadedSettings;
    const candidates = listAvailableVoiceModels(workspaceSettings);
    expect(candidates.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        'qwen-subscription:qwen3-asr-flash',
        'openai:qwen3-asr-flash\0https://api.example/v1',
      ]),
    );
    expect(
      candidates.find(
        ({ authType }) => authType === AuthType.QWEN_SUBSCRIPTION,
      ),
    ).toMatchObject({ transport: 'qwen-asr-chat' });
    expect(
      validateWorkspaceVoiceConfig(
        workspaceSettings,
        'qwen-subscription:qwen3-asr-flash',
      ),
    ).toMatchObject({ id: 'qwen3-asr-flash', transport: 'qwen-asr-chat' });
  });

  it('resolves qualified and endpoint-pinned selectors without hiding ambiguity', () => {
    const account = { ...subscriptionModel, id: apiModel.id };
    const alternate = { ...apiModel, baseUrl: 'https://other.example/v1' };
    const models = [account, apiModel, alternate];
    expect(findVoiceModels(models, apiModel.id)).toHaveLength(3);
    expect(findVoiceModels(models, getVoiceModelSelector(account))).toEqual([
      account,
    ]);
    expect(findVoiceModels(models, getVoiceModelSelector(alternate))).toEqual([
      alternate,
    ]);
    expect(
      isStreamingVoiceModel(
        'openai:qwen3-asr-flash-realtime\0https://api.example/v1',
      ),
    ).toBe(true);
    expect(
      isStreamingVoiceModel('qwen-subscription:qwen3-asr-flash-realtime'),
    ).toBe(false);
    expect(isStreamingVoiceModel('qwen-subscription:')).toBe(false);
  });

  it('resolves account credentials independently of the main API key', () => {
    const result = resolveVoiceTranscriptionConfig({
      config: { getAllConfiguredModels: () => [subscriptionModel] },
      settings: {
        merged: { security: { auth: { apiKey: 'unrelated-main-key' } } },
      } as LoadedSettings,
      voiceModel: getVoiceModelSelector(subscriptionModel),
    });
    expect(result).toEqual({
      model: subscriptionModel.id,
      baseUrl: QWEN_SUBSCRIPTION_BASE_URL,
      subscription: true,
    });
  });

  it('sends a nonstreaming chat request with the raw model id and audio format', async () => {
    const result = await transcribeVoiceAudio(
      { data: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' },
      {
        config: { getAllConfiguredModels: () => [subscriptionModel] },
        settings,
        voiceModel: getVoiceModelSelector(subscriptionModel),
        lookupHost,
      },
    );
    expect(result).toBe('transcribed text');
    expect(request).toHaveBeenCalledTimes(1);
    const [kind, init] = request.mock.calls[0] as [string, RequestInit];
    expect(kind).toBe('chat');
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: subscriptionModel.id,
      stream: false,
      modalities: ['text'],
      messages: expect.arrayContaining([
        {
          role: 'user',
          content: [
            {
              type: 'input_audio',
              input_audio: {
                format: 'wav',
                data: 'data:audio/wav;base64,AQID',
              },
            },
          ],
        },
      ]),
    });
  });

  it('rejects encoded request bodies over 8 MiB before calling the gateway', async () => {
    await expect(
      transcribeVoiceAudio(
        { data: new Uint8Array(6 * 1024 * 1024), mimeType: 'audio/wav' },
        {
          config: { getAllConfiguredModels: () => [subscriptionModel] },
          settings,
          voiceModel: getVoiceModelSelector(subscriptionModel),
          lookupHost,
        },
      ),
    ).rejects.toThrow('max 8 MiB request');
    expect(request).not.toHaveBeenCalled();
  });
});
