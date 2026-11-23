/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
  sendGenerationClosedError,
} from '../workspace-route-runtime.js';
import {
  appendWorkspaceInputHistory,
  isWorkspaceInputHistoryKind,
  MAX_WORKSPACE_INPUT_HISTORY_ENTRIES,
  MAX_WORKSPACE_INPUT_HISTORY_ENTRY_CHARS,
  readWorkspaceInputHistory,
  type WorkspaceInputHistoryKind,
} from '../workspace-input-history.js';
import { runWithWorkspaceRuntimeStorage } from '../workspace-runtime-storage.js';

export interface WorkspaceInputHistoryRouteDeps {
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  boundWorkspace: string;
  workspaceRegistry?: WorkspaceRegistry;
  captureGenerationAssertion?: () => (() => void) | undefined;
}

function parseHistoryKindQuery(
  req: Request,
  res: Response,
): WorkspaceInputHistoryKind | null {
  const raw = req.query['kind'];
  if (raw === undefined) return 'prompt';
  if (typeof raw !== 'string' || !isWorkspaceInputHistoryKind(raw)) {
    res.status(400).json({
      error: '`kind` must be "prompt" or "shell"',
      code: 'invalid_input_history_kind',
    });
    return null;
  }
  return raw;
}

function parseHistoryLimitQuery(req: Request, res: Response): number | null {
  const raw = req.query['limit'];
  if (raw === undefined) return MAX_WORKSPACE_INPUT_HISTORY_ENTRIES;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    res.status(400).json({
      error: `\`limit\` must be an integer between 1 and ${MAX_WORKSPACE_INPUT_HISTORY_ENTRIES}`,
      code: 'invalid_limit',
    });
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  if (parsed < 1 || parsed > MAX_WORKSPACE_INPUT_HISTORY_ENTRIES) {
    res.status(400).json({
      error: `\`limit\` must be an integer between 1 and ${MAX_WORKSPACE_INPUT_HISTORY_ENTRIES}`,
      code: 'invalid_limit',
    });
    return null;
  }
  return parsed;
}

function formatEtag(revision: string): string {
  return `"v1:${revision}"`;
}

function matchesIfNoneMatch(
  headerValue: string | undefined,
  etag: string,
): boolean {
  if (!headerValue) return false;
  return headerValue
    .split(',')
    .map((part) => part.trim())
    .some((tag) => {
      if (tag === '*') return true;
      const normalized = tag.startsWith('W/') ? tag.slice(2).trim() : tag;
      return normalized === etag;
    });
}

function parsePostPayload(
  body: Record<string, unknown>,
  res: Response,
): { kind: WorkspaceInputHistoryKind; entry: string } | null {
  const kind = body['kind'];
  if (!isWorkspaceInputHistoryKind(kind)) {
    res.status(400).json({
      error: '`kind` must be "prompt" or "shell"',
      code: 'invalid_input_history_kind',
    });
    return null;
  }
  const rawEntry = body['entry'];
  if (typeof rawEntry !== 'string') {
    res.status(400).json({
      error: '`entry` must be a non-empty string',
      code: 'invalid_entry',
    });
    return null;
  }
  const trimmed = rawEntry.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_WORKSPACE_INPUT_HISTORY_ENTRY_CHARS
  ) {
    res.status(400).json({
      error: `\`entry\` must be a non-empty string of at most ${MAX_WORKSPACE_INPUT_HISTORY_ENTRY_CHARS} characters`,
      code: 'invalid_entry',
    });
    return null;
  }
  return { kind, entry: trimmed };
}

