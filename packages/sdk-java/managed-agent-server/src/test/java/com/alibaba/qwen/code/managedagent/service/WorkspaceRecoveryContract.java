package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.*;

import com.alibaba.qwen.code.managedagent.api.WorkspaceSelection;
import com.alibaba.qwen.code.managedagent.store.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.store.WorkspaceExecutionStore;
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
