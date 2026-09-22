// Force strict mode and setup for ESM
"use strict";
import {
  MAX_ARTIFACT_BYTES,
  PUBLISHED_CONTENT_SHA256_METADATA_KEY,
  byteLength,
  deleteArtifactSnapshot,
  sanitizeArtifactTitle,
  saveArtifactSnapshot,
  validateSelfContained,
  wrapArtifactHtml
} from "./chunk-ANKISCKU.js";
import {
  openBrowserSecurely
} from "./chunk-NAVJD2PQ.js";
import {
  BaseDeclarativeTool,
  BaseToolInvocation
} from "./chunk-VPGRGNNH.js";
import {
  ToolDisplayNames,
  ToolNames
} from "./chunk-ERIBG3BX.js";
import {
  Storage,
  createDebugLogger,
  makeRelative,
  shortenPath,
  unescapePath
} from "./chunk-ZYDMQCQP.js";
import {
  getErrorMessage,
  isAbortError,
  isNodeError
} from "./chunk-S34QJ6IR.js";
import "./chunk-TBWQLLFO.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/artifact/artifact-tool.ts
init_esbuild_shims();
import { createHash as createHash3 } from "node:crypto";
import path4 from "node:path";

// packages/core/src/tools/artifact/publisher.ts
init_esbuild_shims();
import { createHash } from "node:crypto";
import path from "node:path";
function artifactIdFromPath(filePath) {
  const normalized = path.resolve(filePath);
  return createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}
__name(artifactIdFromPath, "artifactIdFromPath");

// packages/core/src/tools/artifact/create-publisher.ts
init_esbuild_shims();

// packages/core/src/tools/artifact/local-publisher.ts
init_esbuild_shims();
import { promises as fs } from "node:fs";
import path2 from "node:path";
import { pathToFileURL } from "node:url";
var LocalPublisher = class {
  /** @param baseDir Override the output root (defaults to ~/.qwen/artifacts). */
  constructor(baseDir) {
    this.baseDir = baseDir;
  }
  static {
    __name(this, "LocalPublisher");
  }
  kind = "local";
  getBaseDir() {
    return this.baseDir ?? path2.join(Storage.getGlobalQwenDir(), "artifacts");
  }
  async publish(input) {
    const dir = path2.join(this.getBaseDir(), input.id);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path2.join(dir, "index.html");
    await fs.writeFile(filePath, input.html, "utf8");
    return {
      id: input.id,
      url: pathToFileURL(filePath).href,
      filePath
    };
  }
};

