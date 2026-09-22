// Force strict mode and setup for ESM
"use strict";
import {
  parsePositiveIntegerEnv
} from "./chunk-6PVPNMXU.js";
import {
  fetchWithPolicy,
  isConnectionLevelError,
  isPrivateHost
} from "./chunk-KKPIFWTZ.js";
import "./chunk-NFC4WTY2.js";
import "./chunk-YSD6IY6F.js";
import "./chunk-MS4SXNJ6.js";
import {
  MAX_SESSION_BYTES,
  import_lru_cache
} from "./chunk-KKGSJZWK.js";
import "./chunk-5ETULJLP.js";
import "./chunk-VGC4I5JJ.js";
import "./chunk-RVT5L74D.js";
import "./chunk-HD7O6WLV.js";
import {
  extractPDFText,
  formatByteSize,
  isBinaryContentType,
  looksLikeText,
  persistBinaryContent,
  sniffFileKind
} from "./chunk-25FMWESU.js";
import "./chunk-CFMZLE3L.js";
import {
  runSideQuery
} from "./chunk-43QUA4MC.js";
import "./chunk-WZAD4ZNJ.js";
import "./chunk-EKBQJ627.js";
import "./chunk-KUON6Z6R.js";
import "./chunk-XZA32HII.js";
import "./chunk-CA63HYHU.js";
import "./chunk-SBP43AO6.js";
import "./chunk-HHJLM3WQ.js";
import "./chunk-B3XJFEEH.js";
import "./chunk-74TONY4F.js";
import "./chunk-ZRQGTRHA.js";
import {
  BaseDeclarativeTool,
  BaseToolInvocation
} from "./chunk-VPGRGNNH.js";
import {
  ToolDisplayNames,
  ToolNames
} from "./chunk-ERIBG3BX.js";
import {
  createDebugLogger
} from "./chunk-ZYDMQCQP.js";
import {
  getErrorMessage
} from "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import "./chunk-75DOP5OR.js";
import "./chunk-DMTGGOSA.js";
import "./chunk-YQ3U5MUC.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/web-fetch.ts
init_esbuild_shims();

