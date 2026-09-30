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
  type StreamResponse,
  type Task,
} from '@a2a-js/sdk';
import {
  A2AError,
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
import type {
  A2AAgentCard,
  A2ACaller,
  A2AFailure,
  A2ATaskView,
} from '@qwen-code/qwen-code-core';
import {
  A2A_AGENT_CARD_PATH,
  A2A_CONTENT_TYPE,
  A2A_PROTOCOL_VERSION,
  A2A_TRANSPORT_BINDING,
  QWEN_A2A_EXTENSION_URI,
} from '@qwen-code/qwen-code-core/agents/workspace-agents/a2a-contract.js';
import {
  a2aAgentCardForCaller,
  a2aCancelTask,
  a2aGetTask,
  a2aListTasks,
  a2aSendMessage,
} from '@qwen-code/qwen-code-core/agents/workspace-agents/a2a-server.js';
import { checkA2AGrant } from '@qwen-code/qwen-code-core/agents/workspace-agents/a2a-grants.js';
import type {
  Application,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from 'express';
import type { RateLimiterInstance } from '../rate-limit.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';
import { requireTrustedWorkspaceRuntime } from '../workspace-route-runtime.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';

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
    readonly assertCurrent: () => void,
  ) {}

  get userName(): string {
    return this.caller.callerId;
  }
}

type A2ARequest = Request & { a2aUser?: AuthenticatedA2AUser };

// `list()`, not `listAll()`: internal runtimes (live conversations) are not
// workspaces an external caller can name.
function runtimeFor(registry: WorkspaceRegistry, workspaceId: string) {
  return registry.list().find((runtime) => runtime.workspaceId === workspaceId);
}

function baseUrl(req: Request): string {
  return `${req.protocol}://${req.get('host') ?? '127.0.0.1'}`;
}

function rateLimitExceeded(res: Response): void {
  res.status(429).json({
    error: 'Rate limit exceeded',
    code: 'rate_limit_exceeded',
    tier: 'mutation',
  });
}

