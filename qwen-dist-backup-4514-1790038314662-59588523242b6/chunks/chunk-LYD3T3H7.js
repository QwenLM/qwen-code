// Force strict mode and setup for ESM
"use strict";
import {
  init_esbuild_shims
} from "./chunk-5O2XNYP6.js";
import {
  __name
} from "./chunk-J2S4EL5Y.js";

// packages/acp-bridge/src/daemon-memory-budget.ts
init_esbuild_shims();
import os from "node:os";
var LEGACY_CHILD_HEAP_FRACTION = 0.5;
var DEFAULT_MEMORY_BUDGET_FRACTION = 0.5;
var MIN_MEMORY_BUDGET_MB = 1024;
var MAX_MEMORY_BUDGET_MB = 1048576;
var MIN_CHILD_HEAP_MB = 512;
var MAX_CHILD_HEAP_MB = 16384;
var ROOT_RESERVE_FRACTION = 0.1;
var MIN_ROOT_RESERVE_MB = 256;
var MAX_ROOT_RESERVE_MB = 1024;
var JOURNAL_GROWTH_POOL_FRACTION = 0.05;
var MAX_JOURNAL_GROWTH_POOL_MB = 1024;
function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high);
}
__name(clamp, "clamp");
function detectAvailableMemoryMb() {
  const constrainedMemory = process.constrainedMemory;
  const constrained = typeof constrainedMemory === "function" ? constrainedMemory() : 0;
  const totalBytes = os.totalmem();
  if (constrained > 0 && constrained < totalBytes) {
    return {
      memoryMb: Math.floor(constrained / (1024 * 1024)),
      source: "constrained"
    };
  }
  return { memoryMb: Math.floor(totalBytes / (1024 * 1024)), source: "host" };
}
__name(detectAvailableMemoryMb, "detectAvailableMemoryMb");
function legacyChildCeilingMb(availableMemoryMb) {
  const memoryMb = availableMemoryMb ?? detectAvailableMemoryMb().memoryMb;
  return Math.min(
    Math.floor(memoryMb * LEGACY_CHILD_HEAP_FRACTION),
    MAX_CHILD_HEAP_MB
  );
}
__name(legacyChildCeilingMb, "legacyChildCeilingMb");
function isValidMemoryBudgetMb(value) {
  return Number.isSafeInteger(value) && value >= MIN_MEMORY_BUDGET_MB && value <= MAX_MEMORY_BUDGET_MB;
}
__name(isValidMemoryBudgetMb, "isValidMemoryBudgetMb");
function normalizeMemoryBudgetMb(value) {
  if (!isValidMemoryBudgetMb(value)) {
    throw new TypeError(
      `Invalid memoryBudgetMb: ${value}. Must be a safe integer in [${MIN_MEMORY_BUDGET_MB}, ${MAX_MEMORY_BUDGET_MB}].`
    );
  }
  return value;
}
__name(normalizeMemoryBudgetMb, "normalizeMemoryBudgetMb");
function memoryBudgetRangeError() {
  return `qwen serve: --memory-budget-mb must be an integer in [${MIN_MEMORY_BUDGET_MB}, ${MAX_MEMORY_BUDGET_MB}].`;
}
__name(memoryBudgetRangeError, "memoryBudgetRangeError");
function recommendedChildShareMb(budget, children) {
  const share = clamp(
    Math.floor(budget.childPoolMb / Math.max(children, 1)),
    MIN_CHILD_HEAP_MB,
    MAX_CHILD_HEAP_MB
  );
  return Math.min(share, budget.legacyChildCeilingMb);
}
__name(recommendedChildShareMb, "recommendedChildShareMb");
function journalGrowthPoolMb(budget) {
  if (budget.insufficientMemory) return 0;
  return Math.min(
    Math.floor(budget.effectiveBudgetMb * JOURNAL_GROWTH_POOL_FRACTION),
    MAX_JOURNAL_GROWTH_POOL_MB,
    budget.childPoolMb
  );
}
__name(journalGrowthPoolMb, "journalGrowthPoolMb");
function serveJournalGrowthPoolMb(input) {
  if (input.maxJournalEvents !== void 0) return 0;
  if (input.maxJournalBytes !== void 0) return 0;
  return journalGrowthPoolMb(input.budget);
}
__name(serveJournalGrowthPoolMb, "serveJournalGrowthPoolMb");
function resolveDaemonMemoryBudget(input = {}) {
  const detected = input.availableMemoryMb === void 0 ? detectAvailableMemoryMb() : {
    memoryMb: input.availableMemoryMb,
    source: input.availableMemorySource ?? "host"
  };
  const availableMemoryMb = detected.memoryMb;
  const configuredBudgetMb = input.budgetMb === void 0 ? Math.min(
    Math.floor(availableMemoryMb * DEFAULT_MEMORY_BUDGET_FRACTION),
    MAX_MEMORY_BUDGET_MB
  ) : normalizeMemoryBudgetMb(input.budgetMb);
  const effectiveBudgetMb = Math.min(configuredBudgetMb, availableMemoryMb);
  const rootReserveMb = Math.min(
    clamp(
      Math.floor(effectiveBudgetMb * ROOT_RESERVE_FRACTION),
      MIN_ROOT_RESERVE_MB,
      MAX_ROOT_RESERVE_MB
    ),
    effectiveBudgetMb
  );
  return {
    configuredBudgetMb,
    effectiveBudgetMb,
    budgetSource: input.budgetMb === void 0 ? "derived" : "flag",
    availableMemoryMb,
    availableMemorySource: detected.source,
    rootReserveMb,
    childPoolMb: effectiveBudgetMb - rootReserveMb,
    legacyChildCeilingMb: legacyChildCeilingMb(availableMemoryMb),
    insufficientMemory: effectiveBudgetMb < MIN_MEMORY_BUDGET_MB
  };
}
__name(resolveDaemonMemoryBudget, "resolveDaemonMemoryBudget");
function formatMemoryBudgetStderr(budget) {
  let message = `qwen serve: memory budget ${budget.effectiveBudgetMb} MB (${budget.budgetSource}, ${budget.availableMemoryMb} MB available via ${budget.availableMemorySource})`;
  if (budget.effectiveBudgetMb < budget.configuredBudgetMb) {
    message += `; capped down from the configured ${budget.configuredBudgetMb} MB`;
  }
  if (budget.insufficientMemory) {
    message += `; below the ${MIN_MEMORY_BUDGET_MB} MB minimum budget`;
    if (budget.budgetSource === "derived") {
      const minHostMb = Math.ceil(
        MIN_MEMORY_BUDGET_MB / DEFAULT_MEMORY_BUDGET_FRACTION
      );
      message += ` (a derived budget needs a host with at least ~${minHostMb} MB; pass --memory-budget-mb to override \u2014 requires at least ${MIN_MEMORY_BUDGET_MB} MB available)`;
    }
  }
  return message;
}
__name(formatMemoryBudgetStderr, "formatMemoryBudgetStderr");

export {
  MIN_MEMORY_BUDGET_MB,
  MIN_CHILD_HEAP_MB,
  MAX_CHILD_HEAP_MB,
  JOURNAL_GROWTH_POOL_FRACTION,
  MAX_JOURNAL_GROWTH_POOL_MB,
  detectAvailableMemoryMb,
  isValidMemoryBudgetMb,
  memoryBudgetRangeError,
  recommendedChildShareMb,
  serveJournalGrowthPoolMb,
  resolveDaemonMemoryBudget,
  formatMemoryBudgetStderr
};
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
