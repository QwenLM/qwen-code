import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AgentEngine, EngineExecutionContext, EngineInitOptions } from './types';
import type { AgentMessage, RealtimeEvent } from '../types';
import { detectCcr, validateCcrConfig } from '../ccr-detector';
import { getProject } from '../project-service';
import { getChromeMcpUrl } from '../../constant';

// Images are provided to Claude Code via local file paths referenced in the prompt text.
// Claude Code CLI reads images from local paths, so we write base64 images to temp files and reference them.

/**
 * Tool action type for categorizing tool operations.
 */
type ToolAction = 'Edited' | 'Created' | 'Read' | 'Deleted' | 'Generated' | 'Searched' | 'Executed';

/**
 * Map of tool names to their corresponding actions.
 */
const TOOL_NAME_ACTION_MAP: Record<string, ToolAction> = {
  read: 'Read',
  read_file: 'Read',
  write: 'Created',
  write_file: 'Created',
  create_file: 'Created',
  edit: 'Edited',
  edit_file: 'Edited',
  apply_patch: 'Edited',
  patch_file: 'Edited',
  remove_file: 'Deleted',
  delete_file: 'Deleted',
  list_files: 'Searched',
  glob: 'Searched',
  glob_files: 'Searched',
  search_files: 'Searched',
  grep: 'Searched',
  bash: 'Executed',
  run: 'Executed',
  shell: 'Executed',
  todo_write: 'Generated',
  plan_write: 'Generated',
};

/**
 * ClaudeEngine integrates the Claude Agent SDK as an AgentEngine implementation.
 *
 * This engine uses the @anthropic-ai/claude-agent-sdk to interact with Claude,
 * streaming events back to the sidepanel UI via RealtimeEvent envelopes.
 */
export class ClaudeEngine implements AgentEngine {
  public readonly name = 'claude' as const;
  public readonly supportsMcp = true;

  /**
   * Maximum number of stderr lines to keep in memory.
   */
  private static readonly MAX_STDERR_LINES = 200;

  async initializeAndRun(options: EngineInitOptions, ctx: EngineExecutionContext): Promise<void> {
    const {
      sessionId,
      instruction,
      model,
      projectRoot,
      requestId,
      signal,
      attachments,
      resolvedImagePaths,
      projectId,
      permissionMode,
      allowDangerouslySkipPermissions,
      systemPromptConfig,
      optionsConfig,
      resumeClaudeSessionId,
      useCcr,
    } = options;
    const repoPath = this.resolveRepoPath(projectRoot);

    // Check if already aborted
    if (signal?.aborted) {
      throw new Error('ClaudeEngine: execution was cancelled');
    }

    const normalizedInstruction = instruction.trim();
    if (!normalizedInstruction) {
      throw new Error('ClaudeEngine: instruction must not be empty');
    }

    // Dynamically import the Claude Agent SDK
    // Images are passed via temp file paths appended to the prompt string
    let query: (args: { prompt: string; options?: Record<string, unknown> }) => AsyncIterable<any>;
    try {
      // Dynamic import to avoid hard dependency - install @anthropic-ai/claude-agent-sdk to use this engine
      // Use string variable to bypass TypeScript module resolution
      const sdkModuleName = '@anthropic-ai/claude-agent-sdk';

      const sdk = await (Function(
        'moduleName',
        'return import(moduleName)',
      )(sdkModuleName) as Promise<any>);
      query = sdk.query;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `ClaudeEngine: Failed to load Claude Agent SDK. Please install @anthropic-ai/claude-agent-sdk. Error: ${message}`,
      );
    }

    // Resolve model
    const resolvedModel =
      model?.trim() || process.env.CLAUDE_DEFAULT_MODEL || 'claude-sonnet-4-20250514';

    // State management
    const stderrBuffer: string[] = [];
    let assistantBuffer = '';
    let assistantMessageId: string | null = null;
    let assistantCreatedAt: string | null = null;
    let lastAssistantEmitted: { content: string; isFinal: boolean } | null = null;
    const streamedToolHashes = new Set<string>();

    // Tool input accumulation for streaming tool_use blocks
    // Key: content block index, Value: { toolName, toolId, inputJson }
    const pendingToolInputs = new Map<
      number,
      { toolName: string; toolId: string; inputJsonParts: string[] }
    >();
    let currentContentBlockIndex = -1;

    /**
     * Emit assistant message to the stream.
     * Includes deduplication to prevent multiple identical final emissions.
     */
    const emitAssistant = (isFinal: boolean): void => {
      const content = assistantBuffer.trim();
      if (!content) return;

      // Deduplicate: skip if same content and isFinal state was already emitted
      if (
        lastAssistantEmitted &&
        lastAssistantEmitted.content === content &&
        lastAssistantEmitted.isFinal === isFinal
      ) {
        return;
      }
      lastAssistantEmitted = { content, isFinal };

      if (!assistantMessageId) {
        assistantMessageId = randomUUID();
      }
      if (!assistantCreatedAt) {
        assistantCreatedAt = new Date().toISOString();
      }

      const message: AgentMessage = {
        id: assistantMessageId,
        sessionId,
        role: 'assistant',
        content,
        messageType: 'chat',
        cliSource: this.name,
        requestId,
        isStreaming: !isFinal,
        isFinal,
        createdAt: assistantCreatedAt,
      };

      ctx.emit({ type: 'message', data: message });
    };

    /**
     * Emit tool message with deduplication.
     */
    const dispatchToolMessage = (
      content: string,
      metadata: Record<string, unknown>,
      messageType: 'tool_use' | 'tool_result',
      isStreaming: boolean,
    ): void => {
      const trimmed = content.trim();
      if (!trimmed) return;

      const hash = this.encodeHash(
        `${messageType}:${trimmed}:${JSON.stringify(metadata)}:${sessionId}:${requestId || ''}`,
      ).slice(0, 16);
      if (streamedToolHashes.has(hash)) return;
      streamedToolHashes.add(hash);

      const message: AgentMessage = {
        id: randomUUID(),
        sessionId,
        role: 'tool',
        content: trimmed,
        messageType,
        cliSource: this.name,
        requestId,
        isStreaming,
        isFinal: !isStreaming,
        createdAt: new Date().toISOString(),
        metadata: { cli_type: 'claude', ...metadata },
      };

      ctx.emit({ type: 'message', data: message });
    };

