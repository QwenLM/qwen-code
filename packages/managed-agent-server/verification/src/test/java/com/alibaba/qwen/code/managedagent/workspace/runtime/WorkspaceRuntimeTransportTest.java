package com.alibaba.qwen.code.managedagent.workspace.runtime;

import com.alibaba.qwen.code.managedagent.persistence.JdbcWorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeDrainReceipt;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.adapter.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import org.junit.jupiter.api.Test;

import java.net.URI;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.same;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.verifyNoMoreInteractions;
import static org.mockito.Mockito.when;

class WorkspaceRuntimeTransportTest {
    @Test
    void ordinaryExecutionKeepsItsRecordedSessionAcrossMeasurementFlagChangesButRejectsChangedScope() throws Exception {
        for (String recordedProfile : List.of(WorkspaceExecutionProfile.CAPABILITY_DIGEST,
                WorkspaceExecutionProfile.MEASURED_CAPABILITY_DIGEST)) {
            var fixture = sshAcquisitionFixture(recordedProfile);
            var original = fixture.session().getScope();
            var binding = fixture.resolver().savedBinding(fixture.session().getHarnessSessionId());
            String desiredProfile = WorkspaceExecutionProfile.CAPABILITY_DIGEST.equals(recordedProfile)
                    ? WorkspaceExecutionProfile.MEASURED_CAPABILITY_DIGEST : WorkspaceExecutionProfile.CAPABILITY_DIGEST;
            var desired = new RuntimeScope(original.getTenantId(), original.getWorkspaceId(), original.getWorkspaceGeneration(),
                    original.getCanonicalCwd(), desiredProfile, original.getIsolationClass());
            when(fixture.resolver().resolve(fixture.session().getHarnessSessionId(), null))
                    .thenReturn(new WorkspaceRuntimeResolver.Resolved(binding, desired));
            Map<String, Object> reference = Map.of("callId", "original-file-call", "toolName", "read_file",
                    "input", Map.of("file_path", "fixture.txt"));
            Map<String, Object> result = Map.of("executionStatus", "success", "responseParts", List.of());
            when(fixture.http().execute(fixture.lease(), fixture.session(), reference))
                    .thenReturn(CompletableFuture.completedFuture(result));

            assertThat(fixture.transport().execute(fixture.lease(), fixture.session(), reference)
                    .toCompletableFuture().join()).isEqualTo(result);
            assertThat(fixture.session().getScope()).isSameAs(original);
            assertThat(fixture.session().getScope().getCapabilityDigest()).isEqualTo(recordedProfile);
            verify(fixture.http()).execute(same(fixture.lease()), same(fixture.session()), same(reference));
            verify(fixture.sessions()).findById(original, fixture.session().getRuntimeSessionId());
            verify(fixture.ownership()).assertHeld(binding, fixture.record());

            for (var changed : List.of(
                    new RuntimeScope("other-tenant", original.getWorkspaceId(), original.getWorkspaceGeneration(),
                            original.getCanonicalCwd(), desiredProfile, original.getIsolationClass()),
                    new RuntimeScope(original.getTenantId(), "other-workspace", original.getWorkspaceGeneration(),
                            original.getCanonicalCwd(), desiredProfile, original.getIsolationClass()),
                    new RuntimeScope(original.getTenantId(), original.getWorkspaceId(), "other-generation",
                            original.getCanonicalCwd(), desiredProfile, original.getIsolationClass()),
                    new RuntimeScope(original.getTenantId(), original.getWorkspaceId(), original.getWorkspaceGeneration(),
                            original.getCanonicalCwd() + "/other", desiredProfile, original.getIsolationClass()),
                    new RuntimeScope(original.getTenantId(), original.getWorkspaceId(), original.getWorkspaceGeneration(),
                            original.getCanonicalCwd(), desiredProfile, "workspace"))) {
                when(fixture.resolver().resolve(fixture.session().getHarnessSessionId(), null))
                        .thenReturn(new WorkspaceRuntimeResolver.Resolved(binding, changed));
                assertThat(fixture.transport().execute(fixture.lease(), fixture.session(), reference)
                        .toCompletableFuture().join()).containsEntry("executionStatus", "not_started")
                        .containsEntry("error", Map.of("type", "workspace_unavailable",
                                "message", "Workspace execution was refused before dispatch."));
            }
            verifyNoMoreInteractions(fixture.http());
        }
    }

