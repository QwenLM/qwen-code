package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels.AcquireWriterRequest;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

class WorkspaceLifecycleMySqlIT extends WorkspaceLifecycleStoreTest {
    private DriverManagerDataSource source;
    private JdbcTemplate admin;
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
        schema = "l3_" + UUID.randomUUID().toString().replace("-", "");
        admin.execute("CREATE DATABASE " + schema);
        source = new DriverManagerDataSource(url.replaceFirst("/[^/?]+(?=\\?|$)", "/" + schema), user, password);
    }

    @AfterEach
    void removeSchema() {
        if (admin != null && schema != null) {
            admin.execute("DROP DATABASE IF EXISTS " + schema);
        }
    }

    @Override
    Fixture fixture() {
        return new Fixture(source);
    }

    @Test
    void admissionSerializesAnOrdinaryWriterOnThePlacementFence() throws Exception {
        var fixture = fixture();
        var journal = new ManagedSessionStore(fixture.jdbc);
        try (var pool = Executors.newSingleThreadExecutor()) {
            var entered = new CountDownLatch(1);
            var queued = new java.util.concurrent.atomic.AtomicReference<java.util.concurrent.Future<Throwable>>();
            fixture.transactions.execute(ignored -> {
                WorkspaceLifecycleStore.lockPlacement(fixture.jdbc, "tenant");
                queued.set(pool.submit(() -> {
                    entered.countDown();
                    try {
                        fixture.transactions.execute(transaction -> journal.acquireWriter("tenant", fixture.session,
                                "w".repeat(32), new AcquireWriterRequest("workspace", "late-writer", 60_000L)));
                        return null;
                    } catch (RuntimeException error) {
                        return error;
                    }
                }));
                try {
                    assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
                    assertThrows(TimeoutException.class, () -> queued.get().get(100, TimeUnit.MILLISECONDS));
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(error);
                }
                return fixture.admit(OperationKind.DELETE);
            });
            assertThat(queued.get().get(5, TimeUnit.SECONDS)).isInstanceOf(ApiException.class);
        }
        assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_journal_head", Integer.class)).isZero();
    }

    @Test
    void aFailureAfterRetirementRollsBackTheEntireDeleteAndRetryReusesEffects() {
        var fixture = fixture();
        var operation = fixture.admit(OperationKind.DELETE);
        var effects = fixture.transactions.execute(ignored -> fixture.lifecycle.recoverEffects(operation));
        fixture.jdbc.execute("CREATE TRIGGER l3_delete_failure BEFORE UPDATE ON managed_agent_session FOR EACH ROW"
                + " BEGIN IF NEW.status = 'DELETED' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'l3 injected crash'; END IF; END");
        assertThatThrownBy(() -> fixture.transactions.execute(ignored -> fixture.store.completeOperation("tenant", fixture.session,
                operation.operationId(), "worker", operation.claimGeneration(), true))).hasMessageContaining("l3 injected crash");
        assertThat(fixture.store.requireSession("tenant", fixture.session).status()).isEqualTo("DELETING");
        assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM qwen_output_session_retirement", Integer.class)).isZero();
        assertThat(fixture.store.findOperation("tenant", fixture.session, operation.operationId()).orElseThrow().receiptId()).isNull();
        fixture.jdbc.execute("DROP TRIGGER l3_delete_failure");
        assertThat(fixture.transactions.<com.fasterxml.jackson.databind.JsonNode>execute(ignored -> fixture.lifecycle.recoverEffects(operation)))
                .isEqualTo(effects);
        assertThat(fixture.transactions.<Boolean>execute(ignored -> fixture.store.completeOperation("tenant", fixture.session,
                operation.operationId(), "worker", operation.claimGeneration(), true))).isTrue();
        assertThat(fixture.jdbc.queryForObject("SELECT COUNT(*) FROM qwen_output_session_retirement", Integer.class)).isOne();
    }
}
