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
import { homedir } from 'node:os';
import { binaryPath } from './constants.js';

/**
 * Singleton stdio MCP client for the cua-driver binary.
 *
 * Spawned via `<binary> mcp`, where `<binary>` is the pinned cua-driver
 * downloaded under `~/.qwen/computer-use/` (the bootstrap state machine
 * downloads + verifies it before the first spawn). Spawns are sub-second
 * — there is no npx/download cost on this path anymore.
 *
 * Lifecycle: lazy spawn on first `callTool` invocation. The process
 * stays alive until `stop()` or qwen-code exits. State (element_index
 * map per window) lives in the process — if the process restarts, the
 * model must call `get_window_state` again before any element-targeted
 * action.
 */
export interface ComputerUseClientOptions {
  /** Absolute path to the spawnable `cua-driver` binary. */
  binary: string;
  /** Streaming hook for progress messages during slow operations. */
  onProgress?: (message: string) => void;
}

export class ComputerUseClient {
  private static singleton: ComputerUseClient | undefined;

  private readonly binary: string;
  private readonly onProgress: (message: string) => void;
  private client: Client | undefined;
  private startPromise: Promise<void> | undefined;

  constructor(options: ComputerUseClientOptions) {
    this.binary = options.binary;
    this.onProgress = options.onProgress ?? (() => {});
  }

  /**
   * Shared singleton instance, created with default options on first
   * access. Tests can replace it via `setSharedForTest()`.
   *
   * The binary path is derived from the pinned `CUA_DRIVER_VERSION` in
   * constants.ts, the single source of truth the downloaded binary +
   * generated `schemas.ts` agree on.
   */
  static shared(): ComputerUseClient {
    if (!ComputerUseClient.singleton) {
      ComputerUseClient.singleton = new ComputerUseClient({
        binary: binaryPath(homedir()),
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
    progress('Starting Computer Use driver...');

    const transport = new StdioClientTransport({
      command: this.binary,
      args: ['mcp'],
      // Inherit env so HTTPS_PROXY / cua-driver config env flow through.
      env: { ...process.env } as Record<string, string>,
    });
    const client = new Client(
      { name: 'qwen-code-computer-use', version: '1.0.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    this.client = client;
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
      // The connection died. Two recoverable causes, both fixed by respawning
      // the proxy (which relaunches the cua-driver daemon):
      //   1. stdio "Connection closed" — the `cua-driver mcp` child was killed.
      //   2. "daemon transport error … Connection refused" — the CuaDriver
      //      DAEMON behind the proxy restarted. macOS forces a restart right
      //      after the Screen Recording grant, so the proxy's Unix socket to
      //      the daemon goes dead and every subsequent tool fails. This is the
      //      first-use failure mode (grant SR → restart → all tools error).
      //
      // Respawn + retry, with a few attempts to absorb the daemon's restart /
      // startup window (a single retry can land before the new daemon is up).
      // Element-index state is lost across the restart; the model re-snapshots
      // via get_window_state on a stale-index error.
      let lastErr: unknown = err;
      for (let attempt = 0; attempt < 3; attempt++) {
        await this.stop();
        await this.start();
        if (!this.client) throw new Error('ComputerUseClient reconnect failed');
        try {
          return (await this.client.callTool({
            name,
            arguments: args,
          })) as CallToolResult;
        } catch (retryErr) {
          if (!isTransportClosedError(retryErr)) throw retryErr;
          lastErr = retryErr;
          // Daemon may still be coming up after a restart — back off, retry.
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
      throw lastErr;
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
 * Returns true when `err` indicates a recoverable connection failure — either
 * the stdio transport to the `cua-driver mcp` proxy closed, OR the proxy's
 * Unix-socket link to the CuaDriver daemon died (daemon restart). Both are
 * fixed by respawning the proxy. Observed SDK / cua-driver messages:
 *
 *   "Connection closed"            – StdioClientTransport stream closed
 *   "Not connected"                – Client guard before transport is open
 *   "daemon transport error …"     – proxy → daemon Unix socket forward failed
 *   "Connection refused (os error 61)" – daemon not listening (restarted/down)
 *   "MCP error -32603 / -32000: …" – JSON-RPC wrapper around the above
 */
export function isTransportClosedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /connection closed|not connected|connection refused|daemon transport error|os error 61/i.test(
    msg,
  );
}
