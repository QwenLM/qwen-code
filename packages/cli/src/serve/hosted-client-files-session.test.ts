/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCP_MAX_TOOL_LIST_PAGES } from '@qwen-code/qwen-code-core/tools/mcp-client.js';
import {
  CLIENT_FILES_MAX_CATALOG_PAGES,
  CLIENT_FILES_MAX_RESULT_BYTES,
  HostedClientFilesSession,
} from './hosted-client-files-session.js';

interface Script {
  tools?: Array<{ name: string; description?: string; inputSchema?: object }>;
  /** Paginated tools/list: one entry per page; the peer answers the page for the
   * request cursor and sets nextCursor to the following page index. */
  listPages?: Array<{
    tools: Array<{ name: string; description?: string; inputSchema?: object }>;
  }>;
  /** When set, every tools/list page answers this nextCursor, manufacturing a
   * cursor cycle to exercise the discovery cycle guard. */
  listCycleCursor?: string;
  resultText?: string;
  refuseInitialize?: boolean;
  /** JSON-RPC error answered to tools/call, e.g. the relay offline error. */
  callError?: { code: number; message: string };
  /** HTTP status answered to tools/call, e.g. a revoked relay credential. */
  callStatus?: number;
  /** Answer tools/list with the relay offline error during registration. */
  listError?: boolean;
  /** Hold the tools/list response until this promise resolves (to exercise a
   * Disconnect landing while discovery is still in flight). */
  listGate?: Promise<void>;
}

