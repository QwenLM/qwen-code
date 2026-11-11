/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `can_use_tool` 出站通道：会话 → 宿主的权限询问。
 *
 * 只产产品级询问、只消费产品级判决：不构造帧，不认识 request_id；wire 字段投影、
 * control_request 信封与回执关联全归宿主。询问内容（title / description / details）
 * 是产品事实，算在同目录 `sessionPermissionPrompt.ts`。
 *
 * 询问的作废是本会话私有的：每个提示一只 AbortController，turn 中止与撤回都表达为
 * abort 它，宿主把中止翻成落定结果并负责把提示从上游撤下。
 */

import { randomUUID } from 'node:crypto';
import {
  buildCanUseToolPromptDetails,
  getCanUseToolDescription,
  getCanUseToolTitle,
} from './sessionPermissionPrompt.js';
import { recordSessionAsk } from './sessionAskChannel.js';
import {
  REPEATED_TOOL_CALL_PERMISSION_KIND,
  createAskHandler,
  createPermissionRequestHookBridge,
  permissionPromptNotifier,
  runLogger,
  withPermissionRequestHookHandler,
  type AskPrompt,
  type AskSettlement,
  type Config,
  type ConfirmContinuation,
  type ContinuationRequest,
  type SerializableConfirmationDetails,
} from '@qwen-code/core';
import { getCanUseToolPresentation } from '../../../utils/canUseToolPresentation.js';
import type { ThreadCanUseToolHandler } from '../contract/hostContext.js';

export interface ThreadPermissionChannelParams {
  readonly config: Config;
  /** 宿主的许可询问反向请求；wire 投影、关联与回执解析都归宿主。 */
  readonly canUseTool: ThreadCanUseToolHandler;
  /** 取当前 turn 的 signal：询问随 turn 一起作废。 */
  readonly getSignal: () => AbortSignal | undefined;
  /** 绑本会话的 turn 中止——deny 带 interrupt 时要用。 */
  readonly onInterrupt: () => void;
  /** ask 指标归因：询问由具名工具还是 stdio 控制通道承载。 */
  readonly promptChannel: 'stdio_control' | 'named_tool';
}

export interface ThreadPermissionHandlingParams {
  readonly config: Config;
  /**
   * 宿主提供的许可询问回调。**是否提供由宿主决定**：缺席表示宿主没有人可以应答，
   * 会话不装 can_use_tool 控制通道，交给 PermissionRequest hook 串行裁决（无裁决
   * 即拒绝）。参数层判断都在宿主，会话不解析 argv。
   */
  readonly canUseTool?: ThreadCanUseToolHandler;
  /** ask 指标归因；仅在 canUseTool 存在时有意义，缺省按 stdio 控制通道记。 */
  readonly permissionPromptChannel?: 'stdio_control' | 'named_tool';
  /** 取当前 turn 的 signal：询问随 turn 一起作废。 */
  readonly getSignal: () => AbortSignal | undefined;
  /** 绑本会话的 turn 中止——deny 带 interrupt 时要用。 */
  readonly onInterrupt: () => void;
}

/**
 * 权限裁决的会话侧分流：宿主提供 canUseTool 时装 can_use_tool 控制通道，与
 * PermissionRequest hook 竞速；没提供则只留 hook-only handler。
 *
 * 后者串行裁决、无裁决 fail-closed 拒绝；装通道会让宿主的「未提供回调」错误回包
 * 抢先落定，把 hook 的 allow 裁决当迟到者丢弃。
 */
export function installThreadPermissionHandling(
  params: ThreadPermissionHandlingParams,
): void {
  if (params.canUseTool) {
    const channelParams: ThreadPermissionChannelParams = {
      config: params.config,
      canUseTool: params.canUseTool,
      getSignal: params.getSignal,
      onInterrupt: params.onInterrupt,
      promptChannel: params.permissionPromptChannel ?? 'stdio_control',
    };
    createThreadPermissionChannel(channelParams);
    // 宿主有 can_use_tool 通道时，doom-loop 守卫的续跑确认也必须走它：漏接这条接线
    // 会让 confirmContinuation 恒为 undefined，第 5 次相同调用被直接拒绝、整轮终止。
    params.config.confirmContinuation = createThreadContinuation(channelParams);
    return;
  }

  // 有 hook 系统则装 hook-only handler（串行裁决），没有则装 undefined——
  // 「没人可问」的唯一安全解读是拒绝每一次 ask。
  const bridge = createPermissionRequestHookBridge(params.config);
  params.config.setPermissionAskHandler(
    bridge ? withPermissionRequestHookHandler(undefined, bridge) : undefined,
  );
  // doom-loop 守卫同理解读：没人可问，续跑必须被拒绝而不是被假定同意。
  params.config.confirmContinuation = undefined;
  runLogger.log('[thread-session] hook-only permission handler installed', {
    sessionId: params.config.getSessionId(),
    hookBridge: bridge !== undefined,
  });
}

