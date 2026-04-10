#!/usr/bin/env node
/**
 * Zero-dependency MCP test server template.
 * Speaks JSON-RPC over stdin/stdout — no npm install needed.
 *
 * Usage:
 *   1. Edit TOOL_DEFINITIONS to define your tools
 *   2. Edit handleToolCall() to implement tool behavior
 *   3. Configure in .qwen/settings.json and run via the CLI
 *
 * Sanity check without the CLI:
 *   printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}\n' | node mcp-test-server.js
 */

const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, terminal: false });

// ---------------------------------------------------------------------------
// Configure your tools here
// ---------------------------------------------------------------------------

const SERVER_NAME = 'test-server';
const SERVER_VERSION = '1.0.0';

const TOOL_DEFINITIONS = [
  {
    name: 'echo',
    description: 'Echoes back the provided arguments as JSON.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Message to echo' },
      },
      required: ['message'],
    },
  },
  // Add more tools here
];

function handleToolCall(name, args) {
  switch (name) {
    case 'echo':
      return `Echo: ${JSON.stringify(args)}`;
    // Add more cases here
    default:
      return null; // returning null signals unknown tool
  }
}

// ---------------------------------------------------------------------------
// MCP protocol handling — no need to edit below this line
// ---------------------------------------------------------------------------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

rl.on('line', (line) => {
  let req;
  try {
    req = JSON.parse(line.trim());
  } catch {
    return;
  }

  if (req.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    });
  } else if (req.method === 'notifications/initialized') {
    // no response needed
  } else if (req.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: { tools: TOOL_DEFINITIONS },
    });
  } else if (req.method === 'tools/call') {
    const toolName = req.params?.name;
    const args = req.params?.arguments || {};
    const result = handleToolCall(toolName, args);

    if (result === null) {
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          content: [{ type: 'text', text: `Unknown tool: ${toolName}` }],
          isError: true,
        },
      });
    } else {
      send({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          content: [{ type: 'text', text: String(result) }],
        },
      });
    }
  } else if (req.id) {
    send({
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32601, message: 'Method not found' },
    });
  }
});
