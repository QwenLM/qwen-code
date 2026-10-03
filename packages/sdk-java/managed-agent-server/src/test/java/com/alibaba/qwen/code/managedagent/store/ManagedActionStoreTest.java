package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
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
 * Pins the admission stage written when an ACTION_RESPONSE operation
 * completes: a completion the Harness answered is harness_confirmed; one the
 * retry budget terminated without an answer (issue #13182 finding 3) must
 * stay java_durable.
 */
class ManagedActionStoreTest {
    private static final String TENANT = "action-store";
    private static final String ACTION_ID =
            "tool_approval_" + "a".repeat(32);
    private final AtomicLong now = new AtomicLong(1_000);
    private JdbcTemplate jdbc;

    @Test
    void anUnansweredCompletionStaysJavaDurable() {
        ManagedAgentStore agents = agents();
        ManagedActionStore actions = new ManagedActionStore(jdbc, agents);
        String sessionId = agents.insertSessionCommand(TENANT,
                "CREATE_SESSION", "create", "digest", "qwen-code", null, null,
                List.of(), null).sessionId();
        insertLeasedActionOperation(sessionId);
        OperationRecord op = operation(sessionId);

        actions.complete(op, "owner", "action_response_delivery_failed", null,
                false, now.get());
        // The fixture inserts RUNNING/JAVA_DURABLE, so the stage assertion
        // alone cannot tell a write apart from a no-op; only complete()
        // writes FAILED.
        assertThat(state(sessionId)).isEqualTo("FAILED");
        assertThat(stage(sessionId)).isEqualTo("JAVA_DURABLE");
    }

    @Test
    void anAnsweredCompletionIsHarnessConfirmed() {
        ManagedAgentStore agents = agents();
        ManagedActionStore actions = new ManagedActionStore(jdbc, agents);
        String sessionId = agents.insertSessionCommand(TENANT,
                "CREATE_SESSION", "create", "digest", "qwen-code", null, null,
                List.of(), null).sessionId();
        insertLeasedActionOperation(sessionId);

        actions.complete(operation(sessionId), "owner", null, "rcpt-1", true,
                now.get());
        assertThat(stage(sessionId)).isEqualTo("HARNESS_CONFIRMED");
    }

    @Test
    void anAnsweredFailureIsStillHarnessConfirmed() {
        ManagedAgentStore agents = agents();
        ManagedActionStore actions = new ManagedActionStore(jdbc, agents);
        String sessionId = agents.insertSessionCommand(TENANT,
                "CREATE_SESSION", "create", "digest", "qwen-code", null, null,
                List.of(), null).sessionId();
        insertLeasedActionOperation(sessionId);

        // The 400 arm: the Harness answered with a definitive refusal.
        actions.complete(operation(sessionId), "owner",
                "invalid_action_response", null, true, now.get());
        assertThat(state(sessionId)).isEqualTo("FAILED");
        assertThat(stage(sessionId)).isEqualTo("HARNESS_CONFIRMED");
    }

    // A delivery that failed past its retry budget is not the end of the
    // answer: while the Action still waits, the caller's retried click
    // replays the same key and digest and must re-admit the delivery on the
    // same operation row instead of returning the stale failure receipt
    // forever (issue #13182 finding 3, review).
    @Test
    void aReplayedFailedResponseIsReadmittedWhileTheActionIsStillRequested()
            throws Exception {
        ManagedAgentStore agents = agents();
        ManagedActionStore actions = new ManagedActionStore(jdbc, agents);
        String sessionId = agents.insertSessionCommand(TENANT,
                "CREATE_SESSION", "create", "digest", "qwen-code", null, null,
                List.of(), null).sessionId();
        jdbc.update("INSERT INTO managed_workspace_create_command (tenant_id,"
                        + " actor_id, idempotency_key, request_digest,"
                        + " session_id, created_at) VALUES (?, ?, 'create',"
                        + " 'digest', ?, 0)",
                TENANT, ManagedWorkspaceRegistry.actorKey(TENANT, "owner"),
                sessionId);
        jdbc.update("INSERT INTO managed_agent_action (tenant_id, session_id,"
                        + " action_id, state, options_json, created_at)"
                        + " VALUES (?, ?, ?, 'requested', ?, 0)",
                TENANT, sessionId, ACTION_ID,
                "{\"inputRevision\":1,\"policyRevision\":\"p/1\","
                        + "\"expiresAt\":9999999999999}");
        // The first delivery of the answer failed past its retry budget.
        jdbc.update("INSERT INTO managed_agent_operation (tenant_id,"
                        + " session_id, operation_id, operation_kind,"
                        + " actor_digest, idempotency_key, request_digest,"
                        + " state, admission_stage, delivery_state,"
                        + " session_status_before, receipt_id, attempt_count,"
                        + " available_at, created_at, updated_at,"
                        + " completed_at, action_id, response_json,"
                        + " error_code) VALUES (?, ?, 'op-action',"
                        + " 'ACTION_RESPONSE', 'digest', 'idem-key',"
                        + " 'digest', 'FAILED', 'JAVA_DURABLE', 'CONFIRMED',"
                        + " 'ACTIVE', 'rcpt-1', 10, 0, 0, 0, 0, ?, ?,"
                        + " 'action_response_delivery_failed')",
                TENANT, sessionId, ACTION_ID,
                "{\"optionId\":\"allow\",\"inputRevision\":1,"
                        + "\"policyRevision\":\"p/1\"}");

        var admission = actions.admit(TENANT, sessionId, "owner", "digest",
                "idem-key", "digest", ACTION_ID,
                new ObjectMapper().readTree("{\"optionId\":\"allow\","
                        + "\"inputRevision\":1,\"policyRevision\":\"p/1\"}"),
                now.get());

        assertThat(admission.replayed()).isTrue();
        assertThat(admission.operation().operationId()).isEqualTo("op-action");
        assertThat(admission.operation().state()).isEqualTo("PENDING");
        assertThat(admission.operation().deliveryState()).isEqualTo("PENDING");
        assertThat(admission.operation().attemptCount()).isEqualTo(0);
        assertThat(admission.operation().receiptId()).isNull();
        assertThat(admission.operation().failureCode()).isNull();
        // The re-admitted row is deliverable again — no recovery path could
        // see the FAILED/CONFIRMED row.
        assertThat(actions.deliverable(Long.MAX_VALUE))
                .anySatisfy(target -> assertThat(target.operationId())
                        .isEqualTo("op-action"));
    }

    // The same replay against an Action that already ended must not re-open
    // the delivery: the recorded decision is final.
    @Test
    void aReplayedFailedResponseIsNotReadmittedOnceTheActionEnded()
            throws Exception {
        ManagedAgentStore agents = agents();
        ManagedActionStore actions = new ManagedActionStore(jdbc, agents);
        String sessionId = agents.insertSessionCommand(TENANT,
                "CREATE_SESSION", "create", "digest", "qwen-code", null, null,
                List.of(), null).sessionId();
        jdbc.update("INSERT INTO managed_workspace_create_command (tenant_id,"
                        + " actor_id, idempotency_key, request_digest,"
                        + " session_id, created_at) VALUES (?, ?, 'create',"
                        + " 'digest', ?, 0)",
                TENANT, ManagedWorkspaceRegistry.actorKey(TENANT, "owner"),
                sessionId);
        jdbc.update("INSERT INTO managed_agent_action (tenant_id, session_id,"
                        + " action_id, state, options_json, created_at)"
                        + " VALUES (?, ?, ?, 'decided', ?, 0)",
                TENANT, sessionId, ACTION_ID,
                "{\"inputRevision\":1,\"policyRevision\":\"p/1\","
                        + "\"expiresAt\":9999999999999}");
        jdbc.update("INSERT INTO managed_agent_operation (tenant_id,"
                        + " session_id, operation_id, operation_kind,"
                        + " actor_digest, idempotency_key, request_digest,"
                        + " state, admission_stage, delivery_state,"
                        + " session_status_before, receipt_id, attempt_count,"
                        + " available_at, created_at, updated_at,"
                        + " completed_at, action_id, response_json,"
                        + " error_code) VALUES (?, ?, 'op-action',"
                        + " 'ACTION_RESPONSE', 'digest', 'idem-key',"
                        + " 'digest', 'FAILED', 'JAVA_DURABLE', 'CONFIRMED',"
                        + " 'ACTIVE', 'rcpt-1', 10, 0, 0, 0, 0, ?, ?,"
                        + " 'action_response_delivery_failed')",
                TENANT, sessionId, ACTION_ID,
                "{\"optionId\":\"allow\",\"inputRevision\":1,"
                        + "\"policyRevision\":\"p/1\"}");

        var admission = actions.admit(TENANT, sessionId, "owner", "digest",
                "idem-key", "digest", ACTION_ID,
                new ObjectMapper().readTree("{\"optionId\":\"allow\","
                        + "\"inputRevision\":1,\"policyRevision\":\"p/1\"}"),
                now.get());

        assertThat(admission.replayed()).isTrue();
        assertThat(admission.operation().state()).isEqualTo("FAILED");
        assertThat(admission.operation().attemptCount()).isEqualTo(10);
        assertThat(actions.deliverable(Long.MAX_VALUE)).isEmpty();
    }

    private String stage(String sessionId) {
        return jdbc.queryForObject("SELECT admission_stage FROM"
                        + " managed_agent_operation WHERE tenant_id = ? AND"
                        + " session_id = ? AND operation_id = 'op-action'",
                String.class, TENANT, sessionId);
    }

    private String state(String sessionId) {
        return jdbc.queryForObject("SELECT state FROM"
                        + " managed_agent_operation WHERE tenant_id = ? AND"
                        + " session_id = ? AND operation_id = 'op-action'",
                String.class, TENANT, sessionId);
    }

    private void insertLeasedActionOperation(String sessionId) {
        jdbc.update("INSERT INTO managed_agent_operation (tenant_id,"
                        + " session_id, operation_id, operation_kind,"
                        + " actor_digest, idempotency_key, request_digest,"
                        + " state, admission_stage, delivery_state,"
                        + " session_status_before, lease_owner,"
                        + " claim_generation, attempt_count, available_at,"
                        + " created_at, updated_at) VALUES (?, ?,"
                        + " 'op-action', 'ACTION_RESPONSE', 'digest',"
                        + " 'idem-key', 'digest', 'RUNNING', 'JAVA_DURABLE',"
                        + " 'LEASED', 'ACTIVE', 'owner', 1, 0, 0, 0, 0)",
                TENANT, sessionId);
    }

    private static OperationRecord operation(String sessionId) {
        return new OperationRecord(TENANT, sessionId, "op-action",
                OperationKind.ACTION_RESPONSE, "digest", "RUNNING",
                "JAVA_DURABLE", "LEASED", "ACTIVE", null, "owner", 1, 0);
    }

    private ManagedAgentStore agents() {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:action-store-" + UUID.randomUUID()
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
}
