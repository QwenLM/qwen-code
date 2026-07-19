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
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearAccount,
  loadAccount,
  saveAccount,
  type AccountData,
} from './accounts.js';

const originalStateDir = process.env['WEIXIN_STATE_DIR'];

afterEach(() => {
  if (originalStateDir === undefined) {
    delete process.env['WEIXIN_STATE_DIR'];
  } else {
    process.env['WEIXIN_STATE_DIR'] = originalStateDir;
  }
});

function account(token: string): AccountData {
  return {
    token,
    baseUrl: 'https://example.test',
    savedAt: '2026-07-19T00:00:00.000Z',
  };
}

describe('Weixin account storage', () => {
  it('isolates explicitly scoped state from standalone account storage', () => {
    const root = mkdtempSync(join(tmpdir(), 'weixin-accounts-'));
    const legacyDir = join(root, 'legacy');
    const scopedDir = join(root, 'scoped');
    process.env['WEIXIN_STATE_DIR'] = legacyDir;

    saveAccount(account('legacy-token'));

    expect(loadAccount(scopedDir)).toBeNull();
    expect(loadAccount()).toMatchObject({ token: 'legacy-token' });
  });

  it.each(['missing', 'corrupt'])(
    'uses explicit legacy fallback when scoped state is %s',
    (state) => {
      const root = mkdtempSync(join(tmpdir(), 'weixin-fallback-'));
      const scopedDir = join(root, 'scoped');
      const legacyDir = join(root, 'legacy');
      mkdirSync(scopedDir, { recursive: true });
      if (state === 'corrupt') {
        writeFileSync(join(scopedDir, 'account.json'), 'not-json');
      }
      saveAccount(account('legacy-token'), legacyDir);

      expect(
        loadAccount(scopedDir, {
          allowLegacyFallback: true,
          legacyStateDir: legacyDir,
        }),
      ).toMatchObject({ token: 'legacy-token' });
    },
  );

  it('prefers scoped state over the fallback directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'weixin-scoped-wins-'));
    const scopedDir = join(root, 'workspace-a');
    const otherWorkspaceDir = join(root, 'workspace-b');
    saveAccount(account('scoped-token'), scopedDir);
    saveAccount(account('other-token'), otherWorkspaceDir);

    expect(
      loadAccount(scopedDir, {
        allowLegacyFallback: true,
        legacyStateDir: otherWorkspaceDir,
      }),
    ).toMatchObject({ token: 'scoped-token' });
  });

  it('writes scoped credentials atomically with mode 0600', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'weixin-scoped-'));

    saveAccount(account('token-1'), stateDir);

    const path = join(stateDir, 'account.json');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      token: 'token-1',
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('clears only the requested state directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'weixin-clear-'));
    const first = join(root, 'first');
    const second = join(root, 'second');
    saveAccount(account('first'), first);
    saveAccount(account('second'), second);

    clearAccount(first);

    expect(loadAccount(first)).toBeNull();
    expect(loadAccount(second)).toMatchObject({ token: 'second' });
  });

  it('cleans up the temporary credential file when rename fails', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'weixin-rename-failure-'));
    mkdirSync(join(stateDir, 'account.json'));

    expect(() => saveAccount(account('token-1'), stateDir)).toThrow();

    expect(readdirSync(stateDir)).toEqual(['account.json']);
  });
});
