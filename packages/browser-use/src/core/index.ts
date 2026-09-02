/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export {
  ChromeRuntime,
  type BrowserInfo,
  type BrowserUserTabInfo,
  type ChromeRuntimeOptions,
  type DispatchResult,
  type ScreenshotEnvelope,
  type TabInfo,
} from './chrome-runtime.js';
export { DEFAULT_CHROME_DOCUMENTATION } from './chrome-runtime-documentation.js';
export { BrowserRuntimeError, type RuntimeErrorCode } from './errors.js';
export { InputController, type CdpInputSender } from './input-controller.js';
export {
  NetworkHarRecorder,
  buildHar,
  finalizeHarFromJournal,
  journalPathForHar,
  type NetworkHarTraceSummary,
  type NetworkHarRecorderOptions,
} from './network-har-recorder.js';
export {
  backendLegacyCommandFor,
  browserPrimitiveNames,
  hasAuditedResult,
  isAfterCodeMutationCommand,
  isLegacyObservationCommand,
  primitiveForLegacyCommand,
  primitiveLegacyCommands,
} from './primitive-compatibility.js';
export {
  type Box,
  type BrowserDialogInfo,
  type BrowserDownloadEvent,
  type BrowserHistoryEntry,
  type BrowserModifier,
  type BrowserMouseButton,
  type BrowserNetworkEntry,
  type BrowserPrimitive,
  type BrowserPrimitiveArgs,
  type BrowserPrimitiveExecutor,
  type BrowserPrimitiveResult,
  type BrowserPrimitiveSpec,
  type BrowserSelectOption,
  type BrowserSnapshotEnvelope,
  type BrowserScrollResult,
  type DialogInfo,
  type LogEntry,
  type LocatorMatcher,
  type LocatorStep,
  type NetworkEntry,
} from './primitives.js';
export {
  commandSchemas,
  locatorStepsSchema,
  type SupportedCommand,
} from './schemas.js';
export {
  MAX_SCREENSHOT_BASE64_CHARS,
  MAX_SCREENSHOT_BYTES,
  MAX_SCREENSHOT_EDGE,
  MAX_SCREENSHOT_PIXELS,
} from './screenshot-budget.js';
export {
  isTabObservationCommand,
  TabOperationCoordinator,
} from './tab-operation-coordinator.js';
