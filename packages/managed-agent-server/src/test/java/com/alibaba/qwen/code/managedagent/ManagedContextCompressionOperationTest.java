package com.alibaba.qwen.code.managedagent;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.persistence.ManagedAgentStore;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSchemaJdbcTemplate;
import com.alibaba.qwen.code.managedagent.persistence.ManagedWorkspaceRegistry;
import com.alibaba.qwen.code.managedagent.workspace.WorkspaceSelection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.function.Supplier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ManagedContextCompressionOperationTest {
    protected ManagedSchemaJdbcTemplate jdbc;
    protected ManagedAgentStore store;
    private TransactionTemplate transactions;
    protected String session;

    @BeforeEach
    void setUp() {
        var dataSource = testDataSource();
        ManagedSchema.initialize(dataSource);
        jdbc = new ManagedSchemaJdbcTemplate(dataSource);
        transactions = new TransactionTemplate(new DataSourceTransactionManager(dataSource));
        var properties = new ManagedAgentProperties();
        properties.getHarness().setWorkspaceFilesEnabled(true);
        store = new ManagedAgentStore(jdbc, new ObjectMapper(), Clock.systemUTC(),
                ignored -> {}, new ManagedWorkspaceRegistry(jdbc), properties);
        jdbc.update("INSERT INTO ma_workspace (tenant_id, workspace_id, workspace_generation, storage_id,"
                + " display_name, config_ref, policy_ref, state) VALUES ('tenant', 'workspace', 1, 'storage',"
                + " 'Workspace', 'config', 'policy', 'ACTIVE')");
        for (String actor : List.of("creator", "operator")) {
            jdbc.update("INSERT INTO ma_workspace_access (tenant_id, workspace_id, actor_id, role)"
                    + " VALUES (?, ?, ?, 'OPERATOR')", "tenant", "workspace", actor.getBytes(StandardCharsets.UTF_8));
        }
        session = tx(() -> store.insertWorkspaceSessionCommand("tenant", "creator", "create", "create-digest",
                "qwen-code", null, null, List.of(), null, new WorkspaceSelection("workspace", ".")).sessionId());
    }

    protected javax.sql.DataSource testDataSource() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:context-compression-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        return source;
    }

    @Test
    void durableAdmissionCreatesNoTurnAndHoldsTheExecutionBarrier() {
        var admission = admit("key", "digest", 0, true);
        assertThat(admission.operation().kind()).isEqualTo(OperationKind.CONTEXT_COMPRESSION);
        assertThat(admission.operation().state()).isEqualTo("PENDING");
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn", Integer.class)).isZero();
        assertThat(store.contextCompressionState("tenant", session).compactionRevision()).isZero();
        assertThat(store.contextCompressionState("tenant", session).operationId())
                .isEqualTo(admission.operation().operationId());
        assertThat(store.contextCompressionStates("tenant", List.of(session)).get(session))
                .isEqualTo(store.contextCompressionState("tenant", session));
        assertThatThrownBy(() -> tx(() -> store.insertTurnCommand("tenant", "SUBMIT", "turn", "digest",
                session, List.of(), "payload"))).isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("session_context_busy"));
        assertThat(store.requireSession("tenant", session).workspace().getContextRevision()).isEqualTo(1);
    }

    @Test
    void actorScopedReplayPrecedesMutableRoleCapabilityAndBusyChecks() {
        var first = admit("key", "digest", 0, true);
        jdbc.update("UPDATE ma_workspace_access SET role = 'READER' WHERE actor_id = ?",
                "operator".getBytes(StandardCharsets.UTF_8));
        var replay = admit("key", "digest", 0, false);
        assertThat(replay.replayed()).isTrue();
        assertThat(replay.operation().operationId()).isEqualTo(first.operation().operationId());
        assertThatThrownBy(() -> admit("key", "different", 0, false))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("idempotency_conflict"));
        assertThatThrownBy(() -> admit("other", "digest", 0, true))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("session_operation_forbidden"));
        jdbc.update("DELETE FROM ma_workspace_access WHERE actor_id = ?", "operator".getBytes(StandardCharsets.UTF_8));
        assertThatThrownBy(() -> admit("key", "digest", 0, true))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("session_not_found"));
    }

    @Test
    void staleCompactionRevisionAndConcurrentCompressionRefuse() {
        assertThatThrownBy(() -> admit("stale", "stale", 1, true))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("compaction_revision_conflict"));
        admit("first", "first", 0, true);
        assertThatThrownBy(() -> admit("second", "second", 0, true))
                .isInstanceOfSatisfying(ManagedAgentException.class,
                        error -> assertThat(error.getCode()).isEqualTo("session_context_busy"));
    }

    @Test
    void unknownAcceptanceIsDurableAndAStaleClaimCannotSettleIt() {
        String id = admit("first", "first", 0, true).operation().operationId();
        var first = tx(() -> store.claimContextCompression("tenant", session, id, "first", Duration.ofMinutes(1)))
                .orElseThrow();
        assertThat(tx(() -> store.markContextCompressionSubmitted(first, "first"))).isTrue();
        tx(() -> {
            store.awaitContextCompression(first, "first", false, null, 0);
            return null;
        });
        var parked = store.findOperation("tenant", session, id).orElseThrow();
        assertThat(parked.state()).isEqualTo("RECOVERY_BLOCKED");
        assertThat(parked.admissionStage()).isEqualTo("HARNESS_SUBMITTED");
        assertThat(parked.failureCode()).isEqualTo("context_compression_acceptance_unknown");
        var second = tx(() -> store.claimContextCompression("tenant", session, id, "second", Duration.ofMinutes(1)))
                .orElseThrow();
        assertThat(second.claimGeneration()).isGreaterThan(first.claimGeneration());
        assertThat(tx(() -> store.settleContextCompression(first, "first", "noop", null, null))).isFalse();
        assertThat(tx(() -> store.settleContextCompression(second, "second", "noop", null, null))).isTrue();
        assertThat(store.contextCompressionState("tenant", session).operationId()).isNull();
        assertThat(store.contextCompressionState("tenant", session).compactionRevision()).isZero();
    }

    @Test
    void aRevokedInitiatorIsRefusedBeforeSubmissionAndReleasesTheBarrier() {
        String id = admit("before-send", "before-send", 0, true).operation().operationId();
        var operation = tx(() -> store.claimContextCompression("tenant", session, id, "owner", Duration.ofMinutes(1)))
                .orElseThrow();
        jdbc.update("UPDATE ma_workspace_access SET role = 'READER' WHERE actor_id = ?",
                "operator".getBytes(StandardCharsets.UTF_8));
        assertThat(tx(() -> store.markContextCompressionSubmitted(operation, "owner"))).isFalse();
        assertThat(store.findOperation("tenant", session, id).orElseThrow().state()).isEqualTo("FAILED");
        assertThat(store.contextCompressionState("tenant", session).operationId()).isNull();
    }

    @Test
    void revokedInitiatorCannotSendOrCommitAndAcceptedWorkKeepsItsBarrier() {
        String id = admit("authority", "authority", 0, true).operation().operationId();
        var operation = tx(() -> store.claimContextCompression("tenant", session, id, "owner", Duration.ofMinutes(1)))
                .orElseThrow();
        assertThat(tx(() -> store.markContextCompressionSubmitted(operation, "owner"))).isTrue();
        jdbc.update("UPDATE ma_workspace_access SET role = 'READER' WHERE actor_id = ?",
                "operator".getBytes(StandardCharsets.UTF_8));
        assertThatThrownBy(() -> tx(() -> {
            store.requireContextCompressionCommit("tenant", session, id);
            return null;
        })).isInstanceOfSatisfying(ManagedAgentException.class,
                error -> assertThat(error.getCode()).isEqualTo("context_compression_authorization_revoked"));
        assertThat(store.contextCompressionState("tenant", session).operationId()).isEqualTo(id);
        jdbc.update("UPDATE ma_workspace_access SET role = 'OPERATOR' WHERE actor_id = ?",
                "operator".getBytes(StandardCharsets.UTF_8));
        tx(() -> {
            store.requireContextCompressionCommit("tenant", session, id);
            return null;
        });
    }

    protected com.alibaba.qwen.code.managedagent.model.StoreModels.OperationAdmission admit(
            String key, String digest, long revision, boolean supported) {
        return tx(() -> store.beginContextCompression("tenant", session, "operator", "operator-digest",
                key, digest, revision, supported));
    }

    protected <T> T tx(Supplier<T> action) {
        return transactions.execute(status -> action.get());
    }
}
