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
/** How long a terminal view stays readable so a polling client can observe it. */
const TERMINAL_RETENTION_MS = 60_000;

export interface RegisterWeixinAuthRoutesOptions {
  /**
   * Test seam only. Production wiring passes nothing and no request field can
   * override it: a caller-supplied upstream URL would turn login into SSRF.
   */
  apiBaseUrl?: string;
}

interface WeixinFlow {
  view: DaemonWeixinLoginFlow;
  controller: AbortController;
  timer: NodeJS.Timeout | undefined;
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
    flows.delete(id);
  };

  app.get('/auth/weixin', (_req, res) => {
    noStore(res);
    const account = loadAccount();
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
      if (flows.size >= MAX_FLOWS) {
        res.status(429).json({ code: 'too_many_flows' });
        return;
      }
      const id = randomUUID();
      const controller = new AbortController();
      const flow: WeixinFlow = {
        view: { id, status: 'waiting' },
        controller,
        timer: undefined,
      };

      // Reserve the slot before awaiting the upstream mint. Checking the cap
      // and registering across an await lets concurrent starts all pass the
      // check and then all register, exceeding MAX_FLOWS.
      flows.set(id, flow);

      let qrcodeId: string;
      try {
        const qr = await startLogin(apiBaseUrl);
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

      const finish = (view: DaemonWeixinLoginFlow) => {
        clearTimeout(flow.timer);
        flow.view = view;
        flow.timer = setTimeout(() => cancel(id), TERMINAL_RETENTION_MS);
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
    const flow = flows.get(req.params['id'] ?? '');
    if (!flow) {
      res.status(404).json({ code: 'flow_not_found' });
      return;
    }
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
