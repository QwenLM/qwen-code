/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Managed → ChatPane 数据适配层。
 *
 * 目的：让 Managed 会话复用与普通实例完全相同的 `ChatPane`（同一套 UI、
 * 交互与能力门控），而不是维护第二套 `ManagedSessionsPage` 外壳与文案。
 *
 * 边界：只做**数据结构映射**，不伪造能力。后端 `capabilities` 明确为 false 的项
 * 一律映射为「不支持」，`goalState` / `backgroundTurn` / `planExecutionMode` 这类
 * Managed 无对应语义的字段留空，由 ChatPane 自身按缺省渲染。
 */

import type { DaemonCapabilities } from '@qwen-code/sdk/daemon';
import type {
  DaemonConnectionState,
  DaemonConnectionStatus,
} from '../../daemon/session/types.js';
import type { ManagedAgentSessionSummary } from './managed-agent-provider.js';

/**
 * Managed 会话阶段 → daemon 连接状态。
 *
 * Managed 的 phase 描述「这一轮执行到哪」，daemon 的 status 描述「连接是否可用」，
 * 二者不是同一维度：只要运行时已就绪，即使某轮 completed 也仍是 connected。
 * 因此用 runtimeReady 判连接、用 phase 判失败，避免把正常结束误报成断连。
 */
export function managedPhaseToConnectionStatus(
  summary: ManagedAgentSessionSummary | undefined,
): DaemonConnectionStatus {
  if (!summary) return 'idle';
  if (summary.phase === 'failed') return 'error';
  if (summary.runtimeReady) return 'connected';
  // 已受理但运行时还没起来：等价于 daemon 的 connecting（ChatPane 据此显示启动中）
  if (
    summary.phase === 'created' ||
    summary.phase === 'admitted' ||
    summary.phase === 'runtime_starting' ||
    summary.phase === 'waiting_runtime'
  ) {
    return 'connecting';
  }
  return 'disconnected';
}

/**
 * Managed 布尔 capabilities → daemon feature tags。
 *
 * ChatPane 只按 `capabilities.features.includes(tag)` 门控 UI，所以这里把
 * 后端逐项声明的能力翻译成对应 tag；未声明或 false 的项不加入，UI 自然隐藏。
 */
export function managedCapabilitiesToDaemon(
  capabilities: ManagedAgentSessionSummary['capabilities'] | undefined,
): DaemonCapabilities | undefined {
  if (!capabilities) return undefined;
  const features: string[] = [];
  if (capabilities.inputAttachments) features.push('session_attachments');
  // 逐轮提交等价于 daemon 的继续生成能力
  if (capabilities.canSend) features.push('session_generation');
  // Managed 不支持轮内插话（无 mid-turn send now 协议），故不加该 tag
  return {
    v: 1,
    // Managed 经宿主 HTTP 转发到运行时，不是本地 native daemon。
    mode: 'http-bridge',
    features,
    // Managed 不暴露 daemon 的模型服务目录；模型由 modelSelection 单独提供。
    modelServices: [],
  };
}

export interface ManagedConnectionInput {
  summary: ManagedAgentSessionSummary | undefined;
  /** 宿主选中的会话 id；summary 尚未返回时也要能让 ChatPane 显示 loading */
  sessionId: string | undefined;
  /** transcript 首次加载中 */
  loadingTranscript?: boolean;
  /** 事件回放追平中 */
  catchingUp?: boolean;
  /** 后端确认会话已不存在 */
  missingSession?: boolean;
  /** 当前模型（Managed 固定模型，来自 modelSelection 或 agentId） */
  currentModel?: string;
  /** 可选模型列表；modelChange 不支持时留空，ChatPane 会隐藏选择器 */
  models?: DaemonConnectionState['models'];
  /** 斜杠命令 */
  commands?: DaemonConnectionState['commands'];
  /** 技能名列表 */
  skills?: string[];
}

/**
 * 把 Managed 会话投影成 ChatPane 期望的 `DaemonConnectionState`。
 *
 * 未映射的字段（gitBranch/gitStatus/goalState/backgroundTurn/workflowMode/
 * planExecutionMode/reasoning/tokenUsage 等）保持 undefined：Managed 后端没有
 * 对应语义，留空让 ChatPane 走缺省分支，比塞占位值更诚实。
 */
export function managedSessionToConnection(
  input: ManagedConnectionInput,
): DaemonConnectionState {
  const { summary, sessionId } = input;
  const cwd = summary?.workspace?.cwdRelative;
  return {
    status: managedPhaseToConnectionStatus(summary),
    sessionId: summary?.sessionId ?? sessionId,
    // Managed 的工作目录是相对 workspace 根的路径；ChatPane 只把它当上下文标识，
    // 不用于 daemon 请求，所以直接透传（"." 表示 workspace 根）。
    workspaceCwd: cwd,
    displayName: summary?.title,
    currentMode: summary?.approvalMode,
    currentModel: input.currentModel,
    models: input.models,
    commands: input.commands,
    skills: input.skills,
    capabilities: managedCapabilitiesToDaemon(summary?.capabilities),
    loadingTranscript: input.loadingTranscript,
    catchingUp: input.catchingUp,
    missingSession: input.missingSession,
    // GONE/失败时 ChatPane 用 runtimeStopped 收敛发送与重试入口
    runtimeStopped:
      summary?.phase === 'failed' || summary?.runtimeState === 'failed',
    error: summary?.failure?.message,
  };
}