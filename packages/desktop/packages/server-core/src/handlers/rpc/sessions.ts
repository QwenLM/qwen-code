import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import {
  RPC_CHANNELS,
  type FileAttachment,
  type SendMessageOptions,
  type SessionEvent,
} from '@craft-agent/shared/protocol';
import type { StoredAttachment } from '@craft-agent/core/types';
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config';
import { perf } from '@craft-agent/shared/utils';
import {
  isValidThinkingLevel,
  THINKING_LEVEL_IDS,
} from '@craft-agent/shared/agent/thinking-levels';
import {
  pushTyped,
  type RequestContext,
  type RpcServer,
} from '@craft-agent/server-core/transport';
import type { HandlerDeps } from '../handler-deps';
import { setTransferableHandler } from './transfer';

const VALID_THINKING_LEVELS_LIST = THINKING_LEVEL_IDS.map(
  (id) => `'${id}'`,
).join(', ');

const SESSION_LIST_EXTERNAL_REFRESH_WAIT_MS = 90_000;
const EXTERNAL_REFRESH_TIMED_OUT = Symbol('external-refresh-timed-out');

type SessionListRefreshLogger = Pick<HandlerDeps['platform']['logger'], 'warn'>;

export async function waitForSessionListExternalRefresh(
  refreshPromise: Promise<void> | undefined,
  {
    log,
    timeoutMs = SESSION_LIST_EXTERNAL_REFRESH_WAIT_MS,
    workspaceId,
  }: {
    log: SessionListRefreshLogger;
    timeoutMs?: number;
    workspaceId?: string;
  },
): Promise<void> {
  if (!refreshPromise) return;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const guardedRefresh = refreshPromise.catch((error) => {
    log.warn('Session list external refresh failed:', error);
  });

  try {
    const result = await Promise.race([
      guardedRefresh,
      new Promise<typeof EXTERNAL_REFRESH_TIMED_OUT>((resolve) => {
        timeout = setTimeout(
          () => resolve(EXTERNAL_REFRESH_TIMED_OUT),
          timeoutMs,
        );
      }),
    ]);

    if (result === EXTERNAL_REFRESH_TIMED_OUT) {
      log.warn(
        `Session list external refresh for workspace ${workspaceId ?? '(all)'} is still running after ${timeoutMs}ms; returning cached sessions`,
      );
    }
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

interface ClientSessionWatchState {
  watcher: import('fs').FSWatcher;
  sessionId: string;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

// Per-client session file watcher state (supports concurrent windows/clients safely)
const clientSessionWatches = new Map<string, ClientSessionWatchState>();

/**
 * Clean up session file watcher for a client.
 * Called from main process disconnect hooks to prevent watcher leaks.
 */
export function cleanupSessionFileWatchForClient(clientId: string): void {
  const state = clientSessionWatches.get(clientId);
  if (!state) return;

  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
  }

  state.watcher.close();
  clientSessionWatches.delete(clientId);
}

// Recursive directory scanner for session files
// Filters out internal files (session.jsonl) and hidden files (. prefix)
// Returns only non-empty directories
async function scanSessionDirectory(
  dirPath: string,
): Promise<Array<import('@craft-agent/shared/protocol').SessionFile>> {
  const { readdir, stat } = await import('fs/promises');
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files: Array<import('@craft-agent/shared/protocol').SessionFile> = [];

  for (const entry of entries) {
    // Skip internal and hidden files
    if (entry.name === 'session.jsonl' || entry.name.startsWith('.')) continue;

    const fullPath = join(dirPath, entry.name);

    if (entry.isDirectory()) {
      // Recursively scan subdirectory
      const children = await scanSessionDirectory(fullPath);
      // Only include non-empty directories
      if (children.length > 0) {
        files.push({
          name: entry.name,
          path: fullPath,
          type: 'directory',
          children,
        });
      }
    } else {
      const stats = await stat(fullPath);
      files.push({
        name: entry.name,
        path: fullPath,
        type: 'file',
        size: stats.size,
      });
    }
  }

  // Sort: directories first, then alphabetically
  return files.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.sessions.GET,
  RPC_CHANNELS.sessions.GET_FOR_WORKSPACE,
  RPC_CHANNELS.sessions.GET_UNREAD_SUMMARY,
  RPC_CHANNELS.sessions.MARK_ALL_READ,
  RPC_CHANNELS.sessions.CREATE,
  RPC_CHANNELS.sessions.DELETE,
  RPC_CHANNELS.sessions.GET_MESSAGES,
  RPC_CHANNELS.sessions.SEND_MESSAGE,
  RPC_CHANNELS.sessions.CANCEL,
  RPC_CHANNELS.sessions.KILL_SHELL,
  RPC_CHANNELS.tasks.GET_OUTPUT,
  RPC_CHANNELS.sessions.RESPOND_TO_PERMISSION,
  RPC_CHANNELS.sessions.RESPOND_TO_CREDENTIAL,
  RPC_CHANNELS.sessions.COMMAND,
  RPC_CHANNELS.sessions.GET_PENDING_PLAN_EXECUTION,
  RPC_CHANNELS.sessions.GET_PERMISSION_MODE_STATE,
  RPC_CHANNELS.sessions.SEARCH_CONTENT,
  RPC_CHANNELS.sessions.GET_FILES,
  RPC_CHANNELS.sessions.GET_NOTES,
  RPC_CHANNELS.sessions.SET_NOTES,
  RPC_CHANNELS.sessions.WATCH_FILES,
  RPC_CHANNELS.sessions.UNWATCH_FILES,
  RPC_CHANNELS.sessions.EXPORT,
  RPC_CHANNELS.sessions.IMPORT,
  RPC_CHANNELS.sessions.EXPORT_REMOTE_TRANSFER,
  RPC_CHANNELS.sessions.IMPORT_REMOTE_TRANSFER,
] as const;

export function registerSessionsHandlers(
  server: RpcServer,
  deps: HandlerDeps,
): void {
  const { sessionManager, platform } = deps;
  const log = platform.logger;

  // Get all sessions for the calling window's workspace
  // Waits for initialization to complete so sessions are never returned empty during startup
  server.handle(RPC_CHANNELS.sessions.GET, async (ctx) => {
    try {
      await sessionManager.waitForInit();
    } catch (error) {
      log.error('GET_SESSIONS continuing after initialization failure:', error);
    }
    const end = perf.start('rpc.getSessions');
    const workspaceId =
      ctx.workspaceId ??
      deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!);
    await waitForSessionListExternalRefresh(
      sessionManager.refreshExternalSessions?.(workspaceId ?? undefined),
      { log, workspaceId: workspaceId ?? undefined },
    );
    const sessions = sessionManager.getSessions(workspaceId ?? undefined);
    end();
    return sessions;
  });

  // Get lightweight session metadata for a specific local workspace.
  // Used by the project sidebar to show sessions across workspaces without
  // switching the current window context.
  server.handle(
    RPC_CHANNELS.sessions.GET_FOR_WORKSPACE,
    async (
      _ctx,
      workspaceId: string,
      options?: { refreshExternal?: boolean },
    ) => {
      try {
        await sessionManager.waitForInit();
      } catch (error) {
        log.error(
          'GET_SESSIONS_FOR_WORKSPACE continuing after initialization failure:',
          error,
        );
      }
      const end = perf.start('rpc.getSessionsForWorkspace', { workspaceId });
      if (options?.refreshExternal !== false) {
        await waitForSessionListExternalRefresh(
          sessionManager.refreshExternalSessions?.(workspaceId),
          { log, workspaceId },
        );
      }
      const sessions = sessionManager.getSessions(workspaceId);
      end();
      return sessions;
    },
  );

  // Get unread summary across all workspaces
  server.handle(RPC_CHANNELS.sessions.GET_UNREAD_SUMMARY, async () => {
    try {
      await sessionManager.waitForInit();
    } catch (error) {
      log.error(
        'GET_UNREAD_SUMMARY continuing after initialization failure:',
        error,
      );
    }
    return sessionManager.getUnreadSummary();
  });

  server.handle(
    RPC_CHANNELS.sessions.MARK_ALL_READ,
    async (_ctx, workspaceId: string) =>
      sessionManager.markAllSessionsRead(workspaceId),
  );

  // Get a single session with messages (for lazy loading)
  server.handle(
    RPC_CHANNELS.sessions.GET_MESSAGES,
    async (_ctx, sessionId: string) => {
      const end = perf.start('rpc.getSessionMessages');
      const session = await sessionManager.getSession(sessionId);
      end();
      return session;
    },
  );

  // Create a new session
  server.handle(
    RPC_CHANNELS.sessions.CREATE,
    async (
      _ctx,
      workspaceId: string,
      options?: import('@craft-agent/shared/protocol').CreateSessionOptions,
    ) => {
      const end = perf.start('rpc.createSession', { workspaceId });
      const session = await sessionManager.createSession(workspaceId, options);
      end();
      return session;
    },
  );

  // Delete a session
  server.handle(RPC_CHANNELS.sessions.DELETE, async (_ctx, sessionId: string) =>
    sessionManager.deleteSession(sessionId),
  );

  // Send a message to a session (with optional file attachments)
  // Note: We intentionally don't await here - the response is streamed via events.
  // The IPC handler returns immediately, and results come through SESSION_EVENT channel.
  // attachments: FileAttachment[] for backend input, storedAttachments: StoredAttachment[] for persistence (has thumbnailBase64)
  server.handle(
    RPC_CHANNELS.sessions.SEND_MESSAGE,
    async (
      ctx,
      sessionId: string,
      message: string,
      attachments?: FileAttachment[],
      storedAttachments?: StoredAttachment[],
      options?: SendMessageOptions,
    ) => {
      // Capture the caller's clientId for error routing
      const callerClientId = ctx.clientId;
      const callerWorkspaceId = ctx.workspaceId ?? undefined;

      // Start processing in background, errors are sent via event stream
      sessionManager
        .sendMessage(
          sessionId,
          message,
          attachments,
          storedAttachments,
          options,
          undefined,
          callerClientId,
        )
        .catch((err) => {
          log.error('Error in sendMessage:', err);
          // Send error to the calling client
          pushTyped(
            server,
            RPC_CHANNELS.sessions.EVENT,
            { to: 'client', clientId: callerClientId },
            {
              type: 'error',
              sessionId,
              error: err instanceof Error ? err.message : 'Unknown error',
              workspaceId: callerWorkspaceId,
            } as SessionEvent,
          );
          // Also send complete event to clear processing state
          pushTyped(
            server,
            RPC_CHANNELS.sessions.EVENT,
            { to: 'client', clientId: callerClientId },
            {
              type: 'complete',
              sessionId,
              workspaceId: callerWorkspaceId,
            } as SessionEvent,
          );
        });
      // Return immediately - streaming results come via SESSION_EVENT
      return { started: true };
    },
  );

  // Cancel processing
  server.handle(
    RPC_CHANNELS.sessions.CANCEL,
    async (_ctx, sessionId: string, silent?: boolean) =>
      sessionManager.cancelProcessing(sessionId, silent),
  );

  // Kill background shell
  server.handle(
    RPC_CHANNELS.sessions.KILL_SHELL,
    async (_ctx, sessionId: string, shellId: string) =>
      sessionManager.killShell(sessionId, shellId),
  );

  // Get background task output
  server.handle(RPC_CHANNELS.tasks.GET_OUTPUT, async (_ctx, taskId: string) => {
    try {
      const output = await sessionManager.getTaskOutput(taskId);
      return output;
    } catch (err) {
      log.error('Failed to get task output:', err);
      throw err;
    }
  });

  // Respond to a permission request (bash command approval)
  // Returns true if the response was delivered, false if agent/session is gone
  server.handle(
    RPC_CHANNELS.sessions.RESPOND_TO_PERMISSION,
    async (
      _ctx,
      sessionId: string,
      requestId: string,
      allowed: boolean,
      alwaysAllow: boolean,
      options?: import('@craft-agent/shared/protocol').PermissionResponseOptions,
    ) =>
      sessionManager.respondToPermission(
        sessionId,
        requestId,
        allowed,
        alwaysAllow,
        options,
      ),
  );

  // Respond to a credential request (secure auth input)
  // Returns true if the response was delivered, false if agent/session is gone
  server.handle(
    RPC_CHANNELS.sessions.RESPOND_TO_CREDENTIAL,
    async (
      _ctx,
      sessionId: string,
      requestId: string,
      response: import('@craft-agent/shared/protocol').CredentialResponse,
    ) => sessionManager.respondToCredential(sessionId, requestId, response),
  );

  // ==========================================================================
  // Consolidated Command Handlers
  // ==========================================================================

  // Session commands - consolidated handler for session operations
  server.handle(
    RPC_CHANNELS.sessions.COMMAND,
    async (
      _ctx,
      sessionId: string,
      command: import('@craft-agent/shared/protocol').SessionCommand,
    ) => {
      switch (command.type) {
        case 'flag':
          return sessionManager.flagSession(sessionId);
        case 'unflag':
          return sessionManager.unflagSession(sessionId);
        case 'archive':
          return sessionManager.archiveSession(sessionId);
        case 'unarchive':
          return sessionManager.unarchiveSession(sessionId);
        case 'rename':
          return sessionManager.renameSession(sessionId, command.name);
        case 'setSessionStatus':
          return sessionManager.setSessionStatus(sessionId, command.state);
        case 'markRead':
          return sessionManager.markSessionRead(sessionId);
        case 'markUnread':
          return sessionManager.markSessionUnread(sessionId);
        case 'setActiveViewing':
          // Track which session user is actively viewing (for unread state machine)
          return sessionManager.setActiveViewingSession(
            sessionId,
            command.workspaceId,
          );
        case 'setPermissionMode':
          return sessionManager.setSessionPermissionMode(
            sessionId,
            command.mode,
          );
        case 'setThinkingLevel':
          // Validate thinking level before passing to session manager
          if (!isValidThinkingLevel(command.level)) {
            throw new Error(
              `Invalid thinking level: ${command.level}. Valid values: ${VALID_THINKING_LEVELS_LIST}`,
            );
          }
          return sessionManager.setSessionThinkingLevel(
            sessionId,
            command.level,
          );
        case 'updateWorkingDirectory':
          return sessionManager.updateWorkingDirectory(sessionId, command.dir);
        case 'setSources':
          return sessionManager.setSessionSources(
            sessionId,
            command.sourceSlugs,
          );
        case 'setLabels':
          return sessionManager.setSessionLabels(sessionId, command.labels);
        case 'showInFinder': {
          const sessionPath = sessionManager.getSessionPath(sessionId);
          if (sessionPath) {
            deps.platform.showItemInFolder?.(sessionPath);
          }
          return;
        }
        case 'copyPath': {
          // Return the session folder path for copying to clipboard
          const sessionPath = sessionManager.getSessionPath(sessionId);
          return sessionPath
            ? { success: true, path: sessionPath }
            : { success: false };
        }
        case 'shareToViewer':
          return sessionManager.shareToViewer(sessionId);
        case 'updateShare':
          return sessionManager.updateShare(sessionId);
        case 'revokeShare':
          return sessionManager.revokeShare(sessionId);
        case 'refreshTitle':
          log.info(`IPC: refreshTitle received for session ${sessionId}`);
          return sessionManager.refreshTitle(sessionId);
        case 'getQwenPermissionSettings':
          log.info(
            `IPC: getQwenPermissionSettings received for session ${sessionId}`,
          );
          return sessionManager.getSessionPermissionSettings(sessionId);
        case 'setQwenPermissionRules':
          log.info(
            `IPC: setQwenPermissionRules received for session ${sessionId}`,
          );
          return sessionManager.setSessionPermissionRules(
            sessionId,
            command.scope,
            command.ruleType,
            command.rules,
          );
        case 'getQwenCoreSettings':
          return sessionManager.getSessionQwenCoreSettings(sessionId);
        case 'setQwenCoreSetting':
          return sessionManager.setSessionQwenCoreSetting(
            sessionId,
            command.scope,
            command.key,
            command.value,
          );
        case 'setQwenMcpServer':
          return sessionManager.setSessionQwenMcpServer(
            sessionId,
            command.scope,
            command.name,
            command.server,
          );
        case 'removeQwenMcpServer':
          return sessionManager.removeSessionQwenMcpServer(
            sessionId,
            command.scope,
            command.name,
          );
        case 'setQwenHook':
          return sessionManager.setSessionQwenHook(
            sessionId,
            command.scope,
            command.event,
            command.index,
            command.hook,
          );
        case 'removeQwenHook':
          return sessionManager.removeSessionQwenHook(
            sessionId,
            command.scope,
            command.event,
            command.index,
          );
        case 'setQwenExtensionSetting':
          return sessionManager.setSessionQwenExtensionSetting(
            sessionId,
            command.extensionId,
            command.settingKey,
            command.scope,
            command.value,
          );
        case 'refreshAvailableCommands':
          log.info(
            `IPC: refreshAvailableCommands received for session ${sessionId}`,
          );
          return sessionManager.refreshAvailableCommands(sessionId, command);
        // Connection selection (locked after first message)
        case 'setConnection':
          log.info(
            `IPC: setConnection received for session ${sessionId}, connection: ${command.connectionSlug}`,
          );
          return sessionManager.setSessionConnection(
            sessionId,
            command.connectionSlug,
          );
        // Pending plan execution (Accept & Compact flow)
        case 'setPendingPlanExecution':
          return sessionManager.setPendingPlanExecution(
            sessionId,
            command.planPath,
            command.draftInputSnapshot,
          );
        case 'markCompactionComplete':
          return sessionManager.markCompactionComplete(sessionId);
        case 'markPendingPlanExecutionDispatched':
          return sessionManager.markPendingPlanExecutionDispatched(sessionId);
        case 'clearPendingPlanExecution':
          return sessionManager.clearPendingPlanExecution(sessionId);
        case 'updateMessageContent':
          return sessionManager.updateMessageContent(
            sessionId,
            command.messageId,
            command.content,
          );
        case 'addAnnotation':
          return sessionManager.addMessageAnnotation(
            sessionId,
            command.messageId,
            command.annotation,
          );
        case 'removeAnnotation':
          return sessionManager.removeMessageAnnotation(
            sessionId,
            command.messageId,
            command.annotationId,
          );
        case 'updateAnnotation':
          return sessionManager.updateMessageAnnotation(
            sessionId,
            command.messageId,
            command.annotationId,
            command.patch,
          );
        default: {
          const _exhaustive: never = command;
          throw new Error(
            `Unknown session command: ${JSON.stringify(command)}`,
          );
        }
      }
    },
  );

  // Get pending plan execution state (for reload recovery)
  server.handle(
    RPC_CHANNELS.sessions.GET_PENDING_PLAN_EXECUTION,
    async (_ctx, sessionId: string) =>
      sessionManager.getPendingPlanExecution(sessionId),
  );

  // Get authoritative permission mode diagnostics for renderer reconciliation
  server.handle(
    RPC_CHANNELS.sessions.GET_PERMISSION_MODE_STATE,
    async (_ctx, sessionId: string) =>
      sessionManager.getSessionPermissionModeState(sessionId),
  );

  // ============================================================
  // Session Content Search
  // ============================================================

  // Search session content using ripgrep
  server.handle(
    RPC_CHANNELS.sessions.SEARCH_CONTENT,
    async (_ctx, workspaceId: string, query: string, searchId?: string) => {
      const id = searchId || Date.now().toString(36);
      log.info('[search]', 'ipc:request', { searchId: id, query });

      const workspace = getWorkspaceByNameOrId(workspaceId);
      if (!workspace) {
        log.warn('SEARCH_SESSIONS: Workspace not found:', workspaceId);
        return [];
      }

      const { searchSessions } = await import(
        '@craft-agent/server-core/services'
      );
      const { getWorkspaceSessionsPath } = await import(
        '@craft-agent/shared/workspaces'
      );

      const sessionsDir = getWorkspaceSessionsPath(workspace.rootPath);
      log.debug(`SEARCH_SESSIONS: Searching "${query}" in ${sessionsDir}`);

      const results = await searchSessions(query, sessionsDir, {
        timeout: 5000,
        maxMatchesPerSession: 3,
        maxSessions: 50,
        searchId: id,
      });

      // Filter out hidden sessions (e.g., mini edit sessions)
      const allSessions = await sessionManager.getSessions();
      const hiddenSessionIds = new Set(
        allSessions.filter((s) => s.hidden).map((s) => s.id),
      );
      const filteredResults = results.filter(
        (r) => !hiddenSessionIds.has(r.sessionId),
      );

      log.info('[search]', 'ipc:response', {
        searchId: id,
        resultCount: filteredResults.length,
        totalFound: results.length,
      });
      return filteredResults;
    },
  );

  // ============================================================
  // Session Info Panel (files, notes, file watching)
  // ============================================================

  // Get files in session directory (recursive tree structure)
  server.handle(
    RPC_CHANNELS.sessions.GET_FILES,
    async (_ctx, sessionId: string) => {
      const sessionPath = sessionManager.getSessionPath(sessionId);
      if (!sessionPath) return [];

      try {
        return await scanSessionDirectory(sessionPath);
      } catch (error) {
        log.error('Failed to get session files:', error);
        return [];
      }
    },
  );

  // Start watching a session directory for file changes (per client)
  server.handle(
    RPC_CHANNELS.sessions.WATCH_FILES,
    async (ctx, sessionId: string) => {
      const clientId = ctx.clientId;
      cleanupSessionFileWatchForClient(clientId);

      const sessionPath = sessionManager.getSessionPath(sessionId);
      if (!sessionPath) return;

      try {
        const { watch } = await import('fs');

        const state: ClientSessionWatchState = {
          watcher: null as unknown as import('fs').FSWatcher,
          sessionId,
          debounceTimer: null,
        };

        state.watcher = watch(
          sessionPath,
          { recursive: true },
          (_eventType, filename) => {
            // Ignore internal files and hidden files
            if (
              filename &&
              (filename.includes('session.jsonl') || filename.startsWith('.'))
            ) {
              return;
            }

            // Debounce: wait 100ms before notifying to batch rapid changes
            if (state.debounceTimer) {
              clearTimeout(state.debounceTimer);
            }

            state.debounceTimer = setTimeout(() => {
              pushTyped(
                server,
                RPC_CHANNELS.sessions.FILES_CHANGED,
                { to: 'client', clientId },
                state.sessionId,
              );
            }, 100);
          },
        );

        clientSessionWatches.set(clientId, state);
      } catch (error) {
        log.error('Failed to start session file watcher:', error);
      }
    },
  );

  // Stop watching session files for the calling client
  server.handle(RPC_CHANNELS.sessions.UNWATCH_FILES, async (ctx) => {
    cleanupSessionFileWatchForClient(ctx.clientId);
  });

  // Get session notes (reads notes.md from session directory)
  server.handle(
    RPC_CHANNELS.sessions.GET_NOTES,
    async (_ctx, sessionId: string) => {
      const sessionPath = sessionManager.getSessionPath(sessionId);
      if (!sessionPath) return '';

      try {
        const notesPath = join(sessionPath, 'notes.md');
        const content = await readFile(notesPath, 'utf-8');
        return content;
      } catch {
        // File doesn't exist yet - return empty string
        return '';
      }
    },
  );

  // Set session notes (writes to notes.md in session directory)
  server.handle(
    RPC_CHANNELS.sessions.SET_NOTES,
    async (_ctx, sessionId: string, content: string) => {
      const sessionPath = sessionManager.getSessionPath(sessionId);
      if (!sessionPath) {
        throw new Error(`Session not found: ${sessionId}`);
      }

      try {
        const notesPath = join(sessionPath, 'notes.md');
        await writeFile(notesPath, content, 'utf-8');
      } catch (error) {
        log.error('Failed to save session notes:', error);
        throw error;
      }
    },
  );

  // ============================================
  // Export / Import / Dispatch
  // ============================================

  // Export a session as a portable bundle
  server.handle(
    RPC_CHANNELS.sessions.EXPORT,
    async (ctx, sessionId: string) => {
      await sessionManager.waitForInit();
      const workspaceId =
        ctx.workspaceId ??
        deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!);
      if (!workspaceId) throw new Error('No workspace context');

      const bundle = await sessionManager.exportSession(sessionId, workspaceId);
      if (!bundle) throw new Error(`Failed to export session ${sessionId}`);
      return bundle;
    },
  );

  // Import a session bundle into a target workspace
  // targetWorkspaceId is passed explicitly (not from context) so the renderer
  // can import into any workspace the server manages, not just the active one.
  const importHandler = async (
    _ctx: RequestContext,
    targetWorkspaceId: string,
    bundle: unknown,
    mode: string,
  ) => {
    await sessionManager.waitForInit();
    if (!targetWorkspaceId || typeof targetWorkspaceId !== 'string')
      throw new Error('targetWorkspaceId is required');
    if (mode !== 'move' && mode !== 'fork')
      throw new Error(`Invalid dispatch mode: ${mode}`);

    return sessionManager.importSession(
      targetWorkspaceId,
      bundle as import('@craft-agent/shared/sessions').SessionBundle,
      mode,
    );
  };
  server.handle(RPC_CHANNELS.sessions.IMPORT, importHandler);
  // Also register as transferable so chunked transfer can invoke it on commit
  setTransferableHandler(RPC_CHANNELS.sessions.IMPORT, importHandler);

  // Export a session as a summarized remote-transfer payload.
  server.handle(
    RPC_CHANNELS.sessions.EXPORT_REMOTE_TRANSFER,
    async (ctx, sessionId: string) => {
      await sessionManager.waitForInit();
      const workspaceId =
        ctx.workspaceId ??
        deps.windowManager?.getWorkspaceForWindow(ctx.webContentsId!);
      if (!workspaceId) throw new Error('No workspace context');

      const payload = await sessionManager.exportRemoteSessionTransfer(
        sessionId,
        workspaceId,
      );
      if (!payload)
        throw new Error(
          `Failed to export remote transfer for session ${sessionId}`,
        );
      return payload;
    },
  );

  // Import a summarized remote-transfer payload into a target workspace.
  server.handle(
    RPC_CHANNELS.sessions.IMPORT_REMOTE_TRANSFER,
    async (
      _ctx,
      targetWorkspaceId: string,
      payload: import('@craft-agent/shared/protocol').RemoteSessionTransferPayload,
    ) => {
      await sessionManager.waitForInit();
      if (!targetWorkspaceId || typeof targetWorkspaceId !== 'string')
        throw new Error('targetWorkspaceId is required');
      return sessionManager.importRemoteSessionTransfer(
        targetWorkspaceId,
        payload,
      );
    },
  );
}
