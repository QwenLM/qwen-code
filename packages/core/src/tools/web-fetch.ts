/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * WebFetch tool — fetches content from a URL, converts HTML to markdown,
 * and returns readable content directly or summarizes it with a local source file.
 *
 * Uses direct HTTP fetch with redirect handling, LRU content cache,
 * and secondary model processing via the session ModelProviderManager.
 */


import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type ToolInvocation,
  type ToolLiveOutput,
  type ToolResult,
  type ToolUseContext,
  type WebFetchResult,
} from './tools.js';
import { saveWebFetchSource } from './web-fetch-source.js';
import { ToolErrorType } from './tool-error.js';
import { getErrorMessage, isAbortError } from '../utils/errors.js';
import { getErrorStatus } from '../utils/httpErrors.js';
import { WEB_FETCH_TOOL_NAME, WEB_FETCH_DISPLAY_NAME } from './tool-names.js';
import { runLogger } from '../utils/runLogger.js';
import { CORE_TOOL_SET } from './definitions/coreTools.js';
import {
  isPreapprovedHost,
  type PreapprovedHostChecker,
} from './web-fetch-preapproved.js';
import type { AgentLoopContext } from '../config/agent-loop-context.js';
import type { GetModelPolicyCallback } from '../core/model-policy.js';
import { readLimitedResponseBody, unmanagedRequest } from '../utils/fetch.js';
import { BRAND_CLI_BIN, BRAND_WEBSITE_URL } from '../config/brand.js';
import { getVersion } from '../utils/version.js';
import { readRetryAfterHeaderMs } from '../utils/retry-after.js';
import {
  isSessionIdInvariantError,
  SessionIdInvariantError,
} from '../utils/sessionIdInvariantError.js';
import {
  getBusinessInfoFromContext,
  getRequestSetIdFromContext,
} from '../utils/sessionIdContext.js';
import { applyBusinessSubTask } from '../qoder/business-info.js';
import { resolveBusinessIdentity } from '../core/agent-lifecycle-state.js';
import { randomUUID } from 'node:crypto';
import { resolveModelSelectionOverride } from '../provider/session-model.js';
import { mergeModelConfig } from '../provider/model/modelConfig.js';
import { getConfigValue } from '../config-service/index.js';
import { parseObjectGateValue } from '../config-service/features/gateParseUtils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_URL_LENGTH = 2000;
const MAX_CONTENT_LENGTH = 10_485_760; // 10 MB
const FETCH_TIMEOUT_MS = 60_000;
const TOTAL_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 10;
const CACHE_TTL_MS = 900_000; // 15 min
const MAX_CACHE_SIZE = 52_428_800; // 52 MB
const INVALID_SESSION_CONTEXT_MESSAGE =
  'WebFetch is unavailable because its model session context is invalid. Continue without WebFetch.';
const MAX_MARKDOWN_LENGTH = 100_000;
const MAX_DIRECT_MATERIAL_LENGTH = 50_000;
const WEB_FETCH_MODEL_POLICY = 'webfetch_model_policy';
const WEB_FETCH_TASK_ID = 'agent_summary';
const WEB_FETCH_MAX_OUTPUT_TOKENS = 8192;
// While the secondary model summarizes the fetched page (which can take
// ~15-25s with no intermediate output), emit a progress heartbeat this often so
// the UI keeps showing forward motion instead of appearing frozen/stuck.
const PROGRESS_HEARTBEAT_MS = 1_000;
const MAX_DIAGNOSTIC_CODE_LENGTH = 80;
const TOOL_ERROR_DETAILS_SCHEMA_VERSION = 1;

interface WebFetchDiagnosticData extends Record<string, unknown> {
  tool_error_stage: string;
  tool_error_subtype: string;
  tool_error_details_json: string;
  http_status?: number;
  network_error_code?: string;
}

interface WebFetchDiagnosticOptions {
  httpStatus?: number;
  networkErrorCode?: string;
  details?: Record<string, unknown>;
}

class WebFetchDiagnosticError extends Error {
  constructor(
    message: string,
    readonly data: WebFetchDiagnosticData,
  ) {
    super(message);
    this.name = 'WebFetchDiagnosticError';
  }
}

function compactDiagnosticObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const compacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) compacted[key] = item;
  }
  return compacted;
}

function createWebFetchDiagnosticData(
  stage: string,
  subtype: string,
  options: WebFetchDiagnosticOptions = {},
): WebFetchDiagnosticData {
  const details = compactDiagnosticObject({
    schema_version: TOOL_ERROR_DETAILS_SCHEMA_VERSION,
    tool: WEB_FETCH_DISPLAY_NAME,
    stage,
    subtype,
    ...(options.details ?? {}),
  });

  return compactDiagnosticObject({
    tool_error_stage: stage,
    tool_error_subtype: subtype,
    tool_error_details_json: JSON.stringify(details),
    http_status: options.httpStatus,
    network_error_code: options.networkErrorCode,
  }) as WebFetchDiagnosticData;
}

function isWebFetchDiagnosticError(
  error: unknown,
): error is WebFetchDiagnosticError {
  return error instanceof WebFetchDiagnosticError;
}

function sanitizeDiagnosticCode(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) {
    return value.slice(0, MAX_DIAGNOSTIC_CODE_LENGTH);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as Record<string, unknown>;
  const directCode = sanitizeDiagnosticCode(
    record['code'] ?? record['errorCode'] ?? record['error_code'],
  );
  if (directCode) return directCode;

  const cause = record['cause'];
  if (typeof cause === 'object' && cause !== null) {
    return sanitizeDiagnosticCode(
      (cause as Record<string, unknown>)['code'] ??
        (cause as Record<string, unknown>)['errorCode'] ??
        (cause as Record<string, unknown>)['error_code'],
    );
  }
  return undefined;
}

