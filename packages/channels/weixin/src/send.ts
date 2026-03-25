/**
 * Send messages to WeChat users.
 */

import { randomUUID } from 'node:crypto';
import { sendMessage } from './api.js';
import { MessageType, MessageState, MessageItemType } from './types.js';

/** Convert markdown to plain text (WeChat doesn't support markdown) */
export function markdownToPlainText(text: string): string {
  return text
    .replace(/```[\s\S]*?\n([\s\S]*?)```/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/___(.+?)___/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/_(.+?)_/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '[$1]')
    .replace(/^>\s+/gm, '')
    .replace(/^[-*_]{3,}$/gm, '---')
    .replace(/^[\s]*[-*+]\s+/gm, '- ')
    .replace(/^[\s]*(\d+)\.\s+/gm, '$1. ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Send a text message */
export async function sendText(params: {
  to: string;
  text: string;
  baseUrl: string;
  token: string;
  contextToken: string;
}): Promise<void> {
  const { to, text, baseUrl, token, contextToken } = params;
  const plainText = markdownToPlainText(text);

  await sendMessage(baseUrl, token, {
    to_user_id: to,
    from_user_id: '',
    client_id: randomUUID(),
    message_type: MessageType.BOT,
    message_state: MessageState.FINISH,
    context_token: contextToken,
    item_list: [{ type: MessageItemType.TEXT, text_item: { text: plainText } }],
  });
}
