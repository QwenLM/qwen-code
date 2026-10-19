package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.artifact.ManagedArtifactPolicy;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.support.StaticListableBeanFactory;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verifyNoInteractions;

class ManagedActionResultCsiBoundaryTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private JdbcTemplate jdbc;
    private TransactionTemplate transaction;
    private ManagedAgentStore managed;
    private ManagedToolResultStore results;
    private ManagedActionStore actions;
    private String privateSession;

    @BeforeEach
    void setUp() {
        var data = new DriverManagerDataSource("jdbc:h2:mem:csi-action-result-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema.initialize(data);
        jdbc = new ManagedSchemaJdbcTemplate(data);
        var manager = new DataSourceTransactionManager(data);
        transaction = new TransactionTemplate(manager);
        var properties = new ManagedAgentProperties();
        properties.setAgentRevision("reviewed-agent/1");
        var registration = new WorkspaceCsiRegistration("tenant", "storage", "cluster", "ns", "pvc", "pvc-uid",
                "pv", "pv-uid", "disk.csi.example.com", "volume", "backend", "disk-serial", "/workspace", 7);
        new WorkspaceCsiReservationStore(jdbc, manager, JSON).register(registration);
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation,"
                + " storage_id, display_name, config_ref, policy_ref, state) VALUES"
                + " ('tenant', 'workspace', 3, 'storage', 'CSI', ?, ?, 'ACTIVE')",
                CsiFilesRetirementProfile.CONFIG_REF, CsiFilesRetirementProfile.POLICY_REF);
        jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                + " VALUES ('tenant', 'workspace', ?, 'OPERATOR')", ManagedWorkspaceRegistry.actorKey("tenant", "actor"));
        privateSession = WorkspaceCsiSessionMain.create(jdbc, manager, JSON, properties,
                new WorkspaceCsiSessionMain.Request(registration, "actor", "original", null, null,
                        new WorkspaceSelection("workspace", "."))).sessionId();
        managed = new ManagedAgentStore(jdbc, JSON, Clock.systemUTC(), ignored -> {},
                new ManagedWorkspaceRegistry(jdbc), properties);
        results = new ManagedToolResultStore(jdbc, manager, managed);
        actions = new ManagedActionStore(jdbc, managed);
    }

    @AfterEach
    void shutDownOwnedDatabase() {
        jdbc.execute("SHUTDOWN");
    }

    @Test
    void historicalPrivateResultStatesRemainUnchangedAcrossAllLegacyCallbacks() {
        for (String state : List.of("PENDING", "RETRYABLE", "LEASED", "UNSUPPORTED", "SUPPRESSED", "QUARANTINED", "READY")) {
            seedResult(privateSession, "private-" + state, state);
        }
        seedHead(privateSession);
        jdbc.update("UPDATE ma_session SET tool_profile = 'ordinary' WHERE session_id = ?", privateSession);
        assertThat(jdbc.queryForObject("SELECT csi_guard FROM ma_session WHERE session_id = ?",
                Boolean.class, privateSession)).isTrue();
        var before = tables();
        results.captureEvents("tenant", "workspace", privateSession, 1, List.of(receipt(privateSession)));
        results.backfillOnePage();
        assertThat(results.claim()).isEmpty();
        for (String state : List.of("PENDING", "RETRYABLE", "LEASED", "UNSUPPORTED", "SUPPRESSED", "QUARANTINED", "READY")) {
            var source = JSON.convertValue(ManagedToolResultStore.parse(jdbc.queryForObject(
                    "SELECT request_json FROM ma_operation WHERE operation_kind = 'TOOL_RESULT_PROJECTION' AND operation_id = ?", String.class,
                    "private-" + state)), ManagedToolResultStore.Source.class);
            var claim = new ManagedToolResultStore.Claim(source, 1);
            results.fail(claim, "RETRYABLE", "late-callback");
            assertThat(results.complete(claim, projection(), "policy")).isFalse();
            assertThat(results.admitsLegacyProjection(claim)).isFalse();
        }
        assertThat(tables()).isEqualTo(before);
    }

    @Test
    void storedPrivateScopeWinsOverForgedCallerAndJsonBeforeLeaseOrIo() {
        var original = seedResult(privateSession, "private-forged", "LEASED");
        var forged = new ManagedToolResultStore.Source(original.id(), "ordinary-tenant", "ordinary-workspace",
                "ordinary-session", original.executionCallId(), 1, 1, JSON.nullNode(), JSON.nullNode(),
                JSON.createArrayNode(), original.sourceDigest());
        jdbc.update("UPDATE ma_operation SET request_json = ? WHERE operation_kind = 'TOOL_RESULT_PROJECTION' AND operation_id = ?",
                JSON.valueToTree(forged).toString(), original.id());
        jdbc.update("DELETE FROM ma_tenant_guard WHERE guard_domain = 'output_publication'");
        var data = mock(ToolPublicationDataStore.class);
        var reader = mock(ManagedArtifactReader.class);
        var policy = mock(ManagedArtifactPolicy.class);
        var beans = new StaticListableBeanFactory();
        beans.addBean("data", data);
        var projector = new ManagedToolResultProjector(results, jdbc,
                beans.getBeanProvider(ToolPublicationDataStore.class), reader, policy, new ManagedAgentProperties());
        var before = tables();
        var claim = new ManagedToolResultStore.Claim(forged, 1);
        results.fail(claim, "UNSUPPORTED", "legacy-producer");
        assertThat(results.complete(claim, projection(), "policy")).isFalse();
        projector.project(claim);
        verifyNoInteractions(data, reader, policy);
        assertThat(tables()).isEqualTo(before);
    }

    @Test
    void privateBacklogDoesNotFillResultHeadOrActionSelectionLimits() {
        for (String state : List.of("PENDING", "RETRYABLE", "LEASED")) {
            seedResult(privateSession, "a-private-" + state, state);
        }
        seedHead(privateSession);
        for (int index = 0; index < 51; index++) {
            seedOperation(privateSession, "private-op-" + index, "PENDING", 0);
        }
        insertOrdinarySession("z-ordinary");
        seedOperation("z-ordinary", "ordinary-op", "PENDING", 1);
        var privateBefore = privateRows();
        seedHead("z-journal-only");
        var ordinary = seedResult("z-journal-only", "z-ordinary-result", "PENDING");
        assertThat(actions.deliverable(System.currentTimeMillis())).extracting(StoreModels.OperationTarget::operationId)
                .containsExactly("ordinary-op");
        assertThat(results.claim().orElseThrow().source()).isEqualTo(ordinary);
        results.backfillOnePage();
        assertThat(jdbc.queryForObject("SELECT o3_backfill_pending FROM ma_session_head"
                + " WHERE session_id = X'7a2d6a6f75726e616c2d6f6e6c79'", Boolean.class)).isFalse();
        assertThat(privateRows()).isEqualTo(privateBefore);
    }

    @Test
    void privateActionMutatorsRefuseWhileNonActionCallbackDoesNoWork() {
        seedOperation(privateSession, "private-op", "LEASED", 0);
        var op = managed.findOperation("tenant", privateSession, "private-op").orElseThrow();
        var before = tables();
        assertPrivate(() -> transaction.executeWithoutResult(status -> actions.complete(op, "owner", null, "decision", true, 1)));
        assertPrivate(() -> transaction.executeWithoutResult(status -> actions.admit("tenant", privateSession,
                "actor", "actor-digest", "response", "request", "action", JSON.createObjectNode(), 1)));
        byte[] changed = "{\"subtype\":\"managed_session_event_v1\",\"managedSession\":{\"kind\":\"action.changed\"}}\n"
                .getBytes(StandardCharsets.UTF_8);
        assertPrivate(() -> transaction.executeWithoutResult(status -> actions.apply("tenant", "workspace", privateSession,
                1, 1, changed, id -> { throw new AssertionError("Private callback resolved an action resource"); })));
        byte[] receipt = "{\"subtype\":\"managed_session_event_v1\",\"managedSession\":{\"kind\":\"tool.receipt\"}}\n"
                .getBytes(StandardCharsets.UTF_8);
        transaction.executeWithoutResult(status -> actions.apply("tenant", "workspace", privateSession, 1, 1,
                receipt, id -> { throw new AssertionError("Non-action callback resolved an action resource"); }));
        assertThat(tables()).isEqualTo(before);
    }

    @Test
    void conflictingOrdinarySourceDoesNotSettleRetiredOrLapsedResult() {
        for (boolean retired : List.of(false, true)) {
            String session = "ordinary-" + retired;
            var source = seedResult(session, session, "LEASED");
            if (retired) {
                jdbc.update("INSERT INTO ma_session (tenant_key, session_key, tenant_id, session_id, session_kind,"
                        + " retirement_operation_id, retirement_generation, retired_at, recovery_protected, gmt_create, gmt_modified)"
                        + " VALUES (?, ?, 'tenant', ?, 'CONTROL', 'retirement', 1, 0, FALSE, 0, 0)", ToolPublicationRetentionStore.hash("tenant"),
                        ToolPublicationRetentionStore.hash(session), session);
            }
            var conflicting = new ManagedToolResultStore.Source(source.id(), source.tenantId(), source.workspaceId(),
                    "foreign", source.executionCallId(), 1, 1, source.outcomeRef(), source.resultRef(),
                    source.resources(), source.sourceDigest());
            var claim = new ManagedToolResultStore.Claim(conflicting, 1);
            var before = tables();
            assertThatThrownBy(() -> results.fail(claim, "RETRYABLE", "error")).hasMessageContaining("source conflicts");
            assertThatThrownBy(() -> results.complete(claim, projection(), "policy")).hasMessageContaining("source conflicts");
            assertThatThrownBy(() -> results.admitsLegacyProjection(claim)).hasMessageContaining("source conflicts");
            assertThat(tables()).isEqualTo(before);
            assertThat(results.complete(new ManagedToolResultStore.Claim(source, 1), projection(), "policy")).isFalse();
            assertThat(jdbc.queryForMap("SELECT state AS work_state, failure_code FROM ma_operation WHERE operation_kind = 'TOOL_RESULT_PROJECTION' AND operation_id = ?",
                    source.id())).containsEntry("work_state", retired ? "SUPPRESSED" : "RETRYABLE")
                    .containsEntry("failure_code", retired ? "session_retired" : "projection_claim_lapsed");
        }
    }

    @Test
    void ambientBackfillRefusesBeforeAnyWrite() {
        seedHead("ordinary");
        var before = tables();
        assertThatThrownBy(() -> transaction.executeWithoutResult(status -> results.backfillOnePage()))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("owns its scheduler transactions");
        assertThat(tables()).isEqualTo(before);
        results.backfillOnePage();
        assertThat(jdbc.queryForObject("SELECT o3_backfill_pending FROM ma_session_head", Boolean.class)).isFalse();
    }

    @Test
    void projectionAdmissionRejectsOldGenerationBeforeOpeningResources() {
        var source = seedResult("ordinary", "ordinary", "LEASED");
        var data = mock(ToolPublicationDataStore.class);
        var reader = mock(ManagedArtifactReader.class);
        var policy = mock(ManagedArtifactPolicy.class);
        var beans = new StaticListableBeanFactory();
        beans.addBean("data", data);
        var projector = new ManagedToolResultProjector(results, jdbc,
                beans.getBeanProvider(ToolPublicationDataStore.class), reader, policy, new ManagedAgentProperties());
        for (var entry : Map.of("LEASED", 2L, "READY", 1L, "RETRYABLE", 1L).entrySet()) {
            String state = entry.getKey();
            long generation = entry.getValue();
            jdbc.update("UPDATE ma_operation SET state = ?, claim_generation = ? WHERE operation_id = ?",
                    state, generation, source.id());
            var claim = new ManagedToolResultStore.Claim(source, 1);
            assertThat(results.admitsLegacyProjection(claim)).isFalse();
            projector.project(claim);
            verifyNoInteractions(data, reader, policy);
            assertThat(jdbc.queryForMap("SELECT state, claim_generation FROM ma_operation WHERE operation_id = ?", source.id()))
                    .containsEntry("state", state).containsEntry("claim_generation", generation);
        }
    }

    @Test
    void expiredMillisecondClaimIsReclaimedOnceAndFutureClaimStaysOwned() {
        var source = seedResult("ordinary", "original", "LEASED");
        long future = Instant.parse("2040-01-01T00:00:00.123Z").toEpochMilli();
        jdbc.update("UPDATE ma_operation SET claim_until = ? WHERE operation_id = ?", future, source.id());
        assertThat(results.claim()).isEmpty();
        jdbc.update("UPDATE ma_operation SET claim_until = 1000 WHERE operation_id = ?", source.id());
        var claim = results.claim().orElseThrow();
        assertThat(claim.source()).isEqualTo(source);
        assertThat(claim.generation()).isEqualTo(2L);
        assertThat(results.claim()).isEmpty();
        assertThat(results.admitsLegacyProjection(new ManagedToolResultStore.Claim(source, 1))).isFalse();
        assertThat(results.admitsLegacyProjection(claim)).isTrue();
    }

    private ManagedToolResultStore.Source seedResult(String session, String id, String state) {
        // Explicit historical legacy work, not original native membership.
        var source = new ManagedToolResultStore.Source(id, "tenant", "workspace", session, "execution-" + id,
                1, 1, JSON.nullNode(), JSON.nullNode(), JSON.createArrayNode(), "a".repeat(64));
        String scope = ManagedToolResultStore.scope("tenant", session);
        String execution = ManagedToolResultStore.identity("execution", source.executionCallId()).substring(10);
        String key = com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.operationKey(
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.OperationKind.TOOL_RESULT_PROJECTION, scope, execution, id);
        jdbc.update("INSERT INTO ma_operation (operation_key, scope_key, session_scope_key, operation_kind, operation_id,"
                + " target_kind, target_key, execution_key, tenant_id, workspace_id, session_id, request_json, request_digest,"
                + " phase, state, claim_generation, claim_until, gmt_create, gmt_modified)"
                + " VALUES (?, ?, ?, 'TOOL_RESULT_PROJECTION', ?, 'TOOL_EXECUTION', ?, ?, 'tenant', 'workspace', ?, ?, ?,"
                + " 'PROJECTING', ?, 1, 0, 0, 0)", key, scope, scope, id, execution, execution,
                session, JSON.valueToTree(source).toString(), source.sourceDigest(), state);
        return source;
    }

    private void seedHead(String session) {
        jdbc.update("INSERT INTO ma_session_head (tenant_key, harness_key, head_kind, harness_session_id, tenant_id, workspace_id, session_id, storage_version,"
                + " state, writer_generation, journal_revision, committed_sequence, activation_epoch, compacted_through_revision,"
                + " recovery_status, gmt_create, gmt_modified) VALUES (?, ?, 'MANAGED_SESSION', ?, 'tenant', 'workspace', ?, 1, 'ACTIVE', 1, 0, 0, 0, 0,"
                + " 'READY', " + ManagedSchemaTime.SQL_NOW + ", " + ManagedSchemaTime.SQL_NOW + ")", WorkspaceOperations.hash("tenant"), WorkspaceOperations.hash(session), session, session);
    }

    private void insertOrdinarySession(String session) {
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, status, gmt_create, gmt_modified)"
                + " VALUES ('tenant', ?, 'qwen-code', 'ACTIVE', 0, 0)", session);
    }

    private void seedOperation(String session, String id, String delivery, long available) {
        String scope = ManagedSessionStore.sessionScopeKey("tenant", session);
        String target = WorkspaceOperations.hash(session);
        String key = com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.operationKey(
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.OperationKind.ACTION_RESPONSE, scope, target, id);
        jdbc.update("INSERT INTO ma_operation (operation_key, scope_key, session_scope_key, target_kind, target_key, target_id, tenant_id, session_id, operation_id, operation_kind, actor_digest,"
                + " idempotency_key, idempotency_digest, request_digest, request_json, state, phase, admission_stage, delivery_state, session_status_before, claim_owner,"
                + " claim_until, claim_generation, available_at, gmt_create, gmt_modified) VALUES (?, ?, ?, 'SESSION', ?, ?, 'tenant', ?, ?, 'ACTION_RESPONSE',"
                + " '', ?, ?, 'digest', '{}', 'PENDING', 'PENDING', 'ADMITTED', ?, 'ACTIVE', 'owner', 0, 1, ?, 0, 0)",
                key, scope, scope, target, session, session, id, id, WorkspaceOperations.hash(id), delivery, available);
    }

    private JsonNode receipt(String session) {
        var event = JSON.createObjectNode().put("sequence", 1);
        event.set("sessionKey", JSON.createObjectNode().put("tenantId", "tenant").put("workspaceId", "workspace")
                .put("sessionId", session));
        event.set("payload", JSON.createObjectNode().put("executionCallId", "new-receipt").putNull("toolOutcomeRef")
                .putNull("resultRef").set("resources", JSON.createArrayNode()));
        return event;
    }

    private ManagedToolResultStore.Projection projection() {
        return new ManagedToolResultStore.Projection(JSON.createObjectNode(), "missing", JSON.createObjectNode(),
                JSON.nullNode(), List.of(), "policy");
    }

    private Map<String, JsonNode> tables() {
        var result = new TreeMap<String, JsonNode>();
        for (String table : jdbc.queryForList("SELECT table_name FROM information_schema.tables"
                + " WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name", String.class)) {
            var rows = jdbc.queryForList("SELECT * FROM " + table).stream().map(row -> {
                row.replaceAll((column, value) -> value instanceof java.sql.Timestamp timestamp ? timestamp.toString() : value);
                return JSON.<JsonNode>valueToTree(row);
            })
                    .sorted(Comparator.comparing(JsonNode::toString)).toList();
            result.put(table, JSON.valueToTree(rows));
        }
        assertThat(result.keySet()).isEqualTo(
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.TABLES);
        return result;
    }

    private Map<String, JsonNode> privateRows() {
        var result = new TreeMap<String, JsonNode>();
        for (String table : List.of("ma_operation", "ma_session_head")) {
            var rows = jdbc.queryForList("SELECT * FROM " + table + " WHERE session_id = ?", privateSession);
            rows.forEach(row -> row.replaceAll((column, value) -> value instanceof java.sql.Timestamp timestamp ? timestamp.toString() : value));
            result.put(table, JSON.valueToTree(rows));
        }
        return result;
    }

    private static void assertPrivate(Runnable action) {
        assertThatThrownBy(action::run).isInstanceOfSatisfying(ManagedAgentException.class, error -> {
            assertThat(error.getStatus()).isEqualTo(HttpStatus.CONFLICT);
            assertThat(error.getCode()).isEqualTo("csi_managed_mutation_unavailable");
        });
    }
}
