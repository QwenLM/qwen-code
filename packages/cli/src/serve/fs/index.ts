/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export {
  canonicalizeWorkspace,
  canonicalizeWorkspaces,
  hasSuspiciousPathPattern,
  resolveWithinWorkspace,
  type Intent,
  type ResolvedPath,
} from './paths.js';
export {
  FsError,
  isFsError,
  type FsErrorKind,
  type FsErrorStatus,
} from './errors.js';
export {
  MAX_READ_BYTES,
  MAX_WRITE_BYTES,
  MAX_UPLOAD_BYTES,
  BINARY_PROBE_BYTES,
  assertTrustedForIntent,
  detectBinary,
  enforceReadBytesSize,
  enforceReadSize,
  enforceWriteSize,
  shouldIgnore,
  type IgnoreVerdict,
  type ReadSizeOutcome,
} from './policy.js';
export {
  FS_ACCESS_EVENT_TYPE,
  FS_DENIED_EVENT_TYPE,
  createAuditPublisher,
  type AuditContext,
  type AuditPublisher,
  type CreateAuditPublisherDeps,
  type FsAccessAuditPayload,
  type FsDeniedAuditPayload,
} from './audit.js';
export {
  OWNER_ONLY_NEW_FILE_MODE,
  createWorkspaceFileSystemFactory,
  isContentHash,
  resolveNewFileModeBits,
  type ContentHash,
  type CreateWorkspaceFileSystemFactoryDeps,
  type NewFileModePolicy,
  type FsEntry,
  type FsStat,
  type GlobOptions,
  type ListOptions,
  type ReadBytesOptions,
  type ReadBytesOutcome,
  type ReadMeta,
  type ReadTextOptions,
  type RequestContext,
  type SameHostToolTextWriteRequest,
  type WorkspaceFileSystem,
  type WorkspaceFileSystemFactory,
  type WriteMode,
  type WriteOutcome,
  type WriteTextAtomicOptions,
  type WriteTextAtomicOutcome,
} from './workspace-file-system.js';
export { MAX_TEXT_CURSOR_CHARS } from './text-cursor.js';
