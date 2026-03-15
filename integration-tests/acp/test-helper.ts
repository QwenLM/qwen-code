/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, ChildProcess } from 'node:child_process';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from 'node:process';
import { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { EventEmitter } from 'node:events';

// ACP SDK imports
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';
import type {
  Client,
  InitializeRequest,
  InitializeResponse,
  NewSessionResponse,
  LoadSessionResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  AuthenticateResponse,
  PromptRequest,
  PromptResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  CancelNotification,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  SessionModeId,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';

// ============================================================================
// Type Guards
// ============================================================================

function hasSessionUpdate(
  update: unknown,
  type: string,
): update is { sessionUpdate: string } {
  return (
    typeof update === 'object' &&
    update !== null &&
    'sessionUpdate' in update &&
    (update as { sessionUpdate: string }).sessionUpdate === type
  );
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '../..');

// ============================================================================
// Type Definitions
// ============================================================================

export interface ToolCallRecord {
  toolCallId: string;
  toolName: string;
  status: 'pending' | 'running' | 'success' | 'error';
  input?: unknown;
  output?: unknown;
  error?: string | undefined;
  timestamp: number;
}

export interface PermissionRecord {
  id: number;
  sessionId?: string;
  toolCallId?: string;
  toolKind?: string;
  title?: string;
  approved: boolean;
  optionId?: string;
  timestamp: number;
}

export type PermissionDecision =
  | { optionId: string }
  | { outcome: 'cancelled' };

export type PermissionHandler = (
  request: RequestPermissionRequest,
) => PermissionDecision;

export interface TestClientOptions {
  /** Filesystem root directory (for test isolation) */
  rootDir: string;
  /** Auto-approve all permission requests */
  autoApprove?: boolean;
  /** Custom permission handler */
  permissionHandler?: PermissionHandler;
  /** Record permission requests for later verification */
  recordPermissions?: boolean;
}

export interface AcpTestRigOptions {
  /** Test name (used to create isolated directory) */
  testName: string;
  /** Extra CLI arguments for qwen */
  extraArgs?: string[];
  /** Timeout in milliseconds */
  timeout?: number;
}

// ============================================================================
// SessionTracker - Tracks session lifecycle and state changes
// ============================================================================

export class SessionTracker extends EventEmitter {
  private sessions: Map<
    string,
    {
      sessionId: string;
      cwd?: string;
      currentMode?: SessionModeId;
      currentModel?: string;
      createdAt: number;
    }
  > = new Map();

  private currentSessionId: string | null = null;

  onSessionCreated(sessionId: string, cwd?: string): void {
    this.sessions.set(sessionId, {
      sessionId,
      cwd,
      createdAt: Date.now(),
    });
    this.currentSessionId = sessionId;
    this.emit('sessionCreated', { sessionId, cwd });
  }

  onSessionLoaded(sessionId: string): void {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        sessionId,
        createdAt: Date.now(),
      });
    }
    this.currentSessionId = sessionId;
    this.emit('sessionLoaded', { sessionId });
  }

  onSessionUpdate(notification: SessionNotification): void {
    const { sessionId, update } = notification;
    if (!sessionId || !update) return;

    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Handle mode update
    if ('currentModeId' in update && update.currentModeId) {
      session.currentMode = update.currentModeId as SessionModeId;
      this.emit('modeChanged', { sessionId, mode: session.currentMode });
    }

    // Handle model update
    if ('currentModelId' in update && update.currentModelId) {
      session.currentModel = String(update.currentModelId);
      this.emit('modelChanged', { sessionId, model: session.currentModel });
    }

    this.emit('sessionUpdate', notification);
  }

  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  getSession(sessionId: string) {
    return this.sessions.get(sessionId);
  }

  getCurrentMode(): SessionModeId | undefined {
    const session = this.currentSessionId
      ? this.sessions.get(this.currentSessionId)
      : undefined;
    return session?.currentMode;
  }

  getCurrentModel(): string | undefined {
    const session = this.currentSessionId
      ? this.sessions.get(this.currentSessionId)
      : undefined;
    return session?.currentModel;
  }

  getAllSessions() {
    return Array.from(this.sessions.values());
  }

  clear(): void {
    this.sessions.clear();
    this.currentSessionId = null;
  }
}

// ============================================================================
// ToolCallCollector - Collects and queries tool call records
// ============================================================================

