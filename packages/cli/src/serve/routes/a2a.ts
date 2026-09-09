/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentCard,
  Role,
  TaskState,
  taskStateFromJSON,
  type ListTasksResponse,
  type Task,
} from '@a2a-js/sdk';
import {
  JsonRpcRequestMalformedError,
  JsonRpcTaskNotFoundError,
  JsonRpcUnsupportedOperationError,
} from '@a2a-js/sdk/errors';
import {
  UnauthenticatedUser,
  type A2ARequestHandler,
  type ServerCallContext,
  type User,
} from '@a2a-js/sdk/server';
import { jsonRpcHandler } from '@a2a-js/sdk/server/express';
import {
  A2A_AGENT_CARD_PATH,
  A2A_CONTENT_TYPE,
  A2A_PROTOCOL_VERSION,
  A2A_TRANSPORT_BINDING,
  QWEN_A2A_EXTENSION_URI,
  a2aAgentCardForCaller,
  a2aCancelTask,
  a2aGetTask,
  a2aListTasks,
  a2aSendMessage,
  type A2AAgentCard,
  type A2ACaller,
  type A2AFailure,
  type A2ATaskView,
} from '@qwen-code/qwen-code-core';
import type { Application, NextFunction, Request, Response } from 'express';
import type { WorkspaceRegistry } from '../workspace-registry.js';

const A2A_PATH = '/a2a/v1';
const REQUEST_REFUSED = -32010;
const IDEMPOTENCY_CONFLICT = -32011;

const HEADER_WORKSPACE = 'x-qwen-workspace-id';
const HEADER_CALLER = 'x-qwen-caller-id';
const HEADER_AGENT = 'x-qwen-agent-id';

class AuthenticatedA2AUser implements User {
  readonly isAuthenticated = true;

  constructor(
    readonly projectRoot: string,
    readonly caller: A2ACaller,
    readonly agentId: string,
    readonly baseUrl: string,
  ) {}

  get userName(): string {
    return this.caller.callerId;
  }
}

function runtimeFor(registry: WorkspaceRegistry, workspaceId: string) {
  return registry
    .listAll()
    .find((runtime) => runtime.workspaceId === workspaceId);
}

function baseUrl(req: Request): string {
  return `${req.protocol}://${req.get('host') ?? '127.0.0.1'}`;
}

async function buildUser(
  req: Request,
  registry: WorkspaceRegistry,
): Promise<User> {
  const authorization = /^Bearer ([A-Za-z0-9_-]{32,})$/.exec(
    req.get('authorization') ?? '',
  );
  const workspaceId = req.get(HEADER_WORKSPACE);
  const callerId = req.get(HEADER_CALLER);
  const agentId = req.get(HEADER_AGENT);
  const runtime = workspaceId ? runtimeFor(registry, workspaceId) : undefined;
  if (
    !authorization ||
    !callerId ||
    !agentId ||
    !runtime ||
    (!runtime.primary && !runtime.trusted)
  ) {
    return new UnauthenticatedUser();
  }
  return new AuthenticatedA2AUser(
    runtime.workspaceCwd,
    { callerId, secret: authorization[1] },
    agentId,
    baseUrl(req),
  );
}

function authenticated(context: ServerCallContext): AuthenticatedA2AUser {
  if (!(context.user instanceof AuthenticatedA2AUser)) {
    throw new JsonRpcRequestMalformedError({
      envelopeCode: REQUEST_REFUSED,
      message: 'Request refused.',
    });
  }
  return context.user;
}

function fail(failure: A2AFailure): never {
  switch (failure.kind) {
    case 'invalid':
      throw new JsonRpcRequestMalformedError({ message: failure.detail });
    case 'not_found':
      throw new JsonRpcTaskNotFoundError({ message: 'Task not found.' });
    case 'refused':
      throw new JsonRpcRequestMalformedError({
        envelopeCode: REQUEST_REFUSED,
        message: 'Request refused.',
      });
    case 'conflict':
      throw new JsonRpcRequestMalformedError({
        envelopeCode: IDEMPOTENCY_CONFLICT,
        message: `Message id was already used for different content. Existing task: ${failure.existingTaskId}.`,
        metadata: { existingTaskId: failure.existingTaskId },
      });
  }
}

function unwrap<T>(
  result: { ok: true; value: T } | ({ ok: false } & A2AFailure),
): T {
  return result.ok ? result.value : fail(result);
}

