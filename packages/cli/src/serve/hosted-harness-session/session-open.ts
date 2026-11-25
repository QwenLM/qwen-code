/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Part } from '@google/genai';
import { parseBridgeManagedSessionStore } from '@qwen-code/acp-bridge/bridgeTypes';
import { extensionInstructionText } from '@qwen-code/qwen-code-core/extension/managed-skill-content.js';
import type { HostedHarnessPlacement } from '@qwen-code/qwen-code-core/managed-runtime/hosted-harness-release.js';
import {
  createHttpManagedSessionStores,
  type ManagedSessionLifecycleAuthority,
  ManagedSessionStoreHttpError,
} from '@qwen-code/qwen-code-core/managed-runtime/http-managed-session-store.js';
import {
  parsePublicChildModelRoute,
  type PublicChildModelRoute,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-child-operations.js';
import { isManagedExtensionConfig } from '@qwen-code/qwen-code-core/managed-runtime/managed-config-install.js';
import { enableManagedExecutionDiagnostics } from '@qwen-code/qwen-code-core/managed-runtime/managed-execution-diagnostics.js';
import { readManagedExtensionContributions } from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-contributions.js';
import {
  type ManagedExtensionApplyCommand,
  parseManagedExtensionApplyCommand,
  parseManagedExtensionEffectiveBundle,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-extension-package.js';
import type { ManagedHookCatalogPin } from '@qwen-code/qwen-code-core/managed-runtime/managed-hook-protocol.js';
import { MANAGED_MCP_MAX_CONNECTIONS } from '@qwen-code/qwen-code-core/managed-runtime/managed-mcp-protocol.js';
import {
  type ManagedSession,
  ManagedSessionCloseError,
  openManagedSession,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-assembly.js';
import {
  ManagedSessionAlreadyExistsError,
  ManagedSessionNotFoundError,
} from '@qwen-code/qwen-code-core/managed-runtime/managed-session-authority.js';
import { enableManagedSessionDiagnostics } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-diagnostics.js';
import type { ManagedSessionDurableRef } from '@qwen-code/qwen-code-core/managed-runtime/managed-session-records.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import type { Application, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  sanitizeDaemonLogLine,
  writeStderrLineSafe,
} from '../../utils/stdioHelpers.js';
import {
  hostedApprovalResumeShapeRefusal,
  hostedCommandStepResumeShapeRefusal,
} from '../hosted-action-parking.js';
import {
  type HostedAgentDefinition,
  HostedModelUnavailableError,
  parseHostedAgentDefinition,
  readHostedAgentInstructions,
  sameHostedAgentDefinition,
} from '../hosted-agent-definition.js';
import {
  findHostedApprovalContinuation,
  HostedPublicChildRecoveryProfileChanged,
  type RestoredHostedApprovalContinuation,
} from '../hosted-approval-continuation.js';
import { readHostedTurnApprovalSelection } from '../hosted-approval-selection.js';
import {
  createHostedAutomationGateRelease,
  createHostedAutomationGateRunner,
  type HostedAutomationGateRunnerOptions,
} from '../hosted-automation-gate.js';
import { HostedAutomationSession } from '../hosted-automation-session.js';
import { reattachAndDrainBackgroundDeliveries } from '../hosted-background-delivery-recovery.js';
import { HostedChannelSession } from '../hosted-channel-session.js';
import { HostedChildAgentSession } from '../hosted-child-agent-session.js';
import { HostedChildRunSession } from '../hosted-child-run-session.js';
import { HostedCronSession } from '../hosted-cron-session.js';
import {
  type HostedChildExtensionAgent,
  hostedChildExtensionApplyCommand,
  parseHostedChildExtensionAgent,
} from '../hosted-extension-agent.js';
import { HostedExtensionRecoveryRequired } from '../hosted-extension-session.js';
import {
  canSettleHostedFileHistory,
  dropPendingHostedFileHistoryTurn,
  HOSTED_UUID,
  type HostedFileHistorySettlement,
  readHostedFileHistory,
} from '../hosted-file-history.js';
import type { HostedHarnessContract } from '../hosted-harness-contract.js';
import {
  type HostedHarnessInstance,
  parseHostedHarnessPlacement,
} from '../hosted-harness-instance.js';
import { createHostedLoopFireClassifier } from '../hosted-harness-model.js';
import {
  hostedConfigScopedOwnerId,
  HostedHookSession,
  parseHostedHookPin,
} from '../hosted-hook-session.js';
import { HostedLoopSession } from '../hosted-loop-session.js';
import {
  HOSTED_MCP_PROFILE,
  type HostedMcpServerPin,
  HostedMcpSession,
  parseHostedMcpServers,
} from '../hosted-mcp-session.js';
import {
  readHostedMcpSettings,
  validateHostedMcpHistory,
} from '../hosted-mcp-settings.js';
import {
  findHostedMemoryResults,
  HostedMemorySession,
  parseHostedMemoryStoreId,
} from '../hosted-memory-session.js';
import {
  parseHostedModelConfig,
  parseHostedModelConfigDigest,
} from '../hosted-model-config.js';
import {
  findHostedCommittedModelOutput,
  findHostedModelRequest,
  type HostedModelRequest,
} from '../hosted-model-recovery.js';
import { HostedMonitorSession } from '../hosted-monitor-session.js';
import { reconcileNeverStartedChildRuns } from '../hosted-never-started-reconcile.js';
import { inspectHostedRecovery } from '../hosted-recovery-status.js';
import {
  answerResumedTurnCalls,
  HostedRecoveryQuiescingError,
  type HostedRuntimeRecoveryReport,
  isDurableBlockedVerdict,
  recoverHostedRuntimeTurn,
} from '../hosted-runtime-recovery.js';
import { HostedSessionCommandSession } from '../hosted-session-command-session.js';
import { HostedSessionMessageSession } from '../hosted-session-message-session.js';
import {
  admitSuspensionWork,
  HOSTED_COLD_OPEN_LIMIT,
  releaseSuspensionWork,
  suspensionRefusalCode,
} from '../hosted-session-suspension.js';
import {
  HostedSkillCatalog,
  parseSessionSkillsRef,
  readHostedSkills,
  sameSessionSkillsRef,
} from '../hosted-skill-catalog.js';
import { HostedTeamSession } from '../hosted-team-session.js';
import {
  hostedApprovalDefinition,
  HostedApprovalWaiters,
  parseHostedApprovalSettings,
  readHostedApprovalDefinition,
} from '../hosted-tool-approval.js';
import { hasHostedCleanupDebt } from '../hosted-turn-cleanup.js';
import {
  HostedWorkspaceBroker,
  type HostedWorkspaceBrokerOptions,
} from '../hosted-workspace-broker.js';
import {
  hasHostedExternalExcludedOptions,
  HOSTED_WORKSPACE_EXTERNAL_FILES_PROFILE,
  HOSTED_WORKSPACE_EXTERNAL_SHELL_PROFILE,
  HOSTED_WORKSPACE_FILE_PROFILE_V3,
  HOSTED_WORKSPACE_SHELL_PROFILE_V3,
  HOSTED_WORKSPACE_SHELL_PROFILE_V4,
  hostedShellLaneAttachesChildAgents,
  isHostedWorkspaceExternalProfile,
  isHostedWorkspaceExternalShellProfile,
  isHostedWorkspacePublicShellProfile,
  isHostedWorkspaceReadProfile,
} from '../hosted-workspace-profiles.js';
import {
  HOSTED_WORKSPACE_FILE_PROFILE,
  HostedToolRecoveryRequiredError,
  isHostedWorkspaceProfile,
  isHostedWorkspaceShellProfile,
  isRetryableWorkspaceAcquisition,
} from '../hosted-workspace-tool-turn.js';
import {
  extensionBootstrapIncomplete,
  type HostedExtensionsManager,
  selectExtensionCatalog,
} from './configuration-routes.js';
import { stopPublicChildSource } from './interaction-routes.js';
import { compressionBusy, compressionFor } from './lifecycle-routes.js';
import {
  blockRecovery,
  type HostedRuntimeOwnership,
  liftRecoveryBlock,
  retryHostedCleanup,
} from './runtime-ownership.js';
import {
  error,
  identity,
  isLifecycleFenceRemoteCode,
  lifecycleAuthority,
  namedStoreFailure,
  object,
  ordinaryAuthorizationError,
  recoveryDeclined,
} from './session-http.js';
import type {
  HostedHarnessSessionOptions,
  HostedSession,
  HostedSessionOpenings,
  HostedSuspensionStats,
} from './session-state.js';
import type { HostedSessionSuspension } from './session-suspension.js';
import {
  parkNeedsNoRuntimeSettlement,
  runSettleProjection,
  settleCancelledHarnessTurn,
  settleCancelledHookTurn,
  settleProjectablePromptId,
} from './turn-cancellation.js';
import { hostedOriginalPromptText, startHostedRecoveredTurn } from './turn.js';
import {
  hasUnsettledInput,
  isPumpOwnedToolTurn,
  isWakeOwnedInput,
  unsettledInputs,
  unsettledInputsThrough,
  unsettledPromptId,
} from './wake-recovery.js';
import { installHostedWakeScheduler } from './wake-scheduler.js';
import {
  recoverShellReceipts,
  verifyWorkspaceRestore,
} from './workspace-restore.js';

const debugLogger = createDebugLogger('HOSTED_HARNESS_SESSION');

/** A Session's gate runner and the release for probes it no longer asks. */
function gateOptions(options: HostedAutomationGateRunnerOptions): {
  gate: ReturnType<typeof createHostedAutomationGateRunner>;
  releaseGate: ReturnType<typeof createHostedAutomationGateRelease>;
} {
  // One memory of started probes for both, so the release of a revision
  // that went stale can ask about a probe the runner started.
  const shared = { ...options, startedProbes: new Map<string, string>() };
  return {
    gate: createHostedAutomationGateRunner(shared),
    releaseGate: createHostedAutomationGateRelease(shared),
  };
}

export function registerHostedSessionOpenRoutes({
  app,
  sessions,
  openings,
  contract,
  cwd,
  brokerOptions,
  instance,
  options,
  epoch,
  acceptingWork,
  suspensionStats,
  suspension,
  ownership,
  extensionsManager,
}: {
  app: Application;
  sessions: Map<string, HostedSession>;
  openings: HostedSessionOpenings;
  contract: HostedHarnessContract;
  cwd: string;
  brokerOptions: HostedWorkspaceBrokerOptions | undefined;
  instance: HostedHarnessInstance | undefined;
  options: HostedHarnessSessionOptions | undefined;
  epoch: string;
  acceptingWork: () => boolean;
  suspensionStats: HostedSuspensionStats;
  suspension: Pick<
    HostedSessionSuspension,
    'suspensions' | 'dropSuspension' | 'armFor' | 'noteActivity'
  >;
  ownership: Pick<
    HostedRuntimeOwnership,
    | 'refusedAdoptions'
    | 'noteOwedAdoption'
    | 'releaseHeldRuntime'
    | 'cleanupOriginalRecovery'
  >;
  extensionsManager: HostedExtensionsManager;
}): void {
  const { suspensions, dropSuspension, armFor, noteActivity } = suspension;
  const {
    refusedAdoptions,
    noteOwedAdoption,
    releaseHeldRuntime,
    cleanupOriginalRecovery,
  } = ownership;
  // Cold-open admission: suspension turns steady-state work into bursts of
  // journal restores and MCP reinstalls, so the instance caps how many run
  // at once (the design's candidate constant). The slot is held from the
  // restore until the open completes, released by the route's finally.
  const coldOpenLimit = options?.coldOpenLimit ?? HOSTED_COLD_OPEN_LIMIT;
  let coldOpensInFlight = 0;

  const releaseColdOpenSlot = (res: Response): void => {
    if (!res.locals['coldOpenSlot']) return;
    res.locals['coldOpenSlot'] = false;
    coldOpensInFlight -= 1;
    const totalMs = Date.now() - (res.locals['coldOpenStart'] as number);
    const storeMs = (res.locals['coldOpenStoreMs'] as number | undefined) ?? 0;
    suspensionStats.coldOpens += 1;
    suspensionStats.coldOpenTotalMs += totalMs;
    suspensionStats.coldOpenStoreMs += storeMs;
  };

  // E2E fault injection only (QWEN_E2E_DROP_LOAD_REPLY=<sessionId>, set by the
  // packaged load-reply-lost arm on the replacement Harness): lose exactly the
  // first load attach reply for that Session, after its driver has started, so
  // the control plane must redrive the same load into the now-active driver.
  // The flag is never set in production.
  const dropLoadReplySession = process.env['QWEN_E2E_DROP_LOAD_REPLY'];
  let loadReplyDropped = false;

  const sendAttachment = (
    res: Response,
    sessionId: string,
    session: HostedSession,
    recovery?: HostedRuntimeRecoveryReport,
  ): void => {
    if (dropLoadReplySession === sessionId && !loadReplyDropped) {
      loadReplyDropped = true;
      writeStderrLineSafe(
        `qwen serve: E2E dropping first load reply for Session ${sessionId}`,
      );
      res.destroy();
      return;
    }
    // A completed load is activity even when it reuses a resident: the load
    // route is registered before the session middleware, so resident-reuse
    // replies never reach the middleware's noteActivity. Reset the idle
    // clock here so every attachment response (create, cold load, resident
    // reuse) earns a full residency period.
    noteActivity(sessionId);
    res.status(200).json({
      sessionId,
      clientId: session.clientId,
      workspaceCwd: session.cwd,
      lastEventId: session.managed.authority.committedSequence,
      eventEpoch: epoch,
      // A Harness older than approvals omits this, so a caller can tell.
      ...(session.approval ? { approvalMode: session.approval.mode } : {}),
      ...(session.recoveryCleanupOnly ? { recoveryCleanupOnly: true } : {}),
      ...(session.blocked || session.hooks?.hasPendingOperations
        ? { recoveryRequired: true }
        : {}),
      ...(recovery
        ? { _meta: { 'qwen.daemon.managedRuntimeRecovery': recovery } }
        : {}),
    });
  };

  const answerResidentInapplicable = async (
    res: Response,
    sessionId: string,
    resident: HostedSession,
    promptId: string,
  ): Promise<void> => {
    const authorization =
      await resident.managed.authority.harnessRunAuthorization();
    const approvalPending =
      authorization.status === 'runnable' &&
      authorization.checkpoint.approval?.state === 'requested';
    const settle = approvalPending
      ? null
      : await settleProjectablePromptId(
          resident.managed,
          resident,
          await readHostedFileHistory(resident.managed),
          promptId,
        );
    if (!approvalPending && settle === null) {
      noteOwedAdoption(resident, sessionId);
      writeStderrLineSafe(
        `qwen serve: Hosted Session ${sessionId} redrive refused (takeover_inapplicable_unpayable): prompt=${promptId}`,
      );
      error(res, 409, 'hosted_turn_recovery_required', 'takeover_unrecovered');
      return;
    }
    if (sessions.get(sessionId) !== resident) {
      noteOwedAdoption(resident, sessionId);
      error(res, 404, 'hosted_session_not_found');
      return;
    }
    if (resident.mcpClosing) {
      noteOwedAdoption(resident, sessionId);
      error(res, 409, 'hosted_session_closing');
      return;
    }
    if (resident.active !== undefined) {
      noteOwedAdoption(resident, sessionId);
      error(res, 409, 'hosted_turn_active');
      return;
    }
    refusedAdoptions.delete(sessionId);
    liftRecoveryBlock(resident);
    // The projection owes the terminal record and holds the busy flag until
    // it lands; the undriven marker's guard ends with the park's payability
    // — the first load's bare branch arms no marker on this arm either.
    if (settle !== null) resident.recoveredTurn = undefined;
    sendAttachment(res, sessionId, resident);
    if (settle !== null)
      runSettleProjection(resident, sessionId, settle, brokerOptions);
  };

  const cancellationTargetState = (
    managed: ManagedSession,
    promptId: string,
  ): 'pending' | 'settled' | undefined => {
    const events = managed.authority.eventsInSequenceRange(
      1,
      managed.authority.committedSequence,
    );
    if (
      !events.some(
        (event) =>
          event.kind === 'input.accepted' &&
          event.payload['turnId'] === promptId,
      )
    )
      return undefined;
    if (
      !events.some(
        (event) =>
          event.kind === 'turn.settled' && event.payload['turnId'] === promptId,
      )
    )
      return 'pending';
    return events.findLast((event) => event.kind === 'input.accepted')?.payload[
      'turnId'
    ] === promptId
      ? 'settled'
      : undefined;
  };

  const open = async (
    req: Request,
    res: Response,
    create: boolean,
    holdCancellation?: (session: HostedSession) => void,
  ): Promise<void> => {
    const body = object(req.body);
    const requestedProfile =
      body?.['toolProfile'] ??
      (!create ? sessions.get(req.params['id']!)?.toolProfile : undefined);
    if (
      requestedProfile === HOSTED_WORKSPACE_EXTERNAL_FILES_PROFILE &&
      (!contract.features?.includes(HOSTED_WORKSPACE_EXTERNAL_FILES_PROFILE) ||
        contract.lifecycleProtocolVersion !== 1 ||
        hasHostedExternalExcludedOptions(body, requestedProfile))
    )
      return error(res, 400, 'hosted_tool_profile_unavailable');
    if (
      isHostedWorkspaceExternalShellProfile(requestedProfile) &&
      (!contract.features?.includes(HOSTED_WORKSPACE_EXTERNAL_SHELL_PROFILE) ||
        contract.lifecycleProtocolVersion !== 1 ||
        hasHostedExternalExcludedOptions(body, requestedProfile))
    )
      return error(res, 400, 'hosted_tool_profile_unavailable');
    let cleanupPromptId = body?.['recoveryCleanupPromptId'];
    const cancellationPromptId = body?.['cancellationPromptId'];
    if (
      cancellationPromptId !== undefined &&
      (create ||
        typeof cancellationPromptId !== 'string' ||
        !HOSTED_UUID.test(cancellationPromptId) ||
        body?.['cancellationTakeover'] !== true ||
        body?.['passiveManagedRuntimeRecovery'] !== true ||
        body?.['driveRuntimeRecovery'] === true ||
        cleanupPromptId !== undefined ||
        body?.['lifecycleAuthority'] !== undefined)
    ) {
      error(res, 400, 'invalid_managed_runtime_recovery');
      return;
    }
    if (
      cleanupPromptId !== undefined &&
      (create ||
        typeof cleanupPromptId !== 'string' ||
        !HOSTED_UUID.test(cleanupPromptId) ||
        body?.['driveRuntimeRecovery'] === true ||
        body?.['passiveManagedRuntimeRecovery'] === true ||
        body?.['cancellationTakeover'] === true ||
        body?.['lifecycleAuthority'] !== undefined)
    ) {
      error(res, 400, 'invalid_managed_runtime_recovery');
      return;
    }
    const sessionId = create ? body?.['sessionId'] : req.params['id'];
    // The suspension gate covers every open() path — create, ordinary,
    // passive, driven recovery, MCP-management — before any resident
    // reuse or writer acquisition. The load route is registered before
    // the session middleware, so the middleware alone cannot gate it.
    if (typeof sessionId === 'string') {
      const gated = suspensions.get(sessionId);
      const refusal = gated ? suspensionRefusalCode(gated) : undefined;
      if (refusal) return error(res, 409, refusal);
    }
    let agentDefinition: HostedAgentDefinition | undefined;
    let modelConfigDigest: string | undefined;
    let memoryStoreId: string | undefined;
    let sessionSkillsRef: ManagedSessionDurableRef | undefined;
    try {
      modelConfigDigest = parseHostedModelConfigDigest(
        body?.['modelConfigDigest'],
      );
      memoryStoreId = parseHostedMemoryStoreId(body?.['memoryStoreId']);
      sessionSkillsRef = parseSessionSkillsRef(body?.['sessionSkillsRef']);
      agentDefinition = parseHostedAgentDefinition(
        body?.['agentDefinition'],
        create,
      );
    } catch {
      error(res, 400, 'invalid_hosted_agent_definition');
      return;
    }
    let toolProfile = body?.['toolProfile'];
    let captureBytes = body?.['captureBytes'];
    const publicChildAgentsVersion = body?.['publicChildAgentsVersion'] ?? 0;
    let publicChildModelRoute: PublicChildModelRoute | undefined;
    let publicChildExtensionAgent: HostedChildExtensionAgent | undefined;
    let initialSelection: ManagedExtensionApplyCommand | undefined;
    try {
      if (body?.['initialSelection'] !== undefined) {
        initialSelection = parseManagedExtensionApplyCommand(
          body['initialSelection'],
        );
        if (
          initialSelection.expectedRevision !== 0 ||
          initialSelection.mcpChange
        )
          throw new Error('Invalid initial extension selection.');
      }
      publicChildExtensionAgent = parseHostedChildExtensionAgent(
        body?.['publicChildExtensionAgent'],
      );
      if (publicChildExtensionAgent && initialSelection)
        throw new Error('Child and creation extension bindings conflict.');
      publicChildModelRoute =
        body?.['publicChildModelRoute'] === undefined
          ? undefined
          : parsePublicChildModelRoute(body['publicChildModelRoute']);
      if (
        publicChildModelRoute &&
        (publicChildAgentsVersion !== 1 || (!body?.['lineage'] && create))
      )
        throw new Error('A model route belongs only to a public child.');
      if (
        publicChildExtensionAgent &&
        (!publicChildModelRoute || (create && !body?.['lineage']))
      )
        throw new Error('An extension agent belongs only to a public child.');
    } catch {
      return error(res, 400, 'invalid_public_child_model_route');
    }
    if (publicChildAgentsVersion !== 0 && publicChildAgentsVersion !== 1) {
      error(res, 400, 'invalid_public_child_agents_version');
      return;
    }
    const extensionChildProfile =
      contract.features?.includes('session-extension-packages/1') === true &&
      (contract.lifecycleV2Profiles?.includes('hosted-workspace-shell/1') ||
        contract.lifecycleV2Profiles?.includes(
          HOSTED_WORKSPACE_SHELL_PROFILE_V3,
        ) ||
        contract.lifecycleV2Profiles?.includes('hosted-workspace-shell/4'));
    if (
      publicChildAgentsVersion === 1 &&
      (!isHostedWorkspacePublicShellProfile(toolProfile) ||
        body?.['foregroundOnly'] === true ||
        (!extensionChildProfile &&
          (body?.['mcpServers'] !== undefined ||
            body?.['hookCatalog'] !== undefined ||
            agentDefinition !== undefined)) ||
        body?.['childWorkspaces'] === true ||
        body?.['childSnapshots'] === true)
    ) {
      error(res, 400, 'hosted_tool_profile_unavailable');
      return;
    }
    const requestedForegroundOnly = body?.['foregroundOnly'];
    let foregroundOnly = requestedForegroundOnly === true;
    if (
      requestedForegroundOnly !== undefined &&
      typeof requestedForegroundOnly !== 'boolean'
    ) {
      error(res, 400, 'invalid_hosted_foreground_only');
      return;
    }
    if (
      foregroundOnly &&
      ((toolProfile !== undefined &&
        toolProfile !== HOSTED_WORKSPACE_FILE_PROFILE &&
        toolProfile !== HOSTED_WORKSPACE_EXTERNAL_FILES_PROFILE &&
        !isHostedWorkspaceExternalShellProfile(toolProfile) &&
        toolProfile !== 'hosted-workspace-shell/1') ||
        (create && toolProfile === undefined) ||
        body?.['mcpServers'] !== undefined ||
        body?.['hookCatalog'] !== undefined ||
        body?.['childWorkspaces'] === true ||
        body?.['lineage'] !== undefined)
    ) {
      error(res, 400, 'hosted_tool_profile_unavailable');
      return;
    }
    if (
      ((agentDefinition?.skillsRef !== undefined ||
        sessionSkillsRef !== undefined) &&
        ((create && !toolProfile) || !brokerOptions)) ||
      (toolProfile !== undefined &&
        ((!isHostedWorkspaceProfile(toolProfile) &&
          toolProfile !== HOSTED_MCP_PROFILE) ||
          !brokerOptions))
    ) {
      error(res, 400, 'hosted_tool_profile_unavailable');
      return;
    }
    let mcpServers: readonly HostedMcpServerPin[] | undefined;
    let hookCatalog: ManagedHookCatalogPin | undefined;
    try {
      if (body?.['hookCatalog'] !== undefined) {
        if (!brokerOptions || (create && !toolProfile))
          throw new Error('Hooks require a Hosted Workspace profile.');
        hookCatalog = parseHostedHookPin(body['hookCatalog']);
      }
    } catch {
      error(res, 400, 'invalid_hosted_hook_catalog');
      return;
    }
    try {
      if (
        toolProfile === HOSTED_MCP_PROFILE &&
        (create ||
          body?.['lifecycleAuthority'] === undefined ||
          body?.['mcpServers'] !== undefined)
      )
        mcpServers = parseHostedMcpServers(body?.['mcpServers']);
      else if (body?.['mcpServers'] !== undefined) {
        if (
          !isHostedWorkspacePublicShellProfile(toolProfile) ||
          !contract.lifecycleV2Profiles?.includes(toolProfile)
        )
          throw new Error('MCP requires a supported Workspace profile.');
        mcpServers = parseHostedMcpServers(body['mcpServers']);
      }
      if (
        create &&
        mcpServers &&
        mcpServers.length > MANAGED_MCP_MAX_CONNECTIONS
      )
        throw new Error('MCP server definitions exceed Runtime capacity.');
    } catch {
      error(res, 400, 'invalid_hosted_mcp_servers');
      return;
    }
    // The mode is pinned at creation, so a deployment's later mode affects
    // only new Sessions; a load uses the saved one.
    const approval =
      create && toolProfile !== undefined
        ? parseHostedApprovalSettings(
            body?.['approvalMode'],
            body?.['approvalTimeoutMs'],
          )
        : undefined;
    if (create && toolProfile !== undefined && !approval) {
      error(res, 400, 'invalid_hosted_approval');
      return;
    }
    if (
      isHostedWorkspaceShellProfile(toolProfile) &&
      captureBytes !== undefined &&
      (!Number.isSafeInteger(captureBytes) ||
        (captureBytes as number) < 1 ||
        (captureBytes as number) > 2 ** 41)
    ) {
      error(res, 400, 'hosted_shell_capture_capacity_required');
      return;
    }
    if (
      typeof sessionId !== 'string' ||
      !HOSTED_UUID.test(sessionId) ||
      (create && body?.['sessionScope'] !== 'thread')
    ) {
      error(res, 400, 'invalid_hosted_session');
      return;
    }
    let store;
    try {
      store = parseBridgeManagedSessionStore(body?.['managedSessionStore']);
    } catch (cause) {
      debugLogger.warn('managed session store descriptor rejected:', cause);
      error(
        res,
        400,
        'invalid_managed_session_store',
        undefined,
        cause instanceof Error ? cause.message : String(cause),
      );
      return;
    }
    if (store.writerId !== contract.bootId) {
      error(res, 409, 'hosted_harness_generation_mismatch');
      return;
    }
    let placement: HostedHarnessPlacement | undefined;
    try {
      if (instance) {
        placement = parseHostedHarnessPlacement(body?.['harnessPlacement']);
        if (
          placement.instanceId !== contract.instanceId ||
          placement.bootId !== contract.bootId ||
          store.allowInsecureHttp === true ||
          !store.writerToken
        )
          throw new Error('Harness placement does not name this owner.');
      } else if (body?.['harnessPlacement'] !== undefined) {
        throw new Error('Harness pool mode is not enabled.');
      }
    } catch {
      return error(res, 409, 'hosted_harness_placement_mismatch');
    }
    if (instance && !instance.accepting)
      return error(res, 409, 'hosted_harness_quiescing');
    let lifecycle: ManagedSessionLifecycleAuthority | undefined;
    try {
      lifecycle = lifecycleAuthority(body?.['lifecycleAuthority']);
      if (
        lifecycle &&
        (create ||
          (body?.['lifecycleProtocolVersion'] !== undefined &&
            body['lifecycleProtocolVersion'] !== 1 &&
            body['lifecycleProtocolVersion'] !== 2))
      )
        throw new Error('Invalid lifecycle load.');
    } catch {
      error(res, 400, 'invalid_hosted_lifecycle_authority');
      return;
    }
    const lifecycleProtocolVersion =
      body?.['lifecycleProtocolVersion'] === 2 ? 2 : 1;
    if (
      lifecycle &&
      (lifecycleProtocolVersion === 1
        ? toolProfile !== HOSTED_WORKSPACE_FILE_PROFILE &&
          !(
            isHostedWorkspaceExternalProfile(toolProfile) &&
            contract.lifecycleProtocolVersion === 1 &&
            contract.features?.includes(toolProfile as string)
          )
        : typeof toolProfile !== 'string' ||
          !contract.lifecycleV2Profiles?.includes(toolProfile))
    ) {
      return error(res, 409, 'hosted_lifecycle_profile_unavailable');
    }
    let resident = sessions.get(sessionId);
    if (resident && !isDeepStrictEqual(resident.placement, placement))
      return error(res, 409, 'hosted_harness_placement_mismatch');
    // H4f × H4d-b: the load of a stopped run's child carries the stop, so
    // its wake pump starts none of its message inputs, not even the first
    // pass this load kicks before the stop itself arrives.
    const stopMessages = body?.['stopMessages'] === true;
    const childWorkspaces = body?.['childWorkspaces'] === true;
    const childSnapshots = childWorkspaces && body?.['childSnapshots'] === true;
    if (
      resident &&
      requestedForegroundOnly !== undefined &&
      (resident.foregroundOnly === true) !== foregroundOnly
    ) {
      error(res, 409, 'hosted_tool_profile_conflict');
      return;
    }
    if (
      resident?.foregroundOnly &&
      (childWorkspaces ||
        mcpServers !== undefined ||
        hookCatalog !== undefined ||
        (toolProfile !== undefined &&
          toolProfile !== HOSTED_WORKSPACE_FILE_PROFILE &&
          toolProfile !== HOSTED_WORKSPACE_EXTERNAL_FILES_PROFILE &&
          !isHostedWorkspaceExternalShellProfile(toolProfile) &&
          toolProfile !== 'hosted-workspace-shell/1'))
    ) {
      error(res, 409, 'hosted_tool_profile_conflict');
      return;
    }
    if (
      resident &&
      ((!create &&
        !sameHostedAgentDefinition(
          resident.agentDefinition,
          agentDefinition,
        )) ||
        resident.modelConfigDigest !== modelConfigDigest ||
        resident.memoryStoreId !== memoryStoreId)
    ) {
      error(res, 409, 'hosted_agent_definition_conflict');
      return;
    }
    if (
      resident &&
      !create &&
      !sameSessionSkillsRef(resident.sessionSkillsRef, sessionSkillsRef)
    ) {
      error(res, 409, 'hosted_agent_definition_conflict');
      return;
    }
    const passiveRecovery = body?.['passiveManagedRuntimeRecovery'] === true;
    const driveRecovery = body?.['driveRuntimeRecovery'] === true;
    // Even a passive cold load may resume a model or pay cleanup debt.
    if (body?.['mcpManagementOnly'] === true) {
      if (
        create ||
        lifecycle ||
        passiveRecovery ||
        driveRecovery ||
        stopMessages ||
        body?.['cancellationTakeover'] === true ||
        cleanupPromptId !== undefined
      )
        return error(res, 400, 'invalid_mcp_management_attachment');
      if (!resident || resident.recoveryCleanupOnly)
        return error(res, 409, 'hosted_mcp_session_load_required');
      const key = resident.managed.authority.sessionHeader.sessionKey;
      if (
        key.tenantId !== store.tenantId ||
        key.workspaceId !== store.workspaceId
      )
        return error(res, 409, 'hosted_session_already_attached');
      if (resident.storeBaseUrl !== store.baseUrl)
        return error(res, 409, 'hosted_session_store_mismatch');
      const definition = resident.definition;
      if (
        ![
          'hosted-workspace-shell/1',
          HOSTED_WORKSPACE_SHELL_PROFILE_V3,
          'hosted-workspace-shell/4',
          HOSTED_MCP_PROFILE,
        ].includes(toolProfile as string) ||
        resident.foregroundOnly ||
        (resident.childDepth ?? 0) !== 0 ||
        definition?.['toolProfile'] !== toolProfile ||
        JSON.stringify(definition?.['mcpServers']) !==
          JSON.stringify(mcpServers) ||
        !isDeepStrictEqual(
          definition?.['hookCatalog'],
          hookCatalog ?? definition?.['hookCatalog'],
        ) ||
        (captureBytes !== undefined &&
          definition?.['captureBytes'] !== captureBytes)
      )
        return error(res, 409, 'hosted_tool_profile_conflict');
      if (resident.lifecycle || resident.mcpClosing)
        return error(res, 409, 'hosted_session_closing');
      const attachedSession = resident;
      await attachedSession.stores!.assertWritable().then(
        () => sendAttachment(res, sessionId, attachedSession),
        () => error(res, 503, 'managed_session_open_failed'),
      );
      return;
    }
    const takeoverFlags = passiveRecovery || driveRecovery;
    if (resident && typeof cancellationPromptId === 'string') {
      const key = resident.managed.authority.sessionHeader.sessionKey;
      const definition = resident.definition;
      if (
        key.tenantId !== store.tenantId ||
        key.workspaceId !== store.workspaceId ||
        resident.storeBaseUrl !== store.baseUrl ||
        (toolProfile !== undefined && toolProfile !== resident.toolProfile) ||
        JSON.stringify(definition?.['mcpServers']) !==
          JSON.stringify(mcpServers) ||
        !isDeepStrictEqual(
          definition?.['hookCatalog'],
          hookCatalog ?? definition?.['hookCatalog'],
        ) ||
        (isHostedWorkspaceShellProfile(resident.toolProfile) &&
          captureBytes !== undefined &&
          definition?.['captureBytes'] !== captureBytes) ||
        resident.lifecycle ||
        resident.mcpClosing ||
        openings.inFlight.has(sessionId)
      ) {
        error(res, 409, 'hosted_session_already_attached');
        return;
      }
      const target = cancellationTargetState(
        resident.managed,
        cancellationPromptId,
      );
      if (
        target === undefined ||
        (resident.active && resident.active.promptId !== cancellationPromptId)
      ) {
        error(res, 409, 'hosted_cancel_identity_mismatch');
        return;
      }
      if (
        target === 'settled' ||
        resident.active?.promptId === cancellationPromptId
      ) {
        sendAttachment(res, sessionId, resident);
        return;
      }
      if (
        resident.hooksBusy ||
        resident.mcpBusy ||
        resident.mcpRecovering ||
        unsettledPromptId(resident) !== cancellationPromptId
      ) {
        error(res, 409, 'hosted_turn_recovery_required');
        return;
      }
      resident.hooksBusy = true;
      holdCancellation?.(resident);
    }
    if (
      resident &&
      (cleanupPromptId !== undefined || resident.recoveryCleanupOnly)
    ) {
      const key = resident.managed.authority.sessionHeader.sessionKey;
      if (
        key.tenantId !== store.tenantId ||
        key.workspaceId !== store.workspaceId ||
        resident.storeBaseUrl !== store.baseUrl ||
        resident.active ||
        resident.hooksBusy ||
        resident.mcpBusy ||
        resident.mcpRecovering ||
        resident.mcpClosing ||
        openings.inFlight.has(sessionId)
      ) {
        error(res, 409, 'hosted_turn_recovery_required');
        return;
      }
      if (cleanupPromptId !== undefined) {
        const sequence = resident.managed.authority.committedSequence;
        const status = await inspectHostedRecovery(resident, cleanupPromptId);
        if (
          sessions.get(sessionId) !== resident ||
          openings.inFlight.has(sessionId) ||
          resident.managed.authority.committedSequence !== sequence ||
          resident.active ||
          resident.recoveredTurn ||
          resident.hooksBusy ||
          resident.mcpBusy ||
          resident.mcpRecovering ||
          resident.mcpClosing ||
          !status.inputSettled ||
          !status.continuationReady ||
          !['ready', 'cleanup_pending'].includes(status.state)
        ) {
          error(res, 409, 'hosted_turn_recovery_required');
          return;
        }
        resident.hooksBusy = true;
        try {
          await cleanupOriginalRecovery(resident, cleanupPromptId);
          sendAttachment(res, sessionId, resident);
        } catch {
          error(res, 503, 'hosted_turn_recovery_required');
        } finally {
          resident.hooksBusy = false;
        }
        return;
      }
      if (passiveRecovery) {
        if (
          (toolProfile !== undefined && toolProfile !== resident.toolProfile) ||
          mcpServers !== undefined ||
          hookCatalog !== undefined ||
          (isHostedWorkspaceShellProfile(resident.toolProfile) &&
            captureBytes !== undefined &&
            captureBytes !== resident.definition?.['captureBytes'])
        ) {
          error(res, 409, 'hosted_tool_profile_conflict');
          return;
        }
        sendAttachment(res, sessionId, resident);
        return;
      }
      openings.inFlight.add(sessionId);
      if (instance) openings.unresolved.add(sessionId);
      resident.mcpClosing = true;
      try {
        await resident.managed.close();
        await resident.stores!.close();
        for (const stop of resident.streams) stop();
        await resident.clientFiles?.close();
        resident.clientFiles = undefined;
        sessions.delete(sessionId);
        resident = undefined;
      } catch {
        if (!sessions.has(sessionId)) dropSuspension(sessionId);
        error(res, 503, 'hosted_turn_recovery_required');
        return;
      } finally {
        openings.inFlight.delete(sessionId);
      }
    }
    // H4b: a child Session arrives with its ancestry; the definition
    // document persists it so a later load answers the same depth.
    let lineage:
      | {
          parentSessionId: string;
          rootSessionId: string;
          parentChildRunId: string;
          depth: number;
        }
      | undefined;
    try {
      const rawLineage = body?.['lineage'];
      const value =
        rawLineage === undefined || rawLineage === null
          ? null
          : object(rawLineage);
      if (rawLineage !== undefined && rawLineage !== null && value === null)
        throw new Error('Invalid child lineage.');
      if (value) {
        const parentSessionId = value['parentSessionId'];
        const rootSessionId = value['rootSessionId'];
        const parentChildRunId = value['parentChildRunId'];
        const depth = value['depth'];
        if (
          !create ||
          typeof parentSessionId !== 'string' ||
          !HOSTED_UUID.test(parentSessionId) ||
          typeof rootSessionId !== 'string' ||
          !HOSTED_UUID.test(rootSessionId) ||
          typeof parentChildRunId !== 'string' ||
          parentChildRunId.length < 1 ||
          parentChildRunId.length > 128 ||
          !Number.isSafeInteger(depth) ||
          (depth as number) < 1 ||
          (depth as number) > 8
        )
          throw new Error('Invalid child lineage.');
        lineage = {
          parentSessionId,
          rootSessionId,
          parentChildRunId,
          depth: depth as number,
        };
      }
    } catch {
      error(res, 400, 'invalid_hosted_lineage');
      return;
    }
    if (resident !== undefined && lifecycle) {
      if (
        !isDeepStrictEqual(store, resident.storeDescriptor) ||
        toolProfile !== resident.toolProfile ||
        (mcpServers !== undefined &&
          !isDeepStrictEqual(
            mcpServers,
            resident.definition?.['mcpServers'],
          )) ||
        (hookCatalog !== undefined &&
          !isDeepStrictEqual(
            hookCatalog,
            resident.definition?.['hookCatalog'],
          )) ||
        (resident.lifecycle &&
          resident.lifecycle.operationId !== lifecycle.operationId)
      ) {
        error(res, 409, 'hosted_session_already_attached');
        return;
      }
      if (
        resident.active ||
        resident.mcpBusy ||
        resident.mcpRecovering ||
        resident.hooksBusy
      ) {
        error(res, 409, 'hosted_turn_active');
        return;
      }
      const previous = resident.lifecycle;
      resident.hooksBusy = true;
      resident.stores!.setLifecycleAuthority(lifecycle);
      try {
        await resident.stores!.assertWritable();
        resident.lifecycle = lifecycle;
        resident.lifecycleProtocolVersion = lifecycleProtocolVersion;
        resident.mcpClosing = true;
        sendAttachment(res, sessionId, resident);
      } catch (cause) {
        resident.stores!.setLifecycleAuthority(previous);
        debugLogger.warn('Hosted lifecycle attachment claim rejected:', cause);
        error(res, 503, 'managed_session_open_failed');
      } finally {
        resident.hooksBusy = false;
      }
      return;
    }
    // The re-answer hands over the resident Session's client id again, so
    // both below branches re-prove the store identity the attachment was
    // opened with once, before either runs: the writer fence proves the
    // generation, this proves the tenant/Workspace the caller claims to
    // continue for. A drifted Session Store address is the caller's own
    // lookup failing, so it answers a retryable conflict with its own code.
    if (resident !== undefined && !create) {
      const key = resident.managed.authority.sessionHeader.sessionKey;
      if (
        key.tenantId !== store.tenantId ||
        key.workspaceId !== store.workspaceId
      ) {
        error(res, 409, 'hosted_session_already_attached');
        return;
      }
      if (resident.storeBaseUrl !== store.baseUrl) {
        error(res, 409, 'hosted_session_store_mismatch');
        return;
      }
      // The owner proven above restates the host's capability; a later
      // Turn reads it, never a stale one from the first attach.
      if (
        (resident.publicChildAgentsVersion ?? 0) !== publicChildAgentsVersion
      ) {
        error(res, 409, 'hosted_tool_profile_conflict');
        return;
      }
      if (
        !isDeepStrictEqual(
          resident.publicChildModelRoute,
          publicChildModelRoute,
        )
      ) {
        error(res, 409, 'hosted_tool_profile_conflict');
        return;
      }
      if (
        !isDeepStrictEqual(
          resident.publicChildExtensionAgent,
          publicChildExtensionAgent,
        )
      ) {
        error(res, 409, 'hosted_tool_profile_conflict');
        return;
      }
      if (!isDeepStrictEqual(resident.initialSelection, initialSelection)) {
        error(res, 409, 'hosted_tool_profile_conflict');
        return;
      }
      if (resident.childAgents) {
        await resident.childAgents.serialized(async () => {
          resident.publicChildLaunchEnabled =
            body?.['suppressChildAgents'] !== true;
        });
      } else {
        resident.publicChildLaunchEnabled =
          body?.['suppressChildAgents'] !== true;
      }
      if (resident.publicChildAgentsVersion === 1)
        await resident.childAgents?.stopCancelledSources();
      resident.childWorkspaces = childWorkspaces;
      resident.childSnapshots = childSnapshots;
      if (
        !resident.active &&
        brokerOptions &&
        hasHostedCleanupDebt(resident.managed) &&
        !unsettledPromptId(resident)
      ) {
        try {
          await retryHostedCleanup(resident, brokerOptions);
        } catch (cause) {
          writeStderrLineSafe(
            'qwen serve: Cleanup remains owed: ' + String(cause),
          );
        }
      }
      // The cancellation signal pays identically on an attached re-answer
      // (R9-2): the settle separation lived only on the first-load branch,
      // so a cancellation takeover forced onto an attached Session fell
      // into the passive kernel — which never advances a durable wait
      // passively, and threw the park back as an unknown phase once the
      // wait had ended since the attach. The no-tool arm settles
      // unconditionally here too, and the owed-work gate reads the work
      // exactly as on the first load.
      if (
        !resident.hooks &&
        resident.active === undefined &&
        (passiveRecovery || driveRecovery) &&
        body?.['cancellationTakeover'] === true
      ) {
        const parkedForCancellation = unsettledPromptId(resident);
        if (
          parkedForCancellation !== undefined &&
          (resident.toolProfile === undefined ||
            !brokerOptions ||
            (await parkNeedsNoRuntimeSettlement(resident.managed)))
        ) {
          if (resident.active !== undefined) {
            error(res, 409, 'hosted_session_already_attached');
            return;
          }
          if (typeof cancellationPromptId === 'string') {
            const target = cancellationTargetState(
              resident.managed,
              cancellationPromptId,
            );
            if (target === 'settled') {
              sendAttachment(res, sessionId, resident);
              return;
            }
            if (
              target !== 'pending' ||
              parkedForCancellation !== cancellationPromptId ||
              unsettledPromptId(resident) !== cancellationPromptId
            ) {
              error(res, 409, 'hosted_cancel_identity_mismatch');
              return;
            }
          }
          try {
            await settleCancelledHarnessTurn(
              resident.managed,
              resident,
              sessionId,
              parkedForCancellation,
            );
            if (sessions.get(sessionId) !== resident) {
              error(res, 404, 'hosted_session_not_found');
              return;
            }
            if (resident.mcpClosing) {
              error(res, 409, 'hosted_session_closing');
              return;
            }
            writeStderrLineSafe(
              `qwen serve: Hosted Session ${sessionId} settles the cancelled park on the redriven load: prompt=${parkedForCancellation}`,
            );
            // The settle discharged the parked Turn, so the undriven
            // marker an earlier load's lost reply armed has nothing left
            // to guard and no route left to discharge it — continue and
            // cancel only ever settleReplay a settled Turn. Disarm it
            // with the re-answer, or /prompt refuses this Session for
            // the rest of the incarnation.
            resident.recoveredTurn = undefined;
            // The journal owes nothing more: the re-answer carries the
            // refreshed watermark the already-running stream settles from.
            refusedAdoptions.delete(sessionId);
            sendAttachment(res, sessionId, resident);
            return;
          } catch (cause) {
            writeStderrLineSafe(
              `qwen serve: Hosted Session ${sessionId} redrive refused (takeover_failed): profile=${resident.toolProfile ?? 'none'} broker=${brokerOptions ? 'ready' : 'none'} settle=${sanitizeDaemonLogLine(String(cause))}`,
            );
            error(res, 409, 'hosted_turn_recovery_required', 'takeover_failed');
            return;
          }
        }
      }
    }
    if (
      openings.inFlight.has(sessionId) ||
      (resident && (create || (!passiveRecovery && !driveRecovery)))
    ) {
      error(res, 409, 'hosted_session_already_attached');
      return;
    }
    // A continuation load redriven after a lost reply is answered from the
    // Session it already attached: the writer fence above proves this load
    // targets this generation, and no continue/cancel can have been admitted
    // since (its identities ride the lost reply), so the resident state is
    // still exactly what the first load left behind. Answer again from that
    // state instead of wedging the Turn on a 409 loop; the re-run is read-only
    // apart from the Broker acquire, which is idempotent under the same
    // Runtime Session identity. A passive load takes the stricter resident
    // path below, which validates the store and the tool profile first.
    if (resident !== undefined && driveRecovery && !passiveRecovery) {
      if (resident.hooks) {
        error(res, 409, 'hosted_session_already_attached');
        return;
      }
      const parked = unsettledPromptId(resident);
      if (parked === undefined) {
        // No single parked Turn: the first load's answer still holds, so the
        // redrive gets the same attachment restated — including a blocked
        // Session, whose recoveryRequired the coordinator already handles.
        // A marker whose parked Turn left the unsettled set has no route
        // left to discharge it, so the restatement discharges it; a marker
        // whose Turn is still among several unsettled inputs keeps the
        // fail-closed posture that state already has.
        if (
          resident.recoveredTurn !== undefined &&
          !unsettledInputs(resident).has(resident.recoveredTurn)
        )
          resident.recoveredTurn = undefined;
        if (stopMessages) resident.messagesStopped = true;
        refusedAdoptions.delete(sessionId);
        sendAttachment(res, sessionId, resident);
        return;
      }
      if (resident.active?.promptId === parked) {
        sendAttachment(res, sessionId, resident);
        return;
      }
      if (resident.active !== undefined) {
        error(res, 409, 'hosted_session_already_attached');
        return;
      }
      // Only a load this resident Session admits may stop its messages,
      // and before the recovery it drives can start one.
      if (stopMessages) resident.messagesStopped = true;
      if (!resident.mcp) {
        if (resident.mcpClosing) {
          noteOwedAdoption(resident, sessionId);
          return error(res, 409, 'hosted_session_closing');
        }
        if (resident.mcpRecovering)
          return error(res, 409, 'hosted_turn_active');
        resident.mcpRecovering += 1;
        try {
          const committed = await findHostedCommittedModelOutput(
            resident.managed,
            parked,
          );
          if (committed) {
            if (sessions.get(sessionId) !== resident) {
              noteOwedAdoption(resident, sessionId);
              return error(res, 404, 'hosted_session_not_found');
            }
            if (resident.mcpClosing) {
              noteOwedAdoption(resident, sessionId);
              return error(res, 409, 'hosted_session_closing');
            }
            runSettleProjection(
              resident,
              sessionId,
              parked,
              brokerOptions,
              true,
            );
            sendAttachment(res, sessionId, resident);
            return;
          }
          const model = await findHostedModelRequest(resident.managed, parked);
          const approval =
            hostedApprovalResumeShapeRefusal(resident, brokerOptions) ===
            undefined
              ? await findHostedApprovalContinuation(resident.managed, parked)
              : undefined;
          const memoryResults =
            resident.memory &&
            !model &&
            !approval &&
            (await parkNeedsNoRuntimeSettlement(resident.managed))
              ? await findHostedMemoryResults(resident.managed, parked)
              : undefined;
          if (model || approval || memoryResults) {
            const text = await hostedOriginalPromptText(
              resident.managed,
              parked,
            );
            if (text === undefined)
              throw new HostedToolRecoveryRequiredError(
                'Original Prompt is missing.',
              );
            if (sessions.get(sessionId) !== resident) {
              noteOwedAdoption(resident, sessionId);
              return error(res, 404, 'hosted_session_not_found');
            }
            if (resident.mcpClosing) {
              noteOwedAdoption(resident, sessionId);
              return error(res, 409, 'hosted_session_closing');
            }
            await startHostedRecoveredTurn(
              resident,
              sessionId,
              cwd,
              { promptId: parked, text, parts: memoryResults ?? [] },
              brokerOptions,
              approval,
              model,
            );
            if (sessions.get(sessionId) !== resident) {
              noteOwedAdoption(resident, sessionId);
              return error(res, 404, 'hosted_session_not_found');
            }
            if (resident.mcpClosing) {
              noteOwedAdoption(resident, sessionId);
              return error(res, 409, 'hosted_session_closing');
            }
            sendAttachment(res, sessionId, resident);
            return;
          }
        } catch (cause) {
          if (
            cause instanceof HostedRecoveryQuiescingError &&
            !resident.managed.authority.writesStopped
          ) {
            error(res, 409, 'hosted_harness_quiescing');
            return;
          }
          // #17260: the parked Turn's saved public-child profile belongs
          // to a topology this Harness cannot open. The durable verdict
          // never changes on retry, so answer the typed terminal decline
          // instead of the retriable refusal that kept the coordinator's
          // recovery sweep re-driving it forever.
          if (cause instanceof HostedPublicChildRecoveryProfileChanged) {
            recoveryDeclined(res, 'public_child_recovery_unsupported');
            return;
          }
          blockRecovery(resident, namedStoreFailure(cause));
          writeStderrLineSafe(
            'qwen serve: Hosted recovery redrive failed: ' + String(cause),
          );
          error(res, 409, 'hosted_turn_recovery_required');
          return;
        } finally {
          resident.mcpRecovering -= 1;
        }
      }
      if (resident.toolProfile === undefined || !brokerOptions) {
        recoveryDeclined(res, 'model_start');
        return;
      }
      let recovery: HostedRuntimeRecoveryReport;
      try {
        const outcome = await recoverHostedRuntimeTurn({
          session: resident.managed,
          canStart: resident.poolAccepting,
          sessionId,
          cwd,
          promptId: parked,
          brokerOptions,
          passive: false,
          children: resident.childAgents,
          teams: resident.teams,
          messages: resident.messages,
          commands: resident.commands,
          leaseAlreadyHeld: resident.runtimeLeaseHeld?.promptId === parked,
        });
        if (outcome.kind === 'declined') {
          recoveryDeclined(res, outcome.reason);
          return;
        }
        if (outcome.kind === 'inapplicable') {
          await answerResidentInapplicable(res, sessionId, resident, parked);
          return;
        }
        recovery = outcome.turn.report;
        // Arm the undriven marker exactly like the first load does: the
        // re-answer advertises the same drivable recovery, and without the
        // marker a fresh /prompt is admitted over the parked executions the
        // report describes. An undrivable re-answer DISARMS the marker an
        // earlier load's lost reply armed — its marker would have no
        // discharger, since the coordinator fails an undrivable report
        // without ever calling continue/cancel.
        resident.recoveredTurn = outcome.turn.drivable
          ? outcome.turn.promptId
          : undefined;
        if (outcome.turn.acquiredRuntime) {
          resident.runtimeLeaseHeld = {
            promptId: outcome.turn.promptId,
            runtimeSessionId: outcome.turn.runtimeSessionId,
          };
          resident.runtimeLeaseOwedByTerminalRoute = false;
        }
      } catch (cause) {
        writeStderrLineSafe(
          `qwen serve: Hosted Harness recovery re-answer of session ${sessionId} failed: ${sanitizeDaemonLogLine(String(cause))}`,
        );
        if (
          cause instanceof HostedRecoveryQuiescingError &&
          !resident.managed.authority.writesStopped
        ) {
          error(res, 409, 'hosted_harness_quiescing');
          return;
        }
        // Retry-inviting, like the first load's recovery failure; the
        // attached Session keeps its owed lease for the next redrive. A
        // stopped writer outranks the takeover label, exactly as the
        // blocked-first rule writes_stopped beats turn_blocked (R1-3).
        error(
          res,
          409,
          'hosted_turn_recovery_required',
          resident.managed.authority.writesStopped
            ? 'writes_stopped'
            : 'takeover_failed',
        );
        return;
      }
      // A teardown admitted during the await above released nothing (the
      // lease was not recorded yet) and left no route to hand it back.
      if (sessions.get(sessionId) !== resident) {
        noteOwedAdoption(resident, sessionId);
        error(res, 404, 'hosted_session_not_found');
        return;
      }
      if (resident.mcpClosing) {
        noteOwedAdoption(resident, sessionId);
        error(res, 409, 'hosted_session_closing');
        return;
      }
      refusedAdoptions.delete(sessionId);
      sendAttachment(res, sessionId, resident, recovery);
      return;
    }
    if (resident) {
      if (
        toolProfile === undefined &&
        isHostedWorkspaceProfile(resident.toolProfile)
      )
        toolProfile = resident.toolProfile;
      const definition = resident.definition;
      if (
        definition?.['toolProfile'] !== toolProfile ||
        JSON.stringify(definition?.['mcpServers']) !==
          JSON.stringify(mcpServers) ||
        !isDeepStrictEqual(
          definition?.['hookCatalog'],
          hookCatalog ?? definition?.['hookCatalog'],
        ) ||
        (isHostedWorkspaceShellProfile(toolProfile) &&
          captureBytes !== undefined &&
          definition?.['captureBytes'] !== captureBytes)
      ) {
        error(res, 409, 'hosted_tool_profile_conflict');
        return;
      }
      // Only a load this resident Session admits may stop its messages: an
      // identity, admission or profile refusal above changes nothing.
      if (stopMessages) resident.messagesStopped = true;
      try {
        // Reuse the live owner without reopening its writer or driving work.
        // A lost passive-load reply must still report a parked Runtime Turn.
        let recovery: HostedRuntimeRecoveryReport | undefined;
        const parked = !resident.active && unsettledPromptId(resident);
        if (resident.mcpClosing) {
          error(res, 409, 'hosted_session_closing');
          return;
        }
        if (
          !resident.active &&
          !parked &&
          hasUnsettledInput(
            resident,
            resident.managed.authority.committedSequence,
          )
        ) {
          error(res, 409, 'hosted_turn_recovery_required', 'inputs_unsettled');
          return;
        }
        if (parked) {
          if (!resident.toolProfile || !brokerOptions || resident.hooks) {
            error(
              res,
              409,
              'hosted_turn_recovery_required',
              'takeover_unsupported',
            );
            return;
          }
          // The adoption this await publishes lands on a Session every route
          // can still reach, so the recovery holds close()'s own fence: a
          // concurrent teardown would otherwise release a lease that is still
          // mid-adoption and persist the record RELEASED.
          resident.mcpRecovering += 1;
          try {
            const outcome = await recoverHostedRuntimeTurn({
              session: resident.managed,
              canStart: resident.poolAccepting,
              sessionId,
              cwd: resident.cwd,
              promptId: parked,
              brokerOptions,
              passive: true,
              onPassiveRuntimeAcquired: (runtimeSessionId) => {
                resident.runtimeLeaseHeld = {
                  promptId: parked,
                  runtimeSessionId,
                };
                resident.runtimeLeaseOwedByTerminalRoute = false;
              },
            });
            if (outcome.kind === 'recovered') {
              recovery = outcome.turn.report;
              // Arm the undriven marker only for a recovery the producer
              // itself judges drivable — the coordinator fails an
              // undrivable one without ever arriving, and the Session must
              // not refuse every later route forever. An undrivable report
              // DISARMS a marker an earlier load armed for the same park:
              // nothing would ever discharge it otherwise.
              resident.recoveredTurn = outcome.turn.drivable
                ? outcome.turn.promptId
                : undefined;
            } else if (outcome.kind === 'inapplicable') {
              await answerResidentInapplicable(
                res,
                sessionId,
                resident,
                parked,
              );
              return;
            } else {
              // A declined passive load was refused before any adoption, so
              // nothing is owed; the typed code tells the coordinator the
              // refusal is terminal.
              recoveryDeclined(res, outcome.reason);
              return;
            }
            if (
              !resident.active &&
              unsettledPromptId(resident) &&
              (!recovery ||
                parked !== unsettledPromptId(resident) ||
                recovery.checkpointId !==
                  resident.managed.authority.latestCheckpoint?.checkpointId ||
                recovery.activationId !==
                  resident.managed.activation.activationId)
            ) {
              noteOwedAdoption(resident, sessionId);
              error(
                res,
                409,
                'hosted_turn_recovery_required',
                'takeover_failed',
              );
              return;
            }
          } finally {
            resident.mcpRecovering -= 1;
          }
        }
        // The fence above covers the whole adoption, so these exits answer
        // only a Session another route already dropped.
        if (sessions.get(sessionId) !== resident) {
          noteOwedAdoption(resident, sessionId);
          error(res, 404, 'hosted_session_not_found');
          return;
        }
        if (resident.mcpClosing) {
          noteOwedAdoption(resident, sessionId);
          error(res, 409, 'hosted_session_closing');
          return;
        }
        // A marker whose parked Turn left the unsettled set has no route left
        // to discharge it, so this answer discharges it — the drive redrive's
        // restatement does the same.
        if (
          resident.recoveredTurn !== undefined &&
          !unsettledInputs(resident).has(resident.recoveredTurn)
        )
          resident.recoveredTurn = undefined;
        refusedAdoptions.delete(sessionId);
        sendAttachment(
          res,
          sessionId,
          resident,
          resident.active || !unsettledPromptId(resident)
            ? undefined
            : recovery,
        );
      } catch {
        noteOwedAdoption(resident, sessionId);
        error(res, 409, 'hosted_turn_recovery_required', 'takeover_failed');
      }
      return;
    }
    const sessionKey = {
      tenantId: store.tenantId,
      workspaceId: store.workspaceId,
      sessionId,
    };
    let stores: ReturnType<typeof createHttpManagedSessionStores>;
    try {
      stores = createHttpManagedSessionStores({
        baseUrl: store.baseUrl,
        sessionKey,
        writerId: store.writerId,
        leaseDurationMs: store.leaseDurationMs,
        ...(store.writerToken === undefined
          ? {}
          : { writerToken: store.writerToken }),
        ...(store.allowInsecureHttp === undefined
          ? {}
          : { allowInsecureHttp: store.allowInsecureHttp }),
      });
    } catch (cause) {
      debugLogger.warn('managed session store descriptor refused:', cause);
      error(
        res,
        400,
        'invalid_managed_session_store',
        undefined,
        cause instanceof Error ? cause.message : String(cause),
      );
      return;
    }
    if (lifecycle) stores.setLifecycleAuthority(lifecycle);
    // Refuse before the create publishes resources or registers its
    // opening: a cap-refused create must leave no unreferenced resources
    // and no unresolvedOpenings debt for the control plane's retry loop.
    if (coldOpensInFlight >= coldOpenLimit) {
      suspensionStats.openBusyRefusals += 1;
      return error(res, 409, 'hosted_session_open_busy');
    }
    coldOpensInFlight += 1;
    res.locals['coldOpenSlot'] = true;
    res.locals['coldOpenStart'] = Date.now();
    openings.inFlight.add(sessionId);
    let managed: ManagedSession | undefined;
    try {
      const refs = create
        ? {
            definitionRef: await stores.resourceStore.publish(
              'managed-definition',
              Buffer.from(
                JSON.stringify({
                  engine: 'managed',
                  sessionId,
                  ...(agentDefinition ? { agentDefinition } : {}),
                  ...(modelConfigDigest ? { modelConfigDigest } : {}),
                  ...(memoryStoreId ? { memoryStoreId } : {}),
                  ...(publicChildAgentsVersion === 1
                    ? { publicChildAgentsVersion }
                    : {}),
                  ...(publicChildModelRoute ? { publicChildModelRoute } : {}),
                  ...(publicChildExtensionAgent
                    ? { publicChildExtensionAgent }
                    : {}),
                  ...(initialSelection ? { initialSelection } : {}),
                  ...(sessionSkillsRef ? { sessionSkillsRef } : {}),
                  ...(toolProfile ? { toolProfile } : {}),
                  ...(foregroundOnly ? { foregroundOnly: true } : {}),
                  ...(mcpServers ? { mcpServers } : {}),
                  ...(hookCatalog ? { hookCatalog } : {}),
                  ...(isHostedWorkspaceShellProfile(toolProfile) ||
                  isHostedWorkspaceExternalShellProfile(toolProfile)
                    ? { captureBytes }
                    : {}),
                  ...(approval
                    ? hostedApprovalDefinition(
                        approval,
                        !agentDefinition &&
                          (toolProfile === HOSTED_WORKSPACE_FILE_PROFILE ||
                            toolProfile ===
                              HOSTED_WORKSPACE_EXTERNAL_FILES_PROFILE ||
                            isHostedWorkspaceExternalShellProfile(
                              toolProfile,
                            ) ||
                            toolProfile === HOSTED_WORKSPACE_FILE_PROFILE_V3 ||
                            isHostedWorkspaceShellProfile(toolProfile)),
                      )
                    : {}),
                  // H4b: a child's ancestry persists with its definition,
                  // so a load answers its depth without a second channel.
                  ...(lineage ? { lineage } : {}),
                }),
              ),
            ),
            rootSnapshotRef: await stores.resourceStore.publish(
              'managed-root',
              Buffer.from(JSON.stringify({ cwd })),
            ),
            createdBy: 'hosted-harness',
          }
        : undefined;
      const storeRecoveryStart = Date.now();
      managed = await openManagedSession({
        runtimeBaseDir: cwd,
        transcriptPath: '',
        sessionId,
        sessionKey,
        cwd,
        version: 'hosted-harness/1',
        workerId: contract.bootId,
        activationLeaseDurationMs: store.leaseDurationMs,
        journalStore: stores.journalStore,
        resourceStore: stores.resourceStore,
        ...(refs
          ? { create: refs, requireNew: true }
          : { retainVerifiedResources: true }),
      });
      res.locals['coldOpenStoreMs'] = Date.now() - storeRecoveryStart;
      if (stores.supportsModelDiagnostics?.())
        await enableManagedSessionDiagnostics(managed);
      if (stores.supportsExecutionDiagnostics?.())
        await enableManagedExecutionDiagnostics(managed);
      if (!acceptingWork()) {
        await managed.close();
        error(res, 409, 'hosted_harness_quiescing');
        return;
      }
      if (typeof cancellationPromptId === 'string') {
        const target = cancellationTargetState(managed, cancellationPromptId);
        if (target === undefined) {
          await managed.close();
          error(res, 409, 'hosted_cancel_identity_mismatch');
          return;
        }
        if (target === 'settled') cleanupPromptId = cancellationPromptId;
      }
      // Taken now, so the authority keeps none of it for the Session's
      // lifetime; a cold Workspace load reuses it below.
      const preverified =
        await managed.authority.takeVerifiedExtensionResources();
      const definition = object(
        JSON.parse(
          (
            await managed.resources.read(
              managed.authority.sessionHeader.definitionRef,
            )
          ).toString('utf8'),
        ),
      );
      const externalFiles =
        definition?.['toolProfile'] === HOSTED_WORKSPACE_EXTERNAL_FILES_PROFILE;
      const externalShell = isHostedWorkspaceExternalShellProfile(
        definition?.['toolProfile'],
      );
      if (
        (externalFiles || externalShell) &&
        (!contract.features?.includes(definition?.['toolProfile'] as string) ||
          contract.lifecycleProtocolVersion !== 1 ||
          hasHostedExternalExcludedOptions(body, definition?.['toolProfile']) ||
          hasHostedExternalExcludedOptions(
            definition,
            definition?.['toolProfile'],
          ) ||
          managed.authority
            .eventsInSequenceRange(1, managed.authority.committedSequence)
            .some(
              (event) =>
                event.kind === 'domain.committed' &&
                [
                  'hook_registration',
                  'hook_execution',
                  'mcp_configuration',
                  'mcp_operation',
                  'child_run',
                  'monitor_run',
                  'schedule',
                  'automation_run',
                  'child_acceptance',
                  'session_message',
                  'channel_route',
                  'channel_delivery',
                  'team_state',
                  'team_task',
                  'team_plan',
                  'session_command',
                ].includes(event.payload['domain'] as string),
            ))
      ) {
        await managed.close();
        return error(res, 409, 'hosted_tool_profile_conflict');
      }
      let savedAgentDefinition: HostedAgentDefinition | undefined;
      let savedSessionSkillsRef: ManagedSessionDurableRef | undefined;
      let skills: HostedSkillCatalog | undefined;
      try {
        if (
          parseHostedModelConfigDigest(definition?.['modelConfigDigest']) !==
          modelConfigDigest
        ) {
          throw new Error('Session model configuration binding changed.');
        }
        if (
          parseHostedMemoryStoreId(definition?.['memoryStoreId']) !==
          memoryStoreId
        )
          throw new Error('Session personal memory binding changed.');
        savedAgentDefinition = parseHostedAgentDefinition(
          definition?.['agentDefinition'],
        );
        savedSessionSkillsRef = parseSessionSkillsRef(
          definition?.['sessionSkillsRef'],
        );
        if (!sameSessionSkillsRef(savedSessionSkillsRef, sessionSkillsRef))
          throw new Error('Session Skills reference changed.');
        if (!sameHostedAgentDefinition(savedAgentDefinition, agentDefinition))
          throw new Error('Agent definition identity changed.');
        await readHostedAgentInstructions(
          savedAgentDefinition,
          managed.resources,
        );
        const effectiveSkillsRef =
          savedSessionSkillsRef ?? savedAgentDefinition?.skillsRef;
        if (effectiveSkillsRef)
          skills = new HostedSkillCatalog(
            await readHostedSkills(effectiveSkillsRef, managed.resources),
          );
      } catch {
        await managed.close();
        error(res, 409, 'hosted_agent_definition_conflict');
        return;
      }
      const savedProfile = definition?.['toolProfile'];
      if (
        (definition?.['foregroundOnly'] !== undefined &&
          typeof definition['foregroundOnly'] !== 'boolean') ||
        (requestedForegroundOnly !== undefined &&
          foregroundOnly !== (definition?.['foregroundOnly'] === true))
      ) {
        await managed.close();
        error(res, 409, 'hosted_tool_profile_conflict');
        return;
      }
      if (
        !isDeepStrictEqual(
          definition?.['publicChildModelRoute'],
          publicChildModelRoute,
        )
      )
        throw new Error('Public child model route changed.');
      if (
        !isDeepStrictEqual(
          definition?.['publicChildExtensionAgent'],
          publicChildExtensionAgent,
        )
      )
        throw new Error('Public child extension binding changed.');
      if (
        !isDeepStrictEqual(definition?.['initialSelection'], initialSelection)
      )
        throw new Error('Initial extension selection changed.');
      if (
        (definition?.['publicChildAgentsVersion'] ?? 0) !==
        publicChildAgentsVersion
      ) {
        await managed.close();
        error(res, 409, 'hosted_tool_profile_conflict');
        return;
      }
      foregroundOnly = definition?.['foregroundOnly'] === true;
      if (
        !create &&
        toolProfile === undefined &&
        isHostedWorkspaceProfile(savedProfile)
      )
        toolProfile = savedProfile;
      // #13753 I3: the read profile declares only read_file and glob, so a
      // snapshot child takes no skill catalog. Its instructions would name
      // a skill tool the profile does not declare, and an undeclared call
      // fails the Turn.
      if (isHostedWorkspaceReadProfile(toolProfile)) skills = undefined;
      if (
        !create &&
        lifecycle &&
        (toolProfile === HOSTED_MCP_PROFILE ||
          (isHostedWorkspacePublicShellProfile(toolProfile) &&
            definition?.['mcpServers'] !== undefined)) &&
        mcpServers === undefined
      ) {
        mcpServers = parseHostedMcpServers(definition?.['mcpServers']);
      }
      if (!create && hookCatalog === undefined && definition?.['hookCatalog']) {
        try {
          hookCatalog = parseHostedHookPin(definition['hookCatalog']);
        } catch {
          await managed.close();
          error(res, 409, 'hosted_tool_profile_conflict');
          return;
        }
      }
      if (
        !create &&
        (isHostedWorkspaceShellProfile(toolProfile) ||
          isHostedWorkspaceExternalShellProfile(toolProfile)) &&
        captureBytes === undefined
      )
        captureBytes = definition?.['captureBytes'];
      const workspaceProfile = isHostedWorkspaceProfile(toolProfile);
      if (
        (foregroundOnly &&
          ((toolProfile !== HOSTED_WORKSPACE_FILE_PROFILE &&
            toolProfile !== HOSTED_WORKSPACE_EXTERNAL_FILES_PROFILE &&
            !isHostedWorkspaceExternalShellProfile(toolProfile) &&
            toolProfile !== 'hosted-workspace-shell/1') ||
            mcpServers !== undefined ||
            hookCatalog !== undefined ||
            childWorkspaces ||
            definition?.['lineage'] !== undefined)) ||
        ((hookCatalog !== undefined || skills !== undefined) &&
          (!toolProfile || !brokerOptions)) ||
        (toolProfile !== undefined &&
          ((!isHostedWorkspaceProfile(toolProfile) &&
            toolProfile !== HOSTED_MCP_PROFILE) ||
            !brokerOptions))
      ) {
        await managed.close();
        error(res, 409, 'hosted_tool_profile_conflict');
        return;
      }
      if (
        isHostedWorkspaceShellProfile(toolProfile) &&
        captureBytes !== undefined &&
        (!Number.isSafeInteger(captureBytes) ||
          (captureBytes as number) < 1 ||
          (captureBytes as number) > 2 ** 41)
      ) {
        await managed.close();
        error(res, 409, 'hosted_tool_profile_conflict');
        return;
      }
      if (!acceptingWork()) {
        await managed.close();
        error(res, 409, 'hosted_harness_quiescing');
        return;
      }
      const session: HostedSession = {
        ...(placement ? { placement, poolAccepting: acceptingWork } : {}),
        streamOwner: { bootId: contract.bootId, eventEpoch: epoch },
        managed,
        storeBaseUrl: store.baseUrl,
        definition,
        agentDefinition: savedAgentDefinition,
        ...(memoryStoreId
          ? {
              memoryStoreId,
              memory: new HostedMemorySession(stores, memoryStoreId),
            }
          : {}),
        ...(modelConfigDigest
          ? {
              modelConfigDigest,
              modelConfig: async (kind) => {
                try {
                  return parseHostedModelConfig(
                    await stores.modelConfig(modelConfigDigest, kind),
                    modelConfigDigest,
                  );
                } catch (cause) {
                  if (namedStoreFailure(cause)) throw cause;
                  throw new HostedModelUnavailableError();
                }
              },
            }
          : {}),
        ...(publicChildAgentsVersion === 1
          ? { publicChildAgentsVersion: 1 as const }
          : {}),
        ...(publicChildModelRoute ? { publicChildModelRoute } : {}),
        ...(publicChildExtensionAgent ? { publicChildExtensionAgent } : {}),
        ...(initialSelection ? { initialSelection } : {}),
        publicChildLaunchEnabled: body?.['suppressChildAgents'] !== true,
        ...(savedSessionSkillsRef
          ? { sessionSkillsRef: savedSessionSkillsRef }
          : {}),
        ...(skills ? { skills } : {}),
        clientId: randomUUID(),
        cwd,
        streams: new Set(),
        admissions: new Map(),
        blocked: false,
        childConsumption: new Set(),
        heldRuntimeTurns: new Set(),
        mcpRecovering: 0,
        waiters: new HostedApprovalWaiters(),
        stores,
        storeDescriptor: store,
        lifecycle,
        ...(lifecycle ? { lifecycleProtocolVersion, mcpClosing: true } : {}),
        ...(childWorkspaces ? { childWorkspaces: true } : {}),
        ...(childSnapshots ? { childSnapshots: true } : {}),
        ...(toolProfile ? { toolProfile } : {}),
        ...(foregroundOnly ? { foregroundOnly: true } : {}),
        ...((isHostedWorkspaceShellProfile(toolProfile) ||
          isHostedWorkspaceExternalShellProfile(toolProfile)) &&
        captureBytes !== undefined
          ? {
              publication: {
                owner: stores.publication,
                captureBytes: captureBytes as number,
              },
              // The external placement is foreground-only by contract: it has
              // no background ledger, so it never opens that lane.
              ...(!foregroundOnly &&
              !isHostedWorkspaceExternalShellProfile(toolProfile)
                ? {
                    backgroundLane: {
                      resources: stores.toolResultResources,
                      assertWritable: stores.assertWritable,
                    },
                  }
                : {}),
            }
          : {}),
        ...(isHostedWorkspaceShellProfile(toolProfile) &&
        captureBytes === undefined
          ? {
              shell: {
                resources: stores.toolResultResources,
                assertWritable: stores.assertWritable,
              },
            }
          : {}),
        ...(stopMessages ? { messagesStopped: true } : {}),
      };
      const savedLineage = object(definition?.['lineage']);
      if (
        savedLineage &&
        Number.isSafeInteger(savedLineage['depth']) &&
        (savedLineage['depth'] as number) >= 1 &&
        (savedLineage['depth'] as number) <= 8
      ) {
        session.childDepth = savedLineage['depth'] as number;
      }
      const pinned = toolProfile
        ? readHostedApprovalDefinition(definition)
        : undefined;
      if (
        definition?.['toolProfile'] !== toolProfile ||
        JSON.stringify(definition?.['mcpServers']) !==
          JSON.stringify(mcpServers) ||
        !isDeepStrictEqual(definition?.['hookCatalog'], hookCatalog) ||
        (isHostedWorkspaceShellProfile(toolProfile) &&
          definition?.['captureBytes'] !== captureBytes) ||
        (isHostedWorkspaceExternalShellProfile(toolProfile) &&
          definition?.['captureBytes'] !== captureBytes) ||
        (toolProfile && !pinned)
      ) {
        await managed.close();
        error(res, 409, 'hosted_tool_profile_conflict');
        return;
      }
      const configurationHead =
        managed.authority.domainRecord('config_install');
      const hasExtensionConfiguration =
        configurationHead &&
        isManagedExtensionConfig(
          JSON.parse(
            (
              await managed.resources.read(configurationHead.recordRef)
            ).toString('utf8'),
          ),
        );
      if ((externalFiles || externalShell) && hasExtensionConfiguration) {
        await managed.close();
        return error(res, 409, 'hosted_tool_profile_conflict');
      }
      // The external drain proves the captured bytes arrived, so their
      // capacity must be reserved before the placement admits any Shell.
      if (
        externalShell &&
        (captureBytes === undefined ||
          !Number.isSafeInteger(captureBytes) ||
          (captureBytes as number) < 1 ||
          (captureBytes as number) > 2 ** 41)
      ) {
        await managed.close();
        error(res, 409, 'hosted_tool_profile_conflict');
        return;
      }
      const mcpSettings = hasExtensionConfiguration
        ? []
        : await readHostedMcpSettings(managed);
      validateHostedMcpHistory(mcpServers ?? [], mcpSettings);
      if (
        mcpSettings.length &&
        (foregroundOnly ||
          ![
            'hosted-workspace-shell/1',
            HOSTED_WORKSPACE_SHELL_PROFILE_V3,
            'hosted-workspace-shell/4',
            HOSTED_MCP_PROFILE,
          ].includes(toolProfile ?? '') ||
          (session.childDepth ?? 0) !== 0)
      )
        throw new Error(
          'Hosted MCP management is unavailable for this Session.',
        );
      if (
        typeof cancellationPromptId === 'string' &&
        cleanupPromptId === undefined &&
        unsettledPromptId(session) !== cancellationPromptId
      ) {
        await managed.close();
        error(res, 409, 'hosted_cancel_identity_mismatch');
        return;
      }
      if (typeof cleanupPromptId === 'string') {
        const status = await inspectHostedRecovery(session, cleanupPromptId);
        if (
          !workspaceProfile ||
          hookCatalog ||
          mcpServers ||
          mcpSettings.length > 0 ||
          !status.inputSettled ||
          !status.continuationReady ||
          !['ready', 'cleanup_pending'].includes(status.state)
        ) {
          await managed.close();
          error(res, 409, 'hosted_turn_recovery_required');
          return;
        }
        session.recoveryCleanupOnly = true;
        if (pinned) session.approval = pinned;
        try {
          await cleanupOriginalRecovery(session, cleanupPromptId);
        } catch {
          session.cleanupBlocked = true;
          session.blocked = true;
        }
        sessions.set(sessionId, session);
        armFor(sessionId);
        sendAttachment(res, sessionId, session);
        return;
      }
      const extensionManagement =
        hasExtensionConfiguration ||
        publicChildExtensionAgent ||
        initialSelection
          ? await extensionsManager(session, !!publicChildExtensionAgent)
          : undefined;
      if (initialSelection && extensionManagement && !passiveRecovery)
        await extensionManagement.bootstrap(initialSelection);
      if (publicChildExtensionAgent && extensionManagement) {
        const source = parseManagedExtensionEffectiveBundle(
          JSON.parse(
            (
              await managed.resources.read(
                publicChildExtensionAgent.effectiveConfigRef,
              )
            ).toString('utf8'),
          ),
        );
        const descriptor = publicChildExtensionAgent.extensionAgent;
        const member = source.packages.find(
          (entry) =>
            isDeepStrictEqual(entry.pin, descriptor.pin) &&
            isDeepStrictEqual(
              entry.contributionsRef,
              descriptor.contributionsRef,
            ),
        );
        if (!member || source.configRevision !== descriptor.configRevision)
          throw new Error('Child extension source membership changed.');
        const contributions = await readManagedExtensionContributions(
          managed.resources,
          member.contributionsRef,
        );
        const agent = contributions.agents.find(
          (entry) => entry.name === descriptor.agentName,
        );
        if (
          !agent ||
          descriptor.toolNames.some(
            (name) =>
              (agent.tools && !agent.tools.includes(name)) ||
              agent.disallowedTools?.includes(name),
          )
        )
          throw new Error('Child extension descriptor changed.');
        session.extensionAgentTools = descriptor.toolNames;
        session.extensionAgentPrompt = extensionInstructionText(
          agent.systemPrompt,
          descriptor.pin.extensionId,
        );
        session.extensionAgentPins = source.packages.map((entry) => entry.pin);
        if (!passiveRecovery)
          await extensionManagement.bootstrap(
            hostedChildExtensionApplyCommand(
              sessionId,
              publicChildExtensionAgent.effectiveConfigRef.digest,
              session.extensionAgentPins,
            ),
          );
      }
      const extensionBundle = await extensionManagement?.active();
      if (
        extensionManagement &&
        (await extensionBootstrapIncomplete(session, extensionManagement))
      ) {
        if (!passiveRecovery) throw new HostedExtensionRecoveryRequired();
        session.extensionBootstrapPending = true;
        session.blocked = true;
      }
      const effectiveMcpServers = extensionBundle?.mcpServers ?? mcpServers;
      const effectiveHookCatalog = extensionBundle
        ? extensionBundle.hookCatalog
        : hookCatalog;
      if (
        (effectiveMcpServers?.length || mcpSettings.length) &&
        brokerOptions &&
        !session.mcp
      ) {
        // A non-terminal discard can leave drained rows under a superseded
        // owner; now that this bundle is durably active, release them so the
        // constructor below does not see owners.size>1 (R15-3). The active
        // owner's own drained rows stay for the reload to re-initialize, so a
        // failed apply that kept the previous revision active is never stranded.
        if (extensionBundle)
          await HostedMcpSession.releaseSupersededDrained(
            managed,
            hostedConfigScopedOwnerId(
              managed.authority.sessionHeader.sessionKey,
              extensionBundle.configRevision,
            ),
          );
        session.mcp = new HostedMcpSession(
          { ...brokerOptions, lifecycleAuthority: () => session.lifecycle },
          managed,
          effectiveMcpServers ?? [],
          mcpSettings.at(-1),
          undefined,
          extensionBundle !== undefined,
        );
      }
      if (effectiveHookCatalog && brokerOptions && !session.hooks)
        session.hooks = new HostedHookSession(
          { ...brokerOptions, lifecycleAuthority: () => session.lifecycle },
          managed,
          effectiveHookCatalog,
          session.mcp?.broker,
          () => session.lifecycleProtocolVersion === 2,
          extensionBundle
            ? hostedConfigScopedOwnerId(
                session.managed.authority.sessionHeader.sessionKey,
                extensionBundle.configRevision,
              )
            : undefined,
        );
      if (extensionBundle && extensionManagement)
        selectExtensionCatalog(
          session,
          extensionBundle,
          await extensionManagement.packages(extensionBundle),
        );
      if (session.extensionAgentPrompt)
        session.extensionContext = `${session.extensionContext ?? ''}\n\n${session.extensionAgentPrompt}`;
      if (extensionManagement?.pending) session.blocked = true;
      if (
        !externalFiles &&
        !externalShell &&
        !foregroundOnly &&
        session.toolProfile &&
        brokerOptions
      ) {
        session.childRuns = new HostedChildRunSession(
          {
            authority: session.managed.authority,
            resources: session.managed.resources,
          },
          session.managed.authority.sessionHeader.sessionKey,
        );
        // H4b: the Session's own child orchestrator, on the Shell lanes
        // the notification wake is proven over — files profiles keep their
        // exact current surface (their child admission is its own gate).
        // Public Shell admission suppresses the child agent tool; a private
        // Shell lane that omits the flag keeps it. Team attachment stays.
        if (session.shell || session.backgroundLane) {
          if (
            hostedShellLaneAttachesChildAgents(
              true,
              publicChildAgentsVersion !== 1 &&
                body?.['suppressChildAgents'] === true,
            )
          )
            session.childAgents = new HostedChildAgentSession(
              {
                authority: session.managed.authority,
                resources: session.managed.resources,
              },
              session.managed.authority.sessionHeader.sessionKey,
              (promptId) =>
                session.managed.authority
                  .eventsInSequenceRange(
                    1,
                    session.managed.authority.committedSequence,
                  )
                  .some(
                    (event) =>
                      event.kind === 'cancel.requested' &&
                      (
                        event.payload['target'] as
                          | { turnId?: string }
                          | undefined
                      )?.turnId === promptId,
                  ),
              () => session.publicChildLaunchEnabled !== false,
            );
          if (publicChildAgentsVersion !== 1)
            session.teams = new HostedTeamSession(
              {
                authority: session.managed.authority,
                resources: session.managed.resources,
              },
              session.managed.authority.sessionHeader.sessionKey,
              // H4e-b3 decision 10: request_shutdown commits the stop an
              // H4f cancel would, through the child funnel's own chain.
              session.childAgents,
            );
          // H4d-b: the Session messages along its lineage on the same
          // writes chain; a child names its parent from its definition.
          const lineage =
            session.childDepth !== undefined &&
            typeof savedLineage?.['parentSessionId'] === 'string' &&
            typeof savedLineage['parentChildRunId'] === 'string'
              ? {
                  parentSessionId: savedLineage['parentSessionId'],
                  parentChildRunId: savedLineage['parentChildRunId'],
                }
              : undefined;
          // H4d-b: messages share the child orchestrator's write chain, so
          // a Shell lane that suppressed the agent tool has no funnel. The
          // commands funnel (H4e-b3) rides the same guard.
          if (session.childAgents && publicChildAgentsVersion !== 1) {
            session.messages = new HostedSessionMessageSession(
              {
                authority: session.managed.authority,
                resources: session.managed.resources,
              },
              session.managed.authority.sessionHeader.sessionKey,
              session.childAgents,
              lineage,
            );
            // H4e-b3: the Session's commands run beside its messages — its
            // own outbox as a member, and the lead's execute on the same
            // funnels when its children command it.
            session.commands = new HostedSessionCommandSession(
              {
                authority: session.managed.authority,
                resources: session.managed.resources,
              },
              session.managed.authority.sessionHeader.sessionKey,
              session.childAgents,
              lineage,
            );
          }
        }
      }
      // H4e-b3 decisions 5/9: a member run's plan mode is decided lazily by
      // ensureMemberPlanMode at tool-turn construction — the first committed
      // input may not exist yet while the Session assembles on create.
      if (
        !foregroundOnly &&
        session.toolProfile &&
        brokerOptions &&
        (session.shell || session.backgroundLane)
      )
        session.monitors = new HostedMonitorSession(
          {
            authority: session.managed.authority,
            resources: session.managed.resources,
          },
          session.managed.authority.sessionHeader.sessionKey,
        );
      // #13801 A3: settle records claimed but provably never started
      // before any route can read this reopened Session.
      if (session.childRuns && brokerOptions)
        await reconcileNeverStartedChildRuns({
          authority: session.managed.authority,
          resources: session.managed.resources,
          childRuns: session.childRuns,
          brokerOptions,
        });
      // H6b: every hosted Session owns its automation funnel — a run's
      // input needs no Runtime, and its settle reads the turn alone.
      if (!externalFiles && !externalShell) {
        session.automations = new HostedAutomationSession(
          {
            authority: managed.authority,
            resources: managed.resources,
            sink: managed.sink,
          },
          managed.authority.sessionHeader.sessionKey,
          {
            // The gate probe runs in the Workspace Runtime through the
            // Broker; a Harness without one blocks every gated fire.
            ...(brokerOptions
              ? gateOptions({
                  broker: {
                    ...brokerOptions,
                    lifecycleAuthority: () => session.lifecycle,
                  },
                  sessionKey: managed.authority.sessionHeader.sessionKey,
                  toolProfile: () => session.toolProfile,
                })
              : {}),
            shellAvailable: () =>
              isHostedWorkspaceShellProfile(session.toolProfile),
            hooksConfigured: () => session.hooks !== undefined,
          },
        );
      }
      // Self-paced /loop: every hosted Session owns its wakeup funnel — a
      // wakeup is a journal input the wake pump defers to its notBefore. The
      // arm-time review rides the active turn's permission classifier; with
      // none active the arm is refused rather than admitted unreviewed.
      session.loops = new HostedLoopSession(
        {
          authority: managed.authority,
          resources: managed.resources,
          sink: managed.sink,
        },
        managed.authority.sessionHeader.sessionKey,
        {
          cwd: session.cwd,
          classify: (input) =>
            session.loopClassify
              ? session.loopClassify(input)
              : Promise.resolve({
                  allowed: false,
                  reason: 'No active permission classifier for loop arming.',
                }),
          classifyFire: createHostedLoopFireClassifier({
            cwd: session.cwd,
            sessionId,
            modelConfig: session.modelConfig,
            model: session.agentDefinition?.model,
          }),
        },
      );
      // Fixed-interval /loop: the cron trio rides the internal automation
      // routes over the store channel; the arm-time review reuses the active
      // turn's permission classifier, refused when none is active.
      session.crons = session.stores
        ? new HostedCronSession(session.stores, session.loops, {
            classify: (input) =>
              session.loopClassify
                ? session.loopClassify(input)
                : Promise.resolve({
                    allowed: false,
                    reason: 'No active permission classifier for cron arming.',
                  }),
            shellAvailable: isHostedWorkspaceShellProfile(session.toolProfile),
            loopWakeupAvailable:
              session.toolProfile === HOSTED_WORKSPACE_SHELL_PROFILE_V3 ||
              session.toolProfile === HOSTED_WORKSPACE_SHELL_PROFILE_V4,
          })
        : undefined;
      // H5b: every hosted Session owns its channel funnel — a channel input
      // needs no Runtime, and its reply plans from the settled turn alone.
      if (!externalFiles && !externalShell) {
        session.channels = new HostedChannelSession(
          {
            authority: managed.authority,
            resources: managed.resources,
            sink: managed.sink,
          },
          managed.authority.sessionHeader.sessionKey,
        );
      }
      installHostedWakeScheduler({
        session,
        sessionId,
        cwd,
        brokerOptions,
        instance,
        releaseHeldRuntime,
      });
      if (pinned) session.approval = pinned;
      if (session.extensionBootstrapPending) {
        sessions.set(sessionId, session);
        armFor(sessionId);
        sendAttachment(res, sessionId, session);
        return;
      }
      // A takeover recovers exactly the parked Turn, including the file
      // history it left pending; only refuse a stranger's pending state.
      // A bare load of a parked Session keeps refusing with 409 so it never
      // drives a Runtime by accident.
      const unsettled = unsettledPromptId(session);
      if (
        (externalFiles || externalShell) &&
        unsettled &&
        (await readHostedTurnApprovalSelection(managed, unsettled))?.planMode
      ) {
        await managed.close();
        return error(res, 409, 'hosted_tool_profile_conflict');
      }
      const pendingContinuation =
        (session.extensions?.enabled || session.hooks || session.mcp) &&
        unsettled
          ? await findHostedApprovalContinuation(managed, unsettled)
          : undefined;
      // Cold loads stay inert: only an explicit takeover request may touch
      // the Broker or settle anything. A bare load of a parked Session keeps
      // refusing with 409 so it never drives a Runtime by accident.
      const takeover = !lifecycle && !session.hooks && takeoverFlags;
      // An extensions Session that also carries a Hook catalog never satisfies
      // `takeover` (hooks set), yet a parked command-step approval is still
      // recoverable by an explicit takeover load. Compute it once and use it
      // for BOTH the file-history settle exemption and the resume arm below,
      // so a batch that owes file history while a command step parks at
      // await_action is resumed rather than 409'd on a settle it can never
      // produce (R8-1 / R7-2).
      const extensionsCommandStepTakeover =
        takeoverFlags &&
        !lifecycle &&
        !!session.extensions?.enabled &&
        pendingContinuation?.plan.commandStep !== undefined;
      // A Hooks or MCP Session's saved native batch is recovered the same
      // way: only by an explicit takeover load, and only on a shape recovery
      // admits.
      const hooksNativePark =
        (session.hooks !== undefined || session.mcp !== undefined) &&
        pendingContinuation !== undefined &&
        pendingContinuation.plan.commandStep === undefined &&
        hostedApprovalResumeShapeRefusal(session, brokerOptions) === undefined;
      const hooksNativeTakeover =
        takeoverFlags && !lifecycle && hooksNativePark;
      // A parked command-step or Hooks native round must never be answered by
      // a cold load: answering writes a durable tool_result for one of the
      // plan's own calls, which permanently destroys the continuation. Both
      // answer guards below key on this one predicate. pendingContinuation is
      // computed unconditionally above; resumeApproval is only assigned inside
      // the takeover arm, so on a bare load it is undefined and cannot be the
      // key (R9-1).
      let resumeApproval: RestoredHostedApprovalContinuation | undefined;
      const continuationPark =
        pendingContinuation?.plan.commandStep !== undefined || hooksNativePark;
      // A Hooks Session recovers only through this load (it never takes
      // over), and the file-history gate below needs every call of the
      // pending round answered. The team and agent calls the dead Harness
      // never answered are answered first — a committed one by what
      // committed, any other as never run — or the gate would refuse this
      // Session on every load. A failed answer leaves the gate's retriable
      // refusal.
      if (
        session.hooks &&
        !lifecycle &&
        unsettled !== undefined &&
        !continuationPark
      ) {
        try {
          await answerResumedTurnCalls({
            session: managed,
            sessionId,
            cwd,
            promptId: unsettled,
            skills: session.skills,
            hooks: session.hooks,
            children: session.childAgents,
            teams: session.teams,
            messages: session.messages,
            commands: session.commands,
          });
        } catch (cause) {
          writeStderrLineSafe(
            `qwen serve: Hosted Session ${sessionId} could not answer the interrupted calls of ${unsettled}: ${String(cause)}`,
          );
        }
      }
      let fileHistory = await readHostedFileHistory(managed);
      // A settled Turn's marker can outlive its retirement: an earlier
      // incarnation owed the drop only in memory, so a restart before the
      // retry stranded it, and no route can retire a settled Turn's marker
      // once the Session is gone. Retire it from the durable events before
      // refusing; a parked Turn's marker (no turn.settled) is never touched
      // here, since a takeover still needs it to reconcile.
      const owedMarker = fileHistory?.pendingTurn;
      if (
        owedMarker &&
        managed.authority
          .eventsInSequenceRange(1, managed.authority.committedSequence)
          .some(
            (event) =>
              event.kind === 'turn.settled' &&
              event.payload['turnId'] === owedMarker,
          )
      ) {
        try {
          await dropPendingHostedFileHistoryTurn(managed, owedMarker);
          fileHistory = await readHostedFileHistory(managed);
        } catch (cause) {
          // The drop stays durable-owed: the gate below refuses as before
          // and the next load retries the retirement.
          writeStderrLineSafe(
            `qwen serve: Hosted Harness file-history retirement of settled Turn ${owedMarker} failed at load: ${String(cause)}`,
          );
        }
      }
      // H5/F5 follow-up: a pump-owned tool turn (channel or pr_event)
      // interrupted inside a Write/Edit owes the wake pump its recovery, but
      // refusing here would kill that pump before it started — the input is
      // pump-owned, so the takeover arithmetic above can never match its
      // pendingTurn. Let the load through: the pump proves the stop and
      // settles right after attachment.
      const pumpOwnedParked =
        fileHistory?.pendingTurn !== null &&
        fileHistory?.pendingTurn !== undefined &&
        isPumpOwnedToolTurn(session, fileHistory.pendingTurn);
      // A takeover's own parked Turn is exempt from the settle probe; a
      // stranger's record is named pending_turn_mismatch outright rather
      // than by whichever conjunct of it the probe trips first.
      const settle: HostedFileHistorySettlement | null =
        !fileHistory?.pendingUndo &&
        fileHistory?.pendingTurn &&
        !pumpOwnedParked
          ? (takeover ||
              extensionsCommandStepTakeover ||
              hooksNativeTakeover) &&
            unsettled !== undefined
            ? fileHistory.pendingTurn === unsettled
              ? null
              : { blocker: 'pending_turn_mismatch' }
            : await canSettleHostedFileHistory(managed, fileHistory)
          : null;
      if (fileHistory?.pendingUndo || settle !== null) {
        // The pending ids pass the record parser with a typeof check only,
        // and JSON.stringify emits U+2028/U+2029 raw: every Store-read field
        // is bounded before it reaches the single-line tag.
        const tagField = (value: string | null | undefined): string | null =>
          value == null ? null : sanitizeDaemonLogLine(value);
        writeStderrLineSafe(
          `qwen serve: Hosted Session ${sessionId} load refused (file_history_pending): ${JSON.stringify({ pendingTurn: tagField(fileHistory?.pendingTurn), pendingUndo: fileHistory?.pendingUndo ? { requestId: sanitizeDaemonLogLine(fileHistory.pendingUndo.requestId), promptId: sanitizeDaemonLogLine(fileHistory.pendingUndo.promptId) } : null, unsettled: tagField(unsettled), takeover, ground: settle?.blocker ?? null, groundDetail: settle?.detail ?? null })}`,
        );
        await managed.close();
        const pendingUndo = fileHistory?.pendingUndo != null;
        error(
          res,
          409,
          pendingUndo
            ? 'hosted_file_history_recovery_required'
            : 'hosted_turn_recovery_required',
          pendingUndo ? 'undo_unsettled' : 'file_history_unsettled',
        );
        return;
      }
      const restore = await managed.authority.restoreBundle();
      if (restore.recoveryStatus !== 'ok') {
        // Read the verdict BEFORE close(): sealing the journal makes every
        // later store read fail as "writer is not active", which the
        // authority erases into missing_state — reading after close would
        // leave only the retriable refusal and hide the durable reasons.
        // The bundle carries the ok/blocked verdict but not its reason, and
        // the reason is what decides the refusal: a durable parse/identity
        // failure can never change on retry, so it declines with its typed
        // reason, while transport shape keeps the retriable 409. The same
        // read feeds the refusal diagnostics below.
        const verdict = await managed.authority
          .harnessRunAuthorization()
          .catch(() => undefined);

        // The restore bundle is a spec'd closed set with no reason field,
        // so the blocked reason comes from the verdict read above; that read
        // already tolerates a faulting Store, so the tag cannot go down with
        // it either.
        const blocked =
          verdict?.status === 'blocked'
            ? ` reason=${verdict.reason}` +
              (verdict.message !== undefined
                ? ` message=${sanitizeDaemonLogLine(verdict.message)}`
                : '')
            : '';
        writeStderrLineSafe(
          `qwen serve: Hosted Session ${sessionId} load refused (restore_${restore.recoveryStatus}): basis=${String(restore.restoreBasis)} through=${restore.throughSequence}${blocked}`,
        );
        await managed.close();
        if (
          verdict?.status === 'blocked' &&
          isDurableBlockedVerdict(verdict) &&
          takeoverFlags &&
          body?.['passiveManagedRuntimeRecovery'] !== true
        ) {
          // A durable parse/identity failure can never change on retry, so
          // a DRIVE takeover declines with the typed reason. A bare load and
          // a cancellation-only load keep the baseline retriable refusal:
          // neither asked for a takeover answer, and nothing here may
          // terminalize for a cancellation.
          recoveryDeclined(res, 'checkpoint_blocked');
          return;
        }
        error(res, 409, 'hosted_turn_recovery_required', 'restore_blocked');
        return;
      }
      let incompletePublication = false;
      if (!create && workspaceProfile) {
        try {
          incompletePublication = await verifyWorkspaceRestore(
            session,
            preverified,
            stores.toolResultResources,
            restore.throughSequence,
          );
        } catch (cause) {
          writeStderrLineSafe(
            `qwen serve: Hosted Session ${sessionId} load refused (workspace_verify): ${sanitizeDaemonLogLine(String(cause))}`,
          );
          await managed.close();
          error(
            res,
            409,
            'hosted_turn_recovery_required',
            'restore_verification_failed',
          );
          return;
        }
        try {
          await stores.assertWritable();
        } catch (cause) {
          writeStderrLineSafe(
            `qwen serve: Hosted Session ${sessionId} load refused (workspace_writable): ${sanitizeDaemonLogLine(String(cause))}`,
          );
          await managed.close();
          error(
            res,
            409,
            'hosted_turn_recovery_required',
            'workspace_not_writable',
          );
          return;
        }
      }
      if (session.publicChildAgentsVersion === 1) {
        if (body?.['cancellationTakeover'] === true && unsettled)
          await stopPublicChildSource(session, unsettled);
        else await session.childAgents?.stopCancelledSources();
      }
      let resume: { promptId: string; text: string; parts: Part[] } | undefined;
      let resumeModel: HostedModelRequest | undefined;
      let committedModelOutput: { promptId: string } | undefined;
      if (
        takeover &&
        unsettled &&
        body?.['cancellationTakeover'] !== true &&
        !session.hooks &&
        !session.mcp
      ) {
        committedModelOutput = await findHostedCommittedModelOutput(
          managed,
          unsettled,
        );
        if (!committedModelOutput)
          resumeModel = await findHostedModelRequest(managed, unsettled);
        if (resumeModel) {
          const text = await hostedOriginalPromptText(managed, unsettled);
          if (text === undefined)
            throw new HostedToolRecoveryRequiredError(
              'Original model Prompt is missing.',
            );
          resume = { promptId: unsettled, text, parts: [] };
        }
      }
      // The extensions arm reuses extensionsCommandStepTakeover (computed with
      // the settle exemption above): an explicit, non-lifecycle takeover of an
      // extensions Session's parked command-step plan, even when a Hook catalog
      // makes `takeover` itself false. It is scoped to a command-step plan — a
      // native approval on an MCP Session is refused by resumeSavedNativeBatch,
      // so admitting it here would 503 the load instead of attaching (R7-2);
      // a Hooks Session's native plan takes the Hooks arm on the shape terms
      // its park eligibility read. Sharing the booleans with the settle
      // exemption keeps a file-history-owing batch recoverable instead of
      // 409'ing before this arm is consulted (R8-1).
      if (
        unsettled &&
        ((takeover &&
          hostedApprovalResumeShapeRefusal(session, brokerOptions) ===
            undefined) ||
          (extensionsCommandStepTakeover &&
            hostedCommandStepResumeShapeRefusal(session, brokerOptions) ===
              undefined) ||
          hooksNativeTakeover)
      ) {
        const verdict = await managed.authority.harnessRunAuthorization();
        if (
          verdict.status === 'runnable' &&
          ['before_model', 'await_action', 'model_output_committed'].includes(
            verdict.checkpoint.continuation.phase,
          )
        ) {
          resumeApproval =
            pendingContinuation ??
            (await findHostedApprovalContinuation(managed, unsettled));
          if (resumeApproval) {
            const text = await hostedOriginalPromptText(managed, unsettled);
            if (text === undefined)
              throw new HostedToolRecoveryRequiredError(
                'Original Prompt is missing.',
              );
            resume = { promptId: unsettled, text, parts: [] };
          }
        }
      }
      if (
        takeover &&
        unsettled &&
        (session.skills || session.memory) &&
        !resume &&
        !resumeApproval &&
        !committedModelOutput &&
        body?.['cancellationTakeover'] !== true &&
        (await parkNeedsNoRuntimeSettlement(managed))
      ) {
        const current = (await managed.sink.project()).filter(
          (record) => record.daemonPromptId === unsettled,
        );
        const assistant = current.findLast(
          (record) => record.type === 'assistant',
        );
        const calls = assistant?.message?.parts?.flatMap((part) =>
          part.functionCall ? [part.functionCall] : [],
        );
        const memoryResults = session.memory
          ? await findHostedMemoryResults(managed, unsettled)
          : undefined;
        if (
          memoryResults ||
          (session.skills &&
            calls?.length &&
            calls.every((call) => call.name === 'skill'))
        ) {
          if (!memoryResults)
            await answerResumedTurnCalls({
              session: managed,
              sessionId,
              cwd,
              promptId: unsettled,
              skills: session.skills,
              hooks: session.hooks,
            });
          const projected = (await managed.sink.project()).filter(
            (record) => record.daemonPromptId === unsettled,
          );
          const text = await hostedOriginalPromptText(managed, unsettled);
          if (text === undefined)
            throw new HostedToolRecoveryRequiredError(
              'Original Prompt is missing.',
            );
          const lastAssistant = projected.findLastIndex(
            (record) => record.type === 'assistant',
          );
          resume = {
            promptId: unsettled,
            text,
            parts:
              memoryResults ??
              projected
                .slice(lastAssistant + 1)
                .flatMap((record) => record.message?.parts ?? []),
          };
        }
      }
      let settlePromptId: string | undefined = committedModelOutput?.promptId;
      let recovery: HostedRuntimeRecoveryReport | undefined;
      // A takeover that answers inapplicable has spoken: the plain attach
      // must not fail the bare-load refusal below on its empty recovery.
      let inapplicableAnswer = false;
      if (
        restore.recoveryStatus === 'ok' &&
        unsettled !== undefined &&
        takeover &&
        !resumeApproval &&
        !resumeModel &&
        !resume &&
        !settlePromptId
      ) {
        // A parked Runtime turn is taken over, not refused: settle its
        // executions under their original ids (or report them for a
        // cancellation) and answer with the recovery snapshot. A Turn with
        // no Runtime work (a model round, or every Turn of a no-tool
        // Session) cannot be driven here: refuse it with a typed terminal
        // decline rather than a refusal the coordinator retries forever –
        // on the DRIVE shape. A cancellation-only load of the same shape
        // CANNOT answer "nothing is owed" either: there is no kernel to
        // ask, so no plain attach may be minted — the placeholder is the
        // baseline retriable refusal, and the cancel path re-issues when
        // the tools to settle exist. Attaching one here would stand up a
        // Session whose parked Turn no route may resolve (R5-2' round).
        // The cancellation separation (P1-1) splits "the Session is
        // configured for tools" from "the Turn owes unsettled Runtime
        // work": wherever NO unpaid Runtime work exists — checkpointless,
        // bootstrap, fully consumed, or an approval whose record says the
        // wait ended — the cancelled terminal can only be this journal,
        // so this load writes it itself; wherever Runtime work is in
        // flight, the recovery-cancel below is its faithful settlement,
        // and both must not be claimed by the same park. A no-tool
        // Session cannot owe Runtime work by definition, so its arm
        // settles unconditionally — the gate's checkpoint questions mean
        // nothing there, and gating on them re-wedged every cancelled
        // Turn after the first (R9).
        let cancellationSettled = false;
        if (
          body?.['cancellationTakeover'] === true &&
          (toolProfile === undefined ||
            !brokerOptions ||
            (await parkNeedsNoRuntimeSettlement(managed)))
        ) {
          if (
            typeof cancellationPromptId === 'string' &&
            (unsettled !== cancellationPromptId ||
              cancellationTargetState(managed, cancellationPromptId) !==
                'pending' ||
              unsettledPromptId(session) !== cancellationPromptId)
          ) {
            await managed.close();
            error(res, 409, 'hosted_cancel_identity_mismatch');
            return;
          }
          try {
            await settleCancelledHarnessTurn(
              managed,
              session,
              sessionId,
              unsettled,
            );
            writeStderrLineSafe(
              `qwen serve: Hosted Session ${sessionId} settles the cancelled park on load: prompt=${unsettled}`,
            );
            // The journal owes nothing more: the cancelled record is
            // the plain attach's whole answer, replayed home from the
            // kept watermark.
            inapplicableAnswer = true;
            cancellationSettled = true;
          } catch (cause) {
            writeStderrLineSafe(
              `qwen serve: Hosted Session ${sessionId} load refused (takeover_failed): profile=${toolProfile ?? 'none'} broker=${brokerOptions ? 'ready' : 'none'} settle=${sanitizeDaemonLogLine(String(cause))}`,
            );
            await managed.close();
            error(res, 409, 'hosted_turn_recovery_required', 'takeover_failed');
            return;
          }
        }
        if (toolProfile === undefined || !brokerOptions) {
          if (!cancellationSettled) {
            writeStderrLineSafe(
              `qwen serve: Hosted Session ${sessionId} load refused (takeover_unsupported): profile=${toolProfile ?? 'none'} broker=${brokerOptions ? 'ready' : 'none'}`,
            );
            await managed.close();
            if (body?.['passiveManagedRuntimeRecovery'] === true)
              error(
                res,
                409,
                'hosted_turn_recovery_required',
                'takeover_unsupported',
              );
            else recoveryDeclined(res, 'model_start');
            return;
          }
        } else if (!cancellationSettled) {
          try {
            const outcome = await recoverHostedRuntimeTurn({
              session: managed,
              canStart: session.poolAccepting,
              sessionId,
              cwd,
              promptId: unsettled,
              brokerOptions,
              passive: body?.['passiveManagedRuntimeRecovery'] === true,
              children: session.childAgents,
              teams: session.teams,
              messages: session.messages,
              commands: session.commands,
              onPassiveRuntimeAcquired: (runtimeSessionId) => {
                session.runtimeLeaseHeld = {
                  promptId: unsettled,
                  runtimeSessionId,
                };
              },
            });
            if (outcome.kind === 'inapplicable') {
              // R11-2: inapplicable pays only where a settlement route can.
              // A requested approval keeps the plain attach (the resolve
              // route writes the decision durably); turn_settled is settled
              // HERE — the bare branch's projection never ran on this arm,
              // so the missing terminal record is written by this load
              // itself — or the load keeps the retriable refusal when the
              // projection cannot pay either.
              const inapplicableVerdict = await managed.authority
                .harnessRunAuthorization()
                .catch(() => undefined);
              const approvalPending =
                inapplicableVerdict?.status === 'runnable' &&
                inapplicableVerdict.checkpoint.approval?.state === 'requested';
              if (approvalPending) {
                inapplicableAnswer = true;
              } else {
                const settle = await settleProjectablePromptId(
                  managed,
                  session,
                  fileHistory,
                  unsettled,
                );
                if (settle === null) {
                  // The adoption this load took stays owed: a release here
                  // would persist RELEASED and wedge every retried acquire
                  // of the identity, so the teardown's release pays it.
                  noteOwedAdoption(session, sessionId);
                  await managed.close();
                  writeStderrLineSafe(
                    `qwen serve: Hosted Session ${sessionId} load refused (takeover_inapplicable_unpayable): prompt=${unsettled}`,
                  );
                  error(
                    res,
                    409,
                    'hosted_turn_recovery_required',
                    'takeover_unrecovered',
                  );
                  return;
                }
                settlePromptId = settle;
                inapplicableAnswer = true;
              }
            } else if (outcome.kind === 'declined') {
              writeStderrLineSafe(
                `qwen serve: Hosted Session ${sessionId} load refused (takeover_unrecovered): prompt=${unsettled} reason=${outcome.reason}`,
              );
              await managed.close();
              recoveryDeclined(res, outcome.reason);
              return;
            } else if (outcome.kind === 'recovered') {
              recovery = outcome.turn.report;
              // Arm the undriven marker only for a recovery the producer
              // itself judges drivable — the coordinator fails an
              // undrivable one without ever arriving, and the Session must
              // not refuse every later route forever.
              if (outcome.turn.drivable)
                session.recoveredTurn = outcome.turn.promptId;
              if (outcome.turn.acquiredRuntime)
                session.runtimeLeaseHeld = {
                  promptId: outcome.turn.promptId,
                  runtimeSessionId: outcome.turn.runtimeSessionId,
                };
            }
            // inapplicable: nothing a takeover owes this payload — the load
            // continues as the plain attach it was before G3, so a requested
            // approval or a cancellation-only load meets its own path.
          } catch (cause) {
            noteOwedAdoption(session, sessionId);
            await managed.close();
            writeStderrLineSafe(
              `qwen serve: Hosted Harness recovery of session ${sessionId} failed: ${sanitizeDaemonLogLine(String(cause))}`,
            );
            if (cause instanceof HostedRecoveryQuiescingError) {
              error(res, 409, 'hosted_harness_quiescing');
              return;
            }
            // A failed takeover keeps the turn parked for the next attempt:
            // refuse exactly like a plain recovery refusal so the coordinator
            // retries instead of failing the Turn.
            error(res, 409, 'hosted_turn_recovery_required', 'takeover_failed');
            return;
          }
        }
      } else if (
        !lifecycle &&
        restore.recoveryStatus === 'ok' &&
        (session.publication || session.hooks || fileHistory) &&
        brokerOptions
      ) {
        const pendingInputs = new Set<string>();
        for (const event of managed.authority.eventsInSequenceRange(
          1,
          restore.throughSequence,
        )) {
          if (event.kind === 'input.accepted' && !isWakeOwnedInput(event))
            pendingInputs.add(event.payload['turnId'] as string);
          if (event.kind === 'turn.settled')
            pendingInputs.delete(event.payload['turnId'] as string);
        }
        const recoveredPromptId = session.publication
          ? await recoverShellReceipts(
              session,
              brokerOptions,
              restore.throughSequence,
            )
          : session.hooks && pendingInputs.size === 1
            ? [...pendingInputs][0]
            : null;
        const authorization = await managed.authority.harnessRunAuthorization();
        const promptId =
          recoveredPromptId ??
          (fileHistory &&
          hasUnsettledInput(session, restore.throughSequence) &&
          authorization.status === 'runnable'
            ? authorization.checkpoint.identity.promptId
            : null);
        // The resume below reads only the round's journaled results. A
        // sibling the Runtime does not own (a team call, a background
        // launch) is answered first: by what committed when it committed
        // before the Harness died — core's orphan repair would otherwise
        // have the model retry it — and as never run otherwise, so the
        // round the resume needs is whole.
        if (promptId && !continuationPark)
          await answerResumedTurnCalls({
            session: managed,
            sessionId,
            cwd,
            promptId,
            skills: session.skills,
            hooks: session.hooks,
            children: session.childAgents,
            teams: session.teams,
            messages: session.messages,
            commands: session.commands,
          });
        const projected = await managed.sink.project();
        const current = projected.filter(
          (item) => item.daemonPromptId === promptId,
        );
        const lastAssistant = current.findLastIndex(
          (item) => item.type === 'assistant',
        );
        const tail = current.slice(lastAssistant + 1);
        const user = current.find((item) => item.type === 'user');
        const prompt = user?.message?.parts
          ?.filter((part) => typeof part.text === 'string')
          .map((part) => part.text)
          .join('\n');
        const parts = tail.flatMap((item) => item.message?.parts ?? []);
        if (
          promptId &&
          authorization.status === 'runnable' &&
          authorization.checkpoint.continuation.phase === 'results_ready' &&
          authorization.checkpoint.tools?.items.every(
            (item) => item.state === 'settled',
          ) &&
          lastAssistant >= 0 &&
          tail.length > 0 &&
          tail.every((item) => item.type === 'tool_result') &&
          typeof prompt === 'string' &&
          prompt.length > 0 &&
          parts.length > 0 &&
          (!fileHistory ||
            (await canSettleHostedFileHistory(managed, {
              ...fileHistory,
              pendingTurn: promptId,
              pendingMessageId: current[lastAssistant].uuid,
            })) === null)
        )
          resume = { promptId, text: prompt, parts };
        if (
          promptId &&
          authorization.status === 'runnable' &&
          ['results_ready', 'turn_settled'].includes(
            authorization.checkpoint.continuation.phase,
          ) &&
          authorization.checkpoint.tools?.items.every(
            (item) =>
              item.state === 'settled' &&
              (authorization.checkpoint.continuation.phase === 'turn_settled' ||
                item.consumed),
          ) &&
          lastAssistant >= 0 &&
          tail.length === 0 &&
          current[lastAssistant].message?.parts?.every(
            (part) => !part.functionCall,
          )
        )
          settlePromptId = promptId;
      }
      // close() releases the activation, which commits a record and advances
      // committedSequence; bind the boundary once so the guard and the tag
      // name the deciding value.
      const unsettledThrough = workspaceProfile
        ? restore.throughSequence
        : managed.authority.committedSequence;
      if (
        incompletePublication ||
        (hasUnsettledInput(session, unsettledThrough) &&
          !resume &&
          !settlePromptId &&
          // A Hooks Session otherwise recovers through this load, but only a
          // takeover may resume a parked command step or native batch (R9-1).
          (!session.hooks || continuationPark) &&
          !recovery &&
          !inapplicableAnswer)
      ) {
        // A retry-inviting refusal keeps a takeover-adopted lease owed on
        // the Broker side: the coordinator's retried load re-acquires the
        // READY identity idempotently, while a release would persist
        // RELEASED and wedge every retry with runtime_session_not_acquirable.
        // This Session, though, is closed before registration, so no route
        // can ever see the owed lease again — record it and say so, or the
        // strand is silent until retirement.
        noteOwedAdoption(session, sessionId);
        writeStderrLineSafe(
          `qwen serve: Hosted Session ${sessionId} load refused (unsettled_input): ${JSON.stringify({ incompletePublication: !create && workspaceProfile ? incompletePublication : null, unsettled: [...unsettledInputsThrough(session, unsettledThrough)], resume: resume?.promptId ?? null, settle: settlePromptId ?? null, through: unsettledThrough })}`,
        );
        await managed.close();
        error(
          res,
          409,
          'hosted_turn_recovery_required',
          incompletePublication ? 'publication_incomplete' : 'turn_unsettled',
        );
        return;
      }
      if (!create && workspaceProfile) {
        try {
          await stores.assertWritable();
        } catch (cause) {
          // Same owed-lease discipline as the refusal above.
          noteOwedAdoption(session, sessionId);
          writeStderrLineSafe(
            `qwen serve: Hosted Session ${sessionId} load refused (workspace_writable): ${sanitizeDaemonLogLine(String(cause))}`,
          );
          await managed.close();
          error(
            res,
            409,
            'hosted_turn_recovery_required',
            'workspace_not_writable',
          );
          return;
        }
      }
      // A takeover that answered inapplicable still has its Turn payable:
      // park the persistent latch on genuinely unsettled work here
      // (recovery not produced and the request was a real takeover), but
      // NOT when the kernel told us nothing is owed — otherwise every
      // settlement route (resolve/continue/cancel/rewind/prompt) would
      // 409 on a Session the caller was just told attached (R5-2's latch).
      if (
        hasUnsettledInput(session, restore.throughSequence) &&
        !resume &&
        !settlePromptId &&
        !recovery &&
        !inapplicableAnswer
      )
        session.blocked = true;
      if (!session.lifecycle) await settleCancelledHookTurn(session);
      if (resume)
        await startHostedRecoveredTurn(
          session,
          sessionId,
          cwd,
          resume,
          brokerOptions,
          resumeApproval,
          resumeModel,
          body?.['cancellationTakeover'] === true,
        );
      const deliveryRecoveryLane = session.backgroundLane ?? session.shell;
      if (
        brokerOptions &&
        deliveryRecoveryLane &&
        session.stores?.publication &&
        !unsettledPromptId(session)
      ) {
        await reattachAndDrainBackgroundDeliveries({
          managed,
          lane: deliveryRecoveryLane,
          writerOwner: session.stores.publication,
          brokerOptions,
          childRuns: session.childRuns,
          monitors: session.monitors,
        });
      }
      if (
        brokerOptions &&
        hasHostedCleanupDebt(managed) &&
        !unsettledPromptId(session)
      ) {
        try {
          await retryHostedCleanup(session, brokerOptions);
        } catch (cause) {
          session.blocked = true;
          writeStderrLineSafe(
            'qwen serve: Cleanup remains owed: ' + String(cause),
          );
        }
      }
      // #13930 R1-2: the load restores the close's held-Runtime drain
      // obligation from the Broker's durable hold rows — the in-memory set
      // a restart emptied. Restore-only: the answer adds entries and never
      // discharges one, and a failed query loads without the obligation
      // rather than failing the load (the Workspace-level cascade stays
      // the backstop). The Broker answers Runtime Session ids, and
      // hostedRuntimeSessionId is idempotent, so the close's drain maps a
      // restored entry back to itself. The `!== 2` conjunct is the #13986 R1-3
      // gate, and it is NOT what keeps a restored config-scoped owner safe:
      // lifecycleProtocolVersion is only spread onto the resident when the
      // load carries a lifecycle authority, so a bare attach leaves it
      // undefined and this restore runs even for a Session that later settles
      // as v2 (R28-1). A load cannot know which protocol will close it, so the
      // protection lives at the release instead — both drains skip a
      // config-scoped owner unless the close is terminal (R13-1/R14-1).
      if (
        !create &&
        brokerOptions &&
        isHostedWorkspaceProfile(session.toolProfile) &&
        session.lifecycleProtocolVersion !== 2
      ) {
        try {
          const held = await new HostedWorkspaceBroker(
            brokerOptions,
            session.managed.authority.sessionHeader.sessionKey,
            sessionId,
          ).activeHoldRuntimeSessionIds();
          for (const runtimeSessionId of held)
            session.heldRuntimeTurns.add(runtimeSessionId);
        } catch (cause) {
          writeStderrLineSafe(
            `qwen serve: Hosted Session ${sessionId} could not restore its held Runtimes: ${sanitizeDaemonLogLine(String(cause))}`,
          );
        }
      }
      sessions.set(sessionId, session);
      armFor(sessionId);
      if (acceptingWork()) compressionFor(session).resume();
      // H6c: a settle → settle-revision crash window closes here. It runs
      // beside the pump's first turn: the funnel serializes its commits and
      // a settle is idempotent, so the order between the two is immaterial.
      if (acceptingWork()) {
        if (instance) openings.reconciliations += 1;
        void Promise.allSettled([
          session.automations
            ?.reconcileRuns()
            .catch((cause: unknown) =>
              writeStderrLineSafe(
                `qwen serve: Hosted automation runs of session ${sessionId} could not be reconciled: ${String(cause)}`,
              ),
            ),
          // H5c: a settle → plan crash window closes here, before the pump
          // can start another channel turn.
          session.channels
            ?.reconcileReplies()
            .catch((cause: unknown) =>
              writeStderrLineSafe(
                `qwen serve: Hosted channel replies of session ${sessionId} could not be reconciled: ${String(cause)}`,
              ),
            ),
        ]).finally(() => {
          if (instance) openings.reconciliations -= 1;
        });
      }
      session.monitorWake?.kick();
      // The registered Session now carries the owed lease itself; the
      // refusal-time record is discharged.
      refusedAdoptions.delete(sessionId);
      sendAttachment(res, sessionId, session, recovery);
      if (settlePromptId)
        runSettleProjection(
          session,
          sessionId,
          settlePromptId,
          brokerOptions,
          !!committedModelOutput,
        );
    } catch (thrown) {
      await managed?.close().catch(() => undefined);
      await stores.close().catch(() => undefined);
      // A refusal's close that failed both to release the activation and to
      // seal the writer rejects with both. The seal failure says what the
      // writer was left as, so the answer is classified on it: a fenced
      // writer must still answer its self-healing 409, not the generic 503.
      if (thrown instanceof ManagedSessionCloseError) {
        writeStderrLineSafe(
          `qwen serve: Hosted Session ${sessionId} close failed during open: ${sanitizeDaemonLogLine(String(thrown))}`,
        );
      }
      const cause =
        thrown instanceof ManagedSessionCloseError ? thrown.sealError : thrown;
      if (cause instanceof HostedRecoveryQuiescingError) {
        error(res, 409, 'hosted_harness_quiescing');
      } else if (cause instanceof HostedPublicChildRecoveryProfileChanged) {
        // #17260: same durable verdict as the attached redrive above — a
        // saved public-child profile this topology cannot open declines
        // terminally instead of the generic retriable open failure.
        recoveryDeclined(res, 'public_child_recovery_unsupported');
      } else if (isRetryableWorkspaceAcquisition(cause)) {
        error(res, 409, cause.code);
      } else if (
        cause instanceof ManagedSessionStoreHttpError &&
        cause.remoteCode === 'managed_session_writer_conflict'
      ) {
        // A fenced-but-alive predecessor's writer lease is the one 409 whose
        // wait self-heals when the lease lapses; it must not collapse into
        // the generic open failure, or the wait dies at the budget instead.
        error(res, 409, cause.remoteCode);
      } else if (cause instanceof ManagedSessionAlreadyExistsError) {
        error(res, 409, 'managed_session_already_exists');
      } else if (cause instanceof ManagedSessionNotFoundError) {
        error(res, 404, 'managed_session_not_found');
      } else {
        // A recovery-blocked load answers a bare 503 whose root cause (file
        // history drift, runnable-checkpoint classification) is otherwise
        // invisible to anyone diagnosing why the restore was refused.
        writeStderrLineSafe(
          'qwen serve: Hosted Session open failed: ' +
            String(
              cause instanceof Error && cause.cause !== undefined
                ? cause.cause
                : cause,
            ),
        );
        error(res, 503, 'managed_session_open_failed');
      }
    } finally {
      openings.inFlight.delete(sessionId);
      if (instance) {
        // A failed open may have acquired a writer without a release receipt.
        // Keep it unresolved until this Session attaches or the boot expires.
        if (sessions.has(sessionId)) openings.unresolved.delete(sessionId);
        else openings.unresolved.add(sessionId);
      }
    }
  };

  app.post('/session', (req, res) => {
    void open(req, res, true).finally(() => releaseColdOpenSlot(res));
  });
  app.post('/session/:id/load', (req, res) => {
    let held: HostedSession | undefined;
    void open(req, res, false, (session) => {
      held = session;
    }).finally(() => {
      if (held) held.hooksBusy = false;
      releaseColdOpenSlot(res);
    });
  });

  app.use('/session/:id', async (req, res, next) => {
    const session = sessions.get(req.params['id']);
    const suspension = suspensions.get(req.params['id']);
    if (suspension) {
      const refusal = suspensionRefusalCode(suspension);
      if (refusal) return error(res, 409, refusal);
      // Request-scoped work is counted until the handler ends its own
      // response, which every route reaches through res.json/send/error even
      // after its caller disconnected. The socket's 'close' is not that
      // moment: it fires while a disconnected caller's async tail is still
      // committing, and releasing there lets teardown start under live work.
      // A route that never ends its response keeps the Session resident —
      // the safe direction. Async tails that outlive the response (turns,
      // message operations, loops) are caught by the live-work recheck.
      if (req.method !== 'GET' && req.path !== '/heartbeat') {
        admitSuspensionWork(suspension);
        const end = res.end.bind(res) as (...args: unknown[]) => Response;
        let released = false;
        res.end = ((...args: unknown[]) => {
          if (!released) {
            released = true;
            releaseSuspensionWork(suspension);
          }
          return end(...args);
        }) as typeof res.end;
      }
    }
    if (instance && session && req.method !== 'GET') {
      if (!identity(req, sessions, req.method === 'DELETE'))
        return error(res, 404, 'hosted_session_not_found');
      if (session.ownershipRelease)
        return error(res, 409, 'hosted_harness_quiescing');
      if (!instance.accepting) {
        const kind = object(req.body)?.['kind'];
        const observed =
          [
            '/prompt',
            '/heartbeat',
            '/cancel',
            '/managed-runtime/cancel',
            '/lifecycle',
            '/detach',
          ].includes(req.path) ||
          req.method === 'DELETE' ||
          /^\/actions\/[^/]+\/resolve$/u.test(req.path) ||
          /\/(hooks|mcp)\/operations\/[^/]+\/cancel$/u.test(req.path) ||
          (req.path === '/children/operations' &&
            !['accept', 'mark_accepted', 'dispatch_started'].includes(
              String(kind),
            )) ||
          (req.path === '/messages/operations' &&
            [
              'accepted',
              'answered',
              'consumed',
              'cancelled',
              'rejected',
              'unknown',
              'consume',
            ].includes(String(kind))) ||
          (req.path === '/channels/operations' &&
            ['segment_receipt', 'settle_delivery', 'cancel_delivery'].includes(
              String(kind),
            )) ||
          (req.path === '/automations/operations' &&
            ['cancel_run', 'reconcile_run', 'retire_schedule'].includes(
              String(kind),
            ));
        if (!observed) return error(res, 409, 'hosted_harness_quiescing');
      }
    }
    if (
      session?.lifecycle &&
      req.method !== 'GET' &&
      !['/lifecycle', '/detach', '/heartbeat'].includes(req.path)
    ) {
      const legacyClose = req.method === 'DELETE' && req.path === '/';
      if (!identity(req, sessions, legacyClose))
        return error(res, 404, 'hosted_session_not_found');
      return error(res, 409, 'hosted_lifecycle_operation_active');
    }
    if (
      session &&
      req.method !== 'GET' &&
      !['/lifecycle', '/detach', '/heartbeat', '/cancel'].includes(req.path) &&
      !session.lifecycle
    ) {
      const legacyClose = req.method === 'DELETE' && req.path === '/';
      if (!identity(req, sessions, legacyClose))
        return error(res, 404, 'hosted_session_not_found');
      try {
        const extensionBody = object(req.body);
        const extensionCommand =
          object(extensionBody?.['command']) ?? extensionBody;
        const extensionOperation =
          req.method === 'POST' &&
          (req.path === '/extensions/management' ||
            (req.path === '/mcp/management' && session.extensions?.enabled))
            ? extensionCommand?.['operationId']
            : req.method === 'POST'
              ? /^\/extensions\/management\/operations\/([^/]+)\/(?:continue|recover-previous)$/u.exec(
                  req.path,
                )?.[1]
              : undefined;
        await session.stores!.authorizeOrdinary(
          legacyClose
            ? 'legacy-close'
            : typeof extensionOperation === 'string' &&
                HOSTED_UUID.test(extensionOperation)
              ? `configuration:${extensionOperation}`
              : undefined,
        );
        if (session.lifecycle)
          return error(res, 409, 'hosted_lifecycle_operation_active');
      } catch (cause) {
        if (
          req.method === 'POST' &&
          req.path === '/children/operations' &&
          cause instanceof ManagedSessionStoreHttpError &&
          cause.status === 409 &&
          isLifecycleFenceRemoteCode(cause.remoteCode)
        ) {
          // Closing work means lifecycle admission, so the parent's own
          // child cleanup presents the matching lifecycle claim instead:
          // the store itself verifies the operation id, claim generation
          // and lifecycle kind named by the call. The shared client keeps
          // the claim only for the evaluation — every outcome restores
          // the prior stamped authority, so a rejected or stale one never
          // hides the next request's own claim. No valid claim present
          // reverts to the exact ordinary refusal of before; a refused
          // claim answers as conflict, never a silent pass.
          const claim = object(object(req.body)?.['authority']);
          if (
            typeof claim?.['operationId'] !== 'string' ||
            typeof claim['claimGeneration'] !== 'number' ||
            (claim['kind'] !== 'close' && claim['kind'] !== 'delete')
          )
            return ordinaryAuthorizationError(res, cause);
          const authority = {
            operationId: claim['operationId'] as string,
            claimGeneration: claim['claimGeneration'] as number,
          };
          const kind = claim['kind'] as 'close' | 'delete';
          const previousAuthority = session.lifecycle;
          try {
            session.stores!.setLifecycleAuthority(authority);
            await session.stores!.authorizeLifecycle(kind);
          } catch (lifecycleCause) {
            session.stores!.setLifecycleAuthority(previousAuthority);
            if (
              lifecycleCause instanceof ManagedSessionStoreHttpError &&
              lifecycleCause.status === 409
            )
              return error(res, 409, 'hosted_lifecycle_operation_conflict');
            return ordinaryAuthorizationError(res, lifecycleCause);
          }
          // The claim stays stamped through the route handler's own
          // durable writes — the children/operations route is the only
          // boundary that closes it (restores the prior stamp), so a
          // claimed cleanup revision reaches the store with the claim,
          // and nothing after it inherits noise.
          res.locals['lifecycleRestoreAuthority'] = previousAuthority;
          noteActivity(req.params['id']);
          return next();
        }
        return ordinaryAuthorizationError(res, cause);
      }
    }
    // Admitted mutations reset the idle timer; reads, heartbeats and
    // refused requests never do.
    if (req.method !== 'GET' && req.path !== '/heartbeat')
      noteActivity(req.params['id']);
    next();
  });

  app.use('/session/:id', (req, res, next) => {
    const session = identity(req, sessions);
    if (
      session &&
      req.method !== 'GET' &&
      compressionBusy(session) &&
      (req.method === 'DELETE' ||
        /^\/(detach|lifecycle|title|files\/rewind|mcp|hooks)(\/|$)/u.test(
          req.path,
        ))
    )
      return error(res, 409, 'session_context_busy');
    next();
  });
}
