/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { render as renderInk } from 'ink';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AuthDialog,
  getExistingProviderSetup,
  getProtocolSetups,
  getMaxItemsToShow,
} from './AuthDialog.js';
import { LoadedSettings } from '../../config/settings.js';
import type { Settings } from '../../config/settingsSchema.js';
import type { Config } from '@qwen-code/qwen-code-core';
import {
  AuthType,
  customProvider,
  findProviderById,
  generateCustomEnvKey,
} from '@qwen-code/qwen-code-core';
import { renderWithProviders } from '../../test-utils/render.js';
import { UIStateContext } from '../contexts/UIStateContext.js';
import { UIActionsContext } from '../contexts/UIActionsContext.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { KeypressProvider } from '../contexts/KeypressContext.js';
import { SettingsContext } from '../contexts/SettingsContext.js';
import { ShellFocusContext } from '../contexts/ShellFocusContext.js';
import type { UIState } from '../contexts/UIStateContext.js';
import type { UIActions } from '../contexts/UIActionsContext.js';

const discoverProviderModelsMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(null),
);

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/qwen-code-core')>()),
  discoverProviderModels: discoverProviderModelsMock,
}));

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
    closeAuthDialog: vi.fn(),
    handleProviderSubmit: vi.fn(),
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
  availableTerminalHeight?: number,
  initialViewLevel?: 'main' | 'alibaba-select' | 'thirdparty-select',
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
        <AuthDialog
          availableTerminalHeight={availableTerminalHeight}
          initialViewLevel={initialViewLevel}
        />
      </UIActionsContext.Provider>
    </UIStateContext.Provider>,
    { settings, config: mockConfig },
  );
};

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

describe('getMaxItemsToShow', () => {
  it('uses pagination only when the available height cannot fit every item', () => {
    expect(getMaxItemsToShow(24, 4, 7)).toBe(4);
    expect(getMaxItemsToShow(18, 6, 7)).toBe(2);
  });

  it('shows every item when the height fits and guards an empty list', () => {
    expect(getMaxItemsToShow(100, 4, 7)).toBe(4);
    expect(getMaxItemsToShow(24, 0, 7)).toBe(1);
  });

  it('clamps to a single item when the floor computation goes non-positive', () => {
    expect(getMaxItemsToShow(12, 6, 7)).toBe(1);
    expect(getMaxItemsToShow(10, 6, 7)).toBe(1);
  });
});

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

const waitForText = async (
  lastFrame: () => string | undefined,
  expectedText: string,
) => {
  await vi.waitFor(
    () => {
      expect(lastFrame()).toContain(expectedText);
    },
    { timeout: WAIT_FOR_TIMEOUT },
  );
};

const pressEnterAndWaitFor = async (
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined,
  expectedText: string,
) => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  stdin.write('\r');
  await vi.waitFor(
    () => {
      expect(lastFrame()).toContain(expectedText);
    },
    { timeout: WAIT_FOR_TIMEOUT },
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
};

const moveDownAndWaitForSelection = async (
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined,
  label: string,
) => {
  await new Promise((resolve) => setTimeout(resolve, 50));
  stdin.write('\u001b[B');
  await waitForSelectedOption(lastFrame, label);
  await new Promise((resolve) => setTimeout(resolve, 50));
};

