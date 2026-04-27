/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AuthDialog } from './AuthDialog.js';
import { LoadedSettings } from '../../config/settings.js';
import type { Config } from '@qwen-code/qwen-code-core';
import { AuthType } from '@qwen-code/qwen-code-core';
import { renderWithProviders } from '../../test-utils/render.js';
import { UIStateContext } from '../contexts/UIStateContext.js';
import { UIActionsContext } from '../contexts/UIActionsContext.js';
import type { UIState } from '../contexts/UIStateContext.js';
import type { UIActions } from '../contexts/UIActionsContext.js';

const createMockUIState = (overrides: Partial<UIState> = {}): UIState => {
  // AuthDialog only uses authError and pendingAuthType
  const baseState = {
    authError: null,
    pendingAuthType: undefined,
  } as Partial<UIState>;

  return {
    ...baseState,
    ...overrides,
  } as UIState;
};

const createMockUIActions = (overrides: Partial<UIActions> = {}): UIActions => {
  // AuthDialog only uses handleAuthSelect
  const baseActions = {
    handleAuthSelect: vi.fn(),
    handleCodingPlanSubmit: vi.fn(),
    handleAlibabaStandardSubmit: vi.fn(),
    handleOpenRouterSubmit: vi.fn(),
    onAuthError: vi.fn(),
    handleRetryLastPrompt: vi.fn(),
  } as Partial<UIActions>;

  return {
    ...baseActions,
    ...overrides,
  } as UIActions;
};

const renderAuthDialog = (
  settings: LoadedSettings,
  uiStateOverrides: Partial<UIState> = {},
  uiActionsOverrides: Partial<UIActions> = {},
  configAuthType: AuthType | undefined = undefined,
  configApiKey: string | undefined = undefined,
) => {
  const uiState = createMockUIState(uiStateOverrides);
  const uiActions = createMockUIActions(uiActionsOverrides);

  const mockConfig = {
    getAuthType: vi.fn(() => configAuthType),
    getContentGeneratorConfig: vi.fn(() => ({ apiKey: configApiKey })),
  } as unknown as Config;

  return renderWithProviders(
    <UIStateContext.Provider value={uiState}>
      <UIActionsContext.Provider value={uiActions}>
        <AuthDialog />
      </UIActionsContext.Provider>
    </UIStateContext.Provider>,
    { settings, config: mockConfig },
  );
};

/**
 * Type text into the terminal one character at a time.
 * Works around a Node 24.x + ink compatibility issue on Windows
 * where bulk stdin.write() may not propagate to TextInput correctly.
 */
const typeText = async (
  stdin: { write: (s: string) => void },
  text: string,
) => {
  const delay = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
  for (const char of text) {
    stdin.write(char);
    await delay(5);
  }
  await delay(30);
};

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const expectSelectedOption = (frame: string | undefined, label: string) => {
  expect(frame).toMatch(
    new RegExp(`›\\s*(?:\\d+\\.\\s*)?${escapeRegExp(label)}`),
  );
};

const waitForSelectedOption = async (
  lastFrame: () => string | undefined,
  label: string,
) => {
  await vi.waitFor(() => {
    expectSelectedOption(lastFrame(), label);
  });
};

const pressEnterAndWaitFor = async (
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined,
  expectedText: string,
) => {
  stdin.write('\r');
  await vi.waitFor(() => {
    expect(lastFrame()).toContain(expectedText);
  });
};

const moveDownAndWaitForSelection = async (
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined,
  label: string,
) => {
  stdin.write('\u001b[B');
  await waitForSelectedOption(lastFrame, label);
};

const navigateToCustomProtocolSelect = async (
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined,
) => {
  await waitForSelectedOption(lastFrame, 'OAuth');
  await moveDownAndWaitForSelection(
    stdin,
    lastFrame,
    'Alibaba Cloud Coding Plan',
  );
  await moveDownAndWaitForSelection(stdin, lastFrame, 'API Key');
  await pressEnterAndWaitFor(stdin, lastFrame, 'Select API Key Type');
  await waitForSelectedOption(
    lastFrame,
    'Alibaba Cloud ModelStudio Standard API Key',
  );
  await moveDownAndWaitForSelection(stdin, lastFrame, 'Custom API Key');
  await pressEnterAndWaitFor(stdin, lastFrame, 'Step 1/6 · Protocol');
};