function task(view: A2ATaskView): Task {
  return {
    id: view.id,
    contextId: view.contextId,
    status: {
      state: taskStateFromJSON(view.status.state),
      message: undefined,
      timestamp: view.status.timestamp,
    },
    artifacts: [],
    history: [],
    metadata: view.metadata,
  };
}

function securityRequirements() {
  return [
    {
      schemes: {
        bearer: { list: [] },
        workspace: { list: [] },
        caller: { list: [] },
        agent: { list: [] },
      },
    },
  ];
}

function card(source: A2AAgentCard): AgentCard {
  const requirements = securityRequirements();
  return {
    name: source.name,
    description: source.description,
    supportedInterfaces: source.interfaces.map((entry) => ({
      url: entry.url,
      protocolBinding: entry.protocolBinding,
      protocolVersion: source.protocolVersion,
      tenant: '',
    })),
    provider: undefined,
    version: '1.0.0',
    capabilities: {
      streaming: source.capabilities.streaming,
      pushNotifications: source.capabilities.pushNotifications,
      extendedAgentCard: source.capabilities.extendedAgentCard,
      extensions: source.capabilities.extensions.map((extension) => ({
        ...extension,
        params: undefined,
      })),
    },
    securitySchemes: {
      bearer: {
        scheme: {
          $case: 'httpAuthSecurityScheme',
          value: {
            description: 'Opaque A2A grant secret',
            scheme: 'Bearer',
            bearerFormat: 'opaque',
          },
        },
      },
      workspace: {
        scheme: {
          $case: 'apiKeySecurityScheme',
          value: {
            description: 'Workspace containing the target agent',
            location: 'header',
            name: HEADER_WORKSPACE,
          },
        },
      },
      caller: {
        scheme: {
          $case: 'apiKeySecurityScheme',
          value: {
            description: 'Stable external caller id',
            location: 'header',
            name: HEADER_CALLER,
          },
        },
      },
      agent: {
        scheme: {
          $case: 'apiKeySecurityScheme',
          value: {
            description: 'Agent addressed by this grant',
            location: 'header',
            name: HEADER_AGENT,
          },
        },
      },
    },
    securityRequirements: requirements,
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: source.skills.map((skill) => ({
      ...skill,
      tags: [],
      examples: [],
      inputModes: ['text/plain'],
      outputModes: ['text/plain'],
      securityRequirements: requirements,
    })),
    signatures: [],
  };
}

function publicCard(origin: string): AgentCard {
  return card({
    protocolVersion: A2A_PROTOCOL_VERSION,
    name: 'Qwen Code workspace agents',
    description: 'Workspace agents collaborating on shared task threads',
    interfaces: [
      {
        url: `${origin}${A2A_PATH}`,
        protocolBinding: A2A_TRANSPORT_BINDING,
      },
    ],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: true,
      extensions: [
        {
          uri: QWEN_A2A_EXTENSION_URI,
          description: 'Carries Qwen Code thread state and known token usage',
          required: false,
        },
      ],
    },
    skills: [],
  });
}

function messageText(params: Parameters<A2ARequestHandler['sendMessage']>[0]) {
  const message = params.message;
  if (!message || message.role !== Role.ROLE_USER || !message.messageId) {
    fail({
      kind: 'invalid',
      detail: 'A user message with messageId is required.',
    });
  }
  if (
    message.parts.length === 0 ||
    message.parts.some((part) => part.content?.$case !== 'text')
  ) {
    fail({ kind: 'invalid', detail: 'Only text message parts are supported.' });
  }
  return {
    messageId: message.messageId,
    body: message.parts
      .map((part) => (part.content?.$case === 'text' ? part.content.value : ''))
      .join('\n'),
  };
}

function extensionMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function unsupported(): JsonRpcUnsupportedOperationError {
  return new JsonRpcUnsupportedOperationError({
    message: 'This optional operation is not supported.',
  });
}