// packages/core/src/tools/web-fetch-preapproved.ts
init_esbuild_shims();
var PREAPPROVED_HOSTS = /* @__PURE__ */ new Set([
  // Qwen ecosystem
  "qwenlm.github.io",
  "qwen.readthedocs.io",
  "github.com/QwenLM",
  // Matches QwenLM raw files whether requested directly or via a github.com
  // blob URL (the tool rewrites those to this host before fetching).
  "raw.githubusercontent.com/QwenLM",
  "modelcontextprotocol.io",
  // Top programming languages
  "docs.python.org",
  "en.cppreference.com",
  "docs.oracle.com",
  "learn.microsoft.com",
  "developer.mozilla.org",
  "go.dev",
  "pkg.go.dev",
  "www.php.net",
  "docs.swift.org",
  "kotlinlang.org",
  "ruby-doc.org",
  "doc.rust-lang.org",
  "www.typescriptlang.org",
  // Web & JavaScript frameworks/libraries
  "react.dev",
  "angular.io",
  "vuejs.org",
  "nextjs.org",
  "expressjs.com",
  "nodejs.org",
  "bun.sh",
  "jquery.com",
  "getbootstrap.com",
  "tailwindcss.com",
  "d3js.org",
  "threejs.org",
  "redux.js.org",
  "webpack.js.org",
  "jestjs.io",
  "reactrouter.com",
  // Python frameworks & libraries
  "docs.djangoproject.com",
  "flask.palletsprojects.com",
  "fastapi.tiangolo.com",
  "pandas.pydata.org",
  "numpy.org",
  "www.tensorflow.org",
  "pytorch.org",
  "scikit-learn.org",
  "matplotlib.org",
  "requests.readthedocs.io",
  "jupyter.org",
  // PHP frameworks
  "laravel.com",
  "symfony.com",
  "wordpress.org",
  // Java frameworks & libraries
  "docs.spring.io",
  "hibernate.org",
  "tomcat.apache.org",
  "gradle.org",
  "maven.apache.org",
  // .NET & C# frameworks
  "asp.net",
  "dotnet.microsoft.com",
  "nuget.org",
  "blazor.net",
  // Mobile development
  "reactnative.dev",
  "docs.flutter.dev",
  "developer.apple.com",
  "developer.android.com",
  // Data science & machine learning
  "keras.io",
  "spark.apache.org",
  "huggingface.co",
  "www.kaggle.com",
  // Databases
  "www.mongodb.com",
  "redis.io",
  "www.postgresql.org",
  "dev.mysql.com",
  "www.sqlite.org",
  "graphql.org",
  "prisma.io",
  // Cloud & DevOps
  "docs.aws.amazon.com",
  "cloud.google.com",
  "kubernetes.io",
  "www.docker.com",
  "www.terraform.io",
  "www.ansible.com",
  "vercel.com/docs",
  "docs.netlify.com",
  "devcenter.heroku.com",
  // Testing & monitoring
  "cypress.io",
  "selenium.dev",
  // Game development
  "docs.unity.com",
  "docs.unrealengine.com",
  // Other essential tools
  "git-scm.com",
  "nginx.org",
  "httpd.apache.org"
]);
var stripWww = /* @__PURE__ */ __name((hostname) => hostname.replace(/^www\./, ""), "stripWww");
var { HOSTNAME_ONLY, PATH_PREFIXES } = (() => {
  const hosts = /* @__PURE__ */ new Set();
  const paths = /* @__PURE__ */ new Map();
  for (const entry of PREAPPROVED_HOSTS) {
    const slash = entry.indexOf("/");
    if (slash === -1) {
      hosts.add(stripWww(entry));
    } else {
      const host = stripWww(entry.slice(0, slash));
      const prefix = entry.slice(slash).toLowerCase();
      const prefixes = paths.get(host);
      if (prefixes) {
        prefixes.push(prefix);
      } else {
        paths.set(host, [prefix]);
      }
    }
  }
  return { HOSTNAME_ONLY: hosts, PATH_PREFIXES: paths };
})();
function isPreapprovedHost(hostname, pathname) {
  const host = stripWww(hostname.toLowerCase());
  if (HOSTNAME_ONLY.has(host)) {
    return true;
  }
  const prefixes = PATH_PREFIXES.get(host);
  if (prefixes) {
    const path = pathname.toLowerCase();
    for (const prefix of prefixes) {
      if (path === prefix || path.startsWith(prefix + "/")) {
        return true;
      }
    }
  }
  return false;
}
__name(isPreapprovedHost, "isPreapprovedHost");
function isPreapprovedUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && isPreapprovedHost(parsed.hostname, parsed.pathname);
  } catch {
    return false;
  }
}
__name(isPreapprovedUrl, "isPreapprovedUrl");

