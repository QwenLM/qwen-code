// Force strict mode and setup for ESM
"use strict";
import {
  useKeypress
} from "./chunk-CGGQFT4L.js";
import {
  require_react
} from "./chunk-5QWWOFGG.js";
import {
  t
} from "./chunk-POMFSBEC.js";
import {
  APPROVAL_MODES
} from "./chunk-JX6XHPTX.js";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name,
  __toESM
} from "./chunk-J2S4EL5Y.js";

// packages/cli/src/ui/hooks/useAutoAcceptIndicator.ts
init_esbuild_shims();
var import_react = __toESM(require_react(), 1);
var AUTO_MODE_FIRST_TIME_MESSAGE_KEY = "auto_mode.entry_notice";
var AUTO_MODE_FIRST_TIME_MESSAGE_FALLBACK = "Auto mode enabled.\n   An LLM classifier evaluates each tool call \u2014 safe actions auto-approve,\n   risky ones are blocked. Exit: Shift+Tab or /approval-mode default.";
var getAutoModeFirstTimeMessage = /* @__PURE__ */ __name(() => {
  const message = t(AUTO_MODE_FIRST_TIME_MESSAGE_KEY);
  return message === AUTO_MODE_FIRST_TIME_MESSAGE_KEY ? AUTO_MODE_FIRST_TIME_MESSAGE_FALLBACK : message;
}, "getAutoModeFirstTimeMessage");
function useAutoAcceptIndicator({
  config,
  settings,
  addItem,
  onApprovalModeChange,
  shouldBlockTab,
  disabled
}) {
  const currentConfigValue = config.getApprovalMode();
  const [showAutoAcceptIndicator, setShowAutoAcceptIndicator] = (0, import_react.useState)(currentConfigValue);
  (0, import_react.useEffect)(() => {
    setShowAutoAcceptIndicator(currentConfigValue);
  }, [currentConfigValue]);
  (0, import_react.useEffect)(() => {
    if (currentConfigValue === "auto" /* AUTO */) {
      emitAutoModeEntryNotices({ config, settings, addItem });
    }
  }, []);
  useKeypress(
    (key) => {
      const isShiftTab = key.shift && key.name === "tab" && !key.ctrl;
      const isWindowsTab = process.platform === "win32" && key.name === "tab" && !key.ctrl && !key.meta;
      if (isShiftTab || isWindowsTab) {
        if (isWindowsTab && shouldBlockTab?.()) {
          return;
        }
        const currentMode = config.getApprovalMode();
        const currentIndex = APPROVAL_MODES.indexOf(currentMode);
        const nextIndex = currentIndex === -1 ? 0 : (currentIndex + 1) % APPROVAL_MODES.length;
        const nextApprovalMode = APPROVAL_MODES[nextIndex];
        try {
          config.setApprovalMode(nextApprovalMode);
          setShowAutoAcceptIndicator(nextApprovalMode);
          if (nextApprovalMode === "auto" /* AUTO */ && currentMode !== "auto" /* AUTO */) {
            emitAutoModeEntryNotices({ config, settings, addItem });
          }
          onApprovalModeChange?.(nextApprovalMode);
        } catch (e) {
          addItem?.(
            {
              type: "info" /* INFO */,
              text: e.message
            },
            Date.now()
          );
        }
      }
    },
    { isActive: !disabled }
  );
  return showAutoAcceptIndicator;
}
__name(useAutoAcceptIndicator, "useAutoAcceptIndicator");
function emitAutoModeEntryNotices(opts) {
  const { config, settings, addItem } = opts;
  if (!addItem) return;
  const now = Date.now();
  const acknowledged = settings?.merged.ui?.autoModeAcknowledged === true;
  if (!acknowledged) {
    addItem(
      { type: "info" /* INFO */, text: getAutoModeFirstTimeMessage() },
      now
    );
    if (settings) {
      try {
        settings.setValue("User" /* User */, "ui.autoModeAcknowledged", true);
      } catch {
      }
    }
  }
  const pm = config.getPermissionManager?.();
  const stripped = pm?.getStrippedDangerousRules?.();
  if (stripped && (stripped.persistent.length > 0 || stripped.session.length > 0)) {
    const lines = [
      "\u2139 Auto mode temporarily disabled these allow rules",
      "   (they would bypass the classifier):",
      ...stripped.persistent.map((r) => `   - ${r.raw} (from user settings)`),
      ...stripped.session.map((r) => `   - ${r.raw} (session)`),
      "   These will be restored when leaving auto mode."
    ];
    addItem({ type: "info" /* INFO */, text: lines.join("\n") }, now + 1);
  }
}
__name(emitAutoModeEntryNotices, "emitAutoModeEntryNotices");

export {
  useAutoAcceptIndicator,
  emitAutoModeEntryNotices
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
