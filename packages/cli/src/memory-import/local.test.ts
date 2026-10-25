/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { beforeEach, expect, it, vi } from 'vitest';

interface MockAuthSettings {
  security?: { auth?: { selectedType?: string; enforcedType?: string } };
}
const mocks = vi.hoisted(() => ({
  refreshAuth: vi.fn(async () => undefined),
  settings: {
    merged: { security: { auth: { selectedType: 'gemini' } } },
  } as { merged: MockAuthSettings },
  currentAuthType: undefined as string | undefined,
  envAuthType: undefined as string | undefined,
}));
vi.mock('../config/settings.js', () => ({
  loadSettings: () => mocks.settings,
}));
vi.mock('../config/config.js', () => ({
  loadCliConfig: async () => ({
    isTrustedFolder: () => true,
    isManagedMemoryAvailable: () => true,
    getProjectRoot: () => '/project',
    getModelsConfig: () => ({
      getCurrentAuthType: () => mocks.currentAuthType,
    }),
    refreshAuth: mocks.refreshAuth,
  }),
}));
vi.mock('../utils/modelConfigUtils.js', () => ({
  getAuthTypeFromEnv: () => mocks.envAuthType,
}));
vi.mock('../config/auth.js', () => ({
  validateAuthMethod: (authType: string) =>
    authType === 'qwen-oauth'
      ? 'Qwen OAuth free tier was discontinued on 2026-04-15. Run /auth to switch to Coding Plan, OpenRouter, Fireworks AI, or another provider.'
      : authType === 'openai'
        ? "Missing API key for OpenAI-compatible auth. Set settings.security.auth.apiKey, or set the 'OPENAI_API_KEY' environment variable."
        : null,
}));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settings = {
    merged: { security: { auth: { selectedType: 'gemini' } } },
  };
  mocks.currentAuthType = undefined;
  mocks.envAuthType = undefined;
});

it('authenticates with cached credentials only, never an interactive flow', async () => {
  const { createLocalMemoryImportService } = await import('./local.js');
  await createLocalMemoryImportService();
  expect(mocks.refreshAuth).toHaveBeenCalledWith('gemini', true);
});

it('rejects a discontinued auth type before any model spend', async () => {
  mocks.settings = {
    merged: { security: { auth: { selectedType: 'qwen-oauth' } } },
  };
  const { createLocalMemoryImportService } = await import('./local.js');
  await expect(createLocalMemoryImportService()).rejects.toThrow(
    'Qwen OAuth free tier was discontinued on 2026-04-15.',
  );
  expect(mocks.refreshAuth).not.toHaveBeenCalled();
});

it('rejects a missing OpenAI-compatible key before any model spend', async () => {
  mocks.settings = {
    merged: { security: { auth: { selectedType: 'openai' } } },
  };
  const { createLocalMemoryImportService } = await import('./local.js');
  await expect(createLocalMemoryImportService()).rejects.toThrow(
    'Missing API key for OpenAI-compatible auth.',
  );
  expect(mocks.refreshAuth).not.toHaveBeenCalled();
});

it('prefers the configured auth type over provider environment variables', async () => {
  mocks.envAuthType = 'use-openai';
  const { createLocalMemoryImportService } = await import('./local.js');
  await createLocalMemoryImportService();
  expect(mocks.refreshAuth).toHaveBeenCalledWith('gemini', true);
});

it('refuses a non-enforced auth type before any model spend', async () => {
  mocks.settings = {
    merged: {
      security: {
        auth: { selectedType: 'qwen-oauth', enforcedType: 'use-openai' },
      },
    },
  };
  const { createLocalMemoryImportService } = await import('./local.js');
  await expect(createLocalMemoryImportService()).rejects.toThrow(
    'The configured auth type is use-openai, but the current auth type is qwen-oauth.',
  );
  expect(mocks.refreshAuth).not.toHaveBeenCalled();
});

it('authenticates when the resolved auth type matches the enforced type', async () => {
  mocks.settings = {
    merged: {
      security: {
        auth: { selectedType: 'gemini', enforcedType: 'gemini' },
      },
    },
  };
  const { createLocalMemoryImportService } = await import('./local.js');
  await createLocalMemoryImportService();
  expect(mocks.refreshAuth).toHaveBeenCalledWith('gemini', true);
});
