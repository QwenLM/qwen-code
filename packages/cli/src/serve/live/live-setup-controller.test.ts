/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import type { Settings } from '../../config/settings.js';
import { LiveHostCoordinator } from './live-host-coordinator.js';
import { LiveHostInstaller } from './live-host-installer.js';
import { LiveSetupController } from './live-setup-controller.js';
import {
  LIVE_HOST_PROTOCOL_VERSION,
  LIVE_WEB_HOST_BUNDLE_ID,
} from './types.js';

function createHarness(
  options: {
    initiallyEnabled?: boolean;
    apiKey?: string;
    endpoint?: string;
    modelProviders?: Record<string, unknown[]>;
    env?: Record<string, string | undefined>;
    nativeHost?: boolean;
  } = {},
) {
  const initiallyEnabled = options.initiallyEnabled ?? false;
  let settings = {
    experimental: {
      liveVoice: {
        enabled: initiallyEnabled,
        shortcut: 'Command+E',
        ...(options.apiKey ? { apiKey: options.apiKey } : {}),
        ...(options.endpoint ? { endpoint: options.endpoint } : {}),
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
  const inspectInstalled = vi.fn(async () => undefined);
  const launch = vi.fn(async () => {});
  const installer = new LiveHostInstaller({
    platform: 'darwin',
    architecture: 'arm64',
    inspectInstalled,
    installLatest,
    launch,
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
    ...(options.nativeHost !== undefined
      ? { nativeHost: options.nativeHost }
      : {}),
  });
  return {
    controller,
    persistSettings,
    validateCredential,
    setEnabled,
    installLatest,
    inspectInstalled,
    launch,
    settings: () => settings,
    coordinator,
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

    it('says where the key comes from, naming the variable but never its value', async () => {
      const routed = createHarness({
        modelProviders: { openai: [route] },
        env: { DASHSCOPE_API_KEY: 'env-secret' },
      });
      const status = await routed.controller.getStatus();
      expect(status).toMatchObject({
        keySource: 'route',
        keyEnv: 'DASHSCOPE_API_KEY',
      });
      expect(JSON.stringify(status)).not.toContain('env-secret');

      const legacy = createHarness({ modelProviders: { openai: [chat] } });
      const legacyStatus = await legacy.controller.getStatus();
      expect(legacyStatus.keySource).toBe('settings');
      expect(legacyStatus.keyEnv).toBeUndefined();
      expect(legacyStatus.modelError).toBeUndefined();
    });

    it('reports an unresolvable model instead of only "no key"', async () => {
      const harness = createHarness({
        modelProviders: { openai: [route], 'dashscope-intl': [route] },
        env: { DASHSCOPE_API_KEY: 'env-secret' },
      });
      const status = await harness.controller.getStatus();
      expect(status.modelError).toMatch(/more than one realtimeOnly route/);
      expect(status.keyConfigured).toBe(false);
      expect(status.keySource).toBe('settings');
    });

    it('reports no usable key when the route variable is unset', async () => {
      const harness = createHarness({
        modelProviders: { openai: [route] },
        env: {},
      });
      const status = await harness.controller.getStatus();
      expect(status.keyConfigured).toBe(false);
      // An unset variable is the one cause the card explains on its own
      // ("not set"), so it is not also reported as a route defect.
      expect(status.keyError).toBeUndefined();
      expect(status.storedKey).toBe(false);
    });

    it('reports why a route without envKey cannot produce a credential', async () => {
      const harness = createHarness({
        modelProviders: { openai: [{ id: route.id, realtimeOnly: true }] },
        env: { DASHSCOPE_API_KEY: 'env-secret' },
      });
      const status = await harness.controller.getStatus();
      expect(status.keyConfigured).toBe(false);
      // No variable to blame: the route itself is incomplete.
      expect(status.keyEnv).toBeUndefined();
      expect(status.keyError).toMatch(/must declare baseUrl and envKey/);
    });

    it('keeps a stored key reported and revocable while the model is ambiguous', async () => {
      const harness = createHarness({
        apiKey: 'stored-clear-text',
        modelProviders: { openai: [route], 'dashscope-intl': [route] },
        env: { DASHSCOPE_API_KEY: 'env-secret' },
      });
      const status = await harness.controller.getStatus();
      expect(status.modelError).toMatch(/more than one realtimeOnly route/);
      expect(status.keyConfigured).toBe(false);
      expect(status.storedKey).toBe(true);
      expect(JSON.stringify(status)).not.toContain('stored-clear-text');

      // The unusable model refuses `replace`, but `clear` must keep working.
      await harness.controller.update({ apiKey: { operation: 'clear' } });
      expect((await harness.controller.getStatus()).storedKey).toBe(false);
    });

    it('reports a stored key alongside a route key, still revocable', async () => {
      const harness = createHarness({
        apiKey: 'stored-clear-text',
        modelProviders: { openai: [route] },
        env: { DASHSCOPE_API_KEY: 'env-secret' },
      });
      const status = await harness.controller.getStatus();
      expect(status.keySource).toBe('route');
      expect(status.keyConfigured).toBe(true);
      expect(status.storedKey).toBe(true);

      await harness.controller.update({ apiKey: { operation: 'clear' } });
      expect((await harness.controller.getStatus()).storedKey).toBe(false);
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

    it('still turns off and rebinds the shortcut while the route is ambiguous', async () => {
      const harness = createHarness({
        initiallyEnabled: true,
        // Bare default id under two providers: unresolvable.
        modelProviders: { openai: [route], 'dashscope-intl': [route] },
        env: { DASHSCOPE_API_KEY: 'env-secret' },
      });

      await expect(
        harness.controller.update({ voice: 'Ethan' }),
      ).rejects.toMatchObject({ code: 'invalid_live_model', status: 400 });

      await harness.controller.update({ shortcut: 'Command+L' });
      expect(harness.settings().experimental?.liveVoice).toMatchObject({
        shortcut: 'Command+L',
      });
      await harness.controller.update({ enabled: false });
      expect(harness.setEnabled).toHaveBeenLastCalledWith(false);
      expect(harness.settings().experimental?.liveVoice).toMatchObject({
        enabled: false,
      });
      expect(harness.validateCredential).not.toHaveBeenCalled();
    });

    it('refuses to store a key the selected route would never use', async () => {
      const harness = createHarness({
        initiallyEnabled: true,
        modelProviders: { openai: [route] },
        env: { DASHSCOPE_API_KEY: 'env-secret' },
      });
      await expect(
        harness.controller.update({
          apiKey: { operation: 'replace', value: 'unverifiable-secret' },
        }),
      ).rejects.toMatchObject({ code: 'live_api_key_unused', status: 400 });
      // Validating against the route's key would pass and prove nothing.
      expect(harness.validateCredential).not.toHaveBeenCalled();
      expect(harness.persistSettings).not.toHaveBeenCalled();
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

      // The status names the real cause; blaming the environment variable
      // (which is set) would send the user to the wrong fix.
      const status = await harness.controller.getStatus();
      expect(status.keyConfigured).toBe(false);
      expect(status.keyError).toMatch(/supported secure DashScope/);
      expect(JSON.stringify(status)).not.toContain('env-secret');
    });
  });

  it('saves a shortcut change while a browser Host holds the lease', async () => {
    const harness = createHarness();
    harness.coordinator.setAppshotReadiness({ state: 'ready' });
    const socket = Object.assign(new EventEmitter(), {
      readyState: WebSocket.OPEN as number,
      bufferedAmount: 0,
      sent: [] as string[],
      send(data: string | Uint8Array) {
        if (typeof data === 'string') this.sent.push(data);
      },
      close() {},
    });
    harness.coordinator.attachBrowserHost(socket as unknown as WebSocket);
    socket.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'host.hello',
          protocolVersion: LIVE_HOST_PROTOCOL_VERSION,
          hostVersion: '0.24.0',
          bundleId: LIVE_WEB_HOST_BUNDLE_ID,
          instanceNonce: 'browser_tab_nonce_0001',
          permissions: { microphone: 'granted' },
          selfChecks: { audioInput: true, audioOutput: true },
        }),
      ),
      false,
    );
    expect(harness.coordinator.getStatus().host).toMatchObject({
      kind: 'browser',
    });

    // Used to surface as a 500: the native shortcut round trip rejected
    // with an error the setup route does not map.
    const status = await harness.controller.update({ shortcut: 'Alt+Space' });

    expect(status.shortcut).toBe('Alt+Space');
    expect(harness.settings().experimental?.liveVoice).toMatchObject({
      shortcut: 'Alt+Space',
    });
    expect(socket.sent.join('')).not.toContain('host.set_shortcut');
    harness.coordinator.dispose();
  });

  describe('without the native Host', () => {
    it('neither probes nor installs, and reports why', async () => {
      const harness = createHarness({ nativeHost: false });
      const status = await harness.controller.update({
        enabled: true,
        apiKey: { operation: 'replace', value: 'realtime-secret' },
      });
      await Promise.resolve();

      expect(status).toMatchObject({
        enabled: true,
        nativeHost: false,
        install: { state: 'error', retryable: false },
      });
      expect(harness.inspectInstalled).not.toHaveBeenCalled();
      expect(harness.installLatest).not.toHaveBeenCalled();
    });

    it.each(['retryInstall', 'launchHost'] as const)(
      'refuses %s',
      async (method) => {
        const harness = createHarness({
          initiallyEnabled: true,
          apiKey: 'realtime-secret',
          nativeHost: false,
        });
        await expect(harness.controller[method]()).rejects.toMatchObject({
          code: 'live_native_host_unavailable',
          status: 409,
        });
        expect(harness.installLatest).not.toHaveBeenCalled();
        expect(harness.launch).not.toHaveBeenCalled();
      },
    );
  });

  describe('endpoint', () => {
    const intlBase = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
    const intlRealtime = 'wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime';

    it('reports an empty endpoint while the default is in use', async () => {
      const harness = createHarness({ apiKey: 'realtime-secret' });
      const status = await harness.controller.getStatus();
      expect(status.endpoint).toBe('');
      expect(status.endpointError).toBeUndefined();
    });

    it('reports a stored base URL as entered', async () => {
      const harness = createHarness({ endpoint: intlBase });
      const status = await harness.controller.getStatus();
      expect(status.endpoint).toBe(intlBase);
      expect(status.endpointError).toBeUndefined();
    });

    it('names a stored endpoint that a call would refuse, by the field', async () => {
      const harness = createHarness({
        endpoint: 'https://example.com/compatible-mode/v1',
      });
      const status = await harness.controller.getStatus();
      expect(status.endpointError).toMatch(/^The endpoint must be a DashScope/);
      expect(status.endpointError).not.toContain('experimental.liveVoice');
    });

    it('stores a base URL as entered', async () => {
      const harness = createHarness({ apiKey: 'realtime-secret' });
      const status = await harness.controller.update({
        endpoint:
          '  https://llm-abc.cn-beijing.maas.aliyuncs.com/compatible-mode/v1 ',
      });

      expect(harness.settings().experimental?.liveVoice?.endpoint).toBe(
        'https://llm-abc.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      );
      expect(status.endpoint).toBe(
        'https://llm-abc.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      );
      // Live is off: nothing to validate until it is turned on.
      expect(harness.validateCredential).not.toHaveBeenCalled();
    });

    it('restores the default when the endpoint is cleared', async () => {
      const harness = createHarness({ endpoint: intlBase });
      const status = await harness.controller.update({ endpoint: '' });
      expect(
        harness.settings().experimental?.liveVoice?.endpoint,
      ).toBeUndefined();
      expect(status.endpoint).toBe('');
    });

    it('refuses a host outside the DashScope allow-list without writing', async () => {
      const harness = createHarness({ apiKey: 'realtime-secret' });
      await expect(
        harness.controller.update({
          endpoint: 'https://example.com/compatible-mode/v1',
        }),
      ).rejects.toMatchObject({ code: 'invalid_live_endpoint', status: 400 });
      expect(harness.persistSettings).not.toHaveBeenCalled();
    });

    it('validates a new endpoint with a new key together while Live is on', async () => {
      const harness = createHarness({
        initiallyEnabled: true,
        apiKey: 'old-secret',
      });
      await harness.controller.update({
        endpoint: intlBase,
        apiKey: { operation: 'replace', value: 'intl-secret' },
      });

      expect(harness.validateCredential).toHaveBeenCalledOnce();
      const [[credential]] = harness.validateCredential.mock
        .calls as unknown as Array<[{ endpoint: string; apiKey: string }]>;
      expect(credential.endpoint).toBe(intlRealtime);
      expect(credential.apiKey).toBe('intl-secret');
      expect(harness.settings().experimental?.liveVoice).toMatchObject({
        endpoint: intlBase,
        apiKey: 'intl-secret',
      });
    });

    it('does not revalidate when the same endpoint is saved in another form', async () => {
      const harness = createHarness({
        initiallyEnabled: true,
        apiKey: 'intl-secret',
        endpoint: intlRealtime,
      });
      await harness.controller.update({ endpoint: intlBase });
      expect(harness.validateCredential).not.toHaveBeenCalled();
      expect(harness.settings().experimental?.liveVoice?.endpoint).toBe(
        intlBase,
      );
    });

    it('keeps the old endpoint when the new one fails validation', async () => {
      const harness = createHarness({
        initiallyEnabled: true,
        apiKey: 'beijing-secret',
      });
      harness.validateCredential.mockRejectedValueOnce(
        new Error('Realtime provider rejected the WebSocket upgrade (401).'),
      );
      await expect(
        harness.controller.update({ endpoint: intlBase }),
      ).rejects.toMatchObject({
        code: 'live_provider_validation_failed',
        status: 409,
      });
      expect(harness.persistSettings).not.toHaveBeenCalled();
    });

    it('reports the route base URL and refuses an endpoint for a routed model', async () => {
      const harness = createHarness({
        modelProviders: {
          openai: [
            {
              id: 'qwen3.5-omni-plus-realtime',
              baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
              envKey: 'DASHSCOPE_API_KEY',
              realtimeOnly: true,
            },
          ],
        },
        env: { DASHSCOPE_API_KEY: 'env-secret' },
      });
      expect(await harness.controller.getStatus()).toMatchObject({
        keySource: 'route',
        endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      });
      await expect(
        harness.controller.update({ endpoint: intlBase }),
      ).rejects.toMatchObject({ code: 'live_endpoint_unused', status: 400 });
      expect(harness.persistSettings).not.toHaveBeenCalled();
    });
  });
});
