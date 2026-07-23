import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  escapeRegex,
  testBotMention,
  stripBotMention,
  savePollCursor,
  loadPollCursor,
  abortableSleep,
} from './polling-helpers.js';

vi.mock('./paths.js', () => ({
  getGlobalQwenDir: () => '/tmp/test-qwen-polling',
}));

describe('escapeRegex', () => {
  it('escapes special regex characters', () => {
    expect(escapeRegex('a.b+c')).toBe('a\\.b\\+c');
    expect(escapeRegex('bot[0]')).toBe('bot\\[0\\]');
  });
});

describe('testBotMention', () => {
  const bot = 'qwen-bot';

  it('detects a simple mention', () => {
    expect(testBotMention('hello @qwen-bot fix this', bot)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(testBotMention('@Qwen-Bot please help', bot)).toBe(true);
    expect(testBotMention('@QWEN-BOT', bot)).toBe(true);
  });

  it('does not false-positive on trailing newline', () => {
    expect(testBotMention('Please fix.\n', bot)).toBe(false);
  });

  it('does not false-positive on double space', () => {
    expect(testBotMention('Please  fix.', bot)).toBe(false);
  });

  it('does not false-positive on CRLF body', () => {
    expect(testBotMention('line one\r\nline two\r\n', bot)).toBe(false);
  });

  it('does not false-positive on leading space', () => {
    expect(testBotMention(' hello', bot)).toBe(false);
  });

  it('does not false-positive on indented code block', () => {
    expect(testBotMention('    const x = 1;\n    foo(x);', bot)).toBe(false);
  });

  it('detects mention at start of text', () => {
    expect(testBotMention('@qwen-bot fix this', bot)).toBe(true);
  });

  it('detects mention after bracket', () => {
    expect(testBotMention('(@qwen-bot) can you look?', bot)).toBe(true);
  });

  it('does not match partial username', () => {
    expect(testBotMention('@qwen-bot-extra hello', bot)).toBe(false);
  });

  it('does not match mention embedded in word', () => {
    expect(testBotMention('foo@qwen-bot', bot)).toBe(false);
  });
});

describe('stripBotMention', () => {
  const bot = 'qwen-bot';

  it('removes the bot mention', () => {
    expect(stripBotMention('@qwen-bot fix this', bot)).toBe('fix this');
  });

  it('preserves other mentions', () => {
    expect(stripBotMention('@qwen-bot ask @alice', bot)).toBe('ask @alice');
  });

  it('preserves markdown indentation', () => {
    const input = '@qwen-bot Repro:\n\n    const x = 1;\n    foo(x);';
    const result = stripBotMention(input, bot);
    expect(result).toBe('Repro:\n\n    const x = 1;\n    foo(x);');
  });

  it('preserves nested list formatting', () => {
    const input = '@qwen-bot\n- a\n  - b\n    - c';
    const result = stripBotMention(input, bot);
    expect(result).toBe('- a\n  - b\n    - c');
  });

  it('removes multiple mentions of the bot', () => {
    expect(stripBotMention('@qwen-bot hello @qwen-bot world', bot)).toBe(
      'hello  world',
    );
  });

  it('is case-insensitive', () => {
    expect(stripBotMention('@Qwen-Bot fix', bot)).toBe('fix');
  });
});

describe('savePollCursor / loadPollCursor', () => {
  beforeEach(() => {
    mkdirSync('/tmp/test-qwen-polling/channels', { recursive: true });
  });

  it('round-trips a timestamp', () => {
    savePollCursor('test-ch', '2026-07-24T10:00:00.000Z');
    expect(loadPollCursor('test-ch')).toBe('2026-07-24T10:00:00.000Z');
  });

  it('returns null for missing cursor', () => {
    expect(loadPollCursor('nonexistent-channel')).toBeNull();
  });

  it('returns null for corrupt cursor', () => {
    const path = join(
      '/tmp/test-qwen-polling/channels',
      'corrupt-ch-poll-cursor.txt',
    );
    writeFileSync(path, 'not-a-date\n', 'utf-8');
    expect(loadPollCursor('corrupt-ch')).toBeNull();
  });

  it('encodes special characters in channel name', () => {
    savePollCursor('my/channel:name', '2026-01-01T00:00:00.000Z');
    expect(loadPollCursor('my/channel:name')).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('abortableSleep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves after the specified time', async () => {
    const controller = new AbortController();
    const p = abortableSleep(1000, controller.signal);
    vi.advanceTimersByTime(1000);
    await expect(p).resolves.toBeUndefined();
  });

  it('resolves immediately when aborted', async () => {
    const controller = new AbortController();
    const p = abortableSleep(60000, controller.signal);
    controller.abort();
    await expect(p).resolves.toBeUndefined();
  });

  it('resolves immediately if already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      abortableSleep(60000, controller.signal),
    ).resolves.toBeUndefined();
  });
});