    @Test
    void invalidRemoteCwdIsRejectedBeforeClaimingStorageOrInstallingContext() throws Exception {
        var fixture = sshAcquisitionFixture();
        var binding = fixture.resolver().savedBinding(fixture.session().getHarnessSessionId());
        doThrow(WorkspaceExecutionStore.unavailable()).when(fixture.resolver())
                .verifyInstallable(binding, binding.getCwdRelative());
        unavailable(() -> fixture.transport().acquire(fixture.lease(), fixture.session()));
        verifyNoInteractions(fixture.ownership(), fixture.http());
    }

    @Test
    void sshPreflightVerdictsTranslateToTheDefiniteRefusalContract() throws Exception {
        var fixture = sshAcquisitionFixture();
        var binding = fixture.resolver().savedBinding(fixture.session().getHarnessSessionId());
        for (String verdict : new String[] {"ssh_runtime_state_unavailable", "ssh_runtime_identity_conflict"}) {
            doThrow(new RuntimeBrokerException(409, verdict, "SSH preflight refused the directory.", false))
                    .when(fixture.resolver()).verifyInstallable(binding, binding.getCwdRelative());
            assertThatThrownBy(() -> fixture.transport().acquire(fixture.lease(), fixture.session()))
                    .isInstanceOfSatisfying(RuntimeBrokerException.class, error -> {
                        assertThat(error.getCode()).isEqualTo("workspace_unavailable");
                        assertThat(error.getCause()).isInstanceOfSatisfying(RuntimeBrokerException.class,
                                cause -> assertThat(cause.getCode()).isEqualTo(verdict));
                    });
            verify(fixture.ownership(), never()).claim(any(), any());
            verifyNoInteractions(fixture.http());
        }
    }

    @Test
    void remotePreflightPrecedesClaimButAnUncertainInstallStillRetainsOwnership() throws Exception {
        var fixture = sshAcquisitionFixture();
        var binding = fixture.resolver().savedBinding(fixture.session().getHarnessSessionId());
        when(fixture.http().installContext(any(), any(), any(), any()))
                .thenReturn(CompletableFuture.failedFuture(new IllegalStateException("Response lost")));
        assertThatThrownBy(() -> fixture.transport().acquire(fixture.lease(), fixture.session()).toCompletableFuture().join())
                .hasCauseInstanceOf(RuntimeBrokerException.class)
                .cause().extracting(error -> ((RuntimeBrokerException) error).getCode())
                .isEqualTo("runtime_session_acquire_failed");
        var order = inOrder(fixture.resolver(), fixture.ownership(), fixture.http());
        order.verify(fixture.resolver()).verifyInstallable(binding, binding.getCwdRelative());
        order.verify(fixture.ownership()).claim(binding, fixture.record());
        order.verify(fixture.http()).installContext(any(), any(), any(), any());
        verify(fixture.ownership(), never()).release(any(), any());
    }

