/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createCorsHeaders,
  createServerToken,
  getSingleHeader,
  isAllowedOrigin,
  isAuthorized,
} from './http/auth.js';
import { AcpEventRouter } from './acp/AcpEventRouter.js';
import { PermissionBridge } from './acp/permissionBridge.js';
import { isDesktopHttpError, DesktopHttpError } from './http/errors.js';
import {
  DesktopGitReviewService,
  type DesktopGitTarget,
} from './services/gitReviewService.js';
import { DesktopProjectService } from './services/projectService.js';
import { getRuntimeInfo } from './services/runtimeService.js';
import {
  DesktopSessionService,
  isDesktopApprovalMode,
} from './services/sessionService.js';
import { DesktopSettingsService } from './services/settingsService.js';
import type { DesktopUpdateUserSettingsRequest } from './services/settingsService.js';
import { DesktopTerminalService } from './services/terminalService.js';
import { SessionSocketHub } from './ws/SessionSocketHub.js';
import type { DesktopServer, DesktopServerOptions } from './types.js';

interface HandlerContext {
  token: string;
  startedAt: number;
  now: () => Date;
  gitReviewService: DesktopGitReviewService;
  projectService: DesktopProjectService;
  sessionService: DesktopSessionService;
  settingsService: DesktopSettingsService;
  terminalService: DesktopTerminalService;
  acpClient: DesktopServerOptions['acpClient'];
}

