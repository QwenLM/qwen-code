package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.daemon.DaemonHttpException;
import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.persistence.HostedCleanupDebtStore;
import com.alibaba.qwen.code.managedagent.persistence.HostedCleanupDebtStore.CleanupDebt;
import com.alibaba.qwen.code.managedagent.persistence.HostedCleanupDebtStore.ScanPage;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

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
 * The scan's pacing, its advancing cursor and its stale-attachment escape: an
 * owed debt is retried through the cleanup load, a failed attempt waits before
 * it is tried again, the cursor walks forward and wraps so a stuck prefix
 * cannot starve later debts, and a cached attachment from the dead generation
 * is dropped so the retry performs its own load.
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
                .thenThrow(new IllegalStateException("dead generation"))
                .thenReturn(true);

        coordinator.retryOwedCleanup();
        verify(harness).discardManagedRecovery(TENANT, SESSION);

        now.addAndGet(HostedCleanupRetryCoordinator.INITIAL_DELAY.toMillis());
        coordinator.retryOwedCleanup();
        verify(harness, times(2)).recheckRecoveryCleanup(TENANT, SESSION, PROMPT);
    }

    @Test
    void keepsTheAttachmentWhenTheHarnessNamesLiveWork() {
        when(store.findOwed(eq(20), anyLong(), anyString())).thenReturn(page(debt(SESSION, OWNER, PROMPT)));
        when(harness.isAvailable()).thenReturn(true);
        DaemonHttpException refusal = mock(DaemonHttpException.class);
        when(refusal.getStatusCode()).thenReturn(409);
        when(harness.recheckRecoveryCleanup(TENANT, SESSION, PROMPT))
                .thenThrow(refusal);

        coordinator.retryOwedCleanup();

        // A 409 means a Turn still owns the Session; evicting its attachment
        // would churn live work instead of waiting for it to settle.
        verify(harness, never()).discardManagedRecovery(anyString(), anyString());
    }

    @Test
    void dropsTheAttachmentWhenTheReferenceVanished() {
        when(store.findOwed(eq(20), anyLong(), anyString())).thenReturn(page(debt(SESSION, OWNER, PROMPT)));
        when(harness.isAvailable()).thenReturn(true);
        DaemonHttpException gone = mock(DaemonHttpException.class);
        when(gone.getStatusCode()).thenReturn(404);
        when(harness.recheckRecoveryCleanup(TENANT, SESSION, PROMPT))
                .thenThrow(gone);

        coordinator.retryOwedCleanup();

        verify(harness).discardManagedRecovery(TENANT, SESSION);
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
