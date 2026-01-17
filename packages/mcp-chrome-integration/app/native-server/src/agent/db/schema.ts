/**
 * Drizzle ORM Schema for Agent Storage.
 *
 * Design principles:
 * - Type-safe database access
 * - Consistent with shared types (AgentProject, AgentStoredMessage)
 * - Proper indexes for common query patterns
 * - Foreign key constraints with cascade delete
 */
import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core';

// ============================================================
// Projects Table
// ============================================================

export const projects = sqliteTable(
  'projects',
  {
    id: text().primaryKey(),
    name: text().notNull(),
    description: text(),
    rootPath: text('root_path').notNull(),
    preferredCli: text('preferred_cli'),
    selectedModel: text('selected_model'),
    /**
     * Active Claude session ID (UUID format) for session resumption.
     * Captured from SDK's system/init message.
     */
    activeClaudeSessionId: text('active_claude_session_id'),
    /**
     * Whether to use Claude Code Router (CCR) for this project.
     * Stored as '1' (true) or '0'/null (false).
     */
    useCcr: text('use_ccr'),
    /**
     * Whether to enable the local Chrome MCP server integration for this project.
     * Stored as '1' (true) or '0' (false). Default: '1' (enabled).
     */
    enableChromeMcp: text('enable_chrome_mcp').notNull().default('1'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    lastActiveAt: text('last_active_at'),
  },
  (table) => ({
    lastActiveIdx: index('projects_last_active_idx').on(table.lastActiveAt),
  }),
);

// ============================================================
// Sessions Table
// ============================================================

export const sessions = sqliteTable(
  'sessions',
  {
    id: text().primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /**
     * Engine name: claude, codex, cursor, qwen, glm, etc.
     */
    engineName: text('engine_name').notNull(),
    /**
     * Engine-specific session ID for resumption.
     * For Claude: SDK's session_id from system:init message.
     */
    engineSessionId: text('engine_session_id'),
    /**
     * User-defined session name for display.
     */
    name: text(),
    /**
     * Model override for this session.
     */
    model: text(),
    /**
     * Permission mode: default, acceptEdits, bypassPermissions, plan, dontAsk.
     */
    permissionMode: text('permission_mode').notNull().default('bypassPermissions'),
    /**
     * Whether to allow bypassing interactive permission prompts.
     * Stored as '1' (true) or null (false).
     */
    allowDangerouslySkipPermissions: text('allow_dangerously_skip_permissions'),
    /**
     * JSON: System prompt configuration.
     * Format: { type: 'custom', text: string } | { type: 'preset', preset: 'claude_code', append?: string }
     */
    systemPromptConfig: text('system_prompt_config'),
    /**
     * JSON: Engine/session option overrides (settingSources, tools, betas, etc.).
     */
    optionsConfig: text('options_config'),
    /**
     * JSON: Cached management info (supported models, commands, account, MCP servers, etc.).
     */
    managementInfo: text('management_info'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => ({
    projectIdIdx: index('sessions_project_id_idx').on(table.projectId),
    engineNameIdx: index('sessions_engine_name_idx').on(table.engineName),
  }),
);

// ============================================================
// Messages Table
// ============================================================

export const messages = sqliteTable(
  'messages',
  {
    id: text().primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').notNull(),
    conversationId: text('conversation_id'),
    role: text().notNull(), // 'user' | 'assistant' | 'tool' | 'system'
    content: text().notNull(),
    messageType: text('message_type').notNull(), // 'chat' | 'tool_use' | 'tool_result' | 'status'
    metadata: text(), // JSON string
    cliSource: text('cli_source'),
    requestId: text('request_id'),
    createdAt: text('created_at').notNull(),
  },
  (table) => ({
    projectIdIdx: index('messages_project_id_idx').on(table.projectId),
    sessionIdIdx: index('messages_session_id_idx').on(table.sessionId),
    createdAtIdx: index('messages_created_at_idx').on(table.createdAt),
    requestIdIdx: index('messages_request_id_idx').on(table.requestId),
  }),
);

// ============================================================
// Type Inference Helpers
// ============================================================

export type ProjectRow = typeof projects.$inferSelect;
export type ProjectInsert = typeof projects.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type SessionInsert = typeof sessions.$inferInsert;
export type MessageRow = typeof messages.$inferSelect;
export type MessageInsert = typeof messages.$inferInsert;
