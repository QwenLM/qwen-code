/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { AuthType } from '../core/contentGenerator.js';
import { ToolErrorType } from './tool-error.js';
import { WebSearchTool, evaluateWebSearchGate } from './web-search.js';
import { generateCustomEnvKey } from '../providers/presets/custom-provider.js';
import { findProviderByCredentials } from '../providers/all-providers.js';
import { alibabaStandardProvider } from '../providers/presets/alibaba-standard.js';
import {
  TOKEN_PLAN_CHINA_BASE_URL,
  TOKEN_PLAN_ENV_KEY,
} from '../providers/presets/alibaba-token-plan.js';
import {
  CODING_PLAN_CHINA_BASE_URL,
  CODING_PLAN_ENV_KEY,
} from '../providers/presets/alibaba-coding-plan.js';
import {
  OPENROUTER_BASE_URL,
  OPENROUTER_ENV_KEY,
} from '../providers/presets/openrouter.js';

const mockCreate = vi.hoisted(() => vi.fn());
const mockCtorOpts = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock('openai', () => ({
  default: class MockOpenAI {
    responses = { create: mockCreate };
    constructor(opts: unknown) {
      mockCtorOpts.current = opts;
    }
  },
}));

const TEST_ENV_KEY = 'WEB_SEARCH_TEST_DS_KEY';
const DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';

interface ConfigOverrides {
  allowDynamicHeaderValues?: boolean;
  settings?: {
    enabled?: boolean;
    model?: string;
    webExtractor?: boolean;
    baseUrl?: string;
    apiKeyEnv?: string;
  };
  models?: Array<{
    id: string;
    authType: string;
    envKey?: string;
    baseUrl?: string;
    generationConfig?: { customHeaders?: Record<string, string> };
  }>;
  /** Model id the registry currently has selected (drives the auto path). */
  primaryModel?: string;
  primaryAuthType?: string;
  primaryRegistryBaseUrl?: string;
  /**
   * Resolved generation config, the only source for env-only setups. Mirrors
   * the real shape: a pure env configuration carries no `apiKeyEnvKey`.
   */
  generationConfig?: {
    model?: string;
    authType?: string;
    baseUrl?: string;
    apiKeyEnvKey?: string;
    apiKey?: string;
    customHeaders?: Record<string, string>;
  };
  generationConfigSources?: Record<string, { kind: string; envKey?: string }>;
}

function makeConfig(overrides: ConfigOverrides = {}): Config {
  const models = overrides.models ?? [
    {
      id: 'qwen3.6-plus',
      authType: 'openai',
      envKey: TEST_ENV_KEY,
      baseUrl: DASHSCOPE_BASE_URL,
    },
  ];
  return {
    // `settings: undefined` must mean "nothing configured" (the auto path),
    // which `??` cannot express — check for the key instead.
    getWebSearchSettings: () =>
      'settings' in overrides
        ? overrides.settings
        : { enabled: true, model: 'qwen3.6-plus' },
    // The real Config disambiguates same-id entries by registry baseUrl;
    // mirror that so multi-entry tests resolve the gate-selected entry, not
    // the first (authType, id) match.
    getAllConfiguredModels: (authTypes?: string[]) =>
      models
        .filter((m) => !authTypes || authTypes.includes(m.authType))
        .map((m) => ({ ...m, registryBaseUrl: m.baseUrl })),
    getResolvedModelConfig: (
      authType: string,
      id: string,
      baseUrl?: string,
    ) => {
      const m = models.find(
        (mm) =>
          mm.authType === authType &&
          mm.id === id &&
          (baseUrl === undefined || mm.baseUrl === baseUrl),
      );
      return m
        ? { ...m, generationConfig: m.generationConfig ?? {} }
        : undefined;
    },
    getSessionId: () => 'session-1',
    getOutboundAllowDynamicHeaderValues: () =>
      overrides.allowDynamicHeaderValues ?? false,
    getCliVersion: () => '0.0.0-test',
    getProxy: () => undefined,
    getModel: () => overrides.primaryModel ?? 'main-model',
    getContentGeneratorConfig: () => ({ authType: 'openai' }),
    // The auto path reads the ModelsConfig view, which is populated before
    // `refreshAuth` fills in the content generator config.
    getCurrentAuthType: () =>
      'primaryAuthType' in overrides ? overrides.primaryAuthType : 'openai',
    getCurrentModelRegistryBaseUrl: () => overrides.primaryRegistryBaseUrl,
    getModelsConfig: () => ({
      getGenerationConfig: () => overrides.generationConfig ?? {},
      getGenerationConfigSources: () => overrides.generationConfigSources ?? {},
    }),
    getFastModel: () => undefined,
  } as unknown as Config;
}

function makeStream(events: Array<Record<string, unknown>>) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

function completedEvents(
  output: Array<Record<string, unknown>>,
  usage?: Record<string, unknown>,
  status = 'completed',
): Array<Record<string, unknown>> {
  return [
    { type: 'response.created' },
    ...output.map((item) => ({ type: 'response.output_item.done', item })),
    {
      type: 'response.completed',
      response: { status, output, usage },
    },
  ];
}

const SEARCH_ITEM = {
  type: 'web_search_call',
  status: 'completed',
  action: {
    type: 'search',
    query: 'test query',
    queries: ['test query'],
    sources: [
      { type: 'url', url: 'https://example.com/a' },
      { type: 'url', url: 'https://example.com/b' },
    ],
  },
};

const EXTRACTOR_ITEM = {
  type: 'web_extractor_call',
  status: 'completed',
  urls: ['https://example.com/a'],
  goal: 'verify facts',
  output: 'page content',
};

const MESSAGE_ITEM = {
  type: 'message',
  status: 'completed',
  content: [{ type: 'output_text', text: 'The answer is 42.' }],
};

async function runSearch(config: Config, query = 'test query') {
  const tool = new WebSearchTool(config);
  const invocation = tool.build({ query });
  return invocation.execute(new AbortController().signal);
}

/**
 * Like runSearch, but for tests with fake timers active: starts the
 * invocation, then advances time past the no-search retry backoff so the
 * attempt loop can complete.
 */
async function runSearchWithRetryTimers(config: Config, query = 'test query') {
  const tool = new WebSearchTool(config);
  const invocation = tool.build({ query });
  const promise = invocation.execute(new AbortController().signal);
  await vi.advanceTimersByTimeAsync(3000);
  return promise;
}

beforeEach(() => {
  process.env[TEST_ENV_KEY] = 'sk-test';
  mockCreate.mockReset();
});

