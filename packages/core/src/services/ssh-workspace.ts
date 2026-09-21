/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { isIP } from 'node:net';
import { posix } from 'node:path';
import { SSH_WORKSPACE_SCRIPT } from './ssh-workspace-script.js';
import { getQwenIgnoreFileNames } from '../utils/qwenIgnoreParser.js';

export interface SshWorkspace {
  host: string;
  port?: number;
  directory: string;
}

export class SshWorkspaceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SshWorkspaceError';
  }
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

function validateWorkspace(workspace: SshWorkspace): void {
  const parts = workspace.host.split('@');
  const hostname = parts.at(-1)!;
  if (
    parts.length > 2 ||
    workspace.host.length > 512 ||
    (parts.length === 2 && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(parts[0]!)) ||
    (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(hostname) && isIP(hostname) !== 6)
  ) {
    throw new SshWorkspaceError('invalid_workspace', 'Invalid SSH host.');
  }
  if (
    workspace.port !== undefined &&
    (!Number.isInteger(workspace.port) ||
      workspace.port < 1 ||
      workspace.port > 65535)
  ) {
    throw new SshWorkspaceError('invalid_workspace', 'Invalid SSH port.');
  }
  if (
    !workspace.directory.startsWith('/') ||
    workspace.directory.length > 4096 ||
    containsControlCharacter(workspace.directory)
  ) {
    throw new SshWorkspaceError(
      'invalid_workspace',
      'SSH workspace directory must be an absolute Linux path without control characters.',
    );
  }
}

