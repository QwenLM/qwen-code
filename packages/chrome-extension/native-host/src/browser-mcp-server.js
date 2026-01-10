#!/usr/bin/env node

/* global require, process, Buffer, __dirname, setTimeout, console */

/**
 * Browser MCP Server
 * Provides browser tools (read_page, capture_screenshot, etc.) to Qwen CLI
 * Communicates with Native Host via HTTP to get browser data
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require('http');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawn } = require('child_process');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TOOLS } = require('./shared/tools');

// All logs must go to stderr to avoid corrupting MCP stdout framing.
console.error('Browser MCP Server starting...');
const BRIDGE_PORT = process.env.BRIDGE_PORT || '18765';
const BRIDGE_BASE =
  process.env.BRIDGE_BASE || `http://127.0.0.1:${BRIDGE_PORT}`;
const BRIDGE_URL = process.env.BRIDGE_URL || `${BRIDGE_BASE}/api`;
const DEBUG = process.env.BROWSER_MCP_DEBUG !== '0';
console.error(`Bridge URL: ${BRIDGE_URL}`, `Debug: ${DEBUG}`);
const SPAWN_ENABLED =
  process.env.BROWSER_MCP_NO_SPAWN !== '1' &&
  process.env.BROWSER_MCP_SPAWN !== '0';

// MCP Protocol version
const PROTOCOL_VERSION = '2024-11-05';

let bridgeReadyPromise = null;
let hostProcess = null;
let bridgeAvailable = true;

function logAlways(...args) {
  try {
     
    console.error('[browser-mcp]', ...args);
  } catch {
    /* ignore */
  }
}

function logDebug(...args) {
  if (!DEBUG) return;
  try {
    // Use stderr to avoid corrupting MCP stdout framing
     
    console.error('[browser-mcp]', ...args);
  } catch {
    /* ignore */
  }
}

