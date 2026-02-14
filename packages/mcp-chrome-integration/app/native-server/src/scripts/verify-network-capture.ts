import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

type ToolResult = {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: any;
  isError?: boolean;
};

const DEFAULT_TOOL_TIMEOUT_MS = Number(
  process.env.MCP_TOOL_TIMEOUT_MS || 15000,
);

function extractStructured(result: ToolResult) {
  if (result?.structuredContent) return result.structuredContent;
  const text = result?.content?.[0]?.text;
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function callTool(
  client: Client,
  name: string,
  args: Record<string, any>,
) {
  console.log(`[verify] callTool ${name}`);
  const result = (await Promise.race([
    client.callTool({ name, arguments: args }, undefined, {
      timeout: DEFAULT_TOOL_TIMEOUT_MS,
    }),
    delay(DEFAULT_TOOL_TIMEOUT_MS + 2000).then(() => {
      throw new Error(
        `Tool ${name} timed out after ${DEFAULT_TOOL_TIMEOUT_MS}ms`,
      );
    }),
  ])) as ToolResult;
  if (result?.isError) {
    throw new Error(`Tool ${name} failed: ${result.content?.[0]?.text || ''}`);
  }
  console.log(`[verify] callTool ${name} ok`);
  return extractStructured(result);
}

function createTestPageHtml(port: number) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Qwen Network Test</title>
  </head>
  <body>
    <h1>Network Capture Test</h1>
    <script>
      fetch('http://127.0.0.1:${port}/api/data')
        .then(res => res.text())
        .then(() => {});
      const xhr = new XMLHttpRequest();
      xhr.open('POST', 'http://127.0.0.1:${port}/api/echo');
      xhr.setRequestHeader('content-type', 'application/json');
      xhr.send(JSON.stringify({ ping: 'pong' }));
      const ws = new WebSocket('ws://127.0.0.1:${port}/ws');
      ws.addEventListener('open', () => {
        ws.send('hello-from-client');
      });
    </script>
  </body>
</html>`;
}

function sendWebSocketText(socket: Duplex, text: string) {
  const payload = Buffer.from(text);
  const length = payload.length;
  if (length > 125) {
    throw new Error('Payload too large for simple frame');
  }
  const frame = Buffer.alloc(2 + length);
  frame[0] = 0x81;
  frame[1] = length;
  payload.copy(frame, 2);
  socket.write(frame);
}

async function startTestServer() {
  let port = 0;
  const sockets = new Set<Duplex>();
  const server = http.createServer((req, res) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end('bad request');
      return;
    }
    if (req.url === '/test') {
      const html = createTestPageHtml(port);
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(html);
      return;
    }
    if (req.url.startsWith('/api/data')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url.startsWith('/api/echo')) {
      let body = '';
      req.on('data', (chunk) => {
        body += String(chunk);
      });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(body || JSON.stringify({ ok: true }));
      });
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    if (req.url !== '/ws') {
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (!key || Array.isArray(key)) {
      socket.destroy();
      return;
    }
    const accept = crypto
      .createHash('sha1')
      .update(key + GUID)
      .digest('base64');
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'),
    );
    sendWebSocketText(socket, 'hello-from-server');
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });

  return { server, port, sockets };
}

async function main() {
  const { server, port, sockets } = await startTestServer();
  const mcpUrl = process.env.MCP_URL || 'http://127.0.0.1:12306/mcp';
  const client = new Client(
    { name: 'Qwen Network Capture Verifier', version: '1.0.0' },
    { capabilities: {} },
  );

  try {
    console.log(`[verify] test server listening on 127.0.0.1:${port}`);
    console.log(`[verify] connecting to MCP at ${mcpUrl}`);
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {});
    await Promise.race([
      client.connect(transport),
      delay(10000).then(() => {
        throw new Error(
          `Timed out connecting to MCP at ${mcpUrl}. Ensure the native server is running and the extension is connected.`,
        );
      }),
    ]);
    console.log('[verify] MCP connected');

    const windowsResult = await callTool(client, 'get_windows_and_tabs', {});
    const windows = windowsResult?.windows || [];
    const activeTabId =
      windows
        .flatMap((win: any) => win.tabs || [])
        .find((tab: any) => tab.active)?.tabId ||
      windows?.[0]?.tabs?.[0]?.tabId;

    if (!activeTabId) {
      throw new Error(
        'No active tab found. Please open Chrome with the extension enabled.',
      );
    }

    await callTool(client, 'chrome_network_capture', {
      action: 'start',
      needResponseBody: true,
      needDocumentBody: true,
      captureWebSocket: true,
      includeStatic: false,
      maxEntries: 200,
    });

    await callTool(client, 'chrome_navigate', {
      url: `http://127.0.0.1:${port}/test`,
      tabId: activeTabId,
    });

    await delay(3000);

    const stopResult = await callTool(client, 'chrome_network_capture', {
      action: 'stop',
    });

    let capture = stopResult?.capture;
    if (!capture) {
      console.warn(
        '[verify] capture field missing; falling back to legacy response shape. Rebuild/reload the extension to get standardized capture output.',
      );
      console.log(
        '[verify] stopResult payload:',
        JSON.stringify(stopResult, null, 2),
      );
      capture = {
        requests: stopResult?.requests || [],
        websockets: stopResult?.websockets || [],
      };
    }
    assert.ok(capture, 'Missing capture result');

    const requests = capture.requests || [];
    const hasData = requests.some((req: any) => {
      const url = String(req.url || req.request?.url || '');
      const bodyText = String(
        req.response?.body?.text ?? req.responseBody ?? '',
      );
      return url.includes('/api/data') && bodyText.includes('"ok":true');
    });
    assert.ok(hasData, 'Missing /api/data response body');

    const hasDocument = requests.some((req: any) => {
      const url = String(req.url || req.request?.url || '');
      const bodyText = String(
        req.response?.body?.text ?? req.responseBody ?? '',
      );
      return url.includes('/test') && bodyText.includes('Network Capture Test');
    });
    assert.ok(hasDocument, 'Missing document response body');

    const websockets = capture.websockets || [];
    const hasWebSocketFrame = websockets.some((session: any) =>
      (session.frames || []).some((frame: any) =>
        String(frame.payload || '').includes('hello-from-server'),
      ),
    );
    assert.ok(
      hasWebSocketFrame,
      'Missing WebSocket frame payload (check captureWebSocket flag and extension build)',
    );

    console.log('Network capture verification passed.');
  } finally {
    for (const socket of sockets) {
      try {
        socket.destroy();
      } catch {
        // ignore
      }
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await client.close();
  }
}

main().catch((error) => {
  console.error('Network capture verification failed:', error);
  process.exit(1);
});
