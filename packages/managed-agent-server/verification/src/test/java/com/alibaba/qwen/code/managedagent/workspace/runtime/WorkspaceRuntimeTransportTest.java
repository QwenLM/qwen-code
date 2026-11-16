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
