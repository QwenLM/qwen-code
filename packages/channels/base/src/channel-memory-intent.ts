import { PROMPT_UNSAFE_INVISIBLES } from './sanitize.js';

export type ChannelMemoryIntent =
  | { kind: 'remember'; texts: string[] }
  | { kind: 'list'; page: number }
  | { kind: 'inspect'; id: string }
  | { kind: 'remove'; id: string }
  | { kind: 'update'; id: string; text: string }
  | { kind: 'update_confirm' }
  | { kind: 'remove_confirm' }
  | { kind: 'clear_request' }
  | { kind: 'clear_confirm' };

const REMEMBER_PATTERNS: RegExp[] = [
  /^记住[:：]\s*(.+)$/su,
  /^记一下[:：,，]?\s*(.+)$/su,
  /^帮我记一下[:：,，]?\s*(.+)$/su,
  /^帮我记住[:：,，]?\s*(.+)$/su,
  /^以后记住[:：,，]?\s*(.+)$/su,
  /^remember:\s*(.+)$/isu,
];

const LIST_PATTERNS: RegExp[] = [
  /^你现在记住了什么[?？]?$/u,
  /^查看记忆$/u,
  /^当前记忆$/u,
  /^这个聊天你记住了什么[?？]?$/u,
  /^what do you remember[?？]?$/iu,
];

const LIST_PAGE_PATTERNS: RegExp[] = [
  /^查看第\s*(\d+)\s*页记忆$/u,
  /^show memory page\s+(\d+)$/iu,
];

const INSPECT_PATTERNS: RegExp[] = [
  /^查看记忆\s+(\S+)$/u,
  /^show memory\s+(\S+)$/iu,
];

const REMOVE_PATTERNS: RegExp[] = [
  /^忘掉\s+(\S+)$/u,
  /^删除\s+(\S+)$/u,
  /^删掉\s+(\S+)$/u,
  /^forget\s+(\S+)$/iu,
  /^delete\s+(\S+)$/iu,
  /^remove\s+(\S+)$/iu,
];

const UPDATE_PATTERNS: RegExp[] = [
  /^把\s+(\S+)\s+改成\s*(.+)$/su,
  /^更新\s+(\S+)\s+为\s*(.+)$/su,
  /^update\s+(\S+)\s+to\s+(.+)$/isu,
  /^change\s+(\S+)\s+to\s+(.+)$/isu,
];

const MEMORY_ID_PATTERN = /^m-[a-f0-9]{12}$/u;

const CLEAR_REQUEST_PATTERNS: RegExp[] = [
  /^清空记忆$/u,
  /^清除记忆$/u,
  /^忘掉这个聊天的所有记忆$/u,
  /^把.+的?记忆清空$/u,
  /^clear memory$/iu,
];

const CLEAR_CONFIRM_PATTERNS: RegExp[] = [
  /^确认清空记忆$/u,
  /^确认清除记忆$/u,
  /^confirm clear memory$/iu,
];

const UPDATE_CONFIRM_PATTERNS: RegExp[] = [
  /^确认更新记忆$/u,
  /^confirm memory update$/iu,
];

const REMOVE_CONFIRM_PATTERNS: RegExp[] = [
  /^确认删除记忆$/u,
  /^confirm memory removal$/iu,
];

export function parseChannelMemoryIntent(
  text: string,
): ChannelMemoryIntent | null {
  const trimmed = text.replace(PROMPT_UNSAFE_INVISIBLES, '').trim();
  if (!trimmed || trimmed.startsWith('/')) {
    return null;
  }

  for (const pattern of UPDATE_CONFIRM_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { kind: 'update_confirm' };
    }
  }
  for (const pattern of REMOVE_CONFIRM_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { kind: 'remove_confirm' };
    }
  }
  for (const pattern of CLEAR_CONFIRM_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { kind: 'clear_confirm' };
    }
  }
  for (const pattern of REMOVE_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match?.[1] && MEMORY_ID_PATTERN.test(match[1])) {
      return { kind: 'remove', id: match[1] };
    }
  }
  for (const pattern of UPDATE_PATTERNS) {
    const match = trimmed.match(pattern);
    const id = match?.[1];
    const updated = match?.[2]?.trim();
    if (id && updated && MEMORY_ID_PATTERN.test(id)) {
      return { kind: 'update', id, text: updated };
    }
  }
  for (const pattern of CLEAR_REQUEST_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { kind: 'clear_request' };
    }
  }
  for (const pattern of INSPECT_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match?.[1] && MEMORY_ID_PATTERN.test(match[1])) {
      return { kind: 'inspect', id: match[1] };
    }
  }
  for (const pattern of LIST_PAGE_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match?.[1]) {
      const page = Number(match[1]);
      return Number.isSafeInteger(page) && page > 0
        ? { kind: 'list', page }
        : null;
    }
  }
  for (const pattern of LIST_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { kind: 'list', page: 1 };
    }
  }
  for (const pattern of REMEMBER_PATTERNS) {
    const match = trimmed.match(pattern);
    const remembered = match?.[1]?.replace(PROMPT_UNSAFE_INVISIBLES, '').trim();
    if (remembered) {
      return { kind: 'remember', texts: [remembered] };
    }
  }

  return null;
}