// packages/core/src/tools/web-fetch.ts
var FETCH_TIMEOUT_MS = 6e4;
var SIDE_QUERY_TIMEOUT_MS = 3e5;
function sideQueryTimeoutMs() {
  const value = parsePositiveIntegerEnv(
    process.env["QWEN_WEB_FETCH_PROCESSING_TIMEOUT_MS"],
    SIDE_QUERY_TIMEOUT_MS
  );
  return value > 2147483647 ? SIDE_QUERY_TIMEOUT_MS : value;
}
__name(sideQueryTimeoutMs, "sideQueryTimeoutMs");
var MAX_CONTENT_CHARS = 1e5;
var MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
var MAX_REDIRECTS = 10;
var CACHE_TTL_MS = 15 * 60 * 1e3;
var CACHE_CAPACITY = 32;
var MAX_CACHEABLE_CHARS = 2 * 1024 * 1024;
var cachesByStorage = /* @__PURE__ */ new WeakMap();
function getUrlCacheFor(storage) {
  let cache = cachesByStorage.get(storage);
  if (!cache) {
    cache = new import_lru_cache.default(CACHE_CAPACITY);
    cachesByStorage.set(storage, cache);
  }
  return cache;
}
__name(getUrlCacheFor, "getUrlCacheFor");
function clearWebFetchCache() {
  cachesByStorage = /* @__PURE__ */ new WeakMap();
}
__name(clearWebFetchCache, "clearWebFetchCache");
var turndownPromise;
function getTurndownService() {
  return turndownPromise ??= import("./turndown.cjs-FZHGMUTY.js").then((m) => {
    const service = new m.default();
    service.remove(["script", "style", "noscript"]);
    service.addRule("drop-images", {
      filter: "img",
      replacement: /* @__PURE__ */ __name(() => "", "replacement")
    });
    return service;
  });
}
__name(getTurndownService, "getTurndownService");
var USER_AGENT_SUFFIX = `(${process.platform}; ${process.arch})`;
function rewriteGitHubBlobUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") {
      return url;
    }
    const rawPath = parsed.pathname.replace(/^(\/[^/]+\/[^/]+)\/blob\//, "$1/");
    if (rawPath === parsed.pathname) {
      return url;
    }
    parsed.hostname = "raw.githubusercontent.com";
    parsed.pathname = rawPath;
    return parsed.toString();
  } catch {
    return url;
  }
}
__name(rewriteGitHubBlobUrl, "rewriteGitHubBlobUrl");
function hostnameOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}
__name(hostnameOf, "hostnameOf");
function readHintForPath(persistedPath) {
  if (persistedPath.endsWith(".pdf")) {
    return ` Use ${ToolNames.READ_FILE} to examine it (reads PDFs natively; pass pages for large files).`;
  }
  if (/\.(png|jpe?g|gif|webp)$/.test(persistedPath)) {
    return ` Use ${ToolNames.READ_FILE} to view it.`;
  }
  return "";
}
__name(readHintForPath, "readHintForPath");
function truncateText(text) {
  if (text.length <= MAX_CONTENT_CHARS) {
    return text;
  }
  return text.slice(0, MAX_CONTENT_CHARS) + `

[Content truncated: showing first ${MAX_CONTENT_CHARS.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} characters]`;
}
__name(truncateText, "truncateText");
var WebFetchToolInvocation = class extends BaseToolInvocation {
  constructor(config, params) {
    super(params);
    this.config = config;
    this.debugLogger = createDebugLogger("WEB_FETCH");
  }
  static {
    __name(this, "WebFetchToolInvocation");
  }
  debugLogger;
  getAcceptHeader() {
    const format = this.params.format ?? "auto";
    switch (format) {
      case "markdown":
        return "text/markdown, */*;q=0.1";
      case "html":
        return "text/html, */*;q=0.1";
      case "text":
        return "text/plain, */*;q=0.1";
      case "auto":
      default:
        return "text/markdown, text/html;q=0.9, text/plain;q=0.8, */*;q=0.1";
    }
  }
  getUserAgent() {
    const version = this.config.getCliVersion?.() || "unknown";
    return `QwenCode/${version} ${USER_AGENT_SUFFIX}`;
  }
  fetchPlan;
  /** The URL actually fetched: blob→raw for GitHub, https upgrade for public hosts. */
  getFetchUrl() {
    return this.getFetchPlan().url;
  }
  getFetchPlan() {
    return this.fetchPlan ??= this.computeFetchPlan();
  }
  computeFetchPlan() {
    let url = this.params.url;
    let upgradedFrom;
    if (url.toLowerCase().startsWith("http://") && !isPrivateHost(url)) {
      try {
        const parsed = new URL(url);
        if (parsed.port === "") {
          upgradedFrom = url;
          parsed.protocol = "https:";
          url = parsed.toString();
          this.debugLogger.debug(`[WebFetchTool] Upgraded to https: ${url}`);
        }
      } catch {
      }
    }
    return { url, upgradedFrom };
  }
  buildRedirectResult(redirect) {
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
      returnDisplay: `Redirected to ${redirectHost} (${redirect.status}) \u2014 not followed (different host or scheme/port).`
    };
  }
  buildMetadataHeader(entry) {
    const urlLine = entry.finalUrl !== this.params.url ? `URL: ${this.params.url} (final: ${entry.finalUrl})` : `URL: ${this.params.url}`;
    return `${urlLine}
Status: ${entry.status} ${entry.statusText || "OK"} | Content-Type: ${entry.contentType || "unknown"} | Size: ${entry.byteLength.toLocaleString("en-US")} bytes`;
  }
  async fetchAndProcess(signal) {
    const fetchUrl = this.getFetchUrl();
    const acceptHeader = this.getAcceptHeader();
    const urlCache = getUrlCacheFor(this.config.storage);
    const cacheKey = `${this.config.getSessionId?.() ?? ""}|${acceptHeader} ${fetchUrl}`;
    const cached = urlCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      this.debugLogger.debug(`[WebFetchTool] Cache hit for ${fetchUrl}`);
      return cached;
    }
    this.debugLogger.debug(
      `[WebFetchTool] Fetching ${fetchUrl} (Accept: ${acceptHeader})`
    );
    const policyOptions = {
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
      maxRedirects: MAX_REDIRECTS,
      signal,
      headers: {
        Accept: acceptHeader,
        "User-Agent": this.getUserAgent()
      }
    };
    const networkStart = Date.now();
    let result;
    let usedHttpFallback = false;
    try {
      result = await fetchWithPolicy(fetchUrl, policyOptions);
    } catch (error) {
      const { upgradedFrom } = this.getFetchPlan();
      if (upgradedFrom && isConnectionLevelError(error)) {
        this.debugLogger.debug(
          `[WebFetchTool] https upgrade failed (${error.message}); retrying original ${upgradedFrom}`
        );
        result = await fetchWithPolicy(upgradedFrom, policyOptions);
        usedHttpFallback = true;
      } else {
        throw error;
      }
    }
    const networkMs = Date.now() - networkStart;
    if (result.kind === "cross-host-redirect") {
      return result;
    }
    const response = result;
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Request failed with status code ${response.status} ${response.statusText}`
      );
    }
    const extractStart = Date.now();
    const contentType = response.contentType;
    const sniff = sniffFileKind(
      response.body,
      contentType,
      response.contentDisposition,
      response.finalUrl
    );
    let isBinary = isBinaryContentType(contentType) || sniff.magicMatched || !contentType && sniff.extensionSource === "name" && sniff.extension !== "svg";
    if (isBinary && (contentType.split(";")[0] ?? "").trim().toLowerCase() === "application/octet-stream" && !sniff.magicMatched && sniff.extensionSource === "fallback" && looksLikeText(response.body)) {
      isBinary = false;
    }
    let persistedPath;
    let persistedSize;
    let persistedMime;
    let content;
    if (isBinary) {
      const budgetUsed = this.config.getToolResultBytesWritten();
      if (budgetUsed + response.body.length > MAX_SESSION_BYTES) {
        throw new Error(
          `Fetched ${response.body.length} bytes of binary content (${contentType || "unknown content type"}) but the session's tool-result disk budget is exhausted (${budgetUsed} bytes used of ${MAX_SESSION_BYTES}).`
        );
      }
      this.config.trackToolResultBytes(response.body.length);
      const persistId = `webfetch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const persisted = await persistBinaryContent(
        response.body,
        sniff.extension,
        this.config.storage.getToolResultsDir(),
        persistId
      );
      if ("error" in persisted) {
        this.config.trackToolResultBytes(-response.body.length);
        this.debugLogger.error(
          `[WebFetchTool] Failed to persist binary content: ${persisted.error}`
        );
        throw new Error(
          `Fetched ${response.body.length} bytes of binary content (${contentType || "unknown content type"}) but failed to save it: ${persisted.error}`
        );
      }
      persistedPath = persisted.filepath;
      persistedSize = persisted.size;
      persistedMime = sniff.mimeType || contentType;
      content = "";
      if (sniff.extension === "pdf" && persistedPath) {
        const pdfText = await extractPDFText(persistedPath, { signal });
        if (pdfText.success && pdfText.text.trim()) {
          content = truncateText(pdfText.text);
        } else if (!pdfText.success) {
          this.debugLogger.debug(
            `[WebFetchTool] PDF text extraction failed: ${pdfText.error}`
          );
        }
      }
    } else if (contentType.includes("text/html")) {
      this.debugLogger.debug("[WebFetchTool] Converting HTML to markdown");
      const decoded = response.body.toString("utf-8");
      try {
        const turndown = await getTurndownService();
        content = truncateText(turndown.turndown(decoded));
      } catch (error) {
        this.debugLogger.error(
          `[WebFetchTool] HTML conversion failed, using raw text`,
          error
        );
        content = truncateText(decoded);
      }
    } else {
      content = truncateText(response.body.toString("utf-8"));
    }
    this.debugLogger.debug(
      `[WebFetchTool] network_ms=${networkMs} extract_ms=${Date.now() - extractStart}`
    );
    const entry = {
      fetchedAt: Date.now(),
      status: response.status,
      statusText: response.statusText,
      contentType,
      byteLength: response.body.length,
      finalUrl: response.finalUrl,
      content,
      persistedPath,
      persistedSize,
      persistedMime
    };
    if (!usedHttpFallback && content.length <= MAX_CACHEABLE_CHARS) {
      urlCache.set(cacheKey, entry);
    }
    return entry;
  }
  async executeDirectFetch(signal) {
    const startMs = Date.now();
    const elapsedSuffix = /* @__PURE__ */ __name(() => ` in ${((Date.now() - startMs) / 1e3).toFixed(1)}s`, "elapsedSuffix");
    try {
      const entry = await this.fetchAndProcess(signal);
      if ("kind" in entry) {
        const redirect = this.buildRedirectResult(entry);
        return {
          ...redirect,
          returnDisplay: `${redirect.returnDisplay}${elapsedSuffix()}`
        };
      }
      const header = this.buildMetadataHeader(entry);
      const binaryNote = entry.persistedPath ? `

