/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { AcpConnection } from './acpConnection.js';
import type {
  AcpSessionUpdate,
  AcpPermissionRequest,
  ApprovalModeValue,
} from '../types/acpTypes.js';
import { QwenSessionReader, type QwenSession } from './qwenSessionReader.js';
import { QwenSessionManager } from './qwenSessionManager.js';
import type { AuthStateManager } from './authStateManager.js';
import type {
  ChatMessage,
  PlanEntry,
  ToolCallUpdateData,
  QwenAgentCallbacks,
} from '../types/chatTypes.js';
import { QwenConnectionHandler } from '../services/qwenConnectionHandler.js';
import { QwenSessionUpdateHandler } from './qwenSessionUpdateHandler.js';
import { CliContextManager } from '../cli/cliContextManager.js';
import { authMethod } from '../types/acpTypes.js';
import { MIN_CLI_VERSION_FOR_SESSION_METHODS } from '../cli/cliVersionManager.js';

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
  // When loading a past session via ACP, the CLI replays history through
  // session/update notifications. We set this flag to route message chunks
  // (user/assistant) as discrete chat messages instead of live streaming.
  private rehydratingSessionId: string | null = null;
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
      // If we are rehydrating a loaded session, map message chunks into
      // full messages for the UI, instead of streaming behavior.
      try {
        const targetId = this.rehydratingSessionId;
        if (
          targetId &&
          typeof data === 'object' &&
          data &&
          'update' in data &&
          (data as { sessionId?: string }).sessionId === targetId
        ) {
          const update = (
            data as unknown as {
              update: { sessionUpdate: string; content?: { text?: string } };
            }
          ).update;
          const text = update?.content?.text || '';
          if (update?.sessionUpdate === 'user_message_chunk' && text) {
            console.log(
              '[QwenAgentManager] Rehydration: routing user message chunk',
            );
            this.callbacks.onMessage?.({
              role: 'user',
              content: text,
              timestamp: Date.now(),
            });
            return;
          }
          if (update?.sessionUpdate === 'agent_message_chunk' && text) {
            console.log(
              '[QwenAgentManager] Rehydration: routing agent message chunk',
            );
            this.callbacks.onMessage?.({
              role: 'assistant',
              content: text,
              timestamp: Date.now(),
            });
            return;
          }
          // For other types during rehydration, fall through to normal handler
          console.log(
            '[QwenAgentManager] Rehydration: non-text update, forwarding to handler',
          );
        }
      } catch (err) {
        console.warn('[QwenAgentManager] Rehydration routing failed:', err);
      }

      // Default handling path
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

    // Initialize callback to surface available modes and current mode to UI
    this.connection.onInitialized = (init: unknown) => {
      try {
        const obj = (init || {}) as Record<string, unknown>;
        const modes = obj['modes'] as
          | {
              currentModeId?: 'plan' | 'default' | 'auto-edit' | 'yolo';
              availableModes?: Array<{
                id: 'plan' | 'default' | 'auto-edit' | 'yolo';
                name: string;
                description: string;
              }>;
            }
          | undefined;
        if (modes && this.callbacks.onModeInfo) {
          this.callbacks.onModeInfo({
            currentModeId: modes.currentModeId,
            availableModes: modes.availableModes,
          });
        }
      } catch (err) {
        console.warn('[QwenAgentManager] onInitialized parse error:', err);
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
   * Set approval mode from UI
   */
  async setApprovalModeFromUi(
    mode: ApprovalModeValue,
  ): Promise<ApprovalModeValue> {
    const modeId = mode;
    try {
      const res = await this.connection.setMode(modeId);
      // Optimistically notify UI using response
      const result = (res?.result || {}) as { modeId?: string };
      const confirmed =
        (result.modeId as
          | 'plan'
          | 'default'
          | 'auto-edit'
          | 'yolo'
          | undefined) || modeId;
      this.callbacks.onModeChanged?.(confirmed);
      return confirmed;
    } catch (err) {
      console.error('[QwenAgentManager] Failed to set mode:', err);
      throw err;
    }
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

        // sendRequest resolves with the JSON-RPC "result" directly
        // Newer CLI returns an object: { items: [...], nextCursor?, hasMore }
        // Older prototypes might return an array. Support both.
        const res: unknown = response;
        let items: Array<Record<string, unknown>> = [];

        // Note: AcpSessionManager resolves `sendRequest` with the JSON-RPC
        // "result" directly (not the full AcpResponse). Treat it as unknown
        // and carefully narrow before accessing `items` to satisfy strict TS.
        if (res && typeof res === 'object' && 'items' in res) {
          const itemsValue = (res as { items?: unknown }).items;
          items = Array.isArray(itemsValue)
            ? (itemsValue as Array<Record<string, unknown>>)
            : [];
        }

        console.log(
          '[QwenAgentManager] Sessions retrieved via ACP:',
          res,
          items.length,
        );
        if (items.length > 0) {
          const sessions = items.map((item) => ({
            id: item.sessionId || item.id,
            sessionId: item.sessionId || item.id,
            title: item.title || item.name || item.prompt || 'Untitled Session',
            name: item.title || item.name || item.prompt || 'Untitled Session',
            startTime: item.startTime,
            lastUpdated: item.mtime || item.lastUpdated,
            messageCount: item.messageCount || 0,
            projectHash: item.projectHash,
            filePath: item.filePath,
            cwd: item.cwd,
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
   * Get session list (paged)
   * Uses ACP session/list with cursor-based pagination when available.
   * Falls back to file system scan with equivalent pagination semantics.
   */
  async getSessionListPaged(params?: {
    cursor?: number;
    size?: number;
  }): Promise<{
    sessions: Array<Record<string, unknown>>;
    nextCursor?: number;
    hasMore: boolean;
  }> {
    const size = params?.size ?? 20;
    const cursor = params?.cursor;

    const cliContextManager = CliContextManager.getInstance();
    const supportsSessionList = cliContextManager.supportsSessionList();

    if (supportsSessionList) {
      try {
        const response = await this.connection.listSessions({
          size,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        // sendRequest resolves with the JSON-RPC "result" directly
        const res: unknown = response;
        let items: Array<Record<string, unknown>> = [];

        if (Array.isArray(res)) {
          items = res;
        } else if (typeof res === 'object' && res !== null && 'items' in res) {
          const responseObject = res as {
            items?: Array<Record<string, unknown>>;
          };
          items = Array.isArray(responseObject.items)
            ? responseObject.items
            : [];
        }

        const mapped = items.map((item) => ({
          id: item.sessionId || item.id,
          sessionId: item.sessionId || item.id,
          title: item.title || item.name || item.prompt || 'Untitled Session',
          name: item.title || item.name || item.prompt || 'Untitled Session',
          startTime: item.startTime,
          lastUpdated: item.mtime || item.lastUpdated,
          messageCount: item.messageCount || 0,
          projectHash: item.projectHash,
          filePath: item.filePath,
          cwd: item.cwd,
        }));

        const nextCursor: number | undefined =
          typeof res === 'object' && res !== null && 'nextCursor' in res
            ? typeof res.nextCursor === 'number'
              ? res.nextCursor
              : undefined
            : undefined;
        const hasMore: boolean =
          typeof res === 'object' && res !== null && 'hasMore' in res
            ? Boolean(res.hasMore)
            : false;

        return { sessions: mapped, nextCursor, hasMore };
      } catch (error) {
        console.warn(
          '[QwenAgentManager] Paged ACP session list failed:',
          error,
        );
        // fall through to file system
      }
    }

    // Fallback: file system for current project only (to match ACP semantics)
    try {
      const all = await this.sessionReader.getAllSessions(
        this.currentWorkingDir,
        false,
      );
      // Sorted by lastUpdated desc already per reader
      const allWithMtime = all.map((s) => ({
        raw: s,
        mtime: new Date(s.lastUpdated).getTime(),
      }));
      const filtered =
        cursor !== undefined
          ? allWithMtime.filter((x) => x.mtime < cursor)
          : allWithMtime;
      const page = filtered.slice(0, size);
      const sessions = page.map((x) => ({
        id: x.raw.sessionId,
        sessionId: x.raw.sessionId,
        title: this.sessionReader.getSessionTitle(x.raw),
        name: this.sessionReader.getSessionTitle(x.raw),
        startTime: x.raw.startTime,
        lastUpdated: x.raw.lastUpdated,
        messageCount: x.raw.messages.length,
        projectHash: x.raw.projectHash,
      }));
      const nextCursorVal =
        page.length > 0 ? page[page.length - 1].mtime : undefined;
      const hasMore = filtered.length > size;
      return { sessions, nextCursor: nextCursorVal, hasMore };
    } catch (error) {
      console.error('[QwenAgentManager] File system paged list failed:', error);
      return { sessions: [], hasMore: false };
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
      // Prefer reading CLI's JSONL if we can find filePath from session/list
      const cliContextManager = CliContextManager.getInstance();
      if (cliContextManager.supportsSessionList()) {
        try {
          const list = await this.getSessionList();
          const item = list.find(
            (s) => s.sessionId === sessionId || s.id === sessionId,
          );
          console.log(
            '[QwenAgentManager] Session list item for filePath lookup:',
            item,
          );
          if (
            typeof item === 'object' &&
            item !== null &&
            'filePath' in item &&
            typeof item.filePath === 'string'
          ) {
            const messages = await this.readJsonlMessages(item.filePath);
            // Even if messages array is empty, we should return it rather than falling back
            // This ensures we don't accidentally show messages from a different session format
            return messages;
          }
        } catch (e) {
          console.warn('[QwenAgentManager] JSONL read path lookup failed:', e);
        }
      }

      // Fallback: legacy JSON session files
      const session = await this.sessionReader.getSession(
        sessionId,
        this.currentWorkingDir,
      );
      if (!session) {
        return [];
      }
      return session.messages.map(
        (msg: { type: string; content: string; timestamp: string }) => ({
          role: msg.type === 'user' ? 'user' : 'assistant',
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

  // Read CLI JSONL session file and convert to ChatMessage[] for UI
  private async readJsonlMessages(filePath: string): Promise<ChatMessage[]> {
    const fs = await import('fs');
    const readline = await import('readline');
    try {
      if (!fs.existsSync(filePath)) {
        return [];
      }
      const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });
      const records: unknown[] = [];
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const obj = JSON.parse(trimmed);
          records.push(obj);
        } catch {
          /* ignore */
        }
      }
      // Simple linear reconstruction: filter user/assistant and sort by timestamp
      console.log(
        '[QwenAgentManager] JSONL records read:',
        records.length,
        filePath,
      );

      // Include all types of records, not just user/assistant
      // Narrow unknown JSONL rows into a minimal shape we can work with.
      type JsonlRecord = {
        type: string;
        timestamp: string;
        message?: unknown;
        toolCallResult?: { callId?: string; status?: string } | unknown;
        subtype?: string;
        systemPayload?: { uiEvent?: Record<string, unknown> } | unknown;
        plan?: { entries?: Array<Record<string, unknown>> } | unknown;
      };

      const isJsonlRecord = (x: unknown): x is JsonlRecord =>
        typeof x === 'object' &&
        x !== null &&
        typeof (x as Record<string, unknown>).type === 'string' &&
        typeof (x as Record<string, unknown>).timestamp === 'string';

      const allRecords = records
        .filter(isJsonlRecord)
        .sort(
          (a, b) =>
            new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );

      const msgs: ChatMessage[] = [];
      for (const r of allRecords) {
        // Handle user and assistant messages
        if ((r.type === 'user' || r.type === 'assistant') && r.message) {
          msgs.push({
            role:
              r.type === 'user' ? ('user' as const) : ('assistant' as const),
            content: this.contentToText(r.message),
            timestamp: new Date(r.timestamp).getTime(),
          });
        }
        // Handle tool call records that might have content we want to show
        else if (r.type === 'tool_call' || r.type === 'tool_call_update') {
          // Convert tool calls to messages if they have relevant content
          const toolContent = this.extractToolCallContent(r as unknown);
          if (toolContent) {
            msgs.push({
              role: 'assistant',
              content: toolContent,
              timestamp: new Date(r.timestamp).getTime(),
            });
          }
        }
        // Handle tool result records
        else if (
          r.type === 'tool_result' &&
          r.toolCallResult &&
          typeof r.toolCallResult === 'object'
        ) {
          const toolResult = r.toolCallResult as {
            callId?: string;
            status?: string;
          };
          const callId = toolResult.callId ?? 'unknown';
          const status = toolResult.status ?? 'unknown';
          const resultText = `Tool Result (${callId}): ${status}`;
          msgs.push({
            role: 'assistant',
            content: resultText,
            timestamp: new Date(r.timestamp).getTime(),
          });
        }
        // Handle system telemetry records
        else if (
          r.type === 'system' &&
          r.subtype === 'ui_telemetry' &&
          r.systemPayload &&
          typeof r.systemPayload === 'object' &&
          'uiEvent' in r.systemPayload &&
          (r.systemPayload as { uiEvent?: Record<string, unknown> }).uiEvent
        ) {
          const uiEvent = (
            r.systemPayload as {
              uiEvent?: Record<string, unknown>;
            }
          ).uiEvent as Record<string, unknown>;
          let telemetryText = '';

          if (
            typeof uiEvent['event.name'] === 'string' &&
            (uiEvent['event.name'] as string).includes('tool_call')
          ) {
            const functionName =
              (uiEvent['function_name'] as string | undefined) ||
              'Unknown tool';
            const status =
              (uiEvent['status'] as string | undefined) || 'unknown';
            const duration =
              typeof uiEvent['duration_ms'] === 'number'
                ? ` (${uiEvent['duration_ms']}ms)`
                : '';
            telemetryText = `Tool Call: ${functionName} - ${status}${duration}`;
          } else if (
            typeof uiEvent['event.name'] === 'string' &&
            (uiEvent['event.name'] as string).includes('api_response')
          ) {
            const statusCode =
              (uiEvent['status_code'] as string | number | undefined) ||
              'unknown';
            const duration =
              typeof uiEvent['duration_ms'] === 'number'
                ? ` (${uiEvent['duration_ms']}ms)`
                : '';
            telemetryText = `API Response: Status ${statusCode}${duration}`;
          } else {
            // Generic system telemetry
            const eventName =
              (uiEvent['event.name'] as string | undefined) || 'Unknown event';
            telemetryText = `System Event: ${eventName}`;
          }

          if (telemetryText) {
            msgs.push({
              role: 'assistant',
              content: telemetryText,
              timestamp: new Date(r.timestamp).getTime(),
            });
          }
        }
        // Handle plan entries
        else if (
          r.type === 'plan' &&
          r.plan &&
          typeof r.plan === 'object' &&
          'entries' in r.plan
        ) {
          const planEntries =
            ((r.plan as { entries?: Array<Record<string, unknown>> })
              .entries as Array<Record<string, unknown>> | undefined) || [];
          if (planEntries.length > 0) {
            const planText = planEntries
              .map(
                (entry: Record<string, unknown>, index: number) =>
                  `${index + 1}. ${entry.description || entry.title || 'Unnamed step'}`,
              )
              .join('\n');
            msgs.push({
              role: 'assistant',
              content: `Plan:\n${planText}`,
              timestamp: new Date(r.timestamp).getTime(),
            });
          }
        }
        // Handle other types if needed
      }

      console.log(
        '[QwenAgentManager] JSONL messages reconstructed:',
        msgs.length,
      );
      return msgs;
    } catch (err) {
      console.warn('[QwenAgentManager] Failed to read JSONL messages:', err);
      return [];
    }
  }

  // Extract meaningful content from tool call records
  private extractToolCallContent(record: unknown): string | null {
    try {
      // Type guard for record
      if (typeof record !== 'object' || record === null) {
        return null;
      }

      // Cast to a more specific type for easier handling
      const typedRecord = record as Record<string, unknown>;

      // If the tool call has a result or output, include it
      if ('toolCallResult' in typedRecord && typedRecord.toolCallResult) {
        return `Tool result: ${this.formatValue(typedRecord.toolCallResult)}`;
      }

      // If the tool call has content, include it
      if ('content' in typedRecord && typedRecord.content) {
        return this.formatValue(typedRecord.content);
      }

      // If the tool call has a title or name, include it
      if (
        ('title' in typedRecord && typedRecord.title) ||
        ('name' in typedRecord && typedRecord.name)
      ) {
        return `Tool: ${typedRecord.title || typedRecord.name}`;
      }

      // Handle tool_call records with more details
      if (
        typedRecord.type === 'tool_call' &&
        'toolCall' in typedRecord &&
        typedRecord.toolCall
      ) {
        const toolCall = typedRecord.toolCall as Record<string, unknown>;
        if (
          ('title' in toolCall && toolCall.title) ||
          ('name' in toolCall && toolCall.name)
        ) {
          return `Tool call: ${toolCall.title || toolCall.name}`;
        }
        if ('rawInput' in toolCall && toolCall.rawInput) {
          return `Tool input: ${this.formatValue(toolCall.rawInput)}`;
        }
      }

      // Handle tool_call_update records with status
      if (typedRecord.type === 'tool_call_update') {
        const status =
          ('status' in typedRecord && typedRecord.status) || 'unknown';
        const title =
          ('title' in typedRecord && typedRecord.title) ||
          ('name' in typedRecord && typedRecord.name) ||
          'Unknown tool';
        return `Tool ${status}: ${title}`;
      }

      return null;
    } catch {
      return null;
    }
  }

  // Format any value to a string for display
  private formatValue(value: unknown): string {
    if (value === null || value === undefined) {
      return '';
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value, null, 2);
      } catch (_e) {
        return String(value);
      }
    }
    return String(value);
  }

  // Extract plain text from Content (genai Content)
  private contentToText(message: unknown): string {
    try {
      // Type guard for message
      if (typeof message !== 'object' || message === null) {
        return '';
      }

      // Cast to a more specific type for easier handling
      const typedMessage = message as Record<string, unknown>;

      const parts = Array.isArray(typedMessage.parts) ? typedMessage.parts : [];
      const texts: string[] = [];
      for (const p of parts) {
        // Type guard for part
        if (typeof p !== 'object' || p === null) {
          continue;
        }

        const typedPart = p as Record<string, unknown>;
        if (typeof typedPart.text === 'string') {
          texts.push(typedPart.text);
        } else if (typeof typedPart.data === 'string') {
          texts.push(typedPart.data);
        }
      }
      return texts.join('\n');
    } catch {
      return '';
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
  async loadSessionViaAcp(
    sessionId: string,
    cwdOverride?: string,
  ): Promise<unknown> {
    // Check if CLI supports session/load method
    const cliContextManager = CliContextManager.getInstance();
    const supportsSessionLoad = cliContextManager.supportsSessionLoad();

    if (!supportsSessionLoad) {
      throw new Error(
        `CLI version does not support session/load method. Please upgrade to version ${MIN_CLI_VERSION_FOR_SESSION_METHODS} or later.`,
      );
    }

    try {
      // Route upcoming session/update messages as discrete messages for replay
      this.rehydratingSessionId = sessionId;
      console.log(
        '[QwenAgentManager] Rehydration start for session:',
        sessionId,
      );
      console.log(
        '[QwenAgentManager] Attempting session/load via ACP for session:',
        sessionId,
      );
      const response = await this.connection.loadSession(
        sessionId,
        cwdOverride,
      );
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
      if (error && typeof error === 'object') {
        // Safely check if 'error' property exists
        if ('error' in error) {
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
        } else {
          console.error('[QwenAgentManager] Non-ACPIf error details:', error);
        }
      }

      throw error;
    } finally {
      // End rehydration routing regardless of outcome
      console.log('[QwenAgentManager] Rehydration end for session:', sessionId);
      this.rehydratingSessionId = null;
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

    // Try to create a new ACP session. If Qwen asks for auth despite our
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
   * Register initialize mode info callback
   */
  onModeInfo(
    callback: (info: {
      currentModeId?: 'plan' | 'default' | 'auto-edit' | 'yolo';
      availableModes?: Array<{
        id: 'plan' | 'default' | 'auto-edit' | 'yolo';
        name: string;
        description: string;
      }>;
    }) => void,
  ): void {
    this.callbacks.onModeInfo = callback;
    this.sessionUpdateHandler.updateCallbacks(this.callbacks);
  }

  /**
   * Register mode changed callback
   */
  onModeChanged(
    callback: (modeId: 'plan' | 'default' | 'auto-edit' | 'yolo') => void,
  ): void {
    this.callbacks.onModeChanged = callback;
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
