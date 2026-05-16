/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import express from 'express';
import type { Application } from 'express';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import { bearerAuth, denyBrowserOriginCors, hostAllowlist } from './auth.js';
import { isLoopbackBind } from './loopbackBinds.js';
import {
  canonicalizeWorkspace,
  createHttpAcpBridge,
  InvalidPermissionOptionError,
  MAX_WORKSPACE_PATH_LENGTH,
  SessionLimitExceededError,
  SessionNotFoundError,
  WorkspaceMismatchError,
  type HttpAcpBridge,
} from './httpAcpBridge.js';
import {
  getAdvertisedServeFeatures,
  getServeProtocolVersions,
} from './capabilities.js';
import { SubscriberLimitExceededError, type BridgeEvent } from './eventBus.js';
import {
  CAPABILITIES_SCHEMA_VERSION,
  type CapabilitiesEnvelope,
  type ServeOptions,
} from './types.js';

export interface ServeAppDeps {
  /** Bridge instance; tests inject a fake. Defaults to a fresh real one. */
  bridge?: HttpAcpBridge;
  /**
   * Pre-canonicalized workspace path. When supplied, `createServeApp`
   * skips its own `canonicalizeWorkspace` call (which would issue a
   * redundant `realpathSync.native` syscall — idempotent, but a hot
   * boot-time stat we can avoid). `runQwenServe` passes this after
   * its own boot-time canonicalize so the value used by
   * `/capabilities`, the `POST /session` cwd fallback, and the
   * bridge are all the SAME canonical form. Callers that haven't
   * canonicalized yet (tests, direct embeds) omit this and
   * `createServeApp` falls back to canonicalizing `opts.workspace ??
   * process.cwd()` itself.
   */
  boundWorkspace?: string;
}

/**
 * Build the Express app for `qwen serve`. Pure function — no side effects on
 * the network or process; `runQwenServe` does the listen/signal handling.
 *
 * `getPort` is invoked lazily by the host-allowlist middleware so callers
 * binding to port 0 (ephemeral) can supply the actual port after `listen()`
 * resolves. Defaults to `opts.port` for callers (e.g. tests) that pin a port
 * up front.
 *
 * Stage 1 routes shipped (matches §04 of issue #3803):
 *   - `GET  /health`
 *   - `GET  /capabilities`
 *   - `POST /session`
 *   - `GET  /workspace/:id/sessions`
 *   - `POST /session/:id/prompt`
 *   - `POST /session/:id/cancel`
 *   - `POST /session/:id/model`
 *   - `GET  /session/:id/events` (SSE)
 *   - `POST /permission/:requestId`
 *
 * **Workspace validation contract.** `createServeApp` itself does NOT
 * verify that `opts.workspace` exists or is a directory — it
 * canonicalizes via `canonicalizeWorkspace`, which falls back to
 * `path.resolve` on ENOENT so the app boots even against a missing
 * path. `runQwenServe` is the production entry point and DOES
 * perform the `fs.statSync` + `isDirectory()` boot-loud check before
 * calling this function. Tests inject synthetic paths (`/work/bound`
 * etc.) on purpose: they want to exercise the route layer's
 * canonicalization and `workspace_mismatch` translation without
 * needing a real directory on disk. If a future entry point binds
 * `createServeApp` directly to user input, it MUST replicate the
 * `runQwenServe` validation (or call into a shared helper if one is
 * extracted) — otherwise a non-existent `--workspace` would boot
 * a "healthy"-looking daemon whose every spawn fails with cryptic
 * child-process ENOENT.
 */
