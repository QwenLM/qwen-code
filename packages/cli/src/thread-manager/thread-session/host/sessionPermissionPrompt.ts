/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 权限提示的产品内容：`title` / `description` / `details` 的计算（进程内会话自有一份）。
 *
 * 这些函数决定一次工具调用如何被解释成人可读的提示，字段集属于 SDK 消费方可见的
 * 对外契约。内容是产品事实而非帧构造：把内容投影成 `title` / `description` /
 * `permission_suggestions` / `blocked_path` 等 wire 字段归宿主。
 */

import {
  buildConfirmationDetails,
  presentationOptionsForPrompt,
  breakerConfirmationDetails,
  EXIT_PLAN_MODE_TOOL_NAME,
  READ_FILE_TOOL_NAME,
  resolveCurrentPlanPath,
  type AgentLoopContext,
  type AnyDeclarativeTool,
  type AskPrompt,
  type Config,
  type SerializableConfirmationDetails,
} from '@qwen-code/core';

import { homedir } from 'node:os';

export type CanUseToolDefinition = NonNullable<
  ReturnType<AgentLoopContext['toolRegistry']['getTool']>
>;

export function getCanUseToolTitle(
  details: SerializableConfirmationDetails | undefined,
): string {
  return details && typeof details.title === 'string' ? details.title : '';
}

export function getCanUseToolDescription(
  details: SerializableConfirmationDetails | undefined,
  toolDef: CanUseToolDefinition | undefined,
  toolInput: Record<string, unknown>,
  toolName: string,
): string {
  if (
    details &&
    details.type === EXIT_PLAN_MODE_TOOL_NAME &&
    typeof details.planPath === 'string'
  ) {
    return `Exiting plan mode via ${details.planPath}`;
  }

  const desc = toolInput['description'];
  if (desc && typeof desc === 'string' && desc.length > 0) {
    return desc;
  }

  const filePath = toolInput['file_path'];
  if (
    toolName === READ_FILE_TOOL_NAME &&
    filePath &&
    typeof filePath === 'string' &&
    filePath.length > 0
  ) {
    return formatHomeRelativePath(filePath);
  }

  return toolDef?.description ?? '';
}

function formatHomeRelativePath(filePath: string): string {
  const home = homedir();
  if (!home) {
    return filePath;
  }
  if (filePath === home) {
    return '~';
  }
  return filePath.startsWith(`${home}/`)
    ? `~/${filePath.slice(home.length + 1)}`
    : filePath;
}

/**
 * 提示随问题一起带出的富载荷：放在这里而不是挂在 prompt 上，因为要多少细节是
 * 通道的决定，且构造需要工具实例，prompt 不带它。
 */
export async function buildCanUseToolPromptDetails(
  config: Config,
  prompt: AskPrompt,
  toolDef: AnyDeclarativeTool | undefined,
): Promise<SerializableConfirmationDetails | undefined> {
  const breaker = breakerConfirmationDetails(prompt.reason);
  if (breaker) {
    return breaker;
  }
  if (!toolDef) {
    return undefined;
  }
  try {
    return await buildConfirmationDetails(
      toolDef,
      prompt.input,
      prompt.reason.message,
      toolDef.name === EXIT_PLAN_MODE_TOOL_NAME
        ? resolveCurrentPlanPath(config)
        : undefined,
      config.getTargetDir?.(),
      undefined,
      presentationOptionsForPrompt(prompt),
    );
  } catch {
    // 构造不出载荷不能阻止我们发问。
    return undefined;
  }
}
