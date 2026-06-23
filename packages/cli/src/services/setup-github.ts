/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { ProxyAgent } from 'undici';

import {
  getGitHubRepoInfo,
  getGitRepoRoot,
  getLatestGitHubRelease,
  isGitHubRepository,
} from '../utils/gitUtils.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core';
import { writeStderrLine } from '../utils/stdioHelpers.js';

const debugLogger = createDebugLogger('SETUP_GITHUB');

export const GITHUB_WORKFLOW_PATHS = [
  'qwen-dispatch/qwen-dispatch.yml',
  'qwen-assistant/qwen-invoke.yml',
  'issue-triage/qwen-triage.yml',
  'issue-triage/qwen-scheduled-triage.yml',
  'pr-review/qwen-review.yml',
];

const GITIGNORE_ENTRIES = ['.qwen/', 'gha-creds-*.json'];

export type GithubSetupGitignoreStatus =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'failed'
  | 'skipped';

export interface GithubSetupWriteMetadata {
  sizeBytes: number;
}

export interface SetupGithubFileOps {
  ensureWorkflowDirectory(gitRepoRoot: string): Promise<void>;
  writeTextFile(
    gitRepoRoot: string,
    relativePath: string,
    content: string,
  ): Promise<GithubSetupWriteMetadata>;
  readTextFile(
    gitRepoRoot: string,
    relativePath: string,
  ): Promise<string | undefined>;
}

export interface GithubSetupWorkflowResult {
  sourcePath: string;
  path: string;
  status: 'written' | 'failed';
  sizeBytes?: number;
  error?: string;
}

export interface GithubSetupGitignoreResult {
  path: '.gitignore';
  status: GithubSetupGitignoreStatus;
  added?: string[];
  error?: string;
}

export interface SetupGithubResult {
  kind: 'github_setup';
  workspaceCwd: string;
  gitRepoRoot: string;
  releaseTag: string;
  readmeUrl: string;
  secretsUrl?: string;
  workflows: GithubSetupWorkflowResult[];
  gitignore: GithubSetupGitignoreResult;
  warnings: string[];
  partial?: boolean;
}

export interface SetupGithubOptions {
  cwd?: string;
  workspaceRoot?: string;
  proxy?: string;
  abortSignal?: AbortSignal;
  fetchImpl?: typeof fetch;
  fileOps?: SetupGithubFileOps;
}

export class SetupGithubError extends Error {
  readonly code: string;
  readonly status: number;
  readonly partial: boolean;
  readonly partialResult?: SetupGithubResult;

  constructor(
    code: string,
    message: string,
    status: number,
    partialResult?: SetupGithubResult,
  ) {
    super(message);
    this.name = 'SetupGithubError';
    this.code = code;
    this.status = status;
    this.partial = partialResult !== undefined;
    this.partialResult = partialResult;
  }
}

const nodeFileOps: SetupGithubFileOps = {
  async ensureWorkflowDirectory(gitRepoRoot: string): Promise<void> {
    await fsp.mkdir(path.join(gitRepoRoot, '.github', 'workflows'), {
      recursive: true,
    });
  },

  async writeTextFile(
    gitRepoRoot: string,
    relativePath: string,
    content: string,
  ): Promise<GithubSetupWriteMetadata> {
    const target = path.join(gitRepoRoot, relativePath);
    await fsp.writeFile(target, content, { mode: 0o644 });
    return { sizeBytes: Buffer.byteLength(content, 'utf8') };
  },

  async readTextFile(
    gitRepoRoot: string,
    relativePath: string,
  ): Promise<string | undefined> {
    try {
      return await fsp.readFile(path.join(gitRepoRoot, relativePath), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return undefined;
      }
      throw error;
    }
  },
};

