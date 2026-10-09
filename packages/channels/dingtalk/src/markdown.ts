import { splitMarkdown } from '@qwen-code/channel-base';

export const DINGTALK_CHUNK_LIMIT = 3800;
export const DINGTALK_MAX_CHUNK_LENGTH = 20_000;

export function escapeDingTalkMarkdown(value: string): string {
  return value.replace(/([\\`*_[\]{}()#+.!|>~:-])/gu, '\\$1');
}

export function splitChunks(
  text: string,
  chunkLimit = DINGTALK_CHUNK_LIMIT,
  maxLength = DINGTALK_MAX_CHUNK_LENGTH,
): string[] {
  return splitMarkdown(text, {
    targetLength: chunkLimit,
    maxLength,
    unit: 'utf16',
  });
}

/** Extract a short title from the first line of markdown for the webhook payload. */
export function extractTitle(text: string): string {
  const firstLine = text.split('\n')[0] || '';
  const cleaned = firstLine.replace(/^[#*\s\->]+/, '').slice(0, 20);
  return cleaned || 'Reply';
}

/** Split long Markdown messages without cutting inline structures. */
export function normalizeDingTalkMarkdown(
  text: string,
  chunkLimit = DINGTALK_CHUNK_LIMIT,
  maxLength = DINGTALK_MAX_CHUNK_LENGTH,
): string[] {
  return splitChunks(text, chunkLimit, maxLength);
}
