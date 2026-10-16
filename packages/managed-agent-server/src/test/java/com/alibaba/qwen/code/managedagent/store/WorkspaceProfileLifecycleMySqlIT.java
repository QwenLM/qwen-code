package com.alibaba.qwen.code.managedagent.store;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.util.UUID;

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
        f.jdbc.update("UPDATE ma_operation SET claim_until = 946684800000 WHERE operation_kind IN ('CLOSE', 'ARCHIVE', 'DELETE')");
        var start = new java.util.concurrent.CountDownLatch(1);
        try (var executor = java.util.concurrent.Executors.newFixedThreadPool(2)) {
            var futures = java.util.stream.IntStream.range(0, 2).mapToObj(index -> executor.submit(() -> {
                start.await();
                return f.transactions.execute(ignored -> f.store.claimOperation("tenant", f.session,
                        first.operationId(), "takeover-" + index, java.time.Duration.ofSeconds(30)));
            })).toList();
            start.countDown();
            var claims = new java.util.ArrayList<StoreModels.OperationRecord>();
            for (var future : futures) {
                future.get(10, java.util.concurrent.TimeUnit.SECONDS).ifPresent(claims::add);
            }
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

    @org.junit.jupiter.api.Test
    void expiredWriterRenewalAndColdAcquireCannotBothOwnTheHead() throws Exception {
        var f = fixture();
        var journal = new ManagedSessionStore(f.jdbc);
        var writer = f.transactions.execute(ignored -> journal.acquireWriter("tenant", f.session, "w".repeat(32),
                new ManagedSessionStoreModels.AcquireWriterRequest("workspace", "resident", 60_000L)));
        var operation = admit(f, WorkspaceToolProfiles.SHELL, StoreModels.OperationKind.DELETE);
        f.transactions.executeWithoutResult(ignored -> f.lifecycle.recoverEffects(operation));
        f.jdbc.update("UPDATE ma_session_head SET writer_lease_until = ?",
                java.sql.Timestamp.from(java.time.Instant.parse("2000-01-01T00:00:00Z")));
        var start = new java.util.concurrent.CountDownLatch(1);
        try (var executor = java.util.concurrent.Executors.newFixedThreadPool(2)) {
            var futures = java.util.stream.IntStream.range(0, 2).mapToObj(index -> executor.submit(() -> {
                start.await();
                try {
                    return f.transactions.execute(ignored -> index == 0
                            ? journal.renewWriter("tenant", f.session, "w".repeat(32),
                                    new ManagedSessionStoreModels.RenewWriterRequest("workspace", "resident", writer.writerGeneration(), 60_000L),
                                    WorkspaceLifecycleStore.authority(operation))
                            : journal.acquireWriter("tenant", f.session, "r".repeat(32),
                                    new ManagedSessionStoreModels.AcquireWriterRequest("workspace", "recovery", 60_000L),
                                    WorkspaceLifecycleStore.authority(operation)));
                } catch (com.alibaba.qwen.code.managedagent.api.ApiException conflict) {
                    org.assertj.core.api.Assertions.assertThat(conflict.getCode()).isEqualTo("managed_session_writer_conflict");
                    return null;
                }
            })).toList();
            start.countDown();
            var winners = new java.util.ArrayList<ManagedSessionStoreModels.WriterGrant>();
            for (var future : futures) {
                var grant = future.get(10, java.util.concurrent.TimeUnit.SECONDS);
                if (grant != null) {
                    winners.add(grant);
                }
            }
            org.assertj.core.api.Assertions.assertThat(winners).hasSize(1);
            org.assertj.core.api.Assertions.assertThat(f.jdbc.queryForObject("SELECT writer_generation FROM ma_session_head", Long.class))
                    .isEqualTo(winners.getFirst().writerGeneration());
            org.assertj.core.api.Assertions.assertThat(journal.hasLiveWriter("tenant", f.session)).isTrue();
        }
    }

    @Override
    WorkspaceLifecycleStoreTest.Fixture fixture() {
        return new WorkspaceLifecycleStoreTest.Fixture(source);
    }
}
