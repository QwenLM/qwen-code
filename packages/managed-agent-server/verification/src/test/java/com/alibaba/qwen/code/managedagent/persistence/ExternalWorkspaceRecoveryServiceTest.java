package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.WorkspaceAccess;
import com.alibaba.qwen.code.runtimebroker.spi.ExternalWorkspaceRecoveryGateway;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import javax.sql.DataSource;

import java.net.URI;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class ExternalWorkspaceRecoveryServiceTest {
    private final ManagedWorkspaceRegistry registry = mock(ManagedWorkspaceRegistry.class);
    private final RuntimeBindingRepository bindings = mock(RuntimeBindingRepository.class);
    private final ToolExecutionRepository executions = mock(ToolExecutionRepository.class);
    private final ExternalWorkspaceRecoveryGateway broker =
            mock(ExternalWorkspaceRecoveryGateway.class);
    private final DataSource dataSource = mock(DataSource.class);
    private final RuntimeBindingRecord binding = mock(RuntimeBindingRecord.class);
    private ExternalWorkspaceRecoveryService service;

    @BeforeEach
    void setUp() throws Exception {
        Connection connection = mock(Connection.class);
        DatabaseMetaData metadata = mock(DatabaseMetaData.class);
        when(dataSource.getConnection()).thenReturn(connection);
        when(connection.getMetaData()).thenReturn(metadata);
        when(metadata.getDatabaseProductName()).thenReturn("MySQL");
        service = new ExternalWorkspaceRecoveryService(registry, bindings, executions, broker, dataSource);
        when(registry.accessOf("tenant", "owner", "workspace")).thenReturn(WorkspaceAccess.OWNER);
        when(registry.bindingCurrent("tenant", "workspace", 1, "workspace")).thenReturn(true);
        RuntimeProvisionRequest request = new RuntimeProvisionRequest(new RuntimeScope("tenant", "workspace",
                "1", "/var/lib/managed-workspace", WorkspaceExecutionProfile.CAPABILITY_DIGEST, "workspace"),
                null, "external-workspace", "workspace");
        when(binding.getRequest()).thenReturn(request);
        when(binding.getBindingId()).thenReturn("binding");
        when(binding.getGeneration()).thenReturn(1L);
        when(binding.getVersion()).thenReturn(7L);
        when(binding.getState()).thenReturn(RuntimeBindingRecord.State.READY);
        RuntimeProvisionSeed seed = mock(RuntimeProvisionSeed.class);
        RuntimeLease lease = mock(RuntimeLease.class);
        when(seed.matches(lease)).thenReturn(true);
        when(lease.getEndpoint()).thenReturn(URI.create("http://127.0.0.1:41467"));
        when(binding.getProvisionSeed()).thenReturn(seed);
        when(binding.getLease()).thenReturn(lease);
        when(binding.getResourceHandle()).thenReturn(mock(RuntimeResourceHandle.class));
        when(bindings.findById("binding")).thenReturn(binding);
        when(broker.externalRecoveryProviderRequest(binding)).thenReturn(Map.of("boot", Map.of("token", "private-token")));
    }

    @Test
    void nonOwnerCannotDiscoverBindings() {
        when(registry.accessOf("tenant", "reader", "workspace")).thenReturn(WorkspaceAccess.READER);
        assertThrows(RuntimeBrokerException.class,
                () -> service.listCandidates("tenant", "reader", "workspace", null, 10));
        verifyNoInteractions(bindings, broker, executions);
    }

    @Test
    void missingLeaseAndUnknownExecutionNeverExportBoot() {
        RuntimeLease lease = binding.getLease();
        when(binding.getLease()).thenReturn(null);
        assertThrows(RuntimeBrokerException.class,
                () -> service.requireSnapshot("tenant", "owner", "workspace", "binding", 1, 7));
        when(binding.getLease()).thenReturn(lease);
        when(executions.hasActiveByBinding("binding", 1)).thenReturn(true);
        assertThrows(RuntimeBrokerException.class,
                () -> service.requireSnapshot("tenant", "owner", "workspace", "binding", 1, 7));
        verifyNoInteractions(broker);
    }

    @Test
    void readOnlySnapshotRejectsChangedVersionAndDoesNotSerializeCredentials() throws Exception {
        var snapshot = service.requireSnapshot("tenant", "owner", "workspace", "binding", 1, 7);
        assertEquals(URI.create("http://127.0.0.1:41467"), snapshot.originalEndpoint());
        ObjectMapper mapper = new ObjectMapper().disable(
                com.fasterxml.jackson.databind.SerializationFeature.FAIL_ON_EMPTY_BEANS);
        assertFalse(mapper.writeValueAsString(snapshot).contains("private-token"));
        assertFalse(snapshot.toString().contains("private-token"));
        when(binding.getVersion()).thenReturn(8L);
        assertThrows(RuntimeBrokerException.class,
                () -> service.recoverSnapshot("tenant", "owner", "workspace", snapshot));
        // 版本漂移后 recoverSnapshot 在到达宿主前就被 blocked() 拒绝；
        // 但 requireSnapshot 已经向 broker 取过一次只读 boot 回执，不能断言零交互。
        verify(broker, never()).recoverExternalWorkspaceBinding(
                org.mockito.ArgumentMatchers.anyString(),
                org.mockito.ArgumentMatchers.anyLong(),
                org.mockito.ArgumentMatchers.anyLong());
    }

    @Test
    void brokerFencesAdmissionBeforeCheckingConcurrentTools() {
        var provisioner = mock(com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner.class);
        when(provisioner.supportsKind("external-workspace")).thenReturn(true);
        when(provisioner.supportsStartupRecovery(binding.getResourceHandle())).thenReturn(true);
        when(binding.isActive()).thenReturn(true);
        RuntimeBindingRecord claimed = mock(RuntimeBindingRecord.class);
        RuntimeBindingRecord fenced = mock(RuntimeBindingRecord.class);
        when(claimed.getBindingId()).thenReturn("binding");
        when(claimed.getGeneration()).thenReturn(1L);
        when(claimed.getVersion()).thenReturn(8L);
        // 提前取出 binding 的 mock 返回值，避免在 stubbing claimed 时再次触发 binding
        // 的 stubbed 调用，造成 UnfinishedStubbingException。
        var claimedRequest = binding.getRequest();
        var claimedLease = binding.getLease();
        var claimedSeed = binding.getProvisionSeed();
        var claimedHandle = binding.getResourceHandle();
        when(claimed.getRequest()).thenReturn(claimedRequest);
        when(claimed.getState()).thenReturn(RuntimeBindingRecord.State.READY);
        when(claimed.getLease()).thenReturn(claimedLease);
        when(claimed.getProvisionSeed()).thenReturn(claimedSeed);
        when(claimed.getResourceHandle()).thenReturn(claimedHandle);
        when(claimed.getOperationGeneration()).thenReturn(1L);
        when(fenced.getBindingId()).thenReturn("binding");
        when(fenced.getGeneration()).thenReturn(1L);
        when(fenced.getState()).thenReturn(RuntimeBindingRecord.State.RECOVERY_BLOCKED);
        when(fenced.getOperationGeneration()).thenReturn(1L);
        when(fenced.getOperationOwner()).thenReturn("broker-owner");
        // The compensation re-reads the row it fenced, exactly as it must in
        // production: the claim renewal between steps rewrites the version.
        when(bindings.findById("binding")).thenReturn(binding, fenced);
        // The tool admitted between the eligibility read and the fence is
        // exactly what the fence exists to protect: every evidence path
        // requires READY/DRAINING, so the conflict must put the row back.
        var restoreState = new java.util.concurrent.atomic.AtomicReference<RuntimeBindingRecord.State>();
        var restored = mock(RuntimeBindingRecord.class);
        when(fenced.withState(org.mockito.ArgumentMatchers.any(),
                org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any())).thenAnswer(call -> {
                    restoreState.set(call.getArgument(0));
                    return restored;
                });
        when(bindings.compareAndSet(fenced, restored)).thenReturn(restored);
        when(bindings.claimOperation(org.mockito.ArgumentMatchers.eq("binding"),
                org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.any())).thenReturn(claimed);
        when(claimed.withState(org.mockito.ArgumentMatchers.eq(RuntimeBindingRecord.State.RECOVERY_BLOCKED),
                org.mockito.ArgumentMatchers.eq(claimedLease), org.mockito.ArgumentMatchers.any())).thenReturn(fenced);
        when(bindings.compareAndSet(claimed, fenced)).thenReturn(fenced);
        // 最后一次读取模拟工具在初始检查与关闭准入之间成功抢先进入。
        when(executions.hasActiveByBinding("binding", 1)).thenReturn(false, false, true);
        var nativeBroker = new com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerService(
                mock(com.alibaba.qwen.code.runtimebroker.HarnessSessionResolver.class), provisioner,
                mock(com.alibaba.qwen.code.runtimebroker.RuntimeTransport.class), bindings,
                mock(com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository.class), executions,
                "broker-owner", java.time.Duration.ofSeconds(30), java.time.Duration.ofSeconds(30));
        try {
            assertThrows(java.util.concurrent.CompletionException.class,
                    () -> nativeBroker.recoverExternalWorkspaceBinding("binding", 1, 7).toCompletableFuture().join());
            verify(bindings).compareAndSet(claimed, fenced);
            // The blocking fence was compensated on its own version, so the
            // healthy binding is READY again and a racing tool can still be
            // answered from it; leaving RECOVERY_BLOCKED would have failed
            // that tool's evidence path forever.
            verify(bindings).compareAndSet(fenced, restored);
            assertEquals(RuntimeBindingRecord.State.READY, restoreState.get());
            verify(provisioner, never()).reconcile(org.mockito.ArgumentMatchers.any(),
                    org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
        } finally {
            nativeBroker.close();
        }
    }

    @Test
    void anEmptyObservationRestoresTheAttemptsFence() {
        // R4-1: an observation that answers nothing is not a verdict. The
        // fence exists to close new writes while the row is re-observed, so
        // the attempt that wrote it must undo it before answering; otherwise
        // a successful recovery leaves the healthy binding RECOVERY_BLOCKED.
        assertFenceRestored(null);
    }

    @Test
    void aStartingObservationRestoresTheAttemptsFence() {
        // STARTING/UNKNOWN are the other no-verdict shapes: the Runtime is
        // neither identified nor lost, so recovery must stay retryable.
        assertFenceRestored(com.alibaba.qwen.code.runtimebroker.RuntimeObservation.starting(
                binding.getResourceHandle()));
    }

    @Test
    void aConflictingObservationKeepsTheFence() {
        // The counterpart of the two cases above: identity evidence is a
        // verdict, so the fence stays and the binding remains blocked.
        var provisioner = mock(com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner.class);
        var request = binding.getRequest();
        var lease = binding.getLease();
        var seed = binding.getProvisionSeed();
        var handle = binding.getResourceHandle();
        when(provisioner.supportsKind("external-workspace")).thenReturn(true);
        when(provisioner.supportsStartupRecovery(handle)).thenReturn(true);
        when(binding.isActive()).thenReturn(true);
        RuntimeBindingRecord claimed = recoveryRow(request, lease, seed, handle,
                RuntimeBindingRecord.State.READY, 8L);
        RuntimeBindingRecord fenced = recoveryRow(request, lease, seed, handle,
                RuntimeBindingRecord.State.RECOVERY_BLOCKED, 9L);
        RuntimeBindingRecord renewed = recoveryRow(request, lease, seed, handle,
                RuntimeBindingRecord.State.RECOVERY_BLOCKED, 10L);
        RuntimeBindingRecord blocked = recoveryRow(request, lease, seed, handle,
                RuntimeBindingRecord.State.RECOVERY_BLOCKED, 11L);
        RuntimeBindingRecord restored = recoveryRow(request, lease, seed, handle,
                RuntimeBindingRecord.State.READY, 11L);
        when(bindings.claimOperation(eq("binding"), anyString(), any())).thenReturn(claimed);
        when(claimed.withState(eq(RuntimeBindingRecord.State.RECOVERY_BLOCKED), any(), any())).thenReturn(fenced);
        when(bindings.compareAndSet(claimed, fenced)).thenReturn(fenced);
        when(bindings.renewOperation(eq("binding"), anyString(), eq(1L), any())).thenReturn(renewed);
        when(renewed.withState(eq(RuntimeBindingRecord.State.RECOVERY_BLOCKED), any(), any())).thenReturn(blocked);
        when(bindings.compareAndSet(renewed, blocked)).thenReturn(blocked);
        when(bindings.findById("binding")).thenReturn(binding, renewed, blocked);
        when(executions.hasActiveByBinding("binding", 1L)).thenReturn(false);
        when(provisioner.reconcile(any(), any(), any(), any())).thenReturn(
                java.util.concurrent.CompletableFuture.completedFuture(
                        com.alibaba.qwen.code.runtimebroker.RuntimeObservation.conflict(handle)));
        var nativeBroker = new com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerService(
                mock(com.alibaba.qwen.code.runtimebroker.HarnessSessionResolver.class), provisioner,
                mock(com.alibaba.qwen.code.runtimebroker.RuntimeTransport.class), bindings,
                mock(com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository.class), executions,
                "broker-owner", java.time.Duration.ofSeconds(30), java.time.Duration.ofSeconds(30));
        try {
            RuntimeBindingRecord recovered = nativeBroker.recoverExternalWorkspaceBinding("binding", 1, 7)
                    .toCompletableFuture().join();
            assertEquals(RuntimeBindingRecord.State.RECOVERY_BLOCKED, recovered.getState());
            // The verdict write keeps the fence; only the no-verdict paths
            // write READY back.
            verify(bindings).compareAndSet(renewed, blocked);
            verify(bindings, never()).compareAndSet(any(), eq(restored));
        } finally {
            nativeBroker.close();
        }
    }

    private void assertFenceRestored(
            com.alibaba.qwen.code.runtimebroker.RuntimeObservation observed) {
        var provisioner = mock(com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner.class);
        var request = binding.getRequest();
        var lease = binding.getLease();
        var seed = binding.getProvisionSeed();
        var handle = binding.getResourceHandle();
        when(provisioner.supportsKind("external-workspace")).thenReturn(true);
        when(provisioner.supportsStartupRecovery(handle)).thenReturn(true);
        when(binding.isActive()).thenReturn(true);
        RuntimeBindingRecord claimed = recoveryRow(request, lease, seed, handle,
                RuntimeBindingRecord.State.READY, 8L);
        RuntimeBindingRecord fenced = recoveryRow(request, lease, seed, handle,
                RuntimeBindingRecord.State.RECOVERY_BLOCKED, 9L);
        RuntimeBindingRecord renewed = recoveryRow(request, lease, seed, handle,
                RuntimeBindingRecord.State.RECOVERY_BLOCKED, 10L);
        RuntimeBindingRecord restored = recoveryRow(request, lease, seed, handle,
                RuntimeBindingRecord.State.READY, 11L);
        when(bindings.claimOperation(eq("binding"), anyString(), any())).thenReturn(claimed);
        when(claimed.withState(eq(RuntimeBindingRecord.State.RECOVERY_BLOCKED), any(), any())).thenReturn(fenced);
        when(bindings.compareAndSet(claimed, fenced)).thenReturn(fenced);
        when(bindings.renewOperation(eq("binding"), anyString(), eq(1L), any())).thenReturn(renewed);
        when(renewed.withState(eq(RuntimeBindingRecord.State.READY), any(), any())).thenReturn(restored);
        when(bindings.compareAndSet(renewed, restored)).thenReturn(restored);
        when(bindings.findById("binding")).thenReturn(binding, renewed);
        when(executions.hasActiveByBinding("binding", 1L)).thenReturn(false);
        when(provisioner.reconcile(any(), any(), any(), any())).thenReturn(
                java.util.concurrent.CompletableFuture.completedFuture(observed));
        var nativeBroker = new com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerService(
                mock(com.alibaba.qwen.code.runtimebroker.HarnessSessionResolver.class), provisioner,
                mock(com.alibaba.qwen.code.runtimebroker.RuntimeTransport.class), bindings,
                mock(com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository.class), executions,
                "broker-owner", java.time.Duration.ofSeconds(30), java.time.Duration.ofSeconds(30));
        try {
            RuntimeBindingRecord recovered = nativeBroker.recoverExternalWorkspaceBinding("binding", 1, 7)
                    .toCompletableFuture().join();
            assertEquals(RuntimeBindingRecord.State.READY, recovered.getState());
            // The restoration CAS names the renewed claim: the steps in
            // between rewrote the row version, so a stale snapshot would
            // leave the fence in place.
            verify(bindings).compareAndSet(renewed, restored);
        } finally {
            nativeBroker.close();
        }
    }

    private RuntimeBindingRecord recoveryRow(RuntimeProvisionRequest request, RuntimeLease lease,
            RuntimeProvisionSeed seed, RuntimeResourceHandle handle,
            RuntimeBindingRecord.State state, long version) {
        RuntimeBindingRecord row = mock(RuntimeBindingRecord.class);
        when(row.getBindingId()).thenReturn("binding");
        when(row.getGeneration()).thenReturn(1L);
        when(row.getVersion()).thenReturn(version);
        when(row.getState()).thenReturn(state);
        when(row.getOperationGeneration()).thenReturn(1L);
        when(row.getOperationOwner()).thenReturn("broker-owner");
        when(row.getRequest()).thenReturn(request);
        when(row.getLease()).thenReturn(lease);
        when(row.getProvisionSeed()).thenReturn(seed);
        when(row.getResourceHandle()).thenReturn(handle);
        return row;
    }

    @Test
    void volatileCatalogIsNotARecoverySource() throws Exception {
        when(dataSource.getConnection().getMetaData().getDatabaseProductName()).thenReturn("H2");
        assertThrows(IllegalStateException.class,
                () -> new ExternalWorkspaceRecoveryService(registry, bindings, executions, broker, dataSource));
    }
}
