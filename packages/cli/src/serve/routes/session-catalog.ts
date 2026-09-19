/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application } from 'express';
import { z } from 'zod';
import { parseSessionSource } from '@qwen-code/acp-bridge';
import { SessionOrganizationError } from '@qwen-code/qwen-code-core/services/session-organization-service.js';
import { runWithoutDebugLogSession } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import type { SessionGroupCatalog } from '@qwen-code/qwen-code-core';
import {
  InvalidCursorError,
  listWorkspaceSessionsForResponse,
  type ListWorkspaceSessionsResult,
} from '../server/session-list.js';
import { createSessionOrganizationService } from '../session-organization-helpers.js';
import type {
  WorkspaceEntry,
  WorkspaceRegistry,
} from '../workspace-registry.js';
import {
  isGenerationClosedError,
  resolveWorkspaceEntryBySelector,
} from '../workspace-route-runtime.js';
import { runWithWorkspaceRuntimeStorage } from '../workspace-runtime-storage.js';

const MAX_WORKSPACES = 20;
const READ_CONCURRENCY = 4;
const MAX_MEMBER_BYTES = 512 * 1024;

const catalogRequestSchema = z
  .object({
    workspaces: z.union([
      z.literal('all'),
      z
        .array(
          z
            .object({
              workspace: z.string().min(1).max(4096),
              cursor: z.string().max(16384).optional(),
            })
            .strict(),
        )
        .min(1)
        .max(MAX_WORKSPACES),
    ]),
    options: z
      .object({
        size: z.number().int().min(1).max(100).optional(),
        archiveState: z.enum(['active', 'archived']).optional(),
        view: z.literal('organized').optional(),
        group: z.string().min(1).max(256).optional(),
        parentSessionId: z.string().min(1).max(256).optional(),
        sourceType: z.string().optional(),
        sourceId: z.string().optional(),
      })
      .strict()
      .optional(),
    includeGroups: z.boolean().optional(),
  })
  .strict();

interface CatalogMemberIdentity {
  workspace: string;
  workspaceId?: string;
  cwd?: string;
}

type CatalogMember = CatalogMemberIdentity &
  (
    | (ListWorkspaceSessionsResult & { groups?: SessionGroupCatalog })
    | { error: { code: string; message: string; status: number } }
  );

function failedMember(
  workspace: string,
  entry: WorkspaceEntry | undefined,
  status: number,
  code: string,
  message: string,
): CatalogMember {
  return {
    workspace,
    ...(entry
      ? { workspaceId: entry.workspaceId, cwd: entry.workspaceCwd }
      : {}),
    error: { code, message, status },
  };
}

