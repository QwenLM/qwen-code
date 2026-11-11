/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { GlobTool, globGetPath, type GlobToolParams } from './glob.js';
import type { GlobResult } from './tools.js';
import { partListUnionToString } from '../core/llmRequest.js';
import path from 'node:path';
import { isSubpath } from '../utils/paths.js';
import fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import * as asyncFs from 'node:fs/promises';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import type { Config } from '../config/config.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import { ToolErrorType } from './tool-error.js';
import { projectProgrammaticResult } from '../codemode/contracts.js';
import * as globUtils from '../utils/glob.js';
import { DEFAULT_FILE_FILTERING_OPTIONS } from '../config/constants.js';
import {
  runWithCwdOverride,
  resetForTest as resetShellCwd,
} from '../utils/Shell.js';

vi.mock('../utils/glob.js', { spy: true });
vi.mock('node:fs', { spy: true });
vi.mock('node:fs/promises', { spy: true });

describe('GlobTool', () => {
  let tempRootDir: string; // This will be the rootDirectory for the GlobTool instance
  let globTool: InstanceType<typeof GlobTool>;
  const abortSignal = new AbortController().signal;
  let mockConfig: Config;

  const expectGlobResult = (
    display: unknown,
    filenames: string[],
    truncated = false,
  ) => {
    const globResult = display as GlobResult;
    expect(globResult).toMatchObject({
      numFiles: filenames.length,
      filenames,
      truncated,
    });
    expect(typeof globResult.durationMs).toBe('number');
  };

  beforeEach(async () => {
    // Create a unique root directory for each test run
    tempRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'glob-tool-root-'));
    resetShellCwd(tempRootDir);
    await fs.writeFile(path.join(tempRootDir, '.git'), ''); // Fake git repo

    const rootDir = tempRootDir;
    const workspaceContext = createMockWorkspaceContext(rootDir);
    const fileDiscovery = new FileDiscoveryService(rootDir);

    const mockStorage = {
      getProjectTempDir: vi.fn().mockReturnValue('/tmp/project'),
    };

    mockConfig = {
      getTargetDir: () => rootDir,
      getWorkspaceContext: () => workspaceContext,
      getFileService: () => fileDiscovery,
      getFileFilteringOptions: () => DEFAULT_FILE_FILTERING_OPTIONS,
      getFileExclusions: () => ({ getGlobExcludes: () => [] }),
      getPermissionMode: () => 'default' as const,
      storage: mockStorage,
      isPathAllowed(this: Config, absolutePath: string): boolean {
        const workspaceContext = this.getWorkspaceContext();
        if (workspaceContext.isPathWithinWorkspace(absolutePath)) {
          return true;
        }

        const projectTempDir = this.storage.getProjectTempDir();
        return isSubpath(path.resolve(projectTempDir), absolutePath);
      },
      validatePathAccess(this: Config, absolutePath: string): string | null {
        if (this.isPathAllowed(absolutePath)) {
          return null;
        }

        const workspaceDirs = this.getWorkspaceContext().getDirectories();
        const projectTempDir = this.storage.getProjectTempDir();
        return `Path not in workspace: Attempted path "${absolutePath}" resolves outside the allowed workspace directories: ${workspaceDirs.join(', ')} or the project temp directory: ${projectTempDir}`;
      },
    } as unknown as Config;

    globTool = new GlobTool(mockConfig);

    // Create some test files and directories within this root
    // Top-level files
    await fs.writeFile(path.join(tempRootDir, 'fileA.txt'), 'contentA');
    await fs.writeFile(path.join(tempRootDir, 'FileB.TXT'), 'contentB'); // Different case for testing

    // Subdirectory and files within it
    await fs.mkdir(path.join(tempRootDir, 'sub'));
    await fs.writeFile(path.join(tempRootDir, 'sub', 'fileC.md'), 'contentC');
    await fs.writeFile(path.join(tempRootDir, 'sub', 'FileD.MD'), 'contentD'); // Different case

    // Deeper subdirectory
    await fs.mkdir(path.join(tempRootDir, 'sub', 'deep'));
    await fs.writeFile(
      path.join(tempRootDir, 'sub', 'deep', 'fileE.log'),
      'contentE',
    );

    // Files for mtime sorting test
    await fs.writeFile(path.join(tempRootDir, 'older.sortme'), 'older_content');
    // Ensure a noticeable difference in modification time
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fs.writeFile(path.join(tempRootDir, 'newer.sortme'), 'newer_content');
  });

  afterEach(async () => {
    resetShellCwd();
    // Clean up the temporary root directory
    await fs.rm(tempRootDir, { recursive: true, force: true });
    vi.resetAllMocks();
  });

  describe('execute', () => {
    it('should search only the target directory when no path is given', async () => {
      // The default root must be a single directory: it is the one directory
      // the permission layer checks for a no-path call, so fanning out over
      // extra workspace roots would search unchecked directories.
      // Asserted on the search target rather than on results, so the test does
      // not depend on a working ripgrep binary.
      vi.mocked(
        mockConfig.getWorkspaceContext().getDirectories,
      ).mockReturnValue([tempRootDir, path.join(os.tmpdir(), 'second-root')]);

      const invocation = globTool.build({ pattern: '*.txt' });
      await invocation.execute(abortSignal);

      const searchedDirs = vi
        .mocked(globUtils.glob)
        .mock.calls.map((call) => call[1]);
      expect(searchedDirs).toEqual([tempRootDir]);
    });

    it('should find files matching a simple pattern in the root', async () => {
      const params: GlobToolParams = { pattern: '*.txt' };
      const invocation = globTool.build(params);
      const result = await invocation.execute(abortSignal);
      // Ripgrep is case-sensitive by default, so *.txt only matches fileA.txt
      expect(result.llmContent).toContain('fileA.txt');
      expectGlobResult(result.returnDisplay, ['fileA.txt']);
    }, 30000);

    it('should find files case-sensitively by default (pattern: *.txt)', async () => {
      const params: GlobToolParams = { pattern: '*.txt' };
      const invocation = globTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain('fileA.txt');
      expect(result.llmContent).not.toContain('FileB.TXT');
    }, 30000);

    it('should find files case-sensitively by default (pattern: *.TXT)', async () => {
      const params: GlobToolParams = { pattern: '*.TXT' };
      const invocation = globTool.build(params);
      const result = await invocation.execute(abortSignal);
      // Ripgrep is case-sensitive by default, so *.TXT only matches FileB.TXT
      expect(result.llmContent).toContain('FileB.TXT');
      expect(result.llmContent).not.toContain('fileA.txt');
    }, 30000);

    it('should find only matching case (pattern: *.TXT)', async () => {
      const params: GlobToolParams = {
        pattern: '*.TXT',
      };
      const invocation = globTool.build(params);
      const result = await invocation.execute(abortSignal);
      // Ripgrep is case-sensitive, so *.TXT only matches FileB.TXT
      expect(result.llmContent).toContain('FileB.TXT');
    }, 30000);

    it('should find files using a pattern that includes a subdirectory', async () => {
      const params: GlobToolParams = { pattern: '**/sub/*.md' };
      const invocation = globTool.build(params);
      const result = await invocation.execute(abortSignal);
      // Ripgrep is case-sensitive by default, so only fileC.md matches
      expect(result.llmContent).toContain('sub/fileC.md');
      expectGlobResult(result.returnDisplay, ['sub/fileC.md']);
    }, 30000);

    it('should find files in a specified relative path (relative to rootDir)', async () => {
      const params: GlobToolParams = { pattern: '*.md', path: 'sub' };
      const invocation = globTool.build(params);
      const result = await invocation.execute(abortSignal);
      // Ripgrep is case-sensitive by default, so only fileC.md matches
      expect(result.llmContent).toContain('sub/fileC.md');
      expectGlobResult(result.returnDisplay, ['sub/fileC.md']);
    }, 30000);

    it('should find files using a deep globstar pattern (e.g., **/*.log)', async () => {
      const params: GlobToolParams = { pattern: '**/*.log' };
      const invocation = globTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain('sub/deep/fileE.log');
      expectGlobResult(result.returnDisplay, ['sub/deep/fileE.log']);
    }, 30000);

    it('should return "No files found" message when pattern matches nothing', async () => {
      const params: GlobToolParams = { pattern: '*.nonexistent' };
      const invocation = globTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain('No files found');
      expectGlobResult(result.returnDisplay, []);
      expect(
        projectProgrammaticResult(globTool.programmatic, result),
      ).toEqual({
        filenames: [],
        numFiles: 0,
        truncated: false,
        totalMatches: 0,
        countIsComplete: true,
      });
    }, 30000);

    it('preserves incomplete search metadata even when the visible result is empty', async () => {
      vi.mocked(globUtils.glob).mockResolvedValueOnce({
        files: [],
        truncated: true,
        totalMatches: 0,
        countIsComplete: false,
      });
      const result = await globTool
        .build({ pattern: '*.txt' })
        .execute(abortSignal);
      expect(
        projectProgrammaticResult(globTool.programmatic, result),
      ).toMatchObject({
        filenames: [],
        truncated: true,
        totalMatches: 0,
        countIsComplete: false,
      });
    });

    it('should find files with special characters in the name', async () => {
      await fs.writeFile(path.join(tempRootDir, 'file[1].txt'), 'content');
      const params: GlobToolParams = { pattern: 'file[[]1[]].txt' };
      const invocation = globTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain('file[1].txt');
      expectGlobResult(result.returnDisplay, ['file[1].txt']);
    }, 30000);

    it('should find files with special characters like [] and () in the path', async () => {
      const filePath = path.join(
        tempRootDir,
        'src/app/[test]/(dashboard)/testing/components/code.tsx',
      );
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, 'content');

      // Use globstar to match files with special characters in path
      const params: GlobToolParams = {
        pattern: '**/code.tsx',
      };
      const invocation = globTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.llmContent).toContain('code.tsx');
      expectGlobResult(result.returnDisplay, [
        'src/app/[test]/(dashboard)/testing/components/code.tsx',
      ]);
    }, 30000);

    it('should sort files by modification time (oldest first)', async () => {
      const params: GlobToolParams = { pattern: '*.sortme' };
      const invocation = globTool.build(params);
      const result = await invocation.execute(abortSignal);
      const llmContent = partListUnionToString(result.llmContent);
      const newerIndex = llmContent.indexOf('newer.sortme');
      const olderIndex = llmContent.indexOf('older.sortme');
      // ripgrep sorts by modification time oldest first with --sort=modified
      expect(olderIndex).toBeLessThan(newerIndex);
    }, 30000);

    it('should return a GLOB_EXECUTION_ERROR on glob failure', async () => {
      vi.mocked(globUtils.glob).mockRejectedValue(new Error('Glob failed'));
      const params: GlobToolParams = { pattern: '*' };
      const invocation = globTool.build(params);
      const result = await invocation.execute(abortSignal);
      expect(result.error?.type).toBe(ToolErrorType.GLOB_EXECUTION_ERROR);
    }, 30000);
  });

  describe('validateToolParams', () => {
    it('should return null for valid parameters', () => {
      const params: GlobToolParams = { pattern: '*.txt' };
      expect(globTool.validateToolParams(params)).toBeNull();
    });

    it('should return null for valid parameters with path', () => {
      const params: GlobToolParams = { pattern: '*.txt', path: 'sub' };
      expect(globTool.validateToolParams(params)).toBeNull();
    });

    it('should return null for valid parameters with absolute path within workspace', async () => {
      const params: GlobToolParams = {
        pattern: '*.txt',
        path: tempRootDir,
      };
      expect(globTool.validateToolParams(params)).toBeNull();
    });

    it('should return error if pattern is missing', () => {
      const params = {} as unknown as GlobToolParams;
      expect(globTool.validateToolParams(params)).toContain(
        "params must have required property 'pattern'",
      );
    });

    it('should return error if pattern is an empty string', () => {
      const params: GlobToolParams = { pattern: '' };
      expect(globTool.validateToolParams(params)).toContain(
        "The 'pattern' parameter cannot be empty",
      );
    });

    it('should return error if pattern is only whitespace', () => {
      const params: GlobToolParams = { pattern: '   ' };
      expect(globTool.validateToolParams(params)).toContain(
        "The 'pattern' parameter cannot be empty",
      );
    });

    it('should defer probing a schema-coerced path until execution', () => {
      const params = {
        pattern: '*',
        path: 123,
      } as unknown as GlobToolParams;
      expect(globTool.validateToolParams(params)).toBeNull();
    });

    it('should leave workspace boundary checks to the permission layer', () => {
      const params: GlobToolParams = { pattern: '*', path: '../' };
      expect(globTool.validateToolParams(params)).toBeNull();
    });

    it('should report a missing directory during execution, not validation', async () => {
      const params: GlobToolParams = {
        pattern: '*',
        path: 'non-existent',
      };
      expect(globTool.validateToolParams(params)).toBeNull();
      const result = await globTool.build(params).execute(abortSignal);
      expect(result.error?.message).toContain('Search path does not exist');
      expect(globUtils.glob).not.toHaveBeenCalled();
    });

    it('should reject a file as a search directory during execution', async () => {
      await fs.writeFile(path.join(tempRootDir, 'not-a-dir'), 'content');
      const params: GlobToolParams = { pattern: '*', path: 'not-a-dir' };
      expect(globTool.validateToolParams(params)).toBeNull();
      const result = await globTool.build(params).execute(abortSignal);
      expect(result.error?.message).toContain('Search path is not a directory');
      expect(globUtils.glob).not.toHaveBeenCalled();
    });
  });

  describe('workspace boundary validation', () => {
    it('should leave workspace boundary validation to the permission layer', () => {
      expect(globTool.validateToolParams({ pattern: '*' })).toBeNull();
      expect(
        globTool.validateToolParams({ pattern: '*', path: '.' }),
      ).toBeNull();
      expect(
        globTool.validateToolParams({ pattern: '*', path: tempRootDir }),
      ).toBeNull();

      for (const searchPath of ['..', '/']) {
        expect(
          globTool.validateToolParams({ pattern: '*', path: searchPath }),
        ).toBeNull();
      }
    });

    it('should never probe paths during build, including network patterns and CWD', () => {
      const probes = [
        syncFs.existsSync,
        syncFs.statSync,
        syncFs.realpathSync,
        asyncFs.stat,
      ];
      for (const probe of probes) {
        vi.mocked(probe).mockClear();
        vi.mocked(probe).mockImplementation(() => {
          throw new Error('Unexpected filesystem probe');
        });
      }
      runWithCwdOverride('//server/share', () => {
        for (const params of [
          { pattern: '*' },
          { pattern: '*', path: 'child' },
          { pattern: '*', path: '//server/share' },
          { pattern: '*', path: ' //server/share ' },
          { pattern: '//server/share/**/*.ts', path: tempRootDir },
          { pattern: '*', path: tempRootDir },
        ]) {
          expect(() => globTool.build(params)).not.toThrow();
        }
      });
      for (const probe of probes) {
        expect(probe).not.toHaveBeenCalled();
        vi.mocked(probe).mockRestore();
      }
    });

    it('should accept a missing absolute path until execution', () => {
      const result = globTool.validateToolParams({
        pattern: '*',
        path: '/tmp/outside',
      });
      expect(result).toBeNull();
    });

    it('should work with paths in workspace subdirectories', async () => {
      const subDir = path.join(tempRootDir, 'allowed-sub');
      await fs.mkdir(subDir);
      expect(
        globTool.validateToolParams({ pattern: '*', path: 'allowed-sub' }),
      ).toBeNull();
    });
  });

  describe('search scope description', () => {
    it('describes the live search root, including absolute pattern overrides', () => {
      runWithCwdOverride(path.join(tempRootDir, 'sub'), () => {
        for (const [params, expectedScope] of [
          [{ pattern: '*.md' }, 'sub'],
          [{ pattern: '*.log', path: 'deep' }, path.join('sub', 'deep')],
          [{ pattern: path.join(tempRootDir, '*.txt'), path: 'deep' }, './'],
        ] as const) {
          expect(globTool.build(params).getDescription()).toBe(
            `'${params.pattern}' within ${expectedScope}`,
          );
        }
      });
    });
  });

  describe('ignore file handling', () => {
    it('should use ignore patterns from config', async () => {
      await fs.writeFile(path.join(tempRootDir, 'ignored_test.txt'), 'content');
      await fs.writeFile(path.join(tempRootDir, 'visible_test.txt'), 'content');

      // Update mockConfig to return ignore patterns
      mockConfig = Object.assign(
        Object.create(Object.getPrototypeOf(mockConfig)),
        mockConfig,
        {
          getCustomExcludes: () => ['ignored_test.txt'],
        },
      ) as Config;
      globTool = new GlobTool(mockConfig);

      const params: GlobToolParams = { pattern: '*_test.txt' };
      const invocation = globTool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.llmContent).toContain('visible_test.txt');
      expect(result.llmContent).not.toContain('ignored_test.txt');
      expectGlobResult(result.returnDisplay, ['visible_test.txt']);
    }, 30000);
  });

  describe('Read deny result filtering', () => {
    // The deny rule must use the double-slash absolute form; a single leading
    // slash is project-relative semantics. cwd for rule matching is the
    // config's target directory ('/opt/workspace' here).
    const setupDenyScenario = (denyRules: string[] | undefined) => {
      mockConfig = Object.assign(
        Object.create(Object.getPrototypeOf(mockConfig)),
        mockConfig,
        {
          getTargetDir: () => '/opt/workspace',
          permission:
            denyRules === undefined
              ? undefined
              : {
                  getRules: () => ({
                    allow: {},
                    deny: { projectSettings: denyRules },
                    ask: {},
                  }),
                  getAdditionalDirectories: () => [],
                  getManagedRules: () => undefined,
                },
        },
      ) as Config;
      globTool = new GlobTool(mockConfig);
    };

    const mockSearchResults = () => {
      // Mimic the collector contract (utils/glob.ts): the deny filter is
      // applied before slicing. The predicate itself is the real one
      // executeGlob builds from the permission context — this is what the
      // test exercises.
      vi.mocked(globUtils.glob).mockImplementationOnce(
        async (
          _pattern: string,
          _dir: string,
          { limit, offset }: { limit: number; offset: number },
          _signal: AbortSignal,
          _ignorePatterns?: string[],
          denyFilter?: (absolutePath: string) => boolean,
        ) => {
          const files = [
            '/opt/workspace/config/db.env',
            '/opt/workspace/config/app.conf',
          ].filter((f) => !denyFilter || !denyFilter(f));
          return {
            files: files.slice(offset, offset + limit),
            truncated: false,
            totalMatches: files.length,
            countIsComplete: true,
          };
        },
      );
    };

    it('should keep the search allowed but hide Read-denied files from results', async () => {
      setupDenyScenario(['Read(//opt/workspace/config/db.env)']);
      mockSearchResults();

      const params: GlobToolParams = { pattern: '*', path: tempRootDir };
      const invocation = globTool.build(params);
      const result = await invocation.execute(abortSignal);

      // The search itself passes: no execution error, and the collector ran.
      expect(result.error).toBeUndefined();
      expect(globUtils.glob).toHaveBeenCalled();

      const globResult = result.returnDisplay as GlobResult;
      expect(globResult.numFiles).toBe(1);
      expect(globResult.filenames.join('\n')).toContain('app.conf');
      expect(globResult.filenames.join('\n')).not.toContain('db.env');
      expect(result.llmContent).toContain('app.conf');
      expect(result.llmContent).not.toContain('db.env');
    });

    it('should keep files the deny rule does not hit', async () => {
      setupDenyScenario(['Read(//opt/workspace/other/secret.txt)']);
      mockSearchResults();

      const params: GlobToolParams = { pattern: '*', path: tempRootDir };
      const invocation = globTool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.error).toBeUndefined();
      const globResult = result.returnDisplay as GlobResult;
      expect(globResult.numFiles).toBe(2);
      expect(globResult.filenames.join('\n')).toContain('app.conf');
      expect(globResult.filenames.join('\n')).toContain('db.env');
    });

    it('should leave results untouched when no permission context is configured', async () => {
      setupDenyScenario(undefined);
      mockSearchResults();

      const params: GlobToolParams = { pattern: '*', path: tempRootDir };
      const invocation = globTool.build(params);
      const result = await invocation.execute(abortSignal);

      expect(result.error).toBeUndefined();
      const globResult = result.returnDisplay as GlobResult;
      expect(globResult.numFiles).toBe(2);
    });
  });
});

describe('globGetPath', () => {
  beforeEach(() => resetShellCwd('/session'));
  afterEach(() => resetShellCwd());

  it('expands home paths', () => {
    expect(globGetPath({ pattern: '*', path: '~' })).toBe(os.homedir());
  });
  it('uses the current session directory by default', () => {
    expect(globGetPath({ pattern: '*' })).toBe('/session');
  });
  it('resolves relative paths against the current directory', () => {
    expect(globGetPath({ pattern: '*', path: 'sub/dir' })).toBe(
      path.resolve('/session', 'sub/dir'),
    );
  });
  it('preserves an explicit absolute search root', () => {
    expect(globGetPath({ pattern: '*', path: '/abs/dir' })).toBe('/abs/dir');
  });
});
