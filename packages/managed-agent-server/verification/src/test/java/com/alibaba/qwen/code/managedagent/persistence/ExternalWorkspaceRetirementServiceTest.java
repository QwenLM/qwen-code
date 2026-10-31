package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.runtime.EmbeddedRuntimeBroker;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.adapter.security.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.provisioning.ExternalRuntimeClient;
import com.alibaba.qwen.code.runtimebroker.provisioning.ExternalWorkspaceProvisioner;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;

class ExternalWorkspaceRetirementServiceTest {
    private ManagedSchemaJdbcTemplate jdbc;
    private JdbcRuntimeBindingRepository bindings;
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
                    WorkspaceExecutionProfile.POLICY_REF, "hosted-workspace-external-files/1", ManagedWorkspaceRegistry.actorKey("tenant", "owner"));
        }
        bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
        placement = new RuntimeProvisionRequest(new RuntimeScope("tenant", "workspace", "1", "/var/lib/managed-workspace",
                WorkspaceExecutionProfile.CAPABILITY_DIGEST, "workspace"), null, "external-workspace", "workspace");
        original = bindings.findOrCreate(placement);
        original = bindings.claimOperation(original.getBindingId(), "initial", Duration.ofMinutes(1));
        provider = new ExternalWorkspaceProvisioner(mock(ExternalRuntimeClient.class), registration, "provider", Duration.ofSeconds(1));
        var handle = provider.ensureResource(placement, original.getProvisionSeed(), null).toCompletableFuture().get();
        original = bindings.compareAndSet(original, original.withResourceHandle(handle, Instant.now())
                .withState(RuntimeBindingRecord.State.RECOVERY_BLOCKED, null, Instant.now()));
        original = bindings.releaseOperation(original.getBindingId(), "initial", original.getOperationGeneration());
        var embedded = mock(EmbeddedRuntimeBroker.class);
        doAnswer(invocation -> { provider.validateTerminalOriginal(invocation.getArgument(0)); return null; })
                .when(embedded).validateExternalTerminalOriginal(any());
        service = new ExternalWorkspaceRetirementService(jdbc, manager, bindings, registration,
                new ManagedWorkspaceRegistry(jdbc), embedded, new ObjectMapper().findAndRegisterModules());
        request = new ExternalWorkspaceRetirementService.Request("tenant", "owner", "workspace", 1,
                original.getBindingId(), original.getGeneration(), original.getVersion(), UUID.randomUUID().toString());
    }

    @AfterEach
    void close() { if (provider != null) { provider.close(); } }

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