async function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function checkBridgeHealth() {
  logDebug('Checking bridge health at', `${BRIDGE_BASE}/healthz`);
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${BRIDGE_BASE}/healthz`,
      { method: 'GET' },
      (res) => {
        // any 2xx considered healthy
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(true);
        } else {
          reject(new Error(`Health check status ${res.statusCode}`));
        }
      },
    );
    req.on('error', (err) => reject(err));
    req.end();
  });
}

async function ensureBridgeReady() {
  logAlways('ensureBridgeReady: start', {
    node: process.execPath,
    argv: process.argv,
    cwd: process.cwd(),
  });
  if (bridgeReadyPromise) return bridgeReadyPromise;
  bridgeReadyPromise = (async () => {
    // If health OK, done
    try {
      logDebug('Initial health check before spawning host');
      await checkBridgeHealth();
      logDebug('Bridge already healthy, skip spawn');
      return;
    } catch {
      // continue to spawn or bail based on env
      if (!SPAWN_ENABLED) {
        logAlways(
          'Bridge not healthy and spawn is disabled (BROWSER_MCP_NO_SPAWN=1). Please start native-host/host.js manually.',
        );
        bridgeAvailable = false;
        return;
      }
    }

    // Spawn host.js so extension can talk to it
    const hostPath = path.join(__dirname, '..', 'host.js');
    logDebug('Spawning host.js via node', hostPath);
    logAlways('Spawning host.js', hostPath);
    hostProcess = spawn(process.execPath || 'node', [hostPath], {
      // Never send host stdout to MCP stdout (would corrupt Content-Length framing)
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    if (hostProcess.stdout) {
      hostProcess.stdout.on('data', (data) =>
        logAlways('[host.js stdout]', data.toString('utf8').trimEnd()),
      );
    }
    if (hostProcess.stderr) {
      hostProcess.stderr.on('data', (data) =>
        logAlways('[host.js stderr]', data.toString('utf8').trimEnd()),
      );
    }
    hostProcess.on('error', (err) => {
      logAlways('host.js process error', err?.message || err);
    });
    hostProcess.on('exit', (code, signal) => {
      logAlways('host.js exited', { code, signal });
    });

    // Wait for health up to ~5s
    for (let i = 0; i < 10; i++) {
      await wait(500);
      try {
        await checkBridgeHealth();
        logDebug('Bridge healthy after spawn');
        logAlways('Bridge healthy after spawn');
        return;
      } catch {
        // retry
        logDebug('Health check retry', i + 1);
      }
    }
    logDebug('Bridge health check failed after spawning host.js');
    logAlways('Bridge health check failed after spawning host.js');
    bridgeAvailable = false;
    return;
  })();
  return bridgeReadyPromise;
}

process.on('exit', () => {
  if (hostProcess) {
    try {
      hostProcess.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
});

// Send request to Native Host HTTP bridge with simple retry
async function callBridge(method, params = {}) {
  await ensureBridgeReady();
  if (!bridgeAvailable) {
    // Return a predictable error payload instead of throwing to avoid timeouts
    return {
      success: false,
      error:
        'Bridge unavailable (failed to start or bind). If spawn is disabled, start native-host/host.js manually.',
      method,
    };
  }
  const data = JSON.stringify({ method, params });
  const attempt = () =>
    new Promise((resolve, reject) => {
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
              const result = JSON.parse(body || '{}');
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
            `Bridge connection failed: ${err.message}. Ensure host.js is running and the extension is loaded.`,
          ),
        );
      });

      req.write(data);
      req.end();
    });

  // retry twice with small delay
  let lastErr;
  for (let i = 0; i < 3; i++) {
    try {
      return await attempt();
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw lastErr;
}

// Handle MCP tool calls
async function handleToolCall(name, args) {
  switch (name) {
    case 'browser_read_page': {
      const data = await callBridge('read_page');
      if (data?.success === false) {
        return {
          content: [
            {
              type: 'text',
              text: data.error || 'Bridge unavailable for read_page',
            },
          ],
          isError: true,
        };
      }
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
      if (data?.success === false) {
        return {
          content: [
            {
              type: 'text',
              text: data.error || 'Bridge unavailable for capture_screenshot',
            },
          ],
          isError: true,
        };
      }
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
      if (data?.success === false) {
        return {
          content: [
            {
              type: 'text',
              text: data.error || 'Bridge unavailable for get_network_logs',
            },
          ],
          isError: true,
        };
      }
      const logs = data.logs || [];

      if (!logs.length) {
        return {
          content: [
            {
              type: 'text',
              text: 'No network entries captured yet. Try reloading the page or triggering a request, then run again.',
            },
          ],
        };
      }

      // Aggregate by requestId to include method/url/status/headers/bodies
      const byRequest = new Map();
      for (const log of logs) {
        const reqId = log.params?.requestId;
        if (!reqId) continue;
        const entry = byRequest.get(reqId) || { requestId: reqId };

        switch (log.method) {
          case 'Network.requestWillBeSent': {
            entry.method = log.params?.request?.method;
            entry.url =
              log.params?.request?.url || log.params?.documentURL || entry.url;
            entry.requestHeaders = log.params?.request?.headers;
            entry.requestBody = log.params?.request?.postData;
            entry.timestamp = log.timestamp;
            break;
          }
          case 'Network.responseReceived': {
            entry.status = log.params?.response?.status;
            entry.statusText = log.params?.response?.statusText;
            entry.responseHeaders = log.params?.response?.headers;
            entry.timestamp = log.timestamp;
            break;
          }
          case 'Network.responseBody': {
            entry.responseBody = log.params?.body;
            entry.responseBodyBase64 = log.params?.base64Encoded;
            if (log.params?.error) entry.responseBodyError = log.params.error;
            entry.timestamp = log.timestamp;
            break;
          }
          case 'Network.loadingFailed': {
            entry.error = log.params?.errorText || log.params?.error;
            entry.timestamp = log.timestamp;
            break;
          }
          default:
            break;
        }

        byRequest.set(reqId, entry);
      }

      // Take the most recent 20 requests
      const items = Array.from(byRequest.values()).slice(-20);
      const text = `Network requests (last ${items.length}):\n${JSON.stringify(
        items,
        null,
        2,
      )}`;

      return {
        content: [
          {
            type: 'text',
            text,
          },
        ],
      };
    }

    case 'browser_get_console_logs': {
      const data = await callBridge('get_console_logs');
      if (data?.success === false) {
        return {
          content: [
            {
              type: 'text',
              text: data.error || 'Bridge unavailable for get_console_logs',
            },
          ],
          isError: true,
        };
      }
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

    case 'browser_fill_form': {
      const data = await callBridge('fill_form', args);
      if (data?.success === false) {
        return {
          content: [
            {
              type: 'text',
              text: data.error || 'Bridge unavailable for fill_form',
            },
          ],
          isError: true,
        };
      }
      const results = data.results || [];
      return {
        content: [
          {
            type: 'text',
            text: `Fill results:\n${JSON.stringify(results, null, 2)}`,
          },
        ],
      };
    }

    case 'browser_fill_form_auto': {
      const data = await callBridge('fill_form_auto', args);
      if (data?.success === false) {
        return {
          content: [
            {
              type: 'text',
              text: data.error || 'Bridge unavailable for fill_form_auto',
            },
          ],
          isError: true,
        };
      }
      const results = data.results || [];
      return {
        content: [
          {
            type: 'text',
            text: `Auto fill results:\n${JSON.stringify(results, null, 2)}`,
          },
        ],
      };
    }

    case 'browser_input_text': {
      if (!args.selector || args.text === undefined) {
        throw new Error('selector and text are required');
      }
      const data = await callBridge('input_text', args);
      if (data?.success === false) {
        return {
          content: [
            {
              type: 'text',
              text: data.error || 'Bridge unavailable for input_text',
            },
          ],
          isError: true,
        };
      }
      const success = data?.success !== false;
      const message =
        data?.error ||
        data?.message ||
        (success ? 'Filled successfully' : 'Failed to fill input');
      return {
        content: [
          {
            type: 'text',
            text: `Input result: ${message}`,
          },
        ],
        isError: !success,
      };
    }

    case 'browser_click': {
      if (!args.selector) throw new Error('selector is required');
      const data = await callBridge('click_element', args);
      if (data?.success === false) {
        return {
          content: [
            {
              type: 'text',
              text: data.error || 'Bridge unavailable for click_element',
            },
          ],
          isError: true,
        };
      }
      const success = data?.success !== false;
      const message =
        data?.error || (success ? 'Click success' : 'Click failed');
      return {
        content: [
          {
            type: 'text',
            text: message,
          },
        ],
        isError: !success,
      };
    }

    case 'browser_click_text': {
      if (!args.text) throw new Error('text is required');
      const data = await callBridge('click_text', args);
      if (data?.success === false) {
        return {
          content: [
            {
              type: 'text',
              text: data.error || 'Bridge unavailable for click_text',
            },
          ],
          isError: true,
        };
      }
      const success = data?.success !== false;
      const message =
        data?.error || (success ? 'Click success' : 'Click failed');
      return {
        content: [
          {
            type: 'text',
            text: message,
          },
        ],
        isError: !success,
      };
    }

    case 'browser_run_js': {
      if (!args.code) throw new Error('code is required');
      const data = await callBridge('run_js', { code: args.code });
      if (data?.success === false) {
        return {
          content: [
            {
              type: 'text',
              text: data.error || 'Bridge unavailable for run_js',
            },
          ],
          isError: true,
        };
      }
      const success = data?.success !== false;
      const message = data?.error || JSON.stringify(data?.result ?? data);
      return {
        content: [
          {
            type: 'text',
            text: success ? `Result: ${message}` : `Error: ${message}`,
          },
        ],
        isError: !success,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// JSON-RPC framing over stdio (Content-Length)
let inputBuffer = Buffer.alloc(0);
let rawMode = false; // if client does not use Content-Length framing
function writeMessage(obj) {
  const jsonBuf = Buffer.from(JSON.stringify(obj), 'utf8');
  if (rawMode) {
    process.stdout.write(jsonBuf);
    process.stdout.write('\n');
    logAlways('stdout write (raw)', { length: jsonBuf.length + 1 });
    return;
  }
  const header = Buffer.from(
    `Content-Length: ${jsonBuf.length}\r\n\r\n`,
    'utf8',
  );
  process.stdout.write(header);
  process.stdout.write(jsonBuf);
  logAlways('stdout write (CL)', { length: jsonBuf.length });
}
function sendResponse(id, result) {
  writeMessage({ jsonrpc: '2.0', id, result });
}
function sendError(id, code, message) {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message } });
}

// Handle incoming JSON-RPC messages
async function handleMessage(message) {
  logAlways(
    'Received message',
    message?.method || 'response',
    message?.id ?? '',
  );
  const { id, method, params } = message;
  // Use client-provided protocolVersion if available to maximize compatibility
  const clientProtocolVersion = params?.protocolVersion;
  const protocolVersion = clientProtocolVersion || PROTOCOL_VERSION;

  try {
    switch (method) {
      case 'initialize':
        sendResponse(id, {
          protocolVersion,
          capabilities: {
            tools: {},
            resources: {},
          },
          serverInfo: {
            name: 'chrome-browser',
            version: '1.0.0',
          },
        });
        break;

      case 'tool': {
        // Return functionDeclarations compatible with Qwen's mcpToTool expectation
        const functionDeclarations = TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          parametersJsonSchema: t.inputSchema || {
            type: 'object',
            properties: {},
          },
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
  const b64 = chunk.toString('base64');
  const preview = chunk
    .slice(0, 120)
    .toString('utf8')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
  logAlways('stdin data length', chunk.length, 'b64', b64, 'preview', preview);

  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  while (true) {
    let headerEnd = inputBuffer.indexOf('\r\n\r\n');
    let sepLen = 4;
    if (headerEnd === -1) {
      headerEnd = inputBuffer.indexOf('\n\n');
      sepLen = 2;
    }
    if (headerEnd === -1) {
      // Fallback: if no header framing, try to parse the whole buffer as a single JSON message.
      const bufStr = inputBuffer.toString('utf8').trim();
      if (!bufStr) return; // nothing yet
      try {
        logAlways('Parsing message without Content-Length framing', {
          length: inputBuffer.length,
        });
        const message = JSON.parse(bufStr);
        rawMode = true; // respond using raw (newline-delimited) framing to match client
        inputBuffer = Buffer.alloc(0);
        handleMessage(message);
        continue; // loop in case more data arrived together
      } catch (e) {
        logAlways('Waiting for header or complete JSON', e?.message || e, {
          length: inputBuffer.length,
        });
        return; // wait for more data
      }
    }

    const headerStr = inputBuffer.slice(0, headerEnd).toString('utf8');
    logAlways('Header found', { headerEnd, sepLen, headerStr });
    const match = headerStr.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      // drop until next header
      logAlways('No Content-Length found, dropping header', headerStr);
      inputBuffer = inputBuffer.slice(headerEnd + sepLen);
      continue;
    }
    const length = parseInt(match[1], 10);
    const totalLen = headerEnd + sepLen + length;
    if (inputBuffer.length < totalLen) {
      logAlways('Waiting for full body', {
        have: inputBuffer.length,
        need: totalLen,
        contentLength: length,
      });
      return; // wait for full body
    }
    const body = inputBuffer.slice(headerEnd + sepLen, totalLen);
    inputBuffer = inputBuffer.slice(totalLen);
    try {
      const raw = body.toString('utf8');
      logAlways(
        'Parsing message body length',
        body.length,
        'preview',
        raw.slice(0, 200),
      );
      const message = JSON.parse(raw);
      // Debug to stderr (not stdout): show basic method flow

      try {
        console.error(
          '[MCP <-]',
          message.method || 'response',
          message.id ?? '',
        );
      } catch {
        /* ignore */
      }
      handleMessage(message);
    } catch (e) {
      logAlways('JSON parse error', e?.message || e);
      logAlways('Offending body (base64)', body.toString('base64'));
      logAlways('Header/len info', {
        headerEnd,
        sepLen,
        contentLength: length,
        bufferRemaining: inputBuffer.length,
      });
      // ignore parse errors
    }
  }
});

process.stdin.on('end', () => {
  logAlways('stdin ended');
});

process.stdin.on('error', (err) => {
  logAlways('stdin error', err?.message || err);
});

process.on('exit', (code) => {
  logAlways('browser-mcp exiting', { code });
});

// Kick off bridge readiness early so we see logs even before first tool call
(async () => {
  try {
    logAlways('Pre-flight bridge check...');
    await ensureBridgeReady();
    logAlways('Pre-flight bridge check done.');
  } catch (err) {
    logAlways('Pre-flight bridge check failed', err?.message || err);
  }
})();

// Handle errors
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason) => {
  logAlways('Unhandled rejection', reason);
});

// If no MCP traffic arrives within a short window, log a hint and keep running
setTimeout(() => {
  logAlways(
    'No MCP traffic received yet. If this server was launched manually, that is normal. If launched by qwen mcp, ensure the process is still running and not being killed.',
  );
}, 3000);
