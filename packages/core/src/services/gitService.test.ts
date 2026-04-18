/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';
import { GitService } from './gitService.js';
import { Storage } from '../config/storage.js';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { getProjectHash, QWEN_DIR } from '../utils/paths.js';
import { isCommandAvailable } from '../utils/shell-utils.js';

vi.mock('../utils/shell-utils.js', () => ({
  isCommandAvailable: vi.fn(),
}));

const hoistedMockEnv = vi.hoisted(() => vi.fn());
const hoistedMockSimpleGit = vi.hoisted(() => vi.fn());
const hoistedMockCheckIsRepo = vi.hoisted(() => vi.fn());
const hoistedMockInit = vi.hoisted(() => vi.fn());
const hoistedMockRaw = vi.hoisted(() => vi.fn());
const hoistedMockAdd = vi.hoisted(() => vi.fn());
const hoistedMockCommit = vi.hoisted(() => vi.fn());
const hoistedMockClean = vi.hoisted(() => vi.fn());
vi.mock('simple-git', () => ({
  simpleGit: hoistedMockSimpleGit.mockImplementation(() => ({
    checkIsRepo: hoistedMockCheckIsRepo,
    init: hoistedMockInit,
    raw: hoistedMockRaw,
    add: hoistedMockAdd,
    commit: hoistedMockCommit,
    clean: hoistedMockClean,
    env: hoistedMockEnv,
  })),
  CheckRepoActions: { IS_REPO_ROOT: 'is-repo-root' },
}));

const hoistedIsGitRepositoryMock = vi.hoisted(() => vi.fn());
vi.mock('../utils/gitUtils.js', () => ({
  isGitRepository: hoistedIsGitRepositoryMock,
}));

const hoistedMockHomedir = vi.hoisted(() => vi.fn());
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return {
    ...actual,
    homedir: hoistedMockHomedir,
  };
});

