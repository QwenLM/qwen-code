// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/serve/channel-selection.ts
init_esbuild_shims();
function isAllChannelSelectionName(name) {
  return name.trim() === "all";
}
__name(isAllChannelSelectionName, "isAllChannelSelectionName");
function normalizeServeChannelSelection(rawChannels, label = "--channel") {
  if (rawChannels === void 0 || rawChannels.length === 0) {
    return void 0;
  }
  const names = [];
  const seen = /* @__PURE__ */ new Set();
  for (const raw of rawChannels) {
    const name = raw.trim();
    if (!name) {
      throw new Error(`${label} requires a non-empty channel name.`);
    }
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  if (names.some(isAllChannelSelectionName)) {
    if (names.length > 1) {
      throw new Error(`${label} all cannot be combined with channel names.`);
    }
    return { mode: "all" };
  }
  return { mode: "names", names };
}
__name(normalizeServeChannelSelection, "normalizeServeChannelSelection");
function channelSelectionNames(selection) {
  return selection.mode === "all" ? ["all"] : [...selection.names];
}
__name(channelSelectionNames, "channelSelectionNames");

export {
  isAllChannelSelectionName,
  normalizeServeChannelSelection,
  channelSelectionNames
};
