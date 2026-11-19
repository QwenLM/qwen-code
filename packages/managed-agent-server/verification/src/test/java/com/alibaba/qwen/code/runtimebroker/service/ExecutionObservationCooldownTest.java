package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.ExecutionReconciliation;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Unit coverage for the first P1 seam extracted from RuntimeBrokerService:
 * the UNKNOWN-lookup cooldown. The integrated behavior stays covered by
 * RuntimeBrokerServiceTest, RuntimeBrokerHttpServerTest and the
 * Issue13183 regression/adversarial suites.
 */
class ExecutionObservationCooldownTest {
    private final MutableClock clock = new MutableClock(Instant.parse("2026-10-31T00:00:00Z"));
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();

    @AfterEach
    void tearDown() {
        scheduler.shutdownNow();
    }

    private static ToolExecutionRecord record(ToolExecutionRecord.State state, long version) {
        ToolExecutionRecord record = mock(ToolExecutionRecord.class);
        when(record.getState()).thenReturn(state);
        when(record.getVersion()).thenReturn(version);
        return record;
    }

    @Test
    void anEmptyCooldownSendsTheCallerToAFreshLookup() {
        ExecutionObservationCooldown cooldown = new ExecutionObservationCooldown(clock, scheduler);
        assertThat(cooldown.cooled("exec-1", record(ToolExecutionRecord.State.UNKNOWN, 1))).isNull();
    }

    @Test
    void aSettledCachedAnswerReplaysWhole() {
        ExecutionObservationCooldown cooldown = new ExecutionObservationCooldown(clock, scheduler);
        ExecutionReconciliation settled = new ExecutionReconciliation(
                record(ToolExecutionRecord.State.SETTLED, 9),
                ExecutionReconciliation.Outcome.RESOLVED, "settled");
        cooldown.stamp("exec-1", settled);
        assertThat(cooldown.cooled("exec-1", record(ToolExecutionRecord.State.UNKNOWN, 1)))
                .isSameAs(settled);
    }

    @Test
    void twoUnknownsServeTheFresherRecordWithTheCachedWorkerAnswer() {
        ExecutionObservationCooldown cooldown = new ExecutionObservationCooldown(clock, scheduler);
        ToolExecutionRecord cachedRecord = record(ToolExecutionRecord.State.UNKNOWN, 5);
        cooldown.stamp("exec-1", new ExecutionReconciliation(cachedRecord,
                ExecutionReconciliation.Outcome.UNRESOLVED, "executing"));
        ToolExecutionRecord olderCaller = record(ToolExecutionRecord.State.UNKNOWN, 3);
        ExecutionReconciliation fresherCached = cooldown.cooled("exec-1", olderCaller);
        assertThat(fresherCached.getRecord()).isSameAs(cachedRecord);
        assertThat(fresherCached.getOutcome()).isEqualTo(ExecutionReconciliation.Outcome.UNRESOLVED);
        assertThat(fresherCached.getRuntimeState()).isEqualTo("executing");
        ToolExecutionRecord newerCaller = record(ToolExecutionRecord.State.UNKNOWN, 7);
        assertThat(cooldown.cooled("exec-1", newerCaller).getRecord()).isSameAs(newerCaller);
    }

    @Test
    void anExpiredWindowSendsTheCallerToAFreshLookup() {
        ExecutionObservationCooldown cooldown = new ExecutionObservationCooldown(clock, scheduler);
        cooldown.stamp("exec-1", new ExecutionReconciliation(
                record(ToolExecutionRecord.State.UNKNOWN, 1),
                ExecutionReconciliation.Outcome.UNRESOLVED, null));
        clock.now = clock.now.plus(ExecutionObservationCooldown.WINDOW).plusMillis(1);
        assertThat(cooldown.cooled("exec-1", record(ToolExecutionRecord.State.UNKNOWN, 1))).isNull();
    }

