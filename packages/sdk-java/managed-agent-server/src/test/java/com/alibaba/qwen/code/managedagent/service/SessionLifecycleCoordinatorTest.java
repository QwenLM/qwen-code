package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.harness.UnavailableHarnessConnector;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Executors;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

class SessionLifecycleCoordinatorTest {
    @Test
    void unsupportedTakeoverKeepsAcceptedCloseBlockedWithAStableFailure() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:close-takeover-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        Flyway.configure().dataSource(source).locations("classpath:db/migration").load().migrate();
        var jdbc = new JdbcTemplate(source);
        var properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        var store = new ManagedAgentStore(jdbc, new ObjectMapper(), Clock.systemUTC(), ignored -> {},
                new ManagedWorkspaceRegistry(jdbc), properties);
        jdbc.update("INSERT INTO managed_workspace_registry (tenant_id, workspace_id, workspace_generation, storage_id,"
                + " display_name, config_ref, policy_ref, state) VALUES ('tenant', 'workspace', 1, 'storage', 'Workspace', ?, ?, 'ACTIVE')",
                WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, can_read, can_create)"
                + " VALUES ('tenant', 'workspace', ?, TRUE, TRUE)", "owner".getBytes(StandardCharsets.UTF_8));
        var transactions = new TransactionTemplate(new DataSourceTransactionManager(source));
        String session = transactions.execute(ignored -> store.insertWorkspaceSessionCommand("tenant", "owner", "create", "digest", "qwen-code",
                null, null, List.of(), null, new WorkspaceSelection("workspace", ".")).sessionId());
        String operation = transactions.execute(ignored -> store.beginWorkspaceClose("tenant", session, "owner", "a".repeat(64),
                "close", "digest", true).operation().operationId());
        RuntimeWarmer unsupported = new RuntimeWarmer() {
            public boolean isEnabled() { return false; }
            public CompletionStage<Void> warm(String id) { return CompletableFuture.completedFuture(null); }
            public CompletionStage<Void> drain(String id) { throw new AssertionError("Accepted bound close must keep its original scope"); }
        };
        try (var executor = Executors.newSingleThreadExecutor()) {
            var coordinator = new SessionLifecycleCoordinator(store, new ManagedSessionStore(jdbc),
                    new UnavailableHarnessConnector(), unsupported, executor, Clock.systemUTC(), properties);
            try {
                coordinator.dispatch("tenant", session, operation);
                await().atMost(Duration.ofSeconds(3)).untilAsserted(() ->
                        assertThat(store.findOperation("tenant", session, operation).orElseThrow().state())
                                .isEqualTo("RECOVERY_BLOCKED"));
                assertThat(store.findOperation("tenant", session, operation).orElseThrow().failureCode())
                        .isEqualTo("workspace_close_identity_unverified");
                assertThat(store.requireSession("tenant", session).status()).isEqualTo("CLOSING");
            } finally {
                coordinator.stopRenewals();
            }
        }
    }
}
