/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, expectTypeOf } from 'vitest';
import * as Public from '../../src/index.js';
import {
  DAEMON_KNOWN_EVENT_TYPE_VALUES,
  PENDING_PROMPT_ADDED_EVENT,
  PENDING_PROMPT_STARTED_EVENT,
  PENDING_PROMPT_COMPLETED_EVENT,
  asKnownDaemonEvent,
} from '../../src/daemon/events.js';
// Type-only imports also exercise the public entry: any name missing
// from `src/index.ts` is a tsc compile error and the suite refuses to
// build, which is the regression fence for the kind of "exists in
// `src/daemon/index.ts` but not re-exported by the published entry"
// gap that two-layer SDK re-exports are easy to drift on.
import type {
  DaemonClient,
  CreateStandaloneSessionOptions,
  DaemonArchiveStandaloneSessionsResult,
  DaemonDeleteStandaloneSessionsResult,
  DaemonRestoredStandaloneSession,
  DaemonSessionRestoreStrategy,
  DaemonStandaloneBatchError,
  DaemonStandaloneCreationRecovery,
  DaemonStandaloneDirectoryResult,
  DaemonStandaloneFields,
  DaemonStandaloneMetadataResult,
  DaemonStandaloneSession,
  DaemonStandaloneSessionCreating,
  DaemonStandaloneSessionListOptions,
  DaemonStandaloneSessionListPage,
  DaemonStandaloneSessionLookup,
  DaemonStandaloneSessionSummary,
  DaemonStandaloneWorkingDirectory,
  DaemonUnarchiveStandaloneSessionsResult,
  RestoreStandaloneSessionRequest,
  WorkspaceDaemonClient,
  DaemonClientEvictedData,
  DaemonClientEvictedEvent,
  DaemonChannelControlState,
  DaemonChannelControlTransition,
  DaemonChannelDelivery,
  DaemonChannelNotifyRequest,
  DaemonChannelNotifyResult,
  DaemonChannelPairingApprovalsSnapshot,
  DaemonChannelPairingSubject,
  DaemonChannelPairingRevocationRequest,
  DaemonChannelPairingRevocationResult,
  DaemonChannelDeliveryErrorCode,
  DaemonChannelDeliveryResultData,
  DaemonChannelDeliveryResultEvent,
  DaemonChannelSelection,
  DaemonChannelSetResult,
  DaemonChannelStartupAttemptFailure,
  DaemonChannelStartupFailure,
  DaemonChannelStopResult,
  DaemonChannelWorkerStartErrorResponse,
  DaemonControlEvent,
  DaemonEvent,
  DaemonEventEnvelope,
  DaemonGithubSetupCompletedData,
  DaemonGithubSetupCompletedEvent,
  DaemonGithubSetupGitignoreResult,
  DaemonGithubSetupRequest,
  DaemonGithubSetupResult,
  DaemonGithubSetupWorkflowResult,
  DaemonHistoryTruncatedData,
  DaemonHistoryTruncatedEvent,
  DaemonKnownEventType,
  DaemonModelSwitchedData,
  DaemonModelSwitchedEvent,
  DaemonModelSwitchFailedData,
  DaemonModelSwitchFailedEvent,
  DaemonLspServerStatus,
  DaemonPermissionOption,
  DaemonPermissionRequestData,
  DaemonPermissionRequestEvent,
  DaemonPermissionResolvedData,
  DaemonPermissionResolvedEvent,
  DaemonPendingPromptAddedData,
  DaemonPendingPromptAddedEvent,
  DaemonPendingPromptStartedData,
  DaemonPendingPromptStartedEvent,
  DaemonPendingPromptCompletedData,
  DaemonPendingPromptCompletedEvent,
  DaemonPendingPromptEvent,
  DaemonPendingPromptSummary,
  DaemonPendingPromptsResult,
  DaemonSessionLspStatus,
  DaemonRuntimeMcpAddRequest,
  DaemonRuntimeMcpAddResult,
  DaemonRuntimeMcpRemoveResult,
  DaemonSessionDiedData,
  DaemonSessionDiedEvent,
  DaemonSessionEvent,
  DaemonSessionCatalogVersion,
  DaemonSessionLiveState,
  DaemonSessionTurnIndexEntry,
  DaemonSessionTurnIndexPage,
  DaemonSessionTurnIndexPageOptions,
  DaemonWorkspaceSessionLiveState,
  DaemonSessionRecapResult,
  DaemonSkillBatchToggleError,
  DaemonSkillBatchToggleErrorCode,
  DaemonSkillBatchToggleItem,
  DaemonSkillBatchToggleResult,
  ExtensionDefaultActivationBatchItem,
  ExtensionMutationResponse,
  ExtensionWorkspaceActivationBatchItem,
  ExtensionWorkspaceBatchActivationState,
  DaemonSessionRecordingDegradedData,
  DaemonSessionRecordingDegradedEvent,
  DaemonSessionUpdateData,
  DaemonSessionUpdateEvent,
  DaemonSessionViewState,
  DaemonLogHealth,
  DaemonLogIssue,
  DaemonLogMode,
  DaemonStatusReport,
  DaemonStatusReportDetail,
  DaemonStatusReportIssue,
  DaemonStatusReportLevel,
  DaemonStatusReportSection,
  DaemonStatusReportSession,
  DaemonStreamErrorData,
  DaemonStreamErrorEvent,
  DaemonStreamLifecycleEvent,
  DaemonTrustChangeRequestedData,
  DaemonTrustChangeRequestedEvent,
  DaemonWorkspaceTrustChangeRequest,
  DaemonWorkspaceTrustChangeResult,
  DaemonWorkspaceTrustDesiredState,
  DaemonWorkspaceTrustLevel,
  DaemonWorkspaceTrustSource,
  DaemonWorkspaceTrustState,
  DaemonWorkspaceTrustStatus,
  DaemonWorkspaceUpdate,
  DaemonWorkspaceMemoryDreamOptions,
  DaemonWorkspaceMemoryDreamResult,
  DaemonWorkspaceMemoryDreamTask,
  DaemonWorkspaceMemoryForgetMatch,
  DaemonWorkspaceMemoryForgetOptions,
  DaemonWorkspaceMemoryForgetResult,
  DaemonWorkspaceMemoryForgetTask,
  DaemonVoiceAudioInput,
  DaemonVoiceMode,
  DaemonVoiceModelDescriptor,
  DaemonVoiceTransport,
  DaemonWorkspaceMemoryRememberContextMode,
  DaemonWorkspaceMemoryRememberOptions,
  DaemonWorkspaceMemoryRememberResult,
  DaemonWorkspaceMemoryRememberTask,
  DaemonWorkspaceMemoryRememberTaskStatus,
  DaemonWorkspaceMemoryTaskStatus,
  DaemonWorkspaceMemoryTopic,
  DaemonWorkspaceVoiceStatus,
  DaemonWorkspaceVoiceTranscribeOptions,
  DaemonWorkspaceVoiceTranscriptionResult,
  DaemonWorkspaceVoiceUpdate,
  KnownDaemonEvent,
} from '../../src/index.js';
import {
  DAEMON_UI_DEBUG_REASONS,
  DAEMON_UI_UNRECOGNIZED_DIAGNOSTIC_REASONS,
  isTaskExecutionMode,
  selectUnrecognizedDiagnostics,
  UNRECOGNIZED_DIAGNOSTICS_LIMIT,
} from '../../src/daemon/index.js';
import type {
  DaemonChannelStartupAttemptFailure as DaemonEntryChannelStartupAttemptFailure,
  DaemonChannelStartupFailure as DaemonEntryChannelStartupFailure,
  DaemonChannelWorkerStartErrorResponse as DaemonEntryChannelWorkerStartErrorResponse,
  DaemonUiDebugReason as DaemonEntryUiDebugReason,
  DaemonUnrecognizedDiagnostic as DaemonEntryUnrecognizedDiagnostic,
  DaemonUnrecognizedDiagnosticReason as DaemonEntryUnrecognizedDiagnosticReason,
} from '../../src/daemon/index.js';

