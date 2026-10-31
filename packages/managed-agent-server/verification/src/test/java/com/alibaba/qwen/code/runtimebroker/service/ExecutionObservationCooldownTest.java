package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.ExecutionReconciliation;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

/**
 * Unit coverage for the first P1 seam extracted from RuntimeBrokerService:
 * the UNKNOWN-lookup cooldown. The integrated behavior stays covered by
 * RuntimeBrokerServiceTest and RuntimeBrokerHttpServerTest.
 */
class ExecutionObservationCooldownTest {
    private final MutableClock clock = new MutableClock(Instant.parse("2026-10-31T00:00:00Z"));
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor();

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
    void theScheduledEvictionDropsTheEntryAfterTheWindow() throws Exception {
        ExecutionObservationCooldown cooldown = new ExecutionObservationCooldown(clock, scheduler);
        cooldown.stamp("exec-1", new ExecutionReconciliation(
                record(ToolExecutionRecord.State.SETTLED, 1),
                ExecutionReconciliation.Outcome.RESOLVED, "settled"));
        // The eviction consults the same clock as the reads: advance it past
        // the deadline so the scheduled task may drop the entry.
        clock.now = clock.now.plus(ExecutionObservationCooldown.WINDOW).plusMillis(50);
        Thread.sleep(ExecutionObservationCooldown.WINDOW.toMillis() + 300);
        // Rewind inside the original window: a surviving entry would answer
        // again, so null proves the eviction removed it rather than expiry.
        clock.now = clock.now.minus(ExecutionObservationCooldown.WINDOW);
        assertThat(cooldown.cooled("exec-1", record(ToolExecutionRecord.State.UNKNOWN, 1))).isNull();
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
