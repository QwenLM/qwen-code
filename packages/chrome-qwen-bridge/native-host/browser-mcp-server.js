#!/usr/bin/env node

/**
 * Browser MCP Server
 * Provides browser tools (read_page, capture_screenshot, etc.) to Qwen CLI
 * Communicates with Native Host via HTTP to get browser data
 */

const http = require('http');

const BRIDGE_URL = 'http://127.0.0.1:18765';

// MCP Protocol version
const PROTOCOL_VERSION = '2024-11-05';

// Available tools
const TOOLS = [
  {
    name: 'browser_read_page',
    description:
      'Read the content of the current browser page. Returns URL, title, text content, links, and images.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'browser_capture_screenshot',
    description:
      'Capture a screenshot of the current browser tab. Returns a base64-encoded PNG image.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'browser_get_network_logs',
    description:
      'Get network request logs from the current browser tab. Useful for debugging API calls.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'browser_get_console_logs',
    description:
      'Get console logs (log, error, warn, info) from the current browser tab.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

// Send request to Native Host HTTP bridge
async function callBridge(method, params = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ method, params });

    const req = http.request(
      BRIDGE_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          try {
            const result = JSON.parse(body);
            if (result.success) {
              resolve(result.data);
            } else {
              reject(new Error(result.error || 'Unknown error'));
            }
          } catch (err) {
            reject(new Error(`Failed to parse response: ${err.message}`));
          }
        });
      },
    );

    req.on('error', (err) => {
      reject(
        new Error(
          `Bridge connection failed: ${err.message}. Make sure Chrome extension is running.`,
        ),
      );
    });

    req.write(data);
    req.end();
  });
}

// Handle MCP tool calls
async function handleToolCall(name, args) {
  switch (name) {
    case 'browser_read_page': {
      const data = await callBridge('read_page');
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                url: data.url,
                title: data.title,
                content: data.content?.text || data.content?.markdown || '',
                linksCount: data.links?.length || 0,
                imagesCount: data.images?.length || 0,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    case 'browser_capture_screenshot': {
      const data = await callBridge('capture_screenshot');
      return {
        content: [
          {
            type: 'image',
            data: data.dataUrl?.replace(/^data:image\/png;base64,/, '') || '',
            mimeType: 'image/png',
          },
        ],
      };
    }

    case 'browser_get_network_logs': {
      const data = await callBridge('get_network_logs');
      const logs = data.logs || [];
      const summary = logs.slice(-50).map((log) => ({
        method: log.method,
        url: log.params?.request?.url || log.params?.documentURL,
        status: log.params?.response?.status,
        timestamp: log.timestamp,
      }));
      return {
        content: [
          {
            type: 'text',
            text: `Network logs (last ${summary.length} entries):\n${JSON.stringify(summary, null, 2)}`,
          },
        ],
      };
    }

    case 'browser_get_console_logs': {
      const data = await callBridge('get_console_logs');
      const logs = data.logs || [];
      const formatted = logs
        .slice(-50)
        .map((log) => `[${log.type}] ${log.message}`)
        .join('\n');
      return {
        content: [
          {
            type: 'text',
            text: `Console logs (last ${Math.min(logs.length, 50)} entries):\n${formatted || '(no logs captured)'}`,
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// JSON-RPC framing over stdio (Content-Length)
let inputBuffer = Buffer.alloc(0);
function writeMessage(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.from(`Content-Length: ${json.length}\r\n\r\n`, 'utf8');
  process.stdout.write(header);
  process.stdout.write(json);
}
function sendResponse(id, result) {
  writeMessage({ jsonrpc: '2.0', id, result });
}
function sendError(id, code, message) {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

// Handle incoming JSON-RPC messages
async function handleMessage(message) {
  const { id, method, params } = message;

  try {
    switch (method) {
      case 'initialize':
        sendResponse(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'chrome-browser',
            version: '1.0.0',
          },
        });
        break;

      case 'tool': {
        // Return functionDeclarations compatible with Qwen's mcpToTool expectation
        const functionDeclarations = TOOLS.map(t => ({
          name: t.name,
          description: t.description,
          parametersJsonSchema: t.inputSchema || { type: 'object', properties: {} },
        }));
        sendResponse(id, { functionDeclarations });
        break;
      }

      case 'notifications/initialized':
        // No response needed for notifications
        break;

      case 'tools/list':
        sendResponse(id, { tools: TOOLS });
        break;

      case 'tools/call':
        try {
          const result = await handleToolCall(
            params.name,
            params.arguments || {},
          );
          sendResponse(id, result);
        } catch (err) {
          sendResponse(id, {
            content: [
              {
                type: 'text',
                text: `Error: ${err.message}`,
              },
            ],
            isError: true,
          });
        }
        break;

      case 'ping':
        sendResponse(id, {});
        break;

      default:
        if (id !== undefined) {
          sendError(id, -32601, `Method not found: ${method}`);
        }
    }
  } catch (err) {
    if (id !== undefined) {
      sendError(id, -32603, err.message);
    }
  }
}

// Main: Read JSON-RPC messages from stdin (Content-Length framed)
process.stdin.on('data', (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  while (true) {
    let headerEnd = inputBuffer.indexOf('\r\n\r\n');
    let sepLen = 4;
    if (headerEnd === -1) {
      headerEnd = inputBuffer.indexOf('\n\n');
      sepLen = 2;
    }
    if (headerEnd === -1) return; // wait for full header

    const headerStr = inputBuffer.slice(0, headerEnd).toString('utf8');
    const match = headerStr.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      // drop until next header
      inputBuffer = inputBuffer.slice(headerEnd + sepLen);
      continue;
    }
    const length = parseInt(match[1], 10);
    const totalLen = headerEnd + sepLen + length;
    if (inputBuffer.length < totalLen) return; // wait for full body
    const body = inputBuffer.slice(headerEnd + sepLen, totalLen);
    inputBuffer = inputBuffer.slice(totalLen);
    try {
      const message = JSON.parse(body.toString('utf8'));
      // Debug to stderr (not stdout): show basic method flow
      try { console.error('[MCP <-]', message.method || 'response', message.id ?? ''); } catch (_) {}
      handleMessage(message);
    } catch (e) {
      try { console.error('[MCP] JSON parse error:', e.message); } catch (_) {}
      // ignore parse errors
    }
  }
});

// Handle errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