describe('public SDK entry — typed daemon event surface (#4217)', () => {
  it('exports the runtime narrow + reducer surface', () => {
    expect(typeof Public.asKnownDaemonEvent).toBe('function');
    expect(typeof Public.isKnownDaemonEvent).toBe('function');
    expect(typeof Public.isDaemonEventType).toBe('function');
    expect(typeof Public.reduceDaemonSessionEvent).toBe('function');
    expect(typeof Public.reduceDaemonSessionEvents).toBe('function');
    expect(typeof Public.createDaemonSessionViewState).toBe('function');
    expect(Public.PENDING_PROMPT_ADDED_EVENT).toBe(PENDING_PROMPT_ADDED_EVENT);
    expect(Public.PENDING_PROMPT_STARTED_EVENT).toBe(
      PENDING_PROMPT_STARTED_EVENT,
    );
    expect(Public.PENDING_PROMPT_COMPLETED_EVENT).toBe(
      PENDING_PROMPT_COMPLETED_EVENT,
    );
    // F2 (#4175 commit 6 review fix — claude-opus-4-7 W121): pin
    // `isWorkspaceScopedBudgetEvent` to the SDK public surface. PR
    // description + event JSDoc tell consumers to use this helper to
    // branch on `scope === 'workspace'`; without this pinning the
    // export could silently drop on a future barrel reshuffle (same
    // failure mode caught for PR-21 auth surface).
    expect(typeof Public.isWorkspaceScopedBudgetEvent).toBe('function');
    expect('projectChatRecordsToDaemonTranscript' in Public).toBe(false);
    expect(Public.STANDALONE_SESSIONS_CAPABILITY).toBe(
      'standalone_sessions_v1',
    );
    expect(typeof Public.isStandaloneSessionNotFoundError).toBe('function');
    expect(typeof Public.isStandaloneCreationOutcomeUnknown).toBe('function');
    expect(typeof Public.DaemonStandaloneProtocolError).toBe('function');
    expect(typeof Public.DaemonStandaloneCreationOutcomeUnknownError).toBe(
      'function',
    );
  });

  it('exports standalone session SDK types from the package entry', () => {
    expectTypeOf<CreateStandaloneSessionOptions>().not.toBeNever();
    expectTypeOf<RestoreStandaloneSessionRequest>().not.toBeNever();
    expectTypeOf<DaemonStandaloneSession>().not.toBeNever();
    expectTypeOf<DaemonRestoredStandaloneSession>().not.toBeNever();
    expectTypeOf<DaemonStandaloneSessionSummary>().not.toBeNever();
    expectTypeOf<DaemonStandaloneSessionLookup>().not.toBeNever();
    expectTypeOf<DaemonStandaloneSessionListOptions>().not.toBeNever();
    expectTypeOf<DaemonStandaloneSessionListPage>().not.toBeNever();
    expectTypeOf<DaemonStandaloneDirectoryResult>().not.toBeNever();
    expectTypeOf<DaemonStandaloneMetadataResult>().not.toBeNever();
    expectTypeOf<DaemonArchiveStandaloneSessionsResult>().not.toBeNever();
    expectTypeOf<DaemonUnarchiveStandaloneSessionsResult>().not.toBeNever();
    expectTypeOf<DaemonDeleteStandaloneSessionsResult>().not.toBeNever();
    expectTypeOf<DaemonStandaloneBatchError>().not.toBeNever();
    expectTypeOf<DaemonStandaloneFields>().not.toBeNever();
    expectTypeOf<DaemonStandaloneSessionCreating>().not.toBeNever();
    expectTypeOf<DaemonStandaloneWorkingDirectory>().not.toBeNever();
    expectTypeOf<DaemonStandaloneCreationRecovery>().not.toBeNever();
    expectTypeOf<DaemonSessionRestoreStrategy>().not.toBeNever();
    expectTypeOf<DaemonSessionTurnIndexEntry>().not.toBeNever();
    expectTypeOf<DaemonSessionTurnIndexPage>().not.toBeNever();
    expectTypeOf<DaemonSessionTurnIndexPageOptions>().not.toBeNever();
  });

  it('round-trips a raw DaemonEvent through the public narrow helper', () => {
    // Pin the user-facing contract: `import { asKnownDaemonEvent }
    // from '@qwen-code/sdk'` must work end-to-end via the published
    // entry, not just exist as a re-export inside src/daemon/index.ts.
    const evt: DaemonEvent = {
      id: 1,
      v: 1,
      type: 'model_switched',
      data: { sessionId: 'sess-1', modelId: 'qwen-plus' },
    };
    const narrowed = Public.asKnownDaemonEvent(evt);
    if (narrowed?.type === 'model_switched') {
      expect(narrowed.data.modelId).toBe('qwen-plus');
    } else {
      expect.fail('expected typed model_switched');
    }
  });

  it('exposes the typed event schema types at the public entry (compile-time)', () => {
    // The type-only imports at the top of this file would fail to
    // compile if any of these names were absent from src/index.ts.
    // The runtime expectations below document the surface set the
    // SDK promises to ship and give tooling that ignores type-only
    // imports a runtime assertion trail.
    expectTypeOf<KnownDaemonEvent>().not.toBeNever();
    expectTypeOf<DaemonSessionEvent>().not.toBeNever();
    expectTypeOf<DaemonControlEvent>().not.toBeNever();
    expectTypeOf<DaemonStreamLifecycleEvent>().not.toBeNever();
    expectTypeOf<DaemonSessionViewState>().not.toBeNever();
    expectTypeOf<DaemonKnownEventType>().not.toBeNever();
    expectTypeOf<DaemonEventEnvelope<'foo', { x: 1 }>>().not.toBeNever();

    expectTypeOf<DaemonSessionUpdateEvent>().not.toBeNever();
    expectTypeOf<DaemonPermissionRequestEvent>().not.toBeNever();
    expectTypeOf<DaemonPermissionResolvedEvent>().not.toBeNever();
    expectTypeOf<DaemonPendingPromptAddedEvent>().not.toBeNever();
    expectTypeOf<DaemonPendingPromptStartedEvent>().not.toBeNever();
    expectTypeOf<DaemonPendingPromptCompletedEvent>().not.toBeNever();
    expectTypeOf<DaemonPendingPromptEvent>().not.toBeNever();
    expectTypeOf<DaemonModelSwitchedEvent>().not.toBeNever();
    expectTypeOf<DaemonModelSwitchFailedEvent>().not.toBeNever();
    expectTypeOf<DaemonSessionDiedEvent>().not.toBeNever();
    expectTypeOf<DaemonSessionRecordingDegradedEvent>().not.toBeNever();
    expectTypeOf<DaemonClientEvictedEvent>().not.toBeNever();
    expectTypeOf<DaemonHistoryTruncatedEvent>().not.toBeNever();
    expectTypeOf<DaemonStreamErrorEvent>().not.toBeNever();

    expectTypeOf<DaemonSessionUpdateData>().not.toBeNever();
    expectTypeOf<DaemonPermissionRequestData>().not.toBeNever();
    expectTypeOf<DaemonPermissionResolvedData>().not.toBeNever();
    expectTypeOf<DaemonPendingPromptAddedData>().not.toBeNever();
    expectTypeOf<DaemonPendingPromptStartedData>().not.toBeNever();
    expectTypeOf<DaemonPendingPromptCompletedData>().not.toBeNever();
    expectTypeOf<DaemonPendingPromptSummary>().not.toBeNever();
    expectTypeOf<DaemonPendingPromptsResult>().not.toBeNever();
    expectTypeOf<DaemonModelSwitchedData>().not.toBeNever();
    expectTypeOf<DaemonModelSwitchFailedData>().not.toBeNever();
    expectTypeOf<DaemonSessionDiedData>().not.toBeNever();
    expectTypeOf<DaemonSessionRecordingDegradedData>().not.toBeNever();
    expectTypeOf<DaemonClientEvictedData>().not.toBeNever();
    expectTypeOf<DaemonChannelSelection>().not.toBeNever();
    expectTypeOf<DaemonChannelDelivery>().not.toBeNever();
    expectTypeOf<DaemonChannelNotifyRequest>().not.toBeNever();
    expectTypeOf<DaemonChannelNotifyResult>().not.toBeNever();
    expectTypeOf<DaemonChannelPairingApprovalsSnapshot>().not.toBeNever();
    expectTypeOf<DaemonChannelPairingSubject>().not.toBeNever();
    expectTypeOf<DaemonChannelPairingRevocationRequest>().not.toBeNever();
    expectTypeOf<DaemonChannelPairingRevocationResult>().not.toBeNever();
    expectTypeOf<DaemonChannelDeliveryErrorCode>().not.toBeNever();
    expectTypeOf<DaemonChannelDeliveryResultData>().not.toBeNever();
    expectTypeOf<DaemonChannelDeliveryResultEvent>().not.toBeNever();
    expectTypeOf<DaemonChannelControlTransition>().not.toBeNever();
    expectTypeOf<DaemonChannelControlState>().not.toBeNever();
    expectTypeOf<DaemonChannelSetResult>().not.toBeNever();
    expectTypeOf<DaemonChannelStartupFailure>().not.toBeNever();
    expectTypeOf<DaemonChannelStartupAttemptFailure>().not.toBeNever();
    expectTypeOf<DaemonChannelStopResult>().not.toBeNever();
    expectTypeOf<DaemonChannelWorkerStartErrorResponse>().not.toBeNever();
    expectTypeOf<DaemonChannelStartupFailure>().toEqualTypeOf<DaemonEntryChannelStartupFailure>();
    expectTypeOf<DaemonChannelStartupAttemptFailure>().toEqualTypeOf<DaemonEntryChannelStartupAttemptFailure>();
    expectTypeOf<DaemonChannelWorkerStartErrorResponse>().toEqualTypeOf<DaemonEntryChannelWorkerStartErrorResponse>();
    expectTypeOf<DaemonHistoryTruncatedData>().not.toBeNever();
    expectTypeOf<DaemonStreamErrorData>().not.toBeNever();
    expectTypeOf<DaemonPermissionOption>().not.toBeNever();
    expectTypeOf<DaemonLspServerStatus>().not.toBeNever();
    expectTypeOf<DaemonSessionLspStatus>().not.toBeNever();
    expectTypeOf<DaemonTrustChangeRequestedData>().not.toBeNever();
    expectTypeOf<DaemonTrustChangeRequestedEvent>().not.toBeNever();
    expectTypeOf<DaemonWorkspaceTrustChangeRequest>().not.toBeNever();
    expectTypeOf<DaemonWorkspaceTrustChangeResult>().not.toBeNever();
    expectTypeOf<DaemonWorkspaceTrustDesiredState>().not.toBeNever();
    expectTypeOf<DaemonWorkspaceTrustLevel>().not.toBeNever();
    expectTypeOf<DaemonWorkspaceTrustSource>().not.toBeNever();
    expectTypeOf<DaemonWorkspaceTrustState>().not.toBeNever();
    expectTypeOf<DaemonWorkspaceTrustStatus>().not.toBeNever();
    expectTypeOf<DaemonWorkspaceUpdate>().toEqualTypeOf<{
      displayName: string | null;
    }>();
    expectTypeOf<DaemonVoiceAudioInput>().not.toBeNever();
    expectTypeOf<DaemonVoiceMode>().not.toBeNever();
    expectTypeOf<DaemonVoiceModelDescriptor>().not.toBeNever();
    expectTypeOf<DaemonVoiceTransport>().not.toBeNever();
    expectTypeOf<DaemonWorkspaceVoiceStatus>().not.toBeNever();
    expectTypeOf<DaemonWorkspaceVoiceTranscribeOptions>().not.toBeNever();
    expectTypeOf<DaemonWorkspaceVoiceTranscriptionResult>().not.toBeNever();
    expectTypeOf<DaemonWorkspaceVoiceUpdate>().not.toBeNever();
    expectTypeOf<DaemonWorkspaceMemoryRememberContextMode>().not.toBeNever();
    expectTypeOf<DaemonWorkspaceMemoryRememberOptions>().not.toBeNever();
    expectTypeOf<DaemonWorkspaceMemoryRememberResult>().not.toBeNever();
    expectTypeOf<DaemonWorkspaceMemoryRememberTask>().not.toBeNever();
    expectTypeOf<DaemonWorkspaceMemoryRememberTaskStatus>().not.toBeNever();
    expectTypeOf<DaemonWorkspaceMemoryTaskStatus>().not.toBeNever();
    expectTypeOf<DaemonWorkspaceMemoryTopic>().not.toBeNever();
    expectTypeOf<DaemonWorkspaceMemoryForgetMatch>().not.toBeNever();
    expectTypeOf<DaemonWorkspaceMemoryForgetOptions>().not.toBeNever();
    expectTypeOf<DaemonWorkspaceMemoryForgetResult>().not.toBeNever();
    expectTypeOf<DaemonWorkspaceMemoryForgetTask>().not.toBeNever();
    expectTypeOf<DaemonWorkspaceMemoryDreamOptions>().not.toBeNever();
    expectTypeOf<DaemonWorkspaceMemoryDreamResult>().not.toBeNever();
    expectTypeOf<DaemonWorkspaceMemoryDreamTask>().not.toBeNever();
    expectTypeOf<DaemonGithubSetupCompletedData>().not.toBeNever();
    expectTypeOf<DaemonGithubSetupCompletedEvent>().not.toBeNever();
    expectTypeOf<DaemonGithubSetupGitignoreResult>().not.toBeNever();
    expectTypeOf<DaemonGithubSetupRequest>().not.toBeNever();
    expectTypeOf<DaemonGithubSetupResult>().not.toBeNever();
    expectTypeOf<DaemonGithubSetupWorkflowResult>().not.toBeNever();
    // #4175 follow-up: the recap result type lives under the daemon
    // sub-barrel and is re-exported at the top-level. Without this
    // assertion a future barrel reshuffle could silently drop the
    // result type SDK consumers need to type `client.recapSession`.
    expectTypeOf<DaemonSessionRecapResult>().not.toBeNever();
    expectTypeOf<DaemonLspServerStatus>().not.toBeNever();
    expectTypeOf<DaemonSessionLspStatus>().not.toBeNever();
    // Batch Skill toggle surface: type-only imports are erased at vitest
    // runtime, so the prototype check is the fence that actually executes
    // here; the shape assertions pin the contract for any tsc pass.
    expect(typeof Public.DaemonClient.prototype.setWorkspaceSkillsEnabled).toBe(
      'function',
    );
    expectTypeOf<
      Awaited<ReturnType<DaemonClient['setWorkspaceSkillsEnabled']>>
    >().toEqualTypeOf<DaemonSkillBatchToggleResult>();
    expectTypeOf<DaemonSkillBatchToggleItem>().toEqualTypeOf<{
      skillName: string;
      enabled: boolean;
      changed: boolean;
    }>();
    expectTypeOf<DaemonSkillBatchToggleError>().toEqualTypeOf<{
      skillName: string;
      code: DaemonSkillBatchToggleErrorCode;
      error: string;
      reason?: 'not_user_invocable' | 'inactive_extension' | 'locked';
      lockedScope?: 'system' | 'user' | 'systemDefaults';
    }>();
    expect(
      typeof Public.DaemonClient.prototype.setExtensionDefaultActivations,
    ).toBe('function');
    expect(
      typeof Public.WorkspaceDaemonClient.prototype.setExtensionActivations,
    ).toBe('function');
    expectTypeOf<
      Awaited<ReturnType<DaemonClient['setExtensionDefaultActivations']>>
    >().toEqualTypeOf<ExtensionMutationResponse>();
    expectTypeOf<
      Awaited<ReturnType<WorkspaceDaemonClient['setExtensionActivations']>>
    >().toEqualTypeOf<ExtensionMutationResponse>();
    expectTypeOf<
      Parameters<DaemonClient['setExtensionDefaultActivations']>
    >().toEqualTypeOf<
      [
        extensionNames: readonly string[],
        state: 'enabled' | 'disabled',
        clientId?: string,
      ]
    >();
    expectTypeOf<
      Parameters<WorkspaceDaemonClient['setExtensionActivations']>
    >().toEqualTypeOf<
      [
        extensionNames: readonly string[],
        state: ExtensionWorkspaceBatchActivationState,
        clientId?: string,
      ]
    >();
    expectTypeOf<ExtensionWorkspaceBatchActivationState>().toEqualTypeOf<
      'enabled' | 'disabled' | 'inherit'
    >();
    expectTypeOf<ExtensionDefaultActivationBatchItem>().toEqualTypeOf<{
      name: string;
      defaultActivation: 'enabled' | 'disabled';
    }>();
    expectTypeOf<ExtensionWorkspaceActivationBatchItem>().toEqualTypeOf<{
      name: string;
      workspaceActivation: 'enabled' | 'disabled' | null;
      effectiveActivation: 'enabled' | 'disabled';
    }>();
    expectTypeOf<
      NonNullable<
        NonNullable<
          Awaited<ReturnType<DaemonClient['extensionOperation']>>['result']
        >['results']
      >
    >().toEqualTypeOf<
      Array<
        | ExtensionDefaultActivationBatchItem
        | ExtensionWorkspaceActivationBatchItem
      >
    >();
    // `GET /daemon/status` report surface (PR 5174 client coverage): the
    // envelope plus the sub-shapes UI dashboards need to type against.
    expectTypeOf<DaemonStatusReport>().not.toBeNever();
    expectTypeOf<DaemonLogMode>().not.toBeNever();
    expectTypeOf<DaemonLogHealth>().not.toBeNever();
    expectTypeOf<DaemonLogIssue>().not.toBeNever();
    expectTypeOf<
      DaemonStatusReport['limits']['compactedReplayMaxBytes']
    >().toEqualTypeOf<number>();
    expectTypeOf<
      Pick<
        DaemonStatusReport['limits'],
        | 'acpPreAttachMaxFramesPerStream'
        | 'acpPreAttachMaxFramesPerConnection'
        | 'acpPreAttachMaxFramesGlobal'
        | 'acpPreAttachMaxPayloadBytesPerConnection'
        | 'acpPreAttachMaxPayloadBytesGlobal'
      >
    >().toEqualTypeOf<{
      acpPreAttachMaxFramesPerStream?: number | null;
      acpPreAttachMaxFramesPerConnection?: number | null;
      acpPreAttachMaxFramesGlobal?: number | null;
      acpPreAttachMaxPayloadBytesPerConnection?: number | null;
      acpPreAttachMaxPayloadBytesGlobal?: number | null;
    }>();
    expectTypeOf<
      DaemonStatusReport['limits']['acpPreAttachMaxPayloadBytesGlobal']
    >().toEqualTypeOf<number | null | undefined>();
    expectTypeOf<
      Pick<DaemonStatusReport['runtime']['transport']['acp'], 'preAttach'>
    >().toEqualTypeOf<{
      preAttach?: {
        bufferedConnectionFrames: number;
        bufferedSessionFrames: number;
        pendingDeliveryFrames: number;
        usedFrames: number;
        usedBytes: number;
        highWaterFrames: number;
        highWaterBytes: number;
        guardFailures: number;
      };
    }>();
    expectTypeOf<undefined>().toMatchTypeOf<
      DaemonStatusReport['runtime']['transport']['acp']['preAttach']
    >();
    expectTypeOf<
      Pick<
        NonNullable<DaemonStatusReport['full']>['acpConnections'][number],
        | 'bufferedConnectionFrames'
        | 'bufferedSessionFrames'
        | 'pendingDeliveryFrames'
        | 'preAttachOwnedFrames'
        | 'preAttachOwnedBytes'
      >
    >().toEqualTypeOf<{
      bufferedConnectionFrames?: number;
      bufferedSessionFrames?: number;
      pendingDeliveryFrames?: number;
      preAttachOwnedFrames?: number;
      preAttachOwnedBytes?: number;
    }>();
    expectTypeOf<
      NonNullable<
        DaemonStatusReport['full']
      >['acpConnections'][number]['preAttachOwnedFrames']
    >().toEqualTypeOf<number | undefined>();
    const legacyAcpConnections: NonNullable<
      DaemonStatusReport['full']
    >['acpConnections'] = [{}];
    expect(legacyAcpConnections).toHaveLength(1);
    expectTypeOf<
      NonNullable<
        DaemonStatusReport['full']
      >['acpConnections'][number]['connectionIdPrefix']
    >().toEqualTypeOf<string | undefined>();
    expectTypeOf<undefined>().toMatchTypeOf<
      NonNullable<DaemonStatusReport['full']>['acpMounts']
    >();
    expectTypeOf<
      NonNullable<
        NonNullable<DaemonStatusReport['full']>['acpMounts']
      >[number]['preAttachGuardFailures']
    >().toEqualTypeOf<number>();
    expectTypeOf<DaemonStatusReport['daemon']>().toMatchTypeOf<{
      runId?: string;
      logMode?: DaemonLogMode;
      logHealth?: DaemonLogHealth;
      logIssues?: readonly DaemonLogIssue[];
      logDroppedRecords?: number;
      logDroppedBytes?: number;
    }>();
    expectTypeOf<DaemonStatusReportDetail>().not.toBeNever();
    expectTypeOf<DaemonStatusReportIssue>().not.toBeNever();
    expectTypeOf<DaemonStatusReportLevel>().not.toBeNever();
    expectTypeOf<DaemonStatusReportSection>().not.toBeNever();
    expectTypeOf<DaemonStatusReportSession>().not.toBeNever();
  });

  it('exposes the workspace session live-state surface at the public entry', () => {
    // The prototype checks execute under vitest (type-only imports are
    // erased). The type shape assertions pin the wire contract via the
    // package typecheck, which compiles this file through
    // tsconfig.test-fence.json — the default tsconfig excludes test/.
    expect(
      typeof Public.DaemonClient.prototype.getWorkspaceSessionLiveState,
    ).toBe('function');
    expect(
      typeof Public.WorkspaceDaemonClient.prototype.getSessionLiveState,
    ).toBe('function');
    expectTypeOf<DaemonSessionCatalogVersion>().toEqualTypeOf<{
      generation: string;
      revision: number;
    }>();
    expectTypeOf<DaemonSessionLiveState>().toEqualTypeOf<{
      sessionId: string;
      clientCount: number;
      hasActivePrompt: boolean;
      isWaitingForPermission: boolean;
      isWaitingForUserQuestion: boolean;
      updatedAt?: string;
    }>();
    expectTypeOf<DaemonWorkspaceSessionLiveState>().toEqualTypeOf<{
      v: 1;
      catalogVersion: DaemonSessionCatalogVersion;
      sessions: DaemonSessionLiveState[];
    }>();
  });

  it('exposes the PR 21 auth device-flow surface at the public entry', () => {
    // PR #4255 fold-in 9 review thread #11: the auth surface had
    // been re-exported from `src/daemon/index.ts` but never from
    // the published `src/index.ts`, so SDK consumers got
    // `undefined` for everything except `client.auth.start()`
    // (which traveled through the already-exported `DaemonClient`).
    expect(typeof Public.DaemonAuthFlow).toBe('function');
    expect(typeof Public.reduceDaemonAuthEvent).toBe('function');
    expect(typeof Public.reduceDaemonAuthEvents).toBe('function');
    expect(typeof Public.createDaemonAuthState).toBe('function');
    expect(typeof Public.DEVICE_FLOW_EXPIRY_GRACE_MS).toBe('number');
  });

  it('mirrors the T2.9 errorKind additions in DAEMON_ERROR_KINDS (issue #4514)', () => {
    // The SDK-side `DAEMON_ERROR_KINDS` is hand-mirrored from the
    // serve-side `SERVE_ERROR_KINDS` in `acp-bridge/src/status.ts`.
    // T2.9 added two kinds (`prompt_deadline_exceeded` for the
    // POST /session/:id/prompt 504, `writer_idle_timeout` for the
    // terminal SSE client_evicted frame). Lock them so a future PR
    // that bumps the serve list without touching the SDK list fails
    // here instead of shipping a typed-on-server-but-unknown-on-SDK
    // mismatch.
    expect(Public.DAEMON_ERROR_KINDS).toContain('prompt_deadline_exceeded');
    expect(Public.DAEMON_ERROR_KINDS).toContain('writer_idle_timeout');
    expect(Public.DAEMON_ERROR_KINDS).toContain('restore_timeout');
  });
});

