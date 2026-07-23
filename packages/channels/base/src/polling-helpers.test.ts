import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseChatId,
  parseIssueThreadId,
  extractFromSubjectUrl,
  extractCommentIdFromUrl,
  loadPollCursor,
  savePollCursor,
  stripMentions,
  stripBotMention,
  abortableSleep,
} from './polling-helpers.js';

describe('parseChatId', () => {
  it('parses owner/repo', () => {
    expect(parseChatId('octocat/hello-world')).toEqual({
      owner: 'octocat',
      repo: 'hello-world',
    });
  });

  it('handles repo with slashes (subgroups)', () => {
    expect(parseChatId('org/group/repo')).toEqual({
      owner: 'org',
      repo: 'group/repo',
    });
  });

  it('returns null for missing slash', () => {
    expect(parseChatId('noslash')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseChatId('')).toBeNull();
  });
});

describe('parseIssueThreadId', () => {
  it('parses issue:N', () => {
    expect(parseIssueThreadId('issue:42')).toEqual({
      type: 'issue',
      number: 42,
    });
  });

  it('parses pr:N', () => {
    expect(parseIssueThreadId('pr:7')).toEqual({ type: 'pr', number: 7 });
  });

  it('returns null for unknown prefix', () => {
    expect(parseIssueThreadId('mr:3')).toBeNull();
    expect(parseIssueThreadId('bug:1')).toBeNull();
  });

  it('returns null for non-numeric number', () => {
    expect(parseIssueThreadId('issue:abc')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseIssueThreadId('')).toBeNull();
  });
});

describe('extractFromSubjectUrl', () => {
  it('extracts issue from GitHub API URL', () => {
    expect(
      extractFromSubjectUrl(
        'https://api.github.com/repos/owner/repo/issues/42',
      ),
    ).toEqual({ type: 'issue', owner: 'owner', repo: 'repo', number: 42 });
  });

  it('extracts pr from GitHub API URL', () => {
    expect(
      extractFromSubjectUrl('https://api.github.com/repos/owner/repo/pulls/7'),
    ).toEqual({ type: 'pr', owner: 'owner', repo: 'repo', number: 7 });
  });

  it('extracts from Gitea API URL', () => {
    expect(
      extractFromSubjectUrl(
        'https://gitea.com/api/v1/repos/owner/repo/issues/1',
      ),
    ).toEqual({ type: 'issue', owner: 'owner', repo: 'repo', number: 1 });
  });

  it('extracts from subgroup repository URL', () => {
    expect(
      extractFromSubjectUrl(
        'https://gitea.com/api/v1/repos/org/team/project/issues/5',
      ),
    ).toEqual({
      type: 'issue',
      owner: 'org',
      repo: 'team/project',
      number: 5,
    });
  });

  it('returns null for null/undefined', () => {
    expect(extractFromSubjectUrl(null)).toBeNull();
    expect(extractFromSubjectUrl(undefined)).toBeNull();
  });

  it('returns null for unrecognized URL', () => {
    expect(extractFromSubjectUrl('https://example.com/foo')).toBeNull();
  });
});

describe('extractCommentIdFromUrl', () => {
  it('extracts comment ID from GitHub API URL', () => {
    expect(
      extractCommentIdFromUrl(
        'https://api.github.com/repos/owner/repo/issues/comments/12345',
      ),
    ).toBe(12345);
  });

  it('extracts comment ID from Gitea API URL', () => {
    expect(
      extractCommentIdFromUrl(
        'https://gitea.com/api/v1/repos/owner/repo/issues/comments/67890',
      ),
    ).toBe(67890);
  });

  it('returns null for URL without comment ID', () => {
    expect(
      extractCommentIdFromUrl(
        'https://api.github.com/repos/owner/repo/issues/42',
      ),
    ).toBeNull();
  });

  it('returns null for null/undefined', () => {
    expect(extractCommentIdFromUrl(null)).toBeNull();
    expect(extractCommentIdFromUrl(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractCommentIdFromUrl('')).toBeNull();
  });
});

describe('loadPollCursor / savePollCursor', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'poll-cursor-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty cursor when no cursor file exists', () => {
    const cursor = loadPollCursor('github', tmpDir);
    expect(cursor.timestamp).toBe('');
  });

  it('saves and loads cursor value', () => {
    savePollCursor('github', '2026-01-01T00:00:00Z', tmpDir);
    const cursor = loadPollCursor('github', tmpDir);
    expect(cursor.timestamp).toBe('2026-01-01T00:00:00Z');
  });

  it('overwrites previous cursor value', () => {
    savePollCursor('github', '2026-01-01T00:00:00Z', tmpDir);
    savePollCursor('github', '2026-01-02T00:00:00Z', tmpDir);
    expect(loadPollCursor('github', tmpDir).timestamp).toBe(
      '2026-01-02T00:00:00Z',
    );
  });

  it('isolates cursors by channel name', () => {
    savePollCursor('github', '2026-01-01T00:00:00Z', tmpDir);
    savePollCursor('gitlab', '2026-01-02T00:00:00Z', tmpDir);
    expect(loadPollCursor('github', tmpDir).timestamp).toBe(
      '2026-01-01T00:00:00Z',
    );
    expect(loadPollCursor('gitlab', tmpDir).timestamp).toBe(
      '2026-01-02T00:00:00Z',
    );
  });

  it('reads legacy single-line cursor files', () => {
    writeFileSync(
      join(tmpDir, 'github-poll-cursor.txt'),
      'stale-legacy-value',
      'utf-8',
    );
    const cursor = loadPollCursor('github', tmpDir);
    expect(cursor.timestamp).toBe('stale-legacy-value');
  });

  it('returns fresh cursor when file is unreadable', () => {
    const cursorFile = join(tmpDir, 'github-poll-cursor.txt');
    mkdirSync(cursorFile);
    const cursor = loadPollCursor('github', tmpDir);
    expect(cursor.timestamp).toBe('');
  });

  it('creates directory if missing', () => {
    const nested = join(tmpDir, 'channels');
    savePollCursor('test-channel', '2026-06-15T12:00:00Z', nested);
    expect(existsSync(nested)).toBe(true);
    const cursor = loadPollCursor('test-channel', nested);
    expect(cursor.timestamp).toBe('2026-06-15T12:00:00Z');
  });

  it('survives reload from same path', () => {
    savePollCursor('github', '2026-07-14T22:00:00Z', tmpDir);
    expect(loadPollCursor('github', tmpDir).timestamp).toBe(
      '2026-07-14T22:00:00Z',
    );
    expect(loadPollCursor('github', tmpDir).timestamp).toBe(
      '2026-07-14T22:00:00Z',
    );
  });
});

