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

  it('navigates to protocol selection when Custom API Key is selected', async () => {
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
    await wait();

    // Press down twice to select API Key (from default OAUTH, down once wraps to CODING_PLAN, down again to API_KEY)
    stdin.write('\u001b[B'); // Down from OAUTH -> CODING_PLAN
    await wait();
    stdin.write('\u001b[B'); // Down from CODING_PLAN -> API_KEY
    await wait();
    stdin.write('\r'); // Enter
    await wait();

    // Now on api-key-type-select,Encoding we need to see both options
    await vi.waitFor(() => {
      const frame = lastFrame();
      expect(frame).toContain('Custom API Key');
    });

    // Select Custom API Key (second option)
    stdin.write('\u001b[B'); // Down arrow
    await wait();
    stdin.write('\r'); // Enter
    await wait();

    await vi.waitFor(() => {
      const frame = lastFrame();
      expect(frame).toContain('Step 1/6 · Protocol');
      expect(frame).toContain('OpenAI-compatible');
      expect(frame).toContain('Anthropic-compatible');
      expect(frame).toContain('Gemini-compatible');
    });

    unmount();
  });

  it('navigates to base URL input after selecting a protocol', async () => {
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
    await wait();

    // Navigate: Main -> API Key Type -> Custom API Key -> Protocol select
    stdin.write('\u001b[B'); // Down from OAUTH -> CODING_PLAN
    await wait();
    stdin.write('\u001b[B'); // Down from CODING_PLAN -> API_KEY
    await wait();
    stdin.write('\r'); // Enter
    await wait();
    stdin.write('\u001b[B'); // Down to Custom API Key
    await wait();
    stdin.write('\r'); // Enter -> protocol select
    await wait();

    // Now at protocol selection. First option is OpenAI. Press Enter
    stdin.write('\r'); // Enter -> select OpenAI protocol
    await wait();

    await vi.waitFor(() => {
      const frame = lastFrame();
      expect(frame).toContain('Step 2/6 · Base URL');
      expect(frame).toContain('Enter the API endpoint');
    });

    unmount();
  });

  it('shows review screen with JSON after entering model IDs', async () => {
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
    await wait();

    // Navigate through the wizard:
    // Main -> API Key -> Custom API Key -> Protocol -> Base URL -> API Key -> Model IDs -> Review
    stdin.write('\u001b[B');
    await wait(); // OAUTH -> CODING_PLAN
    stdin.write('\u001b[B');
    await wait(); // CODING_PLAN -> API_KEY
    stdin.write('\r');
    await wait(); // -> api-key-type-select
    stdin.write('\u001b[B');
    await wait(); // Custom API Key
    stdin.write('\r');
    await wait(); // -> protocol select

    // Default protocol is OpenAI, press Enter
    stdin.write('\r');
    await wait(); // -> base URL input

    // Base URL is pre-filled with default. Submit it.
    stdin.write('\r');
    await wait(); // -> API key input

    // Enter test API key
    stdin.write('sk-test-key-12345');
    await wait();
    stdin.write('\r');
    await wait(); // -> model IDs input

    // Enter model IDs
    stdin.write('qwen/qwen3-coder,gpt-4.1');
    await wait();
    stdin.write('\r');
    await wait(); // -> advanced config

    // Press Enter to skip advanced config (use defaults)
    stdin.write('\r');
    await wait(); // -> review

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
  });

  it('calls handleCustomApiKeySubmit on Enter in review view', async () => {
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
    await wait();

    // Navigate through wizard
    stdin.write('\u001b[B');
    await wait(); // OAUTH -> CODING_PLAN
    stdin.write('\u001b[B');
    await wait(); // CODING_PLAN -> API_KEY
    stdin.write('\r');
    await wait();
    stdin.write('\u001b[B');
    await wait(); // Custom
    stdin.write('\r');
    await wait();

    stdin.write('\r');
    await wait(); // protocol (OpenAI default)
    stdin.write('\r');
    await wait(); // base URL (default)
    stdin.write('sk-test');
    await wait();
    stdin.write('\r');
    await wait(); // API key

    stdin.write('model-1,model-2');
    await wait();
    stdin.write('\r');
    await wait(); // model IDs -> advanced config

    // Press Enter to skip advanced config (use defaults)
    stdin.write('\r');
    await wait(); // advanced config -> review

    // We're now at review screen. Verify and press Enter
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
  });

  it('shows advanced config screen after entering model IDs', async () => {
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
    await wait();

    // Quick nav: main -> api-key-type-select -> custom -> protocol -> base-url -> api-key -> model-id -> advanced
    stdin.write('\u001b[B');
    await wait();
    stdin.write('\u001b[B');
    await wait();
    stdin.write('\r');
    await wait();
    stdin.write('\u001b[B');
    await wait();
    stdin.write('\r');
    await wait();
    stdin.write('\r');
    await wait();
    stdin.write('\r');
    await wait();
    stdin.write('sk-test');
    await wait();
    stdin.write('\r');
    await wait();
    stdin.write('model-1,model-2');
    await wait();
    stdin.write('\r');
    await wait();

    // Should be at advanced config
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
  });

  it('passes generationConfig when advanced options are toggled', async () => {
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
    await wait();

    // Quick nav to advanced config
    stdin.write('\u001b[B');
    await wait();
    stdin.write('\u001b[B');
    await wait();
    stdin.write('\r');
    await wait();
    stdin.write('\u001b[B');
    await wait();
    stdin.write('\r');
    await wait();
    stdin.write('\r');
    await wait();
    stdin.write('\r');
    await wait();
    stdin.write('sk-test');
    await wait();
    stdin.write('\r');
    await wait();
    stdin.write('model-1');
    await wait();
    stdin.write('\r');
    await wait();

    // At advanced config screen
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
  });
});
