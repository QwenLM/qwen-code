import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';

const { mockReadFileSync, mockWriteFileSync, mockExistsSync, mockMkdirSync } =
  vi.hoisted(() => ({
    mockReadFileSync: vi.fn(),
    mockWriteFileSync: vi.fn(),
    mockExistsSync: vi.fn(),
    mockMkdirSync: vi.fn(),
  }));

vi.mock('node:fs', () => ({
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  existsSync: mockExistsSync,
  mkdirSync: mockMkdirSync,
}));

vi.mock('@qwen-code/channel-base', () => ({
  getGlobalQwenDir: () => '/tmp/test-qwen',
  // Mirrors @qwen-code/channel-base: at most `max` UTF-16 units, cut on
  // code-point boundaries, so a pair is never split.
  truncateUtf16Units: (text: string, max: number): string => {
    if (text.length <= max) return text;
    let kept = '';
    for (const ch of text) {
      if (kept.length + ch.length > max) break;
      kept += ch;
    }
    return kept;
  },
}));

const { getCredsFilePath, loadCredentials, saveCredentials } = await import(
  './accounts.js'
);

describe('getCredsFilePath', () => {
  it('returns path under channels dir with credentials suffix', () => {
    expect(getCredsFilePath('mybot')).toBe(
      join('/tmp/test-qwen', 'channels', 'mybot-credentials.json'),
    );
  });

  it('includes the safeName in the filename', () => {
    const path = getCredsFilePath('test_123');
    expect(path).toContain('test_123-credentials.json');
  });
});

describe('loadCredentials', () => {
  it('returns null when file does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    expect(loadCredentials('/path/to/creds.json')).toBeNull();
  });

  it('returns null when file is missing appId', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ appSecret: 'secret-only' }),
    );
    expect(loadCredentials('/path/to/creds.json')).toBeNull();
  });

  it('returns null when file is missing appSecret', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({ appId: 'app-only' }));
    expect(loadCredentials('/path/to/creds.json')).toBeNull();
  });

  it('returns null on parse error (corrupt file)', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not-valid-json');
    expect(loadCredentials('/path/to/creds.json')).toBeNull();
  });

  it('returns credentials when both fields are present', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ appId: 'my-app', appSecret: 'my-secret' }),
    );
    expect(loadCredentials('/path/to/creds.json')).toEqual({
      appId: 'my-app',
      appSecret: 'my-secret',
    });
  });
});

describe('saveCredentials', () => {
  it('creates dir and writes file with 0o600 permissions', () => {
    saveCredentials('/path/to/creds.json', 'app-id', 'app-secret');

    expect(mockMkdirSync).toHaveBeenCalledWith(
      join('/tmp/test-qwen', 'channels'),
      { recursive: true },
    );
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      '/path/to/creds.json',
      JSON.stringify({ appId: 'app-id', appSecret: 'app-secret' }),
      { mode: 0o600 },
    );
  });
});

describe('channel-base test double', () => {
  it('exports truncateUtf16Units, which QQChannel imports', async () => {
    const base = await import('@qwen-code/channel-base');
    expect(
      typeof (base as { truncateUtf16Units?: unknown }).truncateUtf16Units,
    ).toBe('function');
  });
});
