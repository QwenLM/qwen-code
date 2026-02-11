/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Node built-ins
import type { EventEmitter } from 'node:events';
import * as path from 'node:path';
import process from 'node:process';

// External dependencies
import { ProxyAgent, setGlobalDispatcher } from 'undici';

// Types
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../core/contentGenerator.js';
import type { ContentGeneratorConfigSources } from '../core/contentGenerator.js';
import type { MCPOAuthConfig } from '../mcp/oauth-provider.js';
import type { ShellExecutionConfig } from '../services/shellExecutionService.js';
import type { AnyToolInvocation } from '../tools/tools.js';

// Core
import { BaseLlmClient } from '../core/baseLlmClient.js';
import { GeminiClient } from '../core/client.js';
import {
  AuthType,
  createContentGenerator,
  resolveContentGeneratorConfigWithSources,
} from '../core/contentGenerator.js';

// Services
import { FileDiscoveryService } from '../services/fileDiscoveryService.js';
import {
  type FileSystemService,
  StandardFileSystemService,
  type FileEncodingType,
  FileEncoding,
} from '../services/fileSystemService.js';
import { GitService } from '../services/gitService.js';

// Tools
import { EditTool } from '../tools/edit.js';
import { ExitPlanModeTool } from '../tools/exitPlanMode.js';
import { GlobTool } from '../tools/glob.js';
import { GrepTool } from '../tools/grep.js';
import { LSTool } from '../tools/ls.js';
import type { SendSdkMcpMessage } from '../tools/mcp-client.js';
import { MemoryTool, setGeminiMdFilename } from '../tools/memoryTool.js';
import { ReadFileTool } from '../tools/read-file.js';
import { canUseRipgrep } from '../utils/ripgrepUtils.js';
import { RipGrepTool } from '../tools/ripGrep.js';
import { ShellTool } from '../tools/shell.js';
import { SkillTool } from '../tools/skill.js';
import { TaskTool } from '../tools/task.js';
import { TodoWriteTool } from '../tools/todoWrite.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import { WebFetchTool } from '../tools/web-fetch.js';
import { WebSearchTool } from '../tools/web-search/index.js';
import { WriteFileTool } from '../tools/write-file.js';
import { LspTool } from '../tools/lsp.js';
import type { LspClient } from '../lsp/types.js';

// Other modules
import { ideContextStore } from '../ide/ideContext.js';
import { InputFormat, OutputFormat } from '../output/types.js';
import { PromptRegistry } from '../prompts/prompt-registry.js';
import { SkillManager } from '../skills/skill-manager.js';
import { SubagentManager } from '../subagents/subagent-manager.js';
import type { SubagentConfig } from '../subagents/types.js';
import {
  DEFAULT_OTLP_ENDPOINT,
  DEFAULT_TELEMETRY_TARGET,
  initializeTelemetry,
  logStartSession,
  logRipgrepFallback,
  RipgrepFallbackEvent,
  StartSessionEvent,
  type TelemetryTarget,
} from '../telemetry/index.js';
import {
  ExtensionManager,
  type Extension,
} from '../extension/extensionManager.js';

// Utils
import { shouldAttemptBrowserLaunch } from '../utils/browser.js';
import { FileExclusions } from '../utils/ignorePatterns.js';
import { WorkspaceContext } from '../utils/workspaceContext.js';
import { isToolEnabled, type ToolName } from '../utils/tool-utils.js';
import { getErrorMessage } from '../utils/errors.js';

// Local config modules
import type { FileFilteringOptions } from './constants.js';
import {
  DEFAULT_FILE_FILTERING_OPTIONS,
  DEFAULT_MEMORY_FILE_FILTERING_OPTIONS,
} from './constants.js';
import { DEFAULT_QWEN_EMBEDDING_MODEL } from './models.js';
import { Storage } from './storage.js';
import { ChatRecordingService } from '../services/chatRecordingService.js';
import {
  SessionService,
  type ResumedSessionData,
} from '../services/sessionService.js';
import { randomUUID } from 'node:crypto';
import { loadServerHierarchicalMemory } from '../utils/memoryDiscovery.js';
import {
  createDebugLogger,
  setDebugLogSession,
  type DebugLogger,
} from '../utils/debugLogger.js';

import {
  ModelsConfig,
  type ModelProvidersConfig,
  type AvailableModel,
  type RuntimeModelSnapshot,
} from '../models/index.js';
import type { ClaudeMarketplaceConfig } from '../extension/claude-converter.js';

// Re-export types
export type { AnyToolInvocation, FileFilteringOptions, MCPOAuthConfig };
export {
  DEFAULT_FILE_FILTERING_OPTIONS,
  DEFAULT_MEMORY_FILE_FILTERING_OPTIONS,
};

export enum ApprovalMode {
  PLAN = 'plan',
  DEFAULT = 'default',
  AUTO_EDIT = 'auto-edit',
  YOLO = 'yolo',
}

export const APPROVAL_MODES = Object.values(ApprovalMode);

/**
 * Information about an approval mode including display name and description.
 */
export interface ApprovalModeInfo {
  id: ApprovalMode;
  name: string;
  description: string;
}

/**
 * Detailed information about each approval mode.
 * Used for UI display and protocol responses.
 */
export const APPROVAL_MODE_INFO: Record<ApprovalMode, ApprovalModeInfo> = {
  [ApprovalMode.PLAN]: {
    id: ApprovalMode.PLAN,
    name: 'Plan',
    description: 'Analyze only, do not modify files or execute commands',
  },
  [ApprovalMode.DEFAULT]: {
    id: ApprovalMode.DEFAULT,
    name: 'Default',
    description: 'Require approval for file edits or shell commands',
  },
  [ApprovalMode.AUTO_EDIT]: {
    id: ApprovalMode.AUTO_EDIT,
    name: 'Auto Edit',
    description: 'Automatically approve file edits',
  },
  [ApprovalMode.YOLO]: {
    id: ApprovalMode.YOLO,
    name: 'YOLO',
    description: 'Automatically approve all tools',
  },
};

export interface AccessibilitySettings {
  enableLoadingPhrases?: boolean;
  screenReader?: boolean;
}

export interface BugCommandSettings {
  urlTemplate: string;
}

export interface ChatCompressionSettings {
  contextPercentageThreshold?: number;
}

export interface SummarizeToolOutputSettings {
  tokenBudget?: number;
}

export interface TelemetrySettings {
  enabled?: boolean;
  target?: TelemetryTarget;
  otlpEndpoint?: string;
  otlpProtocol?: 'grpc' | 'http';
  logPrompts?: boolean;
  outfile?: string;
  useCollector?: boolean;
}

export interface OutputSettings {
  format?: OutputFormat;
}

export interface GitCoAuthorSettings {
  enabled?: boolean;
  name?: string;
  email?: string;
}

export type ExtensionOriginSource = 'QwenCode' | 'Claude' | 'Gemini';