export class ToolCallCollector extends EventEmitter {
  private toolCalls: ToolCallRecord[] = [];

  add(record: ToolCallRecord): void {
    this.toolCalls.push(record);
    this.emit('toolCall', record);
  }

  findById(toolCallId: string): ToolCallRecord | undefined {
    return this.toolCalls.find((t) => t.toolCallId === toolCallId);
  }

  findByName(toolName: string): ToolCallRecord[] {
    return this.toolCalls.filter((t) => t.toolName === toolName);
  }

  getCompleted(): ToolCallRecord[] {
    return this.toolCalls.filter((t) => t.status === 'success');
  }

  getFailed(): ToolCallRecord[] {
    return this.toolCalls.filter((t) => t.status === 'error');
  }

  getPending(): ToolCallRecord[] {
    return this.toolCalls.filter(
      (t) => t.status === 'pending' || t.status === 'running',
    );
  }

  getAll(): ToolCallRecord[] {
    return [...this.toolCalls];
  }

  clear(): void {
    this.toolCalls = [];
  }
}

// ============================================================================
// TestClient - Implements SDK Client interface
// ============================================================================

export class TestClient implements Client {
  readonly rootDir: string;
  private autoApprove: boolean;
  private permissionHandler?: PermissionHandler;
  private recordPermissions: boolean;
  private permissionHistory: PermissionRecord[] = [];
  private sessionTracker: SessionTracker;
  private toolCallCollector: ToolCallCollector;

  constructor(
    options: TestClientOptions,
    sessionTracker: SessionTracker,
    toolCallCollector: ToolCallCollector,
  ) {
    this.rootDir = options.rootDir;
    this.autoApprove = options.autoApprove ?? true;
    this.permissionHandler = options.permissionHandler;
    this.recordPermissions = options.recordPermissions ?? true;
    this.sessionTracker = sessionTracker;
    this.toolCallCollector = toolCallCollector;
  }

  // --------------------------------------------------------------------------
  // Client Interface Methods
  // --------------------------------------------------------------------------

  async readTextFile(
    params: ReadTextFileRequest,
  ): Promise<ReadTextFileResponse> {
    const fullPath = this.resolvePath(params.path);
    const content = readFileSync(fullPath, 'utf-8');
    return { content };
  }

  async writeTextFile(
    params: WriteTextFileRequest,
  ): Promise<WriteTextFileResponse> {
    const fullPath = this.resolvePath(params.path);
    writeFileSync(fullPath, params.content, 'utf-8');
    return {};
  }

  async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const record: PermissionRecord = {
      id: Date.now(), // Using timestamp as unique ID
      sessionId: params.sessionId,
      toolCallId: params.toolCall?.toolCallId,
      toolKind: params.toolCall?.kind ?? undefined,
      title: params.toolCall?.title ?? undefined,
      approved: false,
      timestamp: Date.now(),
    };

    let decision: PermissionDecision;

    if (this.permissionHandler) {
      decision = this.permissionHandler(params);
    } else if (this.autoApprove) {
      // Find the first "allow" option
      const allowOption = params.options?.find(
        (o) => o.kind === 'allow_once' || o.kind === 'allow_always',
      );
      decision = allowOption
        ? { optionId: allowOption.optionId }
        : { outcome: 'cancelled' };
    } else {
      decision = { outcome: 'cancelled' };
    }

    if ('optionId' in decision) {
      record.approved = true;
      record.optionId = decision.optionId;
    }

    if (this.recordPermissions) {
      this.permissionHistory.push(record);
    }

    if ('outcome' in decision) {
      return { outcome: decision };
    } else {
      return {
        outcome: {
          outcome: 'selected',
          optionId: decision.optionId,
        },
      };
    }
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    // Track session updates
    this.sessionTracker.onSessionUpdate(params);

    // Track tool calls from session updates
    const update = params.update;
    if (!update) return;

