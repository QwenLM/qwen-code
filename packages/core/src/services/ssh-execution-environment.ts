/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import type { PermissionDecision } from '../permissions/types.js';
import { createPatchSmart } from '../tools/diffOptions.js';
import { ToolNames } from '../tools/tool-names.js';
import { ToolErrorType } from '../tools/tool-error.js';
import {
  ToolConfirmationOutcome,
  type ToolConfirmationPayload,
  type ToolResult,
  type ToolResultDisplay,
} from '../tools/tools.js';
import type {
  ExecutionConfirmation,
  ExecutionEnvironment,
  ExecutionPreparation,
  PreparedExecution,
} from './execution-environment.js';
import {
  SshWorkspaceClient,
  SshWorkspaceError,
  type SshWorkspace,
} from './ssh-workspace.js';

export const SSH_EXECUTION_TOOL_NAMES: ReadonlySet<string> = new Set([
  ToolNames.READ_FILE,
  ToolNames.WRITE_FILE,
  ToolNames.EDIT,
  ToolNames.GLOB,
  ToolNames.GREP,
  ToolNames.LS,
  ToolNames.SHELL,
]);

const MAX_OUTPUT_CHARS = 16_000;

interface RemoteRead {
  content: string;
  hash: string;
  sizeBytes: number;
}

interface Change {
  current: string | null;
  proposed: string;
  hash?: string;
}

interface PendingExecution {
  toolName: string;
  params: Record<string, unknown>;
  change?: Change;
  executing: boolean;
}

function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string') throw new Error(`${key} must be a string.`);
  return value;
}

function isWrite(toolName: string): boolean {
  return toolName === ToolNames.WRITE_FILE || toolName === ToolNames.EDIT;
}

function bounded(text: string): string {
  return text.length <= MAX_OUTPUT_CHARS
    ? text
    : `${text.slice(0, MAX_OUTPUT_CHARS)}\n[SSH output truncated; narrow the request to see the remaining content.]`;
}

function result(text: string): ToolResult {
  const output = bounded(text);
  return {
    llmContent: output,
    returnDisplay: output,
    outputBudgetApplied: true,
    persistedOutputFiles: [],
    resultFilePaths: [],
  };
}

export class SshExecutionEnvironment implements ExecutionEnvironment {
  readonly toolNames = SSH_EXECUTION_TOOL_NAMES;
  private readonly client: SshWorkspaceClient;
  private readonly invocations = new Map<string, PendingExecution>();
  private readonly readHashes = new Map<string, string>();
  private readonly shutdown = new AbortController();

  constructor(
    private readonly workspace: SshWorkspace,
    private readonly localWorkspace: string,
  ) {
    this.client = new SshWorkspaceClient(workspace);
  }

  private signal(signal: AbortSignal): AbortSignal {
    const combined = AbortSignal.any([signal, this.shutdown.signal]);
    combined.throwIfAborted();
    return combined;
  }

  private remotePath(value: string): string {
    if (value.includes('\0')) throw new Error('Invalid SSH workspace path.');
    const anchor = path.resolve(this.localWorkspace);
    if (path.isAbsolute(value)) {
      const relative = path.relative(anchor, value);
      if (
        relative === '' ||
        (!path.isAbsolute(relative) &&
          relative !== '..' &&
          !relative.startsWith(`..${path.sep}`))
      ) {
        value = relative.split(path.sep).join('/');
      }
    }
    const resolved = path.posix.resolve(this.workspace.directory, value);
    const relative = path.posix.relative(this.workspace.directory, resolved);
    if (relative === '..' || relative.startsWith('../')) {
      throw new Error('Path is outside the SSH workspace.');
    }
    return resolved;
  }

  private pending(id: string): PendingExecution {
    this.shutdown.signal.throwIfAborted();
    const pending = this.invocations.get(id);
    if (!pending) throw new Error(`Unknown SSH tool invocation: ${id}`);
    if (pending.executing) throw new Error('SSH tool is already executing.');
    return pending;
  }