const navigateToCustomBaseUrlInput = async (
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined,
) => {
  await navigateToCustomProtocolSelect(stdin, lastFrame);
  await pressEnterAndWaitFor(stdin, lastFrame, 'Step 2/6 · Base URL');
};

const navigateToCustomApiKeyInput = async (
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined,
) => {
  await navigateToCustomBaseUrlInput(stdin, lastFrame);
  await pressEnterAndWaitFor(stdin, lastFrame, 'Step 3/6 · API Key');
};

const navigateToCustomModelIdInput = async (
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined,
  apiKey = 'sk-test',
) => {
  await navigateToCustomApiKeyInput(stdin, lastFrame);
  await typeText(stdin, apiKey);
  await pressEnterAndWaitFor(stdin, lastFrame, 'Step 4/6 · Model IDs');
};

const navigateToCustomAdvancedConfig = async (
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined,
  apiKey = 'sk-test',
  modelIds = 'model-1,model-2',
) => {
  await navigateToCustomModelIdInput(stdin, lastFrame, apiKey);
  await typeText(stdin, modelIds);
  await pressEnterAndWaitFor(stdin, lastFrame, 'Step 5/6 · Advanced Config');
};

describe('AuthDialog', () => {
  const wait = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env['GEMINI_API_KEY'] = '';
    process.env['QWEN_DEFAULT_AUTH_TYPE'] = '';
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should show an error if the initial auth type is invalid', () => {
    process.env['GEMINI_API_KEY'] = '';

    const settings: LoadedSettings = new LoadedSettings(
      {
        settings: { ui: { customThemes: {} }, mcpServers: {} },
        originalSettings: { ui: { customThemes: {} }, mcpServers: {} },
        path: '',
      },
      {
        settings: {},
        originalSettings: {},
        path: '',
      },
      {
        settings: {
          security: {
            auth: {
              selectedType: AuthType.USE_GEMINI,
            },
          },
        },
        originalSettings: {
          security: {
            auth: {
              selectedType: AuthType.USE_GEMINI,
            },
          },
        },
        path: '',
      },
      {
        settings: { ui: { customThemes: {} }, mcpServers: {} },
        originalSettings: { ui: { customThemes: {} }, mcpServers: {} },
        path: '',
      },
      true,
      new Set(),
    );

    const { lastFrame } = renderAuthDialog(settings, {
      authError: 'GEMINI_API_KEY  environment variable not found',
    });

    expect(lastFrame()).toContain(
      'GEMINI_API_KEY  environment variable not found',
    );
  });

  describe('GEMINI_API_KEY environment variable', () => {
    it('should detect GEMINI_API_KEY environment variable', () => {
      process.env['GEMINI_API_KEY'] = 'foobar';

      const settings: LoadedSettings = new LoadedSettings(
        {
          settings: {
            security: { auth: { selectedType: undefined } },
            ui: { customThemes: {} },
            mcpServers: {},
          },
          originalSettings: {
            security: { auth: { selectedType: undefined } },
            ui: { customThemes: {} },
            mcpServers: {},
          },
          path: '',
        },
        {
          settings: {},
          originalSettings: {},
          path: '',
        },
        {
          settings: { ui: { customThemes: {} }, mcpServers: {} },
          originalSettings: { ui: { customThemes: {} }, mcpServers: {} },
          path: '',
        },
        {
          settings: { ui: { customThemes: {} }, mcpServers: {} },
          originalSettings: { ui: { customThemes: {} }, mcpServers: {} },
          path: '',
        },
        true,
        new Set(),
      );

      const { lastFrame } = renderAuthDialog(settings);

      // Since the auth dialog shows API Key option now,
      // it won't show GEMINI_API_KEY messages
      expect(lastFrame()).toContain('API Key');
    });

    it('should not show the GEMINI_API_KEY message if QWEN_DEFAULT_AUTH_TYPE is set to something else', () => {
      process.env['GEMINI_API_KEY'] = 'foobar';
      process.env['QWEN_DEFAULT_AUTH_TYPE'] = AuthType.USE_OPENAI;

      const settings: LoadedSettings = new LoadedSettings(
        {
          settings: {
            security: { auth: { selectedType: undefined } },
            ui: { customThemes: {} },
            mcpServers: {},
          },
          originalSettings: {
            security: { auth: { selectedType: undefined } },
            ui: { customThemes: {} },
            mcpServers: {},
          },
          path: '',
        },
        {
          settings: {},
          originalSettings: {},
          path: '',
        },
        {
          settings: { ui: { customThemes: {} }, mcpServers: {} },
          originalSettings: { ui: { customThemes: {} }, mcpServers: {} },
          path: '',
        },
        {
          settings: { ui: { customThemes: {} }, mcpServers: {} },
          originalSettings: { ui: { customThemes: {} }, mcpServers: {} },
          path: '',
        },
        true,
        new Set(),
      );

      const { lastFrame } = renderAuthDialog(settings);

      expect(lastFrame()).not.toContain(
        'Existing API key detected (GEMINI_API_KEY)',
      );
    });

    it('should show the GEMINI_API_KEY message if QWEN_DEFAULT_AUTH_TYPE is set to use api key', () => {
      process.env['GEMINI_API_KEY'] = 'foobar';
      process.env['QWEN_DEFAULT_AUTH_TYPE'] = AuthType.USE_OPENAI;

      const settings: LoadedSettings = new LoadedSettings(
        {
          settings: {
            security: { auth: { selectedType: undefined } },
            ui: { customThemes: {} },
            mcpServers: {},
          },
          originalSettings: {
            security: { auth: { selectedType: undefined } },
            ui: { customThemes: {} },
            mcpServers: {},
          },
          path: '',
        },
        {
          settings: {},
          originalSettings: {},
          path: '',
        },
        {
          settings: { ui: { customThemes: {} }, mcpServers: {} },
          originalSettings: { ui: { customThemes: {} }, mcpServers: {} },
          path: '',
        },
        {
          settings: { ui: { customThemes: {} }, mcpServers: {} },
          originalSettings: { ui: { customThemes: {} }, mcpServers: {} },
          path: '',
        },
        true,
        new Set(),
      );

      const { lastFrame } = renderAuthDialog(settings);

      // Since the auth dialog shows API Key option now,
      // it won't show GEMINI_API_KEY messages
      expect(lastFrame()).toContain('API Key');
    });
  });

  describe('QWEN_DEFAULT_AUTH_TYPE environment variable', () => {
    it('should select the auth type specified by QWEN_DEFAULT_AUTH_TYPE', () => {
      // QWEN_OAUTH is the only valid AuthType that can be selected via env var
      // API-KEY is not an AuthType enum value, so it cannot be selected this way
      process.env['QWEN_DEFAULT_AUTH_TYPE'] = AuthType.QWEN_OAUTH;

      const settings: LoadedSettings = new LoadedSettings(
        {
          settings: {
            security: { auth: { selectedType: undefined } },
            ui: { customThemes: {} },
            mcpServers: {},
          },
          originalSettings: {
            security: { auth: { selectedType: undefined } },
            ui: { customThemes: {} },
            mcpServers: {},
          },
          path: '',
        },
        {
          settings: {},
          originalSettings: {},
          path: '',
        },
        {
          settings: { ui: { customThemes: {} }, mcpServers: {} },
          originalSettings: { ui: { customThemes: {} }, mcpServers: {} },
          path: '',
        },
        {
          settings: { ui: { customThemes: {} }, mcpServers: {} },
          originalSettings: { ui: { customThemes: {} }, mcpServers: {} },
          path: '',
        },
        true,
        new Set(),
      );

      const { lastFrame } = renderAuthDialog(settings);

      // QWEN_OAUTH maps to 'OAUTH' in the new three-option main menu
      expect(lastFrame()).toContain('OAuth');
    });

    it('should fall back to default if QWEN_DEFAULT_AUTH_TYPE is not set', () => {
      const settings: LoadedSettings = new LoadedSettings(
        {
          settings: {
            security: { auth: { selectedType: undefined } },
            ui: { customThemes: {} },
            mcpServers: {},
          },
          originalSettings: {
            security: { auth: { selectedType: undefined } },
            ui: { customThemes: {} },
            mcpServers: {},
          },
          path: '',
        },
        {
          settings: {},
          originalSettings: {},
          path: '',
        },
        {
          settings: { ui: { customThemes: {} }, mcpServers: {} },
          originalSettings: { ui: { customThemes: {} }, mcpServers: {} },
          path: '',
        },
        {
          settings: { ui: { customThemes: {} }, mcpServers: {} },
          originalSettings: { ui: { customThemes: {} }, mcpServers: {} },
          path: '',
        },
        true,
        new Set(),
      );

      const { lastFrame } = renderAuthDialog(settings);

      // Default is Coding Plan (first option); Qwen OAuth is last (discontinued)
      expect(lastFrame()).toContain('Alibaba Cloud Coding Plan');
    });

    it('should show an error and fall back to default if QWEN_DEFAULT_AUTH_TYPE is invalid', () => {
      process.env['QWEN_DEFAULT_AUTH_TYPE'] = 'invalid-auth-type';

      const settings: LoadedSettings = new LoadedSettings(
        {
          settings: {
            security: { auth: { selectedType: undefined } },
            ui: { customThemes: {} },
            mcpServers: {},
          },
          originalSettings: {
            security: { auth: { selectedType: undefined } },
            ui: { customThemes: {} },
            mcpServers: {},
          },
          path: '',
        },
        {
          settings: {},
          originalSettings: {},
          path: '',
        },
        {
          settings: { ui: { customThemes: {} }, mcpServers: {} },
          originalSettings: { ui: { customThemes: {} }, mcpServers: {} },
          path: '',
        },
        {
          settings: { ui: { customThemes: {} }, mcpServers: {} },
          originalSettings: { ui: { customThemes: {} }, mcpServers: {} },
          path: '',
        },
        true,
        new Set(),
      );

      const { lastFrame } = renderAuthDialog(settings);

      // Since the auth dialog doesn't show QWEN_DEFAULT_AUTH_TYPE errors anymore,
      // it will just show the default OAuth option
      expect(lastFrame()).toContain('OAuth');
    });
  });

  it('should prevent exiting when no auth method is selected and show error message', async () => {
    const handleAuthSelect = vi.fn();
    const settings: LoadedSettings = new LoadedSettings(
      {
        settings: { ui: { customThemes: {} }, mcpServers: {} },
        originalSettings: { ui: { customThemes: {} }, mcpServers: {} },
        path: '',
      },
      {
        settings: {},
        originalSettings: {},
        path: '',
      },
      {
        settings: {
          security: { auth: { selectedType: undefined } },
          ui: { customThemes: {} },
          mcpServers: {},
        },
        originalSettings: {
          security: { auth: { selectedType: undefined } },
          ui: { customThemes: {} },
          mcpServers: {},
        },
        path: '',
      },
      {
        settings: { ui: { customThemes: {} }, mcpServers: {} },
        originalSettings: { ui: { customThemes: {} }, mcpServers: {} },
        path: '',
      },
      true,
      new Set(),
    );

    const { lastFrame, stdin, unmount } = renderAuthDialog(
      settings,
      {},
      { handleAuthSelect },
      undefined, // config.getAuthType() returns undefined
    );
    await wait();

    // Simulate pressing escape key
    stdin.write('\u001b'); // ESC key
    await wait();

    // Should show error message instead of calling handleAuthSelect
    await vi.waitFor(() => {
      const frame = lastFrame();
      expect(frame).toContain('You must select an auth method');
      expect(frame).toContain('Press Ctrl+C again to exit');
    });
    expect(handleAuthSelect).not.toHaveBeenCalled();
    unmount();
  });

  it('should not exit if there is already an error message', async () => {
    const handleAuthSelect = vi.fn();
    const settings: LoadedSettings = new LoadedSettings(
      {
        settings: { ui: { customThemes: {} }, mcpServers: {} },
        originalSettings: { ui: { customThemes: {} }, mcpServers: {} },
        path: '',
      },
      {
        settings: {},
        originalSettings: {},
        path: '',
      },
      {
        settings: {
          security: { auth: { selectedType: undefined } },
          ui: { customThemes: {} },
          mcpServers: {},
        },
        originalSettings: {
          security: { auth: { selectedType: undefined } },
          ui: { customThemes: {} },
          mcpServers: {},
        },
        path: '',
      },
      {
        settings: { ui: { customThemes: {} }, mcpServers: {} },
        originalSettings: { ui: { customThemes: {} }, mcpServers: {} },
        path: '',
      },
      true,
      new Set(),
    );

    const { lastFrame, stdin, unmount } = renderAuthDialog(
      settings,
      { authError: 'Initial error' },
      { handleAuthSelect },
      undefined, // config.getAuthType() returns undefined
    );
    await wait();

    expect(lastFrame()).toContain('Initial error');

    // Simulate pressing escape key
    stdin.write('\u001b'); // ESC key
    await wait();

    // Should not call handleAuthSelect
    expect(handleAuthSelect).not.toHaveBeenCalled();
    unmount();
  });

  it('should allow exiting when auth method is already selected', async () => {
    const handleAuthSelect = vi.fn();
    const settings: LoadedSettings = new LoadedSettings(
      {
        settings: { ui: { customThemes: {} }, mcpServers: {} },
        originalSettings: { ui: { customThemes: {} }, mcpServers: {} },
        path: '',
      },
      {
        settings: {},
        originalSettings: {},
        path: '',
      },
      {
        settings: {
          security: { auth: { selectedType: AuthType.USE_OPENAI } },
          ui: { customThemes: {} },
          mcpServers: {},
        },
        originalSettings: {
          security: { auth: { selectedType: AuthType.USE_OPENAI } },
          ui: { customThemes: {} },
          mcpServers: {},
        },
        path: '',
      },
      {
        settings: { ui: { customThemes: {} }, mcpServers: {} },
        originalSettings: { ui: { customThemes: {} }, mcpServers: {} },
        path: '',
      },
      true,
      new Set(),
    );

    const { stdin, unmount } = renderAuthDialog(
      settings,
      {},
      { handleAuthSelect },
      AuthType.USE_OPENAI, // config.getAuthType() returns USE_OPENAI
    );
    await wait();

    // Simulate pressing escape key
    stdin.write('\u001b'); // ESC key
    await wait();

    // Should call handleAuthSelect with undefined to exit
    expect(handleAuthSelect).toHaveBeenCalledWith(undefined);
    unmount();
  });

  it('should show OpenRouter in API key options', async () => {
    const settings: LoadedSettings = new LoadedSettings(
      {
        settings: { ui: { customThemes: {} }, mcpServers: {} },
        originalSettings: { ui: { customThemes: {} }, mcpServers: {} },
        path: '',
      },
      {
        settings: {},
        originalSettings: {},
        path: '',
      },
      {
        settings: {
          security: { auth: { selectedType: undefined } },
          ui: { customThemes: {} },
          mcpServers: {},
        },
        originalSettings: {
          security: { auth: { selectedType: undefined } },
          ui: { customThemes: {} },
          mcpServers: {},
        },
        path: '',
      },
      {
        settings: { ui: { customThemes: {} }, mcpServers: {} },
        originalSettings: { ui: { customThemes: {} }, mcpServers: {} },
        path: '',
      },
      true,
      new Set(),
    );

    const { stdin, lastFrame, unmount } = renderAuthDialog(settings);
    await wait();

    // OAuth is selected by default, press Enter to enter OAuth provider list
    stdin.write('\r');
    await wait();

    await vi.waitFor(() => {
      const frame = lastFrame();
      expect(frame).toContain('OpenRouter');
      expect(frame).toContain('Browser OAuth');
    });

    unmount();
  });

  it('should trigger OpenRouter OAuth from API key options', async () => {
    const handleOpenRouterSubmit = vi.fn().mockResolvedValue(undefined);
    const settings: LoadedSettings = new LoadedSettings(
      {
        settings: { ui: { customThemes: {} }, mcpServers: {} },
        originalSettings: { ui: { customThemes: {} }, mcpServers: {} },
        path: '',
      },
      {
        settings: {},
        originalSettings: {},
        path: '',
      },
      {
        settings: {
          security: { auth: { selectedType: undefined } },
          ui: { customThemes: {} },
          mcpServers: {},
        },
        originalSettings: {
          security: { auth: { selectedType: undefined } },
          ui: { customThemes: {} },
          mcpServers: {},
        },
        path: '',
      },
      {
        settings: { ui: { customThemes: {} }, mcpServers: {} },
        originalSettings: { ui: { customThemes: {} }, mcpServers: {} },
        path: '',
      },
      true,
      new Set(),
    );

    const { stdin, unmount } = renderAuthDialog(
      settings,
      {},
      { handleOpenRouterSubmit },
    );
    await wait();

    // OAuth is selected by default, press Enter to enter OAuth provider list
    stdin.write('\r');
    await wait();
    // OpenRouter is the first option, press Enter to trigger OAuth
    stdin.write('\r');
    await wait();

    await vi.waitFor(() => {
      expect(handleOpenRouterSubmit).toHaveBeenCalledTimes(1);
    });

    unmount();
  });
});

