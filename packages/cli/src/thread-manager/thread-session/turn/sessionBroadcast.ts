/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHookDiagnosticsPublisher } from '../../../hookDiagnostics.js';
import type { LoadedSettings } from '../../../config/settings.js';

/**
 * 会话状态广播面：七类 `ThreadNotice` 的会话级生产者，每会话一份。
 * 只产语义通知、不构造帧；`system` 与 subtype、`uuid` 与 `session_id` 信封、蛇形字段名归宿主。
 * 不得 import headlessSession 的任何符号。
 */

import { isDeepStrictEqual } from 'node:util';
import {
  CoreEvent,
  coreEvents,
  OutputFormat,
  runLogger,
  type Config,
  type PermissionPolicySnapshot,
  type GoalClearedPayload,
  type GoalUpdatedPayload,
  type PlanStateChangedPayload,
  type QueryEvent,
  type SlashCommand as SDKSlashCommand,
} from '@qwen-code/core';
import { buildSessionPermissionPolicy } from '../initialize/sessionInitializeSnapshot.js';
import type { SessionQueryRunner } from '../query/sessionQueryRunner.js';
import { getSdkPermissionMode } from '../../../session/permissionMode.js';
import {
  createSessionArtifactRuntime,
  type SessionArtifactRuntime,
} from '../../../session/artifacts/sessionArtifactRuntime.js';
import {
  buildSdkCommandSnapshot,
  SdkCommandCatalogPublisher,
} from '../../../sdkCommandCatalog.js';
import { buildGoalSnapshot } from '../../../utils/goalControlProtocol.js';
import { buildAvailableModelsSnapshot } from '../../../worker/availableModelsSnapshot.js';
import type { ThreadNotice } from '../contract/hostContext.js';
import type { ThreadSessionDeclarations } from '../contract/threadSessionTypes.js';

/** artifact 观察 flush 的超时上界。 */
const ARTIFACT_FLUSH_TIMEOUT_MS = 1000;

function supportsSdkAvailableModelsUpdate(
  declarations: ThreadSessionDeclarations,
): boolean {
  return declarations.supportsAvailableModelsUpdate === true;
}

function supportsSdkCommandsChanged(
  declarations: ThreadSessionDeclarations,
): boolean {
  return declarations.supportsCommandsChanged === true;
}

export interface SessionBroadcastParams {
  readonly config: Config;
  readonly sessionId: string;
  /**
   * 出站写一条语义通知；subtype 字符串、`uuid` 与 `session_id` 信封、蛇形字段名归宿主。
   */
  readonly emitNotice: (notice: ThreadNotice) => void;
  /** runner 是懒建的；持久状态不依赖它，transcript 历史合并才读取它的消息快照。 */
  readonly getQueryRunner: () => SessionQueryRunner | null;
  readonly getSettings: () => LoadedSettings;
  /**
   * `initialize` 决定的控制面形态，决定 permissionMode 取原始视图还是 SDK 映射视图。
   * 装配之后才定，因此用 getter 读。
   */
  readonly isIndependentPlanModeControls: () => boolean;
}

export interface SessionBroadcast {
  /**
   * `initialize` 成功、回包与 `system/init` 都已出门之后调用。命令目录的初始快照取自
   * 回包里的 `commands`，避免 publisher 把已经报过的目录再发一遍。
   */
  startAfterInitialize(options: {
    declarations: ThreadSessionDeclarations;
    initialCommands: readonly SDKSlashCommand[];
  }): void;
  /** 发 `system/init` 之后调用：先恢复持久状态，再按可用性合并 runner 历史。 */
  initializeArtifacts(): Promise<void>;
  /** turn 循环的每个原始 QueryEvent 都要喂进来，否则 artifact 快照永远是空的。 */
  observeQueryEvent(event: QueryEvent): void;
  /** 最终 assistant 出站前等待本轮 artifact observation 完成。 */
  waitForArtifacts(): Promise<void>;
  /** 每会话独占的 artifact 运行时；host refresh 与 `resolve_session_artifacts` 要用。 */
  readonly artifactRuntime: SessionArtifactRuntime;
  /** 会话关闭时调用：停派发 → 等在途 → 退订。幂等。 */
  dispose(): Promise<void>;
}

