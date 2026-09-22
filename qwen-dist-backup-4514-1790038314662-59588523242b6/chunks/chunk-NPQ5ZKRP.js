// Force strict mode and setup for ESM
"use strict";
import {
  getPathComparisonVariants,
  isWithinRoot
} from "./chunk-MR3PXB6E.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __commonJS,
  __name
} from "./chunk-J2S4EL5Y.js";

// node_modules/strip-json-comments/index.js
var require_strip_json_comments = __commonJS({
  "node_modules/strip-json-comments/index.js"(exports, module) {
    "use strict";
    init_esbuild_shims();
    var singleComment = Symbol("singleComment");
    var multiComment = Symbol("multiComment");
    var stripWithoutWhitespace = /* @__PURE__ */ __name(() => "", "stripWithoutWhitespace");
    var stripWithWhitespace = /* @__PURE__ */ __name((string, start, end) => string.slice(start, end).replace(/\S/g, " "), "stripWithWhitespace");
    var isEscaped = /* @__PURE__ */ __name((jsonString, quotePosition) => {
      let index = quotePosition - 1;
      let backslashCount = 0;
      while (jsonString[index] === "\\") {
        index -= 1;
        backslashCount += 1;
      }
      return Boolean(backslashCount % 2);
    }, "isEscaped");
    module.exports = (jsonString, options = {}) => {
      if (typeof jsonString !== "string") {
        throw new TypeError(`Expected argument \`jsonString\` to be a \`string\`, got \`${typeof jsonString}\``);
      }
      const strip = options.whitespace === false ? stripWithoutWhitespace : stripWithWhitespace;
      let insideString = false;
      let insideComment = false;
      let offset = 0;
      let result = "";
      for (let i = 0; i < jsonString.length; i++) {
        const currentCharacter = jsonString[i];
        const nextCharacter = jsonString[i + 1];
        if (!insideComment && currentCharacter === '"') {
          const escaped = isEscaped(jsonString, i);
          if (!escaped) {
            insideString = !insideString;
          }
        }
        if (insideString) {
          continue;
        }
        if (!insideComment && currentCharacter + nextCharacter === "//") {
          result += jsonString.slice(offset, i);
          offset = i;
          insideComment = singleComment;
          i++;
        } else if (insideComment === singleComment && currentCharacter + nextCharacter === "\r\n") {
          i++;
          insideComment = false;
          result += strip(jsonString, offset, i);
          offset = i;
          continue;
        } else if (insideComment === singleComment && currentCharacter === "\n") {
          insideComment = false;
          result += strip(jsonString, offset, i);
          offset = i;
        } else if (!insideComment && currentCharacter + nextCharacter === "/*") {
          result += jsonString.slice(offset, i);
          offset = i;
          insideComment = multiComment;
          i++;
          continue;
        } else if (insideComment === multiComment && currentCharacter + nextCharacter === "*/") {
          i++;
          insideComment = false;
          result += strip(jsonString, offset, i + 1);
          offset = i + 1;
          continue;
        }
      }
      return result + (insideComment ? strip(jsonString.slice(offset)) : jsonString.slice(offset));
    };
  }
});

// packages/cli/src/config/trust-precedence.ts
init_esbuild_shims();
import * as path from "node:path";
function pathDepth(value) {
  const root = path.parse(value).root;
  const relative2 = path.relative(root, value);
  return relative2 === "" ? 0 : relative2.split(path.sep).filter(Boolean).length;
}
__name(pathDepth, "pathDepth");
function matchingDepth(rule, locationVariants) {
  let deepestMatch = -1;
  for (const locationVariant of locationVariants) {
    for (const ruleVariant of rule.variants) {
      if (isWithinRoot(locationVariant, ruleVariant)) {
        deepestMatch = Math.max(deepestMatch, pathDepth(ruleVariant));
      }
    }
  }
  return deepestMatch;
}
__name(matchingDepth, "matchingDepth");
function buildTrustPrecedenceRules(rules) {
  const result = [];
  for (const rule of rules) {
    let level;
    let rulePath = rule.path;
    switch (rule.trustLevel) {
      case "TRUST_FOLDER":
        level = "trusted";
        break;
      case "TRUST_PARENT":
        level = "trusted";
        rulePath = path.dirname(rule.path);
        break;
      case "DO_NOT_TRUST":
        level = "untrusted";
        break;
      default:
        continue;
    }
    result.push({
      level,
      variants: getPathComparisonVariants(rulePath),
      payload: rule.trustLevel
    });
  }
  return result;
}
__name(buildTrustPrecedenceRules, "buildTrustPrecedenceRules");
function resolveTrustRule(rules, locationVariants) {
  let winner;
  let winnerDepth = -1;
  for (const rule of rules) {
    const depth = matchingDepth(rule, locationVariants);
    if (depth < 0) continue;
    if (depth > winnerDepth || depth === winnerDepth && rule.level === "untrusted" && winner?.level !== "untrusted") {
      winner = rule;
      winnerDepth = depth;
    }
  }
  return winner;
}
__name(resolveTrustRule, "resolveTrustRule");
function resolveTrustDecision(rules, locationVariants) {
  const winner = resolveTrustRule(rules, locationVariants);
  return winner?.level === "trusted" ? true : winner?.level === "untrusted" ? false : void 0;
}
__name(resolveTrustDecision, "resolveTrustDecision");

export {
  require_strip_json_comments,
  buildTrustPrecedenceRules,
  resolveTrustRule,
  resolveTrustDecision
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
