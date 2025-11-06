/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  escapePath,
  resolvePath,
  validatePath,
  resolveAndValidatePath,
  unescapePath,
  isSubpath,
} from './paths.js';
import type { Config } from '../config/config.js';

function createConfigStub({
  targetDir,
  allowedDirectories,
}: {
  targetDir: string;
  allowedDirectories: string[];
}): Config {
  const resolvedTargetDir = path.resolve(targetDir);
  const resolvedDirectories = allowedDirectories.map((dir) =>
    path.resolve(dir),
  );

  const workspaceContext = {
    isPathWithinWorkspace(testPath: string) {
      const resolvedPath = path.resolve(testPath);
      return resolvedDirectories.some((dir) => {
        const relative = path.relative(dir, resolvedPath);
        return (
          relative === '' ||
          (!relative.startsWith('..') && !path.isAbsolute(relative))
        );
      });
    },
    getDirectories() {
      return resolvedDirectories;
    },
  };

  return {
    getTargetDir: () => resolvedTargetDir,
    getWorkspaceContext: () => workspaceContext,
  } as unknown as Config;
}

describe('escapePath', () => {
  it('should escape spaces', () => {
    expect(escapePath('my file.txt')).toBe('my\\ file.txt');
  });

  it('should escape tabs', () => {
    expect(escapePath('file\twith\ttabs.txt')).toBe('file\\\twith\\\ttabs.txt');
  });

  it('should escape parentheses', () => {
    expect(escapePath('file(1).txt')).toBe('file\\(1\\).txt');
  });

  it('should escape square brackets', () => {
    expect(escapePath('file[backup].txt')).toBe('file\\[backup\\].txt');
  });

  it('should escape curly braces', () => {
    expect(escapePath('file{temp}.txt')).toBe('file\\{temp\\}.txt');
  });

  it('should escape semicolons', () => {
    expect(escapePath('file;name.txt')).toBe('file\\;name.txt');
  });

  it('should escape ampersands', () => {
    expect(escapePath('file&name.txt')).toBe('file\\&name.txt');
  });

  it('should escape pipes', () => {
    expect(escapePath('file|name.txt')).toBe('file\\|name.txt');
  });

  it('should escape asterisks', () => {
    expect(escapePath('file*.txt')).toBe('file\\*.txt');
  });

  it('should escape question marks', () => {
    expect(escapePath('file?.txt')).toBe('file\\?.txt');
  });

  it('should escape dollar signs', () => {
    expect(escapePath('file$name.txt')).toBe('file\\$name.txt');
  });

  it('should escape backticks', () => {
    expect(escapePath('file`name.txt')).toBe('file\\`name.txt');
  });

  it('should escape single quotes', () => {
    expect(escapePath("file'name.txt")).toBe("file\\'name.txt");
  });

  it('should escape double quotes', () => {
    expect(escapePath('file"name.txt')).toBe('file\\"name.txt');
  });

  it('should escape hash symbols', () => {
    expect(escapePath('file#name.txt')).toBe('file\\#name.txt');
  });

  it('should escape exclamation marks', () => {
    expect(escapePath('file!name.txt')).toBe('file\\!name.txt');
  });

  it('should escape tildes', () => {
    expect(escapePath('file~name.txt')).toBe('file\\~name.txt');
  });

  it('should escape less than and greater than signs', () => {
    expect(escapePath('file<name>.txt')).toBe('file\\<name\\>.txt');
  });

  it('should handle multiple special characters', () => {
    expect(escapePath('my file (backup) [v1.2].txt')).toBe(
      'my\\ file\\ \\(backup\\)\\ \\[v1.2\\].txt',
    );
  });

  it('should not double-escape already escaped characters', () => {
    expect(escapePath('my\\ file.txt')).toBe('my\\ file.txt');
    expect(escapePath('file\\(name\\).txt')).toBe('file\\(name\\).txt');
  });

  it('should handle escaped backslashes correctly', () => {
    // Double backslash (escaped backslash) followed by space should escape the space
    expect(escapePath('path\\\\ file.txt')).toBe('path\\\\\\ file.txt');
    // Triple backslash (escaped backslash + escaping backslash) followed by space should not double-escape
    expect(escapePath('path\\\\\\ file.txt')).toBe('path\\\\\\ file.txt');
    // Quadruple backslash (two escaped backslashes) followed by space should escape the space
    expect(escapePath('path\\\\\\\\ file.txt')).toBe('path\\\\\\\\\\ file.txt');
  });

  it('should handle complex escaped backslash scenarios', () => {
    // Escaped backslash before special character that needs escaping
    expect(escapePath('file\\\\(test).txt')).toBe('file\\\\\\(test\\).txt');
    // Multiple escaped backslashes
    expect(escapePath('path\\\\\\\\with space.txt')).toBe(
      'path\\\\\\\\with\\ space.txt',
    );
  });

  it('should handle paths without special characters', () => {
    expect(escapePath('normalfile.txt')).toBe('normalfile.txt');
    expect(escapePath('path/to/normalfile.txt')).toBe('path/to/normalfile.txt');
  });

  it('should handle complex real-world examples', () => {
    expect(escapePath('My Documents/Project (2024)/file [backup].txt')).toBe(
      'My\\ Documents/Project\\ \\(2024\\)/file\\ \\[backup\\].txt',
    );
    expect(escapePath('file with $special &chars!.txt')).toBe(
      'file\\ with\\ \\$special\\ \\&chars\\!.txt',
    );
  });

  it('should handle empty strings', () => {
    expect(escapePath('')).toBe('');
  });

  it('should handle paths with only special characters', () => {
    expect(escapePath(' ()[]{};&|*?$`\'"#!~<>')).toBe(
      '\\ \\(\\)\\[\\]\\{\\}\\;\\&\\|\\*\\?\\$\\`\\\'\\"\\#\\!\\~\\<\\>',
    );
  });
});

