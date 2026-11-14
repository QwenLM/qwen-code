/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { DWClient, TOPIC_ROBOT, EventAck } from 'dingtalk-stream-sdk-nodejs';
import type { DWClientDownStream } from 'dingtalk-stream-sdk-nodejs';
import type {
  ManagedDingtalkAdapterDeps,
  DingtalkSettings,
  ManagedDingtalkStreamClient,
  DingtalkWebhookFailure,
} from './managed-dingtalk-adapter.js';
import {
  withConnectLoggingSuppressed,
  withConsoleLogSuppressedSync,
} from './connect-logging.js';
import { splitChunks } from './markdown.js';
import { isRetryableDingtalkStatus } from './interactive-card-client.js';
import { ROBOT_MESSAGE_HOSTS } from './DingtalkAdapter.js';

const WEBHOOK_TIMEOUT_MS = 30_000;
const RECONNECT_RETRY_MS = 5_000;
// Provider verdicts a retry can heal: system busy (-1), throttled (88), and the
// send-rate limits (410100 / 130101). Classifying these definitive would settle
// a rate-limited chunk's whole delivery rejected and never send the rest.
const TRANSIENT_ERRCODES = new Set([-1, 88, 410100, 130101]);

function createStreamClient(
  settings: DingtalkSettings,
  onMessage: (messageId: string, data: string) => boolean,
): ManagedDingtalkStreamClient {
  const client = new DWClient({
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    keepAlive: true,
  });
  const internals = client as unknown as {
    debug: boolean;
    onDownStream: (data: unknown) => void;
    connect: () => Promise<void>;
  };
  internals.debug = false;
  client.registerCallbackListener(TOPIC_ROBOT, (msg: DWClientDownStream) => {
    // A frame without a routing messageId cannot be acked or admitted; drop it
    // instead of letting client.send throw through the socket handler.
    const messageId = msg?.headers?.messageId;
    if (!messageId) return;
    // Acceptance is the commit point: queue first, then ack SUCCESS only if the
    // frame was queued. An overflow leaves it unacked (LATER) so the provider
    // redelivers it rather than it being acked and silently dropped.
    const queued = onMessage(messageId, msg.data);
    client.send(messageId, {
      status: queued ? EventAck.SUCCESS : EventAck.LATER,
      message: queued ? 'ok' : 'busy',
    });
  });
  // The SDK's onDownStream console.log()s every raw frame (user text, sender id,
  // the sessionWebhook capability) and its dispatch JSON.parses + reads routing
  // headers with no error boundary. Wrap it so frames are routed without being
  // logged, and a malformed frame is logged and swallowed instead of throwing
  // through the socket handler — that would exit the process and crash-loop on
  // the unacked redelivery.
  const sdkOnDownStream = internals.onDownStream.bind(client);
  internals.onDownStream = (data: unknown) => {
    try {
      withConsoleLogSuppressedSync(() => sdkOnDownStream(data));
    } catch (error) {
      process.stderr.write(
        `Managed DingTalk downstream frame ignored: ${String(error)}\n`,
      );
    }
  };
  // The SDK reconnects by calling this.connect, whose getEndpoint() logs the
  // clientSecret. The adapter's FIRST connect must surface its failure (a bad
  // credential creates no socket and arms no retry, so swallowing it would
  // report a healthy start that is permanently deaf). A reconnect after a
  // successful connect may fail, but the SDK arms its retry timer only from the
  // socket close event — a getEndpoint() failure creates no socket and no timer,
  // so re-arm the retry here or one transient error leaves the adapter deaf.
  let stopped = false;
  let everConnected = false;
  let loggedReconnectFailure = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const sdkConnect = internals.connect.bind(client);
  const guardedConnect = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    return withConnectLoggingSuppressed(sdkConnect).then(
      (result) => {
        everConnected = true;
        loggedReconnectFailure = false;
        // A disconnect may have landed while this attempt was in flight; the
        // attempt then opened a fresh socket and armed the SDK heartbeat. Close
        // it so the process can exit and no zombie keeps acking LATER.
        if (stopped) client.disconnect();
        return result;
      },
      (error) => {
        // The first failure must surface (it tells the operator the credential
        // or network is wrong), but never rethrow the SDK's error object: an
        // AxiosError serializes its config.url, which carries the gettoken
        // appsecret. Redact the payload, not the failure.
        if (!everConnected) {
          void error;
          throw new Error(
            'DingTalk stream connect failed; check the clientId/clientSecret and network.',
          );
        }
        // Do not echo the error: it can carry the endpoint/ticket. Log only on
        // the transition — a permanently rejected app would otherwise re-emit
        // this line every retry interval and drown the log.
        void error;
        if (!loggedReconnectFailure) {
          loggedReconnectFailure = true;
          process.stderr.write(
            `Managed DingTalk stream reconnect failed; retrying in ${RECONNECT_RETRY_MS} ms.\n`,
          );
        }
        if (!stopped && retry === undefined) {
          retry = setTimeout(() => {
            retry = undefined;
            void guardedConnect();
          }, RECONNECT_RETRY_MS);
        }
        return undefined;
      },
    );
  };
  internals.connect = guardedConnect;
  return {
    connect: () => guardedConnect(),
    disconnect: () => {
      stopped = true;
      if (retry !== undefined) clearTimeout(retry);
      client.disconnect();
    },
  };
}

