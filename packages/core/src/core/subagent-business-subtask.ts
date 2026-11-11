/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 稳定的子 Agent 业务标签。
 *
 * 业务标签只区分受控的内置 Agent 与内部 fork。用户、项目、插件和 SDK
 * 动态定义的 Agent 名称不进入 business.sub_task，避免产生无界枚举值。
 */
const BUILT_IN_SUBAGENT_BUSINESS_SUB_TASKS: Readonly<
  Record<string, string>
> = {
  'general-purpose': 'agent_sub_general_purpose',
  explore: 'agent_sub_explore',
  plan: 'agent_sub_plan',
  'qoder-guide': 'agent_sub_qoder_guide',
  'statusline-setup': 'agent_sub_statusline_setup',
  'workflow-subagent': 'agent_sub_workflow',
  'team-lead': 'agent_sub_team_lead',
  compact: 'agent_sub_compact',
  'partial-compact': 'agent_sub_partial_compact',
  session_memory: 'agent_sub_session_memory',
  'memory-fork': 'agent_sub_memory_extraction',
  auto_dream: 'agent_sub_auto_dream',
  'skill-evolution-fork': 'agent_sub_skill_evolution',
};

export const CUSTOM_SUBAGENT_BUSINESS_SUB_TASK = 'agent_sub_custom';

/** 将运行时 Agent 类型映射为低基数、可长期使用的 business.sub_task。 */
export function resolveSubagentBusinessSubTask(
  agentType: string | undefined,
): string {
  const normalizedAgentType = agentType?.trim().toLowerCase();
  if (!normalizedAgentType) {
    return CUSTOM_SUBAGENT_BUSINESS_SUB_TASK;
  }
  return (
    BUILT_IN_SUBAGENT_BUSINESS_SUB_TASKS[normalizedAgentType] ??
    CUSTOM_SUBAGENT_BUSINESS_SUB_TASK
  );
}
