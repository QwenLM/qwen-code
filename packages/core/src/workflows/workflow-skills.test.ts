/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { createEmptyLoadedSettings } from '../test-utils/config.js';
import * as fs from 'node:fs/promises';
import baseline from './__fixtures__/cc-2.1.260-prompts.json' with { type: 'json' };
import type { WorkflowRegistryEntry } from './workflow-types.js';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config } from '../config/config.js';
import { setConfigHomeDirOverride } from '../utils/paths.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { WorkflowTool } from './workflow-tool.js';
import { ActivateSkillTool } from '../tools/activate-skill.js';
import {
  createAttachmentContext,
  getAttachmentMessages,
} from '../attachments/get-attachments.js';
import { normalizeAttachmentForAPI } from '../attachments/normalize.js';
import { restoreAttachment } from '../attachments/transcript-conversion.js';
import {
  getSkillListingAttachments,
  getSkillListingConfig,
} from '../attachments/generators/skill-generators.js';
import { getProjectWorkflowsDir } from './workflow-storage.js';
import {
  WorkflowRegistry,
  createWorkflowRegistryFromConfig,
} from './workflow-registry.js';
import {
  buildWorkflowCommandPrompt,
  getModelVisibleSkillsForTools,
  isWorkflowSkill,
  workflowToSkill,
} from './workflow-skills.js';

