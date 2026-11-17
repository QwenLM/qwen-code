/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview `session_send` relay on a Host daemon (session-multi-agent design §9.3).
 *
 * A Claude / Codex turn running on a Host gets a stdio MCP server
 * (`qwen agents session-send-mcp --url <relay>`) that posts the agent's
 * outbound message here, over loopback. The handler pushes it into that run's
 * event stream as a `session_send` event, which the Host forwards to the
 * coordinator with the rest of the run's events.
 *
 * Wire contract (the MCP command must match):
 *   POST /agent-host-relay/runs/:runId/send
 *   Authorization: Bearer $QWEN_SESSION_SEND_TOKEN
 *   {"text": "..."}  → 200 {"ok": true}
 *
 * Mounted before the daemon's bearer gate: the MCP child holds only the
 * per-run token. Loopback peers only.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';
import type { Application, Request, Response } from 'express';
import {
  formatHostForAuthority,
  isLoopbackAddress,
  isLoopbackBind,
  isWildcardBind,
} from './loopback-binds.js';
import { MAX_EXTERNAL_RECORD_TEXT_LENGTH } from '../acp-integration/session-external-record-params.js';

export const AGENT_HOST_RELAY_PATH = '/agent-host-relay/runs';
// The record writer refuses a longer post; refusing here tells the model the
// send failed instead of answering "sent" for a post that is then dropped.
const MAX_SEND_TEXT = MAX_EXTERNAL_RECORD_TEXT_LENGTH;

interface RelayRun {
  token: Buffer;
  push(text: string): void;
}

const runs = new Map<string, RelayRun>();
let baseUrlGetter: (() => string | undefined) | undefined;

/**
 * The URL a local process reaches this daemon on, or undefined when the
 * daemon is bound to one non-loopback address (nothing local can reach a
 * loopback-only route then).
 */
export function relayBaseUrl(options: {
  hostname: string;
  port: number;
  tls: boolean;
}): string | undefined {
  // TODO(multi-agent): under TLS the MCP child's fetch would reject the
  // daemon's (typically self-signed) certificate on 127.0.0.1, so no relay;
  // a plain loopback listener or a trusted CA would lift this.
  if (!options.port || options.tls) return undefined;
  const scheme = 'http';
  let authority: string | undefined;
  if (options.hostname.toLowerCase() === 'localhost') {
    // TODO(multi-agent): a `localhost` bind that resolved to ::1 only is not
    // reachable on 127.0.0.1; unverified on such a machine.
    authority = '127.0.0.1';
  } else if (isLoopbackBind(options.hostname)) {
    authority = formatHostForAuthority(options.hostname);
  } else if (isWildcardBind(options.hostname)) {
    authority = options.hostname.includes(':') ? '[::1]' : '127.0.0.1';
  }
  return authority ? `${scheme}://${authority}:${options.port}` : undefined;
}

function isLoopbackPeer(req: Request): boolean {
  const address = (req.socket.remoteAddress ?? '').replace(/^::ffff:/i, '');
  return isLoopbackAddress(address);
}

function bearer(req: Request): Buffer | undefined {
  const match = /^Bearer ([A-Za-z0-9_-]{16,256})$/.exec(
    req.get('authorization') ?? '',
  );
  return match ? Buffer.from(match[1]) : undefined;
}

export function registerAgentHostRelayRoutes(
  app: Application,
  options: { hostname: string; getPort: () => number; tls: boolean },
): void {
  // Read lazily: the port is 0 until `listen()` resolves.
  baseUrlGetter = () =>
    relayBaseUrl({
      hostname: options.hostname,
      port: options.getPort(),
      tls: options.tls,
    });
  app.post(
    `${AGENT_HOST_RELAY_PATH}/:runId/send`,
    // The daemon's body parser is installed after its bearer gate.
    express.json({ limit: '512kb' }),
    (req: Request, res: Response) => {
      if (!isLoopbackPeer(req)) {
        res.status(403).json({ error: 'loopback_only' });
        return;
      }
      const run = runs.get(String(req.params['runId']));
      const token = bearer(req);
      if (
        !run ||
        !token ||
        token.length !== run.token.length ||
        !timingSafeEqual(token, run.token)
      ) {
        // One answer for "no such run" and "wrong token".
        res.status(401).json({ error: 'invalid_session_send_token' });
        return;
      }
      const text = (req.body as { text?: unknown } | undefined)?.text;
      if (
        typeof text !== 'string' ||
        !text.trim() ||
        text.length > MAX_SEND_TEXT
      ) {
        res.status(400).json({ error: 'invalid_text' });
        return;
      }
      run.push(text);
      res.json({ ok: true });
    },
  );
}

export interface AgentHostRelayRun {
  /** For `--url`: `<base>/agent-host-relay/runs/<runId>/send`. */
  url: string;
  /** For `QWEN_SESSION_SEND_TOKEN`. */
  token: string;
  close(): void;
}

/** Whether this daemon can offer agent-host relays at all (an addressable base URL). */
export function hasAgentHostRelay(): boolean {
  return Boolean(baseUrlGetter?.());
}

/**
 * Opens the relay for one run. Undefined when this daemon has no relay
 * route mounted or no loopback address (the turn then runs without
 * `session_send`).
 */
export function openAgentHostRelayRun(
  runId: string,
  push: (text: string) => void,
): AgentHostRelayRun | undefined {
  const base = baseUrlGetter?.();
  if (!base) return undefined;
  const token = randomBytes(32).toString('base64url');
  const entry: RelayRun = { token: Buffer.from(token), push };
  runs.set(runId, entry);
  return {
    url: `${base}${AGENT_HOST_RELAY_PATH}/${encodeURIComponent(runId)}/send`,
    token,
    close: () => {
      if (runs.get(runId) === entry) runs.delete(runId);
    },
  };
}

/** Test seam. */
export function resetAgentHostRelayForTests(): void {
  runs.clear();
  baseUrlGetter = undefined;
}
