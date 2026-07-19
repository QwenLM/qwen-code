import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getCredsFilePath,
  loadCredentials,
  saveCredentials,
} from './accounts.js';

describe('QQ credential storage', () => {
  it('keeps the standalone credential path compatible', () => {
    expect(getCredsFilePath('mybot')).toMatch(
      /[/\\]channels[/\\]mybot-credentials\.json$/u,
    );
  });

  it('uses a daemon-scoped credential file when stateDir is provided', () => {
    expect(getCredsFilePath('mybot', '/tmp/daemon/qq/mybot')).toBe(
      '/tmp/daemon/qq/mybot/credentials.json',
    );
  });

  it('does not fall back to standalone credentials by default', () => {
    const root = mkdtempSync(join(tmpdir(), 'qq-isolation-'));
    const scopedFile = join(root, 'scoped', 'credentials.json');
    const legacyFile = join(root, 'legacy.json');
    writeFileSync(
      legacyFile,
      JSON.stringify({ appId: 'legacy-id', appSecret: 'legacy-secret' }),
    );

    expect(loadCredentials(scopedFile, { legacyFile })).toBeNull();
  });

  it('uses standalone credentials only with explicit legacy fallback', () => {
    const root = mkdtempSync(join(tmpdir(), 'qq-fallback-'));
    const scopedFile = join(root, 'scoped', 'credentials.json');
    const legacyFile = join(root, 'legacy.json');
    writeFileSync(
      legacyFile,
      JSON.stringify({ appId: 'legacy-id', appSecret: 'legacy-secret' }),
    );

    expect(
      loadCredentials(scopedFile, {
        allowLegacyFallback: true,
        legacyFile,
      }),
    ).toEqual({ appId: 'legacy-id', appSecret: 'legacy-secret' });
  });

  it('rejects incomplete and corrupt credentials', () => {
    const root = mkdtempSync(join(tmpdir(), 'qq-invalid-'));
    const credsFile = join(root, 'credentials.json');
    writeFileSync(credsFile, JSON.stringify({ appId: 'id' }));
    expect(loadCredentials(credsFile)).toBeNull();

    writeFileSync(credsFile, 'not-json');
    expect(loadCredentials(credsFile)).toBeNull();
  });

  it('writes credentials atomically with mode 0600', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'qq-credentials-'));
    const credsFile = join(stateDir, 'credentials.json');

    saveCredentials(credsFile, 'id', 'secret');

    expect(JSON.parse(readFileSync(credsFile, 'utf8'))).toEqual({
      appId: 'id',
      appSecret: 'secret',
    });
    expect(statSync(credsFile).mode & 0o777).toBe(0o600);
    expect(readdirSync(stateDir)).toEqual(['credentials.json']);
  });

  it('cleans up its unique temporary file when rename fails', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'qq-rename-failure-'));
    const credsFile = join(stateDir, 'credentials.json');
    mkdirSync(credsFile);

    expect(() => saveCredentials(credsFile, 'id', 'secret')).toThrow();

    expect(readdirSync(stateDir)).toEqual(['credentials.json']);
  });
});
