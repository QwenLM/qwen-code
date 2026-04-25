/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core';
import { DesktopHttpError } from '../http/errors.js';

const PROJECT_STORE_VERSION = 1;
const MAX_RECENT_PROJECTS = 40;

export interface DesktopGitStatus {
  branch: string | null;
  modified: number;
  staged: number;
  untracked: number;
  ahead: number;
  behind: number;
  clean: boolean;
  isRepository: boolean;
  error?: string;
}

export interface DesktopProject {
  id: string;
  name: string;
  path: string;
  gitBranch: string | null;
  gitStatus: DesktopGitStatus;
  lastOpenedAt: number;
}

interface StoredProject {
  id: string;
  name: string;
  path: string;
  lastOpenedAt: number;
}

interface ProjectStoreFile {
  version: typeof PROJECT_STORE_VERSION;
  projects: StoredProject[];
}

export interface DesktopProjectServiceOptions {
  storePath?: string;
  now?: () => Date;
}

export class DesktopProjectService {
  private readonly storePath: string;
  private readonly now: () => Date;

  constructor(options: DesktopProjectServiceOptions = {}) {
    this.storePath =
      options.storePath ??
      join(Storage.getGlobalQwenDir(), 'desktop-projects.json');
    this.now = options.now ?? (() => new Date());
  }

  async listProjects(): Promise<DesktopProject[]> {
    const store = await this.readStore();
    const projects = await Promise.all(
      store.projects.map((project) => this.describeStoredProject(project)),
    );

    return projects.sort(
      (left, right) => right.lastOpenedAt - left.lastOpenedAt,
    );
  }

  async openProject(projectPath: string): Promise<DesktopProject> {
    const path = await normalizeDirectoryPath(projectPath);
    const storedProject: StoredProject = {
      id: createProjectId(path),
      name: basename(path) || path,
      path,
      lastOpenedAt: this.now().getTime(),
    };
    const store = await this.readStore();
    const projects = [
      storedProject,
      ...store.projects.filter((project) => project.id !== storedProject.id),
    ].slice(0, MAX_RECENT_PROJECTS);

    await this.writeStore({ version: PROJECT_STORE_VERSION, projects });
    return this.describeStoredProject(storedProject);
  }

  async getProjectGitStatus(projectId: string): Promise<DesktopGitStatus> {
    const project = await this.getStoredProject(projectId);
    return readGitStatus(project.path);
  }

  async getProjectPath(projectId: string): Promise<string> {
    const project = await this.getStoredProject(projectId);
    return project.path;
  }

  private async getStoredProject(projectId: string): Promise<StoredProject> {
    const store = await this.readStore();
    const project = store.projects.find((entry) => entry.id === projectId);
    if (!project) {
      throw new DesktopHttpError(
        404,
        'project_not_found',
        'Project is not registered in the desktop recent projects list.',
      );
    }

    return project;
  }

  private async describeStoredProject(
    project: StoredProject,
  ): Promise<DesktopProject> {
    const gitStatus = await readGitStatus(project.path);
    return {
      ...project,
      gitBranch: gitStatus.branch,
      gitStatus,
    };
  }

  private async readStore(): Promise<ProjectStoreFile> {
    try {
      const raw = await readFile(this.storePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!isProjectStoreFile(parsed)) {
        return { version: PROJECT_STORE_VERSION, projects: [] };
      }

      return parsed;
    } catch {
      return { version: PROJECT_STORE_VERSION, projects: [] };
    }
  }

  private async writeStore(store: ProjectStoreFile): Promise<void> {
    await mkdir(dirname(this.storePath), { recursive: true });
    await writeFile(
      this.storePath,
      `${JSON.stringify(store, null, 2)}\n`,
      'utf8',
    );
  }
}

