/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import type { Application, Request, Response } from 'express';
import {
  SshWorkspaceClient,
  quoteSshArgument,
} from '@qwen-code/qwen-code-core/services/ssh-workspace.js';
import {
  MAX_FILES,
  MAX_FILES_FOR_DETAILS,
  MAX_DIFF_SIZE_BYTES,
  MAX_LINES_PER_FILE,
  parseDeletedFromNameStatus,
  parseGitDiff,
  parseGitNumstat,
  parseStatusBranchLine,
  parseStatusEntries,
} from '@qwen-code/qwen-code-core/utils/gitDiff.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  isPortableAbsolutePath,
  resolveManagedWorkspaceRuntimeByPathSelector,
  resolveWorkspaceEntryFromParam,
  resolveWorkspaceRuntimeFromParam,
  requireTrustedWorkspaceRuntime,
  sendGenerationClosedError,
} from '../workspace-route-runtime.js';
import { applyReadHeaders } from './workspace-file-read.js';

export function rejectSshWorkspaceOperation(
  res: Response,
  error = 'This operation is not supported for SSH workspaces. Use the remote agent or SSH terminal for project commands.',
): void {
  res.status(501).json({ code: 'ssh_workspace_operation_unsupported', error });
}

function relativeGitPath(value: unknown): string | undefined {
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    !path.posix.isAbsolute(value) &&
    !/^[a-zA-Z]:/.test(value) &&
    !value.split('/').includes('..') &&
    !value.includes('\0')
    ? path.posix.normalize(value)
    : undefined;
}

function isSshPassthroughRoute(req: Request): boolean {
  switch (req.method) {
    case 'GET':
      return /^\/(?:acp|file(?:\/bytes)?|stat|list|glob|trust|voice|runtime\/status|permissions|settings|providers|tools|sessions(?:\/(?:search|live-state))?|session-info|session-groups|session\/[^/]+\/(?:export|archive\/export|transcript|turn-index|tool-calls))$/.test(
        req.path,
      );
    case 'POST':
      return /^\/(?:acp|voice(?:\/transcribe)?|file\/(?:write|edit|upload)|trust\/request|runtime\/(?:ensure|stop)|permissions|settings|sessions\/(?:delete|archive|unarchive)|session-groups)$/.test(
        req.path,
      );
    case 'PATCH':
      return /^\/(?:session\/[^/]+\/(?:metadata|organization)|session-groups\/[^/]+)$/.test(
        req.path,
      );
    case 'DELETE':
      return /^\/(?:acp|session-groups\/[^/]+)$/.test(req.path);
    default:
      return false;
  }
}

