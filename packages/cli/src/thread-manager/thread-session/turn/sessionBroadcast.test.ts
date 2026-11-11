/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LoadedSettings } from '../../../config/settings.js';

/**
 * 广播面要保护的不变量按重要性排：
 *
 * 断言对象是语义通知（`ThreadNotice`），不是 wire 帧：subtype 字符串、`uuid`、
 * `session_id` 信封与蛇形字段名都归宿主编解码器（映射与 wire 注意事项见
 * sessionBroadcast.ts 文件头）。每条通知与宿主渲染的帧一一对应，所以下面按帧立的
 * 不变量原样平移成按通知立。
 *
 * 1. **`statusChanged` 通知的自比对按「原始」permissionMode，不是按通知携带的那个值。**
 *    单会话下它必须与 worker 逐帧一致（worker 无自比对，靠 Config.setPermissionMode
 *    只在 currentMode !== mode 时 emit 来保证不发重复帧）；多会话下它必须吃掉串台帧。
 *    缓存键取映射后的值会把 worker 会发的两帧合成一帧——那是真的 wire 分叉，所以专门
 *    用「两个原始模式映射到同一个 SDK 值」这条用例锁住。
 * 2. **两个能力位门禁**（supportsAvailableModelsUpdate / supportsCommandsChanged）。
 *    没声明就一条通知都不发，声明了要立刻补发一次当前状态。
 * 3. **dispose 顺序**：worker 在 :5491-5493 写明了「停止接纳命令变更回调必须早于
 *    drain」，且 coreEvents 退订在最后。顺序错了会在 teardown 期间漏发或重发帧。
 * 4. **dispose 幂等**：close() 与 terminate() 可能都走到这里。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  coreEvents,
  GoalStatus,
  OutputFormat,
  type Config,
  type Goal,
} from '@qwen-code/core';
import type { ThreadNotice } from '../contract/hostContext.js';
import type { SessionQueryRunner } from '../query/sessionQueryRunner.js';

/** setup() 装配的会话 ID：发射器打这个戳才会进本会话的 onSessionEvent 过滤。 */
const MY_SESSION = 's-mine';
/** 别的会话：用它打戳的事件必须被归属过滤挡在本会话 handler 之外。 */
const OTHER_SESSION = 's-other';

/** 本会话 config.getGoalManager() 回读的 Goal（buildGoalSnapshot 的输入形状）。 */
function makeGoal(id: string): Goal {
  return {
    id,
    objective: id,
    status: GoalStatus.Active,
    turnsUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** GoalUpdated / GoalCleared payload 内嵌的 goal 形状（与 core Goal 不同，无时间戳）。 */
function payloadGoal(id: string) {
  return {
    id,
    objective: id,
    status: 'active',
    turnsUsed: 0,
    timeUsedSeconds: 0,
  };
}

const h = vi.hoisted(() => {
  /** 记录 dispose 期间的调用顺序，用来锁 worker 的清理链不变量。 */
  const disposeOrder: string[] = [];
  return {
    disposeOrder,
    buildAvailableModelsSnapshot: vi.fn(),
    buildSdkCommandSnapshot: vi.fn(),
    getSdkPermissionMode: vi.fn(),
    artifactRuntimes: [] as Array<{
      subscribers: Array<(artifacts: unknown, observation?: unknown) => void>;
      cancelHostRecovery: () => void;
      initialize: ReturnType<typeof vi.fn>;
      observeEvent: ReturnType<typeof vi.fn>;
    }>,
    publishers: [] as Array<{ drain: () => Promise<void> }>,
  };
});

vi.mock('../../../worker/availableModelsSnapshot.js', () => ({
  buildAvailableModelsSnapshot: h.buildAvailableModelsSnapshot,
}));

vi.mock('../../../session/permissionMode.js', () => ({
  getSdkPermissionMode: h.getSdkPermissionMode,
}));

vi.mock('../../../sdkCommandCatalog.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../sdkCommandCatalog.js')>();
  type SDKSlashCommand = Parameters<
    InstanceType<typeof actual.SdkCommandCatalogPublisher>['start']
  >[0][number];
  class SpiedPublisher extends actual.SdkCommandCatalogPublisher {
    constructor(
      load: () => Promise<SDKSlashCommand[]>,
      publish: (commands: SDKSlashCommand[]) => void,
    ) {
      super(load, publish);
      // 直接改实例方法：广播面调的是这个实例，包一层代理对象是没人调的。
      const rawDrain = this.drain.bind(this);
      const rawDispose = this.dispose.bind(this);
      this.drain = () => {
        h.disposeOrder.push('drain');
        return rawDrain();
      };
      this.dispose = () => {
        h.disposeOrder.push('publisherDispose');
        rawDispose();
      };
      // 给用例一个不记账的 drain 手柄，手动 flush 时不污染 disposeOrder。
      h.publishers.push({ drain: rawDrain });
    }
  }
  return {
    ...actual,
    SdkCommandCatalogPublisher: SpiedPublisher,
    // 必须一起替掉：真版本会经 CommandService 去读插件、workflow 等一整条装配链，
    // 测试里的 config 是个只有几个 getter 的壳，撑不住。
    buildSdkCommandSnapshot: h.buildSdkCommandSnapshot,
  };
});

