/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BRAND_EVENT_NAMESPACE,
  ENV_BUSINESS_SUB_TASK,
} from '../config/brand.js';

// ---------------------------------------------------------------------------
// BusinessInfo — 业务信息，用于计费追踪（对齐 Go CLI BusinessInfo struct）
// ---------------------------------------------------------------------------

/** 一级子产品 */
export type BusinessProduct =
  | 'cli' // 独立 CLI
  | string; // 预留扩展

/** 二级业务类型 */
export type BusinessType =
  | 'agent' // Agent 对话
  | string; // 预留扩展

/** 阶段 */
export type BusinessStage =
  | 'init' // 初始化阶段
  | 'start' // 已开始
  | 'processing' // 执行中
  | 'complete' // 正常结束
  | 'abort' // 用户取消
  | 'error' // 错误终止
  | string; // 预留扩展

/** 产品常量 */
export const BusinessProductCLI: BusinessProduct = 'cli';

/** 类型常量 */
export const BusinessTypeAgent: BusinessType = 'agent';
export const BusinessTypeCodeReview: BusinessType = 'code_review';
export const BusinessTypeText2Img: BusinessType = 'text2img';
export const BusinessTypeText2Video: BusinessType = 'text2video';

/** 阶段常量 */
export const BusinessStageInit: BusinessStage = 'init';
export const BusinessStageStart: BusinessStage = 'start';
export const BusinessStageProcessing: BusinessStage = 'processing';
export const BusinessStageComplete: BusinessStage = 'complete';
export const BusinessStageAbort: BusinessStage = 'abort';
export const BusinessStageError: BusinessStage = 'error';

/**
 * 业务信息，用于计费追踪。
 * 对齐 Go CLI `BusinessInfo` struct。
 */
export interface BusinessInfo {
  session_id?: string;
  /** 一级子产品 */
  product?: BusinessProduct;
  /** 版本号 */
  version: string;
  /** 二级业务类型 */
  type?: BusinessType;
  /** 业务明细 id，需要在业务子项下唯一或全局唯一 */
  id?: string;
  /** User-selected model at business creation; never changed by request routing. */
  readonly model_key?: string;
  /** 业务明细名称（可选） */
  name?: string;
  /** 子任务标识，用于业务方按任务用途分析数据 */
  sub_task?: string;
  /** 开始时间戳（毫秒） */
  begin_at?: number;
  /** 结束时间戳（毫秒），仅在结束时填充 */
  end_at?: number;
  /** 阶段 */
  stage?: BusinessStage;
  /**
   * True when this BusinessInfo was synthetically created because the parent
   * context was unavailable (e.g., subagent lacking parent businessInfo).
   * AI code tracking should skip or downgrade aggregation for orphan entries.
   */
  orphan?: boolean;
}

const BusinessSubTaskTitle = 'title_generation';
const BusinessSubTaskPromptSuggestion = 'prompt_suggestion';
const BusinessSubTaskAwareness = 'awareness_nudge';
const QuerySourceGenerateSessionTitle = 'generate_session_title';
const QuerySourcePromptSuggestion = 'prompt_suggestion';
const QuerySourceAwareness = 'awareness';

export function resolveBusinessSubTask(
  querySource?: string,
  override?: string,
): string | undefined {
  if (querySource === QuerySourceGenerateSessionTitle) {
    return BusinessSubTaskTitle;
  }
  if (querySource === QuerySourcePromptSuggestion) {
    return BusinessSubTaskPromptSuggestion;
  }
  if (querySource === QuerySourceAwareness) {
    return BusinessSubTaskAwareness;
  }

  const overrideSubTask = override?.trim();
  if (overrideSubTask) {
    return overrideSubTask;
  }

  const envSubTask = process.env[ENV_BUSINESS_SUB_TASK];
  return envSubTask ? envSubTask : undefined;
}

export function applyBusinessSubTask<T extends BusinessInfo>(
  businessInfo: T,
  querySource?: string,
  override?: string,
): T {
  const subTask = resolveBusinessSubTask(querySource, override);
  if (!subTask) {
    const { sub_task: _subTask, ...withoutSubTask } = businessInfo;
    return withoutSubTask as T;
  }
  return { ...businessInfo, sub_task: subTask };
}

/** 命令来源：内置命令或项目级命令 */
export type CommandLocation = 'built-in' | 'project' | string;

/** 命令信息，记录本次执行的命令元数据 */
export interface CmdInfo {
  /** 命令名，如 review、commit */
  command_type?: string;
  /** 命令来源：built-in（内置）或 project（项目级） */
  command_location?: CommandLocation;
}

export interface ErrorInfo {
  error?: Error;
  /** 错误码 */
  errorCode?: string;
  /** 错误描述 */
  errorMessage?: string;
}

export const BUSINESS_ENV_CLI_VERSION_FIELD =
  `${BRAND_EVENT_NAMESPACE}_version` as const;

export interface EnvInfo {
  [BUSINESS_ENV_CLI_VERSION_FIELD]: string;
  os_arch: string;
  os_version: string;
}

/** Compare immutable billing identity when batching asynchronous work. */
export function isSameBusiness(
  a?: Readonly<BusinessInfo>,
  b?: Readonly<BusinessInfo>,
): boolean {
  return a?.id === b?.id && a?.model_key === b?.model_key;
}