export function createSessionBroadcast(
  params: SessionBroadcastParams,
): SessionBroadcast {
  const {
    config,
    sessionId,
    emitNotice,
    getQueryRunner,
    isIndependentPlanModeControls,
  } = params;
  const isStreamJson = config.getOutputFormat() === OutputFormat.STREAM_JSON;

  let disposed = false;
  let unsubscribePermissionPolicy: (() => void) | undefined;
  let lastPermissionPolicy: PermissionPolicySnapshot | undefined;
  const publishPermissionPolicy = (): void => {
    if (disposed) return;
    const policy = buildSessionPermissionPolicy(config);
    if (isDeepStrictEqual(lastPermissionPolicy, policy)) return;
    lastPermissionPolicy = policy;
    emitNoticeLogged({ kind: 'permissionPolicyChanged', policy });
  };

  // 广播出站统一经这里打点：只记 kind，通知负载（模型目录、命令目录、goal 快照等）
  // 体积大且可能带用户内容，刻意不进日志。
  const emitNoticeLogged = (notice: ThreadNotice): void => {
    runLogger.log('[thread-session] broadcast notice', {
      sessionId,
      kind: notice.kind,
    });
    emitNotice(notice);
  };

  // ── available_models_update ────────────────────────────────────────────────
  let modelStatePublisherStarted = false;
  let lastModelStateFingerprint: string | null = null;
  let modelStateRevision = 0;
  const publishModelState = async (force = false): Promise<void> => {
    if (!modelStatePublisherStarted || disposed) return;
    // 快照仍要读：fingerprint 自比对是「变了才发」的唯一依据。models 是原始目录快照，
    // wire 投影归宿主。
    const revision = ++modelStateRevision;
    const model = config.getModel();
    const identity = config.getModelRequestIdentity();
    const targetSessionId = config.getSessionId();
    try {
      const snapshot = await buildAvailableModelsSnapshot(config);
      if (
        !modelStatePublisherStarted ||
        disposed ||
        revision !== modelStateRevision ||
        model !== config.getModel() ||
        identity !== config.getModelRequestIdentity() ||
        targetSessionId !== config.getSessionId()
      )
        return;
      if (!force && snapshot.fingerprint === lastModelStateFingerprint) return;
      emitNoticeLogged({
        kind: 'availableModelsChanged',
        models: snapshot.models,
        currentModel: snapshot.currentModel,
      });
      lastModelStateFingerprint = snapshot.fingerprint;
    } catch (error) {
      runLogger.warn('[thread-session] 模型目录发布失败', { sessionId, error });
    }
  };

  // ── status ─────────────────────────────────────────────────────────────────
  let lastRawPermissionMode = config.getPermissionMode();
  const reportSessionMode = (): void => {
    if (disposed) return;
    // 订阅已按本会话过滤；自比对保留为第二道挡板：忽略 payload、回读自己的 config。
    const rawMode = config.getPermissionMode();
    if (rawMode === lastRawPermissionMode) return;
    lastRawPermissionMode = rawMode;
    // `status: null` 是帧上的遗留形状，由宿主补齐；通知只带解析后的 permissionMode。
    emitNoticeLogged({
      kind: 'statusChanged',
      permissionMode: isIndependentPlanModeControls()
        ? rawMode
        : getSdkPermissionMode(config),
    });
  };

  // ── artifacts_update ───────────────────────────────────────────────────────
  const artifactRuntime = createSessionArtifactRuntime(config);
  let artifactStateInitialization: Promise<void> | null = null;
  let artifactHistoryInitialization: Promise<void> | null = null;
  let artifactQueue: Promise<void> = Promise.resolve();
  /** 停止接纳新的观察必须在 flush 之前，否则 teardown 期间落进来的事件永远等不到 flush。 */
  let admitArtifactObservations = true;
  const disposeArtifactSubscription = artifactRuntime.subscribe(
    (artifacts, observation) => {
      if (!isStreamJson || disposed) return;
      // artifacts 是运行时给的快照，原样透传；宿主渲染成 `artifacts_update` 帧。
      emitNoticeLogged({
        kind: 'artifactsChanged',
        artifacts,
        ...(observation?.changedArtifacts
          ? { changedArtifacts: observation.changedArtifacts }
          : {}),
      });
    },
  );

  const initializeArtifacts = async (): Promise<void> => {
    artifactStateInitialization ??= artifactRuntime
      .initialize([])
      .then(() => undefined);
    await artifactStateInitialization;
    const runner = getQueryRunner();
    if (!runner) return;
    artifactHistoryInitialization ??= artifactRuntime
      .initialize(runner.getMessages(), { forcePublish: false })
      .then(() => undefined);
    await artifactHistoryInitialization;
  };

  const observeQueryEvent = (event: QueryEvent): void => {
    if (!admitArtifactObservations) return;
    artifactQueue = artifactQueue
      .then(async () => {
        await initializeArtifacts();
        await artifactRuntime.observeEvent(event);
      })
      .catch((error) => {
        runLogger.warn('[thread-session] artifact observation failed', {
          sessionId,
          error,
        });
      });
  };

  const flushArtifactQueue = async (): Promise<void> => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      artifactQueue.then(() => 'flushed' as const),
      new Promise<'timeout'>((resolve) => {
        timeout = setTimeout(
          () => resolve('timeout'),
          ARTIFACT_FLUSH_TIMEOUT_MS,
        );
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (outcome === 'timeout') {
      runLogger.warn(
        `[thread-session] artifact flush timed out after ${ARTIFACT_FLUSH_TIMEOUT_MS}ms`,
        { sessionId },
      );
    }
  };

  // Static diagnostics are snapshots, independent of Hook execution events.
  const hookDiagnostics = isStreamJson
    ? createHookDiagnosticsPublisher({
        config,
        getSettings: params.getSettings,
        publish: (snapshot) =>
          emitNoticeLogged({ kind: 'hookDiagnostics', snapshot }),
      })
    : undefined;
  // ── commands_changed ───────────────────────────────────────────────────────
  let commandCatalogPublisher: SdkCommandCatalogPublisher | undefined;
  let closeCommandCatalogAdmission: (() => void) | undefined;

  // ── coreEvents 订阅 ────────────────────────────────────────────────────────
  const unsubs: Array<() => void> = [];
  if (isStreamJson) {
    // ModelChanged 是会话级事件，走 onSessionEvent 过滤；ModelInfoChanged 是进程级事件，
    // 无法按归属过滤，串台靠 fingerprint 自比对吃掉。两个 handler 都忽略 payload、回读 config。
    const handleModelStateChange = () => {
      void publishModelState();
    };
    unsubs.push(
      coreEvents.onSessionEvent(
        CoreEvent.ModelChanged,
        sessionId,
        handleModelStateChange,
      ),
    );
    coreEvents.on(CoreEvent.ModelInfoChanged, handleModelStateChange);
    unsubs.push(() => {
      coreEvents.off(CoreEvent.ModelInfoChanged, handleModelStateChange);
    });

    const publisher = new SdkCommandCatalogPublisher(
      () => buildSdkCommandSnapshot(config),
      (commands) => {
        // commands 是命令目录快照，原样透传；宿主渲染成 `commands_changed` 帧。
        emitNoticeLogged({ kind: 'commandsChanged', commands });
      },
    );
    commandCatalogPublisher = publisher;
    // `config.getStartupRuntime()` 是每会话 Config 自带的，不是进程单例，
    // 因此这条订阅天然按会话隔离。
    const unsubscribeCommands = config
      .getStartupRuntime()
      .onChange('commands', () => publisher.notify());
    let commandCatalogSubscriptionOpen = true;
    closeCommandCatalogAdmission = () => {
      if (!commandCatalogSubscriptionOpen) return;
      commandCatalogSubscriptionOpen = false;
      unsubscribeCommands();
    };

    // 会话级事件：只收本会话的权限模式变更。
    unsubs.push(
      coreEvents.onSessionEvent(
        CoreEvent.PermissionModeChanged,
        sessionId,
        reportSessionMode,
      ),
    );

    // ── goal_updated / goal_cleared ─────────────────────────────────────────
    // 过滤须先于回读单槽 goal；快照显式传 sessionId，不靠 daemon 根 config 兜底。
    const reportGoalUpdated = (payload: GoalUpdatedPayload): void => {
      if (disposed) return;
      const goal = config.getGoalManager().getGoal();
      // 读不到就不发，不发空快照。
      if (!goal) return;
      // goal 是 `buildGoalSnapshot` 的 wire 快照，原样透传；reason 原样带出。
      emitNoticeLogged({
        kind: 'goalChanged',
        goal: buildGoalSnapshot(goal),
        ...(payload.reason ? { reason: payload.reason } : {}),
      });
    };
    const reportGoalCleared = (payload: GoalClearedPayload): void => {
      if (disposed) return;
      // goalId 是产品名；帧上蛇形 `goal_id` 的改名归宿主。
      emitNoticeLogged({
        kind: 'goalCleared',
        goalId: payload.goalId,
        ...(payload.reason ? { reason: payload.reason } : {}),
      });
    };
    unsubs.push(
      coreEvents.onSessionEvent(
        CoreEvent.GoalUpdated,
        sessionId,
        reportGoalUpdated,
      ),
      coreEvents.onSessionEvent(
        CoreEvent.GoalCleared,
        sessionId,
        reportGoalCleared,
      ),
    );

    // ── plan_mode_changed ───────────────────────────────────────────────────
    // PlanStateChangedPayload 带 sessionId，经 onSessionEvent 过滤到本会话。
    const reportPlanModeChanged = (payload: PlanStateChangedPayload): void => {
      if (disposed) return;
      // 帧上把 active 包在 plan_mode 一层是 wire 形状，归宿主。
      emitNoticeLogged({ kind: 'planModeChanged', active: payload.active });
    };
    unsubs.push(
      coreEvents.onSessionEvent(
        CoreEvent.PlanStateChanged,
        sessionId,
        reportPlanModeChanged,
      ),
    );
  }

  let disposePromise: Promise<void> | null = null;
  const runDispose = async (): Promise<void> => {
    runLogger.log('[thread-session] broadcast dispose started', { sessionId });
    unsubscribePermissionPolicy?.();
    // 顺序：artifact flush 与退订 → 命令目录停派发 → drain → dispose → coreEvents 退订；
    // 停止接纳命令变更必须早于 drain。`disposed` 最后置位，flush 期间仍可 publish 最后一批快照。
    admitArtifactObservations = false;
    modelStatePublisherStarted = false;
    modelStateRevision++;
    await flushArtifactQueue();
    artifactRuntime.cancelHostRecovery();
    disposeArtifactSubscription();
    hookDiagnostics?.dispose();
    closeCommandCatalogAdmission?.();
    await commandCatalogPublisher?.drain();
    commandCatalogPublisher?.dispose();
    for (const unsub of unsubs) unsub();
    unsubs.length = 0;
    disposed = true;
    runLogger.log('[thread-session] broadcast disposed', { sessionId });
  };

  return {
    artifactRuntime,

    startAfterInitialize({ declarations, initialCommands }) {
      if (disposed) return;
      if (isStreamJson && !unsubscribePermissionPolicy) {
        const policyManager = config.getProcessPermissionManager() as
          | { subscribePolicyChanges?: (listener: () => void) => () => void }
          | undefined;
        unsubscribePermissionPolicy =
          policyManager?.subscribePolicyChanges?.(publishPermissionPolicy);
        // 先订阅，再补发当前快照，覆盖初始化期间发生的变化。
        publishPermissionPolicy();
      }
      hookDiagnostics?.start();
      runLogger.log('[thread-session] broadcast started', {
        sessionId,
        streamJson: isStreamJson,
        commandsChanged: supportsSdkCommandsChanged(declarations),
        modelsUpdate: supportsSdkAvailableModelsUpdate(declarations),
        initialCommands: initialCommands.length,
      });
      if (supportsSdkCommandsChanged(declarations)) {
        commandCatalogPublisher?.start(initialCommands);
      }
      if (supportsSdkAvailableModelsUpdate(declarations)) {
        modelStatePublisherStarted = true;
        void publishModelState(true);
      }
    },

    initializeArtifacts,
    observeQueryEvent,
    waitForArtifacts: () => artifactQueue,

    dispose() {
      disposePromise ??= runDispose();
      return disposePromise;
    },
  };
}
