import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  getSourceConfigPath,
  getSourceGuidePath,
  getSourcePath,
  loadSourceConfig,
  sourceConfigExists,
  sourceExists,
} from './source-helpers.ts';

describe('session source helper slug validation', () => {
  it('resolves valid source helper paths', () => {
    const workspaceRoot = '/tmp/workspace';

    expect(getSourcePath(workspaceRoot, 'craft-kb')).toBe(
      join(workspaceRoot, 'sources', 'craft-kb')
    );
    expect(getSourceConfigPath(workspaceRoot, 'craft-kb')).toBe(
      join(workspaceRoot, 'sources', 'craft-kb', 'config.json')
    );
    expect(getSourceGuidePath(workspaceRoot, 'craft-kb')).toBe(
      join(workspaceRoot, 'sources', 'craft-kb', 'guide.md')
    );
  });

  it('rejects traversal and malformed source slugs', () => {
    const workspaceRoot = '/tmp/workspace';
    const unsafeSlugs = [
      '../sessions',
      '..\\sessions',
      '/sessions',
      'source/child',
      'source\\child',
      '-source',
      'source-',
      'source--child',
      'Source',
      '',
    ];

    for (const slug of unsafeSlugs) {
      const message = `Invalid source slug: ${JSON.stringify(slug)}`;
      expect(() => getSourcePath(workspaceRoot, slug)).toThrow(message);
      expect(() => getSourceConfigPath(workspaceRoot, slug)).toThrow(message);
      expect(() => getSourceGuidePath(workspaceRoot, slug)).toThrow(message);
    }
  });

  it('preserves boolean and null-return contracts for invalid source slugs', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'session-source-helpers-'));
    const invalidDir = join(workspaceRoot, 'sources', 'legacy-source-');
    mkdirSync(invalidDir, { recursive: true });
    writeFileSync(join(invalidDir, 'config.json'), '{}');

    expect(sourceExists(workspaceRoot, 'legacy-source-')).toBe(false);
    expect(sourceConfigExists(workspaceRoot, 'legacy-source-')).toBe(false);
    expect(loadSourceConfig(workspaceRoot, 'legacy-source-')).toBeNull();
  });
});
