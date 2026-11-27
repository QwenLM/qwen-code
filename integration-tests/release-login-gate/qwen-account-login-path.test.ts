/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Release gate: the Qwen-account login path must work end to end.
 *
 * Scenario (single case, release-blocking):
 *   1. The real built CLI (`qwen serve`) starts a subscription device flow.
 *   2. The flow hands out a chat.qwen.ai authorization URL carrying a user_code.
 *   3. The web side of the grant (sign-in, device verify, device approve) is
 *      completed over plain HTTP against the same endpoints the web UI calls.
 *      No browser and no UI assertions: popups and layout may change freely,
 *      the protocol contract is what this gate protects.
 *   4. The daemon must reach `ready` with the test account's identity, report
 *      signedIn, and land subscription_credentials.json in its QWEN_HOME.
 *   5. Cleanup revokes the grant; the refresh chain must be cut afterwards.
 *
 * Credentials come from QWEN_E2E_LOGIN_EMAIL / QWEN_E2E_LOGIN_PASSWORD, which
 * only the release `login_e2e_gate` job injects. Regular integration suites
 * exclude this directory (see integration-tests/vitest.config.ts), and the
 * gate job fails closed when the secrets are absent, so a missing secret can
 * never turn into a silent skip.
 */

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnDaemon, type SpawnedDaemon } from '../cli/_daemon-harness.js';

const EMAIL = process.env['QWEN_E2E_LOGIN_EMAIL'];
const PASSWORD = process.env['QWEN_E2E_LOGIN_PASSWORD'];

const AUTH_BASE = 'https://auth.qwen.ai';
const WEB_ORIGIN = 'https://chat.qwen.ai';

const describeIfCredentials = EMAIL && PASSWORD ? describe : describe.skip;

/** Headers the web client sends on auth calls; verified against live traffic. */
function webHeaders(json: boolean): Record<string, string> {
  return {
    Accept: 'application/json, text/plain, */*',
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    Origin: WEB_ORIGIN,
    Referer: `${WEB_ORIGIN}/auth`,
    'x-request-origin': WEB_ORIGIN,
    'x-request-id': randomUUID(),
    source: 'web',
    version: '0.3.50',
    'accept-language': 'en-US,en;q=0.9',
    timezone: new Date().toString(),
  };
}

interface AuthBody {
  success?: boolean;
  error?: string;
  data?: {
    access_token?: string;
    email?: string;
    status?: boolean;
    code?: string;
    details?: string;
  };
}

/** Server-side throttle observed on verify/approve (~10 calls per window). */
const RATE_LIMIT_CODE = 'Too_Many_Requests';
const RATE_LIMIT_BACKOFF_MS = 60_000;
const RATE_LIMIT_MAX_RETRIES = 4;

function rateLimited(res: { status: number; body: AuthBody }): boolean {
  return (
    res.status === 429 ||
    res.body.data?.code === RATE_LIMIT_CODE ||
    res.body.error === RATE_LIMIT_CODE
  );
}

/**
 * Retry only the throttle response, with a backoff that outlives the ~3min
 * server window. Every other response returns untouched so real failures
 * still fail the gate immediately.
 */
async function withRateLimitBackoff(
  label: string,
  call: () => Promise<{ status: number; body: AuthBody }>,
): Promise<{ status: number; body: AuthBody }> {
  for (let attempt = 0; ; attempt++) {
    const res = await call();
    if (!rateLimited(res) || attempt >= RATE_LIMIT_MAX_RETRIES) return res;
    console.warn(
      `[login-gate] ${label} throttled (attempt ${attempt + 1}); ` +
        `backing off ${RATE_LIMIT_BACKOFF_MS}ms`,
    );
    await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_BACKOFF_MS));
  }
}

async function authRequest(
  method: string,
  url: string,
  opts: {
    form?: Record<string, string>;
    json?: unknown;
    bearer?: string;
  } = {},
): Promise<{ status: number; body: AuthBody }> {
  const headers = webHeaders(opts.json !== undefined);
  let data: string | undefined;
  if (opts.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    data = new URLSearchParams(opts.form).toString();
  } else if (opts.json !== undefined) {
    data = JSON.stringify(opts.json);
  }
  if (opts.bearer) headers['Authorization'] = `Bearer ${opts.bearer}`;
  const res = await fetch(url, { method, headers, body: data });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as AuthBody) : {},
  };
}

async function pollUntil<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

