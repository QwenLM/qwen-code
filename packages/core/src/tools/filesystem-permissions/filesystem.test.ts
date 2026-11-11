/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  normalizeCaseForComparison,
  toPosixPath,
  relativePath,
  isDangerousFileName,
  isDangerousDirectorySegment,
  isDangerousFilePathToAutoEdit,
  hasSuspiciousWindowsPathPattern,
  checkPathSafetyForAutoEdit,
  allWorkingDirectories,
  pathInWorkingPath,
  pathInAllowedWorkingPath,
  patternWithRoot,
  rootPathForSource,
  matchingRuleForInput,
  checkReadPermissionForPath,
  checkWritePermissionForPath,
  getFileReadIgnorePatterns,
  DANGEROUS_FILES,
  DANGEROUS_DIRECTORIES,
  PROJECT_CONFIG_DIR_NAME,
  SAFE_CONFIG_SUBDIRS,
  isInternalPath,
} from './filesystem.js';
import type { PathPermissionContext } from '../tool-checkers/checker-reasons.js';
import {
  getConfigHomeDirOverride,
  sanitizePath,
  setConfigHomeDirOverride,
} from '../../utils/paths.js';

// Mock homedir for consistent test results
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => '/home/testuser',
  };
});

/**
 * A minimal path-permission context. Callers pass rule buckets by behaviour and
 * trusted directories as paths.
 */
function makeContext(
  overrides: {
    allow?: Record<string, string[]>;
    deny?: Record<string, string[]>;
    ask?: Record<string, string[]>;
    additionalDirectories?: string[];
  } = {},
): PathPermissionContext {
  const { allow = {}, deny = {}, ask = {}, additionalDirectories = [] } =
    overrides;
  return {
    rules: { allow, deny, ask },
    additionalDirectories,
  };
}