const isUnreliableTuiInputEnvironment =
  process.platform === 'win32' ||
  (process.env['CI'] === 'true' && process.version.startsWith('v20.'));
const itWhenTuiInputReliable = isUnreliableTuiInputEnvironment ? it.skip : it;

describe('AuthDialog Custom API Key Wizard', () => {
  const wait = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

  const createStandardSettings = (): LoadedSettings =>
    new LoadedSettings(
      {
        settings: { ui: { customThemes: {} }, mcpServers: {} },
        originalSettings: { ui: { customThemes: {} }, mcpServers: {} },
        path: '',
      },
      {
        settings: {},
        originalSettings: {},
        path: '',
      },
      {
        settings: {
          security: { auth: { selectedType: undefined } },
          ui: { customThemes: {} },
          mcpServers: {},
        },
        originalSettings: {
          security: { auth: { selectedType: undefined } },
          ui: { customThemes: {} },
          mcpServers: {},
        },
        path: '',
      },
      {
        settings: { ui: { customThemes: {} }, mcpServers: {} },
        originalSettings: { ui: { customThemes: {} }, mcpServers: {} },
        path: '',
      },
      true,
      new Set(),
    );

  itWhenTuiInputReliable(
    'navigates to protocol selection when Custom API Key is selected',
    async () => {
      const settings = createStandardSettings();
      const handleCustomApiKeySubmit = vi.fn();

      const mockUIState = {
        authError: null,
        pendingAuthType: undefined,
      } as UIState;

      const mockUIActions = {
        handleAuthSelect: vi.fn(),
        handleCodingPlanSubmit: vi.fn(),
        handleAlibabaStandardSubmit: vi.fn(),
        handleOpenRouterSubmit: vi.fn(),
        handleCustomApiKeySubmit,
        onAuthError: vi.fn(),
        handleRetryLastPrompt: vi.fn(),
      } as unknown as UIActions;

      const mockConfig = {
        getAuthType: vi.fn(() => undefined),
        getContentGeneratorConfig: vi.fn(() => ({})),
      } as unknown as Config;

      const { stdin, lastFrame, unmount } = renderWithProviders(
        <UIStateContext.Provider value={mockUIState}>
          <UIActionsContext.Provider value={mockUIActions}>
            <AuthDialog />
          </UIActionsContext.Provider>
        </UIStateContext.Provider>,
        { settings, config: mockConfig },
      );

      await navigateToCustomProtocolSelect(stdin, lastFrame);

      await vi.waitFor(() => {
        const frame = lastFrame();
        expect(frame).toContain('Step 1/6 · Protocol');
        expect(frame).toContain('OpenAI-compatible');
        expect(frame).toContain('Anthropic-compatible');
        expect(frame).toContain('Gemini-compatible');
      });

      unmount();
    },
  );

  itWhenTuiInputReliable(
    'navigates to base URL input after selecting a protocol',
    async () => {
      const settings = createStandardSettings();
      const handleCustomApiKeySubmit = vi.fn();

      const mockUIState = {
        authError: null,
        pendingAuthType: undefined,
      } as UIState;

      const mockUIActions = {
        handleAuthSelect: vi.fn(),
        handleCodingPlanSubmit: vi.fn(),
        handleAlibabaStandardSubmit: vi.fn(),
        handleOpenRouterSubmit: vi.fn(),
        handleCustomApiKeySubmit,
        onAuthError: vi.fn(),
        handleRetryLastPrompt: vi.fn(),
      } as unknown as UIActions;

      const mockConfig = {
        getAuthType: vi.fn(() => undefined),
        getContentGeneratorConfig: vi.fn(() => ({})),
      } as unknown as Config;

      const { stdin, lastFrame, unmount } = renderWithProviders(
        <UIStateContext.Provider value={mockUIState}>
          <UIActionsContext.Provider value={mockUIActions}>
            <AuthDialog />
          </UIActionsContext.Provider>
        </UIStateContext.Provider>,
        { settings, config: mockConfig },
      );

      await navigateToCustomBaseUrlInput(stdin, lastFrame);

      await vi.waitFor(() => {
        const frame = lastFrame();
        expect(frame).toContain('Step 2/6 · Base URL');
        expect(frame).toContain('Enter the API endpoint');
      });

      unmount();
    },
  );

  itWhenTuiInputReliable(
    'shows review screen with JSON after entering model IDs',
    async () => {
      const settings = createStandardSettings();
      const handleCustomApiKeySubmit = vi.fn();

      const mockUIState = {
        authError: null,
        pendingAuthType: undefined,
      } as UIState;

      const mockUIActions = {
        handleAuthSelect: vi.fn(),
        handleCodingPlanSubmit: vi.fn(),
        handleAlibabaStandardSubmit: vi.fn(),
        handleOpenRouterSubmit: vi.fn(),
        handleCustomApiKeySubmit,
        onAuthError: vi.fn(),
        handleRetryLastPrompt: vi.fn(),
      } as unknown as UIActions;

      const mockConfig = {
        getAuthType: vi.fn(() => undefined),
        getContentGeneratorConfig: vi.fn(() => ({})),
      } as unknown as Config;

      const { stdin, lastFrame, unmount } = renderWithProviders(
        <UIStateContext.Provider value={mockUIState}>
          <UIActionsContext.Provider value={mockUIActions}>
            <AuthDialog />
          </UIActionsContext.Provider>
        </UIStateContext.Provider>,
        { settings, config: mockConfig },
      );

      await navigateToCustomAdvancedConfig(
        stdin,
        lastFrame,
        'sk-test-key-12345',
        'qwen/qwen3-coder,gpt-4.1',
      );
      await pressEnterAndWaitFor(stdin, lastFrame, 'Step 6/6 · Review');

      await vi.waitFor(() => {
        const frame = lastFrame();
        expect(frame).toContain('Step 6/6 · Review');
        expect(frame).toContain('The following JSON will be saved');
        expect(frame).toContain('QWEN_CUSTOM_API_KEY_OPENAI');
        expect(frame).toContain('qwen/qwen3-coder');
        expect(frame).toContain('gpt-4.1');
        expect(frame).toContain('Enter to save');
      });

      unmount();
    },
  );

  itWhenTuiInputReliable(
    'calls handleCustomApiKeySubmit on Enter in review view',
    async () => {
      const settings = createStandardSettings();
      const handleCustomApiKeySubmit = vi.fn().mockResolvedValue(undefined);

      const mockUIState = {
        authError: null,
        pendingAuthType: undefined,
      } as UIState;

      const mockUIActions = {
        handleAuthSelect: vi.fn(),
        handleCodingPlanSubmit: vi.fn(),
        handleAlibabaStandardSubmit: vi.fn(),
        handleOpenRouterSubmit: vi.fn(),
        handleCustomApiKeySubmit,
        onAuthError: vi.fn(),
        handleRetryLastPrompt: vi.fn(),
      } as unknown as UIActions;

      const mockConfig = {
        getAuthType: vi.fn(() => undefined),
        getContentGeneratorConfig: vi.fn(() => ({})),
      } as unknown as Config;

      const { stdin, lastFrame, unmount } = renderWithProviders(
        <UIStateContext.Provider value={mockUIState}>
          <UIActionsContext.Provider value={mockUIActions}>
            <AuthDialog />
          </UIActionsContext.Provider>
        </UIStateContext.Provider>,
        { settings, config: mockConfig },
      );

      await navigateToCustomAdvancedConfig(
        stdin,
        lastFrame,
        'sk-test',
        'model-1,model-2',
      );
      await pressEnterAndWaitFor(stdin, lastFrame, 'Step 6/6 · Review');

      await vi.waitFor(() => {
        const frame = lastFrame();
        expect(frame).toContain('Enter to save');
      });

      stdin.write('\r'); // Enter to save
      await wait();

      await vi.waitFor(() => {
        expect(handleCustomApiKeySubmit).toHaveBeenCalledWith(
          AuthType.USE_OPENAI,
          'https://api.openai.com/v1',
          'sk-test',
          'model-1,model-2',
          undefined,
        );
      });

      unmount();
    },
  );

  itWhenTuiInputReliable(
    'shows advanced config screen after entering model IDs',
    async () => {
      const settings = createStandardSettings();
      const handleCustomApiKeySubmit = vi.fn();

      const mockUIState = {
        authError: null,
        pendingAuthType: undefined,
      } as UIState;

      const mockUIActions = {
        handleAuthSelect: vi.fn(),
        handleCodingPlanSubmit: vi.fn(),
        handleAlibabaStandardSubmit: vi.fn(),
        handleOpenRouterSubmit: vi.fn(),
        handleCustomApiKeySubmit,
        onAuthError: vi.fn(),
        handleRetryLastPrompt: vi.fn(),
      } as unknown as UIActions;

      const mockConfig = {
        getAuthType: vi.fn(() => undefined),
        getContentGeneratorConfig: vi.fn(() => ({})),
      } as unknown as Config;

      const { stdin, lastFrame, unmount } = renderWithProviders(
        <UIStateContext.Provider value={mockUIState}>
          <UIActionsContext.Provider value={mockUIActions}>
            <AuthDialog />
          </UIActionsContext.Provider>
        </UIStateContext.Provider>,
        { settings, config: mockConfig },
      );

      await navigateToCustomAdvancedConfig(
        stdin,
        lastFrame,
        'sk-test',
        'model-1,model-2',
      );

      await vi.waitFor(() => {
        const frame = lastFrame();
        expect(frame).toContain('Step 5/6 · Advanced Config');
        expect(frame).toContain(
          'Optional: configure advanced generation settings',
        );
        expect(frame).toContain('Enable thinking');
        expect(frame).toContain('Enable modality');
        expect(frame).toContain('Enter to continue');
      });

      unmount();
    },
  );

  itWhenTuiInputReliable(
    'passes generationConfig when advanced options are toggled',
    async () => {
      const settings = createStandardSettings();
      const handleCustomApiKeySubmit = vi.fn().mockResolvedValue(undefined);

      const mockUIState = {
        authError: null,
        pendingAuthType: undefined,
      } as UIState;

      const mockUIActions = {
        handleAuthSelect: vi.fn(),
        handleCodingPlanSubmit: vi.fn(),
        handleAlibabaStandardSubmit: vi.fn(),
        handleOpenRouterSubmit: vi.fn(),
        handleCustomApiKeySubmit,
        onAuthError: vi.fn(),
        handleRetryLastPrompt: vi.fn(),
      } as unknown as UIActions;

      const mockConfig = {
        getAuthType: vi.fn(() => undefined),
        getContentGeneratorConfig: vi.fn(() => ({})),
      } as unknown as Config;

      const { stdin, lastFrame, unmount } = renderWithProviders(
        <UIStateContext.Provider value={mockUIState}>
          <UIActionsContext.Provider value={mockUIActions}>
            <AuthDialog />
          </UIActionsContext.Provider>
        </UIStateContext.Provider>,
        { settings, config: mockConfig },
      );

      await navigateToCustomAdvancedConfig(
        stdin,
        lastFrame,
        'sk-test',
        'model-1',
      );

      await vi.waitFor(() => {
        const frame = lastFrame();
        expect(frame).toContain('Step 5/6 · Advanced Config');
      });

      // Toggle thinking (press Space — thinking is initially focused)
      stdin.write(' ');
      await wait();

      // Navigate down to modality, toggle (press ↓ then Space)
      stdin.write('\u001b[B');
      await wait();
      stdin.write(' ');
      await wait();

      // Press Enter to continue to review
      stdin.write('\r');
      await wait();

      // Verify review includes generationConfig
      await vi.waitFor(() => {
        const frame = lastFrame();
        expect(frame).toContain('"generationConfig"');
        expect(frame).toContain('"enable_thinking"');
        expect(frame).toContain('"image": true');
        expect(frame).toContain('"video": true');
        expect(frame).toContain('"audio": true');
      });

      // Press Enter to save
      stdin.write('\r');
      await wait();

      await vi.waitFor(() => {
        expect(handleCustomApiKeySubmit).toHaveBeenCalledWith(
          AuthType.USE_OPENAI,
          'https://api.openai.com/v1',
          'sk-test',
          'model-1',
          {
            enableThinking: true,
            multimodal: {
              image: true,
              video: true,
              audio: true,
            },
          },
        );
      });

      unmount();
    },
  );
});
