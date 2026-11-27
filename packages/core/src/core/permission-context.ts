/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content, Part } from '@google/genai';
import { ApprovalMode } from '../config/approval-mode.js';
import { wrapSystemReminder } from './environmentContext.js';
import { isUserPromptSubmitContextPartText } from '../hooks/user-prompt-submit-context.js';

export const PERMISSION_CONTEXT_METADATA = 'qwen-code:permission-context';

const MODE_GUIDANCE: Record<ApprovalMode, string> = {
  [ApprovalMode.DEFAULT]:
    'Tool defaults and permission rules determine which actions require approval. Read-only or explicitly allowed actions may run without a prompt.',
  [ApprovalMode.AUTO_EDIT]:
    'File edits may be auto-approved. Other actions still follow permission rules and confirmation checks.',
  [ApprovalMode.AUTO]:
    'An automatic reviewer can evaluate actions that require review. Runtime checks may still deny an action or require manual approval.',
  [ApprovalMode.YOLO]:
    'Tool approvals are bypassed where permitted. Explicit deny rules and other runtime restrictions still apply.',
  [ApprovalMode.PLAN]:
    'Plan-mode restrictions apply. Only operations permitted by the plan-mode runtime may execute.',
};

export function findLatestPermissionContext(
  history: readonly Content[],
): Part | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== 'user') continue;
    const snapshot = history[i].parts?.findLast((part) => {
      const mode = part.partMetadata?.[PERMISSION_CONTEXT_METADATA];
      return typeof mode === 'string' && Object.hasOwn(MODE_GUIDANCE, mode);
    });
    if (snapshot) return snapshot;
  }
  return undefined;
}

export function getPermissionContextSnapshot(
  history: readonly Content[],
  mode: ApprovalMode,
): Part | undefined {
  const text = wrapSystemReminder(
    `Effective permissions (runtime snapshot; supersedes earlier permission-mode context):
The current runtime approval mode is \`${mode}\`.
${MODE_GUIDANCE[mode]}
Use this runtime state instead of inferring the current mode from settings files or successful tool calls. A successful tool call alone does not establish whether a user approved it. The runtime enforces permissions for each tool call; this context does not grant additional permissions.`,
  );
  const previous = findLatestPermissionContext(history);
  if (
    previous?.partMetadata?.[PERMISSION_CONTEXT_METADATA] === mode &&
    previous.text === text
  )
    return undefined;
  return { text, partMetadata: { [PERMISSION_CONTEXT_METADATA]: mode } };
}

export function appendPermissionContext(
  history: Content[],
  snapshot: Part,
): void {
  const last = history.at(-1);
  if (last?.role !== 'user') {
    history.push({ role: 'user', parts: [snapshot] });
    return;
  }
  const parts = last.parts ?? [];
  const offset = isUserPromptSubmitContextPartText(parts.at(-1)?.text ?? '')
    ? parts.length - 1
    : parts.length;
  // 按发生顺序追加，保留前导工具结果和末尾 UserPromptSubmit 收据；只复制当前消息。
  history[history.length - 1] = {
    ...last,
    parts: [...parts.slice(0, offset), snapshot, ...parts.slice(offset)],
  };
}
