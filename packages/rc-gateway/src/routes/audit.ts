/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RequestHandler } from 'express';
import {
  AUDIT_ACTIONS,
  type AuditAction,
  type AuditQuery,
  type AuditReader,
} from '../auditLog.js';

/** GET /rc/audit?limit&since&action&actor → newest-first audit records. */
export function createAuditQueryRoute(reader: AuditReader): RequestHandler {
  return async (req, res) => {
    const q: AuditQuery = {};

    const limit = Number(req.query.limit);
    if (Number.isFinite(limit) && limit >= 1) q.limit = Math.trunc(limit);

    const since = Number(req.query.since);
    if (req.query.since !== undefined && Number.isFinite(since))
      q.since = since;

    const action = req.query.action;
    if (
      typeof action === 'string' &&
      (AUDIT_ACTIONS as readonly string[]).includes(action)
    ) {
      q.action = action as AuditAction;
    }

    const actor = req.query.actor;
    if (typeof actor === 'string' && actor.length > 0) q.actor = actor;

    const rows = await reader.query(q);
    res.status(200).json(rows);
  };
}