/** doom-loop 续跑确认的 details。 */
function continuationConfirmationDetails(
  request: ContinuationRequest,
): SerializableConfirmationDetails {
  return {
    type: REPEATED_TOOL_CALL_PERMISSION_KIND,
    title: request.title,
    toolName: request.toolName,
    repeatCount: request.repeatCount,
    threshold: request.threshold,
    inputPreview: request.inputPreview ?? '',
  };
}

/**
 * 续跑确认复用宿主的 can_use_tool 通道，带 repeated_tool_call 专属 details /
 * permission_kind，宿主据此渲染确认卡片。只有 permissionScope 'session' 表示会话内
 * 始终允许，其余批准只放行一次；无应答（撤回 / 中止）按拒绝结算。
 */
function createThreadContinuation(
  params: ThreadPermissionChannelParams,
): ConfirmContinuation {
  return async (request) => {
    const details = continuationConfirmationDetails(request);
    try {
      const decision = await params.canUseTool(
        {
          toolName: request.toolName,
          input: {},
          suggestions: [],
          blockedPath: undefined,
          title: request.title,
          description: `Repeated ${request.toolName} call with identical input`,
          toolUseId: randomUUID(),
          displayName: request.toolName,
          details,
          permissionKind: REPEATED_TOOL_CALL_PERMISSION_KIND,
          options: getCanUseToolPresentation(details).options,
        },
        { signal: request.signal ?? params.getSignal() },
      );
      if (decision.behavior === 'deny') {
        return decision.message
          ? { outcome: 'deny', reason: decision.message }
          : { outcome: 'deny' };
      }
      return decision.permissionScope === 'session'
        ? { outcome: 'session' }
        : { outcome: 'once' };
    } catch {
      // 无人应答不等于批准：撤回、turn 中止与通道断开都结算成拒绝。
      return { outcome: 'deny', reason: 'aborted' };
    }
  };
}

