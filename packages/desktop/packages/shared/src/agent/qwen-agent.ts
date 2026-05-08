/**
 * Qwen Code Backend (ACP SDK Client)
 *
 * Spawns Qwen Code in ACP mode and adapts ACP session updates into Craft's
 * provider-agnostic AgentEvent stream.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Client,
  type ContentBlock,
  type McpServer,
  type ModelInfo,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import type { AgentEvent, AvailableSlashCommand, Message, MessageTextElement } from '@craft-agent/core/types';
import { utf16IndexToByteOffset } from '@craft-agent/core/utils';
import type { FileAttachment } from '../utils/files.ts';
import type { ModelDefinition } from '../config/models.ts';
import { getProxyEnvVars } from '../config/proxy-env.ts';
import { getCoAuthorPreference } from '../config/preferences.ts';
import { getSessionPlansPath } from '../sessions/storage.ts';
import { getSystemPrompt } from '../prompts/system.ts';
import { resolveFileMentions, resolveSourceMentions } from '../mentions/index.ts';

import { BaseAgent } from './base-agent.ts';
import type {
  BackendConfig,
  BackendSessionMessagesResult,
  AvailableCommandsSnapshot,
  BackendSessionListOptions,
  BackendSessionListResult,
  ChatOptions,
  PermissionRequestType,
  SdkMcpServerConfig,
} from './backend/types.ts';
import { AbortReason } from './backend/types.ts';
import { getBackendRuntime } from './backend/internal/driver-types.ts';
import { EventQueue } from './backend/event-queue.ts';
import type { PermissionMode } from './mode-manager.ts';
import { LLM_QUERY_TIMEOUT_MS, type LLMQueryRequest, type LLMQueryResult } from './llm-tool.ts';

type JsonRecord = Record<string, unknown>;

type AcpPermissionOption = {
  optionId?: string;
  name?: string;
  kind?: string;
};

type PendingPermission = {
  resolve: (response: RequestPermissionResponse) => void;
  options: AcpPermissionOption[];
};

type MiniCollector = {
  chunks: string[];
  inputTokens?: number;
  outputTokens?: number;
};

type HistoryCollector = {
  updates: JsonRecord[];
};

type SlashCommandInvocation = {
  rawCommand: string;
  timestamp: number;
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 60_000;
const INCLUDE_CRAFT_CONTEXT_IN_QWEN_PROMPTS = false;

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = asNumber(value);
    if (number !== undefined) return number;
  }
  return undefined;
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    const bool = asBoolean(value);
    if (bool !== undefined) return bool;
  }
  return undefined;
}

function toQwenModelDefinition(value: unknown): ModelDefinition | null {
  const model = toRecord(value as ModelInfo);
  const id = asString(model.modelId);
  if (!id) return null;
  const name = asString(model.name) || id;
  const meta = toRecord(model._meta);
  const generationConfig = toRecord(model.generationConfig);
  const metaGenerationConfig = toRecord(meta.generationConfig);
  const extraBody = toRecord(generationConfig.extra_body);
  const metaExtraBody = toRecord(metaGenerationConfig.extra_body);
  const capabilities = toRecord(model.capabilities);
  const limits = toRecord(capabilities.limits);
  const metaCapabilities = toRecord(meta.capabilities);
  const metaLimits = toRecord(metaCapabilities.limits);
  const contextWindow = firstNumber(
    meta.contextLimit,
    meta.contextWindowSize,
    meta.contextWindow,
    model.contextWindowSize,
    model.contextWindow,
    model.maxContextWindowTokens,
    metaGenerationConfig.contextWindowSize,
    metaGenerationConfig.contextWindow,
    generationConfig.contextWindowSize,
    generationConfig.contextWindow,
    metaLimits.max_context_window_tokens,
    limits.max_context_window_tokens,
  );
  const supportsThinking = firstBoolean(
    meta.supportsThinking,
    meta.supportsReasoning,
    meta.enableThinking,
    meta.enable_thinking,
    model.supportsThinking,
    model.supportsReasoning,
    model.enableThinking,
    model.enable_thinking,
    metaGenerationConfig.enableThinking,
    metaGenerationConfig.enable_thinking,
    metaExtraBody.enableThinking,
    metaExtraBody.enable_thinking,
    generationConfig.enableThinking,
    generationConfig.enable_thinking,
    extraBody.enableThinking,
    extraBody.enable_thinking,
  );

  return {
    id,
    name,
    shortName: name,
    description: asString(model.description) || '',
    provider: 'qwen',
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(supportsThinking !== undefined ? { supportsThinking } : {}),
  };
}

function toRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

function toAvailableSlashCommands(value: unknown): AvailableSlashCommand[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const commands: AvailableSlashCommand[] = [];

  for (const item of value) {
    const record = toRecord(item);
    const rawName = asString(record.name)?.trim().replace(/^\/+/, '');
    if (!rawName || seen.has(rawName)) continue;

    seen.add(rawName);
    const input = record.input === null || isRecord(record.input)
      ? record.input
      : undefined;

    commands.push({
      name: rawName,
      description: asString(record.description),
      ...(input !== undefined && { input }),
    });
  }

  return commands;
}

function toAvailableSkills(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const seen = new Set<string>();
  const skills: string[] = [];

  for (const item of value) {
    const name = asString(item)?.trim().replace(/^\/+/, '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    skills.push(name);
  }

  return skills.length > 0 ? skills : undefined;
}

function formatDebugNames(values: string[] | undefined, max = 40): string {
  if (!values || values.length === 0) return 'none';
  const visible = values.slice(0, max).join(', ');
  return values.length > max ? `${visible}, ... +${values.length - max} more` : visible;
}

function parseQwenTimestamp(value: unknown): number | undefined {
  const raw = asString(value);
  if (!raw) return undefined;
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function sanitizeQwenCwd(cwd: string): string {
  const normalizedCwd = platform() === 'win32' ? cwd.toLowerCase() : cwd;
  return normalizedCwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function resolveQwenRuntimeDir(dir: string): string {
  if (dir === '~') return homedir();
  if (dir.startsWith('~/') || dir.startsWith('~\\')) {
    return join(homedir(), ...dir.slice(2).split(/[/\\]+/).filter(Boolean));
  }
  return isAbsolute(dir) ? dir : resolve(dir);
}

function getQwenRuntimeDir(): string {
  const envDir = process.env.QWEN_RUNTIME_DIR;
  if (envDir) return resolveQwenRuntimeDir(envDir);

  const homeDir = homedir();
  return homeDir ? join(homeDir, '.qwen') : join(tmpdir(), '.qwen');
}

function getQwenTranscriptPath(sessionId: string, cwd: string): string {
  const projectId = sanitizeQwenCwd(resolve(cwd));
  return join(getQwenRuntimeDir(), 'projects', projectId, 'chats', `${sessionId}.jsonl`);
}

function qwenSkillNameFromTextElement(element: MessageTextElement): string | undefined {
  const raw = (element.target || element.label || element.placeholder || '').trim();
  if (!raw) return undefined;

  const bracketMatch = /^\[skill:([^\]]+)\]$/.exec(raw);
  const normalized = (bracketMatch?.[1] ?? raw).trim();
  const withoutPlugin = normalized.startsWith('.agents:')
    ? normalized.slice('.agents:'.length).trim()
    : normalized;
  return withoutPlugin.split(':').pop()?.trim() || withoutPlugin;
}

function rangesOverlapBytes(a: MessageTextElement, b: MessageTextElement): boolean {
  return a.byte_range.start < b.byte_range.end && b.byte_range.start < a.byte_range.end;
}

function qwenTranscriptPlaceholderFromSourceElement(sourceElement: MessageTextElement): string | undefined {
  if (sourceElement.type === 'skill') {
    const skillName = qwenSkillNameFromTextElement(sourceElement);
    return skillName ? `@${skillName}` : undefined;
  }

  return sourceElement.placeholder || undefined;
}

function findNonOverlappingPlaceholderStart(
  content: string,
  placeholder: string,
  elements: MessageTextElement[],
): number {
  let start = content.indexOf(placeholder);
  while (start >= 0) {
    const candidate: MessageTextElement = {
      type: 'context',
      byte_range: {
        start: utf16IndexToByteOffset(content, start),
        end: utf16IndexToByteOffset(content, start + placeholder.length),
      },
      placeholder,
    };
    if (!elements.some(existing => rangesOverlapBytes(existing, candidate))) return start;
    start = content.indexOf(placeholder, start + placeholder.length);
  }
  return -1;
}

function buildQwenTranscriptTextElements(
  content: string,
  sourceElements?: MessageTextElement[],
): MessageTextElement[] | undefined {
  const elements: MessageTextElement[] = [];

  for (const sourceElement of sourceElements ?? []) {
    const placeholder = qwenTranscriptPlaceholderFromSourceElement(sourceElement);
    if (!placeholder) continue;

    const start = findNonOverlappingPlaceholderStart(content, placeholder, elements);
    if (start < 0) continue;

    const element: MessageTextElement = {
      type: sourceElement.type,
      byte_range: {
        start: utf16IndexToByteOffset(content, start),
        end: utf16IndexToByteOffset(content, start + placeholder.length),
      },
      placeholder,
      ...(sourceElement.label ? { label: sourceElement.label } : {}),
      ...(sourceElement.target ? { target: sourceElement.target } : {}),
      ...(sourceElement.metadata ? { metadata: sourceElement.metadata } : {}),
    };

    if (sourceElement.type === 'skill') {
      const skillName = qwenSkillNameFromTextElement(sourceElement);
      if (skillName) {
        element.target = skillName;
        element.label = sourceElement.label || skillName;
      }
    }

    elements.push(element);
  }

  elements.sort((a, b) => a.byte_range.start - b.byte_range.start);
  return elements.length > 0 ? elements : undefined;
}

function toQwenTranscriptTextElements(value: unknown): MessageTextElement[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const byteOffset = (offset: unknown): number | undefined => {
    if (typeof offset === 'number' && Number.isFinite(offset) && offset >= 0) return offset;
    if (typeof offset !== 'string') return undefined;
    const parsed = Number(offset);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
  };

  const elements = value
    .filter(isRecord)
    .map((element): MessageTextElement | null => {
      const type = asString(element.type) as MessageTextElement['type'] | undefined;
      const byteRange = toRecord(element.byte_range);
      const start = byteOffset(byteRange.start);
      const end = byteOffset(byteRange.end);
      const placeholder = asString(element.placeholder);
      if (!type || start == null || end == null || !placeholder) return null;
      if (!['source', 'skill', 'context', 'slash_command', 'file', 'folder'].includes(type)) return null;
      return {
        type,
        byte_range: { start, end },
        placeholder,
        ...(asString(element.label) ? { label: asString(element.label) } : {}),
        ...(asString(element.target) ? { target: asString(element.target) } : {}),
        ...(isRecord(element.metadata) ? { metadata: element.metadata } : {}),
      };
    })
    .filter((element): element is MessageTextElement => !!element);

  return elements.length > 0 ? elements : undefined;
}

function jsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseJsonText(value: string): unknown | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function isJsonCodeFence(value: string): boolean {
  return /^```(?:json|JSON)?\s*\r?\n/.test(value.trim());
}

function isDoctorOutput(value: unknown): boolean {
  const record = toRecord(value);
  return Array.isArray(record.checks) && isRecord(record.summary);
}

function formatJsonMarkdown(value: unknown): string {
  return `\`\`\`json\n${jsonStringify(value)}\n\`\`\``;
}

function normalizeQwenAssistantText(
  text: string,
  options: { forceJsonFence?: boolean } = {},
): string {
  const trimmed = text.trim();
  if (!trimmed || isJsonCodeFence(trimmed)) return text;
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text;

  const parsed = parseJsonText(text);
  if (!parsed) return text;
  if (!options.forceJsonFence && !isDoctorOutput(parsed)) return text;

  return formatJsonMarkdown(parsed);
}

function normalizeQwenUserHistoryText(text: string): string {
  return text
    .replace(/^<craft_agent_context>[\s\S]*?<\/craft_agent_context>\s*/, '')
    .trimStart();
}

