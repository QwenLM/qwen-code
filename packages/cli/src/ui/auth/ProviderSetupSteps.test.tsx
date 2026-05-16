/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithProviders } from '../../test-utils/render.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import type { KeypressHandler, Key } from '../contexts/KeypressContext.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { ProviderSetupSteps } from './ProviderSetupSteps.js';
import type { ProviderSetupFlow } from './useProviderSetupFlow.js';

type UseKeypressMockOptions = { isActive: boolean };

vi.mock('../hooks/useKeypress.js');

let activeKeypressHandler: KeypressHandler | null = null;

describe('ProviderSetupSteps', () => {
  beforeEach(() => {
    activeKeypressHandler = null;
    vi.mocked(useKeypress).mockImplementation(
      (handler: KeypressHandler, options?: UseKeypressMockOptions) => {
        if (options?.isActive) {
          activeKeypressHandler = handler;
        }
      },
    );
  });

  const pressKey = (
    name: string,
    sequence: string = name,
    overrides: Partial<Key> = {},
  ) => {
    if (!activeKeypressHandler) {
      throw new Error(`No active keypress handler for ${name}`);
    }
    activeKeypressHandler({
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

  it('maps Ctrl+P/N to advanced-config focus navigation', () => {
    const flow = createAdvancedConfigFlow();

    const { unmount } = renderWithProviders(<ProviderSetupSteps flow={flow} />);

    pressKey('p', '\u0010', { ctrl: true });
    pressKey('n', '\u000E', { ctrl: true });

    expect(flow.moveAdvancedFocusUp).toHaveBeenCalledTimes(1);
    expect(flow.moveAdvancedFocusDown).toHaveBeenCalledTimes(1);
    unmount();
  });
});
