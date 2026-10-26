package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector.RecoveryStatus;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnSummary;
import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStore;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.mockito.Mockito.when;

class SessionRecoveryServiceTest {
    private final ManagedAgentService sessions = mock(ManagedAgentService.class);
    private final AgentStateStore store = mock(AgentStateStore.class);
    private final HarnessCoordinator coordinator = mock(HarnessCoordinator.class);
    private final HarnessConnector harness = mock(HarnessConnector.class);
    private final SessionRecord session = new SessionRecord("tenant", "session",
            "qwen-code", "title", "ACTIVE", "boot", "epoch", 1, 1, 1, 1, null, 1);
    private JdbcTemplate jdbc;
    private SessionRecoveryService service;

    @BeforeEach
    void setup() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:session-recovery-" + UUID.randomUUID() + ";DB_CLOSE_DELAY=-1");
        jdbc = new JdbcTemplate(source);
        jdbc.execute("CREATE TABLE ma_session_head (tenant_id VARCHAR, session_id VARCHAR,"
                + " head_kind VARCHAR, recovery_status VARCHAR, recovery_detail_code VARCHAR)");
        jdbc.update("INSERT INTO ma_session_head VALUES (?, ?, ?, ?, ?)",
                "tenant", "session", "MANAGED_SESSION", "READY", null);
        when(sessions.requireReadableSession("tenant", "actor", "session")).thenReturn(session);
        when(store.findLatestTurns("tenant", List.of("session"))).thenReturn(Map.of());
        service = new SessionRecoveryService(sessions, store, coordinator, harness, jdbc, mock(ManagedSessionStore.class));
    }

    @Test
    void anEmptyNeverExecutedSessionIsReadyWithoutLoadingAnything() {
        jdbc.update("DELETE FROM ma_session_head");
        when(sessions.requireReadableSession("tenant", "actor", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", "title", "ACTIVE",
                        null, null, 0, 0, 1, 1, null, 1));
        var recovery = service.query("tenant", "actor", "session");
        assertThat(recovery.state()).isEqualTo("ready");
        assertThat(recovery.nextTurnAllowed()).isTrue();
        assertThat(recovery.turnId()).isNull();
        verifyNoInteractions(harness, coordinator);
    }

    @ParameterizedTest
    @ValueSource(strings = {"boot", "epoch", "both"})
    void aBoundSessionWithoutItsNativeHeadCannotUseEvenAWarmReadyCache(String identity) {
        jdbc.update("DELETE FROM ma_session_head");
        when(sessions.requireReadableSession("tenant", "actor", "session")).thenReturn(
                new SessionRecord("tenant", "session", "qwen-code", "title", "ACTIVE",
                        "epoch".equals(identity) ? null : "boot", "boot".equals(identity) ? null : "epoch",
                        0, 0, 1, 1, null, 1));
        when(harness.inspectRecovery("tenant", "session", null))
                .thenReturn(new RecoveryStatus("ready", null, null, true, true, true));
        var recovery = service.query("tenant", "actor", "session");
        assertThat(recovery.state()).isEqualTo("operator_required");
        assertThat(recovery.reasonCode()).isEqualTo("recovery_evidence_unavailable");
        assertThat(recovery.nextTurnAllowed()).isFalse();
        assertThat(recovery.actions().recheck()).isFalse();
        verifyNoInteractions(harness, coordinator);
    }

    @Test
    void ordinaryRunningWorkDoesNotBecomeARecoveryErrorOrRecheckTarget() {
        turn("RUNNING", null);
        var recovery = service.query("tenant", "actor", "session");
        assertThat(recovery.state()).isEqualTo("recovering");
        assertThat(recovery.reasonCode()).isEqualTo("turn_active");
        assertThat(recovery.actions().cancel()).isTrue();
        assertThat(recovery.actions().recheck()).isFalse();
        assertThat(recovery.nextTurnAllowed()).isFalse();
        assertThatThrownBy(() -> service.recheck("tenant", "actor", "session", "turn"))
                .isInstanceOf(ManagedAgentException.class)
                .hasMessage("This recovery has no existing work to recheck.");
        verifyNoInteractions(harness, coordinator);
    }

    @Test
    void anUnknownActiveExecutionKeepsItsPublicIdentityAndExistingRecheck() {
        turn("RUNNING", AgentStateStore.RUNTIME_RECOVERY_BLOCKED);
        var recovery = service.query("tenant", "actor", "session");
        assertThat(recovery.state()).isEqualTo("awaiting_evidence");
        assertThat(recovery.turnId()).isEqualTo("turn");
        assertThat(recovery.nextRecheckAt()).isEqualTo(10_000);
        assertThat(recovery.nextTurnAllowed()).isFalse();
        assertThat(recovery.actions().recheck()).isTrue();
        verify(harness).inspectRecovery("tenant", "session", "private-prompt");
        verifyNoInteractions(coordinator);
    }

    @ParameterizedTest
    @ValueSource(strings = {"RUNNING", "FAILED"})
    void nativeWorkKeepsARecoveryProjectionUntilItsOwnEvidenceSettles(String status) {
        turn(status, AgentStateStore.RUNTIME_RECOVERY_BLOCKED);
        when(harness.inspectRecovery("tenant", "session", "private-prompt"))
                .thenReturn(new RecoveryStatus("recovering", "turn_active", "private-prompt", false, false, false));
        var recovery = service.projection(session, "actor");
        assertThat(recovery).isNotNull();
        assertThat(recovery.reasonCode()).isEqualTo("harness_work_active");
        assertThat(recovery.nextTurnAllowed()).isFalse();
    }

    @Test
    void aColdHistoricalFailureOnlyOffersAProofCheckedCleanupRecheck() {
        turn("FAILED", "managed_runtime_recovery_blocked");
        var recovery = service.query("tenant", "actor", "session");
        assertThat(recovery.state()).isEqualTo("operator_required");
        assertThat(recovery.nextTurnAllowed()).isFalse();
        assertThat(recovery.actions().recheck()).isTrue();
        assertThat(recovery.actions().cancel()).isFalse();
        assertThat(recovery.actions().continueInNewSession()).isTrue();
        verifyNoInteractions(coordinator);
        verify(harness, never()).recheckRecoveryCleanup(anyString(), anyString(), anyString());
    }

    @Test
    void aHistoricalFailureWithAnUnsettledNativeInputCannotRequestCleanup() {
        turn("FAILED", "managed_runtime_recovery_blocked");
        when(harness.inspectRecovery("tenant", "session", "private-prompt"))
                .thenReturn(new RecoveryStatus("awaiting_evidence", "inputs_unsettled",
                        "private-prompt", false, false, false));
        assertThat(service.query("tenant", "actor", "session").actions().recheck()).isFalse();
        assertThatThrownBy(() -> service.recheck("tenant", "actor", "session", "turn"))
                .isInstanceOf(ManagedAgentException.class)
                .hasMessage("This recovery has no existing work to recheck.");
        verify(harness, never()).recheckRecoveryCleanup(anyString(), anyString(), anyString());
        verifyNoInteractions(coordinator);
    }

    @Test
    void aParkedWorkflowWithoutACancelHasNoAutomaticRecheckDriver() {
        turn("RUNNING", AgentStateStore.WORKFLOW_RECOVERY_BLOCKED);
        var recovery = service.query("tenant", "actor", "session");
        assertThat(recovery.actions().cancel()).isTrue();
        assertThat(recovery.actions().recheck()).isFalse();
        verifyNoInteractions(coordinator);
    }

    @Test
    void readyNeedsTheOriginalNativeTerminalAndAnAdmissibleContinuation() {
        turn("FAILED", "failure");
        when(harness.inspectRecovery("tenant", "session", "private-prompt"))
                .thenReturn(new RecoveryStatus("ready", "ready", "another-prompt", true, true, true))
                .thenReturn(new RecoveryStatus("ready", "ready", "private-prompt", false, true, true))
                .thenReturn(new RecoveryStatus("ready", "ready", "private-prompt", true, false, true))
                .thenReturn(new RecoveryStatus("operator_required", "inconsistent", "private-prompt", true, true, true))
                .thenReturn(new RecoveryStatus(null, "incomplete", "private-prompt", true, true, true))
                .thenReturn(new RecoveryStatus("ready", "ready", "private-prompt", true, true, true));
        assertThat(service.query("tenant", "actor", "session").nextTurnAllowed()).isFalse();
        assertThat(service.query("tenant", "actor", "session").nextTurnAllowed()).isFalse();
        assertThat(service.query("tenant", "actor", "session").nextTurnAllowed()).isFalse();
        assertThat(service.query("tenant", "actor", "session").nextTurnAllowed()).isFalse();
        assertThat(service.query("tenant", "actor", "session").nextTurnAllowed()).isFalse();
        assertThat(service.query("tenant", "actor", "session").nextTurnAllowed()).isTrue();
        verifyNoInteractions(coordinator);
    }

    @Test
    void nativeReadyStillWaitsForTheActiveJavaTurnToSettle() {
        turn("CANCELLING", null);
        when(harness.inspectRecovery("tenant", "session", "private-prompt"))
                .thenReturn(new RecoveryStatus("ready", "ready", "private-prompt", true, true, true));
        var recovery = service.query("tenant", "actor", "session");
        assertThat(recovery.state()).isEqualTo("recovering");
        assertThat(recovery.nextTurnAllowed()).isFalse();
    }

    @Test
    void anOriginalJournalBlockCannotBeResetByAHarnessRead() {
        turn("FAILED", "failure");
        jdbc.update("UPDATE ma_session_head SET recovery_status = ?, recovery_detail_code = ?",
                "BLOCKED_EXECUTION", "original_unproven");
        var recovery = service.query("tenant", "actor", "session");
        assertThat(recovery.state()).isEqualTo("operator_required");
        assertThat(recovery.reasonCode()).isEqualTo("original_unproven");
        assertThat(recovery.nextTurnAllowed()).isFalse();
        assertThat(recovery.actions().recheck()).isFalse();
        assertThatThrownBy(() -> service.recheck("tenant", "actor", "session", "turn"))
                .isInstanceOf(ManagedAgentException.class)
                .hasMessage("This recovery has no existing work to recheck.");
        assertThat(jdbc.queryForObject("SELECT recovery_status FROM ma_session_head", String.class))
                .isEqualTo("BLOCKED_EXECUTION");
        verifyNoInteractions(harness, coordinator);
    }

    @Test
    void aReadFailureCannotGrantReadiness() {
        turn("FAILED", "failure");
        when(harness.inspectRecovery(anyString(), anyString(), anyString()))
                .thenThrow(new IllegalStateException("unavailable"))
                .thenReturn(new RecoveryStatus("awaiting_evidence", "recovery_evidence_unavailable",
                        "private-prompt", true, false, false));
        var recovery = service.query("tenant", "actor", "session");
        assertThat(recovery.nextTurnAllowed()).isFalse();
        assertThat(recovery.actions().recheck()).isTrue();
        var unreadable = service.query("tenant", "actor", "session");
        assertThat(unreadable.state()).isEqualTo("operator_required");
        assertThat(unreadable.nextTurnAllowed()).isFalse();
        assertThat(unreadable.actions().recheck()).isTrue();
        verify(harness, never()).recheckRecoveryCleanup(anyString(), anyString(), anyString());
    }

    @Test
    void readerCanInspectButCannotRecheckOrCancel() {
        turn("RUNNING", AgentStateStore.RUNTIME_RECOVERY_BLOCKED);
        doThrow(new ManagedAgentException(HttpStatus.FORBIDDEN,
                "session_operation_forbidden", "Operator required"))
                .when(sessions).requireRecoveryOperator(session, "actor");
        var recovery = service.query("tenant", "actor", "session");
        assertThat(recovery.actions().recheck()).isFalse();
        assertThat(recovery.actions().cancel()).isFalse();
        assertThatThrownBy(() -> service.recheck("tenant", "actor", "session", "turn"))
                .isInstanceOf(ManagedAgentException.class)
                .hasMessage("Operator required");
        verifyNoInteractions(coordinator);
    }

    @Test
    void staleTurnRecheckCannotWakeTheNewTurn() {
        turn("CANCELLING", null);
        assertThatThrownBy(() -> service.recheck("tenant", "actor", "session", "old-turn"))
                .isInstanceOf(ManagedAgentException.class)
                .hasMessage("The Session's recovery Turn has changed.");
        verifyNoInteractions(harness, coordinator);
    }

    @Test
    void recheckOnlyWakesTheOriginalExistingRecoveryDriver() {
        turn("CANCELLING", null);
        when(coordinator.recheckRecovery("tenant", "session", "turn")).thenReturn(true);
        var recovery = service.recheck("tenant", "actor", "session", "turn");
        assertThat(recovery.nextTurnAllowed()).isFalse();
        verify(coordinator).recheckRecovery("tenant", "session", "turn");
        verify(harness, never()).recheckRecoveryCleanup(anyString(), anyString(), anyString());
    }

    @Test
    void cleanupRecheckRequiresTheOriginalSettledInput() {
        turn("FAILED", "failure");
        when(harness.inspectRecovery("tenant", "session", "private-prompt"))
                .thenReturn(new RecoveryStatus("cleanup_pending", "runtime_cleanup_pending",
                        "private-prompt", true, true, false));
        when(harness.recheckRecoveryCleanup("tenant", "session", "private-prompt")).thenReturn(true);
        var recovery = service.recheck("tenant", "actor", "session", "turn");
        assertThat(recovery.state()).isEqualTo("cleanup_pending");
        assertThat(recovery.nextTurnAllowed()).isFalse();
        verify(harness).recheckRecoveryCleanup("tenant", "session", "private-prompt");
    }

    @Test
    void aColdTerminalRecheckDelegatesOnlyItsOriginalPromptToProofCheckedCleanup() {
        turn("FAILED", "failure");
        when(harness.recheckRecoveryCleanup("tenant", "session", "private-prompt")).thenReturn(true);
        var recovery = service.recheck("tenant", "actor", "session", "turn");
        assertThat(recovery.state()).isEqualTo("operator_required");
        assertThat(recovery.nextTurnAllowed()).isFalse();
        verify(harness).recheckRecoveryCleanup("tenant", "session", "private-prompt");
        verifyNoInteractions(coordinator);
    }

    @Test
    void aColdCleanupRefusalCannotGrantReadinessOrWakeATurnDriver() {
        turn("FAILED", "failure");
        assertThatThrownBy(() -> service.recheck("tenant", "actor", "session", "turn"))
                .isInstanceOf(ManagedAgentException.class)
                .hasMessage("The original recovery work is not available.");
        assertThat(service.query("tenant", "actor", "session").nextTurnAllowed()).isFalse();
        verify(harness).recheckRecoveryCleanup("tenant", "session", "private-prompt");
        verifyNoInteractions(coordinator);
    }

    @Test
    void coldCleanupOnlyBecomesReadyAfterAffirmativeOriginalNativeEvidence() {
        turn("FAILED", "failure");
        when(harness.inspectRecovery("tenant", "session", "private-prompt"))
                .thenReturn(null)
                .thenReturn(new RecoveryStatus("ready", null, "private-prompt", true, true, true));
        when(harness.recheckRecoveryCleanup("tenant", "session", "private-prompt")).thenReturn(true);
        var recovery = service.recheck("tenant", "actor", "session", "turn");
        assertThat(recovery.state()).isEqualTo("ready");
        assertThat(recovery.nextTurnAllowed()).isTrue();
        verify(harness).recheckRecoveryCleanup("tenant", "session", "private-prompt");
        verifyNoInteractions(coordinator);
    }

    @Test
    void aRepeatedRecheckAfterTheOriginalTurnIsReadyHasNoEffect() {
        turn("FAILED", "failure");
        when(harness.inspectRecovery("tenant", "session", "private-prompt"))
                .thenReturn(new RecoveryStatus("ready", null, "private-prompt", true, true, true));
        assertThat(service.recheck("tenant", "actor", "session", "turn").state()).isEqualTo("ready");
        verifyNoInteractions(coordinator);
        verify(harness, never()).recheckRecoveryCleanup(anyString(), anyString(), anyString());
    }

    @ParameterizedTest
    @CsvSource({"coordinator,CANCELLED,ready", "coordinator,COMPLETED,ready", "cleanup,COMPLETED,ready",
            "coordinator,ACCEPTED,changed", "cleanup,ACCEPTED,changed",
            "coordinator,CANCELLED,unsettled", "coordinator,CANCELLED,blocked"})
    void recheckRevalidatesTheOriginalTargetWhenADriverRacesWithSettlement(
            String driver, String terminalStatus, String outcome) throws Exception {
        boolean cleanup = "cleanup".equals(driver);
        var latest = new AtomicReference<>(turn(cleanup ? "COMPLETED" : "CANCELLING", null));
        var nativeStatus = new AtomicReference<>(new RecoveryStatus(
                cleanup ? "cleanup_pending" : "awaiting_evidence",
                cleanup ? "runtime_cleanup_pending" : "inputs_unsettled", "private-prompt", cleanup, cleanup, false));
        when(store.findLatestTurns("tenant", List.of("session"))).thenAnswer(call -> {
            TurnRecord current = latest.get();
            return Map.of("session", new TurnSummary("session", current.turnId(), current.status(),
                    1, current.completedAt(), current.errorCode()));
        });
        when(store.findTurn("tenant", "session", "turn")).thenAnswer(call -> Optional.of(latest.get()));
        when(store.findTurn("tenant", "session", "new-turn")).thenAnswer(call -> Optional.of(latest.get()));
        when(harness.inspectRecovery("tenant", "session", "private-prompt")).thenAnswer(call -> nativeStatus.get());
        var started = new CountDownLatch(1);
        var finish = new CountDownLatch(1);
        org.mockito.stubbing.Answer<Boolean> refusedAfterSettlement = call -> {
            started.countDown();
            assertThat(finish.await(5, TimeUnit.SECONDS)).isTrue();
            return false;
        };
        if (cleanup) {
            when(harness.recheckRecoveryCleanup("tenant", "session", "private-prompt")).thenAnswer(refusedAfterSettlement);
        } else {
            when(coordinator.recheckRecovery("tenant", "session", "turn")).thenAnswer(refusedAfterSettlement);
        }
        try (var executor = Executors.newSingleThreadExecutor()) {
            try {
                var response = executor.submit(() -> service.recheck("tenant", "actor", "session", "turn"));
                assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();
                latest.set(record("changed".equals(outcome) ? "new-turn" : "turn", terminalStatus, null));
                if ("ready".equals(outcome)) {
                    nativeStatus.set(new RecoveryStatus("ready", null, "private-prompt", true, true, true));
                } else if ("blocked".equals(outcome)) {
                    jdbc.update("UPDATE ma_session_head SET recovery_status = 'BLOCKED_EXECUTION'");
                }
                finish.countDown();
                if ("ready".equals(outcome)) {
                    var recovery = response.get(5, TimeUnit.SECONDS);
                    assertThat(recovery.state()).isEqualTo("ready");
                    assertThat(recovery.turnId()).isEqualTo("turn");
                    assertThat(recovery.nextTurnAllowed()).isTrue();
                } else {
                    assertThatThrownBy(() -> response.get(5, TimeUnit.SECONDS))
                            .hasCauseInstanceOf(ManagedAgentException.class)
                            .hasRootCauseMessage("changed".equals(outcome)
                                    ? "The Session's recovery Turn has changed."
                                    : "The original recovery work is not available.");
                }
            } finally {
                finish.countDown();
            }
        }
        verify(coordinator, never()).recheckRecovery("tenant", "session", "new-turn");
        verify(harness, never()).recheckRecoveryCleanup("tenant", "session", "new-prompt");
        if (!cleanup) {
            verify(harness, never()).recheckRecoveryCleanup("tenant", "session", "private-prompt");
        }
    }

    @Test
    void foreignOrInvisibleSessionsNeverReachTheirEvidence() {
        when(sessions.requireReadableSession("foreign", "actor", "session"))
                .thenThrow(new ManagedAgentException(HttpStatus.NOT_FOUND,
                        "session_not_found", "Not found"));
        assertThatThrownBy(() -> service.query("foreign", "actor", "session"))
                .isInstanceOf(ManagedAgentException.class);
        verifyNoInteractions(harness, coordinator, store);
    }

    private TurnRecord turn(String state, String code) {
        var turn = record("turn", state, code);
        when(store.findLatestTurns("tenant", List.of("session"))).thenReturn(Map.of("session",
                new TurnSummary("session", "turn", state, 1, turn.completedAt(), code)));
        when(store.findTurn("tenant", "session", "turn")).thenReturn(Optional.of(turn));
        return turn;
    }

    private static TurnRecord record(String turnId, String state, String code) {
        return new TurnRecord("tenant", "session", turnId, "turn".equals(turnId) ? "private-prompt" : "new-prompt", List.of(),
                "digest", state, true, "epoch", 1L, null, null, 3, 3, 0, 10_000L,
                code, "original diagnostic", 1, 2, active(state) ? null : 2L, 1);
    }

    private static boolean active(String state) {
        return List.of("ACCEPTED", "RUNNING", "CANCELLING").contains(state);
    }
}
