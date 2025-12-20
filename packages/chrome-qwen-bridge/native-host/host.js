#!/usr/bin/env node

/**
 * Native Messaging Host for Qwen CLI Bridge
 * This script acts as a bridge between the Chrome extension and Qwen CLI
 * Uses ACP (Agent Communication Protocol) for communication with Qwen CLI
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ============================================================================
// Logging
// ============================================================================

const LOG_FILE = path.join(os.tmpdir(), 'qwen-bridge-host.log');

function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const logLine = `[${timestamp}] [${level}] ${message}\n`;
  fs.appendFileSync(LOG_FILE, logLine);
}

function logError(message) {
  log(message, 'ERROR');
}

function logDebug(message) {
  log(message, 'DEBUG');
}

// ============================================================================
// Native Messaging Protocol (Chrome Extension <-> Native Host)
// ============================================================================

function sendMessageToExtension(message) {
  const buffer = Buffer.from(JSON.stringify(message));
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32LE(buffer.length, 0);

  process.stdout.write(length);
  process.stdout.write(buffer);
}

function readMessagesFromExtension() {
  let messageLength = null;
  let chunks = [];

  // Keep stdin open and in flowing mode
  process.stdin.resume();

  process.stdin.on('data', (chunk) => {
    log(`Received ${chunk.length} bytes from extension`);
    chunks.push(chunk);

    while (true) {
      const buffer = Buffer.concat(chunks);

      // Need at least 4 bytes for length
      if (messageLength === null) {
        if (buffer.length < 4) break;
        messageLength = buffer.readUInt32LE(0);
        chunks = [buffer.slice(4)];
        log(`Message length: ${messageLength}`);
        continue;
      }

      // Check if we have the full message
      const fullBuffer = Buffer.concat(chunks);
      if (fullBuffer.length < messageLength) break;

      // Extract and parse message
      const messageBuffer = fullBuffer.slice(0, messageLength);
      try {
        const message = JSON.parse(messageBuffer.toString());
        log(`Received message: ${JSON.stringify(message)}`);

        // Reset for next message
        chunks = [fullBuffer.slice(messageLength)];
        messageLength = null;

        // Handle the message
        handleExtensionMessage(message);
      } catch (err) {
        logError(`Failed to parse message: ${err.message}`);
        chunks = [fullBuffer.slice(messageLength)];
        messageLength = null;
      }
    }
  });

  process.stdin.on('end', () => {
    log('stdin ended');
    cleanup();
    process.exit();
  });

  process.stdin.on('error', (err) => {
    logError(`stdin error: ${err.message}`);
  });
}

// ============================================================================
// ACP Protocol (Native Host <-> Qwen CLI)
// ============================================================================

const ACP_PROTOCOL_VERSION = 1;

class AcpConnection {
  constructor() {
    this.process = null;
    this.status = 'disconnected';
    this.sessionId = null;
    this.pendingRequests = new Map();
    this.nextRequestId = 1;
    this.inputBuffer = '';
  }

  async start(cwd = process.cwd()) {
    if (this.process) {
      return { success: false, error: 'Qwen CLI is already running' };
    }

    try {
      log(`Starting Qwen CLI with ACP mode in ${cwd}`);

      this.process = spawn('qwen', ['--experimental-acp'], {
        cwd,
        shell: true,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      if (!this.process || !this.process.pid) {
        this.process = null;
        this.status = 'stopped';
        return { success: false, error: 'Failed to start Qwen CLI process' };
      }

      this.status = 'starting';

      // Handle stdout (ACP messages from Qwen CLI)
      this.process.stdout.on('data', (data) => {
        this.handleAcpData(data.toString());
      });

      // Handle stderr (logs from Qwen CLI)
      this.process.stderr.on('data', (data) => {
        const message = data.toString().trim();
        if (message) {
          log(`Qwen stderr: ${message}`);
        }
      });

      // Handle process exit
      this.process.on('close', (code) => {
        log(`Qwen CLI exited with code ${code}`);
        this.process = null;
        this.status = 'stopped';
        this.sessionId = null;

        // Reject all pending requests
        for (const [id, { reject }] of this.pendingRequests) {
          reject(new Error('Qwen CLI process exited'));
        }
        this.pendingRequests.clear();

        sendMessageToExtension({
          type: 'event',
          data: { type: 'qwen_stopped', code }
        });
      });

      this.process.on('error', (err) => {
        logError(`Qwen CLI process error: ${err.message}`);
        this.status = 'error';
      });

      // Initialize ACP connection
      const initResult = await this.initialize();
      if (!initResult.success) {
        this.stop();
        return initResult;
      }

      // Create a new session
      const sessionResult = await this.createSession(cwd);
      if (!sessionResult.success) {
        this.stop();
        return sessionResult;
      }

      this.status = 'running';
      return {
        success: true,
        data: {
          status: 'running',
          pid: this.process.pid,
          sessionId: this.sessionId,
          agentInfo: initResult.data.agentInfo
        }
      };
    } catch (error) {
      logError(`Failed to start Qwen CLI: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  handleAcpData(data) {
    this.inputBuffer += data;
    const lines = this.inputBuffer.split('\n');
    this.inputBuffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const message = JSON.parse(trimmed);
        this.handleAcpMessage(message);
      } catch (err) {
        logError(`Failed to parse ACP message: ${trimmed}`);
      }
    }
  }

  handleAcpMessage(message) {
    logDebug(`ACP received: ${JSON.stringify(message)}`);

    // Handle response to our request
    if ('id' in message && !('method' in message)) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        if ('result' in message) {
          pending.resolve(message.result);
        } else if ('error' in message) {
          pending.reject(new Error(message.error.message || 'ACP error'));
        }
      }
      return;
    }

    // Handle notification from Qwen CLI
    if ('method' in message && !('id' in message)) {
      this.handleAcpNotification(message.method, message.params);
      return;
    }

    // Handle request from Qwen CLI (e.g., permission requests)
    if ('method' in message && 'id' in message) {
      this.handleAcpRequest(message.id, message.method, message.params);
      return;
    }
  }

  handleAcpNotification(method, params) {
    switch (method) {
      case 'session/update':
        // Forward session updates to the extension
        sendMessageToExtension({
          type: 'event',
          data: {
            type: 'session_update',
            sessionId: params.sessionId,
            update: params.update
          }
        });
        break;

      case 'authenticate/update':
        sendMessageToExtension({
          type: 'event',
          data: {
            type: 'auth_update',
            authUri: params._meta?.authUri
          }
        });
        break;

      default:
        log(`Unknown ACP notification: ${method}`);
    }
  }

  handleAcpRequest(id, method, params) {
    switch (method) {
      case 'session/request_permission':
        // Forward permission request to extension
        sendMessageToExtension({
          type: 'permission_request',
          requestId: id,
          sessionId: params.sessionId,
          toolCall: params.toolCall,
          options: params.options
        });
        break;

      case 'fs/read_text_file':
        // Handle file read request
        this.handleFileReadRequest(id, params);
        break;

      case 'fs/write_text_file':
        // Handle file write request
        this.handleFileWriteRequest(id, params);
        break;

      default:
        log(`Unknown ACP request: ${method}`);
        this.sendAcpResponse(id, { error: { code: -32601, message: 'Method not found' } });
    }
  }

  handleFileReadRequest(id, params) {
    try {
      const content = fs.readFileSync(params.path, 'utf-8');
      this.sendAcpResponse(id, { result: { content } });
    } catch (err) {
      this.sendAcpResponse(id, {
        error: { code: -32000, message: `Failed to read file: ${err.message}` }
      });
    }
  }

  handleFileWriteRequest(id, params) {
    try {
      fs.writeFileSync(params.path, params.content, 'utf-8');
      this.sendAcpResponse(id, { result: null });
    } catch (err) {
      this.sendAcpResponse(id, {
        error: { code: -32000, message: `Failed to write file: ${err.message}` }
      });
    }
  }

  sendAcpMessage(message) {
    if (!this.process || !this.process.stdin.writable) {
      throw new Error('Qwen CLI is not running');
    }

    const json = JSON.stringify(message) + '\n';
    logDebug(`ACP send: ${json.trim()}`);
    this.process.stdin.write(json);
  }

  sendAcpRequest(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextRequestId++;
      this.pendingRequests.set(id, { resolve, reject });

      try {
        this.sendAcpMessage({
          jsonrpc: '2.0',
          id,
          method,
          params
        });
      } catch (err) {
        this.pendingRequests.delete(id);
        reject(err);
      }

      // Timeout after 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${method} timed out`));
        }
      }, 30000);
    });
  }

  sendAcpResponse(id, response) {
    this.sendAcpMessage({
      jsonrpc: '2.0',
      id,
      ...response
    });
  }

  sendAcpNotification(method, params) {
    this.sendAcpMessage({
      jsonrpc: '2.0',
      method,
      params
    });
  }

  async initialize() {
    try {
      const result = await this.sendAcpRequest('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: {
            readTextFile: true,
            writeTextFile: true
          }
        }
      });

      log(`Qwen CLI initialized: ${JSON.stringify(result)}`);
      return { success: true, data: result };
    } catch (err) {
      logError(`Failed to initialize Qwen CLI: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  async createSession(cwd) {
    try {
      const result = await this.sendAcpRequest('session/new', {
        cwd,
        mcpServers: []
      });

      this.sessionId = result.sessionId;
      log(`Session created: ${this.sessionId}`);
      return { success: true, data: result };
    } catch (err) {
      logError(`Failed to create session: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  async prompt(text) {
    if (!this.sessionId) {
      return { success: false, error: 'No active session' };
    }

    try {
      const result = await this.sendAcpRequest('session/prompt', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text }]
      });

      return { success: true, data: result };
    } catch (err) {
      logError(`Prompt failed: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  async cancel() {
    if (!this.sessionId) {
      return { success: false, error: 'No active session' };
    }

    try {
      this.sendAcpNotification('session/cancel', {
        sessionId: this.sessionId
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  respondToPermission(requestId, optionId) {
    this.sendAcpResponse(requestId, {
      result: {
        outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' }
      }
    });
  }

  stop() {
    if (!this.process) {
      return { success: false, error: 'Qwen CLI is not running' };
    }

    try {
      this.process.kill('SIGTERM');
      this.process = null;
      this.status = 'stopped';
      this.sessionId = null;

      return { success: true, data: 'Qwen CLI stopped' };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  getStatus() {
    return {
      status: this.status,
      sessionId: this.sessionId,
      pid: this.process?.pid || null
    };
  }
}

// ============================================================================
// Global State
// ============================================================================

const acpConnection = new AcpConnection();

// Check if Qwen CLI is installed
async function checkQwenInstallation() {
  return new Promise((resolve) => {
    try {
      const checkProcess = spawn('qwen', ['--version'], {
        shell: true,
        windowsHide: true
      });

      let output = '';
      checkProcess.stdout.on('data', (data) => {
        output += data.toString();
      });

      checkProcess.on('error', () => {
        resolve({ installed: false });
      });

      checkProcess.on('close', (code) => {
        if (code === 0) {
          resolve({ installed: true, version: output.trim() });
        } else {
          resolve({ installed: false });
        }
      });

      setTimeout(() => {
        checkProcess.kill();
        resolve({ installed: false });
      }, 5000);
    } catch (error) {
      resolve({ installed: false });
    }
  });
}

// ============================================================================
// Message Handlers
// ============================================================================

async function handleExtensionMessage(message) {
  log(`Received from extension: ${JSON.stringify(message)}`);
  let response;

  switch (message.type) {
    case 'handshake':
      const installInfo = await checkQwenInstallation();
      response = {
        type: 'handshake_response',
        version: '1.0.0',
        qwenInstalled: installInfo.installed,
        qwenVersion: installInfo.version,
        qwenStatus: acpConnection.getStatus().status
      };
      break;

    case 'start_qwen':
      const cwd = message.cwd || process.cwd();
      const startResult = await acpConnection.start(cwd);
      response = {
        type: 'response',
        id: message.id,
        ...startResult
      };
      break;

    case 'stop_qwen':
      const stopResult = acpConnection.stop();
      response = {
        type: 'response',
        id: message.id,
        ...stopResult
      };
      break;

    case 'qwen_prompt':
      const promptResult = await acpConnection.prompt(message.text);
      response = {
        type: 'response',
        id: message.id,
        ...promptResult
      };
      break;

    case 'qwen_cancel':
      const cancelResult = await acpConnection.cancel();
      response = {
        type: 'response',
        id: message.id,
        ...cancelResult
      };
      break;

    case 'permission_response':
      acpConnection.respondToPermission(message.requestId, message.optionId);
      response = {
        type: 'response',
        id: message.id,
        success: true
      };
      break;

    case 'get_status':
      const status = acpConnection.getStatus();
      const installStatus = await checkQwenInstallation();
      response = {
        type: 'response',
        id: message.id,
        data: {
          ...status,
          qwenInstalled: installStatus.installed,
          qwenVersion: installStatus.version
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

  sendMessageToExtension(response);
}

// ============================================================================
// Cleanup
// ============================================================================

function cleanup() {
  log('Cleaning up...');
  acpConnection.stop();
}

process.on('SIGINT', () => {
  cleanup();
  process.exit();
});

process.on('SIGTERM', () => {
  cleanup();
  process.exit();
});

// ============================================================================
// Main
// ============================================================================

log('Native host started (ACP mode)');
readMessagesFromExtension();
