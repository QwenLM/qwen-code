/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { SubagentManager } from './subagent-manager.js';
import { type SubagentConfig, SubagentError } from './types.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import type { Config } from '../config/config.js';
import { makeFakeConfig } from '../test-utils/config.js';
import { AuthType, Protocol } from '../core/contentGenerator.js';

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

vi.mock('./subagent.js');

// Mock AgentHeadless for createAgentHeadless tests
const mockAgentHeadlessCreate = vi.hoisted(() => vi.fn());
vi.mock('../agents/runtime/agent-headless.js', () => ({
  AgentHeadless: { create: mockAgentHeadlessCreate },
  ContextState: class {},
}));

// Mirrors the positional AgentHeadless.create parameters so tests can
// destructure by name instead of indexing — adding new parameters can't
// silently shift assertions onto the wrong slot.
function destructureAgentHeadlessCall(call: unknown[]) {
  return {
    name: call[0] as string,
    runtimeContext: call[1],
    promptConfig: call[2],
    modelConfig: call[3],
    runConfig: call[4],
    toolConfig: call[5],
    eventEmitter: call[6],
    hooks: call[7],
    runtimeView: call[8] as
      | {
          contentGenerator: unknown;
          contentGeneratorConfig: { authType?: string; model?: string };
        }
      | undefined,
  };
}

// Mock createContentGenerator for model override tests
const mockCreateContentGenerator = vi.hoisted(() => vi.fn());
vi.mock('../core/contentGenerator.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../core/contentGenerator.js')>();
  return {
    ...original,
    createContentGenerator: mockCreateContentGenerator,
  };
});

