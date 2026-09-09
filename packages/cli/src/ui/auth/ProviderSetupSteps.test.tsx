/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithProviders } from '../../test-utils/render.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { AuthType, customProvider } from '@qwen-code/qwen-code-core';
import type { ModelSpec } from '@qwen-code/qwen-code-core';
import type { KeypressHandler, Key } from '../contexts/KeypressContext.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { ProviderSetupSteps } from './ProviderSetupSteps.js';
import {
  useProviderSetupFlow,
  type ProviderSetupFlow,
} from './useProviderSetupFlow.js';

type UseKeypressMockOptions = { isActive: boolean };

const discoverProviderModelsMock = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/qwen-code-core')>()),
  discoverProviderModels: discoverProviderModelsMock,
}));
vi.mock('../hooks/useKeypress.js');

let activeKeypressHandlers: KeypressHandler[] = [];

describe('ProviderSetupSteps', () => {
  beforeEach(() => {
    activeKeypressHandlers = [];
    discoverProviderModelsMock.mockReset();
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

  const createProtocolFlow = (): ProviderSetupFlow => {
    const noop = vi.fn();
    return {
      state: {
        provider: customProvider,
        step: 'protocol',
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
      moveAdvancedFocusUp: noop,
      moveAdvancedFocusDown: noop,
      toggleFocusedAdvancedOption: noop,
      changeContextWindowSize: noop,
      submitAdvancedConfig: noop,
      submit: noop,
    } as unknown as ProviderSetupFlow;
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
      clearModelIdsError: vi.fn(),
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
      clearModelIdsError: vi.fn(),
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
      clearModelIdsError: vi.fn(),
      submitModelIds,
      moveAdvancedFocusUp: noop,
      moveAdvancedFocusDown: noop,
      toggleFocusedAdvancedOption: noop,
      changeContextWindowSize: noop,
      submitAdvancedConfig: noop,
      submit: noop,
    } as unknown as ProviderSetupFlow;
  };

  const enableDiscovery = (flow: ProviderSetupFlow) => {
    if (!flow.state.provider) {
      throw new Error('Expected a provider');
    }
    flow.state.provider = {
      ...flow.state.provider,
      supportsModelDiscovery: true,
    };
    flow.state.baseUrl = 'https://example.com/v1';
    flow.state.apiKey = 'secret-key';
  };

  it('renders OpenAI Responses for the custom provider protocol step', () => {
    const flow = createProtocolFlow();

    const { lastFrame, unmount } = renderWithProviders(
      <ProviderSetupSteps flow={flow} />,
    );

    expect(lastFrame()).toContain('OpenAI Responses');
    unmount();
  });
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
    expect(frame).not.toContain('Other models from the provider');
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
    expect(frame).toMatch(/◉\uFE0E\s+MiniMax-M3/);
    expect(frame).toMatch(/◉\uFE0E\s+MiniMax-M2\.7/);
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
      modelIds: ['MiniMax-M3', 'MiniMax-M2.7', 'custom-model'],
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

  it('does not mount the model editor before discovery settles', () => {
    discoverProviderModelsMock.mockReturnValue(new Promise(() => {}));
    const flow = createModelIdsFlow();
    enableDiscovery(flow);

    const { lastFrame, unmount } = renderWithProviders(
      <ProviderSetupSteps flow={flow} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Loading models from provider…');
    expect(frame).toContain('Esc to go back');
    expect(frame).not.toContain('Enter model IDs directly');
    expect(discoverProviderModelsMock).toHaveBeenCalledWith({
      baseUrl: 'https://example.com/v1',
      apiKey: 'secret-key',
      staticModels: flow.state.provider?.models,
      signal: expect.any(AbortSignal),
    });
    unmount();
  });

  it('mounts one provider snapshot without promoting new models or dropping unserved selections', async () => {
    let resolveDiscovery!: (models: ModelSpec[]) => void;
    discoverProviderModelsMock.mockReturnValue(
      new Promise<ModelSpec[]>((resolve) => {
        resolveDiscovery = resolve;
      }),
    );
    const submitModelIds = vi.fn();
    const flow = createModelIdsFlow({
      modelIds: 'custom-model, MiniMax-M3, MiniMax-M2.7',
      submitModelIds,
    });
    enableDiscovery(flow);
    const { lastFrame, unmount } = renderWithProviders(
      <ProviderSetupSteps flow={flow} />,
    );

    await act(async () => {
      resolveDiscovery([
        {
          id: 'MiniMax-M3',
          contextWindowSize: 1000000,
          modalities: { image: true, video: true },
        },
        { id: 'MiniMax-M4' },
        { id: 'custom-model' },
      ]);
    });

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Recommended models · from the provider');
    expect(frame).toContain('custom-model');
    expect(frame).toContain('MiniMax-M3');
    expect(frame).toContain('MiniMax-M4');
    // The snapshot has no row for the previously selected MiniMax-M2.7, so it
    // stays visible and selectable through the free-form input instead.
    expect(frame).not.toMatch(/[◉○]\uFE0E\s+MiniMax-M2\.7/);
    const inputLine = frame
      .split('\n')
      .find((line) => line.includes('custom-model'));
    expect(inputLine).toContain('custom-model, MiniMax-M2.7');
    expect(frame).toMatch(/◉\uFE0E\s+MiniMax-M3/);
    expect(frame).toMatch(/○\uFE0E\s+MiniMax-M4/);
    expect(frame).toMatch(/○\uFE0E\s+custom-model/);
    const lines = frame.split('\n');
    const otherHeadingLine = lines.findIndex((line) =>
      line.includes('Other models from the provider'),
    );
    expect(otherHeadingLine).toBeGreaterThan(
      lines.findIndex((line) => /◉\uFE0E\s+MiniMax-M3/.test(line)),
    );
    expect(otherHeadingLine).toBeLessThan(
      lines.findIndex((line) => /○\uFE0E\s+MiniMax-M4/.test(line)),
    );
    await act(async () => {
      pressLatestKey('x', 'x');
    });
    expect(lastFrame()).toContain('xcustom-model, MiniMax-M2.7');
    expect(flow.changeModelIds).not.toHaveBeenCalled();
    pressKey('return', '\r');
    expect(submitModelIds).toHaveBeenCalledWith({
      modelIds: ['MiniMax-M3', 'xcustom-model', 'MiniMax-M2.7'],
    });
    unmount();
  });

  it('lists provider-only models without the recommended endorsement', async () => {
    discoverProviderModelsMock.mockResolvedValue([
      { id: 'served-unknown-a' },
      { id: 'served-unknown-b' },
    ]);
    const flow = createModelIdsFlow();
    enableDiscovery(flow);

    const { lastFrame, unmount } = renderWithProviders(
      <ProviderSetupSteps flow={flow} />,
    );
    await act(async () => {});

    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('Recommended models · from the provider');
    expect(frame).toContain('Other models from the provider');
    expect(frame).toMatch(/○\uFE0E\s+served-unknown-a/);
    expect(frame).toMatch(/○\uFE0E\s+served-unknown-b/);
    unmount();
  });

  it('toggles and submits an unendorsed provider model like a recommended one', async () => {
    let resolveDiscovery!: (models: ModelSpec[]) => void;
    discoverProviderModelsMock.mockReturnValue(
      new Promise<ModelSpec[]>((resolve) => {
        resolveDiscovery = resolve;
      }),
    );
    const submitModelIds = vi.fn();
    const flow = createModelIdsFlow({
      modelIds: 'custom-model, MiniMax-M3',
      submitModelIds,
    });
    enableDiscovery(flow);
    const { lastFrame, unmount } = renderWithProviders(
      <ProviderSetupSteps flow={flow} />,
    );

    await act(async () => {
      resolveDiscovery([
        { id: 'MiniMax-M3', contextWindowSize: 1000000 },
        { id: 'MiniMax-M4' },
      ]);
    });

    await act(async () => {
      pressLatestKey('down');
    });
    await act(async () => {
      pressLatestKey('down');
    });
    await act(async () => {
      pressLatestKey('down');
    });
    await act(async () => {
      pressLatestKey('space', ' ');
    });

    expect(lastFrame()).toMatch(/◉\uFE0E\s+MiniMax-M4/);

    pressKey('return', '\r');
    expect(submitModelIds).toHaveBeenCalledWith({
      modelIds: ['MiniMax-M3', 'MiniMax-M4', 'custom-model'],
    });
    unmount();
  });

  it('falls back to built-ins after an unavailable catalog', async () => {
    discoverProviderModelsMock.mockResolvedValue(null);
    const flow = createModelIdsFlow();
    enableDiscovery(flow);

    const { lastFrame, unmount } = renderWithProviders(
      <ProviderSetupSteps flow={flow} />,
    );
    await act(async () => {});

    const frame = lastFrame() ?? '';
    expect(frame).toContain(
      'Recommended models · provider list unavailable, showing built-ins',
    );
    expect(frame).not.toContain('Other models from the provider');
    expect(frame).toContain('MiniMax-M2.7');
    unmount();
  });

  it('cancels a pending discovery when the step unmounts', () => {
    discoverProviderModelsMock.mockReturnValue(new Promise(() => {}));
    const flow = createModelIdsFlow();
    enableDiscovery(flow);
    const { unmount } = renderWithProviders(<ProviderSetupSteps flow={flow} />);
    const signal = discoverProviderModelsMock.mock.calls[0]?.[0]
      .signal as AbortSignal;

    unmount();

    expect(signal.aborted).toBe(true);
  });

  it('submits served recommendations ahead of unserved defaults on a partial catalog', async () => {
    let resolveDiscovery!: (models: ModelSpec[]) => void;
    discoverProviderModelsMock.mockReturnValue(
      new Promise<ModelSpec[]>((resolve) => {
        resolveDiscovery = resolve;
      }),
    );
    const submitModelIds = vi.fn();
    // Defaults are pre-selected; the catalog serves MiniMax-M3 but not the
    // built-in MiniMax-M2.7, which the step demotes into the free-form input.
    const flow = createModelIdsFlow({ submitModelIds });
    enableDiscovery(flow);

    const { lastFrame, unmount } = renderWithProviders(
      <ProviderSetupSteps flow={flow} />,
    );

    await act(async () => {
      resolveDiscovery([{ id: 'MiniMax-M3', contextWindowSize: 1000000 }]);
    });

    expect(lastFrame()).toContain('Enter model IDs directly');

    pressKey('return', '\r');

    // The no-edit submit must lead with a catalog-served model: models[0]
    // becomes modelSelection and is written as model.name on first-time setup.
    expect(submitModelIds).toHaveBeenCalledWith({
      modelIds: ['MiniMax-M3', 'MiniMax-M2.7'],
    });
    unmount();
  });

  it('clears the model-ids error on edit after an empty discovery submit', async () => {
    discoverProviderModelsMock.mockResolvedValue([{ id: 'served-model' }]);

    let flow: ProviderSetupFlow | undefined;
    const RealFlowHarness = () => {
      const realFlow = useProviderSetupFlow(async () => {});
      flow = realFlow;
      return <ProviderSetupSteps flow={realFlow} />;
    };

    const { lastFrame, unmount } = renderWithProviders(<RealFlowHarness />);

    await act(async () => {
      flow?.start({
        id: 'discovery-provider',
        label: 'Discovery Provider',
        description: 'Provider with model discovery',
        protocol: AuthType.USE_OPENAI,
        baseUrl: 'https://example.com/v1',
        envKey: 'DISCOVERY_API_KEY',
        modelsEditable: true,
        supportsModelDiscovery: true,
        modelNamePrefix: 'Discovery',
      });
    });
    await act(async () => {
      flow?.submitApiKey('sk-discovery');
    });
    await act(async () => {});

    expect(lastFrame()).toContain('Enter model IDs directly');

    await act(async () => {
      pressLatestKey('return', '\r');
    });
    expect(lastFrame()).toContain('Model IDs cannot be empty.');

    await act(async () => {
      pressLatestKey('x', 'x');
    });
    expect(lastFrame()).not.toContain('Model IDs cannot be empty.');

    unmount();
  });
});