  async prepare(
    request: ExecutionPreparation,
    signal: AbortSignal,
  ): Promise<PreparedExecution> {
    signal = this.signal(signal);
    if (!this.toolNames.has(request.toolName)) {
      throw new Error(
        `Tool is unavailable for SSH workspaces: ${request.toolName}`,
      );
    }
    if (this.invocations.has(request.id))
      throw new Error('Duplicate SSH invocation.');
    if (this.invocations.size >= 256)
      throw new Error('Too many pending SSH tools.');
    const params = structuredClone(request.params);
    const field =
      request.toolName === ToolNames.SHELL
        ? 'directory'
        : isWrite(request.toolName) || request.toolName === ToolNames.READ_FILE
          ? 'file_path'
          : 'path';
    params[field] = this.remotePath(
      params[field] === undefined ? '' : stringParam(params, field),
    );
    if (request.toolName === ToolNames.SHELL) {
      stringParam(params, 'command');
      if (params['is_background'])
        throw new Error('Background SSH commands are unavailable.');
      this.nonNegativeInteger(params, 'timeout');
      if (params['timeout'] === 0)
        throw new Error('SSH commands require a positive timeout.');
    }
    if (request.toolName === ToolNames.READ_FILE) {
      if (params['pages'] !== undefined)
        throw new Error(
          'SSH read_file supports UTF-8 text, not PDF page extraction.',
        );
      this.nonNegativeInteger(params, 'offset');
      this.nonNegativeInteger(params, 'limit');
    }
    if (request.toolName === ToolNames.GREP)
      this.nonNegativeInteger(params, 'limit');
    if (request.toolName === ToolNames.LS) {
      if (
        params['ignore'] !== undefined ||
        params['file_filtering_options'] !== undefined
      ) {
        throw new Error(
          'Custom directory filtering is unavailable for SSH workspaces.',
        );
      }
    }
    if (params['record_as_artifact'] === true)
      throw new Error('SSH artifact registration is unavailable.');
    const pending: PendingExecution = {
      toolName: request.toolName,
      params,
      executing: false,
    };
    this.invocations.set(request.id, pending);
    try {
      if (isWrite(request.toolName)) {
        pending.change = await this.prepareChange(
          request.toolName,
          params,
          signal,
        );
        if (request.modification) {
          if (
            request.modification.oldContent !== (pending.change.current ?? '')
          ) {
            throw new Error(
              'The file changed while modifying the proposal. Read it again.',
            );
          }
          pending.change.proposed = request.modification.newContent;
          params['modified_by_user'] = true;
          if (request.toolName === ToolNames.WRITE_FILE) {
            params['content'] = request.modification.newContent;
          } else {
            params['old_string'] = pending.change.current ?? '';
            params['new_string'] = request.modification.newContent;
          }
        }
      } else if (request.modification) {
        throw new Error('This SSH tool does not support modification.');
      }
      signal.throwIfAborted();
      if (!this.invocations.has(request.id))
        throw new Error('SSH invocation was released.');
      return {
        params,
        description: `${request.toolName} on ${this.workspace.host}: ${String(params[field])}`,
        locations: [{ path: String(params[field]) }],
      };
    } catch (error) {
      this.invocations.delete(request.id);
      throw error;
    }
  }

  private nonNegativeInteger(
    params: Record<string, unknown>,
    key: string,
  ): void {
    const value = params[key];
    if (
      value !== undefined &&
      (typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > 2_147_483_647)
    ) {
      throw new Error(`${key} must be a non-negative 32-bit integer.`);
    }
  }