describe('unescapePath', () => {
  it('should unescape spaces', () => {
    expect(unescapePath('my\\ file.txt')).toBe('my file.txt');
  });

  it('should unescape tabs', () => {
    expect(unescapePath('file\\\twith\\\ttabs.txt')).toBe(
      'file\twith\ttabs.txt',
    );
  });

  it('should unescape parentheses', () => {
    expect(unescapePath('file\\(1\\).txt')).toBe('file(1).txt');
  });

  it('should unescape square brackets', () => {
    expect(unescapePath('file\\[backup\\].txt')).toBe('file[backup].txt');
  });

  it('should unescape curly braces', () => {
    expect(unescapePath('file\\{temp\\}.txt')).toBe('file{temp}.txt');
  });

  it('should unescape multiple special characters', () => {
    expect(unescapePath('my\\ file\\ \\(backup\\)\\ \\[v1.2\\].txt')).toBe(
      'my file (backup) [v1.2].txt',
    );
  });

  it('should handle paths without escaped characters', () => {
    expect(unescapePath('normalfile.txt')).toBe('normalfile.txt');
    expect(unescapePath('path/to/normalfile.txt')).toBe(
      'path/to/normalfile.txt',
    );
  });

  it('should handle all special characters', () => {
    expect(
      unescapePath(
        '\\ \\(\\)\\[\\]\\{\\}\\;\\&\\|\\*\\?\\$\\`\\\'\\"\\#\\!\\~\\<\\>',
      ),
    ).toBe(' ()[]{};&|*?$`\'"#!~<>');
  });

  it('should be the inverse of escapePath', () => {
    const testCases = [
      'my file.txt',
      'file(1).txt',
      'file[backup].txt',
      'My Documents/Project (2024)/file [backup].txt',
      'file with $special &chars!.txt',
      ' ()[]{};&|*?$`\'"#!~<>',
      'file\twith\ttabs.txt',
    ];

    testCases.forEach((testCase) => {
      expect(unescapePath(escapePath(testCase))).toBe(testCase);
    });
  });

  it('should handle empty strings', () => {
    expect(unescapePath('')).toBe('');
  });

  it('should not affect backslashes not followed by special characters', () => {
    expect(unescapePath('file\\name.txt')).toBe('file\\name.txt');
    expect(unescapePath('path\\to\\file.txt')).toBe('path\\to\\file.txt');
  });

  it('should handle escaped backslashes in unescaping', () => {
    // Should correctly unescape when there are escaped backslashes
    expect(unescapePath('path\\\\\\ file.txt')).toBe('path\\\\ file.txt');
    expect(unescapePath('path\\\\\\\\\\ file.txt')).toBe(
      'path\\\\\\\\ file.txt',
    );
    expect(unescapePath('file\\\\\\(test\\).txt')).toBe('file\\\\(test).txt');
  });
});

describe('isSubpath', () => {
  it('should return true for a direct subpath', () => {
    expect(isSubpath('/a/b', '/a/b/c')).toBe(true);
  });

  it('should return true for the same path', () => {
    expect(isSubpath('/a/b', '/a/b')).toBe(true);
  });

  it('should return false for a parent path', () => {
    expect(isSubpath('/a/b/c', '/a/b')).toBe(false);
  });

  it('should return false for a completely different path', () => {
    expect(isSubpath('/a/b', '/x/y')).toBe(false);
  });

  it('should handle relative paths', () => {
    expect(isSubpath('a/b', 'a/b/c')).toBe(true);
    expect(isSubpath('a/b', 'a/c')).toBe(false);
  });

  it('should handle paths with ..', () => {
    expect(isSubpath('/a/b', '/a/b/../b/c')).toBe(true);
    expect(isSubpath('/a/b', '/a/c/../b')).toBe(true);
  });

  it('should handle root paths', () => {
    expect(isSubpath('/', '/a')).toBe(true);
    expect(isSubpath('/a', '/')).toBe(false);
  });

  it('should handle trailing slashes', () => {
    expect(isSubpath('/a/b/', '/a/b/c')).toBe(true);
    expect(isSubpath('/a/b', '/a/b/c/')).toBe(true);
    expect(isSubpath('/a/b/', '/a/b/c/')).toBe(true);
  });
});