[Binary content (${entry.persistedMime || entry.contentType || "unknown"}, ${formatByteSize(entry.persistedSize ?? entry.byteLength)}) saved to ${entry.persistedPath}.${readHintForPath(entry.persistedPath)}]` : "";
      const displaySummary = `Received ${formatByteSize(entry.byteLength)} (${entry.status} ${entry.statusText || "OK"}) from ${hostnameOf(this.params.url)}${entry.persistedPath ? ` \u2014 binary saved to ${entry.persistedPath}` : ""}`;
      if (entry.persistedPath && !entry.content) {
        return {
          llmContent: `${header}

[No text could be extracted from this binary content.]${binaryNote}`,
          returnDisplay: `${displaySummary}${elapsedSuffix()}`,
          resultFilePaths: [entry.persistedPath]
        };
      }
      const preapproved = isPreapprovedUrl(entry.finalUrl);
      if (preapproved && entry.contentType.includes("text/markdown") && entry.content.length <= MAX_CONTENT_CHARS) {
        return {
          llmContent: `${header}

${entry.content}${binaryNote}`,
          returnDisplay: `${displaySummary}${elapsedSuffix()}`,
          ...entry.persistedPath ? { resultFilePaths: [entry.persistedPath] } : {}
        };
      }
      const fallbackPrompt = `The user requested the following: "${this.params.prompt}".

