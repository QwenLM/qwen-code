/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 本文件锁 `registerHostAgents` 的两类不变量：
 *
 * 1. **注册成功后必须再调一次 `config.applySessionAgent()`。** 这不是冗余：用户可能同时
 *    传了 `--agent <name>` 指向刚注入的 SDK agent，而 `Config.initialize()` 里那次
 *    applySessionAgent 跑在注册之前，主会话因此没被 transform。这行调用幂等、删掉不会
 *    报错，只会在运行时静默失效——所以必须由测试钉住，并且钉住「先注册后补偿」的顺序。
 *    边界同样重要：一个都没注册进去时不补偿，否则会在没有新 agent 的情况下白跑一次
 *    会话 transform。
 * 2. **坏声明只 warn 不抛。** registry 取不到、payload 解析失败、部分 agent 注册失败，
 *    都不能让 initialize 失败——SDK 侧靠回包里的 `agents` 字段发现少了谁。解析交给 core
 *    的公共解析器，本模块只负责把 wire 记录（键是 agent 名）转成内部定义并转交注册表，
 *    失败列表里 name 缺失时用 `?` 占位。
 *    显式会话 agent 的应用是另一条失败路径：必须等待完成，应用错误向上传递。
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import {
  runLogger,
  type AgentDefinition,
  type Config,
} from '@qwen-code/core';
import { registerHostAgents } from './sessionHostAgents.js';
import type { ThreadSessionDeclarations } from '../contract/threadSessionTypes.js';

interface RegistrationResult {
  registered: string[];
  failed: Array<{ name?: string; error: string }>;
}

interface SetupOptions {
  /** missing = getter 返回 undefined；absent = config 上根本没有这个 getter。 */
  registry?: 'missing' | 'absent';
  result?: RegistrationResult;
}

function setup(options: SetupOptions = {}) {
  const order: string[] = [];
  const defsReceived: AgentDefinition[][] = [];
  const registerSdkAgentsOnRegistry = vi.fn(async (defs: AgentDefinition[]) => {
    order.push('registerSdkAgents');
    defsReceived.push(defs);
    return (
      options.result ?? {
        registered: defs.map((def) => def.name),
        failed: [] as Array<{ name?: string; error: string }>,
      }
    );
  });
  const agentRegistry = { registerSdkAgents: registerSdkAgentsOnRegistry };
  const applySessionAgent = vi.fn(async () => {
    order.push('applySessionAgent');
  });
  const config = (options.registry === 'absent'
    ? { applySessionAgent }
    : {
        getAgentRegistry: () =>
          options.registry === 'missing' ? undefined : agentRegistry,
        applySessionAgent,
      }) as unknown as Config;

  return {
    order,
    defsReceived,
    registerSdkAgentsOnRegistry,
    applySessionAgent,
    run: (declarations: ThreadSessionDeclarations) =>
      registerHostAgents({ config, declarations }),
    defs: () => defsReceived[0]!,
  };
}

function agent(extra: Record<string, unknown> = {}) {
  return { description: 'Reviews diffs', prompt: 'You review diffs', ...extra };
}

let warnSpy: MockInstance;
let logSpy: MockInstance;

