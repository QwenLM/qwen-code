package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties.RuntimeBroker.WorkspaceMount;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

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
        var source = new DriverManagerDataSource("jdbc:h2:mem:w1b-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
        Flyway.configure().dataSource(source).locations("classpath:db/migration").load().migrate();
        jdbc = new JdbcTemplate(source);
        manager = new DataSourceTransactionManager(source);
        root = Files.createDirectory(temporary.resolve("source")).toRealPath();
        bundle = Files.createDirectory(temporary.resolve("bundle")).toRealPath();
        var properties = new ManagedAgentProperties();
        properties.getHarness().setCapabilityDigest("a".repeat(64));
        properties.getRuntimeBroker().setVerifiedWorkspaceRecoveryEnabled(true);
        properties.getRuntimeBroker().setWorkspaceMounts(List.of(new WorkspaceMount("tenant", "storage", root.toString())));
        guard = new WorkspaceStorageGuard(jdbc, manager, properties, path -> new WorkspaceStorageGuard.Identity(
                path.toRealPath().toString(), "test-host", "test-device", "test-inode", "2026-10-01T00:00:00Z"));
        sessions = new ManagedAgentStore(jdbc, WorkspaceRecoveryStore.JSON, Clock.systemUTC(), ignored -> { },
                new ManagedWorkspaceRegistry(jdbc), properties);
        for (String workspace : List.of("workspace-a", "workspace-b")) {
            jdbc.update("INSERT INTO managed_workspace_registry (tenant_id, workspace_id, workspace_generation,"
                    + " storage_id, display_name, config_ref, policy_ref, state) VALUES ('tenant', ?, 1, 'storage',"
                    + " 'Test', ?, ?, 'ACTIVE')", workspace, WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
            jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, can_read, can_create)"
                    + " VALUES ('tenant', ?, ?, TRUE, TRUE)", workspace, "actor".getBytes(StandardCharsets.UTF_8));
        }
        guard.register("tenant", "storage", UUID.randomUUID().toString());
        String fence = UUID.randomUUID().toString();
        guard.fence("tenant", "storage", 1, fence);
        request = WorkspaceRecoveryStore.JSON.createObjectNode().put("version", 1)
                .put("operationId", UUID.randomUUID().toString()).put("tenantId", "tenant").put("storageId", "storage")
                .put("fenceOperationId", fence).put("mountRevision", 1).put("sourceRoot", root.toString())
                .put("bundleRoot", bundle.toString()).put("fileHistoryRoot", temporary.resolve("history").toString())
                .put("nodeExecutable", "/test/node").put("cliEntry", "/test/cli.js");
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
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_recovery_operation", Integer.class)).isZero();
    }

    @Test
    void pinsAllSharedStorageMembershipAndRetriesDerivedWorkWithoutMutatingAuthority() {
        List<String> ids = new ArrayList<>();
        for (int i = 0; i < 35; i++) ids.add(session(i % 2 == 0 ? "workspace-a" : "workspace-b"));
        jdbc.update("UPDATE managed_agent_session SET status = 'ARCHIVED' WHERE session_id = ?", ids.getFirst());
        jdbc.update("UPDATE managed_agent_session SET status = 'DELETED', deleted_at = 1 WHERE session_id = ?", ids.getLast());
        var before = jdbc.queryForList("SELECT * FROM managed_agent_session ORDER BY session_id");
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
        assertThat(jdbc.queryForList("SELECT * FROM managed_agent_session ORDER BY session_id")).isEqualTo(before);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_journal_head", Integer.class)).isZero();
        assertThatThrownBy(() -> capture.call("asset", object().put("key", key).set("metadata", object().put("type", "changed"))))
                .hasMessageContaining("asset_conflict");
        request.put("nodeExecutable", "/different/node");
        assertThatThrownBy(this::capture).hasMessageContaining("operation_conflict");
    }

    @Test
    void sourceDriftInvalidatesOutsideTheFailedDerivedTransaction() {
        String session = session("workspace-a");
        var capture = capture();
        jdbc.update("UPDATE managed_agent_session SET version = version + 1 WHERE session_id = ?", session);
        assertThatThrownBy(() -> capture.call("sessionComplete", object().put("sessionId", session).set("summary", object())))
                .hasMessageContaining("source_drift");
        assertThat(capture.inspect().path("state").asText()).isEqualTo("INVALIDATED");
        assertThat(capture.inspect().path("lastErrorCode").asText()).isEqualTo("source_drift");
        capture.call("invalidate", object().put("code", "source_drift"));
        capture.call("failure", object().put("code", "bundle_io_failed"));
        assertThat(capture.inspect().path("lastErrorCode").asText()).isEqualTo("source_drift");
        assertThat(jdbc.queryForObject("SELECT state FROM managed_workspace_recovery_session WHERE session_id = ?",
                String.class, session)).isEqualTo("PENDING");
        assertThat(jdbc.queryForObject("SELECT mount_state FROM managed_workspace_execution_lease", String.class)).isEqualTo("FENCED");
    }

    @Test
    void pinsPrivateKeyAndReadsResourceWithoutWriterOrVerificationMutations() {
        String session = session("workspace-a");
        head(session);
        byte[] bytes = "{\"proof\":true}".getBytes(StandardCharsets.UTF_8);
        String digest = WorkspaceRecoveryStore.hash(bytes);
        jdbc.update("INSERT INTO qwen_managed_session_resource (session_scope_key, tenant_id, workspace_id, session_id,"
                + " resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, publish_command_id,"
                + " state, created_at) VALUES (?, 'tenant', 'private-key', ?, 'resource', 'managed-definition', 1, ?, ?,"
                + " 'MYSQL_INLINE', ?, 'command', 'REFERENCED', CURRENT_TIMESTAMP(6))",
                ManagedSessionStore.sessionScopeKey("tenant", session), session, bytes.length, digest, bytes);
        jdbc.update("INSERT INTO qwen_managed_session_resource_ref (session_scope_key, tenant_id, workspace_id, session_id,"
                + " journal_revision, resource_id, created_at) VALUES (?, 'tenant', 'private-key', ?, 1, 'resource', CURRENT_TIMESTAMP(6))",
                ManagedSessionStore.sessionScopeKey("tenant", session), session);
        var capture = capture();
        JsonNode source = call(capture, "sessions").path("sessions").get(0).path("source");
        assertThat(source.path("head").path("workspaceId").asText()).isEqualTo("private-key");
        assertThat(source.path("binding").path("workspaceGeneration").isTextual()).isTrue();
        assertThat(source.path("binding").path("contextRevision").isTextual()).isTrue();
        ObjectNode ref = object().put("resourceId", "resource").put("kind", "managed-definition").put("schemaVersion", 1)
                .put("byteLength", bytes.length).put("digest", digest);
        ObjectNode params = object().put("sessionId", session);
        params.set("ref", ref);
        var before = jdbc.queryForMap("SELECT * FROM qwen_managed_session_journal_head");
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
        assertThat(jdbc.queryForMap("SELECT * FROM qwen_managed_session_journal_head")).isEqualTo(before);
        assertThat(jdbc.queryForObject("SELECT last_verified_at FROM qwen_managed_session_resource", java.sql.Timestamp.class)).isNull();
    }

    @Test
    void liveWriterAndPendingTurnPreventCapturingEvenUnderAStorageFence() {
        String session = session("workspace-a");
        head(session);
        jdbc.update("UPDATE qwen_managed_session_journal_head SET state = 'ACTIVE', writer_lease_until = '2999-01-01 00:00:00'");
        assertThatThrownBy(this::capture).hasMessageContaining("source_drift");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_recovery_operation", Integer.class)).isZero();
        jdbc.update("UPDATE qwen_managed_session_journal_head SET state = 'SEALED'");
        jdbc.update("INSERT INTO managed_agent_turn (tenant_id, session_id, turn_id, prompt_id, input_json, payload_digest,"
                + " status, created_at, updated_at) VALUES ('tenant', ?, 'turn', ?, '[]', 'sha256:x', 'ACCEPTED', 1, 1)",
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
        assertThat(jdbc.queryForObject("SELECT mount_state FROM managed_workspace_execution_lease", String.class)).isEqualTo("FENCED");
    }

    @Test
    void lateMembershipPreventsSealingTheOriginalCut() throws Exception {
        var capture = capture();
        session("workspace-b");
        Path manifest = Files.createDirectories(bundle.resolve(".w1-recovery")).resolve("manifest.json");
        Files.writeString(manifest, manifest(capture).toString());
        ObjectNode params = object().put("manifestDigest", WorkspaceRecoveryStore.hash(Files.readAllBytes(manifest)));
        params.set("result", object().put("contentVerified", true).put("activation", false));
        assertThatThrownBy(() -> capture.call("finish", params)).hasMessageContaining("source_drift");
        assertThat(capture.inspect().path("state").asText()).isEqualTo("INVALIDATED");
        assertThat(capture.inspect().path("lastErrorCode").asText()).isEqualTo("source_drift");
    }

    private ObjectNode manifest(WorkspaceRecoveryStore capture) {
        JsonNode context = call(capture, "context");
        ObjectNode manifest = object().put("version", 1).put("provider", "local-workspace-bundle/1")
                .put("tenantId", "tenant").put("storageId", "storage").put("activation", false);
        for (String name : List.of("fenceOperationId", "mountRevision")) manifest.set(name, request.path(name));
        for (String name : List.of("registration", "sourceDigest", "sessionCount")) manifest.set(name, context.path(name));
        manifest.set("captureOperationId", request.path("operationId"));
        for (String name : List.of("sessions", "assets")) manifest.putObject(name)
                .put("path", ".w1-recovery/" + name + ".ndjson").put("byteLength", 0).put("digest", "a".repeat(64))
                .put("count", "sessions".equals(name) ? context.path("sessionCount").asLong() : call(capture, "assetPage").path("assets").size());
        return manifest;
    }

    private String session(String workspace) {
        return new TransactionTemplate(manager).execute(status -> sessions.insertWorkspaceSessionCommand("tenant", "actor", UUID.randomUUID().toString(),
                "sha256:" + "a".repeat(64), "qwen-code", null, null, List.of(), null,
                new WorkspaceSelection(workspace, ".")).sessionId());
    }

    private void head(String session) {
        jdbc.update("INSERT INTO qwen_managed_session_journal_head (tenant_id, workspace_id, session_id, storage_version,"
                + " state, writer_generation, writer_id, writer_lease_until, lease_token_hash, journal_revision,"
                + " committed_sequence, last_commit_digest, activation_epoch, compacted_through_revision, recovery_status,"
                + " created_at, updated_at) VALUES ('tenant', 'private-key', ?, 1, 'SEALED', 1, 'original',"
                + " '2000-01-01 00:00:00', ?, 1, 1, ?, 1, 0, 'READY', CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6))",
                session, "a".repeat(64), "b".repeat(64));
    }

    private WorkspaceRecoveryStore capture() {
        return store("capture");
    }

    private WorkspaceRecoveryStore store(String mode) {
        return new WorkspaceRecoveryStore(jdbc, manager, guard, null, mode, request.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static ObjectNode object() {
        return WorkspaceRecoveryStore.JSON.createObjectNode();
    }

    private static JsonNode call(WorkspaceRecoveryStore store, String method) {
        return store.call(method, object());
    }
}
