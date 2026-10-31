package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.model.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.model.StoreModels.HarnessEvent;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ProjectedEvent;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnRecord;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import javax.sql.DataSource;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

class RecoverySettlementStoreTest {
    protected static final String TENANT = "tenant-recovery";
    protected static final String OWNER = "original-owner";
    protected JdbcTemplate jdbc;
    protected ManagedAgentStore store;
    protected TransactionTemplate transactions;
    protected String sessionId;
    protected String turnId;
    private final Clock clock = Clock.fixed(Instant.now(), ZoneOffset.UTC);

    protected DataSource dataSource() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:recovery-settlement-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE;LOCK_TIMEOUT=10000");
        return source;
    }

    @BeforeEach
    void setUp() {
        DataSource source = dataSource();
        ManagedSchema.initialize(source);
        jdbc = new ManagedSchemaJdbcTemplate(source);
        transactions = new TransactionTemplate(new DataSourceTransactionManager(source));
        store = newStore();
        transactions.executeWithoutResult(status -> {
            Admission session = store.insertSessionCommand(TENANT, "CREATE_SESSION", "create-key",
                    "create-digest", "qwen-code", "1", null, List.of(), null);
            sessionId = session.sessionId();
            turnId = store.insertTurnCommand(TENANT, "SUBMIT_TURN", "submit-key", "submit-digest",
                    sessionId, List.of(Map.of("type", "text", "text", "task")), "payload").turnId();
            assertThat(store.claimTurn(TENANT, sessionId, turnId, OWNER, Duration.ofMinutes(1)))
                    .isPresent();
            store.markSubmissionAttempted(TENANT, sessionId, turnId, OWNER);
            store.recordAdmission(TENANT, sessionId, turnId, OWNER, "epoch-original", 1);
        });
    }

    @Test
    void intentSurvivesAStoreRestartWithoutReleasingItsLiveOwner() {
        TurnRecord before = turn();

        mark();
        ManagedAgentStore restarted = newStore();
        TurnRecord saved = restarted.findTurn(TENANT, sessionId, turnId).orElseThrow();

        assertThat(saved.status()).isEqualTo("RUNNING");
        assertThat(saved.errorCode()).isEqualTo(AgentStateStore.RUNTIME_RECOVERY_BLOCKED);
        assertThat(saved.errorMessage()).isEqualTo("hosted_harness_protocol_error: invalid response");
        assertThat(saved.dispatchOwner()).isEqualTo(OWNER);
        assertThat(saved.dispatchLeaseUntil()).isEqualTo(before.dispatchLeaseUntil());
        assertThat(saved.retryCount()).isEqualTo(before.retryCount());
        assertThat(saved.consecutiveFailures()).isEqualTo(before.consecutiveFailures());
    }

    @Test
    void repeatedRechecksPreserveTheFailureBudgetAndOriginalDiagnostic() {
        jdbc.update("UPDATE ma_turn SET retry_count=12, consecutive_failures=9,"
                + " budget_exempt_failures=2 WHERE turn_id=?", turnId);
        mark();
        transactions.executeWithoutResult(status -> {
            assertThat(store.markTurnFailureRecovery(TENANT, sessionId, turnId, OWNER,
                    "a later transient read failed")).isTrue();
            assertThat(store.parkTurnForRuntimeRecovery(TENANT, sessionId, turnId, OWNER,
                    turn().errorMessage(), clock.millis() + 60_000)).isTrue();
        });
        TurnRecord parked = turn();
        assertThat(parked.dispatchOwner()).isNull();
        Boolean firstRecheck = transactions.execute(
                status -> store.requestRecoveryRecheck(TENANT, sessionId, turnId));
        assertThat(firstRecheck).isTrue();
        TurnRecord first = turn();
        Boolean secondRecheck = transactions.execute(
                status -> store.requestRecoveryRecheck(TENANT, sessionId, turnId));
        assertThat(secondRecheck).isTrue();
        TurnRecord repeated = turn();

        assertThat(repeated.errorMessage()).isEqualTo(parked.errorMessage());
        assertThat(repeated.retryCount()).isEqualTo(12);
        assertThat(repeated.consecutiveFailures()).isEqualTo(9);
        assertThat(repeated.budgetExemptFailures()).isEqualTo(2);
        assertThat(repeated.retryAfter()).isEqualTo(clock.millis());
        assertThat(repeated.version()).isEqualTo(first.version());
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void staleOwnersAndExpiredLeasesCannotMarkOrFinish(boolean expired) {
        String owner = expired ? OWNER : "stale-owner";
        if (expired) {
            jdbc.update("UPDATE ma_turn SET dispatch_lease_until=? WHERE turn_id=?", clock.millis() - 1, turnId);
        }

        transactions.executeWithoutResult(status -> {
            assertThat(store.markTurnFailureRecovery(TENANT, sessionId, turnId, owner, "failure"))
                    .isFalse();
            assertThat(store.failRecoveryBlockedTurn(TENANT, sessionId, turnId, owner, "failure"))
                    .isFalse();
        });
        assertThatThrownBy(() -> transactions.executeWithoutResult(status ->
                store.recordHarnessEvents(TENANT, sessionId, turnId, owner, "epoch-original",
                        List.of(terminal("turn.completed", "COMPLETED")))))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("lease was lost");

        assertThat(turn().status()).isEqualTo("RUNNING");
        assertThat(turn().errorCode()).isNull();
        assertNoFailureEvent();
    }

    @Test
    void aUserCancellationCommittedAfterTheIntentCannotBeOverwritten() {
        mark();
        cancel();

        transactions.executeWithoutResult(status -> {
            assertThat(store.markTurnFailureRecovery(TENANT, sessionId, turnId, OWNER, "new failure"))
                    .isFalse();
            assertThat(store.failRecoveryBlockedTurn(TENANT, sessionId, turnId, OWNER, "failure"))
                    .isFalse();
        });

        assertThat(turn().status()).isEqualTo("CANCELLING");
        assertNoFailureEvent();
    }

    @Test
    void nativeTailIsProjectedOnceUnderTheOriginalLease() {
        mark();
        HarnessEvent chunk = new HarnessEvent(2, "boot:epoch-original:2",
                new ProjectedEvent("item.output_text.delta", Map.of("text", "native final output"),
                        false, null, null, null));
        transactions.executeWithoutResult(status -> {
            store.recordHarnessEvents(TENANT, sessionId, turnId, OWNER, "epoch-original", List.of(chunk));
            store.recordHarnessEvents(TENANT, sessionId, turnId, OWNER, "epoch-original", List.of(chunk));
            store.recordHarnessEvents(TENANT, sessionId, turnId, OWNER, "epoch-original",
                    List.of(new HarnessEvent(3, "boot:epoch-original:3",
                            new ProjectedEvent("turn.completed", Map.of(), true, "COMPLETED", null, null))));
        });
        assertThatThrownBy(() -> transactions.executeWithoutResult(status ->
                store.recordHarnessEvents(TENANT, sessionId, turnId, OWNER, "epoch-original",
                        List.of(terminal("turn.completed", "COMPLETED")))))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("lease was lost");
        assertThat(turn().status()).isEqualTo("COMPLETED");
        assertThat(turn().dispatchOwner()).isNull();
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_public_event WHERE session_id=?"
                + " AND event_type='turn.completed'", Integer.class, sessionId)).isEqualTo(1);
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_public_event WHERE session_id=?"
                + " AND event_type='item.output_text.delta'", Integer.class, sessionId)).isEqualTo(1);
        assertNoFailureEvent();
    }

    protected void mark() {
        transactions.executeWithoutResult(status -> assertThat(store.markTurnFailureRecovery(TENANT,
                sessionId, turnId, OWNER, "hosted_harness_protocol_error: invalid response")).isTrue());
    }

    protected void cancel() {
        transactions.executeWithoutResult(status -> assertThat(store.insertCancelCommand(TENANT,
                "CANCEL_TURN", "cancel-key", "cancel-digest", sessionId, turnId).commandEffect()).isTrue());
    }

    protected TurnRecord turn() {
        return store.findTurn(TENANT, sessionId, turnId).orElseThrow();
    }

    protected void assertNoFailureEvent() {
        assertThat(jdbc.queryForObject("SELECT COUNT(*) FROM ma_public_event WHERE session_id=?"
                + " AND event_type='turn.failed'", Integer.class, sessionId)).isZero();
    }

    protected HarnessEvent terminal(String type, String status) {
        return new HarnessEvent(2, "boot:epoch-original:2",
                new ProjectedEvent(type, Map.of(), true, status, null, null));
    }

    private ManagedAgentStore newStore() {
        return com.alibaba.qwen.code.managedagent.VerificationFixtures.configure(new ManagedAgentStore(jdbc, new ObjectMapper(), clock, events -> {},
                mock(ManagedWorkspaceRegistry.class), new ManagedAgentProperties(), new com.alibaba.qwen.code.managedagent.harness.SdkHarnessRules()));
    }
}
