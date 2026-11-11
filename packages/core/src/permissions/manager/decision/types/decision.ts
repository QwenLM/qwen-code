/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// 跨模块边界的数据结构。两条原则：
// 1. 词汇表封闭（mode/kind/behavior/source 取值写死），“为什么”的载荷开放
//    （TReason 归宿主，本包只搬运）。
// 2. 不感知具体工具：规则只按工具名筛选，内容是否命中由宿主的自检判断。

// 模式词表统一由本包持有，值为落盘/上报用的 camelCase 字符串。
// Default=写入/执行先询问；AcceptEdits=编辑预放行；Auto=宿主分类后拿不准才问；
// DontAsk=不弹窗、原本要问的直接拒绝；Yolo=全放行，deny 也不拦。
export const PermissionModes = {
  Default: 'default',
  AcceptEdits: 'acceptEdits',
  Auto: 'auto',
  DontAsk: 'dontAsk',
  Yolo: 'yolo',
} as const;

export type PermissionMode =
  (typeof PermissionModes)[keyof typeof PermissionModes];

// 仅声明顺序，不是强弱排序。
export const PERMISSION_MODES: readonly PermissionMode[] = [
  PermissionModes.Default,
  PermissionModes.AcceptEdits,
  PermissionModes.Auto,
  PermissionModes.DontAsk,
  PermissionModes.Yolo,
] as const;

// 兼容存量配置的旧拼写。
const PERMISSION_MODE_ALIASES: Readonly<Record<string, PermissionMode>> = {
  bypassPermissions: PermissionModes.Yolo,
  accepting_edits: PermissionModes.AcceptEdits,
};

// 认不出返回 undefined，降级还是拒绝由调用方决定。
export function normalizePermissionMode(
  value: string,
): PermissionMode | undefined {
  if ((PERMISSION_MODES as readonly string[]).includes(value)) {
    return value as PermissionMode;
  }
  return PERMISSION_MODE_ALIASES[value];
}

// 模式判断统一入口：宿主一律用这些谓词，不做字面量比较——
// 词表在这里，判断也在这里，词表演进时漏改会编译失败。
export function isDefaultMode(mode: PermissionMode): boolean {
  return mode === PermissionModes.Default;
}

export function isAcceptEditsMode(mode: PermissionMode): boolean {
  return mode === PermissionModes.AcceptEdits;
}

export function isAutoMode(mode: PermissionMode): boolean {
  return mode === PermissionModes.Auto;
}

export function isDontAskMode(mode: PermissionMode): boolean {
  return mode === PermissionModes.DontAsk;
}

export function isYoloMode(mode: PermissionMode): boolean {
  return mode === PermissionModes.Yolo;
}

export type PermissionBehavior = 'allow' | 'deny' | 'ask';

// 来源只用于署名和决定“记住授权”写到哪个文件，不影响优先级。
export type PermissionRuleSource =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'flagSettings'
  | 'policySettings'
  | 'cliArg'
  | 'command'
  | 'session';

// ruleContent 是括号内原文，本包不解释。
export type PermissionRuleValue = {
  toolName: string;
  ruleContent?: string;
};

export type PermissionRule = {
  source: PermissionRuleSource;
  ruleBehavior: PermissionBehavior;
  ruleValue: PermissionRuleValue;
};

export type PermissionRulesBySource = {
  [S in PermissionRuleSource]?: string[];
};

export type PermissionRules = {
  allow: PermissionRulesBySource;
  deny: PermissionRulesBySource;
  ask: PermissionRulesBySource;
};

// 某工具名下的规则，按粒度×行为×来源索引：toolLevel=无内容规则，
// toolDetailLevel=带内容规则。只出现确有规则的来源。
export interface RulesForTool {
  toolLevel: {
    allow: PermissionRulesBySourceForTool;
    deny: PermissionRulesBySourceForTool;
    ask: PermissionRulesBySourceForTool;
  };
  toolDetailLevel: {
    allow: PermissionRulesBySourceForTool;
    deny: PermissionRulesBySourceForTool;
    ask: PermissionRulesBySourceForTool;
  };
}

export type PermissionRulesBySourceForTool = Partial<
  Record<PermissionRuleSource, readonly PermissionRule[]>
>;

export type PermissionRequest = {
  toolName: string;
  input: Record<string, unknown>;
  toolUseId: string;
  agentId?: string;
  signal?: AbortSignal;
};

// 宿主 PreToolUse hook 已给出的裁决。组件只透传不解释：优先级编排、
// deny 短路、ask 折叠全部是宿主的事。
export interface PreToolUseHookVerdict {
  behavior: PermissionBehavior;
  message?: string;
  reason?: string;
}

export type DecisionKind = 'allow' | 'ask' | 'deny';

// 模块先跑自检，自检给 ask 才交给 handler；handler 必须给终局，
// 所以模块对外永远不返回 ask 决定。
export type StageKind = 'toolCheck' | 'ask';

// ask 阶段怎么落定的——就是 handler 交回来那一态，不另立词表。check-task 把
// handleResult.kind 直接传进来，所以 AskHandleResult 增态会在这里编译失败。
// 没有 handler 可问时不存在这一项（见 PermissionDecision.settlement）。
export type AskSettlementKind = 'approved' | 'rejected' | 'aborted';

// 三选一，没有不表态。TReason 仅在 ask 分支必填（宿主要渲染的文案）；
// TExtra 契约见 tool-check.ts；TSuggestion 是工具与宿主间的不透明约定。
export type ToolCheckResult<
  TReason = unknown,
  TExtra = unknown,
  TSuggestion = unknown,
> =
  | { kind: 'allow'; extra?: TExtra }
  | { kind: 'ask'; reason: TReason; extra?: TExtra; suggestions?: TSuggestion[] }
  | { kind: 'deny'; extra?: TExtra };

// 模块唯一输出，各消费方（展示/埋点/协议）自行投影。
export interface PermissionDecision<TReason = unknown> {
  kind: DecisionKind;
  decidedBy: StageKind;
  // 首次自检的询问文案，仅 ask 阶段跑过时存在。
  reason?: TReason;
  // 拒绝方措辞，与 reason 独立并存，宿主可并进给模型看的内容。
  denialMessage?: string;
  // ask 阶段怎么落定的。字段存在 ⟺ 真的问过 handler（handler 抛异常算 aborted）；
  // 于是 decidedBy==='ask' 却没有这一项，就是没有 handler 可问的 fail-closed。
  // 与 kind 独立：批准时改过参数、改后又过不了自检，是 settlement='approved' 配 kind='deny'。
  settlement?: AskSettlementKind;

  toolName: string;
  input: Record<string, unknown>;
  suggestions?: unknown[];

  toolCheck: ToolCheckResult<TReason>;
  // 配置变更重跑的结果，按时间排列。
  history: Array<ToolCheckResult<TReason>>;
  // 阶段轨迹；组件只记录自己的阶段，宿主侧分层（如 hook）自行叠加。
  stages: DecisionStage[];

  toolUseId: string;
}

export interface DecisionStage {
  stage: 'toolCheck' | 'recheck' | 'ask';
  verdict: DecisionKind;
}
