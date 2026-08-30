/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface LanCandidate {
  interfaceName: string;
  address: string;
}

export interface LocalControlStatus {
  active: boolean;
  url?: string;
  /**
   * Set when the daemon withheld the pairing URL from this response because
   * the request carried no credentials (#9106); the URL is printed to the
   * daemon terminal instead.
   */
  urlRedacted?: boolean;
  qrText?: string;
  interfaceName?: string;
  address?: string;
  sleepInhibited?: boolean;
  encrypted?: boolean;
  interfaces?: LanCandidate[];
}

function resolveLocalControlUrl(baseUrl: string, path: string): URL {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return new URL(path.replace(/^\/+/, ''), base);
}

export class LocalControlRequestError extends Error {
  constructor(
    message: string,
    readonly payload?: LocalControlStatus,
  ) {
    super(message);
    this.name = 'LocalControlRequestError';
  }
}

export async function requestLocalControl(
  baseUrl: string,
  token: string | undefined,
  method: 'GET' | 'POST',
  path: string,
  body?: object,
): Promise<LocalControlStatus> {
  const headers = new Headers(
    token ? { Authorization: `Bearer ${token}` } : undefined,
  );
  if (body) headers.set('Content-Type', 'application/json');
  const response = await fetch(resolveLocalControlUrl(baseUrl, path), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload: (LocalControlStatus & { error?: string }) | undefined;
  try {
    payload = (text ? JSON.parse(text) : {}) as LocalControlStatus & {
      error?: string;
    };
  } catch {
    if (response.ok) throw new Error('Invalid Local Control response');
  }
  if (!response.ok) {
    throw new LocalControlRequestError(
      payload?.error?.trim() ||
        response.statusText ||
        `Local Control request failed (${response.status})`,
      payload,
    );
  }
  return payload!;
}
