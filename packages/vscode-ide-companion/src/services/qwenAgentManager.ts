/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { AcpConnection } from './acpConnection.js';
import type {
  AcpSessionUpdate,
  AcpPermissionRequest,
  AuthenticateUpdateNotification,
  ModelInfo,
} from '../types/acpTypes.js';
import type { ApprovalModeValue } from '../types/approvalModeValueTypes.js';
import { QwenSessionReader, type QwenSession } from './qwenSessionReader.js';
import { QwenSessionManager } from './qwenSessionManager.js';
import type {
  ChatMessage,
  PlanEntry,
  ToolCallUpdateData,
  QwenAgentCallbacks,
  UsageStatsPayload,
} from '../types/chatTypes.js';
import {
  QwenConnectionHandler,
  type QwenConnectionResult,
} from '../services/qwenConnectionHandler.js';
import { QwenSessionUpdateHandler } from './qwenSessionUpdateHandler.js';
import { authMethod } from '../types/acpTypes.js';
import { extractModelInfoFromNewSessionResult } from '../utils/acpModelInfo.js';
import { isAuthenticationRequiredError } from '../utils/authErrors.js';
import { handleAuthenticateUpdate } from '../utils/authNotificationHandler.js';

export type { ChatMessage, PlanEntry, ToolCallUpdateData };

/**
 * Qwen Agent Manager
 *
 * Coordinates various modules and provides unified interface
 */
interface AgentConnectOptions {
  autoAuthenticate?: boolean;
}
interface AgentSessionOptions {
  autoAuthenticate?: boolean;
}

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
  // CLI is now the single source of truth for authentication state
  // Deduplicate concurrent session/new attempts
  private sessionCreateInFlight: Promise<string | null> | null = null;

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

    this.connection.onEndTurn = (reason?: string) => {
      try {
        if (this.callbacks.onEndTurn) {
          this.callbacks.onEndTurn(reason);
        } else if (this.callbacks.onStreamChunk) {
          // Fallback: send a zero-length chunk then rely on streamEnd elsewhere
          this.callbacks.onStreamChunk('');
        }
      } catch (err) {
        console.warn('[QwenAgentManager] onEndTurn callback error:', err);
      }
    };

    this.connection.onAuthenticateUpdate = (
      data: AuthenticateUpdateNotification,
    ) => {
      try {
        // Handle authentication update notifications by showing VS Code notification
        handleAuthenticateUpdate(data);
      } catch (err) {
        console.warn(
          '[QwenAgentManager] onAuthenticateUpdate callback error:',
          err,
        );
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
   * @param cliEntryPath - Path to bundled CLI entrypoint (cli.js)
   */
  async connect(
    workingDir: string,
    cliEntryPath: string,
    options?: AgentConnectOptions,
  ): Promise<QwenConnectionResult> {
    this.currentWorkingDir = workingDir;
    const res = await this.connectionHandler.connect(
      this.connection,
      workingDir,
      cliEntryPath,
      options,
    );
    if (res.modelInfo && this.callbacks.onModelInfo) {
      this.callbacks.onModelInfo(res.modelInfo);
    }
    return res;
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
          messageCount: session.messageCount ?? session.messages.length,
          projectHash: session.projectHash,
          filePath: session.filePath,
          cwd: session.cwd,
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
        items = Array.isArray(responseObject.items) ? responseObject.items : [];
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
      console.warn('[QwenAgentManager] Paged ACP session list failed:', error);
      // fall through to file system
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
        messageCount: x.raw.messageCount ?? x.raw.messages.length,
        projectHash: x.raw.projectHash,
        filePath: x.raw.filePath,
        cwd: x.raw.cwd,
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
                  `${index + 1}. ${
                    entry.description || entry.title || 'Unnamed step'
                  }`,
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
   * Create new session
   *
   * Note: Authentication should be done in connect() method, only create session here
   *
   * @param workingDir - Working directory
   * @returns Newly created session ID
   */
  async createNewSession(
    workingDir: string,
    options?: AgentSessionOptions,
  ): Promise<string | null> {
    const autoAuthenticate = options?.autoAuthenticate ?? true;
    // Reuse existing session if present
    if (this.connection.currentSessionId) {
      return this.connection.currentSessionId;
    }
    // Deduplicate concurrent session/new attempts
    if (this.sessionCreateInFlight) {
      return this.sessionCreateInFlight;
    }

    console.log('[QwenAgentManager] Creating new session...');

    this.sessionCreateInFlight = (async () => {
      try {
        let newSessionResult: unknown;
        // Try to create a new ACP session. If Qwen asks for auth, let it handle authentication.
        try {
          newSessionResult = await this.connection.newSession(workingDir);
        } catch (err) {
          const requiresAuth = isAuthenticationRequiredError(err);

          if (requiresAuth) {
            if (!autoAuthenticate) {
              console.warn(
                '[QwenAgentManager] session/new requires authentication but auto-auth is disabled. Deferring until user logs in.',
              );
              throw err;
            }
            console.warn(
              '[QwenAgentManager] session/new requires authentication. Retrying with authenticate...',
            );
            try {
              // Let CLI handle authentication - it's the single source of truth
              await this.connection.authenticate(authMethod);
              console.log(
                '[QwenAgentManager] createNewSession Authentication successful. Retrying session/new...',
              );
              // Add a slight delay to ensure auth state is settled
              await new Promise((resolve) => setTimeout(resolve, 300));
              newSessionResult = await this.connection.newSession(workingDir);
            } catch (reauthErr) {
              console.error(
                '[QwenAgentManager] Re-authentication failed:',
                reauthErr,
              );
              throw reauthErr;
            }
          } else {
            throw err;
          }
        }

        const modelInfo =
          extractModelInfoFromNewSessionResult(newSessionResult);
        if (modelInfo && this.callbacks.onModelInfo) {
          this.callbacks.onModelInfo(modelInfo);
        }

        const newSessionId = this.connection.currentSessionId;
        console.log(
          '[QwenAgentManager] New session created with ID:',
          newSessionId,
        );
        return newSessionId;
      } finally {
        this.sessionCreateInFlight = null;
      }
    })();

    return this.sessionCreateInFlight;
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
   * @param callback - Called when ACP stopReason is reported
   */
  onEndTurn(callback: (reason?: string) => void): void {
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
   * Register callback for usage metadata updates
   */
  onUsageUpdate(callback: (stats: UsageStatsPayload) => void): void {
    this.callbacks.onUsageUpdate = callback;
    this.sessionUpdateHandler.updateCallbacks(this.callbacks);
  }

  /**
   * Register callback for model info updates
   */
  onModelInfo(callback: (info: ModelInfo) => void): void {
    this.callbacks.onModelInfo = callback;
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
