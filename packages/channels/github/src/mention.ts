export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const MENTION_LOOKBEHIND = '(?<=\\s|^|[([{<])';
const MENTION_LOOKAHEAD = '(?=[^a-zA-Z0-9_/-]|$)';

export function testBotMention(text: string, username: string): boolean {
  const re = new RegExp(
    `${MENTION_LOOKBEHIND}@${escapeRegex(username)}${MENTION_LOOKAHEAD}`,
    'i',
  );
  return re.test(text);
}

export function stripBotMention(text: string, username: string): string {
  const re = new RegExp(
    `${MENTION_LOOKBEHIND}@${escapeRegex(username)}${MENTION_LOOKAHEAD}`,
    'gi',
  );
  return text.replace(re, '');
}
