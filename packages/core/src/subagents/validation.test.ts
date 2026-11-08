/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SubagentValidator } from './validation.js';
import {
  type SubagentConfig,
  SubagentError,
  type ValidationResult,
} from './types.js';

/** Valid, with no errors. */
function expectValid(result: ValidationResult) {
  expect(result.isValid).toBe(true);
  expect(result.errors).toHaveLength(0);
}

/** Invalid, listing `error`. */
function expectError(result: ValidationResult, error: string) {
  expect(result.isValid).toBe(false);
  expect(result.errors).toContain(error);
}

/** Still valid, but listing `warning`. */
function expectWarning(result: ValidationResult, warning: string) {
  expect(result.isValid).toBe(true);
  expect(result.warnings).toContain(warning);
}

describe('SubagentValidator', () => {
  let validator: SubagentValidator;

  beforeEach(() => {
    validator = new SubagentValidator();
  });

  const validConfig: SubagentConfig = {
    name: 'test-agent',
    description: 'A test subagent',
    systemPrompt: 'You are a helpful assistant.',
    level: 'project',
    filePath: '/path/to/test-agent.md',
  };

  it.each(
    [null, false, 'local', 'docker', '', [], {}].map((executionBackend) => ({
      executionBackend,
    })),
  )(
    'rejects invalid executionBackend=$executionBackend on direct create/update configurations',
    ({ executionBackend }) => {
      const config = {
        name: 'test-agent',
        description: 'A test agent',
        systemPrompt: 'Complete the requested task.',
        level: 'project',
        executionBackend,
      } as unknown as SubagentConfig;
      expect(validator.validateConfig(config)).toMatchObject({
        isValid: false,
        errors: expect.arrayContaining([
          'executionBackend must be "container" when provided',
        ]),
      });
      expect(() => validator.validateOrThrow(config)).toThrow(
        'executionBackend',
      );
    },
  );

  describe('validateName', () => {
    it('should accept valid names', () => {
      const validNames = [
        'test-agent',
        'code_reviewer',
        'agent123',
        'my-helper',
        '项目管理',
        'コードレビュー',
        '코드리뷰',
        '项目-manager',
        'проект_менеджер',
      ];

      for (const name of validNames) {
        expectValid(validator.validateName(name));
      }
    });

    it.each([
      [
        'should reject empty or whitespace names',
        ['', '   ', '\t', '\n'],
        'Name is required and cannot be empty',
      ],
      [
        'should reject names that are too short',
        ['a'],
        'Name must be at least 2 characters long',
      ],
      [
        'should reject names that are too long',
        ['a'.repeat(51)],
        'Name must be 50 characters or less',
      ],
      [
        'should reject names with invalid characters',
        ['test@agent', 'agent.name', 'test agent', 'agent!'],
        'Name can only contain letters, numbers, hyphens, and underscores',
      ],
      [
        'should reject names starting with special characters',
        ['-agent', '_agent'],
        'Name cannot start with a hyphen or underscore',
      ],
      [
        'should reject names ending with special characters',
        ['agent-', 'agent_'],
        'Name cannot end with a hyphen or underscore',
      ],
    ])('%s', (_title, names, error) => {
      for (const name of names) {
        expectError(validator.validateName(name), error);
      }
    });

    it('should reject reserved names', () => {
      const reservedNames = [
        'self',
        'system',
        'user',
        'model',
        'tool',
        'config',
        'default',
        'main',
      ];

      for (const name of reservedNames) {
        expectError(
          validator.validateName(name),
          `"${name}" is a reserved name and cannot be used`,
        );
      }
    });

    it('should warn about naming conventions', () => {
      expectWarning(
        validator.validateName('TestAgent'),
        'Consider using lowercase names for consistency',
      );
    });

    it('should not warn about case for non-Latin names', () => {
      const result = validator.validateName('项目管理');
      expect(result.isValid).toBe(true);
      expect(result.warnings).not.toContain(
        'Consider using lowercase names for consistency',
      );
    });

    it('should warn about mixed separators', () => {
      expectWarning(
        validator.validateName('test-agent_helper'),
        'Consider using either hyphens or underscores consistently, not both',
      );
    });
  });

  describe('validateSystemPrompt', () => {
    it('should accept valid system prompts', () => {
      const validPrompts = [
        'You are a helpful assistant.',
        'You are a code reviewer. Analyze the provided code and suggest improvements.',
        'Help the user with ${task} by using available tools.',
      ];

      for (const prompt of validPrompts) {
        expectValid(validator.validateSystemPrompt(prompt));
      }
    });

    it('should reject empty prompts', () => {
      for (const prompt of ['', '   ', '\t\n']) {
        expectError(
          validator.validateSystemPrompt(prompt),
          'System prompt is required and cannot be empty',
        );
      }
    });

    it('should reject prompts that are too short', () => {
      expectError(
        validator.validateSystemPrompt('Short'),
        'System prompt must be at least 10 characters long',
      );
    });

    it('should warn about long prompts', () => {
      expectWarning(
        validator.validateSystemPrompt('a'.repeat(10001)),
        'System prompt is quite long (>10,000 characters), consider shortening',
      );
    });
  });

  describe('validateTools', () => {
    it('should accept valid tool arrays', () => {
      expectValid(validator.validateTools(['read_file', 'write_file']));
    });

    it('should reject non-array inputs', () => {
      expectError(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        validator.validateTools('not-an-array' as any),
        'Tools must be an array of strings',
      );
    });

    it('should warn about empty arrays', () => {
      expectWarning(
        validator.validateTools([]),
        'Empty tools array - subagent will inherit all available tools (any disallowedTools still apply)',
      );
    });

    it('should warn about duplicate tools', () => {
      expectWarning(
        validator.validateTools(['read_file', 'read_file', 'write_file']),
        'Duplicate tool names found in tools array',
      );
    });

    it('should reject non-string tool names', () => {
      expectError(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        validator.validateTools([123, 'read_file'] as any),
        'Tool name must be a string, got: number',
      );
    });

    it('should reject empty tool names', () => {
      expectError(
        validator.validateTools(['', 'read_file']),
        'Tool name cannot be empty',
      );
    });
  });

  describe('validateModel', () => {
    it('should accept valid model selectors', () => {
      const validModels = [
        'inherit',
        'glm-5',
        'claude-sonnet-4-6',
        'openai:glm-5',
        'anthropic:sonnet',
      ];

      for (const model of validModels) {
        expectValid(validator.validateModel(model));
      }
    });

    it('should reject empty model selectors', () => {
      expectError(
        validator.validateModel(''),
        'Model must be a non-empty string',
      );
    });

    it('should accept model IDs containing colons with unknown prefix', () => {
      const result = validator.validateModel('invalid:glm-5');
      expect(result.isValid).toBe(true);
    });

    it('should accept model IDs with colons (e.g. gpt-4o:online)', () => {
      const result = validator.validateModel('gpt-4o:online');
      expect(result.isValid).toBe(true);
    });

    it('should reject missing model IDs after valid authType prefixes', () => {
      expectError(
        validator.validateModel('openai:'),
        'Model selector must include a model ID after the authType',
      );
    });

    it('should warn when inherit is explicit', () => {
      expectWarning(
        validator.validateModel('inherit'),
        'Explicit "inherit" is optional because omitting the model uses the main conversation model',
      );
    });
  });

  describe('validateRunConfig', () => {
    it('should accept valid run configurations', () => {
      const validConfigs = [
        { max_time_minutes: 10, max_turns: 20 },
        { max_time_minutes: 5 },
        { max_turns: 10 },
        {},
      ];

      for (const config of validConfigs) {
        expectValid(validator.validateRunConfig(config));
      }
    });

    it('should reject invalid max_time_minutes', () => {
      for (const time of [0, -1, 'not-a-number']) {
        const result = validator.validateRunConfig({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          max_time_minutes: time as any,
        });
        expect(result.isValid).toBe(false);
      }
    });

    it('should warn about very long execution times', () => {
      expectWarning(
        validator.validateRunConfig({ max_time_minutes: 120 }),
        'Very long execution time (>60 minutes) may cause resource issues',
      );
    });

    it('should reject invalid max_turns', () => {
      for (const turns of [0, -1, 1.5, 'not-a-number']) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = validator.validateRunConfig({ max_turns: turns as any });
        expect(result.isValid).toBe(false);
      }
    });

    it('should warn about high turn limits', () => {
      expectWarning(
        validator.validateRunConfig({ max_turns: 150 }),
        'Very high turn limit (>100) may cause long execution times',
      );
    });
  });

  describe('validateConfig', () => {
    it('should accept valid configurations', () => {
      expectValid(validator.validateConfig(validConfig));
    });

    it('should accept valid disallowedTools', () => {
      expectValid(
        validator.validateConfig({
          ...validConfig,
          disallowedTools: ['write_file', 'mcp__slack'],
        }),
      );
    });

    it('should reject non-string entries in disallowedTools', () => {
      expectError(
        validator.validateConfig({
          ...validConfig,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          disallowedTools: [123, 'write_file'] as any,
        }),
        'Tool name must be a string, got: number',
      );
    });

    it('should reject empty strings in disallowedTools', () => {
      expectError(
        validator.validateConfig({
          ...validConfig,
          disallowedTools: ['', 'write_file'],
        }),
        'Tool name cannot be empty',
      );
    });

    it('should collect errors from all validation steps', () => {
      const invalidConfig: SubagentConfig = {
        name: '',
        description: '',
        systemPrompt: '',
        level: 'project',
        filePath: '/path/to/invalid.md',
      };

      const result = validator.validateConfig(invalidConfig);
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should collect warnings from all validation steps', () => {
      const configWithWarnings: SubagentConfig = {
        ...validConfig,
        name: 'TestAgent', // Will generate warning about case
        description: 'A'.repeat(1001), // Will generate warning about long description
      };

      const result = validator.validateConfig(configWithWarnings);
      expect(result.isValid).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
    });
  });

  describe('validateOrThrow', () => {
    const invalidConfig: SubagentConfig = {
      ...validConfig,
      name: '',
    };

    it('should not throw for valid configurations', () => {
      expect(() => validator.validateOrThrow(validConfig)).not.toThrow();
    });

    it('should throw SubagentError for invalid configurations', () => {
      expect(() => validator.validateOrThrow(invalidConfig)).toThrow(
        SubagentError,
      );
      expect(() => validator.validateOrThrow(invalidConfig)).toThrow(
        /Validation failed/,
      );
    });

    it('should include subagent name in error', () => {
      try {
        validator.validateOrThrow(invalidConfig, 'custom-name');
        expect.fail('Should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(SubagentError);
        expect((error as SubagentError).subagentName).toBe('custom-name');
      }
    });
  });
});
