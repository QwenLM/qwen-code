import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModelsConfig } from '@qwen-code/qwen-code-core/models/modelsConfig.js';
import { loadSettings } from '../config/settings.js';
import {
  loadManagedLocalModels,
  registerManagedLocalModels,
} from './managed-local-models.js';

vi.mock('../config/settings.js', () => ({ loadSettings: vi.fn() }));

const options = {
  javaUrl: 'http://127.0.0.1:5011',
  signingKey: 'private-signing-key',
  tenantId: 'local-installation',
  actorId: 'owner',
};
const agentId = 'agent_0123456789abcdef0123456789abcdef';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('local Managed model catalog', () => {
  beforeEach(() => {
    vi.mocked(loadSettings).mockReturnValue({ merged: {} } as ReturnType<
      typeof loadSettings
    >);
  });

  it('uses deployment settings and returns only unique conversation model IDs and labels', () => {
    const merged = {
      model: { name: 'selected' },
      security: { auth: { selectedType: 'openai' } },
      providerProtocol: { custom: 'openai' },
      modelProviders: {
        custom: [
          { id: 'other', apiKey: 'secret-key', baseUrl: 'https://private/v1' },
          { id: 'selected', name: 'Selected model' },
          { id: 'shared', baseUrl: 'https://one/v1' },
          { id: 'shared', baseUrl: 'https://two/v1' },
          { id: 'cross-wire' },
          { id: 'fast', fastOnly: true },
          { id: 'image', imageOnly: true },
          { id: 'vision', visionOnly: true },
          { id: 'voice', voiceOnly: true },
          { id: 'realtime', realtimeOnly: true },
        ],
        anthropic: [{ id: 'cross-wire' }],
      },
    };
    vi.mocked(loadSettings).mockReturnValue({ merged } as unknown as ReturnType<
      typeof loadSettings
    >);
    expect(loadManagedLocalModels()).toEqual({
      defaultModelId: 'selected',
      models: [
        { modelId: 'selected', label: 'Selected model' },
        { modelId: 'other', label: 'other' },
      ],
    });
    expect(loadSettings).toHaveBeenCalledWith(process.cwd(), {
      skipLoadEnvironment: true,
      skipWorkspaceSettings: true,
      workspaceTrusted: false,
    });
    const harnessModels = new ModelsConfig({
      modelProvidersConfig: merged.modelProviders,
      providerProtocolConfig: merged.providerProtocol,
    }).getAllConfiguredModels();
    for (const model of loadManagedLocalModels().models) {
      expect(
        harnessModels.filter((entry) => entry.id === model.modelId),
      ).toHaveLength(1);
    }
  });

  it('keeps the existing default fallback when no provider models are configured', () => {
    expect(loadManagedLocalModels()).toEqual({
      models: [],
      defaultModelId: undefined,
    });
  });

  it.each(['qwen-oauth', 'openai'])(
    'keeps an unmatched %s default instead of silently selecting another provider',
    (authType) => {
      vi.mocked(loadSettings).mockReturnValue({
        merged: {
          security: { auth: { selectedType: authType } },
          model: { name: 'default-not-in-catalog' },
          modelProviders: { openai: [{ id: 'other' }] },
        },
      } as unknown as ReturnType<typeof loadSettings>);
      expect(loadManagedLocalModels()).toEqual({
        models: [{ modelId: 'other', label: 'other' }],
        defaultModelId: undefined,
      });
    },
  );

  it('recognizes an environment-selected configured model using the CLI resolver', () => {
    vi.stubEnv('OPENAI_MODEL', 'model-b');
    vi.mocked(loadSettings).mockReturnValue({
      merged: {
        security: { auth: { selectedType: 'openai' } },
        modelProviders: { openai: [{ id: 'model-a' }, { id: 'model-b' }] },
      },
    } as unknown as ReturnType<typeof loadSettings>);
    expect(loadManagedLocalModels()).toEqual({
      models: [
        { modelId: 'model-b', label: 'model-b' },
        { modelId: 'model-a', label: 'model-a' },
      ],
      defaultModelId: 'model-b',
    });
  });
});

describe('local model presets', () => {
  it('creates model-pinned shell definitions through signed, replayable private requests', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ id: agentId }, { status: 202 }),
    );
    vi.stubGlobal('fetch', fetch);
    const models = [{ modelId: 'model-b', label: 'Model B' }];
    expect(await registerManagedLocalModels(options, models)).toEqual([
      { agentId, label: 'Model B' },
    ]);
    await registerManagedLocalModels(options, [
      { ...models[0]!, label: 'Renamed' },
    ]);
    const [url, request] = fetch.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${options.javaUrl}/v1/agents`);
    expect(JSON.parse(String(request.body))).toEqual({
      model: { id: 'model-b' },
      instructions: '',
      tools: [{ type: 'hosted_profile', profile: 'hosted-workspace-shell/1' }],
      permission_policy: { approval_mode: 'default' },
    });
    const headers = new Headers(request.headers);
    expect(headers.get('x-qwen-signature')).toMatch(/^v1=/u);
    expect(headers.get('x-qwen-tenant-id')).toBe(options.tenantId);
    expect(headers.get('idempotency-key')).toBe(
      new Headers(
        (fetch.mock.calls[1] as unknown as [string, RequestInit])[1].headers,
      ).get('idempotency-key'),
    );
    expect(String(request.body)).not.toContain(options.signingKey);
  });

  it.each([
    () => new Response('secret upstream diagnostic', { status: 409 }),
    () => Response.json({ id: 'qwen-code' }),
    () => new Response('invalid secret response'),
  ])(
    'fails startup instead of advertising an unregistered model',
    async (response) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => response()),
      );
      await expect(
        registerManagedLocalModels(options, [
          { modelId: 'model-a', label: 'A' },
        ]),
      ).rejects.toThrow(/Local model registration/u);
      try {
        await registerManagedLocalModels(options, [
          { modelId: 'model-a', label: 'A' },
        ]);
      } catch (error) {
        expect(String(error)).not.toContain('secret');
      }
    },
  );
});