export async function setupGithub(
  options: SetupGithubOptions = {},
): Promise<SetupGithubResult> {
  const cwd = options.cwd ?? process.cwd();
  const fileOps = options.fileOps ?? nodeFileOps;

  if (!isGitHubRepository({ cwd })) {
    throw new SetupGithubError(
      'github_repository_not_found',
      'Unable to determine the GitHub repository. /setup-github must be run from a git repository.',
      400,
    );
  }

  let gitRepoRoot: string;
  try {
    gitRepoRoot = getGitRepoRoot({ cwd });
  } catch (error) {
    debugLogger.debug('Failed to get git repo root:', error);
    throw new SetupGithubError(
      'github_repository_not_found',
      'Unable to determine the GitHub repository. /setup-github must be run from a git repository.',
      400,
    );
  }

  if (options.workspaceRoot) {
    const [gitRootReal, workspaceReal] = await Promise.all([
      realpathOrResolve(gitRepoRoot),
      realpathOrResolve(options.workspaceRoot),
    ]);
    if (gitRootReal !== workspaceReal) {
      throw new SetupGithubError(
        'github_git_root_mismatch',
        'The Git repository root must match the daemon workspace root.',
        400,
      );
    }
  }

  let releaseTag: string;
  try {
    releaseTag = await getLatestGitHubRelease(options.proxy);
  } catch (error) {
    writeStderrLine(
      `qwen setup-github: failed to determine latest qwen-code-action release: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    debugLogger.debug(
      'Failed to determine latest qwen-code-action release:',
      error,
    );
    throw new SetupGithubError(
      'github_release_lookup_failed',
      'Unable to determine the latest qwen-code-action release on GitHub.',
      502,
    );
  }

  const readmeUrl = `https://github.com/QwenLM/qwen-code-action/blob/${releaseTag}/README.md#quick-start`;
  const secretsUrl = resolveSecretsUrl(cwd);
  const downloads = await downloadWorkflows({
    releaseTag,
    proxy: options.proxy,
    abortSignal: options.abortSignal,
    fetchImpl: options.fetchImpl ?? fetch,
  });

  const result: SetupGithubResult = {
    kind: 'github_setup',
    workspaceCwd: options.workspaceRoot ?? gitRepoRoot,
    gitRepoRoot,
    releaseTag,
    readmeUrl,
    ...(secretsUrl ? { secretsUrl } : {}),
    workflows: [],
    gitignore: { path: '.gitignore', status: 'skipped' },
    warnings: [],
  };

  try {
    await fileOps.ensureWorkflowDirectory(gitRepoRoot);
    for (const workflow of downloads) {
      const relativePath = path.posix.join(
        '.github',
        'workflows',
        path.posix.basename(workflow.sourcePath),
      );
      try {
        const write = await fileOps.writeTextFile(
          gitRepoRoot,
          relativePath,
          workflow.content,
        );
        result.workflows.push({
          sourcePath: workflow.sourcePath,
          path: relativePath,
          status: 'written',
          sizeBytes: write.sizeBytes,
        });
      } catch (error) {
        result.partial = true;
        result.workflows.push({
          sourcePath: workflow.sourcePath,
          path: relativePath,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
        throw new SetupGithubError(
          'github_workflow_write_failed',
          `Unable to write ${relativePath}.`,
          500,
          result,
        );
      }
    }
  } catch (error) {
    if (error instanceof SetupGithubError) throw error;
    throw new SetupGithubError(
      'github_workflow_write_failed',
      'Unable to create .github/workflows.',
      500,
      result,
    );
  }

  result.gitignore = await updateGitignore(gitRepoRoot, fileOps);
  if (result.gitignore.status === 'failed') {
    result.warnings.push('Failed to update .gitignore.');
  }
  return result;
}

export async function updateGitignore(
  gitRepoRoot: string,
  fileOps: SetupGithubFileOps = nodeFileOps,
): Promise<GithubSetupGitignoreResult> {
  try {
    const existingContent = await fileOps.readTextFile(
      gitRepoRoot,
      '.gitignore',
    );
    if (existingContent === undefined) {
      const content = GITIGNORE_ENTRIES.join('\n') + '\n';
      await fileOps.writeTextFile(gitRepoRoot, '.gitignore', content);
      return {
        path: '.gitignore',
        status: 'created',
        added: [...GITIGNORE_ENTRIES],
      };
    }

    const missingEntries = GITIGNORE_ENTRIES.filter(
      (entry) =>
        !existingContent
          .split(/\r?\n/)
          .some((line) => line.split('#')[0].trim() === entry),
    );
    if (missingEntries.length === 0) {
      return { path: '.gitignore', status: 'unchanged' };
    }

    const nextContent =
      existingContent + '\n' + missingEntries.join('\n') + '\n';
    await fileOps.writeTextFile(gitRepoRoot, '.gitignore', nextContent);
    return {
      path: '.gitignore',
      status: 'updated',
      added: missingEntries,
    };
  } catch (error) {
    debugLogger.debug('Failed to update .gitignore:', error);
    return {
      path: '.gitignore',
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function downloadWorkflows(options: {
  releaseTag: string;
  proxy?: string;
  abortSignal?: AbortSignal;
  fetchImpl: typeof fetch;
}): Promise<Array<{ sourcePath: string; content: string }>> {
  const internalAbort = new AbortController();
  try {
    const dispatcher = options.proxy
      ? new ProxyAgent(options.proxy)
      : undefined;
    return await Promise.all(
      GITHUB_WORKFLOW_PATHS.map(async (workflow) => {
        const endpoint = `https://raw.githubusercontent.com/QwenLM/qwen-code-action/refs/tags/${options.releaseTag}/examples/workflows/${workflow}`;
        const response = await options.fetchImpl(endpoint, {
          method: 'GET',
          dispatcher,
          signal: AbortSignal.any([
            AbortSignal.timeout(30_000),
            internalAbort.signal,
            ...(options.abortSignal ? [options.abortSignal] : []),
          ]),
        } as RequestInit);

        if (!response.ok) {
          throw new Error(
            `Invalid response code downloading ${endpoint}: ${response.status} - ${response.statusText}`,
          );
        }
        return { sourcePath: workflow, content: await response.text() };
      }),
    );
  } catch (error) {
    internalAbort.abort();
    const message = error instanceof Error ? error.message : String(error);
    debugLogger.debug('Failed to download qwen-code-action workflows:', error);
    throw new SetupGithubError(
      'github_workflow_download_failed',
      `Unable to download qwen-code-action workflows from GitHub. ${message}`,
      502,
    );
  }
}

function resolveSecretsUrl(cwd: string): string | undefined {
  try {
    const repoInfo = getGitHubRepoInfo({ cwd });
    return `https://github.com/${repoInfo.owner}/${repoInfo.repo}/settings/secrets/actions`;
  } catch {
    return undefined;
  }
}

async function realpathOrResolve(input: string): Promise<string> {
  try {
    return await fsp.realpath(input);
  } catch {
    return path.resolve(input);
  }
}
