/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SubagentValidator } from './validation.js';
import { type SubagentConfig, SubagentError } from './types.js';

describe('SubagentValidator', () => {
  let validator: SubagentValidator;

  beforeEach(() => {
    validator = new SubagentValidator();
  });

  describe('validateName', () => {
    it('should accept valid names', () => {
      const validNames = [
        'test-agent',
        'code_reviewer',
        'agent123',
        'my-helper',
      ];

      for (const name of validNames) {
        const result = validator.validateName(name);
        expect(result.isValid).toBe(true);
        expect(result.errors).toHaveLength(0);
      }
    });

    it('should reject empty or whitespace names', () => {
      const invalidNames = ['', '   ', '\t', '\n'];

      for (const name of invalidNames) {
        const result = validator.validateName(name);
        expect(result.isValid).toBe(false);
        expect(result.errors).toContain('Name is required and cannot be empty');
      }
    });

    it('should reject names that are too short', () => {
      const result = validator.validateName('a');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain(
        'Name must be at least 2 characters long',
      );
    });

    it('should reject names that are too long', () => {
      const longName = 'a'.repeat(51);
      const result = validator.validateName(longName);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Name must be 50 characters or less');
    });

    it('should reject names with invalid characters', () => {
      const invalidNames = ['test@agent', 'agent.name', 'test agent', 'agent!'];

      for (const name of invalidNames) {
        const result = validator.validateName(name);
        expect(result.isValid).toBe(false);
        expect(result.errors).toContain(
          'Name can only contain letters, numbers, hyphens, and underscores',
        );
      }
    });

    it('should reject names starting with special characters', () => {
      const invalidNames = ['-agent', '_agent'];

      for (const name of invalidNames) {
        const result = validator.validateName(name);
        expect(result.isValid).toBe(false);
        expect(result.errors).toContain(
          'Name cannot start with a hyphen or underscore',
        );
      }
    });

    it('should reject names ending with special characters', () => {
      const invalidNames = ['agent-', 'agent_'];

      for (const name of invalidNames) {
        const result = validator.validateName(name);
        expect(result.isValid).toBe(false);
        expect(result.errors).toContain(
          'Name cannot end with a hyphen or underscore',
        );
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
      ];

      for (const name of reservedNames) {
        const result = validator.validateName(name);
        expect(result.isValid).toBe(false);
        expect(result.errors).toContain(
          `"${name}" is a reserved name and cannot be used`,
        );
      }
    });

    it('should warn about naming conventions', () => {
      const result = validator.validateName('TestAgent');
      expect(result.isValid).toBe(true);
      expect(result.warnings).toContain(
        'Consider using lowercase names for consistency',
      );
    });

    it('should warn about mixed separators', () => {
      const result = validator.validateName('test-agent_helper');
      expect(result.isValid).toBe(true);
      expect(result.warnings).toContain(
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
        const result = validator.validateSystemPrompt(prompt);
        expect(result.isValid).toBe(true);
        expect(result.errors).toHaveLength(0);
      }
    });

    it('should reject empty prompts', () => {
      const invalidPrompts = ['', '   ', '\t\n'];

      for (const prompt of invalidPrompts) {
        const result = validator.validateSystemPrompt(prompt);
        expect(result.isValid).toBe(false);
        expect(result.errors).toContain(
          'System prompt is required and cannot be empty',
        );
      }
    });

    it('should reject prompts that are too short', () => {
      const result = validator.validateSystemPrompt('Short');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain(
        'System prompt must be at least 10 characters long',
      );
    });

    it('should warn about long prompts', () => {
      const longPrompt = 'a'.repeat(10001);
      const result = validator.validateSystemPrompt(longPrompt);
      expect(result.isValid).toBe(true);
      expect(result.warnings).toContain(
        'System prompt is quite long (>10,000 characters), consider shortening',
      );
    });
  });

  describe('validateTools', () => {
    it('should accept valid tool arrays', () => {
      const result = validator.validateTools(['read_file', 'write_file']);
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject non-array inputs', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = validator.validateTools('not-an-array' as any);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Tools must be an array of strings');
    });

    it('should warn about empty arrays', () => {
      const result = validator.validateTools([]);
      expect(result.isValid).toBe(true);
      expect(result.warnings).toContain(
        'Empty tools array - subagent will inherit all available tools',
      );
    });

    it('should warn about duplicate tools', () => {
      const result = validator.validateTools([
        'read_file',
        'read_file',
        'write_file',
      ]);
      expect(result.isValid).toBe(true);
      expect(result.warnings).toContain(
        'Duplicate tool names found in tools array',
      );
    });

    it('should reject non-string tool names', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = validator.validateTools([123, 'read_file'] as any);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain(
        'Tool name must be a string, got: number',
      );
    });

    it('should reject empty tool names', () => {
      const result = validator.validateTools(['', 'read_file']);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Tool name cannot be empty');
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
        const result = validator.validateModel(model);
        expect(result.isValid).toBe(true);
        expect(result.errors).toHaveLength(0);
      }
    });

    it('should reject empty model selectors', () => {
      const result = validator.validateModel('');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Model must be a non-empty string');
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
      const result = validator.validateModel('openai:');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain(
        'Model selector must include a model ID after the authType',
      );
    });

    it('should warn when inherit is explicit', () => {
      const result = validator.validateModel('inherit');
      expect(result.isValid).toBe(true);
      expect(result.warnings).toContain(
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
        const result = validator.validateRunConfig(config);
        expect(result.isValid).toBe(true);
        expect(result.errors).toHaveLength(0);
      }
    });

    it('should reject invalid max_time_minutes', () => {
      const invalidTimes = [0, -1, 'not-a-number'];

      for (const time of invalidTimes) {
        const result = validator.validateRunConfig({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          max_time_minutes: time as any,
        });
        expect(result.isValid).toBe(false);
      }
    });

    it('should warn about very long execution times', () => {
      const result = validator.validateRunConfig({ max_time_minutes: 120 });
      expect(result.isValid).toBe(true);
      expect(result.warnings).toContain(
        'Very long execution time (>60 minutes) may cause resource issues',
      );
    });

    it('should reject invalid max_turns', () => {
      const invalidTurns = [0, -1, 1.5, 'not-a-number'];

      for (const turns of invalidTurns) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = validator.validateRunConfig({ max_turns: turns as any });
        expect(result.isValid).toBe(false);
      }
    });

    it('should warn about high turn limits', () => {
      const result = validator.validateRunConfig({ max_turns: 150 });
      expect(result.isValid).toBe(true);
      expect(result.warnings).toContain(
        'Very high turn limit (>100) may cause long execution times',
      );
    });
  });

  describe('validateConfig', () => {
    const validConfig: SubagentConfig = {
      name: 'test-agent',
      description: 'A test subagent',
      systemPrompt: 'You are a helpful assistant.',
      level: 'project',
      filePath: '/path/to/test-agent.md',
    };

    it('should accept valid configurations', () => {
      const result = validator.validateConfig(validConfig);
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should accept valid disallowedTools', () => {
      const result = validator.validateConfig({
        ...validConfig,
        disallowedTools: ['write_file', 'mcp__slack'],
      });
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject non-string entries in disallowedTools', () => {
      const result = validator.validateConfig({
        ...validConfig,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        disallowedTools: [123, 'write_file'] as any,
      });
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain(
        'Tool name must be a string, got: number',
      );
    });

    it('should reject empty strings in disallowedTools', () => {
      const result = validator.validateConfig({
        ...validConfig,
        disallowedTools: ['', 'write_file'],
      });
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Tool name cannot be empty');
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
    const validConfig: SubagentConfig = {
      name: 'test-agent',
      description: 'A test subagent',
      systemPrompt: 'You are a helpful assistant.',
      level: 'project',
      filePath: '/path/to/test-agent.md',
    };

    it('should not throw for valid configurations', () => {
      expect(() => validator.validateOrThrow(validConfig)).not.toThrow();
    });

    it('should throw SubagentError for invalid configurations', () => {
      const invalidConfig: SubagentConfig = {
        ...validConfig,
        name: '',
      };

      expect(() => validator.validateOrThrow(invalidConfig)).toThrow(
        SubagentError,
      );
      expect(() => validator.validateOrThrow(invalidConfig)).toThrow(
        /Validation failed/,
      );
    });

    it('should include subagent name in error', () => {
      const invalidConfig: SubagentConfig = {
        ...validConfig,
        name: '',
      };

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
