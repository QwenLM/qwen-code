/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { getMemoryTypesBody } from '../memory/memory-types.js';
import { systemPromptFromText } from '../prompts/system-prompt.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ActivateSkillTool } from './activate-skill.js';
import type { Config } from '../config/config.js';
import * as agentSetup from '../agents/agent-setup.js';
import * as runSubagentModule from '../agents/run-subagent.js';
import { RESOLVED_AGENT_REASONING } from '../agents/types.js';
import type { EffortValue } from '../utils/frontmatterParsers.js';

vi.mock('../utils/promptShellExecution.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/promptShellExecution.js')>();
  return {
    ...actual,
    executeShellCommandsInPrompt: vi
      .fn()
      .mockImplementation(async (body: string) => body),
  };
});

describe('ActivateSkillTool', () => {
  let mockConfig: Config;
  let tool: ActivateSkillTool;

  beforeEach(() => {
    const skills = [
      {
        name: 'test-skill',
        description: 'A test skill',
        location: '/path/to/test-skill/SKILL.md',
        skillRoot: '/registered/test-skill-root',
      },
    ];
    const skillManager = {
      recordUsage: vi.fn().mockResolvedValue(undefined),
      getSkills: vi.fn().mockReturnValue(skills),
      getModelVisibleSkills: vi.fn(),
      getAllSkills: vi.fn().mockReturnValue(skills),
      isSkillAllowedForMainSession: vi.fn().mockReturnValue(true),
      getSkill: vi.fn().mockImplementation((name: string) => {
        if (name.toLowerCase() === 'test-skill') {
          return {
            name: 'test-skill',
            description: 'A test skill',
            location: '/path/to/test-skill/SKILL.md',
            skillRoot: '/registered/test-skill-root',
            body: 'Skill instructions content. ${QWEN_SKILL_DIR}',
          };
        }
        return null;
      }),
      activateSkill: vi.fn(),
      clearInvokedSkillsForAgent: vi.fn(),
    };
    // Mirror the real accessor: model-visible excludes disableModelInvocation.
    // Delegating to getSkills lets tests that update getSkills flow through
    // without also stubbing getModelVisibleSkills.
    skillManager.getModelVisibleSkills.mockImplementation(() =>
      skillManager
        .getSkills()
        .filter(
          (s: { disableModelInvocation?: boolean }) =>
            !s.disableModelInvocation,
        ),
    );
    mockConfig = {
      isWorkflowsEnabled: vi.fn().mockReturnValue(false),
      getWorkspaceContext: vi.fn().mockReturnValue({
        addDirectory: vi.fn(),
        addReadOnlyPath: vi.fn(),
      }),
      getSkillManager: vi.fn().mockReturnValue(skillManager),
      getWorkingDir: vi.fn().mockReturnValue('/test/workspace'),
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getModel: vi.fn().mockReturnValue('parent-session-model'),
      isSkillShellExecutionDisabled: vi.fn().mockReturnValue(false),
      getShellExecutionConfig: vi.fn().mockReturnValue({}),
    } as unknown as Config;
    tool = new ActivateSkillTool(mockConfig);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('gives auto-mode review the whole skill arguments', () => {
    const args = `${'a'.repeat(2000)} --target prod`;
    expect(tool.toClassifierInput({ skill: 'deploy', args })).toEqual({
      skill: 'deploy',
      args,
    });
  });

  it('reports missing memory-types through the normal skill error path', async () => {
    const result = await tool
      .build({ skill: 'memory-types' })
      .execute(new AbortController().signal);
    expect(result.error).toBeDefined();
    expect(result.error?.message).toContain('Skill "memory-types" not found');
  });

  it('delivers the complete builtin type body via normal skill activation', async () => {
    vi.mocked(mockConfig.getSkillManager().getSkill).mockReturnValue({
      name: 'memory-types',
      description: 'types',
      location: 'bundled',
      skillRoot: '/test',
      body: '',
      isBuiltin: true,
      source: 'built-in',
      getBody: getMemoryTypesBody,
    });
    mockConfig.getToolRegistry = vi
      .fn()
      .mockReturnValue({ getFunctionDeclarations: () => [] });
    const result = await tool
      .build({ skill: 'memory-types' })
      .execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    const content = result.newMessages?.[0]?.content;
    expect(content).toContain(await getMemoryTypesBody());
    for (const type of ['user', 'feedback', 'project', 'reference']) {
      expect(content).toContain(`<name>${type}</name>`);
    }
    expect(content).not.toContain('<when_to_save>');
  });

  it('should return enhanced description', () => {
    const params = { skill: 'test-skill' };
    const invocation = tool.build(params);
    expect(invocation.getDescription()).toBe('"test-skill": A test skill');
  });

  it('should activate a valid skill and return its content in newMessages', async () => {
    const params = { skill: 'test-skill' };
    const invocation = tool.build(params);
    const result = await invocation.execute(new AbortController().signal);

    expect(mockConfig.getSkillManager().recordUsage).toHaveBeenCalledWith(
      'test-skill',
    );
    expect(mockConfig.getSkillManager().activateSkill).toHaveBeenCalledWith(
      'test-skill',
      expect.any(String),
    );
    expect(
      mockConfig.getWorkspaceContext().addDirectory,
    ).not.toHaveBeenCalled();
    expect(
      mockConfig.getWorkspaceContext().addReadOnlyPath,
    ).not.toHaveBeenCalled();
    // Main llmContent is a short confirmation
    expect(result.llmContent).toContain('Launching skill: test-skill');
    // Full skill content is in newMessages (bypasses truncation)
    expect(result.newMessages).toBeDefined();
    expect(result.newMessages).toHaveLength(1);
    const msgContent = result.newMessages![0].content as string;
    // Model-invoked path: metadata tags are filtered out.
    // Only the skill body + resources should appear in newMessages content.
    expect(msgContent).not.toContain('<command-message>');
    expect(msgContent).not.toContain('<command-name>');
    expect(msgContent).not.toContain('<skill-format>');
    expect(msgContent).toBe(
      'Base directory for this skill: /registered/test-skill-root\n\nSkill instructions content. /registered/test-skill-root',
    );
    expect(result.newMessages![0].isMeta).toBe(true);
    expect(result.returnDisplay).toContain('Skill **test-skill** activated');
    expect(result.toolUseResult).toEqual({
      success: true,
      commandName: 'test-skill',
      status: 'inline',
    });
  });

  it('should canonicalize mixed-case model input before activation', async () => {
    const invocation = tool.build({ skill: 'TEST-SKILL' });
    const result = await invocation.execute(new AbortController().signal);

    expect(mockConfig.getSkillManager().activateSkill).toHaveBeenCalledWith(
      'test-skill',
      expect.any(String),
    );
    expect(result.llmContent).toContain('Launching skill: test-skill');
    expect(result.returnDisplay).toContain('Skill **test-skill** activated');
  });

  it('should return an error for non-existent skill name (runtime validation)', async () => {
    vi.mocked(mockConfig.getSkillManager().getSkill).mockReturnValue(null);
    const params = { skill: 'non-existent' };
    const invocation = tool.build(params as { skill: string });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.llmContent).toContain(
      'Error: Skill "non-existent" not found.',
    );
    expect(result.data).toMatchObject({
      tool_error_stage: 'parameter_validation',
      tool_error_subtype: 'missing_reference',
    });
    expect(
      JSON.parse(result.data?.['tool_error_details_json'] as string),
    ).toEqual({
      schema_version: 1,
      validation_source: 'tool_execution',
      parameter_path: 'params.skill',
      constraint_category: 'reference_not_found',
      quality: 'precise',
      validation_phase: 'execution',
    });
    expect(JSON.stringify(result.data)).not.toContain('non-existent');
  });

  it('should return an error if skill content cannot be read', async () => {
    vi.mocked(mockConfig.getSkillManager().getSkill).mockReturnValue(null);
    const params = { skill: 'test-skill' };
    const invocation = tool.build(params);
    const result = await invocation.execute(new AbortController().signal);

    expect(result.llmContent).toContain('Error: Skill "test-skill" not found.');
    expect(mockConfig.getSkillManager().activateSkill).not.toHaveBeenCalled();
  });

  it('should return an error for empty skill name (runtime validation)', async () => {
    vi.mocked(mockConfig.getSkillManager().getSkill).mockReturnValue(null);
    const invocation = tool.build({ skill: '' } as unknown as {
      skill: string;
    });
    const result = await invocation.execute(new AbortController().signal);
    expect(result.llmContent).toContain('Error: Skill "" not found.');
  });

  it('should omit disableModelInvocation skills from the not-found suggestions', async () => {
    vi.mocked(mockConfig.getSkillManager().getSkill).mockReturnValue(null);
    vi.mocked(mockConfig.getSkillManager().getSkills).mockReturnValue([
      {
        name: 'test-skill',
        description: 'A test skill',
        location: '/path/to/test-skill/SKILL.md',
      },
      {
        name: 'debug',
        description: 'A user-only skill',
        location: '/path/to/debug/SKILL.md',
        disableModelInvocation: true,
      },
    ] as never);

    const invocation = tool.build({ skill: 'unknown-helper' });
    const result = await invocation.execute(new AbortController().signal);

    expect(result.llmContent).toContain('Available skills are: test-skill');
    expect(result.llmContent).not.toContain('debug');
  });

  it('should report that no skills are available when all are model-blocked', async () => {
    vi.mocked(mockConfig.getSkillManager().getSkill).mockReturnValue(null);
    vi.mocked(mockConfig.getSkillManager().getSkills).mockReturnValue([
      {
        name: 'debug',
        description: 'A user-only skill',
        location: '/path/to/debug/SKILL.md',
        disableModelInvocation: true,
      },
    ] as never);

    const invocation = tool.build({ skill: 'harness-debugger' });
    const result = await invocation.execute(new AbortController().signal);

    expect(result.llmContent).toContain(
      'No skills are available to activate.',
    );
  });

  it('should reject direct model invocation when disabled by the skill', async () => {
    const modelBlockedSkill = {
      name: 'quest',
      description: 'A user-invocable-only skill',
      location: 'bundled',
      skillRoot: '/test/workspace',
      body: 'Quest instructions.',
      disableModelInvocation: true,
      userInvocable: true,
    };
    vi.mocked(mockConfig.getSkillManager().getSkill).mockReturnValue(
      modelBlockedSkill,
    );

    const invocation = tool.build({ skill: 'quest' });
    const result = await invocation.execute(new AbortController().signal);

    expect(result.error).toMatchObject({
      type: 'policy_violation',
    });
    expect(result.llmContent).toContain(
      'cannot be activated via the Skill tool',
    );
    expect(mockConfig.getSkillManager().activateSkill).not.toHaveBeenCalled();
  });

  it('should substitute $ARGUMENTS in skill body', async () => {
    const skillWithArgs = {
      name: 'arg-skill',
      description: 'A skill with args',
      location: '/path/to/arg-skill/SKILL.md',
      skillRoot: '/path/to/arg-skill',
      body: 'Process file: $ARGUMENTS',
    };

    vi.mocked(mockConfig.getSkillManager().getSkill).mockReturnValue(
      skillWithArgs,
    );
    vi.mocked(mockConfig.getSkillManager().getSkills).mockReturnValue([
      skillWithArgs,
    ]);

    const toolWithArgs = new ActivateSkillTool(mockConfig);
    const params = { skill: 'arg-skill', args: 'foo.txt' };
    const invocation = toolWithArgs.build(params);
    const result = await invocation.execute(new AbortController().signal);

    const msgContent = result.newMessages![0].content as string;
    expect(msgContent).toContain('Process file: foo.txt');
    expect(msgContent).not.toContain('$ARGUMENTS');
  });

  it('should substitute positional $0 and $1 in skill body', async () => {
    const skillWithPositional = {
      name: 'pos-skill',
      description: 'A positional skill',
      location: '/path/to/pos-skill/SKILL.md',
      skillRoot: '/path/to/pos-skill',
      body: 'Source: $0, Target: $1',
    };

    vi.mocked(mockConfig.getSkillManager().getSkill).mockReturnValue(
      skillWithPositional,
    );
    vi.mocked(mockConfig.getSkillManager().getSkills).mockReturnValue([
      skillWithPositional,
    ]);

    const toolWithPos = new ActivateSkillTool(mockConfig);
    const params = { skill: 'pos-skill', args: 'input.csv output.json' };
    const invocation = toolWithPos.build(params);
    const result = await invocation.execute(new AbortController().signal);

    const msgContent = result.newMessages![0].content as string;
    expect(msgContent).toContain('Source: input.csv, Target: output.json');
  });

  it('should append ARGUMENTS fallback when skill body has no placeholders', async () => {
    const skillNoPlaceholders = {
      name: 'plain-skill',
      description: 'A plain skill',
      location: '/path/to/plain-skill/SKILL.md',
      skillRoot: '/path/to/plain-skill',
      body: 'Just do the thing.',
    };

    vi.mocked(mockConfig.getSkillManager().getSkill).mockReturnValue(
      skillNoPlaceholders,
    );
    vi.mocked(mockConfig.getSkillManager().getSkills).mockReturnValue([
      skillNoPlaceholders,
    ]);

    const toolWithFallback = new ActivateSkillTool(mockConfig);
    const params = { skill: 'plain-skill', args: 'extra info here' };
    const invocation = toolWithFallback.build(params);
    const result = await invocation.execute(new AbortController().signal);

    const msgContent = result.newMessages![0].content as string;
    expect(msgContent).toContain('Just do the thing.');
    expect(msgContent).toContain('ARGUMENTS: extra info here');
  });

  describe('SK54: disableSkillShellExecution', () => {
    it('should replace shell commands with placeholder when shell execution is disabled', async () => {
      const shellSkill = {
        name: 'shell-skill',
        description: 'A skill with shell commands',
        location: '/path/to/shell-skill/SKILL.md',
        skillRoot: '/path/to/shell-skill',
        body: 'Run this: !`echo hello`\nAnd this:\n```!\nls -la\n```\nDone.',
      };

      vi.mocked(mockConfig.getSkillManager().getSkill).mockReturnValue(
        shellSkill,
      );
      vi.mocked(mockConfig.getSkillManager().getSkills).mockReturnValue([
        shellSkill,
      ]);

      mockConfig.isSkillShellExecutionDisabled = vi.fn().mockReturnValue(true);

      const toolWithDisabled = new ActivateSkillTool(mockConfig);
      const params = { skill: 'shell-skill' };
      const invocation = toolWithDisabled.build(params);
      const result = await invocation.execute(new AbortController().signal);

      const msgContent = result.newMessages![0].content as string;
      expect(msgContent).not.toContain('!`echo hello`');
      expect(msgContent).not.toContain('```!');
      expect(msgContent).toContain(
        '[shell command execution disabled by policy]',
      );
      expect(msgContent).toContain('Done.');
    });

    it('should NOT replace shell commands for built-in skills even when disabled', async () => {
      const builtinShellSkill = {
        name: 'builtin-shell',
        description: 'A built-in skill with shell commands',
        location: '/path/to/builtin-shell/SKILL.md',
        skillRoot: '/test/workspace',
        body: 'Run this: !`echo hello`',
        isBuiltin: true,
      };

      vi.mocked(mockConfig.getSkillManager().getSkill).mockReturnValue(
        builtinShellSkill,
      );
      vi.mocked(mockConfig.getSkillManager().getSkills).mockReturnValue([
        builtinShellSkill,
      ]);

      mockConfig.isSkillShellExecutionDisabled = vi.fn().mockReturnValue(true);

      const toolWithBuiltin = new ActivateSkillTool(mockConfig);
      const params = { skill: 'builtin-shell' };
      const invocation = toolWithBuiltin.build(params);
      const result = await invocation.execute(new AbortController().signal);

      const msgContent = result.newMessages![0].content as string;
      // Built-in skills should NOT have shell commands replaced with the
      // placeholder — they go through normal executeShellCommandsInPrompt
      // (mocked here to return body as-is).
      expect(msgContent).not.toContain(
        '[shell command execution disabled by policy]',
      );
      expect(msgContent).toContain('Run this: !`echo hello`');
    });

    it('should execute shell commands normally when shell execution is NOT disabled', async () => {
      const shellSkill = {
        name: 'shell-skill',
        description: 'A skill with shell commands',
        location: '/path/to/shell-skill/SKILL.md',
        skillRoot: '/path/to/shell-skill',
        body: 'No shell commands here, just plain text.',
      };

      vi.mocked(mockConfig.getSkillManager().getSkill).mockReturnValue(
        shellSkill,
      );
      vi.mocked(mockConfig.getSkillManager().getSkills).mockReturnValue([
        shellSkill,
      ]);

      mockConfig.isSkillShellExecutionDisabled = vi.fn().mockReturnValue(false);

      const toolNormal = new ActivateSkillTool(mockConfig);
      const params = { skill: 'shell-skill' };
      const invocation = toolNormal.build(params);
      const result = await invocation.execute(new AbortController().signal);

      const msgContent = result.newMessages![0].content as string;
      expect(msgContent).toContain('No shell commands here, just plain text.');
      expect(msgContent).not.toContain(
        '[shell command execution disabled by policy]',
      );
    });
  });

  it('should handle quoted arguments in $ARGUMENTS[N]', async () => {
    const skillWithIndexed = {
      name: 'idx-skill',
      description: 'An indexed skill',
      location: '/path/to/idx-skill/SKILL.md',
      skillRoot: '/path/to/idx-skill',
      body: 'File: $ARGUMENTS[0], Mode: $ARGUMENTS[1]',
    };

    vi.mocked(mockConfig.getSkillManager().getSkill).mockReturnValue(
      skillWithIndexed,
    );
    vi.mocked(mockConfig.getSkillManager().getSkills).mockReturnValue([
      skillWithIndexed,
    ]);

    const toolWithQuoted = new ActivateSkillTool(mockConfig);
    const params = { skill: 'idx-skill', args: '"hello world" fast' };
    const invocation = toolWithQuoted.build(params);
    const result = await invocation.execute(new AbortController().signal);

    const msgContent = result.newMessages![0].content as string;
    expect(msgContent).toContain('File: hello world, Mode: fast');
  });

  it('should preserve bounded forked skill result in structured toolUseResult', async () => {
    const hookSystem = {
      registerSessionHook: vi.fn(),
      clearSessionHooks: vi.fn(),
    };
    Object.assign(mockConfig, {
      getHookSystem: vi.fn().mockReturnValue(hookSystem),
      getAgentRegistry: vi.fn().mockReturnValue(undefined),
      getToolRegistry: vi.fn().mockReturnValue({
        getAllTools: vi.fn().mockReturnValue([]),
      }),
      getPermissionMode: vi.fn().mockReturnValue('default'),
      setPermissionMode: vi.fn(),
    });
    const skillManager = mockConfig.getSkillManager();
    vi.mocked(skillManager.getSkill).mockReturnValue({
      name: 'fork-skill',
      description: 'A forked skill',
      location: '/path/to/fork-skill/SKILL.md',
      skillRoot: '/path/to/fork-skill',
      body: 'Forked skill body.',
      context: 'fork',
    });
    vi.mocked(skillManager.getSkills).mockReturnValue([
      skillManager.getSkill('fork-skill')!,
    ]);

    const buildSubagentRegistriesSpy = vi
      .spyOn(agentSetup, 'buildSubagentRegistries')
      .mockResolvedValueOnce({
        toolRegistry: {
          getAllTools: vi.fn().mockReturnValue([]),
        },
        toolBridge: {
          execute: vi.fn(),
          dispose: vi.fn(),
        },
        schedulerContext: {
          config: mockConfig,
        },
      } as never);
    const buildSubagentSystemPromptSpy = vi
      .spyOn(agentSetup, 'buildSubagentSystemPrompt')
      .mockResolvedValueOnce(systemPromptFromText('system prompt'));
    const largeOutput = 'x'.repeat(60_000);
    const runSubagentSpy = vi
      .spyOn(runSubagentModule, 'runSubagent')
      .mockResolvedValueOnce({
        messages: [],
        totalUsage: {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        },
        textContent: largeOutput,
      } as never);

    const toolWithForkSkill = new ActivateSkillTool(mockConfig);
    const invocation = toolWithForkSkill.build({ skill: 'fork-skill' });
    const result = await invocation.executeWithContext!({
      signal: new AbortController().signal,
      customContext: { tenant: 'skill' },
    } as never);
    const toolUseResult = result.toolUseResult as {
      success: true;
      commandName: string;
      status: 'forked';
      result: string;
    };

    expect(result.llmContent).toContain(largeOutput);
    expect(toolUseResult).toMatchObject({
      success: true,
      commandName: 'fork-skill',
      status: 'forked',
    });
    expect(toolUseResult.result.length).toBeLessThan(largeOutput.length);
    expect(toolUseResult.result).toContain('output truncated');
    expect(runSubagentSpy.mock.calls[0]?.[0].prompt).toBe(
      'Base directory for this skill: /path/to/fork-skill\n\nForked skill body.',
    );
    expect(runSubagentSpy.mock.calls[0]?.[0].customContext).toEqual({
      tenant: 'skill',
    });

    runSubagentSpy.mockRestore();
    buildSubagentSystemPromptSpy.mockRestore();
    buildSubagentRegistriesSpy.mockRestore();
  });

  it("resolves the 'inherit' model sentinel to the parent session model before running the fork subagent", async () => {
    const hookSystem = {
      registerSessionHook: vi.fn(),
      clearSessionHooks: vi.fn(),
    };
    Object.assign(mockConfig, {
      getHookSystem: vi.fn().mockReturnValue(hookSystem),
      // No agent registry → buildDefaultSkillForkDefinition() is used, which
      // carries modelConfig.model === 'inherit'.
      getAgentRegistry: vi.fn().mockReturnValue(undefined),
      getToolRegistry: vi.fn().mockReturnValue({
        getAllTools: vi.fn().mockReturnValue([]),
      }),
      getPermissionMode: vi.fn().mockReturnValue('default'),
      setPermissionMode: vi.fn(),
      // Parent session model that 'inherit' must resolve to.
      getModel: vi.fn().mockReturnValue('gm51model'),
    });
    const skillManager = mockConfig.getSkillManager();
    vi.mocked(skillManager.getSkill).mockReturnValue({
      name: 'inherit-fork',
      description: 'A forked skill without explicit model',
      location: '/path/to/inherit-fork/SKILL.md',
      skillRoot: '/path/to/inherit-fork',
      body: 'Forked skill body.',
      context: 'fork',
    });
    vi.mocked(skillManager.getSkills).mockReturnValue([
      skillManager.getSkill('inherit-fork')!,
    ]);

    const buildSubagentRegistriesSpy = vi
      .spyOn(agentSetup, 'buildSubagentRegistries')
      .mockResolvedValueOnce({
        toolRegistry: { getAllTools: vi.fn().mockReturnValue([]) },
        toolBridge: { execute: vi.fn(), dispose: vi.fn() },
        schedulerContext: { config: mockConfig },
      } as never);
    const buildSubagentSystemPromptSpy = vi
      .spyOn(agentSetup, 'buildSubagentSystemPrompt')
      .mockResolvedValueOnce(systemPromptFromText('system prompt'));
    const runSubagentSpy = vi
      .spyOn(runSubagentModule, 'runSubagent')
      .mockResolvedValueOnce({
        messages: [],
        totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        textContent: 'done',
      } as never);

    const toolWithForkSkill = new ActivateSkillTool(mockConfig);
    const invocation = toolWithForkSkill.build({ skill: 'inherit-fork' });
    await invocation.execute(new AbortController().signal);

    expect(runSubagentSpy).toHaveBeenCalledTimes(1);
    const callArg = runSubagentSpy.mock.calls[0][0] as { model: string };
    expect(callArg.model).toBe('gm51model');
    expect(callArg.model).not.toBe('inherit');

    runSubagentSpy.mockRestore();
    buildSubagentSystemPromptSpy.mockRestore();
    buildSubagentRegistriesSpy.mockRestore();
  });

  it.each([
    ['high', 'high'],
    ['none', 'none'],
    [1024, 'low'],
  ])(
    'passes fork skill effort=%s explicitly without rewriting the definition',
    async (effort, expectedEffort) => {
      const hookSystem = {
        registerSessionHook: vi.fn(),
        clearSessionHooks: vi.fn(),
      };
      Object.assign(mockConfig, {
        getHookSystem: vi.fn().mockReturnValue(hookSystem),
        getAgentRegistry: vi.fn().mockReturnValue(undefined),
        getToolRegistry: vi.fn().mockReturnValue({
          getAllTools: vi.fn().mockReturnValue([]),
        }),
        getPermissionMode: vi.fn().mockReturnValue('default'),
        setPermissionMode: vi.fn(),
      });
      const skillManager = mockConfig.getSkillManager();
      vi.mocked(skillManager.getSkill).mockReturnValue({
        name: 'effort-fork',
        description: 'fork w/ effort',
        location: '/path/effort-fork/SKILL.md',
        skillRoot: '/path/effort-fork',
        body: 'body',
        context: 'fork',
        effort: effort as EffortValue,
      });
      vi.mocked(skillManager.getSkills).mockReturnValue([
        skillManager.getSkill('effort-fork')!,
      ]);

      const buildSubagentRegistriesSpy = vi
        .spyOn(agentSetup, 'buildSubagentRegistries')
        .mockResolvedValueOnce({
          toolRegistry: { getAllTools: vi.fn().mockReturnValue([]) },
          toolBridge: { execute: vi.fn(), dispose: vi.fn() },
          schedulerContext: { config: mockConfig },
        } as never);
      const buildSubagentSystemPromptSpy = vi
        .spyOn(agentSetup, 'buildSubagentSystemPrompt')
        .mockResolvedValueOnce(systemPromptFromText('system prompt'));
      const runSubagentSpy = vi
        .spyOn(runSubagentModule, 'runSubagent')
        .mockResolvedValueOnce({
          messages: [],
          totalUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          textContent: 'done',
        } as never);

      const toolWithFork = new ActivateSkillTool(mockConfig);
      const invocation = toolWithFork.build({ skill: 'effort-fork' });
      await invocation.execute(new AbortController().signal);

      expect(runSubagentSpy).toHaveBeenCalledTimes(1);
      const callArg = runSubagentSpy.mock.calls[0][0];
      expect(callArg.definition.effort).toBeUndefined();
      expect(callArg.definition[RESOLVED_AGENT_REASONING]).toBeUndefined();
      expect(callArg.querySelection).toEqual({
        config: { reasoning: { effort: expectedEffort } },
      });

      runSubagentSpy.mockRestore();
      buildSubagentSystemPromptSpy.mockRestore();
      buildSubagentRegistriesSpy.mockRestore();
    },
  );

});
