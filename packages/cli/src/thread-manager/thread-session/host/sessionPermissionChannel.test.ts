/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 进程内会话权限通道的 ask side channel 落定事实。
 *
 * 锁住的不变量：本通道由宿主应答落定，每一次 settle 前都要把赢家写进会话的
 * ask side channel 存储——执行门（ste-bridge.ts:912-916）正是靠 `winnerParty === 'prompt'`
 * 把一次拒绝认成「用户拒绝」，从而落盘 `toolDenialKind: 'user-rejected'`
 * （:470-473）与拒绝理由 `userFeedback`（:444-446）。少了这条 record，进程内会话
 * 的拒绝元数据整块丢失（这正是 worker 过、daemon 挂的那条 e2e）。
 *
 * 1. **拒绝/批准**：均由宿主应答落定，记 winnerParty 'prompt'。
 * 2. **recheck 落定**：经 createAskHandler 的 getAskMetrics 记 winnerParty 'recheck'，
 *    证明本通道确实把 store 交了出去（否则 recheck 路径同样是瞎的）。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createAskMetricsStore,
  NotificationType,
  PermissionRequestHookOutput,
  type AskMetricsStore,
  type AskSettlement,
  type Config,
} from '@qwen-code/core';
import {
  createThreadPermissionChannel,
  installThreadPermissionHandling,
} from './sessionPermissionChannel.js';

/** 装到 fake permission 上、供测试直接驱动的 ask handler。 */
type InstalledHandler = (ctx: unknown) => Promise<AskSettlement>;

/** 抓住 createAskHandler 登记的 recheck 监听器，供测试推送重查结果。 */
interface RecheckHolder {
  listener?: (result: unknown) => void;
}

interface Harness {
  readonly askMetrics: AskMetricsStore;
  readonly canUseTool: ReturnType<typeof vi.fn>;
  readonly onInterrupt: ReturnType<typeof vi.fn>;
  readonly handler: () => InstalledHandler;
}

function setup(
  hookSystem?: unknown,
  promptChannel: 'stdio_control' | 'named_tool' = 'stdio_control',
  toolDef?: unknown,
): Harness {
  const askMetrics = createAskMetricsStore();

  let installed: InstalledHandler | undefined;
  // 只实现通道真正会碰到的成员：setAskHandler（安装口）、getRules（hook 桥建时读）。
  const permission = {
    setAskHandler: (h: unknown) => {
      installed = h as InstalledHandler | undefined;
    },
    getRules: () => ({ allow: {}, deny: {}, ask: {} }),
  };

  const config = {
    permission,
    setPermissionAskHandler: (h: unknown) => {
      installed = h as InstalledHandler | undefined;
    },
    toolRegistry: { getTool: () => toolDef },
    permissionTelemetry: { askMetrics },
    getPermissionMode: () => undefined,
    getSessionId: () => 's-1',
    // 缺省没有 hook 系统：hook 桥的 getVerdict 直接让位给通道，竞速由通道赢。
    // 通知用例传入带 fireNotificationEvent 的假 hook 系统。
    getHookSystem: () => hookSystem,
  } as unknown as Config;

  const canUseTool = vi.fn();
  const onInterrupt = vi.fn();

  createThreadPermissionChannel({
    config,
    canUseTool: canUseTool as never,
    getSignal: () => undefined,
    onInterrupt,
    promptChannel,
  });

  return {
    askMetrics,
    canUseTool,
    onInterrupt,
    handler: () => {
      if (!installed) throw new Error('ask handler 未安装');
      return installed;
    },
  };
}

/** 构造一次 ask 判定上下文；onToolCheckResult 把 recheck 监听器交回 holder。 */
function makeCtx(
  toolUseId: string,
  toolName: string,
  input: Record<string, unknown>,
  holder?: RecheckHolder,
): unknown {
  return {
    toolUseId,
    toolName,
    input,
    toolCheckResult: {
      kind: 'ask',
      reason: {
        message: `Allow ${toolName}?`,
        attribution: { type: 'other', reason: 'test' },
      },
      suggestions: [],
    },
    onToolCheckResult: (listener: (result: unknown) => void) => {
      if (holder) holder.listener = listener;
      return () => {};
    },
  };
}

