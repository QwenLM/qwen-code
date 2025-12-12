/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SDK E2E Test Helper
 * Provides utilities for SDK e2e tests including test isolation,
 * file management, MCP server setup, and common test utilities.
 */

import { mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKSystemMessage,
  SDKUserMessage,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
} from '@qwen-code/sdk';
import {
  isSDKAssistantMessage,
  isSDKSystemMessage,
  isSDKResultMessage,
} from '@qwen-code/sdk';

// ============================================================================
// Core Test Helper Class
// ============================================================================

export interface SDKTestHelperOptions {
  /**
   * Optional settings for .qwen/settings.json
   */
  settings?: Record<string, unknown>;
  /**
   * Whether to create .qwen/settings.json
   */
  createQwenConfig?: boolean;
}

/**
 * Helper class for SDK E2E tests
 * Provides isolated test environments for each test case
 */
export class SDKTestHelper {
  testDir: string | null = null;
  testName?: string;
  private baseDir: string;

  constructor() {
    this.baseDir = process.env['E2E_TEST_FILE_DIR']!;
    if (!this.baseDir) {
      throw new Error('E2E_TEST_FILE_DIR environment variable not set');
    }
  }

  /**
   * Setup an isolated test directory for a specific test
   */
  async setup(
    testName: string,
    options: SDKTestHelperOptions = {},
  ): Promise<string> {
    this.testName = testName;
    const sanitizedName = this.sanitizeTestName(testName);
    this.testDir = join(this.baseDir, sanitizedName);

    await mkdir(this.testDir, { recursive: true });

    // Optionally create .qwen/settings.json for CLI configuration
    if (options.createQwenConfig) {
      const qwenDir = join(this.testDir, '.qwen');
      await mkdir(qwenDir, { recursive: true });

      const settings = {
        telemetry: {
          enabled: false, // SDK tests don't need telemetry
        },
        ...options.settings,
      };

      await writeFile(
        join(qwenDir, 'settings.json'),
        JSON.stringify(settings, null, 2),
        'utf-8',
      );
    }

    return this.testDir;
  }

  /**
   * Create a file in the test directory
   */
  async createFile(fileName: string, content: string): Promise<string> {
    if (!this.testDir) {
      throw new Error('Test directory not initialized. Call setup() first.');
    }
    const filePath = join(this.testDir, fileName);
    await writeFile(filePath, content, 'utf-8');
    return filePath;
  }

  /**
   * Read a file from the test directory
   */
  async readFile(fileName: string): Promise<string> {
    if (!this.testDir) {
      throw new Error('Test directory not initialized. Call setup() first.');
    }
    const filePath = join(this.testDir, fileName);
    return await readFile(filePath, 'utf-8');
  }

  /**
   * Create a subdirectory in the test directory
   */
  async mkdir(dirName: string): Promise<string> {
    if (!this.testDir) {
      throw new Error('Test directory not initialized. Call setup() first.');
    }
    const dirPath = join(this.testDir, dirName);
    await mkdir(dirPath, { recursive: true });
    return dirPath;
  }

  /**
   * Check if a file exists in the test directory
   */
  fileExists(fileName: string): boolean {
    if (!this.testDir) {
      throw new Error('Test directory not initialized. Call setup() first.');
    }
    const filePath = join(this.testDir, fileName);
    return existsSync(filePath);
  }

  /**
   * Get the full path to a file in the test directory
   */
  getPath(fileName: string): string {
    if (!this.testDir) {
      throw new Error('Test directory not initialized. Call setup() first.');
    }
    return join(this.testDir, fileName);
  }

  /**
   * Cleanup test directory
   */
  async cleanup(): Promise<void> {
    if (this.testDir && process.env['KEEP_OUTPUT'] !== 'true') {
      try {
        await rm(this.testDir, { recursive: true, force: true });
      } catch (error) {
        if (process.env['VERBOSE'] === 'true') {
          console.warn('Cleanup warning:', (error as Error).message);
        }
      }
    }
  }

  /**
   * Sanitize test name to create valid directory name
   */
  private sanitizeTestName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .substring(0, 100); // Limit length
  }
}

// ============================================================================
// MCP Server Utilities
// ============================================================================

export interface MCPServerConfig {
  command: string;
  args: string[];
}

export interface MCPServerResult {
  scriptPath: string;
  config: MCPServerConfig;
}

/**
 * Built-in MCP server template: Math server with add and multiply tools
 */
const MCP_MATH_SERVER_SCRIPT = `#!/usr/bin/env node
/**
 * @license
 * Copyright 2025 Qwen Team
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
      name: 'test-math-server',
      version: '1.0.0'
    }
  };
});

// Handle tools/list
rpc.on('tools/list', async () => {
  debug('Handling tools/list request');
  return {
    tools: [
      {
        name: 'add',
        description: 'Add two numbers together',
        inputSchema: {
          type: 'object',
          properties: {
            a: { type: 'number', description: 'First number' },
            b: { type: 'number', description: 'Second number' }
          },
          required: ['a', 'b']
        }
      },
      {
        name: 'multiply',
        description: 'Multiply two numbers together',
        inputSchema: {
          type: 'object',
          properties: {
            a: { type: 'number', description: 'First number' },
            b: { type: 'number', description: 'Second number' }
          },
          required: ['a', 'b']
        }
      }
    ]
  };
});

// Handle tools/call
rpc.on('tools/call', async (params) => {
  debug(\`Handling tools/call request for tool: \${params.name}\`);
  
  if (params.name === 'add') {
    const { a, b } = params.arguments;
    return {
      content: [{
        type: 'text',
        text: String(a + b)
      }]
    };
  }
  
  if (params.name === 'multiply') {
    const { a, b } = params.arguments;
    return {
      content: [{
        type: 'text',
        text: String(a * b)
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

/**
 * Create an MCP server script in the test directory
 * @param helper - SDKTestHelper instance
 * @param type - Type of MCP server ('math' or provide custom script)
 * @param serverName - Name of the MCP server (default: 'test-math-server')
 * @param customScript - Custom MCP server script (if type is not 'math')
 * @returns Object with scriptPath and config
 */
export async function createMCPServer(
  helper: SDKTestHelper,
  type: 'math' | 'custom' = 'math',
  serverName: string = 'test-math-server',
  customScript?: string,
): Promise<MCPServerResult> {
  if (!helper.testDir) {
    throw new Error('Test directory not initialized. Call setup() first.');
  }

  const script = type === 'math' ? MCP_MATH_SERVER_SCRIPT : customScript;
  if (!script) {
    throw new Error('Custom script required when type is "custom"');
  }

  const scriptPath = join(helper.testDir, `${serverName}.cjs`);
  await writeFile(scriptPath, script, 'utf-8');

  // Make script executable on Unix-like systems
  if (process.platform !== 'win32') {
    await chmod(scriptPath, 0o755);
  }

  return {
    scriptPath,
    config: {
      command: 'node',
      args: [scriptPath],
    },
  };
}

// ============================================================================
// Message & Content Utilities
// ============================================================================

/**
 * Extract text from ContentBlock array
 */
export function extractText(content: ContentBlock[]): string {
  return content
    .filter((block): block is TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}

/**
 * Collect messages by type
 */
export function collectMessagesByType<T extends SDKMessage>(
  messages: SDKMessage[],
  predicate: (msg: SDKMessage) => msg is T,
): T[] {
  return messages.filter(predicate);
}

/**
 * Find tool use blocks in a message
 */
export function findToolUseBlocks(
  message: SDKAssistantMessage,
  toolName?: string,
): ToolUseBlock[] {
  const toolUseBlocks = message.message.content.filter(
    (block): block is ToolUseBlock => block.type === 'tool_use',
  );

  if (toolName) {
    return toolUseBlocks.filter((block) => block.name === toolName);
  }

  return toolUseBlocks;
}

/**
 * Extract all assistant text from messages
 */
export function getAssistantText(messages: SDKMessage[]): string {
  return messages
    .filter(isSDKAssistantMessage)
    .map((msg) => extractText(msg.message.content))
    .join('');
}

/**
 * Find system message with optional subtype filter
 */
export function findSystemMessage(
  messages: SDKMessage[],
  subtype?: string,
): SDKSystemMessage | null {
  const systemMessages = messages.filter(isSDKSystemMessage);

  if (subtype) {
    return systemMessages.find((msg) => msg.subtype === subtype) || null;
  }

  return systemMessages[0] || null;
}

/**
 * Find all tool calls in messages
 */
export function findToolCalls(
  messages: SDKMessage[],
  toolName?: string,
): Array<{ message: SDKAssistantMessage; toolUse: ToolUseBlock }> {
  const results: Array<{
    message: SDKAssistantMessage;
    toolUse: ToolUseBlock;
  }> = [];

  for (const message of messages) {
    if (isSDKAssistantMessage(message)) {
      const toolUseBlocks = findToolUseBlocks(message, toolName);
      for (const toolUse of toolUseBlocks) {
        results.push({ message, toolUse });
      }
    }
  }

  return results;
}

/**
 * Find tool result for a specific tool use ID
 */
export function findToolResult(
  messages: SDKMessage[],
  toolUseId: string,
): { content: string; isError: boolean } | null {
  for (const message of messages) {
    if (message.type === 'user' && 'message' in message) {
      const userMsg = message as SDKUserMessage;
      const content = userMsg.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (
            block.type === 'tool_result' &&
            (block as { tool_use_id?: string }).tool_use_id === toolUseId
          ) {
            const resultBlock = block as {
              content?: string | ContentBlock[];
              is_error?: boolean;
            };
            let resultContent = '';
            if (typeof resultBlock.content === 'string') {
              resultContent = resultBlock.content;
            } else if (Array.isArray(resultBlock.content)) {
              resultContent = resultBlock.content
                .filter((b): b is TextBlock => b.type === 'text')
                .map((b) => b.text)
                .join('');
            }
            return {
              content: resultContent,
              isError: resultBlock.is_error ?? false,
            };
          }
        }
      }
    }
  }
  return null;
}

/**
 * Find all tool results for a specific tool name
 */
export function findToolResults(
  messages: SDKMessage[],
  toolName: string,
): Array<{ toolUseId: string; content: string; isError: boolean }> {
  const results: Array<{
    toolUseId: string;
    content: string;
    isError: boolean;
  }> = [];

  // First find all tool calls for this tool
  const toolCalls = findToolCalls(messages, toolName);

  // Then find the result for each tool call
  for (const { toolUse } of toolCalls) {
    const result = findToolResult(messages, toolUse.id);
    if (result) {
      results.push({
        toolUseId: toolUse.id,
        content: result.content,
        isError: result.isError,
      });
    }
  }

  return results;
}

/**
 * Find all tool result blocks from messages (without requiring tool name)
 */
export function findAllToolResultBlocks(
  messages: SDKMessage[],
): Array<{ toolUseId: string; content: string; isError: boolean }> {
  const results: Array<{
    toolUseId: string;
    content: string;
    isError: boolean;
  }> = [];

  for (const message of messages) {
    if (message.type === 'user' && 'message' in message) {
      const userMsg = message as SDKUserMessage;
      const content = userMsg.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result' && 'tool_use_id' in block) {
            const resultBlock = block as {
              tool_use_id: string;
              content?: string | ContentBlock[];
              is_error?: boolean;
            };
            let resultContent = '';
            if (typeof resultBlock.content === 'string') {
              resultContent = resultBlock.content;
            } else if (Array.isArray(resultBlock.content)) {
              resultContent = (resultBlock.content as ContentBlock[])
                .filter((b): b is TextBlock => b.type === 'text')
                .map((b) => b.text)
                .join('');
            }
            results.push({
              toolUseId: resultBlock.tool_use_id,
              content: resultContent,
              isError: resultBlock.is_error ?? false,
            });
          }
        }
      }
    }
  }

  return results;
}

/**
 * Check if any tool results exist in messages
 */
export function hasAnyToolResults(messages: SDKMessage[]): boolean {
  return findAllToolResultBlocks(messages).length > 0;
}

/**
 * Check if any successful (non-error) tool results exist
 */
export function hasSuccessfulToolResults(messages: SDKMessage[]): boolean {
  return findAllToolResultBlocks(messages).some((r) => !r.isError);
}

/**
 * Check if any error tool results exist
 */
export function hasErrorToolResults(messages: SDKMessage[]): boolean {
  return findAllToolResultBlocks(messages).some((r) => r.isError);
}

// ============================================================================
// Streaming Input Utilities
// ============================================================================

/**
 * Create a simple streaming input from an array of message contents
 */
export async function* createStreamingInput(
  messageContents: string[],
  sessionId?: string,
): AsyncIterable<SDKUserMessage> {
  const sid = sessionId || crypto.randomUUID();

  for (const content of messageContents) {
    yield {
      type: 'user',
      session_id: sid,
      message: {
        role: 'user',
        content: content,
      },
      parent_tool_use_id: null,
    } as SDKUserMessage;

    // Small delay between messages
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Create a controlled streaming input with pause/resume capability
 */
export function createControlledStreamingInput(
  messageContents: string[],
  sessionId?: string,
): {
  generator: AsyncIterable<SDKUserMessage>;
  resume: () => void;
  resumeAll: () => void;
} {
  const sid = sessionId || crypto.randomUUID();
  const resumeResolvers: Array<() => void> = [];
  const resumePromises: Array<Promise<void>> = [];

  // Create a resume promise for each message after the first
  for (let i = 1; i < messageContents.length; i++) {
    const promise = new Promise<void>((resolve) => {
      resumeResolvers.push(resolve);
    });
    resumePromises.push(promise);
  }

  const generator = (async function* () {
    // Yield first message immediately
    yield {
      type: 'user',
      session_id: sid,
      message: {
        role: 'user',
        content: messageContents[0],
      },
      parent_tool_use_id: null,
    } as SDKUserMessage;

    // For subsequent messages, wait for resume
    for (let i = 1; i < messageContents.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await resumePromises[i - 1];
      await new Promise((resolve) => setTimeout(resolve, 200));

      yield {
        type: 'user',
        session_id: sid,
        message: {
          role: 'user',
          content: messageContents[i],
        },
        parent_tool_use_id: null,
      } as SDKUserMessage;
    }
  })();

  let currentResumeIndex = 0;

  return {
    generator,
    resume: () => {
      if (currentResumeIndex < resumeResolvers.length) {
        resumeResolvers[currentResumeIndex]();
        currentResumeIndex++;
      }
    },
    resumeAll: () => {
      resumeResolvers.forEach((resolve) => resolve());
      currentResumeIndex = resumeResolvers.length;
    },
  };
}

// ============================================================================
// Assertion Utilities
// ============================================================================

/**
 * Assert that messages follow expected type sequence
 */
export function assertMessageSequence(
  messages: SDKMessage[],
  expectedTypes: string[],
): void {
  const actualTypes = messages.map((msg) => msg.type);

  if (actualTypes.length < expectedTypes.length) {
    throw new Error(
      `Expected at least ${expectedTypes.length} messages, got ${actualTypes.length}`,
    );
  }

  for (let i = 0; i < expectedTypes.length; i++) {
    if (actualTypes[i] !== expectedTypes[i]) {
      throw new Error(
        `Expected message ${i} to be type '${expectedTypes[i]}', got '${actualTypes[i]}'`,
      );
    }
  }
}

/**
 * Assert that a specific tool was called
 */
export function assertToolCalled(
  messages: SDKMessage[],
  toolName: string,
): void {
  const toolCalls = findToolCalls(messages, toolName);

  if (toolCalls.length === 0) {
    const allToolCalls = findToolCalls(messages);
    const allToolNames = allToolCalls.map((tc) => tc.toolUse.name);
    throw new Error(
      `Expected tool '${toolName}' to be called. Found tools: ${allToolNames.length > 0 ? allToolNames.join(', ') : 'none'}`,
    );
  }
}

/**
 * Assert that the conversation completed successfully
 */
export function assertSuccessfulCompletion(messages: SDKMessage[]): void {
  const lastMessage = messages[messages.length - 1];

  if (!isSDKResultMessage(lastMessage)) {
    throw new Error(
      `Expected last message to be a result message, got '${lastMessage.type}'`,
    );
  }

  if (lastMessage.subtype !== 'success') {
    throw new Error(
      `Expected successful completion, got result subtype '${lastMessage.subtype}'`,
    );
  }
}

/**
 * Wait for a condition to be true with timeout
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: {
    timeout?: number;
    interval?: number;
    errorMessage?: string;
  } = {},
): Promise<void> {
  const {
    timeout = 5000,
    interval = 100,
    errorMessage = 'Condition not met within timeout',
  } = options;

  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const result = await predicate();
    if (result) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }

  throw new Error(errorMessage);
}

// ============================================================================
// Debug and Validation Utilities
// ============================================================================

/**
 * Validate model output and warn about unexpected content
 * Inspired by integration-tests test-helper
 */
export function validateModelOutput(
  result: string,
  expectedContent: string | (string | RegExp)[] | null = null,
  testName = '',
): boolean {
  // First, check if there's any output at all
  if (!result || result.trim().length === 0) {
    throw new Error('Expected model to return some output');
  }

  // If expectedContent is provided, check for it and warn if missing
  if (expectedContent) {
    const contents = Array.isArray(expectedContent)
      ? expectedContent
      : [expectedContent];
    const missingContent = contents.filter((content) => {
      if (typeof content === 'string') {
        return !result.toLowerCase().includes(content.toLowerCase());
      } else if (content instanceof RegExp) {
        return !content.test(result);
      }
      return false;
    });

    if (missingContent.length > 0) {
      console.warn(
        `Warning: Model did not include expected content in response: ${missingContent.join(', ')}.`,
        'This is not ideal but not a test failure.',
      );
      console.warn(
        'The tool was called successfully, which is the main requirement.',
      );
      return false;
    } else if (process.env['VERBOSE'] === 'true') {
      console.log(`${testName}: Model output validated successfully.`);
    }
    return true;
  }

  return true;
}

/**
 * Print debug information when tests fail
 */
export function printDebugInfo(
  messages: SDKMessage[],
  context: Record<string, unknown> = {},
): void {
  console.error('Test failed - Debug info:');
  console.error('Message count:', messages.length);

  // Print message types
  const messageTypes = messages.map((m) => m.type);
  console.error('Message types:', messageTypes.join(', '));

  // Print assistant text
  const assistantText = getAssistantText(messages);
  console.error(
    'Assistant text (first 500 chars):',
    assistantText.substring(0, 500),
  );
  if (assistantText.length > 500) {
    console.error(
      'Assistant text (last 500 chars):',
      assistantText.substring(assistantText.length - 500),
    );
  }

  // Print tool calls
  const toolCalls = findToolCalls(messages);
  console.error(
    'Tool calls found:',
    toolCalls.map((tc) => tc.toolUse.name),
  );

  // Print any additional context provided
  Object.entries(context).forEach(([key, value]) => {
    console.error(`${key}:`, value);
  });
}

/**
 * Create detailed error message for tool call expectations
 */
export function createToolCallErrorMessage(
  expectedTools: string | string[],
  foundTools: string[],
  messages: SDKMessage[],
): string {
  const expectedStr = Array.isArray(expectedTools)
    ? expectedTools.join(' or ')
    : expectedTools;

  const assistantText = getAssistantText(messages);
  const preview = assistantText
    ? assistantText.substring(0, 200) + '...'
    : 'no output';

  return (
    `Expected to find ${expectedStr} tool call(s). ` +
    `Found: ${foundTools.length > 0 ? foundTools.join(', ') : 'none'}. ` +
    `Output preview: ${preview}`
  );
}

// ============================================================================
// Shared Test Options Helper
// ============================================================================

/**
 * Create shared test options with CLI path
 */
export function createSharedTestOptions(
  overrides: Record<string, unknown> = {},
) {
  const TEST_CLI_PATH = process.env['TEST_CLI_PATH'];
  if (!TEST_CLI_PATH) {
    throw new Error('TEST_CLI_PATH environment variable not set');
  }

  return {
    pathToQwenExecutable: TEST_CLI_PATH,
    ...overrides,
  };
}
