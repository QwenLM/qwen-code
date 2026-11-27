/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { parseBridgeManagedSessionStore } from '@qwen-code/acp-bridge/bridgeTypes';
import type {
  HostedHarnessPlacement,
  HostedHarnessReleaseReceipt,
} from '@qwen-code/qwen-code-core/managed-runtime/hosted-harness-release.js';
import type {
  HttpManagedSessionStores,
  HttpToolPublicationOwner,
  ManagedSessionLifecycleAuthority,
} from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import type { PublicChildModelRoute } from '@qwen-code/qwen-code-core/managed-runtime/managed-child-operations.js';
import type {
  ManagedExtensionApplyCommand,
  ManagedExtensionEffectiveBundle,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-package.js';
import type { ManagedSession } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import type { ManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import type { DaemonLogger } from '../daemon-logger.js';
import type { SseAdmissionCaps } from '../daemon-status.js';
import type { HostedActionParkRefusal } from '../hosted-action-parking.js';
import type { HostedAgentDefinition } from '../hosted-agent-definition.js';
import type { HostedAutomationSession } from '../hosted-automation-session.js';
import type { HostedChannelSession } from '../hosted-channel-session.js';
import type { HostedChildAgentSession } from '../hosted-child-agent-session.js';
import type { HostedChildRunSession } from '../hosted-child-run-session.js';
import type { HostedClientFilesSession } from '../hosted-client-files-session.js';
import type { HostedContextCompression } from '../hosted-context-compression.js';
import type { HostedCronSession } from '../hosted-cron-session.js';
import type { HostedChildExtensionAgent } from '../hosted-extension-agent.js';
import type {
  HostedExtensionPackage,
  HostedExtensionSession,
} from '../hosted-extension-session.js';
import type { HostedHookSession } from '../hosted-hook-session.js';
import type {
  HostedLoopClassifier,
  HostedLoopSession,
} from '../hosted-loop-session.js';
import type {
  HOSTED_MCP_PROFILE,
  HostedMcpSession,
} from '../hosted-mcp-session.js';
import type { HostedMemorySession } from '../hosted-memory-session.js';
import type { HostedModelConfigReader } from '../hosted-model-config.js';
import type { HostedMonitorSession } from '../hosted-monitor-session.js';
import type { HostedMonitorWakeScheduler } from '../hosted-monitor-wake.js';
import type { HostedSessionCommandSession } from '../hosted-session-command-session.js';
import type { HostedSessionMessageSession } from '../hosted-session-message-session.js';
import type { SessionSuspension } from '../hosted-session-suspension.js';
import type { HostedSkillCatalog } from '../hosted-skill-catalog.js';
import type { HostedTeamSession } from '../hosted-team-session.js';
import type {
  HostedApprovalSettings,
  HostedApprovalWaiters,
} from '../hosted-tool-approval.js';
import type { HostedCleanupHold } from '../hosted-turn-cleanup.js';
import type {
  HostedShellTurnOptions,
  HostedWorkspaceToolProfile,
} from '../hosted-workspace-tool-turn.js';
import type { HostedEventIngest } from './event-ingest.js';

export interface HostedSession {
  placement?: HostedHarnessPlacement;
  poolAccepting?: () => boolean;
  /**
   * The idle-suspension state shared with the route-level registry. The
   * registry entry outlives this resident when a teardown's outcome is
   * uncertain; this field is only the resident's handle to it.
   */
  suspension?: SessionSuspension;
  ownershipRelease?: {
    operationId: string;
    proof?: HostedHarnessReleaseReceipt['commitProof'];
    result?: Promise<HostedHarnessReleaseReceipt>;
  };
  compression?: HostedContextCompression;
  streamOwner: { bootId: string; eventEpoch: string };
  managed: ManagedSession;
  storeBaseUrl: string;
  definition: Record<string, unknown> | null;
  agentDefinition?: HostedAgentDefinition;
  modelConfigDigest?: string;
  modelConfig?: HostedModelConfigReader;
  memoryStoreId?: string;
  memory?: HostedMemorySession;
  sessionSkillsRef?: ManagedSessionDurableRef;
  skills?: HostedSkillCatalog;
  baseSkills?: HostedSkillCatalog;
  extensions?: HostedExtensionSession;
  extensionBundle?: ManagedExtensionEffectiveBundle;
  extensionPackages?: readonly HostedExtensionPackage[];
  extensionContext?: string;
  publicChildExtensionAgent?: HostedChildExtensionAgent;
  initialSelection?: ManagedExtensionApplyCommand;
  extensionBootstrapPending?: boolean;
  extensionAgentPins?: ManagedExtensionApplyCommand['extensions'];
  extensionAgentTools?: readonly string[];
  extensionAgentPrompt?: string;
  clientId: string;
  cwd: string;
  streams: Set<() => void>;
  /** Event-ingest pushers by prompt; each also stops through `streams`. */
  eventIngests?: Map<string, HostedEventIngest>;
  active?: { promptId: string; digest: string; abort: AbortController };
  deadlineTimer?: NodeJS.Timeout;
  admissions: Map<string, { digest: string; lastEventId: number }>;
  blocked: boolean;
  /** #13800 D4: the named store failure kept in memory once a settlement's
   * own journal write could not commit — surfaced via /session/:id/status
   * until the block clears. Only `managed_session_store_unavailable` goes
   * here; other recovery blocks keep naming themselves at the caller. */
  recoveryReason?: string;
  /** Original prompt parked by a Broker that has yet to adopt its Runtime. */
  runtimeRecoveryPromptId?: string;
  /** The one A6 block whose pre-aborted managed cancel can still settle. */
  recoveryCancelPromptId?: string;
  toolProfile?: HostedWorkspaceToolProfile | typeof HOSTED_MCP_PROFILE;
  foregroundOnly?: boolean;
  publicChildAgentsVersion?: 1;
  publicChildModelRoute?: PublicChildModelRoute;
  publicChildLaunchEnabled?: boolean;
  publication?: { owner: HttpToolPublicationOwner; captureBytes: number };
  shell?: HostedShellTurnOptions;
  // The record funnel of a publication-mode turn's background Shells and
  // Monitors. Captures of the detached family belong to this Session's
  // record store, never to the Runtime's publication, so the lane exists
  // in publication mode exactly like `shell` does without capture bytes.
  backgroundLane?: HostedShellTurnOptions;
  mcp?: HostedMcpSession;
  clientFiles?: HostedClientFilesSession;
  hooks?: HostedHookSession;
  childRuns?: HostedChildRunSession;
  monitors?: HostedMonitorSession;
  /** H6: the Session's automation definitions and runs, on every profile. */
  automations?: HostedAutomationSession;
  /** Self-paced /loop wakeups: the Session's single unfired loop input. */
  loops?: HostedLoopSession;
  /** Fixed-interval /loop: the cron trio over the internal automation routes. */
  crons?: HostedCronSession;
  /** The active turn's permission classifier, adapted for loop arming; the
   * model turn refreshes it so a wakeup is vetted by the same classifier
   * that vets the turn's other side-effectful tools. */
  loopClassify?: HostedLoopClassifier;
  childAgents?: HostedChildAgentSession;
  /** H4d-b: the Session's messages along its lineage, beside its children. */
  messages?: HostedSessionMessageSession;
  /** H4e-b3: the Session's commands to its parent, on the same chain. */
  commands?: HostedSessionCommandSession;
  /** H4d-b: message operations past the closing check, which a close waits
   * out before it cancels the pending inputs. */
  messageOperations?: Set<Promise<void>>;
  /** H4f × H4d-b: the Session's run was stopped; no message input of it
   * starts a turn any more. */
  messagesStopped?: boolean;
  /** H4e-b1: the lead's team funnel, beside its child orchestrator. */
  teams?: HostedTeamSession;
  /** H4e-b3 decisions 5/9: this run's first input carried an unescaped
   * plan-mode preamble, so its tool calls admit reads only. */
  memberPlanMode?: boolean;
  /**
   * #13753 I2: the control plane serves child Workspaces, so the Agent
   * tool admits `isolation: "worktree"`. It describes the host, not the
   * Session: every create or load restates it and nothing persists it.
   */
  childWorkspaces?: boolean;
  /**
   * #13753 I3: the control plane also serves read-only snapshots, so the
   * Agent tool admits `isolation: "snapshot"`. Like `childWorkspaces`, it
   * describes the host and counts only beside it.
   */
  childSnapshots?: boolean;
  /** Depth of this Session in its child tree; absent or 0 is the root. */
  childDepth?: number;
  /** Tool-arm results answered by a turn; flushed at that turn's settle. */
  readonly childConsumption: Set<string>;
  /** H5: the Session's channel routes and deliveries, on every profile. */
  channels?: HostedChannelSession;
  /** Pending channel reply-plan retries; live work that blocks suspension. */
  replyPlanRetries?: Map<string, ReturnType<typeof setTimeout>>;
  /** One-shot flag: the first MCP readiness of this load was measured. */
  mcpReadyMeasured?: boolean;
  hooksBusy?: boolean;
  mcpBusy?: boolean;
  mcpClosing?: boolean;
  mcpRecovering: number;
  approval?: HostedApprovalSettings;
  waiters: HostedApprovalWaiters;
  stores?: HttpManagedSessionStores;
  storeDescriptor: ReturnType<typeof parseBridgeManagedSessionStore>;
  lifecycle?: ManagedSessionLifecycleAuthority;
  lifecycleKind?: 'close' | 'delete';
  cleanupBlocked?: boolean;
  cleanupHolds?: Map<string, HostedCleanupHold>;
  cleanupRetry?: Promise<void>;
  recoveryCleanupOnly?: boolean;
  lifecycleProtocolVersion?: 1 | 2;
  /** Fetched Workspace instructions; undefined until the first fetch. */
  workspaceContext?: string;
  monitorWake?: HostedMonitorWakeScheduler;
  /** The shared aftermath of a wake turn that died inside its attempt:
   * settles its run, its parked Runtime executions and the consume write,
   * retry-safe across passes. Wired where the wake pump is installed, so
   * the pump's recovery branch, its blocked retry and the reconcile route
   * all run the same one — serialized per Session behind its own guard. */
  wakeAftermath?: (turnId: string) => Promise<'settled' | 'pending'>;
  /** A recovery load acquired the Runtime Session for this promptId. On
   * the cancellation path, only the terminal success route and session
   * teardown hand it back; retry-inviting refusals deliberately leave it
   * owed, because a release persists RELEASED forever while a stranded
   * READY lease is re-admitted against the current checkpoint or
   * re-acquired idempotently. The continuation route keeps its #13083
   * handback discipline (a recorded follow-up). */
  runtimeLeaseHeld?: { promptId: string; runtimeSessionId: string };
  /** Distinguishes a lease a terminal route already owes the Broker (its
   * handback was attempted and failed — retried by a settled /prompt, a
   * cancel replay, or close) from one a passive takeover merely adopted:
   * releasing an adopted lease from an unrelated route persists RELEASED
   * and wedges every later takeover on runtime_session_not_acquirable. */
  runtimeLeaseOwedByTerminalRoute?: boolean;
  /** A takeover load registered this Session with its recovered Turn still
   * owned by the client: /status reports it in flight and /prompt refuses a
   * fresh Turn until continue/cancel drives it to a terminal record. Never
   * alias this to active/blocked — both refuse the continue/cancel routes. */
  recoveredTurn?: string;
  /** Executions a cancel drive accepted on the Broker's terminal fence
   * alone, keyed by the recovered Turn they were counted for. A retried
   * cancel is a fresh request whose stop re-reads the Broker, and a record
   * reclaimed between attempts then certifies as already-stopped — the
   * honest unobservable outcome has to survive across attempts or the
   * retry journals a cancellation nobody witnessed. An entry clears when
   * that Turn's terminal record lands. */
  recoveryUnobserved?: Map<string, Set<string>>;
  /** The settled Turn's file-history retirement failed after the terminal
   * record landed; the next settled /prompt or close retires it. */
  fileHistoryOwed?: string;
  /** #13856: two key kinds coexist in this set, both strings. The
   * in-process hold sites add promptIds of turns whose Runtime Session
   * ended held by a live background run (the designed hold — the broker
   * refused the routine release with `runtime_session_held` and stopped
   * nothing); the load additionally restores Runtime Session ids from the
   * Broker's durable hold rows (#13930 R1-2), which never passed through a
   * refused release. The Session's close drain-releases each; a later turn
   * never re-uses the id, so a held Runtime is owed exactly until the
   * close. `hostedRuntimeSessionId` is idempotent, so the close's drain
   * maps either kind back to itself. */
  readonly heldRuntimeTurns: Set<string>;
}

export interface HostedHarnessSessionOptions {
  idleSuspendMs?: number;
  suspendRetryBaseMs?: number;
  suspendRetryCap?: number;
  suspendReconcileMs?: number;
  coldOpenLimit?: number;
  sseAdmissionCaps?: SseAdmissionCaps;
  daemonLog?: DaemonLogger;
}

export interface HostedSessionOpenings {
  inFlight: Set<string>;
  unresolved: Set<string>;
  reconciliations: number;
}

export interface HostedSuspensionStats {
  cleanSuspensions: number;
  revertedAttempts: number;
  eligibilityFailures: number;
  blockedTeardowns: number;
  reconciledGates: number;
  openBusyRefusals: number;
  coldOpens: number;
  coldOpenTotalMs: number;
  coldOpenStoreMs: number;
  mcpReadyMs: number;
  /** Per suspension attempt over a waiting Turn that could not park. */
  parkRefusals: Partial<Record<HostedActionParkRefusal, number>>;
}
