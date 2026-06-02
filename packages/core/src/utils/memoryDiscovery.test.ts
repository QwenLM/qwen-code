/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadServerHierarchicalMemory } from './memoryDiscovery.js';
import {
  setGeminiMdFilename,
  DEFAULT_CONTEXT_FILENAME,
  LOCAL_CONTEXT_FILENAME,
} from '../memory/const.js';
import { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import { QWEN_DIR } from './paths.js';
import type { InstructionsLoadedNotification } from './memoryDiscovery.js';

vi.mock('os', async (importOriginal) => {
  const actualOs = await importOriginal<typeof os>();
  return {
    ...actualOs,
    homedir: vi.fn(),
  };
});

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
    setGeminiMdFilename(DEFAULT_CONTEXT_FILENAME);
    // Clean up the temporary directory to prevent resource leaks.
    // Use maxRetries option for robust cleanup without race conditions
    await fsPromises.rm(testRootDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 10,
    });
  });

  describe('when untrusted', () => {
    it('does not load context files from untrusted workspaces', async () => {
      await createTestFile(
        path.join(projectRoot, DEFAULT_CONTEXT_FILENAME),
        'Project root memory',
      );
      await createTestFile(
        path.join(cwd, DEFAULT_CONTEXT_FILENAME),
        'Src directory memory',
      );
      const { fileCount } = await loadServerHierarchicalMemory(
        cwd,
        [],
        new FileDiscoveryService(projectRoot),
        [],
        false, // untrusted
      );

      expect(fileCount).toEqual(0);
    });

    it('loads context from outside the untrusted workspace', async () => {
      await createTestFile(
        path.join(projectRoot, DEFAULT_CONTEXT_FILENAME),
        'Project root memory',
      ); // Untrusted
      await createTestFile(
        path.join(cwd, DEFAULT_CONTEXT_FILENAME),
        'Src directory memory',
      ); // Untrusted

      const filepath = path.join(homedir, QWEN_DIR, DEFAULT_CONTEXT_FILENAME);
      await createTestFile(filepath, 'default context content'); // In user home dir (outside untrusted space).
      const { fileCount, memoryContent } = await loadServerHierarchicalMemory(
        cwd,
        [],
        new FileDiscoveryService(projectRoot),
        [],
        false, // untrusted
      );

      expect(fileCount).toEqual(1);
      expect(memoryContent).toContain(path.relative(cwd, filepath).toString());
    });
  });

  it('should return empty memory and count if no context files are found', async () => {
    const result = await loadServerHierarchicalMemory(
      cwd,
      [],
      new FileDiscoveryService(projectRoot),
      [],
      DEFAULT_FOLDER_TRUST,
    );

    expect(result).toEqual({
      memoryContent: '',
      fileCount: 0,
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: expect.any(String),
    });
  });

  it('should skip implicit global, project, and rule discovery in explicit-only mode', async () => {
    await createTestFile(
      path.join(homedir, QWEN_DIR, DEFAULT_CONTEXT_FILENAME),
      'global context',
    );
    await createTestFile(
      path.join(projectRoot, DEFAULT_CONTEXT_FILENAME),
      'project context',
    );
    await createTestFile(
      path.join(cwd, DEFAULT_CONTEXT_FILENAME),
      'cwd context',
    );
    await createTestFile(
      path.join(projectRoot, QWEN_DIR, 'rules', 'baseline.md'),
      'project rule',
    );

    const result = await loadServerHierarchicalMemory(
      cwd,
      [],
      new FileDiscoveryService(projectRoot),
      [],
      DEFAULT_FOLDER_TRUST,
      'tree',
      [],
      { explicitOnly: true },
    );

    expect(result).toEqual({
      memoryContent: '',
      fileCount: 0,
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: expect.any(String),
    });
  });

  it('should still load context from explicit include directories in explicit-only mode', async () => {
    const extraDir = await createEmptyDir(path.join(testRootDir, 'explicit'));
    const explicitContextFile = await createTestFile(
      path.join(extraDir, DEFAULT_CONTEXT_FILENAME),
      'explicit context',
    );
    await createTestFile(
      path.join(homedir, QWEN_DIR, DEFAULT_CONTEXT_FILENAME),
      'global context',
    );
    await createTestFile(
      path.join(projectRoot, DEFAULT_CONTEXT_FILENAME),
      'project context',
    );
    await createTestFile(
      path.join(projectRoot, QWEN_DIR, 'rules', 'baseline.md'),
      'project rule',
    );

    const result = await loadServerHierarchicalMemory(
      cwd,
      [extraDir],
      new FileDiscoveryService(projectRoot),
      [],
      DEFAULT_FOLDER_TRUST,
      'tree',
      [],
      { explicitOnly: true },
    );

    expect(result).toEqual({
      memoryContent: `--- Context from: ${path.relative(cwd, explicitContextFile)} ---\nexplicit context\n--- End of Context from: ${path.relative(cwd, explicitContextFile)} ---`,
      fileCount: 1,
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: expect.any(String),
    });
  });

  it('should load only the global context file if present and others are not (default filename)', async () => {
    const defaultContextFile = await createTestFile(
      path.join(homedir, QWEN_DIR, DEFAULT_CONTEXT_FILENAME),
      'default context content',
    );

    const result = await loadServerHierarchicalMemory(
      cwd,
      [],
      new FileDiscoveryService(projectRoot),
      [],
      DEFAULT_FOLDER_TRUST,
    );

    expect(result).toEqual({
      memoryContent: `--- Context from: ${path.relative(cwd, defaultContextFile)} ---\ndefault context content\n--- End of Context from: ${path.relative(cwd, defaultContextFile)} ---`,
      fileCount: 1,
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: expect.any(String),
    });
  });

  it('should load only the global custom context file if present and filename is changed', async () => {
    const customFilename = 'CUSTOM_AGENTS.md';
    setGeminiMdFilename(customFilename);

    const customContextFile = await createTestFile(
      path.join(homedir, QWEN_DIR, customFilename),
      'custom context content',
    );

    const result = await loadServerHierarchicalMemory(
      cwd,
      [],
      new FileDiscoveryService(projectRoot),
      [],
      DEFAULT_FOLDER_TRUST,
    );

    expect(result).toEqual({
      memoryContent: `--- Context from: ${path.relative(cwd, customContextFile)} ---\ncustom context content\n--- End of Context from: ${path.relative(cwd, customContextFile)} ---`,
      fileCount: 1,
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: expect.any(String),
    });
  });

  it('should load context files by upward traversal with custom filename', async () => {
    const customFilename = 'PROJECT_CONTEXT.md';
    setGeminiMdFilename(customFilename);

    const projectContextFile = await createTestFile(
      path.join(projectRoot, customFilename),
      'project context content',
    );
    const cwdContextFile = await createTestFile(
      path.join(cwd, customFilename),
      'cwd context content',
    );

    const result = await loadServerHierarchicalMemory(
      cwd,
      [],
      new FileDiscoveryService(projectRoot),
      [],
      DEFAULT_FOLDER_TRUST,
    );

    expect(result).toEqual({
      memoryContent: `--- Context from: ${path.relative(cwd, projectContextFile)} ---\nproject context content\n--- End of Context from: ${path.relative(cwd, projectContextFile)} ---\n\n--- Context from: ${path.relative(cwd, cwdContextFile)} ---\ncwd context content\n--- End of Context from: ${path.relative(cwd, cwdContextFile)} ---`,
      fileCount: 2,
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: expect.any(String),
    });
  });

  it('should load context files from CWD with custom filename (not subdirectories)', async () => {
    const customFilename = 'LOCAL_CONTEXT.md';
    setGeminiMdFilename(customFilename);

    await createTestFile(
      path.join(cwd, 'subdir', customFilename),
      'Subdir custom memory',
    );
    await createTestFile(path.join(cwd, customFilename), 'CWD custom memory');

    const result = await loadServerHierarchicalMemory(
      cwd,
      [],
      new FileDiscoveryService(projectRoot),
      [],
      DEFAULT_FOLDER_TRUST,
    );

    // Only upward traversal is performed, subdirectory files are not loaded
    expect(result).toEqual({
      memoryContent: `--- Context from: ${customFilename} ---\nCWD custom memory\n--- End of Context from: ${customFilename} ---`,
      fileCount: 1,
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: expect.any(String),
    });
  });

  it('should load ORIGINAL_GEMINI_MD_FILENAME files by upward traversal from CWD to project root', async () => {
    const projectRootGeminiFile = await createTestFile(
      path.join(projectRoot, DEFAULT_CONTEXT_FILENAME),
      'Project root memory',
    );
    const srcGeminiFile = await createTestFile(
      path.join(cwd, DEFAULT_CONTEXT_FILENAME),
      'Src directory memory',
    );

    const result = await loadServerHierarchicalMemory(
      cwd,
      [],
      new FileDiscoveryService(projectRoot),
      [],
      DEFAULT_FOLDER_TRUST,
    );

    expect(result).toEqual({
      memoryContent: `--- Context from: ${path.relative(cwd, projectRootGeminiFile)} ---\nProject root memory\n--- End of Context from: ${path.relative(cwd, projectRootGeminiFile)} ---\n\n--- Context from: ${path.relative(cwd, srcGeminiFile)} ---\nSrc directory memory\n--- End of Context from: ${path.relative(cwd, srcGeminiFile)} ---`,
      fileCount: 2,
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: expect.any(String),
    });
  });

  it('should only load context files from CWD, not subdirectories', async () => {
    await createTestFile(
      path.join(cwd, 'subdir', DEFAULT_CONTEXT_FILENAME),
      'Subdir memory',
    );
    await createTestFile(
      path.join(cwd, DEFAULT_CONTEXT_FILENAME),
      'CWD memory',
    );

    const result = await loadServerHierarchicalMemory(
      cwd,
      [],
      new FileDiscoveryService(projectRoot),
      [],
      DEFAULT_FOLDER_TRUST,
    );

    // Subdirectory files are not loaded, only CWD and upward
    expect(result).toEqual({
      memoryContent: `--- Context from: ${DEFAULT_CONTEXT_FILENAME} ---\nCWD memory\n--- End of Context from: ${DEFAULT_CONTEXT_FILENAME} ---`,
      fileCount: 1,
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: expect.any(String),
    });
  });

  it('should load and correctly order global and upward context files', async () => {
    const defaultContextFile = await createTestFile(
      path.join(homedir, QWEN_DIR, DEFAULT_CONTEXT_FILENAME),
      'default context content',
    );
    const rootGeminiFile = await createTestFile(
      path.join(testRootDir, DEFAULT_CONTEXT_FILENAME),
      'Project parent memory',
    );
    const projectRootGeminiFile = await createTestFile(
      path.join(projectRoot, DEFAULT_CONTEXT_FILENAME),
      'Project root memory',
    );
    const cwdGeminiFile = await createTestFile(
      path.join(cwd, DEFAULT_CONTEXT_FILENAME),
      'CWD memory',
    );
    await createTestFile(
      path.join(cwd, 'sub', DEFAULT_CONTEXT_FILENAME),
      'Subdir memory',
    );

    const result = await loadServerHierarchicalMemory(
      cwd,
      [],
      new FileDiscoveryService(projectRoot),
      [],
      DEFAULT_FOLDER_TRUST,
    );

    // Subdirectory files are not loaded, only global and upward from CWD
    expect(result).toEqual({
      memoryContent: `--- Context from: ${path.relative(cwd, defaultContextFile)} ---\ndefault context content\n--- End of Context from: ${path.relative(cwd, defaultContextFile)} ---\n\n--- Context from: ${path.relative(cwd, rootGeminiFile)} ---\nProject parent memory\n--- End of Context from: ${path.relative(cwd, rootGeminiFile)} ---\n\n--- Context from: ${path.relative(cwd, projectRootGeminiFile)} ---\nProject root memory\n--- End of Context from: ${path.relative(cwd, projectRootGeminiFile)} ---\n\n--- Context from: ${path.relative(cwd, cwdGeminiFile)} ---\nCWD memory\n--- End of Context from: ${path.relative(cwd, cwdGeminiFile)} ---`,
      fileCount: 4,
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: expect.any(String),
    });
  });

  it('should load extension context file paths', async () => {
    const extensionFilePath = await createTestFile(
      path.join(testRootDir, 'extensions/ext1/QWEN.md'),
      'Extension memory content',
    );

    const result = await loadServerHierarchicalMemory(
      cwd,
      [],
      new FileDiscoveryService(projectRoot),
      [extensionFilePath],
      DEFAULT_FOLDER_TRUST,
    );

    expect(result).toEqual({
      memoryContent: `--- Context from: ${path.relative(cwd, extensionFilePath)} ---\nExtension memory content\n--- End of Context from: ${path.relative(cwd, extensionFilePath)} ---`,
      fileCount: 1,
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: expect.any(String),
    });
  });

  it('notifies when startup instruction files are loaded', async () => {
    const globalFile = await createTestFile(
      path.join(homedir, QWEN_DIR, DEFAULT_CONTEXT_FILENAME),
      'global context',
    );
    const projectFile = await createTestFile(
      path.join(projectRoot, DEFAULT_CONTEXT_FILENAME),
      'project context',
    );
    const extensionFile = await createTestFile(
      path.join(testRootDir, 'extensions/ext1/QWEN.md'),
      'extension context',
    );
    const notifications: InstructionsLoadedNotification[] = [];

    await loadServerHierarchicalMemory(
      cwd,
      [],
      new FileDiscoveryService(projectRoot),
      [extensionFile],
      DEFAULT_FOLDER_TRUST,
      'tree',
      [],
      {
        onInstructionsLoaded: (notification) => {
          notifications.push(notification);
        },
      },
    );

    expect(notifications).toEqual(
      expect.arrayContaining([
        {
          filePath: globalFile,
          memoryType: 'user',
          loadReason: 'session_start',
        },
        {
          filePath: projectFile,
          memoryType: 'project',
          loadReason: 'session_start',
        },
        {
          filePath: extensionFile,
          memoryType: 'extension',
          loadReason: 'session_start',
        },
      ]),
    );
  });

  it('notifies when imported instruction files are loaded', async () => {
    await createEmptyDir(path.join(projectRoot, '.git'));
    const importedFile = await createTestFile(
      path.join(projectRoot, 'included.md'),
      'included content',
    );
    const projectFile = await createTestFile(
      path.join(projectRoot, DEFAULT_CONTEXT_FILENAME),
      'project context @./included.md',
    );
    const notifications: InstructionsLoadedNotification[] = [];

    await loadServerHierarchicalMemory(
      cwd,
      [],
      new FileDiscoveryService(projectRoot),
      [],
      DEFAULT_FOLDER_TRUST,
      'tree',
      [],
      {
        onInstructionsLoaded: (notification) => {
          notifications.push(notification);
        },
      },
    );

    expect(notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filePath: projectFile,
          memoryType: 'project',
          loadReason: 'session_start',
        }),
        expect.objectContaining({
          filePath: importedFile,
          memoryType: 'project',
          loadReason: 'include',
          triggerFilePath: projectFile,
          parentFilePath: projectFile,
        }),
      ]),
    );
    expect(
      notifications.findIndex((item) => item.filePath === projectFile),
    ).toBeLessThan(
      notifications.findIndex((item) => item.filePath === importedFile),
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
    const projectFile = await createTestFile(
      path.join(projectRoot, DEFAULT_CONTEXT_FILENAME),
      'project context @./child.md',
    );
    const notifications: InstructionsLoadedNotification[] = [];

    await loadServerHierarchicalMemory(
      cwd,
      [],
      new FileDiscoveryService(projectRoot),
      [],
      DEFAULT_FOLDER_TRUST,
      'tree',
      [],
      {
        onInstructionsLoaded: (notification) => {
          notifications.push(notification);
        },
      },
    );

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
    const extensionFile = await createTestFile(
      path.join(extensionDir, DEFAULT_CONTEXT_FILENAME),
      'extension context @./included.md',
    );
    const notifications: InstructionsLoadedNotification[] = [];

    await loadServerHierarchicalMemory(
      cwd,
      [],
      new FileDiscoveryService(projectRoot),
      [extensionFile],
      DEFAULT_FOLDER_TRUST,
      'tree',
      [],
      {
        onInstructionsLoaded: (notification) => {
          notifications.push(notification);
        },
      },
    );

    expect(notifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filePath: importedFile,
          memoryType: 'extension',
          loadReason: 'include',
          triggerFilePath: extensionFile,
          parentFilePath: extensionFile,
        }),
      ]),
    );
  });

  it('still loads memory when instruction load notification fails', async () => {
    const projectFile = await createTestFile(
      path.join(projectRoot, DEFAULT_CONTEXT_FILENAME),
      'project context',
    );

    const result = await loadServerHierarchicalMemory(
      cwd,
      [],
      new FileDiscoveryService(projectRoot),
      [],
      DEFAULT_FOLDER_TRUST,
      'tree',
      [],
      {
        onInstructionsLoaded: () => {
          throw new Error('hook failed');
        },
      },
    );

    expect(result.fileCount).toBe(1);
    expect(result.memoryContent).toContain(
      `--- Context from: ${path.relative(cwd, projectFile)} ---\nproject context`,
    );
  });

  it('should load memory from included directories', async () => {
    const includedDir = await createEmptyDir(
      path.join(testRootDir, 'included'),
    );
    const includedFile = await createTestFile(
      path.join(includedDir, DEFAULT_CONTEXT_FILENAME),
      'included directory memory',
    );

    const result = await loadServerHierarchicalMemory(
      cwd,
      [includedDir],
      new FileDiscoveryService(projectRoot),
      [],
      DEFAULT_FOLDER_TRUST,
    );

    expect(result).toEqual({
      memoryContent: `--- Context from: ${path.relative(cwd, includedFile)} ---\nincluded directory memory\n--- End of Context from: ${path.relative(cwd, includedFile)} ---`,
      fileCount: 1,
      ruleCount: 0,
      conditionalRules: [],
      projectRoot: expect.any(String),
    });
  });

  it('should handle multiple directories and files in parallel correctly', async () => {
    // Create multiple test directories with GEMINI.md files
    const numDirs = 5;
    const createdFiles: string[] = [];

    for (let i = 0; i < numDirs; i++) {
      const dirPath = await createEmptyDir(
        path.join(testRootDir, `project-${i}`),
      );
      const filePath = await createTestFile(
        path.join(dirPath, DEFAULT_CONTEXT_FILENAME),
        `Content from project ${i}`,
      );
      createdFiles.push(filePath);
    }

    // Load memory from all directories
    const result = await loadServerHierarchicalMemory(
      cwd,
      createdFiles.map((f) => path.dirname(f)),
      new FileDiscoveryService(projectRoot),
      [],
      DEFAULT_FOLDER_TRUST,
    );

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

    await createTestFile(
      path.join(parentDir, DEFAULT_CONTEXT_FILENAME),
      'Parent content',
    );
    await createTestFile(
      path.join(childDir, DEFAULT_CONTEXT_FILENAME),
      'Child content',
    );

    // Include both parent and child directories
    const result = await loadServerHierarchicalMemory(
      parentDir,
      [childDir, parentDir], // Deliberately include duplicates
      new FileDiscoveryService(projectRoot),
      [],
      DEFAULT_FOLDER_TRUST,
    );

    // Should have both files without duplicates
    expect(result.fileCount).toBe(2);
    expect(result.memoryContent).toContain('Parent content');
    expect(result.memoryContent).toContain('Child content');

    // Check that files are not duplicated
    const parentOccurrences = (
      result.memoryContent.match(/Parent content/g) || []
    ).length;
    const childOccurrences = (
      result.memoryContent.match(/Child content/g) || []
    ).length;
    expect(parentOccurrences).toBe(1);
    expect(childOccurrences).toBe(1);
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

    it('loads .qwen/QWEN.local.md from project root when present', async () => {
      const localFile = await createTestFile(
        path.join(projectRoot, QWEN_DIR, 'QWEN.local.md'),
        'local context content',
      );

      const result = await loadServerHierarchicalMemory(
        cwd,
        [],
        new FileDiscoveryService(projectRoot),
        [],
        DEFAULT_FOLDER_TRUST,
      );

      expect(result.fileCount).toBe(1);
      expect(result.memoryContent).toContain(
        `--- Context from: ${path.relative(cwd, localFile)} ---\nlocal context content`,
      );
    });

    it('notifies when QWEN.local.md is loaded', async () => {
      const localFile = await createTestFile(
        path.join(projectRoot, QWEN_DIR, LOCAL_CONTEXT_FILENAME),
        'local context content',
      );
      const notifications: InstructionsLoadedNotification[] = [];

      await loadServerHierarchicalMemory(
        cwd,
        [],
        new FileDiscoveryService(projectRoot),
        [],
        DEFAULT_FOLDER_TRUST,
        'tree',
        [],
        {
          onInstructionsLoaded: (notification) => {
            notifications.push(notification);
          },
        },
      );

      expect(notifications).toEqual(
        expect.arrayContaining([
          {
            filePath: localFile,
            memoryType: 'local',
            loadReason: 'session_start',
          },
        ]),
      );
    });

    it('orders QWEN.local.md after the project-root QWEN.md', async () => {
      const projectFile = await createTestFile(
        path.join(projectRoot, DEFAULT_CONTEXT_FILENAME),
        'shared project context',
      );
      const localFile = await createTestFile(
        path.join(projectRoot, QWEN_DIR, 'QWEN.local.md'),
        'local override',
      );

      const result = await loadServerHierarchicalMemory(
        cwd,
        [],
        new FileDiscoveryService(projectRoot),
        [],
        DEFAULT_FOLDER_TRUST,
      );

      expect(result.fileCount).toBe(2);
      const projectIdx = result.memoryContent.indexOf(
        path.relative(cwd, projectFile),
      );
      const localIdx = result.memoryContent.indexOf(
        path.relative(cwd, localFile),
      );
      expect(projectIdx).toBeGreaterThanOrEqual(0);
      expect(localIdx).toBeGreaterThan(projectIdx);
    });

    it('orders QWEN.local.md after upward-traversed CWD QWEN.md', async () => {
      const projectFile = await createTestFile(
        path.join(projectRoot, DEFAULT_CONTEXT_FILENAME),
        'project root memory',
      );
      const cwdFile = await createTestFile(
        path.join(cwd, DEFAULT_CONTEXT_FILENAME),
        'cwd memory',
      );
      const localFile = await createTestFile(
        path.join(projectRoot, QWEN_DIR, 'QWEN.local.md'),
        'local memory',
      );

      const result = await loadServerHierarchicalMemory(
        cwd,
        [],
        new FileDiscoveryService(projectRoot),
        [],
        DEFAULT_FOLDER_TRUST,
      );

      expect(result.fileCount).toBe(3);
      const projectIdx = result.memoryContent.indexOf(
        path.relative(cwd, projectFile),
      );
      const cwdIdx = result.memoryContent.indexOf(path.relative(cwd, cwdFile));
      const localIdx = result.memoryContent.indexOf(
        path.relative(cwd, localFile),
      );
      expect(projectIdx).toBeGreaterThanOrEqual(0);
      expect(cwdIdx).toBeGreaterThan(projectIdx);
      expect(localIdx).toBeGreaterThan(cwdIdx);
    });

    it('silently ignores absent .qwen/QWEN.local.md', async () => {
      await createTestFile(
        path.join(projectRoot, DEFAULT_CONTEXT_FILENAME),
        'project content',
      );

      const result = await loadServerHierarchicalMemory(
        cwd,
        [],
        new FileDiscoveryService(projectRoot),
        [],
        DEFAULT_FOLDER_TRUST,
      );

      expect(result.fileCount).toBe(1);
      expect(result.memoryContent).toContain('project content');
      expect(result.memoryContent).not.toContain('QWEN.local.md');
    });

    it('does not load QWEN.local.md from untrusted workspaces', async () => {
      await createTestFile(
        path.join(projectRoot, QWEN_DIR, 'QWEN.local.md'),
        'local content',
      );

      const { fileCount, memoryContent } = await loadServerHierarchicalMemory(
        cwd,
        [],
        new FileDiscoveryService(projectRoot),
        [],
        false, // untrusted
      );

      expect(fileCount).toBe(0);
      expect(memoryContent).not.toContain('local content');
    });

    it('does not load QWEN.local.md in explicit-only mode', async () => {
      await createTestFile(
        path.join(projectRoot, QWEN_DIR, 'QWEN.local.md'),
        'local content',
      );

      const result = await loadServerHierarchicalMemory(
        cwd,
        [],
        new FileDiscoveryService(projectRoot),
        [],
        DEFAULT_FOLDER_TRUST,
        'tree',
        [],
        { explicitOnly: true },
      );

      expect(result.fileCount).toBe(0);
      expect(result.memoryContent).not.toContain('local content');
    });

    it('does not search .qwen/QWEN.local.md in CWD subdirectories', async () => {
      // A `.qwen/QWEN.local.md` placed inside a nested directory (not the
      // project root) must NOT be picked up — the slot is single, fixed,
      // and lives at <projectRoot>/.qwen/QWEN.local.md.
      await createTestFile(
        path.join(cwd, QWEN_DIR, 'QWEN.local.md'),
        'misplaced local content',
      );

      const result = await loadServerHierarchicalMemory(
        cwd,
        [],
        new FileDiscoveryService(projectRoot),
        [],
        DEFAULT_FOLDER_TRUST,
      );

      expect(result.fileCount).toBe(0);
      expect(result.memoryContent).not.toContain('misplaced local content');
    });

    it('loads QWEN.local.md even when no project QWEN.md exists', async () => {
      const localFile = await createTestFile(
        path.join(projectRoot, QWEN_DIR, 'QWEN.local.md'),
        'standalone local',
      );

      const result = await loadServerHierarchicalMemory(
        cwd,
        [],
        new FileDiscoveryService(projectRoot),
        [],
        DEFAULT_FOLDER_TRUST,
      );

      expect(result.fileCount).toBe(1);
      expect(result.memoryContent).toContain(
        `--- Context from: ${path.relative(cwd, localFile)} ---\nstandalone local`,
      );
    });

    it('loads QWEN.local.md when project root is marked by a .git FILE (worktree / submodule layout)', async () => {
      // Git worktrees and submodules mark the repo root with a `.git` file
      // (containing `gitdir: <path>`), not a `.git` directory. The loader
      // must treat that as a valid project root, otherwise `<cwd>` is used
      // as a silent fallback and the documented project-root slot never
      // loads. Replace the directory created by beforeEach with a file.
      await fsPromises.rm(path.join(projectRoot, '.git'), {
        recursive: true,
        force: true,
      });
      await fsPromises.writeFile(
        path.join(projectRoot, '.git'),
        'gitdir: /elsewhere/worktrees/feature/.git\n',
      );

      const localFile = await createTestFile(
        path.join(projectRoot, QWEN_DIR, 'QWEN.local.md'),
        'worktree local',
      );

      const result = await loadServerHierarchicalMemory(
        cwd,
        [],
        new FileDiscoveryService(projectRoot),
        [],
        DEFAULT_FOLDER_TRUST,
      );

      expect(result.fileCount).toBe(1);
      expect(result.memoryContent).toContain(
        `--- Context from: ${path.relative(cwd, localFile)} ---\nworktree local`,
      );
    });

    it('skips QWEN.local.md when no project root can be found (no .git ancestor)', async () => {
      // Without a project root, falling back to cwd would silently turn the
      // single fixed slot into a per-cwd file — opposite of the design.
      // Pin the "skip" behavior so a future regression doesn't reintroduce
      // the fallback.
      await fsPromises.rm(path.join(projectRoot, '.git'), {
        recursive: true,
        force: true,
      });

      await createTestFile(
        path.join(cwd, QWEN_DIR, 'QWEN.local.md'),
        'cwd-anchored local that must not load',
      );
      await createTestFile(
        path.join(projectRoot, QWEN_DIR, 'QWEN.local.md'),
        'projectRoot-anchored local that must not load either',
      );

      const result = await loadServerHierarchicalMemory(
        cwd,
        [],
        new FileDiscoveryService(projectRoot),
        [],
        DEFAULT_FOLDER_TRUST,
      );

      expect(result.fileCount).toBe(0);
      expect(result.memoryContent).not.toContain(
        'cwd-anchored local that must not load',
      );
      expect(result.memoryContent).not.toContain(
        'projectRoot-anchored local that must not load either',
      );
    });

    it('skips QWEN.local.md when cwd === homedir without .git (avoids global-dir collision)', async () => {
      // When cwd is the home directory and there is no `.git` there, the
      // would-be slot path resolves to `<homedir>/.qwen/QWEN.local.md` —
      // i.e. inside the GLOBAL Qwen dir. Loading that as a project-local
      // override is wrong: there is no project. Pin the "skip" behavior.
      await fsPromises.rm(path.join(projectRoot, '.git'), {
        recursive: true,
        force: true,
      });
      await createTestFile(
        path.join(homedir, QWEN_DIR, 'QWEN.local.md'),
        'do not promote this to project-local',
      );

      const result = await loadServerHierarchicalMemory(
        homedir, // cwd === homedir
        [],
        new FileDiscoveryService(homedir),
        [],
        DEFAULT_FOLDER_TRUST,
      );

      // Allowed: global QWEN.md / AGENTS.md in ~/.qwen/ may still load via
      // the existing global-discovery path. The assertion here is narrow —
      // the LOCAL slot specifically must not have been loaded.
      expect(result.memoryContent).not.toContain(
        'do not promote this to project-local',
      );
    });

    it('dedupes when an extension registers the local slot path explicitly', async () => {
      // The hierarchical scan iterates `getAllGeminiMdFilenames()`
      // (QWEN.md / AGENTS.md) and never produces a `QWEN.local.md` path,
      // so the dedup guard in the slot loader looks unreachable in
      // production paths. It IS reachable, though, via
      // `extensionContextFilePaths`: an extension may register the slot
      // path explicitly, in which case the hierarchical scan picks it up
      // via the extension-paths append. The dedup guard prevents the
      // slot loader from then appending the same file a second time
      // (double content + inflated fileCount). Pin that behavior.
      const localFile = await createTestFile(
        path.join(projectRoot, QWEN_DIR, 'QWEN.local.md'),
        'slot content only once',
      );

      const result = await loadServerHierarchicalMemory(
        cwd,
        [],
        new FileDiscoveryService(projectRoot),
        [localFile], // extension explicitly registers the slot path
        DEFAULT_FOLDER_TRUST,
      );

      expect(result.fileCount).toBe(1);
      const occurrences = (
        result.memoryContent.match(/slot content only once/g) ?? []
      ).length;
      expect(occurrences).toBe(1);
    });
  });
});
