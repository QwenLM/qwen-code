/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/// <reference types="vitest/globals" />

import { describe, it, expect } from 'vitest';
import {
  validateSettings,
  formatValidationError,
  getSettingsZodSchema,
} from './settings-validation.js';
import { z } from 'zod';
import {
  READ_FILE_TOOL_NAME,
  SHELL_TOOL_NAME,
  WRITE_FILE_TOOL_NAME,
  CONFIG_DIR,
} from '@qwen-code/core';

describe('settings-validation', () => {
  describe('validateSettings', () => {
    it('should accept valid settings with correct model.name as string', () => {
      const validSettings = {
        model: {
          name: 'gemini-2.0-flash-exp',
        },
        ui: {
          theme: 'dark',
          maxTurns: 2000,
        },
      };

      const result = validateSettings(validSettings);
      expect(result.success).toBe(true);
    });

    it('should accept flattened per-model generation preferences', () => {
      const result = validateSettings({
        model: {
          preferences: {
            'provider/model-a': {
              temperature: 1,
              topP: 0.95,
              topK: 20,
              maxTokens: 65535,
              reasoning: {
                thinking: { type: 'enabled', budgetTokens: 63000 },
                effort: 'high',
                preserve: true,
              },
            },
          },
        },
      });

      expect(result.success).toBe(true);
    });

    it('should reject invalid flattened generation preferences', () => {
      const result = validateSettings({
        model: {
          preferences: {
            'provider/model-a': {
              topP: 1.5,
              topK: 0,
            },
          },
        },
      });

      expect(result.success).toBe(false);
    });

    it('should validate the discriminated thinking configuration', () => {
      const result = validateSettings({
        model: {
          preferences: {
            'provider/model-a': {
              reasoning: { thinking: { type: 'enabled' } },
            },
          },
        },
      });

      expect(result.success).toBe(false);
    });

    it('should reject model.name as object instead of string', () => {
      const invalidSettings = {
        model: {
          name: {
            invalidKey: true,
          },
        },
      };

      const result = validateSettings(invalidSettings);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();

      if (result.error) {
        const issues = result.error.issues;
        expect(issues.length).toBeGreaterThan(0);
        expect(issues[0]?.path).toEqual(['model', 'name']);
        expect(issues[0]?.code).toBe('invalid_type');
      }
    });

    it('should accept valid model.summarizeToolOutput structure', () => {
      const validSettings = {
        model: {
          summarizeToolOutput: {
            [SHELL_TOOL_NAME]: {
              tokenBudget: 500,
            },
          },
        },
      };

      const result = validateSettings(validSettings);
      expect(result.success).toBe(true);
    });

    it('should reject invalid model.summarizeToolOutput structure', () => {
      const invalidSettings = {
        model: {
          summarizeToolOutput: {
            [SHELL_TOOL_NAME]: {
              tokenBudget: 500,
            },
          },
        },
      };

      // First test with valid structure
      let result = validateSettings(invalidSettings);
      expect(result.success).toBe(true);

      // Now test with wrong type (string instead of object)
      const actuallyInvalidSettings = {
        model: {
          summarizeToolOutput: 'invalid',
        },
      };

      result = validateSettings(actuallyInvalidSettings);
      expect(result.success).toBe(false);
      if (result.error) {
        expect(result.error.issues.length).toBeGreaterThan(0);
      }
    });

    it('should accept empty settings object', () => {
      const emptySettings = {};
      const result = validateSettings(emptySettings);
      expect(result.success).toBe(true);
    });

    it('should accept capability-only custom provider model declarations', () => {
      const result = validateSettings({
        providers: {
          'custom-openai': {
            type: 'openai-compatible',
            baseUrl: 'https://example.test/v1',
            apiKey: 'sk-test',
            model: 'example-model',
            models: [
              {
                model: 'example-model',
                contextWindow: 128000,
                maxOutputTokens: 8192,
                capabilities: {
                  tools: true,
                  cacheControl: true,
                  thinking: { modes: ['enabled'] },
                },
              },
            ],
          },
        },
      });

      expect(result.success).toBe(true);
    });

    it.each([
      {},
      {
        type: 'alibaba',
        baseUrl: 'https://dashscope.aliyuncs.com',
        apiKey: 'image-sk-test',
      },
    ])('rejects removed provider ImageGen settings %j', (image) => {
      const result = validateSettings({
        providers: {
          gateway: {
            baseUrl: 'https://example.test/v1',
            apiKey: 'sk-test',
            model: 'example-model',
            image,
          },
        },
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error?.issues).toContainEqual(
          expect.objectContaining({
            path: ['providers', 'gateway', 'image'],
            message:
              'providers[provider].image has been removed; use tools.imageGen',
          }),
        );
      }
    });

    it('should validate custom provider protocol and authentication choices', () => {
      expect(
        validateSettings({
          providers: {
            gateway: {
              protocol: 'openai-responses',
              baseUrl: 'https://example.test/v1',
              apiKey: 'sk-test',
              model: 'example-model',
            },
          },
        }).success,
      ).toBe(true);

      expect(
        validateSettings({
          providers: {
            gateway: {
              protocol: 'anthropic',
              authType: 'api-key',
              baseUrl: 'https://example.test/v1',
              apiKey: 'sk-test',
              model: 'example-model',
            },
          },
        }).success,
      ).toBe(true);

      const invalid = validateSettings({
        providers: {
          gateway: {
            protocol: 'messages-v2',
            authType: 'cookie',
            baseUrl: 'https://example.test/v1',
            apiKey: 'sk-test',
            model: 'example-model',
          },
        },
      });
      expect(invalid.success).toBe(false);
      expect(invalid.error?.issues.map((issue) => issue.path)).toEqual(
        expect.arrayContaining([
          ['providers', 'gateway', 'protocol'],
          ['providers', 'gateway', 'authType'],
        ]),
      );
    });

    it('should validate Anthropic protocol options and structured thinking capabilities', () => {
      const valid = validateSettings({
        providers: {
          gateway: {
            protocol: 'anthropic',
            baseUrl: 'https://example.test/v1',
            apiKey: 'sk-test',
            model: 'example-model',
            anthropic: {
              version: false,
              betas: ['custom-beta'],
              queryParams: { preview: 'true' },
              cache: { mode: 'auto', ttl: '1h' },
            },
            models: [
              {
                model: 'example-model',
                capabilities: {
                  thinking: {
                    modes: ['enabled', 'adaptive'],
                    preferredMode: 'adaptive',
                    requiresBudgetForEnabled: false,
                    supportsEffort: true,
                    supportedEffortLevels: [
                      'low',
                      'medium',
                      'high',
                      'xhigh',
                      'max',
                    ],
                    requiredBetasForEffort: [],
                  },
                },
              },
            ],
          },
        },
      });
      expect(valid.success).toBe(true);

      const booleanThinking = validateSettings({
        providers: {
          gateway: {
            protocol: 'anthropic',
            baseUrl: 'https://example.test/v1',
            apiKey: 'sk-test',
            model: 'example-model',
            models: [
              {
                model: 'example-model',
                capabilities: { thinking: true },
              },
            ],
          },
        },
      });
      expect(booleanThinking.success).toBe(false);

      const invalid = validateSettings({
        providers: {
          gateway: {
            protocol: 'anthropic',
            baseUrl: 'https://example.test/v1',
            apiKey: 'sk-test',
            model: 'example-model',
            anthropic: {
              version: true,
              betas: 'custom-beta',
              queryParams: { preview: true },
              cache: { mode: 'sometimes', ttl: '1d' },
            },
            models: [
              {
                model: 'example-model',
                capabilities: { thinking: { mode: 'automatic' } },
              },
            ],
          },
        },
      });
      expect(invalid.success).toBe(false);
      expect(invalid.error?.issues.map((issue) => issue.path)).toEqual(
        expect.arrayContaining([
          ['providers', 'gateway', 'anthropic', 'version'],
          ['providers', 'gateway', 'anthropic', 'betas'],
          ['providers', 'gateway', 'anthropic', 'queryParams', 'preview'],
          ['providers', 'gateway', 'anthropic', 'cache', 'mode'],
          ['providers', 'gateway', 'anthropic', 'cache', 'ttl'],
          ['providers', 'gateway', 'models', 0, 'capabilities', 'thinking'],
        ]),
      );
    });

    it('should reject generation parameters in custom provider declarations', () => {
      const providerLevel = validateSettings({
        providers: {
          gateway: {
            baseUrl: 'https://example.test/v1',
            apiKey: 'sk-test',
            model: 'example-model',
            top_k: 20,
          },
        },
      });
      expect(providerLevel.success).toBe(false);

      const modelLevel = validateSettings({
        providers: {
          gateway: {
            baseUrl: 'https://example.test/v1',
            apiKey: 'sk-test',
            model: 'example-model',
            models: [{ model: 'example-model', temperature: 1 }],
          },
        },
      });
      expect(modelLevel.success).toBe(false);
    });

    it('should explain maxTokens placement consistently with runtime parsing', () => {
      const result = validateSettings({
        providers: {
          gateway: {
            baseUrl: 'https://example.test/v1',
            apiKey: 'sk-test',
            model: 'example-model',
            models: [{ model: 'example-model', maxTokens: 8192 }],
          },
        },
      });

      expect(result.success).toBe(false);
      expect(result.error?.issues).toContainEqual(
        expect.objectContaining({
          path: ['providers', 'gateway', 'models', 0, 'maxTokens'],
          message:
            '`maxTokens` is a generation preference and must be configured under model.preferences[provider/model]. To declare the model output capacity here, use `maxOutputTokens`.',
        }),
      );
    });

    it('should accept Alibaba as a custom provider type', () => {
      const result = validateSettings({
        providers: {
          'alibaba-prod': {
            type: 'alibaba',
            baseUrl: 'https://example.test/v1',
            apiKey: 'sk-test',
          },
        },
      });

      expect(result.success).toBe(true);
    });

    it('should accept aliyun-bailian as an Alibaba compatibility type', () => {
      const result = validateSettings({
        providers: {
          gateway: {
            type: 'aliyun-bailian',
            baseUrl: 'https://example.test/v1',
            apiKey: 'sk-test',
          },
        },
      });

      expect(result.success).toBe(true);
    });

    it('should reject unsupported custom provider types', () => {
      const result = validateSettings({
        providers: {
          gateway: {
            type: 'unsupported',
            baseUrl: 'https://example.test/v1',
            apiKey: 'sk-test',
            model: 'example-model',
          },
        },
      });

      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual([
        'providers',
        'gateway',
        'type',
      ]);
    });

    it('accepts only boolean values for skills.loadFromAgentsDirectory', () => {
      expect(
        validateSettings({
          skills: { loadFromAgentsDirectory: true },
        }).success,
      ).toBe(true);

      const invalid = validateSettings({
        skills: { loadFromAgentsDirectory: 'true' },
      });
      expect(invalid.success).toBe(false);
      expect(invalid.error?.issues[0]?.path).toEqual([
        'skills',
        'loadFromAgentsDirectory',
      ]);
    });

    it('should accept unknown top-level keys (for migration compatibility)', () => {
      const settingsWithUnknownKey = {
        unknownKey: 'some value',
      };

      const result = validateSettings(settingsWithUnknownKey);
      expect(result.success).toBe(true);
      // Unknown keys are allowed via .passthrough() for migration scenarios
    });

    it('treats the removed model.maxSessionTurns field like any unknown setting', () => {
      expect(validateSettings({ model: { maxSessionTurns: -1 } }).success).toBe(
        true,
      );
    });

    it('strips product MCP metadata from shared Settings validation', () => {
      const url = 'https://provider.example/mcp';
      expect(
        getSettingsZodSchema().parse({
          mcpServers: {
            ordinary: { url, hostEndpoint: 'https://gateway.example/mcp' },
          },
        }),
      ).toEqual({ mcpServers: { ordinary: { url } } });
    });

    it('should accept deprecated memory settings for compatibility', () => {
      const settingsWithDeprecatedMemoryFields = {
        autoMemoryEnabled: true,
        autoMemoryUserScopeEnabled: false,
        compression: {
          autoCompact: {
            sessionMemory: {
              enabled: true,
            },
          },
        },
      };

      const result = validateSettings(settingsWithDeprecatedMemoryFields);
      expect(result.success).toBe(true);
    });

    it('should accept dream scheduling settings', () => {
      const settingsWithDream = {
        dream: {
          enabled: true,
          minHours: 0.01,
          minSessions: 1,
          scanThrottleMinutes: 0.1,
        },
      };

      const result = validateSettings(settingsWithDream);
      expect(result.success).toBe(true);
    });

    it('should reject non-positive dream scheduling thresholds', () => {
      const dreamThresholds = [
        'minHours',
        'minSessions',
        'scanThrottleMinutes',
      ] as const;

      for (const threshold of dreamThresholds) {
        const result = validateSettings({
          dream: {
            enabled: true,
            [threshold]: 0,
          },
        });

        expect(result.success).toBe(false);
        expect(result.error?.issues[0]?.path).toEqual(['dream', threshold]);
      }
    });

    it('should accept nested valid settings', () => {
      const validSettings = {
        ui: {
          theme: 'dark',
          hideWindowTitle: true,
          footer: {
            hideCWD: false,
            hideModelInfo: true,
          },
        },
        tools: {
          shell: { pager: 'cat' },
        },
      };

      const result = validateSettings(validSettings);
      expect(result.success).toBe(true);
    });

    it('should validate array types correctly', () => {
      const validSettings = {
        tools: {
          core: [READ_FILE_TOOL_NAME, WRITE_FILE_TOOL_NAME],
          exclude: ['dangerous-tool'],
        },
      };

      const result = validateSettings(validSettings);
      expect(result.success).toBe(true);
    });

    it('should reject invalid types in arrays', () => {
      const invalidSettings = {
        tools: {
          core: [READ_FILE_TOOL_NAME, 123],
        },
      };

      const result = validateSettings(invalidSettings);
      expect(result.success).toBe(false);
    });

    it('should validate boolean fields correctly', () => {
      const validSettings = {
        general: {
          vimMode: true,
          disableAutoUpdate: false,
        },
      };

      const result = validateSettings(validSettings);
      expect(result.success).toBe(true);
    });

    it('should reject non-boolean values for boolean fields', () => {
      const invalidSettings = {
        general: {
          vimMode: 'yes',
        },
      };

      const result = validateSettings(invalidSettings);
      expect(result.success).toBe(false);
    });

    it('should validate the TUI max turns enum', () => {
      const validSettings = {
        ui: {
          maxTurns: 'unlimited',
        },
      };

      const result = validateSettings(validSettings);
      expect(result.success).toBe(true);
    });

    it('should validate complex nested mcpServers configuration', () => {
      const invalidSettings = {
        mcpServers: {
          'my-server': {
            command: 123, // Should be string
            args: ['arg1'],
            env: {
              VAR: 'value',
            },
          },
        },
      };

      const result = validateSettings(invalidSettings);
      expect(result.success).toBe(false);
      if (result.error) {
        expect(result.error.issues.length).toBeGreaterThan(0);
        // Path should be mcpServers.my-server.command
        const issue = result.error.issues.find((i) =>
          i.path.includes('command'),
        );
        expect(issue).toBeDefined();
        expect(issue?.code).toBe('invalid_type');
      }
    });

    it('should validate mcpServers with type field for all transport types', () => {
      const validSettings = {
        mcpServers: {
          'sse-server': {
            url: 'https://example.com/sse',
            type: 'sse',
            headers: { 'X-API-Key': 'key' },
          },
          'http-server': {
            url: 'https://example.com/mcp',
            type: 'http',
          },
          'stdio-server': {
            command: '/usr/bin/mcp-server',
            type: 'stdio',
          },
        },
      };

      const result = validateSettings(validSettings);
      expect(result.success).toBe(true);
    });

    it('should reject invalid type values in mcpServers', () => {
      const invalidSettings = {
        mcpServers: {
          'bad-server': {
            url: 'https://example.com/mcp',
            type: 'invalid-type',
          },
        },
      };

      const result = validateSettings(invalidSettings);
      expect(result.success).toBe(false);
    });

    it('should validate mcpServers without type field', () => {
      const validSettings = {
        mcpServers: {
          'stdio-server': {
            command: '/usr/bin/mcp-server',
            args: ['--port', '8080'],
          },
          'url-server': {
            url: 'https://example.com/mcp',
          },
        },
      };

      const result = validateSettings(validSettings);
      expect(result.success).toBe(true);
    });

    it('should validate complex nested customThemes configuration', () => {
      const invalidSettings = {
        ui: {
          customThemes: {
            'my-theme': {
              type: 'custom',
              // Missing 'name' property which is required
              text: {
                primary: '#ffffff',
              },
            },
          },
        },
      };

      const result = validateSettings(invalidSettings);
      expect(result.success).toBe(false);
      if (result.error) {
        expect(result.error.issues.length).toBeGreaterThan(0);
        // Should complain about missing 'name'
        const issue = result.error.issues.find(
          (i) => i.code === 'invalid_type' && i.message.includes('Required'),
        );
        expect(issue).toBeDefined();
      }
    });
  });

  describe('formatValidationError', () => {
    it('should format error with file path and helpful message for model.name', () => {
      const invalidSettings = {
        model: {
          name: {
            invalidKey: true,
          },
        },
      };

      const result = validateSettings(invalidSettings);
      expect(result.success).toBe(false);

      if (result.error) {
        const formatted = formatValidationError(
          result.error,
          '/path/to/settings.json',
        );

        expect(formatted).toContain('/path/to/settings.json');
        expect(formatted).toContain('model.name');
        expect(formatted).toContain('Expected: string, but received: object');
        expect(formatted).toContain('Please fix the configuration.');
        expect(formatted).toContain(
          'See the settings documentation for details.',
        );
      }
    });

    it('should format error for model.summarizeToolOutput', () => {
      const invalidSettings = {
        model: {
          summarizeToolOutput: 'wrong type',
        },
      };

      const result = validateSettings(invalidSettings);
      expect(result.success).toBe(false);

      if (result.error) {
        const formatted = formatValidationError(
          result.error,
          `~/${CONFIG_DIR}/settings.json`,
        );

        expect(formatted).toContain(`~/${CONFIG_DIR}/settings.json`);
        expect(formatted).toContain('model.summarizeToolOutput');
      }
    });

    it('should reference the documentation', () => {
      const invalidSettings = {
        model: {
          name: { invalid: 'object' }, // model.name should be a string
        },
      };

      const result = validateSettings(invalidSettings);
      expect(result.success).toBe(false);

      if (result.error) {
        const formatted = formatValidationError(result.error, 'test.json');

        expect(formatted).toContain(
          'See the settings documentation for details.',
        );
      }
    });

    it('should list all validation errors', () => {
      const invalidSettings = {
        model: {
          name: { invalid: 'object' },
        },
        ui: {
          maxTurns: 50,
        },
      };

      const result = validateSettings(invalidSettings);
      expect(result.success).toBe(false);

      if (result.error) {
        const formatted = formatValidationError(result.error, 'test.json');

        // Should have multiple errors listed
        expect(formatted.match(/Error in:/g)?.length).toBeGreaterThan(1);
      }
    });

    it('should format array paths correctly (e.g. tools.core[0])', () => {
      const invalidSettings = {
        tools: {
          core: [READ_FILE_TOOL_NAME, 123], // 123 is invalid, expected string
        },
      };

      const result = validateSettings(invalidSettings);
      expect(result.success).toBe(false);

      if (result.error) {
        const formatted = formatValidationError(result.error, 'test.json');
        expect(formatted).toContain('tools.core[1]');
      }
    });

    it('should limit the number of displayed errors', () => {
      const invalidSettings = {
        tools: {
          // Create 6 invalid items to trigger the limit
          core: [1, 2, 3, 4, 5, 6],
        },
      };

      const result = validateSettings(invalidSettings);
      expect(result.success).toBe(false);

      if (result.error) {
        const formatted = formatValidationError(result.error, 'test.json');
        // Should see the first 5
        expect(formatted).toContain('tools.core[0]');
        expect(formatted).toContain('tools.core[4]');
        // Should NOT see the 6th
        expect(formatted).not.toContain('tools.core[5]');
        // Should see the summary
        expect(formatted).toContain('...and 1 more errors.');
      }
    });
  });

  describe('settingsZodSchema', () => {
    it('should be a valid Zod object schema', () => {
      expect(getSettingsZodSchema()).toBeInstanceOf(z.ZodObject);
    });

    it('should have optional fields', () => {
      // All top-level fields should be optional
      const shape = getSettingsZodSchema().shape;
      expect(shape['model']).toBeDefined();
      expect(shape['ui']).toBeDefined();
      expect(shape['tools']).toBeDefined();

      // Test that empty object is valid (all fields optional)
      const result = getSettingsZodSchema().safeParse({});
      expect(result.success).toBe(true);
    });
  });
});