async function normalizeDirectoryPath(projectPath: string): Promise<string> {
  let absolutePath: string;
  try {
    absolutePath = await realpath(projectPath);
  } catch {
    throw new DesktopHttpError(
      400,
      'project_path_invalid',
      'Project path does not exist.',
    );
  }

  const pathStat = await stat(absolutePath);
  if (!pathStat.isDirectory()) {
    throw new DesktopHttpError(
      400,
      'project_path_not_directory',
      'Project path must be a directory.',
    );
  }

  return absolutePath;
}

async function readGitStatus(projectPath: string): Promise<DesktopGitStatus> {
  try {
    const stdout = await runGit(projectPath, [
      'status',
      '--porcelain=v1',
      '--branch',
      '--untracked-files=all',
    ]);
    return parseGitStatus(stdout);
  } catch (error) {
    return {
      branch: null,
      modified: 0,
      staged: 0,
      untracked: 0,
      ahead: 0,
      behind: 0,
      clean: true,
      isRepository: false,
      error: error instanceof Error ? error.message : 'Git status unavailable.',
    };
  }
}

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      {
        maxBuffer: 1024 * 1024 * 4,
        timeout: 10_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = stderr.trim() || error.message;
          reject(new Error(message));
          return;
        }

        resolve(stdout);
      },
    );
  });
}

function parseGitStatus(stdout: string): DesktopGitStatus {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.length > 0);
  const branchLine = lines[0]?.startsWith('## ') ? lines[0] : undefined;
  let modified = 0;
  let staged = 0;
  let untracked = 0;

  for (const line of branchLine ? lines.slice(1) : lines) {
    if (line.startsWith('?? ')) {
      untracked += 1;
      continue;
    }
    if (line.startsWith('!! ')) {
      continue;
    }

    const indexStatus = line[0];
    const worktreeStatus = line[1];
    if (indexStatus && indexStatus !== ' ') {
      staged += 1;
    }
    if (worktreeStatus && worktreeStatus !== ' ') {
      modified += 1;
    }
  }

  return {
    branch: parseBranch(branchLine),
    modified,
    staged,
    untracked,
    ...parseAheadBehind(branchLine),
    clean: modified === 0 && staged === 0 && untracked === 0,
    isRepository: true,
  };
}

function parseBranch(branchLine: string | undefined): string | null {
  if (!branchLine) {
    return null;
  }

  const value = branchLine.slice(3).trim();
  if (value.startsWith('HEAD ')) {
    return null;
  }

  const noCommitPrefix = 'No commits yet on ';
  if (value.startsWith(noCommitPrefix)) {
    return value.slice(noCommitPrefix.length).trim() || null;
  }

  const branch = value
    .replace(/\s+\[[^\]]+\]$/u, '')
    .split('...')[0]
    ?.trim();
  return branch || null;
}

function parseAheadBehind(branchLine: string | undefined): {
  ahead: number;
  behind: number;
} {
  const summary = /\[([^\]]+)\]/u.exec(branchLine ?? '')?.[1] ?? '';
  let ahead = 0;
  let behind = 0;

  for (const entry of summary.split(',').map((part) => part.trim())) {
    const aheadMatch = /^ahead (\d+)$/u.exec(entry);
    if (aheadMatch?.[1]) {
      ahead = Number(aheadMatch[1]);
      continue;
    }

    const behindMatch = /^behind (\d+)$/u.exec(entry);
    if (behindMatch?.[1]) {
      behind = Number(behindMatch[1]);
    }
  }

  return { ahead, behind };
}

function createProjectId(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 16);
}

function isProjectStoreFile(value: unknown): value is ProjectStoreFile {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<ProjectStoreFile>;
  return (
    candidate.version === PROJECT_STORE_VERSION &&
    Array.isArray(candidate.projects) &&
    candidate.projects.every(isStoredProject)
  );
}

function isStoredProject(value: unknown): value is StoredProject {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<StoredProject>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.path === 'string' &&
    typeof candidate.lastOpenedAt === 'number'
  );
}
