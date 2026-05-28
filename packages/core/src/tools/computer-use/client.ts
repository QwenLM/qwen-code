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
   * Throws on spawn failure (network down, npx missing, etc.). The
   * caller (bootstrap state machine) is responsible for mapping the
   * throw into user-facing UX.
   */
  async start(): Promise<void> {
    if (this.client) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.doStart().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    this.onProgress('Starting Computer Use...');

    // After ~3s, surface a hint that the slow path is download.
    const downloadHintTimer = setTimeout(() => {
      this.onProgress(
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
   */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    if (!this.client) throw new Error('ComputerUseClient not started');
    return this.client.callTool({
      name,
      arguments: args,
    }) as Promise<CallToolResult>;
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