vi.mock('../../../session/artifacts/sessionArtifactRuntime.js', () => {
  class FakeSessionArtifactRuntime {
    readonly subscribers: Array<
      (artifacts: unknown, observation?: unknown) => void
    > = [];
    constructor() {
      h.artifactRuntimes.push(this as never);
    }
    subscribe(subscriber: (artifacts: unknown, observation?: unknown) => void) {
      this.subscribers.push(subscriber);
      return () => {
        h.disposeOrder.push('unsubscribeArtifact');
        const index = this.subscribers.indexOf(subscriber);
        if (index >= 0) this.subscribers.splice(index, 1);
      };
    }
    readonly initialize = vi.fn(
      async (
        messages: readonly unknown[],
        options?: { readonly forcePublish?: boolean },
      ) => {
        void messages;
        void options;
        return null;
      },
    );
    readonly observeEvent = vi.fn(async (_event: unknown) => null);
    cancelHostRecovery() {
      h.disposeOrder.push('cancelHostRecovery');
    }
  }
  return {
    SessionArtifactRuntime: FakeSessionArtifactRuntime,
    createSessionArtifactRuntime: () => new FakeSessionArtifactRuntime(),
  };
});

import { createSessionBroadcast } from './sessionBroadcast.js';

const broadcasts: Array<ReturnType<typeof createSessionBroadcast>> = [];
afterEach(async () => {
  await Promise.all(
    broadcasts.splice(0).map((broadcast) => broadcast.dispose()),
  );
});

interface Harness {
  state: {
    permissionMode: string;
    model: string;
    identity: string;
    sessionId: string;
    goal: Goal | null;
  };
  commandListeners: Array<() => void>;
  permissionListeners: Set<() => void>;
  restrictions: Map<string, string>;
  emitNotice: ReturnType<typeof vi.fn>;
  broadcast: ReturnType<typeof createSessionBroadcast>;
}