export function createServeApp(
  opts: ServeOptions,
  getPort: () => number = () => opts.port,
  deps: ServeAppDeps = {},
): Application {
  const app = express();
  // Forward `maxSessions` into the default-constructed bridge so
  // direct callers of `createServeApp` (tests, embeds) get the same
  // cap they configured via `ServeOptions`. Previously the default
  // bridge silently fell back to `DEFAULT_MAX_SESSIONS` (20) and
  // only the `runQwenServe` path piped the option through.
  //
  // Workspace binding mirrors `runQwenServe`: per #3803 §02 the
  // daemon is bound to exactly one workspace (`opts.workspace` or
  // `process.cwd()`). `POST /session` with a mismatched cwd is
  // rejected with 400 `workspace_mismatch`.
  //
  // The value advertised on `/capabilities`, used for the `POST
  // /session` cwd fallback, AND passed into the bridge must be the
  // SAME canonical form — otherwise the bridge's
  // `realpathSync.native` would diverge from what `/capabilities`
  // shows on symlinks / case-insensitive filesystems, and clients
  // echoing the advertised path back would see a response whose
  // `workspaceCwd` differs from what they sent.
  //
  // `deps.boundWorkspace` is the pre-canonicalized fast-path —
  // `runQwenServe` passes it after its own boot-time
  // `canonicalizeWorkspace`, so we skip the redundant
  // `realpathSync.native` here. When omitted (tests, direct embeds)
  // we canonicalize ourselves.
  const boundWorkspace =
    deps.boundWorkspace ??
    canonicalizeWorkspace(opts.workspace ?? process.cwd());
  const bridge =
    deps.bridge ??
    createHttpAcpBridge({
      maxSessions: opts.maxSessions,
      boundWorkspace,
    });

  // Order matters: rejection guards (CORS / Host allowlist / bearer auth)
  // run BEFORE the JSON body parser. Otherwise an unauthenticated POST
  // gets a full 10MB `JSON.parse` before the 401 fires — a trivially
  // amplified CPU/memory cost from any wrong-token client.
  app.use(denyBrowserOriginCors);
  app.use(hostAllowlist(opts.hostname, getPort));

  // `/health` is exempted from `bearerAuth` ONLY on loopback binds —
  // the canonical liveness-probe case (k8s/Compose probes don't
  // carry the daemon's bearer; round-tripping a 401 just to know
  // the listener is up is waste). On non-loopback binds the
  // exemption becomes a low-severity info leak (attacker can probe
  // arbitrary IP:port to confirm a `qwen serve` is listening), so
  // we register `/health` AFTER `bearerAuth` and let it 401 like
  // every other route. Operators using the loopback default get the
  // probe-friendly behavior; operators exposing the daemon publicly
  // gate `/health` behind their token alongside everything else.
  // CORS deny + Host allowlist still apply to `/health` in both
  // cases.
  // Shared handler so loopback (pre-auth) and non-loopback (post-auth)
  // routes return the same shape. `?deep=1` exposes bridge counters
  // (`sessions`, `pendingPermissions`) for observability — it is
  // INFORMATIONAL only, not a true liveness probe. Counter getters
  // are size accessors that don't perform per-session/channel pings,
  // so a wedged child (stuck on a request, leaked FD, etc.) won't
  // change the response. We retain the try/catch + 503 as a
  // defense-in-depth net for custom bridge impls whose getters MAY
  // throw — but the real bridge's getters never do, so under normal
  // operation the 503 path is unreachable. Per BQ-6F: the docs
  // (`docs/users/qwen-serve.md` + `qwen-serve-protocol.md`) clarify
  // that deep is for counters, not health verification. Default (no
  // query) stays cheap so high-frequency liveness probes don't load
  // the bridge.
  const healthHandler = (
    req: import('express').Request,
    res: import('express').Response,
  ): void => {
    const deepQuery = req.query['deep'];
    const deep = deepQuery === '1' || deepQuery === 'true' || deepQuery === '';
    if (!deep) {
      res.status(200).json({ status: 'ok' });
      return;
    }
    try {
      res.status(200).json({
        status: 'ok',
        sessions: bridge.sessionCount,
        pendingPermissions: bridge.pendingPermissionCount,
      });
    } catch (err) {
      writeStderrLine(
        `qwen serve: /health deep probe failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      res.status(503).json({ status: 'degraded' });
    }
  };

  const loopback = isLoopbackBind(opts.hostname);
  if (loopback) {
    app.get('/health', healthHandler);
  }

  app.use(bearerAuth(opts.token));
  app.use(express.json({ limit: '10mb' }));

  if (!loopback) {
    // Non-loopback: register `/health` AFTER `bearerAuth` so probes
    // must carry the token. Otherwise unauthenticated callers can
    // ping any reachable address:port to confirm a daemon exists.
    app.get('/health', healthHandler);
  }

  app.get('/capabilities', (_req, res) => {
    const envelope: CapabilitiesEnvelope = {
      v: CAPABILITIES_SCHEMA_VERSION,
      protocolVersions: getServeProtocolVersions(),
      mode: opts.mode,
      features: getAdvertisedServeFeatures(),
      modelServices: [],
      // #3803 §02: surface the bound workspace so clients can detect
      // mismatch pre-flight and omit `cwd` on `POST /session`.
      workspaceCwd: boundWorkspace,
    };
    res.status(200).json(envelope);
  });

  app.post('/session', async (req, res) => {
    const body = safeBody(req);
    // #3803 §02: 1 daemon = 1 workspace. Three input shapes:
    //   - `cwd` ABSENT from body → fall back to the daemon's bound
    //     workspace (the §02 documented shape — clients pre-flight
    //     `caps.workspaceCwd` and may then omit `cwd`).
    //   - `cwd` PRESENT but not a string → 400 malformed. A
    //     client/orchestrator serialization bug (`cwd: null`,
    //     `cwd: 123`, `cwd: {}`) must not silently bind a session
    //     to the daemon's workspace; surface the bug instead.
    //   - `cwd` PRESENT as a string → fall through to the
    //     `path.isAbsolute` check (empty string and relative both
    //     fail there with "must be an absolute path when provided").
    //
    // `safeBody` returns an `Object.create(null)` map, so
    // `'cwd' in body` reflects exactly "did the client send the
    // key?" without prototype-chain confusion. The presence-check
    // is safe as long as `PROTOTYPE_POLLUTION_KEYS` doesn't grow to
    // include `cwd` — see the cross-reference in the const's JSDoc
    // for what to do if that invariant ever has to break.
    const hasCwd = 'cwd' in body;
    if (hasCwd && typeof body['cwd'] !== 'string') {
      res
        .status(400)
        .json({ error: '`cwd` must be a string absolute path when provided' });
      return;
    }
    // Length cap BEFORE assignment so a multi-MB `cwd` body can't
    // amplify through downstream interpolations
    // (`WorkspaceMismatchError`'s `.message` echoes `requested` twice;
    // `sendBridgeError` writes it to stderr; `res.json` echoes it
    // again). On the loopback-default-no-token deployment shape this
    // is pre-auth, so a 10 MB cwd body — right under
    // `express.json({limit: '10mb'})` — would otherwise cost
    // ~60 MB per request × `maxConnections` (default 256). The
    // `MAX_WORKSPACE_PATH_LENGTH` constant matches Linux's PATH_MAX
    // (4096); legitimate filesystem paths fit well under it. The
    // `WorkspaceMismatchError` constructor also truncates as a
    // belt-and-suspenders defense for non-route callers (tests,
    // embeds, future entry points that throw the error directly).
    if (hasCwd && (body['cwd'] as string).length > MAX_WORKSPACE_PATH_LENGTH) {
      res.status(400).json({
        error: `\`cwd\` exceeds the ${MAX_WORKSPACE_PATH_LENGTH}-character limit`,
      });
      return;
    }
    const cwd = hasCwd ? (body['cwd'] as string) : boundWorkspace;
    if (!path.isAbsolute(cwd)) {
      res
        .status(400)
        .json({ error: '`cwd` must be an absolute path when provided' });
      return;
    }
    const modelServiceId =
      typeof body['modelServiceId'] === 'string'
        ? (body['modelServiceId'] as string)
        : undefined;
    try {
      const session = await bridge.spawnOrAttach({
        workspaceCwd: cwd,
        modelServiceId,
      });
      // Client may have disconnected during the 1–3s spawn window. If
      // so, the response can't be delivered. The session is otherwise
      // orphaned (in `byId` / `defaultEntry` with no client knowing the
      // id), and under churn this leaks one child per aborted request.
      //
      // Detect "can we still write the response?" via `res.writable`,
      // which stays true until the SOCKET destination side closes
      // (the right signal for our case). The legacy `req.aborted`
      // only flips while the request body is still being received,
      // so a client that completed the POST and then closed during
      // the spawn would slip past it. `req.destroyed` is too eager
      // — clients (incl. supertest) close their writable end after
      // sending the body even though they're still listening for the
      // response. `res.writable` is the documented signal for
      // "ServerResponse can still send to client".
      //
      // Combined with `!session.attached` we only reap when WE spawned
      // a fresh child for this request — if another client legitimately
      // attached, killing it would tear out their work mid-flight.
      // The disconnect-without-reap branch also needs to skip
      // `res.json` — writing to a closed socket would throw EPIPE
      // through Express's default error handler.
      if (!res.writable) {
        if (!session.attached) {
          // `requireZeroAttaches: true` closes the BQ9tV race: if
          // a second client called `spawnOrAttach` for the same
          // workspace between our `await` resolving and this reap
          // dispatching, the bridge will see `attachCount > 0` and
          // skip the kill. Without the flag, that second client's
          // session would die mid-prompt.
          bridge
            .killSession(session.sessionId, { requireZeroAttaches: true })
            .catch(() => {
              // Best-effort cleanup; channel.exited will eventually reap.
            });
        } else {
          // tanzhenxin issue 2: when an attaching client disconnects
          // before its 200 response can be written, the
          // `attachCount` bump we did inside `spawnOrAttach` is
          // fictitious — there's no live attaching client. Roll the
          // counter back and let the bridge decide whether to reap
          // (it does if attachCount returns to 0 AND no live SSE
          // subscribers). Without this, both-coalesced-callers-
          // disconnect leaves an orphan agent child no client knows
          // the id of.
          bridge.detachClient(session.sessionId).catch(() => {
            // Best-effort cleanup; channel.exited will eventually reap.
          });
        }
        return;
      }
      res.status(200).json(session);
    } catch (err) {
      sendBridgeError(res, err, { route: 'POST /session' });
    }
  });

  app.post('/session/:id/prompt', async (req, res) => {
    const sessionId = req.params['id'];
    const body = safeBody(req);
    const prompt = body['prompt'];
    if (!Array.isArray(prompt) || prompt.length === 0) {
      res.status(400).json({
        error:
          '`prompt` is required and must be a non-empty array of content blocks',
      });
      return;
    }
    if (
      !prompt.every(
        (item: unknown) =>
          // `typeof item === 'object'` is true for arrays too, so an
          // exclude-arrays check is needed to keep the contract
          // ("ACP content block, like {type: 'text', text: '...'}")
          // honest. Without `!Array.isArray(item)`, `prompt: [[]]`
          // passes validation and a confusing 500 surfaces from the
          // ACP SDK layer.
          typeof item === 'object' && item !== null && !Array.isArray(item),
      )
    ) {
      res.status(400).json({
        error: 'each `prompt` element must be an object (content block)',
      });
      return;
    }
    // Propagate HTTP-client disconnect to an ACP cancel notification so
    // the agent winds down promptly and the per-session FIFO doesn't
    // stay blocked on a dead client. Detached after the prompt settles.
    //
    // Use `res.on('close')` (NOT `req.on('close')`) — `IncomingMessage`'s
    // close event fires once the request body has been fully consumed
    // even when the client is still listening for the response, which
    // would cancel every ordinary prompt the moment its upload
    // finished. `ServerResponse`'s close event only fires when the
    // socket goes away. Guard with `!res.writableEnded` so a normal
    // response flush (which also triggers `res.close`) doesn't fire
    // the abort retroactively.
    const abort = new AbortController();
    const onResClose = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.once('close', onResClose);
    try {
      // SECURITY NOTE: this `...(body as object)` passthrough is
      // intentional — the bridge / ACP SDK ignores fields it
      // doesn't recognize (ACP-spec `_meta` etc are forwarded
      // wholesale to the agent, which is the documented behavior).
      // `sessionId` and `prompt` are forced to the route's view to
      // prevent body-spoofing of the routing key. If a future
      // bridge version starts trusting an additional field by name,
      // that field becomes a client-controlled input surface — at
      // that point switch this to an explicit pick. The same
      // pattern repeats on cancel / model below; review them all
      // together when adding new bridge-trusted fields.
      const result = await bridge.sendPrompt(
        sessionId,
        {
          ...(body as object),
          sessionId,
          prompt,
        } as Parameters<HttpAcpBridge['sendPrompt']>[1],
        abort.signal,
      );
      res.status(200).json(result);
    } catch (err) {
      // The HTTP client disconnecting fires the abort path above and
      // the bridge re-throws as `AbortError`. That's a normal
      // wind-down, not an error worth a 500 + stderr stack trace.
      // Drop it silently — the socket is already closed so we can't
      // send a response anyway, and active clients (e.g. an IDE
      // plugin scrubbing a stuck prompt) would otherwise spam the
      // daemon log.
      //
      // BX9_k: narrow the swallow to ONLY the case where WE armed
      // the abort. The earlier blanket `err.name === 'AbortError'`
      // could also swallow an internal bridge abort (e.g. the child
      // process aborting a prompt mid-flight) — leaving the client
      // with no response and no log trace. If `abort.signal.aborted`
      // is false, the AbortError came from somewhere we didn't
      // expect → route it through `sendBridgeError` as a real
      // failure.
      if (
        err instanceof DOMException &&
        err.name === 'AbortError' &&
        abort.signal.aborted
      ) {
        return;
      }
      sendBridgeError(res, err, {
        route: 'POST /session/:id/prompt',
        sessionId,
      });
    } finally {
      res.off('close', onResClose);
    }
  });

  app.post('/session/:id/cancel', async (req, res) => {
    const sessionId = req.params['id'];
    const body = safeBody(req);
    try {
      await bridge.cancelSession(sessionId, {
        ...(body as object),
        sessionId,
      } as Parameters<HttpAcpBridge['cancelSession']>[1]);
      res.status(204).end();
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'POST /session/:id/cancel',
        sessionId,
      });
    }
  });

  app.get('/workspace/:id/sessions', (req, res) => {
    // Express decodes URL-encoded path params automatically; clients pass
    // the absolute workspace cwd encoded (e.g.
    // GET /workspace/%2Fwork%2Fa/sessions).
    const workspaceCwd = req.params['id'] ?? '';
    if (!path.isAbsolute(workspaceCwd)) {
      res
        .status(400)
        .json({ error: '`:id` must decode to an absolute workspace path' });
      return;
    }
    // #3803 §02: reject cross-workspace queries so orchestrators
    // don't mistake "no sessions here" for "workspace is idle".
    const key = canonicalizeWorkspace(workspaceCwd);
    if (key !== boundWorkspace) {
      res.status(400).json({
        error: `Workspace mismatch: daemon is bound to "${boundWorkspace}"`,
        code: 'workspace_mismatch',
        boundWorkspace,
        requestedWorkspace: key,
      });
      return;
    }
    const sessions = bridge.listWorkspaceSessions(workspaceCwd);
    res.status(200).json({ sessions });
  });

  app.post('/session/:id/model', async (req, res) => {
    const sessionId = req.params['id'];
    const body = safeBody(req);
    const modelId = body['modelId'];
    if (typeof modelId !== 'string' || !modelId) {
      res.status(400).json({
        error: '`modelId` is required and must be a non-empty string',
      });
      return;
    }
    try {
      const response = await bridge.setSessionModel(sessionId, {
        ...(body as object),
        sessionId,
        modelId,
      } as Parameters<HttpAcpBridge['setSessionModel']>[1]);
      res.status(200).json(response);
    } catch (err) {
      sendBridgeError(res, err, {
        route: 'POST /session/:id/model',
        sessionId,
      });
    }
  });

  app.post('/permission/:requestId', (req, res) => {
    const requestId = req.params['requestId'];
    const body = safeBody(req);
    const outcome = body['outcome'];
    if (!isValidOutcome(outcome)) {
      res.status(400).json({
        error:
          '`outcome` must be `{ outcome: "cancelled" }` or `{ outcome: "selected", optionId: string }`',
      });
      return;
    }
    let accepted: boolean;
    try {
      accepted = bridge.respondToPermission(requestId, {
        ...(body as object),
        outcome,
      } as Parameters<HttpAcpBridge['respondToPermission']>[1]);
    } catch (err) {
      // BkwQI: voter's `optionId` wasn't in the option set the agent
      // originally offered (e.g. forging `ProceedAlways*` when the
      // prompt's `hideAlwaysAllow` policy suppressed it). 400, not
      // 404 — the requestId IS known, but the chosen option isn't.
      if (err instanceof InvalidPermissionOptionError) {
        res.status(400).json({
          error: err.message,
          code: 'invalid_option_id',
          requestId: err.requestId,
          optionId: err.optionId,
        });
        return;
      }
      throw err;
    }
    if (!accepted) {
      // Either the requestId never existed or another client already won
      // the race. Stage 1 doesn't distinguish — both surface as 404.
      res
        .status(404)
        .json({ error: 'No pending permission request', requestId });
      return;
    }
    res.status(200).json({});
  });

  app.get('/session/:id/events', (req, res) => {
    const sessionId = req.params['id'];
    const lastEventId = parseLastEventId(req.headers['last-event-id']);

    let iter: AsyncIterator<BridgeEvent> | undefined;
    const abort = new AbortController();
    try {
      const iterable = bridge.subscribeEvents(sessionId, {
        signal: abort.signal,
        lastEventId,
      });
      iter = iterable[Symbol.asyncIterator]();
    } catch (err) {
      // `EventBus` throws `SubscriberLimitExceededError` when the
      // per-session subscriber cap (default 64) is reached.
      //
      // Bd1zJ: surface as `429 Too Many Requests` + `Retry-After`
      // header rather than `200 + stream_error`. The previous
      // SSE-shaped response triggered `EventSource`'s
      // auto-reconnect (which honors the `retry:` directive AND
      // default-reconnects on any closed stream). The reconnect hit
      // the same cap, looped, amplifying the exact load the limit
      // exists to prevent.
      //
      // `429` is the standard "back off" signal — browsers'
      // `EventSource` treats `4xx` as terminal and does NOT
      // auto-reconnect on it, unlike `200 + close` which DOES
      // reconnect. Body shape mirrors the SSE frame's data field so
      // a raw-fetch client gets the same structured error.
      if (err instanceof SubscriberLimitExceededError) {
        writeStderrLine(
          `qwen serve: subscriber limit reached for session ${sessionId} (limit=${err.limit}); rejecting new SSE client with 429`,
        );
        res.setHeader('Retry-After', '5');
        res.status(429).json({
          error: err.message,
          code: 'subscriber_limit_exceeded',
          limit: err.limit,
        });
        return;
      }
      sendBridgeError(res, err, {
        route: 'GET /session/:id/events',
        sessionId,
      });
      return;
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Disable proxy buffering (nginx); event-stream content type alone
    // doesn't always reach the client through every proxy.
    res.setHeader('X-Accel-Buffering', 'no');
    // Always present on the supported Node versions (engines.node >=22).
    res.flushHeaders();

    // Backpressure helper: `res.write` returns false when the kernel send
    // buffer is full. Without awaiting `drain` Node accumulates the
    // payload in user-space memory unboundedly — a slow consumer on a
    // chatty session can balloon daemon RSS. Wait for `drain` (or
    // close/error) before scheduling the next write.
    //
    // Concurrency: serialize ALL writes through a per-connection chain
    // so the heartbeat (fire-and-forget interval, see below) can't
    // interleave with the main event-write loop. Without serialization,
    // the heartbeat firing while the main loop is mid-`drain` await
    // would issue a second `res.write()` that bypasses the
    // backpressure guard — and could even interleave bytes between two
    // SSE frames on the wire. The chain is single-flight: each call
    // waits for the previous write to settle before scheduling its own.
    let writeChain: Promise<void> = Promise.resolve();
    const doWrite = (chunk: string): Promise<void> =>
      new Promise((resolve, reject) => {
        if (res.writableEnded) {
          resolve();
          return;
        }
        // `res.write` can throw synchronously when the socket is
        // already destroyed (typical EPIPE shape). Wrap in try/catch
        // so that surfaces as a rejection on this promise instead of
        // escaping the executor and turning into an unhandled
        // exception. Async failures still arrive via the `'error'`
        // event handler below — Node's Writable.write callback isn't
        // documented to receive an error argument (errors come on
        // the event), so we don't rely on it.
        let ok: boolean;
        try {
          ok = res.write(chunk);
        } catch (err) {
          reject(err);
          return;
        }
        if (ok) {
          resolve();
          return;
        }
        const onDrain = () => {
          res.off('close', onClose);
          res.off('error', onError);
          resolve();
        };
        const onClose = () => {
          res.off('drain', onDrain);
          res.off('error', onError);
          resolve();
        };
        const onError = (err: Error) => {
          res.off('drain', onDrain);
          res.off('close', onClose);
          reject(err);
        };
        res.once('drain', onDrain);
        res.once('close', onClose);
        res.once('error', onError);
      });
    const writeWithBackpressure = (chunk: string): Promise<void> => {
      const next = writeChain.then(() => doWrite(chunk));
      // Tail-swallow rejections on the chain itself so a single failed
      // write doesn't poison every subsequent call. The CALLER's
      // returned promise still rejects — chain-internal failures are
      // someone else's problem, not blockers for queueing.
      writeChain = next.catch(() => undefined);
      return next;
    };

    // Tell EventSource to retry after 3s on disconnect. Awaiting drain on
    // the very first write is overkill but cheap — `ok` is true the
    // overwhelming majority of the time. Always swallow rejection: a
    // socket that errors before the very first write would otherwise
    // surface as an unhandled promise rejection (the `res.on('error')`
    // hook below is what we actually rely on for cleanup).
    void writeWithBackpressure('retry: 3000\n\n').catch(() => {});

    // Heartbeat keeps NAT/proxy connections alive and lets the server
    // notice a dead client through write-back-pressure. Comment frame is
    // ignored by EventSource.
    //
    // KNOWN GAP: this only catches dead connections via write
    // back-pressure on heartbeat itself. A network partition without TCP
    // RST can leave the connection looking alive (no FIN received) for
    // however long Node's keepalive probes take to time out — usually
    // ~2 hours by default, configurable via `server.keepAliveTimeout`.
    // Stage 2 may add an explicit application-level idle timeout
    // (last-byte-written tracking + per-connection deadline).
    const heartbeatTimer = setInterval(() => {
      if (!res.writableEnded) {
        // Heartbeat writes are best-effort; failure swallowed via the
        // `res.on('error')` hook below.
        void writeWithBackpressure(': heartbeat\n\n').catch(() => {});
      }
    }, 15_000);
    heartbeatTimer.unref();

    const cleanup = () => {
      clearInterval(heartbeatTimer);
      abort.abort();
    };
    req.on('close', cleanup);
    // Swallow socket-level write errors. When the underlying TCP connection
    // dies (RST, mid-flight kill -9), the next `res.write` throws EPIPE.
    // Without an `error` listener Express forwards it to its default error
    // handler which logs noisily. The req.on('close') path above is what we
    // actually rely on to tear down the subscription; this listener just
    // suppresses the noise + ensures cleanup runs even if for some reason
    // the close event doesn't fire first.
    res.on('error', (err) => {
      // Without this log the daemon side is blind to SSE disconnects
      // (RST, mid-flight kill -9, network blip). Cleanup still runs —
      // the listener exists primarily so Node doesn't crash on EPIPE
      // — but operators get a breadcrumb when chasing flaky clients.
      writeStderrLine(
        `qwen serve: SSE socket error (session ${sessionId}): ${err.message}`,
      );
      cleanup();
    });

    void (async () => {
      try {
        while (true) {
          const next = await iter!.next();
          if (next.done) break;
          if (res.writableEnded) break;
          await writeWithBackpressure(formatSseFrame(next.value));
        }
      } catch (err) {
        if (!res.writableEnded) {
          // Don't burn an `id:` slot — `stream_error` is a terminal frame
          // emitted on the daemon side when the bridge iterator throws, so
          // it has no place in the per-session monotonic sequence and a
          // hard-coded `id: 0` would regress the client's `Last-Event-ID`
          // tracker. `formatSseFrame` omits the `id:` line when the input
          // event has no id.
          await writeWithBackpressure(
            formatSseFrame({
              v: 1,
              type: 'stream_error',
              data: { error: errorMessage(err) },
            }),
          ).catch(() => {});
        }
      } finally {
        cleanup();
        if (!res.writableEnded) res.end();
      }
    })();
  });

  // Final error handler. `express.json()` throws `SyntaxError` (with
  // `status: 400`) on malformed body — without this 4-arg middleware
  // Express renders an HTML error page, which trips SDK clients that
  // expect a JSON body on every response. Anything else bubbling out
  // is a programmer error; log it and return a JSON 500 (matches the
  // route-level `sendBridgeError` shape so clients have one error
  // contract to parse).
  app.use(
    (
      err: unknown,
      _req: import('express').Request,
      res: import('express').Response,
      _next: import('express').NextFunction,
    ) => {
      if (
        err instanceof SyntaxError &&
        'status' in err &&
        (err as { status: number }).status === 400
      ) {
        res.status(400).json({ error: 'Invalid JSON in request body' });
        return;
      }
      // body-parser raises a typed error with `status: 413` when a
      // request body exceeds the `express.json({ limit: '10mb' })`
      // ceiling. Without this branch it falls through to the 500 path
      // and clients see a misleading "Internal server error" instead
      // of a clear "payload too large" — which is the kind of error
      // they can actually act on (chunk the request, raise the limit).
      if (
        err &&
        typeof err === 'object' &&
        'status' in err &&
        (err as { status: number }).status === 413
      ) {
        res.status(413).json({ error: 'Request body too large (max 10 MB)' });
        return;
      }
      writeStderrLine(
        `qwen serve: unhandled error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      );
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    },
  );

  return app;
}

/**
 * Keys stripped by `safeBody` to defend against prototype-pollution
 * — see BZ9uv/va/vs/wD/Bd1zz. Routes downstream of `safeBody` spread
 * the filtered result into objects passed to the bridge / ACP SDK;
 * without this scrub a client could set
 * `{"__proto__": {"polluted": true}}` and pollute
 * `Object.prototype` via downstream spreads.
 *
 * **Cross-reference for route maintainers:** the POST `/session`
 * route distinguishes "absent" from "present" via `'cwd' in body`
 * against `safeBody`'s output. The semantics rely on this set NOT
 * overlapping with user-payload keys. If you ever add a key here
 * that a route's presence-check cares about (highly unlikely — this
 * set is the JS prototype-attack triple, plus a route would have
 * to deliberately name a property after one of these), the
 * presence-check needs to move to the pre-`safeBody` `req.body`
 * (with its own pollution guard) or `safeBody` needs to return a
 * separate "raw-keys" set alongside the filtered object.
 */
const PROTOTYPE_POLLUTION_KEYS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);

/**
 * Coerce `req.body` into a safe `Record<string, unknown>` for route
 * handlers. Replaces the 5-site copy-pasted preamble
 * `typeof req.body === 'object' && req.body !== null ? ... : {}`
 * (Bd10m).
 *
 * Strips the `PROTOTYPE_POLLUTION_KEYS` set before returning. Uses an
 * `Object.create(null)` target so the returned object itself has no
 * prototype either, blocking second-order spread-into-default-
 * prototype attacks.
 */
function safeBody(req: import('express').Request): Record<string, unknown> {
  const raw = req.body;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return Object.create(null) as Record<string, unknown>;
  }
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (PROTOTYPE_POLLUTION_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

function isValidOutcome(
  raw: unknown,
): raw is { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string } {
  if (typeof raw !== 'object' || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  if (obj['outcome'] === 'cancelled') return true;
  // `optionId` must be a non-empty string. An empty string is technically a
  // string but isn't a meaningful selection — letting it through would
  // forward malformed votes to the bridge and the agent would reject the
  // unknown option opaquely.
  return (
    obj['outcome'] === 'selected' &&
    typeof obj['optionId'] === 'string' &&
    (obj['optionId'] as string).length > 0
  );
}

function parseLastEventId(raw: unknown): number | undefined {
  // Stricter than Number.parseInt: only accept pure decimal digits to avoid
  // values like "1abc" or "1.5e10z" silently parsing to 1.
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    // BX9_I: log a breadcrumb for the operator when a non-empty
    // header is rejected. The client resumed from event 0 instead
    // of where they meant to — without this line, the loss of
    // every event buffered during their disconnect was invisible.
    // Skip the log for missing / empty headers (the common case of
    // "first connect, no resume").
    if (typeof raw === 'string' && raw.length > 0) {
      writeStderrLine(
        `qwen serve: rejected Last-Event-ID "${raw.slice(0, 80)}" ` +
          `(not a decimal integer)`,
      );
    }
    return undefined;
  }
  const n = Number.parseInt(raw, 10);
  // Reject values that lose precision as a JS `number`. The bus's monotonic
  // ids are bounded by `Number.MAX_SAFE_INTEGER` (2^53 - 1); a client that
  // tries to resume from beyond that is either malicious or broken.
  if (!Number.isFinite(n) || n > Number.MAX_SAFE_INTEGER) {
    writeStderrLine(
      `qwen serve: rejected Last-Event-ID "${raw.slice(0, 80)}" ` +
        `(exceeds Number.MAX_SAFE_INTEGER)`,
    );
    return undefined;
  }
  return n;
}

function formatSseFrame(event: BridgeEvent | OmitId<BridgeEvent>): string {
  // SSE format: id (optional), event (optional), data, blank line.
  // The `id:` line is intentionally omitted when `event.id` is absent —
  // terminal/synthetic frames (e.g. daemon-side `stream_error`) must not
  // burn a slot in the per-session monotonic sequence the client uses for
  // `Last-Event-ID` reconnect tracking.
  //
  // We always emit the payload as a single `data:` line. The EventSource
  // spec also allows a frame to span multiple `data:` lines (which a
  // conformant parser joins with `\n`); we don't emit that form because
  // our payload is JSON without embedded newlines after `JSON.stringify`.
  // The SDK parser at `sdk-typescript/src/daemon/sse.ts` handles the
  // multi-line variant on the receive side — input/output asymmetry is
  // intentional.
  const dataJson = JSON.stringify(event);
  const idLine =
    'id' in event && event.id !== undefined ? `id: ${event.id}\n` : '';
  return `${idLine}event: ${event.type}\ndata: ${dataJson}\n\n`;
}

type OmitId<T> = Omit<T, 'id'>;

/**
 * Map a thrown bridge error to an HTTP response.
 *
 * `ctx` is operator-facing: route + sessionId folded into the stderr
 * log line so a bare `ECONNRESET` / `ENOMEM` stack trace is
 * attributable to a specific session and request without having to
 * timestamp-correlate against client logs. Pass via the route handlers
 * — see how they call `sendBridgeError(res, err, { route: 'POST
 * /session/:id/prompt', sessionId })`. Optional so test/dev call
 * sites that don't care about the log can omit it.
 */
function sendBridgeError(
  res: import('express').Response,
  err: unknown,
  ctx?: { route?: string; sessionId?: string },
): void {
  if (err instanceof SessionNotFoundError) {
    res.status(404).json({ error: err.message, sessionId: err.sessionId });
    return;
  }
  if (err instanceof WorkspaceMismatchError) {
    // #3803 §02 single-workspace mode: the daemon binds to one
    // workspace at boot; cross-workspace POSTs are rejected here.
    // 400 (not 404 — the daemon is "fine", the client just picked
    // the wrong daemon for their workspace). Body includes both
    // paths so orchestrator-aware clients can route to the right
    // daemon / spawn a new one.
    //
    // Operator log line: unlike SessionNotFoundError (per-session
    // 404 with rich URL context), workspace_mismatch indicates an
    // orchestration / deployment drift (operator booted with the
    // wrong workspace, or client is routing to the wrong daemon).
    // Without a breadcrumb the daemon's log looks healthy while
    // every client request silently 400s. Limited to authenticated
    // requests by the upstream bearer-token gate, so probing-DoS
    // log noise stays bounded.
    // SECURITY: `err.requested` is derived from the request body
    // (`req.workspaceCwd` → `canonicalizeWorkspace` → here). `path.resolve`
    // + `realpathSync.native` both preserve control characters inside
    // path segments — they only normalize separators / `..` / `.` and
    // walk symlinks. A body like `{"cwd": "/legit/path\nqwen serve:
    // FAKE LOG LINE"}` would otherwise emit two valid-looking daemon
    // log lines, weaponizing line-based log shippers (Splunk / Loki /
    // journald → SIEM). `JSON.stringify` escapes control chars and
    // wraps in quotes so any injection attempt surfaces as
    // visible-as-quoted-noise rather than forged-line. `err.bound` is
    // safe (canonicalized at boot from operator-controlled
    // `--workspace` / `process.cwd()`) but quoted symmetrically for
    // readability.
    writeStderrLine(
      `qwen serve: workspace_mismatch (POST /session): ` +
        `daemon bound to ${JSON.stringify(err.bound)}, ` +
        `rejected ${JSON.stringify(err.requested)}`,
    );
    res.status(400).json({
      error: err.message,
      code: 'workspace_mismatch',
      boundWorkspace: err.bound,
      requestedWorkspace: err.requested,
    });
    return;
  }
  if (err instanceof SessionLimitExceededError) {
    // 503 Service Unavailable + `Retry-After` is the canonical
    // "we'd serve you, but we're full right now" shape. The hint
    // is intentionally conservative (5s) because a session that
    // finishes a prompt frees a slot quickly under normal load;
    // a client that backs off too aggressively wastes capacity.
    res.set('Retry-After', '5');
    res.status(503).json({
      error: err.message,
      code: 'session_limit_exceeded',
      limit: err.limit,
    });
    return;
  }
  // 5xx is the kind of error operators need to see in their daemon log
  // — bridge ENOMEM, agent stack trace, unexpected throw, etc. Without
  // logging here every 500 disappears once the caller consumes the
  // response body. This is a stop-gap until structured access/error
  // logging lands (tracked under §10 follow-ups). Use the stdio helper
  // (not `console.error`) to keep the no-console lint rule happy and
  // route through the same writer the rest of the daemon uses.
  const ctxParts = [
    ctx?.route,
    ctx?.sessionId ? `session=${ctx.sessionId}` : undefined,
  ].filter(Boolean);
  const ctxStr = ctxParts.length > 0 ? ` (${ctxParts.join(' ')})` : '';
  writeStderrLine(
    `qwen serve: bridge error${ctxStr}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
  res.status(500).json(errorPayload(err));
}

/**
 * Coerce an arbitrary thrown value to a useful string. Plain `String(err)`
 * yields `[object Object]` for JSON-RPC-shaped errors (`{code, message,
 * data}`) which are exactly what the ACP SDK forwards from the agent. Try
 * the `message` field first, fall back to JSON-stringify, then `String`.
 */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const maybe = (err as { message?: unknown }).message;
    if (typeof maybe === 'string' && maybe.length > 0) return maybe;
    try {
      return JSON.stringify(err);
    } catch {
      /* fall through */
    }
  }
  return String(err);
}

/**
 * Build the JSON body for a 5xx response. The ACP SDK forwards
 * JSON-RPC-shaped errors like `{code: -32000, message: "Internal error",
 * data: {reason: "model quota exceeded"}}` — discarding `code`/`data`
 * collapses every distinct failure (quota / rate-limit / auth /
 * crash) to the same opaque `"Internal error"` string at the client.
 * Forward both fields so callers can triage from response body alone.
 * `error` stays as the human-readable string for backward compatibility
 * with clients that only consumed `error` in the original shape.
 *
 * BSA0G acknowledged: forwarding `data` verbatim leaks per-error
 * detail (file paths in upstream tool failures, partial API response
 * snippets, etc.) to every authenticated SSE subscriber that
 * observes 5xx responses. In Stage 1's single-user / small-team
 * trust model (every authenticated client is the same human or
 * collaborators they trust) this is acceptable — and the triage
 * value of the rich error is high. Stage 2 multi-tenant deployments
 * will need an opt-in `--redact-errors` flag (or per-deployment
 * policy hook) that strips `data` and replaces it with an
 * error-class identifier; tracked under #3803 follow-ups.
 */
function errorPayload(err: unknown): {
  error: string;
  code?: unknown;
  data?: unknown;
} {
  const out: { error: string; code?: unknown; data?: unknown } = {
    error: errorMessage(err),
  };
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    if ('code' in obj) out.code = obj['code'];
    if ('data' in obj) out.data = obj['data'];
  }
  return out;
}
