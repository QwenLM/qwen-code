/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FunctionDeclaration } from '@google/genai';

/**
 * Harness-local MCP client for one Session's client filesystem registration.
 * The relay is a pure Streamable HTTP endpoint fronting the browser's
 * directory grant; this client holds no local process and no Workspace file
 * access. It lives beside the Session authority because the worker's MCP
 * control admission is journal-grant-gated and an ephemeral registration has
 * no journal rows (design 2026-11-10, open question 1).
 */

export const CLIENT_FILES_CONNECT_TIMEOUT_MS = 25_000;
export const CLIENT_FILES_REQUEST_TIMEOUT_MS = 600_000;
export const CLIENT_FILES_MAX_RESULT_BYTES = 60 * 1024;
// Mirror the durable MCP runtime's catalog bounds so a browser-registered
// server cannot silently truncate a paginated tools/list or install an
// unbounded catalog that every Turn re-advertises to the model.
export const CLIENT_FILES_MAX_CATALOG_PAGES = 64;
export const CLIENT_FILES_MAX_CATALOG_BYTES = 16 * 1024;

export interface HostedClientFilesRegistration {
  readonly serverId: string;
  readonly generation: number;
  readonly url: string;
  readonly token: string;
}

export interface HostedClientFilesTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface HostedClientFilesCatalog {
  readonly serverId: string;
  readonly generation: number;
  readonly tools: readonly HostedClientFilesTool[];
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class HostedClientFilesSession {
  private client?: Client;
  private registration?: HostedClientFilesRegistration;
  private catalog: HostedClientFilesCatalog = {
    serverId: '',
    generation: 0,
    tools: [],
  };
  private closed = false;
  private registering: Promise<unknown> = Promise.resolve();
  // Bumped by unregister/close so a discovery still in flight cannot install
  // its client/catalog after a Disconnect; a later explicit registration
  // captures the new epoch and proceeds normally.
  private epoch = 0;

  get active(): boolean {
    return this.client !== undefined && !this.closed;
  }

  get generation(): number {
    return this.registration?.generation ?? 0;
  }

  /**
   * Connects to the relay and discovers the browser's tools. Overlapping
   * registrations are serialized so no loser's transport is orphaned, and the
   * previous client is dropped only after the new one has discovered its
   * tools — a refused dispatch leaves the working registration intact.
   */
  async register(registration: HostedClientFilesRegistration): Promise<number> {
    // Capture the epoch at request time, not when the queued registration
    // starts executing: a Disconnect that lands while this registration is
    // still queued must invalidate it, which a later read would miss.
    const epoch = this.epoch;
    const run = this.registering.then(() =>
      this.registerSerial(registration, epoch),
    );
    this.registering = run.catch(() => {});
    return run;
  }

  private async registerSerial(
    registration: HostedClientFilesRegistration,
    epoch: number,
  ): Promise<number> {
    if (this.closed) throw new Error('Client files session is closed.');
    const transport = new StreamableHTTPClientTransport(
      new URL(registration.url),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${registration.token}` },
        },
      },
    );
    const client = new Client(
      { name: 'qwen-hosted-client-files', version: '1.0.0' },
      { capabilities: {} },
    );
    try {
      await client.connect(transport, {
        timeout: CLIENT_FILES_CONNECT_TIMEOUT_MS,
      });
      // Follow nextCursor up to the house page cap and enforce a catalog byte
      // cap before installing, mirroring the durable MCP runtime: a paginated
      // tools/list must not be silently truncated, and an oversized catalog
      // fails the registration closed instead of inflating every Turn.
      const tools: HostedClientFilesTool[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        if (cursors.size >= CLIENT_FILES_MAX_CATALOG_PAGES) {
          throw new Error('Client files catalog exceeds the page bound.');
        }
        const listed = await client.listTools(cursor ? { cursor } : undefined, {
          timeout: CLIENT_FILES_REQUEST_TIMEOUT_MS,
        });
        for (const tool of listed.tools) {
          const mapped: HostedClientFilesTool = {
            name: tool.name,
            ...(tool.description !== undefined
              ? { description: tool.description }
              : {}),
            inputSchema: (tool.inputSchema ?? {}) as Record<string, unknown>,
          };
          if (
            Buffer.byteLength(JSON.stringify([...tools, mapped])) >
            CLIENT_FILES_MAX_CATALOG_BYTES
          ) {
            throw new Error('Client files catalog exceeds the size bound.');
          }
          tools.push(mapped);
        }
        cursor = listed.nextCursor;
        if (cursor && cursors.has(cursor)) {
          throw new Error('Client files catalog cursor cycle.');
        }
        if (cursor) cursors.add(cursor);
      } while (cursor);
      // A close()/unregister() or a newer generation may have landed while
      // discovery was in flight; never install a client the session no longer
      // owns. The epoch check invalidates a registration that was already
      // awaiting discovery when Disconnect completed.
      if (this.closed || epoch !== this.epoch) {
        await client.close().catch(() => {});
        throw new Error('Client files session is closed.');
      }
      if (this.active && this.generation > registration.generation) {
        await client.close().catch(() => {});
        return this.catalog.tools.length;
      }
      const previous = this.client;
      this.client = client;
      this.registration = registration;
      this.catalog = {
        serverId: registration.serverId,
        generation: registration.generation,
        tools,
      };
      if (previous) await previous.close().catch(() => {});
      return tools.length;
    } catch (cause) {
      await client.close().catch(() => {});
      throw cause;
    }
  }

  /** Drops the connection and catalog; idempotent. Invalidates any discovery
   * still in flight so it cannot reinstall the catalog after Disconnect. */
  async unregister(): Promise<void> {
    this.epoch += 1;
    const client = this.client;
    this.client = undefined;
    this.registration = undefined;
    this.catalog = { serverId: '', generation: 0, tools: [] };
    if (client) await client.close().catch(() => {});
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.unregister();
  }

  catalogs(): readonly HostedClientFilesCatalog[] {
    return this.active ? [this.catalog] : [];
  }

  tools(): FunctionDeclaration[] {
    if (!this.active) return [];
    return this.catalog.tools.map((tool) => ({
      name: this.toolName(tool.name),
      description: `MCP server: ${JSON.stringify(this.catalog.serverId)}\nMCP tool: ${JSON.stringify(tool.name)}${tool.description ? `\n${tool.description}` : ''}`,
      parametersJsonSchema: tool.inputSchema,
    }));
  }

  /** Resolves a namespaced tool name to the browser's own tool name. */
  resolve(name: string): HostedClientFilesTool | undefined {
    if (!this.active) return undefined;
    return this.catalog.tools.find(
      (candidate) => this.toolName(candidate.name) === name,
    );
  }

  /** Calls one browser tool; the result is bounded like the worker MCP cap. */
  async invoke(
    tool: HostedClientFilesTool,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const client = this.client;
    if (!client || !this.active)
      throw new Error('Client files session is not connected.');
    const result = await client.callTool(
      { name: tool.name, arguments: args },
      undefined,
      { timeout: CLIENT_FILES_REQUEST_TIMEOUT_MS, signal },
    );
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
    if (bytes > CLIENT_FILES_MAX_RESULT_BYTES)
      throw new Error('Client files tool result exceeds the byte cap.');
    return result;
  }

  private toolName(name: string): string {
    return `mcp_${digest([this.catalog.serverId, this.catalog.generation, name]).slice(0, 32)}`;
  }
}
