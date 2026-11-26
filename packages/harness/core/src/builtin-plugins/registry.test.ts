/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import type { SkillDefinition } from '@qwen-code/resource';
import type { LocalAgentDefinition } from '../agents/types.js';
import type { OutputStyleConfig } from '../prompts/outputStyles/types.js';
import type { BuiltinPlugin, BuiltinPluginContext } from './types.js';
import { BuiltinPluginRegistry } from './registry.js';

const context: BuiltinPluginContext = {
  runtime: {
    prepare: async () => {},
    getSetting: async () => undefined,
  },
  mode: 'headless',
  getLaunchSetting: () => undefined,
  isSettingSourceAllowed: () => true,
  notifyChanged: async () => {},
  whenReady: async () => {},
};
function plugin(id: string): BuiltinPlugin {
  return {
    apiVersion: 1,
    id,
    initialize: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    getSkillDefinitions: () => [],
    getHooks: () => [],
  };
}
const skill: SkillDefinition = {
  name: 'example',
  description: 'Example',
  location: '/skills/example/SKILL.md',
  skillRoot: '/skills/example',
  body: 'Instructions',
};
function agent(name: string): LocalAgentDefinition {
  return {
    kind: 'local',
    name,
    description: `${name} agent`,
    promptConfig: { systemPrompt: 'Instructions' },
    modelConfig: { model: 'inherit' },
  };
}

function outputStyle(name: string): OutputStyleConfig {
  return {
    name,
    source: 'built-in',
    description: `${name} style`,
    prompt: 'Instructions',
  };
}

