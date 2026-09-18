/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Settings } from '../../config/settings.js';
import { LiveHostCoordinator } from './live-host-coordinator.js';
import { LiveHostInstaller } from './live-host-installer.js';
import { LiveSetupController } from './live-setup-controller.js';
import { LIVE_HOST_PROTOCOL_VERSION } from './types.js';

function createHarness(
  options: {
    initiallyEnabled?: boolean;
    modelProviders?: Record<string, unknown[]>;
    env?: Record<string, string | undefined>;
  } = {},
) {
  const initiallyEnabled = options.initiallyEnabled ?? false;
  let settings = {
    experimental: {
      liveVoice: {
        enabled: initiallyEnabled,
        shortcut: 'Command+E',
      },
    },
    ...(options.modelProviders
      ? { modelProviders: options.modelProviders }
      : {}),
  } as unknown as Settings;
  let enabled = initiallyEnabled;
  const persistSettings = vi.fn(async (writes) => {
    const liveVoice = { ...settings.experimental?.liveVoice };
    for (const write of writes) {
      const property = write.key.split('.').at(-1)!;
      if (write.value === undefined)
        delete (liveVoice as Record<string, unknown>)[property];
      else (liveVoice as Record<string, unknown>)[property] = write.value;
    }
    settings = {
      ...settings,
      experimental: { ...settings.experimental, liveVoice },
    } as Settings;
  });
  const validateCredential = vi.fn(async () => {});
  const setEnabled = vi.fn(async (next: boolean) => {
    enabled = next;
  });
  const installLatest = vi.fn(async () => ({
    version: '0.1.0',
    protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
  }));
  const installer = new LiveHostInstaller({
    platform: 'darwin',
    architecture: 'arm64',
    inspectInstalled: async () => undefined,
    installLatest,
    launch: async () => {},
  });
  const coordinator = new LiveHostCoordinator({
    getProviderReadiness: () =>
      enabled ? { state: 'ready' } : { state: 'unavailable' },
  });
  const controller = new LiveSetupController({
    loadSettings: () => settings,
    persistSettings,
    coordinator,
    installer,
    getEnabled: () => enabled,
    setEnabled,
    validateCredential,
    ...(options.env ? { env: options.env } : {}),
  });
  return {
    controller,
    persistSettings,
    validateCredential,
    setEnabled,
    installLatest,
    settings: () => settings,
  };
}

