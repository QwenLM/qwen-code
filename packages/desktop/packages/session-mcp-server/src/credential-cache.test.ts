import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getCredentialCachePath,
  readCredentialCache,
} from './credential-cache';

let workspaceRoot: string | undefined;

function makeWorkspace(): string {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'session-credential-cache-'));
  return workspaceRoot;
}

function writeCredentialCache(root: string, sourceSlug: string, content: string): void {
  const sourceDir = join(root, 'sources', sourceSlug);
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, '.credential-cache.json'), content);
}

afterEach(() => {
  if (workspaceRoot) {
    rmSync(workspaceRoot, { recursive: true, force: true });
    workspaceRoot = undefined;
  }
});

describe('credential cache path validation', () => {
  it('resolves cache paths through the validated source directory helper', () => {
    const root = '/tmp/workspace';

    expect(getCredentialCachePath(root, 'craft-kb')).toBe(
      join(root, 'sources', 'craft-kb', '.credential-cache.json')
    );
  });

  it('rejects unsafe source slugs before reading from the filesystem', () => {
    const root = makeWorkspace();
    const escapedDir = join(root, 'sessions');
    mkdirSync(escapedDir, { recursive: true });
    writeFileSync(
      join(escapedDir, '.credential-cache.json'),
      JSON.stringify({ value: 'escaped-token' })
    );

    expect(() => getCredentialCachePath(root, '../sessions')).toThrow(
      'Invalid source slug: "../sessions"'
    );
    expect(() => readCredentialCache(root, '../sessions')).toThrow(
      'Invalid source slug: "../sessions"'
    );
  });

  it('reads valid, unexpired credential cache entries', () => {
    const root = makeWorkspace();
    writeCredentialCache(root, 'github', JSON.stringify({ value: 'token' }));

    expect(readCredentialCache(root, 'github')).toBe('token');
  });

  it('returns null for missing, expired, or empty cache entries without logging misses', () => {
    const root = makeWorkspace();
    const messages: string[] = [];
    writeCredentialCache(
      root,
      'expired',
      JSON.stringify({ value: 'old-token', expiresAt: Date.now() - 1000 })
    );
    writeCredentialCache(root, 'empty', JSON.stringify({ value: '' }));

    expect(readCredentialCache(root, 'missing', (message) => messages.push(message))).toBeNull();
    expect(readCredentialCache(root, 'expired')).toBeNull();
    expect(readCredentialCache(root, 'empty')).toBeNull();
    expect(messages).toEqual([]);
  });

  it('logs unreadable cache content without swallowing slug validation errors', () => {
    const root = makeWorkspace();
    const messages: string[] = [];
    writeCredentialCache(root, 'github', '{not-json');

    expect(readCredentialCache(root, 'github', (message) => messages.push(message))).toBeNull();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('Failed to read credential cache for source "github"');
  });
});
