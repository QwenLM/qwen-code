/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

const LOCAL_HTTP_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost):\d+$/u;

export function createServerToken(): string {
  return randomBytes(32).toString('base64url');
}

export function getSingleHeader(
  value: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

export function getBearerToken(
  authorization: string | string[] | undefined,
): string | undefined {
  const header = getSingleHeader(authorization);
  if (!header) {
    return undefined;
  }

  const parts = header.trim().split(/\s+/u);
  if (parts.length !== 2) {
    return undefined;
  }

  const [scheme, token] = parts;
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return undefined;
  }

  return token;
}

export function isAuthorized(
  headers: IncomingHttpHeaders,
  expectedToken: string,
): boolean {
  const token = getBearerToken(headers.authorization);
  if (!token) {
    return false;
  }

  return safeEqual(token, expectedToken);
}

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin || origin === 'null' || origin.startsWith('file://')) {
    return true;
  }

  return LOCAL_HTTP_ORIGIN.test(origin);
}

export function createCorsHeaders(
  origin: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };

  if (origin && isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }

  return headers;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}
