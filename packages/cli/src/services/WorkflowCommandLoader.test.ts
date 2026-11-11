/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createEmptyLoadedSettings } from '@qwen-code/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  Config,
  ToolRegistry,
  WorkflowTool,
  ActivateSkillTool,
  buildWorkflowCommandPrompt,
  setConfigHomeDirOverride,
} from '@qwen-code/core';
import { SkillCommandLoader } from './SkillCommandLoader.js';
import { CommandKind } from '../ui/commands/types.js';
import { WorkflowCommandLoader } from './WorkflowCommandLoader.js';

describe('WorkflowCommandLoader', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-command-'));
    setConfigHomeDirOverride(path.join(tmpDir, 'config'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setConfigHomeDirOverride(undefined);
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('loads saved workflows through Skill discovery and records slash usage', async () => {
    const projectRoot = path.join(tmpDir, 'project');
    const workflowsDir = path.join(projectRoot, '.qwen', 'workflows');
    await fs.mkdir(workflowsDir, { recursive: true });
    await fs.writeFile(
      path.join(workflowsDir, 'audit.js'),
      'export const meta = { name: "audit", description: "Audit repo" };',
    );

    const config = new Config({
      loadedSettings: createEmptyLoadedSettings(),
      sessionId: 'workflow-command-metadata',
      targetDir: projectRoot,
      cwd: projectRoot,
      debugMode: false,
      model: 'test-model',
    });
    vi.spyOn(config, 'isSkillsSupportEnabled').mockReturnValue(true);
    const registry = new ToolRegistry(config, true);
    registry.registerTool(new WorkflowTool(config));
    registry.registerTool(new ActivateSkillTool(config));
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    const manager = config.getSkillManager();
    manager.setEnabledBuiltinSkills(['workflow-authoring']);
    await manager.discoverSkills({ config });
    const loader = new WorkflowCommandLoader(config);

    const commands = await loader.loadCommands(new AbortController().signal);
    const command = commands.find((item) => item.name === 'audit');

    expect(command).toMatchObject({
      name: 'audit',
      description: 'Audit repo (dynamic workflow)',
      kind: CommandKind.WORKFLOW,
      hasUserSpecifiedDescription: true,
      progressMessage: 'running dynamic workflow',
      source: 'project',
      loadedFrom: 'skills',
      autoExecute: true,
      argumentHint: '[args]',
    });
    expect(command?.isSafeConcurrent).toBeUndefined();

    const result = await command?.action?.({} as never, 'src/core');
    expect(result).toEqual({
      type: 'submit_prompt',
      content: expect.stringContaining(
        'Invoke: Workflow({ name: "audit", args: "src/core" })',
      ),
    });
    expect(manager.getUsageScore('audit')).toBeGreaterThan(0);
  });

  it('builds a prompt without args for no-argument invocations', () => {
    expect(buildWorkflowCommandPrompt({
      name: 'audit',
      description: 'Audit repository changes',
      source: 'project',
    }, '   ')).toBe(
      'Run the "audit" workflow.\n\nAudit repository changes\n\nInvoke: Workflow({ name: "audit" })',
    );
  });

  it('expands existing metadata and preserves the slash args representation', () => {
    const entry = {
      name: 'audit',
      source: 'project' as const,
      description: 'Audit repository changes',
      whenToUse: 'Review a patch',
      phases: [{ title: 'Review', detail: 'Inspect changed files' }],
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
    };
    const prompt = buildWorkflowCommandPrompt(entry, '{"path":"src"}', true);
    expect(prompt).toContain('\n\nAudit repository changes');
    expect(prompt).toContain('\n\nReview a patch');
    expect(prompt).toContain('- Review: Inspect changed files');
    expect(prompt).toContain(
      `Args schema: ${JSON.stringify(entry.inputSchema)}`,
    );
    expect(prompt).toContain(
      'Invoke: Workflow({ name: "audit", args: "{\\"path\\":\\"src\\"}" })',
    );
    expect(prompt).toContain(
      'If the user asks you to modify this workflow or write a new script, load the `workflow-authoring` skill first.',
    );
    expect(buildWorkflowCommandPrompt(entry, '', false)).not.toContain(
      'load workflow-authoring',
    );
  });

  it('uses the same expanded command on every Workflow entry point', async () => {
    const config = new Config({
      loadedSettings: createEmptyLoadedSettings(), sessionId: 'cli-workflow-test', targetDir: tmpDir, cwd: tmpDir, debugMode: false, model: 'test-model', interactive: true });
    vi.spyOn(config, 'isSkillsSupportEnabled').mockReturnValue(true);
    const registry = new ToolRegistry(config, true);
    registry.registerTool(new WorkflowTool(config));
    registry.registerTool(new ActivateSkillTool(config));
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    const dir = path.join(tmpDir, '.qwen', 'workflows');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'audit.js'), 'export const meta = { name: "audit", description: "Audit" }; return 42;');
    const manager = config.getSkillManager();
    manager.setEnabledBuiltinSkills(['workflow-authoring']);
    await manager.discoverSkills({ config });
    const commands = await new WorkflowCommandLoader(config).loadCommands(new AbortController().signal);
    const command = commands.find(item => item.name === 'audit')!;
    const entry = { name: 'audit', description: 'Audit', source: 'project' as const };
    expect(await command.action!({} as never, 'the topic')).toEqual({ type: 'submit_prompt', content: buildWorkflowCommandPrompt(entry, 'the topic', true) });
    expect((await new SkillCommandLoader(config).loadCommands(new AbortController().signal)).map(item => item.name)).not.toContain('audit');
    await manager.discoverSkills({ config, resourceSkills: [{ name: 'audit', description: 'File Skill', body: 'Instructions', location: '/tmp/skill/SKILL.md', skillRoot: '/tmp/skill', source: 'user' }] });
    expect((await new WorkflowCommandLoader(config).loadCommands(new AbortController().signal)).map(item => item.name)).not.toContain('audit');
    expect((await new SkillCommandLoader(config).loadCommands(new AbortController().signal)).map(item => item.name).filter(name => name === 'audit')).toHaveLength(1);
  });

  it.each(['slash', 'Skill'] as const)(
    'shares persisted usage and minute deduplication when %s invokes the workflow first',
    async (first) => {
      const config = new Config({
        loadedSettings: createEmptyLoadedSettings(),
        sessionId: 'workflow-slash-usage',
        targetDir: tmpDir,
        cwd: tmpDir,
        debugMode: false,
        model: 'test-model',
        interactive: true,
      });
      vi.spyOn(config, 'isSkillsSupportEnabled').mockReturnValue(true);
      const registry = new ToolRegistry(config, true);
      registry.registerTool(new WorkflowTool(config));
      registry.registerTool(new ActivateSkillTool(config));
      vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
      const dir = path.join(tmpDir, '.qwen', 'workflows');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, 'audit.js'),
        'export const meta = { name: "audit", description: "Audit" }; return 42;',
      );
      const manager = config.getSkillManager();
      await manager.discoverSkills({ config });
      const signal = new AbortController().signal;
      const commands = await new WorkflowCommandLoader(config).loadCommands(
        signal,
      );
      const command = commands.find((item) => item.name === 'audit')!;
      const invoke = {
        slash: async () => {
          expect(await command.action!({} as never, '')).toMatchObject({
            type: 'submit_prompt',
            content: expect.stringContaining('Run the "audit" workflow.'),
          });
        },
        Skill: async () => {
          const result = await registry
            .getTool('Skill')!
            .build({ skill: 'audit' })
            .execute(signal);
          expect(result.error).toBeUndefined();
          expect(result.newMessages).toEqual([
            expect.objectContaining({
              content: expect.stringContaining('Run the "audit" workflow.'),
            }),
          ]);
        },
      };
      const usageFile = path.join(tmpDir, 'config', 'skill-usage.json');
      const readUsage = async () =>
        JSON.parse(await fs.readFile(usageFile, 'utf8'));
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      const second = first === 'slash' ? 'Skill' : 'slash';
      expect(manager.getUsageScore('audit')).toBe(0);

      await invoke[first]();
      expect(await readUsage()).toEqual({
        audit: { usageCount: 1, lastUsedAt: now },
      });
      expect(manager.getUsageScore('audit')).toBe(1);

      clock.mockReturnValue(now + 59_999);
      await invoke[second]();
      expect(await readUsage()).toEqual({
        audit: { usageCount: 1, lastUsedAt: now },
      });

      clock.mockReturnValue(now + 60_000);
      await invoke[second]();
      expect(await readUsage()).toEqual({
        audit: { usageCount: 2, lastUsedAt: now + 60_000 },
      });
      expect(manager.getUsageScore('audit')).toBe(2);
    },
  );

  it('exposes plugin workflow metadata on slash commands', async () => {
    const projectRoot = path.join(tmpDir, 'project');
    const pluginRoot = path.join(tmpDir, 'plugins', 'quality');
    const workflowsDir = path.join(pluginRoot, 'workflows');
    await fs.mkdir(workflowsDir, { recursive: true });
    await fs.writeFile(
      path.join(workflowsDir, 'audit.js'),
      `export const meta = {
        name: "audit",
        description: "Plugin audit",
        whenToUse: "Use for plugin audits"
      };`,
    );

    const loader = new WorkflowCommandLoader({
      getSkillManager: () => ({
        isAdminEnabled: () => true,
        getDisplayableSkills: () => [{
          workflow: {
            name: 'quality:audit',
            description: 'Plugin audit',
            whenToUse: 'Use for plugin audits',
            source: 'plugin',
            pluginName: 'quality',
          },
        }],
      }),
      getSessionArtifactProjectRoot: () => projectRoot,
      getEnabledPlugins: () => [
        {
          name: 'quality',
          path: pluginRoot,
          repository: 'marketplace',
          manifest: { name: 'quality', version: '1.0.0' },
        },
      ],
    } as never);

    const commands = await loader.loadCommands(new AbortController().signal);
    expect(
      commands.find((item) => item.name === 'quality:audit'),
    ).toMatchObject({
      name: 'quality:audit',
      description: 'Plugin audit (dynamic workflow)',
      whenToUse: 'Use for plugin audits',
      source: 'plugin',
      loadedFrom: 'plugin',
      workflow: {
        source: 'plugin',
        pluginName: 'quality',
        pluginRepository: 'marketplace',
        pluginPath: pluginRoot,
        pluginManifest: { name: 'quality', version: '1.0.0' },
      },
    });
  });
});
