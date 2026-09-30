package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationTarget;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * Delivery states of an operation on a store that no worker scans, with a
 * clock the test moves.
 */
class ManagedSessionOperationStoreTest {
    private static final String TENANT = "operation-store";
    private final AtomicLong now = new AtomicLong(1_000);

    @Test
    void onlyTheNewestClaimCompletesOrRetries() {
        ManagedAgentStore store = store();
        String sessionId = store.insertSessionCommand(TENANT,
                "CREATE_SESSION", "create", "digest", "qwen-code", null, null,
                List.of(), null).sessionId();
        String operationId = store.beginOperation(TENANT, sessionId,
                OperationKind.CLOSE, "", "close", "digest").operation()
                .operationId();
        assertThat(targets(store)).containsExactly(operationId);

        OperationRecord first = store.claimOperation(TENANT, sessionId,
                operationId, "worker", Duration.ofMillis(100)).orElseThrow();
        assertThat(first.state()).isEqualTo("RUNNING");
        assertThat(first.deliveryState()).isEqualTo("LEASED");
        assertThat(store.claimOperation(TENANT, sessionId, operationId,
                "other", Duration.ofMillis(100))).isEmpty();
        assertThat(targets(store)).isEmpty();

        // The same worker claims again after its lease expired, so only the
        // newer claim may finish.
        now.addAndGet(200);
        assertThat(targets(store)).containsExactly(operationId);
        OperationRecord second = store.claimOperation(TENANT, sessionId,
                operationId, "worker", Duration.ofMillis(100)).orElseThrow();
        assertThat(second.claimGeneration())
                .isEqualTo(first.claimGeneration() + 1);
        assertThat(store.completeOperation(TENANT, sessionId, operationId,
                "worker", first.claimGeneration(), true)).isFalse();
        store.retryOperation(TENANT, sessionId, operationId, "worker",
                first.claimGeneration(), 0);
        assertThat(operation(store, sessionId, operationId)).isEqualTo(second);

        store.retryOperation(TENANT, sessionId, operationId, "worker",
                second.claimGeneration(), now.get() + 500);
        OperationRecord waiting = operation(store, sessionId, operationId);
        assertThat(waiting.deliveryState()).isEqualTo("PENDING");
        assertThat(waiting.attemptCount()).isEqualTo(1);
        assertThat(targets(store)).isEmpty();
        assertThat(store.claimOperation(TENANT, sessionId, operationId,
                "worker", Duration.ofMillis(100))).isEmpty();

        now.addAndGet(500);
        OperationRecord third = store.claimOperation(TENANT, sessionId,
                operationId, "worker", Duration.ofMillis(100)).orElseThrow();
        assertThat(store.completeOperation(TENANT, sessionId, operationId,
                "worker", third.claimGeneration(), false)).isTrue();
        OperationRecord completed = operation(store, sessionId, operationId);
        assertThat(completed.state()).isEqualTo("COMPLETED");
        assertThat(completed.deliveryState()).isEqualTo("CONFIRMED");
        assertThat(completed.admissionStage()).isEqualTo("JAVA_DURABLE");
        assertThat(completed.leaseOwner()).isNull();
        assertThat(store.requireSession(TENANT, sessionId).status())
                .isEqualTo("CLOSED");
        assertThat(targets(store)).isEmpty();
    }

    // Lifecycle requests carry only their Session and kind, which the domain
    // already fixes, so only the store can present a different digest.
    @Test
    void aKeyReusedWithAnotherDigestConflicts() {
        ManagedAgentStore store = store();
        String sessionId = store.insertSessionCommand(TENANT,
                "CREATE_SESSION", "create", "digest", "qwen-code", null, null,
                List.of(), null).sessionId();
        store.beginOperation(TENANT, sessionId, OperationKind.CLOSE, "",
                "close", "digest-a");
        assertThatThrownBy(() -> store.beginOperation(TENANT, sessionId,
                OperationKind.CLOSE, "", "close", "digest-b"))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode())
                                .isEqualTo("idempotency_conflict"));
    }

    private ManagedAgentStore store() {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:operation-store-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        JdbcTemplate jdbc = new JdbcTemplate(dataSource);
        return new ManagedAgentStore(jdbc, new ObjectMapper(), new Clock() {
            @Override
            public ZoneId getZone() {
                return ZoneOffset.UTC;
            }

            @Override
            public Clock withZone(ZoneId zone) {
                return this;
            }

            @Override
            public Instant instant() {
                return Instant.ofEpochMilli(now.get());
            }
        }, ignored -> {
        }, new ManagedWorkspaceRegistry(jdbc), new ManagedAgentProperties());
    }

    private List<String> targets(ManagedAgentStore store) {
        return store.findDeliverableOperations(now.get(), 10).stream()
                .map(OperationTarget::operationId).toList();
    }

    private static OperationRecord operation(ManagedAgentStore store,
            String sessionId, String operationId) {
        return store.findOperation(TENANT, sessionId, operationId)
                .orElseThrow();
    }
}
