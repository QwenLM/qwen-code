package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.SshRuntimeSettings;
import com.alibaba.qwen.code.managedagent.store.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.store.SshWorkspaceStore;
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

    @BeforeEach
    void setup() {
        properties = new ManagedAgentProperties();
        properties.getRuntimeBroker().getSsh().setNodes(List.of(new SshRuntimeSettings.Node("mac", "Mac", "test-host",
                "/node", "/cli.js", "/state", List.of("/work"), 41270, "0.25.1",
                List.of(new SshRuntimeSettings.Access("tenant", "actor")))));
        var source = new DriverManagerDataSource("jdbc:h2:mem:ssh-service-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
        ManagedSchema.initialize(source);
        store = new SshWorkspaceStore(new ManagedSchemaJdbcTemplate(source), new DataSourceTransactionManager(source));
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
}
