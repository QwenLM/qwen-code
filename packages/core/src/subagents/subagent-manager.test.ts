/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SubagentManager } from './subagent-manager.js';
import { SubagentConfig, SubagentError } from './types.js';
import { ToolRegistry } from '../tools/tool-registry.js';

// Mock file system operations
vi.mock('fs/promises');
vi.mock('os');

// Mock yaml parser - use vi.hoisted for proper hoisting
const mockParseYaml = vi.hoisted(() => vi.fn());
const mockStringifyYaml = vi.hoisted(() => vi.fn());

vi.mock('../utils/yaml-parser.js', () => ({
  parse: mockParseYaml,
  stringify: mockStringifyYaml,
}));

// Mock dependencies - create mock functions at the top level
const mockValidateConfig = vi.hoisted(() => vi.fn());
const mockValidateOrThrow = vi.hoisted(() => vi.fn());

vi.mock('./validation.js', () => ({
  SubagentValidator: class MockSubagentValidator {
    validateConfig = mockValidateConfig;
    validateOrThrow = mockValidateOrThrow;
  },
}));

vi.mock('../core/subagent.js');

describe('SubagentManager', () => {
  let manager: SubagentManager;
  let mockToolRegistry: ToolRegistry;
  const projectRoot = '/test/project';

  beforeEach(() => {
    mockToolRegistry = {} as ToolRegistry;

    // Mock os.homedir
    vi.mocked(os.homedir).mockReturnValue('/home/user');

    // Reset and setup mocks
    vi.clearAllMocks();
    mockValidateConfig.mockReturnValue({
      isValid: true,
      errors: [],
      warnings: [],
    });
    mockValidateOrThrow.mockImplementation(() => {});

    // Setup yaml parser mocks with sophisticated behavior
    mockParseYaml.mockImplementation((yamlString: string) => {
      // Handle different test cases based on YAML content
      if (yamlString.includes('tools:')) {
        return {
          name: 'test-agent',
          description: 'A test subagent',
          tools: ['read_file', 'write_file'],
        };
      }
      if (yamlString.includes('modelConfig:')) {
        return {
          name: 'test-agent',
          description: 'A test subagent',
          modelConfig: { model: 'custom-model', temp: 0.5 },
        };
      }
      if (yamlString.includes('runConfig:')) {
        return {
          name: 'test-agent',
          description: 'A test subagent',
          runConfig: { max_time_minutes: 5, max_turns: 10 },
        };
      }
      if (yamlString.includes('name: agent1')) {
        return { name: 'agent1', description: 'First agent' };
      }
      if (yamlString.includes('name: agent2')) {
        return { name: 'agent2', description: 'Second agent' };
      }
      if (yamlString.includes('name: agent3')) {
        return { name: 'agent3', description: 'Third agent' };
      }
      if (!yamlString.includes('name:')) {
        return { description: 'A test subagent' }; // Missing name case
      }
      if (!yamlString.includes('description:')) {
        return { name: 'test-agent' }; // Missing description case
      }
      // Default case
      return {
        name: 'test-agent',
        description: 'A test subagent',
      };
    });

    mockStringifyYaml.mockImplementation((obj: Record<string, unknown>) => {
      let yaml = '';
      for (const [key, value] of Object.entries(obj)) {
        if (key === 'tools' && Array.isArray(value)) {
          yaml += `tools:\n${value.map((tool) => `  - ${tool}`).join('\n')}\n`;
        } else if (
          key === 'modelConfig' &&
          typeof value === 'object' &&
          value
        ) {
          yaml += `modelConfig:\n`;
          for (const [k, v] of Object.entries(
            value as Record<string, unknown>,
          )) {
            yaml += `  ${k}: ${v}\n`;
          }
        } else if (key === 'runConfig' && typeof value === 'object' && value) {
          yaml += `runConfig:\n`;
          for (const [k, v] of Object.entries(
            value as Record<string, unknown>,
          )) {
            yaml += `  ${k}: ${v}\n`;
          }
        } else {
          yaml += `${key}: ${value}\n`;
        }
      }
      return yaml.trim();
    });

    manager = new SubagentManager(projectRoot, mockToolRegistry);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const validConfig: SubagentConfig = {
    name: 'test-agent',
    description: 'A test subagent',
    systemPrompt: 'You are a helpful assistant.',
    level: 'project',
    filePath: '/test/project/.qwen/agents/test-agent.md',
  };

  const validMarkdown = `---
name: test-agent
description: A test subagent
---

You are a helpful assistant.
`;

  describe('parseSubagentContent', () => {
    it('should parse valid markdown content', () => {
      const config = manager.parseSubagentContent(
        validMarkdown,
        validConfig.filePath,
      );

      expect(config.name).toBe('test-agent');
      expect(config.description).toBe('A test subagent');
      expect(config.systemPrompt).toBe('You are a helpful assistant.');
      expect(config.level).toBe('project');
      expect(config.filePath).toBe(validConfig.filePath);
    });

    it('should parse content with tools', () => {
      const markdownWithTools = `---
name: test-agent
description: A test subagent
tools:
  - read_file
  - write_file
---

You are a helpful assistant.
`;

      const config = manager.parseSubagentContent(
        markdownWithTools,
        validConfig.filePath,
      );

      expect(config.tools).toEqual(['read_file', 'write_file']);
    });

    it('should parse content with model config', () => {
      const markdownWithModel = `---
name: test-agent
description: A test subagent
modelConfig:
  model: custom-model
  temp: 0.5
---

You are a helpful assistant.
`;

      const config = manager.parseSubagentContent(
        markdownWithModel,
        validConfig.filePath,
      );

      expect(config.modelConfig).toEqual({ model: 'custom-model', temp: 0.5 });
    });

    it('should parse content with run config', () => {
      const markdownWithRun = `---
name: test-agent
description: A test subagent
runConfig:
  max_time_minutes: 5
  max_turns: 10
---

You are a helpful assistant.
`;

      const config = manager.parseSubagentContent(
        markdownWithRun,
        validConfig.filePath,
      );

      expect(config.runConfig).toEqual({ max_time_minutes: 5, max_turns: 10 });
    });

    it('should determine level from file path', () => {
      const projectPath = '/test/project/.qwen/agents/test-agent.md';
      const userPath = '/home/user/.qwen/agents/test-agent.md';

      const projectConfig = manager.parseSubagentContent(
        validMarkdown,
        projectPath,
      );
      const userConfig = manager.parseSubagentContent(validMarkdown, userPath);

      expect(projectConfig.level).toBe('project');
      expect(userConfig.level).toBe('user');
    });

    it('should throw error for invalid frontmatter format', () => {
      const invalidMarkdown = `No frontmatter here
Just content`;

      expect(() =>
        manager.parseSubagentContent(invalidMarkdown, validConfig.filePath),
      ).toThrow(SubagentError);
    });

    it('should throw error for missing name', () => {
      const markdownWithoutName = `---
description: A test subagent
---

You are a helpful assistant.
`;

      expect(() =>
        manager.parseSubagentContent(markdownWithoutName, validConfig.filePath),
      ).toThrow(SubagentError);
    });

    it('should throw error for missing description', () => {
      const markdownWithoutDescription = `---
name: test-agent
---

You are a helpful assistant.
`;

      expect(() =>
        manager.parseSubagentContent(
          markdownWithoutDescription,
          validConfig.filePath,
        ),
      ).toThrow(SubagentError);
    });
  });

  describe('serializeSubagent', () => {
    it('should serialize basic configuration', () => {
      const serialized = manager.serializeSubagent(validConfig);

      expect(serialized).toContain('name: test-agent');
      expect(serialized).toContain('description: A test subagent');
      expect(serialized).toContain('You are a helpful assistant.');
      expect(serialized).toMatch(/^---\n[\s\S]*\n---\n\n[\s\S]*\n$/);
    });

    it('should serialize configuration with tools', () => {
      const configWithTools: SubagentConfig = {
        ...validConfig,
        tools: ['read_file', 'write_file'],
      };

      const serialized = manager.serializeSubagent(configWithTools);

      expect(serialized).toContain('tools:');
      expect(serialized).toContain('- read_file');
      expect(serialized).toContain('- write_file');
    });

    it('should serialize configuration with model config', () => {
      const configWithModel: SubagentConfig = {
        ...validConfig,
        modelConfig: { model: 'custom-model', temp: 0.5 },
      };

      const serialized = manager.serializeSubagent(configWithModel);

      expect(serialized).toContain('modelConfig:');
      expect(serialized).toContain('model: custom-model');
      expect(serialized).toContain('temp: 0.5');
    });

    it('should not include empty optional fields', () => {
      const serialized = manager.serializeSubagent(validConfig);

      expect(serialized).not.toContain('tools:');
      expect(serialized).not.toContain('modelConfig:');
      expect(serialized).not.toContain('runConfig:');
    });
  });

  describe('createSubagent', () => {
    beforeEach(() => {
      // Mock successful file operations
      vi.mocked(fs.access).mockRejectedValue(new Error('File not found'));
      vi.mocked(fs.mkdir).mockResolvedValue(undefined);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    });

    it('should create subagent successfully', async () => {
      await manager.createSubagent(validConfig, { level: 'project' });

      expect(fs.mkdir).toHaveBeenCalledWith(
        path.dirname(validConfig.filePath),
        { recursive: true },
      );
      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('test-agent.md'),
        expect.stringContaining('name: test-agent'),
        'utf8',
      );
    });

    it('should throw error if file already exists and overwrite is false', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined); // File exists

      await expect(
        manager.createSubagent(validConfig, { level: 'project' }),
      ).rejects.toThrow(SubagentError);

      await expect(
        manager.createSubagent(validConfig, { level: 'project' }),
      ).rejects.toThrow(/already exists/);
    });

    it('should overwrite file when overwrite is true', async () => {
      vi.mocked(fs.access).mockResolvedValue(undefined); // File exists

      await manager.createSubagent(validConfig, {
        level: 'project',
        overwrite: true,
      });

      expect(fs.writeFile).toHaveBeenCalled();
    });

    it('should use custom path when provided', async () => {
      const customPath = '/custom/path/agent.md';

      await manager.createSubagent(validConfig, {
        level: 'project',
        customPath,
      });

      expect(fs.writeFile).toHaveBeenCalledWith(
        customPath,
        expect.any(String),
        'utf8',
      );
    });

    it('should throw error on file write failure', async () => {
      vi.mocked(fs.writeFile).mockRejectedValue(new Error('Write failed'));

      await expect(
        manager.createSubagent(validConfig, { level: 'project' }),
      ).rejects.toThrow(SubagentError);

      await expect(
        manager.createSubagent(validConfig, { level: 'project' }),
      ).rejects.toThrow(/Failed to write subagent file/);
    });
  });

  describe('loadSubagent', () => {
    it('should load subagent from project level first', async () => {
      vi.mocked(fs.readFile).mockResolvedValue(validMarkdown);

      const config = await manager.loadSubagent('test-agent');

      expect(config).toBeDefined();
      expect(config!.name).toBe('test-agent');
      expect(fs.readFile).toHaveBeenCalledWith(
        '/test/project/.qwen/agents/test-agent.md',
        'utf8',
      );
    });

    it('should fall back to user level if project level fails', async () => {
      vi.mocked(fs.readFile)
        .mockRejectedValueOnce(new Error('Not found'))
        .mockResolvedValueOnce(validMarkdown);

      const config = await manager.loadSubagent('test-agent');

      expect(config).toBeDefined();
      expect(config!.name).toBe('test-agent');
      expect(fs.readFile).toHaveBeenCalledWith(
        '/home/user/.qwen/agents/test-agent.md',
        'utf8',
      );
    });

    it('should return null if not found at either level', async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error('Not found'));

      const config = await manager.loadSubagent('nonexistent');

      expect(config).toBeNull();
    });
  });

  describe('updateSubagent', () => {
    beforeEach(() => {
      vi.mocked(fs.readFile).mockResolvedValue(validMarkdown);
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    });

    it('should update existing subagent', async () => {
      const updates = { description: 'Updated description' };

      await manager.updateSubagent('test-agent', updates);

      expect(fs.writeFile).toHaveBeenCalledWith(
        expect.stringContaining('test-agent.md'),
        expect.stringContaining('Updated description'),
        'utf8',
      );
    });

    it('should throw error if subagent not found', async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error('Not found'));

      await expect(manager.updateSubagent('nonexistent', {})).rejects.toThrow(
        SubagentError,
      );

      await expect(manager.updateSubagent('nonexistent', {})).rejects.toThrow(
        /not found/,
      );
    });

    it('should throw error on write failure', async () => {
      vi.mocked(fs.writeFile).mockRejectedValue(new Error('Write failed'));

      await expect(manager.updateSubagent('test-agent', {})).rejects.toThrow(
        SubagentError,
      );

      await expect(manager.updateSubagent('test-agent', {})).rejects.toThrow(
        /Failed to update subagent file/,
      );
    });
  });

  describe('deleteSubagent', () => {
    it('should delete subagent from specified level', async () => {
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      await manager.deleteSubagent('test-agent', 'project');

      expect(fs.unlink).toHaveBeenCalledWith(
        '/test/project/.qwen/agents/test-agent.md',
      );
    });

    it('should delete from both levels if no level specified', async () => {
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      await manager.deleteSubagent('test-agent');

      expect(fs.unlink).toHaveBeenCalledTimes(2);
      expect(fs.unlink).toHaveBeenCalledWith(
        '/test/project/.qwen/agents/test-agent.md',
      );
      expect(fs.unlink).toHaveBeenCalledWith(
        '/home/user/.qwen/agents/test-agent.md',
      );
    });

    it('should throw error if subagent not found', async () => {
      vi.mocked(fs.unlink).mockRejectedValue(new Error('Not found'));

      await expect(manager.deleteSubagent('nonexistent')).rejects.toThrow(
        SubagentError,
      );

      await expect(manager.deleteSubagent('nonexistent')).rejects.toThrow(
        /not found/,
      );
    });

    it('should succeed if deleted from at least one level', async () => {
      vi.mocked(fs.unlink)
        .mockRejectedValueOnce(new Error('Not found'))
        .mockResolvedValueOnce(undefined);

      await expect(manager.deleteSubagent('test-agent')).resolves.not.toThrow();
    });
  });

  describe('listSubagents', () => {
    beforeEach(() => {
      // Mock directory listing
      vi.mocked(fs.readdir)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValueOnce(['agent1.md', 'agent2.md', 'not-md.txt'] as any)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValueOnce(['agent3.md', 'agent1.md'] as any); // user level

      // Mock file reading for valid agents
      vi.mocked(fs.readFile).mockImplementation((filePath) => {
        const pathStr = String(filePath);
        if (pathStr.includes('agent1.md')) {
          return Promise.resolve(`---
name: agent1
description: First agent
---
System prompt 1`);
        } else if (pathStr.includes('agent2.md')) {
          return Promise.resolve(`---
name: agent2
description: Second agent
---
System prompt 2`);
        } else if (pathStr.includes('agent3.md')) {
          return Promise.resolve(`---
name: agent3
description: Third agent
---
System prompt 3`);
        }
        return Promise.reject(new Error('File not found'));
      });
    });

    it('should list subagents from both levels', async () => {
      const subagents = await manager.listSubagents();

      expect(subagents).toHaveLength(3); // agent1 (project takes precedence), agent2, agent3
      expect(subagents.map((s) => s.name)).toEqual([
        'agent1',
        'agent2',
        'agent3',
      ]);
    });

    it('should prioritize project level over user level', async () => {
      const subagents = await manager.listSubagents();
      const agent1 = subagents.find((s) => s.name === 'agent1');

      expect(agent1!.level).toBe('project');
    });

    it('should filter by level', async () => {
      const projectSubagents = await manager.listSubagents({
        level: 'project',
      });

      expect(projectSubagents).toHaveLength(2); // agent1, agent2
      expect(projectSubagents.every((s) => s.level === 'project')).toBe(true);
    });

    it('should sort by name', async () => {
      const subagents = await manager.listSubagents({
        sortBy: 'name',
        sortOrder: 'asc',
      });

      const names = subagents.map((s) => s.name);
      expect(names).toEqual(['agent1', 'agent2', 'agent3']);
    });

    it('should handle empty directories', async () => {
      // Reset all mocks for this specific test
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.readdir).mockResolvedValue([] as any);
      vi.mocked(fs.readFile).mockRejectedValue(new Error('No files'));

      const subagents = await manager.listSubagents();

      expect(subagents).toHaveLength(0);
    });

    it('should handle directory read errors', async () => {
      // Reset all mocks for this specific test
      vi.mocked(fs.readdir).mockRejectedValue(new Error('Directory not found'));
      vi.mocked(fs.readFile).mockRejectedValue(new Error('No files'));

      const subagents = await manager.listSubagents();

      expect(subagents).toHaveLength(0);
    });

    it('should skip invalid subagent files', async () => {
      // Reset all mocks for this specific test
      vi.mocked(fs.readdir)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValueOnce(['valid.md', 'invalid.md'] as any)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValueOnce(['valid.md', 'invalid.md'] as any); // user level
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(validMarkdown) // valid.md project level
        .mockRejectedValueOnce(new Error('Invalid YAML')) // invalid.md project level
        .mockRejectedValueOnce(new Error('Not found')) // valid.md user level (already found)
        .mockRejectedValueOnce(new Error('Invalid YAML')); // invalid.md user level

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const subagents = await manager.listSubagents();

      expect(subagents).toHaveLength(1);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skipping invalid subagent file'),
      );

      consoleSpy.mockRestore();
    });
  });

  describe('findSubagentByName', () => {
    it('should find existing subagent', async () => {
      vi.mocked(fs.readFile).mockResolvedValue(validMarkdown);

      const metadata = await manager.findSubagentByName('test-agent');

      expect(metadata).toBeDefined();
      expect(metadata!.name).toBe('test-agent');
      expect(metadata!.description).toBe('A test subagent');
    });

    it('should return null for non-existent subagent', async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error('Not found'));

      const metadata = await manager.findSubagentByName('nonexistent');

      expect(metadata).toBeNull();
    });
  });

  describe('isNameAvailable', () => {
    it('should return true for available names', async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error('Not found'));

      const available = await manager.isNameAvailable('new-agent');

      expect(available).toBe(true);
    });

    it('should return false for existing names', async () => {
      vi.mocked(fs.readFile).mockResolvedValue(validMarkdown);

      const available = await manager.isNameAvailable('test-agent');

      expect(available).toBe(false);
    });

    it('should check specific level when provided', async () => {
      // The isNameAvailable method loads from both levels and checks if found subagent is at different level
      // First call: loads subagent (found at user level), checks if it's at project level (different) -> available
      vi.mocked(fs.readFile)
        .mockRejectedValueOnce(new Error('Not found')) // project level
        .mockResolvedValueOnce(validMarkdown); // user level - found here

      const availableAtProject = await manager.isNameAvailable(
        'test-agent',
        'project',
      );
      expect(availableAtProject).toBe(true); // Available at project because found at user level

      // Second call: loads subagent (found at user level), checks if it's at user level (same) -> not available
      vi.mocked(fs.readFile)
        .mockRejectedValueOnce(new Error('Not found')) // project level
        .mockResolvedValueOnce(validMarkdown); // user level - found here

      const availableAtUser = await manager.isNameAvailable(
        'test-agent',
        'user',
      );
      expect(availableAtUser).toBe(false); // Not available at user because found at user level
    });
  });

  describe('Runtime Configuration Methods', () => {
    describe('convertToRuntimeConfig', () => {
      it('should convert basic configuration', () => {
        const runtimeConfig = manager.convertToRuntimeConfig(validConfig);

        expect(runtimeConfig.promptConfig.systemPrompt).toBe(
          validConfig.systemPrompt,
        );
        expect(runtimeConfig.modelConfig).toEqual({});
        expect(runtimeConfig.runConfig).toEqual({});
        expect(runtimeConfig.toolConfig).toBeUndefined();
      });

      it('should include tool configuration when tools are specified', () => {
        const configWithTools: SubagentConfig = {
          ...validConfig,
          tools: ['read_file', 'write_file'],
        };

        const runtimeConfig = manager.convertToRuntimeConfig(configWithTools);

        expect(runtimeConfig.toolConfig).toBeDefined();
        expect(runtimeConfig.toolConfig!.tools).toEqual([
          'read_file',
          'write_file',
        ]);
      });

      it('should merge custom model and run configurations', () => {
        const configWithCustom: SubagentConfig = {
          ...validConfig,
          modelConfig: { model: 'custom-model', temp: 0.5 },
          runConfig: { max_time_minutes: 5 },
        };

        const runtimeConfig = manager.convertToRuntimeConfig(configWithCustom);

        expect(runtimeConfig.modelConfig.model).toBe('custom-model');
        expect(runtimeConfig.modelConfig.temp).toBe(0.5);
        expect(runtimeConfig.runConfig.max_time_minutes).toBe(5);
        // No default values are provided anymore
        expect(Object.keys(runtimeConfig.modelConfig)).toEqual([
          'model',
          'temp',
        ]);
        expect(Object.keys(runtimeConfig.runConfig)).toEqual([
          'max_time_minutes',
        ]);
      });
    });

    describe('mergeConfigurations', () => {
      it('should merge basic properties', () => {
        const updates = {
          description: 'Updated description',
          systemPrompt: 'Updated prompt',
        };

        const merged = manager.mergeConfigurations(validConfig, updates);

        expect(merged.description).toBe('Updated description');
        expect(merged.systemPrompt).toBe('Updated prompt');
        expect(merged.name).toBe(validConfig.name); // Should keep original
      });

      it('should merge nested configurations', () => {
        const configWithNested: SubagentConfig = {
          ...validConfig,
          modelConfig: { model: 'original-model', temp: 0.7 },
          runConfig: { max_time_minutes: 10, max_turns: 20 },
        };

        const updates = {
          modelConfig: { temp: 0.5 },
          runConfig: { max_time_minutes: 5 },
        };

        const merged = manager.mergeConfigurations(configWithNested, updates);

        expect(merged.modelConfig!.model).toBe('original-model'); // Should keep original
        expect(merged.modelConfig!.temp).toBe(0.5); // Should update
        expect(merged.runConfig!.max_time_minutes).toBe(5); // Should update
        expect(merged.runConfig!.max_turns).toBe(20); // Should keep original
      });
    });
  });
});