describe('isSubpath on Windows', () => {
  const originalPlatform = process.platform;

  beforeAll(() => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
    });
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
    });
  });

  it('should return true for a direct subpath on Windows', () => {
    expect(isSubpath('C:\\Users\\Test', 'C:\\Users\\Test\\file.txt')).toBe(
      true,
    );
  });

  it('should return true for the same path on Windows', () => {
    expect(isSubpath('C:\\Users\\Test', 'C:\\Users\\Test')).toBe(true);
  });

  it('should return false for a parent path on Windows', () => {
    expect(isSubpath('C:\\Users\\Test\\file.txt', 'C:\\Users\\Test')).toBe(
      false,
    );
  });

  it('should return false for a different drive on Windows', () => {
    expect(isSubpath('C:\\Users\\Test', 'D:\\Users\\Test')).toBe(false);
  });

  it('should be case-insensitive for drive letters on Windows', () => {
    expect(isSubpath('c:\\Users\\Test', 'C:\\Users\\Test\\file.txt')).toBe(
      true,
    );
  });

  it('should be case-insensitive for path components on Windows', () => {
    expect(isSubpath('C:\\Users\\Test', 'c:\\users\\test\\file.txt')).toBe(
      true,
    );
  });

  it('should handle mixed slashes on Windows', () => {
    expect(isSubpath('C:/Users/Test', 'C:\\Users\\Test\\file.txt')).toBe(true);
  });

  it('should handle trailing slashes on Windows', () => {
    expect(isSubpath('C:\\Users\\Test\\', 'C:\\Users\\Test\\file.txt')).toBe(
      true,
    );
  });

  it('should handle relative paths correctly on Windows', () => {
    expect(isSubpath('Users\\Test', 'Users\\Test\\file.txt')).toBe(true);
    expect(isSubpath('Users\\Test\\file.txt', 'Users\\Test')).toBe(false);
  });
});

describe('resolvePath', () => {
  it('resolves relative paths against the provided base directory', () => {
    const result = resolvePath('/home/user/project', 'src/main.ts');
    expect(result).toBe(path.resolve('/home/user/project', 'src/main.ts'));
  });

  it('resolves relative paths against cwd when baseDir is undefined', () => {
    const cwd = process.cwd();
    const result = resolvePath(undefined, 'src/main.ts');
    expect(result).toBe(path.resolve(cwd, 'src/main.ts'));
  });

  it('returns absolute paths unchanged', () => {
    const absolutePath = '/absolute/path/to/file.ts';
    const result = resolvePath('/some/base', absolutePath);
    expect(result).toBe(absolutePath);
  });

  it('expands tilde to home directory', () => {
    const homeDir = os.homedir();
    const result = resolvePath(undefined, '~');
    expect(result).toBe(homeDir);
  });

  it('expands tilde-prefixed paths to home directory', () => {
    const homeDir = os.homedir();
    const result = resolvePath(undefined, '~/documents/file.txt');
    expect(result).toBe(path.join(homeDir, 'documents/file.txt'));
  });

  it('uses baseDir when provided for relative paths', () => {
    const baseDir = '/custom/base';
    const result = resolvePath(baseDir, './relative/path');
    expect(result).toBe(path.resolve(baseDir, './relative/path'));
  });

  it('handles tilde expansion regardless of baseDir', () => {
    const homeDir = os.homedir();
    const result = resolvePath('/some/base', '~/file.txt');
    expect(result).toBe(path.join(homeDir, 'file.txt'));
  });

  it('handles dot paths correctly', () => {
    const result = resolvePath('/base/dir', '.');
    expect(result).toBe(path.resolve('/base/dir', '.'));
  });

  it('handles parent directory references', () => {
    const result = resolvePath('/base/dir/subdir', '..');
    expect(result).toBe(path.resolve('/base/dir/subdir', '..'));
  });
});