describe('createThreadPermissionChannel: 拒绝落定事实', () => {
  it('passes one-shot managed approval choices and details to the host', async () => {
    const h = setup(undefined, 'stdio_control', { name: 'Bash', displayName: 'Bash', kind: 'execute' });
    h.canUseTool.mockResolvedValue({ behavior: 'allow' });
    const ctx = makeCtx('managed-presentation', 'Bash', { command: 'cat private.txt' }) as { toolCheckResult: { reason: Record<string, unknown> } };
    Object.assign(ctx.toolCheckResult.reason, { attribution: { type: 'managedRule' } });
    await h.handler()(ctx);
    const request = h.canUseTool.mock.calls[0][0];
    expect(request.details).toMatchObject({ type: 'exec', persistable: false });
    expect(request.options.map((o: { outcome: string }) => o.outcome)).toEqual(['proceed_once', 'cancel']);
  });

  it('拒绝时把 winnerParty prompt 写进 store', async () => {
    const harness = setup();
    harness.canUseTool.mockResolvedValue({
      behavior: 'deny',
      message: '用户拒绝了这次调用',
      interrupt: false,
    });

    const settlement = await harness.handler()(makeCtx('tu-deny', 'Bash', {}));

    // settle 的结果带着拒绝理由——它就是落盘 userFeedback 的来源。
    expect(settlement).toEqual({
      kind: 'rejected',
      reason: '用户拒绝了这次调用',
    });

    expect(harness.askMetrics.peek('tu-deny')).toEqual({
      winnerParty: 'prompt',
    });
  });

  it('具名工具通道照旧把询问发给宿主', async () => {
    // `--permission-prompt-tool <tool>` 与 stdio 同走宿主通道；
    // 迁移后这一岔漏装通道时，具名工具一次都不会被调用（P15 回归）。
    const harness = setup(undefined, 'named_tool');
    harness.canUseTool.mockResolvedValue({
      behavior: 'allow',
      updatedInput: undefined,
    });

    await harness.handler()(makeCtx('tu-named', 'Write', {}));

    expect(harness.canUseTool).toHaveBeenCalledTimes(1);
  });

  it('拒绝带 interrupt 时先中止 turn 再落定', async () => {
    const harness = setup();
    harness.canUseTool.mockResolvedValue({
      behavior: 'deny',
      message: 'no',
      interrupt: true,
    });

    await harness.handler()(makeCtx('tu-int', 'Bash', {}));

    expect(harness.onInterrupt).toHaveBeenCalledTimes(1);
    expect(harness.askMetrics.peek('tu-int')).toEqual({
      winnerParty: 'prompt',
    });
  });
});

describe('createThreadPermissionChannel: 批准落定事实', () => {
  it('批准携带 updatedInput 时把改动后的输入带给执行层', async () => {
    const harness = setup();
    harness.canUseTool.mockResolvedValue({
      behavior: 'allow',
      updatedInput: { command: 'ls -la' },
    });

    const settlement = await harness.handler()(
      makeCtx('tu-ok', 'Bash', { command: 'ls' }),
    );

    expect(settlement).toEqual({
      kind: 'approved',
      input: { command: 'ls -la' },
    });
    expect(harness.askMetrics.peek('tu-ok')).toEqual({
      winnerParty: 'prompt',
    });
  });

  it('批准不带 updatedInput 时按原输入批准', async () => {
    const harness = setup();
    harness.canUseTool.mockResolvedValue({
      behavior: 'allow',
      updatedInput: undefined,
    });

    const settlement = await harness.handler()(makeCtx('tu-plain', 'Bash', {}));

    expect(settlement).toEqual({ kind: 'approved' });
    expect(harness.askMetrics.peek('tu-plain')).toEqual({
      winnerParty: 'prompt',
    });
  });
});

describe('createThreadPermissionChannel: recheck 落定', () => {
  it('把 getAskMetrics 交给 createAskHandler，recheck allow 记 winnerParty recheck', async () => {
    const harness = setup();
    // 通道应答永不返回：让 recheck 抢先落定，验证走的是 createAskHandler 的
    // getAskMetrics（本通道新接上的），而非本通道自己的 record。
    harness.canUseTool.mockReturnValue(new Promise(() => {}));

    const holder: RecheckHolder = {};
    const pending = harness.handler()(
      makeCtx('tu-recheck', 'Bash', {}, holder),
    );

    // onToolCheckResult 在 handler 调用的同步段就登记了监听器。
    expect(holder.listener).toBeDefined();
    holder.listener?.({ kind: 'allow' });

    const settlement = await pending;
    expect(settlement).toEqual({ kind: 'approved' });
    expect(harness.askMetrics.peek('tu-recheck')).toEqual({
      winnerParty: 'recheck',
    });
  });
});

