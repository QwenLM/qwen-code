package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationContract;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationDataStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationAdmissionStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationStore;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

class ToolPublicationStoreTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String WRITER_TOKEN = "a".repeat(32);
    private static final String PUBLICATION_TOKEN = Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[32]);
    private static final long CAPTURE_BYTES = 1024;
    private static final long ALLOCATION = CAPTURE_BYTES + ToolPublicationContract.PRODUCER_BYTES
            + ToolPublicationContract.ADMISSION_BYTES;
    private JdbcTemplate jdbc;
    private DataSourceTransactionManager manager;
    private ManagedSessionStore sessions;
    private JdbcRuntimeBindingRepository bindings;
    private JdbcToolExecutionRepository executions;
    private ToolPublicationStore store;
    private ObjectNode binding;
    private JsonNode checkpoint;
    private JsonNode args;
    private long revision;
    private long sequence;
    private String commitDigest;

    @BeforeEach
    void setup() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:publication-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE;LOCK_TIMEOUT=10000");
        Flyway.configure().dataSource(source).load().migrate();
        jdbc = new JdbcTemplate(source);
        manager = new DataSourceTransactionManager(source);
        sessions = new ManagedSessionStore(jdbc);
        bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("key", new byte[32]),
                () -> "binding-1");
        executions = new JdbcToolExecutionRepository(source);
        store = newStore(10 * ALLOCATION, 10);
        var runtime = bindings.findOrCreate(new RuntimeProvisionRequest(
                new RuntimeScope("tenant-1", "workspace-1", "generation-1", "/workspace", "capability", "workspace"), null));
        runtime = bindings.claimOperation(runtime.getBindingId(), "owner", java.time.Duration.ofMinutes(1));
        assertThat(bindings.compareAndSet(runtime, runtime.withState(RuntimeBindingRecord.State.READY, null, Instant.now())))
                .isNotNull();
        binding = JSON.createObjectNode().put("publication", ToolPublicationContract.PROTOCOL)
                .put("publicationId", "pub-1").put("turnId", "turn-1").put("executionCallId", "execution-1")
                .put("modelCallId", "model-1").put("runtimeBindingId", "binding-1").put("bindingGeneration", "1")
                .put("captureId", "capture-1").put("revision", 1).put("captureScope", "process_pipes")
                .put("capturePolicy", "complete_required").put("writerId", "writer-1").put("writerGeneration", 1)
                .put("activationId", "activation-1").put("activationEpoch", 1).put("intentSequence", 2);
        binding.set("sessionKey", JSON.createObjectNode().put("tenantId", "tenant-1")
                .put("workspaceId", "workspace-1").put("sessionId", "session-1"));
        String payload = "{\"toolName\":\"run_shell_command\",\"input\":{\"command\":\"printf hi\"}}";
        binding.put("requestDigest", "sha256:" + digest(payload));
        binding.set("reference", JSON.createObjectNode().put("sessionId", "runtime-1").put("promptId", "runtime-prompt-1")
                .put("callId", "runtime-call-1").put("argsDigest", "sha256:" + digest("{\"command\":\"printf hi\"}")));
        args = JSON.createObjectNode().put("harnessSessionId", "session-1").put("runtimeSessionId", "runtime-1")
                .put("payloadJson", payload);
        binding.set("argsRef", ref("args-1", "managed-tool-input", args));
        ObjectNode cp = JSON.createObjectNode();
        cp.set("identity", JSON.createObjectNode().put("schemaVersion", 1).put("engine", "managed")
                .put("turnId", "turn-1").put("promptId", "runtime-prompt-1").put("activationId", "activation-1").put("coveredSequence", 2)
                .set("sessionKey", binding.get("sessionKey")));
        cp.set("continuation", JSON.createObjectNode().put("phase", "await_runtime"));
        cp.set("tools", JSON.createObjectNode().set("items", JSON.createArrayNode().add(JSON.createObjectNode()
                .put("executionCallId", "execution-1").put("functionCallId", "model-1").put("toolName", "run_shell_command")
                .put("state", "in_progress").put("outcomeSource", "runtime")
                .put("inputDigest", digest("{\"command\":\"printf hi\"}")))));
        checkpoint = cp;
        binding.set("checkpointRef", ref("checkpoint-1", "managed-checkpoint", checkpoint));
        executions.findOrCreate(ToolExecutionRecord.prepared("execution-1", "idempotency-1", "binding-1", 1,
                "session-1", "runtime-1", "runtime-prompt-1", "runtime-call-1", "sha256:" + digest(payload),
                Map.of("sessionId", "runtime-1", "promptId", "runtime-prompt-1", "callId", "runtime-call-1",
                        "argsDigest", "sha256:" + digest("{\"command\":\"printf hi\"}"),
                        "payloadDigest", "sha256:" + digest(payload), "dispatchMode", "deferred_v3",
                        "publicationId", "pub-1")));
        new TransactionTemplate(manager).executeWithoutResult(status -> sessions.acquireWriter("tenant-1", "session-1",
                WRITER_TOKEN, new ManagedSessionStoreModels.AcquireWriterRequest("workspace-1", "writer-1", 300000L)));
        append("session.create", "{}\n{}\n", 0, List.of(), null);
        ObjectNode intent = JSON.createObjectNode().put("executionCallId", "execution-1").put("outcomeSource", "runtime");
        intent.set("argsRef", binding.get("argsRef"));
        append("tool.dispatch", event(1, "activation.changed", activation("active"))
                + event(2, "tool.intent", intent) + "{}\n", 2,
                List.of(resource(binding.get("argsRef"), args), resource(binding.get("checkpointRef"), checkpoint)),
                "checkpoint-1");
    }

    @Test
    void commitsLargeBlockedOutcomeThroughVerifiedCatalogObject() {
        reserve();
        Map<String, byte[]> objects = new java.util.HashMap<>();
        ToolPublicationObjectStore bucket = new ToolPublicationObjectStore() {
            @Override
            public void putIfAbsent(String key, byte[] bytes) {
                objects.putIfAbsent(key, bytes.clone());
            }

            @Override
            public InputStream open(String key) {
                return new ByteArrayInputStream(objects.get(key));
            }

            @Override
            public void requireUnversioned() {
            }
        };
        sessions.setPublicationObjects(bucket);
        var data = new ToolPublicationDataStore(jdbc, manager, store, sessions, bucket,
                Duration.ofMinutes(2), Duration.ofSeconds(30));
        JsonNode key = binding.get("sessionKey");
        ObjectNode capture = JSON.createObjectNode().put("captureStatus", "unavailable")
                .put("captureReason", "storage_failed").put("previewTruncated", false)
                .put("deliveryStatus", "pending").putNull("manifest");
        ObjectNode envelope = JSON.createObjectNode().put("executionStatus", "error");
        envelope.putArray("responseParts").add("x".repeat(100_000));
        envelope.set("capture", capture);
        data.finish(key, "pub-1", PUBLICATION_TOKEN, "large-finish", envelope);
        ObjectNode outcome = JSON.createObjectNode().put("schemaVersion", 1)
                .put("decision", "blocked").putNull("manifestRef");
        outcome.set("envelope", envelope);
        ObjectNode history = JSON.createObjectNode()
                .put("messageId", "11111111-1111-4111-8111-111111111111")
                .put("timestamp", "2026-09-28T00:00:00Z").put("model", "test");
        history.putArray("parts").addObject().put("text", "Shell capture unavailable");
        outcome.set("history", history);
        JsonNode admission = data.prepareAdmission(key, "pub-1", "writer-1", 1, WRITER_TOKEN, outcome);
        assertThat(admission.path("byteLength").asLong()).isGreaterThan(64 * 1024);
        ObjectNode receiptPayload = JSON.createObjectNode().put("executionCallId", "execution-1")
                .put("historyRevision", sequence + 1).putNull("resultRef");
        receiptPayload.set("toolOutcomeRef", admission);
        receiptPayload.putArray("resources");
        String records = event(sequence + 1, "tool.receipt", receiptPayload) + "{}\n";
        var commit = new ManagedSessionStoreModels.CommitTransactionRequest("workspace-1", "writer-1", 1,
                revision, sequence, "transaction-large", "recordToolResult", "execution-1",
                admission.path("digest").asText(), sequence + 1, sequence + 1, 1,
                digest(records), commitDigest, digest(records), 1, null, 2,
                Base64.getEncoder().encodeToString(records.getBytes(StandardCharsets.UTF_8)),
                digest(records), List.of(new ManagedSessionStoreModels.CommitResource(
                        admission.path("resourceId").asText(), "managed-tool-outcome", 1,
                        admission.path("byteLength").asLong(), admission.path("digest").asText(), null)));
        var admissions = new ToolPublicationAdmissionStore(jdbc, manager, sessions, data);
        assertThat(admissions.commitReceipt(key, "pub-1", WRITER_TOKEN, commit)
                .path("decision").asText()).isEqualTo("blocked");
        var changedReplay = new ManagedSessionStoreModels.CommitTransactionRequest("workspace-1", "writer-1", 1,
                revision, sequence, "different-transaction", "recordToolResult", "execution-1",
                admission.path("digest").asText(), sequence + 1, sequence + 1, 1,
                digest(records), commitDigest, digest(records), 1, null, 2,
                Base64.getEncoder().encodeToString(records.getBytes(StandardCharsets.UTF_8)),
                digest(records), commit.resources());
        assertThatThrownBy(() -> admissions.commitReceipt(key, "pub-1", WRITER_TOKEN, changedReplay))
                .hasMessageContaining("different content");
        assertThat(admissions.commitReceipt(key, "pub-1", WRITER_TOKEN, commit)
                .path("decision").asText()).isEqualTo("blocked");
        assertThat(sessions.readResource("tenant-1", "workspace-1", "session-1",
                admission.path("resourceId").asText(), WRITER_TOKEN).bytes())
                .isEqualTo(outcome.toString().getBytes(StandardCharsets.UTF_8));
        String objectKey = jdbc.queryForObject("SELECT object_key FROM qwen_tool_publication_object"
                + " WHERE slot_key = 'admission'", String.class);
        objects.get(objectKey)[0] = 'z';
        assertThatThrownBy(() -> sessions.readResource("tenant-1", "workspace-1", "session-1",
                admission.path("resourceId").asText(), WRITER_TOKEN)).hasMessageContaining("verification");
        assertThat(jdbc.queryForObject("SELECT quarantined FROM qwen_tool_publication"
                + " WHERE publication_id = 'pub-1'", Boolean.class)).isTrue();
        assertThatThrownBy(() -> sessions.readResource("tenant-1", "workspace-1", "session-1",
                admission.path("resourceId").asText(), WRITER_TOKEN)).hasMessageContaining("verification");
    }

    @Test
    void publishesImmutableSegmentAndResourceUnderOriginalAuthorization() {
        reserve();
        Map<String, byte[]> objects = new java.util.HashMap<>();
        ToolPublicationObjectStore bucket = new ToolPublicationObjectStore() {
            @Override
            public void putIfAbsent(String key, byte[] bytes) {
                objects.putIfAbsent(key, bytes.clone());
            }

            @Override
            public InputStream open(String key) {
                return new ByteArrayInputStream(objects.get(key));
            }

            @Override
            public void requireUnversioned() {
            }
        };
        var data = new ToolPublicationDataStore(jdbc, manager, store, sessions, bucket,
                Duration.ofMinutes(2), Duration.ofSeconds(30));
        JsonNode key = binding.get("sessionKey");
        byte[] segment = "abc".getBytes(StandardCharsets.UTF_8);
        JsonNode first = data.publishSegment(key, "pub-1", PUBLICATION_TOKEN,
                "operation-1", "stdout", 0, segment, digest("abc"));
        segment[0] = 'x';
        assertThat(data.publishSegment(key, "pub-1", PUBLICATION_TOKEN,
                "operation-1", "stdout", 0, "abc".getBytes(StandardCharsets.UTF_8), digest("abc")))
                .isEqualTo(first);
        assertThat(data.operationStatus(key, "pub-1", PUBLICATION_TOKEN, "operation-1")
                .path("receipt")).isEqualTo(first);
        assertThat(objects.values()).singleElement().satisfies(bytes ->
                assertThat(bytes).isEqualTo("abc".getBytes(StandardCharsets.UTF_8)));
        assertThat(data.prefix(key, "pub-1", PUBLICATION_TOKEN, "operation-prefix", "stdout")
                .path("byteLength").asLong()).isEqualTo(3);
        assertThat(data.seal(key, "pub-1", PUBLICATION_TOKEN, "operation-seal", "stdout", 1,
                3, digest("abc")).path("segmentCount").asInt()).isEqualTo(1);
        data.seal(key, "pub-1", PUBLICATION_TOKEN, "operation-seal-empty", "stderr", 0,
                0, digest(""));
        assertThat(data.prefix(key, "pub-1", PUBLICATION_TOKEN, "operation-prefix-2", "stdout")
                .path("sealed").asBoolean()).isTrue();
        assertThatThrownBy(() -> data.publishSegment(key, "pub-1", PUBLICATION_TOKEN,
                "operation-extra", "stdout", 1, "x".getBytes(StandardCharsets.UTF_8), null))
                .hasMessageContaining("sealed");
        assertThatThrownBy(() -> data.publishSegment(key, "pub-1", PUBLICATION_TOKEN,
                "operation-2", "stdout", 0, "abd".getBytes(StandardCharsets.UTF_8), null))
                .hasMessageContaining("conflicts");
        ObjectNode page = JSON.createObjectNode().put("toolResult", "managed-tool-result/1")
                .put("type", "page").put("captureId", "capture-1")
                .put("streamId", "stdout").put("firstOrdinal", 0).put("offset", 0);
        page.putArray("segments").add(JSON.createObjectNode().put("byteLength", 3).put("digest", digest("abc")));
        assertThatThrownBy(() -> data.publishResource(key, "pub-1", PUBLICATION_TOKEN,
                "wrong-page-slot", "page:stdout:1", "managed-tool-result-page",
                page.toString().getBytes(StandardCharsets.UTF_8)))
                .hasMessageContaining("slot conflicts");
        JsonNode ref = data.publishResource(key, "pub-1", PUBLICATION_TOKEN,
                "operation-3", "page:stdout:0", "managed-tool-result-page",
                page.toString().getBytes(StandardCharsets.UTF_8));
        assertThat(data.readResource(key, "pub-1", ref.path("resourceId").asText()))
                .isEqualTo(page.toString().getBytes(StandardCharsets.UTF_8));
        assertThat(jdbc.queryForObject("SELECT capture_used_bytes FROM qwen_tool_publication",
                Long.class)).isEqualTo(3L);
        assertThat(jdbc.queryForObject("SELECT producer_used_bytes FROM qwen_tool_publication",
                Long.class)).isEqualTo(page.toString().getBytes(StandardCharsets.UTF_8).length);
        ObjectNode manifest = JSON.createObjectNode().put("toolResult", "managed-tool-result/1")
                .put("type", "manifest").put("tenantId", "tenant-1").put("sessionId", "session-1")
                .put("turnId", "turn-1").put("executionCallId", "execution-1")
                .put("callId", "runtime-call-1")
                .put("invocationDigest", binding.path("reference").path("argsDigest").asText())
                .put("bindingGeneration", "1").put("captureId", "capture-1")
                .put("revision", 1).put("executionStatus", "success").put("exitCode", 0)
                .putNull("signal").put("captureScope", "process_pipes")
                .put("capturePolicy", "complete_required").put("captureStatus", "complete")
                .putNull("captureReason").put("upstreamTruncated", false);
        ObjectNode content = JSON.createObjectNode().put("streamId", "stdout")
                .put("role", "stdout").put("mimeType", "application/octet-stream")
                .put("state", "sealed").put("byteLength", 3).put("digest", digest("abc"));
        content.putArray("missingRanges");
        ObjectNode body = JSON.createObjectNode();
        ObjectNode pageLink = JSON.createObjectNode().put("segmentCount", 1).put("byteLength", 3);
        pageLink.set("ref", ref);
        body.putArray("pages").add(pageLink);
        content.set("body", body);
        manifest.putArray("contents").add(content);
        ObjectNode stderr = JSON.createObjectNode().put("streamId", "stderr")
                .put("role", "stderr").put("mimeType", "application/octet-stream")
                .put("state", "sealed").put("byteLength", 0).put("digest", digest(""));
        stderr.putArray("missingRanges");
        ObjectNode emptyBody = JSON.createObjectNode();
        emptyBody.putArray("pages");
        stderr.set("body", emptyBody);
        ((com.fasterxml.jackson.databind.node.ArrayNode) manifest.path("contents")).add(stderr);
        JsonNode manifestRef = data.publishResource(key, "pub-1", PUBLICATION_TOKEN,
                "operation-manifest", "manifest:1", "managed-tool-result-manifest",
                manifest.toString().getBytes(StandardCharsets.UTF_8));
        ObjectNode capture = JSON.createObjectNode().put("captureStatus", "complete")
                .putNull("captureReason").put("previewTruncated", false)
                .put("deliveryStatus", "pending");
        capture.set("manifest", manifestRef);
        ObjectNode envelope = JSON.createObjectNode().put("executionStatus", "success");
        envelope.putArray("responseParts");
        envelope.set("capture", capture);
        assertThat(data.finish(key, "pub-1", PUBLICATION_TOKEN,
                "operation-finish", envelope).path("producerPhase").asText()).isEqualTo("FINISHED");
        assertThat(data.finished(key, "pub-1", WRITER_TOKEN).path("result")).isEqualTo(envelope);
        store.apply(request("fence"), WRITER_TOKEN, null);
        assertThat(data.finished(key, "pub-1", WRITER_TOKEN).path("result")).isEqualTo(envelope);
        ObjectNode outcome = JSON.createObjectNode().put("schemaVersion", 1)
                .put("decision", "committed");
        outcome.set("envelope", envelope);
        outcome.set("manifestRef", manifestRef);
        ObjectNode history = JSON.createObjectNode()
                .put("messageId", "22222222-2222-4222-8222-222222222222")
                .put("timestamp", "2026-09-28T00:00:00Z").put("model", "test");
        history.putArray("parts").addObject().put("text", "done");
        outcome.set("history", history);
        JsonNode admission = data.prepareAdmission(key, "pub-1", "writer-1", 1,
                WRITER_TOKEN, outcome);
        assertThat(data.readResource(key, "pub-1", admission.path("resourceId").asText()))
                .isEqualTo(outcome.toString().getBytes(StandardCharsets.UTF_8));
        ObjectNode receiptPayload = JSON.createObjectNode().put("executionCallId", "execution-1")
                .put("historyRevision", sequence + 1);
        receiptPayload.set("toolOutcomeRef", admission);
        receiptPayload.set("resultRef", manifestRef);
        receiptPayload.putArray("resources").add(manifestRef);
        String recordBytes = event(sequence + 1, "tool.receipt", receiptPayload) + "{}\n";
        long receiptSequence = sequence + 1;
        var commit = new ManagedSessionStoreModels.CommitTransactionRequest("workspace-1", "writer-1", 1,
                revision, sequence, "transaction-receipt", "recordToolResult", "execution-1",
                admission.path("digest").asText(), receiptSequence, receiptSequence, 1,
                digest(recordBytes), commitDigest, digest(recordBytes), 1, null, 2,
                Base64.getEncoder().encodeToString(recordBytes.getBytes(StandardCharsets.UTF_8)),
                digest(recordBytes), List.of(
                        new ManagedSessionStoreModels.CommitResource(admission.path("resourceId").asText(),
                                "managed-tool-outcome", 1, admission.path("byteLength").asLong(),
                                admission.path("digest").asText(), null),
                        new ManagedSessionStoreModels.CommitResource(manifestRef.path("resourceId").asText(),
                                "managed-tool-result-manifest", 1, manifestRef.path("byteLength").asLong(),
                                manifestRef.path("digest").asText(), null)));
        var admissions = new ToolPublicationAdmissionStore(jdbc, manager, sessions, data);
        JsonNode committed = admissions.commitReceipt(key, "pub-1", WRITER_TOKEN, commit);
        assertThat(committed.path("historyRevision").asLong()).isEqualTo(receiptSequence);
        assertThat(admissions.commitReceipt(key, "pub-1", WRITER_TOKEN, commit)).isEqualTo(committed);
        assertThat(data.receiptForBroker(executions.findByExecutionCallId("execution-1"))
                .path("historyRevision").asLong()).isEqualTo(receiptSequence);
        assertThat(sessions.readResource("tenant-1", "workspace-1", "session-1",
                admission.path("resourceId").asText(), WRITER_TOKEN).bytes())
                .isEqualTo(outcome.toString().getBytes(StandardCharsets.UTF_8));
        ObjectNode identity = manifest.deepCopy();
        assertThat(data.readRange(key, "pub-1", WRITER_TOKEN, manifestRef, identity,
                "stdout", 1, 2)).isEqualTo("bc".getBytes(StandardCharsets.UTF_8));
        assertThat(data.readRange(key, "pub-1", WRITER_TOKEN, manifestRef, identity,
                "stdout", 3, 0)).isEmpty();
        assertThatThrownBy(() -> data.readRange(key, "pub-1", WRITER_TOKEN, manifestRef,
                identity, "stdout", 2, 2)).hasMessageContaining("range exceeds");
        objects.values().iterator().next()[0] = 'z';
        assertThatThrownBy(() -> data.readRange(key, "pub-1", WRITER_TOKEN, manifestRef,
                identity, "stdout", 0, 1)).hasMessageContaining("digest changed");
        assertThat(jdbc.queryForObject("SELECT state FROM qwen_tool_publication_object"
                + " WHERE slot_key = 'segment:stdout:0'", String.class)).isEqualTo("QUARANTINED");
        assertThatThrownBy(() -> sessions.readResource("tenant-1", "workspace-1", "session-1",
                admission.path("resourceId").asText(), WRITER_TOKEN)).hasMessageContaining("verification");
    }

    @Test
    void isolatesCorruptCandidateWithoutBlockingVerifiedPrefix() {
        reserve();
        Map<String, byte[]> objects = new java.util.HashMap<>();
        boolean[] corruptNext = {false};
        ToolPublicationObjectStore bucket = new ToolPublicationObjectStore() {
            @Override
            public void putIfAbsent(String key, byte[] bytes) {
                byte[] stored = bytes.clone();
                if (corruptNext[0]) {
                    stored[0] ^= 1;
                    corruptNext[0] = false;
                }
                objects.putIfAbsent(key, stored);
            }

            @Override
            public InputStream open(String key) {
                return new ByteArrayInputStream(objects.get(key));
            }

            @Override
            public void requireUnversioned() {
            }
        };
        var data = new ToolPublicationDataStore(jdbc, manager, store, sessions, bucket,
                Duration.ofMinutes(2), Duration.ofSeconds(30));
        JsonNode key = binding.get("sessionKey");
        data.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "good-segment",
                "stdout", 0, "abc".getBytes(StandardCharsets.UTF_8), digest("abc"));
        corruptNext[0] = true;
        assertThatThrownBy(() -> data.publishSegment(key, "pub-1", PUBLICATION_TOKEN,
                "bad-segment", "stdout", 1, "def".getBytes(StandardCharsets.UTF_8), digest("def")))
                .hasMessageContaining("digest changed");
        assertThat(jdbc.queryForObject("SELECT state FROM qwen_tool_publication_object"
                + " WHERE slot_key = 'segment:stdout:1'", String.class)).isEqualTo("QUARANTINED");
        assertThat(jdbc.queryForObject("SELECT quarantined FROM qwen_tool_publication"
                + " WHERE publication_id = 'pub-1'", Boolean.class)).isFalse();
        assertThat(data.prefix(key, "pub-1", PUBLICATION_TOKEN, "good-prefix", "stdout")
                .path("byteLength").asLong()).isEqualTo(3);
        assertThatThrownBy(() -> data.publishSegment(key, "pub-1", PUBLICATION_TOKEN,
                "bad-segment", "stdout", 1, "def".getBytes(StandardCharsets.UTF_8), digest("def")))
                .hasMessageContaining("quarantined");
    }

    @Test
    void preservesSegmentAndSealRefusalCodesAcrossCatalogOperations() {
        reserve();
        Map<String, byte[]> objects = new java.util.HashMap<>();
        ToolPublicationObjectStore bucket = new ToolPublicationObjectStore() {
            @Override
            public void putIfAbsent(String key, byte[] bytes) {
                objects.putIfAbsent(key, bytes.clone());
            }

            @Override
            public InputStream open(String key) {
                return new ByteArrayInputStream(objects.get(key));
            }

            @Override
            public void requireUnversioned() {
            }
        };
        var data = new ToolPublicationDataStore(jdbc, manager, store, sessions, bucket,
                Duration.ofMinutes(2), Duration.ofSeconds(30));
        JsonNode key = binding.get("sessionKey");
        byte[] abc = "abc".getBytes(StandardCharsets.UTF_8);
        assertThatThrownBy(() -> data.publishSegment(key, "pub-1", PUBLICATION_TOKEN,
                "bad-digest", "stdout", 0, abc, digest("other")))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo("managed_tool_result_digest_mismatch"));
        data.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "segment-0", "stdout", 0, abc, digest("abc"));
        data.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "segment-1", "stderr", 0, abc, digest("abc"));
        assertThatThrownBy(() -> data.publishSegment(key, "pub-1", PUBLICATION_TOKEN,
                "segment-1", "stdout", 0, abc, digest("abc")))
                .hasMessageContaining("operation conflicts");
        assertThatThrownBy(() -> data.publishSegment(key, "pub-1", PUBLICATION_TOKEN,
                "other-segment", "stdout", 0, "abd".getBytes(StandardCharsets.UTF_8), null))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo("managed_tool_result_conflict"));
        assertThatThrownBy(() -> data.seal(key, "pub-1", PUBLICATION_TOKEN,
                "missing-segment", "stdout", 2, 3, digest("abc")))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo("managed_tool_result_conflict"));
        assertThatThrownBy(() -> data.seal(key, "pub-1", PUBLICATION_TOKEN,
                "wrong-length", "stdout", 1, 4, digest("abc")))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo("managed_tool_result_digest_mismatch"));
        data.seal(key, "pub-1", PUBLICATION_TOKEN, "seal-correct", "stdout", 1, 3, digest("abc"));
        assertThatThrownBy(() -> data.seal(key, "pub-1", PUBLICATION_TOKEN,
                "seal-conflict", "stdout", 1, 3, digest("abd")))
                .isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo("managed_tool_result_conflict"));
    }

    @Test
    void renewsTheOriginalClaimWhileScanningSlowObjectBytes() {
        reserve();
        byte[] segment = "abc".getBytes(StandardCharsets.UTF_8);
        boolean[] slow = {false};
        ToolPublicationObjectStore bucket = new ToolPublicationObjectStore() {
            @Override
            public void putIfAbsent(String key, byte[] bytes) {
            }

            @Override
            public InputStream open(String key) {
                return new ByteArrayInputStream(segment) {
                    @Override
                    public synchronized int read(byte[] target, int offset, int length) {
                        if (available() == 0) {
                            return -1;
                        }
                        if (slow[0]) {
                            try {
                                Thread.sleep(45);
                            } catch (InterruptedException error) {
                                Thread.currentThread().interrupt();
                                throw new IllegalStateException(error);
                            }
                        }
                        return super.read(target, offset, Math.min(length, 1));
                    }
                };
            }

            @Override
            public void requireUnversioned() {
            }
        };
        var data = new ToolPublicationDataStore(jdbc, manager, store, sessions, bucket,
                Duration.ofSeconds(2), Duration.ofMillis(90));
        JsonNode key = binding.get("sessionKey");
        data.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "slow-segment",
                "stdout", 0, segment, digest("abc"));
        slow[0] = true;
        assertThat(data.seal(key, "pub-1", PUBLICATION_TOKEN, "slow-seal", "stdout",
                1, segment.length, digest("abc")).path("segmentCount").asInt()).isEqualTo(1);
    }

    @Test
    void streamsLargeOutputAndReadsItsTailAfterStoreReplacement(@TempDir Path root) throws Exception {
        int segments = "1".equals(System.getenv("O2_STRESS")) ? 1024 : 100;
        long captureBytes = (long) segments * 1024 * 1024;
        long allocated = captureBytes + ToolPublicationContract.PRODUCER_BYTES
                + ToolPublicationContract.ADMISSION_BYTES;
        store = new ToolPublicationStore(jdbc, manager, sessions, executions, bindings,
                new ToolPublicationStore.Capacity(captureBytes, allocated, allocated, 1));
        store.apply(request("reserve").put("captureBytes", captureBytes), WRITER_TOKEN, PUBLICATION_TOKEN);
        ToolPublicationObjectStore bucket = new ToolPublicationObjectStore() {
            private Path file(String key) { return root.resolve(digest(key)); }

            @Override
            public void putIfAbsent(String key, byte[] bytes) {
                try {
                    Files.write(file(key), bytes, StandardOpenOption.CREATE_NEW);
                } catch (java.nio.file.FileAlreadyExistsException ignored) {
                } catch (java.io.IOException error) {
                    throw new java.io.UncheckedIOException(error);
                }
            }

            @Override
            public InputStream open(String key) {
                try {
                    return Files.newInputStream(file(key));
                } catch (java.io.IOException error) {
                    throw new java.io.UncheckedIOException(error);
                }
            }

            @Override
            public void requireUnversioned() {
            }
        };
        ToolPublicationDataStore data = new ToolPublicationDataStore(jdbc, manager, store, sessions,
                bucket, Duration.ofMinutes(20), Duration.ofMinutes(10));
        JsonNode key = binding.get("sessionKey");
        byte[] unit = new byte[1024 * 1024];
        java.util.Arrays.fill(unit, (byte) 0x91);
        java.security.MessageDigest hash = java.security.MessageDigest.getInstance("SHA-256");
        ObjectNode page = JSON.createObjectNode().put("toolResult", "managed-tool-result/1")
                .put("type", "page").put("captureId", "capture-1")
                .put("streamId", "stdout").put("firstOrdinal", 0).put("offset", 0);
        var descriptors = page.putArray("segments");
        var pageLinks = JSON.createArrayNode();
        String unitDigest = ToolPublicationContract.sha256(unit);
        for (int ordinal = 0; ordinal < segments; ordinal++) {
            data.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "segment-" + ordinal,
                    "stdout", ordinal, unit, unitDigest);
            hash.update(unit);
            descriptors.add(JSON.createObjectNode().put("byteLength", unit.length)
                    .put("digest", unitDigest));
            if (descriptors.size() == 512 || ordinal == segments - 1) {
                int pageIndex = pageLinks.size();
                JsonNode pageRef = data.publishResource(key, "pub-1", PUBLICATION_TOKEN,
                        "page-stdout-" + pageIndex, "page:stdout:" + page.path("firstOrdinal").asInt(),
                        "managed-tool-result-page", page.toString().getBytes(StandardCharsets.UTF_8));
                ObjectNode pageLink = JSON.createObjectNode().put("segmentCount", descriptors.size())
                        .put("byteLength", (long) descriptors.size() * unit.length);
                pageLink.set("ref", pageRef);
                pageLinks.add(pageLink);
                page = JSON.createObjectNode().put("toolResult", "managed-tool-result/1")
                        .put("type", "page").put("captureId", "capture-1")
                        .put("streamId", "stdout").put("firstOrdinal", ordinal + 1)
                        .put("offset", (long) (ordinal + 1) * unit.length);
                descriptors = page.putArray("segments");
            }
        }
        String outputDigest = HexFormat.of().formatHex(hash.digest());
        data.seal(key, "pub-1", PUBLICATION_TOKEN, "seal-stdout", "stdout",
                segments, captureBytes, outputDigest);
        data.seal(key, "pub-1", PUBLICATION_TOKEN, "seal-stderr", "stderr", 0,
                0, digest(""));
        ObjectNode manifest = JSON.createObjectNode().put("toolResult", "managed-tool-result/1")
                .put("type", "manifest").put("tenantId", "tenant-1")
                .put("sessionId", "session-1").put("turnId", "turn-1")
                .put("executionCallId", "execution-1").put("callId", "runtime-call-1")
                .put("invocationDigest", binding.path("reference").path("argsDigest").asText())
                .put("bindingGeneration", "1").put("captureId", "capture-1")
                .put("revision", 1).put("executionStatus", "success")
                .put("exitCode", 0).putNull("signal").put("captureScope", "process_pipes")
                .put("capturePolicy", "complete_required").put("captureStatus", "complete")
                .putNull("captureReason").put("upstreamTruncated", false);
        ObjectNode stdout = JSON.createObjectNode().put("streamId", "stdout")
                .put("role", "stdout").put("mimeType", "application/octet-stream")
                .put("state", "sealed").put("byteLength", captureBytes).put("digest", outputDigest);
        stdout.putArray("missingRanges");
        ObjectNode stdoutBody = JSON.createObjectNode();
        stdoutBody.set("pages", pageLinks);
        stdout.set("body", stdoutBody);
        ObjectNode stderr = JSON.createObjectNode().put("streamId", "stderr")
                .put("role", "stderr").put("mimeType", "application/octet-stream")
                .put("state", "sealed").put("byteLength", 0).put("digest", digest(""));
        stderr.putArray("missingRanges");
        stderr.set("body", JSON.createObjectNode().set("pages", JSON.createArrayNode()));
        manifest.putArray("contents").add(stdout).add(stderr);
        JsonNode manifestRef = data.publishResource(key, "pub-1", PUBLICATION_TOKEN,
                "manifest-1", "manifest:1", "managed-tool-result-manifest",
                manifest.toString().getBytes(StandardCharsets.UTF_8));
        ObjectNode capture = JSON.createObjectNode().put("captureStatus", "complete")
                .putNull("captureReason").put("previewTruncated", true)
                .put("deliveryStatus", "pending");
        capture.set("manifest", manifestRef);
        ObjectNode envelope = JSON.createObjectNode().put("executionStatus", "success");
        envelope.putArray("responseParts");
        envelope.set("capture", capture);
        data.finish(key, "pub-1", PUBLICATION_TOKEN, "finish-1", envelope);
        ToolPublicationDataStore reopened = new ToolPublicationDataStore(jdbc, manager, store, sessions,
                bucket, Duration.ofMinutes(20), Duration.ofMinutes(10));
        assertThat(reopened.readRange(key, "pub-1", WRITER_TOKEN, manifestRef,
                manifest, "stdout", captureBytes - 64, 64))
                .isEqualTo(java.util.Arrays.copyOf(unit, 64));
    }

    @Test
    void replaysAcrossRepositoryReplacementAndKeyOrderWithoutLeakingSecret() {
        JsonNode first = reserve();
        ObjectNode reordered = request("reserve");
        ObjectNode key = JSON.createObjectNode().put("sessionId", "session-1").put("workspaceId", "workspace-1")
                .put("tenantId", "tenant-1");
        reordered.set("sessionKey", key);
        ((ObjectNode) reordered.get("binding")).set("sessionKey", key);
        assertThat(newStore(10 * ALLOCATION, 10).apply(reordered, WRITER_TOKEN, PUBLICATION_TOKEN)).isEqualTo(first);
        assertThat(first.toString()).doesNotContain(PUBLICATION_TOKEN).doesNotContain("writerToken");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_publication", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT token_hash FROM qwen_tool_publication", String.class))
                .isEqualTo(ToolPublicationContract.tokenHash(PUBLICATION_TOKEN));
    }

    @Test
    void rejectsConflictingTokenCapacityAndRebinding() {
        reserve();
        assertThatThrownBy(() -> store.apply(request("reserve"), WRITER_TOKEN,
                Base64.getUrlEncoder().withoutPadding().encodeToString(new byte[32]).replaceFirst("A", "B")))
                .isInstanceOf(IllegalArgumentException.class);
        ObjectNode capacityChange = request("reserve").put("captureBytes", CAPTURE_BYTES + 1);
        assertThatThrownBy(() -> store.apply(capacityChange, WRITER_TOKEN, PUBLICATION_TOKEN)).hasMessageContaining("replay");
        ObjectNode changed = request("reserve");
        ((ObjectNode) changed.get("binding")).put("publicationId", "pub-2");
        ObjectNode duplicate = changed;
        assertThatThrownBy(() -> store.apply(duplicate, WRITER_TOKEN, PUBLICATION_TOKEN))
                .hasMessageContaining("Broker execution identity conflicts");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_publication", Integer.class)).isEqualTo(1);
    }

    @Test
    void refusesMissingChangedAndCorruptAuthoritativeEvidence() {
        binding.put("modelCallId", "other-model");
        assertThatThrownBy(this::reserve).hasMessageContaining("Checkpoint execution");
        binding.put("modelCallId", "model-1");
        binding.put("bindingGeneration", "2");
        assertThatThrownBy(this::reserve).hasMessageContaining("Broker execution");
        binding.put("bindingGeneration", "1");
        jdbc.update("UPDATE qwen_managed_session_resource SET inline_bytes = ? WHERE resource_id = 'args-1'",
                "{}".getBytes(StandardCharsets.UTF_8));
        assertThatThrownBy(this::reserve).isInstanceOf(RuntimeException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_publication", Integer.class)).isZero();
    }

    @Test
    void blockedRecoveryMayFenceButCannotReserveOrRenew() {
        reserve();
        jdbc.update("UPDATE qwen_managed_session_journal_head SET recovery_status = 'BLOCKED_EXECUTION'");
        assertThatThrownBy(this::reserve).hasMessageContaining("recovery is blocked");
        assertThatThrownBy(() -> store.apply(request("renew"), WRITER_TOKEN, PUBLICATION_TOKEN))
                .hasMessageContaining("recovery is blocked");
        assertThat(store.apply(request("fence"), WRITER_TOKEN, null).path("state").asText()).isEqualTo("FENCED");
    }

    @Test
    void sameEpochReleasePreventsReserveAndRenew() {
        reserve();
        append("activation.release", event(3, "activation.changed", activation("released")) + "{}\n", 1,
                List.of(resource(binding.get("checkpointRef"), checkpoint)), "checkpoint-1");
        assertThatThrownBy(this::reserve).hasMessageContaining("Activation is not active");
        assertThatThrownBy(() -> store.apply(request("renew"), WRITER_TOKEN, PUBLICATION_TOKEN))
                .hasMessageContaining("Activation is not active");
    }

    @Test
    void fencesWithoutFreeingCapacityAndRequiresDurableNoStart() {
        reserve();
        assertThat(store.apply(request("fence"), WRITER_TOKEN, null).path("state").asText()).isEqualTo("FENCED");
        assertThatThrownBy(() -> store.apply(request("renew"), WRITER_TOKEN, PUBLICATION_TOKEN)).hasMessageContaining("fenced");
        assertThatThrownBy(() -> store.apply(request("close_not_started"), WRITER_TOKEN, null))
                .hasMessageContaining("not-started proof");
        var original = executions.findByExecutionCallId("execution-1");
        executions.requestCancel(original.getExecutionCallId(), original.getVersion());
        JsonNode closed = store.apply(request("close_not_started"), WRITER_TOKEN, null);
        assertThat(closed.path("state").asText()).isEqualTo("NOT_STARTED");
        assertThat(store.apply(request("close_not_started"), WRITER_TOKEN, null)).isEqualTo(closed);
        assertThat(store.apply(request("fence"), WRITER_TOKEN, null)).isEqualTo(closed);
        assertThatThrownBy(this::reserve).hasMessageContaining("fenced");
    }

    @Test
    void replacementWriterMayFenceButCannotRenewOriginalPublication() {
        reserve();
        jdbc.update("UPDATE qwen_managed_session_journal_head SET writer_lease_until = TIMESTAMP '2000-01-01 00:00:00'");
        new TransactionTemplate(manager).executeWithoutResult(status -> sessions.acquireWriter("tenant-1", "session-1",
                "b".repeat(32), new ManagedSessionStoreModels.AcquireWriterRequest("workspace-1", "writer-2", 300000L)));
        assertThatThrownBy(() -> store.apply(request("renew"), WRITER_TOKEN, PUBLICATION_TOKEN)).isInstanceOf(RuntimeException.class);
        ObjectNode replacement = request("renew");
        replacement.set("owner", JSON.createObjectNode().put("writerId", "writer-2").put("writerGeneration", 2));
        assertThatThrownBy(() -> store.apply(replacement, "b".repeat(32), PUBLICATION_TOKEN)).hasMessageContaining("Original writer");
        replacement.put("operation", "fence");
        assertThat(store.apply(replacement, "b".repeat(32), null).path("state").asText()).isEqualTo("FENCED");
    }

    @Test
    void concurrentReplayChargesOnceAndCapacityIncludesMetadata() throws Exception {
        store = newStore(ALLOCATION, 1);
        CountDownLatch start = new CountDownLatch(1);
        try (var pool = Executors.newFixedThreadPool(2)) {
            var one = pool.submit(() -> { start.await(); return reserve(); });
            var two = pool.submit(() -> { start.await(); return reserve(); });
            start.countDown();
            assertThat(one.get()).isEqualTo(two.get());
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_publication", Integer.class)).isEqualTo(1);
        jdbc.update("DELETE FROM qwen_tool_publication");
        store = newStore(ALLOCATION - 1, 1);
        assertThatThrownBy(this::reserve).hasMessageContaining("capacity exhausted");
        store = newStore(ALLOCATION, 1);
        assertThat(reserve().path("captureBytes").asLong()).isEqualTo(CAPTURE_BYTES);
    }

    @Test
    void refusesFirstReservationAfterDispatchHasBeenClaimed() {
        var execution = executions.claimDispatch("execution-1", "dispatcher", java.time.Duration.ofMinutes(1));
        assertThat(execution).isNotNull();
        assertThatThrownBy(this::reserve).hasMessageContaining("before dispatch");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_publication", Integer.class)).isZero();
    }

    @Test
    void originalReservationRemainsUsableWhileExecutionIsRunning() {
        JsonNode original = reserve();
        var execution = executions.claimDispatch("execution-1", "dispatcher", java.time.Duration.ofMinutes(1));
        assertThat(executions.compareAndSet(execution, execution.withState(ToolExecutionRecord.State.EXECUTING, false),
                "dispatcher", execution.getDispatchGeneration())).isNotNull();
        assertThat(reserve()).isEqualTo(original);
        assertThat(store.apply(request("renew"), WRITER_TOKEN, PUBLICATION_TOKEN).path("bindingDigest"))
                .isEqualTo(original.path("bindingDigest"));
        var running = executions.findByExecutionCallId("execution-1");
        assertThat(executions.compareAndSet(running, running.withUnknown(),
                "dispatcher", running.getDispatchGeneration())).isNotNull();
        assertThat(reserve()).isEqualTo(original);
        assertThat(store.apply(request("renew"), WRITER_TOKEN, PUBLICATION_TOKEN).path("bindingDigest"))
                .isEqualTo(original.path("bindingDigest"));
    }

    @Test
    void renewsOriginalBindingWhenAnotherToolAdvancesTheWaitCheckpoint() {
        JsonNode original = reserve();
        ObjectNode originalBinding = binding.deepCopy();
        addSecondExecution();
        JsonNode renewed = store.apply(request("renew"), WRITER_TOKEN, PUBLICATION_TOKEN);
        assertThat(renewed.path("bindingDigest")).isEqualTo(original.path("bindingDigest"));
        ObjectNode replay = request("reserve");
        replay.set("binding", originalBinding);
        assertThat(store.apply(replay, WRITER_TOKEN, PUBLICATION_TOKEN).path("bindingDigest"))
                .isEqualTo(original.path("bindingDigest"));
        ObjectNode next = checkpoint.deepCopy();
        ((ObjectNode) next.path("tools").path("items").get(0)).put("state", "settled");
        JsonNode nextRef = ref("checkpoint-3", "managed-checkpoint", next);
        append("tool.wait", event(4, "checkpoint.saved", JSON.createObjectNode()) + "{}\n", 1,
                List.of(resource(nextRef, next)), "checkpoint-3");
        assertThatThrownBy(() -> store.apply(request("renew"), WRITER_TOKEN, PUBLICATION_TOKEN))
                .hasMessageContaining("Checkpoint execution");
    }

    @Test
    void cannotAdoptAnUnreservedIntentFromAnEarlierWriter() {
        jdbc.update("UPDATE qwen_managed_session_journal_head SET writer_lease_until = TIMESTAMP '2000-01-01 00:00:00'");
        new TransactionTemplate(manager).executeWithoutResult(status -> sessions.acquireWriter("tenant-1", "session-1",
                "b".repeat(32), new ManagedSessionStoreModels.AcquireWriterRequest("workspace-1", "writer-2", 300000L)));
        ObjectNode candidate = request("reserve");
        ((ObjectNode) candidate.get("binding")).put("writerId", "writer-2").put("writerGeneration", 2);
        candidate.set("owner", JSON.createObjectNode().put("writerId", "writer-2").put("writerGeneration", 2));
        assertThatThrownBy(() -> store.apply(candidate, "b".repeat(32), PUBLICATION_TOKEN))
                .hasMessageContaining("Original intent writer");
    }

    @Test
    void concurrentDistinctReservationsCannotOversubscribeAndOnlyNoStartFreesCapacity() throws Exception {
        ObjectNode second = addSecondExecution();
        store = newStore(ALLOCATION, 10);
        ObjectNode firstRequest = request("reserve");
        ObjectNode secondRequest = request("reserve");
        secondRequest.set("binding", second);
        CountDownLatch start = new CountDownLatch(1);
        List<Object> outcomes;
        try (var pool = Executors.newFixedThreadPool(2)) {
            var one = pool.submit(() -> attempt(start, firstRequest));
            var two = pool.submit(() -> attempt(start, secondRequest));
            start.countDown();
            outcomes = List.of(one.get(), two.get());
        }
        assertThat(outcomes.stream().filter(JsonNode.class::isInstance).count()).isEqualTo(1);
        assertThat(outcomes.stream().filter(IllegalArgumentException.class::isInstance).count()).isEqualTo(1);
        String winner = jdbc.queryForObject("SELECT publication_id FROM qwen_tool_publication", String.class);
        ObjectNode loser = "pub-1".equals(winner) ? secondRequest : firstRequest;
        ObjectNode fence = request("fence").put("publicationId", winner);
        store.apply(fence, WRITER_TOKEN, null);
        assertThatThrownBy(() -> store.apply(loser, WRITER_TOKEN, PUBLICATION_TOKEN)).hasMessageContaining("capacity exhausted");
        String executionId = "pub-1".equals(winner) ? "execution-1" : "execution-2";
        var execution = executions.findByExecutionCallId(executionId);
        executions.requestCancel(executionId, execution.getVersion());
        fence.put("operation", "close_not_started");
        store.apply(fence, WRITER_TOKEN, null);
        store.apply(fence, WRITER_TOKEN, null);
        assertThat(store.apply(loser, WRITER_TOKEN, PUBLICATION_TOKEN).path("state").asText()).isEqualTo("OPEN");
    }

    private Object attempt(CountDownLatch start, JsonNode request) throws InterruptedException {
        start.await();
        try {
            return store.apply(request, WRITER_TOKEN, PUBLICATION_TOKEN);
        } catch (IllegalArgumentException error) {
            return error;
        }
    }

    private ObjectNode addSecondExecution() {
        ObjectNode second = binding.deepCopy().put("publicationId", "pub-2").put("executionCallId", "execution-2")
                .put("captureId", "capture-2").put("modelCallId", "model-2").put("intentSequence", 3);
        ((ObjectNode) second.get("reference")).put("callId", "runtime-call-2");
        ObjectNode nextCheckpoint = checkpoint.deepCopy();
        ((ObjectNode) nextCheckpoint.get("identity")).put("coveredSequence", 3);
        ObjectNode item = nextCheckpoint.path("tools").path("items").get(0).deepCopy();
        item.put("executionCallId", "execution-2").put("functionCallId", "model-2");
        ((com.fasterxml.jackson.databind.node.ArrayNode) nextCheckpoint.path("tools").path("items")).add(item);
        checkpoint = nextCheckpoint;
        binding.set("checkpointRef", ref("checkpoint-2", "managed-checkpoint", checkpoint));
        second.set("checkpointRef", binding.get("checkpointRef"));
        ObjectNode intent = JSON.createObjectNode().put("executionCallId", "execution-2").put("outcomeSource", "runtime");
        intent.set("argsRef", binding.get("argsRef"));
        append("tool.dispatch", event(3, "tool.intent", intent) + "{}\n", 1,
                List.of(resource(binding.get("checkpointRef"), checkpoint)), "checkpoint-2");
        String digest = binding.path("requestDigest").asText();
        executions.findOrCreate(ToolExecutionRecord.prepared("execution-2", "idempotency-2", "binding-1", 1,
                "session-1", "runtime-1", "runtime-prompt-1", "runtime-call-2", digest,
                Map.of("sessionId", "runtime-1", "promptId", "runtime-prompt-1", "callId", "runtime-call-2",
                        "argsDigest", second.path("reference").path("argsDigest").asText(),
                        "payloadDigest", digest, "dispatchMode", "deferred_v3", "publicationId", "pub-2")));
        return second;
    }

    private ToolPublicationStore newStore(long bytes, long count) {
        return new ToolPublicationStore(jdbc, manager, sessions, executions, bindings,
                new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, bytes, bytes, count));
    }

    private JsonNode reserve() {
        return store.apply(request("reserve"), WRITER_TOKEN, PUBLICATION_TOKEN);
    }

    private ObjectNode request(String operation) {
        ObjectNode result = JSON.createObjectNode().put("publication", ToolPublicationContract.PROTOCOL)
                .put("operation", operation);
        result.set("sessionKey", binding.get("sessionKey").deepCopy());
        result.set("owner", JSON.createObjectNode().put("writerId", "writer-1").put("writerGeneration", 1));
        if ("reserve".equals(operation)) {
            result.set("binding", binding.deepCopy());
            result.put("captureBytes", CAPTURE_BYTES);
        } else {
            result.put("publicationId", "pub-1");
        }
        return result;
    }

    private ObjectNode activation(String phase) {
        return JSON.createObjectNode().put("activationId", "activation-1").put("epoch", 1)
                .put("phase", phase).put("expiresAt", System.currentTimeMillis() + 180000);
    }

    private String event(long number, String kind, JsonNode payload) {
        ObjectNode event = JSON.createObjectNode().put("v", 1).put("sequence", number).put("kind", kind);
        event.set("sessionKey", binding.get("sessionKey"));
        event.set("payload", payload);
        event.set("subject", JSON.createObjectNode().put("type", "activation").put("activationId", "activation-1").put("epoch", 1));
        return JSON.createObjectNode().put("subtype", "managed_session_event_v1").set("managedSession", event) + "\n";
    }

    private void append(String operation, String records, int events,
            List<ManagedSessionStoreModels.CommitResource> resources, String checkpointId) {
        String nextDigest = events == 0 ? null : digest(records);
        var request = new ManagedSessionStoreModels.CommitTransactionRequest("workspace-1", "writer-1", 1,
                revision, sequence, "transaction-" + revision, operation, "command-" + revision, digest(records),
                events == 0 ? 0 : sequence + 1, sequence + events, events, nextDigest, commitDigest, nextDigest,
                events == 0 ? 0 : 1, checkpointId, events == 0 ? 2 : events + 1,
                Base64.getEncoder().encodeToString(records.getBytes(StandardCharsets.UTF_8)), digest(records), resources);
        new TransactionTemplate(manager).executeWithoutResult(status -> sessions.commit("tenant-1", "session-1", WRITER_TOKEN, request));
        revision++;
        sequence += events;
        commitDigest = nextDigest;
    }

    private static ObjectNode ref(String id, String kind, JsonNode body) {
        return JSON.createObjectNode().put("resourceId", id).put("kind", kind).put("schemaVersion", 1)
                .put("byteLength", body.toString().getBytes(StandardCharsets.UTF_8).length).put("digest", digest(body.toString()));
    }

    private static ManagedSessionStoreModels.CommitResource resource(JsonNode ref, JsonNode body) {
        return new ManagedSessionStoreModels.CommitResource(ref.path("resourceId").asText(), ref.path("kind").asText(),
                1, ref.path("byteLength").asLong(), ref.path("digest").asText(),
                Base64.getEncoder().encodeToString(body.toString().getBytes(StandardCharsets.UTF_8)));
    }

    private static String digest(String value) {
        return ToolPublicationContract.sha256(value.getBytes(StandardCharsets.UTF_8));
    }
}
