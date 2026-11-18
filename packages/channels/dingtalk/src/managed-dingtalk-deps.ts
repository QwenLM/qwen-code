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
import { withConsoleLogSuppressedSync } from './connect-logging.js';
import { splitChunks } from './markdown.js';
import { isRetryableDingtalkStatus } from './interactive-card-client.js';
import { ROBOT_MESSAGE_HOSTS } from './DingtalkAdapter.js';

const WEBHOOK_TIMEOUT_MS = 30_000;
const RECONNECT_RETRY_MS = 5_000;
// The SDK's connect() resolves when the WebSocket is *constructed*, not when it
// opens. Bound the whole attempt so a blocked wss: upgrade becomes a rejection,
// not a deaf start; discovery below carries its own, shorter bound.
const CONNECT_TIMEOUT_MS = 20_000;
// Endpoint discovery is bounded on its own, below the attempt budget, so the
// budget is left to cover the wss: upgrade. The SDK's own getEndpoint() has no
// timeout at all, and it console.log()s the resolved config (clientSecret) and
// the gateway response (endpoint/ticket) — which is why the connect path used
// to mute console.log process-wide for as long as discovery stayed pending.
// Owning discovery removes both the unbounded wait and the need to mute.
const DISCOVERY_TIMEOUT_MS = 15_000;
// The discovery contract, pinned against dingtalk-stream-sdk-nodejs 2.0.4
// dist/client.mjs getEndpoint(); a bump that changes it must change these.
const TOKEN_URL = 'https://oapi.dingtalk.com/gettoken';
const GATEWAY_URL = 'https://api.dingtalk.com/v1.0/gateway/connections/open';
const SOCKET_OPEN = 1; // ws.WebSocket.OPEN
// Provider verdicts a retry can heal: system busy (-1), throttled (88), and the
// send-rate limits (410100 / 130101). Classifying these definitive would settle
// a rate-limited chunk's whole delivery rejected and never send the rest.
const TRANSIENT_ERRCODES = new Set([-1, 88, 410100, 130101]);