function setup(
  options: {
    outputFormat?: OutputFormat;
    runner?: SessionQueryRunner;
    permissionListeners?: Set<() => void>;
    restrictions?: Map<string, string>;
  } = {},
): Harness {
  h.disposeOrder.length = 0;
  h.artifactRuntimes.length = 0;
  h.publishers.length = 0;
  h.buildAvailableModelsSnapshot.mockReset();
  // setup() 会 reset 掉 describe 级 beforeEach 里设的实现，所以缺省实现要在这里给。
  h.buildAvailableModelsSnapshot.mockImplementation(async (config: Config) => ({
    models: [{ modelId: config.getModel() }],
    currentModel: config.getModel(),
    fingerprint: `fp:${config.getModel()}`,
  }));
  h.buildSdkCommandSnapshot.mockReset();
  h.buildSdkCommandSnapshot.mockResolvedValue([]);
  h.getSdkPermissionMode.mockReset();

  const state = {
    permissionMode: 'default',
    model: 'm-1',
    identity: 'account-1',
    sessionId: MY_SESSION,
    goal: null as Goal | null,
  };
  const commandListeners: Array<() => void> = [];
  const permissionListeners = options.permissionListeners ?? new Set<() => void>();
  const restrictions = options.restrictions ?? new Map<string, string>();
  const config = {
    getSessionId: () => state.sessionId,
    getModelRequestIdentity: () => state.identity,
    getHookSystem: () => undefined,
    isSettingSourceAllowed: () => false,
    getOutputFormat: () => options.outputFormat ?? OutputFormat.STREAM_JSON,
    getPermissionMode: () => state.permissionMode,
    getPermissionModeRestriction: (mode: string) => restrictions.get(mode),
    getProcessPermissionManager: () => ({
      subscribePolicyChanges: (listener: () => void) => {
        permissionListeners.add(listener);
        return () => {
          permissionListeners.delete(listener);
        };
      },
    }),
    getModel: () => state.model,
    getWorkingDir: () => '/wd',
    getWorkspaceContext: () => ({ getDirectories: () => ['/wd'] }),
    // reportGoalUpdated 命中本会话事件后回读它；缺省 null 让所有旧 harness 在
    // 「读不到就不发」处早退，goal 用例只在自己的 harness 上放 goal。
    getGoalManager: () => ({ getGoal: () => state.goal }),
    getStartupRuntime: () => ({
      onChange: (event: string, listener: () => void) => {
        if (event === 'commands') commandListeners.push(listener);
        return () => {
          h.disposeOrder.push('closeAdmission');
          const index = commandListeners.indexOf(listener);
          if (index >= 0) commandListeners.splice(index, 1);
        };
      },
    }),
  } as unknown as Config;

  const emitNotice = vi.fn();
  const broadcast = createSessionBroadcast({
    config,
    sessionId: MY_SESSION,
    emitNotice,
    getSettings: () => ({ errors: [] }) as unknown as LoadedSettings,
    getQueryRunner: () => options.runner ?? null,
    isIndependentPlanModeControls: () => false,
  });

  broadcasts.push(broadcast);
  return { state, commandListeners, permissionListeners, restrictions, emitNotice, broadcast };
}

/** 从 mock 里取已发出的通知；每次现取，避免 setup 时快照过期。 */
function emittedNotices(emitNotice: ReturnType<typeof vi.fn>): ThreadNotice[] {
  return emitNotice.mock.calls.map((call) => call[0] as ThreadNotice);
}

type NoticeOfKind<K extends ThreadNotice['kind']> = Extract<
  ThreadNotice,
  { kind: K }
>;

function noticesOfKind<K extends ThreadNotice['kind']>(
  emitNotice: ReturnType<typeof vi.fn>,
  kind: K,
): Array<NoticeOfKind<K>> {
  return emittedNotices(emitNotice).filter(
    (notice) => notice.kind === kind,
  ) as Array<NoticeOfKind<K>>;
}

/**
 * SDK 的 `SlashCommand` 三个字段全是必填（protocol/common.d.ts:101-105），而命令目录
 * 的指纹是按整份快照算的——`initialCommands` 与 `buildSdkCommandSnapshot` 的返回必须
 * 逐字段一致，否则「指纹相同不发帧」这条会被自己造出来的差异推翻。
 */
function slashCommand(name: string) {
  return { name, description: '', argumentHint: '' };
}

