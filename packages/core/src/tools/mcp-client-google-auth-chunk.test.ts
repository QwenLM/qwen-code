/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProviderType } from '../config/config.js';

// Kept separate from mcp-client.test.ts: the vi.resetModules() below would
// rebind the provider classes for any test running after it in the same
// file, breaking toBeInstanceOf assertions against that file's static
// imports.
describe('Google auth provider chunk missing after a background update', () => {
  afterEach(() => {
    vi.doUnmock('../mcp/google-auth-provider.js');
    vi.doUnmock('../mcp/sa-impersonation-provider.js');
    vi.resetModules();
  });

  it.each([
    {
      provider: 'GoogleCredentialProvider',
      modulePath: '../mcp/google-auth-provider.js',
      authProviderType: AuthProviderType.GOOGLE_CREDENTIALS,
    },
    {
      provider: 'ServiceAccountImpersonationProvider',
      modulePath: '../mcp/sa-impersonation-provider.js',
      authProviderType: AuthProviderType.SERVICE_ACCOUNT_IMPERSONATION,
    },
  ])(
    'asks for a restart when the $provider chunk cannot be found',
    async ({ modulePath, authProviderType }) => {
      const moduleError = Object.assign(
        new Error(`Cannot find module '${modulePath}'`),
        { code: 'ERR_MODULE_NOT_FOUND' },
      );
      vi.resetModules();
      vi.doMock(modulePath, () => {
        throw moduleError;
      });
      const { createTransport: createTransportAfterUpdate } = await import(
        './mcp-client.js'
      );

      const error = await createTransportAfterUpdate(
        'test-server',
        {
          httpUrl: 'http://test.googleapis.com',
          authProviderType,
          targetAudience: 'test-audience',
          targetServiceAccount: 'mcp@test-project.iam.gserviceaccount.com',
        },
        false,
      ).then(
        () => expect.unreachable('createTransport should reject'),
        (rejection: unknown) => rejection,
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        'Qwen Code was updated in the background and needs to be restarted.\n' +
          'Please exit and restart Qwen Code to use Google authentication for MCP servers.',
      );
      expect((error as Error).cause).toBe(moduleError);
    },
  );
});
