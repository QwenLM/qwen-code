package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.adapter.security.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.provisioning.external.ExternalWorkspaceProvisioner;
import com.alibaba.qwen.code.runtimebroker.spi.ExternalRuntimeClient;
import com.alibaba.qwen.code.runtimebroker.spi.ExternalWorkspaceRecoveryGateway;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;

class ExternalWorkspaceRetirementServiceTest {
    private ManagedSchemaJdbcTemplate jdbc;
    private JdbcRuntimeBindingRepository bindings;
    private JdbcRuntimeSessionRepository sessions;
    private JdbcToolExecutionRepository executions;
    private WorkspaceExecutionStore ownership;
    private ExternalWorkspaceProvisioner provider;
    private RuntimeBindingRecord original;
    private RuntimeProvisionRequest placement;
    private ExternalWorkspaceRetirementService service;
    private ExternalWorkspaceRetirementService.Request request;

    @BeforeEach
    void setUp() throws Exception {
        var source = new DriverManagerDataSource("jdbc:h2:mem:external-retirement-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1", "sa", "");
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        var registration = new ExternalStorageRegistrationStore(jdbc, manager);
        new ExternalWorkspaceRegistrationService(registration, new ExternalWorkspaceMaterializationStore(jdbc, manager))
                .ensureEphemeralRegistered("tenant", "owner", "register", new EphemeralWorkspaceRegistration(
                        "provider", "workspace", "/var/lib/managed-workspace", 1), "Personal");
        for (String id : List.of("user-session", "empty-probe", "completed-turn-session")) {
            jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, title, gmt_create, gmt_modified, workspace_id,"
                    + " workspace_generation, workspace_storage_id, cwd_relative, context_config_ref, context_revision,"
                    + " workspace_config_ref, workspace_policy_ref, tool_profile, creator_actor_key)"
                    + " VALUES ('tenant', ?, 'qwen-code', ?, 1, 1, 'workspace', 1, 'workspace', '.', ?, 1, ?, ?, ?, ?)",
                    id, id, WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, WorkspaceExecutionProfile.CONFIG_REF,
                    WorkspaceExecutionProfile.POLICY_REF, "hosted-workspace-external-files/1", com.alibaba.qwen.code.managedagent.repository.ManagedWorkspaceRegistry.actorKey("tenant", "owner"));
        }
        bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
        sessions = new JdbcRuntimeSessionRepository(source);
        executions = new JdbcToolExecutionRepository(source);
        ownership = new WorkspaceExecutionStore(jdbc, manager);
        placement = new RuntimeProvisionRequest(new RuntimeScope("tenant", "workspace", "1", "/var/lib/managed-workspace",
                WorkspaceExecutionProfile.CAPABILITY_DIGEST, "workspace"), null, "external-workspace", "workspace");
        original = bindings.findOrCreate(placement);
        original = bindings.claimOperation(original.getBindingId(), "initial", Duration.ofMinutes(1));
        provider = new ExternalWorkspaceProvisioner(mock(ExternalRuntimeClient.class), registration, "provider", Duration.ofSeconds(1));
        var handle = provider.ensureResource(placement, original.getProvisionSeed(), null).toCompletableFuture().get();
        original = bindings.compareAndSet(original, original.withResourceHandle(handle, Instant.now())
                .withState(RuntimeBindingRecord.State.RECOVERY_BLOCKED, null, Instant.now()));
        original = bindings.releaseOperation(original.getBindingId(), "initial", original.getOperationGeneration());
        var recoveryGateway = mock(ExternalWorkspaceRecoveryGateway.class);
        doAnswer(invocation -> {
            provider.validateTerminalOriginal(invocation.getArgument(0));
            return null;
        })
                .when(recoveryGateway).validateExternalTerminalOriginal(any());
        service = new ExternalWorkspaceRetirementService(jdbc, manager, bindings, registration,
                new ManagedWorkspaceRegistry(jdbc), recoveryGateway, new ObjectMapper().findAndRegisterModules());
        request = new ExternalWorkspaceRetirementService.Request("tenant", "owner", "workspace", 1,
                original.getBindingId(), original.getGeneration(), original.getVersion(), UUID.randomUUID().toString());
    }

    @AfterEach
    void close() {
        if (provider != null) {
            provider.close();
        }
    }

    private ExternalWorkspaceRetirementService.TerminationProof terminated(ExternalWorkspaceRetirementService.Identity identity) {
        return new ExternalWorkspaceRetirementService.TerminationProof(identity, "sandbox-original", "Terminated",
                Instant.now(), "audit-original", "a".repeat(64));
    }

    @Test
    void preservesActiveSessionsAndMakesRetirementReplayIndependentOfNextGeneration() {
        var first = service.retire(request, this::terminated);
        assertThat(first.resumed()).isFalse();
        assertThat(first.state()).isEqualTo("RELEASED");
        assertThat(jdbc.queryForList("SELECT status FROM ma_session ORDER BY session_id", String.class))
                .containsExactly("ACTIVE", "ACTIVE", "ACTIVE");
        assertThat(jdbc.queryForObject("SELECT state FROM ma_workspace", String.class)).isEqualTo("DRAINING");
        assertThat(service.retire(request, ignored -> { throw new AssertionError("No repeated provider observation"); })).isEqualTo(first);
        var resumed = service.resume(request, first.proofDigest());
        assertThat(resumed.resumed()).isTrue();
        var next = bindings.findOrCreate(placement);
        assertThat(next.getGeneration()).isEqualTo(original.getGeneration() + 1);
        assertThat(service.retire(request, ignored -> { throw new AssertionError("Do not retire the replacement"); })).isEqualTo(resumed);
        assertThat(service.resume(request, first.proofDigest())).isEqualTo(resumed);
        assertThat(bindings.findActive(placement).getBindingId()).isEqualTo(next.getBindingId());
    }

    @Test
    void readyHistoryWithSettledToolReleasedSessionAndExactHolderRetiresOnce() {
        var observations = new AtomicInteger();
        makeReady();
        var runtime = claimExactHolder(runtimeSession(RuntimeSessionRecord.State.READY));
        settleTool(runtime);
        var owner = jdbc.queryForMap("SELECT * FROM ma_storage_owner");
        assertThat(owner.get("holder_key")).isNotNull();
        assertThat(owner.get("binding_id")).isEqualTo(original.getBindingId());
        assertThat(owner.get("runtime_generation")).isEqualTo(original.getGeneration());

        var first = service.retire(request, identity -> {
            observations.incrementAndGet();
            return terminated(identity);
        });

        assertThat(first.state()).isEqualTo("RELEASED");
        assertThat(first.resumed()).isFalse();
        assertThat(bindings.findById(original.getBindingId()).getState())
                .isEqualTo(RuntimeBindingRecord.State.RELEASED);
        assertThat(jdbc.queryForMap("SELECT holder_key, binding_id, runtime_generation, runtime_session_id"
                + " FROM ma_storage_owner").values()).containsOnlyNulls();
        assertThat(jdbc.queryForMap("SELECT tenant_id, storage_id, physical_key, mount_root, mount_revision"
                + " FROM ma_storage_owner")).isEqualTo(Map.of(
                        "tenant_id", owner.get("tenant_id"),
                        "storage_id", owner.get("storage_id"),
                        "physical_key", owner.get("physical_key"),
                        "mount_root", owner.get("mount_root"),
                        "mount_revision", owner.get("mount_revision")));
        assertThat(executions.findByIdempotencyKey("tool-key").getState())
                .isEqualTo(ToolExecutionRecord.State.SETTLED);
        assertThat(sessions.findById(placement.getScope(), runtime.getRuntimeSessionId()).getState())
                .isEqualTo(RuntimeSessionRecord.State.RELEASED);
        assertThat(jdbc.queryForList("SELECT status FROM ma_session ORDER BY session_id", String.class))
                .containsExactly("ACTIVE", "ACTIVE", "ACTIVE");

        assertThat(service.retire(request, identity -> {
            throw new AssertionError("A committed retirement must not observe the platform again");
        })).isEqualTo(first);
        assertThat(observations).hasValue(1);
        var resumed = service.resume(request, first.proofDigest());
        assertThat(resumed.resumed()).isTrue();
        var next = bindings.findOrCreate(placement);
        assertThat(next.getGeneration()).isEqualTo(original.getGeneration() + 1);
        assertThat(next.getBindingId()).isNotEqualTo(original.getBindingId());
        assertThat(bindings.findActive(placement).getBindingId()).isEqualTo(next.getBindingId());
        assertThat(service.retire(request, identity -> {
            throw new AssertionError("The old retirement must not retire its replacement");
        })).isEqualTo(resumed);
        assertThat(observations).hasValue(1);
    }

    @Test
    void nonterminalToolPreventsEveryRetirementWrite() {
        makeReady();
        var runtime = claimExactHolder(runtimeSession(RuntimeSessionRecord.State.READY));
        var prepared = executions.findOrCreate(preparedTool(runtime));
        var before = durableState();
        var observations = new AtomicInteger();

        assertThatThrownBy(() -> service.retire(request, identity -> {
            observations.incrementAndGet();
            return terminated(identity);
        })).isInstanceOf(RuntimeBrokerException.class);

        assertThat(durableState()).isEqualTo(before);
        assertThat(executions.findByIdempotencyKey(prepared.getIdempotencyKey()).getState())
                .isEqualTo(ToolExecutionRecord.State.PREPARED);
        assertThat(service.inspect(request)).isNull();
        assertThat(observations).hasValue(1);
    }

    @Test
    void nonterminalRuntimeSessionPreventsEveryRetirementWrite() {
        makeReady();
        claimExactHolder(runtimeSession(RuntimeSessionRecord.State.READY));
        var active = sessions.findOrCreate(new RuntimeSessionRecord(new RuntimeSession(
                "empty-probe", "active-runtime-child", "bootstrap", placement.getScope()),
                original.getBindingId(), original.getGeneration(),
                RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
        active = sessions.compareAndSet(active, active.withState(
                RuntimeSessionRecord.State.READY, Instant.now()));
        var activeId = active.getRuntimeSessionId();
        var before = durableState();

        assertThatThrownBy(() -> service.retire(request, this::terminated))
                .isInstanceOf(RuntimeBrokerException.class);

        assertThat(durableState()).isEqualTo(before);
        assertThat(sessions.findById(placement.getScope(), activeId).getState())
                .isEqualTo(RuntimeSessionRecord.State.READY);
        assertThat(service.inspect(request)).isNull();
    }

    @Test
    void holderForACompetingBindingIsNeitherClearedNorRetired() {
        makeReady();
        claimExactHolder(runtimeSession(RuntimeSessionRecord.State.READY));
        jdbc.update("UPDATE ma_storage_owner SET binding_id = ?, runtime_generation = ?",
                "competing-binding", original.getGeneration());
        var before = durableState();

        assertThatThrownBy(() -> service.retire(request, this::terminated))
                .isInstanceOf(RuntimeBrokerException.class);

        assertThat(durableState()).isEqualTo(before);
        assertThat(service.inspect(request)).isNull();
    }

    @Test
    void maintenanceHolderPreventsEveryRetirementWrite() {
        makeReady();
        claimExactHolder(runtimeSession(RuntimeSessionRecord.State.READY));
        jdbc.update("UPDATE ma_storage_owner SET maintenance_id = ?, maintenance_generation = ?",
                "a".repeat(32), 1);
        var before = durableState();

        assertThatThrownBy(() -> service.retire(request, this::terminated))
                .isInstanceOf(RuntimeBrokerException.class);

        assertThat(durableState()).isEqualTo(before);
        assertThat(service.inspect(request)).isNull();
    }

    private void makeReady() {
        assertThat(original.getState()).isEqualTo(RuntimeBindingRecord.State.RECOVERY_BLOCKED);
        original = bindings.claimOperation(original.getBindingId(), "attest", Duration.ofMinutes(1));
        var seed = original.getProvisionSeed();
        var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:19219"),
                seed.getToken(), seed.getLeaseId(), seed.getEpoch());
        original = bindings.compareAndSet(original, original.withAttestation(
                lease, original.getResourceHandle(), Instant.now(), Instant.now()));
        original = bindings.releaseOperation(
                original.getBindingId(), "attest", original.getOperationGeneration());
        assertThat(original.getState()).isEqualTo(RuntimeBindingRecord.State.READY);
        assertThat(original.getAttestationGeneration()).isPositive();
        assertThat(original.getLease()).isNotNull();
        request = requestForOriginal();
    }

    private RuntimeSessionRecord runtimeSession(RuntimeSessionRecord.State state) {
        var created = sessions.findOrCreate(new RuntimeSessionRecord(new RuntimeSession(
                "user-session", "runtime-child", "bootstrap", placement.getScope()),
                original.getBindingId(), original.getGeneration(),
                RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
        return sessions.compareAndSet(created, created.withState(state, Instant.now()));
    }

    private RuntimeSessionRecord claimExactHolder(RuntimeSessionRecord ready) {
        var context = new ContextBinding("tenant", "workspace", 1, "workspace", ".",
                WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1);
        ownership.claim(context, ready, original, bindings);
        ownership.release(context, ready, original, bindings);
        return sessions.compareAndSet(ready, ready.withState(
                RuntimeSessionRecord.State.RELEASED, Instant.now()));
    }

    private ToolExecutionRecord preparedTool(RuntimeSessionRecord runtime) {
        return ToolExecutionRecord.prepared(
                "tool-execution", "tool-key", original.getBindingId(), original.getGeneration(),
                "user-session", runtime.getRuntimeSessionId(), "turn", "tool-call", "digest",
                Map.of("sessionId", runtime.getRuntimeSessionId(), "promptId", "turn",
                        "callId", "tool-call", "argsDigest", "digest"));
    }

    private void settleTool(RuntimeSessionRecord runtime) {
        var prepared = executions.findOrCreate(preparedTool(runtime));
        var claimed = executions.claimDispatch(prepared.getExecutionCallId(), "dispatcher", Duration.ofMinutes(1));
        assertThat(claimed).isNotNull();
        assertThat(executions.compareAndSet(claimed, claimed.withResult(
                Map.of("executionStatus", "success"), 1, Instant.now()),
                "dispatcher", claimed.getDispatchGeneration()).getState())
                .isEqualTo(ToolExecutionRecord.State.SETTLED);
    }

    private ExternalWorkspaceRetirementService.Request requestForOriginal() {
        return new ExternalWorkspaceRetirementService.Request(
                "tenant", "owner", "workspace", 1, original.getBindingId(),
                original.getGeneration(), original.getVersion(), request.retirementId());
    }

    private Map<String, List<Map<String, Object>>> durableState() {
        var result = new LinkedHashMap<String, List<Map<String, Object>>>();
        for (String table : List.of("ma_workspace", "ma_runtime_binding", "ma_runtime_slot",
                "ma_runtime_session", "ma_tool_execution", "ma_storage_owner", "ma_operation")) {
            String order = switch (table) {
                case "ma_workspace" -> "workspace_id";
                case "ma_runtime_binding", "ma_runtime_session", "ma_storage_owner" -> "binding_id";
                case "ma_runtime_slot" -> "request_key";
                case "ma_tool_execution" -> "execution_call_id_hash";
                case "ma_operation" -> "operation_key";
                default -> throw new IllegalArgumentException(table);
            };
            result.put(table, WorkspaceOperations.rows(jdbc, "SELECT * FROM " + table + " ORDER BY " + order));
        }
        return result;
    }

    @Test
    void terminalFailedOperationWithBlockedDeliveryDoesNotFenceRetirement() {
        jdbc.update("INSERT INTO ma_operation (operation_key, scope_key, session_scope_key, operation_id, operation_kind,"
                + " tenant_id, session_id, target_kind, target_key, request_digest, request_json, state, phase, delivery_state,"
                + " gmt_create, gmt_modified) VALUES (?, ?, NULL, ?, 'SUBMIT_INPUT', ?, 'user-session', 'SESSION', ?,"
                + " 'digest', '{}', 'FAILED', 'FAILED', 'BLOCKED', 1, 1)",
                "a".repeat(64), "b".repeat(64), "turn-op".getBytes(),
                "tenant".getBytes(), "c".repeat(64));

        var receipt = service.retire(request, this::terminated);

        assertThat(receipt.state()).isEqualTo("RELEASED");
        assertThat(receipt.resumed()).isFalse();
        assertThat(bindings.findById(original.getBindingId()).getState())
                .isEqualTo(RuntimeBindingRecord.State.RELEASED);
        assertThat(service.resume(request, receipt.proofDigest()).resumed()).isTrue();
        var replacement = bindings.findOrCreate(placement);
        assertThat(replacement.getGeneration()).isEqualTo(original.getGeneration() + 1);
        assertThat(replacement.getBindingId()).isNotEqualTo(original.getBindingId());
        assertThat(bindings.findActive(placement).getBindingId()).isEqualTo(replacement.getBindingId());
    }

    @Test
    void unknownTurnInAnyMemberPreventsAllRetirementWrites() {
        jdbc.update("INSERT INTO ma_turn (tenant_id, session_id, turn_id, prompt_id, input_json, payload_digest, status,"
                + " gmt_create, gmt_modified) VALUES ('tenant','user-session','unknown','prompt','{}','digest','RECOVERY_BLOCKED',1,1)");
        assertThatThrownBy(() -> service.retire(request, this::terminated)).isInstanceOf(RuntimeBrokerException.class);
        assertThat(bindings.findById(original.getBindingId()).getVersion()).isEqualTo(original.getVersion());
        assertThat(bindings.findActive(placement).getBindingId()).isEqualTo(original.getBindingId());
        assertThat(jdbc.queryForObject("SELECT state FROM ma_workspace", String.class)).isEqualTo("ACTIVE");
        assertThat(service.inspect(request)).isNull();
    }
}
