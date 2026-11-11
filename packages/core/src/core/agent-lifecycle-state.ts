/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { runLogger } from '../utils/runLogger.js';
import type {
  BusinessInfo,
  BusinessType,
  BusinessProduct,
  BusinessStage,
  CmdInfo,
  ErrorInfo,
  EnvInfo,
} from '../qoder/business-info.js';
import {
  BusinessProductCLI,
  BusinessTypeAgent,
  BusinessTypeCodeReview,
  BusinessStageInit,
  BusinessStageStart,
  BusinessStageProcessing,
  BusinessStageComplete,
  BusinessStageAbort,
  BusinessStageError,
  BUSINESS_ENV_CLI_VERSION_FIELD,
  applyBusinessSubTask,
} from '../qoder/business-info.js';
import {
  ENV_BUSINESS_PRODUCT,
  getConfiguredBusinessProduct,
  ENV_BUSINESS_TYPE,
} from '../config/brand.js';
import type { Terminal } from './query-event.js';
import { getVersion } from '../utils/version.js';
import {
  getBusinessInfoFromContext,
  getRequestSetIdFromContext,
} from '../utils/sessionIdContext.js';
import { resolveSubagentBusinessSubTask } from './subagent-business-subtask.js';

// ---------------------------------------------------------------------------
// Snapshot type (plain object, used by reporters / tests)
// ---------------------------------------------------------------------------

/** 子 Agent 调用上下文。 */
export interface SubagentContext {
  agentId: string;
  agentType: string;
  subagentName?: string;
  invokingRequestId?: string;
  parentRequestId?: string;
  depth: number;
}

export interface AgentLifecycleSnapshot {
  readonly requestSetId: string;
  readonly sessionId: string;
  readonly businessInfo: Readonly<BusinessInfo>;
  readonly cmdInfo: Readonly<CmdInfo>;
  readonly errorInfo?: Readonly<ErrorInfo>;
  readonly envInfo: Readonly<EnvInfo>;
  readonly subagentContext?: Readonly<SubagentContext>;
}

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

/**
 * Mutable lifecycle state for one query() invocation.
 * Use the static factory `AgentLifecycleState.create()` to construct.
 */
export class AgentLifecycleState {
  readonly requestSetId: string;
  readonly sessionId: string;
  /** 是否为子 agent 实例。子 agent 的 businessInfo 为只读，所有状态变更方法均为 no-op。 */
  private readonly _isSubagent: boolean;
  private _businessInfo: BusinessInfo;
  private _cmdInfo: CmdInfo;
  private _errorInfo: ErrorInfo | undefined;
  private _envInfo: EnvInfo;
  private _subagentContext: SubagentContext | undefined;

  private constructor(
    requestSetId: string,
    sessionId: string,
    businessInfo: BusinessInfo,
    cmdInfo: CmdInfo,
    envInfo: EnvInfo,
    isSubagent: boolean = false,
  ) {
    this.requestSetId = requestSetId;
    this.sessionId = sessionId;
    this._isSubagent = isSubagent;
    this._businessInfo = businessInfo;
    this._cmdInfo = cmdInfo;
    this._envInfo = envInfo;
  }

  // ── Accessors ──────────────────────────────────────────────────────────

  get businessInfo(): Readonly<BusinessInfo> {
    return this._businessInfo;
  }


  get subagentContext(): Readonly<SubagentContext> | undefined {
    return this._subagentContext;
  }

  // ── State transitions ──────────────────────────────────────────────────

  /**
   * 标记为子 agent 调用，并填充子 agent 上下文。
   * 仅应在 agentType === 'sub' 时调用。
   */
  setSubagentContext(ctx: SubagentContext): void {
    this._subagentContext = { ...ctx };
  }

  /**
   * Advance the business stage: init → start → processing.
   * Aligned with Go executionState.ChangeBusinessState().
   * - If stage is 'init', advance to 'start'.
   * - If stage is 'start', advance to 'processing'.
   * - Otherwise, no-op.
   */
  changeBusinessState(): void {
    if (this._isSubagent) return; // subagent: no-op，businessInfo 由主 agent 管理
    const stage = this._businessInfo.stage;
    if (!this._businessInfo.id) {
      runLogger.warn(
        '[AgentLifecycle] changeBusinessState: no business info id',
      );
      return;
    }
    if (stage === BusinessStageInit) {
      this._businessInfo = { ...this._businessInfo, stage: BusinessStageStart };
    } else if (stage === BusinessStageStart) {
      this._businessInfo = {
        ...this._businessInfo,
        stage: BusinessStageProcessing,
      };
    }
    // NOTE: 不再调用 businessInfoContext.enterWith()。
    // 所有需要 businessInfo 上下文的代码路径（工具执行、压缩管道、子 agent 创建）
    // 均已通过 businessInfoContext.run(lifecycle.businessInfo, ...) 显式包裹，
    // lifecycle.businessInfo accessor 始终返回最新值。enterWith() 在并发场景下
    // 会污染不相关的异步链，与 run() 模式矛盾。
  }


