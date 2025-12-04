/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode';
import { AcpConnection } from '../acp/acpConnection.js';
import type {
  AcpSessionUpdate,
  AcpPermissionRequest,
} from '../constants/acpTypes.js';
import {
  QwenSessionReader,
  type QwenSession,
} from '../services/qwenSessionReader.js';
import { QwenSessionManager } from '../services/qwenSessionManager.js';
import type { AuthStateManager } from '../auth/authStateManager.js';
import type {
  ChatMessage,
  PlanEntry,
  ToolCallUpdateData,
  QwenAgentCallbacks,
} from './qwenTypes.js';
import { QwenConnectionHandler } from './qwenConnectionHandler.js';
import { QwenSessionUpdateHandler } from './qwenSessionUpdateHandler.js';
import { CliContextManager } from '../cli/cliContextManager.js';

export type { ChatMessage, PlanEntry, ToolCallUpdateData };

/**
 * Qwen Agent Manager
 *
 * Coordinates various modules and provides unified interface
 */
export class QwenAgentManager {
  private connection: AcpConnection;
  private sessionReader: QwenSessionReader;
  private sessionManager: QwenSessionManager;
  private connectionHandler: QwenConnectionHandler;
  private sessionUpdateHandler: QwenSessionUpdateHandler;
  private currentWorkingDir: string = process.cwd();
  // Cache the last used AuthStateManager so internal calls (e.g. fallback paths)
  // can reuse it and avoid forcing a fresh authentication unnecessarily.
  private defaultAuthStateManager?: AuthStateManager;

  // Callback storage
  private callbacks: QwenAgentCallbacks = {};

  constructor() {
    this.connection = new AcpConnection();
    this.sessionReader = new QwenSessionReader();
    this.sessionManager = new QwenSessionManager();
    this.connectionHandler = new QwenConnectionHandler();
    this.sessionUpdateHandler = new QwenSessionUpdateHandler({});

    // Set ACP connection callbacks
    this.connection.onSessionUpdate = (data: AcpSessionUpdate) => {
      this.sessionUpdateHandler.handleSessionUpdate(data);
    };

    this.connection.onPermissionRequest = async (
      data: AcpPermissionRequest,
    ) => {
      if (this.callbacks.onPermissionRequest) {
        const optionId = await this.callbacks.onPermissionRequest(data);
        return { optionId };
      }
      return { optionId: 'allow_once' };
    };

    this.connection.onEndTurn = () => {
      try {
        if (this.callbacks.onEndTurn) {
          this.callbacks.onEndTurn();
        } else if (this.callbacks.onStreamChunk) {
          // Fallback: send a zero-length chunk then rely on streamEnd elsewhere
          this.callbacks.onStreamChunk('');
        }
      } catch (err) {
        console.warn('[QwenAgentManager] onEndTurn callback error:', err);
      }
    };
  }

  /**
   * Connect to Qwen service
   *
   * @param workingDir - Working directory
   * @param authStateManager - Authentication state manager (optional)
   * @param cliPath - CLI path (optional, if provided will override the path in configuration)
   */
  async connect(
    workingDir: string,
    authStateManager?: AuthStateManager,
    _cliPath?: string,
  ): Promise<void> {
    this.currentWorkingDir = workingDir;
    // Remember the provided authStateManager for future calls
    this.defaultAuthStateManager = authStateManager;
    await this.connectionHandler.connect(
      this.connection,
      this.sessionReader,
      workingDir,
      authStateManager,
      _cliPath,
    );
  }

  /**
   * Send message
   *
   * @param message - Message content
   */
  async sendMessage(message: string): Promise<void> {
    await this.connection.sendPrompt(message);
  }

  /**
   * Validate if current session is still active
   * This is a lightweight check to verify session validity
   *
   * @returns True if session is valid, false otherwise
   */
  async validateCurrentSession(): Promise<boolean> {
    try {
      // If we don't have a current session, it's definitely not valid
      if (!this.connection.currentSessionId) {
        return false;
      }

      // Try to get session list to verify our session still exists
      const sessions = await this.getSessionList();
      const currentSessionId = this.connection.currentSessionId;

      // Check if our current session exists in the session list
      const sessionExists = sessions.some(
        (session: Record<string, unknown>) =>
          session.id === currentSessionId ||
          session.sessionId === currentSessionId,
      );

      return sessionExists;
    } catch (error) {
      console.warn('[QwenAgentManager] Session validation failed:', error);
      // If we can't validate, assume session is invalid
      return false;
    }
  }