function classifyHttpStatus(status: number | undefined): string | undefined {
  if (status === undefined) return undefined;
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'auth_or_permission';
  if (status >= 500) return 'http_5xx';
  if (status >= 400) return 'http_4xx';
  return undefined;
}

function classifyDiagnosticCode(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const normalized = code.toUpperCase();
  if (normalized.includes('TIMEOUT') || normalized.includes('TIMEDOUT')) {
    return 'network_timeout';
  }
  if (
    normalized.startsWith('UND_ERR') ||
    normalized.startsWith('EAI_') ||
    normalized === 'ECONNRESET' ||
    normalized === 'ECONNREFUSED' ||
    normalized === 'ENOTFOUND'
  ) {
    return 'network_error';
  }
  return 'api_error';
}

function classifyErrorSubtype(error: unknown): string {
  return (
    classifyHttpStatus(getErrorStatus(error)) ??
    classifyDiagnosticCode(getErrorCode(error)) ??
    'exception'
  );
}

function createFetchProcessingDiagnosticData(
  error: unknown,
): WebFetchDiagnosticData {
  const status = getErrorStatus(error);
  const code = getErrorCode(error);
  const message = getErrorMessage(error).toLowerCase();
  let stage = 'fetch_request';
  let subtype = classifyErrorSubtype(error);

  if (message.includes('invalid url')) {
    stage = 'url_validation';
    subtype = 'invalid_url';
  } else if (message.includes('response too large')) {
    stage = 'content_size';
    subtype = 'response_too_large';
  } else if (message.includes('too many redirects')) {
    subtype = 'too_many_redirects';
  } else if (message.includes('redirect missing location')) {
    subtype = 'redirect_error';
  }

  return createWebFetchDiagnosticData(stage, subtype, {
    httpStatus: status,
    networkErrorCode: code,
    details: compactDiagnosticObject({
      http: status !== undefined ? { status } : undefined,
      network: code ? { error_code: code } : undefined,
    }),
  });
}

// Non-browser identity User-Agent for outbound fetches. Declares who we are
// plus a contact URL (crawler etiquette) instead of impersonating a browser.
// A blank/undici UA or a browser UA can trip UA-based WAFs (e.g. challenge
// pages that return 403 or a 200 interstitial), so we state our identity.
// Version comes from getVersion() (memoized) to match the other product UA
// builders and pick up the same robust package.json fallback.
async function getWebFetchUserAgent(): Promise<string> {
  const version = await getVersion();
  return `${BRAND_CLI_BIN}/${version} (+${BRAND_WEBSITE_URL})`;
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

function validateURL(url: string): boolean {
  if (url.length > MAX_URL_LENGTH) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  if (parsed.hostname.split('.').length < 2) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Redirect helpers
// ---------------------------------------------------------------------------

function isSameOrigin(a: string, b: string): boolean {
  try {
    const urlA = new URL(a);
    const urlB = new URL(b);
    if (urlB.protocol !== urlA.protocol) return false;
    if (urlB.port !== urlA.port) return false;
    if (urlB.username || urlB.password) return false;
    const strip = (h: string) => h.replace(/^www\./, '');
    return strip(urlA.hostname) === strip(urlB.hostname);
  } catch {
    return false;
  }
}

function resolveRedirectUrl(location: string, baseUrl: string): string {
  try {
    return new URL(location, baseUrl).toString();
  } catch {
    return location;
  }
}

// ---------------------------------------------------------------------------
// LRU Content Cache
// ---------------------------------------------------------------------------

interface CacheEntry<V> {
  value: V;
  sizeBytes: number;
  expiresAt: number;
}

class ContentCache<V> {
  private readonly map = new Map<string, CacheEntry<V>>();
  private totalBytes = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      this.totalBytes -= entry.sizeBytes;
      runLogger.debug(
        `[WebFetch] cache expired for ${key}, evicted ${entry.sizeBytes} bytes`,
      );
      return undefined;
    }
    // Move to end for LRU ordering
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: V, sizeBytes: number): void {
    const existing = this.map.get(key);
    if (existing) {
      this.map.delete(key);
      this.totalBytes -= existing.sizeBytes;
    }
    // Evict oldest entries until we have space
    while (this.totalBytes + sizeBytes > this.maxBytes && this.map.size > 0) {
      const oldest = this.map.keys().next().value!;
      const entry = this.map.get(oldest)!;
      this.map.delete(oldest);
      this.totalBytes -= entry.sizeBytes;
      runLogger.debug(
        `[WebFetch] cache LRU evicted ${oldest}, freed ${entry.sizeBytes} bytes`,
      );
    }
    this.map.set(key, {
      value,
      sizeBytes,
      expiresAt: Date.now() + this.ttlMs,
    });
    this.totalBytes += sizeBytes;
  }

  clear(): void {
    this.map.clear();
    this.totalBytes = 0;
  }
}

// ---------------------------------------------------------------------------
// Content types
// ---------------------------------------------------------------------------

export interface WebFetchPageLink {
  href: string;
  text?: string;
  title?: string;
}

export interface WebFetchPageMedia {
  src: string;
  data?: string;
  alt?: string;
  desc?: string;
  format?: string;
}

