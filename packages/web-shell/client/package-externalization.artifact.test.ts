import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIST_DIR = resolve(__dirname, '../dist');

function readPackageJavascript(): string {
  return readdirSync(DIST_DIR)
    .filter((fileName) => fileName.endsWith('.js'))
    .map((fileName) => readFileSync(resolve(DIST_DIR, fileName), 'utf8'))
    .join('\n');
}

describe('build artifact — manifest-derived externals', () => {
  it('keeps declared runtime dependencies external in the built library', () => {
    const bundle = readPackageJavascript();
    for (const dependency of [
      '@modelcontextprotocol/ext-apps',
      '@tanstack/react-table',
      '@tanstack/react-virtual',
      '@xterm/addon-fit',
      '@xterm/xterm',
      'fzf',
    ]) {
      expect(bundle, `${dependency} should remain external`).toContain(
        `from "${dependency}"`,
      );
    }
  });
});
