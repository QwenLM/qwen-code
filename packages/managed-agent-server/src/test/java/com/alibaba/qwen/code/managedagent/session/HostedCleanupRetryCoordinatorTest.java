package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.daemon.DaemonTransportException;
import com.alibaba.qwen.code.daemon.HostedHarnessGenerationException;
import com.alibaba.qwen.code.daemon.MutationOutcomeUnknownException;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.harness.HostedHarnessRecoveryDeclinedException;
import com.alibaba.qwen.code.managedagent.persistence.HostedCleanupDebtStore;
import com.alibaba.qwen.code.managedagent.persistence.HostedCleanupDebtStore.CleanupDebt;
import com.alibaba.qwen.code.managedagent.persistence.HostedCleanupDebtStore.ScanPage;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.http.HttpStatus;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Stream;

import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * The scan's pacing, its advancing cursor and its attachment-staleness
 * classification: an owed debt is retried through the cleanup load, a failed
 * attempt waits out an explicit backoff ladder that survives the debt leaving
 * the page, the cursor walks forward and wraps so a stuck prefix cannot starve
 * later debts, and only an unreachable generation — never a named refusal —
 * evicts the cached attachment.
 */
class HostedCleanupRetryCoordinatorTest {
    private static final String TENANT = "tenant-cleanup";
    private static final String SESSION = "session-cleanup";
    private static final String OWNER = "hosted-cleanup:owner";
    private static final String PROMPT = "prompt-cleanup";

    private final HostedCleanupDebtStore store = mock(HostedCleanupDebtStore.class);
    private final HarnessConnector harness = mock(HarnessConnector.class);
    private final AtomicLong now = new AtomicLong(1_000);
    private final HostedCleanupRetryCoordinator coordinator =
            new HostedCleanupRetryCoordinator(store, harness,
                    CoordinatorTestSupport.directExecutor(), clock());

    @Test
    void retriesAnOwedDebtThroughTheCleanupLoad() {
        when(store.findOwed(eq(20), anyLong(), anyString())).thenReturn(page(debt(SESSION, OWNER, PROMPT)));
        when(harness.isAvailable()).thenReturn(true);
        when(harness.recheckRecoveryCleanup(TENANT, SESSION, PROMPT)).thenReturn(true);

        coordinator.retryOwedCleanup();

        verify(harness).recheckRecoveryCleanup(TENANT, SESSION, PROMPT);
        verify(harness, never()).discardManagedRecovery(anyString(), anyString());

        // Accepted is not confirmed: the projection stays until the confirmed
        // event lands, so the next tick must wait out the initial delay.
        coordinator.retryOwedCleanup();
        verify(harness, times(1)).recheckRecoveryCleanup(TENANT, SESSION, PROMPT);
    }

    @Test
    void pacesAFailedAttemptUntilItsDelayElapses() {
        when(store.findOwed(eq(20), anyLong(), anyString())).thenReturn(page(debt(SESSION, OWNER, PROMPT)));
        when(harness.isAvailable()).thenReturn(true);
        when(harness.recheckRecoveryCleanup(TENANT, SESSION, PROMPT)).thenReturn(false);

        coordinator.retryOwedCleanup();
        coordinator.retryOwedCleanup();
        verify(harness, times(1)).recheckRecoveryCleanup(TENANT, SESSION, PROMPT);

        now.addAndGet(HostedCleanupRetryCoordinator.INITIAL_DELAY.toMillis());
        coordinator.retryOwedCleanup();
        verify(harness, times(2)).recheckRecoveryCleanup(TENANT, SESSION, PROMPT);
    }

    @Test
    void dropsAStaleAttachmentAndRetriesAfterBackoff() {
        when(store.findOwed(eq(20), anyLong(), anyString())).thenReturn(page(debt(SESSION, OWNER, PROMPT)));
        when(harness.isAvailable()).thenReturn(true);
        when(harness.recheckRecoveryCleanup(TENANT, SESSION, PROMPT))
                .thenThrow(mock(DaemonTransportException.class))
                .thenReturn(true);

        coordinator.retryOwedCleanup();
        verify(harness).discardManagedRecovery(TENANT, SESSION);

        now.addAndGet(HostedCleanupRetryCoordinator.INITIAL_DELAY.toMillis());
        coordinator.retryOwedCleanup();
        verify(harness, times(2)).recheckRecoveryCleanup(TENANT, SESSION, PROMPT);
    }

    @ParameterizedTest(name = "{0} evicts={2}")
    @MethodSource("attachmentCases")
    void classifiesAttachmentStaleness(String label, RuntimeException error, boolean evict) {
        HostedCleanupDebtStore localStore = mock(HostedCleanupDebtStore.class);
        HarnessConnector localHarness = mock(HarnessConnector.class);
        when(localStore.findOwed(eq(20), anyLong(), anyString()))
                .thenReturn(page(debt(SESSION, OWNER, PROMPT)));
        when(localHarness.isAvailable()).thenReturn(true);
        when(localHarness.recheckRecoveryCleanup(TENANT, SESSION, PROMPT)).thenThrow(error);
        var local = new HostedCleanupRetryCoordinator(localStore, localHarness,
                CoordinatorTestSupport.directExecutor(), clock());

        local.retryOwedCleanup();

        if (evict) {
            verify(localHarness).discardManagedRecovery(TENANT, SESSION);
        } else {
            verify(localHarness, never()).discardManagedRecovery(anyString(), anyString());
        }
    }

