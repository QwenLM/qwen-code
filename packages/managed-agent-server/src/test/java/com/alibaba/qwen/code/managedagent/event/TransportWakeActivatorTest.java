package com.alibaba.qwen.code.managedagent.event;

import com.alibaba.qwen.code.managedagent.AutomationHarnessFake;
import com.alibaba.qwen.code.managedagent.event.TransportWakeActivator.LoadOutcome;
import com.alibaba.qwen.code.managedagent.event.TransportWakeActivator.Outcome;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.persistence.TransportConsumerStore;
import com.alibaba.qwen.code.managedagent.persistence.TransportConsumerStore.WakeFence;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.Executor;
import java.util.concurrent.RejectedExecutionException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class TransportWakeActivatorTest {
    private static final String DIGEST = "a".repeat(64);

    private TransportConsumerStore store;
    private HarnessConnector harness;
    private List<String> activated;
    private List<Runnable> queued;
    private TransportWakeActivator activator;

    private static ManagedEventEnvelope wake(long sequence) {
        return envelope("authoritative_journal", "wake.requested", sequence);
    }

    private static ManagedEventEnvelope envelope(String stream, String kind,
            long sequence) {
        return new ManagedEventEnvelope(1, "s1", "t1", "w1", stream, sequence,
                "evt-" + sequence, kind, 1_760_000_000_000L,
                new ManagedEventEnvelope.PayloadRef(DIGEST));
    }

    private static WakeFence fence(String status, String workspace,
            String state, long committed, boolean liveWriter) {
        return new WakeFence(status, workspace, state, committed, liveWriter);
    }

    private void fenceIs(String status, String workspace, String state,
            long committed, boolean liveWriter) {
        when(store.wakeFence("t1", "s1")).thenReturn(Optional.of(
                fence(status, workspace, state, committed, liveWriter)));
    }

    private void verifyNoAttempt() {
        verify(store, never()).claimWake(anyString(), anyString(), anyLong());
        verify(harness, never()).activateForWake(anyString(), anyString());
    }

    @BeforeEach
    void setUp() {
        store = mock(TransportConsumerStore.class);
        harness = mock(HarnessConnector.class);
        when(harness.isAvailable()).thenReturn(true);
        activated = new ArrayList<>();
        queued = new ArrayList<>();
        activator = new TransportWakeActivator(store, harness, activated::add,
                queued::add);
    }

    @Test
    void anUnownedWakeIsClaimedOnTheListenerAndLoadedOffIt() {
        fenceIs("ACTIVE", "w1", "SEALED", 5, false);
        when(store.claimWake("t1", "s1", 3)).thenReturn(true);
        when(harness.activateForWake("t1", "s1")).thenReturn(true);

        assertEquals(Outcome.SCHEDULED, activator.onWake(wake(3)));

        // Nothing loaded on the listener thread: the ordered lane moves on.
        verify(harness, never()).activateForWake(anyString(), anyString());
        assertEquals(1, queued.size());
        queued.getFirst().run();
        verify(harness).activateForWake("t1", "s1");
        assertEquals(List.of("s1"), activated);
    }

    @Test
    void aRedeliveredWakeIsANoOp() {
        fenceIs("ACTIVE", "w1", "ACTIVE", 5, false);
        when(store.claimWake("t1", "s1", 3)).thenReturn(false);

        assertEquals(Outcome.DUPLICATE, activator.onWake(wake(3)));

        assertEquals(List.of(), queued);
    }

    @Test
    void aWakeForAHeldSessionIsANoOpAndClaimsNothing() {
        fenceIs("ACTIVE", "w1", "ACTIVE", 5, true);

        assertEquals(Outcome.OWNED, activator.onWake(wake(3)));

        verifyNoAttempt();
    }

    @Test
    void aStaleWakeForASettledSessionIsANoOp() {
        for (String[] settled : new String[][] {
                {"CLOSED", "SEALED"}, {"CLOSING", "ACTIVE"},
                {"ACTIVE", "DELETING"}, {"ACTIVE", "DELETED"}}) {
            fenceIs(settled[0], "w1", settled[1], 5, false);

            assertEquals(Outcome.SETTLED, activator.onWake(wake(3)),
                    String.join("/", settled));
        }
        verifyNoAttempt();
    }

    @Test
    void aWakeSqlCannotShowIsANoOp() {
        when(store.wakeFence("t1", "s1")).thenReturn(Optional.empty());
        assertEquals(Outcome.UNKNOWN_SESSION, activator.onWake(wake(3)));

        fenceIs("ACTIVE", "w1", "ACTIVE", 2, false);
        assertEquals(Outcome.NOT_VISIBLE, activator.onWake(wake(3)));

        fenceIs("ACTIVE", "w-other", "ACTIVE", 5, false);
        assertEquals(Outcome.WORKSPACE_MISMATCH, activator.onWake(wake(3)));

        verifyNoAttempt();
    }

    @Test
    void onlyAJournalWakeIsThisRolesBusiness() {
        assertEquals(Outcome.NOT_A_WAKE, activator.onWake(
                envelope("authoritative_journal", "input.accepted", 3)));
        assertEquals(Outcome.NOT_A_WAKE, activator.onWake(
                envelope("public_event", "wake.requested", 3)));

        verify(store, never()).wakeFence(anyString(), anyString());
    }

    @Test
    void anUnavailableHarnessClaimsNothing() {
        fenceIs("ACTIVE", "w1", "SEALED", 5, false);
        when(harness.isAvailable()).thenReturn(false);

        assertEquals(Outcome.UNAVAILABLE, activator.onWake(wake(3)));

        verifyNoAttempt();
    }

    @Test
    void aFullLoadPoolDropsTheClaimedWakeToTheBackstop() {
        fenceIs("ACTIVE", "w1", "SEALED", 5, false);
        when(store.claimWake("t1", "s1", 3)).thenReturn(true);
        Executor full = command -> {
            throw new RejectedExecutionException("full");
        };
        TransportWakeActivator saturated = new TransportWakeActivator(store,
                harness, activated::add, full);

        assertEquals(Outcome.DROPPED, saturated.onWake(wake(3)));

        verify(harness, never()).activateForWake(anyString(), anyString());
    }

    @Test
    void aSessionAlreadyAttachedHereLoadsNothingAndSubscribesNothing() {
        when(harness.activateForWake("t1", "s1")).thenReturn(false);

        assertEquals(LoadOutcome.ALREADY_ATTACHED, activator.load(wake(3)));

        assertEquals(List.of(), activated);
    }

    // Whether another writer won is read from SQL after the failure, never
    // from the failure's status: a 409 also names a parked Turn.
    @Test
    void aFailedLoadIsFencedOnlyWhenSqlShowsAnotherWriter() {
        when(harness.activateForWake("t1", "s1")).thenThrow(
                AutomationHarnessFake.refusal(409, "writer_conflict"));

        when(store.wakeFence("t1", "s1")).thenReturn(Optional.of(
                fence("ACTIVE", "w1", "ACTIVE", 5, true)));
        assertEquals(LoadOutcome.FENCED, activator.load(wake(3)));

        when(store.wakeFence("t1", "s1")).thenReturn(Optional.of(
                fence("ACTIVE", "w1", "SEALED", 5, false)));
        assertEquals(LoadOutcome.FAILED, activator.load(wake(3)));

        when(store.wakeFence("t1", "s1")).thenThrow(
                new IllegalStateException("database down"));
        assertEquals(LoadOutcome.FAILED, activator.load(wake(3)));

        assertEquals(List.of(), activated);
    }
}