beforeEach(() => {
  warnSpy = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
  logSpy = vi.spyOn(runLogger, 'log').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

describe('registerHostAgents: 声明解析', () => {
  it.each([
    ['没有 agents 字段', {}],
    ['字段是字符串', { agents: 'reviewer' }],
    ['字段是数组', { agents: [{ name: 'reviewer' }] }],
    ['字段是 null', { agents: null }],
    ['字段是数字', { agents: 42 }],
  ])('没有可用的 agents 对象时是空操作：%s', async (_label, request) => {
    const harness = setup();
    await harness.run(request);
    expect(harness.registerSdkAgentsOnRegistry).not.toHaveBeenCalled();
    expect(harness.applySessionAgent).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('agents 是空对象时解析出零个定义，既不注册也不补偿', async () => {
    const harness = setup();
    await harness.run({ agents: {} });
    expect(harness.registerSdkAgentsOnRegistry).not.toHaveBeenCalled();
    expect(harness.applySessionAgent).not.toHaveBeenCalled();
  });

  it('wire 记录的键成为 agent 名，prompt 落到 systemPrompt，model 缺省为 inherit', async () => {
    const harness = setup();
    await harness.run({
      agents: {
        reviewer: agent({ tools: ['Bash', 'Read'] }),
        planner: agent({ model: 'sonnet' }),
      },
    });

    const defs = harness.defs();
    expect(defs.map((def) => def.name)).toEqual(['reviewer', 'planner']);
    expect(defs[0]).toMatchObject({
      kind: 'local',
      description: 'Reviews diffs',
      promptConfig: { systemPrompt: 'You review diffs' },
      modelConfig: { model: 'inherit' },
      toolConfig: { tools: ['Bash', 'Read'] },
    });
    expect(defs[1]!.modelConfig).toMatchObject({ model: 'sonnet' });
  });

  it.each([
    ['getter 返回 undefined', 'missing'],
    ['config 上没有 getter', 'absent'],
  ])(
    'AgentRegistry 取不到时只 warn、不抛也不补偿：%s',
    async (_label, registry) => {
      const harness = setup({ registry: registry as 'missing' | 'absent' });
      await expect(
        harness.run({ agents: { reviewer: agent() } }),
      ).resolves.toBeUndefined();
      expect(harness.applySessionAgent).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(
        '[thread-session] agents received but AgentRegistry unavailable — skipping.',
      );
    },
  );

  it.each([
    ['缺 description', { reviewer: { prompt: 'You review diffs' } }],
    ['description 是空串', { reviewer: agent({ description: '' }) }],
    ['缺 prompt', { reviewer: { description: 'Reviews diffs' } }],
    ['agent 名是空串', { '': agent() }],
    ['maxTurns 不是正整数', { reviewer: agent({ maxTurns: 0 }) }],
    ['memory 不在枚举里', { reviewer: agent({ memory: 'global' }) }],
  ])(
    'payload 解析失败时只 warn 解析器的错误文本，不注册也不补偿：%s',
    async (_label, agents) => {
      const harness = setup();
      await expect(harness.run({ agents })).resolves.toBeUndefined();

      expect(harness.registerSdkAgentsOnRegistry).not.toHaveBeenCalled();
      expect(harness.applySessionAgent).not.toHaveBeenCalled();
      const message = warnSpy.mock.calls[0]![0] as string;
      expect(
        message.startsWith('[thread-session] Invalid agents payload: '),
      ).toBe(true);
      expect(message).toContain('Validation failed');
    },
  );
});

describe('registerHostAgents: 注册结果与 applySessionAgent 补偿', () => {
  it('waits for session agent application before completing registration', async () => {
    const harness = setup();
    let resolveApplication!: () => void;
    harness.applySessionAgent.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveApplication = resolve;
      }),
    );
    const completed = vi.fn();
    const registration = harness
      .run({ agents: { reviewer: agent() } })
      .then(completed);

    await vi.waitFor(() =>
      expect(harness.applySessionAgent).toHaveBeenCalledOnce(),
    );
    expect(completed).not.toHaveBeenCalled();
    resolveApplication();
    await registration;
    expect(completed).toHaveBeenCalledOnce();
  });

  it('propagates an asynchronous session agent application failure', async () => {
    const harness = setup();
    const error = new Error('configured model is ambiguous');
    const failure = Promise.reject(error);
    // Keep the pre-fix detached promise handled while checking the caller's result.
    void failure.catch(() => {});
    harness.applySessionAgent.mockReturnValue(failure);

    await expect(harness.run({ agents: { reviewer: agent() } })).rejects.toBe(
      error,
    );
  });

  it('有 agent 注册成功时先注册再补偿一次，补偿不带参数', async () => {
    const harness = setup({ result: { registered: ['reviewer'], failed: [] } });
    await harness.run({ agents: { reviewer: agent() } });

    expect(harness.order).toEqual(['registerSdkAgents', 'applySessionAgent']);
    expect(harness.applySessionAgent).toHaveBeenCalledTimes(1);
    expect(harness.applySessionAgent).toHaveBeenCalledWith();
    expect(logSpy).toHaveBeenCalledWith(
      '[thread-session] SDK agents registered: [reviewer]',
    );
  });

  it('部分成功仍然补偿，成功与失败两条日志都出', async () => {
    const harness = setup({
      result: {
        registered: ['reviewer', 'planner'],
        failed: [{ name: 'broken', error: 'bad tools' }],
      },
    });
    await harness.run({ agents: { reviewer: agent() } });

    expect(harness.applySessionAgent).toHaveBeenCalledTimes(1);
    expect(logSpy).toHaveBeenCalledWith(
      '[thread-session] SDK agents registered: [reviewer, planner]',
    );
    expect(warnSpy).toHaveBeenCalledWith(
      '[thread-session] SDK agents failed: [broken: bad tools]',
    );
  });

  it('一个都没注册进去时不补偿，只报失败列表', async () => {
    const harness = setup({
      result: {
        registered: [],
        failed: [{ name: 'broken', error: 'bad tools' }],
      },
    });
    await harness.run({ agents: { broken: agent() } });

    expect(harness.order).toEqual(['registerSdkAgents']);
    expect(harness.applySessionAgent).not.toHaveBeenCalled();
  });

  it('失败项缺 name 时用 ? 占位，多条用分号连接', async () => {
    const harness = setup({
      result: {
        registered: [],
        failed: [{ name: 'reviewer', error: 'boom' }, { error: 'no name' }],
      },
    });
    await harness.run({ agents: { reviewer: agent() } });

    expect(warnSpy).toHaveBeenCalledWith(
      '[thread-session] SDK agents failed: [reviewer: boom; ?: no name]',
    );
  });
});