describe('stripMentions', () => {
  it('strips @username', () => {
    expect(stripMentions('hello @alice please review')).toBe(
      'hello please review',
    );
  });

  it('strips multiple mentions', () => {
    expect(stripMentions('@bob @alice can you check')).toBe('can you check');
  });

  it('strips org/team mentions', () => {
    expect(stripMentions('cc @org/team for visibility')).toBe(
      'cc for visibility',
    );
  });

  it('collapses extra whitespace', () => {
    expect(stripMentions('hello   @alice   world')).toBe('hello world');
  });

  it('returns empty for mention-only text', () => {
    expect(stripMentions('@alice')).toBe('');
  });

  it('returns original text when no mentions', () => {
    expect(stripMentions('no mentions here')).toBe('no mentions here');
  });

  it('handles empty string', () => {
    expect(stripMentions('')).toBe('');
  });

  it('preserves email addresses', () => {
    expect(stripMentions('contact user@example.com for details')).toBe(
      'contact user@example.com for details',
    );
  });

  it('strips mentions but preserves emails in same text', () => {
    expect(stripMentions('@bot please review, cc user@example.com')).toBe(
      'please review, cc user@example.com',
    );
  });

  it('preserves email addresses preceded by whitespace', () => {
    expect(stripMentions('send to user @example.com for info')).toBe(
      'send to user @example.com for info',
    );
  });

  it('strips mentions after opening punctuation', () => {
    expect(stripMentions('(@alice) can you review?')).toBe(
      '() can you review?',
    );
    expect(stripMentions('[@bob] thoughts?')).toBe('[] thoughts?');
  });

  it('preserves blank lines and multi-line structure', () => {
    expect(stripMentions('multi-line\n\nno mention')).toBe(
      'multi-line\n\nno mention',
    );
    expect(stripMentions('line1\n\n@bot line2')).toBe('line1\n\nline2');
  });
});

describe('stripBotMention', () => {
  it('strips only the bot mention', () => {
    expect(stripBotMention('@bot please fix', 'bot')).toBe('please fix');
  });

  it('preserves other mentions', () => {
    expect(stripBotMention('@alice @bot can you check', 'bot')).toBe(
      '@alice can you check',
    );
  });

  it('does not strip partial username matches', () => {
    expect(stripBotMention('@bot-team please review', 'bot')).toBe(
      '@bot-team please review',
    );
  });

  it('handles mention after punctuation', () => {
    expect(stripBotMention('(@bot) thoughts?', 'bot')).toBe('() thoughts?');
  });

  it('collapses extra whitespace', () => {
    expect(stripBotMention('hello   @bot   world', 'bot')).toBe('hello world');
  });

  it('returns original text when bot not mentioned', () => {
    expect(stripBotMention('@alice please review', 'bot')).toBe(
      '@alice please review',
    );
  });

  it('escapes regex special characters in username', () => {
    expect(stripBotMention('hello @my.bot please fix', 'my.bot')).toBe(
      'hello please fix',
    );
  });

  it('preserves paragraph breaks (newlines)', () => {
    expect(
      stripBotMention(
        '@bot Please fix this.\n\nSteps to reproduce:\n1. Do X',
        'bot',
      ),
    ).toBe('Please fix this.\n\nSteps to reproduce:\n1. Do X');
  });
});

describe('abortableSleep', () => {
  it('resolves after the specified duration', async () => {
    const start = Date.now();
    await abortableSleep(50, new AbortController().signal);
    expect(Date.now() - start).toBeGreaterThanOrEqual(40);
  });

  it('resolves immediately when signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const start = Date.now();
    await abortableSleep(10_000, ac.signal);
    expect(Date.now() - start).toBeLessThan(100);
  });

  it('resolves early when signal is aborted during sleep', async () => {
    const ac = new AbortController();
    const start = Date.now();
    const promise = abortableSleep(10_000, ac.signal);
    setTimeout(() => ac.abort(), 20);
    await promise;
    expect(Date.now() - start).toBeLessThan(500);
  });
});
