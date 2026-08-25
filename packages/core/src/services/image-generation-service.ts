/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isPrivateHost } from '../utils/fetch.js';
import { getErrorMessage } from '../utils/errors.js';
import {
  resolveNetworkTarget,
  type ResolvedNetworkTarget,
} from '../extension/network-policy.js';
import { loadUndici } from '../utils/runtimeFetchOptions.js';

const GENERATION_TIMEOUT_MS = 240_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_API_RESPONSE_BYTES = 1024 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_DOWNLOAD_REDIRECTS = 3;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const MINIMAX_IMAGE_GENERATION_PATH = '/v1/image_generation';
const MINIMAX_IMAGE_GENERATION_SUFFIX = '/image_generation';

class ResponseSizeLimitError extends Error {}

export interface ImageGenerationRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  size?: string;
  signal: AbortSignal;
  fetchFn?: typeof fetch;
}

export interface GeneratedImage {
  bytes: Buffer;
  mimeType: 'image/png';
  requestId?: string;
}

export type GenerateImage = (
  request: ImageGenerationRequest,
) => Promise<GeneratedImage>;

export function normalizeImageGenerationBaseUrl(
  value: string | undefined,
): string | undefined {
  const baseUrl = value?.trim();
  if (!baseUrl) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return undefined;
  }
  return parsed.toString().replace(/\/+$/, '');
}

