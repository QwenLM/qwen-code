/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { LRUCache } from 'mnemonist';
import type { Config } from '../config/config.js';
import {
  fetchWithPolicy,
  type FetchPolicyRedirect,
  type FetchPolicyResponse,
  isConnectionLevelError,
  isPrivateHost,
} from '../utils/fetch.js';
import type { Storage } from '../config/storage.js';
import { MAX_SESSION_BYTES } from '../utils/truncation.js';
import {
  formatByteSize,
  isBinaryContentType,
  persistBinaryContent,
  sniffFileKind,
} from '../utils/binary-content.js';
import { extractPDFText } from '../utils/pdf.js';
import { runSideQuery } from '../utils/sideQuery.js';
import { ToolErrorType } from './tool-error.js';
import type {
  ToolCallConfirmationDetails,
  ToolInvocation,
  ToolResult,
  ToolConfirmationPayload,
  ToolConfirmationOutcome,
} from './tools.js';
import type { PermissionDecision } from '../permissions/types.js';
import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import { isPreapprovedUrl } from './web-fetch-preapproved.js';
import { createDebugLogger, type DebugLogger } from '../utils/debugLogger.js';

// Full-transfer budget: headers AND body must complete within this window.
const FETCH_TIMEOUT_MS = 60_000;
// Truncation applies to converted/decoded text, never to raw HTML — cutting
// markup before conversion silently destroys content deep in large pages.
const MAX_CONTENT_CHARS = 100_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 10;

const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_CAPACITY = 32;
// mnemonist's LRUCache has no byte-size accounting; refusing to cache huge
// conversions bounds worst-case memory at CACHE_CAPACITY * this limit.
const MAX_CACHEABLE_CHARS = 2 * 1024 * 1024;

interface CacheEntry {
  fetchedAt: number;
  status: number;
  statusText: string;
  contentType: string;
  byteLength: number;
  finalUrl: string;
  /**
   * Model-facing text, already truncated: converted markdown for HTML,
   * decoded text for textual types, extracted text for PDFs, '' for other
   * binary content.
   */
  content: string;
  persistedPath?: string;
  persistedSize?: number;
  /** Sniffed mime for the persisted-file note (Content-Type may lie). */
  persistedMime?: string;
}

// Caches are keyed by the session's Storage object: one process can host
// several sessions (ACP/SDK) with distinct runtime directories, and a shared
// cache would leak content and persisted-file paths across them. Keying on
// Storage rather than Config also invalidates the cache when a session
// relocates its workspace (/cd replaces config.storage with a new Storage),
// so stale persisted paths under the old project temp dir are never served.
let cachesByStorage = new WeakMap<Storage, LRUCache<string, CacheEntry>>();

function getUrlCacheFor(storage: Storage): LRUCache<string, CacheEntry> {
  let cache = cachesByStorage.get(storage);
  if (!cache) {
    cache = new LRUCache<string, CacheEntry>(CACHE_CAPACITY);
    cachesByStorage.set(storage, cache);
  }
  return cache;
}

export function clearWebFetchCache(): void {
  cachesByStorage = new WeakMap();
}

// Lazy singleton: defers the turndown import until the first HTML fetch and
// reuses one instance (construction builds rule objects; .turndown() is
// stateless).
interface HtmlToMarkdownConverter {
  turndown(html: string): string;
}
let turndownPromise: Promise<HtmlToMarkdownConverter> | undefined;
function getTurndownService(): Promise<HtmlToMarkdownConverter> {
  return (turndownPromise ??= import('turndown').then((m) => {
    const service = new m.default();
    // Turndown keeps the text of script/style by default; hydration blobs
    // and inline CSS would eat the truncation budget before real content.
    service.remove(['script', 'style', 'noscript']);
    // The html-to-text predecessor skipped images; turndown would emit
    // ![alt](src) — a single data-URI image can consume the entire
    // truncation budget. Anchors keep their hrefs; only images drop.
    service.addRule('drop-images', {
      filter: 'img',
      replacement: () => '',
    });
    return service;
  }));
}