describe('sessionBroadcast: statusChanged 通知（宿主渲染为 status 帧）', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = setup();
    h.getSdkPermissionMode.mockReturnValue('sdk-mapped');
  });

  it('本会话原始模式变了就发一条通知，与 worker 逐帧一致', () => {
    harness.state.permissionMode = 'plan';
    coreEvents.emitPermissionModeChanged(
      MY_SESSION,
      'plan' as never,
      'default' as never,
    );
    harness.state.permissionMode = 'acceptEdits';
    coreEvents.emitPermissionModeChanged(
      MY_SESSION,
      'acceptEdits' as never,
      'plan' as never,
    );

    const notices = noticesOfKind(harness.emitNotice, 'statusChanged');
    expect(notices).toHaveLength(2);
    // 通知携带的是解析后的权限模式值（SDK 映射视图）；帧信封归宿主，不在断言里。
    expect(notices[0]).toEqual({
      kind: 'statusChanged',
      permissionMode: 'sdk-mapped',
    });
  });

  /**
   * 多会话的核心不变量，现在是两道挡板各咬一口：
   * - 本会话事件但自己的模式没变 → 自比对吃掉（与 worker 帧序对齐的那道挡板）；
   * - 别的会话的事件 → onSessionEvent 的归属过滤挡在 handler 之外。第二段刻意把
   *   本地模式也改掉：若把过滤拆除，handler 会运行、自比对会发现模式变了并发出
   *   通知——断言因此咬的是归属过滤本身，而不是碰巧被自比对兜住。
   */
  it('别的会话改模式时本会话不发通知', () => {
    coreEvents.emitPermissionModeChanged(
      MY_SESSION,
      'plan' as never,
      'default' as never,
    );
    expect(harness.emitNotice).not.toHaveBeenCalled();

    harness.state.permissionMode = 'acceptEdits';
    coreEvents.emitPermissionModeChanged(
      OTHER_SESSION,
      'plan' as never,
      'default' as never,
    );
    coreEvents.emitPermissionModeChanged(
      OTHER_SESSION,
      'acceptEdits' as never,
      'plan' as never,
    );

    expect(harness.emitNotice).not.toHaveBeenCalled();
  });

  /**
   * 缓存键必须是原始模式。getSdkPermissionMode 是多对一映射，若按映射后的值比对，
   * 下面两次变更会被合成一条通知——worker 会发两帧，那就是 wire 分叉。
   */
  it('两个原始模式映射到同一个 SDK 值时仍发两条通知', () => {
    h.getSdkPermissionMode.mockReturnValue('default');

    harness.state.permissionMode = 'plan';
    coreEvents.emitPermissionModeChanged(
      MY_SESSION,
      'plan' as never,
      'default' as never,
    );
    harness.state.permissionMode = 'acceptEdits';
    coreEvents.emitPermissionModeChanged(
      MY_SESSION,
      'acceptEdits' as never,
      'plan' as never,
    );

    const notices = noticesOfKind(harness.emitNotice, 'statusChanged');
    expect(notices).toHaveLength(2);
    expect(notices.every((notice) => notice.permissionMode === 'default')).toBe(
      true,
    );
  });

  it('独立 plan 控制面下通知携带原始视图，否则携带 SDK 映射视图', () => {
    const independent = setup();
    // 重新装配一份带独立控制面的广播面
    independent.broadcast.dispose();
    const state = { permissionMode: 'default' };
    const config = {
      getSessionId: () => 's-indep',
      getHookSystem: () => undefined,
      isSettingSourceAllowed: () => false,
      getOutputFormat: () => OutputFormat.STREAM_JSON,
      getPermissionMode: () => state.permissionMode,
      getModel: () => 'm-1',
      getWorkingDir: () => '/wd',
      getWorkspaceContext: () => ({ getDirectories: () => ['/wd'] }),
      getStartupRuntime: () => ({ onChange: () => () => {} }),
    } as unknown as Config;
    const emitNotice = vi.fn();
    createSessionBroadcast({
      config,
      sessionId: 's-indep',
      emitNotice,
      getSettings: () => ({ errors: [] }) as unknown as LoadedSettings,
      getQueryRunner: () => null,
      isIndependentPlanModeControls: () => true,
    });

    state.permissionMode = 'plan';
    coreEvents.emitPermissionModeChanged(
      's-indep',
      'plan' as never,
      'default' as never,
    );

    const notices = noticesOfKind(emitNotice, 'statusChanged');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.permissionMode).toBe('plan');
  });

  it('dispose 之后不再发 statusChanged 通知', async () => {
    await harness.broadcast.dispose();
    harness.state.permissionMode = 'plan';
    coreEvents.emitPermissionModeChanged(
      MY_SESSION,
      'plan' as never,
      'default' as never,
    );
    expect(harness.emitNotice).not.toHaveBeenCalled();
  });
});

