/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, RequestHandler, Response } from 'express';
import { redactLogCredentials } from '@qwen-code/acp-bridge/logRedaction';
import { sanitizeLogText } from '@qwen-code/channel-base';
import { normalizeServeChannelSelection } from '../channel-selection.js';
import {
  MAX_CHANNEL_STARTUP_FAILURES,
  MAX_CHANNEL_STARTUP_FAILURE_CHANNEL_LENGTH,
  MAX_CHANNEL_STARTUP_FAILURE_CODE_LENGTH,
  MAX_CHANNEL_STARTUP_FAILURE_MESSAGE_LENGTH,
} from '../channel-worker-startup-ipc.js';
import { normalizeWorkerDiagnostic } from '../channel-worker-diagnostics.js';
import type {
  ChannelWorkerControlState,
  ChannelWorkerSetResult,
  ChannelWorkerStopResult,
} from '../channel-worker-manager.js';
import type { ChannelWorkerSnapshot } from '../channel-worker-supervisor.js';
import type { SendBridgeError } from '../server/error-response.js';
import type { ServeChannelSelection } from '../types.js';

interface RegisterWorkspaceChannelControlRoutesDeps {
  getChannelWorkerControl: () => ChannelWorkerControlState;
  isDaemonDraining?: () => boolean;
  isManagerInitializing?: () => boolean;
  setChannelWorkerSelection?: (
    selection: ServeChannelSelection,
  ) => Promise<ChannelWorkerSetResult>;
  stopChannelWorker?: () => Promise<ChannelWorkerStopResult>;
  reloadChannelWorker?: () => Promise<ChannelWorkerSnapshot>;
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  safeBody: (req: Request) => Record<string, unknown>;
  sendBridgeError: SendBridgeError;
  parseAndValidateClientId: (
    req: Request,
    res: Response,
  ) => string | undefined | null;
}

function parseSelection(
  body: Record<string, unknown>,
  res: Response,
): ServeChannelSelection | undefined {
  const raw = body['selection'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    res.status(400).json({
      error: '`selection` must be an object.',
      code: 'invalid_channel_selection',
    });
    return undefined;
  }
  const selection = raw as Record<string, unknown>;
  if (selection['mode'] === 'all') {
    if (selection['names'] !== undefined) {
      res.status(400).json({
        error: '`names` cannot be used with selection mode `all`.',
        code: 'invalid_channel_selection',
      });
      return undefined;
    }
    return { mode: 'all' };
  }
  if (selection['mode'] !== 'names' || !Array.isArray(selection['names'])) {
    res.status(400).json({
      error: 'Selection must use mode `all` or a `names` array.',
      code: 'invalid_channel_selection',
    });
    return undefined;
  }
  if (!selection['names'].every((name) => typeof name === 'string')) {
    res.status(400).json({
      error: 'Every channel name must be a string.',
      code: 'invalid_channel_selection',
    });
    return undefined;
  }
  try {
    const normalized = normalizeServeChannelSelection(
      selection['names'] as string[],
    );
    if (!normalized || normalized.mode !== 'names') {
      throw new Error('At least one named channel is required.');
    }
    return normalized;
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : String(error),
      code: 'invalid_channel_selection',
    });
    return undefined;
  }
}

function sanitizeControlDiagnostic(value: string, maxLength: number): string {
  return sanitizeLogText(
    redactLogCredentials(normalizeWorkerDiagnostic(value)),
    maxLength,
  );
}

function startupFailureResponseFields(error: unknown): {
  startupFailures?: Array<{
    workspaceCwd: string;
    channel: string;
    phase: 'connect';
    code?: string;
    message: string;
  }>;
  startupFailuresTruncated?: boolean;
} {
  if (!error || typeof error !== 'object') return {};
  let rawFailures: unknown;
  let rawTruncated: unknown;
  try {
    rawFailures = Reflect.get(error, 'startupFailures');
    rawTruncated = Reflect.get(error, 'startupFailuresTruncated');
  } catch {
    return {};
  }
  if (!Array.isArray(rawFailures)) return {};
  let limitedFailures: unknown[];
  let rawFailureCount: number;
  try {
    limitedFailures = rawFailures.slice(0, MAX_CHANNEL_STARTUP_FAILURES);
    rawFailureCount = rawFailures.length;
  } catch {
    return {};
  }
  const startupFailures = limitedFailures.flatMap((raw) => {
    try {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
      const failure = raw as Record<string, unknown>;
      if (
        typeof failure['workspaceCwd'] !== 'string' ||
        failure['workspaceCwd'].length === 0 ||
        typeof failure['channel'] !== 'string' ||
        failure['channel'].length === 0 ||
        failure['phase'] !== 'connect' ||
        typeof failure['message'] !== 'string' ||
        failure['message'].length === 0 ||
        (failure['code'] !== undefined &&
          (typeof failure['code'] !== 'string' || failure['code'].length === 0))
      ) {
        return [];
      }
      const workspaceCwd = sanitizeControlDiagnostic(
        failure['workspaceCwd'],
        4096,
      );
      const channel = sanitizeControlDiagnostic(
        failure['channel'],
        MAX_CHANNEL_STARTUP_FAILURE_CHANNEL_LENGTH,
      );
      const message = sanitizeControlDiagnostic(
        failure['message'],
        MAX_CHANNEL_STARTUP_FAILURE_MESSAGE_LENGTH,
      );
      const code =
        typeof failure['code'] === 'string'
          ? sanitizeControlDiagnostic(
              failure['code'],
              MAX_CHANNEL_STARTUP_FAILURE_CODE_LENGTH,
            )
          : undefined;
      if (!workspaceCwd || !channel || !message) return [];
      return [
        {
          workspaceCwd,
          channel,
          phase: 'connect' as const,
          ...(code ? { code } : {}),
          message,
        },
      ];
    } catch {
      return [];
    }
  });
  if (startupFailures.length === 0) return {};
  const truncated =
    rawTruncated === true || rawFailureCount > MAX_CHANNEL_STARTUP_FAILURES;
  return {
    startupFailures,
    ...(truncated ? { startupFailuresTruncated: true } : {}),
  };
}