    /**
     * Infer tool action from tool name.
     */
    const inferActionFromToolName = (toolName: unknown): ToolAction | undefined => {
      if (typeof toolName !== 'string') return undefined;
      const normalized = toolName.trim().toLowerCase();
      if (!normalized) return undefined;

      if (TOOL_NAME_ACTION_MAP[normalized]) {
        return TOOL_NAME_ACTION_MAP[normalized];
      }

      // Try suffix after colon (e.g., "mcp__server__tool" -> "tool")
      const suffix = normalized.split(':').pop() ?? normalized;
      if (suffix && TOOL_NAME_ACTION_MAP[suffix]) {
        return TOOL_NAME_ACTION_MAP[suffix];
      }

      // Infer from name patterns
      if (
        normalized.includes('edit') ||
        normalized.includes('modify') ||
        normalized.includes('patch')
      ) {
        return 'Edited';
      }
      if (normalized.includes('write') || normalized.includes('create')) {
        return 'Created';
      }
      if (normalized.includes('read') || normalized.includes('view')) {
        return 'Read';
      }
      if (normalized.includes('delete') || normalized.includes('remove')) {
        return 'Deleted';
      }
      if (
        normalized.includes('search') ||
        normalized.includes('find') ||
        normalized.includes('glob') ||
        normalized.includes('grep')
      ) {
        return 'Searched';
      }
      if (
        normalized.includes('bash') ||
        normalized.includes('shell') ||
        normalized.includes('exec')
      ) {
        return 'Executed';
      }
      if (normalized.includes('todo') || normalized.includes('plan')) {
        return 'Generated';
      }

      return undefined;
    };

    /**
     * Build tool metadata from content block with detailed tool-specific information.
     */
    const buildToolMetadata = (contentBlock: Record<string, unknown>): Record<string, unknown> => {
      const toolName = this.pickFirstString(contentBlock.name) || 'unknown';
      const toolId = this.pickFirstString(contentBlock.id);
      const input = contentBlock.input as Record<string, unknown> | undefined;
      const action = inferActionFromToolName(toolName);

      const metadata: Record<string, unknown> = {
        toolName,
        tool_name: toolName,
        toolId,
        action,
      };

      if (!input) {
        return metadata;
      }

      // Extract tool-specific details
      const normalizedName = toolName.toLowerCase();

      // File operations (read, write, edit)
      if (typeof input.file_path === 'string') {
        metadata.filePath = input.file_path;
      }

      // Edit tool - extract diff information
      if (
        normalizedName.includes('edit') ||
        normalizedName === 'apply_patch' ||
        normalizedName === 'patch_file'
      ) {
        if (typeof input.old_string === 'string') {
          metadata.oldString = input.old_string;
          metadata.deletedLines = input.old_string.split('\n').length;
        }
        if (typeof input.new_string === 'string') {
          metadata.newString = input.new_string;
          metadata.addedLines = input.new_string.split('\n').length;
        }
        if (typeof input.replace_all === 'boolean') {
          metadata.replaceAll = input.replace_all;
        }
      }

      // Write tool - content preview
      if (normalizedName.includes('write') || normalizedName === 'create_file') {
        if (typeof input.content === 'string') {
          metadata.contentPreview = input.content.slice(0, 200);
          metadata.totalLines = input.content.split('\n').length;
        }
      }

      // Read tool - offset/limit
      if (normalizedName.includes('read')) {
        if (typeof input.offset === 'number') metadata.offset = input.offset;
        if (typeof input.limit === 'number') metadata.limit = input.limit;
      }

      // Bash/shell - command
      if (
        normalizedName === 'bash' ||
        normalizedName.includes('shell') ||
        normalizedName === 'run'
      ) {
        if (typeof input.command === 'string') {
          metadata.command = input.command;
        }
        if (typeof input.description === 'string') {
          metadata.commandDescription = input.description;
        }
      }

      // Search tools (grep, glob)
      if (normalizedName === 'grep' || normalizedName.includes('search')) {
        if (typeof input.pattern === 'string') metadata.pattern = input.pattern;
        if (typeof input.path === 'string') metadata.searchPath = input.path;
        if (typeof input.glob === 'string') metadata.glob = input.glob;
        if (typeof input.output_mode === 'string') metadata.outputMode = input.output_mode;
      }

      if (normalizedName === 'glob' || normalizedName === 'glob_files') {
        if (typeof input.pattern === 'string') metadata.pattern = input.pattern;
        if (typeof input.path === 'string') metadata.searchPath = input.path;
      }

      // TodoWrite
      if (normalizedName === 'todo_write' || normalizedName === 'todowrite') {
        if (Array.isArray(input.todos)) {
          metadata.todoCount = input.todos.length;
          metadata.todos = input.todos;
        }
      }

      // Store raw input for debugging (truncated)
      metadata.rawInput = JSON.stringify(input).slice(0, 1000);

      return metadata;
    };

    // State for temp file cleanup
    const tempFiles: string[] = [];
    const cleanupTempFiles = async (): Promise<void> => {
      if (tempFiles.length === 0) return;

      try {
        const fs = await import('node:fs/promises');
        for (const filePath of tempFiles) {
          try {
            await fs.unlink(filePath);
            console.error(`[ClaudeEngine] Cleaned up temp file: ${filePath}`);
          } catch (err) {
            // Best-effort cleanup; ignore failures (file may already be deleted)
            console.error(`[ClaudeEngine] Failed to cleanup temp file ${filePath}:`, err);
          }
        }
      } catch (err) {
        console.error('[ClaudeEngine] Failed to cleanup temp files:', err);
      }
    };

    // Build prompt instruction (may be modified if images are attached)
    let promptInstruction = normalizedInstruction;