    @Test
    void theScheduledEvictionDropsTheEntryOnceItsClockPassesTheDeadline() {
        CapturingScheduler capturing = new CapturingScheduler();
        try {
            ExecutionObservationCooldown cooldown = new ExecutionObservationCooldown(clock, capturing);
            cooldown.stamp("exec-1", new ExecutionReconciliation(
                    record(ToolExecutionRecord.State.SETTLED, 1),
                    ExecutionReconciliation.Outcome.RESOLVED, "settled"));
            assertThat(capturing.tasks).hasSize(1);
            // The eviction must be scheduled at the cooldown window itself,
            // asserted against the moved constant rather than a restated 1000.
            assertThat(capturing.delay).isEqualTo(ExecutionObservationCooldown.WINDOW.toMillis());
            assertThat(capturing.unit).isEqualTo(TimeUnit.MILLISECONDS);
            // Advance the shared clock past the deadline, then run the
            // captured eviction task explicitly: no wall-clock race.
            clock.now = clock.now.plus(ExecutionObservationCooldown.WINDOW).plusMillis(50);
            capturing.tasks.get(0).run();
            // Rewind inside the original window: a surviving entry would
            // answer again, so null proves the eviction removed the entry
            // rather than the read merely observing expiry.
            clock.now = clock.now.minus(ExecutionObservationCooldown.WINDOW);
            assertThat(cooldown.cooled("exec-1", record(ToolExecutionRecord.State.UNKNOWN, 1))).isNull();
        } finally {
            capturing.shutdownNow();
        }
    }

    @Test
    void theEvictionKeepsAnEntryItsOwnClockStillConsidersFresh() {
        CapturingScheduler capturing = new CapturingScheduler();
        try {
            ExecutionObservationCooldown cooldown = new ExecutionObservationCooldown(clock, capturing);
            ExecutionReconciliation settled = new ExecutionReconciliation(
                    record(ToolExecutionRecord.State.SETTLED, 1),
                    ExecutionReconciliation.Outcome.RESOLVED, "settled");
            cooldown.stamp("exec-1", settled);
            // The scheduler fires against a clock that has not moved: the
            // eviction must consult the same clock as the reads and refuse
            // to drop an entry those reads still consider fresh.
            capturing.tasks.get(0).run();
            assertThat(cooldown.cooled("exec-1", record(ToolExecutionRecord.State.UNKNOWN, 1)))
                    .isSameAs(settled);
        } finally {
            capturing.shutdownNow();
        }
    }

    @Test
    void aStaleEvictionDoesNotDeleteAFresherRestamp() {
        CapturingScheduler capturing = new CapturingScheduler();
        try {
            ExecutionObservationCooldown cooldown = new ExecutionObservationCooldown(clock, capturing);
            ExecutionReconciliation first = new ExecutionReconciliation(
                    record(ToolExecutionRecord.State.SETTLED, 1),
                    ExecutionReconciliation.Outcome.RESOLVED, "settled");
            cooldown.stamp("exec-1", first);
            // Re-stamp inside the first window: the second entry replaces the
            // first and carries a later deadline.
            clock.now = clock.now.plusMillis(900);
            ExecutionReconciliation second = new ExecutionReconciliation(
                    record(ToolExecutionRecord.State.SETTLED, 2),
                    ExecutionReconciliation.Outcome.RESOLVED, "settled");
            cooldown.stamp("exec-1", second);
            assertThat(capturing.tasks).hasSize(2);
            // Fire the FIRST eviction after its own deadline but before the
            // second entry's: the value-equal remove must leave the fresher
            // entry alone, or every observation in the restamped window's
            // second half fans through to the worker (issue #13183).
            clock.now = clock.now.plusMillis(150);
            capturing.tasks.get(0).run();
            assertThat(cooldown.cooled("exec-1", record(ToolExecutionRecord.State.UNKNOWN, 1)))
                    .isSameAs(second);
        } finally {
            capturing.shutdownNow();
        }
    }

    @Test
    void aClosingSchedulerKeepsNoCooldownState() {
        ScheduledExecutorService closing = Executors.newSingleThreadScheduledExecutor();
        closing.shutdownNow();
        ExecutionObservationCooldown cooldown = new ExecutionObservationCooldown(clock, closing);
        cooldown.stamp("exec-1", new ExecutionReconciliation(
                record(ToolExecutionRecord.State.SETTLED, 1),
                ExecutionReconciliation.Outcome.RESOLVED, "settled"));
        assertThat(cooldown.cooled("exec-1", record(ToolExecutionRecord.State.UNKNOWN, 1))).isNull();
    }

    /** Captures the cooldown's eviction tasks so tests run them deterministically. */
    private static final class CapturingScheduler extends ScheduledThreadPoolExecutor {
        private final List<Runnable> tasks = new ArrayList<>();
        private long delay;
        private TimeUnit unit;

        private CapturingScheduler() {
            super(1);
        }

        @Override
        public ScheduledFuture<?> schedule(Runnable command, long delay, TimeUnit unit) {
            tasks.add(command);
            this.delay = delay;
            this.unit = unit;
            return super.schedule(() -> { }, delay, unit);
        }
    }

    private static final class MutableClock extends Clock {
        private Instant now;

        private MutableClock(Instant now) {
            this.now = now;
        }

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
            return now;
        }
    }
}