describe('mcp_server_added event drift insurance', () => {
  it('is exported in DAEMON_KNOWN_EVENT_TYPE_VALUES', () => {
    expect(DAEMON_KNOWN_EVENT_TYPE_VALUES).toContain('mcp_server_added');
  });

  it('asKnownDaemonEvent returns the right discriminator', () => {
    const evt: DaemonEvent = {
      v: 1,
      type: 'mcp_server_added',
      data: {
        name: 'echo',
        transport: 'stdio',
        replaced: false,
        shadowedSettings: false,
        toolCount: 3,
        originatorClientId: 'client-1',
      },
    };
    const known = asKnownDaemonEvent(evt);
    expect(known?.type).toBe('mcp_server_added');
    if (known?.type === 'mcp_server_added') {
      expect(known.data.name).toBe('echo');
      expect(known.data.transport).toBe('stdio');
      expect(known.data.replaced).toBe(false);
      expect(known.data.shadowedSettings).toBe(false);
      expect(known.data.toolCount).toBe(3);
      expect(known.data.originatorClientId).toBe('client-1');
    }
  });
});

describe('mcp_server_removed event drift insurance', () => {
  it('is exported in DAEMON_KNOWN_EVENT_TYPE_VALUES', () => {
    expect(DAEMON_KNOWN_EVENT_TYPE_VALUES).toContain('mcp_server_removed');
  });

  it('asKnownDaemonEvent returns the right discriminator', () => {
    const evt: DaemonEvent = {
      v: 1,
      type: 'mcp_server_removed',
      data: {
        name: 'echo',
        wasShadowingSettings: true,
        originatorClientId: 'client-2',
      },
    };
    const known = asKnownDaemonEvent(evt);
    expect(known?.type).toBe('mcp_server_removed');
    if (known?.type === 'mcp_server_removed') {
      expect(known.data.name).toBe('echo');
      expect(known.data.wasShadowingSettings).toBe(true);
      expect(known.data.originatorClientId).toBe('client-2');
    }
  });
});

