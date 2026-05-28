/* eslint-disable import/no-internal-modules */
/**
 * Qwen Code Backend (ACP SDK Client)
 *
 * Spawns Qwen Code in ACP mode and adapts ACP session updates into Craft's
 * provider-agnostic AgentEvent stream.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, platform, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

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
} from '@agentclientprotocol/sdk'
import type {
  AgentEvent,
  AskUserQuestionItem,
  AvailableSkillDetail,
  AvailableSlashCommand,
  IntermediateMessageKind,
  Message,
  MessageTextElement,
} from '@craft-agent/core/types'
import { utf16IndexToByteOffset } from '@craft-agent/core/utils'
import type { FileAttachment } from '../utils/files.ts'
import type { ModelDefinition } from '../config/models.ts'
import { getProxyEnvVars } from '../config/proxy-env.ts'
import { getCoAuthorPreference } from '../config/preferences.ts'
import { getSessionPlansPath } from '../sessions/storage.ts'
import { getSystemPrompt } from '../prompts/system.ts'
import {
  resolveFileMentions,
  resolveSourceMentions,
} from '../mentions/index.ts'
import { isParentTaskTool } from '../utils/toolNames.ts'

import { BaseAgent } from './base-agent.ts'
import type {
  BackendConfig,
  BackendSessionMessagesResult,
  AvailableCommandsSnapshot,
  BackendSessionListOptions,
  BackendSessionListResult,
  BackendRewindResult,
  ChatOptions,
  BackendHostRuntimeContext,
  PermissionRequestType,
  SdkMcpServerConfig,
} from './backend/types.ts'
import { AbortReason } from './backend/types.ts'
import { getBackendRuntime } from './backend/internal/driver-types.ts'
import { withElectronRunAsNodeEnv } from './backend/internal/electron-run-as-node.ts'
import { resolveBackendRuntimePaths } from './backend/internal/runtime-resolver.ts'
import { EventQueue } from './backend/event-queue.ts'
import type { PermissionMode } from './mode-manager.ts'
import {
  LLM_QUERY_TIMEOUT_MS,
  type LLMQueryRequest,
  type LLMQueryResult,
} from './llm-tool.ts'
import type {
  PermissionResponseOptions,
  PermissionRuleType,
  PermissionSettingsScope,
  QwenCoreSettingKey,
  QwenCoreSettingsSnapshot,
  QwenHookDefinition,
  QwenHookEvent,
  QwenMcpServerConfig,
  QwenPermissionSettings,
  QwenProviderCatalog,
  QwenProviderConnectParams,
  QwenProviderConnectResult,
  QwenSettingValue,
  QwenSettingsScope,
  QwenSkillDeleteRequest,
  QwenSkillDeleteResult,
  QwenSkillInstallRequest,
  QwenSkillInstallResult,
  QwenSkillSetEnabledRequest,
  QwenSkillSetEnabledResult,
} from '../protocol/dto.ts'
import type {
  QwenMemoryPaths,
  QwenMemorySettings,
} from '../config/qwen-settings.ts'
import { normalizeQwenMemorySettings } from '../config/qwen-settings.ts'

type JsonRecord = Record<string, unknown>

type AcpPermissionOption = {
  optionId?: string
  name?: string
  kind?: string
}

type PendingPermission = {
  resolve: (
    response: RequestPermissionResponse & { answers?: Record<string, string> },
  ) => void
  options: AcpPermissionOption[]
}

type MiniCollector = {
  chunks: string[]
  inputTokens?: number
  outputTokens?: number
}

type ExtractedUsage = {
  inputTokens: number
  contextTokens: number
  outputTokens?: number
}

type HistoryCollector = {
  updates: JsonRecord[]
}

type SlashCommandInvocation = {
  rawCommand: string
  timestamp: number
}

const MID_TURN_QUEUE_DRAIN_METHOD = 'craft/drainMidTurnQueue'
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_INITIALIZE_TIMEOUT_MS = 60_000
const INCLUDE_CRAFT_CONTEXT_IN_QWEN_PROMPTS = false
const SHARED_ACP_IDLE_TTL_MS = 5 * 60_000

type QwenAcpSubscriber = {
  onSessionUpdate(params: unknown): void
  onPermissionRequest(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse>
  onExtMethod(method: string, params: JsonRecord): Promise<JsonRecord>
  onProcessExit(code: number | null, signal: NodeJS.Signals | null): void
  onDebug(message: string): void
}

type QwenAcpProcessOptions = {
  key: string
  command: string
  args: string[]
  cwd: string
  envOverrides?: Record<string, string>
}

type QwenAcpLease = {
  connection: ClientSideConnection
  commandDescription: string
  recentStderr(): string
  isActive(): boolean
  registerSession(sessionId: string): void
  unregisterSession(sessionId: string): void
  release(): void
}

const sharedAcpProcesses = new Map<string, SharedQwenAcpProcess>()

function stableStringifyRecord(
  value: Record<string, string | undefined>,
): string {
  return JSON.stringify(
    Object.keys(value)
      .sort()
      .reduce<Record<string, string>>((acc, key) => {
        const item = value[key]
        if (item !== undefined) acc[key] = item
        return acc
      }, {}),
  )
}

function buildSharedAcpProcessKey(args: {
  command: string
  spawnArgs: string[]
  workspaceRootPath: string
  envOverrides?: Record<string, string>
}): string {
  return [
    args.command,
    args.spawnArgs.join('\u0000'),
    args.workspaceRootPath,
    stableStringifyRecord(args.envOverrides ?? {}),
  ].join('\u0001')
}

async function acquireSharedQwenAcpProcess(
  options: QwenAcpProcessOptions,
  subscriber: QwenAcpSubscriber,
): Promise<QwenAcpLease> {
  let processEntry = sharedAcpProcesses.get(options.key)
  if (!processEntry) {
    processEntry = new SharedQwenAcpProcess(options)
    sharedAcpProcesses.set(options.key, processEntry)
  }
  return processEntry.acquire(subscriber)
}

class SharedQwenAcpProcess {
  private child: ChildProcess | null = null
  private connection: ClientSideConnection | null = null
  private startPromise: Promise<void> | null = null
  private initialized = false
  private subscribers = new Set<QwenAcpSubscriber>()
  private sessionOwners = new Map<string, QwenAcpSubscriber>()
  private refCount = 0
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private stderrBuffer: string[] = []
  private stderrBufferBytes = 0
  private readonly commandDescription: string
  private static readonly STDERR_BUFFER_MAX_BYTES = 8 * 1024

  constructor(private readonly options: QwenAcpProcessOptions) {
    this.commandDescription = `${options.command} ${options.args.join(' ')}`
  }

  async acquire(subscriber: QwenAcpSubscriber): Promise<QwenAcpLease> {
    this.refCount += 1
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
    this.subscribers.add(subscriber)

    try {
      await this.ensureStarted()
    } catch (error) {
      this.releaseSubscriber(subscriber)
      throw error
    }

    const lease: QwenAcpLease = {
      connection: this.ensureConnection(),
      commandDescription: this.commandDescription,
      recentStderr: () => this.stderrBuffer.join(''),
      isActive: () => this.isActive(),
      registerSession: (sessionId) => {
        this.sessionOwners.set(sessionId, subscriber)
      },
      unregisterSession: (sessionId) => {
        if (this.sessionOwners.get(sessionId) === subscriber) {
          this.sessionOwners.delete(sessionId)
        }
      },
      release: () => this.releaseSubscriber(subscriber),
    }
    return lease
  }

  private async ensureStarted(): Promise<void> {
    if (this.isActive()) return
    if (this.startPromise) {
      await this.startPromise
      return
    }

    this.startPromise = this.start()
    try {
      await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  private async start(): Promise<void> {
    this.debug(`Spawning shared Qwen ACP process: ${this.commandDescription}`)
    this.stderrBuffer = []
    this.stderrBufferBytes = 0

    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: this.buildEnv(),
      shell: false,
    })

    this.child = child
    this.initialized = false

    const connection = new ClientSideConnection(
      () => this.createAcpClient(),
      ndJsonStream(
        Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
      ),
    )
    this.connection = connection

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString()
      this.recordStderr(text)
      const trimmed = text.trim()
      if (trimmed) this.debug(`[qwen stderr] ${trimmed}`)
    })
    child.on('exit', (code, signal) => this.handleExit(code, signal))
    child.on('error', (error) => {
      this.debug(`Qwen ACP process error: ${error.message}`)
    })

    void connection.closed.then(() => {
      if (this.connection !== connection) return
      if (this.child === child && !child.killed && child.exitCode === null) {
        child.kill()
      }
    })

    try {
      await this.withTimeout(
        connection.initialize({
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
        }),
        'initialize',
        qwenInitializeTimeoutMs(),
      )
      this.initialized = true
    } catch (error) {
      this.kill()
      throw error
    }
  }

  private buildEnv(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...getProxyEnvVars(),
      ...this.options.envOverrides,
    }
    delete env.CRAFT_SESSION_DIR
    return withElectronRunAsNodeEnv(
      env,
      this.options.command,
      this.options.args,
    )
  }

  private createAcpClient(): Client {
    return {
      requestPermission: async (params) => {
        const sessionId = asString(toRecord(params).sessionId)
        const owner = sessionId ? this.sessionOwners.get(sessionId) : undefined
        if (owner) return owner.onPermissionRequest(params)

        this.debug(
          `Qwen permission request had no owner for session ${sessionId ?? 'unknown'}`,
        )
        return { outcome: { outcome: 'cancelled' } }
      },
      sessionUpdate: async (params) => {
        for (const subscriber of [...this.subscribers]) {
          subscriber.onSessionUpdate(params)
        }
      },
      extMethod: async (method, params) => {
        const record = toRecord(params)
        const sessionId = asString(record.sessionId)
        const owner = sessionId ? this.sessionOwners.get(sessionId) : undefined
        if (owner) return owner.onExtMethod(method, record)

        for (const subscriber of [...this.subscribers]) {
          const result = await subscriber.onExtMethod(method, record)
          if (Object.keys(result).length > 0) return result
        }
        return method === MID_TURN_QUEUE_DRAIN_METHOD ? { messages: [] } : {}
      },
    }
  }

  private ensureConnection(): ClientSideConnection {
    if (
      !this.connection ||
      this.connection.signal.aborted ||
      !this.isActive()
    ) {
      throw new Error('Qwen ACP process is not running')
    }
    return this.connection
  }

  private isActive(): boolean {
    return !!(
      this.child &&
      !this.child.killed &&
      this.child.exitCode === null &&
      this.connection &&
      !this.connection.signal.aborted &&
      this.initialized
    )
  }

  private releaseSubscriber(subscriber: QwenAcpSubscriber): void {
    if (this.subscribers.delete(subscriber)) {
      this.refCount = Math.max(0, this.refCount - 1)
    }
    for (const [sessionId, owner] of [...this.sessionOwners]) {
      if (owner === subscriber) this.sessionOwners.delete(sessionId)
    }
    if (this.refCount === 0 && !this.idleTimer) {
      this.idleTimer = setTimeout(() => {
        if (this.refCount > 0) return
        sharedAcpProcesses.delete(this.options.key)
        this.kill()
      }, SHARED_ACP_IDLE_TTL_MS)
    }
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.debug(
      `Qwen ACP process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
    )
    this.initialized = false
    this.child = null
    this.connection = null
    sharedAcpProcesses.delete(this.options.key)
    for (const subscriber of [...this.subscribers]) {
      subscriber.onProcessExit(code, signal)
    }
  }

  private kill(): void {
    this.connection = null
    if (this.child && !this.child.killed) {
      this.child.kill()
    }
    this.child = null
    this.initialized = false
  }

  private recordStderr(chunk: string): void {
    if (!chunk) return
    const effective =
      chunk.length > SharedQwenAcpProcess.STDERR_BUFFER_MAX_BYTES
        ? chunk.slice(
            chunk.length - SharedQwenAcpProcess.STDERR_BUFFER_MAX_BYTES,
          )
        : chunk
    this.stderrBuffer.push(effective)
    this.stderrBufferBytes += effective.length
    while (
      this.stderrBufferBytes > SharedQwenAcpProcess.STDERR_BUFFER_MAX_BYTES &&
      this.stderrBuffer.length > 1
    ) {
      const dropped = this.stderrBuffer.shift()!
      this.stderrBufferBytes -= dropped.length
    }
  }

  private withTimeout<T>(
    promise: Promise<T>,
    method: string,
    timeoutMs: number,
  ): Promise<T> {
    if (timeoutMs <= 0) return promise

    let timeout: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`Qwen ACP request timed out: ${method}`))
      }, timeoutMs)
    })

    return Promise.race([promise, timeoutPromise]).finally(() => {
      if (timeout) clearTimeout(timeout)
    })
  }

  private debug(message: string): void {
    for (const subscriber of [...this.subscribers]) {
      subscriber.onDebug(message)
    }
  }
}

type QwenSettingsAcpOptions = {
  hostRuntime: BackendHostRuntimeContext
  cwd?: string
  envOverrides?: Record<string, string>
  timeoutMs?: number
  debug?: (message: string) => void
}

function buildQwenAcpSpawnCommand(
  qwenCliPath: string,
  nodePath: string,
): { command: string; args: string[] } {
  const args = ['--acp', '--channel=desktop']

  if (qwenCliPath.endsWith('.js')) {
    return { command: nodePath, args: [qwenCliPath, ...args] }
  }

  return { command: qwenCliPath, args }
}

function qwenSettingsCwd(hostRuntime: BackendHostRuntimeContext): string {
  return hostRuntime.appRootPath || homedir() || process.cwd()
}

function qwenAcpWithTimeout<T>(
  promise: Promise<T>,
  method: string,
  timeoutMs: number,
): Promise<T> {
  if (timeoutMs <= 0) return promise

  let timeout: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`Qwen ACP request timed out: ${method}`))
    }, timeoutMs)
  })

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout)
  })
}

async function callQwenSettingsAcpMethod(
  options: QwenSettingsAcpOptions,
  method: string,
  params: JsonRecord = {},
): Promise<JsonRecord> {
  const resolvedPaths = resolveBackendRuntimePaths(options.hostRuntime)
  const qwenCliPath = resolvedPaths.qwenCliPath
  if (!qwenCliPath) {
    throw new Error(
      'Qwen Code CLI not found. Build the current qwen-code checkout with npm run build && npm run bundle, or set QWEN_CODE_CLI to a dist/cli.js path.',
    )
  }

  const nodePath = resolvedPaths.nodeRuntimePath || process.execPath
  const { command, args } = buildQwenAcpSpawnCommand(qwenCliPath, nodePath)
  const cwd = options.cwd || qwenSettingsCwd(options.hostRuntime)
  const key = buildSharedAcpProcessKey({
    command,
    spawnArgs: args,
    workspaceRootPath: cwd,
    envOverrides: options.envOverrides,
  })

  const lease = await acquireSharedQwenAcpProcess(
    {
      key,
      command,
      args,
      cwd,
      envOverrides: options.envOverrides,
    },
    {
      onSessionUpdate: () => {},
      onPermissionRequest: async () => ({ outcome: { outcome: 'cancelled' } }),
      onExtMethod: async (extMethod) =>
        extMethod === MID_TURN_QUEUE_DRAIN_METHOD ? { messages: [] } : {},
      onProcessExit: () => {},
      onDebug: options.debug ?? (() => {}),
    },
  )

  try {
    return toRecord(
      await qwenAcpWithTimeout(
        lease.connection.extMethod(method, params),
        method,
        options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      ),
    )
  } finally {
    lease.release()
  }
}

export async function getQwenMemorySettingsViaAcp(
  options: QwenSettingsAcpOptions,
): Promise<QwenMemorySettings> {
  const response = await callQwenSettingsAcpMethod(
    options,
    'qwen/settings/getMemory',
  )
  return normalizeQwenMemorySettings(response.settings)
}

export async function setQwenMemorySettingsViaAcp(
  options: QwenSettingsAcpOptions,
  updates: Partial<QwenMemorySettings>,
): Promise<QwenMemorySettings> {
  const response = await callQwenSettingsAcpMethod(
    options,
    'qwen/settings/setMemory',
    { updates },
  )
  return normalizeQwenMemorySettings(response.settings)
}

export async function getQwenSettingsPathViaAcp(
  options: QwenSettingsAcpOptions,
): Promise<string> {
  const response = await callQwenSettingsAcpMethod(
    options,
    'qwen/settings/getPath',
  )
  const settingsPath = asString(response.path)
  if (!settingsPath) throw new Error('Qwen ACP did not return settings path')
  return settingsPath
}

export async function getQwenCoreSettingsViaAcp(
  options: QwenSettingsAcpOptions,
): Promise<QwenCoreSettingsSnapshot> {
  const cwd = options.cwd || qwenSettingsCwd(options.hostRuntime)
  const response = await callQwenSettingsAcpMethod(
    { ...options, cwd },
    'qwen/settings/getCore',
    { cwd },
  )
  return response as unknown as QwenCoreSettingsSnapshot
}

export async function setQwenCoreSettingViaAcp(
  options: QwenSettingsAcpOptions,
  scope: QwenSettingsScope,
  key: QwenCoreSettingKey,
  value: QwenSettingValue,
): Promise<QwenCoreSettingsSnapshot> {
  const cwd = options.cwd || qwenSettingsCwd(options.hostRuntime)
  const response = await callQwenSettingsAcpMethod(
    { ...options, cwd },
    'qwen/settings/setCoreValue',
    { cwd, scope, key, value },
  )
  return response as unknown as QwenCoreSettingsSnapshot
}

export async function getQwenMemoryPathsViaAcp(
  options: QwenSettingsAcpOptions & { projectRoot?: string },
): Promise<QwenMemoryPaths> {
  const cwd = options.cwd || qwenSettingsCwd(options.hostRuntime)
  const response = await callQwenSettingsAcpMethod(
    { ...options, cwd },
    'qwen/settings/getMemoryPaths',
    { cwd, projectRoot: options.projectRoot ?? cwd },
  )
  const paths = toRecord(response.paths)
  const userMemoryFile = asString(paths.userMemoryFile)
  const projectMemoryFile = asString(paths.projectMemoryFile)
  const autoMemoryDir = asString(paths.autoMemoryDir)
  if (!userMemoryFile || !projectMemoryFile || !autoMemoryDir) {
    throw new Error('Qwen ACP did not return memory paths')
  }
  return { userMemoryFile, projectMemoryFile, autoMemoryDir }
}

export async function listQwenProvidersViaAcp(
  options: QwenSettingsAcpOptions,
): Promise<QwenProviderCatalog> {
  const response = await callQwenSettingsAcpMethod(
    options,
    'qwen/providers/list',
  )
  return normalizeQwenProviderCatalog(response)
}

function normalizeQwenProviderCatalog(
  response: JsonRecord,
): QwenProviderCatalog {
  return {
    providers: Array.isArray(response.providers)
      ? (response.providers as QwenProviderCatalog['providers'])
      : [],
  }
}

export async function connectQwenProviderViaAcp(
  options: QwenSettingsAcpOptions,
  params: QwenProviderConnectParams,
): Promise<QwenProviderConnectResult> {
  const response = await callQwenSettingsAcpMethod(
    options,
    'qwen/providers/connect',
    params as unknown as JsonRecord,
  )
  return normalizeQwenProviderConnectResult(response)
}

function normalizeQwenProviderConnectResult(
  response: JsonRecord,
): QwenProviderConnectResult {
  const error = asString(response.error)
  const providerId = asString(response.providerId)
  const providerLabel = asString(response.providerLabel)
  const authType = asString(response.authType)
  const modelId = asString(response.modelId)
  return {
    success: response.success === true,
    ...(error ? { error } : {}),
    ...(providerId ? { providerId } : {}),
    ...(providerLabel ? { providerLabel } : {}),
    ...(authType ? { authType } : {}),
    ...(modelId ? { modelId } : {}),
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function extractQwenParentToolUseId(
  update: Record<string, unknown>,
): string | undefined {
  const meta = toRecord(update._meta)
  return (
    asString(update.parentToolCallId) ||
    asString(update.parentToolUseId) ||
    asString(update.parent_tool_use_id) ||
    asString(meta.parentToolCallId) ||
    asString(meta.parentToolUseId) ||
    asString(meta.parent_tool_use_id)
  )
}

export function resolveQwenParentToolUseId(args: {
  update: Record<string, unknown>
  toolUseId?: string
  activeParentToolUseIds?: ReadonlySet<string>
}): string | undefined {
  const explicitParentToolUseId = extractQwenParentToolUseId(args.update)
  if (explicitParentToolUseId && explicitParentToolUseId !== args.toolUseId) {
    return explicitParentToolUseId
  }

  const activeParentToolUseIds = args.activeParentToolUseIds
  if (activeParentToolUseIds?.size === 1) {
    const [activeParentToolUseId] = activeParentToolUseIds
    if (activeParentToolUseId !== args.toolUseId) {
      return activeParentToolUseId
    }
  }

  return undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0)
    return value
  if (typeof value !== 'string') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function parseAskUserQuestions(
  value: unknown,
): AskUserQuestionItem[] | undefined {
  if (!Array.isArray(value)) return undefined

  const questions = value
    .filter(isRecord)
    .map((question) => {
      const options = Array.isArray(question.options)
        ? question.options
            .filter(isRecord)
            .map((option) => ({
              label: asString(option.label) || '',
              description: asString(option.description) || '',
            }))
            .filter((option) => option.label)
        : []

      return {
        question: asString(question.question) || '',
        header: asString(question.header) || '',
        options,
        ...(asBoolean(question.multiSelect) !== undefined
          ? { multiSelect: asBoolean(question.multiSelect) }
          : {}),
      }
    })
    .filter(
      (question) =>
        question.question && question.header && question.options.length > 0,
    )

  return questions.length > 0 ? questions : undefined
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const number = asNumber(value)
    if (number !== undefined) return number
  }
  return undefined
}

function firstBoolean(...values: unknown[]): boolean | undefined {
  for (const value of values) {
    const bool = asBoolean(value)
    if (bool !== undefined) return bool
  }
  return undefined
}

function toQwenModelDefinition(value: unknown): ModelDefinition | null {
  const model = toRecord(value as ModelInfo)
  const id = asString(model.modelId)
  if (!id) return null
  const name = asString(model.name) || id
  const meta = toRecord(model._meta)
  const generationConfig = toRecord(model.generationConfig)
  const metaGenerationConfig = toRecord(meta.generationConfig)
  const extraBody = toRecord(generationConfig.extra_body)
  const metaExtraBody = toRecord(metaGenerationConfig.extra_body)
  const capabilities = toRecord(model.capabilities)
  const limits = toRecord(capabilities.limits)
  const metaCapabilities = toRecord(meta.capabilities)
  const metaLimits = toRecord(metaCapabilities.limits)
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
  )
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
  )

  return {
    id,
    name,
    shortName: name,
    description: asString(model.description) || '',
    provider: 'qwen',
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(supportsThinking !== undefined ? { supportsThinking } : {}),
  }
}

function toRecord(value: unknown): JsonRecord {
  return isRecord(value) ? value : {}
}

function toAvailableSlashCommands(value: unknown): AvailableSlashCommand[] {
  if (!Array.isArray(value)) return []

  const seen = new Set<string>()
  const commands: AvailableSlashCommand[] = []

  for (const item of value) {
    const record = toRecord(item)
    const rawName = asString(record.name)?.trim().replace(/^\/+/, '')
    if (!rawName || seen.has(rawName)) continue

    seen.add(rawName)
    const input =
      record.input === null || isRecord(record.input) ? record.input : undefined

    commands.push({
      name: rawName,
      description: asString(record.description),
      ...(input !== undefined && { input }),
    })
  }

  return commands
}

function toAvailableSkills(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined

  const seen = new Set<string>()
  const skills: string[] = []

  for (const item of value) {
    const name = asString(item)?.trim().replace(/^\/+/, '')
    if (!name || seen.has(name)) continue
    seen.add(name)
    skills.push(name)
  }

  return skills.length > 0 ? skills : undefined
}

function toAvailableSkillDetails(
  value: unknown,
): AvailableSkillDetail[] | undefined {
  if (!Array.isArray(value)) return undefined

  const seen = new Set<string>()
  const details: AvailableSkillDetail[] = []

  for (const item of value) {
    const record = toRecord(item)
    const name = asString(record.name)?.trim().replace(/^\/+/, '')
    if (!name || seen.has(name)) continue
    seen.add(name)

    const description = asString(record.description)
    const body = asString(record.body)
    const filePath = asString(record.filePath)
    const level = asString(record.level)
    const modelInvocable = asBoolean(record.modelInvocable)

    details.push({
      name,
      ...(description !== undefined && { description }),
      ...(body !== undefined && { body }),
      ...(filePath !== undefined && { filePath }),
      ...(level !== undefined && { level }),
      ...(modelInvocable !== undefined && { modelInvocable }),
    })
  }

  return details.length > 0 ? details : undefined
}

function formatDebugNames(values: string[] | undefined, max = 40): string {
  if (!values || values.length === 0) return 'none'
  const visible = values.slice(0, max).join(', ')
  return values.length > max
    ? `${visible}, ... +${values.length - max} more`
    : visible
}

function parseQwenTimestamp(value: unknown): number | undefined {
  const raw = asString(value)
  if (!raw) return undefined
  const timestamp = Date.parse(raw)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function sanitizeQwenCwd(cwd: string): string {
  const normalizedCwd = platform() === 'win32' ? cwd.toLowerCase() : cwd
  return normalizedCwd.replace(/[^a-zA-Z0-9]/g, '-')
}

function resolveQwenRuntimeDir(dir: string): string {
  if (dir === '~') return homedir()
  if (dir.startsWith('~/') || dir.startsWith('~\\')) {
    return join(
      homedir(),
      ...dir
        .slice(2)
        .split(/[/\\]+/)
        .filter(Boolean),
    )
  }
  return isAbsolute(dir) ? dir : resolve(dir)
}

function getQwenRuntimeDir(): string {
  const envDir = process.env.QWEN_RUNTIME_DIR
  if (envDir) return resolveQwenRuntimeDir(envDir)

  const homeDir = homedir()
  return homeDir ? join(homeDir, '.qwen') : join(tmpdir(), '.qwen')
}

function getQwenTranscriptPath(sessionId: string, cwd: string): string {
  const projectId = sanitizeQwenCwd(resolve(cwd))
  return join(
    getQwenRuntimeDir(),
    'projects',
    projectId,
    'chats',
    `${sessionId}.jsonl`,
  )
}

function qwenSkillNameFromTextElement(
  element: MessageTextElement,
): string | undefined {
  const raw = (
    element.target ||
    element.label ||
    element.placeholder ||
    ''
  ).trim()
  if (!raw) return undefined

  const bracketMatch = /^\[skill:([^\]]+)\]$/.exec(raw)
  const normalized = (bracketMatch?.[1] ?? raw).trim()
  const withoutPlugin = normalized.startsWith('.agents:')
    ? normalized.slice('.agents:'.length).trim()
    : normalized
  return withoutPlugin.split(':').pop()?.trim() || withoutPlugin
}

function rangesOverlapBytes(
  a: MessageTextElement,
  b: MessageTextElement,
): boolean {
  return (
    a.byte_range.start < b.byte_range.end &&
    b.byte_range.start < a.byte_range.end
  )
}

function qwenTranscriptPlaceholderFromSourceElement(
  sourceElement: MessageTextElement,
): string | undefined {
  if (sourceElement.type === 'skill') {
    const skillName = qwenSkillNameFromTextElement(sourceElement)
    return skillName ? `@${skillName}` : undefined
  }

  return sourceElement.placeholder || undefined
}

function findNonOverlappingPlaceholderStart(
  content: string,
  placeholder: string,
  elements: MessageTextElement[],
): number {
  let start = content.indexOf(placeholder)
  while (start >= 0) {
    const candidate: MessageTextElement = {
      type: 'context',
      byte_range: {
        start: utf16IndexToByteOffset(content, start),
        end: utf16IndexToByteOffset(content, start + placeholder.length),
      },
      placeholder,
    }
    if (!elements.some((existing) => rangesOverlapBytes(existing, candidate)))
      return start
    start = content.indexOf(placeholder, start + placeholder.length)
  }
  return -1
}

function buildQwenTranscriptTextElements(
  content: string,
  sourceElements?: MessageTextElement[],
): MessageTextElement[] | undefined {
  const elements: MessageTextElement[] = []

  for (const sourceElement of sourceElements ?? []) {
    const placeholder =
      qwenTranscriptPlaceholderFromSourceElement(sourceElement)
    if (!placeholder) continue

    const start = findNonOverlappingPlaceholderStart(
      content,
      placeholder,
      elements,
    )
    if (start < 0) continue

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
    }

    if (sourceElement.type === 'skill') {
      const skillName = qwenSkillNameFromTextElement(sourceElement)
      if (skillName) {
        element.target = skillName
        element.label = sourceElement.label || skillName
      }
    }

    elements.push(element)
  }

  elements.sort((a, b) => a.byte_range.start - b.byte_range.start)
  return elements.length > 0 ? elements : undefined
}

function toQwenTranscriptTextElements(
  value: unknown,
): MessageTextElement[] | undefined {
  if (!Array.isArray(value)) return undefined

  const byteOffset = (offset: unknown): number | undefined => {
    if (typeof offset === 'number' && Number.isFinite(offset) && offset >= 0)
      return offset
    if (typeof offset !== 'string') return undefined
    const parsed = Number(offset)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
  }

  const elements = value
    .filter(isRecord)
    .map((element): MessageTextElement | null => {
      const type = asString(element.type) as
        | MessageTextElement['type']
        | undefined
      const byteRange = toRecord(element.byte_range)
      const start = byteOffset(byteRange.start)
      const end = byteOffset(byteRange.end)
      const placeholder = asString(element.placeholder)
      if (!type || start == null || end == null || !placeholder) return null
      if (
        ![
          'source',
          'skill',
          'context',
          'slash_command',
          'file',
          'folder',
        ].includes(type)
      )
        return null
      return {
        type,
        byte_range: { start, end },
        placeholder,
        ...(asString(element.label) ? { label: asString(element.label) } : {}),
        ...(asString(element.target)
          ? { target: asString(element.target) }
          : {}),
        ...(isRecord(element.metadata) ? { metadata: element.metadata } : {}),
      }
    })
    .filter((element): element is MessageTextElement => !!element)

  return elements.length > 0 ? elements : undefined
}

function jsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function parseJsonText(value: string): unknown | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    return null
  }
}

function isJsonCodeFence(value: string): boolean {
  return /^```(?:json|JSON)?\s*\r?\n/.test(value.trim())
}

function isDoctorOutput(value: unknown): boolean {
  const record = toRecord(value)
  return Array.isArray(record.checks) && isRecord(record.summary)
}

function formatJsonMarkdown(value: unknown): string {
  return `\`\`\`json\n${jsonStringify(value)}\n\`\`\``
}

function normalizeQwenAssistantText(
  text: string,
  options: { forceJsonFence?: boolean } = {},
): string {
  const trimmed = text.trim()
  if (!trimmed || isJsonCodeFence(trimmed)) return text
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return text

  const parsed = parseJsonText(text)
  if (!parsed) return text
  if (!options.forceJsonFence && !isDoctorOutput(parsed)) return text

  return formatJsonMarkdown(parsed)
}

function formatQwenSlashOutputHistoryItem(
  item: JsonRecord,
): string | undefined {
  const text = asString(item.text)
  if (text?.trim()) {
    return normalizeQwenAssistantText(text, { forceJsonFence: true })
  }

  if (item.type === 'doctor') {
    return formatJsonMarkdown({
      checks: Array.isArray(item.checks) ? item.checks : [],
      summary: toRecord(item.summary),
    })
  }

  return undefined
}

function isSlashCommandPrompt(
  message: string,
  attachments?: FileAttachment[],
): boolean {
  if (attachments && attachments.length > 0) return false
  return /^\/[A-Za-z][\w-]*(?:\s|$)/.test(message.trim())
}

function qwenInitializeTimeoutMs(): number {
  const raw =
    process.env.QWEN_ACP_INITIALIZE_TIMEOUT_MS ||
    process.env.QWEN_INITIALIZE_TIMEOUT_MS
  const parsed = raw ? Number(raw) : Number.NaN
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_INITIALIZE_TIMEOUT_MS
}

function mapPermissionModeToQwen(mode: PermissionMode): string {
  switch (mode) {
    case 'allow-all':
      return 'yolo'
    case 'safe':
      return 'plan'
    case 'auto-edit':
      return 'auto-edit'
    case 'ask':
    default:
      return 'default'
  }
}

function mapQwenModeToPermissionMode(
  mode: string | undefined,
): PermissionMode | undefined {
  switch (mode) {
    case 'plan':
      return 'safe'
    case 'yolo':
      return 'allow-all'
    case 'auto-edit':
      return 'auto-edit'
    case 'default':
      return 'ask'
    default:
      return undefined
  }
}

function mapPlanStatus(
  status: unknown,
): 'pending' | 'in_progress' | 'completed' {
  switch (status) {
    case 'completed':
    case 'complete':
    case 'done':
      return 'completed'
    case 'in_progress':
    case 'in-progress':
    case 'running':
      return 'in_progress'
    default:
      return 'pending'
  }
}

function normalizeToolName(
  toolName: string | undefined,
  kind?: string,
): string {
  const raw = (toolName || kind || 'tool').trim()
  const lower = raw.toLowerCase()

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
  }

  if (mappings[lower]) return mappings[lower]

  switch (kind) {
    case 'read':
      return 'Read'
    case 'edit':
    case 'delete':
    case 'move':
      return 'Edit'
    case 'search':
      return 'Grep'
    case 'execute':
      return 'Bash'
    case 'fetch':
      return 'WebFetch'
    case 'switch_mode':
      return 'ExitPlanMode'
    default:
      return raw
  }
}

function displayNameForTool(toolName: string, kind?: string): string {
  if (toolName === 'Bash') return 'Run Command'
  if (toolName === 'Read') return 'Read File'
  if (toolName === 'Write') return 'Write File'
  if (toolName === 'Edit') return 'Edit File'
  if (toolName === 'LS') return 'List Directory'
  if (toolName === 'Glob') return 'Search Files'
  if (toolName === 'Grep') return 'Search Content'
  if (toolName === 'WebFetch') return 'Fetch URL'
  if (toolName === 'ExitPlanMode') return 'Switch Mode'
  if (kind === 'think') return 'Think'
  return toolName
}

function permissionTypeForKind(
  kind?: string,
): PermissionRequestType | undefined {
  switch (kind) {
    case 'execute':
      return 'bash'
    case 'edit':
    case 'delete':
    case 'move':
      return 'file_write'
    case 'fetch':
      return 'api_mutation'
    case 'switch_mode':
      return 'admin_approval'
    default:
      return 'mcp_mutation'
  }
}

export class QwenAgent extends BaseAgent {
  protected backendName = 'Qwen Code'

  private acpLease: QwenAcpLease | null = null
  private connection: ClientSideConnection | null = null

  private qwenSessionId: string | null = null
  private ensureQwenSessionPromise: Promise<void> | null = null
  private eventQueue = new EventQueue()
  private _isProcessing = false
  private abortReason?: AbortReason
  private persistedQwenSessionId: string | null = null
  private activePromptRunId: number | null = null
  private promptRunCounter = 0
  private permissionRequestCounter = 0
  private toolIdCounter = 0
  private planUpdateCounter = 0
  private hasInitialModeOverride = false
  private pendingModeOverride: PermissionMode | null = null

  private pendingPermissions = new Map<string, PendingPermission>()
  private miniCollectors = new Map<string, MiniCollector>()
  private historyCollectors = new Map<string, HistoryCollector>()
  private ensureProcessPromise: Promise<void> | null = null
  private suppressedSessionUpdates = new Set<string>()
  private pendingAvailableCommandsUpdates = new Map<string, JsonRecord>()
  private latestAvailableCommandsSnapshot: AvailableCommandsSnapshot | null =
    null
  private availableCommandsWaiters: Array<
    (snapshot: AvailableCommandsSnapshot | null) => void
  > = []
  private availableModelIds: Set<string> | null = null
  private availableModelsById = new Map<string, ModelDefinition>()
  private firstAvailableModelId: string | undefined

  private sourceMcpServers: Record<string, SdkMcpServerConfig> = {}
  private currentTurnId: string | undefined
  private currentAssistantText = ''
  private currentThoughtText = ''
  private currentAssistantParentToolUseId: string | undefined
  private currentThoughtParentToolUseId: string | undefined
  private currentIsSlashCommand = false
  private toolNames = new Map<string, string>()
  private toolInputs = new Map<string, Record<string, unknown>>()
  private activeParentToolUseIds = new Set<string>()
  private midTurnMessageQueue: string[] = []

  constructor(config: BackendConfig) {
    super(config, config.model || '')
    this._supportsBranching = false
    this.persistedQwenSessionId = config.session?.sdkSessionId || null
    this.pendingModeOverride =
      config.session?.permissionMode && !config.session?.sdkSessionId
        ? config.session.permissionMode
        : null
    this.hasInitialModeOverride = this.pendingModeOverride !== null

    if (!config.isHeadless) {
      this.startConfigWatcher()
    }
  }

  getRecentStderr(): string {
    return this.acpLease?.recentStderr() ?? ''
  }

  override getSessionId(): string | null {
    return (
      this.qwenSessionId ??
      this.persistedQwenSessionId ??
      this.config.session?.sdkSessionId ??
      null
    )
  }

  override setSessionId(sessionId: string | null): void {
    super.setSessionId(sessionId)
    if (this.qwenSessionId) this.unregisterAcpSession(this.qwenSessionId)
    this.qwenSessionId = sessionId
    this.persistedQwenSessionId = sessionId
    if (sessionId) this.registerAcpSession(sessionId)
  }

  override clearHistory(): void {
    super.clearHistory()
    if (this.qwenSessionId) this.unregisterAcpSession(this.qwenSessionId)
    this.qwenSessionId = null
    this.persistedQwenSessionId = null
    this.pendingAvailableCommandsUpdates.clear()
    this.latestAvailableCommandsSnapshot = null
    this.resolveAvailableCommandsWaiters(null)
    this.config.onSdkSessionIdCleared?.()
  }

  protected override extractSkillPaths(message: string): {
    skillPaths: Map<string, string>
    cleanMessage: string
    missingSkills: string[]
  } {
    const withQwenSkills = message.replace(
      /\[skill:([^\]]+)\]/g,
      (_match, rawSkill: string) => {
        const normalized = rawSkill.trim()
        const skillName = normalized.startsWith('.agents:')
          ? normalized.slice('.agents:'.length).trim()
          : normalized
        return skillName ? `@${skillName}` : ''
      },
    )
    const withSources = resolveSourceMentions(withQwenSkills)
    const workDir =
      this.config.session?.workingDirectory ?? this.workingDirectory
    const cleanMessage = resolveFileMentions(withSources, workDir).trim()

    if (withQwenSkills !== message) {
      this.debug(
        '[extractSkillPaths] Qwen skill mentions are passed to ACP as @skill references',
      )
    }

    return {
      skillPaths: new Map(),
      cleanMessage: cleanMessage || message.trim(),
      missingSkills: [],
    }
  }

  override updateWorkingDirectory(path: string): void {
    super.updateWorkingDirectory(path)
    if (this.qwenSessionId) {
      this.unregisterAcpSession(this.qwenSessionId)
      this.qwenSessionId = null
      this.persistedQwenSessionId = null
      this.pendingAvailableCommandsUpdates.clear()
      this.latestAvailableCommandsSnapshot = null
      this.resolveAvailableCommandsWaiters(null)
      this.config.onSdkSessionIdCleared?.()
      this.debug('Qwen ACP session cleared after working directory change')
    }
  }

  private invalidateAvailableCommandsSnapshot(reason: string): void {
    if (this.latestAvailableCommandsSnapshot) {
      this.debug(`Qwen slash command snapshot invalidated: ${reason}`)
    }
    this.latestAvailableCommandsSnapshot = null
  }

  protected async *chatImpl(
    messageParam: string,
    attachments?: FileAttachment[],
    options?: ChatOptions,
  ): AsyncGenerator<AgentEvent> {
    let message = messageParam
    const promptRunId = ++this.promptRunCounter
    this.activePromptRunId = promptRunId
    this._isProcessing = true
    this.abortReason = undefined
    this.eventQueue.reset()
    this.currentAssistantText = ''
    this.currentThoughtText = ''
    this.currentAssistantParentToolUseId = undefined
    this.currentThoughtParentToolUseId = undefined
    this.currentIsSlashCommand = isSlashCommandPrompt(message, attachments)
    this.currentTurnId = `qwen-turn-${promptRunId}`
    this.toolNames.clear()
    this.toolInputs.clear()
    this.activeParentToolUseIds.clear()
    this.midTurnMessageQueue = []

    this.emitAutomationEvent('UserPromptSubmit', {
      hook_event_name: 'UserPromptSubmit',
      prompt: message,
    })

    try {
      await this.ensureProcess()

      try {
        await this.ensureQwenSession()
      } catch (error) {
        if (this.persistedQwenSessionId || this.config.session?.sdkSessionId) {
          this.debug(
            `Qwen resume failed, starting a fresh session: ${error instanceof Error ? error.message : String(error)}`,
          )
          this.qwenSessionId = null
          this.persistedQwenSessionId = null
          this.config.onSdkSessionIdCleared?.()
          const recoveryContext = this.buildRecoveryContext()
          if (recoveryContext && !isSlashCommandPrompt(message, attachments)) {
            message = recoveryContext + message
          }
          await this.ensureQwenSession()
        } else {
          throw error
        }
      }

      const sessionId = this.qwenSessionId
      if (!sessionId) throw new Error('Qwen ACP session was not created')

      const prompt = this.buildPromptBlocks(message, attachments)
      let transcriptTextElementsPersisted = false
      const persistTranscriptTextElements = () => {
        if (transcriptTextElementsPersisted) return
        transcriptTextElementsPersisted = true
        this.persistQwenTranscriptTextElements(
          sessionId,
          this.resolvedCwd(),
          options?.textElements,
        )
      }
      const promptPromise = this.callAcp(
        'session/prompt',
        (connection) => connection.prompt({ sessionId, prompt }),
        0,
      )

      promptPromise
        .then((result) => {
          if (this.activePromptRunId !== promptRunId) return
          const stopReason = asString(toRecord(result).stopReason)
          persistTranscriptTextElements()
          this.flushThoughtText()
          this.flushAssistantText()
          this.eventQueue.enqueue({ type: 'complete' })
          this.eventQueue.complete()
          this.debug(
            `Qwen prompt complete${stopReason ? ` (${stopReason})` : ''}`,
          )
        })
        .catch((error) => {
          if (this.activePromptRunId !== promptRunId) return
          if (this.abortReason) {
            persistTranscriptTextElements()
            this.eventQueue.complete()
            return
          }
          const message = error instanceof Error ? error.message : String(error)
          persistTranscriptTextElements()
          this.eventQueue.enqueue({ type: 'error', message })
          this.eventQueue.enqueue({ type: 'complete' })
          this.eventQueue.complete()
        })

      for await (const event of this.eventQueue.drain()) {
        yield event
        if (event.type === 'tool_result') {
          const pendingRestart = this.consumePendingSourceActivationRestart()
          if (pendingRestart) {
            yield {
              type: 'source_activated',
              sourceSlug: pendingRestart.sourceSlug,
              originalMessage: pendingRestart.userMessage,
            }
            this.forceAbort(AbortReason.SourceActivated)
            return
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      yield { type: 'error', message }
      yield { type: 'complete' }
    } finally {
      if (this.activePromptRunId === promptRunId) {
        this.activePromptRunId = null
      }
      this._isProcessing = false
      this.currentTurnId = undefined
      this.currentAssistantText = ''
      this.currentThoughtText = ''
      this.currentIsSlashCommand = false
      this.midTurnMessageQueue = []
    }
  }

  isProcessing(): boolean {
    return this._isProcessing
  }

  enqueueMidTurnMessage(message: string): boolean {
    const trimmed = message.trim()
    if (!trimmed || !this._isProcessing || this.abortReason) return false

    this.midTurnMessageQueue.push(trimmed)
    this.debug(
      `Queued mid-turn user message for Qwen ACP injection (${this.midTurnMessageQueue.length} pending)`,
    )
    return true
  }

  async abort(reason?: string): Promise<void> {
    this.debug(`Qwen abort requested${reason ? `: ${reason}` : ''}`)
    this.emitAutomationEvent('Stop', { hook_event_name: 'Stop' })
    this.abortReason = AbortReason.UserStop
    this._isProcessing = false
    this.activePromptRunId = null
    this.midTurnMessageQueue = []
    this.cancelPendingPermissions()

    const sessionId = this.qwenSessionId
    if (sessionId && this.connection) {
      await this.callAcp(
        'session/cancel',
        (connection) => connection.cancel({ sessionId }),
        5_000,
      ).catch((error) => {
        this.debug(
          `Qwen cancel failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
    }

    this.eventQueue.complete()
  }

  forceAbort(reason: AbortReason): void {
    this.emitAutomationEvent('Stop', { hook_event_name: 'Stop' })
    this.abortReason = reason
    this._isProcessing = false
    this.activePromptRunId = null
    this.midTurnMessageQueue = []
    this.cancelPendingPermissions()
    this.eventQueue.complete()

    const sessionId = this.qwenSessionId
    if (sessionId && this.connection) {
      void this.callAcp(
        'session/cancel',
        (connection) => connection.cancel({ sessionId }),
        5_000,
      ).catch((error) => {
        this.debug(
          `Qwen force cancel failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
    }
  }

  respondToPermission(
    requestId: string,
    allowed: boolean,
    alwaysAllow?: boolean,
    options?: PermissionResponseOptions,
  ): void {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) return

    this.pendingPermissions.delete(requestId)
    pending.resolve(
      this.createPermissionResponse(
        pending.options,
        allowed,
        !!alwaysAllow,
        options?.answers,
      ),
    )
  }

  override setPermissionMode(mode: PermissionMode): void {
    this.hasInitialModeOverride = true
    this.pendingModeOverride = mode
    super.setPermissionMode(mode)
    void this.forwardPermissionMode(mode)
  }

  override cyclePermissionMode(): PermissionMode {
    this.hasInitialModeOverride = true
    const mode = super.cyclePermissionMode()
    this.pendingModeOverride = mode
    void this.forwardPermissionMode(mode)
    return mode
  }

  async getPermissionSettings(): Promise<QwenPermissionSettings> {
    await this.ensureProcess()
    const result = await this.callAcp(
      'qwen/permissions/getSettings',
      (connection) =>
        connection.extMethod('qwen/permissions/getSettings', {
          cwd: this.resolvedCwd(),
        }),
      10_000,
    )
    return result as unknown as QwenPermissionSettings
  }

  async setPermissionRules(
    scope: PermissionSettingsScope,
    ruleType: PermissionRuleType,
    rules: string[],
  ): Promise<QwenPermissionSettings> {
    await this.ensureProcess()
    const result = await this.callAcp(
      'qwen/permissions/setRules',
      (connection) =>
        connection.extMethod('qwen/permissions/setRules', {
          cwd: this.resolvedCwd(),
          scope,
          ruleType,
          rules,
        }),
      10_000,
    )
    return result as unknown as QwenPermissionSettings
  }

  async getCoreSettings(): Promise<QwenCoreSettingsSnapshot> {
    await this.ensureProcess()
    const result = await this.callAcp(
      'qwen/settings/getCore',
      (connection) =>
        connection.extMethod('qwen/settings/getCore', {
          cwd: this.resolvedCwd(),
        }),
      10_000,
    )
    return result as unknown as QwenCoreSettingsSnapshot
  }

  async listProviders(): Promise<QwenProviderCatalog> {
    await this.ensureProcess()
    const result = await this.callAcp(
      'qwen/providers/list',
      (connection) =>
        connection.extMethod('qwen/providers/list', {
          cwd: this.resolvedCwd(),
        }),
      10_000,
    )
    return normalizeQwenProviderCatalog(toRecord(result))
  }

  async connectProvider(
    params: QwenProviderConnectParams,
  ): Promise<QwenProviderConnectResult> {
    await this.ensureProcess()
    const result = await this.callAcp(
      'qwen/providers/connect',
      (connection) =>
        connection.extMethod('qwen/providers/connect', {
          cwd: this.resolvedCwd(),
          ...params,
        } as unknown as JsonRecord),
      30_000,
    )
    return normalizeQwenProviderConnectResult(toRecord(result))
  }

  async setCoreSetting(
    scope: QwenSettingsScope,
    key: QwenCoreSettingKey,
    value: QwenSettingValue,
  ): Promise<QwenCoreSettingsSnapshot> {
    await this.ensureProcess()
    const result = await this.callAcp(
      'qwen/settings/setCoreValue',
      (connection) =>
        connection.extMethod('qwen/settings/setCoreValue', {
          cwd: this.resolvedCwd(),
          scope,
          key,
          value,
        }),
      10_000,
    )
    return result as unknown as QwenCoreSettingsSnapshot
  }

  async setMcpServer(
    scope: QwenSettingsScope,
    name: string,
    server: QwenMcpServerConfig,
  ): Promise<QwenCoreSettingsSnapshot> {
    await this.ensureProcess()
    const result = await this.callAcp(
      'qwen/settings/setMcpServer',
      (connection) =>
        connection.extMethod('qwen/settings/setMcpServer', {
          cwd: this.resolvedCwd(),
          scope,
          name,
          server,
        }),
      10_000,
    )
    return result as unknown as QwenCoreSettingsSnapshot
  }

  async removeMcpServer(
    scope: QwenSettingsScope,
    name: string,
  ): Promise<QwenCoreSettingsSnapshot> {
    await this.ensureProcess()
    const result = await this.callAcp(
      'qwen/settings/removeMcpServer',
      (connection) =>
        connection.extMethod('qwen/settings/removeMcpServer', {
          cwd: this.resolvedCwd(),
          scope,
          name,
        }),
      10_000,
    )
    return result as unknown as QwenCoreSettingsSnapshot
  }

  async setHook(
    scope: QwenSettingsScope,
    event: QwenHookEvent,
    index: number | undefined,
    hook: QwenHookDefinition,
  ): Promise<QwenCoreSettingsSnapshot> {
    await this.ensureProcess()
    const result = await this.callAcp(
      'qwen/settings/setHook',
      (connection) =>
        connection.extMethod('qwen/settings/setHook', {
          cwd: this.resolvedCwd(),
          scope,
          event,
          index,
          hook,
        }),
      10_000,
    )
    return result as unknown as QwenCoreSettingsSnapshot
  }

  async removeHook(
    scope: QwenSettingsScope,
    event: QwenHookEvent,
    index: number,
  ): Promise<QwenCoreSettingsSnapshot> {
    await this.ensureProcess()
    const result = await this.callAcp(
      'qwen/settings/removeHook',
      (connection) =>
        connection.extMethod('qwen/settings/removeHook', {
          cwd: this.resolvedCwd(),
          scope,
          event,
          index,
        }),
      10_000,
    )
    return result as unknown as QwenCoreSettingsSnapshot
  }

  async setExtensionSetting(
    extensionId: string,
    settingKey: string,
    scope: QwenSettingsScope,
    value: QwenSettingValue,
  ): Promise<QwenCoreSettingsSnapshot> {
    await this.ensureProcess()
    const result = await this.callAcp(
      'qwen/settings/setExtensionSetting',
      (connection) =>
        connection.extMethod('qwen/settings/setExtensionSetting', {
          cwd: this.resolvedCwd(),
          extensionId,
          settingKey,
          scope,
          value,
        }),
      10_000,
    )
    return result as unknown as QwenCoreSettingsSnapshot
  }

  async installSkill(
    request: QwenSkillInstallRequest,
  ): Promise<QwenSkillInstallResult> {
    await this.ensureProcess()
    this.invalidateAvailableCommandsSnapshot('skill install')
    const result = await this.callAcp(
      'qwen/skills/install',
      (connection) =>
        connection.extMethod('qwen/skills/install', {
          cwd: this.resolvedCwd(),
          skill: {
            ...request,
            scope: request.scope ?? 'global',
          },
        }),
      30_000,
    )
    const record = toRecord(result)
    const installedSkill = toRecord(record.skill)
    return {
      id: asString(record.id) ?? asString(installedSkill.id) ?? request.id,
      slug:
        asString(record.slug) ?? asString(installedSkill.slug) ?? request.slug,
      installed: asBoolean(record.installed) ?? true,
      installedPath:
        asString(record.installedPath) ??
        asString(record.installed_path) ??
        asString(installedSkill.installedPath) ??
        asString(installedSkill.installed_path),
      message: asString(record.message),
    }
  }

  async deleteSkill(
    request: QwenSkillDeleteRequest,
  ): Promise<QwenSkillDeleteResult> {
    await this.ensureProcess()
    this.invalidateAvailableCommandsSnapshot('skill delete')
    const result = await this.callAcp(
      'qwen/skills/delete',
      (connection) =>
        connection.extMethod('qwen/skills/delete', {
          cwd: this.resolvedCwd(),
          skill: {
            ...request,
            scope: request.scope ?? 'global',
          },
        }),
      10_000,
    )
    const record = toRecord(result)
    const deletedSkill = toRecord(record.skill)
    return {
      slug:
        asString(record.slug) ?? asString(deletedSkill.slug) ?? request.slug,
      deleted: asBoolean(record.deleted) ?? true,
      message: asString(record.message),
    }
  }

  async setSkillEnabled(
    request: QwenSkillSetEnabledRequest,
  ): Promise<QwenSkillSetEnabledResult> {
    await this.ensureProcess()
    this.invalidateAvailableCommandsSnapshot('skill enabled state change')
    const result = await this.callAcp(
      'qwen/skills/setEnabled',
      (connection) =>
        connection.extMethod('qwen/skills/setEnabled', {
          cwd: this.resolvedCwd(),
          skill: {
            ...request,
            scope: request.scope ?? 'global',
          },
        }),
      10_000,
    )
    const record = toRecord(result)
    const updatedSkill = toRecord(record.skill)
    return {
      slug:
        asString(record.slug) ?? asString(updatedSkill.slug) ?? request.slug,
      enabled: asBoolean(record.enabled) ?? request.enabled,
      installedPath:
        asString(record.installedPath) ??
        asString(record.installed_path) ??
        asString(updatedSkill.installedPath) ??
        asString(updatedSkill.installed_path),
      message: asString(record.message),
    }
  }

  override setModel(model: string): void {
    if (!this.isKnownAvailableModel(model)) {
      this.debug(`Ignoring Qwen model switch for unavailable model: ${model}`)
      return
    }
    super.setModel(model)
    this.applyCurrentModelContextWindow(model)
    void this.forwardModel(model)
  }

  override async setSourceServers(
    mcpServers: Record<string, SdkMcpServerConfig>,
    apiServers: Record<string, unknown>,
    intendedSlugs?: string[],
  ): Promise<void> {
    this.sourceMcpServers = mcpServers
    await super.setSourceServers(mcpServers, apiServers, intendedSlugs)
  }

  async runMiniCompletion(prompt: string): Promise<string | null> {
    const result = await this.queryLlm({ prompt })
    return result.text.trim() || null
  }

  async listSessions(
    options: BackendSessionListOptions = {},
  ): Promise<BackendSessionListResult> {
    await this.ensureProcess()
    const response = await this.callAcp(
      'session/list',
      (connection) =>
        connection.listSessions({
          cwd: options.cwd || this.resolvedCwd(),
          cursor: options.cursor,
          _meta:
            options.size && options.size > 0
              ? { size: Math.floor(options.size) }
              : undefined,
        }),
      60_000,
    )

    return {
      nextCursor: response.nextCursor ?? undefined,
      sessions: response.sessions.map((session) => ({
        sessionId: session.sessionId,
        cwd: session.cwd,
        title: session.title,
        createdAt:
          typeof session._meta?.createdAt === 'string'
            ? session._meta.createdAt
            : null,
        updatedAt: session.updatedAt,
        startTime:
          typeof session._meta?.['startTime'] === 'string'
            ? session._meta['startTime']
            : undefined,
        preview:
          typeof session._meta?.['preview'] === 'string'
            ? session._meta['preview']
            : undefined,
        messageCount:
          typeof session._meta?.['messageCount'] === 'number'
            ? session._meta['messageCount']
            : undefined,
        gitBranch:
          typeof session._meta?.['gitBranch'] === 'string'
            ? session._meta['gitBranch']
            : undefined,
        titleSource:
          session._meta?.['titleSource'] === 'manual' ||
          session._meta?.['titleSource'] === 'auto'
            ? session._meta['titleSource']
            : undefined,
      })),
    }
  }

  async deleteBackendSession(
    sessionId: string,
    options: { cwd?: string } = {},
  ): Promise<boolean> {
    await this.ensureProcess()
    const result = toRecord(
      await this.callAcp(
        'ext/deleteSession',
        (connection) =>
          connection.extMethod('deleteSession', {
            sessionId,
            cwd: options.cwd || this.resolvedCwd(),
          }),
        30_000,
      ),
    )
    return result.success !== false
  }

  async rewindToUserTurn(
    targetTurnIndex: number,
  ): Promise<BackendRewindResult> {
    if (!Number.isInteger(targetTurnIndex) || targetTurnIndex < 0) {
      throw new Error('targetTurnIndex must be a non-negative integer')
    }

    await this.ensureProcess()
    await this.ensureQwenSession()

    const sessionId = this.qwenSessionId
    if (!sessionId) throw new Error('Qwen ACP session was not created')

    const result = toRecord(
      await this.callAcp(
        'ext/rewindSession',
        (connection) =>
          connection.extMethod('rewindSession', {
            sessionId,
            targetTurnIndex,
            cwd: this.resolvedCwd(),
          }),
        30_000,
      ),
    )

    if (result.success !== true) {
      throw new Error('Qwen ACP rewindSession did not report success')
    }

    const resultTargetTurnIndex = Number.isInteger(result.targetTurnIndex)
      ? (result.targetTurnIndex as number)
      : undefined
    const resultApiTruncateIndex = Number.isInteger(result.apiTruncateIndex)
      ? (result.apiTruncateIndex as number)
      : undefined

    return {
      historyBeforeRewind: Array.isArray(result.historyBeforeRewind)
        ? result.historyBeforeRewind
        : undefined,
      targetTurnIndex: resultTargetTurnIndex,
      apiTruncateIndex: resultApiTruncateIndex,
    }
  }

  async renameBackendSession(
    sessionId: string,
    title: string,
    options: { cwd?: string } = {},
  ): Promise<boolean> {
    await this.ensureProcess()
    const result = toRecord(
      await this.callAcp(
        'ext/renameSession',
        (connection) =>
          connection.extMethod('renameSession', {
            sessionId,
            title,
            cwd: options.cwd || this.resolvedCwd(),
          }),
        30_000,
      ),
    )
    return result.success !== false
  }

  async loadSessionMessages(
    sessionId: string,
    options: { cwd?: string } = {},
  ): Promise<BackendSessionMessagesResult> {
    const cwd = options.cwd || this.resolvedCwd()
    await this.ensureProcess()

    const buildResultFromUpdates = (
      updates: JsonRecord[],
    ): BackendSessionMessagesResult => {
      const messages = this.buildHistoryMessages(sessionId, updates, cwd)
      const availableCommandsSnapshot =
        this.extractAvailableCommandsSnapshot(updates)
      const mergedMessages = this.mergeSlashCommandInvocationMessages(
        sessionId,
        messages,
        cwd,
      )
      const messagesWithTranscriptTelemetry =
        this.mergeQwenTranscriptTelemetryMessages(
          sessionId,
          mergedMessages,
          cwd,
        )
      const messagesWithTextElements = this.applyQwenTranscriptTextElements(
        messagesWithTranscriptTelemetry,
        sessionId,
        cwd,
      )
      return {
        messages: messagesWithTextElements,
        ...(availableCommandsSnapshot ?? {}),
      }
    }

    try {
      const response = toRecord(
        await this.callAcp(
          'ext/qwen/session/loadUpdates',
          (connection) =>
            connection.extMethod('qwen/session/loadUpdates', {
              sessionId,
              cwd,
            }),
          30_000,
        ),
      )
      const updates = Array.isArray(response.updates)
        ? response.updates.filter(isRecord)
        : undefined
      if (updates) {
        return buildResultFromUpdates(updates)
      }
    } catch (error) {
      this.debug(
        `Qwen loadSessionMessages extension unavailable; falling back to session/load for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    const collector: HistoryCollector = { updates: [] }
    this.historyCollectors.set(sessionId, collector)

    try {
      await this.callAcp(
        'session/load',
        (connection) =>
          connection.loadSession({
            sessionId,
            cwd,
            mcpServers: this.buildAcpMcpServers(),
          }),
        60_000,
      )

      return buildResultFromUpdates(collector.updates)
    } finally {
      this.historyCollectors.delete(sessionId)
    }
  }

  async refreshAvailableCommands(): Promise<AvailableCommandsSnapshot | null> {
    this.debug(
      `Qwen slash command refresh requested (session=${this.qwenSessionId ?? this.persistedQwenSessionId ?? 'none'}, cwd=${this.resolvedCwd()})`,
    )
    const hadLiveSessionBeforeRefresh = !!this.qwenSessionId
    await this.ensureProcess()
    await this.ensureQwenSession()

    if (this.latestAvailableCommandsSnapshot) {
      this.debug(
        `Qwen slash command refresh using latest snapshot: commands=${this.latestAvailableCommandsSnapshot.availableCommands.length} ` +
          `skills=${this.latestAvailableCommandsSnapshot.availableSkills?.length ?? 0} ` +
          `names=${formatDebugNames(this.latestAvailableCommandsSnapshot.availableCommands.map((command) => command.name))}`,
      )
      return this.latestAvailableCommandsSnapshot
    }

    if (hadLiveSessionBeforeRefresh) {
      const reloadedSnapshot =
        await this.reloadCurrentSessionForAvailableCommands()
      if (reloadedSnapshot) {
        this.debug(
          `Qwen slash command refresh reused current session after reload: commands=${reloadedSnapshot.availableCommands.length} ` +
            `skills=${reloadedSnapshot.availableSkills?.length ?? 0} ` +
            `names=${formatDebugNames(reloadedSnapshot.availableCommands.map((command) => command.name))}`,
        )
        return reloadedSnapshot
      }
    }

    this.debug(
      'Qwen slash command refresh waiting for available_commands_update',
    )
    const snapshot = await this.waitForAvailableCommandsSnapshot()
    this.debug(
      snapshot
        ? `Qwen slash command refresh received after wait: commands=${snapshot.availableCommands.length} skills=${snapshot.availableSkills?.length ?? 0} names=${formatDebugNames(snapshot.availableCommands.map((command) => command.name))}`
        : 'Qwen slash command refresh timed out waiting for available_commands_update',
    )
    return snapshot
  }

  async queryLlm(request: LLMQueryRequest): Promise<LLMQueryResult> {
    await this.ensureProcess()
    const sessionId = await this.createEphemeralSession()
    const collector: MiniCollector = { chunks: [] }
    this.miniCollectors.set(sessionId, collector)

    try {
      const model = request.model
      if (model) {
        await this.callAcp(
          'session/set_config_option',
          (connection) =>
            connection.setSessionConfigOption({
              sessionId,
              configId: 'model',
              value: model,
            }),
          10_000,
        ).catch((error) => {
          this.debug(
            `Qwen mini model switch failed: ${error instanceof Error ? error.message : String(error)}`,
          )
        })
      }

      const prompt = this.buildQueryPrompt(request)
      await this.callAcp(
        'session/prompt',
        (connection) =>
          connection.prompt({
            sessionId,
            prompt: [{ type: 'text', text: prompt }],
          }),
        LLM_QUERY_TIMEOUT_MS,
      )

      return {
        text: collector.chunks.join('').trim(),
        model: request.model || this._model || undefined,
        inputTokens: collector.inputTokens,
        outputTokens: collector.outputTokens,
      }
    } finally {
      this.miniCollectors.delete(sessionId)
      await this.deleteBackendSession(sessionId).catch((error) => {
        this.debug(
          `Qwen mini session cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      })
      this.unregisterAcpSession(sessionId)
    }
  }

  override destroy(): void {
    super.destroy()
    this.killSubprocess()
    this.pendingPermissions.clear()
    this.miniCollectors.clear()
    this.historyCollectors.clear()
    this.ensureProcessPromise = null
  }

  // ============================================================
  // ACP process and SDK connection
  // ============================================================

  private async ensureProcess(): Promise<void> {
    if (
      this.acpLease?.isActive() &&
      this.connection &&
      !this.connection.signal.aborted
    )
      return

    if (this.ensureProcessPromise) {
      await this.ensureProcessPromise
      return
    }

    this.ensureProcessPromise = this.startProcess()
    try {
      await this.ensureProcessPromise
    } finally {
      this.ensureProcessPromise = null
    }
  }

  private async startProcess(): Promise<void> {
    this.connection = null
    this.acpLease?.release()
    this.acpLease = null

    const runtime = getBackendRuntime(this.config)
    const qwenCliPath = runtime.paths?.qwenCli
    if (!qwenCliPath) {
      throw new Error(
        'Qwen Code CLI not found. Build the current qwen-code checkout with npm run build && npm run bundle, or set QWEN_CODE_CLI to a dist/cli.js path.',
      )
    }

    const nodePath = runtime.paths?.node || process.execPath
    const { command, args } = this.buildSpawnCommand(qwenCliPath, nodePath)
    const cwd = this.config.workspace.rootPath || this.resolvedCwd()
    const commandDescription = `${command} ${args.join(' ')}`
    const key = buildSharedAcpProcessKey({
      command,
      spawnArgs: args,
      workspaceRootPath: cwd,
      envOverrides: this.config.envOverrides,
    })

    try {
      this.acpLease = await acquireSharedQwenAcpProcess(
        {
          key,
          command,
          args,
          cwd,
          envOverrides: this.config.envOverrides,
        },
        {
          onSessionUpdate: (params) => this.handleSessionUpdate(params),
          onPermissionRequest: (params) => this.handlePermissionRequest(params),
          onExtMethod: (method, params) => this.handleExtMethod(method, params),
          onProcessExit: (code, signal) => this.handleProcessExit(code, signal),
          onDebug: (message) => this.debug(message),
        },
      )
      this.connection = this.acpLease.connection
    } catch (error) {
      const originalMessage =
        error instanceof Error ? error.message : String(error)
      const recentStderr = this.getRecentStderr().trim()
      const message = [
        originalMessage,
        `Qwen command: ${commandDescription}`,
        recentStderr ? `Recent Qwen stderr:\n${recentStderr}` : undefined,
      ]
        .filter(Boolean)
        .join('\n')
      const wrapped = new Error(message)
      ;(wrapped as Error & { cause?: unknown }).cause = error
      throw wrapped
    }
  }

  private buildSpawnCommand(
    qwenCliPath: string,
    nodePath: string,
  ): { command: string; args: string[] } {
    const args = ['--acp', '--channel=desktop']

    if (qwenCliPath.endsWith('.js')) {
      return { command: nodePath, args: [qwenCliPath, ...args] }
    }

    return { command: qwenCliPath, args }
  }

  private async handleExtMethod(
    method: string,
    params: JsonRecord,
  ): Promise<JsonRecord> {
    if (method !== MID_TURN_QUEUE_DRAIN_METHOD) {
      return {}
    }

    const sessionId = asString(params.sessionId)
    const managedSessionId = this.config.session?.id
    const isCurrentSession =
      !!sessionId &&
      (sessionId === this.qwenSessionId || sessionId === managedSessionId)
    if (!isCurrentSession) {
      if (sessionId) {
        this.debug(
          `Ignored mid-turn queue drain for non-current session ${sessionId}`,
        )
      }
      return {}
    }

    const messages = this.midTurnMessageQueue.splice(0)
    if (messages.length > 0) {
      this.debug(
        `Drained ${messages.length} mid-turn user message(s) to Qwen ACP`,
      )
      this.config.onMidTurnMessagesDrained?.(messages)
    }
    return { messages }
  }

  private getAcpConnection(): ClientSideConnection {
    if (
      !this.connection ||
      this.connection.signal.aborted ||
      !this.acpLease?.isActive()
    ) {
      throw new Error('Qwen ACP process is not running')
    }
    return this.connection
  }

  private callAcp<T>(
    method: string,
    execute: (connection: ClientSideConnection) => Promise<T>,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    return this.withTimeout(execute(this.getAcpConnection()), method, timeoutMs)
  }

  private withTimeout<T>(
    promise: Promise<T>,
    method: string,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (timeoutMs <= 0) return promise

    let timeout: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        reject(new Error(`Qwen ACP request timed out: ${method}`))
      }, timeoutMs)
    })

    return Promise.race([promise, timeoutPromise]).finally(() => {
      if (timeout) clearTimeout(timeout)
    })
  }

  private handleProcessExit(
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const message = `Qwen ACP process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`
    this.debug(message)
    this.acpLease = null
    this.connection = null

    this.cancelPendingPermissions()

    if (this._isProcessing && !this.abortReason) {
      this.eventQueue.enqueue({ type: 'error', message })
      this.eventQueue.enqueue({ type: 'complete' })
      this.eventQueue.complete()
    }
  }

  private killSubprocess(): void {
    for (const sessionId of [
      this.qwenSessionId,
      ...this.miniCollectors.keys(),
      ...this.historyCollectors.keys(),
    ]) {
      if (sessionId) this.unregisterAcpSession(sessionId)
    }
    this.connection = null
    this.acpLease?.release()
    this.acpLease = null
  }

  private registerAcpSession(sessionId: string): void {
    this.acpLease?.registerSession(sessionId)
  }

  private unregisterAcpSession(sessionId: string): void {
    this.acpLease?.unregisterSession(sessionId)
  }

  // ============================================================
  // Session management
  // ============================================================

  private async ensureQwenSession(): Promise<void> {
    if (this.qwenSessionId) {
      this.debug(
        `Qwen ACP session reuse: using live session ${this.qwenSessionId}`,
      )
      this.registerAcpSession(this.qwenSessionId)
      await this.applySessionSettings(this.qwenSessionId)
      this.flushPendingAvailableCommandsUpdate(this.qwenSessionId)
      return
    }

    if (this.ensureQwenSessionPromise) {
      this.debug('Qwen ACP session reuse: waiting for in-flight session setup')
      await this.ensureQwenSessionPromise
      return
    }

    this.ensureQwenSessionPromise = this.createOrLoadQwenSession()
    try {
      await this.ensureQwenSessionPromise
    } finally {
      this.ensureQwenSessionPromise = null
    }
  }

  private async createOrLoadQwenSession(): Promise<void> {
    if (this.qwenSessionId) {
      this.debug(
        `Qwen ACP session reuse: using live session ${this.qwenSessionId}`,
      )
      this.registerAcpSession(this.qwenSessionId)
      await this.applySessionSettings(this.qwenSessionId)
      this.flushPendingAvailableCommandsUpdate(this.qwenSessionId)
      return
    }

    const cwd = this.resolvedCwd()
    const mcpServers = this.buildAcpMcpServers()
    const existingSessionId =
      this.persistedQwenSessionId ?? this.config.session?.sdkSessionId

    if (existingSessionId) {
      this.debug(
        `Qwen ACP session reuse: loading persisted session ${existingSessionId}`,
      )
      this.suppressedSessionUpdates.add(existingSessionId)
      try {
        const result = toRecord(
          await this.callAcp(
            'session/load',
            (connection) =>
              connection.loadSession({
                sessionId: existingSessionId,
                cwd,
                mcpServers,
              }),
            60_000,
          ),
        )
        this.qwenSessionId = existingSessionId
        this.persistedQwenSessionId = existingSessionId
        this.registerAcpSession(existingSessionId)
        this.recordSessionModels(result)
        this.recordSessionModes(result)
        this.config.onSdkSessionIdUpdate?.(existingSessionId)
        await this.applySessionSettings(existingSessionId)
        this.flushPendingAvailableCommandsUpdate(existingSessionId)
        return
      } finally {
        this.suppressedSessionUpdates.delete(existingSessionId)
      }
    }

    this.debug(
      'Qwen ACP session reuse: no existing session id, creating a new ACP session',
    )
    const result = toRecord(
      await this.callAcp(
        'session/new',
        (connection) =>
          connection.newSession({
            cwd,
            mcpServers,
          }),
        60_000,
      ),
    )

    const sessionId = asString(result.sessionId)
    if (!sessionId) {
      throw new Error('Qwen ACP did not return a sessionId')
    }

    this.qwenSessionId = sessionId
    this.persistedQwenSessionId = sessionId
    this.registerAcpSession(sessionId)
    this.recordSessionModels(result)
    this.recordSessionModes(result)
    this.config.onSdkSessionIdUpdate?.(sessionId)
    await this.applySessionSettings(sessionId)
    this.flushPendingAvailableCommandsUpdate(sessionId)
  }

  private async reloadCurrentSessionForAvailableCommands(): Promise<AvailableCommandsSnapshot | null> {
    const sessionId = this.qwenSessionId
    if (!sessionId) return null

    if (this._isProcessing) {
      this.debug(
        `Qwen slash command refresh did not reload session ${sessionId} because a prompt is active`,
      )
      return null
    }

    this.debug(
      `Qwen slash command refresh reloading existing ACP session ${sessionId} to request available_commands_update`,
    )
    this.suppressedSessionUpdates.add(sessionId)
    try {
      const result = toRecord(
        await this.callAcp(
          'session/load',
          (connection) =>
            connection.loadSession({
              sessionId,
              cwd: this.resolvedCwd(),
              mcpServers: this.buildAcpMcpServers(),
            }),
          60_000,
        ),
      )
      this.recordSessionModels(result)
      this.recordSessionModes(result)
      await this.applySessionSettings(sessionId)
    } finally {
      this.suppressedSessionUpdates.delete(sessionId)
      this.flushPendingAvailableCommandsUpdate(sessionId)
    }
    return this.latestAvailableCommandsSnapshot
  }

  private async createEphemeralSession(): Promise<string> {
    const result = toRecord(
      await this.callAcp(
        'session/new',
        (connection) =>
          connection.newSession({
            cwd: this.resolvedCwd(),
            mcpServers: [],
          }),
        60_000,
      ),
    )
    const sessionId = asString(result.sessionId)
    if (!sessionId) {
      throw new Error('Qwen ACP did not return a sessionId for mini completion')
    }
    this.registerAcpSession(sessionId)
    this.recordSessionModels(result)
    return sessionId
  }

  private recordSessionModels(result: JsonRecord): void {
    const modelState = toRecord(result.models)
    const availableModels = Array.isArray(modelState.availableModels)
      ? modelState.availableModels
          .map(toQwenModelDefinition)
          .filter((model): model is ModelDefinition => !!model)
      : []
    const currentModelId = asString(modelState.currentModelId)
    this.availableModelIds = new Set(availableModels.map((model) => model.id))
    this.availableModelsById = new Map(
      availableModels.map((model) => [model.id, model]),
    )
    this.firstAvailableModelId = availableModels[0]?.id
    const selectableCurrentModelId =
      currentModelId && this.availableModelIds.has(currentModelId)
        ? currentModelId
        : undefined

    if (
      (!this._model || !this.isKnownAvailableModel(this._model)) &&
      (selectableCurrentModelId || this.firstAvailableModelId)
    ) {
      super.setModel(
        selectableCurrentModelId || this.firstAvailableModelId || '',
      )
    }

    this.applyCurrentModelContextWindow()

    if (availableModels.length > 0) {
      this.config.onAvailableModelsUpdate?.(availableModels, currentModelId)
    }
  }

  private isKnownAvailableModel(model: string): boolean {
    return (
      !this.availableModelIds ||
      this.availableModelIds.size === 0 ||
      this.availableModelIds.has(model)
    )
  }

  private getCurrentModelContextWindow(
    model = this._model,
  ): number | undefined {
    return model
      ? this.availableModelsById.get(model)?.contextWindow
      : undefined
  }

  private applyCurrentModelContextWindow(model = this._model): void {
    const contextWindow = this.getCurrentModelContextWindow(model)
    if (contextWindow) {
      this.usageTracker.setContextWindow(contextWindow)
    }
  }

  private recordSessionModes(result: JsonRecord): void {
    if (this.pendingModeOverride) return

    const modeState = toRecord(result.modes)
    const currentModeId = asString(modeState.currentModeId)
    const mode = mapQwenModeToPermissionMode(currentModeId)

    if (!mode || mode === this.getPermissionMode()) return

    this.applyAcpPermissionMode(mode)
  }

  private async forwardModel(
    model: string,
    sessionId = this.qwenSessionId,
    options: { persistDefault?: boolean } = {},
  ): Promise<void> {
    if (!model || !sessionId) return
    if (!this.isKnownAvailableModel(model)) {
      this.debug(`Skipping Qwen model forward for unavailable model: ${model}`)
      return
    }

    try {
      if (options.persistDefault ?? true) {
        await this.callAcp(
          'session/set_model',
          (connection) =>
            connection.unstable_setSessionModel({
              sessionId,
              modelId: model,
            }),
          10_000,
        )
      } else {
        await this.callAcp(
          'session/set_config_option',
          (connection) =>
            connection.setSessionConfigOption({
              sessionId,
              configId: 'model',
              value: model,
            }),
          10_000,
        )
      }
    } catch (error) {
      this.debug(
        `Qwen session/set_model failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      await this.callAcp(
        'session/set_config_option',
        (connection) =>
          connection.setSessionConfigOption({
            sessionId,
            configId: 'model',
            value: model,
          }),
        10_000,
      ).catch((fallbackError) => {
        this.debug(
          `Qwen model config fallback failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
        )
      })
    }
  }

  private async applySessionSettings(sessionId: string): Promise<void> {
    if (this.hasInitialModeOverride) {
      await this.forwardPermissionMode(this.getPermissionMode(), sessionId)
    }

    if (this._model) {
      await this.forwardModel(this._model, sessionId)
    }
  }

  private async forwardPermissionMode(
    mode: PermissionMode,
    sessionId = this.qwenSessionId,
  ): Promise<void> {
    if (!sessionId || !this.connection || this.connection.signal.aborted) return
    try {
      await this.callAcp(
        'session/set_mode',
        (connection) =>
          connection.setSessionMode({
            sessionId,
            modeId: mapPermissionModeToQwen(mode),
          }),
        10_000,
      )
      if (this.pendingModeOverride === mode) {
        this.pendingModeOverride = null
      }
    } catch (error) {
      this.debug(
        `Qwen mode switch failed: ${error instanceof Error ? error.message : String(error)}`,
      )
      if (this.pendingModeOverride === mode) {
        this.pendingModeOverride = null
      }
    }
  }

  private resolvedCwd(): string {
    return (
      this.config.session?.workingDirectory ||
      this.workingDirectory ||
      this.config.workspace.rootPath ||
      process.cwd()
    )
  }

  private extractQwenRecordText(record: JsonRecord): string {
    const message = toRecord(record.message)
    const parts = Array.isArray(message.parts)
      ? message.parts.filter(isRecord)
      : []
    return parts
      .map((part) => asString(part.text))
      .filter((text): text is string => !!text)
      .join('\n\n')
  }

  private getQwenTranscriptPatchContent(record: JsonRecord): string {
    if (record.type === 'system' && record.subtype === 'slash_command') {
      const payload = toRecord(record.systemPayload)
      if (payload.phase === 'invocation') {
        return asString(payload.rawCommand) || ''
      }
    }
    return this.extractQwenRecordText(record)
  }

  private isPatchableQwenUserRecord(
    record: JsonRecord,
    sessionId: string,
  ): boolean {
    if (record.sessionId !== sessionId) return false
    if (record.type === 'user') return true
    if (record.type !== 'system' || record.subtype !== 'slash_command')
      return false
    return toRecord(record.systemPayload).phase === 'invocation'
  }

  private persistQwenTranscriptTextElements(
    sessionId: string,
    cwd: string,
    sourceElements?: MessageTextElement[],
  ): void {
    const transcriptPath = getQwenTranscriptPath(sessionId, cwd)
    if (!existsSync(transcriptPath)) return

    let fileContent: string
    try {
      fileContent = readFileSync(transcriptPath, 'utf8')
    } catch (error) {
      this.debug(
        `Failed to read Qwen transcript for text elements: ${error instanceof Error ? error.message : String(error)}`,
      )
      return
    }

    const hadTrailingNewline = fileContent.endsWith('\n')
    const lines = fileContent.split(/\r?\n/)
    if (lines[lines.length - 1] === '') lines.pop()

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]
      if (!line?.trim()) continue

      let record: JsonRecord
      try {
        record = JSON.parse(line) as JsonRecord
      } catch {
        continue
      }

      if (!this.isPatchableQwenUserRecord(record, sessionId)) continue

      const content = this.getQwenTranscriptPatchContent(record)
      const textElements = buildQwenTranscriptTextElements(
        content,
        sourceElements,
      )
      if (!textElements) return

      const existing = JSON.stringify(record.textElements ?? null)
      const next = JSON.stringify(textElements)
      if (existing === next) return

      record.textElements = textElements
      lines[index] = JSON.stringify(record)

      const tmpPath = `${transcriptPath}.craft-text-elements-${process.pid}-${Date.now()}.tmp`
      try {
        writeFileSync(
          tmpPath,
          lines.join('\n') + (hadTrailingNewline ? '\n' : ''),
          'utf8',
        )
        renameSync(tmpPath, transcriptPath)
        this.debug(
          `Wrote ${textElements.length} text element(s) into Qwen transcript ${transcriptPath}`,
        )
      } catch (error) {
        this.debug(
          `Failed to write Qwen transcript text elements: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      return
    }
  }

  private readQwenTranscriptTextElements(
    sessionId: string,
    cwd: string,
  ): Array<{ content: string; textElements: MessageTextElement[] }> {
    const transcriptPath = getQwenTranscriptPath(sessionId, cwd)
    if (!existsSync(transcriptPath)) return []

    let fileContent: string
    try {
      fileContent = readFileSync(transcriptPath, 'utf8')
    } catch {
      return []
    }

    const records: Array<{
      content: string
      textElements: MessageTextElement[]
    }> = []
    for (const line of fileContent.split(/\r?\n/)) {
      if (!line.trim()) continue

      let record: JsonRecord
      try {
        record = JSON.parse(line) as JsonRecord
      } catch {
        continue
      }

      if (!this.isPatchableQwenUserRecord(record, sessionId)) continue
      const textElements = toQwenTranscriptTextElements(record.textElements)
      if (!textElements) continue

      const content = this.getQwenTranscriptPatchContent(record)
      if (!content) continue
      records.push({ content, textElements })
    }

    return records
  }

  private applyQwenTranscriptTextElements(
    messages: Message[],
    sessionId: string,
    cwd: string,
  ): Message[] {
    const records = this.readQwenTranscriptTextElements(sessionId, cwd)
    if (records.length === 0) return messages

    const remaining = [...records]
    for (const message of messages) {
      if (message.role !== 'user' || message.textElements?.length) continue

      const index = remaining.findIndex(
        (record) => record.content === message.content,
      )
      if (index < 0) continue

      message.textElements = remaining[index]!.textElements
      remaining.splice(index, 1)
    }

    return messages
  }

  private buildAcpMcpServers(): McpServer[] {
    if (this.config.poolServerUrl) {
      return [
        {
          type: 'http',
          name: 'craft_sources',
          url: this.config.poolServerUrl,
          headers: [],
        },
      ]
    }

    return Object.entries(this.sourceMcpServers).map(([name, config]) => {
      if (config.type === 'stdio') {
        const env = new Map<string, string>()
        for (const [key, value] of Object.entries(config.env ?? {})) {
          env.set(key, value)
        }
        for (const key of config.envVars ?? []) {
          const value = process.env[key]
          if (value !== undefined) env.set(key, value)
        }
        return {
          name,
          command: config.command,
          args: config.args ?? [],
          env: [...env.entries()].map(([envName, value]) => ({
            name: envName,
            value,
          })),
        }
      }

      const headers = new Map<string, string>()
      for (const [key, value] of Object.entries(config.headers ?? {})) {
        headers.set(key, value)
      }
      if (config.bearerTokenEnvVar && process.env[config.bearerTokenEnvVar]) {
        headers.set(
          'Authorization',
          `Bearer ${process.env[config.bearerTokenEnvVar]}`,
        )
      }

      return {
        type: config.type,
        name,
        url: config.url,
        headers: [...headers.entries()].map(([headerName, value]) => ({
          name: headerName,
          value,
        })),
      }
    })
  }

  // ============================================================
  // Prompt construction
  // ============================================================

  private buildPromptBlocks(
    message: string,
    attachments?: FileAttachment[],
  ): ContentBlock[] {
    if (isSlashCommandPrompt(message, attachments)) {
      return [{ type: 'text', text: message.trim() }]
    }

    const textParts: string[] = []
    const context = INCLUDE_CRAFT_CONTEXT_IN_QWEN_PROMPTS
      ? this.buildCraftContext()
      : ''

    for (const attachment of attachments ?? []) {
      if (attachment.mimeType?.startsWith('image/') && attachment.base64) {
        continue
      }
      const filePath =
        attachment.storedPath || attachment.markdownPath || attachment.path
      if (filePath) {
        textParts.push(
          `[Attached file: ${attachment.name}]\n[Stored at: ${filePath}]`,
        )
      } else if (attachment.text) {
        textParts.push(
          `[Attached text: ${attachment.name}]\n${attachment.text}`,
        )
      }
    }

    textParts.push(message)
    const text = textParts.filter(Boolean).join('\n\n')
    const blocks: ContentBlock[] = [
      {
        type: 'text',
        text: context ? `${text}\n\n` : text,
      },
    ]

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
      })
    }

    for (const attachment of attachments ?? []) {
      if (attachment.mimeType?.startsWith('image/') && attachment.base64) {
        blocks.push({
          type: 'image',
          data: attachment.base64,
          mimeType: attachment.mimeType,
        })
      }
    }

    return blocks
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
    )

    const sourceContext = this.sourceManager.formatSourceState()
    const contextParts = this.promptBuilder.buildContextParts(
      {
        plansFolderPath: getSessionPlansPath(
          this.config.workspace.rootPath,
          this._sessionId,
        ),
      },
      sourceContext,
    )

    return [systemPrompt, ...contextParts].filter(Boolean).join('\n\n')
  }

  private buildQueryPrompt(request: LLMQueryRequest): string {
    const parts: string[] = []
    if (request.systemPrompt) {
      parts.push(`System instructions:\n${request.systemPrompt}`)
    }
    if (request.outputSchema) {
      parts.push(
        `Return a JSON value that conforms to this schema:\n${jsonStringify(request.outputSchema)}`,
      )
    }
    parts.push(request.prompt)
    return parts.join('\n\n')
  }

  // ============================================================
  // Update adaptation
  // ============================================================

  private handleSessionUpdate(params: unknown): void {
    const record = toRecord(params)
    const sessionId = asString(record.sessionId)
    const update = toRecord(record.update)
    if (!sessionId || !update.sessionUpdate) return

    const collector = this.miniCollectors.get(sessionId)
    if (collector) {
      this.collectMiniUpdate(collector, update)
      return
    }

    const historyCollector = this.historyCollectors.get(sessionId)
    if (historyCollector) {
      historyCollector.updates.push(update)
      return
    }

    if (update.sessionUpdate === 'available_commands_update') {
      this.handleOrStoreAvailableCommandsUpdate(sessionId, update)
      return
    }

    if (this.suppressedSessionUpdates.has(sessionId)) return
    if (sessionId !== this.qwenSessionId || !this._isProcessing) return

    this.captureUsage(update)

    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        this.flushThoughtText()
        this.handleAgentMessageChunk(update)
        break
      case 'agent_thought_chunk':
        this.flushAssistantText(true)
        this.handleAgentThoughtChunk(update)
        break
      case 'tool_call':
        this.flushPendingTextAsIntermediate()
        this.handleToolCall(update)
        break
      case 'tool_call_update':
        this.flushPendingTextAsIntermediate()
        this.handleToolCallUpdate(update)
        break
      case 'plan':
        this.flushPendingTextAsIntermediate()
        this.handlePlanUpdate(update)
        break
      case 'current_mode_update':
        this.handleModeUpdate(update)
        break
      default:
        break
    }
  }

  private collectMiniUpdate(
    collector: MiniCollector,
    update: JsonRecord,
  ): void {
    this.captureUsageInto(collector, update)
    if (update.sessionUpdate !== 'agent_message_chunk') return
    const content = toRecord(update.content)
    if (content.type !== 'text') return
    const text = asString(content.text)
    if (text) collector.chunks.push(text)
  }

  private buildHistoryMessages(
    sessionId: string,
    updates: JsonRecord[],
    _cwd: string,
  ): Message[] {
    const messages: Message[] = []
    const toolMessages = new Map<string, Message>()
    const activeParentToolUseIds = new Set<string>()
    let idCounter = 0
    let fallbackTimestamp = Date.now()

    const nextId = () => `qwen-${sessionId}-${++idCounter}`
    const timestampFor = (update: JsonRecord): number => {
      const meta = toRecord(update._meta)
      const timestamp = asNumber(meta.timestamp) ?? asNumber(update.timestamp)
      if (timestamp != null) return timestamp
      fallbackTimestamp += 1
      return fallbackTimestamp
    }

    const appendTextMessage = (
      role: 'user' | 'assistant',
      text: string,
      timestamp: number,
      isIntermediate?: boolean,
      intermediateKind?: IntermediateMessageKind,
      parentToolUseId?: string,
    ) => {
      if (!text) return
      const messageText =
        role === 'assistant' ? normalizeQwenAssistantText(text) : text
      const previous = messages[messages.length - 1]
      if (
        previous &&
        previous.role === role &&
        previous.timestamp === timestamp &&
        !previous.toolUseId &&
        previous.isIntermediate === isIntermediate &&
        previous.intermediateKind === intermediateKind &&
        previous.parentToolUseId === parentToolUseId
      ) {
        const nextContent = previous.content + text
        previous.content =
          role === 'assistant'
            ? normalizeQwenAssistantText(nextContent)
            : nextContent
        return
      }

      const content = messageText
      messages.push({
        id: nextId(),
        role,
        content,
        timestamp,
        isIntermediate,
        intermediateKind,
        parentToolUseId,
      })
    }

    const markTrailingAssistantAsCommentary = () => {
      const previous = messages[messages.length - 1]
      if (
        previous &&
        previous.role === 'assistant' &&
        !previous.toolUseId &&
        !previous.isIntermediate
      ) {
        previous.isIntermediate = true
        previous.intermediateKind = 'commentary'
      }
    }

    for (const update of updates) {
      const timestamp = timestampFor(update)
      const content = toRecord(update.content)
      const text = content.type === 'text' ? asString(content.text) : undefined
      const parentToolUseId = resolveQwenParentToolUseId({
        update,
        activeParentToolUseIds,
      })

      switch (update.sessionUpdate) {
        case 'user_message_chunk':
          appendTextMessage('user', text || '', timestamp)
          break

        case 'agent_message_chunk':
          appendTextMessage(
            'assistant',
            text || '',
            timestamp,
            undefined,
            undefined,
            parentToolUseId,
          )
          break

        case 'agent_thought_chunk':
          appendTextMessage(
            'assistant',
            text || '',
            timestamp,
            true,
            'thought',
            parentToolUseId,
          )
          break

        case 'tool_call': {
          markTrailingAssistantAsCommentary()
          const toolUseId =
            asString(update.toolCallId) || `qwen-history-tool-${++idCounter}`
          const rawInput = toRecord(update.rawInput)
          const meta = toRecord(update._meta)
          const kind = asString(update.kind)
          const toolName = normalizeToolName(
            asString(meta.toolName) || asString(update.title),
            kind,
          )
          const toolParentUseId = resolveQwenParentToolUseId({
            update,
            toolUseId,
            activeParentToolUseIds,
          })
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
            parentToolUseId: toolParentUseId,
          }
          messages.push(toolMessage)
          toolMessages.set(toolUseId, toolMessage)
          if (isParentTaskTool(toolName)) {
            activeParentToolUseIds.add(toolUseId)
          }
          break
        }

        case 'tool_call_update': {
          markTrailingAssistantAsCommentary()
          const toolUseId =
            asString(update.toolCallId) || `qwen-history-tool-${++idCounter}`
          const existing = toolMessages.get(toolUseId)
          const meta = toRecord(update._meta)
          const toolName = normalizeToolName(
            asString(meta.toolName) || existing?.toolName,
            asString(update.kind),
          )
          const toolParentUseId = resolveQwenParentToolUseId({
            update,
            toolUseId,
            activeParentToolUseIds,
          })
          const result = this.formatToolResult(update)
          const isError = update.status === 'failed'

          if (existing) {
            existing.toolName = existing.toolName || toolName
            existing.toolResult = result
            existing.toolStatus = isError ? 'error' : 'completed'
            existing.isError = isError
            existing.parentToolUseId =
              existing.parentToolUseId || toolParentUseId
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
              parentToolUseId: toolParentUseId,
            }
            messages.push(toolMessage)
            toolMessages.set(toolUseId, toolMessage)
          }
          if (isParentTaskTool(toolName)) {
            activeParentToolUseIds.delete(toolUseId)
          }
          break
        }

        case 'plan': {
          markTrailingAssistantAsCommentary()
          const entries = Array.isArray(update.entries) ? update.entries : []
          const todos = entries
            .filter(isRecord)
            .map((entry) => ({
              content: asString(entry.content) || '',
              status: mapPlanStatus(entry.status),
              activeForm: asString(entry.content) || '',
            }))
            .filter((todo) => todo.content)
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
          })
          break
        }

        default:
          break
      }
    }

    return messages
  }

  private mergeQwenTranscriptTelemetryMessages(
    sessionId: string,
    messages: Message[],
    cwd: string,
  ): Message[] {
    const transcriptMessages = this.loadQwenTranscriptTelemetryMessages(
      sessionId,
      cwd,
    )
    if (transcriptMessages.length === 0) return messages

    const seenToolUseIds = new Set(
      messages
        .map((message) => message.toolUseId)
        .filter((toolUseId): toolUseId is string => !!toolUseId),
    )

    const additions = transcriptMessages.filter((candidate) => {
      if (candidate.toolUseId && seenToolUseIds.has(candidate.toolUseId)) {
        return false
      }
      if (
        candidate.role !== 'tool' &&
        messages.some(
          (message) =>
            message.role === candidate.role &&
            message.content === candidate.content &&
            Math.abs(message.timestamp - candidate.timestamp) <= 1_000,
        )
      ) {
        return false
      }
      return true
    })
    if (additions.length === 0) return messages

    return [...messages, ...additions]
      .map((message, index) => ({ message, index }))
      .sort((a, b) => {
        const timestampDelta = a.message.timestamp - b.message.timestamp
        return timestampDelta !== 0 ? timestampDelta : a.index - b.index
      })
      .map(({ message }) => message)
  }

  private loadQwenTranscriptTelemetryMessages(
    sessionId: string,
    cwd: string,
  ): Message[] {
    const transcriptPath = getQwenTranscriptPath(sessionId, cwd)
    if (!existsSync(transcriptPath)) return []

    let fileContent: string
    try {
      fileContent = readFileSync(transcriptPath, 'utf8')
    } catch (error) {
      this.debug(
        `Failed to read Qwen transcript telemetry from ${transcriptPath}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return []
    }

    const messages: Message[] = []
    const parentToolUseIdsBySubagent = new Map<string, string>()
    const parentToolMessages = new Map<string, Message>()
    let fallbackParentToolUseId: string | undefined
    let idCounter = 0

    const nextId = () => `qwen-${sessionId}-transcript-${++idCounter}`
    const completeOpenParentTools = () => {
      for (const parent of parentToolMessages.values()) {
        if (parent.toolStatus !== 'executing') continue
        parent.toolStatus = 'completed'
        parent.toolResult = parent.toolResult ?? 'Completed'
      }
    }

    for (const line of fileContent.split(/\r?\n/)) {
      if (!line.trim()) continue

      let record: JsonRecord
      try {
        record = JSON.parse(line) as JsonRecord
      } catch {
        continue
      }

      if (record.sessionId !== sessionId) continue
      const timestamp = parseQwenTimestamp(record.timestamp) ?? Date.now()

      if (record.type === 'user') {
        completeOpenParentTools()
        const content = this.extractQwenRecordText(record)
        if (!content) continue
        messages.push({
          id: nextId(),
          role: 'user',
          content,
          timestamp,
        })
        continue
      }

      if (record.type === 'assistant') {
        const message = toRecord(record.message)
        const parts = Array.isArray(message.parts)
          ? message.parts.filter(isRecord)
          : []

        for (const part of parts) {
          const text = asString(part.text)
          if (text) {
            const isThought = part.thought === true
            messages.push({
              id: nextId(),
              role: 'assistant',
              content: isThought ? text : normalizeQwenAssistantText(text),
              timestamp,
              ...(isThought
                ? {
                    isIntermediate: true,
                    intermediateKind: 'thought' as const,
                  }
                : {}),
            })
          }

          const functionCall = toRecord(part.functionCall)
          const functionName = asString(functionCall.name)
          if (!functionName) continue

          const toolName = normalizeToolName(functionName)
          const toolUseId =
            asString(functionCall.id) || `qwen-transcript-tool-${++idCounter}`
          const rawInput = toRecord(functionCall.args)
          const toolMessage: Message = {
            id: nextId(),
            role: 'tool',
            content: `Running ${toolName}...`,
            timestamp,
            toolName,
            toolUseId,
            toolInput: rawInput,
            toolStatus: 'executing',
            toolIntent: asString(rawInput.description),
            toolDisplayName: displayNameForTool(toolName),
          }
          messages.push(toolMessage)

          if (isParentTaskTool(toolName)) {
            fallbackParentToolUseId = toolUseId
            parentToolMessages.set(toolUseId, toolMessage)
            const subagentType = asString(rawInput.subagent_type)
            if (subagentType) {
              parentToolUseIdsBySubagent.set(subagentType, toolUseId)
            }
          }
        }
        continue
      }

      const telemetryMessage = this.buildQwenTranscriptTelemetryMessage({
        record,
        timestamp,
        nextId,
        parentToolUseIdsBySubagent,
        fallbackParentToolUseId,
      })
      if (telemetryMessage) messages.push(telemetryMessage)
    }

    if (!(this._isProcessing && sessionId === this.qwenSessionId)) {
      completeOpenParentTools()
    }

    return messages
  }

  private buildQwenTranscriptTelemetryMessage(args: {
    record: JsonRecord
    timestamp: number
    nextId: () => string
    parentToolUseIdsBySubagent: ReadonlyMap<string, string>
    fallbackParentToolUseId?: string
  }): Message | undefined {
    const { record, timestamp, nextId, parentToolUseIdsBySubagent } = args
    if (record.type !== 'system' || record.subtype !== 'ui_telemetry') {
      return undefined
    }

    const payload = toRecord(record.systemPayload)
    const uiEvent = toRecord(payload.uiEvent)
    if (uiEvent['event.name'] !== 'qwen-code.tool_call') return undefined

    const toolName = normalizeToolName(asString(uiEvent.function_name))
    const toolUseId =
      asString(record.uuid) || `qwen-transcript-tool-${nextId()}`
    const input = toRecord(uiEvent.function_args)
    const isError = uiEvent.success === false || uiEvent.status === 'error'
    const error = asString(uiEvent.error)
    const contentLength = asNumber(uiEvent.content_length)
    const toolResult = isError
      ? error || 'Tool failed'
      : contentLength != null
        ? `Completed (${contentLength} bytes)`
        : 'Completed'

    return {
      id: nextId(),
      role: 'tool',
      content: '',
      timestamp,
      toolName,
      toolUseId,
      toolInput: input,
      toolResult,
      toolStatus: isError ? 'error' : 'completed',
      toolDisplayName: displayNameForTool(toolName),
      parentToolUseId: this.resolveQwenTranscriptTelemetryParent(
        uiEvent,
        parentToolUseIdsBySubagent,
        args.fallbackParentToolUseId,
      ),
      ...(isError ? { isError } : {}),
    }
  }

  private resolveQwenTranscriptTelemetryParent(
    uiEvent: JsonRecord,
    parentToolUseIdsBySubagent: ReadonlyMap<string, string>,
    fallbackParentToolUseId?: string,
  ): string | undefined {
    const subagentName = asString(uiEvent.subagent_name)
    if (subagentName) {
      const parentToolUseId = parentToolUseIdsBySubagent.get(subagentName)
      if (parentToolUseId) return parentToolUseId
    }

    const promptId = asString(uiEvent.prompt_id)
    const promptSubagentName = promptId?.match(/#([^#]+?)-[^#]+#/)?.[1]
    if (promptSubagentName) {
      const parentToolUseId = parentToolUseIdsBySubagent.get(promptSubagentName)
      if (parentToolUseId) return parentToolUseId
    }

    return parentToolUseIdsBySubagent.size === 1
      ? [...parentToolUseIdsBySubagent.values()][0]
      : fallbackParentToolUseId
  }

  private mergeSlashCommandInvocationMessages(
    sessionId: string,
    messages: Message[],
    cwd: string,
  ): Message[] {
    const slashMessages = this.loadSlashCommandInvocationMessages(
      sessionId,
      cwd,
    )
    if (slashMessages.length === 0) return messages

    const additions = slashMessages.filter(
      (slashMessage) =>
        !messages.some((message) =>
          this.isSameSlashCommandInvocationMessage(message, slashMessage),
        ),
    )
    if (additions.length === 0) return messages

    return [...messages, ...additions]
      .map((message, index) => ({ message, index }))
      .sort((a, b) => {
        const timestampDelta = a.message.timestamp - b.message.timestamp
        if (timestampDelta !== 0) return timestampDelta
        if (a.message.role === 'user' && b.message.role !== 'user') return -1
        if (a.message.role !== 'user' && b.message.role === 'user') return 1
        return a.index - b.index
      })
      .map(({ message }) => message)
  }

  private isSameSlashCommandInvocationMessage(
    message: Message,
    slashMessage: Message,
  ): boolean {
    const messageContent =
      message.role === 'assistant'
        ? normalizeQwenAssistantText(message.content).trim()
        : message.content.trim()

    return (
      message.role === slashMessage.role &&
      messageContent === slashMessage.content.trim() &&
      Math.abs(message.timestamp - slashMessage.timestamp) <= 10_000
    )
  }

  private loadSlashCommandInvocationMessages(
    sessionId: string,
    cwd: string,
  ): Message[] {
    const transcriptPath = getQwenTranscriptPath(sessionId, cwd)
    if (!existsSync(transcriptPath)) return []

    const invocations = new Map<string, SlashCommandInvocation>()
    const seenResults = new Set<string>()
    const messages: Message[] = []
    let idCounter = 0

    try {
      const lines = readFileSync(transcriptPath, 'utf8').split(/\r?\n/)
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        let record: JsonRecord
        try {
          record = toRecord(JSON.parse(trimmed))
        } catch {
          continue
        }

        if (record.type !== 'system' || record.subtype !== 'slash_command')
          continue

        const payload = toRecord(record.systemPayload)
        const rawCommand = asString(payload.rawCommand)?.trim()
        if (!rawCommand) continue

        const phase = asString(payload.phase)
        const timestamp = parseQwenTimestamp(record.timestamp) ?? Date.now()
        if (phase === 'invocation') {
          const uuid = asString(record.uuid)
          if (uuid) invocations.set(uuid, { rawCommand, timestamp })
          continue
        }

        if (phase !== 'result') continue

        const outputItems = Array.isArray(payload.outputHistoryItems)
          ? payload.outputHistoryItems
          : []
        const outputTexts = outputItems
          .filter(isRecord)
          .map(formatQwenSlashOutputHistoryItem)
          .filter((text): text is string => !!text?.trim())
        if (outputTexts.length === 0) continue

        const parentUuid = asString(record.parentUuid)
        const resultKey = parentUuid || `${rawCommand}:${timestamp}`
        if (seenResults.has(resultKey)) continue
        seenResults.add(resultKey)

        const invocation = parentUuid ? invocations.get(parentUuid) : undefined
        const userContent = invocation?.rawCommand || rawCommand
        messages.push({
          id: `qwen-${sessionId}-slash-${++idCounter}`,
          role: 'user',
          content: userContent,
          timestamp: invocation?.timestamp ?? timestamp,
        })
        messages.push({
          id: `qwen-${sessionId}-slash-${++idCounter}`,
          role: 'assistant',
          content: outputTexts.join('\n\n'),
          timestamp,
        })
      }
    } catch (error) {
      this.debug(
        `Failed to read Qwen slash command history from ${transcriptPath}: ${error instanceof Error ? error.message : String(error)}`,
      )
      return []
    }

    return messages
  }

  private handleAgentMessageChunk(update: JsonRecord): void {
    const content = toRecord(update.content)
    if (content.type !== 'text') return
    const text = asString(content.text)
    if (!text) return
    const parentToolUseId = resolveQwenParentToolUseId({
      update,
      activeParentToolUseIds: this.activeParentToolUseIds,
    })
    if (
      this.currentAssistantText &&
      this.currentAssistantParentToolUseId !== parentToolUseId
    ) {
      this.flushAssistantText(true)
    }
    this.currentAssistantParentToolUseId = parentToolUseId
    this.currentAssistantText += text
    this.eventQueue.enqueue({
      type: 'text_delta',
      text,
      turnId: this.currentTurnId,
      parentToolUseId,
    })
  }

  private handleAgentThoughtChunk(update: JsonRecord): void {
    const content = toRecord(update.content)
    if (content.type !== 'text') return
    const text = asString(content.text)
    if (!text) return
    const parentToolUseId = resolveQwenParentToolUseId({
      update,
      activeParentToolUseIds: this.activeParentToolUseIds,
    })
    if (
      this.currentThoughtText &&
      this.currentThoughtParentToolUseId !== parentToolUseId
    ) {
      this.flushThoughtText()
    }
    this.currentThoughtParentToolUseId = parentToolUseId
    this.currentThoughtText += text
    this.eventQueue.enqueue({
      type: 'text_delta',
      text,
      turnId: this.currentTurnId,
      parentToolUseId,
    })
  }

  private flushPendingTextAsIntermediate(): void {
    this.flushThoughtText()
    this.flushAssistantText(true)
  }

  private flushThoughtText(): void {
    if (!this.currentThoughtText) return
    this.eventQueue.enqueue({
      type: 'text_complete',
      text: this.currentThoughtText,
      isIntermediate: true,
      intermediateKind: 'thought',
      turnId: this.currentTurnId,
      parentToolUseId: this.currentThoughtParentToolUseId,
    })
    this.currentThoughtText = ''
    this.currentThoughtParentToolUseId = undefined
  }

  private flushAssistantText(isIntermediate?: boolean): void {
    if (!this.currentAssistantText) return
    const text = normalizeQwenAssistantText(this.currentAssistantText, {
      forceJsonFence: this.currentIsSlashCommand,
    })
    this.eventQueue.enqueue({
      type: 'text_complete',
      text,
      ...(isIntermediate !== undefined ? { isIntermediate } : {}),
      ...(isIntermediate ? { intermediateKind: 'commentary' as const } : {}),
      turnId: this.currentTurnId,
      parentToolUseId: this.currentAssistantParentToolUseId,
    })
    this.currentAssistantText = ''
    this.currentAssistantParentToolUseId = undefined
  }

  private handleToolCall(update: JsonRecord): void {
    const toolUseId =
      asString(update.toolCallId) || `qwen-tool-${++this.toolIdCounter}`
    const rawInput = toRecord(update.rawInput)
    const meta = toRecord(update._meta)
    const kind = asString(update.kind)
    const toolName = normalizeToolName(
      asString(meta.toolName) || asString(update.title),
      kind,
    )
    const title = asString(update.title)
    const parentToolUseId = resolveQwenParentToolUseId({
      update,
      toolUseId,
      activeParentToolUseIds: this.activeParentToolUseIds,
    })

    this.toolNames.set(toolUseId, toolName)
    this.toolInputs.set(toolUseId, rawInput)

    this.eventQueue.enqueue({
      type: 'tool_start',
      toolName,
      toolUseId,
      input: rawInput,
      intent: title,
      displayName: displayNameForTool(toolName, kind),
      turnId: this.currentTurnId,
      parentToolUseId,
    })

    if (isParentTaskTool(toolName)) {
      this.activeParentToolUseIds.add(toolUseId)
    }
  }

  private handleToolCallUpdate(update: JsonRecord): void {
    const toolUseId =
      asString(update.toolCallId) || `qwen-tool-${++this.toolIdCounter}`
    const meta = toRecord(update._meta)
    const toolName =
      this.toolNames.get(toolUseId) ||
      normalizeToolName(asString(meta.toolName), asString(update.kind))
    const parentToolUseId = resolveQwenParentToolUseId({
      update,
      toolUseId,
      activeParentToolUseIds: this.activeParentToolUseIds,
    })
    const result = this.formatToolResult(update)
    const isError = update.status === 'failed'

    this.eventQueue.enqueue({
      type: 'tool_result',
      toolUseId,
      toolName,
      result,
      isError,
      input: this.toolInputs.get(toolUseId),
      turnId: this.currentTurnId,
      parentToolUseId,
    })

    if (isParentTaskTool(toolName)) {
      this.activeParentToolUseIds.delete(toolUseId)
    }
  }

  private handlePlanUpdate(update: JsonRecord): void {
    const entries = Array.isArray(update.entries) ? update.entries : []
    const todos = entries
      .filter(isRecord)
      .map((entry) => ({
        content: asString(entry.content) || '',
        status: mapPlanStatus(entry.status),
        activeForm: asString(entry.content) || '',
      }))
      .filter((todo) => todo.content)

    const toolUseId = `qwen-plan-${++this.planUpdateCounter}`
    const input = { todos }
    this.eventQueue.enqueue({
      type: 'tool_start',
      toolName: 'TodoWrite',
      toolUseId,
      input,
      displayName: 'Todo List Updated',
      turnId: this.currentTurnId,
    })
    this.eventQueue.enqueue({
      type: 'tool_result',
      toolUseId,
      toolName: 'TodoWrite',
      result: 'Todo list updated',
      isError: false,
      input,
      turnId: this.currentTurnId,
    })
  }

  private handleModeUpdate(update: JsonRecord): void {
    const modeId = asString(update.modeId) || asString(update.currentModeId)
    const mode = mapQwenModeToPermissionMode(modeId)
    if (!mode || mode === this.getPermissionMode()) return
    this.applyAcpPermissionMode(mode)
  }

  private applyAcpPermissionMode(mode: PermissionMode): void {
    if (this.pendingModeOverride) {
      if (mode !== this.pendingModeOverride) return
      this.pendingModeOverride = null
    }

    if (mode === this.getPermissionMode()) return
    this.permissionManager.setPermissionMode(mode)
    this.onPermissionModeChange?.(mode)
  }

  private parseAvailableCommandsUpdate(
    update: JsonRecord,
  ): AvailableCommandsSnapshot | null {
    const availableCommands = toAvailableSlashCommands(update.availableCommands)
    const meta = toRecord(update._meta)
    const availableSkillDetails = toAvailableSkillDetails(
      meta.availableSkillDetails,
    )
    const availableSkills =
      toAvailableSkills(meta.availableSkills) ??
      availableSkillDetails?.map((skill) => skill.name)

    if (
      availableCommands.length === 0 &&
      (!availableSkills || availableSkills.length === 0)
    ) {
      return null
    }

    return {
      availableCommands,
      ...(availableSkills ? { availableSkills } : {}),
      ...(availableSkillDetails ? { availableSkillDetails } : {}),
    }
  }

  private extractAvailableCommandsSnapshot(
    updates: JsonRecord[],
  ): AvailableCommandsSnapshot | null {
    let latest: AvailableCommandsSnapshot | null = null
    for (const update of updates) {
      if (update.sessionUpdate !== 'available_commands_update') continue
      const snapshot = this.parseAvailableCommandsUpdate(update)
      if (snapshot) latest = snapshot
    }

    if (latest) {
      this.latestAvailableCommandsSnapshot = latest
      this.resolveAvailableCommandsWaiters(latest)
      this.debug(
        `Qwen loadSessionMessages captured available commands: commands=${latest.availableCommands.length} ` +
          `skills=${latest.availableSkills?.length ?? 0} ` +
          `skillDetails=${latest.availableSkillDetails?.length ?? 0} ` +
          `names=${formatDebugNames(latest.availableCommands.map((command) => command.name))} ` +
          `skillNames=${formatDebugNames(latest.availableSkills)}`,
      )
    }

    return latest
  }

  private handleAvailableCommandsUpdate(update: JsonRecord): void {
    const snapshot = this.parseAvailableCommandsUpdate(update)

    if (!snapshot) {
      this.debug(
        'Qwen available_commands_update ignored because it contained no commands or skills',
      )
      return
    }

    this.debug(
      `Qwen available_commands_update parsed: commands=${snapshot.availableCommands.length} ` +
        `skills=${snapshot.availableSkills?.length ?? 0} ` +
        `skillDetails=${snapshot.availableSkillDetails?.length ?? 0} ` +
        `names=${formatDebugNames(snapshot.availableCommands.map((command) => command.name))} ` +
        `skillNames=${formatDebugNames(snapshot.availableSkills)}`,
    )

    this.latestAvailableCommandsSnapshot = snapshot
    this.resolveAvailableCommandsWaiters(snapshot)

    this.eventQueue.enqueue({
      type: 'available_commands_update',
      availableCommands: snapshot.availableCommands,
      availableSkills: snapshot.availableSkills,
      ...(snapshot.availableSkillDetails
        ? { availableSkillDetails: snapshot.availableSkillDetails }
        : {}),
    })
  }

  private handleOrStoreAvailableCommandsUpdate(
    sessionId: string,
    update: JsonRecord,
  ): void {
    if (
      sessionId === this.qwenSessionId &&
      !this.suppressedSessionUpdates.has(sessionId)
    ) {
      this.debug(
        `Qwen available_commands_update received for active session ${sessionId}`,
      )
      this.handleAvailableCommandsUpdate(update)
      return
    }

    this.debug(
      `Qwen available_commands_update buffered: updateSession=${sessionId} ` +
        `currentSession=${this.qwenSessionId ?? 'none'} ` +
        `suppressed=${this.suppressedSessionUpdates.has(sessionId)}`,
    )
    this.pendingAvailableCommandsUpdates.set(sessionId, update)
  }

  private flushPendingAvailableCommandsUpdate(sessionId: string): void {
    const update = this.pendingAvailableCommandsUpdates.get(sessionId)
    if (!update) return
    this.pendingAvailableCommandsUpdates.delete(sessionId)
    this.debug(
      `Qwen available_commands_update flushing buffered update for session ${sessionId}`,
    )
    this.handleAvailableCommandsUpdate(update)
  }

  private waitForAvailableCommandsSnapshot(
    timeoutMs = 2_000,
  ): Promise<AvailableCommandsSnapshot | null> {
    if (this.latestAvailableCommandsSnapshot) {
      return Promise.resolve(this.latestAvailableCommandsSnapshot)
    }

    return new Promise((resolve) => {
      let settled = false
      const waiter = (snapshot: AvailableCommandsSnapshot | null) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        this.availableCommandsWaiters = this.availableCommandsWaiters.filter(
          (item) => item !== waiter,
        )
        resolve(snapshot)
      }
      const timeout = setTimeout(() => {
        this.debug(
          `Qwen slash command refresh wait timed out after ${timeoutMs}ms`,
        )
        waiter(null)
      }, timeoutMs)
      this.availableCommandsWaiters.push(waiter)
    })
  }

  private resolveAvailableCommandsWaiters(
    snapshot: AvailableCommandsSnapshot | null,
  ): void {
    const waiters = this.availableCommandsWaiters.splice(0)
    if (waiters.length > 0) {
      this.debug(
        `Qwen resolving ${waiters.length} slash command refresh waiter(s)`,
      )
    }
    for (const resolve of waiters) {
      resolve(snapshot)
    }
  }

  private formatToolResult(update: JsonRecord): string {
    const content = Array.isArray(update.content) ? update.content : []
    const parts: string[] = []

    for (const item of content) {
      if (!isRecord(item)) continue
      if (item.type === 'content') {
        const inner = toRecord(item.content)
        if (inner.type === 'text' && typeof inner.text === 'string') {
          parts.push(inner.text)
        } else {
          parts.push(jsonStringify(inner))
        }
      } else if (item.type === 'diff') {
        const path = asString(item.path) || 'file'
        parts.push(`Updated ${path}`)
      } else if (item.type === 'terminal') {
        parts.push(jsonStringify(item))
      }
    }

    if (parts.length > 0) return parts.join('\n\n')
    if ('rawOutput' in update)
      return typeof update.rawOutput === 'string'
        ? update.rawOutput
        : jsonStringify(update.rawOutput)
    return update.status === 'failed' ? 'Tool failed' : 'Tool completed'
  }

  private captureUsage(update: JsonRecord): void {
    const usage = this.extractUsage(update)
    if (!usage) return
    const contextWindow = this.getCurrentModelContextWindow()
    this.eventQueue.enqueue({
      type: 'usage_update',
      usage: {
        inputTokens: usage.contextTokens,
        ...(contextWindow ? { contextWindow } : {}),
      },
    })
  }

  private captureUsageInto(collector: MiniCollector, update: JsonRecord): void {
    const usage = this.extractUsage(update)
    if (!usage) return
    collector.inputTokens = usage.inputTokens
    collector.outputTokens = usage.outputTokens
  }

  private extractUsage(update: JsonRecord): ExtractedUsage | null {
    const meta = toRecord(update._meta)
    const usage = toRecord(meta.usage)
    if (Object.keys(usage).length === 0) return null

    const inputTokens =
      asNumber(usage.inputTokens) ??
      asNumber(usage.promptTokens) ??
      asNumber(usage.promptTokenCount) ??
      0
    const outputTokens =
      asNumber(usage.outputTokens) ??
      asNumber(usage.completionTokens) ??
      asNumber(usage.candidatesTokenCount)
    const totalTokens =
      asNumber(usage.totalTokens) ?? asNumber(usage.totalTokenCount)
    const contextTokens =
      totalTokens !== undefined && totalTokens > 0 ? totalTokens : inputTokens

    return { inputTokens, contextTokens, outputTokens }
  }

  // ============================================================
  // Permissions
  // ============================================================

  private handlePermissionRequest(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const record = toRecord(params)
    const toolCall = toRecord(record.toolCall)
    const options = Array.isArray(record.options)
      ? (record.options.filter(isRecord) as AcpPermissionOption[])
      : []

    const kind = asString(toolCall.kind)
    const rawInput = toRecord(toolCall.rawInput)
    const title = asString(toolCall.title) || 'Qwen Code requests permission'
    const toolName = normalizeToolName(
      asString(toRecord(toolCall._meta).toolName) || title,
      kind,
    )
    const command = asString(rawInput.command) || asString(rawInput.cmd)
    const questions = parseAskUserQuestions(rawInput.questions)
    const isAskUserQuestion = toolName === 'ask_user_question' || !!questions
    const metadata = isRecord(rawInput.metadata)
      ? { source: asString(rawInput.metadata.source) }
      : undefined

    if (!this.onPermissionRequest) {
      const autoAllow = this.getPermissionMode() === 'allow-all'
      return Promise.resolve(
        this.createPermissionResponse(options, autoAllow, autoAllow),
      )
    }

    return new Promise<RequestPermissionResponse>((resolve) => {
      const requestId = `qwen-permission-${++this.permissionRequestCounter}`
      this.pendingPermissions.set(requestId, { resolve, options })

      try {
        this.onPermissionRequest?.({
          requestId,
          toolName,
          command,
          description: title,
          type: isAskUserQuestion
            ? 'ask_user_question'
            : permissionTypeForKind(kind),
          reason: asString(rawInput.reason),
          impact: this.permissionImpact(toolCall),
          questions,
          metadata,
        })
      } catch (error) {
        this.debug(
          `Qwen permission callback failed: ${error instanceof Error ? error.message : String(error)}`,
        )
        this.pendingPermissions.delete(requestId)
        resolve(this.createPermissionResponse(options, false, false))
      }
    })
  }

  private permissionImpact(toolCall: JsonRecord): string | undefined {
    const content = Array.isArray(toolCall.content) ? toolCall.content : []
    for (const item of content) {
      if (!isRecord(item)) continue
      if (item.type === 'diff') {
        return `Will modify ${asString(item.path) || 'a file'}`
      }
      if (item.type === 'content') {
        const inner = toRecord(item.content)
        const text = asString(inner.text)
        if (text) return text.slice(0, 500)
      }
    }
    return undefined
  }

  private selectPermissionOption(
    options: AcpPermissionOption[],
    alwaysAllow: boolean,
  ): string {
    if (alwaysAllow) {
      const always = options.find(
        (option) =>
          option.kind === 'allow_always' || option.optionId?.includes('always'),
      )
      if (always?.optionId) return always.optionId
    }

    const once = options.find(
      (option) =>
        option.optionId === 'proceed_once' || option.kind === 'allow_once',
    )
    if (once?.optionId) return once.optionId

    const firstAllow = options.find(
      (option) => option.kind !== 'reject_once' && option.optionId,
    )
    return firstAllow?.optionId || 'proceed_once'
  }

  private createPermissionResponse(
    options: AcpPermissionOption[],
    allowed: boolean,
    alwaysAllow: boolean,
    answers?: Record<string, string>,
  ): RequestPermissionResponse & { answers?: Record<string, string> } {
    if (!allowed) {
      return { outcome: { outcome: 'cancelled' } }
    }

    return {
      outcome: {
        outcome: 'selected',
        optionId: this.selectPermissionOption(options, alwaysAllow),
      },
      ...(answers ? { answers } : {}),
    }
  }

  private cancelPendingPermissions(): void {
    for (const [, pending] of this.pendingPermissions) {
      pending.resolve(
        this.createPermissionResponse(pending.options, false, false),
      )
    }
    this.pendingPermissions.clear()
  }

  protected override debug(message: string): void {
    this.onDebug?.(`[QwenAgent] ${message}`)
  }
}

export { QwenAgent as QwenBackend }
