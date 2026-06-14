/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * This test verifies MCP (Model Context Protocol) server integration.
 * It uses a minimal MCP server implementation that doesn't require
 * external dependencies, making it compatible with Docker sandbox mode.
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { TestRig, validateModelOutput } from '../test-helper.js';
import { join, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { hashMcpServerConfig } from '@qwen-code/qwen-code-core';

// Create a minimal MCP server that doesn't require external dependencies
// This implements the MCP protocol directly using Node.js built-ins
const INTEGRATION_TOKEN = 'qwen-mcp-tool-token-7f31d0';
const additionServerConfig = {
  command: 'node',
  args: ['mcp-server.cjs'],
};
const serverScript = `#!/usr/bin/env node
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const readline = require('readline');
const fs = require('fs');

// Debug logging to stderr (only when MCP_DEBUG or VERBOSE is set)
const debugEnabled = process.env['MCP_DEBUG'] === 'true' || process.env['VERBOSE'] === 'true';
function debug(msg) {
  if (debugEnabled) {
    fs.writeSync(2, \`[MCP-DEBUG] \${msg}\\n\`);
  }
}

debug('MCP server starting...');

// Simple JSON-RPC implementation for MCP
class SimpleJSONRPC {
  constructor() {
    this.handlers = new Map();
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false
    });
    
    this.rl.on('line', (line) => {
      debug(\`Received line: \${line}\`);
      try {
        const message = JSON.parse(line);
        debug(\`Parsed message: \${JSON.stringify(message)}\`);
        this.handleMessage(message);
      } catch (e) {
        debug(\`Parse error: \${e.message}\`);
      }
    });
  }
  
  send(message) {
    const msgStr = JSON.stringify(message);
    debug(\`Sending message: \${msgStr}\`);
    process.stdout.write(msgStr + '\\n');
  }
  
  async handleMessage(message) {
    if (message.method && this.handlers.has(message.method)) {
      try {
        const result = await this.handlers.get(message.method)(message.params || {});
        if (message.id !== undefined) {
          this.send({
            jsonrpc: '2.0',
            id: message.id,
            result
          });
        }
      } catch (error) {
        if (message.id !== undefined) {
          this.send({
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: -32603,
              message: error.message
            }
          });
        }
      }
    } else if (message.id !== undefined) {
      this.send({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32601,
          message: 'Method not found'
        }
      });
    }
  }
  
  on(method, handler) {
    this.handlers.set(method, handler);
  }
}

// Create MCP server
const rpc = new SimpleJSONRPC();

// Handle initialize
rpc.on('initialize', async (params) => {
  debug('Handling initialize request');
  return {
    protocolVersion: '2024-11-05',
    capabilities: {
      tools: {}
    },
    serverInfo: {
      name: 'addition-server',
      version: '1.0.0'
    }
  };
});

const INTEGRATION_TOKEN = ${JSON.stringify(INTEGRATION_TOKEN)};

// Handle tools/list
rpc.on('tools/list', async () => {
  debug('Handling tools/list request');
  return {
    tools: [{
      name: 'get_integration_token',
      description: 'Return the integration-test token',
      inputSchema: {
        type: 'object',
        properties: {}
      }
    }]
  };
});

// Handle tools/call
rpc.on('tools/call', async (params) => {
  debug(\`Handling tools/call request for tool: \${params.name}\`);
  if (params.name === 'get_integration_token') {
    return {
      content: [{
        type: 'text',
        text: INTEGRATION_TOKEN
      }]
    };
  }
  throw new Error('Unknown tool: ' + params.name);
});

// Send initialization notification
rpc.send({
  jsonrpc: '2.0',
  method: 'initialized'
});
`;

describe('simple-mcp-server', () => {
  const rig = new TestRig();
  let previousMcpApprovalsPath: string | undefined;

  beforeAll(async () => {
    // Force the pre-#3994 synchronous MCP discovery path: under progressive
    // MCP availability the spawned CLI's first non-interactive `--prompt`
    // request fires without the MCP `add` tool wired into the model's tool
    // surface, so the model answers `15` directly and `foundToolCall` stays
    // false. Remove once QwenLM/qwen-code#4163 is fixed.
    process.env['QWEN_CODE_LEGACY_MCP_BLOCKING'] = '1';

    // Setup test directory with MCP server configuration
    await rig.setup('simple-mcp-server', {
      settings: {
        mcpServers: {
          'addition-server': additionServerConfig,
        },
      },
    });

    previousMcpApprovalsPath = process.env['QWEN_CODE_MCP_APPROVALS_PATH'];
    const approvalsPath = join(rig.testDir!, '.qwen', 'mcpApprovals.json');
    process.env['QWEN_CODE_MCP_APPROVALS_PATH'] = approvalsPath;
    writeFileSync(
      approvalsPath,
      JSON.stringify(
        {
          [resolve(rig.testDir!)]: {
            'addition-server': {
              hash: hashMcpServerConfig(additionServerConfig),
              status: 'approved',
            },
          },
        },
        null,
        2,
      ),
    );

    // Create server script in the test directory
    const testServerPath = join(rig.testDir!, 'mcp-server.cjs');
    writeFileSync(testServerPath, serverScript);

    // Make the script executable (though running with 'node' should work anyway)
    if (process.platform !== 'win32') {
      const { chmodSync } = await import('node:fs');
      chmodSync(testServerPath, 0o755);
    }

    // Poll for script for up to 5s
    const { accessSync, constants } = await import('node:fs');
    const isReady = await rig.poll(
      () => {
        try {
          accessSync(testServerPath, constants.F_OK);
          return true;
        } catch {
          return false;
        }
      },
      5000, // Max wait 5 seconds
      100, // Poll every 100ms
    );

    if (!isReady) {
      throw new Error('MCP server script was not ready in time.');
    }
  });

  afterAll(() => {
    if (previousMcpApprovalsPath === undefined) {
      delete process.env['QWEN_CODE_MCP_APPROVALS_PATH'];
    } else {
      process.env['QWEN_CODE_MCP_APPROVALS_PATH'] = previousMcpApprovalsPath;
    }
  });

  it('should call an MCP tool and return its result', async () => {
    // Test directory is already set up in before hook
    // Just run the command - MCP server config is in settings.json
    const output = await rig.run(
      'Use the get_integration_token tool and print the returned token. Do not guess it.',
    );

    const foundToolCall = await rig.waitForToolCall(
      'mcp__addition-server__get_integration_token',
    );

    expect(
      foundToolCall,
      'Expected to find a get_integration_token tool call',
    ).toBeTruthy();

    // Validate model output - will throw if no output, fail if missing expected content
    validateModelOutput(output, INTEGRATION_TOKEN, 'MCP server test');
    expect(
      output.includes(INTEGRATION_TOKEN),
      'Expected output to contain the MCP tool token',
    ).toBeTruthy();
  });
});
