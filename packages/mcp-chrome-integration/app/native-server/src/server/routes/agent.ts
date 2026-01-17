/**
 * Agent Routes - All agent-related HTTP endpoints.
 *
 * Handles:
 * - Projects CRUD
 * - Chat messages CRUD
 * - Chat streaming (SSE)
 * - Chat actions (act, cancel)
 * - Engine listing
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { HTTP_STATUS, ERROR_MESSAGES } from '../../constant';
import { AgentStreamManager } from '../../agent/stream-manager';
import { AgentChatService } from '../../agent/chat-service';
import type { AgentActRequest, AgentActResponse, RealtimeEvent } from '../../agent/types';
import type { CreateOrUpdateProjectInput } from '../../agent/project-types';
import {
  createProjectDirectory,
  deleteProject,
  listProjects,
  upsertProject,
  validateRootPath,
} from '../../agent/project-service';
import {
  createMessage as createStoredMessage,
  deleteMessagesByProjectId,
  deleteMessagesBySessionId,
  getMessagesByProjectId,
  getMessagesCountByProjectId,
  getMessagesBySessionId,
  getMessagesCountBySessionId,
} from '../../agent/message-service';
import {
  createSession,
  deleteSession,
  getSession,
  getSessionsByProject,
  getSessionsByProjectAndEngine,
  getAllSessions,
  updateSession,
  type CreateSessionOptions,
  type UpdateSessionInput,
} from '../../agent/session-service';
import { getProject } from '../../agent/project-service';
import { getDefaultWorkspaceDir, getDefaultProjectRoot } from '../../agent/storage';
import { openDirectoryPicker } from '../../agent/directory-picker';
import type { EngineName } from '../../agent/engines/types';
import { attachmentService } from '../../agent/attachment-service';
import { openProjectDirectory, openFileInVSCode } from '../../agent/open-project';
import type {
  AttachmentStatsResponse,
  AttachmentCleanupRequest,
  AttachmentCleanupResponse,
  OpenProjectRequest,
  OpenProjectTarget,
} from 'chrome-mcp-shared';

// Valid engine names for validation
const VALID_ENGINE_NAMES: readonly EngineName[] = ['claude', 'codex', 'cursor', 'qwen', 'glm'];

function isValidEngineName(name: string): name is EngineName {
  return VALID_ENGINE_NAMES.includes(name as EngineName);
}

// Valid open project targets
const VALID_OPEN_TARGETS: readonly OpenProjectTarget[] = ['vscode', 'terminal'];

function isValidOpenTarget(target: string): target is OpenProjectTarget {
  return VALID_OPEN_TARGETS.includes(target as OpenProjectTarget);
}

// ============================================================
// Types
// ============================================================

export interface AgentRoutesOptions {
  streamManager: AgentStreamManager;
  chatService: AgentChatService;
}

// ============================================================
// Route Registration
// ============================================================

/**
 * Register all agent-related routes on the Fastify instance.
 */
