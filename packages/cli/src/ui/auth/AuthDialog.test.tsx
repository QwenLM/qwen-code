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

type UIStateOverrides = Partial<UIState> & Partial<UIState['auth']>;

type UIActionsOverrides = Partial<UIActions> & Partial<UIActions['auth']>;

const createMockUIState = (overrides: UIStateOverrides = {}): UIState => {
  const baseState = {
    auth: {
      authError: null,
      isAuthDialogOpen: false,
      isAuthenticating: false,
      pendingAuthType: undefined,
      externalAuthState: null,
      qwenAuthState: {
        deviceAuth: null,
        authStatus: 'idle',
        authMessage: null,
      },
    },
  } as Partial<UIState>;

  return {
    ...baseState,
    ...overrides,
    auth: {
      ...baseState.auth,
      ...(overrides.auth ?? {}),
      authError: overrides.auth?.authError ?? overrides.authError ?? null,
      pendingAuthType:
        overrides.auth?.pendingAuthType ?? overrides.pendingAuthType,
    },
  } as UIState;
};

const createMockUIActions = (overrides: UIActionsOverrides = {}): UIActions => {
  const { auth, ...topLevelOverrides } = overrides;
  const authActions = {
    handleAuthSelect: vi.fn(),
    handleProviderSubmit: vi.fn(),
    handleOpenRouterSubmit: vi.fn(),
    setAuthState: vi.fn(),
    onAuthError: vi.fn(),
    openAuthDialog: vi.fn(),
    cancelAuthentication: vi.fn(),
    ...auth,
  } as UIActions['auth'];

  for (const key of Object.keys(topLevelOverrides) as Array<
    keyof UIActions['auth']
  >) {
    if (key in authActions) {
      Object.assign(authActions, {
        [key]: topLevelOverrides[key],
      });
      delete topLevelOverrides[key];
    }
  }

  return {
    auth: authActions,
    handleRetryLastPrompt: vi.fn(),
    ...topLevelOverrides,
  } as UIActions;
};

