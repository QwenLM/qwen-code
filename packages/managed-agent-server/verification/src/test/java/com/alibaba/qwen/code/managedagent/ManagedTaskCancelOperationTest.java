package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.persistence.ManagedExtensionProjection;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionCreationCommand;
import com.alibaba.qwen.code.managedagent.contracts.session.SessionLifecycleStore.TaskCancelOutcome;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.AcceptanceVerdict;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationAdmission;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationTarget;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ParkedOperation;
import com.alibaba.qwen.code.managedagent.persistence.JdbcChildResultRelayStore;
import com.alibaba.qwen.code.managedagent.persistence.JdbcManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

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

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * H4f: the task_cancel operation on real SQL — admission in the contract's
 * order (#12847 A6), replay and conflict under the retained key, the one
 * open operation per Session, a parked cancel that holds no lifecycle
 * hostage, and settlement guarded by the claim or by the parking.
 */
class ManagedTaskCancelOperationTest {
    private static final String TENANT = "cancel-tenant";
    private static final String ACTOR_DIGEST = "digest-of-actor";
    private String runningChild;
    private String settledChild;
    private String automation;
    private String workflow;
    private String shell;
    private String monitor;
    private String delivery;
    private final AtomicLong now = new AtomicLong(1_000_000);
    private ManagedAgentStore store;
    private JdbcTemplate jdbc;
    private String sessionId;

    @BeforeEach
    void setUp() {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:task-cancel-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        ManagedSchema.initialize(dataSource);
        jdbc = new ManagedSchemaJdbcTemplate(dataSource);
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
        store = com.alibaba.qwen.code.managedagent.VerificationFixtures.managedAgentStore(jdbc, new ObjectMapper(), clock,
                ignored -> {}, new JdbcManagedWorkspaceRegistry(jdbc), properties, new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules());
        sessionId = store.insertSessionCommand(TENANT, "CREATE_SESSION", "create", "digest", "qwen-code",
                null, null, List.of(), null).sessionId();
        runningChild = task("child_run", "child_agent", "running", "a".repeat(64));
        settledChild = task("child_run", "child_agent", "completed", "b".repeat(64));
        automation = task("automation_run", "automation_run", "running", "c".repeat(64));
    }

    @Test
    void admitsReplaysAndConflictsByDigest() {
        OperationAdmission first = begin("key-1", "digest-1", runningChild);
        assertThat(first.replayed()).isFalse();
        OperationRecord operation = first.operation();
        assertThat(operation.kind()).isEqualTo(OperationKind.TASK_CANCEL);
        assertThat(operation.taskId()).isEqualTo(runningChild);
        assertThat(operation.state()).isEqualTo("PENDING");
        assertThat(operation.admissionStage()).isEqualTo("JAVA_DURABLE");
        assertThat(operation.deliveryState()).isEqualTo("PENDING");
        assertThat(operation.receiptId()).isNull();

        OperationAdmission replay = begin("key-1", "digest-1",
                runningChild);
        assertThat(replay.replayed()).isTrue();
        assertThat(replay.operation().operationId())
                .isEqualTo(operation.operationId());
        refused(() -> begin("key-1", "digest-2", runningChild),
                HttpStatus.CONFLICT, "idempotency_conflict");
        // Another actor's key is another request: it meets the open
        // operation instead of the first actor's record.
        refused(() -> store.beginTaskCancelOperation(TENANT, sessionId,
                runningChild, "another-actor", "key-1", "digest-1"),
                HttpStatus.CONFLICT, "session_operation_active");
    }

    @Test
    void aRetainedKeyReplaysThroughStateChangesThatRefuseNewRequests() {
        OperationRecord admitted = begin("key-1", "digest-1", runningChild)
                .operation();
        settle(admitted, TaskCancelOutcome.completed());
        jdbc.update("UPDATE ma_session_record SET"
                + " task_state = 'cancelled'");
        jdbc.update("UPDATE ma_session SET status = 'CLOSING'");
        OperationAdmission replay = begin("key-1", "digest-1",
                runningChild);
        assertThat(replay.replayed()).isTrue();
        assertThat(replay.operation().state()).isEqualTo("COMPLETED");
        refused(() -> begin("key-2", "digest-2", runningChild),
                HttpStatus.CONFLICT, "session_not_active");
        jdbc.update("UPDATE ma_session SET status = 'DELETED'");
        refused(() -> begin("key-2", "digest-2", runningChild),
                HttpStatus.NOT_FOUND, "session_not_found");
    }

    @Test
    void aNewRequestNeedsTheTasksCancelAction() {
        refused(() -> begin("key-2", "digest-2", settledChild),
                HttpStatus.CONFLICT, "task_action_unavailable");
        refused(() -> begin("key-3", "digest-3", "task_" + "d".repeat(64)),
                HttpStatus.NOT_FOUND, "task_not_found");
        for (String state : new String[] {"pending", "waiting", "degraded"}) {
            taskState("child_run", "a".repeat(64), state);
            OperationRecord admitted = begin("key-" + state, "digest-" + state,
                    runningChild).operation();
            settle(admitted, TaskCancelOutcome.completed());
        }
        taskState("child_run", "a".repeat(64), "recovery_blocked");
        refused(() -> begin("key-4", "digest-4", runningChild),
                HttpStatus.CONFLICT, "task_action_unavailable");
    }

    @Test
    void anAutomationRunAdmitsCancelAndReplaysAfterSettlement() {
        OperationRecord admitted = begin("auto-key", "auto-digest", automation)
                .operation();
        assertThat(admitted.kind()).isEqualTo(OperationKind.TASK_CANCEL);
        assertThat(admitted.taskId()).isEqualTo(automation);
        refused(() -> begin("auto-key", "other-digest", automation),
                HttpStatus.CONFLICT, "idempotency_conflict");
        settle(admitted, TaskCancelOutcome.completed());
        taskState("automation_run", "c".repeat(64), "cancelled");
        assertThat(begin("auto-key", "auto-digest", automation).operation()
                .operationId()).isEqualTo(admitted.operationId());
        refused(() -> begin("auto-next", "auto-digest", automation),
                HttpStatus.CONFLICT, "task_action_unavailable");
    }

    // H4f-b: a workflow child_run takes the same admission rule as a child
    // agent's — the cancellable states admit, terminal and
    // recovery_blocked states refuse, and the retained key replays.
    @Test
    void aWorkflowTaskAdmitsCancelUnderTheSameRule() {
        workflow = task("child_run", "workflow", "running", "e".repeat(64));
        OperationAdmission first = begin("wf-key-1", "wf-digest-1",
                workflow);
        assertThat(first.replayed()).isFalse();
        assertThat(first.operation().kind()).isEqualTo(
                OperationKind.TASK_CANCEL);
        assertThat(first.operation().taskId()).isEqualTo(workflow);
        assertThat(begin("wf-key-1", "wf-digest-1", workflow).replayed())
                .isTrue();
        refused(() -> begin("wf-key-1", "wf-digest-2", workflow),
                HttpStatus.CONFLICT, "idempotency_conflict");
        settle(first.operation(), TaskCancelOutcome.completed());
        for (String state : new String[] {"pending", "waiting",
                "degraded"}) {
            taskState("child_run", "e".repeat(64), state);
            settle(begin("wf-key-" + state, "wf-digest-" + state, workflow)
                    .operation(), TaskCancelOutcome.completed());
        }
        for (String state : new String[] {"completed", "failed",
                "cancelled", "recovery_blocked"}) {
            taskState("child_run", "e".repeat(64), state);
            refused(() -> begin("wf-key-" + state, "wf-digest-" + state,
                    workflow), HttpStatus.CONFLICT,
                    "task_action_unavailable");
        }
    }

    // H4f-c: a background Shell and a Monitor take the same admission
    // rule — the cancellable states admit, terminal and recovery_blocked
    // states refuse, and the retained key replays.
    @Test
    void theH3TasksAdmitCancelUnderTheSameRule() {
        shell = task("child_run", "background_shell", "running", "f".repeat(64));
        monitor = task("monitor_run", "monitor", "running", "9".repeat(64));
        for (String[] descriptor : new String[][] {
                {shell, "child_run", "f".repeat(64)},
                {monitor, "monitor_run", "9".repeat(64)}}) {
            String taskId = descriptor[0];
            OperationAdmission first = begin(taskId + "-1", "digest-1",
                    taskId);
            assertThat(first.replayed()).isFalse();
            assertThat(first.operation().taskId()).isEqualTo(taskId);
            assertThat(begin(taskId + "-1", "digest-1", taskId).replayed())
                    .isTrue();
            settle(first.operation(), TaskCancelOutcome.completed());
            for (String state : new String[] {"pending", "waiting",
                    "degraded"}) {
                taskState(descriptor[1], descriptor[2], state);
                settle(begin(taskId + state, "digest-" + state, taskId)
                        .operation(), TaskCancelOutcome.completed());
            }
            for (String state : new String[] {"completed", "failed",
                    "cancelled", "recovery_blocked"}) {
                taskState(descriptor[1], descriptor[2], state);
                refused(() -> begin(taskId + state, "digest-" + state,
                        taskId), HttpStatus.CONFLICT,
                        "task_action_unavailable");
            }
        }
    }

    // #13746 F3: a channel delivery admits a cancel only while pending —
    // planned, with no adapter claim — and the retained key replays.
    @Test
    void aDeliveryTaskAdmitsCancelOnlyWhilePending() {
        delivery = task("channel_delivery", "channel_delivery", "pending", "8".repeat(64));
        OperationAdmission first = begin("delivery-1", "digest-1", delivery);
        assertThat(first.replayed()).isFalse();
        assertThat(first.operation().taskId()).isEqualTo(delivery);
        settle(first.operation(), TaskCancelOutcome.completed());
        for (String state : new String[] {"running", "waiting", "degraded",
                "completed", "failed", "cancelled", "recovery_blocked"}) {
            taskState("channel_delivery", "8".repeat(64), state);
            refused(() -> begin("delivery-" + state, "digest-" + state,
                    delivery), HttpStatus.CONFLICT,
                    "task_action_unavailable");
        }
        assertThat(begin("delivery-1", "digest-1", delivery).replayed())
                .isTrue();
    }

    // A bound Session under storage migration admits no new cancel, as
    // its sibling bound admissions refuse; a retained key still replays.
    @Test
    void theMigrationFenceRefusesANewCancelButNotItsReplay() {
        jdbc.update("INSERT INTO ma_workspace (tenant_id,"
                + " workspace_id, workspace_generation, storage_id,"
                + " display_name, config_ref, policy_ref, state) VALUES (?,"
                + " 'ws', 1, 'storage-1', 'ws', 'config', 'policy',"
                + " 'ACTIVE')", TENANT);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id,"
                + " workspace_id, actor_id, role) VALUES (?, 'ws', ?,"
                + " 'OPERATOR')", TENANT,
                "actor".getBytes(java.nio.charset.StandardCharsets.UTF_8));
        String bound = new TransactionTemplate(
                new DataSourceTransactionManager(jdbc.getDataSource()))
                .execute(status -> store.insertWorkspaceSessionCommand(SessionCreationCommand.builder()
                        .tenantId(TENANT)
                        .actorId("actor")
                        .idempotencyKey("create-bound")
                        .requestDigest("create-digest")
                        .agentId("qwen-code")
                        .selection(new WorkspaceSelection("ws", "services"))
                        .build())
                        .sessionId());
        String previous = sessionId;
        sessionId = bound;
        runningChild = task("child_run", "child_agent", "running", "a".repeat(64));
        OperationRecord admitted = begin("key-1", "digest-1", runningChild)
                .operation();
        settle(admitted, TaskCancelOutcome.completed());
        jdbc.update("INSERT INTO ma_storage (tenant_id, storage_id, fence_operation_id) VALUES (?,"
                + " 'storage-1', ?)",
                TENANT, UUID.randomUUID().toString());
        assertThat(begin("key-1", "digest-1", runningChild).replayed())
                .isTrue();
        assertThatThrownBy(() -> begin("key-2", "digest-2", runningChild))
                .isInstanceOfSatisfying(RuntimeBrokerException.class,
                        error -> assertThat(error.getCode())
                                .isEqualTo("workspace_unavailable"));
        sessionId = previous;
    }

    @Test
    void oneOpenOperationPerSessionBothWays() {
        begin("key-1", "digest-1", runningChild);
        refused(() -> begin("key-2", "digest-2", runningChild),
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
                            "digest-" + key, runningChild));
                    outcomes.add("admitted");
                } catch (ManagedAgentException error) {
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
        OperationRecord admitted = begin("key-1", "digest-1", runningChild)
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
        assertThat(store.findParkedOperations(10)).isEmpty();
        jdbc.update("UPDATE ma_operation SET available_at = 0");
        ParkedOperation due = new ParkedOperation(TENANT, sessionId,
                admitted.operationId(), "TASK_CANCEL");
        assertThat(store.findParkedOperations(10)).containsExactly(due);
        // Due for reconciliation is still not claimable (D7-2): its
        // acceptance is unknown, so no claim may send it again, however
        // early it parked.
        assertThat(store.claimOperation(TENANT, sessionId,
                admitted.operationId(), "owner-2", Duration.ofSeconds(30)))
                .isEmpty();
        assertThat(read(admitted).state()).isEqualTo("RECOVERY_BLOCKED");
        // Not open: a new cancel is admitted, and so is the close.
        OperationRecord second = begin("key-2", "digest-2", runningChild)
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
        // Unknown evidence parks it again for the recheck.
        assertThat(store.settleParkedOperation(due,
                AcceptanceVerdict.unknown(), now.get() + 60_000)).isTrue();
        assertThat(read(admitted).state()).isEqualTo("RECOVERY_BLOCKED");
        assertThat(store.findParkedOperations(10)).isEmpty();
        assertThat(store.settleParkedOperation(due,
                AcceptanceVerdict.committed(), 0)).isTrue();
        OperationRecord reconciled = read(admitted);
        assertThat(reconciled.state()).isEqualTo("COMPLETED");
        assertThat(reconciled.admissionStage())
                .isEqualTo("HARNESS_CONFIRMED");
        assertThat(reconciled.deliveryState()).isEqualTo("CONFIRMED");
        assertThat(reconciled.receiptId()).startsWith("rcpt_");
        assertThat(reconciled.failureCode()).isNull();
        assertThat(store.settleParkedOperation(due,
                AcceptanceVerdict.notCommitted("task_already_settled"), 0))
                .isFalse();
    }

    @Test
    void settlementWritesTheContractsStateFieldsUnderTheClaim() {
        OperationRecord admitted = begin("key-1", "digest-1", runningChild)
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
                + " ma_operation WHERE delivery_state = 'BLOCKED'"
                + " AND available_at <= ?", Integer.class,
                Long.MAX_VALUE - 1)).isZero();
        assertThat(store.claimOperation(TENANT, sessionId,
                admitted.operationId(), "owner-2", Duration.ofSeconds(30)))
                .isEmpty();
        assertThat(store.settleParkedOperation(new ParkedOperation(TENANT,
                sessionId, admitted.operationId(), "TASK_CANCEL"),
                AcceptanceVerdict.committed(), 0)).isFalse();
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
            jdbc.update("INSERT INTO ma_turn (tenant_id,"
                    + " session_id, turn_id, prompt_id, input_json,"
                    + " payload_digest, status, gmt_create, gmt_modified)"
                    + " VALUES (?, ?, ?, ?, '[]', 'digest', ?, 0, 0)", TENANT,
                    sessionId, turn[0], UUID.randomUUID().toString(), turn[1]);
        }
        JdbcChildResultRelayStore relay = new JdbcChildResultRelayStore(jdbc);
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
        jdbc.update("INSERT INTO ma_session_record"
                        + " (tenant_id,"
                        + " workspace_id, session_id, domain, record_id,"
                        + " operation_id, revision, record_resource_id,"
                        + " task_kind, task_state, gmt_create) VALUES (?,"
                        + " 'workspace', ?, 'child_run', 'run-stop', 'op-stop', 2,"
                        + " 'resource-stop', 'child_agent', 'running', 1)", TENANT, sessionId);
        byte[] body = ("{\"kind\":\"child_agent\",\"stopRequested\":true,"
                + "\"run\":{\"state\":\"running\"}}")
                .getBytes(java.nio.charset.StandardCharsets.UTF_8);
        jdbc.update("INSERT INTO ma_resource (tenant_id, workspace_id, session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, publish_command_id, state, gmt_create) VALUES (?, 'workspace', ?, 'resource-stop', 'managed-child-run', 1, ?, ?, 'MYSQL_INLINE', ?, 'command', 'REFERENCED', " + ManagedSchemaTime.SQL_NOW + ")",
                TENANT, sessionId, body.length, "c".repeat(64), body);
        JdbcChildResultRelayStore relay = new JdbcChildResultRelayStore(jdbc);
        assertThat(relay.stopState(TENANT, sessionId, "run-stop"))
                .isEqualTo(new JdbcChildResultRelayStore.StopState(true, false));
        assertThat(relay.stopState(TENANT, sessionId, "run-missing"))
                .isNull();
    }

    private String task(String domain, String kind, String state,
            String recordId) {
        jdbc.update("INSERT INTO ma_session_record"
                        + " (tenant_id,"
                        + " workspace_id, session_id, domain, record_id,"
                        + " operation_id, revision, record_resource_id,"
                        + " task_kind, task_state, gmt_create)"
                        + " VALUES (?, 'workspace', ?, ?, ?, ?, 1, ?,"
                        + " ?, ?, 1)",
                TENANT, sessionId, domain, recordId,
                "op-" + recordId, "resource-" + recordId, kind, state);
        return ManagedExtensionProjection.taskId(
                ManagedExtensionProjection.recordKey(sessionId, domain, recordId));
    }

    private void taskState(String domain, String recordId, String state) {
        jdbc.update("UPDATE ma_session_record SET task_state = ?"
                        + " WHERE tenant_id = ? AND session_id = ? AND domain = ? AND record_id = ?",
                state, TENANT, sessionId, domain, recordId);
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
                ManagedAgentException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(status.value());
                    assertThat(error.getCode()).isEqualTo(code);
                });
    }
}
