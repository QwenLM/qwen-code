import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { getSourceConfigPath, getSourceGuidePath, getSourcePath } from './source-helpers.ts';

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
});
