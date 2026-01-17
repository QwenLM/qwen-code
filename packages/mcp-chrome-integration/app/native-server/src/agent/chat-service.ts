import { randomUUID } from 'node:crypto';
import type { AgentActRequest } from './types';
import type {
  AgentEngine,
  EngineExecutionContext,
  EngineName,
  EngineInitOptions,
  RunningExecution,
} from './engines/types';
import type { AgentMessage, RealtimeEvent } from './types';
import type { AttachmentMetadata } from 'chrome-mcp-shared';
import { AgentStreamManager } from './stream-manager';
import { getProject, touchProjectActivity, updateProjectClaudeSessionId } from './project-service';
import { createMessage as persistAgentMessage } from './message-service';
import {
  getSession,
  updateEngineSessionId,
  updateManagementInfo,
  touchSessionActivity,
  type AgentSession,
} from './session-service';
import { attachmentService, type SavedAttachment } from './attachment-service';

export interface AgentChatServiceOptions {
  engines: AgentEngine[];
  streamManager: AgentStreamManager;
  defaultEngineName?: EngineName;
}

/**
 * AgentChatService coordinates incoming /agent/chat requests and delegates to engines.
 *
 * 中文说明：该服务负责会话级调度，不关心具体 CLI/SDK 实现细节。
 * 通过 Engine 接口实现依赖倒置，后续替换或新增引擎时无需修改 HTTP 路由层。
 */
export class AgentChatService {
  private readonly engines = new Map<EngineName, AgentEngine>();
  private readonly streamManager: AgentStreamManager;
  private readonly defaultEngineName: EngineName;

  /**
   * Registry of currently running executions, keyed by requestId.
   */
  private readonly runningExecutions = new Map<string, RunningExecution>();

  constructor(options: AgentChatServiceOptions) {
    this.streamManager = options.streamManager;

    for (const engine of options.engines) {
      this.engines.set(engine.name, engine);
    }

    if (options.defaultEngineName && this.engines.has(options.defaultEngineName)) {
      this.defaultEngineName = options.defaultEngineName;
    } else {
      // Fallback to first registered engine to avoid hard-coding 'claude' here.
      const firstEngine = options.engines[0];
      if (!firstEngine) {
        throw new Error('AgentChatService requires at least one engine');
      }
      this.defaultEngineName = firstEngine.name;
    }
  }

