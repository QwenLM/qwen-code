package com.alibaba.qwen.code.managedagent;

import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.ALLOCATION;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.CAPTURE_BYTES;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.COMMIT_MARKER;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.PUBLICATION_TOKEN;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.WRITER_TOKEN;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.checkpointPayload;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.digest;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.ref;
import static com.alibaba.qwen.code.managedagent.PublicationJournalFixture.resource;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.ApiException;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.service.ManagedArtifactPolicy;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.ManagedArtifactReader;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStore;
import com.alibaba.qwen.code.managedagent.store.ManagedSessionStoreModels;
import com.alibaba.qwen.code.managedagent.store.ManagedToolResultProjector;
import com.alibaba.qwen.code.managedagent.store.ManagedToolResultStore;
import com.alibaba.qwen.code.managedagent.store.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationAdmissionStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationContract;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationDataStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationObjectStore;
import com.alibaba.qwen.code.managedagent.store.ToolPublicationStore;
import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiRegistration;
import com.alibaba.qwen.code.managedagent.store.WorkspaceCsiReservationStore;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.flywaydb.core.Flyway;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
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

class ToolPublicationStoreTest {
    private static final String MARKER = COMMIT_MARKER;
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final ToolPublicationDataStore.VerificationBudget VERIFICATION_BUDGET =
            new ToolPublicationDataStore.VerificationBudget(16 * 1024 * 1024, Duration.ofMinutes(25));
    private PublicationJournalFixture journal;
    private JdbcTemplate jdbc;
    private DataSourceTransactionManager manager;
    private ManagedSessionStore sessions;
    private ManagedToolResultStore publicResults;
    private ManagedAgentStore publicSessions;
    private ManagedAgentProperties projectionProperties;
    private ManagedWorkspaceRegistry publicWorkspaces;
    private ManagedArtifactReader apiReader;
    private Map<String, byte[]> apiObjects;
    private String apiFailNextObject;
    private ToolPublicationDataStore apiPublications;
    private boolean keepApiFixture;
    private boolean quarantineBeforeProjection;
    private JdbcRuntimeBindingRepository bindings;
    private JdbcToolExecutionRepository executions;
    private ToolPublicationStore store;
    private ObjectNode binding;
    private JsonNode checkpoint;
    private WorkspaceCsiReservationStore csiStore;
    private WorkspaceCsiRegistration csiRegistration;
    private WorkspaceCsiReservationStore.Reservation csiReservation;

    @BeforeEach
    void setup() {
        initialize(publicationDataSource());
    }

    private void initialize(javax.sql.DataSource source) {
        initialize(source, false);
    }

    private void initialize(javax.sql.DataSource source, boolean csiWorkspace) {
        Flyway.configure().dataSource(source).load().migrate();
        csiRegistration = csiWorkspace
                ? new WorkspaceCsiRegistration("tenant-1", "fixture-storage", "fixture-cluster",
                        "fixture", "fixture-claim", "fixture-pvc", "fixture-volume", "fixture-pv",
                        "fixture.csi", "fixture-handle", "fixture-backend", "fixture-serial", "/workspace", 1)
                : null;
        journal = PublicationJournalFixture.create(source, false, csiRegistration);
        jdbc = journal.jdbc;
        manager = journal.manager;
        sessions = journal.sessions;
        bindings = journal.bindings;
        executions = journal.executions;
        store = journal.store;
        binding = journal.binding;
        checkpoint = journal.checkpoint;
        csiStore = csiWorkspace ? new WorkspaceCsiReservationStore(jdbc, manager, JSON) : null;
        csiReservation = journal.csiReservation;
        projectionProperties = new ManagedAgentProperties();
        projectionProperties.getArtifacts().setEnabled(true);
        publicWorkspaces = org.mockito.Mockito.mock(ManagedWorkspaceRegistry.class);
        publicSessions = new ManagedAgentStore(jdbc, JSON, java.time.Clock.systemUTC(), events -> {},
                publicWorkspaces, projectionProperties);
        publicResults = new ManagedToolResultStore(jdbc, manager, publicSessions);
        sessions.setToolResults(publicResults);
    }

