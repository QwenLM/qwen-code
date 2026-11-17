/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveWorkspacePath, WorkspaceContext } from './workspaceContext.js';

/**
 * Creates a fresh temp dir with `subdirs` inside it and returns
 * [tempDir, ...subdir paths]. os.tmpdir() can return a path using a symlink
 * (standard on macOS), so the temp dir is fully resolved with realpathSync.
 */
function makeTempDirs(prefix: string, ...subdirs: string[]): string[] {
  const tempDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
  );
  const dirs = subdirs.map((name) => path.join(tempDir, name));
  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
  return [tempDir, ...dirs];
}

/** Registers a directories-changed spy on `ctx`. */
function listenTo(ctx: WorkspaceContext) {
  const listener = vi.fn();
  ctx.onDirectoriesChanged(listener);
  return listener;
}

describe('WorkspaceContext with real filesystem', () => {
  let tempDir: string;
  let cwd: string;
  let otherDir: string;

  beforeEach(() => {
    [tempDir, cwd, otherDir] = makeTempDirs(
      'workspace-context-test-',
      'project',
      'other-project',
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('initialization', () => {
    it('should initialize with a single directory (cwd)', () => {
      const ctx = new WorkspaceContext(cwd);
      expect(ctx.getDirectories()).toEqual([cwd]);
    });

    it('should validate and resolve directories to absolute paths', () => {
      const ctx = new WorkspaceContext(cwd, [otherDir]);
      expect(ctx.getDirectories()).toEqual([cwd, otherDir]);
    });

    it('should handle empty initialization', () => {
      const directories = new WorkspaceContext(cwd, []).getDirectories();
      expect(directories).toHaveLength(1);
      expect(fs.realpathSync(directories[0])).toBe(cwd);
    });
  });

  describe('adding directories', () => {
    it('should add valid directories', () => {
      const ctx = new WorkspaceContext(cwd);
      ctx.addDirectory(otherDir);
      expect(ctx.getDirectories()).toEqual([cwd, otherDir]);
    });

    it('should resolve relative paths to absolute', () => {
      const ctx = new WorkspaceContext(cwd);
      ctx.addDirectory(path.relative(cwd, otherDir), cwd);
      expect(ctx.getDirectories()).toEqual([cwd, otherDir]);
    });

    it('should prevent duplicate directories', () => {
      const ctx = new WorkspaceContext(cwd);
      ctx.addDirectory(otherDir);
      ctx.addDirectory(otherDir);
      expect(ctx.getDirectories()).toHaveLength(2);
    });

    it('should handle symbolic links correctly', () => {
      const realDir = path.join(tempDir, 'real');
      fs.mkdirSync(realDir, { recursive: true });
      const symlinkDir = path.join(tempDir, 'symlink-to-real');
      fs.symlinkSync(realDir, symlinkDir, 'dir');
      const ctx = new WorkspaceContext(cwd);
      ctx.addDirectory(symlinkDir);

      expect(ctx.getDirectories()).toEqual([cwd, realDir]);
    });
  });

  describe('path validation', () => {
    it('should accept paths within workspace directories', () => {
      const ctx = new WorkspaceContext(cwd, [otherDir]);
      const validPath1 = path.join(cwd, 'src', 'file.ts');
      const validPath2 = path.join(otherDir, 'lib', 'module.js');

      fs.mkdirSync(path.dirname(validPath1), { recursive: true });
      fs.writeFileSync(validPath1, 'content');
      fs.mkdirSync(path.dirname(validPath2), { recursive: true });
      fs.writeFileSync(validPath2, 'content');

      expect(ctx.isPathWithinWorkspace(validPath1)).toBe(true);
      expect(ctx.isPathWithinWorkspace(validPath2)).toBe(true);
    });

    it('should accept non-existent paths within workspace directories', () => {
      const ctx = new WorkspaceContext(cwd, [otherDir]);
      const validPath1 = path.join(cwd, 'src', 'file.ts');
      const validPath2 = path.join(otherDir, 'lib', 'module.js');

      expect(ctx.isPathWithinWorkspace(validPath1)).toBe(true);
      expect(ctx.isPathWithinWorkspace(validPath2)).toBe(true);
    });

    it('should reject non-existent paths outside workspace', () => {
      const ctx = new WorkspaceContext(cwd, [otherDir]);
      const invalidPath = path.join(tempDir, 'outside-workspace', 'file.txt');

      expect(ctx.isPathWithinWorkspace(invalidPath)).toBe(false);
    });

    it('should handle nested directories correctly', () => {
      const ctx = new WorkspaceContext(cwd, [otherDir]);
      const nestedPath = path.join(cwd, 'deeply', 'nested', 'path', 'file.txt');
      expect(ctx.isPathWithinWorkspace(nestedPath)).toBe(true);
    });

    it('should handle edge cases (root, parent references)', () => {
      const ctx = new WorkspaceContext(cwd, [otherDir]);
      const rootPath = path.parse(tempDir).root;
      const parentPath = path.dirname(cwd);

      expect(ctx.isPathWithinWorkspace(rootPath)).toBe(false);
      expect(ctx.isPathWithinWorkspace(parentPath)).toBe(false);
    });

    it('should handle non-existent paths correctly', () => {
      const ctx = new WorkspaceContext(cwd, [otherDir]);
      const nonExistentPath = path.join(cwd, 'does-not-exist.txt');
      expect(ctx.isPathWithinWorkspace(nonExistentPath)).toBe(true);
    });

    it('should preserve paths with missing intermediate components', () => {
      const ctx = new WorkspaceContext(cwd);
      const nonExistentPath = path.join(cwd, 'missing', 'nested.txt');

      expect(resolveWorkspacePath(nonExistentPath)).toBe(nonExistentPath);
      expect(ctx.isPathWithinWorkspace(nonExistentPath)).toBe(true);
    });

    describe('with symbolic link', () => {
      let symlinkDir: string;

      /** Whether a fresh cwd-rooted context accepts a path under the link. */
      const acceptsUnderLink = (...segments: string[]) =>
        new WorkspaceContext(cwd).isPathWithinWorkspace(
          path.join(symlinkDir, ...segments),
        );

      /** Links cwd/symlink-file to a new `real-dir` created under `parent`. */
      const linkRealDirUnder = (parent: string) => {
        const realDir = path.join(parent, 'real-dir');
        fs.mkdirSync(realDir, { recursive: true });

        symlinkDir = path.join(cwd, 'symlink-file');
        fs.symlinkSync(realDir, symlinkDir, 'dir');
      };

      describe('in the workspace', () => {
        beforeEach(() => linkRealDirUnder(cwd));

        it('should accept dir paths', () => {
          expect(acceptsUnderLink()).toBe(true);
        });

        it('should accept non-existent paths', () => {
          expect(acceptsUnderLink('does-not-exist.txt')).toBe(true);
        });

        it('should accept non-existent deep paths', () => {
          expect(acceptsUnderLink('deep', 'does-not-exist.txt')).toBe(true);
        });
      });

      describe('outside the workspace', () => {
        beforeEach(() => linkRealDirUnder(tempDir));

        it('should reject dir paths', () => {
          expect(acceptsUnderLink()).toBe(false);
        });

        it('should reject non-existent paths', () => {
          expect(acceptsUnderLink('does-not-exist.txt')).toBe(false);
        });

        it('should reject non-existent deep paths', () => {
          expect(acceptsUnderLink('deep', 'does-not-exist.txt')).toBe(false);
        });

        it('should reject partially non-existent deep paths', () => {
          fs.mkdirSync(path.join(symlinkDir, 'deep'), { recursive: true });
          expect(acceptsUnderLink('deep', 'does-not-exist.txt')).toBe(false);
        });
      });

      it('should reject symbolic file links outside the workspace', () => {
        const realFile = path.join(tempDir, 'real-file.txt');
        fs.writeFileSync(realFile, 'content');

        const symlinkFile = path.join(cwd, 'symlink-to-real-file');
        fs.symlinkSync(realFile, symlinkFile, 'file');

        const ctx = new WorkspaceContext(cwd);

        expect(ctx.isPathWithinWorkspace(symlinkFile)).toBe(false);
      });

      it('should reject non-existent symbolic file links outside the workspace', () => {
        const realFile = path.join(tempDir, 'real-file.txt');

        const symlinkFile = path.join(cwd, 'symlink-to-real-file');
        fs.symlinkSync(realFile, symlinkFile, 'file');

        const ctx = new WorkspaceContext(cwd);

        expect(ctx.isPathWithinWorkspace(symlinkFile)).toBe(false);
      });

      it('should handle circular symlinks gracefully', () => {
        const ctx = new WorkspaceContext(cwd);
        const linkA = path.join(cwd, 'link-a');
        const linkB = path.join(cwd, 'link-b');
        // Create a circular dependency: linkA -> linkB -> linkA
        fs.symlinkSync(linkB, linkA, 'dir');
        fs.symlinkSync(linkA, linkB, 'dir');

        // fs.realpathSync should throw ELOOP, and isPathWithinWorkspace should
        // handle it gracefully and return false.
        expect(ctx.isPathWithinWorkspace(linkA)).toBe(false);
        expect(ctx.isPathWithinWorkspace(linkB)).toBe(false);
      });
    });
  });

  describe('onDirectoriesChanged', () => {
    it('should call listener when adding a directory', () => {
      const ctx = new WorkspaceContext(cwd);
      const listener = listenTo(ctx);

      ctx.addDirectory(otherDir);

      expect(listener).toHaveBeenCalledOnce();
    });

    it('should not call listener when adding a duplicate directory', () => {
      const ctx = new WorkspaceContext(cwd);
      ctx.addDirectory(otherDir);
      const listener = listenTo(ctx);

      ctx.addDirectory(otherDir);

      expect(listener).not.toHaveBeenCalled();
    });

    it('should call listener when setting different directories', () => {
      const ctx = new WorkspaceContext(cwd);
      const listener = listenTo(ctx);

      ctx.setDirectories([otherDir]);

      expect(listener).toHaveBeenCalledOnce();
    });

    it('should not call listener when setting same directories', () => {
      const ctx = new WorkspaceContext(cwd);
      const listener = listenTo(ctx);

      ctx.setDirectories([cwd]);

      expect(listener).not.toHaveBeenCalled();
    });

    it('should support multiple listeners', () => {
      const ctx = new WorkspaceContext(cwd);
      const listener1 = listenTo(ctx);
      const listener2 = listenTo(ctx);

      ctx.addDirectory(otherDir);

      expect(listener1).toHaveBeenCalledOnce();
      expect(listener2).toHaveBeenCalledOnce();
    });

    it('should allow unsubscribing a listener', () => {
      const ctx = new WorkspaceContext(cwd);
      const listener = vi.fn();
      const unsubscribe = ctx.onDirectoriesChanged(listener);

      unsubscribe();
      ctx.addDirectory(otherDir);

      expect(listener).not.toHaveBeenCalled();
    });

    it('should not fail if a listener throws an error', () => {
      const ctx = new WorkspaceContext(cwd);
      ctx.onDirectoriesChanged(() => {
        throw new Error('test error');
      });
      const listener = listenTo(ctx);

      expect(() => {
        ctx.addDirectory(otherDir);
      }).not.toThrow();
      expect(listener).toHaveBeenCalledOnce();
    });
  });

  describe('getDirectories', () => {
    it('should return a copy of directories array', () => {
      const ctx = new WorkspaceContext(cwd);
      const dirs1 = ctx.getDirectories();
      const dirs2 = ctx.getDirectories();

      expect(dirs1).not.toBe(dirs2);
      expect(dirs1).toEqual(dirs2);
    });
  });

  describe('applyRootDirectories', () => {
    it('should preserve runtime-added directories when changing roots', () => {
      const runtimeDir = path.join(tempDir, 'runtime-added');
      const nextRoot = path.join(tempDir, 'next-project');
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.mkdirSync(nextRoot, { recursive: true });

      const ctx = new WorkspaceContext(cwd);
      ctx.addDirectory(runtimeDir);

      ctx.applyRootDirectories(
        WorkspaceContext.resolveRootDirectories(nextRoot),
      );

      expect(ctx.getDirectories()).toEqual([nextRoot, runtimeDir]);
      expect(ctx.getInitialDirectories()).toEqual([nextRoot]);
      expect(ctx.removeDirectory(runtimeDir)).toBe(true);
      expect(ctx.removeDirectory(nextRoot)).toBe(false);
    });
  });
});

describe('WorkspaceContext with optional directories', () => {
  let tempDir: string;
  let cwd: string;
  let existingDir1: string;
  let nonExistentDir: string;

  beforeEach(() => {
    [tempDir, cwd, existingDir1] = makeTempDirs(
      'workspace-context-optional-',
      'project',
      'existing-dir-1',
      'existing-dir-2',
    );
    nonExistentDir = path.join(tempDir, 'non-existent-dir');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should skip a missing optional directory', () => {
    const ctx = new WorkspaceContext(cwd, [nonExistentDir, existingDir1]);
    expect(ctx.getDirectories()).toEqual([cwd, existingDir1]);
  });

  it('should include an existing optional directory', () => {
    const ctx = new WorkspaceContext(cwd, [existingDir1]);
    expect(ctx.getDirectories()).toEqual([cwd, existingDir1]);
  });
});

describe('WorkspaceContext removeDirectory', () => {
  let tempDir: string;
  let cwd: string;
  let addedDir: string;

  beforeEach(() => {
    [tempDir, cwd, addedDir] = makeTempDirs(
      'workspace-context-remove-',
      'project',
      'added',
      'another',
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should remove a runtime-added directory', () => {
    const ctx = new WorkspaceContext(cwd);
    ctx.addDirectory(addedDir);
    expect(ctx.getDirectories()).toContain(addedDir);

    expect(ctx.removeDirectory(addedDir)).toBe(true);
    expect(ctx.getDirectories()).not.toContain(addedDir);
  });

  it('should not remove the initial cwd directory', () => {
    const ctx = new WorkspaceContext(cwd, [addedDir]);
    // Only cwd is truly initial (non-removable)
    expect(ctx.removeDirectory(cwd)).toBe(false);
    expect(ctx.getDirectories()).toContain(cwd);
  });

  it('should allow removing an additional directory passed at construction', () => {
    const ctx = new WorkspaceContext(cwd, [addedDir]);
    // additionalDirectories are NOT initial — they can be removed
    expect(ctx.removeDirectory(addedDir)).toBe(true);
    expect(ctx.getDirectories()).not.toContain(addedDir);
  });

  it('should return false for non-existent directory', () => {
    const ctx = new WorkspaceContext(cwd);
    expect(ctx.removeDirectory('/non/existent/path')).toBe(false);
  });

  it('should notify listeners when a directory is removed', () => {
    const ctx = new WorkspaceContext(cwd);
    ctx.addDirectory(addedDir);

    const listener = listenTo(ctx);

    ctx.removeDirectory(addedDir);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('should not notify listeners when removal fails', () => {
    const ctx = new WorkspaceContext(cwd);

    const listener = listenTo(ctx);

    ctx.removeDirectory(addedDir); // not in workspace
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('WorkspaceContext isInitialDirectory', () => {
  let tempDir: string;
  let cwd: string;
  let additionalDir: string;
  let runtimeDir: string;

  beforeEach(() => {
    [tempDir, cwd, additionalDir, runtimeDir] = makeTempDirs(
      'workspace-context-initial-',
      'project',
      'additional',
      'runtime',
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should return true for the initial cwd directory', () => {
    const ctx = new WorkspaceContext(cwd);
    expect(ctx.isInitialDirectory(cwd)).toBe(true);
  });

  it('should return false for an additional directory passed at construction', () => {
    const ctx = new WorkspaceContext(cwd, [additionalDir]);
    // additionalDirectories are no longer considered 'initial'
    expect(ctx.isInitialDirectory(additionalDir)).toBe(false);
  });

  it('should return false for a runtime-added directory', () => {
    const ctx = new WorkspaceContext(cwd);
    ctx.addDirectory(runtimeDir);
    expect(ctx.isInitialDirectory(runtimeDir)).toBe(false);
  });

  it('should return false for a directory not in the workspace', () => {
    const ctx = new WorkspaceContext(cwd);
    expect(ctx.isInitialDirectory('/some/random/path')).toBe(false);
  });
});
