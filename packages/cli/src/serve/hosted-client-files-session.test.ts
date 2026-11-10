/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLIENT_FILES_MAX_RESULT_BYTES,
  HostedClientFilesSession,
} from './hosted-client-files-session.js';

interface Script {
  tools?: Array<{ name: string; description?: string; inputSchema?: object }>;
  resultText?: string;
  refuseInitialize?: boolean;
  /** JSON-RPC error answered to tools/call, e.g. the relay offline error. */
  callError?: { code: number; message: string };
  /** HTTP status answered to tools/call, e.g. a revoked relay credential. */
  callStatus?: number;
  /** Answer tools/list with the relay offline error during registration. */
  listError?: boolean;
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
    req.on('end', () => {
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
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
        if (script.listError) {
          replyError({ code: -32000, message: 'client_files_offline' });
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
    expect(files.resolve(declarations[0].name)?.name).toBe('read_file');
    expect(files.catalogs()[0].serverId).toBe('local-files');
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
    const tool = files.resolve(files.tools()[0].name)!;
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
    const tool = files.resolve(files.tools()[0].name)!;
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
    const tool = files.resolve(files.tools()[0].name)!;
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
    const tool = files.resolve(files.tools()[0].name)!;
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
    expect(files.resolve(files.tools()[0].name)?.name).toBe('write_file');
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
});
