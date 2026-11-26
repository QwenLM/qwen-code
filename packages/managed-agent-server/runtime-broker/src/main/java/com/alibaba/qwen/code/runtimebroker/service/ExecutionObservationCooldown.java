package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.ExecutionReconciliation;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * The lookup cooldown shared by sequential execution observers.
 * A lookup that just ran is the freshest answer any sequential observer
 * can act on; without the cooldown every observation fans through to the
 * worker (issue #13183 saw hundreds of status calls per execution).
 *
 * <p>Extracted from {@link RuntimeBrokerService} as the first P1 internal
 * seam, now owned by RuntimeExecutionReconciler. The service owns the
 * scheduler this class schedules eviction on,
 * so the cooldown has no lifecycle of its own.
 */
final class ExecutionObservationCooldown {
    // Sequential observations inside this window share one Runtime lookup.
    static final Duration WINDOW = Duration.ofSeconds(1);

    private final ConcurrentMap<String, CooledObservation> entries =
            new ConcurrentHashMap<>();
    private final Clock clock;
    private final ScheduledExecutorService scheduler;

    ExecutionObservationCooldown(Clock clock, ScheduledExecutorService scheduler) {
        this.clock = clock;
        this.scheduler = scheduler;
    }

    /**
     * The cached answer to replay for a cooled execution, or null when the
     * caller must run a fresh lookup.
     */
    ExecutionReconciliation cooled(String executionId, ToolExecutionRecord current) {
        CooledObservation cooledObservation = entries.get(executionId);
        if (cooledObservation != null
                && clock.instant().isBefore(cooledObservation.deadline())) {
            ExecutionReconciliation cached = cooledObservation.reconciliation();
            if (cached.getRecord().isTerminal()) {
                return cached;
            }
            // A cancel can land between observations; keep the newer row.
            ToolExecutionRecord freshest =
                    cached.getRecord().getVersion() > current.getVersion()
                            ? cached.getRecord() : current;
            return new ExecutionReconciliation(freshest,
                    cached.getOutcome(),
                    cached.getRuntimeState());
        }
        return null;
    }

    void stamp(String executionId, ExecutionReconciliation reconciliation) {
        Instant deadline = clock.instant().plus(WINDOW);
        CooledObservation observation = new CooledObservation(reconciliation,
                deadline);
        entries.put(executionId, observation);
        try {
            // The eviction consults the same clock as the deadline check, so
            // a service clock that moves differently from the scheduler's
            // wall time can never evict an entry its reads still consider
            // fresh.
            scheduler.schedule(() -> {
                if (!clock.instant().isBefore(observation.deadline())) {
                    entries.remove(executionId, observation);
                }
            }, WINDOW.toMillis(), TimeUnit.MILLISECONDS);
        } catch (RuntimeException ignored) {
            // A closing service keeps no cooldown state.
            entries.remove(executionId, observation);
        }
    }

    private record CooledObservation(ExecutionReconciliation reconciliation,
            Instant deadline) {
    }
}