describe('SubagentManager', () => {
  let manager: SubagentManager;
  let mockToolRegistry: ToolRegistry;
  let mockConfig: Config;

  beforeEach(() => {
    // Mock os.homedir before makeFakeConfig, since Config constructor
    // calls Storage.getGlobalQwenDir() which needs os.homedir()
    vi.mocked(os.homedir).mockReturnValue('/home/user');
    vi.mocked(os.tmpdir).mockReturnValue('/tmp');

    mockToolRegistry = {
      warmAll: vi.fn().mockResolvedValue(undefined),
      getAllTools: vi.fn().mockReturnValue([
        { name: 'read_file', displayName: 'Read File' },
        { name: 'write_file', displayName: 'Write File' },
        { name: 'grep', displayName: 'Search Files' },
      ]),
      // `buildSubagentContextOverride` now rebuilds the tool registry on
      // its override and copies discovered tools from this parent
      // registry. The real implementation iterates `source.tools.values()`,
      // so the stub needs a `tools` Map to avoid a TypeError.
      tools: new Map(),
    } as unknown as ToolRegistry;

    // Create mock Config object using test utility
    mockConfig = makeFakeConfig({});

    // Mock the tool registry and project root methods
    vi.spyOn(mockConfig, 'getToolRegistry').mockReturnValue(mockToolRegistry);
    vi.spyOn(mockConfig, 'getProjectRoot').mockReturnValue('/test/project');

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
      // Check disallowedTools before tools to avoid substring match
      if (yamlString.includes('disallowedTools:')) {
        const dtLine = yamlString
          .split('\n')
          .find((l: string) => l.startsWith('disallowedTools:'));
        const dtInline = dtLine?.replace('disallowedTools:', '').trim();
        if (dtInline && dtInline !== '') {
          return {
            name: 'test-agent',
            description: 'A test subagent',
            disallowedTools: dtInline,
          };
        }
        return {
          name: 'test-agent',
          description: 'A test subagent',
          disallowedTools: ['write_file', 'mcp__slack'],
        };
      }
      if (yamlString.includes('tools:')) {
        const toolsLine = yamlString
          .split('\n')
          .find((l: string) => l.startsWith('tools:'));
        const inlineValue = toolsLine?.replace('tools:', '').trim();
        if (
          inlineValue &&
          !inlineValue.startsWith('\n') &&
          inlineValue !== ''
        ) {
          return {
            name: 'test-agent',
            description: 'A test subagent',
            tools: inlineValue,
          };
        }
        return {
          name: 'test-agent',
          description: 'A test subagent',
          tools: ['read_file', 'write_file'],
        };
      }
      if (yamlString.includes('model:')) {
        return {
          name: 'test-agent',
          description: 'A test subagent',
          model: 'custom-model',
        };
      }
      if (yamlString.includes('runConfig:')) {
        return {
          name: 'test-agent',
          description: 'A test subagent',
          runConfig: { max_time_minutes: 5, max_turns: 10 },
        };
      }
      if (
        yamlString.includes('background:') ||
        yamlString.includes('approvalMode:')
      ) {
        const bgMatch = yamlString.match(/background:\s*"?(true|false)"?/);
        const approvalMatch = yamlString.match(/approvalMode:\s*"?([\w-]+)"?/);
        const result: Record<string, unknown> = {
          name: yamlString.match(/name:\s*(\S+)/)?.[1] ?? 'test-agent',
          description:
            yamlString.match(/description:\s*(.+)/)?.[1] ?? 'A test subagent',
        };
        if (bgMatch) result['background'] = bgMatch[1] === 'true';
        if (approvalMatch) result['approvalMode'] = approvalMatch[1];
        return result;
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
      if (yamlString.includes('name: 11')) {
        return { name: 11, description: 333 }; // Numeric values test case
      }
      if (yamlString.includes('name: true')) {
        return { name: true, description: false }; // Boolean values test case
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
        if (key === 'disallowedTools' && Array.isArray(value)) {
          yaml += `disallowedTools:\n${value.map((t) => `  - ${t}`).join('\n')}\n`;
        } else if (key === 'tools' && Array.isArray(value)) {
          yaml += `tools:\n${value.map((tool) => `  - ${tool}`).join('\n')}\n`;
        } else if (key === 'model') {
          yaml += `model: ${value}\n`;
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

    manager = new SubagentManager(mockConfig);
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
        validConfig.filePath!,
        'project',
      );

      expect(config.name).toBe('test-agent');
      expect(config.description).toBe('A test subagent');
      expect(config.systemPrompt).toBe('You are a helpful assistant.');
      expect(config.level).toBe('project');
      expect(config.filePath).toBe(validConfig.filePath);
    });

    it('should parse valid markdown content with CRLF line endings', () => {
      const markdownWithCRLF = `---\r\nname: test-agent\r\ndescription: A test subagent\r\n---\r\n\r\nYou are a helpful assistant.\r\n`;
      const config = manager.parseSubagentContent(
        markdownWithCRLF,
        validConfig.filePath!,
        'project',
      );

      expect(config.name).toBe('test-agent');
      expect(config.description).toBe('A test subagent');
      // The system prompt logic applies .trim(), so the trailing \r is removed regardless,
      // but the central test is that frontmatterRegex didn't throw an error.
      expect(config.systemPrompt).toBe('You are a helpful assistant.');
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
        validConfig.filePath!,
        'project',
      );

      expect(config.tools).toEqual(['read_file', 'write_file']);
    });

    it('should parse comma-separated tools string into array', () => {
      const markdownWithCSV = `---
name: test-agent
description: A test subagent
tools: Read, Bash, Grep, Glob, WebSearch, WebFetch, mcp__context7__*
---

You are a helpful assistant.
`;

      const config = manager.parseSubagentContent(
        markdownWithCSV,
        validConfig.filePath!,
        'project',
      );

      expect(config.tools).toEqual([
        'Read',
        'Bash',
        'Grep',
        'Glob',
        'WebSearch',
        'WebFetch',
        'mcp__context7__*',
      ]);
    });

    it('should parse single tool string into array', () => {
      const markdownWithSingle = `---
name: test-agent
description: A test subagent
tools: Read
---

You are a helpful assistant.
`;

      const config = manager.parseSubagentContent(
        markdownWithSingle,
        validConfig.filePath!,
        'project',
      );

      expect(config.tools).toEqual(['Read']);
    });

    it('should parse content with disallowedTools array', () => {
      const markdownWithDisallowed = `---
name: test-agent
description: A test subagent
disallowedTools:
  - write_file
  - mcp__slack
---

You are a helpful assistant.
`;

      const config = manager.parseSubagentContent(
        markdownWithDisallowed,
        validConfig.filePath!,
        'project',
      );

      expect(config.disallowedTools).toEqual(['write_file', 'mcp__slack']);
    });

    it('should normalize scalar disallowedTools to array', () => {
      const markdownWithScalar = `---
name: test-agent
description: A test subagent
disallowedTools: write_file
---

You are a helpful assistant.
`;

      const config = manager.parseSubagentContent(
        markdownWithScalar,
        validConfig.filePath!,
        'project',
      );

      expect(config.disallowedTools).toEqual(['write_file']);
    });

    it('should parse comma-separated disallowedTools string into array', () => {
      const markdownWithCSV = `---
name: test-agent
description: A test subagent
disallowedTools: write_file, mcp__slack, Bash
---

You are a helpful assistant.
`;

      const config = manager.parseSubagentContent(
        markdownWithCSV,
        validConfig.filePath!,
        'project',
      );

      expect(config.disallowedTools).toEqual([
        'write_file',
        'mcp__slack',
        'Bash',
      ]);
    });

    it('should parse content with model selector', () => {
      const markdownWithModel = `---
name: test-agent
description: A test subagent
model: custom-model
---

You are a helpful assistant.
`;

      const config = manager.parseSubagentContent(
        markdownWithModel,
        validConfig.filePath!,
        'project',
      );

      expect(config.model).toBe('custom-model');
    });

    it('should parse legacy modelConfig frontmatter for compatibility', () => {
      const markdownWithLegacyModel = `---
name: test-agent
description: A test subagent
modelConfig:
  model: legacy-model
---

You are a helpful assistant.
`;

      mockParseYaml.mockReturnValueOnce({
        name: 'test-agent',
        description: 'A test subagent',
        modelConfig: { model: 'legacy-model' },
      });

      const config = manager.parseSubagentContent(
        markdownWithLegacyModel,
        validConfig.filePath!,
        'project',
      );

      expect(config.model).toBe('legacy-model');
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
        validConfig.filePath!,
        'project',
      );

      expect(config.runConfig).toEqual({ max_time_minutes: 5, max_turns: 10 });
    });

    it('should handle numeric name and description values', () => {
      const markdownWithNumeric = `---
name: 11
description: 333
---

You are a helpful assistant.
`;

      const config = manager.parseSubagentContent(
        markdownWithNumeric,
        validConfig.filePath!,
        'project',
      );

      expect(config.name).toBe('11');
      expect(config.description).toBe('333');
      expect(typeof config.name).toBe('string');
      expect(typeof config.description).toBe('string');
    });

    it('should handle boolean name and description values', () => {
      const markdownWithBoolean = `---
name: true
description: false
---

You are a helpful assistant.
`;

      const config = manager.parseSubagentContent(
        markdownWithBoolean,
        validConfig.filePath!,
        'project',
      );

      expect(config.name).toBe('true');
      expect(config.description).toBe('false');
      expect(typeof config.name).toBe('string');
      expect(typeof config.description).toBe('string');
    });

    it('should determine level from file path', () => {
      const projectPath = '/test/project/.qwen/agents/test-agent.md';
      const userPath = '/home/user/.qwen/agents/test-agent.md';

      const projectConfig = manager.parseSubagentContent(
        validMarkdown,
        projectPath,
        'project',
      );
      const userConfig = manager.parseSubagentContent(
        validMarkdown,
        userPath,
        'user',
      );

      expect(projectConfig.level).toBe('project');
      expect(userConfig.level).toBe('user');
    });

    it('should throw error for invalid frontmatter format', () => {
      const invalidMarkdown = `No frontmatter here
Just content`;

      expect(() =>
        manager.parseSubagentContent(
          invalidMarkdown,
          validConfig.filePath!,
          'project',
        ),
      ).toThrow(SubagentError);
    });

    it('should throw error for missing name', () => {
      const markdownWithoutName = `---
description: A test subagent
---

You are a helpful assistant.
`;

      expect(() =>
        manager.parseSubagentContent(
          markdownWithoutName,
          validConfig.filePath!,
          'project',
        ),
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
          validConfig.filePath!,
          'project',
        ),
      ).toThrow(SubagentError);
    });

    it('should not warn when filename matches subagent name', () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const matchingPath = '/test/project/.qwen/agents/test-agent.md';

      const config = manager.parseSubagentContent(
        validMarkdown,
        matchingPath,
        'project',
      );

      expect(config.name).toBe('test-agent');
      expect(consoleSpy).not.toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('should parse background: true from frontmatter', () => {
      const markdownWithBackground = `---
name: monitor
description: A background monitor
background: true
---

You are a monitor.
`;

      const config = manager.parseSubagentContent(
        markdownWithBackground,
        validConfig.filePath!,
        'project',
      );

      expect(config.background).toBe(true);
    });

    it('should parse background: "true" string from frontmatter', () => {
      const markdownWithBgString = `---
name: monitor
description: A background monitor
background: "true"
---

You are a monitor.
`;

      const config = manager.parseSubagentContent(
        markdownWithBgString,
        validConfig.filePath!,
        'project',
      );

      expect(config.background).toBe(true);
    });

    it('should not set background when background: false', () => {
      const markdownWithBgFalse = `---
name: monitor
description: A foreground agent
background: false
---

You are an agent.
`;

      const config = manager.parseSubagentContent(
        markdownWithBgFalse,
        validConfig.filePath!,
        'project',
      );

      expect(config.background).toBeUndefined();
    });

    it('should not set background when omitted', () => {
      const config = manager.parseSubagentContent(
        validMarkdown,
        validConfig.filePath!,
        'project',
      );

      expect(config.background).toBeUndefined();
    });

    it('should parse approvalMode: bubble from frontmatter', () => {
      const md = `---
name: bubbler
description: A background agent that bubbles approvals
background: true
approvalMode: bubble
---

You are a bubbler.
`;
      const config = manager.parseSubagentContent(
        md,
        validConfig.filePath!,
        'project',
      );

      expect(config.approvalMode).toBe('bubble');
    });

    it('should reject an unknown approvalMode value', () => {
      const md = `---
name: weird
description: An agent with a bogus mode
approvalMode: telepathy
---

You are weird.
`;
      expect(() =>
        manager.parseSubagentContent(md, validConfig.filePath!, 'project'),
      ).toThrow(/Invalid "approvalMode"/);
    });

    it('should round-trip approvalMode: bubble through serialize', () => {
      const serialized = manager.serializeSubagent({
        ...validConfig,
        approvalMode: 'bubble',
      });
      expect(serialized).toContain('approvalMode: bubble');

      const reparsed = manager.parseSubagentContent(
        serialized,
        validConfig.filePath!,
        'project',
      );
      expect(reparsed.approvalMode).toBe('bubble');
    });

    // --- CC 2.1.168 declarative-agent fields (DL7-parity lenient parse) ---

    it('should parse valid permissionMode and bridge to approvalMode', () => {
      mockParseYaml.mockReturnValueOnce({
        name: 'a',
        description: 'd',
        permissionMode: 'bypassPermissions',
      });
      const config = manager.parseSubagentContent(
        '---\nname: a\ndescription: d\npermissionMode: bypassPermissions\n---\nx',
        validConfig.filePath!,
        'project',
      );
      expect(config.permissionMode).toBe('bypassPermissions');
      expect(config.approvalMode).toBe('yolo');
    });

    it('should prefer explicit approvalMode over permissionMode bridge', () => {
      mockParseYaml.mockReturnValueOnce({
        name: 'a',
        description: 'd',
        permissionMode: 'bypassPermissions',
        approvalMode: 'plan',
      });
      const config = manager.parseSubagentContent(
        '---\nname: a\ndescription: d\npermissionMode: bypassPermissions\napprovalMode: plan\n---\nx',
        validConfig.filePath!,
        'project',
      );
      expect(config.approvalMode).toBe('plan');
      expect(config.permissionMode).toBe('bypassPermissions');
    });

    it('should drop invalid permissionMode and not bridge', () => {
      mockParseYaml.mockReturnValueOnce({
        name: 'a',
        description: 'd',
        permissionMode: 'not-a-mode',
      });
      const config = manager.parseSubagentContent(
        '---\nname: a\ndescription: d\npermissionMode: not-a-mode\n---\nx',
        validConfig.filePath!,
        'project',
      );
      expect(config.permissionMode).toBeUndefined();
      expect(config.approvalMode).toBeUndefined();
    });

    it('should parse maxTurns as number', () => {
      mockParseYaml.mockReturnValueOnce({
        name: 'a',
        description: 'd',
        maxTurns: 42,
      });
      const config = manager.parseSubagentContent(
        '---\nname: a\ndescription: d\nmaxTurns: 42\n---\nx',
        validConfig.filePath!,
        'project',
      );
      expect(config.maxTurns).toBe(42);
    });

    it('should parse maxTurns from numeric string', () => {
      mockParseYaml.mockReturnValueOnce({
        name: 'a',
        description: 'd',
        maxTurns: '42',
      });
      const config = manager.parseSubagentContent(
        '---\nname: a\ndescription: d\nmaxTurns: "42"\n---\nx',
        validConfig.filePath!,
        'project',
      );
      expect(config.maxTurns).toBe(42);
    });

    it('should drop negative or zero maxTurns', () => {
      mockParseYaml.mockReturnValueOnce({
        name: 'a',
        description: 'd',
        maxTurns: -1,
      });
      const config = manager.parseSubagentContent(
        '---\nname: a\ndescription: d\nmaxTurns: -1\n---\nx',
        validConfig.filePath!,
        'project',
      );
      expect(config.maxTurns).toBeUndefined();
    });

    it('should parse nested mcpServers as a record', () => {
      const mcpServers = {
        filesystem: { type: 'stdio', command: 'node' },
        github: { type: 'http', url: 'https://example.com' },
      };
      mockParseYaml.mockReturnValueOnce({
        name: 'a',
        description: 'd',
        mcpServers,
      });
      const config = manager.parseSubagentContent(
        '---\nname: a\ndescription: d\nmcpServers:\n  filesystem:\n    type: stdio\n    command: node\n---\nx',
        validConfig.filePath!,
        'project',
      );
      expect(config.mcpServers).toEqual(mcpServers);
    });

    it('should drop mcpServers of the wrong top-level shape', () => {
      mockParseYaml.mockReturnValueOnce({
        name: 'a',
        description: 'd',
        mcpServers: 'just-a-string',
      });
      const config = manager.parseSubagentContent(
        '---\nname: a\ndescription: d\nmcpServers: just-a-string\n---\nx',
        validConfig.filePath!,
        'project',
      );
      expect(config.mcpServers).toBeUndefined();
    });

    it('should parse nested hooks as a record of arrays', () => {
      const hooks = {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo' }] },
        ],
      };
      mockParseYaml.mockReturnValueOnce({
        name: 'a',
        description: 'd',
        hooks,
      });
      const config = manager.parseSubagentContent(
        '---\nname: a\ndescription: d\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: echo\n---\nx',
        validConfig.filePath!,
        'project',
      );
      expect(config.hooks).toEqual(hooks);
    });

    it('should drop hooks with non-array values per event', () => {
      mockParseYaml.mockReturnValueOnce({
        name: 'a',
        description: 'd',
        hooks: { PreToolUse: 'not-an-array' },
      });
      const config = manager.parseSubagentContent(
        '---\nname: a\ndescription: d\nhooks:\n  PreToolUse: not-an-array\n---\nx',
        validConfig.filePath!,
        'project',
      );
      expect(config.hooks).toBeUndefined();
    });

    it('should preserve color from allowlist', () => {
      mockParseYaml.mockReturnValueOnce({
        name: 'a',
        description: 'd',
        color: 'cyan',
      });
      const config = manager.parseSubagentContent(
        '---\nname: a\ndescription: d\ncolor: cyan\n---\nx',
        validConfig.filePath!,
        'project',
      );
      expect(config.color).toBe('cyan');
    });

    it('should drop color not in allowlist (matches CC _Y silent drop)', () => {
      mockParseYaml.mockReturnValueOnce({
        name: 'a',
        description: 'd',
        color: 'magenta',
      });
      const config = manager.parseSubagentContent(
        '---\nname: a\ndescription: d\ncolor: magenta\n---\nx',
        validConfig.filePath!,
        'project',
      );
      expect(config.color).toBeUndefined();
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

    it('should serialize configuration with model selector', () => {
      const configWithModel: SubagentConfig = {
        ...validConfig,
        model: 'custom-model',
      };

      const serialized = manager.serializeSubagent(configWithModel);

      expect(serialized).toContain('model: custom-model');
    });

    it('should not include empty optional fields', () => {
      const serialized = manager.serializeSubagent(validConfig);

      expect(serialized).not.toContain('tools:');
      expect(serialized).not.toContain('model:');
      expect(serialized).not.toContain('runConfig:');
      expect(serialized).not.toContain('disallowedTools:');
    });

    it('should serialize configuration with disallowedTools', () => {
      const configWithDisallowed: SubagentConfig = {
        ...validConfig,
        disallowedTools: ['write_file', 'mcp__slack'],
      };

      const serialized = manager.serializeSubagent(configWithDisallowed);

      expect(serialized).toContain('disallowedTools:');
      expect(serialized).toContain('- write_file');
      expect(serialized).toContain('- mcp__slack');
    });

    it('should roundtrip disallowedTools through serialize and parse', () => {
      const configWithDisallowed: SubagentConfig = {
        ...validConfig,
        disallowedTools: ['write_file', 'mcp__slack'],
      };

      const serialized = manager.serializeSubagent(configWithDisallowed);

      expect(serialized).toContain('disallowedTools:');
      expect(serialized).toContain('- write_file');
      expect(serialized).toContain('- mcp__slack');

      const parsed = manager.parseSubagentContent(
        serialized,
        validConfig.filePath!,
        'project',
      );

      expect(parsed.disallowedTools).toEqual(['write_file', 'mcp__slack']);
    });

    it('should serialize background: true', () => {
      const configWithBackground: SubagentConfig = {
        ...validConfig,
        background: true,
      };

      const serialized = manager.serializeSubagent(configWithBackground);
      expect(serialized).toContain('background: true');
    });

    it('should not serialize background when undefined', () => {
      const serialized = manager.serializeSubagent(validConfig);
      expect(serialized).not.toContain('background');
    });

    it('should include mcpServers in the frontmatter object passed to stringifyYaml', () => {
      const mcpServers = {
        filesystem: { type: 'stdio', command: 'node' },
      };
      mockStringifyYaml.mockClear();
      manager.serializeSubagent({ ...validConfig, mcpServers });
      const frontmatterArg = mockStringifyYaml.mock.calls[0][0];
      expect(frontmatterArg.mcpServers).toEqual(mcpServers);
    });

    it('should include hooks in the frontmatter object passed to stringifyYaml', () => {
      const hooks = {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo' }] },
        ],
      };
      mockStringifyYaml.mockClear();
      manager.serializeSubagent({ ...validConfig, hooks });
      const frontmatterArg = mockStringifyYaml.mock.calls[0][0];
      expect(frontmatterArg.hooks).toEqual(hooks);
    });

    it('should omit mcpServers / hooks when the record is empty', () => {
      mockStringifyYaml.mockClear();
      manager.serializeSubagent({
        ...validConfig,
        mcpServers: {},
        hooks: {},
      });
      const frontmatterArg = mockStringifyYaml.mock.calls[0][0];
      expect(frontmatterArg.mcpServers).toBeUndefined();
      expect(frontmatterArg.hooks).toBeUndefined();
    });

    it('should roundtrip background through serialize and parse', () => {
      const configWithBackground: SubagentConfig = {
        ...validConfig,
        background: true,
      };

      const serialized = manager.serializeSubagent(configWithBackground);
      const parsed = manager.parseSubagentContent(
        serialized,
        validConfig.filePath!,
        'project',
      );

      expect(parsed.background).toBe(true);
    });

    // --- CC 2.1.168 declarative-agent fields serialization ---

    it('should serialize permissionMode when set', () => {
      const serialized = manager.serializeSubagent({
        ...validConfig,
        permissionMode: 'bypassPermissions',
      });
      expect(serialized).toContain('permissionMode: bypassPermissions');
    });

    it('should serialize maxTurns when set', () => {
      const serialized = manager.serializeSubagent({
        ...validConfig,
        maxTurns: 25,
      });
      expect(serialized).toContain('maxTurns: 25');
    });

    it('should NOT emit permissionMode when approvalMode is also being emitted (avoid round-trip drift)', () => {
      // Regression for PR #4842 round-2 review: if both fields land on the
      // serialised frontmatter, the next parse takes approvalMode (explicit
      // wins over bridge) and silently ignores any user edits to
      // permissionMode in the file.
      const serialized = manager.serializeSubagent({
        ...validConfig,
        permissionMode: 'bypassPermissions',
        approvalMode: 'yolo',
      });
      expect(serialized).toContain('approvalMode: yolo');
      expect(serialized).not.toContain('permissionMode:');
    });

    it('should still emit permissionMode when approvalMode is unset (faithful round-trip of the user intent)', () => {
      const serialized = manager.serializeSubagent({
        ...validConfig,
        permissionMode: 'plan',
      });
      expect(serialized).toContain('permissionMode: plan');
      expect(serialized).not.toContain('approvalMode:');
    });

    it('should not include new fields when undefined', () => {
      const serialized = manager.serializeSubagent(validConfig);
      expect(serialized).not.toContain('permissionMode:');
      expect(serialized).not.toContain('maxTurns:');
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
        path.normalize(path.dirname(validConfig.filePath!)),
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.readdir).mockResolvedValue(['test-agent.md'] as any);
      vi.mocked(fs.readFile).mockResolvedValue(validMarkdown);

      const config = await manager.loadSubagent('test-agent');

      expect(config).toBeDefined();
      expect(config!.name).toBe('test-agent');
      expect(fs.readdir).toHaveBeenCalledWith(
        path.normalize('/test/project/.qwen/agents'),
      );
      expect(fs.readFile).toHaveBeenCalledWith(
        path.normalize('/test/project/.qwen/agents/test-agent.md'),
        'utf8',
      );
    });

    it('should fall back to user level if project level fails', async () => {
      vi.mocked(fs.readdir)
        .mockRejectedValueOnce(new Error('Project dir not found')) // project level fails
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValueOnce(['test-agent.md'] as any); // user level succeeds
      vi.mocked(fs.readFile).mockResolvedValue(validMarkdown);

      const config = await manager.loadSubagent('test-agent');

      expect(config).toBeDefined();
      expect(config!.name).toBe('test-agent');
      expect(fs.readdir).toHaveBeenCalledWith(
        path.normalize('/home/user/.qwen/agents'),
      );
      expect(fs.readFile).toHaveBeenCalledWith(
        path.normalize('/home/user/.qwen/agents/test-agent.md'),
        'utf8',
      );
    });

    it('should return null if not found at either level', async () => {
      vi.mocked(fs.readdir).mockRejectedValue(new Error('Directory not found'));

      const config = await manager.loadSubagent('nonexistent');

      expect(config).toBeNull();
    });

    it('should load subagent even when filename does not match name', async () => {
      // Mock readdir to return files with different names
      vi.mocked(fs.readdir).mockResolvedValue([
        'wrong-filename.md',
        'another-file.md',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any);

      // Mock readFile to return content with different name
      const mismatchedMarkdown = `---
name: correct-agent-name
description: A test subagent with mismatched filename
---

You are a helpful assistant.`;

      const anotherFileMarkdown = `---
name: other-agent
description: Some other agent
---

You are another assistant.`;

      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(mismatchedMarkdown) // first file (wrong-filename.md) - matches!
        .mockResolvedValueOnce(anotherFileMarkdown); // second file (another-file.md) - doesn't match

      // Mock parseYaml for different scenarios
      mockParseYaml
        .mockReturnValueOnce({
          name: 'correct-agent-name',
          description: 'A test subagent with mismatched filename',
        })
        .mockReturnValueOnce({
          name: 'other-agent',
          description: 'Some other agent',
        });

      const config = await manager.loadSubagent('correct-agent-name');

      expect(config).toBeDefined();
      expect(config!.name).toBe('correct-agent-name');
      expect(config!.filePath).toBe(
        path.normalize('/test/project/.qwen/agents/wrong-filename.md'),
      );

      // Verify it scanned the directory instead of using direct path
      expect(fs.readdir).toHaveBeenCalledWith(
        path.normalize('/test/project/.qwen/agents'),
      );
    });

    it('should search user level when filename mismatch at project level', async () => {
      // Mock project level to have no matching files
      vi.mocked(fs.readdir)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValueOnce(['other-file.md'] as any) // project level
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValueOnce(['user-agent.md'] as any); // user level

      const projectMarkdown = `---
name: wrong-agent
description: Wrong agent
---

You are a wrong assistant.`;

      const userMarkdown = `---
name: target-agent
description: A test subagent at user level
---

You are a helpful assistant.`;

      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(projectMarkdown) // project level file (other-file.md)
        .mockResolvedValueOnce(userMarkdown); // user level file (user-agent.md)

      // Mock parseYaml for different scenarios
      mockParseYaml
        .mockReturnValueOnce({
          name: 'wrong-agent',
          description: 'Wrong agent',
        })
        .mockReturnValueOnce({
          name: 'target-agent',
          description: 'A test subagent at user level',
        });

      const config = await manager.loadSubagent('target-agent');

      expect(config).toBeDefined();
      expect(config!.name).toBe('target-agent');
      expect(config!.filePath).toBe(
        path.normalize('/home/user/.qwen/agents/user-agent.md'),
      );
      expect(config!.level).toBe('user');
    });

    it('should handle specific level search with filename mismatch', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.readdir).mockResolvedValue(['misnamed-file.md'] as any);

      const levelMarkdown = `---
name: specific-agent
description: A test subagent for specific level
---

You are a helpful assistant.`;

      vi.mocked(fs.readFile).mockResolvedValue(levelMarkdown);

      mockParseYaml.mockReturnValue({
        name: 'specific-agent',
        description: 'A test subagent for specific level',
      });

      const config = await manager.loadSubagent('specific-agent', 'project');

      expect(config).toBeDefined();
      expect(config!.name).toBe('specific-agent');
      expect(config!.filePath).toBe(
        path.normalize('/test/project/.qwen/agents/misnamed-file.md'),
      );
    });
  });

  describe('updateSubagent', () => {
    beforeEach(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.readdir).mockResolvedValue(['test-agent.md'] as any);
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
      vi.mocked(fs.readdir).mockRejectedValue(new Error('Directory not found'));

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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.readdir).mockResolvedValue(['test-agent.md'] as any);
      vi.mocked(fs.readFile).mockResolvedValue(validMarkdown);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      await manager.deleteSubagent('test-agent', 'project');

      expect(fs.unlink).toHaveBeenCalledWith(
        path.normalize('/test/project/.qwen/agents/test-agent.md'),
      );
    });

    it('should delete from both levels if no level specified', async () => {
      vi.mocked(fs.readdir)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValueOnce(['test-agent.md'] as any) // project level
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValueOnce(['test-agent.md'] as any); // user level
      vi.mocked(fs.readFile).mockResolvedValue(validMarkdown);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      await manager.deleteSubagent('test-agent');

      expect(fs.unlink).toHaveBeenCalledTimes(2);
      expect(fs.unlink).toHaveBeenCalledWith(
        path.normalize('/test/project/.qwen/agents/test-agent.md'),
      );
      expect(fs.unlink).toHaveBeenCalledWith(
        path.normalize('/home/user/.qwen/agents/test-agent.md'),
      );
    });

    it('should throw error if subagent not found', async () => {
      vi.mocked(fs.readdir).mockRejectedValue(new Error('Directory not found'));

      await expect(manager.deleteSubagent('nonexistent')).rejects.toThrow(
        SubagentError,
      );

      await expect(manager.deleteSubagent('nonexistent')).rejects.toThrow(
        /not found/,
      );
    });

    it('should succeed if deleted from at least one level', async () => {
      vi.mocked(fs.readdir)
        .mockRejectedValueOnce(new Error('Project dir not found')) // project level fails
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValueOnce(['test-agent.md'] as any); // user level succeeds
      vi.mocked(fs.readFile).mockResolvedValue(validMarkdown);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      await expect(manager.deleteSubagent('test-agent')).resolves.not.toThrow();
    });

    it('should delete subagent with mismatched filename', async () => {
      // Mock directory listing to return files with different names
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.readdir).mockResolvedValue(['wrong-name.md'] as any);

      const mismatchedMarkdown = `---
name: correct-name
description: A test subagent with mismatched filename
---

You are a helpful assistant.`;

      vi.mocked(fs.readFile).mockResolvedValue(mismatchedMarkdown);
      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      mockParseYaml.mockReturnValue({
        name: 'correct-name',
        description: 'A test subagent with mismatched filename',
      });

      await manager.deleteSubagent('correct-name', 'project');

      // Should delete the actual file, not the expected filename
      expect(fs.unlink).toHaveBeenCalledWith(
        path.normalize('/test/project/.qwen/agents/wrong-name.md'),
      );
    });

    it('should handle deletion when multiple files exist but only one matches', async () => {
      // Mock directory listing with multiple files
      vi.mocked(fs.readdir).mockResolvedValue([
        'file1.md',
        'file2.md',
        'target-file.md',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any);

      const markdowns = [
        `---
name: other-agent-1
description: First other agent
---
Content 1`,
        `---
name: other-agent-2
description: Second other agent
---
Content 2`,
        `---
name: target-agent
description: The target agent
---
Target content`,
      ];

      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(markdowns[0])
        .mockResolvedValueOnce(markdowns[1])
        .mockResolvedValueOnce(markdowns[2]);

      vi.mocked(fs.unlink).mockResolvedValue(undefined);

      mockParseYaml
        .mockReturnValueOnce({
          name: 'other-agent-1',
          description: 'First other agent',
        })
        .mockReturnValueOnce({
          name: 'other-agent-2',
          description: 'Second other agent',
        })
        .mockReturnValueOnce({
          name: 'target-agent',
          description: 'The target agent',
        });

      await manager.deleteSubagent('target-agent', 'project');

      // Should only delete the matching file
      expect(fs.unlink).toHaveBeenCalledTimes(1);
      expect(fs.unlink).toHaveBeenCalledWith(
        path.normalize('/test/project/.qwen/agents/target-file.md'),
      );
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

      expect(subagents).toHaveLength(6); // agent1 (project takes precedence), agent2, agent3, general-purpose, Explore, statusline-setup (built-in)
      expect(subagents.map((s) => s.name)).toEqual([
        'agent1',
        'agent2',
        'agent3',
        'general-purpose',
        'Explore',
        'statusline-setup',
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
      expect(names).toEqual([
        'agent1',
        'agent2',
        'agent3',
        'Explore',
        'general-purpose',
        'statusline-setup',
      ]);
    });

    it('should handle empty directories', async () => {
      // Reset all mocks for this specific test
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.readdir).mockResolvedValue([] as any);
      vi.mocked(fs.readFile).mockRejectedValue(new Error('No files'));

      const subagents = await manager.listSubagents();

      expect(subagents).toHaveLength(3); // Only built-in agents remain
      expect(subagents.map((s) => s.name)).toEqual([
        'general-purpose',
        'Explore',
        'statusline-setup',
      ]);
      expect(subagents.every((s) => s.level === 'builtin')).toBe(true);
    });

    it('should handle directory read errors', async () => {
      // Reset all mocks for this specific test
      vi.mocked(fs.readdir).mockRejectedValue(new Error('Directory not found'));
      vi.mocked(fs.readFile).mockRejectedValue(new Error('No files'));

      const subagents = await manager.listSubagents();

      expect(subagents).toHaveLength(3); // Only built-in agents remain
      expect(subagents.map((s) => s.name)).toEqual([
        'general-purpose',
        'Explore',
        'statusline-setup',
      ]);
      expect(subagents.every((s) => s.level === 'builtin')).toBe(true);
    });
  });

  describe('findSubagentByName', () => {
    it('should find existing subagent', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.readdir).mockResolvedValue(['test-agent.md'] as any);
      vi.mocked(fs.readFile).mockResolvedValue(validMarkdown);

      const metadata = await manager.findSubagentByName('test-agent');

      expect(metadata).toBeDefined();
      expect(metadata!.name).toBe('test-agent');
      expect(metadata!.description).toBe('A test subagent');
    });

    it('should return null for non-existent subagent', async () => {
      vi.mocked(fs.readdir).mockRejectedValue(new Error('Directory not found'));

      const metadata = await manager.findSubagentByName('nonexistent');

      expect(metadata).toBeNull();
    });
  });

  describe('isNameAvailable', () => {
    it('should return true for available names', async () => {
      vi.mocked(fs.readdir).mockRejectedValue(new Error('Directory not found'));

      const available = await manager.isNameAvailable('new-agent');

      expect(available).toBe(true);
    });

    it('should return false for existing names', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.readdir).mockResolvedValue(['test-agent.md'] as any);
      vi.mocked(fs.readFile).mockResolvedValue(validMarkdown);

      const available = await manager.isNameAvailable('test-agent');

      expect(available).toBe(false);
    });

    it('should check specific level when provided', async () => {
      // The isNameAvailable method loads from both levels and checks if found subagent is at different level
      // First call: loads subagent (found at user level), checks if it's at project level (different) -> available
      vi.mocked(fs.readdir)
        .mockRejectedValueOnce(new Error('Project dir not found')) // project level
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .mockResolvedValueOnce(['test-agent.md'] as any); // user level - found here
      vi.mocked(fs.readFile).mockResolvedValue(validMarkdown);

      const availableAtProject = await manager.isNameAvailable(
        'test-agent',
        'project',
      );
      expect(availableAtProject).toBe(true); // Available at project because found at user level

      // Second call: loads subagent (found at user level), checks if it's at user level (same) -> not available
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(fs.readdir).mockResolvedValue(['test-agent.md'] as any); // user level - found here
      vi.mocked(fs.readFile).mockResolvedValue(validMarkdown);

      const availableAtUser = await manager.isNameAvailable(
        'test-agent',
        'user',
      );
      expect(availableAtUser).toBe(false); // Not available at user because found at user level
    });
  });

  describe('Runtime Configuration Methods', () => {
    describe('convertToRuntimeConfig', () => {
      it('should convert basic configuration', async () => {
        const runtimeConfig = await manager.convertToRuntimeConfig(validConfig);

        expect(runtimeConfig.promptConfig.systemPrompt).toBe(
          validConfig.systemPrompt,
        );
        expect(runtimeConfig.modelConfig).toEqual({});
        expect(runtimeConfig.runConfig).toEqual({});
        expect(runtimeConfig.toolConfig).toBeUndefined();
      });

      it('should include tool configuration when tools are specified', async () => {
        const configWithTools: SubagentConfig = {
          ...validConfig,
          tools: ['read_file', 'write_file'],
        };

        const runtimeConfig =
          await manager.convertToRuntimeConfig(configWithTools);

        expect(runtimeConfig.toolConfig).toBeDefined();
        expect(runtimeConfig.toolConfig!.tools).toEqual([
          'read_file',
          'write_file',
        ]);
      });

      it('should transform display names to tool names in tool configuration', async () => {
        const configWithDisplayNames: SubagentConfig = {
          ...validConfig,
          tools: ['Read File', 'write_file', 'Search Files', 'unknown_tool'],
        };

        const runtimeConfig = await manager.convertToRuntimeConfig(
          configWithDisplayNames,
        );

        expect(runtimeConfig.toolConfig).toBeDefined();
        expect(runtimeConfig.toolConfig!.tools).toEqual([
          'read_file', // 'Read File' -> 'read_file' (display name match)
          'write_file', // 'write_file' -> 'write_file' (exact name match)
          'grep', // 'Search Files' -> 'grep' (display name match)
          'unknown_tool', // 'unknown_tool' -> 'unknown_tool' (preserved as-is)
        ]);
      });

      it('should set modelConfig.model from model selector and merge run configurations', async () => {
        const configWithCustom: SubagentConfig = {
          ...validConfig,
          model: 'custom-model',
          runConfig: { max_time_minutes: 5 },
        };

        const runtimeConfig =
          await manager.convertToRuntimeConfig(configWithCustom);

        expect(runtimeConfig.modelConfig.model).toBe('custom-model');
        expect(runtimeConfig.runConfig.max_time_minutes).toBe(5);
      });

      it('should accept cross-provider model selectors', async () => {
        const configWithCrossProvider: SubagentConfig = {
          ...validConfig,
          model: 'openai:gpt-4',
        };

        const runtimeConfig = await manager.convertToRuntimeConfig(
          configWithCrossProvider,
        );
        expect(runtimeConfig.modelConfig.model).toBe('gpt-4');
      });

      it('should resolve "fast" to the configured current-auth fast model', async () => {
        const fastConfig: SubagentConfig = { ...validConfig, model: 'fast' };
        vi.spyOn(mockConfig, 'getFastModel').mockReturnValue('fast-model-id');

        const runtimeConfig = await manager.convertToRuntimeConfig(
          fastConfig,
          mockConfig,
        );

        expect(runtimeConfig.modelConfig.model).toBe('fast-model-id');
      });

      it('should resolve "fast" to authType-qualified fast model selectors', async () => {
        const fastConfig: SubagentConfig = { ...validConfig, model: 'fast' };
        vi.spyOn(mockConfig, 'getFastModel').mockReturnValue(
          'openai:fast-model-id',
        );

        const runtimeConfig = await manager.convertToRuntimeConfig(
          fastConfig,
          mockConfig,
        );

        expect(runtimeConfig.modelConfig.model).toBe('fast-model-id');
      });

      it('should leave modelConfig empty for "fast" when getFastModel returns undefined', async () => {
        // Mirrors the unset / invalid-for-authType cases — AgentCore then
        // falls back to runtimeContext.getModel() (the parent model).
        const fastConfig: SubagentConfig = { ...validConfig, model: 'fast' };
        vi.spyOn(mockConfig, 'getFastModel').mockReturnValue(undefined);

        const runtimeConfig = await manager.convertToRuntimeConfig(
          fastConfig,
          mockConfig,
        );

        expect(runtimeConfig.modelConfig).toEqual({});
      });

      it('should leave modelConfig empty for "fast" when no runtimeContext is provided', async () => {
        const fastConfig: SubagentConfig = { ...validConfig, model: 'fast' };

        const runtimeConfig = await manager.convertToRuntimeConfig(fastConfig);

        expect(runtimeConfig.modelConfig).toEqual({});
      });

      // --- CC 2.1.168 maxTurns top-level promotion ---

      it('should populate runConfig.max_turns from top-level maxTurns', async () => {
        const cfg: SubagentConfig = { ...validConfig, maxTurns: 42 };
        const runtimeConfig = await manager.convertToRuntimeConfig(cfg);
        expect(runtimeConfig.runConfig.max_turns).toBe(42);
      });

      it('should prefer top-level maxTurns over nested runConfig.max_turns', async () => {
        const cfg: SubagentConfig = {
          ...validConfig,
          maxTurns: 99,
          runConfig: { max_turns: 5 },
        };
        const runtimeConfig = await manager.convertToRuntimeConfig(cfg);
        expect(runtimeConfig.runConfig.max_turns).toBe(99);
      });

      it('should fall back to nested runConfig.max_turns when maxTurns is unset', async () => {
        const cfg: SubagentConfig = {
          ...validConfig,
          runConfig: { max_turns: 7 },
        };
        const runtimeConfig = await manager.convertToRuntimeConfig(cfg);
        expect(runtimeConfig.runConfig.max_turns).toBe(7);
      });

      it('should leave max_turns undefined when neither is set', async () => {
        const runtimeConfig = await manager.convertToRuntimeConfig(validConfig);
        expect(runtimeConfig.runConfig.max_turns).toBeUndefined();
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
          model: 'original-model',
          runConfig: { max_time_minutes: 10, max_turns: 20 },
        };

        const updates = {
          model: 'updated-model',
          runConfig: { max_time_minutes: 5 },
        };

        const merged = manager.mergeConfigurations(configWithNested, updates);

        expect(merged.model).toBe('updated-model');
        expect(merged.runConfig!.max_time_minutes).toBe(5); // Should update
        expect(merged.runConfig!.max_turns).toBe(20); // Should keep original
      });
    });

    describe('createAgentHeadless model override', () => {
      const agentConfig: SubagentConfig = {
        name: 'model-test-agent',
        description: 'Test agent',
        systemPrompt: 'You are a test agent.',
        level: 'session' as const,
      };

      beforeEach(() => {
        mockAgentHeadlessCreate.mockResolvedValue({
          execute: vi.fn(),
          getResult: vi.fn(),
        });
        mockCreateContentGenerator.mockResolvedValue({
          generateContentStream: vi.fn(),
        });

        vi.spyOn(mockConfig, 'getContentGeneratorConfig').mockReturnValue({
          model: 'parent-model',
          authType: AuthType.USE_OPENAI,
          apiKey: 'parent-key',
        });
        vi.spyOn(mockConfig, 'getModelsConfig').mockReturnValue({
          getResolvedModel: vi.fn().mockReturnValue(undefined),
          getProtocol: vi.fn().mockReturnValue(Protocol.OPENAI),
        } as unknown as ReturnType<Config['getModelsConfig']>);
      });

      afterEach(() => {
        mockAgentHeadlessCreate.mockReset();
        mockCreateContentGenerator.mockReset();
      });

      it('should create a new ContentGenerator for bare model IDs', async () => {
        const config = { ...agentConfig, model: 'custom-model' };

        await manager.createAgentHeadless(config, mockConfig);

        // Owner is the runtimeContext passed to createAgentHeadless — assert
        // the exact instance so a regression that swaps in a different Config
        // (e.g. the override) gets caught.
        expect(mockCreateContentGenerator).toHaveBeenCalledWith(
          expect.objectContaining({ model: 'custom-model' }),
          mockConfig,
        );
      });

      it('should create a new ContentGenerator for cross-provider selectors', async () => {
        const config = { ...agentConfig, model: 'anthropic:claude-sonnet' };

        await manager.createAgentHeadless(config, mockConfig);

        expect(mockCreateContentGenerator).toHaveBeenCalledWith(
          expect.objectContaining({
            model: 'claude-sonnet',
            authType: 'anthropic',
          }),
          mockConfig,
        );
      });

      it('should NOT create a new ContentGenerator for inherit', async () => {
        const config = { ...agentConfig, model: 'inherit' };

        await manager.createAgentHeadless(config, mockConfig);

        expect(mockCreateContentGenerator).not.toHaveBeenCalled();
      });

      it('should NOT create a new ContentGenerator when model is omitted', async () => {
        await manager.createAgentHeadless(agentConfig, mockConfig);

        expect(mockCreateContentGenerator).not.toHaveBeenCalled();
      });

      it('should pass the agent runtimeView to AgentHeadless.create', async () => {
        const config = { ...agentConfig, model: 'custom-model' };
        const fakeGenerator = { generateContentStream: vi.fn() };
        mockCreateContentGenerator.mockResolvedValue(fakeGenerator);

        await manager.createAgentHeadless(config, mockConfig);

        const { runtimeContext, runtimeView } = destructureAgentHeadlessCall(
          mockAgentHeadlessCreate.mock.calls[0],
        );
        // Subagents always get an `Object.create(parent)` wrapper for
        // FileReadCache isolation — distinct instance, prototype === parent.
        expect(runtimeContext).not.toBe(mockConfig);
        expect(Object.getPrototypeOf(runtimeContext)).toBe(mockConfig);
        expect(runtimeView).toBeDefined();
        expect(runtimeView!.contentGenerator).toBe(fakeGenerator);
        expect(runtimeView!.contentGeneratorConfig.model).toBe('custom-model');
      });

      it('should build a ContentGenerator with the resolved fastModel when model is "fast"', async () => {
        const config = { ...agentConfig, model: 'fast' };
        vi.spyOn(mockConfig, 'getFastModel').mockReturnValue('fast-model-id');

        await manager.createAgentHeadless(config, mockConfig);

        expect(mockCreateContentGenerator).toHaveBeenCalledWith(
          expect.objectContaining({
            model: 'fast-model-id',
            authType: AuthType.USE_OPENAI,
          }),
          mockConfig,
        );
      });

      it('should build a cross-auth ContentGenerator when "fast" resolves to an authType-qualified selector', async () => {
        const config = { ...agentConfig, model: 'fast' };
        vi.spyOn(mockConfig, 'getContentGeneratorConfig').mockReturnValue({
          model: 'parent-model',
          authType: AuthType.USE_ANTHROPIC,
          apiKey: 'parent-key',
        });
        vi.spyOn(mockConfig, 'getFastModel').mockReturnValue(
          'openai:deepseek-v4-flash',
        );

        await manager.createAgentHeadless(config, mockConfig);

        expect(mockCreateContentGenerator).toHaveBeenCalledWith(
          expect.objectContaining({
            model: 'deepseek-v4-flash',
            authType: AuthType.USE_OPENAI,
          }),
          mockConfig,
        );
      });

      it('should resolve bare fast models to their configured auth type when current auth does not own them', async () => {
        const config = { ...agentConfig, model: 'fast' };
        vi.spyOn(mockConfig, 'getContentGeneratorConfig').mockReturnValue({
          model: 'claude-opus',
          authType: AuthType.USE_ANTHROPIC,
          apiKey: 'parent-key',
        });
        vi.spyOn(mockConfig, 'getFastModel').mockReturnValue(
          'deepseek-v4-flash',
        );
        vi.spyOn(mockConfig, 'getAllConfiguredModels').mockImplementation(
          (authTypes) =>
            authTypes?.includes(AuthType.USE_ANTHROPIC)
              ? []
              : [
                  {
                    id: 'deepseek-v4-flash',
                    label: 'deepseek-v4-flash',
                    authType: AuthType.USE_OPENAI,
                  },
                ],
        );

        await manager.createAgentHeadless(config, mockConfig);

        expect(mockCreateContentGenerator).toHaveBeenCalledWith(
          expect.objectContaining({
            model: 'deepseek-v4-flash',
            authType: AuthType.USE_OPENAI,
          }),
          mockConfig,
        );
      });

      it('should NOT build a new ContentGenerator for "fast" when getFastModel returns undefined', async () => {
        const config = { ...agentConfig, model: 'fast' };
        vi.spyOn(mockConfig, 'getFastModel').mockReturnValue(undefined);

        await manager.createAgentHeadless(config, mockConfig);

        // Falls back to inheriting the parent — no override, no runtimeView.
        expect(mockCreateContentGenerator).not.toHaveBeenCalled();
        const { runtimeView } = destructureAgentHeadlessCall(
          mockAgentHeadlessCreate.mock.calls[0],
        );
        expect(runtimeView).toBeUndefined();
      });
    });

    describe('createAgentHeadless — caller-driven dispose contract', () => {
      // Regression for self-inflicted leaks (review #4996 round 1):
      //   1. `wrapAgentHooksForCleanup` relied on `AgentHeadless.execute()`'s
      //      inner finally firing `onStop`. Two execute() early-exit paths
      //      (`createChat()` → null and `prepareTools()` throwing) bypass
      //      that finally, so ephemeral hook entries leaked into the global
      //      registry for the rest of the session.
      //   2. The forced tool-registry rebuild for per-agent `mcpServers`
      //      spawned real MCP client connections (stdio child processes,
      //      sockets) on a registry distinct from the parent's, but nothing
      //      stopped it — every subagent invocation declaring `mcpServers`
      //      orphaned its server processes.
      //
      // The unified fix is to return `{ subagent, dispose }` from
      // `createAgentHeadless` and have callers run `dispose()` in a
      // `finally` that they already own around `subagent.execute()`. These
      // tests assert that contract.

      const baseConfig: SubagentConfig = {
        name: 'cleanup-agent',
        description: 'dispose contract test',
        systemPrompt: 'You are a test agent.',
        level: 'session' as const,
      };

      beforeEach(() => {
        mockAgentHeadlessCreate.mockResolvedValue({
          execute: vi.fn(),
          getResult: vi.fn(),
        });
      });

      afterEach(() => {
        mockAgentHeadlessCreate.mockReset();
      });

      it('returns { subagent, dispose }; dispose unregisters per-agent hooks', async () => {
        const unregisterSpy = vi.fn();
        const addAgentHooksSpy = vi.fn().mockReturnValue(unregisterSpy);
        vi.spyOn(mockConfig, 'getHookSystem').mockReturnValue({
          getRegistry: () => ({ addAgentHooks: addAgentHooksSpy }),
        } as unknown as ReturnType<Config['getHookSystem']>);

        const result = await manager.createAgentHeadless(
          {
            ...baseConfig,
            hooks: {
              PreToolUse: [
                {
                  matcher: 'Bash',
                  hooks: [{ type: 'command', command: 'echo' }],
                },
              ],
            },
          },
          mockConfig,
        );

        // The whole point: callers need an explicit cleanup handle they can
        // invoke from the outer `finally`. A return shape of just
        // `AgentHeadless` (the pre-fix contract) gives them no way to do
        // that, because the inner onStop wrap doesn't fire on every
        // execute() exit path.
        expect(result).toHaveProperty('subagent');
        expect(result).toHaveProperty('dispose');
        expect(typeof result.dispose).toBe('function');
        expect(addAgentHooksSpy).toHaveBeenCalledTimes(1);
        expect(unregisterSpy).not.toHaveBeenCalled();

        await result.dispose();

        expect(unregisterSpy).toHaveBeenCalledTimes(1);
      });

      it('dispose unregisters even when execute() never runs (early-exit leak fix)', async () => {
        // Caller pattern:
        //   const { subagent, dispose } = await createAgentHeadless(...);
        //   try { await subagent.execute(...); } finally { await dispose(); }
        // We never call execute() in this test — that simulates the
        // createChat-returns-null and prepareTools-throws paths where the
        // pre-fix `onStop` wrapping never fired its cleanup.
        const unregisterSpy = vi.fn();
        vi.spyOn(mockConfig, 'getHookSystem').mockReturnValue({
          getRegistry: () => ({
            addAgentHooks: vi.fn().mockReturnValue(unregisterSpy),
          }),
        } as unknown as ReturnType<Config['getHookSystem']>);

        const { dispose } = await manager.createAgentHeadless(
          {
            ...baseConfig,
            hooks: {
              PreToolUse: [
                {
                  matcher: '*',
                  hooks: [{ type: 'command', command: 'echo' }],
                },
              ],
            },
          },
          mockConfig,
        );

        await dispose();
        expect(unregisterSpy).toHaveBeenCalledTimes(1);
      });

      it('dispose is a safe no-op when neither hooks nor mcpServers are declared', async () => {
        const result = await manager.createAgentHeadless(
          baseConfig,
          mockConfig,
        );
        expect(typeof result.dispose).toBe('function');
        // Must not throw — the caller's `finally` always invokes dispose,
        // even for agents that triggered no cleanup-bearing setup.
        await expect(result.dispose()).resolves.toBeUndefined();
      });

      it('runs cleanup when AgentHeadless.create throws — caller never gets dispose', async () => {
        // Constructor-failure path inside createAgentHeadless: the caller
        // never receives `{ subagent, dispose }`, so the inner catch must
        // run the same cleanup itself. Without that, a transient
        // AgentHeadless.create failure (e.g. ContentGenerator init blows
        // up) would orphan the hook entries we just registered.
        const unregisterSpy = vi.fn();
        vi.spyOn(mockConfig, 'getHookSystem').mockReturnValue({
          getRegistry: () => ({
            addAgentHooks: vi.fn().mockReturnValue(unregisterSpy),
          }),
        } as unknown as ReturnType<Config['getHookSystem']>);
        mockAgentHeadlessCreate.mockRejectedValueOnce(
          new Error('synthetic constructor failure'),
        );

        await expect(
          manager.createAgentHeadless(
            {
              ...baseConfig,
              hooks: {
                PreToolUse: [
                  {
                    matcher: '*',
                    hooks: [{ type: 'command', command: 'echo' }],
                  },
                ],
              },
            },
            mockConfig,
          ),
        ).rejects.toThrow(/synthetic constructor failure/);
        expect(unregisterSpy).toHaveBeenCalledTimes(1);
      });
    });
  });
});
