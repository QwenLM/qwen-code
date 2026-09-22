// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/core/src/utils/cronDisplay.ts
init_esbuild_shims();
var INTEGER_TOKEN_RE = /^\d+$/;
function parsePositiveInteger(token) {
  if (!INTEGER_TOKEN_RE.test(token)) return void 0;
  const value = parseInt(token, 10);
  return value > 0 ? value : void 0;
}
__name(parsePositiveInteger, "parsePositiveInteger");
function evenStepOf(token, unit) {
  const n = parsePositiveInteger(token);
  if (n === void 0 || n >= unit || unit % n !== 0) return void 0;
  return n;
}
__name(evenStepOf, "evenStepOf");
function isEveryDayStep(token) {
  return parsePositiveInteger(token) === 1;
}
__name(isEveryDayStep, "isEveryDayStep");
function humanReadableCron(cronExpr) {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return cronExpr;
  const [min, hour, dom, mon, dow] = parts;
  if (min.startsWith("*/") && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    const n = evenStepOf(min.slice(2), 60);
    if (n !== void 0) {
      return n === 1 ? "Every minute" : `Every ${n} minutes`;
    }
  }
  if (/^\d+$/.test(min) && hour.startsWith("*/") && dom === "*" && mon === "*" && dow === "*") {
    const n = evenStepOf(hour.slice(2), 24);
    if (n !== void 0) {
      return n === 1 ? "Every hour" : `Every ${n} hours`;
    }
  }
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom.startsWith("*/") && mon === "*" && dow === "*" && isEveryDayStep(dom.slice(2))) {
    return "Every day";
  }
  return cronExpr;
}
__name(humanReadableCron, "humanReadableCron");

export {
  humanReadableCron
};