describe('validatePath', () => {
  let workspaceRoot: string;
  let config: Config;

  beforeAll(() => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'validate-path-test-'),
    );
    fs.mkdirSync(path.join(workspaceRoot, 'subdir'));
    config = createConfigStub({
      targetDir: workspaceRoot,
      allowedDirectories: [workspaceRoot],
    });
  });

  afterAll(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('validates paths within workspace boundaries', () => {
    const validPath = path.join(workspaceRoot, 'subdir');
    expect(() => validatePath(config, validPath)).not.toThrow();
  });

  it('throws when path is outside workspace boundaries', () => {
    const outsidePath = path.join(os.tmpdir(), 'outside');
    expect(() => validatePath(config, outsidePath)).toThrowError(
      /Path is not within workspace/,
    );
  });

  it('throws when path does not exist', () => {
    const nonExistentPath = path.join(workspaceRoot, 'nonexistent');
    expect(() => validatePath(config, nonExistentPath)).toThrowError(
      /Path does not exist:/,
    );
  });

  it('throws when path is a file, not a directory (default behavior)', () => {
    const filePath = path.join(workspaceRoot, 'test-file.txt');
    fs.writeFileSync(filePath, 'content');
    try {
      expect(() => validatePath(config, filePath)).toThrowError(
        /Path is not a directory/,
      );
    } finally {
      fs.rmSync(filePath);
    }
  });

  it('allows files when allowFiles option is true', () => {
    const filePath = path.join(workspaceRoot, 'test-file.txt');
    fs.writeFileSync(filePath, 'content');
    try {
      expect(() =>
        validatePath(config, filePath, { allowFiles: true }),
      ).not.toThrow();
    } finally {
      fs.rmSync(filePath);
    }
  });

  it('validates paths at workspace root', () => {
    expect(() => validatePath(config, workspaceRoot)).not.toThrow();
  });

  it('validates paths in allowed directories', () => {
    const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-extra-'));
    try {
      const configWithExtra = createConfigStub({
        targetDir: workspaceRoot,
        allowedDirectories: [workspaceRoot, extraDir],
      });
      expect(() => validatePath(configWithExtra, extraDir)).not.toThrow();
    } finally {
      fs.rmSync(extraDir, { recursive: true, force: true });
    }
  });
});

describe('resolveAndValidatePath', () => {
  let workspaceRoot: string;
  let config: Config;

  beforeAll(() => {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'resolve-and-validate-'),
    );
    fs.mkdirSync(path.join(workspaceRoot, 'subdir'));
    config = createConfigStub({
      targetDir: workspaceRoot,
      allowedDirectories: [workspaceRoot],
    });
  });

  afterAll(() => {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('returns the target directory when no path is provided', () => {
    expect(resolveAndValidatePath(config)).toBe(workspaceRoot);
  });

  it('resolves relative paths within the workspace', () => {
    const expected = path.join(workspaceRoot, 'subdir');
    expect(resolveAndValidatePath(config, 'subdir')).toBe(expected);
  });

  it('allows absolute paths that are permitted by the workspace context', () => {
    const extraDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'resolve-and-validate-extra-'),
    );
    try {
      const configWithExtra = createConfigStub({
        targetDir: workspaceRoot,
        allowedDirectories: [workspaceRoot, extraDir],
      });
      expect(resolveAndValidatePath(configWithExtra, extraDir)).toBe(extraDir);
    } finally {
      fs.rmSync(extraDir, { recursive: true, force: true });
    }
  });

  it('expands tilde-prefixed paths using the home directory', () => {
    const fakeHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'resolve-and-validate-home-'),
    );
    const homeSubdir = path.join(fakeHome, 'project');
    fs.mkdirSync(homeSubdir);

    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    try {
      const configWithHome = createConfigStub({
        targetDir: workspaceRoot,
        allowedDirectories: [workspaceRoot, fakeHome],
      });
      expect(resolveAndValidatePath(configWithHome, '~/project')).toBe(
        homeSubdir,
      );
      expect(resolveAndValidatePath(configWithHome, '~')).toBe(fakeHome);
    } finally {
      homedirSpy.mockRestore();
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it('throws when the path resolves outside of the workspace', () => {
    expect(() => resolveAndValidatePath(config, '../outside')).toThrowError(
      /Path is not within workspace/,
    );
  });

  it('throws when the path does not exist', () => {
    expect(() => resolveAndValidatePath(config, 'missing')).toThrowError(
      /Path does not exist:/,
    );
  });

  it('throws when the path points to a file (default behavior)', () => {
    const filePath = path.join(workspaceRoot, 'file.txt');
    fs.writeFileSync(filePath, 'content');
    try {
      expect(() => resolveAndValidatePath(config, 'file.txt')).toThrowError(
        `Path is not a directory: ${filePath}`,
      );
    } finally {
      fs.rmSync(filePath);
    }
  });

  it('allows file paths when allowFiles option is true', () => {
    const filePath = path.join(workspaceRoot, 'file.txt');
    fs.writeFileSync(filePath, 'content');
    try {
      const result = resolveAndValidatePath(config, 'file.txt', {
        allowFiles: true,
      });
      expect(result).toBe(filePath);
    } finally {
      fs.rmSync(filePath);
    }
  });
});