async function serveSshGit(
  req: Request,
  res: Response,
  runtime: WorkspaceRuntime,
): Promise<void> {
  applyReadHeaders(res);
  const connection = runtime.routeFileSystemFactory.sshWorkspace!;
  const client = new SshWorkspaceClient(connection);
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)]);
  const onClose = () => {
    if (!res.writableEnded) abort.abort();
  };
  res.once('close', onClose);
  try {
    runtime.generationGuard?.assertOpen();
    if (
      req.query['cwd'] !== undefined &&
      req.query['cwd'] !== runtime.workspaceCwd
    ) {
      rejectSshWorkspaceOperation(res);
      return;
    }
    const filename = relativeGitPath(req.query['path']);
    const oldPath = relativeGitPath(req.query['oldPath']);
    if (
      req.path === '/git/diff/file' &&
      (!filename || (req.query['oldPath'] !== undefined && !oldPath))
    ) {
      res.status(400).json({
        code: 'invalid_path',
        error: 'A relative remote file path is required.',
      });
      return;
    }
    const gitCommand = (args: string[]) =>
      [
        'python3',
        '-c',
        "import os,sys; env={k:v for k,v in os.environ.items() if not k.startswith('GIT_')}; env['LC_ALL']='C'; os.execvpe('git',['git']+sys.argv[1:],env)",
        '--no-pager',
        '--no-optional-locks',
        '--literal-pathspecs',
        '-c',
        'core.fsmonitor=false',
        '-c',
        'core.hooksPath=/dev/null',
        ...args,
      ]
        .map(quoteSshArgument)
        .join(' ');
    const run = async (command: string, allowFailure = false) => {
      runtime.generationGuard?.assertOpen();
      const result = await client.execute(command, {
        signal,
        timeoutMs: 15_000,
      });
      runtime.generationGuard?.assertOpen();
      if (result.exitCode !== 0 && !allowFailure)
        throw new Error(result.stderr || 'Remote Git command failed.');
      return result;
    };
    const git = (args: string[], allowFailure = false) =>
      run(gitCommand(args), allowFailure);
    const emptyDiff = () => ({
      v: 1,
      workspaceCwd: runtime.workspaceCwd,
      available: false,
      ...(req.path === '/git/diff/file'
        ? { path: req.query['path'], hunks: [] }
        : {
            filesCount: 0,
            linesAdded: 0,
            linesRemoved: 0,
            files: [],
            hiddenCount: 0,
          }),
    });
    const repository = await git(['rev-parse', '--is-inside-work-tree'], true);
    if (repository.exitCode !== 0) {
      if (!repository.stderr.includes('not a git repository'))
        throw new Error(
          repository.stderr || 'Remote Git repository is unavailable.',
        );
      res.json(
        req.path === '/git'
          ? { v: 2, workspaceCwd: runtime.workspaceCwd, branch: null }
          : emptyDiff(),
      );
      return;
    }
    if (repository.stdout.trim() !== 'true') {
      rejectSshWorkspaceOperation(
        res,
        'SSH Git inspection requires a working tree.',
      );
      return;
    }
    const status = await git([
      'status',
      '--porcelain=v1',
      '--branch',
      '-z',
      '--',
      '.',
    ]);
    const tokens = status.stdout.split('\0').filter(Boolean);
    const header = tokens.shift() ?? '';
    const branch = parseStatusBranchLine(header);
    const counts = parseStatusEntries(tokens);
    const operationNames = {
      'rebase-merge': 'rebase',
      'rebase-apply': 'rebase',
      MERGE_HEAD: 'merge',
      CHERRY_PICK_HEAD: 'cherry-pick',
      REVERT_HEAD: 'revert',
      BISECT_LOG: 'bisect',
    } as const;
    const operationResult = await run(
      `for marker in ${Object.keys(operationNames).map(quoteSshArgument).join(' ')}; do location=$(${gitCommand(['rev-parse', '--git-path'])} "$marker") || exit; if test -e "$location"; then printf '%s' "$marker"; break; fi; done; exit 0`,
    );
    const operation =
      operationNames[operationResult.stdout as keyof typeof operationNames];
    if (req.path === '/git') {
      const stash = await git(['stash', 'list', '--format=%H']);
      res.json({
        v: 2,
        workspaceCwd: runtime.workspaceCwd,
        ...branch,
        ...counts,
        stashCount: stash.stdout.split('\n').filter(Boolean).length,
        computedAt: Date.now(),
        ...(operation ? { operation } : {}),
      });
      return;
    }
    if ((operation && operation !== 'bisect') || counts.conflicted > 0) {
      res.json(emptyDiff());
      return;
    }
    const unborn = /^## (?:No commits yet|Initial commit) on /.test(header);
    const base = unborn
      ? (await git(['hash-object', '-t', 'tree', '/dev/null'])).stdout.trim()
      : 'HEAD';
    const diffArgs = [
      'diff',
      '--relative',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      base,
    ];
    const untracked = (
      await git(['ls-files', '--others', '--exclude-standard', '-z', '--', '.'])
    ).stdout
      .split('\0')
      .filter(Boolean);
    const readUntracked = async (name: string) => {
      const [read] = await client.request<
        Array<{ lines?: string[]; truncated: boolean }>
      >(
        'gitUntrackedStats',
        {
          paths: [name],
          maxBytes: MAX_DIFF_SIZE_BYTES,
          maxLines: MAX_LINES_PER_FILE,
        },
        signal,
      );
      runtime.generationGuard?.assertOpen();
      return { lines: read!.lines ?? [], truncated: read!.truncated };
    };
    if (req.path === '/git/diff') {
      const result = parseGitNumstat(
        (await git([...diffArgs, '--numstat', '-z', '--', '.'])).stdout,
      );
      if (result.stats.filesCount + untracked.length > MAX_FILES_FOR_DETAILS) {
        const filesCount = result.stats.filesCount + untracked.length;
        res.json({
          v: 1,
          workspaceCwd: runtime.workspaceCwd,
          available: true,
          ...result.stats,
          filesCount,
          files: [],
          hiddenCount: filesCount,
        });
        return;
      }
      const deleted = parseDeletedFromNameStatus(
        (await git([...diffArgs, '--name-status', '-z', '--', '.'])).stdout,
      );
      for (const [name, stats] of result.perFileStats)
        if (deleted.has(name)) stats.isDeleted = true;
      const untrackedStats = untracked.length
        ? await client.request<
            Array<{
              path: string;
              added: number;
              isBinary: boolean;
              truncated: boolean;
            }>
          >(
            'gitUntrackedStats',
            { paths: untracked, maxBytes: MAX_DIFF_SIZE_BYTES },
            signal,
          )
        : [];
      for (const stats of untrackedStats) {
        result.stats.linesAdded += stats.added;
        if (result.perFileStats.size < MAX_FILES) {
          result.perFileStats.set(stats.path, {
            added: stats.added,
            removed: 0,
            isBinary: stats.isBinary,
            isUntracked: true,
            truncated: stats.truncated,
          });
        }
      }
      result.stats.filesCount += untracked.length;
      runtime.generationGuard?.assertOpen();
      res.json({
        v: 1,
        workspaceCwd: runtime.workspaceCwd,
        available: true,
        ...result.stats,
        files: [...result.perFileStats].map(([name, stats]) => ({
          path: name,
          ...stats,
          isUntracked: stats.isUntracked ?? false,
          isDeleted: stats.isDeleted ?? false,
          truncated: stats.truncated ?? false,
        })),
        hiddenCount: Math.max(
          0,
          result.stats.filesCount - result.perFileStats.size,
        ),
      });
      return;
    }
    if (untracked.includes(filename!)) {
      const read = await readUntracked(filename!);
      runtime.generationGuard?.assertOpen();
      const lines = read.lines.slice(0, MAX_LINES_PER_FILE);
      res.json({
        v: 1,
        workspaceCwd: runtime.workspaceCwd,
        path: req.query['path'],
        available: lines.length > 0,
        ...(read.truncated || read.lines.length > lines.length
          ? { truncated: true }
          : {}),
        hunks: lines.length
          ? [
              {
                oldStart: 0,
                oldLines: 0,
                newStart: 1,
                newLines: lines.length,
                lines: lines.map((line) => '+' + line),
              },
            ]
          : [],
      });
      return;
    }
    const truncated = new Set<string>();
    const diff = await git([
      ...diffArgs,
      '--find-renames',
      '--',
      ...(oldPath ? [oldPath] : []),
      filename!,
    ]);
    const hunks = parseGitDiff(diff.stdout, truncated).get(filename!) ?? [];
    res.json({
      v: 1,
      workspaceCwd: runtime.workspaceCwd,
      path: req.query['path'],
      available: hunks.length > 0,
      hunks,
      ...(truncated.has(filename!) ? { truncated: true } : {}),
    });
  } catch (error) {
    if (!res.headersSent && !sendGenerationClosedError(res, error)) {
      res.status(503).json({
        code: 'ssh_workspace_unavailable',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  } finally {
    res.off('close', onClose);
    client.dispose();
  }
}

export function registerSshWorkspaceBoundary(
  app: Application,
  registry: WorkspaceRegistry,
): void {
  app.use('/workspaces/:workspace', (req, res, next) => {
    const selector = req.params['workspace'] ?? '';
    const candidate =
      registry.getEntryByWorkspaceId(selector)?.current?.runtime ??
      (isPortableAbsolutePath(selector)
        ? resolveManagedWorkspaceRuntimeByPathSelector(registry, selector)
        : undefined);
    if (!candidate?.routeFileSystemFactory?.sshWorkspace) {
      next();
      return;
    }
    const entry = resolveWorkspaceEntryFromParam(registry, req, res);
    if (!entry) return;
    if (!entry.current?.runtime.routeFileSystemFactory?.sshWorkspace) {
      next();
      return;
    }
    if (req.path === '/' && ['DELETE', 'PATCH', 'GET'].includes(req.method)) {
      next();
      return;
    }
    if (isSshPassthroughRoute(req)) {
      next();
      return;
    }
    const runtime = resolveWorkspaceRuntimeFromParam(registry, req, res);
    if (!runtime) return;
    if (
      req.method === 'GET' &&
      /^\/git(?:\/diff(?:\/file)?)?$/.test(req.path)
    ) {
      if (!requireTrustedWorkspaceRuntime(runtime, res)) return;
      void serveSshGit(req, res, runtime);
      return;
    }
    rejectSshWorkspaceOperation(res);
  });
}
