/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const MAX_RESPONSE_BYTES = 1024 * 1024;

class ProviderResponseError extends Error {
  constructor() {
    super('External context provider returned an invalid response.');
    this.name = 'ProviderResponseError';
  }
}

export class ProviderHttpStatusError extends Error {
  constructor(readonly status: number) {
    super('External context provider rejected the request.');
    this.name = 'ProviderHttpStatusError';
  }
}

export function validateProviderBaseUrl(
  value: string,
  options?: { allowInsecureHttp?: boolean; allowInsecureHttpHint?: boolean },
): URL {
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
  if (
    url.protocol === 'https:' ||
    (url.protocol === 'http:' &&
      (url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1' ||
        url.hostname === '[::1]' ||
        options?.allowInsecureHttp === true))
  ) {
    return url;
  }
  throw new Error(
    options?.allowInsecureHttpHint === true && url.protocol === 'http:'
      ? 'Provider URL must use HTTPS or loopback HTTP; set "allowInsecureHttp": true to permit plain HTTP for this provider.'
      : 'Provider URL must use HTTPS or loopback HTTP.',
  );
}
export async function postJson(input: {
  url: URL;
  credentialHeader: {
    name: 'authorization' | 'x-api-key';
    value: string;
  };
  body: unknown;
  signal: AbortSignal;
}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(input.url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        [input.credentialHeader.name]: input.credentialHeader.value,
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
    throw new ProviderHttpStatusError(response.status);
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

  // getReader(), not `for await`: async-iterating a ReadableStream needs
  // [Symbol.asyncIterator] on the TYPE, and whether it is there depends on
  // which lib set the program resolves — @types/node's stream has it, the
  // DOM lib's needs lib.dom.asynciterable. That resolution flipped
  // underneath this file once: installing @types/jsdom at the root (#8693)
  // dragged lib.dom into this program and failed the build with TS2504 on
  // this exact line. The reader API types identically in every lib set, so
  // the build no longer depends on that resolution.
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      if (value === undefined) {
        continue;
      }
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        throw new ProviderResponseError();
      }
      chunks.push(value);
    }
  } finally {
    // Parity with `for await`, whose implicit iterator return() cancels the
    // stream when the loop exits early (the oversize throw above) and is
    // awaited before the error propagates — an immediate retry must not
    // overlap this response's still-settling teardown.
    if (!finished) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
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