describe('createThreadPermissionChannel: PermissionPrompt 通知 hook', () => {
  /**
   * 假 hook 系统：fireNotificationEvent 是本组要断言的间谍；
   * firePermissionRequestEvent 返回 undefined 让 hook 桥无裁决，竞速由通道赢，
   * 于是提示照常呈现、通知照常发出（本组只关心通知，不关心 PermissionRequest）。
   */
  function makeHookSystem() {
    return {
      // rest 参数签名让 mock.calls[0] 可按位解构（type / message / payload）。
      fireNotificationEvent: vi.fn(async (..._args: unknown[]) => {}),
      firePermissionRequestEvent: vi.fn(async () => undefined),
    };
  }

  it('提示被呈现时发 Notification/permission_prompt，负载带工具事实', async () => {
    const hookSystem = makeHookSystem();
    const harness = setup(hookSystem);
    harness.canUseTool.mockResolvedValue({
      behavior: 'allow',
      updatedInput: undefined,
    });

    await harness.handler()(
      makeCtx('tu-notify', 'Bash', { command: 'ls' }),
    );

    // 其余四个通道都传 permissionPromptNotifier，本通道补上后进程内会话才会触发。
    expect(hookSystem.fireNotificationEvent).toHaveBeenCalledTimes(1);
    const [type, message, payload] =
      hookSystem.fireNotificationEvent.mock.calls[0]!;
    expect(type).toBe(NotificationType.PermissionPrompt);
    expect(message).toBe('Tool Bash requires confirmation');
    expect(payload).toMatchObject({
      toolName: 'Bash',
      toolUseId: 'tu-notify',
      input: { command: 'ls' },
      message: 'Allow Bash?',
    });
  });

  it('没有 hook 系统时呈现提示不抛错，询问照常落定', async () => {
    // getHookSystem → undefined：permissionPromptNotifier 内部什么都不发。
    const harness = setup();
    harness.canUseTool.mockResolvedValue({
      behavior: 'allow',
      updatedInput: undefined,
    });

    await expect(
      harness.handler()(makeCtx('tu-nohook', 'Bash', {})),
    ).resolves.toEqual({ kind: 'approved' });
  });
});

