/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithProviders } from '../../test-utils/render.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { AuthType } from '@qwen-code/qwen-code-core';
import type { KeypressHandler, Key } from '../contexts/KeypressContext.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { ProviderSetupSteps } from './ProviderSetupSteps.js';
import type { ProviderSetupFlow } from './useProviderSetupFlow.js';

type UseKeypressMockOptions = { isActive: boolean };

vi.mock('../hooks/useKeypress.js');

let activeKeypressHandlers: KeypressHandler[] = [];

describe('ProviderSetupSteps', () => {
  beforeEach(() => {
    activeKeypressHandlers = [];
    vi.mocked(useKeypress).mockImplementation(
      (handler: KeypressHandler, options?: UseKeypressMockOptions) => {
        if (options?.isActive) {
          activeKeypressHandlers.push(handler);
        }
      },
    );
  });

  const pressKey = (
    name: string,
    sequence: string = name,
    overrides: Partial<Key> = {},
  ) => {
    if (activeKeypressHandlers.length === 0) {
      throw new Error(`No active keypress handler for ${name}`);
    }
    const event = {
      name,
      sequence,
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      ...overrides,
    };
    for (const handler of activeKeypressHandlers) {
      handler(event);
    }
  };

  const pressLatestKey = (
    name: string,
    sequence: string = name,
    overrides: Partial<Key> = {},
  ) => {
    const handler = activeKeypressHandlers.at(-1);
    if (!handler) {
      throw new Error(`No active keypress handler for ${name}`);
    }
    handler({
      name,
      sequence,
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      ...overrides,
    });
  };

  const createAdvancedConfigFlow = (): ProviderSetupFlow => {
    const noop = vi.fn();
    return {
      state: {
        provider: {
          name: 'Custom',
          authType: AuthType.USE_OPENAI,
          protocol: AuthType.USE_OPENAI,
          showAdvancedConfig: true,
        },
        step: 'advancedConfig',
        stepIndex: 0,
        totalSteps: 1,
        protocol: AuthType.USE_OPENAI,
        baseUrl: '',
        baseUrlPlaceholder: '',
        baseUrlOptionIndex: 0,
        baseUrlError: null,
        apiKey: '',
        apiKeyError: null,
        modelIds: '',
        modelIdsError: null,
        thinkingEnabled: false,
        modalityEnabled: false,
        modalityImage: true,
        modalityVideo: true,
        modalityAudio: true,
        modalityPdf: false,
        contextWindowSize: '',
        focusedConfigIndex: 0,
        previewJson: '',
      },
      start: noop,
      reset: noop,
      goBack: noop,
      selectProtocol: noop,
      selectBaseUrl: noop,
      highlightBaseUrl: noop,
      submitBaseUrl: noop,
      changeBaseUrl: noop,
      changeApiKey: noop,
      submitApiKey: noop,
      changeModelIds: noop,
      submitModelIds: noop,
      moveAdvancedFocusUp: vi.fn(),
      moveAdvancedFocusDown: vi.fn(),
      toggleFocusedAdvancedOption: noop,
      changeContextWindowSize: noop,
      submitAdvancedConfig: noop,
      submit: noop,
    } as unknown as ProviderSetupFlow;
  };

  const createModelIdsFlow = ({
    modelIds = 'MiniMax-M3, MiniMax-M2.7',
    submitModelIds = vi.fn(),
  }: {
    modelIds?: string;
    submitModelIds?: ReturnType<typeof vi.fn>;
  } = {}): ProviderSetupFlow => {
    const noop = vi.fn();
    return {
      state: {
        provider: {
          id: 'minimax',
          label: 'MiniMax API Key',
          description: 'Quick setup for MiniMax models',
          protocol: AuthType.USE_OPENAI,
          baseUrl: 'https://api.minimax.io/v1',
          envKey: 'MINIMAX_API_KEY',
          models: [
            {
              id: 'MiniMax-M3',
              contextWindowSize: 1000000,
              modalities: { image: true, video: true },
            },
            { id: 'MiniMax-M2.7', contextWindowSize: 204800 },
            { id: 'MiniMax-M2.5', contextWindowSize: 196608 },
          ],
          modelsEditable: true,
          modelNamePrefix: 'MiniMax',
        },
        step: 'models',
        stepIndex: 0,
        totalSteps: 1,
        protocol: AuthType.USE_OPENAI,
        baseUrl: '',
        baseUrlPlaceholder: '',
        baseUrlOptionIndex: 0,
        baseUrlError: null,
        apiKey: '',
        apiKeyError: null,
        modelIds,
        modelIdsError: null,
        thinkingEnabled: false,
        modalityEnabled: false,
        modalityImage: true,
        modalityVideo: true,
        modalityAudio: true,
        modalityPdf: false,
        contextWindowSize: '',
        focusedConfigIndex: 0,
        previewJson: '',
      },
      start: noop,
      reset: noop,
      goBack: noop,
      selectProtocol: noop,
      selectBaseUrl: noop,
      highlightBaseUrl: noop,
      submitBaseUrl: noop,
      changeBaseUrl: noop,
      changeApiKey: noop,
      submitApiKey: noop,
      changeModelIds: noop,
      submitModelIds,
      moveAdvancedFocusUp: noop,
      moveAdvancedFocusDown: noop,
      toggleFocusedAdvancedOption: noop,
      changeContextWindowSize: noop,
      submitAdvancedConfig: noop,
      submit: noop,
    } as unknown as ProviderSetupFlow;
  };

  const createCustomModelIdsFlow = ({
    modelIds = 'model-a, model-b',
    submitModelIds = vi.fn(),
  }: {
    modelIds?: string;
    submitModelIds?: ReturnType<typeof vi.fn>;
  } = {}): ProviderSetupFlow => {
    const noop = vi.fn();
    return {
      state: {
        provider: {
          id: 'custom-openai-compatible',
          label: 'Custom Provider',
          description: 'Manually connect a provider',
          protocol: AuthType.USE_OPENAI,
          modelsEditable: true,
          showAdvancedConfig: true,
        },
        step: 'models',
        stepIndex: 0,
        totalSteps: 1,
        protocol: AuthType.USE_OPENAI,
        baseUrl: '',
        baseUrlPlaceholder: '',
        baseUrlOptionIndex: 0,
        baseUrlError: null,
        apiKey: '',
        apiKeyError: null,
        modelIds,
        modelIdsError: null,
        thinkingEnabled: false,
        modalityEnabled: false,
        modalityImage: true,
        modalityVideo: true,
        modalityAudio: false,
        modalityPdf: false,
        contextWindowSize: '',
        focusedConfigIndex: 0,
        previewJson: '',
      },
      start: noop,
      reset: noop,
      goBack: noop,
      selectProtocol: noop,
      selectBaseUrl: noop,
      highlightBaseUrl: noop,
      submitBaseUrl: noop,
      changeBaseUrl: noop,
      changeApiKey: noop,
      submitApiKey: noop,
      changeModelIds: noop,
      submitModelIds,
      moveAdvancedFocusUp: noop,
      moveAdvancedFocusDown: noop,
      toggleFocusedAdvancedOption: noop,
      changeContextWindowSize: noop,
      submitAdvancedConfig: noop,
      submit: noop,
    } as unknown as ProviderSetupFlow;
  };

  it('maps Ctrl+P/N to advanced-config focus navigation', () => {
    const flow = createAdvancedConfigFlow();

    const { unmount } = renderWithProviders(<ProviderSetupSteps flow={flow} />);

    pressKey('p', '\u0010', { ctrl: true });
    pressKey('n', '\u000E', { ctrl: true });

    expect(flow.moveAdvancedFocusUp).toHaveBeenCalledTimes(1);
    expect(flow.moveAdvancedFocusDown).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('renders predefined editable models with a primary free-form input and recommendations', () => {
    const flow = createModelIdsFlow();

    const { lastFrame, unmount } = renderWithProviders(
      <ProviderSetupSteps flow={flow} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Enter model IDs directly');
    expect(frame).toContain('Recommended models');
    expect(frame).toContain(
      'Checked recommended models are applied on submit but not copied into the input.',
    );
    expect(frame).toContain('◉');
    expect(frame).toContain('○');
    expect(frame).not.toContain('›');
    expect(frame).not.toContain('[x]');
    expect(frame).not.toContain('[ ]');
    expect(frame).toContain('MiniMax-M3');
    expect(frame).toContain('1,000,000 tokens');
    expect(frame).toContain('text/image/video');
    expect(frame).toContain('204,800 tokens, text');
    expect(frame).not.toContain('Edit raw / custom model IDs');
    expect(frame).not.toContain('Tab for custom IDs');
    expect(frame).toContain('Search');
    expect(frame).toContain(
      '↑↓/Tab to switch input, search, and recommendations',
    );
    expect(frame).not.toContain('Enter model IDs separated by commas');
    unmount();
  });

  it('filters recommended models when typing search while recommendations are focused', async () => {
    const flow = createModelIdsFlow();

    const { lastFrame, unmount } = renderWithProviders(
      <ProviderSetupSteps flow={flow} />,
    );

    await act(async () => {
      pressLatestKey('down');
    });
    await act(async () => {
      pressLatestKey('M', 'M');
    });
    await act(async () => {
      pressLatestKey('3', '3');
    });

    const frame = lastFrame() ?? '';
    expect(frame).toContain('> M3');
    expect(frame).toContain('MiniMax-M3');
    expect(frame).not.toContain('MiniMax-M2.7');
    expect(frame).not.toContain('MiniMax-M2.5');
    unmount();
  });

  it('keeps recommended selections out of the free-form model input', () => {
    const flow = createModelIdsFlow({
      modelIds: 'custom-model, MiniMax-M3, MiniMax-M2.7',
    });

    const { lastFrame, unmount } = renderWithProviders(
      <ProviderSetupSteps flow={flow} />,
    );

    const frame = lastFrame() ?? '';
    const inputLine = frame
      .split('\n')
      .find((line) => line.includes('custom-model'));
    expect(inputLine).toContain('custom-model');
    expect(inputLine).not.toContain('MiniMax-M3');
    expect(inputLine).not.toContain('MiniMax-M2.7');
    expect(frame).toMatch(/◉\s+MiniMax-M3/);
    expect(frame).toMatch(/◉\s+MiniMax-M2\.7/);
    unmount();
  });

  it('deduplicates typed and recommended model IDs on submit', () => {
    const submitModelIds = vi.fn();
    const flow = createModelIdsFlow({
      modelIds: 'custom-model, MiniMax-M3, MiniMax-M3, MiniMax-M2.7',
      submitModelIds,
    });

    const { unmount } = renderWithProviders(<ProviderSetupSteps flow={flow} />);

    pressKey('return', '\r');

    expect(submitModelIds).toHaveBeenCalledWith({
      modelIds: ['custom-model', 'MiniMax-M3', 'MiniMax-M2.7'],
    });
    unmount();
  });

  it('preserves comma-separated model IDs for custom providers', () => {
    const submitModelIds = vi.fn();
    const flow = createCustomModelIdsFlow({
      modelIds: 'model-a, model-b',
      submitModelIds,
    });

    const { lastFrame, unmount } = renderWithProviders(
      <ProviderSetupSteps flow={flow} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Enter model IDs separated by commas');
    expect(frame).toContain('model-a, model-b');

    pressLatestKey('return', '\r');

    expect(submitModelIds).toHaveBeenCalledTimes(1);
    unmount();
  });
});
