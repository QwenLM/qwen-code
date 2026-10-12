package com.alibaba.qwen.code.managedagent.store;

import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.AfterEach;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

class WorkspaceProfileLifecycleMySqlIT extends WorkspaceProfileLifecycleTest {
    private JdbcTemplate admin;
    private DriverManagerDataSource source;
    private String schema;

    @BeforeEach
    void openSchema() {
        String url = System.getProperty("mysql.url");
        if (url == null || !url.matches("jdbc:mysql://[^/]+/[^?]+(?:\\?.*)?")) {
            throw new IllegalArgumentException("A MySQL test database URL is required");
        }
        String user = System.getProperty("mysql.user", "root");
        String password = System.getProperty("mysql.password", "");
        admin = new JdbcTemplate(new DriverManagerDataSource(url, user, password));
        schema = "l4_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE " + schema);
        source = new DriverManagerDataSource(url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema), user, password);
    }

    @AfterEach
    void removeSchema() {
        if (admin != null && schema != null) {
            admin.execute("DROP DATABASE IF EXISTS " + schema);
        }
    }

    @org.junit.jupiter.api.Test
    void twoServersRaceForDrainingClaimAndOnlyOneCanRecover() throws Exception {
        var f = fixture();
        var first = admit(f, WorkspaceToolProfiles.SHELL, StoreModels.OperationKind.CLOSE);
        f.transactions.executeWithoutResult(ignored -> f.lifecycle.recoverEffects(first));
        f.jdbc.update("UPDATE managed_agent_operation SET lease_until = 0");
        var start = new java.util.concurrent.CountDownLatch(1);
        try (var executor = java.util.concurrent.Executors.newFixedThreadPool(2)) {
            var futures = java.util.stream.IntStream.range(0, 2).mapToObj(index -> executor.submit(() -> {
                start.await();
                return f.transactions.execute(ignored -> f.store.claimOperation("tenant", f.session,
                        first.operationId(), "takeover-" + index, java.time.Duration.ofSeconds(30)));
            })).toList();
            start.countDown();
            var claims = new java.util.ArrayList<StoreModels.OperationRecord>();
            for (var future : futures) future.get(10, java.util.concurrent.TimeUnit.SECONDS).ifPresent(claims::add);
            org.assertj.core.api.Assertions.assertThat(claims).hasSize(1);
            var winner = claims.getFirst();
            org.assertj.core.api.Assertions.assertThat(winner.claimGeneration()).isGreaterThan(first.claimGeneration());
            org.assertj.core.api.Assertions.assertThat(f.bindings.requireHarnessRecovery(f.scope(), f.session,
                    WorkspaceLifecycleStore.authority(winner))).isTrue();
            org.assertj.core.api.Assertions.assertThatThrownBy(() -> f.bindings.requireHarnessRecovery(f.scope(), f.session,
                    WorkspaceLifecycleStore.authority(first))).hasMessageContaining("closed");
            f.transactions.executeWithoutResult(ignored -> f.lifecycle.verifyResources(winner));
        }
    }

    @Override
    WorkspaceLifecycleStoreTest.Fixture fixture() {
        return new WorkspaceLifecycleStoreTest.Fixture(source);
    }
}