    @Test
    void v2AcknowledgementUsesTheReleasedOriginalSshSessionWithoutReclaimingStorage() throws Exception {
        var fixture = fixture();
        var original = fixture.runtime();
        var oldScope = fixture.session().getScope();
        var scope = new RuntimeScope(oldScope.getTenantId(), oldScope.getWorkspaceId(), oldScope.getWorkspaceGeneration(),
                oldScope.getCanonicalCwd(), oldScope.getCapabilityDigest(), "session");
        var session = new RuntimeSession(fixture.session().getHarnessSessionId(), fixture.session().getRuntimeSessionId(),
                fixture.session().getTurnKind(), scope);
        var request = new RuntimeProvisionRequest(scope, session.getHarnessSessionId(), "ssh-process", original.getRequest().getStorageId());
        var runtime = new RuntimeBindingRecord(original.getBindingId(), request, original.getProvisionSeed(), original.getGeneration(),
                RuntimeBindingRecord.State.DRAINING, original.getLease(), new RuntimeResourceHandle("ssh-process", 1, Map.of("fixture", true)),
                3, true, null, null, 0, 1, null, Instant.now(), Instant.now());
        var record = new RuntimeSessionRecord(session, runtime.getBindingId(), runtime.getGeneration(),
                RuntimeSessionRecord.State.RELEASED, 1, Instant.now());
        when(fixture.bindings().findById(runtime.getBindingId())).thenReturn(runtime);
        when(fixture.sessions().findById(scope, session.getRuntimeSessionId())).thenReturn(record);
        when(fixture.http().acknowledgeV2(any(), any(), any())).thenReturn(CompletableFuture.completedFuture(null));
        Map<String, Object> reference = Map.of("callId", "file-call");
        fixture.transport().acknowledgeV2(fixture.lease(), session, reference).toCompletableFuture().join();
        verify(fixture.http()).acknowledgeV2(fixture.lease(), session, reference);
        verify(fixture.resolver(), never()).resolve(any(), any());
        verifyNoInteractions(fixture.ownership());
        var crossed = new RuntimeLease("other", fixture.lease().getEndpoint(), fixture.lease().getToken(),
                fixture.lease().getLeaseId(), fixture.lease().getEpoch());
        unavailable(() -> fixture.transport().acknowledgeV2(crossed, session, reference));
    }

    @Test
    void dedicatedWorkspaceExemptionDoesNotOpenTheExistingGenericRoutes() throws Exception {
        var fixture = fixture();
        when(fixture.resolver().resolve(any(), any())).thenThrow(WorkspaceExecutionStore.unavailable());
        Map<String, Object> reference = Map.of("runtimeProtocol", 3, "callId", "original");
        unavailable(() -> fixture.transport().statusV3(fixture.lease(), fixture.session(), reference, 0));
        unavailable(() -> fixture.transport().cancelV3(fixture.lease(), fixture.session(), reference));
        unavailable(() -> fixture.transport().acknowledgeV3(fixture.lease(), fixture.session(), reference, Map.of()));
        unavailable(() -> fixture.transport().acknowledge(fixture.lease(), fixture.session(), reference, Map.of()));
        unavailable(() -> fixture.transport().status(fixture.lease(), fixture.session(), reference, 0));
        unavailable(() -> fixture.transport().acquire(fixture.lease(), fixture.session()));
        verifyNoInteractions(fixture.http(), fixture.ownership());
    }