afterEach(() => {
  delete process.env[TEST_ENV_KEY];
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('evaluateWebSearchGate', () => {
  it('passes with a fully configured DashScope entry', () => {
    const gate = evaluateWebSearchGate(makeConfig());
    expect(gate.ok).toBe(true);
    if (gate.ok) {
      expect(gate.backend).toEqual({
        kind: 'dashscope',
        modelId: 'qwen3.6-plus',
        apiKeyEnvKey: TEST_ENV_KEY,
        baseUrl: DASHSCOPE_BASE_URL,
        webExtractor: true,
      });
    }
  });

  it('honors webExtractor: false', () => {
    const gate = evaluateWebSearchGate(
      makeConfig({
        settings: { enabled: true, model: 'qwen3.6-plus', webExtractor: false },
      }),
    );
    expect(gate.ok).toBe(true);
    if (gate.ok) {
      expect(gate.backend.webExtractor).toBe(false);
    }
  });

  it('rejects when no model is configured', () => {
    const gate = evaluateWebSearchGate(
      makeConfig({ settings: { enabled: true } }),
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.notice).toContain('no search model');
  });

  it('pins the no-model notice: the example must pass the gate', () => {
    const gate = evaluateWebSearchGate(
      makeConfig({ settings: { enabled: true } }),
    );
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    // The notice is copy-pasteable guidance: round-trip its settings.json
    // block through the gate so a typo or drift fails the suite.
    const start = gate.notice.indexOf('{');
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    let end = -1;
    for (let i = start; i < gate.notice.length; i++) {
      if (gate.notice[i] === '{') depth++;
      else if (gate.notice[i] === '}') {
        depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    expect(end).toBeGreaterThan(start);
    const example = JSON.parse(gate.notice.slice(start, end + 1)) as {
      tools?: { webSearch?: { enabled?: boolean; model?: string } };
      modelProviders?: {
        openai?: Array<{ id?: string; baseUrl?: string; envKey?: string }>;
      };
    };
    const settings = example.tools?.webSearch;
    const entries = example.modelProviders?.openai;
    expect(settings).toBeTruthy();
    expect(settings?.enabled).toBe(true);
    expect(entries).toBeTruthy();
    if (!settings || !entries) return;
    expect(entries.every((entry) => entry.envKey === 'DASHSCOPE_API_KEY')).toBe(
      true,
    );
    expect(entries.every((entry) => entry.baseUrl === DASHSCOPE_BASE_URL)).toBe(
      true,
    );
    const savedKey = process.env['DASHSCOPE_API_KEY'];
    process.env['DASHSCOPE_API_KEY'] = 'sk-test';
    try {
      const oracle = evaluateWebSearchGate(
        makeConfig({
          settings,
          models: entries.map((entry) => ({
            id: entry.id ?? '',
            authType: 'openai',
            envKey: entry.envKey,
            baseUrl: entry.baseUrl,
          })),
        }),
      );
      if (!oracle.ok) {
        throw new Error(`notice example failed the gate: ${oracle.notice}`);
      }
    } finally {
      if (savedKey === undefined) {
        delete process.env['DASHSCOPE_API_KEY'];
      } else {
        process.env['DASHSCOPE_API_KEY'] = savedKey;
      }
    }
    expect(gate.notice).toContain(
      `ENABLE_WEB_SEARCH=true WEB_SEARCH_MODEL=${settings.model}`,
    );
    expect(gate.notice).toContain(`(recommended: ${settings.model})`);
    expect(gate.notice).toContain(`WEB_SEARCH_BASE_URL=${DASHSCOPE_BASE_URL}`);
    expect(gate.notice).toContain('WEB_SEARCH_API_KEY');
  });

  it('rejects a selector that matches no configured model', () => {
    const gate = evaluateWebSearchGate(
      makeConfig({ settings: { enabled: true, model: 'qwen3.9-mega' } }),
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.notice).toContain('does not match any model');
  });

  it('rejects a Qwen OAuth entry', () => {
    const gate = evaluateWebSearchGate(
      makeConfig({
        settings: { enabled: true, model: 'qwen3.6-plus' },
        models: [{ id: 'qwen3.6-plus', authType: 'qwen-oauth' }],
      }),
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.notice).toContain('OAuth');
  });

  it('rejects a non-DashScope endpoint', () => {
    const gate = evaluateWebSearchGate(
      makeConfig({
        models: [
          {
            id: 'qwen3.6-plus',
            authType: 'openai',
            envKey: TEST_ENV_KEY,
            baseUrl: 'https://api.openai.com/v1',
          },
        ],
      }),
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.notice).toContain('non-DashScope');
  });

  it('rejects a plain-http DashScope host, naming HTTPS as the fix', () => {
    // The side request carries a bearer API key; the https-only guard must
    // reject a DashScope hostname served over plaintext HTTP — and the
    // notice must blame the protocol, not the provider.
    const gate = evaluateWebSearchGate(
      makeConfig({
        models: [
          {
            id: 'qwen3.6-plus',
            authType: 'openai',
            envKey: TEST_ENV_KEY,
            baseUrl: 'http://dashscope.aliyuncs.com/compatible-mode/v1',
          },
        ],
      }),
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.notice).toContain('https://');
      expect(gate.notice).not.toContain('non-DashScope');
    }
  });

  it('rejects an entry without envKey', () => {
    const gate = evaluateWebSearchGate(
      makeConfig({
        models: [
          {
            id: 'qwen3.6-plus',
            authType: 'openai',
            baseUrl: DASHSCOPE_BASE_URL,
          },
        ],
      }),
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.notice).toContain('envKey');
  });

  it('rejects when the key env var is unset', () => {
    delete process.env[TEST_ENV_KEY];
    const gate = evaluateWebSearchGate(makeConfig());
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.notice).toContain(TEST_ENV_KEY);
  });

  it('rejects a whitespace-only key env var as unset', () => {
    process.env[TEST_ENV_KEY] = '   ';
    const gate = evaluateWebSearchGate(makeConfig());
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.notice).toContain(TEST_ENV_KEY);
  });

  it('prefers a usable entry when several modelProviders entries share the model id', () => {
    const gate = evaluateWebSearchGate(
      makeConfig({
        models: [
          // Force-sorted-first OAuth entry and a non-DashScope twin must not
          // shadow the usable DashScope entry with the same id.
          { id: 'qwen3.6-plus', authType: 'qwen-oauth' },
          {
            id: 'qwen3.6-plus',
            authType: 'openai',
            envKey: TEST_ENV_KEY,
            baseUrl: 'https://api.openai.com/v1',
          },
          {
            id: 'qwen3.6-plus',
            authType: 'openai',
            envKey: TEST_ENV_KEY,
            baseUrl: DASHSCOPE_BASE_URL,
          },
        ],
      }),
    );
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.backend.baseUrl).toBe(DASHSCOPE_BASE_URL);
  });

  it('accepts an env-declared backend without any modelProviders entry', () => {
    const gate = evaluateWebSearchGate(
      makeConfig({
        settings: {
          enabled: true,
          model: 'qwen3.6-plus',
          baseUrl: DASHSCOPE_BASE_URL,
          apiKeyEnv: TEST_ENV_KEY,
        },
        models: [],
      }),
    );
    expect(gate.ok).toBe(true);
    if (gate.ok) {
      expect(gate.backend).toEqual({
        kind: 'dashscope',
        modelId: 'qwen3.6-plus',
        apiKeyEnvKey: TEST_ENV_KEY,
        baseUrl: DASHSCOPE_BASE_URL,
        webExtractor: true,
      });
    }
  });

  it('env-declared backend takes precedence over modelProviders resolution', () => {
    const gate = evaluateWebSearchGate(
      makeConfig({
        settings: {
          enabled: true,
          model: 'qwen3.6-plus',
          baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
          apiKeyEnv: TEST_ENV_KEY,
        },
        // A conflicting modelProviders entry must be ignored in env mode.
      }),
    );
    expect(gate.ok).toBe(true);
    if (gate.ok) {
      expect(gate.backend.baseUrl).toBe(
        'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      );
    }
  });

  it('rejects a non-DashScope env-declared base URL', () => {
    const gate = evaluateWebSearchGate(
      makeConfig({
        settings: {
          enabled: true,
          model: 'qwen3.6-plus',
          baseUrl: 'https://api.openai.com/v1',
          apiKeyEnv: TEST_ENV_KEY,
        },
      }),
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.notice).toContain('WEB_SEARCH_BASE_URL');
  });

  it('strips an authType prefix from the selector on the env-declared path', () => {
    // A selector written for the modelProviders path ("openai:<id>", as our
    // own OAuth notice suggests) must not be sent verbatim to DashScope when
    // WEB_SEARCH_BASE_URL overrides the backend.
    const gate = evaluateWebSearchGate(
      makeConfig({
        settings: {
          enabled: true,
          model: 'openai:qwen3.6-plus',
          baseUrl: DASHSCOPE_BASE_URL,
          apiKeyEnv: TEST_ENV_KEY,
        },
      }),
    );
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.backend.modelId).toBe('qwen3.6-plus');
  });

  it('rejects a plain-http env-declared base URL, naming HTTPS as the fix', () => {
    const gate = evaluateWebSearchGate(
      makeConfig({
        settings: {
          enabled: true,
          model: 'qwen3.6-plus',
          baseUrl: 'http://dashscope.aliyuncs.com/compatible-mode/v1',
          apiKeyEnv: TEST_ENV_KEY,
        },
      }),
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.notice).toContain('https://');
      expect(gate.notice).not.toContain('not a DashScope-compatible');
    }
  });

  it('rejects an env-declared backend whose key variable is unset', () => {
    const gate = evaluateWebSearchGate(
      makeConfig({
        settings: {
          enabled: true,
          model: 'qwen3.6-plus',
          baseUrl: DASHSCOPE_BASE_URL,
          apiKeyEnv: 'WS_E2E_UNSET_KEY_VAR',
        },
      }),
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.notice).toContain('WS_E2E_UNSET_KEY_VAR');
  });

  it('rejects an env-declared backend when the selector cannot be resolved', () => {
    const gate = evaluateWebSearchGate(
      makeConfig({
        settings: {
          enabled: true,
          model: 'fast',
          baseUrl: DASHSCOPE_BASE_URL,
          apiKeyEnv: TEST_ENV_KEY,
        },
      }),
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.notice).toContain('could not be resolved');
  });

  it('accepts the US regional and Token Plan MaaS endpoints', () => {
    for (const baseUrl of [
      'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
      'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    ]) {
      const gate = evaluateWebSearchGate(
        makeConfig({
          models: [
            {
              id: 'qwen3.6-plus',
              authType: 'openai',
              envKey: TEST_ENV_KEY,
              baseUrl,
            },
          ],
        }),
      );
      expect(gate.ok).toBe(true);
    }
  });

  it('accepts internal Alibaba gateway hosts', () => {
    const gate = evaluateWebSearchGate(
      makeConfig({
        models: [
          {
            id: 'qwen3.6-plus',
            authType: 'openai',
            envKey: TEST_ENV_KEY,
            baseUrl: 'https://gw.some-team.alibaba-inc.com/v1',
          },
        ],
      }),
    );
    expect(gate.ok).toBe(true);
  });
});

