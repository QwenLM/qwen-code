/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';
import type {
  Agent,
  AuthenticateResponse,
  Client,
  ClientCapabilities,
  ContentBlock,
  InitializeResponse,
  ListSessionsResponse,
  LoadSessionResponse,
  NewSessionResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SetSessionModeResponse,
  SetSessionModelResponse,
} from '@agentclientprotocol/sdk';

type AcpSdkConnection = Pick<
  ClientSideConnection,
  | 'authenticate'
  | 'cancel'
  | 'extMethod'
  | 'initialize'
  | 'loadSession'
  | 'newSession'
  | 'prompt'
  | 'setSessionMode'
  | 'unstable_listSessions'
  | 'unstable_setSessionModel'
>;

type CreateAcpConnection = (
  clientFactory: (agent: Agent) => Client,
  stdin: WritableStream,
  stdout: ReadableStream<Uint8Array>,
) => AcpSdkConnection;

type SpawnProcess = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => ChildProcess;

export interface AcpProcessClientOptions {
  cliEntryPath: string;
  cwd?: string;
  command?: string;
  channel?: 'Desktop';
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
  startupDelayMs?: number;
  validateCliPath?: boolean;
  spawnProcess?: SpawnProcess;
  createConnection?: CreateAcpConnection;
}

export interface ListSessionsOptions {
  cwd?: string;
  cursor?: number;
  size?: number;
}

export class AcpProcessClient {
  private child: ChildProcess | null = null;
  private connection: AcpSdkConnection | null = null;
  private readonly options: Required<
    Pick<
      AcpProcessClientOptions,
      'channel' | 'startupDelayMs' | 'validateCliPath'
    >
  > &
    Omit<
      AcpProcessClientOptions,
      'channel' | 'startupDelayMs' | 'validateCliPath'
    >;

  onSessionUpdate: (notification: SessionNotification) => void = () => {};
  onPermissionRequest: (
    request: RequestPermissionRequest,
  ) => Promise<RequestPermissionResponse> = async () => ({
    outcome: { outcome: 'cancelled' },
  });
  onExtNotification: (
    method: string,
    params: Record<string, unknown>,
  ) => Promise<void> = async () => {};
  onDisconnected: (code: number | null, signal: string | null) => void =
    () => {};
  onInitialized: (response: InitializeResponse) => void = () => {};

  constructor(options: AcpProcessClientOptions) {
    this.options = {
      ...options,
      channel: options.channel ?? 'Desktop',
      startupDelayMs: options.startupDelayMs ?? 1000,
      validateCliPath: options.validateCliPath ?? true,
    };
  }

  get isConnected(): boolean {
    return (
      this.child !== null &&
      !this.child.killed &&
      this.child.exitCode === null &&
      this.connection !== null
    );
  }