  private async prepareChange(
    toolName: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Change> {
    const filePath = this.remotePath(stringParam(params, 'file_path'));
    let read: RemoteRead | undefined;
    try {
      read = await this.client.request<RemoteRead>(
        'read',
        { path: filePath },
        signal,
      );
    } catch (error) {
      if (
        !(error instanceof SshWorkspaceError) ||
        error.code !== 'path_not_found'
      )
        throw error;
    }
    if (read && this.readHashes.get(filePath) !== read.hash) {
      throw new Error(
        'Read the remote file with read_file before editing or overwriting it; it is unread or changed since the last read.',
      );
    }
    if (toolName === ToolNames.WRITE_FILE) {
      return {
        current: read?.content ?? null,
        proposed: stringParam(params, 'content'),
        hash: read?.hash,
      };
    }
    const oldString = stringParam(params, 'old_string');
    const newString = stringParam(params, 'new_string');
    if (!read) {
      if (oldString !== '') throw new Error('Remote file does not exist.');
      return { current: null, proposed: newString };
    }
    if (!oldString)
      throw new Error('old_string must not be empty for an existing file.');
    const pieces = read.content.split(oldString);
    if (pieces.length === 1)
      throw new Error('old_string was not found in the remote file.');
    if (pieces.length > 2 && params['replace_all'] !== true)
      throw new Error(
        'old_string matches multiple locations; use replace_all or a unique match.',
      );
    return {
      current: read.content,
      proposed: pieces.join(newString),
      hash: read.hash,
    };
  }

  async permission(
    id: string,
    signal: AbortSignal,
  ): Promise<PermissionDecision> {
    this.signal(signal);
    const { toolName } = this.pending(id);
    return isWrite(toolName) || toolName === ToolNames.SHELL ? 'ask' : 'allow';
  }

  async confirmation(
    id: string,
    signal: AbortSignal,
  ): Promise<ExecutionConfirmation> {
    this.signal(signal);
    const { toolName, params, change } = this.pending(id);
    if (change) {
      const filePath = stringParam(params, 'file_path');
      const fileName = path.posix.basename(filePath);
      return {
        type: 'edit',
        title: `Confirm SSH edit on ${this.workspace.host}: ${filePath}`,
        fileName,
        filePath,
        originalContent: change.current,
        newContent: change.proposed,
        fileDiff: createPatchSmart(
          fileName,
          change.current ?? '',
          change.proposed,
          'Current',
          'Proposed',
        ),
        skipIdeDiff: true,
      };
    }
    if (toolName === ToolNames.SHELL) {
      const command = stringParam(params, 'command');
      return {
        type: 'exec',
        title: `Run on ${this.workspace.host}: ${String(params['directory'])}`,
        command,
        rootCommand: command.trim().split(/\s+/)[0] ?? '',
        warnings: [
          'This command runs on the SSH host. If the connection is interrupted, the remote command may continue running.',
        ],
      };
    }
    return {
      type: 'info',
      title: 'SSH workspace access',
      prompt: `Read from ${this.workspace.host}: ${String(params['file_path'] ?? params['path'])}`,
    };
  }

  async confirm(
    id: string,
    outcome: ToolConfirmationOutcome,
    payload: ToolConfirmationPayload | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    this.signal(signal);
    const pending = this.pending(id);
    if (outcome === ToolConfirmationOutcome.Cancel) {
      this.invocations.delete(id);
    } else if (payload?.newContent !== undefined) {
      if (!pending.change)
        throw new Error('This SSH tool cannot accept modified file content.');
      pending.change.proposed = payload.newContent;
    }
  }

  async execute(
    id: string,
    signal: AbortSignal,
    updateOutput?: (output: ToolResultDisplay) => void,
  ): Promise<ToolResult> {
    signal = this.signal(signal);
    const pending = this.pending(id);
    pending.executing = true;
    const { toolName, params, change } = pending;
    try {
      if (change) {
        const filePath = stringParam(params, 'file_path');
        const written = await this.client.request<{ hash: string }>(
          'write',
          {
            path: filePath,
            content: change.proposed,
            mode: change.current === null ? 'create' : 'replace',
            ...(change.hash ? { expectedHash: change.hash } : {}),
          },
          signal,
        );
        this.readHashes.set(filePath, written.hash);
        return result(`Wrote ${filePath} on ${this.workspace.host}.`);
      }
      if (toolName === ToolNames.READ_FILE) {
        const filePath = stringParam(params, 'file_path');
        const read = await this.client.request<RemoteRead>(
          'read',
          { path: filePath },
          signal,
        );
        const offset = (params['offset'] as number | undefined) ?? 0;
        const limit = params['limit'] as number | undefined;
        const lines = read.content.split('\n');
        const content = lines
          .slice(offset, limit === undefined ? undefined : offset + limit)
          .join('\n');
        this.readHashes.set(filePath, read.hash);
        return result(content);
      }
      if (toolName === ToolNames.SHELL) {
        this.readHashes.clear();
        try {
          const shell = await this.client.execute(
            stringParam(params, 'command'),
            {
              directory: stringParam(params, 'directory'),
              signal,
              timeoutMs: (params['timeout'] as number | undefined) ?? 120_000,
              onOutput: updateOutput
                ? (chunk) => updateOutput(bounded(chunk))
                : undefined,
            },
          );
          const output = result(
            `Exit code: ${shell.exitCode}\n${shell.stdout}${shell.stderr ? `\n${shell.stderr}` : ''}`,
          );
          if (shell.exitCode !== 0)
            output.error = {
              message: `SSH command exited with code ${shell.exitCode}.`,
              type: ToolErrorType.EXECUTION_FAILED,
            };
          return output;
        } finally {
          this.readHashes.clear();
        }
      }
      const searchPath = stringParam(params, 'path');
      if (toolName === ToolNames.LS) {
        const entries = await this.client.request<
          Array<{ name: string; kind: string; ignored: boolean }>
        >('list', { path: searchPath }, signal);
        return result(
          entries
            .filter((entry) => !entry.ignored)
            .map(
              (entry) =>
                `${entry.kind === 'directory' ? '[DIR] ' : ''}${entry.name}`,
            )
            .join('\n'),
        );
      }
      const search = await this.client.request<{
        paths?: string[];
        text?: string;
        truncated: boolean;
      }>(
        toolName === ToolNames.GLOB ? 'glob' : 'grep',
        {
          path: searchPath,
          pattern: stringParam(params, 'pattern'),
          ...(toolName === ToolNames.GREP ? { caseSensitive: false } : {}),
          ...(params['glob'] === undefined
            ? {}
            : { glob: stringParam(params, 'glob') }),
          ...(params['limit'] === undefined ? {} : { limit: params['limit'] }),
        },
        signal,
      );
      return result(
        `${search.paths?.join('\n') ?? search.text ?? ''}${search.truncated ? '\n[Search truncated; narrow the query.]' : ''}`,
      );
    } finally {
      this.invocations.delete(id);
    }
  }

  async modificationContent(
    toolName: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<{ current: string; proposed: string }> {
    if (!isWrite(toolName))
      throw new Error('This SSH tool does not support modification.');
    const change = await this.prepareChange(
      toolName,
      params,
      this.signal(signal),
    );
    return { current: change.current ?? '', proposed: change.proposed };
  }

  async release(id: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (!this.invocations.get(id)?.executing) this.invocations.delete(id);
  }

  async invalidateReadCache(paths?: readonly string[]): Promise<void> {
    if (paths) {
      for (const filePath of paths)
        this.readHashes.delete(this.remotePath(filePath));
    } else {
      this.readHashes.clear();
    }
  }

  async dispose(): Promise<void> {
    this.shutdown.abort(new Error('SSH execution environment is disposed.'));
    this.client.dispose();
    this.invocations.clear();
    this.readHashes.clear();
  }
}
