/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const backend = vi.hoisted(() => ({
  root: '',
  values: new Map<string, string>(),
  started: false,
  release: undefined as (() => void) | undefined,
}));
vi.mock('../config/storage.js', async original => {
  const actual = await original<typeof import('../config/storage.js')>();
  return { ...actual, Storage: Object.assign(Object.create(actual.Storage), { getGlobalConfigDir: () => backend.root }) };
});
vi.mock('node:os', async original => ({ ...(await original<typeof import('node:os')>()), platform: () => 'linux' }));
vi.mock('keytar', () => ({ default: {
  getPassword: async (service: string, account: string) => backend.values.get(`${service}:${account}`) ?? null,
  setPassword: async (service: string, account: string, value: string) => {
    if (value.includes('late-token')) {
      backend.started = true;
      await new Promise<void>(resolve => { backend.release = resolve; });
    }
    backend.values.set(`${service}:${account}`, value);
  },
  deletePassword: async (service: string, account: string) => backend.values.delete(`${service}:${account}`),
  findCredentials: async () => [],
} }));
import { MCPOAuthTokenStorage } from './oauth-token-storage.js';
import { MCP_ENTERPRISE_SOURCE } from './mcpServerConfig.js';
import { FORCE_ENCRYPTED_FILE_ENV_VAR } from './token-storage/index.js';
import { FORCE_FILE_STORAGE_ENV_VAR, resetKeychainSelection } from '../services/keychainService.js';

afterEach(() => {
  resetKeychainSelection();
  vi.unstubAllEnvs();
  rmSync(backend.root, { recursive: true, force: true });
});

it('reclaims a native Keychain write revoked while pending before allowing the next writer', async () => {
  backend.root = mkdtempSync(join(tmpdir(), 'oauth-native-'));
  resetKeychainSelection();
  vi.stubEnv(FORCE_ENCRYPTED_FILE_ENV_VAR, 'true');
  vi.stubEnv(FORCE_FILE_STORAGE_ENV_VAR, 'false');
  const config = { url: 'https://example.test/mcp', [MCP_ENTERPRISE_SOURCE]: 'org-user' };
  const storage = MCPOAuthTokenStorage.forServer('docs', config);
  let valid = true;
  const pending = storage.saveToken('docs', { accessToken: 'late-token', tokenType: 'Bearer' }, undefined, undefined, undefined, undefined,
    () => { if (!valid) throw new Error('identity ended'); }, null).catch(error => error);
  await vi.waitFor(() => expect(backend.started).toBe(true));
  valid = false;
  const next = storage.saveToken('docs', { accessToken: 'new-token', tokenType: 'Bearer' });
  backend.release!();
  expect(await pending).toMatchObject({ message: 'identity ended' });
  await next;
  expect((await storage.getCredentials('docs'))?.token.accessToken).toBe('new-token');
  expect([...backend.values.values()].join('')).not.toContain('late-token');
});
