/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

/**
 * Injection seam for the ACP fs proxy on `BridgeClient.readTextFile` /
 * `BridgeClient.writeTextFile`. The immediate follow-up PR will land
 * a serve-side adapter that wraps PR 18's `WorkspaceFileSystem` so
 * production `qwen serve` writes pick up the TOCTOU + symlink +
 * trust-gate + audit machinery PR 18 introduced — closing the
 * `ws.ts:613` follow-up thread that has been tracked since PR 18
 * landed. Until that adapter ships and `runQwenServe` wires it
 * through `BridgeOptions.fileSystem`, BridgeClient continues to use
 * its inline fs proxy (preserving pre-F1 behavior).
 *
 * Lifted from the inline `fs.writeFile` / `fs.readFile` implementations
 * BridgeClient carried before #4175 PR F1 (step 5, originally the
 * 22b' scope). Bridge tests + Mode A embedded callers can omit the
 * field on `BridgeOptions`; BridgeClient falls back to its inline
 * proxy so the pre-lift behavior is preserved verbatim when no
 * provider is injected.
 *
 * Method signatures intentionally mirror the ACP SDK request/response
 * shapes so the adapter does the minimum amount of translation
 * (`{ path, content }` ↔ `WorkspaceFileSystem`'s `ResolvedPath` brand
 * types + options bag).
 */
export interface BridgeFileSystem {
  /**
   * Read a UTF-8 text file. Honors ACP's `line` / `limit` window
   * semantics (1-based line, inclusive limit). The adapter is
   * expected to surface boundary / trust / encoding errors as
   * thrown JS errors — the bridge's existing error-mapping path
   * (`mapDomainErrorToErrorKind`) will classify them downstream.
   *
   * Adapter MUST replicate the inline proxy's two defensive
   * gates (the inline path is fully bypassed when a fileSystem is
   * injected):
   *   1. Reject non-regular files (sockets / pipes / char devices
   *      / procfs / sysfs entries can produce unbounded data on
   *      read despite reporting `stats.size === 0`). Inline path
   *      throws with `describeStatKind(stats)` in the message.
   *   2. Cap the buffered size (the inline path uses
   *      `READ_FILE_SIZE_CAP = 100 MiB` to defend against a small
   *      `{ line: 1, limit: 10 }` request against a 500 MB log
   *      from costing 500 MB of RSS just to return 10 lines).
   */
  readText(params: ReadTextFileRequest): Promise<ReadTextFileResponse>;

  /**
   * Atomically replace `params.path` with `params.content`. Adapter
   * MUST preserve mode/owner where possible, resolve symlinks
   * before write, and reject paths outside the bound workspace.
   * Returns the ACP-shaped empty response on success.
   *
   * Adapter MUST replicate the inline proxy's defenses:
   *   - Write-then-rename atomicity (avoid truncation on
   *     SIGKILL / OOM mid-write).
   *   - Dangling-symlink → write through to the symlink's intended
   *     target (don't replace the symlink with a regular file).
   *   - Preserve target mode bits + owner/group where the daemon
   *     has permission.
   *   - Default to `0o600` for newly-created files (NOT umask
   *     defaults — the inline `mode` arg bypasses umask for
   *     atomicity of secret writes).
   */
  writeText(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;
}
