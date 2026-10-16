package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationTarget;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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
        jdbc.update("UPDATE ma_operation SET claim_until = ? WHERE operation_id = ?", new java.sql.Timestamp(0), operationId);
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
        assertThat(jdbc.queryForObject("SELECT available_at FROM ma_operation WHERE operation_id = ?",
                Long.class, operationId)).isBetween(before + retryDelay, after + retryDelay);
        OperationRecord waiting = operation(store, sessionId, operationId);
        assertThat(waiting.deliveryState()).isEqualTo("PENDING");
        assertThat(waiting.attemptCount()).isEqualTo(1);
        assertThat(targets(store)).isEmpty();
        assertThat(store.claimOperation(TENANT, sessionId, operationId,
                "worker", Duration.ofSeconds(30))).isEmpty();

        now.addAndGet(retryDelay);
        assertThat(targets(store)).isEmpty();
        jdbc.update("UPDATE ma_operation SET available_at = 0 WHERE operation_id = ?", operationId);
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

    @Test
    void unrelatedOperationKindsCannotBeScannedOrClaimed() {
        ManagedAgentStore store = store();
        String sessionId = store.insertSessionCommand(TENANT, "CREATE_SESSION", "create", "digest", "qwen-code",
                null, null, List.of(), null).sessionId();
        String scope = ManagedSessionStore.sessionScopeKey(TENANT, sessionId);
        String target = ManagedSchemaKeys.key(sessionId);
        jdbc.update("INSERT INTO ma_operation (operation_key, scope_key, operation_id, operation_kind, tenant_id, session_id,"
                        + " target_kind, target_key, request_digest, request_json, state, phase, delivery_state, claim_until,"
                        + " gmt_create, gmt_modified) VALUES (?, ?, 'background', 'WORKSPACE_RECOVERY', ?, ?, 'SESSION', ?,"
                        + " 'digest', '{}', 'RUNNING', 'CAPTURING', 'LEASED', ?, 0, 0)",
                ManagedSchemaKeys.key("background"), scope, TENANT, sessionId, target, new java.sql.Timestamp(0));
        assertThat(targets(store)).isEmpty();
        assertThat(store.findOperation(TENANT, sessionId, "background")).isEmpty();
        assertThat(store.claimOperation(TENANT, sessionId, "background", "worker", Duration.ofMinutes(1))).isEmpty();
        assertThat(store.beginOperation(TENANT, sessionId, OperationKind.CLOSE, "", "close", "digest").replayed()).isFalse();
    }

    @Test
    void unknownOutcomeBlocksAdmissionAndAutomaticReplay() {
        ManagedAgentStore store = store();
        String sessionId = store.insertSessionCommand(TENANT, "CREATE_SESSION", "create", "digest", "qwen-code",
                null, null, List.of(), null).sessionId();
        var operation = store.beginOperation(TENANT, sessionId, OperationKind.CLOSE, "", "close", "digest").operation();
        var claim = store.claimOperation(TENANT, sessionId, operation.operationId(), "worker", Duration.ofMinutes(1)).orElseThrow();
        jdbc.update("UPDATE ma_operation SET state = 'UNKNOWN', phase = 'UNKNOWN', claim_until = ? WHERE operation_id = ?",
                new java.sql.Timestamp(0), operation.operationId());
        assertThat(targets(store)).isEmpty();
        assertThat(store.claimOperation(TENANT, sessionId, operation.operationId(), "replacement", Duration.ofMinutes(1))).isEmpty();
        store.retryOperation(TENANT, sessionId, operation.operationId(), "worker", claim.claimGeneration(), 0);
        assertThat(operation(store, sessionId, operation.operationId()).state()).isEqualTo("UNKNOWN");
        assertThat(store.beginOperation(TENANT, sessionId, OperationKind.CLOSE, "", "close", "digest").replayed()).isTrue();
        assertThatThrownBy(() -> store.beginOperation(TENANT, sessionId, OperationKind.DELETE, "", "delete", "digest"))
                .isInstanceOf(ApiException.class);
    }

    private ManagedAgentStore store() {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:operation-store-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        ManagedSchema.initialize(dataSource);
        jdbc = new ManagedSchemaJdbcTemplate(dataSource);
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
        }, ignored -> {}, new ManagedWorkspaceRegistry(jdbc), new ManagedAgentProperties());
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
