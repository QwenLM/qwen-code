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

const WEBHOOK_TIMEOUT_MS = 30_000;

function createStreamClient(
  settings: DingtalkSettings,
  onMessage: (messageId: string, data: string) => void,
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
    // Ack first so the provider does not redeliver while the admission is
    // still queued; the admission itself is durable before its side effect.
    client.send(msg.headers.messageId, {
      status: EventAck.SUCCESS,
      message: 'ok',
    });
    onMessage(msg.headers.messageId, msg.data);
  });
  // The SDK's onDownStream console.log()s every raw frame (user text, sender
  // id, the sessionWebhook capability) before dispatching it to the listener
  // above. Wrap the dispatch so the frame is routed without being logged.
  const sdkOnDownStream = internals.onDownStream.bind(client);
  internals.onDownStream = (data: unknown) => {
    withConsoleLogSuppressedSync(() => sdkOnDownStream(data));
  };
  // The SDK reconnects by calling this.connect, whose getEndpoint() logs the
  // clientSecret; connect() also resets userDisconnect, so a timer pending at
  // disconnect would reopen a socket. Route every connect through the logging
  // suppression and stop once the adapter disconnects. The adapter's FIRST
  // connect must surface its failure (a bad credential or unreachable gateway
  // creates no socket and arms no retry, so swallowing it would report a
  // healthy start that is permanently deaf); only a reconnect after a
  // successful connect may fail quietly, since the SDK's close-handler timer
  // owns the retry.
  let stopped = false;
  let everConnected = false;
  const sdkConnect = internals.connect.bind(client);
  const guardedConnect = () => {
    if (stopped) return Promise.resolve();
    return withConnectLoggingSuppressed(sdkConnect).then(
      (result) => {
        everConnected = true;
        return result;
      },
      (error) => {
        if (!everConnected) throw error;
        return undefined;
      },
    );
  };
  internals.connect = guardedConnect;
  return {
    connect: () => guardedConnect(),
    disconnect: () => {
      stopped = true;
      client.disconnect();
    },
  };
}

async function sendWebhook(webhook: string, text: string): Promise<void> {
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
    // System-busy and throttling verdicts are transient (the package's own
    // classifier treats -1 / 410100 as transient): the outcome is unknown, not
    // a definitive refusal the ledger could never revise.
    if (body.errcode === -1 || body.errcode === 410100) {
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
