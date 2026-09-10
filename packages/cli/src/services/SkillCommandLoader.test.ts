/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  recordAutoSkillCommandUsage,
  SkillCommandLoader,
} from './SkillCommandLoader.js';
import { skillArgsPath } from './skill-args-file.js';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandKind, type CommandContext } from '../ui/commands/types.js';
import {
  buildSkillLlmContent,
  HookEventName,
  HookType,
  type Config,
  type SkillConfig,
} from '@qwen-code/qwen-code-core';

const recordAutoSkillUsageMock = vi.hoisted(() => vi.fn());
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/qwen-code-core')>()),
  recordAutoSkillUsage: recordAutoSkillUsageMock,
}));

function makeSkill(overrides: Partial<SkillConfig> = {}): SkillConfig {
  return {
    name: 'my-skill',
    description: 'My skill description',
    level: 'user',
    filePath: '/tmp/qwen-test/skills/my-skill/SKILL.md',
    body: 'Skill body content.',
    ...overrides,
  };
}

function makeSkillPrompt(body: string): string {
  return buildSkillLlmContent('/tmp/qwen-test/skills/my-skill', body);
}

describe('SkillCommandLoader', () => {
  let mockConfig: Config;
  let mockSkillManager: { listSkills: ReturnType<typeof vi.fn> };
  let mockAddSessionAllowRule: ReturnType<typeof vi.fn>;
  let mockAddSessionHook: ReturnType<typeof vi.fn>;
  let mockSessionHooksManager: {
    addSessionHook: ReturnType<typeof vi.fn>;
    getHooksForEvent: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockAddSessionHook = vi.fn();
    mockSessionHooksManager = {
      addSessionHook: mockAddSessionHook,
      getHooksForEvent: vi.fn().mockReturnValue([]),
    };
    mockSkillManager = {
      listSkills: vi.fn().mockResolvedValue([]),
    };
    mockAddSessionAllowRule = vi.fn();
    mockConfig = {
      getSkillManager: vi.fn().mockReturnValue(mockSkillManager),
      getBareMode: vi.fn().mockReturnValue(false),
      getProjectRoot: vi.fn().mockReturnValue('/test/project'),
      getAutoSkillEnabled: vi.fn().mockReturnValue(true),
      getPermissionManager: vi
        .fn()
        .mockReturnValue({ addSessionAllowRule: mockAddSessionAllowRule }),
      isTrustedFolder: vi.fn().mockReturnValue(true),
      // A live-looking hook system by default (session id + session hooks
      // manager): the frontmatter-hooks describe blocks assert registration
      // directly, and any test that needs hooks disabled overrides
      // getHookSystem itself.
      // SkillCommandLoader filters via this. Default to empty so existing
      // assertions about "all skills surface" stay true; per-test cases
      // override to verify the filter behavior.
      getDisabledSkillNames: vi.fn().mockReturnValue(new Set<string>()),
      isSkillEnabled: vi.fn(
        (skill: SkillConfig) =>
          !mockConfig.getDisabledSkillNames().has(skill.name.toLowerCase()),
      ),
      getSessionId: vi.fn().mockReturnValue('session-1'),
      getHookSystem: vi.fn().mockReturnValue({
        getSessionHooksManager: () => mockSessionHooksManager,
      }),
    } as unknown as Config;
  });

  const signal = new AbortController().signal;

  it('should return empty array when config is null', async () => {
    const loader = new SkillCommandLoader(null);
    expect(await loader.loadCommands(signal)).toEqual([]);
  });

  it('should return empty array when SkillManager is not available', async () => {
    const config = {
      getSkillManager: vi.fn().mockReturnValue(null),
      getBareMode: vi.fn().mockReturnValue(false),
    } as unknown as Config;
    const loader = new SkillCommandLoader(config);
    expect(await loader.loadCommands(signal)).toEqual([]);
  });

  it('should return empty array in bare mode', async () => {
    (mockConfig.getBareMode as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const loader = new SkillCommandLoader(mockConfig);
    expect(await loader.loadCommands(signal)).toEqual([]);
    expect(mockSkillManager.listSkills).not.toHaveBeenCalled();
  });

  it('should propagate argumentHint from skills to slash commands', async () => {
    const skill = makeSkill({ argumentHint: '[topic]' });
    mockSkillManager.listSkills.mockImplementation(
      ({ level }: { level: string }) =>
        Promise.resolve(level === 'user' ? [skill] : []),
    );

    const loader = new SkillCommandLoader(mockConfig);
    const commands = await loader.loadCommands(signal);

    expect(commands[0]?.argumentHint).toBe('[topic]');
  });

  it('should default skills to user-invocable slash commands', async () => {
    const skill = makeSkill();
    mockSkillManager.listSkills.mockImplementation(
      ({ level }: { level: string }) =>
        Promise.resolve(level === 'user' ? [skill] : []),
    );

    const loader = new SkillCommandLoader(mockConfig);
    const commands = await loader.loadCommands(signal);

    expect(commands[0]?.userInvocable).toBe(true);
  });

  it('should propagate userInvocable from skills to slash commands', async () => {
    const skill = makeSkill({ userInvocable: false });
    mockSkillManager.listSkills.mockImplementation(
      ({ level }: { level: string }) =>
        Promise.resolve(level === 'user' ? [skill] : []),
    );

    const loader = new SkillCommandLoader(mockConfig);
    const commands = await loader.loadCommands(signal);

    expect(commands[0]?.userInvocable).toBe(false);
    expect(commands[0]?.modelInvocable).toBe(true);
  });

  it('should query user, project, and extension levels', async () => {
    const loader = new SkillCommandLoader(mockConfig);
    await loader.loadCommands(signal);
    expect(mockSkillManager.listSkills).toHaveBeenCalledWith({ level: 'user' });
    expect(mockSkillManager.listSkills).toHaveBeenCalledWith({
      level: 'project',
    });
    expect(mockSkillManager.listSkills).toHaveBeenCalledWith({
      level: 'extension',
    });
  });

  it('should load user skill as slash command with correct properties', async () => {
    const skill = makeSkill({ level: 'user' });
    mockSkillManager.listSkills.mockImplementation(
      ({ level }: { level: string }) =>
        Promise.resolve(level === 'user' ? [skill] : []),
    );

    const loader = new SkillCommandLoader(mockConfig);
    const commands = await loader.loadCommands(signal);

    expect(commands).toHaveLength(1);
    const cmd = commands[0];
    expect(cmd.name).toBe('my-skill');
    expect(cmd.description).toBe('My skill description');
    expect(cmd.kind).toBe(CommandKind.SKILL);
    expect(cmd.source).toBe('skill-dir-command');
    expect(cmd.sourceLabel).toBe('User');
    expect(cmd.sourceDetail).toBe('user');
    expect(cmd.modelInvocable).toBe(true);
  });

  it('does not propagate skill.priority to completionPriority', async () => {
    // Priority is scoped to the `/skills` listing only; slash-completion /
    // `/help` ordering should be independent of any skill's priority value.
    const skill = makeSkill({ level: 'user', priority: 42 });
    mockSkillManager.listSkills.mockImplementation(
      ({ level }: { level: string }) =>
        Promise.resolve(level === 'user' ? [skill] : []),
    );

    const loader = new SkillCommandLoader(mockConfig);
    const commands = await loader.loadCommands(signal);

    expect(commands[0].completionPriority).toBeUndefined();
  });

  it('should load project skill with sourceLabel "Project"', async () => {
    const skill = makeSkill({ level: 'project' });
    mockSkillManager.listSkills.mockImplementation(
      ({ level }: { level: string }) =>
        Promise.resolve(level === 'project' ? [skill] : []),
    );

    const loader = new SkillCommandLoader(mockConfig);
    const commands = await loader.loadCommands(signal);

    expect(commands[0].sourceLabel).toBe('Project');
    expect(commands[0].sourceDetail).toBe('project');
    expect(commands[0].source).toBe('skill-dir-command');
    expect(commands[0].modelInvocable).toBe(true);
    expect(commands[0].skillDetail?.filePath).toBe(skill.filePath);

    await recordAutoSkillCommandUsage(mockConfig, commands[0]);
    expect(recordAutoSkillUsageMock).toHaveBeenCalledWith('/test/project', {
      name: 'my-skill',
      level: 'project',
      filePath: skill.filePath,
    });
  });

  it('records curator usage while Auto Skill generation is disabled', async () => {
    vi.mocked(mockConfig.getAutoSkillEnabled).mockReturnValue(false);

    await recordAutoSkillCommandUsage(mockConfig, {
      name: 'my-skill',
      description: 'My skill',
      kind: CommandKind.SKILL,
      skillDetail: {
        name: 'my-skill',
        level: 'project',
        filePath: '/test/project/.qwen/skills/auto-skill-test/SKILL.md',
      },
    });

    expect(recordAutoSkillUsageMock).toHaveBeenCalledWith('/test/project', {
      name: 'my-skill',
      level: 'project',
      filePath: '/test/project/.qwen/skills/auto-skill-test/SKILL.md',
    });
  });

  it.each([
    {
      caseName: 'user-level skills',
      skillDetail: {
        name: 'my-skill',
        level: 'user',
        filePath: '/test/user/.qwen/skills/my-skill/SKILL.md',
      },
    },
    {
      caseName: 'skills without a file path',
      skillDetail: {
        name: 'my-skill',
        level: 'project',
      },
    },
  ])('does not record curator usage for $caseName', async ({ skillDetail }) => {
    await recordAutoSkillCommandUsage(mockConfig, {
      name: 'my-skill',
      description: 'My skill',
      kind: CommandKind.SKILL,
      skillDetail,
    });

    expect(recordAutoSkillUsageMock).not.toHaveBeenCalled();
  });

  it('keeps usage recording best-effort when persistence fails', async () => {
    recordAutoSkillUsageMock.mockRejectedValueOnce(new Error('lock busy'));

    await expect(
      recordAutoSkillCommandUsage(mockConfig, {
        name: 'my-skill',
        description: 'My skill',
        kind: CommandKind.SKILL,
        skillDetail: {
          name: 'my-skill',
          level: 'project',
          filePath: '/test/project/.qwen/skills/auto-skill-test/SKILL.md',
        },
      }),
    ).resolves.toBeUndefined();
  });

  describe('project skill allowedTools require a trusted folder', () => {
    async function runProjectSkill(): Promise<void> {
      const skill = makeSkill({
        level: 'project',
        allowedTools: ['Bash(curl *)', 'Write'],
      });
      mockSkillManager.listSkills.mockImplementation(
        ({ level }: { level: string }) =>
          Promise.resolve(level === 'project' ? [skill] : []),
      );
      const loader = new SkillCommandLoader(mockConfig);
      const commands = await loader.loadCommands(signal);
      await commands[0].action!(
        { invocation: { raw: '/my-skill', args: '' } } as never,
        '',
      );
    }

    it('grants no session allow rules in an untrusted folder', async () => {
      vi.mocked(mockConfig.isTrustedFolder).mockReturnValue(false);
      await runProjectSkill();
      expect(mockAddSessionAllowRule).not.toHaveBeenCalled();
    });

    it('grants them in a trusted folder — marked trust-gated for the live revocation check', async () => {
      vi.mocked(mockConfig.isTrustedFolder).mockReturnValue(true);
      await runProjectSkill();
      expect(mockAddSessionAllowRule).toHaveBeenCalledTimes(2);
      // Exactly `{ trustGated: true }`: suspension keys solely off the
      // flag, so a `/my-skill`-invoked project skill whose grants shipped
      // ungated would silently escape the mid-session revocation.
      expect(mockAddSessionAllowRule).toHaveBeenNthCalledWith(
        1,
        'Bash(curl *)',
        { trustGated: true },
      );
      expect(mockAddSessionAllowRule).toHaveBeenNthCalledWith(2, 'Write', {
        trustGated: true,
      });
    });
  });

  it('should submit skill body as prompt', async () => {
    const skill = makeSkill();
    mockSkillManager.listSkills.mockImplementation(
      ({ level }: { level: string }) =>
        Promise.resolve(level === 'user' ? [skill] : []),
    );

    const loader = new SkillCommandLoader(mockConfig);
    const commands = await loader.loadCommands(signal);
    const result = await commands[0].action!(
      { invocation: { raw: '/my-skill', args: '' } } as never,
      '',
    );

    expect(result).toEqual({
      type: 'submit_prompt',
      content: [{ text: makeSkillPrompt('Skill body content.') }],
    });
  });

  it('should append raw invocation when args are provided', async () => {
    // The args file is written relative to the process's directory; without a
    // temp cwd this suite would write into the real repository.
    const dir = mkdtempSync(join(tmpdir(), 'skill-cmd-args-'));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const skill = makeSkill();
      mockSkillManager.listSkills.mockResolvedValue([skill]);

      const loader = new SkillCommandLoader(mockConfig);
      const commands = await loader.loadCommands(signal);
      const result = (await commands[0].action!(
        { invocation: { raw: '/my-skill hello', args: 'hello' } } as never,
        'hello',
      )) as { type: string; content: Array<{ text: string }> };

      expect(result.type).toBe('submit_prompt');
      const text = result.content[0].text;
      expect(text).toContain('/my-skill hello');

      // The arguments are written down for the skill to read, not transcribed
      // by the model. See BundledSkillLoader's tests for why.
      const path = skillArgsPath('my-skill');
      expect(readFileSync(path, 'utf8')).toBe('hello');
      expect(text).toContain('<skill-args>hello</skill-args>');
    } finally {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('should return empty array when listSkills throws', async () => {
    mockSkillManager.listSkills.mockRejectedValue(new Error('load failed'));
    const loader = new SkillCommandLoader(mockConfig);
    expect(await loader.loadCommands(signal)).toEqual([]);
  });

  describe('extension skills', () => {
    it('should be modelInvocable when description is present', async () => {
      const skill = makeSkill({
        level: 'extension',
        extensionName: 'superpowers-lab',
        extensionDisplayName: 'Superpowers Lab',
        description: 'Use tmux for interactive commands',
      });
      mockSkillManager.listSkills.mockImplementation(
        ({ level }: { level: string }) =>
          Promise.resolve(level === 'extension' ? [skill] : []),
      );

      const loader = new SkillCommandLoader(mockConfig);
      const commands = await loader.loadCommands(signal);

      expect(commands[0].modelInvocable).toBe(true);
      expect(commands[0].source).toBe('plugin-command');
      expect(commands[0].sourceLabel).toBe('Extension: Superpowers Lab');
      expect(commands[0].sourceDetail).toBe('extension');
      expect(commands[0].skillDetail).toMatchObject({
        extensionName: 'superpowers-lab',
      });
    });

    it('should be modelInvocable when whenToUse is present', async () => {
      const skill = makeSkill({
        level: 'extension',
        extensionName: 'superpowers-lab',
        description: '',
        whenToUse: 'Use when you need tmux',
      });
      mockSkillManager.listSkills.mockImplementation(
        ({ level }: { level: string }) =>
          Promise.resolve(level === 'extension' ? [skill] : []),
      );

      const loader = new SkillCommandLoader(mockConfig);
      const commands = await loader.loadCommands(signal);

      expect(commands[0].modelInvocable).toBe(true);
      expect(commands[0].sourceLabel).toBe('Extension: superpowers-lab');
    });

    it('should NOT be modelInvocable when description and whenToUse are absent', async () => {
      const skill = makeSkill({
        level: 'extension',
        extensionName: 'superpowers-lab',
        description: '',
        whenToUse: undefined,
      });
      mockSkillManager.listSkills.mockImplementation(
        ({ level }: { level: string }) =>
          Promise.resolve(level === 'extension' ? [skill] : []),
      );

      const loader = new SkillCommandLoader(mockConfig);
      const commands = await loader.loadCommands(signal);

      expect(commands[0].modelInvocable).toBe(false);
    });

    it('should NOT be modelInvocable when disableModelInvocation is true, even with description', async () => {
      const skill = makeSkill({
        level: 'extension',
        extensionName: 'superpowers-lab',
        description: 'Some description',
        disableModelInvocation: true,
      });
      mockSkillManager.listSkills.mockImplementation(
        ({ level }: { level: string }) =>
          Promise.resolve(level === 'extension' ? [skill] : []),
      );

      const loader = new SkillCommandLoader(mockConfig);
      const commands = await loader.loadCommands(signal);

      expect(commands[0].modelInvocable).toBe(false);
    });

    it('should use "Extension: unknown" as sourceLabel when extensionName is absent', async () => {
      const skill = makeSkill({ level: 'extension', description: 'foo' });
      mockSkillManager.listSkills.mockImplementation(
        ({ level }: { level: string }) =>
          Promise.resolve(level === 'extension' ? [skill] : []),
      );

      const loader = new SkillCommandLoader(mockConfig);
      const commands = await loader.loadCommands(signal);

      expect(commands[0].sourceLabel).toBe('Extension: unknown');
      expect(commands[0].sourceDetail).toBe('extension');
    });
  });

  describe('user/project skill disableModelInvocation', () => {
    it('user skill with disableModelInvocation:true should NOT be modelInvocable', async () => {
      const skill = makeSkill({ level: 'user', disableModelInvocation: true });
      mockSkillManager.listSkills.mockImplementation(
        ({ level }: { level: string }) =>
          Promise.resolve(level === 'user' ? [skill] : []),
      );

      const loader = new SkillCommandLoader(mockConfig);
      const commands = await loader.loadCommands(signal);

      expect(commands[0].modelInvocable).toBe(false);
    });
  });

  it('should aggregate skills from all levels', async () => {
    mockSkillManager.listSkills.mockImplementation(
      ({ level }: { level: string }) => {
        if (level === 'user')
          return Promise.resolve([
            makeSkill({ name: 'user-skill', level: 'user' }),
          ]);
        if (level === 'project')
          return Promise.resolve([
            makeSkill({ name: 'proj-skill', level: 'project' }),
          ]);
        if (level === 'extension')
          return Promise.resolve([
            makeSkill({
              name: 'ext-skill',
              level: 'extension',
              description: 'foo',
            }),
          ]);
        return Promise.resolve([]);
      },
    );

    const loader = new SkillCommandLoader(mockConfig);
    const commands = await loader.loadCommands(signal);

    expect(commands).toHaveLength(3);
    expect(commands.map((c) => c.name)).toEqual([
      'user-skill',
      'proj-skill',
      'ext-skill',
    ]);
  });

  describe('allowedTools grant', () => {
    it('grants allowedTools as session allow rules when the command runs', async () => {
      const skill = makeSkill({
        level: 'user',
        allowedTools: ['Bash(git *)', 'Edit'],
      });
      mockSkillManager.listSkills.mockImplementation(
        ({ level }: { level: string }) =>
          Promise.resolve(level === 'user' ? [skill] : []),
      );

      const loader = new SkillCommandLoader(mockConfig);
      const commands = await loader.loadCommands(signal);
      await commands[0].action?.({} as CommandContext, '');

      expect(mockAddSessionAllowRule).toHaveBeenCalledTimes(2);
      expect(mockAddSessionAllowRule).toHaveBeenNthCalledWith(
        1,
        'Bash(git *)',
        {
          trustGated: false,
        },
      );
      expect(mockAddSessionAllowRule).toHaveBeenNthCalledWith(2, 'Edit', {
        trustGated: false,
      });
    });

    it('does not grant when the skill declares no allowedTools', async () => {
      const skill = makeSkill({ level: 'user' }); // no allowedTools
      mockSkillManager.listSkills.mockImplementation(
        ({ level }: { level: string }) =>
          Promise.resolve(level === 'user' ? [skill] : []),
      );

      const loader = new SkillCommandLoader(mockConfig);
      const commands = await loader.loadCommands(signal);
      await commands[0].action?.({} as CommandContext, '');

      expect(mockAddSessionAllowRule).not.toHaveBeenCalled();
    });
  });

  describe('frontmatter hooks registration via /<skill-name> (#11067)', () => {
    let mockAddSessionHook: ReturnType<typeof vi.fn>;
    let registeredEvents: Set<string>;

    function installHookSystem(): void {
      mockAddSessionHook = vi.fn();
      registeredEvents = new Set<string>();
      const byEvent = new Map<
        string,
        Array<{ matcher: string; skillRoot?: string; config: unknown }>
      >();
      const sessionHooksManager = {
        // Minimal fake mirroring SessionHooksManager's storage shape so
        // registerSkillHooks' dedup (matcher + skillRoot + config key)
        // sees what a previous addSessionHook actually stored.
        addSessionHook: mockAddSessionHook.mockImplementation(
          (
            _sessionId: string,
            event: string,
            matcher: string,
            hook: unknown,
            options?: { skillRoot?: string },
          ) => {
            registeredEvents.add(event);
            const list = byEvent.get(event) ?? [];
            list.push({ matcher, skillRoot: options?.skillRoot, config: hook });
            byEvent.set(event, list);
          },
        ),
        getHooksForEvent: vi.fn(
          (_sessionId: string, event: string) => byEvent.get(event) ?? [],
        ),
      };
      vi.mocked(mockConfig.getSessionId).mockReturnValue('session-1');
      (mockConfig.getHookSystem as ReturnType<typeof vi.fn>).mockReturnValue({
        getSessionHooksManager: () => sessionHooksManager,
      });
    }

    function gatedSkill(): SkillConfig {
      return makeSkill({
        level: 'project',
        filePath: '/test/project/.qwen/skills/my-skill/SKILL.md',
        skillRoot: '/test/project/.qwen/skills/my-skill',
        hooks: {
          PreToolUse: [
            {
              matcher: 'Shell',
              hooks: [
                {
                  type: HookType.Command,
                  command: '$QWEN_SKILL_ROOT/scripts/gate.sh',
                },
              ],
            },
          ],
          PostToolUse: [
            {
              matcher: 'Shell',
              hooks: [
                {
                  type: HookType.Command,
                  command: '$QWEN_SKILL_ROOT/scripts/audit.sh',
                },
              ],
            },
          ],
        },
      });
    }

    async function loadGatedSkillCommand() {
      const skill = gatedSkill();
      mockSkillManager.listSkills.mockImplementation(
        ({ level }: { level: string }) =>
          Promise.resolve(level === 'project' ? [skill] : []),
      );
      const loader = new SkillCommandLoader(mockConfig);
      const [command] = await loader.loadCommands(signal);
      return command;
    }

    it('registers every frontmatter tool-lifecycle hook event when the user starts the skill — not just when the model does', async () => {
      installHookSystem();
      const command = await loadGatedSkillCommand();

      await command.action?.(
        { invocation: { raw: '/my-skill', args: '' } } as CommandContext,
        '',
      );

      expect(mockAddSessionHook).toHaveBeenCalledTimes(2);
      expect(mockAddSessionHook).toHaveBeenCalledWith(
        'session-1',
        HookEventName.PreToolUse,
        'Shell',
        expect.objectContaining({
          type: HookType.Command,
          command: '$QWEN_SKILL_ROOT/scripts/gate.sh',
          env: { QWEN_SKILL_ROOT: '/test/project/.qwen/skills/my-skill' },
        }),
        {
          skillRoot: '/test/project/.qwen/skills/my-skill',
          trustGated: true,
        },
      );
      expect(mockAddSessionHook).toHaveBeenCalledWith(
        'session-1',
        HookEventName.PostToolUse,
        'Shell',
        expect.objectContaining({
          type: HookType.Command,
          command: '$QWEN_SKILL_ROOT/scripts/audit.sh',
          env: { QWEN_SKILL_ROOT: '/test/project/.qwen/skills/my-skill' },
        }),
        {
          skillRoot: '/test/project/.qwen/skills/my-skill',
          trustGated: true,
        },
      );
    });

    it('excludes prompt-lifecycle hooks so a skill cannot intercept its own submission (PR #11153 R1-1)', async () => {
      // The /<skill-name> action runs inside the dispatch of the very
      // submission that carries the skill body. Registering the skill's
      // own UserPromptSubmit / UserPromptExpansion hooks here would let
      // them fire on — and block — that submission (the UserPromptSubmit
      // arm re-fires downstream in client.ts, which consults
      // hasHooksForEvent only after the action registered it), for the
      // rest of the session since session hooks are never unregistered.
      // Only tool-lifecycle hooks — the PreToolUse gate #11067 is about —
      // may register on the slash path; prompt-lifecycle events stay on
      // the model Skill-tool path (see ApplySkillHooksOptions).
      installHookSystem();
      const skill = makeSkill({
        level: 'project',
        filePath: '/test/project/.qwen/skills/my-skill/SKILL.md',
        skillRoot: '/test/project/.qwen/skills/my-skill',
        hooks: {
          PreToolUse: [
            {
              matcher: 'Shell',
              hooks: [{ type: HookType.Command, command: 'gate.sh' }],
            },
          ],
          // No matcher: the exact form whose UserPromptSubmit arm fires
          // regardless of matcher (the handler has no matcher target).
          UserPromptSubmit: [
            {
              hooks: [{ type: HookType.Command, command: 'submit-guard.sh' }],
            },
          ],
          // Matcher equal to the skill's own command name: the form whose
          // UserPromptExpansion arm self-fires in the dispatchers.
          UserPromptExpansion: [
            {
              matcher: 'my-skill',
              hooks: [{ type: HookType.Command, command: 'expand-guard.sh' }],
            },
          ],
        },
      });
      mockSkillManager.listSkills.mockImplementation(
        ({ level }: { level: string }) =>
          Promise.resolve(level === 'project' ? [skill] : []),
      );
      const [command] = await new SkillCommandLoader(mockConfig).loadCommands(
        signal,
      );

      const result = await command.action?.(
        { invocation: { raw: '/my-skill', args: '' } } as CommandContext,
        '',
      );

      // The skill body still reaches the model — no self-interception.
      expect(result).toMatchObject({ type: 'submit_prompt' });
      // The PreToolUse gate still registers: #11067's actual fix is intact.
      expect(mockAddSessionHook).toHaveBeenCalledTimes(1);
      expect(mockAddSessionHook).toHaveBeenCalledWith(
        'session-1',
        HookEventName.PreToolUse,
        'Shell',
        expect.anything(),
        { skillRoot: '/test/project/.qwen/skills/my-skill', trustGated: true },
      );
      // Neither prompt-lifecycle event registered, so the downstream
      // hasHooksForEvent gates stay closed for them on this submission.
      expect(registeredEvents).toContain(HookEventName.PreToolUse);
      expect(registeredEvents).not.toContain(HookEventName.UserPromptSubmit);
      expect(registeredEvents).not.toContain(HookEventName.UserPromptExpansion);
    });

    it('does not double-register across repeated invocations', async () => {
      installHookSystem();
      const command = await loadGatedSkillCommand();

      await command.action?.({} as CommandContext, '');
      await command.action?.({} as CommandContext, '');

      expect(mockAddSessionHook).toHaveBeenCalledTimes(2);
    });

    it('registers nothing for a project skill in an untrusted folder (fail-closed)', async () => {
      installHookSystem();
      vi.mocked(mockConfig.isTrustedFolder).mockReturnValue(false);
      const command = await loadGatedSkillCommand();

      const result = await command.action?.(
        { invocation: { raw: '/my-skill', args: '' } } as CommandContext,
        '',
      );

      // The skill body still loads (the body only influences the model);
      // only the repo-supplied side effects are withheld.
      expect(result).toMatchObject({ type: 'submit_prompt' });
      expect(mockAddSessionHook).not.toHaveBeenCalled();
    });

    it('marks user-level skill hooks as not trust-gated', async () => {
      installHookSystem();
      const skill = {
        ...gatedSkill(),
        level: 'user' as const,
        filePath: '/tmp/qwen-test/skills/my-skill/SKILL.md',
        skillRoot: '/tmp/qwen-test/skills/my-skill',
      };
      mockSkillManager.listSkills.mockImplementation(
        ({ level }: { level: string }) =>
          Promise.resolve(level === 'user' ? [skill] : []),
      );
      const [command] = await new SkillCommandLoader(mockConfig).loadCommands(
        signal,
      );

      await command.action?.({} as CommandContext, '');

      expect(mockAddSessionHook).toHaveBeenCalledWith(
        'session-1',
        HookEventName.PreToolUse,
        'Shell',
        expect.anything(),
        { skillRoot: '/tmp/qwen-test/skills/my-skill', trustGated: false },
      );
    });

    it('still submits the skill body when no hook system exists (no crash, hooks skipped)', async () => {
      // Disable the hook system explicitly (the shared beforeEach installs
      // one by default): registration no-ops but the body still loads.
      (mockConfig.getHookSystem as ReturnType<typeof vi.fn>).mockReturnValue(
        undefined,
      );
      const skill = gatedSkill();
      mockSkillManager.listSkills.mockImplementation(
        ({ level }: { level: string }) =>
          Promise.resolve(level === 'project' ? [skill] : []),
      );
      const [command] = await new SkillCommandLoader(mockConfig).loadCommands(
        signal,
      );

      const result = await command.action?.(
        { invocation: { raw: '/my-skill', args: '' } } as CommandContext,
        '',
      );

      expect(result).toMatchObject({ type: 'submit_prompt' });
    });

    it('does not register anything when the skill declares no hooks', async () => {
      installHookSystem();
      mockSkillManager.listSkills.mockImplementation(
        ({ level }: { level: string }) =>
          Promise.resolve(level === 'user' ? [makeSkill()] : []),
      );
      const [command] = await new SkillCommandLoader(mockConfig).loadCommands(
        signal,
      );

      await command.action?.({} as CommandContext, '');

      expect(mockAddSessionHook).not.toHaveBeenCalled();
    });
  });

  describe('skills.disabled filter', () => {
    it('rejects a stale action before granting tools or writing arguments', async () => {
      const skill = makeSkill({
        name: 'stale-extension-action',
        level: 'extension',
        extensionName: 'suite',
        allowedTools: ['Edit'],
      });
      mockSkillManager.listSkills.mockImplementation(
        ({ level }: { level: string }) =>
          Promise.resolve(level === 'extension' ? [skill] : []),
      );
      const [command] = await new SkillCommandLoader(mockConfig).loadCommands(
        signal,
      );
      vi.mocked(mockConfig.isSkillEnabled).mockReturnValue(false);
      const dir = mkdtempSync(join(tmpdir(), 'stale-skill-action-'));
      const cwd = process.cwd();
      process.chdir(dir);
      try {
        const result = await command.action?.(
          {
            invocation: {
              raw: '/stale-extension-action payload',
              args: 'payload',
            },
          } as CommandContext,
          'payload',
        );

        expect(result).toMatchObject({ type: 'message', messageType: 'error' });
        expect(mockAddSessionAllowRule).not.toHaveBeenCalled();
        expect(existsSync(skillArgsPath(skill.name))).toBe(false);
        expect(
          await new SkillCommandLoader(mockConfig).loadCommands(signal),
        ).toEqual([]);
      } finally {
        process.chdir(cwd);
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('omits disabled skills (case-insensitive) from the command list', async () => {
      mockSkillManager.listSkills.mockImplementation(
        ({ level }: { level: string }) => {
          if (level === 'user')
            return Promise.resolve([
              makeSkill({ name: 'KeepMe', level: 'user' }),
              makeSkill({ name: 'HideMe', level: 'user' }),
            ]);
          return Promise.resolve([]);
        },
      );
      // Disabled set is lower-case (matches Config.getDisabledSkillNames
      // contract). Loader compares with `.toLowerCase()`.
      (
        mockConfig.getDisabledSkillNames as ReturnType<typeof vi.fn>
      ).mockReturnValue(new Set(['hideme']));

      const loader = new SkillCommandLoader(mockConfig);
      const commands = await loader.loadCommands(signal);

      expect(commands.map((c) => c.name)).toEqual(['KeepMe']);
    });

    it('reflects provider mutations on each load (live read)', async () => {
      // Regression: the provider must be called per-load, not cached, so
      // CommandService rebuilds (triggered by `reloadCommands`) pick up
      // the latest `skills.disabled`. A frozen-at-construction snapshot
      // would be a silent regression.
      mockSkillManager.listSkills.mockImplementation(
        ({ level }: { level: string }) =>
          level === 'user'
            ? Promise.resolve([makeSkill({ name: 'foo', level: 'user' })])
            : Promise.resolve([]),
      );
      let disabled = new Set<string>();
      (
        mockConfig.getDisabledSkillNames as ReturnType<typeof vi.fn>
      ).mockImplementation(() => disabled);

      const loader = new SkillCommandLoader(mockConfig);

      const first = await loader.loadCommands(signal);
      expect(first.map((c) => c.name)).toEqual(['foo']);

      disabled = new Set(['foo']);
      const second = await loader.loadCommands(signal);
      expect(second).toEqual([]);

      disabled = new Set<string>();
      const third = await loader.loadCommands(signal);
      expect(third.map((c) => c.name)).toEqual(['foo']);
    });
  });
});