function sendChannelControlError(
  res: Response,
  error: unknown,
  getState: () => ChannelWorkerControlState,
): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  const message = redactLogCredentials(
    error instanceof Error ? error.message : String(error),
  );
  if (
    code === 'channel_workspace_mismatch' ||
    code === 'ambiguous_channel_workspace'
  ) {
    res.status(400).json({ error: message, code });
    return true;
  }
  if (code === 'untrusted_workspace') {
    res.status(403).json({ error: message, code });
    return true;
  }
  if (code === 'channel_service_conflict') {
    const conflict = error as { owner?: unknown; pid?: unknown };
    res.status(409).json({
      error: message,
      code,
      ...(typeof conflict.owner === 'string' ? { owner: conflict.owner } : {}),
      ...(typeof conflict.pid === 'number' ? { pid: conflict.pid } : {}),
    });
    return true;
  }
  if (code === 'daemon_draining') {
    res.status(503).json({
      error: message,
      code,
      state: getState(),
    });
    return true;
  }
  if (
    code !== 'channel_worker_not_enabled' &&
    code !== 'channel_worker_stop_failed' &&
    code !== 'channel_worker_start_failed'
  ) {
    return false;
  }
  const controlError = error as {
    rolledBack?: unknown;
    rollbackError?: unknown;
  };
  const status =
    code === 'channel_worker_not_enabled'
      ? 409
      : code === 'channel_worker_stop_failed'
        ? 500
        : 502;
  res.status(status).json({
    error: message,
    code,
    ...(typeof controlError.rolledBack === 'boolean'
      ? { rolledBack: controlError.rolledBack }
      : {}),
    ...(typeof controlError.rollbackError === 'string' &&
    controlError.rollbackError
      ? {
          rollbackError: sanitizeControlDiagnostic(
            controlError.rollbackError,
            512,
          ),
        }
      : {}),
    ...(code === 'channel_worker_start_failed'
      ? startupFailureResponseFields(error)
      : {}),
    state: getState(),
  });
  return true;
}

export function registerWorkspaceChannelControlRoutes(
  app: Application,
  deps: RegisterWorkspaceChannelControlRoutesDeps,
): void {
  const parseClient = (req: Request, res: Response): boolean =>
    deps.parseAndValidateClientId(req, res) !== null;

  app.get('/workspace/channel', (_req, res) => {
    res.status(200).json(deps.getChannelWorkerControl());
  });

  if (deps.setChannelWorkerSelection)
    app.put(
      '/workspace/channel',
      deps.mutate({ strict: true }),
      async (req, res) => {
        if (!parseClient(req, res)) return;
        if (deps.isDaemonDraining?.()) {
          res.status(503).json({
            error: 'Daemon is shutting down.',
            code: 'daemon_draining',
            state: deps.getChannelWorkerControl(),
          });
          return;
        }
        const selection = parseSelection(deps.safeBody(req), res);
        if (!selection) return;
        try {
          const result = await deps.setChannelWorkerSelection!(selection);
          const { created, ...response } = result;
          res.status(created === true ? 201 : 200).json(response);
        } catch (error) {
          if (
            sendChannelControlError(res, error, deps.getChannelWorkerControl)
          ) {
            return;
          }
          deps.sendBridgeError(res, error, { route: 'PUT /workspace/channel' });
        }
      },
    );

  if (deps.stopChannelWorker)
    app.delete(
      '/workspace/channel',
      deps.mutate({ strict: true }),
      async (req, res) => {
        if (!parseClient(req, res)) return;
        if (deps.isDaemonDraining?.()) {
          res.status(503).json({
            error: 'Daemon is shutting down.',
            code: 'daemon_draining',
            state: deps.getChannelWorkerControl(),
          });
          return;
        }
        try {
          res.status(200).json(await deps.stopChannelWorker!());
        } catch (error) {
          if (
            sendChannelControlError(res, error, deps.getChannelWorkerControl)
          ) {
            return;
          }
          deps.sendBridgeError(res, error, {
            route: 'DELETE /workspace/channel',
          });
        }
      },
    );

  if (deps.reloadChannelWorker) {
    app.post(
      '/workspace/channel/reload',
      deps.mutate({ strict: true }),
      async (req, res) => {
        if (!parseClient(req, res)) return;
        if (deps.isDaemonDraining?.()) {
          res.status(503).json({
            error: 'Daemon is shutting down.',
            code: 'daemon_draining',
            state: deps.getChannelWorkerControl(),
          });
          return;
        }
        if (
          !deps.isManagerInitializing?.() &&
          !deps.getChannelWorkerControl().enabled
        ) {
          res.status(409).json({
            error:
              'This daemon has no channel worker to reload. Set a runtime selection first.',
            code: 'channel_worker_not_enabled',
          });
          return;
        }
        try {
          const worker = await deps.reloadChannelWorker!();
          res.status(200).json({ reloaded: true, worker });
        } catch (error) {
          if (
            sendChannelControlError(res, error, deps.getChannelWorkerControl)
          ) {
            return;
          }
          deps.sendBridgeError(res, error, {
            route: 'POST /workspace/channel/reload',
          });
        }
      },
    );
  }
}