I have fetched the content from ${this.params.url}. Fetch metadata:
${header}

Please use the following content to answer the user's request.

---
${entry.content}
---`;
      const sideQueryStart = Date.now();
      let resultText;
      try {
        const result = await runSideQuery(this.config, {
          purpose: "web-fetch",
          // Best-effort: a failure falls back to raw content below; retrying
          // 7× just delays that fallback.
          maxAttempts: 1,
          contents: [{ role: "user", parts: [{ text: fallbackPrompt }] }],
          systemInstruction: "Extract and summarize the requested information from the provided web content. Be concise and accurate. Respond only with the requested information.",
          // Stream so the provider SDK's whole-request timeout only bounds
          // connect + first chunk: an exhaustive extraction can legitimately
          // generate for >120s, and a non-streaming call dies at that SDK
          // deadline and is then re-fired by SDK-internal retries (which
          // maxAttempts does not govern).
          stream: true,
          abortSignal: AbortSignal.any([
            signal,
            AbortSignal.timeout(sideQueryTimeoutMs())
          ])
        });
        signal.throwIfAborted();
        resultText = (result.text || "").trim();
        this.debugLogger.debug(
          `[WebFetchTool] side_query_ms=${Date.now() - sideQueryStart}`
        );
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        this.debugLogger.error(
          `[WebFetchTool] side_query_ms=${Date.now() - sideQueryStart} (failed); returning raw content`,
          error
        );
        return {
          llmContent: `${header}

[Content processing failed (${getErrorMessage(error)}). The raw fetched content follows.]

${entry.content}${binaryNote}`,
          returnDisplay: `${displaySummary}${elapsedSuffix()} \u2014 processing failed, raw content returned`,
          ...entry.persistedPath ? { resultFilePaths: [entry.persistedPath] } : {}
        };
      }
      if (!resultText) {
        resultText = "[The processing model returned no content. The fetch itself succeeded \u2014 see the metadata above.]";
      }
      return {
        llmContent: `${header}