const renderAuthDialog = (
  settings: LoadedSettings,
  uiStateOverrides: UIStateOverrides = {},
  uiActionsOverrides: UIActionsOverrides = {},
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

const WAIT_FOR_TIMEOUT = 5000;

const expectSelectedOption = (frame: string | undefined, label: string) => {
  expect(frame).toMatch(
    new RegExp(`›\\s*(?:\\d+\\.\\s*)?${escapeRegExp(label)}`),
  );
};

const waitForSelectedOption = async (
  lastFrame: () => string | undefined,
  label: string,
) => {
  await vi.waitFor(
    () => {
      expectSelectedOption(lastFrame(), label);
    },
    { timeout: WAIT_FOR_TIMEOUT },
  );
};

const pressEnterAndWaitFor = async (
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined,
  expectedText: string,
) => {
  stdin.write('\r');
  await vi.waitFor(
    () => {
      expect(lastFrame()).toContain(expectedText);
    },
    { timeout: WAIT_FOR_TIMEOUT },
  );
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
  await waitForSelectedOption(lastFrame, 'Alibaba ModelStudio');
  await moveDownAndWaitForSelection(stdin, lastFrame, 'Third-party Providers');
  await moveDownAndWaitForSelection(stdin, lastFrame, 'OAuth');
  await vi.waitFor(
    () => {
      expect(lastFrame()).toContain('Custom Provider');
    },
    { timeout: WAIT_FOR_TIMEOUT },
  );
  stdin.write('\u001b[B');
  await waitForSelectedOption(lastFrame, 'Custom Provider');
  await pressEnterAndWaitFor(
    stdin,
    lastFrame,
    'Custom Provider · Step 1/6 · Protocol',
  );
};

const navigateToCustomBaseUrlInput = async (
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined,
) => {
  await navigateToCustomProtocolSelect(stdin, lastFrame);
  await pressEnterAndWaitFor(
    stdin,
    lastFrame,
    'Custom Provider · Step 2/6 · Base URL',
  );
};

const navigateToCustomApiKeyInput = async (
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined,
) => {
  await navigateToCustomBaseUrlInput(stdin, lastFrame);
  await pressEnterAndWaitFor(
    stdin,
    lastFrame,
    'Custom Provider · Step 3/6 · API Key',
  );
};

const navigateToCustomModelIdInput = async (
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined,
  apiKey = 'sk-test',
) => {
  await navigateToCustomApiKeyInput(stdin, lastFrame);
  await typeText(stdin, apiKey);
  await pressEnterAndWaitFor(
    stdin,
    lastFrame,
    'Custom Provider · Step 4/6 · Model IDs',
  );
};

const navigateToCustomAdvancedConfig = async (
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined,
  apiKey = 'sk-test',
  modelIds = 'model-1,model-2',
) => {
  await navigateToCustomModelIdInput(stdin, lastFrame, apiKey);
  await typeText(stdin, modelIds);
  await pressEnterAndWaitFor(
    stdin,
    lastFrame,
    'Custom Provider · Step 5/6 · Advanced Config',
  );
};

const isUnreliableTuiInputEnvironment =
  process.platform === 'win32' || process.env['CI'] === 'true';
const itWhenTuiInputReliable = isUnreliableTuiInputEnvironment ? it.skip : it;

describe('AuthDialog', { timeout: 15000 }, () => {
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
      auth: {
        ...createMockUIState().auth,
        authError: 'GEMINI_API_KEY  environment variable not found',
      },
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

      // Since the auth dialog shows a third-party provider flow now,
      // it won't show GEMINI_API_KEY messages
      expect(lastFrame()).toContain('Third-party Providers');
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

      // Since the auth dialog shows a third-party provider flow now,
      // it won't show GEMINI_API_KEY messages
      expect(lastFrame()).toContain('Third-party Providers');
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

      // QWEN_OAUTH maps to the OAuth entry in the four-flow main menu
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

      // Default is Alibaba ModelStudio (first option); Qwen OAuth is under OAuth.
      expect(lastFrame()).toContain('Alibaba ModelStudio');
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
      // it will just show the default Alibaba ModelStudio option.
      expect(lastFrame()).toContain('Alibaba ModelStudio');
    });
  });

  // ---------------------------------------------------------------------------
  // TUI input simulation tests — skipped on CI (process.env.CI=true)
  // These tests use stdin.write() to simulate keyboard navigation through
  // multi-step UI flows. On slower CI runners the timing between simulated
  // key presses and React re-renders is unreliable, causing flaky failures.
  // Local dev (macOS) retains full coverage.
  // ---------------------------------------------------------------------------

  itWhenTuiInputReliable(
    'should prevent exiting when no auth method is selected and show error message',
    async () => {
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
      await waitForSelectedOption(lastFrame, 'Alibaba ModelStudio');

      // Simulate pressing escape key
      stdin.write('\u001b'); // ESC key

      // Should show error message instead of calling handleAuthSelect
      await vi.waitFor(
        () => {
          const frame = lastFrame();
          expect(frame).toContain('You must select an auth method');
          expect(frame).toContain('Press Ctrl+C again to exit');
        },
        { timeout: WAIT_FOR_TIMEOUT },
      );
      expect(handleAuthSelect).not.toHaveBeenCalled();
      unmount();
    },
  );

  itWhenTuiInputReliable(
    'should not exit if there is already an error message',
    async () => {
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
        {
          auth: {
            ...createMockUIState().auth,
            authError: 'Initial error',
          },
        },
        { handleAuthSelect },
        undefined, // config.getAuthType() returns undefined
      );
      await vi.waitFor(
        () => {
          expect(lastFrame()).toContain('Initial error');
        },
        { timeout: WAIT_FOR_TIMEOUT },
      );

      // Simulate pressing escape key
      stdin.write('\u001b'); // ESC key
      await wait();

      // Should not call handleAuthSelect
      expect(handleAuthSelect).not.toHaveBeenCalled();
      unmount();
    },
  );

  itWhenTuiInputReliable(
    'should allow exiting when auth method is already selected',
    async () => {
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

      const { stdin, lastFrame, unmount } = renderAuthDialog(
        settings,
        {},
        { handleAuthSelect },
        AuthType.USE_OPENAI, // config.getAuthType() returns USE_OPENAI
      );
      await vi.waitFor(
        () => {
          expect(lastFrame()).toBeTruthy();
        },
        { timeout: WAIT_FOR_TIMEOUT },
      );

      // Simulate pressing escape key
      stdin.write('\u001b'); // ESC key
      await wait();

      // Should call handleAuthSelect with undefined to exit
      expect(handleAuthSelect).toHaveBeenCalledWith(undefined);
      unmount();
    },
  );

  itWhenTuiInputReliable(
    'should preserve the selected main entry when returning from each top-level flow',
    async () => {
      const createSettings = () =>
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

      const cases = [
        {
          label: 'Alibaba ModelStudio',
          childTitle: 'Alibaba ModelStudio · Access Method',
        },
        {
          label: 'Third-party Providers',
          childTitle: 'Third-party Providers · Provider',
        },
        {
          label: 'OAuth',
          childTitle: 'Select OAuth Provider',
        },
        {
          label: 'Custom Provider',
          childTitle: 'Custom Provider · Step 1/6 · Protocol',
        },
      ];

      for (const testCase of cases) {
        const { stdin, lastFrame, unmount } =
          renderAuthDialog(createSettings());

        await waitForSelectedOption(lastFrame, 'Alibaba ModelStudio');
        while (
          !lastFrame()?.match(
            new RegExp(`›\\s*(?:\\d+\\.\\s*)?${escapeRegExp(testCase.label)}`),
          )
        ) {
          stdin.write('\u001b[B');
          await wait();
        }
        await pressEnterAndWaitFor(stdin, lastFrame, testCase.childTitle);
        stdin.write('\u001b');
        await waitForSelectedOption(lastFrame, testCase.label);

        unmount();
      }
    },
  );

  itWhenTuiInputReliable(
    'should go back from Coding Plan region selection to Alibaba ModelStudio',
    async () => {
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

      await waitForSelectedOption(lastFrame, 'Alibaba ModelStudio');
      await pressEnterAndWaitFor(
        stdin,
        lastFrame,
        'Alibaba ModelStudio · Access Method',
      );
      await waitForSelectedOption(lastFrame, 'Coding Plan');
      await pressEnterAndWaitFor(
        stdin,
        lastFrame,
        'Alibaba ModelStudio · Step 1/3 · Region',
      );
      stdin.write('\u001b');

      await vi.waitFor(
        () => {
          const frame = lastFrame();
          expect(frame).toContain('Alibaba ModelStudio');
          expect(frame).toContain('Coding Plan');
          expect(frame).toContain('Token Plan');
        },
        { timeout: WAIT_FOR_TIMEOUT },
      );

      unmount();
    },
  );

  itWhenTuiInputReliable(
    'should go back from third-party provider API key input to provider list',
    async () => {
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

      await waitForSelectedOption(lastFrame, 'Alibaba ModelStudio');
      await moveDownAndWaitForSelection(
        stdin,
        lastFrame,
        'Third-party Providers',
      );
      await pressEnterAndWaitFor(
        stdin,
        lastFrame,
        'Third-party Providers · Provider',
      );
      await waitForSelectedOption(lastFrame, 'DeepSeek API Key');
      await pressEnterAndWaitFor(
        stdin,
        lastFrame,
        'DeepSeek API Key · Step 1/2 · API Key',
      );
      stdin.write('\u001b');

      await vi.waitFor(
        () => {
          const frame = lastFrame();
          expect(frame).toContain('Third-party Providers · Provider');
          expect(frame).toContain('DeepSeek API Key');
        },
        { timeout: WAIT_FOR_TIMEOUT },
      );

      unmount();
    },
  );

  itWhenTuiInputReliable(
    'should show preset providers in third-party provider options',
    async () => {
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

      await waitForSelectedOption(lastFrame, 'Alibaba ModelStudio');
      await moveDownAndWaitForSelection(
        stdin,
        lastFrame,
        'Third-party Providers',
      );
      await pressEnterAndWaitFor(
        stdin,
        lastFrame,
        'Third-party Providers · Provider',
      );

      await vi.waitFor(
        () => {
          const frame = lastFrame();
          expect(frame).toContain('DeepSeek API Key');
          expect(frame).toContain('MiniMax API Key');
          expect(frame).toContain('Z.AI API Key');
          expect(frame).not.toContain('OpenAI API Key');
          expect(frame).not.toContain('HuggingFace API Key');
          expect(frame).not.toContain('Standard API Key');
        },
        { timeout: WAIT_FOR_TIMEOUT },
      );

      unmount();
    },
  );

  itWhenTuiInputReliable(
    'drives API key provider steps from endpoint options metadata',
    async () => {
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

      await waitForSelectedOption(lastFrame, 'Alibaba ModelStudio');
      await moveDownAndWaitForSelection(
        stdin,
        lastFrame,
        'Third-party Providers',
      );
      await pressEnterAndWaitFor(
        stdin,
        lastFrame,
        'Third-party Providers · Provider',
      );
      await waitForSelectedOption(lastFrame, 'DeepSeek API Key');
      await pressEnterAndWaitFor(
        stdin,
        lastFrame,
        'DeepSeek API Key · Step 1/2 · API Key',
      );
      stdin.write('\u001b');
      await vi.waitFor(
        () => {
          expect(lastFrame()).toContain('Third-party Providers · Provider');
        },
        { timeout: WAIT_FOR_TIMEOUT },
      );
      await moveDownAndWaitForSelection(stdin, lastFrame, 'MiniMax API Key');
      await pressEnterAndWaitFor(
        stdin,
        lastFrame,
        'MiniMax API Key · Step 1/3 · Endpoint',
      );

      await vi.waitFor(
        () => {
          const frame = lastFrame();
          expect(frame).toContain('International');
          expect(frame).toContain('China');
        },
        { timeout: WAIT_FOR_TIMEOUT },
      );

      unmount();
    },
  );

  itWhenTuiInputReliable(
    'should show Alibaba ModelStudio access methods after selecting Alibaba ModelStudio',
    async () => {
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

      await waitForSelectedOption(lastFrame, 'Alibaba ModelStudio');
      await pressEnterAndWaitFor(
        stdin,
        lastFrame,
        'Alibaba ModelStudio · Access Method',
      );

      await vi.waitFor(
        () => {
          const frame = lastFrame();
          expect(frame).toContain('Coding Plan');
          expect(frame).toContain('Token Plan');
          expect(frame).toContain(
            'Usage-based billing with dedicated endpoint',
          );
        },
        { timeout: WAIT_FOR_TIMEOUT },
      );

      unmount();
    },
  );

  itWhenTuiInputReliable(
    'should submit Token Plan through the shared subscription handler',
    async () => {
      const handleProviderSubmit = vi.fn().mockResolvedValue(undefined);
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

      const { stdin, lastFrame, unmount } = renderAuthDialog(
        settings,
        {},
        { handleProviderSubmit },
      );

      await waitForSelectedOption(lastFrame, 'Alibaba ModelStudio');
      stdin.write('\r');
      await waitForSelectedOption(lastFrame, 'Coding Plan');
      await moveDownAndWaitForSelection(stdin, lastFrame, 'Token Plan');
      await pressEnterAndWaitFor(
        stdin,
        lastFrame,
        'Alibaba ModelStudio · Step 1/2 · API Key',
      );

      await typeText(stdin, 'sk-token-plan');

      await pressEnterAndWaitFor(
        stdin,
        lastFrame,
        'Alibaba ModelStudio · Step 2/2 · Model IDs',
      );
      stdin.write('\r');
      await vi.waitFor(
        () => {
          expect(handleProviderSubmit).toHaveBeenCalled();
        },
        { timeout: WAIT_FOR_TIMEOUT },
      );

      unmount();
    },
  );

  itWhenTuiInputReliable(
    'should return from Token Plan API key input to Token Plan selection',
    async () => {
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

      await waitForSelectedOption(lastFrame, 'Alibaba ModelStudio');
      stdin.write('\r');
      await waitForSelectedOption(lastFrame, 'Coding Plan');
      await moveDownAndWaitForSelection(stdin, lastFrame, 'Token Plan');
      await pressEnterAndWaitFor(
        stdin,
        lastFrame,
        'Alibaba ModelStudio · Step 1/2 · API Key',
      );
      stdin.write('\u001b');

      await vi.waitFor(
        () => {
          expect(lastFrame()).toContain('Alibaba ModelStudio');
          expectSelectedOption(lastFrame(), 'Token Plan');
        },
        { timeout: WAIT_FOR_TIMEOUT },
      );

      unmount();
    },
  );

  itWhenTuiInputReliable(
    'should trigger OpenRouter OAuth from OAuth provider options',
    async () => {
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

      const { stdin, lastFrame, unmount } = renderAuthDialog(
        settings,
        {},
        { handleOpenRouterSubmit },
      );

      await waitForSelectedOption(lastFrame, 'Alibaba ModelStudio');
      await moveDownAndWaitForSelection(
        stdin,
        lastFrame,
        'Third-party Providers',
      );
      await moveDownAndWaitForSelection(stdin, lastFrame, 'OAuth');
      await pressEnterAndWaitFor(stdin, lastFrame, 'Select OAuth Provider');
      await waitForSelectedOption(lastFrame, 'OpenRouter');
      stdin.write('\r');

      await vi.waitFor(
        () => {
          expect(handleOpenRouterSubmit).toHaveBeenCalledTimes(1);
        },
        { timeout: WAIT_FOR_TIMEOUT },
      );

      unmount();
    },
  );
});