  /**
   * Finalise: map Terminal.reason to a business stage, fill end_at,
   * and optionally record error details.
   */
  finalize(terminalReason: Terminal['reason'], error?: Error): void {
    if (this._isSubagent) return; // subagent: no-op，终态由主 agent finalize 负责
    this._businessInfo = {
      ...this._businessInfo,
      stage: mapTerminalToBusinessStage(terminalReason),
      end_at: Date.now(),
    };
    if (error) {
      this._errorInfo = {
        error,
        // 从自定义错误类型提取 code/message，对齐 Go types.Error.Code() / types.Error.Message()
        errorCode: (error as Error & { code?: string }).code,
        errorMessage: error.message,
      };
    }
  }

  // ── Snapshot ────────────────────────────────────────────────────────────

  /**
   * Return an immutable plain-object snapshot of the current state.
   * Suitable for passing to reporters or serialisation.
   */
  snapshot(): AgentLifecycleSnapshot {
    return {
      requestSetId: this.requestSetId,
      sessionId: this.sessionId,
      businessInfo: { ...this._businessInfo },
      cmdInfo: { ...this._cmdInfo },
      ...(this._errorInfo !== undefined
        ? { errorInfo: { ...this._errorInfo } }
        : {}),
      envInfo: { ...this._envInfo },
      ...(this._subagentContext !== undefined
        ? { subagentContext: { ...this._subagentContext } }
        : {}),
    };
  }

  // ── Static factory ──────────────────────────────────────────────────────

  /**
   * Create the initial lifecycle state for a query() invocation.
   * Generates a new requestId and initialises businessInfo with stage='init'.
   *
   * @param sessionId      当前 session ID
   * @param prompt         用户输入
   */
  static async create(
    sessionId: string,
    prompt: string,
    querySource?: string,
    requestSetIdOverride?: string,
    preallocatedRequestSetId?: string,
    businessInfoOverride?: Readonly<BusinessInfo>,
  ): Promise<AgentLifecycleState> {
    const version = await getVersion();
    const requestSetId =
      requestSetIdOverride || preallocatedRequestSetId || randomUUID();
    const businessInfo = businessInfoOverride
      ? { ...businessInfoOverride }
      : createBusinessInfo(
          version,
          sessionId,
          prompt,
          querySource,
          requestSetIdOverride,
        );
    const instance = new AgentLifecycleState(
      requestSetId,
      sessionId,
      businessInfo,
      createCmdInfo(prompt),
      createEnvInfo(version),
    );
    // NOTE: 不再调用 requestSetIdContext.enterWith() / businessInfoContext.enterWith()。
    // query() 中所有需要上下文的代码路径均已通过 run() 显式包裹 lifecycle.requestSetId
    // 和 lifecycle.businessInfo。enterWith() 在并发场景（SDK 模式、并行 subagent 初始化）
    // 中会覆盖其他会话的上下文，与 run() 模式矛盾。
    runLogger.debug(
      `[AgentLifecycle] create: requestSetId=${requestSetId}, businessInfo=${JSON.stringify(businessInfo)}`,
    );
    return instance;
  }

