/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { STATUS_CODES } from 'node:http';
import { getExecutionEnvironmentError } from './fsErrorMessages.js';

import { isApiError, isStructuredError } from './quotaErrorDetection.js';
import { PROXY_ENV_VARS } from './fetch.js';
import {
  collectErrorCodes,
  collectErrorMessages,
  readRootCauseMessage,
} from './errors.js';
import { truncateString } from './textUtils.js';
import { BRAND_CLI_BIN } from '../config/brand.js';
import type { AuthType } from '@qwen-code/resource';
import { getI18nService } from '../i18n/index.js';
import {
  isGenericErrorCode,
  parseApiErrorBody,
  readCodeString,
  readFiniteNumber,
} from '../protocol/provider/qoder-api-error.js';
import { readExplicitNetworkFailurePhase } from '../client/utils/networkUtils.js';

const getRateLimitErrorMessageDefault = (fallbackModel: string = 'lite') =>
  `\nPossible quota limitations in place or slow response times detected. Switching to the ${fallbackModel} model for the rest of this session.`;

export const INVALID_MODEL_RESPONSE_MESSAGE =
  'The model service returned an invalid response. Please try again.';

export const CONNECTION_INTERRUPTED_MESSAGE =
  'The connection to the model service was interrupted. Please try again.';

const CONNECTION_INTERRUPTED_ERROR_CODES = new Set(['UND_ERR_SOCKET']);
const CONNECTION_INTERRUPTED_ERROR_MESSAGES = new Set([
  'other side closed',
  'socket connection was closed unexpectedly',
]);

type ParsedProxyEnv = { name: string; value: string; url: URL };

function getConfiguredProxyEnv(
  proxyUrl?: string,
): { name: string; value: string } | undefined {
  for (const name of PROXY_ENV_VARS) {
    const value = process.env[name];
    if (!value) {
      continue;
    }
    if (!proxyUrl || value === proxyUrl) {
      return { name, value };
    }
  }
  return undefined;
}

function extractUrlFromParseError(message: string): string | undefined {
  const quotedUrlMatch = /^"([^"]+)" cannot be parsed as a URL\.?$/.exec(
    message,
  );
  if (quotedUrlMatch?.[1]) {
    return quotedUrlMatch[1];
  }
  return undefined;
}

function getPortHint(rawUrl: string): string | undefined {
  const portMatch =
    /^(?:https?|socks5h?|socks):\/\/(?:[^@/\s]+@)?(?:\[[^\]]+\]|[^:/\s]+):(\d+)(?:[/?#]|$)/i.exec(
      rawUrl,
    );
  if (!portMatch?.[1]) {
    return undefined;
  }

  const port = Number(portMatch[1]);
  if (port > 65535) {
    return ` Port ${port} is outside the valid range of 0-65535.`;
  }
  return undefined;
}

function formatInvalidProxyUrlError(message: string): string | undefined {
  const rawUrl = extractUrlFromParseError(message);
  const proxyEnv = getConfiguredProxyEnv(rawUrl);
  if (!rawUrl || !proxyEnv) {
    return undefined;
  }

  const portHint = getPortHint(rawUrl) ?? '';
  return (
    `Invalid proxy URL in ${proxyEnv.name}: "${rawUrl}".` +
    `${portHint} Check your proxy environment variable and use a valid ` +
    `http://, https://, socks5://, socks5h://, or socks:// proxy address.`
  );
}

function* parsedProxyEnvs(): Generator<ParsedProxyEnv> {
  for (const name of PROXY_ENV_VARS) {
    const value = process.env[name];
    if (!value) continue;
    try {
      yield { name, value, url: new URL(value) };
    } catch {
      // Unparseable proxy URLs are handled by formatInvalidProxyUrlError.
    }
  }
}

function formatHttpsProxyTlsHandshakeError(
  message: string,
): string | undefined {
  if (
    !/Client network socket disconnected before secure TLS connection was established/i.test(
      message,
    )
  ) {
    return undefined;
  }

  for (const proxyEnv of parsedProxyEnvs()) {
    if (proxyEnv.url.protocol !== 'https:') continue;
    const host = proxyEnv.url.hostname;
    const port = proxyEnv.url.port || '443';
    return (
      `Proxy TLS handshake failed for ${proxyEnv.name}: "${proxyEnv.value}". ` +
      `The proxy URL starts with https://, which means ${BRAND_CLI_BIN} will use TLS to connect to the proxy server itself. ` +
      `If ${host}:${port} is a local mixed proxy port such as Clash/ClashX, use ` +
      `"http://${host}:${port}" or "socks5://${host}:${port}" instead. ` +
      `Original error: ${message}`
    );
  }
  return undefined;
}

