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
import { buildDarwinSandboxProfile } from './filesystem-isolation.ts';

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

  it('keeps parentheses literal inside quoted session paths', () => {
    const profile = buildDarwinSandboxProfile('/tmp/craft-(session)');
    expect(profile).toContain(
      '(allow file-write* (subpath "/tmp/craft-(session)"))',
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