    try {
      // Use console.error for logging to avoid polluting stdout (Native Messaging protocol)
      console.error(`[ClaudeEngine] Starting query with model: ${resolvedModel}`);
      console.error(`[ClaudeEngine] Working directory: ${repoPath}`);

      // Check for image attachments - prefer resolvedImagePaths (persisted), fallback to temp files
      const hasResolvedPaths = resolvedImagePaths && resolvedImagePaths.length > 0;
      const imageAttachments = (attachments ?? []).filter((a) => a.type === 'image');
      const hasImages = hasResolvedPaths || imageAttachments.length > 0;

      if (hasImages) {
        // Strip any legacy "Image #N path:" lines to avoid duplicating references
        const instructionWithoutLegacyPaths = normalizedInstruction
          .replace(/\n*Image #\d+ path: [^\n]+/g, '')
          .trim();

        const imageLines: string[] = [];

        if (hasResolvedPaths) {
          // Use pre-resolved persistent paths (preferred - no temp files needed)
          console.error(
            `[ClaudeEngine] Using ${resolvedImagePaths.length} pre-resolved image path(s)`,
          );
          for (let index = 0; index < resolvedImagePaths.length; index++) {
            imageLines.push(`Image #${index + 1} path: ${resolvedImagePaths[index]}`);
          }
        } else {
          // Fallback: write base64 to temp files (legacy behavior)
          console.error(
            `[ClaudeEngine] Writing ${imageAttachments.length} image attachment(s) to temp files (fallback)`,
          );
          for (let index = 0; index < imageAttachments.length; index++) {
            const attachment = imageAttachments[index];
            const tempFilePath = await this.writeAttachmentToTemp(attachment);
            tempFiles.push(tempFilePath);
            imageLines.push(`Image #${index + 1} path: ${tempFilePath}`);
          }
        }

        // Build final instruction with image paths appended
        promptInstruction = [instructionWithoutLegacyPaths, imageLines.join('\n')]
          .filter((segment) => segment && segment.trim().length > 0)
          .join('\n\n')
          .trim();

        console.error(
          `[ClaudeEngine] Prompt with image paths: ${promptInstruction.slice(0, 200)}...`,
        );
      }

      // Start Claude Agent SDK query
      // Session resumption: if resumeClaudeSessionId is provided (from sessions.engineSessionId or legacy project),
      // pass it as 'resume' to continue a previous Claude conversation.
      // If not provided, SDK will create a new session.

      // Build environment for Claude Code Router support
      // SDK treats options.env as a complete replacement, so we must merge with process.env
      // Reference: https://github.com/musistudio/claude-code-router/issues/855
      const claudeEnv = await this.buildClaudeEnv(useCcr);

      // Validate CCR configuration and emit friendly warning before calling into CCR
      // This prevents users from seeing cryptic "includes of undefined" errors
      if (useCcr) {
        await this.validateAndWarnCcrConfig(sessionId, requestId, ctx);
      }

      // Resolve permission mode from session config or use default
      // SDK default is 'default', but AgentChat defaults to 'bypassPermissions' for headless operation
      const allowedPermissionModes = new Set([
        'default',
        'acceptEdits',
        'bypassPermissions',
        'plan',
        'dontAsk',
      ]);
      const normalizedPermissionMode =
        typeof permissionMode === 'string' ? permissionMode.trim() : '';

      let resolvedPermissionMode: string;
      if (normalizedPermissionMode === '') {
        // No permission mode specified - use AgentChat default for headless operation
        resolvedPermissionMode = 'bypassPermissions';
      } else if (allowedPermissionModes.has(normalizedPermissionMode)) {
        // Valid permission mode - use as specified
        resolvedPermissionMode = normalizedPermissionMode;
      } else {
        // Invalid permission mode - fall back to SDK default and warn
        console.error(
          `[ClaudeEngine] Invalid permissionMode "${normalizedPermissionMode}", falling back to SDK default "default"`,
        );
        resolvedPermissionMode = 'default';
      }

      // allowDangerouslySkipPermissions must be true when using bypassPermissions mode
      // SDK requirement: bypass mode requires explicit acknowledgment via allowDangerouslySkipPermissions=true
      const resolvedAllowDangerouslySkipPermissions = (() => {
        const explicitValue =
          typeof allowDangerouslySkipPermissions === 'boolean'
            ? allowDangerouslySkipPermissions
            : undefined;

        if (resolvedPermissionMode === 'bypassPermissions') {
          // Force true for bypassPermissions mode - SDK requirement
          if (explicitValue === false) {
            console.error(
              '[ClaudeEngine] Warning: allowDangerouslySkipPermissions=false is incompatible with bypassPermissions mode, forcing to true',
            );
          }
          return true;
        }

        // For non-bypass modes, use explicit value or default to false
        return explicitValue ?? false;
      })();

      // Parse optionsConfig for additional SDK options
      const optionsRecord =
        optionsConfig && typeof optionsConfig === 'object' && !Array.isArray(optionsConfig)
          ? (optionsConfig as Record<string, unknown>)
          : undefined;

      // Resolve project-scoped Chrome MCP toggle (default: enabled)
      const enableChromeMcp = await (async (): Promise<boolean> => {
        if (!projectId) return true;
        try {
          const project = await getProject(projectId);
          return project?.enableChromeMcp !== false;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(
            `[ClaudeEngine] Failed to load project enableChromeMcp, defaulting to enabled: ${message}`,
          );
          return true;
        }
      })();

      // Resolve setting sources
      // SDK isolation mode: settingSources=[] prevents loading any filesystem settings
      // Default behavior: include 'project' to load CLAUDE.md
      const resolvedSettingSources = (() => {
        const allowedSettingSources = new Set(['user', 'project', 'local']);
        const raw = optionsRecord?.settingSources;

        // Check for explicit isolation mode (empty array)
        if (Array.isArray(raw) && raw.length === 0) {
          console.error('[ClaudeEngine] Isolation mode enabled: settingSources=[]');
          return [];
        }

        // Parse provided sources
        if (Array.isArray(raw)) {
          const sources: string[] = [];
          for (const entry of raw) {
            if (typeof entry === 'string' && allowedSettingSources.has(entry)) {
              sources.push(entry);
            }
          }
          // If valid sources were provided, use them as-is (trust user config)
          if (sources.length > 0) {
            return sources;
          }
        }

        // Default: include 'project' to load CLAUDE.md
        return ['project'];
      })();

      // Resolve system prompt from session config
      const resolvedSystemPrompt = (() => {
        if (typeof systemPromptConfig === 'string') {
          const trimmed = systemPromptConfig.trim();
          return trimmed.length > 0 ? trimmed : undefined;
        }
        if (
          !systemPromptConfig ||
          typeof systemPromptConfig !== 'object' ||
          Array.isArray(systemPromptConfig)
        ) {
          return undefined;
        }
        const record = systemPromptConfig as Record<string, unknown>;
        const type = record.type;
        if (type === 'custom' && typeof record.text === 'string') {
          const trimmed = record.text.trim();
          return trimmed.length > 0 ? trimmed : undefined;
        }
        if (type === 'preset' && record.preset === 'claude_code') {
          // Trim append and ignore empty strings to avoid "append is empty but object is passed" edge case
          const rawAppend = typeof record.append === 'string' ? record.append.trim() : '';
          const append = rawAppend.length > 0 ? rawAppend : undefined;
          return append
            ? { type: 'preset' as const, preset: 'claude_code' as const, append }
            : { type: 'preset' as const, preset: 'claude_code' as const };
        }
        return undefined;
      })();

      // Create internal AbortController that mirrors the external signal
      // SDK expects abortController option, not raw AbortSignal
      const internalAbortController = new AbortController();
      if (signal) {
        // Propagate external abort to internal controller
        if (signal.aborted) {
          internalAbortController.abort();
        } else {
          signal.addEventListener(
            'abort',
            () => {
              internalAbortController.abort();
            },
            { once: true },
          );
        }
      }

      const queryOptions: Record<string, unknown> = {
        cwd: repoPath,
        additionalDirectories: [repoPath],
        model: resolvedModel,
        // Permission settings are session-configurable (defaults preserve previous behavior)
        permissionMode: resolvedPermissionMode,
        allowDangerouslySkipPermissions: resolvedAllowDangerouslySkipPermissions,
        // Enable streaming: emit stream_event with content_block_delta for real-time UI updates
        // Without this, SDK only outputs aggregated assistant/result messages
        includePartialMessages: true,
        // Load CLAUDE.md / .claude/settings.json from the project root
        settingSources: resolvedSettingSources,
        // Custom system prompt if provided
        systemPrompt: resolvedSystemPrompt,
        // AbortController for cancellation support - SDK uses this to terminate underlying processes
        abortController: internalAbortController,
        // Pass merged env to support Claude Code Router (CCR)
        // This allows users to set ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN via:
        // 1. eval "$(ccr activate)" before launching Chrome
        // 2. Or setting env vars in shell profile
        env: claudeEnv,
        stderr: (data: string) => {
          const line = String(data).trimEnd();
          if (!line) return;
          if (stderrBuffer.length > ClaudeEngine.MAX_STDERR_LINES) {
            stderrBuffer.shift();
          }
          stderrBuffer.push(line);
          console.error(`[ClaudeEngine][stderr] ${line}`);
        },
      };

      // Apply additional SDK options from optionsConfig
      if (optionsRecord) {
        const isStringArray = (value: unknown): value is string[] =>
          Array.isArray(value) && value.every((v) => typeof v === 'string');

        if (isStringArray(optionsRecord.allowedTools)) {
          queryOptions.allowedTools = optionsRecord.allowedTools;
        }
        if (isStringArray(optionsRecord.disallowedTools)) {
          queryOptions.disallowedTools = optionsRecord.disallowedTools;
        }

        const tools = optionsRecord.tools;
        if (isStringArray(tools)) {
          queryOptions.tools = tools;
        } else if (tools && typeof tools === 'object' && !Array.isArray(tools)) {
          const toolsRecord = tools as Record<string, unknown>;
          if (toolsRecord.type === 'preset' && toolsRecord.preset === 'claude_code') {
            queryOptions.tools = { type: 'preset', preset: 'claude_code' };
          }
        }

        if (isStringArray(optionsRecord.betas)) {
          queryOptions.betas = optionsRecord.betas;
        }

        if (
          typeof optionsRecord.maxThinkingTokens === 'number' &&
          Number.isFinite(optionsRecord.maxThinkingTokens)
        ) {
          queryOptions.maxThinkingTokens = optionsRecord.maxThinkingTokens;
        }
        if (typeof optionsRecord.maxTurns === 'number' && Number.isFinite(optionsRecord.maxTurns)) {
          queryOptions.maxTurns = optionsRecord.maxTurns;
        }
        if (
          typeof optionsRecord.maxBudgetUsd === 'number' &&
          Number.isFinite(optionsRecord.maxBudgetUsd)
        ) {
          queryOptions.maxBudgetUsd = optionsRecord.maxBudgetUsd;
        }

        if (
          optionsRecord.mcpServers &&
          typeof optionsRecord.mcpServers === 'object' &&
          !Array.isArray(optionsRecord.mcpServers)
        ) {
          queryOptions.mcpServers = optionsRecord.mcpServers;
        }
        if (
          optionsRecord.outputFormat &&
          typeof optionsRecord.outputFormat === 'object' &&
          !Array.isArray(optionsRecord.outputFormat)
        ) {
          queryOptions.outputFormat = optionsRecord.outputFormat;
        }
        if (typeof optionsRecord.enableFileCheckpointing === 'boolean') {
          queryOptions.enableFileCheckpointing = optionsRecord.enableFileCheckpointing;
        }
        if (
          optionsRecord.sandbox &&
          typeof optionsRecord.sandbox === 'object' &&
          !Array.isArray(optionsRecord.sandbox)
        ) {
          queryOptions.sandbox = optionsRecord.sandbox;
        }

        // Merge session-level env overrides with base claudeEnv
        // Session env takes precedence over process env (useful for per-session API keys, etc.)
        if (
          optionsRecord.env &&
          typeof optionsRecord.env === 'object' &&
          !Array.isArray(optionsRecord.env)
        ) {
          const sessionEnv = optionsRecord.env as Record<string, unknown>;
          const mergedEnv = { ...claudeEnv };
          for (const [key, value] of Object.entries(sessionEnv)) {
            if (typeof value === 'string') {
              mergedEnv[key] = value;
            }
          }
          // Ensure Node.js bin directory is still in PATH after merge
          // Session may have overwritten PATH, which would break child processes
          const nodeBinDir = path.dirname(process.execPath);
          const mergedPath = mergedEnv.PATH || mergedEnv.Path || '';
          if (!mergedPath.includes(nodeBinDir)) {
            mergedEnv.PATH = [nodeBinDir, mergedPath].filter(Boolean).join(path.delimiter);
          }
          queryOptions.env = mergedEnv;
        }
      }

      // Inject the local Chrome MCP server based on project preference.
      // This only controls the built-in "chrome-mcp" entry; user-configured MCP servers remain untouched.
      const CHROME_MCP_SERVER_NAME = 'chrome-mcp';
      if (enableChromeMcp) {
        const existingMcpServers =
          queryOptions.mcpServers &&
          typeof queryOptions.mcpServers === 'object' &&
          !Array.isArray(queryOptions.mcpServers)
            ? (queryOptions.mcpServers as Record<string, unknown>)
            : {};

        queryOptions.mcpServers = {
          ...existingMcpServers,
          [CHROME_MCP_SERVER_NAME]: {
            type: 'http',
            url: getChromeMcpUrl(),
          },
        };
        console.error(`[ClaudeEngine] Chrome MCP server enabled: ${getChromeMcpUrl()}`);
      } else if (
        queryOptions.mcpServers &&
        typeof queryOptions.mcpServers === 'object' &&
        !Array.isArray(queryOptions.mcpServers)
      ) {
        // If Chrome MCP is disabled, remove it from existing mcpServers if present
        const existing = queryOptions.mcpServers as Record<string, unknown>;
        if (CHROME_MCP_SERVER_NAME in existing) {
          const { [CHROME_MCP_SERVER_NAME]: _removed, ...rest } = existing;
          if (Object.keys(rest).length > 0) {
            queryOptions.mcpServers = rest;
          } else {
            delete (queryOptions as Record<string, unknown>).mcpServers;
          }
        }
        console.error('[ClaudeEngine] Chrome MCP server disabled');
      }

      // Add resume option if we have a valid Claude session ID
      if (resumeClaudeSessionId) {
        queryOptions.resume = resumeClaudeSessionId;
        console.error(`[ClaudeEngine] Resuming Claude session: ${resumeClaudeSessionId}`);
      }

      const response = query({
        prompt: promptInstruction,
        options: queryOptions,
      });

      // Process streaming response
      for await (const message of response) {
        // Check for cancellation before processing each message
        if (signal?.aborted) {
          console.error('[ClaudeEngine] Execution cancelled via abort signal');
          throw new Error('ClaudeEngine: execution was cancelled');
        }

        console.error('[ClaudeEngine] Message type:', message.type);

        if (message.type === 'stream_event') {
          const event = (message as unknown as { event?: Record<string, unknown> }).event ?? {};
          const eventType = this.pickFirstString(event.type);

          switch (eventType) {
            case 'message_start': {
              // Reset assistant state for new message
              assistantBuffer = '';
              assistantMessageId = randomUUID();
              assistantCreatedAt = new Date().toISOString();
              lastAssistantEmitted = null;
              break;
            }

            case 'content_block_start': {
              const contentBlock = event.content_block as Record<string, unknown> | undefined;
              const blockIndex =
                typeof event.index === 'number' ? event.index : ++currentContentBlockIndex;
              currentContentBlockIndex = blockIndex;

              if (contentBlock && contentBlock.type === 'tool_use') {
                const toolName = this.pickFirstString(contentBlock.name) || 'tool';
                const toolId = this.pickFirstString(contentBlock.id) || '';

                // Store pending tool input for accumulation
                // Don't emit message here - wait for content_block_stop with complete input
                pendingToolInputs.set(blockIndex, {
                  toolName,
                  toolId,
                  inputJsonParts: [],
                });
              } else if (contentBlock && contentBlock.type === 'tool_result') {
                // Handle tool_result in content_block_start
                const metadata = this.buildToolResultMetadata(contentBlock);
                const content = this.extractToolResultContent(contentBlock);
                const isError = contentBlock.is_error === true;

                dispatchToolMessage(
                  isError
                    ? `Error: ${content || 'Tool execution failed'}`
                    : content || 'Tool completed',
                  metadata,
                  'tool_result',
                  false,
                );
              }
              break;
            }

            case 'content_block_stop': {
              const blockIndex =
                typeof event.index === 'number' ? event.index : currentContentBlockIndex;

              // Check if we have accumulated tool input for this block
              if (pendingToolInputs.has(blockIndex)) {
                const pending = pendingToolInputs.get(blockIndex)!;
                pendingToolInputs.delete(blockIndex);

                // Parse the accumulated JSON
                const fullJsonStr = pending.inputJsonParts.join('');
                let input: Record<string, unknown> = {};
                try {
                  if (fullJsonStr) {
                    input = JSON.parse(fullJsonStr);
                  }
                } catch (e) {
                  console.error(`[ClaudeEngine] Failed to parse tool input JSON: ${e}`);
                }

                console.error(
                  `[ClaudeEngine] content_block_stop - toolName: ${pending.toolName}, input: ${JSON.stringify(input).slice(0, 500)}`,
                );

                // Build metadata with full input
                const metadata = buildToolMetadata({
                  name: pending.toolName,
                  id: pending.toolId,
                  input,
                });

                // Build informative content
                let content = `Using tool: ${pending.toolName}`;
                if (input.command) content = `Running: ${input.command}`;
                else if (input.file_path) content = `Operating on: ${input.file_path}`;
                else if (input.pattern) content = `Searching: ${input.pattern}`;
                else if (input.query) content = `Searching: ${input.query}`;

                // Emit final tool_use message with complete metadata
                dispatchToolMessage(content, metadata, 'tool_use', false);
              }

              // Check if this block was a tool_result
              const contentBlock = event.content_block as Record<string, unknown> | undefined;
              if (contentBlock && contentBlock.type === 'tool_result') {
                const metadata = this.buildToolResultMetadata(contentBlock);
                const content = this.extractToolResultContent(contentBlock);
                const isError = contentBlock.is_error === true;

                dispatchToolMessage(
                  isError
                    ? `Error: ${content || 'Tool execution failed'}`
                    : content || 'Tool completed',
                  metadata,
                  'tool_result',
                  false,
                );
              }
              break;
            }

            case 'content_block_delta': {
              const delta = event.delta as Record<string, unknown> | string | undefined;
              const blockIndex =
                typeof event.index === 'number' ? event.index : currentContentBlockIndex;

              // Check if this is a tool_use input_json_delta
              if (delta && typeof delta === 'object' && delta.type === 'input_json_delta') {
                const partialJson = delta.partial_json as string | undefined;
                if (partialJson && pendingToolInputs.has(blockIndex)) {
                  pendingToolInputs.get(blockIndex)!.inputJsonParts.push(partialJson);
                }
                break;
              }

              // Handle text delta for assistant messages
              let textChunk = '';

              if (typeof delta === 'string') {
                textChunk = delta;
              } else if (delta && typeof delta === 'object') {
                if (typeof delta.text === 'string') {
                  textChunk = delta.text;
                } else if (typeof delta.delta === 'string') {
                  textChunk = delta.delta;
                } else if (typeof delta.partial === 'string') {
                  textChunk = delta.partial;
                }
              }

              if (textChunk) {
                assistantBuffer += textChunk;
                emitAssistant(false);
              }
              break;
            }

            case 'message_delta': {
              // message_delta usually contains metadata only (stop_reason, usage)
              // Don't emit final here to avoid duplicate finals
              break;
            }

            case 'message_stop': {
              // Emit final assistant message only on message_stop
              emitAssistant(true);
              break;
            }

            default:
              // Other stream events are ignored
              break;
          }
        } else if (message.type === 'assistant') {
          // Fallback for non-streaming assistant messages
          const content = this.extractMessageContent(message);
          if (content) {
            assistantBuffer = content;
            emitAssistant(true);
          }
        } else if (message.type === 'result') {
          // Final result - check for errors first
          const resultRecord = message as unknown as Record<string, unknown>;

          // Log full result for debugging
          console.error(`[ClaudeEngine] Result message: ${JSON.stringify(resultRecord, null, 2)}`);

          // Extract and emit usage statistics
          const usage = resultRecord.usage as Record<string, unknown> | undefined;
          const totalCostUsd =
            typeof resultRecord.total_cost_usd === 'number' ? resultRecord.total_cost_usd : 0;
          const durationMs =
            typeof resultRecord.duration_ms === 'number' ? resultRecord.duration_ms : 0;
          const numTurns = typeof resultRecord.num_turns === 'number' ? resultRecord.num_turns : 0;

          if (usage || totalCostUsd > 0) {
            ctx.emit({
              type: 'usage',
              data: {
                sessionId,
                requestId,
                inputTokens: typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0,
                outputTokens: typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0,
                cacheReadInputTokens:
                  typeof usage?.cache_read_input_tokens === 'number'
                    ? usage.cache_read_input_tokens
                    : undefined,
                cacheCreationInputTokens:
                  typeof usage?.cache_creation_input_tokens === 'number'
                    ? usage.cache_creation_input_tokens
                    : undefined,
                totalCostUsd,
                durationMs,
                numTurns,
              },
            });
          }

          // Check if result contains errors (SDK puts error details here)
          // Note: is_error can be true even with empty errors array
          if (resultRecord.is_error) {
            const errors = resultRecord.errors as string[] | undefined;
            const resultText = resultRecord.result as string | undefined;
            const errorMsg = errors?.length
              ? errors.join('; ')
              : resultText || 'Unknown error from Claude Code';
            console.error(`[ClaudeEngine] Result error: ${errorMsg}`);

            // Check if this is a resume failure
            const isResumeFailure =
              errorMsg.includes('No conversation found') ||
              errorMsg.includes('Failed to resume session') ||
              errorMsg.includes('session ID');

            if (isResumeFailure && resumeClaudeSessionId) {
              // Clear the stored session ID so next request starts fresh
              if (ctx.persistClaudeSessionId && projectId) {
                try {
                  // Pass empty string to clear the session
                  await ctx.persistClaudeSessionId('');
                  console.error('[ClaudeEngine] Cleared invalid session ID');
                } catch {
                  // Ignore clear errors
                }
              }
              throw new Error(
                `Resume failed: ${errorMsg}. Session has been cleared - please retry.`,
              );
            }

            throw new Error(errorMsg);
          }

          // Extract content from successful result
          const resultContent = this.extractMessageContent(message);
          if (resultContent && resultContent !== assistantBuffer.trim()) {
            assistantBuffer = resultContent;
            emitAssistant(true);
          }
        } else if (message.type === 'system') {
          // Handle system messages
          const record = message as unknown as Record<string, unknown>;
          const subtype = this.pickFirstString(record.subtype);

          if (subtype === 'init') {
            // system:init - contains session_id and management information
            const claudeSessionId = record.session_id ? String(record.session_id) : undefined;

            if (claudeSessionId) {
              console.error(`[ClaudeEngine] Session initialized: ${claudeSessionId}`);

              // Persist the session ID if callback is provided and projectId exists
              if (ctx.persistClaudeSessionId && projectId) {
                try {
                  await ctx.persistClaudeSessionId(claudeSessionId);
                  console.error(`[ClaudeEngine] Session ID persisted for project: ${projectId}`);
                } catch (persistError) {
                  console.error('[ClaudeEngine] Failed to persist session ID:', persistError);
                }
              }
            }

            // Extract and persist management information
            if (ctx.persistManagementInfo) {
              try {
                const managementInfo = {
                  tools: Array.isArray(record.tools)
                    ? record.tools.filter((t): t is string => typeof t === 'string')
                    : undefined,
                  agents: Array.isArray(record.agents)
                    ? record.agents.filter((a): a is string => typeof a === 'string')
                    : undefined,
                  // SDK returns plugins as { name, path }[] objects
                  plugins: Array.isArray(record.plugins)
                    ? (record.plugins as Array<{ name?: string; path?: string }>)
                        .filter((p) => p && typeof p.name === 'string')
                        .map((p) => ({
                          name: String(p.name),
                          path: p.path ? String(p.path) : undefined,
                        }))
                    : undefined,
                  skills: Array.isArray(record.skills)
                    ? record.skills.filter((s): s is string => typeof s === 'string')
                    : undefined,
                  mcpServers: Array.isArray(record.mcp_servers)
                    ? (record.mcp_servers as Array<{ name?: string; status?: string }>)
                        .filter((s) => s && typeof s.name === 'string')
                        .map((s) => ({
                          name: String(s.name),
                          status: String(s.status || 'unknown'),
                        }))
                    : undefined,
                  slashCommands: Array.isArray(record.slash_commands)
                    ? record.slash_commands.filter((c): c is string => typeof c === 'string')
                    : undefined,
                  model: this.pickFirstString(record.model),
                  permissionMode: this.pickFirstString(record.permissionMode),
                  cwd: this.pickFirstString(record.cwd),
                  outputStyle: this.pickFirstString(record.output_style),
                  betas: Array.isArray(record.betas)
                    ? record.betas.filter((b): b is string => typeof b === 'string')
                    : undefined,
                  claudeCodeVersion: this.pickFirstString(record.claude_code_version),
                  apiKeySource: this.pickFirstString(record.apiKeySource),
                };

                await ctx.persistManagementInfo(managementInfo);
                console.error('[ClaudeEngine] Management info persisted');
              } catch (persistError) {
                console.error('[ClaudeEngine] Failed to persist management info:', persistError);
              }
            }
          } else if (subtype === 'status') {
            // system:status - log for debugging (e.g., compacting)
            const statusText = this.pickFirstString(record.status);
            console.error(`[ClaudeEngine] System status: ${statusText || 'unknown'}`);
          }
        } else if (message.type === 'auth_status') {
          // Handle authentication status - SDK fields: isAuthenticating, output, error
          const record = message as unknown as Record<string, unknown>;
          const isAuthenticating = record.isAuthenticating === true;
          const output = Array.isArray(record.output)
            ? record.output.filter((o): o is string => typeof o === 'string')
            : [];
          const authError = this.pickFirstString(record.error);

          console.error(
            `[ClaudeEngine] Auth status: isAuthenticating=${isAuthenticating}, hasError=${!!authError}`,
          );

          // Build content from output or error
          const content = authError || output.join('\n') || 'Authentication in progress...';

          // Determine if login is required:
          // - Not currently authenticating AND (has error OR output contains login keywords)
          const outputText = output.join(' ').toLowerCase();
          const requiresLogin =
            !isAuthenticating &&
            (!!authError ||
              outputText.includes('login') ||
              outputText.includes('authenticate') ||
              outputText.includes('sign in'));

          // Emit auth status as a system message so UI can display login prompts
          const authSystemMessage: AgentMessage = {
            id: randomUUID(),
            sessionId,
            role: 'system',
            content,
            messageType: 'status',
            cliSource: this.name,
            requestId,
            isStreaming: false,
            isFinal: !isAuthenticating,
            createdAt: new Date().toISOString(),
            metadata: {
              cli_type: 'claude',
              event_type: 'auth_status',
              isAuthenticating,
              output,
              error: authError,
              requires_login: requiresLogin,
            },
          };

          ctx.emit({ type: 'message', data: authSystemMessage });
        } else if (message.type === 'tool_progress') {
          // Handle tool progress - SDK fields: tool_use_id, tool_name, parent_tool_use_id, elapsed_time_seconds
          const record = message as unknown as Record<string, unknown>;
          const toolUseId = this.pickFirstString(record.tool_use_id);
          const toolName = this.pickFirstString(record.tool_name);
          const parentToolUseId = this.pickFirstString(record.parent_tool_use_id);
          const elapsedTimeSeconds =
            typeof record.elapsed_time_seconds === 'number'
              ? record.elapsed_time_seconds
              : undefined;

          if (toolName || toolUseId) {
            const displayName = toolName || toolUseId || 'tool';
            const elapsedStr =
              elapsedTimeSeconds !== undefined ? ` (${elapsedTimeSeconds.toFixed(1)}s)` : '';
            console.error(`[ClaudeEngine] Tool progress: ${displayName}${elapsedStr}`);

            // Use tool_use_id as message id if available, so UI can update the same progress entry
            const messageId = toolUseId ? `progress-${toolUseId}` : randomUUID();

            // Emit tool progress as a tool message
            const progressMessage: AgentMessage = {
              id: messageId,
              sessionId,
              role: 'tool',
              content: `${displayName} in progress${elapsedStr}`,
              messageType: 'tool_use',
              cliSource: this.name,
              requestId,
              isStreaming: true,
              isFinal: false,
              createdAt: new Date().toISOString(),
              metadata: {
                cli_type: 'claude',
                event_type: 'tool_progress',
                toolUseId,
                toolName,
                parentToolUseId,
                elapsedTimeSeconds,
              },
            };

            ctx.emit({ type: 'message', data: progressMessage });
          }
        }
      }

      // Ensure final message is emitted
      if (assistantBuffer.trim()) {
        emitAssistant(true);
      }

      console.error('[ClaudeEngine] Query completed successfully');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Log full stderr for debugging
      console.error(`[ClaudeEngine] Error: ${message}`);
      if (stderrBuffer.length > 0) {
        console.error(`[ClaudeEngine] Stderr (${stderrBuffer.length} lines):`);
        stderrBuffer.slice(-10).forEach((line) => console.error(`  ${line}`));
      }

      // Check if this is a resume failure from stderr
      const stderrText = stderrBuffer.join('\n');
      const isResumeFailure =
        stderrText.includes('No conversation found') ||
        stderrText.includes('Failed to resume session') ||
        stderrText.includes('session ID') ||
        message.includes('Resume failed');

      if (isResumeFailure && resumeClaudeSessionId && ctx.persistClaudeSessionId && projectId) {
        // Clear the stored session ID so next request starts fresh
        try {
          await ctx.persistClaudeSessionId('');
          console.error('[ClaudeEngine] Cleared invalid session ID due to resume failure');
        } catch {
          // Ignore clear errors
        }
      }

      // Enhance error message for CCR-related errors
      const enhancedMessage = await this.enhanceCcrErrorMessage(message, stderrText);

      // Classify errors for better UX
      const errorMessage = this.classifyError(enhancedMessage, stderrBuffer);
      throw new Error(`ClaudeEngine: ${errorMessage}`);
    } finally {
      // Always cleanup temp files, even on error
      await cleanupTempFiles();
    }
  }