async function handleGetInputHistory(
  req: Request,
  res: Response,
  workspaceCwd: string,
  assertGenerationOpen: () => void,
  routeLabel: string,
): Promise<void> {
  const kind = parseHistoryKindQuery(req, res);
  if (kind === null) return;
  const limit = parseHistoryLimitQuery(req, res);
  if (limit === null) return;
  try {
    assertGenerationOpen();
    const snapshot = await readWorkspaceInputHistory(workspaceCwd, kind, limit);
    assertGenerationOpen();
    const etag = formatEtag(snapshot.revision);
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'no-store');
    if (matchesIfNoneMatch(req.header('if-none-match'), etag)) {
      res.status(304).end();
      return;
    }
    res.status(200).json(snapshot);
  } catch (err) {
    if (sendGenerationClosedError(res, err)) return;
    writeStderrLine(
      `qwen serve: ${routeLabel} error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    res.status(500).json({
      error: 'Failed to load workspace input history',
      code: 'internal_error',
    });
  }
}

async function handlePostInputHistory(
  req: Request,
  res: Response,
  workspaceCwd: string,
  safeBody: (req: Request) => Record<string, unknown>,
  assertGenerationOpen: () => void,
  routeLabel: string,
): Promise<void> {
  const parsed = parsePostPayload(safeBody(req), res);
  if (parsed === null) return;
  try {
    assertGenerationOpen();
    const snapshot = await appendWorkspaceInputHistory(
      workspaceCwd,
      parsed.kind,
      parsed.entry,
    );
    assertGenerationOpen();
    if (!snapshot) {
      res.status(400).json({
        error: `\`entry\` must be a non-empty string of at most ${MAX_WORKSPACE_INPUT_HISTORY_ENTRY_CHARS} characters`,
        code: 'invalid_entry',
      });
      return;
    }
    res.setHeader('ETag', formatEtag(snapshot.revision));
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(snapshot);
  } catch (err) {
    if (sendGenerationClosedError(res, err)) return;
    writeStderrLine(
      `qwen serve: ${routeLabel} error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    res.status(500).json({
      error: 'Failed to save workspace input history',
      code: 'internal_error',
    });
  }
}

export function registerWorkspaceInputHistoryRoutes(
  app: Application,
  deps: WorkspaceInputHistoryRouteDeps,
): void {
  const { mutate, safeBody, boundWorkspace } = deps;

  app.get('/workspace/input-history', async (req: Request, res: Response) => {
    const fn = () => {
      const assertGenerationOpen =
        deps.captureGenerationAssertion?.() ?? (() => {});
      return handleGetInputHistory(
        req,
        res,
        boundWorkspace,
        assertGenerationOpen,
        'GET /workspace/input-history',
      );
    };
    try {
      const primaryRuntime = deps.workspaceRegistry?.primary;
      if (primaryRuntime) {
        await runWithWorkspaceRuntimeStorage(primaryRuntime, fn);
      } else {
        await fn();
      }
    } catch (err) {
      if (!sendGenerationClosedError(res, err)) throw err;
    }
  });

  app.post(
    '/workspace/input-history',
    mutate(),
    async (req: Request, res: Response) => {
      const fn = () => {
        const assertGenerationOpen =
          deps.captureGenerationAssertion?.() ?? (() => {});
        return handlePostInputHistory(
          req,
          res,
          boundWorkspace,
          safeBody,
          assertGenerationOpen,
          'POST /workspace/input-history',
        );
      };
      try {
        const primaryRuntime = deps.workspaceRegistry?.primary;
        if (primaryRuntime) {
          await runWithWorkspaceRuntimeStorage(primaryRuntime, fn);
        } else {
          await fn();
        }
      } catch (err) {
        if (!sendGenerationClosedError(res, err)) throw err;
      }
    },
  );

  if (deps.workspaceRegistry) {
    const workspaceRegistry = deps.workspaceRegistry;

    app.get(
      '/workspaces/:workspace/input-history',
      async (req: Request, res: Response) => {
        const runtime = resolveWorkspaceRuntimeFromParam(
          workspaceRegistry,
          req,
          res,
        );
        if (!runtime) return;
        if (!requireTrustedWorkspaceRuntime(runtime, res)) return;
        const assertGenerationOpen = () => {
          runtime.generationGuard?.assertOpen();
        };
        await runWithWorkspaceRuntimeStorage(runtime, () =>
          handleGetInputHistory(
            req,
            res,
            runtime.workspaceCwd,
            assertGenerationOpen,
            'GET /workspaces/:workspace/input-history',
          ),
        );
      },
    );

    app.post(
      '/workspaces/:workspace/input-history',
      mutate(),
      async (req: Request, res: Response) => {
        const runtime = resolveWorkspaceRuntimeFromParam(
          workspaceRegistry,
          req,
          res,
        );
        if (!runtime) return;
        if (!requireTrustedWorkspaceRuntime(runtime, res)) return;
        const assertGenerationOpen = () => {
          runtime.generationGuard?.assertOpen();
        };
        await runWithWorkspaceRuntimeStorage(runtime, () =>
          handlePostInputHistory(
            req,
            res,
            runtime.workspaceCwd,
            safeBody,
            assertGenerationOpen,
            'POST /workspaces/:workspace/input-history',
          ),
        );
      },
    );
  }
}