export async function startDesktopServer(
  options: DesktopServerOptions = {},
): Promise<DesktopServer> {
  const token = options.token ?? createServerToken();
  const now = options.now ?? (() => new Date());
  const startedAt = now().getTime();
  const projectService = new DesktopProjectService({
    storePath: options.projectStorePath,
    now,
  });
  const gitReviewService = new DesktopGitReviewService(now);
  const sessionService = new DesktopSessionService(options.acpClient);
  const settingsService = new DesktopSettingsService(options.settingsPath);
  const terminalService = new DesktopTerminalService(now);
  const socketHubRef: { current: SessionSocketHub | null } = { current: null };
  const permissionBridge = new PermissionBridge({
    timeoutMs: options.permissionRequestTimeoutMs,
    broadcast: (sessionId, message) => {
      socketHubRef.current?.broadcast(sessionId, message);
    },
  });
  const socketHub = new SessionSocketHub({
    token,
    acpClient: options.acpClient,
    permissionBridge,
  });
  socketHubRef.current = socketHub;
  const acpEventRouter = new AcpEventRouter({
    broadcast: (sessionId, message) => socketHub.broadcast(sessionId, message),
  });
  const previousSessionUpdateHandler = options.acpClient?.onSessionUpdate;
  if (options.acpClient) {
    options.acpClient.onSessionUpdate = (notification) => {
      previousSessionUpdateHandler?.(notification);
      acpEventRouter.handleSessionUpdate(notification);
    };
    options.acpClient.onPermissionRequest = (request) =>
      permissionBridge.requestPermission(request);
  }
  const server = createServer((request, response) => {
    void handleRequest(request, response, {
      token,
      startedAt,
      now,
      gitReviewService,
      projectService,
      sessionService,
      settingsService,
      terminalService,
      acpClient: options.acpClient,
    }).catch((error: unknown) => {
      const origin = getSingleHeader(request.headers.origin);
      if (isDesktopHttpError(error)) {
        sendJson(response, origin, error.statusCode, {
          ok: false,
          code: error.code,
          message: error.message,
        });
        return;
      }

      sendJson(response, origin, 500, {
        ok: false,
        code: 'internal_error',
        message:
          error instanceof Error
            ? error.message
            : 'Desktop server request failed.',
      });
    });
  });
  server.on('upgrade', (request, socket, head) => {
    socketHub.handleUpgrade(request, socket, head);
  });

  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error) => {
      server.off('listening', handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.off('error', handleError);
      resolve();
    };

    server.once('error', handleError);
    server.once('listening', handleListening);
    server.listen(0, '127.0.0.1');
  });

  const address = server.address();
  if (!isAddressInfo(address)) {
    await closeHttpServer(server);
    throw new Error('Desktop server did not bind to a TCP address.');
  }

  return {
    info: {
      url: `http://127.0.0.1:${address.port}`,
      token,
    },
    close: async () => {
      permissionBridge.close();
      socketHub.close();
      terminalService.close();
      await closeHttpServer(server);
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: HandlerContext,
): Promise<void> {
  const origin = getSingleHeader(request.headers.origin);
  if (!isAllowedOrigin(origin)) {
    sendJson(response, origin, 403, {
      ok: false,
      code: 'origin_forbidden',
      message: 'Request origin is not allowed.',
    });
    return;
  }

  if (request.method === 'OPTIONS') {
    response.writeHead(204, createCorsHeaders(origin));
    response.end();
    return;
  }

  if (!isAuthorized(request.headers, context.token)) {
    sendJson(response, origin, 401, {
      ok: false,
      code: 'unauthorized',
      message: 'Missing or invalid desktop server token.',
    });
    return;
  }

  const requestUrl = parseRequestUrl(request);
  if (!requestUrl) {
    sendJson(response, origin, 400, {
      ok: false,
      code: 'bad_request',
      message: 'Request URL is invalid.',
    });
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/health') {
    sendJson(response, origin, 200, {
      ok: true,
      service: 'qwen-desktop',
      uptimeMs: Math.max(0, context.now().getTime() - context.startedAt),
      timestamp: context.now().toISOString(),
    });
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/runtime') {
    sendJson(response, origin, 200, await getRuntimeInfo(context.acpClient));
    return;
  }

  if (requestUrl.pathname === '/api/projects') {
    await handleProjectsRoute(request, response, origin, context);
    return;
  }

  if (requestUrl.pathname === '/api/projects/open') {
    await handleOpenProjectRoute(request, response, origin, context);
    return;
  }

  const projectGitStatusMatch = matchSessionRoute(
    requestUrl.pathname,
    /^\/api\/projects\/([^/]+)\/git\/status$/u,
  );
  if (projectGitStatusMatch) {
    await handleProjectGitStatusRoute(
      request,
      response,
      origin,
      context,
      projectGitStatusMatch,
    );
    return;
  }

  const projectGitBranchesMatch = matchSessionRoute(
    requestUrl.pathname,
    /^\/api\/projects\/([^/]+)\/git\/branches$/u,
  );
  if (projectGitBranchesMatch) {
    await handleProjectGitBranchesRoute(
      request,
      response,
      origin,
      context,
      projectGitBranchesMatch,
    );
    return;
  }

  const projectGitCheckoutMatch = matchSessionRoute(
    requestUrl.pathname,
    /^\/api\/projects\/([^/]+)\/git\/checkout$/u,
  );
  if (projectGitCheckoutMatch) {
    await handleProjectGitCheckoutRoute(
      request,
      response,
      origin,
      context,
      projectGitCheckoutMatch,
    );
    return;
  }

  const projectGitDiffMatch = matchSessionRoute(
    requestUrl.pathname,
    /^\/api\/projects\/([^/]+)\/git\/diff$/u,
  );
  if (projectGitDiffMatch) {
    await handleProjectGitDiffRoute(
      request,
      response,
      origin,
      context,
      projectGitDiffMatch,
    );
    return;
  }

  const projectGitStageMatch = matchSessionRoute(
    requestUrl.pathname,
    /^\/api\/projects\/([^/]+)\/git\/stage$/u,
  );
  if (projectGitStageMatch) {
    await handleProjectGitStageRoute(
      request,
      response,
      origin,
      context,
      projectGitStageMatch,
    );
    return;
  }

  const projectGitRevertMatch = matchSessionRoute(
    requestUrl.pathname,
    /^\/api\/projects\/([^/]+)\/git\/revert$/u,
  );
  if (projectGitRevertMatch) {
    await handleProjectGitRevertRoute(
      request,
      response,
      origin,
      context,
      projectGitRevertMatch,
    );
    return;
  }

  const projectGitCommitMatch = matchSessionRoute(
    requestUrl.pathname,
    /^\/api\/projects\/([^/]+)\/git\/commit$/u,
  );
  if (projectGitCommitMatch) {
    await handleProjectGitCommitRoute(
      request,
      response,
      origin,
      context,
      projectGitCommitMatch,
    );
    return;
  }

  if (requestUrl.pathname === '/api/settings/user') {
    await handleUserSettingsRoute(request, response, origin, context);
    return;
  }

  if (requestUrl.pathname === '/api/terminals') {
    await handleTerminalsRoute(request, response, origin, context);
    return;
  }

  const terminalKillMatch = matchSessionRoute(
    requestUrl.pathname,
    /^\/api\/terminals\/([^/]+)\/kill$/u,
  );
  if (terminalKillMatch) {
    await handleTerminalKillRoute(
      request,
      response,
      origin,
      context,
      terminalKillMatch,
    );
    return;
  }

  const terminalWriteMatch = matchSessionRoute(
    requestUrl.pathname,
    /^\/api\/terminals\/([^/]+)\/write$/u,
  );
  if (terminalWriteMatch) {
    await handleTerminalWriteRoute(
      request,
      response,
      origin,
      context,
      terminalWriteMatch,
    );
    return;
  }

  const terminalMatch = matchSessionRoute(
    requestUrl.pathname,
    /^\/api\/terminals\/([^/]+)$/u,
  );
  if (terminalMatch) {
    await handleTerminalRoute(
      request,
      response,
      origin,
      context,
      terminalMatch,
    );
    return;
  }

  if (requestUrl.pathname === '/api/auth') {
    await handleAuthRoute(request, response, origin, context);
    return;
  }

  const authMethodMatch = matchSessionRoute(
    requestUrl.pathname,
    /^\/api\/auth\/([^/]+)$/u,
  );
  if (authMethodMatch) {
    await handleAuthMethodRoute(
      request,
      response,
      origin,
      context,
      authMethodMatch,
    );
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/models') {
    const sessionId = requestUrl.searchParams.get('sessionId');
    if (!sessionId) {
      throw new DesktopHttpError(
        400,
        'bad_request',
        'sessionId query parameter is required.',
      );
    }

    sendJson(response, origin, 200, {
      ok: true,
      models: context.sessionService.getModelState(sessionId),
    });
    return;
  }

  if (requestUrl.pathname === '/api/sessions') {
    await handleSessionsRoute(request, response, origin, requestUrl, context);
    return;
  }

  const loadSessionMatch = matchSessionRoute(
    requestUrl.pathname,
    /^\/api\/sessions\/([^/]+)\/load$/u,
  );
  if (loadSessionMatch) {
    await handleLoadSessionRoute(
      request,
      response,
      origin,
      context,
      loadSessionMatch,
    );
    return;
  }

  const sessionModelMatch = matchSessionRoute(
    requestUrl.pathname,
    /^\/api\/sessions\/([^/]+)\/model$/u,
  );
  if (sessionModelMatch) {
    await handleSessionModelRoute(
      request,
      response,
      origin,
      context,
      sessionModelMatch,
    );
    return;
  }

  const sessionModeMatch = matchSessionRoute(
    requestUrl.pathname,
    /^\/api\/sessions\/([^/]+)\/mode$/u,
  );
  if (sessionModeMatch) {
    await handleSessionModeRoute(
      request,
      response,
      origin,
      context,
      sessionModeMatch,
    );
    return;
  }

  const sessionMatch = matchSessionRoute(
    requestUrl.pathname,
    /^\/api\/sessions\/([^/]+)$/u,
  );
  if (sessionMatch) {
    await handleSessionRoute(
      request,
      response,
      origin,
      requestUrl,
      context,
      sessionMatch,
    );
    return;
  }

  sendJson(response, origin, 404, {
    ok: false,
    code: 'not_found',
    message: 'Route not found.',
  });
}

async function handleProjectsRoute(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  context: HandlerContext,
): Promise<void> {
  if (request.method === 'GET') {
    sendJson(response, origin, 200, {
      ok: true,
      projects: await context.projectService.listProjects(),
    });
    return;
  }

  sendMethodNotAllowed(response, origin);
}

async function handleOpenProjectRoute(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  context: HandlerContext,
): Promise<void> {
  if (request.method === 'POST') {
    const body = await readObjectBody(request);
    const projectPath = getRequiredString(body, 'path');
    sendJson(response, origin, 200, {
      ok: true,
      project: await context.projectService.openProject(projectPath),
    });
    return;
  }

  sendMethodNotAllowed(response, origin);
}

async function handleProjectGitStatusRoute(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  context: HandlerContext,
  projectId: string,
): Promise<void> {
  if (request.method === 'GET') {
    sendJson(response, origin, 200, {
      ok: true,
      status: await context.projectService.getProjectGitStatus(projectId),
    });
    return;
  }

  sendMethodNotAllowed(response, origin);
}

async function handleProjectGitDiffRoute(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  context: HandlerContext,
  projectId: string,
): Promise<void> {
  if (request.method === 'GET') {
    const projectPath = await context.projectService.getProjectPath(projectId);
    sendJson(
      response,
      origin,
      200,
      await context.gitReviewService.getDiff(projectPath),
    );
    return;
  }

  sendMethodNotAllowed(response, origin);
}

async function handleProjectGitBranchesRoute(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  context: HandlerContext,
  projectId: string,
): Promise<void> {
  if (request.method === 'GET') {
    const status = await context.projectService.getProjectGitStatus(projectId);
    sendJson(response, origin, 200, {
      ok: true,
      branches: await context.projectService.listProjectGitBranches(projectId),
      current: status.branch,
      dirty: !status.clean,
    });
    return;
  }

  if (request.method === 'POST') {
    const body = await readObjectBody(request);
    const branchName = getRequiredString(body, 'branchName');
    const status = await context.projectService.createProjectGitBranch(
      projectId,
      branchName,
    );
    const projectPath = await context.projectService.getProjectPath(projectId);
    sendJson(response, origin, 200, {
      ok: true,
      status,
      diff: await context.gitReviewService.getDiff(projectPath),
    });
    return;
  }

  sendMethodNotAllowed(response, origin);
}

async function handleProjectGitCheckoutRoute(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  context: HandlerContext,
  projectId: string,
): Promise<void> {
  if (request.method === 'POST') {
    const body = await readObjectBody(request);
    const branchName = getRequiredString(body, 'branchName');
    const status = await context.projectService.checkoutProjectGitBranch(
      projectId,
      branchName,
    );
    const projectPath = await context.projectService.getProjectPath(projectId);
    sendJson(response, origin, 200, {
      ok: true,
      status,
      diff: await context.gitReviewService.getDiff(projectPath),
    });
    return;
  }

  sendMethodNotAllowed(response, origin);
}

async function handleProjectGitStageRoute(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  context: HandlerContext,
  projectId: string,
): Promise<void> {
  if (request.method === 'POST') {
    const body = await readObjectBody(request);
    const target = parseGitTarget(body);
    const projectPath = await context.projectService.getProjectPath(projectId);
    await context.gitReviewService.stage(projectPath, target);
    sendJson(response, origin, 200, {
      ok: true,
      status: await context.projectService.getProjectGitStatus(projectId),
      diff: await context.gitReviewService.getDiff(projectPath),
    });
    return;
  }

  sendMethodNotAllowed(response, origin);
}

async function handleProjectGitRevertRoute(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  context: HandlerContext,
  projectId: string,
): Promise<void> {
  if (request.method === 'POST') {
    const body = await readObjectBody(request);
    const target = parseGitTarget(body);
    const projectPath = await context.projectService.getProjectPath(projectId);
    await context.gitReviewService.revert(projectPath, target);
    sendJson(response, origin, 200, {
      ok: true,
      status: await context.projectService.getProjectGitStatus(projectId),
      diff: await context.gitReviewService.getDiff(projectPath),
    });
    return;
  }

  sendMethodNotAllowed(response, origin);
}

async function handleProjectGitCommitRoute(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  context: HandlerContext,
  projectId: string,
): Promise<void> {
  if (request.method === 'POST') {
    const body = await readObjectBody(request);
    const message = getRequiredString(body, 'message');
    const projectPath = await context.projectService.getProjectPath(projectId);
    const commit = await context.gitReviewService.commit(projectPath, message);
    sendJson(response, origin, 200, {
      ok: true,
      commit,
      status: await context.projectService.getProjectGitStatus(projectId),
      diff: await context.gitReviewService.getDiff(projectPath),
    });
    return;
  }

  sendMethodNotAllowed(response, origin);
}

async function handleSessionsRoute(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  requestUrl: URL,
  context: HandlerContext,
): Promise<void> {
  if (request.method === 'GET') {
    const result = await context.sessionService.listSessions({
      cwd: getOptionalSearchParam(requestUrl, 'cwd'),
      cursor: getOptionalNumberSearchParam(requestUrl, 'cursor'),
      size: getOptionalNumberSearchParam(requestUrl, 'size'),
    });
    sendJson(response, origin, 200, { ok: true, ...result });
    return;
  }

  if (request.method === 'POST') {
    const body = await readObjectBody(request);
    const cwd = getRequiredString(body, 'cwd');
    const session = await context.sessionService.createSession(cwd);
    sendJson(response, origin, 200, {
      ok: true,
      session: { cwd, ...session },
    });
    return;
  }

  sendMethodNotAllowed(response, origin);
}

async function handleTerminalsRoute(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  context: HandlerContext,
): Promise<void> {
  if (request.method === 'POST') {
    const body = await readObjectBody(request);
    const projectId = getRequiredString(body, 'projectId');
    const command = getRequiredString(body, 'command');
    const projectPath = await context.projectService.getProjectPath(projectId);
    sendJson(response, origin, 200, {
      ok: true,
      terminal: context.terminalService.run(projectId, projectPath, command),
    });
    return;
  }

  sendMethodNotAllowed(response, origin);
}

async function handleTerminalRoute(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  context: HandlerContext,
  terminalId: string,
): Promise<void> {
  if (request.method === 'GET') {
    sendJson(response, origin, 200, {
      ok: true,
      terminal: context.terminalService.get(terminalId),
    });
    return;
  }

  sendMethodNotAllowed(response, origin);
}

async function handleTerminalKillRoute(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  context: HandlerContext,
  terminalId: string,
): Promise<void> {
  if (request.method === 'POST') {
    sendJson(response, origin, 200, {
      ok: true,
      terminal: context.terminalService.kill(terminalId),
    });
    return;
  }

  sendMethodNotAllowed(response, origin);
}

async function handleTerminalWriteRoute(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  context: HandlerContext,
  terminalId: string,
): Promise<void> {
  if (request.method === 'POST') {
    const body = await readObjectBody(request);
    const input = getRequiredString(body, 'input');
    sendJson(response, origin, 200, {
      ok: true,
      terminal: context.terminalService.write(terminalId, input),
    });
    return;
  }

  sendMethodNotAllowed(response, origin);
}

async function handleUserSettingsRoute(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  context: HandlerContext,
): Promise<void> {
  if (request.method === 'GET') {
    sendJson(
      response,
      origin,
      200,
      await context.settingsService.readUserSettings(),
    );
    return;
  }

  if (request.method === 'PUT') {
    const body = await readObjectBody(request);
    sendJson(
      response,
      origin,
      200,
      await context.settingsService.updateUserSettings(
        parseUserSettingsUpdate(body),
      ),
    );
    return;
  }

  sendMethodNotAllowed(response, origin);
}

async function handleAuthRoute(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  context: HandlerContext,
): Promise<void> {
  if (request.method === 'DELETE') {
    sendJson(
      response,
      origin,
      200,
      await context.settingsService.clearPersistedAuth(),
    );
    return;
  }

  sendMethodNotAllowed(response, origin);
}

async function handleAuthMethodRoute(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  context: HandlerContext,
  methodId: string,
): Promise<void> {
  if (request.method !== 'POST') {
    sendMethodNotAllowed(response, origin);
    return;
  }

  await context.sessionService.authenticate(methodId);
  sendJson(response, origin, 200, { ok: true, methodId });
}

async function handleSessionModelRoute(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  context: HandlerContext,
  sessionId: string,
): Promise<void> {
  if (request.method === 'GET') {
    sendJson(response, origin, 200, {
      ok: true,
      models: context.sessionService.getModelState(sessionId),
    });
    return;
  }

  if (request.method === 'PUT') {
    const body = await readObjectBody(request);
    const modelId = getRequiredString(body, 'modelId');
    sendJson(response, origin, 200, {
      ok: true,
      models: await context.sessionService.setSessionModel(sessionId, modelId),
    });
    return;
  }

  sendMethodNotAllowed(response, origin);
}

async function handleSessionModeRoute(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  context: HandlerContext,
  sessionId: string,
): Promise<void> {
  if (request.method === 'GET') {
    sendJson(response, origin, 200, {
      ok: true,
      modes: context.sessionService.getModeState(sessionId),
    });
    return;
  }

  if (request.method === 'PUT') {
    const body = await readObjectBody(request);
    const mode = getRequiredApprovalMode(body, 'mode');
    sendJson(response, origin, 200, {
      ok: true,
      modes: await context.sessionService.setSessionMode(sessionId, mode),
    });
    return;
  }

  sendMethodNotAllowed(response, origin);
}

async function handleLoadSessionRoute(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  context: HandlerContext,
  sessionId: string,
): Promise<void> {
  if (request.method !== 'POST') {
    sendMethodNotAllowed(response, origin);
    return;
  }

  const body = await readObjectBody(request);
  const cwd = getRequiredString(body, 'cwd');
  const session = await context.sessionService.loadSession(sessionId, cwd);
  sendJson(response, origin, 200, {
    ok: true,
    session: { sessionId, cwd, ...session },
  });
}

async function handleSessionRoute(
  request: IncomingMessage,
  response: ServerResponse,
  origin: string | undefined,
  requestUrl: URL,
  context: HandlerContext,
  sessionId: string,
): Promise<void> {
  if (request.method === 'PATCH') {
    const body = await readObjectBody(request);
    const title = getRequiredString(body, 'title');
    const result = await context.sessionService.renameSession(
      sessionId,
      title,
      getOptionalString(body, 'cwd'),
    );
    sendJson(response, origin, 200, { ok: true, result });
    return;
  }

  if (request.method === 'DELETE') {
    const result = await context.sessionService.deleteSession(
      sessionId,
      getOptionalSearchParam(requestUrl, 'cwd'),
    );
    sendJson(response, origin, 200, { ok: true, result });
    return;
  }

  sendMethodNotAllowed(response, origin);
}

function parseRequestUrl(request: IncomingMessage): URL | undefined {
  try {
    return new URL(request.url ?? '/', 'http://127.0.0.1');
  } catch {
    return undefined;
  }
}

function sendJson(
  response: ServerResponse,
  origin: string | undefined,
  statusCode: number,
  payload: unknown,
) {
  if (response.headersSent) {
    response.end();
    return;
  }

  response.writeHead(statusCode, {
    ...createCorsHeaders(origin),
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function sendMethodNotAllowed(
  response: ServerResponse,
  origin: string | undefined,
): void {
  sendJson(response, origin, 405, {
    ok: false,
    code: 'method_not_allowed',
    message: 'Method not allowed.',
  });
}

function matchSessionRoute(pathname: string, pattern: RegExp): string | null {
  const match = pattern.exec(pathname);
  if (!match?.[1]) {
    return null;
  }

  return decodeURIComponent(match[1]);
}

async function readObjectBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const raw = await readRequestBody(request);
  if (!raw) {
    throw new DesktopHttpError(400, 'bad_request', 'Request body is required.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new DesktopHttpError(400, 'bad_json', 'Request body must be JSON.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DesktopHttpError(
      400,
      'bad_request',
      'Request body must be an object.',
    );
  }

  return parsed as Record<string, unknown>;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > 1024 * 1024) {
      throw new DesktopHttpError(
        413,
        'payload_too_large',
        'Request body is too large.',
      );
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

function getRequiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new DesktopHttpError(
      400,
      'bad_request',
      `${key} must be a non-empty string.`,
    );
  }

  return value;
}

function getRequiredApprovalMode(
  body: Record<string, unknown>,
  key: string,
): ReturnType<typeof parseApprovalMode> {
  return parseApprovalMode(body[key], key);
}

function parseApprovalMode(
  value: unknown,
  key: string,
): 'plan' | 'default' | 'auto-edit' | 'yolo' {
  if (!isDesktopApprovalMode(value)) {
    throw new DesktopHttpError(
      400,
      'bad_request',
      `${key} must be plan, default, auto-edit, or yolo.`,
    );
  }

  return value;
}

function parseUserSettingsUpdate(
  body: Record<string, unknown>,
): DesktopUpdateUserSettingsRequest {
  const provider = body['provider'];
  if (provider !== 'api-key' && provider !== 'coding-plan') {
    throw new DesktopHttpError(
      400,
      'bad_request',
      'provider must be api-key or coding-plan.',
    );
  }

  const codingPlanRegion = body['codingPlanRegion'];
  if (
    codingPlanRegion !== undefined &&
    codingPlanRegion !== 'china' &&
    codingPlanRegion !== 'global'
  ) {
    throw new DesktopHttpError(
      400,
      'bad_request',
      'codingPlanRegion must be china or global.',
    );
  }

  const modelProviders = body['modelProviders'];
  if (modelProviders !== undefined && !isStringRecord(modelProviders)) {
    throw new DesktopHttpError(
      400,
      'bad_request',
      'modelProviders must be an object of model ids to base URLs.',
    );
  }

  return {
    provider,
    apiKey: getOptionalString(body, 'apiKey'),
    activeModel: getOptionalString(body, 'activeModel'),
    codingPlanRegion,
    modelProviders,
  };
}

function parseGitTarget(body: Record<string, unknown>): DesktopGitTarget {
  const scope = body['scope'] ?? 'all';
  if (scope === 'all') {
    return { scope };
  }

  if (scope === 'file') {
    return {
      scope,
      filePath: getRequiredString(body, 'filePath'),
    };
  }

  if (scope === 'hunk') {
    return {
      scope,
      filePath: getRequiredString(body, 'filePath'),
      hunkId: getRequiredString(body, 'hunkId'),
    };
  }

  throw new DesktopHttpError(
    400,
    'bad_request',
    'scope must be all, file, or hunk.',
  );
}

function getOptionalString(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new DesktopHttpError(400, 'bad_request', `${key} must be a string.`);
  }

  return value;
}

function getOptionalSearchParam(url: URL, key: string): string | undefined {
  return url.searchParams.get(key) ?? undefined;
}

function getOptionalNumberSearchParam(
  url: URL,
  key: string,
): number | undefined {
  const value = url.searchParams.get(key);
  if (value === null) {
    return undefined;
  }

  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    throw new DesktopHttpError(400, 'bad_request', `${key} must be a number.`);
  }

  return numberValue;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every((entry) => typeof entry === 'string');
}

function isAddressInfo(
  address: string | AddressInfo | null,
): address is AddressInfo {
  return typeof address === 'object' && address !== null;
}

async function closeHttpServer(
  server: ReturnType<typeof createServer>,
): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}
