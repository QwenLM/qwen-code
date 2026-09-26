/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  loadServerHierarchicalMemory,
  formatContextFileDisplayPath,
} from './memoryDiscovery.js';
import {
  setMemoryFilename,
  DEFAULT_CONTEXT_FILENAME,
  LOCAL_CONTEXT_FILENAME,
} from '../utils/memory-constants.js';
import { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import { QWEN_DIR } from '../utils/paths.js';
import type {
  InstructionsLoadedNotification,
  LoadServerHierarchicalMemoryOptions,
} from './memoryDiscovery.js';

const mockLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => mockLogger,
}));

vi.mock('os', async (importOriginal) => {
  const actualOs = await importOriginal<typeof os>();
  return {
    ...actualOs,
    homedir: vi.fn(),
  };
});

interface LoadArgs {
  from?: string;
  include?: string[];
  root?: string;
  extensions?: string[];
  trusted?: boolean;
  options?: LoadServerHierarchicalMemoryOptions;
}

const started = (
  filePath: string,
  memoryType: InstructionsLoadedNotification['memoryType'],
  loadReason: InstructionsLoadedNotification['loadReason'] = 'session_start',
) => ({ filePath, memoryType, loadReason });
const imported = (
  filePath: string,
  memoryType: InstructionsLoadedNotification['memoryType'],
  triggerFilePath: string,
  parentFilePath: string,
) =>
  expect.objectContaining({
    filePath,
    memoryType,
    loadReason: 'include',
    triggerFilePath,
    parentFilePath,
  });
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe('loadServerHierarchicalMemory', () => {
  const DEFAULT_FOLDER_TRUST = true;
  let testRootDir: string;
  let cwd: string;
  let projectRoot: string;
  let homedir: string;

  async function createEmptyDir(fullPath: string) {
    await fsPromises.mkdir(fullPath, { recursive: true });
    return fullPath;
  }

  async function createTestFile(fullPath: string, fileContents: string) {
    await fsPromises.mkdir(path.dirname(fullPath), { recursive: true });
    await fsPromises.writeFile(fullPath, fileContents);
    return path.resolve(testRootDir, fullPath);
  }

  // Context file `name` (QWEN.md by default) in `dir`.
  const writeContext = (
    dir: string,
    text: string,
    name = DEFAULT_CONTEXT_FILENAME,
  ) => createTestFile(path.join(dir, name), text);
  const writeGlobal = (text: string, name = DEFAULT_CONTEXT_FILENAME) =>
    writeContext(path.join(homedir, QWEN_DIR), text, name);
  const writeLocal = (text: string, dir = projectRoot) =>
    writeContext(path.join(dir, QWEN_DIR), text, LOCAL_CONTEXT_FILENAME);
  const writeRule = () =>
    createTestFile(
      path.join(projectRoot, QWEN_DIR, 'rules', 'baseline.md'),
      'project rule',
    );
  const linkContext = (targetDir: string, linkDir: string) =>
    fsPromises.symlink(
      path.join(targetDir, DEFAULT_CONTEXT_FILENAME),
      path.join(linkDir, DEFAULT_CONTEXT_FILENAME),
    );

  // Loads from `from` (default cwd) with a file service rooted at `root`
  // (default projectRoot). `options` selects the full 8-argument form
  // ('tree' imports, no rule excludes); otherwise only 5 arguments are passed.
  function load({
    from = cwd,
    include = [],
    root = projectRoot,
    extensions = [],
    trusted = DEFAULT_FOLDER_TRUST,
    options,
  }: LoadArgs = {}) {
    const service = new FileDiscoveryService(root);
    return options
      ? loadServerHierarchicalMemory(
          from,
          include,
          service,
          extensions,
          trusted,
          'tree',
          [],
          options,
        )
      : loadServerHierarchicalMemory(
          from,
          include,
          service,
          extensions,
          trusted,
        );
  }

  async function notificationsFrom(args: LoadArgs = {}) {
    const notifications: InstructionsLoadedNotification[] = [];
    await load({
      ...args,
      options: {
        ...args.options,
        onInstructionsLoaded: (notification) => {
          notifications.push(notification);
        },
      },
    });
    return notifications;
  }

  const rel = (file: string) => path.relative(cwd, file);
  const tilde = (file: string) => path.join('~', path.relative(homedir, file));
  // The complete result for these [file, text] context blocks, in order.
  const loaded = (
    blocks: Array<[string, string]>,
    contextFilePaths = blocks.map(([file]) => rel(file)),
  ) => ({
    memoryContent: blocks
      .map(
        ([file, text]) =>
          `--- Context from: ${rel(file)} ---\n${text}\n--- End of Context from: ${rel(file)} ---`,
      )
      .join('\n\n'),
    fileCount: blocks.length,
    contextFilePaths,
    ruleCount: 0,
    conditionalRules: [],
    projectRoot: expect.any(String),
  });

  beforeEach(async () => {
    testRootDir = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), 'folder-structure-test-'),
    );

    vi.resetAllMocks();
    // Set environment variables to indicate test environment
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('VITEST', 'true');

    projectRoot = await createEmptyDir(path.join(testRootDir, 'project'));
    cwd = await createEmptyDir(path.join(projectRoot, 'src'));
    homedir = await createEmptyDir(path.join(testRootDir, 'userhome'));
    vi.mocked(os.homedir).mockReturnValue(homedir);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    // Some tests set this to a different value.
    setMemoryFilename(DEFAULT_CONTEXT_FILENAME);
    // Remove the temp dir; maxRetries makes cleanup robust against races.
    await fsPromises.rm(testRootDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  });

  describe('when untrusted', () => {
    it('does not load context files from untrusted workspaces', async () => {
      await writeContext(projectRoot, 'Project root memory');
      await writeContext(cwd, 'Src directory memory');
      const { fileCount } = await load({ trusted: false });

      expect(fileCount).toEqual(0);
    });

    it('loads context from outside the untrusted workspace', async () => {
      await writeContext(projectRoot, 'Project root memory'); // Untrusted
      await writeContext(cwd, 'Src directory memory'); // Untrusted
      // In user home dir (outside untrusted space).
      const filepath = await writeGlobal('default context content');
      const { fileCount, memoryContent } = await load({ trusted: false });

      expect(fileCount).toEqual(1);
      expect(memoryContent).toContain(path.relative(cwd, filepath).toString());
    });
  });

  it('should return empty memory and count if no context files are found', async () => {
    const result = await load();

    expect(result).toEqual(loaded([]));
  });

  it('should skip implicit global, project, and rule discovery in explicit-only mode', async () => {
    await writeGlobal('global context');
    await writeContext(projectRoot, 'project context');
    await writeContext(cwd, 'cwd context');
    await writeRule();

    const result = await load({ options: { explicitOnly: true } });

    expect(result).toEqual(loaded([]));
  });

  it('should still load context from explicit include directories in explicit-only mode', async () => {
    const extraDir = await createEmptyDir(path.join(testRootDir, 'explicit'));
    const explicitFile = await writeContext(extraDir, 'explicit context');
    await writeGlobal('global context');
    await writeContext(projectRoot, 'project context');
    await writeRule();

    const result = await load({
      include: [extraDir],
      options: { explicitOnly: true },
    });

    expect(result).toEqual(loaded([[explicitFile, 'explicit context']]));
  });

  it('should load only the global context file if present and others are not (default filename)', async () => {
    const defaultContextFile = await writeGlobal('default context content');

    const result = await load();

    expect(result).toEqual(
      loaded(
        [[defaultContextFile, 'default context content']],
        [tilde(defaultContextFile)],
      ),
    );
  });

  it('should load only the global custom context file if present and filename is changed', async () => {
    const customFilename = 'CUSTOM_AGENTS.md';
    setMemoryFilename(customFilename);

    const customContextFile = await writeGlobal(
      'custom context content',
      customFilename,
    );

    const result = await load();

    expect(result).toEqual(
      loaded(
        [[customContextFile, 'custom context content']],
        [tilde(customContextFile)],
      ),
    );
  });

  it('should load context files by upward traversal with custom filename', async () => {
    const customFilename = 'PROJECT_CONTEXT.md';
    setMemoryFilename(customFilename);

    const projectContextFile = await writeContext(
      projectRoot,
      'project context content',
      customFilename,
    );
    const cwdContextFile = await writeContext(
      cwd,
      'cwd context content',
      customFilename,
    );

    const result = await load();

    expect(result).toEqual(
      loaded([
        [projectContextFile, 'project context content'],
        [cwdContextFile, 'cwd context content'],
      ]),
    );
  });

  it('should load context files from CWD with custom filename (not subdirectories)', async () => {
    const customFilename = 'LOCAL_CONTEXT.md';
    setMemoryFilename(customFilename);

    await writeContext(
      path.join(cwd, 'subdir'),
      'Subdir custom memory',
      customFilename,
    );
    const cwdFile = await writeContext(
      cwd,
      'CWD custom memory',
      customFilename,
    );

    const result = await load();

    // Only upward traversal is performed, subdirectory files are not loaded
    expect(result).toEqual(loaded([[cwdFile, 'CWD custom memory']]));
  });

  it('should load context files by upward traversal with default filename', async () => {
    const projectRootMemoryFile = await writeContext(
      projectRoot,
      'Project root memory',
    );
    const srcMemoryFile = await writeContext(cwd, 'Src directory memory');

    const result = await load();

    expect(result).toEqual(
      loaded([
        [projectRootMemoryFile, 'Project root memory'],
        [srcMemoryFile, 'Src directory memory'],
      ]),
    );
  });

  it('should only load context files from CWD, not subdirectories', async () => {
    await writeContext(path.join(cwd, 'subdir'), 'Subdir memory');
    const cwdFile = await writeContext(cwd, 'CWD memory');

    const result = await load();

    // Subdirectory files are not loaded, only CWD and upward
    expect(result).toEqual(loaded([[cwdFile, 'CWD memory']]));
  });

  it('should load and correctly order global and upward context files', async () => {
    const defaultContextFile = await writeGlobal('default context content');
    const rootMemoryFile = await writeContext(
      testRootDir,
      'Project parent memory',
    );
    const projectRootMemoryFile = await writeContext(
      projectRoot,
      'Project root memory',
    );
    const cwdMemoryFile = await writeContext(cwd, 'CWD memory');
    await writeContext(path.join(cwd, 'sub'), 'Subdir memory');

    const result = await load();

    // Subdirectory files are not loaded, only global and upward from CWD
    expect(result).toEqual(
      loaded(
        [
          [defaultContextFile, 'default context content'],
          [rootMemoryFile, 'Project parent memory'],
          [projectRootMemoryFile, 'Project root memory'],
          [cwdMemoryFile, 'CWD memory'],
        ],
        [
          tilde(defaultContextFile),
          rel(rootMemoryFile),
          rel(projectRootMemoryFile),
          rel(cwdMemoryFile),
        ],
      ),
    );
  });

  it('should load extension context file paths', async () => {
    const extensionFilePath = await createTestFile(
      path.join(testRootDir, 'extensions/ext1/QWEN.md'),
      'Extension memory content',
    );

    const result = await load({ extensions: [extensionFilePath] });

    expect(result).toEqual(
      loaded([[extensionFilePath, 'Extension memory content']]),
    );
  });

  it('announces extension context files with custom basenames', async () => {
    const extensionFilePath = await createTestFile(
      path.join(testRootDir, 'extensions/ext1/system-prompt.md'),
      'Extension custom context content',
    );

    const result = await load({ extensions: [extensionFilePath] });

    // The file is attached by concatenateInstructions even though its
    // basename is not a configured memory filename, so it must be announced.
    expect(result.fileCount).toBe(0);
    expect(result.memoryContent).toContain('Extension custom context content');
    expect(result.contextFilePaths).toEqual([
      path.relative(cwd, extensionFilePath),
    ]);
  });

  it('counts but does not announce whitespace-only context files', async () => {
    await writeContext(cwd, '   \n\t ');

    const result = await load();

    // The file is discovered, but its blank content never reaches the system
    // prompt, so it must not be announced as attached.
    expect(result.fileCount).toBe(1);
    expect(result.memoryContent).toBe('');
    expect(result.contextFilePaths).toEqual([]);
  });

  it('notifies when startup instruction files are loaded', async () => {
    const globalFile = await writeGlobal('global context');
    const projectFile = await writeContext(projectRoot, 'project context');
    const extensionFile = await createTestFile(
      path.join(testRootDir, 'extensions/ext1/QWEN.md'),
      'extension context',
    );

    const notifications = await notificationsFrom({
      extensions: [extensionFile],
    });

    expect(notifications).toEqual(
      expect.arrayContaining([
        started(globalFile, 'user'),
        started(projectFile, 'project'),
        started(extensionFile, 'extension'),
      ]),
    );
  });

  it('uses refresh load reason for explicit memory refreshes', async () => {
    const projectFile = await writeContext(projectRoot, 'project context');

    const notifications = await notificationsFrom({
      options: { loadReason: 'refresh' },
    });

    expect(notifications).toEqual(
      expect.arrayContaining([started(projectFile, 'project', 'refresh')]),
    );
  });

  it('classifies home-directory project files as project memory', async () => {
    await createEmptyDir(path.join(homedir, '.git'));
    const globalFile = await writeGlobal('global context');
    const projectFile = await writeContext(homedir, 'home project context');

    const notifications = await notificationsFrom({
      from: homedir,
      root: homedir,
    });

    expect(notifications).toContainEqual(started(globalFile, 'user'));
    expect(notifications).toContainEqual(started(projectFile, 'project'));
  });

  it('notifies when imported instruction files are loaded', async () => {
    await createEmptyDir(path.join(projectRoot, '.git'));
    const importedFile = await createTestFile(
      path.join(projectRoot, 'included.md'),
      'included content',
    );
    const projectFile = await writeContext(
      projectRoot,
      'project context @./included.md',
    );

    const notifications = await notificationsFrom();

    expect(notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining(started(projectFile, 'project')),
        imported(importedFile, 'project', projectFile, projectFile),
      ]),
    );
    expect(
      notifications.findIndex((item) => item.filePath === projectFile),
    ).toBeGreaterThan(
      notifications.findIndex((item) => item.filePath === importedFile),
    );
  });

  it('inherits memory type from the importing instruction file', async () => {
    const importedFile = await createTestFile(
      path.join(homedir, 'rules', 'personal.md'),
      'personal included content',
    );
    const userFile = await writeContext(
      homedir,
      'user context @./rules/personal.md',
    );

    const notifications = await notificationsFrom({ from: homedir });

    expect(notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining(started(userFile, 'user')),
        imported(importedFile, 'user', userFile, userFile),
      ]),
    );
  });

  it('inherits memory type from the root instruction file for nested imports', async () => {
    const nestedFile = await createTestFile(
      path.join(homedir, 'rules', 'nested.md'),
      'nested included content',
    );
    const importedFile = await createTestFile(
      path.join(homedir, 'rules', 'personal.md'),
      'personal included content @./nested.md',
    );
    const userFile = await writeContext(
      homedir,
      'user context @./rules/personal.md',
    );

    const notifications = await notificationsFrom({ from: homedir });

    expect(notifications).toEqual(
      expect.arrayContaining([
        imported(nestedFile, 'user', userFile, importedFile),
      ]),
    );
  });

  it('reports the root trigger and immediate parent for nested imports', async () => {
    await createEmptyDir(path.join(projectRoot, '.git'));
    const grandchildFile = await createTestFile(
      path.join(projectRoot, 'grandchild.md'),
      'grandchild content',
    );
    const childFile = await createTestFile(
      path.join(projectRoot, 'child.md'),
      'child content @./grandchild.md',
    );
    const projectFile = await writeContext(
      projectRoot,
      'project context @./child.md',
    );

    const notifications = await notificationsFrom();

    // The grandchild is imported by child.md, but the chain was started by the
    // top-level discovered QWEN.md, so trigger != parent at depth > 1.
    expect(notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filePath: grandchildFile,
          loadReason: 'include',
          triggerFilePath: projectFile,
          parentFilePath: childFile,
        }),
      ]),
    );
  });

  it('classifies extension-owned imports as extension memory', async () => {
    const extensionDir = path.join(testRootDir, 'extensions/ext1');
    const importedFile = await createTestFile(
      path.join(extensionDir, 'included.md'),
      'extension included content',
    );
    const extensionFile = await writeContext(
      extensionDir,
      'extension context @./included.md',
    );

    const notifications = await notificationsFrom({
      extensions: [extensionFile],
    });

    expect(notifications).toEqual(
      expect.arrayContaining([
        imported(importedFile, 'extension', extensionFile, extensionFile),
      ]),
    );
  });

  it('still loads memory when instruction load notification fails', async () => {
    const projectFile = await writeContext(projectRoot, 'project context');

    const result = await load({
      options: {
        onInstructionsLoaded: () => {
          throw new Error('hook failed');
        },
      },
    });

    expect(result.fileCount).toBe(1);
    expect(result.memoryContent).toContain(
      `--- Context from: ${path.relative(cwd, projectFile)} ---\nproject context`,
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      `InstructionsLoaded notification failed for ${projectFile}: hook failed`,
    );
  });

  it('should load memory from included directories', async () => {
    const includedDir = await createEmptyDir(
      path.join(testRootDir, 'included'),
    );
    const includedFile = await writeContext(
      includedDir,
      'included directory memory',
    );

    const result = await load({ include: [includedDir] });

    expect(result).toEqual(
      loaded([[includedFile, 'included directory memory']]),
    );
  });

  it('should handle multiple directories and files in parallel correctly', async () => {
    // Create multiple test directories with GEMINI.md files
    const numDirs = 5;
    const createdFiles: string[] = [];

    for (let i = 0; i < numDirs; i++) {
      const dirPath = await createEmptyDir(
        path.join(testRootDir, `project-${i}`),
      );
      createdFiles.push(
        await writeContext(dirPath, `Content from project ${i}`),
      );
    }

    // Load memory from all directories
    const result = await load({
      include: createdFiles.map((f) => path.dirname(f)),
    });

    // Should have loaded all files
    expect(result.fileCount).toBe(numDirs);

    // Content should include all project contents
    for (let i = 0; i < numDirs; i++) {
      expect(result.memoryContent).toContain(`Content from project ${i}`);
    }
  });

  it('should preserve order and prevent duplicates when processing multiple directories', async () => {
    // Create overlapping directory structure
    const parentDir = await createEmptyDir(path.join(testRootDir, 'parent'));
    const childDir = await createEmptyDir(path.join(parentDir, 'child'));

    await writeContext(parentDir, 'Parent content');
    await writeContext(childDir, 'Child content');

    // Include both parent and child directories
    const result = await load({
      from: parentDir,
      include: [childDir, parentDir], // Deliberately include duplicates
    });

    // Should have both files without duplicates
    expect(result.fileCount).toBe(2);
    expect(result.memoryContent).toContain('Parent content');
    expect(result.memoryContent).toContain('Child content');

    // Check that files are not duplicated
    expect(count(result.memoryContent, 'Parent content')).toBe(1);
    expect(count(result.memoryContent, 'Child content')).toBe(1);
  });

  describe('QWEN.local.md (project-local context file)', () => {
    // The local-context-file slot is anchored at `<projectRoot>/.qwen/`, where
    // projectRoot is the nearest ancestor containing a `.git` directory OR a
    // `.git` file (the latter is how git worktrees and submodules are marked).
    // Most tests in this block use the directory form; a few below cover the
    // file form and the no-project-root case explicitly.
    beforeEach(async () => {
      await createEmptyDir(path.join(projectRoot, '.git'));
    });
    const removeGitDir = () =>
      fsPromises.rm(path.join(projectRoot, '.git'), {
        recursive: true,
        force: true,
      });

    it('loads .qwen/QWEN.local.md from project root when present', async () => {
      const localFile = await writeLocal('local context content');

      const result = await load();

      expect(result.fileCount).toBe(1);
      expect(result.memoryContent).toContain(
        `--- Context from: ${path.relative(cwd, localFile)} ---\nlocal context content`,
      );
    });

    it('notifies when QWEN.local.md is loaded', async () => {
      const localFile = await writeLocal('local context content');

      const notifications = await notificationsFrom();

      expect(notifications).toEqual(
        expect.arrayContaining([started(localFile, 'local')]),
      );
    });

    it('orders QWEN.local.md after the project-root QWEN.md', async () => {
      const projectFile = await writeContext(
        projectRoot,
        'shared project context',
      );
      const localFile = await writeLocal('local override');

      const result = await load();

      expect(result.fileCount).toBe(2);
      const projectIdx = result.memoryContent.indexOf(rel(projectFile));
      const localIdx = result.memoryContent.indexOf(rel(localFile));
      expect(projectIdx).toBeGreaterThanOrEqual(0);
      expect(localIdx).toBeGreaterThan(projectIdx);
    });

    it('orders QWEN.local.md after upward-traversed CWD QWEN.md', async () => {
      const projectFile = await writeContext(
        projectRoot,
        'project root memory',
      );
      const cwdFile = await writeContext(cwd, 'cwd memory');
      const localFile = await writeLocal('local memory');

      const result = await load();

      expect(result.fileCount).toBe(3);
      const projectIdx = result.memoryContent.indexOf(rel(projectFile));
      const cwdIdx = result.memoryContent.indexOf(rel(cwdFile));
      const localIdx = result.memoryContent.indexOf(rel(localFile));
      expect(projectIdx).toBeGreaterThanOrEqual(0);
      expect(cwdIdx).toBeGreaterThan(projectIdx);
      expect(localIdx).toBeGreaterThan(cwdIdx);
    });

    it('silently ignores absent .qwen/QWEN.local.md', async () => {
      await writeContext(projectRoot, 'project content');

      const result = await load();

      expect(result.fileCount).toBe(1);
      expect(result.memoryContent).toContain('project content');
      expect(result.memoryContent).not.toContain('QWEN.local.md');
    });

    it('does not load QWEN.local.md from untrusted workspaces', async () => {
      await writeLocal('local content');

      const { fileCount, memoryContent } = await load({ trusted: false });

      expect(fileCount).toBe(0);
      expect(memoryContent).not.toContain('local content');
    });

    it('does not load QWEN.local.md in explicit-only mode', async () => {
      await writeLocal('local content');

      const result = await load({ options: { explicitOnly: true } });

      expect(result.fileCount).toBe(0);
      expect(result.memoryContent).not.toContain('local content');
    });

    it('does not search .qwen/QWEN.local.md in CWD subdirectories', async () => {
      // A `.qwen/QWEN.local.md` in a nested directory (not the project root)
      // must NOT be picked up: the slot is single, fixed, and lives at
      // <projectRoot>/.qwen/QWEN.local.md.
      await writeLocal('misplaced local content', cwd);

      const result = await load();

      expect(result.fileCount).toBe(0);
      expect(result.memoryContent).not.toContain('misplaced local content');
    });

    it('loads QWEN.local.md even when no project QWEN.md exists', async () => {
      const localFile = await writeLocal('standalone local');

      const result = await load();

      expect(result.fileCount).toBe(1);
      expect(result.memoryContent).toContain(
        `--- Context from: ${path.relative(cwd, localFile)} ---\nstandalone local`,
      );
    });

    it('loads QWEN.local.md when project root is marked by a .git FILE (worktree / submodule layout)', async () => {
      // Worktrees and submodules mark the repo root with a `.git` file
      // (`gitdir: <path>`), not a directory. The loader must accept it as a
      // project root, otherwise `<cwd>` is a silent fallback and the
      // documented project-root slot never loads. Replace beforeEach's
      // directory with a file.
      await removeGitDir();
      await fsPromises.writeFile(
        path.join(projectRoot, '.git'),
        'gitdir: /elsewhere/worktrees/feature/.git\n',
      );

      const localFile = await writeLocal('worktree local');

      const result = await load();

      expect(result.fileCount).toBe(1);
      expect(result.memoryContent).toContain(
        `--- Context from: ${path.relative(cwd, localFile)} ---\nworktree local`,
      );
    });

    it('skips QWEN.local.md when no project root can be found (no .git ancestor)', async () => {
      // Without a project root, falling back to cwd would silently turn the
      // single fixed slot into a per-cwd file, the opposite of the design.
      // Pin "skip" so a future regression can't reintroduce the fallback.
      await removeGitDir();

      await writeLocal('cwd-anchored local that must not load', cwd);
      await writeLocal('projectRoot-anchored local that must not load either');

      const result = await load();

      expect(result.fileCount).toBe(0);
      expect(result.memoryContent).not.toContain(
        'cwd-anchored local that must not load',
      );
      expect(result.memoryContent).not.toContain(
        'projectRoot-anchored local that must not load either',
      );
    });

    it('skips QWEN.local.md when cwd === homedir without .git (avoids global-dir collision)', async () => {
      // With cwd at the home directory and no `.git` there, the would-be slot
      // resolves to `<homedir>/.qwen/QWEN.local.md`, i.e. inside the GLOBAL
      // Qwen dir. Loading that as a project-local override is wrong: there
      // is no project. Pin the "skip" behavior.
      await removeGitDir();
      await writeLocal('do not promote this to project-local', homedir);

      const result = await load({ from: homedir, root: homedir }); // cwd === homedir

      // Global QWEN.md / AGENTS.md in ~/.qwen/ may still load via global
      // discovery; the narrow claim is that the LOCAL slot did not.
      expect(result.memoryContent).not.toContain(
        'do not promote this to project-local',
      );
    });

    it('dedupes when an extension registers the local slot path explicitly', async () => {
      // The hierarchical scan iterates `getAllMemoryFilenames()` (QWEN.md /
      // AGENTS.md) and never yields a `QWEN.local.md` path, so the slot
      // loader's dedup guard looks unreachable. It IS reachable via
      // `extensionContextFilePaths`: an extension may register the slot path,
      // which the scan then picks up via the extension-paths append. The
      // guard stops the slot loader appending the same file again (double
      // content + inflated fileCount). Pin that behavior.
      const localFile = await writeLocal('slot content only once');

      // The extension explicitly registers the slot path.
      const result = await load({ extensions: [localFile] });

      expect(result.fileCount).toBe(1);
      expect(count(result.memoryContent, 'slot content only once')).toBe(1);
    });
  });

  describe('symlink aliases of the same physical file (#9597)', () => {
    it('loads a context file once when a workspace-level file is a symlink to an ancestor file', async () => {
      await writeContext(projectRoot, 'shared symlink marker content');
      await linkContext(projectRoot, cwd);

      const result = await load();

      expect(result.fileCount).toBe(1);
      expect(result.contextFilePaths).toHaveLength(1);
      expect(count(result.memoryContent, 'shared symlink marker content')).toBe(
        1,
      );
    });

    it('keeps two context blocks for distinct physical files with identical content', async () => {
      const text = 'identical content in two physical files';
      await writeContext(projectRoot, text);
      await writeContext(cwd, text);

      const result = await load();

      expect(result.fileCount).toBe(2);
      expect(count(result.memoryContent, text)).toBe(2);
    });

    it('still loads through a symlink when the target is outside the project-root scan boundary', async () => {
      // A .git marker makes cwd the project root, so the upward scan stops
      // at its parent and never reaches testRootDir. The outside file can
      // then only be loaded through the workspace symlink.
      await createEmptyDir(path.join(cwd, '.git'));
      await writeContext(testRootDir, 'outside scan boundary marker');
      await linkContext(testRootDir, cwd);

      const result = await load({ root: cwd });

      expect(result.fileCount).toBe(1);
      expect(result.memoryContent).toContain('outside scan boundary marker');
    });

    it('does not duplicate relative @imports of a file loaded through a symlink alias', async () => {
      // The import target resolves from both directories, so while the parent
      // file is loaded twice (once per lexical alias) its @import content is
      // attached twice as well.
      await createTestFile(
        path.join(projectRoot, 'shared.md'),
        'imported-once marker',
      );
      await createTestFile(path.join(cwd, 'shared.md'), 'imported-once marker');
      await writeContext(projectRoot, '@shared.md');
      await linkContext(projectRoot, cwd);

      const result = await load();

      expect(count(result.memoryContent, 'imported-once marker')).toBe(1);
    });
  });
});

