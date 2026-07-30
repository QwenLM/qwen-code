/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resetHomeEnvBootstrapForTesting } from '../config/settings.js';
import { createWorkspaceProvidersStatusProvider } from './workspace-providers-status.js';

const coreMock = vi.hoisted(() => ({
  throwModelsConfigError: false,
  modelsConfigErrorMessage:
    'Failed loading provider https://user:secret@broken.example/v1',
  debugLogger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    isEnabled: vi.fn(() => false),
    warn: vi.fn(),
  },
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  class TestModelsConfig extends actual.ModelsConfig {
    constructor(options: ConstructorParameters<typeof actual.ModelsConfig>[0]) {
      if (coreMock.throwModelsConfigError) {
        throw new Error(coreMock.modelsConfigErrorMessage);
      }
      super(options);
    }
  }
  return {
    ...actual,
    createDebugLogger: () => coreMock.debugLogger,
    ModelsConfig: TestModelsConfig,
  };
});

describe('createWorkspaceProvidersStatusProvider', () => {
  let tmpDir: string;
  let workspace: string;
  let qwenHome: string;
  const originalQwenHome = process.env['QWEN_HOME'];
  const originalQwenRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
  const originalSystemSettings = process.env['QWEN_CODE_SYSTEM_SETTINGS_PATH'];
  const originalSystemDefaults = process.env['QWEN_CODE_SYSTEM_DEFAULTS_PATH'];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'providers-status-'));
    workspace = path.join(tmpDir, 'workspace');
    qwenHome = path.join(tmpDir, 'qwen-home');
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(qwenHome, { recursive: true });
    process.env['QWEN_HOME'] = qwenHome;
    process.env['QWEN_RUNTIME_DIR'] = path.join(tmpDir, 'runtime');
    process.env['QWEN_CODE_SYSTEM_SETTINGS_PATH'] = path.join(
      tmpDir,
      'system-settings.json',
    );
    process.env['QWEN_CODE_SYSTEM_DEFAULTS_PATH'] = path.join(
      tmpDir,
      'system-defaults.json',
    );
    coreMock.throwModelsConfigError = false;
    coreMock.modelsConfigErrorMessage =
      'Failed loading provider https://user:secret@broken.example/v1';
    coreMock.debugLogger.warn.mockClear();
    resetHomeEnvBootstrapForTesting();
  });

  afterEach(async () => {
    restoreEnv('QWEN_HOME', originalQwenHome);
    restoreEnv('QWEN_RUNTIME_DIR', originalQwenRuntimeDir);
    restoreEnv('QWEN_CODE_SYSTEM_SETTINGS_PATH', originalSystemSettings);
    restoreEnv('QWEN_CODE_SYSTEM_DEFAULTS_PATH', originalSystemDefaults);
    resetHomeEnvBootstrapForTesting();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reads fresh default model settings on every request', async () => {
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      model: { name: 'model-a' },
      modelProviders: {
        openai: [
          {
            id: 'model-a',
            name: 'Model A',
            baseUrl: 'https://user:secret@api-a.example/v1',
          },
          {
            id: 'model-b',
            name: 'Model B',
            baseUrl: 'https://api-b.example/v1',
          },
        ],
      },
    });

    const first = await provider(workspace, false);
    expect(first).toMatchObject({
      initialized: true,
      acpChannelLive: false,
      current: {
        authType: 'openai',
        modelId: 'model-a(openai)',
        baseUrl: 'https://api-a.example/v1',
      },
    });
    expect(JSON.stringify(first)).not.toContain('secret');

    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      model: { name: 'model-b' },
      modelProviders: {
        openai: [
          { id: 'model-a', name: 'Model A' },
          { id: 'model-b', name: 'Model B' },
        ],
      },
    });

    const second = await provider(workspace, false);
    expect(second.current?.modelId).toBe('model-b(openai)');
  });

  it('returns the workspace approval mode', async () => {
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      tools: { approvalMode: 'yolo' },
    });

    const result = await provider(workspace, false);

    expect(result.approvalMode).toBe('yolo');
  });

  it('falls back to auto when no approval mode is configured', async () => {
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({});

    const result = await provider(workspace, false);

    expect(result.approvalMode).toBe('auto');
  });

  it('normalizes legacy workspace approval mode spelling', async () => {
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      tools: { approvalMode: 'auto_edit' },
    });

    const result = await provider(workspace, false);

    expect(result.approvalMode).toBe('auto-edit');
  });

  it('warns and falls back for an unknown workspace approval mode', async () => {
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      tools: { approvalMode: 'auto-edt' },
    });

    const result = await provider(workspace, false);

    expect(result.approvalMode).toBe('auto');
    expect(coreMock.debugLogger.warn).toHaveBeenCalledWith(
      '[workspace-providers-status] unrecognized approvalMode "auto-edt", falling back to auto',
    );
  });

  it('marks only the model matching persisted model.baseUrl as current', async () => {
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      model: {
        name: 'shared-model',
        baseUrl: 'https://api-two.example/v1',
      },
      modelProviders: {
        openai: [
          {
            id: 'shared-model',
            name: 'Shared One',
            baseUrl: 'https://api-one.example/v1',
          },
          {
            id: 'shared-model',
            name: 'Shared Two',
            baseUrl: 'https://api-two.example/v1',
          },
        ],
      },
    });

    const result = await provider(workspace, false);
    const models = result.providers.flatMap((p) => p.models);
    const first = models.find(
      (m) => m.baseUrl === 'https://api-one.example/v1',
    );
    const second = models.find(
      (m) => m.baseUrl === 'https://api-two.example/v1',
    );

    expect(first?.modelId).toMatch(/^qwen-route:v1:/);
    expect(second?.modelId).toMatch(/^qwen-route:v1:/);
    expect(first?.modelId).not.toBe(second?.modelId);
    expect(result.current?.modelId).toBe(second?.modelId);
    expect(first?.isCurrent).toBe(false);
    expect(second?.isCurrent).toBe(true);
  });

  it('does not mark a configured route for an unmatched explicit endpoint', async () => {
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      model: {
        name: 'shared-model',
        baseUrl: 'https://outside.example/v1',
      },
      modelProviders: {
        openai: [
          {
            id: 'shared-model',
            name: 'Shared One',
            baseUrl: 'https://api-one.example/v1',
          },
          {
            id: 'shared-model',
            name: 'Shared Two',
            baseUrl: 'https://api-two.example/v1',
          },
        ],
      },
    });

    const result = await provider(workspace, false);
    const models = result.providers.flatMap((entry) => entry.models);

    expect(result.current?.modelId).toBe('shared-model');
    expect(result.current?.baseUrl).toBe('https://outside.example/v1');
    expect(models.every((model) => model.isCurrent === false)).toBe(true);
  });

  it('filters fastOnly and voiceOnly models from the workspace provider catalog', async () => {
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      model: { name: 'main-model' },
      modelProviders: {
        openai: [
          { id: 'main-model', name: 'Main Model' },
          { id: 'fast-model', name: 'Fast Model', fastOnly: true },
          { id: 'voice-model', name: 'Voice Model', voiceOnly: true },
        ],
      },
    });

    const result = await provider(workspace, false);
    const modelIds = result.providers.flatMap((p) =>
      p.models.map((m) => m.modelId),
    );

    expect(modelIds).toContain('main-model(openai)');
    expect(modelIds).not.toContain('fast-model(openai)');
    expect(modelIds).not.toContain('voice-model(openai)');
  });

  it('reports custom providerProtocol models under their resolved auth type', async () => {
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      model: {
        name: 'custom-model',
        baseUrl: 'https://idealab.example/v1',
      },
      providerProtocol: { idealab: 'openai' },
      modelProviders: {
        idealab: [
          {
            id: 'custom-model',
            name: 'Idealab Current',
            baseUrl: 'https://idealab.example/v1',
          },
        ],
        unmapped: [{ id: 'ignored-model', name: 'Ignored Model' }],
      },
    });

    const result = await provider(workspace, false);
    const openaiProvider = result.providers.find(
      (p) => p.authType === 'openai',
    );

    expect(openaiProvider?.models).toMatchObject([
      {
        modelId: 'custom-model(openai)',
        baseModelId: 'custom-model',
        name: 'Idealab Current',
        baseUrl: 'https://idealab.example/v1',
        isCurrent: true,
      },
    ]);
    expect(openaiProvider?.current).toBe(true);
    expect(
      result.providers
        .flatMap((p) => p.models)
        .some((m) => m.modelId === 'ignored-model(openai)'),
    ).toBe(false);
  });

  it('sanitizes credentials from provider warning URLs', async () => {
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      model: {
        name: 'shared-model',
        baseUrl: 'https://user:sec ret@stale.example/v1',
      },
      modelProviders: {
        openai: [
          {
            id: 'shared-model',
            name: 'Shared Current',
            baseUrl: `https://user:cur'rent@current.example/v1`,
          },
        ],
      },
    });

    const result = await provider(workspace, false);
    const warning = result.errors?.[0]?.error;

    expect(warning).toContain('Persisted model.baseUrl');
    expect(warning).toContain('https://stale.example/v1');
    expect(warning).toContain('https://current.example/v1');
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('sec ret');
    expect(JSON.stringify(result)).not.toContain(`cur'rent`);
  });

  it('does not mark baseUrl variants current when no baseUrl is resolved', async () => {
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      model: { name: 'shared-model' },
      modelProviders: {
        openai: [
          {
            id: 'shared-model',
            name: 'Shared Default',
          },
          {
            id: 'shared-model',
            name: 'Shared Proxy',
            baseUrl: 'https://proxy.example/v1',
          },
        ],
      },
    });

    const result = await provider(workspace, false);
    const models = result.providers.flatMap((p) => p.models);
    const defaultModel = models.find((m) => m.name === 'Shared Default');

    expect(result.current?.modelId).toBe(defaultModel?.modelId);
    expect(defaultModel?.isCurrent).toBe(true);
    expect(
      models.find((m) => m.baseUrl === 'https://proxy.example/v1')?.isCurrent,
    ).toBe(false);
  });

  it('uses the auth-specific env model when settings.model.name is absent', async () => {
    const provider = createWorkspaceProvidersStatusProvider({
      env: { OPENAI_MODEL: 'env-model' },
    });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      modelProviders: {
        openai: [{ id: 'env-model', name: 'Env Model' }],
      },
    });

    const result = await provider(workspace, false);

    expect(result.current?.modelId).toBe('env-model(openai)');
    expect(
      result.providers
        .flatMap((p) => p.models)
        .find((m) => m.modelId === 'env-model(openai)')?.isCurrent,
    ).toBe(true);
  });

  it('does not load workspace env files into process.env when env is injected', async () => {
    const originalOpenaiApiKey = process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
    await fs.writeFile(path.join(workspace, '.env'), 'OPENAI_API_KEY=leak');
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      modelProviders: {
        openai: [{ id: 'env-model', name: 'Env Model' }],
      },
    });
    const provider = createWorkspaceProvidersStatusProvider({
      env: { OPENAI_MODEL: 'env-model', OPENAI_API_KEY: 'runtime-key' },
    });

    try {
      const result = await provider(workspace, false);

      expect(result.current?.modelId).toBe('env-model(openai)');
      expect(process.env['OPENAI_API_KEY']).toBeUndefined();
    } finally {
      restoreEnv('OPENAI_API_KEY', originalOpenaiApiKey);
    }
  });

  it('loads the workspace env when no runtime env snapshot is injected', async () => {
    const originalOpenaiModel = process.env['OPENAI_MODEL'];
    delete process.env['OPENAI_MODEL'];
    await fs.writeFile(path.join(workspace, '.env'), 'OPENAI_MODEL=env-model');
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      modelProviders: {
        openai: [{ id: 'env-model', name: 'Env Model' }],
      },
    });
    const provider = createWorkspaceProvidersStatusProvider();

    try {
      const result = await provider(workspace, false);

      expect(result.current?.modelId).toBe('env-model(openai)');
    } finally {
      restoreEnv('OPENAI_MODEL', originalOpenaiModel);
    }
  });

  it('includes only non-empty fast model settings in current selection', async () => {
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      model: { name: 'main-model' },
      fastModel: 'fast-model',
      modelProviders: {
        openai: [{ id: 'main-model', name: 'Main Model' }],
      },
    });

    const withFastModel = await provider(workspace, false);
    expect(withFastModel.current?.fastModelId).toBe('fast-model');

    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      model: { name: 'main-model' },
      fastModel: '',
      modelProviders: {
        openai: [{ id: 'main-model', name: 'Main Model' }],
      },
    });

    const withEmptyFastModel = await provider(workspace, false);
    expect(withEmptyFastModel.current).not.toHaveProperty('fastModelId');
  });

  it('includes only non-empty vision model settings in current selection', async () => {
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      model: { name: 'main-model' },
      visionModel: 'vision-model',
      modelProviders: {
        openai: [{ id: 'main-model', name: 'Main Model' }],
      },
    });

    const withVisionModel = await provider(workspace, false);
    expect(withVisionModel.current?.visionModelId).toBe('vision-model');

    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      model: { name: 'main-model' },
      visionModel: '',
      modelProviders: {
        openai: [{ id: 'main-model', name: 'Main Model' }],
      },
    });

    const withEmptyVisionModel = await provider(workspace, false);
    expect(withEmptyVisionModel.current).not.toHaveProperty('visionModelId');
  });

  it('does not include runtime models in the workspace provider catalog', async () => {
    const provider = createWorkspaceProvidersStatusProvider({
      argv: { model: 'runtime-only-model' },
      env: { OPENAI_API_KEY: 'sk-test-key' },
    });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      modelProviders: {
        openai: [{ id: 'registry-model', name: 'Registry Model' }],
      },
    });

    const result = await provider(workspace, false);

    expect(result.current?.modelId).toBe('runtime-only-model(openai)');
    expect(
      result.providers
        .flatMap((p) => p.models)
        .some((m) => m.modelId === 'runtime-only-model(openai)'),
    ).toBe(false);
  });

  it('does not report initialized when provider catalog construction fails', async () => {
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      modelProviders: {
        openai: [{ name: 'Broken Model' }],
      },
    });

    const result = await provider(workspace, true);

    expect(result).toMatchObject({
      initialized: false,
      acpChannelLive: true,
      providers: [],
      errors: [
        {
          kind: 'providers',
          status: 'error',
        },
      ],
    });
  });

  it('sanitizes credentials from provider construction errors', async () => {
    coreMock.throwModelsConfigError = true;
    coreMock.modelsConfigErrorMessage =
      'Failed loading provider https://user:sec ret@broken.example/v1';
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      modelProviders: {
        openai: [{ id: 'model-a', name: 'Model A' }],
      },
    });

    const result = await provider(workspace, true);

    expect(JSON.stringify(result)).toContain('https://broken.example/v1');
    expect(JSON.stringify(result)).not.toContain('sec ret');
    expect(result.initialized).toBe(false);
  });

  it('keeps a port and the text after it when the message has no credentials', async () => {
    // A `:` in the authority used to be read as the start of a password, so any
    // later `@` — an email address, an npm scope — was taken as the end of the
    // userinfo and everything between them was deleted.
    coreMock.throwModelsConfigError = true;
    coreMock.modelsConfigErrorMessage =
      'Cannot reach https://api.example:8443/v1 — contact admin@example.com';
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      modelProviders: { openai: [{ id: 'model-a', name: 'Model A' }] },
    });

    const result = await provider(workspace, true);

    expect(result.errors?.[0]?.error).toBe(
      'Cannot reach https://api.example:8443/v1 — contact admin@example.com',
    );
  });

  it('strips a password containing an @ instead of splitting on the first one', async () => {
    // `indexOf('@')` found the one inside the password, so the cut landed too
    // early and the rest of the password was emitted.
    coreMock.throwModelsConfigError = true;
    coreMock.modelsConfigErrorMessage =
      'Failed loading provider https://user:p@ssw0rd-tail@broken.example/v1';
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      modelProviders: { openai: [{ id: 'model-a', name: 'Model A' }] },
    });

    const result = await provider(workspace, true);

    expect(result.errors?.[0]?.error).toBe(
      'Failed loading provider https://broken.example/v1',
    );
    expect(JSON.stringify(result)).not.toContain('ssw0rd-tail');
  });

  it('strips credentials from every URL in a message and leaves the rest intact', async () => {
    coreMock.throwModelsConfigError = true;
    coreMock.modelsConfigErrorMessage =
      'Moving from https://user:sec ret@a.example/v1 to https://user:other@b.example:8443/v2; see admin@example.com';
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      modelProviders: { openai: [{ id: 'model-a', name: 'Model A' }] },
    });

    const result = await provider(workspace, true);

    expect(result.errors?.[0]?.error).toBe(
      'Moving from https://a.example/v1 to https://b.example:8443/v2; see admin@example.com',
    );
  });

  it('keeps a pathless URL and the email after it intact', async () => {
    // A pathless URL has no `/`, `?` or `#` to bound its authority, so handing
    // the trailing prose to the sanitizer let the `@` in an email address read
    // as the end of a userinfo: the host was rewritten and the text deleted.
    coreMock.throwModelsConfigError = true;
    coreMock.modelsConfigErrorMessage =
      'Cannot reach https://api.example.com — contact admin@example.com';
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      modelProviders: { openai: [{ id: 'model-a', name: 'Model A' }] },
    });

    const result = await provider(workspace, true);

    expect(result.errors?.[0]?.error).toBe(
      'Cannot reach https://api.example.com — contact admin@example.com',
    );
  });

  it('keeps a pathless URL with a port and the email after it intact', async () => {
    coreMock.throwModelsConfigError = true;
    coreMock.modelsConfigErrorMessage =
      'Cannot reach https://api.example.com:8443 — contact admin@example.com';
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      modelProviders: { openai: [{ id: 'model-a', name: 'Model A' }] },
    });

    const result = await provider(workspace, true);

    expect(result.errors?.[0]?.error).toBe(
      'Cannot reach https://api.example.com:8443 — contact admin@example.com',
    );
  });

  it('strips a spaced password from a pathless URL followed by prose', async () => {
    // The counterpart to the two above: bounding the URL at the first space
    // must not stop a password that legally contains one from being found.
    coreMock.throwModelsConfigError = true;
    coreMock.modelsConfigErrorMessage =
      'Failed loading provider https://user:sec ret@broken.example — retry later';
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      modelProviders: { openai: [{ id: 'model-a', name: 'Model A' }] },
    });

    const result = await provider(workspace, true);

    expect(result.errors?.[0]?.error).toBe(
      'Failed loading provider https://broken.example — retry later',
    );
    expect(JSON.stringify(result)).not.toContain('sec ret');
  });

  it('keeps the host when a pathless URL carries credentials and prose has an email', async () => {
    // Both `@`s are candidates for the end of the userinfo. Taking the later one
    // deleted the prose and rewrote the host from it, so the credentials were
    // stripped but the message named the wrong server.
    coreMock.throwModelsConfigError = true;
    coreMock.modelsConfigErrorMessage =
      'Cannot reach https://user:pass@host.example — contact admin@example.com';
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      modelProviders: { openai: [{ id: 'model-a', name: 'Model A' }] },
    });

    const result = await provider(workspace, true);

    expect(result.errors?.[0]?.error).toBe(
      'Cannot reach https://host.example — contact admin@example.com',
    );
    expect(JSON.stringify(result)).not.toContain('pass@');
  });

  it('strips a password that begins with digits and a space', async () => {
    // `user:123 ` is shaped exactly like `host:8443 `, so the guard that stops a
    // port being read as a password rejected this password and leaked it.
    coreMock.throwModelsConfigError = true;
    coreMock.modelsConfigErrorMessage =
      'Failed loading provider https://user:123 secret@broken.example/v1';
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      modelProviders: { openai: [{ id: 'model-a', name: 'Model A' }] },
    });

    const result = await provider(workspace, true);

    expect(result.errors?.[0]?.error).toBe(
      'Failed loading provider https://broken.example/v1',
    );
    expect(JSON.stringify(result)).not.toContain('123 secret');
  });

  it('strips a password containing both an at sign and a space', async () => {
    // The two failure modes meet here: a greedy tail runs past the host into the
    // prose, a lazy one stops at the `@` inside the password and leaves `s s@`
    // behind. Only choosing the `@` by what follows it handles both.
    coreMock.throwModelsConfigError = true;
    coreMock.modelsConfigErrorMessage =
      'Failed loading provider https://user:p@s s@broken.example/v1';
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      modelProviders: { openai: [{ id: 'model-a', name: 'Model A' }] },
    });

    const result = await provider(workspace, true);

    expect(result.errors?.[0]?.error).toBe(
      'Failed loading provider https://broken.example/v1',
    );
    expect(JSON.stringify(result)).not.toContain('p@s s');
    expect(JSON.stringify(result)).not.toContain('s s@');
  });

  it('keeps a pathless URL on localhost with a port and the email after it intact', async () => {
    // `localhost` and a dotted IPv4 are hosts too, so the port heuristic has to
    // survive them as well as a dotted name.
    coreMock.throwModelsConfigError = true;
    coreMock.modelsConfigErrorMessage =
      'Cannot reach https://localhost:8443 — contact admin@example.com';
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      modelProviders: { openai: [{ id: 'model-a', name: 'Model A' }] },
    });

    const result = await provider(workspace, true);

    expect(result.errors?.[0]?.error).toBe(
      'Cannot reach https://localhost:8443 — contact admin@example.com',
    );
  });

  it('strips a spaced password from a URL with a bare single-label host', async () => {
    // Requiring a dot in the host excluded exactly the hosts an intranet uses:
    // a proxy name, a container name like `ollama`, a k8s service. Not
    // recognising the host means not recognising the userinfo, and the fallback
    // then cut the URL at the first space -- inside the password.
    coreMock.throwModelsConfigError = true;
    coreMock.modelsConfigErrorMessage =
      'Failed loading provider https://user:my password@internalhost/v1';
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      modelProviders: { openai: [{ id: 'model-a', name: 'Model A' }] },
    });

    const result = await provider(workspace, true);

    expect(result.errors?.[0]?.error).toBe(
      'Failed loading provider https://internalhost/v1',
    );
    expect(JSON.stringify(result)).not.toContain('my password');
  });

  it('keeps a single-label host and the prose after it when the URL is pathless', async () => {
    // The other half of the same omission: with the real `@` unrecognised, the
    // lazy tail ran on into the prose and stripped at the email's `@` instead,
    // reporting a host the user never configured and deleting the contact line.
    coreMock.throwModelsConfigError = true;
    coreMock.modelsConfigErrorMessage =
      'Cannot reach https://user:pass@intranet — contact admin@example.com';
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      modelProviders: { openai: [{ id: 'model-a', name: 'Model A' }] },
    });

    const result = await provider(workspace, true);

    expect(result.errors?.[0]?.error).toBe(
      'Cannot reach https://intranet — contact admin@example.com',
    );
    expect(JSON.stringify(result)).not.toContain('pass@');
  });

  it('does not read a port as a password when punctuation follows it', async () => {
    // A port was only recognised at end of message or before a space, so the
    // comma in `:8443, contact` left `8443` looking like the start of a
    // password -- and the tail then found the email's `@`.
    coreMock.throwModelsConfigError = true;
    coreMock.modelsConfigErrorMessage =
      'Cannot reach https://api.example:8443, contact admin@example.com';
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      modelProviders: { openai: [{ id: 'model-a', name: 'Model A' }] },
    });

    const result = await provider(workspace, true);

    expect(result.errors?.[0]?.error).toBe(
      'Cannot reach https://api.example:8443, contact admin@example.com',
    );
  });

  it('strips a spaced password when the URL ends a sentence', async () => {
    // The characters allowed to follow a host were enumerated, and `.` was not
    // among them, so a URL at the end of a sentence -- the most ordinary shape
    // an error message has -- was not recognised, and the password leaked.
    coreMock.throwModelsConfigError = true;
    coreMock.modelsConfigErrorMessage =
      'Failed https://user:my pass@host.example. Retry later';
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      modelProviders: { openai: [{ id: 'model-a', name: 'Model A' }] },
    });

    const result = await provider(workspace, true);

    expect(result.errors?.[0]?.error).toBe(
      'Failed https://host.example. Retry later',
    );
    expect(JSON.stringify(result)).not.toContain('my pass');
  });

  it('keeps the host and the following sentence when a period ends the URL', async () => {
    // Same omission, corrupting instead of leaking: the trailing period made
    // the real `@` invisible, so the strip landed on the email in the next
    // sentence and both the host and that sentence were rewritten away.
    coreMock.throwModelsConfigError = true;
    coreMock.modelsConfigErrorMessage =
      'Cannot reach https://user:pass@host.example. Contact admin@example.com';
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      modelProviders: { openai: [{ id: 'model-a', name: 'Model A' }] },
    });

    const result = await provider(workspace, true);

    expect(result.errors?.[0]?.error).toBe(
      'Cannot reach https://host.example. Contact admin@example.com',
    );
    expect(JSON.stringify(result)).not.toContain('pass@');
  });

  it('strips a spaced password from a URL whose host is a single character', async () => {
    // The two-character floor on a bare host excluded a one-character one. The
    // floor is only needed where a label has no delimiter after it; here the `/`
    // says the label is an authority rather than a word, so no length is needed.
    coreMock.throwModelsConfigError = true;
    coreMock.modelsConfigErrorMessage = 'Failed https://user:my pass@h/v1';
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      modelProviders: { openai: [{ id: 'model-a', name: 'Model A' }] },
    });

    const result = await provider(workspace, true);

    expect(result.errors?.[0]?.error).toBe('Failed https://h/v1');
    expect(JSON.stringify(result)).not.toContain('my pass');
  });

  it('strips a spaced password when the username is empty', async () => {
    // `https://:token@host` is a legal URL and the shape a token-only config
    // produces, but requiring a character before the colon meant no userinfo was
    // recognised and the fallback cut inside the password.
    coreMock.throwModelsConfigError = true;
    coreMock.modelsConfigErrorMessage =
      'Failed https://:my pass@host.example/v1';
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      modelProviders: { openai: [{ id: 'model-a', name: 'Model A' }] },
    });

    const result = await provider(workspace, true);

    expect(result.errors?.[0]?.error).toBe('Failed https://host.example/v1');
    expect(JSON.stringify(result)).not.toContain('my pass');
  });

  it('strips credentials from a bracketed IPv6 base URL', async () => {
    // Pins the IPv6 branch, which every other case here leaves untouched: it is
    // the one host shape whose own characters include a colon, so a change to
    // the port or delimiter rules could break it while the rest stay green.
    coreMock.throwModelsConfigError = true;
    coreMock.modelsConfigErrorMessage =
      'Failed loading provider https://user:pass@[::1]:8443/v1';
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      modelProviders: { openai: [{ id: 'model-a', name: 'Model A' }] },
    });

    const result = await provider(workspace, true);

    expect(result.errors?.[0]?.error).toBe(
      'Failed loading provider https://[::1]:8443/v1',
    );
    expect(JSON.stringify(result)).not.toContain('pass');
  });

  it('leaves a password whose tail reads as a host, and says so', async () => {
    // Not a fix: a record of where the boundary is. `word@realhost.example` is
    // indistinguishable from a userinfo followed by a host, so `word` survives
    // -- as it did before this PR. Pinned so that a later widening of the host
    // rules has to decide this case deliberately rather than by accident.
    coreMock.throwModelsConfigError = true;
    coreMock.modelsConfigErrorMessage =
      'Failed https://user:p@ss word@realhost.example/v1';
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      modelProviders: { openai: [{ id: 'model-a', name: 'Model A' }] },
    });

    const result = await provider(workspace, true);

    expect(result.errors?.[0]?.error).toBe(
      'Failed https://ss word@realhost.example/v1',
    );
  });

  it('leaves a two-space password beginning with digits, and says so', async () => {
    // The flip side of the port heuristic, and the other half of the tradeoff
    // documented on CREDENTIAL_PREFIX_PATTERN: a second space before the `@` is
    // what tells `:8443 — contact admin@…` from a password, so a password that
    // has one reads as prose. Pinned for the same reason as the case above.
    coreMock.throwModelsConfigError = true;
    coreMock.modelsConfigErrorMessage =
      'Failed https://user:123 secret word@host.example/v1';
    const provider = createWorkspaceProvidersStatusProvider({ env: {} });
    await writeUserSettings({
      security: { auth: { selectedType: 'openai' } },
      modelProviders: { openai: [{ id: 'model-a', name: 'Model A' }] },
    });

    const result = await provider(workspace, true);

    expect(result.errors?.[0]?.error).toBe(
      'Failed https://user:123 secret word@host.example/v1',
    );
  });

  async function writeUserSettings(settings: Record<string, unknown>) {
    await fs.writeFile(
      path.join(qwenHome, 'settings.json'),
      JSON.stringify(settings),
      'utf8',
    );
  }
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