const USER_AGENT_SUFFIX = `(${process.platform}; ${process.arch})`;

/**
 * GitHub blob pages are HTML wrappers; the raw host serves the file itself.
 * This rewrite is applied at invocation-BUILD time (not fetch time) so that
 * permission rules, the confirmation dialog, preapproval, and the network
 * request all see the same destination host — an ask/deny rule for
 * raw.githubusercontent.com must match the request that actually goes there.
 * Matching is on the parsed hostname (github.com, or its www form) and an
 * /owner/repo/blob/... path shape: a lookalike host merely containing
 * "github.com" as a substring, or "github.com"/"/blob/" appearing in the
 * path or query of an unrelated URL, must never trigger the rewrite.
 */
export function rewriteGitHubBlobUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host !== 'github.com' && host !== 'www.github.com') {
      return url;
    }
    const rawPath = parsed.pathname.replace(/^(\/[^/]+\/[^/]+)\/blob\//, '$1/');
    if (rawPath === parsed.pathname) {
      return url;
    }
    parsed.hostname = 'raw.githubusercontent.com';
    parsed.pathname = rawPath;
    return parsed.toString();
  } catch {
    return url;
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

// Hint read_file only for formats it can actually display (mirrors the
// natively-rendered kinds in fileUtils detectFileType: pdf and images); for
// anything else, state the path and let the model pick a tool (shell,
// python, unzip) — a wrong hint sends it down a dead end.
function readHintForPath(persistedPath: string): string {
  if (persistedPath.endsWith('.pdf')) {
    return ` Use ${ToolNames.READ_FILE} to examine it (reads PDFs natively; pass pages for large files).`;
  }
  if (/\.(png|jpe?g|gif|webp|svg)$/.test(persistedPath)) {
    return ` Use ${ToolNames.READ_FILE} to view it.`;
  }
  return '';
}

function truncateText(text: string): string {
  if (text.length <= MAX_CONTENT_CHARS) {
    return text;
  }
  return (
    text.slice(0, MAX_CONTENT_CHARS) +
    `\n\n[Content truncated: showing first ${MAX_CONTENT_CHARS.toLocaleString('en-US')} of ${text.length.toLocaleString('en-US')} characters]`
  );
}

/**
 * Parameters for the WebFetch tool
 */
export interface WebFetchToolParams {
  /**
   * The URL to fetch content from
   */
  url: string;
  /**
   * The prompt to run on the fetched content
   */
  prompt: string;
  /**
   * Preferred content format (controls only the Accept header)
   * All content is normalized to plain text for LLM processing
   * - auto: Prefers markdown via content negotiation (default)
   * - markdown: Prefer markdown format
   * - html: Prefer HTML format (still converted to text)
   * - text: Prefer plain text format
   */
  format?: 'auto' | 'markdown' | 'html' | 'text';
}

/**
 * Implementation of the WebFetch tool invocation logic
 */
class WebFetchToolInvocation extends BaseToolInvocation<
  WebFetchToolParams,
  ToolResult
> {
  private readonly debugLogger: DebugLogger;

  constructor(
    private readonly config: Config,
    params: WebFetchToolParams,
  ) {
    super(params);
    this.debugLogger = createDebugLogger('WEB_FETCH');
  }

  private getAcceptHeader(): string {
    const format = this.params.format ?? 'auto';
    switch (format) {
      case 'markdown':
        return 'text/markdown, */*;q=0.1';
      case 'html':
        return 'text/html, */*;q=0.1';
      case 'text':
        return 'text/plain, */*;q=0.1';
      case 'auto':
      default:
        return 'text/markdown, text/html;q=0.9, text/plain;q=0.8, */*;q=0.1';
    }
  }

  private getUserAgent(): string {
    const version = this.config.getCliVersion?.() || 'unknown';
    return `QwenCode/${version} ${USER_AGENT_SUFFIX}`;
  }

  private fetchPlan?: { url: string; upgradedFrom?: string };

  /** The URL actually fetched: blob→raw for GitHub, https upgrade for public hosts. */
  private getFetchUrl(): string {
    return this.getFetchPlan().url;
  }

  private getFetchPlan(): { url: string; upgradedFrom?: string } {
    return (this.fetchPlan ??= this.computeFetchPlan());
  }

  private computeFetchPlan(): { url: string; upgradedFrom?: string } {
    // params.url is already blob→raw normalized at build time (see
    // rewriteGitHubBlobUrl) — only the scheme concern lives here, since the
    // https upgrade never changes the host that permission rules match on.
    let url = this.params.url;
    let upgradedFrom: string | undefined;

    // Upgrade http to https for public hosts on the default port only —
    // localhost/private dev servers legitimately speak plain http, and an
    // explicit non-default port (e.g. :8080) usually means a service that
    // does not answer TLS. Parsing normalizes an explicit :80 away, so the
    // upgraded URL targets 443 rather than TLS-on-80.
    if (url.toLowerCase().startsWith('http://') && !isPrivateHost(url)) {
      try {
        const parsed = new URL(url);
        if (parsed.port === '') {
          upgradedFrom = url;
          parsed.protocol = 'https:';
          url = parsed.toString();
          this.debugLogger.debug(`[WebFetchTool] Upgraded to https: ${url}`);
        }
      } catch {
        // keep the original URL
      }
    }

    return { url, upgradedFrom };
  }

  private buildRedirectResult(redirect: FetchPolicyRedirect): ToolResult {
    const redirectHost = hostnameOf(redirect.redirectUrl);
    const message = `REDIRECT DETECTED: The URL redirects to a different host (or scheme/port), which was not followed automatically.

Original URL: ${redirect.originalUrl}
Redirect URL: ${redirect.redirectUrl}
Status: ${redirect.status}

To fetch the redirected content, call ${WebFetchTool.Name} again with:
- url: "${redirect.redirectUrl}"
- prompt: "${this.params.prompt}"`;
    return {
      llmContent: message,
      returnDisplay: `Redirected to ${redirectHost} (${redirect.status}) — not followed (different host or scheme/port).`,
    };
  }

  private buildMetadataHeader(entry: CacheEntry): string {
    const urlLine =
      entry.finalUrl !== this.params.url
        ? `URL: ${this.params.url} (final: ${entry.finalUrl})`
        : `URL: ${this.params.url}`;
    return `${urlLine}
Status: ${entry.status} ${entry.statusText || 'OK'} | Content-Type: ${entry.contentType || 'unknown'} | Size: ${entry.byteLength.toLocaleString('en-US')} bytes`;
  }

  private async fetchAndProcess(
    signal: AbortSignal,
  ): Promise<CacheEntry | FetchPolicyRedirect> {
    const fetchUrl = this.getFetchUrl();
    const acceptHeader = this.getAcceptHeader();
    const urlCache = getUrlCacheFor(this.config.storage);

    // The format param changes the Accept header, which can change what the
    // server returns — a URL-only key would serve format:'html' content to a
    // later format:'markdown' call. The session ID isolates conversations
    // that share one Config/Storage (/clear and /new call startNewSession
    // with a fresh ID); old-session entries age out of the LRU.
    const cacheKey = `${this.config.getSessionId?.() ?? ''}|${acceptHeader} ${fetchUrl}`;
    const cached = urlCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      this.debugLogger.debug(`[WebFetchTool] Cache hit for ${fetchUrl}`);
      return cached;
    }
    this.debugLogger.debug(
      `[WebFetchTool] Fetching ${fetchUrl} (Accept: ${acceptHeader})`,
    );

    const policyOptions = {
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
      maxRedirects: MAX_REDIRECTS,
      signal,
      headers: {
        Accept: acceptHeader,
        'User-Agent': this.getUserAgent(),
      },
    };

    let result;
    let usedHttpFallback = false;
    try {
      result = await fetchWithPolicy(fetchUrl, policyOptions);
    } catch (error) {
      // The https upgrade is opportunistic. When the connection/TLS
      // handshake itself fails (intranet FQDNs resolving to private
      // addresses that only serve plain http), fall back to the URL the
      // caller actually asked for — the user approved the http URL they
      // supplied, and fallback responses are never cached (see below).
      const { upgradedFrom } = this.getFetchPlan();
      if (upgradedFrom && isConnectionLevelError(error)) {
        this.debugLogger.debug(
          `[WebFetchTool] https upgrade failed (${(error as Error).message}); retrying original ${upgradedFrom}`,
        );
        result = await fetchWithPolicy(upgradedFrom, policyOptions);
        usedHttpFallback = true;
      } else {
        throw error;
      }
    }

    if (result.kind === 'cross-host-redirect') {
      // Never cached; the caller converts it into a redirect ToolResult.
      return result;
    }

    const response: FetchPolicyResponse = result;
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Request failed with status code ${response.status} ${response.statusText}`,
      );
    }

    const contentType = response.contentType;
    const sniff = sniffFileKind(
      response.body,
      contentType,
      response.contentDisposition,
      response.finalUrl,
    );
    // Servers frequently mislabel binaries (PDF as application/octet-stream
    // or even text/*) — a magic-byte match overrides the Content-Type. When
    // no Content-Type was sent at all, trust a RECOGNIZED filename/URL
    // extension (including a literal .bin) — but never the 'bin' fallback
    // (unknown is not binary), and svg is textual.
    const isBinary =
      isBinaryContentType(contentType) ||
      sniff.magicMatched ||
      (!contentType &&
        sniff.extensionSource === 'name' &&
        sniff.extension !== 'svg');

    let persistedPath: string | undefined;
    let persistedSize: number | undefined;
    let persistedMime: string | undefined;
    let content: string;

    if (isBinary) {
      // Keep the raw bytes on disk so the model (or shell tools) can inspect
      // them. Binary bytes are never UTF-8 decoded for the side-query —
      // mojibake wastes tokens and misleads the model. PDFs get real text
      // extraction instead.
      // Persisted binaries count against the same session disk budget as
      // other tool-result persistence (reserve before the async write;
      // roll back on failure).
      const budgetUsed = this.config.getToolResultBytesWritten();
      if (budgetUsed + response.body.length > MAX_SESSION_BYTES) {
        throw new Error(
          `Fetched ${response.body.length} bytes of binary content (${contentType || 'unknown content type'}) but the session's tool-result disk budget is exhausted (${budgetUsed} bytes used of ${MAX_SESSION_BYTES}).`,
        );
      }
      this.config.trackToolResultBytes(response.body.length);

      const persistId = `webfetch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const persisted = await persistBinaryContent(
        response.body,
        sniff.extension,
        this.config.storage.getToolResultsDir(),
        persistId,
      );
      if ('error' in persisted) {
        this.config.trackToolResultBytes(-response.body.length);
        this.debugLogger.error(
          `[WebFetchTool] Failed to persist binary content: ${persisted.error}`,
        );
        // Binary content that can be neither persisted nor decoded is
        // unusable — surfacing a fake success would feed the side-query no
        // data and mislead the model. Fail the tool call instead.
        throw new Error(
          `Fetched ${response.body.length} bytes of binary content (${contentType || 'unknown content type'}) but failed to save it: ${persisted.error}`,
        );
      }
      persistedPath = persisted.filepath;
      persistedSize = persisted.size;
      persistedMime = sniff.mimeType || contentType;

      content = '';
      if (sniff.extension === 'pdf' && persistedPath) {
        const pdfText = await extractPDFText(persistedPath, { signal });
        if (pdfText.success && pdfText.text.trim()) {
          content = truncateText(pdfText.text);
        } else if (!pdfText.success) {
          this.debugLogger.debug(
            `[WebFetchTool] PDF text extraction failed: ${pdfText.error}`,
          );
        }
      }
    } else if (contentType.includes('text/html')) {
      this.debugLogger.debug('[WebFetchTool] Converting HTML to markdown');
      const decoded = response.body.toString('utf-8');
      try {
        const turndown = await getTurndownService();
        content = truncateText(turndown.turndown(decoded));
      } catch (error) {
        this.debugLogger.error(
          `[WebFetchTool] HTML conversion failed, using raw text`,
          error,
        );
        content = truncateText(decoded);
      }
    } else {
      content = truncateText(response.body.toString('utf-8'));
    }

    const entry: CacheEntry = {
      fetchedAt: Date.now(),
      status: response.status,
      statusText: response.statusText,
      contentType,
      byteLength: response.body.length,
      finalUrl: response.finalUrl,
      content,
      persistedPath,
      persistedSize,
      persistedMime,
    };
    // Never cache a fallback response under the cache key: the key is derived
    // from the upgraded https URL, but the bytes came over plaintext http.
    // Caching them would let a later EXPLICIT https fetch of the same URL hit
    // this entry and receive plaintext content without contacting the TLS
    // endpoint — a silent downgrade of exactly the no-downgrade guarantee the
    // fallback is scoped to preserve.
    if (!usedHttpFallback && content.length <= MAX_CACHEABLE_CHARS) {
      urlCache.set(cacheKey, entry);
    }
    return entry;
  }

  private async executeDirectFetch(signal: AbortSignal): Promise<ToolResult> {
    try {
      const entry = await this.fetchAndProcess(signal);
      // CacheEntry has no 'kind' discriminant — this narrows to the redirect.
      if ('kind' in entry) {
        return this.buildRedirectResult(entry);
      }

      const header = this.buildMetadataHeader(entry);
      const binaryNote = entry.persistedPath
        ? `\n\n[Binary content (${entry.persistedMime || entry.contentType || 'unknown'}, ${formatByteSize(entry.persistedSize ?? entry.byteLength)}) saved to ${entry.persistedPath}.${readHintForPath(entry.persistedPath)}]`
        : '';

      const displaySummary = `Received ${formatByteSize(entry.byteLength)} (${entry.status} ${entry.statusText || 'OK'}) from ${hostnameOf(this.params.url)}${entry.persistedPath ? ` — binary saved to ${entry.persistedPath}` : ''}`;

      // Binary with no extractable text: nothing useful to summarize —
      // return the metadata and file location without a side-query call.
      if (entry.persistedPath && !entry.content) {
        return {
          llmContent: `${header}\n\n[No text could be extracted from this binary content.]${binaryNote}`,
          returnDisplay: displaySummary,
          resultFilePaths: [entry.persistedPath],
        };
      }

      // Trusted markdown passthrough: for a curated docs host serving
      // text/markdown under the size cap, return the content verbatim — zero
      // summarization fidelity loss, no extra model call. This is the list's
      // ONLY remaining job: it is a content-processing optimization decided
      // AFTER the fetch was already permitted and completed, never a
      // permission/network grant. Evaluated against the FINAL URL (post
      // blob→raw rewrite and followed redirects) so a redirect out of a
      // path-scoped entry (github.com/QwenLM → elsewhere) falls back to
      // summarization instead of passing through unrelated content.
      const preapproved = isPreapprovedUrl(entry.finalUrl);
      if (
        preapproved &&
        entry.contentType.includes('text/markdown') &&
        entry.content.length <= MAX_CONTENT_CHARS
      ) {
        return {
          llmContent: `${header}\n\n${entry.content}${binaryNote}`,
          returnDisplay: displaySummary,
          ...(entry.persistedPath
            ? { resultFilePaths: [entry.persistedPath] }
            : {}),
        };
      }

      const fallbackPrompt = `The user requested the following: "${this.params.prompt}".

