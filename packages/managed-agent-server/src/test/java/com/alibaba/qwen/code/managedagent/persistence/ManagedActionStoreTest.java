package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationAdmission;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.session.AgentStateStore;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Pins the admission stage written when an ACTION_RESPONSE operation
 * completes (a completion the Harness answered is harness_confirmed; one
 * the retry budget terminated without an answer stays java_durable), and
 * the replay re-admission arms of a terminally failed delivery (issue
 * #13182 finding 3): resurrect while the Action still waits, heal when the
 * projection shows this response's own decision committed, and the mutable
 * gates that keep a stale failure replaying.
 */
class ManagedActionStoreTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String TENANT = "tenant";
    private static final String SESSION = "session";
    private static final String ACTION = "tool_approval_" + "a".repeat(32);
    private ConsolidatedStoreFixture fixture;
    private JdbcTemplate jdbc;
    private ManagedActionStore actions;
    private AgentStateStore agents;
    private TransactionTemplate transactions;
    private String scope;

    @BeforeEach
    void initialize() throws Exception {
        fixture = ConsolidatedStoreFixture.open("action-store");
        var source = fixture.source();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        transactions = new TransactionTemplate(
                new DataSourceTransactionManager(source));
        scope = ManagedSessionStore.sessionScopeKey(TENANT, SESSION);
        jdbc.update("INSERT INTO ma_session (tenant_id,session_id,agent_id,status,approval_mode,gmt_create,gmt_modified)"
                + " VALUES (?,?,'agent','ACTIVE','manual',0,0)", TENANT, SESSION);
        agents = mock(AgentStateStore.class);
        when(agents.findOperation(anyString(), anyString(), anyString())).thenAnswer(call -> jdbc.query(
                "SELECT * FROM ma_operation WHERE tenant_id=? AND session_id=? AND operation_id=? AND operation_kind='ACTION_RESPONSE'",
                (row, n) -> new OperationRecord(row.getString("tenant_id"), row.getString("session_id"), row.getString("operation_id"),
                        OperationKind.ACTION_RESPONSE, row.getString("request_digest"), row.getString("state"), row.getString("admission_stage"),
                        row.getString("delivery_state"), row.getString("session_status_before"), row.getString("receipt_id"),
                        row.getString("claim_owner"), row.getLong("claim_generation"), row.getInt("attempt_count"),
                        row.getString("failure_code"), row.getInt("lifecycle_protocol_version")),
                call.getArgument(0), call.getArgument(1), call.getArgument(2)).stream().findFirst());
        when(agents.hasExecutionRegistryFacts(anyString(), anyString())).thenReturn(true);
        actions = new ManagedActionStore(jdbc, agents);
    }

    @AfterEach
    void closeFixture() {
        if (fixture != null) {
            fixture.close();
        }
    }

    @Test
    void anUnansweredCompletionStaysJavaDurable() {
        project("requested", null, 1, 1000);
        var admitted = admit("idem", "digest", response("allow"), 10);
        lease(admitted.operation().operationId());
        OperationRecord op = operation(admitted.operation().operationId());

        actions.complete(op, "owner", "action_response_delivery_failed", null, false, 20);

        // The fixture leases RUNNING/JAVA_DURABLE, so the stage assertion
        // alone cannot tell a write apart from a no-op; only complete()
        // writes FAILED.
        assertThat(stringColumn("state", op.operationId())).isEqualTo("FAILED");
        assertThat(stringColumn("admission_stage", op.operationId())).isEqualTo("JAVA_DURABLE");
    }

    @Test
    void anAnsweredCompletionIsHarnessConfirmed() {
        project("requested", null, 1, 1000);
        var admitted = admit("idem", "digest", response("allow"), 10);
        lease(admitted.operation().operationId());

        actions.complete(operation(admitted.operation().operationId()), "owner", null, "rcpt-1", true, 20);

        assertThat(stringColumn("admission_stage", admitted.operation().operationId()))
                .isEqualTo("HARNESS_CONFIRMED");
    }

    @Test
    void anAnsweredFailureIsStillHarnessConfirmed() {
        project("requested", null, 1, 1000);
        var admitted = admit("idem", "digest", response("allow"), 10);
        lease(admitted.operation().operationId());

        // The 400 arm: the Harness answered with a definitive refusal.
        actions.complete(operation(admitted.operation().operationId()), "owner",
                "invalid_action_response", null, true, 20);

        assertThat(stringColumn("state", admitted.operation().operationId())).isEqualTo("FAILED");
        assertThat(stringColumn("admission_stage", admitted.operation().operationId()))
                .isEqualTo("HARNESS_CONFIRMED");
    }

    // A delivery that failed past its retry budget is not the end of the
    // answer: while the Action still waits, the caller's retried click
    // replays the same key and digest and must re-admit the delivery on the
    // same operation row instead of returning the stale failure receipt
    // forever (issue #13182 finding 3, review).
    @Test
    void aReplayedFailedResponseIsReadmittedWhileTheActionIsStillRequested() {
        project("requested", null, 1, 1000);
        var admitted = admit("idem", "digest", response("allow"), 10);
        String operationId = admitted.operation().operationId();
        // The first delivery of the answer failed past its retry budget,
        // with the budget-exempt watermark left over from answered attempts.
        markFailed(operationId, "action_response_delivery_failed", 10, 7);

        var replayed = admit("idem", "digest", response("allow"), 20);

        assertThat(replayed.replayed()).isTrue();
        assertThat(replayed.operation().operationId()).isEqualTo(operationId);
        assertThat(replayed.operation().state()).isEqualTo("PENDING");
        assertThat(replayed.operation().deliveryState()).isEqualTo("PENDING");
        assertThat(intColumn("attempt_count", operationId)).isZero();
        // The watermark resets with the attempt count: the re-admitted
        // delivery is a fresh answer whose budget must be able to terminate
        // (review round 7, R7-3).
        assertThat(intColumn("budget_exempt_attempt", operationId)).isZero();
        assertThat(stringColumn("receipt_id", operationId)).isNull();
        assertThat(stringColumn("failure_code", operationId)).isNull();
        // The re-admitted row is deliverable again — no recovery path could
        // see the FAILED/CONFIRMED row.
        assertThat(actions.deliverable(Long.MAX_VALUE))
                .anySatisfy(target -> assertThat(target.operationId()).isEqualTo(operationId));
    }

    // A migration fence on the Session's storage holds the resurrection
    // back: a fresh admission would refuse it 409 workspace_unavailable, so
    // the replay keeps returning the recorded terminal failure — and its
    // re-admissibility — until the fence lifts, instead of resurrecting a
    // delivery the migration needs quiesced (review round 7, R7-4).
    @Test
    void aReplayedFailedResponseIsNotReadmittedWhileTheStorageIsFenced() {
        bindWorkspace();
        project("requested", null, 1, 1000);
        var admitted = admitAs("owner", "idem", "digest", response("allow"), 10);
        String operationId = admitted.operation().operationId();
        markFailed(operationId, "action_response_delivery_failed", 10, 0);
        // The resurrection arm's evidence that a new delivery must wait.
        jdbc.update("INSERT INTO ma_storage (alias_key, tenant_key, storage_key,"
                        + " tenant_id, storage_id, fence_operation_id) VALUES (?, ?, ?, ?, ?, ?)",
                com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository.storageAliasKey(TENANT, "storage"),
                com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository.storageFenceKey(TENANT),
                com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository.storageFenceKey("storage"),
                TENANT, "storage", "op-fence");

        var replayed = admitAs("owner", "idem", "digest", response("allow"), 20);

        assertThat(replayed.replayed()).isTrue();
        assertThat(replayed.operation().state()).isEqualTo("FAILED");
        assertThat(replayed.operation().failureCode()).isEqualTo("action_response_delivery_failed");
        assertThat(intColumn("attempt_count", operationId)).isEqualTo(10);
        assertThat(actions.deliverable(Long.MAX_VALUE)).isEmpty();
    }

    // A replay whose Action has expired must not resurrect the delivery
    // either: a fresh admission would refuse it 409 action_expired, and a
    // resurrected PENDING row could never complete — counted as an open
    // operation, it would wedge every later lifecycle command on the
    // Session (review round 3, R3-5).
    @Test
    void aReplayedFailedResponseIsNotReadmittedOnceTheActionExpired() {
        project("requested", null, 1, 1000);
        var admitted = admit("idem", "digest", response("allow"), 10);
        String operationId = admitted.operation().operationId();
        markFailed(operationId, "action_response_delivery_failed", 10, 0);

        var replayed = admit("idem", "digest", response("allow"), 2000);

        assertThat(replayed.replayed()).isTrue();
        assertThat(replayed.operation().state()).isEqualTo("FAILED");
        assertThat(intColumn("attempt_count", operationId)).isEqualTo(10);
        assertThat(actions.deliverable(Long.MAX_VALUE)).isEmpty();
    }

    // The same replay against an Action that already ended must not re-open
    // the delivery: the recorded decision is final.
    @Test
    void aReplayedFailedResponseIsNotReadmittedOnceTheActionEnded() {
        project("requested", null, 1, 1000);
        var admitted = admit("idem", "digest", response("allow"), 10);
        String operationId = admitted.operation().operationId();
        markFailed(operationId, "action_response_delivery_failed", 10, 0);
        // The Action ended with a different decision than this response.
        project("decided", response("deny"), 2, 1000);

        var replayed = admit("idem", "digest", response("allow"), 20);

        assertThat(replayed.replayed()).isTrue();
        assertThat(replayed.operation().state()).isEqualTo("FAILED");
        assertThat(intColumn("attempt_count", operationId)).isEqualTo(10);
        assertThat(actions.deliverable(Long.MAX_VALUE)).isEmpty();
    }

    // The one shape where the delivery actually succeeded and only Java's
    // record is wrong: the projection shows the Action decided with THIS
    // response's own decision digest. The replay settles the row in place —
    // COMPLETED with the decision receipt — instead of returning the stale
    // failure forever; the row is never resurrected to PENDING, so a second
    // vote stays impossible (review round 5, R3-5).
    @Test
    void aReplayedFailedResponseSettlesWhenTheActionDecidedWithThisResponse() {
        project("requested", null, 1, 1000);
        var admitted = admit("idem", "digest", response("allow"), 10);
        String operationId = admitted.operation().operationId();
        markFailed(operationId, "action_response_delivery_failed", 10, 0);
        project("decided", response("allow"), 2, 1000);

        var replayed = admit("idem", "digest", response("allow"), 20);

        assertThat(replayed.replayed()).isTrue();
        assertThat(replayed.operation().state()).isEqualTo("COMPLETED");
        assertThat(replayed.operation().admissionStage()).isEqualTo("HARNESS_CONFIRMED");
        assertThat(stringColumn("failure_code", operationId)).isNull();
        assertThat(stringColumn("receipt_id", operationId)).isNotNull().isNotEqualTo("rcpt-1");
        assertThat(stringColumn("decision_receipt_id", operationId))
                .isEqualTo(actions.find(TENANT, SESSION, ACTION).orElseThrow().decisionReceiptId());
        // The settled row stays out of the outbox: it is terminal, not
        // re-deliverable.
        assertThat(actions.deliverable(Long.MAX_VALUE)).isEmpty();
    }

    // The decision-expired terminal is the same durable lie the digest heal
    // already corrects for a delivery failure: the Harness committed the
    // decision before the Action's deadline ran out and only Java's record
    // is wrong, so the replay settles the row in place with the decision
    // receipt. The replay is past the deadline, which also pins that the
    // heal — never the resurrection — is what fires for this code
    // (review R2-4).
    @Test
    void aReplayedDecisionExpiredResponseSettlesWhenTheActionDecidedWithThisResponse() {
        project("requested", null, 1, 1000);
        var admitted = admit("idem", "digest", response("allow"), 10);
        String operationId = admitted.operation().operationId();
        markFailed(operationId, "action_response_decision_expired", 10, 0);
        project("decided", response("allow"), 2, 1000);

        var replayed = admit("idem", "digest", response("allow"), 2000);

        assertThat(replayed.replayed()).isTrue();
        assertThat(replayed.operation().state()).isEqualTo("COMPLETED");
        assertThat(replayed.operation().admissionStage()).isEqualTo("HARNESS_CONFIRMED");
        assertThat(stringColumn("failure_code", operationId)).isNull();
        assertThat(stringColumn("receipt_id", operationId)).isNotNull().isNotEqualTo("rcpt-1");
        assertThat(actions.deliverable(Long.MAX_VALUE)).isEmpty();
    }

    // The re-admission gate keeps the Session check: on a Session that no
    // longer accepts responses the replay returns the recorded failure
    // instead of re-admitting deliveries that can never land.
    @Test
    void aReplayedFailedResponseIsNotReadmittedOnAnInactiveSession() {
        project("requested", null, 1, 1000);
        var admitted = admit("idem", "digest", response("allow"), 10);
        String operationId = admitted.operation().operationId();
        markFailed(operationId, "action_response_delivery_failed", 10, 0);
        jdbc.update("UPDATE ma_session SET status = 'CLOSING'"
                + " WHERE tenant_id = ? AND session_id = ?", TENANT, SESSION);

        var replayed = admit("idem", "digest", response("allow"), 20);

        assertThat(replayed.replayed()).isTrue();
        assertThat(replayed.operation().state()).isEqualTo("FAILED");
        assertThat(intColumn("attempt_count", operationId)).isEqualTo(10);
        assertThat(actions.deliverable(Long.MAX_VALUE)).isEmpty();
    }

    // A FAILED the Harness itself produced is terminal for good: re-sending
    // the identical body would only repeat the refusal, so the replay keeps
    // returning the recorded row even while the Action is still requested.
    @Test
    void aDefinitiveHarnessRefusalIsNotReadmitted() {
        project("requested", null, 1, 1000);
        var admitted = admit("idem", "digest", response("allow"), 10);
        String operationId = admitted.operation().operationId();
        markFailed(operationId, "invalid_action_response", 1, 0);

        var replayed = admit("idem", "digest", response("allow"), 20);

        assertThat(replayed.replayed()).isTrue();
        assertThat(replayed.operation().state()).isEqualTo("FAILED");
        assertThat(replayed.operation().failureCode()).isEqualTo("invalid_action_response");
        assertThat(stringColumn("receipt_id", operationId)).isEqualTo("rcpt-1");
        assertThat(actions.deliverable(Long.MAX_VALUE)).isEmpty();
    }

    // Both mutating replay arms re-check the mutable actor gate: a caller
    // admitted only by the Workspace role loses the resurrect the moment
    // the role is revoked, instead of re-arming a delivery it may no longer
    // make — while the read-only replay of the recorded failure stays open
    // to it (review round 10, R10-1).
    @Test
    void aReplayedFailedResponseIsNotReadmittedOnceTheOperatorRoleWasRevoked() {
        bindWorkspace();
        grantRole("operator", "OPERATOR");
        project("requested", null, 1, 1000);
        var admitted = admitAs("operator", "idem", "digest", response("allow"), 10);
        String operationId = admitted.operation().operationId();
        markFailed(operationId, "action_response_delivery_failed", 10, 0);

        // The role arm admits the resurrect while the role stands.
        var readmitted = admitAs("operator", "idem", "digest", response("allow"), 20);
        assertThat(readmitted.replayed()).isTrue();
        assertThat(readmitted.operation().state()).isEqualTo("PENDING");

        markFailed(operationId, "action_response_delivery_failed", 10, 0);
        jdbc.update("DELETE FROM ma_workspace_access WHERE tenant_id = ?"
                + " AND workspace_id = ?", TENANT, "workspace");

        assertThatThrownBy(() -> admitAs("operator", "idem", "digest", response("allow"), 30))
                .isInstanceOf(ManagedAgentException.class)
                .satisfies(error -> {
                    var refusal = (ManagedAgentException) error;
                    assertThat(refusal.getStatus()).isEqualTo(HttpStatus.FORBIDDEN);
                    assertThat(refusal.getCode()).isEqualTo("action_forbidden");
                });
        assertThat(stringColumn("state", operationId)).isEqualTo("FAILED");
        assertThat(stringColumn("receipt_id", operationId)).isEqualTo("rcpt-1");
    }

    // The resurrect arm re-arms a delivery, so it must certify delivery
    // exactly like a fresh admission: a bound Session whose creator-keyed
    // execution facts lapsed (the creator lost its Workspace grant) gets
    // the fresh path's 409 instead of a PENDING row the arbiter can never
    // reach, and the recorded failure keeps its re-admissibility for when
    // the facts are restored (review round 12, R12-2).
    @Test
    void aReplayedFailedResponseIsNotReadmittedOnceTheExecutionFactsLapsed() {
        bindWorkspace();
        project("requested", null, 1, 1000);
        var admitted = admitAs("owner", "idem", "digest", response("allow"), 10);
        String operationId = admitted.operation().operationId();
        markFailed(operationId, "action_response_delivery_failed", 10, 0);

        // The owner arm admits the resurrect while the facts stand.
        var readmitted = admitAs("owner", "idem", "digest", response("allow"), 20);
        assertThat(readmitted.replayed()).isTrue();
        assertThat(readmitted.operation().state()).isEqualTo("PENDING");

        markFailed(operationId, "action_response_delivery_failed", 10, 0);
        when(agents.hasExecutionRegistryFacts(anyString(), anyString())).thenReturn(false);

        assertThatThrownBy(() -> admitAs("owner", "idem", "digest", response("allow"), 30))
                .isInstanceOf(ManagedAgentException.class)
                .satisfies(error -> {
                    var refusal = (ManagedAgentException) error;
                    assertThat(refusal.getStatus()).isEqualTo(HttpStatus.CONFLICT);
                    assertThat(refusal.getCode()).isEqualTo("workspace_unavailable");
                });
        assertThat(stringColumn("state", operationId)).isEqualTo("FAILED");
        assertThat(stringColumn("receipt_id", operationId)).isEqualTo("rcpt-1");
    }

    // The digest-match heal settles the row too, so it answers the revoked
    // role the same way.
    @Test
    void aReplayedDecisionExpiredResponseIsNotSettledOnceTheOperatorRoleWasRevoked() {
        bindWorkspace();
        grantRole("operator", "OPERATOR");
        project("requested", null, 1, 1000);
        var admitted = admitAs("operator", "idem", "digest", response("allow"), 10);
        String operationId = admitted.operation().operationId();
        markFailed(operationId, "action_response_decision_expired", 10, 0);
        project("decided", response("allow"), 2, 1000);

        // The role arm admits the heal while the role stands.
        var settled = admitAs("operator", "idem", "digest", response("allow"), 2000);
        assertThat(settled.operation().state()).isEqualTo("COMPLETED");

        markFailed(operationId, "action_response_decision_expired", 10, 0);
        jdbc.update("UPDATE ma_operation SET decision_receipt_id = NULL"
                + " WHERE tenant_id = ? AND session_id = ? AND operation_id = ?",
                TENANT, SESSION, operationId);
        jdbc.update("DELETE FROM ma_workspace_access WHERE tenant_id = ?"
                + " AND workspace_id = ?", TENANT, "workspace");

        assertThatThrownBy(() -> admitAs("operator", "idem", "digest", response("allow"), 3000))
                .isInstanceOf(ManagedAgentException.class)
                .satisfies(error -> {
                    var refusal = (ManagedAgentException) error;
                    assertThat(refusal.getStatus()).isEqualTo(HttpStatus.FORBIDDEN);
                    assertThat(refusal.getCode()).isEqualTo("action_forbidden");
                });
        assertThat(stringColumn("state", operationId)).isEqualTo("FAILED");
        assertThat(stringColumn("decision_receipt_id", operationId)).isNull();
    }

    private OperationAdmission admit(String key, String digest, JsonNode body, long now) {
        return admitAs(null, key, digest, body, now);
    }

    private OperationAdmission admitAs(String actor, String key, String digest, JsonNode body, long now) {
        return transactions.execute(status -> actions.admit(TENANT, SESSION, actor,
                actor == null ? "anonymous" : actor + "-digest", key, digest, ACTION, body, now));
    }

    // The terminally failed first delivery: budget spent, receipt written,
    // out of every recovery scan.
    private void markFailed(String operationId, String failureCode, int attempts, int exempt) {
        jdbc.update("UPDATE ma_operation SET state = 'FAILED', phase = 'FAILED',"
                        + " delivery_state = 'CONFIRMED', admission_stage = 'JAVA_DURABLE',"
                        + " session_status_before = 'ACTIVE', receipt_id = 'rcpt-1',"
                        + " attempt_count = ?, budget_exempt_attempt = ?, available_at = 0,"
                        + " completed_at = 0, failure_code = ? WHERE tenant_id = ?"
                        + " AND session_id = ? AND operation_id = ?",
                attempts, exempt, failureCode, TENANT, SESSION, operationId);
    }

    private void lease(String operationId) {
        jdbc.update("UPDATE ma_operation SET claim_owner = 'owner', claim_generation = 2,"
                        + " claim_until = (" + ManagedSchemaTime.SQL_NOW + " + 100000),"
                        + " state = 'RUNNING', delivery_state = 'LEASED' WHERE tenant_id = ?"
                        + " AND session_id = ? AND operation_id = ?",
                TENANT, SESSION, operationId);
    }

    private OperationRecord operation(String operationId) {
        return agents.findOperation(TENANT, SESSION, operationId).orElseThrow();
    }

    // A bound Session: the Workspace row, the binding columns the contract
    // requires, and the recorded owner the identity arm matches.
    private void bindWorkspace() {
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id,"
                        + " workspace_generation, storage_id, display_name, config_ref,"
                        + " policy_ref, state) VALUES (?, 'workspace', 1, 'storage',"
                        + " 'Workspace', 'config', 'policy', 'ACTIVE')", TENANT);
        jdbc.update("UPDATE ma_session SET workspace_id = 'workspace',"
                        + " workspace_generation = 1, workspace_storage_id = 'storage',"
                        + " cwd_relative = '.', context_config_ref = 'config',"
                        + " context_revision = 1, workspace_config_ref = 'config',"
                        + " workspace_policy_ref = 'policy', owner_actor_key = ?"
                        + " WHERE tenant_id = ? AND session_id = ?",
                ManagedWorkspaceRegistry.actorKey(TENANT, "owner"), TENANT, SESSION);
    }

    private void grantRole(String actor, String role) {
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id,"
                        + " actor_id, role) VALUES (?, 'workspace', ?, ?)",
                TENANT, ManagedWorkspaceRegistry.actorKey(TENANT, actor), role);
    }

    private String stringColumn(String name, String operationId) {
        return jdbc.queryForObject("SELECT " + name + " FROM ma_operation"
                        + " WHERE tenant_id = ? AND session_id = ? AND operation_id = ?",
                String.class, TENANT, SESSION, operationId);
    }

    private Integer intColumn(String name, String operationId) {
        return jdbc.queryForObject("SELECT " + name + " FROM ma_operation"
                        + " WHERE tenant_id = ? AND session_id = ? AND operation_id = ?",
                Integer.class, TENANT, SESSION, operationId);
    }

    private void project(String state, JsonNode answer, long sequence, long expiresAt) {
        ObjectNode options = JSON.createObjectNode().put("v", 1).put("requestId", ACTION).put("turnId", "turn")
                .put("functionCallId", "call").put("toolName", "write_file").put("policyRevision", "hosted-tool-approval/1")
                .put("inputRevision", 1).put("createdAt", 1).put("expiresAt", expiresAt);
        options.putArray("options").addObject().put("id", "allow").put("label", "Allow");
        options.withArray("options").addObject().put("id", "deny").put("label", "Deny");
        ObjectNode optionsRef = storeBody("options", "managed-action-options", options);
        ObjectNode decision = null;
        if (answer != null) {
            ObjectNode body = JSON.createObjectNode().put("v", 1).put("optionId", answer.path("optionId").asText())
                    .put("inputRevision", 1).put("policyRevision", "hosted-tool-approval/1");
            decision = storeBody("decision", "managed-action-decision", body);
        }
        ObjectNode envelope = JSON.createObjectNode().put("v", 1).put("sequence", sequence).put("eventId", "action:" + sequence)
                .put("kind", "action.changed").put("occurredAt", sequence);
        envelope.putObject("sessionKey").put("tenantId", TENANT).put("workspaceId", "workspace").put("sessionId", SESSION);
        ObjectNode payload = envelope.putObject("payload").put("requestId", ACTION).put("kind", "permission").put("source", "tool_call")
                .put("inputRevision", 1).put("state", state);
        payload.set("optionsRef", optionsRef);
        if (decision == null) {
            payload.putNull("decisionRef");
        } else {
            payload.set("decisionRef", decision);
        }
        ObjectNode record = JSON.createObjectNode().put("subtype", "managed_session_event_v1");
        record.set("managedSession", envelope);
        transactions.executeWithoutResult(status -> actions.apply(TENANT, "workspace", SESSION, sequence, 1,
                record.toString().getBytes(StandardCharsets.UTF_8), id -> jdbc.queryForObject("SELECT * FROM ma_resource WHERE resource_key=?",
                        (row, n) -> new StoredResource(id, row.getString("kind"), row.getInt("schema_version"), row.getLong("byte_length"),
                                row.getString("sha256"), row.getBytes("inline_bytes")), ManagedSchemaKeys.key(scope, id))));
    }

    private ObjectNode storeBody(String id, String kind, JsonNode body) {
        try {
            byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
            String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
            jdbc.update("INSERT INTO ma_resource (resource_key,session_scope_key,tenant_id,workspace_id,session_id,resource_id,kind,"
                            + "schema_version,byte_length,sha256,storage_kind,inline_bytes,state,gmt_create)"
                            + " VALUES (?,?,?,?,?,?,?,1,?,?,'MYSQL_INLINE',?,'REFERENCED'," + ManagedSchemaTime.SQL_NOW + ") ON DUPLICATE KEY UPDATE resource_key=resource_key",
                    ManagedSchemaKeys.key(scope, id), scope, TENANT, "workspace", SESSION, id, kind, bytes.length, digest, bytes);
            return JSON.createObjectNode().put("resourceId", id).put("kind", kind).put("schemaVersion", 1).put("byteLength", bytes.length).put("digest", digest);
        } catch (java.security.NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    private JsonNode response(String option) {
        return JSON.createObjectNode().put("optionId", option).put("inputRevision", 1).put("policyRevision", "hosted-tool-approval/1");
    }
}
