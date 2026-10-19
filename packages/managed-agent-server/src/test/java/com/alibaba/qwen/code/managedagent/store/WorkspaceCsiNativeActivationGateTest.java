package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.CsiNativeActivationProof;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInfo;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.transaction.support.TransactionTemplate;

import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Native SQL proof tests require built Node producer modules. */
class WorkspaceCsiNativeActivationGateTest {
    private static final ObjectMapper JSON = new ObjectMapper()
            .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    private JdbcTemplate jdbc;
    private TransactionTemplate transaction;
    private JdbcRuntimeBindingRepository bindings;
    private JdbcRuntimeSessionRepository sessions;
    private JdbcToolExecutionRepository executions;
    private ManagedSessionStore journal;
    private RuntimeProvisionRequest request;
    private RuntimeBindingRecord binding;
    private WorkspaceCsiReservationStore reservations;
    private WorkspaceCsiReservationStore.Reservation reservation;
    private WorkspaceCsiRegistration registration;
    private String sessionId;
    private JsonNode nativeFixture;
    private String writerId;
    private String token;
    @TempDir
    Path directory;

    @BeforeEach
    void setUp(TestInfo info) throws Exception {
        var source = new DriverManagerDataSource("jdbc:h2:mem:csi-native-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
        Flyway.configure().dataSource(source).locations("classpath:db/managed-schema").load().migrate();
        jdbc = new com.alibaba.qwen.code.managedagent.store.ManagedSchemaJdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        transaction = new TransactionTemplate(manager);
        transaction.setTimeout(10);
        registration = new WorkspaceCsiRegistration("tenant", "storage", "cluster", "ns", "pvc", "pvc-uid",
                "pv", "pv-uid", "disk.csi.example.com", "volume", "backend", "disk-serial", "/workspace", 7);
        reservations = new WorkspaceCsiReservationStore(jdbc, manager, JSON);
        reservations.register(registration);
        jdbc.update(
                "INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation,"
                        + " storage_id, display_name, config_ref, policy_ref, state) VALUES"
                + " ('tenant', 'workspace', 3, 'storage', 'CSI', ?, ?, 'ACTIVE')",
                CsiFilesRetirementProfile.CONFIG_REF, CsiFilesRetirementProfile.POLICY_REF);
        jdbc.update(
                "INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                        + " VALUES ('tenant', 'workspace', ?, 'OPERATOR')", ManagedWorkspaceRegistry.actorKey("tenant", "actor"));
        var properties = new ManagedAgentProperties();
        properties.setAgentRevision("reviewed-agent/1");
        sessionId = WorkspaceCsiSessionMain.create(jdbc, manager, JSON, properties,
                new WorkspaceCsiSessionMain.Request(registration, "actor", "create", null, null,
                        new WorkspaceSelection("workspace", "."))).sessionId();
        var managed = new ManagedAgentStore(jdbc, JSON, Clock.systemUTC(), ignored -> {},
                new ManagedWorkspaceRegistry(jdbc), properties);
        request = transaction.execute(status -> managed.requireCsiRequest(registration, sessionId));
        bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
        sessions = new JdbcRuntimeSessionRepository(source);
        executions = new JdbcToolExecutionRepository(source, bindings);
        journal = new ManagedSessionStore(jdbc);
        binding = bindings.findOrCreate(request);
        binding = bindings.claimOperation(binding.getBindingId(), "operator", Duration.ofSeconds(120));
        reservation = reservations.reserve(registration, bindings, binding, UUID.randomUUID().toString());
        var seed = binding.getProvisionSeed();
        var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("https://original.example.invalid"),
                seed.getToken(), seed.getLeaseId(), seed.getEpoch());
        binding = bindings.compareAndSet(binding, binding.withAttestation(lease,
                new RuntimeResourceHandle("kubernetes-workspace", 3, Map.of("podUid", "fixture-original")),
                Instant.now(), Instant.now()));
        String method = info.getTestMethod().orElseThrow().getName();
        boolean extracted = method.startsWith("hostedTextConversation");
        generate(method.startsWith("textConversation") || extracted, extracted, method.contains("LegacyTerminal"));
        writerId = nativeFixture.path("writerId").textValue();
        token = nativeFixture.path("writerToken").textValue();
        transaction.execute(status -> journal.acquireWriter("tenant", sessionId, token,
                new ManagedSessionStoreModels.AcquireWriterRequest("workspace", writerId, 300_000L)));
    }

    @Test
    void privateNativeWriterCannotAuthorizeLegacyPublicationMutation() throws Exception {
        ready();
        var before = allRows();
        assertThatThrownBy(() -> transaction.execute(status -> journal.lockPublicationWriter(
                "tenant", "workspace", sessionId, writerId, 1, token)))
                .isInstanceOfSatisfying(ApiException.class, error -> {
                    assertThat(error.getStatus()).isEqualTo(org.springframework.http.HttpStatus.CONFLICT);
                    assertThat(error.getCode()).isEqualTo("csi_managed_mutation_unavailable");
                });
        assertThat(allRows()).isEqualTo(before);
        assertThat(commit(0).replayed()).isTrue();
        assertThat(commit(1).replayed()).isTrue();
        assertThat(allRows()).isEqualTo(before);
    }

    @Test
    void textConversationAcceptsFiveOriginalTurnsAndReplaysOldSettlementWithoutReleasingNewInput() throws Exception {
        ready();
        assertThat(nativeFixture.path("commits").size()).isEqualTo(33);
        for (int index = 2; index <= 9; index++) {
            assertThat(commit(index).replayed()).isFalse();
        }
        var before = allRows();
        assertThat(commit(8).replayed()).isTrue();
        assertThat(allRows()).isEqualTo(before);
        assertThat(commit(10).replayed()).isFalse();
        for (int index = 11; index < 32; index++) {
            assertThat(commit(index).replayed()).isFalse();
        }
        assertThat(pin()).isEqualTo(2);
        assertThat(jdbc.queryForObject(
                                "SELECT committed_sequence FROM ma_session_head", Long.class))
                .isEqualTo(41);
        before = allRows();
        for (int index = 0; index < 32; index++) {
            assertThat(commit(index).replayed()).isTrue();
        }
        assertThat(allRows()).isEqualTo(before);
        rejectedCommit((ObjectNode) nativeFixture.path("commits").get(32).path("request"));
        assertThat(allRows()).isEqualTo(before);
        assertThat(nativeFixture.path("observations").get(3).path("result").path("parts").get(0).path("thought").booleanValue())
                .isTrue();
        rejected(() -> admit("conversation-live"), "csi_native_resources_required");
    }

    @Test
    void textConversationDigestValidSemanticRefusalsRollbackAllTables() throws Exception {
        ready();
        commit(2);
        commit(3);
        var before = allRows();
        for (String field : List.of("daemonPromptId", "parentUuid", "cwd", "version", "type")) {
            rejectedCommit(changedConversationBody(4, "contentRef", body -> body.put(field, "foreign")));
            assertThat(allRows()).as(field).isEqualTo(before);
        }
        commit(4);
        before = allRows();
        rejectedCommit(changedConversationBody(5, "routeRef", body -> body.put("turnId", "foreign")));
        assertThat(allRows()).isEqualTo(before);
        commit(5);
        before = allRows();
        rejectedCommit(changedConversationBody(6, "usageRef", body -> body.put("model", "foreign")));
        assertThat(allRows()).isEqualTo(before);
        commit(6);
        before = allRows();
        rejectedCommit(changedConversationBody(7, "contentRef", body -> body.put("model", "foreign")));
        assertThat(allRows()).isEqualTo(before);
        commit(7);
        before = allRows();
        rejectedCommit(changedConversationBody(8, "resultRef", body -> ((ObjectNode) body.path("systemPayload"))
                .put("promptId", "foreign")));
        assertThat(allRows()).isEqualTo(before);
        for (String field : List.of("coveredSequence", "previousCheckpointId", "inputDigest")) {
            rejectedCommit(changedConversationBody(8, "stateRef", body -> ((ObjectNode) body.path("identity"))
                    .put(field, "foreign")));
            assertThat(allRows()).as(field).isEqualTo(before);
        }
        rejectedCommit(changedConversationBody(8, "stateRef", body -> ((ObjectNode) body.path("resume").path("recording"))
                .put("lastCompletedUuid", "invented")));
        assertThat(allRows()).isEqualTo(before);
        assertThat(commit(8).replayed()).isFalse();
    }

    @Test
    void textConversationHistoryClosureCorruptionBlocksOldReplayAndLiveAdmission() throws Exception {
        ready();
        for (int index = 2; index < 32; index++) {
            commit(index);
        }
        JsonNode part = nativeFixture.path("commits").get(27).path("request").path("resources").get(1);
        String id = part.path("resourceId").textValue();
        assertThat(part.path("kind").textValue()).isEqualTo("managed-message-part");
        assertThat(jdbc.update(
                                "UPDATE ma_resource_ref SET journal_revision = 1 WHERE resource_id"
                                        + " = ?",
                id)).isEqualTo(1);
        var before = allRows();
        rejectedCommit((ObjectNode) nativeFixture.path("commits").get(8).path("request"));
        assertThat(allRows()).isEqualTo(before);
        rejected(() -> admit("conversation-corrupt"), "csi_original_activation_unavailable");
        assertThat(allRows()).isEqualTo(before);
    }

    private Map<String, List<String>> allRows() {
        Map<String, List<String>> rows = new TreeMap<>();
        for (String table : jdbc.queryForList(
                        "SELECT table_name FROM information_schema.tables WHERE table_schema ="
                                + " 'public' AND table_type = 'BASE TABLE' ORDER BY table_name", String.class)) {
            rows.put(table, jdbc.queryForList("SELECT * FROM \"" + table + "\"").stream()
                    .map(row -> JSON.valueToTree(new TreeMap<>(row)).toString()).sorted().toList());
        }
        assertThat(rows).containsKeys("ma_delivery", "ma_session", "ma_session_head", "ma_request_receipt");
        assertThat(rows).hasSize(33);
        return rows;
    }

    private ObjectNode changedConversationBody(int index, String field,
            java.util.function.Consumer<ObjectNode> change) throws Exception {
        ObjectNode request = nativeFixture.path("commits").get(index).path("request").deepCopy();
        var records = CsiNativeActivationProof.records(Base64.getDecoder().decode(request.path("recordBytesBase64").textValue()));
        ObjectNode ref = (ObjectNode) records.get(field.equals("stateRef") ? 1 : 0).path("managedSession").path("payload").path(field);
        ObjectNode resource = null;
        for (JsonNode candidate : request.path("resources")) {
            if (candidate.path("resourceId").equals(ref.path("resourceId"))) {
                resource = (ObjectNode) candidate;
            }
        }
        assertThat(resource).isNotNull();
        ObjectNode body = (ObjectNode) JSON.readTree(Base64.getDecoder().decode(resource.path("bytesBase64").textValue()));
        change.accept(body);
        byte[] bytes = JSON.writeValueAsBytes(body);
        String digest = CsiNativeActivationProof.sha256(bytes);
        resource.put("bytesBase64", Base64.getEncoder().encodeToString(bytes)).put("byteLength", bytes.length).put("digest", digest);
        ref.put("byteLength", bytes.length).put("digest", digest);
        if (field.equals("routeRef") || field.equals("resultRef")) {
            request.put("contentDigest", digest);
        }
        return resign(request, records);
    }

    @Test
    void nativeInputReplayAndRenewalRetainCheckpointAndUnsettledInputFence() throws Exception {
        ready();
        commit(2);
        commit(3);
        commit(4);
        String checkpoint = nativeFixture.path("commits").get(3).path("request")
                .path("latestCheckpointResourceId").textValue();
        assertThat(commit(5).replayed()).isFalse();
        var before = authorityRows();
        assertThat(commit(5).replayed()).isTrue();
        assertThat(authorityRows()).isEqualTo(before);
        commit(6);
        assertThat(pin()).isEqualTo(2);
        assertThat(jdbc.queryForObject(
                                "SELECT latest_checkpoint_resource_id FROM ma_session_head",
                String.class)).isEqualTo(checkpoint);
        before = authorityRows();
        rejectedCommit((ObjectNode) nativeFixture.path("commits").get(7).path("request"));
        assertThat(authorityRows()).isEqualTo(before);
        retire();
        before = authorityRows();
        assertThatThrownBy(() -> commit(5)).isInstanceOf(RuntimeBrokerException.class);
        assertThat(authorityRows()).isEqualTo(before);
        var second = JSON.treeToValue(nativeFixture.path("commits").get(7).path("request"),
                ManagedSessionStoreModels.CommitTransactionRequest.class);
        rejected(() -> transaction.execute(status -> journal.commit("tenant", sessionId, token, second)),
                "runtime_admission_closed");
        assertThat(authorityRows()).isEqualTo(before);
    }

    @Test
    void nativeInputRequiresClosedOriginalPromptAndAdmissionBytes() throws Exception {
        ready();
        commit(2);
        commit(3);
        commit(4);
        var before = authorityRows();
        for (String input : List.of("[]", "[{\"type\":\"text\",\"text\":\"\"}]",
                "[{\"type\":\"image\",\"text\":\"value\"}]", "[{\"type\":\"text\",\"text\":\"value\",\"extra\":true}]",
                "[{\"type\":\"text\",\"text\":\"a\",\"text\":\"b\"}]", "[] []")) {
            rejectedCommit(changedInputBytes(input.getBytes(java.nio.charset.StandardCharsets.UTF_8),
                    admission -> {}));
            assertThat(authorityRows()).as(input.substring(0, Math.min(input.length(), 60))).isEqualTo(before);
        }
        byte[] original = Base64.getDecoder().decode(nativeFixture.path("commits").get(5)
                .path("request").path("resources").get(0).path("bytesBase64").textValue());
        for (String field : List.of("promptId", "digest", "extra")) {
            rejectedCommit(changedInputBytes(original, admission -> admission.put(field, "foreign")));
            assertThat(authorityRows()).as(field).isEqualTo(before);
        }
        rejectedCommit(changedInputBytes(new byte[] {(byte) 0xff}, admission -> {}));
        assertThat(authorityRows()).isEqualTo(before);
        var oversized = JSON.treeToValue(changedInputBytes(
                ("[{\"type\":\"text\",\"text\":\"" + "a".repeat(64 * 1024) + "\"}]")
                        .getBytes(java.nio.charset.StandardCharsets.UTF_8), admission -> {}),
                ManagedSessionStoreModels.CommitTransactionRequest.class);
        assertThatThrownBy(() -> transaction.execute(status -> journal.commit("tenant", sessionId, token, oversized)))
                .isInstanceOf(com.alibaba.qwen.code.managedagent.api.ApiException.class)
                .hasMessage("Resources larger than 64 KiB require the disabled OSS storage path.");
        assertThat(authorityRows()).isEqualTo(before);
        assertThat(commit(5).replayed()).isFalse();
    }

    @Test
    void nativeInputRefusesSemanticMismatchesEvenWithValidTransactionIntegrity() throws Exception {
        ready();
        commit(2);
        commit(3);
        commit(4);
        var before = authorityRows();
        for (String field : List.of("inputId", "turnId", "source")) {
            rejectedCommit(changedInput(event -> ((ObjectNode) event.path("payload")).put(field, "foreign"),
                    event -> {}));
            assertThat(authorityRows()).as(field).isEqualTo(before);
        }
        for (String field : List.of("wakeId", "reason", "sourceEventId")) {
            rejectedCommit(changedInput(event -> {},
                    event -> ((ObjectNode) event.path("payload")).put(field, "foreign")));
            assertThat(authorityRows()).as(field).isEqualTo(before);
        }
        rejectedCommit(changedInput(event -> event.putObject("subject"), event -> {}));
        rejectedCommit(changedInput(event -> {}, event -> ((ObjectNode) event.path("payload"))
                .put("requiredSequence", 1)));
        rejectedCommit(changedInput(event -> {}, event -> ((ObjectNode) event.path("payload").path("subject"))
                .put("turnId", UUID.randomUUID().toString())));
        rejectedCommit(changedInput(event -> {}, event -> event.put("occurredAt", 1)));
        rejectedCommit(changedInput(event -> ((ObjectNode) event.path("payload"))
                .put("deadline", -1), event -> {}));
        rejectedCommit(changedInput(event -> ((ObjectNode) event.path("payload"))
                .put("extra", true), event -> {}));
        assertThat(authorityRows()).isEqualTo(before);
        assertThat(commit(5).replayed()).isFalse();
    }

    @Test
    void corruptInputRevisionClosureRefusesReplayRenewalAndExecution() throws Exception {
        ready();
        commit(2);
        commit(3);
        commit(4);
        commit(5);
        String resource = nativeFixture.path("commits").get(5).path("request").path("resources").get(0)
                .path("resourceId").textValue();
        jdbc.update(
                "UPDATE ma_resource_ref SET journal_revision = 1 WHERE resource_id = ?", resource);
        var before = authorityRows();
        rejectedCommit((ObjectNode) nativeFixture.path("commits").get(5).path("request"));
        rejectedCommit((ObjectNode) nativeFixture.path("commits").get(6).path("request"));
        rejected(() -> admit("corrupt-input-resource"), "csi_original_activation_unavailable");
        assertThat(authorityRows()).isEqualTo(before);
    }

    @Test
    void initialCheckpointRefusesNonemptyOrMismatchedStateWithValidIntegrity() throws Exception {
        ready();
        commit(2);
        var before = authorityRows();
        for (String pointer : List.of("/identity/definitionRevision", "/identity/configRevision", "/identity/inputDigest",
                "/identity/sessionKey/sessionId", "/identity/activationId", "/identity/turnId", "/identity/promptId",
                "/identity/previousCheckpointId", "/resume/recording/lastCompletedUuid", "/resume/apiHistoryRef",
                "/output/physicalStatus", "/followUp/stopBudgetRemaining")) {
            ObjectNode request = changedCheckpoint(state -> {
                int slash = pointer.lastIndexOf('/');
                ((ObjectNode) state.at(pointer.substring(0, slash))).put(pointer.substring(slash + 1), "foreign");
            }, event -> {});
            rejectedCommit(request);
            assertThat(authorityRows()).as(pointer).isEqualTo(before);
        }
        for (String pointer : List.of("/identity/coveredSequence", "/identity/schemaVersion", "/resume/throughSequence",
                "/resume/initialTurn")) {
            rejectedCommit(changedCheckpoint(state -> {
                int slash = pointer.lastIndexOf('/');
                ((ObjectNode) state.at(pointer.substring(0, slash))).put(pointer.substring(slash + 1), 99);
            }, event -> {}));
            assertThat(authorityRows()).as(pointer).isEqualTo(before);
        }
        for (String pointer : List.of("/continuation/pendingEventIds", "/resume/consumedNotificationIds",
                "/resume/recording/turnParentUuids", "/followUp/childRunIds", "/output/mediaRefs")) {
            rejectedCommit(changedCheckpoint(state -> ((com.fasterxml.jackson.databind.node.ArrayNode) state.at(pointer))
                    .add("pending"), event -> {}));
            assertThat(authorityRows()).as(pointer).isEqualTo(before);
        }
        for (String field : List.of("attempt", "tools", "runtime", "approval")) {
            rejectedCommit(changedCheckpoint(state -> state.putObject(field), event -> {}));
            assertThat(authorityRows()).as(field).isEqualTo(before);
        }
        rejectedCommit(changedCheckpoint(state -> ((ObjectNode) state.path("continuation"))
                .put("phase", "results_ready"), event -> {}));
        rejectedCommit(changedCheckpoint(state -> state.put("extra", true), event -> {}));
        rejectedCommit(changedCheckpoint(state -> {}, event -> ((ObjectNode) event.path("subject"))
                .put("activationId", "foreign")));
        rejectedCommit(changedCheckpoint(state -> {}, event -> ((ObjectNode) event.path("payload"))
                .put("coveredSequence", 99)));
        assertThat(authorityRows()).isEqualTo(before);
        assertThat(commit(3).replayed()).isFalse();
    }

    @Test
    void sealedOriginalRefusesInitialCheckpointAndPreservesResources() throws Exception {
        ready();
        commit(2);
        retire();
        var before = authorityRows();
        var value = JSON.treeToValue(nativeFixture.path("commits").get(3).path("request"),
                ManagedSessionStoreModels.CommitTransactionRequest.class);
        rejected(() -> transaction.execute(status -> journal.commit("tenant", sessionId, token, value)),
                "runtime_admission_closed");
        assertThat(authorityRows()).isEqualTo(before);
    }

    @Test
    void corruptedDerivedCheckpointHeadRefusesRenewalReplayAndExecution() throws Exception {
        ready();
        commit(2);
        commit(3);
        jdbc.update("UPDATE ma_session_head SET latest_checkpoint_resource_id = NULL");
        var before = authorityRows();
        rejectedCommit((ObjectNode) nativeFixture.path("commits").get(4).path("request"));
        rejectedCommit((ObjectNode) nativeFixture.path("commits").get(3).path("request"));
        rejected(() -> admit("corrupt-checkpoint-head"), "csi_original_activation_unavailable");
        assertThat(authorityRows()).isEqualTo(before);
    }

    @Test
    void firstPinAndOriginalRenewalAreAtomicReplayIsReadonlyAndStaleBindingCasFails() throws Exception {
        commit(0);
        assertThat(pin()).isNull();
        assertThat(bindings.findById(binding.getBindingId()).getVersion()).isEqualTo(binding.getVersion());
        commit(1);
        assertThat(pin()).isEqualTo(2);
        long pinnedVersion = binding.getVersion() + 1;
        assertThat(bindings.findById(binding.getBindingId()).getVersion()).isEqualTo(pinnedVersion);
        var before = head();
        assertThat(commit(1).replayed()).isTrue();
        assertThat(head()).isEqualTo(before);
        assertThat(bindings.findById(binding.getBindingId()).getVersion()).isEqualTo(pinnedVersion);
        assertThat(bindings.compareAndSet(binding, binding)).isNull();
        commit(2);
        assertThat(pin()).isEqualTo(2);
        assertThat(bindings.findById(binding.getBindingId()).getVersion()).isEqualTo(pinnedVersion);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_journal_tx", Integer.class)).isEqualTo(3);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource", Integer.class)).isEqualTo(3);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref", Integer.class)).isEqualTo(4);
    }

    @Test
    void lateJournalFailureRollsBackPinVersionHeadAndOriginalResourceReference() throws Exception {
        commit(0);
        var before = head();
        jdbc.execute(
                "ALTER TABLE ma_session_journal_tx ADD CONSTRAINT owned_reject_install CHECK"
                        + " (journal_revision < 2)");
        assertThatThrownBy(() -> commit(1)).isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
        assertThat(pin()).isNull();
        assertThat(head()).isEqualTo(before);
        assertThat(bindings.findById(binding.getBindingId()).getVersion()).isEqualTo(binding.getVersion());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_journal_tx", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource", Integer.class)).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref", Integer.class)).isEqualTo(2);
    }

    @Test
    void missingPinnedOriginalReferenceBlocksSelectedAdmissionWithoutNewExecution() throws Exception {
        commit(0);
        commit(1);
        jdbc.update("DELETE FROM ma_resource_ref WHERE journal_revision = 2");
        var candidate = ToolExecutionRecord.prepared("missing-ref-call", "missing-ref-key", binding.getBindingId(), 1,
                sessionId, sessionId, "turn", "call", "sha256:" + "b".repeat(64), Map.of("dispatchMode", "deferred", "sessionId", sessionId,
                        "promptId", "turn", "callId", "call", "argsDigest", "sha256:" + "b".repeat(64)));
        rejected(() -> bindings.admitExecution(sessions, executions, candidate), "csi_original_activation_unavailable");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_tool_execution", Integer.class)).isZero();
        assertThat(pin()).isEqualTo(2);
    }

    private void ready() throws Exception {
        var runtime = bindings.admitSession(sessions, new RuntimeSessionRecord(
                new RuntimeSession(sessionId, sessionId, "bootstrap", request.getScope()), binding.getBindingId(), 1,
                RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
        sessions.compareAndSet(runtime, runtime.withState(RuntimeSessionRecord.State.READY, Instant.now()));
        commit(0);
        commit(1);
    }

    private ToolExecutionRecord admit(String id) {
        return bindings.admitExecution(sessions, executions, ToolExecutionRecord.prepared(id, id + "-key", binding.getBindingId(), 1,
                sessionId, sessionId, id + "-turn", id + "-tool", "sha256:" + "a".repeat(64),
                Map.of("dispatchMode", "deferred", "sessionId", sessionId, "promptId", id + "-turn", "callId", id + "-tool", "argsDigest", "sha256:" + "a".repeat(64))));
    }

    private WorkspaceCsiReservationStore.Retirement retire() {
        return reservations.beginRetirement(registration, bindings, bindings.findById(binding.getBindingId()), reservation, UUID.randomUUID().toString());
    }

    private ManagedSessionStoreModels.CommitReceipt commit(int index) throws Exception {
        var value = JSON.treeToValue(nativeFixture.path("commits").get(index).path("request"),
                ManagedSessionStoreModels.CommitTransactionRequest.class);
        return transaction.execute(status -> journal.commit("tenant", sessionId, token, value));
    }

    private void rejectedCommit(ObjectNode request) throws Exception {
        var value = JSON.treeToValue(request, ManagedSessionStoreModels.CommitTransactionRequest.class);
        rejected(() -> transaction.execute(status -> journal.commit("tenant", sessionId, token, value)),
                "csi_original_activation_unavailable");
    }

    private ObjectNode changedCheckpoint(java.util.function.Consumer<ObjectNode> changeState,
            java.util.function.Consumer<ObjectNode> changeEvent) throws Exception {
        ObjectNode request = nativeFixture.path("commits").get(3).path("request").deepCopy();
        ObjectNode resource = (ObjectNode) request.path("resources").get(0);
        ObjectNode state = (ObjectNode) JSON.readTree(Base64.getDecoder().decode(resource.path("bytesBase64").textValue()));
        var records = CsiNativeActivationProof.records(Base64.getDecoder().decode(request.path("recordBytesBase64").textValue()));
        ObjectNode event = (ObjectNode) records.getFirst().path("managedSession");
        changeState.accept(state);
        byte[] stateBytes = JSON.writeValueAsBytes(state);
        String digest = CsiNativeActivationProof.sha256(stateBytes);
        resource.put("bytesBase64", Base64.getEncoder().encodeToString(stateBytes))
                .put("byteLength", stateBytes.length).put("digest", digest);
        ((ObjectNode) event.path("payload").path("stateRef")).put("byteLength", stateBytes.length).put("digest", digest);
        changeEvent.accept(event);
        request.put("contentDigest", digest);
        return resign(request, records);
    }

    private ObjectNode changedInput(java.util.function.Consumer<ObjectNode> changeAccepted,
            java.util.function.Consumer<ObjectNode> changeWake) throws Exception {
        ObjectNode request = nativeFixture.path("commits").get(5).path("request").deepCopy();
        var records = CsiNativeActivationProof.records(Base64.getDecoder().decode(request.path("recordBytesBase64").textValue()));
        changeAccepted.accept((ObjectNode) records.get(0).path("managedSession"));
        changeWake.accept((ObjectNode) records.get(1).path("managedSession"));
        return resign(request, records);
    }

    private ObjectNode resign(ObjectNode request, List<JsonNode> records) throws Exception {
        var events = records.subList(0, records.size() - 1).stream()
                .map(record -> sorted(record.path("managedSession"))).toList();
        request.put("eventsDigest", CsiNativeActivationProof.sha256(JSON.writeValueAsString(events)
                .replace("\ud800", "\\ud800").getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        ObjectNode marker = (ObjectNode) records.getLast().path("managedSession");
        marker.put("contentDigest", request.path("contentDigest").textValue())
                .put("eventsDigest", request.path("eventsDigest").textValue());
        request.put("commitDigest", CsiNativeActivationProof.sha256(JSON.writeValueAsBytes(sorted(marker))));
        StringBuilder text = new StringBuilder();
        for (JsonNode record : records) {
            text.append(JSON.writeValueAsString(record).replace("\ud800", "\\ud800")).append('\n');
        }
        byte[] bytes = text.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8);
        request.put("recordBytesBase64", Base64.getEncoder().encodeToString(bytes))
                .put("recordDigest", CsiNativeActivationProof.sha256(bytes));
        CsiNativeActivationProof.transaction(records, request, this.request,
                records.getFirst().path("parentUuid").textValue());
        return request;
    }

    private ObjectNode changedInputBytes(byte[] input, java.util.function.Consumer<ObjectNode> changeAdmission)
            throws Exception {
        ObjectNode request = nativeFixture.path("commits").get(5).path("request").deepCopy();
        var records = CsiNativeActivationProof.records(Base64.getDecoder().decode(request.path("recordBytesBase64").textValue()));
        ObjectNode payload = (ObjectNode) records.getFirst().path("managedSession").path("payload");
        String digest = CsiNativeActivationProof.sha256(input);
        ObjectNode admission = JSON.createObjectNode().put("promptId", payload.path("inputId").textValue())
                .put("digest", "sha256:" + digest);
        changeAdmission.accept(admission);
        byte[][] bytes = {input, JSON.writeValueAsBytes(admission)};
        String[] refs = {"contentRef", "admissionRef"};
        for (int index = 0; index < bytes.length; index++) {
            ((ObjectNode) request.path("resources").get(index))
                    .put("bytesBase64", Base64.getEncoder().encodeToString(bytes[index]))
                    .put("byteLength", bytes[index].length).put("digest", CsiNativeActivationProof.sha256(bytes[index]));
            ((ObjectNode) payload.path(refs[index])).put("byteLength", bytes[index].length)
                    .put("digest", CsiNativeActivationProof.sha256(bytes[index]));
        }
        request.put("contentDigest", digest);
        return resign(request, records);
    }

    private static Object sorted(JsonNode node) {
        if (node.isObject()) {
            Map<String, Object> result = new TreeMap<>();
            node.fields().forEachRemaining(field -> result.put(field.getKey(), sorted(field.getValue())));
            return result;
        }
        if (node.isArray()) {
            var result = new java.util.ArrayList<>();
            node.forEach(child -> result.add(sorted(child)));
            return result;
        }
        return JSON.convertValue(node, Object.class);
    }

    private Map<String, List<String>> authorityRows() {
        Map<String, List<String>> rows = new TreeMap<>();
        for (String table : List.of(
                        "ma_session_head",
                        "ma_session_journal_tx",
                        "ma_resource",
                        "ma_resource_ref",
                        "ma_runtime_binding",
                        "ma_session",
                        "ma_runtime_session",
                        "ma_tool_execution",
                        "ma_storage_owner",
                        "ma_operation")) {
            rows.put(table, jdbc.queryForList("SELECT * FROM " + table).stream()
                    .map(row -> JSON.valueToTree(new TreeMap<>(row)).toString()).sorted().toList());
        }
        return rows;
    }

    @Test
    void pinNullWithCommittedActivationHistoryCannotBeRepairedByRenewal() throws Exception {
        commit(0);
        commit(1);
        jdbc.update("UPDATE ma_runtime_binding SET first_activation_journal_revision = NULL");
        var before = head();
        assertThatThrownBy(() -> commit(2)).isInstanceOfSatisfying(RuntimeBrokerException.class,
                error -> assertThat(error.getCode()).isEqualTo("csi_original_activation_unavailable"));
        assertThat(pin()).isNull();
        assertThat(head()).isEqualTo(before);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_session_journal_tx", Integer.class)).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref", Integer.class)).isEqualTo(3);
    }

    @Test
    void priorTerminalAuthorizationRefusesFirstPinAndRollsBackInstallResource() throws Exception {
        commit(0);
        var historical = ToolExecutionRecord.prepared("prior-call", "prior-key", "owned-legacy-binding", 1,
                sessionId, sessionId, "prior-turn", "prior-tool", "sha256:" + "c".repeat(64), Map.of("dispatchMode", "deferred", "sessionId", sessionId,
                        "promptId", "prior-turn", "callId", "prior-tool", "argsDigest", "sha256:" + "c".repeat(64)));
        executions.findOrCreate(historical);
        jdbc.update(
                "UPDATE ma_tool_execution SET binding_id = ?, execution_state = 'SETTLED',"
                        + " execution_status = 'success', dispatch_generation = 1,"
                        + " authorized_dispatch_generation = 1, authorized_binding_version = ?", binding.getBindingId(), binding.getVersion());
        var before = head();
        assertThatThrownBy(() -> commit(1)).isInstanceOfSatisfying(RuntimeBrokerException.class,
                error -> assertThat(error.getCode()).isEqualTo("csi_original_activation_unavailable"));
        assertThat(pin()).isNull();
        assertThat(head()).isEqualTo(before);
        assertThat(bindings.findById(binding.getBindingId()).getVersion()).isEqualTo(binding.getVersion());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource", Integer.class)).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_resource_ref", Integer.class)).isEqualTo(2);
    }

    private Long pin() {
        return jdbc.queryForObject(
                "SELECT first_activation_journal_revision FROM ma_runtime_binding WHERE binding_id"
                        + " = ?",
                Long.class, binding.getBindingId());
    }

    private List<Map<String, Object>> head() {
        return jdbc.queryForList("SELECT " + ManagedSchemaProjection.SESSION_HEAD.columns() + " FROM ma_session_head");
    }

    @Test
    void hostedTextConversationAcceptsActualExtractedProducerBytesAndExactReplay() throws Exception {
        ready();
        int terminalRelease = nativeFixture.path("commits").size() - 1;
        for (int index = 2; index < terminalRelease; index++) {
            assertThat(commit(index).replayed()).isFalse();
        }
        var before = allRows();
        for (int index = 0; index < terminalRelease; index++) {
            assertThat(commit(index).replayed()).isTrue();
        }
        assertThat(allRows()).isEqualTo(before);
        for (JsonNode observation : nativeFixture.path("observations")) {
            assertThat(observation.path("terminal").path("systemPayload").path("state").textValue()).isEqualTo("completed");
            assertThat(observation.path("terminal").has("daemonPromptId")).isFalse();
        }
        rejectedCommit((ObjectNode) nativeFixture.path("commits").get(terminalRelease).path("request"));
    }

    @Test
    void hostedTextConversationRejectsLegacyTerminalFieldsWithValidResourceDigests() throws Exception {
        ready();
        int settlement = 2;
        while (!nativeFixture.path("commits").get(settlement).path("request").path("operation").asText()
                .equals("settleTurn")) {
            assertThat(commit(settlement++).replayed()).isFalse();
        }
        var before = allRows();
        rejectedCommit((ObjectNode) nativeFixture.path("commits").get(settlement).path("request"));
        assertThat(allRows()).isEqualTo(before);
    }

    private void generate(boolean conversation, boolean extracted, boolean legacyTerminal) throws Exception {
        Path root = Path.of("../..").toRealPath();
        Path input = directory.resolve("input.json");
        var value = JSON.createObjectNode().put("cwd", request.getScope().getCanonicalCwd())
                .put("capabilityDigest", CsiFilesRetirementProfile.CAPABILITY_DIGEST);
        if (conversation) {
            value.put("conversation", true);
        }
        if (extracted) {
            value.put("extractedProducer", true);
            value.put("legacyTerminalShape", legacyTerminal);
        }
        value.putObject("sessionKey").put("tenantId", "tenant").put("workspaceId", "workspace").put("sessionId", sessionId);
        JSON.writeValue(input.toFile(), value);
        Path generator = directory.resolve("generator.mjs");
        try (var stream = getClass().getResourceAsStream("/csi-native-activation-generator.mjs")) {
            assertThat(stream).isNotNull();
            Files.copy(stream, generator);
        }
        if (conversation) {
            try (var stream = getClass().getResourceAsStream("/csi-native-text-turns.mjs")) {
                assertThat(stream).isNotNull();
                Files.copy(stream, directory.resolve("csi-native-text-turns.mjs"));
            }
        }
        Path log = directory.resolve("generator.log");
        var builder = new ProcessBuilder("node", generator.toString(), input.toString(), directory.toString())
                .directory(root.toFile()).redirectErrorStream(true).redirectOutput(log.toFile());
        if (conversation) {
            Path settings = directory.resolve("settings");
            Files.createDirectories(settings);
            Files.writeString(directory.resolve("system.json"), "{\"$version\":4}");
            Files.writeString(directory.resolve("defaults.json"), "{\"$version\":4}");
            var env = builder.environment();
            env.put("QWEN_HOME", settings.toString());
            env.put("QWEN_RUNTIME_DIR", directory.resolve("runtime").toString());
            env.put("QWEN_CODE_SYSTEM_SETTINGS_PATH", directory.resolve("system.json").toString());
            env.put("QWEN_CODE_SYSTEM_DEFAULTS_PATH", directory.resolve("defaults.json").toString());
            env.put("OPENAI_API_KEY", "owned-dummy-key");
            env.put("OPENAI_MODEL", "owned-model");
            env.remove("OPENAI_BASE_URL");
        }
        Process process = builder.start();
        try {
            assertThat(process.waitFor(30, TimeUnit.SECONDS)).as("native generator must finish").isTrue();
            assertThat(process.exitValue()).as(Files.readString(log)).isZero();
        } finally {
            if (process.isAlive()) {
                process.destroyForcibly().waitFor(10, TimeUnit.SECONDS);
            }
        }
        nativeFixture = JSON.readTree(directory.resolve("native-fixture.json").toFile());
        assertThat(nativeFixture.path("workerId").textValue()).isEqualTo(nativeFixture.path("writerId").textValue());
        assertThat(nativeFixture.path("input").path("sessionKey").path("sessionId").textValue()).isEqualTo(sessionId);
    }

    private static void rejected(Runnable action, String code) {
        assertThatThrownBy(action::run).isInstanceOfSatisfying(RuntimeBrokerException.class,
                error -> assertThat(error.getCode()).isEqualTo(code));
    }
}
