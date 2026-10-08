import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { readHostTheme, saveHostTheme } from '../theme-store.ts';
import { isLiveTheme, LIVE_THEMES } from '../../shared/theme.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function directory(): string {
  const path = mkdtempSync(join(tmpdir(), 'live-theme-store-'));
  directories.push(path);
  return path;
}

describe('Host-local theme preferences', () => {
  it('accepts only the three exact preference values', () => {
    for (const value of LIVE_THEMES) assert.equal(isLiveTheme(value), true);
    for (const value of [
      undefined,
      null,
      true,
      1,
      '',
      'auto',
      'Dark',
      ' light ',
      [],
      {},
      { theme: 'dark' },
    ]) {
      assert.equal(isLiveTheme(value), false);
    }
  });

  it('round-trips each preference privately without touching language settings', () => {
    const root = directory();
    const data = join(root, 'user-data');
    const path = join(data, 'theme.json');
    assert.equal(readHostTheme(path), 'system');
    saveHostTheme(path, 'light');
    const languagePath = join(data, 'language.json');
    writeFileSync(languagePath, '{"language":"zh-CN"}', { mode: 0o600 });
    for (const theme of LIVE_THEMES) {
      saveHostTheme(path, theme);
      assert.equal(readHostTheme(path), theme);
      assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { theme });
      assert.equal(readFileSync(languagePath, 'utf8'), '{"language":"zh-CN"}');
      assert.deepEqual(readdirSync(data).sort(), [
        'language.json',
        'theme.json',
      ]);
    }
    if (process.platform !== 'win32') {
      assert.equal(statSync(data).mode & 0o777, 0o700);
      assert.equal(statSync(path).mode & 0o777, 0o600);
    }
  });

  it('falls back to System for missing, malformed, unknown or non-object preferences', () => {
    const path = join(directory(), 'theme.json');
    assert.equal(readHostTheme(path), 'system');
    for (const contents of [
      '{',
      'null',
      'true',
      '1',
      '"dark"',
      '[]',
      '{}',
      '{"language":"zh-CN"}',
      '{"theme":"auto"}',
      '{"theme":"Dark"}',
      '{"theme":null}',
      '{"theme":false}',
      '{"theme":1}',
      '{"theme":[]}',
      '{"theme":{"theme":"dark"}}',
    ]) {
      writeFileSync(path, contents);
      assert.equal(readHostTheme(path), 'system', contents);
    }
    assert.equal(readHostTheme(directory()), 'system');
  });

  it('rejects invalid saves before writing or replacing the previous preference', () => {
    const root = directory();
    const path = join(root, 'theme.json');
    saveHostTheme(path, 'dark');
    for (const value of [undefined, null, 'auto', 'Dark', 1, true, {}, []]) {
      assert.throws(() => saveHostTheme(path, value as never), TypeError);
      assert.equal(readHostTheme(path), 'dark');
      assert.deepEqual(readdirSync(root), ['theme.json']);
    }
    const missing = join(root, 'uncreated', 'theme.json');
    assert.throws(() => saveHostTheme(missing, 'auto' as never), TypeError);
    assert.deepEqual(readdirSync(root), ['theme.json']);
  });

  it('reports filesystem failures and cleans temporary files after failed replacement', () => {
    const root = directory();
    const path = join(root, 'theme.json');
    mkdirSync(path);
    writeFileSync(join(path, 'keep.txt'), 'Keep this directory intact');
    assert.throws(() => saveHostTheme(path, 'light'));
    assert.deepEqual(readdirSync(root), ['theme.json']);
    assert.equal(
      readFileSync(join(path, 'keep.txt'), 'utf8'),
      'Keep this directory intact',
    );
    const blockedParent = join(root, 'file-not-directory');
    writeFileSync(blockedParent, 'unchanged');
    assert.throws(() =>
      saveHostTheme(join(blockedParent, 'theme.json'), 'dark'),
    );
    assert.equal(readFileSync(blockedParent, 'utf8'), 'unchanged');
  });
});