/** Optional product fetcher. Undefined keeps the original local fetch path. */
export interface WebFetchRemoteContent {
  fetchedAt?: string;
  content: string;
  contentType: string;
  redirectedUrl?: string;
  links?: { internal?: WebFetchPageLink[]; external?: WebFetchPageLink[] };
  media?: {
    images?: WebFetchPageMedia[];
    audios?: WebFetchPageMedia[];
    videos?: WebFetchPageMedia[];
  };
}
export type WebFetchContentProvider = (
  url: string,
  signal: AbortSignal,
) => Promise<WebFetchRemoteContent | undefined>;

/** Supplement the page text with bounded textual references, never inline media bytes. */
function remoteReferences(
  content: WebFetchRemoteContent,
  budget = Infinity,
): string {
  const header = '\n\nPage links and media (page data):\n';
  const lines: string[] = [];
  let remaining = budget - header.length;
  for (const [group, collections] of [
    ['links', content.links],
    ['media', content.media],
  ] as const) {
    if (!collections) continue;
    for (const [kind, entries] of Object.entries(collections)) {
      for (const entry of entries ?? []) {
        const line = `${group}.${kind}: ${JSON.stringify(entry, (key, value) => (key === 'data' ? undefined : value))}`;
        if (line.length + 1 > remaining) continue;
        lines.push(line);
        remaining -= line.length + 1;
      }
    }
  }
  return lines.length ? header + lines.join('\n') : '';
}

type WebFetchContext = Pick<AgentLoopContext, 'config' | 'promptId'>;

interface FetchedContent {
  fetchedAt: string;
  references?: string;
  modelReferences?: string;
  content: string;
  bytes: number;
  code: number;
  codeText: string;
}

const cache = new ContentCache<FetchedContent>(MAX_CACHE_SIZE, CACHE_TTL_MS);

export function clearWebFetchCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Lazy turndown singleton
// ---------------------------------------------------------------------------

type TurndownCtor = typeof import('turndown');
let turndownServicePromise: Promise<InstanceType<TurndownCtor>> | undefined;
function getTurndownService(): Promise<InstanceType<TurndownCtor>> {
  return (turndownServicePromise ??= import('turndown').then((m) => {
    const Turndown = (m as unknown as { default: TurndownCtor }).default;
    return new Turndown();
  }));
}

// ---------------------------------------------------------------------------
// Redirect info type
// ---------------------------------------------------------------------------

interface RedirectInfo {
  type: 'redirect';
  originalUrl: string;
  redirectUrl: string;
  statusCode: number;
}

// Non-2xx HTTP response. Carried structurally so callers can short-circuit
// before the secondary model — an error body is not worth summarizing, and
// doing so wastes ~60s of model time on 404/500 pages.
interface HttpErrorInfo {
  type: 'http_error';
  statusCode: number;
  codeText: string;
  retryAfterMs?: number;
  url: string;
}

function isRedirectInfo(
  result: FetchedContent | RedirectInfo | HttpErrorInfo,
): result is RedirectInfo {
  return 'type' in result && result.type === 'redirect';
}

function isHttpErrorInfo(
  result: FetchedContent | RedirectInfo | HttpErrorInfo,
): result is HttpErrorInfo {
  return 'type' in result && result.type === 'http_error';
}

// ---------------------------------------------------------------------------
// Main fetch function
// ---------------------------------------------------------------------------

