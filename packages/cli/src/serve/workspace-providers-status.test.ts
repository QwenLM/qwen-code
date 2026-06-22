/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resetHomeEnvBootstrapForTesting } from '../config/settings.js';
import { createWorkspaceProvidersStatusProvider } from './workspace-providers-status.js';

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

    expect(result.current?.modelId).toBe('shared-model(openai)');
    expect(
      models.find((m) => m.baseUrl === 'https://api-one.example/v1')?.isCurrent,
    ).toBe(false);
    expect(
      models.find((m) => m.baseUrl === 'https://api-two.example/v1')?.isCurrent,
    ).toBe(true);
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

    expect(result.current?.modelId).toBe('shared-model(openai)');
    expect(
      models.find((m) => m.name === 'Shared Default')?.isCurrent,
    ).toBe(true);
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