describe('runtime MCP add/remove SDK types', () => {
  it('request type compiles', () => {
    const req: DaemonRuntimeMcpAddRequest = {
      name: 'echo',
      config: { command: 'node', args: ['echo.js'], type: 'stdio' },
      displayName: 'Echo Server',
    };
    expect(req.name).toBe('echo');
  });

  it('add result has right shape', () => {
    const res: DaemonRuntimeMcpAddResult = {
      name: 'echo',
      transport: 'stdio',
      replaced: false,
      shadowedSettings: false,
      toolCount: 0,
      originatorClientId: 'client-x',
    };
    expect(res.replaced).toBe(false);
  });

  it('add soft-refuse has right shape', () => {
    const res: DaemonRuntimeMcpAddResult = {
      name: 'echo',
      skipped: true,
      reason: 'budget_warning_only',
    };
    expect(res.skipped).toBe(true);
  });

  it('remove result has right shape', () => {
    const res: DaemonRuntimeMcpRemoveResult = {
      name: 'echo',
      removed: true,
      wasShadowingSettings: false,
      originatorClientId: 'client-x',
    };
    expect(res.removed).toBe(true);
  });
});

describe('daemon UI debug-reason public surface', () => {
  it('pins the union shipped by @qwen-code/sdk/daemon', () => {
    // A type-only guard would not hold here: vitest transpiles through
    // esbuild, which erases `export type` without checking it, and this
    // package's tsconfig excludes `test/`, so nothing type-checks this file.
    // The union therefore ships as a closed enum value — matching
    // DAEMON_ERROR_KINDS and friends — and the runtime assertion below is
    // what actually fails if the re-export is dropped or the members drift.
    expect(DAEMON_UI_DEBUG_REASONS).toEqual([
      'unrecognized_event',
      'unrecognized_session_update',
      'malformed_payload',
    ]);
    expectTypeOf<DaemonEntryUiDebugReason>().toEqualTypeOf<
      'unrecognized_event' | 'unrecognized_session_update' | 'malformed_payload'
    >();
  });
});

