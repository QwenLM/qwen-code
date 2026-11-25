/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createEmptyLoadedSettings } from '../test-utils/config.js';
import { systemPromptFromText } from '../prompts/system-prompt.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../config/config.js';
import { setConfigHomeDirOverride } from '../utils/paths.js';
import { createPermissionManager } from '../test-utils/config.js';
import { constrainAgentPermissions } from '../permissions/agent-tool-constraints.js';
import { ShellExecutionService } from '../services/shellExecutionService.js';
import { buildAutoApproveAgentContext } from '../agents/agent-context-factory.js';
import * as setup from '../agents/agent-setup.js';
import * as runner from '../agents/run-subagent.js';
import { ToolRegistry } from './tool-registry.js';
import { MockTool } from '../test-utils/mock-tool.js';
import {
  ActivateSkillTool,
  executeForkedSkillDirect,
} from './activate-skill.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';

describe('Skill activation within per-spawn constraints', () => {
  let directory: string;
  let config: Config;
  let root: AgentLoopContext;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'skill-constraints-'));
    setConfigHomeDirOverride(directory);
    config = new Config({
      loadedSettings: createEmptyLoadedSettings(),
      sessionId: 'skill-constraints',
      targetDir: directory,
      cwd: directory,
      model: 'test',
      debugMode: false,
    });
    const permission = createPermissionManager({
      cwd: directory,
      permissionMode: 'yolo',
      rules: { allow: {}, deny: { userSettings: ['Bash(git log)'] }, ask: {} },
      checkerDeps: {
        skill: {
          isAllowedForMainSession: () => true,
          isDisabled: () => false,
          hasOnlySafeProperties: () => false,
        },
        mcpCall: { isKnownTool: () => false, parseQualifiedName: () => ({}) },
      },
    });
    Object.defineProperty(config, 'permission', {
      value: permission,
      configurable: true,
    });
    const registry = new ToolRegistry(config, true);
    for (const name of ['Bash', 'Read', 'Write'])
      registry.registerTool(new MockTool({ name }));
    registry.registerTool(new ActivateSkillTool(config));
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    vi.spyOn(config, 'getAgentRegistry').mockReturnValue(undefined as never);
    root = {
      ...buildAutoApproveAgentContext(config, 'root'),
      permissionContext: undefined,
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setConfigHomeDirOverride(undefined);
    await rm(directory, { recursive: true, force: true });
  });

  it('inherits root denies for direct slash forks on every Workflow surface', async () => {
    const skill = {
      name: 'slash-fork',
      description: 'Probe',
      location: path.join(directory, 'SKILL.md'),
      skillRoot: directory,
      body: 'Report a result',
      context: 'fork' as const,
      allowedTools: ['Bash'],
    };
    config.getSkillManager().addSkills([skill]);
    const request = {
      toolName: 'Bash',
      input: { command: 'git log' },
      toolUseId: 'slash-fork',
    };
    const parentRules = structuredClone(root.permission!.getRules());
    expect((await root.permission!.check(request)).kind).toBe('deny');
    vi.spyOn(setup, 'buildSubagentSystemPrompt').mockResolvedValue(
      systemPromptFromText('system'),
    );
    const run = vi
      .spyOn(runner, 'runSubagent')
      .mockImplementation(async (params) => {
        const child = params.schedulerContext!;
        expect(child.agentDepth).toBe(1);
        expect(
          (await child.permission!.check(request, child.permissionContext?.()))
            .kind,
        ).toBe('deny');
        expect(
          (
            await child.permission!.check(
              { ...request, input: { command: 'git status' } },
              child.permissionContext?.(),
            )
          ).kind,
        ).toBe('allow');
        return { textContent: 'completed' } as never;
      });
    await expect(
      executeForkedSkillDirect(
        config,
        skill,
        undefined,
        new AbortController().signal,
      ),
    ).resolves.toBe('completed');
    expect(run).toHaveBeenCalledOnce();
    expect(root.permission!.getRules()).toEqual(parentRules);
    expect((await root.permission!.check(request)).kind).toBe('deny');
  });

  it('retains the caller registry and permission clamp across a real fork Skill setup', async () => {
    config.getSkillManager().addSkills([
      {
        name: 'fork-probe',
        description: 'Probe',
        location: path.join(directory, 'SKILL.md'),
        skillRoot: directory,
        body: 'Report a result',
        context: 'fork',
        allowedTools: ['Bash', 'Write'],
      },
    ]);
    const parent = await setup.buildSubagentRegistries(
      {
        kind: 'local',
        name: 'workflow-child',
        description: 'Probe',
        modelConfig: { model: 'inherit' },
        promptConfig: { systemPrompt: 'probe' },
      },
      root,
      'parent',
      {
        toolConstraints: {
          disallowedTools: ['Write'],
          bashCommandClamp: ['Bash(git:*)'],
        },
      },
    );
    try {
      vi.spyOn(setup, 'buildSubagentSystemPrompt').mockResolvedValue(
        systemPromptFromText('system'),
      );
      const run = vi
        .spyOn(runner, 'runSubagent')
        .mockImplementation(async (params) => {
          const child = params.schedulerContext!;
          expect(child.agentDepth).toBe(2);
          const names = params.toolRegistry
            .getSchema('test')
            .map((tool) => tool.name);
          expect(names).toContain('Bash');
          expect(names).not.toContain('Write');
          for (const command of ['ls', 'git status && ls', 'git log']) {
            expect(
              (
                await child.permission!.check(
                  { toolName: 'Bash', input: { command }, toolUseId: 'probe' },
                  child.permissionContext?.(),
                )
              ).kind,
            ).toBe('deny');
          }
          expect(
            (
              await child.permission!.check(
                { toolName: 'Write', input: {}, toolUseId: 'probe' },
                child.permissionContext?.(),
              )
            ).kind,
          ).toBe('deny');
          expect(
            (
              await child.permission!.check(
                {
                  toolName: 'Bash',
                  input: { command: 'git status' },
                  toolUseId: 'probe',
                },
                child.permissionContext?.(),
              )
            ).kind,
          ).toBe('allow');
          return { textContent: 'completed' } as never;
        });
      const result = await parent.toolRegistry
        .getTool('Skill')!
        .build({ skill: 'fork-probe' }).executeWithContext!({
        signal: new AbortController().signal,
        toolCallScopeId: 'workflow-child',
        agentLoopContext: parent.schedulerContext,
      });
      expect(result.error).toBeUndefined();
      expect(run).toHaveBeenCalledOnce();
      expect(root.toolRegistry.getTool('Write')).toBeDefined();
      expect(
        (
          await root.permission!.check({
            toolName: 'Bash',
            input: { command: 'ls' },
            toolUseId: 'root',
          })
        ).kind,
      ).toBe('allow');
    } finally {
      parent.toolRegistry.dispose?.();
    }
  });

  it.each(['inline', 'fork', 'powershell'] as const)(
    'blocks %s shell preprocessing before execution despite Skill allowedTools',
    async (mode) => {
      const permission = constrainAgentPermissions(
        root.permission!,
        ['PowerShell'],
        ['Bash(git:*)'],
      );
      config.getSkillManager().addSkills([
        {
          name: 'preamble',
          description: 'Probe',
          location: path.join(directory, 'SKILL.md'),
          skillRoot: directory,
          body: 'Result: !`printf should-not-execute`',
          allowedTools: ['Bash', 'PowerShell'],
          ...(mode === 'fork' ? { context: 'fork' as const } : {}),
          ...(mode === 'powershell' ? { shell: 'powershell' as const } : {}),
        },
      ]);
      const shell = vi.spyOn(ShellExecutionService, 'execute');
      const activation = new ActivateSkillTool(config).build({
        skill: 'preamble',
      }).executeWithContext!({
        signal: new AbortController().signal,
        agentLoopContext: { ...root, permission },
      });
      if (mode === 'fork') {
        expect((await activation).error?.message).toContain(
          'permission denied',
        );
      } else {
        await expect(activation).rejects.toThrow('permission denied');
      }
      expect(shell).not.toHaveBeenCalled();
    },
  );

  it('inherits the caller integration fork context for skill subagents', async () => {
    config.getSkillManager().addSkills([
      {
        name: 'legacy-fork',
        description: 'Probe',
        location: path.join(directory, 'SKILL.md'),
        skillRoot: directory,
        body: 'Report a result',
        context: 'fork',
        allowedTools: ['Bash', 'Write'],
      },
    ]);
    const parentPermission = constrainAgentPermissions(
      root.permission!,
      ['Write'],
      ['Bash(git:*)'],
    );
    vi.spyOn(setup, 'buildSubagentSystemPrompt').mockResolvedValue(
      systemPromptFromText('system'),
    );
    const run = vi
      .spyOn(runner, 'runSubagent')
      .mockImplementation(async (params) => {
        const child = params.schedulerContext!;
        expect(child.agentDepth).toBe(1);
        expect(child.permission).not.toBe(parentPermission);
        expect(child.toolRegistry.getTool('Write')).toBeDefined();
        return { textContent: 'completed' } as never;
      });
    const result = await new ActivateSkillTool(config).build({
      skill: 'legacy-fork',
    }).executeWithContext!({
      signal: new AbortController().signal,
      toolCallScopeId: 'integration-child',
      agentLoopContext: {
        ...root,
        agentDepth: 3,
        permission: parentPermission,
        toolRegistry: new ToolRegistry(config, true),
      },
    });
    expect(result.error).toBeUndefined();
    expect(run).toHaveBeenCalledOnce();
    expect(config.getSkillManager().getUsageScore('legacy-fork')).toBe(0);
  });

  it('executes a permitted preamble through the same real permission path', async () => {
    const command = 'printf workflow-clamp-permitted';
    const permission = constrainAgentPermissions(
      root.permission!,
      [],
      [`Bash(${command})`],
    );
    config.getSkillManager().addSkills([
      {
        name: 'preamble',
        description: 'Probe',
        location: path.join(directory, 'SKILL.md'),
        skillRoot: directory,
        body: 'Result: !`' + command + '`',
        allowedTools: ['Bash'],
      },
    ]);
    const result = await new ActivateSkillTool(config).build({
      skill: 'preamble',
    }).executeWithContext!({
      signal: new AbortController().signal,
      agentLoopContext: { ...root, permission },
    });
    expect(result.newMessages?.[0].content).toContain(
      'Result: workflow-clamp-permitted',
    );
  });
});
