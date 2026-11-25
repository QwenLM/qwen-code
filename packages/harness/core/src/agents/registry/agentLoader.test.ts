/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  parseAgentMarkdown,
  markdownToAgentDefinition,
  loadAgentsFromDirectory,
  loadAgentsFromPath,
  parseAgentsFromJson,
  parseAgentsFromSdkInitialize,
  AgentLoadError,
} from './agentLoader.js';
import {
  RESOLVED_AGENT_REASONING,
  type LocalAgentDefinition,
} from '../types.js';
import {
  SHELL_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  GLOB_TOOL_NAME,
} from '../../tools/tool-names.js';

describe('loader', () => {
  const MODEL_ALIAS_PRO = 'qwen-pro';
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-test-'));
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  async function writeAgentMarkdown(content: string, fileName = 'test.md') {
    const filePath = path.join(tempDir, fileName);
    await fs.writeFile(filePath, content);
    return filePath;
  }

  describe('parseAgentMarkdown', () => {
    it('should parse a valid markdown agent file', async () => {
      const filePath = await writeAgentMarkdown(`---
name: test-agent-md
description: A markdown agent
---
You are a markdown agent.`);

      const result = await parseAgentMarkdown(filePath);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        name: 'test-agent-md',
        description: 'A markdown agent',
        kind: 'local',
        system_prompt: 'You are a markdown agent.',
      });
    });

    it('should parse frontmatter with tools and model config', async () => {
      const filePath = await writeAgentMarkdown(`---
name: complex-agent
description: A complex markdown agent
tools: "${SHELL_TOOL_NAME}"
model: gemini-pro
temperature: 0.7
---
System prompt content.`);

      const result = await parseAgentMarkdown(filePath);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        name: 'complex-agent',
        description: 'A complex markdown agent',
        tools: SHELL_TOOL_NAME,
        model: 'gemini-pro',
        temperature: 0.7,
        system_prompt: 'System prompt content.',
      });
    });

    it('should parse frontmatter with mcpServers', async () => {
      const filePath = await writeAgentMarkdown(`---
name: mcp-agent
description: An agent with MCP servers
mcpServers:
  test-server:
    command: node
    args: [server.js]
    include_tools: [tool1, tool2]
---
System prompt content.`);

      const result = await parseAgentMarkdown(filePath);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        name: 'mcp-agent',
        description: 'An agent with MCP servers',
        mcpServers: {
          'test-server': {
            command: 'node',
            args: ['server.js'],
            include_tools: ['tool1', 'tool2'],
          },
        },
      });
    });

    it('should throw AgentLoadError if frontmatter is missing', async () => {
      const filePath = await writeAgentMarkdown(`Just some markdown content.`);
      await expect(parseAgentMarkdown(filePath)).rejects.toThrow(
        AgentLoadError,
      );
      await expect(parseAgentMarkdown(filePath)).rejects.toThrow(
        'Missing mandatory YAML frontmatter',
      );
    });

    it('should throw AgentLoadError if frontmatter is invalid YAML', async () => {
      const filePath = await writeAgentMarkdown(`---
[
---
Body`);
      await expect(parseAgentMarkdown(filePath)).rejects.toThrow(
        AgentLoadError,
      );
      await expect(parseAgentMarkdown(filePath)).rejects.toThrow(
        'YAML frontmatter parsing failed',
      );
    });

    it('should throw AgentLoadError if validation fails (missing required field)', async () => {
      const filePath = await writeAgentMarkdown(`---
name: test-agent
# missing description
---
Body`);
      await expect(parseAgentMarkdown(filePath)).rejects.toThrow(
        /Validation failed/,
      );
    });

    it('should accept agent names that are not slugs (e.g. spaces, non-ASCII)', async () => {
      const filePath = await writeAgentMarkdown(`---
name: Invalid Name With Spaces
description: Test
---
Body`);
      const result = await parseAgentMarkdown(filePath);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        name: 'Invalid Name With Spaces',
      });
    });

    describe('error formatting and kind inference', () => {
      it('should only show local agent errors when kind is inferred as local (via kind field)', async () => {
        const filePath = await writeAgentMarkdown(`---
kind: local
name: invalid-local
# missing description
---
Body`);
        const error = await parseAgentMarkdown(filePath).catch((e) => e);
        expect(error).toBeInstanceOf(AgentLoadError);
        expect(error.message).toContain('Validation failed');
        expect(error.message).toContain('description: Required');
      });

      it('should only show local agent errors when kind is inferred as local (via local-specific keys)', async () => {
        const filePath = await writeAgentMarkdown(`---
name: invalid-local
# missing description
tools: "${SHELL_TOOL_NAME}"
---
Body`);
        const error = await parseAgentMarkdown(filePath).catch((e) => e);
        expect(error).toBeInstanceOf(AgentLoadError);
        expect(error.message).toContain('Validation failed');
        expect(error.message).toContain('description: Required');
      });

      it('should silently strip unknown keys (no strict mode)', async () => {
        const filePath = await writeAgentMarkdown(`---
kind: local
name: my-agent
description: test
unknown_field: true
---
Body`);
        const result = await parseAgentMarkdown(filePath);
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
          kind: 'local',
          name: 'my-agent',
          description: 'test',
        });
        // unknown_field should be silently stripped
        expect(result[0]).not.toHaveProperty('unknown_field');
      });
    });
  });

  describe('markdownToAgentDefinition', () => {
    it('should convert valid Markdown DTO to AgentDefinition with defaults', () => {
      const markdown = {
        kind: 'local' as const,
        name: 'test-agent',
        description: 'A test agent',
        system_prompt: 'You are a test agent.',
      };

      const result = markdownToAgentDefinition(markdown);
      expect(result).toMatchObject({
        name: 'test-agent',
        description: 'A test agent',
        promptConfig: {
          systemPrompt: 'You are a test agent.',
          query: undefined,
        },
        modelConfig: {
          model: 'inherit',
        },
        inputConfig: {
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'The task for the agent.',
              },
            },
            required: [],
          },
        },
      });
      expect(result.modelConfig.generateContentConfig).toBeUndefined();
    });

    it('should preserve an explicit temperature without synthesizing other sampling fields', () => {
      const result = markdownToAgentDefinition({
        kind: 'local' as const,
        name: 'temperature-agent',
        description: 'An agent with explicit sampling',
        temperature: 0.7,
        system_prompt: 'You are a test agent.',
      }) as LocalAgentDefinition;

      expect(result.modelConfig.generateContentConfig).toEqual({
        temperature: 0.7,
      });
    });

    it('should pass through model aliases', () => {
      const markdown = {
        kind: 'local' as const,
        name: 'test-agent',
        description: 'A test agent',
        model: MODEL_ALIAS_PRO,
        system_prompt: 'You are a test agent.',
      };

      const result = markdownToAgentDefinition(
        markdown,
      ) as LocalAgentDefinition;
      expect(result.modelConfig.model).toBe(MODEL_ALIAS_PRO);
    });

    it('should convert mcp_servers in local agent', () => {
      const markdown = {
        kind: 'local' as const,
        name: 'mcp-agent',
        description: 'An agent with MCP servers',
        mcpServers: [
          {
            'test-server': {
              command: 'node',
              args: ['server.js'],
              include_tools: ['tool1'],
            },
          },
        ],
        system_prompt: 'prompt',
      };

      const result = markdownToAgentDefinition(
        markdown,
      ) as LocalAgentDefinition;
      expect(result.kind).toBe('local');
      expect(result.mcpServers).toBeDefined();
      expect(result.mcpServers).toHaveLength(1);
      const firstSpec = result.mcpServers![0] as Record<string, unknown>;
      expect(firstSpec['test-server']).toMatchObject({
        command: 'node',
        args: ['server.js'],
        includeTools: ['tool1'],
      });
    });

    it('should pass through unknown model names (e.g. auto)', () => {
      const markdown = {
        kind: 'local' as const,
        name: 'test-agent',
        description: 'A test agent',
        model: 'auto',
        system_prompt: 'You are a test agent.',
      };

      const result = markdownToAgentDefinition(
        markdown,
      ) as LocalAgentDefinition;
      expect(result.modelConfig.model).toBe('auto');
    });

    it('should parse CSV tools string into array', () => {
      const markdown = {
        kind: 'local' as const,
        name: 'csv-tools-agent',
        description: 'Agent with CSV tools',
        tools: `${READ_FILE_TOOL_NAME}, ${GLOB_TOOL_NAME}, edit_file`,
        system_prompt: 'prompt',
      };

      const result = markdownToAgentDefinition(
        markdown,
      ) as LocalAgentDefinition;
      expect(result.toolConfig?.tools).toEqual([
        READ_FILE_TOOL_NAME,
        GLOB_TOOL_NAME,
        'edit_file',
      ]);
    });

    it('should parse disallowedTools CSV string', () => {
      const markdown = {
        kind: 'local' as const,
        name: 'disallowed-tools-agent',
        description: 'Agent with disallowed tools',
        tools: '*',
        disallowedTools: `${SHELL_TOOL_NAME}, bash_command`,
        system_prompt: 'prompt',
      };

      const result = markdownToAgentDefinition(
        markdown,
      ) as LocalAgentDefinition;
      expect(result.disallowedTools).toEqual([SHELL_TOOL_NAME, 'bash_command']);
    });

    it('should parse skills CSV string', () => {
      const markdown = {
        kind: 'local' as const,
        name: 'skills-agent',
        description: 'Agent with skills whitelist',
        skills: 'commit, review-pr',
        system_prompt: 'prompt',
      };

      const result = markdownToAgentDefinition(
        markdown,
      ) as LocalAgentDefinition;
      expect(result.skills).toEqual(['commit', 'review-pr']);
    });

    it('should preserve effort input without resolving runtime reasoning', () => {
      const efforts = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

      for (const effort of efforts) {
        const markdown = {
          kind: 'local' as const,
          name: `effort-${effort}-agent`,
          description: `Agent with ${effort} effort`,
          effort,
          system_prompt: 'prompt',
        };

        const result = markdownToAgentDefinition(
          markdown,
        ) as LocalAgentDefinition;
        expect(result.effort).toBe(effort);
        expect(
          result.modelConfig.generateContentConfig?.['thinkingConfig'],
        ).toBeUndefined();
        expect(result[RESOLVED_AGENT_REASONING]).toBeUndefined();
      }
    });

    it('should not add thinkingConfig when effort is not specified', () => {
      const markdown = {
        kind: 'local' as const,
        name: 'no-effort-agent',
        description: 'Agent without effort',
        system_prompt: 'prompt',
      };

      const result = markdownToAgentDefinition(
        markdown,
      ) as LocalAgentDefinition;
      expect(
        result.modelConfig.generateContentConfig?.['thinkingConfig'],
      ).toBeUndefined();
    });

    it('should store initialPrompt on definition but not in promptConfig.query', () => {
      const markdown = {
        kind: 'local' as const,
        name: 'initial-prompt-agent',
        description: 'Agent with initialPrompt',
        initialPrompt: 'Start by analyzing the codebase structure',
        system_prompt: 'prompt',
      };

      const result = markdownToAgentDefinition(
        markdown,
      ) as LocalAgentDefinition;
      // initialPrompt should NOT be mapped to promptConfig.query (it is only
      // used when the agent runs as the main-thread / session agent).
      expect(result.promptConfig.query).toBeUndefined();
      expect(result.initialPrompt).toBe(
        'Start by analyzing the codebase structure',
      );
    });

    it('should pass through color field', () => {
      const markdown = {
        kind: 'local' as const,
        name: 'colored-agent',
        description: 'Agent with color',
        color: 'red' as const,
        system_prompt: 'prompt',
      };

      const result = markdownToAgentDefinition(
        markdown,
      ) as LocalAgentDefinition;
      expect(result.color).toBe('red');
    });

    it('should use maxTurns and timeoutMins (camelCase)', () => {
      const markdown = {
        kind: 'local' as const,
        name: 'camel-case-agent',
        description: 'Agent with camelCase config',
        maxTurns: 50,
        timeoutMins: 20,
        system_prompt: 'prompt',
      };

      const result = markdownToAgentDefinition(
        markdown,
      ) as LocalAgentDefinition;
      expect(result.runConfig?.maxTurns).toBe(50);
      expect(result.runConfig?.maxTimeMinutes).toBe(20);
    });

    it('should pass through runtime fields', () => {
      const markdown = {
        kind: 'local' as const,
        name: 'schema-only-agent',
        description: 'Agent with schema-only fields',
        permissionMode: 'ask',
        hooks: {
          PreToolUse: [
            {
              matcher: 'Edit',
              hooks: [{ type: 'command' as const, command: 'echo started' }],
            },
          ],
        },
        memory: 'user' as const,
        background: true,
        isolation: 'worktree' as const,
        system_prompt: 'prompt',
      };

      const result = markdownToAgentDefinition(
        markdown,
      ) as LocalAgentDefinition;
      expect(result.permissionMode).toBe('ask');
      expect(result.hooks).toEqual({
        PreToolUse: [
          {
            matcher: 'Edit',
            hooks: [{ type: 'command', command: 'echo started' }],
          },
        ],
      });
      expect(result.memory).toBe('user');
      expect(result.background).toBe(true);
      expect(result.isolation).toBe('worktree');
    });

    it('should pass through args on command hooks for exec form', () => {
      const markdown = {
        kind: 'local' as const,
        name: 'exec-form-agent',
        description: 'Agent with an exec-form command hook',
        hooks: {
          PreToolUse: [
            {
              matcher: '*',
              hooks: [
                {
                  type: 'command' as const,
                  command: '/bin/echo',
                  args: ['hi', '${QWEN_PROJECT_DIR}'],
                },
              ],
            },
          ],
        },
        system_prompt: 'prompt',
      };

      const result = markdownToAgentDefinition(
        markdown,
      ) as LocalAgentDefinition;
      expect(result.hooks).toEqual({
        PreToolUse: [
          {
            matcher: '*',
            hooks: [
              {
                type: 'command',
                command: '/bin/echo',
                args: ['hi', '${QWEN_PROJECT_DIR}'],
              },
            ],
          },
        ],
      });
    });

    it('should not reject tool names at parse time (validation deferred to runtime)', async () => {
      const filePath = await writeAgentMarkdown(`---
name: invalid-tools-agent
description: Agent with unusual tool names
tools: "${READ_FILE_TOOL_NAME}, some_custom_tool, ${GLOB_TOOL_NAME}"
---
System prompt.`);

      const result = await parseAgentMarkdown(filePath);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        name: 'invalid-tools-agent',
        tools: `${READ_FILE_TOOL_NAME}, some_custom_tool, ${GLOB_TOOL_NAME}`,
      });
    });
  });

  describe('loadAgentsFromDirectory', () => {
    it('should load definitions from a directory (Markdown only)', async () => {
      await writeAgentMarkdown(
        `---
name: agent-1
description: Agent 1
---
Prompt 1`,
        'valid.md',
      );

      // Create a non-supported file
      await fs.writeFile(path.join(tempDir, 'other.txt'), 'content');

      // Create a hidden file
      await writeAgentMarkdown(
        `---
name: hidden
description: Hidden
---
Hidden`,
        '_hidden.md',
      );

      const result = await loadAgentsFromDirectory(tempDir);
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].name).toBe('agent-1');
      expect(result.errors).toHaveLength(0);
    });

    it('should return empty result if directory does not exist', async () => {
      const nonExistentDir = path.join(tempDir, 'does-not-exist');
      const result = await loadAgentsFromDirectory(nonExistentDir);
      expect(result.agents).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it('should capture errors for malformed individual files', async () => {
      // Create a malformed Markdown file
      await writeAgentMarkdown('invalid markdown', 'malformed.md');

      const result = await loadAgentsFromDirectory(tempDir);
      expect(result.agents).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
    });
  });

  describe('loadAgentsFromPath', () => {
    it('dispatches Markdown files and directories through the same entry point', async () => {
      const filePath = await writeAgentMarkdown(`---
name: shared-source-agent
description: Shared source agent
---
Prompt`);

      const fileResult = await loadAgentsFromPath(filePath, {
        pluginName: 'demo-plugin',
      });
      const directoryResult = await loadAgentsFromPath(tempDir, {
        pluginName: 'demo-plugin',
      });

      expect(fileResult).toMatchObject({
        sourceType: 'file',
        errors: [],
        agents: [{ name: 'demo-plugin:shared-source-agent' }],
      });
      expect(directoryResult).toMatchObject({
        sourceType: 'directory',
        errors: [],
        agents: [{ name: 'demo-plugin:shared-source-agent' }],
      });
    });

    it('returns undefined when the source path no longer exists', async () => {
      await expect(
        loadAgentsFromPath(path.join(tempDir, 'missing.md')),
      ).resolves.toBeUndefined();
    });
  });

  describe('inline agent definitions', () => {
    it('preserves background runtime fields from --agents JSON', () => {
      const [agent] = parseAgentsFromJson(
        JSON.stringify({
          worker: {
            description: 'Background worker',
            prompt: 'Work independently.',
            background: true,
            memory: 'project',
            isolation: 'worktree',
          },
        }),
      );

      expect(agent).toMatchObject({
        name: 'worker',
        background: true,
        memory: 'project',
        isolation: 'worktree',
      });
    });

    it('preserves background runtime fields from SDK initialize', () => {
      const [agent] = parseAgentsFromSdkInitialize({
        worker: {
          description: 'Background worker',
          prompt: 'Work independently.',
          background: true,
          memory: 'local',
        },
      });

      expect(agent).toMatchObject({
        name: 'worker',
        background: true,
        memory: 'local',
      });
    });
  });
});
