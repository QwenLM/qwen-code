package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.*;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
import com.alibaba.qwen.code.managedagent.store.WorkspaceOperatorRecoveryStore;
import com.alibaba.qwen.code.runtimebroker.*;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import javax.sql.DataSource;
import org.springframework.jdbc.core.JdbcTemplate;

/** Same physical-holder assertions run on Spring/H2 and the MySQL integration channel. */
public final class WorkspaceRecoveryContract {
    private WorkspaceRecoveryContract() { }

    public static void verifyOperatorPrepare(DataSource source, JdbcTemplate jdbc, ManagedAgentStore store,
            WorkspaceExecutionStore authority) throws Exception {
        var fixture = new Fixture(source, jdbc, store);
        var original = fixture.runtime("operator");
        authority.claim(fixture.session.workspace(), original.session());
        String callId = UUID.randomUUID().toString();
        var prepared = fixture.executions.findOrCreate(ToolExecutionRecord.prepared(callId,
                UUID.randomUUID().toString(), original.binding().getBindingId(),
                original.binding().getGeneration(), fixture.session.sessionId(),
                original.session().getRuntimeSessionId(), "turn", "call", "digest",
                Map.of("sessionId", original.session().getRuntimeSessionId(), "promptId", "turn",
                        "callId", "call", "argsDigest", "digest", "runtimeProtocol", 3,
                        "inputDigest", "digest", "dispatchMode", "deferred")));
        var dispatched = fixture.executions.claimDispatch(prepared.getExecutionCallId(),
                "dispatcher", Duration.ofMinutes(1));
        assertThat(dispatched).isNotNull();
        assertThat(fixture.executions.compareAndSet(dispatched,
                dispatched.withResult(Map.of("executionStatus", "success", "responseParts", List.of(),
                        "capture", Map.of("captureStatus", "partial", "captureReason", "producer_lost")),
                        1, Instant.now()), "dispatcher", dispatched.getDispatchGeneration())).isNotNull();
        var recovery = new WorkspaceOperatorRecoveryStore(jdbc,
                new org.springframework.jdbc.datasource.DataSourceTransactionManager(source),
                fixture.bindings, new com.fasterxml.jackson.databind.ObjectMapper());
        var inspection = recovery.inspect(original.binding().getBindingId(), original.binding().getGeneration());
        assertThat(inspection.captureReason()).isEqualTo("producer_lost");
        assertThat(inspection.eligibleForPrepare()).isTrue();
        Instant beforePrepare = Instant.now();
        String recoveryId;
        try (var pool = Executors.newSingleThreadExecutor(); var connection = source.getConnection()) {
            connection.setAutoCommit(false);
            try (var lock = connection.prepareStatement("SELECT tenant_id FROM qwen_runtime_placement_guard"
                    + " WHERE tenant_id = ? FOR UPDATE")) {
                lock.setString(1, fixture.tenant);
                try (var rows = lock.executeQuery()) { assertThat(rows.next()).isTrue(); }
            }
            var started = new CountDownLatch(1);
            var pending = pool.submit(() -> {
                started.countDown();
                return recovery.prepare(original.binding().getBindingId(),
                        original.binding().getGeneration(), inspection.holderKey(), "operator", "incident");
            });
            try {
                assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();
                assertThatThrownBy(() -> pending.get(100, TimeUnit.MILLISECONDS))
                        .isInstanceOf(java.util.concurrent.TimeoutException.class);
            } finally {
                connection.commit();
            }
            recoveryId = pending.get(5, TimeUnit.SECONDS);
        }
        assertThat(recovery.operation(recoveryId).preparedAt())
                .isBetween(beforePrepare.minusSeconds(1), Instant.now());
        assertThat(recovery.prepare(original.binding().getBindingId(),
                original.binding().getGeneration(), inspection.holderKey(), "operator", "incident"))
                .isEqualTo(recoveryId);
        var fenced = fixture.bindings.findById(original.binding().getBindingId());
        assertThat(fenced.getState()).isEqualTo(RuntimeBindingRecord.State.OPERATOR_RECOVERY);
        var claimed = fixture.bindings.claimOperation(fenced.getBindingId(),
                "fence-test", Duration.ofSeconds(10));
        assertThat(claimed).isNotNull();
        assertThatThrownBy(() -> fixture.bindings.compareAndSet(claimed,
                claimed.withState(RuntimeBindingRecord.State.READY, claimed.getLease(), Instant.now())))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> fixture.bindings.compareAndSet(claimed,
                claimed.withRecoveryEvidence(
                        evidence(claimed, RuntimeRecoveryEvidence.Fact.JOURNAL_LOST),
                        null, Instant.now())))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("stopped-writer");
        fixture.bindings.releaseOperation(claimed.getBindingId(), "fence-test",
                claimed.getOperationGeneration());
        var scope = original.binding().getRequest().getScope();
        var renamedWorkspace = new RuntimeScope(scope.getTenantId(), "renamed-workspace",
                scope.getWorkspaceGeneration(), scope.getCanonicalCwd(),
                scope.getCapabilityDigest(), scope.getIsolationClass());
        assertThatThrownBy(() -> fixture.bindings.findOrCreate(new RuntimeProvisionRequest(
                renamedWorkspace, "other-session", "local-process", "other-storage")))
                .isInstanceOf(RuntimeBrokerException.class);
        var renamedDirectory = new RuntimeScope(scope.getTenantId(), "renamed-workspace",
                scope.getWorkspaceGeneration(), "/other-directory",
                scope.getCapabilityDigest(), scope.getIsolationClass());
        assertThatThrownBy(() -> fixture.bindings.findOrCreate(new RuntimeProvisionRequest(
                renamedDirectory, "other-session", "local-process",
                original.binding().getRequest().getStorageId())))
                .isInstanceOf(RuntimeBrokerException.class);
        assertThat(fixture.bindings.findRecoveryCandidates("local-process", null, 100))
                .noneMatch(candidate -> candidate.getBindingId().equals(fenced.getBindingId()));
        assertThatThrownBy(() -> authority.release(fixture.session.workspace(), original.session()))
                .isInstanceOf(RuntimeBrokerException.class);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_operator_recovery"
                + " WHERE binding_id = ?", Long.class, original.binding().getBindingId())).isEqualTo(1);
        var lostClaim = fixture.bindings.claimOperation(fenced.getBindingId(),
                "loss-test", Duration.ofSeconds(10));
        var lost = fixture.bindings.compareAndSet(lostClaim,
                lostClaim.withRecoveryEvidence(
                        evidence(lostClaim, RuntimeRecoveryEvidence.Fact.JOURNAL_LOST),
                        evidence(lostClaim, RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED),
                        Instant.now()));
        fixture.bindings.releaseOperation(lost.getBindingId(), "loss-test",
                lost.getOperationGeneration());
        assertThat(fixture.bindings.findRecoveryCandidates("local-process", null, 100))
                .noneMatch(candidate -> candidate.getBindingId().equals(lost.getBindingId()));
        jdbc.update("DELETE FROM managed_workspace_operator_recovery WHERE recovery_id = ?", recoveryId);
        assertThat(fixture.bindings.findRecoveryCandidates("local-process", null, 100))
                .anyMatch(candidate -> candidate.getBindingId().equals(lost.getBindingId()));

        var blockedFixture = new Fixture(source, jdbc, store);
        var blocked = blockedFixture.runtime("blocked").binding();
        assertThat(blockedFixture.bindings.compareAndSet(blocked,
                blocked.withState(RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                        blocked.getLease(), Instant.now()))).isNotNull();
        var blockedScope = blocked.getRequest().getScope();
        var otherWorkspace = new RuntimeScope(blockedScope.getTenantId(), "renamed-workspace",
                blockedScope.getWorkspaceGeneration(), "/other-directory",
                blockedScope.getCapabilityDigest(), blockedScope.getIsolationClass());
        assertThatThrownBy(() -> blockedFixture.bindings.findOrCreate(new RuntimeProvisionRequest(
                otherWorkspace, "other-session", "local-process",
                blocked.getRequest().getStorageId())))
                .isInstanceOf(RuntimeBrokerException.class);

        for (var state : List.of(RuntimeBindingRecord.State.DRAINING,
                RuntimeBindingRecord.State.RECOVERY_BLOCKED)) {
            var stateFixture = new Fixture(source, jdbc, store);
            var stateRuntime = stateFixture.runtime(state.name());
            authority.claim(stateFixture.session.workspace(), stateRuntime.session());
            var stateExecution = stateFixture.executions.findOrCreate(ToolExecutionRecord.prepared(
                    UUID.randomUUID().toString(), UUID.randomUUID().toString(),
                    stateRuntime.binding().getBindingId(), stateRuntime.binding().getGeneration(),
                    stateFixture.session.sessionId(), stateRuntime.session().getRuntimeSessionId(),
                    "turn", "call", "digest", Map.of(
                            "sessionId", stateRuntime.session().getRuntimeSessionId(),
                            "promptId", "turn", "callId", "call", "argsDigest", "digest",
                            "toolName", "run_shell_command")));
            var dispatch = stateFixture.executions.claimDispatch(stateExecution.getExecutionCallId(),
                    "dispatcher", Duration.ofMinutes(1));
            assertThat(stateFixture.executions.compareAndSet(dispatch,
                    dispatch.withResult(Map.of("executionStatus", "success", "responseParts", List.of(),
                            "capture", Map.of("captureStatus", "partial",
                                    "captureReason", "producer_lost")), 1, Instant.now()),
                    "dispatcher", dispatch.getDispatchGeneration())).isNotNull();
            assertThat(stateFixture.bindings.compareAndSet(stateRuntime.binding(),
                    stateRuntime.binding().withState(state, stateRuntime.binding().getLease(),
                            Instant.now()))).isNotNull();
            var stateRecovery = new WorkspaceOperatorRecoveryStore(jdbc,
                    new org.springframework.jdbc.datasource.DataSourceTransactionManager(source),
                    stateFixture.bindings, new com.fasterxml.jackson.databind.ObjectMapper());
            var stateInspection = stateRecovery.inspect(stateRuntime.binding().getBindingId(),
                    stateRuntime.binding().getGeneration());
            assertThat(stateInspection.eligibleForPrepare()).isTrue();
            stateRecovery.prepare(stateRuntime.binding().getBindingId(),
                    stateRuntime.binding().getGeneration(), stateInspection.holderKey(),
                    "operator", "incident");
            assertThat(stateFixture.bindings.findById(stateRuntime.binding().getBindingId()).getState())
                    .isEqualTo(RuntimeBindingRecord.State.OPERATOR_RECOVERY);
        }
    }

    public static void verify(DataSource source, JdbcTemplate jdbc, ManagedAgentStore store,
            WorkspaceExecutionStore authority) throws Exception {
        var fixture = new Fixture(source, jdbc, store);
        var original = fixture.runtime("original");
        var rival = fixture.runtime("rival");
        authority.claim(fixture.session.workspace(), original.session());
        var execution = fixture.bindings.admitExecution(fixture.sessions, fixture.executions,
                ToolExecutionRecord.prepared(fixture.tenant, fixture.tenant, original.binding().getBindingId(),
                        original.binding().getGeneration(), fixture.session.sessionId(), original.session().getRuntimeSessionId(),
                        "turn", "call", "digest", Map.of("sessionId", original.session().getRuntimeSessionId(),
                                "promptId", "turn", "callId", "call", "argsDigest", "digest")));
        var lost = fixture.lose(original.binding());
        assertThatThrownBy(() -> authority.releaseLost(lost)).isInstanceOf(RuntimeBrokerException.class);
        authority.assertHeld(fixture.session.workspace(), original.session());
        assertThat(fixture.bindings.recoverLost(fixture.sessions, fixture.executions, lost).getState())
                .isEqualTo(RuntimeBindingRecord.State.LOST);
        assertThat(fixture.executions.findByExecutionCallId(execution.getExecutionCallId()).getState())
                .isEqualTo(ToolExecutionRecord.State.ABANDONED);
        assertThatThrownBy(() -> fixture.bindings.completeSessionRelease(fixture.sessions, original.session()))
                .isInstanceOf(RuntimeBrokerException.class);
        assertThatThrownBy(() -> authority.release(fixture.session.workspace(), original.session()))
                .isInstanceOf(RuntimeBrokerException.class);

        jdbc.update("DELETE FROM managed_workspace_access WHERE tenant_id = ?", fixture.tenant);
        jdbc.update("UPDATE managed_agent_session SET status = 'DELETED', deleted_at = 2 WHERE session_id = ?",
                fixture.session.sessionId());
        jdbc.update("UPDATE managed_workspace_registry SET storage_id = 'changed', workspace_generation = 2,"
                + " state = 'REMOVED' WHERE tenant_id = ?", fixture.tenant);
        assertThatThrownBy(() -> authority.authorize(fixture.session)).isInstanceOf(RuntimeBrokerException.class);
        var absentMounts = new com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties();
        var resolver = new WorkspaceRuntimeResolver(store, authority, absentMounts);
        assertThatThrownBy(() -> resolver.resolve(fixture.session.sessionId())).isInstanceOf(RuntimeBrokerException.class);

        fixture.bindings.releaseOperation(lost.getBindingId(), "fixture", lost.getOperationGeneration());
        var nextClaim = fixture.bindings.claimOperation(lost.getBindingId(), "restored", Duration.ofMinutes(2));
        assertThatThrownBy(() -> authority.releaseLost(lost)).isInstanceOf(RuntimeBrokerException.class);
        authority.assertHeld(fixture.session.workspace(), original.session());
        authority.releaseLost(nextClaim);
        assertThat(fixture.bindings.findById(lost.getBindingId()).getState()).isEqualTo(RuntimeBindingRecord.State.LOST);
        assertThat(fixture.sessions.countActiveByBinding(lost.getBindingId(), lost.getGeneration())).isEqualTo(1);

        // The first clear is committed. Retry after a new holder arrives must not erase it.
        authority.claim(fixture.session.workspace(), rival.session());
        authority.releaseLost(nextClaim);
        authority.assertHeld(fixture.session.workspace(), rival.session());
        assertThatThrownBy(() -> authority.claim(fixture.session.workspace(), original.session()))
                .isInstanceOf(RuntimeBrokerException.class);
        assertThat(fixture.bindings.finishLostRecovery(fixture.sessions, fixture.executions, nextClaim).getState())
                .isEqualTo(RuntimeBindingRecord.State.RELEASED);
        authority.assertHeld(fixture.session.workspace(), rival.session());
        assertThat(fixture.sessions.countActiveByBinding(rival.binding().getBindingId(), rival.binding().getGeneration()))
                .isEqualTo(1);
        verifyLateClaim(source, jdbc, store, authority);
    }

    private static void verifyLateClaim(DataSource source, JdbcTemplate jdbc, ManagedAgentStore store,
            WorkspaceExecutionStore authority) throws Exception {
        var fixture = new Fixture(source, jdbc, store);
        var original = fixture.runtime("late");
        try (var pool = Executors.newSingleThreadExecutor(); var connection = source.getConnection()) {
            connection.setAutoCommit(false);
            try (var lock = connection.prepareStatement("SELECT binding_id FROM qwen_runtime_binding WHERE binding_id = ? FOR UPDATE")) {
                lock.setString(1, original.binding().getBindingId());
                try (var rows = lock.executeQuery()) { assertThat(rows.next()).isTrue(); }
            }
            var started = new CountDownLatch(1);
            var pending = pool.submit(() -> {
                started.countDown();
                authority.claim(fixture.session.workspace(), original.session());
            });
            assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();
            assertThatThrownBy(() -> pending.get(100, TimeUnit.MILLISECONDS)).isInstanceOf(java.util.concurrent.TimeoutException.class);
            try (var lose = connection.prepareStatement("UPDATE qwen_runtime_binding SET binding_state = 'LOST',"
                    + " record_version = record_version + 1 WHERE binding_id = ?")) {
                lose.setString(1, original.binding().getBindingId());
                assertThat(lose.executeUpdate()).isEqualTo(1);
            }
            connection.commit();
            assertThatThrownBy(() -> pending.get(5, TimeUnit.SECONDS)).hasCauseInstanceOf(RuntimeBrokerException.class);
            assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM managed_workspace_execution_lease WHERE binding_id = ?",
                    Long.class, original.binding().getBindingId())).isZero();
        }
    }

    static final class Fixture {
        final JdbcRuntimeBindingRepository bindings;
        final JdbcRuntimeSessionRepository sessions;
        final JdbcToolExecutionRepository executions;
        final SessionRecord session;
        final String tenant = "recovery-" + UUID.randomUUID();

        Fixture(DataSource source, JdbcTemplate jdbc, ManagedAgentStore store) {
            bindings = new JdbcRuntimeBindingRepository(source, new AesGcmSecretProtector("test", new byte[32]));
            sessions = new JdbcRuntimeSessionRepository(source);
            executions = new JdbcToolExecutionRepository(source);
            jdbc.update("INSERT INTO managed_workspace_registry (tenant_id, workspace_id, workspace_generation,"
                    + " storage_id, display_name, config_ref, policy_ref, state) VALUES (?, 'workspace', 1, 'storage',"
                    + " 'Workspace', ?, ?, 'ACTIVE')", tenant, WorkspaceExecutionProfile.CONFIG_REF, WorkspaceExecutionProfile.POLICY_REF);
            jdbc.update("INSERT INTO managed_workspace_access (tenant_id, workspace_id, actor_id, can_read, can_create)"
                    + " VALUES (?, 'workspace', ?, TRUE, TRUE)", tenant, "actor".getBytes(StandardCharsets.UTF_8));
            var transaction = new org.springframework.transaction.support.TransactionTemplate(
                    new org.springframework.jdbc.datasource.DataSourceTransactionManager(source));
            var created = transaction.execute(status -> store.insertWorkspaceSessionCommand(
                    tenant, "actor", "create", "sha256:" + "a".repeat(64),
                    "qwen-code", null, null, List.of(), null, new WorkspaceSelection("workspace", ".")));
            session = store.findSessionById(created.sessionId()).orElseThrow();
        }

        Runtime runtime(String name) {
            var scope = new RuntimeScope(tenant, "workspace", "1", "/original-storage",
                    WorkspaceExecutionProfile.CAPABILITY_DIGEST, "session");
            var request = new RuntimeProvisionRequest(scope, tenant + name, "local-process", "storage");
            var initial = bindings.findOrCreate(request);
            var claim = bindings.claimOperation(initial.getBindingId(), "fixture", Duration.ofMinutes(2));
            var seed = claim.getProvisionSeed();
            var lease = new RuntimeLease(seed.getProvisionalRuntimeId(), URI.create("http://127.0.0.1:9"),
                    seed.getToken(), seed.getLeaseId(), seed.getEpoch());
            var binding = bindings.compareAndSet(claim, claim.withAttestation(lease,
                    new RuntimeResourceHandle("local-process", 2, Map.of("test", tenant + name)), Instant.now(), Instant.now()));
            var acquiring = bindings.admitSession(sessions, new RuntimeSessionRecord(
                    new RuntimeSession(session.sessionId(), tenant + name, "bootstrap", scope), binding.getBindingId(),
                    binding.getGeneration(), RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()));
            return new Runtime(binding, sessions.compareAndSet(acquiring,
                    acquiring.withState(RuntimeSessionRecord.State.READY, Instant.now())));
        }

        RuntimeBindingRecord lose(RuntimeBindingRecord binding) {
            return bindings.compareAndSet(binding, binding.withRecoveryEvidence(
                    evidence(binding, RuntimeRecoveryEvidence.Fact.JOURNAL_LOST),
                    evidence(binding, RuntimeRecoveryEvidence.Fact.WRITERS_STOPPED), Instant.now()));
        }
    }

    static RuntimeRecoveryEvidence evidence(RuntimeBindingRecord binding, RuntimeRecoveryEvidence.Fact fact) {
        var seed = binding.getProvisionSeed();
        return new RuntimeRecoveryEvidence(seed.getProvisionRequestId() + fact, fact, "test-reboot", Instant.now(),
                "original-test-host-boot", seed.getProvisionRequestId(), seed.getProvisionalRuntimeId(), seed.getGatewayIncarnation(),
                seed.getLeaseId(), seed.getEpoch(), binding.getResourceHandle());
    }

    record Runtime(RuntimeBindingRecord binding, RuntimeSessionRecord session) { }
}