const navigateToCustomProtocolSelect = async (
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined,
) => {
  await waitForSelectedOption(lastFrame, 'Alibaba ModelStudio');
  await moveDownAndWaitForSelection(stdin, lastFrame, 'Third-party Providers');
  await moveDownAndWaitForSelection(stdin, lastFrame, 'Custom Provider');
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
  it('restores the installed Kimi endpoint instead of the first option', () => {
    const kimi = findProviderById('kimi');
    expect(kimi).toBeDefined();

    const setup = getExistingProviderSetup(kimi!, {
      [AuthType.USE_OPENAI]: [
        {
          id: 'kimi-k3',
          name: '[Kimi API] kimi-k3',
          baseUrl: 'https://api.moonshot.ai/v1',
          envKey: 'MOONSHOT_API_KEY',
        },
      ],
    });

    expect(setup).toEqual({
      initialProtocol: AuthType.USE_OPENAI,
      initialBaseUrl: 'https://api.moonshot.ai/v1',
      customModelIds: [],
      trimmedDefaultModelIds: [
        'kimi-k2.7-code',
        'kimi-k2.7-code-highspeed',
        'kimi-k2.6',
      ],
      modelIdsByBaseUrl: new Map([['https://api.moonshot.ai/v1', ['kimi-k3']]]),
    });
  });

  it("scopes the restored model seed to one endpoint but carries every endpoint's custom entries", () => {
    const kimi = findProviderById('kimi');
    expect(kimi).toBeDefined();

    const codeCustom = {
      id: 'custom-code-model',
      name: '[Kimi Code] custom-code-model',
      baseUrl: 'https://api.kimi.com/coding/v1',
      envKey: 'KIMI_CODE_API_KEY',
      generationConfig: { contextWindowSize: 12345 },
    };
    const apiCustom = {
      id: 'custom-kimi-model',
      name: '[Kimi API] custom-kimi-model',
      baseUrl: 'https://api.moonshot.ai/v1',
      envKey: 'MOONSHOT_API_KEY',
    };
    const setup = getExistingProviderSetup(kimi!, {
      [AuthType.USE_OPENAI]: [
        {
          id: 'k3-256k',
          name: '[Kimi Code] k3-256k',
          baseUrl: 'https://api.kimi.com/coding/v1',
          envKey: 'KIMI_CODE_API_KEY',
        },
        codeCustom,
        {
          id: 'kimi-k3',
          name: '[Kimi API] kimi-k3',
          baseUrl: 'https://api.moonshot.ai/v1',
          envKey: 'MOONSHOT_API_KEY',
        },
        apiCustom,
      ],
    });

    expect(setup).toEqual({
      initialProtocol: AuthType.USE_OPENAI,
      initialBaseUrl: 'https://api.kimi.com/coding/v1',
      customModelIds: ['custom-code-model'],
      trimmedDefaultModelIds: [
        'k3',
        'kimi-for-coding',
        'kimi-for-coding-highspeed',
      ],
      modelIdsByBaseUrl: new Map([
        ['https://api.kimi.com/coding/v1', ['k3-256k', 'custom-code-model']],
        ['https://api.moonshot.ai/v1', ['kimi-k3', 'custom-kimi-model']],
      ]),
      // Every endpoint's custom entries are carried: the user can switch the
      // endpoint field before submitting, and the submitted endpoint's rich
      // entries must survive the rebuild (buildCurrentInputs still filters
      // sibling entries out of the actual submission for merge providers).
      preserveModels: [codeCustom, apiCustom],
    });
  });

  it('restores saved model state for every Kimi endpoint', () => {
    const kimi = findProviderById('kimi');
    expect(kimi).toBeDefined();

    const setup = getExistingProviderSetup(kimi!, {
      [AuthType.USE_OPENAI]: [
        {
          id: 'k3-256k',
          name: '[Kimi Code] k3-256k',
          baseUrl: 'https://api.kimi.com/coding/v1',
          envKey: 'KIMI_CODE_API_KEY',
        },
        {
          id: 'code-custom',
          name: '[Kimi Code] code-custom',
          baseUrl: 'https://api.kimi.com/coding/v1',
          envKey: 'KIMI_CODE_API_KEY',
        },
        {
          id: 'kimi-k3',
          name: '[Kimi API] kimi-k3',
          baseUrl: 'https://api.moonshot.ai/v1',
          envKey: 'MOONSHOT_API_KEY',
        },
        {
          id: 'api-custom',
          name: '[Kimi API] api-custom',
          baseUrl: 'https://api.moonshot.ai/v1',
          envKey: 'MOONSHOT_API_KEY',
        },
      ],
    });

    expect(setup.modelIdsByBaseUrl).toEqual(
      new Map([
        ['https://api.kimi.com/coding/v1', ['k3-256k', 'code-custom']],
        ['https://api.moonshot.ai/v1', ['kimi-k3', 'api-custom']],
      ]),
    );
  });

  it('keeps restored models whose id collides with a sibling endpoint built-in', () => {
    const kimi = findProviderById('kimi');
    expect(kimi).toBeDefined();

    const collidingCustom = {
      id: 'kimi-k3',
      name: '[Kimi Code] kimi-k3',
      baseUrl: 'https://api.kimi.com/coding/v1',
      envKey: 'KIMI_CODE_API_KEY',
    };
    const setup = getExistingProviderSetup(kimi!, {
      [AuthType.USE_OPENAI]: [
        {
          id: 'k3-256k',
          name: '[Kimi Code] k3-256k',
          baseUrl: 'https://api.kimi.com/coding/v1',
          envKey: 'KIMI_CODE_API_KEY',
        },
        collidingCustom,
      ],
    });

    expect(setup).toEqual({
      initialProtocol: AuthType.USE_OPENAI,
      initialBaseUrl: 'https://api.kimi.com/coding/v1',
      // kimi-k3 is a built-in of the *API* endpoints, but this model was saved
      // under the coding endpoint, so it is user data for the restored
      // endpoint and must stay in the seed instead of being deleted on the
      // next no-op resubmit.
      customModelIds: ['kimi-k3'],
      trimmedDefaultModelIds: [
        'k3',
        'kimi-for-coding',
        'kimi-for-coding-highspeed',
      ],
      modelIdsByBaseUrl: new Map([
        ['https://api.kimi.com/coding/v1', ['k3-256k', 'kimi-k3']],
      ]),
      preserveModels: [collidingCustom],
    });
  });

  it('restores legacy provider models without a baseUrl', () => {
    const deepseek = findProviderById('deepseek');
    expect(deepseek).toBeDefined();

    const setup = getExistingProviderSetup(deepseek!, {
      [AuthType.USE_OPENAI]: [
        {
          id: 'deepseek-v4-flash',
          name: '[DeepSeek] deepseek-v4-flash',
          baseUrl: 'https://api.deepseek.com',
          envKey: 'DEEPSEEK_API_KEY',
        },
        {
          id: 'legacy-custom',
          name: '[DeepSeek] legacy-custom',
          envKey: 'DEEPSEEK_API_KEY',
          generationConfig: { contextWindowSize: 54321 },
        },
        {
          id: 'proxy-custom',
          name: '[DeepSeek] proxy-custom',
          baseUrl: 'https://corp-proxy.example/v1',
          envKey: 'DEEPSEEK_API_KEY',
          generationConfig: { contextWindowSize: 12345 },
        },
      ],
    });

    expect(setup.customModelIds).toContain('legacy-custom');
    expect(setup.customModelIds).not.toContain('proxy-custom');
    expect(setup.preserveModels).toEqual([
      {
        id: 'legacy-custom',
        name: '[DeepSeek] legacy-custom',
        baseUrl: 'https://api.deepseek.com',
        envKey: 'DEEPSEEK_API_KEY',
        generationConfig: { contextWindowSize: 54321 },
      },
      {
        id: 'proxy-custom',
        name: '[DeepSeek] proxy-custom',
        baseUrl: 'https://corp-proxy.example/v1',
        envKey: 'DEEPSEEK_API_KEY',
        generationConfig: { contextWindowSize: 12345 },
      },
    ]);
    expect(setup.initialBaseUrl).toBe('https://api.deepseek.com');
  });

  it('preserves a stamped proxy model when the first saved model is legacy', () => {
    const deepseek = findProviderById('deepseek');
    expect(deepseek).toBeDefined();
    const proxyCustom = {
      id: 'proxy-custom',
      name: '[DeepSeek] proxy-custom',
      baseUrl: 'https://corp-proxy.example/v1',
      envKey: 'DEEPSEEK_API_KEY',
      generationConfig: { contextWindowSize: 12345 },
    };

    const setup = getExistingProviderSetup(deepseek!, {
      [AuthType.USE_OPENAI]: [
        {
          id: 'legacy-custom',
          name: '[DeepSeek] legacy-custom',
          envKey: 'DEEPSEEK_API_KEY',
        },
        proxyCustom,
      ],
    });

    expect(setup.initialBaseUrl).toBe('https://api.deepseek.com');
    expect(setup.customModelIds).toEqual(['legacy-custom']);
    expect(setup.preserveModels).toEqual([
      {
        id: 'legacy-custom',
        name: '[DeepSeek] legacy-custom',
        baseUrl: 'https://api.deepseek.com',
        envKey: 'DEEPSEEK_API_KEY',
      },
      proxyCustom,
    ]);
  });

  it('fails attribution closed for shared-key legacy entries in both dialog views (R43-3)', () => {
    // MOONSHOT_API_KEY serves BOTH Kimi api endpoints, so a baseUrl-less
    // entry carrying it fails attribution closed (R41-4). Both dialog views
    // stamped every baseUrl-less entry with the restored endpoint before
    // any attribution check — and getProtocolSetups' list is the one
    // useProviderSetupFlow.start() prefers — so an untouched /auth submit
    // wrote a re-homed stamped copy (re-keyed to the restored endpoint)
    // while the stored original was never claimed: a permanent legacy +
    // stamped duplicate pair. Shared-key entries must be unseeded
    // everywhere: not stamped into preserveModels, not seeded into the
    // models field, and no migratedLegacyModelIds claim.
    const kimi = findProviderById('kimi');
    expect(kimi).toBeDefined();
    const legacyModel = {
      id: 'my-custom',
      name: '[Kimi API] my-custom',
      envKey: 'MOONSHOT_API_KEY',
      generationConfig: { contextWindowSize: 12345 },
    };
    const modelProviders = { [AuthType.USE_OPENAI]: [legacyModel] };

    const setup = getExistingProviderSetup(kimi!, modelProviders);
    expect(setup.preserveModels).toBeUndefined();
    expect(setup.migratedLegacyModelIds).toBeUndefined();
    expect(setup.customModelIds).toEqual([]);
    expect(setup.modelIdsByBaseUrl.size).toBe(0);

    const proto = getProtocolSetups(kimi!, modelProviders);
    expect(proto.preserveModelsByProtocol.size).toBe(0);
    expect(proto.migratedLegacyModelIdsByProtocol.size).toBe(0);
  });

  it('keeps a sibling-attributable legacy entry out of a foreign endpoint seed (R43-3)', () => {
    // KIMI_CODE_API_KEY names the coding endpoint; with an api endpoint
    // restored the entry belongs to the sibling and must not be copied to
    // the endpoint that does not own it.
    const kimi = findProviderById('kimi');
    expect(kimi).toBeDefined();
    const legacyModel = {
      id: 'my-code-custom',
      name: '[Kimi Code] my-code-custom',
      envKey: 'KIMI_CODE_API_KEY',
      generationConfig: { contextWindowSize: 12345 },
    };
    // A stamped api entry fixes the restored endpoint at api-international.
    const stampedApi = {
      id: 'kimi-k3',
      name: '[Kimi API] kimi-k3',
      baseUrl: 'https://api.moonshot.ai/v1',
      envKey: 'MOONSHOT_API_KEY',
    };
    const modelProviders = {
      [AuthType.USE_OPENAI]: [stampedApi, legacyModel],
    };

    const setup = getExistingProviderSetup(kimi!, modelProviders);
    // kimi-k3 is a default id at the restored endpoint, so the stamped
    // entry is regenerated rather than carried; the point here is that the
    // sibling-attributable legacy entry is NOT stamped into this endpoint.
    expect(setup.preserveModels).toBeUndefined();
    expect(setup.migratedLegacyModelIds).toBeUndefined();
    expect(setup.customModelIds).toEqual([]);
    expect(setup.modelIdsByBaseUrl.get('https://api.moonshot.ai/v1')).toEqual([
      'kimi-k3',
    ]);

    const proto = getProtocolSetups(kimi!, modelProviders);
    expect(proto.preserveModelsByProtocol.size).toBe(0);
    expect(proto.migratedLegacyModelIdsByProtocol.size).toBe(0);
  });

  it('stamps attributable legacy entries in both dialog views and emits their ids for collapse (R43-3)', () => {
    // DEEPSEEK_API_KEY is unambiguously the single deepseek endpoint's own
    // key, so the entry is attributable there: seeded stamped, with its id
    // in migratedLegacyModelIds so buildInstallPlan claims the stored
    // original and the pair collapses instead of duplicating.
    const deepseek = findProviderById('deepseek');
    expect(deepseek).toBeDefined();
    const legacyModel = {
      id: 'legacy-custom',
      name: '[DeepSeek] legacy-custom',
      envKey: 'DEEPSEEK_API_KEY',
      generationConfig: { contextWindowSize: 54321 },
    };
    const modelProviders = { [AuthType.USE_OPENAI]: [legacyModel] };
    const stamped = {
      ...legacyModel,
      baseUrl: 'https://api.deepseek.com',
    };

    const setup = getExistingProviderSetup(deepseek!, modelProviders);
    expect(setup.preserveModels).toEqual([stamped]);
    expect(setup.migratedLegacyModelIds).toEqual(['legacy-custom']);

    const proto = getProtocolSetups(deepseek!, modelProviders);
    expect(proto.preserveModelsByProtocol.get(AuthType.USE_OPENAI)).toEqual([
      stamped,
    ]);
    expect(
      proto.migratedLegacyModelIdsByProtocol.get(AuthType.USE_OPENAI),
    ).toEqual(['legacy-custom']);
  });

  it('computes per-protocol preserve for a baseUrl-less-first custom bucket like the flat view', () => {
    // A free-form bucket whose FIRST saved model has no baseUrl resolves the
    // bucket endpoint to '' exactly like the flat view's initialBaseUrl. The
    // per-protocol view used to gate attribution and the preserve
    // computation on protoBaseUrl truthiness while the flat view gated on
    // `initialBaseUrl === undefined` — for '' the flat view computed
    // preserveModels but the per-protocol view produced none, so any
    // protocol switch and back emptied preserveModels at submit while the
    // stamped rich entries' generationConfig was silently reset.
    const floating = {
      id: 'floaty',
      envKey: 'QWEN_CUSTOM_API_KEY_OPENAI', // prefix-only: floating
    };
    const rich = {
      id: 'm1-rich',
      baseUrl: 'https://x.example/v1',
      envKey: generateCustomEnvKey(AuthType.USE_OPENAI, 'https://x.example/v1'),
      generationConfig: { contextWindowSize: 12345 },
    };
    const modelProviders = { [AuthType.USE_OPENAI]: [floating, rich] };

    const flat = getExistingProviderSetup(customProvider, modelProviders);
    expect(flat.initialBaseUrl).toBe('');
    expect(flat.preserveModels).toEqual([rich]);

    const proto = getProtocolSetups(customProvider, modelProviders);
    // Gate aligned: the per-protocol view carries the same rich entry...
    expect(proto.preserveModelsByProtocol.get(AuthType.USE_OPENAI)).toEqual([
      rich,
    ]);
    // ...while '' still stays out of baseUrlByProtocol (R39-4).
    expect(proto.baseUrlByProtocol.has(AuthType.USE_OPENAI)).toBe(false);
    // The floating entry is seeded on neither view.
    expect(flat.customModelIds).toEqual([]);
  });

  it('keeps a stale-URL array-provider entry prefilled under its own URL (no re-keying)', () => {
    // An entry stamped at a URL matching NO preset option (hand-edited
    // settings, an earlier iteration's stamp) must not be re-keyed under
    // the first option in the per-endpoint maps (that polluted the first
    // option's id map through the protocol stash); it is keyed under its
    // own URL and still prefilled, and the submit path migrates it
    // (useProviderSetupFlow stale-stamped handling + buildInstallPlan's
    // stale-stamped claim clause) instead of writing a second copy beside
    // the unclaimed original.
    const kimi = findProviderById('kimi');
    expect(kimi).toBeDefined();
    const staleOriginal = {
      id: 'kimi-k3',
      name: '[Kimi API] kimi-k3',
      baseUrl: 'https://stale.example/v1',
      envKey: 'MOONSHOT_API_KEY',
    };

    const setup = getExistingProviderSetup(kimi!, {
      [AuthType.USE_OPENAI]: [staleOriginal],
    });

    expect(setup.initialBaseUrl).toBe('https://stale.example/v1');
    // Prefilled: the id is user-visible in the models field.
    expect(setup.customModelIds).toEqual(['kimi-k3']);
    // Keyed under its OWN URL — NOT re-keyed under the first option.
    expect(
      setup.modelIdsByBaseUrl.get('https://api.kimi.com/coding/v1'),
    ).toBeUndefined();
    expect(setup.modelIdsByBaseUrl.get('https://stale.example/v1')).toEqual([
      'kimi-k3',
    ]);
    // Carried so the submit path can migrate it.
    expect(setup.preserveModels).toEqual([staleOriginal]);
  });

  it('seeds no trims or customs for a provider without saved models', () => {
    const kimi = findProviderById('kimi');
    expect(kimi).toBeDefined();

    // No saved record at all, and an empty record map: the dialog must not
    // mark every default as previously trimmed (which would empty the Models
    // step and install zero models).
    for (const setup of [
      getExistingProviderSetup(kimi!, undefined),
      getExistingProviderSetup(kimi!, {}),
    ]) {
      expect(setup).toEqual({
        initialProtocol: undefined,
        initialBaseUrl: undefined,
        customModelIds: [],
        trimmedDefaultModelIds: [],
        modelIdsByBaseUrl: new Map(),
      });
    }
  });

  it('computes per-protocol saved views so a protocol switch preserves the selected bucket', () => {
    const proxyUrl = 'https://proxy.example/v1';
    const {
      modelIdsByBaseUrlByProtocol,
      preserveModelsByProtocol,
      baseUrlByProtocol,
    } = getProtocolSetups(customProvider, {
      [AuthType.USE_OPENAI]: [
        {
          id: 'a-oai',
          baseUrl: proxyUrl,
          envKey: 'QWEN_CUSTOM_API_KEY_OPENAI',
        },
        {
          id: 'b-oai',
          baseUrl: proxyUrl,
          envKey: 'QWEN_CUSTOM_API_KEY_OPENAI',
        },
      ],
      [AuthType.USE_ANTHROPIC]: [
        {
          id: 'c-ant',
          baseUrl: proxyUrl,
          envKey: 'QWEN_CUSTOM_API_KEY_ANTHROPIC',
        },
        {
          id: 'd-ant',
          baseUrl: proxyUrl,
          envKey: 'QWEN_CUSTOM_API_KEY_ANTHROPIC',
        },
      ],
    });

    // Each protocol bucket gets its own endpoint→ids view, so the models
    // field can be re-seeded with the selected protocol's own models.
    expect(modelIdsByBaseUrlByProtocol.get(AuthType.USE_OPENAI)).toEqual(
      new Map([[proxyUrl, ['a-oai', 'b-oai']]]),
    );
    expect(modelIdsByBaseUrlByProtocol.get(AuthType.USE_ANTHROPIC)).toEqual(
      new Map([[proxyUrl, ['c-ant', 'd-ant']]]),
    );

    // Each protocol's preserveModels carries that bucket's own custom models
    // (R34-2): switching to Anthropic and submitting must preserve c-ant/
    // d-ant, not the first bucket's a-oai/b-oai.
    expect(preserveModelsByProtocol.get(AuthType.USE_OPENAI)).toEqual([
      { id: 'a-oai', baseUrl: proxyUrl, envKey: 'QWEN_CUSTOM_API_KEY_OPENAI' },
      { id: 'b-oai', baseUrl: proxyUrl, envKey: 'QWEN_CUSTOM_API_KEY_OPENAI' },
    ]);
    expect(preserveModelsByProtocol.get(AuthType.USE_ANTHROPIC)).toEqual([
      {
        id: 'c-ant',
        baseUrl: proxyUrl,
        envKey: 'QWEN_CUSTOM_API_KEY_ANTHROPIC',
      },
      {
        id: 'd-ant',
        baseUrl: proxyUrl,
        envKey: 'QWEN_CUSTOM_API_KEY_ANTHROPIC',
      },
    ]);

    expect(baseUrlByProtocol.get(AuthType.USE_OPENAI)).toBe(proxyUrl);
    expect(baseUrlByProtocol.get(AuthType.USE_ANTHROPIC)).toBe(proxyUrl);
  });

  it('seeds only the restored custom-provider endpoint, ignoring trailing slashes', () => {
    const setup = getExistingProviderSetup(customProvider, {
      [AuthType.USE_OPENAI]: [
        {
          id: 'gpt-oss',
          baseUrl: 'https://y.example/v1',
          envKey: 'QWEN_CUSTOM_API_KEY_OPENAI_Y',
        },
        {
          id: 'llama',
          baseUrl: 'https://x.example/v1',
          envKey: 'QWEN_CUSTOM_API_KEY_OPENAI_X',
        },
        {
          id: 'x-shared-env',
          baseUrl: 'https://x.example/v1',
          envKey: 'QWEN_CUSTOM_API_KEY_OPENAI_Y',
        },
        {
          id: 'y-alias',
          baseUrl: 'https://y.example/v1/',
          envKey: 'QWEN_CUSTOM_API_KEY_OPENAI_Y',
        },
      ],
    });

    expect(setup).toEqual({
      initialProtocol: AuthType.USE_OPENAI,
      initialBaseUrl: 'https://y.example/v1',
      customModelIds: ['gpt-oss', 'y-alias'],
      trimmedDefaultModelIds: [],
      modelIdsByBaseUrl: new Map([
        ['https://y.example/v1', ['gpt-oss', 'y-alias']],
        ['https://x.example/v1', ['llama', 'x-shared-env']],
      ]),
      preserveModels: [
        {
          id: 'gpt-oss',
          baseUrl: 'https://y.example/v1',
          envKey: 'QWEN_CUSTOM_API_KEY_OPENAI_Y',
        },
        {
          id: 'llama',
          baseUrl: 'https://x.example/v1',
          envKey: 'QWEN_CUSTOM_API_KEY_OPENAI_X',
        },
        {
          id: 'x-shared-env',
          baseUrl: 'https://x.example/v1',
          envKey: 'QWEN_CUSTOM_API_KEY_OPENAI_Y',
        },
        {
          id: 'y-alias',
          baseUrl: 'https://y.example/v1/',
          envKey: 'QWEN_CUSTOM_API_KEY_OPENAI_Y',
        },
      ],
    });
  });

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

  it('should paginate the main menu when the dialog height is small', () => {
    const { lastFrame } = renderAuthDialog(
      createSettings(),
      {},
      {},
      undefined,
      undefined,
      17,
    );

    const frame = lastFrame();
    expect(frame?.split('\n')).toHaveLength(17);
    expect(frame).toContain('Alibaba ModelStudio');
    expect(frame).not.toContain('Third-party Providers');
    expect(frame).not.toContain('Custom Provider');
    expect(frame).toContain('▲');
    expect(frame).toContain('▼');
  });

  it('should paginate the provider sub-menu when the dialog height is small', () => {
    const { lastFrame } = renderAuthDialog(
      createSettings(),
      {},
      {},
      undefined,
      undefined,
      17,
      'thirdparty-select',
    );

    const frame = lastFrame();
    expect(frame?.split('\n')).toHaveLength(17);
    expect(frame).toContain('Third-party Providers · Provider');
    expect(frame).toContain('DeepSeek API Key');
    expect(frame).not.toContain('Z.AI API Key');
    expect(frame).toContain('▲');
    expect(frame).toContain('▼');
  });

  it('omits scroll arrows when only one main-menu item fits', () => {
    const { lastFrame } = renderAuthDialog(
      createSettings(),
      {},
      {},
      undefined,
      undefined,
      14,
    );

    const frame = lastFrame();
    expect(frame?.split('\n').length).toBeLessThanOrEqual(14);
    expect(frame).not.toContain('▲');
    expect(frame).not.toContain('▼');
  });

  it('omits scroll arrows when only one provider item fits', () => {
    const { lastFrame } = renderAuthDialog(
      createSettings(),
      {},
      {},
      undefined,
      undefined,
      11,
      'thirdparty-select',
    );

    const frame = lastFrame();
    expect(frame?.split('\n').length).toBeLessThanOrEqual(11);
    expect(frame).not.toContain('▲');
    expect(frame).not.toContain('▼');
  });

  it('keeps a long title on one row in a narrow terminal', async () => {
    const frames: string[] = [];
    const stdout = Object.create(process.stdout, {
      columns: { value: 32 },
      rows: { value: 17 },
      isTTY: { value: true },
      write: {
        value(chunk: string | Uint8Array) {
          frames.push(String(chunk));
          return true;
        },
      },
    }) as NodeJS.WriteStream;
    const settings = createSettings();
    const uiState = createMockUIState();
    const uiActions = createMockUIActions();
    const mockConfig = {
      getAuthType: vi.fn(() => undefined),
      getContentGeneratorConfig: vi.fn(() => ({ apiKey: undefined })),
    } as unknown as Config;
    const instance = renderInk(
      <SettingsContext.Provider value={settings}>
        <ConfigContext.Provider value={mockConfig}>
          <ShellFocusContext.Provider value={true}>
            <KeypressProvider kittyProtocolEnabled={true}>
              <UIStateContext.Provider value={uiState}>
                <UIActionsContext.Provider value={uiActions}>
                  <AuthDialog
                    availableTerminalHeight={17}
                    initialViewLevel="thirdparty-select"
                  />
                </UIActionsContext.Provider>
              </UIStateContext.Provider>
            </KeypressProvider>
          </ShellFocusContext.Provider>
        </ConfigContext.Provider>
      </SettingsContext.Provider>,
      {
        stdout,
        debug: true,
        exitOnCtrlC: false,
        interactive: false,
        patchConsole: false,
      },
    );
    try {
      await vi.waitFor(
        () => {
          expect(
            frames.some((frame) =>
              frame.includes('Third-party Providers · Pro…'),
            ),
          ).toBe(true);
        },
        { timeout: 1000 },
      );
      const lastFrame = frames.findLast((frame) =>
        frame.includes('Third-party Providers · Pro…'),
      );
      expect(lastFrame?.split('\n').length).toBeLessThanOrEqual(17);
      expect(lastFrame).toContain('Third-party Providers · Pro…');
    } finally {
      instance.unmount();
      instance.cleanup();
    }
  });

  it('keeps the main menu within the exact height when an error is shown', () => {
    const { lastFrame } = renderAuthDialog(
      createSettings(),
      { authError: 'Authentication failed' },
      {},
      undefined,
      undefined,
      19,
    );

    const frame = lastFrame();
    expect(frame?.split('\n')).toHaveLength(19);
    expect(frame).toContain('Authentication failed');
    expect(frame).toContain('▲');
    expect(frame).toContain('▼');
  });

  it('keeps a provider sub-menu within the exact height when an error is shown', () => {
    const { lastFrame } = renderAuthDialog(
      createSettings(),
      { authError: `Authentication failed: ${'x'.repeat(200)}` },
      {},
      undefined,
      undefined,
      22,
      'thirdparty-select',
    );

    const frame = lastFrame();
    expect(frame).toContain('Third-party Providers · Provider');
    expect(frame?.split('\n')).toHaveLength(22);
    expect(frame).toContain('Authentication failed');
    expect(frame).toContain('▲');
    expect(frame).toContain('▼');
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

      // QWEN OAuth no longer has a UI entry; the dialog falls back to the
      // default Alibaba ModelStudio option.
      expect(lastFrame()).toContain('Alibaba ModelStudio');
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

      // Default is Alibaba ModelStudio (first option).
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
      const closeAuthDialog = vi.fn();
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
        { closeAuthDialog },
        undefined, // config.getAuthType() returns undefined
      );
      await waitForSelectedOption(lastFrame, 'Alibaba ModelStudio');

      // Simulate pressing escape key
      stdin.write('\u001b'); // ESC key

      // Should show error message instead of calling closeAuthDialog
      await vi.waitFor(
        () => {
          const frame = lastFrame();
          expect(frame).toContain('You must connect a provider to proceed');
          expect(frame).toContain('Press Ctrl+C again to exit');
        },
        { timeout: WAIT_FOR_TIMEOUT },
      );
      expect(closeAuthDialog).not.toHaveBeenCalled();
      unmount();
    },
  );

  itWhenTuiInputReliable(
    'should not exit if there is already an error message',
    async () => {
      const closeAuthDialog = vi.fn();
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
        { closeAuthDialog },
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

      // Should not call closeAuthDialog
      expect(closeAuthDialog).not.toHaveBeenCalled();
      unmount();
    },
  );

  itWhenTuiInputReliable(
    'should allow exiting when auth method is already selected',
    async () => {
      const closeAuthDialog = vi.fn();
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
        { closeAuthDialog },
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

      // Should call closeAuthDialog to exit
      expect(closeAuthDialog).toHaveBeenCalled();
      unmount();
    },
  );

  itWhenTuiInputReliable(
    'should preserve the selected main entry when returning from each top-level flow',
    async () => {
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
    'should limit third-party providers to the available dialog height',
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

      const { stdin, lastFrame, unmount } = renderAuthDialog(
        settings,
        { authError: `Authentication failed: ${'x'.repeat(200)}` },
        {},
        undefined,
        undefined,
        22,
      );

      await waitForSelectedOption(lastFrame, 'Alibaba ModelStudio');
      await wait();
      await moveDownAndWaitForSelection(
        stdin,
        lastFrame,
        'Third-party Providers',
      );
      await wait();
      await pressEnterAndWaitFor(
        stdin,
        lastFrame,
        'Third-party Providers · Provider',
      );
      await wait();

      await vi.waitFor(
        () => {
          const frame = lastFrame();
          expect(frame?.split('\n')).toHaveLength(22);
          expect(frame).toContain('Authentication failed');
          expect(frame).toContain('DeepSeek API Key');
          // 'Idealab API Key' is the real last visible row at this height;
          // Kimi is off-screen and 'Kimi' matched only Idealab's description.
          expect(frame).toContain('Idealab API Key');
          expect(frame).not.toContain('MiniMax API Key');
          expect(frame).not.toContain('Z.AI API Key');
          expect(frame).toContain('▲');
          expect(frame).toContain('▼');
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
      await wait();
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
      await wait();
      for (const label of [
        'Grok (xAI) API Key',
        'Idealab API Key',
        'Kimi',
        'Kimi (Moonshot AI) API Key',
        'MiniMax API Key',
        'ModelScope API Key',
        'OpenRouter',
        'Requesty',
        'Xiaomi MiMo API Key',
        'Z.AI API Key',
      ]) {
        await moveDownAndWaitForSelection(stdin, lastFrame, label);
        await wait();
      }
      await pressEnterAndWaitFor(
        stdin,
        lastFrame,
        'Z.AI API Key · Step 1/3 · Endpoint',
      );

      await vi.waitFor(
        () => {
          const frame = lastFrame();
          expect(frame).toContain('Standard API Key');
          expect(frame).toContain('Coding Plan');
        },
        { timeout: WAIT_FOR_TIMEOUT },
      );

      unmount();
    },
  );

  itWhenTuiInputReliable(
    'opens the setup flow at the restored Kimi endpoint',
    async () => {
      const userSettings = {
        security: { auth: { selectedType: undefined } },
        ui: { customThemes: {} },
        mcpServers: {},
        modelProviders: {
          [AuthType.USE_OPENAI]: [
            {
              id: 'kimi-k3',
              name: '[Kimi API] kimi-k3',
              baseUrl: 'https://api.moonshot.ai/v1',
              envKey: 'MOONSHOT_API_KEY',
            },
          ],
        },
      } as Settings;
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
          settings: userSettings,
          originalSettings: userSettings,
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
      for (const label of ['Grok (xAI) API Key', 'Idealab API Key', 'Kimi']) {
        await moveDownAndWaitForSelection(stdin, lastFrame, label);
        await wait();
      }
      // The setup flow must open at the endpoint step with the restored
      // API Key (International) option highlighted, not the first option.
      await pressEnterAndWaitFor(
        stdin,
        lastFrame,
        'Kimi · Step 1/3 · Access type',
      );
      await waitForSelectedOption(lastFrame, 'API Key (International)');

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
        'Alibaba ModelStudio · Step 1/3 · Region',
      );
      await pressEnterAndWaitFor(
        stdin,
        lastFrame,
        'Alibaba ModelStudio · Step 2/3 · API Key',
      );

      await typeText(stdin, 'sk-token-plan');

      await pressEnterAndWaitFor(
        stdin,
        lastFrame,
        'Alibaba ModelStudio · Step 3/3 · Model IDs',
      );
      await waitForText(lastFrame, 'Enter model IDs directly');
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
    'should pre-fill the Model IDs step with previously saved custom model IDs',
    async () => {
      // User previously saved a custom model ID for Token Plan in settings.
      const savedSettings = {
        security: { auth: { selectedType: undefined } },
        ui: { customThemes: {} },
        mcpServers: {},
        modelProviders: {
          openai: [
            {
              id: 'my-custom-token-model',
              name: '[ModelStudio Token Plan] my-custom-token-model',
              baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
              envKey: 'BAILIAN_TOKEN_PLAN_API_KEY',
            },
          ],
        },
      } as unknown as Settings;
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
          settings: savedSettings,
          originalSettings: savedSettings,
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
        'Alibaba ModelStudio · Step 1/3 · Region',
      );
      await pressEnterAndWaitFor(
        stdin,
        lastFrame,
        'Alibaba ModelStudio · Step 2/3 · API Key',
      );

      await typeText(stdin, 'sk-token-plan');

      await pressEnterAndWaitFor(
        stdin,
        lastFrame,
        'Alibaba ModelStudio · Step 3/3 · Model IDs',
      );
      await waitForText(lastFrame, 'Enter model IDs directly');

      // The Model IDs input is pre-filled with the saved custom model id
      // (which only exists in settings, never among the built-in defaults).
      expect(lastFrame()).toContain('my-custom-token-model');

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
        'Alibaba ModelStudio · Step 1/3 · Region',
      );
      await pressEnterAndWaitFor(
        stdin,
        lastFrame,
        'Alibaba ModelStudio · Step 2/3 · API Key',
      );
      stdin.write('\u001b');

      await vi.waitFor(
        () => {
          expect(lastFrame()).toContain(
            'Alibaba ModelStudio · Step 1/3 · Region',
          );
        },
        { timeout: WAIT_FOR_TIMEOUT },
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

      // Verify review includes generationConfig (audio is off by default)
      await vi.waitFor(() => {
        const frame = lastFrame();
        expect(frame).toContain('"generationConfig"');
        expect(frame).toContain('"enable_thinking"');
        expect(frame).toContain('"image": true');
        expect(frame).toContain('"video": true');
        expect(frame).not.toContain('"audio"');
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
              },
            },
          }),
        );
      });

      unmount();
    },
  );
});
