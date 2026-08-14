/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const MIME_TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function resolveRendererAsset(
  rendererRoot: string,
  requestUrl: string,
): string | undefined {
  const url = new URL(requestUrl);
  if (url.protocol !== 'qwen-desktop:' || url.hostname !== 'app') {
    return undefined;
  }
  const encodedPath =
    requestUrl
      .slice(requestUrl.indexOf(url.host) + url.host.length)
      .split(/[?#]/, 1)[0] ?? '';
  let rawPath: string;
  try {
    rawPath = decodeURIComponent(encodedPath);
  } catch {
    return undefined;
  }
  if (rawPath.split('/').includes('..')) {
    return undefined;
  }
  const decoded = decodeURIComponent(url.pathname);
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const normalized = path.normalize(relative);
  if (path.isAbsolute(normalized) || normalized.startsWith('..')) {
    return undefined;
  }
  const candidate = path.join(rendererRoot, normalized);
  return candidate.startsWith(`${rendererRoot}${path.sep}`)
    ? candidate
    : undefined;
}

export async function rendererResponse(
  rendererRoot: string,
  requestUrl: string,
): Promise<Response> {
  const candidate = resolveRendererAsset(rendererRoot, requestUrl);
  if (!candidate) return new Response('Not found', { status: 404 });
  try {
    const body = await fs.readFile(candidate);
    return new Response(body, {
      headers: {
        'Content-Type':
          MIME_TYPES[path.extname(candidate).toLowerCase()] ??
          'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