describe('installThreadPermissionHandling: 宿主未提供 canUseTool 的分流', () => {
  /**
   * 锁住的不变量（T09D-C02/C03 稳定红的回归钉）：宿主没提供 canUseTool——即 SDK
   * 宿主没有配置回调、worker_args 里没有 `--permission-prompt-tool stdio`——时，
   * **不得**安装 can_use_tool 控制通道，PermissionRequest hook 的裁决必须被串行
   * 采纳。装通道的后果是宿主「canUseTool callback is not provided.」的错误回包
   * （约 5ms）永远抢在 hook 聚合链（约 20ms）之前落定，hook 的 allow 被当成迟到
   * 裁决丢弃。
   *
   * 扰动验证方式：把 installThreadPermissionHandling 的分流条件改回无条件
   * `createThreadPermissionChannel(params)`，本组第 1、2 条必须变红
   * （canUseTool 被调用、落定变成 aborted），而不是编译失败。
   */

  interface HookOnlyHarness {
    readonly askMetrics: AskMetricsStore;
    readonly handler: () => InstalledHandler | undefined;
    readonly config: { confirmContinuation?: unknown };
  }

  /**
   * hook-only 分支的假会话：宿主没有提供 canUseTool（参数层判定归宿主，SDK 见
   * sessionHost 的 providesPermissionPromptChannel）。会话因此不装控制通道。
   */
  function setupHookOnly(hookSystem?: unknown): HookOnlyHarness {
    const askMetrics = createAskMetricsStore();
    let installed: InstalledHandler | undefined;
    let installCalled = false;
    const permission = {
      setAskHandler: (h: unknown) => {
        installCalled = true;
        installed = h as InstalledHandler | undefined;
      },
      getRules: () => ({ allow: {}, deny: {}, ask: {} }),
    };
    const config = {
      permission,
      setPermissionAskHandler: (h: unknown) => permission.setAskHandler(h),
      toolRegistry: { getTool: () => undefined },
      permissionTelemetry: { askMetrics },
      getPermissionMode: () => undefined,
      getModel: () => 'test-model',
      getSessionId: () => 's-1',
      getHookSystem: () => hookSystem,
      // doom-loop 守卫哨兵：分流后必须被清成 undefined（没人可问就拒绝续跑）。
      confirmContinuation: () => {},
    };

    installThreadPermissionHandling({
      config: config as unknown as Config,
      canUseTool: undefined,
      getSignal: () => undefined,
      onInterrupt: () => {},
    });

    return {
      askMetrics,
      handler: () => {
        if (!installCalled) throw new Error('setAskHandler 未被调用');
        return installed;
      },
      config,
    };
  }

  /** PermissionRequest hook 的 allow 裁决，故意晚于错误回包（模拟约 20ms 聚合链）。 */
  function allowHookSystem(delayMs = 20) {
    return {
      firePermissionRequestEvent: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return {
          finalOutput: new PermissionRequestHookOutput({
            hookSpecificOutput: {
              hookEventName: 'PermissionRequest',
              decision: { behavior: 'allow' },
            },
          }),
        };
      }),
      fireNotificationEvent: vi.fn(async (..._args: unknown[]) => {}),
    };
  }

  it('hook-only：PermissionRequest hook 的 allow 被串行采纳，且不发 can_use_tool', async () => {
    const hookSystem = allowHookSystem();
    const harness = setupHookOnly(hookSystem);
    const handler = harness.handler();
    expect(handler).toBeDefined();

    const settlement = await handler!(makeCtx('tu-hook-allow', 'Bash', {}));

    expect(settlement).toEqual({ kind: 'approved' });
    expect(hookSystem.firePermissionRequestEvent).toHaveBeenCalledTimes(1);
    // ask side channel 归因到 hook 串行裁决，而不是通道或 recheck。
    expect(harness.askMetrics.peek('tu-hook-allow')).toEqual({
      winnerParty: 'hook',
    });
    // doom-loop 守卫：没人可问，续跑确认必须被清掉（拒绝而非假定同意）。
    expect(harness.config.confirmContinuation).toBeUndefined();
  });

  it('hook-only：hook 无裁决时 fail-closed 拒绝', async () => {
    const hookSystem = {
      firePermissionRequestEvent: vi.fn(async () => undefined),
      fireNotificationEvent: vi.fn(async (..._args: unknown[]) => {}),
    };
    const harness = setupHookOnly(hookSystem);

    const settlement = await harness.handler()!(
      makeCtx('tu-hook-none', 'Bash', {}),
    );

    expect(settlement).toEqual({ kind: 'rejected' });
  });

  it('hook-only：没有 hook 系统时不装 handler（等价卸载，每次 ask 直接拒绝）', () => {
    const harness = setupHookOnly(undefined);
    // createPermissionRequestHookBridge 在无 hook 系统时仍返回桥（getVerdict 内部
    // 让位），因此装的是 hook-only 包装 handler；它对无裁决的回答就是拒绝。
    // 关键不变量：无论如何都**没有**通道 handler，宿主回调从不被接线。
    expect(harness.config.confirmContinuation).toBeUndefined();
  });

  it('宿主提供了 canUseTool 时维持原通道：询问照旧发给宿主', async () => {
    // flag=true 的对照组：证明分流没有把「有回调」的宿主也降级成 hook-only。
    const askMetrics = createAskMetricsStore();
    let installed: InstalledHandler | undefined;
    const permission = {
      setAskHandler: (h: unknown) => {
        installed = h as InstalledHandler | undefined;
      },
      getRules: () => ({ allow: {}, deny: {}, ask: {} }),
    };
    const config = {
      permission,
      setPermissionAskHandler: (h: unknown) => permission.setAskHandler(h),
      toolRegistry: { getTool: () => undefined },
      permissionTelemetry: { askMetrics },
      getPermissionMode: () => undefined,
      getSessionId: () => 's-1',
      getHookSystem: () => undefined,
      confirmContinuation: () => {},
    };
    const canUseTool = vi.fn().mockResolvedValue({
      behavior: 'allow',
      updatedInput: undefined,
    });

    installThreadPermissionHandling({
      config: config as unknown as Config,
      canUseTool: canUseTool as never,
      permissionPromptChannel: 'stdio_control',
      getSignal: () => undefined,
      onInterrupt: () => {},
    });

    expect(installed).toBeDefined();
    const settlement = await installed!(makeCtx('tu-channel', 'Bash', {}));
    expect(settlement).toEqual({ kind: 'approved' });
    expect(canUseTool).toHaveBeenCalledTimes(1);
    // 有宿主可问时 doom-loop 守卫的续跑确认也必须接上，而不是保持 undefined。
    expect(config.confirmContinuation).toBeTypeOf('function');
  });
});