export interface ExtensionInstallMetadata {
  source: string;
  type: 'git' | 'local' | 'link' | 'github-release';
  originSource?: ExtensionOriginSource;
  releaseTag?: string; // Only present for github-release installs.
  ref?: string;
  autoUpdate?: boolean;
  allowPreRelease?: boolean;
  marketplaceConfig?: ClaudeMarketplaceConfig;
  pluginName?: string;
}

export const DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD = 25_000;
export const DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES = 1000;

export class MCPServerConfig {
  constructor(
    // For stdio transport
    readonly command?: string,
    readonly args?: string[],
    readonly env?: Record<string, string>,
    readonly cwd?: string,
    // For sse transport
    readonly url?: string,
    // For streamable http transport
    readonly httpUrl?: string,
    readonly headers?: Record<string, string>,
    // For websocket transport
    readonly tcp?: string,
    // Common
    readonly timeout?: number,
    readonly trust?: boolean,
    // Metadata
    readonly description?: string,
    readonly includeTools?: string[],
    readonly excludeTools?: string[],
    readonly extensionName?: string,
    // OAuth configuration
    readonly oauth?: MCPOAuthConfig,
    readonly authProviderType?: AuthProviderType,
    // Service Account Configuration
    /* targetAudience format: CLIENT_ID.apps.googleusercontent.com */
    readonly targetAudience?: string,
    /* targetServiceAccount format: <service-account-name>@<project-num>.iam.gserviceaccount.com */
    readonly targetServiceAccount?: string,
    // SDK MCP server type - 'sdk' indicates server runs in SDK process
    readonly type?: 'sdk',
  ) {}
}

/**
 * Check if an MCP server config represents an SDK server
 */
export function isSdkMcpServerConfig(config: MCPServerConfig): boolean {
  return config.type === 'sdk';
}

export enum AuthProviderType {
  DYNAMIC_DISCOVERY = 'dynamic_discovery',
  GOOGLE_CREDENTIALS = 'google_credentials',
  SERVICE_ACCOUNT_IMPERSONATION = 'service_account_impersonation',
}

export interface SandboxConfig {
  command: 'docker' | 'podman' | 'sandbox-exec';
  image: string;
}

export interface ConfigParameters {
  sessionId?: string;
  sessionData?: ResumedSessionData;
  embeddingModel?: string;
  sandbox?: SandboxConfig;
  targetDir: string;
  debugMode: boolean;
  includePartialMessages?: boolean;
  question?: string;
  coreTools?: string[];
  allowedTools?: string[];
  excludeTools?: string[];
  toolDiscoveryCommand?: string;
  toolCallCommand?: string;
  mcpServerCommand?: string;
  mcpServers?: Record<string, MCPServerConfig>;
  lsp?: {
    enabled?: boolean;
  };
  lspClient?: LspClient;
  userMemory?: string;
  geminiMdFileCount?: number;
  approvalMode?: ApprovalMode;
  contextFileName?: string | string[];
  accessibility?: AccessibilitySettings;
  telemetry?: TelemetrySettings;
  gitCoAuthor?: boolean;
  usageStatisticsEnabled?: boolean;
  fileFiltering?: {
    respectGitIgnore?: boolean;
    respectQwenIgnore?: boolean;
    enableRecursiveFileSearch?: boolean;
    enableFuzzySearch?: boolean;
  };
  checkpointing?: boolean;
  proxy?: string;
  cwd: string;
  fileDiscoveryService?: FileDiscoveryService;
  includeDirectories?: string[];
  bugCommand?: BugCommandSettings;
  model?: string;
  outputLanguageFilePath?: string;
  maxSessionTurns?: number;
  sessionTokenLimit?: number;
  experimentalZedIntegration?: boolean;
  listExtensions?: boolean;
  overrideExtensions?: string[];
  allowedMcpServers?: string[];
  excludedMcpServers?: string[];
  noBrowser?: boolean;
  summarizeToolOutput?: Record<string, SummarizeToolOutputSettings>;
  folderTrustFeature?: boolean;
  folderTrust?: boolean;
  ideMode?: boolean;
  authType?: AuthType;
  generationConfig?: Partial<ContentGeneratorConfig>;
  /**
   * Optional source map for generationConfig fields (e.g. CLI/env/settings attribution).
   * This is used to produce per-field source badges in the UI.
   */
  generationConfigSources?: ContentGeneratorConfigSources;
  cliVersion?: string;
  loadMemoryFromIncludeDirectories?: boolean;
  importFormat?: 'tree' | 'flat';
  chatRecording?: boolean;
  // Web search providers
  webSearch?: {
    provider: Array<{
      type: 'tavily' | 'google' | 'dashscope';
      apiKey?: string;
      searchEngineId?: string;
    }>;
    default: string;
  };
  chatCompression?: ChatCompressionSettings;
  interactive?: boolean;
  trustedFolder?: boolean;
  defaultFileEncoding?: FileEncodingType;
  useRipgrep?: boolean;
  useBuiltinRipgrep?: boolean;
  shouldUseNodePtyShell?: boolean;
  skipNextSpeakerCheck?: boolean;
  shellExecutionConfig?: ShellExecutionConfig;
  skipLoopDetection?: boolean;
  vlmSwitchMode?: string;
  truncateToolOutputThreshold?: number;
  truncateToolOutputLines?: number;
  enableToolOutputTruncation?: boolean;
  eventEmitter?: EventEmitter;
  output?: OutputSettings;
  inputFormat?: InputFormat;
  outputFormat?: OutputFormat;
  skipStartupContext?: boolean;
  sdkMode?: boolean;
  sessionSubagents?: SubagentConfig[];
  channel?: string;
  /** Model providers configuration grouped by authType */
  modelProvidersConfig?: ModelProvidersConfig;
}

function normalizeConfigOutputFormat(
  format: OutputFormat | undefined,
): OutputFormat | undefined {
  if (!format) {
    return undefined;
  }
  switch (format) {
    case 'stream-json':
      return OutputFormat.STREAM_JSON;
    case 'json':
    case OutputFormat.JSON:
      return OutputFormat.JSON;
    case 'text':
    case OutputFormat.TEXT:
    default:
      return OutputFormat.TEXT;
  }
}

/**
 * Options for Config.initialize()
 */
export interface ConfigInitializeOptions {
  /**
   * Callback for sending MCP messages to SDK servers via control plane.
   * Required for SDK MCP server support in SDK mode.
   */
  sendSdkMcpMessage?: SendSdkMcpMessage;
}

export class Config {
  private sessionId: string;
  private sessionData?: ResumedSessionData;
  private debugLogger: DebugLogger;
  private toolRegistry!: ToolRegistry;
  private promptRegistry!: PromptRegistry;
  private subagentManager!: SubagentManager;
  private extensionManager!: ExtensionManager;
  private skillManager: SkillManager | null = null;
  private fileSystemService: FileSystemService;
  private contentGeneratorConfig!: ContentGeneratorConfig;
  private contentGeneratorConfigSources: ContentGeneratorConfigSources = {};
  private contentGenerator!: ContentGenerator;
  private readonly embeddingModel: string;

