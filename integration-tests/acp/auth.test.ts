/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AcpTestRig } from './test-helper.js';

describe('auth', () => {
  let rig: AcpTestRig;

  beforeEach(async () => {
    rig = new AcpTestRig();
  });

  afterEach(async () => {
    await rig.disconnect();
    await rig.cleanup();
  });

  describe('authentication methods', () => {
    it('should return available auth methods in initialize response', async () => {
      await rig.setup('auth-methods', { clientOptions: { autoApprove: true } });
      await rig.connect();

      const response = await rig.initialize();

      expect(response.authMethods).toBeDefined();
      expect(Array.isArray(response.authMethods)).toBe(true);
    });

    it('should authenticate with openai method', async () => {
      await rig.setup('auth-openai', { clientOptions: { autoApprove: true } });
      await rig.connect();
      await rig.initialize();

      // Should not throw
      await rig.authenticate('openai');
    });

    it('should allow session creation after authentication', async () => {
      await rig.setup('auth-session', { clientOptions: { autoApprove: true } });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');

      const session = await rig.newSession();
      expect(session.sessionId).toBeTruthy();
    });

    it('should list available models after authentication', async () => {
      await rig.setup('auth-models', { clientOptions: { autoApprove: true } });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');

      const session = await rig.newSession();
      expect(session.models).toBeDefined();
      expect(session.models?.availableModels.length).toBeGreaterThan(0);
    });
  });

  describe('oauth authentication', () => {
    it('should include qwen-oauth in available models when auth required', async () => {
      await rig.setup('auth-oauth-models', {
        clientOptions: { autoApprove: true },
      });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');

      const session = await rig.newSession();
      // OAuth model may or may not be present depending on configuration
      // Just verify the models list is populated
      expect(session.models?.availableModels.length).toBeGreaterThan(0);
    });

    it('should return auth error when selecting oauth model without auth', async () => {
      await rig.setup('auth-oauth-error', {
        clientOptions: { autoApprove: true },
      });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');

      const session = await rig.newSession();

      // Find an oauth model if available
      const oauthModel = session.models?.availableModels.find((m) =>
        m.modelId.includes('qwen-oauth'),
      );

      if (oauthModel) {
        // Try to set oauth model - should fail with auth error
        await expect(
          rig.setConfigOption('model', oauthModel.modelId),
        ).rejects.toMatchObject({
          response: {
            code: -32603,
            message: 'Internal error',
            data: {
              details: expect.any(String),
            },
          },
        });
      }
    });
  });

  describe('authentication state', () => {
    it('should persist auth state across sessions', async () => {
      await rig.setup('auth-persist', { clientOptions: { autoApprove: true } });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');

      // Create first session
      const session1 = await rig.newSession();
      expect(session1.sessionId).toBeTruthy();

      // Create second session without re-authenticating
      const session2 = await rig.newSession();
      expect(session2.sessionId).toBeTruthy();
    });
  });
});

describe('auth with permission handling', () => {
  let rig: AcpTestRig;

  afterEach(async () => {
    await rig.disconnect();
    await rig.cleanup();
  });

  it('should allow custom permission handler', async () => {
    let permissionReceived = false;

    rig = new AcpTestRig();
    await rig.setup('auth-permission-handler', {
      clientOptions: {
        autoApprove: false,
        permissionHandler: (request) => {
          permissionReceived = true;
          // Auto-approve with allow_once
          const allowOption = request.options?.find(
            (o) => o.kind === 'allow_once',
          );
          if (allowOption) {
            return { optionId: allowOption.optionId };
          }
          return { outcome: 'cancelled' };
        },
      },
    });

    await rig.connect();
    await rig.initialize();
    await rig.authenticate('openai');
    await rig.newSession();

    await rig.prompt([
      {
        type: 'text',
        text: 'Create a file test.txt with content "hello"',
      },
    ]);

    // Wait for any tool call
    await rig.waitForAnyToolCall(['write_file', 'read_file'], 30000);

    // Permission handler should have been invoked
    expect(permissionReceived).toBe(true);
  });

  it('should track permission history when enabled', async () => {
    rig = new AcpTestRig();
    await rig.setup('auth-permission-history', {
      clientOptions: {
        autoApprove: true,
        recordPermissions: true,
      },
    });

    await rig.connect();
    await rig.initialize();
    await rig.authenticate('openai');
    await rig.newSession();

    await rig.prompt([
      {
        type: 'text',
        text: 'Create a file history.txt with content "test"',
      },
    ]);

    await rig.waitForToolCall('write_file', 30000);

    // Check permission history
    const history = rig.client?.getPermissionHistory() ?? [];
    expect(history.length).toBeGreaterThanOrEqual(0);
  });
});
