/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 内部读判定：只回答「这次读会不会被硬规则拒绝」，永不弹窗。
 * ask 不是拒绝：没有询问通道时它同样落不成 allow，但预读必须放行，
 * 由真正执行读/写时的权限弹窗决定，否则工作目录外写入无法发起询问。
 */

import type { ToolUseContext } from '../tools/tool-types.js';
import { READ_FILE_TOOL_NAME } from '../tools/tool-names.js';
import { permissionRuleValueFromString } from './manager/decision/index.js';
import type {
  CheckPermissionOptions,
  PermissionRequest,
  PermissionRules,
} from './manager/decision/index.js';
import type { SessionPermissionManager } from './manager/session-permission-manager.js';
import type { PermissionContext, Scene } from './manager/types.js';
import type { ToolPermissionReason } from '../tools/tool-checkers/checker-reasons.js';

export interface ReadPermissionDecision {
  /** 内部读是否被硬规则拒绝；ask 不视为拒绝。 */
  denied: boolean;
  /** check 流水线是否直接放行（Auto/Yolo 等模式已落定）。 */
  autoAllowed: boolean;
}

// Bare Read denies from these sources describe tool availability, not a
// confidentiality boundary. Path-scoped denies from the same sources still
// protect their matching paths.
const READ_AVAILABILITY_DENY_SOURCES = ['cliArg', 'command'] as const;

function withoutReadAvailabilityDenies(
  rules: PermissionRules,
): PermissionRules {
  let deny: PermissionRules['deny'] | undefined;
  for (const source of READ_AVAILABILITY_DENY_SOURCES) {
    const sourceRules = rules.deny[source];
    if (!sourceRules?.length) continue;
    const retained = sourceRules.filter((rule) => {
      const value = permissionRuleValueFromString(rule);
      return !(
        value.toolName === READ_FILE_TOOL_NAME &&
        value.ruleContent === undefined
      );
    });
    if (retained.length === sourceRules.length) continue;
    deny ??= { ...rules.deny };
    deny[source] = retained;
  }
  return deny ? { ...rules, deny } : rules;
}

function mergeRules(
  base: PermissionRules,
  overlay: PermissionRules | undefined,
): PermissionRules {
  if (!overlay) return base;
  const merge = (a: PermissionRules['allow'], b: PermissionRules['allow']) => {
    const out = { ...a };
    for (const [source, rules] of Object.entries(b)) {
      const key = source as keyof typeof out;
      out[key] = [...(out[key] ?? []), ...(rules ?? [])];
    }
    return out;
  };
  return {
    allow: merge(base.allow, overlay.allow),
    deny: merge(base.deny, overlay.deny),
    ask: merge(base.ask, overlay.ask),
  };
}

/**
 * 用会话 check 判定一次内部读；只有 deny 才算拒绝，ask 留给真实工具调用去询问。
 */
export async function checkInternalRead(
  permission: SessionPermissionManager,
  request: PermissionRequest,
  override?: CheckPermissionOptions<ToolPermissionReason>,
  scene: Scene = 'main',
): Promise<ReadPermissionDecision> {
  const baseRules = override?.rules ?? permission.getRules();
  const rules = mergeRules(baseRules, override?.additionalRules);
  const context: PermissionContext = {
    scene,
    canPrompt: false,
    ...(request.agentId !== undefined ? { agentId: request.agentId } : {}),
    ...(override?.permissionMode !== undefined
      ? { mode: override.permissionMode, canPrompt: false }
      : {}),
    rules,
  };
  const decision = await permission.check(request, context);
  if (decision.kind === 'allow') {
    return { denied: false, autoAllowed: true };
  }
  // canPrompt:false 会把无法落定的 ask 收敛成 deny；探针保留原始 ask，
  // 所以这里只认工具级硬 deny，ask 留给真实写入去询问。
  if (decision.toolCheck.kind !== 'deny') {
    return { denied: false, autoAllowed: false };
  }
  const filtered = withoutReadAvailabilityDenies(rules);
  if (filtered === rules) {
    return { denied: true, autoAllowed: false };
  }
  const recheck = await permission.check(request, { ...context, rules: filtered });
  return {
    denied: recheck.kind === 'deny' && recheck.toolCheck.kind === 'deny',
    autoAllowed: recheck.kind === 'allow',
  };
}

/** No prompts, no Auto classifier shortcut: this only judges an internal read. */
export async function fileReadPermission(
  ctx: ToolUseContext,
  filePath: string,
): Promise<ReadPermissionDecision> {
  const owner:
    | import('../config/agent-loop-context.js').AgentLoopContext
    | undefined = ctx.agentLoopContext ?? ctx.config;
  const permission = owner?.permission;
  if (!permission) return { denied: false, autoAllowed: false };
  const permissionContext = owner.permissionContext?.();
  const grants = ctx.skillPermissionOverlay?.allowedToolPatterns;
  const extra =
    grants && grants.length > 0
      ? { allow: { session: [...grants] }, deny: {}, ask: {} }
      : undefined;
  const additionalRules = permissionContext?.additionalRules
    ? mergeRules(permissionContext.additionalRules, extra)
    : extra;
  const decision = await checkInternalRead(
    permission,
    {
      toolName: READ_FILE_TOOL_NAME,
      input: { file_path: filePath },
      toolUseId: ctx.callId ?? 'internal-file-read',
      agentId: ctx.agentId,
      signal: ctx.signal,
    },
    {
      ...(permissionContext?.rules ? { rules: permissionContext.rules } : {}),
      ...(permissionContext?.mode !== undefined
        ? { permissionMode: permissionContext.mode }
        : {}),
      ...(additionalRules ? { additionalRules } : {}),
      ...(permissionContext?.additionalDirectories
        ? { additionalDirectories: [...permissionContext.additionalDirectories] }
        : {}),
      ...(ctx.config?.getTargetDir() !== undefined ? { cwd: ctx.config.getTargetDir() } : {}),
    },
    'probe',
  );
  if (!decision.autoAllowed) return decision;
  // Read 工具被裁剪时，预读不能替“先读后写”放行。
  return owner.toolRegistry.getTool(READ_FILE_TOOL_NAME) !== undefined
    ? decision
    : { ...decision, autoAllowed: false };
}
