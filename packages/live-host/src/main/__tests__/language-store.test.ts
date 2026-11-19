import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { readHostLanguage, saveHostLanguage } from '../language-store.ts';

it('persists the local locale privately and falls back for absent or invalid cache', () => {
  const directory = mkdtempSync(join(tmpdir(), 'live-locale-cache-'));
  try {
    const path = join(directory, 'language.json');
    assert.equal(readHostLanguage(path), 'en');
    saveHostLanguage(path, 'zh-CN');
    assert.equal(readHostLanguage(path), 'zh-CN');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.throws(() => saveHostLanguage(path, 'fr' as never));
    assert.equal(readHostLanguage(path), 'zh-CN');
    assert.deepEqual(readdirSync(directory), ['language.json']);
    writeFileSync(path, '{');
    assert.equal(readHostLanguage(path), 'en');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