  /**
   * Check if the current session is valid and can send messages
   * This performs a lightweight validation by sending a test prompt
   *
   * @returns True if session is valid, false otherwise
   */
  async checkSessionValidity(): Promise<boolean> {
    try {
      // If we don't have a current session, it's definitely not valid
      if (!this.connection.currentSessionId) {
        return false;
      }

      // Try to send a lightweight test prompt to validate the session
      // We use a simple prompt that should return quickly
      await this.connection.sendPrompt('test session validity');
      return true;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.warn(
        '[QwenAgentManager] Session validity check failed:',
        errorMsg,
      );

      // Check for common authentication/session expiration errors
      const isAuthError =
        errorMsg.includes('Authentication required') ||
        errorMsg.includes('(code: -32000)') ||
        errorMsg.includes('No active ACP session') ||
        errorMsg.includes('Session not found');

      if (isAuthError) {
        console.log(
          '[QwenAgentManager] Detected authentication/session expiration',
        );
        return false;
      }

      // For other errors, we can't determine validity definitively
      // Assume session is still valid unless we know it's not
      return true;
    }
  }

  /**
   * Get session list with version-aware strategy
   * First tries ACP method if CLI version supports it, falls back to file system method
   *
   * @returns Session list
   */
  async getSessionList(): Promise<Array<Record<string, unknown>>> {
    console.log(
      '[QwenAgentManager] Getting session list with version-aware strategy',
    );

    // Check if CLI supports session/list method
    const cliContextManager = CliContextManager.getInstance();
    const supportsSessionList = cliContextManager.supportsSessionList();

    console.log(
      '[QwenAgentManager] CLI supports session/list:',
      supportsSessionList,
    );

    // Try ACP method first if supported
    if (supportsSessionList) {
      try {
        console.log(
          '[QwenAgentManager] Attempting to get session list via ACP method',
        );
        const response = await this.connection.listSessions();
        console.log('[QwenAgentManager] ACP session list response:', response);

        if (response.result && Array.isArray(response.result)) {
          const sessions = response.result.map((session) => ({
            id: session.sessionId || session.id,
            sessionId: session.sessionId || session.id,
            title: session.title || session.name || 'Untitled Session',
            name: session.title || session.name || 'Untitled Session',
            startTime: session.startTime,
            lastUpdated: session.lastUpdated,
            messageCount: session.messageCount || 0,
            projectHash: session.projectHash,
          }));

          console.log(
            '[QwenAgentManager] Sessions retrieved via ACP:',
            sessions.length,
          );
          return sessions;
        }
      } catch (error) {
        console.warn(
          '[QwenAgentManager] ACP session list failed, falling back to file system method:',
          error,
        );
      }
    }

    // Always fall back to file system method
    try {
      console.log('[QwenAgentManager] Getting session list from file system');
      const sessions = await this.sessionReader.getAllSessions(undefined, true);
      console.log(
        '[QwenAgentManager] Session list from file system (all projects):',
        sessions.length,
      );

      const result = sessions.map(
        (session: QwenSession): Record<string, unknown> => ({
          id: session.sessionId,
          sessionId: session.sessionId,
          title: this.sessionReader.getSessionTitle(session),
          name: this.sessionReader.getSessionTitle(session),
          startTime: session.startTime,
          lastUpdated: session.lastUpdated,
          messageCount: session.messages.length,
          projectHash: session.projectHash,
        }),
      );

      console.log(
        '[QwenAgentManager] Sessions retrieved from file system:',
        result.length,
      );
      return result;
    } catch (error) {
      console.error(
        '[QwenAgentManager] Failed to get session list from file system:',
        error,
      );
      return [];
    }
  }

