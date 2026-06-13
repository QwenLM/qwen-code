/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Thin Matrix client-server REST client over `fetch` — NO SDK dependency for the
 * UNENCRYPTED path (the client-server API is plain HTTPS JSON). This is the
 * outbound + bootstrap surface the bridge needs: `whoami` (the startup
 * MXID-mismatch fail-fast), `joinRoom` (auto-accept invites), and `sendMessage`
 * (permission_request messages, `!qwen` replies, `m.replace` resolve edits, and
 * the encrypted-room refusal notice).
 *
 * NOTE: `matrix-bot-sdk`'s crypto (for E2EE rooms) is integrated with its sync
 * loop and would SUBSUME this fetch client + the sync loop if E2EE is added
 * later. That's why the render/dispatch/store/normalize layers are kept
 * transport-agnostic — they survive that swap; only this adapter is replaceable.
 *
 * Matrix ids (rooms, users) are opaque STRINGS, URL-encoded into paths.
 */

/** Result of a client-server REST call (surfaces M_LIMIT_EXCEEDED backoff). */
export interface MatrixRestResult {
  ok: boolean;
  status: number;
  /** Matrix's `retry_after_ms` on a 429 (milliseconds, not seconds). */
  retryAfterMs?: number;
  /** Parsed JSON body when present. */
  body?: unknown;
}

export interface MatrixRestConfig {
  homeserverUrl: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
  /** Injectable transaction-id generator (tests). Must be unique per call. */
  txnId?: () => string;
}

export class MatrixRestApi {
  private readonly base: string;
  private readonly accessToken: string;
  private readonly fetchImpl: typeof fetch;
  private readonly txnId: () => string;
  private counter = 0;

  constructor(cfg: MatrixRestConfig) {
    this.base = cfg.homeserverUrl.replace(/\/+$/, '');
    this.accessToken = cfg.accessToken;
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.txnId = cfg.txnId ?? (() => `qwen.${Date.now()}.${this.counter++}`);
  }

  private async call(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<MatrixRestResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: {
          // Access token bearer; never logged.
          Authorization: `Bearer ${this.accessToken}`,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch {
      return { ok: false, status: 0 }; // network error / abort → caller backs off
    }
    const json = (await res.json().catch(() => undefined)) as
      | { retry_after_ms?: number }
      | undefined;
    const out: MatrixRestResult = { ok: res.ok, status: res.status };
    if (res.status === 429 && typeof json?.retry_after_ms === 'number') {
      out.retryAfterMs = json.retry_after_ms;
    }
    if (json !== undefined) out.body = json;
    return out;
  }

  /**
   * Long-poll `/sync` from `since` (the prior `next_batch`, or undefined for the
   * initial full sync), blocking up to `timeoutMs` server-side. Returns the raw
   * result; the caller hands `.body` to the sync extractor.
   */
  async sync(
    since: string | undefined,
    timeoutMs = 30000,
    signal?: AbortSignal,
  ): Promise<MatrixRestResult> {
    const q = new URLSearchParams({ timeout: String(timeoutMs) });
    if (since) q.set('since', since);
    return this.call(
      'GET',
      `/_matrix/client/v3/sync?${q.toString()}`,
      undefined,
      signal,
    );
  }

  /** Resolve the access token's MXID (startup fail-fast checks it matches). */
  async whoami(
    signal?: AbortSignal,
  ): Promise<MatrixRestResult & { userId?: string }> {
    const r = await this.call(
      'GET',
      `/_matrix/client/v3/account/whoami`,
      undefined,
      signal,
    );
    const userId = (r.body as { user_id?: unknown })?.user_id;
    return typeof userId === 'string' ? { ...r, userId } : r;
  }

  /** Accept a room invite (auto-join). */
  async joinRoom(roomId: string): Promise<MatrixRestResult> {
    return this.call(
      'POST',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
      {},
    );
  }

  /**
   * Send an `m.room.message` event and return its event id. `content` is the full
   * message content (plain message, or an `m.replace` edit carrying
   * `m.new_content` + `m.relates_to`). A fresh transaction id makes the PUT
   * idempotent.
   */
  async sendMessage(
    roomId: string,
    content: unknown,
  ): Promise<MatrixRestResult & { eventId?: string }> {
    const r = await this.call(
      'PUT',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(this.txnId())}`,
      content,
    );
    const eventId = (r.body as { event_id?: unknown })?.event_id;
    return typeof eventId === 'string' ? { ...r, eventId } : r;
  }
}
