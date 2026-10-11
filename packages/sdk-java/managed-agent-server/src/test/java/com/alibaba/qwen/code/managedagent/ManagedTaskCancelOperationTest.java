package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.AgentStateStore.TaskCancelOutcome;
import com.alibaba.qwen.code.managedagent.store.ChildResultRelayStore;
import com.alibaba.qwen.code.managedagent.store.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationAdmission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationTarget;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * H4f: the task_cancel operation on real SQL — admission in the contract's
 * order (#12847 A6), replay and conflict under the retained key, the one
 * open operation per Session, a parked cancel that holds no lifecycle
 * hostage, and settlement guarded by the claim or by the parking.
 */
class ManagedTaskCancelOperationTest {
    private static final String TENANT = "cancel-tenant";
    private static final String ACTOR_DIGEST = "digest-of-actor";
    private static final String RUNNING_CHILD = "task_" + "a".repeat(64);
    private static final String SETTLED_CHILD = "task_" + "b".repeat(64);
    private static final String MONITOR = "task_" + "c".repeat(64);
    private final AtomicLong now = new AtomicLong(1_000_000);
    private ManagedAgentStore store;
    private JdbcTemplate jdbc;
    private String sessionId;

    @BeforeEach
    void setUp() {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:task-cancel-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        Flyway.configure().dataSource(dataSource)
                .locations("classpath:db/migration").load().migrate();
        jdbc = new JdbcTemplate(dataSource);
        Clock clock = new Clock() {
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
        };
        ManagedAgentProperties properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        store = new ManagedAgentStore(jdbc, new ObjectMapper(), clock,
                ignored -> {
                }, new ManagedWorkspaceRegistry(jdbc), properties);
        sessionId = UUID.randomUUID().toString();
        jdbc.update("INSERT INTO managed_agent_session (tenant_id,"
                + " session_id, agent_id, status, created_at, updated_at)"
                + " VALUES (?, ?, 'qwen-code', 'ACTIVE', 1, 1)", TENANT,
                sessionId);
        task(RUNNING_CHILD, "child_run", "child_agent", "running");
        task(SETTLED_CHILD, "child_run", "child_agent", "completed");
        task(MONITOR, "monitor_run", "monitor", "running");
    }

    @Test
    void admitsReplaysAndConflictsByDigest() {
        OperationAdmission first = begin("key-1", "digest-1", RUNNING_CHILD);
        assertThat(first.replayed()).isFalse();
        OperationRecord operation = first.operation();
        assertThat(operation.kind()).isEqualTo(OperationKind.TASK_CANCEL);
        assertThat(operation.taskId()).isEqualTo(RUNNING_CHILD);
        assertThat(operation.state()).isEqualTo("PENDING");
        assertThat(operation.admissionStage()).isEqualTo("JAVA_DURABLE");
        assertThat(operation.deliveryState()).isEqualTo("PENDING");
        assertThat(operation.receiptId()).isNull();

        OperationAdmission replay = begin("key-1", "digest-1",
                RUNNING_CHILD);
        assertThat(replay.replayed()).isTrue();
        assertThat(replay.operation().operationId())
                .isEqualTo(operation.operationId());
        refused(() -> begin("key-1", "digest-2", RUNNING_CHILD),
                HttpStatus.CONFLICT, "idempotency_conflict");
        // Another actor's key is another request: it meets the open
        // operation instead of the first actor's record.
        refused(() -> store.beginTaskCancelOperation(TENANT, sessionId,
                RUNNING_CHILD, "another-actor", "key-1", "digest-1"),
                HttpStatus.CONFLICT, "session_operation_active");
    }

    @Test
    void aRetainedKeyReplaysThroughStateChangesThatRefuseNewRequests() {
        OperationRecord admitted = begin("key-1", "digest-1", RUNNING_CHILD)
                .operation();
        settle(admitted, TaskCancelOutcome.completed());
        jdbc.update("UPDATE qwen_managed_session_extension_record SET"
                + " task_state = 'cancelled'");
        jdbc.update("UPDATE managed_agent_session SET status = 'CLOSING'");
        OperationAdmission replay = begin("key-1", "digest-1",
                RUNNING_CHILD);
        assertThat(replay.replayed()).isTrue();
        assertThat(replay.operation().state()).isEqualTo("COMPLETED");
        refused(() -> begin("key-2", "digest-2", RUNNING_CHILD),
                HttpStatus.CONFLICT, "session_not_active");
        jdbc.update("UPDATE managed_agent_session SET status = 'DELETED'");
        refused(() -> begin("key-2", "digest-2", RUNNING_CHILD),
                HttpStatus.NOT_FOUND, "session_not_found");
    }

    @Test
    void aNewRequestNeedsTheTasksCancelAction() {
        refused(() -> begin("key-1", "digest-1", MONITOR),
                HttpStatus.CONFLICT, "task_action_unavailable");
        refused(() -> begin("key-2", "digest-2", SETTLED_CHILD),
                HttpStatus.CONFLICT, "task_action_unavailable");
        refused(() -> begin("key-3", "digest-3", "task_" + "d".repeat(64)),
                HttpStatus.NOT_FOUND, "task_not_found");
        for (String state : new String[] {"pending", "waiting", "degraded"}) {
            jdbc.update("UPDATE qwen_managed_session_extension_record SET"
                    + " task_state = ? WHERE record_key = ?", state,
                    "a".repeat(64));
            OperationRecord admitted = begin("key-" + state, "digest-" + state,
                    RUNNING_CHILD).operation();
            settle(admitted, TaskCancelOutcome.completed());
        }
        jdbc.update("UPDATE qwen_managed_session_extension_record SET"
                + " task_state = 'recovery_blocked' WHERE record_key = ?",
                "a".repeat(64));
        refused(() -> begin("key-4", "digest-4", RUNNING_CHILD),
                HttpStatus.CONFLICT, "task_action_unavailable");
    }

    // A bound Session under storage migration admits no new cancel, as
    // its sibling bound admissions refuse; a retained key still replays.
    @Test
    void theMigrationFenceRefusesANewCancelButNotItsReplay() {
        jdbc.update("INSERT INTO managed_workspace_registry (tenant_id,"
                + " workspace_id, workspace_generation, storage_id,"
                + " display_name, config_ref, policy_ref, state) VALUES (?,"
                + " 'ws', 1, 'storage-1', 'ws', 'config', 'policy',"
                + " 'ACTIVE')", TENANT);
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id,"
                + " workspace_id, actor_id, role) VALUES (?, 'ws', ?,"
                + " 'OPERATOR')", TENANT,
                "actor".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        String bound = new TransactionTemplate(
                new DataSourceTransactionManager(jdbc.getDataSource()))
                .execute(status -> store.insertWorkspaceSessionCommand(
                        TENANT, "actor", "create-bound", "create-digest",
                        "qwen-code", null, null, List.of(), null,
                        new WorkspaceSelection("ws", "services"))
                        .sessionId());
        String previous = sessionId;
        sessionId = bound;
        task(RUNNING_CHILD, "child_run", "child_agent", "running");
        OperationRecord admitted = begin("key-1", "digest-1", RUNNING_CHILD)
                .operation();
        settle(admitted, TaskCancelOutcome.completed());
        jdbc.update("INSERT INTO qwen_runtime_storage_fence VALUES (?, ?, ?,"
                + " 'storage-1', ?)",
                JdbcRuntimeBindingRepository.storageFenceKey(TENANT),
                JdbcRuntimeBindingRepository.storageFenceKey("storage-1"),
                TENANT, UUID.randomUUID().toString());
        assertThat(begin("key-1", "digest-1", RUNNING_CHILD).replayed())
                .isTrue();
        assertThatThrownBy(() -> begin("key-2", "digest-2", RUNNING_CHILD))
                .isInstanceOfSatisfying(RuntimeBrokerException.class,
                        error -> assertThat(error.getCode())
                                .isEqualTo("workspace_unavailable"));
        sessionId = previous;
    }

    @Test
    void oneOpenOperationPerSessionBothWays() {
        begin("key-1", "digest-1", RUNNING_CHILD);
        refused(() -> begin("key-2", "digest-2", RUNNING_CHILD),
                HttpStatus.CONFLICT, "session_operation_active");
        // An open cancel blocks close, archive and delete the same way.
        refused(() -> store.beginOperation(TENANT, sessionId,
                OperationKind.CLOSE, ACTOR_DIGEST, "close-1", "close-digest"),
                HttpStatus.CONFLICT, "session_operation_active");
    }

    // Two keys racing on the same task: the Session lock serializes them,
    // so exactly one is admitted and the other meets the open operation.
    @Test
    void competingKeysAdmitExactlyOne() throws Exception {
        TransactionTemplate competition = new TransactionTemplate(
                new DataSourceTransactionManager(jdbc.getDataSource()));
        CyclicBarrier barrier = new CyclicBarrier(2);
        ConcurrentLinkedQueue<String> outcomes = new ConcurrentLinkedQueue<>();
        for (String key : List.of("key-x", "key-y")) {
            Thread thread = new Thread(() -> {
                try {
                    barrier.await(5, TimeUnit.SECONDS);
                    competition.executeWithoutResult(ignored -> begin(key,
                            "digest-" + key, RUNNING_CHILD));
                    outcomes.add("admitted");
                } catch (ApiException error) {
                    outcomes.add(error.getCode());
                } catch (Exception error) {
                    outcomes.add(error.getClass().getSimpleName());
                }
            });
            thread.setDaemon(true);
            thread.start();
        }
        long deadline = System.currentTimeMillis() + 30_000;
        while (outcomes.size() < 2
                && System.currentTimeMillis() < deadline) {
            Thread.sleep(25);
        }
        assertThat(outcomes).containsExactlyInAnyOrder("admitted",
                "session_operation_active");
    }

    @Test
    void aParkedCancelHoldsNoLifecycleHostage() {
        OperationRecord admitted = begin("key-1", "digest-1", RUNNING_CHILD)
                .operation();
        OperationRecord claimed = claim(admitted);
        assertThat(store.settleTaskCancel(TENANT, sessionId,
                claimed.operationId(), "owner", claimed.claimGeneration(),
                TaskCancelOutcome.recoveryBlocked("task_cancel_unconfirmed"),
                now.get() + 60_000)).isTrue();
        OperationRecord parked = read(admitted);
        assertThat(parked.state()).isEqualTo("RECOVERY_BLOCKED");
        assertThat(parked.admissionStage()).isEqualTo("JAVA_DURABLE");
        assertThat(parked.deliveryState()).isEqualTo("BLOCKED");
        assertThat(parked.failureCode()).isEqualTo("task_cancel_unconfirmed");
        // Never claimed again: a parked cancel is only reconciled.
        assertThat(store.claimOperation(TENANT, sessionId,
                admitted.operationId(), "owner-2", Duration.ofSeconds(30)))
                .isEmpty();
        assertThat(store.findDeliverableTaskCancels(10)).isEmpty();
        assertThat(store.findParkedTaskCancels(10)).isEmpty();
        jdbc.update("UPDATE managed_agent_operation SET available_at = 0");
        assertThat(store.findParkedTaskCancels(10))
                .extracting(OperationTarget::operationId)
                .containsExactly(admitted.operationId());
        // Not open: a new cancel is admitted, and so is the close.
        OperationRecord second = begin("key-2", "digest-2", RUNNING_CHILD)
                .operation();
        settle(second, TaskCancelOutcome.completed());
        assertThat(store.beginOperation(TENANT, sessionId,
                OperationKind.CLOSE, ACTOR_DIGEST, "close-1", "close-digest")
                .operation().kind()).isEqualTo(OperationKind.CLOSE);
        // The reconciliation resolves the parked one from evidence; a
        // leased writer cannot touch a parked row and vice versa.
        assertThat(store.settleTaskCancel(TENANT, sessionId,
                admitted.operationId(), "owner", claimed.claimGeneration(),
                TaskCancelOutcome.completed(), 0)).isFalse();
        assertThat(store.settleTaskCancel(TENANT, sessionId,
                admitted.operationId(), null, 0,
                TaskCancelOutcome.completed(), 0)).isTrue();
        OperationRecord reconciled = read(admitted);
        assertThat(reconciled.state()).isEqualTo("COMPLETED");
        assertThat(reconciled.admissionStage())
                .isEqualTo("HARNESS_CONFIRMED");
        assertThat(reconciled.deliveryState()).isEqualTo("CONFIRMED");
        assertThat(reconciled.receiptId()).startsWith("rcpt_");
        assertThat(reconciled.failureCode()).isNull();
        assertThat(store.settleTaskCancel(TENANT, sessionId,
                admitted.operationId(), null, 0,
                TaskCancelOutcome.failed("task_already_settled"), 0))
                .isFalse();
    }

    @Test
    void settlementWritesTheContractsStateFieldsUnderTheClaim() {
        OperationRecord admitted = begin("key-1", "digest-1", RUNNING_CHILD)
                .operation();
        assertThat(store.findDeliverableTaskCancels(10))
                .extracting(OperationTarget::operationId)
                .containsExactly(admitted.operationId());
        // The lifecycle coordinator's scan never sees a task cancel.
        assertThat(store.findDeliverableOperations(now.get(), 10))
                .extracting(OperationTarget::operationId)
                .doesNotContain(admitted.operationId());
        OperationRecord claimed = claim(admitted);
        assertThat(claimed.state()).isEqualTo("RUNNING");
        assertThat(claimed.deliveryState()).isEqualTo("LEASED");
        assertThat(store.settleTaskCancel(TENANT, sessionId,
                claimed.operationId(), "stale-owner",
                claimed.claimGeneration(),
                TaskCancelOutcome.completed(), 0)).isFalse();
        assertThat(store.settleTaskCancel(TENANT, sessionId,
                claimed.operationId(), "owner", claimed.claimGeneration(),
                TaskCancelOutcome.failed("task_already_settled"), 0)).isTrue();
        OperationRecord failed = read(admitted);
        assertThat(failed.state()).isEqualTo("FAILED");
        assertThat(failed.admissionStage()).isEqualTo("JAVA_DURABLE");
        assertThat(failed.deliveryState()).isEqualTo("BLOCKED");
        assertThat(failed.failureCode()).isEqualTo("task_already_settled");
        assertThat(failed.receiptId()).isNull();
        // Terminal for good: the blocked range of the pending index that
        // the per-second scans walk never holds it, however far the clock
        // moves.
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM"
                + " managed_agent_operation WHERE delivery_state = 'BLOCKED'"
                + " AND available_at <= ?", Integer.class,
                Long.MAX_VALUE - 1)).isZero();
        assertThat(store.claimOperation(TENANT, sessionId,
                admitted.operationId(), "owner-2", Duration.ofSeconds(30)))
                .isEmpty();
        assertThat(store.settleTaskCancel(TENANT, sessionId,
                admitted.operationId(), null, 0,
                TaskCancelOutcome.completed(), 0)).isFalse();
    }

    // The relay's evidence on real SQL: only a cancel that took effect on
    // the Turn (it entered CANCELLING) leaves turn.cancel.requested; one
    // admitted on a Turn that had already ended leaves nothing, so a natural
    // end that raced ahead of the stop stays natural. The internal key,
    // with its space, round-trips through the command table.
    @Test
    void onlyAnEffectiveCancelIsTheStopsEvidence() {
        for (String[] turn : new String[][] {{"turn-live", "RUNNING"},
                {"turn-ended", "FAILED"}}) {
            jdbc.update("INSERT INTO managed_agent_turn (tenant_id,"
                    + " session_id, turn_id, prompt_id, input_json,"
                    + " payload_digest, status, created_at, updated_at)"
                    + " VALUES (?, ?, ?, ?, '[]', 'digest', ?, 0, 0)", TENANT,
                    sessionId, turn[0], UUID.randomUUID().toString(), turn[1]);
        }
        ChildResultRelayStore relay = new ChildResultRelayStore(jdbc);
        String liveKey = "child-stop sha256:" + "1".repeat(64);
        String endedKey = "child-stop sha256:" + "2".repeat(64);
        assertThat(store.insertCancelCommand(TENANT, "CANCEL_TURN", liveKey,
                "digest-live", sessionId, "turn-live").commandEffect())
                .isTrue();
        assertThat(store.insertCancelCommand(TENANT, "CANCEL_TURN",
                endedKey, "digest-ended", sessionId, "turn-ended")
                .commandEffect()).isFalse();
        assertThat(relay.turnCancelRequested(TENANT, sessionId, "turn-live"))
                .isTrue();
        assertThat(relay.turnCancelRequested(TENANT, sessionId,
                "turn-ended")).isFalse();
        assertThat(store.findCommand(TENANT, "CANCEL_TURN", liveKey))
                .isPresent();
        assertThat(store.findCommand(TENANT, "CANCEL_TURN", endedKey))
                .isPresent();
    }

    // The stop arm's heartbeat read goes by the record's primary key and
    // reads the committed body's stop request and run line.
    @Test
    void theStopStateReadsTheCommittedBody() {
        String recordKey = ManagedExtensionProjection.recordKey(sessionId,
                "child_run", "run-stop");
        String scope = ManagedSessionStore.sessionScopeKey(TENANT, sessionId);
        jdbc.update("INSERT INTO qwen_managed_session_extension_record"
                        + " (session_scope_key, record_key, tenant_id,"
                        + " workspace_id, session_id, domain, record_id,"
                        + " operation_hash, revision, record_resource_id,"
                        + " task_kind, task_state, created_at) VALUES (?, ?, ?,"
                        + " 'workspace', ?, 'child_run', 'run-stop', ?, 2,"
                        + " 'resource-stop', 'child_agent', 'running', 1)",
                scope, recordKey, TENANT, sessionId, recordKey);
        byte[] body = ("{\"kind\":\"child_agent\",\"stopRequested\":true,"
                + "\"run\":{\"state\":\"running\"}}")
                .getBytes(java.nio.charset.StandardCharsets.UTF_8);
        jdbc.update("INSERT INTO qwen_managed_session_resource"
                        + " (session_scope_key, tenant_id, workspace_id,"
                        + " session_id, resource_id, kind, schema_version,"
                        + " byte_length, sha256, storage_kind, inline_bytes,"
                        + " publish_command_id, state, created_at) VALUES (?,"
                        + " ?, 'workspace', ?, 'resource-stop',"
                        + " 'managed-child-run', 1, ?, ?, 'MYSQL_INLINE', ?,"
                        + " 'command', 'REFERENCED', CURRENT_TIMESTAMP)",
                scope, TENANT, sessionId, body.length, "c".repeat(64), body);
        ChildResultRelayStore relay = new ChildResultRelayStore(jdbc);
        assertThat(relay.stopState(TENANT, sessionId, "run-stop"))
                .isEqualTo(new ChildResultRelayStore.StopState(true, false));
        assertThat(relay.stopState(TENANT, sessionId, "run-missing"))
                .isNull();
    }

    private void task(String taskId, String domain, String kind,
            String state) {
        String recordKey = taskId.substring("task_".length());
        jdbc.update("INSERT INTO qwen_managed_session_extension_record"
                        + " (session_scope_key, record_key, tenant_id,"
                        + " workspace_id, session_id, domain, record_id,"
                        + " operation_hash, revision, record_resource_id,"
                        + " task_kind, task_state, created_at)"
                        + " VALUES (?, ?, ?, 'workspace', ?, ?, ?, ?, 1, ?,"
                        + " ?, ?, 1)",
                ManagedSessionStore.sessionScopeKey(TENANT, sessionId),
                recordKey, TENANT, sessionId, domain, "record-" + recordKey,
                recordKey, "resource-" + recordKey, kind, state);
    }

    private OperationAdmission begin(String key, String digest,
            String taskId) {
        return store.beginTaskCancelOperation(TENANT, sessionId, taskId,
                ACTOR_DIGEST, key, digest);
    }

    private OperationRecord claim(OperationRecord operation) {
        return store.claimOperation(TENANT, sessionId,
                operation.operationId(), "owner", Duration.ofSeconds(30))
                .orElseThrow();
    }

    private void settle(OperationRecord operation, TaskCancelOutcome outcome) {
        OperationRecord claimed = claim(operation);
        assertThat(store.settleTaskCancel(TENANT, sessionId,
                claimed.operationId(), "owner", claimed.claimGeneration(),
                outcome, 0)).isTrue();
    }

    private OperationRecord read(OperationRecord operation) {
        return store.findOperation(TENANT, sessionId,
                operation.operationId()).orElseThrow();
    }

    private static void refused(Runnable call, HttpStatus status,
            String code) {
        assertThatThrownBy(call::run).isInstanceOfSatisfying(
                ApiException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(status);
                    assertThat(error.getCode()).isEqualTo(code);
                });
    }
}