export function registerAgentRoutes(fastify: FastifyInstance, options: AgentRoutesOptions): void {
  const { streamManager, chatService } = options;

  // ============================================================
  // Engine Routes
  // ============================================================

  fastify.get('/agent/engines', async (_request, reply) => {
    try {
      const engines = chatService.getEngineInfos();
      reply.status(HTTP_STATUS.OK).send({ engines });
    } catch (error) {
      fastify.log.error({ err: error }, 'Failed to list agent engines');
      if (!reply.sent) {
        reply
          .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
          .send({ error: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
      }
    }
  });

  // ============================================================
  // Project Routes
  // ============================================================

  fastify.get('/agent/projects', async (_request, reply) => {
    try {
      const projects = await listProjects();
      reply.status(HTTP_STATUS.OK).send({ projects });
    } catch (error) {
      if (!reply.sent) {
        reply
          .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
          .send({ error: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
      }
    }
  });

  fastify.post(
    '/agent/projects',
    async (request: FastifyRequest<{ Body: CreateOrUpdateProjectInput }>, reply: FastifyReply) => {
      try {
        const body = request.body;
        if (!body || !body.name || !body.rootPath) {
          reply
            .status(HTTP_STATUS.BAD_REQUEST)
            .send({ error: 'name and rootPath are required to create a project' });
          return;
        }
        const project = await upsertProject(body);
        reply.status(HTTP_STATUS.OK).send({ project });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reply
          .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
          .send({ error: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
      }
    },
  );

  fastify.delete(
    '/agent/projects/:id',
    async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const { id } = request.params;
      if (!id) {
        reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'project id is required' });
        return;
      }
      try {
        await deleteProject(id);
        reply.status(HTTP_STATUS.NO_CONTENT).send();
      } catch (error) {
        if (!reply.sent) {
          reply
            .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .send({ error: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
        }
      }
    },
  );

  // Path validation API
  fastify.post(
    '/agent/projects/validate-path',
    async (request: FastifyRequest<{ Body: { rootPath: string } }>, reply: FastifyReply) => {
      const { rootPath } = request.body || {};
      if (!rootPath || typeof rootPath !== 'string') {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'rootPath is required' });
      }
      try {
        const result = await validateRootPath(rootPath);
        return reply.send(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({ error: message });
      }
    },
  );

  // Create directory API
  fastify.post(
    '/agent/projects/create-directory',
    async (request: FastifyRequest<{ Body: { absolutePath: string } }>, reply: FastifyReply) => {
      const { absolutePath } = request.body || {};
      if (!absolutePath || typeof absolutePath !== 'string') {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'absolutePath is required' });
      }
      try {
        await createProjectDirectory(absolutePath);
        return reply.send({ success: true, path: absolutePath });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: message });
      }
    },
  );

  // Get default workspace directory
  fastify.get('/agent/projects/default-workspace', async (_request, reply) => {
    try {
      const workspaceDir = getDefaultWorkspaceDir();
      return reply.send({ success: true, path: workspaceDir });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({ error: message });
    }
  });

  // Get default project root for a given project name
  fastify.post(
    '/agent/projects/default-root',
    async (request: FastifyRequest<{ Body: { projectName: string } }>, reply: FastifyReply) => {
      const { projectName } = request.body || {};
      if (!projectName || typeof projectName !== 'string') {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'projectName is required' });
      }
      try {
        const rootPath = getDefaultProjectRoot(projectName);
        return reply.send({ success: true, path: rootPath });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({ error: message });
      }
    },
  );

  // Open directory picker dialog
  fastify.post('/agent/projects/pick-directory', async (_request, reply) => {
    try {
      const result = await openDirectoryPicker('Select Project Directory');
      if (result.success && result.path) {
        return reply.send({ success: true, path: result.path });
      } else if (result.cancelled) {
        return reply.send({ success: false, cancelled: true });
      } else {
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          success: false,
          error: result.error || 'Failed to open directory picker',
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({ error: message });
    }
  });

  // ============================================================
  // Session Routes
  // ============================================================

  // List all sessions across all projects
  fastify.get('/agent/sessions', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const sessions = await getAllSessions();
      return reply.status(HTTP_STATUS.OK).send({ sessions });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fastify.log.error({ err: error }, 'Failed to list all sessions');
      return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
        error: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
      });
    }
  });

  // List sessions for a project
  fastify.get(
    '/agent/projects/:projectId/sessions',
    async (request: FastifyRequest<{ Params: { projectId: string } }>, reply: FastifyReply) => {
      const { projectId } = request.params;
      if (!projectId) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'projectId is required' });
      }

      try {
        const sessions = await getSessionsByProject(projectId);
        return reply.status(HTTP_STATUS.OK).send({ sessions });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ err: error }, 'Failed to list sessions');
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          error: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        });
      }
    },
  );

  // Create a new session for a project
  fastify.post(
    '/agent/projects/:projectId/sessions',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Body: CreateSessionOptions & { engineName: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { projectId } = request.params;
      const body = request.body || {};

      if (!projectId) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'projectId is required' });
      }
      if (!body.engineName) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'engineName is required' });
      }
      if (!isValidEngineName(body.engineName)) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({
          error: `Invalid engineName. Must be one of: ${VALID_ENGINE_NAMES.join(', ')}`,
        });
      }

      try {
        // Verify project exists
        const project = await getProject(projectId);
        if (!project) {
          return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Project not found' });
        }

        const session = await createSession(projectId, body.engineName, {
          name: body.name,
          model: body.model,
          permissionMode: body.permissionMode,
          allowDangerouslySkipPermissions: body.allowDangerouslySkipPermissions,
          systemPromptConfig: body.systemPromptConfig,
          optionsConfig: body.optionsConfig,
        });
        return reply.status(HTTP_STATUS.CREATED).send({ session });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ err: error }, 'Failed to create session');
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          error: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        });
      }
    },
  );

  // Get a specific session
  fastify.get(
    '/agent/sessions/:sessionId',
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) => {
      const { sessionId } = request.params;
      if (!sessionId) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'sessionId is required' });
      }

      try {
        const session = await getSession(sessionId);
        if (!session) {
          return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Session not found' });
        }
        return reply.status(HTTP_STATUS.OK).send({ session });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ err: error }, 'Failed to get session');
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          error: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        });
      }
    },
  );

  // Update a session
  fastify.patch(
    '/agent/sessions/:sessionId',
    async (
      request: FastifyRequest<{
        Params: { sessionId: string };
        Body: UpdateSessionInput;
      }>,
      reply: FastifyReply,
    ) => {
      const { sessionId } = request.params;
      const updates = request.body || {};

      if (!sessionId) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'sessionId is required' });
      }

      try {
        const existing = await getSession(sessionId);
        if (!existing) {
          return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Session not found' });
        }

        await updateSession(sessionId, updates);
        const updated = await getSession(sessionId);
        return reply.status(HTTP_STATUS.OK).send({ session: updated });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ err: error }, 'Failed to update session');
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          error: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        });
      }
    },
  );

  // Delete a session
  fastify.delete(
    '/agent/sessions/:sessionId',
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) => {
      const { sessionId } = request.params;
      if (!sessionId) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'sessionId is required' });
      }

      try {
        await deleteSession(sessionId);
        return reply.status(HTTP_STATUS.NO_CONTENT).send();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ err: error }, 'Failed to delete session');
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          error: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        });
      }
    },
  );

  // Get message history for a session
  fastify.get(
    '/agent/sessions/:sessionId/history',
    async (
      request: FastifyRequest<{
        Params: { sessionId: string };
        Querystring: { limit?: string; offset?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { sessionId } = request.params;
      if (!sessionId) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'sessionId is required' });
      }

      const limitRaw = request.query.limit;
      const offsetRaw = request.query.offset;
      const limit = Number.parseInt(limitRaw || '', 10);
      const offset = Number.parseInt(offsetRaw || '', 10);
      const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 0;
      const safeOffset = Number.isFinite(offset) && offset >= 0 ? offset : 0;

      try {
        const session = await getSession(sessionId);
        if (!session) {
          return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Session not found' });
        }

        const [messages, totalCount] = await Promise.all([
          getMessagesBySessionId(sessionId, safeLimit, safeOffset),
          getMessagesCountBySessionId(sessionId),
        ]);

        return reply.status(HTTP_STATUS.OK).send({
          success: true,
          sessionId,
          messages,
          totalCount,
          pagination: {
            limit: safeLimit,
            offset: safeOffset,
            count: messages.length,
            hasMore: safeLimit > 0 ? safeOffset + messages.length < totalCount : false,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ err: error }, 'Failed to get session history');
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          error: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        });
      }
    },
  );

  // Reset a session conversation (clear messages + engineSessionId)
  fastify.post(
    '/agent/sessions/:sessionId/reset',
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) => {
      const { sessionId } = request.params;
      if (!sessionId) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'sessionId is required' });
      }

      try {
        const existing = await getSession(sessionId);
        if (!existing) {
          return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Session not found' });
        }

        // Clear resume state first, then delete messages
        await updateSession(sessionId, { engineSessionId: null });
        const deletedMessages = await deleteMessagesBySessionId(sessionId);
        const updated = await getSession(sessionId);

        return reply.status(HTTP_STATUS.OK).send({
          success: true,
          sessionId,
          deletedMessages,
          clearedEngineSessionId: Boolean(existing.engineSessionId),
          session: updated || null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ err: error }, 'Failed to reset session');
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          error: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        });
      }
    },
  );

  // Get Claude management info for a session
  fastify.get(
    '/agent/sessions/:sessionId/claude-info',
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) => {
      const { sessionId } = request.params;
      if (!sessionId) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'sessionId is required' });
      }

      try {
        const session = await getSession(sessionId);
        if (!session) {
          return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Session not found' });
        }

        return reply.status(HTTP_STATUS.OK).send({
          managementInfo: session.managementInfo || null,
          sessionId,
          engineName: session.engineName,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ err: error }, 'Failed to get Claude info');
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          error: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        });
      }
    },
  );

  // Get aggregated Claude management info for a project
  // Returns the most recent management info from any Claude session in the project
  fastify.get(
    '/agent/projects/:projectId/claude-info',
    async (request: FastifyRequest<{ Params: { projectId: string } }>, reply: FastifyReply) => {
      const { projectId } = request.params;
      if (!projectId) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'projectId is required' });
      }

      try {
        const project = await getProject(projectId);
        if (!project) {
          return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Project not found' });
        }

        // Get only Claude sessions (more efficient than fetching all and filtering)
        const claudeSessions = await getSessionsByProjectAndEngine(projectId, 'claude');
        const sessionsWithInfo = claudeSessions.filter((s) => s.managementInfo);

        // Sort by lastUpdated in management info (fallback to session.updatedAt for old data)
        sessionsWithInfo.sort((a, b) => {
          const aTime = a.managementInfo?.lastUpdated || a.updatedAt || '';
          const bTime = b.managementInfo?.lastUpdated || b.updatedAt || '';
          return bTime.localeCompare(aTime);
        });

        const latestInfo = sessionsWithInfo[0]?.managementInfo || null;
        const sourceSessionId = sessionsWithInfo[0]?.id;

        return reply.status(HTTP_STATUS.OK).send({
          managementInfo: latestInfo,
          sourceSessionId,
          projectId,
          sessionsWithInfo: sessionsWithInfo.length,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ err: error }, 'Failed to get project Claude info');
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          error: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        });
      }
    },
  );

  // ============================================================
  // Open Project Routes
  // ============================================================

  /**
   * POST /agent/sessions/:sessionId/open
   * Open session's project directory in VSCode or terminal.
   */
  fastify.post(
    '/agent/sessions/:sessionId/open',
    async (
      request: FastifyRequest<{
        Params: { sessionId: string };
        Body: OpenProjectRequest;
      }>,
      reply: FastifyReply,
    ) => {
      const { sessionId } = request.params;
      const { target } = request.body || {};

      if (!sessionId) {
        return reply
          .status(HTTP_STATUS.BAD_REQUEST)
          .send({ success: false, error: 'sessionId is required' });
      }
      if (!target || typeof target !== 'string') {
        return reply
          .status(HTTP_STATUS.BAD_REQUEST)
          .send({ success: false, error: 'target is required' });
      }
      if (!isValidOpenTarget(target)) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({
          success: false,
          error: `Invalid target. Must be one of: ${VALID_OPEN_TARGETS.join(', ')}`,
        });
      }

      try {
        // Get session and its project
        const session = await getSession(sessionId);
        if (!session) {
          return reply
            .status(HTTP_STATUS.NOT_FOUND)
            .send({ success: false, error: 'Session not found' });
        }

        const project = await getProject(session.projectId);
        if (!project) {
          return reply
            .status(HTTP_STATUS.NOT_FOUND)
            .send({ success: false, error: 'Project not found' });
        }

        // Open the project directory
        const result = await openProjectDirectory(project.rootPath, target);
        if (result.success) {
          return reply.status(HTTP_STATUS.OK).send({ success: true });
        }
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          success: false,
          error: result.error,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ err: error }, 'Failed to open session project');
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          success: false,
          error: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        });
      }
    },
  );

  /**
   * POST /agent/projects/:projectId/open
   * Open project directory in VSCode or terminal.
   */
  fastify.post(
    '/agent/projects/:projectId/open',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Body: OpenProjectRequest;
      }>,
      reply: FastifyReply,
    ) => {
      const { projectId } = request.params;
      const { target } = request.body || {};

      if (!projectId) {
        return reply
          .status(HTTP_STATUS.BAD_REQUEST)
          .send({ success: false, error: 'projectId is required' });
      }
      if (!target || typeof target !== 'string') {
        return reply
          .status(HTTP_STATUS.BAD_REQUEST)
          .send({ success: false, error: 'target is required' });
      }
      if (!isValidOpenTarget(target)) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({
          success: false,
          error: `Invalid target. Must be one of: ${VALID_OPEN_TARGETS.join(', ')}`,
        });
      }

      try {
        const project = await getProject(projectId);
        if (!project) {
          return reply
            .status(HTTP_STATUS.NOT_FOUND)
            .send({ success: false, error: 'Project not found' });
        }

        // Open the project directory
        const result = await openProjectDirectory(project.rootPath, target);
        if (result.success) {
          return reply.status(HTTP_STATUS.OK).send({ success: true });
        }
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          success: false,
          error: result.error,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ err: error }, 'Failed to open project');
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          success: false,
          error: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        });
      }
    },
  );

  /**
   * POST /agent/projects/:projectId/open-file
   * Open a file in VSCode at a specific line/column.
   *
   * Request body:
   * - filePath: string (required) - File path (relative or absolute)
   * - line?: number - Line number (1-based)
   * - column?: number - Column number (1-based)
   */
  fastify.post(
    '/agent/projects/:projectId/open-file',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Body: { filePath?: string; line?: number; column?: number };
      }>,
      reply: FastifyReply,
    ) => {
      const { projectId } = request.params;
      const { filePath, line, column } = request.body || {};

      if (!projectId) {
        return reply
          .status(HTTP_STATUS.BAD_REQUEST)
          .send({ success: false, error: 'projectId is required' });
      }
      if (!filePath || typeof filePath !== 'string') {
        return reply
          .status(HTTP_STATUS.BAD_REQUEST)
          .send({ success: false, error: 'filePath is required' });
      }

      try {
        const project = await getProject(projectId);
        if (!project) {
          return reply
            .status(HTTP_STATUS.NOT_FOUND)
            .send({ success: false, error: 'Project not found' });
        }

        // Open the file in VSCode
        const result = await openFileInVSCode(project.rootPath, filePath, line, column);
        if (result.success) {
          return reply.status(HTTP_STATUS.OK).send({ success: true });
        }
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          success: false,
          error: result.error,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ err: error }, 'Failed to open file in VSCode');
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          success: false,
          error: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        });
      }
    },
  );

  // ============================================================
  // Chat Message Routes
  // ============================================================

  fastify.get(
    '/agent/chat/:projectId/messages',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Querystring: { limit?: string; offset?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { projectId } = request.params;
      if (!projectId) {
        reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'projectId is required' });
        return;
      }

      const limitRaw = request.query.limit;
      const offsetRaw = request.query.offset;
      const limit = Number.parseInt(limitRaw || '', 10);
      const offset = Number.parseInt(offsetRaw || '', 10);
      const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 50;
      const safeOffset = Number.isFinite(offset) && offset >= 0 ? offset : 0;

      try {
        const [messages, totalCount] = await Promise.all([
          getMessagesByProjectId(projectId, safeLimit, safeOffset),
          getMessagesCountByProjectId(projectId),
        ]);

        reply.status(HTTP_STATUS.OK).send({
          success: true,
          data: messages,
          totalCount,
          pagination: {
            limit: safeLimit,
            offset: safeOffset,
            count: messages.length,
            hasMore: safeOffset + messages.length < totalCount,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ err: error }, 'Failed to load agent chat messages');
        reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          success: false,
          error: 'Failed to fetch messages',
          message: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        });
      }
    },
  );

  fastify.post(
    '/agent/chat/:projectId/messages',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Body: {
          content?: string;
          role?: string;
          messageType?: string;
          conversationId?: string;
          sessionId?: string;
          cliSource?: string;
          metadata?: Record<string, unknown>;
          requestId?: string;
          id?: string;
          createdAt?: string;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const { projectId } = request.params;
      if (!projectId) {
        reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'projectId is required' });
        return;
      }

      const body = request.body || {};
      const content = typeof body.content === 'string' ? body.content.trim() : '';
      if (!content) {
        reply
          .status(HTTP_STATUS.BAD_REQUEST)
          .send({ success: false, error: 'content is required' });
        return;
      }

      const rawRole = typeof body.role === 'string' ? body.role.toLowerCase().trim() : 'user';
      const role: 'assistant' | 'user' | 'system' | 'tool' =
        rawRole === 'assistant' || rawRole === 'system' || rawRole === 'tool'
          ? (rawRole as 'assistant' | 'system' | 'tool')
          : 'user';

      const rawType = typeof body.messageType === 'string' ? body.messageType.toLowerCase() : '';
      const allowedTypes = ['chat', 'tool_use', 'tool_result', 'status'] as const;
      const fallbackType: (typeof allowedTypes)[number] = role === 'system' ? 'status' : 'chat';
      const messageType =
        (allowedTypes as readonly string[]).includes(rawType) && rawType
          ? (rawType as (typeof allowedTypes)[number])
          : fallbackType;

      try {
        const stored = await createStoredMessage({
          projectId,
          role,
          messageType,
          content,
          metadata: body.metadata,
          sessionId: body.sessionId,
          conversationId: body.conversationId,
          cliSource: body.cliSource,
          requestId: body.requestId,
          id: body.id,
          createdAt: body.createdAt,
        });

        reply.status(HTTP_STATUS.CREATED).send({ success: true, data: stored });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ err: error }, 'Failed to create agent chat message');
        reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          success: false,
          error: 'Failed to create message',
          message: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        });
      }
    },
  );

  fastify.delete(
    '/agent/chat/:projectId/messages',
    async (
      request: FastifyRequest<{
        Params: { projectId: string };
        Querystring: { conversationId?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const { projectId } = request.params;
      if (!projectId) {
        reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'projectId is required' });
        return;
      }

      const { conversationId } = request.query;

      try {
        const deleted = await deleteMessagesByProjectId(projectId, conversationId || undefined);
        reply.status(HTTP_STATUS.OK).send({ success: true, deleted });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fastify.log.error({ err: error }, 'Failed to delete agent chat messages');
        reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          success: false,
          error: 'Failed to delete messages',
          message: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR,
        });
      }
    },
  );

  // ============================================================
  // Chat Streaming Routes (SSE)
  // ============================================================

  fastify.get(
    '/agent/chat/:sessionId/stream',
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) => {
      const { sessionId } = request.params;
      if (!sessionId) {
        reply
          .status(HTTP_STATUS.BAD_REQUEST)
          .send({ error: 'sessionId is required for agent stream' });
        return;
      }

      try {
        reply.raw.writeHead(HTTP_STATUS.OK, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        // Ensure client immediately receives an open event
        reply.raw.write(':\n\n');

        streamManager.addSseStream(sessionId, reply.raw);

        const connectedEvent: RealtimeEvent = {
          type: 'connected',
          data: {
            sessionId,
            transport: 'sse',
            timestamp: new Date().toISOString(),
          },
        };
        streamManager.publish(connectedEvent);

        reply.raw.on('close', () => {
          streamManager.removeSseStream(sessionId, reply.raw);
        });
      } catch (error) {
        if (!reply.sent) {
          reply.code(HTTP_STATUS.INTERNAL_SERVER_ERROR).send(ERROR_MESSAGES.INTERNAL_SERVER_ERROR);
        }
      }
    },
  );

  // ============================================================
  // Chat Action Routes
  // ============================================================

  fastify.post(
    '/agent/chat/:sessionId/act',
    {
      // Increase body limit to support image attachments (base64 encoded)
      // Default Fastify limit is 1MB, which is too small for images
      config: {
        rawBody: false,
      },
      bodyLimit: 50 * 1024 * 1024, // 50MB to support multiple images
    },
    async (
      request: FastifyRequest<{ Params: { sessionId: string }; Body: AgentActRequest }>,
      reply: FastifyReply,
    ) => {
      const { sessionId } = request.params;
      const payload = request.body;

      if (!sessionId) {
        reply
          .status(HTTP_STATUS.BAD_REQUEST)
          .send({ error: 'sessionId is required for agent act' });
        return;
      }

      try {
        const { requestId } = await chatService.handleAct(sessionId, payload);
        const response: AgentActResponse = {
          requestId,
          sessionId,
          status: 'accepted',
        };
        reply.status(HTTP_STATUS.OK).send(response);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        reply
          .status(HTTP_STATUS.BAD_REQUEST)
          .send({ error: message || ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
      }
    },
  );

  // Cancel specific request
  fastify.delete(
    '/agent/chat/:sessionId/cancel/:requestId',
    async (
      request: FastifyRequest<{ Params: { sessionId: string; requestId: string } }>,
      reply: FastifyReply,
    ) => {
      const { sessionId, requestId } = request.params;

      if (!sessionId || !requestId) {
        reply
          .status(HTTP_STATUS.BAD_REQUEST)
          .send({ error: 'sessionId and requestId are required' });
        return;
      }

      const cancelled = chatService.cancelExecution(requestId);
      if (cancelled) {
        reply.status(HTTP_STATUS.OK).send({
          success: true,
          message: 'Execution cancelled',
          requestId,
          sessionId,
        });
      } else {
        reply.status(HTTP_STATUS.OK).send({
          success: false,
          message: 'No running execution found with this requestId',
          requestId,
          sessionId,
        });
      }
    },
  );

  // Cancel all executions for a session
  fastify.delete(
    '/agent/chat/:sessionId/cancel',
    async (request: FastifyRequest<{ Params: { sessionId: string } }>, reply: FastifyReply) => {
      const { sessionId } = request.params;

      if (!sessionId) {
        reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: 'sessionId is required' });
        return;
      }

      const cancelledCount = chatService.cancelSessionExecutions(sessionId);
      reply.status(HTTP_STATUS.OK).send({
        success: true,
        cancelledCount,
        sessionId,
      });
    },
  );

  // ============================================================
  // Attachment Routes
  // ============================================================

  /**
   * GET /agent/attachments/stats
   * Get statistics for all attachment caches.
   */
  fastify.get('/agent/attachments/stats', async (_request, reply) => {
    try {
      const stats = await attachmentService.getAttachmentStats();

      // Enrich with project names from database
      const projects = await listProjects();
      const projectMap = new Map(projects.map((p) => [p.id, p.name]));
      const dbProjectIds = new Set(projects.map((p) => p.id));

      const enrichedProjects = stats.projects.map((p) => ({
        ...p,
        projectName: projectMap.get(p.projectId),
        existsInDb: dbProjectIds.has(p.projectId),
      }));

      const orphanProjectIds = stats.projects
        .filter((p) => !dbProjectIds.has(p.projectId))
        .map((p) => p.projectId);

      const response: AttachmentStatsResponse = {
        success: true,
        rootDir: stats.rootDir,
        totalFiles: stats.totalFiles,
        totalBytes: stats.totalBytes,
        projects: enrichedProjects,
        orphanProjectIds,
      };

      reply.status(HTTP_STATUS.OK).send(response);
    } catch (error) {
      fastify.log.error({ err: error }, 'Failed to get attachment stats');
      reply
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .send({ error: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
    }
  });

  /**
   * GET /agent/attachments/:projectId/:filename
   * Serve an attachment file.
   */
  fastify.get(
    '/agent/attachments/:projectId/:filename',
    async (
      request: FastifyRequest<{ Params: { projectId: string; filename: string } }>,
      reply: FastifyReply,
    ) => {
      const { projectId, filename } = request.params;

      try {
        // Validate and get file
        const buffer = await attachmentService.readAttachment(projectId, filename);

        // Determine content type from filename extension
        const ext = filename.split('.').pop()?.toLowerCase();
        let contentType = 'application/octet-stream';
        switch (ext) {
          case 'png':
            contentType = 'image/png';
            break;
          case 'jpg':
          case 'jpeg':
            contentType = 'image/jpeg';
            break;
          case 'gif':
            contentType = 'image/gif';
            break;
          case 'webp':
            contentType = 'image/webp';
            break;
        }

        reply
          .header('Content-Type', contentType)
          .header('Cache-Control', 'public, max-age=31536000, immutable')
          .send(buffer);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (message.includes('Invalid') || message.includes('traversal')) {
          reply.status(HTTP_STATUS.BAD_REQUEST).send({ error: message });
          return;
        }

        // File not found or read error
        reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Attachment not found' });
      }
    },
  );

  /**
   * DELETE /agent/attachments/:projectId
   * Clean up attachments for a specific project.
   */
  fastify.delete(
    '/agent/attachments/:projectId',
    async (request: FastifyRequest<{ Params: { projectId: string } }>, reply: FastifyReply) => {
      const { projectId } = request.params;

      try {
        const result = await attachmentService.cleanupAttachments({ projectIds: [projectId] });

        const response: AttachmentCleanupResponse = {
          success: true,
          scope: 'project',
          removedFiles: result.removedFiles,
          removedBytes: result.removedBytes,
          results: result.results,
        };

        reply.status(HTTP_STATUS.OK).send(response);
      } catch (error) {
        fastify.log.error({ err: error }, 'Failed to cleanup project attachments');
        reply
          .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
          .send({ error: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
      }
    },
  );

  /**
   * DELETE /agent/attachments
   * Clean up attachments for all or selected projects.
   */
  fastify.delete(
    '/agent/attachments',
    async (request: FastifyRequest<{ Body?: AttachmentCleanupRequest }>, reply: FastifyReply) => {
      try {
        const body = request.body;
        const projectIds = body?.projectIds;

        const result = await attachmentService.cleanupAttachments(
          projectIds ? { projectIds } : undefined,
        );

        const scope = projectIds && projectIds.length > 0 ? 'selected' : 'all';

        const response: AttachmentCleanupResponse = {
          success: true,
          scope,
          removedFiles: result.removedFiles,
          removedBytes: result.removedBytes,
          results: result.results,
        };

        reply.status(HTTP_STATUS.OK).send(response);
      } catch (error) {
        fastify.log.error({ err: error }, 'Failed to cleanup attachments');
        reply
          .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
          .send({ error: ERROR_MESSAGES.INTERNAL_SERVER_ERROR });
      }
    },
  );
}