    javax.sql.DataSource publicationDataSource() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:publication-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE;LOCK_TIMEOUT=10000");
        return source;
    }

    @ParameterizedTest
    @CsvSource({"0.5,false", "1.0,false", "0.0,false", "-0.0,false",
            "0.5,true", "1.0,true", "0.0,true", "-0.0,true"})
    void csiOriginalProducerFinishesBlockedCaptureAndCreatesItsFirstCandidateAfterSeal(
            double score, boolean journalHeadAuthorization) {
        var execution = authorizeCsi(journalHeadAuthorization);
        retireCsi();
        var objects = new java.util.HashMap<String, byte[]>();
        var data = csiData(objects);
        byte[] output = "original".getBytes(StandardCharsets.UTF_8);
        data.publishSegment(binding.get("sessionKey"), "pub-1", PUBLICATION_TOKEN,
                "segment-0", "stdout", 0, output, digest("original"));
        JsonNode terminal = blockedTerminal();
        ((ObjectNode) terminal.path("responseParts").get(0)).put("score", score);
        data.finish(binding.get("sessionKey"), "pub-1", PUBLICATION_TOKEN, "finish-1",
                terminal.toString().getBytes(StandardCharsets.UTF_8));
        assertThat(data.finishedForBroker(execution).path("result")).isEqualTo(terminal);
        execution = executions.compareAndSet(execution, execution.withResult(
                JSON.convertValue(terminal, new com.fasterxml.jackson.core.type.TypeReference<Map<String, Object>>() {}),
                0, Instant.now()), "dispatcher", execution.getDispatchGeneration());
        assertThat(execution.getState()).isEqualTo(ToolExecutionRecord.State.SETTLED);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_publication_object WHERE slot_key = 'admission'",
                Integer.class)).isZero();
        JsonNode outcome = blockedOutcome(terminal);
        JsonNode candidate = data.prepareAdmission(binding.get("sessionKey"), "pub-1", "writer-1", 1,
                WRITER_TOKEN, outcome);
        assertThat(data.prepareAdmission(binding.get("sessionKey"), "pub-1", "writer-1", 1,
                WRITER_TOKEN, outcome)).isEqualTo(candidate);
        assertThat(csiStore.inspect(csiRegistration).phase()).isEqualTo("DRAINING");
        assertThat(jdbc.queryForObject("SELECT active_binding_id FROM qwen_runtime_binding_slot", String.class))
                .isEqualTo("binding-1");
    }

    @ParameterizedTest
    @ValueSource(strings = {"0.6", "0.50000000000000000001"})
    void csiCandidateRefusesAChangedSettledNumericResult(String score) {
        var execution = authorizeCsi();
        retireCsi();
        var data = csiData(new java.util.HashMap<>());
        JsonNode terminal = blockedTerminal();
        data.finish(binding.get("sessionKey"), "pub-1", PUBLICATION_TOKEN, "finish-1",
                terminal.toString().getBytes(StandardCharsets.UTF_8));
        Map<String, Object> changed = JSON.convertValue(terminal,
                new com.fasterxml.jackson.core.type.TypeReference<Map<String, Object>>() {});
        changed.put("responseParts", List.of(Map.of("score", new java.math.BigDecimal(score))));
        execution = executions.compareAndSet(execution, execution.withResult(changed, 0, Instant.now()),
                "dispatcher", execution.getDispatchGeneration());
        assertThat(execution.getState()).isEqualTo(ToolExecutionRecord.State.SETTLED);
        var before = jdbc.queryForMap("SELECT * FROM qwen_tool_publication");
        assertThatThrownBy(() -> data.prepareAdmission(binding.get("sessionKey"), "pub-1", "writer-1", 1,
                WRITER_TOKEN, blockedOutcome(terminal)))
                .hasMessageContaining("Original settled Broker result conflicts");
        assertThat(jdbc.queryForMap("SELECT * FROM qwen_tool_publication")).isEqualTo(before);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_publication_object WHERE slot_key = 'admission'",
                Integer.class)).isZero();
    }

    @Test
    void csiSettledProducerOnlyReplaysItsOriginalSucceededOperation() {
        var execution = authorizeCsi();
        retireCsi();
        var data = csiData(new java.util.HashMap<>());
        byte[] output = "original".getBytes(StandardCharsets.UTF_8);
        JsonNode receipt = data.publishSegment(binding.get("sessionKey"), "pub-1", PUBLICATION_TOKEN,
                "segment-0", "stdout", 0, output, digest("original"));
        JsonNode terminal = blockedTerminal();
        JsonNode finish = data.finish(binding.get("sessionKey"), "pub-1", PUBLICATION_TOKEN, "finish-1",
                terminal.toString().getBytes(StandardCharsets.UTF_8));
        executions.compareAndSet(execution, execution.withResult(
                JSON.convertValue(terminal, new com.fasterxml.jackson.core.type.TypeReference<Map<String, Object>>() {}),
                0, Instant.now()), "dispatcher", execution.getDispatchGeneration());
        var before = jdbc.queryForList("SELECT * FROM qwen_tool_publication_operation ORDER BY operation_id");
        var publication = jdbc.queryForMap("SELECT * FROM qwen_tool_publication");
        assertThat(data.publishSegment(binding.get("sessionKey"), "pub-1", PUBLICATION_TOKEN,
                "segment-0", "stdout", 0, output, digest("original"))).isEqualTo(receipt);
        assertThat(data.finish(binding.get("sessionKey"), "pub-1", PUBLICATION_TOKEN, "finish-1",
                terminal.toString().getBytes(StandardCharsets.UTF_8))).isEqualTo(finish);
        assertThatThrownBy(() -> data.publishSegment(binding.get("sessionKey"), "pub-1", PUBLICATION_TOKEN,
                "new-operation", "stdout", 0, output, digest("original"))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> data.prefix(binding.get("sessionKey"), "pub-1", PUBLICATION_TOKEN,
                "new-prefix", "stdout")).isInstanceOf(IllegalArgumentException.class);
        assertThat(jdbc.queryForList("SELECT * FROM qwen_tool_publication_operation ORDER BY operation_id")).isEqualTo(before);
        assertThat(jdbc.queryForMap("SELECT * FROM qwen_tool_publication")).isEqualTo(publication);
    }

    @ParameterizedTest
    @CsvSource({"marker,false", "journal,false", "unknown,false", "grant,false",
            "marker,true", "journal,true", "unknown,true", "grant,true"})
    void csiTailRefusesMissingOrClosedOriginalAuthority(String damage, boolean journalHeadAuthorization) {
        var execution = authorizeCsi(journalHeadAuthorization);
        retireCsi();
        if ("marker".equals(damage)) {
            jdbc.update("UPDATE qwen_tool_execution SET authorized_dispatch_generation = NULL, authorized_binding_version = NULL");
        } else if ("journal".equals(damage)) {
            jdbc.update("DELETE FROM managed_workspace_csi_retirement");
        } else if ("unknown".equals(damage)) {
            executions.compareAndSet(execution, execution.withUnknown(), "dispatcher", execution.getDispatchGeneration());
        } else {
            jdbc.update("UPDATE qwen_tool_publication SET expires_at = 0");
        }
        var data = csiData(new java.util.HashMap<>());
        var before = jdbc.queryForMap("SELECT * FROM qwen_tool_publication");
        assertThatThrownBy(() -> data.publishSegment(binding.get("sessionKey"), "pub-1", PUBLICATION_TOKEN,
                "segment-0", "stdout", 0, new byte[] {1}, null))
                .isInstanceOf(RuntimeException.class);
        assertThat(jdbc.queryForMap("SELECT * FROM qwen_tool_publication")).isEqualTo(before);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_publication_operation", Integer.class)).isZero();
        assertThat(csiStore.inspect(csiRegistration).phase()).isEqualTo("DRAINING");
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void csiSealRefusesNewGrantReserveRenewAndInstallation(boolean journalHeadAuthorization) {
        var execution = authorizeCsi(journalHeadAuthorization);
        retireCsi();
        var before = jdbc.queryForMap("SELECT * FROM qwen_tool_publication");
        assertThatThrownBy(this::reserve).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> store.apply(request("renew"), WRITER_TOKEN, PUBLICATION_TOKEN))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> store.verifyDispatch(execution, "pub-1", PUBLICATION_TOKEN))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(jdbc.queryForMap("SELECT * FROM qwen_tool_publication")).isEqualTo(before);
    }

    @Test
    void csiStagedProducerRefusesAmbientTransactionBeforeObjectWrites() {
        authorizeCsi();
        var objects = new java.util.HashMap<String, byte[]>();
        var data = csiData(objects);
        assertThatThrownBy(() -> new TransactionTemplate(manager).execute(status -> data.publishSegment(
                binding.get("sessionKey"), "pub-1", PUBLICATION_TOKEN, "segment-0", "stdout", 0,
                new byte[] {1}, null))).hasMessageContaining("ambient transaction");
        assertThat(objects).isEmpty();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_publication_operation", Integer.class)).isZero();
    }

    private ToolExecutionRecord authorizeCsi() {
        return authorizeCsi(false);
    }

    private ToolExecutionRecord authorizeCsi(boolean journalHeadAuthorization) {
        initialize(publicationDataSource(), true);
        store = newStore(10 * ALLOCATION, 10, journalHeadAuthorization);
        reserve();
        var prepared = executions.findByExecutionCallId("execution-1");
        assertThat(store.verifyDispatch(prepared, "pub-1", PUBLICATION_TOKEN)).isEqualTo(binding);
        var claim = executions.claimDispatch("execution-1", "dispatcher", Duration.ofMinutes(1));
        return bindings.authorizeDispatch(new JdbcRuntimeSessionRepository(manager.getDataSource()), executions,
                claim, "dispatcher", claim.getDispatchGeneration());
    }

    private void retireCsi() {
        csiStore.beginRetirement(csiRegistration, bindings, bindings.findById("binding-1"), csiReservation,
                UUID.randomUUID().toString());
    }

    private ToolPublicationDataStore csiData(Map<String, byte[]> objects) {
        ToolPublicationObjectStore bucket = new ToolPublicationObjectStore() {
            @Override
            public void putIfAbsent(String key, byte[] bytes) { objects.putIfAbsent(key, bytes.clone()); }
            @Override
            public InputStream open(String key) { return new ByteArrayInputStream(objects.get(key)); }
            @Override
            public void requireUnversioned() { }
        };
        return new ToolPublicationDataStore(jdbc, manager, store, sessions, bucket,
                Duration.ofMinutes(2), Duration.ofSeconds(30), VERIFICATION_BUDGET);
    }

    private static JsonNode blockedTerminal() {
        ObjectNode result = JSON.createObjectNode().put("executionStatus", "success");
        result.putArray("responseParts").addObject().put("score", 0.5);
        result.set("capture", JSON.createObjectNode().put("captureStatus", "unavailable")
                .put("captureReason", "storage_failed").put("previewTruncated", false)
                .put("deliveryStatus", "pending").putNull("manifest"));
        return result;
    }

    private static JsonNode blockedOutcome(JsonNode terminal) {
        ObjectNode outcome = JSON.createObjectNode().put("schemaVersion", 1).put("decision", "blocked").putNull("manifestRef");
        outcome.set("envelope", terminal);
        ObjectNode history = JSON.createObjectNode().put("messageId", UUID.randomUUID().toString())
                .put("timestamp", Instant.now().toString()).put("model", "fixture");
        history.putArray("parts");
        outcome.set("history", history);
        return outcome;
    }

    @Test
    void finishPreservesTheSubmittedTerminalBytes() {
        reserve();
        ToolPublicationObjectStore bucket = new ToolPublicationObjectStore() {
            @Override
            public void putIfAbsent(String key, byte[] bytes) { throw new AssertionError("Unexpected OSS write"); }

            @Override
            public InputStream open(String key) { throw new AssertionError("Unexpected OSS read"); }

            @Override
            public void requireUnversioned() { }
        };
        var data = new ToolPublicationDataStore(jdbc, manager, store, sessions, bucket,
                Duration.ofMinutes(2), Duration.ofSeconds(30), VERIFICATION_BUDGET);
        ObjectNode capture = JSON.createObjectNode().put("captureStatus", "unavailable")
                .put("captureReason", "storage_failed").put("previewTruncated", false)
                .put("deliveryStatus", "pending").putNull("manifest");
        ObjectNode envelope = JSON.createObjectNode().put("executionStatus", "success");
        envelope.putArray("responseParts").add("\b\u000b\u001f");
        envelope.set("capture", capture);
        String jackson = envelope.toString();
        String submitted = jackson.replace("\\u000B", "\\u000b").replace("\\u001F", "\\u001f");
        assertThat(submitted).isNotEqualTo(jackson);
        byte[] bytes = submitted.getBytes(StandardCharsets.UTF_8);
        JsonNode receipt = data.finish(binding.get("sessionKey"), "pub-1", PUBLICATION_TOKEN,
                "finish-raw", bytes);
        assertThat(receipt.path("terminal").path("digest").asText()).isEqualTo(digest(submitted));
        assertThat(data.finished(binding.get("sessionKey"), "pub-1", WRITER_TOKEN).path("result"))
                .isEqualTo(envelope);
    }

    @Test
    void failedObjectWriteExposesRetryableOriginalOperation() {
        reserve();
        Map<String, byte[]> objects = new java.util.HashMap<>();
        java.util.concurrent.atomic.AtomicInteger writes = new java.util.concurrent.atomic.AtomicInteger();
        ToolPublicationObjectStore bucket = new ToolPublicationObjectStore() {
            @Override
            public void putIfAbsent(String key, byte[] bytes) {
                if (writes.incrementAndGet() == 1) {
                    throw new IllegalStateException("temporary object-store failure");
                }
                objects.putIfAbsent(key, bytes.clone());
            }

            @Override
            public InputStream open(String key) {
                return new ByteArrayInputStream(objects.get(key));
            }

            @Override
            public void requireUnversioned() { }
        };
        var data = new ToolPublicationDataStore(jdbc, manager, store, sessions, bucket,
                Duration.ofMinutes(2), Duration.ofSeconds(30), VERIFICATION_BUDGET);
        JsonNode key = binding.get("sessionKey");
        byte[] bytes = "retry".getBytes(StandardCharsets.UTF_8);
        assertThatThrownBy(() -> data.publishSegment(key, "pub-1", PUBLICATION_TOKEN,
                "original-operation", "stdout", 0, bytes, digest("retry")))
                .hasMessageContaining("temporary object-store failure");
        assertThat(data.operationStatus(key, "pub-1", PUBLICATION_TOKEN, "original-operation")
                .path("state").asText()).isEqualTo("RETRYABLE");
        assertThat(data.publishSegment(key, "pub-1", PUBLICATION_TOKEN,
                "original-operation", "stdout", 0, bytes, digest("retry"))
                .path("ordinal").asInt()).isZero();
        assertThat(writes.get()).isEqualTo(2);
        store.apply(request("fence"), WRITER_TOKEN, null);
        var held = jdbc.queryForMap("SELECT capture_held_bytes, capture_used_bytes,"
                + " producer_held_bytes, producer_used_bytes, admission_held_bytes"
                + " FROM qwen_tool_publication WHERE publication_id = 'pub-1'");
        assertThat(((Number) held.get("capture_held_bytes")).longValue()).isEqualTo(bytes.length);
        assertThat(((Number) held.get("capture_used_bytes")).longValue()).isEqualTo(bytes.length);
        assertThat(((Number) held.get("producer_held_bytes")).longValue()).isZero();
        assertThat(((Number) held.get("producer_used_bytes")).longValue()).isZero();
        assertThat(((Number) held.get("admission_held_bytes")).longValue()).isZero();
    }

    @org.junit.jupiter.params.ParameterizedTest
    @org.junit.jupiter.params.provider.ValueSource(booleans = {false, true})
    void recoversExpiredCandidatesWithoutChangingBytesQuotaOrOriginalDeadline(boolean terminal) throws Exception {
        reserve();
        Map<String, byte[]> objects = new java.util.concurrent.ConcurrentHashMap<>();
        CountDownLatch written = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        var writes = new java.util.concurrent.atomic.AtomicInteger();
        ToolPublicationObjectStore bucket = new ToolPublicationObjectStore() {
            @Override
            public void putIfAbsent(String key, byte[] bytes) {
                objects.putIfAbsent(key, bytes.clone());
                if (writes.incrementAndGet() == 1) {
                    written.countDown();
                    try {
                        if (!release.await(10, java.util.concurrent.TimeUnit.SECONDS)) {
                            throw new IllegalStateException("Test writer did not resume");
                        }
                    } catch (InterruptedException error) {
                        Thread.currentThread().interrupt();
                        throw new IllegalStateException(error);
                    }
                }
            }

            @Override
            public InputStream open(String key) { return new ByteArrayInputStream(objects.get(key)); }

            @Override
            public void requireUnversioned() { }
        };
        var recoveryBudget = new ToolPublicationDataStore.VerificationBudget(256, Duration.ofMinutes(25));
        var first = new ToolPublicationDataStore(jdbc, manager, store, sessions, bucket,
                Duration.ofMinutes(2), Duration.ofSeconds(30), recoveryBudget);
        var replacement = new ToolPublicationDataStore(jdbc, manager, store, sessions, bucket,
                Duration.ofMinutes(2), Duration.ofSeconds(30), recoveryBudget);
        JsonNode key = binding.get("sessionKey");
        ObjectNode capture = JSON.createObjectNode().put("captureStatus", "unavailable")
                .put("captureReason", "storage_failed").put("previewTruncated", false)
                .put("deliveryStatus", "pending").putNull("manifest");
        ObjectNode envelope = JSON.createObjectNode().put("executionStatus", "success");
        envelope.putArray("responseParts").add("x".repeat(100_000));
        envelope.set("capture", capture);
        byte[] bytes = terminal ? envelope.toString().getBytes(StandardCharsets.UTF_8)
                : "abc".getBytes(StandardCharsets.UTF_8);
        try (var pool = Executors.newSingleThreadExecutor()) {
            var old = pool.submit(() -> terminal
                    ? first.finish(key, "pub-1", PUBLICATION_TOKEN, "original", bytes)
                    : first.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "original", "stdout", 0, bytes, null));
            try {
                assertThat(written.await(10, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                jdbc.update("UPDATE qwen_tool_publication_operation SET deadline ="
                        + " TIMESTAMPADD(SECOND, -1, CURRENT_TIMESTAMP(6)) WHERE operation_id = 'original'");
                var originalDeadline = jdbc.queryForObject("SELECT deadline FROM qwen_tool_publication_operation"
                        + " WHERE operation_id = 'original'", java.sql.Timestamp.class);
                var before = jdbc.queryForMap("SELECT object_key, resource_id, byte_length, sha256, operation_id"
                        + " FROM qwen_tool_publication_object WHERE publication_id = 'pub-1'");
                assertThat(replacement.operationStatus(key, "pub-1", PUBLICATION_TOKEN, "original")
                        .path("state").asText()).isEqualTo("EXPIRED");
                assertThatThrownBy(() -> {
                    if (terminal) {
                        replacement.finish(key, "pub-1", PUBLICATION_TOKEN, "original", bytes);
                    } else {
                        replacement.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "original", "stdout", 0, bytes, null);
                    }
                }).isInstanceOfSatisfying(ApiException.class, error ->
                        assertThat(error.getCode()).isEqualTo("managed_tool_publication_operation_expired"));
                var recoveryStarted = jdbc.queryForObject("SELECT CURRENT_TIMESTAMP(6)", java.sql.Timestamp.class);
                assertThat(replacement.recoverOperation(key, "pub-1", PUBLICATION_TOKEN, "original")
                        .path("state").asText()).isEqualTo("RETRYABLE");
                var recoveryFinished = jdbc.queryForObject("SELECT CURRENT_TIMESTAMP(6)", java.sql.Timestamp.class);
                var recoveryDeadline = jdbc.queryForObject("SELECT recovery_deadline FROM qwen_tool_publication_operation"
                        + " WHERE operation_id = 'original'", java.sql.Timestamp.class);
                long recoveryWindowMillis = Duration.ofMinutes(2)
                        .plusSeconds(terminal ? (bytes.length + 255L) / 256 : 0).toMillis();
                assertThat(recoveryDeadline.getTime()).isBetween(
                        recoveryStarted.getTime() / 1000 * 1000 + recoveryWindowMillis,
                        recoveryFinished.getTime() + recoveryWindowMillis);
                replacement.recoverOperation(key, "pub-1", PUBLICATION_TOKEN, "original");
                assertThat(jdbc.queryForObject("SELECT recovery_deadline FROM qwen_tool_publication_operation"
                        + " WHERE operation_id = 'original'", java.sql.Timestamp.class)).isEqualTo(recoveryDeadline);
                assertThatThrownBy(() -> {
                    if (terminal) {
                        replacement.finish(key, "pub-1", PUBLICATION_TOKEN, "other", bytes);
                    } else {
                        replacement.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "other", "stdout", 0, bytes, null);
                    }
                }).isInstanceOf(IllegalArgumentException.class);
                byte[] changed = bytes.clone();
                changed[changed.length - 2] = 'y';
                assertThatThrownBy(() -> {
                    if (terminal) {
                        ObjectNode other = envelope.deepCopy().put("executionStatus", "error");
                        replacement.finish(key, "pub-1", PUBLICATION_TOKEN, "original",
                                other.toString().getBytes(StandardCharsets.UTF_8));
                    } else {
                        replacement.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "original", "stdout", 0, changed, null);
                    }
                }).isInstanceOf(IllegalArgumentException.class);
                JsonNode receipt = terminal
                        ? replacement.finish(key, "pub-1", PUBLICATION_TOKEN, "original", bytes)
                        : replacement.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "original", "stdout", 0, bytes, null);
                release.countDown();
                assertThatThrownBy(() -> old.get(10, java.util.concurrent.TimeUnit.SECONDS))
                        .hasCauseInstanceOf(ApiException.class);
                assertThat(replacement.operationStatus(key, "pub-1", PUBLICATION_TOKEN, "original")
                        .path("receipt")).isEqualTo(receipt);
                assertThat(jdbc.queryForMap("SELECT object_key, resource_id, byte_length, sha256, operation_id"
                        + " FROM qwen_tool_publication_object WHERE publication_id = 'pub-1'")).isEqualTo(before);
                assertThat(jdbc.queryForObject("SELECT deadline FROM qwen_tool_publication_operation"
                        + " WHERE operation_id = 'original'", java.sql.Timestamp.class)).isEqualTo(originalDeadline);
                assertThat(objects).hasSize(1);
                String category = terminal ? "producer" : "capture";
                assertThat(jdbc.queryForObject("SELECT " + category + "_used_bytes FROM qwen_tool_publication"
                        + " WHERE publication_id = 'pub-1'", Long.class)).isEqualTo((long) bytes.length);
                if (terminal) {
                    assertThat(replacement.finished(key, "pub-1", WRITER_TOKEN).path("result")).isEqualTo(envelope);
                } else {
                    replacement.seal(key, "pub-1", PUBLICATION_TOKEN, "seal-after-recovery", "stdout", 1,
                            bytes.length, ToolPublicationContract.sha256(bytes));
                }
            } finally {
                release.countDown();
            }
        }
    }

    @ParameterizedTest
    @CsvSource({"false,false", "false,true", "true,false", "true,true"})
    void resumesHeldWriteAfterDeadlineOrClaimExpiry(boolean terminal, boolean expired) throws Exception {
        reserve();
        var objects = new java.util.concurrent.ConcurrentHashMap<String, byte[]>();
        var entered = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        ToolPublicationObjectStore bucket = new ToolPublicationObjectStore() {
            @Override
            public void putIfAbsent(String key, byte[] bytes) {
                objects.putIfAbsent(key, bytes.clone());
                if (!terminal) hold();
            }

            private void hold() {
                entered.countDown();
                try {
                    if (!release.await(10, java.util.concurrent.TimeUnit.SECONDS)) {
                        throw new IllegalStateException("Held writer timed out");
                    }
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(error);
                }
            }

            @Override
            public InputStream open(String key) {
                if (terminal) hold();
                return new ByteArrayInputStream(objects.get(key));
            }

            @Override
            public void requireUnversioned() { }
        };
        var data = new ToolPublicationDataStore(jdbc, manager, store, sessions, bucket,
                Duration.ofMinutes(2), Duration.ofSeconds(30), VERIFICATION_BUDGET);
        JsonNode key = binding.get("sessionKey");
        ObjectNode capture = JSON.createObjectNode().put("captureStatus", "unavailable")
                .put("captureReason", "storage_failed").put("previewTruncated", false)
                .put("deliveryStatus", "pending").putNull("manifest");
        ObjectNode envelope = JSON.createObjectNode().put("executionStatus", "success");
        envelope.putArray("responseParts").add("x".repeat(100_000));
        envelope.set("capture", capture);
        byte[] bytes = terminal ? envelope.toString().getBytes(StandardCharsets.UTF_8)
                : "abc".getBytes(StandardCharsets.UTF_8);
        try (var pool = Executors.newSingleThreadExecutor()) {
            var old = pool.submit(() -> terminal
                    ? data.finish(key, "pub-1", PUBLICATION_TOKEN, "held", bytes)
                    : data.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "held", "stdout", 0, bytes, null));
            try {
                assertThat(entered.await(10, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                String column = expired ? "deadline" : "claim_until";
                jdbc.update("UPDATE qwen_tool_publication_operation SET " + column
                        + " = TIMESTAMPADD(SECOND, -1, CURRENT_TIMESTAMP(6)) WHERE operation_id = 'held'");
                assertThat(data.operationStatus(key, "pub-1", PUBLICATION_TOKEN, "held").path("state").asText())
                        .isEqualTo(expired ? "EXPIRED" : "RETRYABLE");
                var candidate = jdbc.queryForMap("SELECT object_key, resource_id, byte_length, sha256"
                        + " FROM qwen_tool_publication_object WHERE publication_id = 'pub-1'");
                release.countDown();
                assertThatThrownBy(() -> old.get(10, java.util.concurrent.TimeUnit.SECONDS))
                        .satisfies(error -> {
                            assertThat(error.getCause()).isInstanceOf(ApiException.class);
                            assertThat(((ApiException) error.getCause()).getCode()).isEqualTo(expired
                                    ? "managed_tool_publication_operation_expired"
                                    : "managed_tool_publication_claim_expired");
                        });
                assertThat(jdbc.queryForObject("SELECT state FROM qwen_tool_publication_object"
                        + " WHERE publication_id = 'pub-1'", String.class)).isEqualTo("CANDIDATE");
                if (expired) {
                    data.recoverOperation(key, "pub-1", PUBLICATION_TOKEN, "held");
                }
                JsonNode receipt = terminal ? data.finish(key, "pub-1", PUBLICATION_TOKEN, "held", bytes)
                        : data.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "held", "stdout", 0, bytes, null);
                assertThat(data.operationStatus(key, "pub-1", PUBLICATION_TOKEN, "held").path("receipt"))
                        .isEqualTo(receipt);
                assertThat(jdbc.queryForMap("SELECT object_key, resource_id, byte_length, sha256"
                        + " FROM qwen_tool_publication_object WHERE publication_id = 'pub-1'")).isEqualTo(candidate);
                String category = terminal ? "producer" : "capture";
                assertThat(jdbc.queryForObject("SELECT " + category + "_used_bytes FROM qwen_tool_publication"
                        + " WHERE publication_id = 'pub-1'", Long.class)).isEqualTo((long) bytes.length);
                assertThat(objects).hasSize(1);
            } finally {
                release.countDown();
            }
        }
    }

    @Test
    void expiredPrefixRemainsExpiredAndFencedPublicationCannotRecover() {
        reserve();
        ToolPublicationObjectStore bucket = new ToolPublicationObjectStore() {
            @Override
            public void putIfAbsent(String key, byte[] bytes) { throw new IllegalStateException("lost PUT reply"); }

            @Override
            public InputStream open(String key) { throw new AssertionError("Unexpected read"); }

            @Override
            public void requireUnversioned() { }
        };
        var data = new ToolPublicationDataStore(jdbc, manager, store, sessions, bucket,
                Duration.ofMinutes(2), Duration.ofSeconds(30), VERIFICATION_BUDGET);
        JsonNode key = binding.get("sessionKey");
        assertThatThrownBy(() -> data.publishSegment(key, "pub-1", PUBLICATION_TOKEN,
                "candidate", "stdout", 0, new byte[] {1}, null)).hasMessageContaining("lost PUT reply");
        data.prefix(key, "pub-1", PUBLICATION_TOKEN, "prefix", "stderr");
        jdbc.update("UPDATE qwen_tool_publication_operation SET deadline ="
                + " TIMESTAMPADD(SECOND, -1, CURRENT_TIMESTAMP(6)), state = 'PENDING'");
        assertThatThrownBy(() -> data.recoverOperation(key, "pub-1", PUBLICATION_TOKEN, "prefix"))
                .hasMessageContaining("prefix cannot be recovered");
        assertThatThrownBy(() -> data.recoverOperation(key, "pub-1", "wrong-token", "candidate"))
                .isInstanceOf(RuntimeException.class);
        store.apply(request("fence"), WRITER_TOKEN, null);
        assertThatThrownBy(() -> data.recoverOperation(key, "pub-1", PUBLICATION_TOKEN, "candidate"))
                .isInstanceOf(RuntimeException.class);
        assertThat(data.operationStatus(key, "pub-1", PUBLICATION_TOKEN, "candidate")
                .path("state").asText()).isEqualTo("EXPIRED");
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
                Duration.ofMinutes(2), Duration.ofSeconds(30), VERIFICATION_BUDGET);
        JsonNode key = binding.get("sessionKey");
        ObjectNode capture = JSON.createObjectNode().put("captureStatus", "unavailable")
                .put("captureReason", "storage_failed").put("previewTruncated", false)
                .put("deliveryStatus", "pending").putNull("manifest");
        ObjectNode envelope = JSON.createObjectNode().put("executionStatus", "error");
        envelope.putArray("responseParts").add("x".repeat(100_000));
        envelope.set("capture", capture);
        data.finish(key, "pub-1", PUBLICATION_TOKEN, "large-finish",
                envelope.toString().getBytes(StandardCharsets.UTF_8));
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
                .put("historyRevision", journal.sequence + 1).putNull("resultRef");
        receiptPayload.set("toolOutcomeRef", admission);
        receiptPayload.putArray("resources");
        String records = event(journal.sequence + 1, "tool.receipt", receiptPayload) + MARKER;
        var commit = new ManagedSessionStoreModels.CommitTransactionRequest("workspace-1", "writer-1", 1,
                journal.revision, journal.sequence, "transaction-large", "recordToolResult", "execution-1",
                admission.path("digest").asText(), journal.sequence + 1, journal.sequence + 1, 1,
                digest(records), journal.commitDigest, digest(records), 1, null, 2,
                Base64.getEncoder().encodeToString(records.getBytes(StandardCharsets.UTF_8)),
                digest(records), List.of(new ManagedSessionStoreModels.CommitResource(
                        admission.path("resourceId").asText(), "managed-tool-outcome", 1,
                        admission.path("byteLength").asLong(), admission.path("digest").asText(), null)));
        var admissions = new ToolPublicationAdmissionStore(jdbc, manager, sessions, data);
        assertThat(admissions.commitReceipt(key, "pub-1", WRITER_TOKEN, commit)
                .path("decision").asText()).isEqualTo("blocked");
        var changedReplay = new ManagedSessionStoreModels.CommitTransactionRequest("workspace-1", "writer-1", 1,
                journal.revision, journal.sequence, "different-transaction", "recordToolResult", "execution-1",
                admission.path("digest").asText(), journal.sequence + 1, journal.sequence + 1, 1,
                digest(records), journal.commitDigest, digest(records), 1, null, 2,
                Base64.getEncoder().encodeToString(records.getBytes(StandardCharsets.UTF_8)),
                digest(records), commit.resources());
        assertThatThrownBy(() -> admissions.commitReceipt(key, "pub-1", WRITER_TOKEN, changedReplay))
                .hasMessageContaining("different content");
        assertThat(admissions.commitReceipt(key, "pub-1", WRITER_TOKEN, commit)
                .path("decision").asText()).isEqualTo("blocked");
        assertThat(sessions.readResource("tenant-1", "workspace-1", "session-1",
                admission.path("resourceId").asText(), WRITER_TOKEN).bytes())
                .isEqualTo(outcome.toString().getBytes(StandardCharsets.UTF_8));
        JsonNode blockedPublic = projectPublicReceipt(data);
        assertThat(blockedPublic.path("execution_status").asText()).isEqualTo("error");
        assertThat(blockedPublic.path("capture_status").asText()).isEqualTo("unavailable");
        assertThat(blockedPublic.path("delivery_status").asText()).isEqualTo("blocked");
        assertThat(blockedPublic.path("reason_code").asText()).isEqualTo("storage_failed");
        assertThat(blockedPublic.path("upstream_truncated").isNull()).isTrue();
        assertThat(blockedPublic.path("artifacts")).isEmpty();
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

    @ParameterizedTest
    @ValueSource(strings = {"intact", "large-segment", "large-content", "partial", "missing-page", "corrupt-page", "missing-segment",
            "corrupt-segment", "missing-empty-seal"})
    void publishesImmutableSegmentAndResourceUnderOriginalAuthorization(String damage) {
        boolean partial = "partial".equals(damage);
        boolean contentBody = "large-content".equals(damage);
        boolean large = "large-segment".equals(damage) || contentBody;
        String segmentText = contentBody ? "abc".repeat(700_000) : large ? "abc".repeat(1024 * 1024) : "abc";
        int segmentLength = segmentText.length();
        if (large) {
            store = new ToolPublicationStore(jdbc, manager, sessions, executions, bindings,
                    new ToolPublicationStore.Capacity(16 * 1024 * 1024, 64 * 1024 * 1024, 64 * 1024 * 1024, 10),
                    true);
            store.apply(request("reserve").put("captureBytes", segmentLength), WRITER_TOKEN, PUBLICATION_TOKEN);
        } else {
            reserve();
        }
        Map<String, byte[]> objects = new java.util.HashMap<>();
        ToolPublicationObjectStore bucket = new ToolPublicationObjectStore() {
            @Override
            public void putIfAbsent(String key, byte[] bytes) {
                objects.putIfAbsent(key, bytes.clone());
            }

            @Override
            public InputStream open(String key) {
                if (key.equals(apiFailNextObject)) {
                    apiFailNextObject = null;
                    throw new IllegalStateException("storage temporarily unavailable");
                }
                return new ByteArrayInputStream(objects.get(key));
            }

            @Override
            public void requireUnversioned() {
            }
        };
        var data = new ToolPublicationDataStore(jdbc, manager, store, sessions, bucket,
                Duration.ofMinutes(2), Duration.ofSeconds(30), VERIFICATION_BUDGET);
        JsonNode key = binding.get("sessionKey");
        String firstSegment = large ? segmentText : "ab";
        byte[] segment = firstSegment.getBytes(StandardCharsets.UTF_8);
        JsonNode first = data.publishSegment(key, "pub-1", PUBLICATION_TOKEN,
                "operation-1", "stdout", 0, segment, digest(firstSegment));
        segment[0] = 'x';
        assertThat(data.publishSegment(key, "pub-1", PUBLICATION_TOKEN,
                "operation-1", "stdout", 0, firstSegment.getBytes(StandardCharsets.UTF_8), digest(firstSegment)))
                .isEqualTo(first);
        assertThat(data.operationStatus(key, "pub-1", PUBLICATION_TOKEN, "operation-1")
                .path("receipt")).isEqualTo(first);
        assertThat(objects.values()).singleElement().satisfies(bytes ->
                assertThat(bytes).isEqualTo(firstSegment.getBytes(StandardCharsets.UTF_8)));
        assertThat(data.prefix(key, "pub-1", PUBLICATION_TOKEN, "operation-prefix", "stdout")
                .path("byteLength").asLong()).isEqualTo(firstSegment.length());
        if (!large) {
            data.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "operation-second", "stdout", 1,
                    "c".getBytes(StandardCharsets.UTF_8), digest("c"));
        }
        if (!contentBody) {
            assertThat(data.seal(key, "pub-1", PUBLICATION_TOKEN, "operation-seal", "stdout", large ? 1 : 2,
                    segmentLength, digest(segmentText)).path("segmentCount").asInt()).isEqualTo(large ? 1 : 2);
        }
        if (!partial) {
            data.seal(key, "pub-1", PUBLICATION_TOKEN, "operation-seal-empty", "stderr", 0,
                    0, digest(""));
        }
        assertThat(data.prefix(key, "pub-1", PUBLICATION_TOKEN, "operation-prefix-2", "stdout")
                .path("sealed").asBoolean()).isEqualTo(!contentBody);
        if (!contentBody) {
            assertThatThrownBy(() -> data.publishSegment(key, "pub-1", PUBLICATION_TOKEN,
                    "operation-extra", "stdout", large ? 1 : 2, "x".getBytes(StandardCharsets.UTF_8), null))
                    .hasMessageContaining("sealed");
        }
        assertThatThrownBy(() -> data.publishSegment(key, "pub-1", PUBLICATION_TOKEN,
                "operation-2", "stdout", 0, "abd".getBytes(StandardCharsets.UTF_8), null))
                .hasMessageContaining("conflicts");
        ObjectNode page = JSON.createObjectNode().put("toolResult", "managed-tool-result/1")
                .put("type", "page").put("captureId", "capture-1")
                .put("streamId", "stdout").put("firstOrdinal", 0).put("offset", 0);
        var pageSegments = page.putArray("segments");
        pageSegments.add(JSON.createObjectNode().put("byteLength", firstSegment.length()).put("digest", digest(firstSegment)));
        if (!large) pageSegments.add(JSON.createObjectNode().put("byteLength", 1).put("digest", digest("c")));
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
                Long.class)).isEqualTo((long) segmentLength);
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
                .put("capturePolicy", "complete_required").put("captureStatus", partial ? "partial" : "complete")
                .put("captureReason", partial ? "storage_failed" : null).put("upstreamTruncated", false);
        ObjectNode content = JSON.createObjectNode().put("streamId", "stdout")
                .put("role", "stdout").put("mimeType", "application/octet-stream")
                .put("state", "sealed").put("byteLength", segmentLength).put("digest", digest(segmentText));
        content.putArray("missingRanges");
        ObjectNode body = JSON.createObjectNode();
        ObjectNode pageLink = JSON.createObjectNode().put("segmentCount", large ? 1 : 2).put("byteLength", segmentLength);
        pageLink.set("ref", ref);
        if (contentBody) {
            body.set("ref", data.publishResource(key, "pub-1", PUBLICATION_TOKEN, "operation-content", "content:stdout",
                    "managed-tool-result-content", segmentText.getBytes(StandardCharsets.UTF_8)));
        } else {
            body.putArray("pages").add(pageLink);
        }
        content.set("body", body);
        manifest.putArray("contents").add(content);
        ObjectNode stderr = JSON.createObjectNode().put("streamId", "stderr")
                .put("role", "stderr").put("mimeType", "application/octet-stream")
                .put("state", partial ? "incomplete" : "sealed").put("byteLength", 0).put("digest", digest(""));
        stderr.putArray("missingRanges");
        ObjectNode emptyBody = JSON.createObjectNode();
        emptyBody.putArray("pages");
        stderr.set("body", emptyBody);
        ((com.fasterxml.jackson.databind.node.ArrayNode) manifest.path("contents")).add(stderr);
        JsonNode manifestRef = data.publishResource(key, "pub-1", PUBLICATION_TOKEN,
                "operation-manifest", "manifest:1", "managed-tool-result-manifest",
                manifest.toString().getBytes(StandardCharsets.UTF_8));
        ObjectNode capture = JSON.createObjectNode().put("captureStatus", partial ? "partial" : "complete")
                .put("captureReason", partial ? "storage_failed" : null).put("previewTruncated", false)
                .put("deliveryStatus", "pending");
        capture.set("manifest", manifestRef);
        ObjectNode envelope = JSON.createObjectNode().put("executionStatus", "success");
        envelope.putArray("responseParts");
        envelope.set("capture", capture);
        assertThat(data.finish(key, "pub-1", PUBLICATION_TOKEN,
                "operation-finish", envelope.toString().getBytes(StandardCharsets.UTF_8))
                .path("producerPhase").asText()).isEqualTo("FINISHED");
        assertThat(data.finished(key, "pub-1", WRITER_TOKEN).path("result")).isEqualTo(envelope);
        store.apply(request("fence"), WRITER_TOKEN, null);
        var held = jdbc.queryForMap("SELECT admission_held_bytes, admission_bytes"
                + " FROM qwen_tool_publication WHERE publication_id = 'pub-1'");
        assertThat(((Number) held.get("admission_held_bytes")).longValue())
                .isEqualTo(((Number) held.get("admission_bytes")).longValue());
        assertThat(data.finished(key, "pub-1", WRITER_TOKEN).path("result")).isEqualTo(envelope);
        ObjectNode outcome = JSON.createObjectNode().put("schemaVersion", 1)
                .put("decision", partial ? "blocked" : "committed");
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
                .put("historyRevision", journal.sequence + 1);
        receiptPayload.set("toolOutcomeRef", admission);
        receiptPayload.set("resultRef", partial ? JSON.nullNode() : manifestRef);
        receiptPayload.putArray("resources").add(manifestRef);
        String recordBytes = event(journal.sequence + 1, "tool.receipt", receiptPayload) + MARKER;
        long receiptSequence = journal.sequence + 1;
        var commit = new ManagedSessionStoreModels.CommitTransactionRequest("workspace-1", "writer-1", 1,
                journal.revision, journal.sequence, "transaction-receipt", "recordToolResult", "execution-1",
                admission.path("digest").asText(), receiptSequence, receiptSequence, 1,
                digest(recordBytes), journal.commitDigest, digest(recordBytes), 1, null, 2,
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
        JsonNode brokerReceipt = data.receiptForBroker(executions.findByExecutionCallId("execution-1"));
        assertThat(brokerReceipt.path("deliveryStatus").asText()).isEqualTo(partial ? "blocked" : "committed");
        if (!partial) {
            assertThat(brokerReceipt.path("historyRevision").asLong()).isEqualTo(receiptSequence);
        }
        assertThat(sessions.readResource("tenant-1", "workspace-1", "session-1",
                admission.path("resourceId").asText(), WRITER_TOKEN).bytes())
                .isEqualTo(outcome.toString().getBytes(StandardCharsets.UTF_8));
        ObjectNode verification = JSON.createObjectNode().put("executionCallId", "execution-1")
                .put("historyRevision", receiptSequence);
        verification.set("toolOutcomeRef", admission);
        verification.set("manifestRef", manifestRef);
        assertThat(admissions.verifyReceipt(key, WRITER_TOKEN,
                ToolPublicationContract.readJson(verification.toString().getBytes(StandardCharsets.UTF_8))))
                .isEqualTo(committed);
        assertThatThrownBy(() -> admissions.verifyReceipt(key, "wrong-writer-token", verification))
                .isInstanceOf(ApiException.class);
        ObjectNode wrongSequence = verification.deepCopy().put("historyRevision", receiptSequence + 1);
        assertThatThrownBy(() -> admissions.verifyReceipt(key, WRITER_TOKEN, wrongSequence))
                .hasMessageContaining("sequence conflicts");
        ObjectNode wrongExecution = verification.deepCopy().put("executionCallId", "another-execution");
        assertThatThrownBy(() -> admissions.verifyReceipt(key, WRITER_TOKEN, wrongExecution))
                .hasMessageContaining("receipt conflicts");
        if (partial) return;
        if ("intact".equals(damage) || large) {
            com.alibaba.qwen.code.managedagent.store.WorkspaceRecoveryReaderAssertions.verifyOriginalPublication(
                    jdbc, bucket, key, admission, manifestRef, receiptSequence, firstSegment.getBytes(StandardCharsets.UTF_8));
        }
        if (!"intact".equals(damage) && !large) {
            switch (damage) {
                case "missing-page" -> jdbc.update("DELETE FROM qwen_tool_publication_object"
                        + " WHERE slot_key = 'page:stdout:0'");
                case "corrupt-page" -> jdbc.update("UPDATE qwen_tool_publication_object SET inline_bytes = ?"
                        + " WHERE slot_key = 'page:stdout:0'", new byte[]{1});
                case "missing-segment" -> jdbc.update("DELETE FROM qwen_tool_publication_object"
                        + " WHERE slot_key = 'segment:stdout:0'");
                case "corrupt-segment" -> objects.values().iterator().next()[0] = 'z';
                case "missing-empty-seal" -> jdbc.update("DELETE FROM qwen_tool_publication_seal"
                        + " WHERE stream_id = 'stderr'");
                default -> throw new AssertionError(damage);
            }
            assertThatThrownBy(() -> admissions.verifyReceipt(key, WRITER_TOKEN, verification))
                    .isInstanceOf(IllegalArgumentException.class);
            return;
        }
        ObjectNode identity = manifest.deepCopy();
        assertThat(data.readRange(key, "pub-1", WRITER_TOKEN, manifestRef, identity,
                "stdout", 1, 2)).isEqualTo("bc".getBytes(StandardCharsets.UTF_8));
        assertThat(data.readRange(key, "pub-1", WRITER_TOKEN, manifestRef, identity,
                "stdout", segmentLength, 0)).isEmpty();
        assertThatThrownBy(() -> data.readRange(key, "pub-1", WRITER_TOKEN, manifestRef,
                identity, "stdout", segmentLength - 1, 2)).hasMessageContaining("Invalid publication range");
        var absentManifest = manifestRef.deepCopy();
        ((ObjectNode) absentManifest).put("resourceId", "absent-manifest");
        for (long[] range : new long[][] {{-1, 1}, {0, -1}, {0, 16 * 1024 * 1024 + 1}}) {
            assertThatThrownBy(() -> data.readRange(key, "pub-1", WRITER_TOKEN, absentManifest,
                    identity, "stdout", range[0], (int) range[1])).hasMessageContaining("Invalid publication range");
        }
        if (!large) {
            if (quarantineBeforeProjection) {
                jdbc.update("UPDATE qwen_tool_publication SET quarantined = TRUE WHERE publication_id = 'pub-1'");
            }
            JsonNode projected = projectPublicReceipt(data);
            if (quarantineBeforeProjection) {
                assertThat(projected.path("execution_status").asText()).isEqualTo("success");
                assertThat(projected.path("capture_status").asText()).isEqualTo("complete");
                assertThat(projected.path("delivery_status").asText()).isEqualTo("committed");
                assertThat(projected.has("preview")).isFalse();
                assertThat(projected.path("artifacts")).isEmpty();
                apiPublications = data;
                apiReader = new ManagedArtifactReader(publicationProvider(data));
                return;
            }
            assertThat(projected.path("preview").path("text").asText()).isEqualTo("abc");
            var artifacts = publicResults.listArtifacts("tenant-1", "session-1", null, null, null, 1);
            assertThat(artifacts.hasMore()).isTrue();
            assertThat(artifacts.artifacts()).hasSize(1);
            var last = artifacts.artifacts().getFirst();
            var remaining = publicResults.listArtifacts("tenant-1", "session-1", artifacts.watermark(),
                    last.creationSequence(), last.descriptor().path("id").asText(), 1);
            assertThat(remaining.artifacts()).hasSize(1);
            assertThat(remaining.hasMore()).isFalse();
            assertThat(publicResults.findArtifact("other-tenant", "session-1", last.descriptor().path("id").asText())).isEmpty();
            var provider = publicationProvider(data);
            var publicReader = new ManagedArtifactReader(provider);
            var stdout = publicResults.listArtifacts("tenant-1", "session-1", null, null, null, 100).artifacts()
                    .stream().filter(artifact -> artifact.streamId().equals("stdout")).findFirst().orElseThrow();
            jdbc.update("UPDATE qwen_managed_session_journal_head SET writer_lease_until = TIMESTAMP '2000-01-01 00:00:00'");
            assertThat(publicReader.readRange(stdout, 1, 2)).isEqualTo("bc".getBytes(StandardCharsets.UTF_8));
            var guardCalls = new java.util.concurrent.atomic.AtomicInteger();
            assertThatThrownBy(() -> publicReader.readRange(stdout, 1, 2, () -> {
                if (guardCalls.incrementAndGet() == 2) {
                    throw new IllegalStateException("revoked mid-range");
                }
            })).hasMessage("revoked mid-range");
            // Restore the lease only for the existing private-reader corruption checks.
            // Keep the sentinel before 2038-01-19: databaseEpochMillis reads it back
            // through UNIX_TIMESTAMP, which wraps on H2 and yields NULL on MariaDB past
            // that bound, so a far-future literal here is engine-dependent.
            jdbc.update("UPDATE qwen_managed_session_journal_head SET writer_lease_until = TIMESTAMP '2037-01-01 00:00:00'");
            if (keepApiFixture) {
                apiPublications = data;
                apiReader = publicReader;
                apiObjects = objects;
                return;
            }
        }
        String damagedSlot = contentBody ? "content:stdout" : "segment:stdout:0";
        String damagedKey = jdbc.queryForObject("SELECT object_key FROM qwen_tool_publication_object WHERE slot_key = ?",
                String.class, damagedSlot);
        objects.get(damagedKey)[0] = 'z';
        assertThatThrownBy(() -> data.readRange(key, "pub-1", WRITER_TOKEN, manifestRef,
                identity, "stdout", 0, 1)).hasMessageContaining("digest changed");
        assertThat(jdbc.queryForObject("SELECT state FROM qwen_tool_publication_object"
                + " WHERE slot_key = ?", String.class, damagedSlot)).isEqualTo("QUARANTINED");
        assertThatThrownBy(() -> sessions.readResource("tenant-1", "workspace-1", "session-1",
                admission.path("resourceId").asText(), WRITER_TOKEN)).hasMessageContaining("verification");
    }

    @Test
    void publicReaderStopsBeforeNextSegmentWhenAccessIsRevoked() throws Exception {
        var artifact = preparePublicReader();
        var allowed = new java.util.concurrent.atomic.AtomicBoolean(true);
        try (var stream = apiReader.open(artifact, () -> {
            if (!allowed.get()) {
                throw new SecurityException("access revoked");
            }
        })) {
            assertThat(stream.readNBytes(2)).isEqualTo("ab".getBytes(StandardCharsets.UTF_8));
            allowed.set(false);
            byte[] target = new byte[] {'?'};
            assertThatThrownBy(() -> stream.read(target)).isInstanceOf(SecurityException.class);
            assertThat(target).containsExactly((byte) '?');
        }
    }

    @Test
    void publicReaderStopsBeforeNextSegmentWhenPublicationIsQuarantined() throws Exception {
        var artifact = preparePublicReader();
        try (var stream = apiReader.open(artifact)) {
            assertThat(stream.readNBytes(2)).isEqualTo("ab".getBytes(StandardCharsets.UTF_8));
            jdbc.update("UPDATE qwen_tool_publication SET quarantined = TRUE WHERE publication_id = 'pub-1'");
            byte[] target = new byte[] {'?'};
            assertThatThrownBy(() -> stream.read(target)).hasMessageContaining("receipt is unavailable");
            assertThat(target).containsExactly((byte) '?');
        }
    }

    @Test
    void publicReaderNeverExposesBytesFromCorruptSegmentEvenWhenRetried() throws Exception {
        var artifact = preparePublicReader();
        try (var stream = apiReader.open(artifact)) {
            assertThat(stream.readNBytes(2)).isEqualTo("ab".getBytes(StandardCharsets.UTF_8));
            String secondObject = jdbc.queryForObject("SELECT object_key FROM qwen_tool_publication_object"
                    + " WHERE slot_key = 'segment:stdout:1'", String.class);
            apiObjects.get(secondObject)[0] = 'x';
            byte[] target = new byte[] {'?'};
            assertThatThrownBy(() -> stream.read(target)).hasMessageContaining("digest changed");
            assertThat(target).containsExactly((byte) '?');
            assertThatThrownBy(() -> stream.read(target)).hasMessageContaining("receipt is unavailable");
            assertThat(target).containsExactly((byte) '?');
            assertThat(jdbc.queryForObject("SELECT state FROM qwen_tool_publication_object"
                    + " WHERE slot_key = 'segment:stdout:1'", String.class)).isEqualTo("QUARANTINED");
        }
    }

    @Test
    void publicReaderDoesNotAdvancePastSegmentWhenStorageReadFails() throws Exception {
        var artifact = preparePublicReader();
        try (var stream = apiReader.open(artifact)) {
            assertThat(stream.readNBytes(2)).isEqualTo("ab".getBytes(StandardCharsets.UTF_8));
            apiFailNextObject = jdbc.queryForObject("SELECT object_key FROM qwen_tool_publication_object"
                    + " WHERE slot_key = 'segment:stdout:1'", String.class);
            byte[] target = new byte[] {'?'};
            assertThatThrownBy(() -> stream.read(target)).hasMessageContaining("storage temporarily unavailable");
            assertThat(target).containsExactly((byte) '?');
            assertThat(stream.read(target)).isEqualTo(1);
            assertThat(target).containsExactly((byte) 'c');
            assertThat(stream.read()).isEqualTo(-1);
        }
    }

    private ManagedToolResultStore.Artifact preparePublicReader() {
        keepApiFixture = true;
        publishesImmutableSegmentAndResourceUnderOriginalAuthorization("intact");
        return publicResults.listArtifacts("tenant-1", "session-1", null, null, null, 100).artifacts().stream()
                .filter(artifact -> artifact.streamId().equals("stdout")).findFirst().orElseThrow();
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
                Duration.ofMinutes(2), Duration.ofSeconds(30), VERIFICATION_BUDGET);
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
                Duration.ofMinutes(2), Duration.ofSeconds(30), VERIFICATION_BUDGET);
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
                Duration.ofSeconds(2), Duration.ofMillis(90), VERIFICATION_BUDGET);
        JsonNode key = binding.get("sessionKey");
        data.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "slow-segment",
                "stdout", 0, segment, digest("abc"));
        slow[0] = true;
        assertThat(data.seal(key, "pub-1", PUBLICATION_TOKEN, "slow-seal", "stdout",
                1, segment.length, digest("abc")).path("segmentCount").asInt()).isEqualTo(1);
    }

    @Test
    void finishBudgetIncludesRetainedUnconfirmedCandidate() {
        reserve();
        ToolPublicationObjectStore bucket = new ToolPublicationObjectStore() {
            @Override
            public void putIfAbsent(String key, byte[] bytes) {
                throw new IllegalStateException("Lost candidate PUT reply");
            }

            @Override
            public InputStream open(String key) { throw new AssertionError("Unexpected object read"); }

            @Override
            public void requireUnversioned() { }
        };
        var data = new ToolPublicationDataStore(jdbc, manager, store, sessions, bucket,
                Duration.ofSeconds(1), Duration.ofMillis(500),
                new ToolPublicationDataStore.VerificationBudget(512, Duration.ofSeconds(5)));
        JsonNode key = binding.get("sessionKey");
        assertThatThrownBy(() -> data.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "candidate",
                "stdout", 0, new byte[512], null)).hasMessageContaining("Lost candidate PUT reply");
        ObjectNode capture = JSON.createObjectNode().put("captureStatus", "unavailable")
                .put("captureReason", "storage_failed").put("previewTruncated", false)
                .put("deliveryStatus", "pending").putNull("manifest");
        ObjectNode envelope = JSON.createObjectNode().put("executionStatus", "success");
        envelope.putArray("responseParts");
        envelope.set("capture", capture);
        data.finish(key, "pub-1", PUBLICATION_TOKEN, "finish", envelope.toString().getBytes(StandardCharsets.UTF_8));
        var deadline = jdbc.queryForObject("SELECT deadline FROM qwen_tool_publication_operation"
                + " WHERE operation_id = 'finish'", java.sql.Timestamp.class);
        var created = jdbc.queryForObject("SELECT created_at FROM qwen_tool_publication_operation"
                + " WHERE operation_id = 'finish'", java.sql.Timestamp.class);
        assertThat(deadline.getTime() - created.getTime()).isEqualTo(3000);
        assertThat(jdbc.queryForObject("SELECT state FROM qwen_tool_publication_object"
                + " WHERE slot_key = 'segment:stdout:0'", String.class)).isEqualTo("CANDIDATE");
    }

    @Test
    void sealUsesCatalogBytesToFinishBeyondTheBaseDeadline() {
        reserve();
        byte[] segment = "z".repeat(1024).getBytes(StandardCharsets.UTF_8);
        boolean[] slow = {false};
        long[] verificationTime = {0};
        ToolPublicationObjectStore bucket = new ToolPublicationObjectStore() {
            @Override
            public void putIfAbsent(String key, byte[] bytes) { }

            @Override
            public InputStream open(String key) {
                return new ByteArrayInputStream(segment) {
                    @Override
                    public synchronized int read(byte[] target, int offset, int length) {
                        if (available() == 0) return -1;
                        if (slow[0]) {
                            try {
                                Thread.sleep(250);
                                verificationTime[0] += 250;
                            } catch (InterruptedException error) {
                                Thread.currentThread().interrupt();
                                throw new IllegalStateException(error);
                            }
                        }
                        return super.read(target, offset, Math.min(length, 64));
                    }
                };
            }

            @Override
            public void requireUnversioned() { }
        };
        var publisher = new ToolPublicationDataStore(jdbc, manager, store, sessions, bucket,
                Duration.ofMinutes(2), Duration.ofSeconds(30), VERIFICATION_BUDGET);
        JsonNode key = binding.get("sessionKey");
        String digest = ToolPublicationContract.sha256(segment);
        publisher.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "segment", "stdout", 0, segment, digest);
        verificationTime[0] = jdbc.queryForObject("SELECT CURRENT_TIMESTAMP(6)", java.sql.Timestamp.class)
                .getTime() / 1000 * 1000;
        // Advance verification time with fixture reads, excluding JDBC latency.
        JdbcTemplate verificationJdbc = new JdbcTemplate(jdbc.getDataSource()) {
            @Override
            public <T> T queryForObject(String sql, Class<T> type) {
                if ("SELECT CURRENT_TIMESTAMP(6)".equals(sql) && type == java.sql.Timestamp.class) {
                    return type.cast(new java.sql.Timestamp(verificationTime[0]));
                }
                return super.queryForObject(sql, type);
            }
        };
        // Keep renewal margin when a JDBC driver truncates fractional timestamps.
        var data = new ToolPublicationDataStore(verificationJdbc, manager, store, sessions, bucket,
                Duration.ofSeconds(3), Duration.ofSeconds(2),
                new ToolPublicationDataStore.VerificationBudget(256, Duration.ofSeconds(10)));
        slow[0] = true;
        assertThat(data.seal(key, "pub-1", PUBLICATION_TOKEN, "seal", "stdout", 1, segment.length, digest)
                .path("digest").asText()).isEqualTo(digest);
        var deadline = jdbc.queryForObject("SELECT deadline FROM qwen_tool_publication_operation"
                + " WHERE operation_id = 'seal'", java.sql.Timestamp.class);
        var created = jdbc.queryForObject("SELECT created_at FROM qwen_tool_publication_operation"
                + " WHERE operation_id = 'seal'", java.sql.Timestamp.class);
        assertThat(verificationTime[0] - created.getTime()).isEqualTo(4000);
        assertThat(deadline.getTime() - created.getTime()).isEqualTo(7000);
        assertThat(data.operationStatus(key, "pub-1", PUBLICATION_TOKEN, "seal").path("state").asText())
                .isEqualTo("SUCCEEDED");
        assertThat(jdbc.queryForObject("SELECT deadline FROM qwen_tool_publication_operation"
                + " WHERE operation_id = 'seal'", java.sql.Timestamp.class)).isEqualTo(deadline);
    }

    @Test
    void streamsLargeOutputAndReadsItsTailAfterStoreReplacement(@TempDir Path root) throws Exception {
        int segments = "1".equals(System.getenv("O2_STRESS")) ? 1024 : 100;
        long captureBytes = (long) segments * 1024 * 1024;
        long allocated = captureBytes + ToolPublicationContract.PRODUCER_BYTES
                + ToolPublicationContract.ADMISSION_BYTES;
        store = new ToolPublicationStore(jdbc, manager, sessions, executions, bindings,
                new ToolPublicationStore.Capacity(captureBytes, allocated, allocated, 1), true);
        store.apply(request("reserve").put("captureBytes", captureBytes), WRITER_TOKEN, PUBLICATION_TOKEN);
        boolean[] slow = {false};
        int[] metadataQueries = {0};
        JdbcTemplate metadataJdbc = new JdbcTemplate(jdbc.getDataSource()) {
            @Override
            public <T> List<T> query(String sql, org.springframework.jdbc.core.RowMapper<T> mapper,
                    Object... arguments) {
                if (slow[0] && sql.startsWith("SELECT slot_key, resource_id, byte_length")
                        && arguments.length == 3 && arguments[2].toString().startsWith("segment:")) {
                    metadataQueries[0]++;
                    try {
                        Thread.sleep(15);
                    } catch (InterruptedException error) {
                        Thread.currentThread().interrupt();
                        throw new IllegalStateException(error);
                    }
                }
                return super.query(sql, mapper, arguments);
            }
        };
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
                    return new java.io.FilterInputStream(Files.newInputStream(file(key))) {
                        @Override
                        public int read(byte[] target, int offset, int length) throws java.io.IOException {
                            if (slow[0]) {
                                try {
                                    Thread.sleep(1);
                                } catch (InterruptedException error) {
                                    Thread.currentThread().interrupt();
                                    throw new java.io.IOException(error);
                                }
                            }
                            return super.read(target, offset, length);
                        }
                    };
                } catch (java.io.IOException error) {
                    throw new java.io.UncheckedIOException(error);
                }
            }

            @Override
            public void requireUnversioned() {
            }
        };
        ToolPublicationDataStore data = new ToolPublicationDataStore(metadataJdbc, manager, store, sessions,
                bucket, Duration.ofSeconds(1), Duration.ofMillis(500), VERIFICATION_BUDGET);
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
        slow[0] = true;
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
        data.finish(key, "pub-1", PUBLICATION_TOKEN, "finish-1",
                envelope.toString().getBytes(StandardCharsets.UTF_8));
        assertThat(metadataQueries[0]).isGreaterThanOrEqualTo(segments);
        ToolPublicationDataStore reopened = new ToolPublicationDataStore(jdbc, manager, store, sessions,
                bucket, Duration.ofSeconds(1), Duration.ofMillis(500), VERIFICATION_BUDGET);
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

    // The release fence must hold on the shipped legacy scan and on the
    // head fast path alike.
    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void sameEpochReleasePreventsReserveAndRenew(boolean journalHeadAuthorization) {
        store = newStore(10 * ALLOCATION, 10, journalHeadAuthorization);
        reserve();
        append("activation.release", event(3, "activation.changed", activation("released")) + MARKER, 1,
                List.of(resource(binding.get("checkpointRef"), checkpoint)), "checkpoint-1");
        assertThatThrownBy(this::reserve).hasMessageContaining("Activation is not active");
        assertThatThrownBy(() -> store.apply(request("renew"), WRITER_TOKEN, PUBLICATION_TOKEN))
                .hasMessageContaining("Activation is not active");
    }

    // Two tool.intent lines sharing one sequence are refused by the
    // commit-side full-envelope validation: the second line's position is
    // refused at commit, before the pair can enter a journal.
    @Test
    void duplicateIntentLinesAtOneSequenceAreRejectedAtCommit() {
        store = newStore(10 * ALLOCATION, 10);
        ObjectNode intentA = JSON.createObjectNode().put("executionCallId", "execution-2")
                .put("outcomeSource", "runtime");
        intentA.set("argsRef", binding.get("argsRef"));
        ObjectNode intentB = intentA.deepCopy();
        assertThatThrownBy(() -> addSecondExecutionWith(
                event(3, "tool.intent", intentA)
                        + event(3, "tool.intent", intentB) + MARKER, 2))
                .hasMessageContaining(
                        "event.sequence must be an integer from 4 to 4.");
    }

    // Ambiguous evidence fails closed on both read paths: a pre-existing
    // journal (written before the commit-side check) that carries two
    // tool.intent lines at one sequence is fenced by either authorization
    // path — the duplicate is never silently resolved.
    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void duplicateIntentLinesInAPreExistingJournalAreFenced(
            boolean journalHeadAuthorization) {
        store = newStore(10 * ALLOCATION, 10, journalHeadAuthorization);
        reserve();
        // Simulate the pre-existing poison: the activation line's declared
        // place holds a second tool.intent at the intent's sequence, planted
        // with the stored-bytes idiom of
        // aForeignScopedActivationInAPreExistingJournalIsNotPromoted (a
        // commit-side-checked journal can never contain this pair, so it is
        // planted where the commit path cannot see it).
        byte[] record = jdbc.queryForObject("SELECT record_bytes FROM"
                + " qwen_managed_session_journal_tx WHERE tenant_id = 'tenant-1'"
                + " AND session_id = 'session-1' AND journal_revision = 2",
                byte[].class);
        String intentLine = null;
        StringBuilder poisoned = new StringBuilder();
        for (String line : new String(record, StandardCharsets.UTF_8)
                .split("\n")) {
            if (line.contains("tool.intent")) {
                intentLine = line;
            }
        }
        for (String line : new String(record, StandardCharsets.UTF_8)
                .split("\n")) {
            poisoned.append(line.contains("activation.changed")
                    ? intentLine : line).append("\n");
        }
        byte[] poisonedBytes = poisoned.toString()
                .getBytes(StandardCharsets.UTF_8);
        jdbc.update("UPDATE qwen_managed_session_journal_tx SET record_bytes = ?,"
                + " byte_length = ?, record_digest = ?"
                + " WHERE tenant_id = 'tenant-1' AND session_id = 'session-1'"
                + " AND journal_revision = 2",
                poisonedBytes, poisonedBytes.length,
                ExtensionRecordJournal.sha256(poisonedBytes));
        // A cold head forces both flag settings through the journal scan.
        jdbc.update("UPDATE qwen_managed_session_journal_head SET"
                + " activation_id = NULL, activation_phase = NULL,"
                + " activation_event_epoch = NULL, activation_expires_at = NULL,"
                + " activation_head_revision = NULL");
        assertThatThrownBy(() -> store.apply(request("renew"), WRITER_TOKEN,
                PUBLICATION_TOKEN))
                .hasMessageContaining("Intent sequence conflicts");
    }

    // A journal line scoped to another Session (or a version the reader
    // does not know) must not serve as publication evidence; the commit
    // side refuses to write it in the first place.
    @Test
    void foreignScopedIntentLinesAreRejectedAtCommit() {
        ObjectNode intent = JSON.createObjectNode().put("executionCallId", "execution-2")
                .put("outcomeSource", "runtime");
        intent.set("argsRef", binding.get("argsRef"));
        JsonNode foreignKey = JSON.createObjectNode().put("tenantId", "tenant-1")
                .put("workspaceId", "workspace-1").put("sessionId", "session-9");
        assertThatThrownBy(() -> addSecondExecutionWith(
                event(3, "tool.intent", intent, foreignKey, 1) + MARKER))
                .hasMessageContaining("The event names another Session.");
    }

    @Test
    void unknownVersionIntentLinesAreRejectedAtCommit() {
        ObjectNode intent = JSON.createObjectNode().put("executionCallId", "execution-2")
                .put("outcomeSource", "runtime");
        intent.set("argsRef", binding.get("argsRef"));
        assertThatThrownBy(() -> addSecondExecutionWith(
                event(3, "tool.intent", intent, binding.get("sessionKey"), 2) + MARKER))
                .hasMessageContaining("event.v must be an integer from 1 to 1.");
    }

    // A pre-existing journal (written before the commit-side check) whose
    // activation line carries an envelope version the reader does not know
    // is fenced by either evidence read path, and nothing promotes into
    // the trusted head columns.
    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void unknownVersionActivationInAPreExistingJournalIsNotPromoted(
            boolean journalHeadAuthorization) {
        store = newStore(10 * ALLOCATION, 10, journalHeadAuthorization);
        reserve();
        // Simulate the pre-existing poison: the stored activation line
        // carries version 2.
        byte[] record = jdbc.queryForObject("SELECT record_bytes FROM"
                + " qwen_managed_session_journal_tx WHERE tenant_id = 'tenant-1'"
                + " AND session_id = 'session-1' AND journal_revision = 2",
                byte[].class);
        String[] lines = new String(record, StandardCharsets.UTF_8).split("\n");
        StringBuilder poisoned = new StringBuilder();
        for (String line : lines) {
            if (line.contains("activation.changed")) {
                line = line.replace("\"v\":1", "\"v\":2");
            }
            poisoned.append(line).append("\n");
        }
        byte[] poisonedBytes = poisoned.toString()
                .getBytes(StandardCharsets.UTF_8);
        jdbc.update("UPDATE qwen_managed_session_journal_tx SET record_bytes = ?,"
                + " byte_length = ?, record_digest = ?"
                + " WHERE tenant_id = 'tenant-1' AND session_id = 'session-1'"
                + " AND journal_revision = 2",
                poisonedBytes, poisonedBytes.length,
                ExtensionRecordJournal.sha256(poisonedBytes));
        // A cold head forces both flag settings through the evidence scan.
        jdbc.update("UPDATE qwen_managed_session_journal_head SET"
                + " activation_id = NULL, activation_phase = NULL,"
                + " activation_event_epoch = NULL, activation_expires_at = NULL,"
                + " activation_head_revision = NULL");
        assertThatThrownBy(() -> store.apply(request("renew"), WRITER_TOKEN,
                PUBLICATION_TOKEN))
                .hasMessageContaining("Journal event scope conflicts");
        assertThat(jdbc.queryForObject("SELECT activation_id FROM"
                        + " qwen_managed_session_journal_head", String.class))
                .isNull();
    }

    // A misscoped domain.committed line is refused by the commit-side
    // envelope scope check before any domain check runs.
    @Test
    void unknownDomainLinesAreRejectedAtCommit() {
        ObjectNode payload = JSON.createObjectNode()
                .put("domain", "no.such.domain");
        JsonNode foreignKey = JSON.createObjectNode().put("tenantId", "tenant-1")
                .put("workspaceId", "workspace-1").put("sessionId", "session-9");
        assertThatThrownBy(() -> addSecondExecutionWith(
                event(3, "domain.committed", payload, foreignKey, 1) + MARKER))
                .hasMessageContaining("The event names another Session.");
    }

    // A pre-existing journal (written before the commit-side check) with a
    // misscoped activation line must not be promoted into the trusted head
    // columns by either authorization path.
    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void aForeignScopedActivationInAPreExistingJournalIsNotPromoted(
            boolean journalHeadAuthorization) {
        store = newStore(10 * ALLOCATION, 10, journalHeadAuthorization);
        reserve();
        // Simulate the pre-existing poison: the stored activation line
        // names another Session.
        byte[] record = jdbc.queryForObject("SELECT record_bytes FROM"
                + " qwen_managed_session_journal_tx WHERE tenant_id = 'tenant-1'"
                + " AND session_id = 'session-1' AND journal_revision = 2",
                byte[].class);
        String[] lines = new String(record, StandardCharsets.UTF_8).split("\n");
        StringBuilder poisoned = new StringBuilder();
        for (String line : lines) {
            if (line.contains("activation.changed")) {
                line = line.replace("\"sessionId\":\"session-1\"",
                        "\"sessionId\":\"session-9\"");
            }
            poisoned.append(line).append("\n");
        }
        jdbc.update("UPDATE qwen_managed_session_journal_tx SET record_bytes = ?"
                + " WHERE tenant_id = 'tenant-1' AND session_id = 'session-1'"
                + " AND journal_revision = 2",
                poisoned.toString().getBytes(StandardCharsets.UTF_8));
        // A cold head forces both flag settings through the journal scan.
        jdbc.update("UPDATE qwen_managed_session_journal_head SET"
                + " activation_id = NULL, activation_phase = NULL,"
                + " activation_event_epoch = NULL, activation_expires_at = NULL,"
                + " activation_head_revision = NULL");
        assertThatThrownBy(() -> store.verifyDispatch(
                executions.findByExecutionCallId("execution-1"), "pub-1",
                PUBLICATION_TOKEN))
                .hasMessageContaining("Journal event scope conflicts");
        assertThat(jdbc.queryForObject("SELECT activation_id FROM"
                        + " qwen_managed_session_journal_head", String.class))
                .isNull();
    }

    // The discriminating position: a misscoped line ABOVE the intent is
    // parsed by the legacy walk and refused; the warm head path never
    // re-reads it — the accepted §9 residual, narrowed by the commit-side
    // check to journals written before this change.
    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void aForeignScopedLineAboveTheIntentIsRefusedByTheLegacyScan(
            boolean journalHeadAuthorization) {
        store = newStore(10 * ALLOCATION, 10, journalHeadAuthorization);
        reserve();
        append("tool.wait", event(3, "checkpoint.committed",
                checkpointPayload("checkpoint-1")) + MARKER, 1,
                List.of(), null);
        byte[] record = jdbc.queryForObject("SELECT record_bytes FROM"
                + " qwen_managed_session_journal_tx WHERE tenant_id = 'tenant-1'"
                + " AND session_id = 'session-1' AND journal_revision = 3",
                byte[].class);
        String poisoned = new String(record, StandardCharsets.UTF_8)
                .replace("\"sessionId\":\"session-1\"", "\"sessionId\":\"session-9\"");
        // The walk's digest verification still sees a consistent row.
        jdbc.update("UPDATE qwen_managed_session_journal_tx SET record_bytes = ?,"
                + " record_digest = ?"
                + " WHERE tenant_id = 'tenant-1' AND session_id = 'session-1'"
                + " AND journal_revision = 3",
                poisoned.getBytes(StandardCharsets.UTF_8), digest(poisoned));
        if (journalHeadAuthorization) {
            // The warm head path answers from the head columns and never
            // re-parses the intermediate revision — the §9 residual.
            store.apply(request("renew"), WRITER_TOKEN, PUBLICATION_TOKEN);
        } else {
            assertThatThrownBy(() -> store.apply(request("renew"),
                    WRITER_TOKEN, PUBLICATION_TOKEN))
                    .hasMessageContaining("Journal event scope conflicts");
        }
    }

    // A binding naming a never-committed intent sequence is a client fault
    // (400) on both paths — the 500 corruption fault is reserved for a
    // journal damaged inside the committed span.
    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void aNeverCommittedIntentSequenceIsAClientFault(
            boolean journalHeadAuthorization) {
        store = newStore(10 * ALLOCATION, 10, journalHeadAuthorization);
        ObjectNode candidate = request("reserve");
        ((ObjectNode) candidate.get("binding")).put("intentSequence", 99);
        assertThatThrownBy(() -> store.apply(candidate, WRITER_TOKEN,
                PUBLICATION_TOKEN))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Committed publication evidence is missing");
    }

    @Test
    void aJournalHoleAboveTheIntentFencesTheHeadPath() {
        store = newStore(10 * ALLOCATION, 10, true);
        reserve();
        append("tool.wait", event(3, "checkpoint.committed",
                checkpointPayload("checkpoint-1")) + MARKER, 1,
                List.of(), null);
        // A revision vanishes between the intent's and the locked head.
        jdbc.update("DELETE FROM qwen_managed_session_journal_tx WHERE tenant_id = 'tenant-1'"
                + " AND session_id = 'session-1' AND journal_revision = 3");
        assertThatThrownBy(() -> store.apply(request("renew"), WRITER_TOKEN, PUBLICATION_TOKEN))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getCode())
                            .isEqualTo("managed_session_journal_corrupt");
                    assertThat(error.getStatus().is5xxServerError()).isTrue();
                });
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void aCorruptedJournalRowAboveTheIntentFencesBothPaths(
            boolean journalHeadAuthorization) {
        store = newStore(10 * ALLOCATION, 10, journalHeadAuthorization);
        reserve();
        append("tool.wait", event(3, "checkpoint.committed",
                checkpointPayload("checkpoint-1")) + MARKER, 1,
                List.of(), null);
        // A damaged write zeroed a revision's byte_length between the
        // intent's and the head: both paths must refuse the evidence with
        // the journal-corruption fault (500), not a client request fault.
        jdbc.update("UPDATE qwen_managed_session_journal_tx SET byte_length = 0"
                + " WHERE tenant_id = 'tenant-1' AND session_id = 'session-1'"
                + " AND journal_revision = 3");
        assertThatThrownBy(() -> store.apply(request("renew"), WRITER_TOKEN, PUBLICATION_TOKEN))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getCode())
                            .isEqualTo("managed_session_journal_corrupt");
                    assertThat(error.getStatus().is5xxServerError()).isTrue();
                });
    }

    @Test
    void anOverlappingJournalRangeFencesTheHeadPath() {
        store = newStore(10 * ALLOCATION, 10, true);
        reserve();
        // The intent's sequence suddenly matches two revisions.
        jdbc.update("UPDATE qwen_managed_session_journal_tx SET last_sequence = 2"
                + " WHERE tenant_id = 'tenant-1' AND session_id = 'session-1'"
                + " AND journal_revision = 1");
        assertThatThrownBy(() -> store.apply(request("renew"), WRITER_TOKEN, PUBLICATION_TOKEN))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getCode())
                            .isEqualTo("managed_session_journal_corrupt");
                    assertThat(error.getStatus().is5xxServerError()).isTrue();
                });
    }

    @Test
    void disabledJournalHeadAuthorizationKeepsScanningTheJournal() {
        store = newStore(10 * ALLOCATION, 10, false);
        reserve();
        // With the gate off the head columns are not trusted, even when they
        // disagree with the journal: the legacy scan authorizes instead.
        jdbc.update("UPDATE qwen_managed_session_journal_head SET activation_phase = 'released'");
        store.verifyDispatch(executions.findByExecutionCallId("execution-1"), "pub-1", PUBLICATION_TOKEN);
        // The scan still backfills the head, repairing the disagreement.
        assertThat(jdbc.queryForObject("SELECT activation_phase FROM qwen_managed_session_journal_head",
                String.class)).isEqualTo("active");
        // A release committed to the journal still fences both grant paths.
        append("activation.release", event(3, "activation.changed", activation("released")) + MARKER, 1,
                List.of(resource(binding.get("checkpointRef"), checkpoint)), "checkpoint-1");
        assertThatThrownBy(() -> store.verifyDispatch(executions.findByExecutionCallId("execution-1"),
                "pub-1", PUBLICATION_TOKEN)).hasMessageContaining("Original activation is fenced");
        assertThatThrownBy(() -> store.apply(request("renew"), WRITER_TOKEN, PUBLICATION_TOKEN))
                .hasMessageContaining("Activation is not active");
    }

    @Test
    void oneCommitKeepsTheLastActivationChange() {
        reserve();
        // Two activation changes in one transaction: the head must record
        // the last one, as the journal scans do. The two payloads differ in
        // every column, so all four discriminate last from first.
        ObjectNode firstActive = activation("active");
        firstActive.put("expiresAt", System.currentTimeMillis() + 180_000);
        ObjectNode lastReleased = activation("released");
        lastReleased.put("activationId", "activation-2").put("epoch", 2);
        lastReleased.put("expiresAt", System.currentTimeMillis() + 60_000);
        append("activation.rotate",
                event(3, "activation.changed", firstActive)
                        + event(4, "activation.changed", lastReleased) + MARKER,
                2, List.of(resource(binding.get("checkpointRef"), checkpoint)), "checkpoint-1");
        var rotated = jdbc.queryForMap("SELECT activation_id,"
                + " activation_phase, activation_event_epoch,"
                + " activation_expires_at FROM qwen_managed_session_journal_head");
        assertThat(rotated.get("activation_id")).isEqualTo("activation-2");
        assertThat(rotated.get("activation_phase")).isEqualTo("released");
        assertThat(rotated.get("activation_event_epoch")).isEqualTo(2L);
        assertThat(rotated.get("activation_expires_at"))
                .isEqualTo(lastReleased.get("expiresAt").asLong());
        assertThatThrownBy(() -> store.apply(request("renew"), WRITER_TOKEN, PUBLICATION_TOKEN))
                .hasMessageContaining("Activation is not active");
        // The two scans' intra-record ordering must agree with the head:
        // with the columns blanked, both backward walks fence the released
        // activation instead of reviving the record's earlier active one.
        jdbc.update("UPDATE qwen_managed_session_journal_head SET"
                + " activation_id = NULL, activation_phase = NULL,"
                + " activation_event_epoch = NULL,"
                + " activation_expires_at = NULL,"
                + " activation_head_revision = NULL");
        assertThatThrownBy(() -> store.apply(request("renew"), WRITER_TOKEN, PUBLICATION_TOKEN))
                .hasMessageContaining("Activation is not active");
        jdbc.update("UPDATE qwen_managed_session_journal_head SET"
                + " activation_id = NULL, activation_phase = NULL,"
                + " activation_event_epoch = NULL,"
                + " activation_expires_at = NULL,"
                + " activation_head_revision = NULL");
        assertThatThrownBy(() -> store.verifyDispatch(
                executions.findByExecutionCallId("execution-1"), "pub-1",
                PUBLICATION_TOKEN))
                .hasMessageContaining("Original activation is fenced");
    }

    @Test
    void activePhaseWithExpiredDeadlinePreventsReserveRenewAndDispatch() {
        reserve();
        var execution = executions.findByExecutionCallId("execution-1");
        assertThat(store.verifyDispatch(execution, "pub-1", PUBLICATION_TOKEN)).isNotNull();
        ObjectNode expired = activation("active").put("expiresAt", System.currentTimeMillis() - 1_000);
        append("activation.expire", event(3, "activation.changed", expired) + MARKER, 1,
                List.of(resource(binding.get("checkpointRef"), checkpoint)), "checkpoint-1");
        assertThatThrownBy(this::reserve).hasMessageContaining("Activation is not active");
        assertThatThrownBy(() -> store.apply(request("renew"), WRITER_TOKEN, PUBLICATION_TOKEN))
                .hasMessageContaining("Activation is not active");
        assertThatThrownBy(() -> store.verifyDispatch(execution, "pub-1", PUBLICATION_TOKEN))
                .hasMessageContaining("Original activation is fenced");
    }

    @Test
    void oversizedActivationFieldsBlankTheHeadColumnsInsteadOfFailingTheCommit() {
        reserve();
        assertThat(jdbc.queryForObject("SELECT activation_phase FROM qwen_managed_session_journal_head",
                String.class)).isEqualTo("active");
        // A non-conforming writer can exceed the V36 column widths; the
        // commit must still succeed and leave the columns blank, so
        // authorization falls back to reading the journal.
        ObjectNode oversized = JSON.createObjectNode()
                .put("activationId", "activation-" + "a".repeat(600))
                .put("epoch", 1).put("phase", "active")
                .put("expiresAt", System.currentTimeMillis() + 180000);
        append("activation.oversize", event(3, "activation.changed", oversized) + MARKER, 1, List.of(), null);
        var head = jdbc.queryForMap("SELECT activation_id, activation_phase,"
                + " activation_event_epoch, activation_expires_at"
                + " FROM qwen_managed_session_journal_head");
        assertThat(head.get("activation_id")).isNull();
        assertThat(head.get("activation_phase")).isNull();
        assertThat(head.get("activation_event_epoch")).isNull();
        assertThat(head.get("activation_expires_at")).isNull();
        // A conforming activation writes the columns again.
        append("activation.restore", event(4, "activation.changed", activation("active")) + MARKER, 1,
                List.of(resource(binding.get("checkpointRef"), checkpoint)), "checkpoint-1");
        var restored = jdbc.queryForMap("SELECT activation_id, activation_phase,"
                + " activation_event_epoch, activation_expires_at"
                + " FROM qwen_managed_session_journal_head");
        assertThat(restored.get("activation_id")).isEqualTo("activation-1");
        assertThat(restored.get("activation_phase")).isEqualTo("active");
        assertThat(restored.get("activation_event_epoch")).isEqualTo(1L);
        assertThat(restored.get("activation_expires_at")).isNotNull();
    }

    @Test
    void expiredWriterLeaseAloneFencesDispatch() {
        reserve();
        var execution = executions.findByExecutionCallId("execution-1");
        assertThat(store.verifyDispatch(execution, "pub-1", PUBLICATION_TOKEN)).isNotNull();
        // Expire the head lease only. acquireWriter would also rewrite writer identity and
        // reinstate a live lease, so the fence would trip on identity, never on writer_live.
        jdbc.update("UPDATE qwen_managed_session_journal_head SET writer_lease_until = TIMESTAMP '2000-01-01 00:00:00'");
        assertThatThrownBy(() -> store.verifyDispatch(execution, "pub-1", PUBLICATION_TOKEN))
                .hasMessageContaining("Original Session owner is fenced");
    }

    @Test
    void fencesUnusedCapacityAndRequiresDurableNoStartForFullRelease() {
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
    void fencedProducerDoesNotOccupyAnActiveCaptureSlot() {
        ObjectNode second = addSecondExecution();
        store = newStore(2 * ALLOCATION, 1);
        reserve();
        store.apply(request("fence"), WRITER_TOKEN, null);
        ObjectNode next = request("reserve");
        next.set("binding", second);
        assertThat(store.apply(next, WRITER_TOKEN, PUBLICATION_TOKEN)
                .path("state").asText()).isEqualTo("OPEN");
    }

    @Test
    void expiredUnusedReservationReleasesCapacityOnTheNextReserve() {
        ObjectNode second = addSecondExecution();
        store = newStore(ALLOCATION, 1);
        reserve();
        jdbc.update("UPDATE qwen_tool_publication SET expires_at = 1 WHERE publication_id = 'pub-1'");
        ObjectNode next = request("reserve");
        next.set("binding", second);
        assertThat(store.apply(next, WRITER_TOKEN, PUBLICATION_TOKEN)
                .path("state").asText()).isEqualTo("OPEN");
        var expired = jdbc.queryForMap("SELECT state, capture_held_bytes, producer_held_bytes,"
                + " admission_held_bytes FROM qwen_tool_publication WHERE publication_id = 'pub-1'");
        assertThat(expired.get("state")).isEqualTo("FENCED");
        assertThat(((Number) expired.get("capture_held_bytes")).longValue()).isZero();
        assertThat(((Number) expired.get("producer_held_bytes")).longValue()).isZero();
        assertThat(((Number) expired.get("admission_held_bytes")).longValue()).isZero();
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
        append("tool.wait", event(4, "checkpoint.committed",
                checkpointPayload("checkpoint-3")) + MARKER, 1,
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
    void concurrentDistinctReservationsCannotOversubscribeAndFenceReleasesUnusedCapacity() throws Exception {
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
        assertThat(store.apply(loser, WRITER_TOKEN, PUBLICATION_TOKEN).path("state").asText()).isEqualTo("OPEN");
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
        ObjectNode intent = JSON.createObjectNode().put("executionCallId", "execution-2").put("outcomeSource", "runtime");
        intent.set("argsRef", binding.get("argsRef"));
        return addSecondExecutionWith(event(3, "tool.intent", intent) + MARKER);
    }

    private ObjectNode addSecondExecutionWith(String intentRecords) {
        return addSecondExecutionWith(intentRecords, 1);
    }

    private ObjectNode addSecondExecutionWith(String intentRecords,
            int eventCount) {
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
        append("tool.dispatch", intentRecords, eventCount,
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
        return newStore(bytes, count, false);
    }

    private ToolPublicationStore newStore(long bytes, long count,
            boolean journalHeadAuthorization) {
        return journal.newStore(bytes, count, journalHeadAuthorization);
    }

    private JsonNode reserve() {
        return store.apply(request("reserve"), WRITER_TOKEN, PUBLICATION_TOKEN);
    }

    private ObjectNode request(String operation) {
        return journal.request(operation);
    }

    private ObjectNode activation(String phase) {
        return PublicationJournalFixture.activation(phase);
    }

    private String event(long number, String kind, JsonNode payload) {
        return journal.event(number, kind, payload);
    }

    private String event(long number, String kind, JsonNode payload,
            JsonNode sessionKey, int v) {
        return PublicationJournalFixture.event(number, kind, payload,
                sessionKey, v);
    }

    record ApiFixture(JdbcTemplate jdbc, DataSourceTransactionManager manager, ManagedToolResultStore results,
            ManagedAgentStore sessions, ManagedArtifactReader reader, ManagedAgentProperties properties,
            ManagedArtifactPolicy policy, ManagedWorkspaceRegistry workspaces,
            ToolPublicationDataStore publications) {}

    static ApiFixture largeApiFixture(int total) throws Exception {
        var fixture = new ToolPublicationStoreTest();
        fixture.setup();
        return largeApiFixture(total, fixture);
    }

    static ApiFixture largeApiFixture(int total, javax.sql.DataSource source) throws Exception {
        return largeApiFixture(total, source, Integer.MAX_VALUE);
    }

    static ApiFixture largeApiFixture(int total, javax.sql.DataSource source, int maxRead) throws Exception {
        var fixture = new ToolPublicationStoreTest();
        fixture.initialize(source);
        return largeApiFixture(total, fixture, maxRead);
    }

    private static ApiFixture largeApiFixture(int total, ToolPublicationStoreTest fixture) throws Exception {
        return largeApiFixture(total, fixture, Integer.MAX_VALUE);
    }

    private static ApiFixture largeApiFixture(int total, ToolPublicationStoreTest fixture, int maxRead) throws Exception {
        var jdbc = fixture.jdbc;
        var manager = fixture.manager;
        var sessions = fixture.sessions;
        var executions = fixture.executions;
        var bindings = fixture.bindings;
        var binding = fixture.binding;
        var revision = fixture.journal.revision;
        var sequence = fixture.journal.sequence;
        var commitDigest = fixture.journal.commitDigest;
        long allocation =
                total
                        + ToolPublicationContract.PRODUCER_BYTES
                        + ToolPublicationContract.ADMISSION_BYTES;
        var store =
                new ToolPublicationStore(
                        jdbc,
                        manager,
                        sessions,
                        executions,
                        bindings,
                        new ToolPublicationStore.Capacity(total, allocation, allocation, 1),
                        true);
        store.apply(
                fixture.request("reserve").put("captureBytes", total),
                WRITER_TOKEN,
                PUBLICATION_TOKEN);
        Map<String, byte[]> objects = new java.util.HashMap<>();
        ToolPublicationObjectStore bucket =
                new ToolPublicationObjectStore() {
                    @Override
                    public void putIfAbsent(String key, byte[] bytes) {
                        objects.putIfAbsent(key, bytes.clone());
                    }

                    @Override
                    public InputStream open(String key) {
                        return new java.io.FilterInputStream(new ByteArrayInputStream(objects.get(key))) {
                            @Override
                            public int read(byte[] bytes, int offset, int length) throws java.io.IOException {
                                return in.read(bytes, offset, Math.min(length, maxRead));
                            }
                        };
                    }

                    @Override
                    public void requireUnversioned() {}
                };
        var data =
                new ToolPublicationDataStore(
                        jdbc,
                        manager,
                        store,
                        sessions,
                        bucket,
                        Duration.ofMinutes(2),
                        Duration.ofSeconds(30),
                        VERIFICATION_BUDGET);
        JsonNode key = binding.get("sessionKey");
        byte[] segment = "A".repeat(total / 2).getBytes(StandardCharsets.UTF_8);
        data.publishSegment(
                key,
                "pub-1",
                PUBLICATION_TOKEN,
                "operation-1",
                "stdout",
                0,
                segment,
                digest("A".repeat(total / 2)));

        data.publishSegment(
                key,
                "pub-1",
                PUBLICATION_TOKEN,
                "operation-second",
                "stdout",
                1,
                "A".repeat(total / 2).getBytes(StandardCharsets.UTF_8),
                digest("A".repeat(total / 2)));
        data.seal(
                        key,
                        "pub-1",
                        PUBLICATION_TOKEN,
                        "operation-seal",
                        "stdout",
                        2,
                        total,
                        digest("A".repeat(total)))
                .path("segmentCount")
                .asInt();
        data.seal(
                key,
                "pub-1",
                PUBLICATION_TOKEN,
                "operation-seal-empty",
                "stderr",
                0,
                0,
                digest(""));

        ObjectNode page =
                JSON.createObjectNode()
                        .put("toolResult", "managed-tool-result/1")
                        .put("type", "page")
                        .put("captureId", "capture-1")
                        .put("streamId", "stdout")
                        .put("firstOrdinal", 0)
                        .put("offset", 0);
        page.putArray("segments")
                .add(
                        JSON.createObjectNode()
                                .put("byteLength", total / 2)
                                .put("digest", digest("A".repeat(total / 2))))
                .add(
                        JSON.createObjectNode()
                                .put("byteLength", total / 2)
                                .put("digest", digest("A".repeat(total / 2))));

        JsonNode ref =
                data.publishResource(
                        key,
                        "pub-1",
                        PUBLICATION_TOKEN,
                        "operation-3",
                        "page:stdout:0",
                        "managed-tool-result-page",
                        page.toString().getBytes(StandardCharsets.UTF_8));

        ObjectNode manifest =
                JSON.createObjectNode()
                        .put("toolResult", "managed-tool-result/1")
                        .put("type", "manifest")
                        .put("tenantId", "tenant-1")
                        .put("sessionId", "session-1")
                        .put("turnId", "turn-1")
                        .put("executionCallId", "execution-1")
                        .put("callId", "runtime-call-1")
                        .put(
                                "invocationDigest",
                                binding.path("reference").path("argsDigest").asText())
                        .put("bindingGeneration", "1")
                        .put("captureId", "capture-1")
                        .put("revision", 1)
                        .put("executionStatus", "success")
                        .put("exitCode", 0)
                        .putNull("signal")
                        .put("captureScope", "process_pipes")
                        .put("capturePolicy", "complete_required")
                        .put("captureStatus", "complete")
                        .putNull("captureReason")
                        .put("upstreamTruncated", false);
        ObjectNode content =
                JSON.createObjectNode()
                        .put("streamId", "stdout")
                        .put("role", "stdout")
                        .put("mimeType", "application/octet-stream")
                        .put("state", "sealed")
                        .put("byteLength", total)
                        .put("digest", digest("A".repeat(total)));
        content.putArray("missingRanges");
        ObjectNode body = JSON.createObjectNode();
        ObjectNode pageLink =
                JSON.createObjectNode().put("segmentCount", 2).put("byteLength", total);
        pageLink.set("ref", ref);
        body.putArray("pages").add(pageLink);
        content.set("body", body);
        manifest.putArray("contents").add(content);
        ObjectNode stderr =
                JSON.createObjectNode()
                        .put("streamId", "stderr")
                        .put("role", "stderr")
                        .put("mimeType", "application/octet-stream")
                        .put("state", "sealed")
                        .put("byteLength", 0)
                        .put("digest", digest(""));
        stderr.putArray("missingRanges");
        ObjectNode emptyBody = JSON.createObjectNode();
        emptyBody.putArray("pages");
        stderr.set("body", emptyBody);
        ((com.fasterxml.jackson.databind.node.ArrayNode) manifest.path("contents")).add(stderr);
        JsonNode manifestRef =
                data.publishResource(
                        key,
                        "pub-1",
                        PUBLICATION_TOKEN,
                        "operation-manifest",
                        "manifest:1",
                        "managed-tool-result-manifest",
                        manifest.toString().getBytes(StandardCharsets.UTF_8));
        ObjectNode capture =
                JSON.createObjectNode()
                        .put("captureStatus", "complete")
                        .putNull("captureReason")
                        .put("previewTruncated", false)
                        .put("deliveryStatus", "pending");
        capture.set("manifest", manifestRef);
        ObjectNode envelope = JSON.createObjectNode().put("executionStatus", "success");
        envelope.putArray("responseParts");
        envelope.set("capture", capture);
        data.finish(
                        key,
                        "pub-1",
                        PUBLICATION_TOKEN,
                        "operation-finish",
                        envelope.toString().getBytes(StandardCharsets.UTF_8))
                .path("producerPhase")
                .asText();

        store.apply(fixture.request("fence"), WRITER_TOKEN, null);

        ObjectNode outcome =
                JSON.createObjectNode().put("schemaVersion", 1).put("decision", "committed");
        outcome.set("envelope", envelope);
        outcome.set("manifestRef", manifestRef);
        ObjectNode history =
                JSON.createObjectNode()
                        .put("messageId", "22222222-2222-4222-8222-222222222222")
                        .put("timestamp", "2026-09-28T00:00:00Z")
                        .put("model", "test");
        history.putArray("parts").addObject().put("text", "done");
        outcome.set("history", history);
        JsonNode admission =
                data.prepareAdmission(key, "pub-1", "writer-1", 1, WRITER_TOKEN, outcome);

        ObjectNode receiptPayload =
                JSON.createObjectNode()
                        .put("executionCallId", "execution-1")
                        .put("historyRevision", sequence + 1);
        receiptPayload.set("toolOutcomeRef", admission);
        receiptPayload.set("resultRef", manifestRef);
        receiptPayload.putArray("resources").add(manifestRef);
        String recordBytes = fixture.event(sequence + 1, "tool.receipt", receiptPayload) + MARKER;
        long receiptSequence = sequence + 1;
        var commit =
                new ManagedSessionStoreModels.CommitTransactionRequest(
                        "workspace-1",
                        "writer-1",
                        1,
                        revision,
                        sequence,
                        "transaction-receipt",
                        "recordToolResult",
                        "execution-1",
                        admission.path("digest").asText(),
                        receiptSequence,
                        receiptSequence,
                        1,
                        digest(recordBytes),
                        commitDigest,
                        digest(recordBytes),
                        1,
                        null,
                        2,
                        Base64.getEncoder()
                                .encodeToString(recordBytes.getBytes(StandardCharsets.UTF_8)),
                        digest(recordBytes),
                        List.of(
                                new ManagedSessionStoreModels.CommitResource(
                                        admission.path("resourceId").asText(),
                                        "managed-tool-outcome",
                                        1,
                                        admission.path("byteLength").asLong(),
                                        admission.path("digest").asText(),
                                        null),
                                new ManagedSessionStoreModels.CommitResource(
                                        manifestRef.path("resourceId").asText(),
                                        "managed-tool-result-manifest",
                                        1,
                                        manifestRef.path("byteLength").asLong(),
                                        manifestRef.path("digest").asText(),
                                        null)));
        var admissions = new ToolPublicationAdmissionStore(jdbc, manager, sessions, data);
        admissions.commitReceipt(key, "pub-1", WRITER_TOKEN, commit);

        fixture.insertPublicSession();
        var results = fixture.publicResults;
        var properties = fixture.projectionProperties;
        var beans = new org.springframework.beans.factory.support.StaticListableBeanFactory();
        beans.addBean("publication", data);
        var provider = beans.getBeanProvider(ToolPublicationDataStore.class);
        var policy = publicationPolicy();
        new ManagedToolResultProjector(
                        results,
                        jdbc,
                        provider,
                        new ManagedArtifactReader(provider),
                        policy,
                        properties)
                .project(results.claim().orElseThrow());
        return new ApiFixture(
                jdbc,
                manager,
                results,
                fixture.publicSessions,
                new ManagedArtifactReader(provider),
                properties,
                policy,
                fixture.publicWorkspaces,
                data);
    }

    static ApiFixture apiFixture() {
        var fixture = new ToolPublicationStoreTest();
        fixture.setup();
        return apiFixture(fixture);
    }

    static ApiFixture quarantinedApiFixture() {
        var fixture = new ToolPublicationStoreTest();
        fixture.setup();
        fixture.quarantineBeforeProjection = true;
        return apiFixture(fixture);
    }

    static ApiFixture apiFixture(javax.sql.DataSource source) {
        var fixture = new ToolPublicationStoreTest();
        fixture.initialize(source);
        return apiFixture(fixture);
    }

    private static ApiFixture apiFixture(ToolPublicationStoreTest fixture) {
        fixture.keepApiFixture = true;
        fixture.publishesImmutableSegmentAndResourceUnderOriginalAuthorization("intact");
        return new ApiFixture(fixture.jdbc, fixture.manager, fixture.publicResults, fixture.publicSessions,
                fixture.apiReader, fixture.projectionProperties, publicationPolicy(), fixture.publicWorkspaces,
                fixture.apiPublications);
    }

    @Test
    void acceptedProducerEvidenceFeedsRetirementEligibility() {
        var fixture = apiFixture();
        assertThat(fixture.jdbc().queryForObject("SELECT write_evidence AND accepted_complete FROM qwen_tool_publication",
                Boolean.class)).isTrue();
        fixture.jdbc().update("INSERT INTO qwen_output_session_retirement (tenant_key, session_key, tenant_id,"
                + " session_id, operation_id, generation, retired_at, recovery_protected)"
                + " VALUES (?, ?, 'tenant-1', 'session-1', 'delete-1', 1, 1, FALSE)", digest("tenant-1"), digest("session-1"));
        fixture.jdbc().update("UPDATE qwen_tool_publication SET retention_state = 'RETIRING'");
        var retention = new com.alibaba.qwen.code.managedagent.store.ToolPublicationRetentionStore(fixture.jdbc(), fixture.manager());
        assertThat(retention.observe(Duration.ZERO)).singleElement()
                .extracting(com.alibaba.qwen.code.managedagent.store.ToolPublicationRetentionStore.Candidate::blocker).isNull();
    }

    @Test
    void retiredRootRejectsProjectionWhilePublicSessionIsStillReadable() {
        var fixture = apiFixture();
        var artifact = fixture.results().listArtifacts("tenant-1", "session-1", null, null, null, 100)
                .artifacts().getFirst();
        fixture.jdbc().update("DELETE FROM managed_agent_artifact");
        fixture.jdbc().update("DELETE FROM managed_agent_event");
        fixture.jdbc().update("UPDATE managed_agent_tool_result SET work_state = 'PENDING', next_attempt_at = 0");
        var claim = fixture.results().claim().orElseThrow();
        fixture.jdbc().update("INSERT INTO qwen_output_session_retirement (tenant_key, session_key, tenant_id,"
                + " session_id, operation_id, generation, retired_at, recovery_protected)"
                + " VALUES (?, ?, 'tenant-1', 'session-1', 'delete-1', 1, 1, FALSE)", digest("tenant-1"), digest("session-1"));
        var projection = new ManagedToolResultStore.Projection(JSON.createObjectNode(), "pub-1",
                artifact.binding(), artifact.manifestRef(), List.of(artifact), fixture.policy().version());
        assertThat(fixture.results().complete(claim, projection, fixture.policy().version())).isFalse();
        assertThat(fixture.jdbc().queryForMap("SELECT work_state, claim_until, failure_code FROM managed_agent_tool_result"))
                .containsEntry("work_state", "SUPPRESSED").containsEntry("claim_until", null)
                .containsEntry("failure_code", "session_retired");
        assertThat(fixture.jdbc().queryForObject("SELECT COUNT(*) FROM managed_agent_artifact", Long.class)).isZero();
        assertThat(fixture.jdbc().queryForObject("SELECT COUNT(*) FROM managed_agent_event", Long.class)).isZero();
        assertThat(fixture.sessions().requireSession("tenant-1", "session-1").status()).isNotEqualTo("DELETED");
    }

    @Test
    void skipsAutomaticPreviewWhenItsSegmentVerificationExceedsOneMiB() throws Exception {
        var fixture = largeApiFixture(2 * 1024 * 1024 + 2);
        var row = fixture.jdbc().queryForMap("SELECT work_state, descriptor_json FROM managed_agent_tool_result");
        assertThat(row.get("work_state")).isEqualTo("READY");
        var descriptor = JSON.readTree((String) row.get("descriptor_json"));
        assertThat(descriptor.has("preview")).isFalse();
        assertThat(descriptor.path("artifacts")).hasSize(2);
    }

    @Test
    void verifiesEachArtifactOnceIncludingItsPreviewRead() {
        var fixture = apiFixture();
        var data = org.mockito.Mockito.spy(fixture.publications());
        var beans = new org.springframework.beans.factory.support.StaticListableBeanFactory();
        beans.addBean("publication", data);
        var provider = beans.getBeanProvider(ToolPublicationDataStore.class);
        fixture.jdbc().update("DELETE FROM managed_agent_artifact");
        fixture.jdbc().update("UPDATE managed_agent_tool_result SET work_state='PENDING', next_attempt_at=0");
        new ManagedToolResultProjector(fixture.results(), fixture.jdbc(), provider,
                new ManagedArtifactReader(provider), fixture.policy(), fixture.properties())
                .project(fixture.results().claim().orElseThrow());
        assertThat(fixture.jdbc().queryForObject("SELECT work_state FROM managed_agent_tool_result", String.class))
                .isEqualTo("READY");
        assertThat(org.mockito.Mockito.mockingDetails(data).getInvocations().stream()
                .filter(call -> call.getMethod().getName().equals("openReferencedStream")).count()).isEqualTo(2);
    }

    @ParameterizedTest
    @ValueSource(longs = {-28_800_000, 28_800_000})
    void artifactCreationTimeUsesPublicEpochDespiteJdbcWallClockOffset(long offset) throws Exception {
        var fixture = apiFixture();
        fixture.jdbc().update("DELETE FROM managed_agent_artifact");
        fixture.jdbc().update("DELETE FROM managed_agent_event");
        fixture.jdbc().update("UPDATE managed_agent_tool_result SET work_state='PENDING', next_attempt_at=0");
        JdbcTemplate projectionJdbc = new JdbcTemplate(fixture.jdbc().getDataSource()) {
            @Override
            public <T> T queryForObject(String sql, Class<T> type) {
                if ("SELECT CURRENT_TIMESTAMP(6)".equals(sql) && type == java.sql.Timestamp.class) {
                    return type.cast(new java.sql.Timestamp(System.currentTimeMillis() + offset));
                }
                return super.queryForObject(sql, type);
            }
        };
        long before = System.currentTimeMillis();
        new ManagedToolResultProjector(fixture.results(), projectionJdbc,
                publicationProvider(fixture.publications()), fixture.reader(), fixture.policy(), fixture.properties())
                .project(fixture.results().claim().orElseThrow());
        long after = System.currentTimeMillis();
        var row = fixture.jdbc().queryForMap("SELECT work_state, descriptor_json FROM managed_agent_tool_result");
        assertThat(row.get("work_state")).isEqualTo("READY");
        var descriptor = JSON.readTree((String) row.get("descriptor_json"));
        long eventCreatedAt = fixture.jdbc().queryForObject("SELECT MAX(created_at) FROM managed_agent_event", Long.class);
        assertThat(descriptor.path("artifacts")).hasSize(2);
        for (JsonNode artifact : descriptor.path("artifacts")) {
            long createdAt = artifact.path("created_at").asLong();
            assertThat(createdAt).isBetween(before, after);
            assertThat(eventCreatedAt).isBetween(createdAt, after);
        }
    }

    @Test
    void quarantineDuringCommitRetriesThenPublishesOnlyMetadata() throws Exception {
        var fixture = apiFixture();
        fixture.jdbc().update("DELETE FROM managed_agent_artifact");
        fixture.jdbc().update("DELETE FROM managed_agent_event");
        fixture.jdbc().update("UPDATE managed_agent_tool_result SET work_state='PENDING', next_attempt_at=0");
        var policy = org.mockito.Mockito.spy(fixture.policy());
        var calls = new java.util.concurrent.atomic.AtomicInteger();
        org.mockito.Mockito.doAnswer(call -> {
            if (calls.incrementAndGet() == 2) {
                fixture.jdbc().update("UPDATE qwen_tool_publication SET quarantined=TRUE");
            }
            return fixture.policy().version();
        }).when(policy).version();
        var beans = new org.springframework.beans.factory.support.StaticListableBeanFactory();
        beans.addBean("publication", fixture.publications());
        var provider = beans.getBeanProvider(ToolPublicationDataStore.class);
        new ManagedToolResultProjector(fixture.results(), fixture.jdbc(), provider, fixture.reader(), policy,
                fixture.properties()).project(fixture.results().claim().orElseThrow());
        assertThat(fixture.jdbc().queryForMap("SELECT work_state, failure_code FROM managed_agent_tool_result"))
                .containsEntry("work_state", "RETRYABLE").containsEntry("failure_code", "tool_result_source_unavailable");
        assertThat(fixture.jdbc().queryForObject("SELECT COUNT(*) FROM managed_agent_artifact", Long.class)).isZero();
        assertThat(fixture.jdbc().queryForObject("SELECT COUNT(*) FROM managed_agent_event", Long.class)).isZero();
        fixture.jdbc().update("UPDATE managed_agent_tool_result SET next_attempt_at=0");
        new ManagedToolResultProjector(fixture.results(), fixture.jdbc(), provider, fixture.reader(), fixture.policy(),
                fixture.properties()).project(fixture.results().claim().orElseThrow());
        var row = fixture.jdbc().queryForMap("SELECT work_state, descriptor_json FROM managed_agent_tool_result");
        assertThat(row.get("work_state")).isEqualTo("READY");
        var descriptor = JSON.readTree((String) row.get("descriptor_json"));
        assertThat(descriptor.path("artifacts")).isEmpty();
        assertThat(descriptor.has("preview")).isFalse();
    }

    @Test
    void policyChangeDuringCommitRetriesWithoutPublishing() {
        ordinaryNotStartedReceipt();
        insertPublicSession();
        var policy = org.mockito.Mockito.spy(publicationPolicy());
        org.mockito.Mockito.doReturn("policy-before", "policy-after").when(policy).version();
        var provider = publicationProvider(null);
        new ManagedToolResultProjector(publicResults, jdbc, provider, new ManagedArtifactReader(provider), policy,
                projectionProperties).project(publicResults.claim().orElseThrow());
        assertThat(jdbc.queryForMap("SELECT work_state, failure_code FROM managed_agent_tool_result"))
                .containsEntry("work_state", "RETRYABLE").containsEntry("failure_code", "publication_policy_changed");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_artifact", Long.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_event", Long.class)).isZero();
    }

    @Test
    void missingPublicationIsAnUnsupportedProducer() {
        ordinaryNotStartedReceipt();
        insertPublicSession();
        jdbc.update("DELETE FROM qwen_tool_publication");
        var provider = publicationProvider(null);
        new ManagedToolResultProjector(publicResults, jdbc, provider, new ManagedArtifactReader(provider),
                publicationPolicy(), projectionProperties).project(publicResults.claim().orElseThrow());
        assertThat(jdbc.queryForMap("SELECT work_state, failure_code FROM managed_agent_tool_result"))
                .containsEntry("work_state", "UNSUPPORTED").containsEntry("failure_code", "unsupported_receipt_producer");
    }

    @Test
    void oneBackfillPageCapturesTwoJournalTransactions() {
        twoHistoricalReceipts();
        publicResults.backfillOnePage();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_tool_result", Long.class)).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT o3_backfill_pending FROM qwen_managed_session_journal_head", Boolean.class)).isFalse();
    }

    @Test
    void invalidLaterBackfillRecordPreservesEarlierCheckpoint() {
        twoHistoricalReceipts();
        long last = jdbc.queryForObject("SELECT MAX(journal_revision) FROM qwen_managed_session_journal_tx", Long.class);
        jdbc.update("UPDATE qwen_managed_session_journal_tx SET record_digest=? WHERE journal_revision=?", "0".repeat(64), last);
        assertThatThrownBy(publicResults::backfillOnePage).hasMessageContaining("Backfill journal digest changed");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_tool_result", Long.class)).isEqualTo(1);
        assertThat(jdbc.queryForMap("SELECT o3_backfill_revision, o3_backfill_error FROM qwen_managed_session_journal_head"))
                .containsEntry("o3_backfill_revision", last - 1).containsEntry("o3_backfill_error", "invalid_journal");
    }

    private void twoHistoricalReceipts() {
        ordinaryNotStartedReceipt();
        var outcome = publicResults.claim().orElseThrow().source().outcomeRef();
        var receipt = JSON.createObjectNode().put("executionCallId", "execution-2").putNull("resultRef");
        receipt.set("toolOutcomeRef", outcome);
        receipt.putArray("resources");
        append("recordToolResult", event(journal.sequence + 1, "tool.receipt", receipt) + MARKER, 1, List.of(), null);
        jdbc.update("DELETE FROM managed_agent_tool_result");
        jdbc.update("UPDATE qwen_managed_session_journal_head SET o3_backfill_revision=0, o3_backfill_pending=TRUE, o3_backfill_through=NULL");
    }

    @Test
    void publishesASixKiBPreviewWithoutPrematureTruncation() throws Exception {
        var fixture = largeApiFixture(6144);
        var result =
                JSON.readTree(
                        fixture.jdbc()
                                .queryForObject(
                                        "SELECT descriptor_json FROM managed_agent_tool_result",
                                        String.class));
        assertThat(result.path("preview").path("text").asText()).isEqualTo("A".repeat(6144));
        assertThat(result.path("preview").path("source_end").asInt()).isEqualTo(6144);
        assertThat(result.path("preview").path("truncated").asBoolean()).isFalse();
    }

    @Test
    void projectsOrdinaryNotStartedReceiptAndBackfillsItAfterCrash() {
        ordinaryNotStartedReceipt();
        assertThat(jdbc.queryForObject("SELECT producer_phase FROM qwen_tool_publication", String.class)).isEqualTo("OPEN");
        assertThat(jdbc.queryForObject("SELECT receipt_sequence FROM qwen_tool_publication", Long.class)).isNull();
        jdbc.update("DELETE FROM managed_agent_tool_result");
        jdbc.update(
                "UPDATE qwen_managed_session_journal_head SET o3_backfill_pending = TRUE,"
                    + " o3_backfill_through = NULL");
        for (int i = 0; i < 4; i++) {
            publicResults.backfillOnePage();
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_tool_result", Long.class)).isEqualTo(1);
        JsonNode result = projectPublicReceipt(null);
        assertThat(result.path("execution_status").asText()).isEqualTo("not_started");
        assertThat(result.path("capture_status").isNull()).isTrue();
        assertThat(result.path("capture_scope").isNull()).isTrue();
        assertThat(result.path("upstream_truncated").isNull()).isTrue();
        assertThat(result.path("artifacts").isArray()).isTrue();
        assertThat(result.path("artifacts")).isEmpty();
        publicSessions.appendPublicEventIfAbsent("tenant-1", "session-1", "turn_public_1", "item.tool_call.updated",
                Map.of("toolCallId", "model-1", "status", "in_progress"), false, "late-tool-update");
        new TransactionTemplate(manager).executeWithoutResult(status -> publicSessions.materializeNextBatch("tenant-1", "session-1", 100));
        assertThat(publicSessions.findSnapshot("tenant-1", "session-1").orElseThrow().items()).singleElement()
                .satisfies(item -> {
                    assertThat(item.status()).isEqualTo("failed");
                    assertThat(JSON.valueToTree(item.attributes()).path("result")).isEqualTo(result);
                });
    }

    @Test
    void deletionBeforeProjectionSkipsPublicationReads() {
        ordinaryNotStartedReceipt();
        insertPublicSession();
        jdbc.update("UPDATE managed_agent_session SET status = 'DELETING'");
        var provider = publicationProvider(null);
        var reader = org.mockito.Mockito.mock(ManagedArtifactReader.class);
        var policy = org.mockito.Mockito.mock(ManagedArtifactPolicy.class);
        new ManagedToolResultProjector(publicResults, jdbc, provider, reader, policy,
                projectionProperties).project(publicResults.claim().orElseThrow());
        org.mockito.Mockito.verifyNoInteractions(reader, policy);
        assertThat(jdbc.queryForObject("SELECT work_state FROM managed_agent_tool_result", String.class)).isEqualTo("SUPPRESSED");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_event", Long.class)).isZero();
    }

    @Test
    void deletionAfterProjectionReadSuppressesPublicCommit() {
        ordinaryNotStartedReceipt();
        insertPublicSession();
        var original = publicationPolicy();
        var policy = new ManagedArtifactPolicy() {
            public String version() { return original.version(); }
            public boolean publishOriginal(String tenant, String workspace, String session) {
                jdbc.update("UPDATE managed_agent_session SET status = 'DELETING'");
                return true;
            }
            public boolean publishPreview(String tenant, String workspace, String session) { return false; }
            public boolean readOriginal(String tenant, String actor, String workspace, String session) { return true; }
        };
        var provider = publicationProvider(null);
        new ManagedToolResultProjector(publicResults, jdbc, provider, new ManagedArtifactReader(provider), policy,
                projectionProperties).project(publicResults.claim().orElseThrow());
        assertThat(jdbc.queryForObject("SELECT work_state FROM managed_agent_tool_result", String.class)).isEqualTo("SUPPRESSED");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_event", Long.class)).isZero();
    }

    @Test
    void journalRollbackAlsoRollsBackPendingProjectionSource() {
        reserve();
        var ref = ref("rollback-outcome", "managed-tool-outcome", JSON.createObjectNode());
        ObjectNode receipt = JSON.createObjectNode().put("executionCallId", "execution-1").putNull("resultRef");
        receipt.set("toolOutcomeRef", ref);
        receipt.putArray("resources");
        new TransactionTemplate(manager).executeWithoutResult(status -> {
            append("recordToolResult", event(journal.sequence + 1, "tool.receipt", receipt) + MARKER, 1,
                    List.of(resource(ref, JSON.createObjectNode())), null);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_tool_result", Long.class)).isEqualTo(1);
            status.setRollbackOnly();
        });
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_tool_result", Long.class)).isZero();
    }

    @Test
    void lapsedCurrentClaimBacksOffWithoutPublishing() {
        ordinaryNotStartedReceipt();
        insertPublicSession();
        var provider = publicationProvider(null);
        var claim = publicResults.claim().orElseThrow();
        jdbc.update("UPDATE managed_agent_tool_result SET claim_until = 1");
        new ManagedToolResultProjector(
                        publicResults,
                        jdbc,
                        provider,
                        new ManagedArtifactReader(provider),
                        publicationPolicy(),
                        projectionProperties)
                .project(claim);
        var row =
                jdbc.queryForMap(
                        "SELECT work_state, failure_code, next_attempt_at FROM"
                            + " managed_agent_tool_result");
        assertThat(row.get("work_state")).isEqualTo("RETRYABLE");
        assertThat(row.get("failure_code")).isEqualTo("projection_claim_lapsed");
        assertThat(((Number) row.get("next_attempt_at")).longValue())
                .isGreaterThan(System.currentTimeMillis());
        assertThat(publicResults.claim()).isEmpty();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_event", Long.class))
                .isZero();
    }

    @Test
    void missingPublicTurnIsDistinctFromAnUnsupportedProducer() {
        ordinaryNotStartedReceipt();
        insertPublicSession();
        jdbc.update("DELETE FROM managed_agent_turn");
        var provider = publicationProvider(null);
        new ManagedToolResultProjector(
                        publicResults,
                        jdbc,
                        provider,
                        new ManagedArtifactReader(provider),
                        publicationPolicy(),
                        projectionProperties)
                .project(publicResults.claim().orElseThrow());
        assertThat(
                        jdbc.queryForObject(
                                "SELECT failure_code FROM managed_agent_tool_result", String.class))
                .isEqualTo("public_turn_mapping_missing");
    }

    @Test
    void tickPublishesOneReceiptOnlyWhenEnabled() {
        ordinaryNotStartedReceipt();
        insertPublicSession();
        var provider = publicationProvider(null);
        var projector = new ManagedToolResultProjector(publicResults, jdbc, provider,
                new ManagedArtifactReader(provider), publicationPolicy(), projectionProperties);
        projectionProperties.getArtifacts().setEnabled(false);
        projector.tick();
        assertThat(jdbc.queryForObject("SELECT work_state FROM managed_agent_tool_result", String.class)).isEqualTo("PENDING");
        assertThat(jdbc.queryForObject("SELECT claim_generation FROM managed_agent_tool_result", Long.class)).isZero();
        projectionProperties.getArtifacts().setEnabled(true);
        projector.tick();
        assertThat(jdbc.queryForObject("SELECT work_state FROM managed_agent_tool_result", String.class)).isEqualTo("READY");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_event", Long.class)).isEqualTo(1);
    }

    @Test
    void newHeadsSkipHistoricalBackfill() {
        ordinaryNotStartedReceipt();
        assertThat(jdbc.queryForObject("SELECT o3_backfill_pending FROM qwen_managed_session_journal_head", Boolean.class)).isFalse();
        jdbc.update("DELETE FROM managed_agent_tool_result");
        publicResults.backfillOnePage();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_tool_result", Long.class)).isZero();
    }

    private void ordinaryNotStartedReceipt() {
        reserve();
        var execution = executions.findByExecutionCallId("execution-1");
        executions.requestCancel(execution.getExecutionCallId(), execution.getVersion());
        store.apply(request("close_not_started"), WRITER_TOKEN, null);
        ObjectNode envelope = JSON.createObjectNode().put("executionStatus", "not_started").putNull("capture");
        envelope.putArray("responseParts");
        ObjectNode outcome = JSON.createObjectNode().put("schemaVersion", 1).put("decision", "blocked").putNull("manifestRef");
        outcome.set("envelope", envelope);
        JsonNode ref = ref("unstarted-outcome", "managed-tool-outcome", outcome);
        ObjectNode receipt = JSON.createObjectNode().put("executionCallId", "execution-1")
                .put("historyRevision", journal.sequence + 1).putNull("resultRef");
        receipt.set("toolOutcomeRef", ref);
        receipt.putArray("resources");
        append("recordToolResult", event(journal.sequence + 1, "tool.receipt", receipt) + MARKER, 1,
                List.of(resource(ref, outcome)), null);
    }

    private JsonNode projectPublicReceipt(ToolPublicationDataStore data) {
        insertPublicSession();
        var provider = publicationProvider(data);
        var projector = new ManagedToolResultProjector(publicResults, jdbc, provider, new ManagedArtifactReader(provider),
                publicationPolicy(), projectionProperties);
        var crashedClaim = publicResults.claim().orElseThrow();
        jdbc.update("UPDATE managed_agent_tool_result SET claim_until = 1 WHERE result_id = ?", crashedClaim.source().id());
        var replacement = publicResults.claim().orElseThrow();
        projector.project(crashedClaim);
        assertThat(
                        jdbc.queryForObject(
                                "SELECT work_state FROM managed_agent_tool_result", String.class))
                .isEqualTo("LEASED");
        assertThat(
                        jdbc.queryForObject(
                                "SELECT claim_generation FROM managed_agent_tool_result",
                                Long.class))
                .isEqualTo(replacement.generation());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_event", Long.class))
                .isZero();
        projector.project(replacement);
        projector.project(crashedClaim);
        assertThat(jdbc.queryForObject("SELECT work_state FROM managed_agent_tool_result", String.class)).isEqualTo("READY");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_agent_event", Long.class)).isEqualTo(1);
        var result = JSON.valueToTree(jdbc.queryForObject("SELECT data_json FROM managed_agent_event", String.class));
        JsonNode event = ToolPublicationContract.readJson(result.asText().getBytes(StandardCharsets.UTF_8));
        JsonNode descriptor = event.path("result");
        assertThat(descriptor.path("turn_id").asText()).isEqualTo("turn_public_1");
        assertThat(event.path("toolCallId").asText()).isEqualTo("model-1");
        assertThat(publicResults.findResult("tenant-1", "session-1", descriptor.path("item_id").asText()))
                .contains(descriptor);
        assertThat(publicResults.findResult("tenant-1", "other-session", descriptor.path("item_id").asText())).isEmpty();
        new TransactionTemplate(manager).executeWithoutResult(status -> publicSessions.materializeNextBatch("tenant-1", "session-1", 100));
        assertThat(publicSessions.findSnapshot("tenant-1", "session-1").orElseThrow().items()).singleElement()
                .satisfies(item -> assertThat(JSON.valueToTree(item.attributes()).path("result")).isEqualTo(descriptor));
        assertThat(publicSessions.findControlEvents("tenant-1", "session-1", 1)).isEmpty();
        assertThat(jdbc.queryForObject("SELECT status FROM managed_agent_turn", String.class)).isEqualTo("COMPLETED");
        return descriptor;
    }

    private void insertPublicSession() {
        jdbc.update("INSERT INTO managed_agent_session (tenant_id, session_id, agent_id, status, created_at, updated_at,"
                        + " workspace_id, workspace_generation, workspace_storage_id, cwd_relative, context_config_ref,"
                        + " context_revision, workspace_config_ref, workspace_policy_ref)"
                        + " VALUES ('tenant-1', 'session-1', 'qwen-code', 'CLOSED', 1, 1, 'workspace-1', 1, 'storage-1', '.', ?, 1, 'config', 'policy')",
                "sha256:" + digest("config\u0000policy"));
        jdbc.update("INSERT INTO managed_agent_turn (tenant_id, session_id, turn_id, prompt_id, input_json, payload_digest,"
                + " status, created_at, updated_at) VALUES ('tenant-1', 'session-1', 'turn_public_1', 'turn-1', '[]', 'sha256:a', 'COMPLETED', 1, 1)");
        jdbc.update("INSERT INTO managed_agent_consumer_progress (tenant_id, session_id, consumer_name, covered_sequence, updated_at)"
                + " VALUES ('tenant-1', 'session-1', 'message_projection', 0, 1)");
    }

    private static org.springframework.beans.factory.ObjectProvider<ToolPublicationDataStore> publicationProvider(ToolPublicationDataStore data) {
        var beans = new org.springframework.beans.factory.support.StaticListableBeanFactory();
        if (data != null) {
            beans.addBean("publication", data);
        }
        return beans.getBeanProvider(ToolPublicationDataStore.class);
    }

    private static ManagedArtifactPolicy publicationPolicy() {
        return new ManagedArtifactPolicy() {
            public String version() { return "test-v1"; }
            public boolean publishOriginal(String tenant, String workspace, String session) {
                assertThat(org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive()).isFalse();
                return true;
            }
            public boolean publishPreview(String tenant, String workspace, String session) { return true; }
            public boolean readOriginal(String tenant, String actor, String workspace, String session) { return true; }
        };
    }

    private void append(String operation, String records, int events,
            List<ManagedSessionStoreModels.CommitResource> resources, String checkpointId) {
        journal.append(operation, records, events, resources, checkpointId);
    }
}
