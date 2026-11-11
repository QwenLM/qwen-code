/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const TEAMMATE_MESSAGE_TAG = 'teammate-message';
export const AGENT_MESSAGE_TAG = 'agent-message';

export interface ParsedTeammateMessage {
  from: string;
  text: string;
  summary?: string;
  color?: string;
}

export function escapeAgentMessageAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function guardTeammateMessageText(value: string): string {
  return value.replace(
    new RegExp(`<(?=/?${TEAMMATE_MESSAGE_TAG}(?:[>\\s/]|$))`, 'gi'),
    '<\\',
  );
}

export function formatAgentMessage(params: {
  from: string;
  text: string;
}): string {
  const guardedText = params.text.replace(
    /<(?=\/?agent-message(?:[>\s/]|$))/gi,
    '<\\',
  );
  return `<${AGENT_MESSAGE_TAG} from="${escapeAgentMessageAttribute(params.from)}">\n${guardedText}\n</${AGENT_MESSAGE_TAG}>`;
}

export function formatTeammateMessage(params: {
  from: string;
  text: string;
  summary?: string;
  color?: string;
}): string {
  const color = params.color
    ? ` color="${escapeAgentMessageAttribute(params.color)}"`
    : '';
  const summary = params.summary
    ? ` summary="${escapeAgentMessageAttribute(params.summary)}"`
    : '';
  return `<${TEAMMATE_MESSAGE_TAG} teammate_id="${escapeAgentMessageAttribute(params.from)}"${color}${summary}>\n${guardTeammateMessageText(params.text)}\n</${TEAMMATE_MESSAGE_TAG}>`;
}

function decodeXmlValue(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

export function parseTeammateMessage(
  value: string,
): ParsedTeammateMessage | null {
  const match = value.match(
    /^<(teammate-message|agent-message)\s+([^>]*)>\s*([\s\S]*?)\s*<\/\1>$/,
  );
  if (!match) return null;

  const attributes = new Map<string, string>();
  const attributePattern = /\b(teammate_id|from|color|summary)="([^"]*)"/g;
  for (const attribute of match[2]?.matchAll(attributePattern) ?? []) {
    const name = attribute[1];
    const attributeValue = attribute[2];
    if (name && attributeValue !== undefined) {
      attributes.set(name, decodeXmlValue(attributeValue));
    }
  }
  const from = attributes.get('teammate_id') ?? attributes.get('from');
  if (!from) return null;

  const tag = match[1] ?? TEAMMATE_MESSAGE_TAG;
  const text = (match[3] ?? '').replace(
    new RegExp(`<\\\\(?=/?${tag}(?:[>\\s/]|$))`, 'gi'),
    '<',
  );
  const summary = attributes.get('summary');
  const color = attributes.get('color');
  return {
    from,
    text,
    ...(summary ? { summary } : {}),
    ...(color ? { color } : {}),
  };
}
