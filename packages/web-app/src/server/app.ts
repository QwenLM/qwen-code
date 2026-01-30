/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Config } from '@qwen-code/qwen-code-core';
import { sessionsRouter } from './routes/sessions.js';
import { configRouter } from './routes/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Create Express application
 */
export function createApp(config: Config | null) {
  const app = express();

  // JSON body parser
  app.use(express.json());

  // CORS middleware for development
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    // Allow localhost origins for development
    if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header(
        'Access-Control-Allow-Methods',
        'GET, POST, PUT, DELETE, OPTIONS',
      );
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.header('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });

  // Store config in app locals for routes to access
  app.locals.config = config;

  // API routes
  app.use('/api/sessions', sessionsRouter());
  app.use('/api/config', configRouter());

  // Health check
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Serve static files in production
  const staticDir = path.join(__dirname, '../../dist/client');
  app.use(express.static(staticDir));

  // SPA fallback
  app.get('*', (req, res, next) => {
    // Skip API routes
    if (req.path.startsWith('/api/') || req.path.startsWith('/ws')) {
      return next();
    }
    res.sendFile(path.join(staticDir, 'index.html'), (err) => {
      if (err) {
        // In development, the static files may not exist
        res.status(404).json({ error: 'Not found' });
      }
    });
  });

  return app;
}