export function registerSessionCatalogRoutes(
  app: Application,
  workspaceRegistry: WorkspaceRegistry,
): void {
  app.post('/sessions/catalog', async (req, res) => {
    const parsed = catalogRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        code: 'invalid_session_catalog_request',
        error: 'Invalid session catalog request.',
      });
      return;
    }
    const { options = {}, includeGroups = false } = parsed.data;
    const source = parseSessionSource(options.sourceType, options.sourceId);
    if (
      'error' in source ||
      (options.group !== undefined && options.view !== 'organized') ||
      (options.parentSessionId !== undefined && options.view === 'organized')
    ) {
      res.status(400).json({
        code: 'invalid_session_catalog_request',
        error:
          'error' in source
            ? source.error
            : 'Group filters require organized view; parent filters cannot use it.',
      });
      return;
    }
    const selections =
      parsed.data.workspaces === 'all'
        ? workspaceRegistry.listEntries().map((entry) => ({
            workspace: entry.workspaceCwd,
            cursor: undefined,
          }))
        : parsed.data.workspaces;
    if (selections.length > MAX_WORKSPACES) {
      res.status(400).json({
        code: 'too_many_workspaces',
        error: `Select at most ${MAX_WORKSPACES} workspaces per request.`,
      });
      return;
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    const onClose = () => {
      if (!res.writableEnded) abort();
    };
    req.once('aborted', abort);
    res.once('close', onClose);
    if (req.aborted || res.destroyed) abort();

    const readMember = async (
      selection: (typeof selections)[number],
    ): Promise<CatalogMember> => {
      const { workspace, cursor } = selection;
      const entry = resolveWorkspaceEntryBySelector(
        workspaceRegistry,
        workspace,
      );
      if (!entry) {
        return failedMember(
          workspace,
          undefined,
          404,
          'workspace_not_found',
          'Workspace is not registered with this daemon.',
        );
      }
      const unavailable = () =>
        failedMember(
          workspace,
          entry,
          503,
          'workspace_runtime_unavailable',
          'Workspace runtime is not active.',
        );
      const generation = entry.current;
      const isCurrent = () =>
        workspaceRegistry.getEntryByWorkspaceId(entry.workspaceId) === entry &&
        entry.state === 'active' &&
        entry.current === generation &&
        generation !== undefined &&
        !generation.guard.closed;
      if (!generation || !isCurrent()) return unavailable();
      const runtime = generation.runtime;
      if (runtime.primary && !runtime.trusted) {
        return failedMember(
          workspace,
          entry,
          403,
          'untrusted_workspace',
          'Workspace is not trusted.',
        );
      }
      try {
        const read = () =>
          runWithWorkspaceRuntimeStorage(runtime, async () => {
            const page = await listWorkspaceSessionsForResponse(
              runtime.bridge,
              runtime.workspaceCwd,
              { ...options, cursor },
              {
                mergeLive: runtime.trusted,
                paginateMerged: true,
                runtimeBaseDir: runtime.sessionRuntimeBaseDir,
                signal: controller.signal,
              },
            );
            controller.signal.throwIfAborted();
            if (!isCurrent()) return page;
            const groups = includeGroups
              ? await createSessionOrganizationService(
                  runtime.workspaceCwd,
                ).listGroups()
              : undefined;
            return { ...page, ...(groups ? { groups } : {}) };
          });
        const page = await (runtime.trusted
          ? read()
          : runWithoutDebugLogSession(read));
        if (!isCurrent()) return unavailable();
        const result: CatalogMember = {
          workspace,
          workspaceId: runtime.workspaceId,
          cwd: runtime.workspaceCwd,
          ...page,
          sessions: page.sessions.map((session) => ({
            ...session,
            workspaceCwd: runtime.workspaceCwd,
          })),
        };
        if (Buffer.byteLength(JSON.stringify(result)) > MAX_MEMBER_BYTES) {
          return failedMember(
            workspace,
            entry,
            413,
            'catalog_response_too_large',
            'Catalog page exceeds 512 KiB; reduce size or omit groups.',
          );
        }
        return result;
      } catch (error) {
        if (isGenerationClosedError(error) || !isCurrent())
          return unavailable();
        const known =
          error instanceof InvalidCursorError ||
          error instanceof SessionOrganizationError;
        const code =
          error instanceof InvalidCursorError
            ? 'invalid_cursor'
            : error instanceof SessionOrganizationError
              ? error.code
              : 'session_catalog_failed';
        const status =
          code === 'group_not_found'
            ? 404
            : known && code !== 'session_organization_store_unreadable'
              ? 400
              : 500;
        return failedMember(
          workspace,
          entry,
          status,
          code,
          known ? error.message : 'Failed to read workspace session catalog.',
        );
      }
    };

    const workspaces: CatalogMember[] = new Array(selections.length);
    let nextIndex = 0;
    try {
      await Promise.all(
        Array.from(
          { length: Math.min(READ_CONCURRENCY, selections.length) },
          async () => {
            while (
              !controller.signal.aborted &&
              nextIndex < selections.length
            ) {
              const index = nextIndex++;
              workspaces[index] = await readMember(selections[index]!);
            }
          },
        ),
      );
      if (!controller.signal.aborted) res.status(200).json({ workspaces });
    } finally {
      req.off('aborted', abort);
      res.off('close', onClose);
    }
  });
}