export async function generateImage(
  request: ImageGenerationRequest,
): Promise<GeneratedImage> {
  const fetchFn = request.fetchFn ?? fetch;
  const baseUrl = normalizeImageGenerationBaseUrl(request.baseUrl);
  if (!baseUrl) {
    throw new Error(
      'Image generation baseUrl must be a valid HTTPS URL without credentials, query, or fragment.',
    );
  }
  if (isMiniMaxImageGenerationBaseUrl(baseUrl)) {
    return generateMiniMaxImage({ ...request, baseUrl, fetchFn });
  }
  const generationUrl = baseUrl.endsWith(
    '/services/aigc/multimodal-generation/generation',
  )
    ? baseUrl
    : `${baseUrl}/services/aigc/multimodal-generation/generation`;
  const parameters: Record<string, string | number | boolean> = {
    n: 1,
    prompt_extend: true,
    watermark: false,
  };
  if (request.size) {
    parameters['size'] = request.size;
  }

  let response: Response;
  try {
    response = await fetchFn(generationUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: request.model,
        input: {
          messages: [
            {
              role: 'user',
              content: [{ text: request.prompt }],
            },
          ],
        },
        parameters,
      }),
      redirect: 'error',
      signal: combineWithTimeout(request.signal, GENERATION_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `Image generation request failed: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }

  if (!response.ok) {
    let payload: unknown = {};
    try {
      payload = await readJsonResponse(response, MAX_API_RESPONSE_BYTES);
    } catch {
      // non-JSON error body — formatImageGenerationError handles missing fields
    }
    throw new Error(formatImageGenerationError(response.status, payload));
  }
  const payload = await readJsonResponse(response, MAX_API_RESPONSE_BYTES);

  const imageUrl = findGeneratedImageUrl(payload);
  if (!imageUrl) {
    throw new Error('Image generation response did not contain an image URL.');
  }

  const bytes = await downloadPng(imageUrl, fetchFn, request.signal);
  const requestId = readString(payload, 'request_id', 'requestId');
  return {
    bytes,
    mimeType: 'image/png',
    ...(requestId ? { requestId } : {}),
  };
}

async function generateMiniMaxImage(
  request: ImageGenerationRequest & { baseUrl: string; fetchFn: typeof fetch },
): Promise<GeneratedImage> {
  const generationUrl = request.baseUrl.endsWith(MINIMAX_IMAGE_GENERATION_PATH)
    ? request.baseUrl
    : `${request.baseUrl}${MINIMAX_IMAGE_GENERATION_SUFFIX}`;
  const body: Record<string, unknown> = {
    model: request.model,
    prompt: request.prompt,
    n: 1,
    prompt_optimizer: true,
    response_format: 'url',
  };
  const dimensions = parseImageSize(request.size);
  if (dimensions) {
    body['width'] = dimensions.width;
    body['height'] = dimensions.height;
  }

  let response: Response;
  try {
    response = await request.fetchFn(generationUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${request.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: combineWithTimeout(request.signal, GENERATION_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(
      `Image generation request failed: ${getErrorMessage(error)}`,
      { cause: error },
    );
  }

  if (!response.ok) {
    let payload: unknown = {};
    try {
      payload = await readJsonResponse(response, MAX_API_RESPONSE_BYTES);
    } catch {
      // non-JSON error body — formatImageGenerationError handles missing fields
    }
    throw new Error(formatImageGenerationError(response.status, payload));
  }
  const payload = await readJsonResponse(response, MAX_API_RESPONSE_BYTES);
  const baseResponse = isRecord(payload) ? payload['base_resp'] : undefined;
  const statusCode = readStringOrNumber(baseResponse, 'status_code');
  if (statusCode && statusCode !== '0') {
    throw new Error(formatImageGenerationError(response.status, payload));
  }
  const image = findMiniMaxGeneratedImage(payload);
  if (!image) {
    throw new Error('Image generation response did not contain an image URL.');
  }

  const requestId =
    readString(payload, 'request_id', 'requestId') ??
    readString(
      isRecord(payload) ? payload['base_resp'] : undefined,
      'request_id',
    );
  if (image.kind === 'base64') {
    return {
      bytes: decodePngBase64Image(image.value),
      mimeType: 'image/png',
      ...(requestId ? { requestId } : {}),
    };
  }

  const bytes = await downloadPng(image.value, request.fetchFn, request.signal);
  return {
    bytes,
    mimeType: 'image/png',
    ...(requestId ? { requestId } : {}),
  };
}

async function readJsonResponse(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  const bytes = await readBoundedBody(response, maxBytes);
  if (bytes.length === 0) {
    return {};
  }
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new Error(
      `Image generation endpoint returned malformed JSON (HTTP ${response.status}).`,
    );
  }
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ResponseSizeLimitError(
      `Response exceeds the ${maxBytes}-byte limit.`,
    );
  }
  if (!response.body) {
    return Buffer.alloc(0);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new ResponseSizeLimitError(
          `Response exceeds the ${maxBytes}-byte limit.`,
        );
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function formatImageGenerationError(status: number, payload: unknown): string {
  const baseResponse = isRecord(payload) ? payload['base_resp'] : undefined;
  const code =
    readStringOrNumber(payload, 'code') ??
    readStringOrNumber(baseResponse, 'status_code');
  const message =
    readString(payload, 'message') ?? readString(baseResponse, 'status_msg');
  const suffix = [code, message].filter(Boolean).join(': ');

  if (status === 429 || /throttl|rate.?limit/i.test(`${code} ${message}`)) {
    return `Image generation rate limit reached${suffix ? ` (${suffix})` : ''}.`;
  }
  if (
    status === 401 ||
    status === 403 ||
    /access|permission/i.test(code ?? '')
  ) {
    return `Image generation access denied${suffix ? ` (${suffix})` : ''}. Check the API key, endpoint, and model access.`;
  }
  if (/DataInspectionFailed/i.test(code ?? '')) {
    return `The image generation endpoint blocked the prompt during content moderation${message ? `: ${message}` : '.'}`;
  }
  const statusText =
    status >= 200 && status < 300 ? '' : ` with HTTP ${status}`;
  return `Image generation failed${statusText}${suffix ? ` (${suffix})` : ''}.`;
}

function findGeneratedImageUrl(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const output = payload['output'];
  if (!isRecord(output) || !Array.isArray(output['choices'])) return undefined;

  for (const choice of output['choices']) {
    if (!isRecord(choice)) continue;
    const message = choice['message'];
    if (!isRecord(message) || !Array.isArray(message['content'])) continue;
    for (const part of message['content']) {
      if (!isRecord(part)) continue;
      const image = part['image'];
      if (typeof image === 'string' && image.trim()) {
        return image.trim();
      }
    }
  }
  return undefined;
}

function isMiniMaxImageGenerationBaseUrl(baseUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/, '');
  return (
    (parsed.hostname === 'api.minimax.io' ||
      parsed.hostname === 'api.minimaxi.com') &&
    (normalizedPath === '/v1' ||
      normalizedPath === MINIMAX_IMAGE_GENERATION_PATH)
  );
}

function parseImageSize(
  value: string | undefined,
): { width: number; height: number } | undefined {
  const match = value?.trim().match(/^(\d+)\s*[*xX]\s*(\d+)$/);
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    return undefined;
  }
  return { width, height };
}

function findMiniMaxGeneratedImage(
  payload: unknown,
): { kind: 'url' | 'base64'; value: string } | undefined {
  if (!isRecord(payload)) return undefined;
  const data = payload['data'];
  if (!isRecord(data)) return undefined;
  const imageUrls = data['image_urls'];
  if (!Array.isArray(imageUrls)) return undefined;

  for (const candidate of imageUrls) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const value = candidate.trim();
    if (/^https:\/\//i.test(value)) {
      return { kind: 'url', value };
    }
    return { kind: 'base64', value };
  }
  return undefined;
}

function decodePngBase64Image(value: string): Buffer {
  const match = value.match(/^data:image\/png;base64,(.+)$/i);
  const base64 = (match?.[1] ?? value).trim();
  const bytes = Buffer.from(base64, 'base64');
  if (
    bytes.length < PNG_SIGNATURE.length ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    throw new Error(
      'Image generation response did not contain a valid PNG image.',
    );
  }
  return bytes;
}

async function downloadPng(
  imageUrl: string,
  fetchFn: typeof fetch,
  signal: AbortSignal,
): Promise<Buffer> {
  const combinedSignal = combineWithTimeout(signal, DOWNLOAD_TIMEOUT_MS);
  let currentTarget = await validateResultUrl(imageUrl, combinedSignal);

  for (
    let redirectCount = 0;
    redirectCount <= MAX_DOWNLOAD_REDIRECTS;
    redirectCount++
  ) {
    let dispatcher: import('undici').Dispatcher | undefined;
    if (currentTarget.lookup) {
      const undici = await loadUndici();
      const { Agent } = undici as unknown as typeof import('undici');
      dispatcher = new Agent({ connect: { lookup: currentTarget.lookup } });
    }
    let response: Response;
    try {
      response = await fetchFn(currentTarget.url.toString(), {
        method: 'GET',
        headers: { Accept: 'image/png' },
        redirect: 'manual',
        signal: combinedSignal,
        ...(dispatcher ? { dispatcher } : {}),
      } as RequestInit);
    } catch (error) {
      await dispatcher?.close();
      throw new Error('Generated image download failed before completion.', {
        cause: error,
      });
    }

    try {
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => {});
        if (!location) {
          throw new Error(
            'Generated image redirect is missing a Location header.',
          );
        }
        let redirectUrl: string;
        try {
          redirectUrl = new URL(
            location,
            currentTarget.url.toString(),
          ).toString();
        } catch {
          throw new Error('Generated image redirect URL is invalid.');
        }
        currentTarget = await validateResultUrl(redirectUrl, combinedSignal);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(
          `Generated image download failed with HTTP ${response.status}.`,
        );
      }

      let bytes: Buffer;
      try {
        bytes = await readBoundedBody(response, MAX_IMAGE_BYTES);
      } catch (error) {
        if (error instanceof ResponseSizeLimitError) {
          throw error;
        }
        throw new Error('Generated image download failed before completion.', {
          cause: error,
        });
      }
      if (
        bytes.length < PNG_SIGNATURE.length ||
        !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
      ) {
        throw new Error('Downloaded result is not a valid PNG image.');
      }
      return bytes;
    } finally {
      await dispatcher?.close();
    }
  }

  throw new Error(
    `Generated image download exceeded ${MAX_DOWNLOAD_REDIRECTS} redirects.`,
  );
}

async function validateResultUrl(
  value: string,
  signal: AbortSignal,
): Promise<ResolvedNetworkTarget> {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Image generation returned an invalid image URL.');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    isPrivateHost(parsed.toString())
  ) {
    throw new Error(
      'Image generation returned an image URL that is not a safe public HTTPS URL.',
    );
  }
  try {
    return await resolveNetworkTarget(parsed, 'public', signal);
  } catch (error) {
    signal.throwIfAborted();
    throw new Error(
      'Image generation returned an image URL that is not a safe public HTTPS URL.',
      { cause: error },
    );
  }
}

function combineWithTimeout(
  signal: AbortSignal,
  timeoutMs: number,
): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
}

function readString(value: unknown, ...keys: string[]): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function readStringOrNumber(
  value: unknown,
  ...keys: string[]
): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return String(candidate);
    }
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
