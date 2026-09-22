// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/tools/mcp-resource-content.ts
init_esbuild_shims();
import { randomUUID } from "node:crypto";
var MAX_MCP_RESOURCE_TEXT_CHARS = 1e5;
var MAX_MCP_RESOURCE_BLOB_CHARS = 8e6;
function formatMcpResourceContents(result, label, opts) {
  const maxBlobChars = opts?.maxBlobChars ?? MAX_MCP_RESOURCE_BLOB_CHARS;
  const contentParts = [];
  let textChars = 0;
  let blobChars = 0;
  let blobCount = 0;
  let truncated = false;
  for (const content of result.contents ?? []) {
    if ("text" in content && typeof content.text === "string") {
      const remaining = MAX_MCP_RESOURCE_TEXT_CHARS - textChars;
      if (remaining <= 0) {
        truncated = content.text.length > 0 || truncated;
        continue;
      }
      const text = content.text.length > remaining ? content.text.slice(0, remaining) : content.text;
      if (text.length < content.text.length) {
        truncated = true;
      }
      if (text.length > 0) {
        contentParts.push({ text });
        textChars += text.length;
      }
    } else if ("blob" in content && typeof content.blob === "string") {
      if (blobChars + content.blob.length > maxBlobChars) {
        truncated = true;
        continue;
      }
      blobChars += content.blob.length;
      contentParts.push({
        inlineData: {
          mimeType: typeof content.mimeType === "string" ? content.mimeType : "application/octet-stream",
          data: content.blob
        }
      });
      blobCount += 1;
    }
  }
  const nonce = randomUUID().slice(0, 8);
  const truncationNotice = truncated ? `
[Content truncated \u2014 part of this resource exceeded size limits and was omitted.]` : "";
  const parts = contentParts.length > 0 ? [
    { text: `
--- Content from MCP resource ${label} [${nonce}] ---
` },
    ...contentParts,
    {
      text: `${truncationNotice}
--- End of MCP resource ${label} [${nonce}] ---
`
    }
  ] : [];
  return { parts, textChars, blobCount, blobChars, truncated };
}
__name(formatMcpResourceContents, "formatMcpResourceContents");
function emptyMcpResourceText(formatted, label) {
  return `
--- MCP resource ${label}: ${summarizeMcpResource(formatted)} ---
`;
}
__name(emptyMcpResourceText, "emptyMcpResourceText");
function summarizeMcpResource(formatted) {
  const { textChars, blobCount, truncated } = formatted;
  const summary = [];
  if (textChars > 0) {
    summary.push(`${textChars} chars`);
  }
  if (blobCount > 0) {
    summary.push(`${blobCount} attachment${blobCount === 1 ? "" : "s"}`);
  }
  if (summary.length > 0) {
    return `Injected ${summary.join(" + ")}${truncated ? " (truncated)" : ""}`;
  }
  return truncated ? "(content too large \u2014 skipped)" : "(no readable content)";
}
__name(summarizeMcpResource, "summarizeMcpResource");

export {
  MAX_MCP_RESOURCE_BLOB_CHARS,
  formatMcpResourceContents,
  emptyMcpResourceText,
  summarizeMcpResource
};
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