describe('saved Workflow discovery through Skill', () => {
  let directory: string;
  let config: Config;
  let registry: ToolRegistry;
  const names = ['Skill', 'Workflow'];
  const script = (name: string, description = name) =>
    `export const meta = { name: ${JSON.stringify(name)}, description: ${JSON.stringify(description)} }; return 42;`;
  const write = async (dir: string, name: string, description?: string) => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, name + '.js'), script(name, description));
  };
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workflow-skills-'));
    setConfigHomeDirOverride(path.join(directory, 'config'));
    config = new Config({
      loadedSettings: createEmptyLoadedSettings(),
      sessionId: 'test',
      targetDir: directory,
      cwd: directory,
      debugMode: false,
      model: 'test',
      interactive: true,
    });
    registry = new ToolRegistry(config, true);
    registry.registerTool(new ActivateSkillTool(config));
    registry.registerTool(new WorkflowTool(config));
    vi.spyOn(config, 'getToolRegistry').mockReturnValue(registry);
    config
      .getSkillManager()
      .setEnabledBuiltinSkills(['workflow-authoring', 'deep-research']);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    setConfigHomeDirOverride(undefined);
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('anchors Workflow Skill resources to the original project while running in a Worktree', () => {
    const worktreeCwd = path.join(directory, '.qwen', 'worktrees', 'feature');
    config.setWorktreeSettings({
      name: 'feature',
      path: worktreeCwd,
      worktreeCwd,
      baseSha: 'base',
      lifecycle: 'attached',
      originalCwd: directory,
    });
    config.setTargetDir(worktreeCwd);

    const skill = workflowToSkill(
      {
        name: 'audit',
        description: 'Audit workflow',
        source: 'project',
      },
      config,
    );

    expect(skill.skillRoot).toBe(directory);
  });

  it('keeps more than 20 names under budget and exposes them only as meta user discovery messages', async () => {
    for (let i = 0; i < 25; i++)
      await write(
        getProjectWorkflowsDir(directory),
        `audit-${i}`,
        'Long description '.repeat(30),
      );
    await config.getSkillManager().discoverSkills({ config });
    const skills = getModelVisibleSkillsForTools(config, names)!;
    const ctx = createAttachmentContext(directory);
    const listingConfig = {
      preserveNames: true,
      contextWindowTokens: 100,
      budgetFraction: 0.01,
    };
    const [listing] = await getSkillListingAttachments(
      ctx,
      skills,
      true,
      listingConfig,
    );
    for (const skill of skills)
      expect(listing.content).toContain(`- ${skill.name}`);
    expect(
      listing.names.filter((name) => name.startsWith('audit-')),
    ).toHaveLength(25);
    expect(listing.content).not.toContain('(truncated by budget)');
    expect(listing.content).toContain('workflow-authoring:');
    const messages = await getAttachmentMessages(
      null,
      createAttachmentContext(directory),
      [],
      skills,
      { skillListingConfig: listingConfig },
    );
    const discovery = messages.find((message) =>
      JSON.stringify(message).includes('audit-24'),
    )!;
    expect(discovery.type).toBe('attachment');
    expect(
      normalizeAttachmentForAPI(restoreAttachment(discovery.attachment)!)[0]
        .role,
    ).toBe('user');
    expect(getModelVisibleSkillsForTools(config, ['Workflow'])).toBeNull();
    expect(
      getModelVisibleSkillsForTools(config, ['Skill'])!.some(isWorkflowSkill),
    ).toBe(true);
    expect(listing.content).not.toContain('(dynamic workflow)');
  });

  it('loads a saved workflow through the real Skill tool using the native command template', async () => {
    await write(
      getProjectWorkflowsDir(directory),
      'audit',
      'Audit the repository',
    );
    await config.getSkillManager().discoverSkills({ config });
    const result = await registry
      .getTool('Skill')!
      .build({ skill: 'audit', args: ' src ' })
      .execute(new AbortController().signal);
    expect(result.error).toBeUndefined();
    expect(result.newMessages).toEqual([
      {
        role: 'user',
        isMeta: true,
        content:
          'Run the "audit" workflow.\n\nAudit the repository\n\nInvoke: Workflow({ name: "audit", args: "src" })\n\nIf the user asks you to modify this workflow or write a new script, load the `workflow-authoring` skill first.',
      },
    ]);
    const skill = config.getSkillManager().getSkill('audit');
    expect(isWorkflowSkill(skill)).toBe(true);
    const noGuide = await skill!.getBody!('', {
      skillDir: directory,
      sessionId: 'test',
      toolNames: ['Workflow'],
    } as never);
    expect(noGuide).not.toContain('workflow-authoring');
    expect(noGuide).not.toContain('Base directory');
  });

  it('uses file Skill > Workflow > plugin/bundled precedence and refreshes additions/deletions', async () => {
    await write(getProjectWorkflowsDir(directory), 'audit', 'Project version');
    await write(
      path.join(directory, 'config', 'workflows'),
      'audit',
      'User version',
    );
    const manager = config.getSkillManager();
    await manager.discoverSkills({ config });
    expect(manager.getSkill('audit')?.description).toBe('Project version');
    const fileSkill = {
      name: 'audit',
      description: 'File Skill',
      body: 'File instructions',
      source: 'user' as const,
      location: '/test/SKILL.md',
      skillRoot: '/test',
    };
    await manager.discoverSkills({ config, resourceSkills: [fileSkill] });
    expect(manager.getSkill('audit')).toMatchObject(fileSkill);
    expect(
      manager.getDisplayableSkills().filter((s) => s.name === 'audit'),
    ).toHaveLength(1);
    expect(isWorkflowSkill(manager.getSkill('audit'))).toBe(false);
    await fs.unlink(path.join(getProjectWorkflowsDir(directory), 'audit.js'));
    await write(getProjectWorkflowsDir(directory), 'new-workflow');
    await manager.discoverSkills({ config });
    expect(manager.getSkill('audit')?.description).toBe('User version');
    expect(manager.getSkill('new-workflow')).toBeDefined();
    await fs.unlink(path.join(directory, 'config', 'workflows', 'audit.js'));
    await manager.discoverSkills({ config });
    expect(manager.getSkill('audit')).toBeNull();
  });

  it('applies source filtering before resolving same-name workflows', async () => {
    await write(getProjectWorkflowsDir(directory), 'audit', 'Project version');
    await write(
      path.join(directory, 'config', 'workflows'),
      'audit',
      'User version',
    );
    vi.spyOn(config, 'isAgentSourceAllowed').mockImplementation(
      (source) => source !== 'project',
    );
    await config
      .getSkillManager()
      .discoverSkills({ config, allowedSources: ['user'] });
    expect(config.getSkillManager().getSkill('audit')?.source).toBe('user');
    expect(
      (await createWorkflowRegistryFromConfig(config).resolve('audit')).script,
    ).toContain('User version');
  });

  it('shares disabled, name-only, allowlist and explicit-only semantics with ordinary Skills', async () => {
    await write(getProjectWorkflowsDir(directory), 'audit');
    const manager = config.getSkillManager();
    await manager.discoverSkills({ config });
    manager.setSkillVisibilityOverrides({ audit: 'name-only' });
    expect(
      getModelVisibleSkillsForTools(config, names)!.map((s) => s.name),
    ).toContain('audit');
    manager.setSessionSkillAllowlist(['workflow-authoring']);
    expect(
      getModelVisibleSkillsForTools(config, names)!.map((s) => s.name),
    ).not.toContain('audit');
    expect(
      getModelVisibleSkillsForTools(config, names, {
        isMainSession: false,
      })!.map((s) => s.name),
    ).toContain('audit');
    manager.setSessionSkillAllowlist(undefined);
    manager.setSkillVisibilityOverrides({ audit: 'user-invocable-only' });
    expect(manager.getModelVisibleSkills().map((s) => s.name)).not.toContain(
      'audit',
    );
    expect(manager.getDisplayableSkills().map((s) => s.name)).toContain(
      'audit',
    );
    manager.setDisabledSkills(['audit']);
    expect(manager.getModelVisibleSkills().map((s) => s.name)).not.toContain(
      'audit',
    );
    const listed = await new WorkflowRegistry({
      projectRoot: directory,
      builtInWorkflows: [
        { script: script('manual'), disableModelInvocation: true },
      ],
    }).listAvailable();
    manager.addSkills([
      workflowToSkill(listed.entries.find((e) => e.name === 'manual')!, config),
    ]);
    expect(manager.getModelVisibleSkills().map((s) => s.name)).not.toContain(
      'manual',
    );
    expect(manager.getDisplayableSkills().map((s) => s.name)).toContain(
      'manual',
    );
  });

  it.each(['on', 'name-only', 'user-invocable-only', 'off'] as const)(
    'ignores %s visibility for plugin Skills and Workflows on every Workflow surface',
    async (override) => {
      const manager = config.getSkillManager();
      manager.setEnabledBuiltinSkills([]);
      const pluginWorkflow = workflowToSkill(
        {
          name: 'example:audit',
          description: 'Audit workflow',
          source: 'plugin',
        },
        config,
      );
      const pluginSkill = {
        name: 'example:inspect',
        description: 'Inspect files',
        body: 'Inspect carefully.',
        source: 'plugin' as const,
        location: path.join(directory, 'SKILL.md'),
        skillRoot: directory,
      };
      const projectSkill = {
        ...pluginSkill,
        name: 'inspect',
        source: 'project' as const,
      };
      const resourceSkills = [pluginWorkflow, pluginSkill, projectSkill];
      await manager.discoverSkills({ config, resourceSkills });
      const overrides = {
        'example:audit': override,
        inspect: override,
      };
      manager.setSkillVisibilityOverrides(overrides);
      vi.spyOn(config, 'getSkillVisibilityOverrides').mockReturnValue(
        overrides,
      );

      expect(manager.getSkillVisibilityOverride('example:audit')).toBe('on');
      expect(manager.getSkillVisibilityOverride('example:inspect')).toBe('on');
      expect(manager.getSkillVisibilityOverride('inspect')).toBe(override);
      const visible = getModelVisibleSkillsForTools(config, names)!.filter(
        (skill) => resourceSkills.some((entry) => entry.name === skill.name),
      );
      expect(visible.map((skill) => skill.name)).toEqual(
        override === 'off' || override === 'user-invocable-only'
          ? ['example:audit', 'example:inspect']
          : ['example:audit', 'example:inspect', 'inspect'],
      );
      const [listing] = await getSkillListingAttachments(
        createAttachmentContext(directory),
        visible,
        true,
        await getSkillListingConfig(config),
      );
      expect(listing.content).toContain('- example:audit: Audit workflow');
      expect(listing.content).toContain('- example:inspect: Inspect files');
      if (override === 'name-only') {
        expect(listing.content.split('\n')).toContain('- inspect');
      }
      const result = await registry
        .getTool('Skill')!
        .build({ skill: 'example:audit' })
        .execute(new AbortController().signal);
      expect(result.error).toBeUndefined();
      expect(JSON.stringify(result.newMessages)).toContain('Audit workflow');
    },
  );

  it('resolves the winning source after refresh and preserves plugin disable gates', async () => {
    const manager = config.getSkillManager();
    const skill = workflowToSkill(
      {
        name: 'example:audit',
        description: 'Audit workflow',
        source: 'plugin',
      },
      config,
    );
    manager.setSkillVisibilityOverrides({ [skill.name]: 'off' });
    await manager.discoverSkills({ config, resourceSkills: [skill] });
    expect(manager.getSkillVisibilityOverride(skill.name)).toBe('on');
    await manager.discoverSkills({
      config,
      resourceSkills: [{ ...skill, source: 'project' }],
    });
    expect(manager.getSkillVisibilityOverride(skill.name)).toBe('off');
    await manager.discoverSkills({ config, resourceSkills: [skill] });
    expect(manager.getSkillVisibilityOverride(skill.name)).toBe('on');

    const visible = () =>
      getModelVisibleSkillsForTools(config, names)?.map((entry) => entry.name);
    manager.setSessionSkillAllowlist([]);
    expect(visible()).not.toContain(skill.name);
    expect(
      getModelVisibleSkillsForTools(config, names, { isMainSession: false }),
    ).toContainEqual(expect.objectContaining({ name: skill.name }));
    manager.setSessionSkillAllowlist(undefined);
    manager.setDisabledSkills([skill.name]);
    expect(visible()).not.toContain(skill.name);
    const disabledResult = await registry
      .getTool('Skill')!
      .build({ skill: skill.name })
      .execute(new AbortController().signal);
    expect(disabledResult.error).toBeDefined();
    manager.setDisabledSkills([]);
    await manager.discoverSkills({
      config,
      resourceSkills: [{ ...skill, disableModelInvocation: true }],
    });
    expect(visible()).not.toContain(skill.name);
    const explicitOnlyResult = await registry
      .getTool('Skill')!
      .build({ skill: skill.name })
      .execute(new AbortController().signal);
    expect(explicitOnlyResult.error).toBeDefined();
    manager.setAdminSettings(false);
    expect(getModelVisibleSkillsForTools(config, names)).toBeNull();
  });

  it('matches all native named templates, including empty phases and quoted args', () => {
    for (const fixture of baseline.named) {
      expect(
        buildWorkflowCommandPrompt(
          fixture.entry as WorkflowRegistryEntry,
          fixture.args,
          fixture.available,
        ),
      ).toBe(fixture.text);
    }
  });

  it('keeps the optional args schema extension out of workflows that do not declare it', () => {
    const entry = {
      name: 'audit',
      description: 'Audit',
      source: 'project' as const,
      whenToUse: 'Review a patch',
      phases: [{ title: 'Review', detail: 'Check changes' }],
    };
    const prompt = buildWorkflowCommandPrompt(entry, '', false);
    expect(prompt).toBe(
      'Run the "audit" workflow.\n\nAudit\n\nReview a patch\n\nPhases:\n- Review: Check changes\n\nInvoke: Workflow({ name: "audit" })',
    );
    const schema = { type: 'string' };
    expect(
      buildWorkflowCommandPrompt({ ...entry, inputSchema: schema }, '', false),
    ).toBe(
      prompt.replace(
        '\n\nInvoke:',
        `\n\nArgs schema: ${JSON.stringify(schema)}\n\nInvoke:`,
      ),
    );
  });
});
