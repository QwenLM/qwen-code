package com.alibaba.qwen.code.managedagent.store;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.runtimebroker.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
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
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;
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
    void selectedAdmissionAndDispatchConsumeOriginalLivePinWhileDirectMutationRefuses() throws Exception {
        var runtime = bindings.admitSession(sessions, new RuntimeSessionRecord(
                new RuntimeSession(sessionId, sessionId, "bootstrap", request.getScope()), binding.getBindingId(), 1,
                RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
        sessions.compareAndSet(runtime, runtime.withState(RuntimeSessionRecord.State.READY, Instant.now()));
        var candidate = ToolExecutionRecord.prepared("original-call", "original-key", binding.getBindingId(), 1,
                sessionId, sessionId, "file-turn", "file-call", "a".repeat(64), Map.of("tool", "read_file",
                        "sessionId", sessionId, "promptId", "file-turn", "callId", "file-call", "argsDigest", "a".repeat(64)));
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
                "csi_execution_writer_not_qualified");
        rejected(() -> executions.renewDispatch(candidate.getExecutionCallId(), "owner", authorized.getDispatchGeneration(),
                Duration.ofSeconds(120)), "csi_execution_writer_not_qualified");
        rejected(() -> executions.requestCancel(candidate.getExecutionCallId(), authorized.getVersion()),
                "csi_execution_writer_not_qualified");
        reservations.beginRetirement(registration, bindings, bindings.findById(binding.getBindingId()),
                reservation, UUID.randomUUID().toString());
        rejected(() -> executions.claimDispatch(candidate.getExecutionCallId(), "owner", Duration.ofSeconds(120)),
                "runtime_admission_closed");
        rejected(() -> bindings.admitExecution(sessions, executions, candidate), "runtime_admission_closed");
        assertThat(executions.findByExecutionCallId(candidate.getExecutionCallId()).getVersion()).isEqualTo(authorized.getVersion());
    }

    @Test
    void missingPinnedOriginalReferenceBlocksSelectedAdmissionWithoutNewExecution() throws Exception {
        commit(0);
        commit(1);
        jdbc.update("DELETE FROM qwen_managed_session_resource_ref WHERE journal_revision = 2");
        var candidate = ToolExecutionRecord.prepared("missing-ref-call", "missing-ref-key", binding.getBindingId(), 1,
                sessionId, sessionId, "turn", "call", "b".repeat(64), Map.of("sessionId", sessionId,
                        "promptId", "turn", "callId", "call", "argsDigest", "b".repeat(64)));
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
                sessionId, sessionId, "turn", "call", "d".repeat(64), Map.of("sessionId", sessionId,
                        "promptId", "turn", "callId", "call", "argsDigest", "d".repeat(64)));
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

    private ManagedSessionStoreModels.CommitReceipt commit(int index) throws Exception {
        var value = JSON.treeToValue(nativeFixture.path("commits").get(index).path("request"),
                ManagedSessionStoreModels.CommitTransactionRequest.class);
        return transaction.execute(status -> journal.commit("tenant", sessionId, token, value));
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
                sessionId, sessionId, "prior-turn", "prior-tool", "c".repeat(64), Map.of("sessionId", sessionId,
                        "promptId", "prior-turn", "callId", "prior-tool", "argsDigest", "c".repeat(64)));
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
