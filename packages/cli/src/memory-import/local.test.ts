/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  refreshAuth: vi.fn(async () => undefined),
}));
vi.mock('../config/settings.js', () => ({
  loadSettings: () => ({
    merged: { security: { auth: { selectedType: 'qwen-oauth' } } },
  }),
}));
vi.mock('../config/config.js', () => ({
  loadCliConfig: async () => ({
    isTrustedFolder: () => true,
    isManagedMemoryAvailable: () => true,
    getProjectRoot: () => '/project',
    refreshAuth: mocks.refreshAuth,
  }),
}));
vi.mock('../utils/modelConfigUtils.js', () => ({
  getAuthTypeFromEnv: () => undefined,
}));

it('authenticates with cached credentials only, never an interactive flow', async () => {
  const { createLocalMemoryImportService } = await import('./local.js');
  await createLocalMemoryImportService();
  expect(mocks.refreshAuth).toHaveBeenCalledWith('qwen-oauth', true);
});
