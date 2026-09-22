// Force strict mode and setup for ESM
"use strict";
import {
  t
} from "./chunk-POMFSBEC.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/ui/utils/history-gap-notice.ts
init_esbuild_shims();
function formatHistoryGapNotice(_gap) {
  return t(
    "\u26A0\uFE0F History gap: earlier conversation was lost before this point (storage interruption) and could not be recovered."
  );
}
__name(formatHistoryGapNotice, "formatHistoryGapNotice");
function indexGapsByChild(gaps) {
  const byChild = /* @__PURE__ */ new Map();
  for (const gap of gaps ?? []) {
    byChild.set(gap.childUuid, gap);
  }
  return byChild;
}
__name(indexGapsByChild, "indexGapsByChild");

export {
  formatHistoryGapNotice,
  indexGapsByChild
};
/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */
