/**
 * Qwen Code Backend (ACP JSON-RPC Client)
 *
 * Spawns Qwen Code in ACP mode and adapts ACP session updates into Craft's
 * provider-agnostic AgentEvent stream.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface as ReadlineInterface } from 'node:readline';

import type { AgentEvent } from '@craft-agent/core/types';
import type { FileAttachment } from '../utils/files.ts';
import { getProxyEnvVars } from '../config/proxy-env.ts';
import { getCoAuthorPreference } from '../config/preferences.ts';
import { getSessionPlansPath } from '../sessions/storage.ts';
import { getSystemPrompt } from '../prompts/system.ts';

import { BaseAgent } from './base-agent.ts';
import type {
  BackendConfig,
  ChatOptions,
  PermissionRequestType,
  SdkMcpServerConfig,
} from './backend/types.ts';
import { AbortReason } from './backend/types.ts';
import { getBackendRuntime } from './backend/internal/driver-types.ts';
import { EventQueue } from './backend/event-queue.ts';
import type { PermissionMode } from './mode-manager.ts';
import { LLM_QUERY_TIMEOUT_MS, type LLMQueryRequest, type LLMQueryResult } from './llm-tool.ts';

type JsonRpcId = string | number;
type JsonRecord = Record<string, unknown>;

type PendingJsonRpcRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
};

type AcpPermissionOption = {
  optionId?: string;
  name?: string;
  kind?: string;
};

type PendingPermission = {
  rpcId: JsonRpcId;
  options: AcpPermissionOption[];
};

type MiniCollector = {
  chunks: string[];
  inputTokens?: number;
  outputTokens?: number;
};

type AcpMcpServer =
  | {
      name: string;
      command: string;
      args: string[];
      env: Array<{ name: string; value: string }>;
    }
  | {
      type: 'http' | 'sse';
      name: string;
      url: string;
      headers: Array<{ name: string; value: string }>;
    };

type AcpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image' | 'audio'; data: string; mimeType: string };

const QWEN_CONTEXT_WINDOW = 1_000_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function jsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function mapPermissionModeToQwen(mode: PermissionMode): string {
  switch (mode) {
    case 'safe':
      return 'plan';
    case 'allow-all':
      return 'yolo';
    case 'ask':
    default:
      return 'default';
  }
}

function mapQwenModeToPermissionMode(mode: string | undefined): PermissionMode | undefined {
  switch (mode) {
    case 'plan':
      return 'safe';
    case 'yolo':
      return 'allow-all';
    case 'default':
    case 'auto-edit':
      return 'ask';
    default:
      return undefined;
  }
}

function mapPlanStatus(status: unknown): 'pending' | 'in_progress' | 'completed' {
  switch (status) {
    case 'completed':
    case 'complete':
    case 'done':
      return 'completed';
    case 'in_progress':
    case 'in-progress':
    case 'running':
      return 'in_progress';
    default:
      return 'pending';
  }
}

function normalizeToolName(toolName: string | undefined, kind?: string): string {
  const raw = (toolName || kind || 'tool').trim();
  const lower = raw.toLowerCase();

  const mappings: Record<string, string> = {
    read_file: 'Read',
    read_many_files: 'Read',
    write_file: 'Write',
    edit: 'Edit',
    replace: 'Edit',
    list_directory: 'LS',
    glob: 'Glob',
    file_search: 'Glob',
    search_file_content: 'Grep',
    grep: 'Grep',
    content_search: 'Grep',
    run_shell_command: 'Bash',
    shell: 'Bash',
    web_fetch: 'WebFetch',
    todo_write: 'TodoWrite',
    exit_plan_mode: 'ExitPlanMode',
  };

  if (mappings[lower]) return mappings[lower];

  switch (kind) {
    case 'read':
      return 'Read';
    case 'edit':
    case 'delete':
    case 'move':
      return 'Edit';
    case 'search':
      return 'Grep';
    case 'execute':
      return 'Bash';
    case 'fetch':
      return 'WebFetch';
    case 'switch_mode':
      return 'ExitPlanMode';
    default:
      return raw;
  }
}

function displayNameForTool(toolName: string, kind?: string): string {
  if (toolName === 'Bash') return 'Run Command';
  if (toolName === 'Read') return 'Read File';
  if (toolName === 'Write') return 'Write File';
  if (toolName === 'Edit') return 'Edit File';
  if (toolName === 'LS') return 'List Directory';
  if (toolName === 'Glob') return 'Search Files';
  if (toolName === 'Grep') return 'Search Content';
  if (toolName === 'WebFetch') return 'Fetch URL';
  if (toolName === 'ExitPlanMode') return 'Switch Mode';
  if (kind === 'think') return 'Think';
  return toolName;
}

function permissionTypeForKind(kind?: string): PermissionRequestType | undefined {
  switch (kind) {
    case 'execute':
      return 'bash';
    case 'edit':
    case 'delete':
    case 'move':
      return 'file_write';
    case 'fetch':
      return 'api_mutation';
    case 'switch_mode':
      return 'admin_approval';
    default:
      return 'mcp_mutation';
  }
}

export class QwenAgent extends BaseAgent {
  protected backendName = 'Qwen Code';

  private subprocess: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private startPromise: Promise<void> | null = null;
  private initialized = false;

  private qwenSessionId: string | null = null;
  private eventQueue = new EventQueue();
  private _isProcessing = false;
  private abortReason?: AbortReason;
  private persistedQwenSessionId: string | null = null;
  private activePromptRunId: number | null = null;
  private promptRunCounter = 0;
  private jsonRpcIdCounter = 0;
  private toolIdCounter = 0;
  private planUpdateCounter = 0;

  private pendingRequests = new Map<string, PendingJsonRpcRequest>();
  private pendingPermissions = new Map<string, PendingPermission>();
  private miniCollectors = new Map<string, MiniCollector>();
  private suppressedSessionUpdates = new Set<string>();

  private sourceMcpServers: Record<string, SdkMcpServerConfig> = {};
  private currentTurnId: string | undefined;
  private currentAssistantText = '';
  private toolNames = new Map<string, string>();
  private toolInputs = new Map<string, Record<string, unknown>>();

  private stderrBuffer: string[] = [];
  private stderrBufferBytes = 0;
  private static readonly STDERR_BUFFER_MAX_BYTES = 8 * 1024;

  constructor(config: BackendConfig) {
    super(config, config.model || '', QWEN_CONTEXT_WINDOW);
    this._supportsBranching = false;
    this.persistedQwenSessionId = config.session?.sdkSessionId || null;

    if (!config.isHeadless) {
      this.startConfigWatcher();
    }
  }

  getRecentStderr(): string {
    return this.stderrBuffer.join('');
  }

  override getSessionId(): string | null {
    return this.qwenSessionId ?? this.persistedQwenSessionId ?? this.config.session?.sdkSessionId ?? null;
  }

  override setSessionId(sessionId: string | null): void {
    super.setSessionId(sessionId);
    this.qwenSessionId = sessionId;
    this.persistedQwenSessionId = sessionId;
  }

  override clearHistory(): void {
    super.clearHistory();
    this.qwenSessionId = null;
    this.persistedQwenSessionId = null;
    this.config.onSdkSessionIdCleared?.();
  }

  override updateWorkingDirectory(path: string): void {
    super.updateWorkingDirectory(path);
    if (this.qwenSessionId) {
      this.qwenSessionId = null;
      this.persistedQwenSessionId = null;
      this.config.onSdkSessionIdCleared?.();
      this.debug('Qwen ACP session cleared after working directory change');
    }
  }

  protected async *chatImpl(
    messageParam: string,
    attachments?: FileAttachment[],
    _options?: ChatOptions,
  ): AsyncGenerator<AgentEvent> {
    let message = messageParam;
    const promptRunId = ++this.promptRunCounter;
    this.activePromptRunId = promptRunId;
    this._isProcessing = true;
    this.abortReason = undefined;
    this.eventQueue.reset();
    this.currentAssistantText = '';
    this.currentTurnId = `qwen-turn-${promptRunId}`;
    this.toolNames.clear();
    this.toolInputs.clear();

    this.emitAutomationEvent('UserPromptSubmit', {
      hook_event_name: 'UserPromptSubmit',
      prompt: message,
    });

    try {
      await this.ensureProcess();

      try {
        await this.ensureQwenSession();
      } catch (error) {
        if (this.persistedQwenSessionId || this.config.session?.sdkSessionId) {
          this.debug(`Qwen resume failed, starting a fresh session: ${error instanceof Error ? error.message : String(error)}`);
          this.qwenSessionId = null;
          this.persistedQwenSessionId = null;
          this.config.onSdkSessionIdCleared?.();
          const recoveryContext = this.buildRecoveryContext();
          if (recoveryContext) {
            message = recoveryContext + message;
          }
          await this.ensureQwenSession();
        } else {
          throw error;
        }
      }

      const sessionId = this.qwenSessionId;
      if (!sessionId) throw new Error('Qwen ACP session was not created');

      const prompt = this.buildPromptBlocks(message, attachments);
      const promptPromise = this.sendRequest('session/prompt', { sessionId, prompt }, 0);

      promptPromise
        .then((result) => {
          if (this.activePromptRunId !== promptRunId) return;
          const stopReason = asString(toRecord(result).stopReason);
          this.flushAssistantText();
          this.eventQueue.enqueue({ type: 'complete' });
          this.eventQueue.complete();
          this.debug(`Qwen prompt complete${stopReason ? ` (${stopReason})` : ''}`);
        })
        .catch((error) => {
          if (this.activePromptRunId !== promptRunId) return;
          if (this.abortReason) {
            this.eventQueue.complete();
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          this.eventQueue.enqueue({ type: 'error', message });
          this.eventQueue.enqueue({ type: 'complete' });
          this.eventQueue.complete();
        });

      for await (const event of this.eventQueue.drain()) {
        yield event;
        if (event.type === 'tool_result') {
          const pendingRestart = this.consumePendingSourceActivationRestart();
          if (pendingRestart) {
            yield {
              type: 'source_activated',
              sourceSlug: pendingRestart.sourceSlug,
              originalMessage: pendingRestart.userMessage,
            };
            this.forceAbort(AbortReason.SourceActivated);
            return;
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      yield { type: 'error', message };
      yield { type: 'complete' };
    } finally {
      if (this.activePromptRunId === promptRunId) {
        this.activePromptRunId = null;
      }
      this._isProcessing = false;
      this.currentTurnId = undefined;
      this.currentAssistantText = '';
    }
  }

  isProcessing(): boolean {
    return this._isProcessing;
  }

  async abort(reason?: string): Promise<void> {
    this.debug(`Qwen abort requested${reason ? `: ${reason}` : ''}`);
    this.emitAutomationEvent('Stop', { hook_event_name: 'Stop' });
    this.abortReason = AbortReason.UserStop;
    this._isProcessing = false;
    this.activePromptRunId = null;
    this.cancelPendingPermissions();

    if (this.qwenSessionId && this.subprocess) {
      await this.sendRequest('session/cancel', { sessionId: this.qwenSessionId }, 5_000).catch((error) => {
        this.debug(`Qwen cancel failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }

    this.eventQueue.complete();
  }

  forceAbort(reason: AbortReason): void {
    this.emitAutomationEvent('Stop', { hook_event_name: 'Stop' });
    this.abortReason = reason;
    this._isProcessing = false;
    this.activePromptRunId = null;
    this.cancelPendingPermissions();
    this.eventQueue.complete();

    if (this.qwenSessionId && this.subprocess) {
      void this.sendRequest('session/cancel', { sessionId: this.qwenSessionId }, 5_000).catch((error) => {
        this.debug(`Qwen force cancel failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  respondToPermission(requestId: string, allowed: boolean, alwaysAllow?: boolean): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;

    this.pendingPermissions.delete(requestId);
    if (!allowed) {
      this.sendResponse(pending.rpcId, { outcome: { outcome: 'cancelled' } });
      return;
    }

    const optionId = this.selectPermissionOption(pending.options, !!alwaysAllow);
    this.sendResponse(pending.rpcId, {
      outcome: { outcome: 'selected', optionId },
    });
  }

  override setPermissionMode(mode: PermissionMode): void {
    super.setPermissionMode(mode);
    void this.forwardPermissionMode(mode);
  }

  override cyclePermissionMode(): PermissionMode {
    const mode = super.cyclePermissionMode();
    void this.forwardPermissionMode(mode);
    return mode;
  }

  override setModel(model: string): void {
    super.setModel(model);
    if (!model || !this.qwenSessionId) return;
    void this.sendRequest('session/set_config_option', {
      sessionId: this.qwenSessionId,
      configId: 'model',
      value: model,
    }, 10_000).catch((error) => {
      this.debug(`Qwen model switch failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  override async setSourceServers(
    mcpServers: Record<string, SdkMcpServerConfig>,
    apiServers: Record<string, unknown>,
    intendedSlugs?: string[],
  ): Promise<void> {
    this.sourceMcpServers = mcpServers;
    await super.setSourceServers(mcpServers, apiServers, intendedSlugs);
  }

  async runMiniCompletion(prompt: string): Promise<string | null> {
    const result = await this.queryLlm({ prompt });
    return result.text.trim() || null;
  }

  async queryLlm(request: LLMQueryRequest): Promise<LLMQueryResult> {
    await this.ensureProcess();
    const sessionId = await this.createEphemeralSession();
    const collector: MiniCollector = { chunks: [] };
    this.miniCollectors.set(sessionId, collector);

    try {
      if (request.model) {
        await this.sendRequest('session/set_config_option', {
          sessionId,
          configId: 'model',
          value: request.model,
        }, 10_000).catch((error) => {
          this.debug(`Qwen mini model switch failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }

      const prompt = this.buildQueryPrompt(request);
      await this.sendRequest(
        'session/prompt',
        { sessionId, prompt: [{ type: 'text', text: prompt }] },
        LLM_QUERY_TIMEOUT_MS,
      );

      return {
        text: collector.chunks.join('').trim(),
        model: request.model || this._model || undefined,
        inputTokens: collector.inputTokens,
        outputTokens: collector.outputTokens,
      };
    } finally {
      this.miniCollectors.delete(sessionId);
    }
  }

  override destroy(): void {
    super.destroy();
    this.killSubprocess();
    this.pendingRequests.clear();
    this.pendingPermissions.clear();
    this.miniCollectors.clear();
  }

  // ============================================================
  // ACP process and JSON-RPC
  // ============================================================

  private async ensureProcess(): Promise<void> {
    if (this.subprocess && !this.subprocess.killed && this.initialized) return;
    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    this.startPromise = this.startProcess();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async startProcess(): Promise<void> {
    const runtime = getBackendRuntime(this.config);
    const qwenCliPath = runtime.paths?.qwenCli;
    if (!qwenCliPath) {
      throw new Error('Qwen Code CLI not found. Set QWEN_CODE_CLI to the qwen dist/cli.js path or install qwen on PATH.');
    }

    const nodePath = runtime.paths?.node || process.execPath;
    const { command, args } = this.buildSpawnCommand(qwenCliPath, nodePath);
    const cwd = this.resolvedCwd();

    this.debug(`Spawning Qwen ACP process: ${command} ${args.join(' ')}`);
    this.stderrBuffer = [];
    this.stderrBufferBytes = 0;

    const child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...getProxyEnvVars(),
        ...this.config.envOverrides,
      },
      shell: false,
    });

    this.subprocess = child;
    this.initialized = false;

    this.readline = createInterface({
      input: child.stdout!,
      crlfDelay: Infinity,
    });

    this.readline.on('line', (line) => this.handleLine(line));
    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      this.recordStderr(text);
      const trimmed = text.trim();
      if (trimmed) this.debug(`[qwen stderr] ${trimmed}`);
    });
    child.on('exit', (code, signal) => this.handleProcessExit(code, signal));
    child.on('error', (error) => {
      this.rejectAllPending(error);
      this.eventQueue.enqueue({ type: 'error', message: `Qwen ACP process error: ${error.message}` });
      this.eventQueue.complete();
    });

    await this.sendRequest('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
    }, 30_000);

    this.initialized = true;
  }

  private buildSpawnCommand(qwenCliPath: string, nodePath: string): { command: string; args: string[] } {
    const args = ['--acp'];
    if (this._model) {
      args.push('--model', this._model);
    }

    if (qwenCliPath.endsWith('.js')) {
      return { command: nodePath, args: [qwenCliPath, ...args] };
    }

    return { command: qwenCliPath, args };
  }

  private sendRequest(method: string, params?: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (!this.subprocess?.stdin || this.subprocess.killed) {
      return Promise.reject(new Error('Qwen ACP process is not running'));
    }

    const id = ++this.jsonRpcIdCounter;
    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    return new Promise((resolve, reject) => {
      const pending: PendingJsonRpcRequest = { method, resolve, reject };
      if (timeoutMs > 0) {
        pending.timeout = setTimeout(() => {
          this.pendingRequests.delete(String(id));
          reject(new Error(`Qwen ACP request timed out: ${method}`));
        }, timeoutMs);
      }
      this.pendingRequests.set(String(id), pending);
      this.subprocess!.stdin!.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) return;
        const existing = this.pendingRequests.get(String(id));
        if (existing?.timeout) clearTimeout(existing.timeout);
        this.pendingRequests.delete(String(id));
        reject(error);
      });
    });
  }

  private sendResponse(id: JsonRpcId, result: unknown): void {
    this.writeJson({ jsonrpc: '2.0', id, result });
  }

  private sendError(id: JsonRpcId, code: number, message: string): void {
    this.writeJson({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private writeJson(value: unknown): void {
    if (!this.subprocess?.stdin || this.subprocess.killed) return;
    this.subprocess.stdin.write(`${JSON.stringify(value)}\n`);
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message: JsonRecord;
    try {
      const parsed = JSON.parse(trimmed);
      if (!isRecord(parsed)) return;
      message = parsed;
    } catch {
      this.debug(`[qwen stdout] ${trimmed}`);
      return;
    }

    const id = message.id as JsonRpcId | undefined;
    const method = asString(message.method);

    if (id !== undefined && ('result' in message || 'error' in message)) {
      this.handleResponse(id, message);
      return;
    }

    if (method === 'session/update') {
      this.handleSessionUpdate(message.params);
      return;
    }

    if (method === 'session/request_permission' && id !== undefined) {
      this.handlePermissionRequest(id, message.params);
      return;
    }

    if (id !== undefined) {
      this.sendError(id, -32601, `Unsupported ACP client method: ${method || 'unknown'}`);
    }
  }

  private handleResponse(id: JsonRpcId, message: JsonRecord): void {
    const pending = this.pendingRequests.get(String(id));
    if (!pending) return;

    if (pending.timeout) clearTimeout(pending.timeout);
    this.pendingRequests.delete(String(id));

    if (isRecord(message.error)) {
      const errMsg = asString(message.error.message) || `${pending.method} failed`;
      pending.reject(new Error(errMsg));
      return;
    }

    pending.resolve(message.result);
  }

  private handleProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    const message = `Qwen ACP process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
    this.debug(message);
    this.initialized = false;
    this.subprocess = null;
    this.readline?.close();
    this.readline = null;

    this.rejectAllPending(new Error(message));
    this.pendingPermissions.clear();

    if (this._isProcessing && !this.abortReason) {
      this.eventQueue.enqueue({ type: 'error', message });
      this.eventQueue.enqueue({ type: 'complete' });
      this.eventQueue.complete();
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pendingRequests) {
      if (pending.timeout) clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private killSubprocess(): void {
    this.readline?.close();
    this.readline = null;
    if (this.subprocess && !this.subprocess.killed) {
      this.subprocess.kill();
    }
    this.subprocess = null;
    this.initialized = false;
  }

  private recordStderr(chunk: string): void {
    if (!chunk) return;
    const effective = chunk.length > QwenAgent.STDERR_BUFFER_MAX_BYTES
      ? chunk.slice(chunk.length - QwenAgent.STDERR_BUFFER_MAX_BYTES)
      : chunk;
    this.stderrBuffer.push(effective);
    this.stderrBufferBytes += effective.length;
    while (this.stderrBufferBytes > QwenAgent.STDERR_BUFFER_MAX_BYTES && this.stderrBuffer.length > 1) {
      const dropped = this.stderrBuffer.shift()!;
      this.stderrBufferBytes -= dropped.length;
    }
  }

  // ============================================================
  // Session management
  // ============================================================

  private async ensureQwenSession(): Promise<void> {
    if (this.qwenSessionId) {
      await this.applySessionSettings(this.qwenSessionId);
      return;
    }

    const cwd = this.resolvedCwd();
    const mcpServers = this.buildAcpMcpServers();
    const existingSessionId = this.persistedQwenSessionId ?? this.config.session?.sdkSessionId;

    if (existingSessionId) {
      this.suppressedSessionUpdates.add(existingSessionId);
      try {
        await this.sendRequest('session/load', {
          sessionId: existingSessionId,
          cwd,
          mcpServers,
        }, 60_000);
        this.qwenSessionId = existingSessionId;
        this.persistedQwenSessionId = existingSessionId;
        this.config.onSdkSessionIdUpdate?.(existingSessionId);
        await this.applySessionSettings(existingSessionId);
        return;
      } finally {
        this.suppressedSessionUpdates.delete(existingSessionId);
      }
    }

    const result = toRecord(await this.sendRequest('session/new', {
      cwd,
      mcpServers,
    }, 60_000));

    const sessionId = asString(result.sessionId);
    if (!sessionId) {
      throw new Error('Qwen ACP did not return a sessionId');
    }

    this.qwenSessionId = sessionId;
    this.persistedQwenSessionId = sessionId;
    this.config.onSdkSessionIdUpdate?.(sessionId);
    await this.applySessionSettings(sessionId);
  }

  private async createEphemeralSession(): Promise<string> {
    const result = toRecord(await this.sendRequest('session/new', {
      cwd: this.resolvedCwd(),
      mcpServers: [],
    }, 60_000));
    const sessionId = asString(result.sessionId);
    if (!sessionId) {
      throw new Error('Qwen ACP did not return a sessionId for mini completion');
    }
    return sessionId;
  }

  private async applySessionSettings(sessionId: string): Promise<void> {
    await this.forwardPermissionMode(this.getPermissionMode(), sessionId);

    if (this._model) {
      await this.sendRequest('session/set_config_option', {
        sessionId,
        configId: 'model',
        value: this._model,
      }, 10_000).catch((error) => {
        this.debug(`Qwen initial model switch failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  private async forwardPermissionMode(mode: PermissionMode, sessionId = this.qwenSessionId): Promise<void> {
    if (!sessionId || !this.subprocess) return;
    await this.sendRequest('session/set_mode', {
      sessionId,
      modeId: mapPermissionModeToQwen(mode),
    }, 10_000).catch((error) => {
      this.debug(`Qwen mode switch failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private resolvedCwd(): string {
    return this.config.session?.workingDirectory
      || this.workingDirectory
      || this.config.workspace.rootPath
      || process.cwd();
  }

  private buildAcpMcpServers(): AcpMcpServer[] {
    if (this.config.poolServerUrl) {
      return [{
        type: 'http',
        name: 'craft_sources',
        url: this.config.poolServerUrl,
        headers: [],
      }];
    }

    return Object.entries(this.sourceMcpServers).map(([name, config]) => {
      if (config.type === 'stdio') {
        const env = new Map<string, string>();
        for (const [key, value] of Object.entries(config.env ?? {})) {
          env.set(key, value);
        }
        for (const key of config.envVars ?? []) {
          const value = process.env[key];
          if (value !== undefined) env.set(key, value);
        }
        return {
          name,
          command: config.command,
          args: config.args ?? [],
          env: [...env.entries()].map(([envName, value]) => ({ name: envName, value })),
        };
      }

      const headers = new Map<string, string>();
      for (const [key, value] of Object.entries(config.headers ?? {})) {
        headers.set(key, value);
      }
      if (config.bearerTokenEnvVar && process.env[config.bearerTokenEnvVar]) {
        headers.set('Authorization', `Bearer ${process.env[config.bearerTokenEnvVar]}`);
      }

      return {
        type: config.type,
        name,
        url: config.url,
        headers: [...headers.entries()].map(([headerName, value]) => ({ name: headerName, value })),
      };
    });
  }

  // ============================================================
  // Prompt construction
  // ============================================================

  private buildPromptBlocks(message: string, attachments?: FileAttachment[]): AcpContentBlock[] {
    const textParts: string[] = [];
    const context = this.buildCraftContext();
    if (context) {
      textParts.push(`<craft_agent_context>\n${context}\n</craft_agent_context>`);
    }

    for (const attachment of attachments ?? []) {
      if (attachment.mimeType?.startsWith('image/') && attachment.base64) {
        continue;
      }
      const filePath = attachment.storedPath || attachment.markdownPath || attachment.path;
      if (filePath) {
        textParts.push(`[Attached file: ${attachment.name}]\n[Stored at: ${filePath}]`);
      } else if (attachment.text) {
        textParts.push(`[Attached text: ${attachment.name}]\n${attachment.text}`);
      }
    }

    textParts.push(message);
    const blocks: AcpContentBlock[] = [{ type: 'text', text: textParts.filter(Boolean).join('\n\n') }];

    for (const attachment of attachments ?? []) {
      if (attachment.mimeType?.startsWith('image/') && attachment.base64) {
        blocks.push({
          type: 'image',
          data: attachment.base64,
          mimeType: attachment.mimeType,
        });
      }
    }

    return blocks;
  }

  private buildCraftContext(): string {
    const systemPrompt = getSystemPrompt(
      undefined,
      this.config.debugMode,
      this.config.workspace.rootPath,
      this.config.session?.workingDirectory,
      this.config.systemPromptPreset,
      this.backendName,
      getCoAuthorPreference(),
    );

    const sourceContext = this.sourceManager.formatSourceState();
    const contextParts = this.promptBuilder.buildContextParts(
      { plansFolderPath: getSessionPlansPath(this.config.workspace.rootPath, this._sessionId) },
      sourceContext,
    );

    return [systemPrompt, ...contextParts].filter(Boolean).join('\n\n');
  }

  private buildQueryPrompt(request: LLMQueryRequest): string {
    const parts: string[] = [];
    if (request.systemPrompt) {
      parts.push(`System instructions:\n${request.systemPrompt}`);
    }
    if (request.outputSchema) {
      parts.push(`Return a JSON value that conforms to this schema:\n${jsonStringify(request.outputSchema)}`);
    }
    parts.push(request.prompt);
    return parts.join('\n\n');
  }

  // ============================================================
  // Update adaptation
  // ============================================================

  private handleSessionUpdate(params: unknown): void {
    const record = toRecord(params);
    const sessionId = asString(record.sessionId);
    const update = toRecord(record.update);
    if (!sessionId || !update.sessionUpdate) return;

    const collector = this.miniCollectors.get(sessionId);
    if (collector) {
      this.collectMiniUpdate(collector, update);
      return;
    }

    if (this.suppressedSessionUpdates.has(sessionId)) return;
    if (sessionId !== this.qwenSessionId || !this._isProcessing) return;

    this.captureUsage(update);

    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.handleAgentMessageChunk(update);
        break;
      case 'agent_thought_chunk':
        break;
      case 'tool_call':
        this.handleToolCall(update);
        break;
      case 'tool_call_update':
        this.handleToolCallUpdate(update);
        break;
      case 'plan':
        this.handlePlanUpdate(update);
        break;
      case 'current_mode_update':
        this.handleModeUpdate(update);
        break;
      default:
        break;
    }
  }

  private collectMiniUpdate(collector: MiniCollector, update: JsonRecord): void {
    this.captureUsageInto(collector, update);
    if (update.sessionUpdate !== 'agent_message_chunk') return;
    const content = toRecord(update.content);
    if (content.type !== 'text') return;
    const text = asString(content.text);
    if (text) collector.chunks.push(text);
  }

  private handleAgentMessageChunk(update: JsonRecord): void {
    const content = toRecord(update.content);
    if (content.type !== 'text') return;
    const text = asString(content.text);
    if (!text) return;
    this.currentAssistantText += text;
    this.eventQueue.enqueue({
      type: 'text_delta',
      text,
      turnId: this.currentTurnId,
    });
  }

  private flushAssistantText(): void {
    if (!this.currentAssistantText) return;
    this.eventQueue.enqueue({
      type: 'text_complete',
      text: this.currentAssistantText,
      turnId: this.currentTurnId,
    });
    this.currentAssistantText = '';
  }

  private handleToolCall(update: JsonRecord): void {
    const toolUseId = asString(update.toolCallId) || `qwen-tool-${++this.toolIdCounter}`;
    const rawInput = toRecord(update.rawInput);
    const meta = toRecord(update._meta);
    const kind = asString(update.kind);
    const toolName = normalizeToolName(asString(meta.toolName) || asString(update.title), kind);
    const title = asString(update.title);

    this.toolNames.set(toolUseId, toolName);
    this.toolInputs.set(toolUseId, rawInput);

    this.eventQueue.enqueue({
      type: 'tool_start',
      toolName,
      toolUseId,
      input: rawInput,
      intent: title,
      displayName: displayNameForTool(toolName, kind),
      turnId: this.currentTurnId,
    });
  }

  private handleToolCallUpdate(update: JsonRecord): void {
    const toolUseId = asString(update.toolCallId) || `qwen-tool-${++this.toolIdCounter}`;
    const meta = toRecord(update._meta);
    const toolName = this.toolNames.get(toolUseId)
      || normalizeToolName(asString(meta.toolName), asString(update.kind));
    const result = this.formatToolResult(update);
    const isError = update.status === 'failed';

    this.eventQueue.enqueue({
      type: 'tool_result',
      toolUseId,
      toolName,
      result,
      isError,
      input: this.toolInputs.get(toolUseId),
      turnId: this.currentTurnId,
    });
  }

  private handlePlanUpdate(update: JsonRecord): void {
    const entries = Array.isArray(update.entries) ? update.entries : [];
    const todos = entries
      .filter(isRecord)
      .map((entry) => ({
        content: asString(entry.content) || '',
        status: mapPlanStatus(entry.status),
        activeForm: asString(entry.content) || '',
      }))
      .filter((todo) => todo.content);

    const toolUseId = `qwen-plan-${++this.planUpdateCounter}`;
    const input = { todos };
    this.eventQueue.enqueue({
      type: 'tool_start',
      toolName: 'TodoWrite',
      toolUseId,
      input,
      displayName: 'Todo List Updated',
      turnId: this.currentTurnId,
    });
    this.eventQueue.enqueue({
      type: 'tool_result',
      toolUseId,
      toolName: 'TodoWrite',
      result: 'Todo list updated',
      isError: false,
      input,
      turnId: this.currentTurnId,
    });
  }

  private handleModeUpdate(update: JsonRecord): void {
    const modeId = asString(update.modeId) || asString(update.currentModeId);
    const mode = mapQwenModeToPermissionMode(modeId);
    if (!mode || mode === this.getPermissionMode()) return;
    this.permissionManager.setPermissionMode(mode);
    this.onPermissionModeChange?.(mode);
  }

  private formatToolResult(update: JsonRecord): string {
    const content = Array.isArray(update.content) ? update.content : [];
    const parts: string[] = [];

    for (const item of content) {
      if (!isRecord(item)) continue;
      if (item.type === 'content') {
        const inner = toRecord(item.content);
        if (inner.type === 'text' && typeof inner.text === 'string') {
          parts.push(inner.text);
        } else {
          parts.push(jsonStringify(inner));
        }
      } else if (item.type === 'diff') {
        const path = asString(item.path) || 'file';
        parts.push(`Updated ${path}`);
      } else if (item.type === 'terminal') {
        parts.push(jsonStringify(item));
      }
    }

    if (parts.length > 0) return parts.join('\n\n');
    if ('rawOutput' in update) return typeof update.rawOutput === 'string' ? update.rawOutput : jsonStringify(update.rawOutput);
    return update.status === 'failed' ? 'Tool failed' : 'Tool completed';
  }

  private captureUsage(update: JsonRecord): void {
    const usage = this.extractUsage(update);
    if (!usage) return;
    this.eventQueue.enqueue({
      type: 'usage_update',
      usage: { inputTokens: usage.inputTokens },
    });
  }

  private captureUsageInto(collector: MiniCollector, update: JsonRecord): void {
    const usage = this.extractUsage(update);
    if (!usage) return;
    collector.inputTokens = usage.inputTokens;
    collector.outputTokens = usage.outputTokens;
  }

  private extractUsage(update: JsonRecord): { inputTokens: number; outputTokens?: number } | null {
    const meta = toRecord(update._meta);
    const usage = toRecord(meta.usage);
    if (Object.keys(usage).length === 0) return null;

    const inputTokens =
      asNumber(usage.inputTokens)
      ?? asNumber(usage.promptTokens)
      ?? asNumber(usage.promptTokenCount)
      ?? 0;
    const cachedTokens =
      asNumber(usage.cachedReadTokens)
      ?? asNumber(usage.cachedTokens)
      ?? asNumber(usage.cachedContentTokenCount)
      ?? 0;
    const outputTokens =
      asNumber(usage.outputTokens)
      ?? asNumber(usage.completionTokens)
      ?? asNumber(usage.candidatesTokenCount);

    return { inputTokens: inputTokens + cachedTokens, outputTokens };
  }

  // ============================================================
  // Permissions
  // ============================================================

  private handlePermissionRequest(rpcId: JsonRpcId, params: unknown): void {
    const record = toRecord(params);
    const toolCall = toRecord(record.toolCall);
    const options = Array.isArray(record.options)
      ? record.options.filter(isRecord) as AcpPermissionOption[]
      : [];

    const requestId = `qwen-permission-${String(rpcId)}`;
    this.pendingPermissions.set(requestId, { rpcId, options });

    const kind = asString(toolCall.kind);
    const rawInput = toRecord(toolCall.rawInput);
    const title = asString(toolCall.title) || 'Qwen Code requests permission';
    const toolName = normalizeToolName(asString(toRecord(toolCall._meta).toolName) || title, kind);
    const command = asString(rawInput.command) || asString(rawInput.cmd);

    if (!this.onPermissionRequest) {
      const autoAllow = this.getPermissionMode() === 'allow-all';
      this.respondToPermission(requestId, autoAllow, autoAllow);
      return;
    }

    try {
      this.onPermissionRequest({
        requestId,
        toolName,
        command,
        description: title,
        type: permissionTypeForKind(kind),
        reason: asString(rawInput.reason),
        impact: this.permissionImpact(toolCall),
      });
    } catch (error) {
      this.debug(`Qwen permission callback failed: ${error instanceof Error ? error.message : String(error)}`);
      this.respondToPermission(requestId, false, false);
    }
  }

  private permissionImpact(toolCall: JsonRecord): string | undefined {
    const content = Array.isArray(toolCall.content) ? toolCall.content : [];
    for (const item of content) {
      if (!isRecord(item)) continue;
      if (item.type === 'diff') {
        return `Will modify ${asString(item.path) || 'a file'}`;
      }
      if (item.type === 'content') {
        const inner = toRecord(item.content);
        const text = asString(inner.text);
        if (text) return text.slice(0, 500);
      }
    }
    return undefined;
  }

  private selectPermissionOption(options: AcpPermissionOption[], alwaysAllow: boolean): string {
    if (alwaysAllow) {
      const always = options.find((option) =>
        option.kind === 'allow_always'
        || option.optionId?.includes('always')
      );
      if (always?.optionId) return always.optionId;
    }

    const once = options.find((option) =>
      option.optionId === 'proceed_once'
      || option.kind === 'allow_once'
    );
    if (once?.optionId) return once.optionId;

    const firstAllow = options.find((option) => option.kind !== 'reject_once' && option.optionId);
    return firstAllow?.optionId || 'proceed_once';
  }

  private cancelPendingPermissions(): void {
    for (const [, pending] of this.pendingPermissions) {
      this.sendResponse(pending.rpcId, { outcome: { outcome: 'cancelled' } });
    }
    this.pendingPermissions.clear();
  }

  protected override debug(message: string): void {
    this.onDebug?.(`[QwenAgent] ${message}`);
  }
}

export { QwenAgent as QwenBackend };
