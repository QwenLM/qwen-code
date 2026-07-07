import { PROMPT_UNSAFE_INVISIBLES } from './sanitize.js';

export type ChannelMemoryIntent =
  | { kind: 'remember'; text: string }
  | { kind: 'list' }
  | { kind: 'clear_request' }
  | { kind: 'clear_confirm' };

const REMEMBER_PATTERNS: RegExp[] = [
  /^记住[:：]\s*(.+)$/su,
  /^记一下[:：,，]?\s*(.+)$/su,
  /^帮我记一下[:：,，]?\s*(.+)$/su,
  /^帮我记住[:：,，]?\s*(.+)$/su,
  /^以后记住[:：,，]?\s*(.+)$/su,
  /^保存[:：,，]?\s*(.+)$/su,
  /^remember:\s*(.+)$/isu,
  /^remember that\s+(.+)$/isu,
];

const LIST_PATTERNS: RegExp[] = [
  /^你现在记住了什么[?？]?$/u,
  /^查看记忆$/u,
  /^当前记忆$/u,
  /^这个聊天你记住了什么[?？]?$/u,
  /^what do you remember[?？]?$/iu,
];

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

export function parseChannelMemoryIntent(
  text: string,
): ChannelMemoryIntent | null {
  const trimmed = text.replace(PROMPT_UNSAFE_INVISIBLES, '').trim();
  if (!trimmed || trimmed.startsWith('/')) {
    return null;
  }

  for (const pattern of CLEAR_CONFIRM_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { kind: 'clear_confirm' };
    }
  }
  for (const pattern of CLEAR_REQUEST_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { kind: 'clear_request' };
    }
  }
  for (const pattern of LIST_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { kind: 'list' };
    }
  }
  for (const pattern of REMEMBER_PATTERNS) {
    const match = trimmed.match(pattern);
    const remembered = match?.[1]?.replace(PROMPT_UNSAFE_INVISIBLES, '').trim();
    if (remembered) {
      return { kind: 'remember', text: remembered };
    }
  }

  return null;
}