// Bounded, abortable and silent endpoint discovery. Every failure message is a
// static string: the token URL carries the appsecret and the gateway response
// carries the connect ticket, so neither the payload nor the transport error
// may be echoed.
async function discoverEndpoint(
  config: {
    clientId: string;
    clientSecret: string;
    ua?: string;
    subscriptions: Array<{ type: string; topic: string }>;
  },
  signal: AbortSignal,
): Promise<{ accessToken: string; endpoint: string; ticket: string }> {
  const tokenUrl =
    `${TOKEN_URL}?appkey=${encodeURIComponent(config.clientId)}` +
    `&appsecret=${encodeURIComponent(config.clientSecret)}`;
  // No redirect following on either leg: the token URL carries the appsecret
  // and the gateway request carries the access token, so a redirect would
  // hand that credential to another host. Same guard the webhook send applies.
  const tokenResponse = await fetch(tokenUrl, { signal, redirect: 'error' });
  if (!tokenResponse.ok) {
    throw new Error(
      'DingTalk endpoint discovery failed: token request refused.',
    );
  }
  const token = (await tokenResponse.json()) as { access_token?: string };
  if (!token?.access_token) {
    throw new Error('DingTalk endpoint discovery failed: no access token.');
  }
  const gatewayResponse = await fetch(GATEWAY_URL, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'access-token': token.access_token,
    },
    body: JSON.stringify({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      ua: config.ua,
      subscriptions: config.subscriptions,
    }),
    redirect: 'error',
  });
  if (!gatewayResponse.ok) {
    throw new Error(
      'DingTalk endpoint discovery failed: gateway request refused.',
    );
  }
  const gateway = (await gatewayResponse.json()) as {
    endpoint?: string;
    ticket?: string;
  };
  if (!gateway?.endpoint || !gateway?.ticket) {
    throw new Error(
      'DingTalk endpoint discovery failed: no endpoint or ticket.',
    );
  }
  return {
    accessToken: token.access_token,
    endpoint: gateway.endpoint,
    ticket: gateway.ticket,
  };
}

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
    getEndpoint: () => Promise<unknown>;
    dw_url: string;
    heartbeatIntervallId?: ReturnType<typeof setInterval>;
    socket?: {
      readyState: number;
      on: (event: string, cb: (...args: unknown[]) => void) => void;
      off: (event: string, cb: (...args: unknown[]) => void) => void;
    };
  };
  internals.debug = false;
  // The SDK arms its own reconnect from every socket's close event without
  // reading its `reconnecting` flag, so each drop adds a chain that compounds
  // on the next close. Reconnect is centralized below instead (#17173 R11).
  // Assigned on the instance because the constructor's options type omits the
  // field, while the config it exposes carries it.
  client.config.autoReconnect = false;
  // Replace the SDK's endpoint discovery with the bounded, silent one above.
  // Its own getEndpoint() logs the resolved config and the gateway response and
  // never times out, so wrapping it in a console suppression muted the whole
  // process for as long as it stayed pending — past the attempt budget, which
  // rejects the attempt without settling that promise (#17173 R11).
  internals.getEndpoint = async () => {
    const discovered = await discoverEndpoint(
      client.config,
      AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    );
    client.config.access_token = discovered.accessToken;
    // The SDK stores the whole gateway object here even though its published
    // type says string; nothing reads it back, so store the endpoint itself.
    client.config.endpoint = discovered.endpoint;
    internals.dw_url = `${discovered.endpoint}?ticket=${discovered.ticket}`;
    return client;
  };
  // The SDK creates a heartbeat interval on every socket open but never
  // clears it on close, and the next open overwrites the only stored handle —
  // the old interval keeps pinging the replacement socket. Retire it on close,
  // before the wrapper's reconnect opens the next one (#17173 R5).
  const retireHeartbeat = () => {
    if (internals.heartbeatIntervallId !== undefined) {
      clearInterval(internals.heartbeatIntervallId);
      internals.heartbeatIntervallId = undefined;
    }
  };
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
  // Reconnect is owned here, not by the SDK: a drop and a failed attempt both
  // funnel into one pending timer, and only one attempt runs at a time. The
  // adapter's FIRST connect must surface its failure (a bad credential creates
  // no socket, so swallowing it would report a healthy start that is
  // permanently deaf); a later failure re-arms, because a getEndpoint() failure
  // creates no socket and therefore no close event to re-arm from.
  let stopped = false;
  let everConnected = false;
  let loggedReconnectFailure = false;
  let pending: Promise<void> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const scheduleReconnect = () => {
    // Before the first successful connect a failure must surface to the
    // operator, not turn into a silent retry loop.
    if (stopped || !everConnected || retry !== undefined) return;
    retry = setTimeout(() => {
      retry = undefined;
      if (stopped) return;
      // An attempt still running owns the socket; try again later rather than
      // dropping this reconnect on the floor.
      if (pending !== undefined) {
        scheduleReconnect();
        return;
      }
      void guardedConnect();
    }, RECONNECT_RETRY_MS);
  };
  const sdkConnect = internals.connect.bind(client);
  // The SDK resolves connect() once the WebSocket is constructed; only the
  // 'open' event means the stream can actually receive frames. Wait for it,
  // rejecting on an error/close before open, so a blocked wss: upgrade cannot
  // report a healthy start.
  const waitForSocketOpen = (): Promise<void> => {
    const socket = internals.socket;
    if (!socket) {
      return Promise.reject(new Error('DingTalk stream created no socket.'));
    }
    if (socket.readyState === SOCKET_OPEN) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const fail = () => {
        cleanup();
        reject(new Error('DingTalk stream failed before the socket opened.'));
      };
      const cleanup = () => {
        socket.off('open', onOpen);
        socket.off('error', fail);
        socket.off('close', fail);
      };
      socket.on('open', onOpen);
      socket.on('error', fail);
      socket.on('close', fail);
    });
  };
  // Bound the whole attempt (getEndpoint has no timeout either) so a hung
  // endpoint call or handshake becomes a rejection instead of a pending promise.
  const attempt = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        // Close whatever the attempt has opened so far; if getEndpoint is still
        // in flight the success branch below closes the socket it opens late.
        client.disconnect();
        reject(new Error('DingTalk stream connect timed out.'));
      }, CONNECT_TIMEOUT_MS);
      sdkConnect()
        .then(() => {
          // Each attempt constructs a fresh socket; arm the heartbeat retire
          // and the reconnect on its close, so a drop of a healthy socket is
          // recovered too now that the SDK no longer reconnects itself.
          internals.socket?.on('close', retireHeartbeat);
          internals.socket?.on('close', scheduleReconnect);
          return waitForSocketOpen();
        })
        .then(
          () => {
            clearTimeout(timer);
            if (timedOut) {
              // The abandoned attempt opened a socket after the timeout; close
              // it so no zombie keeps the heartbeat armed.
              client.disconnect();
              return;
            }
            resolve();
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
    });
  const guardedConnect = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    // A concurrent caller joins the running attempt and settles with its real
    // outcome. Resolving early would report a healthy start while the only
    // socket is still opening — and the attempt it joined may yet fail.
    if (pending !== undefined) return pending;
    pending = attempt().then(
      (result) => {
        pending = undefined;
        everConnected = true;
        loggedReconnectFailure = false;
        // A stale retry armed by an earlier failure must not fire after the
        // stream is connected and open a second socket.
        if (retry !== undefined) {
          clearTimeout(retry);
          retry = undefined;
        }
        // A disconnect may have landed while this attempt was in flight; the
        // attempt then opened a fresh socket and armed the SDK heartbeat. Close
        // it so the process can exit and no zombie keeps acking LATER.
        if (stopped) client.disconnect();
        return result;
      },
      (error) => {
        pending = undefined;
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
        scheduleReconnect();
        return undefined;
      },
    );
    return pending;
  };
  return {
    connect: () => guardedConnect(),
    disconnect: () => {
      stopped = true;
      if (retry !== undefined) clearTimeout(retry);
      client.disconnect();
    },
  };
}

