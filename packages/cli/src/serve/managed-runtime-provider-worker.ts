/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { Application, Request, Response } from 'express';
import {
  Config,
  deriveConfig,
} from '@qwen-code/qwen-code-core/config/config.js';
import { ApprovalMode } from '@qwen-code/qwen-code-core/config/approval-mode.js';
import { ManagedToolRuntime } from '@qwen-code/qwen-code-core/tools/managed-tool-runtime.js';
import { ManagedToolFileHistory } from '@qwen-code/qwen-code-core/tools/managed-tool-file-history.js';
import {
  captureManagedToolExecutionContext,
  MANAGED_TOOL_FILE_HISTORY_MAX_BYTES,
  type ManagedToolFileHistoryBinding,
} from '@qwen-code/qwen-code-core/tools/managed-tool-file-history-protocol.js';
import {
  managedToolDigest,
  ManagedToolProtocolError,
} from '@qwen-code/qwen-code-core/tools/managed-tool-protocol.js';
import { ReadFileTool } from '@qwen-code/qwen-code-core/tools/read-file.js';
import { WriteFileTool } from '@qwen-code/qwen-code-core/tools/write-file.js';
import { EditTool } from '@qwen-code/qwen-code-core/tools/edit.js';
import { ShellTool } from '@qwen-code/qwen-code-core/tools/shell.js';
import type { AnyDeclarativeTool } from '@qwen-code/qwen-code-core/tools/tools.js';
import {
  registerSessionProjectDir,
  sessionIdContext,
  unregisterSessionProjectDir,
} from '@qwen-code/qwen-code-core/utils/sessionIdContext.js';
import {
  authorizeManagedRuntime,
  handleManagedRuntimeJsonError,
  managedRuntimeJsonBody,
  managedRuntimeNoStore,
  type ManagedRuntimeRequestIdentity,
} from './managed-runtime-attestation-contract.js';
import {
  MANAGED_RUNTIME_PROVIDER_ROUTE,
  managedRuntimeProviderLimit,
  ManagedRuntimeProviderProtocolError,
  parseManagedRuntimeProviderRequest,
  parseManagedRuntimeProviderResult,
  type ManagedRuntimeProviderOperation,
  type ManagedRuntimeProviderSession,
} from './managed-runtime-provider-protocol.js';
import {
  ManagedToolConflictError,
  ManagedToolUnavailableError,
  type ManagedToolExecutor,
} from './managed-runtime-tool-executor.js';

export interface ManagedRuntimeProviderContext {
  readonly directory: string;
  readonly workspaceRoot: string;
  readonly preapproved: boolean;
  readonly isActive?: () => boolean;
}

type ContextResolver = (
  sessionId: string,
) => Promise<ManagedRuntimeProviderContext | undefined>;

interface ProviderRuntime {
  readonly context: ManagedRuntimeProviderContext;
  readonly config: Config;
  readonly runtime: ManagedToolRuntime;
  readonly shell: AnyDeclarativeTool;
  history?: ManagedToolFileHistory;
  historyBinding?: string;
  turnStarted: boolean;
}

interface ProviderSession {
  readonly identity: ManagedRuntimeProviderSession;
  ready?: Promise<ProviderRuntime>;
  value?: ProviderRuntime;
  pending: number;
  closed: boolean;
  release?: Promise<boolean>;
}

function conflict(message: string): never {
  throw new ManagedToolConflictError(message);
}

function history(value: ProviderRuntime): ManagedToolFileHistory {
  return (
    value.history ?? conflict('Managed Runtime file history is not bound.')
  );
}

class ManagedRuntimeProviderWorker {
  private readonly sessions = new Map<string, ProviderSession>();
  private closing = false;

  constructor(
    private readonly executor: ManagedToolExecutor,
    private readonly contextFor: ContextResolver,
  ) {}

  hasActiveSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return (
      session !== undefined &&
      (session.pending > 0 || session.value?.runtime.hasActiveWork() === true)
    );
  }

  private lookup(identity: ManagedRuntimeProviderSession) {
    const session = this.sessions.get(identity.runtimeSessionId);
    if (
      session &&
      (session.identity.harnessSessionId !== identity.harnessSessionId ||
        session.identity.turnKind !== identity.turnKind)
    ) {
      conflict('Managed Runtime Session identity conflicts.');
    }
    return session;
  }

  async control(
    identity: ManagedRuntimeProviderSession,
    operation: ManagedRuntimeProviderOperation,
  ): Promise<unknown> {
    let session = this.lookup(identity);
    if (operation.kind === 'release') {
      if (session?.closed) return true;
      if (!session) {
        this.executor.closeSessionAdmission(identity.runtimeSessionId);
        this.sessions.set(identity.runtimeSessionId, {
          identity,
          closed: true,
          pending: 0,
        });
        return true;
      }
      if (session.release) return session.release;
      if (session.pending > 0)
        conflict('Managed Runtime Session still owns unfinished work.');
      const entry = session;
      entry.release = (async () => {
        await entry.value?.runtime.releasePrepared();
        this.executor.closeSessionAdmission(identity.runtimeSessionId);
        entry.closed = true;
        return true;
      })().catch((error: unknown) => {
        entry.release = undefined;
        throw error;
      });
      return entry.release;
    }
    if (operation.kind === 'acquire') {
      if (this.closing || session?.closed || session?.release)
        conflict('Managed Runtime Session is closed.');
      if (!session) {
        this.executor.claimProviderSession(identity.runtimeSessionId);
        session = { identity, closed: false, pending: 0 };
        this.sessions.set(identity.runtimeSessionId, session);
      }
      if (!session.ready) {
        const entry = session;
        entry.pending++;
        entry.ready = this.createRuntime(identity.runtimeSessionId)
          .then((value) => {
            entry.value = value;
            return value;
          })
          .catch((error: unknown) => {
            entry.ready = undefined;
            throw error;
          })
          .finally(() => {
            entry.pending--;
          });
      }
      await session.ready;
      return true;
    }
    if (!session?.ready)
      conflict('Managed Runtime Session has not been acquired.');
    const observes = ['status', 'cancel', 'history'].includes(operation.kind);
    if ((this.closing || session.closed || session.release) && !observes)
      conflict('Managed Runtime Session is closed.');
    session.pending++;
    try {
      const value = await session.ready;
      if (!observes) await this.assertContext(identity.runtimeSessionId, value);
      return await sessionIdContext.run(identity.runtimeSessionId, () =>
        this.dispatch(value, operation),
      );
    } finally {
      session.pending--;
    }
  }

  private async assertContext(sessionId: string, value: ProviderRuntime) {
    const context = await this.contextFor(sessionId);
    if (
      !context ||
      context.isActive?.() === false ||
      context.directory !== value.context.directory ||
      context.workspaceRoot !== value.context.workspaceRoot ||
      context.preapproved !== value.context.preapproved
    ) {
      throw new ManagedToolUnavailableError(
        'Managed context directory is unavailable.',
      );
    }
  }

  private async createRuntime(sessionId: string): Promise<ProviderRuntime> {
    const context = await this.contextFor(sessionId);
    if (!context || context.isActive?.() === false) {
      throw new ManagedToolUnavailableError(
        'Managed context directory is unavailable.',
      );
    }
    return sessionIdContext.run(sessionId, () => {
      const config = new Config({
        sessionId,
        targetDir: context.directory,
        cwd: context.directory,
        includeDirectories: [context.workspaceRoot],
        model: 'managed-runtime-worker',
        debugMode: false,
        usageStatisticsEnabled: false,
        approvalMode: context.preapproved
          ? ApprovalMode.YOLO
          : ApprovalMode.DEFAULT,
        fileCheckpointingEnabled: true,
        fileReadCacheDisabled: true,
      });
      const toolConfig = deriveConfig(config, {
        getFileHistoryService: () => history(value).service,
      });
      const shell = new ShellTool(toolConfig);
      const tools = [
        new ReadFileTool(toolConfig),
        new WriteFileTool(toolConfig),
        new EditTool(toolConfig),
        shell,
      ];
      const policyRevision = randomUUID();
      const runtime = new ManagedToolRuntime(
        toolConfig,
        () => tools,
        () => policyRevision,
        {
          prepareTurn: (identity) =>
            history(value).checkpoint(identity.promptId),
          execute: (action) => history(value).run(action),
        },
        (tool, media) => {
          if (tool.name !== ReadFileTool.Name)
            conflict('Managed Runtime tool does not support media context.');
          return new ReadFileTool(
            deriveConfig(toolConfig, {
              getEffectiveInputModalities: () => ({ ...media.inputModalities }),
              getFileReadCache: () => toolConfig.getFileReadCache(),
              getFileService: () => toolConfig.getFileService(),
            }),
          );
        },
      );
      const value: ProviderRuntime = {
        context,
        config,
        runtime,
        shell,
        turnStarted: false,
      };
      registerSessionProjectDir(sessionId, config.storage.getProjectDir());
      return value;
    });
  }

  private async bindHistory(
    value: ProviderRuntime,
    binding: ManagedToolFileHistoryBinding,
  ) {
    if (
      binding.executionCwd !== value.context.directory ||
      (binding.executionContext !== undefined &&
        managedToolDigest(binding.executionContext) !==
          managedToolDigest(captureManagedToolExecutionContext(value.config)))
    ) {
      conflict('Managed Runtime file history execution context conflicts.');
    }
    const digest = managedToolDigest(
      binding,
      MANAGED_TOOL_FILE_HISTORY_MAX_BYTES,
    );
    if (value.historyBinding !== undefined) {
      if (value.historyBinding !== digest)
        conflict('Managed Runtime file history binding conflicts.');
      await history(value).ready();
      return history(value).state();
    }
    if (value.turnStarted || value.runtime.hasActiveWork())
      conflict(
        'Managed Runtime file history must be bound before starting a turn.',
      );
    value.historyBinding = digest;
    value.history = new ManagedToolFileHistory(
      binding.ownerSessionId,
      value.context.directory,
      binding.snapshots,
    );
    await value.history.ready();
    return value.history.state();
  }

  private async dispatch(
    value: ProviderRuntime,
    operation: ManagedRuntimeProviderOperation,
  ): Promise<unknown> {
    const runtime = value.runtime;
    switch (operation.kind) {
      case 'manifest':
        return runtime.manifest();
      case 'begin-turn':
        await history(value).ready();
        value.turnStarted = true;
        await runtime.beginTurn(operation.identity);
        return null;
      case 'prepare': {
        if (operation.toolName === ShellTool.Name) {
          const normalized = structuredClone(operation.input);
          if (
            value.shell.validateToolParams(normalized) === null &&
            normalized['is_background'] === true
          )
            conflict(
              'Managed Runtime does not admit background shell execution.',
            );
        }
        return runtime.prepare(
          operation.identity,
          operation.toolName,
          operation.input,
          operation.modification,
          operation.mediaContext,
        );
      }
      case 'confirmation':
        return runtime.confirmation(operation.reference);
      case 'confirm':
        await runtime.confirm(
          operation.reference,
          operation.outcome,
          operation.payload,
          operation.phase,
        );
        return null;
      case 'preflight':
        return runtime.preflight(operation.reference);
      case 'execute':
        return runtime.execute(operation.reference);
      case 'status':
        return runtime.status(operation.reference, operation.afterSequence);
      case 'cancel': {
        const status = runtime.status(operation.reference);
        return status.state === 'settled'
          ? status
          : runtime.cancel(operation.reference);
      }
      case 'bind-history':
        return this.bindHistory(value, operation.binding);
      case 'checkpoint':
        if (runtime.hasActiveWork())
          conflict('Managed Runtime Session still owns unfinished work.');
        await history(value).checkpoint(operation.promptId);
        return history(value).state();
      case 'history':
        await history(value).drain();
        return history(value).state();
      case 'acquire':
      case 'release':
      default:
        throw new Error(
          'Managed Runtime Session operation was not dispatched.',
        );
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(
      [...this.sessions.values()].map(async (session) => {
        const value = await session.ready;
        await value?.runtime.dispose();
        await value?.history?.drain();
        unregisterSessionProjectDir(session.identity.runtimeSessionId);
      }),
    );
  }
}

