package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.HttpRuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.ManagedCsiProtocol;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import org.junit.jupiter.api.Test;

class WorkspaceRuntimeTransportTest {
    @Test
    void componentGuardForwardsOnlyTheSavedOriginalCsiWorkspaceWithoutNewAuthorizationOrOwnership() throws Exception {
        var fixture = fixture();
        when(fixture.http().acknowledgeCsi(any(), any(), any(), any(), any(), any()))
                .thenReturn(CompletableFuture.completedFuture(Map.of("state", "ACKNOWLEDGED")));
        assertThat(acknowledge(fixture)).containsEntry("state", "ACKNOWLEDGED");
        verify(fixture.resolver()).savedBinding(fixture.session().getHarnessSessionId());
        verify(fixture.resolver(), never()).resolve(any());
        verifyNoInteractions(fixture.ownership());
        verify(fixture.http()).acknowledgeCsi(fixture.lease(), fixture.session(), fixture.boot(), fixture.pod(),
                fixture.request(), fixture.capture());
        System.out.println("ACK wrapper Jackson " + new ObjectMapper().version() + " "
                + ObjectMapper.class.getProtectionDomain().getCodeSource().getLocation());
    }

    @Test
    void dedicatedWorkspaceExemptionDoesNotOpenTheExistingGenericRoutes() throws Exception {
        var fixture = fixture();
        when(fixture.resolver().resolve(any())).thenThrow(WorkspaceExecutionStore.unavailable());
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
    void refusesWrongRuntimeLifecycleSessionLeaseScopeAndGenerationBeforeForwarding() throws Exception {
        var fixture = fixture();
        for (RuntimeBindingRecord.State state : RuntimeBindingRecord.State.values()) {
            if (state != RuntimeBindingRecord.State.DRAINING) {
                when(fixture.bindings().findById("binding-a")).thenReturn(fixture.runtime().withState(state, fixture.lease(), Instant.now()));
                unavailable(() -> acknowledge(fixture));
            }
        }
        when(fixture.bindings().findById("binding-a")).thenReturn(fixture.runtime().withDrainRequested(false, Instant.now()));
        unavailable(() -> acknowledge(fixture));
        when(fixture.bindings().findById("binding-a")).thenReturn(fixture.runtime());
        for (RuntimeSessionRecord.State state : RuntimeSessionRecord.State.values()) {
            if (state != RuntimeSessionRecord.State.READY) {
                when(fixture.sessions().findById(fixture.session().getScope(), fixture.session().getRuntimeSessionId()))
                        .thenReturn(fixture.record().withState(state, Instant.now()));
                unavailable(() -> acknowledge(fixture));
            }
        }
        when(fixture.sessions().findById(fixture.session().getScope(), fixture.session().getRuntimeSessionId())).thenReturn(fixture.record());
        var wrongLease = new RuntimeLease(fixture.lease().getRuntimeInstanceId(), fixture.lease().getEndpoint(),
                "other-token", fixture.lease().getLeaseId(), fixture.lease().getEpoch());
        unavailable(() -> fixture.transport().acknowledgeCsi(wrongLease, fixture.session(), fixture.boot(), fixture.pod(), fixture.request(), fixture.capture()));
        unavailable(() -> fixture.transport().acknowledgeCsi(fixture.lease(), fixture.session(), fixture.boot(), fixture.pod(),
                fixture.request(), with(fixture.capture(), "bindingGeneration", "7")));
        var request = fixture.runtime().getRequest();
        var local = new RuntimeProvisionRequest(request.getScope(), null, "local-process", request.getStorageId());
        when(fixture.bindings().findById("binding-a")).thenReturn(new RuntimeBindingRecord("binding-a", local,
                fixture.runtime().getProvisionSeed(), 9, RuntimeBindingRecord.State.DRAINING, fixture.lease(),
                new RuntimeResourceHandle("local-process", 1, Map.of("fixture", "wrapper-only")),
                3, true, null, null, 0, 1, null, Instant.now(), Instant.now()));
        unavailable(() -> acknowledge(fixture));
        verifyNoInteractions(fixture.http(), fixture.ownership());
        verify(fixture.resolver(), never()).resolve(any());
    }

    @Test
    void refusesACoherentlyChangedBootAndCrossedOriginalSessions() throws Exception {
        var fixture = fixture();
        var boot = with(fixture.boot(), "context", with(map(fixture.boot().get("context")), "runtimeIncarnation", "other-incarnation"));
        var request = with(fixture.request(), "context", with(map(fixture.request().get("context")), "runtimeIncarnation", "other-incarnation"));
        unavailable(() -> fixture.transport().acknowledgeCsi(fixture.lease(), fixture.session(), boot, fixture.pod(), request, fixture.capture()));
        var crossed = new RuntimeSession("other-harness", fixture.session().getRuntimeSessionId(), "continuation", fixture.session().getScope());
        unavailable(() -> fixture.transport().acknowledgeCsi(fixture.lease(), crossed, fixture.boot(), fixture.pod(), fixture.request(), fixture.capture()));
        var original = fixture.session().getScope();
        var sessionScope = new RuntimeScope(original.getTenantId(), original.getWorkspaceId(), original.getWorkspaceGeneration(),
                original.getCanonicalCwd(), original.getCapabilityDigest(), "session");
        var isolated = new RuntimeSession(fixture.session().getHarnessSessionId(), fixture.session().getRuntimeSessionId(), "continuation", sessionScope);
        unavailable(() -> fixture.transport().acknowledgeCsi(fixture.lease(), isolated, fixture.boot(), fixture.pod(), fixture.request(), fixture.capture()));
        verifyNoInteractions(fixture.http(), fixture.ownership());
    }

    @Test
    void dedicatedStrictReaderAndClientPreflightAlsoRejectInvalidWireOnTheManagedJacksonClasspath() throws Exception {
        var fixture = fixture();
        String original = new ObjectMapper().writeValueAsString(fixture.request());
        for (String json : new String[] {original + " {}", "{\"a\":null,\"a\":1}",
                original.replace("\"historyRevision\":7", "\"historyRevision\":7.0"),
                original.replace("\"historyRevision\":7", "\"historyRevision\":7e0"),
                original.replace("\"historyRevision\":7", "\"historyRevision\":7.0000000000000001")}) {
            assertThatThrownBy(() -> ManagedCsiProtocol.parseAcknowledgement(json.getBytes(StandardCharsets.UTF_8)))
                    .isInstanceOf(IllegalArgumentException.class);
        }
        assertThatThrownBy(() -> ManagedCsiProtocol.parseAcknowledgement(new byte[] {(byte) 0xc3, 0x28}))
                .isInstanceOf(IllegalArgumentException.class);
        var decimal = with(fixture.request(), "protocolVersion", new BigDecimal("1.0"));
        ManagedCsiProtocol.validateAcknowledgementRequest(decimal, fixture.boot(), fixture.pod());
        assertThatThrownBy(() -> new HttpRuntimeTransport().acknowledgeCsi(fixture.lease(), fixture.session(),
                fixture.boot(), fixture.pod(), decimal, fixture.capture())).isInstanceOf(IllegalArgumentException.class);
    }

    private static Map<String, Object> acknowledge(Fixture fixture) {
        return fixture.transport().acknowledgeCsi(fixture.lease(), fixture.session(), fixture.boot(), fixture.pod(),
                fixture.request(), fixture.capture()).toCompletableFuture().join();
    }

    private static void unavailable(Runnable action) {
        assertThatThrownBy(action::run).isInstanceOf(RuntimeBrokerException.class)
                .extracting(error -> ((RuntimeBrokerException) error).getCode()).isEqualTo("workspace_unavailable");
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) {
        return (Map<String, Object>) value;
    }

    private static Map<String, Object> with(Map<String, Object> original, String field, Object value) {
        var changed = new LinkedHashMap<>(original);
        changed.put(field, value);
        return changed;
    }

    private static Fixture fixture() throws Exception {
        var fixture = ManagedCsiProtocol.parseAcknowledgement(Files.readAllBytes(
                Path.of("../../cli/src/serve/contracts/managed-csi-worker-ack-v1.fixtures.json")));
        var context = with(map(map(fixture.get("boot")).get("context")), "capabilityDigest", WorkspaceExecutionProfile.CAPABILITY_DIGEST);
        var boot = with(map(fixture.get("boot")), "context", context);
        var request = with(map(fixture.get("request")), "context",
                with(map(map(fixture.get("request")).get("context")), "capabilityDigest", WorkspaceExecutionProfile.CAPABILITY_DIGEST));
        var capture = map(map(fixture.get("response")).get("captureIdentity"));
        var scope = new RuntimeScope((String) context.get("tenantId"), (String) context.get("workspaceId"),
                (String) context.get("workspaceGeneration"), (String) context.get("mountRoot"),
                (String) context.get("capabilityDigest"), "workspace");
        var session = new RuntimeSession((String) capture.get("sessionId"), (String) map(request.get("reference")).get("sessionId"), "continuation", scope);
        var seed = new RuntimeProvisionSeed((String) context.get("provisionRequestId"), (String) context.get("runtimeInstanceId"),
                (String) context.get("runtimeIncarnation"), (String) context.get("leaseId"), ((Number) context.get("epoch")).longValue(), (String) context.get("token"));
        var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:1"), seed.getToken(), seed.getLeaseId(), seed.getEpoch());
        var provision = new RuntimeProvisionRequest(scope, null, "kubernetes-workspace", (String) context.get("storageId"));
        var runtime = new RuntimeBindingRecord("binding-a", provision, seed, 9, RuntimeBindingRecord.State.DRAINING,
                lease, new RuntimeResourceHandle("kubernetes-workspace", 1, Map.of("fixture", "wrapper-only")),
                3, true, null, null, 0, 1, null, Instant.now(), Instant.now());
        var record = new RuntimeSessionRecord(session, "binding-a", 9, RuntimeSessionRecord.State.READY, 1, Instant.now());
        var binding = new ContextBinding(scope.getTenantId(), scope.getWorkspaceId(), 7, provision.getStorageId(), ".", "config-a", 1);
        var resolver = mock(WorkspaceRuntimeResolver.class);
        when(resolver.savedBinding(session.getHarnessSessionId())).thenReturn(binding);
        var bindings = mock(RuntimeBindingRepository.class);
        when(bindings.findById("binding-a")).thenReturn(runtime);
        var sessions = mock(RuntimeSessionRepository.class);
        when(sessions.findById(scope, session.getRuntimeSessionId())).thenReturn(record);
        var ownership = mock(WorkspaceExecutionStore.class);
        var http = mock(HttpRuntimeTransport.class);
        return new Fixture(new WorkspaceRuntimeTransport(http, resolver, ownership, bindings, sessions), http, resolver,
                ownership, bindings, sessions, runtime, record, lease, session, boot, map(fixture.get("expectedPod")), request, capture);
    }

    private record Fixture(WorkspaceRuntimeTransport transport, HttpRuntimeTransport http, WorkspaceRuntimeResolver resolver,
            WorkspaceExecutionStore ownership, RuntimeBindingRepository bindings, RuntimeSessionRepository sessions,
            RuntimeBindingRecord runtime, RuntimeSessionRecord record, RuntimeLease lease, RuntimeSession session,
            Map<String, Object> boot, Map<String, Object> pod, Map<String, Object> request, Map<String, Object> capture) {
    }
}
