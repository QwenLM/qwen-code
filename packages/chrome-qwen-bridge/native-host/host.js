#!/usr/bin/env node

/**
 * Native Messaging Host for Qwen CLI Bridge
 * This script acts as a bridge between the Chrome extension and Qwen CLI
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Native Messaging protocol helpers
function sendMessage(message) {
  const buffer = Buffer.from(JSON.stringify(message));
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32LE(buffer.length, 0);

  process.stdout.write(length);
  process.stdout.write(buffer);
}

function readMessages() {
  let messageLength = null;
  let chunks = [];

  process.stdin.on('readable', () => {
    let chunk;

    while ((chunk = process.stdin.read()) !== null) {
      chunks.push(chunk);
      const buffer = Buffer.concat(chunks);

      // Read message length if we haven't yet
      if (messageLength === null) {
        if (buffer.length >= 4) {
          messageLength = buffer.readUInt32LE(0);
          chunks = [buffer.slice(4)];
        }
      }

      // Read message if we have the full length
      if (messageLength !== null) {
        const fullBuffer = Buffer.concat(chunks);

        if (fullBuffer.length >= messageLength) {
          const messageBuffer = fullBuffer.slice(0, messageLength);
          const message = JSON.parse(messageBuffer.toString());

          // Reset for next message
          chunks = [fullBuffer.slice(messageLength)];
          messageLength = null;

          // Handle the message
          handleMessage(message);
        }
      }
    }
  });

  process.stdin.on('end', () => {
    process.exit();
  });
}

// Qwen CLI process management
let qwenProcess = null;
let qwenStatus = 'disconnected';
let qwenCapabilities = [];

// Check if Qwen CLI is installed
function checkQwenInstallation() {
  return new Promise((resolve) => {
    try {
      const checkProcess = spawn('qwen', ['--version'], {
        shell: true,
        windowsHide: true
      });

      checkProcess.on('error', () => {
        resolve(false);
      });

      checkProcess.on('close', (code) => {
        resolve(code === 0);
      });

      // Timeout after 5 seconds
      setTimeout(() => {
        checkProcess.kill();
        resolve(false);
      }, 5000);
    } catch (error) {
      resolve(false);
    }
  });
}

// Start Qwen CLI process
async function startQwenCli(config = {}) {
  if (qwenProcess) {
    return { success: false, error: 'Qwen CLI is already running' };
  }

  try {
    // Build command arguments
    const args = [];

    // Add MCP servers if specified
    if (config.mcpServers && config.mcpServers.length > 0) {
      for (const server of config.mcpServers) {
        args.push('mcp', 'add', '--transport', 'http', server, `http://localhost:${config.httpPort || 8080}/mcp/${server}`);
        args.push('&&');
      }
    }

    // Start the CLI server
    args.push('qwen', 'server');

    if (config.httpPort) {
      args.push('--port', String(config.httpPort));
    }

    // Spawn the process
    qwenProcess = spawn(args.join(' '), {
      shell: true,
      windowsHide: true,
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Check if process started successfully
    if (!qwenProcess || !qwenProcess.pid) {
      qwenProcess = null;
      qwenStatus = 'stopped';
      return {
        success: false,
        error: 'Failed to start Qwen CLI process'
      };
    }

    qwenStatus = 'running';

    // Handle process output
    qwenProcess.stdout.on('data', (data) => {
      const output = data.toString();
      sendMessage({
        type: 'event',
        data: {
          type: 'qwen_output',
          content: output
        }
      });
    });

    qwenProcess.stderr.on('data', (data) => {
      const error = data.toString();
      sendMessage({
        type: 'event',
        data: {
          type: 'qwen_error',
          content: error
        }
      });
    });

    qwenProcess.on('close', (code) => {
      qwenProcess = null;
      qwenStatus = 'stopped';
      sendMessage({
        type: 'event',
        data: {
          type: 'qwen_stopped',
          code: code
        }
      });
    });

    // Wait a bit for the process to start
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Get capabilities
    qwenCapabilities = await getQwenCapabilities();

    return {
      success: true,
      data: {
        status: 'running',
        pid: qwenProcess && qwenProcess.pid ? qwenProcess.pid : null,
        capabilities: qwenCapabilities
      }
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// Stop Qwen CLI process
function stopQwenCli() {
  if (!qwenProcess) {
    return { success: false, error: 'Qwen CLI is not running' };
  }

  try {
    qwenProcess.kill('SIGTERM');
    qwenProcess = null;
    qwenStatus = 'stopped';

    return {
      success: true,
      data: 'Qwen CLI stopped'
    };
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// Get Qwen CLI capabilities (MCP servers, tools, etc.)
async function getQwenCapabilities() {
  return new Promise((resolve) => {
    const checkProcess = spawn('qwen', ['mcp', 'list', '--json'], {
      shell: true,
      windowsHide: true
    });

    let output = '';

    checkProcess.stdout.on('data', (data) => {
      output += data.toString();
    });

    checkProcess.on('close', () => {
      try {
        const capabilities = JSON.parse(output);
        resolve(capabilities);
      } catch {
        resolve([]);
      }
    });

    checkProcess.on('error', () => {
      resolve([]);
    });

    // Timeout after 5 seconds
    setTimeout(() => {
      checkProcess.kill();
      resolve([]);
    }, 5000);
  });
}

// Send request to Qwen CLI via HTTP
async function sendToQwenHttp(action, data, config = {}) {
  const http = require('http');

  const port = config.httpPort || 8080;
  const hostname = 'localhost';

  const postData = JSON.stringify({
    action,
    data
  });

  const options = {
    hostname,
    port,
    path: '/api/process',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let responseData = '';

      res.on('data', (chunk) => {
        responseData += chunk;
      });

      res.on('end', () => {
        try {
          const response = JSON.parse(responseData);
          resolve(response);
        } catch (error) {
          reject(new Error('Invalid response from Qwen CLI'));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(postData);
    req.end();
  });
}

// Handle messages from Chrome extension
async function handleMessage(message) {
  let response;

  switch (message.type) {
    case 'handshake':
      // Initial handshake with extension
      const isInstalled = await checkQwenInstallation();
      response = {
        type: 'handshake_response',
        version: '1.0.0',
        qwenInstalled: isInstalled,
        qwenStatus: qwenStatus,
        capabilities: qwenCapabilities
      };
      break;

    case 'start_qwen':
      // Start Qwen CLI
      const startResult = await startQwenCli(message.config);
      response = {
        type: 'response',
        id: message.id,
        ...startResult
      };
      break;

    case 'stop_qwen':
      // Stop Qwen CLI
      const stopResult = stopQwenCli();
      response = {
        type: 'response',
        id: message.id,
        ...stopResult
      };
      break;

    case 'qwen_request':
      // Send request to Qwen CLI
      try {
        if (qwenStatus !== 'running') {
          throw new Error('Qwen CLI is not running');
        }

        const qwenResponse = await sendToQwenHttp(
          message.action,
          message.data,
          message.config
        );

        response = {
          type: 'response',
          id: message.id,
          data: qwenResponse
        };
      } catch (error) {
        response = {
          type: 'response',
          id: message.id,
          error: error.message
        };
      }
      break;

    case 'get_status':
      // Get current status
      response = {
        type: 'response',
        id: message.id,
        data: {
          qwenInstalled: await checkQwenInstallation(),
          qwenStatus: qwenStatus,
          qwenPid: qwenProcess ? qwenProcess.pid : null,
          capabilities: qwenCapabilities
        }
      };
      break;

    default:
      response = {
        type: 'response',
        id: message.id,
        error: `Unknown message type: ${message.type}`
      };
  }

  sendMessage(response);
}

// Clean up on exit
process.on('SIGINT', () => {
  if (qwenProcess) {
    qwenProcess.kill();
  }
  process.exit();
});

process.on('SIGTERM', () => {
  if (qwenProcess) {
    qwenProcess.kill();
  }
  process.exit();
});

// Log function for debugging (writes to a file since stdout is used for messaging)
function log(message) {
  const logFile = path.join(os.tmpdir(), 'qwen-bridge-host.log');
  fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`);
}

// Main execution
log('Native host started');
readMessages();