  /**
   * Build environment variables for Claude Code.
   * Supports Claude Code Router (CCR) when useCcr is true:
   * 1. Auto-detecting CCR from config file (~/.claude-code-router/config.json)
   * 2. Passing through env vars if already set (via `eval "$(ccr activate)"`)
   *
   * SDK treats options.env as a complete replacement (not merged with process.env),
   * so we must explicitly include all necessary variables.
   *
   * @param useCcr - Whether CCR is enabled for this project. When false/undefined, CCR detection is skipped.
   */
  private async buildClaudeEnv(useCcr?: boolean): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = { ...process.env };

    // Ensure Node.js bin directory is in PATH (for child processes)
    const nodeBinDir = path.dirname(process.execPath);
    const currentPath = env.PATH || env.Path || '';
    if (!currentPath.includes(nodeBinDir)) {
      env.PATH = [nodeBinDir, currentPath].filter(Boolean).join(path.delimiter);
    }

    // Only detect CCR if explicitly enabled for this project
    if (useCcr && !env.ANTHROPIC_BASE_URL) {
      try {
        const ccrResult = await detectCcr();
        if (ccrResult.detected && ccrResult.baseUrl && ccrResult.authToken) {
          env.ANTHROPIC_BASE_URL = ccrResult.baseUrl;
          env.ANTHROPIC_AUTH_TOKEN = ccrResult.authToken;
          console.error(`[ClaudeEngine] CCR auto-detected (source: ${ccrResult.source})`);
        } else if (ccrResult.error) {
          console.error(`[ClaudeEngine] CCR detection failed: ${ccrResult.error}`);
        } else {
          console.error(
            '[ClaudeEngine] CCR enabled but not detected (config not found or service not running)',
          );
        }
      } catch (err) {
        // CCR detection is best-effort, don't fail the request
        console.error(`[ClaudeEngine] CCR detection error: ${err}`);
      }
    }

