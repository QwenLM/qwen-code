package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.WorkspaceMount;
import com.alibaba.qwen.code.managedagent.service.RequestDigests;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class WorkspaceRecoveryStoreTest {
    @TempDir Path temporary;
    private JdbcTemplate jdbc;
    private DataSourceTransactionManager manager;
    private WorkspaceStorageGuard guard;
    private ManagedAgentStore sessions;
    private ObjectNode request;
    private Path root;
    private Path bundle;

    @BeforeEach
    void setUp() throws Exception {
        var source = recoveryDataSource();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        manager = new DataSourceTransactionManager(source);
        root = Files.createDirectory(temporary.resolve("source")).toRealPath();
        bundle = Files.createDirectory(temporary.resolve("bundle")).toRealPath();
        var properties = new ManagedAgentProperties();
        properties.getHarness().setCapabilityDigest("a".repeat(64));
        properties.getRuntimeBroker().setVerifiedWorkspaceRecoveryEnabled(true);
        properties.getRuntimeBroker().setWorkspaceMounts(List.of(new WorkspaceMount("tenant", "storage", root.toString())));
        guard = new WorkspaceStorageGuard(jdbc, manager, properties, path -> new WorkspaceStorageGuard.Identity(
                path.toRealPath().toString(), "test-host", "test-device", "test-inode", "2026-10-01T00:00:00Z"));
        sessions = new ManagedAgentStore(jdbc, WorkspaceRecoveryStore.JSON, Clock.systemUTC(), ignored -> {},
                new ManagedWorkspaceRegistry(jdbc), properties);
        for (String workspace : List.of("workspace-a", "workspace-b")) {
            jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation,"
                    + " storage_id, display_name, config_ref, policy_ref, state) VALUES ('tenant', ?, 1, 'storage',"
                    + " 'Test', ?, ?, 'ACTIVE')", workspace, WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
            jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                    + " VALUES ('tenant', ?, ?, 'OPERATOR')", workspace, "actor".getBytes(StandardCharsets.UTF_8));
        }
        guard.register("tenant", "storage", UUID.randomUUID().toString());
        String fence = UUID.randomUUID().toString();
        request = WorkspaceRecoveryStore.JSON.createObjectNode().put("version", 1)
                .put("operationId", UUID.randomUUID().toString()).put("tenantId", "tenant").put("storageId", "storage")
                .put("fenceOperationId", fence).put("mountRevision", 1).put("sourceRoot", root.toString())
                .put("bundleRoot", bundle.toString()).put("fileHistoryRoot", temporary.resolve("history").toString())
                .put("nodeExecutable", "/test/node").put("cliEntry", "/test/cli.js");
    }

    DataSource recoveryDataSource() {
        return new DriverManagerDataSource("jdbc:h2:mem:w1b-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
    }

    DataSource recoveryDataSource(String connectionTimeZone) {
        return jdbc.getDataSource();
    }

    @Test
    void registrationRejectsExistingPhysicalDeleteIntentAndRollsBackItsProtection() {
        String session = session("workspace-a");
        deletingCapture(session);
        assertThatThrownBy(this::capture).hasMessageContaining("source_drift");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'WORKSPACE_RECOVERY'", Long.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation_work", Long.class)).isZero();
    }

    @Test
    void registrationRejectsAPrivateClosureResourceDeleteIntent() {
        String session = session("workspace-a");
        String scope = ManagedSessionStore.sessionScopeKey("tenant", session);
        String key = ManagedSessionStore.resourceKey(scope, "checkpoint");
        jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, workspace_id, session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, state, deletion_operation_key, gmt_create) VALUES (?, ?, 'tenant', 'private-key', ?, 'checkpoint', 'managed-checkpoint', 1, 0, ?, 'MYSQL_INLINE', ?, 'REFERENCED', ?, " + ManagedSchemaTime.SQL_NOW + ")",
                key, scope, session, WorkspaceRecoveryStore.hash(new byte[0]), new byte[0], WorkspaceOperations.hash("gc"));
        jdbc.update("INSERT INTO ma_resource_ref (session_scope_key, owner_kind, owner_key, owner_revision, resource_key, tenant_id, workspace_id, session_id, resource_id, journal_revision, gmt_create) VALUES (?, 'JOURNAL', ?, 1, ?, 'tenant', 'private-key', ?, 'checkpoint', 1, " + ManagedSchemaTime.SQL_NOW + ")", scope, scope, key, session);
        assertThatThrownBy(this::capture).hasMessageContaining("source_drift");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'WORKSPACE_RECOVERY'", Long.class)).isZero();
    }

    @Test
    void registrationReadsDeleteIntentAfterWaitingForTheSessionRoot() throws Exception {
        String session = session("workspace-a");
        fence();
        var reached = new java.util.concurrent.CountDownLatch(1);
        var observed = new ManagedSchemaJdbcTemplate(jdbc.getDataSource()) {
            @Override public <T> List<T> query(String sql, org.springframework.jdbc.core.RowMapper<T> mapper, Object... args) {
                if (sql.contains(" FROM ma_session s JOIN ma_event_stream e") && sql.endsWith("FOR UPDATE")) {
                    reached.countDown();
                }
                return super.query(sql, mapper, args);
            }
        };
        try (var pool = Executors.newSingleThreadExecutor()) {
            var future = new java.util.concurrent.atomic.AtomicReference<java.util.concurrent.Future<?>>();
            new TransactionTemplate(manager).executeWithoutResult(status -> {
                jdbc.queryForList("SELECT session_id FROM ma_session WHERE tenant_id = ? AND session_id = ? FOR UPDATE", "tenant", session);
                future.set(pool.submit(() -> new WorkspaceRecoveryStore(observed, manager, guard, null, "capture", request.toString().getBytes(StandardCharsets.UTF_8))));
                try {
                    assertThat(reached.await(5, TimeUnit.SECONDS)).isTrue();
                    assertThatThrownBy(() -> future.get().get(100, TimeUnit.MILLISECONDS)).isInstanceOf(java.util.concurrent.TimeoutException.class);
                } catch (InterruptedException error) {
                    throw new AssertionError(error);
                }
                deletingCapture(session);
            });
            assertThatThrownBy(() -> future.get().get(5, TimeUnit.SECONDS)).hasCauseInstanceOf(IllegalStateException.class)
                    .hasRootCauseMessage("Workspace recovery: source_drift");
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'WORKSPACE_RECOVERY'", Long.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation_work", Long.class)).isZero();
    }

    private void deletingCapture(String session) {
        jdbc.update("INSERT INTO ma_output_capture (scope_key, tenant_key, tenant_id, workspace_id, session_id, publication_id, execution_key,"
                + " capture_id, binding_json, binding_digest, token_hash, state, capture_bytes, producer_bytes, admission_bytes, retention_state)"
                + " VALUES (?, ?, 'tenant', 'workspace-a', ?, 'pub', ?, 'capture', '{}', ?, ?, 'FENCED', 1, 1, 1, 'DELETING')",
                ToolPublicationDataStore.scope("tenant", "workspace-a", session), WorkspaceOperations.hash("tenant"), session,
                WorkspaceOperations.hash("execution"), WorkspaceOperations.hash("binding"), WorkspaceOperations.hash("token"));
    }

    @Test
    void completedGcRetirementExportsItsAuthorityAndVerifiesWithoutResettingCounters() throws Exception {
        String session = committedAndRetiredSession();
        var before = jdbc.queryForMap("SELECT writer_generation, journal_revision, committed_sequence, activation_epoch, last_commit_digest"
                + " FROM ma_session_head WHERE session_id = ? AND head_kind = 'MANAGED_SESSION'", session);
        var properties = new ManagedAgentProperties();
        properties.getToolPublication().setGcEnabled(true);
        properties.getToolPublication().setDeletionGrace(java.time.Duration.ZERO);
        var collector = new SessionResourceCollectionCollector(jdbc, manager, properties);
        for (int page = 0; page < 20 && collector.runOnce(); page++) {
            // collector.runOnce() in the condition does the work; the body stays empty.
        }
        assertThat(jdbc.queryForObject("SELECT state FROM ma_operation WHERE operation_kind = 'SESSION_RESOURCE_GC'", String.class)).isEqualTo("SUCCEEDED");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_journal_tx", Long.class)).isZero();
        var streamBefore = jdbc.queryForMap("SELECT last_sequence, replay_floor_sequence, covered_sequence, projection_version"
                + " FROM ma_event_stream WHERE session_id = ? AND stream_kind = 'SESSION'", session);
        var capture = capture();
        JsonNode exported = call(capture, "sessions").path("sessions").get(0).path("source");
        assertThat(exported.path("head").isNull()).isTrue();
        assertThat(exported.path("retiredHead").path("journalRevision").asLong()).isEqualTo(1);
        assertThat(exported.path("retiredHead").path("compactedThroughRevision").asLong()).isEqualTo(1);
        assertThat(exported.path("retiredHead").path("writerGeneration").asLong()).isEqualTo(((Number) before.get("writer_generation")).longValue());
        capture.call("sessionComplete", object().put("sessionId", session).set("summary", object()));
        Path path = Files.createDirectories(bundle.resolve(".w1-recovery")).resolve("manifest.json");
        Files.writeString(path, manifest(capture).toString());
        String manifestDigest = WorkspaceRecoveryStore.hash(Files.readAllBytes(path));
        var params = object().put("manifestDigest", manifestDigest);
        params.set("result", object().put("contentVerified", true).put("activation", false));
        capture.call("finish", params);
        request.put("captureOperationId", request.path("operationId").asText()).put("operationId", UUID.randomUUID().toString());
        var verification = store("verify");
        assertThat(call(verification, "sessions").path("sessions").get(0).path("source")).isEqualTo(exported);
        verification.call("sessionComplete", object().put("sessionId", session).set("summary", object()));
        verification.call("finish", params);
        assertThat(verification.inspect().path("state").asText()).isEqualTo("VERIFIED");
        guard.restoreOriginal("tenant", "storage", request.path("mountRevision").asLong(), request.path("fenceOperationId").asText());
        assertThat(jdbc.queryForMap("SELECT writer_generation, journal_revision, committed_sequence, activation_epoch, last_commit_digest"
                + " FROM ma_session_head WHERE session_id = ? AND head_kind = 'MANAGED_SESSION'", session)).isEqualTo(before);
        assertThat(jdbc.queryForObject("SELECT status FROM ma_session WHERE session_id = ?", String.class, session)).isEqualTo("DELETED");
        assertThat(jdbc.queryForMap("SELECT last_sequence, replay_floor_sequence, covered_sequence, projection_version"
                + " FROM ma_event_stream WHERE session_id = ? AND stream_kind = 'SESSION'", session)).isEqualTo(streamBefore);
    }

    @Test
    void partialOrUnknownGcCannotBePresentedAsACollectedRetirement() {
        String session = committedAndRetiredSession();
        jdbc.update("UPDATE ma_session_head SET compacted_through_revision = journal_revision WHERE session_id = ?", session);
        assertThatThrownBy(this::capture).hasMessageContaining("source_drift");
        String scope = ManagedSessionStore.sessionScopeKey("tenant", session);
        String id = "session-resources-" + scope;
        String key = com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.operationKey(
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.OperationKind.SESSION_RESOURCE_GC, scope, scope, id);
        jdbc.update("INSERT INTO ma_operation (operation_key, scope_key, session_scope_key, operation_kind, operation_id, tenant_id, session_id,"
                + " target_kind, target_key, request_digest, request_json, phase, state, gmt_create, gmt_modified)"
                + " VALUES (?, ?, ?, 'SESSION_RESOURCE_GC', ?, 'tenant', ?, 'SESSION', ?, 'digest', '{}', 'COLLECTING', 'UNKNOWN', 1, 1)",
                key, scope, scope, id, session, scope);
        assertThatThrownBy(this::capture).hasMessageContaining("source_drift");
        jdbc.update("UPDATE ma_operation SET state = 'SUCCEEDED' WHERE operation_key = ?", key);
        jdbc.update("UPDATE ma_session_head SET journal_revision = journal_revision + 1 WHERE session_id = ?", session);
        assertThatThrownBy(this::capture).hasMessageContaining("source_drift");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'WORKSPACE_RECOVERY'", Long.class)).isZero();
    }

    private String committedAndRetiredSession() {
        String session = session("workspace-a");
        jdbc.update("UPDATE ma_storage SET fence_operation_id = NULL WHERE tenant_id = ?", "tenant");
        long revision = request.path("mountRevision").asLong();
        if ("FENCED".equals(jdbc.queryForObject("SELECT mount_state FROM ma_storage_owner", String.class))) {
            guard.restoreOriginal("tenant", "storage", revision, request.path("fenceOperationId").asText());
            revision++;
            request.put("mountRevision", revision);
        }
        long committedRevision = revision;
        var journal = new ManagedSessionStore(jdbc);
        String token = "a".repeat(64);
        String records = "{\"subtype\":\"session_execution_engine\"}\n{\"subtype\":\"managed_session_header_v1\"}\n";
        byte[] bytes = records.getBytes(StandardCharsets.UTF_8);
        var tx = new TransactionTemplate(manager);
        tx.execute(status -> journal.acquireWriter("tenant", session, token,
                new ManagedSessionStoreModels.AcquireWriterRequest("workspace-a", "original", 30_000L)));
        tx.execute(status -> journal.commit("tenant", session, token, new ManagedSessionStoreModels.CommitTransactionRequest(
                "workspace-a", "original", 1, 0, 0, "genesis", "session.create", "genesis-command", WorkspaceRecoveryStore.hash(bytes),
                0, 0, 0, null, null, null, 0, null, 2, java.util.Base64.getEncoder().encodeToString(bytes), WorkspaceRecoveryStore.hash(bytes), List.of())));
        tx.execute(status -> journal.sealWriter("tenant", session, token, new ManagedSessionStoreModels.SealWriterRequest("workspace-a", "original", 1)));
        guard.fence("tenant", "storage", committedRevision, request.path("fenceOperationId").asText());
        retireSession(session);
        return session;
    }

    @Test
    void recoveryAdmissionIgnoresOtherOperationKindsButBlocksUnresolvedSessionEffects() {
        String session = session("workspace-a");
        String scope = ManagedSessionStore.sessionScopeKey("tenant", session);
        jdbc.update("INSERT INTO ma_operation (operation_key, scope_key, session_scope_key, operation_kind, operation_id, tenant_id, session_id,"
                + " target_kind, target_key, request_digest, request_json, state, phase, gmt_create, gmt_modified)"
                + " VALUES (?, ?, ?, 'OBJECT_PUT', 'original-put', 'tenant', ?, 'RESOURCE', ?, 'digest', '{}', 'RETURNED', 'PUT', 1, 1)",
                WorkspaceOperations.hash("put"), scope, scope, session, WorkspaceOperations.hash("object"));
        assertThat(WorkspaceRecoveryStore.currentSource(jdbc, "tenant", "storage", session, false).path("sessionId").asText())
                .isEqualTo(session);
        jdbc.update("INSERT INTO ma_operation (operation_key, scope_key, session_scope_key, operation_kind, operation_id, tenant_id, session_id,"
                + " target_kind, target_key, request_digest, request_json, state, phase, gmt_create, gmt_modified)"
                + " VALUES (?, ?, ?, 'CLOSE', 'original-close', 'tenant', ?, 'SESSION', ?, 'digest', '{}', 'UNKNOWN', 'UNKNOWN', 1, 1)",
                WorkspaceOperations.hash("close"), scope, scope, session, WorkspaceOperations.hash(session));
        assertThatThrownBy(() -> WorkspaceRecoveryStore.currentSource(jdbc, "tenant", "storage", session, false))
                .hasMessageContaining("source_drift");
    }

    @Test
    void pinsRetainedRetirementWithoutReopeningItsCheckpointOrWriter() {
        String session = session("workspace-a");
        head(session);
        String operation = retireSession(session);
        var before = jdbc.queryForMap("SELECT " + ManagedSchemaProjection.SESSION_HEAD.columns() + " FROM ma_session_head WHERE session_id = ?", session);
        var retirement = jdbc.queryForMap("SELECT retirement_operation_id, retirement_generation, retired_at, recovery_protected FROM ma_session WHERE session_id = ?", session);
        JsonNode source = call(capture(), "sessions").path("sessions").get(0).path("source");
        assertThat(source.path("retirement").path("operationId").asText()).isEqualTo(operation);
        assertThat(source.path("retirement").path("tenantId").asText()).isEqualTo("tenant");
        assertThat(source.path("retirement").path("sessionId").asText()).isEqualTo(session);
        assertThat(source.path("retirement").path("generation").asInt()).isEqualTo(1);
        assertThat(source.path("retirement").path("retiredAt").asLong()).isPositive();
        assertThat(source.path("retirement").path("recoveryProtected").asBoolean()).isFalse();
        assertThat(source.path("head").path("latestCheckpointResourceId").isNull()).isTrue();
        assertThat(source.path("head").path("writerId").isNull()).isTrue();
        assertThat(jdbc.queryForMap("SELECT " + ManagedSchemaProjection.SESSION_HEAD.columns() + " FROM ma_session_head WHERE session_id = ?", session)).isEqualTo(before);
        assertThat(jdbc.queryForMap("SELECT retirement_operation_id, retirement_generation, retired_at, recovery_protected FROM ma_session WHERE session_id = ?", session)).isEqualTo(retirement);
    }

    @Test
    void retirementDriftInvalidatesThePinnedCut() {
        String session = session("workspace-a");
        head(session);
        retireSession(session);
        var capture = capture();
        jdbc.update("UPDATE ma_session SET retired_at = retired_at + 1 WHERE session_id = ?", session);
        assertThatThrownBy(() -> capture.call("sessionComplete", object().put("sessionId", session).set("summary", object())))
                .hasMessageContaining("source_drift");
        assertThat(capture.inspect().path("state").asText()).isEqualTo("INVALIDATED");
    }

    @Test
    void collectedResourceInvalidatesTheCapture() {
        String session = session("workspace-a");
        head(session);
        byte[] bytes = "{\"proof\":true}".getBytes(StandardCharsets.UTF_8);
        String digest = WorkspaceRecoveryStore.hash(bytes);
        // The shape the stream-capture collector leaves: identity kept, state COLLECTED, bytes NULL.
        jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, workspace_id, session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, publish_command_id, state, gmt_create) VALUES (?, ?, 'tenant', 'private-key', ?, 'resource', 'managed-definition', 1, ?, ?, 'MYSQL_INLINE', NULL, 'command', 'COLLECTED', " + ManagedSchemaTime.SQL_NOW + ")",
                ManagedSessionStore.resourceKey(ManagedSessionStore.sessionScopeKey("tenant", session), "resource"),
                ManagedSessionStore.sessionScopeKey("tenant", session), session, bytes.length, digest);
        var capture = capture();
        ObjectNode params = object().put("sessionId", session);
        params.set("ref", object().put("resourceId", "resource").put("kind", "managed-definition")
                .put("schemaVersion", 1).put("byteLength", bytes.length).put("digest", digest));
        assertThatThrownBy(() -> capture.call("resource", params)).hasMessageContaining("resource_collected");
        assertThat(capture.inspect().path("state").asText()).isEqualTo("INVALIDATED");
        assertThat(capture.inspect().path("lastErrorCode").asText()).isEqualTo("resource_collected");
    }

    @Test
    void collectedPublicationObjectInvalidatesTheCapture() {
        String session = session("workspace-a");
        head(session);
        // The shape the publication collector leaves: the publication stays REFERENCED while
        // the object row is state COLLECTED with its bytes permanently freed.
        String sessionScope = ManagedSessionStore.sessionScopeKey("tenant", session);
        String scope = ToolPublicationDataStore.scope("tenant", "private-key", session);
        jdbc.update("INSERT INTO ma_output_capture (scope_key, tenant_key, tenant_id, workspace_id, session_id,"
                + " publication_id, execution_key, capture_id, binding_json, binding_digest, token_hash, state,"
                + " capture_bytes, producer_bytes, admission_bytes, producer_phase, write_evidence, accepted_complete,"
                + " receipt_sequence, receipt_revision) VALUES (?, ?, 'tenant', 'private-key', ?, 'pub-1', ?,"
                + " 'capture-1', '{}', ?, ?, 'FENCED', 0, 0, 0, 'REFERENCED', TRUE, TRUE, 1, 1)",
                scope, WorkspaceRecoveryStore.hash("tenant"), session, scope, scope, scope);
        jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, scope_key, publication_id, slot_key, resource_id, kind, byte_length, sha256, inline_bytes, capture_state, operation_id, tenant_id, workspace_id, session_id, schema_version, storage_kind, state, gmt_create) VALUES (?, ?, ?, 'pub-1', 'terminal', 'resource-1', 'managed-tool-terminal', 64, ?, NULL, 'COLLECTED', 'op-1', 'tenant', 'private-key', ?, 1, 'MYSQL_INLINE', 'COLLECTED', " + ManagedSchemaTime.SQL_NOW + ")", ManagedSessionStore.resourceKey(sessionScope, "resource-1"), sessionScope, scope, "a".repeat(64), session);
        var capture = capture();
        assertThatThrownBy(() -> capture.call("publicationObject",
                object().put("sessionId", session).put("publicationId", "pub-1").put("slotKey", "terminal")))
                .hasMessageContaining("resource_collected");
        assertThat(capture.inspect().path("state").asText()).isEqualTo("INVALIDATED");
        assertThat(capture.inspect().path("lastErrorCode").asText()).isEqualTo("resource_collected");
    }

    @Test
    void registrationRetriesATransientLockWait() {
        String session = session("workspace-a");
        head(session);
        fence();
        var contended = new ManagedSchemaJdbcTemplate(jdbc.getDataSource()) {
            private boolean tripped;
            @Override public int update(String sql, Object... args) {
                if (!tripped && sql.startsWith("INSERT INTO ma_operation (operation_key, scope_key")) {
                    tripped = true;
                    throw new org.springframework.dao.CannotAcquireLockException("injected lock wait");
                }
                return super.update(sql, args);
            }
        };
        var store = new WorkspaceRecoveryStore(contended, manager, guard, null, "capture",
                request.toString().getBytes(StandardCharsets.UTF_8));
        assertThat(store.inspect().path("state").asText()).isEqualTo("CAPTURING");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation_work WHERE work_kind = 'SESSION' AND session_id = ?",
                Long.class, session)).isOne();
    }

    @Test
    void registrationExhaustsItsRetriesOnPersistentLockWaits() {
        fence();
        var contended = new ManagedSchemaJdbcTemplate(jdbc.getDataSource()) {
            @Override public int update(String sql, Object... args) {
                if (sql.startsWith("INSERT INTO ma_operation (operation_key, scope_key")) {
                    throw new org.springframework.dao.CannotAcquireLockException("injected lock wait");
                }
                return super.update(sql, args);
            }
        };
        assertThatThrownBy(() -> new WorkspaceRecoveryStore(contended, manager, guard, null, "capture",
                request.toString().getBytes(StandardCharsets.UTF_8)))
                .isInstanceOf(org.springframework.dao.CannotAcquireLockException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'WORKSPACE_RECOVERY'", Long.class)).isZero();
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(strings = {"owner", "generation", "protected", "operation", "public", "head"})
    void refusesInconsistentRetirementEvidence(String damage) {
        String session = session("workspace-a");
        head(session);
        retireSession(session);
        switch (damage) {
            case "owner" -> jdbc.update("UPDATE ma_session_head SET tenant_id = X'666f726569676e' WHERE session_id = ?", session);
            case "generation" -> jdbc.update("UPDATE ma_session SET retirement_generation = 2 WHERE session_id = ?", session);
            case "protected" -> jdbc.update("UPDATE ma_session SET recovery_protected = TRUE WHERE session_id = ?", session);
            case "operation" -> jdbc.update("UPDATE ma_operation SET delivery_state = 'PENDING' WHERE session_id = ?", session);
            case "public" -> jdbc.update("UPDATE ma_session SET status = 'CLOSED' WHERE session_id = ?", session);
            case "head" -> jdbc.update("UPDATE ma_session_head SET latest_checkpoint_resource_id = X'72657461696e6564' WHERE session_id = ?", session);
            default -> throw new AssertionError(damage);
        }
        assertThatThrownBy(this::capture).hasMessageContaining("source_drift");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'WORKSPACE_RECOVERY'", Integer.class)).isZero();
    }

    @Test
    void capturesAndVerifiesSessionsThatPinStoredDefinitions() throws Exception {
        String builtin = session("workspace-a");
        // A stored definition is compiled and pinned at admission (D8c-1);
        // the storage also holds a deleted Session pinned to it.
        String agentId = "agent_" + "b".repeat(32);
        String definitionDigest = "c".repeat(64);
        String definitionJson = "{\"model\":{},\"instructions\":\"\","
                + "\"tools\":[{\"type\":\"hosted_profile\","
                + "\"profile\":\"hosted-workspace-files/1\"}],"
                + "\"permission_policy\":{\"approval_mode\":\"default\"}}";
        sessions.setManagedAgentDefinitionStore(
                new ManagedAgentDefinitionStore(jdbc, new RequestDigests()));
        String pinned = new TransactionTemplate(manager).execute(status -> {
            new ManagedAgentDefinitionStore(jdbc, new RequestDigests()).create("tenant", "def",
                    "def-digest", agentId, definitionDigest, definitionJson,
                    1L);
            return sessions.insertWorkspaceSessionCommand("tenant", "actor",
                    UUID.randomUUID().toString(),
                    "sha256:" + "a".repeat(64), agentId, null, null, List.of(),
                    null, new WorkspaceSelection("workspace-b", "."))
                    .sessionId();
        });
        String deleted = new TransactionTemplate(manager).execute(status ->
                sessions.insertWorkspaceSessionCommand("tenant", "actor",
                        UUID.randomUUID().toString(),
                        "sha256:" + "a".repeat(64), agentId, "1", null,
                        List.of(), null,
                        new WorkspaceSelection("workspace-b", "."))
                        .sessionId());
        head(deleted);
        retireSession(deleted);
        // The pinned Session carries non-empty agent instructions published
        // through the production publisher; W1 must read them back.
        head(pinned);
        jdbc.update("UPDATE ma_session_head SET workspace_id = X'776f726b73706163652d62'"
                + " WHERE session_id = ?", pinned);
        var instructions = new ManagedSessionStore(jdbc).publishAgentInstructions(
                "tenant", "workspace-b", pinned, "Keep the agent instructions. 保留指令。");
        var skillCatalog = List.<Map<String, Object>>of(Map.of(
                "name", "review", "description", "Review", "body", "Check the diff. 检查差异。"));
        var skills = new ManagedSessionStore(jdbc).publishAgentSkills(
                "tenant", "workspace-b", pinned, skillCatalog);
        JsonNode sources = call(capture(), "sessions").path("sessions");
        assertThat(sources).hasSize(3);
        JsonNode pinnedSource = null;
        JsonNode builtinSource = null;
        JsonNode deletedSource = null;
        for (JsonNode entry : sources) {
            JsonNode source = entry.path("source");
            String id = source.path("sessionId").asText();
            if (id.equals(pinned)) {
                pinnedSource = source;
            } else if (id.equals(builtin)) {
                builtinSource = source;
            } else if (id.equals(deleted)) {
                deletedSource = source;
            }
        }
        assertThat(pinnedSource).isNotNull();
        assertThat(deletedSource).isNotNull();
        for (JsonNode source : List.of(pinnedSource, deletedSource)) {
            assertThat(source.path("agentRevision").asText()).isEqualTo("1");
            assertThat(source.path("agentDefinitionDigest").asText())
                    .isEqualTo(definitionDigest);
        }
        assertThat(builtinSource.path("agentRevision").asText())
                .isEqualTo("1");
        assertThat(builtinSource.path("agentDefinitionDigest").isNull())
                .isTrue();
        // The recovery read of the PUBLISHED agent resources must
        // return the published bytes (resource_layout_unsupported before
        // the reader accepted the kind).
        var capture = capture();
        for (var resource : List.of(instructions, skills)) {
            ObjectNode ref = object().put("resourceId", resource.resourceId())
                    .put("kind", resource.kind())
                    .put("schemaVersion", resource.schemaVersion())
                    .put("byteLength", (int) resource.byteLength())
                    .put("digest", resource.digest());
            ObjectNode read = object().put("sessionId", pinned);
            read.set("ref", ref);
            byte[] expected = resource == instructions
                    ? "Keep the agent instructions. 保留指令。".getBytes(StandardCharsets.UTF_8)
                    : AgentDefinitionExtensions.skillsBytes(skillCatalog);
            assertThat(capture.call("resource", read).path("bytesBase64").asText())
                    .isEqualTo(java.util.Base64.getEncoder().encodeToString(expected));
            capture.call("enqueueRef", read);
            assertThat(capture.call("nextRef", object().put("sessionId", pinned)).toString())
                    .isEqualTo(ref.toString());
            capture.call("completeRef", read);
        }
        assertThat(capture.inspect().path("pendingReferences").asLong())
                .isZero();

        // Capture and verify still pass on the mixed storage.
        ObjectNode asset = object().put("key", "b".repeat(64));
        asset.set("metadata", object().put("type", "entry").put("path",
                "workspace").put("entryType", "directory").put("mode", 493));
        capture.call("asset", asset);
        for (String id : List.of(builtin, pinned, deleted)) {
            capture.call("sessionComplete", object().put("sessionId", id)
                    .set("summary", object()));
        }
        Path manifest = Files.createDirectories(bundle
                .resolve(".w1-recovery")).resolve("manifest.json");
        Files.writeString(manifest, manifest(capture).toString());
        ObjectNode finish = object().put("manifestDigest",
                WorkspaceRecoveryStore.hash(Files.readAllBytes(manifest)));
        finish.set("result", object().put("contentVerified", true)
                .put("activation", false));
        assertThat(capture.call("finish", finish).path("result")
                .path("authorityCompatible").asBoolean()).isTrue();
        String original = request.path("operationId").asText();
        request.put("captureOperationId", original).put("operationId",
                UUID.randomUUID().toString());
        Files.move(root, temporary.resolve("lost-source"));
        var verify = store("verify");
        for (String id : List.of(builtin, pinned, deleted)) {
            verify.call("sessionComplete", object().put("sessionId", id)
                    .set("summary", object()));
        }
        verify.call("asset", asset);
        assertThat(verify.call("finish", finish).path("state").asText())
                .isEqualTo("VERIFIED");
    }

    @Test
    void leaseFingerprintKeepsWallClockPrecisionAcrossConnectionTimeZones() {
        String session = session("workspace-a");
        head(session);
        jdbc.update("UPDATE ma_session_head SET state = 'ACTIVE',"
                + " writer_lease_until = 946684800123");
        var capture = capture();
        JsonNode source = call(capture, "sessions").path("sessions").get(0).path("source");
        assertThat(source.path("head").path("writerLeaseUntil").asText())
                .isEqualTo("2000-01-01T00:00:00.123");
        ObjectNode done = object().put("sessionId", session);
        done.set("summary", object());
        for (String zone : List.of("LOCAL", "UTC", "+08:00", "Asia/Shanghai")) {
            DataSource dataSource = recoveryDataSource(zone);
            var resumed = new WorkspaceRecoveryStore(new ManagedSchemaJdbcTemplate(dataSource),
                    new DataSourceTransactionManager(dataSource), guard, null, "capture",
                    request.toString().getBytes(StandardCharsets.UTF_8));
            assertThat(resumed.call("sessionComplete", done).path("complete").asBoolean()).isTrue();
            assertThat(call(resumed, "sessions").path("sessions").get(0).path("source")).isEqualTo(source);
        }
        jdbc.update("UPDATE ma_session_head SET writer_lease_until = 946684800124");
        assertThatThrownBy(() -> capture.call("sessionComplete", done)).hasMessageContaining("source_drift");
        assertThat(capture.inspect().path("state").asText()).isEqualTo("INVALIDATED");
    }

    @Test
    void rejectsCountersAndVersionsThatWouldTruncateAcrossTheProtocol() {
        request.put("version", 4294967297L);
        assertThatThrownBy(this::capture).hasMessageContaining("invalid_request");
        request.put("version", 1).put("mountRevision", ManagedSessionStoreModels.MAX_SAFE_COUNTER + 1);
        assertThatThrownBy(this::capture).hasMessageContaining("invalid_request");
        request.put("mountRevision", 1.5);
        assertThatThrownBy(this::capture).hasMessageContaining("invalid_request");
        ObjectNode ref = object().put("resourceId", "id").put("kind", "managed-definition")
                .put("schemaVersion", 4294967297L).put("byteLength", 0).put("digest", "a".repeat(64));
        assertThatThrownBy(() -> WorkspaceRecoveryReader.validateRef(ref)).hasMessageContaining("invalid_resource_reference");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'WORKSPACE_RECOVERY'", Integer.class)).isZero();
    }

    @Test
    void retainsUnsupportedSourceFailureOnInvalidationWithoutAcceptingUnknownReasons() {
        var capture = capture();
        assertThatThrownBy(() -> capture.call("invalidate", object().put("code", "arbitrary_reason")))
                .hasMessageContaining("invalid_request");
        assertThat(capture.inspect().path("state").asText()).isEqualTo("CAPTURING");
        capture.call("invalidate", object().put("code", "unsupported_source_entry"));
        assertThat(capture.inspect().path("state").asText()).isEqualTo("INVALIDATED");
        assertThat(capture.inspect().path("lastErrorCode").asText()).isEqualTo("unsupported_source_entry");
        capture.call("invalidate", object().put("code", "source_drift"));
        assertThat(capture.inspect().path("lastErrorCode").asText()).isEqualTo("unsupported_source_entry");
        assertThatThrownBy(() -> call(capture(), "context")).hasMessageContaining("source_drift");
    }

    @Test
    void pinsAllSharedStorageMembershipAndRetriesDerivedWorkWithoutMutatingAuthority() {
        List<String> ids = new ArrayList<>();
        for (int i = 0; i < 35; i++) {
            ids.add(session(i % 2 == 0 ? "workspace-a" : "workspace-b"));
        }
        jdbc.update("UPDATE ma_session SET status = 'ARCHIVED' WHERE session_id = ?", ids.getFirst());
        jdbc.update("UPDATE ma_session SET status = 'DELETED', deleted_at = 1 WHERE session_id = ?", ids.getLast());
        var before = sessionRows();
        var capture = capture();
        assertThat(call(capture, "context").path("sessionCount").asInt()).isEqualTo(35);
        JsonNode first = call(capture, "sessions");
        assertThat(first.path("sessions")).hasSize(32);
        JsonNode rest = capture.call("sessions", object().put("afterSessionId", first.path("nextSessionId").asText()));
        assertThat(rest.path("sessions")).hasSize(3);
        assertThat(capture.inspect().path("sessions")).hasSize(32);
        ObjectNode inspection = request.deepCopy().put("afterSessionId", first.path("nextSessionId").asText());
        var inspected = new WorkspaceRecoveryStore(jdbc, manager, guard, null, "inspect",
                inspection.toString().getBytes(StandardCharsets.UTF_8)).inspect();
        assertThat(inspected.path("sessions")).hasSize(3);
        assertThat(inspected.path("nextSessionId").isNull()).isTrue();
        assertThat(first.path("sessions").get(0).path("source").path("head").isNull()).isTrue();
        String key = "a".repeat(64);
        ObjectNode metadata = object().put("type", "entry").put("path", "workspace").put("entryType", "directory").put("mode", 493);
        ObjectNode asset = object().put("key", key);
        asset.set("metadata", metadata);
        capture.call("asset", asset);
        capture().call("asset", asset);
        assertThat(call(capture, "assetPage").path("assets")).hasSize(1);
        assertThat(sessionRows()).isEqualTo(before);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_head", Integer.class)).isZero();
        assertThatThrownBy(() -> capture.call("asset", object().put("key", key).set("metadata", object().put("type", "changed"))))
                .hasMessageContaining("asset_conflict");
        request.put("nodeExecutable", "/different/node");
        assertThatThrownBy(this::capture).hasMessageContaining("operation_conflict");
    }

    @Test
    void sourceDriftInvalidatesOutsideTheFailedDerivedTransaction() {
        String session = session("workspace-a");
        var capture = capture();
        jdbc.update("UPDATE ma_session SET version = version + 1 WHERE session_id = ?", session);
        assertThatThrownBy(() -> capture.call("sessionComplete", object().put("sessionId", session).set("summary", object())))
                .hasMessageContaining("source_drift");
        assertThat(capture.inspect().path("state").asText()).isEqualTo("INVALIDATED");
        assertThat(capture.inspect().path("lastErrorCode").asText()).isEqualTo("source_drift");
        capture.call("invalidate", object().put("code", "source_drift"));
        capture.call("failure", object().put("code", "bundle_io_failed"));
        assertThat(capture.inspect().path("lastErrorCode").asText()).isEqualTo("source_drift");
        assertThat(jdbc.queryForObject("SELECT state FROM ma_operation_work WHERE work_kind = 'SESSION' AND session_id = ?",
                String.class, session)).isEqualTo("PENDING");
        assertThat(jdbc.queryForObject("SELECT mount_state FROM ma_storage_owner", String.class)).isEqualTo("FENCED");
    }

    @Test
    void pinsPrivateKeyAndReadsResourceWithoutWriterOrVerificationMutations() {
        String session = session("workspace-a");
        head(session);
        byte[] bytes = "{\"proof\":true}".getBytes(StandardCharsets.UTF_8);
        String digest = WorkspaceRecoveryStore.hash(bytes);
        jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, workspace_id, session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, publish_command_id, state, gmt_create) VALUES (?, ?, 'tenant', 'private-key', ?, 'resource', 'managed-definition', 1, ?, ?, 'MYSQL_INLINE', ?, 'command', 'REFERENCED', " + ManagedSchemaTime.SQL_NOW + ")",
                ManagedSessionStore.resourceKey(ManagedSessionStore.sessionScopeKey("tenant", session), "resource"),
                ManagedSessionStore.sessionScopeKey("tenant", session), session, bytes.length, digest, bytes);
        jdbc.update("INSERT INTO ma_resource_ref (session_scope_key, owner_kind, owner_key, owner_revision, resource_key, tenant_id, workspace_id, session_id, journal_revision, resource_id, gmt_create) VALUES (?, 'JOURNAL', ?, 1, ?, 'tenant', 'private-key', ?, 1, 'resource', " + ManagedSchemaTime.SQL_NOW + ")",
                ManagedSessionStore.sessionScopeKey("tenant", session), ManagedSessionStore.sessionScopeKey("tenant", session),
                ManagedSessionStore.resourceKey(ManagedSessionStore.sessionScopeKey("tenant", session), "resource"), session);
        var capture = capture();
        JsonNode source = call(capture, "sessions").path("sessions").get(0).path("source");
        assertThat(source.path("head").path("workspaceId").asText()).isEqualTo("private-key");
        assertThat(source.path("binding").path("workspaceGeneration").isTextual()).isTrue();
        assertThat(source.path("binding").path("contextRevision").isTextual()).isTrue();
        ObjectNode ref = object().put("resourceId", "resource").put("kind", "managed-definition").put("schemaVersion", 1)
                .put("byteLength", bytes.length).put("digest", digest);
        ObjectNode params = object().put("sessionId", session);
        params.set("ref", ref);
        var before = jdbc.queryForMap("SELECT " + ManagedSchemaProjection.SESSION_HEAD.columns() + " FROM ma_session_head");
        assertThat(capture.call("resource", params).path("bytesBase64").asText())
                .isEqualTo(java.util.Base64.getEncoder().encodeToString(bytes));
        capture.call("enqueueRef", params);
        assertThat(capture.call("nextRef", object().put("sessionId", session))).isEqualTo(ref);
        assertThat(capture.inspect().path("pendingReferences").asLong()).isEqualTo(1);
        capture.call("completeRef", params);
        assertThat(capture.call("enqueueRef", params).path("complete").asBoolean()).isTrue();
        assertThat(capture.call("nextRef", object().put("sessionId", session)).isNull()).isTrue();
        ref.put("digest", "f".repeat(64));
        assertThatThrownBy(() -> capture.call("enqueueRef", params)).hasMessageContaining("reference_conflict");
        assertThat(jdbc.queryForMap("SELECT " + ManagedSchemaProjection.SESSION_HEAD.columns() + " FROM ma_session_head")).isEqualTo(before);
        assertThat(jdbc.queryForObject("SELECT last_verified_at FROM ma_resource", java.sql.Timestamp.class)).isNull();
    }

    @Test
    void liveWriterAndPendingTurnPreventCapturingEvenUnderAStorageFence() {
        String session = session("workspace-a");
        head(session);
        jdbc.update("UPDATE ma_session_head SET state = 'ACTIVE', writer_lease_until = 32472144000000");
        assertThatThrownBy(this::capture).hasMessageContaining("source_drift");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_operation WHERE operation_kind = 'WORKSPACE_RECOVERY'", Integer.class)).isZero();
        jdbc.update("UPDATE ma_session_head SET state = 'SEALED'");
        jdbc.update("INSERT INTO ma_turn (tenant_id, session_id, turn_id, prompt_id, input_json, payload_digest,"
                + " status, gmt_create, gmt_modified) VALUES ('tenant', ?, 'turn', ?, '[]', 'sha256:x', 'ACCEPTED', 1, 1)",
                session, UUID.randomUUID().toString());
        assertThatThrownBy(this::capture).hasMessageContaining("source_drift");
    }

    @Test
    void sealsOnlyExactManifestAndVerifiesPinnedBytesWhenOriginalRootIsGone() throws Exception {
        String session = session("workspace-a");
        var capture = capture();
        ObjectNode asset = object().put("key", "b".repeat(64));
        asset.set("metadata", object().put("type", "entry").put("path", "workspace").put("entryType", "directory").put("mode", 493));
        capture.call("asset", asset);
        ObjectNode done = object().put("sessionId", session);
        done.set("summary", object().put("status", "uninitialized"));
        capture.call("sessionComplete", done);
        Path manifest = Files.createDirectories(bundle.resolve(".w1-recovery")).resolve("manifest.json");
        Files.writeString(manifest, manifest(capture).toString());
        String digest = WorkspaceRecoveryStore.hash(Files.readAllBytes(manifest));
        ObjectNode finish = object().put("manifestDigest", "a".repeat(64));
        finish.set("result", object().put("contentVerified", true).put("activation", false));
        assertThatThrownBy(() -> capture.call("finish", finish)).hasMessageContaining("manifest_digest_conflict");
        finish.put("manifestDigest", digest);
        assertThat(capture.call("finish", finish).path("result").path("authorityCompatible").asBoolean()).isTrue();
        assertThat(capture().inspect()).isEqualTo(capture.inspect());
        String original = request.path("operationId").asText();
        request.put("captureOperationId", original).put("operationId", UUID.randomUUID().toString());
        Files.move(root, temporary.resolve("lost-source"));
        var verify = store("verify");
        verify.call("sessionComplete", done);
        assertThatThrownBy(() -> verify.call("finish", finish)).hasMessageContaining("assets_incomplete");
        verify.call("asset", asset);
        JsonNode verified = verify.call("finish", finish);
        assertThat(verified.path("state").asText()).isEqualTo("VERIFIED");
        assertThat(verified.path("result").path("contentVerified").asBoolean()).isTrue();
        assertThat(verified.path("result").path("authorityCompatible").asBoolean()).isFalse();
        assertThat(verified.path("result").path("activation").asBoolean()).isFalse();
    }

    @Test
    void inspectPreservesProgressAndStableFailureForResumption() {
        String session = session("workspace-a");
        var capture = capture();
        capture.call("sessionComplete", object().put("sessionId", session).set("summary", object()));
        capture.call("failure", object().put("code", "bundle_io_failed"));
        capture.workerFailed();
        JsonNode status = capture().inspect();
        assertThat(status.path("state").asText()).isEqualTo("CAPTURING");
        assertThat(status.path("sessionCount").asInt()).isEqualTo(1);
        assertThat(status.path("completedSessions").asInt()).isEqualTo(1);
        assertThat(status.path("lastErrorCode").asText()).isEqualTo("bundle_io_failed");
        assertThat(status.path("sourceDigest").asText()).matches("[0-9a-f]{64}");
        assertThat(status.path("registration").path("fenceOperationId")).isEqualTo(request.path("fenceOperationId"));
        assertThatThrownBy(() -> capture.call("failure", object().put("code", "raw stderr: secret")))
                .hasMessageContaining("invalid_error_code");
    }

    @Test
    void childSourceCensusFailureDurablyInvalidatesOnlyTheCapture() {
        var capture = capture();
        assertThat(capture.call("invalidate", object().put("code", "source_drift")).path("state").asText())
                .isEqualTo("INVALIDATED");
        assertThat(capture().inspect().path("state").asText()).isEqualTo("INVALIDATED");
        assertThatThrownBy(() -> call(capture, "context")).hasMessageContaining("source_drift");
        assertThat(jdbc.queryForObject("SELECT mount_state FROM ma_storage_owner", String.class)).isEqualTo("FENCED");
    }

    @Test
    void lateMembershipPreventsSealingTheOriginalCut() throws Exception {
        var capture = capture();
        assertThatThrownBy(() -> session("workspace-b")).isInstanceOf(com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException.class);
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, workspace_id, workspace_generation, workspace_storage_id,"
                + " cwd_relative, context_config_ref, context_revision, workspace_config_ref, workspace_policy_ref, creator_actor_key, owner_actor_key, gmt_create, gmt_modified)"
                + " VALUES ('tenant', ?, 'qwen-code', 'workspace-b', 1, 'storage', '.', ?, 1, ?, ?, ?, ?, 1, 1)", UUID.randomUUID().toString(),
                WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF,
                "actor".getBytes(StandardCharsets.UTF_8), "actor".getBytes(StandardCharsets.UTF_8));
        Path manifest = Files.createDirectories(bundle.resolve(".w1-recovery")).resolve("manifest.json");
        Files.writeString(manifest, manifest(capture).toString());
        ObjectNode params = object().put("manifestDigest", WorkspaceRecoveryStore.hash(Files.readAllBytes(manifest)));
        params.set("result", object().put("contentVerified", true).put("activation", false));
        assertThatThrownBy(() -> capture.call("finish", params)).hasMessageContaining("source_drift");
        assertThat(capture.inspect().path("state").asText()).isEqualTo("INVALIDATED");
        assertThat(capture.inspect().path("lastErrorCode").asText()).isEqualTo("source_drift");
    }

    @Test
    void concurrentInvalidationCannotBeOverwrittenByCompletion() throws Exception {
        var original = capture();
        Path manifest = Files.createDirectories(bundle.resolve(".w1-recovery")).resolve("manifest.json");
        Files.writeString(manifest, manifest(original).toString());
        ObjectNode params = object().put("manifestDigest", WorkspaceRecoveryStore.hash(Files.readAllBytes(manifest)));
        params.set("result", object().put("contentVerified", true).put("activation", false));
        try (var executor = Executors.newSingleThreadExecutor()) {
            var racingJdbc = new ManagedSchemaJdbcTemplate(jdbc.getDataSource()) {
                @Override
                public <T> java.util.List<T> query(String sql, org.springframework.jdbc.core.RowMapper<T> mapper, Object... args) {
                    if (sql.contains(" FROM ma_operation WHERE operation_key = ?") && sql.endsWith("FOR UPDATE")) {
                        try {
                            executor.submit(() -> original.call("invalidate", object().put("code", "source_drift")))
                                    .get(5, TimeUnit.SECONDS);
                        } catch (Exception error) {
                            throw new AssertionError(error);
                        }
                    }
                    return super.query(sql, mapper, args);
                }
            };
            var finishing = new WorkspaceRecoveryStore(racingJdbc, manager, guard, null, "capture",
                    request.toString().getBytes(StandardCharsets.UTF_8));
            assertThatThrownBy(() -> finishing.call("finish", params)).hasMessageContaining("operation_not_writable");
        }
        assertThat(original.inspect().path("state").asText()).isEqualTo("INVALIDATED");
        assertThat(original.inspect().path("lastErrorCode").asText()).isEqualTo("source_drift");
        assertThat(original.inspect().path("result").isNull()).isTrue();
        assertThat(original.inspect().path("manifestDigest").isNull()).isTrue();
    }

    private ObjectNode manifest(WorkspaceRecoveryStore capture) {
        JsonNode context = call(capture, "context");
        ObjectNode manifest = object().put("version", 1).put("provider", "local-workspace-bundle/1")
                .put("tenantId", "tenant").put("storageId", "storage").put("activation", false);
        for (String name : List.of("fenceOperationId", "mountRevision")) {
            manifest.set(name, request.path(name));
        }
        for (String name : List.of("registration", "sourceDigest", "sessionCount")) {
            manifest.set(name, context.path(name));
        }
        manifest.set("captureOperationId", request.path("operationId"));
        for (String name : List.of("sessions", "assets")) {
            manifest.putObject(name)
                    .put("path", ".w1-recovery/" + name + ".ndjson").put("byteLength", 0).put("digest", "a".repeat(64))
                    .put("count", "sessions".equals(name) ? context.path("sessionCount").asLong() : call(capture, "assetPage").path("assets").size());
        }
        return manifest;
    }

    private String session(String workspace) {
        return new TransactionTemplate(manager).execute(status -> sessions.insertWorkspaceSessionCommand("tenant", "actor", UUID.randomUUID().toString(),
                "sha256:" + "a".repeat(64), "qwen-code", null, null, List.of(), null,
                new WorkspaceSelection(workspace, ".")).sessionId());
    }

    private void head(String session) {
        jdbc.update("INSERT INTO ma_session_head (tenant_key, harness_key, head_kind, harness_session_id, tenant_id, workspace_id, session_id, storage_version, state, writer_generation, writer_id, writer_lease_until, lease_token_hash, journal_revision, committed_sequence, last_commit_digest, activation_epoch, compacted_through_revision, recovery_status, gmt_create, gmt_modified) VALUES (?, ?, 'MANAGED_SESSION', ?, 'tenant', 'private-key', ?, 1, 'SEALED', 1, 'original', 946684800000, ?, 1, 1, ?, 1, 0, 'READY', " + ManagedSchemaTime.SQL_NOW + ", " + ManagedSchemaTime.SQL_NOW + ")",
                WorkspaceOperations.hash("tenant"), WorkspaceOperations.hash(session), session, session, "a".repeat(64), "b".repeat(64));
    }

    private String retireSession(String session) {
        String operation = UUID.randomUUID().toString();
        String scope = ManagedSessionStore.sessionScopeKey("tenant", session);
        jdbc.update("UPDATE ma_session SET status = 'DELETING' WHERE session_id = ?", session);
        jdbc.update("INSERT INTO ma_operation (operation_key, scope_key, session_scope_key, target_kind, target_key, tenant_id, session_id, operation_id, operation_kind, actor_digest, idempotency_key, request_digest, request_json, state, phase, admission_stage, delivery_state, session_status_before, claim_owner, claim_until, claim_generation, available_at, gmt_create, gmt_modified) VALUES (?, ?, ?, 'SESSION', ?, 'tenant', ?, ?, 'DELETE', '', 'delete', 'digest', '{}', 'RUNNING', 'LEASED', 'JAVA_DURABLE', 'LEASED', 'CLOSED', 'worker', (" + ManagedSchemaTime.SQL_NOW + " + 60000), 1, 0, 0, 0)",
                com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.operationKey(
                        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.OperationKind.DELETE,
                        scope, WorkspaceOperations.hash(session), operation), scope, scope, WorkspaceOperations.hash(session), session, operation);
        jdbc.update("UPDATE ma_session_head SET latest_checkpoint_resource_id = X'72657461696e6564' WHERE session_id = ?", session);
        assertThat(new TransactionTemplate(manager).<Boolean>execute(status ->
                sessions.completeOperation("tenant", session, operation, "worker", 1, false))).isTrue();
        return operation;
    }

    private WorkspaceRecoveryStore capture() {
        return store("capture");
    }

    private void fence() {
        if ("READY".equals(jdbc.queryForObject("SELECT mount_state FROM ma_storage_owner", String.class))) {
            guard.fence("tenant", "storage", request.path("mountRevision").asLong(), request.path("fenceOperationId").asText());
        }
    }

    private WorkspaceRecoveryStore store(String mode) {
        if ("capture".equals(mode)) {
            fence();
        }
        return new WorkspaceRecoveryStore(jdbc, manager, guard, null, mode, request.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static ObjectNode object() {
        return WorkspaceRecoveryStore.JSON.createObjectNode();
    }

    private static JsonNode call(WorkspaceRecoveryStore store, String method) {
        return store.call(method, object());
    }

    // byte[] columns (creator_actor_key) compare by reference in a Map;
    // hex them so the immutability assertion compares content.
    private List<Map<String, Object>> sessionRows() {
        return jdbc.queryForList("SELECT " + ManagedSchemaProjection.SESSION.columns() + " FROM ma_session ORDER BY session_id").stream()
                .map(row -> {
                    Map<String, Object> copy = new LinkedHashMap<>(row);
                    copy.replaceAll((key, value) -> value instanceof byte[] b
                            ? java.util.HexFormat.of().formatHex(b) : value);
                    return copy;
                })
                .toList();
    }
}
