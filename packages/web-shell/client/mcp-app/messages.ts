/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const MCP_APP_MESSAGES_EN: Record<string, string> = {
  'mcpApp.message.title': 'Review App message',
  'mcpApp.message.description':
    'This text comes from an MCP App. Sending starts an ordinary request in the session below; normal tool approvals still apply.',
  'mcpApp.message.server': 'Server',
  'mcpApp.message.resource': 'Resource',
  'mcpApp.message.session': 'Target session',
  'mcpApp.message.receipt': 'Prompt receipt',
  'mcpApp.message.send': 'Send to session',
  'mcpApp.message.stopWaiting': 'Stop waiting for receipt',
  'mcpApp.message.busy':
    'The session is busy. Wait for it to finish, then send the message again.',
  'mcpApp.message.reviewing': 'Review the full message before sending.',
  'mcpApp.message.preparing': 'Preparing the message. You can still cancel.',
  'mcpApp.message.dispatched':
    'Sending. Waiting for the session to confirm acceptance.',
  'mcpApp.message.accepted':
    'The session accepted this request. Analysis may still be running.',
  'mcpApp.message.cancelled': 'Cancelled before sending.',
  'mcpApp.message.expired':
    'Review expired before sending. Request a new review from the App.',
  'mcpApp.message.failed':
    'The message was not accepted. The text is kept here.',
  'mcpApp.message.unknown':
    'Acceptance could not be confirmed. Check the original session before sending again. This request will not be retried automatically.',
};

export const MCP_APP_MESSAGES_ZH: Record<string, string> = {
  'mcpApp.message.title': '审阅 App 消息',
  'mcpApp.message.description':
    '以下文字来自 MCP App。发送后将作为普通请求进入下方会话，工具仍需按正常规则审批。',
  'mcpApp.message.server': '服务',
  'mcpApp.message.resource': '资源',
  'mcpApp.message.session': '目标会话',
  'mcpApp.message.receipt': '请求回执',
  'mcpApp.message.send': '发送到会话',
  'mcpApp.message.stopWaiting': '停止等待回执',
  'mcpApp.message.busy': '会话正忙，请等待结束后重新发送消息。',
  'mcpApp.message.reviewing': '请审阅完整消息后再发送。',
  'mcpApp.message.preparing': '正在准备消息，仍可取消。',
  'mcpApp.message.dispatched': '正在发送，等待会话确认接收。',
  'mcpApp.message.accepted': '会话已接收请求，分析可能仍在进行。',
  'mcpApp.message.cancelled': '已在发送前取消。',
  'mcpApp.message.expired': '审阅已过期，消息未发送。请从 App 重新发起审阅。',
  'mcpApp.message.failed': '消息未被接收，原文保留在此。',
  'mcpApp.message.unknown':
    '无法确认是否已接收。再次发送前请检查原会话，本请求不会自动重试。',
};
