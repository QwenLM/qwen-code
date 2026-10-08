package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Base64;
import java.util.TreeMap;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
import org.springframework.jdbc.datasource.SingleConnectionDataSource;
import org.springframework.transaction.support.TransactionTemplate;

/** Explicit SQL integration gate; requires built Node native producer modules. */
class WorkspaceCsiNativeActivationGate {
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
    void setUp() throws Exception {
        var source = new DriverManagerDataSource("jdbc:h2:mem:csi-native-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE", "sa", "");
        Flyway.configure().dataSource(source).locations("classpath:db/migration").load().migrate();
        jdbc = new JdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        transaction = new TransactionTemplate(manager);
        transaction.setTimeout(10);
        registration = new WorkspaceCsiRegistration("tenant", "storage", "cluster", "ns", "pvc", "pvc-uid",
                "pv", "pv-uid", "disk.csi.example.com", "volume", "backend", "disk-serial", "/workspace", 7);
        reservations = new WorkspaceCsiReservationStore(jdbc, manager, JSON);
        reservations.register(registration);
        jdbc.update("INSERT INTO managed_workspace_registry (tenant_id, workspace_id, workspace_generation,"
                + " storage_id, display_name, config_ref, policy_ref, state) VALUES"
                + " ('tenant', 'workspace', 3, 'storage', 'CSI', ?, ?, 'ACTIVE')",
                CsiFilesRetirementProfile.CONFIG_REF, CsiFilesRetirementProfile.POLICY_REF);
        jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, can_read, can_create)"
                + " VALUES ('tenant', 'workspace', ?, TRUE, TRUE)", ManagedWorkspaceRegistry.actorKey("tenant", "actor"));
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
        executions = new JdbcToolExecutionRepository(source);
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
        generate();
        writerId = nativeFixture.path("writerId").textValue();
        token = nativeFixture.path("writerToken").textValue();
        transaction.execute(status -> journal.acquireWriter("tenant", sessionId, token,
                new ManagedSessionStoreModels.AcquireWriterRequest("workspace", writerId, 300_000L)));
    }

    @Test
    void exactRequestRetryReturnsOriginalReceiptWithoutResetOrRegrant() throws Exception {
        ready();
        var original = admit("exact-retry");
        var candidate = ToolExecutionRecord.prepared("fresh-server-id", original.getIdempotencyKey(),
                original.getBindingId(), original.getRuntimeGeneration(), original.getHarnessSessionId(),
                original.getRuntimeSessionId(), original.getTurnId(), original.getToolCallId(),
                original.getRequestDigest(), original.getReference());
        var before = authorityRows();
        assertThat(bindings.admitExecution(sessions, executions, candidate))
                .usingRecursiveComparison().isEqualTo(original);
        assertThat(authorityRows()).isEqualTo(before);
        assertThat(executions.findByExecutionCallId(candidate.getExecutionCallId())).isNull();

        var executing = authorize(original);
        before = authorityRows();
        assertThat(bindings.admitExecution(sessions, executions, candidate))
                .usingRecursiveComparison().isEqualTo(executing);
        assertThat(authorityRows()).isEqualTo(before);

        var settled = executions.compareAndSet(executing,
                executing.withResult(Map.of("executionStatus", "success", "responseParts", List.of()), 4, Instant.now()),
                "owner", executing.getDispatchGeneration());
        assertThat(settled.getState()).isEqualTo(ToolExecutionRecord.State.SETTLED);
        before = authorityRows();
        assertThat(bindings.admitExecution(sessions, executions, candidate))
                .usingRecursiveComparison().isEqualTo(settled);
        assertThat(authorityRows()).isEqualTo(before);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_execution", Integer.class)).isEqualTo(1);
    }

    @Test
    void sameKeyWithChangedRequestStillRefusesWithoutMutation() throws Exception {
        ready();
        var original = admit("changed-retry");
        var before = authorityRows();
        for (String changed : List.of("turn", "call", "digest")) {
            String turn = changed.equals("turn") ? "different-turn" : original.getTurnId();
            String call = changed.equals("call") ? "different-call" : original.getToolCallId();
            String digest = changed.equals("digest") ? "sha256:" + "b".repeat(64) : original.getRequestDigest();
            var candidate = ToolExecutionRecord.prepared("fresh-" + changed, original.getIdempotencyKey(),
                    original.getBindingId(), original.getRuntimeGeneration(), original.getHarnessSessionId(),
                    original.getRuntimeSessionId(), turn, call, digest,
                    Map.of("dispatchMode", "deferred", "sessionId", sessionId, "promptId", turn,
                            "callId", call, "argsDigest", digest));
            assertThatThrownBy(() -> bindings.admitExecution(sessions, executions, candidate))
                    .isInstanceOf(IllegalArgumentException.class).hasMessage("Execution identity differs");
            assertThat(authorityRows()).as(changed).isEqualTo(before);
        }
    }

    @Test
    void existingReceiptRetryStillRequiresCurrentNativePinReadySessionAndOpenAdmission() throws Exception {
        ready();
        var original = admit("guarded-retry");
        var candidate = ToolExecutionRecord.prepared("fresh-guarded-id", original.getIdempotencyKey(),
                original.getBindingId(), original.getRuntimeGeneration(), original.getHarnessSessionId(),
                original.getRuntimeSessionId(), original.getTurnId(), original.getToolCallId(),
                original.getRequestDigest(), original.getReference());
        jdbc.update("UPDATE qwen_runtime_binding SET first_activation_journal_revision = NULL");
        var before = authorityRows();
        rejected(() -> bindings.admitExecution(sessions, executions, candidate), "csi_original_activation_unavailable");
        assertThat(authorityRows()).isEqualTo(before);

        jdbc.update("UPDATE qwen_runtime_binding SET first_activation_journal_revision = 2");
        var runtime = sessions.findById(request.getScope(), sessionId);
        assertThat(sessions.compareAndSet(runtime, runtime.withState(RuntimeSessionRecord.State.FAILED, Instant.now())))
                .isNotNull();
        before = authorityRows();
        rejected(() -> bindings.admitExecution(sessions, executions, candidate), "runtime_admission_closed");
        assertThat(authorityRows()).isEqualTo(before);

        jdbc.update("UPDATE qwen_runtime_session SET session_state = 'READY'");
        retire();
        before = authorityRows();
        rejected(() -> bindings.admitExecution(sessions, executions, candidate), "runtime_admission_closed");
        assertThat(authorityRows()).isEqualTo(before);
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
        assertThat(jdbc.queryForObject("SELECT latest_checkpoint_resource_id FROM qwen_managed_session_journal_head",
                String.class)).isEqualTo(checkpoint);
        before = authorityRows();
        rejectedCommit((ObjectNode) nativeFixture.path("commits").get(7).path("request"));
        assertThat(authorityRows()).isEqualTo(before);
        retire();
        before = authorityRows();
        assertThat(commit(5).replayed()).isTrue();
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
        jdbc.update("UPDATE qwen_managed_session_resource_ref SET journal_revision = 1 WHERE resource_id = ?", resource);
        var before = authorityRows();
        rejectedCommit((ObjectNode) nativeFixture.path("commits").get(5).path("request"));
        rejectedCommit((ObjectNode) nativeFixture.path("commits").get(6).path("request"));
        rejected(() -> admit("corrupt-input-resource"), "csi_original_activation_unavailable");
        assertThat(authorityRows()).isEqualTo(before);
    }

    @Test
    void initialNativeCheckpointRetainsOriginalPinRenewalAndExecutionContinuation() throws Exception {
        ready();
        commit(2);
        assertThat(commit(3).replayed()).isFalse();
        String checkpoint = nativeFixture.path("commits").get(3).path("request")
                .path("latestCheckpointResourceId").textValue();
        assertThat(jdbc.queryForObject("SELECT latest_checkpoint_resource_id FROM qwen_managed_session_journal_head",
                String.class)).isEqualTo(checkpoint);
        var before = authorityRows();
        assertThat(commit(3).replayed()).isTrue();
        assertThat(authorityRows()).isEqualTo(before);
        commit(4);
        assertThat(pin()).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT latest_checkpoint_resource_id FROM qwen_managed_session_journal_head",
                String.class)).isEqualTo(checkpoint);
        var executing = authorize(admit("checkpoint-original"));
        retire();
        assertThat(executions.renewDispatch(executing.getExecutionCallId(), "owner", 1, Duration.ofSeconds(120)))
                .isNotNull();
        var renewed = executions.findByExecutionCallId(executing.getExecutionCallId());
        assertThat(executions.compareAndSet(renewed,
                renewed.withResult(Map.of("executionStatus", "success", "responseParts", List.of()), 4, Instant.now()),
                "owner", 1).getState()).isEqualTo(ToolExecutionRecord.State.SETTLED);
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
        jdbc.update("UPDATE qwen_managed_session_journal_head SET latest_checkpoint_resource_id = NULL");
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
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_journal_tx", Integer.class)).isEqualTo(3);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_resource", Integer.class)).isEqualTo(3);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_resource_ref", Integer.class)).isEqualTo(4);
    }

    @Test
    void lateJournalFailureRollsBackPinVersionHeadAndOriginalResourceReference() throws Exception {
        commit(0);
        var before = head();
        jdbc.execute("ALTER TABLE qwen_managed_session_journal_tx ADD CONSTRAINT owned_reject_install CHECK (journal_revision < 2)");
        assertThatThrownBy(() -> commit(1)).isInstanceOf(org.springframework.dao.DataIntegrityViolationException.class);
        assertThat(pin()).isNull();
        assertThat(head()).isEqualTo(before);
        assertThat(bindings.findById(binding.getBindingId()).getVersion()).isEqualTo(binding.getVersion());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_journal_tx", Integer.class)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_resource", Integer.class)).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_resource_ref", Integer.class)).isEqualTo(2);
    }

    @Test
    void selectedAdmissionDispatchAndContinuationConsumeOriginalLivePin() throws Exception {
        var runtime = bindings.admitSession(sessions, new RuntimeSessionRecord(
                new RuntimeSession(sessionId, sessionId, "bootstrap", request.getScope()), binding.getBindingId(), 1,
                RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
        sessions.compareAndSet(runtime, runtime.withState(RuntimeSessionRecord.State.READY, Instant.now()));
        var candidate = ToolExecutionRecord.prepared("original-call", "original-key", binding.getBindingId(), 1,
                sessionId, sessionId, "file-turn", "file-call", "sha256:" + "a".repeat(64), Map.of("dispatchMode", "deferred",
                        "sessionId", sessionId, "promptId", "file-turn", "callId", "file-call", "argsDigest", "sha256:" + "a".repeat(64)));
        rejected(() -> bindings.admitExecution(sessions, executions, candidate), "csi_original_activation_unavailable");
        rejected(() -> executions.findOrCreate(candidate), "csi_execution_writer_not_qualified");
        commit(0);
        commit(1);
        var admitted = bindings.admitExecution(sessions, executions, candidate);
        assertThat(admitted.getState()).isEqualTo(ToolExecutionRecord.State.PREPARED);
        var claimed = executions.claimDispatch(candidate.getExecutionCallId(), "owner", Duration.ofSeconds(120));
        assertThat(claimed.getState()).isEqualTo(ToolExecutionRecord.State.DISPATCHING);
        var authorized = bindings.authorizeDispatch(sessions, executions, claimed, "owner", claimed.getDispatchGeneration());
        assertThat(authorized.getAuthorizedBindingVersion()).isEqualTo(binding.getVersion() + 1);
        rejected(() -> executions.compareAndSet(authorized, authorized, "owner", authorized.getDispatchGeneration()),
                "csi_execution_continuation_unavailable");
        var renewed = executions.renewDispatch(candidate.getExecutionCallId(), "owner", authorized.getDispatchGeneration(),
                Duration.ofSeconds(120));
        assertThat(renewed.getAuthorizedBindingVersion()).isEqualTo(authorized.getAuthorizedBindingVersion());
        var cancelled = executions.requestCancel(candidate.getExecutionCallId(), renewed.getVersion());
        assertThat(cancelled.getState()).isEqualTo(ToolExecutionRecord.State.CANCEL_REQUESTED);
        reservations.beginRetirement(registration, bindings, bindings.findById(binding.getBindingId()),
                reservation, UUID.randomUUID().toString());
        assertThat(executions.claimDispatch(candidate.getExecutionCallId(), "owner", Duration.ofSeconds(120)).getVersion())
                .isEqualTo(cancelled.getVersion());
        rejected(() -> bindings.admitExecution(sessions, executions, candidate), "runtime_admission_closed");
        assertThat(executions.findByExecutionCallId(candidate.getExecutionCallId()).getVersion()).isEqualTo(cancelled.getVersion());
    }

    @Test
    void missingPinnedOriginalReferenceBlocksSelectedAdmissionWithoutNewExecution() throws Exception {
        commit(0);
        commit(1);
        jdbc.update("DELETE FROM qwen_managed_session_resource_ref WHERE journal_revision = 2");
        var candidate = ToolExecutionRecord.prepared("missing-ref-call", "missing-ref-key", binding.getBindingId(), 1,
                sessionId, sessionId, "turn", "call", "sha256:" + "b".repeat(64), Map.of("dispatchMode", "deferred", "sessionId", sessionId,
                        "promptId", "turn", "callId", "call", "argsDigest", "sha256:" + "b".repeat(64)));
        rejected(() -> bindings.admitExecution(sessions, executions, candidate), "csi_original_activation_unavailable");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_tool_execution", Integer.class)).isZero();
        assertThat(pin()).isEqualTo(2);
    }

    @Test
    void claimRequiresCurrentReadyRuntimeSessionBeforeChangingExecution() throws Exception {
        var acquiring = bindings.admitSession(sessions, new RuntimeSessionRecord(
                new RuntimeSession(sessionId, sessionId, "bootstrap", request.getScope()), binding.getBindingId(), 1,
                RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
        var runtime = sessions.compareAndSet(acquiring, acquiring.withState(RuntimeSessionRecord.State.READY, Instant.now()));
        commit(0);
        commit(1);
        var candidate = ToolExecutionRecord.prepared("failed-session-call", "failed-session-key", binding.getBindingId(), 1,
                sessionId, sessionId, "turn", "call", "sha256:" + "d".repeat(64), Map.of("dispatchMode", "deferred", "sessionId", sessionId,
                        "promptId", "turn", "callId", "call", "argsDigest", "sha256:" + "d".repeat(64)));
        var admitted = bindings.admitExecution(sessions, executions, candidate);
        assertThat(sessions.compareAndSet(runtime, runtime.withState(RuntimeSessionRecord.State.FAILED, Instant.now()))).isNotNull();
        rejected(() -> executions.claimDispatch(candidate.getExecutionCallId(), "owner", Duration.ofSeconds(120)),
                "runtime_admission_closed");
        var unchanged = executions.findByExecutionCallId(candidate.getExecutionCallId());
        assertThat(unchanged.getState()).isEqualTo(ToolExecutionRecord.State.PREPARED);
        assertThat(unchanged.getDispatchGeneration()).isZero();
        assertThat(unchanged.getVersion()).isEqualTo(admitted.getVersion());
        assertThat(unchanged.getAuthorizedDispatchGeneration()).isNull();
    }

    @Test
    void drainingKeepsOriginalRenewCancelAndResultButClosesNewGrant() throws Exception {
        ready();
        var prepared = admit("started");
        var pending = admit("pending");
        var executing = authorize(prepared);
        retire();
        rejected(() -> executions.claimDispatch(pending.getExecutionCallId(), "owner", Duration.ofSeconds(120)),
                "runtime_admission_closed");
        assertThat(executions.renewDispatch(executing.getExecutionCallId(), "foreign", 1, Duration.ofSeconds(120))).isNull();
        assertThat(executions.renewDispatch(executing.getExecutionCallId(), "owner", 2, Duration.ofSeconds(120))).isNull();
        var renewed = executions.renewDispatch(executing.getExecutionCallId(), "owner", 1, Duration.ofSeconds(120));
        assertThat(renewed.getVersion()).isEqualTo(executing.getVersion() + 1);
        assertThat(executions.compareAndSet(executing, executing.withUnknown(), "owner", 1)).isNull();
        var cancel = executions.requestCancel(renewed.getExecutionCallId(), renewed.getVersion());
        assertThat(cancel.getState()).isEqualTo(ToolExecutionRecord.State.CANCEL_REQUESTED);
        assertThat(executions.requestCancel(cancel.getExecutionCallId(), cancel.getVersion()).getVersion()).isEqualTo(cancel.getVersion());
        var settled = executions.compareAndSet(cancel,
                cancel.withResult(Map.of("executionStatus", "success", "responseParts", List.of()), 4, Instant.now()), "owner", 1);
        assertThat(settled.getState()).isEqualTo(ToolExecutionRecord.State.SETTLED);
        assertThat(settled.getAuthorizedBindingVersion()).isEqualTo(executing.getAuthorizedBindingVersion());
        assertThat(settled.getAuthorizedDispatchGeneration()).isEqualTo(1);
        assertThat(settled.getDispatchOwner()).isEqualTo("owner");
        assertThat(settled.isCancelRequested()).isTrue();
        assertThat(settled.getLastSequence()).isEqualTo(4);
        assertThat(executions.claimDispatch(settled.getExecutionCallId(), "owner", Duration.ofSeconds(120))).isNull();
    }

    @Test
    void preAuthorizationCancelSettlesNotStartedWithoutMintingAuthorization() throws Exception {
        ready();
        var prepared = admit("prepared-cancel");
        var dispatching = executions.claimDispatch(admit("dispatching-cancel").getExecutionCallId(), "owner", Duration.ofSeconds(120));
        retire();
        for (var original : List.of(prepared, dispatching)) {
            var cancelled = executions.requestCancel(original.getExecutionCallId(), original.getVersion());
            assertThat(cancelled.getState()).isEqualTo(ToolExecutionRecord.State.SETTLED);
            assertThat(cancelled.getResult()).isEqualTo(Map.of("executionStatus", "not_started", "responseParts", List.of()));
            assertThat(cancelled.getAuthorizedDispatchGeneration()).isNull();
            assertThat(cancelled.getAuthorizedBindingVersion()).isNull();
            assertThat(cancelled.getDispatchGeneration()).isEqualTo(original.getDispatchGeneration());
            assertThat(cancelled.isCancelRequested()).isTrue();
            assertThat(executions.claimDispatch(cancelled.getExecutionCallId(), "owner", Duration.ofSeconds(120))).isNull();
        }
    }

    @Test
    void expiredOriginalFencesUnknownWithoutRegrantOrReconciliation() throws Exception {
        ready();
        var executing = authorize(admit("expired"));
        retire();
        jdbc.update("UPDATE qwen_tool_execution SET dispatch_lease_until = TIMESTAMP '2000-01-01 00:00:00'");
        assertThat(executions.renewDispatch(executing.getExecutionCallId(), "owner", 1, Duration.ofSeconds(120))).isNull();
        assertThat(executions.claimDispatch(executing.getExecutionCallId(), "replacement", Duration.ofSeconds(120))).isNull();
        var unknown = executions.findByExecutionCallId(executing.getExecutionCallId());
        assertThat(unknown.getState()).isEqualTo(ToolExecutionRecord.State.UNKNOWN);
        assertThat(unknown.getDispatchOwner()).isEqualTo("owner");
        assertThat(unknown.getDispatchGeneration()).isEqualTo(1);
        assertThat(unknown.getAuthorizedBindingVersion()).isEqualTo(executing.getAuthorizedBindingVersion());
        var cancelled = executions.requestCancel(unknown.getExecutionCallId(), unknown.getVersion());
        assertThat(cancelled.getState()).isEqualTo(ToolExecutionRecord.State.UNKNOWN);
        assertThat(cancelled.getResult()).isNull();
        rejected(() -> executions.resolveUnknown(cancelled, Map.of("executionStatus", "success"), Instant.now()),
                "csi_execution_writer_not_qualified");
    }

    @Test
    void immutableSealStillRejectsLateAuthorizationAfterBindingOperationVersionAdvances() throws Exception {
        ready();
        var executing = authorize(admit("sealed"));
        var retirement = retire();
        var operation = bindings.claimOperation(binding.getBindingId(), "operator", Duration.ofSeconds(120));
        var advanced = bindings.renewOperation(binding.getBindingId(), "operator", operation.getOperationGeneration(), Duration.ofSeconds(120));
        assertThat(advanced.getVersion()).isGreaterThan(retirement.sealedBindingVersion());
        jdbc.update("UPDATE qwen_tool_execution SET authorized_binding_version = ?", retirement.sealedBindingVersion());
        var before = executionRows();
        rejected(() -> executions.renewDispatch(executing.getExecutionCallId(), "owner", 1, Duration.ofSeconds(120)),
                "csi_execution_continuation_unavailable");
        assertThat(executionRows()).isEqualTo(before);
        jdbc.update("UPDATE qwen_tool_execution SET authorized_binding_version = ?", executing.getAuthorizedBindingVersion());
        assertThat(executions.renewDispatch(executing.getExecutionCallId(), "owner", 1, Duration.ofSeconds(120))).isNotNull();
    }

    @Test
    void corruptRetirementIdentityRefusesBeforeExecutionMutation() throws Exception {
        ready();
        var executing = authorize(admit("corrupt-intent"));
        var retirement = retire();
        String encoded = jdbc.queryForObject("SELECT identity_json FROM managed_workspace_csi_retirement", String.class);
        for (String corrupt : List.of(encoded + " {}", encoded.replaceFirst("\\{", "{\"unexpected\":true,"),
                encoded.replaceFirst("\\{", "{\"phase\":\"DRAINING\","),
                encoded.replace("\"sealedBindingVersion\":" + retirement.sealedBindingVersion(), "\"sealedBindingVersion\":0"),
                encoded.replace("\"revision\":1", "\"revision\":2"),
                encoded.replace("\"sealedBindingVersion\":" + retirement.sealedBindingVersion(), "\"sealedBindingVersion\":3.1"),
                encoded.replace("\"sealedBindingVersion\":" + retirement.sealedBindingVersion(), "\"sealedBindingVersion\":\"3\""),
                encoded.replace(retirement.startedAt(), "invalid-time"), " ".repeat(256 * 1024 + 1))) {
            jdbc.update("UPDATE managed_workspace_csi_retirement SET identity_json = ?", corrupt);
            var before = executionRows();
            rejected(() -> executions.requestCancel(executing.getExecutionCallId(), executing.getVersion()),
                    "csi_retirement_identity_unavailable");
            assertThat(executionRows()).isEqualTo(before);
        }
        jdbc.update("UPDATE managed_workspace_csi_retirement SET identity_json = ?", encoded);
        jdbc.update("UPDATE managed_workspace_execution_lease SET csi_revision = 3");
        rejected(() -> executions.renewDispatch(executing.getExecutionCallId(), "owner", 1, Duration.ofSeconds(120)),
                "csi_retirement_identity_unavailable");
    }

    @Test
    void currentSessionAndNativeLeaseLossRefuseContinuationWithoutChangingExecution() throws Exception {
        ready();
        var executing = authorize(admit("proof-loss"));
        var runtime = sessions.findById(request.getScope(), sessionId);
        sessions.compareAndSet(runtime, runtime.withState(RuntimeSessionRecord.State.FAILED, Instant.now()));
        var before = executionRows();
        rejected(() -> executions.requestCancel(executing.getExecutionCallId(), executing.getVersion()), "runtime_admission_closed");
        assertThat(executionRows()).isEqualTo(before);
        jdbc.update("UPDATE qwen_runtime_session SET session_state = 'READY'");
        jdbc.update("UPDATE qwen_managed_session_journal_head SET writer_lease_until = TIMESTAMP '2000-01-01 00:00:00'");
        rejected(() -> executions.compareAndSet(executing, executing.withUnknown(), "owner", 1), "csi_original_activation_unavailable");
        assertThat(executionRows()).isEqualTo(before);
    }

    @Test
    void privateLostRecoveryCannotAbandonExecutionOrClearOriginalSlot() throws Exception {
        ready();
        authorize(admit("lost-original"));
        jdbc.update("UPDATE qwen_runtime_binding SET binding_state = 'LOST'");
        var lost = bindings.findById(binding.getBindingId());
        var before = executionRows();
        var runtimeBefore = jdbc.queryForList("SELECT * FROM qwen_runtime_session");
        var slotBefore = jdbc.queryForList("SELECT * FROM qwen_runtime_binding_slot");
        rejected(() -> bindings.recoverLost(sessions, executions, lost), "csi_finalize_required");
        rejected(() -> bindings.finishLostRecovery(sessions, executions, lost), "csi_finalize_required");
        assertThat(executionRows()).isEqualTo(before);
        assertThat(jdbc.queryForList("SELECT * FROM qwen_runtime_session")).isEqualTo(runtimeBefore);
        assertThat(jdbc.queryForList("SELECT * FROM qwen_runtime_binding_slot")).isEqualTo(slotBefore);
        assertThat(bindings.findById(binding.getBindingId()).getVersion()).isEqualTo(lost.getVersion());
    }

    @Test
    void missingZeroAndFutureAuthorizationCannotUseOriginalContinuation() throws Exception {
        ready();
        var executing = authorize(admit("unqualified-authorization"));
        for (long version : List.of(0L, bindings.findById(binding.getBindingId()).getVersion() + 1)) {
            jdbc.update("UPDATE qwen_tool_execution SET authorized_binding_version = ?", version);
            var before = executionRows();
            rejected(() -> executions.requestCancel(executing.getExecutionCallId(), executing.getVersion()),
                    "csi_execution_continuation_unavailable");
            assertThat(executionRows()).isEqualTo(before);
        }
        jdbc.update("UPDATE qwen_tool_execution SET authorized_binding_version = NULL, authorized_dispatch_generation = NULL");
        var before = executionRows();
        rejected(() -> executions.claimDispatch(executing.getExecutionCallId(), "owner", Duration.ofSeconds(120)),
                "csi_execution_continuation_unavailable");
        assertThat(executionRows()).isEqualTo(before);
    }

    @Test
    void nonV2ReferenceCannotUsePrivateContinuation() throws Exception {
        ready();
        var executing = authorize(admit("non-file-mode"));
        var reference = new java.util.LinkedHashMap<>(executing.getReference());
        reference.put("runtimeProtocol", 3);
        jdbc.update("UPDATE qwen_tool_execution SET reference_json = ?", JSON.writeValueAsString(reference));
        var before = executionRows();
        rejected(() -> executions.requestCancel(executing.getExecutionCallId(), executing.getVersion()),
                "csi_execution_continuation_unavailable");
        assertThat(executionRows()).isEqualTo(before);
    }

    @Test
    void absentSnapshotCannotAdoptLaterOriginalExecution() throws Exception {
        ready();
        for (String action : List.of("claim", "renew", "cancel", "result")) {
            jdbc.update("UPDATE qwen_runtime_session SET session_state = 'READY'");
            try (var snapshot = jdbc.getDataSource().getConnection()) {
                snapshot.setTransactionIsolation(Connection.TRANSACTION_REPEATABLE_READ);
                snapshot.setAutoCommit(false);
                try (var query = snapshot.prepareStatement("SELECT COUNT(*) FROM qwen_tool_execution WHERE execution_call_id = ?")) {
                    query.setString(1, "late-" + action);
                    try (var row = query.executeQuery()) {
                        assertThat(row.next()).isTrue();
                        assertThat(row.getInt(1)).isZero();
                    }
                }
                var original = authorize(admit("late-" + action));
                var runtime = sessions.findById(request.getScope(), sessionId);
                assertThat(sessions.compareAndSet(runtime,
                        runtime.withState(RuntimeSessionRecord.State.FAILED, Instant.now()))).isNotNull();
                var before = executionRows();
                var delayed = new JdbcToolExecutionRepository(new SingleConnectionDataSource(snapshot, false));
                var result = switch (action) {
                    case "claim" -> delayed.claimDispatch(original.getExecutionCallId(), "owner", Duration.ofSeconds(120));
                    case "renew" -> delayed.renewDispatch(original.getExecutionCallId(), "owner", 1, Duration.ofSeconds(120));
                    case "cancel" -> delayed.requestCancel(original.getExecutionCallId(), original.getVersion());
                    case "result" -> delayed.compareAndSet(original,
                            original.withResult(Map.of("executionStatus", "success", "responseParts", List.of()), 4, Instant.now()), "owner", 1);
                    default -> throw new IllegalStateException(action);
                };
                assertThat(result).isNull();
                assertThat(executionRows()).isEqualTo(before);
            }
        }
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

    private ToolExecutionRecord authorize(ToolExecutionRecord prepared) {
        var claimed = executions.claimDispatch(prepared.getExecutionCallId(), "owner", Duration.ofSeconds(120));
        return bindings.authorizeDispatch(sessions, executions, claimed, "owner", claimed.getDispatchGeneration());
    }

    private WorkspaceCsiReservationStore.Retirement retire() {
        return reservations.beginRetirement(registration, bindings, bindings.findById(binding.getBindingId()), reservation, UUID.randomUUID().toString());
    }

    private List<Map<String, Object>> executionRows() {
        return jdbc.queryForList("SELECT * FROM qwen_tool_execution ORDER BY execution_call_id_hash");
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
        request.put("eventsDigest", CsiNativeActivationProof.sha256(JSON.writeValueAsBytes(events)));
        ObjectNode marker = (ObjectNode) records.getLast().path("managedSession");
        marker.put("contentDigest", request.path("contentDigest").textValue())
                .put("eventsDigest", request.path("eventsDigest").textValue());
        request.put("commitDigest", CsiNativeActivationProof.sha256(JSON.writeValueAsBytes(sorted(marker))));
        StringBuilder text = new StringBuilder();
        for (JsonNode record : records) {
            text.append(JSON.writeValueAsString(record)).append('\n');
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
        for (String table : List.of("qwen_managed_session_journal_head", "qwen_managed_session_journal_tx",
                "qwen_managed_session_resource", "qwen_managed_session_resource_ref", "qwen_runtime_binding",
                "managed_agent_session", "qwen_runtime_session", "qwen_tool_execution",
                "managed_workspace_execution_lease", "managed_workspace_csi_retirement")) {
            rows.put(table, jdbc.queryForList("SELECT * FROM " + table).stream()
                    .map(row -> JSON.valueToTree(new TreeMap<>(row)).toString()).sorted().toList());
        }
        return rows;
    }

    @Test
    void pinNullWithCommittedActivationHistoryCannotBeRepairedByRenewal() throws Exception {
        commit(0);
        commit(1);
        jdbc.update("UPDATE qwen_runtime_binding SET first_activation_journal_revision = NULL");
        var before = head();
        assertThatThrownBy(() -> commit(2)).isInstanceOfSatisfying(RuntimeBrokerException.class,
                error -> assertThat(error.getCode()).isEqualTo("csi_original_activation_unavailable"));
        assertThat(pin()).isNull();
        assertThat(head()).isEqualTo(before);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_journal_tx", Integer.class)).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_resource_ref", Integer.class)).isEqualTo(3);
    }

    @Test
    void priorTerminalAuthorizationRefusesFirstPinAndRollsBackInstallResource() throws Exception {
        commit(0);
        var historical = ToolExecutionRecord.prepared("prior-call", "prior-key", "owned-legacy-binding", 1,
                sessionId, sessionId, "prior-turn", "prior-tool", "sha256:" + "c".repeat(64), Map.of("dispatchMode", "deferred", "sessionId", sessionId,
                        "promptId", "prior-turn", "callId", "prior-tool", "argsDigest", "sha256:" + "c".repeat(64)));
        executions.findOrCreate(historical);
        jdbc.update("UPDATE qwen_tool_execution SET binding_id = ?, execution_state = 'SETTLED',"
                + " execution_status = 'success', dispatch_generation = 1, authorized_dispatch_generation = 1,"
                + " authorized_binding_version = ?", binding.getBindingId(), binding.getVersion());
        var before = head();
        assertThatThrownBy(() -> commit(1)).isInstanceOfSatisfying(RuntimeBrokerException.class,
                error -> assertThat(error.getCode()).isEqualTo("csi_original_activation_unavailable"));
        assertThat(pin()).isNull();
        assertThat(head()).isEqualTo(before);
        assertThat(bindings.findById(binding.getBindingId()).getVersion()).isEqualTo(binding.getVersion());
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_resource", Integer.class)).isEqualTo(2);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM qwen_managed_session_resource_ref", Integer.class)).isEqualTo(2);
    }

    private Long pin() {
        return jdbc.queryForObject("SELECT first_activation_journal_revision FROM qwen_runtime_binding WHERE binding_id = ?",
                Long.class, binding.getBindingId());
    }

    private List<Map<String, Object>> head() {
        return jdbc.queryForList("SELECT * FROM qwen_managed_session_journal_head");
    }

    private void generate() throws Exception {
        Path root = Path.of("../../..").toRealPath();
        Path input = directory.resolve("input.json");
        var value = JSON.createObjectNode().put("cwd", request.getScope().getCanonicalCwd())
                .put("capabilityDigest", CsiFilesRetirementProfile.CAPABILITY_DIGEST);
        value.putObject("sessionKey").put("tenantId", "tenant").put("workspaceId", "workspace").put("sessionId", sessionId);
        JSON.writeValue(input.toFile(), value);
        Path generator = directory.resolve("generator.mjs");
        try (var stream = getClass().getResourceAsStream("/csi-native-activation-generator.mjs")) {
            assertThat(stream).isNotNull();
            Files.copy(stream, generator);
        }
        Path log = directory.resolve("generator.log");
        Process process = new ProcessBuilder("node", generator.toString(), input.toString(), directory.toString())
                .directory(root.toFile()).redirectErrorStream(true).redirectOutput(log.toFile()).start();
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