  /**
   * Get session messages (read from disk)
   *
   * @param sessionId - Session ID
   * @returns Message list
   */
  async getSessionMessages(sessionId: string): Promise<ChatMessage[]> {
    try {
      const session = await this.sessionReader.getSession(
        sessionId,
        this.currentWorkingDir,
      );
      if (!session) {
        return [];
      }

      return session.messages.map(
        (msg: { type: string; content: string; timestamp: string }) => ({
          role:
            msg.type === 'user' ? ('user' as const) : ('assistant' as const),
          content: msg.content,
          timestamp: new Date(msg.timestamp).getTime(),
        }),
      );
    } catch (error) {
      console.error(
        '[QwenAgentManager] Failed to get session messages:',
        error,
      );
      return [];
    }
  }

  /**
   * Save session via /chat save command
   * Since CLI doesn't support session/save ACP method, we send /chat save command directly
   *
   * @param sessionId - Session ID
   * @param tag - Save tag
   * @returns Save response
   */
  async saveSessionViaCommand(
    sessionId: string,
    tag: string,
  ): Promise<{ success: boolean; message?: string }> {
    try {
      console.log(
        '[QwenAgentManager] Saving session via /chat save command:',
        sessionId,
        'with tag:',
        tag,
      );

      // Send /chat save command as a prompt
      // The CLI will handle this as a special command
      await this.connection.sendPrompt(`/chat save "${tag}"`);

      console.log('[QwenAgentManager] /chat save command sent successfully');
      return {
        success: true,
        message: `Session saved with tag: ${tag}`,
      };
    } catch (error) {
      console.error('[QwenAgentManager] /chat save command failed:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Save session via ACP session/save method (deprecated, CLI doesn't support)
   *
   * @deprecated Use saveSessionViaCommand instead
   * @param sessionId - Session ID
   * @param tag - Save tag
   * @returns Save response
   */
  async saveSessionViaAcp(
    sessionId: string,
    tag: string,
  ): Promise<{ success: boolean; message?: string }> {
    // Fallback to command-based save since CLI doesn't support session/save ACP method
    console.warn(
      '[QwenAgentManager] saveSessionViaAcp is deprecated, using command-based save instead',
    );
    return this.saveSessionViaCommand(sessionId, tag);
  }

  /**
   * Save session via /chat save command (CLI way)
   * Calls CLI's native save function to ensure complete content is saved
   *
   * @param tag - Checkpoint tag
   * @returns Save result
   */
  async saveCheckpointViaCommand(
    tag: string,
  ): Promise<{ success: boolean; tag?: string; message?: string }> {
    try {
      console.log(
        '[QwenAgentManager] ===== SAVING VIA /chat save COMMAND =====',
      );
      console.log('[QwenAgentManager] Tag:', tag);

      // Send /chat save command as a prompt
      // The CLI will handle this as a special command and save the checkpoint
      const command = `/chat save "${tag}"`;
      console.log('[QwenAgentManager] Sending command:', command);

      await this.connection.sendPrompt(command);

      console.log(
        '[QwenAgentManager] Command sent, checkpoint should be saved by CLI',
      );

      // Wait a bit for CLI to process the command
      await new Promise((resolve) => setTimeout(resolve, 500));

      return {
        success: true,
        tag,
        message: `Checkpoint saved via CLI: ${tag}`,
      };
    } catch (error) {
      console.error('[QwenAgentManager] /chat save command failed:', error);
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Save session as checkpoint (using CLI format)
   * Saves to ~/.qwen/tmp/{projectHash}/checkpoint-{tag}.json
   * Saves two copies with sessionId and conversationId to ensure recovery via either ID
   *
   * @param messages - Current session messages
   * @param conversationId - Conversation ID (from VSCode extension)
   * @returns Save result
   */
  async saveCheckpoint(
    messages: ChatMessage[],
    conversationId: string,
  ): Promise<{ success: boolean; tag?: string; message?: string }> {
    try {
      console.log('[QwenAgentManager] ===== CHECKPOINT SAVE START =====');
      console.log('[QwenAgentManager] Conversation ID:', conversationId);
      console.log('[QwenAgentManager] Message count:', messages.length);
      console.log(
        '[QwenAgentManager] Current working dir:',
        this.currentWorkingDir,
      );
      console.log(
        '[QwenAgentManager] Current session ID (from CLI):',
        this.currentSessionId,
      );
      // In ACP mode, the CLI does not accept arbitrary slash commands like
      // "/chat save". To ensure we never block on unsupported features,
      // persist checkpoints directly to ~/.qwen/tmp using our SessionManager.
      const qwenMessages = messages.map((m) => ({
        // Generate minimal QwenMessage shape expected by the writer
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        type: m.role === 'user' ? ('user' as const) : ('qwen' as const),
        content: m.content,
      }));

      const tag = await this.sessionManager.saveCheckpoint(
        qwenMessages,
        conversationId,
        this.currentWorkingDir,
        this.currentSessionId || undefined,
      );

      return { success: true, tag };
    } catch (error) {
      console.error('[QwenAgentManager] ===== CHECKPOINT SAVE FAILED =====');
      console.error('[QwenAgentManager] Error:', error);
      console.error(
        '[QwenAgentManager] Error stack:',
        error instanceof Error ? error.stack : 'N/A',
      );
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Save session directly to file system (without relying on ACP)
   *
   * @param messages - Current session messages
   * @param sessionName - Session name
   * @returns Save result
   */
  async saveSessionDirect(
    messages: ChatMessage[],
    sessionName: string,
  ): Promise<{ success: boolean; sessionId?: string; message?: string }> {
    // Use checkpoint format instead of session format
    // This matches CLI's /chat save behavior
    return this.saveCheckpoint(messages, sessionName);
  }

  /**
   * Try to load session via ACP session/load method
   * This method will only be used if CLI version supports it
   *
   * @param sessionId - Session ID
   * @returns Load response or error
   */
  async loadSessionViaAcp(sessionId: string): Promise<unknown> {
    // Check if CLI supports session/load method
    const cliContextManager = CliContextManager.getInstance();
    const supportsSessionLoad = cliContextManager.supportsSessionLoad();

    if (!supportsSessionLoad) {
      throw new Error(
        `CLI version does not support session/load method. Please upgrade to version 0.2.4 or later.`,
      );
    }

    try {
      console.log(
        '[QwenAgentManager] Attempting session/load via ACP for session:',
        sessionId,
      );
      const response = await this.connection.loadSession(sessionId);
      console.log(
        '[QwenAgentManager] Session load succeeded. Response:',
        JSON.stringify(response).substring(0, 200),
      );
      return response;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(
        '[QwenAgentManager] Session load via ACP failed for session:',
        sessionId,
      );
      console.error('[QwenAgentManager] Error type:', error?.constructor?.name);
      console.error('[QwenAgentManager] Error message:', errorMessage);

      // Check if error is from ACP response
      if (error && typeof error === 'object' && 'error' in error) {
        const acpError = error as {
          error?: { code?: number; message?: string };
        };
        if (acpError.error) {
          console.error(
            '[QwenAgentManager] ACP error code:',
            acpError.error.code,
          );
          console.error(
            '[QwenAgentManager] ACP error message:',
            acpError.error.message,
          );
        }
      }

      throw error;
    }
  }

  /**
   * Load session with version-aware strategy
   * First tries ACP method if CLI version supports it, falls back to file system method
   *
   * @param sessionId - Session ID to load
   * @returns Loaded session messages or null
   */
  async loadSession(sessionId: string): Promise<ChatMessage[] | null> {
    console.log(
      '[QwenAgentManager] Loading session with version-aware strategy:',
      sessionId,
    );

    // Check if CLI supports session/load method
    const cliContextManager = CliContextManager.getInstance();
    const supportsSessionLoad = cliContextManager.supportsSessionLoad();

    console.log(
      '[QwenAgentManager] CLI supports session/load:',
      supportsSessionLoad,
    );

    // Try ACP method first if supported
    if (supportsSessionLoad) {
      try {
        console.log(
          '[QwenAgentManager] Attempting to load session via ACP method',
        );
        await this.loadSessionViaAcp(sessionId);
        console.log('[QwenAgentManager] Session loaded successfully via ACP');

        // After loading via ACP, we still need to get messages from file system
        // In future, we might get them directly from the ACP response
      } catch (error) {
        console.warn(
          '[QwenAgentManager] ACP session load failed, falling back to file system method:',
          error,
        );
      }
    }

    // Always fall back to file system method
    try {
      console.log(
        '[QwenAgentManager] Loading session messages from file system',
      );
      const messages = await this.loadSessionMessagesFromFile(sessionId);
      console.log(
        '[QwenAgentManager] Session messages loaded successfully from file system',
      );
      return messages;
    } catch (error) {
      console.error(
        '[QwenAgentManager] Failed to load session messages from file system:',
        error,
      );
      return null;
    }
  }

  /**
   * Load session messages from file system
   *
   * @param sessionId - Session ID to load
   * @returns Loaded session messages
   */
  private async loadSessionMessagesFromFile(
    sessionId: string,
  ): Promise<ChatMessage[] | null> {
    try {
      console.log(
        '[QwenAgentManager] Loading session from file system:',
        sessionId,
      );

      // Load session from file system
      const session = await this.sessionManager.loadSession(
        sessionId,
        this.currentWorkingDir,
      );

      if (!session) {
        console.log(
          '[QwenAgentManager] Session not found in file system:',
          sessionId,
        );
        return null;
      }

      // Convert message format
      const messages: ChatMessage[] = session.messages.map((msg) => ({
        role: msg.type === 'user' ? 'user' : 'assistant',
        content: msg.content,
        timestamp: new Date(msg.timestamp).getTime(),
      }));

      return messages;
    } catch (error) {
      console.error(
        '[QwenAgentManager] Session load from file system failed:',
        error,
      );
      throw error;
    }
  }

  /**
   * Load session, preferring ACP method if CLI version supports it
   *
   * @param sessionId - Session ID
   * @returns Loaded session messages or null
   */
  async loadSessionDirect(sessionId: string): Promise<ChatMessage[] | null> {
    return this.loadSession(sessionId);
  }

  /**
   * Create new session
   *
   * Note: Authentication should be done in connect() method, only create session here
   *
   * @param workingDir - Working directory
   * @returns Newly created session ID
   */
  async createNewSession(
    workingDir: string,
    authStateManager?: AuthStateManager,
  ): Promise<string | null> {
    console.log('[QwenAgentManager] Creating new session...');

    // Check if we have valid cached authentication
    let hasValidAuth = false;
    const config = vscode.workspace.getConfiguration('qwenCode');
    const openaiApiKey = config.get<string>('qwen.openaiApiKey', '');
    const authMethod = openaiApiKey ? 'openai' : 'qwen-oauth';
    // Prefer the provided authStateManager, otherwise fall back to the one
    // remembered during connect(). This prevents accidental re-auth in
    // fallback paths (e.g. session switching) when the handler didn't pass it.
    const effectiveAuth = authStateManager || this.defaultAuthStateManager;
    if (effectiveAuth) {
      hasValidAuth = await effectiveAuth.hasValidAuth(workingDir, authMethod);
      console.log(
        '[QwenAgentManager] Has valid cached auth for new session:',
        hasValidAuth,
      );
    }

    // Only authenticate if we don't have valid cached auth
    if (!hasValidAuth) {
      console.log(
        '[QwenAgentManager] Authenticating before creating session...',
      );
      try {
        await this.connection.authenticate(authMethod);
        console.log('[QwenAgentManager] Authentication successful');

        // Save auth state
        if (effectiveAuth) {
          console.log(
            '[QwenAgentManager] Saving auth state after successful authentication',
          );
          await effectiveAuth.saveAuthState(workingDir, authMethod);
        }
      } catch (authError) {
        console.error('[QwenAgentManager] Authentication failed:', authError);
        // Clear potentially invalid cache
        if (effectiveAuth) {
          console.log(
            '[QwenAgentManager] Clearing auth cache due to authentication failure',
          );
          await effectiveAuth.clearAuthState();
        }
        throw authError;
      }
    } else {
      console.log(
        '[QwenAgentManager] Skipping authentication - using valid cached auth',
      );
    }

    // Try to create a new ACP session. If the backend asks for auth despite our
    // cached flag (e.g. fresh process or expired tokens), re-authenticate and retry.
    try {
      await this.connection.newSession(workingDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const requiresAuth =
        msg.includes('Authentication required') ||
        msg.includes('(code: -32000)');

      if (requiresAuth) {
        console.warn(
          '[QwenAgentManager] session/new requires authentication. Retrying with authenticate...',
        );
        try {
          await this.connection.authenticate(authMethod);
          // Persist auth cache so subsequent calls can skip the web flow.
          if (effectiveAuth) {
            await effectiveAuth.saveAuthState(workingDir, authMethod);
          }
          await this.connection.newSession(workingDir);
        } catch (reauthErr) {
          // Clear potentially stale cache on failure and rethrow
          if (effectiveAuth) {
            await effectiveAuth.clearAuthState();
          }
          throw reauthErr;
        }
      } else {
        throw err;
      }
    }
    const newSessionId = this.connection.currentSessionId;
    console.log(
      '[QwenAgentManager] New session created with ID:',
      newSessionId,
    );
    return newSessionId;
  }

  /**
   * Switch to specified session
   *
   * @param sessionId - Session ID
   */
  async switchToSession(sessionId: string): Promise<void> {
    await this.connection.switchSession(sessionId);
  }

  /**
   * Cancel current prompt
   */
  async cancelCurrentPrompt(): Promise<void> {
    console.log('[QwenAgentManager] Cancelling current prompt');
    await this.connection.cancelSession();
  }

  /**
   * Register message callback
   *
   * @param callback - Message callback function
   */
  onMessage(callback: (message: ChatMessage) => void): void {
    this.callbacks.onMessage = callback;
    this.sessionUpdateHandler.updateCallbacks(this.callbacks);
  }

  /**
   * Register stream chunk callback
   *
   * @param callback - Stream chunk callback function
   */
  onStreamChunk(callback: (chunk: string) => void): void {
    this.callbacks.onStreamChunk = callback;
    this.sessionUpdateHandler.updateCallbacks(this.callbacks);
  }

  /**
   * Register thought chunk callback
   *
   * @param callback - Thought chunk callback function
   */
  onThoughtChunk(callback: (chunk: string) => void): void {
    this.callbacks.onThoughtChunk = callback;
    this.sessionUpdateHandler.updateCallbacks(this.callbacks);
  }

  /**
   * Register tool call callback
   *
   * @param callback - Tool call callback function
   */
  onToolCall(callback: (update: ToolCallUpdateData) => void): void {
    this.callbacks.onToolCall = callback;
    this.sessionUpdateHandler.updateCallbacks(this.callbacks);
  }

  /**
   * Register plan callback
   *
   * @param callback - Plan callback function
   */
  onPlan(callback: (entries: PlanEntry[]) => void): void {
    this.callbacks.onPlan = callback;
    this.sessionUpdateHandler.updateCallbacks(this.callbacks);
  }

  /**
   * Register permission request callback
   *
   * @param callback - Permission request callback function
   */
  onPermissionRequest(
    callback: (request: AcpPermissionRequest) => Promise<string>,
  ): void {
    this.callbacks.onPermissionRequest = callback;
    this.sessionUpdateHandler.updateCallbacks(this.callbacks);
  }

  /**
   * Register end-of-turn callback
   *
   * @param callback - Called when ACP stopReason === 'end_turn'
   */
  onEndTurn(callback: () => void): void {
    this.callbacks.onEndTurn = callback;
    this.sessionUpdateHandler.updateCallbacks(this.callbacks);
  }

  /**
   * Disconnect
   */
  disconnect(): void {
    this.connection.disconnect();
  }

  /**
   * Check if connected
   */
  get isConnected(): boolean {
    return this.connection.isConnected;
  }

  /**
   * Get current session ID
   */
  get currentSessionId(): string | null {
    return this.connection.currentSessionId;
  }
}
