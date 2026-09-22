// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/extract-text-from-contents.ts
init_esbuild_shims();
var textOfParts = /* @__PURE__ */ __name((parts) => parts.map(
  (part) => typeof part === "string" ? part : "text" in part ? part.text || "" : ""
).join(" "), "textOfParts");
function extractTextFromContents(contents) {
  let text = "";
  if (Array.isArray(contents)) {
    text = contents.map((content) => {
      if (typeof content === "string") return content;
      if ("parts" in content && content.parts) {
        return textOfParts(content.parts);
      }
      return "";
    }).join(" ");
  } else if (contents) {
    if (typeof contents === "string") {
      text = contents;
    } else if ("parts" in contents && contents.parts) {
      text = textOfParts(contents.parts);
    }
  }
  return text;
}
__name(extractTextFromContents, "extractTextFromContents");

export {
  extractTextFromContents
};
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