    static Stream<Arguments> attachmentCases() {
        return Stream.of(
                Arguments.of("transport", mock(DaemonTransportException.class), true),
                Arguments.of("generation", mock(HostedHarnessGenerationException.class), true),
                Arguments.of("unknown-outcome", mock(MutationOutcomeUnknownException.class), true),
                Arguments.of("http-404", httpStatus(404), true),
                Arguments.of("http-503", httpStatus(503), true),
                Arguments.of("http-409", httpStatus(409), false),
                Arguments.of("declined", new HostedHarnessRecoveryDeclinedException("await_action"), false),
                Arguments.of("pool-unavailable", new ManagedAgentException(
                        HttpStatus.SERVICE_UNAVAILABLE, "harness_pool_unavailable", "no owner"), false));
    }

    private static DaemonHttpException httpStatus(int status) {
        DaemonHttpException error = mock(DaemonHttpException.class);
        when(error.getStatusCode()).thenReturn(status);
        return error;
    }

    @Test
    void backoffSurvivesTheDebtLeavingThePage() {
        when(harness.isAvailable()).thenReturn(true);
        when(harness.recheckRecoveryCleanup(TENANT, SESSION, PROMPT)).thenReturn(false);
        CleanupDebt owed = debt(SESSION, OWNER, PROMPT);

        // Attempt 1 fails and backs off 10s.
        when(store.findOwed(eq(20), anyLong(), anyString())).thenReturn(page(owed));
        coordinator.retryOwedCleanup();
        // The debt is absent from the next page (the cursor moved past it). Its
        // pacing entry must survive: pruning by page membership would reset it.
        when(store.findOwed(eq(20), anyLong(), anyString())).thenReturn(page());
        coordinator.retryOwedCleanup();
        // Attempt 2 at +10s must inherit failure count 2 and back off 20s.
        now.addAndGet(HostedCleanupRetryCoordinator.INITIAL_DELAY.toMillis());
        when(store.findOwed(eq(20), anyLong(), anyString())).thenReturn(page(owed));
        coordinator.retryOwedCleanup();
        verify(harness, times(2)).recheckRecoveryCleanup(TENANT, SESSION, PROMPT);
        // At +20s a reset ladder would re-attempt (10s); the inherited 20s
        // backoff means this tick stays quiet.
        now.addAndGet(HostedCleanupRetryCoordinator.INITIAL_DELAY.toMillis());
        coordinator.retryOwedCleanup();
        verify(harness, times(2)).recheckRecoveryCleanup(TENANT, SESSION, PROMPT);
    }

    @Test
    void backoffLadderDoublesToTheCap() {
        when(harness.isAvailable()).thenReturn(true);
        when(harness.recheckRecoveryCleanup(TENANT, SESSION, PROMPT)).thenReturn(false);
        when(store.findOwed(eq(20), anyLong(), anyString()))
                .thenReturn(page(debt(SESSION, OWNER, PROMPT)));

        long[] ladder = {10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000};
        long due = now.get();
        for (int attempt = 0; attempt < ladder.length; attempt++) {
            now.set(due);
            coordinator.retryOwedCleanup();
            verify(harness, times(attempt + 1))
                    .recheckRecoveryCleanup(TENANT, SESSION, PROMPT);
            due += ladder[attempt];
        }
    }

    @Test
    void triesOneDebtPerSessionPerTick() {
        when(store.findOwed(eq(20), anyLong(), anyString())).thenReturn(page(
                debt(SESSION, OWNER + "-a", "prompt-a"),
                debt(SESSION, OWNER + "-b", "prompt-b")));
        when(harness.isAvailable()).thenReturn(true);

        coordinator.retryOwedCleanup();

        verify(harness, times(1)).recheckRecoveryCleanup(anyString(), anyString(), anyString());
    }

    @Test
    void advancesTheCursorAndWrapsWhenAPageIsShort() {
        when(harness.isAvailable()).thenReturn(true);
        when(harness.recheckRecoveryCleanup(anyString(), anyString(), anyString())).thenReturn(true);
        CleanupDebt first = debt(SESSION, OWNER + "-a", "prompt-a");
        CleanupDebt second = debt("session-b", OWNER + "-b", "prompt-b");
        when(store.findOwed(eq(20), eq(-1L), eq("")))
                .thenReturn(new ScanPage(List.of(first), 100, "owner-a", false));
        when(store.findOwed(eq(20), eq(100L), eq("owner-a")))
                .thenReturn(new ScanPage(List.of(second), 200, "owner-b", true));

        coordinator.retryOwedCleanup();
        coordinator.retryOwedCleanup();
        coordinator.retryOwedCleanup();

        // A full page advances the cursor; the short page that follows wraps it
        // back to the start, so the third tick reads the first page again.
        verify(store).findOwed(20, 100, "owner-a");
        verify(store, times(2)).findOwed(20, -1, "");
    }

    @Test
    void doesNothingWhileTheHarnessIsUnavailable() {
        when(harness.isAvailable()).thenReturn(false);

        coordinator.retryOwedCleanup();

        verify(store, never()).findOwed(anyInt(), anyLong(), anyString());
    }

    private static ScanPage page(CleanupDebt... debts) {
        return new ScanPage(List.of(debts), 0, "", true);
    }

    private static CleanupDebt debt(String session, String owner, String prompt) {
        return new CleanupDebt(TENANT, "workspace-cleanup", session, owner, prompt);
    }

    private Clock clock() {
        return new Clock() {
            @Override
            public ZoneId getZone() {
                return ZoneOffset.UTC;
            }

            @Override
            public Clock withZone(ZoneId zone) {
                return this;
            }

            @Override
            public Instant instant() {
                return Instant.ofEpochMilli(now.get());
            }

            @Override
            public long millis() {
                return now.get();
            }
        };
    }
}