describe('LiveSetupController', () => {
  it('does not install the Host while reading an enabled setup', async () => {
    const harness = createHarness({ initiallyEnabled: true });

    await harness.controller.getStatus();
    await Promise.resolve();

    expect(harness.installLatest).not.toHaveBeenCalled();
  });

  it('validates, persists, hot-enables, and starts installation', async () => {
    const harness = createHarness();
    const status = await harness.controller.update({
      enabled: true,
      shortcut: 'Command+K',
      apiKey: { operation: 'replace', value: 'realtime-secret' },
    });

    expect(harness.validateCredential).toHaveBeenCalledOnce();
    expect(harness.persistSettings).toHaveBeenCalledOnce();
    expect(harness.setEnabled).toHaveBeenCalledWith(true);
    expect(status).toMatchObject({
      enabled: true,
      keyConfigured: true,
      shortcut: 'Command+K',
    });
    expect(JSON.stringify(status)).not.toContain('realtime-secret');
    expect(harness.settings().experimental?.liveVoice?.apiKey).toBe(
      'realtime-secret',
    );
    await vi.waitFor(() =>
      expect(harness.installLatest).toHaveBeenCalledOnce(),
    );
  });

  it('does not persist or enable when credential validation fails', async () => {
    const harness = createHarness();
    harness.validateCredential.mockRejectedValueOnce(new Error('Invalid key'));

    await expect(
      harness.controller.update({
        enabled: true,
        apiKey: { operation: 'replace', value: 'bad-secret' },
      }),
    ).rejects.toMatchObject({
      code: 'live_provider_validation_failed',
      status: 409,
    });
    expect(harness.persistSettings).not.toHaveBeenCalled();
    expect(harness.setEnabled).not.toHaveBeenCalled();
  });

  it('requires a dedicated key before enablement', async () => {
    const harness = createHarness();
    await expect(
      harness.controller.update({ enabled: true }),
    ).rejects.toMatchObject({
      code: 'live_api_key_required',
      status: 400,
    });
    expect(harness.validateCredential).not.toHaveBeenCalled();
    expect(harness.persistSettings).not.toHaveBeenCalled();
    expect(harness.setEnabled).not.toHaveBeenCalled();
  });

  it('persists a replacement key without opening a provider connection', async () => {
    const harness = createHarness();

    await harness.controller.update({
      apiKey: { operation: 'replace', value: 'realtime-secret' },
    });

    expect(harness.validateCredential).not.toHaveBeenCalled();
    expect(harness.settings().experimental?.liveVoice?.apiKey).toBe(
      'realtime-secret',
    );
  });

  it('validates a replacement key before changing an enabled setup', async () => {
    const harness = createHarness();
    await harness.controller.update({
      enabled: true,
      apiKey: { operation: 'replace', value: 'realtime-secret' },
    });
    harness.validateCredential.mockRejectedValueOnce(new Error('Invalid key'));

    await expect(
      harness.controller.update({
        apiKey: { operation: 'replace', value: 'bad-secret' },
      }),
    ).rejects.toMatchObject({ code: 'live_provider_validation_failed' });
    expect(harness.settings().experimental?.liveVoice?.apiKey).toBe(
      'realtime-secret',
    );
  });

  it('hot-disables without uninstalling the Host', async () => {
    const harness = createHarness();
    await harness.controller.update({
      enabled: true,
      apiKey: { operation: 'replace', value: 'realtime-secret' },
    });
    await harness.controller.update({ enabled: false });

    expect(harness.setEnabled).toHaveBeenLastCalledWith(false);
    expect(harness.installLatest).toHaveBeenCalledOnce();
    expect(await harness.controller.getStatus()).toMatchObject({
      enabled: false,
      keyConfigured: true,
    });
  });

  describe('realtimeOnly routes', () => {
    const route = {
      id: 'qwen3.5-omni-plus-realtime',
      name: 'Omni Realtime',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      envKey: 'DASHSCOPE_API_KEY',
      realtimeOnly: true,
    };
    const chat = { id: 'qwen3.8-max', envKey: 'DASHSCOPE_API_KEY' };

    it('lists only realtime routes as choices and reports the route key', async () => {
      const harness = createHarness({
        modelProviders: { openai: [chat, route] },
        env: { DASHSCOPE_API_KEY: 'env-secret' },
      });
      const status = await harness.controller.getStatus();
      expect(status.models).toEqual([
        { id: route.id, provider: 'openai', name: 'Omni Realtime' },
      ]);
      expect(status.voice).toBe('Tina');
      // The default model id matches the route, so its envKey decides.
      expect(status.keyConfigured).toBe(true);
    });

    it('reports no usable key when the route variable is unset', async () => {
      const harness = createHarness({
        modelProviders: { openai: [route] },
        env: {},
      });
      expect((await harness.controller.getStatus()).keyConfigured).toBe(false);
    });

    it('enables through a route without any liveVoice.apiKey', async () => {
      const harness = createHarness({
        modelProviders: { openai: [route] },
        env: { DASHSCOPE_API_KEY: 'env-secret' },
      });
      await harness.controller.update({ enabled: true });
      expect(harness.validateCredential).toHaveBeenCalledWith(
        expect.objectContaining({
          endpoint: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
          realtimeModel: route.id,
        }),
      );
      expect(harness.persistSettings).toHaveBeenCalledWith([
        expect.objectContaining({
          key: 'experimental.liveVoice.enabled',
          value: true,
        }),
      ]);
    });

    it('still demands liveVoice.apiKey when the model names no route', async () => {
      const harness = createHarness({
        modelProviders: { openai: [chat] },
        env: { DASHSCOPE_API_KEY: 'env-secret' },
      });
      await expect(
        harness.controller.update({ enabled: true }),
      ).rejects.toMatchObject({ code: 'live_api_key_required' });
    });

    it('validates a model or voice change against the provider before saving', async () => {
      const harness = createHarness({
        initiallyEnabled: true,
        modelProviders: { openai: [route] },
        env: { DASHSCOPE_API_KEY: 'env-secret' },
      });
      await harness.controller.update({ voice: 'Ethan' });
      expect(harness.validateCredential).toHaveBeenCalledWith(
        expect.objectContaining({ voice: 'Ethan' }),
      );
      expect(harness.settings().experimental?.liveVoice).toMatchObject({
        voice: 'Ethan',
      });

      harness.validateCredential.mockRejectedValueOnce(
        new Error('model not found'),
      );
      await expect(
        harness.controller.update({
          model: `openai:${route.id}`,
          voice: 'Nope',
        }),
      ).rejects.toMatchObject({ code: 'live_provider_validation_failed' });
      expect(harness.settings().experimental?.liveVoice).toMatchObject({
        voice: 'Ethan',
      });
    });

    it('rejects a route that cannot produce a credential', async () => {
      const harness = createHarness({
        initiallyEnabled: true,
        modelProviders: {
          openai: [{ ...route, baseUrl: 'https://gateway.example.com/v1' }],
        },
        env: { DASHSCOPE_API_KEY: 'env-secret' },
      });
      await expect(
        harness.controller.update({ voice: 'Ethan' }),
      ).rejects.toMatchObject({ code: 'invalid_live_model', status: 400 });
      expect(harness.validateCredential).not.toHaveBeenCalled();
      expect(harness.persistSettings).not.toHaveBeenCalled();
    });
  });
});
