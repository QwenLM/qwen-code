package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeDrainReceipt;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import com.alibaba.qwen.code.runtimebroker.provisioning.ExternalRuntimeClient;
import com.alibaba.qwen.code.runtimebroker.provisioning.ExternalWorkspaceProvisioner;
import com.alibaba.qwen.code.runtimebroker.security.AesGcmSecretProtector;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

import javax.sql.DataSource;

import java.net.URI;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ExternalWorkspaceOwnershipTest {
    private ManagedSchemaJdbcTemplate jdbc;
    private WorkspaceExecutionStore ownership;
    private JdbcRuntimeBindingRepository bindings;
    private JdbcRuntimeSessionRepository sessions;
    private JdbcToolExecutionRepository executions;
    private RuntimeBindingRecord binding;
    private RuntimeSessionRecord session;
    private ContextBinding context;

    DataSource source() {
        return new DriverManagerDataSource("jdbc:h2:mem:external-owner-" + UUID.randomUUID()
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;DB_CLOSE_DELAY=-1", "sa", "");
    }

    @BeforeEach
    void setUp() throws Exception {
        var source = source();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        var manager = new DataSourceTransactionManager(source);
        var registrations = new ExternalStorageRegistrationStore(jdbc, manager);
        registrations.registerExternalStorage("tenant", "register", new ExternalStorageRegistration(
                new ExternalStorageRegistration.ExternalStorageIdentity("provider", "physical", 7),
                new ExternalStorageRegistration.StorageAlias("workspace", "/aliases/workspace", "/remote/workspace")));
        new ExternalWorkspaceMaterializationStore(jdbc, manager).materialize("tenant", "workspace", "Name", "actor", "materialize");
        jdbc.update("INSERT INTO ma_session (tenant_id, session_id, agent_id, gmt_create, gmt_modified, workspace_id,"
                + " workspace_generation, workspace_storage_id, cwd_relative, context_config_ref, context_revision,"
                + " workspace_config_ref, workspace_policy_ref, tool_profile, creator_actor_key)"
                + " VALUES ('tenant', 'harness', 'qwen-code', 1, 1, 'workspace', 1, 'workspace', '.', ?, 1, ?, ?, ?, 'actor')",
                WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, WorkspaceExecutionProfile.CONFIG_REF,
                WorkspaceExecutionProfile.POLICY_REF, "hosted-workspace-external-files/1");
        bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("owner-test", new byte[32]));
        sessions = new JdbcRuntimeSessionRepository(source);
        executions = new JdbcToolExecutionRepository(source);
        ownership = new WorkspaceExecutionStore(jdbc, manager);
        var scope = new RuntimeScope("tenant", "workspace", "1", "/remote/workspace",
                WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");
        var request = new RuntimeProvisionRequest(scope, "harness", ExternalWorkspaceProvisioner.KIND, "workspace");
        var created = bindings.findOrCreate(request);
        created = bindings.claimOperation(created.getBindingId(), "provisioner", Duration.ofMinutes(1));
        ExternalRuntimeClient noNetwork = new ExternalRuntimeClient() {
            @Override
            public CompletionStage<Map<String, Object>> provision(Map<String, Object> ignored) {
                return CompletableFuture.failedFuture(new AssertionError("No allocation in ownership fixture"));
            }

            @Override
            public CompletionStage<Map<String, Object>> observe(Map<String, Object> ignored) {
                return CompletableFuture.failedFuture(new AssertionError("No observation in ownership fixture"));
            }
        };
        try (var provider = new ExternalWorkspaceProvisioner(noNetwork, registrations, "provider", Duration.ofSeconds(5))) {
            var handle = provider.ensureResource(request, created.getProvisionSeed(), null).toCompletableFuture().get();
            var seed = created.getProvisionSeed();
            var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:19219"),
                    seed.getToken(), seed.getLeaseId(), seed.getEpoch());
            binding = bindings.compareAndSet(created, created.withAttestation(lease, handle, Instant.now(), Instant.now()));
        }
        binding = bindings.releaseOperation(binding.getBindingId(), binding.getOperationOwner(), binding.getOperationGeneration());
        session = sessions.findOrCreate(new RuntimeSessionRecord(new RuntimeSession("harness", "runtime-session", "bootstrap", scope),
                binding.getBindingId(), binding.getGeneration(), RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
        session = sessions.compareAndSet(session, session.withState(RuntimeSessionRecord.State.READY, Instant.now()));
        context = new ContextBinding("tenant", "workspace", 1, "workspace", ".", WorkspaceExecutionProfile.CONTEXT_CONFIG_REF, 1);
    }

    @Test
    void malformedRegistrationPermanentlyRefusesOwnershipWithoutMutatingHolder() {
        ownership.claim(context, session, binding, bindings);
        var owner = jdbc.queryForMap("SELECT * FROM ma_storage_owner");
        String original = jdbc.queryForObject("SELECT registration_json FROM ma_storage", String.class);
        for (String encoded : java.util.List.of("not-json", "{}",
                original.replaceFirst("\\{", "{\"extra\":true,"),
                original.replace("\"registrationRevision\":7", "\"registrationRevision\":\"7\""))) {
            jdbc.update("UPDATE ma_storage SET registration_json = ?", encoded);
            assertThatThrownBy(() -> ownership.assertHeld(context, session, binding, bindings))
                    .isInstanceOfSatisfying(RuntimeBrokerException.class, error -> {
                        assertThat(error.getStatusCode()).isEqualTo(409);
                        assertThat(error.getCode()).isEqualTo("workspace_close_identity_unverified");
                        assertThat(error.isRetryable()).isFalse();
                    });
            assertThat(jdbc.queryForMap("SELECT * FROM ma_storage_owner")).isEqualTo(owner);
        }
    }

    @Test
    void canStopExternalDrainedRequiresCurrentClaimAndQuiescentExecution() {
        ownership.claim(context, session, binding, bindings);
        binding = bindings.claimOperation(binding.getBindingId(), "drainer", Duration.ofMinutes(1));
        binding = bindings.compareAndSet(binding, binding.withDrainRequested(true, Instant.now())
                .withState(RuntimeBindingRecord.State.DRAINING, binding.getLease(), Instant.now()));
        var owner = jdbc.queryForMap("SELECT * FROM ma_storage_owner");
        assertThat(ownership.canStopExternalDrained(binding, bindings)).isTrue();
        executions.findOrCreate(com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord.prepared(
                "execution", "tenant", binding.getBindingId(), binding.getGeneration(), "harness",
                session.getRuntimeSessionId(), "turn", "call", "digest", Map.of("sessionId", session.getRuntimeSessionId(),
                        "promptId", "turn", "callId", "call", "argsDigest", "digest")));
        assertThat(ownership.canStopExternalDrained(binding, bindings)).isFalse();
        var stale = binding;
        bindings.releaseOperation(binding.getBindingId(), binding.getOperationOwner(), binding.getOperationGeneration());
        binding = bindings.claimOperation(binding.getBindingId(), "next-drainer", Duration.ofMinutes(1));
        assertThatThrownBy(() -> ownership.canStopExternalDrained(stale, bindings))
                .isInstanceOfSatisfying(RuntimeBrokerException.class,
                        error -> assertThat(error.getCode()).isEqualTo("workspace_close_identity_unverified"));
        assertThat(jdbc.queryForMap("SELECT * FROM ma_storage_owner")).isEqualTo(owner);
    }

    @Test
    void lostStopEligibilityDoesNotReopenAcquisitionOrBypassActiveExecution() {
        ownership.claim(context, session, binding, bindings);
        var owner = jdbc.queryForMap("SELECT * FROM ma_storage_owner");
        binding = bindings.claimOperation(binding.getBindingId(), "drainer", Duration.ofMinutes(1));
        binding = bindings.compareAndSet(binding,
                binding.withState(RuntimeBindingRecord.State.LOST, binding.getLease(), Instant.now()));
        assertThat(binding.isDrainRequested()).isFalse();
        assertThatThrownBy(() -> ownership.claim(context, session, binding, bindings))
                .isInstanceOfSatisfying(RuntimeBrokerException.class,
                        error -> assertThat(error.getCode()).isEqualTo("workspace_close_identity_unverified"));
        assertThat(ownership.canStopExternalDrained(binding, bindings)).isFalse();
        binding = bindings.compareAndSet(binding, binding.withDrainRequested(true, Instant.now()));
        assertThat(binding.getDrainReceipt()).isNull();
        assertThat(ownership.canStopExternalDrained(binding, bindings)).isTrue();
        executions.findOrCreate(com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord.prepared(
                "execution", "tenant", binding.getBindingId(), binding.getGeneration(), "harness",
                session.getRuntimeSessionId(), "turn", "call", "digest", Map.of("sessionId", session.getRuntimeSessionId(),
                        "promptId", "turn", "callId", "call", "argsDigest", "digest")));
        assertThat(ownership.canStopExternalDrained(binding, bindings)).isFalse();
        assertThat(jdbc.queryForMap("SELECT * FROM ma_storage_owner")).isEqualTo(owner);
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void lostRetiredReleaseRequiresACommittedReceiptAtBothEntrypoints(boolean throughBroker) {
        prepareLostRetiredHolder();
        var owner = jdbc.queryForMap("SELECT * FROM ma_storage_owner");
        java.util.function.Consumer<RuntimeBindingRecord> release = claim -> {
            if (throughBroker) {
                session = bindings.completeStoppedSessionRelease(sessions, executions, session, claim);
            } else {
                ownership.releaseStopped(context, session, claim, bindings);
            }
        };
        assertThatThrownBy(() -> release.accept(binding))
                .isInstanceOfSatisfying(RuntimeBrokerException.class,
                        error -> assertThat(error.getCode()).isEqualTo("runtime_reconciliation_required"));
        var receipt = new RuntimeDrainReceipt(binding.getBindingId(), binding.getGeneration(),
                binding.getProvisionSeed().getProvisionRequestId(), binding.getResourceHandle(), Instant.now());
        assertThatThrownBy(() -> release.accept(binding.withDrainReceipt(receipt)))
                .isInstanceOfSatisfying(RuntimeBrokerException.class,
                        error -> assertThat(error.getCode()).isEqualTo("runtime_reconciliation_required"));
        assertThat(jdbc.queryForMap("SELECT * FROM ma_storage_owner")).isEqualTo(owner);
        binding = bindings.compareAndSet(binding, binding.withDrainReceipt(receipt));
        release.accept(binding);
        assertThat(jdbc.queryForMap("SELECT holder_key, binding_id, runtime_generation, runtime_session_id FROM ma_storage_owner").values())
                .containsOnlyNulls();
        assertThat(bindings.findById(binding.getBindingId()).getDrainReceipt()).isEqualTo(receipt);
        if (throughBroker) {
            assertThat(session.getState()).isEqualTo(RuntimeSessionRecord.State.RELEASED);
        }
    }

    @Test
    void lostRetiredReleaseRefusesReplacedAndExpiredOperationClaims() {
        prepareLostRetiredHolder();
        var receipt = new RuntimeDrainReceipt(binding.getBindingId(), binding.getGeneration(),
                binding.getProvisionSeed().getProvisionRequestId(), binding.getResourceHandle(), Instant.now());
        binding = bindings.compareAndSet(binding, binding.withDrainReceipt(receipt));
        var owner = jdbc.queryForMap("SELECT * FROM ma_storage_owner");
        var stale = binding;
        bindings.releaseOperation(binding.getBindingId(), binding.getOperationOwner(), binding.getOperationGeneration());
        binding = bindings.claimOperation(binding.getBindingId(), "next-drainer", Duration.ofMinutes(1));
        assertThatThrownBy(() -> ownership.releaseStopped(context, session, stale, bindings))
                .isInstanceOfSatisfying(RuntimeBrokerException.class,
                        error -> assertThat(error.getCode()).isEqualTo("workspace_close_identity_unverified"));
        jdbc.update("UPDATE ma_runtime_binding SET operation_lease_until = ?", java.sql.Timestamp.from(Instant.now().minusSeconds(1)));
        assertThatThrownBy(() -> ownership.releaseStopped(context, session, binding, bindings))
                .isInstanceOfSatisfying(RuntimeBrokerException.class,
                        error -> assertThat(error.getCode()).isEqualTo("workspace_close_identity_unverified"));
        assertThat(jdbc.queryForMap("SELECT * FROM ma_storage_owner")).isEqualTo(owner);
    }

    private void prepareLostRetiredHolder() {
        ownership.claim(context, session, binding, bindings);
        ownership.release(context, session, binding, bindings);
        binding = bindings.claimOperation(binding.getBindingId(), "drainer", Duration.ofMinutes(1));
        binding = bindings.compareAndSet(binding, binding.withDrainRequested(true, Instant.now())
                .withState(RuntimeBindingRecord.State.DRAINING, binding.getLease(), Instant.now()));
        session = bindings.beginSessionRelease(sessions, executions, session);
        binding = bindings.compareAndSet(binding,
                binding.withState(RuntimeBindingRecord.State.LOST, binding.getLease(), Instant.now()));
    }

    @Test
    void releaseLostRejectsExternalEvenWithStoppedWriterEvidence() {
        binding = bindings.claimOperation(binding.getBindingId(), "recovery", Duration.ofMinutes(1));
        var seed = binding.getProvisionSeed();
        var handle = binding.getResourceHandle();
        java.util.function.Function<com.alibaba.qwen.code.runtimebroker.RuntimeRecoveryEvidence.Fact,
                com.alibaba.qwen.code.runtimebroker.RuntimeRecoveryEvidence> evidence = fact ->
                        new com.alibaba.qwen.code.runtimebroker.RuntimeRecoveryEvidence("evidence-" + fact, fact,
                                "test-recovery", Instant.now(), "original-host", seed.getProvisionRequestId(),
                                seed.getProvisionalRuntimeId(), seed.getGatewayIncarnation(), seed.getLeaseId(), seed.getEpoch(), handle);
        binding = bindings.compareAndSet(binding, binding.withRecoveryEvidence(
                evidence.apply(com.alibaba.qwen.code.runtimebroker.RuntimeRecoveryEvidence.Fact.JOURNAL_LOST),
                evidence.apply(com.alibaba.qwen.code.runtimebroker.RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED), Instant.now()));
        var owner = jdbc.queryForMap("SELECT * FROM ma_storage_owner");
        var member = jdbc.queryForMap("SELECT * FROM ma_runtime_session");
        assertThat(binding.hasStoppedWriters()).isTrue();
        var manager = org.mockito.Mockito.spy(new DataSourceTransactionManager(jdbc.getDataSource()));
        var recovery = new WorkspaceExecutionStore(jdbc, manager);
        org.mockito.Mockito.clearInvocations(manager);
        assertThatThrownBy(() -> recovery.releaseLost(binding))
                .isInstanceOfSatisfying(RuntimeBrokerException.class, error -> {
                    assertThat(error.getStatusCode()).isEqualTo(409);
                    assertThat(error.getCode()).isEqualTo("workspace_unavailable");
                    assertThat(error.isRetryable()).isFalse();
                });
        org.mockito.Mockito.verifyNoInteractions(manager);
        assertThat(jdbc.queryForMap("SELECT * FROM ma_storage_owner")).isEqualTo(owner);
        assertThat(jdbc.queryForMap("SELECT * FROM ma_runtime_session")).isEqualTo(member);
    }

    @Test
    void turnHandbackRetainsPhysicalOwnerAndOnlyExactSessionCanReacquire() {
        ownership.claim(context, session, binding, bindings);
        var owner = jdbc.queryForMap("SELECT * FROM ma_storage_owner");
        assertThat(owner).containsEntry("mount_revision", 7L).containsEntry("mount_state", "UNVERIFIED");
        assertThat(jdbc.queryForObject("SELECT mount_revision FROM ma_storage", Long.class)).isZero();
        ownership.release(context, session, binding, bindings);
        assertThat(jdbc.queryForObject("SELECT execution_storage_key FROM ma_runtime_session", String.class)).isNull();
        assertThat(jdbc.queryForMap("SELECT * FROM ma_storage_owner")).isEqualTo(owner);
        ownership.assertOriginalExternal(context, session, binding, bindings);
        assertThat(new WorkspaceExecutionStore(jdbc, new DataSourceTransactionManager(jdbc.getDataSource())).hasHolder(binding)).isTrue();
        ownership.claim(context, session, binding, bindings);
        assertThat(ownership.isHeld(context, session, binding, bindings)).isTrue();
        var competitor = sessions.findOrCreate(new RuntimeSessionRecord(new RuntimeSession("harness", "competitor", "bootstrap",
                binding.getRequest().getScope()), binding.getBindingId(), binding.getGeneration(), RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
        assertThatThrownBy(() -> ownership.claim(context, competitor, binding, bindings)).isInstanceOf(RuntimeBrokerException.class);
        jdbc.update("UPDATE ma_runtime_session SET execution_storage_key = ? WHERE runtime_session_id = ?",
                owner.get("storage_key"), competitor.getRuntimeSessionId());
        assertThatThrownBy(() -> ownership.assertHeld(context, session, binding, bindings)).isInstanceOf(RuntimeBrokerException.class);
        assertThat(jdbc.queryForMap("SELECT * FROM ma_storage_owner")).isEqualTo(owner);
    }

    @Test
    void unknownAndUnpersistedReceiptRetainOwnerThenExactLiveReceiptClearsOnlyRuntimeColumns() {
        ownership.claim(context, session, binding, bindings);
        ownership.release(context, session, binding, bindings);
        binding = bindings.claimOperation(binding.getBindingId(), "drainer", Duration.ofMinutes(1));
        binding = bindings.compareAndSet(binding, binding.withDrainRequested(true, Instant.now())
                .withState(RuntimeBindingRecord.State.DRAINING, binding.getLease(), Instant.now()));
        session = bindings.beginSessionRelease(sessions, executions, session);
        var claim = binding;
        var owner = jdbc.queryForMap("SELECT * FROM ma_storage_owner");
        assertThatThrownBy(() -> ownership.releaseStopped(context, session, claim, bindings)).isInstanceOf(RuntimeBrokerException.class);
        var receipt = new RuntimeDrainReceipt(binding.getBindingId(), binding.getGeneration(),
                binding.getProvisionSeed().getProvisionRequestId(), binding.getResourceHandle(), Instant.now());
        var unpersisted = binding.withDrainReceipt(receipt);
        assertThatThrownBy(() -> ownership.releaseStopped(context, session, unpersisted, bindings)).isInstanceOf(RuntimeBrokerException.class);
        assertThat(jdbc.queryForMap("SELECT * FROM ma_storage_owner")).isEqualTo(owner);
        binding = bindings.compareAndSet(binding, unpersisted);
        jdbc.update("DELETE FROM ma_workspace_access");
        ownership.releaseStopped(context, session, binding, bindings);
        assertThat(jdbc.queryForMap("SELECT holder_key, binding_id, runtime_generation, runtime_session_id FROM ma_storage_owner").values())
                .containsOnlyNulls();
        assertThat(jdbc.queryForMap("SELECT tenant_id, storage_id, physical_key, mount_root, mount_revision FROM ma_storage_owner"))
                .containsEntry("mount_revision", 7L).containsEntry("mount_root", "/remote/workspace");
        ownership.releaseStopped(context, session, binding, bindings);
    }

    @Test
    void retiredNonHolderBeforeTheHolderDoesNotAbortPhysicalRelease() {
        var nonHolder = retireWithNonHolder();
        var owner = jdbc.queryForMap("SELECT * FROM ma_storage_owner");
        var rows = sessions.findByBinding(binding.getBindingId(), binding.getGeneration(), null, 100);
        assertThat(rows).extracting(RuntimeSessionRecord::getRuntimeSessionId)
                .containsExactly(nonHolder.getRuntimeSessionId(), session.getRuntimeSessionId());
        ownership.releaseStopped(context, nonHolder, binding, bindings);
        assertThat(jdbc.queryForMap("SELECT * FROM ma_storage_owner")).isEqualTo(owner);
        ownership.releaseStopped(context, session, binding, bindings);
        var released = new java.util.HashMap<>(owner);
        for (String column : java.util.List.of("holder_key", "binding_id", "runtime_generation", "runtime_session_id")) {
            released.put(column, null);
        }
        assertThat(jdbc.queryForMap("SELECT * FROM ma_storage_owner")).isEqualTo(released);
        assertThat(bindings.findById(binding.getBindingId()).getDrainReceipt()).isEqualTo(binding.getDrainReceipt());
    }

    @Test
    void retiredNonHolderStillRefusesSplitOrForeignPhysicalMembership() {
        var nonHolder = retireWithNonHolder();
        var owner = jdbc.queryForMap("SELECT * FROM ma_storage_owner");
        for (var invalid : Map.of((String) owner.get("storage_key"), "workspace_busy",
                "foreign-physical-owner", "workspace_close_identity_unverified").entrySet()) {
            jdbc.update("UPDATE ma_runtime_session SET execution_storage_key = ? WHERE runtime_session_id = ?",
                    invalid.getKey(), nonHolder.getRuntimeSessionId());
            assertThatThrownBy(() -> ownership.releaseStopped(context, nonHolder, binding, bindings))
                    .isInstanceOfSatisfying(RuntimeBrokerException.class, failure -> {
                        assertThat(failure.getCode()).isEqualTo(invalid.getValue());
                        assertThat(failure.isRetryable()).isEqualTo("workspace_busy".equals(invalid.getValue()));
                    });
            assertThat(jdbc.queryForMap("SELECT * FROM ma_storage_owner")).isEqualTo(owner);
        }
    }

    private RuntimeSessionRecord retireWithNonHolder() {
        var nonHolder = sessions.findOrCreate(new RuntimeSessionRecord(
                new RuntimeSession("harness", "a-retired", "bootstrap", binding.getRequest().getScope()),
                binding.getBindingId(), binding.getGeneration(), RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
        nonHolder = sessions.compareAndSet(nonHolder, nonHolder.withState(RuntimeSessionRecord.State.READY, Instant.now()));
        ownership.claim(context, session, binding, bindings);
        ownership.release(context, session, binding, bindings);
        binding = bindings.claimOperation(binding.getBindingId(), "drainer", Duration.ofMinutes(1));
        binding = bindings.compareAndSet(binding, binding.withDrainRequested(true, Instant.now())
                .withState(RuntimeBindingRecord.State.DRAINING, binding.getLease(), Instant.now()));
        var receipt = new RuntimeDrainReceipt(binding.getBindingId(), binding.getGeneration(),
                binding.getProvisionSeed().getProvisionRequestId(), binding.getResourceHandle(), Instant.now());
        binding = bindings.compareAndSet(binding, binding.withDrainReceipt(receipt));
        session = bindings.beginSessionRelease(sessions, executions, session);
        session = bindings.completeSessionRelease(sessions, session);
        nonHolder = bindings.beginSessionRelease(sessions, executions, nonHolder);
        return bindings.completeSessionRelease(sessions, nonHolder);
    }

    @Test
    void retiredHolderRequiresTheCapturedLiveLifecycleClaimAfterReceiptPersistence() {
        ownership.claim(context, session, binding, bindings);
        ownership.release(context, session, binding, bindings);
        binding = bindings.claimOperation(binding.getBindingId(), "drainer", Duration.ofMinutes(1));
        binding = bindings.compareAndSet(binding, binding.withDrainRequested(true, Instant.now())
                .withState(RuntimeBindingRecord.State.DRAINING, binding.getLease(), Instant.now()));
        var receipt = new RuntimeDrainReceipt(binding.getBindingId(), binding.getGeneration(),
                binding.getProvisionSeed().getProvisionRequestId(), binding.getResourceHandle(), Instant.now());
        binding = bindings.compareAndSet(binding, binding.withDrainReceipt(receipt));
        session = bindings.beginSessionRelease(sessions, executions, session);
        session = bindings.completeSessionRelease(sessions, session);
        assertThat(session.getState()).isEqualTo(RuntimeSessionRecord.State.RELEASED);
        var owner = jdbc.queryForMap("SELECT * FROM ma_storage_owner");
        new org.springframework.transaction.support.TransactionTemplate(new DataSourceTransactionManager(jdbc.getDataSource()))
                .executeWithoutResult(status -> jdbc.execute((org.springframework.jdbc.core.ConnectionCallback<Void>) connection -> {
                    JdbcRuntimeBindingRepository.beginHarnessLifecycle(connection, "tenant", "harness", "lifecycle");
                    return null;
                }));
        jdbc.update("UPDATE ma_session SET status = 'CLOSING'");
        jdbc.update("DELETE FROM ma_workspace_access");
        long now = jdbc.queryForObject("SELECT " + com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime.SQL_NOW, Long.class);
        jdbc.update("UPDATE ma_session_head SET claim_generation = 1, claim_lease_until = ?", now + 60_000);
        java.util.function.LongFunction<RuntimeSessionRecord> captured = generation -> new RuntimeSessionRecord(
                new RuntimeSession(session.getSession().getHarnessSessionId(), session.getRuntimeSessionId(), session.getSession().getTurnKind(),
                        session.getSession().getScope().withLifecycleAuthority(
                                new com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority("lifecycle", generation))),
                session.getBindingId(), session.getRuntimeGeneration(), session.getState(), session.getVersion(), session.getLastActiveAt());
        var expired = captured.apply(1);
        jdbc.update("UPDATE ma_session_head SET claim_lease_until = ?", now - 1);
        assertThatThrownBy(() -> ownership.releaseStopped(context, expired, binding, bindings))
                .isInstanceOfSatisfying(RuntimeBrokerException.class, error -> assertThat(error.getCode()).isEqualTo("runtime_admission_closed"));
        assertThat(jdbc.queryForMap("SELECT * FROM ma_storage_owner")).isEqualTo(owner);
        assertThat(bindings.findById(binding.getBindingId()).getDrainReceipt()).isEqualTo(receipt);
        jdbc.update("UPDATE ma_session_head SET claim_generation = 2, claim_lease_until = ?", now + 60_000);
        assertThatThrownBy(() -> ownership.releaseStopped(context, expired, binding, bindings))
                .isInstanceOfSatisfying(RuntimeBrokerException.class, error -> assertThat(error.getCode()).isEqualTo("runtime_admission_closed"));
        assertThat(jdbc.queryForMap("SELECT * FROM ma_storage_owner")).isEqualTo(owner);
        assertThat(bindings.findById(binding.getBindingId()).getDrainReceipt()).isEqualTo(receipt);
        ownership.releaseStopped(context, captured.apply(2), binding, bindings);
        assertThat(ownership.hasHolder(binding)).isFalse();
        assertThat(bindings.findById(binding.getBindingId()).getDrainReceipt()).isEqualTo(receipt);
    }

    @Test
    void lateCleanupCannotClearAfterClaimChangesAndRevokedGrantCannotAcquire() {
        ownership.claim(context, session, binding, bindings);
        jdbc.update("DELETE FROM ma_workspace_access");
        assertThat(ownership.isHeld(context, session, binding, bindings)).isTrue();
        assertThatThrownBy(() -> ownership.assertHeld(context, session, binding, bindings)).isInstanceOf(RuntimeBrokerException.class);
        ownership.release(context, session, binding, bindings);
        assertThat(ownership.isHeld(context, session, binding, bindings)).isFalse();
        assertThatThrownBy(() -> ownership.claim(context, session, binding, bindings)).isInstanceOf(RuntimeBrokerException.class);
        binding = bindings.claimOperation(binding.getBindingId(), "drainer", Duration.ofMinutes(1));
        binding = bindings.compareAndSet(binding, binding.withDrainRequested(true, Instant.now())
                .withState(RuntimeBindingRecord.State.DRAINING, binding.getLease(), Instant.now()));

        binding = bindings.compareAndSet(binding, binding.withDrainReceipt(new RuntimeDrainReceipt(binding.getBindingId(),
                binding.getGeneration(), binding.getProvisionSeed().getProvisionRequestId(), binding.getResourceHandle(), Instant.now())));
        session = bindings.beginSessionRelease(sessions, executions, session);
        var stale = binding;
        var owner = jdbc.queryForMap("SELECT * FROM ma_storage_owner");
        bindings.releaseOperation(binding.getBindingId(), binding.getOperationOwner(), binding.getOperationGeneration());
        binding = bindings.claimOperation(binding.getBindingId(), "second", Duration.ofMinutes(1));
        assertThatThrownBy(() -> ownership.releaseStopped(context, session, stale, bindings)).isInstanceOf(RuntimeBrokerException.class);
        assertThat(jdbc.queryForMap("SELECT * FROM ma_storage_owner")).isEqualTo(owner);
        var releasing = bindings.beginSessionRelease(sessions, executions, session);
        assertThat(bindings.completeStoppedSessionRelease(sessions, executions, releasing, binding).getState())
                .isEqualTo(RuntimeSessionRecord.State.RELEASED);
        assertThat(ownership.hasHolder(binding)).isFalse();
    }
}
