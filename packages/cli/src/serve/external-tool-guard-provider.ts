/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import * as http from 'node:http';
import * as https from 'node:https';
import type {
  ExternalToolGuardHandler,
  ExternalToolGuardPrepareRequest,
  ExternalToolGuardPrepareResult,
} from '@qwen-code/acp-bridge/bridgeOptions';
import {
  containsUnsafeExternalToolGuardControlCharacter,
  EXTERNAL_TOOL_GUARD_TOKEN_ENV,
  isValidExternalToolGuardDenialReason,
} from '@qwen-code/acp-bridge/externalToolGuard';

export const EXTERNAL_TOOL_GUARD_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_EXTERNAL_TOOL_GUARD_TIMEOUT_MS = 3000;
export const MIN_EXTERNAL_TOOL_GUARD_TIMEOUT_MS = 100;
export const MAX_EXTERNAL_TOOL_GUARD_TIMEOUT_MS = 30_000;

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;

export interface RequiredExternalToolGuardOptions {
  endpoint: string;
  token: string;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => allowed.has(key))
  );
}

function normalizeEndpoint(raw: unknown): URL {
  if (typeof raw !== 'string') {
    throw new TypeError(
      'Invalid external tool guard endpoint: expected an absolute loopback HTTP(S) origin.',
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new TypeError(
      'Invalid external tool guard endpoint: expected an absolute loopback HTTP(S) origin.',
    );
  }
  const hostname = endpoint.hostname.toLowerCase();
  if (
    (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') ||
    (hostname !== '127.0.0.1' &&
      hostname !== 'localhost' &&
      hostname !== '::1' &&
      hostname !== '[::1]') ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.pathname !== '/' ||
    endpoint.search !== '' ||
    endpoint.hash !== ''
  ) {
    throw new TypeError(
      'Invalid external tool guard endpoint: expected an origin-only loopback HTTP(S) URL.',
    );
  }
  return endpoint;
}

function normalizeToken(raw: unknown): string {
  if (
    typeof raw !== 'string' ||
    containsUnsafeExternalToolGuardControlCharacter(raw)
  ) {
    throw new TypeError(
      `Invalid ${EXTERNAL_TOOL_GUARD_TOKEN_ENV}: expected a non-blank token without control characters.`,
    );
  }
  const token = raw.trim();
  if (token.length === 0 || token.length > 8192) {
    throw new TypeError(
      `Invalid ${EXTERNAL_TOOL_GUARD_TOKEN_ENV}: expected a non-blank token without control characters.`,
    );
  }
  return token;
}

function normalizeTimeout(timeoutMs: unknown): number {
  const value = timeoutMs ?? DEFAULT_EXTERNAL_TOOL_GUARD_TIMEOUT_MS;
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < MIN_EXTERNAL_TOOL_GUARD_TIMEOUT_MS ||
    value > MAX_EXTERNAL_TOOL_GUARD_TIMEOUT_MS
  ) {
    throw new TypeError(
      `Invalid external tool guard timeout: expected an integer in [${MIN_EXTERNAL_TOOL_GUARD_TIMEOUT_MS}, ${MAX_EXTERNAL_TOOL_GUARD_TIMEOUT_MS}] ms.`,
    );
  }
  return value;
}

function validateHandshakeResponse(value: unknown, nonce: string): void {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['protocolVersion', 'nonce', 'capabilities']) ||
    value['protocolVersion'] !== EXTERNAL_TOOL_GUARD_PROTOCOL_VERSION ||
    value['nonce'] !== nonce ||
    !isRecord(value['capabilities']) ||
    !hasExactKeys(value['capabilities'], ['prepare']) ||
    value['capabilities']['prepare'] !== true
  ) {
    throw new Error('External tool guard handshake response is incompatible.');
  }
}

function validatePrepareResponse(
  value: unknown,
  requestId: string,
): ExternalToolGuardPrepareResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ['protocolVersion', 'requestId', 'allowed'],
      ['reason'],
    ) ||
    value['protocolVersion'] !== EXTERNAL_TOOL_GUARD_PROTOCOL_VERSION ||
    value['requestId'] !== requestId ||
    typeof value['allowed'] !== 'boolean'
  ) {
    throw new Error('External tool guard prepare response is invalid.');
  }
  if (value['allowed']) {
    if (Object.hasOwn(value, 'reason')) {
      throw new Error('External tool guard allow response contains a reason.');
    }
    return { allowed: true };
  }
  if (!Object.hasOwn(value, 'reason')) return { allowed: false };
  const reason = value['reason'];
  if (!isValidExternalToolGuardDenialReason(reason)) {
    throw new Error(
      'External tool guard denial response contains an unsafe reason.',
    );
  }
  return { allowed: false, reason };
}