  async handleAct(sessionId: string, payload: AgentActRequest): Promise<{ requestId: string }> {
    const trimmed = payload.instruction?.trim();
    if (!trimmed) {
      throw new Error('instruction is required');
    }

    const requestId = payload.requestId || randomUUID();
    let projectId = payload.projectId;
    // Normalize empty string to undefined
    const rawDbSessionId =
      typeof payload.dbSessionId === 'string' ? payload.dbSessionId.trim() : '';
    const dbSessionId = rawDbSessionId || undefined;

    // Load session from database if dbSessionId is provided
    let dbSession: AgentSession | undefined;
    if (dbSessionId) {
      dbSession = await getSession(dbSessionId);
      if (!dbSession) {
        throw new Error(`Session not found for id: ${dbSessionId}`);
      }
      // Validate project association
      if (projectId && dbSession.projectId !== projectId) {
        throw new Error(`Session ${dbSessionId} does not belong to project: ${projectId}`);
      }
      // Use session's project if not explicitly provided
      if (!projectId) {
        projectId = dbSession.projectId;
      }
    }

    // Project is required - workspace path must come from project system
    if (!projectId) {
      throw new Error('projectId is required. Please select or create a project first.');
    }

    const project = await getProject(projectId);
    if (!project) {
      throw new Error(`Project not found for id: ${projectId}`);
    }

    const projectRoot = project.rootPath;
    const projectPreferredCli = project.preferredCli as EngineName | undefined;
    const projectSelectedModel = project.selectedModel;
    const projectUseCcr = project.useCcr;

    // Legacy fallback: if caller does not use sessions table, use project-level resume id
    let resumeClaudeSessionId: string | undefined;
    if (!dbSessionId) {
      resumeClaudeSessionId = project.activeClaudeSessionId;
    }

    // Resolve engine name - session binding takes precedence
    let engineName: EngineName;
    if (dbSession) {
      engineName = dbSession.engineName as EngineName;
      // Validate cliPreference matches session engine
      if (payload.cliPreference && payload.cliPreference !== engineName) {
        throw new Error(
          `cliPreference (${payload.cliPreference}) does not match session.engineName (${engineName})`,
        );
      }
    } else {
      engineName = this.resolveEngineName(
        payload.cliPreference as EngineName | undefined,
        projectPreferredCli,
      );
    }

    const engine = this.engines.get(engineName);
    if (!engine) {
      throw new Error(`No agent engine registered for ${engineName}`);
    }

    // Model priority: request > session > project
    const effectiveModel = payload.model?.trim() || dbSession?.model || projectSelectedModel;

    // For Claude engine with session, use session's engineSessionId for resume
    if (dbSession && engineName === 'claude') {
      resumeClaudeSessionId = dbSession.engineSessionId;
    }

    const now = new Date().toISOString();
    const userMessageId = randomUUID();

    // Process and persist image attachments
    const savedAttachments: SavedAttachment[] = [];
    let attachmentMetadata: AttachmentMetadata[] | undefined;
    let resolvedImagePaths: string[] | undefined;

    if (projectId && payload.attachments && payload.attachments.length > 0) {
      const imageAttachments = payload.attachments.filter((a) => a.type === 'image');

      if (imageAttachments.length > 0) {
        try {
          console.error(
            `[AgentChatService] Saving ${imageAttachments.length} image attachment(s) for project ${projectId}`,
          );

          for (let i = 0; i < imageAttachments.length; i++) {
            const attachment = imageAttachments[i];
            const saved = await attachmentService.saveAttachment({
              projectId,
              messageId: userMessageId,
              attachment,
              index: i,
            });
            savedAttachments.push(saved);
          }

          // Build metadata array for message persistence
          attachmentMetadata = savedAttachments.map((s) => s.metadata);
          // Build paths array for engine consumption
          resolvedImagePaths = savedAttachments.map((s) => s.absolutePath);

          console.error(
            `[AgentChatService] Saved ${savedAttachments.length} attachment(s): ${resolvedImagePaths.join(', ')}`,
          );
        } catch (error) {
          console.error('[AgentChatService] Failed to save attachments:', error);
          // Continue without attachments - don't fail the entire request
        }
      }
    }

    // Build metadata object for user message
    // Include attachments, clientMeta, and displayText if present
    let userMessageMetadata: Record<string, unknown> | undefined;
    const hasAttachments = attachmentMetadata && attachmentMetadata.length > 0;
    const hasClientMeta = payload.clientMeta !== undefined;
    const hasDisplayText = payload.displayText !== undefined;

    if (hasAttachments || hasClientMeta || hasDisplayText) {
      userMessageMetadata = {};
      if (hasAttachments) {
        userMessageMetadata.attachments = attachmentMetadata;
      }
      if (hasClientMeta) {
        userMessageMetadata.clientMeta = payload.clientMeta;
      }
      if (hasDisplayText) {
        userMessageMetadata.displayText = payload.displayText;
      }
    }

    // Emit a canonical user message into the stream so UI can render from server events only.
    const userMessage: AgentMessage = {
      id: userMessageId,
      sessionId,
      role: 'user',
      content: trimmed,
      messageType: 'chat',
      cliSource: engineName,
      requestId,
      isStreaming: false,
      isFinal: true,
      createdAt: now,
      metadata: userMessageMetadata,
    };

    this.streamManager.publish({ type: 'message', data: userMessage });

    if (projectId) {
      // Persist user message into project history for later reload.
      try {
        await touchProjectActivity(projectId);
        // Update session activity timestamp so it appears at top of session list
        if (dbSessionId) {
          await touchSessionActivity(dbSessionId);
        }
        await persistAgentMessage({
          projectId,
          role: 'user',
          messageType: 'chat',
          content: trimmed,
          sessionId,
          cliSource: engineName,
          requestId,
          id: userMessage.id,
          createdAt: userMessage.createdAt,
          metadata: userMessageMetadata,
        });
      } catch (error) {
        console.error('[AgentChatService] Failed to persist user message:', error);
      }
    }

    this.streamManager.publish({
      type: 'status',
      data: {
        sessionId,
        status: 'starting',
        requestId,
        message: 'Agent request accepted',
      },
    });

    const ctx: EngineExecutionContext = {
      emit: (event: RealtimeEvent) => {
        this.streamManager.publish(event);

        if (!projectId) {
          return;
        }

        if (event.type === 'message') {
          const msg = event.data;
          if (!msg) return;

          // Only persist final snapshots; streaming deltas are transient.
          if (msg.isStreaming && !msg.isFinal) {
            return;
          }

          // User messages are already handled above.
          if (msg.role === 'user') {
            return;
          }

          const content = msg.content?.trim();
          if (!content) {
            return;
          }

          void persistAgentMessage({
            projectId,
            role: msg.role,
            messageType: msg.messageType,
            content,
            metadata: msg.metadata,
            sessionId: msg.sessionId,
            conversationId: undefined,
            cliSource: msg.cliSource,
            requestId: msg.requestId,
            id: msg.id,
            createdAt: msg.createdAt,
          }).catch((error) => {
            console.error('[AgentChatService] Failed to persist agent message:', error);
          });
        }
      },
      // Callback to persist Claude session ID when SDK returns system/init message
      // Prefer session-level persistence over project-level
      persistClaudeSessionId: dbSessionId
        ? async (claudeSessionId: string) => {
            await updateEngineSessionId(dbSessionId, claudeSessionId);
          }
        : projectId
          ? async (claudeSessionId: string) => {
              await updateProjectClaudeSessionId(projectId, claudeSessionId);
            }
          : undefined,
      // Callback to persist management info from system:init message
      // Only available when using session-level persistence
      persistManagementInfo: dbSessionId
        ? async (info) => {
            await updateManagementInfo(dbSessionId, info);
          }
        : undefined,
    };

    const engineOptions: EngineInitOptions = {
      sessionId,
      instruction: trimmed,
      model: effectiveModel,
      projectRoot,
      requestId,
      // Pass original attachments (for fallback) and resolved paths (preferred)
      attachments: payload.attachments,
      resolvedImagePaths,
      projectId,
      dbSessionId,
      // Session-level configuration for ClaudeEngine
      permissionMode: dbSession?.permissionMode,
      allowDangerouslySkipPermissions: dbSession?.allowDangerouslySkipPermissions,
      systemPromptConfig: dbSession?.systemPromptConfig,
      optionsConfig: dbSession?.optionsConfig,
      // Pass Claude session ID for session resumption (ClaudeEngine only)
      resumeClaudeSessionId: engineName === 'claude' ? resumeClaudeSessionId : undefined,
      // Pass useCcr flag for Claude Code Router support (ClaudeEngine only)
      useCcr: engineName === 'claude' ? projectUseCcr : undefined,
      // Pass Codex-specific configuration (CodexEngine only)
      codexConfig: engineName === 'codex' ? dbSession?.optionsConfig?.codexConfig : undefined,
    };

    // Create abort controller for cancellation support
    const abortController = new AbortController();

    // Register execution in the running executions registry
    this.runningExecutions.set(requestId, {
      requestId,
      sessionId,
      engineName,
      abortController,
      startedAt: new Date(),
    });

    // Fire-and-forget execution to keep HTTP handler fast.
    void this.runEngine(engine, engineOptions, ctx, sessionId, requestId, abortController);

    return { requestId };
  }