  private modelsConfig!: ModelsConfig;
  private readonly modelProvidersConfig?: ModelProvidersConfig;
  private readonly sandbox: SandboxConfig | undefined;
  private readonly targetDir: string;
  private workspaceContext: WorkspaceContext;
  private readonly debugMode: boolean;
  private readonly inputFormat: InputFormat;
  private readonly outputFormat: OutputFormat;
  private readonly includePartialMessages: boolean;
  private readonly question: string | undefined;
  private readonly coreTools: string[] | undefined;
  private readonly allowedTools: string[] | undefined;
  private readonly excludeTools: string[] | undefined;
  private readonly toolDiscoveryCommand: string | undefined;
  private readonly toolCallCommand: string | undefined;
  private readonly mcpServerCommand: string | undefined;
  private mcpServers: Record<string, MCPServerConfig> | undefined;
  private readonly lspEnabled: boolean;
  private lspClient?: LspClient;
  private readonly allowedMcpServers?: string[];
  private readonly excludedMcpServers?: string[];
  private sessionSubagents: SubagentConfig[];
  private userMemory: string;
  private sdkMode: boolean;
  private geminiMdFileCount: number;
  private approvalMode: ApprovalMode;
  private readonly accessibility: AccessibilitySettings;
  private readonly telemetrySettings: TelemetrySettings;
  private readonly gitCoAuthor: GitCoAuthorSettings;
  private readonly usageStatisticsEnabled: boolean;
  private geminiClient!: GeminiClient;
  private baseLlmClient!: BaseLlmClient;
  private readonly fileFiltering: {
    respectGitIgnore: boolean;
    respectQwenIgnore: boolean;
    enableRecursiveFileSearch: boolean;
    enableFuzzySearch: boolean;
  };
  private fileDiscoveryService: FileDiscoveryService | null = null;
  private gitService: GitService | undefined = undefined;
  private sessionService: SessionService | undefined = undefined;
  private chatRecordingService: ChatRecordingService | undefined = undefined;
  private readonly checkpointing: boolean;
  private readonly proxy: string | undefined;
  private readonly cwd: string;
  private readonly bugCommand: BugCommandSettings | undefined;
  private readonly outputLanguageFilePath?: string;
  private readonly noBrowser: boolean;
  private readonly folderTrustFeature: boolean;
  private readonly folderTrust: boolean;
  private ideMode: boolean;

  private readonly maxSessionTurns: number;
  private readonly sessionTokenLimit: number;
  private readonly listExtensions: boolean;
  private readonly overrideExtensions?: string[];

  private readonly summarizeToolOutput:
    | Record<string, SummarizeToolOutputSettings>
    | undefined;
  private readonly cliVersion?: string;
  private readonly experimentalZedIntegration: boolean = false;
  private readonly chatRecordingEnabled: boolean;
  private readonly loadMemoryFromIncludeDirectories: boolean = false;
  private readonly importFormat: 'tree' | 'flat';
  private readonly webSearch?: {
    provider: Array<{
      type: 'tavily' | 'google' | 'dashscope';
      apiKey?: string;
      searchEngineId?: string;
    }>;
    default: string;
  };
  private readonly chatCompression: ChatCompressionSettings | undefined;
  private readonly interactive: boolean;
  private readonly trustedFolder: boolean | undefined;
  private readonly useRipgrep: boolean;
  private readonly useBuiltinRipgrep: boolean;
  private readonly shouldUseNodePtyShell: boolean;
  private readonly skipNextSpeakerCheck: boolean;
  private shellExecutionConfig: ShellExecutionConfig;
  private readonly skipLoopDetection: boolean;
  private readonly skipStartupContext: boolean;
  private readonly vlmSwitchMode: string | undefined;
  private initialized: boolean = false;
  readonly storage: Storage;
  private readonly fileExclusions: FileExclusions;
  private readonly truncateToolOutputThreshold: number;
  private readonly truncateToolOutputLines: number;
  private readonly enableToolOutputTruncation: boolean;
  private readonly eventEmitter?: EventEmitter;
  private readonly channel: string | undefined;
  private readonly defaultFileEncoding: FileEncodingType;