    // Check if this is a tool call update
    const toolUpdate = update as ToolCallUpdate;
    if (toolUpdate.toolCallId) {
      this.toolCallCollector.add({
        toolCallId: toolUpdate.toolCallId,
        toolName: toolUpdate.title ?? 'unknown',
        status: this.mapToolStatus(toolUpdate.status),
        input: toolUpdate.rawInput,
        output: toolUpdate.rawOutput,
        error: undefined,
        timestamp: Date.now(),
      });
    }
  }

  // --------------------------------------------------------------------------
  // Test Helper Methods
  // --------------------------------------------------------------------------

  getPermissionHistory(): PermissionRecord[] {
    return [...this.permissionHistory];
  }

  clearPermissionHistory(): void {
    this.permissionHistory = [];
  }

  setAutoApprove(value: boolean): void {
    this.autoApprove = value;
  }

  setPermissionHandler(handler?: PermissionHandler): void {
    this.permissionHandler = handler;
  }

  // --------------------------------------------------------------------------
  // Private Helpers
  // --------------------------------------------------------------------------

  private resolvePath(filePath: string): string {
    if (filePath.startsWith('/')) {
      return join(this.rootDir, filePath);
    }
    return join(this.rootDir, filePath);
  }

  private mapToolStatus(
    status: unknown,
  ): 'pending' | 'running' | 'success' | 'error' {
    switch (status) {
      case 'pending':
        return 'pending';
      case 'running':
        return 'running';
      case 'success':
        return 'success';
      case 'error':
        return 'error';
      default:
        return 'pending';
    }
  }
}

// ============================================================================
// AcpTestRig - Test framework core class
// ============================================================================

export class AcpTestRig {
  // Directories and paths
  testDir: string = '';
  bundlePath: string;

  // ACP components
  client: TestClient | null = null;
  connection: ClientSideConnection | null = null;
  process: ChildProcess | null = null;

  // State trackers
  sessionTracker: SessionTracker;
  toolCallCollector: ToolCallCollector;

  // State collections
  sessionUpdates: SessionNotification[] = [];
  permissionRequests: RequestPermissionRequest[] = [];
  stderrOutput: string[] = [];

  // Configuration
  testName?: string;
  private extraArgs: string[] = [];
  private timeout: number;
  private clientOptions: Partial<TestClientOptions> = {};

  constructor() {
    this.bundlePath = join(PROJECT_ROOT, 'dist/cli.js');

    // Verify bundle exists
    if (!existsSync(this.bundlePath)) {
      throw new Error(
        `Qwen CLI bundle not found at ${this.bundlePath}. ` +
          `Please build the project first with: npm run build`,
      );
    }

    this.sessionTracker = new SessionTracker();
    this.toolCallCollector = new ToolCallCollector();
    this.timeout = this.getDefaultTimeout();
  }

  // --------------------------------------------------------------------------
  // Lifecycle Methods
  // --------------------------------------------------------------------------

  /**
   * Set up the test environment with isolated directory
   */
  async setup(
    testName: string,
    options: {
      settings?: Record<string, unknown>;
      clientOptions?: Partial<TestClientOptions>;
      extraArgs?: string[];
      timeout?: number;
    } = {},
  ): Promise<void> {
    this.testName = testName;
    this.clientOptions = options.clientOptions ?? {};
    this.extraArgs = options.extraArgs ?? [];
    if (options.timeout) {
      this.timeout = options.timeout;
    }

    // Create isolated test directory
    const sanitizedName = this.sanitizeTestName(testName);
    this.testDir = join(
      env['INTEGRATION_TEST_FILE_DIR'] ?? join(PROJECT_ROOT, '.test-output'),
      sanitizedName,
    );

    // Clean and recreate directory
    if (existsSync(this.testDir)) {
      rmSync(this.testDir, { recursive: true, force: true });
    }
    mkdirSync(this.testDir, { recursive: true });

    // Create .qwen settings directory
    const qwenDir = join(this.testDir, '.qwen');
    mkdirSync(qwenDir, { recursive: true });

    // Write settings file
    const telemetryPath = join(this.testDir, 'telemetry.log');
    const settings = {
      telemetry: {
        enabled: true,
        target: 'local',
        otlpEndpoint: '',
        outfile: telemetryPath,
      },
      sandbox: env['QWEN_SANDBOX'] !== 'false' ? env['QWEN_SANDBOX'] : false,
      ...options.settings,
    };

    writeFileSync(
      join(qwenDir, 'settings.json'),
      JSON.stringify(settings, null, 2),
    );
  }