describe('evaluateWebSearchGate auto derivation', () => {
  const standardBaseUrls = alibabaStandardProvider.baseUrl;
  if (!Array.isArray(standardBaseUrls)) {
    throw new Error('Standard provider must declare regional base URLs');
  }
  if (typeof alibabaStandardProvider.envKey !== 'string') {
    throw new Error('Standard provider must declare a fixed env key');
  }
  const STANDARD = {
    id: 'qwen3.6-plus',
    authType: AuthType.USE_OPENAI,
    envKey: alibabaStandardProvider.envKey,
    baseUrl: standardBaseUrls[0].url,
  };
  const TOKEN_PLAN = {
    id: 'qwen3.7-plus',
    authType: AuthType.USE_OPENAI,
    envKey: TOKEN_PLAN_ENV_KEY,
    baseUrl: TOKEN_PLAN_CHINA_BASE_URL,
  };
  const CODING_PLAN = {
    id: 'qwen3-coder-plus',
    authType: AuthType.USE_OPENAI,
    envKey: CODING_PLAN_ENV_KEY,
    baseUrl: CODING_PLAN_CHINA_BASE_URL,
  };
  const OPENROUTER = {
    id: 'z-ai/glm-4.5-air:free',
    authType: AuthType.USE_OPENAI,
    envKey: OPENROUTER_ENV_KEY,
    baseUrl: OPENROUTER_BASE_URL,
  };

  /** Config with nothing under tools.webSearch: the auto path. */
  const autoConfig = (
    models: ConfigOverrides['models'],
    primaryModel: string,
    extra: Partial<ConfigOverrides> = {},
  ) => makeConfig({ settings: undefined, models, primaryModel, ...extra });

  it('derives the backend from a Standard API Key entry', () => {
    expect(
      findProviderByCredentials(STANDARD.baseUrl, STANDARD.envKey)?.id,
    ).toBe('alibabaStandard');
    vi.stubEnv(STANDARD.envKey, 'sk-standard');
    const gate = evaluateWebSearchGate(autoConfig([STANDARD], STANDARD.id));
    expect(gate.ok).toBe(true);
    if (gate.ok) {
      expect(gate.backend).toEqual({
        kind: 'dashscope',
        // Not the primary model id: the search runs on the documented
        // search model at the same endpoint.
        modelId: 'qwen3.8-flash',
        apiKeyEnvKey: STANDARD.envKey,
        baseUrl: STANDARD.baseUrl,
        webExtractor: true,
      });
    }
  });

  it('derives the backend from a Token Plan entry', () => {
    expect(
      findProviderByCredentials(TOKEN_PLAN.baseUrl, TOKEN_PLAN.envKey)?.id,
    ).toBe('token-plan');
    vi.stubEnv(TOKEN_PLAN.envKey, 'sk-token-plan');
    const gate = evaluateWebSearchGate(autoConfig([TOKEN_PLAN], TOKEN_PLAN.id));
    expect(gate.ok).toBe(true);
    if (gate.ok) {
      expect(gate.backend.baseUrl).toBe(TOKEN_PLAN.baseUrl);
      expect(gate.backend.modelId).toBe('qwen3.8-flash');
    }
  });

  it('derives the backend for a workspace-specific Token Plan host', () => {
    // Preset matching compares base URLs exactly, so a workspace endpoint
    // matches no preset and must be adopted by the host check instead.
    const workspace = {
      id: 'qwen3.7-plus',
      authType: 'openai',
      envKey: 'WS_WORKSPACE_KEY',
      baseUrl:
        'https://llm-1yxl3y53fm8pcr4z.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    };
    vi.stubEnv(workspace.envKey, 'sk-workspace');
    const gate = evaluateWebSearchGate(autoConfig([workspace], workspace.id));
    expect(gate.ok).toBe(true);
    if (gate.ok) {
      expect(gate.backend.baseUrl).toBe(workspace.baseUrl);
      expect(gate.backend.apiKeyEnvKey).toBe(workspace.envKey);
    }
  });

  it('derives the backend for a hand-written DashScope entry', () => {
    const handWritten = {
      id: 'my-model',
      authType: 'openai',
      envKey: 'MY_DASHSCOPE_KEY',
      baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    };
    vi.stubEnv(handWritten.envKey, 'sk-hand-written');
    const gate = evaluateWebSearchGate(
      autoConfig([handWritten], handWritten.id),
    );
    expect(gate.ok).toBe(true);
  });

  it('derives the backend for a custom-provider entry on a DashScope host', () => {
    // The custom provider matches any endpoint the user typed in, so it must
    // not veto an endpoint the host check would otherwise accept.
    const custom = {
      id: 'my-model',
      authType: 'openai',
      envKey: generateCustomEnvKey(AuthType.USE_OPENAI, DASHSCOPE_BASE_URL),
      baseUrl: DASHSCOPE_BASE_URL,
    };
    vi.stubEnv(custom.envKey, 'sk-custom');
    const gate = evaluateWebSearchGate(autoConfig([custom], custom.id));
    expect(gate.ok).toBe(true);
    if (gate.ok) {
      expect(gate.backend.apiKeyEnvKey).toBe(custom.envKey);
    }
  });

  it('derives the backend from an env-only generation config', () => {
    // The resolver carries the env value plus its source metadata, but no
    // apiKeyEnvKey. The source keeps searches following key rotation.
    vi.stubEnv('OPENAI_API_KEY', 'sk-env-only');
    const gate = evaluateWebSearchGate(
      autoConfig([], 'env-model', {
        generationConfig: {
          model: 'env-model',
          authType: 'openai',
          baseUrl: DASHSCOPE_BASE_URL,
          apiKey: 'sk-env-only',
        },
        generationConfigSources: {
          apiKey: { kind: 'env', envKey: 'OPENAI_API_KEY' },
        },
      }),
    );
    expect(gate.ok).toBe(true);
    if (gate.ok) {
      expect(gate.backend.baseUrl).toBe(DASHSCOPE_BASE_URL);
      expect(gate.backend.apiKeyEnvKey).toBe('OPENAI_API_KEY');
      expect(gate.backend.apiKey).toBeUndefined();
    }
  });

  it('carries a literal primary-model credential into the derived backend', () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const gate = evaluateWebSearchGate(
      autoConfig([], 'env-model', {
        generationConfig: {
          model: 'env-model',
          authType: AuthType.USE_OPENAI,
          baseUrl: DASHSCOPE_BASE_URL,
          apiKey: 'sk-cli-literal',
        },
        generationConfigSources: { apiKey: { kind: 'cli' } },
      }),
    );
    expect(gate.ok).toBe(true);
    if (gate.ok) {
      expect(gate.backend.apiKey).toBe('sk-cli-literal');
      expect(gate.backend.apiKeyEnvKey).toBeUndefined();
    }
  });

  it('uses the generation config env key when deriving a backend', () => {
    vi.stubEnv('PLAN_KEY', 'sk-plan');
    const gate = evaluateWebSearchGate(
      autoConfig([], 'env-model', {
        generationConfig: {
          model: 'env-model',
          authType: AuthType.USE_OPENAI,
          baseUrl: DASHSCOPE_BASE_URL,
          apiKeyEnvKey: 'PLAN_KEY',
        },
      }),
    );
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.backend.apiKeyEnvKey).toBe('PLAN_KEY');
  });

  it('uses a literal credential when a declared env key is unset', () => {
    vi.stubEnv(STANDARD.envKey, '');
    const gate = evaluateWebSearchGate(
      autoConfig([STANDARD], STANDARD.id, {
        primaryRegistryBaseUrl: STANDARD.baseUrl,
        generationConfig: {
          model: STANDARD.id,
          authType: AuthType.USE_OPENAI,
          baseUrl: STANDARD.baseUrl,
          apiKeyEnvKey: STANDARD.envKey,
          apiKey: 'sk-settings-literal',
        },
        generationConfigSources: { apiKey: { kind: 'settings' } },
      }),
    );
    expect(gate.ok).toBe(true);
    if (gate.ok) {
      expect(gate.backend.apiKey).toBe('sk-settings-literal');
      expect(gate.backend.apiKeyEnvKey).toBeUndefined();
    }
  });

  it('forwards custom headers from an env-only generation config', () => {
    const customHeaders = { 'X-DashScope-WorkSpace': 'llm-xyz' };
    const gate = evaluateWebSearchGate(
      autoConfig([], 'env-model', {
        generationConfig: {
          model: 'env-model',
          authType: AuthType.USE_OPENAI,
          baseUrl:
            'https://llm-xyz.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
          apiKey: 'sk-workspace',
          customHeaders,
        },
        generationConfigSources: { apiKey: { kind: 'settings' } },
      }),
    );
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.backend.customHeaders).toEqual(customHeaders);
  });

  it('keeps auto-derived web extraction disabled when requested', () => {
    vi.stubEnv(STANDARD.envKey, 'sk-standard');
    const gate = evaluateWebSearchGate(
      makeConfig({
        settings: { webExtractor: false },
        models: [STANDARD],
        primaryModel: STANDARD.id,
      }),
    );
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.backend.webExtractor).toBe(false);
  });

  it('forwards custom headers from the selected provider entry', () => {
    const model = {
      ...STANDARD,
      generationConfig: { customHeaders: { 'X-Gateway-Route': 'ds' } },
    };
    vi.stubEnv(model.envKey, 'sk-standard');
    const gate = evaluateWebSearchGate(autoConfig([model], model.id));
    expect(gate.ok).toBe(true);
    if (gate.ok) {
      expect(gate.backend.customHeaders).toEqual({ 'X-Gateway-Route': 'ds' });
    }
  });

  it('uses the registry-selected entry when model ids are duplicated', () => {
    const intl = {
      ...STANDARD,
      envKey: 'DASHSCOPE_INTL_KEY',
      baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    };
    vi.stubEnv(STANDARD.envKey, 'sk-standard');
    vi.stubEnv(intl.envKey, 'sk-intl');
    const gate = evaluateWebSearchGate(
      autoConfig([STANDARD, intl], STANDARD.id, {
        primaryRegistryBaseUrl: intl.baseUrl,
      }),
    );
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.backend.baseUrl).toBe(intl.baseUrl);
  });

  it('falls back to the selected generation config instead of a keyed sibling', () => {
    const selected = { ...STANDARD, envKey: undefined };
    const sibling = {
      ...STANDARD,
      envKey: 'DASHSCOPE_INTL_KEY',
      baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    };
    vi.stubEnv(sibling.envKey, 'sk-intl');
    const gate = evaluateWebSearchGate(
      autoConfig([selected, sibling], selected.id, {
        primaryRegistryBaseUrl: selected.baseUrl,
        generationConfig: {
          model: selected.id,
          authType: AuthType.USE_OPENAI,
          baseUrl: selected.baseUrl,
          apiKey: 'sk-selected',
        },
        generationConfigSources: { apiKey: { kind: 'settings' } },
      }),
    );
    expect(gate.ok).toBe(true);
    if (gate.ok) {
      expect(gate.backend.baseUrl).toBe(selected.baseUrl);
      expect(gate.backend.apiKey).toBe('sk-selected');
    }
  });

  it('does not scan other auth types before authentication is selected', () => {
    vi.stubEnv(STANDARD.envKey, 'sk-standard');
    const gate = evaluateWebSearchGate(
      autoConfig([STANDARD], STANDARD.id, {
        primaryAuthType: undefined,
      }),
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.silent).toBe(true);
  });

  it('still uses the selected generation config before authentication is resolved', () => {
    const gate = evaluateWebSearchGate(
      autoConfig([STANDARD], STANDARD.id, {
        primaryAuthType: undefined,
        generationConfig: {
          model: STANDARD.id,
          authType: AuthType.USE_OPENAI,
          baseUrl: STANDARD.baseUrl,
          apiKey: 'sk-selected',
        },
        generationConfigSources: { apiKey: { kind: 'settings' } },
      }),
    );
    expect(gate.ok).toBe(true);
    if (gate.ok) {
      expect(gate.backend.baseUrl).toBe(STANDARD.baseUrl);
      expect(gate.backend.apiKey).toBe('sk-selected');
    }
  });

  it('accepts a non-preset internal Alibaba host on the automatic path', () => {
    const internal = {
      id: 'internal-model',
      authType: AuthType.USE_OPENAI,
      envKey: 'INTERNAL_MODEL_KEY',
      baseUrl: 'https://gw.some-team.alibaba-inc.com/v1',
    };
    vi.stubEnv(internal.envKey, 'sk-internal');
    const gate = evaluateWebSearchGate(autoConfig([internal], internal.id));
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.backend.baseUrl).toBe(internal.baseUrl);
  });

  it('rejects a non-OpenAI primary provider on an accepted host', () => {
    const anthropic = {
      id: 'shared-model',
      authType: AuthType.USE_ANTHROPIC,
      envKey: 'IDEALAB_OPUS_API_KEY',
      baseUrl: 'https://idealab.alibaba-inc.com/api/anthropic',
    };
    vi.stubEnv(anthropic.envKey, 'sk-anthropic');
    const gate = evaluateWebSearchGate(
      autoConfig([anthropic], anthropic.id, {
        primaryAuthType: AuthType.USE_ANTHROPIC,
      }),
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.silent).toBe(true);
  });

  it('uses the primary auth type to disambiguate duplicate model ids', () => {
    const anthropic = {
      id: STANDARD.id,
      authType: AuthType.USE_ANTHROPIC,
      envKey: 'ANTHROPIC_GATEWAY_KEY',
      baseUrl: 'https://gateway.aliyun-inc.com/anthropic',
    };
    vi.stubEnv(STANDARD.envKey, 'sk-standard');
    vi.stubEnv(anthropic.envKey, 'sk-anthropic');
    const gate = evaluateWebSearchGate(
      autoConfig([STANDARD, anthropic], STANDARD.id, {
        primaryAuthType: AuthType.USE_ANTHROPIC,
      }),
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.silent).toBe(true);
  });

  it('never derives a side request from Qwen OAuth credentials', () => {
    const oauth = {
      id: 'qwen3.6-plus',
      authType: AuthType.QWEN_OAUTH,
      envKey: 'API_KEY',
      baseUrl: DASHSCOPE_BASE_URL,
    };
    vi.stubEnv(oauth.envKey, 'oauth-token');
    const gate = evaluateWebSearchGate(
      autoConfig([oauth], oauth.id, {
        primaryAuthType: AuthType.QWEN_OAUTH,
      }),
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.silent).toBe(true);
  });

  it('stays silently off when the env-only key variable is unset', () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const gate = evaluateWebSearchGate(
      autoConfig([], 'env-model', {
        generationConfig: {
          model: 'env-model',
          authType: 'openai',
          baseUrl: DASHSCOPE_BASE_URL,
          apiKey: 'stale-env-value',
        },
        generationConfigSources: {
          apiKey: { kind: 'env', envKey: 'OPENAI_API_KEY' },
        },
      }),
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.silent).toBe(true);
    }
  });

  it('stays silently off for an env-only config on a non-DashScope host', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-env-only');
    const gate = evaluateWebSearchGate(
      autoConfig([], 'env-model', {
        generationConfig: {
          model: 'env-model',
          authType: 'openai',
          baseUrl: 'https://api.openai.com/v1',
        },
      }),
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.silent).toBe(true);
    }
  });

  it('stays silently off on a Coding Plan entry', () => {
    // The preset matches but declares no backend: the endpoint has not been
    // verified to serve the Responses API search tools.
    vi.stubEnv(CODING_PLAN.envKey, 'sk-sp-coding');
    expect(
      findProviderByCredentials(CODING_PLAN.baseUrl, CODING_PLAN.envKey)?.id,
    ).toBe('coding-plan');
    const gate = evaluateWebSearchGate(
      autoConfig([CODING_PLAN], CODING_PLAN.id),
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.silent).toBe(true);
    }
  });

  it('stays silently off on a hand-written Coding Plan host', () => {
    const handWritten = {
      id: 'my-model',
      authType: 'openai',
      envKey: 'MY_CODING_KEY',
      baseUrl: 'https://coding-intl.dashscope.aliyuncs.com/v1',
    };
    vi.stubEnv(handWritten.envKey, 'sk-sp-hand-written');
    const gate = evaluateWebSearchGate(
      autoConfig([handWritten], handWritten.id),
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.silent).toBe(true);
    }
  });

  it('stays silently off on a hand-written China Coding Plan host', () => {
    const handWritten = {
      id: 'my-model',
      authType: AuthType.USE_OPENAI,
      envKey: 'MY_CODING_KEY',
      baseUrl: CODING_PLAN_CHINA_BASE_URL,
    };
    vi.stubEnv(handWritten.envKey, 'sk-sp-hand-written');
    const gate = evaluateWebSearchGate(
      autoConfig([handWritten], handWritten.id),
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.silent).toBe(true);
  });

  it('honors a preset veto even when its host would otherwise be accepted', () => {
    const idealab = {
      id: 'qwen3.6-plus',
      authType: AuthType.USE_OPENAI,
      envKey: 'IDEALAB_API_KEY',
      baseUrl: 'https://idealab.alibaba-inc.com/api/openai/v1',
    };
    vi.stubEnv(idealab.envKey, 'sk-idealab');
    const gate = evaluateWebSearchGate(autoConfig([idealab], idealab.id));
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.notice).toContain(
        'provider "idealab" declares no built-in web search backend',
      );
    }
  });

  it.each([
    [CODING_PLAN.baseUrl + '/', 'ALT_CODING_KEY'],
    ['https://idealab.alibaba-inc.com/api/openai/v1/', 'ALT_IDEALAB_KEY'],
  ])(
    'honors an endpoint preset veto despite credential formatting: %s',
    (baseUrl, envKey) => {
      const entry = {
        id: 'qwen3.6-plus',
        authType: AuthType.USE_OPENAI,
        envKey,
        baseUrl,
      };
      vi.stubEnv(envKey, 'sk-test');
      const gate = evaluateWebSearchGate(autoConfig([entry], entry.id));
      expect(gate.ok).toBe(false);
      if (!gate.ok) expect(gate.silent).toBe(true);
    },
  );

  it('honors an endpoint preset veto for a literal credential', () => {
    const gate = evaluateWebSearchGate(
      autoConfig([], 'qwen3.6-plus', {
        generationConfig: {
          model: 'qwen3.6-plus',
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://idealab.alibaba-inc.com/api/openai/v1',
          apiKey: 'sk-literal',
        },
        generationConfigSources: { apiKey: { kind: 'settings' } },
      }),
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.silent).toBe(true);
  });

  it.each([
    'https://qwen-gw.alicloudapi.com/v1',
    'https://dashscope-proxy.example.com/v1',
  ])(
    'does not assume an unverified proxy host serves search: %s',
    (baseUrl) => {
      const proxy = {
        id: 'qwen3.6-plus',
        authType: AuthType.USE_OPENAI,
        envKey: 'PROXY_KEY',
        baseUrl,
      };
      vi.stubEnv(proxy.envKey, 'sk-proxy');
      const gate = evaluateWebSearchGate(autoConfig([proxy], proxy.id));
      expect(gate.ok).toBe(false);
      if (!gate.ok) expect(gate.silent).toBe(true);
    },
  );

  it('does not expose credentials embedded in an unsupported base URL', () => {
    const unsafe = {
      id: 'qwen3.6-plus',
      authType: AuthType.USE_OPENAI,
      envKey: 'UNSAFE_URL_KEY',
      baseUrl: 'https://user:sk-secret@api.openai.com/v1',
    };
    vi.stubEnv(unsafe.envKey, 'sk-env');
    const gate = evaluateWebSearchGate(autoConfig([unsafe], unsafe.id));
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.notice).not.toContain('sk-secret');
  });

  it('stays silently off on a third-party provider, without falling back to another DashScope entry', () => {
    vi.stubEnv(OPENROUTER.envKey, 'sk-or');
    vi.stubEnv(STANDARD.envKey, 'sk-standard');
    expect(
      findProviderByCredentials(OPENROUTER.baseUrl, OPENROUTER.envKey)?.id,
    ).toBe('openrouter');
    const gate = evaluateWebSearchGate(
      autoConfig([STANDARD, OPENROUTER], OPENROUTER.id),
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.silent).toBe(true);
    }
  });

  it('stays silently off when the entry key variable is unset', () => {
    vi.stubEnv(STANDARD.envKey, '');
    const gate = evaluateWebSearchGate(autoConfig([STANDARD], STANDARD.id));
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.silent).toBe(true);
    }
  });

  it('stays silently off on a plaintext-HTTP DashScope host', () => {
    const insecure = {
      id: 'my-model',
      authType: 'openai',
      envKey: 'MY_INSECURE_KEY',
      baseUrl: 'http://dashscope.aliyuncs.com/compatible-mode/v1',
    };
    vi.stubEnv(insecure.envKey, 'sk-insecure');
    const gate = evaluateWebSearchGate(autoConfig([insecure], insecure.id));
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.silent).toBe(true);
    }
  });

  it('stays silently off when disabled explicitly', () => {
    vi.stubEnv(STANDARD.envKey, 'sk-standard');
    const gate = evaluateWebSearchGate(
      makeConfig({
        settings: { enabled: false },
        models: [STANDARD],
        primaryModel: STANDARD.id,
      }),
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.silent).toBe(true);
    }
  });

  it('still reports the no-model notice when explicitly enabled', () => {
    vi.stubEnv(OPENROUTER.envKey, 'sk-or');
    const gate = evaluateWebSearchGate(
      makeConfig({
        settings: { enabled: true },
        models: [OPENROUTER],
        primaryModel: OPENROUTER.id,
      }),
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.silent).toBeFalsy();
      expect(gate.notice).toContain('no search model');
    }
  });

  it('derives the backend when explicitly enabled without a model', () => {
    vi.stubEnv(STANDARD.envKey, 'sk-standard');
    const gate = evaluateWebSearchGate(
      makeConfig({
        settings: { enabled: true },
        models: [STANDARD],
        primaryModel: STANDARD.id,
      }),
    );
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.backend.modelId).toBe('qwen3.8-flash');
  });

  it('stays silently off instead of throwing when the config surface is incomplete', () => {
    // The gate runs while the tool registry is being built, for whatever
    // Config shape the caller has. A missing accessor must cost web search,
    // not every other tool in the registry.
    const broken = {
      getWebSearchSettings: () => undefined,
      getModel: () => 'some-model',
      getCurrentAuthType: () => 'openai',
      getCurrentModelRegistryBaseUrl: () => undefined,
      getAllConfiguredModels: () => [],
      getModelsConfig: () => ({}),
    } as unknown as Config;
    const gate = evaluateWebSearchGate(broken);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.silent).toBe(true);
    }
  });

  it('reports explicit opt-in when automatic derivation throws', () => {
    const broken = {
      getWebSearchSettings: () => ({ enabled: true }),
      getModel: () => 'some-model',
      getCurrentAuthType: () => 'openai',
      getCurrentModelRegistryBaseUrl: () => undefined,
      getAllConfiguredModels: () => [],
      getModelsConfig: () => ({}),
    } as unknown as Config;
    const gate = evaluateWebSearchGate(broken);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.silent).toBeFalsy();
      expect(gate.notice).toContain('no search model');
    }
  });

  it('does not override a declared env backend when its model is missing', () => {
    vi.stubEnv(STANDARD.envKey, 'sk-standard');
    const gate = evaluateWebSearchGate(
      makeConfig({
        settings: {
          baseUrl: DASHSCOPE_BASE_URL,
          apiKeyEnv: TEST_ENV_KEY,
        },
        models: [STANDARD],
        primaryModel: STANDARD.id,
      }),
    );
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.silent).toBeFalsy();
      expect(gate.notice).toContain('no search model');
    }
  });

  it('prefers an explicitly configured search model over derivation', () => {
    vi.stubEnv(STANDARD.envKey, 'sk-standard');
    const gate = evaluateWebSearchGate(
      makeConfig({
        settings: { model: 'qwen3.7-plus' },
        models: [{ ...STANDARD, id: 'qwen3.7-plus' }],
        primaryModel: 'qwen3.7-plus',
      }),
    );
    expect(gate.ok).toBe(true);
    if (gate.ok) {
      expect(gate.backend.modelId).toBe('qwen3.7-plus');
    }
  });
});