// packages/core/src/tools/artifact/host-publisher.ts
init_esbuild_shims();
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs2 } from "node:fs";
import os from "node:os";
import path3 from "node:path";
var execFileAsync = promisify(execFile);
var defaultRunCommand = /* @__PURE__ */ __name(async (command, args, signal) => {
  await execFileAsync(command, args, { signal, maxBuffer: 10 * 1024 * 1024 });
}, "defaultRunCommand");
function tokenizeCommand(command) {
  const tokens = [];
  let current = "";
  let started = false;
  let quote;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = void 0;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote) throw new Error("Unterminated quote in uploadCommand.");
  if (started) tokens.push(current);
  return tokens;
}
__name(tokenizeCommand, "tokenizeCommand");
function substitute(token, file, key) {
  return token.split("{file}").join(file).split("{key}").join(key);
}
__name(substitute, "substitute");
function substituteKey(token, key) {
  return token.split("{key}").join(key);
}
__name(substituteKey, "substituteKey");
function normalizeKeyPrefix(raw) {
  const prefix = (raw || "artifacts").replace(/^\/+|\/+$/g, "");
  if (!prefix) {
    throw new Error(
      'artifact.host.keyPrefix must not be empty or "/" after stripping slashes.'
    );
  }
  if (/[#?%\s]/.test(prefix)) {
    throw new Error(
      "artifact.host.keyPrefix must not contain #, ?, %, or whitespace."
    );
  }
  return prefix;
}
__name(normalizeKeyPrefix, "normalizeKeyPrefix");
var HostPublisher = class {
  constructor(config, run = defaultRunCommand) {
    this.config = config;
    this.run = run;
  }
  static {
    __name(this, "HostPublisher");
  }
  kind = "host";
  async publish(input, signal) {
    const uploadCommand = this.config.uploadCommand?.trim();
    const urlTemplate = this.config.urlTemplate?.trim();
    if (!uploadCommand) {
      throw new Error(
        'artifact.host.uploadCommand is not configured (set it to e.g. "aws s3 cp {file} s3://bucket/{key}").'
      );
    }
    if (!urlTemplate) {
      throw new Error(
        'artifact.host.urlTemplate is not configured (set it to e.g. "https://bucket.example.com/{key}").'
      );
    }
    if (!uploadCommand.includes("{file}")) {
      throw new Error(
        "artifact.host.uploadCommand must include the {file} placeholder (the local HTML path to upload)."
      );
    }
    if (!uploadCommand.includes("{key}")) {
      throw new Error(
        "artifact.host.uploadCommand must include the {key} placeholder so the upload destination matches the returned URL."
      );
    }
    if (!urlTemplate.includes("{key}")) {
      throw new Error(
        "artifact.host.urlTemplate must include the {key} placeholder (the remote object key)."
      );
    }
    if (urlTemplate.includes("{file}")) {
      throw new Error(
        "artifact.host.urlTemplate must not include {file}; only {key} is supported."
      );
    }
    const prefix = normalizeKeyPrefix(this.config.keyPrefix);
    const key = `${prefix}/${input.id}/index.html`;
    const dir = await fs2.mkdtemp(path3.join(os.tmpdir(), "qwen-art-"));
    const file = path3.join(dir, "index.html");
    await fs2.writeFile(file, input.html, "utf8");
    try {
      const argv = tokenizeCommand(uploadCommand).map(
        (t) => substitute(t, file, key)
      );
      const [command, ...args] = argv;
      if (!command) {
        throw new Error("artifact.host.uploadCommand is empty.");
      }
      await this.run(command, args, signal);
    } finally {
      await fs2.rm(dir, { recursive: true, force: true });
    }
    return { id: input.id, url: substituteKey(urlTemplate, key) };
  }
};

// packages/core/src/tools/artifact/oss-publisher.ts
init_esbuild_shims();
import { createHash as createHash2, createHmac } from "node:crypto";
var defaultHttpPut = /* @__PURE__ */ __name(async (url, headers, body, signal) => {
  const timeout = AbortSignal.timeout(6e4);
  const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let res;
  try {
    res = await fetch(url, {
      method: "PUT",
      headers,
      body,
      signal: combinedSignal
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`OSS upload to ${url} failed: ${message}`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {
    });
    throw new Error(`OSS upload failed: ${res.status} ${res.statusText}`);
  }
  await res.body?.cancel().catch(() => {
  });
}, "defaultHttpPut");
function ossCredentialsFromEnv(env = process.env) {
  const accessKeyId = env["OSS_ACCESS_KEY_ID"] || env["ALIBABA_CLOUD_ACCESS_KEY_ID"];
  const accessKeySecret = env["OSS_ACCESS_KEY_SECRET"] || env["ALIBABA_CLOUD_ACCESS_KEY_SECRET"];
  if (!accessKeyId || !accessKeySecret) return void 0;
  const securityToken = env["OSS_SESSION_TOKEN"] || env["ALIBABA_CLOUD_SECURITY_TOKEN"] || void 0;
  return { accessKeyId, accessKeySecret, securityToken };
}
__name(ossCredentialsFromEnv, "ossCredentialsFromEnv");
function signOssPut(params) {
  const ossHeaders = {};
  if (params.acl) ossHeaders["x-oss-object-acl"] = params.acl;
  if (params.credentials.securityToken) {
    ossHeaders["x-oss-security-token"] = params.credentials.securityToken;
  }
  const canonicalizedHeaders = Object.keys(ossHeaders).sort().map((k) => `${k}:${ossHeaders[k]}
`).join("");
  const canonicalizedResource = `/${params.bucket}/${params.key}`;
  const stringToSign = `PUT
${params.contentMd5}
${params.contentType}
${params.date}
${canonicalizedHeaders}${canonicalizedResource}`;
  const signature = createHmac("sha1", params.credentials.accessKeySecret).update(stringToSign, "utf8").digest("base64");
  return {
    authorization: `OSS ${params.credentials.accessKeyId}:${signature}`,
    ossHeaders
  };
}
__name(signOssPut, "signOssPut");
var CONTENT_TYPE = "text/html";
function normalizeEndpoint(raw) {
  const endpoint = raw.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!/^[a-z0-9.-]+\.aliyuncs\.com$/i.test(endpoint)) {
    throw new Error(
      `artifact.oss.endpoint does not look like a valid Aliyun OSS endpoint: ${endpoint}`
    );
  }
  return endpoint;
}
__name(normalizeEndpoint, "normalizeEndpoint");
function normalizeKeyPrefix2(raw) {
  const prefix = (raw || "artifacts").replace(/^\/+|\/+$/g, "");
  if (!prefix) {
    throw new Error(
      'artifact.oss.keyPrefix must not be empty or "/" after stripping slashes.'
    );
  }
  if (/[#?%\s]/.test(prefix)) {
    throw new Error(
      "artifact.oss.keyPrefix must not contain #, ?, %, or whitespace."
    );
  }
  return prefix;
}
__name(normalizeKeyPrefix2, "normalizeKeyPrefix");
function normalizePublicBaseUrl(raw) {
  const base = raw?.trim().replace(/\/+$/, "");
  if (!base) return void 0;
  if (!/^https?:\/\//i.test(base)) {
    throw new Error(
      "artifact.oss.publicBaseUrl must start with http:// or https://."
    );
  }
  return base;
}
__name(normalizePublicBaseUrl, "normalizePublicBaseUrl");
var OssPublisher = class {
  constructor(config, deps = {}) {
    this.config = config;
    this.deps = deps;
  }
  static {
    __name(this, "OssPublisher");
  }
  kind = "oss";
  async publish(input, signal) {
    const bucket = this.config.bucket?.trim();
    const rawEndpoint = this.config.endpoint?.trim();
    if (!bucket) {
      throw new Error("artifact.oss.bucket is not configured.");
    }
    if (!rawEndpoint) {
      throw new Error(
        'artifact.oss.endpoint is not configured (e.g. "oss-cn-hangzhou.aliyuncs.com").'
      );
    }
    const endpoint = normalizeEndpoint(rawEndpoint);
    const credentials = (this.deps.credentials ?? ossCredentialsFromEnv)();
    if (!credentials) {
      throw new Error(
        "OSS credentials not found. Set OSS_ACCESS_KEY_ID and OSS_ACCESS_KEY_SECRET (or ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET)."
      );
    }
    const prefix = normalizeKeyPrefix2(this.config.keyPrefix);
    const key = `${prefix}/${input.id}/index.html`;
    const base = normalizePublicBaseUrl(this.config.publicBaseUrl);
    const acl = this.config.acl ?? "public-read";
    const date = (this.deps.now ? this.deps.now() : /* @__PURE__ */ new Date()).toUTCString();
    const contentMd5 = createHash2("md5").update(input.html, "utf8").digest("base64");
    const { authorization, ossHeaders } = signOssPut({
      credentials,
      bucket,
      key,
      contentMd5,
      contentType: CONTENT_TYPE,
      date,
      acl
    });
    const putUrl = `https://${bucket}.${endpoint}/${key}`;
    const httpPut = this.deps.httpPut ?? defaultHttpPut;
    await httpPut(
      putUrl,
      {
        Date: date,
        "Content-MD5": contentMd5,
        "Content-Type": CONTENT_TYPE,
        Authorization: authorization,
        ...ossHeaders
      },
      input.html,
      signal
    );
    const url = base ? `${base}/${key}` : putUrl;
    return { id: input.id, url };
  }
};

// packages/core/src/tools/artifact/create-publisher.ts
function createArtifactPublisher(config) {
  const kind = config.getArtifactPublisherKind();
  switch (kind) {
    case "host":
      return new HostPublisher(
        config.getArtifactHostConfig() ?? {
          uploadCommand: "",
          urlTemplate: ""
        }
      );
    case "oss":
      return new OssPublisher(
        config.getArtifactOssConfig() ?? { bucket: "", endpoint: "" }
      );
    case "local":
      return new LocalPublisher();
    default: {
      const unknown = kind;
      throw new Error(`Unknown artifact publisher kind: ${unknown}`);
    }
  }
}
__name(createArtifactPublisher, "createArtifactPublisher");

// packages/core/src/tools/artifact/artifact-tool.ts
var DESCRIPTION = `Publishes a self-contained HTML page as an interactive Artifact, optionally opens it in the browser depending on settings, and returns a shareable link when a remote host is configured. Use it to turn session output into a durable, interactive page \u2014 a PR walkthrough, an architecture tour, a project dashboard.

Workflow:
- Write the page to a file first (via Write/Edit), then call Artifact with that file's absolute path.
- Write a BODY-ONLY fragment: no <!doctype>, <html>, <head>, or <body> tags \u2014 they are added at publish time, along with a minimal CSS reset.
- Self-contained only: inline all CSS and JS; embed images/fonts as data: URIs. No external scripts, stylesheets, fonts, or remote images.
- Responsive: relative units, flex/grid, max-width:100% on media; wide content (tables, diagrams, code) scrolls inside its own overflow-x:auto container.
- Set a concise \`title\` \u2014 it names the browser tab.

To update an artifact, call Artifact again with the SAME file path: it redeploys to the same URL. In Web Shell, each publication also saves a separate local HTML version for the conversation's historical preview. Use Artifact to deliver a saved webpage version; recording a live development URL alone cannot preserve its content. A different path creates a separate Artifact.

Set artifact.autoOpen=false in settings.json, or QWEN_ARTIFACT_NO_AUTO_OPEN=1, to publish without launching a browser.`;
var debugLogger = createDebugLogger("artifact");
function cancelledArtifactResult() {
  const message = "Artifact publishing was cancelled.";
  return {
    llmContent: message,
    returnDisplay: message
  };
}
__name(cancelledArtifactResult, "cancelledArtifactResult");
var ArtifactToolInvocation = class extends BaseToolInvocation {
  constructor(config, publisher, openUrl, params) {
    super(params);
    this.config = config;
    this.publisher = publisher;
    this.openUrl = openUrl;
    this.shouldAutoOpen = config.shouldAutoOpenArtifact();
  }
  static {
    __name(this, "ArtifactToolInvocation");
  }
  shouldAutoOpen;
  getDescription() {
    const relativePath = makeRelative(
      this.params.file_path,
      this.config.getTargetDir()
    );
    return `Publishing artifact from ${shortenPath(relativePath)}`;
  }
  /** Publishing writes outside the project and may open a browser — always ask. */
  getDefaultPermission() {
    return Promise.resolve("ask");
  }
  getConfirmationDetails(_abortSignal) {
    const relativePath = makeRelative(
      this.params.file_path,
      this.config.getTargetDir()
    );
    const backendLabel = this.publisher.kind === "host" ? "custom upload" : this.publisher.kind;
    const openSuffix = this.shouldAutoOpen ? " and open it in your browser" : "";
    const remoteOpenSuffix = this.shouldAutoOpen ? " and opens the shareable link in your browser" : "";
    const prompt = this.publisher.kind === "local" ? `Publish ${shortenPath(relativePath)} as an interactive Artifact${openSuffix}.` : `Publish ${shortenPath(relativePath)} as an interactive Artifact. This uploads the page to a remote host (${backendLabel})${remoteOpenSuffix}.`;
    const details = {
      type: "info",
      title: "Publish Artifact",
      prompt,
      onConfirm: /* @__PURE__ */ __name(async () => {
      }, "onConfirm")
    };
    return Promise.resolve(details);
  }
  async execute(signal) {
    const { file_path } = this.params;
    let fragment;
    try {
      const { content, _meta } = await this.config.getFileSystemService().readTextFile({
        path: file_path,
        maxOutputBytes: MAX_ARTIFACT_BYTES,
        signal
      });
      if (_meta?.truncatedByBytes === true) {
        const message = `Artifact is too large (source exceeds the ${MAX_ARTIFACT_BYTES} byte limit). Trim the content or split it across multiple artifacts.`;
        return {
          llmContent: message,
          returnDisplay: message,
          error: { message, type: "file_too_large" /* FILE_TOO_LARGE */ }
        };
      }
      fragment = content;
    } catch (err) {
      if (signal.aborted || isAbortError(err)) {
        return cancelledArtifactResult();
      }
      const notFound = isNodeError(err) && err.code === "ENOENT";
      const message = notFound ? `Artifact source file not found: ${file_path}. Write the page content to this file first.` : `Error reading artifact source file '${file_path}': ${getErrorMessage(err)}`;
      return {
        llmContent: message,
        returnDisplay: message,
        error: {
          message,
          type: notFound ? "file_not_found" /* FILE_NOT_FOUND */ : "read_content_failure" /* READ_CONTENT_FAILURE */
        }
      };
    }
    const contentError = validateSelfContained(fragment);
    if (contentError) {
      return {
        llmContent: contentError,
        returnDisplay: contentError,
        error: { message: contentError, type: "execution_failed" /* EXECUTION_FAILED */ }
      };
    }
    const title = sanitizeArtifactTitle(
      this.params.title ?? path4.basename(file_path).replace(/\.html?$/i, "")
    );
    const html = wrapArtifactHtml(fragment, title);
    const bytes = byteLength(html);
    if (bytes > MAX_ARTIFACT_BYTES) {
      const message = `Artifact is too large (${bytes} bytes > ${MAX_ARTIFACT_BYTES} byte limit). Trim the content or split it across multiple artifacts.`;
      return {
        llmContent: message,
        returnDisplay: message,
        error: { message, type: "file_too_large" /* FILE_TOO_LARGE */ }
      };
    }
    let managedId;
    let url;
    let filePath;
    try {
      const published = await this.publisher.publish(
        { id: artifactIdFromPath(file_path), title, html },
        signal
      );
      managedId = published.id;
      url = published.url;
      filePath = published.filePath;
    } catch (err) {
      if (signal.aborted || isAbortError(err)) {
        return cancelledArtifactResult();
      }
      const message = `Failed to publish artifact: ${getErrorMessage(err)}`;
      return {
        llmContent: message,
        returnDisplay: message,
        error: { message, type: "execution_failed" /* EXECUTION_FAILED */ }
      };
    }
    if (this.shouldAutoOpen) {
      try {
        await this.openUrl(url, {
          allowFile: true,
          allowedFilePaths: filePath ? [filePath] : []
        });
      } catch (err) {
        debugLogger.warn(
          `Failed to open browser for artifact "${title}": ${getErrorMessage(err)}`
        );
      }
    }
    const artifacts = [
      {
        kind: "html",
        storage: "published",
        title,
        url,
        managedId,
        mimeType: "text/html",
        sizeBytes: bytes,
        metadata: {
          [PUBLISHED_CONTENT_SHA256_METADATA_KEY]: createHash3("sha256").update(html).digest("hex")
        }
      }
    ];
    const saveVersion = this.config.isArtifactSnapshotsEnabled();
    if (saveVersion) {
      try {
        const sessionId = this.config.getSessionId();
        const runtimeBaseDir = this.config.storage.getRuntimeBaseDir();
        const snapshot = await saveArtifactSnapshot(
          html,
          title,
          url,
          sessionId,
          runtimeBaseDir
        );
        if (signal.aborted) {
          await deleteArtifactSnapshot(snapshot, runtimeBaseDir, sessionId);
          const message = `Published artifact "${title}" to ${url}, but its historical version was discarded because the request was cancelled.`;
          return {
            llmContent: message,
            returnDisplay: message,
            resultFilePaths: filePath ? [filePath] : void 0
          };
        }
        artifacts.push(snapshot);
      } catch (err) {
        const message = `Published artifact "${title}" to ${url}, but its historical version could not be saved: ${getErrorMessage(err)}`;
        return {
          llmContent: message,
          returnDisplay: message,
          artifacts,
          resultFilePaths: filePath ? [filePath] : void 0
        };
      }
    }
    const llmContent = `Published artifact "${title}" to ${url}${saveVersion ? " and saved a separate local HTML version for this turn" : ""}. Share or open this URL to view the latest interactive page. Re-run Artifact with the same file path to update it${saveVersion ? "; earlier saved versions remain unchanged" : ""}.`;
    return {
      llmContent,
      returnDisplay: `Published artifact **${title}**

${url}`,
      resultFilePaths: filePath ? [filePath] : void 0,
      artifacts
    };
  }
};
var ArtifactTool = class _ArtifactTool extends BaseDeclarativeTool {
  constructor(config, publisher, openUrl = openBrowserSecurely) {
    super(
      _ArtifactTool.Name,
      ToolDisplayNames.ARTIFACT,
      DESCRIPTION,
      "other" /* Other */,
      {
        type: "object",
        properties: {
          file_path: {
            type: "string",
            description: "Absolute path to the body-only HTML fragment file to publish."
          },
          title: {
            type: "string",
            description: "Concise title for the artifact (names the browser tab and listing)."
          }
        },
        required: ["file_path"]
      }
    );
    this.config = config;
    this.openUrl = openUrl;
    this.publisher = publisher ?? createArtifactPublisher(config);
  }
  static {
    __name(this, "ArtifactTool");
  }
  static Name = ToolNames.ARTIFACT;
  publisher;
  validateToolParamValues(params) {
    const filePath = unescapePath((params.file_path ?? "").trim());
    params.file_path = filePath;
    if (!filePath) {
      return 'Missing or empty "file_path"';
    }
    if (!path4.isAbsolute(filePath)) {
      return `File path must be absolute: ${filePath}`;
    }
    return null;
  }
  toAutoClassifierInput(params) {
    return { file_path: params.file_path, title: params.title };
  }
  createInvocation(params) {
    return new ArtifactToolInvocation(
      this.config,
      this.publisher,
      this.openUrl,
      params
    );
  }
};
export {
  ArtifactTool
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
