package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.session.AgentStateStore;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.apache.commons.codec.digest.DigestUtils;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ManagedPrivateMutationIsolationTest {
    private ManagedSchemaJdbcTemplate jdbc;
    private TransactionTemplate transaction;
    private final ObjectMapper json = new ObjectMapper();

    @BeforeEach
    void setUp() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:private-mutation-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        transaction = new TransactionTemplate(new DataSourceTransactionManager(source));
    }

    @ParameterizedTest
    @ValueSource(strings = {"ordinary", "profile", "retained-pin"})
    void failedLifecycleOperationsRespectTheActualPrivateFence(String shape) {
        session(shape);
        String scope = ManagedSessionStore.sessionScopeKey("tenant", "session");
        jdbc.update("INSERT INTO ma_operation (operation_key, scope_key, operation_id, operation_kind,"
                + " tenant_id, session_id, target_kind, target_key, request_digest, request_json,"
                + " state, phase, delivery_state, claim_owner, claim_generation, claim_until,"
                + " gmt_create, gmt_modified) VALUES (?, ?, 'close', 'CLOSE', 'tenant', 'session',"
                + " 'SESSION', ?, 'digest', '{}', 'RUNNING', 'ACTIVE', 'LEASED', 'owner', 1,"
                + " " + ManagedSchemaTime.SQL_NOW + " + 60000, 1, 1)", "a".repeat(64), scope,
                ManagedSchemaKeys.key("session"));
        var before = jdbc.queryForMap("SELECT * FROM ma_operation");
        var owner = jdbc.queryForMap("SELECT * FROM ma_session");
        var store = new ManagedAgentStore(jdbc, json, Clock.systemUTC(), ignored -> {},
                new ManagedWorkspaceRegistry(jdbc), new ManagedAgentProperties());
        if (shape.equals("ordinary")) {
            Boolean changed = transaction.execute(status -> store.failOperation("tenant", "session", "close",
                    "owner", 1, "test_failure"));
            assertThat(changed).isTrue();
            assertThat(jdbc.queryForMap("SELECT state, delivery_state, failure_code FROM ma_operation"))
                    .containsEntry("state", "FAILED").containsEntry("delivery_state", "CONFIRMED")
                    .containsEntry("failure_code", "test_failure");
        } else {
            assertThatThrownBy(() -> transaction.execute(status -> store.failOperation("tenant", "session",
                    "close", "owner", 1, "test_failure"))).isInstanceOfSatisfying(ManagedAgentException.class,
                            error -> assertThat(error.getCode()).isEqualTo("csi_managed_mutation_unavailable"));
            assertThat(jdbc.queryForMap("SELECT * FROM ma_operation")).usingRecursiveComparison().isEqualTo(before);
        }
        assertThat(jdbc.queryForMap("SELECT * FROM ma_session")).usingRecursiveComparison().isEqualTo(owner);
    }

    @ParameterizedTest
    @ValueSource(strings = {"ordinary", "profile", "retained-pin"})
    void modelUsageProjectionLeavesPrivateJournalDataAlone(String shape) throws Exception {
        session(shape);
        byte[] body = "{\"version\":1,\"model\":\"model\",\"attempts\":[]}".getBytes(StandardCharsets.UTF_8);
        String digest = DigestUtils.sha256Hex(body);
        var resource = new StoredResource("usage", "managed-hosted-model-usage", 1, body.length, digest, body);
        String scope = ManagedSessionStore.sessionScopeKey("tenant", "session");
        jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, workspace_id,"
                + " session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind,"
                + " inline_bytes, state, gmt_create) VALUES (?, ?, 'tenant', 'workspace', 'session',"
                + " 'usage', ?, 1, ?, ?, 'MYSQL_INLINE', ?, 'REFERENCED', 1)",
                ManagedSchemaKeys.key(scope, "usage"), scope, resource.kind(), body.length, digest, body);
        var stored = jdbc.queryForMap("SELECT * FROM ma_resource");
        var record = json.createObjectNode().put("subtype", "managed_session_event_v1");
        var event = record.putObject("managedSession").put("v", 1).put("sequence", 1)
                .put("eventId", "attempt:model").put("kind", "model.attempt").put("occurredAt", 1);
        event.putObject("sessionKey").put("tenantId", "tenant").put("workspaceId", "workspace")
                .put("sessionId", "session");
        event.putObject("payload").put("state", "output_committed").put("attemptId", "model")
                .putObject("usageRef").put("resourceId", "usage").put("kind", resource.kind())
                .put("schemaVersion", 1).put("byteLength", body.length).put("digest", digest);
        byte[] bytes = json.writeValueAsBytes(record);
        var before = jdbc.queryForMap("SELECT * FROM ma_session");
        var applied = transaction.execute(status -> new ManagedExtensionRecordStore(jdbc)
                .apply("tenant", "workspace", "session", 1, 1, bytes, id -> {
                    assertThat(id).isEqualTo("usage");
                    return resource;
                }, 1));
        assertThat(applied.records()).containsExactly(record);
        assertThat(resource.bytes()).containsExactly(body);
        assertThat(jdbc.queryForMap("SELECT * FROM ma_resource")).usingRecursiveComparison().isEqualTo(stored);
        int expected = shape.equals("ordinary") ? 1 : 0;
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_record", Integer.class)).isEqualTo(expected);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref", Integer.class)).isEqualTo(expected);
        assertThat(jdbc.queryForMap("SELECT * FROM ma_session")).usingRecursiveComparison().isEqualTo(before);
    }

    private void session(String shape) {
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, workspace_id, workspace_generation,"
                + " workspace_storage_id, cwd_relative, context_config_ref, context_revision, workspace_config_ref,"
                + " workspace_policy_ref, tool_profile, runtime_request_key, gmt_create, gmt_modified)"
                + " VALUES ('tenant', 'session', 'qwen-code', 'workspace', 1, 'storage', '.', 'context', 1,"
                + " 'config', 'policy', ?, ?, 1, 1)",
                shape.equals("profile") ? "csi-files-retirement/1" : "hosted-workspace-files/1",
                shape.equals("retained-pin") ? "b".repeat(64) : null);
        assertThat(jdbc.queryForObject("SELECT csi_guard FROM ma_session", Boolean.class))
                .isEqualTo(!shape.equals("ordinary"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"ordinary", "profile", "retained-pin"})
    void endedActionRecoveryDoesNotSettlePrivateOperations(String shape) {
        session(shape);
        String scope = ManagedSessionStore.sessionScopeKey("tenant", "session");
        String action = "tool_approval_" + "a".repeat(32);
        jdbc.update("INSERT INTO ma_session_record (session_scope_key, record_key, tenant_id, session_id,"
                + " domain, record_id, revision, gmt_create, record_kind, state, action_id, action_version, options_json)"
                + " VALUES (?, ?, 'tenant', 'session', 'action', ?, 1, 1, 'ACTION', 'expired', ?, 1, '{}')",
                scope, "c".repeat(64), action, action);
        jdbc.update("INSERT INTO ma_operation (operation_key, scope_key, operation_id, operation_kind, tenant_id,"
                + " session_id, target_kind, target_key, request_digest, request_json, state, phase,"
                + " delivery_state, action_id, gmt_create, gmt_modified) VALUES (?, ?, 'response', 'ACTION_RESPONSE',"
                + " 'tenant', 'session', 'SESSION', ?, 'digest', '{}', 'PENDING', 'PENDING', 'PENDING', ?, 1, 1)",
                "d".repeat(64), scope, ManagedSchemaKeys.key("session"), action);
        var before = jdbc.queryForMap("SELECT * FROM ma_operation");
        var owner = jdbc.queryForMap("SELECT * FROM ma_session");
        var store = new ManagedActionStore(jdbc, org.mockito.Mockito.mock(AgentStateStore.class));
        transaction.executeWithoutResult(status -> store.settleEndedResponses(2));
        if (shape.equals("ordinary")) {
            assertThat(jdbc.queryForMap("SELECT state, delivery_state FROM ma_operation"))
                    .containsEntry("state", "FAILED").containsEntry("delivery_state", "CONFIRMED");
        } else {
            assertThat(jdbc.queryForMap("SELECT * FROM ma_operation")).usingRecursiveComparison().isEqualTo(before);
        }
        assertThat(jdbc.queryForMap("SELECT * FROM ma_session")).usingRecursiveComparison().isEqualTo(owner);
    }

    @ParameterizedTest
    @ValueSource(strings = {"profile", "retained-pin"})
    void approvalChangesRespectThePrivateFenceBeforeReplayOrPolicyWrites(String shape) {
        session(shape);
        var owner = jdbc.queryForMap("SELECT * FROM ma_session");
        var store = new ManagedAgentStore(jdbc, json, Clock.systemUTC(), ignored -> {},
                new ManagedWorkspaceRegistry(jdbc), new ManagedAgentProperties());
        for (boolean saved : new boolean[] {false, true}) {
            if (saved) {
                String scope = ManagedSchemaKeys.key("SET_APPROVAL", "session", "actor");
                transaction.executeWithoutResult(status -> ManagedReceipts.insert(jdbc,
                        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptNamespace.SESSION_COMMAND,
                        "tenant", com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptScope.ACTOR,
                        scope, "approval", "digest", "SET_APPROVAL", "actor".getBytes(StandardCharsets.UTF_8),
                        "session", null, "COMPLETED", "ACTIVE", true, 1));
                jdbc.update("UPDATE ma_request_receipt SET result_json = '{\"mode\":\"auto-edit\",\"revision\":1}'");
            }
            var receipts = jdbc.queryForList("SELECT * FROM ma_request_receipt");
            assertThatThrownBy(() -> transaction.execute(status -> store.changeSessionApproval("tenant", "actor",
                    "session", "approval", "digest", "auto-edit", 0, true, true)))
                    .isInstanceOfSatisfying(ManagedAgentException.class,
                            error -> assertThat(error.getCode()).isEqualTo("csi_managed_mutation_unavailable"));
            assertThat(jdbc.queryForMap("SELECT * FROM ma_session")).usingRecursiveComparison().isEqualTo(owner);
            assertThat(jdbc.queryForList("SELECT * FROM ma_request_receipt")).usingRecursiveComparison().isEqualTo(receipts);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_public_event", Integer.class)).isZero();
        }
    }
}