export function parseSshWorkspaceUrl(value: string): SshWorkspace {
  try {
    if (
      !value.startsWith('ssh://') ||
      containsControlCharacter(value) ||
      value.includes(' ')
    ) {
      throw new Error('Invalid SSH URL.');
    }
    const url = new URL(value);
    const authority = value.slice(6).split('/')[0]!;
    const userInfo = authority.includes('@') ? authority.split('@')[0]! : '';
    if (
      url.protocol !== 'ssh:' ||
      url.password ||
      userInfo.includes(':') ||
      authority.startsWith('@') ||
      value.includes('?') ||
      value.includes('#') ||
      !url.pathname.startsWith('/')
    ) {
      throw new Error(
        'SSH URLs cannot contain passwords, queries or fragments.',
      );
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const workspace: SshWorkspace = {
      host: url.username
        ? `${decodeURIComponent(url.username)}@${hostname}`
        : hostname,
      ...(url.port ? { port: Number(url.port) } : {}),
      directory: posix.normalize(decodeURIComponent(url.pathname)),
    };
    validateWorkspace(workspace);
    return workspace;
  } catch (error) {
    if (error instanceof SshWorkspaceError) throw error;
    throw new SshWorkspaceError(
      'invalid_workspace',
      'Use ssh://[user@]host[:port]/absolute/path without a password, query or fragment.',
    );
  }
}

export function formatSshWorkspaceUrl(workspace: SshWorkspace): string {
  validateWorkspace(workspace);
  const parts = workspace.host.split('@');
  const hostname = parts.at(-1)!;
  const host = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  const user = parts.length === 2 ? `${encodeURIComponent(parts[0]!)}@` : '';
  const port = workspace.port === undefined ? '' : `:${workspace.port}`;
  const directory = posix
    .normalize(workspace.directory)
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  return `ssh://${user}${host}${port}${directory}`;
}

export function quoteSshArgument(value: string): string {
  if (value.includes('\0')) {
    throw new SshWorkspaceError(
      'invalid_argument',
      'SSH arguments cannot contain NUL.',
    );
  }
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function sshCommand(
  workspace: SshWorkspace,
  remoteCommand: string,
  tty = false,
): { file: string; args: string[] } {
  validateWorkspace(workspace);
  if (remoteCommand.includes('\0')) {
    throw new SshWorkspaceError(
      'invalid_argument',
      'SSH commands cannot contain NUL.',
    );
  }
  return {
    file: 'ssh',
    args: [
      tty ? '-tt' : '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'ConnectionAttempts=1',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
      '-o',
      'ForwardAgent=no',
      '-o',
      'ClearAllForwardings=yes',
      ...(workspace.port === undefined ? [] : ['-p', String(workspace.port)]),
      '--',
      workspace.host,
      remoteCommand,
    ],
  };
}

const MAX_TRANSPORT_BYTES = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const UNCERTAIN_STATUS =
  'The remote command may still be running or may have completed; its status is uncertain. It was not retried.';

interface ExecuteOptions {
  directory?: string;
  signal?: AbortSignal;
  onOutput?: (text: string) => void;
  timeoutMs?: number;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class SshWorkspaceClient {
  readonly workspace: SshWorkspace;
  private readonly pending = new Set<() => void>();
  private disposed = false;
  private readonly ignoreFiles: string[];

  constructor(workspace: SshWorkspace, customIgnoreFiles?: readonly string[]) {
    validateWorkspace(workspace);
    this.ignoreFiles = getQwenIgnoreFileNames(customIgnoreFiles);
    this.workspace = Object.freeze({
      ...workspace,
      directory: posix.normalize(workspace.directory),
    });
  }

  async request<T>(
    operation: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (operation === 'execute') {
      throw new SshWorkspaceError(
        'invalid_operation',
        'Use execute() for shell commands.',
      );
    }
    const result = await this.run(
      operation,
      ['list', 'glob', 'grep'].includes(operation)
        ? { ...params, ignoreFiles: this.ignoreFiles }
        : params,
      { signal },
    );
    if (result.exitCode !== 0) {
      throw new SshWorkspaceError(
        'remote_failed',
        `Remote filesystem request failed (${result.exitCode}): ${result.stderr.slice(0, 2048)}`,
      );
    }
    let envelope: {
      ok?: boolean;
      result?: T;
      error?: { code?: string; message?: string };
    };
    try {
      envelope = JSON.parse(result.stdout) as typeof envelope;
    } catch {
      throw new SshWorkspaceError(
        'invalid_response',
        'The SSH host returned an invalid filesystem response.',
      );
    }
    if (!envelope || envelope.ok !== true) {
      throw new SshWorkspaceError(
        envelope?.error?.code ?? 'remote_failed',
        envelope?.error?.message ?? 'Remote filesystem request failed.',
      );
    }
    return envelope.result as T;
  }

  execute(
    command: string,
    options: ExecuteOptions = {},
  ): Promise<CommandResult> {
    if (command.includes('\0')) {
      return Promise.reject(
        new SshWorkspaceError(
          'invalid_argument',
          'Shell commands cannot contain NUL.',
        ),
      );
    }
    return this.run('execute', { command, path: options.directory }, options);
  }

  dispose(): void {
    this.disposed = true;
    for (const cancel of this.pending) cancel();
  }

  private run(
    operation: string,
    params: Record<string, unknown>,
    options: ExecuteOptions,
  ): Promise<CommandResult> {
    if (this.disposed || options.signal?.aborted) {
      return Promise.reject(
        new SshWorkspaceError(
          'cancelled',
          'SSH request was cancelled before starting.',
        ),
      );
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 0 ||
      timeoutMs > 2_147_483_647
    ) {
      return Promise.reject(
        new SshWorkspaceError(
          'invalid_argument',
          'SSH timeout must be an integer between 0 and 2147483647 milliseconds.',
        ),
      );
    }
    const input = JSON.stringify({
      root: this.workspace.directory,
      operation,
      params,
    });
    if (Buffer.byteLength(input) > MAX_TRANSPORT_BYTES) {
      return Promise.reject(
        new SshWorkspaceError(
          'too_large',
          'SSH request exceeds the 32 MiB limit.',
        ),
      );
    }
    const launch = sshCommand(
      this.workspace,
      `python3 -c ${quoteSshArgument(SSH_WORKSPACE_SCRIPT)}`,
    );
    return new Promise((resolve, reject) => {
      const child = spawn(launch.file, launch.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      let settled = false;
      let size = 0;
      let stdout = '';
      let stderr = '';
      let frames = '';
      let remoteExitCode: number | undefined;
      let remoteError: { code: string; message: string } | undefined;
      let sendError: Error | undefined;
      const decoders = {
        stdout: new StringDecoder('utf8'),
        stderr: new StringDecoder('utf8'),
      };
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', cancel);
        this.pending.delete(cancel);
      };
      const fail = (code: string, message: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (child.exitCode === null && child.signalCode === null) {
          if (process.platform !== 'win32' && child.pid) {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {
              child.kill('SIGKILL');
            }
          } else {
            child.kill('SIGKILL');
          }
        }
        reject(new SshWorkspaceError(code, `${message} ${UNCERTAIN_STATUS}`));
      };
      const cancel = () => fail('cancelled', 'SSH request was cancelled.');
      const timer =
        timeoutMs === 0
          ? undefined
          : setTimeout(
              () => fail('timeout', 'SSH request timed out.'),
              timeoutMs,
            );
      this.pending.add(cancel);
      options.signal?.addEventListener('abort', cancel, { once: true });
      const append = (chunk: string, stream: 'stdout' | 'stderr') => {
        if (stream === 'stdout') stdout += chunk;
        else stderr += chunk;
        options.onOutput?.(chunk);
      };
      const receive = (chunk: string, stream: 'stdout' | 'stderr') => {
        if (settled) return;
        size += Buffer.byteLength(chunk);
        if (size > MAX_TRANSPORT_BYTES) {
          fail('output_limit', 'SSH output exceeded the 32 MiB limit.');
          return;
        }
        try {
          if (operation !== 'execute' || stream === 'stderr') {
            append(chunk, stream);
            return;
          }
          frames += chunk;
          let end: number;
          while ((end = frames.indexOf('\n')) !== -1) {
            const frame = JSON.parse(frames.slice(0, end)) as {
              stream?: 'stdout' | 'stderr';
              data?: string;
              ok?: boolean;
              result?: { exitCode?: number };
              error?: { code: string; message: string };
            };
            frames = frames.slice(end + 1);
            if (remoteExitCode !== undefined || remoteError)
              throw new Error('Unexpected trailing frame.');
            if (
              (frame.stream === 'stdout' || frame.stream === 'stderr') &&
              typeof frame.data === 'string'
            ) {
              append(
                decoders[frame.stream].write(Buffer.from(frame.data, 'base64')),
                frame.stream,
              );
            } else if (
              frame.ok === true &&
              Number.isInteger(frame.result?.exitCode) &&
              frame.result!.exitCode! >= 0 &&
              frame.result!.exitCode! <= 255
            ) {
              remoteExitCode = frame.result!.exitCode!;
            } else if (
              frame.ok === false &&
              typeof frame.error?.code === 'string' &&
              typeof frame.error.message === 'string'
            ) {
              remoteError = frame.error;
            } else throw new Error('Invalid execution frame.');
          }
        } catch {
          fail(
            'invalid_response',
            'The SSH host returned an invalid execution response or output handling failed.',
          );
        }
      };
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => receive(chunk, 'stdout'));
      child.stderr.on('data', (chunk: string) => receive(chunk, 'stderr'));
      child.on('error', (error) =>
        fail('ssh_failed', `Could not start SSH: ${error.message}`),
      );
      child.stdin.on('error', (error: Error) => {
        sendError = error;
      });
      child.on('close', (code, signal) => {
        if (settled) return;
        if (code === null || code === 255 || signal || sendError) {
          fail(
            'ssh_failed',
            `SSH connection failed${stderr ? `: ${stderr.slice(0, 2048)}` : sendError ? `: ${sendError.message}` : '.'}`,
          );
          return;
        }
        if (operation === 'execute') {
          if (remoteError) {
            fail(remoteError.code, remoteError.message);
            return;
          }
          if (code !== 0 || frames || remoteExitCode === undefined) {
            fail(
              'invalid_response',
              'The SSH host did not confirm command completion.',
            );
            return;
          }
          stdout += decoders.stdout.end();
          stderr += decoders.stderr.end();
        }
        settled = true;
        cleanup();
        resolve({ stdout, stderr, exitCode: remoteExitCode ?? code });
      });
      if (options.signal?.aborted || this.disposed) cancel();
      else child.stdin.end(input);
    });
  }
}
