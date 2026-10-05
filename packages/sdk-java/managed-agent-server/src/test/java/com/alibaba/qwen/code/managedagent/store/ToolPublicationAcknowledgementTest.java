package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
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
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

class ToolPublicationAcknowledgementTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String WRITER_TOKEN = "a".repeat(32);
    private static final String PRODUCER_TOKEN = Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[32]);
    private JdbcTemplate jdbc;
    private DataSourceTransactionManager manager;
    private ManagedSessionStore sessions;
    private JdbcRuntimeBindingRepository bindings;
    private JdbcRuntimeSessionRepository runtimeSessions;
    private JdbcToolExecutionRepository executions;
    private ToolPublicationStore grants;
    private ToolPublicationDataStore data;
    private ToolPublicationAdmissionStore admissions;
    private WorkspaceCsiReservationStore csi;
    private WorkspaceCsiRegistration registration;
    private WorkspaceCsiReservationStore.Reservation reservation;
    private RuntimeBindingRecord runtime;
    private RuntimeSessionRecord runtimeSession;
    private ToolExecutionRecord execution;
    private ObjectNode binding;
    private long revision;
    private long sequence;
    private String commitDigest;
    private int objectReads;
    private String retirementId;
    private Runnable duringObjectRead = () -> {};

    @BeforeEach
    void prepareOriginalPublicApiAuthority() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:ack-authority-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE;LOCK_TIMEOUT=10000");
        Flyway.configure().dataSource(source).load().migrate();
        jdbc = new JdbcTemplate(source);
        manager = new DataSourceTransactionManager(source);
        sessions = new ManagedSessionStore(jdbc);
        bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("fixture", new byte[32]));
        runtimeSessions = new JdbcRuntimeSessionRepository(source);
        executions = new JdbcToolExecutionRepository(source);
        csi = new WorkspaceCsiReservationStore(jdbc, manager, JSON);
        registration = WorkspaceCsiReservationStoreTest.registration("tenant-1", "storage", "backend", "handle", 1);
        csi.register(registration);
        var scope = new RuntimeScope("tenant-1", "workspace-1", "1", "/workspace", "sha256:" + "a".repeat(64), "workspace");
        runtime = bindings.claimOperation(bindings.findOrCreate(new RuntimeProvisionRequest(scope, null,
                "kubernetes-workspace", registration.storageId())).getBindingId(), "fixture", Duration.ofMinutes(5));
        reservation = csi.reserve(registration, bindings, runtime, UUID.randomUUID().toString());
        var seed = runtime.getProvisionSeed();
        var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:9"),
                seed.getToken(), seed.getLeaseId(), seed.getEpoch());
        // This component fixture qualifies SQL authorities, not trusted Pod provenance or a durable ACK.
        runtime = bindings.compareAndSet(runtime, runtime.withAttestation(lease,
                new RuntimeResourceHandle("kubernetes-workspace", 1, Map.of("fixture", "sql-only")), Instant.now(), Instant.now()));
        var acquiring = bindings.admitSession(runtimeSessions, new RuntimeSessionRecord(new RuntimeSession(
                "session-1", "runtime-1", "bootstrap", scope), runtime.getBindingId(), runtime.getGeneration(),
                RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
        runtimeSession = runtimeSessions.compareAndSet(acquiring, acquiring.withState(RuntimeSessionRecord.State.READY, Instant.now()));
        grants = new ToolPublicationStore(jdbc, manager, sessions, executions, bindings,
                new ToolPublicationStore.Capacity(2048, 16 * 1024 * 1024, 16 * 1024 * 1024, 10));
        var objects = new HashMap<String, byte[]>();
        ToolPublicationObjectStore bucket = new ToolPublicationObjectStore() {
            public void putIfAbsent(String key, byte[] value) {
                assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
                objects.putIfAbsent(key, value.clone());
            }
            public InputStream open(String key) {
                assertThat(TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
                objectReads++;
                duringObjectRead.run();
                return new ByteArrayInputStream(objects.get(key));
            }
            public void requireUnversioned() { }
        };
        sessions.setPublicationObjects(bucket);
        data = new ToolPublicationDataStore(jdbc, manager, grants, sessions, bucket,
                Duration.ofMinutes(2), Duration.ofSeconds(30),
                new ToolPublicationDataStore.VerificationBudget(16 * 1024 * 1024, Duration.ofMinutes(25)));
        admissions = new ToolPublicationAdmissionStore(jdbc, manager, sessions, data);
        binding = JSON.createObjectNode().put("publication", ToolPublicationContract.PROTOCOL).put("publicationId", "pub-1")
                .put("turnId", "harness-turn").put("executionCallId", "execution-1").put("modelCallId", "model-1")
                .put("runtimeBindingId", runtime.getBindingId()).put("bindingGeneration", Long.toString(runtime.getGeneration()))
                .put("captureId", "capture-1").put("revision", 1).put("captureScope", "process_pipes")
                .put("capturePolicy", "complete_required").put("writerId", "writer-1").put("writerGeneration", 1)
                .put("activationId", "activation-1").put("activationEpoch", 1).put("intentSequence", 2);
        binding.set("sessionKey", JSON.createObjectNode().put("tenantId", "tenant-1").put("workspaceId", "workspace-1").put("sessionId", "session-1"));
        String payload = "{\"toolName\":\"run_shell_command\",\"input\":{\"command\":\"printf abc\"}}";
        binding.put("requestDigest", "sha256:" + digest(payload.getBytes(StandardCharsets.UTF_8)));
        binding.set("reference", JSON.createObjectNode().put("sessionId", "runtime-1").put("promptId", "runtime-prompt")
                .put("callId", "call-1").put("argsDigest", "sha256:" + digest("{\"command\":\"printf abc\"}".getBytes(StandardCharsets.UTF_8))));
        ObjectNode args = JSON.createObjectNode().put("harnessSessionId", "session-1").put("runtimeSessionId", "runtime-1").put("payloadJson", payload);
        binding.set("argsRef", ref("args-1", "managed-tool-input", args));
        ObjectNode checkpoint = JSON.createObjectNode();
        checkpoint.set("identity", JSON.createObjectNode().put("schemaVersion", 1).put("engine", "managed")
                .put("turnId", "harness-turn").put("promptId", "runtime-prompt").put("activationId", "activation-1")
                .put("coveredSequence", 2).set("sessionKey", key()));
        checkpoint.set("continuation", JSON.createObjectNode().put("phase", "await_runtime"));
        checkpoint.set("tools", JSON.createObjectNode().set("items", JSON.createArrayNode().add(JSON.createObjectNode()
                .put("executionCallId", "execution-1").put("functionCallId", "model-1").put("toolName", "run_shell_command")
                .put("state", "in_progress").put("outcomeSource", "runtime")
                .put("inputDigest", binding.path("reference").path("argsDigest").asText().substring(7)))));
        binding.set("checkpointRef", ref("checkpoint-1", "managed-checkpoint", checkpoint));
        var reference = new HashMap<String, Object>();
        for (String field : List.of("sessionId", "promptId", "callId", "argsDigest")) reference.put(field, binding.path("reference").path(field).asText());
        reference.put("dispatchMode", "deferred_v3");
        reference.put("publicationId", "pub-1");
        reference.put("payloadDigest", binding.path("requestDigest").asText());
        execution = bindings.admitExecution(runtimeSessions, executions, ToolExecutionRecord.prepared("execution-1", "idempotency-1",
                runtime.getBindingId(), runtime.getGeneration(), "session-1", "runtime-1", "runtime-prompt", "call-1",
                binding.path("requestDigest").asText(), reference));
        tx().executeWithoutResult(status -> sessions.acquireWriter("tenant-1", "session-1", WRITER_TOKEN,
                new ManagedSessionStoreModels.AcquireWriterRequest("workspace-1", "writer-1", 300000L)));
        append("session.create", "{}\n{}\n", 0, List.of(), null);
        ObjectNode activation = JSON.createObjectNode().put("activationId", "activation-1").put("epoch", 1).put("phase", "active")
                .put("expiresAt", System.currentTimeMillis() + 300000);
        ObjectNode intent = JSON.createObjectNode().put("executionCallId", "execution-1").put("outcomeSource", "runtime");
        intent.set("argsRef", binding.path("argsRef"));
        append("tool.dispatch", event(1, "activation.changed", activation) + event(2, "tool.intent", intent) + "{}\n", 2,
                List.of(resource(binding.path("argsRef"), args), resource(binding.path("checkpointRef"), checkpoint)), "checkpoint-1");
        ObjectNode reserve = JSON.createObjectNode().put("publication", ToolPublicationContract.PROTOCOL).put("operation", "reserve").put("captureBytes", 1024);
        reserve.set("sessionKey", key());
        reserve.set("owner", JSON.createObjectNode().put("writerId", "writer-1").put("writerGeneration", 1));
        reserve.set("binding", binding);
        grants.apply(reserve, WRITER_TOKEN, PRODUCER_TOKEN);
        var claim = executions.claimDispatch("execution-1", "dispatcher", Duration.ofMinutes(3));
        execution = bindings.authorizeDispatch(runtimeSessions, executions, claim, "dispatcher", claim.getDispatchGeneration());
        retirementId = UUID.randomUUID().toString();
        csi.beginRetirement(registration, bindings, runtime, reservation, retirementId);
        finishAndCommitOriginalReceipt();
    }

    @Test
    void immutableBundleRevalidatesActualAuthorityWithoutObjectIoInsideFinalTransaction() {
        var bundle = admissions.verifyOriginalAcknowledgement(execution);
        assertThat(objectReads).isPositive();
        assertThat(bundle.captureIdentity().path("sessionId").asText()).isEqualTo("session-1");
        assertThat(bundle.captureIdentity().path("turnId").asText()).isEqualTo("harness-turn");
        assertThat(bundle.finished().path("binding").path("reference").path("promptId").asText()).isEqualTo("runtime-prompt");
        ((ObjectNode) bundle.finished().path("result")).put("executionStatus", "not_started");
        ((ObjectNode) bundle.receipt()).put("historyRevision", 999);
        int reads = objectReads;
        ToolExecutionRecord actual = tx().execute(status -> admissions.lockOriginalAcknowledgement(bundle));
        assertThat(actual.getExecutionCallId()).isEqualTo(execution.getExecutionCallId());
        assertThat(actual.getState()).isEqualTo(ToolExecutionRecord.State.SETTLED);
        assertThat(objectReads).isEqualTo(reads);
        assertThat(bundle.receipt().path("historyRevision").longValue()).isEqualTo(sequence);
        assertThat(csi.inspect(registration).phase()).isEqualTo("DRAINING");
    }

    @Test
    void ambientAndMismatchedManagersRefuseBeforeResourceIo() {
        int reads = objectReads;
        assertThatThrownBy(() -> tx().execute(status -> admissions.verifyOriginalAcknowledgement(execution))).isInstanceOf(IllegalArgumentException.class);
        assertThat(objectReads).isEqualTo(reads);
        var other = new JdbcDataSource();
        other.setURL("jdbc:h2:mem:other-" + UUID.randomUUID());
        var wrong = new ToolPublicationAdmissionStore(jdbc, new DataSourceTransactionManager(other), sessions, data);
        assertThat(wrong.usesDataSource(jdbc.getDataSource())).isFalse();
        assertThatThrownBy(() -> wrong.verifyOriginalAcknowledgement(execution)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> admissions.lockOriginalAcknowledgement(admissions.verifyOriginalAcknowledgement(execution)))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @ParameterizedTest
    @ValueSource(strings = {"quarantine", "object", "seal", "reference", "receipt", "marker", "journal"})
    void lateAuthorityChangesRefuse(String damage) {
        var bundle = admissions.verifyOriginalAcknowledgement(execution);
        switch (damage) {
            case "quarantine" -> jdbc.update("UPDATE qwen_tool_publication SET quarantined = TRUE");
            case "object" -> jdbc.update("UPDATE qwen_tool_publication_object SET state = 'QUARANTINED' WHERE slot_key = 'manifest:1'");
            case "seal" -> jdbc.update("UPDATE qwen_tool_publication_seal SET segment_count = 9 WHERE stream_id = 'stdout'");
            case "reference" -> jdbc.update("DELETE FROM qwen_managed_session_resource_ref WHERE journal_revision = ?", revision);
            case "receipt" -> jdbc.update("UPDATE qwen_tool_publication SET receipt_sequence = 9");
            case "marker" -> jdbc.update("UPDATE qwen_tool_execution SET authorized_binding_version = NULL, authorized_dispatch_generation = NULL");
            default -> jdbc.update("UPDATE qwen_managed_session_journal_tx SET record_digest = ? WHERE journal_revision = ?", "f".repeat(64), revision);
        }
        assertThatThrownBy(() -> tx().execute(status -> admissions.lockOriginalAcknowledgement(bundle))).isInstanceOf(RuntimeException.class);
        assertThat(csi.inspect(registration).phase()).isEqualTo("DRAINING");
    }

    @Test
    void releasedSessionAndOriginalWriterCannotAuthorizeAckTail() {
        var bundle = admissions.verifyOriginalAcknowledgement(execution);
        runtimeSessions.compareAndSet(runtimeSession, runtimeSession.withState(RuntimeSessionRecord.State.RELEASING, Instant.now()));
        assertThatThrownBy(() -> tx().execute(status -> admissions.lockOriginalAcknowledgement(bundle)))
                .hasMessageContaining("Original Runtime Session");
    }

    @Test
    void originalWriterSealRefusesAfterPreflight() {
        var bundle = admissions.verifyOriginalAcknowledgement(execution);
        tx().executeWithoutResult(status -> sessions.sealWriter("tenant-1", "session-1", WRITER_TOKEN,
                new ManagedSessionStoreModels.SealWriterRequest("workspace-1", "writer-1", 1)));
        assertThatThrownBy(() -> tx().execute(status -> admissions.lockOriginalAcknowledgement(bundle)))
                .hasMessageContaining("Original Session owner");
    }

    @Test
    void rawPrecisionDifferenceCannotBeRoundedIntoOriginalResult() {
        var object = jdbc.queryForMap("SELECT inline_bytes FROM qwen_tool_publication_object WHERE slot_key = 'terminal'");
        String original = new String((byte[]) object.get("inline_bytes"), StandardCharsets.UTF_8);
        byte[] changed = original.replace("\"score\":0.5", "\"score\":0.50000000000000000001").getBytes(StandardCharsets.UTF_8);
        assertThat(changed).isNotEqualTo((byte[]) object.get("inline_bytes"));
        jdbc.update("UPDATE qwen_tool_publication_object SET inline_bytes = ?, byte_length = ?, sha256 = ? WHERE slot_key = 'terminal'",
                changed, changed.length, digest(changed));
        assertThatThrownBy(() -> admissions.verifyOriginalAcknowledgement(execution)).hasMessageContaining("Original complete Broker result");
    }

    @Test
    void changedCatalogDuringResourceVerificationCannotBeRecordedAsVerified() {
        duringObjectRead = () -> jdbc.update("UPDATE qwen_tool_publication_object SET operation_id = 'changed' WHERE slot_key = 'manifest:1'");
        assertThatThrownBy(() -> admissions.verifyOriginalAcknowledgement(execution))
                .hasMessageContaining("changed during verification");
    }

    @Test
    void invalidRawReceiptUtf8RefusesEvenWithUpdatedByteDigest() {
        var row = jdbc.queryForMap("SELECT record_bytes FROM qwen_managed_session_journal_tx WHERE journal_revision = ?", revision);
        byte[] valid = (byte[]) row.get("record_bytes");
        byte[] changed = (new String(valid, StandardCharsets.UTF_8).replace("{}\n", "{\"unknown\":\"?\"}\n"))
                .getBytes(StandardCharsets.UTF_8);
        for (int index = 0; index < changed.length; index++) {
            if (changed[index] == '?') {
                changed[index] = (byte) 0xff;
                break;
            }
        }
        jdbc.update("UPDATE qwen_managed_session_journal_tx SET record_bytes = ?, byte_length = ?, record_digest = ? WHERE journal_revision = ?",
                changed, changed.length, digest(changed), revision);
        assertThatThrownBy(() -> admissions.verifyOriginalAcknowledgement(execution)).hasMessageContaining("not UTF-8");
    }

    @ParameterizedTest
    @ValueSource(strings = {"v", "sequence", "historyRevision"})
    void rawReceiptIntegerOverflowCannotWrapIntoOriginalFields(String field) {
        byte[] valid = (byte[]) jdbc.queryForMap("SELECT record_bytes FROM qwen_managed_session_journal_tx WHERE journal_revision = ?",
                revision).get("record_bytes");
        long original = "v".equals(field) ? 1 : sequence;
        String overflow = "v".equals(field) ? "4294967297" : java.math.BigInteger.ONE.shiftLeft(64).add(java.math.BigInteger.valueOf(sequence)).toString();
        byte[] changed = new String(valid, StandardCharsets.UTF_8).replace("\"" + field + "\":" + original,
                "\"" + field + "\":" + overflow).getBytes(StandardCharsets.UTF_8);
        assertThat(changed).isNotEqualTo(valid);
        jdbc.update("UPDATE qwen_managed_session_journal_tx SET record_bytes = ?, byte_length = ?, record_digest = ? WHERE journal_revision = ?",
                changed, changed.length, digest(changed), revision);
        assertThatThrownBy(() -> admissions.verifyOriginalAcknowledgement(execution)).hasMessageContaining("Original");
    }

    @ParameterizedTest
    @ValueSource(strings = {"legacy", "null", "k1"})
    void coordinatorRefusesUntrustedProvenanceWithoutRpcOrAckWrite(String provenance) {
        if ("null".equals(provenance)) {
            jdbc.update("UPDATE qwen_runtime_binding SET resource_handle_version = NULL, resource_handle_json = NULL");
        } else if ("k1".equals(provenance)) {
            jdbc.update("UPDATE qwen_runtime_binding SET resource_handle_json = ?",
                    "{\"cluster\":\"cluster\",\"namespace\":\"runtime\",\"podName\":\"old-pod\",\"podUid\":\"legacy\"}");
        }
        RuntimeTransport transport = mock(RuntimeTransport.class);
        var coordinator = coordinator(transport);
        assertThatThrownBy(() -> coordinator.acknowledge(selector())).isInstanceOf(RuntimeException.class);
        verifyNoInteractions(transport);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_csi_worker_ack", Long.class)).isZero();
        assertThat(csi.inspect(registration).phase()).isEqualTo("DRAINING");
    }

    @Test
    void coordinatorRejectsAmbientAndDifferentDataSourceBeforeRpc() {
        RuntimeTransport transport = mock(RuntimeTransport.class);
        var coordinator = coordinator(transport);
        int reads = objectReads;
        assertThatThrownBy(() -> tx().execute(status -> coordinator.acknowledge(selector())))
                .hasMessageContaining("ambient transaction");
        assertThat(objectReads).isEqualTo(reads);
        var other = new JdbcDataSource();
        other.setURL("jdbc:h2:mem:ack-other-" + UUID.randomUUID());
        assertThatThrownBy(() -> new WorkspaceCsiWorkerAckStore(jdbc.getDataSource(), new DataSourceTransactionManager(other),
                bindings, runtimeSessions, executions, admissions, transport, Duration.ofSeconds(1)))
                .hasMessageContaining("one DataSource");
        assertThatThrownBy(() -> new WorkspaceCsiWorkerAckStore(jdbc.getDataSource(), manager,
                bindings, new JdbcRuntimeSessionRepository(other), executions, admissions, transport, Duration.ofSeconds(1)))
                .hasMessageContaining("one DataSource");
        verifyNoInteractions(transport);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_csi_worker_ack", Long.class)).isZero();
    }

    @Test
    void nativeSessionAndExecutionLockReadsRequireTransactionAndPinTheirTimeout() throws Exception {
        var connection = mock(Connection.class);
        var statement = mock(PreparedStatement.class);
        var result = mock(ResultSet.class);
        when(connection.getAutoCommit()).thenReturn(true);
        assertThatThrownBy(() -> executions.findByExecutionCallIdForUpdate(connection, "execution-1"))
                .hasMessageContaining("active transaction");
        assertThatThrownBy(() -> runtimeSessions.findByIdForUpdate(connection, runtime.getRequest().getScope(), "runtime-1"))
                .hasMessageContaining("active transaction");
        verifyNoInteractions(statement);
        when(connection.getAutoCommit()).thenReturn(false);
        when(connection.prepareStatement(anyString())).thenReturn(statement);
        when(statement.executeQuery()).thenReturn(result);
        assertThat(runtimeSessions.findByIdForUpdate(connection, runtime.getRequest().getScope(), "runtime-1")).isNull();
        assertThat(executions.findByExecutionCallIdForUpdate(connection, "execution-1")).isNull();
        verify(statement, org.mockito.Mockito.times(2)).setQueryTimeout(10);
    }

    @ParameterizedTest
    @ValueSource(strings = {"grants", "data", "admission"})
    void mismatchedSessionAuthorityAtEveryInjectionSiteRefusesBeforeRpcAndObjectReads(String component) {
        var other = new JdbcDataSource();
        other.setURL("jdbc:h2:mem:foreign-session-" + UUID.randomUUID());
        var foreignSessions = new ManagedSessionStore(new JdbcTemplate(other));
        var selectedGrants = new ToolPublicationStore(jdbc, manager,
                "grants".equals(component) ? foreignSessions : sessions, executions, bindings,
                new ToolPublicationStore.Capacity(2048, 16 * 1024 * 1024, 16 * 1024 * 1024, 10));
        var objects = mock(ToolPublicationObjectStore.class);
        var selectedData = new ToolPublicationDataStore(jdbc, manager, selectedGrants,
                "data".equals(component) ? foreignSessions : sessions, objects,
                Duration.ofMinutes(2), Duration.ofSeconds(30),
                new ToolPublicationDataStore.VerificationBudget(16 * 1024 * 1024, Duration.ofMinutes(25)));
        var selectedAdmission = new ToolPublicationAdmissionStore(jdbc, manager,
                "admission".equals(component) ? foreignSessions : sessions, selectedData);
        RuntimeTransport transport = mock(RuntimeTransport.class);
        int reads = objectReads;
        assertThat(selectedAdmission.usesDataSource(jdbc.getDataSource())).isFalse();
        assertThatThrownBy(() -> new WorkspaceCsiWorkerAckStore(jdbc.getDataSource(), manager,
                bindings, runtimeSessions, executions, selectedAdmission, transport, Duration.ofSeconds(1)))
                .hasMessageContaining("one DataSource");
        verifyNoInteractions(transport, objects);
        assertThat(objectReads).isEqualTo(reads);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_csi_worker_ack", Long.class)).isZero();
    }

    private WorkspaceCsiWorkerAckStore coordinator(RuntimeTransport transport) {
        return new WorkspaceCsiWorkerAckStore(jdbc.getDataSource(), manager, bindings,
                runtimeSessions, executions, admissions, transport, Duration.ofSeconds(1));
    }

    private WorkspaceCsiWorkerAckStore.Selector selector() {
        return new WorkspaceCsiWorkerAckStore.Selector(retirementId, "tenant-1", "workspace-1", "session-1", "pub-1");
    }

    private void finishAndCommitOriginalReceipt() {
        byte[] output = "abc".getBytes(StandardCharsets.UTF_8);
        data.publishSegment(key(), "pub-1", PRODUCER_TOKEN, "segment-0", "stdout", 0, output, digest(output));
        data.seal(key(), "pub-1", PRODUCER_TOKEN, "seal-stdout", "stdout", 1, 3, digest(output));
        data.seal(key(), "pub-1", PRODUCER_TOKEN, "seal-stderr", "stderr", 0, 0, digest(new byte[0]));
        var page = JSON.createObjectNode().put("toolResult", "managed-tool-result/1").put("type", "page").put("captureId", "capture-1")
                .put("streamId", "stdout").put("firstOrdinal", 0).put("offset", 0);
        page.putArray("segments").add(JSON.createObjectNode().put("byteLength", 3).put("digest", digest(output)));
        JsonNode pageRef = data.publishResource(key(), "pub-1", PRODUCER_TOKEN, "page-0", "page:stdout:0", "managed-tool-result-page", bytes(page));
        ObjectNode manifest = JSON.createObjectNode().put("toolResult", "managed-tool-result/1").put("type", "manifest");
        for (String field : List.of("turnId", "executionCallId", "bindingGeneration", "captureId", "revision", "captureScope", "capturePolicy")) {
            manifest.set(field, binding.path(field));
        }
        manifest.put("tenantId", "tenant-1").put("sessionId", "session-1").put("callId", "call-1")
                .put("invocationDigest", binding.path("reference").path("argsDigest").asText()).put("executionStatus", "success")
                .put("exitCode", 0).putNull("signal").put("captureStatus", "complete").putNull("captureReason").put("upstreamTruncated", false);
        var contents = manifest.putArray("contents");
        for (String stream : List.of("stdout", "stderr")) {
            ObjectNode content = JSON.createObjectNode().put("streamId", stream).put("role", stream).put("mimeType", "application/octet-stream")
                    .put("state", "sealed").put("byteLength", stream.equals("stdout") ? 3 : 0).put("digest", digest(stream.equals("stdout") ? output : new byte[0]));
            content.putArray("missingRanges");
            var pages = JSON.createObjectNode().putArray("pages");
            if (stream.equals("stdout")) {
                pages.add(JSON.createObjectNode().put("segmentCount", 1).put("byteLength", 3).set("ref", pageRef));
            }
            content.set("body", JSON.createObjectNode().set("pages", pages));
            contents.add(content);
        }
        JsonNode manifestRef = data.publishResource(key(), "pub-1", PRODUCER_TOKEN, "manifest-1", "manifest:1", "managed-tool-result-manifest", bytes(manifest));
        ObjectNode result = JSON.createObjectNode().put("executionStatus", "success");
        result.putArray("responseParts").addObject().put("score", 0.5);
        result.set("capture", JSON.createObjectNode().put("captureStatus", "complete").putNull("captureReason")
                .put("previewTruncated", false).put("deliveryStatus", "pending").set("manifest", manifestRef));
        data.finish(key(), "pub-1", PRODUCER_TOKEN, "finish-1", bytes(result));
        execution = executions.compareAndSet(execution, execution.withResult(JSON.convertValue(result, Map.class), 0, Instant.now()),
                "dispatcher", execution.getDispatchGeneration());
        ObjectNode outcome = JSON.createObjectNode().put("schemaVersion", 1).put("decision", "committed");
        outcome.set("envelope", result);
        outcome.set("manifestRef", manifestRef);
        ObjectNode history = JSON.createObjectNode().put("messageId", "22222222-2222-4222-8222-222222222222")
                .put("timestamp", Instant.now().toString()).put("model", "fixture");
        history.putArray("parts");
        outcome.set("history", history);
        JsonNode admission = data.prepareAdmission(key(), "pub-1", "writer-1", 1, WRITER_TOKEN, outcome);
        ObjectNode payload = JSON.createObjectNode().put("executionCallId", "execution-1").put("historyRevision", sequence + 1);
        payload.set("toolOutcomeRef", admission);
        payload.set("resultRef", manifestRef);
        payload.putArray("resources").add(manifestRef);
        String records = event(sequence + 1, "tool.receipt", payload) + "{}\n";
        var request = request("recordToolResult", "execution-1", admission.path("digest").asText(), records, 1,
                List.of(resource(admission, null), resource(manifestRef, null)), null);
        admissions.commitReceipt(key(), "pub-1", WRITER_TOKEN, request);
        revision++;
        sequence++;
        commitDigest = digest(records.getBytes(StandardCharsets.UTF_8));
    }

    private TransactionTemplate tx() { return new TransactionTemplate(manager); }
    private JsonNode key() { return binding.path("sessionKey"); }
    private static byte[] bytes(JsonNode value) { return value.toString().getBytes(StandardCharsets.UTF_8); }
    private static String digest(byte[] value) { return ToolPublicationContract.sha256(value); }
    private static JsonNode ref(String id, String kind, JsonNode value) {
        return JSON.createObjectNode().put("resourceId", id).put("kind", kind).put("schemaVersion", 1)
                .put("byteLength", bytes(value).length).put("digest", digest(bytes(value)));
    }
    private static ManagedSessionStoreModels.CommitResource resource(JsonNode ref, JsonNode value) {
        return new ManagedSessionStoreModels.CommitResource(ref.path("resourceId").asText(), ref.path("kind").asText(), 1,
                ref.path("byteLength").longValue(), ref.path("digest").asText(), value == null ? null : Base64.getEncoder().encodeToString(bytes(value)));
    }
    private String event(long number, String kind, JsonNode payload) {
        ObjectNode event = JSON.createObjectNode().put("v", 1).put("sequence", number).put("kind", kind);
        event.set("sessionKey", key());
        event.set("payload", payload);
        event.set("subject", JSON.createObjectNode().put("type", "activation").put("activationId", "activation-1").put("epoch", 1));
        return JSON.createObjectNode().put("subtype", "managed_session_event_v1").set("managedSession", event) + "\n";
    }
    private ManagedSessionStoreModels.CommitTransactionRequest request(String operation, String command, String digest,
            String records, int events, List<ManagedSessionStoreModels.CommitResource> resources, String checkpoint) {
        String next = events == 0 ? null : ToolPublicationContract.sha256(records.getBytes(StandardCharsets.UTF_8));
        return new ManagedSessionStoreModels.CommitTransactionRequest("workspace-1", "writer-1", 1, revision, sequence,
                "transaction-" + revision, operation, command, digest, events == 0 ? 0 : sequence + 1, sequence + events,
                events, next, commitDigest, next, events == 0 ? 0 : 1, checkpoint, events == 0 ? 2 : events + 1,
                Base64.getEncoder().encodeToString(records.getBytes(StandardCharsets.UTF_8)),
                ToolPublicationContract.sha256(records.getBytes(StandardCharsets.UTF_8)), resources);
    }
    private void append(String operation, String records, int events, List<ManagedSessionStoreModels.CommitResource> resources, String checkpoint) {
        var request = request(operation, "command-" + revision, digest(records.getBytes(StandardCharsets.UTF_8)), records, events, resources, checkpoint);
        tx().executeWithoutResult(status -> sessions.commit("tenant-1", "session-1", WRITER_TOKEN, request));
        revision++;
        sequence += events;
        commitDigest = events == 0 ? null : digest(records.getBytes(StandardCharsets.UTF_8));
    }
}
