// Force strict mode and setup for ESM
"use strict";
import {
  isDocumentNavigation,
  require_express
} from "./chunk-PXBV45LZ.js";
import {
  WEB_SHELL_PWA_ASSETS
} from "./chunk-RO7OJQS2.js";
import {
  writeStderrLine
} from "./chunk-7FA2II6K.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/web-shell-static.ts
init_esbuild_shims();
var import_express = __toESM(require_express(), 1);
import * as path from "node:path";

// packages/cli/src/serve/debug-mode.ts
init_esbuild_shims();
function isServeDebugMode() {
  const value = process.env["QWEN_SERVE_DEBUG"];
  if (!value) return false;
  return !["0", "false", "off", "no"].includes(value.trim().toLowerCase());
}
__name(isServeDebugMode, "isServeDebugMode");

// packages/cli/src/serve/web-shell-static.ts
var WEB_SHELL_CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "media-src 'self' data:",
  "worker-src 'self' blob:",
  // base-uri does NOT fall back to default-src; lock it so an injected <base>
  // (the SPA renders AI-generated markdown) cannot repoint relative URLs to an
  // attacker origin.
  "base-uri 'none'"
];
function buildWebShellPermissionsPolicy() {
  return [
    "camera=()",
    "microphone=(self)",
    "geolocation=()",
    "payment=()",
    "clipboard-write=(self)"
  ].join(", ");
}
__name(buildWebShellPermissionsPolicy, "buildWebShellPermissionsPolicy");
function buildWebShellCsp(frameAncestors = [], connectOrigins = []) {
  const fa = frameAncestors.length ? `frame-ancestors ${frameAncestors.join(" ")}` : "frame-ancestors 'none'";
  const frameSrc = "frame-src http: https: blob:";
  const connectSrc = `connect-src 'self' ${connectOrigins.join(" ")}`.trim();
  return [...WEB_SHELL_CSP_DIRECTIVES, connectSrc, frameSrc, fa].join("; ");
}
__name(buildWebShellCsp, "buildWebShellCsp");
function requestedDaemonParam(originalUrl) {
  const queryStart = originalUrl.indexOf("?");
  return new URLSearchParams(
    queryStart === -1 ? "" : originalUrl.slice(queryStart + 1)
  ).get("daemon");
}
__name(requestedDaemonParam, "requestedDaemonParam");
function remoteDaemonConnectOrigins(value) {
  if (!value) return [];
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !/^[a-z0-9._\-[\]:]+$/iu.test(url.hostname)) {
      return [];
    }
    if (url.hostname.startsWith("[")) return [];
    const websocket = new URL(url.origin);
    websocket.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return [url.origin, websocket.origin];
  } catch {
    return [];
  }
}
__name(remoteDaemonConnectOrigins, "remoteDaemonConnectOrigins");
var WEB_SHELL_CSP = buildWebShellCsp();
function createSendIndex(webShellDir, frameAncestors = []) {
  const indexPath = path.join(webShellDir, "index.html");
  return (req, res) => {
    const csp = buildWebShellCsp(
      frameAncestors,
      remoteDaemonConnectOrigins(requestedDaemonParam(req.originalUrl))
    );
    res.status(200).set("Content-Security-Policy", csp).set("X-Content-Type-Options", "nosniff").set("Referrer-Policy", "no-referrer").set(
      // `microphone=(self)` lets the same-origin Web Shell document request
      // the mic for voice dictation (the prompt won't even appear under an
      // empty `microphone=()` allowlist). Camera/geolocation stay disabled:
      // the MCP App inner iframe is opaque-origin, so those grants cannot
      // work there, and this header also blocks delegating them to the
      // cross-origin sandbox.
      "Permissions-Policy",
      buildWebShellPermissionsPolicy()
    ).set("Cache-Control", "no-cache");
    if (frameAncestors.length === 0) {
      res.set("X-Frame-Options", "DENY");
    }
    res.sendFile(
      indexPath,
      { cacheControl: false, dotfiles: "allow" },
      (err) => {
        if (!err) return;
        writeStderrLine(
          `qwen serve: Web Shell index send failed: ${err instanceof Error ? err.message : String(err)}`
        );
        if (!res.headersSent) {
          res.status(500).type("text/plain").send("Failed to load Web Shell");
        } else {
          res.end();
        }
      }
    );
  };
}
__name(createSendIndex, "createSendIndex");
function mountWebShellAssets(app, webShellDir, frameAncestors = []) {
  const sendIndex = createSendIndex(webShellDir, frameAncestors);
  app.use(
    "/assets",
    import_express.default.static(path.join(webShellDir, "assets"), {
      index: false,
      maxAge: 0,
      setHeaders(res, filePath) {
        const fileName = path.basename(filePath);
        const contentAddressed = /-[a-zA-Z0-9_-]{8,}\.[^.]+$/u.test(fileName);
        res.setHeader(
          "Cache-Control",
          contentAddressed ? "public, max-age=31536000, immutable" : "no-cache"
        );
      }
    })
  );
  app.use("/assets", (req, res) => {
    if (isServeDebugMode()) {
      writeStderrLine(
        `qwen serve: Web Shell asset not found: ${req.originalUrl}`
      );
    }
    res.status(404).type("text/plain").send("Not found");
  });
  app.get("/", (req, res) => sendIndex(req, res));
  app.get("/session/:id", (req, res, next) => {
    if (!isDocumentNavigation(req)) return next();
    sendIndex(req, res);
  });
  for (const {
    route,
    contentType,
    serviceWorkerAllowed
  } of WEB_SHELL_PWA_ASSETS) {
    app.get(route, (_req, res) => {
      res.set("Content-Type", contentType).set("Cache-Control", "no-cache").set("X-Content-Type-Options", "nosniff");
      if (serviceWorkerAllowed) res.set("Service-Worker-Allowed", "/");
      res.sendFile(
        path.join(webShellDir, route.slice(1)),
        { cacheControl: false, dotfiles: "allow" },
        (err) => {
          if (!err) return;
          if (res.headersSent) {
            res.end();
            return;
          }
          const status = "status" in err && err.status === 404 ? 404 : 500;
          if (status === 500) {
            writeStderrLine(
              `qwen serve: Web Shell asset send failed (${route}): ${err instanceof Error ? err.message : String(err)}`
            );
          }
          res.status(status).type("text/plain").send(
            status === 404 ? "Not found" : "Failed to load Web Shell asset"
          );
        }
      );
    });
  }
}
__name(mountWebShellAssets, "mountWebShellAssets");
function mountWebShellSpaFallback(app, webShellDir, frameAncestors = []) {
  const sendIndex = createSendIndex(webShellDir, frameAncestors);
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (!isDocumentNavigation(req)) return next();
    if (isServeDebugMode()) {
      writeStderrLine(
        `qwen serve: Web Shell SPA fallback served for ${req.method} ${req.originalUrl}`
      );
    }
    sendIndex(req, res);
  });
}
__name(mountWebShellSpaFallback, "mountWebShellSpaFallback");

export {
  isServeDebugMode,
  buildWebShellPermissionsPolicy,
  buildWebShellCsp,
  requestedDaemonParam,
  remoteDaemonConnectOrigins,
  WEB_SHELL_CSP,
  mountWebShellAssets,
  mountWebShellSpaFallback
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