/** A minimal in-process Streamable HTTP MCP peer standing in for the relay. */
function startPeer(script: Script): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    // The SDK opens a GET SSE stream and sends DELETE on close; this peer
    // only speaks POST JSON-RPC, so refuse the stream and accept the close.
    if (req.method === 'GET') {
      res.writeHead(405);
      res.end();
      return;
    }
    if (req.method === 'DELETE') {
      res.writeHead(200);
      res.end();
      return;
    }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      if (body === '') {
        res.writeHead(400);
        res.end();
        return;
      }
      const message = JSON.parse(body) as {
        id?: string | number;
        method?: string;
        params?: { name?: string };
      };
      const reply = (result: unknown) => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Mcp-Session-Id': 'scripted-session',
        });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      };
      const replyError = (error: { code: number; message: string }) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error }));
      };
      if (message.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      if (message.method === 'initialize') {
        if (script.refuseInitialize) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              error: { code: -32000, message: 'refused' },
            }),
          );
          return;
        }
        reply({
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'scripted-relay', version: '1.0.0' },
        });
        return;
      }
      if (message.method === 'tools/list') {
        if (script.listGate) await script.listGate;
        if (script.listError) {
          replyError({ code: -32000, message: 'client_files_offline' });
          return;
        }
        if (script.listPages) {
          const cursor = (message.params as { cursor?: string } | undefined)
            ?.cursor;
          const pageIndex = cursor ? Number.parseInt(cursor, 10) : 0;
          const page = script.listPages[pageIndex];
          const nextCursor =
            script.listCycleCursor !== undefined
              ? script.listCycleCursor
              : pageIndex + 1 < script.listPages.length
                ? String(pageIndex + 1)
                : undefined;
          reply({
            tools: (page?.tools ?? []).map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema ?? { type: 'object' },
            })),
            ...(nextCursor !== undefined ? { nextCursor } : {}),
          });
          return;
        }
        reply({
          tools: (script.tools ?? []).map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema ?? { type: 'object' },
          })),
        });
        return;
      }
      if (message.method === 'tools/call') {
        if (script.callStatus !== undefined) {
          res.writeHead(script.callStatus, {
            'Content-Type': 'application/json',
          });
          res.end(
            JSON.stringify({
              error: { code: 'client_files_credential_invalid' },
            }),
          );
          return;
        }
        if (script.callError) {
          replyError(script.callError);
          return;
        }
        reply({
          content: [{ type: 'text', text: script.resultText ?? 'ok' }],
        });
        return;
      }
      reply({});
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${port}/mcp` });
    });
  });
}

describe('HostedClientFilesSession', () => {
  const servers: Server[] = [];
  const sessions: HostedClientFilesSession[] = [];

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
  });

  async function peer(script: Script) {
    const { server, url } = await startPeer(script);
    servers.push(server);
    return url;
  }

  function session() {
    const created = new HostedClientFilesSession();
    sessions.push(created);
    return created;
  }

  // The loser's transport must be terminated, not orphaned. Spy on the
  // transport close directly: the SDK's DELETE is async and absent in
  // POST-only fallback, so a network count is not a reliable signal.
  function spyTransportCloses() {
    return vi.spyOn(StreamableHTTPClientTransport.prototype, 'close');
  }

  it('discovers tools and exposes namespaced declarations', async () => {
    const url = await peer({
      tools: [{ name: 'read_file', description: 'Read a client file' }],
    });
    const files = session();
    const count = await files.register({
      serverId: 'local-files',
      generation: 1,
      url,
      token: 'token-1',
    });
    expect(count).toBe(1);
    expect(files.active).toBe(true);
    const declarations = files.tools();
    expect(declarations).toHaveLength(1);
    expect(declarations[0].name).toMatch(/^mcp_[0-9a-f]{32}$/);
    expect(declarations[0].description).toContain('read_file');
    expect(files.resolve(declarations[0]!.name!)?.name).toBe('read_file');
    expect(files.catalogs()[0].serverId).toBe('local-files');
  });

  it('follows tools/list pagination instead of truncating the catalog', async () => {
    const url = await peer({
      listPages: [
        { tools: [{ name: 'read_file' }] },
        { tools: [{ name: 'write_file' }] },
      ],
    });
    const files = session();
    const count = await files.register({
      serverId: 'local-files',
      generation: 1,
      url,
      token: 't',
    });
    expect(count).toBe(2);
    expect(files.catalogs()[0].tools.map((tool) => tool.name)).toEqual([
      'read_file',
      'write_file',
    ]);
  });

  it('refuses a catalog over the size bound instead of installing it', async () => {
    const url = await peer({
      tools: [{ name: 'read_file', description: 'x'.repeat(20_000) }],
    });
    const files = session();
    await expect(
      files.register({
        serverId: 'local-files',
        generation: 1,
        url,
        token: 't',
      }),
    ).rejects.toThrow('size bound');
    expect(files.active).toBe(false);
  });

  it('refuses a catalog over the page bound instead of truncating it', async () => {
    const url = await peer({
      listPages: Array.from(
        { length: CLIENT_FILES_MAX_CATALOG_PAGES + 1 },
        (_, i) => ({
          tools: [{ name: `tool_${i}` }],
        }),
      ),
    });
    const files = session();
    await expect(
      files.register({
        serverId: 'local-files',
        generation: 1,
        url,
        token: 't',
      }),
    ).rejects.toThrow('page bound');
    expect(files.active).toBe(false);
  });

  it('pins the catalog page cap to core’s tools/list page bound', () => {
    // The page-bound fixture above scales with the constant, so it proves a
    // bound exists but not its value. Hold the cap to the producer it mirrors:
    // drifting it to 50 (or any other number) must red here.
    expect(CLIENT_FILES_MAX_CATALOG_PAGES).toBe(MCP_MAX_TOOL_LIST_PAGES);
  });

  it('refuses a tools/list cursor cycle instead of looping', async () => {
    const url = await peer({
      listPages: [{ tools: [{ name: 'read_file' }] }],
      listCycleCursor: '0',
    });
    const files = session();
    await expect(
      files.register({
        serverId: 'local-files',
        generation: 1,
        url,
        token: 't',
      }),
    ).rejects.toThrow('cursor cycle');
    expect(files.active).toBe(false);
  });

  it('invokes a browser tool and returns its result', async () => {
    const url = await peer({
      tools: [{ name: 'read_file' }],
      resultText: 'file content',
    });
    const files = session();
    await files.register({
      serverId: 'local-files',
      generation: 1,
      url,
      token: 't',
    });
    const tool = files.resolve(files.tools()[0]!.name!)!;
    const result = (await files.invoke(tool, { path: 'a.txt' })) as {
      content: Array<{ text: string }>;
    };
    expect(result.content[0].text).toBe('file content');
  });

  it('refuses an oversize tool result', async () => {
    const url = await peer({
      tools: [{ name: 'read_file' }],
      resultText: 'x'.repeat(CLIENT_FILES_MAX_RESULT_BYTES),
    });
    const files = session();
    await files.register({
      serverId: 'local-files',
      generation: 1,
      url,
      token: 't',
    });
    const tool = files.resolve(files.tools()[0]!.name!)!;
    await expect(files.invoke(tool, {})).rejects.toThrow(/byte cap/);
  });

  it('surfaces the relay offline error as a call failure', async () => {
    const url = await peer({
      tools: [{ name: 'read_file' }],
      // The exact shape the Java relay answers once the browser queue TTL
      // expires (ClientFilesRelayService.offlineError).
      callError: { code: -32000, message: 'client_files_offline' },
    });
    const files = session();
    await files.register({
      serverId: 'local-files',
      generation: 1,
      url,
      token: 't',
    });
    const tool = files.resolve(files.tools()[0]!.name!)!;
    await expect(files.invoke(tool, {})).rejects.toThrow(
      /client_files_offline/,
    );
  });

  it('surfaces a relay credential refusal as a call failure', async () => {
    const url = await peer({
      tools: [{ name: 'read_file' }],
      callStatus: 403,
    });
    const files = session();
    await files.register({
      serverId: 'local-files',
      generation: 1,
      url,
      token: 't',
    });
    const tool = files.resolve(files.tools()[0]!.name!)!;
    await expect(files.invoke(tool, {})).rejects.toThrow();
  });

  it('a failed tools/list leaves no active client', async () => {
    const url = await peer({ tools: [{ name: 'read_file' }], listError: true });
    const files = session();
    await expect(
      files.register({
        serverId: 'local-files',
        generation: 1,
        url,
        token: 't',
      }),
    ).rejects.toThrow(/client_files_offline/);
    expect(files.active).toBe(false);
    expect(files.tools()).toEqual([]);
  });

  it('unregister drops the catalog and is idempotent', async () => {
    const url = await peer({ tools: [{ name: 'read_file' }] });
    const files = session();
    await files.register({
      serverId: 'local-files',
      generation: 1,
      url,
      token: 't',
    });
    await files.unregister();
    expect(files.active).toBe(false);
    expect(files.tools()).toEqual([]);
    expect(files.catalogs()).toEqual([]);
    await files.unregister();
  });

  it('re-register advances the generation and replaces tools', async () => {
    const first = await peer({ tools: [{ name: 'read_file' }] });
    const second = await peer({ tools: [{ name: 'write_file' }] });
    const files = session();
    await files.register({
      serverId: 'local-files',
      generation: 1,
      url: first,
      token: 't',
    });
    const before = files.tools()[0].name;
    await files.register({
      serverId: 'local-files',
      generation: 2,
      url: second,
      token: 't2',
    });
    expect(files.generation).toBe(2);
    expect(files.tools()[0].name).not.toBe(before);
    expect(files.resolve(files.tools()[0]!.name!)?.name).toBe('write_file');
  });

  it('a refused re-registration keeps the working client', async () => {
    const first = await peer({ tools: [{ name: 'read_file' }] });
    const second = await peer({
      tools: [{ name: 'write_file' }],
      listError: true,
    });
    const files = session();
    await files.register({
      serverId: 'local-files',
      generation: 1,
      url: first,
      token: 't',
    });
    await expect(
      files.register({
        serverId: 'local-files',
        generation: 2,
        url: second,
        token: 't2',
      }),
    ).rejects.toThrow(/client_files_offline/);
    expect(files.active).toBe(true);
    expect(files.generation).toBe(1);
    expect(files.resolve(files.tools()[0]!.name!)?.name).toBe('read_file');
  });

  it('a stale generation cannot replace a newer registration', async () => {
    const older = await peer({ tools: [{ name: 'read_file' }] });
    const newer = await peer({ tools: [{ name: 'write_file' }] });
    const files = session();
    await files.register({
      serverId: 'local-files',
      generation: 2,
      url: newer,
      token: 't2',
    });
    const closes = spyTransportCloses();
    const count = await files.register({
      serverId: 'local-files',
      generation: 1,
      url: older,
      token: 't',
    });
    expect(files.generation).toBe(2);
    expect(files.resolve(files.tools()[0]!.name!)?.name).toBe('write_file');
    expect(count).toBe(1);
    // The stale registration's transport was terminated, not orphaned — and
    // exactly one close: the surviving newer transport must not be closed too.
    expect(closes).toHaveBeenCalledTimes(1);
    closes.mockRestore();
  });

  it('overlapping registrations serialize to the newer generation', async () => {
    const first = await peer({ tools: [{ name: 'read_file' }] });
    const second = await peer({ tools: [{ name: 'write_file' }] });
    const files = session();
    const closes = spyTransportCloses();
    await Promise.all([
      files.register({
        serverId: 'local-files',
        generation: 1,
        url: first,
        token: 't',
      }),
      files.register({
        serverId: 'local-files',
        generation: 2,
        url: second,
        token: 't2',
      }),
    ]);
    expect(files.generation).toBe(2);
    expect(files.resolve(files.tools()[0]!.name!)?.name).toBe('write_file');
    // The first registration's transport was terminated when the second won —
    // exactly one close: the winning transport must not be closed too.
    expect(closes).toHaveBeenCalledTimes(1);
    closes.mockRestore();
  });

  it('a refused initialize leaves no active client', async () => {
    const url = await peer({ refuseInitialize: true });
    const files = session();
    await expect(
      files.register({
        serverId: 'local-files',
        generation: 1,
        url,
        token: 't',
      }),
    ).rejects.toThrow();
    expect(files.active).toBe(false);
    expect(files.tools()).toEqual([]);
  });

  it('close prevents re-registration', async () => {
    const url = await peer({ tools: [{ name: 'read_file' }] });
    const files = session();
    await files.close();
    await expect(
      files.register({
        serverId: 'local-files',
        generation: 1,
        url,
        token: 't',
      }),
    ).rejects.toThrow(/closed/);
  });

  it('unregister invalidates a discovery still in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const url = await peer({ tools: [{ name: 'read_file' }], listGate: gate });
    const files = session();
    const registering = files.register({
      serverId: 'local-files',
      generation: 1,
      url,
      token: 't',
    });
    registering.catch(() => {});
    // Let discovery reach the held tools/list, then Disconnect before it
    // answers; the delayed response must not reinstall the catalog.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await files.unregister();
    release();
    await expect(registering).rejects.toThrow();
    expect(files.active).toBe(false);
    expect(files.tools()).toEqual([]);
    // A later explicit registration still proceeds normally.
    const next = await peer({ tools: [{ name: 'write_file' }] });
    const count = await files.register({
      serverId: 'local-files',
      generation: 2,
      url: next,
      token: 't2',
    });
    expect(count).toBe(1);
    expect(files.active).toBe(true);
  });

  it('a registration queued before Disconnect is invalidated too', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const url = await peer({ tools: [{ name: 'read_file' }], listGate: gate });
    const files = session();
    // gen 1 parks at tools/list; gen 2 queues behind it. Disconnect lands
    // while gen 2 is still queued — its epoch was captured at request time,
    // so it must not install itself once it finally runs.
    const first = files.register({
      serverId: 'local-files',
      generation: 1,
      url,
      token: 't',
    });
    first.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = files.register({
      serverId: 'local-files',
      generation: 2,
      url,
      token: 't2',
    });
    second.catch(() => {});
    await files.unregister();
    release();
    await expect(first).rejects.toThrow();
    await expect(second).rejects.toThrow();
    expect(files.active).toBe(false);
    expect(files.tools()).toEqual([]);
  });
});