describe('sessionBroadcast: availableModelsChanged 通知（宿主渲染为 available_models_update 帧）', () => {
  it('未声明能力位时模型变更一条通知都不发', () => {
    const harness = setup();
    harness.broadcast.startAfterInitialize({
      declarations: {},
      initialCommands: [],
    });
    coreEvents.emitModelChanged(MY_SESSION, 'm-2');
    expect(noticesOfKind(harness.emitNotice, 'availableModelsChanged')).toEqual(
      [],
    );
  });

  it('声明能力位后立即补发一条携带当前目录快照的通知', async () => {
    const harness = setup();
    harness.broadcast.startAfterInitialize({
      declarations: { supportsAvailableModelsUpdate: true },
      initialCommands: [],
    });

    // models 是原始目录快照原样透传——toSdkModelInfo 那层 wire 投影归宿主
    // （见 sessionBroadcast.ts 文件头），所以这里断言的是快照本身。
    await vi.waitFor(() =>
      expect(
        noticesOfKind(harness.emitNotice, 'availableModelsChanged'),
      ).toHaveLength(1),
    );
    const notices = noticesOfKind(harness.emitNotice, 'availableModelsChanged');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toEqual({
      kind: 'availableModelsChanged',
      models: [{ modelId: 'm-1' }],
      currentModel: 'm-1',
    });
  });

  it('fingerprint 未变时后续模型事件不再发通知，变了才发', async () => {
    const harness = setup();
    harness.broadcast.startAfterInitialize({
      declarations: { supportsAvailableModelsUpdate: true },
      initialCommands: [],
    });
    await vi.waitFor(() =>
      expect(
        noticesOfKind(harness.emitNotice, 'availableModelsChanged'),
      ).toHaveLength(1),
    );
    const countAfterStart = harness.emitNotice.mock.calls.length;

    // 本会话的事件但自己的模型没变：fingerprint 自比对吃掉——这道挡板与 worker
    // 帧序对齐，独立于归属过滤存在。
    coreEvents.emitModelChanged(MY_SESSION, 'm-1');
    await Promise.resolve();
    expect(harness.emitNotice.mock.calls).toHaveLength(countAfterStart);

    // 别的会话换了模型，且本会话本地模型恰好也变了：归属过滤必须把事件挡在
    // handler 之外——若把 onSessionEvent 拆掉，fingerprint 变了就会发帧，
    // 这条断言因此咬的是归属过滤本身，而不是碰巧被自比对兜住。
    harness.state.model = 'm-2';
    coreEvents.emitModelChanged(OTHER_SESSION, 'm-other');
    expect(harness.emitNotice.mock.calls).toHaveLength(countAfterStart);

    // 本会话真的变了：发。
    coreEvents.emitModelChanged(MY_SESSION, 'm-2');
    await vi.waitFor(() =>
      expect(harness.emitNotice.mock.calls).toHaveLength(countAfterStart + 1),
    );
  });

  it.each(['model', 'account', 'session', 'dispose', 'newer-query'])(
    '目录查询丢弃 %s 变化后的迟到通知',
    async (change) => {
      const harness = setup();
      let finish!: (value: {
        models: unknown[];
        currentModel: string;
        fingerprint: string;
      }) => void;
      h.buildAvailableModelsSnapshot.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      harness.broadcast.startAfterInitialize({
        declarations: { supportsAvailableModelsUpdate: true },
        initialCommands: [],
      });
      if (change === 'model') harness.state.model = 'm-2';
      if (change === 'account') harness.state.identity = 'account-2';
      if (change === 'session') harness.state.sessionId = OTHER_SESSION;
      if (change === 'dispose') await harness.broadcast.dispose();
      if (change === 'newer-query') {
        harness.state.model = 'm-2';
        coreEvents.emitModelChanged(MY_SESSION, 'm-2');
        await vi.waitFor(() =>
          expect(
            noticesOfKind(harness.emitNotice, 'availableModelsChanged'),
          ).toHaveLength(1),
        );
      }
      finish({ models: [], currentModel: 'm-1', fingerprint: 'stale' });
      await Promise.resolve();
      const notices = noticesOfKind(
        harness.emitNotice,
        'availableModelsChanged',
      );
      expect(notices).toHaveLength(change === 'newer-query' ? 1 : 0);
      expect(notices.every((notice) => notice.currentModel === 'm-2')).toBe(
        true,
      );
    },
  );
});

