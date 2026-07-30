/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BundledSkillLoader } from './BundledSkillLoader.js';
import { skillArgsPath } from './skill-args-file.js';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandKind } from '../ui/commands/types.js';
import {
  buildSkillLlmContent,
  type Config,
  type SkillConfig,
} from '@qwen-code/qwen-code-core';

function makeSkill(overrides: Partial<SkillConfig> = {}): SkillConfig {
  return {
    name: 'review',
    description: 'Review code changes',
    level: 'bundled',
    filePath: '/bundled/review/SKILL.md',
    body: 'You are an expert code reviewer.',
    ...overrides,
  };
}

function makeSkillPrompt(body: string): string {
  return buildSkillLlmContent('/bundled/review', body);
}

describe('BundledSkillLoader', () => {
  let mockConfig: Config;
  let mockSkillManager: {
    listSkills: ReturnType<typeof vi.fn>;
  };
  let mockAddSessionAllowRule: ReturnType<typeof vi.fn>;
  let resolveCurrentAutofixPullRequest: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSkillManager = {
      listSkills: vi.fn().mockResolvedValue([]),
    };
    mockAddSessionAllowRule = vi.fn();
    resolveCurrentAutofixPullRequest = vi.fn().mockResolvedValue({
      kind: 'error',
      message: 'Autofix requires a checked-out branch.',
    });
    mockConfig = {
      getSkillManager: vi.fn().mockReturnValue(mockSkillManager),
      isCronEnabled: vi.fn().mockReturnValue(false),
      getModel: vi.fn().mockReturnValue(undefined),
      getPermissionManager: vi
        .fn()
        .mockReturnValue({ addSessionAllowRule: mockAddSessionAllowRule }),
      // BundledSkillLoader filters via this. Default empty so existing
      // assertions about bundled skills surfacing stay true; per-test
      // cases override.
      getDisabledSkillNames: vi.fn().mockReturnValue(new Set<string>()),
    } as unknown as Config;
  });

  const signal = new AbortController().signal;

  it('should return empty array when config is null', async () => {
    const loader = new BundledSkillLoader(null);
    const commands = await loader.loadCommands(signal);
    expect(commands).toEqual([]);
  });

  it('should return empty array when SkillManager is not available', async () => {
    const config = {
      getSkillManager: vi.fn().mockReturnValue(null),
    } as unknown as Config;
    const loader = new BundledSkillLoader(config);
    const commands = await loader.loadCommands(signal);
    expect(commands).toEqual([]);
  });

  it('should return empty array in bare mode', async () => {
    const skill = makeSkill();
    mockSkillManager.listSkills.mockResolvedValue([skill]);
    (
      mockConfig as Config & { getBareMode: ReturnType<typeof vi.fn> }
    ).getBareMode = vi.fn().mockReturnValue(true);

    const loader = new BundledSkillLoader(mockConfig);
    const commands = await loader.loadCommands(signal);

    expect(commands).toEqual([]);
    expect(mockSkillManager.listSkills).not.toHaveBeenCalled();
  });

  it('should propagate argumentHint from bundled skills to slash commands', async () => {
    const skill = makeSkill({ argumentHint: '[topic]' });
    mockSkillManager.listSkills.mockResolvedValue([skill]);

    const loader = new BundledSkillLoader(mockConfig);
    const commands = await loader.loadCommands(signal);

    expect(commands[0]?.argumentHint).toBe('[topic]');
  });

  it('should default bundled skills to user-invocable slash commands', async () => {
    const skill = makeSkill();
    mockSkillManager.listSkills.mockResolvedValue([skill]);

    const loader = new BundledSkillLoader(mockConfig);
    const commands = await loader.loadCommands(signal);

    expect(commands[0]?.userInvocable).toBe(true);
  });

  it('should propagate userInvocable from bundled skills to slash commands', async () => {
    const skill = makeSkill({ userInvocable: false });
    mockSkillManager.listSkills.mockResolvedValue([skill]);

    const loader = new BundledSkillLoader(mockConfig);
    const commands = await loader.loadCommands(signal);

    expect(commands[0]?.userInvocable).toBe(false);
    expect(commands[0]?.modelInvocable).toBe(true);
  });

  it('should load bundled skills as slash commands', async () => {
    const skill = makeSkill();
    mockSkillManager.listSkills.mockResolvedValue([skill]);

    const loader = new BundledSkillLoader(mockConfig);
    const commands = await loader.loadCommands(signal);

    expect(commands).toHaveLength(1);
    expect(commands[0].name).toBe('review');
    expect(commands[0].description).toBe('Review code changes');
    expect(commands[0].kind).toBe(CommandKind.SKILL);
    expect(mockSkillManager.listSkills).toHaveBeenCalledWith({
      level: 'bundled',
    });
  });

  it('does not propagate skill.priority to completionPriority', async () => {
    // Priority is intentionally scoped to the `/skills` listing (sorted in
    // SkillManager.listSkills) and must NOT leak into the slash-completion
    // menu / `/help` ordering — typing `/` should keep its prior behavior
    // regardless of any skill's priority value.
    const skill = makeSkill({ priority: 42 });
    mockSkillManager.listSkills.mockResolvedValue([skill]);

    const loader = new BundledSkillLoader(mockConfig);
    const commands = await loader.loadCommands(signal);

    expect(commands[0].completionPriority).toBeUndefined();
  });

  it('should submit skill body as prompt without args', async () => {
    const skill = makeSkill();
    mockSkillManager.listSkills.mockResolvedValue([skill]);

    const loader = new BundledSkillLoader(mockConfig);
    const commands = await loader.loadCommands(signal);
    const result = await commands[0].action!(
      { invocation: { raw: '/review', args: '' } } as never,
      '',
    );

    expect(result).toEqual({
      type: 'submit_prompt',
      content: [{ text: makeSkillPrompt('You are an expert code reviewer.') }],
    });
  });

  describe('invocation arguments', () => {
    let dir: string;
    let cwd: string;

    beforeEach(() => {
      // The args file is written relative to the process's directory. Without a
      // temp cwd the suite would write into the real repository.
      dir = mkdtempSync(join(tmpdir(), 'bundled-skill-args-'));
      cwd = process.cwd();
      process.chdir(dir);
    });
    afterEach(() => {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    });

    async function invoke(raw: string, args?: string) {
      mockSkillManager.listSkills.mockResolvedValue([makeSkill()]);
      const loader = new BundledSkillLoader(mockConfig);
      const commands = await loader.loadCommands(signal);
      const result = (await commands[0].action!(
        { invocation: { raw, args } } as never,
        args ?? '',
      )) as { content: Array<{ text: string }> };
      return result.content[0].text;
    }

    it('appends the raw invocation when args are provided', async () => {
      const text = await invoke('/review 123', '123');
      expect(text).toContain(
        makeSkillPrompt('You are an expert code reviewer.'),
      );
      expect(text).toContain('/review 123');
    });

    it('writes the arguments to a file the skill can read', async () => {
      // The skill used to be asked to copy its own arguments into a file, and a
      // dogfood run of `/review 6771` copied `--effort high` — an example out of
      // the skill's own documentation. The parser then resolved a *local* review,
      // found the tree clean, and reported "no changes to review". The arguments
      // are a fact of the invocation; they are now written down before the model
      // has any say in them.
      const text = await invoke('/review 6771', '6771');

      const path = skillArgsPath('review');
      expect(existsSync(path)).toBe(true);
      // Verbatim: no newline, no quoting, no trimming.
      expect(readFileSync(path, 'utf8')).toBe('6771');
      // And the skill is told where to find it.
      expect(text).toContain(path);
      expect(text).toContain('<skill-args>6771</skill-args>');
    });

    it('preserves flags and spacing exactly', async () => {
      await invoke(
        '/review 6771 --comment --effort high',
        '6771 --comment --effort high',
      );
      expect(readFileSync(skillArgsPath('review'), 'utf8')).toBe(
        '6771 --comment --effort high',
      );
    });

    it('writes no args file for a bare invocation', async () => {
      const text = await invoke('/review');
      expect(existsSync(skillArgsPath('review'))).toBe(false);
      expect(text).not.toContain('<skill-args>');
    });
  });

  describe('allowedTools grant', () => {
    it('grants allowedTools as session allow rules when the command runs', async () => {
      const skill = makeSkill({ allowedTools: ['Bash(git *)', 'Edit'] });
      mockSkillManager.listSkills.mockResolvedValue([skill]);

      const loader = new BundledSkillLoader(mockConfig);
      const commands = await loader.loadCommands(signal);
      await commands[0].action!(
        { invocation: { raw: '/review', args: '' } } as never,
        '',
      );

      expect(mockAddSessionAllowRule).toHaveBeenCalledTimes(2);
      expect(mockAddSessionAllowRule).toHaveBeenNthCalledWith(1, 'Bash(git *)');
      expect(mockAddSessionAllowRule).toHaveBeenNthCalledWith(2, 'Edit');
    });

    it('does not grant when the bundled skill declares no allowedTools', async () => {
      const skill = makeSkill(); // no allowedTools
      mockSkillManager.listSkills.mockResolvedValue([skill]);

      const loader = new BundledSkillLoader(mockConfig);
      const commands = await loader.loadCommands(signal);
      await commands[0].action!(
        { invocation: { raw: '/review', args: '' } } as never,
        '',
      );

      expect(mockAddSessionAllowRule).not.toHaveBeenCalled();
    });
  });

  it('should return empty array when listSkills throws', async () => {
    mockSkillManager.listSkills.mockRejectedValue(new Error('load failed'));

    const loader = new BundledSkillLoader(mockConfig);
    const commands = await loader.loadCommands(signal);

    expect(commands).toEqual([]);
  });

  it('should load multiple bundled skills', async () => {
    const skills = [
      makeSkill({ name: 'review', description: 'Review code' }),
      makeSkill({ name: 'deploy', description: 'Deploy app' }),
    ];
    mockSkillManager.listSkills.mockResolvedValue(skills);

    const loader = new BundledSkillLoader(mockConfig);
    const commands = await loader.loadCommands(signal);

    expect(commands).toHaveLength(2);
    expect(commands.map((c) => c.name)).toEqual(['review', 'deploy']);
  });

  it('should load simplify bundled skill like other slash commands', async () => {
    const skills = [
      makeSkill({
        name: 'simplify',
        description: 'Simplify recent changes',
        filePath: '/bundled/simplify/SKILL.md',
        body: 'Simplify body',
      }),
    ];
    mockSkillManager.listSkills.mockResolvedValue(skills);

    const loader = new BundledSkillLoader(mockConfig);
    const commands = await loader.loadCommands(signal);

    expect(commands).toHaveLength(1);
    expect(commands[0].name).toBe('simplify');
    expect(commands[0].description).toBe('Simplify recent changes');
    expect(commands[0].kind).toBe(CommandKind.SKILL);
  });

  it('should resolve {{model}} template variable in skill body', async () => {
    const skill = makeSkill({
      body: 'Review by {{model}} via Qwen Code',
    });
    mockSkillManager.listSkills.mockResolvedValue([skill]);
    (mockConfig.getModel as ReturnType<typeof vi.fn>).mockReturnValue(
      'qwen3-coder',
    );

    const loader = new BundledSkillLoader(mockConfig);
    const commands = await loader.loadCommands(signal);
    const result = await commands[0].action!(
      { invocation: { raw: '/review', args: '' } } as never,
      '',
    );

    expect(result).toEqual({
      type: 'submit_prompt',
      content: [
        {
          text: makeSkillPrompt(
            'YOUR_MODEL_ID="qwen3-coder"\n\nReview by qwen3-coder via Qwen Code',
          ),
        },
      ],
    });
  });

  it('should use empty string for {{model}} when getModel returns undefined', async () => {
    const skill = makeSkill({
      body: 'Review by {{model}}',
    });
    mockSkillManager.listSkills.mockResolvedValue([skill]);
    // getModel returns undefined (default mock behavior)

    const loader = new BundledSkillLoader(mockConfig);
    const commands = await loader.loadCommands(signal);
    const result = await commands[0].action!(
      { invocation: { raw: '/review', args: '' } } as never,
      '',
    );

    expect(result).toEqual({
      type: 'submit_prompt',
      content: [{ text: makeSkillPrompt('Review by ') }],
    });
  });

  it('should resolve {{model}} when args are provided', async () => {
    const skill = makeSkill({
      body: 'Review by {{model}}',
    });
    mockSkillManager.listSkills.mockResolvedValue([skill]);
    (mockConfig.getModel as ReturnType<typeof vi.fn>).mockReturnValue(
      'qwen3-coder',
    );

    // An argument-bearing invoke writes the args file; keep it in a throwaway
    // cwd so the suite does not leave `.qwen/tmp/qwen-skill-args-review.txt` in
    // the real repository.
    const argDir = mkdtempSync(join(tmpdir(), 'bundled-model-args-'));
    const argCwd = process.cwd();
    process.chdir(argDir);

    let result: { type: string; content: Array<{ text: string }> };
    try {
      const loader = new BundledSkillLoader(mockConfig);
      const commands = await loader.loadCommands(signal);
      result = (await commands[0].action!(
        { invocation: { raw: '/review 123', args: '123' } } as never,
        '123',
      )) as { type: string; content: Array<{ text: string }> };
    } finally {
      process.chdir(argCwd);
      rmSync(argDir, { recursive: true, force: true });
    }

    expect(result.type).toBe('submit_prompt');
    const text = result.content[0].text;
    expect(text).toContain('Review by qwen3-coder');
    expect(text).toContain('YOUR_MODEL_ID="qwen3-coder"');
    expect(text).toContain('/review 123');
  });

  it('should use empty string for {{model}} when getModel returns empty string', async () => {
    const skill = makeSkill({
      body: 'Review by {{model}}',
    });
    mockSkillManager.listSkills.mockResolvedValue([skill]);
    (mockConfig.getModel as ReturnType<typeof vi.fn>).mockReturnValue('');

    const loader = new BundledSkillLoader(mockConfig);
    const commands = await loader.loadCommands(signal);
    const result = await commands[0].action!(
      { invocation: { raw: '/review', args: '' } } as never,
      '',
    );

    expect(result).toEqual({
      type: 'submit_prompt',
      content: [{ text: makeSkillPrompt('Review by ') }],
    });
  });

  it('should not modify skill body without {{model}} template', async () => {
    const skill = makeSkill({ body: 'No template here' });
    mockSkillManager.listSkills.mockResolvedValue([skill]);

    const loader = new BundledSkillLoader(mockConfig);
    const commands = await loader.loadCommands(signal);
    const result = await commands[0].action!(
      { invocation: { raw: '/review', args: '' } } as never,
      '',
    );

    expect(result).toEqual({
      type: 'submit_prompt',
      content: [{ text: makeSkillPrompt('No template here') }],
    });
  });

  it('should hide skills with cron allowedTools when cron is disabled', async () => {
    const skills = [
      makeSkill({ name: 'review', description: 'Review code' }),
      makeSkill({
        name: 'loop',
        description: 'Loop command',
        allowedTools: ['cron_create', 'cron_list', 'cron_delete'],
      }),
    ];
    mockSkillManager.listSkills.mockResolvedValue(skills);
    (mockConfig.isCronEnabled as ReturnType<typeof vi.fn>).mockReturnValue(
      false,
    );

    const loader = new BundledSkillLoader(mockConfig);
    const commands = await loader.loadCommands(signal);

    expect(commands).toHaveLength(1);
    expect(commands[0].name).toBe('review');
  });

  describe('autofix command controls', () => {
    let dir: string;
    let cwd: string;
    let schedulerJobs: Array<{
      id: string;
      cronExpr: string;
      prompt: string;
      recurring: boolean;
      createdAt: number;
      expiresAt: number;
      jitterMs: number;
    }>;
    const currentPullRequest = {
      kind: 'ok' as const,
      value: {
        repo: 'QwenLM/qwen-code',
        pullRequest: {
          number: 4362,
          title: 'Autofix current PR',
          url: 'https://github.com/QwenLM/qwen-code/pull/4362',
          author: 'maintainer',
          headRefName: 'feat/4362-autofix-controls',
          state: 'open' as const,
          reviewDecision: 'review_required' as const,
          checks: 'failing' as const,
          updatedAt: 1,
        },
      },
    };
    let scheduler: {
      disabled: boolean;
      list: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'bundled-autofix-'));
      cwd = process.cwd();
      process.chdir(dir);
      schedulerJobs = [];
      scheduler = {
        disabled: false,
        list: vi.fn(() => schedulerJobs),
        create: vi.fn(
          (cronExpr: string, prompt: string, recurring: boolean) => {
            const job = {
              id: `job-${schedulerJobs.length + 1}`,
              cronExpr,
              prompt,
              recurring,
              createdAt: Date.now(),
              expiresAt: Date.now() + 1000,
              jitterMs: 0,
            };
            schedulerJobs.push(job);
            return job;
          },
        ),
        delete: vi.fn(async (id: string) => {
          const before = schedulerJobs.length;
          schedulerJobs = schedulerJobs.filter((job) => job.id !== id);
          return schedulerJobs.length !== before;
        }),
      };
      (mockConfig.isCronEnabled as ReturnType<typeof vi.fn>).mockReturnValue(
        true,
      );
      (mockConfig as Config & { getProjectRoot: () => string }).getProjectRoot =
        () => dir;
      (
        mockConfig as unknown as { getCronScheduler: () => unknown }
      ).getCronScheduler = () => scheduler;
    });

    afterEach(() => {
      process.chdir(cwd);
      rmSync(dir, { recursive: true, force: true });
    });

    function autofixSkill(): SkillConfig {
      return makeSkill({
        name: 'autofix',
        description: 'Watch the current PR',
        filePath: '/bundled/autofix/SKILL.md',
        body: 'Autofix instructions',
        allowedTools: ['cron_create'],
        disableModelInvocation: true,
      });
    }

    async function invokeAutofix(args: string) {
      mockSkillManager.listSkills.mockResolvedValue([autofixSkill()]);
      const loader = new BundledSkillLoader(mockConfig, {
        resolveCurrentAutofixPullRequest,
      });
      const [command] = await loader.loadCommands(signal);
      return command.action!(
        {
          invocation: {
            raw: `/autofix${args ? ` ${args}` : ''}`,
            name: 'autofix',
            args,
          },
        } as never,
        args,
      );
    }

    it('rejects invalid arguments before reading GitHub', async () => {
      const result = await invokeAutofix('enable');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content:
          'Usage: /autofix status | on [propose-only|auto-commit|auto-push] | off',
      });
      expect(scheduler.create).not.toHaveBeenCalled();
    });

    it('reports GitHub resolution failures without touching the scheduler', async () => {
      const result = await invokeAutofix('status');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: 'Autofix requires a checked-out branch.',
      });
      expect(scheduler.list).not.toHaveBeenCalled();
      expect(scheduler.create).not.toHaveBeenCalled();
    });

    it('reports the resolved PR and matching watcher state', async () => {
      resolveCurrentAutofixPullRequest.mockResolvedValue(currentPullRequest);
      schedulerJobs.push({
        id: 'job-existing',
        cronExpr: '*/10 * * * *',
        prompt:
          'autofix tick repo=QwenLM/qwen-code pr=4362 mode=auto-push rounds=4 infra-reruns=1',
        recurring: true,
        createdAt: 1,
        expiresAt: 2,
        jitterMs: 0,
      });

      const result = await invokeAutofix('status');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: [
          'PR QwenLM/qwen-code#4362: https://github.com/QwenLM/qwen-code/pull/4362',
          'Watcher: on (auto-push, rounds 4/10, infra reruns 1/1, job job-existing)',
          'CI: failing',
          'Review: review_required',
        ].join('\n'),
      });
      expect(scheduler.create).not.toHaveBeenCalled();
    });

    it('starts one propose-only watcher and submits the authorized first tick', async () => {
      resolveCurrentAutofixPullRequest.mockResolvedValue(currentPullRequest);

      const result = await invokeAutofix('on');

      expect(scheduler.create).toHaveBeenCalledWith(
        '*/10 * * * *',
        'autofix tick repo=QwenLM/qwen-code pr=4362 mode=propose-only rounds=0 infra-reruns=0',
        true,
      );
      expect(result).toMatchObject({ type: 'submit_prompt' });
      expect(result).toHaveProperty(
        'content.0.text',
        expect.stringContaining(
          '<autofix-authority source="user" repo="QwenLM/qwen-code" pr="4362" mode="propose-only" rounds="0" infra-reruns="0" job="job-1" />',
        ),
      );
      expect(mockAddSessionAllowRule).toHaveBeenCalledWith('cron_create');
    });

    it('does not create a duplicate watcher for the same pull request', async () => {
      resolveCurrentAutofixPullRequest.mockResolvedValue(currentPullRequest);
      schedulerJobs.push({
        id: 'job-existing',
        cronExpr: '*/10 * * * *',
        prompt:
          'autofix tick repo=qwenlm/QWEN-CODE pr=4362 mode=auto-commit rounds=2 infra-reruns=0',
        recurring: true,
        createdAt: 1,
        expiresAt: 2,
        jitterMs: 0,
      });

      const result = await invokeAutofix('on auto-push');

      expect(result).toMatchObject({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('Autofix watcher is already on'),
      });
      expect(scheduler.create).not.toHaveBeenCalled();
    });

    it('deletes every Autofix watcher without requiring live PR resolution', async () => {
      schedulerJobs.push(
        {
          id: 'job-1',
          cronExpr: '*/10 * * * *',
          prompt:
            'autofix tick repo=QwenLM/qwen-code pr=4362 mode=propose-only rounds=0 infra-reruns=0',
          recurring: true,
          createdAt: 1,
          expiresAt: 2,
          jitterMs: 0,
        },
        {
          id: 'job-2',
          cronExpr: '*/10 * * * *',
          prompt:
            'autofix tick repo=other/repo pr=99 mode=auto-push rounds=1 infra-reruns=0',
          recurring: true,
          createdAt: 1,
          expiresAt: 2,
          jitterMs: 0,
        },
      );

      const result = await invokeAutofix('off');

      expect(resolveCurrentAutofixPullRequest).not.toHaveBeenCalled();
      expect(scheduler.delete).toHaveBeenCalledTimes(2);
      expect(scheduler.list).toHaveBeenCalledTimes(2);
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: 'Disabled 2 Autofix watchers.',
      });
    });

    it('reports a failed kill switch while any Autofix watcher remains', async () => {
      schedulerJobs.push({
        id: 'job-stuck',
        cronExpr: '*/10 * * * *',
        prompt:
          'autofix tick repo=QwenLM/qwen-code pr=4362 mode=propose-only rounds=0 infra-reruns=0',
        recurring: true,
        createdAt: 1,
        expiresAt: 2,
        jitterMs: 0,
      });
      scheduler.delete.mockResolvedValue(false);

      const result = await invokeAutofix('off');

      expect(resolveCurrentAutofixPullRequest).not.toHaveBeenCalled();
      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content:
          'Autofix watcher could not be fully disabled. Failed jobs: job-stuck',
      });
    });
  });

  describe('skills.disabled filter', () => {
    it('omits disabled bundled skills (case-insensitive)', async () => {
      mockSkillManager.listSkills.mockResolvedValue([
        makeSkill({ name: 'review' }),
        makeSkill({ name: 'batch' }),
      ]);
      (
        mockConfig.getDisabledSkillNames as ReturnType<typeof vi.fn>
      ).mockReturnValue(new Set(['REVIEW'.toLowerCase()]));

      const loader = new BundledSkillLoader(mockConfig);
      const commands = await loader.loadCommands(signal);

      expect(commands.map((c) => c.name)).toEqual(['batch']);
    });

    it('reflects provider mutations on each load (live read)', async () => {
      mockSkillManager.listSkills.mockResolvedValue([
        makeSkill({ name: 'review' }),
      ]);
      let disabled = new Set<string>();
      (
        mockConfig.getDisabledSkillNames as ReturnType<typeof vi.fn>
      ).mockImplementation(() => disabled);

      const loader = new BundledSkillLoader(mockConfig);

      expect((await loader.loadCommands(signal)).map((c) => c.name)).toEqual([
        'review',
      ]);

      disabled = new Set(['review']);
      expect(await loader.loadCommands(signal)).toEqual([]);

      disabled = new Set<string>();
      expect((await loader.loadCommands(signal)).map((c) => c.name)).toEqual([
        'review',
      ]);
    });
  });
});
