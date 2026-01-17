/**
 * Session Service - Database-backed implementation using Drizzle ORM.
 *
 * Provides CRUD operations for agent sessions with:
 * - Type-safe database queries
 * - Engine-agnostic session configuration storage
 * - JSON config and management info caching
 */
import { randomUUID } from 'node:crypto';
import { eq, desc, and, asc } from 'drizzle-orm';
import { getDb, sessions, messages, type SessionRow } from './db';
import type { EngineName } from './engines/types';

// ============================================================
// Types
// ============================================================

/**
 * System prompt configuration options.
 */
export type SystemPromptConfig =
  | { type: 'custom'; text: string }
  | { type: 'preset'; preset: 'claude_code'; append?: string };

/**
 * Tools configuration - can be a list of tool names or a preset.
 */
export type ToolsConfig = string[] | { type: 'preset'; preset: 'claude_code' };

/**
 * Session options configuration (stored as JSON).
 */
export interface SessionOptionsConfig {
  settingSources?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
  tools?: ToolsConfig;
  betas?: string[];
  maxThinkingTokens?: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  mcpServers?: Record<string, unknown>;
  outputFormat?: Record<string, unknown>;
  enableFileCheckpointing?: boolean;
  sandbox?: Record<string, unknown>;
  env?: Record<string, string>;
  /**
   * Optional Codex-specific configuration overrides.
   * Only applicable when using CodexEngine.
   */
  codexConfig?: Partial<import('chrome-mcp-shared').CodexEngineConfig>;
}

/**
 * Cached management information from Claude SDK.
 */
export interface ManagementInfo {
  models?: Array<{ value: string; displayName: string; description: string }>;
  commands?: Array<{ name: string; description: string; argumentHint: string }>;
  account?: { email?: string; organization?: string; subscriptionType?: string };
  mcpServers?: Array<{ name: string; status: string }>;
  tools?: string[];
  agents?: string[];
  /** Plugins with name and path (SDK returns { name, path }[]) */
  plugins?: Array<{ name: string; path?: string }>;
  skills?: string[];
  slashCommands?: string[];
  model?: string;
  permissionMode?: string;
  cwd?: string;
  outputStyle?: string;
  betas?: string[];
  claudeCodeVersion?: string;
  apiKeySource?: string;
  lastUpdated?: string;
}

/**
 * Structured preview metadata for session list display.
 * When present, allows rendering special styles (e.g., chip for web editor apply).
 */
export interface AgentSessionPreviewMeta {
  /** Compact display text (e.g., user's message or "Apply changes") */
  displayText?: string;
  /** Client metadata for special rendering */
  clientMeta?: {
    kind?: 'web_editor_apply_batch' | 'web_editor_apply_single';
    pageUrl?: string;
    elementCount?: number;
    elementLabels?: string[];
  };
  /** Full content for tooltip preview (truncated to avoid payload bloat) */
  fullContent?: string;
}

/**
 * Agent session representation.
 */
export interface AgentSession {
  id: string;
  projectId: string;
  engineName: string;
  engineSessionId?: string;
  name?: string;
  /** Preview text from first user message, for display in session list */
  preview?: string;
  /** Structured preview metadata for special rendering (e.g., web editor apply chip) */
  previewMeta?: AgentSessionPreviewMeta;
  model?: string;
  permissionMode: string;
  allowDangerouslySkipPermissions: boolean;
  systemPromptConfig?: SystemPromptConfig;
  optionsConfig?: SessionOptionsConfig;
  managementInfo?: ManagementInfo;
  createdAt: string;
  updatedAt: string;
}

/**
 * Options for creating a new session.
 */
export interface CreateSessionOptions {
  id?: string;
  engineSessionId?: string;
  name?: string;
  model?: string;
  permissionMode?: string;
  allowDangerouslySkipPermissions?: boolean;
  systemPromptConfig?: SystemPromptConfig;
  optionsConfig?: SessionOptionsConfig;
}

/**
 * Options for updating an existing session.
 */
export interface UpdateSessionInput {
  engineSessionId?: string | null;
  name?: string | null;
  model?: string | null;
  permissionMode?: string | null;
  allowDangerouslySkipPermissions?: boolean | null;
  systemPromptConfig?: SystemPromptConfig | null;
  optionsConfig?: SessionOptionsConfig | null;
  managementInfo?: ManagementInfo | null;
}

// ============================================================
// JSON Parsing Utilities
// ============================================================

function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function stringifyJson<T>(value: T | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return JSON.stringify(value);
}

// ============================================================
// Type Conversion
// ============================================================

