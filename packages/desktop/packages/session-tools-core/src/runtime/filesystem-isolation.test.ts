import { describe, it, expect } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildDarwinSandboxProfile,
  combineFirejailFilesystemIsolation,
} from './filesystem-isolation.ts';

describe('buildDarwinSandboxProfile', () => {
  it('includes session subpath write allow', () => {
    const profile = buildDarwinSandboxProfile('/tmp/craft-session');
    expect(profile).toContain(
      '(allow file-write* (subpath "/tmp/craft-session"))',
    );
    expect(profile).not.toContain('(deny network*)');
  });

  it('includes deny network when requested', () => {
    const profile = buildDarwinSandboxProfile('/tmp/craft-session', {
      includeNetworkDeny: true,
    });
    expect(profile).toContain('(deny network*)');
  });

  it('escapes parentheses in session paths', () => {
    const profile = buildDarwinSandboxProfile('/tmp/craft-(session)');
    expect(profile).toContain(
      '(allow file-write* (subpath "/tmp/craft-\\(session\\)"))',
    );
  });

  it('falls back to resolved path when realpathSync fails', () => {
    const missingPath = join(tmpdir(), 'sandbox-profile-missing-session-path');
    const resolvedPath = resolve(missingPath);
    const profile = buildDarwinSandboxProfile(missingPath);
    expect(profile).toContain(
      `(allow file-write* (subpath "${resolvedPath}"))`,
    );
  });

  it('includes logical and real write roots when the session path crosses a symlink', () => {
    if (process.platform === 'win32') {
      return;
    }

    const root = mkdtempSync(join(tmpdir(), 'sandbox-profile-roots-'));
    try {
      const realRoot = join(root, 'real');
      const linkRoot = join(root, 'link');
      mkdirSync(realRoot, { recursive: true });
      symlinkSync(realRoot, linkRoot, 'dir');

      const logicalSession = join(linkRoot, 'session');
      mkdirSync(logicalSession, { recursive: true });
      const logicalRoot = resolve(logicalSession);
      const realSession = realpathSync.native(logicalSession);

      expect(realSession).not.toBe(logicalRoot);

      const profile = buildDarwinSandboxProfile(logicalSession);
      expect(profile).toContain(
        `(allow file-write* (subpath "${logicalRoot}"))`,
      );
      expect(profile).toContain(
        `(allow file-write* (subpath "${realSession}"))`,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('combineFirejailFilesystemIsolation', () => {
  it('adds filesystem flags to an existing firejail network wrapper', () => {
    expect(
      combineFirejailFilesystemIsolation(
        ['--quiet', '--net=none', '--', 'node', 'script.js'],
        '/tmp/session',
      ),
    ).toEqual([
      '--quiet',
      '--net=none',
      '--private=/tmp/session',
      '--whitelist=/tmp/session',
      '--',
      'node',
      'script.js',
    ]);
  });

  it('returns null when firejail args do not contain a command separator', () => {
    expect(
      combineFirejailFilesystemIsolation(['--quiet', '--net=none'], '/tmp/x'),
    ).toBeNull();
  });
});