describe('installThreadPermissionHandling: doom-loop 续跑确认', () => {
  /**
   * 锁住的不变量：宿主提供了 canUseTool 时，doom-loop 守卫第 5 次相同调用必须走
   * can_use_tool 问宿主，而不是因为 confirmContinuation 缺席被直接拒绝、整轮终止。
   * 询问帧要带 repeated_tool_call 的 details / permission_kind / options（与 worker 同形），
   * 批准作用域与拒绝理由原样映射回 ContinuationDecision。
   */

  const request = {
    kind: 'repeated_tool_call',
    title: 'Repeated tool call detected',
    toolName: 'wait_chat_sessions',
    repeatCount: 5,
    threshold: 5,
    inputPreview: '{"sessionIds":["6314e57b-0000-0000-0000-000000000000"]}',
  } as const;

  function setupContinuation(): {
    readonly canUseTool: ReturnType<typeof vi.fn>;
    readonly confirm: NonNullable<Config['confirmContinuation']>;
  } {
    const askMetrics = createAskMetricsStore();
    const permission = {
      setAskHandler: (_h: unknown) => {},
      getRules: () => ({ allow: {}, deny: {}, ask: {} }),
    };
    const config: {
      confirmContinuation?: Config['confirmContinuation'];
      [key: string]: unknown;
    } = {
      permission,
      setPermissionAskHandler: (h: unknown) => permission.setAskHandler(h),
      toolRegistry: { getTool: () => undefined },
      permissionTelemetry: { askMetrics },
      getPermissionMode: () => undefined,
      getSessionId: () => 's-1',
      getHookSystem: () => undefined,
      confirmContinuation: undefined,
    };
    const canUseTool = vi.fn();

    installThreadPermissionHandling({
      config: config as unknown as Config,
      canUseTool: canUseTool as never,
      permissionPromptChannel: 'stdio_control',
      getSignal: () => undefined,
      onInterrupt: () => {},
    });

    if (!config.confirmContinuation) {
      throw new Error('宿主有 canUseTool 时 confirmContinuation 必须被接线');
    }
    return { canUseTool, confirm: config.confirmContinuation };
  }

  it('续跑确认发 can_use_tool，并带 repeated_tool_call 的 details 与选项', async () => {
    const { canUseTool, confirm } = setupContinuation();
    canUseTool.mockResolvedValue({
      behavior: 'allow',
      updatedInput: undefined,
    });

    await expect(confirm(request)).resolves.toEqual({ outcome: 'once' });

    expect(canUseTool).toHaveBeenCalledTimes(1);
    const [wireRequest] = canUseTool.mock.calls[0]!;
    expect(wireRequest).toMatchObject({
      toolName: 'wait_chat_sessions',
      input: {},
      title: 'Repeated tool call detected',
      description: 'Repeated wait_chat_sessions call with identical input',
      permissionKind: 'repeated_tool_call',
      details: {
        type: 'repeated_tool_call',
        title: 'Repeated tool call detected',
        toolName: 'wait_chat_sessions',
        repeatCount: 5,
        threshold: 5,
        inputPreview: request.inputPreview,
      },
    });
    expect(wireRequest.toolUseId).toEqual(expect.any(String));
    expect(wireRequest.options).toEqual([
      { outcome: 'proceed_once', name: 'Continue once', allowed: true },
      {
        outcome: 'proceed_always',
        name: 'Always continue this exact call',
        allowed: true,
      },
      { outcome: 'cancel', name: 'Stop', allowed: false },
    ]);
  });

  it('permissionScope=session 映射为会话级放行，其余批准只放行一次', async () => {
    const { canUseTool, confirm } = setupContinuation();
    canUseTool
      .mockResolvedValueOnce({
        behavior: 'allow',
        updatedInput: undefined,
        permissionScope: 'once',
      })
      .mockResolvedValueOnce({
        behavior: 'allow',
        updatedInput: undefined,
        permissionScope: 'session',
      });

    await expect(confirm(request)).resolves.toEqual({ outcome: 'once' });
    await expect(confirm(request)).resolves.toEqual({ outcome: 'session' });
  });

  it('拒绝理由原样带回；通道失败（撤回 / 中止）结算成拒绝而不是批准', async () => {
    const { canUseTool, confirm } = setupContinuation();
    canUseTool
      .mockResolvedValueOnce({
        behavior: 'deny',
        message: 'stop the loop',
        interrupt: false,
      })
      .mockRejectedValueOnce(new Error('aborted'));

    await expect(confirm(request)).resolves.toEqual({
      outcome: 'deny',
      reason: 'stop the loop',
    });
    await expect(confirm(request)).resolves.toEqual({
      outcome: 'deny',
      reason: 'aborted',
    });
  });
});