describe('BuiltinPluginRegistry', () => {
  it('所有插件等待同一入口许可，变化通知覆盖存活订阅者而不是首个 Config', async () => {
    let appContext!: BuiltinPluginContext;
    const contributor = plugin('notifications');
    contributor.initialize = async (value) => {
      appContext = value;
    };
    const registry = new BuiltinPluginRegistry([contributor], context);
    await registry.initialize();
    let ready = false;
    const waiting = appContext.whenReady().then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    registry.markHostReady();
    await waiting;
    const first = vi.fn(async () => {});
    const second = vi.fn(async () => {});
    const unsubscribe = registry.subscribeChanged(first);
    registry.subscribeChanged(second);
    await appContext.notifyChanged();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    unsubscribe();
    await appContext.notifyChanged();
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledTimes(2);
    await registry.dispose();
  });

  it('退出会结束插件尚未获得的后台许可等待', async () => {
    const abort = new AbortController();
    let appContext!: BuiltinPluginContext;
    const contributor = plugin('cancel');
    contributor.initialize = async (value) => {
      appContext = value;
    };
    const registry = new BuiltinPluginRegistry([contributor], {
      ...context,
      signal: abort.signal,
    });
    await registry.initialize();
    const waiting = appContext.whenReady().catch((error: unknown) => error);
    abort.abort(new Error('exit'));
    expect(await waiting).toEqual(expect.objectContaining({ message: 'exit' }));
    await registry.dispose();
  });

  it('初始化中关闭会等待迟到清理，不会重新暴露贡献或重复关闭', async () => {
    let finish!: () => void;
    const contributor = plugin('late');
    contributor.initialize = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const registry = new BuiltinPluginRegistry([contributor], context);
    const initializing = registry.initialize().catch((error: unknown) => error);
    const closing = registry.dispose();
    finish();
    expect(await initializing).toEqual(
      expect.objectContaining({ message: expect.stringContaining('disposed') }),
    );
    await closing;
    expect(registry.isReady()).toBe(false);
    expect(contributor.dispose).toHaveBeenCalledOnce();
    expect(registry.dispose()).toBe(closing);
  });

  it('cleans up both successful and partially initialized plugins on failure', async () => {
    const first = plugin('first');
    const second = plugin('second');
    second.initialize = vi.fn(async () => {
      throw new Error('initialization failed');
    });
    const registry = new BuiltinPluginRegistry([first, second], context);
    await expect(registry.initialize()).rejects.toThrow(
      'initialization failed',
    );
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.dispose).toHaveBeenCalledOnce();
    await registry.dispose();
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(() => registry.getHooks()).toThrow('not initialized');
  });

  it('continues cleanup when one plugin cannot dispose', async () => {
    const first = plugin('first');
    const second = plugin('second');
    second.dispose = vi.fn(async () => {
      throw new Error('cleanup failed');
    });
    const registry = new BuiltinPluginRegistry([first, second], context);
    await registry.initialize();
    await expect(registry.dispose()).rejects.toThrow('cleanup failed');
    expect(first.dispose).toHaveBeenCalledOnce();
  });

  it('awaits asynchronous initialization once before exposing contributions', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const first = plugin('first');
    first.initialize = vi.fn(() => pending);
    first.getSkillDefinitions = () => [skill];
    const second = plugin('second');
    second.getHooks = () => [
      { event: 'PreToolUse', matcher: 'Bash', command: 'check' },
    ];
    const registry = new BuiltinPluginRegistry([first, second], context);
    expect(first.initialize).not.toHaveBeenCalled();
    expect(() => registry.getSkillDefinitions()).toThrow('not initialized');
    const initializing = registry.initialize();
    expect(registry.initialize()).toBe(initializing);
    expect(first.initialize).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        mode: context.mode,
        runtime: context.runtime,
      }),
    );
    expect(second.initialize).not.toHaveBeenCalled();
    finish();
    await initializing;
    expect(second.initialize).toHaveBeenCalledExactlyOnceWith(
      vi.mocked(first.initialize).mock.calls[0][0],
    );
    expect(registry.getSkillDefinitions()).toEqual([skill]);
    expect(registry.getHooks()).toEqual([
      { event: 'PreToolUse', matcher: 'Bash', command: 'check' },
    ]);
  });

  it('aggregates agent definitions from every plugin', async () => {
    const first = plugin('first');
    first.getAgentDefinitions = () => [agent('guide')];
    const second = plugin('second');
    second.getAgentDefinitions = () => [agent('helper')];
    const registry = new BuiltinPluginRegistry([first, second], context);
    await registry.initialize();
    expect(registry.getAgentDefinitions().map((value) => value.name)).toEqual([
      'guide',
      'helper',
    ]);
  });

  it('treats an omitted agent contribution getter as empty', async () => {
    const registry = new BuiltinPluginRegistry([plugin('plain')], context);
    await registry.initialize();
    expect(registry.getAgentDefinitions()).toEqual([]);
  });

  it('aggregates output style definitions from every plugin', async () => {
    const first = plugin('first');
    first.getOutputStyleDefinitions = () => [outputStyle('Product-A')];
    const second = plugin('second');
    second.getOutputStyleDefinitions = () => [outputStyle('Product-B')];
    const registry = new BuiltinPluginRegistry([first, second], context);
    await registry.initialize();
    expect(
      registry.getOutputStyleDefinitions().map((value) => value.name),
    ).toEqual(['Product-A', 'Product-B']);
  });

  it('treats an omitted output style contribution getter as empty', async () => {
    const registry = new BuiltinPluginRegistry([plugin('plain')], context);
    await registry.initialize();
    expect(registry.getOutputStyleDefinitions()).toEqual([]);
  });

  it('rejects non-array output style contributions', async () => {
    const invalid = {
      ...plugin('invalid'),
      getOutputStyleDefinitions: () => ({}),
    } as unknown as BuiltinPlugin;
    const registry = new BuiltinPluginRegistry([invalid], context);
    await registry.initialize();
    expect(() => registry.getOutputStyleDefinitions()).toThrow(
      'Invalid builtin plugin output styles: invalid',
    );
  });

  it('rejects non-array agent contributions', async () => {
    const invalid = {
      ...plugin('invalid'),
      getAgentDefinitions: () => ({}),
    } as unknown as BuiltinPlugin;
    const registry = new BuiltinPluginRegistry([invalid], context);
    await registry.initialize();
    expect(() => registry.getAgentDefinitions()).toThrow(
      'Invalid builtin plugin agents: invalid',
    );
  });

  it('reads fresh definitions when the host asks again', async () => {
    const contributor = plugin('example');
    let skills: SkillDefinition[] = [];
    contributor.getSkillDefinitions = () => skills;
    const registry = new BuiltinPluginRegistry([contributor], context);
    await registry.initialize();
    expect(registry.getSkillDefinitions()).toEqual([]);
    skills = [skill];
    expect(registry.getSkillDefinitions()).toEqual([skill]);
  });

  it('passes the builtin switch flag through unchanged', async () => {
    const contributor = plugin('flagged');
    const flagged = {
      ...skill,
      name: 'flagged',
      respectBuiltinSkillSwitch: true,
    };
    contributor.getSkillDefinitions = () => [flagged];
    const registry = new BuiltinPluginRegistry([contributor], context);

    await registry.initialize();

    expect(registry.getSkillDefinitions()).toEqual([flagged]);
  });

  it('supports an empty product configuration', async () => {
    const registry = new BuiltinPluginRegistry([], context);
    await registry.initialize();
    expect(registry.getSkillDefinitions()).toEqual([]);
    expect(registry.getHooks()).toEqual([]);
  });

  it('validates all plugins before starting any of them', async () => {
    const first = plugin('duplicate');
    const registry = new BuiltinPluginRegistry(
      [first, plugin('duplicate')],
      context,
    );
    await expect(registry.initialize()).rejects.toThrow(
      'duplicate builtin plugin',
    );
    expect(first.initialize).not.toHaveBeenCalled();
  });

  it.each([
    { ...plugin('invalid'), apiVersion: 2 },
    { ...plugin('invalid'), initialize: undefined },
    { ...plugin('invalid'), dispose: undefined },
  ])('rejects incompatible lifecycle implementations', async (value) => {
    const registry = new BuiltinPluginRegistry(
      [value as unknown as BuiltinPlugin],
      context,
    );
    await expect(registry.initialize()).rejects.toThrow(
      'Invalid or duplicate builtin plugin',
    );
  });

  it('treats omitted contribution getters as empty', async () => {
    const registry = new BuiltinPluginRegistry(
      [
        {
          apiVersion: 1,
          id: 'lifecycle-only',
          initialize: async () => {},
          dispose: async () => {},
        },
      ],
      context,
    );

    await registry.initialize();

    expect(registry.getSkillDefinitions()).toEqual([]);
    expect(registry.getHooks()).toEqual([]);
  });

  it('propagates initialization failure and never exposes partial contributions', async () => {
    const first = plugin('failing');
    first.initialize = vi.fn(async () => {
      throw new Error('initialization failed');
    });
    const second = plugin('next');
    const registry = new BuiltinPluginRegistry([first, second], context);
    await expect(registry.initialize()).rejects.toThrow(
      'initialization failed',
    );
    await expect(registry.initialize()).rejects.toThrow(
      'initialization failed',
    );
    expect(first.initialize).toHaveBeenCalledTimes(1);
    expect(second.initialize).not.toHaveBeenCalled();
    expect(() => registry.getHooks()).toThrow('not initialized');
  });

  it('rejects non-array contributions from JavaScript plugins', async () => {
    const invalid = {
      ...plugin('invalid'),
      getSkillDefinitions: () => null,
      getHooks: () => ({}),
    } as unknown as BuiltinPlugin;
    const registry = new BuiltinPluginRegistry([invalid], context);
    await registry.initialize();
    expect(() => registry.getSkillDefinitions()).toThrow(
      'Invalid builtin plugin skills',
    );
    expect(() => registry.getHooks()).toThrow('Invalid builtin plugin hooks');
  });
});