async function sendWebhook(
  webhook: string,
  text: string,
  proxy?: string,
): Promise<void> {
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
  // In a proxy-only egress the reply must still leave: route this send through
  // the resolved proxy with a per-send dispatcher (the Legacy sender's shape),
  // destroyed afterwards so it never leaks. Only the webhook send is proxied —
  // the internal control-plane traffic is left untouched.
  let dispatcher: import('undici').Dispatcher | undefined;
  try {
    if (proxy) {
      // Read the constructor off the default namespace: in the bundled CLI a
      // dynamic import of the CJS undici package is default-only, so a named
      // destructure would bind undefined and throw before the POST. The Legacy
      // sender uses this same shape.
      const { default: undici } = await import('undici');
      dispatcher = new undici.EnvHttpProxyAgent({
        httpProxy: proxy,
        httpsProxy: proxy,
      });
    }
    // DingTalk caps one text message at DINGTALK_MAX_CHUNK_LENGTH units, while
    // a ledger segment can be larger; split and send the chunks in order. One
    // receipt still covers the whole ledger segment. Each chunk gets its own
    // budget, armed across that chunk's header AND body read: a shared budget
    // would let the earlier chunks spend it and abort a slow-but-progressing
    // send mid-batch, settling the tail unknown (#17173 R10).
    let delivered = 0;
    for (const chunk of splitChunks(text)) {
      // No aggregate ceiling on purpose: each chunk is already capped at its
      // own 30s budget, so an aggregate cap could only refuse chunks that
      // answered inside that budget — a bound on healthy sends, not on an
      // unbounded tick. A send that outlives the claim lease is reconciled to
      // unknown, but a late receipt moves unknown → partial → delivered, so
      // the ledger converges while the tail keeps arriving. Refusing the tail
      // instead strands it at unknown for good; #17529 has the full trace.
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), WEBHOOK_TIMEOUT_MS);
      try {
        await postTextChunk(webhook, chunk, abort.signal, dispatcher);
        delivered += 1;
      } catch (error) {
        // A definitive refusal after a chunk was already delivered means the
        // segment is partially delivered, not never sent. Classify it unknown
        // (re-drivable by receipt replay) rather than rejected, so the ledger
        // does not record a half-delivered reply as never sent and the resend
        // path does not re-send the half the user already has.
        if (delivered > 0 && (error as DingtalkWebhookFailure).definitive) {
          (error as DingtalkWebhookFailure).definitive = false;
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    await dispatcher?.destroy().catch(() => undefined);
  }
}

async function postTextChunk(
  webhook: string,
  content: string,
  signal: AbortSignal,
  dispatcher?: import('undici').Dispatcher,
): Promise<void> {
  let response: Response;
  try {
    const init: RequestInit & { dispatcher?: import('undici').Dispatcher } = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content } }),
      signal,
      redirect: 'error',
    };
    if (dispatcher) init.dispatcher = dispatcher;
    response = await fetch(webhook, init);
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
export function createManagedDingtalkDeps(
  proxy?: string,
): ManagedDingtalkAdapterDeps {
  return {
    createStreamClient,
    sendWebhook: (webhook, text) => sendWebhook(webhook, text, proxy),
    lock: async (directory, onCompromised) => {
      const { default: lockfile } = await import('proper-lockfile');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      return lockfile.lock(directory, { retries: 0, onCompromised });
    },
  };
}