describe('formatContextFileDisplayPath', () => {
  // Fixtures share one volume (os.tmpdir()) so `..` relationships hold on
  // every platform; POSIX literals like '/proj' behave differently under
  // path.win32 and would fail the Windows merge-queue gate.
  const root = os.tmpdir();
  const proj = path.join(root, 'proj');
  const other = path.join(root, 'other');
  const home = path.join(root, 'u');
  const siblingHome = path.join(root, 'u2');

  beforeEach(() => {
    vi.mocked(os.homedir).mockReturnValue(home);
  });

  it('returns CWD-relative paths for files inside the CWD tree', () => {
    expect(formatContextFileDisplayPath(path.join(proj, 'QWEN.md'), proj)).toBe(
      'QWEN.md',
    );
    expect(
      formatContextFileDisplayPath(path.join(proj, 'sub', 'QWEN.md'), proj),
    ).toBe(path.join('sub', 'QWEN.md'));
  });

  it('shortens home-dir files outside the CWD tree to ~ paths', () => {
    expect(
      formatContextFileDisplayPath(path.join(home, '.qwen', 'QWEN.md'), proj),
    ).toBe(path.join('~', '.qwen', 'QWEN.md'));
  });

  it('prefers CWD-relative paths for projects under the home dir', () => {
    const projUnderHome = path.join(home, 'proj');
    expect(
      formatContextFileDisplayPath(
        path.join(projUnderHome, 'QWEN.md'),
        projUnderHome,
      ),
    ).toBe('QWEN.md');
  });

  it('keeps CWD-relative paths for directories with leading-dot names', () => {
    // '..cfg' merely starts with two dots; it is not a real '..' segment, so
    // the file is inside the CWD tree and must not be tildeified.
    const projUnderHome = path.join(home, 'proj2');
    expect(
      formatContextFileDisplayPath(
        path.join(projUnderHome, '..cfg', 'QWEN.md'),
        projUnderHome,
      ),
    ).toBe(path.join('..cfg', 'QWEN.md'));
  });

  it('does not tildeify sibling directories sharing the home prefix', () => {
    const file = path.join(siblingHome, 'proj', 'QWEN.md');
    expect(formatContextFileDisplayPath(file, proj)).toBe(
      path.relative(proj, file),
    );
  });

  it('keeps relative paths for files outside both CWD and home', () => {
    const file = path.join(other, 'QWEN.md');
    expect(formatContextFileDisplayPath(file, proj)).toBe(
      path.relative(proj, file),
    );
  });

  it('passes through non-absolute paths unchanged', () => {
    expect(formatContextFileDisplayPath('QWEN.md', proj)).toBe('QWEN.md');
  });

  it('strips ANSI escapes and control characters from display paths', () => {
    // stripVTControlCharacters matches ESC[2Jb…\x07 as one BEL-terminated
    // sequence, swallowing 'b' with the BEL; a bare BEL would survive it,
    // which is why this fixture pairs the two to exercise that pass.
    expect(
      formatContextFileDisplayPath(
        path.join(proj, 'a\u001b[2Jb\u0007.md'),
        proj,
      ),
    ).toBe('a.md');
  });
});
