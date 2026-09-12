/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Daemon discovery: probe `GET /health` to decide whether a local `qwen serve`
 * daemon is reachable before the side panel opens a session — so the UI can show
 * a "start `qwen serve`" hint instead of a broken chat.
 */

import type { DaemonConfig } from './config.js';

const VERIFICATION_DOMAIN = 'qwen-extension-daemon';

function parsePairingCredential(
  credential: string,
): { id: string; secret: string } | undefined {
  const separator = credential.indexOf('.');
  if (separator <= 0 || separator === credential.length - 1) return undefined;
  return {
    id: credential.slice(0, separator),
    secret: credential.slice(separator + 1),
  };
}

function base64Url(bytes: ArrayBuffer): string {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function pairingProof(
  secret: string,
  challenge: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(secret));
  const key = await crypto.subtle.importKey(
    'raw',
    digest,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return base64Url(
    await crypto.subtle.sign(
      'HMAC',
      key,
      encoder.encode(`${VERIFICATION_DOMAIN}:${challenge}`),
    ),
  );
}

function randomChallenge(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes.buffer);
}

export type DaemonHealth =
  | { reachable: true; status: string }
  | { reachable: false; error: string };

export type ExtensionPairingHealth =
  | { paired: true }
  | {
      paired: false;
      reason: 'missing_credential' | 'rejected' | 'unreachable';
    };

/** Probe the daemon's `/health` endpoint with a short timeout. */
export async function checkDaemonHealth(
  config: DaemonConfig,
  timeoutMs = 2_000,
): Promise<DaemonHealth> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/health`, {
      signal: controller.signal,
    });
    if (!res.ok) {
      return { reachable: false, error: `health returned ${res.status}` };
    }
    const body = (await res.json().catch(() => ({}))) as { status?: string };
    return { reachable: true, status: body?.status ?? 'ok' };
  } catch (error) {
    return {
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Read the daemon's advertised feature tags. */
export async function getDaemonFeatures(
  config: DaemonConfig,
  timeoutMs = 2_000,
): Promise<Set<string>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(
      `${config.baseUrl.replace(/\/+$/, '')}/capabilities`,
      {
        headers: config.token
          ? { Authorization: `Bearer ${config.token}` }
          : {},
        signal: controller.signal,
      },
    );
    if (!res.ok) return new Set();
    const body = (await res.json().catch(() => ({}))) as {
      features?: unknown;
    };
    return new Set(
      Array.isArray(body.features)
        ? body.features.filter(
            (feature): feature is string => typeof feature === 'string',
          )
        : [],
    );
  } catch {
    return new Set();
  } finally {
    clearTimeout(timer);
  }
}

/** Verify that this extension has been paired with the daemon it found. */
export async function checkExtensionPairing(
  config: DaemonConfig,
  timeoutMs = 2_000,
): Promise<ExtensionPairingHealth> {
  const credential = config.extensionPairingCredential?.trim();
  if (!credential) {
    return { paired: false, reason: 'missing_credential' };
  }
  const parsed = parsePairingCredential(credential);
  if (!parsed) return { paired: false, reason: 'rejected' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const challenge = randomChallenge();
    const res = await fetch(
      `${config.baseUrl.replace(/\/+$/, '')}/extension/pairing/verify`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ credentialId: parsed.id, challenge }),
        signal: controller.signal,
      },
    );
    if (!res.ok) return { paired: false, reason: 'rejected' };
    const body = (await res.json().catch(() => ({}))) as { proof?: unknown };
    const expected = await pairingProof(parsed.secret, challenge);
    return body.proof === expected
      ? { paired: true }
      : { paired: false, reason: 'rejected' };
  } catch {
    return { paired: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}
