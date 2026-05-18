/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export {
  canonicalizeWorkspace,
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
  createWorkspaceFileSystemFactory,
  type CreateWorkspaceFileSystemFactoryDeps,
  type FsEntry,
  type FsStat,
  type GlobOptions,
  type ListOptions,
  type ReadMeta,
  type ReadTextOptions,
  type RequestContext,
  type WorkspaceFileSystem,
  type WorkspaceFileSystemFactory,
  type WriteOutcome,
} from './workspaceFileSystem.js';
