package com.alibaba.qwen.code.runtimebroker.provisioning.kubernetes;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.persistence.WorkspaceCsiRegistration;
import com.alibaba.qwen.code.managedagent.contracts.workspace.RuntimeWarmer;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.persistence.ResidentWorkspaces;
import com.alibaba.qwen.code.managedagent.persistence.WorkspaceExecutionStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.persistence.InMemoryRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.InMemoryToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.MockedConstruction;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;

import javax.sql.DataSource;

import java.util.List;
import java.util.concurrent.CompletableFuture;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.mockConstruction;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.same;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class ResidentWorkspaceProvisionerTest {
    private MockedConstruction<KubernetesHttpRuntimeClient> clients;
    private MockedConstruction<WorkspaceCsiRuntimeProvisioner> delegates;
    private ResidentWorkspaceProvisioner wrapper;
    private RuntimeProvisionRequest request;
    private ManagedAgentProperties properties;
    private JdbcTemplate jdbc;
    private JdbcRuntimeBindingRepository bindings;
    private final RuntimeProvisionSeed seed = new RuntimeProvisionSeed("request", "runtime", "incarnation",
            "lease", 1, "inert-test-token");

    @BeforeEach
    void setUp() throws Exception {
        clients = mockConstruction(KubernetesHttpRuntimeClient.class);
        delegates = mockConstruction(WorkspaceCsiRuntimeProvisioner.class);
        var registration = new WorkspaceCsiRegistration("tenant", "storage", "cluster", "resident", "claim",
                "pvc-uid", "volume", "pv-uid", "diskplugin.csi.alibabacloud.com", "handle", "backend", "serial",
                "/workspace", 1);
        var mapping = new ManagedAgentProperties.RuntimeBroker.ResidentWorkspace("workspace", 1, registration,
                new com.alibaba.qwen.code.managedagent.contracts.runtime.ProtectionIdentity("namespace", "policy", "policy-uid", 1,
                        "binding", "binding-uid", 1), "worker@sha256:" + "a".repeat(64),
                List.of("node", "/worker/cli.js"), List.of());
        properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        properties.getHarness().setWorkspaceShellEnabled(false);
        var config = properties.getRuntimeBroker();
        config.setIsolationClass("workspace");
        config.setResidentWorkspaces(List.of(mapping));
        config.setTrustedLocalRebootRecovery(false);
        config.setVerifiedWorkspaceRecoveryEnabled(false);
        config.setChildWorkspacesEnabled(false);
        config.setResidentKubernetesApiUrl("https://no-network.invalid");
        config.setResidentKubernetesTokenFile("/inert/token");
        config.setResidentKubernetesCaFile("/inert/ca");
        jdbc = mock(JdbcTemplate.class);
        var source = mock(DataSource.class);
        when(jdbc.getDataSource()).thenReturn(source);
        when(jdbc.queryForList(anyString(), eq(String.class), any(), any(), any(), any(), any()))
                .thenReturn(List.of(new ObjectMapper().writeValueAsString(registration)));
        bindings = mock(JdbcRuntimeBindingRepository.class);
        when(bindings.usesDataSource(source)).thenReturn(true);
        wrapper = new ResidentWorkspaceProvisioner(properties, new com.alibaba.qwen.code.managedagent.persistence.WorkspaceCsiReservationStore(jdbc, mock(PlatformTransactionManager.class), new ObjectMapper()), bindings);
        request = new RuntimeProvisionRequest(ResidentWorkspaces.scope(mapping), null, "kubernetes-workspace", "storage");
    }

    @AfterEach
    void tearDown() {
        delegates.close();
        clients.close();
    }

    @Test
    void logicalCloseIsAvailableOnlyForTheConfiguredResidentBinding() {
        var config = properties.getRuntimeBroker();
        config.setPort(0);
        config.setProvisioner("kubernetes-workspace");
        config.setToken("inert-broker-token");
        config.setWorkspaceId("workspace");
        config.setWorkspaceCwd("/workspace");
        properties.getHarness().setCapabilityDigest("test-capability");
        var binding = new ContextBinding("tenant", "workspace", 1, "storage", ".",
                WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1);
        var foreign = new ContextBinding("tenant", "other-workspace", 1, "storage", ".",
                WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1);
        try (var broker = com.alibaba.qwen.code.managedagent.config.runtime.EmbeddedBrokerFixture.create(mock(ManagedAgentStore.class), properties,
                bindings, new InMemoryRuntimeSessionRepository(), new InMemoryToolExecutionRepository(),
                mock(WorkspaceExecutionStore.class), null, null, jdbc,
                mock(PlatformTransactionManager.class), wrapper)) {
            assertThat(broker.supportsWorkspaceClose()).isTrue();
            assertThat(RuntimeWarmer.supportsClose(broker, binding)).isTrue();
            assertThat(RuntimeWarmer.supportsClose(broker, foreign)).isFalse();
        }
    }

    @Test
    void factoryUsesOnlyOriginalCsiPortsAndDoesNotCreateClientsDuringValidation() {
        var factory = new KubernetesRuntimeProviderFactory();
        int originalClients = clients.constructed().size();
        factory.validate(properties);
        assertThat(clients.constructed()).hasSize(originalClients);
        var storage = mock(com.alibaba.qwen.code.managedagent.repository.WorkspaceCsiReservations.class);
        when(storage.usesSameDataSource(bindings)).thenReturn(true);
        var ports = new com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderDependencies() {
            @Override
            public com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository bindings() { return bindings; }
            @Override
            public com.alibaba.qwen.code.managedagent.repository.WorkspaceCsiReservations csiReservations() { return storage; }
        };
        try (var provider = factory.create(properties, null, ports)) {
            assertThat(provider.kind()).isEqualTo("kubernetes-workspace");
            verify(storage).usesSameDataSource(bindings);
            verify(storage).requireRegistration(properties.getRuntimeBroker().getResidentWorkspaces().getFirst());
        }
        verify(delegates.constructed().getLast()).close();
        assertThat(factory.kinds()).containsExactly("kubernetes-workspace");
        assertThatThrownBy(() -> factory.create(properties, null,
                com.alibaba.qwen.code.runtimebroker.spi.RuntimeProviderDependencies.NONE))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("original JDBC authority");
    }

    @Test
    void laterRegistrationFailureClosesEarlierDelegates() {
        var config = properties.getRuntimeBroker();
        var first = config.getResidentWorkspaces().getFirst();
        var registration = new WorkspaceCsiRegistration("tenant", "other-storage", "cluster", "resident", "other-claim",
                "other-pvc-uid", "other-volume", "other-pv-uid", "diskplugin.csi.alibabacloud.com", "other-handle",
                "backend", "other-serial", "/other-workspace", 1);
        var second = new ManagedAgentProperties.RuntimeBroker.ResidentWorkspace("other-workspace", 1, registration,
                first.protection(), first.image(), first.command(), first.artifacts());
        config.setResidentWorkspaces(List.of(first, second));
        var storage = mock(com.alibaba.qwen.code.managedagent.repository.WorkspaceCsiReservations.class);
        when(storage.usesSameDataSource(bindings)).thenReturn(true);
        org.mockito.Mockito.doThrow(new IllegalStateException("second registration unavailable"))
                .when(storage).requireRegistration(second);
        int originalDelegates = delegates.constructed().size();
        assertThatThrownBy(() -> new ResidentWorkspaceProvisioner(properties, storage, bindings))
                .hasMessage("second registration unavailable");
        assertThat(delegates.constructed()).hasSize(originalDelegates + 1);
        verify(delegates.constructed().getLast()).close();
    }

    @Test
    void forwardsTheOriginalDurableSeedToTheSelectedProvider() {
        var provider = delegates.constructed().getFirst();
        var result = new CompletableFuture<RuntimeLease>();
        when(provider.provision(same(request), same(seed))).thenReturn(result);

        assertThat(wrapper.provision(request, seed)).isSameAs(result);
        verify(provider).provision(same(request), same(seed));
        verify(provider, never()).provision(any(RuntimeProvisionRequest.class));
        verifyNoInteractions(clients.constructed().getFirst());
    }

    @Test
    void seededProvisionStillRejectsUnselectedScopesAndPlacementIdentity() {
        var scope = request.getScope();
        var foreignTenant = new RuntimeScope("foreign", scope.getWorkspaceId(), scope.getWorkspaceGeneration(),
                scope.getCanonicalCwd(), scope.getCapabilityDigest(), scope.getIsolationClass());
        var foreignWorkspace = new RuntimeScope(scope.getTenantId(), "foreign", scope.getWorkspaceGeneration(),
                scope.getCanonicalCwd(), scope.getCapabilityDigest(), scope.getIsolationClass());
        for (var invalid : List.of(
                new RuntimeProvisionRequest(foreignTenant, null, "kubernetes-workspace", "storage"),
                new RuntimeProvisionRequest(foreignWorkspace, null, "kubernetes-workspace", "storage"),
                new RuntimeProvisionRequest(scope, null, "kubernetes-workspace", "foreign"),
                new RuntimeProvisionRequest(scope, null, "foreign", "storage"))) {
            assertThatThrownBy(() -> wrapper.provision(invalid, seed)).isInstanceOf(RuntimeBrokerException.class);
        }
        verifyNoInteractions(delegates.constructed().getFirst(), clients.constructed().getFirst());
    }

    @Test
    void unseededProvisionRemainsClosed() {
        var provider = delegates.constructed().getFirst();
        when(provider.provision(request)).thenCallRealMethod();

        assertThatThrownBy(() -> wrapper.provision(request).toCompletableFuture().join())
                .hasCauseInstanceOf(RuntimeBrokerException.class)
                .satisfies(error -> assertThat(((RuntimeBrokerException) error.getCause()).getCode())
                        .isEqualTo("workspace_csi_provenance_unavailable"));
        verify(provider, never()).provision(any(RuntimeProvisionRequest.class), any(RuntimeProvisionSeed.class));
        verifyNoInteractions(clients.constructed().getFirst());
    }
}
