package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.session.AgentStateStore;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
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

class ConsolidatedActionStoreTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String ACTION = "tool_approval_01234567890123456789012345678901";
    private ConsolidatedStoreFixture fixture;
    private JdbcTemplate jdbc;
    private ManagedActionStore actions;
    private TransactionTemplate transactions;
    private String scope;

    @BeforeEach
    void initialize() throws Exception {
        fixture = ConsolidatedStoreFixture.open("action");
        var source = fixture.source();
        ManagedSchema.initialize(source);
        jdbc = new JdbcTemplate(source);
        transactions = new TransactionTemplate(new DataSourceTransactionManager(source));
        scope = ManagedSessionStore.sessionScopeKey("tenant", "session");
        jdbc.update("INSERT INTO ma_session (tenant_id,session_id,agent_id,status,approval_mode,gmt_create,gmt_modified)"
                + " VALUES (?,?,?,'ACTIVE','manual',0,0)", "tenant", "session", "agent");
        AgentStateStore state = mock(AgentStateStore.class);
        when(state.findOperation(anyString(), anyString(), anyString())).thenAnswer(call -> jdbc.query(
                "SELECT " + ManagedSchemaProjection.OPERATION.columns() + " FROM ma_operation WHERE tenant_id=? AND session_id=? AND operation_id=? AND operation_kind='ACTION_RESPONSE'",
                (row, n) -> new OperationRecord(row.getString("tenant_id"), row.getString("session_id"), row.getString("operation_id"),
                        OperationKind.ACTION_RESPONSE, row.getString("request_digest"), row.getString("state"), row.getString("admission_stage"),
                        row.getString("delivery_state"), row.getString("session_status_before"), row.getString("receipt_id"),
                        row.getString("claim_owner"), row.getLong("claim_generation"), row.getInt("attempt_count")),
                call.getArgument(0), call.getArgument(1), call.getArgument(2)).stream().findFirst());
        actions = new ManagedActionStore(jdbc, state);
        project("requested", null, 1);
    }

    @AfterEach
    void closeFixture() {
        if (fixture != null) {
            fixture.close();
        }
    }

    @Test
    void actionProjectionOwnsReferencesAndDoesNotEnterDomainQueries() throws Exception {
        assertThat(actions.find("tenant", "session", ACTION).orElseThrow().state()).isEqualTo("requested");
        assertThat(actions.list("tenant", "session", null, null, 10)).hasSize(1);
        assertThat(new ManagedExtensionRecordStore(jdbc).listTasks("tenant", "session", null, null, 10).tasks()).isEmpty();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE owner_kind='SESSION_RECORD'", Long.class)).isEqualTo(1);
        project("decided", response("allow"), 2);
        assertThat(actions.find("tenant", "session", ACTION).orElseThrow().decisionDigest())
                .isEqualTo(ManagedActionStore.decisionDigest(response("allow")));
        assertThat(actions.list("tenant", "session", null, null, 10)).isEmpty();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref WHERE owner_kind='SESSION_RECORD'", Long.class)).isEqualTo(2);
    }

    @Test
    void decisionSlotBlocksOppositeAnswersAndLeaseExpiryCannotAdmitAnotherExecution() {
        var first = admit("key1", "request1", response("allow"));
        assertThat(admit("key1", "request1", response("allow")).operation().operationId()).isEqualTo(first.operation().operationId());
        assertThat(admit("key2", "request2", response("allow")).replayed()).isTrue();
        assertThatThrownBy(() -> admit("key3", "request3", response("deny"))).isInstanceOf(ManagedAgentException.class);
        assertThatThrownBy(() -> admit("key1", "changed", response("allow"))).isInstanceOf(ManagedAgentException.class);
        jdbc.update("UPDATE ma_operation SET claim_owner='worker',claim_generation=2,claim_until=?,state='RUNNING',delivery_state='LEASED'",
                0L);
        assertThatThrownBy(() -> admit("key4", "request4", response("deny"))).isInstanceOf(ManagedAgentException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind='ACTION_RESPONSE'", Long.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_request_receipt WHERE namespace='ACTION_DECISION'", Long.class)).isEqualTo(1);
    }

    @Test
    void staleWorkerCannotSettleReclaimedActionAndUnknownIsNotDeliverable() {
        OperationRecord original = admit("key1", "request1", response("allow")).operation();
        jdbc.update("UPDATE ma_operation SET claim_owner=?,claim_generation=2,claim_until=(" + ManagedSchemaTime.SQL_NOW + " + 100000),state='RUNNING',delivery_state='LEASED'",
                "worker");
        actions.complete(original, "worker", null, "decision", true, 100);
        assertThat(actions.response("tenant", "session", original.operationId()).decisionReceiptId()).isNull();
        OperationRecord current = new OperationRecord("tenant", "session", original.operationId(), OperationKind.ACTION_RESPONSE,
                "request1", "RUNNING", "JAVA_DURABLE", "LEASED", "ACTIVE", null, "worker", 2, 0);
        actions.complete(current, "worker", null, "decision", true, 100);
        assertThat(actions.response("tenant", "session", original.operationId()).decisionReceiptId()).isEqualTo("decision");
        jdbc.update("UPDATE ma_operation SET state='UNKNOWN',delivery_state='LEASED',claim_until=?", 0L);
        assertThat(actions.deliverable(100)).isEmpty();
    }

    @Test
    void creationReceiptDoesNotRestoreMissingPersistedOwnership() {
        jdbc.update("UPDATE ma_session SET workspace_id='workspace',workspace_generation=1,"
                + "workspace_storage_id='storage',cwd_relative='.',context_config_ref='config',"
                + "context_revision=1,workspace_config_ref='config',workspace_policy_ref='policy'");
        byte[] actor = ManagedWorkspaceRegistry.actorKey("tenant", "actor");
        ManagedReceipts.insert(jdbc,
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptNamespace.SESSION_CREATE_ACTOR,
                "tenant", com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptScope.ACTOR,
                ManagedReceipts.actorScope(actor), "create", "create-digest", "CREATE_SESSION", actor,
                "session", null, "COMPLETED", null, true, 0);
        assertThatThrownBy(() -> transactions.execute(status -> actions.admit(
                "tenant", "session", "actor", "actor-digest", "response", "request", ACTION, response("allow"), 10)))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("action_forbidden"));
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation", Long.class)).isZero();
    }

    @Test
    void preservesThePersistedDecisionDigestAndItsFieldOrder() {
        JsonNode response = JSON.createObjectNode()
                .put("policyRevision", "p1").put("inputRevision", 7).put("optionId", "allow");

        assertThat(ManagedActionStore.decisionDigest(response)).isEqualTo(
                "d61ff840d95b8aaa9b24999e2910fc687098d73b225c0837b6ec6718fb038ae5");
    }

    private StoreModels.OperationAdmission admit(String key, String digest, JsonNode response) {
        return transactions.execute(status -> actions.admit("tenant", "session", null, "anonymous", key, digest, ACTION, response, 10));
    }

    private void project(String state, JsonNode answer, long sequence) throws Exception {
        ObjectNode options = JSON.createObjectNode().put("v", 1).put("requestId", ACTION).put("turnId", "turn")
                .put("functionCallId", "call").put("toolName", "write_file").put("policyRevision", "hosted-tool-approval/1")
                .put("inputRevision", 1).put("createdAt", 1).put("expiresAt", 1000);
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
        envelope.putObject("sessionKey").put("tenantId", "tenant").put("workspaceId", "workspace").put("sessionId", "session");
        ObjectNode payload = envelope.putObject("payload").put("requestId", ACTION).put("kind", "permission").put("source", "tool_call")
                .put("inputRevision", 1).put("state", state);
        payload.set("optionsRef", optionsRef);
        if (decision == null) {
            payload.putNull("decisionRef");
        }
        else {
            payload.set("decisionRef", decision);
        }
        ObjectNode record = JSON.createObjectNode().put("subtype", "managed_session_event_v1");
        record.set("managedSession", envelope);
        transactions.executeWithoutResult(status -> actions.apply("tenant", "workspace", "session", sequence, 1,
                record.toString().getBytes(StandardCharsets.UTF_8), id -> jdbc.queryForObject("SELECT " + ManagedSchemaProjection.RESOURCE.columns() + " FROM ma_resource WHERE resource_key=?",
                        (row, n) -> new StoredResource(id, row.getString("kind"), row.getInt("schema_version"), row.getLong("byte_length"),
                                row.getString("sha256"), row.getBytes("inline_bytes")), ManagedSchemaKeys.key(scope, id))));
    }

    private ObjectNode storeBody(String id, String kind, JsonNode body) throws Exception {
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        jdbc.update("INSERT INTO ma_resource (resource_key,session_scope_key,tenant_id,workspace_id,session_id,resource_id,kind,"
                        + "schema_version,byte_length,sha256,storage_kind,inline_bytes,state,gmt_create)"
                        + " VALUES (?,?,?,?,?,?,?,1,?,?,'MYSQL_INLINE',?,'REFERENCED'," + ManagedSchemaTime.SQL_NOW + ") ON DUPLICATE KEY UPDATE resource_key=resource_key",
                ManagedSchemaKeys.key(scope, id), scope, "tenant", "workspace", "session", id, kind, bytes.length, digest, bytes);
        return JSON.createObjectNode().put("resourceId", id).put("kind", kind).put("schemaVersion", 1).put("byteLength", bytes.length).put("digest", digest);
    }

    private ObjectNode response(String option) {
        return JSON.createObjectNode().put("optionId", option).put("inputRevision", 1).put("policyRevision", "hosted-tool-approval/1");
    }
}