describe('AuthDialog Custom API Key Wizard', { timeout: 15000 }, () => {
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

      const mockUIState = createMockUIState();
      const mockUIActions = createMockUIActions();

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

      await vi.waitFor(
        () => {
          const frame = lastFrame();
          expect(frame).toContain('Custom Provider · Step 1/6 · Protocol');
          expect(frame).toContain('OpenAI-compatible');
          expect(frame).toContain('Anthropic-compatible');
          expect(frame).toContain('Gemini-compatible');
        },
        { timeout: WAIT_FOR_TIMEOUT },
      );

      unmount();
    },
  );

  itWhenTuiInputReliable(
    'navigates to base URL input after selecting a protocol',
    async () => {
      const settings = createStandardSettings();

      const mockUIState = createMockUIState();
      const mockUIActions = createMockUIActions();

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

      await vi.waitFor(
        () => {
          const frame = lastFrame();
          expect(frame).toContain('Custom Provider · Step 2/6 · Base URL');
          expect(frame).toContain('Enter the API endpoint');
        },
        { timeout: WAIT_FOR_TIMEOUT },
      );

      unmount();
    },
  );

  itWhenTuiInputReliable(
    'shows review screen with JSON after entering model IDs',
    async () => {
      const settings = createStandardSettings();

      const mockUIState = createMockUIState();
      const mockUIActions = createMockUIActions();

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
      await pressEnterAndWaitFor(
        stdin,
        lastFrame,
        'Custom Provider · Step 6/6 · Review',
      );

      await vi.waitFor(
        () => {
          const frame = lastFrame();
          expect(frame).toContain('Custom Provider · Step 6/6 · Review');
          expect(frame).toContain('The following JSON will be saved');
          expect(frame).toContain('QWEN_CUSTOM_API_KEY_');
          expect(frame).toContain('qwen/qwen3-coder');
          expect(frame).toContain('gpt-4.1');
          expect(frame).toContain('Enter to save');
        },
        { timeout: WAIT_FOR_TIMEOUT },
      );

      unmount();
    },
  );

  itWhenTuiInputReliable(
    'calls handleProviderSubmit on Enter in review view',
    async () => {
      const settings = createStandardSettings();
      const handleProviderSubmit = vi.fn().mockResolvedValue(undefined);

      const mockUIState = createMockUIState();
      const mockUIActions = createMockUIActions({ handleProviderSubmit });

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
      await pressEnterAndWaitFor(
        stdin,
        lastFrame,
        'Custom Provider · Step 6/6 · Review',
      );

      await vi.waitFor(
        () => {
          const frame = lastFrame();
          expect(frame).toContain('Enter to save');
        },
        { timeout: WAIT_FOR_TIMEOUT },
      );

      stdin.write('\r'); // Enter to save

      await vi.waitFor(
        () => {
          expect(handleProviderSubmit).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'custom-openai-compatible' }),
            expect.objectContaining({
              protocol: AuthType.USE_OPENAI,
              apiKey: 'sk-test',
              modelIds: ['model-1', 'model-2'],
            }),
          );
        },
        { timeout: WAIT_FOR_TIMEOUT },
      );

      unmount();
    },
  );

  itWhenTuiInputReliable(
    'shows advanced config screen after entering model IDs',
    async () => {
      const settings = createStandardSettings();

      const mockUIState = createMockUIState();
      const mockUIActions = createMockUIActions();

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
        expect(frame).toContain('Custom Provider · Step 5/6 · Advanced Config');
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
      const handleProviderSubmit = vi.fn().mockResolvedValue(undefined);

      const mockUIState = createMockUIState();
      const mockUIActions = createMockUIActions({ handleProviderSubmit });

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
        expect(frame).toContain('Custom Provider · Step 5/6 · Advanced Config');
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
        expect(handleProviderSubmit).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'custom-openai-compatible' }),
          expect.objectContaining({
            protocol: AuthType.USE_OPENAI,
            advancedConfig: {
              enableThinking: true,
              multimodal: {
                image: true,
                video: true,
                audio: true,
              },
            },
          }),
        );
      });

      unmount();
    },
  );
});