${resultText}${binaryNote}`,
        returnDisplay: `${displaySummary}${elapsedSuffix()}`,
        ...entry.persistedPath ? { resultFilePaths: [entry.persistedPath] } : {}
      };
    } catch (e) {
      const errorMessage = `Error during fetch for ${this.params.url}: ${getErrorMessage(e)}`;
      this.debugLogger.error(`[WebFetchTool] ${errorMessage}`, e);
      return {
        llmContent: `Error: ${errorMessage}`,
        returnDisplay: `Error: ${errorMessage}${elapsedSuffix()}`,
        error: {
          message: errorMessage,
          type: "web_fetch_fallback_failed" /* WEB_FETCH_FALLBACK_FAILED */
        }
      };
    }
  }
  getDescription() {
    const displayPrompt = this.params.prompt.length > 100 ? this.params.prompt.substring(0, 97) + "..." : this.params.prompt;
    const format = this.params.format ?? "auto";
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
  async getDefaultPermission() {
    return "ask";
  }
  /**
   * Constructs the web fetch confirmation details.
   */
  async getConfirmationDetails(_abortSignal) {
    const permissionRules = [`WebFetch(${hostnameOf(this.params.url)})`];
    const confirmationDetails = {
      type: "info",
      title: `Confirm Web Fetch`,
      prompt: `Fetch content from ${this.params.url} and process with: ${this.params.prompt}`,
      urls: [this.params.url],
      permissionRules,
      onConfirm: /* @__PURE__ */ __name(async (_outcome, _payload) => {
      }, "onConfirm")
    };
    return confirmationDetails;
  }
  async execute(signal) {
    return this.executeDirectFetch(signal);
  }
};
var WebFetchTool = class _WebFetchTool extends BaseDeclarativeTool {
  constructor(config) {
    super(
      _WebFetchTool.Name,
      ToolDisplayNames.WEB_FETCH,
      `Fetches content from a specified URL and processes it using an AI model
- Takes a URL and a prompt as input
- Supports content negotiation for markdown (reduces tokens by ~80%)
- Fetches the URL content and converts HTML to markdown (links preserved)
- Processes the content with the prompt using an AI model
- Returns the model's response about the content, prefixed with fetch metadata (HTTP status, content type, size)
- Use this tool when you need to retrieve and analyze web content

Usage notes:
  - IMPORTANT: This tool cannot access authenticated or private URLs (e.g. Google Docs, Confluence, Jira, private GitHub). If an MCP-provided web fetch tool is available, prefer using that tool instead of this one, as it may have fewer restrictions. All MCP-provided tools start with "mcp__".
  - The URL must be a fully-formed valid URL
  - Plain-http URLs to public hosts are upgraded to https automatically; localhost/private hosts are fetched as-is
  - When a URL redirects to a different host, the redirect is NOT followed; the tool returns the redirect URL so you can re-issue web_fetch with it
  - Binary content (PDFs, images, archives) is saved to a local file; the result includes the file path \u2014 use read_file on it (it reads PDFs and images natively)
  - Repeated fetches of the same URL within 15 minutes are served from a local cache
  - The prompt should describe what information you want to extract from the page
  - format parameter (optional): controls only the Accept header sent to the server. All content is normalized to plain text for LLM processing, regardless of format.
  - "auto" (default): Prefers markdown via content negotiation, accepts HTML, text, or other content as fallback. Use when user does NOT specify a format.
  - "markdown": Prefers text/markdown. Use when user explicitly asks for markdown content.
  - "html": Prefers text/html. Content is still converted to markdown for LLM processing.
  - "text": Prefers text/plain. Use when user explicitly asks for plain text.
  - This tool does not modify any files (other than saving fetched binary content)
  - Results may be summarized if the content is very large
  - Supports both public and private/localhost URLs using direct fetch`,
      "fetch" /* Fetch */,
      {
        properties: {
          url: {
            description: "The URL to fetch content from",
            type: "string"
          },
          prompt: {
            description: "The prompt to run on the fetched content",
            type: "string"
          },
          format: {
            description: "Preferred content format (Accept header only): auto (default, prefers markdown), markdown, html, or text. All content is normalized to plain text.",
            type: "string",
            enum: ["auto", "markdown", "html", "text"]
          }
        },
        required: ["url", "prompt"],
        type: "object"
      },
      true,
      // isOutputMarkdown
      false,
      // canUpdateOutput
      true,
      // shouldDefer — web fetching is infrequent
      false,
      // alwaysLoad
      "web fetch url http download content"
    );
    this.config = config;
  }
  static {
    __name(this, "WebFetchTool");
  }
  static Name = ToolNames.WEB_FETCH;
  validateToolParamValues(params) {
    if (!params.url || params.url.trim() === "") {
      return "The 'url' parameter cannot be empty.";
    }
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
    if (!params.prompt || params.prompt.trim() === "") {
      return "The 'prompt' parameter cannot be empty.";
    }
    return null;
  }
  createInvocation(params) {
    return new WebFetchToolInvocation(this.config, {
      ...params,
      url: rewriteGitHubBlobUrl(params.url)
    });
  }
  toAutoClassifierInput(params) {
    return { url: params.url };
  }
};
export {
  WebFetchTool,
  clearWebFetchCache,
  rewriteGitHubBlobUrl,
  sideQueryTimeoutMs
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