export function createThreadPermissionChannel(
  params: ThreadPermissionChannelParams,
): void {
  const sessionId = params.config.getSessionId();

  const handler = createAskHandler(
    {
      present(prompt: AskPrompt, settle: (result: AskSettlement) => void) {
        // 提示被呈现的这一刻起算等待跨度：每条 settle 前的 record 都拿它算
        // waitLatencyMs。
        const startedAt = Date.now();
        const toolDef = params.config.toolRegistry.getTool(prompt.toolName);

        // 每个提示一只中止控制器：撤回（teardown）与 turn 中止都汇聚到它，宿主把
        // 中止翻成落定结果——会话不再持有 pending 关联表。
        const promptAbort = new AbortController();
        const turnSignal = params.getSignal();
        const forwardTurnAbort = () => promptAbort.abort();
        if (turnSignal) {
          if (turnSignal.aborted) {
            promptAbort.abort();
          } else {
            turnSignal.addEventListener('abort', forwardTurnAbort, {
              once: true,
            });
          }
        }

        let tornDown = false;

        // details 要先算出来才能定 title / description，所以询问的发起是异步的；
        // 中止控制器在同步段就已经建好，撤回与 turn 中止的关联不依赖这一步。
        void (async () => {
          try {
            const details = await buildCanUseToolPromptDetails(
              params.config,
              prompt,
              toolDef,
            );
            // 发起前就已作废（撤回或 turn 中止）：询问不该再出去。撤回由 teardown
            // 接管；被撤回时不 settle 也不 record——撤回不算一次提示应答。
            if (promptAbort.signal.aborted) {
              if (!tornDown) {
                runLogger.log(
                  '[thread-session] permission ask aborted before dispatch',
                  {
                    sessionId,
                    toolName: prompt.toolName,
                    toolUseId: prompt.toolUseId,
                  },
                );
                recordSessionAsk(
                  params.config.permissionTelemetry.askMetrics,
                  prompt.toolUseId,
                );
                settle({ kind: 'aborted' });
              }
              return;
            }
            // 权限询问发出：只记工具名，不记 input / details / title / description
            // 等正文——那些可能含工具参数与路径。
            runLogger.log('[thread-session] permission ask dispatched', {
              sessionId,
              toolName: prompt.toolName,
              toolUseId: prompt.toolUseId,
            });
            const decision = await params.canUseTool(
              {
                toolName: prompt.toolName,
                // 投影后的 input，不是原始 input——见 core 的 promptForCheck。
                input: prompt.input,
                // 为什么会被问：suggestions / blockedPath 让 SDK 消费方能程序化
                // 判断，而不是只看到一句提示语。wire 投影归宿主。
                suggestions: prompt.suggestions ?? [],
                blockedPath: prompt.reason.blockedPath,
                title: getCanUseToolTitle(details) || undefined,
                description: getCanUseToolDescription(
                  details,
                  toolDef,
                  prompt.input,
                  prompt.toolName,
                ),
                // 这三个字段需要 prompt 与工具实例，二者都在本函数作用域内。
                toolUseId: prompt.toolUseId,
                displayName: toolDef?.displayName ?? prompt.toolName,
                details,
                ...(prompt.persistable === false
                  ? { options: getCanUseToolPresentation(details, false).options }
                  : {}),
              },
              { signal: promptAbort.signal },
            );
            // 撤回后晚到的判决按孤儿丢弃。
            if (tornDown) return;
            if (promptAbort.signal.aborted) {
              // turn 中止与应答竞速：询问随 turn 一起作废，判决不再采用。record
              // 必须在 settle 前，执行门才读得到。
              runLogger.log('[thread-session] permission ask aborted', {
                sessionId,
                toolName: prompt.toolName,
                toolUseId: prompt.toolUseId,
                waitMs: Date.now() - startedAt,
              });
              recordSessionAsk(
                params.config.permissionTelemetry.askMetrics,
                prompt.toolUseId,
              );
              settle({ kind: 'aborted' });
              return;
            }
            if (decision.behavior === 'deny') {
              if (decision.interrupt) params.onInterrupt();
              // 拒绝理由正文（decision.message）刻意不打：它可能回显工具参数内容。
              runLogger.log('[thread-session] permission denied', {
                sessionId,
                toolName: prompt.toolName,
                toolUseId: prompt.toolUseId,
                interrupt: decision.interrupt === true,
                hasMessage: Boolean(decision.message),
                waitMs: Date.now() - startedAt,
              });
              const settlement: AskSettlement = decision.message
                ? { kind: 'rejected', reason: decision.message }
                : { kind: 'rejected' };
              // 正是这条 record 让执行门把拒绝归成 winnerParty 'prompt'，从而落盘
              // toolDenialKind 'user-rejected' 与拒绝理由。
              recordSessionAsk(
                params.config.permissionTelemetry.askMetrics,
                prompt.toolUseId,
              );
              settle(settlement);
              return;
            }
            // 判决契约（ThreadCanUseToolDecision）不携带 updatedPermissions——
            // 回执里权限更新的解析与应用属于 wire 层，随投影一起归宿主侧。
            runLogger.log('[thread-session] permission approved', {
              sessionId,
              toolName: prompt.toolName,
              toolUseId: prompt.toolUseId,
              inputUpdated: isRecord(decision.updatedInput),
              waitMs: Date.now() - startedAt,
            });
            const settlement: AskSettlement = {
              kind: 'approved',
              ...(isRecord(decision.updatedInput)
                ? { input: decision.updatedInput }
                : {}),
            };
            recordSessionAsk(
              params.config.permissionTelemetry.askMetrics,
              prompt.toolUseId,
            );
            settle(settlement);
          } catch (error) {
            // 没有应答不等于拒绝：turn 中止、撤回或会话 teardown 都会让宿主把在途
            // 询问落定成失败。撤回（tornDown）时不再 settle，也不 record。
            if (!tornDown) {
              runLogger.log('[thread-session] permission ask failed', {
                sessionId,
                toolName: prompt.toolName,
                toolUseId: prompt.toolUseId,
                waitMs: Date.now() - startedAt,
                error,
              });
              recordSessionAsk(
                params.config.permissionTelemetry.askMetrics,
                prompt.toolUseId,
              );
              settle({ kind: 'aborted' });
            }
          } finally {
            turnSignal?.removeEventListener('abort', forwardTurnAbort);
          }
        })();

        return () => {
          tornDown = true;
          runLogger.log('[thread-session] permission ask withdrawn', {
            sessionId,
            toolName: prompt.toolName,
            toolUseId: prompt.toolUseId,
          });
          // 撤回通过 abort 本提示的信号表达；把提示从上游真的撤下（cancel 帧）
          // 是宿主在信号上挂的等待里做的事。
          promptAbort.abort();
        };
      },
    },
    {
      // 提示真正被呈现时发 Notification/permission_prompt hook 事件。通知器是
      // fire-and-forget：只发事件、不落定这次询问；没有 hook 系统时什么都不发。
      onPromptShown: permissionPromptNotifier(params.config),
      getCurrentMode: () => params.config.getPermissionMode(),
      // recheck 落定的询问由 createAskHandler 自己记 winnerParty 'recheck'，走同一个
      // store；缺了它，执行门读到 undefined，拒绝归因失效。
      getAskMetrics: () => params.config.permissionTelemetry.askMetrics,
    },
  );

  // PermissionRequest hook 与通道竞速：谁先给出裁决谁赢。没有 hook 系统时
  // createPermissionRequestHookBridge 返回 undefined，装裸 handler。
  const bridge = createPermissionRequestHookBridge(params.config);
  params.config.setPermissionAskHandler(
    bridge ? withPermissionRequestHookHandler(handler, bridge) : handler,
  );
  runLogger.log('[thread-session] permission channel installed', {
    sessionId: params.config.getSessionId(),
    hookBridge: bridge !== undefined,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