async function sendWebhook(webhook: string, text: string): Promise<void> {
  // The sessionWebhook is a bearer capability URL taken from the inbound frame;
  // validate it before the first fetch (the same guard the Legacy path applies)
  // so a reply — assistant output and the URL's token included — is never sent
  // over cleartext or to a non-DingTalk host.
  let url: URL;
  try {
    url = new URL(webhook);
  } catch {
    throw webhookFailure('DingTalk webhook URL is not a valid URL.', true);
  }
  if (
    url.protocol !== 'https:' ||
    url.port !== '' ||
    !ROBOT_MESSAGE_HOSTS.has(url.hostname)
  ) {
    throw webhookFailure('DingTalk webhook URL rejected.', true);
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    // DingTalk caps one text message at DINGTALK_MAX_CHUNK_LENGTH units, while
    // a ledger segment can be larger; split and send the chunks in order. One
    // receipt still covers the whole ledger segment. The budget stays armed
    // across every chunk's header AND body read, so a stalled body cannot
    // outlive it.
    for (const chunk of splitChunks(text)) {
      await postTextChunk(webhook, chunk, abort.signal);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function postTextChunk(
  webhook: string,
  content: string,
  signal: AbortSignal,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content } }),
      signal,
      redirect: 'error',
    });
  } catch (error) {
    // A timeout or a dropped connection leaves the provider's state unknown.
    throw webhookFailure(
      `DingTalk webhook send failed: ${String(error)}`,
      false,
    );
  }
  if (response.status >= 400 && response.status < 500) {
    // Retryable statuses (408/425/429) are transient, matching the package's
    // own classifier; the rest (expired/invalid webhook, banned) are definitive.
    throw webhookFailure(
      `DingTalk webhook answered HTTP ${response.status}.`,
      !isRetryableDingtalkStatus(response.status),
    );
  }
  if (!response.ok) {
    throw webhookFailure(
      `DingTalk webhook send failed (HTTP ${response.status}).`,
      false,
    );
  }
  let body: { errcode?: number; errmsg?: string } | undefined;
  try {
    body = (await response.json()) as typeof body;
  } catch {
    if (signal.aborted) {
      throw webhookFailure('DingTalk webhook body read timed out.', false);
    }
    // HTTP 200 is not DingTalk's success verdict (non-zero errcode arrives with
    // 200 too); an unreadable body proves nothing, so the outcome is unknown.
    throw webhookFailure(
      'DingTalk webhook answered without a readable body; the send outcome is unknown.',
      false,
    );
  }
  if (!body || typeof body.errcode !== 'number') {
    throw webhookFailure(
      'DingTalk webhook answered without an errcode; the send outcome is unknown.',
      false,
    );
  }
  if (body.errcode !== 0) {
    // System-busy and send-throttle verdicts are transient: the outcome is
    // unknown, not a definitive refusal the ledger could never revise. A
    // rate-limited chunk must not settle the whole delivery rejected.
    if (TRANSIENT_ERRCODES.has(body.errcode)) {
      throw webhookFailure(
        `DingTalk webhook is busy (errcode ${body.errcode}); the send outcome is unknown.`,
        false,
      );
    }
    throw webhookFailure(
      `DingTalk webhook refused the send (errcode ${body.errcode}: ${String(body.errmsg)}).`,
      true,
    );
  }
}

function webhookFailure(
  message: string,
  definitive: boolean,
): DingtalkWebhookFailure {
  const failure = new Error(message) as DingtalkWebhookFailure;
  failure.definitive = definitive;
  return failure;
}

/** The production dependencies of the managed DingTalk adapter. */
export function createManagedDingtalkDeps(): ManagedDingtalkAdapterDeps {
  return {
    createStreamClient,
    sendWebhook,
    lock: async (directory, onCompromised) => {
      const { default: lockfile } = await import('proper-lockfile');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      return lockfile.lock(directory, { retries: 0, onCompromised });
    },
  };
}
