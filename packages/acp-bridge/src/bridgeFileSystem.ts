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
 * post-PR-18 follow-up thread about `BridgeClient`'s inline fs
 * proxy bypassing `WorkspaceFileSystem` (originally raised in
 * #4250 review; see also FIXME(stage-1.5, chiga0 finding 4) lifted
 * to this package as part of #4175 F1). Until that adapter ships and `runQwenServe` wires it
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
   * Atomically replace `params.path` with `params.content`. Returns
   * the ACP-shaped empty response on success; throws an `FsError`
   * (classified downstream by `mapDomainErrorToErrorKind`) on
   * boundary, trust, or I/O failure.
   *
   * Adapter MUST provide:
   *   - **Write-then-rename atomicity** — a SIGKILL / OOM mid-write
   *     does NOT leave the target truncated.
   *   - **Target mode preservation** — editing a `0o600` secret
   *     keeps it at `0o600`; an executable `+x` bit is retained.
   *   - **`0o600` default for new files** — NOT umask defaults (the
   *     write syscall's `mode` arg bypasses umask). This is the
   *     security posture for agent-driven writes where the agent's
   *     intent about the file's audience is unknown.
   *   - **Symlink rejection** — paths whose target is a symlink
   *     surface `symlink_escape`. This is a **divergence from the
   *     pre-F1 inline `BridgeClient.writeTextFile` proxy** which
   *     resolved symlinks and wrote through to their target;
   *     production now matches the more conservative PR 18 +
   *     HTTP `POST /file` posture (PR 20). Agents that previously
   *     relied on writing through symlinked dotfiles will need
   *     to address the resolved path directly.
   *   - **Workspace boundary enforcement** — paths outside the
   *     bound workspace surface `path_outside_workspace`.
   *
   * Owner/group preservation is best-effort and platform-dependent
   * (POSIX `chown` requires root for cross-user changes; Windows
   * lacks the concept entirely). The contract does NOT require it.
   *
   * The serve-side adapter satisfies this via
   * `WorkspaceFileSystem.writeTextOverwrite` — the PR 18 primitive
   * that does atomic tmp+rename with mode preservation + `0o600`
   * default + symlink reject inside a per-path lock.
   */
  writeText(params: WriteTextFileRequest): Promise<WriteTextFileResponse>;
}