/**
 * Small direct HTTP(S) client. It intentionally does not use global fetch:
 * Qwen's model proxy may install a process-global dispatcher, while this
 * security boundary must stay on the validated loopback origin and must not
 * inherit proxy routing or redirect behavior.
 */
export class RequiredExternalToolGuard {
  private readonly endpoint: URL;
  private readonly token: string;
  private readonly timeoutMs: number;
  private initialized = false;

  constructor(options: RequiredExternalToolGuardOptions) {
    this.endpoint = normalizeEndpoint(options.endpoint);
    this.token = normalizeToken(options.token);
    this.timeoutMs = normalizeTimeout(options.timeoutMs);
  }

  async initialize(): Promise<void> {
    const nonce = randomUUID();
    const response = await this.request('/v1/handshake', {
      protocolVersion: EXTERNAL_TOOL_GUARD_PROTOCOL_VERSION,
      nonce,
      client: 'qwen-code',
    });
    validateHandshakeResponse(response, nonce);
    this.initialized = true;
  }

  readonly prepare: ExternalToolGuardHandler = async (
    request: ExternalToolGuardPrepareRequest,
  ): Promise<ExternalToolGuardPrepareResult> => {
    if (!this.initialized) {
      throw new Error('External tool guard has not completed its handshake.');
    }
    const requestId = randomUUID();
    const response = await this.request('/v1/prepare', {
      protocolVersion: EXTERNAL_TOOL_GUARD_PROTOCOL_VERSION,
      requestId,
      sessionId: request.sessionId,
      promptId: request.promptId,
      toolCallId: request.toolCallId,
      toolName: request.toolName,
      arguments: request.arguments,
    });
    return validatePrepareResponse(response, requestId);
  };

  private request(pathname: string, value: unknown): Promise<unknown> {
    let body: Buffer;
    try {
      body = Buffer.from(JSON.stringify(value), 'utf8');
    } catch {
      return Promise.reject(
        new Error('External tool guard request is not JSON serializable.'),
      );
    }
    if (body.byteLength > MAX_REQUEST_BYTES) {
      return Promise.reject(
        new Error('External tool guard request exceeds the size limit.'),
      );
    }

    const transport = this.endpoint.protocol === 'https:' ? https : http;
    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, result?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      };
      const hostname = this.endpoint.hostname;
      const localhost = hostname.toLowerCase() === 'localhost';
      const request = transport.request(
        {
          protocol: this.endpoint.protocol,
          hostname: localhost
            ? '127.0.0.1'
            : hostname.startsWith('[') && hostname.endsWith(']')
              ? hostname.slice(1, -1)
              : hostname,
          port: this.endpoint.port || undefined,
          // A security boundary must not inherit a process-global Agent that
          // an embedding or dependency could have replaced with proxy logic.
          agent: false,
          ...(localhost && this.endpoint.protocol === 'https:'
            ? { servername: 'localhost' }
            : {}),
          method: 'POST',
          path: pathname,
          headers: {
            authorization: `Bearer ${this.token}`,
            'content-type': 'application/json',
            accept: 'application/json',
            host: this.endpoint.host,
            'content-length': String(body.byteLength),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let received = 0;
          response.on('data', (chunk: Buffer | string) => {
            const bytes = Buffer.isBuffer(chunk)
              ? chunk
              : Buffer.from(chunk, 'utf8');
            received += bytes.byteLength;
            if (received > MAX_RESPONSE_BYTES) {
              finish(
                new Error(
                  'External tool guard response exceeds the size limit.',
                ),
              );
              response.destroy();
              return;
            }
            chunks.push(bytes);
          });
          response.on('end', () => {
            if (response.statusCode !== 200) {
              finish(
                new Error(
                  `External tool guard returned HTTP ${response.statusCode ?? 'unknown'}.`,
                ),
              );
              return;
            }
            const contentType = response.headers['content-type'];
            if (
              typeof contentType !== 'string' ||
              !/^application\/json(?:\s*;|$)/iu.test(contentType)
            ) {
              finish(
                new Error(
                  'External tool guard returned a non-JSON content type.',
                ),
              );
              return;
            }
            try {
              finish(
                undefined,
                JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
              );
            } catch {
              finish(new Error('External tool guard returned malformed JSON.'));
            }
          });
          response.on('error', () => {
            finish(new Error('External tool guard response failed.'));
          });
          response.on('aborted', () => {
            finish(new Error('External tool guard response was aborted.'));
          });
        },
      );
      const timer = setTimeout(() => {
        request.destroy();
        finish(new Error('External tool guard request timed out.'));
      }, this.timeoutMs);
      timer.unref();
      request.on('error', () => {
        finish(new Error('External tool guard request failed.'));
      });
      request.end(body);
    });
  }
}
