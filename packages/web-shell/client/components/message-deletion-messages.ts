/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { plural } from '../utils/plural.js';

export const MESSAGE_DELETION_MESSAGES_EN: Record<
  string,
  string | ((vars?: Record<string, string | number>) => string)
> = {
  'messageDelete.commandFailed': 'Command failed.',
  'messageDelete.entry': 'Delete messages',
  'messageDelete.selected': (vars) =>
    `${plural(vars?.['count'], 'group')} selected`,
  'messageDelete.delete': 'Delete selected',
  'messageDelete.confirm': 'Delete permanently',
  'messageDelete.confirmTitle': (vars) =>
    `Delete ${plural(vars?.['count'], 'message group')}?`,
  'messageDelete.confirmDescription':
    'This permanently deletes the selected original messages from history. Existing summaries, command effects and project files are preserved. Information already included in a summary may still influence future replies.',
  'messageDelete.selectGroup': 'Select message group',
  'messageDelete.processing': 'Processing…',
  'messageDelete.failed':
    'Unable to delete messages. Please reload and try again.',
  'messageDelete.unsupported':
    'Deleting saved messages is not supported for this session.',
  'messageDelete.conflict':
    'Session history changed. Select the messages again before deleting.',
  'messageDelete.reopenRequired':
    'Messages were deleted. Reopen this session before sending another message.',
  'messageDelete.busy':
    'The session is processing a turn. Try again when it finishes.',
  'messageDelete.invalidHistory':
    'This history lacks reliable identities needed to safely delete the selected messages.',
  'messageDelete.unavailable':
    'This message cannot be safely matched to its saved history. Please reload and try again.',
  'messageDelete.reloadFailed':
    'Messages were deleted, but history could not be reloaded. Reload the session to refresh the remaining messages.',
};

export const MESSAGE_DELETION_MESSAGES_ZH: Record<
  string,
  string | ((vars?: Record<string, string | number>) => string)
> = {
  'messageDelete.commandFailed': '命令执行失败。',
  'messageDelete.entry': '删除消息',
  'messageDelete.selected': (vars) => `已选 ${vars?.['count'] ?? 0} 组`,
  'messageDelete.delete': '删除所选',
  'messageDelete.confirm': '确认删除',
  'messageDelete.confirmTitle': (vars) =>
    `删除 ${vars?.['count'] ?? 0} 组消息？`,
  'messageDelete.confirmDescription':
    '所选原始消息将从历史中永久删除。已有摘要、命令执行效果和项目文件保持不变。已进入摘要的信息仍可能影响后续回复。',
  'messageDelete.selectGroup': '选择消息组',
  'messageDelete.processing': '处理中…',
  'messageDelete.failed': '无法删除消息，请刷新后重试。',
  'messageDelete.unsupported': '此会话不支持删除已保存的消息。',
  'messageDelete.conflict': '会话历史已变化，请重新选择要删除的消息。',
  'messageDelete.reopenRequired': '消息已删除，请重新打开此会话后再发送消息。',
  'messageDelete.busy': '会话正在处理消息，请结束后重试。',
  'messageDelete.invalidHistory':
    '当前历史缺少安全删除所需的可靠身份信息，无法删除所选消息。',
  'messageDelete.unavailable':
    '无法安全匹配此消息对应的历史记录，请刷新后重试。',
  'messageDelete.reloadFailed':
    '消息已删除，但历史重载失败。请重新加载会话以刷新其余消息。',
};
