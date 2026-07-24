/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const MAX_RESPONSE_BYTES = 1024 * 1024;

class ProviderResponseError extends Error {
  constructor() {
    super('External context provider returned an invalid response.');
    this.name = 'ProviderResponseError';
  }
}

export function validateProviderBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Provider URL is invalid.');
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'Provider URL must not contain credentials, path, query, or fragment.',
    );
  }
  if (url.protocol === 'https:') {
    return url;
  }
  if (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]')
  ) {
    return url;
  }
  throw new Error('Provider URL must use HTTPS or loopback HTTP.');
}

export async function postJson(input: {
  url: URL;
  authorization: string;
  body: unknown;
  signal: AbortSignal;
}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(input.url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: input.authorization,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input.body),
      redirect: 'manual',
      signal: input.signal,
    });
  } catch {
    throw new Error('External context provider request did not complete.');
  }

  if (response.status >= 300 && response.status < 400) {
    cancelResponseBody(response);
    throw new ProviderResponseError();
  }
  if (!response.ok) {
    cancelResponseBody(response);
    throw new Error('External context provider rejected the request.');
  }

  const declaredLength = response.headers.get('content-length');
  if (
    declaredLength !== null &&
    Number.parseInt(declaredLength, 10) > MAX_RESPONSE_BYTES
  ) {
    cancelResponseBody(response);
    throw new ProviderResponseError();
  }

  let text: string;
  try {
    text = await readBoundedBody(response);
  } catch (error) {
    if (error instanceof ProviderResponseError) {
      throw error;
    }
    throw new Error('External context provider request did not complete.');
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderResponseError();
  }
}

function cancelResponseBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

async function readBoundedBody(response: Response): Promise<string> {
  if (!response.body) {
    throw new ProviderResponseError();
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      throw new ProviderResponseError();
    }
    chunks.push(chunk);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new ProviderResponseError();
  }
}
