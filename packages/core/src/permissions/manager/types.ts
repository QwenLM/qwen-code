/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AskHandleContext,
  AskHandleResult,
  PermissionMode,
  PermissionRequest,
  PermissionRules,
  PreToolUseHookVerdict,
} from './decision/index.js';
import type {
  HostToolChecker,
  ToolPermissionResult,
} from '../../tools/tool-checkers/rule-precedence.js';
import type { ToolPermissionReason } from '../../tools/tool-checkers/checker-reasons.js';
import type { SessionMcpManager } from '../../mcp/sessionMcpManager/sessionMcpManager.js';
import type { LazyMcpToolEntry } from '../../mcp/sessionMcpManager/types.js';
import type { SkillCheckerDeps } from '../../tools/tool-checkers/content-checkers.js';
import type { ToolCheckContext } from './decision/index.js';
import type { AutoModeUserConfig } from '../permission-modes/auto/classifier.js';
import type { AutoSessionJudges } from '../permission-modes/auto/auto-judge.js';
import type {
  EditableSettingSource,
  PermissionsSettingsJson,
} from '../settings/permissionsLoader.js';

export type Scene = 'main' | 'probe' | `fork:${string}` | (string & {});

export type Checker = HostToolChecker;

export type CheckerFactory = (
  scene: Scene,
  toolName: string,
) => Checker | undefined;

export interface SkillRules {
  readonly grants?: readonly string[];
  readonly disabled?: ReadonlySet<string>;
  readonly safeProperties?: ReadonlySet<string>;
}

export interface CheckRequest extends PermissionRequest {
  readonly preToolUseHookVerdict?: PreToolUseHookVerdict;
}

export interface PermissionContext {
  readonly agentId?: string;
  readonly scene?: Scene;
  readonly mode?: PermissionMode;
  readonly rules?: PermissionRules;
  readonly additionalRules?: PermissionRules;
  readonly additionalDirectories?: readonly string[];
  readonly skillRules?: SkillRules;
  readonly messages?: readonly unknown[];
  readonly canPrompt?: boolean;
}

export interface ModeGate {
  readonly ok: boolean;
  readonly reason?: string;
  readonly message?: string;
}

export interface ModeListing {
  readonly mode: PermissionMode;
  readonly available: boolean;
  readonly reason?: string;
}

export interface ModeChangeResult {
  readonly previous: PermissionMode;
  readonly current: PermissionMode;
  readonly recheckPending: boolean;
  readonly resolvePending: boolean;
}

export interface FlagSettings {
  readonly initialMode: PermissionMode;
  readonly rules: PermissionRules;
  readonly additionalDirectories: readonly string[];
}

export interface ManagedPolicy {
  /** 判定前等待首次读取结束；静态策略无需实现。 */
  whenReady?(): Promise<void>;
  /** 当前托管规则；每次判定读取。 */
  getRules(): PermissionRules;
  /** 模式被托管策略禁用时返回限制，未禁用返回 undefined。 */
  getModeRestriction(
    mode: PermissionMode,
  ): { readonly message?: string } | undefined;
  /** 释放策略自身的监听或轮询。 */
  dispose(): void;
  /** 策略内容变化通知；没有变更通道的实现可以不提供。 */
  subscribe?(listener: () => void): () => void;
}