describe('WebSearchTool confirmation', () => {
  it('asks by default, shows the query, and offers the standard always-allow rule', async () => {
    const tool = new WebSearchTool(makeConfig());
    const invocation = tool.build({ query: 'test query' });
    expect(await invocation.getDefaultPermission()).toBe('ask');
    const details = await invocation.getConfirmationDetails(
      new AbortController().signal,
    );
    expect(details && details.type).toBe('info');
    if (details && details.type === 'info') {
      expect(details.prompt).toContain('test query');
      expect(details.hideAlwaysAllow).toBeUndefined();
      // Tool-level rule (queries are free text, no narrower scope exists),
      // consistent with the other tools' persistent-allow behavior.
      expect(details.permissionRules).toEqual(['WebSearch']);
    }
  });
});

describe('WebSearchTool validation', () => {
  it('rejects a query shorter than 2 characters', () => {
    const tool = new WebSearchTool(makeConfig());
    expect(() => tool.build({ query: 'a' })).toThrow(
      /fewer than 2 characters|at least 2 characters/,
    );
  });

  it('rejects a whitespace-only query', () => {
    const tool = new WebSearchTool(makeConfig());
    expect(() => tool.build({ query: '   ' })).toThrow(/at least 2 characters/);
  });
});

describe('WebSearchTool execute', () => {
  it('uses a literal credential derived from the primary model', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    mockCreate.mockResolvedValueOnce(
      makeStream(completedEvents([SEARCH_ITEM, MESSAGE_ITEM])),
    );
    await runSearch(
      makeConfig({
        settings: undefined,
        models: [],
        primaryModel: 'env-model',
        generationConfig: {
          model: 'env-model',
          authType: AuthType.USE_OPENAI,
          baseUrl: DASHSCOPE_BASE_URL,
          apiKey: 'sk-cli-literal',
        },
        generationConfigSources: { apiKey: { kind: 'cli' } },
      }),
    );
    const opts = mockCtorOpts.current as { apiKey: string };
    expect(opts.apiKey).toBe('sk-cli-literal');
  });

  it('returns a structured result with answer, opened pages, candidates, queries, citation policy, and safety footer', async () => {
    mockCreate.mockResolvedValueOnce(
      makeStream(
        completedEvents([SEARCH_ITEM, EXTRACTOR_ITEM, MESSAGE_ITEM], {
          x_tools: { web_search: { count: 1 }, web_extractor: { count: 1 } },
        }),
      ),
    );

    const result = await runSearch(makeConfig());
    expect(result.error).toBeUndefined();
    const content = result.llmContent as string;
    expect(content).toContain('Web search results for query: "test query"');
    expect(content).toContain('The answer is 42.');
    expect(content).toContain('Opened evidence pages');
    expect(content).toContain('https://example.com/a');
    expect(content).toContain('Additional search candidates');
    expect(content).toContain('https://example.com/b');
    expect(content).toContain('Queries executed: test query');
    expect(content).toContain('Citation policy:');
    expect(content).toContain('[Safety:');
    // Opened page must not be repeated in the candidates section.
    const candidatesSection = content.slice(
      content.indexOf('Additional search candidates'),
    );
    expect(candidatesSection).not.toContain('https://example.com/a');
    expect(result.returnDisplay).toMatch(/^Did 1 search in \d+(\.\d+)?s$/);
  });

  it('passes instructions, store:false, and both tools to the backend', async () => {
    mockCreate.mockResolvedValueOnce(
      makeStream(completedEvents([SEARCH_ITEM, MESSAGE_ITEM])),
    );
    await runSearch(makeConfig());
    const params = mockCreate.mock.calls[0][0];
    expect(params.store).toBe(false);
    expect(params.stream).toBe(true);
    expect(params.instructions).toContain('untrusted');
    expect(params.input).toBe('Perform a web search for the query: test query');
    expect(params.tools).toEqual([
      { type: 'web_search' },
      { type: 'web_extractor' },
    ]);
  });

  it('omits web_extractor when disabled', async () => {
    mockCreate.mockResolvedValueOnce(
      makeStream(completedEvents([SEARCH_ITEM, MESSAGE_ITEM])),
    );
    await runSearch(
      makeConfig({
        settings: { enabled: true, model: 'qwen3.6-plus', webExtractor: false },
      }),
    );
    expect(mockCreate.mock.calls[0][0].tools).toEqual([{ type: 'web_search' }]);
  });

  it('merges the resolved entry customHeaders into the search client headers', async () => {
    mockCreate.mockResolvedValueOnce(
      makeStream(completedEvents([SEARCH_ITEM, MESSAGE_ITEM])),
    );
    await runSearch(
      makeConfig({
        models: [
          {
            id: 'qwen3.6-plus',
            authType: 'openai',
            envKey: TEST_ENV_KEY,
            baseUrl: DASHSCOPE_BASE_URL,
            generationConfig: { customHeaders: { 'X-Gateway-Route': 'ds' } },
          },
        ],
      }),
    );
    const opts = mockCtorOpts.current as {
      defaultHeaders: Record<string, string>;
    };
    expect(opts.defaultHeaders['X-Gateway-Route']).toBe('ds');
    expect(opts.defaultHeaders['User-Agent']).toContain('QwenCode/');
  });

  it('installs dynamic header expansion on the search client fetch', async () => {
    mockCreate.mockResolvedValueOnce(
      makeStream(completedEvents([SEARCH_ITEM, MESSAGE_ITEM])),
    );
    const config = makeConfig({
      allowDynamicHeaderValues: true,
      models: [
        {
          id: 'qwen3.6-plus',
          authType: 'openai',
          envKey: TEST_ENV_KEY,
          baseUrl: DASHSCOPE_BASE_URL,
          generationConfig: {
            customHeaders: { 'X-Session': '${session_id}' },
          },
        },
      ],
    });
    const getSessionId = vi.spyOn(config, 'getSessionId');
    await runSearch(config);
    const opts = mockCtorOpts.current as {
      defaultHeaders: Record<string, string>;
      fetch: typeof globalThis.fetch;
    };

    await opts.fetch('data:text/plain,ok', { headers: opts.defaultHeaders });

    expect(getSessionId).toHaveBeenCalledOnce();
  });

  it('truncates an oversized answer while preserving source URLs and the safety footer', async () => {
    const bigText = 'x'.repeat(150_000);
    mockCreate.mockResolvedValueOnce(
      makeStream(
        completedEvents([
          SEARCH_ITEM,
          EXTRACTOR_ITEM,
          {
            type: 'message',
            status: 'completed',
            content: [{ type: 'output_text', text: bigText }],
          },
        ]),
      ),
    );
    const result = await runSearch(makeConfig());
    const content = result.llmContent as string;
    expect(content).toContain('answer truncated to fit');
    // The citation evidence must survive — only the answer text shrinks.
    expect(content).toContain('Opened evidence pages');
    expect(content).toContain('https://example.com/a');
    expect(content).toContain('https://example.com/b');
    expect(content).toContain('Queries executed: test query');
    expect(content).toContain('[Safety:');
    expect(content.length).toBeLessThan(102_000);
  });

  it('does not split a surrogate pair at the truncation boundary', async () => {
    // 60k emoji = 120k UTF-16 code units of non-BMP text; both the answer
    // shrink and the backstop slice must land on a character boundary or the
    // result embeds a lone surrogate that breaks the next request's
    // serialization.
    const bigText = '😀'.repeat(60_000);
    mockCreate.mockResolvedValueOnce(
      makeStream(
        completedEvents([
          SEARCH_ITEM,
          EXTRACTOR_ITEM,
          {
            type: 'message',
            status: 'completed',
            content: [{ type: 'output_text', text: bigText }],
          },
        ]),
      ),
    );
    const result = await runSearch(makeConfig());
    const content = result.llmContent as string;
    expect(content).toContain('answer truncated to fit');
    // No high surrogate without its low surrogate anywhere in the payload.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(content)).toBe(false);
  });

  it('salvages extracted page content as the answer when the stream dies before narration', async () => {
    mockCreate.mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { type: 'response.created' };
        yield { type: 'response.output_item.done', item: SEARCH_ITEM };
        yield { type: 'response.output_item.done', item: EXTRACTOR_ITEM };
        throw new Error('stream reset');
      },
    });
    const result = await runSearch(makeConfig());
    expect(result.error).toBeUndefined();
    const content = result.llmContent as string;
    expect(content).toContain('[Partial result:');
    // EXTRACTOR_ITEM's output/goal back-fill the missing narration.
    expect(content).toContain('page content');
    expect(content).toContain('verify facts');
  });

  it('caps candidate URLs and notes the omission', async () => {
    const manySources = Array.from({ length: 40 }, (_, i) => ({
      type: 'url',
      url: `https://example.com/${i}`,
    }));
    mockCreate.mockResolvedValueOnce(
      makeStream(
        completedEvents([
          {
            ...SEARCH_ITEM,
            action: { ...SEARCH_ITEM.action, sources: manySources },
          },
          MESSAGE_ITEM,
        ]),
      ),
    );
    const result = await runSearch(makeConfig());
    const content = result.llmContent as string;
    expect(content).toContain('15 more candidate URL(s) omitted');
  });

  it('caps opened URLs and notes the omission', async () => {
    const manyOpened = Array.from(
      { length: 30 },
      (_, i) => `https://example.com/opened/${i}`,
    );
    mockCreate.mockResolvedValueOnce(
      makeStream(
        completedEvents([
          SEARCH_ITEM,
          {
            type: 'web_extractor_call',
            status: 'completed',
            urls: manyOpened,
            output: 'content',
          },
          MESSAGE_ITEM,
        ]),
      ),
    );
    const result = await runSearch(makeConfig());
    const content = result.llmContent as string;
    expect(content).toContain('Opened evidence pages');
    expect(content).toContain('https://example.com/opened/24');
    expect(content).not.toContain('https://example.com/opened/25');
    expect(content).toContain('5 more opened page(s) omitted');
  });

  it('maps HTTP 429 to WEB_SEARCH_RATE_LIMITED', async () => {
    mockCreate.mockRejectedValueOnce(
      Object.assign(new Error('Too many requests'), { status: 429 }),
    );
    const result = await runSearch(makeConfig());
    expect(result.error?.type).toBe(ToolErrorType.WEB_SEARCH_RATE_LIMITED);
  });

  it('maps HTTP 400 (unsupported model) to WEB_SEARCH_BACKEND_FAILED with the server message', async () => {
    mockCreate.mockRejectedValueOnce(
      Object.assign(new Error("Unsupported model: 'qwen2.5-7b-instruct'."), {
        status: 400,
      }),
    );
    const result = await runSearch(makeConfig());
    expect(result.error?.type).toBe(ToolErrorType.WEB_SEARCH_BACKEND_FAILED);
    expect(result.error?.message).toContain('Unsupported model');
  });

  it('maps a pre-stream transport failure to WEB_SEARCH_BACKEND_FAILED', async () => {
    mockCreate.mockRejectedValueOnce(new Error('ENOTFOUND'));
    const result = await runSearch(makeConfig());
    expect(result.error?.type).toBe(ToolErrorType.WEB_SEARCH_BACKEND_FAILED);
  });

  it('retries once when no search was performed, then errors with NO_SEARCH_PERFORMED', async () => {
    vi.useFakeTimers();
    mockCreate.mockResolvedValue(makeStream(completedEvents([MESSAGE_ITEM])));
    const result = await runSearchWithRetryTimers(makeConfig());
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result.error?.type).toBe(
      ToolErrorType.WEB_SEARCH_NO_SEARCH_PERFORMED,
    );
  });

  it('succeeds on the retry after an initial no-search response', async () => {
    vi.useFakeTimers();
    mockCreate
      .mockResolvedValueOnce(makeStream(completedEvents([MESSAGE_ITEM])))
      .mockResolvedValueOnce(
        makeStream(completedEvents([SEARCH_ITEM, MESSAGE_ITEM])),
      );
    const result = await runSearchWithRetryTimers(makeConfig());
    expect(result.error).toBeUndefined();
    expect(result.llmContent as string).toContain('The answer is 42.');
  });

  it('does not count a failed search call — retries then reports NO_SEARCH_PERFORMED', async () => {
    vi.useFakeTimers();
    const failedSearch = {
      type: 'web_search_call',
      status: 'failed',
      action: {
        type: 'search',
        queries: ['test query'],
        sources: [{ type: 'url', url: 'https://example.com/failed' }],
      },
    };
    mockCreate.mockResolvedValue(
      makeStream(completedEvents([failedSearch, MESSAGE_ITEM])),
    );
    const result = await runSearchWithRetryTimers(makeConfig());
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result.error?.type).toBe(
      ToolErrorType.WEB_SEARCH_NO_SEARCH_PERFORMED,
    );
  });

  it('ignores a failed search call alongside a completed one', async () => {
    const failedSearch = {
      type: 'web_search_call',
      status: 'failed',
      action: {
        type: 'search',
        queries: ['bad query'],
        sources: [{ type: 'url', url: 'https://example.com/failed' }],
      },
    };
    mockCreate.mockResolvedValueOnce(
      makeStream(completedEvents([failedSearch, SEARCH_ITEM, MESSAGE_ITEM])),
    );
    const result = await runSearch(makeConfig());
    expect(result.error).toBeUndefined();
    const content = result.llmContent as string;
    expect(content).not.toContain('https://example.com/failed');
    expect(content).not.toContain('bad query');
    expect(result.returnDisplay).toMatch(/^Did 1 search in/);
  });

  it('keeps a failed extractor attempt in the candidate tier, not opened evidence', async () => {
    const failedExtractor = {
      type: 'web_extractor_call',
      status: 'failed',
      urls: ['https://example.com/a'],
    };
    mockCreate.mockResolvedValueOnce(
      makeStream(completedEvents([SEARCH_ITEM, failedExtractor, MESSAGE_ITEM])),
    );
    const result = await runSearch(makeConfig());
    expect(result.error).toBeUndefined();
    const content = result.llmContent as string;
    expect(content).not.toContain('Opened evidence pages');
    const candidatesSection = content.slice(
      content.indexOf('Additional search candidates'),
    );
    expect(candidatesSection).toContain('https://example.com/a');
  });

  it('returns NO_RESULTS with the safety footer when the search yields nothing', async () => {
    mockCreate.mockResolvedValueOnce(
      makeStream(
        completedEvents([
          {
            type: 'web_search_call',
            status: 'completed',
            action: { type: 'search', queries: ['test query'], sources: [] },
          },
        ]),
      ),
    );
    const result = await runSearch(makeConfig());
    expect(result.error?.type).toBe(ToolErrorType.WEB_SEARCH_NO_RESULTS);
    expect(result.llmContent as string).toContain('[Safety:');
  });

  it('surfaces a typeless in-stream error event (HTTP 200 + event:error) with the server message', async () => {
    // DashScope shape captured by live probe: no `type`, no `error` wrapper.
    mockCreate.mockResolvedValueOnce(
      makeStream([
        {
          code: 'InvalidParameter',
          message: "Unsupported model: 'qwen2.5-7b-instruct'.",
          request_id: 'req-1',
        },
      ]),
    );
    const result = await runSearch(makeConfig());
    expect(result.error?.type).toBe(ToolErrorType.WEB_SEARCH_BACKEND_FAILED);
    expect(result.error?.message).toContain('InvalidParameter');
    expect(result.error?.message).toContain('Unsupported model');
  });

  it('maps an in-stream Throttling error to WEB_SEARCH_RATE_LIMITED', async () => {
    mockCreate.mockResolvedValueOnce(
      makeStream([
        { code: 'Throttling.RateQuota', message: 'Requests throttled.' },
      ]),
    );
    const result = await runSearch(makeConfig());
    expect(result.error?.type).toBe(ToolErrorType.WEB_SEARCH_RATE_LIMITED);
  });

  it('salvages streamed results when an in-stream error follows an executed search', async () => {
    mockCreate.mockResolvedValueOnce(
      makeStream([
        { type: 'response.created' },
        { type: 'response.output_item.done', item: SEARCH_ITEM },
        { code: 'Throttling.RateQuota', message: 'Requests throttled.' },
      ]),
    );
    const result = await runSearch(makeConfig());
    // The search executed (and billed) before the error — its sources must
    // surface as a partial result, matching the transport-error path.
    expect(result.error).toBeUndefined();
    const content = result.llmContent as string;
    expect(content).toContain('Partial result');
    expect(content).toContain('https://example.com/a');
  });

  it('salvages streamed results when the backend reports the request as failed', async () => {
    mockCreate.mockResolvedValueOnce(
      makeStream([
        { type: 'response.created' },
        { type: 'response.output_item.done', item: SEARCH_ITEM },
        { type: 'response.failed', response: { status: 'failed', output: [] } },
      ]),
    );
    const result = await runSearch(makeConfig());
    // The search executed (and billed) before the backend gave up — its
    // sources must surface as a partial result, same as the in-stream-error
    // and transport-error paths.
    expect(result.error).toBeUndefined();
    const content = result.llmContent as string;
    expect(content).toContain('Partial result');
    expect(content).toContain('https://example.com/a');
  });

  it('handles a response.failed terminal event', async () => {
    mockCreate.mockResolvedValueOnce(
      makeStream([
        { type: 'response.created' },
        {
          type: 'response.failed',
          response: { status: 'failed', output: [] },
        },
      ]),
    );
    const result = await runSearch(makeConfig());
    expect(result.error?.type).toBe(ToolErrorType.WEB_SEARCH_BACKEND_FAILED);
  });

  it('maps a terminal failed status to WEB_SEARCH_BACKEND_FAILED', async () => {
    mockCreate.mockResolvedValueOnce(
      makeStream(completedEvents([], undefined, 'failed')),
    );
    const result = await runSearch(makeConfig());
    expect(result.error?.type).toBe(ToolErrorType.WEB_SEARCH_BACKEND_FAILED);
  });

  it('handles a response.cancelled terminal event with no prior search', async () => {
    mockCreate.mockResolvedValueOnce(
      makeStream([
        { type: 'response.created' },
        {
          type: 'response.cancelled',
          response: { status: 'cancelled', output: [] },
        },
      ]),
    );
    const result = await runSearch(makeConfig());
    expect(result.error?.type).toBe(ToolErrorType.WEB_SEARCH_BACKEND_FAILED);
  });

  it('salvages streamed results when the backend cancels after an executed search', async () => {
    mockCreate.mockResolvedValueOnce(
      makeStream([
        { type: 'response.created' },
        { type: 'response.output_item.done', item: SEARCH_ITEM },
        {
          type: 'response.cancelled',
          response: { status: 'cancelled', output: [] },
        },
      ]),
    );
    const result = await runSearch(makeConfig());
    expect(result.error).toBeUndefined();
    const content = result.llmContent as string;
    expect(content).toContain('Partial result');
    expect(content).toContain('https://example.com/a');
  });

  it('labels an incomplete response as partial', async () => {
    mockCreate.mockResolvedValueOnce(
      makeStream(
        completedEvents([SEARCH_ITEM, MESSAGE_ITEM], undefined, 'incomplete'),
      ),
    );
    const result = await runSearch(makeConfig());
    expect(result.error).toBeUndefined();
    expect(result.llmContent as string).toContain('[Partial result:');
    expect(result.returnDisplay).toContain('(partial result)');
  });

  it('falls back to streamed items when the terminal event omits output', async () => {
    mockCreate.mockResolvedValueOnce(
      makeStream([
        { type: 'response.created' },
        { type: 'response.output_item.done', item: SEARCH_ITEM },
        { type: 'response.output_item.done', item: MESSAGE_ITEM },
        { type: 'response.completed', response: { status: 'completed' } },
      ]),
    );
    const result = await runSearch(makeConfig());
    expect(result.error).toBeUndefined();
    const content = result.llmContent as string;
    expect(content).toContain('The answer is 42.');
    expect(content).toContain('https://example.com/a');
    expect(result.returnDisplay).toMatch(/^Did 1 search in/);
  });

  it('does not report an incomplete response as partial success when no search ran', async () => {
    vi.useFakeTimers();
    mockCreate.mockResolvedValue(
      makeStream(completedEvents([MESSAGE_ITEM], undefined, 'incomplete')),
    );
    const result = await runSearchWithRetryTimers(makeConfig());
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(result.error?.type).toBe(
      ToolErrorType.WEB_SEARCH_NO_SEARCH_PERFORMED,
    );
  });

  it('returns a labeled partial result when the stream dies mid-flight', async () => {
    mockCreate.mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { type: 'response.created' };
        yield { type: 'response.output_item.done', item: SEARCH_ITEM };
        yield { type: 'response.output_text.delta', delta: 'partial answer' };
        throw new Error('stream reset');
      },
    });
    const result = await runSearch(makeConfig());
    expect(result.error).toBeUndefined();
    const content = result.llmContent as string;
    expect(content).toContain('[Partial result:');
    expect(content).toContain('partial answer');
  });

  it('does not salvage a mid-stream partial that contains no executed search', async () => {
    mockCreate.mockResolvedValueOnce({
      async *[Symbol.asyncIterator]() {
        yield { type: 'response.created' };
        yield { type: 'response.output_text.delta', delta: 'unaudited text' };
        throw new Error('stream reset');
      },
    });
    const result = await runSearch(makeConfig());
    expect(result.error?.type).toBe(ToolErrorType.WEB_SEARCH_BACKEND_FAILED);
    expect(result.llmContent as string).not.toContain('unaudited text');
  });

  it('streams progress updates', async () => {
    mockCreate.mockResolvedValueOnce(
      makeStream([
        { type: 'response.created' },
        {
          type: 'response.output_item.added',
          item: {
            type: 'web_search_call',
            action: { queries: ['test query'] },
          },
        },
        { type: 'response.output_item.done', item: SEARCH_ITEM },
        { type: 'response.output_item.done', item: MESSAGE_ITEM },
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [SEARCH_ITEM, MESSAGE_ITEM],
          },
        },
      ]),
    );
    const tool = new WebSearchTool(makeConfig());
    const invocation = tool.build({ query: 'test query' });
    const updates: string[] = [];
    await invocation.execute(new AbortController().signal, (output) => {
      if (typeof output === 'string') updates.push(output);
    });
    expect(updates).toContain('Searching: test query');
    expect(updates).toContain('Found 2 sources');
  });

  it('does not report sources for a failed web_search_call', async () => {
    mockCreate.mockResolvedValueOnce(
      makeStream([
        { type: 'response.created' },
        {
          type: 'response.output_item.done',
          item: {
            type: 'web_search_call',
            status: 'failed',
            action: {
              queries: ['test query'],
              sources: [{ type: 'url', url: 'https://example.com/x' }],
            },
          },
        },
        {
          type: 'response.output_item.done',
          item: SEARCH_ITEM,
        },
        { type: 'response.output_item.done', item: MESSAGE_ITEM },
        {
          type: 'response.completed',
          response: {
            status: 'completed',
            output: [SEARCH_ITEM, MESSAGE_ITEM],
          },
        },
      ]),
    );
    const tool = new WebSearchTool(makeConfig());
    const invocation = tool.build({ query: 'test query' });
    const updates: string[] = [];
    await invocation.execute(new AbortController().signal, (output) => {
      if (typeof output === 'string') updates.push(output);
    });
    // The failed item's sources must not produce a progress update; only
    // the completed SEARCH_ITEM (2 sources) should.
    expect(updates.filter((u) => u.startsWith('Found'))).toEqual([
      'Found 2 sources',
    ]);
  });

  it('fails closed when the gate breaks at execute time', async () => {
    delete process.env[TEST_ENV_KEY];
    const result = await runSearch(makeConfig());
    expect(result.error?.type).toBe(ToolErrorType.WEB_SEARCH_BACKEND_FAILED);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('embeds the current month and year in the schema description', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 21));
    const tool = new WebSearchTool(makeConfig());
    const schema = tool.schema;
    expect(schema.description).toContain('July 2026');
    vi.useRealTimers();
  });
});

describe('WebSearchTool citations', () => {
  it('asks the model to cite bare URLs without titles', async () => {
    mockCreate.mockResolvedValueOnce(
      makeStream(completedEvents([SEARCH_ITEM, EXTRACTOR_ITEM, MESSAGE_ITEM])),
    );
    const content = (await runSearch(makeConfig())).llmContent as string;
    expect(content).toContain('as bare URLs, one per line');
    expect(content).toContain('cannot be verified');
    expect(content).not.toContain('as markdown links');
  });

  it('shows a bare URL citation example in the tool description', () => {
    const description = new WebSearchTool(makeConfig()).schema.description;
    expect(description).toContain(
      '- https://www.cms.gov/files/document/r12951cp.pdf',
    );
    expect(description).toContain('do not wrap them in markdown links');
    expect(description).not.toContain('](https://');
  });
});