function authenticateA2A(
  registry: WorkspaceRegistry,
  rateLimiter?: Pick<RateLimiterInstance, 'checkRate'>,
  isEnabledFor?: (workspaceCwd: string) => boolean,
): RequestHandler {
  return async (request, res, next) => {
    const req = request as A2ARequest;
    if (
      rateLimiter &&
      !rateLimiter.checkRate(
        `a2a:preauth:${req.ip || req.socket.remoteAddress || 'unknown'}`,
        'mutation',
      )
    ) {
      rateLimitExceeded(res);
      return;
    }

    const authorization = /^Bearer ([A-Za-z0-9_-]{32,})$/.exec(
      req.get('authorization') ?? '',
    );
    const workspaceId = req.get(HEADER_WORKSPACE);
    const callerId = req.get(HEADER_CALLER);
    const agentId = req.get(HEADER_AGENT);
    const runtime = workspaceId ? runtimeFor(registry, workspaceId) : undefined;
    if (!authorization || !callerId || !agentId || !runtime) {
      next();
      return;
    }
    const generation = registry.getEntryByWorkspaceId(
      runtime.workspaceId,
    )?.current;
    // Trust first: the opt-in check below reads the workspace's settings, and
    // an unauthenticated request must not make the daemon read an untrusted
    // workspace's files.
    if (!requireTrustedWorkspaceRuntime(runtime, res)) return;
    // A workspace that has since opted out keeps its grants on disk; they
    // stop working with the rest of its collaboration surface.
    if (isEnabledFor !== undefined && !isEnabledFor(runtime.workspaceCwd)) {
      next();
      return;
    }
    const caller = { callerId, secret: authorization[1] };
    let grant: Awaited<ReturnType<typeof checkA2AGrant>>;
    try {
      grant = await checkA2AGrant(runtime.workspaceCwd, {
        ...caller,
        agentId,
      });
    } catch (error) {
      // Same boundary as the RPC methods: a damaged grant store is logged,
      // and the unauthenticated caller learns only that the request failed.
      writeStderrLine(
        `qwen serve: A2A authentication failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      res.status(500).json({ error: 'Internal error.' });
      return;
    }
    if (!grant.ok) {
      next();
      return;
    }
    if (
      rateLimiter &&
      !rateLimiter.checkRate(`a2a:caller:${callerId}`, 'mutation')
    ) {
      rateLimitExceeded(res);
      return;
    }
    const isCurrent = () => {
      const entry = registry.getEntryByWorkspaceId(runtime.workspaceId);
      return (
        entry?.state === 'active' &&
        entry.current === generation &&
        entry.current?.runtime === runtime &&
        !entry.current.guard.closed &&
        runtime.trusted &&
        (isEnabledFor?.(runtime.workspaceCwd) ?? true)
      );
    };
    if (!isCurrent()) {
      next();
      return;
    }
    req.a2aUser = new AuthenticatedA2AUser(
      runtime.workspaceCwd,
      caller,
      agentId,
      baseUrl(req),
      () => {
        if (!isCurrent()) fail({ kind: 'refused' });
      },
    );
    next();
  };
}

async function buildUser(req: Request): Promise<User> {
  return (req as A2ARequest).a2aUser ?? new UnauthenticatedUser();
}

function authenticated(context: ServerCallContext): AuthenticatedA2AUser {
  if (!(context.user instanceof AuthenticatedA2AUser)) {
    throw new JsonRpcRequestMalformedError({
      envelopeCode: REQUEST_REFUSED,
      message: 'Request refused.',
    });
  }
  context.user.assertCurrent();
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
    default: {
      // `A2AFailure` is a closed union, so this is unreachable today. It is
      // here so that adding a member is a compile error at the one place that
      // decides what a caller is told, rather than a silent fall-through that
      // returns success for a failure.
      const unreachable: never = failure;
      throw new Error(`Unmapped A2A failure: ${JSON.stringify(unreachable)}`);
    }
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
    // The agent's latest post, replaced as the thread moves on.
    artifacts: view.answer
      ? [
          {
            artifactId: 'answer',
            name: 'answer',
            description: '',
            parts: [
              {
                content: { $case: 'text', value: view.answer },
                metadata: undefined,
                filename: '',
                mediaType: 'text/plain',
              },
            ],
            metadata: undefined,
            extensions: [],
          },
        ]
      : [],
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
  if (message.taskId || message.contextId) {
    fail({
      kind: 'invalid',
      detail: 'Continuing an existing task or context is not supported.',
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

/**
 * The SDK answers any error that is not an A2A error with its own message, so
 * a store failure would hand an outside caller absolute paths and other
 * callers' thread ids. Those are logged here; the caller learns only that the
 * request failed.
 */
function withoutInternalDetail(handler: A2ARequestHandler): A2ARequestHandler {
  const methods = [
    'getAuthenticatedExtendedAgentCard',
    'sendMessage',
    'getTask',
    'listTasks',
    'cancelTask',
  ] as const;
  const wrapped: Record<string, unknown> = { ...handler };
  for (const name of methods) {
    const method = handler[name] as (...args: unknown[]) => Promise<unknown>;
    wrapped[name] = async (...args: unknown[]) => {
      try {
        return await method.apply(handler, args);
      } catch (error) {
        if (error instanceof A2AError) throw error;
        writeStderrLine(
          `qwen serve: A2A ${name} failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw new Error('Internal error.');
      }
    };
  }
  return wrapped as unknown as A2ARequestHandler;
}

function requestHandler(): A2ARequestHandler {
  return withoutInternalDetail({
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

    // Declared with the generator signature the interface requires, but it
    // refuses before yielding: the capability is advertised false, so a client
    // that follows the card never calls it, and one that ignores the card is
    // told rather than left waiting on a stream that will not come.
    sendMessageStream(): AsyncGenerator<StreamResponse, void, undefined> {
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
    resubscribe(): AsyncGenerator<StreamResponse, void, undefined> {
      throw unsupported();
    },
  });
}

export function registerA2ATransportRoutes(
  app: Application,
  workspaceRegistry: WorkspaceRegistry,
  rateLimiter?: Pick<RateLimiterInstance, 'checkRate'>,
  isEnabledFor?: (workspaceCwd: string) => boolean,
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
    authenticateA2A(workspaceRegistry, rateLimiter, isEnabledFor),
    (req: Request, res: Response, next: NextFunction): void => {
      if (req.is(A2A_CONTENT_TYPE)) {
        req.headers['content-type'] = 'application/json';
      }
      res.setHeader('A2A-Version', A2A_PROTOCOL_VERSION);
      res.setHeader('Content-Type', A2A_CONTENT_TYPE);
      next();
    },
    jsonRpcHandler({
      requestHandler: requestHandler(),
      userBuilder: buildUser,
    }),
  );
}
