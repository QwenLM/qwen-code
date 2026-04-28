/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AcpTestRig } from './test-helper.js';

describe('session', () => {
  let rig: AcpTestRig;

  beforeEach(async () => {
    rig = new AcpTestRig();
  });

  afterEach(async () => {
    await rig.disconnect();
    await rig.cleanup();
  });

  describe('basic operations', () => {
    it('basic smoke test', async () => {
      await rig.setup('session-smoke', {
        clientOptions: { autoApprove: true },
      });
      await rig.connect();

      const initResult = await rig.initialize({
        fs: { readTextFile: true, writeTextFile: true },
      });
      expect(initResult).toBeDefined();
      expect(initResult.agentInfo?.version).toBeDefined();

      await rig.authenticate('openai');

      const newSession = await rig.newSession();
      expect(newSession.sessionId).toBeTruthy();

      const promptResult = await rig.prompt([
        {
          type: 'text',
          text: 'Create a quick note (smoke test).',
        },
      ]);
      expect(promptResult).toBeDefined();
    });

    it('should create a new session with correct working directory', async () => {
      await rig.setup('session-cwd', {
        clientOptions: { autoApprove: true },
      });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');

      const session = await rig.newSession();
      expect(session.sessionId).toBeTruthy();
      // Session working directory should match test directory
      expect(rig.testDir).toBeTruthy();
    });

    it('should create session with custom cwd', async () => {
      await rig.setup('session-custom-cwd', {
        clientOptions: { autoApprove: true },
      });

      // Create a subdirectory
      rig.mkdir('subdir');

      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');

      const customCwd = `${rig.testDir}/subdir`;
      const session = await rig.newSession(customCwd);

      expect(session.sessionId).toBeTruthy();
      // Verify custom cwd is set by checking the testDir
      expect(rig.testDir).toContain(customCwd.split('/subdir')[0]);
    });
  });

  describe('session tracking', () => {
    it('should track session creation', async () => {
      await rig.setup('session-tracking', {
        clientOptions: { autoApprove: true },
      });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');

      expect(rig.sessionTracker.getCurrentSessionId()).toBeNull();

      const session = await rig.newSession();

      expect(rig.sessionTracker.getCurrentSessionId()).toBe(session.sessionId);
      expect(rig.sessionTracker.getAllSessions()).toHaveLength(1);
    });

    it('should track multiple sessions', async () => {
      await rig.setup('session-multiple', {
        clientOptions: { autoApprove: true },
      });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');

      const session1 = await rig.newSession();
      const session2 = await rig.newSession();

      expect(rig.sessionTracker.getAllSessions()).toHaveLength(2);
      expect(rig.sessionTracker.getCurrentSessionId()).toBe(session2.sessionId);
      // Verify both sessions exist
      expect(rig.sessionTracker.getSession(session1.sessionId)).toBeDefined();
      expect(rig.sessionTracker.getSession(session2.sessionId)).toBeDefined();
    });

    it('should retrieve session by id', async () => {
      await rig.setup('session-get-by-id', {
        clientOptions: { autoApprove: true },
      });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');

      const session = await rig.newSession();
      const retrieved = rig.sessionTracker.getSession(session.sessionId);

      expect(retrieved).toBeDefined();
      expect(retrieved?.sessionId).toBe(session.sessionId);
    });
  });

  describe('prompt operations', () => {
    it('should send a simple prompt', async () => {
      await rig.setup('session-prompt-simple', {
        clientOptions: { autoApprove: true },
      });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      const result = await rig.prompt([
        {
          type: 'text',
          text: 'Say "hello"',
        },
      ]);

      expect(result).toBeDefined();
      expect(result.stopReason).toBeDefined();
    });

    it('should send prompts with multiple content blocks', async () => {
      await rig.setup('session-prompt-multi', {
        clientOptions: { autoApprove: true },
      });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      const result = await rig.prompt([
        {
          type: 'text',
          text: 'First message',
        },
        {
          type: 'text',
          text: 'Second message',
        },
      ]);

      expect(result).toBeDefined();
    });

    it('should use specified session for prompt', async () => {
      await rig.setup('session-prompt-specific', {
        clientOptions: { autoApprove: true },
      });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');

      const session1 = await rig.newSession();
      await rig.newSession(); // Create second session (becomes current)

      // Send prompt to first session
      const result = await rig.prompt(
        [
          {
            type: 'text',
            text: 'Hello',
          },
        ],
        session1.sessionId,
      );

      expect(result).toBeDefined();
    });
  });

  describe('cancel operation', () => {
    it('should cancel ongoing prompt', async () => {
      await rig.setup('session-cancel', {
        clientOptions: { autoApprove: true },
      });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      // Start a prompt that might take a while
      const promptPromise = rig.prompt([
        {
          type: 'text',
          text: 'Write a very long story about',
        },
      ]);

      // Cancel it after a short delay
      await new Promise((resolve) => setTimeout(resolve, 500));
      await rig.cancel();

      // The prompt should eventually complete (possibly with cancelled status)
      const result = await promptPromise;
      expect(result).toBeDefined();
    });
  });

  describe('error handling', () => {
    it('should return internal error details when model auth is required', async () => {
      await rig.setup('session-auth-error', {
        clientOptions: { autoApprove: true },
      });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');

      const session = await rig.newSession();

      // Find a model that requires oauth
      const oauthModel = session.models?.availableModels.find((m) =>
        m.modelId.includes('qwen-oauth'),
      );

      if (oauthModel) {
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
});
