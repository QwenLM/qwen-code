package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.SshRuntimeSettings;
import com.alibaba.qwen.code.managedagent.store.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.store.SshWorkspaceStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.AcceptanceVerdict;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ParkedOperation;
import com.alibaba.qwen.code.runtimebroker.SshConnectionManager;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class SshWorkspaceServiceTest {
    private ManagedAgentProperties properties;
    private SshWorkspaceStore store;
    private SshConnectionManager connections;
    private org.springframework.jdbc.core.JdbcTemplate jdbc;

    @BeforeEach
    void setup() {
        properties = new ManagedAgentProperties();
        properties.getRuntimeBroker().getSsh().setNodes(List.of(new SshRuntimeSettings.Node("mac", "Mac", "test-host",
                "/node", "/cli.js", "/state", List.of("/work"), 41270, "0.25.1",
                List.of(new SshRuntimeSettings.Access("tenant", "actor")))));
        var source = new DriverManagerDataSource("jdbc:h2:mem:ssh-service-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        store = new SshWorkspaceStore(jdbc, new DataSourceTransactionManager(source));
        connections = mock(SshConnectionManager.class);
    }

    @Test
    void requiresEnabledAdmissionAndExactActorGrant() {
        try (var service = new SshWorkspaceService(properties, store, connections)) {
            assertThat(service.list("tenant", "actor").supported()).isFalse();
            assertThatThrownBy(() -> service.check("tenant", "actor", "mac", "/work/project"))
                    .isInstanceOf(ApiException.class);
            properties.getRuntimeBroker().getSsh().setEnabled(true);
            assertThat(service.list("tenant", "actor").data()).hasSize(1);
            assertThat(service.list("tenant", "other").data()).isEmpty();
            assertThatThrownBy(() -> service.create("tenant", "other", "mac", "/work/project", "Project", "key"))
                    .isInstanceOf(ApiException.class);
        }
    }

    @Test
    void completesRegistrationOutsideSqlTransactionsAndQueriesAfterAdmissionDisabled() throws Exception {
        properties.getRuntimeBroker().getSsh().setEnabled(true);
        var marker = new AtomicReference<Map<String, Object>>();
        Map<String, Object> identity = Map.of("root", "/work/project", "hostId", "host", "device", "1", "inode", "2", "birthTime", "3");
        when(connections.bootstrap(any(), any())).thenAnswer(invocation -> {
            assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
            Map<String, Object> request = invocation.getArgument(1);
            if ("register-storage".equals(request.get("operation"))) {
                marker.set(SshWorkspaceStore.object(request, "marker"));
                return Map.of("identity", identity, "marker", marker.get());
            }
            var result = new LinkedHashMap<String, Object>();
            result.put("platform", "darwin");
            result.put("nodeVersion", "22.22.3");
            result.put("qwenVersion", "0.25.1");
            result.put("identity", identity);
            result.put("marker", marker.get());
            return result;
        });
        try (var service = new SshWorkspaceService(properties, store, connections)) {
            assertThat(service.check("tenant", "actor", "mac", "/work/project").canonicalPath()).isEqualTo("/work/project");
            var operation = service.create("tenant", "actor", "mac", "/work/project", "Project", "key");
            long until = System.nanoTime() + java.time.Duration.ofSeconds(5).toNanos();
            while (!"completed".equals(operation.status()) && System.nanoTime() < until) {
                Thread.sleep(10);
                operation = service.get("tenant", "actor", operation.operationId());
            }
            assertThat(operation.status()).isEqualTo("completed");
            String operationId = operation.operationId();
            properties.getRuntimeBroker().getSsh().setEnabled(false);
            assertThat(service.get("tenant", "actor", operation.operationId()).workspaceId()).isEqualTo(operation.workspaceId());
            assertThat(service.create("tenant", "actor", "mac", "/work/project", "Project", "key").operationId())
                    .isEqualTo(operation.operationId());
            assertThatThrownBy(() -> service.create("tenant", "actor", "mac", "/other", "Project", "key"))
                    .isInstanceOf(ApiException.class).hasMessageContaining("another request");
            assertThatThrownBy(() -> service.create("tenant", "actor", "mac", "/work/project", "Project", "new-key"))
                    .isInstanceOf(ApiException.class);
            assertThatThrownBy(() -> service.get("tenant", "other", operationId)).isInstanceOf(ApiException.class);
        }
    }

    @Test
    void refusesAnUnmatchedQwenInstallation() {
        properties.getRuntimeBroker().getSsh().setEnabled(true);
        when(connections.bootstrap(any(), any())).thenReturn(Map.of("qwenVersion", "old"));
        try (var service = new SshWorkspaceService(properties, store, connections)) {
            assertThatThrownBy(() -> service.check("tenant", "actor", "mac", "/work/project"))
                    .isInstanceOf(ApiException.class).hasMessageContaining("pinned version");
        }
    }

    // D7-2: a parked registration reads its node, read-only, and settles
    // from what the node holds; the node is never asked to register again.
    @Test
    void aParkedRegistrationWhoseMarkerLandedCompletes() {
        var intent = parkedReservation();
        probeReturns(IDENTITY, marker(intent));
        try (var service = new SshWorkspaceService(properties, store, connections)) {
            assertThat(reconcile(service, intent)).isEqualTo(AcceptanceVerdict.committed());
            var completed = service.get("tenant", "actor", intent.operationId());
            assertThat(completed.status()).isEqualTo("completed");
            assertThat(completed.workspaceId()).isEqualTo(intent.workspaceId());
        }
        assertOnlyProbed();
    }

    @Test
    void aParkedRegistrationWithoutItsMarkerFailsAndReleasesTheDirectory() {
        var intent = parkedReservation();
        probeReturns(IDENTITY, null);
        try (var service = new SshWorkspaceService(properties, store, connections)) {
            assertThat(reconcile(service, intent))
                    .isEqualTo(AcceptanceVerdict.notCommitted("workspace_registration_failed"));
            var failed = service.get("tenant", "actor", intent.operationId());
            assertThat(failed.status()).isEqualTo("failed");
            assertThat(failed.failureCode()).isEqualTo("workspace_registration_failed");
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_storage_owner", Integer.class)).isZero();
        assertOnlyProbed();
    }

    @Test
    void anotherDirectoryAtTheRootFailsTheRegistration() {
        var intent = parkedReservation();
        var replaced = new LinkedHashMap<>(IDENTITY);
        replaced.put("inode", "99");
        probeReturns(replaced, null);
        try (var service = new SshWorkspaceService(properties, store, connections)) {
            assertThat(reconcile(service, intent))
                    .isEqualTo(AcceptanceVerdict.notCommitted("ssh_runtime_identity_mismatch"));
        }
        assertOnlyProbed();
    }

    // Nothing proven: another registration's marker, a node that no longer
    // admits the actor, and an unreadable node all leave it parked.
    @Test
    void unprovenEvidenceKeepsTheRegistrationParked() {
        var intent = parkedReservation();
        var foreign = new LinkedHashMap<>(marker(intent));
        foreign.put("registrationId", UUID.randomUUID().toString());
        probeReturns(IDENTITY, foreign);
        try (var service = new SshWorkspaceService(properties, store, connections)) {
            assertThat(reconcile(service, intent)).isEqualTo(AcceptanceVerdict.unknown());
            assertThat(service.get("tenant", "actor", intent.operationId()).status()).isEqualTo("recovery_blocked");
            when(connections.bootstrap(any(), any())).thenThrow(new IllegalStateException("node unreachable"));
            var parked = new ParkedOperation("tenant", null, intent.operationId(), SshWorkspaceStore.OPERATION);
            assertThatThrownBy(() -> service.read(parked)).isInstanceOf(IllegalStateException.class);
        }
        properties.getRuntimeBroker().getSsh().setNodes(List.of(new SshRuntimeSettings.Node("mac", "Mac",
                "test-host", "/node", "/cli.js", "/state", List.of("/work"), 41270, "0.25.1",
                List.of(new SshRuntimeSettings.Access("tenant", "someone-else")))));
        org.mockito.Mockito.clearInvocations(connections);
        try (var service = new SshWorkspaceService(properties, store, connections)) {
            assertThat(reconcile(service, intent)).isEqualTo(AcceptanceVerdict.unknown());
        }
        org.mockito.Mockito.verify(connections, org.mockito.Mockito.never()).bootstrap(any(), any());
    }

    // A row parked before this change without a reservation never reached
    // its node: it fails at once, without a probe.
    @Test
    void anUnreservedParkedRegistrationFailsWithoutAProbe() {
        var operation = store.begin("tenant", "actor", "key", "mac", "/work/project", "Project");
        jdbc.update("UPDATE ma_operation SET state = 'RECOVERY_BLOCKED', phase = 'RECOVERY_BLOCKED',"
                + " failure_code = 'ssh_runtime_version_mismatch', available_at = 0");
        try (var service = new SshWorkspaceService(properties, store, connections)) {
            assertThat(service.parked(10)).hasSize(1);
            var parked = service.parked(10).getFirst();
            var verdict = service.read(parked).orElseThrow();
            assertThat(verdict).isEqualTo(AcceptanceVerdict.notCommitted("ssh_runtime_version_mismatch"));
            assertThat(service.settle(null, parked, verdict, 0)).isTrue();
            assertThat(service.get("tenant", "actor", operation.operationId()).status()).isEqualTo("failed");
        }
        org.mockito.Mockito.verify(connections, org.mockito.Mockito.never()).bootstrap(any(), any());
    }

    private static final Map<String, Object> IDENTITY = Map.of("root", "/work/project", "hostId", "host",
            "device", "1", "inode", "2", "birthTime", "3");

    private SshWorkspaceStore.Intent parkedReservation() {
        var operation = store.begin("tenant", "actor", "key", "mac", "/work/project", "Project");
        var intent = store.claim("tenant", "actor", operation.operationId(), "owner");
        store.reserve(intent, "owner", Map.of("nodeId", "mac", "identity", IDENTITY, "marker", marker(intent),
                "qwenVersion", "0.25.1"));
        store.fail(intent, "owner", "workspace_registration_failed", false);
        jdbc.update("UPDATE ma_operation SET available_at = 0");
        return intent;
    }

    private static Map<String, Object> marker(SshWorkspaceStore.Intent intent) {
        var marker = new LinkedHashMap<String, Object>(IDENTITY);
        marker.put("version", 2);
        marker.put("tenantId", intent.tenantId());
        marker.put("storageId", intent.storageId());
        marker.put("registrationId", intent.registrationId());
        return marker;
    }

    private void probeReturns(Map<String, Object> identity, Map<String, Object> marker) {
        when(connections.bootstrap(any(), any())).thenAnswer(invocation -> {
            var result = new LinkedHashMap<String, Object>();
            result.put("platform", "darwin");
            result.put("qwenVersion", "0.25.1");
            result.put("identity", identity);
            result.put("marker", marker);
            return result;
        });
    }

    private AcceptanceVerdict reconcile(SshWorkspaceService service, SshWorkspaceStore.Intent intent) {
        assertThat(service.parked(10)).extracting(ParkedOperation::operationId).containsExactly(intent.operationId());
        var parked = service.parked(10).getFirst();
        var verdict = service.read(parked).orElseThrow();
        service.settle(null, parked, verdict, 0);
        return verdict;
    }

    // Every call the evidence made was a probe: the node was never asked to
    // register the storage again.
    private void assertOnlyProbed() {
        var captor = org.mockito.ArgumentCaptor.forClass(Map.class);
        org.mockito.Mockito.verify(connections, org.mockito.Mockito.atLeastOnce()).bootstrap(any(), captor.capture());
        assertThat(captor.getAllValues()).allSatisfy(request -> assertThat(request.get("operation")).isEqualTo("probe"));
    }
}
