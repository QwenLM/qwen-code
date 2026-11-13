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

const WEBHOOK_TIMEOUT_MS = 30_000;

/**
 * The SDK's getEndpoint() console.log()s the resolved config (clientSecret)
 * and the gateway response, ungated by its own debug flag. Silence rather
 * than redact: a key allowlist stays open to future SDK logs. A depth counter
 * keeps nested suppressions from restoring the no-op early.
 */
let connectLogDepth = 0;
let unsuppressedConsoleLog: typeof console.log | undefined;
/* eslint-disable no-console */
async function withConnectLoggingSuppressed<T>(
  connect: () => Promise<T>,
): Promise<T> {
  if (connectLogDepth++ === 0) {
    unsuppressedConsoleLog = console.log;
    console.log = () => {};
  }
  try {
    return await connect();
  } finally {
    if (--connectLogDepth === 0 && unsuppressedConsoleLog) {
      console.log = unsuppressedConsoleLog;
      unsuppressedConsoleLog = undefined;
    }
  }
}
/* eslint-enable no-console */

function createStreamClient(
  settings: DingtalkSettings,
  onMessage: (messageId: string, data: string) => void,
): ManagedDingtalkStreamClient {
  const client = new DWClient({
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    keepAlive: true,
  });
  (client as unknown as { debug: boolean }).debug = false;
  client.registerCallbackListener(TOPIC_ROBOT, (msg: DWClientDownStream) => {
    // Ack first so the provider does not redeliver while the admission is
    // still queued; the admission itself is durable before its side effect.
    client.send(msg.headers.messageId, {
      status: EventAck.SUCCESS,
      message: 'ok',
    });
    onMessage(msg.headers.messageId, msg.data);
  });
  const sdkConnect = client.connect.bind(client);
  return {
    connect: () => withConnectLoggingSuppressed(sdkConnect),
    disconnect: () => client.disconnect(),
  };
}

async function sendWebhook(webhook: string, text: string): Promise<void> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), WEBHOOK_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
      signal: abort.signal,
    });
  } catch (error) {
    // A timeout or a dropped connection leaves the provider's state unknown.
    const failure = new Error(
      `DingTalk webhook send failed: ${String(error)}`,
    ) as DingtalkWebhookFailure;
    failure.definitive = false;
    throw failure;
  } finally {
    clearTimeout(timer);
  }
  if (response.status >= 400 && response.status < 500) {
    const failure = new Error(
      `DingTalk webhook refused the send (HTTP ${response.status}).`,
    ) as DingtalkWebhookFailure;
    failure.definitive = true;
    throw failure;
  }
  if (!response.ok) {
    const failure = new Error(
      `DingTalk webhook send failed (HTTP ${response.status}).`,
    ) as DingtalkWebhookFailure;
    failure.definitive = false;
    throw failure;
  }
  const body = (await response.json().catch(() => undefined)) as
    | { errcode?: number; errmsg?: string }
    | undefined;
  if (body && typeof body.errcode === 'number' && body.errcode !== 0) {
    // A non-zero errcode is the provider's definitive verdict (an expired or
    // invalid webhook, a banned robot): nothing retries it.
    const failure = new Error(
      `DingTalk webhook refused the send (errcode ${body.errcode}: ${String(body.errmsg)}).`,
    ) as DingtalkWebhookFailure;
    failure.definitive = true;
    throw failure;
  }
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