describe('sessionBroadcast: goal / plan 通知的会话归属过滤', () => {
  /**
   * goal / plan 的 payload 本身就是数据，无法自比对；归属过滤（onSessionEvent）是
   * 唯一挡板。goal 尤其致命：handler 命中后要回读 config.getGoalManager()，那是
   * 单槽单例，跨会话事件一旦进 handler 就会触到别人的槽（见生产文件头）。
   */
  it('plan：本会话事件发通知，别的会话事件一条都不发', () => {
    const harness = setup();

    coreEvents.emitPlanStateChanged(OTHER_SESSION, true);
    coreEvents.emitPlanStateChanged(OTHER_SESSION, false);
    expect(harness.emitNotice).not.toHaveBeenCalled();

    coreEvents.emitPlanStateChanged(MY_SESSION, true);
    expect(noticesOfKind(harness.emitNotice, 'planModeChanged')).toEqual([
      { kind: 'planModeChanged', active: true },
    ]);

    // 归属过滤不因本会话曾经收到过事件而放宽。
    coreEvents.emitPlanStateChanged(OTHER_SESSION, false);
    expect(noticesOfKind(harness.emitNotice, 'planModeChanged')).toHaveLength(
      1,
    );
  });

  it('goal：只有本会话事件发通知，跨会话事件被归属过滤挡住', () => {
    const harness = setup();
    // 本会话槽里放了 goal：若归属过滤被拆掉，跨会话事件会进 handler、回读到它
    // 并发出通知——断言因此咬的是过滤本身，而不是「碰巧读不到 goal」。
    harness.state.goal = makeGoal('goal-1');

    coreEvents.emitGoalUpdated({
      sessionId: OTHER_SESSION,
      goal: payloadGoal('goal-x'),
    });
    coreEvents.emitGoalCleared({
      sessionId: OTHER_SESSION,
      goalId: 'goal-x',
      timestamp: 1,
    });
    expect(harness.emitNotice).not.toHaveBeenCalled();

    coreEvents.emitGoalUpdated({
      sessionId: MY_SESSION,
      goal: payloadGoal('goal-1'),
      reason: 'safety-limit',
    });
    const updated = noticesOfKind(harness.emitNotice, 'goalChanged');
    expect(updated).toHaveLength(1);
    // goal 是 buildGoalSnapshot 的 wire 快照原样透传——handler 回读的是本会话
    // config 里的 goal，不是 payload 带来的那份；reason 原样带出。
    expect(updated[0]!.goal).toEqual(
      expect.objectContaining({ id: 'goal-1', status: 'active' }),
    );
    expect(updated[0]!.reason).toBe('safety-limit');

    coreEvents.emitGoalCleared({
      sessionId: MY_SESSION,
      goalId: 'goal-1',
      timestamp: 1,
      reason: 'user',
    });
    expect(noticesOfKind(harness.emitNotice, 'goalCleared')).toEqual([
      { kind: 'goalCleared', goalId: 'goal-1', reason: 'user' },
    ]);
  });

  it('dispose 之后本会话的 goal / plan 事件也不再发通知（退订走 onSessionEvent 的返回函数）', async () => {
    const harness = setup();
    harness.state.goal = makeGoal('goal-1');
    await harness.broadcast.dispose();

    coreEvents.emitPlanStateChanged(MY_SESSION, true);
    coreEvents.emitGoalUpdated({
      sessionId: MY_SESSION,
      goal: payloadGoal('goal-1'),
    });
    coreEvents.emitGoalCleared({
      sessionId: MY_SESSION,
      goalId: 'goal-1',
      timestamp: 1,
    });
    expect(harness.emitNotice).not.toHaveBeenCalled();
  });
});

describe('sessionBroadcast: commandsChanged 通知（宿主渲染为 commands_changed 帧）', () => {
  it('未声明能力位时 publisher 不 start，目录变更不发通知', async () => {
    const harness = setup();
    h.buildSdkCommandSnapshot.mockResolvedValue([{ name: 'c-1' }]);
    harness.broadcast.startAfterInitialize({
      declarations: {},
      initialCommands: [],
    });

    expect(harness.commandListeners).toHaveLength(1);
    harness.commandListeners[0]!();
    await h.publishers[0]!.drain();

    expect(noticesOfKind(harness.emitNotice, 'commandsChanged')).toHaveLength(
      0,
    );
  });

  it('声明能力位后用回包里的 commands 当初始指纹，目录真变了才发通知', async () => {
    const harness = setup();
    h.buildSdkCommandSnapshot.mockResolvedValue([slashCommand('c-1')]);
    harness.broadcast.startAfterInitialize({
      declarations: { supportsCommandsChanged: true },
      initialCommands: [slashCommand('c-1')],
    });
    // start() 会立刻 reconcile 一次；指纹相同所以不发通知。
    await h.publishers[0]!.drain();
    expect(noticesOfKind(harness.emitNotice, 'commandsChanged')).toHaveLength(
      0,
    );

    h.buildSdkCommandSnapshot.mockResolvedValue([
      slashCommand('c-1'),
      slashCommand('c-2'),
    ]);
    harness.commandListeners[0]!();
    await h.publishers[0]!.drain();

    const notices = noticesOfKind(harness.emitNotice, 'commandsChanged');
    expect(notices).toHaveLength(1);
    // 命令目录快照原样透传，宿主渲染进帧。
    expect(notices[0]!.commands).toEqual([
      slashCommand('c-1'),
      slashCommand('c-2'),
    ]);
  });
});

