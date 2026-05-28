/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type {
  CallToolResult,
  ListToolsResult,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * Singleton stdio MCP client for the upstream open-computer-use binary.
 *
 * Spawned via `npx -y <packageSpec> mcp`. First spawn pays the npx
 * download cost (up to ~60s for a fresh cache); subsequent spawns reuse
 * the npx cache and are sub-second.
 *
 * Lifecycle: lazy spawn on first `callTool` invocation. The process
 * stays alive until `stop()` or qwen-code exits. State (element_index
 * map per app) lives in the process — if the process restarts, the
 * model must call `get_app_state` again before any element-targeted
 * action.
 */
export interface ComputerUseClientOptions {
  /** npm package spec to npx. Example: "open-computer-use@^0.3.0". */
  packageSpec: string;
  /** Streaming hook for progress messages during slow operations. */
  onProgress?: (message: string) => void;
}

export class ComputerUseClient {
  private static singleton: ComputerUseClient | undefined;

  private readonly packageSpec: string;
  private readonly onProgress: (message: string) => void;
  private client: Client | undefined;
  private startPromise: Promise<void> | undefined;

  constructor(options: ComputerUseClientOptions) {
    this.packageSpec = options.packageSpec;
    this.onProgress = options.onProgress ?? (() => {});
  }

  /**
   * Shared singleton instance, created with default options on first
   * access. Tests can replace it via `setSharedForTest()`.
   */
  static shared(): ComputerUseClient {
    if (!ComputerUseClient.singleton) {
      ComputerUseClient.singleton = new ComputerUseClient({
        packageSpec:
          process.env['QWEN_COMPUTER_USE_PACKAGE'] ??
          'open-computer-use@latest',
      });
    }
    return ComputerUseClient.singleton;
  }

  /** Test-only: replace the singleton. */
  static setSharedForTest(replacement: ComputerUseClient | undefined): void {
    ComputerUseClient.singleton = replacement;
  }

  isStarted(): boolean {
    return this.client !== undefined;
  }

  /**
   * Start the upstream MCP server. Idempotent: concurrent callers share
   * the same in-flight start promise.
   *
   * An optional `onProgress` callback can be supplied to receive download
   * and startup messages during this call. It overrides the instance-level
   * callback for the duration of the start operation only.
   *
   * Throws on spawn failure (network down, npx missing, etc.). The
   * caller (bootstrap state machine) is responsible for mapping the
   * throw into user-facing UX.
   */
  async start(onProgress?: (message: string) => void): Promise<void> {
    if (this.client) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.doStart(onProgress).finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  private async doStart(onProgress?: (message: string) => void): Promise<void> {
    const progress = onProgress ?? this.onProgress;
    progress('Starting Computer Use...');

    // After ~3s, surface a hint that the slow path is download.
    const downloadHintTimer = setTimeout(() => {
      progress(
        'Downloading Computer Use binary (this can take ~60s on first use)...',
      );
    }, 3000);

    try {
      const transport = new StdioClientTransport({
        command: 'npx',
        args: ['-y', this.packageSpec, 'mcp'],
        // Inherit env so HTTPS_PROXY etc. flow through to npx
        env: { ...process.env } as Record<string, string>,
      });
      const client = new Client(
        { name: 'qwen-code-computer-use', version: '1.0.0' },
        { capabilities: {} },
      );
      await client.connect(transport);
      this.client = client;
    } finally {
      clearTimeout(downloadHintTimer);
    }
  }

  /**
   * List the tools exposed by the upstream server. Used by the schema
   * sync script and bootstrap diagnostics.
   */
  async listTools(): Promise<ListToolsResult> {
    if (!this.client) throw new Error('ComputerUseClient not started');
    return this.client.listTools();
  }

  /**
   * Call a tool by upstream name (NOT the qwen-code-facing
   * `computer_use__` prefixed name). Returns the raw MCP result so the
   * caller can inspect `isError` and parse text content.
   *
   * On transport-closed errors (e.g. macOS kills the upstream binary after
   * the user grants Screen Recording permission), this method transparently
   * tears down the stale connection, reconnects, and retries the call once.
   * If the retry also fails, the error is re-thrown without further
   * reconnect attempts.
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    if (!this.client) throw new Error('ComputerUseClient not started');
    try {
      return (await this.client.callTool({
        name,
        arguments: args,
      })) as CallToolResult;
    } catch (err) {
      if (!isTransportClosedError(err)) throw err;
      // Reconnect: upstream binary is commonly killed by macOS after the
      // user grants Screen Recording (a TCC restart prompt). The child
      // process is dead but the user's task is mid-flight. Transparent
      // reconnect + single retry keeps the model's flow uninterrupted.
      //
      // Element index state lives in the upstream process and is therefore
      // lost across the restart. The model is already instructed (via
      // schema descriptions) to call get_app_state before any
      // element-targeted action — if its retry uses a stale element_index
      // it will get a normal upstream error ("element_index out of range")
      // and naturally re-snapshot.
      await this.stop();
      await this.start();
      if (!this.client) throw new Error('ComputerUseClient reconnect failed');
      return (await this.client.callTool({
        name,
        arguments: args,
      })) as CallToolResult;
    }
  }

  /** Tear down the child process. Safe to call multiple times. */
  async stop(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (client) {
      try {
        await client.close();
      } catch {
        // best-effort cleanup
      }
    }
  }
}

/**
 * Returns true when `err` indicates the MCP transport closed unexpectedly
 * (e.g. the upstream child process was killed by macOS after a TCC permission
 * grant). The patterns below cover all observed SDK error messages:
 *
 *   "Connection closed"          – StdioClientTransport stream closed
 *   "MCP error -32000: ..."      – JSON-RPC internal error, often wraps the above
 *   "Not connected"              – Client.callTool guard before transport is open
 */
export function isTransportClosedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /connection closed|not connected/i.test(msg);
}