function formatQwenSlashOutputHistoryItem(item: JsonRecord): string | undefined {
  const text = asString(item.text);
  if (text?.trim()) {
    return normalizeQwenAssistantText(text, { forceJsonFence: true });
  }

  if (item.type === 'doctor') {
    return formatJsonMarkdown({
      checks: Array.isArray(item.checks) ? item.checks : [],
      summary: toRecord(item.summary),
    });
  }

  return undefined;
}

function isSlashCommandPrompt(message: string, attachments?: FileAttachment[]): boolean {
  if (attachments && attachments.length > 0) return false;
  return /^\/[A-Za-z][\w-]*(?:\s|$)/.test(message.trim());
}

function qwenInitializeTimeoutMs(): number {
  const raw = process.env.QWEN_ACP_INITIALIZE_TIMEOUT_MS || process.env.QWEN_INITIALIZE_TIMEOUT_MS;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_INITIALIZE_TIMEOUT_MS;
}

function mapPermissionModeToQwen(mode: PermissionMode): string {
  switch (mode) {
    case 'allow-all':
      return 'yolo';
    case 'safe':
      return 'plan';
    case 'auto-edit':
      return 'auto-edit';
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
    case 'auto-edit':
      return 'auto-edit';
    case 'default':
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
  private connection: ClientSideConnection | null = null;
  private startPromise: Promise<void> | null = null;
  private initialized = false;

  private qwenSessionId: string | null = null;
  private ensureQwenSessionPromise: Promise<void> | null = null;
  private eventQueue = new EventQueue();
  private _isProcessing = false;
  private abortReason?: AbortReason;
  private persistedQwenSessionId: string | null = null;
  private activePromptRunId: number | null = null;
  private promptRunCounter = 0;
  private permissionRequestCounter = 0;
  private toolIdCounter = 0;
  private planUpdateCounter = 0;
  private hasInitialModeOverride = false;
  private pendingModeOverride: PermissionMode | null = null;

  private pendingPermissions = new Map<string, PendingPermission>();
  private miniCollectors = new Map<string, MiniCollector>();
  private historyCollectors = new Map<string, HistoryCollector>();
  private suppressedSessionUpdates = new Set<string>();
  private pendingAvailableCommandsUpdates = new Map<string, JsonRecord>();
  private latestAvailableCommandsSnapshot: AvailableCommandsSnapshot | null = null;
  private availableCommandsWaiters: Array<(snapshot: AvailableCommandsSnapshot | null) => void> = [];
  private availableModelIds: Set<string> | null = null;
  private availableModelsById = new Map<string, ModelDefinition>();
  private firstAvailableModelId: string | undefined;

  private sourceMcpServers: Record<string, SdkMcpServerConfig> = {};
  private currentTurnId: string | undefined;
  private currentAssistantText = '';
  private currentThoughtText = '';
  private currentIsSlashCommand = false;
  private toolNames = new Map<string, string>();
  private toolInputs = new Map<string, Record<string, unknown>>();

  private stderrBuffer: string[] = [];
  private stderrBufferBytes = 0;
  private static readonly STDERR_BUFFER_MAX_BYTES = 8 * 1024;

  constructor(config: BackendConfig) {
    super(config, config.model || '');
    this._supportsBranching = false;
    this.persistedQwenSessionId = config.session?.sdkSessionId || null;
    this.pendingModeOverride = config.session?.permissionMode && !config.session?.sdkSessionId
      ? config.session.permissionMode
      : null;
    this.hasInitialModeOverride = this.pendingModeOverride !== null;

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
    this.pendingAvailableCommandsUpdates.clear();
    this.latestAvailableCommandsSnapshot = null;
    this.resolveAvailableCommandsWaiters(null);
    this.config.onSdkSessionIdCleared?.();
  }

  protected override extractSkillPaths(message: string): {
    skillPaths: Map<string, string>;
    cleanMessage: string;
    missingSkills: string[];
  } {
    const withQwenSkills = message.replace(
      /\[skill:([^\]]+)\]/g,
      (_match, rawSkill: string) => {
        const normalized = rawSkill.trim();
        const skillName = normalized.startsWith('.agents:')
          ? normalized.slice('.agents:'.length).trim()
          : normalized;
        return skillName ? `@${skillName}` : '';
      },
    );
    const withSources = resolveSourceMentions(withQwenSkills);
    const workDir = this.config.session?.workingDirectory ?? this.workingDirectory;
    const cleanMessage = resolveFileMentions(withSources, workDir).trim();

    if (withQwenSkills !== message) {
      this.debug('[extractSkillPaths] Qwen skill mentions are passed to ACP as @skill references');
    }

    return {
      skillPaths: new Map(),
      cleanMessage: cleanMessage || message.trim(),
      missingSkills: [],
    };
  }

  override updateWorkingDirectory(path: string): void {
    super.updateWorkingDirectory(path);
    if (this.qwenSessionId) {
      this.qwenSessionId = null;
      this.persistedQwenSessionId = null;
      this.pendingAvailableCommandsUpdates.clear();
      this.latestAvailableCommandsSnapshot = null;
      this.resolveAvailableCommandsWaiters(null);
      this.config.onSdkSessionIdCleared?.();
      this.debug('Qwen ACP session cleared after working directory change');
    }
  }

  protected async *chatImpl(
    messageParam: string,
    attachments?: FileAttachment[],
    options?: ChatOptions,
  ): AsyncGenerator<AgentEvent> {
    let message = messageParam;
    const promptRunId = ++this.promptRunCounter;
    this.activePromptRunId = promptRunId;
    this._isProcessing = true;
    this.abortReason = undefined;
    this.eventQueue.reset();
    this.currentAssistantText = '';
    this.currentThoughtText = '';
    this.currentIsSlashCommand = isSlashCommandPrompt(message, attachments);
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
          if (recoveryContext && !isSlashCommandPrompt(message, attachments)) {
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
      let transcriptTextElementsPersisted = false;
      const persistTranscriptTextElements = () => {
        if (transcriptTextElementsPersisted) return;
        transcriptTextElementsPersisted = true;
        this.persistQwenTranscriptTextElements(sessionId, this.resolvedCwd(), options?.textElements);
      };
      const promptPromise = this.callAcp(
        'session/prompt',
        (connection) => connection.prompt({ sessionId, prompt }),
        0,
      );

      promptPromise
        .then((result) => {
          if (this.activePromptRunId !== promptRunId) return;
          const stopReason = asString(toRecord(result).stopReason);
          persistTranscriptTextElements();
          this.flushThoughtText();
          this.flushAssistantText();
          this.eventQueue.enqueue({ type: 'complete' });
          this.eventQueue.complete();
          this.debug(`Qwen prompt complete${stopReason ? ` (${stopReason})` : ''}`);
        })
        .catch((error) => {
          if (this.activePromptRunId !== promptRunId) return;
          if (this.abortReason) {
            persistTranscriptTextElements();
            this.eventQueue.complete();
            return;
          }
          const message = error instanceof Error ? error.message : String(error);
          persistTranscriptTextElements();
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
      this.currentThoughtText = '';
      this.currentIsSlashCommand = false;
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

    const sessionId = this.qwenSessionId;
    if (sessionId && this.connection) {
      await this.callAcp(
        'session/cancel',
        (connection) => connection.cancel({ sessionId }),
        5_000,
      ).catch((error) => {
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

    const sessionId = this.qwenSessionId;
    if (sessionId && this.connection) {
      void this.callAcp(
        'session/cancel',
        (connection) => connection.cancel({ sessionId }),
        5_000,
      ).catch((error) => {
        this.debug(`Qwen force cancel failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  respondToPermission(requestId: string, allowed: boolean, alwaysAllow?: boolean): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;

    this.pendingPermissions.delete(requestId);
    pending.resolve(this.createPermissionResponse(pending.options, allowed, !!alwaysAllow));
  }

  override setPermissionMode(mode: PermissionMode): void {
    this.hasInitialModeOverride = true;
    this.pendingModeOverride = mode;
    super.setPermissionMode(mode);
    void this.forwardPermissionMode(mode);
  }

  override cyclePermissionMode(): PermissionMode {
    this.hasInitialModeOverride = true;
    const mode = super.cyclePermissionMode();
    this.pendingModeOverride = mode;
    void this.forwardPermissionMode(mode);
    return mode;
  }

  override setModel(model: string): void {
    if (!this.isKnownAvailableModel(model)) {
      this.debug(`Ignoring Qwen model switch for unavailable model: ${model}`);
      return;
    }
    super.setModel(model);
    this.applyCurrentModelContextWindow(model);
    void this.forwardModel(model);
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

  async listSessions(options: BackendSessionListOptions = {}): Promise<BackendSessionListResult> {
    await this.ensureProcess();
    const response = await this.callAcp(
      'session/list',
      (connection) => connection.listSessions({
        cwd: options.cwd || this.resolvedCwd(),
        cursor: options.cursor,
        _meta: options.size && options.size > 0 ? { size: Math.floor(options.size) } : undefined,
      }),
      60_000,
    );

    return {
      nextCursor: response.nextCursor ?? undefined,
      sessions: response.sessions.map((session) => ({
        sessionId: session.sessionId,
        cwd: session.cwd,
        title: session.title,
        updatedAt: session.updatedAt,
      })),
    };
  }

  async deleteBackendSession(sessionId: string, options: { cwd?: string } = {}): Promise<boolean> {
    await this.ensureProcess();
    const result = toRecord(await this.callAcp(
      'ext/deleteSession',
      (connection) => connection.extMethod('deleteSession', {
        sessionId,
        cwd: options.cwd || this.resolvedCwd(),
      }),
      30_000,
    ));
    return result.success !== false;
  }

  async renameBackendSession(sessionId: string, title: string, options: { cwd?: string } = {}): Promise<boolean> {
    await this.ensureProcess();
    const result = toRecord(await this.callAcp(
      'ext/renameSession',
      (connection) => connection.extMethod('renameSession', {
        sessionId,
        title,
        cwd: options.cwd || this.resolvedCwd(),
      }),
      30_000,
    ));
    return result.success !== false;
  }

  async loadSessionMessages(sessionId: string, options: { cwd?: string } = {}): Promise<BackendSessionMessagesResult> {
    const cwd = options.cwd || this.resolvedCwd();
    await this.ensureProcess();

    const collector: HistoryCollector = { updates: [] };
    this.historyCollectors.set(sessionId, collector);

    try {
      await this.callAcp('session/load', (connection) => connection.loadSession({
        sessionId,
        cwd: options.cwd || this.resolvedCwd(),
        mcpServers: this.buildAcpMcpServers(),
      }), 60_000);

      const messages = this.buildHistoryMessages(sessionId, collector.updates, cwd);
      const availableCommandsSnapshot = this.extractAvailableCommandsSnapshot(collector.updates);
      const mergedMessages = this.mergeSlashCommandInvocationMessages(sessionId, messages, cwd);
      const messagesWithTextElements = this.applyQwenTranscriptTextElements(mergedMessages, sessionId, cwd);
      return {
        messages: messagesWithTextElements,
        ...(availableCommandsSnapshot ?? {}),
      };
    } finally {
      this.historyCollectors.delete(sessionId);
    }
  }

  async refreshAvailableCommands(): Promise<AvailableCommandsSnapshot | null> {
    this.debug(`Qwen slash command refresh requested (session=${this.qwenSessionId ?? this.persistedQwenSessionId ?? 'none'}, cwd=${this.resolvedCwd()})`);
    const hadLiveSessionBeforeRefresh = !!this.qwenSessionId;
    await this.ensureProcess();
    await this.ensureQwenSession();

    if (this.latestAvailableCommandsSnapshot) {
      this.debug(
        `Qwen slash command refresh using latest snapshot: commands=${this.latestAvailableCommandsSnapshot.availableCommands.length} ` +
        `skills=${this.latestAvailableCommandsSnapshot.availableSkills?.length ?? 0} ` +
        `names=${formatDebugNames(this.latestAvailableCommandsSnapshot.availableCommands.map(command => command.name))}`,
      );
      return this.latestAvailableCommandsSnapshot;
    }

    if (hadLiveSessionBeforeRefresh) {
      const reloadedSnapshot = await this.reloadCurrentSessionForAvailableCommands();
      if (reloadedSnapshot) {
        this.debug(
          `Qwen slash command refresh reused current session after reload: commands=${reloadedSnapshot.availableCommands.length} ` +
          `skills=${reloadedSnapshot.availableSkills?.length ?? 0} ` +
          `names=${formatDebugNames(reloadedSnapshot.availableCommands.map(command => command.name))}`,
        );
        return reloadedSnapshot;
      }
    }

    this.debug('Qwen slash command refresh waiting for available_commands_update');
    const snapshot = await this.waitForAvailableCommandsSnapshot();
    this.debug(snapshot
      ? `Qwen slash command refresh received after wait: commands=${snapshot.availableCommands.length} skills=${snapshot.availableSkills?.length ?? 0} names=${formatDebugNames(snapshot.availableCommands.map(command => command.name))}`
      : 'Qwen slash command refresh timed out waiting for available_commands_update');
    return snapshot;
  }

  async queryLlm(request: LLMQueryRequest): Promise<LLMQueryResult> {
    await this.ensureProcess();
    const sessionId = await this.createEphemeralSession();
    const collector: MiniCollector = { chunks: [] };
    this.miniCollectors.set(sessionId, collector);

    try {
      const model = request.model;
      if (model) {
        await this.callAcp('session/set_config_option', (connection) => connection.setSessionConfigOption({
          sessionId,
          configId: 'model',
          value: model,
        }), 10_000).catch((error) => {
          this.debug(`Qwen mini model switch failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }

      const prompt = this.buildQueryPrompt(request);
      await this.callAcp(
        'session/prompt',
        (connection) => connection.prompt({ sessionId, prompt: [{ type: 'text', text: prompt }] }),
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
      await this.deleteBackendSession(sessionId).catch((error) => {
        this.debug(`Qwen mini session cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }

  override destroy(): void {
    super.destroy();
    this.killSubprocess();
    this.pendingPermissions.clear();
    this.miniCollectors.clear();
    this.historyCollectors.clear();
  }

  // ============================================================
  // ACP process and SDK connection
  // ============================================================

  private async ensureProcess(): Promise<void> {
    if (
      this.subprocess
      && !this.subprocess.killed
      && this.connection
      && !this.connection.signal.aborted
      && this.initialized
    ) return;
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

    const commandDescription = `${command} ${args.join(' ')}`;
    this.debug(`Spawning Qwen ACP process: ${commandDescription}`);
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

      const connection = new ClientSideConnection(
        () => this.createAcpClient(),
        ndJsonStream(
          Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>,
          Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
        ),
      );
    this.connection = connection;

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      this.recordStderr(text);
      const trimmed = text.trim();
      if (trimmed) this.debug(`[qwen stderr] ${trimmed}`);
    });
    child.on('exit', (code, signal) => this.handleProcessExit(code, signal));
    child.on('error', (error) => {
      this.eventQueue.enqueue({ type: 'error', message: `Qwen ACP process error: ${error.message}` });
      this.eventQueue.complete();
    });

    void connection.closed.then(() => {
      if (this.connection !== connection) return;
      if (this.subprocess === child && !child.killed && child.exitCode === null) {
        child.kill();
      }
    });

    try {
      await this.withTimeout(connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
      }), 'initialize', qwenInitializeTimeoutMs());
      this.initialized = true;
    } catch (error) {
      if (this.subprocess === child) {
        this.killSubprocess();
      }
      const originalMessage = error instanceof Error ? error.message : String(error);
      const recentStderr = this.getRecentStderr().trim();
      const message = [
        originalMessage,
        `Qwen command: ${commandDescription}`,
        recentStderr ? `Recent Qwen stderr:\n${recentStderr}` : undefined,
      ].filter(Boolean).join('\n');
      const wrapped = new Error(message);
      (wrapped as Error & { cause?: unknown }).cause = error;
      throw wrapped;
    }
  }

  private buildSpawnCommand(qwenCliPath: string, nodePath: string): { command: string; args: string[] } {
    const args = ['--acp', '--channel=ACP'];

    if (qwenCliPath.endsWith('.js')) {
      return { command: nodePath, args: [qwenCliPath, ...args] };
    }

    return { command: qwenCliPath, args };
  }

  private createAcpClient(): Client {
    return {
      requestPermission: (params) => this.handlePermissionRequest(params),
      sessionUpdate: async (params) => {
        this.handleSessionUpdate(params);
      },
    };
  }

  private getAcpConnection(): ClientSideConnection {
    if (!this.connection || this.connection.signal.aborted || !this.subprocess || this.subprocess.killed) {
      throw new Error('Qwen ACP process is not running');
    }
    return this.connection;
  }

  private callAcp<T>(
    method: string,
    execute: (connection: ClientSideConnection) => Promise<T>,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    return this.withTimeout(execute(this.getAcpConnection()), method, timeoutMs);
  }

  private withTimeout<T>(
    promise: Promise<T>,
    method: string,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (timeoutMs <= 0) return promise;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`Qwen ACP request timed out: ${method}`));
      }, timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
      if (timeout) clearTimeout(timeout);
    });
  }

  private handleProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    const message = `Qwen ACP process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
    this.debug(message);
    this.initialized = false;
    this.subprocess = null;
    this.connection = null;

    this.cancelPendingPermissions();

    if (this._isProcessing && !this.abortReason) {
      this.eventQueue.enqueue({ type: 'error', message });
      this.eventQueue.enqueue({ type: 'complete' });
      this.eventQueue.complete();
    }
  }

  private killSubprocess(): void {
    this.connection = null;
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
      this.debug(`Qwen ACP session reuse: using live session ${this.qwenSessionId}`);
      await this.applySessionSettings(this.qwenSessionId);
      this.flushPendingAvailableCommandsUpdate(this.qwenSessionId);
      return;
    }

    if (this.ensureQwenSessionPromise) {
      this.debug('Qwen ACP session reuse: waiting for in-flight session setup');
      await this.ensureQwenSessionPromise;
      return;
    }

    this.ensureQwenSessionPromise = this.createOrLoadQwenSession();
    try {
      await this.ensureQwenSessionPromise;
    } finally {
      this.ensureQwenSessionPromise = null;
    }
  }

  private async createOrLoadQwenSession(): Promise<void> {
    if (this.qwenSessionId) {
      this.debug(`Qwen ACP session reuse: using live session ${this.qwenSessionId}`);
      await this.applySessionSettings(this.qwenSessionId);
      this.flushPendingAvailableCommandsUpdate(this.qwenSessionId);
      return;
    }

    const cwd = this.resolvedCwd();
    const mcpServers = this.buildAcpMcpServers();
    const existingSessionId = this.persistedQwenSessionId ?? this.config.session?.sdkSessionId;

    if (existingSessionId) {
      this.debug(`Qwen ACP session reuse: loading persisted session ${existingSessionId}`);
      this.suppressedSessionUpdates.add(existingSessionId);
      try {
        const result = toRecord(await this.callAcp('session/load', (connection) => connection.loadSession({
          sessionId: existingSessionId,
          cwd,
          mcpServers,
        }), 60_000));
        this.qwenSessionId = existingSessionId;
        this.persistedQwenSessionId = existingSessionId;
        this.recordSessionModels(result);
        this.recordSessionModes(result);
        this.config.onSdkSessionIdUpdate?.(existingSessionId);
        await this.applySessionSettings(existingSessionId);
        this.flushPendingAvailableCommandsUpdate(existingSessionId);
        return;
      } finally {
        this.suppressedSessionUpdates.delete(existingSessionId);
      }
    }

    this.debug('Qwen ACP session reuse: no existing session id, creating a new ACP session');
    const result = toRecord(await this.callAcp('session/new', (connection) => connection.newSession({
      cwd,
      mcpServers,
    }), 60_000));

    const sessionId = asString(result.sessionId);
    if (!sessionId) {
      throw new Error('Qwen ACP did not return a sessionId');
    }

    this.qwenSessionId = sessionId;
    this.persistedQwenSessionId = sessionId;
    this.recordSessionModels(result);
    this.recordSessionModes(result);
    this.config.onSdkSessionIdUpdate?.(sessionId);
    await this.applySessionSettings(sessionId);
    this.flushPendingAvailableCommandsUpdate(sessionId);
  }

  private async reloadCurrentSessionForAvailableCommands(): Promise<AvailableCommandsSnapshot | null> {
    const sessionId = this.qwenSessionId;
    if (!sessionId) return null;

    if (this._isProcessing) {
      this.debug(`Qwen slash command refresh did not reload session ${sessionId} because a prompt is active`);
      return null;
    }

    this.debug(`Qwen slash command refresh reloading existing ACP session ${sessionId} to request available_commands_update`);
    this.suppressedSessionUpdates.add(sessionId);
    try {
      const result = toRecord(await this.callAcp('session/load', (connection) => connection.loadSession({
        sessionId,
        cwd: this.resolvedCwd(),
        mcpServers: this.buildAcpMcpServers(),
      }), 60_000));
      this.recordSessionModels(result);
      this.recordSessionModes(result);
      await this.applySessionSettings(sessionId);
    } finally {
      this.suppressedSessionUpdates.delete(sessionId);
      this.flushPendingAvailableCommandsUpdate(sessionId);
    }
    return this.latestAvailableCommandsSnapshot;
  }

  private async createEphemeralSession(): Promise<string> {
    const result = toRecord(await this.callAcp('session/new', (connection) => connection.newSession({
      cwd: this.resolvedCwd(),
      mcpServers: [],
    }), 60_000));
    const sessionId = asString(result.sessionId);
    if (!sessionId) {
      throw new Error('Qwen ACP did not return a sessionId for mini completion');
    }
    this.recordSessionModels(result);
    return sessionId;
  }

  private recordSessionModels(result: JsonRecord): void {
    const modelState = toRecord(result.models);
    const availableModels = Array.isArray(modelState.availableModels)
      ? modelState.availableModels.map(toQwenModelDefinition).filter((model): model is ModelDefinition => !!model)
      : [];
    const currentModelId = asString(modelState.currentModelId);
    this.availableModelIds = new Set(availableModels.map(model => model.id));
    this.availableModelsById = new Map(availableModels.map(model => [model.id, model]));
    this.firstAvailableModelId = availableModels[0]?.id;
    const selectableCurrentModelId = currentModelId && this.availableModelIds.has(currentModelId)
      ? currentModelId
      : undefined;

    if ((!this._model || !this.isKnownAvailableModel(this._model)) && (selectableCurrentModelId || this.firstAvailableModelId)) {
      super.setModel(selectableCurrentModelId || this.firstAvailableModelId || '');
    }

    this.applyCurrentModelContextWindow();

    if (availableModels.length > 0) {
      this.config.onAvailableModelsUpdate?.(availableModels, currentModelId);
    }
  }

  private isKnownAvailableModel(model: string): boolean {
    return !this.availableModelIds || this.availableModelIds.size === 0 || this.availableModelIds.has(model);
  }

  private getCurrentModelContextWindow(model = this._model): number | undefined {
    return model ? this.availableModelsById.get(model)?.contextWindow : undefined;
  }

  private applyCurrentModelContextWindow(model = this._model): void {
    const contextWindow = this.getCurrentModelContextWindow(model);
    if (contextWindow) {
      this.usageTracker.setContextWindow(contextWindow);
    }
  }

  private recordSessionModes(result: JsonRecord): void {
    if (this.pendingModeOverride) return;

    const modeState = toRecord(result.modes);
    const currentModeId = asString(modeState.currentModeId);
    const mode = mapQwenModeToPermissionMode(currentModeId);

    if (!mode || mode === this.getPermissionMode()) return;

    this.applyAcpPermissionMode(mode);
  }

  private async forwardModel(
    model: string,
    sessionId = this.qwenSessionId,
    options: { persistDefault?: boolean } = {},
  ): Promise<void> {
    if (!model || !sessionId) return;
    if (!this.isKnownAvailableModel(model)) {
      this.debug(`Skipping Qwen model forward for unavailable model: ${model}`);
      return;
    }

    try {
      if (options.persistDefault ?? true) {
        await this.callAcp('session/set_model', (connection) => connection.unstable_setSessionModel({
          sessionId,
          modelId: model,
        }), 10_000);
      } else {
        await this.callAcp('session/set_config_option', (connection) => connection.setSessionConfigOption({
          sessionId,
          configId: 'model',
          value: model,
        }), 10_000);
      }
    } catch (error) {
      this.debug(`Qwen session/set_model failed: ${error instanceof Error ? error.message : String(error)}`);
      await this.callAcp('session/set_config_option', (connection) => connection.setSessionConfigOption({
        sessionId,
        configId: 'model',
        value: model,
      }), 10_000).catch((fallbackError) => {
        this.debug(`Qwen model config fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
      });
    }
  }

  private async applySessionSettings(sessionId: string): Promise<void> {
    if (this.hasInitialModeOverride) {
      await this.forwardPermissionMode(this.getPermissionMode(), sessionId);
    }

    if (this._model) {
      await this.forwardModel(this._model, sessionId, { persistDefault: false });
    }
  }

  private async forwardPermissionMode(mode: PermissionMode, sessionId = this.qwenSessionId): Promise<void> {
    if (!sessionId || !this.connection || this.connection.signal.aborted) return;
    try {
      await this.callAcp('session/set_mode', (connection) => connection.setSessionMode({
        sessionId,
        modeId: mapPermissionModeToQwen(mode),
      }), 10_000);
      if (this.pendingModeOverride === mode) {
        this.pendingModeOverride = null;
      }
    } catch (error) {
      this.debug(`Qwen mode switch failed: ${error instanceof Error ? error.message : String(error)}`);
      if (this.pendingModeOverride === mode) {
        this.pendingModeOverride = null;
      }
    }
  }

  private resolvedCwd(): string {
    return this.config.session?.workingDirectory
      || this.workingDirectory
      || this.config.workspace.rootPath
      || process.cwd();
  }

  private extractQwenRecordText(record: JsonRecord): string {
    const message = toRecord(record.message);
    const parts = Array.isArray(message.parts) ? message.parts.filter(isRecord) : [];
    return parts
      .map(part => asString(part.text))
      .filter((text): text is string => !!text)
      .join('\n\n');
  }

  private getQwenTranscriptPatchContent(record: JsonRecord): string {
    if (record.type === 'system' && record.subtype === 'slash_command') {
      const payload = toRecord(record.systemPayload);
      if (payload.phase === 'invocation') {
        return asString(payload.rawCommand) || '';
      }
    }
    return this.extractQwenRecordText(record);
  }

  private isPatchableQwenUserRecord(record: JsonRecord, sessionId: string): boolean {
    if (record.sessionId !== sessionId) return false;
    if (record.type === 'user') return true;
    if (record.type !== 'system' || record.subtype !== 'slash_command') return false;
    return toRecord(record.systemPayload).phase === 'invocation';
  }

  private persistQwenTranscriptTextElements(
    sessionId: string,
    cwd: string,
    sourceElements?: MessageTextElement[],
  ): void {
    const transcriptPath = getQwenTranscriptPath(sessionId, cwd);
    if (!existsSync(transcriptPath)) return;

    let fileContent: string;
    try {
      fileContent = readFileSync(transcriptPath, 'utf8');
    } catch (error) {
      this.debug(`Failed to read Qwen transcript for text elements: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }

    const hadTrailingNewline = fileContent.endsWith('\n');
    const lines = fileContent.split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop();

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (!line?.trim()) continue;

      let record: JsonRecord;
      try {
        record = JSON.parse(line) as JsonRecord;
      } catch {
        continue;
      }

      if (!this.isPatchableQwenUserRecord(record, sessionId)) continue;

      const content = this.getQwenTranscriptPatchContent(record);
      const textElements = buildQwenTranscriptTextElements(content, sourceElements);
      if (!textElements) return;

      const existing = JSON.stringify(record.textElements ?? null);
      const next = JSON.stringify(textElements);
      if (existing === next) return;

      record.textElements = textElements;
      lines[index] = JSON.stringify(record);

      const tmpPath = `${transcriptPath}.craft-text-elements-${process.pid}-${Date.now()}.tmp`;
      try {
        writeFileSync(tmpPath, lines.join('\n') + (hadTrailingNewline ? '\n' : ''), 'utf8');
        renameSync(tmpPath, transcriptPath);
        this.debug(`Wrote ${textElements.length} text element(s) into Qwen transcript ${transcriptPath}`);
      } catch (error) {
        this.debug(`Failed to write Qwen transcript text elements: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
  }

  private readQwenTranscriptTextElements(
    sessionId: string,
    cwd: string,
  ): Array<{ content: string; textElements: MessageTextElement[] }> {
    const transcriptPath = getQwenTranscriptPath(sessionId, cwd);
    if (!existsSync(transcriptPath)) return [];

    let fileContent: string;
    try {
      fileContent = readFileSync(transcriptPath, 'utf8');
    } catch {
      return [];
    }

    const records: Array<{ content: string; textElements: MessageTextElement[] }> = [];
    for (const line of fileContent.split(/\r?\n/)) {
      if (!line.trim()) continue;

      let record: JsonRecord;
      try {
        record = JSON.parse(line) as JsonRecord;
      } catch {
        continue;
      }

      if (!this.isPatchableQwenUserRecord(record, sessionId)) continue;
      const textElements = toQwenTranscriptTextElements(record.textElements);
      if (!textElements) continue;

      const content = this.getQwenTranscriptPatchContent(record);
      if (!content) continue;
      records.push({ content, textElements });
    }

    return records;
  }

  private applyQwenTranscriptTextElements(messages: Message[], sessionId: string, cwd: string): Message[] {
    const records = this.readQwenTranscriptTextElements(sessionId, cwd);
    if (records.length === 0) return messages;

    const remaining = [...records];
    for (const message of messages) {
      if (message.role !== 'user' || message.textElements?.length) continue;

      const index = remaining.findIndex(record => record.content === message.content);
      if (index < 0) continue;

      message.textElements = remaining[index]!.textElements;
      remaining.splice(index, 1);
    }

    return messages;
  }

  private buildAcpMcpServers(): McpServer[] {
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

  private buildPromptBlocks(message: string, attachments?: FileAttachment[]): ContentBlock[] {
    if (isSlashCommandPrompt(message, attachments)) {
      return [{ type: 'text', text: message.trim() }];
    }

    const textParts: string[] = [];
    const context = INCLUDE_CRAFT_CONTEXT_IN_QWEN_PROMPTS ? this.buildCraftContext() : '';

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
    const text = textParts.filter(Boolean).join('\n\n');
    const blocks: ContentBlock[] = [{
      type: 'text',
      text: context ? `${text}\n\n` : text,
    }];

    if (context) {
      blocks.push({
        type: 'resource',
        resource: {
          uri: `craft://agent-context/${encodeURIComponent(this._sessionId)}`,
          mimeType: 'text/plain',
          text: `<craft_agent_context>\n${context}\n</craft_agent_context>`,
        },
        _meta: {
          source: 'craft-agent',
          hiddenFromPromptDisplay: true,
        },
      });
    }

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

    const historyCollector = this.historyCollectors.get(sessionId);
    if (historyCollector) {
      historyCollector.updates.push(update);
      return;
    }

    if (update.sessionUpdate === 'available_commands_update') {
      this.handleOrStoreAvailableCommandsUpdate(sessionId, update);
      return;
    }

    if (this.suppressedSessionUpdates.has(sessionId)) return;
    if (sessionId !== this.qwenSessionId || !this._isProcessing) return;

    this.captureUsage(update);

    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.flushThoughtText();
        this.handleAgentMessageChunk(update);
        break;
      case 'agent_thought_chunk':
        this.flushAssistantText(true);
        this.handleAgentThoughtChunk(update);
        break;
      case 'tool_call':
        this.flushPendingTextAsIntermediate();
        this.handleToolCall(update);
        break;
      case 'tool_call_update':
        this.flushPendingTextAsIntermediate();
        this.handleToolCallUpdate(update);
        break;
      case 'plan':
        this.flushPendingTextAsIntermediate();
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

  private buildHistoryMessages(sessionId: string, updates: JsonRecord[], cwd: string): Message[] {
    const messages: Message[] = [];
    const toolMessages = new Map<string, Message>();
    let idCounter = 0;
    let fallbackTimestamp = Date.now();

    const nextId = () => `qwen-${sessionId}-${++idCounter}`;
    const timestampFor = (update: JsonRecord): number => {
      const meta = toRecord(update._meta);
      const timestamp = asNumber(meta.timestamp);
      if (timestamp != null) return timestamp;
      fallbackTimestamp += 1;
      return fallbackTimestamp;
    };

    const appendTextMessage = (
      role: 'user' | 'assistant',
      text: string,
      timestamp: number,
      isIntermediate?: boolean,
    ) => {
      if (!text) return;
      const messageText = role === 'assistant' ? normalizeQwenAssistantText(text) : text;
      const previous = messages[messages.length - 1];
      if (
        previous
        && previous.role === role
        && previous.timestamp === timestamp
        && !previous.toolUseId
        && previous.isIntermediate === isIntermediate
      ) {
        const nextContent = previous.content + text;
        previous.content = role === 'assistant'
          ? normalizeQwenAssistantText(nextContent)
          : nextContent;
        return;
      }

      const content = messageText;
      messages.push({
        id: nextId(),
        role,
        content,
        timestamp,
        isIntermediate,
      });
    };

    for (const update of updates) {
      const timestamp = timestampFor(update);
      const content = toRecord(update.content);
      const text = content.type === 'text' ? asString(content.text) : undefined;

      switch (update.sessionUpdate) {
        case 'user_message_chunk':
          appendTextMessage('user', text || '', timestamp);
          break;

        case 'agent_message_chunk':
          appendTextMessage('assistant', text || '', timestamp);
          break;

        case 'agent_thought_chunk':
          appendTextMessage('assistant', text || '', timestamp, true);
          break;

        case 'tool_call': {
          const toolUseId = asString(update.toolCallId) || `qwen-history-tool-${++idCounter}`;
          const rawInput = toRecord(update.rawInput);
          const meta = toRecord(update._meta);
          const kind = asString(update.kind);
          const toolName = normalizeToolName(asString(meta.toolName) || asString(update.title), kind);
          const toolMessage: Message = {
            id: nextId(),
            role: 'tool',
            content: `Running ${toolName}...`,
            timestamp,
            toolName,
            toolUseId,
            toolInput: rawInput,
            toolStatus: 'executing',
            toolIntent: asString(update.title),
            toolDisplayName: displayNameForTool(toolName, kind),
          };
          messages.push(toolMessage);
          toolMessages.set(toolUseId, toolMessage);
          break;
        }

        case 'tool_call_update': {
          const toolUseId = asString(update.toolCallId) || `qwen-history-tool-${++idCounter}`;
          const meta = toRecord(update._meta);
          const toolName = normalizeToolName(asString(meta.toolName), asString(update.kind));
          const result = this.formatToolResult(update);
          const isError = update.status === 'failed';
          const existing = toolMessages.get(toolUseId);

          if (existing) {
            existing.toolName = existing.toolName || toolName;
            existing.toolResult = result;
            existing.toolStatus = isError ? 'error' : 'completed';
            existing.isError = isError;
          } else {
            const toolMessage: Message = {
              id: nextId(),
              role: 'tool',
              content: '',
              timestamp,
              toolName,
              toolUseId,
              toolResult: result,
              toolStatus: isError ? 'error' : 'completed',
              isError,
            };
            messages.push(toolMessage);
            toolMessages.set(toolUseId, toolMessage);
          }
          break;
        }

        case 'plan': {
          const entries = Array.isArray(update.entries) ? update.entries : [];
          const todos = entries
            .filter(isRecord)
            .map((entry) => ({
              content: asString(entry.content) || '',
              status: mapPlanStatus(entry.status),
              activeForm: asString(entry.content) || '',
            }))
            .filter((todo) => todo.content);
          messages.push({
            id: nextId(),
            role: 'tool',
            content: 'Todo list updated',
            timestamp,
            toolName: 'TodoWrite',
            toolUseId: `qwen-history-plan-${idCounter}`,
            toolInput: { todos },
            toolResult: 'Todo list updated',
            toolStatus: 'completed',
            toolDisplayName: 'Todo List Updated',
          });
          break;
        }

        default:
          break;
      }
    }

    return messages;
  }

  private mergeSlashCommandInvocationMessages(sessionId: string, messages: Message[], cwd: string): Message[] {
    const slashMessages = this.loadSlashCommandInvocationMessages(sessionId, cwd);
    if (slashMessages.length === 0) return messages;

    const additions = slashMessages.filter((slashMessage) =>
      !messages.some((message) => this.isSameSlashCommandInvocationMessage(message, slashMessage)),
    );
    if (additions.length === 0) return messages;

    return [...messages, ...additions]
      .map((message, index) => ({ message, index }))
      .sort((a, b) => {
        const timestampDelta = a.message.timestamp - b.message.timestamp;
        if (timestampDelta !== 0) return timestampDelta;
        if (a.message.role === 'user' && b.message.role !== 'user') return -1;
        if (a.message.role !== 'user' && b.message.role === 'user') return 1;
        return a.index - b.index;
      })
      .map(({ message }) => message);
  }

  private isSameSlashCommandInvocationMessage(message: Message, slashMessage: Message): boolean {
    const messageContent = message.role === 'assistant'
      ? normalizeQwenAssistantText(message.content).trim()
      : message.content.trim();

    return message.role === slashMessage.role
      && messageContent === slashMessage.content.trim()
      && Math.abs(message.timestamp - slashMessage.timestamp) <= 10_000;
  }

  private loadSlashCommandInvocationMessages(sessionId: string, cwd: string): Message[] {
    const transcriptPath = getQwenTranscriptPath(sessionId, cwd);
    if (!existsSync(transcriptPath)) return [];

    const invocations = new Map<string, SlashCommandInvocation>();
    const seenResults = new Set<string>();
    const messages: Message[] = [];
    let idCounter = 0;

    try {
      const lines = readFileSync(transcriptPath, 'utf8').split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let record: JsonRecord;
        try {
          record = toRecord(JSON.parse(trimmed));
        } catch {
          continue;
        }

        if (record.type !== 'system' || record.subtype !== 'slash_command') continue;

        const payload = toRecord(record.systemPayload);
        const rawCommand = asString(payload.rawCommand)?.trim();
        if (!rawCommand) continue;

        const phase = asString(payload.phase);
        const timestamp = parseQwenTimestamp(record.timestamp) ?? Date.now();
        if (phase === 'invocation') {
          const uuid = asString(record.uuid);
          if (uuid) invocations.set(uuid, { rawCommand, timestamp });
          continue;
        }

        if (phase !== 'result') continue;

        const outputItems = Array.isArray(payload.outputHistoryItems) ? payload.outputHistoryItems : [];
        const outputTexts = outputItems
          .filter(isRecord)
          .map(formatQwenSlashOutputHistoryItem)
          .filter((text): text is string => !!text?.trim());
        if (outputTexts.length === 0) continue;

        const parentUuid = asString(record.parentUuid);
        const resultKey = parentUuid || `${rawCommand}:${timestamp}`;
        if (seenResults.has(resultKey)) continue;
        seenResults.add(resultKey);

        const invocation = parentUuid ? invocations.get(parentUuid) : undefined;
        const userContent = invocation?.rawCommand || rawCommand;
        messages.push({
          id: `qwen-${sessionId}-slash-${++idCounter}`,
          role: 'user',
          content: userContent,
          timestamp: invocation?.timestamp ?? timestamp,
        });
        messages.push({
          id: `qwen-${sessionId}-slash-${++idCounter}`,
          role: 'assistant',
          content: outputTexts.join('\n\n'),
          timestamp,
        });
      }
    } catch (error) {
      this.debug(`Failed to read Qwen slash command history from ${transcriptPath}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }

    return messages;
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

  private handleAgentThoughtChunk(update: JsonRecord): void {
    const content = toRecord(update.content);
    if (content.type !== 'text') return;
    const text = asString(content.text);
    if (!text) return;
    this.currentThoughtText += text;
    this.eventQueue.enqueue({
      type: 'text_delta',
      text,
      turnId: this.currentTurnId,
    });
  }

  private flushPendingTextAsIntermediate(): void {
    this.flushThoughtText();
    this.flushAssistantText(true);
  }

  private flushThoughtText(): void {
    if (!this.currentThoughtText) return;
    this.eventQueue.enqueue({
      type: 'text_complete',
      text: this.currentThoughtText,
      isIntermediate: true,
      turnId: this.currentTurnId,
    });
    this.currentThoughtText = '';
  }

  private flushAssistantText(isIntermediate?: boolean): void {
    if (!this.currentAssistantText) return;
    const text = normalizeQwenAssistantText(this.currentAssistantText, {
      forceJsonFence: this.currentIsSlashCommand,
    });
    this.eventQueue.enqueue({
      type: 'text_complete',
      text,
      ...(isIntermediate !== undefined ? { isIntermediate } : {}),
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
    this.applyAcpPermissionMode(mode);
  }

  private applyAcpPermissionMode(mode: PermissionMode): void {
    if (this.pendingModeOverride) {
      if (mode !== this.pendingModeOverride) return;
      this.pendingModeOverride = null;
    }

    if (mode === this.getPermissionMode()) return;
    this.permissionManager.setPermissionMode(mode);
    this.onPermissionModeChange?.(mode);
  }

  private parseAvailableCommandsUpdate(update: JsonRecord): AvailableCommandsSnapshot | null {
    const availableCommands = toAvailableSlashCommands(update.availableCommands);
    const meta = toRecord(update._meta);
    const availableSkills = toAvailableSkills(meta.availableSkills);

    if (availableCommands.length === 0 && (!availableSkills || availableSkills.length === 0)) {
      return null;
    }

    return { availableCommands, availableSkills };
  }

  private extractAvailableCommandsSnapshot(updates: JsonRecord[]): AvailableCommandsSnapshot | null {
    let latest: AvailableCommandsSnapshot | null = null;
    for (const update of updates) {
      if (update.sessionUpdate !== 'available_commands_update') continue;
      const snapshot = this.parseAvailableCommandsUpdate(update);
      if (snapshot) latest = snapshot;
    }

    if (latest) {
      this.latestAvailableCommandsSnapshot = latest;
      this.resolveAvailableCommandsWaiters(latest);
      this.debug(
        `Qwen loadSessionMessages captured available commands: commands=${latest.availableCommands.length} ` +
        `skills=${latest.availableSkills?.length ?? 0} ` +
        `names=${formatDebugNames(latest.availableCommands.map(command => command.name))} ` +
        `skillNames=${formatDebugNames(latest.availableSkills)}`,
      );
    }

    return latest;
  }

  private handleAvailableCommandsUpdate(update: JsonRecord): void {
    const snapshot = this.parseAvailableCommandsUpdate(update);

    if (!snapshot) {
      this.debug('Qwen available_commands_update ignored because it contained no commands or skills');
      return;
    }

    this.debug(
      `Qwen available_commands_update parsed: commands=${snapshot.availableCommands.length} ` +
      `skills=${snapshot.availableSkills?.length ?? 0} ` +
      `names=${formatDebugNames(snapshot.availableCommands.map(command => command.name))} ` +
      `skillNames=${formatDebugNames(snapshot.availableSkills)}`,
    );

    this.latestAvailableCommandsSnapshot = snapshot;
    this.resolveAvailableCommandsWaiters(snapshot);

    this.eventQueue.enqueue({
      type: 'available_commands_update',
      availableCommands: snapshot.availableCommands,
      availableSkills: snapshot.availableSkills,
    });
  }

  private handleOrStoreAvailableCommandsUpdate(sessionId: string, update: JsonRecord): void {
    if (
      sessionId === this.qwenSessionId
      && !this.suppressedSessionUpdates.has(sessionId)
    ) {
      this.debug(`Qwen available_commands_update received for active session ${sessionId}`);
      this.handleAvailableCommandsUpdate(update);
      return;
    }

    this.debug(
      `Qwen available_commands_update buffered: updateSession=${sessionId} ` +
      `currentSession=${this.qwenSessionId ?? 'none'} ` +
      `suppressed=${this.suppressedSessionUpdates.has(sessionId)}`,
    );
    this.pendingAvailableCommandsUpdates.set(sessionId, update);
  }

  private flushPendingAvailableCommandsUpdate(sessionId: string): void {
    const update = this.pendingAvailableCommandsUpdates.get(sessionId);
    if (!update) return;
    this.pendingAvailableCommandsUpdates.delete(sessionId);
    this.debug(`Qwen available_commands_update flushing buffered update for session ${sessionId}`);
    this.handleAvailableCommandsUpdate(update);
  }

  private waitForAvailableCommandsSnapshot(timeoutMs = 2_000): Promise<AvailableCommandsSnapshot | null> {
    if (this.latestAvailableCommandsSnapshot) {
      return Promise.resolve(this.latestAvailableCommandsSnapshot);
    }

    return new Promise(resolve => {
      let settled = false;
      const waiter = (snapshot: AvailableCommandsSnapshot | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.availableCommandsWaiters = this.availableCommandsWaiters.filter(item => item !== waiter);
        resolve(snapshot);
      };
      const timeout = setTimeout(() => {
        this.debug(`Qwen slash command refresh wait timed out after ${timeoutMs}ms`);
        waiter(null);
      }, timeoutMs);
      this.availableCommandsWaiters.push(waiter);
    });
  }

  private resolveAvailableCommandsWaiters(snapshot: AvailableCommandsSnapshot | null): void {
    const waiters = this.availableCommandsWaiters.splice(0);
    if (waiters.length > 0) {
      this.debug(`Qwen resolving ${waiters.length} slash command refresh waiter(s)`);
    }
    for (const resolve of waiters) {
      resolve(snapshot);
    }
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
    const contextWindow = this.getCurrentModelContextWindow();
    this.eventQueue.enqueue({
      type: 'usage_update',
      usage: {
        inputTokens: usage.inputTokens,
        ...(contextWindow ? { contextWindow } : {}),
      },
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

  private handlePermissionRequest(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const record = toRecord(params);
    const toolCall = toRecord(record.toolCall);
    const options = Array.isArray(record.options)
      ? record.options.filter(isRecord) as AcpPermissionOption[]
      : [];

    const kind = asString(toolCall.kind);
    const rawInput = toRecord(toolCall.rawInput);
    const title = asString(toolCall.title) || 'Qwen Code requests permission';
    const toolName = normalizeToolName(asString(toRecord(toolCall._meta).toolName) || title, kind);
    const command = asString(rawInput.command) || asString(rawInput.cmd);

    if (!this.onPermissionRequest) {
      const autoAllow = this.getPermissionMode() === 'allow-all';
      return Promise.resolve(this.createPermissionResponse(options, autoAllow, autoAllow));
    }

    return new Promise<RequestPermissionResponse>((resolve) => {
      const requestId = `qwen-permission-${++this.permissionRequestCounter}`;
      this.pendingPermissions.set(requestId, { resolve, options });

      try {
        this.onPermissionRequest?.({
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
        this.pendingPermissions.delete(requestId);
        resolve(this.createPermissionResponse(options, false, false));
      }
    });
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

  private createPermissionResponse(
    options: AcpPermissionOption[],
    allowed: boolean,
    alwaysAllow: boolean,
  ): RequestPermissionResponse {
    if (!allowed) {
      return { outcome: { outcome: 'cancelled' } };
    }

    return {
      outcome: {
        outcome: 'selected',
        optionId: this.selectPermissionOption(options, alwaysAllow),
      },
    };
  }

  private cancelPendingPermissions(): void {
    for (const [, pending] of this.pendingPermissions) {
      pending.resolve(this.createPermissionResponse(pending.options, false, false));
    }
    this.pendingPermissions.clear();
  }

  protected override debug(message: string): void {
    this.onDebug?.(`[QwenAgent] ${message}`);
  }
}

export { QwenAgent as QwenBackend };
