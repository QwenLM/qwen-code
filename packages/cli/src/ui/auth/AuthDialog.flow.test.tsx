/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import {
  QWENCLOUD_PRESETS,
  customProviderPreset,
  providerIdForPreset,
  type Config,
} from '@qwen-code/core';
import type { LoadedSettings } from '../../config/settings.js';
import { renderWithProviders } from '../../test-utils/render.js';
import { AuthDialog } from './AuthDialog.js';
import { figures } from '../utils/figures.js';

async function press(view: { stdin: { write: (value: string) => void }; waitUntilReady: () => Promise<void> }, value: string) {
  await act(async () => {
    view.stdin.write(value);
  });
  await view.waitUntilReady();
  await new Promise((resolve) => setTimeout(resolve, 120));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AuthDialog custom provider flow', () => {
  it('accepts base URL and API key input', async () => {
    const config = {
      isBrowserLaunchSuppressed: () => true,
      getModelProviderManager: () => ({ listModels: async () => [] }),
    } as unknown as Config;
    const settings = {
      merged: { security: { auth: {} } },
      setValue: vi.fn(() => true),
    } as unknown as LoadedSettings;
    const view = await renderWithProviders(
      <AuthDialog
        config={config}
        settings={settings}
        canClose
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
      { width: 120 },
    );
    await view.waitUntilReady();

    try {
      // Main → Custom Provider (last item).
      for (let i = 0; i < 5; i++) await press(view, '\u001b[B');
      await press(view, '\r');
      // Protocol → OpenAI-compatible, then Chat Completions.
      await press(view, '\r');
      await press(view, '\r');
      // Base URL input.
      for (const char of 'https://example.test/v1') {
        await press(view, char);
      }
      await press(view, '\r');
      expect(view.lastFrame()).toContain('Step 4/7 · API Key');
      // API key input.
      for (const char of 'key-1') await press(view, char);
      await press(view, '\r');
      expect(view.lastFrame()).toContain('Step 5/7 · Model IDs');
    } finally {
      view.unmount();
    }
  });

  it('writes openai-responses when Responses is selected', async () => {
    const config = {
      isBrowserLaunchSuppressed: () => true,
      getModelProviderManager: () => ({ listModels: async () => [] }),
      reloadModelConfigFromDisk: vi.fn(async () => {}),
      getCustomProvidersState: vi.fn(async () => ({})),
      setModel: vi.fn(async () => true),
    } as unknown as Config;
    const settings = {
      merged: { security: { auth: {} } },
      setValue: vi.fn(() => true),
    } as unknown as LoadedSettings;
    const view = await renderWithProviders(
      <AuthDialog
        config={config}
        settings={settings}
        canClose
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
      { width: 120 },
    );
    await view.waitUntilReady();

    try {
      for (let i = 0; i < 5; i++) await press(view, '\u001b[B');
      await press(view, '\r');
      await press(view, '\r');
      expect(view.lastFrame()).toContain('Step 2/7 · API');
      // Wire API → Responses.
      await press(view, '\u001b[B');
      await press(view, '\r');
      expect(view.lastFrame()).toContain('Step 3/7 · Base URL');
      for (const char of 'https://example.test/v1') await press(view, char);
      await press(view, '\r');
      for (const char of 'key-1') await press(view, char);
      await press(view, '\r');
      for (const char of 'm1') await press(view, char);
      await press(view, '\r');
      expect(view.lastFrame()).toContain('Step 6/7 · Advanced');
      // Advanced config → review.
      await press(view, '\r');
      expect(view.lastFrame()).toContain('Step 7/7 · Review');
      await press(view, '\r');
      await view.waitUntilReady();
      expect(settings.setValue).toHaveBeenCalledWith(
        expect.anything(),
        ['providers', expect.any(String)],
        expect.objectContaining({ protocol: 'openai-responses' }),
      );
      expect(settings.setValue).toHaveBeenCalledWith(
        expect.anything(),
        'security.auth.selectedType',
        'openai-responses',
      );
    } finally {
      view.unmount();
    }
  });

  it('keeps earlier models when reconnecting the same custom endpoint', async () => {
    const baseUrl = 'https://example.test/v1';
    const providerId = providerIdForPreset(customProviderPreset, baseUrl);
    const config = {
      isBrowserLaunchSuppressed: () => true,
      getModelProviderManager: () => ({ listModels: async () => [] }),
    } as unknown as Config;
    const settings = {
      merged: {
        security: { auth: {} },
        providers: {
          [providerId]: {
            protocol: 'openai',
            baseUrl,
            apiKey: 'old-key',
            models: [{ model: 'old-model' }],
          },
        },
      },
      setValue: vi.fn(() => true),
    } as unknown as LoadedSettings;
    const view = await renderWithProviders(
      <AuthDialog
        config={config}
        settings={settings}
        canClose
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
      { width: 120 },
    );
    await view.waitUntilReady();

    try {
      for (let i = 0; i < 5; i++) await press(view, '\u001b[B');
      await press(view, '\r');
      await press(view, '\r');
      await press(view, '\r');
      for (const char of baseUrl) await press(view, char);
      await press(view, '\r');
      for (const char of 'new-key') await press(view, char);
      await press(view, '\r');
      for (const char of 'new-model') await press(view, char);
      await press(view, '\r');
      await press(view, '\r');
      await press(view, '\r');

      const providerWrite = (
        settings.setValue as ReturnType<typeof vi.fn>
      ).mock.calls.find(
        (call) => Array.isArray(call[1]) && call[1][0] === 'providers',
      );
      expect(providerWrite?.[2]).toEqual(
        expect.objectContaining({
          models: [{ model: 'old-model' }, { model: 'new-model' }],
        }),
      );
    } finally {
      view.unmount();
    }
  });

  it('filters models with slash search and activates the first match', async () => {
    const config = {
      isBrowserLaunchSuppressed: () => true,
      getModelProviderManager: () => ({ listModels: async () => [] }),
    } as unknown as Config;
    const settings = {
      merged: { security: { auth: {} } },
      setValue: vi.fn(() => true),
    } as unknown as LoadedSettings;
    const onDone = vi.fn();
    const view = await renderWithProviders(
      <AuthDialog
        config={config}
        settings={settings}
        canClose
        onClose={vi.fn()}
        onDone={onDone}
      />,
      { width: 120 },
    );
    await view.waitUntilReady();

    try {
      // Main → Other Providers.
      for (let i = 0; i < 4; i++) await press(view, '\u001b[B');
      await press(view, '\r');
      // Provider list → DeepSeek API Key (first item).
      await press(view, '\r');
      for (const char of 'key-1') await press(view, char);
      await press(view, '\r');
      expect(view.lastFrame()).toContain('Model IDs');
      // `/` focuses the search box; typing filters the list.
      await press(view, '/');
      for (const char of 'flash') await press(view, char);
      expect(view.lastFrame()).toContain('deepseek-flash');
      expect(view.lastFrame()).not.toContain('deepseek-v4-pro');
      // Enter returns to the list, Enter activates the first match.
      await press(view, '\r');
      await press(view, '\r');
      expect(onDone).toHaveBeenCalledWith({
        modelKey: 'deepseek/deepseek-flash',
      });
    } finally {
      view.unmount();
    }
  });

  it('returns to the provider list from a single-endpoint key step', async () => {
    const config = {
      isBrowserLaunchSuppressed: () => true,
      getModelProviderManager: () => ({ listModels: async () => [] }),
    } as unknown as Config;
    const settings = {
      merged: { security: { auth: {} } },
      setValue: vi.fn(() => true),
    } as unknown as LoadedSettings;
    const view = await renderWithProviders(
      <AuthDialog
        config={config}
        settings={settings}
        canClose
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
      { width: 120 },
    );
    await view.waitUntilReady();

    try {
      for (let i = 0; i < 4; i++) await press(view, '\u001b[B');
      await press(view, '\r');
      await press(view, '\r');
      expect(view.lastFrame()).toContain('API Key');
      await press(view, '\u001b');
      expect(view.lastFrame()).toContain('Other Providers · Provider');
    } finally {
      view.unmount();
    }
  });

  it.each([
    ['saved China', 'https://api.minimaxi.com/v1', 'China'],
    ['saved International', 'https://api.minimax.io/v1', 'International'],
    ['fresh setup', undefined, 'International'],
    ['unknown saved URL', 'https://example.test/v1', 'International'],
  ])('selects the expected MiniMax endpoint for %s', async (_, baseUrl, label) => {
    const config = {
      isBrowserLaunchSuppressed: () => true,
      getModelProviderManager: () => ({ listModels: async () => [] }),
    } as unknown as Config;
    const settings = {
      merged: {
        security: { auth: {} },
        providers: baseUrl
          ? {
              minimax: {
                protocol: 'openai',
                baseUrl,
                apiKey: 'saved-test-key',
                models: [{ model: 'MiniMax-M2.7' }],
              },
            }
          : {},
      },
      setValue: vi.fn(() => true),
    } as unknown as LoadedSettings;
    const view = await renderWithProviders(
      <AuthDialog
        config={config}
        settings={settings}
        canClose
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
      { width: 120 },
    );
    await view.waitUntilReady();

    try {
      // Main → Third-party Providers → MiniMax API Key.
      for (let i = 0; i < 4; i++) await press(view, '\u001b[B');
      await press(view, '\r');
      for (let i = 0; i < 2; i++) await press(view, '\u001b[B');
      await press(view, '\r');
      expect(view.lastFrame()).toContain('Step 1/3 · Endpoint');
      expect(view.lastFrame()).toContain(`${figures.pointer} ${label}`);

      // Accept the highlighted endpoint without moving the cursor.
      await press(view, '\r');
      expect(view.lastFrame()).toContain('Step 2/3 · API Key');
      expect(view.lastFrame()).toContain(`Paste the API key for ${label}.`);
      await press(view, '\u001b');
      expect(view.lastFrame()).toContain(`${figures.pointer} ${label}`);

      // A new choice also survives returning from the key step.
      const otherLabel = label === 'China' ? 'International' : 'China';
      await press(view, label === 'China' ? '\u001b[A' : '\u001b[B');
      await press(view, '\r');
      expect(view.lastFrame()).toContain(`Paste the API key for ${otherLabel}.`);
      await press(view, '\u001b');
      expect(view.lastFrame()).toContain(`${figures.pointer} ${otherLabel}`);
      expect(settings.setValue).not.toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  });

  it('returns to the region step from a multi-endpoint key step', async () => {
    const config = {
      isBrowserLaunchSuppressed: () => true,
      getModelProviderManager: () => ({ listModels: async () => [] }),
    } as unknown as Config;
    const settings = {
      merged: { security: { auth: {} } },
      setValue: vi.fn(() => true),
    } as unknown as LoadedSettings;
    const view = await renderWithProviders(
      <AuthDialog
        config={config}
        settings={settings}
        canClose
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
      { width: 120 },
    );
    await view.waitUntilReady();

    try {
      for (let i = 0; i < 3; i++) await press(view, '\u001b[B');
      await press(view, '\r');
      await press(view, '\r');
      expect(view.lastFrame()).toContain('Region');
      await press(view, '\r');
      expect(view.lastFrame()).toContain('API Key');
      await press(view, '\u001b');
      expect(view.lastFrame()).toContain('Region');
    } finally {
      view.unmount();
    }
  });

  it('defaults a custom Gemini endpoint and uses the standard key hint', async () => {
    const config = {
      isBrowserLaunchSuppressed: () => true,
      getModelProviderManager: () => ({ listModels: async () => [] }),
    } as unknown as Config;
    const settings = {
      merged: { security: { auth: {} } },
      setValue: vi.fn(() => true),
    } as unknown as LoadedSettings;
    const view = await renderWithProviders(
      <AuthDialog
        config={config}
        settings={settings}
        canClose
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
      { width: 120 },
    );
    await view.waitUntilReady();

    try {
      // Main → Custom Provider.
      for (let i = 0; i < 5; i++) await press(view, '\u001b[B');
      await press(view, '\r');
      // Protocol → Gemini-compatible.
      await press(view, '\u001b[B');
      await press(view, '\u001b[B');
      await press(view, '\r');
      expect(view.lastFrame()).toContain('Base URL');
      expect(view.lastFrame()).toContain(
        'https://generativelanguage.googleapis.com',
      );
      // Submitting an empty field adopts the default endpoint.
      await press(view, '\r');
      expect(view.lastFrame()).toContain('API Key');
      expect(view.lastFrame()).toContain('sk-...');
    } finally {
      view.unmount();
    }
  });

  it('navigates advanced rows while the context window input is focused', async () => {
    const config = {
      isBrowserLaunchSuppressed: () => true,
      getModelProviderManager: () => ({ listModels: async () => [] }),
    } as unknown as Config;
    const settings = {
      merged: { security: { auth: {} } },
      setValue: vi.fn(() => true),
    } as unknown as LoadedSettings;
    const view = await renderWithProviders(
      <AuthDialog
        config={config}
        settings={settings}
        canClose
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
      { width: 120 },
    );
    await view.waitUntilReady();

    try {
      for (let i = 0; i < 5; i++) await press(view, '\u001b[B');
      await press(view, '\r');
      await press(view, '\r');
      await press(view, '\r');
      for (const char of 'https://example.test/v1') await press(view, char);
      await press(view, '\r');
      for (const char of 'key-1') await press(view, char);
      await press(view, '\r');
      for (const char of 'm1') await press(view, char);
      await press(view, '\r');
      expect(view.lastFrame()).toContain('Advanced Config');
      // Thinking → modality → context window.
      await press(view, '\u001b[B');
      await press(view, '\u001b[B');
      expect(view.lastFrame()).toContain('› Context window');
      for (const char of '200000') await press(view, char);
      expect(view.lastFrame()).toContain('200000');
      // Up leaves the inline input and returns to the modality row.
      await press(view, '\u001b[A');
      const modalityLine = view
        .lastFrame()
        .split('\n')
        .find((line) => line.includes('Enable modality'));
      expect(modalityLine).toContain('›');
      // Back down to the input and continue to review.
      await press(view, '\u001b[B');
      await press(view, '\u001b[B');
      await press(view, '\r');
      expect(view.lastFrame()).toContain('Step 7/7 · Review');
    } finally {
      view.unmount();
    }
  });

  it('activates the highlighted catalog model, not the first preset model', async () => {
    const preset = QWENCLOUD_PRESETS[0]!;
    const expectedModel = preset.models[1]!.id;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            data: [
              { id: 'wan2.7-image' },
              ...preset.models.map((model) => ({ id: model.id })),
            ],
          }),
      })),
    );
    const config = {
      isBrowserLaunchSuppressed: () => true,
      getModelProviderManager: () => ({ listModels: async () => [] }),
    } as unknown as Config;
    const settings = {
      merged: { security: { auth: {} } },
      setValue: vi.fn(() => true),
    } as unknown as LoadedSettings;
    const onDone = vi.fn();
    const view = await renderWithProviders(
      <AuthDialog
        config={config}
        settings={settings}
        canClose
        onClose={vi.fn()}
        onDone={onDone}
      />,
      { width: 120 },
    );
    await view.waitUntilReady();

    try {
      // Main menu → QwenCloud.
      await press(view, '\u001b[B');
      await press(view, '\u001b[B');
      await press(view, '\r');
      // Access method → first preset.
      await press(view, '\r');
      // Region → first endpoint.
      await press(view, '\r');
      for (const char of 'sk-sp-test') await press(view, char);
      await press(view, '\r');
      expect(view.lastFrame()).toContain('Model IDs');
      // The generation model is listed but disabled, so the cursor skips it.
      const generationLine = view
        .lastFrame()
        .split('\n')
        .find((line) => line.includes('wan2.7-image'));
      expect(generationLine).toContain('○ wan2.7-image');
      expect(generationLine).not.toContain('❯');
      // Highlight the second model and submit.
      await press(view, '\u001b[B');
      await press(view, '\r');
      expect(onDone).toHaveBeenCalledWith({
        modelKey: `${preset.id}/${expectedModel}`,
      });
    } finally {
      view.unmount();
    }
  });
});
