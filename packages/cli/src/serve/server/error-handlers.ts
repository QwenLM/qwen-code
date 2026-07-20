/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import type { Application, NextFunction, Request, Response } from 'express';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { sendJsonBodyParserError } from './request-helpers.js';

export function installJsonBodyParser(app: Application): void {
  app.use(express.json({ limit: '10mb' }));
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (sendJsonBodyParserError(res, err)) return;
    next(err);
  });
}

function isMalformedRouteEncoding(err: unknown): boolean {
  if (!(err instanceof URIError)) return false;
  const status = (err as { status?: unknown; statusCode?: unknown }).status;
  const statusCode = (err as { statusCode?: unknown }).statusCode;
  return status === 400 || statusCode === 400;
}

export function installFinalErrorHandler(app: Application): void {
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (sendJsonBodyParserError(res, err)) return;
    if (isMalformedRouteEncoding(err)) {
      res.status(400).json({
        error: 'Malformed URL encoding',
        code: 'invalid_request',
      });
      return;
    }
    writeStderrLine(
      `qwen serve: unhandled error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  });
}