describe('GitService', () => {
  let testRootDir: string;
  let projectRoot: string;
  let homedir: string;
  let hash: string;
  let storage: Storage;

  beforeEach(async () => {
    testRootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-service-test-'));
    projectRoot = path.join(testRootDir, 'project');
    homedir = path.join(testRootDir, 'home');
    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(homedir, { recursive: true });

    hash = getProjectHash(projectRoot);

    vi.clearAllMocks();
    hoistedIsGitRepositoryMock.mockReturnValue(true);
    (isCommandAvailable as Mock).mockReturnValue({ available: true });

    hoistedMockHomedir.mockReturnValue(homedir);

    hoistedMockEnv.mockImplementation(() => ({
      checkIsRepo: hoistedMockCheckIsRepo,
      init: hoistedMockInit,
      raw: hoistedMockRaw,
      add: hoistedMockAdd,
      commit: hoistedMockCommit,
      clean: hoistedMockClean,
    }));
    hoistedMockSimpleGit.mockImplementation(() => ({
      checkIsRepo: hoistedMockCheckIsRepo,
      init: hoistedMockInit,
      raw: hoistedMockRaw,
      add: hoistedMockAdd,
      commit: hoistedMockCommit,
      clean: hoistedMockClean,
      env: hoistedMockEnv,
    }));
    hoistedMockCheckIsRepo.mockResolvedValue(false);
    hoistedMockInit.mockResolvedValue(undefined);
    hoistedMockRaw.mockResolvedValue('');
    hoistedMockAdd.mockResolvedValue(undefined);
    hoistedMockCommit.mockResolvedValue({
      commit: 'initial',
    });
    hoistedMockClean.mockResolvedValue(undefined);
    storage = new Storage(projectRoot);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(testRootDir, { recursive: true, force: true });
  });

  describe('constructor', () => {
    it('should successfully create an instance', () => {
      expect(() => new GitService(projectRoot, storage)).not.toThrow();
    });
  });

  describe('initialize', () => {
    it('should throw an error if Git is not available', async () => {
      (isCommandAvailable as Mock).mockReturnValue({ available: false });
      const service = new GitService(projectRoot, storage);
      await expect(service.initialize()).rejects.toThrow(
        'Checkpointing is enabled, but Git is not installed. Please install Git or disable checkpointing to continue.',
      );
    });

    it('should call setupShadowGitRepository if Git is available', async () => {
      const service = new GitService(projectRoot, storage);
      const setupSpy = vi
        .spyOn(service, 'setupShadowGitRepository')
        .mockResolvedValue(undefined);

      await service.initialize();
      expect(setupSpy).toHaveBeenCalled();
    });
  });

  describe('setupShadowGitRepository', () => {
    let repoDir: string;
    let gitConfigPath: string;

    beforeEach(() => {
      repoDir = path.join(homedir, QWEN_DIR, 'history', hash);
      gitConfigPath = path.join(repoDir, '.gitconfig');
    });

    it('should create history and repository directories', async () => {
      const service = new GitService(projectRoot, storage);
      await service.setupShadowGitRepository();
      const stats = await fs.stat(repoDir);
      expect(stats.isDirectory()).toBe(true);
    });

    it('should create a .gitconfig file with the correct content', async () => {
      const service = new GitService(projectRoot, storage);
      await service.setupShadowGitRepository();

      const expectedConfigContent =
        '[user]\n  name = Qwen Code\n  email = qwen-code@qwen.ai\n[commit]\n  gpgsign = false\n';
      const actualConfigContent = await fs.readFile(gitConfigPath, 'utf-8');
      expect(actualConfigContent).toBe(expectedConfigContent);
    });

    it('should use the shadow git config during repository setup', async () => {
      const service = new GitService(projectRoot, storage);
      await service.setupShadowGitRepository();

      expect(hoistedMockEnv).toHaveBeenCalledWith({
        HOME: repoDir,
        XDG_CONFIG_HOME: repoDir,
      });
    });

    it('should initialize git repo in historyDir if not already initialized', async () => {
      hoistedMockCheckIsRepo.mockResolvedValue(false);
      hoistedMockRaw.mockResolvedValueOnce('');
      const service = new GitService(projectRoot, storage);
      await service.setupShadowGitRepository();
      expect(hoistedMockSimpleGit).toHaveBeenCalledWith(repoDir);
      expect(hoistedMockInit).toHaveBeenCalledWith(false);
      expect(hoistedMockRaw).toHaveBeenCalledWith([
        'symbolic-ref',
        'HEAD',
        'refs/heads/main',
      ]);
    });

    it('should initialize git repo when root repo check throws', async () => {
      hoistedMockCheckIsRepo.mockRejectedValueOnce(
        new Error('fatal: not a git repository'),
      );
      hoistedMockRaw.mockResolvedValueOnce('');
      const service = new GitService(projectRoot, storage);
      await expect(service.setupShadowGitRepository()).resolves.toBeUndefined();
      expect(hoistedMockInit).toHaveBeenCalled();
    });

    it('should fall back to plain init when git does not support --initial-branch', async () => {
      hoistedMockCheckIsRepo.mockResolvedValue(false);
      hoistedMockInit
        .mockRejectedValueOnce(
          new Error("error: unknown option `initial-branch=main'"),
        )
        .mockResolvedValueOnce(undefined);
      hoistedMockRaw.mockResolvedValueOnce('');

      const service = new GitService(projectRoot, storage);
      await service.setupShadowGitRepository();

      expect(hoistedMockInit).toHaveBeenNthCalledWith(1, false, {
        '--initial-branch': 'main',
      });
      expect(hoistedMockInit).toHaveBeenNthCalledWith(2, false);
      expect(hoistedMockCommit).toHaveBeenCalledWith('Initial snapshot');
    });

    it('should not initialize git repo if already initialized', async () => {
      hoistedMockCheckIsRepo.mockResolvedValue(true);
      hoistedMockRaw.mockResolvedValueOnce('tracked.txt\n');
      const service = new GitService(projectRoot, storage);
      await service.setupShadowGitRepository();
      expect(hoistedMockInit).not.toHaveBeenCalled();
      expect(hoistedMockRaw).not.toHaveBeenCalled();
    });

    it('should copy .gitignore from projectRoot if it exists', async () => {
      const gitignoreContent = 'node_modules/\n.env';
      const visibleGitIgnorePath = path.join(projectRoot, '.gitignore');
      await fs.writeFile(visibleGitIgnorePath, gitignoreContent);

      const service = new GitService(projectRoot, storage);
      await service.setupShadowGitRepository();

      const hiddenGitIgnorePath = path.join(repoDir, '.gitignore');
      const copiedContent = await fs.readFile(hiddenGitIgnorePath, 'utf-8');
      expect(copiedContent).toBe(gitignoreContent);
    });

    it('should copy .gitignore before creating the baseline snapshot', async () => {
      const gitignoreContent = 'node_modules/\n.env\n';
      await fs.writeFile(
        path.join(projectRoot, '.gitignore'),
        gitignoreContent,
      );
      hoistedMockRaw.mockResolvedValueOnce('');
      hoistedMockAdd.mockImplementationOnce(async () => {
        await expect(
          fs.readFile(path.join(repoDir, '.gitignore'), 'utf-8'),
        ).resolves.toBe(gitignoreContent);
      });

      const service = new GitService(projectRoot, storage);
      await service.setupShadowGitRepository();

      expect(hoistedMockAdd).toHaveBeenCalledWith('.');
      expect(hoistedMockCommit).toHaveBeenCalledWith('Initial snapshot');
    });

    it('should not create a .gitignore in shadow repo if project .gitignore does not exist', async () => {
      const service = new GitService(projectRoot, storage);
      await service.setupShadowGitRepository();

      const hiddenGitIgnorePath = path.join(repoDir, '.gitignore');
      // An empty string is written if the file doesn't exist.
      const content = await fs.readFile(hiddenGitIgnorePath, 'utf-8');
      expect(content).toBe('');
    });

    it('should throw an error if reading projectRoot .gitignore fails with other errors', async () => {
      const visibleGitIgnorePath = path.join(projectRoot, '.gitignore');
      // Create a directory instead of a file to cause a read error
      await fs.mkdir(visibleGitIgnorePath);

      const service = new GitService(projectRoot, storage);
      // EISDIR is the expected error code on Unix-like systems
      await expect(service.setupShadowGitRepository()).rejects.toThrow(
        /EISDIR: illegal operation on a directory, read|EBUSY: resource busy or locked, read/,
      );
    });

    it('should make an initial commit if no commits exist in history repo', async () => {
      hoistedMockCheckIsRepo.mockResolvedValue(false);
      hoistedMockRaw.mockResolvedValueOnce('');
      hoistedMockCommit
        .mockRejectedValueOnce(
          new Error('nothing to commit, working tree clean'),
        )
        .mockResolvedValueOnce({
          commit: 'initial',
        });
      const service = new GitService(projectRoot, storage);
      await service.setupShadowGitRepository();
      expect(hoistedMockCommit).toHaveBeenCalledWith('Initial commit', {
        '--allow-empty': null,
      });
    });

    it('should not make an initial commit if commits already exist', async () => {
      hoistedMockCheckIsRepo.mockResolvedValue(true);
      hoistedMockRaw.mockResolvedValueOnce('tracked.txt\n');
      const service = new GitService(projectRoot, storage);
      await service.setupShadowGitRepository();
      expect(hoistedMockCommit).not.toHaveBeenCalled();
    });

    it('should create an initial baseline snapshot when repository tree is empty', async () => {
      hoistedMockCheckIsRepo.mockResolvedValue(true);
      hoistedMockRaw.mockResolvedValueOnce('');

      const service = new GitService(projectRoot, storage);
      await service.setupShadowGitRepository();

      expect(hoistedMockAdd).toHaveBeenCalledWith('.');
      expect(hoistedMockCommit).toHaveBeenCalledWith('Initial snapshot');
    });
  });

  describe('restoreProjectFromSnapshot', () => {
    it('should restore tracked files without cleaning untracked files', async () => {
      const service = new GitService(projectRoot, storage);

      await service.restoreProjectFromSnapshot('abc123');

      expect(hoistedMockRaw).toHaveBeenCalledWith([
        'restore',
        '--source',
        'abc123',
        '.',
      ]);
      expect(hoistedMockClean).not.toHaveBeenCalled();
    });
  });

  describe('getSnapshotDiffSummary', () => {
    it('parses diff output and untracked files', async () => {
      hoistedMockRaw
        .mockResolvedValueOnce('3\t1\tsrc/app.ts\n10\t0\tREADME.md\n')
        .mockResolvedValueOnce('new-file.ts\n');
      await fs.writeFile(
        path.join(projectRoot, 'new-file.ts'),
        'line 1\nline 2\nline 3\n',
      );

      const service = new GitService(projectRoot, storage);
      const result = await service.getSnapshotDiffSummary('abc123');

      expect(result).toEqual([
        {
          path: 'new-file.ts',
          additions: 3,
          deletions: 0,
        },
        {
          path: 'README.md',
          additions: 10,
          deletions: 0,
        },
        {
          path: 'src/app.ts',
          additions: 3,
          deletions: 1,
        },
      ]);
      expect(hoistedMockRaw).toHaveBeenNthCalledWith(
        1,
        'diff',
        '--numstat',
        'abc123',
        '--',
      );
      expect(hoistedMockRaw).toHaveBeenNthCalledWith(
        2,
        'ls-files',
        '--others',
        '--exclude-standard',
      );
    });

    it('treats binary changes as zero line counts', async () => {
      hoistedMockRaw
        .mockResolvedValueOnce('-\t-\timage.png\n')
        .mockResolvedValueOnce('');

      const service = new GitService(projectRoot, storage);
      const result = await service.getSnapshotDiffSummary('abc123');

      expect(result).toEqual([
        {
          path: 'image.png',
          additions: 0,
          deletions: 0,
        },
      ]);
    });

    it('can diff between two snapshots without reading untracked files', async () => {
      hoistedMockRaw.mockResolvedValueOnce('7\t0\thello_qwen.py\n');

      const service = new GitService(projectRoot, storage);
      const result = await service.getSnapshotDiffSummary('base123', 'next456');

      expect(result).toEqual([
        {
          path: 'hello_qwen.py',
          additions: 7,
          deletions: 0,
        },
      ]);
      expect(hoistedMockRaw).toHaveBeenCalledTimes(1);
      expect(hoistedMockRaw).toHaveBeenCalledWith(
        'diff',
        '--numstat',
        'base123',
        'next456',
        '--',
      );
    });
  });
});