async function getURLMarkdownContent(
  url: string,
  signal: AbortSignal,
): Promise<FetchedContent | RedirectInfo | HttpErrorInfo> {
  if (!validateURL(url)) {
    runLogger.warn(`[WebFetch] URL validation failed: ${url}`);
    throw new Error(`Invalid URL: ${url}`);
  }

  // Upgrade http → https
  const urlObj = new URL(url);
  if (urlObj.protocol === 'http:') {
    urlObj.protocol = 'https:';
    runLogger.debug(`[WebFetch] upgraded HTTP → HTTPS: ${url}`);
  }
  const upgradedUrl = urlObj.toString();

  runLogger.debug(`[WebFetch] fetching url=${upgradedUrl}`);

  // Check cache
  const cached = cache.get(upgradedUrl);
  if (cached) {
    runLogger.debug(
      `[WebFetch] cache hit for ${upgradedUrl}, bytes=${cached.bytes}`,
    );
    return { ...cached };
  }

  // Fetch with redirect handling
  let currentUrl = upgradedUrl;
  let redirectCount = 0;
  let response: Response;
  const userAgent = await getWebFetchUserAgent();

  while (true) {
    response = await unmanagedRequest(
      currentUrl,
      {
        method: 'GET',
        redirect: 'manual',
        headers: {
          Accept: 'text/markdown, text/html, */*',
          'User-Agent': userAgent,
        },
        signal,
      },
      { timeoutMs: FETCH_TIMEOUT_MS },
    );

    // Handle redirects
    if ([301, 302, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) {
        throw new Error('Redirect missing Location header');
      }
      const redirectUrl = resolveRedirectUrl(location, currentUrl);
      redirectCount++;
      runLogger.debug(
        `[WebFetch] redirect #${redirectCount}: ${response.status} → ${redirectUrl}`,
      );
      if (redirectCount > MAX_REDIRECTS) {
        runLogger.warn(
          `[WebFetch] too many redirects (${redirectCount} > ${MAX_REDIRECTS}) for ${url}`,
        );
        throw new Error(`Too many redirects (exceeded ${MAX_REDIRECTS})`);
      }
      if (isSameOrigin(currentUrl, redirectUrl)) {
        currentUrl = redirectUrl;
        continue;
      }
      // Cross-origin redirect — return info to caller
      runLogger.debug(
        `[WebFetch] cross-origin redirect detected: ${currentUrl} → ${redirectUrl}`,
      );
      return {
        type: 'redirect',
        originalUrl: currentUrl,
        redirectUrl,
        statusCode: response.status,
      };
    }
    break;
  }

  // Non-2xx short-circuit: an error page is not worth reading, converting,
  // caching, or summarizing with the secondary model. Return a structured
  // error so the caller can report it immediately instead of spending ~60s
  // "analyzing" a 404/500 body.
  if (response!.status < 200 || response!.status >= 300) {
    const retryAfterMs = readRetryAfterHeaderMs(response!.headers);
    runLogger.warn(
      `[WebFetch] non-2xx status=${response!.status} ${response!.statusText} for ${upgradedUrl}, skipping secondary model`,
    );
    // Release the socket promptly — we never read this error body. Swallow
    // any rejection so it can't surface as an unhandled rejection after return.
    void response!.body?.cancel().catch(() => undefined);
    return {
      type: 'http_error',
      statusCode: response!.status,
      codeText: response!.statusText,
      retryAfterMs,
      url: upgradedUrl,
    };
  }

  // Read body with streaming size limit
  const buffer = await readLimitedResponseBody(response!, MAX_CONTENT_LENGTH, {
    logTag: 'WebFetch',
  });
  const bodyText = buffer.toString('utf-8');
  const bytes = buffer.byteLength;
  const code = response!.status;
  const codeText = response!.statusText;
  const contentType = response!.headers.get('content-type') ?? '';

  runLogger.debug(
    `[WebFetch] response: status=${code} ${codeText} contentType=${contentType} bytes=${bytes}`,
  );

  // HTML → Markdown conversion
  let content: string;
  if (contentType.includes('text/html')) {
    content = (await getTurndownService()).turndown(bodyText);
    runLogger.debug(
      `[WebFetch] converted HTML→Markdown, length=${content.length}`,
    );
  } else {
    content = bodyText;
  }

  // Store in cache (use content string byte length, not raw HTTP buffer size,
  // since content may be much smaller after HTML→Markdown conversion)
  const contentBytes = Buffer.byteLength(content, 'utf-8');
  const fetchedAt = new Date().toISOString();
  cache.set(
    upgradedUrl,
    { bytes, code, codeText, content, fetchedAt },
    contentBytes,
  );
  runLogger.debug(
    `[WebFetch] cached ${upgradedUrl}, rawBytes=${bytes}, storedBytes=${contentBytes}`,
  );

  return { content, bytes, code, codeText, fetchedAt };
}

// ---------------------------------------------------------------------------
// Secondary model prompt
// ---------------------------------------------------------------------------

