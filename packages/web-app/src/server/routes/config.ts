/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Config } from '@qwen-code/qwen-code-core';

/**
 * Get config from request app locals
 */
function getConfig(req: Request): Config | null {
  return req.app.locals.config as Config | null;
}

/**
 * Config API router
 */
export function configRouter() {
  const router = Router();

  /**
   * GET /api/config - Get current configuration
   */
  router.get('/', (req: Request, res: Response) => {
    const config = getConfig(req);
    if (!config) {
      return res.status(500).json({ error: 'Configuration not available' });
    }

    try {
      const contentGeneratorConfig = config.getContentGeneratorConfig();

      res.json({
        model: contentGeneratorConfig?.model || 'unknown',
        workingDirectory: config.getProjectRoot(),
        theme: 'auto', // TODO: Get from settings
      });
    } catch (error) {
      console.error('Error getting config:', error);
      res.status(500).json({
        error: 'Failed to get configuration',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  /**
   * PUT /api/config/theme - Update theme setting
   */
  router.put('/theme', (req: Request, res: Response) => {
    const { theme } = req.body;

    if (!theme || !['light', 'dark', 'auto'].includes(theme)) {
      return res.status(400).json({ error: 'Invalid theme value' });
    }

    // TODO: Persist theme setting
    res.json({ theme });
  });

  return router;
}
