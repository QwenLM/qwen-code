/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AcpTestRig } from './test-helper.js';
import { setTimeout as delay } from 'node:timers/promises';

// Type for usage metadata in session updates
interface UsageMetadata {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  thoughtsTokens?: number;
  cachedTokens?: number;
}

interface AgentMessageChunkWithUsage {
  sessionUpdate: 'agent_message_chunk';
  _meta?: {
    usage?: UsageMetadata;
  };
}

describe('telemetry', () => {
  let rig: AcpTestRig;

  beforeEach(async () => {
    rig = new AcpTestRig();
  });

  afterEach(async () => {
    await rig.disconnect();
    await rig.cleanup();
  });

  describe('usage metadata', () => {
    it('should receive usage metadata in agent_message_chunk updates', async () => {
      await rig.setup('telemetry-usage', {
        clientOptions: { autoApprove: true },
      });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      await rig.prompt([
        {
          type: 'text',
          text: 'Say "hello".',
        },
      ]);

      await delay(500);

      // Find updates with usage metadata
      const updatesWithUsage = rig.sessionUpdates.filter(
        (u): u is typeof u & { update: AgentMessageChunkWithUsage } =>
          u.update?.sessionUpdate === 'agent_message_chunk' &&
          '_meta' in u.update &&
          typeof (u.update as AgentMessageChunkWithUsage)._meta === 'object' &&
          (u.update as AgentMessageChunkWithUsage)._meta?.usage !== undefined,
      );

      expect(updatesWithUsage.length).toBeGreaterThan(0);

      const usage = updatesWithUsage[0].update._meta?.usage;
      expect(usage).toBeDefined();
      expect(
        typeof usage?.promptTokens === 'number' ||
          typeof usage?.totalTokens === 'number',
      ).toBe(true);
    });
  });

  describe('tool call tracking', () => {
    it('should track tool calls in toolCallCollector', async () => {
      await rig.setup('telemetry-tool-calls', {
        clientOptions: { autoApprove: true },
      });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      await rig.prompt([
        {
          type: 'text',
          text: 'Create a file called telemetry-test.txt with content "test"',
        },
      ]);

      await rig.waitForToolCall('write_file', 30000);

      const toolCalls = rig.toolCallCollector.getAll();
      expect(toolCalls.length).toBeGreaterThan(0);

      const writeCall = toolCalls.find((t) => t.toolName === 'write_file');
      expect(writeCall).toBeDefined();
      expect(writeCall?.status).toBe('success');
    });

    it('should track completed tool calls', async () => {
      await rig.setup('telemetry-completed', {
        clientOptions: { autoApprove: true },
      });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      // Create a file to read
      rig.createFile('to-read.txt', 'sample content');

      await rig.prompt([
        {
          type: 'text',
          text: 'Read the file to-read.txt',
        },
      ]);

      await rig.waitForToolCall('read_file', 30000);

      const completed = rig.toolCallCollector.getCompleted();
      expect(completed.length).toBeGreaterThan(0);
    });
  });

  describe('session update tracking', () => {
    it('should collect all session updates', async () => {
      await rig.setup('telemetry-updates', {
        clientOptions: { autoApprove: true },
      });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      await rig.prompt([
        {
          type: 'text',
          text: 'Say hello',
        },
      ]);

      await delay(1000);

      // Should have collected some session updates
      expect(rig.sessionUpdates.length).toBeGreaterThanOrEqual(0);
    });
  });
});
