/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { WSClient } from '@wecom/aibot-node-sdk';
import type { WSClientOptions } from '@wecom/aibot-node-sdk';
import { sanitizeLogText } from '@qwen-code/channel-base';
import { splitMarkdown } from '@qwen-code/channel-base/markdown-chunks';
import type {
  ManagedWecomAdapterDeps,
  WecomSettings,
  ManagedWecomStreamClient,
} from './managed-wecom-adapter.js';

// The production dependencies of the managed WeCom adapter. Both directions
// ride the SDK's authenticated WebSocket: inbound message.text frames are
// staged by the adapter, outbound segments go through sendMessage on the same
// client. The SDK pushes each inbound frame once with no ack and no provider
// redelivery, and a server kick (a new connection displaced this one) is
// fatal — reconnecting would displace the new owner in turn. See
// docs/design/2026-11-16-managed-channel-wecom-adapter.md.

const AUTHENTICATION_TIMEOUT_MS = 30_000;
// The Legacy channel's per-message markdown budgets; a ledger segment can be
// larger, so the deps split it and one receipt still covers the whole segment.
const MARKDOWN_CHUNK_BYTES = 3800;
const MARKDOWN_MAX_CHUNK_BYTES = 20_000;

function createStreamClient(
  settings: WecomSettings,
  onMessage: (messageId: string, data: string) => void,
  onStopped: (reason: string) => void,
  onClient: (client: WSClient | undefined) => void,
  onReady: (ready: boolean) => void,
): ManagedWecomStreamClient {
  const options: WSClientOptions = {
    botId: settings.botId,
    secret: settings.secret,
    // A transient disconnect or a mid-session credential rotation heals by
    // retry, mirroring the DingTalk deps' forever-retry discipline; the SDK's
    // heartbeat and missed-pong detection drive the reconnect. Only a server
    // kick stops the adapter (below).
    maxReconnectAttempts: -1,
    maxAuthFailureAttempts: -1,
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message: string) =>
        process.stderr.write(
          `Managed WeCom SDK warn: ${sanitizeLogText(message, 200)}\n`,
        ),
      error: (message: string) =>
        process.stderr.write(
          `Managed WeCom SDK error: ${sanitizeLogText(message, 200)}\n`,
        ),
    },
  };
  if (settings.wsUrl) options.wsUrl = settings.wsUrl;
  const client = new WSClient(options);
  let authenticated = false;
  // Whether the initial handshake ever completed, tracked separately from
  // current send readiness: a server kick is terminal once this stream has been
  // established, even while a replacement socket is still reauthenticating
  // (authenticated false). Gating the kick on authenticated would ignore a kick
  // that lands in that window, leaving the adapter holding its entry lock and
  // deregistering the replacement owner's row on shutdown.
  let established = false;
  let stopped = false;
  let loggedNonText = false;
  // Hoisted so disconnect() can interrupt a pending connect() instead of
  // leaving it to reject 30s later as a misleading authentication timeout.
  let interruptConnect: ((error: Error) => void) | undefined;

  // The managed path serves text only; the SDK emits message.<msgtype> per
  // type, so a non-text frame would otherwise vanish with no trace on a
  // provider that never redelivers. Name the drop once (latched).
  client.on('message', (frame) => {
    if (!authenticated || stopped) return;
    const msgtype = frame.body?.msgtype;
    if (msgtype && msgtype !== 'text' && !loggedNonText) {
      loggedNonText = true;
      process.stderr.write(
        `Managed WeCom dropped a non-text frame (msgtype ${sanitizeLogText(String(msgtype), 40)}); the managed path serves text only (the provider does not redeliver).\n`,
      );
    }
  });
  client.on('message.text', (frame) => {
    if (!authenticated || stopped) return;
    const body = frame.body;
    const msgid =
      body && typeof body.msgid === 'string' && body.msgid.trim()
        ? body.msgid
        : undefined;
    // A frame without a msgid cannot be deduped across restarts; drop it
    // instead of admitting an event the settled window can never recognize.
    if (!msgid) {
      process.stderr.write(
        'Managed WeCom message without a msgid is dropped.\n',
      );
      return;
    }
    try {
      onMessage(msgid, JSON.stringify(body));
    } catch (error) {
      // The adapter's onMessage owns its error boundary; this catches a
      // serialization failure so it cannot throw through the SDK's socket
      // handler.
      process.stderr.write(
        `Managed WeCom message ${sanitizeLogText(msgid, 100)} ignored: ${sanitizeLogText(String(error), 200)}\n`,
      );
    }
  });
  client.on('event.disconnected_event', () => {
    // Gate on establishment, not current readiness: after the first successful
    // connection every kick is fatal, including one that arrives while the
    // replacement socket is still reauthenticating (authenticated false). The
    // initial handshake's own onKicked listener handles a pre-establishment
    // kick; this persistent handler owns every kick after it.
    if (!established || stopped) return;
    stopped = true;
    authenticated = false;
    onReady(false);
    onClient(undefined);
    onStopped('a new connection displaced this one (server kick)');
  });
  client.on('error', (error) => {
    process.stderr.write(
      `Managed WeCom SDK error: ${sanitizeLogText(error.message, 200)}\n`,
    );
  });
  // Readiness tracks AUTHENTICATION, not the socket reaching OPEN: the SDK
  // marks isConnected at WebSocket.OPEN, before the subscribe acknowledgement.
  // Claiming deliveries in that window would send on a socket that may still
  // fail authentication, settling the reply unknown. Clear readiness on every
  // disconnect and restore it on each authenticated event (the SDK re-emits it
  // on every successful reconnect).
  client.on('authenticated', () => {
    authenticated = true;
    onReady(true);
  });
  client.on('disconnected', (reason) => {
    authenticated = false;
    onReady(false);
    process.stderr.write(
      `Managed WeCom WebSocket ${sanitizeLogText(reason, 200)}.\n`,
    );
  });

  return {
    // The SDK's connect() returns this synchronously; only the authenticated
    // event means the stream can actually receive frames. Bound the wait so a
    // blocked upgrade or a silent auth failure becomes a rejection, not a
    // deaf start. The first failure surfaces to the operator; the error text
    // is sanitized because SDK errors can carry credential material.
    connect: () =>
      new Promise<void>((resolve, reject) => {
        let settled = false;
        const detach = () => {
          client.off('authenticated', onAuth);
          client.off('error', onError);
          client.off('event.disconnected_event', onKicked);
        };
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          interruptConnect = undefined;
          clearTimeout(timer);
          detach();
          if (error) {
            authenticated = false;
            onReady(false);
            onClient(undefined);
            try {
              client.disconnect();
            } catch {
              // cleanup must not mask the original connection error
            }
            reject(error);
          } else {
            established = true;
            authenticated = true;
            onReady(true);
            onClient(client);
            resolve();
          }
        };
        const onAuth = () => finish();
        const onError = (error: Error) =>
          finish(
            new Error(
              `WeCom authentication failed: ${sanitizeLogText(error.message, 200)}`,
            ),
          );
        const onKicked = () =>
          finish(
            new Error('WeCom authentication interrupted by a server kick.'),
          );
        const timer = setTimeout(
          () => finish(new Error('WeCom authentication timed out.')),
          AUTHENTICATION_TIMEOUT_MS,
        );
        timer.unref?.();
        client.on('authenticated', onAuth);
        client.on('error', onError);
        client.on('event.disconnected_event', onKicked);
        interruptConnect = (error) => finish(error);
        client.connect();
      }),
    disconnect: () => {
      stopped = true;
      authenticated = false;
      onReady(false);
      onClient(undefined);
      // Interrupt a pending handshake promptly with the stop reason rather
      // than letting it time out 30s later as a credential error.
      interruptConnect?.(
        new Error('WeCom connection stopped before authentication.'),
      );
      client.disconnect();
    },
  };
}

