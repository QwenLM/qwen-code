/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  HookRegistryConfig,
  FeedbackEmitter,
  ExtensionWithHooks,
} from './hookRegistry.js';
import { HookRegistry } from './hookRegistry.js';
import { HookEventName, HooksConfigSource, HookType } from './types.js';
import type { HookConfig, HookDefinition } from './types.js';

type HooksMap = Parameters<HookRegistry['addAgentHooks']>[0];
interface Sources {
  trusted?: boolean;
  system?: HooksMap;
  user?: HooksMap;
  project?: HooksMap;
  extensions?: ExtensionWithHooks[];
}

/** A command hook; the `name` key is absent when no name is given. */
const cmd = (command: string, name?: string): HookConfig =>
  name === undefined
    ? { type: HookType.Command, command }
    : { type: HookType.Command, command, name };
/** `{ [event]: definitions }`. */
const on = (event: HookEventName, ...defs: HookDefinition[]): HooksMap => ({
  [event]: defs,
});
/** One PreToolUse definition `{ ...opts, hooks }`. */
const pre = (
  hooks: HookConfig | HookConfig[],
  opts: Omit<HookDefinition, 'hooks'> = {},
) => on(HookEventName.PreToolUse, { ...opts, hooks: [hooks].flat() });
const bash = (command: string, name: string) =>
  pre(cmd(command, name), { matcher: 'Bash' });
const ext = (hooks: HooksMap, isActive = true) => ({ isActive, hooks });
const preHooks = (registry: HookRegistry) =>
  registry.getHooksForEvent(HookEventName.PreToolUse);

const { debugWarn } = vi.hoisted(() => ({
  debugWarn: vi.fn(),
}));

vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => ({
    warn: debugWarn,
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('HookRegistry', () => {
  let mockConfig: HookRegistryConfig;
  let mockFeedbackEmitter: FeedbackEmitter;

  beforeEach(() => {
    mockConfig = {
      getProjectRoot: vi.fn().mockReturnValue('/test/project'),
      isTrustedFolder: vi.fn().mockReturnValue(true),
      getSystemHooks: vi.fn().mockReturnValue(undefined),
      getUserHooks: vi.fn().mockReturnValue(undefined),
      getProjectHooks: vi.fn().mockReturnValue(undefined),
      getExtensions: vi.fn().mockReturnValue([]),
    };
    mockFeedbackEmitter = {
      emitFeedback: vi.fn(),
    };
    vi.clearAllMocks();
  });

  /** Point each config getter at the given sources, then build and initialize a registry. */
  const init = async (
    { trusted = true, system, user, project, extensions = [] }: Sources = {},
    emitter?: FeedbackEmitter,
  ) => {
    mockConfig.isTrustedFolder = vi.fn().mockReturnValue(trusted);
    mockConfig.getSystemHooks = vi.fn().mockReturnValue(system);
    mockConfig.getUserHooks = vi.fn().mockReturnValue(user);
    mockConfig.getProjectHooks = vi.fn().mockReturnValue(project);
    mockConfig.getExtensions = vi.fn().mockReturnValue(extensions);
    const registry = new HookRegistry(mockConfig, emitter);
    await registry.initialize();
    return registry;
  };
  /** Rows of [title, sources, expected getAllHooks() length]. */
  const itCounts = (rows: Array<[string, Sources, number]>) =>
    it.each(rows)('%s', async (_title, sources, length) => {
      expect((await init(sources)).getAllHooks()).toHaveLength(length);
    });

  describe('initialize', () => {
    it('should initialize with empty hooks when no config provided', async () => {
      const registry = await init();
      expect(registry.getAllHooks()).toHaveLength(0);
    });

    it('should process project hooks from config', async () => {
      const registry = await init({ user: pre(cmd('echo test', 'test-hook')) });

      const allHooks = registry.getAllHooks();
      expect(allHooks).toHaveLength(1);
      expect(allHooks[0].eventName).toBe(HookEventName.PreToolUse);
      expect(allHooks[0].source).toBe(HooksConfigSource.User);
    });

    it('should process user hooks even in untrusted folder', async () => {
      const registry = await init({
        trusted: false,
        user: pre(cmd('echo user', 'user-hook')),
      });

      const allHooks = registry.getAllHooks();
      expect(allHooks).toHaveLength(1);
      expect(allHooks[0].source).toBe(HooksConfigSource.User);
    });

    describe('system scope', () => {
      const commandHooks = (command: string, name: string) =>
        pre(cmd(command, name));
      const allSources = {
        system: commandHooks('echo system', 'system-hook'),
        user: commandHooks('echo user', 'user-hook'),
        project: commandHooks('echo project', 'project-hook'),
      };

      it('registers system hooks under the system source, before user and project hooks', async () => {
        const registry = await init(allSources);

        expect(
          registry.getAllHooks().map(({ source, config }) => ({
            source,
            name: config.name,
          })),
        ).toEqual([
          { source: HooksConfigSource.System, name: 'system-hook' },
          { source: HooksConfigSource.User, name: 'user-hook' },
          { source: HooksConfigSource.Project, name: 'project-hook' },
        ]);
      });

      it('orders the hooks planned for an event by source priority: project, user, system, extensions', async () => {
        const registry = await init({
          ...allSources,
          extensions: [ext(commandHooks('echo extension', 'extension-hook'))],
        });

        expect(preHooks(registry).map(({ source }) => source)).toEqual([
          HooksConfigSource.Project,
          HooksConfigSource.User,
          HooksConfigSource.System,
          HooksConfigSource.Extensions,
        ]);
      });

      it('registers system-only hooks as system hooks, not user hooks', async () => {
        const registry = await init({
          system: commandHooks('echo system', 'system-hook'),
        });

        const allHooks = registry.getAllHooks();
        expect(allHooks).toHaveLength(1);
        expect(allHooks[0].source).toBe(HooksConfigSource.System);
        expect(
          allHooks.some(({ source }) => source === HooksConfigSource.User),
        ).toBe(false);
      });

      it('registers nothing and does not throw when there are no system hooks', async () => {
        mockConfig.getSystemHooks = vi.fn().mockReturnValue(undefined);

        const registry = new HookRegistry(mockConfig);
        await expect(registry.initialize()).resolves.toBeUndefined();

        expect(registry.getAllHooks()).toHaveLength(0);
      });

      it('keeps the same hook from system and user settings as two entries', async () => {
        // The duplicate key includes the source; this pins that established
        // behaviour so a change to the key is a deliberate one.
        const same = commandHooks('echo same', 'same-hook');
        const registry = await init({ system: same, user: same });

        expect(registry.getAllHooks().map(({ source }) => source)).toEqual([
          HooksConfigSource.System,
          HooksConfigSource.User,
        ]);
      });
    });

    it('should load hooks from getUserHooks regardless of trust', async () => {
      // The CLI filters workspace hooks before passing them to core, so core
      // loads whatever getUserHooks returns, even in an untrusted folder.
      const registry = await init({
        trusted: false,
        user: pre(cmd('echo test', 'test-hook')),
      });

      expect(registry.getAllHooks()).toHaveLength(1);
      expect(registry.getAllHooks()[0].source).toBe(HooksConfigSource.User);
    });

    it('should load both user and project hooks in trusted folder', async () => {
      const registry = await init({
        trusted: true,
        user: pre(cmd('echo user', 'user-hook')),
        project: pre(cmd('echo project', 'project-hook')),
      });

      const allHooks = registry.getAllHooks();
      expect(allHooks).toHaveLength(2);
      // User hooks should have priority (lower number) over project hooks
      expect(allHooks[0].source).toBe(HooksConfigSource.User);
      expect(allHooks[0].config.name).toBe('user-hook');
      expect(allHooks[1].source).toBe(HooksConfigSource.Project);
      expect(allHooks[1].config.name).toBe('project-hook');
    });

    it('should not load project hooks in untrusted folder', async () => {
      // Project hooks stay undefined: Config.getProjectHooks() checks trust.
      const registry = await init({
        trusted: false,
        user: pre(cmd('echo user', 'user-hook')),
      });

      const allHooks = registry.getAllHooks();
      expect(allHooks).toHaveLength(1);
      expect(allHooks[0].source).toBe(HooksConfigSource.User);
      expect(allHooks[0].config.name).toBe('user-hook');
    });
  });

  describe('getHooksForEvent', () => {
    it('should return hooks for specific event', async () => {
      const registry = await init({
        user: {
          ...pre(cmd('echo pre', 'pre-hook')),
          ...on(HookEventName.PostToolUse, {
            hooks: [cmd('echo post', 'post-hook')],
          }),
        },
      });

      const preToolHooks = preHooks(registry);
      expect(preToolHooks).toHaveLength(1);
      expect(preToolHooks[0].config.name).toBe('pre-hook');

      const postHooks = registry.getHooksForEvent(HookEventName.PostToolUse);
      expect(postHooks).toHaveLength(1);
      expect(postHooks[0].config.name).toBe('post-hook');
    });

    it('should register all hooks as enabled by default', async () => {
      const registry = await init({
        user: pre([
          cmd('echo first', 'first-hook'),
          cmd('echo second', 'second-hook'),
        ]),
      });

      const hooks = preHooks(registry);
      expect(hooks).toHaveLength(2);
      expect(hooks[0].enabled).toBe(true);
      expect(hooks[1].enabled).toBe(true);
    });

    it('should sort hooks by source priority', async () => {
      const registry = await init({
        user: pre(cmd('echo user', 'user-hook')),
        extensions: [ext(pre(cmd('echo extension', 'extension-hook')))],
      });

      const hooks = preHooks(registry);
      expect(hooks).toHaveLength(2);
      // User hooks have higher priority (lower number) than extensions
      expect(hooks[0].source).toBe(HooksConfigSource.User);
      expect(hooks[1].source).toBe(HooksConfigSource.Extensions);
    });
  });

  describe('setHookEnabled', () => {
    it('should disable an enabled hook', async () => {
      const registry = await init({ user: pre(cmd('echo test', 'test-hook')) });

      expect(preHooks(registry)).toHaveLength(1);
      registry.setHookEnabled('test-hook', false);
      expect(preHooks(registry)).toHaveLength(0);
    });

    it('should enable a disabled hook', async () => {
      const registry = await init({ user: pre(cmd('echo test', 'test-hook')) });

      registry.setHookEnabled('test-hook', false);
      expect(preHooks(registry)).toHaveLength(0);
      registry.setHookEnabled('test-hook', true);
      expect(preHooks(registry)).toHaveLength(1);
    });

    it('should update all hooks with matching name', async () => {
      const registry = await init({
        user: {
          ...pre(cmd('echo 1', 'same-name')),
          ...on(HookEventName.PostToolUse, {
            hooks: [cmd('echo 2', 'same-name')],
          }),
        },
      });
      const postHooks = () =>
        registry.getHooksForEvent(HookEventName.PostToolUse);

      expect(registry.getAllHooks()).toHaveLength(2);
      expect(preHooks(registry)).toHaveLength(1);
      expect(postHooks()).toHaveLength(1);

      registry.setHookEnabled('same-name', false);

      expect(preHooks(registry)).toHaveLength(0);
      expect(postHooks()).toHaveLength(0);
    });
  });

  describe('hook validation', () => {
    itCounts([
      [
        'should discard hooks with invalid type',
        {
          user: pre({
            type: 'invalid-type',
            command: 'echo test',
          } as unknown as HookConfig),
        },
        0,
      ],
      [
        'should discard command hooks without command field',
        { user: pre({ type: HookType.Command } as HookConfig) },
        0,
      ],
      [
        'should discard HTTP hooks without url field',
        { user: pre({ type: HookType.Http } as HookConfig) },
        0,
      ],
      [
        'should discard function hooks without callback field',
        {
          user: on(HookEventName.SessionStart, {
            hooks: [{ type: HookType.Function } as HookConfig],
          }),
        },
        0,
      ],
    ]);

    it('should accept valid HTTP hooks with url', async () => {
      const registry = await init({
        user: pre({
          type: HookType.Http,
          url: 'http://localhost:8080/hook',
          name: 'http-hook',
        }),
      });

      expect(registry.getAllHooks()).toHaveLength(1);
      expect(registry.getAllHooks()[0].config.type).toBe(HookType.Http);
    });

    it('should accept valid function hooks with callback', async () => {
      const callback = vi.fn();
      const registry = await init({
        user: on(HookEventName.SessionStart, {
          hooks: [
            {
              type: HookType.Function,
              callback,
              name: 'function-hook',
              errorMessage: 'Error occurred',
            },
          ],
        }),
      });

      expect(registry.getAllHooks()).toHaveLength(1);
      expect(registry.getAllHooks()[0].config.type).toBe(HookType.Function);
    });

    it('should skip invalid event names', async () => {
      const user = {
        InvalidEventName: [{ hooks: [cmd('echo test')] }],
      } as HooksMap;
      const registry = await init({ user }, mockFeedbackEmitter);

      expect(registry.getAllHooks()).toHaveLength(0);
      expect(mockFeedbackEmitter.emitFeedback).toHaveBeenCalledWith(
        'warning',
        expect.stringContaining('Invalid hook event name'),
      );
    });

    it('should skip hooks config fields like enabled and disabled', async () => {
      const user = {
        enabled: ['hook1'],
        disabled: ['hook2'],
        ...pre(cmd('echo test', 'valid-hook')),
      } as HooksMap;
      const registry = await init({ user });

      expect(registry.getAllHooks()).toHaveLength(1);
      expect(registry.getAllHooks()[0].config.name).toBe('valid-hook');
    });
  });

  describe('duplicate detection', () => {
    itCounts([
      [
        'should skip duplicate hooks with same name+source+event+matcher+sequential',
        {
          user: pre(
            [cmd('echo test', 'dup-hook'), cmd('echo test', 'dup-hook')],
            { matcher: '*.ts', sequential: true },
          ),
        },
        1,
      ],
      [
        'should allow hooks with same name but different matcher',
        {
          user: on(
            HookEventName.PreToolUse,
            { matcher: '*.ts', hooks: [cmd('echo ts', 'my-hook')] },
            { matcher: '*.js', hooks: [cmd('echo js', 'my-hook')] },
          ),
        },
        2,
      ],
      [
        'should allow hooks with same name but different sequential',
        {
          user: on(
            HookEventName.PreToolUse,
            { sequential: true, hooks: [cmd('echo seq', 'my-hook')] },
            { sequential: false, hooks: [cmd('echo par', 'my-hook')] },
          ),
        },
        2,
      ],
      [
        'should skip truly duplicate unnamed prompt hooks with identical prompt',
        {
          user: pre([
            { type: HookType.Prompt, prompt: 'This is a test prompt' },
            { type: HookType.Prompt, prompt: 'This is a test prompt' },
          ]),
        },
        1,
      ],
    ]);

    it('should distinguish unnamed prompt hooks with same prefix but different content', async () => {
      // Two unnamed prompt hooks sharing their first 30 chars must both register.
      const prompt = (ending: string) => ({
        type: HookType.Prompt as const,
        prompt: `This is a very long prompt that exceeds thirty characters and has ending ${ending}`,
      });
      const registry = await init({ user: pre([prompt('A'), prompt('B')]) });

      const hooks = registry.getAllHooks();
      expect(hooks).toHaveLength(2);
      expect(hooks[0].config.type).toBe(HookType.Prompt);
      expect(hooks[1].config.type).toBe(HookType.Prompt);
    });
  });

  describe('extension hooks', () => {
    it('should process hooks from active extensions', async () => {
      const registry = await init({
        extensions: [ext(pre(cmd('echo ext', 'ext-hook')))],
      });

      const allHooks = registry.getAllHooks();
      expect(allHooks).toHaveLength(1);
      expect(allHooks[0].source).toBe(HooksConfigSource.Extensions);
      expect(allHooks[0].config.name).toBe('ext-hook');
    });

    itCounts([
      [
        'should skip hooks from inactive extensions',
        { extensions: [ext(pre(cmd('echo ext')), false)] },
        0,
      ],
      [
        'should process multiple extensions',
        {
          extensions: [
            ext(pre(cmd('echo ext1', 'ext1-hook'))),
            ext(pre(cmd('echo ext2', 'ext2-hook'))),
          ],
        },
        2,
      ],
    ]);
  });

  describe('hook metadata', () => {
    it('should preserve matcher in registry entry', async () => {
      const registry = await init({
        user: pre(cmd('echo test', 'matcher-hook'), {
          matcher: 'ReadFileTool',
        }),
      });
      expect(registry.getAllHooks()[0].matcher).toBe('ReadFileTool');
    });

    it('should preserve sequential flag in registry entry', async () => {
      const registry = await init({
        user: pre(cmd('echo test', 'seq-hook'), { sequential: true }),
      });
      expect(registry.getAllHooks()[0].sequential).toBe(true);
    });

    it('should add source to hook config', async () => {
      const registry = await init({
        user: pre(cmd('echo test', 'source-hook')),
      });
      expect(
        (registry.getAllHooks()[0].config as { source?: unknown }).source,
      ).toBe(HooksConfigSource.User);
    });
  });

  describe('addAgentHooks — per-agent frontmatter ephemeral entries', () => {
    it('rolls back partially registered entries when registration throws', async () => {
      const registry = await init();
      const valid = {
        hooks: [{ type: HookType.Command as const, command: 'echo valid' }],
      };
      registry.addAgentHooks(
        { [HookEventName.PreToolUse]: [valid] },
        'existing',
        {
          owner: { sessionId: 's', agentId: 'existing' },
        },
      );
      const broken = {
        get hooks(): HookConfig[] {
          throw new Error('broken definition');
        },
      };
      expect(() =>
        registry.addAgentHooks(
          { [HookEventName.PreToolUse]: [valid, broken] },
          'new',
          {
            owner: { sessionId: 's', agentId: 'new' },
          },
        ),
      ).toThrow('broken definition');
      expect(registry.getAllHooks()).toHaveLength(1);
      expect(registry.getAllHooks()[0].agentScope).toBe('existing');
    });

    it('appends entries tagged with agentScope and returns an unregister callback', async () => {
      const registry = await init();
      expect(registry.getAllHooks()).toHaveLength(0);

      const unregister = registry.addAgentHooks(
        bash('echo per-agent', 'agent-hook'),
        'agent:test:abc',
        { owner: { sessionId: 'session-1', agentId: 'agent-1' } },
      );

      const after = registry.getAllHooks();
      expect(after).toHaveLength(1);
      expect(after[0].source).toBe(HooksConfigSource.Session);
      expect(after[0].agentScope).toBe('agent:test:abc');

      unregister();
      expect(registry.getAllHooks()).toHaveLength(0);
    });

    it('coexists with session/user hooks of the same identity', async () => {
      const userHooks = bash('echo same', 'shared');
      const registry = await init({ user: userHooks });
      expect(registry.getAllHooks()).toHaveLength(1);

      // Same identity, different source path (Session + agentScope): must NOT
      // be deduped against the user-source entry.
      registry.addAgentHooks(userHooks, 'agent:test:def', {
        owner: { sessionId: 'session-1', agentId: 'agent-1' },
      });
      const after = registry.getAllHooks();
      expect(after).toHaveLength(2);
      // Pin the scope tag itself as part of the dedup key, not just the count:
      // dropping `agentScope` from the check could still yield 2 entries by
      // ordering luck.
      expect(
        after.some(
          (e) =>
            e.source === HooksConfigSource.User && e.agentScope === undefined,
        ),
      ).toBe(true);
      expect(
        after.some(
          (e) =>
            e.source === HooksConfigSource.Session &&
            e.agentScope === 'agent:test:def',
        ),
      ).toBe(true);
    });

    it('two concurrent agents each keep their own copy of an identical hook', async () => {
      const registry = await init();
      const sameHooks = on(HookEventName.PostToolUse, {
        hooks: [cmd('echo done', 'h')],
      });

      const u1 = registry.addAgentHooks(sameHooks, 'agent:a:1', {
        owner: { sessionId: 'session-1', agentId: 'agent-1' },
      });
      const u2 = registry.addAgentHooks(sameHooks, 'agent:b:2', {
        owner: { sessionId: 'session-1', agentId: 'agent-1' },
      });

      expect(registry.getAllHooks()).toHaveLength(2);
      u1();
      const remaining = registry.getAllHooks();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].agentScope).toBe('agent:b:2');
      u2();
      expect(registry.getAllHooks()).toHaveLength(0);
    });

    it('preserves agent-scoped hooks when configured hooks reload', async () => {
      const registry = await init({ user: bash('echo user', 'user-hook') });
      registry.addAgentHooks(
        bash('echo agent', 'agent-hook'),
        'agent:test:reload',
        { owner: { sessionId: 'session-1', agentId: 'agent-1' } },
      );

      mockConfig.getUserHooks = vi.fn().mockReturnValue(undefined);
      await registry.reloadConfiguredHooks();

      const after = registry.getAllHooks();
      expect(after).toHaveLength(1);
      expect(after[0].source).toBe(HooksConfigSource.Session);
      expect(after[0].agentScope).toBe('agent:test:reload');
    });

    it('preserves configured hook enabled state when hooks reload', async () => {
      const registry = await init({ user: bash('echo user', 'user-hook') });
      registry.setHookEnabled('user-hook', false);

      expect(preHooks(registry)).toHaveLength(0);

      await registry.reloadConfiguredHooks();

      const after = registry.getAllHooks();
      expect(after).toHaveLength(1);
      expect(after[0].enabled).toBe(false);
      expect(preHooks(registry)).toHaveLength(0);
    });

    it('restores all previous hooks when configured hooks reload fails', async () => {
      const registry = await init({ user: bash('echo user', 'user-hook') });
      registry.addAgentHooks(
        bash('echo agent', 'agent-hook'),
        'agent:test:reload-failure',
        { owner: { sessionId: 'session-1', agentId: 'agent-1' } },
      );

      const before = registry.getAllHooks();
      mockConfig.getUserHooks = vi.fn(() => {
        throw new Error('reload failed');
      });

      await expect(registry.reloadConfiguredHooks()).rejects.toThrow(
        'reload failed',
      );

      expect(registry.getAllHooks()).toEqual(before);
    });

    it('silently keeps entries when the hooks payload is empty', async () => {
      const registry = await init();
      const unregister = registry.addAgentHooks({}, 'agent:empty:0', {
        owner: { sessionId: 'session-1', agentId: 'agent-1' },
      });
      expect(registry.getAllHooks()).toHaveLength(0);
      // No-op unregister should not throw
      unregister();
      expect(registry.getAllHooks()).toHaveLength(0);
    });
  });

  describe('reloadConfiguredHooks — stable enabled-state keying', () => {
    beforeEach(() => {
      debugWarn.mockClear();
    });
    it('preserves disabled state of a named command hook when its command is edited on disk', async () => {
      const userHooks = {
        [HookEventName.PreToolUse]: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: HookType.Command,
                command: 'echo old-command',
                name: 'my-named-hook',
              },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(userHooks);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();
      registry.setHookEnabled('my-named-hook', false);
      expect(registry.getHooksForEvent(HookEventName.PreToolUse)).toHaveLength(
        0,
      );
      const editedHooks = {
        [HookEventName.PreToolUse]: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: HookType.Command,
                command: 'echo new-command',
                name: 'my-named-hook',
              },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(editedHooks);

      await registry.reloadConfiguredHooks();

      const after = registry.getAllHooks();
      expect(after).toHaveLength(1);
      expect((after[0].config as { command: string }).command).toBe(
        'echo new-command',
      );
      expect(after[0].enabled).toBe(false);
      expect(registry.getHooksForEvent(HookEventName.PreToolUse)).toHaveLength(
        0,
      );
      expect(debugWarn).not.toHaveBeenCalled();
    });

    it('preserves disabled state of a named HTTP hook when its URL is edited on disk', async () => {
      const userHooks = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [
              {
                type: HookType.Http,
                url: 'http://old.example.com/hook',
                name: 'my-http-hook',
              },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(userHooks);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();
      registry.setHookEnabled('my-http-hook', false);
      expect(registry.getHooksForEvent(HookEventName.PreToolUse)).toHaveLength(
        0,
      );

      const editedHooks = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [
              {
                type: HookType.Http,
                url: 'http://new.example.com/hook',
                name: 'my-http-hook',
              },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(editedHooks);

      await registry.reloadConfiguredHooks();

      const after = registry.getAllHooks();
      expect(after).toHaveLength(1);
      expect((after[0].config as { url: string }).url).toBe(
        'http://new.example.com/hook',
      );
      expect(after[0].enabled).toBe(false);
      expect(debugWarn).not.toHaveBeenCalled();
    });

    it('preserves disabled state of a named prompt hook when its prompt text is edited on disk', async () => {
      const userHooks = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [
              {
                type: HookType.Prompt,
                prompt: 'Evaluate this tool call for safety (old)',
                name: 'my-prompt-hook',
              },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(userHooks);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();
      registry.setHookEnabled('my-prompt-hook', false);
      expect(registry.getHooksForEvent(HookEventName.PreToolUse)).toHaveLength(
        0,
      );

      const editedHooks = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [
              {
                type: HookType.Prompt,
                prompt: 'Evaluate this tool call for safety (new)',
                name: 'my-prompt-hook',
              },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(editedHooks);

      await registry.reloadConfiguredHooks();

      const after = registry.getAllHooks();
      expect(after).toHaveLength(1);
      expect((after[0].config as { prompt: string }).prompt).toBe(
        'Evaluate this tool call for safety (new)',
      );
      expect(after[0].enabled).toBe(false);
      expect(debugWarn).not.toHaveBeenCalled();
    });

    it('refuses to disable an unnamed command hook individually', async () => {
      const userHooks = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [
              {
                type: HookType.Command,
                command: 'echo unnamed',
              },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(userHooks);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();

      registry.setHookEnabled('echo unnamed', false);

      const hooks = registry.getAllHooks();
      expect(hooks).toHaveLength(1);
      expect(hooks[0].enabled).toBe(true);
      expect(registry.getHooksForEvent(HookEventName.PreToolUse)).toHaveLength(
        1,
      );
    });

    it('resets disabled state when a hook is renamed on disk', async () => {
      const userHooks = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [
              {
                type: HookType.Command,
                command: 'echo test',
                name: 'old-name',
              },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(userHooks);

      const registry = new HookRegistry(mockConfig);
      await registry.initialize();
      registry.setHookEnabled('old-name', false);
      expect(registry.getHooksForEvent(HookEventName.PreToolUse)).toHaveLength(
        0,
      );

      const renamedHooks = {
        [HookEventName.PreToolUse]: [
          {
            hooks: [
              {
                type: HookType.Command,
                command: 'echo test',
                name: 'new-name',
              },
            ],
          },
        ],
      };
      mockConfig.getUserHooks = vi.fn().mockReturnValue(renamedHooks);

      await registry.reloadConfiguredHooks();

      const after = registry.getAllHooks();
      expect(after).toHaveLength(1);
      expect(after[0].config.name).toBe('new-name');
      expect(after[0].enabled).toBe(true);
      expect(registry.getHooksForEvent(HookEventName.PreToolUse)).toHaveLength(
        1,
      );
      // The reload warning should fire exactly once for the orphaned key
      expect(debugWarn).toHaveBeenCalledTimes(1);
      expect(debugWarn.mock.calls[0][0]).toContain(
        'did not match any entry after reload',
      );
    });
  });

  describe('getAllHooks', () => {
    it('should return a copy of entries array', async () => {
      const registry = await init({ user: pre(cmd('echo test', 'test-hook')) });

      const hooks1 = registry.getAllHooks();
      const hooks2 = registry.getAllHooks();

      expect(hooks1).toEqual(hooks2);
      expect(hooks1).not.toBe(hooks2); // Different array reference
    });
  });
});
