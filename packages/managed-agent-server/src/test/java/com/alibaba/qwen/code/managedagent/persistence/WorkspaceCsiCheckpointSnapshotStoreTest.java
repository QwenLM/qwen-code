package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.security.AesGcmSecretProtector;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.AbstractDataSource;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class WorkspaceCsiCheckpointSnapshotStoreTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private DataSource database;
    private JdbcTemplate jdbc;
    private SnapshotDriver source;
    private JdbcRuntimeBindingRepository bindings;
    private WorkspaceCsiCheckpointSnapshotStore store;
    private String retirementId;
    private JsonNode outcomeRef;

    @BeforeEach
    void setUp() throws Exception {
        database = database();
        ManagedSchema.initialize(database);
        jdbc = new ManagedSchemaJdbcTemplate(database);
        var protector = new AesGcmSecretProtector("test-key", new byte[32]);
        var runtimeBindings = new JdbcRuntimeBindingRepository(database, protector, () -> "binding-1");
        var manager = new DataSourceTransactionManager(database);
        var csi = new WorkspaceCsiReservationStore(jdbc, manager, JSON);
        var registration = new WorkspaceCsiRegistration("tenant", "storage", "cluster", "ns", "pvc", "pvc-uid",
                "pv", "pv-uid", "test.csi", "handle", "backend", "serial", "/workspace", 1);
        csi.register(registration);
        var scope = new RuntimeScope("tenant", "workspace", "1", "/workspace", "sha256:" + "a".repeat(64), "session");
        var runtime = runtimeBindings.findOrCreate(new RuntimeProvisionRequest(scope, "harness", "kubernetes-workspace", "storage"));
        runtime = runtimeBindings.claimOperation(runtime.getBindingId(), "owner", Duration.ofMinutes(5));
        var reservation = csi.reserve(registration, runtimeBindings, runtime, UUID.randomUUID().toString());
        var seed = runtime.getProvisionSeed();
        runtime = runtimeBindings.compareAndSet(runtime, runtime.withAttestation(new RuntimeLease(seed.getProvisionalRuntimeId(),
                URI.create("http://127.0.0.1:9"), seed.getToken(), seed.getLeaseId(), seed.getEpoch()),
                new RuntimeResourceHandle("kubernetes-workspace", 1, Map.of("fixture", "no-worker", "providerToken", "must-never-escape")), Instant.now(), Instant.now()));
        var sessions = new JdbcRuntimeSessionRepository(database);
        var acquiring = runtimeBindings.admitSession(sessions, new RuntimeSessionRecord(
                new RuntimeSession("harness", "runtime-session", "bootstrap", scope), runtime.getBindingId(), runtime.getGeneration(),
                RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
        sessions.compareAndSet(acquiring, acquiring.withState(RuntimeSessionRecord.State.READY, Instant.now()));
        JsonNode key = JSON.createObjectNode().put("tenantId", "tenant").put("workspaceId", "workspace").put("sessionId", "harness");
        ObjectNode binding = binding(key);
        JsonNode manifest = manifest();
        JsonNode manifestRef = ref("manifest", "managed-tool-result-manifest", manifest);
        ObjectNode terminal = JSON.createObjectNode().put("executionStatus", "success");
        terminal.putArray("responseParts");
        ObjectNode capture = terminal.putObject("capture").put("captureStatus", "complete").putNull("captureReason")
                .put("previewTruncated", false).put("deliveryStatus", "pending");
        capture.set("manifest", manifestRef);
        var executions = new JdbcToolExecutionRepository(database);
        var prepared = runtimeBindings.admitExecution(sessions, executions, ToolExecutionRecord.prepared("execution", "idempotency",
                runtime.getBindingId(), runtime.getGeneration(), "harness", "runtime-session", "prompt", "call", binding.path("requestDigest").asText(),
                Map.of("sessionId", "runtime-session", "promptId", "prompt", "callId", "call", "argsDigest", "sha256:" + "b".repeat(64),
                        "dispatchMode", "deferred_v3", "publicationId", "pub", "payloadDigest", binding.path("requestDigest").asText())));
        var claim = executions.claimDispatch(prepared.getExecutionCallId(), "dispatcher", Duration.ofMinutes(1));
        var authorized = runtimeBindings.authorizeDispatch(sessions, executions, claim, "dispatcher", claim.getDispatchGeneration());
        executions.compareAndSet(authorized, authorized.withResult(JSON.convertValue(terminal,
                new com.fasterxml.jackson.core.type.TypeReference<Map<String, Object>>() {}), 0, Instant.now()),
                "dispatcher", authorized.getDispatchGeneration());
        retirementId = UUID.randomUUID().toString();
        csi.beginRetirement(registration, runtimeBindings, runtimeBindings.findById(runtime.getBindingId()), reservation, retirementId);
        ObjectNode outcome = JSON.createObjectNode().put("schemaVersion", 1).put("decision", "committed");
        outcome.set("envelope", terminal);
        outcome.set("manifestRef", manifestRef);
        outcome.putObject("history").put("messageId", UUID.randomUUID().toString()).put("timestamp", "2026-10-03T00:00:00Z")
                .put("model", "fixture").putArray("parts");
        outcomeRef = ref("outcome", "managed-tool-outcome", outcome);
        // SQL mapping fixture only; native journal semantics are tested separately by the TS consumer.
        byte[] records = "{}\n".getBytes(StandardCharsets.UTF_8);
        jdbc.update("INSERT INTO ma_session_head (tenant_key, harness_key, head_kind, harness_session_id, tenant_id, workspace_id, session_id, storage_version, state, writer_generation, journal_revision, committed_sequence, last_commit_digest, activation_epoch, latest_checkpoint_resource_id, compacted_through_revision, recovery_status, gmt_create, gmt_modified) VALUES (?, ?, 'MANAGED_SESSION', 'harness', 'tenant', 'workspace', 'harness', 1, 'SEALED', 1, 1, 1, ?, 1, 'checkpoint', 0, 'READY', " + ManagedSchemaTime.SQL_NOW + ", " + ManagedSchemaTime.SQL_NOW + ")",
                WorkspaceOperations.hash("tenant"), WorkspaceOperations.hash("harness"), "c".repeat(64));
        jdbc.update("INSERT INTO ma_session_journal_tx (tenant_id, workspace_id, session_id, journal_revision, command_key_hash, transaction_id, operation, command_id, content_digest, first_sequence, last_sequence, event_count, events_digest, commit_digest, writer_generation, writer_id, writer_token_hash, activation_epoch, latest_checkpoint_resource_id, record_encoding, record_bytes, byte_length, record_digest, gmt_create) VALUES ('tenant', 'workspace', 'harness', 1, ?, 'transaction', 'recordToolResult', 'execution', ?, 1, 1, 1, ?, ?, 1, 'writer', ?, 1, 'checkpoint', 'identity', ?, ?, ?, " + ManagedSchemaTime.SQL_NOW + ")",
                "d".repeat(64), outcomeRef.path("digest").asText(), "e".repeat(64), "c".repeat(64), "f".repeat(64), records, records.length, hash(records));
        resource("checkpoint", "managed-checkpoint", JSON.createObjectNode());
        resource("outcome", "managed-tool-outcome", outcome);
        resource("manifest", "managed-tool-result-manifest", manifest);
        String publicationScope = ToolPublicationDataStore.scope(key);
        jdbc.update("INSERT INTO ma_output_capture (scope_key, tenant_key, tenant_id, workspace_id, session_id, publication_id,"
                        + " execution_key, capture_id, binding_json, binding_digest, token_hash, state, capture_bytes, producer_bytes,"
                        + " admission_bytes, producer_phase, terminal_resource_id, admission_resource_id, receipt_sequence, receipt_revision)"
                        + " VALUES (?, ?, 'tenant', 'workspace', 'harness', 'pub', ?, 'capture', ?, ?, ?, 'FENCED', 0, 0, 0,"
                        + " 'REFERENCED', 'terminal', 'outcome', 1, 1)",
                publicationScope, "a".repeat(64), hash("execution".getBytes(StandardCharsets.UTF_8)), binding.toString(),
                ToolPublicationContract.bindingDigest(binding), "b".repeat(64));
        publicationObject(publicationScope, "terminal", "terminal", "managed-tool-terminal", terminal);
        publicationObject(publicationScope, "admission", "outcome", "managed-tool-outcome", outcome);
        publicationObject(publicationScope, "manifest:1", "manifest", "managed-tool-result-manifest", manifest);
        source = new SnapshotDriver(database);
        bindings = new JdbcRuntimeBindingRepository(source, protector);
        store = new WorkspaceCsiCheckpointSnapshotStore(source, bindings, JSON);
    }

    DataSource database() {
        return new DriverManagerDataSource("jdbc:h2:mem:snapshot-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
    }

    @Test
    void mapsOriginalInlineRowsWithoutWritesOrCredentials() {
        JsonNode resourcesBefore = JSON.valueToTree(jdbc.queryForList("SELECT " + ManagedSchemaProjection.RESOURCE.columns() + " FROM ma_resource"));
        var holderBefore = jdbc.queryForMap("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner");
        JsonNode snapshot = export();
        assertThat(snapshot.path("format").asText()).isEqualTo(WorkspaceCsiCheckpointSnapshotStore.FORMAT);
        assertThat(snapshot.path("originalCSI").path("runtimeGeneration").asText()).isEqualTo("1");
        assertThat(snapshot.path("original").path("outcomeRef")).isEqualTo(outcomeRef);
        assertThat(snapshot.path("head").path("state").asText()).isEqualTo("SEALED");
        assertThat(snapshot.path("resources")).hasSize(3);
        assertThat(snapshot.toString()).doesNotContain("token", "ciphertext", "credential", "must-never-escape", "providerToken");
        assertThat(snapshot.path("originalCSI").path("resourceHandleDigest").asText()).matches("[a-f0-9]{64}");
        assertThat(snapshot.path("originalCSI").has("resourceHandleJson")).isFalse();
        assertThat(snapshot.path("originalCSI").path("pvcUid").asText()).isEqualTo("pvc-uid");
        assertThat(source.starts).isEqualTo(1);
        assertThat(source.connections).isEqualTo(1);
        assertThat(source.closes).isEqualTo(1);
        assertThat(source.rollbacks).isEqualTo(1);
        assertThat(source.statements).allMatch(sql -> sql.startsWith("SELECT"));
        assertThat((JsonNode) JSON.valueToTree(jdbc.queryForList("SELECT " + ManagedSchemaProjection.RESOURCE.columns() + " FROM ma_resource")))
                .isEqualTo(resourcesBefore);
        assertThat(jdbc.queryForMap("SELECT " + ManagedSchemaProjection.STORAGE_OWNER.columns() + " FROM ma_storage_owner")).isEqualTo(holderBefore);
    }

    @ParameterizedTest
    @ValueSource(strings = {
        "UPDATE ma_runtime_slot SET active_binding_id = NULL",
        "UPDATE ma_runtime_binding SET binding_state = 'READY'",
        "UPDATE ma_runtime_binding SET runtime_credential_ciphertext = 'corrupt'",
        "UPDATE ma_storage_owner SET csi_reservation_id = '00000000-0000-0000-0000-000000000000'",
        "UPDATE ma_storage_owner SET csi_registration_revision = 2",
        "UPDATE ma_storage SET physical_key = 'bad'",
        "UPDATE ma_storage SET registration_revision = 9007199254740991",
        "UPDATE ma_storage SET registration_json = '{}'",
        "UPDATE ma_operation SET result_json = '{\"schemaVersion\":1,\"data\":{\"identity_json\":\"{}\"}}'",
        "UPDATE ma_tool_execution SET authorized_binding_version = NULL",
        "UPDATE ma_tool_execution SET authorized_dispatch_generation = 999",
        "UPDATE ma_tool_execution SET result_json = '{}'",
        "UPDATE ma_tool_execution SET reference_json = REPLACE(reference_json, 'payloadDigest', 'wrongDigest')",
        "UPDATE ma_tool_execution SET reference_json = '{}'",
        "UPDATE ma_runtime_session SET binding_id = 'different'",
        "UPDATE ma_output_capture SET quarantined = TRUE",
        "UPDATE ma_output_capture SET producer_phase = 'FINISHED'",
        "UPDATE ma_output_capture SET binding_digest = 'bad'",
        "UPDATE ma_output_capture SET receipt_revision = 2",
        "UPDATE ma_session_head SET workspace_id = X'646966666572656e74'",
        "UPDATE ma_session_head SET journal_revision = 2",
        "UPDATE ma_session_head SET writer_generation = 9007199254740991",
        "UPDATE ma_session_head SET compacted_through_revision = 1",
        "UPDATE ma_session_head SET activation_epoch = 2",
        "UPDATE ma_session_journal_tx SET record_digest = 'bad'",
        "UPDATE ma_resource SET storage_kind = 'TOOL_PUBLICATION' WHERE resource_id = X'6f7574636f6d65'",
        "UPDATE ma_resource SET inline_bytes = X'00' WHERE resource_id = X'6f7574636f6d65'",
        "DELETE FROM ma_resource_ref WHERE resource_id = X'6f7574636f6d65'",
        "UPDATE ma_resource SET kind = 'managed-checkpoint' WHERE resource_id = X'6f7574636f6d65'",
        "UPDATE ma_resource_ref SET journal_revision = 2 WHERE resource_id = X'6f7574636f6d65'",
        "UPDATE ma_resource SET deletion_operation_key = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE slot_key = X'61646d697373696f6e'",
        "UPDATE ma_resource SET inline_bytes = X'00' WHERE slot_key = X'7465726d696e616c'"
    })
    void refusesBrokenOriginalPinsWithoutMutation(String damage) {
        jdbc.update(damage);
        JsonNode resourcesBefore = JSON.valueToTree(jdbc.queryForList("SELECT " + ManagedSchemaProjection.RESOURCE.columns() + " FROM ma_resource"));
        assertThatThrownBy(this::export).isInstanceOf(IllegalStateException.class)
                .hasMessage("Original CSI checkpoint snapshot is unavailable.").hasNoCause();
        assertThat(source.statements).allMatch(sql -> sql.startsWith("SELECT"));
        assertThat(source.rollbacks).isEqualTo(1);
        assertThat((JsonNode) JSON.valueToTree(jdbc.queryForList("SELECT " + ManagedSchemaProjection.RESOURCE.columns() + " FROM ma_resource")))
                .isEqualTo(resourcesBefore);
    }

    @Test
    void verifiedInlineReceiptCanRetainItsOriginalPhysicalPointer() {
        jdbc.update("UPDATE ma_resource SET capture_object_key = ? WHERE slot_key = ?", "original-physical-object", "admission");
        assertThat(export().path("original").path("outcomeRef")).isEqualTo(outcomeRef);
        assertThat(jdbc.queryForObject("SELECT capture_object_key FROM ma_resource WHERE slot_key = ?", String.class, "admission"))
                .isEqualTo("original-physical-object");
    }

    @ParameterizedTest
    @ValueSource(strings = {"registrationRevision", "sealedBindingVersion", "epoch"})
    void refusesFractionalTypedJsonIdentityWithoutTruncation(String identity) {
        boolean registration = "registrationRevision".equals(identity);
        String table = registration ? "ma_storage" : "ma_operation";
        String column = registration ? "registration_json" : "identity_json";
        String field = registration ? "revision" : identity;
        String original = registration ? jdbc.queryForObject("SELECT registration_json FROM ma_storage", String.class) : retirementIdentity();
        var match = java.util.regex.Pattern.compile("\"" + field + "\"\\s*:\\s*([0-9]+)(?=\\s*[,}])").matcher(original);
        assertThat(match.find()).isTrue();
        String fractional = original.substring(0, match.start(1)) + match.group(1) + ".5" + original.substring(match.end(1));
        if (registration) {
            jdbc.update("UPDATE ma_storage SET registration_json = ?", fractional);
        } else {
            saveRetirementIdentity(fractional);
        }
        assertThatThrownBy(this::export).isInstanceOf(IllegalStateException.class)
                .hasMessage("Original CSI checkpoint snapshot is unavailable.").hasNoCause();
        assertThat(source.starts).isEqualTo(1);
        assertThat(source.rollbacks).isEqualTo(1);
        assertThat(source.statements).allMatch(sql -> sql.startsWith("SELECT") && !sql.contains("FOR UPDATE"));
        assertThat(registration ? jdbc.queryForObject("SELECT registration_json FROM ma_storage", String.class) : retirementIdentity()).isEqualTo(fractional);
    }

    @Test
    void refusesAmbientTransactionAndDifferentScopeBeforeStartingSnapshot() {
        var transaction = new TransactionTemplate(new DataSourceTransactionManager(database));
        assertThatThrownBy(() -> transaction.execute(status -> export())).isInstanceOf(IllegalStateException.class);
        assertThat(source.starts).isZero();
        assertThatThrownBy(() -> store.exportOriginalPublication(retirementId, "tenant", "workspace", "another", "pub"))
                .isInstanceOf(IllegalStateException.class);
    }

    @Test
    void refusesUnqualifiedDriverAndNonInnoDbTable() {
        source.product = "PostgreSQL";
        assertThatThrownBy(this::export).isInstanceOf(IllegalStateException.class);
        assertThat(source.starts).isZero();
        source.product = "MySQL";
        source.engine = "MyISAM";
        assertThatThrownBy(this::export).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void readOnlyBindingHelperRequiresOriginalConnectionMode() throws Exception {
        try (var connection = source.getConnection()) {
            assertThatThrownBy(() -> bindings.findByIdInReadOnlySnapshot(connection, "binding-1"))
                    .isInstanceOf(IllegalArgumentException.class);
            connection.setAutoCommit(false);
            assertThatThrownBy(() -> bindings.findByIdInReadOnlySnapshot(connection, "binding-1"))
                    .isInstanceOf(IllegalArgumentException.class);
            connection.setReadOnly(true);
            connection.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
            assertThat(bindings.findByIdInReadOnlySnapshot(connection, "binding-1").getState())
                    .isEqualTo(RuntimeBindingRecord.State.DRAINING);
            connection.rollback();
        }
    }

    @ParameterizedTest
    @ValueSource(strings = {"inline", "transaction", "rows", "total"})
    void refusesFixedCapacityOverflow(String limit) {
        if ("inline".equals(limit)) {
            byte[] bytes = new byte[ManagedSessionStoreModels.MAX_INLINE_RESOURCE_BYTES + 1];
            jdbc.update("UPDATE ma_resource SET inline_bytes = ?, byte_length = ?, sha256 = ?"
                    + " WHERE resource_id = X'636865636b706f696e74'", bytes, bytes.length, hash(bytes));
        } else {
            if ("transaction".equals(limit) || "total".equals(limit)) {
                byte[] bytes = new byte[ManagedSessionStoreModels.MAX_TRANSACTION_BYTES + ("transaction".equals(limit) ? 1 : 0)];
                jdbc.update("UPDATE ma_session_journal_tx SET record_bytes = ?, byte_length = ?, record_digest = ?",
                        bytes, bytes.length, hash(bytes));
            }
            if ("rows".equals(limit) || "total".equals(limit)) {
                int count = "rows".equals(limit) ? 4097 : 17;
                List<Object[]> rows = new ArrayList<>();
                for (int revision = 2; revision <= count; revision++) {
                    rows.add(new Object[]{revision, String.format("%064d", revision), "transaction-" + revision,
                            "execution-" + revision, revision, revision});
                }
                jdbc.batchUpdate("INSERT INTO ma_session_journal_tx (tenant_id, workspace_id, session_id, journal_revision,"
                        + " command_key_hash, transaction_id, operation, command_id, content_digest, first_sequence, last_sequence,"
                        + " event_count, events_digest, previous_commit_digest, commit_digest, writer_generation, writer_id, writer_token_hash, activation_epoch,"
                        + " latest_checkpoint_resource_id, record_encoding, record_bytes, byte_length, record_digest, gmt_create)"
                        + " SELECT t.tenant_id, t.workspace_id, t.session_id, ?, ?,"
                        + " ?, t.operation, ?, t.content_digest, ?, ?,"
                        + " t.event_count, t.events_digest, t.commit_digest, t.commit_digest, t.writer_generation, t.writer_id, t.writer_token_hash,"
                        + " t.activation_epoch, t.latest_checkpoint_resource_id, t.record_encoding, t.record_bytes,"
                        + " t.byte_length, t.record_digest, t.gmt_create FROM ma_session_journal_tx t"
                        + " WHERE t.journal_revision = 1", rows);
                jdbc.update("UPDATE ma_session_head SET journal_revision = ?, committed_sequence = ?", count, count);
            }
        }
        assertThatThrownBy(this::export).isInstanceOf(IllegalStateException.class)
                .hasMessage("Original CSI checkpoint snapshot is unavailable.").hasNoCause();
        assertThat(source.rollbacks).isEqualTo(1);
        assertThat(source.statements).allMatch(sql -> sql.startsWith("SELECT"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"0.5/0.50000000000000000001", "0.50000000000000000001/0.5"})
    void refusesNumericResultsWithLostDoublePrecision(String scores) {
        String[] values = scores.split("/");
        numericResults(values[0], values[1]);
        assertThatThrownBy(this::export).isInstanceOf(IllegalStateException.class)
                .hasMessage("Original CSI checkpoint snapshot is unavailable.").hasNoCause();
    }

    @ParameterizedTest
    @ValueSource(strings = {"1/1.0", "1.0/1", "-0/0", "0/-0", "0.5/0.50"})
    void acceptsNumericallyIdenticalOriginalResults(String scores) {
        String[] values = scores.split("/");
        numericResults(values[0], values[1]);
        assertThat(export().path("original").path("publicationId").asText()).isEqualTo("pub");
    }

    private void numericResults(String terminalScore, String executionScore) {
        byte[] terminal = jdbc.queryForObject("SELECT inline_bytes FROM ma_resource WHERE slot_key = X'7465726d696e616c'", byte[].class);
        String changed = new String(terminal, StandardCharsets.UTF_8).replace("\"responseParts\":[]",
                "\"responseParts\":[{\"score\":" + terminalScore + "}]");
        byte[] bytes = changed.getBytes(StandardCharsets.UTF_8);
        jdbc.update("UPDATE ma_tool_execution SET result_json = ?", changed.replace("\"score\":" + terminalScore, "\"score\":" + executionScore));
        jdbc.update("UPDATE ma_resource SET inline_bytes = ?, byte_length = ?, sha256 = ? WHERE slot_key = X'7465726d696e616c'",
                bytes, bytes.length, hash(bytes));
        byte[] outcome = jdbc.queryForObject("SELECT inline_bytes FROM ma_resource WHERE slot_key = X'61646d697373696f6e'", byte[].class);
        byte[] changedOutcome = new String(outcome, StandardCharsets.UTF_8).replace(new String(terminal, StandardCharsets.UTF_8), changed)
                .getBytes(StandardCharsets.UTF_8);
        jdbc.update("UPDATE ma_resource SET inline_bytes = ?, byte_length = ?, sha256 = ? WHERE slot_key = X'61646d697373696f6e'",
                changedOutcome, changedOutcome.length, hash(changedOutcome));
        jdbc.update("UPDATE ma_resource SET inline_bytes = ?, byte_length = ?, sha256 = ? WHERE resource_id = X'6f7574636f6d65'",
                changedOutcome, changedOutcome.length, hash(changedOutcome));
        jdbc.update("UPDATE ma_session_journal_tx SET content_digest = ?", hash(changedOutcome));
    }

    private JsonNode export() {
        return store.exportOriginalPublication(retirementId, "tenant", "workspace", "harness", "pub");
    }

    private static ObjectNode binding(JsonNode key) {
        ObjectNode value = JSON.createObjectNode().put("publication", ToolPublicationContract.PROTOCOL).put("publicationId", "pub")
                .put("turnId", "turn").put("executionCallId", "execution").put("modelCallId", "model").put("runtimeBindingId", "binding-1")
                .put("bindingGeneration", "1").put("captureId", "capture").put("revision", 1).put("captureScope", "process_pipes")
                .put("capturePolicy", "complete_required").put("requestDigest", "sha256:" + "a".repeat(64))
                .put("writerId", "writer").put("writerGeneration", 1).put("activationId", "activation").put("activationEpoch", 1).put("intentSequence", 1);
        value.set("sessionKey", key);
        value.putObject("reference").put("sessionId", "runtime-session").put("promptId", "prompt").put("callId", "call")
                .put("argsDigest", "sha256:" + "b".repeat(64));
        value.set("argsRef", ref("args", "managed-tool-input", JSON.createObjectNode()));
        value.set("checkpointRef", ref("checkpoint", "managed-checkpoint", JSON.createObjectNode()));
        return value;
    }

    private static JsonNode manifest() {
        ObjectNode value = JSON.createObjectNode().put("toolResult", "managed-tool-result/1").put("type", "manifest").put("tenantId", "tenant")
                .put("sessionId", "harness").put("turnId", "turn").put("executionCallId", "execution").put("callId", "call")
                .put("invocationDigest", "sha256:" + "b".repeat(64)).put("bindingGeneration", "1").put("captureId", "capture")
                .put("revision", 1).put("executionStatus", "success").put("exitCode", 0).putNull("signal").put("captureScope", "process_pipes")
                .put("capturePolicy", "complete_required").put("captureStatus", "complete").putNull("captureReason").put("upstreamTruncated", false);
        var contents = value.putArray("contents");
        for (String stream : List.of("stdout", "stderr")) {
            var content = contents.addObject().put("streamId", stream).put("role", stream).put("mimeType", "application/octet-stream")
                    .put("state", "sealed").put("byteLength", 0).put("digest", hash(new byte[0]));
            content.putArray("missingRanges");
            content.putObject("body").putArray("pages");
        }
        return value;
    }

    private void resource(String id, String kind, JsonNode body) {
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        String scope = ManagedSessionStore.sessionScopeKey("tenant", "harness");
        String resource = ManagedSessionStore.resourceKey(scope, id);
        jdbc.update("INSERT INTO ma_resource (resource_key, session_scope_key, tenant_id, workspace_id, session_id, resource_id, kind, schema_version, byte_length, sha256, storage_kind, inline_bytes, publish_command_id, state, gmt_create) VALUES (?, ?, 'tenant', 'workspace', 'harness', ?, ?, 1, ?, ?, 'MYSQL_INLINE', ?, 'fixture', 'REFERENCED', " + ManagedSchemaTime.SQL_NOW + ")",
                resource, scope, id, kind, bytes.length, hash(bytes), bytes);
        jdbc.update("INSERT INTO ma_resource_ref (session_scope_key, owner_kind, owner_key, owner_revision, resource_key, tenant_id, workspace_id, session_id, journal_revision, resource_id, gmt_create) VALUES (?, 'JOURNAL', ?, 1, ?, 'tenant', 'workspace', 'harness', 1, ?, " + ManagedSchemaTime.SQL_NOW + ")", scope, scope, resource, id);
    }

    private void publicationObject(String scope, String slot, String id, String kind, JsonNode body) {
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        String sessionScope = ManagedSessionStore.sessionScopeKey("tenant", "harness");
        String resource = ManagedSessionStore.resourceKey(sessionScope, id);
        if (jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource WHERE resource_key = ?", Integer.class, resource) == 0) {
            resource(id, kind, body);
            jdbc.update("DELETE FROM ma_resource_ref WHERE resource_key = ?", resource);
        }
        jdbc.update("UPDATE ma_resource SET scope_key = ?, publication_id = 'pub', slot_key = ?, capture_state = 'VERIFIED', operation_id = X'66697874757265'"
                + " WHERE resource_key = ?", scope, slot, resource);
    }

    private String retirementIdentity() {
        return (String) new WorkspaceOperations(jdbc, "tenant").find(WorkspaceOperations.Kind.CSI_RETIREMENT, retirementId, false).get("identity_json");
    }

    private void saveRetirementIdentity(String value) {
        new TransactionTemplate(new DataSourceTransactionManager(database)).executeWithoutResult(ignored ->
                new WorkspaceOperations(jdbc, "tenant").update(WorkspaceOperations.Kind.CSI_RETIREMENT, retirementId,
                        WorkspaceOperations.values("identity_json", value)));
    }

    private static JsonNode ref(String id, String kind, JsonNode body) {
        byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
        return JSON.createObjectNode().put("resourceId", id).put("kind", kind).put("schemaVersion", 1)
                .put("byteLength", bytes.length).put("digest", hash(bytes));
    }

    private static String hash(byte[] bytes) {
        return ToolPublicationContract.sha256(bytes);
    }

    /** H2 maps rows only; this adapter does not qualify MySQL transaction semantics. */
    private static final class SnapshotDriver extends AbstractDataSource {
        private final DataSource database;
        private final List<String> statements = new ArrayList<>();
        private String engine = "InnoDB";
        private String product = "MySQL";
        private int starts;
        private int rollbacks;
        private int connections;
        private int closes;

        private SnapshotDriver(DataSource database) {
            this.database = database;
        }

        @Override
        public Connection getConnection() throws SQLException {
            Connection connection = database.getConnection();
            connections++;
            boolean[] readOnly = {false};
            return (Connection) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{Connection.class}, (proxy, method, args) -> {
                if ("isReadOnly".equals(method.getName())) {
                    return readOnly[0];
                }
                if ("setReadOnly".equals(method.getName())) {
                    readOnly[0] = (Boolean) args[0];
                    return null;
                }
                if ("getMetaData".equals(method.getName())) {
                    var metadata = connection.getMetaData();
                    return Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{java.sql.DatabaseMetaData.class},
                            (ignored, metaMethod, metaArgs) -> "getDatabaseProductName".equals(metaMethod.getName()) ? product
                                    : invoke(metadata, metaMethod, metaArgs));
                }
                if ("createStatement".equals(method.getName())) {
                    var statement = connection.createStatement();
                    return Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[]{java.sql.Statement.class}, (ignored, call, parameters) -> {
                        if ("execute".equals(call.getName())) {
                            assertThat(parameters[0]).isEqualTo("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
                            assertThat(connection.getTransactionIsolation()).isEqualTo(Connection.TRANSACTION_REPEATABLE_READ);
                            assertThat(readOnly[0]).isTrue();
                            assertThat(connection.getAutoCommit()).isFalse();
                            starts++;
                            return false;
                        }
                        return invoke(statement, call, parameters);
                    });
                }
                if ("prepareStatement".equals(method.getName())) {
                    String sql = (String) args[0];
                    statements.add(sql);
                    assertThat(sql).startsWith("SELECT").doesNotContain("FOR UPDATE");
                    if (sql.contains("information_schema.tables")) {
                        boolean h2 = "H2".equals(connection.getMetaData().getDatabaseProductName());
                        if (h2 || !"InnoDB".equals(engine)) {
                            sql = sql.replace("table_name, engine", "table_name, '" + engine + "' AS engine");
                        }
                        return connection.prepareStatement(h2 ? sql.replace("table_schema = DATABASE()", "table_schema = 'public'") : sql);
                    }
                }
                if ("close".equals(method.getName())) {
                    closes++;
                }
                if ("rollback".equals(method.getName())) {
                    rollbacks++;
                }
                return invoke(connection, method, args);
            });
        }

        @Override
        public Connection getConnection(String username, String password) throws SQLException {
            return getConnection();
        }

        private static Object invoke(Object target, java.lang.reflect.Method method, Object[] args) throws Throwable {
            try {
                return method.invoke(target, args);
            } catch (InvocationTargetException error) {
                throw error.getCause();
            }
        }
    }
}
