/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type { Application, Request, Response, RequestHandler } from 'express';
import { SERVE_CONTROL_EXT_METHODS } from '@qwen-code/acp-bridge/status';
import type { MemoryImportBatchProposal } from '@qwen-code/qwen-code-core/memory/import-model.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import { runWithMemoryProjectScope } from '@qwen-code/qwen-code-core/memory/paths.js';
import {
  previewSource,
  MemoryImportRequestError,
} from '../memory-import/source.js';
import {
  MemoryImportService,
  MemoryImportNotFoundError,
} from '../memory-import/service.js';
import { runWithWorkspaceRuntimeStorage } from './workspace-runtime-storage.js';
import {
  resolveTrustedRuntime,
  sendGenerationClosedError,
} from './workspace-route-runtime.js';
import { WorkspaceGenerationClosedError } from './workspace-registry.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from './workspace-registry.js';

const debugLogger = createDebugLogger('MEMORY_IMPORT');

class MemoryImportRecoveryError extends Error {}

export function mountMemoryImportRoutes(
  app: Application,
  deps: {
    workspaceRegistry: WorkspaceRegistry;
    mutate: (opts?: { strict?: boolean }) => RequestHandler;
  },
): void {
  const services = new WeakMap<WorkspaceRuntime, MemoryImportService>();
  const recoveries = new WeakMap<WorkspaceRuntime, Promise<void>>();
  function active(runtime: WorkspaceRuntime): void {
    const entry = deps.workspaceRegistry.getEntryByWorkspaceId(
      runtime.workspaceId,
    );
    if (
      !entry ||
      entry.state !== 'active' ||
      entry.current?.runtime !== runtime ||
      !runtime.trusted ||
      runtime.routeFileSystemFactory.sshWorkspace
    )
      throw new WorkspaceGenerationClosedError(
        'Workspace memory import is unavailable.',
      );
    entry.current.guard.assertOpen();
    // These legacy process-global overrides cannot safely describe a selected
    // runtime with different memory settings. Refuse rather than use primary.
    for (const key of ['QWEN_CODE_MEMORY_BASE_DIR', 'QWEN_CODE_MEMORY_LOCAL']) {
      if ((runtime.env.effectiveEnv?.[key] ?? process.env[key]) !== undefined)
        throw new MemoryImportRequestError(
          'Memory import does not support legacy memory path overrides.',
        );
    }
  }
  function withRuntime<T>(runtime: WorkspaceRuntime, run: () => T): T {
    const configured =
      runtime.env.effectiveEnv !== undefined
        ? runtime.env.effectiveEnv['QWEN_CODE_MEMORY_PROJECT_SCOPE']
        : runtime.env.mode === 'parent-process'
          ? process.env['QWEN_CODE_MEMORY_PROJECT_SCOPE']
          : undefined;
    const scope =
      configured?.trim().toLowerCase() === 'workspace'
        ? 'workspace'
        : 'git-root';
    return runWithWorkspaceRuntimeStorage(runtime, () =>
      runWithMemoryProjectScope(scope, run),
    );
  }
  async function service(
    runtime: WorkspaceRuntime,
  ): Promise<MemoryImportService> {
    active(runtime);
    let value = services.get(runtime);
    if (!value) {
      value = new MemoryImportService({
        projectRoot: runtime.workspaceCwd,
        assertActive: () => active(runtime),
        propose: async (input, signal) => {
          signal.throwIfAborted();
          active(runtime);
          const response =
            await runtime.bridge.invokeWorkspaceCommand<MemoryImportBatchProposal>(
              SERVE_CONTROL_EXT_METHODS.workspaceMemoryImportPlan,
              { ...input },
              { timeoutMs: 130_000 },
            );
          signal.throwIfAborted();
          active(runtime);
          return response;
        },
      });
      services.set(runtime, value);
    }
    let recovery = recoveries.get(runtime);
    if (!recovery) {
      recovery = value.recover().catch((cause: unknown) => {
        recoveries.delete(runtime);
        debugLogger.warn('Workspace memory import recovery failed.', cause);
        throw new MemoryImportRecoveryError(
          'Memory import recovery is unavailable.',
          { cause },
        );
      });
      recoveries.set(runtime, recovery);
    }
    await recovery;
    return value;
  }
  const handle =
    (
      action: (
        req: Request,
        runtime: WorkspaceRuntime,
      ) => Promise<unknown> | unknown,
      status = 200,
    ): RequestHandler =>
    async (req, res) => {
      res.set('Cache-Control', 'no-store');
      const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
      if (!runtime) return;
      try {
        active(runtime);
        const result = await withRuntime(runtime, () => action(req, runtime));
        // Admission already persisted a 202 receipt; closing afterward must not
        // hide its task ID. Reads still recheck access before returning content.
        if (status !== 202) active(runtime);
        res.status(status).json(result);
      } catch (error) {
        sendError(res, error);
      }
    };
  const assertManagedMemoryAvailable = async (
    runtime: WorkspaceRuntime,
  ): Promise<void> => {
    if (!(await runtime.bridge.isWorkspaceMemoryRememberAvailable()))
      throw new MemoryImportRequestError(
        'Managed memory import is unavailable.',
      );
  };
  const base = '/workspaces/:workspace/memory/import';
  app.post(
    `${base}/preview`,
    deps.mutate({ strict: true }),
    handle((req) => previewSource(req.body)),
  );
  app.post(
    `${base}/batches`,
    deps.mutate({ strict: true }),
    handle(async (req, runtime) => {
      await assertManagedMemoryAvailable(runtime);
      return (await service(runtime)).submit(
        req.body?.source,
        req.body?.selection,
        req.body?.idempotencyKey,
      );
    }, 202),
  );
  app.get(
    `${base}/batches`,
    handle(async (_req, runtime) => (await service(runtime)).list()),
  );
  app.get(
    `${base}/batches/:batch`,
    handle(async (req, runtime) =>
      (await service(runtime)).get(String(req.params['batch'])),
    ),
  );
  app.get(
    `${base}/batches/:batch/sources/:section`,
    handle(async (req, runtime) =>
      (await service(runtime)).source(
        String(req.params['batch']),
        String(req.params['section']),
      ),
    ),
  );
  app.post(
    `${base}/batches/:batch/cancel`,
    deps.mutate({ strict: true }),
    handle(async (req, runtime) =>
      (await service(runtime)).cancel(String(req.params['batch'])),
    ),
  );
  app.post(
    `${base}/batches/:batch/retry`,
    deps.mutate({ strict: true }),
    handle(async (req, runtime) => {
      await assertManagedMemoryAvailable(runtime);
      return (await service(runtime)).retry(String(req.params['batch']));
    }, 202),
  );
  // Recover registered trusted runtimes at daemon startup; later runtimes recover
  // on their first import request. No source/model work occurs for previews.
  for (const runtime of deps.workspaceRegistry.list()) {
    void withRuntime(runtime, () => service(runtime)).catch(() => {
      // Recovery failures are logged and retried by the next import request.
      // Unsupported runtimes stay unavailable.
    });
  }
}
function sendError(res: Response, error: unknown): void {
  if (error instanceof MemoryImportRecoveryError) {
    res.set('Retry-After', '1');
    res.status(503).json({
      code: 'memory_import_recovery_unavailable',
      error: 'Import recovery failed. Check workspace storage and retry.',
    });
    return;
  }
  if (sendGenerationClosedError(res, error)) return;
  if (error instanceof MemoryImportNotFoundError) {
    res.status(404).json({
      code: 'memory_import_not_found',
      error: 'Import batch not found.',
    });
    return;
  }
  if (error instanceof MemoryImportRequestError) {
    res.status(400).json({
      code: 'memory_import_rejected',
      error: error.message,
    });
    return;
  }
  debugLogger.warn('Workspace memory import request failed.', error);
  res.status(500).json({
    code: 'memory_import_failed',
    error:
      'Import request failed. Check daemon logs and retry using the same idempotency key or batch ID.',
  });
}
