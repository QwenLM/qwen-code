/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Session, SessionsListResponse } from '../../shared/types.js';
import { SessionService } from '@qwen-code/qwen-code-core';
import { createSession, removeSession } from '../sessionManager.js';

/**
 * Sessions API router
 */
export function sessionsRouter() {
  const router = Router();
  const cwd = process.cwd();
  const sessionService = new SessionService(cwd);

  /**
   * GET /api/sessions - List all sessions
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string, 10) || 50;

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
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error listing sessions:', message);

      // If configuration is not available, return empty list instead of error
      if (
        message.includes('Configuration not available') ||
        message.includes('not found')
      ) {
        return res.json({ sessions: [], hasMore: false });
      }

      res.status(500).json({
        error: 'Failed to list sessions',
        message,
      });
    }
  });

  /**
   * POST /api/sessions - Create a new session
   */
  router.post('/', async (_req: Request, res: Response) => {
    try {
      const runner = await createSession(cwd);
      const sessionId = runner.getSessionId();

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
    try {
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
    try {
      const success = await sessionService.removeSession(req.params.id);

      if (!success) {
        return res.status(404).json({ error: 'Session not found' });
      }

      removeSession(req.params.id);

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
