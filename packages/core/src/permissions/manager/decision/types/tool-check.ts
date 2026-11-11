/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// 工具自检契约。工具不依赖本包；模块只调用装配时注入的校验表，依赖单向。

import type {
  PermissionMode,
  PermissionRules,
  PreToolUseHookVerdict,
  RulesForTool,
  ToolCheckResult,
} from './decision.js';
import type { SkillCheckerDeps } from '../../../../tools/tool-checkers/content-checkers.js';
import type { SkillRules } from '../../types.js';

/** Resolved locations only; omitted fields grant no exemption. */
export interface InternalPathContext {
  readonly projectConfigDir?: string;
  readonly userConfigDir?: string;
  readonly projectStorageDir?: string;
  readonly projectTempDir?: string;
  /** Resolve only the config root, never symlinks inside the project tree. */
  readonly realProjectTempDir?: string;
  readonly taskOutputDir?: string;
  readonly pastedImageDir?: string;
  readonly inboundUploadDir?: string;
  readonly plansDir?: string;
  readonly autoMemoryDirs?: readonly string[];
  readonly agentMemoryDirs?: readonly string[];
  readonly mcpOutputDirName?: string;
}

/**
 * 工具对自身调用的意见，三选一，没有跳过——校验器必须表态。
 *
 * TExtra 是工具递给自己的草稿区，四条约定靠契约不靠类型：
 * 1. 只有生产者读；2. 不带权限语义（结果只看 kind）；3. 不带展示文案（那是 reason）；
 * 4. 生命周期只有一个 toolUseId。
 *
 * 抛异常的自检降级为 deny（fail-closed）。
 */
export interface ToolPermissionChecker<
  TReason = unknown,
  TExtra = unknown,
  TSuggestion = unknown,
> {
  check(
    input: Record<string, unknown>,
    ctx: ToolCheckContext<TReason>,
  ):
    | ToolCheckResult<TReason, TExtra, TSuggestion>
    | Promise<ToolCheckResult<TReason, TExtra, TSuggestion>>;
}

// 只读视图，每次调用（含重跑）新建一份，携带判定所依据的配置快照。
// oxlint-disable-next-line no-unused-vars
export interface ToolCheckContext<TReason = unknown> {
  readonly internalPaths?: InternalPathContext;
  readonly mode: PermissionMode;
  readonly rules: PermissionRules;
  readonly cwd: string;
  readonly additionalDirectories: string[];
  // 宿主 PreToolUse hook 裁决，只读透传；组件不读取、不据此判定。
  readonly preToolUseHookVerdict?: PreToolUseHookVerdict;
  readonly rulesForTool: RulesForTool;
  /** 当前被判定调用的工具名；跨工具复用的路径检查据此区分归属。 */
  readonly toolName?: string;
  readonly toolUseId: string;
  readonly agentId?: string;
  readonly signal?: AbortSignal;
  /** 会话 Skill 视图；Skill checker 的会话依赖从这里读。 */
  readonly skill?: SkillCheckerDeps;
  /** 本次判定的技能规则覆盖；来自 PermissionContext。 */
  readonly skillRules?: SkillRules;
  /** 会话模式层：原始 checker 给出 ask 后由会话解析成最终结论。 */
  readonly resolveAsk?: (
    ask: Extract<ToolCheckResult<TReason>, { kind: 'ask' }>,
  ) => ToolCheckResult<TReason> | Promise<ToolCheckResult<TReason>>;
  /** 本会话当前可用的 MCP 工具视图；lazy 模式下与分发器同一份索引。 */
  readonly isMcpToolKnown?: (qualifiedName: string) => boolean;
  /** Auto 模式授权分类器的会话视图；按本次调用的 agentId 绑定。 */
  readonly autoClassifier?: AutoClassifierView<TReason>;
}

export interface AutoClassifierView<TReason = unknown> {
  classify(
    facts: { toolName: string; coveredByAcceptEdits: boolean },
    input: Record<string, unknown>,
    toolCheckContext: ToolCheckContext<TReason>,
    ask: Extract<ToolCheckResult<TReason>, { kind: 'ask' }>,
    messages?: readonly unknown[],
    session?: import('../../../permission-modes/auto/auto-classifier.js').AutoClassifierSession,
  ): Promise<ToolCheckResult<TReason>>;
}
