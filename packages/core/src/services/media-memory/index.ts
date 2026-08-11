/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Multimodal media memory (upstream design M). The service below is the
 * ONLY entry point: collection writes happen exclusively from the omni
 * harness (M §14 — no daemon, no MCP surface), and Stage B recall reads
 * go through the same facade. Store/type modules are internal except for
 * the record types recall consumers need.
 */

export {
  MediaMemoryService,
  DEFAULT_MAX_INLINE_TEXT_BYTES,
  MEDIA_DETECTOR_VERSION,
  type MediaMemoryBinding,
  type PolicyOutputInput,
  type PolicyMediaOutputInput,
  type PolicyTextOutputInput,
  type PolicySucceededInput,
  type PolicySucceededCommit,
} from './service.js';
export {
  MediaResourceRegistry,
  type MediaResourceBinding,
  type OmniMediaRegistryView,
} from './registry.js';
export {
  MediaMemoryRecallService,
  MediaMemoryRecallRejection,
  type MediaMemoryCandidateSummary,
  type MediaMemoryRecallRequest,
  type MediaMemoryRecallResult,
  type MediaMemoryRecallFile,
  type MediaMemoryRecallEntry,
  type MediaMemoryRecallGap,
  type MediaMemoryRecallProvenance,
  type MediaMemoryRecallAdvisor,
  type MediaMemoryNextPolicyAction,
} from './recall.js';
export {
  OmniMemoryConfigError,
  DEFAULT_OMNI_MEMORY_CONFIG,
  OMNI_MEMORY_RECALL_KINDS,
  normalizeOmniMemoryConfig,
  type NormalizedOmniMemoryConfig,
  type NormalizedOmniMemoryCollection,
  type NormalizedOmniMemoryRecall,
  type NormalizedOmniMemorySideQuery,
  type OmniMemoryConfigView,
  type OmniMemoryRecallKind,
  type RawOmniMemorySettings,
} from './config.js';
export type {
  FileRecognizedCommit,
  FileRecognizedEvent,
  KnownMediaMemoryRole,
  MediaArtifactRef,
  MediaChannel,
  MediaCoverage,
  MediaExecutionOrigin,
  MediaFileId,
  MediaFileOrigin,
  MediaFileRecord,
  MediaFileVersionId,
  MediaFileVersionRecord,
  MediaMemoryEntryId,
  MediaMemorySnapshot,
  MediaPolicyExecutionRecord,
  MediaScope,
  MediaVersionRecognition,
  MediaVersionSource,
  NormalizedPolicyOutput,
  PolicyExecutionId,
} from './types.js';
