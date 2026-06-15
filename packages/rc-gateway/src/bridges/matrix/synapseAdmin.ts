/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Synapse shared-secret registration helper — INTEGRATION-TEST SUPPORT ONLY
 * (used by the E2EE crypto round-trip test to provision throwaway accounts).
 * Implements the `/_synapse/admin/v1/register` nonce+HMAC flow: GET a nonce, then
 * POST `{nonce, username, password, admin, mac}` where `mac` is
 * `HMAC-SHA1(secret, nonce\0user\0password\0("admin"|"notadmin"))`.
 *
 * The HMAC is pure and unit-tested against a known vector; the live HTTP calls run
 * only against a real Synapse (env-gated test), never in the default suite.
 */

import { createHmac } from 'node:crypto';

/** The documented Synapse shared-secret registration MAC (hex). */
export function synapseRegisterMac(
  sharedSecret: string,
  nonce: string,
  username: string,
  password: string,
  admin: boolean,
): string {
  const mac = createHmac('sha1', sharedSecret);
  mac.update(nonce);
  mac.update('\x00');
  mac.update(username);
  mac.update('\x00');
  mac.update(password);
  mac.update('\x00');
  mac.update(admin ? 'admin' : 'notadmin');
  return mac.digest('hex');
}

export interface RegisteredUser {
  userId: string;
  accessToken: string;
  deviceId: string;
}

/**
 * Register a throwaway user via Synapse's shared-secret admin endpoint and return
 * its credentials. `fetchImpl` is injectable for unit tests; defaults to global
 * `fetch`. Throws on a non-OK response.
 */
export async function registerViaSharedSecret(
  homeserverUrl: string,
  sharedSecret: string,
  username: string,
  password: string,
  admin = false,
  fetchImpl: typeof fetch = fetch,
): Promise<RegisteredUser> {
  const base = homeserverUrl.replace(/\/$/, '');
  const nonceRes = await fetchImpl(`${base}/_synapse/admin/v1/register`);
  if (!nonceRes.ok) {
    throw new Error(`nonce fetch failed: ${nonceRes.status}`);
  }
  const { nonce } = (await nonceRes.json()) as { nonce: string };
  const mac = synapseRegisterMac(
    sharedSecret,
    nonce,
    username,
    password,
    admin,
  );
  const res = await fetchImpl(`${base}/_synapse/admin/v1/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nonce, username, password, admin, mac }),
  });
  if (!res.ok) {
    throw new Error(
      `register failed: ${res.status} ${await res.text().catch(() => '')}`,
    );
  }
  const body = (await res.json()) as {
    user_id: string;
    access_token: string;
    device_id: string;
  };
  return {
    userId: body.user_id,
    accessToken: body.access_token,
    deviceId: body.device_id,
  };
}