describeIfCredentials('release gate: Qwen account login path', () => {
  let daemon: SpawnedDaemon;
  let home: string;

  beforeAll(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-login-gate-'));
    daemon = await spawnDaemon({
      env: { QWEN_HOME: home },
      bootTimeoutMs: 60_000,
      // Release-artifact legs point these at the unpacked standalone archive
      // (its own node runtime + cli.js); default stays the built dist tree.
      ...(process.env['QWEN_GATE_NODE_BIN']
        ? { nodePath: process.env['QWEN_GATE_NODE_BIN'] }
        : {}),
    });
  }, 90_000);

  afterAll(async () => {
    await daemon?.dispose();
    if (home) fs.rmSync(home, { recursive: true, force: true });
  });

  const serveHeaders = () => ({
    Authorization: `Bearer ${daemon.token}`,
    'Content-Type': 'application/json',
  });

  it('completes the device-flow login and lands verified credentials', async () => {
    // 1. The daemon starts a subscription device flow.
    const start = await fetch(
      `${daemon.base}/auth/subscription/flows?paywallScene=cli`,
      { method: 'POST', headers: serveHeaders() },
    );
    const startText = await start.text();
    expect(start.status, startText).toBe(201);
    const { id } = JSON.parse(startText) as { id: string };

    // 2. The flow must hand out a chat.qwen.ai authorization URL.
    const authorizationUrl = await pollUntil(
      async () => {
        const res = await fetch(
          `${daemon.base}/auth/subscription/flows/${id}`,
          { headers: serveHeaders() },
        );
        const view = await res.json();
        if (view.status === 'error') {
          throw new Error(
            `device flow errored before authorization: ${JSON.stringify(view)}`,
          );
        }
        return view.authorizationUrl as string | undefined;
      },
      60_000,
      'authorization URL from the daemon flow',
    );
    const url = new URL(authorizationUrl);
    expect(url.origin).toBe(WEB_ORIGIN);
    expect(url.pathname).toBe('/authorize');
    const userCode = url.searchParams.get('user_code');
    expect(userCode).toBeTruthy();

    // 3. Web side of the grant over plain HTTP: sign in, verify, approve.
    //    Throttle responses back off and retry; anything else fails loud
    //    with the server body in the message so CI logs keep the evidence.
    const signin = await withRateLimitBackoff('signin', () =>
      authRequest('POST', `${AUTH_BASE}/api/v2/auths/signin`, {
        json: {
          email: EMAIL,
          password: createHash('sha256').update(PASSWORD!).digest('hex'),
        },
      }),
    );
    const session = signin.body.data?.access_token;
    if (signin.status !== 200 || !session) {
      throw new Error(`web sign-in failed: ${JSON.stringify(signin.body)}`);
    }
    expect(signin.body.data?.email).toBe(EMAIL);

    const verify = await withRateLimitBackoff('verify', () =>
      authRequest(
        'GET',
        `${AUTH_BASE}/api/v2/auths/device/verify?user_code=${userCode}`,
        { bearer: session },
      ),
    );
    if (verify.status !== 200 || verify.body.success === false) {
      throw new Error(`device verify failed: ${JSON.stringify(verify.body)}`);
    }

    const approve = await withRateLimitBackoff('approve', () =>
      authRequest('POST', `${AUTH_BASE}/api/v2/auths/device/approve`, {
        json: { user_code: userCode, approve: true },
        bearer: session,
      }),
    );
    if (approve.status !== 200 || approve.body.data?.status !== true) {
      throw new Error(`device approve failed: ${JSON.stringify(approve.body)}`);
    }

    // 4. The daemon must finish the grant with the test account's identity.
    const view = await pollUntil(
      async () => {
        const res = await fetch(
          `${daemon.base}/auth/subscription/flows/${id}`,
          { headers: serveHeaders() },
        );
        const v = await res.json();
        if (v.status === 'error') {
          throw new Error(
            `device flow failed after approval: ${JSON.stringify(v)}\n` +
              `daemon stderr: ${daemon.stderrBuf.value.slice(-2000)}`,
          );
        }
        return v.status === 'ready' ? v : undefined;
      },
      90_000,
      'daemon flow to reach ready',
    );
    expect(view.userInfo?.email).toBe(EMAIL);

    const state = await fetch(`${daemon.base}/auth/subscription`, {
      headers: serveHeaders(),
    });
    expect((await state.json()).signedIn).toBe(true);

    const credsPath = path.join(home, 'subscription_credentials.json');
    expect(fs.existsSync(credsPath), 'credentials must land in QWEN_HOME').toBe(
      true,
    );
    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    const refreshToken = creds.tokens?.refresh_token as string;
    expect(refreshToken, 'credentials must carry a refresh token').toBeTruthy();

    // 5. Cleanup through the product's own sign-out route, then prove the
    //    refresh chain is cut so no usable grant outlives the test.
    const revoke = await fetch(`${daemon.base}/auth/subscription/revoke`, {
      method: 'POST',
      headers: serveHeaders(),
    });
    expect(revoke.status, await revoke.text()).toBe(204);
    const after = await fetch(`${daemon.base}/auth/subscription`, {
      headers: serveHeaders(),
    });
    expect((await after.json()).signedIn).toBe(false);

    const refresh = await withRateLimitBackoff('refresh-after-revoke', () =>
      authRequest('POST', `${AUTH_BASE}/api/oauth/token`, {
        form: {
          grant_type: 'refresh_token',
          client_id: 'qwen-code-cli',
          refresh_token: refreshToken,
        },
      }),
    );
    if (refresh.status !== 400 || refresh.body.error !== 'invalid_grant') {
      throw new Error(
        `revoked grant must not refresh: ${JSON.stringify(refresh.body)}`,
      );
    }
  }, 900_000);
});
