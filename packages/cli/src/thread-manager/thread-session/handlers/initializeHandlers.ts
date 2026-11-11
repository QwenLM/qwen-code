/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `initialize`：握手。它把一串有严格相对顺序的步骤串起来，顺序错了会出故障。
 *
 * 顺序：独立控制面 → `applyInitializeDeclarations`（必须 await）→ `ensureInferenceReady`
 * → 采集产品快照 → 发出 init 能力快照帧 → `setInitialized(true)` → 返回；`recoverHostArtifacts`
 * / `startSessionBroadcast` / `ensureSessionStartHooks` 必须等回包发出之后才执行。
 * 返回的是产品快照，wire 回包体（蛇形键、能力广告、pid 等）由宿主编解码器组装。
 */

import { runLogger } from '@qwen-code/core';
import { applyIndependentSessionMode } from '../../../session/permissionMode.js';
import { buildSessionInitializeSnapshot } from '../initialize/sessionInitializeSnapshot.js';
import type { ThreadCallContext } from '../contract/hostContext.js';
import type {
  ThreadInitializeResult,
  ThreadInitializeSnapshot,
  ThreadSessionDeclarations,
} from '../contract/threadSessionTypes.js';
import {
  ThreadCapabilityError,
  type ThreadSessionInternals,
} from '../contract/handlerContract.js';

export async function initialize(
  session: ThreadSessionInternals,
  ctx: ThreadCallContext,
  declarations: ThreadSessionDeclarations,
): Promise<ThreadInitializeResult> {
  if (session.isInitialized()) {
    throw new ThreadCapabilityError('Already initialized');
  }

  const hasPermissionMode = Object.prototype.hasOwnProperty.call(
    declarations,
    'permissionMode',
  );
  const hasPlanMode = Object.prototype.hasOwnProperty.call(
    declarations,
    'planMode',
  );
  // 显式声明独立控制面，或带 permissionMode / planMode 任一个，都算独立控制面；
  // 它同时决定回包是否带 permissionMode，以及能力快照里取哪个视图。
  const usesIndependentPlanModeControls =
    declarations['independentPlanModeControls'] === true ||
    hasPermissionMode ||
    hasPlanMode;
  const sessionMode = {
    ...(hasPermissionMode
      ? { permissionMode: declarations['permissionMode'] }
      : {}),
    ...(hasPlanMode ? { planMode: declarations['planMode'] } : {}),
  };
  const deferAutoMode = sessionMode.permissionMode === 'auto';
  if ((hasPermissionMode || hasPlanMode) && !deferAutoMode) {
    applyIndependentSessionMode(session.requireConfig(), sessionMode);
  }
  if (usesIndependentPlanModeControls) {
    session.setIndependentPlanModeControls(true);
  }
  session.setPromptSuggestionsEnabled(
    declarations['promptSuggestions'] === true,
  );
  warnAboutUnsupportedInitializeFields(declarations, session.sessionId);

  // 所有会改变会话装配的声明（hooks / modelPolicyProvider / memory / skillEvolution /
  // systemPrompt / model / contextWindow / skills / mcpServers / agents 等）必须早于
  // ensureInferenceReady 与采集产品快照，相对顺序见 applyInitializeDeclarations 的说明。
  await session.phaseLog.phase(
    '应用 initialize 声明',
    '宿主声明落地：hooks / modelPolicy / 产物解析 / memory / skillEvolution / ' +
      'systemPrompt / model / contextWindow / skills / mcpServers / agents',
    () => session.applyInitializeDeclarations(declarations),
  );
  // 必须在采集产品快照之前：快照里的 models 来自目录，未经 reconcile 的会话模型会被推理守卫拒掉。
  await session.phaseLog.phase(
    '推理就绪',
    '会话推理身份绑定（refreshAuth 的 per-Config 部分）+ 模型目录等待（服务端）；' +
      '宿主声明了 catalogReadyInitialize 时还含端点选举等待与模型二次归一',
    () => session.ensureInferenceReady(),
  );
  if (deferAutoMode) {
    applyIndependentSessionMode(session.requireConfig(), sessionMode);
  }

  const collected = await session.phaseLog.phase(
    '采集产品快照',
    '回包体：模型目录 / 命令 / 技能 / agents / MCP 状态 / 权限模式',
    () =>
      buildSessionInitializeSnapshot(
        session.requireConfig(),
        { includePermissionMode: usesIndependentPlanModeControls },
        ctx.signal,
      ),
  );
  // memory / evolution 声明的产物只合并进回包，不进能力快照；wire 键位由宿主的回包组装补。
  const snapshot: ThreadInitializeSnapshot = {
    ...collected,
    ...session.getInitializeDeclarationProducts(),
  };
  // 能力快照必须在回包之前发出：上游靠这一帧发现 msg_lifecycle_v1，晚了会在首个 result 到达时
  // 直接关会话。
  await session.phaseLog.phase('init 帧装配与发射', '能力快照帧出门，宿主据此发现会话已可用', async () => {
    await session.emitInitSnapshot();
    session.setInitialized(true);
  });
  // 两个时间界（拿到 sessionId / 会话真正可用）都打点，三段耗时才切得开。
  session.phaseLog.summary('init 帧出门（会话可用）');

  return {
    snapshot,
    afterResponseSent: async () => {
      // Host artifact 快照的启动期恢复是 best-effort：回包已出门，失败不影响它。
      session.recoverHostArtifacts();
      // 广播面在回包之后启动；命令目录初始指纹取自快照里的 commands，早一步会重复发变更通知。
      session.startSessionBroadcast(declarations, snapshot.commands);
      // SessionStart hook 在回包与广播面之后触发；thread 侧 runner 懒建，
      // 早到的声明由 pendingRunnerDeclarations 暂存、buildRunner 时回放。
      await session.ensureSessionStartHooks();
    },
  };
}

/**
 * initialize 声明里「只记录、不消费」的字段：目前只有 `initializeTimeoutMs`
 * （共享实现用它给目录等待设超时，进程内会话走 `waitModels: true` 的既有路径）。
 */
function warnAboutUnsupportedInitializeFields(
  declarations: ThreadSessionDeclarations,
  sessionId: string,
): void {
  const recordedOnly = ['initializeTimeoutMs'].filter((field) =>
    Object.prototype.hasOwnProperty.call(declarations, field),
  );
  if (recordedOnly.length === 0) return;
  runLogger.warn(
    '[thread-session] initialize fields recorded but not consumed in-process',
    { sessionId, fields: recordedOnly },
  );
}
