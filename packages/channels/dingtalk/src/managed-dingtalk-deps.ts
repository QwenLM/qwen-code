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
  // clientSecret and can reject unhandled against a down network; connect()
  // also resets userDisconnect, so a timer pending at disconnect would reopen
  // a socket. Route every connect — including the SDK's own reconnects —
  // through the logging suppression, swallow a failed attempt so it cannot
  // raise an unhandled rejection (the next timer retries), and stop once the
  // adapter disconnects.
  let stopped = false;
  const sdkConnect = internals.connect.bind(client);
  internals.connect = () => {
    if (stopped) return Promise.resolve();
    return withConnectLoggingSuppressed(sdkConnect).catch(() => undefined);
  };
  return {
    connect: () => internals.connect(),
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
    throw webhookFailure(
      `DingTalk webhook refused the send (HTTP ${response.status}).`,
      true,
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
    body = undefined;
  }
  if (body && typeof body.errcode === 'number' && body.errcode !== 0) {
    // A non-zero errcode is the provider's definitive verdict (an expired or
    // invalid webhook, a banned robot): nothing retries it.
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
