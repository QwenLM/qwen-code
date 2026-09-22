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

// packages/cli/src/ui/utils/formatters.ts
init_esbuild_shims();
var formatRelativeTime = /* @__PURE__ */ __name((timestamp) => {
  const now = Date.now();
  const diffMs = now - timestamp;
  const seconds = Math.floor(diffMs / 1e3);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);
  const months = Math.floor(days / 30);
  if (months > 0) {
    return months === 1 ? "1 month ago" : `${months} months ago`;
  }
  if (weeks > 0) {
    return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
  }
  if (days > 0) {
    return days === 1 ? "1 day ago" : `${days} days ago`;
  }
  if (hours > 0) {
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }
  if (minutes > 0) {
    return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  }
  return "just now";
}, "formatRelativeTime");
var formatTokenCount = /* @__PURE__ */ __name((count) => {
  if (count < 1e3) {
    return `${count}`;
  }
  if (count < 1e4) {
    return `${(count / 1e3).toFixed(1)}k`;
  }
  return `${Math.floor(count / 1e3)}k`;
}, "formatTokenCount");
var formatPercentageUsed = /* @__PURE__ */ __name((percentage) => {
  if (percentage > 1) {
    return ">100";
  }
  return (percentage * 100).toFixed(1);
}, "formatPercentageUsed");
var contextUsageLabel = /* @__PURE__ */ __name((terminalWidth) => terminalWidth < 100 ? t("% used") : t("% context used"), "contextUsageLabel");
var formatDuration = /* @__PURE__ */ __name((milliseconds, options) => {
  if (milliseconds <= 0) {
    return "0s";
  }
  if (milliseconds < 1e3) {
    return `${Math.round(milliseconds)}ms`;
  }
  const totalSeconds = milliseconds / 1e3;
  if (totalSeconds < 60) {
    const formatted = totalSeconds.toFixed(1);
    if (parseFloat(formatted) >= 60) {
      return "1m";
    }
    if (options?.hideTrailingZeros && formatted.endsWith(".0")) {
      return `${formatted.slice(0, -2)}s`;
    }
    return `${formatted}s`;
  }
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor(totalSeconds % 3600 / 60);
  const seconds = Math.floor(totalSeconds % 60);
  const parts = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}m`);
  }
  if (seconds > 0) {
    parts.push(`${seconds}s`);
  }
  if (parts.length === 0) {
    if (hours > 0) return `${hours}h`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
  }
  return parts.join(" ");
}, "formatDuration");

export {
  formatRelativeTime,
  formatTokenCount,
  formatPercentageUsed,
  contextUsageLabel,
  formatDuration
};
/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