  /**
   * Start qwen process and establish ACP connection
   */
  async connect(
    options: { useNewFlag?: boolean; autoApprove?: boolean } = {},
  ): Promise<void> {
    const useNewFlag = options.useNewFlag !== false;
    const autoApprove = options.autoApprove ?? true;

    // Determine ACP flag
    const acpFlag = useNewFlag ? '--acp' : '--experimental-acp';

    // Start qwen process
    this.process = spawn(
      'node',
      [
        this.bundlePath,
        acpFlag,
        '--no-chat-recording',
        '--authType=qwen-oauth',
        ...this.extraArgs,
      ],
      {
        cwd: this.testDir,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      },
    );

    // Wait for process to be ready
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for qwen process to start'));
      }, 5000);

      const onError = (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      };

      const onExit = (code: number | null) => {
        clearTimeout(timeout);
        reject(new Error(`Qwen process exited prematurely with code ${code}`));
      };

      this.process!.once('error', onError);
      this.process!.once('exit', onExit);

      // Give process a moment to start
      setImmediate(() => {
        clearTimeout(timeout);
        this.process!.off('error', onError);
        this.process!.off('exit', onExit);
        resolve();
      });
    });

    // Capture stderr
    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      this.stderrOutput.push(text);
      if (env['VERBOSE'] === 'true') {
        process.stderr.write(text);
      }
    });

    // Handle process exit
    this.process.on('exit', (code) => {
      if (code !== 0 && code !== null && env['VERBOSE'] === 'true') {
        console.error(`Qwen process exited with code ${code}`);
      }
    });

    // Verify process streams are available
    if (!this.process.stdout || !this.process.stdin) {
      throw new Error('Process stdio streams not available');
    }

    // Create streams
    // ndJsonStream(output: WritableStream, input: ReadableStream)
    // output = where we write TO (agent's stdin)
    // input = where we read FROM (agent's stdout)
    const agentStdout = Readable.toWeb(
      this.process.stdout,
    ) as ReadableStream<Uint8Array>;
    const agentStdin = Writable.toWeb(
      this.process.stdin,
    ) as WritableStream<Uint8Array>;

    // Create ACP stream - order is (output, input) = (stdin, stdout)
    const stream = ndJsonStream(agentStdin, agentStdout);

    // Create TestClient
    this.client = new TestClient(
      {
        rootDir: this.testDir,
        autoApprove,
        ...this.clientOptions,
      },
      this.sessionTracker,
      this.toolCallCollector,
    );

    // Create connection
    this.connection = new ClientSideConnection(() => this.client!, stream);

    // Wait for connection to be ready
    await delay(500);
  }

  /**
   * Disconnect and cleanup the qwen process
   */
  async disconnect(): Promise<void> {
    // Close connection gracefully
    if (this.connection) {
      try {
        // Send cancel to any active sessions
        if (this.sessionTracker.getCurrentSessionId()) {
          await this.cancel();
        }
      } catch {
        // Ignore errors during cleanup
      }
    }

    // Kill the process
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM');

      // Wait for process to exit (with timeout)
      await Promise.race([
        new Promise<void>((resolve) => {
          this.process?.once('exit', () => resolve());
        }),
        delay(2000),
      ]);

      // Force kill if still running
      if (!this.process.killed) {
        this.process.kill('SIGKILL');
      }
    }

    this.connection = null;
    this.process = null;
    this.client = null;
  }

  /**
   * Clean up test directory
   */
  async cleanup(): Promise<void> {
    if (this.testDir && !env['KEEP_OUTPUT']) {
      try {
        rmSync(this.testDir, { recursive: true, force: true });
      } catch (error) {
        if (env['VERBOSE'] === 'true') {
          console.warn('Cleanup warning:', (error as Error).message);
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // Agent Operations
  // --------------------------------------------------------------------------

  async initialize(
    clientCapabilities?: InitializeRequest['clientCapabilities'],
  ): Promise<InitializeResponse> {
    this.ensureConnected();
    const response = await this.connection!.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: clientCapabilities ?? {
        fs: { readTextFile: true, writeTextFile: true },
      },
    });
    return response;
  }

  async authenticate(methodId: string): Promise<AuthenticateResponse | void> {
    this.ensureConnected();
    return await this.connection!.authenticate({ methodId });
  }

  async newSession(cwd?: string): Promise<NewSessionResponse> {
    this.ensureConnected();
    const response = await this.connection!.newSession({
      cwd: cwd ?? this.testDir,
      mcpServers: [],
    });

    // Track session creation
    if (response.sessionId) {
      this.sessionTracker.onSessionCreated(
        response.sessionId,
        cwd ?? this.testDir,
      );
    }

    return response;
  }

  async loadSession(
    sessionId: string,
    cwd?: string,
  ): Promise<LoadSessionResponse> {
    this.ensureConnected();
    const response = await this.connection!.loadSession({
      sessionId,
      cwd: cwd ?? this.testDir,
      mcpServers: [],
    });

    this.sessionTracker.onSessionLoaded(sessionId);
    return response;
  }

  async listSessions(): Promise<ListSessionsResponse> {
    this.ensureConnected();
    return await this.connection!.listSessions({} as ListSessionsRequest);
  }

  async prompt(
    prompt: PromptRequest['prompt'],
    sessionId?: string,
  ): Promise<PromptResponse> {
    this.ensureConnected();
    const targetSessionId =
      sessionId ?? this.sessionTracker.getCurrentSessionId();

    if (!targetSessionId) {
      throw new Error('No active session. Call newSession() first.');
    }

    return await this.connection!.prompt({
      sessionId: targetSessionId,
      prompt,
    } as PromptRequest);
  }

  async cancel(sessionId?: string): Promise<void> {
    this.ensureConnected();
    const targetSessionId =
      sessionId ?? this.sessionTracker.getCurrentSessionId();

    if (!targetSessionId) {
      return;
    }

    try {
      await this.connection!.cancel({
        sessionId: targetSessionId,
      } as CancelNotification);
    } catch {
      // Ignore errors during cancel
    }
  }

  // --------------------------------------------------------------------------
  // Session Configuration
  // --------------------------------------------------------------------------

  async setMode(modeId: SessionModeId): Promise<SetSessionModeResponse> {
    this.ensureConnected();
    const sessionId = this.sessionTracker.getCurrentSessionId();

    if (!sessionId) {
      throw new Error('No active session. Call newSession() first.');
    }

    return await this.connection!.setSessionMode({
      sessionId,
      modeId,
    } as SetSessionModeRequest);
  }

  async setModel(modelId: string): Promise<SetSessionModelResponse> {
    this.ensureConnected();
    const sessionId = this.sessionTracker.getCurrentSessionId();

    if (!sessionId) {
      throw new Error('No active session. Call newSession() first.');
    }

    return await this.connection!.unstable_setSessionModel({
      sessionId,
      modelId,
    } as SetSessionModelRequest);
  }

  async setConfigOption(
    configId: string,
    value: unknown,
  ): Promise<SetSessionConfigOptionResponse> {
    this.ensureConnected();
    const sessionId = this.sessionTracker.getCurrentSessionId();

    if (!sessionId) {
      throw new Error('No active session. Call newSession() first.');
    }

    return await this.connection!.setSessionConfigOption({
      sessionId,
      configId,
      value,
    } as SetSessionConfigOptionRequest);
  }

  // --------------------------------------------------------------------------
  // Event Waiting (for async assertions)
  // --------------------------------------------------------------------------

  async waitForToolCall(
    toolName: string,
    timeoutMs?: number,
  ): Promise<ToolCallRecord> {
    const targetTimeout = timeoutMs ?? this.timeout;

    // First check if already received
    const existing = this.toolCallCollector.findByName(toolName).pop();
    if (existing) {
      return existing;
    }

    // Wait for new tool call
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout waiting for tool call: ${toolName}`));
      }, targetTimeout);

      const handler = (record: ToolCallRecord) => {
        if (record.toolName === toolName) {
          clearTimeout(timer);
          cleanup();
          resolve(record);
        }
      };

      const cleanup = () => {
        this.toolCallCollector.off('toolCall', handler);
      };

      this.toolCallCollector.on('toolCall', handler);
    });
  }

  async waitForAnyToolCall(
    toolNames: string[],
    timeoutMs?: number,
  ): Promise<ToolCallRecord> {
    const targetTimeout = timeoutMs ?? this.timeout;

    // First check existing
    for (const name of toolNames) {
      const existing = this.toolCallCollector.findByName(name).pop();
      if (existing) return existing;
    }

    // Wait for new
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timeout waiting for any tool call: ${toolNames.join(', ')}`,
          ),
        );
      }, targetTimeout);

      const handler = (record: ToolCallRecord) => {
        if (toolNames.includes(record.toolName)) {
          clearTimeout(timer);
          cleanup();
          resolve(record);
        }
      };

      const cleanup = () => {
        this.toolCallCollector.off('toolCall', handler);
      };

      this.toolCallCollector.on('toolCall', handler);
    });
  }

  async waitForSessionUpdate(
    updateType: string,
    timeoutMs?: number,
  ): Promise<SessionNotification> {
    const targetTimeout = timeoutMs ?? this.timeout;

    // Check existing updates
    const existing = this.sessionUpdates.find(
      (u) => u.update && hasSessionUpdate(u.update, updateType),
    );
    if (existing) return existing;

    // Wait for new update
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout waiting for session update: ${updateType}`));
      }, targetTimeout);

      const handler = (notification: SessionNotification) => {
        if (
          notification.update &&
          hasSessionUpdate(notification.update, updateType)
        ) {
          clearTimeout(timer);
          cleanup();
          resolve(notification);
        }
      };

      const cleanup = () => {
        this.sessionTracker.off('sessionUpdate', handler);
      };

      this.sessionTracker.on('sessionUpdate', handler);
    });
  }

  async waitForPermissionRequest(
    timeoutMs?: number,
  ): Promise<RequestPermissionRequest> {
    const targetTimeout = timeoutMs ?? this.timeout;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Timeout waiting for permission request'));
      }, targetTimeout);

      // Store original handler
      const originalHandler = this.client?.requestPermission;

      // Intercept permission requests
      const interceptor = async (params: RequestPermissionRequest) => {
        clearTimeout(timer);
        cleanup();
        resolve(params);

        // Continue with normal handling
        if (originalHandler) {
          return originalHandler.call(this.client!, params);
        }
        return { outcome: { outcome: 'cancelled' as const } };
      };

      // Temporarily replace handler using type-safe assertion
      type ClientWithMutablePermission = TestClient & {
        requestPermission: (
          params: RequestPermissionRequest,
        ) => Promise<RequestPermissionResponse>;
      };
      if (this.client) {
        (this.client as ClientWithMutablePermission).requestPermission =
          interceptor;
      }

      const cleanup = () => {
        if (this.client && originalHandler) {
          (this.client as ClientWithMutablePermission).requestPermission =
            originalHandler;
        }
      };
    });
  }

  // --------------------------------------------------------------------------
  // File Operations
  // --------------------------------------------------------------------------

  createFile(fileName: string, content: string): string {
    const filePath = join(this.testDir, fileName);
    writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  readFile(fileName: string): string {
    const filePath = join(this.testDir, fileName);
    return readFileSync(filePath, 'utf-8');
  }

  mkdir(dir: string): void {
    mkdirSync(join(this.testDir, dir), { recursive: true });
  }

  fileExists(fileName: string): boolean {
    return existsSync(join(this.testDir, fileName));
  }

  // --------------------------------------------------------------------------
  // Utility Methods
  // --------------------------------------------------------------------------

  getStderr(): string {
    return this.stderrOutput.join('');
  }

  hasDeprecationWarning(): boolean {
    return this.stderrOutput.some((s) =>
      s.includes('--experimental-acp is deprecated'),
    );
  }

  getDefaultTimeout(): number {
    if (env['CI']) return 60000; // 1 minute in CI
    if (env['QWEN_SANDBOX']) return 30000; // 30s in containers
    return 15000; // 15s locally
  }

  // --------------------------------------------------------------------------
  // Private Helpers
  // --------------------------------------------------------------------------

  private ensureConnected(): void {
    if (!this.connection) {
      throw new Error('Not connected. Call connect() first.');
    }
  }

  private sanitizeTestName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-');
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

export function createToolCallErrorMessage(
  expectedTools: string | string[],
  foundTools: string[],
  result: string,
): string {
  const expectedStr = Array.isArray(expectedTools)
    ? expectedTools.join(' or ')
    : expectedTools;
  return (
    `Expected to find ${expectedStr} tool call(s). ` +
    `Found: ${foundTools.length > 0 ? foundTools.join(', ') : 'none'}. ` +
    `Output preview: ${result ? result.substring(0, 200) + '...' : 'no output'}`
  );
}

export async function poll<T>(
  predicate: () => T | undefined | null | false,
  timeout: number,
  interval: number,
): Promise<T> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const result = predicate();
    if (result) {
      return result as T;
    }
    await delay(interval);
  }

  throw new Error(`Poll timed out after ${timeout}ms`);
}
