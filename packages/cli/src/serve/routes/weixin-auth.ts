/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type { Application, RequestHandler, Response } from 'express';
import {
  clearAccount,
  DEFAULT_BASE_URL,
  loadAccount,
  saveAccount,
} from '@qwen-code/channel-weixin/accounts';
import { startLogin, waitForLogin } from '@qwen-code/channel-weixin/login';
import type {
  DaemonWeixinAccountStatus,
  DaemonWeixinLoginFlow,
} from '@qwen-code/sdk/daemon';

/** Concurrent flows are capped; each one polls the upstream once a second. */
const MAX_FLOWS = 4;
/**
 * How long a terminal view stays readable so a polling client can observe it.
 * Exported for the contract case that pins it against the documented window:
 * the behavioural test drives the seam, which would not notice this default
 * being shortened.
 */
export const TERMINAL_RETENTION_MS = 60_000;
/**
 * How long a live flow may go unpolled before it is treated as abandoned.
 *
 * Sized against the worst gap between two polls the daemon actually serves,
 * not against the poll cadence. The panel schedules its next poll only after
 * the previous one settles, and each request carries its own 15 s budget, so
 * one stalled request alone puts 16.5 s between served polls. A hidden tab is
 * worse: Chromium throttles a page hidden for five minutes to one timer per
 * minute, so a backgrounded login can go ~75 s without a served poll. Reaping
 * inside either window would cancel a login the operator is still watching,
 * and the panel would take the 404 path back to "Not logged in" with no error.
 *
 * 120 s clears both and still reaps an orphan four times over before its 480 s
 * login deadline. Exported for the contract test that reads the client's two
 * constants and checks them against this one.
 */
export const UNWATCHED_FLOW_MS = 120_000;

const TERMINAL_STATUSES = new Set<DaemonWeixinLoginFlow['status']>([
  'ready',
  'expired',
  'error',
]);

export interface RegisterWeixinAuthRoutesOptions {
  /**
   * Test seam only. Production wiring passes nothing and no request field can
   * override it: a caller-supplied upstream URL would turn login into SSRF.
   */
  apiBaseUrl?: string;
  /** Test seam only, for the same reason: it shortens the abandonment bound. */
  unwatchedFlowMs?: number;
  /** Test seam only, for the same reason: it shortens the retention window. */
  terminalRetentionMs?: number;
}

interface WeixinFlow {
  view: DaemonWeixinLoginFlow;
  controller: AbortController;
  timer: NodeJS.Timeout | undefined;
  watchdog: NodeJS.Timeout | undefined;
}

function noStore(res: Response): void {
  res.setHeader('Cache-Control', 'no-store');
}

/**
 * Block-glyph QR for the browser, following the Local Control route. Rendering
 * is best-effort: an over-capacity URL must not fail the flow, because the view
 * still carries `qrcodeUrl` and the operator can open it directly.
 */
async function renderQr(url: string | undefined): Promise<string | undefined> {
  if (!url) return undefined;
  try {
    const { default: qrcode } = (await import('qrcode-terminal')) as {
      default: typeof import('qrcode-terminal');
    };
    qrcode.setErrorLevel('Q');
    let text: string | undefined;
    qrcode.generate(url, { small: true }, (code) => {
      text = code.trimEnd();
    });
    return text;
  } catch {
    return undefined;
  }
}