function makeSecondaryModelPrompt(
  markdownContent: string,
  prompt: string,
  isPreapprovedDomain: boolean,
  bodyTruncated: boolean,
): string {
  const guidelines = isPreapprovedDomain
    ? `Provide a concise response based on the content above. Include relevant details, code examples, and documentation excerpts as needed.`
    : `Provide a concise response based only on the content above. In your response:
 - Enforce a strict 125-character maximum for quotes from any source document. Open Source Software is ok as long as we respect the license.
 - Use quotation marks for exact language from articles; any language outside of the quotation should never be word-for-word the same.
 - You are not a lawyer and never comment on the legality of your own prompts and responses.
 - Never produce or reproduce exact song lyrics.`;

  return `
Web page content:
---
${markdownContent}
---
${bodyTruncated ? '\n[Page body truncated] You are seeing only part of the page body. Do not conclude that information is absent from the full page merely because it is missing from this excerpt.\n' : ''}

${prompt}

${guidelines}
`;
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

/**
 * Parameters for the WebFetch tool.
 */
export interface WebFetchToolParams {
  url: string;
  prompt: string;
}

// ---------------------------------------------------------------------------
// Invocation
// ---------------------------------------------------------------------------

class WebFetchToolInvocation extends BaseToolInvocation<
  WebFetchToolParams,
  ToolResult
> {
  constructor(
    private readonly context: WebFetchContext,
    params: WebFetchToolParams,
    _toolName?: string,
    _toolDisplayName?: string,
    private readonly contentProvider?: WebFetchContentProvider,
    private readonly preapprovedHostChecker: PreapprovedHostChecker =
      isPreapprovedHost,
  ) {
    super(params, _toolName, _toolDisplayName);
  }

  override getDescription(): string {
    try {
      const hostname = new URL(this.params.url).hostname;
      return `Fetching content from ${hostname}`;
    } catch {
      return `Fetching content from URL`;
    }
  }

  override executeWithContext(ctx: ToolUseContext): Promise<ToolResult> {
    return this.executeInternal(
      ctx.signal,
      ctx.sessionId ?? this.context.config.getSessionId(),
      ctx.config?.getModelPolicy,
      ctx.updateOutput,
      ctx.modelKey,
    );
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (output: ToolLiveOutput) => void,
  ): Promise<ToolResult> {
    return this.executeInternal(
      signal,
      this.context.config.getSessionId(),
      undefined,
      updateOutput,
    );
  }

  private useDirectMode(modelKey?: string): boolean {
    try {
      const key = modelKey ?? this.context.config.getModel();
      const raw = getConfigValue(WEB_FETCH_MODEL_POLICY);
      if (raw == null) return true;
      const policy = parseObjectGateValue(raw);
      if (
        !policy ||
        Object.keys(policy).some(
          (name) => name !== 'direct' && name !== 'summary',
        )
      ) return true;
      const direct = policy['direct'];
      const summary = policy['summary'];
      const validList = (value: unknown): value is string[] | undefined =>
        value === undefined ||
        (Array.isArray(value) && value.every((item) => typeof item === 'string'));
      if (!validList(direct) || !validList(summary)) return true;
      if (direct?.includes(key) && summary?.includes(key)) {
        runLogger.warn('[WebFetch] model policy conflict; using direct');
        return true;
      }
      return !summary?.includes(key);
    } catch (error) {
      runLogger.debug(
        `[WebFetch] model policy lookup failed: ${getErrorMessage(error)}`,
      );
      return true;
    }
  }

  private async executeInternal(
    signal: AbortSignal,
    sessionId: string,
    getModelPolicy?: GetModelPolicyCallback,
    updateOutput?: (output: ToolLiveOutput) => void,
    modelKey?: string,
  ): Promise<ToolResult> {
    const startTime = performance.now();
    // Snapshot once per call, including calls that reuse cached content.
    const direct = this.useDirectMode(modelKey);
    const deadlineController = new AbortController();
    const deadlineTimer = setTimeout(() => {
      deadlineController.abort(
        new DOMException(
          `WebFetch timed out after ${TOTAL_TIMEOUT_MS}ms`,
          'TimeoutError',
        ),
      );
    }, TOTAL_TIMEOUT_MS);
    deadlineTimer.unref?.();
    const operationSignal = AbortSignal.any([
      signal,
      deadlineController.signal,
    ]);
    const deadlineResult = new Promise<ToolResult>((resolve) => {
      deadlineController.signal.addEventListener(
        'abort',
        () => {
          const durationMs = Math.round(performance.now() - startTime);
          const message = `WebFetch timed out after ${TOTAL_TIMEOUT_MS}ms.`;
          runLogger.warn(
            `[WebFetch] overall deadline exceeded after ${durationMs}ms`,
          );
          resolve({
            llmContent: `Error: ${message}`,
            returnDisplay: message,
            error: {
              message,
              type: ToolErrorType.WEB_FETCH_PROCESSING_ERROR,
            },
            data: createWebFetchDiagnosticData('overall_deadline', 'timeout', {
              details: {
                timeout_ms: TOTAL_TIMEOUT_MS,
                duration_ms: durationMs,
              },
            }),
          });
        },
        { once: true },
      );
    });

    try {
      const result = await Promise.race([
        this.executeOperation(
          operationSignal,
          sessionId,
          getModelPolicy,
          updateOutput,
          startTime,
          direct,
        ),
        deadlineResult,
      ]);
      return result;
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  private async fetchContent(
    url: string,
    signal: AbortSignal,
  ): Promise<FetchedContent | RedirectInfo | HttpErrorInfo> {
    signal.throwIfAborted();
    if (!validateURL(url)) throw new Error(`Invalid URL: ${url}`);
    const normalized = new URL(url);
    if (normalized.protocol === 'http:') normalized.protocol = 'https:';
    if (this.contentProvider) {
      try {
        const remote = await this.contentProvider(
          normalized.toString(),
          signal,
        );
        signal.throwIfAborted();
        if (remote) {
          if (
            !remote.content.trim() ||
            Buffer.byteLength(remote.content) > MAX_CONTENT_LENGTH
          ) {
            throw new Error('Invalid remote WebFetch content');
          }
          if (remote.redirectedUrl) {
            const redirected = new URL(remote.redirectedUrl, normalized);
            if (!validateURL(redirected.toString()))
              throw new Error('Invalid remote redirect');
            if (!isSameOrigin(normalized.toString(), redirected.toString())) {
              return {
                type: 'redirect',
                originalUrl: normalized.toString(),
                redirectUrl: redirected.toString(),
                statusCode: 302,
              };
            }
          }
          const pageContent = remote.contentType.includes('html')
            ? (await getTurndownService()).turndown(remote.content)
            : remote.content;
          return {
            content: pageContent,
            references: remoteReferences(remote),
            modelReferences: remoteReferences(remote, 20_000),
            fetchedAt: remote.fetchedAt ?? new Date().toISOString(),
            bytes: Buffer.byteLength(remote.content),
            code: 200,
            codeText: 'OK',
          };
        }
      } catch (error) {
        signal.throwIfAborted();
        runLogger.debug(
          '[WebFetch] remote fetch failed; falling back to local',
          {
            errorType: error instanceof Error ? error.name : typeof error,
            status:
              typeof error === 'object' && error !== null && 'status' in error
                ? error.status
                : undefined,
          },
        );
      }
    }
    signal.throwIfAborted();
    return getURLMarkdownContent(url, signal);
  }

  private async executeOperation(
    signal: AbortSignal,
    sessionId: string,
    getModelPolicy: GetModelPolicyCallback | undefined,
    updateOutput: ((output: ToolLiveOutput) => void) | undefined,
    startTime: number,
    direct: boolean,
  ): Promise<ToolResult> {
    try {
      const { url, prompt } = this.params;
      const parsedUrl = new URL(url);
      const isPreapproved = this.preapprovedHostChecker(
        parsedUrl.hostname,
        parsedUrl.pathname,
      );

      runLogger.debug(
        `[WebFetch] execute: url="${url}" prompt="${prompt.substring(0, 50)}..." preapproved=${isPreapproved}`,
      );

      // Emit an initial progress line so the UI shows forward motion during the
      // network fetch instead of a static "Fetching content from ..." label.
      updateOutput?.(`Fetching content from ${parsedUrl.hostname}…`);

      // Fetch URL content with redirect handling and caching
      const response: FetchedContent | RedirectInfo | HttpErrorInfo =
        await this.fetchContent(url, signal);

      // Handle cross-origin redirect
      if (isRedirectInfo(response)) {
        const statusText =
          response.statusCode === 301
            ? 'Moved Permanently'
            : response.statusCode === 308
              ? 'Permanent Redirect'
              : response.statusCode === 307
                ? 'Temporary Redirect'
                : 'Found';

        const message = `REDIRECT DETECTED: The URL redirects to a different host.

Original URL: ${response.originalUrl}
Redirect URL: ${response.redirectUrl}
Status: ${response.statusCode} ${statusText}

To complete your request, I need to fetch content from the redirected URL. Please use WebFetch again with these parameters:
- url: "${response.redirectUrl}"
- prompt: "${prompt}"`;

        const durationSeconds = (performance.now() - startTime) / 1000;
        runLogger.debug(
          `[WebFetch] cross-origin redirect returned in ${durationSeconds.toFixed(2)}s: ${response.originalUrl} → ${response.redirectUrl}`,
        );

        const toolUseResult: WebFetchResult = {
          bytes: 0,
          code: response.statusCode,
          codeText: statusText,
          result: message,
          durationMs: Math.round(durationSeconds * 1000),
          url: response.originalUrl,
        };
        return {
          llmContent: message,
          returnDisplay: toolUseResult,
          toolUseResult,
        };
      }

      // Non-2xx HTTP response — report immediately, skip the secondary model.
      if (isHttpErrorInfo(response)) {
        const retryHint =
          response.retryAfterMs !== undefined
            ? ` The server asked to retry after ${Math.ceil(response.retryAfterMs / 1000)} seconds.`
            : '';
        const message =
          `HTTP ERROR: Fetching ${response.url} returned ${response.statusCode} ${response.codeText}. ` +
          `The page could not be retrieved, so there is no content to analyze. ` +
          `Do not retry this exact URL; verify the URL is correct or try a different source.${retryHint}`;

        const durationSeconds = (performance.now() - startTime) / 1000;
        runLogger.debug(
          `[WebFetch] http error returned in ${durationSeconds.toFixed(2)}s: ${response.statusCode} ${response.codeText} for ${response.url}`,
        );

        const toolUseResult: WebFetchResult = {
          bytes: 0,
          code: response.statusCode,
          codeText: response.codeText,
          result: message,
          durationMs: Math.round(durationSeconds * 1000),
          url: response.url,
        };
        return {
          llmContent: message,
          returnDisplay: toolUseResult,
          toolUseResult,
        };
      }

      const { content } = response;
      const fullContent = content + (response.references ?? '');
      const directTruncated = fullContent.length > MAX_DIRECT_MATERIAL_LENGTH;
      let source: Awaited<ReturnType<typeof saveWebFetchSource>> | undefined;
      try {
        source = await saveWebFetchSource({
          content: fullContent,
          url,
          fetchedAt: response.fetchedAt,
          projectTempDir: this.context.config.storage.getProjectTempDir(),
          sessionId,
          signal,
        });
      } catch (error) {
        signal.throwIfAborted();
        if (isAbortError(error) || isSessionIdInvariantError(error))
          throw error;
        runLogger.warn('[WebFetch] could not save local source', error);
      }
      signal.throwIfAborted();
      let result: string;
      let summaryDiagnostic: WebFetchDiagnosticData | undefined;
      if (direct) {
        signal.throwIfAborted();
        const preview = fullContent.slice(0, MAX_DIRECT_MATERIAL_LENGTH);
        result =
          preview +
          (directTruncated
            ? `\n\n[WebFetch content truncated: only the first ${MAX_DIRECT_MATERIAL_LENGTH.toLocaleString('en-US')} UTF-16 code units of the readable page materials are included.]`
            : '');
      } else {
        const references = response.modelReferences ?? '';
        const bodyBudget = MAX_MARKDOWN_LENGTH - references.length;
        const bodyTruncated = content.length > bodyBudget;
        const modelContent = content.slice(0, bodyBudget) + references;
        let summary: string;
        try {
          summary = await this.applyPromptToMarkdown(
            prompt,
            modelContent,
            signal,
            sessionId,
            isPreapproved,
            getModelPolicy,
            updateOutput,
            bodyTruncated,
          );
        } catch (error) {
          signal.throwIfAborted();
          if (
            !source ||
            isAbortError(error) ||
            isSessionIdInvariantError(error)
          )
            throw error;
          summary =
            'Summary unavailable. The fetched page source is saved locally; use Read or Grep to inspect it.';
          if (isWebFetchDiagnosticError(error)) summaryDiagnostic = error.data;
          runLogger.warn(
            '[WebFetch] summary failed; returning saved source',
            error,
          );
        }
        signal.throwIfAborted();
        const truncationNotice = bodyTruncated
          ? '\n\nSummary input was truncated: only part of the page body was available for summarization.' +
            (source
              ? ' Use Read or Grep on the complete local file below to check omitted content.'
              : '')
          : '';
        result = summary + truncationNotice;
      }
      result +=
        '\n\n' +
        (source?.note ??
          'Local page source unavailable: the readable content could not be saved; omitted content cannot be read locally.');
      const durationSeconds = (performance.now() - startTime) / 1000;
      runLogger.debug(
        `[WebFetch] returning processed content in ${durationSeconds.toFixed(2)}s`,
      );

      const toolUseResult: WebFetchResult = {
        bytes: response.bytes,
        code: response.code,
        codeText: response.codeText,
        result,
        durationMs: Math.round(durationSeconds * 1000),
        url,
      };
      return {
        llmContent: result,
        returnDisplay: toolUseResult,
        toolUseResult,
        data: summaryDiagnostic,
      };
    } catch (error: unknown) {
      if (isSessionIdInvariantError(error)) {
        runLogger.error(
          `[WebFetch] unavailable because the model session context is invalid: ${getErrorMessage(error)}`,
          error,
        );
        return {
          llmContent: INVALID_SESSION_CONTEXT_MESSAGE,
          returnDisplay: 'WebFetch unavailable: invalid session context.',
          error: {
            message: INVALID_SESSION_CONTEXT_MESSAGE,
            type: ToolErrorType.WEB_FETCH_PROCESSING_ERROR,
          },
          data: createWebFetchDiagnosticData(
            'secondary_model_request',
            'invalid_session_context',
            { details: { secondary_model: { used: true } } },
          ),
        };
      }
      if (isAbortError(error)) {
        const durationSeconds = (performance.now() - startTime) / 1000;
        runLogger.debug(
          `[WebFetch] cancelled after ${durationSeconds.toFixed(2)}s: ${this.params.url}`,
        );
        return {
          llmContent: 'Web fetch was cancelled.',
          returnDisplay: 'Fetch cancelled.',
        };
      }
      const errorMessage = `Error during web fetch for "${this.params.url}": ${getErrorMessage(error)}`;
      const data = isWebFetchDiagnosticError(error)
        ? error.data
        : createFetchProcessingDiagnosticData(error);
      runLogger.warn(errorMessage, error);
      return {
        llmContent: `Error: ${errorMessage}`,
        returnDisplay: errorMessage,
        error: {
          message: errorMessage,
          type: ToolErrorType.WEB_FETCH_PROCESSING_ERROR,
        },
        data,
      };
    }
  }

  /**
   * Applies the user prompt to the fetched content using a secondary model.
   */
  private async applyPromptToMarkdown(
    prompt: string,
    markdownContent: string,
    signal: AbortSignal,
    sessionId: string,
    isPreapprovedDomain: boolean,
    getModelPolicy?: GetModelPolicyCallback,
    updateOutput?: (output: ToolLiveOutput) => void,
    bodyTruncated = false,
  ): Promise<string> {
    runLogger.debug(
      `[WebFetch] applyPromptToMarkdown: contentLength=${markdownContent.length} truncated=${bodyTruncated} promptLength=${prompt.length}`,
    );

    const modelPrompt = makeSecondaryModelPrompt(
      markdownContent,
      prompt,
      isPreapprovedDomain,
      bodyTruncated,
    );

    // Pull-mode model selection: call getModelPolicy with purpose 'web_fetch'
    if (sessionId.trim().length === 0) {
      throw new SessionIdInvariantError(
        'Utility model requests require a non-empty sessionId.',
      );
    }
    let requestedModelKey: string | undefined;
    let policyTaskId: string | undefined;
    let policySubTask: string | undefined;
    if (getModelPolicy) {
      const policyResult = await getModelPolicy(
        'web_fetch',
        sessionId,
        0, // turnIndex — not applicable for web fetch
        undefined, // agentId
        signal,
        undefined, // extras
      );
      policyTaskId = policyResult?.labels?.taskId;
      policySubTask = policyResult?.labels?.subTask;
      if (policyResult?.model) {
        runLogger.debug(
          `[WebFetch] getModelPolicy returned model override: ${policyResult.model}`,
        );
        requestedModelKey = policyResult.model;
      }
    }

    const manager = this.context.config.getModelProviderManager();
    const baseSelection = requestedModelKey !== undefined
      ? await resolveModelSelectionOverride(manager, requestedModelKey)
      : await manager.select({ purpose: 'web_fetch' });
    const resolution = await manager.select({
      purpose: 'web_fetch',
      overrideSelection: {
        model: baseSelection.model,
        config: mergeModelConfig(baseSelection.config, {
          reasoning: { effort: 'none', thinking: { type: 'disabled' } },
          context: { maxOutputTokens: WEB_FETCH_MAX_OUTPUT_TOKENS },
        }),
      },
    });
    const { model } = resolution;
    signal.throwIfAborted();

    runLogger.debug(
      `[WebFetch] invoking secondary model (${model.key}), promptLength=${modelPrompt.length}`,
    );

    // The secondary model summarization can run ~15-25s with no intermediate
    // output. Emit an elapsed-time heartbeat so the tool call visibly advances
    // in the UI instead of looking stuck at "Fetching content from ...".
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let stopHeartbeat: (() => void) | undefined;
    if (updateOutput) {
      const analyzeStartedAt = Date.now();
      const emitProgress = () => {
        const elapsedSeconds = Math.round(
          (Date.now() - analyzeStartedAt) / 1000,
        );
        updateOutput(
          `Analyzing fetched content with the model… (${elapsedSeconds}s)`,
        );
      };
      emitProgress();
      heartbeat = setInterval(emitProgress, PROGRESS_HEARTBEAT_MS);
      // Don't let the heartbeat keep the process alive on its own.
      heartbeat.unref?.();
      stopHeartbeat = () => {
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = undefined;
        }
      };
      signal.addEventListener('abort', stopHeartbeat, { once: true });
      if (signal.aborted) stopHeartbeat();
    }

    let result: string;
    const secondaryStartedAt = performance.now();
    try {
      const parentBusiness = getBusinessInfoFromContext();
      const request = {
        resolution,
        prompt: { messages: [{ role: 'user' as const, content: modelPrompt }] },
        control: { signal },
        qoder: {
          identity: { sessionId, requestSetId: getRequestSetIdFromContext() },
          taskRouting: { taskId: WEB_FETCH_TASK_ID, policyTaskId },
          business: applyBusinessSubTask(
            {
              ...(parentBusiness ?? {
                ...resolveBusinessIdentity(),
                version: await getVersion(),
                id: randomUUID(),
                name: 'webfetch_summary',
                begin_at: Date.now(),
                stage: 'init',
              }),
              type: parentBusiness?.type ?? 'webfetch_summary',
            },
            undefined,
            policySubTask,
          ),
        },
      };
      const message = await (await manager.inference(request)).completed;
      result = message.blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (message.stopReason === 'max_tokens') {
        const notice =
          '[Response truncated because the model reached its output token limit.]';
        result = result.length > 0 ? `${result}\n\n${notice}` : notice;
      }
    } catch (error: unknown) {
      if (isAbortError(error) || isSessionIdInvariantError(error)) {
        throw error;
      }
      const status = getErrorStatus(error);
      const code = getErrorCode(error);
      runLogger.warn(
        `[WebFetch] secondary model call failed: ${getErrorMessage(error)}`,
      );
      const durationMs = Math.round(performance.now() - secondaryStartedAt);
      throw new WebFetchDiagnosticError(
        getErrorMessage(error),
        createWebFetchDiagnosticData(
          'secondary_model_request',
          classifyErrorSubtype(error),
          {
            httpStatus: status,
            networkErrorCode: code,
            details: {
              secondary_model: compactDiagnosticObject({
                used: true,
                model: model.key,
                provider: model.source,
                status,
                error_code: code,
                duration_ms: durationMs,
              }),
            },
          },
        ),
      );
    } finally {
      if (stopHeartbeat) {
        signal.removeEventListener('abort', stopHeartbeat);
        stopHeartbeat();
      }
    }

    const responseText = result;

    if (!responseText.trim()) {
      runLogger.warn(`[WebFetch] secondary model returned empty response`);
      return 'No response from model';
    }

    runLogger.debug(
      `[WebFetch] secondary model response: length=${responseText.length}`,
    );
    return responseText;
  }
}

// ---------------------------------------------------------------------------
// Tool class
// ---------------------------------------------------------------------------

/**
 * A tool to fetch web content and process it using a secondary model.
 */
class ContextWebFetchInvocation extends BaseToolInvocation<
  WebFetchToolParams,
  ToolResult
> {
  constructor(
    params: WebFetchToolParams,
    private readonly tool: WebFetchTool,
    name?: string,
    displayName?: string,
  ) {
    super(params, name, displayName);
  }
  getDescription(): string {
    return `Fetching content from ${new URL(this.params.url).hostname}`;
  }
  async execute(): Promise<ToolResult> {
    throw new Error('WebFetch requires a session config');
  }
  override executeWithContext(ctx: ToolUseContext): Promise<ToolResult> {
    if (!ctx.config) return this.execute();
    return this.tool.build(this.params, ctx).executeWithContext!(ctx);
  }
}

export class WebFetchTool extends BaseDeclarativeTool<
  WebFetchToolParams,
  ToolResult
> {
  static readonly Name = WEB_FETCH_TOOL_NAME;

  override get maxResultSizeChars(): number {
    // WebFetch bounds its preview and persists the full source itself. Keep the
    // source path and read instructions visible instead of truncating them again.
    return Infinity;
  }

  constructor(
    private readonly context?: WebFetchContext,
    private readonly contentProvider?: WebFetchContentProvider,
    private readonly preapprovedHostChecker: PreapprovedHostChecker =
      isPreapprovedHost,
  ) {
    super(
      WebFetchTool.Name,
      WEB_FETCH_DISPLAY_NAME,
      CORE_TOOL_SET.WebFetch.description!,
      Kind.Fetch,
      CORE_TOOL_SET.WebFetch.parametersJsonSchema,
      true, // isOutputMarkdown
      true, // canUpdateOutput
    );
  }

  override build(
    params: WebFetchToolParams,
    context?: ToolUseContext,
  ): ToolInvocation<WebFetchToolParams, ToolResult> {
    if (context?.config) {
      return new WebFetchTool(
        {
          config: context.config,
          promptId: context.promptId ?? this.context?.promptId ?? '',
        },
        this.contentProvider,
        this.preapprovedHostChecker,
      ).build(params);
    }
    return super.build(params, context);
  }

  /**
   * Validates the parameters for the WebFetch tool.
   */
  protected override validateToolParamValues(
    params: WebFetchToolParams,
  ): string | null {
    if (!params.url || params.url.trim() === '') {
      return "The 'url' parameter is required.";
    }
    if (!params.prompt || params.prompt.trim() === '') {
      return "The 'prompt' parameter is required.";
    }
    try {
      const parsed = new URL(params.url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return `Unsupported protocol: "${parsed.protocol}". Only http and https are supported.`;
      }
    } catch {
      return `Invalid URL: "${params.url}"`;
    }
    return null;
  }

  protected createInvocation(
    params: WebFetchToolParams,
    _toolName?: string,
    _toolDisplayName?: string,
  ): ToolInvocation<WebFetchToolParams, ToolResult> {
    if (!this.context) {
      return new ContextWebFetchInvocation(
        params,
        this,
        _toolName,
        _toolDisplayName,
      );
    }
    return new WebFetchToolInvocation(
      this.context,
      params,
      _toolName,
      _toolDisplayName,
      this.contentProvider,
      this.preapprovedHostChecker,
    );
  }

  // === Permission Pipeline methods ===

  override toClassifierInput(input: WebFetchToolParams): unknown {
    return input.prompt ? `${input.url}: ${input.prompt}` : input.url;
  }
}