    // Log CCR-related env vars for debugging (without exposing full token)
    const baseUrl = env.ANTHROPIC_BASE_URL;
    const authToken = env.ANTHROPIC_AUTH_TOKEN;
    if (baseUrl) {
      console.error(`[ClaudeEngine] Using ANTHROPIC_BASE_URL: ${baseUrl}`);
    }
    if (authToken) {
      const preview =
        authToken.length > 8 ? `${authToken.slice(0, 4)}...${authToken.slice(-4)}` : '****';
      console.error(`[ClaudeEngine] Using ANTHROPIC_AUTH_TOKEN: ${preview}`);
    }

    return env;
  }

  /**
   * Resolve project root path.
   */
  private resolveRepoPath(projectRoot?: string): string {
    const base =
      (projectRoot && projectRoot.trim()) || process.env.MCP_AGENT_PROJECT_ROOT || process.cwd();
    return path.resolve(base);
  }

  /**
   * Pick first string value from unknown input.
   */
  private pickFirstString(value: unknown): string | undefined {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        const candidate = this.pickFirstString(entry);
        if (candidate) return candidate;
      }
      return undefined;
    }
    return undefined;
  }

  /**
   * Extract content from SDK message.
   * Handles various message structures from Claude Agent SDK:
   * - result.result (final result text)
   * - assistant.message (nested message content)
   * - content/text (direct content fields)
   * - content[] (array of content blocks)
   *
   * @param message - The message object to extract content from
   * @param depth - Current recursion depth (max 3 to prevent infinite loops)
   */
  private extractMessageContent(message: unknown, depth = 0): string | undefined {
    // Prevent infinite recursion
    if (depth > 3 || !message || typeof message !== 'object') return undefined;
    const record = message as Record<string, unknown>;

    // Handle result message: result field contains final text
    if (typeof record.result === 'string') {
      return record.result.trim();
    }

    // Handle assistant message: message field may contain nested content
    if (record.message && typeof record.message === 'object') {
      const nested = this.extractMessageContent(record.message, depth + 1);
      if (nested) return nested;
    }

    // Try common content fields
    if (typeof record.content === 'string') {
      return record.content.trim();
    }
    if (typeof record.text === 'string') {
      return record.text.trim();
    }
    if (Array.isArray(record.content)) {
      const textParts: string[] = [];
      for (const part of record.content) {
        if (part && typeof part === 'object' && (part as Record<string, unknown>).type === 'text') {
          const text = (part as Record<string, unknown>).text;
          if (typeof text === 'string') {
            textParts.push(text);
          }
        }
      }
      if (textParts.length > 0) {
        return textParts.join('').trim();
      }
    }

    return undefined;
  }

  /**
   * Format error message for user display.
   * Preserves the original error message and only appends stderr context if useful.
   */
  private classifyError(message: string, stderrBuffer: string[]): string {
    // Always preserve the original error message
    // Only append stderr context if it contains useful information beyond the spawn line
    const usefulStderr = stderrBuffer.filter(
      (line) => !line.includes('Spawning Claude Code:') && line.trim().length > 0,
    );

    if (usefulStderr.length > 0) {
      const lastLines = usefulStderr.slice(-3).join(' | ');
      return `${message} (stderr: ${lastLines})`;
    }

    return message;
  }

  /**
   * Validate CCR configuration and emit a warning message if issues are found.
   * This is a best-effort check to provide actionable guidance before CCR crashes.
   */
  private async validateAndWarnCcrConfig(
    sessionId: string,
    requestId: string | undefined,
    ctx: EngineExecutionContext,
  ): Promise<void> {
    try {
      const validation = await validateCcrConfig();

      if (!validation.checked || validation.valid) {
        return;
      }

      // Build user-friendly warning message
      const lines = [
        '⚠️ Claude Code Router (CCR) configuration issue detected:',
        validation.issue ?? 'CCR configuration appears invalid.',
        '',
        validation.suggestion ?? 'Please check your CCR configuration.',
      ];

      if (validation.suggestedFix) {
        lines.push('', `Suggested fix: Router.default = "${validation.suggestedFix}"`);
      }

      const content = lines.join('\n');
      console.error(`[ClaudeEngine] CCR config warning: ${validation.issue}`);

      const warningMessage: AgentMessage = {
        id: randomUUID(),
        sessionId,
        role: 'system',
        content,
        messageType: 'status',
        cliSource: this.name,
        requestId,
        isStreaming: false,
        isFinal: true,
        createdAt: new Date().toISOString(),
        metadata: {
          cli_type: 'claude',
          warning_type: 'ccr_config',
          ccr_issue: validation.issue,
          ccr_suggested_fix: validation.suggestedFix,
        },
      };

      ctx.emit({ type: 'message', data: warningMessage });
    } catch (err) {
      // CCR config validation is best-effort, don't fail the request
      console.error('[ClaudeEngine] CCR config validation error:', err);
    }
  }

  /**
   * Enhance error messages for CCR-related errors.
   * Detects the common "includes of undefined" crash and provides actionable guidance.
   */
  private async enhanceCcrErrorMessage(message: string, stderrText: string): Promise<string> {
    const combinedText = `${message}\n${stderrText}`;

    // Detect CCR's "includes of undefined" error pattern
    const isCcrIncludesError =
      combinedText.includes('claude-code-router') &&
      (combinedText.includes("reading 'includes'") || combinedText.includes('transformRequestIn'));

    if (!isCcrIncludesError) {
      return message;
    }

    // Try to get specific fix suggestion from CCR config
    let suggestion =
      'Edit ~/.claude-code-router/config.json and set Router.default to "provider,model" format (e.g., "venus,claude-4-5-sonnet-20250929"), then restart CCR.';

    try {
      const validation = await validateCcrConfig();
      if (validation.checked && !validation.valid && validation.suggestion) {
        suggestion = validation.suggestion;
      }
    } catch {
      // Use default suggestion if validation fails
    }

    return [
      message,
      '',
      '💡 CCR Configuration Issue Detected:',
      'This error is commonly caused by Router.default being set to only a provider name',
      '(e.g., "venus") instead of the required "provider,model" format.',
      '',
      `Fix: ${suggestion}`,
    ].join('\n');
  }

  /**
   * Build metadata for tool result events.
   */
  private buildToolResultMetadata(block: Record<string, unknown>): Record<string, unknown> {
    const toolUseId = this.pickFirstString(block.tool_use_id);
    const isError = block.is_error === true;

    return {
      toolUseId,
      is_error: isError,
      status: isError ? 'failed' : 'completed',
      cli_type: 'claude',
    };
  }

  /**
   * Extract content from a tool_result block.
   */
  private extractToolResultContent(block: Record<string, unknown>): string | undefined {
    const content = block.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const textParts = content
        .filter((c) => c && typeof c === 'object' && (c as Record<string, unknown>).type === 'text')
        .map((c) => (c as Record<string, unknown>).text as string)
        .filter(Boolean);
      if (textParts.length > 0) {
        return textParts.join('\n');
      }
    }
    return undefined;
  }

  /**
   * Encode string to base64 for hashing.
   */
  private encodeHash(value: string): string {
    return Buffer.from(value, 'utf-8').toString('base64');
  }

  /**
   * Write an attachment to a temporary file and return its path.
   */
  private async writeAttachmentToTemp(attachment: {
    type: string;
    name: string;
    mimeType: string;
    dataBase64: string;
  }): Promise<string> {
    const os = await import('node:os');
    const fs = await import('node:fs/promises');

    const tempDir = os.tmpdir();
    const ext = attachment.mimeType.split('/')[1] || 'bin';
    const sanitizedName = attachment.name.replace(/[^a-zA-Z0-9.-]/g, '_');
    const fileName = `mcp-agent-${Date.now()}-${sanitizedName}.${ext}`;
    const filePath = path.join(tempDir, fileName);

    const buffer = Buffer.from(attachment.dataBase64, 'base64');
    await fs.writeFile(filePath, buffer);

    return filePath;
  }
}