function formatProxyConnectionError(message: string): string | undefined {
  if (!/\b(?:ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH)\b/.test(message)) {
    return undefined;
  }

  for (const { name, value, url } of parsedProxyEnvs()) {
    const defaultPort =
      url.protocol === 'https:'
        ? '443'
        : /^socks(5h?)?:$/i.test(url.protocol)
          ? '1080'
          : '80';
    const hostPort = `${url.hostname}:${url.port || defaultPort}`;
    if (message.includes(hostPort) || message.includes(url.hostname)) {
      return (
        `Proxy connection failed for ${name}: "${value}". ` +
        `Check that the proxy server is running and reachable. ` +
        `Original error: ${message}`
      );
    }
  }

  return undefined;
}

function formatProxyConfigurationError(message: string): string | undefined {
  return (
    formatInvalidProxyUrlError(message) ??
    formatHttpsProxyTlsHandshakeError(message) ??
    formatProxyConnectionError(message)
  );
}

function getRateLimitMessage(
  _authType?: AuthType,
  fallbackModel?: string,
): string {
  return getRateLimitErrorMessageDefault(fallbackModel);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Returns the trimmed string, or undefined if it is empty or not a string. */
export function readDisplayMessage(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

const HTTP_STATUS_NAME_CODES = new Map<string, number>(
  Object.entries(STATUS_CODES).flatMap(([code, label]) =>
    label ? [[normalizeStatusName(label), Number(code)]] : [],
  ),
);

const PROVIDER_STATUS_NAME_ALIASES: Readonly<Record<string, number>> = {
  // Some providers use the older phrase; Node/Bun's STATUS_CODES[416] is
  // "Range Not Satisfiable", whose normalized name lacks "REQUESTED".
  REQUESTEDRANGENOTSATISFIABLE: 416,
};

function normalizeStatusName(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function readStatusNameCode(value: string): number | undefined {
  const numeric = readFiniteNumber(value);
  if (numeric !== undefined) return numeric;
  const normalized = normalizeStatusName(value);
  return (
    PROVIDER_STATUS_NAME_ALIASES[normalized] ??
    HTTP_STATUS_NAME_CODES.get(normalized)
  );
}

function readStatusCode(value: unknown): number | undefined {
  const numeric = readFiniteNumber(value);
  if (numeric !== undefined) return numeric;
  const statusName = readDisplayMessage(value);
  return statusName ? readStatusNameCode(statusName) : undefined;
}

export function resolveErrorDisplayCode(
  error: Record<string, unknown>,
): string | number | undefined {
  const code =
    readCodeString(error['code']) ??
    readCodeString(error['error_code']) ??
    readCodeString(error['errorCode']);

  // Provider/transport placeholders do not identify the user-facing error.
  // Prefer the numeric provider status in that case so dynamic texts such as
  // error.code.416 can be selected. Concrete business codes still take
  // precedence over HTTP status codes (for example, code 122 over status 403).
  if (code !== undefined && !isGenericErrorCode(code)) {
    return code;
  }

  return (
    readFiniteNumber(error['status_code']) ??
    readFiniteNumber(error['statusCode']) ??
    readFiniteNumber(error['httpStatus']) ??
    readStatusCode(error['status'])
  );
}

export function formatApiErrorDisplayMessage(
  code: string | number | undefined,
  fallbackMessage: string,
): string {
  const fallback =
    readDisplayMessage(fallbackMessage) ??
    'The request could not be completed. Please try again.';
  const translated =
    code === undefined
      ? fallback
      : getI18nService().get(
          String(code).startsWith('error.code.')
            ? String(code)
            : 'error.code.' + code,
          { message: fallback },
        );
  return readDisplayMessage(translated) ?? fallback;
}

export interface ApiErrorDisplayMetadata {
  displayErrorCode?: string | number;
  fallbackMessage: string;
}

function metadataFromConnectionInterruptedError(
  error: unknown,
): ApiErrorDisplayMetadata | undefined {
  const hasInterruptedCode = collectErrorCodes(error).some((code) =>
    CONNECTION_INTERRUPTED_ERROR_CODES.has(code),
  );
  const messages =
    typeof error === 'string' ? [error] : collectErrorMessages(error);
  const hasInterruptedMessage = messages.some((message) =>
    CONNECTION_INTERRUPTED_ERROR_MESSAGES.has(message.trim().toLowerCase()),
  );

  return hasInterruptedCode || hasInterruptedMessage
    ? { fallbackMessage: CONNECTION_INTERRUPTED_MESSAGE }
    : undefined;
}

function formatFromMetadata(
  metadata: ApiErrorDisplayMetadata | undefined,
): string | undefined {
  if (!metadata) return undefined;
  // fallbackMessage is already normalized by the metadata builders, so format
  // it directly rather than re-running readDisplayMessage.
  const text = formatApiErrorDisplayMessage(
    metadata.displayErrorCode,
    metadata.fallbackMessage,
  );
  return text ? `[API Error: ${text}]` : undefined;
}

function formatNetworkAttemptError(error: unknown): string | undefined {
  if (!isRecord(error) || error['name'] !== 'NetworkAttemptError') {
    return undefined;
  }

  // Source the phase through the canonical classifier so the switch labels are
  // type-checked against NetworkFailurePhase (renames/typos become compile
  // errors) rather than matched as free-form strings.
  const phase = readExplicitNetworkFailurePhase(error);
  let message: string;
  switch (phase) {
    case 'request_build': {
      // Never report this as a connectivity problem: nothing was sent, and the
      // real reason (an invalid header value, e.g. from a non-ASCII machine
      // name) has to be visible or users end up debugging proxy and DNS.
      const detail = readClientRequestFailureDetail(error);
      message =
        'This request could not be built on your machine, so nothing was sent to the model service. This is a local error, not a network failure.';
      if (detail) {
        message += ` Reason: ${detail}`;
      }
      break;
    }
    case 'dns':
      message =
        'Unable to resolve the model service address. Check your DNS or network connection, then try again.';
      break;
    case 'proxy_connect':
      message =
        'Unable to connect through the configured proxy. Check your proxy settings and try again.';
      break;
    case 'connect':
      message =
        'Unable to connect to the model service. Check your network or proxy settings, then try again.';
      break;
    case 'tls':
      message =
        'Unable to establish a secure connection to the model service. Check your network, proxy, system time, and certificates.';
      break;
    case 'timeout':
      message =
        'The model service did not respond in time. Check your network and try again.';
      break;
    case 'request_write':
    case 'response_headers':
      message =
        'The connection to the model service was interrupted. Please try again.';
      break;
    case 'first_byte':
    case 'first_event':
    case 'first_payload':
    case 'stream_idle':
    case 'body':
      message = 'The model response was interrupted. Please try again.';
      break;
    case 'protocol':
      message =
        'The model service returned an invalid response. Please try again.';
      break;
    default:
      message =
        Array.isArray(error['attempts']) && error['attempts'].length === 0
          ? 'No network route to the model service is currently available. Check your network, DNS, or proxy settings.'
          : 'Unable to reach the model service. Check your network settings and try again.';
  }
  return `[API Error: ${message}]`;
}

const MAX_CLIENT_FAILURE_DETAIL_LENGTH = 240;

/**
 * The root-cause message, capped so a pathological one cannot flood the UI.
 * These messages quote the offending value, which is non-ASCII by construction
 * here, so the cut has to be surrogate-safe.
 */
function readClientRequestFailureDetail(error: unknown): string | undefined {
  const detail = readRootCauseMessage(error);
  if (!detail) return undefined;
  return truncateString(detail, MAX_CLIENT_FAILURE_DETAIL_LENGTH, '...');
}

function metadataFromErrorString(
  error: string,
): ApiErrorDisplayMetadata | undefined {
  const prefix = 'Qoder API error:';
  if (!error.startsWith(prefix)) return undefined;

  const delimiter = error.indexOf(' - ', prefix.length);
  if (delimiter === -1) return undefined;

  const statusName = error.slice(prefix.length, delimiter).trim();

  const parsedQoderError = parseApiErrorBody(error.slice(delimiter + 3).trim());
  if (!parsedQoderError) return undefined;

  const displayErrorCode = resolveErrorDisplayCode({
    code: parsedQoderError.code,
    status_code: readStatusNameCode(statusName),
  });
  const fallbackMessage = readDisplayMessage(parsedQoderError.message) ?? '';
  return {
    ...(displayErrorCode !== undefined ? { displayErrorCode } : {}),
    fallbackMessage,
  };
}

function formatErrorString(error: string): string | undefined {
  return formatFromMetadata(metadataFromErrorString(error));
}

export function getApiErrorDisplayMetadata(
  error: unknown,
): ApiErrorDisplayMetadata | undefined {
  const environmentError = getExecutionEnvironmentError(error);
  if (environmentError) {
    return {
      displayErrorCode: environmentError.code,
      fallbackMessage: environmentError.message,
    };
  }
  if (error instanceof Error) {
    return (
      metadataFromErrorString(error.message) ??
      metadataFromConnectionInterruptedError(error)
    );
  }
  if (isRecord(error)) {
    return metadataFromConnectionInterruptedError(error);
  }
  return typeof error === 'string'
    ? (metadataFromErrorString(error) ??
        metadataFromConnectionInterruptedError(error))
    : undefined;
}

/**
 * Resolves the code/fallback used to render a persisted synthetic API error.
 * Prefers the metadata persisted on the message and only re-parses the raw
 * error text for legacy transcripts that predate those fields. Shared by the
 * local TUI renderer and the transcript resume dedup so both derive identical
 * display text.
 */
export function resolvePersistedApiErrorDisplay(
  persisted: {
    displayErrorCode?: string | number;
    errorFallbackMessage?: string;
  },
  rawError: string,
): { displayErrorCode?: string | number; fallbackMessage?: string } {
  let displayErrorCode = persisted.displayErrorCode;
  let fallbackMessage = persisted.errorFallbackMessage;
  if (displayErrorCode === undefined || fallbackMessage === undefined) {
    const legacyMetadata = getApiErrorDisplayMetadata(rawError);
    displayErrorCode ??= legacyMetadata?.displayErrorCode;
    fallbackMessage ??= legacyMetadata?.fallbackMessage;
  }
  return { displayErrorCode, fallbackMessage };
}

export function parseAndFormatApiError(
  error: unknown,
  authType?: AuthType,
  fallbackModel?: string,
): string {
  const environmentError = getExecutionEnvironmentError(error);
  if (environmentError) return environmentError.message;
  return parseApiError(error, authType, fallbackModel);
}

// 执行环境分类只在入口进行；递归解析文本时保留入口按 syscall 作出的判断。
function parseApiError(
  error: unknown,
  authType?: AuthType,
  fallbackModel?: string,
): string {
  const formattedNetworkError = formatNetworkAttemptError(error);
  if (formattedNetworkError) return formattedNetworkError;

  if (error instanceof Error) {
    return parseApiError(error.message, authType, fallbackModel);
  }

  if (isStructuredError(error)) {
    let text = `[API Error: ${error.message}]`;
    if (error.status === 429) {
      text += getRateLimitMessage(authType, fallbackModel);
    }
    return text;
  }

  // The error message might be a string containing a JSON object.
  if (typeof error === 'string') {
    const formattedProxyError = formatProxyConfigurationError(error);
    if (formattedProxyError) {
      return `[API Error: ${formattedProxyError}]`;
    }

    const jsonStart = error.indexOf('{');
    if (jsonStart === -1) {
      return `[API Error: ${error}]`; // Not a JSON error, return as is.
    }

    const formattedQoderError = formatErrorString(error);
    if (formattedQoderError) return formattedQoderError;

    const jsonString = error.substring(jsonStart);

    try {
      const parsedError = JSON.parse(jsonString) as unknown;
      if (isApiError(parsedError)) {
        let finalMessage = parsedError.error.message;
        try {
          // See if the message is a stringified JSON with another error
          const nestedError = JSON.parse(finalMessage) as unknown;
          if (isApiError(nestedError)) {
            finalMessage = nestedError.error.message;
          }
        } catch {
          // It's not a nested JSON error, so we just use the message as is.
        }
        let text = `[API Error: ${finalMessage} (Status: ${parsedError.error.status})]`;
        if (parsedError.error.code === 429) {
          text += getRateLimitMessage(authType, fallbackModel);
        }
        return text;
      }
    } catch {
      // Not a valid JSON, fall through and return the original message.
    }
    return `[API Error: ${error}]`;
  }

  return '[API Error: An unknown error occurred.]';
}

/**
 * Like {@link parseAndFormatApiError}, but strips the outer `[API Error: …]`
 * wrapper so callers rendering their own error surface get just the
 * human-readable message.
 */
export function parseAndFormatApiErrorMessage(
  error: unknown,
  authType?: AuthType,
  fallbackModel?: string,
): string {
  const formatted = parseAndFormatApiError(error, authType, fallbackModel);
  const apiErrorMatch = formatted.match(/^\[API Error: ([\s\S]*)\]$/);
  return apiErrorMatch?.[1] ?? formatted;
}