export interface SessionPermissionOptions {
  /** 进程级 Auto 分类器；会话只借视图，不持有判定资源。 */
  readonly autoClassifier: import('../permission-modes/auto/auto-classifier.js').AutoClassifier;
  /** 策略内容的更新由策略对象自己维护；会话只读当前快照。 */
  readonly managedPolicy: ManagedPolicy;
  /** 会话身份实时读取；resume / 切换会话后自动跟随。 */
  readonly getSessionId: () => string;
  /** 会话当前工作目录；每次判定实时读取，Worktree 切换后自动跟随。 */
  readonly getWorkingDir: () => string;
  readonly rules: PermissionRules;
  readonly modes: Record<PermissionMode, PermissionModeDefinition>;
  readonly askHandler?: AskHandler;
  readonly getChecker: CheckerFactory;
  /** 进程级 manager 维护的场景 checker 表；会话只读同一份，不自行组装。 */
  readonly sceneCheckers?: ReadonlyMap<Scene, ReadonlyMap<string, HostToolChecker>>;
  readonly sessionMcpManager?: SessionMcpManager;
  /** 为直接注册的 MCP 工具构造 checker；会话按 MCP 工具表变化实时同步。 */
  readonly createMcpToolChecker?: (entry: LazyMcpToolEntry) => HostToolChecker;
  /** 宿主注入的旧工具名别名表；组件不内置任何宿主的表。 */
  readonly toolNameAliases?: Record<string, string>;
  /** 会话的 SkillManager 视图；Skill checker 的会话依赖从这里读。 */
  readonly skill?: SkillCheckerDeps;
  /** 创建绑定当前会话请求能力的审批 Judge。 */
  readonly createSessionJudges?: () => AutoSessionJudges;
  /** 用户全局 autoMode 规则（每次判定读取）。 */
  readonly autoModeUserConfig?: () => AutoModeUserConfig | undefined;
  /** shadow judge 对比结果上报；由宿主注入。 */
  readonly reportAutoShadowComparison?: (
    comparison: import('../permission-modes/auto/auto-classifier.js').AutoClassifierShadowComparison,
  ) => void;
  readonly isAutoShadowReportingEnabled?: () => boolean;
  /** 用户全局 memory 作为 classifier 的常驻指令。 */
  readonly autoModeUserInstructions?: () => string | undefined;
  /** 权限设置读写；由宿主按会话注入，读写都经 SettingsService 的会话投影。 */
  readonly permissionSettings?: {
    getSettingsForSource(source: EditableSettingSource): PermissionsSettingsJson | null;
    mutateSettingsForSource(
      source: EditableSettingSource,
      mutation: (data: PermissionsSettingsJson) => boolean,
    ): { error?: Error };
  };

  /** 会话设置来源的模式限制；全局托管限制已在 modes.isAvailable 里。 */
  readonly getSessionModeRestriction?: (
    mode: PermissionMode,
  ) => string | undefined;
  readonly initialMode: PermissionMode;
  readonly directories: {
    readonly additional: readonly string[];
  };
  /** 会话的 transcript 与工具表；每次判定随会话配置传给分类器。 */
  readonly classifierInputs?: import('../permission-modes/auto/auto-classifier.js').SessionClassifierInputs;
}

export interface AskHandler {
  handleAsk(
    sessionId: string,
    ask: AskHandleContext<ToolPermissionReason, unknown, unknown>,
  ): Promise<AskHandleResult>;
}

export interface ModeResolveContext {
  readonly mode: PermissionMode;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly agentId?: string;
  readonly rules: PermissionRules;
  readonly skillRules?: SkillRules;
  readonly messages?: readonly unknown[];
  readonly signal?: AbortSignal;
  /** 本次判定的原始工具上下文；Auto 分类器需要其中的事实。 */
  readonly toolCheckContext?: ToolCheckContext<ToolPermissionReason>;
  /** AcceptEdits 覆盖的文件编辑工具；checker 注册期声明的性质。 */
  readonly coveredByAcceptEdits?: boolean;
  /** Auto 授权分类器的会话视图；由 ToolCheck 按 agentId 注入。 */
  readonly autoClassifier?: import('./decision/index.js').AutoClassifierView<ToolPermissionReason>;
  /** 本次判定的会话级 auto 配置；分类器不持有会话对象。 */
  readonly autoSession?: import('../permission-modes/auto/auto-classifier.js').AutoClassifierSession;
}

export interface PermissionModeDefinition {
  resolve(
    ask: Extract<ToolPermissionResult, { kind: 'ask' }>,
    ctx: ModeResolveContext,
  ): ToolPermissionResult | Promise<ToolPermissionResult>;

  isAvailable(): ModeGate;
}