describe('sessionBroadcast: artifactsChanged 通知（宿主渲染为 artifacts_update 帧）与 dispose', () => {
  it('没有 QueryRunner 时也加载一次持久 Artifact 状态', async () => {
    const harness = setup();
    const runtime = h.artifactRuntimes[0]!;

    await harness.broadcast.initializeArtifacts();
    await harness.broadcast.initializeArtifacts();

    expect(runtime.initialize).toHaveBeenCalledTimes(1);
    expect(runtime.initialize).toHaveBeenCalledWith([]);
  });

  it('QueryRunner 就绪后只合并一次 transcript Artifact 历史', async () => {
    const messages = [{ type: 'user', uuid: 'history-1' }];
    const harness = setup({
      runner: { getMessages: () => messages } as never,
    });
    const runtime = h.artifactRuntimes[0]!;

    await harness.broadcast.initializeArtifacts();
    await harness.broadcast.initializeArtifacts();

    expect(runtime.initialize.mock.calls).toEqual([
      [[]],
      [messages, { forcePublish: false }],
    ]);
  });

  it('artifact 运行时 publish 时转成 artifactsChanged 通知', () => {
    const harness = setup();
    const runtime = h.artifactRuntimes[0]!;
    runtime.subscribers[0]!([{ path: '/a' }]);

    const notices = noticesOfKind(harness.emitNotice, 'artifactsChanged');
    expect(notices).toHaveLength(1);
    // 产物快照原样透传，宿主渲染进帧。
    expect(notices[0]).toEqual({
      kind: 'artifactsChanged',
      artifacts: [{ path: '/a' }],
    });
  });

  it('透传本次 observation 的 changedArtifacts', () => {
    const harness = setup();
    const runtime = h.artifactRuntimes[0]!;
    runtime.subscribers[0]!([{ path: '/a' }, { path: '/b' }], {
      changedArtifacts: [{ path: '/b' }],
    });

    expect(noticesOfKind(harness.emitNotice, 'artifactsChanged')).toEqual([
      {
        kind: 'artifactsChanged',
        artifacts: [{ path: '/a' }, { path: '/b' }],
        changedArtifacts: [{ path: '/b' }],
      },
    ]);
  });

  it('waitForArtifacts 等待已接纳的 observation 完成', async () => {
    const harness = setup();
    const runtime = h.artifactRuntimes[0]!;
    let resolveObservation: () => void = () => {};
    runtime.observeEvent.mockImplementationOnce(
      () =>
        new Promise<null>((resolve) => {
          resolveObservation = () => resolve(null);
        }),
    );
    harness.broadcast.observeQueryEvent({ type: 'request_start' } as never);
    let flushed = false;
    const flush = harness.broadcast.waitForArtifacts().then(() => {
      flushed = true;
    });

    await vi.waitFor(() => expect(runtime.observeEvent).toHaveBeenCalledOnce());
    expect(flushed).toBe(false);
    resolveObservation();
    await flush;
    expect(flushed).toBe(true);
  });

  /**
   * 非 stream-json 时整段 coreEvents 订阅与命令目录 publisher 都不装配（worker 的条件是
   * `isStreamJson && !bare`）。注意 `startAfterInitialize` 里那次强制补发**不受**
   * isStreamJson 门禁——worker 也一样（:5361-5363 只判 bare 与能力位），所以这条用例
   * 刻意不声明 supportsAvailableModelsUpdate，只验订阅面。
   */
  it('非 stream-json 输出下不订阅 coreEvents、不装配命令目录、artifact publish 不出通知', () => {
    const harness = setup({ outputFormat: OutputFormat.JSON });
    harness.broadcast.startAfterInitialize({
      declarations: { supportsCommandsChanged: true },
      initialCommands: [],
    });

    expect(harness.commandListeners).toHaveLength(0);
    expect(h.publishers).toHaveLength(0);

    harness.state.model = 'm-2';
    coreEvents.emitModelChanged(MY_SESSION, 'm-2');
    harness.state.permissionMode = 'plan';
    coreEvents.emitPermissionModeChanged(
      MY_SESSION,
      'plan' as never,
      'default' as never,
    );
    h.artifactRuntimes[0]!.subscribers[0]!([{ path: '/a' }]);

    expect(harness.emitNotice).not.toHaveBeenCalled();
  });

  /**
   * worker 在 :5491-5493 写明的不变量：停止接纳命令变更回调必须早于 drain，否则
   * drain 与退订之间落进来的运行时事件会再排一次发布。coreEvents 退订在最后。
   */
  it('dispose 顺序：artifact 收尾 → 关闭命令目录派发 → drain → dispose publisher', async () => {
    const harness = setup();
    await harness.broadcast.dispose();

    expect(h.disposeOrder).toEqual([
      'cancelHostRecovery',
      'unsubscribeArtifact',
      'closeAdmission',
      'drain',
      'publisherDispose',
    ]);
  });

  it('dispose 幂等：第二次调用不重复收尾', async () => {
    const harness = setup();
    await harness.broadcast.dispose();
    const firstOrder = [...h.disposeOrder];
    await harness.broadcast.dispose();

    expect(h.disposeOrder).toEqual(firstOrder);
    expect(harness.commandListeners).toHaveLength(0);
  });

  it('dispose 之后命令目录运行时变更不再发通知', async () => {
    const harness = setup();
    h.buildSdkCommandSnapshot.mockResolvedValue([{ name: 'c-1' }]);
    harness.broadcast.startAfterInitialize({
      declarations: { supportsCommandsChanged: true },
      initialCommands: [],
    });
    // start() 自带一次 reconcile，目录确实变了所以这一条通知是应该发的。
    await h.publishers[0]!.drain();
    const listener = harness.commandListeners[0]!;
    const noticesBeforeDispose = harness.emitNotice.mock.calls.length;
    await harness.broadcast.dispose();

    h.buildSdkCommandSnapshot.mockResolvedValue([
      { name: 'c-1' },
      { name: 'c-2' },
    ]);
    listener();
    await Promise.resolve();
    expect(harness.emitNotice.mock.calls).toHaveLength(noticesBeforeDispose);
  });
});