export function registerManagedRuntimeProviderRoute(
  app: Application,
  identity: ManagedRuntimeRequestIdentity,
  executor: ManagedToolExecutor,
  contextFor: ContextResolver,
): void {
  const provider = new ManagedRuntimeProviderWorker(executor, contextFor);
  executor.attachProvider(provider);
  app.post(
    MANAGED_RUNTIME_PROVIDER_ROUTE.path,
    managedRuntimeNoStore,
    authorizeManagedRuntime(identity),
    managedRuntimeJsonBody(
      MANAGED_RUNTIME_PROVIDER_ROUTE.requestBodyLimitBytes,
    ),
    async (req: Request, res: Response) => {
      try {
        const request = parseManagedRuntimeProviderRequest(req.body);
        const result: unknown = JSON.parse(
          JSON.stringify(
            await provider.control(request.session, request.operation),
          ),
        );
        parseManagedRuntimeProviderResult(
          request.operation,
          result,
          request.session,
        );
        const response = {
          protocolVersion: request.protocolVersion,
          providerProtocol: request.providerProtocol,
          session: request.session,
          result,
        };
        const json = JSON.stringify(response);
        const limit = managedRuntimeProviderLimit(request.operation.kind);
        if (Buffer.byteLength(json) > limit) {
          res.status(413).json({
            code: 'managed_runtime_provider_too_large',
            error:
              'Managed Runtime provider response exceeds its body size limit.',
          });
          return;
        }
        res.status(200).type('application/json').send(json);
      } catch (error) {
        if (error instanceof ManagedRuntimeProviderProtocolError) {
          res
            .status(error.status)
            .json({ code: error.code, error: error.message });
        } else if (error instanceof ManagedToolProtocolError) {
          res.status(400).json({
            code: 'managed_runtime_provider_invalid',
            error: error.message,
          });
        } else {
          res.status(409).json({
            code:
              error instanceof ManagedToolUnavailableError
                ? error.code
                : 'managed_runtime_identity_conflict',
            error:
              error instanceof Error
                ? error.message
                : 'Managed Runtime provider operation failed.',
          });
        }
      }
    },
    handleManagedRuntimeJsonError,
  );
}
