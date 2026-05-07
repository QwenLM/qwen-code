/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type {
  CLIControlRequest,
  CLIControlResponse,
  CLIUserMessage,
  PermissionMode,
} from '../nonInteractive/types.js';
import type { RemoteChildMessage } from './protocol.js';

export interface ChildProcessLike {
  pid?: number;
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  once(
    event: 'exit',
    listener: (code: number | null, signal: string | null) => void,
  ): this;
  once(event: 'error', listener: (error: Error) => void): this;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type RunnerSpawnFn = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ChildProcessLike;

export interface RemoteSessionRunnerOptions {
  sessionId: string;
  cwd: string;
  cliEntryPath: string;
  model?: string;
  permissionMode?: PermissionMode;
  env?: NodeJS.ProcessEnv;
  spawnFn?: RunnerSpawnFn;
  onMessage: (message: RemoteChildMessage) => void;
  onStderr?: (line: string) => void;
  onExit?: (exit: { code: number | null; signal: string | null }) => void;
  onError?: (error: Error) => void;
}

export class RemoteSessionRunner {
  private readonly options: RemoteSessionRunnerOptions;
  private readonly spawnFn: RunnerSpawnFn;
  private child: ChildProcessLike | null = null;
  private stdoutReader: Interface | null = null;
  private stderrReader: Interface | null = null;
  private closed = false;
  private initializeRequestId: string | null = null;

  constructor(options: RemoteSessionRunnerOptions) {
    this.options = options;
    this.spawnFn =
      options.spawnFn ??
      ((command, args, spawnOptions) =>
        spawn(command, args, spawnOptions) as ChildProcessLike);
  }

  start(): void {
    if (this.child) {
      return;
    }

    const args = this.buildArgs();
    const child = this.spawnFn(process.execPath, args, {
      cwd: this.options.cwd,
      env: {
        ...process.env,
        ...this.options.env,
        QWEN_REMOTE_CONTROL: '1',
      },
    });

    this.child = child;
    this.stdoutReader = createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    this.stderrReader = createInterface({
      input: child.stderr,
      crlfDelay: Infinity,
    });

    this.stdoutReader.on('line', (line) => this.handleStdoutLine(line));
    this.stderrReader.on('line', (line) => this.options.onStderr?.(line));
    child.once('exit', (code, signal) => {
      this.closed = true;
      this.options.onExit?.({ code, signal });
    });
    child.once('error', (error) => {
      this.closed = true;
      this.options.onError?.(error);
    });

    this.initializeRequestId = `init-${randomUUID()}`;
    this.sendJson({
      type: 'control_request',
      request_id: this.initializeRequestId,
      request: {
        subtype: 'initialize',
        hooks: null,
        sdkMcpServers: {},
        mcpServers: {},
        agents: [],
      },
    } satisfies CLIControlRequest);
  }

  getPid(): number | undefined {
    return this.child?.pid;
  }

  getInitializeRequestId(): string | null {
    return this.initializeRequestId;
  }

  submit(text: string): void {
    const message: CLIUserMessage = {
      type: 'user',
      uuid: randomUUID(),
      session_id: this.options.sessionId,
      message: {
        role: 'user',
        content: text,
      },
      parent_tool_use_id: null,
    };
    this.sendJson(message);
  }

  respondToTool(params: {
    requestId: string;
    behavior: 'allow' | 'deny';
    message?: string;
    updatedInput?: unknown;
  }): void {
    const responsePayload: Record<string, unknown> = {
      behavior: params.behavior,
    };
    if (params.message) {
      responsePayload['message'] = params.message;
    }
    if (params.updatedInput !== undefined) {
      responsePayload['updatedInput'] = params.updatedInput;
    }

    this.sendJson({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: params.requestId,
        response: responsePayload,
      },
    } satisfies CLIControlResponse);
  }

  interrupt(): string {
    return this.sendControlRequest({ subtype: 'interrupt' });
  }

  setModel(model: string): string {
    return this.sendControlRequest({ subtype: 'set_model', model });
  }

  setPermissionMode(mode: PermissionMode): string {
    return this.sendControlRequest({ subtype: 'set_permission_mode', mode });
  }

  getContextUsage(showDetails: boolean = false): string {
    return this.sendControlRequest({
      subtype: 'get_context_usage',
      show_details: showDetails,
    });
  }

  close(): void {
    this.closed = true;
    this.stdoutReader?.close();
    this.stderrReader?.close();
    if (this.child) {
      this.child.kill('SIGTERM');
    }
  }

  private sendControlRequest(request: CLIControlRequest['request']): string {
    const requestId = randomUUID();
    this.sendJson({
      type: 'control_request',
      request_id: requestId,
      request,
    } satisfies CLIControlRequest);
    return requestId;
  }

  private sendJson(value: unknown): void {
    if (!this.child || this.closed) {
      throw new Error('Remote session runner is not running');
    }
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private handleStdoutLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    try {
      this.options.onMessage(JSON.parse(trimmed) as RemoteChildMessage);
    } catch (error) {
      this.options.onError?.(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private buildArgs(): string[] {
    const args = [
      this.options.cliEntryPath,
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--session-id',
      this.options.sessionId,
    ];
    if (this.options.model) {
      args.push('--model', this.options.model);
    }
    if (this.options.permissionMode) {
      args.push('--approval-mode', this.options.permissionMode);
    }
    return args;
  }
}
