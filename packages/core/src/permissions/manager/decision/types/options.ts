/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// 装配选项、单次调用覆盖、ask handler 契约。
// 三条核心语义：pin vs overlay（见 CheckPermissionOptions）、
// fail-closed（无 askHandler 时 ask 一律拒绝）、TExtra 四条约定（见 tool-check.ts）。

import type {
  PermissionMode,
  PermissionRules,
  PreToolUseHookVerdict,
  ToolCheckResult,
} from './decision.js';
import type { ToolPermissionChecker } from './tool-check.js';

// 模块只存这些值并递给回调，除 rulesForTool 外不做任何推导。
export interface PermissionOptions<TReason = unknown> {
  permissionMode: PermissionMode;
  rules: PermissionRules;
  cwd: string;
  additionalDirectories: string[];
  // 宿主注入的旧工具名别名表。
  toolNameAliases?: Record<string, string>;
  toolCheckerMap: Map<string, ToolPermissionChecker<TReason>>;
  askHandler?: AskHandler<TReason>;
}

/**
 * 单次调用覆盖，逐字段叠在对象状态上，只对本次调用生效：
 * - 给了的字段钉住（pin）：后续 setter 改动不影响本次调用。
 * - 没给的字段跟随对象状态：ask 挂起期间被改动会触发自检重跑，结果经
 *   handler 的 onToolCheckResult 送达。
 *
 * rules 与 additionalRules 的唯一区别是是否钉住：rules 整体替换即钉住；
 * additionalRules 叠加不钉住，弹窗期间的规则编辑仍会触发重查。给了 rules
 * 时 additionalRules 被忽略。
 */
export interface CheckPermissionOptions<TReason = unknown> {
  permissionMode?: PermissionMode;
  rules?: PermissionRules;
  additionalRules?: PermissionRules;
  cwd?: string;
  additionalDirectories?: string[];
  askHandler?: AskHandler<TReason>;
  // 进 checkPermission 前宿主 PreToolUse hook 已给出的裁决。给了就钉住，整个
  // 调用（含重跑）原样透传给 checker；组件只透传，优先级编排是宿主的事。
  preToolUseHookVerdict?: PreToolUseHookVerdict;
}

/**
 * 每次判定恰好调用一次；后续重跑结果经 ctx.onToolCheckResult 送达，handler
 * 可在任一结果上落定或继续等。无 handler 时 ask 一律拒绝（fail-closed）。
 */
export type AskHandler<
  TReason = unknown,
  TExtra = unknown,
  TSuggestion = unknown,
> = (
  ctx: AskHandleContext<TReason, TExtra, TSuggestion>,
) => Promise<AskHandleResult>;

// 弹窗内容全部来自 toolCheckResult（reason/suggestions/extra），模块不包装。
export interface AskHandleContext<TReason, TExtra, TSuggestion> {
  readonly toolUseId: string;
  readonly agentId?: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly signal?: AbortSignal;
  readonly toolCheckResult: ToolCheckResult<TReason, TExtra, TSuggestion>;
  // 重跑结果投递通道；handler 自行决定含义（allow→批准、deny→拒绝、ask→刷新）。
  readonly onToolCheckResult: (
    listener: (result: ToolCheckResult<TReason, TExtra, TSuggestion>) => void,
  ) => () => void;
}

// 落定结果。范围、反馈、署名都是宿主的业务，这里只保留最小必要信息。
export type AskHandleResult =
  | {
      kind: 'approved';
      // 批准者改过参数则以改后的执行。模块会对这份输入重跑自检，
      // 堵住「批准时改参绕过规则」的后门。省略表示按原样执行。
      input?: Record<string, unknown>;
    }
  | {
      kind: 'rejected';
      // 拒绝理由携带在 decision.denialMessage 上；如何并入模型上下文是宿主的事。
      reason?: string;
    }
  | { kind: 'aborted' };
