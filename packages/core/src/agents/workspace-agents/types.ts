/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Types for durable workspace agent identities, the Agent
 * Hosts that can run them, and the A2A grants that open them to outside
 * callers.
 *
 * The distinction from Agent Team: a teammate dies with its leader. A workspace
 * agent persists independently and answers @-mentions in chat sessions through
 * the session-agents orchestrator (`agents/session-agents`).
 */

import type { HostProgramProbe } from '../session-agents/contract.js';

export const AGENTS_SCHEMA_VERSION = 1;
export const AGENT_HOST_REPLACEMENT_REQUIRED =
  'Agent Host replacement requires enrollment.';

export const AGENT_HOSTS_SCHEMA_VERSION = 1;
export const LOCAL_AGENT_RUNTIME_ID = 'local';

export interface AgentHost {
  id: string;
  name: string;
  secretHash: string;
  workspaceCwd: string;
  /**
   * Programs the Host offers. A protocol-v2 Host reports program ids
   * (`qwen` / `claude` / `codex`); records written by a v1 Host hold display
   * labels (`Qwen Code ACP`). Readers go through {@link hostOffersProgram},
   * which accepts both.
   */
  providers: string[];
  /** What the Host's last v2 heartbeat probed on its PATH, installed or not. */
  programs?: HostProgramProbe[];
  /** Host protocol version of the last heartbeat; absent means v1. */
  protocol?: number;
  createdAt: number;
  lastSeenAt?: number;
}

export type AgentHostView = Omit<AgentHost, 'secretHash'>;

export interface AgentHostEnrollment {
  tokenHash: string;
  expiresAt: number;
  supersedesHostId?: string;
  replacementHostId?: string;
}

export interface AgentHostsFile {
  schemaVersion: typeof AGENT_HOSTS_SCHEMA_VERSION;
  hosts: AgentHost[];
  enrollment?: AgentHostEnrollment;
}

/**
 * One external caller's permission to call one agent.
 *
 * Per agent, never per daemon: opening agent A says nothing about agent B, and
 * a grant in one direction confers nothing in the other. The secret is stored
 * only as a digest and never travels in a prompt, a tool argument or a log
 * line.
 */
export interface A2AGrant {
  callerId: string;
  agentId: string;
  secretHash: string;
  createdAt: number;
  /** Absent means it does not expire on its own; revocation still applies. */
  expiresAt?: number;
}

export interface AgentWorkspaceState {
  schemaVersion: typeof AGENTS_SCHEMA_VERSION;
  workspaceId: string;
  /** External callers allowed in, and to which agent. Absent means none. */
  callerGrants?: A2AGrant[];
}

export interface WorkspaceAgentsFile {
  schemaVersion: typeof AGENTS_SCHEMA_VERSION;
  agents: WorkspaceAgent[];
}

/** A program a runtime can run an agent with. */
export type AgentProgram = 'qwen' | 'codex' | 'claude';

/**
 * How a host names each program in its advertised `providers`. The one table
 * the host, the daemon's validation and pickup all read.
 */
export const AGENT_PROGRAM_LABELS: Readonly<Record<AgentProgram, string>> = {
  qwen: 'Qwen Code ACP',
  codex: 'Codex CLI',
  claude: 'Claude Code ACP',
};

export function isAgentProgram(value: unknown): value is AgentProgram {
  return (
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(AGENT_PROGRAM_LABELS, value)
  );
}

export function hostOffersProgram(
  host: {
    providers: readonly string[];
    programs?: ReadonlyArray<Pick<HostProgramProbe, 'program' | 'available'>>;
  },
  program: AgentProgram,
): boolean {
  // A v2 Host's probe is authoritative: it says what is installed now.
  if (host.programs) {
    return host.programs.some(
      (probe) => probe.program === program && probe.available,
    );
  }
  // Tolerate both vocabularies: v1 records hold labels, v2 ones ids.
  return (
    host.providers.includes(program) ||
    host.providers.includes(AGENT_PROGRAM_LABELS[program])
  );
}

/** Every program a Host offers, as ids. */
export function hostAvailablePrograms(host: {
  providers: readonly string[];
  programs?: ReadonlyArray<Pick<HostProgramProbe, 'program' | 'available'>>;
}): AgentProgram[] {
  return (Object.keys(AGENT_PROGRAM_LABELS) as AgentProgram[]).filter(
    (program) => hostOffersProgram(host, program),
  );
}

/**
 * The coordinator's pinned answer for a Host credential it will not accept.
 *
 * A Host clears its stored credential and re-joins only on this exact body;
 * every other 401 — the bearer gate while the runtime is still starting, or
 * the routes being unmounted — is worth a retry. Both halves read this
 * constant so the coupling is a compile error rather than a string match.
 */
export const AGENT_HOST_CREDENTIAL_REJECTED = 'Invalid Agent Host credential.';

export type WorkspaceAgentExecution =
  | {
      mode: 'local';
      /** Program on this machine; `qwen` when absent (session agents only). */
      provider?: AgentProgram;
    }
  | {
      mode: 'managed-host';
      hostIds: string[];
      /** The program to run on the host; the host's default when absent. */
      provider?: AgentProgram;
    };

/**
 * A durable agent identity, scoped to one workspace.
 *
 * Identity instructions, model and scheduling policy live here. `agentType`
 * optionally supplies a reusable base definition; an Agent created in the
 * primary flow needs no second definition record.
 */
export interface WorkspaceAgent {
  /** Stable id. Never reused, never derived from the name. */
  id: string;
  /**
   * Display name and the token people and agents type after `@`. Unique
   * within a workspace, case-insensitively — mention routing has to be
   * unambiguous, and two agents named `Review` and `review` would make it a
   * coin flip.
   */
  name: string;
  /** Display and peer-discovery summary; never grants execution authority. */
  description?: string;
  /** Hex colour (`#rrggbb`) for UI attribution. */
  color?: string;
  /** Optional existing definition supplying a base persona. */
  agentType?: string;
  /** Model override; absent inherits the workspace default. */
  model?: string;
  /**
   * What this identity is told on top of its definition's prompt.
   *
   * Appended to the optional base definition at boot, so editing the Agent
   * reaches its next turn rather than only its next spawn.
   *
   * It cannot widen anything. The read-only capability boundary is derived
   * from the definition and applied after this, so instructions change what an
   * agent is for and never what it may do.
   */
  instructions?: string;
  /**
   * Thread-era cap on runs waiting for this agent. Still accepted on read so
   * existing roster files validate; nothing reads it now.
   * TODO(multi-agent): drop once rosters written before the session-agents
   * redesign no longer need to load.
   */
  queueLimit?: number;
  /**
   * Absent or `true` = can be addressed. `false` keeps the identity and its
   * history but stops it taking new work, matching how a disabled scheduled
   * task stays on disk.
   */
  enabled?: boolean;
  createdAt: number;
  /**
   * Set when a person deletes this agent. The entry stays so every message it
   * wrote keeps its author, but it stops being addressable and reads
   * `offline`.
   */
  retiredAt?: number;
  /** How many runs this agent may execute at once. Absent means 1. */
  maxConcurrentRuns?: number;
  /** Where this workspace-scoped identity may execute. Absent means local. */
  execution?: WorkspaceAgentExecution;
}
