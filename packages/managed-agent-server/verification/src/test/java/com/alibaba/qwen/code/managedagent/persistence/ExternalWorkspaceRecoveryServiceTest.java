package com.alibaba.qwen.code.managedagent.persistence;

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
        verifyNoInteractions(broker);
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
        when(claimed.getRequest()).thenReturn(binding.getRequest());
        when(claimed.getState()).thenReturn(RuntimeBindingRecord.State.READY);
        when(claimed.getLease()).thenReturn(binding.getLease());
        when(claimed.getProvisionSeed()).thenReturn(binding.getProvisionSeed());
        when(claimed.getResourceHandle()).thenReturn(binding.getResourceHandle());
        when(claimed.getOperationGeneration()).thenReturn(1L);
        when(fenced.getBindingId()).thenReturn("binding");
        when(fenced.getGeneration()).thenReturn(1L);
        when(bindings.claimOperation(org.mockito.ArgumentMatchers.eq("binding"),
                org.mockito.ArgumentMatchers.anyString(), org.mockito.ArgumentMatchers.any())).thenReturn(claimed);
        when(claimed.withState(org.mockito.ArgumentMatchers.eq(RuntimeBindingRecord.State.RECOVERY_BLOCKED),
                org.mockito.ArgumentMatchers.eq(binding.getLease()), org.mockito.ArgumentMatchers.any())).thenReturn(fenced);
        when(bindings.compareAndSet(claimed, fenced)).thenReturn(fenced);
        // 最后一次读取模拟工具在初始检查与关闭准入之间成功抢先进入。
        when(executions.hasActiveByBinding("binding", 1)).thenReturn(false, false, true);
        var nativeBroker = new com.alibaba.qwen.code.runtimebroker.RuntimeBrokerService(
                mock(com.alibaba.qwen.code.runtimebroker.HarnessSessionResolver.class), provisioner,
                mock(com.alibaba.qwen.code.runtimebroker.RuntimeTransport.class), bindings,
                mock(com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository.class), executions,
                "broker-owner", java.time.Duration.ofSeconds(30), java.time.Duration.ofSeconds(30));
        try {
            assertThrows(java.util.concurrent.CompletionException.class,
                    () -> nativeBroker.recoverExternalWorkspaceBinding("binding", 1, 7).toCompletableFuture().join());
            verify(bindings).compareAndSet(claimed, fenced);
            verify(provisioner, never()).reconcile(org.mockito.ArgumentMatchers.any(),
                    org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
        } finally {
            nativeBroker.close();
        }
    }

    @Test
    void volatileCatalogIsNotARecoverySource() throws Exception {
        when(dataSource.getConnection().getMetaData().getDatabaseProductName()).thenReturn("H2");
        assertThrows(IllegalStateException.class,
                () -> new ExternalWorkspaceRecoveryService(registry, bindings, executions, broker, dataSource));
    }
}