// Process-global account credentials belong to the daemon's home, never a
// workspace runtime: one account.json is shared by every weixin channel in
// every workspace, so a workspace-scoped route writing it would let one
// workspace replace another's account.
export function registerWeixinAuthRoutes(
  app: Application,
  mutate: (opts?: { strict?: boolean }) => RequestHandler,
  options: RegisterWeixinAuthRoutesOptions = {},
): () => void {
  const apiBaseUrl = options.apiBaseUrl ?? DEFAULT_BASE_URL;
  const unwatchedFlowMs = options.unwatchedFlowMs ?? UNWATCHED_FLOW_MS;
  const terminalRetentionMs =
    options.terminalRetentionMs ?? TERMINAL_RETENTION_MS;
  const flows = new Map<string, WeixinFlow>();
  let disposed = false;

  const allowed: RequestHandler = (_req, res, next) => {
    if (disposed) {
      res.status(404).json({ code: 'weixin_unavailable' });
      return;
    }
    next();
  };

  const cancel = (id: string) => {
    const flow = flows.get(id);
    if (!flow) return;
    flow.controller.abort();
    clearTimeout(flow.timer);
    clearTimeout(flow.watchdog);
    flows.delete(id);
  };

  // A client that vanishes after the 201 — a page reload, not a closing dialog
  // — never sends DELETE and `res.on('close')` cannot fire once the response is
  // out. Its id is lost, so nothing else can reach the flow: it would hold a
  // live slot and poll the upstream for its whole deadline. Every poll re-arms
  // this, so only a flow nobody watches is reaped.
  const armWatchdog = (id: string, flow: WeixinFlow) => {
    clearTimeout(flow.watchdog);
    flow.watchdog = setTimeout(() => cancel(id), unwatchedFlowMs);
    flow.watchdog.unref();
  };

  app.get('/auth/weixin', (_req, res) => {
    noStore(res);
    let account: ReturnType<typeof loadAccount>;
    try {
      account = loadAccount();
    } catch {
      // `loadAccount` reaches `getStateDir`, whose mkdir is outside its own
      // try, so a read-only home throws here. The write paths already answer a
      // stable code for that environment; a bare 500 would reach the panel as
      // an English stack trace. Not 404 — the client reads that as "this daemon
      // has no WeChat support".
      res.status(502).json({ code: 'credentials_error' });
      return;
    }
    const status: DaemonWeixinAccountStatus = {
      enabled: !disposed,
      configured: account !== null,
      ...(account?.userId ? { userId: account.userId } : {}),
      ...(account?.savedAt ? { savedAt: account.savedAt } : {}),
    };
    res.status(200).json(status);
  });

  app.post(
    '/auth/weixin/flows',
    mutate({ strict: true }),
    allowed,
    async (_req, res) => {
      // Count live flows, not map entries. A terminal view is kept for
      // TERMINAL_RETENTION_MS so a polling client can still read it, and four
      // *finished* logins must not refuse a fifth start with nothing running.
      const live = [...flows.values()].filter(
        (entry) => !TERMINAL_STATUSES.has(entry.view.status),
      ).length;
      if (live >= MAX_FLOWS) {
        res.status(429).json({ code: 'too_many_flows' });
        return;
      }
      const id = randomUUID();
      const controller = new AbortController();
      const flow: WeixinFlow = {
        view: { id, status: 'waiting' },
        controller,
        timer: undefined,
        watchdog: undefined,
      };

      // Reserve the slot before awaiting the upstream mint. Checking the cap
      // and registering across an await lets concurrent starts all pass the
      // check and then all register, exceeding MAX_FLOWS.
      flows.set(id, flow);

      // If the client goes away before the mint answers, it never learns this
      // id and so can never cancel it — the flow would hold a slot and poll
      // the upstream for its whole deadline with nobody able to stop it. A
      // tab refresh during login is enough to trigger that. `writableEnded`
      // keeps the normal path (response already sent) out of this.
      res.on('close', () => {
        if (!res.writableEnded) cancel(id);
      });

      let qrcodeId: string;
      try {
        const qr = await startLogin(apiBaseUrl, { signal: controller.signal });
        // Without a scannable URL the flow has nothing to show: the operator
        // could neither scan nor open a link, and a live flow renders no
        // retry action, so it would sit dead until the deadline. Treat it like
        // a failed mint. The encoder failing is different and stays tolerated
        // below — qrcodeUrl is what makes the flow usable, not the rendering.
        if (!qr.qrcodeUrl) throw new Error('QR code has no scannable URL');
        qrcodeId = qr.qrcodeId;
        flow.view = {
          id,
          status: 'waiting',
          qrcodeUrl: qr.qrcodeUrl,
          qrText: await renderQr(qr.qrcodeUrl),
        };
      } catch {
        // A failed mint releases its slot rather than occupying the cap.
        flows.delete(id);
        res.status(502).json({ code: 'qr_unavailable' });
        return;
      }
      noStore(res);
      res.status(201).json(flow.view);
      armWatchdog(id, flow);

      const finish = (view: DaemonWeixinLoginFlow) => {
        clearTimeout(flow.timer);
        // Terminal views are governed by the retention timer, not by whether
        // anyone is still reading them.
        clearTimeout(flow.watchdog);
        flow.view = view;
        flow.timer = setTimeout(() => cancel(id), terminalRetentionMs);
        flow.timer.unref();
      };

      void waitForLogin({
        qrcodeId,
        apiBaseUrl,
        signal: controller.signal,
        onEvent: (event) => {
          if (event.type === 'scanned') {
            flow.view = { ...flow.view, status: 'scanned' };
            return;
          }
          if (event.type === 'expired') {
            // The QR is dead now, and the replacement mint can take up to its
            // own bound — or never publish one at all. Stop advertising the
            // dead code as scannable while that is in flight.
            flow.view = {
              id,
              status: 'waiting',
              qrText: undefined,
              qrcodeUrl: undefined,
            };
            return;
          }
          if (event.type === 'qrcode') {
            void renderQr(event.qrcodeUrl).then((qrText) => {
              if (controller.signal.aborted) return;
              flow.view = {
                ...flow.view,
                status: 'waiting',
                qrcodeUrl: event.qrcodeUrl,
                qrText,
              };
            });
          }
        },
      })
        .then((result) => {
          if (controller.signal.aborted) return;
          if (result.connected && result.token) {
            try {
              saveAccount({
                token: result.token,
                baseUrl: result.baseUrl || apiBaseUrl,
                userId: result.userId,
                savedAt: new Date().toISOString(),
              });
            } catch {
              finish({ id, status: 'error', errorCode: 'credentials_error' });
              return;
            }
            // The token is consumed by the save and never enters the view.
            finish({ id, status: 'ready' });
            return;
          }
          if (result.reason === 'expired') {
            finish({ id, status: 'expired', errorCode: 'qr_expired' });
            return;
          }
          finish({ id, status: 'error', errorCode: 'login_failed' });
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          finish({ id, status: 'error', errorCode: 'login_failed' });
        });
    },
  );

  app.get('/auth/weixin/flows/:id', allowed, (req, res) => {
    const id = req.params['id'] ?? '';
    const flow = flows.get(id);
    if (!flow) {
      res.status(404).json({ code: 'flow_not_found' });
      return;
    }
    if (!TERMINAL_STATUSES.has(flow.view.status)) armWatchdog(id, flow);
    noStore(res);
    res.status(200).json(flow.view);
  });

  app.delete(
    '/auth/weixin/flows/:id',
    mutate({ strict: true }),
    allowed,
    (req, res) => {
      cancel(req.params['id'] ?? '');
      res.status(204).end();
    },
  );

  app.post(
    '/auth/weixin/revoke',
    mutate({ strict: true }),
    allowed,
    (_req, res) => {
      for (const id of [...flows.keys()]) cancel(id);
      try {
        clearAccount();
      } catch {
        res.status(502).json({ code: 'credentials_error' });
        return;
      }
      res.status(204).end();
    },
  );

  return () => {
    disposed = true;
    for (const id of [...flows.keys()]) cancel(id);
  };
}