    @Test
    void sharedLocalBindingAnswersEachRuntimeSessionForItsOwnHarnessSession() {
        var scope = new RuntimeScope("tenant", "workspace", "7", "/workspace", WorkspaceExecutionProfile.CAPABILITY_DIGEST,
                "workspace");
        var seed = new RuntimeProvisionSeed("provision", "binding-a", "incarnation", "lease", 1, "token");
        var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:1"), seed.getToken(),
                seed.getLeaseId(), seed.getEpoch());
        var runtime = new RuntimeBindingRecord("binding-a", new RuntimeProvisionRequest(scope, null, "local-process", "storage"),
                seed, 1, RuntimeBindingRecord.State.READY, lease, new RuntimeResourceHandle("local-process", 2, Map.of("fixture", "shared")),
                3, false, null, null, 0, 1, null, Instant.now(), Instant.now());
        var bindings = mock(RuntimeBindingRepository.class);
        when(bindings.findById("binding-a")).thenReturn(runtime);
        var sessions = mock(RuntimeSessionRepository.class);
        var http = mock(HttpRuntimeTransport.class);
        var transport = new WorkspaceRuntimeTransport(http, mock(JdbcWorkspaceExecutionStore.class), bindings, sessions,
                harness -> new ContextBinding("tenant", "workspace", 7, "storage", ".", "config", 1));
        for (String harness : new String[] {"harness-a", "harness-b"}) {
            var session = new RuntimeSession(harness, harness + "-turn", "continuation", scope);
            when(sessions.findById(scope, session.getRuntimeSessionId())).thenReturn(
                    new RuntimeSessionRecord(session, "binding-a", 1, RuntimeSessionRecord.State.RELEASING, 1, Instant.now()));
            assertThat(transport.release(lease, session).toCompletableFuture().join()).isTrue();
        }
        unavailable(() -> transport.release(lease, new RuntimeSession("harness-b", "harness-a-turn", "continuation", scope)));
        verifyNoInteractions(http);
    }

    @Test
    void confinedReleaseNeedsPhysicalProofOnlyWhenAnInstallationCanStillBeOwed() {
        var scope = new RuntimeScope("tenant", "workspace", "7", "/workspace",
                WorkspaceExecutionProfile.PRIVATE_ROOT_CAPABILITY_DIGEST, "session");
        var session = new RuntimeSession("harness", "turn", "continuation", scope);
        var seed = new RuntimeProvisionSeed("provision", "binding-a", "incarnation", "lease", 1, "token");
        var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:1"), seed.getToken(),
                seed.getLeaseId(), seed.getEpoch());
        var request = new RuntimeProvisionRequest(scope, "harness", "local-process", "storage");
        var runtime = new RuntimeBindingRecord("binding-a", request, seed, 1, RuntimeBindingRecord.State.READY,
                lease, new RuntimeResourceHandle("local-process", 3, Map.of("fixture", "confined")),
                3, false, null, null, 0, 1, null, Instant.now(), Instant.now());
        var record = new RuntimeSessionRecord(session, "binding-a", 1, RuntimeSessionRecord.State.RELEASING, 1, Instant.now());
        var context = new ContextBinding("tenant", "workspace", 7, "storage", ".", "config", 1);
        var bindings = mock(RuntimeBindingRepository.class);
        when(bindings.findById("binding-a")).thenReturn(runtime);
        var sessions = mock(RuntimeSessionRepository.class);
        when(sessions.findById(scope, session.getRuntimeSessionId())).thenReturn(record);
        var http = mock(HttpRuntimeTransport.class);
        var ownership = mock(JdbcWorkspaceExecutionStore.class);
        var transport = new WorkspaceRuntimeTransport(http, ownership, bindings, sessions, ignored -> context);
        var proof = new CompletableFuture<Void>();
        transport.configureConfinedHandback(original -> {
            assertThat(original).isSameAs(runtime);
            return proof;
        });

        assertThat(transport.release(lease, session).toCompletableFuture().join()).isTrue();
        verifyNoInteractions(http);

        when(ownership.isHeld(context, record)).thenReturn(true);
        when(http.activateWorkspace(runtime, record, context, false)).thenReturn(CompletableFuture.completedFuture(null));
        var heldRelease = transport.release(lease, session).toCompletableFuture();
        verify(http).activateWorkspace(runtime, record, context, false);
        assertThat(heldRelease).isNotDone();
        verify(ownership, never()).releaseConfined(context, record, runtime);
        proof.complete(null);
        assertThat(heldRelease.join()).isTrue();
        verify(ownership).releaseConfined(context, record, runtime);
    }

    @Test
    void releaseRetiredClearsTheHolderWithAMatchingReceipt() throws Exception {
        var fixture = sshAcquisitionFixture();
        var runtime = fixture.runtime();
        var receipt = new RuntimeDrainReceipt(runtime.getBindingId(), runtime.getGeneration(),
                runtime.getProvisionSeed().getProvisionRequestId(), runtime.getResourceHandle(), Instant.now());
        var draining = runtime.withDrainRequested(true, Instant.now())
                .withState(RuntimeBindingRecord.State.DRAINING, runtime.getLease(), Instant.now())
                .withDrainReceipt(receipt);
        when(fixture.bindings().findById(runtime.getBindingId())).thenReturn(draining);

        assertThat(fixture.transport().releaseRetired(fixture.lease(), fixture.session())
                .toCompletableFuture().join()).isTrue();
        verify(fixture.ownership()).release(any(), any());
    }

    @Test
    void releaseRetiredRefusesWithoutAPersistedReceipt() throws Exception {
        var fixture = sshAcquisitionFixture();
        var runtime = fixture.runtime();
        var draining = runtime.withDrainRequested(true, Instant.now())
                .withState(RuntimeBindingRecord.State.DRAINING, runtime.getLease(), Instant.now());
        when(fixture.bindings().findById(runtime.getBindingId())).thenReturn(draining);
        when(fixture.ownership().isHeld(any(), any())).thenReturn(true);

        assertThat(fixture.transport().releaseRetired(fixture.lease(), fixture.session())
                .toCompletableFuture().join()).isFalse();
        verify(fixture.ownership(), never()).release(any(), any());
    }

    @Test
    void externalVerifierRunsBeforeClaimAndAfterActivationAndReclaim() throws Exception {
        var events = new java.util.ArrayList<String>();
        var activation = new CompletableFuture<Void>();
        var fixture = externalFixture(runtime -> {
            events.add("verify");
            return CompletableFuture.completedFuture(null);
        });
        org.mockito.Mockito.doAnswer(invocation -> {
            events.add("claim");
            return null;
        }).when(fixture.ownership()).claim(any(), any(), any(), any());
        org.mockito.Mockito.doAnswer(invocation -> {
            events.add("assertHeld");
            return null;
        }).when(fixture.ownership()).assertHeld(any(), any(), any(), any());
        when(fixture.http().installContext(any(), any(), any(), any())).thenAnswer(invocation -> {
            events.add("install");
            return CompletableFuture.completedFuture(Map.of());
        });
        when(fixture.http().activateWorkspace(any(), any(), any(), org.mockito.ArgumentMatchers.eq(true)))
                .thenAnswer(invocation -> {
                    events.add("activate");
                    return activation;
                });
        var acquired = fixture.transport().acquire(fixture.lease(), fixture.session()).toCompletableFuture();
        assertThat(acquired).isNotDone();
        assertThat(events).containsExactly("verify", "claim", "install", "activate");
        activation.complete(null);
        acquired.join();
        assertThat(events).containsExactly("verify", "claim", "install", "activate", "verify", "assertHeld");
        events.clear();
        fixture.transport().reclaimMount(fixture.lease(), fixture.session()).toCompletableFuture().join();
        assertThat(events).containsExactly("verify", "claim", "assertHeld");
        verify(fixture.resolver(), never()).verifyInstallable(any(), any());
    }

    @Test
    void externalPreclaimFailureOwnsNothingAndRestartReleaseStillDetachesWithoutMembership() throws Exception {
        var fixture = externalFixture(runtime -> CompletableFuture.failedFuture(com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable()));
        assertThatThrownBy(() -> fixture.transport().acquire(fixture.lease(), fixture.session()).toCompletableFuture().join())
                .hasCauseInstanceOf(RuntimeBrokerException.class);
        verify(fixture.ownership()).requireExternalExecution(any());
        verify(fixture.ownership(), never()).claim(any(), any(), any(), any());
        verifyNoInteractions(fixture.http());
        when(fixture.sessions().findById(fixture.session().getScope(), fixture.session().getRuntimeSessionId()))
                .thenReturn(fixture.record().withState(RuntimeSessionRecord.State.RELEASING, Instant.now()));
        when(fixture.http().release(any(), any())).thenReturn(CompletableFuture.completedFuture(true));
        when(fixture.http().activateWorkspace(any(), any(), any(), org.mockito.ArgumentMatchers.eq(false)))
                .thenReturn(CompletableFuture.completedFuture(null));
        assertThat(fixture.transport().release(fixture.lease(), fixture.session()).toCompletableFuture().join()).isTrue();
        verify(fixture.http()).release(fixture.lease(), fixture.session());
        verify(fixture.ownership()).release(any(), any(), any(), any());
        when(fixture.sessions().findById(fixture.session().getScope(), fixture.session().getRuntimeSessionId()))
                .thenReturn(fixture.record().withState(RuntimeSessionRecord.State.RELEASED, Instant.now()));
        when(fixture.http().acknowledgeV2(any(), any(), any())).thenReturn(CompletableFuture.completedFuture(null));
        fixture.transport().acknowledgeV2(fixture.lease(), fixture.session(), Map.of("callId", "original")).toCompletableFuture().join();
        verify(fixture.ownership()).assertOriginalExternal(any(), any(), any(), any());
        verify(fixture.http()).acknowledgeV2(fixture.lease(), fixture.session(), Map.of("callId", "original"));
    }

    @Test
    void externalReclaimRefusesUnavailableRegistrationBeforeClaimingStorage() throws Exception {
        var fixture = externalFixture(runtime -> CompletableFuture.completedFuture(null));
        doThrow(com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable()).when(fixture.ownership()).requireExternalExecution(any());
        unavailable(() -> fixture.transport().reclaimMount(fixture.lease(), fixture.session()));
        verify(fixture.ownership(), never()).claim(any(), any(), any(), any());
        verifyNoInteractions(fixture.http());
    }

    @Test
    void externalPreparePermanentlyRefusesInvalidAndNonCanonicalPaths() throws Exception {
        var fixture = externalFixture(runtime -> CompletableFuture.completedFuture(null));
        for (String path : java.util.List.of("../etc", "src/../lib", "src//lib", "src/./lib", ".")) {
            assertThatThrownBy(() -> fixture.transport().control(fixture.lease(), fixture.session(),
                    Map.of("kind", "raw-file-history", "action", "prepare", "promptId", "prompt-1", "paths", java.util.List.of(path))))
                    .isInstanceOfSatisfying(RuntimeBrokerException.class, error -> {
                        assertThat(error.getStatusCode()).isEqualTo(409);
                        assertThat(error.getCode()).isEqualTo("workspace_unavailable");
                        assertThat(error.isRetryable()).isFalse();
                    });
        }
        verifyNoInteractions(fixture.http());
    }

    @Test
    void externalFileAuxiliaryControlsPreserveOriginalHolderAndRejectOtherOperations() throws Exception {
        var fixture = externalFixture(runtime -> CompletableFuture.completedFuture(null));
        when(fixture.http().control(any(), any(), any())).thenReturn(CompletableFuture.completedFuture(Map.of()));
        when(fixture.ownership().isHeld(any(), any(), any(), any())).thenReturn(true);
        var bind = new LinkedHashMap<String, Object>();
        bind.put("kind", "raw-file-history");
        bind.put("action", "bind");
        bind.put("state", null);
        for (var operation : java.util.List.of(bind, Map.<String, Object>of("kind", "workspace-context"),
                Map.<String, Object>of("kind", "raw-file-history", "action", "prepare", "promptId", "prompt-1", "paths", java.util.List.of("README.md")),
                Map.<String, Object>of("kind", "raw-file-history", "action", "snapshot"))) {
            fixture.transport().control(fixture.lease(), fixture.session(), operation).toCompletableFuture().join();
            verify(fixture.http()).control(fixture.lease(), fixture.session(), operation);
        }
        org.mockito.Mockito.clearInvocations(fixture.http());
        for (var operation : java.util.List.of(Map.<String, Object>of("kind", "history"),
                Map.<String, Object>of("kind", "manifest"), Map.<String, Object>of("kind", "prepare"),
                Map.<String, Object>of("kind", "raw-file-history"),
                Map.<String, Object>of("kind", "raw-file-history", "action", "rewind", "promptId", "prompt-1"),
                Map.<String, Object>of("kind", "workspace-context", "extra", true),
                Map.<String, Object>of("kind", "raw-file-history", "action", "snapshot", "extra", true),
                Map.<String, Object>of("kind", "raw-file-history", "action", "bind", "state", Map.of("ownerSessionId", "other")))) {
            assertThatThrownBy(() -> fixture.transport().control(fixture.lease(), fixture.session(), operation))
                    .isInstanceOf(RuntimeBrokerException.class);
        }
        verifyNoInteractions(fixture.http());
        doThrow(com.alibaba.qwen.code.managedagent.repository.WorkspaceExecutionStore.unavailable()).when(fixture.ownership()).requireExternalExecution(any());
        unavailable(() -> fixture.transport().control(fixture.lease(), fixture.session(), Map.of("kind", "workspace-context")));
        fixture.transport().control(fixture.lease(), fixture.session(), Map.of("kind", "raw-file-history", "action", "snapshot"))
                .toCompletableFuture().join();
        org.mockito.Mockito.clearInvocations(fixture.http());
        when(fixture.ownership().isHeld(any(), any(), any(), any())).thenReturn(false);
        unavailable(() -> fixture.transport().control(fixture.lease(), fixture.session(),
                Map.of("kind", "raw-file-history", "action", "snapshot")));
        verifyNoInteractions(fixture.http());
    }

    private static Fixture externalFixture(java.util.function.Function<RuntimeBindingRecord,
            java.util.concurrent.CompletionStage<Void>> verifier) throws Exception {
        var fixture = sshAcquisitionFixture();
        var scope = fixture.session().getScope();
        var request = new RuntimeProvisionRequest(scope, fixture.session().getHarnessSessionId(), "external-workspace", scope.getWorkspaceId());
        var context = new ContextBinding(scope.getTenantId(), scope.getWorkspaceId(), Long.parseLong(scope.getWorkspaceGeneration()),
                scope.getWorkspaceId(), ".", WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1);
        var runtime = new RuntimeBindingRecord(fixture.runtime().getBindingId(), request, fixture.runtime().getProvisionSeed(),
                fixture.runtime().getGeneration(), RuntimeBindingRecord.State.READY, fixture.lease(),
                new RuntimeResourceHandle("external-workspace", 1, Map.of("component-only", true)), 3, false,
                null, null, 0, 1, null, Instant.now(), Instant.now());
        when(fixture.bindings().findById(runtime.getBindingId())).thenReturn(runtime);
        when(fixture.resolver().savedBinding(fixture.session().getHarnessSessionId())).thenReturn(context);
        when(fixture.resolver().resolve(fixture.session().getHarnessSessionId(), null))
                .thenReturn(new WorkspaceRuntimeResolver.Resolved(context, scope));
        return new Fixture(new WorkspaceRuntimeTransport(fixture.http(), fixture.resolver(), fixture.ownership(), fixture.bindings(),
                fixture.sessions(), verifier), fixture.http(), fixture.resolver(), fixture.ownership(), fixture.bindings(), fixture.sessions(),
                runtime, fixture.record(), fixture.lease(), fixture.session());
    }

    private static void unavailable(Runnable action) {
        assertThatThrownBy(action::run).isInstanceOf(RuntimeBrokerException.class)
                .extracting(error -> ((RuntimeBrokerException) error).getCode()).isEqualTo("workspace_unavailable");
    }

    private static Fixture fixture() throws Exception {
        var scope = new RuntimeScope("tenant-a", "workspace-a", "7", "/runtime/workspaces/workspace-a",
                WorkspaceExecutionProfile.CAPABILITY_DIGEST, "workspace");
        var session = new RuntimeSession("session-a", "runtime-session-a", "continuation", scope);
        var seed = new RuntimeProvisionSeed("provision-01", "runtime-01", "boot-01", "lease-01", 4, "fixture-token");
        var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:1"), seed.getToken(), seed.getLeaseId(), seed.getEpoch());
        var provision = new RuntimeProvisionRequest(scope, null, "ssh-process", "storage://workspace-a");
        var runtime = new RuntimeBindingRecord("binding-a", provision, seed, 9, RuntimeBindingRecord.State.DRAINING,
                lease, new RuntimeResourceHandle("ssh-process", 1, Map.of("fixture", "wrapper-only")),
                3, true, null, null, 0, 1, null, Instant.now(), Instant.now());
        var record = new RuntimeSessionRecord(session, "binding-a", 9, RuntimeSessionRecord.State.READY, 1, Instant.now());
        var binding = new ContextBinding(scope.getTenantId(), scope.getWorkspaceId(), 7, provision.getStorageId(), ".", "config-a", 1);
        var resolver = mock(WorkspaceRuntimeResolver.class);
        when(resolver.savedBinding(session.getHarnessSessionId())).thenReturn(binding);
        var bindings = mock(RuntimeBindingRepository.class);
        when(bindings.findById("binding-a")).thenReturn(runtime);
        var sessions = mock(RuntimeSessionRepository.class);
        when(sessions.findById(scope, session.getRuntimeSessionId())).thenReturn(record);
        var ownership = mock(JdbcWorkspaceExecutionStore.class);
        var http = mock(HttpRuntimeTransport.class);
        return new Fixture(new WorkspaceRuntimeTransport(http, resolver, ownership, bindings, sessions), http, resolver,
                ownership, bindings, sessions, runtime, record, lease, session);
    }

    private static Fixture sshAcquisitionFixture() throws Exception {
        return sshAcquisitionFixture(WorkspaceExecutionProfile.CAPABILITY_DIGEST);
    }

    private static Fixture sshAcquisitionFixture(String capabilityDigest) throws Exception {
        var fixture = fixture();
        var original = fixture.runtime();
        var oldScope = fixture.session().getScope();
        var scope = new RuntimeScope(oldScope.getTenantId(), oldScope.getWorkspaceId(), oldScope.getWorkspaceGeneration(),
                oldScope.getCanonicalCwd(), capabilityDigest, "session");
        var session = new RuntimeSession(fixture.session().getHarnessSessionId(), fixture.session().getRuntimeSessionId(),
                fixture.session().getTurnKind(), scope);
        var request = new RuntimeProvisionRequest(scope, session.getHarnessSessionId(), "ssh-process", original.getRequest().getStorageId());
        var runtime = new RuntimeBindingRecord(original.getBindingId(), request, original.getProvisionSeed(), original.getGeneration(),
                RuntimeBindingRecord.State.READY, original.getLease(), new RuntimeResourceHandle("ssh-process", 1, Map.of("fixture", true)),
                3, false, null, null, 0, 1, null, Instant.now(), Instant.now());
        var record = new RuntimeSessionRecord(session, runtime.getBindingId(), runtime.getGeneration(),
                RuntimeSessionRecord.State.READY, 1, Instant.now());
        var binding = fixture.resolver().savedBinding(session.getHarnessSessionId());
        when(fixture.bindings().findById(runtime.getBindingId())).thenReturn(runtime);
        when(fixture.sessions().findById(scope, session.getRuntimeSessionId())).thenReturn(record);
        when(fixture.resolver().resolve(session.getHarnessSessionId(), null))
                .thenReturn(new WorkspaceRuntimeResolver.Resolved(binding, scope));
        return new Fixture(fixture.transport(), fixture.http(), fixture.resolver(), fixture.ownership(),
                fixture.bindings(), fixture.sessions(), runtime, record, fixture.lease(), session);
    }

    private record Fixture(WorkspaceRuntimeTransport transport, HttpRuntimeTransport http, WorkspaceRuntimeResolver resolver,
            JdbcWorkspaceExecutionStore ownership, RuntimeBindingRepository bindings, RuntimeSessionRepository sessions,
            RuntimeBindingRecord runtime, RuntimeSessionRecord record, RuntimeLease lease, RuntimeSession session) {
    }
}