async function sendMessage(
  client: WSClient | undefined,
  chatId: string,
  text: string,
): Promise<void> {
  if (!client || !client.isConnected) {
    // A disconnected client proves nothing about the provider's state; the
    // adapter classifies the failure unknown and the receipt re-drives.
    throw new Error(
      'WeCom client is not connected; the send outcome is unknown.',
    );
  }
  // A ledger segment can exceed the per-message markdown budget; split it
  // with the shared structure-aware splitter and send the chunks in order.
  // The SDK bounds each chunk by its own reply-ack timeout. A failure after
  // some chunks were delivered stays unknown (partially delivered, not never
  // sent) — the adapter's all-unknown classification already guarantees it.
  const chunks = splitMarkdown(text, {
    targetLength: MARKDOWN_CHUNK_BYTES,
    maxLength: MARKDOWN_MAX_CHUNK_BYTES,
    unit: 'utf8',
  });
  for (const chunk of chunks) {
    await client.sendMessage(chatId, {
      msgtype: 'markdown',
      markdown: { content: chunk },
    });
  }
}

/** The production dependencies of the managed WeCom adapter. */
export function createManagedWecomDeps(): ManagedWecomAdapterDeps {
  // The send path rides the stream's live client; the factory holds the
  // current instance so sendMessage and the stream cannot drift apart.
  let current: WSClient | undefined;
  // Authentication readiness of the live socket (see createStreamClient): the
  // claim phase gates on this, not on the socket merely reaching OPEN.
  let ready = false;
  return {
    createStreamClient: (settings, onMessage, onStopped) =>
      createStreamClient(
        settings,
        onMessage,
        onStopped,
        (client) => {
          current = client;
        },
        (value) => {
          ready = value;
        },
      ),
    sendMessage: (chatId, text) => sendMessage(current, chatId, text),
    isConnected: () => ready,
    lock: async (directory, onCompromised) => {
      const { default: lockfile } = await import('proper-lockfile');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      return lockfile.lock(directory, { retries: 0, onCompromised });
    },
  };
}