  /**
   * Cancel a running execution by requestId.
   * Returns true if the execution was found and cancelled, false otherwise.
   */
  cancelExecution(requestId: string): boolean {
    const execution = this.runningExecutions.get(requestId);
    if (!execution) {
      return false;
    }

    // Abort the execution
    execution.abortController.abort();

    // Emit cancelled status
    this.streamManager.publish({
      type: 'status',
      data: {
        sessionId: execution.sessionId,
        status: 'cancelled',
        requestId,
        message: 'Execution cancelled by user',
      },
    });

    // Remove from registry
    this.runningExecutions.delete(requestId);

    return true;
  }

  /**
   * Cancel all running executions for a session.
   * Returns the number of executions cancelled.
   */
  cancelSessionExecutions(sessionId: string): number {
    let cancelled = 0;
    for (const [requestId, execution] of this.runningExecutions) {
      if (execution.sessionId === sessionId) {
        execution.abortController.abort();
        this.runningExecutions.delete(requestId);
        cancelled++;
      }
    }

    if (cancelled > 0) {
      this.streamManager.publish({
        type: 'status',
        data: {
          sessionId,
          status: 'cancelled',
          message: `Cancelled ${cancelled} running execution(s)`,
        },
      });
    }

    return cancelled;
  }

  /**
   * Get list of running executions for diagnostics.
   */
  getRunningExecutions(): RunningExecution[] {
    return Array.from(this.runningExecutions.values());
  }

  private resolveEngineName(preference?: EngineName, projectPreferredCli?: EngineName): EngineName {
    if (preference && this.engines.has(preference)) {
      return preference;
    }
    if (projectPreferredCli && this.engines.has(projectPreferredCli)) {
      return projectPreferredCli;
    }
    return this.defaultEngineName;
  }

  private async runEngine(
    engine: AgentEngine,
    options: EngineInitOptions,
    ctx: EngineExecutionContext,
    sessionId: string,
    requestId: string,
    abortController: AbortController,
  ): Promise<void> {
    try {
      // Check if already aborted before starting
      if (abortController.signal.aborted) {
        return;
      }

      this.streamManager.publish({
        type: 'status',
        data: {
          sessionId,
          status: 'running',
          requestId,
        },
      });

      // Pass abort signal to engine
      const optionsWithSignal: EngineInitOptions = {
        ...options,
        signal: abortController.signal,
      };

      await engine.initializeAndRun(optionsWithSignal, ctx);

      // Only emit completed if not aborted
      if (!abortController.signal.aborted) {
        this.streamManager.publish({
          type: 'status',
          data: {
            sessionId,
            status: 'completed',
            requestId,
          },
        });
      }
    } catch (error) {
      // Check if this was an abort error
      if (abortController.signal.aborted) {
        // Already handled by cancelExecution, just return
        return;
      }

      const message = error instanceof Error ? error.message : String(error);

      this.streamManager.publish({
        type: 'error',
        error: message,
        data: { sessionId, requestId },
      });

      this.streamManager.publish({
        type: 'status',
        data: {
          sessionId,
          status: 'error',
          message,
          requestId,
        },
      });
    } finally {
      // Always remove from running executions when done
      this.runningExecutions.delete(requestId);
    }
  }

  /**
   * Expose registered engines for UI and diagnostics.
   */
  getEngineInfos(): Array<{ name: EngineName; supportsMcp?: boolean }> {
    const result: Array<{ name: EngineName; supportsMcp?: boolean }> = [];
    for (const engine of this.engines.values()) {
      result.push({
        name: engine.name,
        supportsMcp: engine.supportsMcp,
      });
    }
    return result;
  }
}
