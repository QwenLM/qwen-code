package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.config.ManagedAgentProperties;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector.Admission;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector.Attachment;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector.RecoveryStatus;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector.SourceEvent;
import com.alibaba.qwen.code.managedagent.contracts.harness.HarnessConnector.SourceStream;
import com.alibaba.qwen.code.managedagent.contracts.harness.HostedHarnessRecoveryDeclinedException;
import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.contracts.workspace.RuntimeWarmer;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessHttpFailure;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessProtocolFailure;
import com.alibaba.qwen.code.managedagent.harness.contracts.HarnessRuntimeRecovery;
import com.alibaba.qwen.code.managedagent.model.StoreModels.HarnessEvent;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnRecord;
import com.alibaba.qwen.code.runtimebroker.managedworkspace.ContextBinding;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.InOrder;

import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.argThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class RecoverySettlementTest {
    @ParameterizedTest(name = "spent retries = {0}")
    @ValueSource(ints = {10, 42})
    void cancellationAdmissionAloneCannotFinishAnAdmittedWorkspaceTurn(int retries) {
        Fixture fixture = new Fixture(retries, "RUNNING", false);
        HarnessHttpFailure unavailable = mock(HarnessHttpFailure.class);
        when(unavailable.getStatusCode()).thenReturn(503);
        fixture.failRecovery(unavailable);

        fixture.dispatch();

        fixture.verifyParked();
        verify(fixture.harness).cancelManagedRuntime("tenant", "session", "original-prompt",
                "original-checkpoint", "original-activation");
        verify(fixture.store).markTurnFailureRecovery(eq("tenant"), eq("session"),
                eq("turn"), anyString(), argThat(message -> message.contains(
                        "hosted_harness_unavailable_after_admission")));
    }

    @ParameterizedTest
    @ValueSource(strings = {"protocol", "declined"})
    void terminalFailureAlsoWaitsForTheOriginalNativeInput(String kind) {
        Fixture fixture = new Fixture(0, "RUNNING", false);
        fixture.failRecovery("protocol".equals(kind)
                ? mock(HarnessProtocolFailure.class)
                : new HostedHarnessRecoveryDeclinedException("model_snapshot_missing"));

        fixture.dispatch();

        fixture.verifyParked();
        InOrder order = inOrder(fixture.store, fixture.harness);
        order.verify(fixture.store).markTurnFailureRecovery(eq("tenant"), eq("session"),
                eq("turn"), anyString(), anyString());
        order.verify(fixture.harness).recoverManagedFailureCancellation(eq("tenant"),
                eq("session"), eq("turn"), anyString(), eq("original-prompt"));
        order.verify(fixture.harness).cancelManagedRuntime("tenant", "session", "original-prompt",
                "original-checkpoint", "original-activation");
        order.verify(fixture.store).parkTurnForRuntimeRecovery(eq("tenant"), eq("session"),
                eq("turn"), anyString(), anyString(), anyLong());
    }

    @Test
    void aLiveResidentWithoutTakeoverWorkStillReceivesCancellation() {
        Fixture fixture = new Fixture(0, "RUNNING", false);
        fixture.failRecovery(mock(HarnessProtocolFailure.class));
        when(fixture.harness.recoverManagedFailureCancellation(eq("tenant"), eq("session"),
                eq("turn"), anyString(), eq("original-prompt"))).thenReturn(new Attachment("boot-old", null, 4L, "epoch-old"));

        fixture.dispatch();

        InOrder order = inOrder(fixture.store, fixture.harness);
        order.verify(fixture.store).markTurnFailureRecovery(eq("tenant"), eq("session"),
                eq("turn"), anyString(), anyString());
        order.verify(fixture.harness).recoverManagedFailureCancellation(eq("tenant"), eq("session"),
                eq("turn"), anyString(), eq("original-prompt"));
        order.verify(fixture.harness).cancelOriginalTurn("tenant", "session", "original-prompt");
        fixture.verifyParked();
    }

    @Test
    void aLostIntentWriteCannotIssueCancellation() {
        Fixture fixture = new Fixture(0, "RUNNING", false);
        fixture.failRecovery(mock(HarnessProtocolFailure.class));
        doReturn(false).when(fixture.store).markTurnFailureRecovery(anyString(), anyString(), anyString(),
                anyString(), anyString());

        fixture.dispatch();

        verify(fixture.harness, never()).recoverManagedFailureCancellation(anyString(),
                anyString(), anyString(), anyString(), anyString());
        verify(fixture.harness, never()).cancelManagedRuntime(anyString(), anyString(),
                anyString(), anyString(), anyString());
        fixture.verifyNoTerminalWrite();
        verify(fixture.store).releaseTurnLease(eq("tenant"), eq("session"), eq("turn"), anyString());
    }

    @Test
    void restartAfterTheIntentWriteOnlyReconcilesAndCancels() {
        Fixture fixture = new Fixture(10, "RUNNING", true);

        fixture.dispatch();

        fixture.verifyParked();
        verify(fixture.harness).discardManagedRecovery("tenant", "session");
        verify(fixture.harness, never()).recoverManagedRuntime(anyString(), anyString(), anyBoolean());
        verify(fixture.harness, never()).createOrLoad(anyString(), anyString(), anyBoolean());
        verify(fixture.harness, never()).continueManagedRuntime(anyString(), anyString(),
                anyString(), anyString(), anyString());
        verify(fixture.harness, never()).submit(anyString(), anyString(), anyString(), any(), anyString());
        verify(fixture.store).parkTurnForRuntimeRecovery(eq("tenant"), eq("session"), eq("turn"),
                anyString(), eq("hosted_harness_protocol_error: invalid response"), anyLong());
    }

    @ParameterizedTest
    @CsvSource({"false,true,original-prompt", "true,false,original-prompt", "true,true,other-prompt"})
    void partialOrForeignProofCannotFinishTheTurn(boolean settled, boolean continuation,
            String proofPrompt) {
        Fixture fixture = new Fixture(0, "RUNNING", false);
        fixture.failRecovery(mock(HarnessProtocolFailure.class));
        fixture.proof.set(new RecoveryStatus("awaiting_evidence", "unconfirmed", proofPrompt,
                settled, continuation, false));

        fixture.dispatch();

        fixture.verifyParked();
    }

    @Test
    void matchingProofProjectsTheNativeTailBeforeCompletingTheTurn() {
        Fixture fixture = new Fixture(0, "RUNNING", false);
        fixture.failRecovery(mock(HarnessProtocolFailure.class));
        doAnswer(invocation -> {
            fixture.proof.set(ready());
            return new Admission(5L, "epoch-new");
        }).when(fixture.harness).cancelManagedRuntime("tenant", "session", "original-prompt",
                "original-checkpoint", "original-activation");

        fixture.dispatch();

        InOrder order = inOrder(fixture.store, fixture.harness);
        order.verify(fixture.store).markTurnFailureRecovery(eq("tenant"), eq("session"),
                eq("turn"), anyString(), anyString());
        order.verify(fixture.harness).cancelManagedRuntime("tenant", "session", "original-prompt",
                "original-checkpoint", "original-activation");
        order.verify(fixture.harness).inspectRecovery("tenant", "session", "original-prompt");
        order.verify(fixture.harness).stream("tenant", "session", 4L, "epoch-old");
        fixture.verifyNativeCompletion("COMPLETED");
        verify(fixture.store, never()).parkTurnForRuntimeRecovery(anyString(), anyString(),
                anyString(), anyString(), anyString(), anyLong());
        verify(fixture.harness, never()).submit(anyString(), anyString(), anyString(), any(), anyString());
        verify(fixture.harness, never()).continueManagedRuntime(anyString(), anyString(),
                anyString(), anyString(), anyString());
    }

    @Test
    void alreadyCommittedProofDoesNotStopTheOriginalExecutionAgain() {
        Fixture fixture = new Fixture(0, "RUNNING", false);
        fixture.failRecovery(mock(HarnessProtocolFailure.class));
        fixture.proof.set(ready());

        fixture.dispatch();

        fixture.verifyNativeCompletion("COMPLETED");
        verify(fixture.harness, never()).recoverManagedFailureCancellation(anyString(),
                anyString(), anyString(), anyString(), anyString());
        fixture.dispatch();
        assertThat(fixture.recorded).filteredOn(event -> event.projection().type()
                .equals("item.output_text.delta")).hasSize(1);
        verify(fixture.harness, never()).cancelManagedRuntime(anyString(), anyString(),
                anyString(), anyString(), anyString());
    }

    @Test
    void matchingNativeProofCanSettleALostAdmissionResponse() {
        Fixture fixture = new Fixture(0, "RUNNING", false, false);
        fixture.failRecovery(mock(HarnessProtocolFailure.class));
        fixture.proof.set(ready());

        fixture.dispatch();

        fixture.verifyNativeCompletion("COMPLETED");
        verify(fixture.store).recordRecoveryAdmission(eq("tenant"), eq("session"), eq("turn"),
                anyString(), org.mockito.ArgumentMatchers.isNull(), eq("epoch-old"), eq("epoch-old"), eq(0L));
        verify(fixture.harness, never()).cancel(anyString(), anyString());
        verify(fixture.harness, never()).cancelManagedRuntime(anyString(), anyString(),
                anyString(), anyString(), anyString());
    }

    @Test
    void missingReadinessFieldsFromAnOldHarnessRemainBlocked() {
        Fixture fixture = new Fixture(0, "RUNNING", false);
        fixture.failRecovery(mock(HarnessProtocolFailure.class));
        fixture.proof.set(null);

        fixture.dispatch();

        fixture.verifyParked();
    }

    @Test
    void unreadableNativeEvidenceCannotBeConvertedIntoTerminalFailure() {
        Fixture fixture = new Fixture(0, "RUNNING", false);
        fixture.failRecovery(mock(HarnessProtocolFailure.class));
        when(fixture.harness.inspectRecovery("tenant", "session", "original-prompt"))
                .thenThrow(new IllegalStateException("evidence store unavailable"));

        fixture.dispatch();

        fixture.verifyParked();
        verify(fixture.harness, never()).cancelManagedRuntime(anyString(), anyString(),
                anyString(), anyString(), anyString());
    }

    @Test
    void aRestartAfterTheIntentProjectsOnlyTheCommittedTail() {
        Fixture fixture = new Fixture(0, "RUNNING", true);
        fixture.proof.set(ready());

        fixture.dispatch();

        fixture.verifyNativeCompletion("COMPLETED");
        verify(fixture.harness, never()).recoverManagedRuntime(anyString(), anyString(), anyBoolean());
        verify(fixture.harness, never()).submit(anyString(), anyString(), anyString(), any(), anyString());
        verify(fixture.harness, never()).continueManagedRuntime(anyString(), anyString(), anyString(),
                anyString(), anyString());
    }

    @Test
    void aTailReadFailureParksAndRetriesFromTheLastConsumedCursor() {
        Fixture fixture = new Fixture(0, "RUNNING", false);
        fixture.failRecovery(mock(HarnessProtocolFailure.class));
        fixture.proof.set(ready());
        fixture.failAfterChunk.set(true);

        fixture.dispatch();

        fixture.verifyParked();
        assertThat(fixture.recorded).hasSize(1);
        fixture.dispatch();
        fixture.verifyNativeCompletion("COMPLETED");
        verify(fixture.harness).stream("tenant", "session", 5L, "epoch-old");
        assertThat(fixture.recorded).filteredOn(event -> event.projection().type()
                .equals("item.output_text.delta")).hasSize(1);
    }

    @Test
    void aSafeInitialCancellationProjectsItsTerminalWithoutAContinuationCheckpoint() {
        Fixture fixture = new Fixture(0, "RUNNING", false, false);
        fixture.failRecovery(mock(HarnessProtocolFailure.class));
        fixture.proof.set(ready());
        fixture.tail = List.of(new SourceEvent(1L, "turn_complete", Map.of("stopReason", "cancelled"),
                "original-prompt", Map.of()));

        fixture.dispatch();

        fixture.verifyNativeCompletion("CANCELLED");
        verify(fixture.harness, never()).cancel(anyString(), anyString());
    }

    @Test
    void aUserCancellationProjectsItsActualTerminalInsteadOfAFailure() {
        Fixture fixture = new Fixture(0, "CANCELLING", false);
        fixture.failRecovery(mock(HarnessProtocolFailure.class));
        fixture.proof.set(ready());
        fixture.tail = List.of(new SourceEvent(5L, "turn_complete", Map.of("stopReason", "cancelled"),
                "original-prompt", Map.of()));

        fixture.dispatch();

        fixture.verifyNoTerminalWrite();
        fixture.verifyNativeCompletion("CANCELLED");
        verify(fixture.store, never()).markTurnFailureRecovery(anyString(), anyString(),
                anyString(), anyString(), anyString());
        verify(fixture.store, never()).scheduleTurnRetry(anyString(), anyString(), anyString(),
                anyString(), anyLong(), anyBoolean());
        verify(fixture.harness, never()).recoverManagedFailureCancellation(anyString(),
                anyString(), anyString(), anyString(), anyString());
    }

    private static RecoveryStatus ready() {
        return new RecoveryStatus("ready", null, "original-prompt", true, true, true);
    }

    private static final class Fixture {
        private final AgentStateStore store = mock(AgentStateStore.class);
        private final HarnessConnector harness = mock(HarnessConnector.class);
        private final TurnRecord turn;
        private final AtomicReference<TurnRecord> current = new AtomicReference<>();
        private final List<HarnessEvent> recorded = new ArrayList<>();
        private final AtomicBoolean failAfterChunk = new AtomicBoolean();
        private List<SourceEvent> tail = List.of(new SourceEvent(5L, "session_update",
                        Map.of("update", Map.of("sessionUpdate", "agent_message_chunk",
                                "content", Map.of("type", "text", "text", "native final output"))),
                        "original-prompt", Map.of()),
                new SourceEvent(6L, "turn_complete", Map.of("stopReason", "end_turn"),
                        "original-prompt", Map.of()));
        private final AtomicReference<RecoveryStatus> proof = new AtomicReference<>(
                new RecoveryStatus("awaiting_evidence", "original_input_unsettled", "original-prompt",
                        false, false, false));

        private Fixture(int retries, String status, boolean cancellationOnly) {
            this(retries, status, cancellationOnly, true);
        }

        private Fixture(int retries, String status, boolean cancellationOnly, boolean acknowledged) {
            turn = new TurnRecord("tenant", "session", "turn", "original-prompt",
                    List.of(Map.of("type", "text", "text", "recover")), "sha256:" + "a".repeat(64),
                    status, true, acknowledged ? "epoch-old" : null,
                    acknowledged ? 4L : null, "previous-owner", Long.MAX_VALUE,
                    retries, retries, 0, null,
                    cancellationOnly ? AgentStateStore.RUNTIME_RECOVERY_BLOCKED : null,
                    cancellationOnly ? "hosted_harness_protocol_error: invalid response" : null,
                    1, 1, null, 1);
            current.set(turn);
            when(store.claimTurn(eq("tenant"), eq("session"), eq("turn"), anyString(),
                    any(Duration.class))).thenAnswer(invocation -> List.of("ACCEPTED", "RUNNING", "CANCELLING")
                    .contains(current.get().status()) ? Optional.of(current.get()) : Optional.empty());
            when(store.findTurn("tenant", "session", "turn")).thenAnswer(invocation -> Optional.of(current.get()));
            when(store.requireSession("tenant", "session")).thenReturn(new SessionRecord(
                    "tenant", "session", "qwen-code", null, null, "ACTIVE", "boot-old", "epoch-old",
                    4, 4, 0, 1, 1, null, 1,
                    new ContextBinding("tenant", "ws-a", 1, "storage-a", ".", "config-a", 1),
                    "default", "hosted-workspace-shell/1"));
            doAnswer(invocation -> {
                TurnRecord value = current.get();
                current.set(copy(value, value.status(), value.harnessEventEpoch(), value.harnessLastEventId(),
                        AgentStateStore.RUNTIME_RECOVERY_BLOCKED, invocation.getArgument(4)));
                return true;
            }).when(store).markTurnFailureRecovery(anyString(), anyString(), anyString(), anyString(), anyString());
            when(store.parkTurnForRuntimeRecovery(anyString(), anyString(), anyString(),
                    anyString(), anyString(), anyLong())).thenReturn(true);
            when(store.failRecoveryBlockedTurn(anyString(), anyString(), anyString(), anyString(),
                    anyString())).thenReturn(true);
            when(harness.isWorkspaceFilesAvailable()).thenReturn(true);
            when(harness.inspectRecovery("tenant", "session", "original-prompt"))
                    .thenAnswer(invocation -> proof.get());
            when(harness.cachedRecoveryAttachment("tenant", "session"))
                    .thenReturn(new Attachment("boot-old", null, 6L, "epoch-old"));
            when(store.bindRecoveredHarness(eq("tenant"), eq("session"), eq("turn"), anyString(),
                    eq("boot-old"), eq("boot-old"))).thenReturn(true);
            doAnswer(invocation -> {
                TurnRecord value = current.get();
                current.set(copy(value, value.status(), invocation.getArgument(6), invocation.getArgument(7),
                        value.errorCode(), value.errorMessage()));
                return null;
            }).when(store).recordRecoveryAdmission(anyString(), anyString(), anyString(), anyString(),
                    org.mockito.ArgumentMatchers.nullable(String.class), anyString(), anyString(), anyLong());
            doAnswer(invocation -> {
                List<HarnessEvent> batch = invocation.getArgument(5);
                recorded.addAll(batch);
                HarnessEvent last = batch.getLast();
                TurnRecord value = current.get();
                current.set(copy(value, last.projection() != null && last.projection().terminal()
                                ? last.projection().terminalStatus() : value.status(),
                        value.harnessEventEpoch(), last.sourceId(), value.errorCode(), value.errorMessage()));
                return null;
            }).when(store).recordHarnessEvents(anyString(), anyString(), anyString(), anyString(),
                    anyString(), any());
            when(harness.stream(eq("tenant"), eq("session"), anyLong(), eq("epoch-old")))
                    .thenAnswer(invocation -> {
                        long cursor = invocation.getArgument(2);
                        List<SourceEvent> pending = tail.stream().filter(event -> event.id() > cursor).toList();
                        return new SourceStream() {
                            private int index;
                            public String eventEpoch() { return "epoch-old"; }
                            public SourceEvent next() {
                                if (index == 1 && failAfterChunk.compareAndSet(true, false)) {
                                    throw new IllegalStateException("native tail unavailable");
                                }
                                return index < pending.size() ? pending.get(index++) : null;
                            }
                            public void close() { }
                        };
                    });
            HarnessRuntimeRecovery cancellation = mock(HarnessRuntimeRecovery.class);
            when(cancellation.isCancellationReady()).thenReturn(true);
            when(cancellation.getCheckpointId()).thenReturn("original-checkpoint");
            when(cancellation.getActivationId()).thenReturn("original-activation");
            when(harness.recoverManagedFailureCancellation(eq("tenant"), eq("session"),
                    eq("turn"), anyString(), eq("original-prompt")))
                    .thenReturn(new Attachment("boot-new", cancellation, 4L, "epoch-new"));
            when(harness.cancelManagedRuntime("tenant", "session", "original-prompt",
                    "original-checkpoint", "original-activation")).thenReturn(new Admission(5L, "epoch-new"));
        }

        private void failRecovery(RuntimeException failure) {
            if ("CANCELLING".equals(turn.status())) {
                when(harness.recoverManagedRuntime("tenant", "session", true, turn.promptId()))
                        .thenThrow(failure);
            } else {
                when(harness.recoverManagedRuntime("tenant", "session", false)).thenThrow(failure);
            }
        }

        private void dispatch() {
            HarnessCoordinator coordinator = new HarnessCoordinator(store, harness,
                    new HarnessEventProjector(), mock(RuntimeWarmer.class),
                    CoordinatorTestSupport.directExecutor(), Clock.systemUTC(), new ManagedAgentProperties());
            try {
                coordinator.dispatch("tenant", "session", "turn");
            } finally {
                coordinator.close();
            }
            verify(harness, never()).cancel(anyString(), anyString());
            verify(harness, never()).recoverManagedCancellation(anyString(), anyString());
            verify(harness, never()).recoverManagedFailureCancellation(anyString(), anyString(), anyString(), anyString());
            verify(harness, never()).recoverManagedRuntime(anyString(), anyString(), eq(true));
        }

        private void verifyParked() {
            verifyNoTerminalWrite();
            verify(store).parkTurnForRuntimeRecovery(eq("tenant"), eq("session"), eq("turn"),
                    anyString(), anyString(), anyLong());
            verify(store, never()).scheduleTurnRetry(anyString(), anyString(), anyString(),
                    anyString(), anyLong(), anyBoolean());
        }

        private void verifyNoTerminalWrite() {
            verify(store, never()).failTurn(anyString(), anyString(), anyString(), anyString(),
                    anyString(), anyString());
            verify(store, never()).failRecoveryBlockedTurn(anyString(), anyString(), anyString(),
                    anyString(), anyString());
        }

        private void verifyNativeCompletion(String expected) {
            assertThat(current.get().status()).isEqualTo(expected);
            assertThat(recorded).anySatisfy(event -> assertThat(event.projection().terminalStatus()).isEqualTo(expected));
            if ("COMPLETED".equals(expected)) {
                assertThat(recorded).filteredOn(event -> "item.output_text.delta".equals(event.projection().type()))
                        .extracting(event -> event.projection().data().get("text"))
                        .containsExactly("native final output");
            }
            verifyNoTerminalWrite();
        }

        private static TurnRecord copy(TurnRecord value, String status, String epoch, Long cursor,
                String errorCode, String message) {
            return new TurnRecord(value.tenantId(), value.sessionId(), value.turnId(), value.promptId(),
                    value.input(), value.payloadDigest(), status, value.submissionAttempted(), epoch, cursor,
                    value.dispatchOwner(), value.dispatchLeaseUntil(), value.retryCount(), value.consecutiveFailures(),
                    value.budgetExemptFailures(), value.retryAfter(), errorCode, message, value.createdAt(),
                    value.updatedAt(), value.completedAt(), value.version());
        }
    }
}