function rowToSession(row: SessionRow): AgentSession {
  return {
    id: row.id,
    projectId: row.projectId,
    engineName: row.engineName,
    engineSessionId: row.engineSessionId ?? undefined,
    name: row.name ?? undefined,
    model: row.model ?? undefined,
    permissionMode: row.permissionMode,
    allowDangerouslySkipPermissions: row.allowDangerouslySkipPermissions === '1',
    systemPromptConfig: parseJson<SystemPromptConfig>(row.systemPromptConfig),
    optionsConfig: parseJson<SessionOptionsConfig>(row.optionsConfig),
    managementInfo: parseJson<ManagementInfo>(row.managementInfo),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ============================================================
// Public API
// ============================================================

/**
 * Create a new session for a project.
 */
export async function createSession(
  projectId: string,
  engineName: EngineName,
  options: CreateSessionOptions = {},
): Promise<AgentSession> {
  const db = getDb();
  const now = new Date().toISOString();

  // Resolve permission mode - AgentChat defaults to bypassPermissions for headless operation
  const resolvedPermissionMode = options.permissionMode?.trim() || 'bypassPermissions';

  // SDK requires allowDangerouslySkipPermissions=true when using bypassPermissions mode
  // If explicitly provided, use that value; otherwise infer from permission mode
  const resolvedAllowDangerouslySkipPermissions =
    typeof options.allowDangerouslySkipPermissions === 'boolean'
      ? options.allowDangerouslySkipPermissions
      : resolvedPermissionMode === 'bypassPermissions';

  const sessionData = {
    id: options.id?.trim() || randomUUID(),
    projectId,
    engineName,
    engineSessionId: options.engineSessionId?.trim() || null,
    name: options.name?.trim() || null,
    model: options.model?.trim() || null,
    permissionMode: resolvedPermissionMode,
    allowDangerouslySkipPermissions: resolvedAllowDangerouslySkipPermissions ? '1' : null,
    systemPromptConfig: stringifyJson(options.systemPromptConfig),
    optionsConfig: stringifyJson(options.optionsConfig),
    managementInfo: null,
    createdAt: now,
    updatedAt: now,
  };

  await db.insert(sessions).values(sessionData);
  return rowToSession(sessionData as SessionRow);
}

/**
 * Get a session by ID.
 */
export async function getSession(sessionId: string): Promise<AgentSession | undefined> {
  const db = getDb();
  const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  return rows.length > 0 ? rowToSession(rows[0]) : undefined;
}

/** Maximum length for preview text */
const MAX_PREVIEW_LENGTH = 50;

/**
 * Truncate text to max length with ellipsis.
 */
function truncatePreview(text: string, maxLength: number = MAX_PREVIEW_LENGTH): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= maxLength) return trimmed;
  return trimmed.slice(0, maxLength - 1) + '…';
}

/**
 * Add preview to sessions by fetching first user message for each.
 * Shared helper to avoid code duplication.
 */
async function addPreviewsToSessions(rows: SessionRow[]): Promise<AgentSession[]> {
  const db = getDb();

  return Promise.all(
    rows.map(async (row) => {
      const session = rowToSession(row);

      // Query first user message for this session (include metadata for special rendering)
      const firstUserMessages = await db
        .select({ content: messages.content, metadata: messages.metadata })
        .from(messages)
        .where(and(eq(messages.sessionId, row.id), eq(messages.role, 'user')))
        .orderBy(asc(messages.createdAt))
        .limit(1);

      if (firstUserMessages.length > 0 && firstUserMessages[0].content) {
        const content = firstUserMessages[0].content;
        const metadataJson = firstUserMessages[0].metadata;

        session.preview = truncatePreview(content);

        // Parse metadata to extract clientMeta/displayText for special rendering
        if (metadataJson) {
          try {
            const parsed = JSON.parse(metadataJson) as Record<string, unknown>;

            // Type-safe extraction with validation
            const rawClientMeta = parsed.clientMeta;
            const rawDisplayText = parsed.displayText;

            // Validate displayText is a string
            const displayText = typeof rawDisplayText === 'string' ? rawDisplayText : undefined;

            // Validate clientMeta structure
            const clientMeta =
              rawClientMeta &&
              typeof rawClientMeta === 'object' &&
              'kind' in rawClientMeta &&
              (rawClientMeta.kind === 'web_editor_apply_batch' ||
                rawClientMeta.kind === 'web_editor_apply_single')
                ? (rawClientMeta as AgentSessionPreviewMeta['clientMeta'])
                : undefined;

            // Only set previewMeta if we have valid special metadata
            if (clientMeta || displayText) {
              session.previewMeta = {
                displayText: displayText || truncatePreview(content),
                clientMeta,
                // Truncate fullContent to avoid payload bloat (200 chars max)
                fullContent: truncatePreview(content, 200),
              };
            }
          } catch {
            // Ignore JSON parse errors, just use plain preview
          }
        }
      }

      return session;
    }),
  );
}

