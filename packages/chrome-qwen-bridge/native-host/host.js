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
const http = require('http');

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
  log(`Sending to extension: ${JSON.stringify(message).slice(0, 100)}`);
  const buffer = Buffer.from(JSON.stringify(message));
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32LE(buffer.length, 0);

  process.stdout.write(length);
  process.stdout.write(buffer);
  log('Message sent successfully');
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
        const rawLengthBytes = buffer.slice(0, 4);
        messageLength = buffer.readUInt32LE(0);
        
        // Log raw bytes for debugging
        log(`Raw length bytes: ${rawLengthBytes.toString('hex')}`);
        log(`Parsed message length: ${messageLength}`);
        
        // Validate message length to prevent buffer overflow and handle corrupted data
        if (messageLength > 1024 * 1024) { // Max 1MB message
          logError(`Invalid message length: ${messageLength}. Resetting connection.`);
          messageLength = null;
          chunks = [];
          // Send error response to extension
          try {
            const errorMessage = {
              type: 'error',
              error: 'Invalid message format'
            };
            const errorBuffer = Buffer.from(JSON.stringify(errorMessage));
            const length = Buffer.allocUnsafe(4);
            length.writeUInt32LE(errorBuffer.length, 0);
            process.stdout.write(length);
            process.stdout.write(errorBuffer);
          } catch (writeErr) {
            logError(`Failed to send error response: ${writeErr.message}`);
          }
          break;
        }
        
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
      // Normalize CWD: use a dedicated clean directory for Chrome extension
      // to avoid slow QWEN.md scanning in directories with many files
      let normalizedCwd = cwd;
      try {
        const home = os.homedir();
        // Use a dedicated directory for Chrome bridge to minimize file scanning
        const chromeBridgeDir = path.join(home, '.qwen', 'chrome-bridge');

        // Ensure the directory exists
        if (!fs.existsSync(chromeBridgeDir)) {
          fs.mkdirSync(chromeBridgeDir, { recursive: true });
        }

        // Create an empty QWEN.md to immediately satisfy memory discovery
        // This prevents BfsFileSearch from scanning many directories
        const qwenMdPath = path.join(chromeBridgeDir, 'QWEN.md');
        if (!fs.existsSync(qwenMdPath)) {
          fs.writeFileSync(
            qwenMdPath,
            '# Chrome Browser Bridge\n\nThis is the Qwen CLI Chrome extension workspace.\n',
            'utf8',
          );
        }

        // Always use the dedicated chrome-bridge directory unless a specific CWD is requested
        if (
          !normalizedCwd ||
          normalizedCwd === '/' ||
          normalizedCwd === '\\' ||
          !fs.existsSync(normalizedCwd)
        ) {
          normalizedCwd = chromeBridgeDir;
        }
      } catch (_) {
        try {
          const fallback = path.join(os.homedir(), '.qwen', 'chrome-bridge');
          if (!fs.existsSync(fallback))
            fs.mkdirSync(fallback, { recursive: true });
          normalizedCwd = fallback;
        } catch (_) {
          normalizedCwd = os.homedir();
        }
      }

      log(`Starting Qwen CLI with ACP mode in ${normalizedCwd}`);

      // Chrome 环境没有用户 PATH，需要手动设置
      const env = {
        ...process.env,
        PATH:
          '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:' +
          (process.env.PATH || ''),
      };

      // Resolve qwen CLI path more robustly
      const qwenPath = (() => {
        try {
          // Prefer local monorepo build: packages/cli/dist/index.js
          const localCli = path.resolve(
            __dirname,
            '..',
            '..',
            'cli',
            'dist',
            'index.js',
          );
          if (fs.existsSync(localCli)) {
            return localCli;
          }
        } catch {}
        try {
          // Prefer explicit env override
          if (
            process.env.QWEN_CLI_PATH &&
            fs.existsSync(process.env.QWEN_CLI_PATH)
          ) {
            return process.env.QWEN_CLI_PATH;
          }
        } catch {}
        try {
          // Fallback to previously used absolute path if it exists
          if (fs.existsSync('/Users/yiliang/.npm-global/bin/qwen')) {
            return '/Users/yiliang/.npm-global/bin/qwen';
          }
        } catch {}
        // Last resort: rely on PATH
        return 'qwen';
      })();

      // Support both executable CLI (e.g., 'qwen') and Node script paths (e.g., '/.../dist/index.js')
      const isNodeScript = /\.(mjs|cjs|js)$/i.test(qwenPath);
      const spawnCommand = isNodeScript ? process.execPath || 'node' : qwenPath;
      const spawnArgs = [
        ...(isNodeScript ? [qwenPath] : []),
        '--experimental-acp',
        '--allowed-mcp-server-names',
        'chrome-browser,chrome-devtools',
        '--debug',
      ];

      this.process = spawn(spawnCommand, spawnArgs, {
        cwd: normalizedCwd,
        env,
        shell: true,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
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
          try {
            sendMessageToExtension({
              type: 'event',
              data: { type: 'cli_stderr', line: message },
            });
          } catch (_) {}
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
          data: { type: 'qwen_stopped', code },
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
      const sessionResult = await this.createSession(normalizedCwd);
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
          agentInfo: initResult.data.agentInfo,
        },
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
            update: params.update,
          },
        });
        break;

      case 'authenticate/update':
        sendMessageToExtension({
          type: 'event',
          data: {
            type: 'auth_update',
            authUri: params._meta?.authUri,
          },
        });
        break;

      case 'notifications/tools/list_changed':
        // Forward MCP tool list change notifications to the extension
        sendMessageToExtension({
          type: 'event',
          data: {
            type: 'tools_list_changed',
            tools: params?.tools || [],
          },
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
          options: params.options,
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

      // Browser MCP Tools
      case 'browser/read_page':
        // Get current page content from browser
        this.handleBrowserReadPage(id, params);
        break;

      case 'browser/capture_screenshot':
        // Capture screenshot of current tab
        this.handleBrowserCaptureScreenshot(id, params);
        break;

      case 'browser/get_network_logs':
        // Get network logs from browser
        this.handleBrowserGetNetworkLogs(id, params);
        break;

      case 'browser/get_console_logs':
        // Get console logs from browser
        this.handleBrowserGetConsoleLogs(id, params);
        break;

      default:
        log(`Unknown ACP request: ${method}`);
        this.sendAcpResponse(id, {
          error: { code: -32601, message: 'Method not found' },
        });
    }
  }

  handleFileReadRequest(id, params) {
    try {
      const content = fs.readFileSync(params.path, 'utf-8');
      this.sendAcpResponse(id, { result: { content } });
    } catch (err) {
      this.sendAcpResponse(id, {
        error: { code: -32000, message: `Failed to read file: ${err.message}` },
      });
    }
  }

  handleFileWriteRequest(id, params) {
    try {
      fs.writeFileSync(params.path, params.content, 'utf-8');
      this.sendAcpResponse(id, { result: null });
    } catch (err) {
      this.sendAcpResponse(id, {
        error: {
          code: -32000,
          message: `Failed to write file: ${err.message}`,
        },
      });
    }
  }

  // Browser request handlers
  async handleBrowserReadPage(id, params) {
    try {
      const data = await sendBrowserRequest('read_page', params);
      this.sendAcpResponse(id, {
        result: {
          url: data.url,
          title: data.title,
          content: data.content,
          links: data.links,
          images: data.images,
        },
      });
    } catch (err) {
      this.sendAcpResponse(id, {
        error: { code: -32000, message: `Failed to read page: ${err.message}` },
      });
    }
  }

  async handleBrowserCaptureScreenshot(id, params) {
    try {
      const data = await sendBrowserRequest('capture_screenshot', params);
      this.sendAcpResponse(id, {
        result: {
          dataUrl: data.dataUrl,
          format: 'png',
        },
      });
    } catch (err) {
      this.sendAcpResponse(id, {
        error: {
          code: -32000,
          message: `Failed to capture screenshot: ${err.message}`,
        },
      });
    }
  }

  async handleBrowserGetNetworkLogs(id, params) {
    try {
      const data = await sendBrowserRequest('get_network_logs', params);
      this.sendAcpResponse(id, {
        result: {
          logs: data.logs || [],
        },
      });
    } catch (err) {
      this.sendAcpResponse(id, {
        error: {
          code: -32000,
          message: `Failed to get network logs: ${err.message}`,
        },
      });
    }
  }

  async handleBrowserGetConsoleLogs(id, params) {
    try {
      const data = await sendBrowserRequest('get_console_logs', params);
      this.sendAcpResponse(id, {
        result: {
          logs: data.logs || [],
        },
      });
    } catch (err) {
      this.sendAcpResponse(id, {
        error: {
          code: -32000,
          message: `Failed to get console logs: ${err.message}`,
        },
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

  sendAcpRequest(method, params, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = this.nextRequestId++;
      this.pendingRequests.set(id, { resolve, reject });

      try {
        this.sendAcpMessage({
          jsonrpc: '2.0',
          id,
          method,
          params,
        });
      } catch (err) {
        this.pendingRequests.delete(id);
        reject(err);
      }

      // Timeout after specified duration
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Request ${method} timed out`));
        }
      }, timeoutMs);
    });
  }

  sendAcpResponse(id, response) {
    this.sendAcpMessage({
      jsonrpc: '2.0',
      id,
      ...response,
    });
  }

  sendAcpNotification(method, params) {
    this.sendAcpMessage({
      jsonrpc: '2.0',
      method,
      params,
    });
  }

  async initialize() {
    try {
      const result = await this.sendAcpRequest(
        'initialize',
        {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {
            fs: {
              // Only advertise filesystem capabilities; CLI schema accepts only 'fs' here.
              readTextFile: true,
              writeTextFile: true,
            },
          },
        },
        30000,
      );

      log(`Qwen CLI initialized: ${JSON.stringify(result)}`);
      return { success: true, data: result };
    } catch (err) {
      logError(`Failed to initialize Qwen CLI: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  async createSession(cwd) {
    try {
      // Helper to discover Chrome DevTools WS URL from env or default port
      const http = require('http');
      async function fetchJson(url) {
        return new Promise((resolve) => {
          try {
            const req = http.get(url, (res) => {
              let body = '';
              res.on('data', (c) => (body += c));
              res.on('end', () => {
                try {
                  resolve(JSON.parse(body));
                } catch (_) {
                  resolve(null);
                }
              });
            });
            req.on('error', () => resolve(null));
            req.end();
          } catch (_) {
            resolve(null);
          }
        });
      }
      async function discoverDevToolsWsUrl() {
        // 1) Explicit env
        if (process.env.DEVTOOLS_WS_URL) return process.env.DEVTOOLS_WS_URL;
        // 2) Provided port
        const port = process.env.CHROME_REMOTE_DEBUG_PORT || '9222';
        const json = await fetchJson(`http://127.0.0.1:${port}/json/version`);
        if (json && json.webSocketDebuggerUrl) return json.webSocketDebuggerUrl;
        return null;
      }

      // Get the path to browser-mcp-server.js
      const browserMcpServerPath = path.join(
        __dirname,
        'browser-mcp-server.js',
      );

      log(`Creating session with MCP server: ${browserMcpServerPath}`);

      // Use the same Node runtime that's running this host process to launch the MCP server.
      // This avoids hard-coded paths like /usr/local/bin/node which may not exist on all systems
      // (e.g., Homebrew on Apple Silicon uses /opt/homebrew/bin/node, or users may use nvm).
      const nodeCommand = process.execPath || 'node';

      const mcpServersConfig = [
        {
          name: 'chrome-browser',
          command: nodeCommand,
          args: [browserMcpServerPath],
          env: [],
          timeout: 180000, // 3 minutes timeout for MCP operations
          trust: true, // Auto-approve browser tools
        },
      ];

      // Optionally add open-source DevTools MCP if a WS URL is available
      try {
        const wsUrl = await discoverDevToolsWsUrl();
        if (wsUrl) {
          mcpServersConfig.push({
            name: 'chrome-devtools',
            command: 'chrome-devtools-mcp',
            args: ['--ws-url', wsUrl],
            env: [{ name: 'DEVTOOLS_WS_URL', value: wsUrl }],
            timeout: 180000,
            trust: true,
          });
          log(`Adding DevTools MCP with wsUrl: ${wsUrl}`);
        } else {
          log(
            'DevTools WS URL not found (is Chrome running with --remote-debugging-port=9222?). Skipping chrome-devtools MCP.',
          );
        }
      } catch (e) {
        log(`Failed to prepare DevTools MCP: ${e.message}`);
      }

      log(`MCP servers config: ${JSON.stringify(mcpServersConfig)}`);

      // Skip MCP server configuration to avoid slow tool discovery.
      // Browser tools are handled via fallback mechanism in service-worker.js.
      // To enable MCP (slower startup), set useMcp = true
      const useMcp = false;

      const result = await this.sendAcpRequest(
        'session/new',
        {
          cwd,
          mcpServers: useMcp ? mcpServersConfig : [],
        },
        useMcp ? 180000 : 30000, // Fast startup without MCP
      );

      this.sessionId = result.sessionId;
      log(`Session created: ${this.sessionId}`);
      try {
        log(`Session/new result: ${JSON.stringify(result)}`);
      } catch (_) {}
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
        prompt: [{ type: 'text', text }],
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
        sessionId: this.sessionId,
      });
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  respondToPermission(requestId, optionId) {
    this.sendAcpResponse(requestId, {
      result: {
        outcome: optionId
          ? { outcome: 'selected', optionId }
          : { outcome: 'cancelled' },
      },
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
      pid: this.process?.pid || null,
    };
  }
}

// ============================================================================
// Browser Request Bridge (Native Host <-> Chrome Extension)
// ============================================================================

// Pending browser requests from Qwen CLI that need Chrome Extension responses
const pendingBrowserRequests = new Map();
let browserRequestId = 0;

/**
 * Send a request to Chrome Extension and wait for response
 */
function sendBrowserRequest(requestType, params) {
  return new Promise((resolve, reject) => {
    const id = ++browserRequestId;
    pendingBrowserRequests.set(id, { resolve, reject });

    sendMessageToExtension({
      type: 'browser_request',
      browserRequestId: id,
      requestType,
      params,
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      if (pendingBrowserRequests.has(id)) {
        pendingBrowserRequests.delete(id);
        reject(new Error(`Browser request ${requestType} timed out`));
      }
    }, 30000);
  });
}

/**
 * Handle browser response from Chrome Extension
 */
function handleBrowserResponse(message) {
  const pending = pendingBrowserRequests.get(message.browserRequestId);
  if (pending) {
    pendingBrowserRequests.delete(message.browserRequestId);
    if (message.error) {
      pending.reject(new Error(message.error));
    } else {
      pending.resolve(message.data);
    }
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
      const qwenPath =
        process.env.QWEN_CLI_PATH ||
        '/Users/yiliang/.npm-global/bin/qwen' ||
        'qwen';
      const checkProcess = spawn(qwenPath, ['--version'], {
        shell: true,
        windowsHide: true,
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

/**
 * Build a prompt string from action, data, and optional user prompt
 */
function buildPromptFromAction(action, data, userPrompt) {
  // If user provided additional instructions, append them
  const userInstructions = userPrompt
    ? `\n\nUser's request: ${userPrompt}`
    : '';

  switch (action) {
    case 'analyze_page':
      return `Here is the webpage content:\n\nURL: ${data.url}\nTitle: ${data.title}\n\nContent:\n${data.content?.text || data.content?.markdown || 'No content available'}${userInstructions || '\n\nPlease provide a summary and any notable observations.'}`;

    case 'analyze_screenshot':
      return `Here is a screenshot from URL: ${data.url}\n\n[Screenshot data provided as base64 image]${userInstructions || '\n\nPlease analyze this screenshot.'}`;

    case 'ai_analyze':
      return (
        data.prompt ||
        `Here is the webpage:\n\nURL: ${data.pageData?.url}\nTitle: ${data.pageData?.title}\n\nContent:\n${data.pageData?.content?.text || 'No content available'}${userInstructions}`
      );

    case 'process_text':
      return `Here is the ${data.context || 'text'}:\n\n${data.text}${userInstructions || '\n\nPlease process this information.'}`;

    default:
      // For unknown actions, just stringify the data
      return `Action: ${action}\nData: ${JSON.stringify(data, null, 2)}${userInstructions}`;
  }
}

async function handleExtensionMessage(message) {
  log(`Received from extension: ${JSON.stringify(message)}`);

  // Handle browser response (async response from extension for browser requests)
  if (message.type === 'browser_response') {
    handleBrowserResponse(message);
    return;
  }

  let response;

  switch (message.type) {
    case 'handshake':
      // 立即响应，不等待 qwen 版本检查
      response = {
        type: 'handshake_response',
        version: '1.0.0',
        qwenInstalled: true, // 假设已安装，后续会验证
        qwenVersion: 'checking...',
        qwenStatus: acpConnection.getStatus().status,
      };
      // Send host info event (log path, runtime) to help debugging
      try {
        sendMessageToExtension({
          type: 'event',
          data: {
            type: 'host_info',
            logFile: LOG_FILE,
            node: process.execPath,
            pid: process.pid,
          },
        });
      } catch (e) {
        logError(`Failed to send host_info: ${e.message}`);
      }
      break;

    case 'start_qwen':
      const cwd = message.cwd || process.cwd();
      const startResult = await acpConnection.start(cwd);
      response = {
        type: 'response',
        id: message.id,
        ...startResult,
      };
      break;

    case 'stop_qwen':
      const stopResult = acpConnection.stop();
      response = {
        type: 'response',
        id: message.id,
        ...stopResult,
      };
      break;

    case 'qwen_prompt':
      const promptResult = await acpConnection.prompt(message.text);
      response = {
        type: 'response',
        id: message.id,
        ...promptResult,
      };
      break;

    case 'qwen_cancel':
      const cancelResult = await acpConnection.cancel();
      response = {
        type: 'response',
        id: message.id,
        ...cancelResult,
      };
      break;

    case 'permission_response':
      acpConnection.respondToPermission(message.requestId, message.optionId);
      response = {
        type: 'response',
        id: message.id,
        success: true,
      };
      break;

    case 'qwen_request':
      // Handle generic requests from extension (analyze_page, analyze_screenshot, etc.)
      // Convert action + data to a prompt for Qwen CLI, including user's original request
      const promptText = buildPromptFromAction(
        message.action,
        message.data,
        message.userPrompt,
      );
      if (acpConnection.status !== 'running') {
        response = {
          type: 'response',
          id: message.id,
          success: false,
          error: 'Qwen CLI is not running. Please start it first.',
        };
      } else {
        const actionResult = await acpConnection.prompt(promptText);
        response = {
          type: 'response',
          id: message.id,
          ...actionResult,
        };
      }
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
          qwenVersion: installStatus.version,
        },
      };
      break;

    default:
      response = {
        type: 'response',
        id: message.id,
        error: `Unknown message type: ${message.type}`,
      };
  }

  sendMessageToExtension(response);
}

// ============================================================================
// HTTP Bridge Server (for browser-mcp-server.js to call)
// ============================================================================

const HTTP_PORT = 18765;
let httpServer = null;

function startHttpBridgeServer() {
  if (httpServer) return;

  httpServer = http.createServer(async (req, res) => {
    // Set CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      try {
        const request = JSON.parse(body);
        log(`HTTP Bridge request: ${request.method}`);

        let result;
        switch (request.method) {
          case 'read_page':
            result = await sendBrowserRequest(
              'read_page',
              request.params || {},
            );
            break;
          case 'capture_screenshot':
            result = await sendBrowserRequest(
              'capture_screenshot',
              request.params || {},
            );
            break;
          case 'get_network_logs':
            result = await sendBrowserRequest(
              'get_network_logs',
              request.params || {},
            );
            break;
          case 'get_console_logs':
            result = await sendBrowserRequest(
              'get_console_logs',
              request.params || {},
            );
            break;
          default:
            throw new Error(`Unknown method: ${request.method}`);
        }

        res.writeHead(200);
        res.end(JSON.stringify({ success: true, data: result }));
      } catch (err) {
        log(`HTTP Bridge error: ${err.message}`);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
  });

  httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
    log(`HTTP Bridge server started on port ${HTTP_PORT}`);
  });

  httpServer.on('error', (err) => {
    logError(`HTTP Bridge server error: ${err.message}`);
  });
}

// ============================================================================
// Cleanup
// ============================================================================

function cleanup() {
  log('Cleaning up...');
  acpConnection.stop();
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
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

log('Native host started (ACP mode) - Debug version');
log(`Current working directory: ${process.cwd()}`);
log(`Node.js version: ${process.version}`);
log(`Platform: ${process.platform}`);
startHttpBridgeServer();
readMessagesFromExtension();
