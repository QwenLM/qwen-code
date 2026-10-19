package com.alibaba.qwen.code.managedagent;

import ch.qos.logback.classic.Level;
import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
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
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.assertj.core.api.ThrowableAssert.ThrowingCallable;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DelegatingDataSource;
import org.springframework.transaction.support.TransactionTemplate;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.SQLException;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;

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
        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema.initialize(source);
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

    @Test
    void localReservationWaitsForLifecyclePlacementBeforeLockingBrokerRows() throws Exception {
        try (var pool = Executors.newSingleThreadExecutor()) {
            var publisher = new TransactionTemplate(manager).execute(status -> {
                com.alibaba.qwen.code.managedagent.store.WorkspaceLifecycleStore.lockPlacement(jdbc, "tenant-1");
                String tenantKey = ToolPublicationContract.sha256("tenant-1".getBytes(StandardCharsets.UTF_8));
                jdbc.update("INSERT INTO ma_tenant_guard (tenant_key, tenant_id, guard_domain) VALUES (?, ?, 'output_publication')"
                        + " ON DUPLICATE KEY UPDATE tenant_key = tenant_key", tenantKey, "tenant-1");
                jdbc.queryForList("SELECT tenant_id FROM ma_tenant_guard WHERE guard_domain = 'output_publication' AND tenant_key = ? FOR UPDATE",
                        tenantKey);
                var entered = new CountDownLatch(1);
                var pending = pool.submit(() -> {
                    entered.countDown();
                    return reserve();
                });
                try {
                    assertThat(entered.await(3, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                    assertThatThrownBy(() -> pending.get(250, java.util.concurrent.TimeUnit.MILLISECONDS))
                            .isInstanceOf(java.util.concurrent.TimeoutException.class);
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(error);
                }
                RuntimeBindingRecord original = jdbc.execute(
                        (org.springframework.jdbc.core.ConnectionCallback<RuntimeBindingRecord>) connection ->
                                bindings.findByIdForUpdate(connection, "binding-1"));
                assertThat(original.getBindingId()).isEqualTo("binding-1");
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_output_capture", Integer.class)).isZero();
                return pending;
            });
            assertThat(publisher.get(3, java.util.concurrent.TimeUnit.SECONDS).path("publicationId").asText())
                    .isEqualTo("pub-1");
        }
    }

    @Test
    void localReservationHoldsBothBrokerRowsUntilThePublicationCommits() throws Exception {
        var reserved = new CountDownLatch(1);
        var release = new CountDownLatch(1);
        try (var pool = Executors.newFixedThreadPool(3)) {
            var publisher = pool.submit(() -> new TransactionTemplate(manager).execute(status -> {
                JsonNode grant = reserve();
                reserved.countDown();
                try {
                    assertThat(release.await(5, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(error);
                }
                return grant;
            }));
            try {
                assertThat(reserved.await(3, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                var bindingLock = pool.submit(() -> jdbc.queryForList(
                        "SELECT binding_id FROM ma_runtime_binding WHERE binding_id = ? FOR UPDATE", "binding-1"));
                var executionLock = pool.submit(() -> jdbc.queryForList(
                        "SELECT execution_call_id FROM ma_tool_execution WHERE execution_call_id = ? FOR UPDATE", "execution-1"));
                for (var contender : List.of(bindingLock, executionLock)) {
                    assertThatThrownBy(() -> contender.get(250, java.util.concurrent.TimeUnit.MILLISECONDS))
                            .isInstanceOf(java.util.concurrent.TimeoutException.class);
                }
                release.countDown();
                assertThat(publisher.get(3, java.util.concurrent.TimeUnit.SECONDS).path("publicationId").asText())
                        .isEqualTo("pub-1");
                assertThat(bindingLock.get(3, java.util.concurrent.TimeUnit.SECONDS)).hasSize(1);
                assertThat(executionLock.get(3, java.util.concurrent.TimeUnit.SECONDS)).hasSize(1);
            } finally {
                release.countDown();
            }
        }
    }

    @Test
    void localReservationRechecksBindingAfterWaitingForRetirement() throws Exception {
        try (var connection = jdbc.getDataSource().getConnection(); var pool = Executors.newSingleThreadExecutor()) {
            connection.setAutoCommit(false);
            bindings.findByIdForUpdate(connection, "binding-1");
            var entered = new CountDownLatch(1);
            var publisher = pool.submit(() -> {
                entered.countDown();
                return reserve();
            });
            try {
                assertThat(entered.await(3, java.util.concurrent.TimeUnit.SECONDS)).isTrue();
                assertThatThrownBy(() -> publisher.get(250, java.util.concurrent.TimeUnit.MILLISECONDS))
                        .isInstanceOf(java.util.concurrent.TimeoutException.class);
                try (var statement = connection.prepareStatement("UPDATE ma_runtime_binding"
                        + " SET binding_state = 'RELEASED' WHERE binding_id = ?")) {
                    statement.setBytes(1, "binding-1".getBytes(StandardCharsets.UTF_8));
                    statement.executeUpdate();
                }
                connection.commit();
                assertThatThrownBy(() -> publisher.get(3, java.util.concurrent.TimeUnit.SECONDS))
                        .hasRootCauseMessage("Runtime cannot authorize publication");
                assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_output_capture", Integer.class)).isZero();
            } finally {
                connection.rollback();
            }
        }
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
        assertThat(jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_resource WHERE slot_key ="
                                        + " X'61646d697373696f6e'",
                Integer.class)).isZero();
        JsonNode outcome = blockedOutcome(terminal);
        JsonNode candidate = data.prepareAdmission(binding.get("sessionKey"), "pub-1", "writer-1", 1,
                WRITER_TOKEN, outcome);
        assertThat(data.prepareAdmission(binding.get("sessionKey"), "pub-1", "writer-1", 1,
                WRITER_TOKEN, outcome)).isEqualTo(candidate);
        assertThat(csiStore.inspect(csiRegistration).phase()).isEqualTo("DRAINING");
        assertThat(jdbc.queryForObject("SELECT active_binding_id FROM ma_runtime_slot", String.class))
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
        var before = jdbc.queryForMap("SELECT " + ManagedSchemaProjection.OUTPUT_CAPTURE.columns() + " FROM ma_output_capture");
        assertThatThrownBy(() -> data.prepareAdmission(binding.get("sessionKey"), "pub-1", "writer-1", 1,
                WRITER_TOKEN, blockedOutcome(terminal)))
                .hasMessageContaining("Original settled Broker result conflicts");
        assertThat(jdbc.queryForMap("SELECT " + ManagedSchemaProjection.OUTPUT_CAPTURE.columns() + " FROM ma_output_capture")).isEqualTo(before);
        assertThat(jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_resource WHERE slot_key ="
                                        + " X'61646d697373696f6e'",
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
        var before = jdbc.queryForList(
                        "SELECT " + ManagedSchemaProjection.OPERATION.columns() + " FROM ma_operation WHERE operation_kind IN ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH') ORDER BY operation_id");
        var publication = jdbc.queryForMap("SELECT " + ManagedSchemaProjection.OUTPUT_CAPTURE.columns() + " FROM ma_output_capture");
        assertThat(data.publishSegment(binding.get("sessionKey"), "pub-1", PUBLICATION_TOKEN,
                "segment-0", "stdout", 0, output, digest("original"))).isEqualTo(receipt);
        assertThat(data.finish(binding.get("sessionKey"), "pub-1", PUBLICATION_TOKEN, "finish-1",
                terminal.toString().getBytes(StandardCharsets.UTF_8))).isEqualTo(finish);
        assertThatThrownBy(() -> data.publishSegment(binding.get("sessionKey"), "pub-1", PUBLICATION_TOKEN,
                "new-operation", "stdout", 0, output, digest("original"))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> data.prefix(binding.get("sessionKey"), "pub-1", PUBLICATION_TOKEN,
                "new-prefix", "stdout")).isInstanceOf(IllegalArgumentException.class);
        assertThat(jdbc.queryForList(
                                "SELECT " + ManagedSchemaProjection.OPERATION.columns() + " FROM ma_operation WHERE operation_kind IN ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH') ORDER BY operation_id")).usingRecursiveComparison().isEqualTo(before);
        assertThat(jdbc.queryForMap("SELECT " + ManagedSchemaProjection.OUTPUT_CAPTURE.columns() + " FROM ma_output_capture")).isEqualTo(publication);
    }

    @ParameterizedTest
    @CsvSource({"marker,false", "journal,false", "unknown,false", "grant,false",
            "marker,true", "journal,true", "unknown,true", "grant,true"})
    void csiTailRefusesMissingOrClosedOriginalAuthority(String damage, boolean journalHeadAuthorization) {
        var execution = authorizeCsi(journalHeadAuthorization);
        retireCsi();
        if ("marker".equals(damage)) {
            jdbc.update(
                    "UPDATE ma_tool_execution SET authorized_dispatch_generation = NULL,"
                            + " authorized_binding_version = NULL");
        } else if ("journal".equals(damage)) {
            jdbc.update("DELETE FROM ma_operation WHERE operation_kind = 'CSI_RETIREMENT'");
        } else if ("unknown".equals(damage)) {
            executions.compareAndSet(execution, execution.withUnknown(), "dispatcher", execution.getDispatchGeneration());
        } else {
            jdbc.update("UPDATE ma_output_capture SET expires_at = 0");
        }
        var data = csiData(new java.util.HashMap<>());
        var before = jdbc.queryForMap("SELECT " + ManagedSchemaProjection.OUTPUT_CAPTURE.columns() + " FROM ma_output_capture");
        assertThatThrownBy(() -> data.publishSegment(binding.get("sessionKey"), "pub-1", PUBLICATION_TOKEN,
                "segment-0", "stdout", 0, new byte[] {1}, null))
                .isInstanceOf(RuntimeException.class);
        assertThat(jdbc.queryForMap("SELECT " + ManagedSchemaProjection.OUTPUT_CAPTURE.columns() + " FROM ma_output_capture")).isEqualTo(before);
        assertThat(jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_operation WHERE operation_kind IN"
                                        + " ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH')", Integer.class)).isZero();
        assertThat(csiStore.inspect(csiRegistration).phase()).isEqualTo("DRAINING");
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void csiSealRefusesNewGrantReserveRenewAndInstallation(boolean journalHeadAuthorization) {
        var execution = authorizeCsi(journalHeadAuthorization);
        retireCsi();
        var before = jdbc.queryForMap("SELECT " + ManagedSchemaProjection.OUTPUT_CAPTURE.columns() + " FROM ma_output_capture");
        assertThatThrownBy(this::reserve).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> store.apply(request("renew"), WRITER_TOKEN, PUBLICATION_TOKEN))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> store.verifyDispatch(execution, "pub-1", PUBLICATION_TOKEN))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(jdbc.queryForMap("SELECT " + ManagedSchemaProjection.OUTPUT_CAPTURE.columns() + " FROM ma_output_capture")).isEqualTo(before);
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
        assertThat(jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_operation WHERE operation_kind IN"
                                        + " ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH')", Integer.class)).isZero();
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
            public void validateConfiguration() { }
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

    private Map<String, List<Map<String, Object>>> producerTables() {
        var result = new java.util.TreeMap<String, List<Map<String, Object>>>();
        for (String table : List.of("ma_tenant_guard", "ma_session_head",
                "ma_output_capture", "ma_resource", "ma_operation",
                "ma_resource_ref")) {
            result.put(table, jdbc.queryForList("SELECT * FROM " + table));
        }
        return result;
    }

    @ParameterizedTest
    @CsvSource({"row-scope,apply", "row-scope,prepare", "binding-key,apply", "binding-key,prepare",
            "binding-id,apply", "binding-id,prepare", "binding-generation,apply", "binding-generation,prepare",
            "digest,apply", "digest,prepare",
            "runtime-tenant,apply", "runtime-tenant,prepare", "runtime-workspace,apply", "runtime-workspace,prepare",
            "runtime-generation,apply", "runtime-generation,prepare",
            "runtime-provisioner,apply", "runtime-provisioner,prepare"})
    void publicationTargetConflictRefusesBeforeChoosingPlacement(String conflict, String operation) {
        reserve();
        if (conflict.startsWith("runtime-")) {
            var discovered = bindings.findById("binding-1");
            var repository = org.mockito.Mockito.mock(JdbcRuntimeBindingRepository.class);
            org.mockito.Mockito.when(repository.findById("binding-1")).thenReturn(discovered);
            org.mockito.Mockito.when(repository.usesDataSource(jdbc.getDataSource())).thenReturn(true);
            store = new ToolPublicationStore(jdbc, manager, sessions, executions, repository,
                    new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, 10 * ALLOCATION, 10 * ALLOCATION, 10));
        }
        switch (conflict) {
            case "row-scope" -> jdbc.update("UPDATE ma_output_capture SET tenant_id = X'6f746865722d74656e616e74'");
            case "binding-key", "binding-id", "binding-generation" -> {
                ObjectNode changed = binding.deepCopy();
                if ("binding-key".equals(conflict)) {
                    ((ObjectNode) changed.path("sessionKey")).put("tenantId", "other-tenant");
                } else if ("binding-id".equals(conflict)) {
                    changed.put("publicationId", "other-publication");
                } else {
                    changed.put("bindingGeneration", "2");
                }
                jdbc.update("UPDATE ma_output_capture SET binding_json = ?, binding_digest = ?",
                        changed.toString(), ToolPublicationContract.bindingDigest(changed));
            }
            case "digest" -> jdbc.update("UPDATE ma_output_capture SET binding_digest = ?", "b".repeat(64));
            case "runtime-tenant" -> jdbc.update(
                            "UPDATE ma_runtime_binding SET tenant_id ="
                                    + " X'6f746865722d74656e616e74'");
            case "runtime-workspace" -> jdbc.update(
                            "UPDATE ma_runtime_binding SET workspace_id ="
                                    + " X'6f746865722d776f726b7370616365'");
            case "runtime-generation" -> jdbc.update("UPDATE ma_runtime_binding SET runtime_generation = 2");
            case "runtime-provisioner" -> jdbc.update("UPDATE ma_runtime_binding SET provisioner_kind = ?",
                    WorkspaceCsiReservationStore.PROVISIONER_KIND);
            default -> throw new AssertionError("Unexpected target conflict");
        }
        jdbc.update("DELETE FROM ma_tenant_guard WHERE guard_domain = 'runtime_placement'");
        var before = producerTables();
        assertThatThrownBy(() -> new TransactionTemplate(manager).execute(status -> {
            try {
                if ("apply".equals(operation)) {
                    return store.apply(request("fence"), WRITER_TOKEN, null);
                }
                return csiData(new java.util.HashMap<>()).prepareAdmission(binding.path("sessionKey"), "pub-1",
                        "writer-1", 1, WRITER_TOKEN, JSON.createObjectNode().put("schemaVersion", 1));
            } catch (RuntimeException failure) {
                assertThat(jdbc.queryForList(
                                                                                "SELECT " + ManagedSchemaProjection.TENANT_GUARD.columns() + " FROM ma_tenant_guard WHERE guard_domain = 'runtime_placement'")).isEmpty();
                assertThat(producerTables()).usingRecursiveComparison().isEqualTo(before);
                throw failure;
            }
        })).isInstanceOf(IllegalArgumentException.class)
                .hasMessage("digest".equals(conflict) ? "Stored binding is corrupt"
                        : conflict.startsWith("runtime-") ? "Original persisted Runtime scope conflicts"
                        : "binding-generation".equals(conflict) ? "Broker execution identity conflicts"
                        : "Publication scope conflicts");
        assertThat(jdbc.queryForList(
                                "SELECT " + ManagedSchemaProjection.TENANT_GUARD.columns() + " FROM ma_tenant_guard WHERE guard_domain = 'runtime_placement'")).isEmpty();
        assertThat(producerTables()).usingRecursiveComparison().isEqualTo(before);
    }

    @Test
    void newReservationRecreatesOnlyItsQualifiedPlacementWhenPublicSessionIsMissing() {
        jdbc.update("DELETE FROM ma_tenant_guard WHERE guard_domain = 'runtime_placement'");
        assertThat(jdbc.queryForList("SELECT " + ManagedSchemaProjection.SESSION.columns() + " FROM ma_session WHERE session_kind = 'PUBLIC'")).isEmpty();
        assertThat(reserve().path("state").asText()).isEqualTo("OPEN");
        assertThat(jdbc.queryForList(
                                "SELECT tenant_id FROM ma_tenant_guard WHERE guard_domain ="
                                        + " 'runtime_placement'"))
                .containsExactly(Map.of("tenant_id", "tenant-1"));
        assertThat(reserve().path("state").asText()).isEqualTo("OPEN");
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
            public void validateConfiguration() { }
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
            public void validateConfiguration() { }
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
        assertThatThrownBy(() -> data.publishSegment(key, "pub-1", PUBLICATION_TOKEN,
                "original-operation", "stdout", 0, bytes, digest("retry")))
                .hasMessageContaining("original object write is unresolved");
        assertThat(writes.get()).isEqualTo(1);
        assertThat(jdbc.queryForObject(
                                "SELECT state FROM ma_operation WHERE operation_kind ="
                                        + " 'OBJECT_PUT'", String.class))
                .isEqualTo("UNKNOWN");
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
            public void validateConfiguration() { }
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
                jdbc.update(
                        "UPDATE ma_operation SET deadline = (" + ManagedSchemaTime.SQL_NOW + " + -1000) WHERE operation_id = X'6f726967696e616c'");
                var originalDeadline = jdbc.queryForObject(
                                "SELECT deadline FROM ma_operation WHERE operation_kind IN"
                                        + " ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH') AND"
                                        + " operation_id = X'6f726967696e616c'", java.sql.Timestamp.class);
                var before = jdbc.queryForMap(
                                "SELECT capture_object_key AS object_key, resource_id, byte_length,"
                                    + " sha256, operation_id FROM ma_resource WHERE publication_id"
                                    + " = X'7075622d31'");
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
                var recoveryStarted = jdbc.queryForObject("SELECT " + ManagedSchemaTime.SQL_NOW + "", java.sql.Timestamp.class);
                assertThat(replacement.recoverOperation(key, "pub-1", PUBLICATION_TOKEN, "original")
                        .path("state").asText()).isEqualTo("RETRYABLE");
                var recoveryFinished = jdbc.queryForObject("SELECT " + ManagedSchemaTime.SQL_NOW, java.sql.Timestamp.class);
                var recoveryDeadline = jdbc.queryForObject(
                                "SELECT recovery_deadline FROM ma_operation WHERE operation_kind IN"
                                        + " ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH') AND"
                                        + " operation_id = X'6f726967696e616c'", java.sql.Timestamp.class);
                long recoveryWindowMillis = Duration.ofMinutes(2)
                        .plusSeconds(terminal ? (bytes.length + 255L) / 256 : 0).toMillis();
                assertThat(recoveryDeadline.getTime()).isBetween(
                        recoveryStarted.getTime() / 1000 * 1000 + recoveryWindowMillis,
                        recoveryFinished.getTime() + recoveryWindowMillis);
                replacement.recoverOperation(key, "pub-1", PUBLICATION_TOKEN, "original");
                assertThat(jdbc.queryForObject(
                                        "SELECT recovery_deadline FROM ma_operation WHERE"
                                            + " operation_kind IN ('OUTPUT_UPLOAD',"
                                            + " 'OUTPUT_VERIFY', 'OUTPUT_FINISH') AND operation_id"
                                            + " = X'6f726967696e616c'", java.sql.Timestamp.class)).isEqualTo(recoveryDeadline);
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
                JsonNode recovered = terminal
                        ? replacement.finish(key, "pub-1", PUBLICATION_TOKEN, "original", bytes)
                        : replacement.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "original", "stdout", 0, bytes, null);
                assertThat(writes).hasValue(1);
                assertThat(jdbc.queryForObject(
                                        "SELECT state FROM ma_operation WHERE operation_kind ="
                                                + " 'OBJECT_PUT'",
                        String.class)).isEqualTo("RETURNED");
                release.countDown();
                assertThatThrownBy(() -> old.get(10, java.util.concurrent.TimeUnit.SECONDS))
                        .hasCauseInstanceOf(ApiException.class);
                JsonNode receipt = terminal
                        ? replacement.finish(key, "pub-1", PUBLICATION_TOKEN, "original", bytes)
                        : replacement.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "original", "stdout", 0, bytes, null);
                assertThat(receipt).isEqualTo(recovered);
                assertThat(writes).hasValue(1);
                assertThat(replacement.operationStatus(key, "pub-1", PUBLICATION_TOKEN, "original")
                        .path("receipt")).isEqualTo(receipt);
                assertThat(jdbc.queryForMap(
                                        "SELECT capture_object_key AS object_key, resource_id,"
                                            + " byte_length, sha256, operation_id FROM ma_resource"
                                            + " WHERE publication_id = X'7075622d31'")).isEqualTo(before);
                assertThat(jdbc.queryForObject(
                                        "SELECT deadline FROM ma_operation WHERE operation_kind IN"
                                            + " ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH')"
                                            + " AND operation_id = X'6f726967696e616c'", java.sql.Timestamp.class)).isEqualTo(originalDeadline);
                assertThat(objects).hasSize(1);
                String category = terminal ? "producer" : "capture";
                assertThat(jdbc.queryForObject("SELECT " + category + "_used_bytes FROM ma_output_capture"
                        + " WHERE publication_id = X'7075622d31'", Long.class)).isEqualTo((long) bytes.length);
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
                if (!terminal) {
                    hold();
                }
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
                if (terminal) {
                    hold();
                }
                return new ByteArrayInputStream(objects.get(key));
            }

            @Override
            public void validateConfiguration() { }
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
                jdbc.update("UPDATE ma_operation SET " + column
                        + " = (" + ManagedSchemaTime.SQL_NOW + " + -1000) WHERE operation_id = X'68656c64'");
                assertThat(data.operationStatus(key, "pub-1", PUBLICATION_TOKEN, "held").path("state").asText())
                        .isEqualTo(expired ? "EXPIRED" : "RETRYABLE");
                var candidate = jdbc.queryForMap(
                                "SELECT capture_object_key AS object_key, resource_id, byte_length,"
                                        + " sha256 FROM ma_resource WHERE publication_id ="
                                        + " X'7075622d31'");
                release.countDown();
                assertThatThrownBy(() -> old.get(10, java.util.concurrent.TimeUnit.SECONDS))
                        .satisfies(error -> {
                            assertThat(error.getCause()).isInstanceOf(ApiException.class);
                            assertThat(((ApiException) error.getCause()).getCode()).isEqualTo(expired
                                    ? "managed_tool_publication_operation_expired"
                                    : "managed_tool_publication_claim_expired");
                        });
                assertThat(jdbc.queryForObject("SELECT capture_state FROM ma_resource"
                        + " WHERE publication_id = X'7075622d31'", String.class)).isEqualTo("CANDIDATE");
                if (expired) {
                    data.recoverOperation(key, "pub-1", PUBLICATION_TOKEN, "held");
                }
                JsonNode receipt = terminal ? data.finish(key, "pub-1", PUBLICATION_TOKEN, "held", bytes)
                        : data.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "held", "stdout", 0, bytes, null);
                assertThat(data.operationStatus(key, "pub-1", PUBLICATION_TOKEN, "held").path("receipt"))
                        .isEqualTo(receipt);
                assertThat(jdbc.queryForMap(
                                        "SELECT capture_object_key AS object_key, resource_id,"
                                                + " byte_length, sha256 FROM ma_resource WHERE"
                                                + " publication_id = X'7075622d31'")).isEqualTo(candidate);
                String category = terminal ? "producer" : "capture";
                assertThat(jdbc.queryForObject("SELECT " + category + "_used_bytes FROM ma_output_capture"
                        + " WHERE publication_id = X'7075622d31'", Long.class)).isEqualTo((long) bytes.length);
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
            public void validateConfiguration() { }
        };
        var data = new ToolPublicationDataStore(jdbc, manager, store, sessions, bucket,
                Duration.ofMinutes(2), Duration.ofSeconds(30), VERIFICATION_BUDGET);
        JsonNode key = binding.get("sessionKey");
        assertThatThrownBy(() -> data.publishSegment(key, "pub-1", PUBLICATION_TOKEN,
                "candidate", "stdout", 0, new byte[] {1}, null)).hasMessageContaining("lost PUT reply");
        data.prefix(key, "pub-1", PUBLICATION_TOKEN, "prefix", "stderr");
        jdbc.update("UPDATE ma_operation SET deadline = (" + ManagedSchemaTime.SQL_NOW + " + -1000), state = 'PENDING'");
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

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void commitsLargeBlockedOutcomeThroughVerifiedCatalogObject(boolean ambient) {
        List<String> lockOrder = new java.util.ArrayList<>();
        initialize(new DelegatingDataSource(publicationDataSource()) {
            @Override
            public Connection getConnection() throws SQLException {
                Connection connection = super.getConnection();
                return (Connection) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[] {Connection.class},
                        (proxy, method, args) -> {
                            try {
                                Object result = method.invoke(connection, args);
                                if (!method.getName().equals("prepareStatement")
                                        || !(result instanceof PreparedStatement statement)) {
                                    return result;
                                }
                                String sql = (String) args[0];
                                return Proxy.newProxyInstance(getClass().getClassLoader(),
                                        new Class<?>[] {PreparedStatement.class}, (prepared, call, values) -> {
                                            if (call.getName().startsWith("execute")) {
                                                if (sql.startsWith(
                                                                                "INSERT INTO"
                                                                                    + " ma_tenant_guard") && sql.contains("'runtime_placement'")) {
                                                    lockOrder.add("placement");
                                                } else if (sql.startsWith(
                                                                                "INSERT INTO"
                                                                                    + " ma_tenant_guard") && sql.contains("'output_publication'")) {
                                                    lockOrder.add("retention");
                                                }
                                            }
                                            try {
                                                return call.invoke(statement, values);
                                            } catch (InvocationTargetException failure) {
                                                throw failure.getCause();
                                            }
                                        });
                            } catch (InvocationTargetException failure) {
                                throw failure.getCause();
                            }
                        });
            }
        });
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
            public void validateConfiguration() {
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
        lockOrder.clear();
        JsonNode receipt = ambient ? new TransactionTemplate(manager).execute(status ->
                admissions.commitReceipt(key, "pub-1", WRITER_TOKEN, commit))
                : admissions.commitReceipt(key, "pub-1", WRITER_TOKEN, commit);
        assertThat(receipt.path("decision").asText()).isEqualTo("blocked");
        if (ambient) {
            assertThat(lockOrder).contains("retention");
            assertThat(lockOrder.getFirst()).isEqualTo("placement");
        }
        var changedReplay = new ManagedSessionStoreModels.CommitTransactionRequest("workspace-1", "writer-1", 1,
                journal.revision, journal.sequence, "different-transaction", "recordToolResult", "execution-1",
                admission.path("digest").asText(), journal.sequence + 1, journal.sequence + 1, 1,
                digest(records), journal.commitDigest, digest(records), 1, null, 2,
                Base64.getEncoder().encodeToString(records.getBytes(StandardCharsets.UTF_8)),
                digest(records), commit.resources());
        assertThatThrownBy(() -> admissions.commitReceipt(key, "pub-1", WRITER_TOKEN, changedReplay))
                .hasMessageContaining("different content");
        JsonNode replay = ambient ? new TransactionTemplate(manager).execute(status ->
                admissions.commitReceipt(key, "pub-1", WRITER_TOKEN, commit))
                : admissions.commitReceipt(key, "pub-1", WRITER_TOKEN, commit);
        assertThat(replay).isEqualTo(receipt);
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
        String objectKey = jdbc.queryForObject("SELECT capture_object_key FROM ma_resource"
                + " WHERE slot_key = X'61646d697373696f6e'", String.class);
        objects.get(objectKey)[0] = 'z';
        assertThatThrownBy(() -> sessions.readResource("tenant-1", "workspace-1", "session-1",
                admission.path("resourceId").asText(), WRITER_TOKEN)).hasMessageContaining("verification");
        assertThat(jdbc.queryForObject("SELECT quarantined FROM ma_output_capture"
                + " WHERE publication_id = X'7075622d31'", Boolean.class)).isTrue();
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
            public void validateConfiguration() {
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
        if (!large) {
            pageSegments.add(JSON.createObjectNode().put("byteLength", 1).put("digest", digest("c")));
        }
        assertThatThrownBy(() -> data.publishResource(key, "pub-1", PUBLICATION_TOKEN,
                "wrong-page-slot", "page:stdout:1", "managed-tool-result-page",
                page.toString().getBytes(StandardCharsets.UTF_8)))
                .hasMessageContaining("slot conflicts");
        JsonNode ref = data.publishResource(key, "pub-1", PUBLICATION_TOKEN,
                "operation-3", "page:stdout:0", "managed-tool-result-page",
                page.toString().getBytes(StandardCharsets.UTF_8));
        assertThat(data.readResource(key, "pub-1", ref.path("resourceId").asText()))
                .isEqualTo(page.toString().getBytes(StandardCharsets.UTF_8));
        assertThat(jdbc.queryForObject("SELECT capture_used_bytes FROM ma_output_capture",
                Long.class)).isEqualTo((long) segmentLength);
        assertThat(jdbc.queryForObject("SELECT producer_used_bytes FROM ma_output_capture",
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
                + " FROM ma_output_capture WHERE publication_id = X'7075622d31'");
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
        if (partial) {
            return;
        }
        if ("intact".equals(damage) || large) {
            com.alibaba.qwen.code.managedagent.store.WorkspaceRecoveryReaderAssertions.verifyOriginalPublication(
                    jdbc, bucket, key, admission, manifestRef, receiptSequence, firstSegment.getBytes(StandardCharsets.UTF_8));
        }
        if (!"intact".equals(damage) && !large) {
            switch (damage) {
                case "missing-page" -> deleteCapturedSlot("page:stdout:0");
                case "corrupt-page" -> jdbc.update("UPDATE ma_resource SET inline_bytes = ?"
                        + " WHERE slot_key = X'706167653a7374646f75743a30'", new byte[]{1});
                case "missing-segment" -> deleteCapturedSlot("segment:stdout:0");
                case "corrupt-segment" -> objects.values().iterator().next()[0] = 'z';
                case "missing-empty-seal" -> jdbc.update(
                                "UPDATE ma_output_capture SET seal_manifest_resource_key = NULL,"
                                        + " seal_manifest_sha256 = NULL");
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
                jdbc.update(
                        "UPDATE ma_output_capture SET quarantined = TRUE WHERE publication_id ="
                                + " X'7075622d31'");
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
            jdbc.update("UPDATE ma_session_head SET writer_lease_until = ?",
                    java.time.Instant.parse("2000-01-01T00:00:00Z").toEpochMilli());
            assertThat(publicReader.readRange(stdout, 1, 2)).isEqualTo("bc".getBytes(StandardCharsets.UTF_8));
            var guardCalls = new java.util.concurrent.atomic.AtomicInteger();
            assertThatThrownBy(() -> publicReader.readRange(stdout, 1, 2, () -> {
                if (guardCalls.incrementAndGet() == 2) {
                    throw new IllegalStateException("revoked mid-range");
                }
            })).hasMessage("revoked mid-range");
            // Restore the lease only for the existing private-reader corruption checks.
            jdbc.update("UPDATE ma_session_head SET writer_lease_until = ?",
                    java.time.Instant.parse("2037-01-01T00:00:00Z").toEpochMilli());
            if (keepApiFixture) {
                apiPublications = data;
                apiReader = publicReader;
                apiObjects = objects;
                return;
            }
        }
        String damagedSlot = contentBody ? "content:stdout" : "segment:stdout:0";
        String damagedKey = jdbc.queryForObject("SELECT capture_object_key FROM ma_resource WHERE slot_key = ?",
                String.class, damagedSlot);
        objects.get(damagedKey)[0] = 'z';
        assertThatThrownBy(() -> data.readRange(key, "pub-1", WRITER_TOKEN, manifestRef,
                identity, "stdout", 0, 1)).hasMessageContaining("digest changed");
        assertThat(jdbc.queryForObject("SELECT capture_state FROM ma_resource"
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
            jdbc.update(
                    "UPDATE ma_output_capture SET quarantined = TRUE WHERE publication_id ="
                            + " X'7075622d31'");
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
            String secondObject = jdbc.queryForObject("SELECT capture_object_key FROM ma_resource"
                    + " WHERE slot_key = X'7365676d656e743a7374646f75743a31'", String.class);
            apiObjects.get(secondObject)[0] = 'x';
            byte[] target = new byte[] {'?'};
            assertThatThrownBy(() -> stream.read(target)).hasMessageContaining("digest changed");
            assertThat(target).containsExactly((byte) '?');
            assertThatThrownBy(() -> stream.read(target)).hasMessageContaining("receipt is unavailable");
            assertThat(target).containsExactly((byte) '?');
            assertThat(jdbc.queryForObject(
                                    "SELECT capture_state FROM ma_resource WHERE slot_key ="
                                            + " X'7365676d656e743a7374646f75743a31'", String.class)).isEqualTo("QUARANTINED");
        }
    }

    @Test
    void publicReaderDoesNotAdvancePastSegmentWhenStorageReadFails() throws Exception {
        var artifact = preparePublicReader();
        try (var stream = apiReader.open(artifact)) {
            assertThat(stream.readNBytes(2)).isEqualTo("ab".getBytes(StandardCharsets.UTF_8));
            apiFailNextObject = jdbc.queryForObject("SELECT capture_object_key FROM ma_resource"
                    + " WHERE slot_key = X'7365676d656e743a7374646f75743a31'", String.class);
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
            public void validateConfiguration() {
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
        assertThat(jdbc.queryForObject("SELECT capture_state FROM ma_resource"
                + " WHERE slot_key = X'7365676d656e743a7374646f75743a31'", String.class)).isEqualTo("QUARANTINED");
        assertThat(jdbc.queryForObject("SELECT quarantined FROM ma_output_capture"
                + " WHERE publication_id = X'7075622d31'", Boolean.class)).isFalse();
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
            public void validateConfiguration() {
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
            public void validateConfiguration() {
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
            public void validateConfiguration() { }
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
        var deadline = jdbc.queryForObject(
                        "SELECT deadline FROM ma_operation WHERE operation_kind IN"
                                + " ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH') AND"
                                + " operation_id = X'66696e697368'", java.sql.Timestamp.class);
        var created = jdbc.queryForObject(
                        "SELECT gmt_create FROM ma_operation WHERE operation_kind IN ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH') AND operation_id = X'66696e697368'", Long.class);
        assertThat(deadline.getTime() - created).isEqualTo(3000);
        assertThat(jdbc.queryForObject("SELECT capture_state FROM ma_resource"
                + " WHERE slot_key = X'7365676d656e743a7374646f75743a30'", String.class)).isEqualTo("CANDIDATE");
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
                        if (available() == 0) {
                            return -1;
                        }
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
            public void validateConfiguration() { }
        };
        var publisher = new ToolPublicationDataStore(jdbc, manager, store, sessions, bucket,
                Duration.ofMinutes(2), Duration.ofSeconds(30), VERIFICATION_BUDGET);
        JsonNode key = binding.get("sessionKey");
        String digest = ToolPublicationContract.sha256(segment);
        publisher.publishSegment(key, "pub-1", PUBLICATION_TOKEN, "segment", "stdout", 0, segment, digest);
        verificationTime[0] = jdbc.queryForObject("SELECT " + ManagedSchemaTime.SQL_NOW + "", java.sql.Timestamp.class)
                .getTime() / 1000 * 1000;
        // Advance verification time with fixture reads, excluding JDBC latency.
        JdbcTemplate verificationJdbc = new com.alibaba.qwen.code.managedagent.store.ManagedSchemaJdbcTemplate(jdbc.getDataSource()) {
            @Override
            public <T> T queryForObject(String sql, Class<T> type) {
                if (("SELECT " + ManagedSchemaTime.SQL_NOW).equals(sql) && type == java.sql.Timestamp.class) {
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
        var deadline = jdbc.queryForObject(
                        "SELECT deadline FROM ma_operation WHERE operation_kind IN"
                                + " ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH') AND"
                                + " operation_id = X'7365616c'", java.sql.Timestamp.class);
        var created = jdbc.queryForObject(
                        "SELECT gmt_create FROM ma_operation WHERE operation_kind IN ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH') AND operation_id = X'7365616c'", Long.class);
        assertThat(verificationTime[0] - created).isEqualTo(4000);
        assertThat(deadline.getTime() - created).isEqualTo(7000);
        assertThat(data.operationStatus(key, "pub-1", PUBLICATION_TOKEN, "seal").path("state").asText())
                .isEqualTo("SUCCEEDED");
        assertThat(jdbc.queryForObject(
                                "SELECT deadline FROM ma_operation WHERE operation_kind IN"
                                        + " ('OUTPUT_UPLOAD', 'OUTPUT_VERIFY', 'OUTPUT_FINISH') AND"
                                        + " operation_id = X'7365616c'", java.sql.Timestamp.class)).isEqualTo(deadline);
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
        JdbcTemplate metadataJdbc = new com.alibaba.qwen.code.managedagent.store.ManagedSchemaJdbcTemplate(jdbc.getDataSource()) {
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
            public void validateConfiguration() {
            }
        };
        ToolPublicationDataStore data = new ToolPublicationDataStore(metadataJdbc, manager, store, sessions,
                bucket, Duration.ofMinutes(2), Duration.ofSeconds(30), VERIFICATION_BUDGET);
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
                bucket, Duration.ofMinutes(2), Duration.ofSeconds(30), VERIFICATION_BUDGET);
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
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_output_capture", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT token_hash FROM ma_output_capture", String.class))
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
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_output_capture", Integer.class)).isEqualTo(1);
    }

    @Test
    void refusesMissingChangedAndCorruptAuthoritativeEvidence() {
        binding.put("modelCallId", "other-model");
        assertThatThrownBy(this::reserve).hasMessageContaining("Checkpoint execution");
        binding.put("modelCallId", "model-1");
        binding.put("bindingGeneration", "2");
        assertThatThrownBy(this::reserve).hasMessageContaining("Broker execution");
        binding.put("bindingGeneration", "1");
        jdbc.update("UPDATE ma_resource SET inline_bytes = ? WHERE resource_id = X'617267732d31'",
                "{}".getBytes(StandardCharsets.UTF_8));
        assertThatThrownBy(this::reserve).isInstanceOf(RuntimeException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_output_capture", Integer.class)).isZero();
    }

    @Test
    void blockedRecoveryMayFenceButCannotReserveOrRenew() {
        reserve();
        jdbc.update("UPDATE ma_session_head SET recovery_status = 'BLOCKED_EXECUTION'");
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
        byte[] record = jdbc.queryForObject(
                        "SELECT record_bytes FROM ma_session_journal_tx WHERE tenant_id ="
                                + " X'74656e616e742d31' AND session_id = X'73657373696f6e2d31' AND"
                                + " journal_revision = 2",
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
        jdbc.update(
                "UPDATE ma_session_journal_tx SET record_bytes = ?, byte_length = ?, record_digest"
                        + " = ? WHERE tenant_id = X'74656e616e742d31' AND session_id ="
                        + " X'73657373696f6e2d31' AND journal_revision = 2",
                poisonedBytes, poisonedBytes.length,
                ExtensionRecordJournal.sha256(poisonedBytes));
        // A cold head forces both flag settings through the journal scan.
        jdbc.update("UPDATE ma_session_head SET"
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
        byte[] record = jdbc.queryForObject(
                        "SELECT record_bytes FROM ma_session_journal_tx WHERE tenant_id ="
                                + " X'74656e616e742d31' AND session_id = X'73657373696f6e2d31' AND"
                                + " journal_revision = 2",
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
        jdbc.update(
                "UPDATE ma_session_journal_tx SET record_bytes = ?, byte_length = ?, record_digest"
                        + " = ? WHERE tenant_id = X'74656e616e742d31' AND session_id ="
                        + " X'73657373696f6e2d31' AND journal_revision = 2",
                poisonedBytes, poisonedBytes.length,
                ExtensionRecordJournal.sha256(poisonedBytes));
        // A cold head forces both flag settings through the evidence scan.
        jdbc.update("UPDATE ma_session_head SET"
                + " activation_id = NULL, activation_phase = NULL,"
                + " activation_event_epoch = NULL, activation_expires_at = NULL,"
                + " activation_head_revision = NULL");
        assertThatThrownBy(() -> store.apply(request("renew"), WRITER_TOKEN,
                PUBLICATION_TOKEN))
                .hasMessageContaining("Journal event scope conflicts");
        assertThat(jdbc.queryForObject("SELECT activation_id FROM"
                        + " ma_session_head", String.class))
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
        byte[] record = jdbc.queryForObject(
                        "SELECT record_bytes FROM ma_session_journal_tx WHERE tenant_id ="
                                + " X'74656e616e742d31' AND session_id = X'73657373696f6e2d31' AND"
                                + " journal_revision = 2",
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
        jdbc.update(
                "UPDATE ma_session_journal_tx SET record_bytes = ? WHERE tenant_id ="
                        + " X'74656e616e742d31' AND session_id = X'73657373696f6e2d31' AND"
                        + " journal_revision = 2",
                poisoned.toString().getBytes(StandardCharsets.UTF_8));
        // A cold head forces both flag settings through the journal scan.
        jdbc.update("UPDATE ma_session_head SET"
                + " activation_id = NULL, activation_phase = NULL,"
                + " activation_event_epoch = NULL, activation_expires_at = NULL,"
                + " activation_head_revision = NULL");
        assertThatThrownBy(() -> store.verifyDispatch(
                executions.findByExecutionCallId("execution-1"), "pub-1",
                PUBLICATION_TOKEN))
                .hasMessageContaining("Journal event scope conflicts");
        assertThat(jdbc.queryForObject("SELECT activation_id FROM"
                        + " ma_session_head", String.class))
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
        byte[] record = jdbc.queryForObject(
                        "SELECT record_bytes FROM ma_session_journal_tx WHERE tenant_id ="
                                + " X'74656e616e742d31' AND session_id = X'73657373696f6e2d31' AND"
                                + " journal_revision = 3",
                byte[].class);
        String poisoned = new String(record, StandardCharsets.UTF_8)
                .replace("\"sessionId\":\"session-1\"", "\"sessionId\":\"session-9\"");
        // The walk's digest verification still sees a consistent row.
        jdbc.update(
                "UPDATE ma_session_journal_tx SET record_bytes = ?, record_digest = ? WHERE"
                    + " tenant_id = X'74656e616e742d31' AND session_id = X'73657373696f6e2d31' AND"
                    + " journal_revision = 3",
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
        jdbc.update("DELETE FROM ma_session_journal_tx WHERE tenant_id = X'74656e616e742d31'"
                + " AND session_id = X'73657373696f6e2d31' AND journal_revision = 3");
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
        jdbc.update(
                "UPDATE ma_session_journal_tx SET byte_length = 0 WHERE tenant_id ="
                        + " X'74656e616e742d31' AND session_id = X'73657373696f6e2d31' AND"
                        + " journal_revision = 3");
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
        jdbc.update(
                "UPDATE ma_session_journal_tx SET last_sequence = 2 WHERE tenant_id ="
                        + " X'74656e616e742d31' AND session_id = X'73657373696f6e2d31' AND"
                        + " journal_revision = 1");
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
        jdbc.update("UPDATE ma_session_head SET activation_phase = 'released'");
        store.verifyDispatch(executions.findByExecutionCallId("execution-1"), "pub-1", PUBLICATION_TOKEN);
        // The scan still backfills the head, repairing the disagreement.
        assertThat(jdbc.queryForObject("SELECT activation_phase FROM ma_session_head",
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
                + " activation_expires_at FROM ma_session_head");
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
        jdbc.update("UPDATE ma_session_head SET"
                + " activation_id = NULL, activation_phase = NULL,"
                + " activation_event_epoch = NULL,"
                + " activation_expires_at = NULL,"
                + " activation_head_revision = NULL");
        assertThatThrownBy(() -> store.apply(request("renew"), WRITER_TOKEN, PUBLICATION_TOKEN))
                .hasMessageContaining("Activation is not active");
        jdbc.update("UPDATE ma_session_head SET"
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
        assertThat(jdbc.queryForObject("SELECT activation_phase FROM ma_session_head",
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
                + " FROM ma_session_head");
        assertThat(head.get("activation_id")).isNull();
        assertThat(head.get("activation_phase")).isNull();
        assertThat(head.get("activation_event_epoch")).isNull();
        assertThat(head.get("activation_expires_at")).isNull();
        // A conforming activation writes the columns again.
        append("activation.restore", event(4, "activation.changed", activation("active")) + MARKER, 1,
                List.of(resource(binding.get("checkpointRef"), checkpoint)), "checkpoint-1");
        var restored = jdbc.queryForMap("SELECT activation_id, activation_phase,"
                + " activation_event_epoch, activation_expires_at"
                + " FROM ma_session_head");
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
        jdbc.update("UPDATE ma_session_head SET writer_lease_until = 946684800000");
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
        jdbc.update("UPDATE ma_output_capture SET expires_at = 1 WHERE publication_id = X'7075622d31'");
        ObjectNode next = request("reserve");
        next.set("binding", second);
        assertThat(store.apply(next, WRITER_TOKEN, PUBLICATION_TOKEN)
                .path("state").asText()).isEqualTo("OPEN");
        var expired = jdbc.queryForMap("SELECT state, capture_held_bytes, producer_held_bytes,"
                + " admission_held_bytes FROM ma_output_capture WHERE publication_id ="
                            + " X'7075622d31'");
        assertThat(expired.get("state")).isEqualTo("FENCED");
        assertThat(((Number) expired.get("capture_held_bytes")).longValue()).isZero();
        assertThat(((Number) expired.get("producer_held_bytes")).longValue()).isZero();
        assertThat(((Number) expired.get("admission_held_bytes")).longValue()).isZero();
    }

    @Test
    void replacementWriterMayFenceButCannotRenewOriginalPublication() {
        reserve();
        jdbc.update("UPDATE ma_session_head SET writer_lease_until = 946684800000");
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
            var one = pool.submit(() -> {
                start.await();
                return reserve();
            });
            var two = pool.submit(() -> {
                start.await();
                return reserve();
            });
            start.countDown();
            assertThat(one.get()).isEqualTo(two.get());
        }
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_output_capture", Integer.class)).isEqualTo(1);
        jdbc.update("DELETE FROM ma_output_capture");
        store = newStore(ALLOCATION - 1, 1);
        assertRefused(this::reserve, true, "tenant_bytes");
        store = newStore(ALLOCATION, 1);
        assertThat(reserve().path("captureBytes").asLong()).isEqualTo(CAPTURE_BYTES);
    }

    @Test
    void refusesEachExhaustedLimitWithItsOwnCode() {
        ObjectNode second = addSecondExecution();
        store = new ToolPublicationStore(jdbc, manager, sessions, executions, bindings,
                new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, 10 * ALLOCATION, ALLOCATION - 1, 10));
        assertRefused(this::reserve, true, "tenant_bytes");
        store = new ToolPublicationStore(jdbc, manager, sessions, executions, bindings,
                new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, ALLOCATION - 1, 10 * ALLOCATION, 10));
        assertRefused(this::reserve, true, "session_bytes");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_output_capture", Integer.class)).isZero();
        store = new ToolPublicationStore(jdbc, manager, sessions, executions, bindings,
                new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, 10 * ALLOCATION, 10 * ALLOCATION, 1));
        reserve();
        ObjectNode secondRequest = request("reserve");
        secondRequest.set("binding", second);
        assertRefused(() -> store.apply(secondRequest, WRITER_TOKEN, PUBLICATION_TOKEN), false, "active_captures");
        // A fenced capture stops counting, so the refused reservation now fits.
        store.apply(request("fence"), WRITER_TOKEN, null);
        assertThat(store.apply(secondRequest, WRITER_TOKEN, PUBLICATION_TOKEN).path("state").asText())
                .isEqualTo("OPEN");
    }

    @Test
    void namesTheByteLimitWhenTheCaptureSlotsAreFullToo() {
        ObjectNode second = addSecondExecution();
        store = new ToolPublicationStore(jdbc, manager, sessions, executions, bindings,
                new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, ALLOCATION, 10 * ALLOCATION, 1));
        reserve();
        ObjectNode secondRequest = request("reserve");
        secondRequest.set("binding", second);
        // The Session's bytes and its one slot are both taken by an open
        // capture: the byte limit is named, and it is retryable, because the
        // capture gives both back when it ends.
        assertRefused(() -> store.apply(secondRequest, WRITER_TOKEN, PUBLICATION_TOKEN), false, "session_bytes");
        store.apply(request("fence"), WRITER_TOKEN, null);
        assertThat(store.apply(secondRequest, WRITER_TOKEN, PUBLICATION_TOKEN).path("state").asText())
                .isEqualTo("OPEN");
    }

    @Test
    void refusesWithoutRetryOnlyWhenUsedBytesAloneFillTheLimit() {
        ObjectNode second = addSecondExecution();
        store = new ToolPublicationStore(jdbc, manager, sessions, executions, bindings,
                new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, ALLOCATION, 10 * ALLOCATION, 10));
        reserve();
        ObjectNode secondRequest = request("reserve");
        secondRequest.set("binding", second);
        // One byte of the open capture is used: only that byte outlives it.
        jdbc.update("UPDATE ma_output_capture SET capture_used_bytes = 1");
        store = new ToolPublicationStore(jdbc, manager, sessions, executions, bindings,
                new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, ALLOCATION + 1, 10 * ALLOCATION, 10));
        assertRefused(() -> store.apply(secondRequest, WRITER_TOKEN, PUBLICATION_TOKEN), false, "session_bytes");
        store = new ToolPublicationStore(jdbc, manager, sessions, executions, bindings,
                new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, ALLOCATION, 10 * ALLOCATION, 10));
        assertRefused(() -> store.apply(secondRequest, WRITER_TOKEN, PUBLICATION_TOKEN), true, "session_bytes");
        // A finished capture keeps everything it used until its Session is
        // collected: nothing about it frees on its own.
        jdbc.update("UPDATE ma_output_capture SET state = 'FENCED', expires_at = NULL,"
                + " capture_used_bytes = capture_held_bytes, producer_used_bytes = producer_held_bytes,"
                + " admission_used_bytes = admission_held_bytes");
        store = new ToolPublicationStore(jdbc, manager, sessions, executions, bindings,
                new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, 2 * ALLOCATION - 1, 10 * ALLOCATION, 10));
        assertRefused(() -> store.apply(secondRequest, WRITER_TOKEN, PUBLICATION_TOKEN), true, "session_bytes");
    }

    @Test
    void anotherSessionsOpenCaptureDoesNotFreeThisSessionsRetainedBytes() {
        ObjectNode second = addSecondExecution();
        store = new ToolPublicationStore(jdbc, manager, sessions, executions, bindings,
                new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, 10 * ALLOCATION, 10 * ALLOCATION, 10));
        reserve();
        ObjectNode secondRequest = request("reserve");
        secondRequest.set("binding", second);
        store.apply(secondRequest, WRITER_TOKEN, PUBLICATION_TOKEN);
        // The first capture finished here with everything used; the second
        // is still open but now belongs to another Session of the tenant.
        jdbc.update("UPDATE ma_output_capture SET state = 'FENCED', expires_at = NULL,"
                + " capture_used_bytes = capture_held_bytes, producer_used_bytes = producer_held_bytes,"
                + " admission_used_bytes = admission_held_bytes WHERE publication_id = ?",
                "pub-1".getBytes(StandardCharsets.UTF_8));
        jdbc.update("UPDATE ma_output_capture SET scope_key = ? WHERE publication_id = ?", "f".repeat(64),
                "pub-2".getBytes(StandardCharsets.UTF_8));
        // The tenant fails first, and its open capture could make room
        // there; the Session's used bytes still leave none.
        store = new ToolPublicationStore(jdbc, manager, sessions, executions, bindings,
                new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, 2 * ALLOCATION - 1, 3 * ALLOCATION - 1, 10));
        assertRefused(() -> store.apply(secondRequest, WRITER_TOKEN, PUBLICATION_TOKEN), true, "session_bytes");
    }

    @Test
    void anotherSessionsUsedBytesDoNotFillThisSessionsLimit() {
        ObjectNode second = addSecondExecution();
        store = new ToolPublicationStore(jdbc, manager, sessions, executions, bindings,
                new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, 10 * ALLOCATION, 10 * ALLOCATION, 10));
        ObjectNode firstRequest = request("reserve");
        reserve();
        ObjectNode secondRequest = request("reserve");
        secondRequest.set("binding", second);
        store.apply(secondRequest, WRITER_TOKEN, PUBLICATION_TOKEN);
        // The first capture finished with everything used, in another Session
        // of the tenant; this Session holds only the second, still open.
        jdbc.update("UPDATE ma_output_capture SET state = 'FENCED', expires_at = NULL, scope_key = ?,"
                + " capture_used_bytes = capture_held_bytes, producer_used_bytes = producer_held_bytes,"
                + " admission_used_bytes = admission_held_bytes WHERE publication_id = ?", "f".repeat(64),
                "pub-1".getBytes(StandardCharsets.UTF_8));
        store = new ToolPublicationStore(jdbc, manager, sessions, executions, bindings,
                new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, 2 * ALLOCATION - 1, 10 * ALLOCATION, 10));
        assertRefused(() -> store.apply(firstRequest, WRITER_TOKEN, PUBLICATION_TOKEN), false, "session_bytes");
    }

    @Test
    void anUnreferencedAdmissionDoesNotCountAsRetained() {
        ObjectNode second = addSecondExecution();
        store = new ToolPublicationStore(jdbc, manager, sessions, executions, bindings,
                new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, 10 * ALLOCATION, 10 * ALLOCATION, 10));
        reserve();
        ObjectNode secondRequest = request("reserve");
        secondRequest.set("binding", second);
        // Finished and fenced with its output fully used, but not yet
        // referenced: the receipt still gives back the admission it did not use.
        jdbc.update("UPDATE ma_output_capture SET state = 'FENCED', expires_at = NULL, producer_phase = 'FINISHED',"
                + " capture_used_bytes = capture_held_bytes, producer_used_bytes = producer_held_bytes,"
                + " admission_used_bytes = 100");
        store = new ToolPublicationStore(jdbc, manager, sessions, executions, bindings,
                new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, 2 * ALLOCATION - 1, 10 * ALLOCATION, 10));
        assertRefused(() -> store.apply(secondRequest, WRITER_TOKEN, PUBLICATION_TOKEN), false, "session_bytes");
        jdbc.update("UPDATE ma_output_capture SET producer_phase = 'REFERENCED',"
                + " admission_held_bytes = admission_used_bytes");
        assertThat(store.apply(secondRequest, WRITER_TOKEN, PUBLICATION_TOKEN).path("state").asText())
                .isEqualTo("OPEN");
    }

    @Test
    void logsEachRefusalWithWhatItWeighed() {
        Logger log = (Logger) LoggerFactory.getLogger(ToolPublicationStore.class);
        ListAppender<ILoggingEvent> logged = new ListAppender<>();
        logged.start();
        log.addAppender(logged);
        try {
            ObjectNode second = addSecondExecution();
            store = new ToolPublicationStore(jdbc, manager, sessions, executions, bindings,
                    new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, 10 * ALLOCATION, 10 * ALLOCATION, 10));
            reserve();
            Map<String, Object> keys = jdbc.queryForMap("SELECT tenant_key, scope_key FROM ma_output_capture");
            // Distinct numbers: the capture holds 10 bytes less than an
            // allocation, has used 3, and now belongs to another Session.
            jdbc.update("UPDATE ma_output_capture SET capture_held_bytes = capture_held_bytes - 10,"
                    + " capture_used_bytes = 3, scope_key = ?", "f".repeat(64));
            ObjectNode secondRequest = request("reserve");
            secondRequest.set("binding", second);
            store = new ToolPublicationStore(jdbc, manager, sessions, executions, bindings,
                    new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, 10 * ALLOCATION, ALLOCATION + 5, 10));
            assertRefused(() -> store.apply(secondRequest, WRITER_TOKEN, PUBLICATION_TOKEN), false, "tenant_bytes");
            store = new ToolPublicationStore(jdbc, manager, sessions, executions, bindings,
                    new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, 10 * ALLOCATION, ALLOCATION + 2, 10));
            assertRefused(() -> store.apply(secondRequest, WRITER_TOKEN, PUBLICATION_TOKEN), true, "tenant_bytes");
            store = new ToolPublicationStore(jdbc, manager, sessions, executions, bindings,
                    new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, 10 * ALLOCATION, 10 * ALLOCATION, 1));
            assertRefused(() -> store.apply(secondRequest, WRITER_TOKEN, PUBLICATION_TOKEN), false, "active_captures");
            String identity = " tenant=" + keys.get("tenant_key") + " scope=" + keys.get("scope_key");
            String held = " held=" + (ALLOCATION - 10) + " used=3 requested=" + ALLOCATION;
            assertThat(logged.list).extracting(ILoggingEvent::getFormattedMessage).containsExactly(
                    "Tool publication reservation refused limit=tenant_bytes retained=false" + identity + held
                            + " allowed=" + (ALLOCATION + 5) + " admits=1",
                    "Tool publication reservation refused limit=tenant_bytes retained=true" + identity + held
                            + " allowed=" + (ALLOCATION + 2) + " admits=1",
                    "Tool publication reservation refused limit=active_captures retained=false" + identity
                            + " held=1 used=0 requested=1 allowed=1 admits=1");
            assertThat(logged.list).extracting(ILoggingEvent::getLevel).containsOnly(Level.WARN);
        } finally {
            log.detachAppender(logged);
        }
    }

    @Test
    void eachByteLimitChargesItsOwnSum() {
        ObjectNode second = addSecondExecution();
        store = new ToolPublicationStore(jdbc, manager, sessions, executions, bindings,
                new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, 10 * ALLOCATION, 10 * ALLOCATION, 10));
        reserve();
        // Hand the first capture to another Session of the same tenant: the
        // tenant still carries its bytes, this Session no longer does.
        jdbc.update("UPDATE ma_output_capture SET scope_key = ?", "f".repeat(64));
        ObjectNode secondRequest = request("reserve");
        secondRequest.set("binding", second);
        store = new ToolPublicationStore(jdbc, manager, sessions, executions, bindings,
                new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, 10 * ALLOCATION, ALLOCATION, 10));
        assertRefused(() -> store.apply(secondRequest, WRITER_TOKEN, PUBLICATION_TOKEN), false, "tenant_bytes");
        store = new ToolPublicationStore(jdbc, manager, sessions, executions, bindings,
                new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, ALLOCATION, 10 * ALLOCATION, 10));
        assertThat(store.apply(secondRequest, WRITER_TOKEN, PUBLICATION_TOKEN).path("state").asText())
                .isEqualTo("OPEN");
    }

    private static void assertRefused(ThrowingCallable reservation, boolean retained, String limit) {
        assertThatThrownBy(reservation).isInstanceOfSatisfying(ApiException.class,
                error -> assertRefusal(error, retained, limit));
    }

    // A refusal that used bytes alone cause is a 409; any other is a 429.
    private static void assertRefusal(ApiException error, boolean retained, String limit) {
        assertThat(error.getStatus()).isEqualTo(retained ? HttpStatus.CONFLICT : HttpStatus.TOO_MANY_REQUESTS);
        assertThat(error.getCode()).isEqualTo(retained ? "managed_tool_publication_retention_exhausted"
                : "managed_tool_publication_capacity_exhausted");
        assertThat(error.getMessage()).isEqualTo("Tool publication reservation refused at the " + limit + " limit");
        assertThat(error.getDetails()).containsEntry("limit", limit).containsOnlyKeys("limit", "admits");
    }

    @Test
    void saysHowManyReservationsTheSessionCouldEverHoldAtOnce() {
        ObjectNode second = addSecondExecution();
        store = new ToolPublicationStore(jdbc, manager, sessions, executions, bindings,
                new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, 10 * ALLOCATION, 10 * ALLOCATION, 10));
        reserve();
        // Three open captures of this Session hold three allocations.
        copyCapture("pub-1", "pub-3");
        copyCapture("pub-1", "pub-4");
        ObjectNode secondRequest = request("reserve");
        secondRequest.set("binding", second);
        // Open captures end, so what they hold does not count against a
        // batch: each limit admits as many as it could hold (#14518).
        assertAdmits(secondRequest, new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, 10 * ALLOCATION,
                4 * ALLOCATION - 1, 10), "tenant_bytes", 3);
        assertAdmits(secondRequest, new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, 4 * ALLOCATION - 1,
                10 * ALLOCATION, 10), "session_bytes", 3);
        assertAdmits(secondRequest, new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, 10 * ALLOCATION,
                10 * ALLOCATION, 3), "active_captures", 3);
        // The tightest limit decides, whichever one refused.
        assertAdmits(secondRequest, new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, 5 * ALLOCATION / 2,
                39 * ALLOCATION / 10, 10), "tenant_bytes", 2);
        assertAdmits(secondRequest, new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, 10 * ALLOCATION,
                39 * ALLOCATION / 10, 2), "tenant_bytes", 2);
        // This Session's used bytes stay charged while it lives, so they
        // come off what it could hold.
        jdbc.update("UPDATE ma_output_capture SET capture_used_bytes = capture_held_bytes,"
                + " producer_used_bytes = producer_held_bytes, admission_used_bytes = admission_held_bytes"
                + " WHERE publication_id = ?", "pub-1".getBytes(StandardCharsets.UTF_8));
        assertAdmits(secondRequest, new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, 4 * ALLOCATION - 1,
                10 * ALLOCATION, 10), "session_bytes", 2);
        // A refusal that used bytes alone cause says it too.
        store = new ToolPublicationStore(jdbc, manager, sessions, executions, bindings,
                new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, 2 * ALLOCATION - 1, 10 * ALLOCATION, 10));
        assertThatThrownBy(() -> store.apply(secondRequest, WRITER_TOKEN, PUBLICATION_TOKEN))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertRefusal(error, true, "session_bytes");
                    assertThat(error.getDetails()).containsEntry("admits", 0L);
                });
        // Used bytes past the limit still leave none, not fewer than none.
        jdbc.update("UPDATE ma_output_capture SET capture_used_bytes = capture_held_bytes,"
                + " producer_used_bytes = producer_held_bytes, admission_used_bytes = admission_held_bytes"
                + " WHERE publication_id = ?", "pub-3".getBytes(StandardCharsets.UTF_8));
        store = new ToolPublicationStore(jdbc, manager, sessions, executions, bindings,
                new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, ALLOCATION, 10 * ALLOCATION, 10));
        assertThatThrownBy(() -> store.apply(secondRequest, WRITER_TOKEN, PUBLICATION_TOKEN))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertRefusal(error, true, "session_bytes");
                    assertThat(error.getDetails()).containsEntry("admits", 0L);
                });
        // Another Session's used bytes free when it retires, so they do not.
        jdbc.update("UPDATE ma_output_capture SET scope_key = ? WHERE publication_id = ?", "f".repeat(64),
                "pub-1".getBytes(StandardCharsets.UTF_8));
        assertAdmits(secondRequest, new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, 10 * ALLOCATION,
                4 * ALLOCATION - 1, 10), "tenant_bytes", 2);
    }

    @Test
    void countsOnlyTheSessionsOwnRetainedOutputWhenTheCaptureSlotsRefuse() {
        ObjectNode second = addSecondExecution();
        store = new ToolPublicationStore(jdbc, manager, sessions, executions, bindings,
                new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2, 10 * ALLOCATION, 10 * ALLOCATION, 10));
        reserve();
        copyCapture("pub-1", "pub-3");
        copyCapture("pub-1", "pub-4");
        copyCapture("pub-1", "pub-5");
        // This Session keeps one finished, fully used capture and one open,
        // unused one; another Session has two open captures, one fully used.
        // The three open captures take every slot.
        jdbc.update("UPDATE ma_output_capture SET state = 'FENCED', expires_at = NULL,"
                + " capture_used_bytes = capture_held_bytes, producer_used_bytes = producer_held_bytes,"
                + " admission_used_bytes = admission_held_bytes WHERE publication_id = ?",
                "pub-1".getBytes(StandardCharsets.UTF_8));
        jdbc.update("UPDATE ma_output_capture SET scope_key = ? WHERE publication_id IN (?, ?)", "f".repeat(64),
                "pub-3".getBytes(StandardCharsets.UTF_8), "pub-4".getBytes(StandardCharsets.UTF_8));
        jdbc.update("UPDATE ma_output_capture SET capture_used_bytes = capture_held_bytes,"
                + " producer_used_bytes = producer_held_bytes, admission_used_bytes = admission_held_bytes"
                + " WHERE publication_id = ?", "pub-3".getBytes(StandardCharsets.UTF_8));
        ObjectNode secondRequest = request("reserve");
        secondRequest.set("binding", second);
        ToolPublicationStore.Capacity capacity = new ToolPublicationStore.Capacity(CAPTURE_BYTES * 2,
                3 * ALLOCATION, 10 * ALLOCATION, 3);
        // Only this Session's used bytes come off: not what its open capture
        // holds, nor what the other Session used.
        assertAdmits(secondRequest, capacity, "active_captures", 2);
        // A pending finish can still give its terminal back, so its used
        // bytes do not come off either.
        jdbc.update("UPDATE ma_output_capture SET producer_phase = 'FINISHING',"
                + " capture_used_bytes = capture_held_bytes, producer_used_bytes = producer_held_bytes,"
                + " admission_used_bytes = admission_held_bytes WHERE publication_id = ?",
                "pub-5".getBytes(StandardCharsets.UTF_8));
        assertAdmits(secondRequest, capacity, "active_captures", 2);
    }

    private void assertAdmits(ObjectNode request, ToolPublicationStore.Capacity capacity, String limit,
            long admits) {
        store = new ToolPublicationStore(jdbc, manager, sessions, executions, bindings, capacity);
        assertThatThrownBy(() -> store.apply(request, WRITER_TOKEN, PUBLICATION_TOKEN)).isInstanceOfSatisfying(
                ApiException.class, error -> {
                    assertRefusal(error, false, limit);
                    assertThat(error.getDetails()).containsEntry("admits", admits);
                });
    }

    // Another open capture of the same Session, as a reservation leaves it.
    private void copyCapture(String from, String to) {
        jdbc.update("INSERT INTO ma_output_capture (scope_key, tenant_key, tenant_id, workspace_id, session_id,"
                + " publication_id, execution_key, capture_id, binding_json, binding_digest, token_hash, state,"
                + " expires_at, capture_bytes, producer_bytes, admission_bytes, capture_held_bytes,"
                + " producer_held_bytes, admission_held_bytes, write_evidence) SELECT scope_key, tenant_key,"
                + " tenant_id, workspace_id, session_id, ?, ?, ?, binding_json, binding_digest, token_hash, state,"
                + " expires_at, capture_bytes, producer_bytes, admission_bytes, capture_held_bytes,"
                + " producer_held_bytes, admission_held_bytes, write_evidence FROM ma_output_capture"
                + " WHERE publication_id = ?", to.getBytes(StandardCharsets.UTF_8), digest(to),
                to.getBytes(StandardCharsets.UTF_8), from.getBytes(StandardCharsets.UTF_8));
    }

    @Test
    void refusesFirstReservationAfterDispatchHasBeenClaimed() {
        var execution = executions.claimDispatch("execution-1", "dispatcher", java.time.Duration.ofMinutes(1));
        assertThat(execution).isNotNull();
        assertThatThrownBy(this::reserve).hasMessageContaining("before dispatch");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_output_capture", Integer.class)).isZero();
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
        jdbc.update("UPDATE ma_session_head SET writer_lease_until = 946684800000");
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
        assertThat(outcomes).filteredOn(ApiException.class::isInstance).singleElement()
                .satisfies(error -> assertRefusal((ApiException) error, false, "tenant_bytes"));
        String winner = jdbc.queryForObject("SELECT publication_id FROM ma_output_capture", String.class);
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
        } catch (ApiException error) {
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
                    public void validateConfiguration() {}
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
        assertThat(fixture.jdbc().queryForObject(
                                        "SELECT write_evidence AND accepted_complete FROM"
                                                + " ma_output_capture",
                Boolean.class)).isTrue();
        fixture.jdbc().update(
                        "UPDATE ma_session SET retirement_operation_id = X'64656c6574652d31',"
                                + " retirement_generation = 1, retired_at = 1, recovery_protected ="
                                + " FALSE WHERE tenant_id = X'74656e616e742d31' AND session_id ="
                                + " X'73657373696f6e2d31'");
        fixture.jdbc().update("UPDATE ma_output_capture SET retention_state = 'RETIRING'");
        var retention = new com.alibaba.qwen.code.managedagent.store.ToolPublicationRetentionStore(fixture.jdbc(), fixture.manager());
        assertThat(retention.observe(Duration.ZERO)).singleElement()
                .extracting(com.alibaba.qwen.code.managedagent.store.ToolPublicationRetentionStore.Candidate::blocker).isEqualTo("resource_referenced");
    }

    @Test
    void settledProjectionDoesNotParseObsoleteSourceJson() {
        var fixture = apiFixture();
        fixture.jdbc()
                .update(
                        "UPDATE ma_operation SET state = 'PENDING', available_at = 0 WHERE"
                            + " operation_kind = 'TOOL_RESULT_PROJECTION'");
        var claim = fixture.results().claim().orElseThrow();
        fixture.jdbc()
                .update(
                        "UPDATE ma_operation SET state = 'SUPPRESSED', claim_until = NULL,"
                            + " request_json = '{}' WHERE operation_kind ="
                            + " 'TOOL_RESULT_PROJECTION'");
        var before =
                fixture.jdbc()
                        .queryForMap(
                                "SELECT " + ManagedSchemaProjection.OPERATION.columns() + " FROM ma_operation WHERE operation_kind = 'TOOL_RESULT_PROJECTION'");
        var artifacts = fixture.jdbc().queryForList("SELECT " + ManagedSchemaProjection.ARTIFACT.columns() + " FROM ma_artifact");
        var events = fixture.jdbc().queryForList("SELECT " + ManagedSchemaProjection.PUBLIC_EVENT.columns() + " FROM ma_public_event");
        var projection =
                new ManagedToolResultStore.Projection(
                        JSON.createObjectNode(),
                        "pub-1",
                        JSON.createObjectNode(),
                        JSON.createObjectNode(),
                        List.of(),
                        fixture.policy().version());
        assertThat(fixture.results().complete(claim, projection, fixture.policy().version()))
                .isFalse();
        assertThat(
                        fixture.jdbc()
                                .queryForMap(
                                        "SELECT " + ManagedSchemaProjection.OPERATION.columns() + " FROM ma_operation WHERE operation_kind = 'TOOL_RESULT_PROJECTION'"))
                .usingRecursiveComparison()
                .isEqualTo(before);
        assertThat(fixture.jdbc().queryForList("SELECT " + ManagedSchemaProjection.ARTIFACT.columns() + " FROM ma_artifact"))
                .usingRecursiveComparison()
                .isEqualTo(artifacts);
        assertThat(fixture.jdbc().queryForList("SELECT " + ManagedSchemaProjection.PUBLIC_EVENT.columns() + " FROM ma_public_event"))
                .usingRecursiveComparison()
                .isEqualTo(events);
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void projectionUsesPersistedOwnerAndRejectsForeignActiveClaims(boolean privateSession) {
        var fixture = apiFixture();
        fixture.jdbc()
                .update(
                        "UPDATE ma_operation SET state = 'PENDING', available_at = 0 WHERE"
                            + " operation_kind = 'TOOL_RESULT_PROJECTION'");
        var claim = fixture.results().claim().orElseThrow();
        var source = claim.source();
        var foreign =
                new ManagedToolResultStore.Claim(
                        new ManagedToolResultStore.Source(
                                source.id(),
                                "foreign",
                                source.workspaceId(),
                                source.sessionId(),
                                source.executionCallId(),
                                source.journalRevision(),
                                source.receiptSequence(),
                                source.outcomeRef(),
                                source.resultRef(),
                                source.resources(),
                                source.sourceDigest()),
                        claim.generation());
        if (privateSession) {
            fixture.jdbc().update("UPDATE ma_session SET tool_profile = 'csi-files-retirement/1'");
        }
        var before =
                fixture.jdbc()
                        .queryForMap(
                                "SELECT " + ManagedSchemaProjection.OPERATION.columns() + " FROM ma_operation WHERE operation_kind = 'TOOL_RESULT_PROJECTION'");
        var artifacts = fixture.jdbc().queryForList("SELECT " + ManagedSchemaProjection.ARTIFACT.columns() + " FROM ma_artifact");
        var events = fixture.jdbc().queryForList("SELECT " + ManagedSchemaProjection.PUBLIC_EVENT.columns() + " FROM ma_public_event");
        var projection =
                new ManagedToolResultStore.Projection(
                        JSON.createObjectNode(),
                        "pub-1",
                        JSON.createObjectNode(),
                        JSON.createObjectNode(),
                        List.of(),
                        fixture.policy().version());
        if (privateSession) {
            assertThat(fixture.results().complete(foreign, projection, fixture.policy().version()))
                    .isFalse();
        } else {
            assertThatThrownBy(
                            () ->
                                    fixture.results()
                                            .complete(
                                                    foreign,
                                                    projection,
                                                    fixture.policy().version()))
                    .hasMessage("Claimed projection source conflicts");
        }
        assertThat(
                        fixture.jdbc()
                                .queryForMap(
                                        "SELECT " + ManagedSchemaProjection.OPERATION.columns() + " FROM ma_operation WHERE operation_kind = 'TOOL_RESULT_PROJECTION'"))
                .usingRecursiveComparison()
                .isEqualTo(before);
        assertThat(fixture.jdbc().queryForList("SELECT " + ManagedSchemaProjection.ARTIFACT.columns() + " FROM ma_artifact"))
                .usingRecursiveComparison()
                .isEqualTo(artifacts);
        assertThat(fixture.jdbc().queryForList("SELECT " + ManagedSchemaProjection.PUBLIC_EVENT.columns() + " FROM ma_public_event"))
                .usingRecursiveComparison()
                .isEqualTo(events);
    }

    @Test
    void retiredRootRejectsProjectionWhilePublicSessionIsStillReadable() {
        var fixture = apiFixture();
        var artifact = fixture.results().listArtifacts("tenant-1", "session-1", null, null, null, 100)
                .artifacts().getFirst();
        releaseArtifacts(fixture.jdbc(), fixture.manager());
        fixture.jdbc().update("DELETE FROM ma_public_event");
        fixture.jdbc().update(
                        "UPDATE ma_operation SET state = 'PENDING', available_at = 0 WHERE"
                                + " operation_kind = 'TOOL_RESULT_PROJECTION'");
        var claim = fixture.results().claim().orElseThrow();
        fixture.jdbc().update(
                        "UPDATE ma_session SET retirement_operation_id = X'64656c6574652d31',"
                                + " retirement_generation = 1, retired_at = 1, recovery_protected ="
                                + " FALSE WHERE tenant_id = X'74656e616e742d31' AND session_id ="
                                + " X'73657373696f6e2d31'");
        var projection = new ManagedToolResultStore.Projection(JSON.createObjectNode(), "pub-1",
                artifact.binding(), artifact.manifestRef(), List.of(artifact), fixture.policy().version());
        assertThat(fixture.results().complete(claim, projection, fixture.policy().version())).isFalse();
        assertThat(fixture.jdbc().queryForMap(
                                        "SELECT state, claim_until, failure_code FROM ma_operation"
                                            + " WHERE operation_kind = 'TOOL_RESULT_PROJECTION'"))
                .containsEntry("state", "SUPPRESSED").containsEntry("claim_until", null)
                .containsEntry("failure_code", "session_retired");
        assertThat(fixture.jdbc().queryForObject("SELECT COUNT(*) FROM ma_artifact", Long.class)).isZero();
        assertThat(fixture.jdbc().queryForObject("SELECT COUNT(*) FROM ma_public_event", Long.class)).isZero();
        assertThat(fixture.sessions().requireSession("tenant-1", "session-1").status()).isNotEqualTo("DELETED");
    }

    @Test
    void skipsAutomaticPreviewWhenItsSegmentVerificationExceedsOneMiB() throws Exception {
        var fixture = largeApiFixture(2 * 1024 * 1024 + 2);
        var row = fixture.jdbc().queryForMap(
                                "SELECT state, result_json FROM ma_operation WHERE operation_kind ="
                                        + " 'TOOL_RESULT_PROJECTION'");
        assertThat(row.get("state")).isEqualTo("READY");
        var descriptor = JSON.readTree((String) row.get("result_json"));
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
        releaseArtifacts(fixture.jdbc(), fixture.manager());
        fixture.jdbc().update(
                        "UPDATE ma_operation SET state='PENDING', available_at=0 WHERE"
                                + " operation_kind = 'TOOL_RESULT_PROJECTION'");
        new ManagedToolResultProjector(fixture.results(), fixture.jdbc(), provider,
                new ManagedArtifactReader(provider), fixture.policy(), fixture.properties())
                .project(fixture.results().claim().orElseThrow());
        assertThat(fixture.jdbc().queryForObject(
                                        "SELECT state FROM ma_operation WHERE operation_kind ="
                                                + " 'TOOL_RESULT_PROJECTION'", String.class))
                .isEqualTo("READY");
        assertThat(org.mockito.Mockito.mockingDetails(data).getInvocations().stream()
                .filter(call -> call.getMethod().getName().equals("openReferencedStream")).count()).isEqualTo(2);
    }

    @ParameterizedTest
    @ValueSource(longs = {-28_800_000, 28_800_000})
    void artifactCreationTimeUsesPublicEpochDespiteJdbcWallClockOffset(long offset) throws Exception {
        var fixture = apiFixture();
        releaseArtifacts(fixture.jdbc(), fixture.manager());
        fixture.jdbc().update("DELETE FROM ma_public_event");
        fixture.jdbc().update(
                        "UPDATE ma_operation SET state='PENDING', available_at=0 WHERE"
                                + " operation_kind = 'TOOL_RESULT_PROJECTION'");
        JdbcTemplate projectionJdbc = new com.alibaba.qwen.code.managedagent.store.ManagedSchemaJdbcTemplate(fixture.jdbc().getDataSource()) {
            @Override
            public <T> T queryForObject(String sql, Class<T> type) {
                if (("SELECT " + ManagedSchemaTime.SQL_NOW).equals(sql) && type == java.sql.Timestamp.class) {
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
        var row = fixture.jdbc().queryForMap(
                                "SELECT state, result_json FROM ma_operation WHERE operation_kind ="
                                        + " 'TOOL_RESULT_PROJECTION'");
        assertThat(row.get("state")).isEqualTo("READY");
        var descriptor = JSON.readTree((String) row.get("result_json"));
        long eventCreatedAt = fixture.jdbc().queryForObject("SELECT MAX(gmt_create) FROM ma_public_event", Long.class);
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
        releaseArtifacts(fixture.jdbc(), fixture.manager());
        fixture.jdbc().update("DELETE FROM ma_public_event");
        fixture.jdbc().update(
                        "UPDATE ma_operation SET state='PENDING', available_at=0 WHERE"
                                + " operation_kind = 'TOOL_RESULT_PROJECTION'");
        var policy = org.mockito.Mockito.spy(fixture.policy());
        var calls = new java.util.concurrent.atomic.AtomicInteger();
        org.mockito.Mockito.doAnswer(call -> {
            if (calls.incrementAndGet() == 2) {
                fixture.jdbc().update("UPDATE ma_output_capture SET quarantined=TRUE");
            }
            return fixture.policy().version();
        }).when(policy).version();
        var beans = new org.springframework.beans.factory.support.StaticListableBeanFactory();
        beans.addBean("publication", fixture.publications());
        var provider = beans.getBeanProvider(ToolPublicationDataStore.class);
        new ManagedToolResultProjector(fixture.results(), fixture.jdbc(), provider, fixture.reader(), policy,
                fixture.properties()).project(fixture.results().claim().orElseThrow());
        assertThat(fixture.jdbc().queryForMap(
                                        "SELECT state, failure_code FROM ma_operation WHERE"
                                                + " operation_kind = 'TOOL_RESULT_PROJECTION'"))
                .containsEntry("state", "RETRYABLE").containsEntry("failure_code", "tool_result_source_unavailable");
        assertThat(fixture.jdbc().queryForObject("SELECT COUNT(*) FROM ma_artifact", Long.class)).isZero();
        assertThat(fixture.jdbc().queryForObject("SELECT COUNT(*) FROM ma_public_event", Long.class)).isZero();
        fixture.jdbc().update(
                        "UPDATE ma_operation SET available_at=0 WHERE operation_kind ="
                                + " 'TOOL_RESULT_PROJECTION'");
        new ManagedToolResultProjector(fixture.results(), fixture.jdbc(), provider, fixture.reader(), fixture.policy(),
                fixture.properties()).project(fixture.results().claim().orElseThrow());
        var row = fixture.jdbc().queryForMap(
                                "SELECT state, result_json FROM ma_operation WHERE operation_kind ="
                                        + " 'TOOL_RESULT_PROJECTION'");
        assertThat(row.get("state")).isEqualTo("READY");
        var descriptor = JSON.readTree((String) row.get("result_json"));
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
        assertThat(jdbc.queryForMap(
                                "SELECT state, failure_code FROM ma_operation WHERE operation_kind"
                                        + " = 'TOOL_RESULT_PROJECTION'"))
                .containsEntry("state", "RETRYABLE").containsEntry("failure_code", "publication_policy_changed");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_artifact", Long.class)).isZero();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_public_event", Long.class)).isZero();
    }

    @Test
    void missingPublicationIsAnUnsupportedProducer() {
        ordinaryNotStartedReceipt();
        insertPublicSession();
        jdbc.update("DELETE FROM ma_output_capture");
        var provider = publicationProvider(null);
        new ManagedToolResultProjector(publicResults, jdbc, provider, new ManagedArtifactReader(provider),
                publicationPolicy(), projectionProperties).project(publicResults.claim().orElseThrow());
        assertThat(jdbc.queryForMap(
                                "SELECT state, failure_code FROM ma_operation WHERE operation_kind"
                                        + " = 'TOOL_RESULT_PROJECTION'"))
                .containsEntry("state", "UNSUPPORTED").containsEntry("failure_code", "unsupported_receipt_producer");
    }

    @Test
    void oneBackfillPageCapturesTwoJournalTransactions() {
        twoHistoricalReceipts();
        publicResults.backfillOnePage();
        assertThat(jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_operation WHERE operation_kind ="
                                        + " 'TOOL_RESULT_PROJECTION'", Long.class)).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT o3_backfill_pending FROM ma_session_head", Boolean.class)).isFalse();
    }

    @Test
    void invalidLaterBackfillRecordPreservesEarlierCheckpoint() {
        twoHistoricalReceipts();
        long last = jdbc.queryForObject("SELECT MAX(journal_revision) FROM ma_session_journal_tx", Long.class);
        jdbc.update("UPDATE ma_session_journal_tx SET record_digest=? WHERE journal_revision=?", "0".repeat(64), last);
        assertThatThrownBy(publicResults::backfillOnePage).hasMessageContaining("Backfill journal digest changed");
        assertThat(jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_operation WHERE operation_kind ="
                                        + " 'TOOL_RESULT_PROJECTION'", Long.class)).isEqualTo(1);
        assertThat(jdbc.queryForMap(
                                "SELECT o3_backfill_revision, o3_backfill_error FROM"
                                        + " ma_session_head"))
                .containsEntry("o3_backfill_revision", last - 1).containsEntry("o3_backfill_error", "invalid_journal");
    }

    private void twoHistoricalReceipts() {
        ordinaryNotStartedReceipt();
        var outcome = publicResults.claim().orElseThrow().source().outcomeRef();
        var receipt = JSON.createObjectNode().put("executionCallId", "execution-2").putNull("resultRef");
        receipt.set("toolOutcomeRef", outcome);
        receipt.putArray("resources");
        append("recordToolResult", event(journal.sequence + 1, "tool.receipt", receipt) + MARKER, 1, List.of(), null);
        jdbc.update("DELETE FROM ma_operation WHERE operation_kind = 'TOOL_RESULT_PROJECTION'");
        jdbc.update(
                "UPDATE ma_session_head SET o3_backfill_revision=0, o3_backfill_pending=TRUE,"
                        + " o3_backfill_through=NULL");
    }

    @Test
    void publishesASixKiBPreviewWithoutPrematureTruncation() throws Exception {
        var fixture = largeApiFixture(6144);
        var result =
                JSON.readTree(
                        fixture.jdbc()
                                .queryForObject(
                                        "SELECT result_json FROM ma_operation WHERE operation_kind"
                                                + " = 'TOOL_RESULT_PROJECTION'",
                                        String.class));
        assertThat(result.path("preview").path("text").asText()).isEqualTo("A".repeat(6144));
        assertThat(result.path("preview").path("source_end").asInt()).isEqualTo(6144);
        assertThat(result.path("preview").path("truncated").asBoolean()).isFalse();
    }

    @Test
    void projectsOrdinaryNotStartedReceiptAndBackfillsItAfterCrash() {
        ordinaryNotStartedReceipt();
        assertThat(jdbc.queryForObject("SELECT producer_phase FROM ma_output_capture", String.class)).isEqualTo("OPEN");
        assertThat(jdbc.queryForObject("SELECT receipt_sequence FROM ma_output_capture", Long.class)).isNull();
        jdbc.update("DELETE FROM ma_operation WHERE operation_kind = 'TOOL_RESULT_PROJECTION'");
        jdbc.update(
                "UPDATE ma_session_head SET o3_backfill_pending = TRUE,"
                    + " o3_backfill_through = NULL");
        for (int i = 0; i < 4; i++) {
            publicResults.backfillOnePage();
        }
        assertThat(jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_operation WHERE operation_kind ="
                                        + " 'TOOL_RESULT_PROJECTION'", Long.class)).isEqualTo(1);
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
        jdbc.update("UPDATE ma_session SET status = 'DELETING'");
        var provider = publicationProvider(null);
        var reader = org.mockito.Mockito.mock(ManagedArtifactReader.class);
        var policy = org.mockito.Mockito.mock(ManagedArtifactPolicy.class);
        new ManagedToolResultProjector(publicResults, jdbc, provider, reader, policy,
                projectionProperties).project(publicResults.claim().orElseThrow());
        org.mockito.Mockito.verifyNoInteractions(reader, policy);
        assertThat(jdbc.queryForObject(
                                "SELECT state FROM ma_operation WHERE operation_kind ="
                                        + " 'TOOL_RESULT_PROJECTION'", String.class)).isEqualTo("SUPPRESSED");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_public_event", Long.class)).isZero();
    }

    @Test
    void deletionAfterProjectionReadSuppressesPublicCommit() {
        ordinaryNotStartedReceipt();
        insertPublicSession();
        var original = publicationPolicy();
        var policy = new ManagedArtifactPolicy() {
            public String version() { return original.version(); }
            public boolean publishOriginal(String tenant, String workspace, String session) {
                jdbc.update("UPDATE ma_session SET status = 'DELETING'");
                return true;
            }
            public boolean publishPreview(String tenant, String workspace, String session) { return false; }
            public boolean readOriginal(String tenant, String actor, String workspace, String session) { return true; }
        };
        var provider = publicationProvider(null);
        new ManagedToolResultProjector(publicResults, jdbc, provider, new ManagedArtifactReader(provider), policy,
                projectionProperties).project(publicResults.claim().orElseThrow());
        assertThat(jdbc.queryForObject(
                                "SELECT state FROM ma_operation WHERE operation_kind ="
                                        + " 'TOOL_RESULT_PROJECTION'", String.class)).isEqualTo("SUPPRESSED");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_public_event", Long.class)).isZero();
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
            assertThat(jdbc.queryForObject(
                                                    "SELECT COUNT(*) FROM ma_operation WHERE"
                                                            + " operation_kind ="
                                                            + " 'TOOL_RESULT_PROJECTION'", Long.class)).isEqualTo(1);
            status.setRollbackOnly();
        });
        assertThat(jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_operation WHERE operation_kind ="
                                        + " 'TOOL_RESULT_PROJECTION'", Long.class)).isZero();
    }

    @Test
    void lapsedCurrentClaimBacksOffWithoutPublishing() {
        ordinaryNotStartedReceipt();
        insertPublicSession();
        var provider = publicationProvider(null);
        var claim = publicResults.claim().orElseThrow();
        jdbc.update("UPDATE ma_operation SET claim_until = 1000");
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
                        "SELECT state, failure_code, available_at FROM"
                            + " ma_operation");
        assertThat(row.get("state")).isEqualTo("RETRYABLE");
        assertThat(row.get("failure_code")).isEqualTo("projection_claim_lapsed");
        assertThat(((Number) row.get("available_at")).longValue())
                .isGreaterThan(System.currentTimeMillis());
        assertThat(publicResults.claim()).isEmpty();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_public_event", Long.class))
                .isZero();
    }

    @Test
    void missingPublicTurnIsDistinctFromAnUnsupportedProducer() {
        ordinaryNotStartedReceipt();
        insertPublicSession();
        jdbc.update("DELETE FROM ma_turn");
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
                                "SELECT failure_code FROM ma_operation WHERE operation_kind ="
                                        + " 'TOOL_RESULT_PROJECTION'", String.class))
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
        assertThat(jdbc.queryForObject(
                                "SELECT state FROM ma_operation WHERE operation_kind ="
                                        + " 'TOOL_RESULT_PROJECTION'", String.class)).isEqualTo("PENDING");
        assertThat(jdbc.queryForObject(
                                "SELECT claim_generation FROM ma_operation WHERE operation_kind ="
                                        + " 'TOOL_RESULT_PROJECTION'", Long.class)).isZero();
        projectionProperties.getArtifacts().setEnabled(true);
        projector.tick();
        assertThat(jdbc.queryForObject(
                                "SELECT state FROM ma_operation WHERE operation_kind ="
                                        + " 'TOOL_RESULT_PROJECTION'", String.class)).isEqualTo("READY");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_public_event", Long.class)).isEqualTo(1);
    }

    @Test
    void newHeadsSkipHistoricalBackfill() {
        ordinaryNotStartedReceipt();
        assertThat(jdbc.queryForObject("SELECT o3_backfill_pending FROM ma_session_head", Boolean.class)).isFalse();
        jdbc.update("DELETE FROM ma_operation WHERE operation_kind = 'TOOL_RESULT_PROJECTION'");
        publicResults.backfillOnePage();
        assertThat(jdbc.queryForObject(
                                "SELECT COUNT(*) FROM ma_operation WHERE operation_kind ="
                                        + " 'TOOL_RESULT_PROJECTION'", Long.class)).isZero();
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
        jdbc.update("UPDATE ma_operation SET claim_until = 1000 WHERE operation_id = ?", crashedClaim.source().id());
        var replacement = publicResults.claim().orElseThrow();
        projector.project(crashedClaim);
        assertThat(
                        jdbc.queryForObject(
                                "SELECT state FROM ma_operation WHERE operation_kind ="
                                        + " 'TOOL_RESULT_PROJECTION'", String.class))
                .isEqualTo("LEASED");
        assertThat(
                        jdbc.queryForObject(
                                "SELECT claim_generation FROM ma_operation WHERE operation_kind ="
                                        + " 'TOOL_RESULT_PROJECTION'",
                                Long.class))
                .isEqualTo(replacement.generation());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_public_event", Long.class))
                .isZero();
        projector.project(replacement);
        projector.project(crashedClaim);
        assertThat(jdbc.queryForObject(
                                "SELECT state FROM ma_operation WHERE operation_kind ="
                                        + " 'TOOL_RESULT_PROJECTION'", String.class)).isEqualTo("READY");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_public_event", Long.class)).isEqualTo(1);
        var result = JSON.valueToTree(jdbc.queryForObject("SELECT data_json FROM ma_public_event", String.class));
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
        assertThat(jdbc.queryForObject("SELECT status FROM ma_turn", String.class)).isEqualTo("COMPLETED");
        return descriptor;
    }

    private void insertPublicSession() {
        jdbc.update(
                "UPDATE ma_session SET session_kind = 'PUBLIC', agent_id = 'qwen-code', status ="
                    + " 'CLOSED', workspace_id = ?, workspace_generation = 1, workspace_storage_id"
                    + " = ?, cwd_relative = ?, context_config_ref = ?, context_revision = 1,"
                    + " workspace_config_ref = ?, workspace_policy_ref = ? WHERE tenant_id = ? AND"
                    + " session_id = ?",
                "workspace-1", "storage-1", ".", "sha256:" + digest("config\u0000policy"), "config", "policy", "tenant-1", "session-1");
        jdbc.update(
                "INSERT INTO ma_turn (tenant_id, session_id, turn_id, prompt_id, input_json, payload_digest, status, gmt_create, gmt_modified) VALUES (?, ?, ?, ?, '[]', 'sha256:a', 'COMPLETED', 1, 1)",
                "tenant-1", "session-1", "turn_public_1", "turn-1");
        jdbc.update(
                "INSERT IGNORE INTO ma_event_stream (tenant_id, session_id, stream_kind, stream_id, covered_sequence, gmt_modified) VALUES (?, ?, 'SESSION', ?, 0, 1)", "tenant-1", "session-1", "");
    }

    static void releaseArtifacts(JdbcTemplate jdbc, DataSourceTransactionManager manager) {
        new TransactionTemplate(manager).executeWithoutResult(status -> {
            var rows = jdbc.query("SELECT scope_key, artifact_id FROM ma_artifact",
                    (row, index) -> new String[] {row.getString(1), row.getString(2)});
            for (var row : rows) {
                jdbc.update(
                                        "DELETE FROM ma_resource_ref WHERE session_scope_key = ?"
                                                + " AND owner_kind = 'ARTIFACT' AND owner_key = ?",
                        row[0], com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys.key(row[0], row[1]));
                jdbc.update(
                                        "DELETE FROM ma_artifact WHERE scope_key = ? AND"
                                                + " artifact_id = ?", row[0], row[1]);
            }
        });
    }

    private void deleteCapturedSlot(String slot) {
        new TransactionTemplate(manager).executeWithoutResult(status -> {
            jdbc.update(
                                    "DELETE FROM ma_resource_ref WHERE resource_key IN (SELECT"
                                            + " resource_key FROM ma_resource WHERE slot_key = ?)", slot);
            jdbc.update("DELETE FROM ma_resource WHERE slot_key = ?", slot);
        });
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
