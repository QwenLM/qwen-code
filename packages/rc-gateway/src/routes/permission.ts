/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import type {
  DaemonClient,
  PermissionResponse,
  PermissionOutcomeCancelled,
  PermissionOutcomeSelected,
} from '@qwen-code/sdk';
import type { AuditRecorder } from '../auditLog.js';

/** POST /rc/session/:id/permission/:requestId { outcome, optionId? } → vote. */
export function createPermissionVoteRoute(
  daemon: DaemonClient,
  audit?: AuditRecorder,
): RequestHandler {
  return async (req, res) => {
    const sessionId = req.params.id;
    const requestId = req.params.requestId;
    const body = (req.body ?? {}) as { outcome?: unknown; optionId?: unknown };

    let response: PermissionResponse;
    if (body.outcome === 'cancelled') {
      response = {
        outcome: { outcome: 'cancelled' } as PermissionOutcomeCancelled,
      };
    } else if (
      body.outcome === 'selected' &&
      typeof body.optionId === 'string' &&
      body.optionId.length > 0
    ) {
      response = {
        outcome: {
          outcome: 'selected',
          optionId: body.optionId,
        } as PermissionOutcomeSelected,
      };
    } else {
      res.status(400).json({ error: 'Invalid vote', code: 'invalid_vote' });
      return;
    }

    let accepted: boolean;
    try {
      accepted = await daemon.respondToSessionPermission(
        sessionId,
        requestId,
        response,
      );
    } catch {
      res
        .status(502)
        .json({ error: 'Daemon unavailable', code: 'daemon_unavailable' });
      return;
    }

    void audit?.record({
      action: 'permission_voted',
      actorTokenId: req.rcClient?.id,
      target: sessionId,
      shareId: req.rcClient?.shareId,
      shareLabel: req.rcClient?.shareLabel,
      detail: { requestId, outcome: body.outcome, accepted },
    });

    if (accepted) {
      res.status(200).json({ accepted: true });
    } else {
      res.status(404).json({
        error: 'No pending permission request',
        code: 'no_pending_permission',
      });
    }
  };
}