I have fetched the content from ${this.params.url}. Fetch metadata:
${header}

Please use the following content to answer the user's request.

---
${entry.content}
---`;

      const result = await runSideQuery(this.config, {
        purpose: 'web-fetch',
        // Pin to the main model — fast model loses too much fidelity on
        // long, rich source material.
        model: this.config.getModel(),
        // Best-effort: the outer catch already converts processing failures
        // into a tool error; retrying 7× just delays that fallback.
        maxAttempts: 1,
        contents: [{ role: 'user', parts: [{ text: fallbackPrompt }] }],
        systemInstruction:
          'Extract and summarize the requested information from the provided web content. ' +
          'Be concise and accurate. Respond only with the requested information.',
        abortSignal: signal,
      });
      let resultText = (result.text || '').trim();
      if (!resultText) {
        resultText =
          '[The processing model returned no content. The fetch itself succeeded — see the metadata above.]';
      }

      return {
        llmContent: `${header}\n\n${resultText}${binaryNote}`,
        returnDisplay: displaySummary,
        ...(entry.persistedPath
          ? { resultFilePaths: [entry.persistedPath] }
          : {}),
      };
    } catch (e) {
      const error = e as Error;
      const errorMessage = `Error during fetch for ${this.params.url}: ${error.message}`;
      this.debugLogger.error(`[WebFetchTool] ${errorMessage}`, error);
      return {
        llmContent: `Error: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}`,
        error: {
          message: errorMessage,
          type: ToolErrorType.WEB_FETCH_FALLBACK_FAILED,
        },
      };
    }
  }

  override getDescription(): string {
    const displayPrompt =
      this.params.prompt.length > 100
        ? this.params.prompt.substring(0, 97) + '...'
        : this.params.prompt;
    const format = this.params.format ?? 'auto';
    return `Fetching content from ${this.params.url} (format: ${format}) and processing with prompt: "${displayPrompt}"`;
  }

  /**
   * WebFetch always requires confirmation: it is an egress operation, not a
   * read. A GET discloses its full path and query to a third party, so a
   * model-produced URL (e.g. under prompt injection) is an exfiltration
   * channel regardless of how "trusted" the host is — there is no curated
   * host list this tool can safely auto-allow on the user's behalf. The
   * permission flow consults this default only when no user rule matches, so
   * a user who wants a no-prompt host can still add their own allow rule.
   * (In AUTO mode, WebFetch is excluded from the safe-tool allowlist and
   * instead judged by the exfiltration-aware classifier.)
   */
  override async getDefaultPermission(): Promise<PermissionDecision> {
    return 'ask';
  }

  /**
   * Constructs the web fetch confirmation details.
   */
  override async getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails> {
    // Extract the domain for the permission rule.
    const permissionRules = [`WebFetch(${hostnameOf(this.params.url)})`];

    const confirmationDetails: ToolCallConfirmationDetails = {
      type: 'info',
      title: `Confirm Web Fetch`,
      prompt: `Fetch content from ${this.params.url} and process with: ${this.params.prompt}`,
      urls: [this.params.url],
      permissionRules,
      onConfirm: async (
        _outcome: ToolConfirmationOutcome,
        _payload?: ToolConfirmationPayload,
      ) => {
        // No-op: persistence is handled by coreToolScheduler via PM rules
      },
    };
    return confirmationDetails;
  }

  async execute(signal: AbortSignal): Promise<ToolResult> {
    return this.executeDirectFetch(signal);
  }
}

/**
 * Implementation of the WebFetch tool logic
 */
export class WebFetchTool extends BaseDeclarativeTool<
  WebFetchToolParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.WEB_FETCH;

  constructor(private readonly config: Config) {
    super(
      WebFetchTool.Name,
      ToolDisplayNames.WEB_FETCH,
      'Fetches content from a specified URL and processes it using an AI model\n- Takes a URL and a prompt as input\n- Supports content negotiation for markdown (reduces tokens by ~80%)\n- Fetches the URL content and converts HTML to markdown (links preserved)\n- Processes the content with the prompt using an AI model\n- Returns the model\'s response about the content, prefixed with fetch metadata (HTTP status, content type, size)\n- Use this tool when you need to retrieve and analyze web content\n\nUsage notes:\n  - IMPORTANT: This tool cannot access authenticated or private URLs (e.g. Google Docs, Confluence, Jira, private GitHub). If an MCP-provided web fetch tool is available, prefer using that tool instead of this one, as it may have fewer restrictions. All MCP-provided tools start with "mcp__".\n  - The URL must be a fully-formed valid URL\n  - Plain-http URLs to public hosts are upgraded to https automatically; localhost/private hosts are fetched as-is\n  - When a URL redirects to a different host, the redirect is NOT followed; the tool returns the redirect URL so you can re-issue web_fetch with it\n  - Binary content (PDFs, images, archives) is saved to a local file; the result includes the file path — use read_file on it (it reads PDFs and images natively)\n  - Repeated fetches of the same URL within 15 minutes are served from a local cache\n  - The prompt should describe what information you want to extract from the page\n  - format parameter (optional): controls only the Accept header sent to the server. All content is normalized to plain text for LLM processing, regardless of format.\n  - "auto" (default): Prefers markdown via content negotiation, accepts HTML, text, or other content as fallback. Use when user does NOT specify a format.\n  - "markdown": Prefers text/markdown. Use when user explicitly asks for markdown content.\n  - "html": Prefers text/html. Content is still converted to markdown for LLM processing.\n  - "text": Prefers text/plain. Use when user explicitly asks for plain text.\n  - This tool does not modify any files (other than saving fetched binary content)\n  - Results may be summarized if the content is very large\n  - Supports both public and private/localhost URLs using direct fetch',
      Kind.Fetch,
      {
        properties: {
          url: {
            description: 'The URL to fetch content from',
            type: 'string',
          },
          prompt: {
            description: 'The prompt to run on the fetched content',
            type: 'string',
          },
          format: {
            description:
              'Preferred content format (Accept header only): auto (default, prefers markdown), markdown, html, or text. All content is normalized to plain text.',
            type: 'string',
            enum: ['auto', 'markdown', 'html', 'text'],
          },
        },
        required: ['url', 'prompt'],
        type: 'object',
      },
      true, // isOutputMarkdown
      false, // canUpdateOutput
      true, // shouldDefer — web fetching is infrequent
      false, // alwaysLoad
      'web fetch url http download content',
    );
  }

  protected override validateToolParamValues(
    params: WebFetchToolParams,
  ): string | null {
    if (!params.url || params.url.trim() === '') {
      return "The 'url' parameter cannot be empty.";
    }
    // Regex rejects non-http(s) schemes and malformed authority that new URL() normalizes away.
    if (!/^https?:\/\//i.test(params.url)) {
      return "The 'url' must be a valid URL starting with http:// or https://.";
    }
    try {
      const parsedUrl = new URL(params.url);
      if (parsedUrl.username || parsedUrl.password) {
        return "The 'url' must not include credentials.";
      }
    } catch {
      return "The 'url' is malformed and could not be parsed.";
    }
    if (!params.prompt || params.prompt.trim() === '') {
      return "The 'prompt' parameter cannot be empty.";
    }
    return null;
  }

  protected createInvocation(
    params: WebFetchToolParams,
  ): ToolInvocation<WebFetchToolParams, ToolResult> {
    // Normalize before the invocation exists: the scheduler feeds
    // invocation.params into evaluatePermissionFlow, so this is what makes
    // domain rules match the host actually contacted.
    return new WebFetchToolInvocation(this.config, {
      ...params,
      url: rewriteGitHubBlobUrl(params.url),
    });
  }

  override toAutoClassifierInput(
    params: WebFetchToolParams,
  ): Record<string, unknown> {
    // Do not forward the prompt — it may contain sensitive context.
    return { url: params.url };
  }
}