  constructor(params: ConfigParameters) {
    this.sessionId = params.sessionId ?? randomUUID();
    this.sessionData = params.sessionData;
    setDebugLogSession(this);
    this.debugLogger = createDebugLogger();
    this.embeddingModel = params.embeddingModel ?? DEFAULT_QWEN_EMBEDDING_MODEL;
    this.fileSystemService = new StandardFileSystemService();
    this.sandbox = params.sandbox;
    this.targetDir = path.resolve(params.targetDir);
    this.workspaceContext = new WorkspaceContext(
      this.targetDir,
      params.includeDirectories ?? [],
    );
    this.debugMode = params.debugMode;
    this.inputFormat = params.inputFormat ?? InputFormat.TEXT;
    const normalizedOutputFormat = normalizeConfigOutputFormat(
      params.outputFormat ?? params.output?.format,
    );
    this.outputFormat = normalizedOutputFormat ?? OutputFormat.TEXT;
    this.includePartialMessages = params.includePartialMessages ?? false;
    this.question = params.question;
    this.coreTools = params.coreTools;
    this.allowedTools = params.allowedTools;
    this.excludeTools = params.excludeTools;
    this.toolDiscoveryCommand = params.toolDiscoveryCommand;
    this.toolCallCommand = params.toolCallCommand;
    this.mcpServerCommand = params.mcpServerCommand;
    this.mcpServers = params.mcpServers;
    this.lspEnabled = params.lsp?.enabled ?? false;
    this.lspClient = params.lspClient;
    this.allowedMcpServers = params.allowedMcpServers;
    this.excludedMcpServers = params.excludedMcpServers;
    this.sessionSubagents = params.sessionSubagents ?? [];
    this.sdkMode = params.sdkMode ?? false;
    this.userMemory = params.userMemory ?? '';
    this.geminiMdFileCount = params.geminiMdFileCount ?? 0;
    this.approvalMode = params.approvalMode ?? ApprovalMode.DEFAULT;
    this.accessibility = params.accessibility ?? {};
    this.telemetrySettings = {
      enabled: params.telemetry?.enabled ?? false,
      target: params.telemetry?.target ?? DEFAULT_TELEMETRY_TARGET,
      otlpEndpoint: params.telemetry?.otlpEndpoint ?? DEFAULT_OTLP_ENDPOINT,
      otlpProtocol: params.telemetry?.otlpProtocol,
      logPrompts: params.telemetry?.logPrompts ?? true,
      outfile: params.telemetry?.outfile,
      useCollector: params.telemetry?.useCollector,
    };
    this.gitCoAuthor = {
      enabled: params.gitCoAuthor ?? true,
      name: 'Qwen-Coder',
      email: 'qwen-coder@alibabacloud.com',
    };
    this.usageStatisticsEnabled = params.usageStatisticsEnabled ?? true;
    this.outputLanguageFilePath = params.outputLanguageFilePath;

    this.fileFiltering = {
      respectGitIgnore: params.fileFiltering?.respectGitIgnore ?? true,
      respectQwenIgnore: params.fileFiltering?.respectQwenIgnore ?? true,
      enableRecursiveFileSearch:
        params.fileFiltering?.enableRecursiveFileSearch ?? true,
      enableFuzzySearch: params.fileFiltering?.enableFuzzySearch ?? true,
    };
    this.checkpointing = params.checkpointing ?? false;
    this.proxy = params.proxy;
    this.cwd = params.cwd ?? process.cwd();
    this.fileDiscoveryService = params.fileDiscoveryService ?? null;
    this.bugCommand = params.bugCommand;
    this.maxSessionTurns = params.maxSessionTurns ?? -1;
    this.sessionTokenLimit = params.sessionTokenLimit ?? -1;
    this.experimentalZedIntegration =
      params.experimentalZedIntegration ?? false;
    this.listExtensions = params.listExtensions ?? false;
    this.overrideExtensions = params.overrideExtensions;
    this.noBrowser = params.noBrowser ?? false;
    this.summarizeToolOutput = params.summarizeToolOutput;
    this.folderTrustFeature = params.folderTrustFeature ?? false;
    this.folderTrust = params.folderTrust ?? false;
    this.ideMode = params.ideMode ?? false;
    this.modelProvidersConfig = params.modelProvidersConfig;
    this.cliVersion = params.cliVersion;

    this.chatRecordingEnabled = params.chatRecording ?? true;

    this.loadMemoryFromIncludeDirectories =
      params.loadMemoryFromIncludeDirectories ?? false;
    this.importFormat = params.importFormat ?? 'tree';
    this.chatCompression = params.chatCompression;
    this.interactive = params.interactive ?? false;
    this.trustedFolder = params.trustedFolder;
    this.skipLoopDetection = params.skipLoopDetection ?? false;
    this.skipStartupContext = params.skipStartupContext ?? false;

    // Web search
    this.webSearch = params.webSearch;
    this.useRipgrep = params.useRipgrep ?? true;
    this.useBuiltinRipgrep = params.useBuiltinRipgrep ?? true;
    this.shouldUseNodePtyShell = params.shouldUseNodePtyShell ?? false;
    this.skipNextSpeakerCheck = params.skipNextSpeakerCheck ?? true;
    this.shellExecutionConfig = {
      terminalWidth: params.shellExecutionConfig?.terminalWidth ?? 80,
      terminalHeight: params.shellExecutionConfig?.terminalHeight ?? 24,
      showColor: params.shellExecutionConfig?.showColor ?? false,
      pager: params.shellExecutionConfig?.pager ?? 'cat',
    };
    this.truncateToolOutputThreshold =
      params.truncateToolOutputThreshold ??
      DEFAULT_TRUNCATE_TOOL_OUTPUT_THRESHOLD;
    this.truncateToolOutputLines =
      params.truncateToolOutputLines ?? DEFAULT_TRUNCATE_TOOL_OUTPUT_LINES;
    this.enableToolOutputTruncation = params.enableToolOutputTruncation ?? true;
    this.channel = params.channel;
    this.defaultFileEncoding = params.defaultFileEncoding ?? FileEncoding.UTF8;
    this.storage = new Storage(this.targetDir);
    this.vlmSwitchMode = params.vlmSwitchMode;
    this.inputFormat = params.inputFormat ?? InputFormat.TEXT;
    this.fileExclusions = new FileExclusions(this);
    this.eventEmitter = params.eventEmitter;
    if (params.contextFileName) {
      setGeminiMdFilename(params.contextFileName);
    }

    // Create ModelsConfig for centralized model management
    // Prefer params.authType over generationConfig.authType because:
    // - params.authType preserves undefined (user hasn't selected yet)
    // - generationConfig.authType may have a default value from resolvers
    this.modelsConfig = new ModelsConfig({
      initialAuthType: params.authType ?? params.generationConfig?.authType,
      modelProvidersConfig: this.modelProvidersConfig,
      generationConfig: {
        model: params.model,
        ...(params.generationConfig || {}),
        baseUrl: params.generationConfig?.baseUrl,
      },
      generationConfigSources: params.generationConfigSources,
      onModelChange: this.handleModelChange.bind(this),
    });

    if (this.telemetrySettings.enabled) {
      initializeTelemetry(this);
    }

    if (this.getProxy()) {
      setGlobalDispatcher(new ProxyAgent(this.getProxy() as string));
    }
    this.geminiClient = new GeminiClient(this);
    this.chatRecordingService = this.chatRecordingEnabled
      ? new ChatRecordingService(this)
      : undefined;
    this.extensionManager = new ExtensionManager({
      workspaceDir: this.targetDir,
      enabledExtensionOverrides: this.overrideExtensions,
      isWorkspaceTrusted: this.isTrustedFolder(),
    });
  }

  /**
   * Must only be called once, throws if called again.
   * @param options Optional initialization options including sendSdkMcpMessage callback
   */
  async initialize(options?: ConfigInitializeOptions): Promise<void> {
    if (this.initialized) {
      throw Error('Config was already initialized');
    }
    this.initialized = true;
    this.debugLogger.info('Config initialization started');

    // Initialize centralized FileDiscoveryService
    this.getFileService();
    if (this.getCheckpointingEnabled()) {
      await this.getGitService();
    }
    this.promptRegistry = new PromptRegistry();
    this.extensionManager.setConfig(this);
    await this.extensionManager.refreshCache();
    this.debugLogger.debug('Extension manager initialized');

    this.subagentManager = new SubagentManager(this);
    this.skillManager = new SkillManager(this);
    await this.skillManager.startWatching();
    this.debugLogger.debug('Skill manager initialized');

    // Load session subagents if they were provided before initialization
    if (this.sessionSubagents.length > 0) {
      this.subagentManager.loadSessionSubagents(this.sessionSubagents);
    }

    await this.extensionManager.refreshCache();

    await this.refreshHierarchicalMemory();
    this.debugLogger.debug('Hierarchical memory loaded');

    this.toolRegistry = await this.createToolRegistry(
      options?.sendSdkMcpMessage,
    );
    this.debugLogger.info(
      `Tool registry initialized with ${this.toolRegistry.getAllToolNames().length} tools`,
    );

    await this.geminiClient.initialize();
    this.debugLogger.info('Gemini client initialized');

    // Detect and capture runtime model snapshot (from CLI/ENV/credentials)
    this.modelsConfig.detectAndCaptureRuntimeModel();

    logStartSession(this, new StartSessionEvent(this));
    this.debugLogger.info('Config initialization completed');
  }

  async refreshHierarchicalMemory(): Promise<void> {
    const { memoryContent, fileCount } = await loadServerHierarchicalMemory(
      this.getWorkingDir(),
      this.shouldLoadMemoryFromIncludeDirectories()
        ? this.getWorkspaceContext().getDirectories()
        : [],
      this.getFileService(),
      this.getExtensionContextFilePaths(),
      this.isTrustedFolder(),
      this.getImportFormat(),
    );
    this.setUserMemory(memoryContent);
    this.setGeminiMdFileCount(fileCount);
  }

