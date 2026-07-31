/**
 * MCP Pool Server
 *
 * Serves McpClientPool tools over HTTP using the MCP Streamable HTTP protocol.
 * This allows external backend subprocesses to access pool-managed
 * MCP source tools through a single HTTP endpoint instead of connecting to each
 * source independently.
 *
 * Uses Streamable HTTP transport in stateless mode because Codex uses the
 * Streamable HTTP protocol (POST-based JSON-RPC). Stateless mode means no
 * session tracking — each request is independent.
 *
 * Architecture:
 *   Backend subprocess
 *       ↓ (HTTP Streamable HTTP protocol)
 *   McpPoolServer (this, in Electron main process)
 *       ↓
 *   McpClientPool
 *       ↓ (per-source MCP connections)
 *   Linear / GitHub / Notion / etc.
 */

import { createServer, type Server as HttpServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { McpClientPool } from './mcp-pool.ts';

export class McpPoolServer {
  private pool: McpClientPool;
  private httpServer: HttpServer | null = null;
  private mcpServer: Server | null = null;
  private transport: StreamableHTTPServerTransport | null = null;
  private debugFn: ((msg: string) => void) | undefined;
  private _port = 0;

  constructor(pool: McpClientPool, options?: { debug?: (msg: string) => void }) {
    this.pool = pool;
    this.debugFn = options?.debug;
  }

  private debug(msg: string): void {
    this.debugFn?.(`[McpPoolServer] ${msg}`);
  }

  get port(): number {
    return this._port;
  }

  get url(): string {
    return `http://127.0.0.1:${this._port}/mcp`;
  }

  /**
   * Start the HTTP MCP server on a random port.
   * Returns the URL clients should connect to.
   */
  async start(): Promise<string> {
    if (this.httpServer) {
      return this.url;
    }

    // Create a single MCP Server + Streamable HTTP transport pair (stateless mode)
    this.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless — no session tracking
    });
    this.mcpServer = this.createMcpServer();
    await this.mcpServer.connect(this.transport);

    this.httpServer = createServer(async (req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1`);
      if (url.pathname !== '/mcp') {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }

      // Route all methods (POST, GET, DELETE) through the Streamable HTTP transport
      await this.transport!.handleRequest(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(0, '127.0.0.1', () => {
        const addr = this.httpServer!.address();
        this._port = typeof addr === 'object' && addr ? addr.port : 0;
        this.debug(`Listening on 127.0.0.1:${this._port}`);
        resolve();
      });
      this.httpServer!.on('error', reject);
    });

    return this.url;
  }

  /**
   * Create an MCP Server instance wired to the pool.
   * Tools from pool use `mcp__craft__search_spaces` naming internally.
   * We strip the `mcp__` prefix so Codex (which adds its own `mcp__sources__`
   * prefix based on the POOL_SERVER_MCP_NAME) sees clean names:
   *   pool internal: mcp__craft__search_spaces
   *   exposed here:  craft__search_spaces
   *   Codex sees:    mcp__sources__craft__search_spaces
   */
  private createMcpServer(): Server {
    const server = new Server(
      { name: 'craft-pool-proxy', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    // List tools — proxy from pool, strip `mcp__` prefix
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const proxyDefs = this.pool.getProxyToolDefs();
      return {
        tools: proxyDefs.map(def => ({
          name: def.name.replace(/^mcp__/, ''),
          description: def.description,
          inputSchema: def.inputSchema as {
            type: 'object';
            properties?: Record<string, unknown>;
          },
        })),
      };
    });

    // Call tool — add `mcp__` prefix back before routing through pool
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const internalName = `mcp__${name}`;
      this.debug(`Tool call: ${name} → ${internalName}`);

      const result = await this.pool.callTool(internalName, args || {});

      return {
        content: [{ type: 'text' as const, text: result.content }],
        ...(result.isError ? { isError: true } : {}),
      };
    });

    return server;
  }

  /**
   * Notify that the tool list has changed.
   * In stateless mode this is a no-op — source changes already trigger
   * `regenCodexConfigAndReconnect()` which restarts the app-server,
   * and it re-discovers tools on startup.
   */
  notifyToolsChanged(): void {
    this.debug('Tools changed (stateless mode — clients will discover on next connect)');
  }

  /**
   * Stop the HTTP server and close the transport.
   */
  async stop(): Promise<void> {
    if (this.transport) {
      await this.transport.close().catch(() => {});
      this.transport = null;
    }

    if (this.mcpServer) {
      await this.mcpServer.close().catch(() => {});
      this.mcpServer = null;
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
      this._port = 0;
      this.debug('Stopped');
    }
  }
}
