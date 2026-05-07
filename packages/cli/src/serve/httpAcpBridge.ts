/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Stage 1 HTTP→ACP bridge skeleton.
 *
 * Per design §08 (Roadmap, Stage 1) and the issue body's Caveat:
 *   - Each session spawns its own `qwen --acp` child process.
 *   - HTTP request bodies are forwarded as ACP NDJSON over the child's stdin.
 *   - Child stdout NDJSON notifications fan out to all SSE/WS subscribers
 *     attached to the session.
 *   - Multi-client requests against the same session serialize through this
 *     bridge (FIFO; honors ACP's "one active prompt per session" invariant).
 *
 * This file ships the public surface only; the routes that depend on it
 * (`POST /session`, `POST /session/:id/prompt`, `GET /session/:id/events`
 * etc.) land in follow-up PRs once each surface has its own test coverage.
 *
 * Stage 2 replaces this with an in-process call into core's ACP-equivalent
 * API (no child subprocess). The HTTP route layer does NOT need to change at
 * that point — only the implementation behind `HttpAcpBridge` does.
 */

export interface BridgeSpawnRequest {
  /** Workspace root the spawned `qwen --acp` child process inherits as cwd. */
  workspaceCwd: string;
  /** Optional explicit model service id; falls back to settings default. */
  modelServiceId?: string;
}

export interface BridgeSession {
  sessionId: string;
  workspaceCwd: string;
  /** True if this attach reused an existing session under `sessionScope: single`. */
  attached: boolean;
}

export interface HttpAcpBridge {
  /**
   * Create a new session, or — under `sessionScope: 'single'` — attach to an
   * existing session for the same workspace.
   */
  spawnOrAttach(req: BridgeSpawnRequest): Promise<BridgeSession>;

  /** Close all live child processes; called on daemon shutdown. */
  shutdown(): Promise<void>;
}

/**
 * Stub implementation. Returns a placeholder so the type plumbing compiles.
 * Replaced in the follow-up PR that wires the actual stdio child process.
 */
export function createHttpAcpBridge(): HttpAcpBridge {
  return {
    async spawnOrAttach(_req) {
      throw new Error(
        'HttpAcpBridge.spawnOrAttach is not yet implemented (Stage 1 follow-up PR).',
      );
    },
    async shutdown() {
      // No-op until the bridge owns child processes.
    },
  };
}