describe('sessionBroadcast: idle permission policy', () => {
  it('sends the latest snapshot after subscribing; deduplicates unrelated changes and unsubscribes', async () => {
    const harness = setup();
    // A change between initialize and broadcast must not be lost.
    harness.restrictions.set('yolo', 'disabled');
    harness.broadcast.startAfterInitialize({ declarations: {}, initialCommands: [] });
    expect(harness.permissionListeners.size).toBe(1);
    expect(noticesOfKind(harness.emitNotice, 'permissionPolicyChanged')).toEqual([
      { kind: 'permissionPolicyChanged', policy: {
        disabledModes: ['yolo'], disabledModeMessages: { yolo: 'disabled' },
      } },
    ]);
    for (const listener of harness.permissionListeners) listener();
    expect(noticesOfKind(harness.emitNotice, 'permissionPolicyChanged')).toHaveLength(1);
    harness.restrictions.clear();
    for (const listener of harness.permissionListeners) listener();
    expect(noticesOfKind(harness.emitNotice, 'permissionPolicyChanged').at(-1)?.policy.disabledModes).toEqual([]);
    expect(harness.state.permissionMode).toBe('default');
    await harness.broadcast.dispose();
    expect(harness.permissionListeners.size).toBe(0);
  });

  it('pushes to two idle session broadcasts independently', async () => {
    const permissionListeners = new Set<() => void>();
    const restrictions = new Map<string, string>();
    const a = setup({ permissionListeners, restrictions });
    const b = setup({ permissionListeners, restrictions });
    for (const harness of [a, b]) {
      harness.broadcast.startAfterInitialize({ declarations: {}, initialCommands: [] });
    }
    restrictions.set('auto', 'disabled');
    for (const listener of permissionListeners) listener();
    for (const harness of [a, b]) {
      expect(noticesOfKind(harness.emitNotice, 'permissionPolicyChanged').at(-1)?.policy.disabledModes).toEqual(['auto']);
      expect(harness.state.permissionMode).toBe('default');
    }
  });
});
