import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  canonicalizeWorkspacePath,
  getGlobalQwenDir,
  getWorkspaceScopeDirName,
  resolvePath,
} from './paths.js';

describe('channels/base paths – getGlobalQwenDir', () => {
  const originalEnv = process.env['QWEN_HOME'];

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env['QWEN_HOME'] = originalEnv;
    } else {
      delete process.env['QWEN_HOME'];
    }
  });

  it('defaults to ~/.qwen when QWEN_HOME is not set', () => {
    delete process.env['QWEN_HOME'];
    expect(getGlobalQwenDir()).toBe(path.join(os.homedir(), '.qwen'));
  });

  it('uses QWEN_HOME when set to absolute path', () => {
    const configDir = path.resolve('/tmp/custom-qwen');
    process.env['QWEN_HOME'] = configDir;
    expect(getGlobalQwenDir()).toBe(configDir);
  });

  it('resolves relative QWEN_HOME against process.cwd', () => {
    process.env['QWEN_HOME'] = 'relative/config';
    expect(getGlobalQwenDir()).toBe(path.resolve('relative/config'));
  });

  it('expands tilde (~/x) in QWEN_HOME', () => {
    process.env['QWEN_HOME'] = '~/custom-qwen';
    expect(getGlobalQwenDir()).toBe(path.join(os.homedir(), 'custom-qwen'));
  });

  it('expands Windows-style tilde (~\\x) in QWEN_HOME', () => {
    process.env['QWEN_HOME'] = '~\\custom-qwen';
    expect(getGlobalQwenDir()).toBe(path.join(os.homedir(), 'custom-qwen'));
  });

  it('treats bare tilde (~) as home directory', () => {
    process.env['QWEN_HOME'] = '~';
    expect(getGlobalQwenDir()).toBe(path.normalize(os.homedir()));
  });
});

describe('channels/base paths – resolvePath', () => {
  it('returns absolute paths unchanged', () => {
    const abs = path.resolve('/tmp/x');
    expect(resolvePath(abs)).toBe(abs);
  });

  it('expands bare tilde (~) to home directory', () => {
    expect(resolvePath('~')).toBe(path.normalize(os.homedir()));
  });

  it('expands POSIX-style tilde (~/x)', () => {
    expect(resolvePath('~/xomo')).toBe(path.join(os.homedir(), 'xomo'));
  });

  it('expands Windows-style tilde (~\\x)', () => {
    expect(resolvePath('~\\xomo')).toBe(path.join(os.homedir(), 'xomo'));
  });

  it('resolves relative paths against process.cwd', () => {
    expect(resolvePath('relative/dir')).toBe(path.resolve('relative/dir'));
  });
});

describe('canonicalizeWorkspacePath', () => {
  // Regression for the #7065 review finding: scope identity must follow the
  // repo's workspace-canonicalization contract (realpath after resolve), so
  // symlinked spellings of the same directory — e.g. macOS `/tmp/ws` vs
  // `/private/tmp/ws` — address the same store from the worker and the CLI.
  it('collapses a symlinked spelling to the same scope as the real path', () => {
    const real = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ws-'));
    const link = `${real}-link`;
    fs.symlinkSync(real, link);
    try {
      expect(canonicalizeWorkspacePath(link)).toBe(
        canonicalizeWorkspacePath(real),
      );
      expect(getWorkspaceScopeDirName(link)).toBe(
        getWorkspaceScopeDirName(real),
      );
    } finally {
      fs.rmSync(link);
      fs.rmSync(real, { recursive: true, force: true });
    }
  });

  it('collapses trailing-separator and dot-dot spellings of a nonexistent path', () => {
    // The realpath step cannot help for paths that do not exist on disk, so
    // the resolved fallback itself must canonicalize equivalent spellings.
    const missing = path.join(os.tmpdir(), 'qwen-scope-missing-norm');
    expect(getWorkspaceScopeDirName(`${missing}${path.sep}`)).toBe(
      getWorkspaceScopeDirName(missing),
    );
    expect(
      getWorkspaceScopeDirName(
        path.join(missing, '..', 'qwen-scope-missing-norm'),
      ),
    ).toBe(getWorkspaceScopeDirName(missing));
  });

  it('keeps the resolved spelling for a path that does not exist (ENOENT fallback)', () => {
    const missing = path.join(os.tmpdir(), 'qwen-scope-missing', 'nested');
    expect(canonicalizeWorkspacePath(missing)).toBe(resolvePath(missing));
    // The scope name of a nonexistent path is exactly the one computed from
    // its resolved spelling — the realpath step degrades to a no-op.
    expect(getWorkspaceScopeDirName(missing)).toBe(
      getWorkspaceScopeDirName(resolvePath(missing)),
    );
  });
});
