import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getGlobalQwenDir } from './paths.js';

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
  return text.replace(re, '').trim();
}

function cursorPath(channelName: string): string {
  const encoded = channelName.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(getGlobalQwenDir(), 'channels', `${encoded}-poll-cursor.txt`);
}

export function savePollCursor(channelName: string, timestamp: string): void {
  const path = cursorPath(channelName);
  mkdirSync(join(getGlobalQwenDir(), 'channels'), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, timestamp + '\n', 'utf-8');
  renameSync(tmp, path);
}

export function loadPollCursor(channelName: string): string | null {
  try {
    const raw = readFileSync(cursorPath(channelName), 'utf-8').trim();
    if (!raw) return null;
    const t = new Date(raw).getTime();
    if (Number.isNaN(t)) return null;
    return raw;
  } catch {
    return null;
  }
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
