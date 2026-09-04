/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The seam between the live orchestrator and a coding-agent backend.
 *
 * An adaptor owns one backend (a qwen serve daemon, an ACP agent, ...) and
 * exposes the small primitive set the orchestrator needs. Capability bits
 * describe what the backend can actually do so the orchestrator can degrade
 * per feature instead of branching on adaptor names.
 */

/** Opaque backend session identity, scoped to the owning adaptor. */
export interface BackendHandle {
  /** Adaptor-scoped stable id (for qwen serve: the session id). */
  readonly id: string;
  /** Identifies the owning adaptor (e.g. 'qwen-code'). */
  readonly adaptor: string;
}

export interface BackendCapabilities {
  /** Whether an in-flight turn can accept an appended instruction. */
  steering: 'native' | 'queued' | 'none';
  /** Whether handoff prompts may carry image attachments. */
  imageInput: boolean;
  /** Whether permission requests surface as events and accept votes. */
  permissionForwarding: boolean;
  /** Whether the backend can push speech-worthy messages mid-turn. */
  proactiveSpeak: boolean;
  /** Whether the backend enumerates existing sessions. */
  sessionList: boolean;
  eventDelivery: 'stream' | 'per-turn' | 'poll' | 'reply-only';
}

export interface SessionSummary {
  handle: BackendHandle;
  label?: string;
  cwd?: string;
  state: 'idle' | 'busy' | 'closed' | 'unknown';
}

/** Receipt returned by prompt(): the task was accepted, not completed. */
export interface PromptReceipt {
  status: 'accepted' | 'queued' | 'rejected';
  /** Correlates later turn events with this prompt (qwen serve: promptId). */
  jobRef?: string;
  /** Human note for the realtime model to relay ("queue full", ...). */
  note?: string;
  /** For steering: the instruction joined the currently running turn. */
  joinedActiveTurn?: boolean;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: Uint8Array; name?: string };

export type PermissionOptionKind = 'proceed' | 'reject' | 'other';

export interface PermissionOption {
  optionId: string;
  label?: string;
  kind: PermissionOptionKind;
  /**
   * Grant breadth, from the wire's structured kind (`allow_once` vs
   * `allow_always`, `reject_once` vs `reject_always`). A bare voice
   * "allow" must take the narrowest ('once') option on offer instead of
   * persisting an always-allow rule. Absent when the backend gave no
   * signal.
   */
  escalation?: 'once' | 'always';
}

export type BackendEvent =
  | { type: 'turn_started'; jobRef?: string }
  | { type: 'progress'; jobRef?: string; summary: string }
  | { type: 'speak'; text: string }
  | {
      type: 'permission_request';
      /** Backend turn that is blocked on this vote, when known. */
      jobRef?: string;
      requestId: string;
      title: string;
      options: readonly PermissionOption[];
      payload?: unknown;
    }
  | {
      type: 'permission_resolved';
      requestId: string;
      /** True when this daemon's own vote settled it (vs WebShell etc.). */
      byUs: boolean;
    }
  | { type: 'turn_complete'; jobRef?: string; summary: string; detail?: string }
  | { type: 'turn_error'; jobRef?: string; error: string }
  | { type: 'session_closed' };

export type PermissionDecision = 'allow' | 'deny' | 'cancel';

export interface BackendAdaptor {
  readonly name: string;

  capabilities(): BackendCapabilities;

  /**
   * Verify the backend is reachable and supports what this adaptor needs.
   * Throws a descriptive error when it does not — fail fast at daemon start.
   */
  preflight(): Promise<void>;

  createSession(opts?: {
    cwd?: string;
    label?: string;
  }): Promise<BackendHandle>;

  listSessions(): Promise<SessionSummary[]>;

  /**
   * Submit one turn. Resolves as soon as the backend admits the prompt.
   * When `steer` is set and the session is busy, the adaptor attempts a
   * mid-turn injection first and reports the outcome in the receipt.
   */
  prompt(
    handle: BackendHandle,
    blocks: readonly ContentBlock[],
    opts?: { steer?: boolean },
  ): Promise<PromptReceipt>;

  /** Long-lived normalized event stream for one session. */
  events(
    handle: BackendHandle,
    opts?: { signal?: AbortSignal },
  ): AsyncIterable<BackendEvent>;

  /** True when the session currently has an active turn. */
  isBusy(handle: BackendHandle): boolean;

  cancel(handle: BackendHandle): Promise<void>;

  respondPermission(
    handle: BackendHandle,
    requestId: string,
    decision: PermissionDecision,
  ): Promise<'delivered' | 'already_resolved'>;

  close(): Promise<void>;
}
