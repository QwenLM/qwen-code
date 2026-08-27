/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Stream } from '@agentclientprotocol/sdk';

export interface AcpChannelTransportGuard {
  maxActiveHandlers: number;
  maxActiveHandlerBytes: number;
  reserveOutboundOperation(value: unknown): () => void;
  reservePreparedResponse(value: unknown): void;
  fail(error: unknown): void;
}

/**
 * One ACP NDJSON channel to a single agent. Tests inject a fake by
 * replacing the channel factory; production uses
 * `defaultSpawnChannelFactory` (in `./spawnChannel.ts`).
 *
 * This contract is consumed by the daemon HTTP bridge and is available
 * for `packages/channels/base/AcpBridge.ts` and the VSCode IDE
 * companion's `acpConnection.ts` to consume directly via
 * `@qwen-code/acp-bridge/spawnChannel` instead of each reimplementing
 * the child lifecycle. The adapter migrations land separately.
 */
export interface AcpChannel {
  stream: Stream;
  /**
   * Resolves once when the transport becomes permanently unusable before the
   * underlying process has exited. The bridge uses this to stop admitting work
   * to a child that is still inside its termination grace period. Providers
   * that expose this signal are also responsible for starting teardown.
   */
  transportFailed?: Promise<unknown>;
  /** Present only on daemon-owned bounded transports. */
  transportGuard?: AcpChannelTransportGuard;
  /** Best-effort terminate; resolves when owned teardown is complete. */
  kill(): Promise<void>;
  /**
   * Synchronous force-kill for the second-signal force-exit path.
   * Force-kills the owned process tree (or equivalent in-process tear-down)
   * and returns immediately — no Promise. The daemon's
   * signal handler can call this before `process.exit(1)` so that
   * double-Ctrl+C doesn't leave the agent child running after the
   * daemon vanishes.
   */
  killSync(): void;
  /**
   * Resolves when the channel has terminated for any reason —
   * planned (`kill()` called) OR unexpected (child process crashed,
   * stream closed). The bridge subscribes to this so a SessionEntry
   * whose underlying channel dies between requests is removed from
   * `byId` / `defaultEntry` instead of lingering as a stuck session.
   *
   * Resolves to `{ exitCode, signalCode }` when the spawn factory
   * can capture them (the standard `child.on('exit', code, signal)`
   * path), or `undefined` when termination didn't go through the OS
   * exit path (programmatic kill via the in-process channel,
   * channel-factory error path, etc.). The bridge threads this
   * through the `session_died` event so an operator triaging a
   * crash doesn't need to grep stderr for the pid.
   */
  exited: Promise<AcpChannelExitInfo | undefined>;
}

export interface AcpChannelExitInfo {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

export type ChannelFactory = (
  workspaceCwd: string,
  childEnvOverrides?: Readonly<Record<string, string | undefined>>,
) => Promise<AcpChannel>;