  async connect(): Promise<InitializeResponse> {
    if (this.child) {
      this.disconnect();
    }

    if (
      this.options.validateCliPath &&
      !existsSync(this.options.cliEntryPath)
    ) {
      throw new Error(
        `Qwen CLI ACP entry not found: ${this.options.cliEntryPath}`,
      );
    }

    const child = this.spawnChild();
    const stderrChunks: string[] = [];
    let spawnError: Error | null = null;
    let startupComplete = false;

    const processExitPromise = new Promise<never>((_resolve, reject) => {
      child.on('exit', (code: number | null, signal: string | null) => {
        const stderrOutput = stderrChunks.join('').trim();
        const stderrSuffix = stderrOutput
          ? `\nCLI stderr: ${stderrOutput.slice(-500)}`
          : '';

        if (this.child === child) {
          this.child = null;
          this.connection = null;
          this.onDisconnected(code, signal);
        }

        if (!startupComplete) {
          reject(
            new Error(
              `Qwen ACP process exited unexpectedly (exit code: ${code}, signal: ${signal})${stderrSuffix}`,
            ),
          );
        }
      });
    });

    child.stderr?.on('data', (data: Buffer) => {
      stderrChunks.push(data.toString());
    });
    child.on('error', (error: Error) => {
      spawnError = error;
    });

    this.child = child;

    if (this.options.startupDelayMs > 0) {
      await delay(this.options.startupDelayMs);
    }

    if (spawnError) {
      throw spawnError;
    }
    if (child.killed || child.exitCode !== null) {
      throw new Error('Qwen ACP process failed to start.');
    }

    const connection = this.createSdkConnection(child);
    this.connection = connection;

    const initializeResponse = await Promise.race([
      connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: this.getClientCapabilities(),
      }),
      processExitPromise,
    ]).finally(() => {
      startupComplete = true;
    });

    this.onInitialized(initializeResponse);
    return initializeResponse;
  }

  disconnect(): void {
    if (this.child) {
      this.child.kill();
    }

    this.child = null;
    this.connection = null;
  }

  async authenticate(methodId = 'default'): Promise<AuthenticateResponse> {
    return this.ensureConnection().authenticate({ methodId });
  }

  async newSession(cwd: string): Promise<NewSessionResponse> {
    return this.ensureConnection().newSession({ cwd, mcpServers: [] });
  }

  async loadSession(
    sessionId: string,
    cwd: string,
  ): Promise<LoadSessionResponse> {
    return this.ensureConnection().loadSession({
      sessionId,
      cwd,
      mcpServers: [],
    });
  }

  async listSessions(
    options: ListSessionsOptions = {},
  ): Promise<ListSessionsResponse> {
    const params: Parameters<AcpSdkConnection['unstable_listSessions']>[0] = {
      cwd: options.cwd ?? this.options.cwd ?? process.cwd(),
    };

    if (options.cursor !== undefined) {
      params.cursor = String(options.cursor);
    }
    if (options.size !== undefined) {
      params._meta = { ...(params._meta ?? {}), size: options.size };
    }

    return this.ensureConnection().unstable_listSessions(params);
  }

  async prompt(
    sessionId: string,
    prompt: string | ContentBlock[],
  ): Promise<PromptResponse> {
    const promptBlocks =
      typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : prompt;
    return this.ensureConnection().prompt({
      sessionId,
      prompt: promptBlocks,
    });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.ensureConnection().cancel({ sessionId });
  }

  async setMode(
    sessionId: string,
    modeId: string,
  ): Promise<SetSessionModeResponse | void> {
    return this.ensureConnection().setSessionMode({ sessionId, modeId });
  }

  async setModel(
    sessionId: string,
    modelId: string,
  ): Promise<SetSessionModelResponse | void> {
    return this.ensureConnection().unstable_setSessionModel({
      sessionId,
      modelId,
    });
  }

  async extMethod<T extends Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    return (await this.ensureConnection().extMethod(method, params)) as T;
  }

  private spawnChild(): ChildProcess {
    const command = this.options.command ?? process.execPath;
    const args = [
      this.options.cliEntryPath,
      '--acp',
      `--channel=${this.options.channel}`,
      ...(this.options.extraArgs ?? []),
    ];
    const env = { ...process.env, ...(this.options.env ?? {}) };

    return (this.options.spawnProcess ?? spawn)(command, args, {
      cwd: this.options.cwd ?? process.cwd(),
      env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  private createSdkConnection(child: ChildProcess): AcpSdkConnection {
    const stdout = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
    const stdin = Writable.toWeb(child.stdin!) as WritableStream;
    const createConnection =
      this.options.createConnection ?? createSdkConnection;

    return createConnection(
      () => ({
        sessionUpdate: (params: SessionNotification): Promise<void> => {
          this.onSessionUpdate(params);
          return Promise.resolve();
        },
        requestPermission: (
          params: RequestPermissionRequest,
        ): Promise<RequestPermissionResponse> =>
          this.onPermissionRequest(params),
        extNotification: (
          method: string,
          params: Record<string, unknown>,
        ): Promise<void> => this.onExtNotification(method, params),
      }),
      stdin,
      stdout,
    );
  }

  private ensureConnection(): AcpSdkConnection {
    if (!this.isConnected || !this.connection) {
      throw new Error('Not connected to ACP agent');
    }

    return this.connection;
  }

  private getClientCapabilities(): ClientCapabilities {
    return {};
  }
}

function createSdkConnection(
  clientFactory: (agent: Agent) => Client,
  stdin: WritableStream,
  stdout: ReadableStream<Uint8Array>,
): AcpSdkConnection {
  return new ClientSideConnection(clientFactory, ndJsonStream(stdin, stdout));
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
