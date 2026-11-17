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
import { afterEach, describe, it } from 'node:test';
import {
  readOverlayPosition,
  saveOverlayPosition,
} from '../overlay-position-store.ts';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true });
});
function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'live-overlay-position-'));
  directories.push(directory);
  return join(directory, 'overlay-position.json');
}

describe('overlay position persistence', () => {
  it('falls back for absent, corrupt and non-finite positions', () => {
    const path = fixture();
    assert.equal(readOverlayPosition(path), undefined);
    for (const contents of ['{', '{}', '{"x":"1","y":2}', '{"x":1e30,"y":2}']) {
      writeFileSync(path, contents);
      assert.equal(readOverlayPosition(path), undefined);
    }
  });

  it('atomically replaces and restores a private rounded position without temporary files', () => {
    const path = fixture();
    saveOverlayPosition(path, { x: -800.4, y: 240.8 });
    assert.deepEqual(readOverlayPosition(path), { x: -800, y: 241 });
    saveOverlayPosition(path, { x: 420, y: 100 });
    assert.deepEqual(readOverlayPosition(path), { x: 420, y: 100 });
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(directories[0]!), ['overlay-position.json']);
  });

  it('rejects malformed writes before replacing a saved position', () => {
    const path = fixture();
    saveOverlayPosition(path, { x: 20, y: 30 });
    assert.throws(() => saveOverlayPosition(path, { x: Infinity, y: 50 }));
    assert.deepEqual(readOverlayPosition(path), { x: 20, y: 30 });
  });
});