describe('unrecognized-diagnostic sidechannel public surface (#8823)', () => {
  it('pins the routed reason subset as a runtime value', () => {
    // Same esbuild-erasure hazard as DAEMON_UI_DEBUG_REASONS: the router
    // keys on this array at runtime, so it must ship as a value, and the
    // subset must stay inside the parent union.
    expect(DAEMON_UI_UNRECOGNIZED_DIAGNOSTIC_REASONS).toEqual([
      'unrecognized_event',
      'unrecognized_session_update',
    ]);
    for (const reason of DAEMON_UI_UNRECOGNIZED_DIAGNOSTIC_REASONS) {
      expect(DAEMON_UI_DEBUG_REASONS).toContain(reason);
    }
    expectTypeOf<DaemonEntryUnrecognizedDiagnosticReason>().toEqualTypeOf<
      'unrecognized_event' | 'unrecognized_session_update'
    >();
  });

  it('routes every unrecognized_*-prefixed debug reason (#8823)', () => {
    // Membership is what the router tests, but Web Shell hides debug blocks
    // by the `unrecognized_` prefix — so any reason added to
    // DAEMON_UI_DEBUG_REASONS under that prefix must join the routed
    // subset, otherwise those frames fall through to `appendStatusBlock`
    // (finalizing the streaming block, consuming the maxBlocks budget)
    // while renderers hide the resulting block: the #8823 symptoms,
    // invisible until usage-loss reports arrive.
    for (const reason of DAEMON_UI_DEBUG_REASONS) {
      if (!reason.startsWith('unrecognized_')) continue;
      expect(DAEMON_UI_UNRECOGNIZED_DIAGNOSTIC_REASONS).toContain(reason);
    }
  });

  it('reaches the selector and the cap through the daemon entry', () => {
    // The PR's Risk & Scope points adapters at `@qwen-code/sdk/daemon`; an
    // export missing from the barrel is a compile error for every consumer,
    // so pin reachability the way DAEMON_UI_DEBUG_REASONS is pinned.
    expect(typeof selectUnrecognizedDiagnostics).toBe('function');
    expect(UNRECOGNIZED_DIAGNOSTICS_LIMIT).toBe(50);
    expectTypeOf<DaemonEntryUnrecognizedDiagnostic>().toHaveProperty(
      'debugReason',
    );
  });
});

describe('task executionMode guard public surface', () => {
  it('pins the fail-closed literal whitelist at the daemon entry', () => {
    // webui's projection (`projectSubagentToolUpdate`) and the web-shell
    // adapter (`daemonToolBlockToToolCall`) both import this guard from
    // @qwen-code/sdk/daemon; a dropped re-export is a compile error for
    // them, and a widened or narrowed literal set silently re-routes live
    // vs recorded classification. Pin the runtime behavior here the way
    // DAEMON_UI_DEBUG_REASONS pins its closed union.
    expect(typeof isTaskExecutionMode).toBe('function');
    expect(isTaskExecutionMode('foreground')).toBe(true);
    expect(isTaskExecutionMode('background')).toBe(true);
    expect(isTaskExecutionMode('detached')).toBe(false);
    expect(isTaskExecutionMode('')).toBe(false);
    expect(isTaskExecutionMode(undefined)).toBe(false);
    expect(isTaskExecutionMode(42)).toBe(false);
    expect(isTaskExecutionMode({})).toBe(false);
  });
});
