/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SkillTool, type SkillParams } from './skill.js';
import type { PartListUnion } from '@google/genai';
import type { ToolResultDisplay } from './tools.js';
import type { Config } from '../config/config.js';
import { SkillManager } from '../skills/skill-manager.js';
import type { SkillConfig } from '../skills/types.js';
import { partToString } from '../utils/partUtils.js';

// Type for accessing protected methods in tests
type SkillToolWithProtectedMethods = SkillTool & {
  createInvocation: (params: SkillParams) => {
    execute: (
      signal?: AbortSignal,
      updateOutput?: (output: ToolResultDisplay) => void,
    ) => Promise<{
      llmContent: PartListUnion;
      returnDisplay: ToolResultDisplay;
    }>;
    getDescription: () => string;
    shouldConfirmExecute: () => Promise<boolean>;
  };
};

// Mock dependencies
vi.mock('../skills/skill-manager.js');
vi.mock('../telemetry/index.js', () => ({
  logSkillLaunch: vi.fn(),
  SkillLaunchEvent: class {
    constructor(
      public skill_name: string,
      public success: boolean,
    ) {}
  },
}));

const MockedSkillManager = vi.mocked(SkillManager);

describe('SkillTool', () => {
  let config: Config;
  let skillTool: SkillTool;
  let mockSkillManager: SkillManager;
  let changeListeners: Array<() => void>;

  const mockSkills: SkillConfig[] = [
    {
      name: 'code-review',
      description: 'Specialized skill for reviewing code quality',
      level: 'project',
      filePath: '/project/.qwen/skills/code-review/SKILL.md',
      body: 'Review code for quality and best practices.',
    },
    {
      name: 'testing',
      description: 'Skill for writing and running tests',
      level: 'user',
      filePath: '/home/user/.qwen/skills/testing/SKILL.md',
      body: 'Help write comprehensive tests.',
      allowedTools: ['read_file', 'write_file', 'shell'],
    },
  ];

  beforeEach(async () => {
    // Setup fake timers
    vi.useFakeTimers();

    // Create mock config
    config = {
      getProjectRoot: vi.fn().mockReturnValue('/test/project'),
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getSkillManager: vi.fn(),
      getGeminiClient: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    changeListeners = [];

    // Setup SkillManager mock
    mockSkillManager = {
      listSkills: vi.fn().mockResolvedValue(mockSkills),
      loadSkill: vi.fn(),
      loadSkillForRuntime: vi.fn(),
      addChangeListener: vi.fn((listener: () => void) => {
        changeListeners.push(listener);
        return () => {
          const index = changeListeners.indexOf(listener);
          if (index >= 0) {
            changeListeners.splice(index, 1);
          }
        };
      }),
      getParseErrors: vi.fn().mockReturnValue(new Map()),
    } as unknown as SkillManager;

    MockedSkillManager.mockImplementation(() => mockSkillManager);

    // Make config return the mock SkillManager
    vi.mocked(config.getSkillManager).mockReturnValue(mockSkillManager);

    // Create SkillTool instance
    skillTool = new SkillTool(config);

    // Allow async initialization to complete
    await vi.runAllTimersAsync();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('initialization', () => {
    it('should initialize with correct name and properties', () => {
      expect(skillTool.name).toBe('skill');
      expect(skillTool.displayName).toBe('Skill');
      expect(skillTool.kind).toBe('read');
    });

    it('should load available skills during initialization', () => {
      expect(mockSkillManager.listSkills).toHaveBeenCalled();
    });

    it('should subscribe to skill manager changes', () => {
      expect(mockSkillManager.addChangeListener).toHaveBeenCalledTimes(1);
    });

    it('should update description with available skills', () => {
      expect(skillTool.description).toContain('code-review');
      expect(skillTool.description).toContain(
        'Specialized skill for reviewing code quality',
      );
      expect(skillTool.description).toContain('testing');
      expect(skillTool.description).toContain(
        'Skill for writing and running tests',
      );
    });

    it('should handle empty skills list gracefully', async () => {
      vi.mocked(mockSkillManager.listSkills).mockResolvedValue([]);

      const emptySkillTool = new SkillTool(config);
      await vi.runAllTimersAsync();

      expect(emptySkillTool.description).toContain(
        'No skills are currently configured',
      );
    });

    it('should handle skill loading errors gracefully', async () => {
      vi.mocked(mockSkillManager.listSkills).mockRejectedValue(
        new Error('Loading failed'),
      );

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      new SkillTool(config);
      await vi.runAllTimersAsync();

      expect(consoleSpy).toHaveBeenCalledWith(
        'Failed to load skills for Skills tool:',
        expect.any(Error),
      );
      consoleSpy.mockRestore();
    });
  });

  describe('schema generation', () => {
    it('should expose static schema without dynamic enums', () => {
      const schema = skillTool.schema;
      const properties = schema.parametersJsonSchema as {
        properties: {
          skill: {
            type: string;
            description: string;
            enum?: string[];
          };
        };
      };
      expect(properties.properties.skill.type).toBe('string');
      expect(properties.properties.skill.description).toBe(
        'The skill name (no arguments). E.g., "pdf" or "xlsx"',
      );
      expect(properties.properties.skill.enum).toBeUndefined();
    });

    it('should keep schema static even when no skills available', async () => {
      vi.mocked(mockSkillManager.listSkills).mockResolvedValue([]);

      const emptySkillTool = new SkillTool(config);
      await vi.runAllTimersAsync();

      const schema = emptySkillTool.schema;
      const properties = schema.parametersJsonSchema as {
        properties: {
          skill: {
            type: string;
            description: string;
            enum?: string[];
          };
        };
      };
      expect(properties.properties.skill.type).toBe('string');
      expect(properties.properties.skill.description).toBe(
        'The skill name (no arguments). E.g., "pdf" or "xlsx"',
      );
      expect(properties.properties.skill.enum).toBeUndefined();
    });
  });

  describe('validateToolParams', () => {
    it('should validate valid parameters', () => {
      const result = skillTool.validateToolParams({ skill: 'code-review' });
      expect(result).toBeNull();
    });

    it('should reject empty skill', () => {
      const result = skillTool.validateToolParams({ skill: '' });
      expect(result).toBe('Parameter "skill" must be a non-empty string.');
    });

    it('should reject non-existent skill', () => {
      const result = skillTool.validateToolParams({
        skill: 'non-existent',
      });
      expect(result).toBe(
        'Skill "non-existent" not found. Available skills: code-review, testing',
      );
    });

    it('should show appropriate message when no skills available', async () => {
      vi.mocked(mockSkillManager.listSkills).mockResolvedValue([]);

      const emptySkillTool = new SkillTool(config);
      await vi.runAllTimersAsync();

      const result = emptySkillTool.validateToolParams({
        skill: 'non-existent',
      });
      expect(result).toBe(
        'Skill "non-existent" not found. No skills are currently available.',
      );
    });
  });

  describe('refreshSkills', () => {
    it('should refresh when change listener fires', async () => {
      const newSkills: SkillConfig[] = [
        {
          name: 'new-skill',
          description: 'A brand new skill',
          level: 'project',
          filePath: '/project/.qwen/skills/new-skill/SKILL.md',
          body: 'New skill content.',
        },
      ];

      vi.mocked(mockSkillManager.listSkills).mockResolvedValueOnce(newSkills);

      const listener = changeListeners[0];
      expect(listener).toBeDefined();

      listener?.();
      await vi.runAllTimersAsync();

      expect(skillTool.description).toContain('new-skill');
      expect(skillTool.description).toContain('A brand new skill');
    });

    it('should refresh available skills and update description', async () => {
      const newSkills: SkillConfig[] = [
        {
          name: 'test-skill',
          description: 'A test skill',
          level: 'project',
          filePath: '/project/.qwen/skills/test-skill/SKILL.md',
          body: 'Test content.',
        },
      ];

      vi.mocked(mockSkillManager.listSkills).mockResolvedValue(newSkills);

      await skillTool.refreshSkills();

      expect(skillTool.description).toContain('test-skill');
      expect(skillTool.description).toContain('A test skill');
    });
  });

  describe('SkillToolInvocation', () => {
    const mockRuntimeConfig: SkillConfig = {
      ...mockSkills[0],
    };

    beforeEach(() => {
      vi.mocked(mockSkillManager.loadSkillForRuntime).mockResolvedValue(
        mockRuntimeConfig,
      );
    });

    it('should execute skill load successfully', async () => {
      const params: SkillParams = {
        skill: 'code-review',
      };

      const invocation = (
        skillTool as SkillToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      expect(mockSkillManager.loadSkillForRuntime).toHaveBeenCalledWith(
        'code-review',
      );

      const llmText = partToString(result.llmContent);
      expect(llmText).toContain(
        'Base directory for this skill: /project/.qwen/skills/code-review',
      );
      expect(llmText.trim()).toContain(
        'Review code for quality and best practices.',
      );

      expect(result.returnDisplay).toBe('Launching skill: code-review');
    });

    it('should include allowedTools in result when present', async () => {
      const skillWithTools: SkillConfig = {
        ...mockSkills[1],
      };
      vi.mocked(mockSkillManager.loadSkillForRuntime).mockResolvedValue(
        skillWithTools,
      );

      const params: SkillParams = {
        skill: 'testing',
      };

      const invocation = (
        skillTool as SkillToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      const llmText = partToString(result.llmContent);
      expect(llmText).toContain('testing');
      // Base description is omitted from llmContent; ensure body is present.
      expect(llmText).toContain('Help write comprehensive tests.');

      expect(result.returnDisplay).toBe('Launching skill: testing');
    });

    it('should handle skill not found error', async () => {
      vi.mocked(mockSkillManager.loadSkillForRuntime).mockResolvedValue(null);

      const params: SkillParams = {
        skill: 'non-existent',
      };

      const invocation = (
        skillTool as SkillToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      const llmText = partToString(result.llmContent);
      expect(llmText).toContain('Skill "non-existent" not found');
    });

    it('should handle execution errors gracefully', async () => {
      vi.mocked(mockSkillManager.loadSkillForRuntime).mockRejectedValue(
        new Error('Loading failed'),
      );

      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      const params: SkillParams = {
        skill: 'code-review',
      };

      const invocation = (
        skillTool as SkillToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      const llmText = partToString(result.llmContent);
      expect(llmText).toContain('Failed to load skill');
      expect(llmText).toContain('Loading failed');

      consoleSpy.mockRestore();
    });

    it('should not require confirmation', async () => {
      const params: SkillParams = {
        skill: 'code-review',
      };

      const invocation = (
        skillTool as SkillToolWithProtectedMethods
      ).createInvocation(params);
      const shouldConfirm = await invocation.shouldConfirmExecute();

      expect(shouldConfirm).toBe(false);
    });

    it('should provide correct description', () => {
      const params: SkillParams = {
        skill: 'code-review',
      };

      const invocation = (
        skillTool as SkillToolWithProtectedMethods
      ).createInvocation(params);
      const description = invocation.getDescription();

      expect(description).toBe('Launching skill: "code-review"');
    });

    it('should handle skill without additional files', async () => {
      vi.mocked(mockSkillManager.loadSkillForRuntime).mockResolvedValue(
        mockSkills[0],
      );

      const params: SkillParams = {
        skill: 'code-review',
      };

      const invocation = (
        skillTool as SkillToolWithProtectedMethods
      ).createInvocation(params);
      const result = await invocation.execute();

      const llmText = partToString(result.llmContent);
      expect(llmText).not.toContain('## Additional Files');

      expect(result.returnDisplay).toBe('Launching skill: code-review');
    });
  });
});