  /**
   * Create a subagent lifecycle state that inherits the parent's businessInfo (read-only).
   * All state-mutation methods (changeBusinessState / finalize) are no-op
   * on subagent instances — the parent agent owns the businessInfo lifecycle.
   *
   * @param sessionId       当前 session ID（子 agent 与父 agent 共享同一 sessionId）
   * @param prompt          子 agent 的输入
   * @param parentBusinessInfo  父 agent 的 businessInfo（只读共享）
   * @param promptId        触发本次子 agent 调用的请求 ID
   * @param parentRequestSetId 父 agent 的 requestSetId（显式传参，不依赖 AsyncLocalStorage）
   * @param subagentType    运行时子 Agent 类型，用于生成受控的 business.sub_task
   */
  static async createForSubagent(
    sessionId: string,
    prompt: string,
    parentBusinessInfo?: Readonly<BusinessInfo>,
    promptId?: string,
    parentRequestSetId?: string,
    subagentType = '',
  ): Promise<AgentLifecycleState> {
    const normalizedSubagentType = subagentType.trim() || 'subagent';
    const subagentBusinessSubTask =
      resolveSubagentBusinessSubTask(subagentType);
    const version = await getVersion();
    const newParentRequestSetId =
      parentRequestSetId ?? getRequestSetIdFromContext() ?? randomUUID();
    const inheritedBusinessInfo =
      parentBusinessInfo ?? getBusinessInfoFromContext();
    if (!inheritedBusinessInfo) {
      runLogger.error(
        '[SubAgentLifecycle] createForSubagent: businessInfo not found — neither parentBusinessInfo was passed nor available in AsyncLocalStorage context. ' +
          `promptId=${promptId}, sessionId=${sessionId}. Falling back to creating a new BusinessInfo.p
  `,
      );
    }
    const requestSetId = randomUUID();
    const businessInfo: BusinessInfo = inheritedBusinessInfo
      ? applyBusinessSubTask(
          { ...inheritedBusinessInfo },
          undefined,
          subagentBusinessSubTask,
        )
      : {
          ...applyBusinessSubTask(
            createBusinessInfo(version, sessionId, prompt),
            undefined,
            subagentBusinessSubTask,
          ),
          orphan: true,
        };
    const instance = new AgentLifecycleState(
      requestSetId,
      sessionId,
      businessInfo,
      createCmdInfo(prompt),
      createEnvInfo(version),
      true, // isSubagent
    );
    instance.setSubagentContext({
      agentId: requestSetId,
      agentType: normalizedSubagentType,
      invokingRequestId: promptId,
      parentRequestId: newParentRequestSetId,
      depth: 1,
    });
    runLogger.debug(
      `[SubAgentLifecycle] createForSubagent: requestSetId=${requestSetId}, businessInfo=${JSON.stringify(businessInfo)}`,
    );
    return instance;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers (migrated from agent-loop.ts)
// ---------------------------------------------------------------------------

function mapTerminalToBusinessStage(reason: Terminal['reason']): BusinessStage {
  switch (reason) {
    case 'abort':
    case 'repeated_tool_call_denied':
      return BusinessStageAbort;
    case 'error':
    case 'max_turns':
      return BusinessStageError;
    case 'end_turn':
    default:
      return BusinessStageComplete;
  }
}

/**
 * 生成业务名称，对齐 Go CLI getBusinessName() 逻辑。
 * - BusinessTypeCodeReview: 使用 sessionId
 * - BusinessTypeAgent 及其他: 取用户输入前 10 个 Unicode 字符
 */
function getBusinessName(
  businessType: BusinessType,
  sessionId: string,
  prompt: string,
): string {
  switch (businessType) {
    case BusinessTypeCodeReview:
      return sessionId;
    case BusinessTypeAgent:
    default: {
      return prompt.length > 10 ? prompt.slice(0, 10) : prompt;
    }
  }
}

/**
 * Resolve the business product and type for this process.
 *
 * Each field is resolved independently: an explicit ENV_BUSINESS_PRODUCT or
 * ENV_BUSINESS_TYPE overrides only that field, otherwise it falls back to the
 * CLI defaults (cli / agent). This keeps `business.product` / `business.type`
 * consistent with the Cosy-Business-Product / Cosy-Business-Type headers
 * emitted by the WASM auth plugin.
 *
 * `ENV_BUSINESS_SUB_TASK` is copied into `business.sub_task` only when the
 * querySource is not one of the built-in explicit sub-task scenarios.
 */
export function resolveBusinessIdentity(): {
  product: BusinessProduct;
  type: BusinessType;
} {
  return {
    product: getConfiguredBusinessProduct() ?? process.env[ENV_BUSINESS_PRODUCT] ?? BusinessProductCLI,
    type: process.env[ENV_BUSINESS_TYPE] ?? BusinessTypeAgent,
  };
}

/**
 * 初始化 BusinessInfo，对齐 Go CLI StartBusiness() 逻辑。
 */
function createBusinessInfo(
  version: string,
  sessionId: string,
  prompt: string,
  querySource?: string,
  businessId?: string,
  businessType?: string,
): BusinessInfo {
  const identity = resolveBusinessIdentity();
  const product = identity.product;
  const type = businessType ?? identity.type;
  return applyBusinessSubTask(
    {
      product,
      version,
      type,
      id: businessId || randomUUID(),
      name: getBusinessName(type, sessionId, prompt),
      begin_at: Date.now(),
      stage: BusinessStageInit,
    },
    querySource,
  );
}

/**
 * 创建 cmdInfo，对齐 Go CLI StartBusiness() 逻辑。
 */
function createCmdInfo(prompt: string): CmdInfo {
  // TODO: 解析 prompt-> cmd
  runLogger.debug(
    `[AgentLifecycle] createCmdInfo prompt="${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`,
  );
  return {
    command_type: 'query',
    command_location: 'built-in',
  };
}

function createEnvInfo(version: string): EnvInfo {
  return {
    [BUSINESS_ENV_CLI_VERSION_FIELD]: version,
    os_arch: process.arch,
    os_version: process.platform,
  };
}

/** Allocate the main turn business before any asynchronous derived requests start. */
export async function createQueryBusinessInfo(
  sessionId: string,
  prompt: string,
  businessId: string,
  querySource?: string,
  modelKey?: string,
  businessType?: string,
): Promise<BusinessInfo> {
  return {
    ...createBusinessInfo(
      await getVersion(),
      sessionId,
      prompt,
      querySource,
      businessId,
      businessType,
    ),
    ...(modelKey ? { model_key: modelKey } : {}),
  };
}
