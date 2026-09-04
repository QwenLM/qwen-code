/**
 * HTTP server for the qwen-code stats dashboard.
 * Serves API endpoints and static SPA assets via Node.js http.createServer.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDashboardStats, getByFolderStats, getByModelStats, getTimeSeries, getToolStats } from './aggregator.js';
import type { TimeRange } from './aggregator.js';
import { closeDb } from './db.js';
import { syncAllSessions } from './sync-worker.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const STATIC_DIR = join(__dirname, '..', 'dist', 'client');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// ---------------------------------------------------------------------------
// API handler
// ---------------------------------------------------------------------------

async function handleApi(pathname: string, range: TimeRange, method: string, body?: string): Promise<{ status: number; data: unknown }> {
  if (pathname === '/api/stats') {
    return { status: 200, data: getDashboardStats(range) };
  }

  if (pathname === '/api/stats/models') {
    return { status: 200, data: getByModelStats(range) };
  }

  if (pathname === '/api/stats/folders') {
    return { status: 200, data: getByFolderStats(range) };
  }

  if (pathname === '/api/stats/timeseries') {
    return { status: 200, data: getTimeSeries(range) };
  }

  if (pathname === '/api/stats/tools') {
    return { status: 200, data: getToolStats(range) };
  }

  if (pathname === '/api/sync' && method === 'POST') {
    const result = await syncAllSessions();
    return { status: 200, data: result };
  }

  return { status: 404, data: 'Not Found' };
}

// ---------------------------------------------------------------------------
// Static file handler with SPA fallback
// ---------------------------------------------------------------------------

async function serveStatic(requestPath: string, res: ServerResponse): Promise<void> {
  const filePath = requestPath === '/' ? '/index.html' : requestPath;
  const fullPath = join(STATIC_DIR, filePath);

  try {
    const info = await stat(fullPath);
    if (info.isFile()) {
      const ext = extname(fullPath);
      const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
      const content = await readFile(fullPath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
      return;
    }
  } catch {
    // File not found — fall through to SPA fallback
  }

  // SPA fallback: serve index.html for non-file routes
  try {
    const indexPath = join(STATIC_DIR, 'index.html');
    const content = await readFile(indexPath);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
}

// ---------------------------------------------------------------------------
// Request body reader
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// CORS headers
// ---------------------------------------------------------------------------

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function setCorsHeaders(res: ServerResponse): void {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    res.setHeader(key, value);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function startServer(
  port = 3848,
): Promise<{ port: number; stop: () => void }> {
  const server = createServer(async (req, res) => {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const pathname = url.pathname;
    const range = (url.searchParams.get('range') as TimeRange) || '24h';

    try {
      if (pathname.startsWith('/api/')) {
        const body = req.method === 'POST' ? await readBody(req) : undefined;
        const result = await handleApi(pathname, range, req.method ?? 'GET', body);
        res.writeHead(result.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(typeof result.data === 'string' ? result.data : JSON.stringify(result.data));
      } else {
        await serveStatic(pathname, res);
      }
    } catch (error) {
      console.error('Server error:', error);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        error: error instanceof Error ? error.message : 'Unknown error',
      }));
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(
          `Port ${port} is already in use. Use --port to specify a different port.`,
        ));
      } else {
        reject(err);
      }
    });

    server.listen(port, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        port: actualPort,
        stop: () => {
          server.close();
          closeDb();
        },
      });
    });
  });
}
