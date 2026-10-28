package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.harness.HarnessConnector;
import com.alibaba.qwen.code.managedagent.persistence.HostedCleanupDebtStore;
import com.alibaba.qwen.code.managedagent.persistence.HostedCleanupDebtStore.CleanupDebt;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;

import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * The scan's pacing and its stale-attachment escape: an owed debt is retried
 * through the cleanup load, a failed attempt waits before it is tried again,
 * and a cached attachment from the dead generation is dropped so the retry
 * performs its own load.
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
        when(store.findOwed(20)).thenReturn(List.of(debt(SESSION, OWNER, PROMPT)));
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
        when(store.findOwed(20)).thenReturn(List.of(debt(SESSION, OWNER, PROMPT)));
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
        when(store.findOwed(20)).thenReturn(List.of(debt(SESSION, OWNER, PROMPT)));
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
    void triesOneDebtPerSessionPerTick() {
        when(store.findOwed(20)).thenReturn(List.of(
                debt(SESSION, OWNER + "-a", "prompt-a"),
                debt(SESSION, OWNER + "-b", "prompt-b")));
        when(harness.isAvailable()).thenReturn(true);

        coordinator.retryOwedCleanup();

        verify(harness, times(1)).recheckRecoveryCleanup(anyString(), anyString(), anyString());
    }

    @Test
    void doesNothingWhileTheHarnessIsUnavailable() {
        when(harness.isAvailable()).thenReturn(false);

        coordinator.retryOwedCleanup();

        verify(store, never()).findOwed(20);
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