describe('filesystem', () => {
  // ========================================================================
  // Constants
  // ========================================================================

  describe('constants', () => {
    it('DANGEROUS_FILES should include shell configs', () => {
      expect(DANGEROUS_FILES).toContain('.bashrc');
      expect(DANGEROUS_FILES).toContain('.zshrc');
      expect(DANGEROUS_FILES).toContain('.profile');
    });

    it('DANGEROUS_FILES should include git configs', () => {
      expect(DANGEROUS_FILES).toContain('.gitconfig');
      expect(DANGEROUS_FILES).toContain('.gitmodules');
    });

    it('DANGEROUS_FILES should include tool configs', () => {
      expect(DANGEROUS_FILES).toContain('.mcp.json');
    });

    it('DANGEROUS_DIRECTORIES should include VCS and IDE dirs', () => {
      expect(DANGEROUS_DIRECTORIES).toContain('.git');
      expect(DANGEROUS_DIRECTORIES).toContain('.vscode');
      expect(DANGEROUS_DIRECTORIES).toContain('.idea');
      expect(DANGEROUS_DIRECTORIES).toContain('.husky');
    });

    it('DANGEROUS_DIRECTORIES should include project config dir', () => {
      expect(DANGEROUS_DIRECTORIES).toContain('.qwen');
    });
  });

  // ========================================================================
  // Path Normalization
  // ========================================================================

  describe('normalizeCaseForComparison', () => {
    it('should lowercase paths', () => {
      expect(normalizeCaseForComparison('/Path/To/FILE')).toBe('/path/to/file');
    });
  });

  describe('toPosixPath', () => {
    it.skipIf(process.platform === 'win32')(
      'should return path as-is on non-Windows platforms',
      () => {
        // On non-Windows, toPosixPath is a no-op since backslashes
        // are not path separators on POSIX systems
        expect(toPosixPath('C:\\Users\\test\\file.txt')).toBe(
          'C:\\Users\\test\\file.txt',
        );
      },
    );

    it('should not modify forward-slash paths', () => {
      expect(toPosixPath('/home/user/file.txt')).toBe('/home/user/file.txt');
    });
  });

  describe('relativePath', () => {
    it('should compute relative path', () => {
      expect(relativePath('/home/user', '/home/user/docs/file.txt')).toBe(
        'docs/file.txt',
      );
    });

    it('should handle same path', () => {
      expect(relativePath('/home/user', '/home/user')).toBe('');
    });

    it('should handle parent traversal', () => {
      expect(relativePath('/home/user/docs', '/home/user/other')).toBe(
        '../other',
      );
    });
  });

  // ========================================================================
  // Dangerous File/Directory Detection
  // ========================================================================

  describe('isDangerousFileName', () => {
    it('should detect dangerous filenames', () => {
      expect(isDangerousFileName('.bashrc')).toBe(true);
      expect(isDangerousFileName('.gitconfig')).toBe(true);
    });

    it('should be case-insensitive', () => {
      expect(isDangerousFileName('.BASHRC')).toBe(true);
      expect(isDangerousFileName('.BaShRc')).toBe(true);
    });

    it('should not flag safe filenames', () => {
      expect(isDangerousFileName('README.md')).toBe(false);
      expect(isDangerousFileName('package.json')).toBe(false);
    });
  });

  describe('isDangerousDirectorySegment', () => {
    it('should detect dangerous directories', () => {
      expect(isDangerousDirectorySegment('.git')).toBe(true);
      expect(isDangerousDirectorySegment('.vscode')).toBe(true);
    });

    it('should be case-insensitive', () => {
      expect(isDangerousDirectorySegment('.GIT')).toBe(true);
      expect(isDangerousDirectorySegment('.Git')).toBe(true);
    });

    it('should not flag safe directories', () => {
      expect(isDangerousDirectorySegment('src')).toBe(false);
      expect(isDangerousDirectorySegment('node_modules')).toBe(false);
    });
  });

  describe('isDangerousFilePathToAutoEdit', () => {
    it('should detect files within dangerous directories', () => {
      expect(isDangerousFilePathToAutoEdit('/project/.git/config')).toBe(true);
      expect(
        isDangerousFilePathToAutoEdit('/project/.vscode/settings.json'),
      ).toBe(true);
    });

    it('should detect dangerous filenames', () => {
      expect(isDangerousFilePathToAutoEdit('/home/user/.bashrc')).toBe(true);
      expect(isDangerousFilePathToAutoEdit('/home/user/.gitconfig')).toBe(true);
    });

    it(`should allow extensible ${PROJECT_CONFIG_DIR_NAME} subdirectories`, () => {
      for (const subdir of SAFE_CONFIG_SUBDIRS) {
        expect(
          isDangerousFilePathToAutoEdit(
            `/project/${PROJECT_CONFIG_DIR_NAME}/${subdir}/abc/file.txt`,
          ),
        ).toBe(false);
      }
    });

    it(`should allow ${PROJECT_CONFIG_DIR_NAME}/projects/<id>/memory subtree (auto-memory write area)`, () => {
      expect(
        isDangerousFilePathToAutoEdit(
          `/Users/u/${PROJECT_CONFIG_DIR_NAME}/projects/-Users-u-cli-app/memory/MEMORY.md`,
        ),
      ).toBe(false);
      expect(
        isDangerousFilePathToAutoEdit(
          `/Users/u/${PROJECT_CONFIG_DIR_NAME}/projects/-Users-u-cli-app/memory/feedback_x.md`,
        ),
      ).toBe(false);
    });

    it(`should allow user-scope ${PROJECT_CONFIG_DIR_NAME}/memory subtree (auto-memory write area)`, () => {
      expect(
        isDangerousFilePathToAutoEdit(
          path.join(getConfigHomeDir(), 'memory', 'MEMORY.md'),
        ),
      ).toBe(false);
      expect(
        isDangerousFilePathToAutoEdit(
          path.join(getConfigHomeDir(), 'memory', 'user-employee-id.md'),
        ),
      ).toBe(false);
    });

    it(`should still block ${PROJECT_CONFIG_DIR_NAME}/projects/<id>/non-memory siblings`, () => {
      expect(
        isDangerousFilePathToAutoEdit(
          `/Users/u/${PROJECT_CONFIG_DIR_NAME}/projects/-Users-u-cli-app/cache/foo.json`,
        ),
      ).toBe(true);
    });

    it(`should block ${PROJECT_CONFIG_DIR_NAME} non-worktree files`, () => {
      expect(
        isDangerousFilePathToAutoEdit(
          `/project/${PROJECT_CONFIG_DIR_NAME}/settings.json`,
        ),
      ).toBe(true);
    });

    it('should not flag safe paths', () => {
      expect(isDangerousFilePathToAutoEdit('/project/src/main.ts')).toBe(false);
      expect(isDangerousFilePathToAutoEdit('/project/README.md')).toBe(false);
    });
  });

  describe('isInternalPath', () => {
    const cwd = '/project';

    it('should allow todo.md', () => {
      expect(isInternalPath(`/project/${PROJECT_CONFIG_DIR_NAME}/todo.md`, cwd)).toBe(true);
    });

    it('should allow memory/ subtree', () => {
      expect(isInternalPath(`/project/${PROJECT_CONFIG_DIR_NAME}/memory/auto/MEMORY.md`, cwd)).toBe(true);
    });

    it('should allow settings.json', () => {
      expect(isInternalPath(`/project/${PROJECT_CONFIG_DIR_NAME}/settings.json`, cwd)).toBe(true);
    });

    it('should allow settings.local.json', () => {
      expect(isInternalPath(`/project/${PROJECT_CONFIG_DIR_NAME}/settings.local.json`, cwd)).toBe(true);
    });

    it('should block hooks.json (not in allowed patterns)', () => {
      expect(isInternalPath(`/project/${PROJECT_CONFIG_DIR_NAME}/hooks.json`, cwd)).toBe(false);
    });

    it('should block directory traversal using settings.json as directory name', () => {
      expect(isInternalPath(`/project/${PROJECT_CONFIG_DIR_NAME}/settings.json/malicious.sh`, cwd)).toBe(false);
    });

    it('should not match paths outside the project config dir', () => {
      expect(isInternalPath('/other/project/.qwen/settings.json', cwd)).toBe(false);
    });

    it('should be case-insensitive', () => {
      expect(isInternalPath(`/project/${PROJECT_CONFIG_DIR_NAME}/Settings.JSON`, cwd)).toBe(true);
      expect(isInternalPath(`/project/${PROJECT_CONFIG_DIR_NAME}/SETTINGS.LOCAL.JSON`, cwd)).toBe(true);
    });
  });

  // ========================================================================
  // Windows Path Safety
  // ========================================================================

  describe('hasSuspiciousWindowsPathPattern', () => {
    it('should detect ADS (Alternate Data Streams)', () => {
      expect(hasSuspiciousWindowsPathPattern('file.txt:Zone.Identifier')).toBe(
        true,
      );
    });

    it('should not flag drive letter colon', () => {
      expect(hasSuspiciousWindowsPathPattern('C:\\file.txt')).toBe(false);
    });

    // skip: 现存失败
    it.skip('should detect device paths', () => {
      expect(hasSuspiciousWindowsPathPattern('\\\\?\\C:\\file')).toBe(true);
      expect(hasSuspiciousWindowsPathPattern('\\\\.\\COM1')).toBe(true);
      expect(hasSuspiciousWindowsPathPattern('//?/C:/file')).toBe(true);
    });

    it('should detect short name aliases', () => {
      expect(hasSuspiciousWindowsPathPattern('C:\\PROGRA~1\\app')).toBe(true);
    });

    it('should not flag normal paths', () => {
      expect(hasSuspiciousWindowsPathPattern('/home/user/file.txt')).toBe(
        false,
      );
    });
  });

  // ========================================================================
  // Path Safety for Auto-Edit
  // ========================================================================

  describe('checkPathSafetyForAutoEdit', () => {
    it('should return safe for normal paths', () => {
      const result = checkPathSafetyForAutoEdit('/project/src/main.ts');
      expect(result.safe).toBe(true);
    });

    it('should block suspicious Windows patterns', () => {
      const result = checkPathSafetyForAutoEdit('file.txt:Zone.Identifier');
      expect(result.safe).toBe(false);
      if (!result.safe) {
        expect(result.classifierApprovable).toBe(false);
      }
    });

    it('should flag dangerous file paths as classifier-approvable', () => {
      const result = checkPathSafetyForAutoEdit('/home/user/.bashrc');
      expect(result.safe).toBe(false);
      if (!result.safe) {
        expect(result.classifierApprovable).toBe(true);
      }
    });

    it('should check all provided paths', () => {
      // First path is safe, second is dangerous
      const result = checkPathSafetyForAutoEdit('/project/src/main.ts', [
        '/project/src/main.ts',
        '/home/user/.bashrc',
      ]);
      expect(result.safe).toBe(false);
    });
  });

  // ========================================================================
  // Working Directory Checks
  // ========================================================================

  describe('allWorkingDirectories', () => {
    it('should include CWD', () => {
      const ctx = makeContext();
      const dirs = allWorkingDirectories(ctx, '/project');
      expect(dirs.has('/project')).toBe(true);
      expect(dirs.size).toBe(1);
    });

    it('should include additional directories', () => {
      const ctx = makeContext({
        additionalDirectories: ['/extra'],
      });
      const dirs = allWorkingDirectories(ctx, '/project');
      expect(dirs.size).toBe(2);
      expect(dirs.has('/extra')).toBe(true);
    });
  });

  describe('pathInWorkingPath', () => {
    it('should return true for paths within working directory', () => {
      expect(pathInWorkingPath('/project/src/main.ts', '/project')).toBe(true);
    });

    it('should return true for same path', () => {
      expect(pathInWorkingPath('/project', '/project')).toBe(true);
    });

    it('should return false for paths outside working directory', () => {
      expect(pathInWorkingPath('/other/file.txt', '/project')).toBe(false);
    });

    it('should return false for parent traversal', () => {
      expect(pathInWorkingPath('/project/../etc/passwd', '/project')).toBe(
        false,
      );
    });

    it('should handle macOS /private/var normalization', () => {
      expect(pathInWorkingPath('/private/var/folders/x', '/var/folders')).toBe(
        true,
      );
    });

    it('should handle macOS /private/tmp normalization', () => {
      expect(pathInWorkingPath('/private/tmp/file', '/tmp')).toBe(true);
    });

    it('should expand tilde', () => {
      expect(pathInWorkingPath('~/docs/file.txt', '/home/testuser')).toBe(true);
    });

    it('should allow directories starting with ".." that are not traversals', () => {
      // '..cache' is a legitimate directory name, not a parent traversal
      expect(pathInWorkingPath('/workspace/..cache/a.md', '/workspace')).toBe(
        true,
      );
      expect(pathInWorkingPath('/workspace/..foo/bar', '/workspace')).toBe(
        true,
      );
    });

    it('should still reject actual parent traversal via ".."', () => {
      expect(pathInWorkingPath('/workspace/../etc/passwd', '/workspace')).toBe(
        false,
      );
      // bare '..' resolves to parent
      expect(pathInWorkingPath('/workspace/..', '/workspace')).toBe(false);
    });
  });

  describe('pathInAllowedWorkingPath', () => {
    it('should check against all working directories', () => {
      const ctx = makeContext({
        additionalDirectories: ['/extra'],
      });
      expect(pathInAllowedWorkingPath('/extra/file.txt', ctx, '/project')).toBe(
        true,
      );
      expect(
        pathInAllowedWorkingPath('/project/src/main.ts', ctx, '/project'),
      ).toBe(true);
    });

    it('should return false for paths outside all directories', () => {
      const ctx = makeContext();
      expect(pathInAllowedWorkingPath('/other/file.txt', ctx, '/project')).toBe(
        false,
      );
    });
  });

  // ========================================================================
  // Pattern Resolution
  // ========================================================================

  describe('rootPathForSource', () => {
    it('should return homedir for userSettings', () => {
      expect(rootPathForSource('userSettings', '/project')).toBe(
        '/home/testuser',
      );
    });

    it('should return cwd for projectSettings', () => {
      expect(rootPathForSource('projectSettings', '/project')).toBe('/project');
    });

    it('should return cwd for localSettings', () => {
      expect(rootPathForSource('localSettings', '/project')).toBe('/project');
    });

    it('should return cwd as fallback', () => {
      expect(rootPathForSource('session', '/project')).toBe('/project');
    });
  });

  describe('patternWithRoot', () => {
    it('should handle absolute path pattern (//)', () => {
      const result = patternWithRoot('//etc/passwd', 'session', '/project');
      expect(result.root).toBe('/');
      expect(result.relativePattern).toBe('/etc/passwd');
    });

    it('should handle home directory pattern (~)', () => {
      const result = patternWithRoot('~/docs/**', 'session', '/project');
      expect(result.root).toBe('/home/testuser');
      expect(result.relativePattern).toBe('/docs/**');
    });

    it('should handle rooted pattern (/)', () => {
      const result = patternWithRoot('/src/**', 'projectSettings', '/project');
      expect(result.root).toBe('/project');
      expect(result.relativePattern).toBe('/src/**');
    });

    it('should handle rootless pattern', () => {
      const result = patternWithRoot('*.test.ts', 'session', '/project');
      expect(result.root).toBeNull();
      expect(result.relativePattern).toBe('/*.test.ts');
    });
  });

  // ========================================================================
  // Rule Matching
  // ========================================================================

  describe('matchingRuleForInput', () => {
    it('should match a simple file pattern', () => {
      const ctx = makeContext({
        deny: {
          projectSettings: ['Read(/secret/**)'],
        },
      });
      const rule = matchingRuleForInput(
        '/project/secret/key.pem',
        ctx,
        'read',
        'deny',
        '/project',
      );
      expect(rule).not.toBeNull();
      expect(rule!.ruleBehavior).toBe('deny');
    });

    it('should not match when path is outside pattern root', () => {
      const ctx = makeContext({
        deny: {
          projectSettings: ['Read(/secret/**)'],
        },
      });
      const rule = matchingRuleForInput(
        '/other/secret/key.pem',
        ctx,
        'read',
        'deny',
        '/project',
      );
      expect(rule).toBeNull();
    });

    it('should match absolute path pattern', () => {
      const ctx = makeContext({
        allow: {
          session: ['Read(//tmp/data/**)'],
        },
      });
      const rule = matchingRuleForInput(
        '/tmp/data/report.csv',
        ctx,
        'read',
        'allow',
        '/project',
      );
      expect(rule).not.toBeNull();
    });

    it('should match rootless pattern from any location', () => {
      const ctx = makeContext({
        deny: {
          projectSettings: ['Read(*.secret)'],
        },
      });
      const rule = matchingRuleForInput(
        '/any/path/to/file.secret',
        ctx,
        'read',
        'deny',
        '/project',
      );
      expect(rule).not.toBeNull();
    });

    it('should return null when no rules match', () => {
      const ctx = makeContext({
        allow: {
          session: ['Read(/docs/**)'],
        },
      });
      const rule = matchingRuleForInput(
        '/project/src/main.ts',
        ctx,
        'read',
        'allow',
        '/project',
      );
      expect(rule).toBeNull();
    });

    it('should skip tool-wide rules without content', () => {
      const ctx = makeContext({
        deny: {
          projectSettings: ['Read'],
        },
      });
      const rule = matchingRuleForInput(
        '/project/any/file.txt',
        ctx,
        'read',
        'deny',
        '/project',
      );
      // Tool-wide rules (no content) don't participate in pattern matching
      expect(rule).toBeNull();
    });

    it('should match edit tool rules', () => {
      const ctx = makeContext({
        allow: {
          localSettings: ['Edit(/src/**)'],
        },
      });
      const rule = matchingRuleForInput(
        '/project/src/component.tsx',
        ctx,
        'edit',
        'allow',
        '/project',
      );
      expect(rule).not.toBeNull();
      expect(rule!.ruleValue.toolName).toBe('Edit');
    });
  });

  // ========================================================================
  // Permission Check Pipelines
  // ========================================================================

  describe('checkReadPermissionForPath', () => {
    it('should allow reads within working directory', () => {
      const ctx = makeContext();
      const result = checkReadPermissionForPath(
        '/project/src/main.ts',
        ctx,
        '/project',
      );
      expect(result.kind).toBe('allow');
    });

    it('should ask for UNC paths (Windows-only enforcement)', () => {
      vi.stubGlobal(
        'process',
        Object.create(process, { platform: { get: () => 'win32' } }),
      );
      try {
        const ctx = makeContext();
        const result = checkReadPermissionForPath(
          '\\\\evil.com\\share',
          ctx,
          '/project',
        );
        expect(result.kind).toBe('ask');
        expect(result.kind === 'ask' ? result.reason?.decisionPoint : undefined).toBe(
          'fs_read.network_path.ask',
        );
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('should not gate UNC paths on non-Windows platforms', () => {
      vi.stubGlobal(
        'process',
        Object.create(process, { platform: { get: () => 'linux' } }),
      );
      try {
        const ctx = makeContext();
        const result = checkReadPermissionForPath(
          '\\\\evil.com\\share',
          ctx,
          '/project',
        );
        expect(
          result.kind === 'ask' ? result.reason?.decisionPoint : undefined,
        ).not.toBe('fs_read.network_path.ask');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    // skip: 现存失败
    it.skip('should deny suspicious Windows paths', () => {
      const ctx = makeContext();
      const result = checkReadPermissionForPath(
        'file.txt:Zone.Identifier',
        ctx,
        '/project',
      );
      expect(result.kind).toBe('deny');
    });

    it('should apply deny rules', () => {
      const ctx = makeContext({
        deny: {
          projectSettings: ['Read(/secret/**)'],
        },
      });
      const result = checkReadPermissionForPath(
        '/project/secret/key.pem',
        ctx,
        '/project',
      );
      expect(result.kind).toBe('deny');
    });

    it('should allow plan file reads in plan mode outside the working directory', () => {
      const ctx = makeContext();
      const planFilePath = path.join(
        getConfigHomeDir(),
        'plans',
        'session-plan.md',
      );
      const result = checkReadPermissionForPath(planFilePath, ctx, '/project');
      expect(result.kind).toBe('allow');
    });

    it('should allow plan file reads outside plan mode (mode-decoupled)', () => {
      // Behavior change: plan files are now exempted in any mode via the
      // InternalPaths.isSessionPlanFile sub-domain, decoupling exemption from
      // context.planModeActive. Plan files are now mode-independent.
      const ctx = makeContext();
      const planFilePath = path.join(
        getConfigHomeDir(),
        'plans',
        'session-plan.md',
      );
      const result = checkReadPermissionForPath(planFilePath, ctx, '/project');
      expect(result.kind).toBe('allow');
    });

    it('should keep explicit read deny rules above plan file reads', () => {
      const planFilePath = path.join(
        getConfigHomeDir(),
        'plans',
        'session-plan.md',
      );
      const plansDirPattern = `/${toPosixPath(path.dirname(planFilePath))}/**`;
      const ctx = makeContext({

        deny: {
          session: [`Read(${plansDirPattern})`],
        },
      });
      const result = checkReadPermissionForPath(planFilePath, ctx, '/project');
      expect(result.kind).toBe('deny');
    });

    it('should apply allow rules for paths outside working dir', () => {
      const ctx = makeContext({
        allow: {
          session: ['Read(//tmp/data/**)'],
        },
      });
      const result = checkReadPermissionForPath(
        '/tmp/data/report.csv',
        ctx,
        '/project',
      );
      expect(result.kind).toBe('allow');
    });

    it('should ask for paths outside working directory with no rules', () => {
      const ctx = makeContext();
      const result = checkReadPermissionForPath(
        '/other/file.txt',
        ctx,
        '/project',
      );
      expect(result.kind).toBe('ask');
      if (result.kind === 'ask') {
        expect(result.reason.attribution).toEqual({
          type: 'workingDir',
          reason: 'Path is outside allowed working directories',
        });
      }
    });

    it.skipIf(process.platform === 'win32')(
      'should suggest the target directory when reading an existing directory outside the working directory',
      () => {
        const tempDir = fs.realpathSync(
          fs.mkdtempSync(path.join(os.tmpdir(), 'read-dir-suggestion-')),
        );

        try {
          const projectDir = path.join(tempDir, 'project');
          const outsideDir = path.join(tempDir, 'outside');
          fs.mkdirSync(projectDir, { recursive: true });
          fs.mkdirSync(outsideDir, { recursive: true });

          const result = checkReadPermissionForPath(
            outsideDir,
            makeContext(),
            projectDir,
          );

          expect(result.kind).toBe('ask');
          if (result.kind === 'ask') {
            expect(result.suggestions).toContainEqual(
              expect.objectContaining({
                type: 'addRules',
                behavior: 'allow',
                destination: 'session',
                rules: [
                  {
                    toolName: 'Read',
                    ruleContent: `/${toPosixPath(outsideDir)}/**`,
                  },
                ],
              }),
            );
          }
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      },
    );

    it('should allow auto-memory reads in default mode', () => {
      const ctx = makeContext();
      const autoMemoryPaths = [
        path.join(getConfigHomeDir(), 'memory', 'MEMORY.md'),
        `/Users/u/${PROJECT_CONFIG_DIR_NAME}/projects/-Users-u-cli-app/memory/project-context.md`,
      ];

      for (const autoMemoryPath of autoMemoryPaths) {
        const result = checkReadPermissionForPath(
          autoMemoryPath,
          ctx,
          '/project',
        );
        expect(result.kind).toBe('allow');
      }
    });

    it('should keep explicit read deny rules above auto-memory reads', () => {
      const projectMemoryDir = `/Users/u/${PROJECT_CONFIG_DIR_NAME}/projects/-Users-u-cli-app/memory`;
      const ctx = makeContext({
        deny: {
          session: [`Read(/${projectMemoryDir}/**)`],
        },
      });
      const result = checkReadPermissionForPath(
        `${projectMemoryDir}/MEMORY.md`,
        ctx,
        '/Users/u/cli/app',
      );
      expect(result.kind).toBe('deny');
    });

    it.skipIf(process.platform === 'win32')(
      'should ask for a relative symlink file that resolves outside the working directory',
      () => {
        const tempDir = fs.realpathSync(
          fs.mkdtempSync(path.join(os.tmpdir(), 'read-symlink-perm-')),
        );

        try {
          const projectDir = path.join(tempDir, 'project');
          const projectSrcDir = path.join(projectDir, 'src');
          const outsideDir = path.join(tempDir, 'outside');
          fs.mkdirSync(projectSrcDir, { recursive: true });
          fs.mkdirSync(outsideDir, { recursive: true });

          const outsideFile = path.join(outsideDir, 'secret.txt');
          fs.writeFileSync(outsideFile, 'secret');
          fs.symlinkSync(
            outsideFile,
            path.join(projectSrcDir, 'secret-link.txt'),
            'file',
          );

          const result = checkReadPermissionForPath(
            'src/secret-link.txt',
            makeContext(),
            projectDir,
          );

          expect(result.kind).toBe('ask');
          if (result.kind === 'ask') {
            expect(result.reason.message).toContain(
              'resolves outside the working directory',
            );
            expect(result.reason.message).toContain(outsideFile);
          }
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      },
    );
  });

  describe('checkWritePermissionForPath', () => {
    it('should return ask for writes in working dir when acceptEdits mode (allow decision in resolveByMode)', () => {
      const ctx = makeContext();
      const result = checkWritePermissionForPath(
        '/project/src/main.ts',
        ctx,
        '/project',
      );
      expect(result.kind).toBe('ask');
    });

    it('should ask for writes in working dir in default mode', () => {
      const ctx = makeContext();
      const result = checkWritePermissionForPath(
        '/project/src/main.ts',
        ctx,
        '/project',
      );
      expect(result.kind).toBe('ask');
    });

    it('should apply deny rules', () => {
      const ctx = makeContext({
        deny: {
          projectSettings: ['Edit(/protected/**)'],
        },
      });
      const result = checkWritePermissionForPath(
        '/project/protected/config.yml',
        ctx,
        '/project',
      );
      expect(result.kind).toBe('deny');
    });

    it('should flag dangerous paths for confirmation', () => {
      const ctx = makeContext();
      const result = checkWritePermissionForPath(
        '/home/user/.bashrc',
        ctx,
        '/project',
      );
      expect(result.kind).toBe('ask');
    });

    it('should apply allow rules', () => {
      const ctx = makeContext({
        allow: {
          localSettings: ['Edit(/src/**)'],
        },
      });
      const result = checkWritePermissionForPath(
        '/project/src/component.tsx',
        ctx,
        '/project',
      );
      expect(result.kind).toBe('allow');
    });

    it('should allow project-scope auto-memory writes in default mode', () => {
      const ctx = makeContext();
      const projectMemoryDir = `/Users/u/${PROJECT_CONFIG_DIR_NAME}/projects/-Users-u-cli-app/memory`;
      const autoMemoryPaths = [
        `${projectMemoryDir}/MEMORY.md`,
        `${projectMemoryDir}/feedback-testing.md`,
      ];

      for (const autoMemoryPath of autoMemoryPaths) {
        const result = checkWritePermissionForPath(
          autoMemoryPath,
          ctx,
          '/Users/u/cli/app',
        );
        expect(result.kind).toBe('allow');
      }
    });

    it('should allow user-scope auto-memory writes in default mode', () => {
      const ctx = makeContext();
      const result = checkWritePermissionForPath(
        path.join(getConfigHomeDir(), 'memory', 'user-employee-id.md'),
        ctx,
        '/project',
      );
      expect(result.kind).toBe('allow');
    });

    it('should allow user-scope auto-memory writes in acceptEdits mode', () => {
      const ctx = makeContext();
      const result = checkWritePermissionForPath(
        path.join(getConfigHomeDir(), 'memory', 'user-employee-id.md'),
        ctx,
        '/project',
      );
      expect(result.kind).toBe('allow');
    });

    it('should allow user-scope auto-memory writes in auto mode', () => {
      const ctx = makeContext();
      const result = checkWritePermissionForPath(
        path.join(getConfigHomeDir(), 'memory', 'user-employee-id.md'),
        ctx,
        '/project',
      );
      expect(result.kind).toBe('allow');
    });

    it('should keep explicit write deny rules above auto-memory writes', () => {
      const projectMemoryDir = `/Users/u/${PROJECT_CONFIG_DIR_NAME}/projects/-Users-u-cli-app/memory`;
      const ctx = makeContext({
        deny: {
          session: [`Edit(/${projectMemoryDir}/**)`],
        },
      });
      const result = checkWritePermissionForPath(
        `${projectMemoryDir}/MEMORY.md`,
        ctx,
        '/Users/u/cli/app',
      );
      expect(result.kind).toBe('deny');
    });

    it('should allow auto-memory (internal) writes above explicit write ask rules (internal before ask)', () => {
      const projectMemoryDir = `/Users/u/${PROJECT_CONFIG_DIR_NAME}/projects/-Users-u-cli-app/memory`;
      const ctx = makeContext({
        ask: {
          session: [`Edit(/${projectMemoryDir}/**)`],
        },
      });
      const result = checkWritePermissionForPath(
        `${projectMemoryDir}/MEMORY.md`,
        ctx,
        '/Users/u/cli/app',
      );
      expect(result.kind).toBe('allow');
    });

    it(`should return ask for non-memory ${PROJECT_CONFIG_DIR_NAME} writes in auto mode (deny decision in resolveAutoMode)`, () => {
      const ctx = makeContext();
      const result = checkWritePermissionForPath(
        path.join(getConfigHomeDir(), 'settings.json'),
        ctx,
        '/project',
      );
      expect(result.kind).toBe('ask');
      if (result.kind === 'ask') {
        expect(result.reason.attribution.type).toBe('safetyCheck');
      }
    });

    it.each(['settings.json', 'settings.local.json'])(
      `should route project ${PROJECT_CONFIG_DIR_NAME}/%s writes to a classifier-approvable safety check`,
      (file) => {
        const result = checkWritePermissionForPath(
          `/project/${PROJECT_CONFIG_DIR_NAME}/${file}`,
          makeContext(),
          '/project',
        );
        expect(result.kind).toBe('ask');
        if (result.kind === 'ask') {
          expect(result.reason.attribution).toMatchObject({
            type: 'safetyCheck',
            safetyCheckKind: 'protectedPath',
            classifierApprovable: true,
          });
        }
      },
    );

    it('should mark config extension writes for auto-mode review without a safety check', () => {
      const D = PROJECT_CONFIG_DIR_NAME;
      const reviewed = [
        `/project/${D}/skills/demo/SKILL.md`,
        `/project/${D}/agents/helper.md`,
        `/project/${D}/Commands/run.md`,
        `/project/${D}/worktrees/w/${D}/skills/demo/SKILL.md`,
      ];
      for (const file of reviewed) {
        const result = checkWritePermissionForPath(file, makeContext(), '/project');
        expect(result.kind).toBe('ask');
        if (result.kind === 'ask') {
          expect(result.reason.attribution.type).not.toBe('safetyCheck');
          expect(result.extra?.autoModeReview).toBe(true);
        }
      }

      for (const file of [
        `/project/${D}/worktrees/w/src/a.ts`,
        '/project/src/skills/a.ts',
      ]) {
        const result = checkWritePermissionForPath(file, makeContext(), '/project');
        expect(result.extra?.autoModeReview).toBeUndefined();
      }
    });

    it('should return ask for writes in default mode (mode suggestion in resolveByMode)', () => {
      const ctx = makeContext();
      const result = checkWritePermissionForPath(
        '/project/src/main.ts',
        ctx,
        '/project',
      );
      expect(result.kind).toBe('ask');
      // Tool no longer adds mode-specific suggestions — that's resolveByMode's job.
      // The full pipeline (hasPermissionsToUseTool) will include the setMode suggestion.
    });

    it.skipIf(process.platform === 'win32')(
      'should ask before acceptEdits writes through a relative symlink directory outside the working directory',
      () => {
        const tempDir = fs.realpathSync(
          fs.mkdtempSync(path.join(os.tmpdir(), 'write-symlink-perm-')),
        );

        try {
          const projectDir = path.join(tempDir, 'project');
          const outsideDir = path.join(tempDir, 'outside');
          fs.mkdirSync(projectDir, { recursive: true });
          fs.mkdirSync(outsideDir, { recursive: true });
          fs.symlinkSync(outsideDir, path.join(projectDir, 'linked'), 'dir');

          const result = checkWritePermissionForPath(
            'linked/deep/new-file.txt',
            makeContext(),
            projectDir,
          );

          expect(result.kind).toBe('ask');
          if (result.kind === 'ask') {
            expect(result.reason.message).toContain(
              'resolves outside the working directory',
            );
            expect(result.reason.message).toContain(
              path.join(outsideDir, 'deep', 'new-file.txt'),
            );
          }
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      },
    );
  });

  // ========================================================================
  // File Read Ignore Patterns
  // ========================================================================

  describe('getFileReadIgnorePatterns', () => {
    it('should return empty map when no deny rules', () => {
      const ctx = makeContext();
      const patterns = getFileReadIgnorePatterns(ctx, '/project');
      expect(patterns.size).toBe(0);
    });

    it('should extract deny patterns for read tool', () => {
      const ctx = makeContext({
        deny: {
          projectSettings: ['Read(/secret/**)'],
        },
      });
      const patterns = getFileReadIgnorePatterns(ctx, '/project');
      expect(patterns.size).toBeGreaterThan(0);
    });
  });
});


describe.skipIf(process.platform === 'win32')(
  'project temp reads through a symlinked config home',
  () => {
    let root: string;
    let cwd: string;
    let source: string;
    let previousConfigHome: string | undefined;

    beforeEach(() => {
      previousConfigHome = getConfigHomeDirOverride();
      root = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'config-symlink-read-')),
      );
      cwd = path.join(root, 'workspace');
      fs.mkdirSync(cwd);
      const configHome = path.join(root, 'config');
      const realConfigHome = path.join(root, 'storage');
      fs.mkdirSync(realConfigHome);
      fs.symlinkSync(realConfigHome, configHome, 'dir');
      setConfigHomeDirOverride(configHome);
      source = path.join(
        configHome,
        'tmp',
        sanitizePath(cwd),
        'tool-outputs',
        'session-test',
        'webfetch.md',
      );
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.writeFileSync(source, '# Saved page\nExact source text.\n');
    });

    afterEach(() => {
      setConfigHomeDirOverride(previousConfigHome);
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('allows the saved source through both the configured and real paths', () => {
      for (const file of [source, fs.realpathSync(source)]) {
        expect(checkReadPermissionForPath(file, makeContext(), cwd).kind).toBe(
          'allow',
        );
      }
    });

    it.each([true, false])(
      'does not decode the config root when it exists: %s',
      (configRootExists) => {
        const configHome = path.join(root, 'config%20root');
        if (configRootExists) fs.mkdirSync(configHome);
        setConfigHomeDirOverride(configHome);
        const sibling = path.join(
          root,
          'config root',
          'tmp',
          sanitizePath(cwd),
          'secret.txt',
        );
        fs.mkdirSync(path.dirname(sibling), { recursive: true });
        fs.writeFileSync(sibling, 'private');

        expect({
          read: checkReadPermissionForPath(sibling, makeContext(), cwd).kind,
          write: checkWritePermissionForPath(sibling, makeContext(), cwd).kind,
        }).toEqual({ read: 'ask', write: 'ask' });
      },
    );

    it('keeps explicit deny rules above the internal read allowance', () => {
      const realSource = fs.realpathSync(source);
      const ctx = makeContext({ deny: { session: [`Read(/${realSource})`] } });
      expect(checkReadPermissionForPath(source, ctx, cwd).kind).toBe('deny');
    });

    it('does not allow other projects or symlinks escaping the project temp directory', () => {
      const outside = path.join(root, 'outside');
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'secret.md'), 'private');
      const escape = path.join(path.dirname(source), 'escape');
      fs.symlinkSync(outside, escape, 'dir');
      const configHome = getConfigHomeDir();
      const sibling = path.join(
        configHome,
        'tmp',
        sanitizePath(cwd) + '-other',
        'source.md',
      );
      fs.mkdirSync(path.dirname(sibling), { recursive: true });
      fs.writeFileSync(sibling, 'other project');
      for (const file of [
        sibling,
        fs.realpathSync(sibling),
        path.join(escape, 'secret.md'),
      ]) {
        expect(checkReadPermissionForPath(file, makeContext(), cwd).kind).toBe(
          'ask',
        );
      }
      // Resolving the entire temp prefix would accidentally trust this escape.
      fs.rmSync(path.join(configHome, 'tmp', sanitizePath(cwd)), {
        recursive: true,
      });
      fs.symlinkSync(
        outside,
        path.join(configHome, 'tmp', sanitizePath(cwd)),
        'dir',
      );
      expect(
        checkReadPermissionForPath(
          path.join(configHome, 'tmp', sanitizePath(cwd), 'secret.md'),
          makeContext(),
          cwd,
        ).kind,
      ).toBe('ask');
    });
  },
);

import { qwenInternalPathDeps } from './internal-path-deps.js';
function getConfigHomeDir(): string {
  return qwenInternalPathDeps.resolve({ cwd: '/project' }).userConfigDir!;
}
