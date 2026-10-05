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
 * deliberately skewed application clock. Claim deadlines use database time.
 */
class ManagedSessionOperationStoreTest {
    private static final String TENANT = "operation-store";
    private final AtomicLong now = new AtomicLong(1_000);
    private JdbcTemplate jdbc;

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
                operationId, "worker", Duration.ofSeconds(30)).orElseThrow();
        assertThat(first.state()).isEqualTo("RUNNING");
        assertThat(first.deliveryState()).isEqualTo("LEASED");
        assertThat(store.claimOperation(TENANT, sessionId, operationId,
                "other", Duration.ofSeconds(30))).isEmpty();
        assertThat(targets(store)).isEmpty();

        // The same worker claims again after its lease expired, so only the
        // newer claim may finish.
        now.addAndGet(200);
        assertThat(targets(store)).isEmpty();
        jdbc.update("UPDATE managed_agent_operation SET lease_until = 0 WHERE operation_id = ?", operationId);
        assertThat(targets(store)).containsExactly(operationId);
        OperationRecord second = store.claimOperation(TENANT, sessionId,
                operationId, "worker", Duration.ofSeconds(30)).orElseThrow();
        assertThat(second.claimGeneration())
                .isEqualTo(first.claimGeneration() + 1);
        assertThat(store.completeOperation(TENANT, sessionId, operationId,
                "worker", first.claimGeneration(), true)).isFalse();
        store.retryOperation(TENANT, sessionId, operationId, "worker",
                first.claimGeneration(), 0);
        assertThat(operation(store, sessionId, operationId)).isEqualTo(second);

        long retryDelay = Duration.ofDays(1).toMillis();
        long before = databaseTime();
        store.retryOperation(TENANT, sessionId, operationId, "worker",
                second.claimGeneration(), now.get() + retryDelay);
        long after = databaseTime();
        assertThat(jdbc.queryForObject("SELECT available_at FROM managed_agent_operation WHERE operation_id = ?",
                Long.class, operationId)).isBetween(before + retryDelay, after + retryDelay);
        OperationRecord waiting = operation(store, sessionId, operationId);
        assertThat(waiting.deliveryState()).isEqualTo("PENDING");
        assertThat(waiting.attemptCount()).isEqualTo(1);
        assertThat(targets(store)).isEmpty();
        assertThat(store.claimOperation(TENANT, sessionId, operationId,
                "worker", Duration.ofSeconds(30))).isEmpty();

        now.addAndGet(retryDelay);
        assertThat(targets(store)).isEmpty();
        jdbc.update("UPDATE managed_agent_operation SET available_at = 0 WHERE operation_id = ?", operationId);
        OperationRecord third = store.claimOperation(TENANT, sessionId,
                operationId, "worker", Duration.ofSeconds(30)).orElseThrow();
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

    // The budget-exhausted terminal write: the operation row fails closed
    // with its cause kept, the Session keeps its pending status, and no
    // scanner ever re-drives the row.
    @Test
    void aFailedTerminationKeepsTheSessionPendingAndStopsRedriving() {
        ManagedAgentStore store = store();
        String sessionId = store.insertSessionCommand(TENANT,
                "CREATE_SESSION", "create", "digest", "qwen-code", null, null,
                List.of(), null).sessionId();
        String operationId = store.beginOperation(TENANT, sessionId,
                OperationKind.CLOSE, "", "close", "digest").operation()
                .operationId();
        OperationRecord claimed = store.claimOperation(TENANT, sessionId,
                operationId, "worker", Duration.ofSeconds(30)).orElseThrow();

        // Fencing: another owner, a mismatched generation, or an expired
        // lease cannot terminate the operation.
        assertThat(store.failOperation(TENANT, sessionId, operationId,
                "other", claimed.claimGeneration(), "some_code")).isFalse();
        assertThat(store.failOperation(TENANT, sessionId, operationId,
                "worker", claimed.claimGeneration() + 1, "some_code"))
                .isFalse();
        jdbc.update("UPDATE managed_agent_operation SET lease_until = 0"
                + " WHERE operation_id = ?", operationId);
        assertThat(store.failOperation(TENANT, sessionId, operationId,
                "worker", claimed.claimGeneration(), "some_code")).isFalse();
        jdbc.update("UPDATE managed_agent_operation SET lease_until = ?"
                + " WHERE operation_id = ?", databaseTime() + 60_000,
                operationId);

        assertThat(store.failOperation(TENANT, sessionId, operationId,
                "worker", claimed.claimGeneration(),
                "session_lifecycle_delivery_failed")).isTrue();
        OperationRecord failed = operation(store, sessionId, operationId);
        assertThat(failed.state()).isEqualTo("FAILED");
        assertThat(failed.deliveryState()).isEqualTo("CONFIRMED");
        assertThat(failed.admissionStage()).isEqualTo("JAVA_DURABLE");
        assertThat(failed.failureCode())
                .isEqualTo("session_lifecycle_delivery_failed");
        // The contract requires a receipt on every confirmed row; it
        // certifies nothing here.
        assertThat(failed.receiptId()).startsWith("rcpt_");
        assertThat(failed.leaseOwner()).isNull();
        assertThat(store.requireSession(TENANT, sessionId).status())
                .isEqualTo("CLOSING");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " managed_agent_event WHERE tenant_id = ? AND"
                        + " session_id = ? AND event_type = 'session.closed'",
                Integer.class, TENANT, sessionId)).isZero();
        assertThat(targets(store)).isEmpty();
        assertThat(store.claimOperation(TENANT, sessionId, operationId,
                "worker", Duration.ofSeconds(30))).isEmpty();
    }

    // The budget-exempt reschedule keeps the delay-growing attempt count
    // but records the wait so the terminal budget only counts attempts that
    // could have made progress; the plain retry and block paths leave the
    // baseline alone. A blocked CLOSE stays re-drivable.
    @Test
    void budgetExemptWaitsDoNotConsumeTheTerminalBudget() {
        ManagedAgentStore store = store();
        String sessionId = store.insertSessionCommand(TENANT,
                "CREATE_SESSION", "create", "digest", "qwen-code", null, null,
                List.of(), null).sessionId();
        String operationId = store.beginOperation(TENANT, sessionId,
                OperationKind.CLOSE, "", "close", "digest").operation()
                .operationId();

        OperationRecord first = store.claimOperation(TENANT, sessionId,
                operationId, "worker", Duration.ofSeconds(30)).orElseThrow();
        store.retryOperation(TENANT, sessionId, operationId, "worker",
                first.claimGeneration(), 0);
        OperationRecord retried = operation(store, sessionId, operationId);
        assertThat(retried.attemptCount()).isEqualTo(1);
        assertThat(retried.budgetExemptAttempt()).isZero();

        OperationRecord second = store.claimOperation(TENANT, sessionId,
                operationId, "worker", Duration.ofSeconds(30)).orElseThrow();
        store.retryOperation(TENANT, sessionId, operationId, "worker",
                second.claimGeneration(), 0, true);
        OperationRecord waited = operation(store, sessionId, operationId);
        assertThat(waited.attemptCount()).isEqualTo(2);
        assertThat(waited.budgetExemptAttempt()).isEqualTo(2);

        OperationRecord third = store.claimOperation(TENANT, sessionId,
                operationId, "worker", Duration.ofSeconds(30)).orElseThrow();
        store.blockLifecycleOperation(TENANT, sessionId, operationId,
                "worker", third.claimGeneration(), "session_close_writer_live",
                0, true);
        OperationRecord blocked = operation(store, sessionId, operationId);
        assertThat(blocked.state()).isEqualTo("RECOVERY_BLOCKED");
        assertThat(blocked.deliveryState()).isEqualTo("BLOCKED");
        assertThat(blocked.failureCode())
                .isEqualTo("session_close_writer_live");
        assertThat(blocked.attemptCount()).isEqualTo(3);
        assertThat(blocked.budgetExemptAttempt()).isEqualTo(3);
        // The blocked CLOSE is re-driven, so the wait stays unbounded.
        assertThat(targets(store)).containsExactly(operationId);

        OperationRecord fourth = store.claimOperation(TENANT, sessionId,
                operationId, "worker", Duration.ofSeconds(30)).orElseThrow();
        assertThat(fourth.budgetExemptAttempt()).isEqualTo(3);
        store.blockLifecycleOperation(TENANT, sessionId, operationId,
                "worker", fourth.claimGeneration(),
                "workspace_close_identity_unverified", 0);
        OperationRecord brokerBlocked = operation(store, sessionId,
                operationId);
        assertThat(brokerBlocked.attemptCount()).isEqualTo(4);
        assertThat(brokerBlocked.budgetExemptAttempt()).isEqualTo(3);
        assertThat(brokerBlocked.failureCode())
                .isEqualTo("workspace_close_identity_unverified");
    }

    @Test
    void blockedActiveDeletionRemainsUnavailable() {
        ManagedAgentStore store = store();
        String sessionId = store.insertSessionCommand(TENANT, "CREATE_SESSION", "create", "digest",
                "qwen-code", null, null, List.of(), null).sessionId();
        var admitted = store.beginOperation(TENANT, sessionId, OperationKind.DELETE, "", "delete", "digest");
        var claim = store.claimOperation(TENANT, sessionId, admitted.operation().operationId(),
                "worker", Duration.ofMinutes(1)).orElseThrow();
        store.blockLifecycleOperation(TENANT, sessionId, claim.operationId(), "worker", claim.claimGeneration(),
                "workspace_close_identity_unverified", now.get());
        assertThat(targets(store)).isEmpty();
        assertThat(store.claimOperation(TENANT, sessionId, claim.operationId(), "replacement", Duration.ofMinutes(1))).isEmpty();
        assertThat(operation(store, sessionId, claim.operationId()).state()).isEqualTo("RECOVERY_BLOCKED");
    }

    private long databaseTime() {
        return jdbc.queryForObject("SELECT UNIX_TIMESTAMP(), EXTRACT(MICROSECOND FROM CURRENT_TIMESTAMP(6))",
                (row, index) -> row.getLong(1) * 1000 + row.getLong(2) / 1000);
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
        jdbc = new JdbcTemplate(dataSource);
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
