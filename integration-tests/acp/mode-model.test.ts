/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AcpTestRig } from './test-helper.js';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';

// Type guard for SessionConfigSelect
function isSelectConfig(
  option: SessionConfigOption,
): option is SessionConfigOption & {
  type: 'select';
  options: Array<{ value: string }>;
} {
  return (
    option.type === 'select' &&
    'options' in option &&
    Array.isArray((option as unknown as { options: unknown }).options)
  );
}

describe('mode and model', () => {
  let rig: AcpTestRig;

  beforeEach(async () => {
    rig = new AcpTestRig();
  });

  afterEach(async () => {
    await rig.disconnect();
    await rig.cleanup();
  });

  describe('mode operations', () => {
    it('should initialize and return available modes', async () => {
      await rig.setup('mode-initialize', {
        clientOptions: { autoApprove: true },
      });
      await rig.connect();

      const initResult = await rig.initialize();
      expect(initResult).toBeDefined();
      expect(initResult.protocolVersion).toBe(1);
    });

    it('should set mode to yolo', async () => {
      await rig.setup('mode-yolo', { clientOptions: { autoApprove: true } });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      const result = await rig.setMode('yolo');
      expect(result).toBeDefined();
    });

    it('should set mode to auto-edit', async () => {
      await rig.setup('mode-auto-edit', {
        clientOptions: { autoApprove: true },
      });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      const result = await rig.setMode('auto-edit');
      expect(result).toBeDefined();
    });

    it('should set mode back to default', async () => {
      await rig.setup('mode-default', { clientOptions: { autoApprove: true } });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      // First set to yolo
      await rig.setMode('yolo');

      // Then set back to default
      const result = await rig.setMode('default');
      expect(result).toBeDefined();
    });

    it('should track mode changes via session tracker', async () => {
      await rig.setup('mode-tracking', {
        clientOptions: { autoApprove: true },
      });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      expect(rig.sessionTracker.getCurrentMode()).toBeUndefined();

      await rig.setMode('yolo');
      // Mode change might be tracked via session update notification
    });
  });

  describe('model operations', () => {
    it('should list available models in new session', async () => {
      await rig.setup('model-list', { clientOptions: { autoApprove: true } });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');

      const session = await rig.newSession();
      expect(session.models).toBeDefined();
      expect(session.models?.availableModels.length).toBeGreaterThan(0);
    });

    it('should set model using setModel', async () => {
      await rig.setup('model-set', { clientOptions: { autoApprove: true } });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');

      const session = await rig.newSession();
      const openaiModel = session.models?.availableModels.find((m) =>
        m.modelId.includes('openai'),
      );

      if (openaiModel) {
        const result = await rig.setModel(openaiModel.modelId);
        expect(result).toBeDefined();
      }
    });
  });

  describe('config options', () => {
    it('should set mode using set_config_option', async () => {
      await rig.setup('config-mode', { clientOptions: { autoApprove: true } });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      const result = await rig.setConfigOption('mode', 'yolo');
      expect(result).toBeDefined();
      expect(Array.isArray(result.configOptions)).toBe(true);

      const modeOption = result.configOptions.find((opt) => opt.id === 'mode');
      expect(modeOption).toBeDefined();
      expect(modeOption?.currentValue).toBe('yolo');
    });

    it('should set model using set_config_option', async () => {
      await rig.setup('config-model', { clientOptions: { autoApprove: true } });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');

      const session = await rig.newSession();
      const openaiModel = session.models?.availableModels.find((m) =>
        m.modelId.includes('openai'),
      );

      if (openaiModel) {
        const result = await rig.setConfigOption('model', openaiModel.modelId);
        expect(result).toBeDefined();
        expect(Array.isArray(result.configOptions)).toBe(true);

        const modelOption = result.configOptions.find(
          (opt) => opt.id === 'model',
        );
        expect(modelOption).toBeDefined();
        expect(modelOption?.currentValue).toBe(openaiModel.modelId);
      }
    });

    it('should return error for invalid configId', async () => {
      await rig.setup('config-invalid', {
        clientOptions: { autoApprove: true },
      });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      await expect(
        rig.setConfigOption('invalid_config', 'some_value'),
      ).rejects.toMatchObject({
        response: {
          code: -32602,
          message: expect.stringContaining('Invalid params'),
        },
      });
    });

    it('should return all config options after set', async () => {
      await rig.setup('config-all-options', {
        clientOptions: { autoApprove: true },
      });
      await rig.connect();
      await rig.initialize();
      await rig.authenticate('openai');
      await rig.newSession();

      const result = await rig.setConfigOption('mode', 'auto-edit');
      expect(result.configOptions.length).toBeGreaterThanOrEqual(2);

      // Should have mode option
      const modeOption = result.configOptions.find((opt) => opt.id === 'mode');
      expect(modeOption).toBeDefined();
      // Use type guard to check if it's a select config
      if (modeOption && isSelectConfig(modeOption)) {
        expect(modeOption.options.some((o) => o.value === 'auto-edit')).toBe(
          true,
        );
      }

      // Should have model option
      const modelOption = result.configOptions.find(
        (opt) => opt.id === 'model',
      );
      expect(modelOption).toBeDefined();
      expect(modelOption?.currentValue).toBeTruthy();
    });
  });
});
