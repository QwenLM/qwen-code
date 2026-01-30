/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Config } from '@qwen-code/qwen-code-core';
import type { Session, SessionsListResponse } from '../../shared/types.js';

/**
 * Get config from request app locals
 */
function getConfig(req: Request): Config | null {
  return req.app.locals.config as Config | null;
}

/**
 * Sessions API router
 */
export function sessionsRouter() {
  const router = Router();

  /**
   * GET /api/sessions - List all sessions
   */
  router.get('/', async (req: Request, res: Response) => {
    const config = getConfig(req);
    if (!config) {
      return res.status(500).json({ error: 'Configuration not available' });
    }

    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const offset = parseInt(req.query.offset as string) || 0;

      const sessionService = config.getSessionService();
      const result = await sessionService.listSessions({ size: limit });

      const response: SessionsListResponse = {
        sessions: result.items.map((s) => ({
          id: s.sessionId,
          title: s.prompt || 'Untitled Session',
          lastUpdated: new Date(s.mtime).toISOString(),
          startTime: s.startTime,
        })),
        hasMore: result.hasMore,
      };

      res.json(response);
    } catch (error) {
      console.error('Error listing sessions:', error);
      res.status(500).json({
        error: 'Failed to list sessions',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * POST /api/sessions - Create a new session
   */
  router.post('/', async (req: Request, res: Response) => {
    const config = getConfig(req);
    if (!config) {
      return res.status(500).json({ error: 'Configuration not available' });
    }

    try {
      const sessionId = config.startNewSession();

      const session: Session = {
        id: sessionId,
        title: 'New Session',
        lastUpdated: new Date().toISOString(),
      };

      res.status(201).json(session);
    } catch (error) {
      console.error('Error creating session:', error);
      res.status(500).json({
        error: 'Failed to create session',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * GET /api/sessions/:id - Get session details
   */
  router.get('/:id', async (req: Request, res: Response) => {
    const config = getConfig(req);
    if (!config) {
      return res.status(500).json({ error: 'Configuration not available' });
    }

    try {
      const sessionService = config.getSessionService();
      const session = await sessionService.loadSession(req.params.id);

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      res.json({
        id: session.conversation.sessionId,
        title: 'Untitled Session',
        messages: session.conversation.messages,
        lastUpdated: session.conversation.lastUpdated,
      });
    } catch (error) {
      console.error('Error loading session:', error);
      res.status(500).json({
        error: 'Failed to load session',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * DELETE /api/sessions/:id - Delete a session
   */
  router.delete('/:id', async (req: Request, res: Response) => {
    const config = getConfig(req);
    if (!config) {
      return res.status(500).json({ error: 'Configuration not available' });
    }

    try {
      const sessionService = config.getSessionService();
      const success = await sessionService.removeSession(req.params.id);

      if (!success) {
        return res.status(404).json({ error: 'Session not found' });
      }

      res.status(204).send();
    } catch (error) {
      console.error('Error deleting session:', error);
      res.status(500).json({
        error: 'Failed to delete session',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  return router;
}
