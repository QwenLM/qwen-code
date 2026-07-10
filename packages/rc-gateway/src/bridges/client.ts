/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A bridge's client of the gateway over the PUBLIC loopback contract
 * (`add-bridge-protocol`). This is the seam that keeps an in-process bridge
 * extractable to a separate-process sidecar: it talks ONLY HTTP+SSE to a
 * configured `baseUrl` with a configured bridge `token` — it never imports or
 * calls a gateway internal (no TokenStore, no daemon client, no OwnerEventBus).
 * To move the bridge to its own process you change only `baseUrl`/`token`.
 *
 * The token is OPERATOR-PROVIDED (minted once via `POST /rc/tokens {scopes:
 * ['bridge']}` and passed as config/env) — the gateway never auto-mints and
 * hands one over, preserving the owner-explicit-grant property of the scope.
 */

import type { BridgeMarkdownSupport } from './registry.js';

/** A parsed SSE frame from `/session/:id/events`. */
export interface BridgeEvent {
  id?: number;
  type?: string;
  data?: unknown;
}

/** Outcome of a write (prompt/vote): surfaces the HTTP status for back-pressure. */
export interface WriteResult {
  ok: boolean;
  status: number;
  /** Seconds to back off, when the gateway rate-limited (429). */
  retryAfterSec?: number;
  /** Parsed JSON body when present. */
  body?: unknown;
}

export interface BridgeClientConfig {
  /** The gateway base URL (e.g. http://127.0.0.1:4170). Loopback in-process. */
  baseUrl: string;
  /** A `bridge`-scope token (qwk_*), operator-minted and supplied as config. */
  token: string;
  /** Injectable fetch (tests). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class BridgeClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: BridgeClientConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.token = cfg.token;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private authHeaders(subActor?: string): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };
    if (subActor) h['X-RC-SubActor'] = subActor;
    return h;
  }

  /** Register / heartbeat this bridge's capabilities (POST /rc/bridges). */
  async register(reg: {
    id: string;
    displayName: string;
    supportsActions?: boolean;
    /** 'full' | 'limited' | 'none' — how richly the service renders markdown. */
    supportsMarkdown?: BridgeMarkdownSupport;
    supportsThreads?: boolean;
    supportsEdits?: boolean;
    /** Byte limit (legacy; prefer maxMessageChars). */
    maxMessageBytes?: number;
    /** Character limit — the preferred alternative to maxMessageBytes. */
    maxMessageChars?: number;
  }): Promise<WriteResult> {
    return this.postJson('/rc/bridges', reg);
  }

  /**
   * Redeem a one-time invite token (POST /rc/bridges/:id/invite/redeem). On a
   * `200` the bridge learns the `sessionId` to bind; on a non-2xx the gateway's
   * `error` text ("Invalid or expired invite token") is relayed to the chat. This
   * is the SOLE bind path — a chat user never names a session id directly.
   */
  async redeemInvite(
    bridgeId: string,
    token: string,
  ): Promise<WriteResult & { sessionId?: string }> {
    const r = await this.postJson(
      `/rc/bridges/${encodeURIComponent(bridgeId)}/invite/redeem`,
      { token },
    );
    const sessionId = (r.body as { sessionId?: unknown })?.sessionId;
    return typeof sessionId === 'string' ? { ...r, sessionId } : r;
  }

  /** Refresh this bridge's liveness (POST /rc/bridges/:id/heartbeat). A 404 means
   * the gateway no longer knows the bridge (reaped or restarted) → re-register. */
  async heartbeat(bridgeId: string): Promise<WriteResult> {
    return this.postJson(
      `/rc/bridges/${encodeURIComponent(bridgeId)}/heartbeat`,
      {},
    );
  }

  /** Send a prompt on behalf of a chat user (POST /session/:id/prompt). */
  async sendPrompt(
    sessionId: string,
    prompt: string,
    subActor: string,
  ): Promise<WriteResult> {
    return this.postJson(
      `/session/${encodeURIComponent(sessionId)}/prompt`,
      { prompt },
      subActor,
    );
  }

  /** Vote on a permission request on behalf of a chat user. */
  async vote(
    sessionId: string,
    requestId: string,
    outcome: 'allow_once' | 'cancelled',
    subActor: string,
    optionId?: string,
  ): Promise<WriteResult> {
    const body: Record<string, unknown> = { outcome };
    if (optionId !== undefined) body['optionId'] = optionId;
    return this.postJson(
      `/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}`,
      body,
      subActor,
    );
  }

  private async postJson(
    path: string,
    body: unknown,
    subActor?: string,
  ): Promise<WriteResult> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        ...this.authHeaders(subActor),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const parsed = await res.json().catch(() => undefined);
    const result: WriteResult = { ok: res.ok, status: res.status };
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'));
      if (Number.isFinite(ra) && ra > 0) result.retryAfterSec = ra;
    }
    if (parsed !== undefined) result.body = parsed;
    return result;
  }

  /**
   * Subscribe to a session's event stream (GET /session/:id/events) and invoke
   * `onEvent` for each parsed SSE frame (including `bridgeHints` on
   * permission_request). Resolves when the stream ends or `signal` aborts; never
   * throws on a normal abort. The caller owns reconnection.
   *
   * Pass `lastEventId` (the highest frame id already delivered) on a RECONNECT so
   * the gateway/daemon replays only frames with `id > lastEventId` from its bounded
   * ring — closing the no-cursor gap where a permission_request or stream chunk
   * arriving during a blip was silently lost. The daemon skips `id <= cursor`, so
   * this never re-delivers an already-seen frame. Omit it on the FIRST subscribe
   * (and after a full gateway restart, when the caller's cursor map is empty) to
   * get the live stream from now without replaying pre-restart history.
   */
  async subscribeEvents(
    sessionId: string,
    onEvent: (ev: BridgeEvent) => void,
    signal?: AbortSignal,
    lastEventId?: number,
  ): Promise<void> {
    const headers = this.authHeaders();
    if (lastEventId !== undefined && Number.isFinite(lastEventId)) {
      headers['Last-Event-ID'] = String(lastEventId);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(
        `${this.baseUrl}/session/${encodeURIComponent(sessionId)}/events`,
        { headers, signal },
      );
    } catch {
      return; // network/abort before headers → caller may reconnect
    }
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const blocks = buf.split('\n\n');
        buf = blocks.pop() ?? ''; // keep the trailing partial block
        for (const block of blocks) {
          const frame = parseFrame(block);
          if (frame) onEvent(frame);
        }
      }
    } catch {
      // Aborted or stream error → stop; caller decides whether to reconnect.
    }
  }
}

/** Parse one SSE block ("id: N\ndata: {...}") into a frame, or null. */
function parseFrame(block: string): BridgeEvent | null {
  const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
  if (!dataLine) return null;
  try {
    return JSON.parse(dataLine.slice(5).trim()) as BridgeEvent;
  } catch {
    return null;
  }
}