function requestHandler(registry: WorkspaceRegistry): A2ARequestHandler {
  return {
    getAgentCard: async () => publicCard('http://localhost'),

    getAuthenticatedExtendedAgentCard: async (_params, context) => {
      const user = authenticated(context);
      const extended = await a2aAgentCardForCaller(
        user.projectRoot,
        user.caller,
        [user.agentId],
        user.baseUrl,
      );
      if (extended.skills.length === 0) {
        fail({ kind: 'refused' });
      }
      return card(extended);
    },

    sendMessage: async (params, context) => {
      const user = authenticated(context);
      const input = messageText(params);
      const metadata = extensionMetadata(
        params.metadata?.[QWEN_A2A_EXTENSION_URI],
      );
      const title =
        typeof metadata['title'] === 'string'
          ? metadata['title']
          : input.body.slice(0, 80);
      const acceptanceCriteria = metadata['acceptanceCriteria'];
      return task(
        unwrap(
          await a2aSendMessage(user.projectRoot, user.caller, {
            agentId: user.agentId,
            messageId: input.messageId,
            title,
            body: input.body,
            ...(typeof acceptanceCriteria === 'string'
              ? { acceptanceCriteria }
              : {}),
          }),
        ),
      );
    },

    getTask: async (params, context) => {
      const user = authenticated(context);
      return task(
        unwrap(await a2aGetTask(user.projectRoot, user.caller, params.id)),
      );
    },

    listTasks: async (params, context): Promise<ListTasksResponse> => {
      const user = authenticated(context);
      let tasks = unwrap(
        await a2aListTasks(user.projectRoot, user.caller, user.agentId),
      ).map(task);
      if (params.contextId) {
        tasks = tasks.filter((entry) => entry.contextId === params.contextId);
      }
      if (params.status !== TaskState.TASK_STATE_UNSPECIFIED) {
        tasks = tasks.filter((entry) => entry.status?.state === params.status);
      }
      const totalSize = tasks.length;
      const pageSize = params.pageSize ?? 50;
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
        fail({ kind: 'invalid', detail: 'Invalid pageSize.' });
      }
      const offset = params.pageToken ? Number(params.pageToken) : 0;
      if (!Number.isSafeInteger(offset) || offset < 0) {
        fail({ kind: 'invalid', detail: 'Invalid pageToken.' });
      }
      const page = tasks.slice(offset, offset + pageSize);
      return {
        tasks: page,
        nextPageToken:
          offset + page.length < totalSize ? String(offset + page.length) : '',
        pageSize,
        totalSize,
      };
    },

    cancelTask: async (params, context) => {
      const user = authenticated(context);
      const cancelled = unwrap(
        await a2aCancelTask(user.projectRoot, user.caller, params.id),
      );
      const result = task(cancelled.task);
      const metadata = extensionMetadata(
        result.metadata?.[QWEN_A2A_EXTENSION_URI],
      );
      result.metadata = {
        ...result.metadata,
        [QWEN_A2A_EXTENSION_URI]: {
          ...metadata,
          runsStillLive: cancelled.runsStillLive,
        },
      };
      return result;
    },

    sendMessageStream: async function* () {
      throw unsupported();
    },
    createTaskPushNotificationConfig: async () => {
      throw unsupported();
    },
    getTaskPushNotificationConfig: async () => {
      throw unsupported();
    },
    listTaskPushNotificationConfigs: async () => {
      throw unsupported();
    },
    deleteTaskPushNotificationConfig: async () => {
      throw unsupported();
    },
    resubscribe: async function* () {
      throw unsupported();
    },
  };
}

export function registerA2ATransportRoutes(
  app: Application,
  workspaceRegistry: WorkspaceRegistry,
): void {
  app.get(`/${A2A_AGENT_CARD_PATH}`, (req: Request, res: Response): void => {
    res.setHeader('A2A-Version', A2A_PROTOCOL_VERSION);
    res.setHeader('Content-Type', A2A_CONTENT_TYPE);
    res
      .status(200)
      .send(JSON.stringify(AgentCard.toJSON(publicCard(baseUrl(req)))));
  });

  app.use(
    A2A_PATH,
    (req: Request, res: Response, next: NextFunction): void => {
      if (req.is(A2A_CONTENT_TYPE)) {
        req.headers['content-type'] = 'application/json';
      }
      res.setHeader('A2A-Version', A2A_PROTOCOL_VERSION);
      res.setHeader('Content-Type', A2A_CONTENT_TYPE);
      next();
    },
    jsonRpcHandler({
      requestHandler: requestHandler(workspaceRegistry),
      userBuilder: (req) => buildUser(req, workspaceRegistry),
    }),
  );
}