/**
 * Get all sessions for a project, sorted by most recently updated.
 * Includes preview from first user message for each session.
 */
export async function getSessionsByProject(projectId: string): Promise<AgentSession[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.projectId, projectId))
    .orderBy(desc(sessions.updatedAt));

  return addPreviewsToSessions(rows);
}

/**
 * Get all sessions across all projects, sorted by most recently updated.
 * Includes preview from first user message for each session.
 */
export async function getAllSessions(): Promise<AgentSession[]> {
  const db = getDb();
  const rows = await db.select().from(sessions).orderBy(desc(sessions.updatedAt));

  return addPreviewsToSessions(rows);
}

/**
 * Get sessions for a project filtered by engine name.
 */
export async function getSessionsByProjectAndEngine(
  projectId: string,
  engineName: EngineName,
): Promise<AgentSession[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.projectId, projectId), eq(sessions.engineName, engineName)))
    .orderBy(desc(sessions.updatedAt));
  return rows.map(rowToSession);
}

/**
 * Update an existing session.
 */
export async function updateSession(sessionId: string, updates: UpdateSessionInput): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();

  const updateData: Record<string, unknown> = {
    updatedAt: now,
  };

  if (updates.engineSessionId !== undefined) {
    updateData.engineSessionId = updates.engineSessionId?.trim() || null;
  }

  if (updates.name !== undefined) {
    updateData.name = updates.name?.trim() || null;
  }

  if (updates.model !== undefined) {
    updateData.model = updates.model?.trim() || null;
  }

  if (updates.permissionMode !== undefined) {
    updateData.permissionMode = updates.permissionMode?.trim() || 'bypassPermissions';
  }

  if (updates.allowDangerouslySkipPermissions !== undefined) {
    updateData.allowDangerouslySkipPermissions = updates.allowDangerouslySkipPermissions
      ? '1'
      : null;
  }

  if (updates.systemPromptConfig !== undefined) {
    updateData.systemPromptConfig = stringifyJson(updates.systemPromptConfig);
  }

  if (updates.optionsConfig !== undefined) {
    updateData.optionsConfig = stringifyJson(updates.optionsConfig);
  }

  if (updates.managementInfo !== undefined) {
    updateData.managementInfo = stringifyJson(updates.managementInfo);
  }

  await db.update(sessions).set(updateData).where(eq(sessions.id, sessionId));
}

/**
 * Delete a session by ID.
 * Note: Messages associated with this session are NOT automatically deleted.
 * The caller should handle message cleanup if needed.
 */
export async function deleteSession(sessionId: string): Promise<void> {
  const db = getDb();
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

/**
 * Update the engine session ID (e.g., Claude SDK session_id).
 */
export async function updateEngineSessionId(
  sessionId: string,
  engineSessionId: string | null,
): Promise<void> {
  await updateSession(sessionId, { engineSessionId });
}

/**
 * Touch session activity - updates the updatedAt timestamp.
 * Used when a message is sent to move the session to the top of the list.
 */
export async function touchSessionActivity(sessionId: string): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  await db.update(sessions).set({ updatedAt: now }).where(eq(sessions.id, sessionId));
}

/**
 * Update the cached management information.
 */
export async function updateManagementInfo(
  sessionId: string,
  info: ManagementInfo | null,
): Promise<void> {
  // Add timestamp to management info
  const infoWithTimestamp = info ? { ...info, lastUpdated: new Date().toISOString() } : null;
  await updateSession(sessionId, { managementInfo: infoWithTimestamp });
}

/**
 * Get or create a default session for a project and engine.
 * Useful for backwards compatibility - creates a session if none exists.
 */
export async function getOrCreateDefaultSession(
  projectId: string,
  engineName: EngineName,
  options: CreateSessionOptions = {},
): Promise<AgentSession> {
  const existingSessions = await getSessionsByProjectAndEngine(projectId, engineName);

  if (existingSessions.length > 0) {
    // Return the most recently updated session
    return existingSessions[0];
  }

  // Create a new default session
  return createSession(projectId, engineName, {
    ...options,
    name: options.name || `Default ${engineName} session`,
  });
}