  getContentGenerator(): ContentGenerator {
    return this.contentGenerator;
  }

  /**
   * Get the ModelsConfig instance for model-related operations.
   * External code (e.g., CLI) can use this to access model configuration.
   */
  getModelsConfig(): ModelsConfig {
    return this.modelsConfig;
  }

  /**
   * Updates the credentials in the generation config.
   * Exclusive for `OpenAIKeyPrompt` to update credentials via `/auth`
   * Delegates to ModelsConfig.
   */
  updateCredentials(
    credentials: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
    },
    settingsGenerationConfig?: Partial<ContentGeneratorConfig>,
  ): void {
    this.modelsConfig.updateCredentials(credentials, settingsGenerationConfig);
  }

  /**
   * Reload model providers configuration at runtime.
   * This enables hot-reloading of modelProviders settings without restarting the CLI.
   * Should be called before refreshAuth when settings.json has been updated.
   *
   * @param modelProvidersConfig - The updated model providers configuration
   */
  reloadModelProvidersConfig(
    modelProvidersConfig?: ModelProvidersConfig,
  ): void {
    this.modelsConfig.reloadModelProvidersConfig(modelProvidersConfig);
  }

  /**
   * Refresh authentication and rebuild ContentGenerator.
   */
  async refreshAuth(authMethod: AuthType, isInitialAuth?: boolean) {
    // Sync modelsConfig state for this auth refresh
    const modelId = this.modelsConfig.getModel();
    this.modelsConfig.syncAfterAuthRefresh(authMethod, modelId);

    // Check and consume cached credentials flag
    const requireCached =
      this.modelsConfig.consumeRequireCachedCredentialsFlag();

    const { config, sources } = resolveContentGeneratorConfigWithSources(
      this,
      authMethod,
      this.modelsConfig.getGenerationConfig(),
      this.modelsConfig.getGenerationConfigSources(),
      {
        strictModelProvider: this.modelsConfig.isStrictModelProviderSelection(),
      },
    );
    const newContentGeneratorConfig = config;
    this.contentGenerator = await createContentGenerator(
      newContentGeneratorConfig,
      this,
      requireCached ? true : isInitialAuth,
    );
    // Only assign to instance properties after successful initialization
    this.contentGeneratorConfig = newContentGeneratorConfig;
    this.contentGeneratorConfigSources = sources;

    // Initialize BaseLlmClient now that the ContentGenerator is available
    this.baseLlmClient = new BaseLlmClient(this.contentGenerator, this);
  }

  /**
   * Provides access to the BaseLlmClient for stateless LLM operations.
   */
  getBaseLlmClient(): BaseLlmClient {
    if (!this.baseLlmClient) {
      // Handle cases where initialization might be deferred or authentication failed
      if (this.contentGenerator) {
        this.baseLlmClient = new BaseLlmClient(
          this.getContentGenerator(),
          this,
        );
      } else {
        throw new Error(
          'BaseLlmClient not initialized. Ensure authentication has occurred and ContentGenerator is ready.',
        );
      }
    }
    return this.baseLlmClient;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getDebugLogger(): DebugLogger {
    return this.debugLogger;
  }

  /**
   * Starts a new session and resets session-scoped services.
   */
  startNewSession(
    sessionId?: string,
    sessionData?: ResumedSessionData,
  ): string {
    this.sessionId = sessionId ?? randomUUID();
    this.sessionData = sessionData;
    setDebugLogSession(this);
    this.debugLogger = createDebugLogger();
    this.chatRecordingService = this.chatRecordingEnabled
      ? new ChatRecordingService(this)
      : undefined;
    if (this.initialized) {
      logStartSession(this, new StartSessionEvent(this));
    }
    return this.sessionId;
  }

  /**
   * Returns the resumed session data if this session was resumed from a previous one.
   */
  getResumedSessionData(): ResumedSessionData | undefined {
    return this.sessionData;
  }

  shouldLoadMemoryFromIncludeDirectories(): boolean {
    return this.loadMemoryFromIncludeDirectories;
  }

  getImportFormat(): 'tree' | 'flat' {
    return this.importFormat;
  }

  getContentGeneratorConfig(): ContentGeneratorConfig {
    return this.contentGeneratorConfig;
  }

  getContentGeneratorConfigSources(): ContentGeneratorConfigSources {
    // If contentGeneratorConfigSources is empty (before initializeAuth),
    // get sources from ModelsConfig
    if (
      Object.keys(this.contentGeneratorConfigSources).length === 0 &&
      this.modelsConfig
    ) {
      return this.modelsConfig.getGenerationConfigSources();
    }
    return this.contentGeneratorConfigSources;
  }

  getModel(): string {
    return this.contentGeneratorConfig?.model || this.modelsConfig.getModel();
  }

  /**
   * Set model programmatically (e.g., VLM auto-switch, fallback).
   * Delegates to ModelsConfig.
   */
  async setModel(
    newModel: string,
    metadata?: { reason?: string; context?: string },
  ): Promise<void> {
    await this.modelsConfig.setModel(newModel, metadata);
    // Also update contentGeneratorConfig for hot-update compatibility
    if (this.contentGeneratorConfig) {
      this.contentGeneratorConfig.model = newModel;
    }
  }

  /**
   * Handle model change from ModelsConfig.
   * This updates the content generator config with the new model settings.
   */
  private async handleModelChange(
    authType: AuthType,
    requiresRefresh: boolean,
  ): Promise<void> {
    if (!this.contentGeneratorConfig) {
      return;
    }

    // Hot update path: only supported for qwen-oauth.
    // For other auth types we always refresh to recreate the ContentGenerator.
    //
    // Rationale:
    // - Non-qwen providers may need to re-validate credentials / baseUrl / envKey.
    // - ModelsConfig.applyResolvedModelDefaults can clear or change credentials sources.
    // - Refresh keeps runtime behavior consistent and centralized.
    if (authType === AuthType.QWEN_OAUTH && !requiresRefresh) {
      const { config, sources } = resolveContentGeneratorConfigWithSources(
        this,
        authType,
        this.modelsConfig.getGenerationConfig(),
        this.modelsConfig.getGenerationConfigSources(),
        {
          strictModelProvider:
            this.modelsConfig.isStrictModelProviderSelection(),
        },
      );

      // Hot-update fields (qwen-oauth models share the same auth + client).
      this.contentGeneratorConfig.model = config.model;
      this.contentGeneratorConfig.samplingParams = config.samplingParams;
      this.contentGeneratorConfig.contextWindowSize = config.contextWindowSize;
      this.contentGeneratorConfig.enableCacheControl =
        config.enableCacheControl;

      if ('model' in sources) {
        this.contentGeneratorConfigSources['model'] = sources['model'];
      }
      if ('samplingParams' in sources) {
        this.contentGeneratorConfigSources['samplingParams'] =
          sources['samplingParams'];
      }
      if ('enableCacheControl' in sources) {
        this.contentGeneratorConfigSources['enableCacheControl'] =
          sources['enableCacheControl'];
      }
      if ('contextWindowSize' in sources) {
        this.contentGeneratorConfigSources['contextWindowSize'] =
          sources['contextWindowSize'];
      }
      return;
    }

    // Full refresh path
    await this.refreshAuth(authType);
  }

  /**
   * Get available models for the current authType.
   * Delegates to ModelsConfig.
   */
  getAvailableModels(): AvailableModel[] {
    return this.modelsConfig.getAvailableModels();
  }

  /**
   * Get available models for a specific authType.
   * Delegates to ModelsConfig.
   */
  getAvailableModelsForAuthType(authType: AuthType): AvailableModel[] {
    return this.modelsConfig.getAvailableModelsForAuthType(authType);
  }

  /**
   * Get all configured models across authTypes.
   * Delegates to ModelsConfig.
   */
  getAllConfiguredModels(authTypes?: AuthType[]): AvailableModel[] {
    return this.modelsConfig.getAllConfiguredModels(authTypes);
  }

  /**
   * Get the currently active runtime model snapshot.
   * Delegates to ModelsConfig.
   */
  getActiveRuntimeModelSnapshot(): RuntimeModelSnapshot | undefined {
    return this.modelsConfig.getActiveRuntimeModelSnapshot();
  }

  /**
   * Switch authType+model.
   * Supports both registry-backed models and runtime model snapshots.
   *
   * For runtime models, the modelId should be in format `$runtime|${authType}|${modelId}`.
   * This triggers a refresh of the ContentGenerator when required (always on authType changes).
   * For qwen-oauth model switches that are hot-update safe, this may update in place.
   *
   * @param authType - Target authentication type
   * @param modelId - Target model ID (or `$runtime|${authType}|${modelId}` for runtime models)
   * @param options - Additional options like requireCachedCredentials
   */
  async switchModel(
    authType: AuthType,
    modelId: string,
    options?: { requireCachedCredentials?: boolean },
  ): Promise<void> {
    await this.modelsConfig.switchModel(authType, modelId, options);
  }

  getMaxSessionTurns(): number {
    return this.maxSessionTurns;
  }

  getSessionTokenLimit(): number {
    return this.sessionTokenLimit;
  }

  getEmbeddingModel(): string {
    return this.embeddingModel;
  }

  getSandbox(): SandboxConfig | undefined {
    return this.sandbox;
  }

  isRestrictiveSandbox(): boolean {
    const sandboxConfig = this.getSandbox();
    const seatbeltProfile = process.env['SEATBELT_PROFILE'];
    return (
      !!sandboxConfig &&
      sandboxConfig.command === 'sandbox-exec' &&
      !!seatbeltProfile &&
      seatbeltProfile.startsWith('restrictive-')
    );
  }

  getTargetDir(): string {
    return this.targetDir;
  }

  getProjectRoot(): string {
    return this.targetDir;
  }

  getWorkspaceContext(): WorkspaceContext {
    return this.workspaceContext;
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  /**
   * Shuts down the Config and releases all resources.
   * This method is idempotent and safe to call multiple times.
   * It handles the case where initialization was not completed.
   */
  async shutdown(): Promise<void> {
    if (!this.initialized) {
      // Nothing to clean up if not initialized
      return;
    }
    try {
      this.skillManager?.stopWatching();

      if (this.toolRegistry) {
        await this.toolRegistry.stop();
      }
    } catch (error) {
      // Log but don't throw - cleanup should be best-effort
      this.debugLogger.error('Error during Config shutdown:', error);
    }
  }

  getPromptRegistry(): PromptRegistry {
    return this.promptRegistry;
  }

  getDebugMode(): boolean {
    return this.debugMode;
  }

  getQuestion(): string | undefined {
    return this.question;
  }

  getCoreTools(): string[] | undefined {
    return this.coreTools;
  }

  getAllowedTools(): string[] | undefined {
    return this.allowedTools;
  }

  getExcludeTools(): string[] | undefined {
    return this.excludeTools;
  }

  getToolDiscoveryCommand(): string | undefined {
    return this.toolDiscoveryCommand;
  }

  getToolCallCommand(): string | undefined {
    return this.toolCallCommand;
  }

  getMcpServerCommand(): string | undefined {
    return this.mcpServerCommand;
  }

  getMcpServers(): Record<string, MCPServerConfig> | undefined {
    let mcpServers = { ...(this.mcpServers || {}) };
    const extensions = this.getActiveExtensions();
    for (const extension of extensions) {
      Object.entries(extension.config.mcpServers || {}).forEach(
        ([key, server]) => {
          if (mcpServers[key]) return;
          mcpServers[key] = {
            ...server,
            extensionName: extension.config.name,
          };
        },
      );
    }

    if (this.allowedMcpServers) {
      mcpServers = Object.fromEntries(
        Object.entries(mcpServers).filter(([key]) =>
          this.allowedMcpServers?.includes(key),
        ),
      );
    }

    if (this.excludedMcpServers) {
      mcpServers = Object.fromEntries(
        Object.entries(mcpServers).filter(
          ([key]) => !this.excludedMcpServers?.includes(key),
        ),
      );
    }

    return mcpServers;
  }

  addMcpServers(servers: Record<string, MCPServerConfig>): void {
    if (this.initialized) {
      throw new Error('Cannot modify mcpServers after initialization');
    }
    this.mcpServers = { ...this.mcpServers, ...servers };
  }

  isLspEnabled(): boolean {
    return this.lspEnabled;
  }

  getLspClient(): LspClient | undefined {
    return this.lspClient;
  }

  /**
   * Allows wiring an LSP client after Config construction but before initialize().
   */
  setLspClient(client: LspClient | undefined): void {
    if (this.initialized) {
      throw new Error('Cannot set LSP client after initialization');
    }
    this.lspClient = client;
  }

  getSessionSubagents(): SubagentConfig[] {
    return this.sessionSubagents;
  }

  setSessionSubagents(subagents: SubagentConfig[]): void {
    if (this.initialized) {
      throw new Error('Cannot modify sessionSubagents after initialization');
    }
    this.sessionSubagents = subagents;
  }

  getSdkMode(): boolean {
    return this.sdkMode;
  }

  setSdkMode(value: boolean): void {
    this.sdkMode = value;
  }

  getUserMemory(): string {
    return this.userMemory;
  }

  setUserMemory(newUserMemory: string): void {
    this.userMemory = newUserMemory;
  }

  getGeminiMdFileCount(): number {
    return this.geminiMdFileCount;
  }

  setGeminiMdFileCount(count: number): void {
    this.geminiMdFileCount = count;
  }

  getApprovalMode(): ApprovalMode {
    return this.approvalMode;
  }

  setApprovalMode(mode: ApprovalMode): void {
    if (
      !this.isTrustedFolder() &&
      mode !== ApprovalMode.DEFAULT &&
      mode !== ApprovalMode.PLAN
    ) {
      throw new Error(
        'Cannot enable privileged approval modes in an untrusted folder.',
      );
    }
    this.approvalMode = mode;
  }

  getInputFormat(): 'text' | 'stream-json' {
    return this.inputFormat;
  }

  getIncludePartialMessages(): boolean {
    return this.includePartialMessages;
  }

  getAccessibility(): AccessibilitySettings {
    return this.accessibility;
  }

  getTelemetryEnabled(): boolean {
    return this.telemetrySettings.enabled ?? false;
  }

  getTelemetryLogPromptsEnabled(): boolean {
    return this.telemetrySettings.logPrompts ?? true;
  }

  getTelemetryOtlpEndpoint(): string {
    return this.telemetrySettings.otlpEndpoint ?? DEFAULT_OTLP_ENDPOINT;
  }

  getTelemetryOtlpProtocol(): 'grpc' | 'http' {
    return this.telemetrySettings.otlpProtocol ?? 'grpc';
  }

  getTelemetryTarget(): TelemetryTarget {
    return this.telemetrySettings.target ?? DEFAULT_TELEMETRY_TARGET;
  }

  getTelemetryOutfile(): string | undefined {
    return this.telemetrySettings.outfile;
  }

  getGitCoAuthor(): GitCoAuthorSettings {
    return this.gitCoAuthor;
  }

  getTelemetryUseCollector(): boolean {
    return this.telemetrySettings.useCollector ?? false;
  }

  getGeminiClient(): GeminiClient {
    return this.geminiClient;
  }

  getEnableRecursiveFileSearch(): boolean {
    return this.fileFiltering.enableRecursiveFileSearch;
  }

  getFileFilteringEnableFuzzySearch(): boolean {
    return this.fileFiltering.enableFuzzySearch;
  }

  getFileFilteringRespectGitIgnore(): boolean {
    return this.fileFiltering.respectGitIgnore;
  }
  getFileFilteringRespectQwenIgnore(): boolean {
    return this.fileFiltering.respectQwenIgnore;
  }

  getFileFilteringOptions(): FileFilteringOptions {
    return {
      respectGitIgnore: this.fileFiltering.respectGitIgnore,
      respectQwenIgnore: this.fileFiltering.respectQwenIgnore,
    };
  }

  /**
   * Gets custom file exclusion patterns from configuration.
   * TODO: This is a placeholder implementation. In the future, this could
   * read from settings files, CLI arguments, or environment variables.
   */
  getCustomExcludes(): string[] {
    // Placeholder implementation - returns empty array for now
    // Future implementation could read from:
    // - User settings file
    // - Project-specific configuration
    // - Environment variables
    // - CLI arguments
    return [];
  }

  getCheckpointingEnabled(): boolean {
    return this.checkpointing;
  }

  getProxy(): string | undefined {
    return this.proxy;
  }

  getWorkingDir(): string {
    return this.cwd;
  }

  getBugCommand(): BugCommandSettings | undefined {
    return this.bugCommand;
  }

  getFileService(): FileDiscoveryService {
    if (!this.fileDiscoveryService) {
      this.fileDiscoveryService = new FileDiscoveryService(this.targetDir);
    }
    return this.fileDiscoveryService;
  }

  getUsageStatisticsEnabled(): boolean {
    return this.usageStatisticsEnabled;
  }

  getExtensionContextFilePaths(): string[] {
    const extensionContextFilePaths = this.getActiveExtensions().flatMap(
      (e) => e.contextFiles,
    );
    return [
      ...extensionContextFilePaths,
      ...(this.outputLanguageFilePath ? [this.outputLanguageFilePath] : []),
    ];
  }

  getExperimentalZedIntegration(): boolean {
    return this.experimentalZedIntegration;
  }

  getListExtensions(): boolean {
    return this.listExtensions;
  }

  getExtensionManager(): ExtensionManager {
    return this.extensionManager;
  }

  getExtensions(): Extension[] {
    const extensions = this.extensionManager.getLoadedExtensions();
    if (this.overrideExtensions) {
      return extensions.filter((e) =>
        this.overrideExtensions?.includes(e.name),
      );
    } else {
      return extensions;
    }
  }

  getActiveExtensions(): Extension[] {
    return this.getExtensions().filter((e) => e.isActive);
  }

  getBlockedMcpServers(): Array<{ name: string; extensionName: string }> {
    const mcpServers = { ...(this.mcpServers || {}) };
    const extensions = this.getActiveExtensions();
    for (const extension of extensions) {
      Object.entries(extension.config.mcpServers || {}).forEach(
        ([key, server]) => {
          if (mcpServers[key]) return;
          mcpServers[key] = {
            ...server,
            extensionName: extension.config.name,
          };
        },
      );
    }
    const blockedMcpServers: Array<{ name: string; extensionName: string }> =
      [];

    if (this.allowedMcpServers) {
      Object.entries(mcpServers).forEach(([key, server]) => {
        const isAllowed = this.allowedMcpServers?.includes(key);
        if (!isAllowed) {
          blockedMcpServers.push({
            name: key,
            extensionName: server.extensionName || '',
          });
        }
      });
    }
    return blockedMcpServers;
  }

  getNoBrowser(): boolean {
    return this.noBrowser;
  }

  isBrowserLaunchSuppressed(): boolean {
    return this.getNoBrowser() || !shouldAttemptBrowserLaunch();
  }

  getSummarizeToolOutputConfig():
    | Record<string, SummarizeToolOutputSettings>
    | undefined {
    return this.summarizeToolOutput;
  }

  // Web search provider configuration
  getWebSearchConfig() {
    return this.webSearch;
  }

  getIdeMode(): boolean {
    return this.ideMode;
  }

  getFolderTrustFeature(): boolean {
    return this.folderTrustFeature;
  }

  /**
   * Returns 'true' if the workspace is considered "trusted".
   * 'false' for untrusted.
   */
  getFolderTrust(): boolean {
    return this.folderTrust;
  }

  isTrustedFolder(): boolean {
    // isWorkspaceTrusted in cli/src/config/trustedFolder.js returns undefined
    // when the file based trust value is unavailable, since it is mainly used
    // in the initialization for trust dialogs, etc. Here we return true since
    // config.isTrustedFolder() is used for the main business logic of blocking
    // tool calls etc in the rest of the application.
    //
    // Default value is true since we load with trusted settings to avoid
    // restarts in the more common path. If the user chooses to mark the folder
    // as untrusted, the CLI will restart and we will have the trust value
    // reloaded.
    const context = ideContextStore.get();
    if (context?.workspaceState?.isTrusted !== undefined) {
      return context.workspaceState.isTrusted;
    }

    return this.trustedFolder ?? true;
  }

  setIdeMode(value: boolean): void {
    this.ideMode = value;
  }

  getAuthType(): AuthType | undefined {
    return this.contentGeneratorConfig?.authType;
  }

  getCliVersion(): string | undefined {
    return this.cliVersion;
  }

  getChannel(): string | undefined {
    return this.channel;
  }

  /**
   * Get the default file encoding for new files.
   * @returns FileEncodingType
   */
  getDefaultFileEncoding(): FileEncodingType {
    return this.defaultFileEncoding;
  }

  /**
   * Get the current FileSystemService
   */
  getFileSystemService(): FileSystemService {
    return this.fileSystemService;
  }

  /**
   * Set a custom FileSystemService
   */
  setFileSystemService(fileSystemService: FileSystemService): void {
    this.fileSystemService = fileSystemService;
  }

  getChatCompression(): ChatCompressionSettings | undefined {
    return this.chatCompression;
  }

  isInteractive(): boolean {
    return this.interactive;
  }

  getUseRipgrep(): boolean {
    return this.useRipgrep;
  }

  getUseBuiltinRipgrep(): boolean {
    return this.useBuiltinRipgrep;
  }

  getShouldUseNodePtyShell(): boolean {
    return this.shouldUseNodePtyShell;
  }

  getSkipNextSpeakerCheck(): boolean {
    return this.skipNextSpeakerCheck;
  }

  getShellExecutionConfig(): ShellExecutionConfig {
    return this.shellExecutionConfig;
  }

  setShellExecutionConfig(config: ShellExecutionConfig): void {
    this.shellExecutionConfig = {
      terminalWidth:
        config.terminalWidth ?? this.shellExecutionConfig.terminalWidth,
      terminalHeight:
        config.terminalHeight ?? this.shellExecutionConfig.terminalHeight,
      showColor: config.showColor ?? this.shellExecutionConfig.showColor,
      pager: config.pager ?? this.shellExecutionConfig.pager,
    };
  }
  getScreenReader(): boolean {
    return this.accessibility.screenReader ?? false;
  }

  getSkipLoopDetection(): boolean {
    return this.skipLoopDetection;
  }

  getSkipStartupContext(): boolean {
    return this.skipStartupContext;
  }

  getVlmSwitchMode(): string | undefined {
    return this.vlmSwitchMode;
  }

  getEnableToolOutputTruncation(): boolean {
    return this.enableToolOutputTruncation;
  }

  getTruncateToolOutputThreshold(): number {
    if (
      !this.enableToolOutputTruncation ||
      this.truncateToolOutputThreshold <= 0
    ) {
      return Number.POSITIVE_INFINITY;
    }

    return this.truncateToolOutputThreshold;
  }

  getTruncateToolOutputLines(): number {
    if (!this.enableToolOutputTruncation || this.truncateToolOutputLines <= 0) {
      return Number.POSITIVE_INFINITY;
    }

    return this.truncateToolOutputLines;
  }

  getOutputFormat(): OutputFormat {
    return this.outputFormat;
  }

  async getGitService(): Promise<GitService> {
    if (!this.gitService) {
      this.gitService = new GitService(this.targetDir, this.storage);
      await this.gitService.initialize();
    }
    return this.gitService;
  }

  /**
   * Returns the chat recording service.
   */
  getChatRecordingService(): ChatRecordingService | undefined {
    if (!this.chatRecordingEnabled) {
      return undefined;
    }
    if (!this.chatRecordingService) {
      this.chatRecordingService = new ChatRecordingService(this);
    }
    return this.chatRecordingService;
  }

  /**
   * Gets or creates a SessionService for managing chat sessions.
   */
  getSessionService(): SessionService {
    if (!this.sessionService) {
      this.sessionService = new SessionService(this.targetDir);
    }
    return this.sessionService;
  }

  getFileExclusions(): FileExclusions {
    return this.fileExclusions;
  }

  getSubagentManager(): SubagentManager {
    return this.subagentManager;
  }

  getSkillManager(): SkillManager | null {
    return this.skillManager;
  }

  async createToolRegistry(
    sendSdkMcpMessage?: SendSdkMcpMessage,
  ): Promise<ToolRegistry> {
    const registry = new ToolRegistry(
      this,
      this.eventEmitter,
      sendSdkMcpMessage,
    );

    const coreToolsConfig = this.getCoreTools();
    const excludeToolsConfig = this.getExcludeTools();

    // Helper to create & register core tools that are enabled
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const registerCoreTool = (ToolClass: any, ...args: unknown[]) => {
      const toolName = ToolClass?.Name as ToolName | undefined;
      const className = ToolClass?.name ?? 'UnknownTool';

      if (!toolName) {
        // Log warning and skip this tool instead of crashing
        this.debugLogger.warn(
          `Skipping tool registration: ${className} is missing static Name property. ` +
            `Tools must define a static Name property to be registered.`,
        );
        return;
      }

      if (isToolEnabled(toolName, coreToolsConfig, excludeToolsConfig)) {
        try {
          registry.registerTool(new ToolClass(...args));
        } catch (error) {
          this.debugLogger.error(
            `Failed to register tool ${className} (${toolName}):`,
            error,
          );
          throw error; // Re-throw after logging context
        }
      }
    };

    registerCoreTool(TaskTool, this);
    registerCoreTool(SkillTool, this);
    registerCoreTool(LSTool, this);
    registerCoreTool(ReadFileTool, this);

    if (this.getUseRipgrep()) {
      let useRipgrep = false;
      let errorString: undefined | string = undefined;
      try {
        useRipgrep = await canUseRipgrep(this.getUseBuiltinRipgrep());
      } catch (error: unknown) {
        errorString = getErrorMessage(error);
      }
      if (useRipgrep) {
        registerCoreTool(RipGrepTool, this);
      } else {
        // Log for telemetry
        logRipgrepFallback(
          this,
          new RipgrepFallbackEvent(
            this.getUseRipgrep(),
            this.getUseBuiltinRipgrep(),
            errorString || 'ripgrep is not available',
          ),
        );
        registerCoreTool(GrepTool, this);
      }
    } else {
      registerCoreTool(GrepTool, this);
    }

    registerCoreTool(GlobTool, this);
    registerCoreTool(EditTool, this);
    registerCoreTool(WriteFileTool, this);
    registerCoreTool(ShellTool, this);
    registerCoreTool(MemoryTool);
    registerCoreTool(TodoWriteTool, this);
    !this.sdkMode && registerCoreTool(ExitPlanModeTool, this);
    registerCoreTool(WebFetchTool, this);
    // Conditionally register web search tool if web search provider is configured
    // buildWebSearchConfig ensures qwen-oauth users get dashscope provider, so
    // if tool is registered, config must exist
    if (this.getWebSearchConfig()) {
      registerCoreTool(WebSearchTool, this);
    }
    if (this.isLspEnabled() && this.getLspClient()) {
      // Register the unified LSP tool
      registerCoreTool(LspTool, this);
    }

    await registry.discoverAllTools();
    this.debugLogger.debug(
      `ToolRegistry created: ${JSON.stringify(registry.getAllToolNames())} (${registry.getAllToolNames().length} tools)`,
    );
    return registry;
  }
}
