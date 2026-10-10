package com.alibaba.qwen.code.managedagent.service;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.scheduling.annotation.Scheduled;

/**
 * The first pass after an operator opts in drains every Session with a
 * Snapshot, which on a large deployment takes minutes; the pass must run on
 * its own scheduler so the shared one-thread default pool keeps serving the
 * message materializer and the recovery ticks meanwhile.
 */
class ReplayFloorSchedulerTest {
    @Test
    void thePassDoesNotShareTheDefaultScheduler() throws Exception {
        Scheduled scheduled = ReplayFloorAdvancer.class.getMethod("advance")
                .getAnnotation(Scheduled.class);
        assertThat(scheduled.scheduler()).isEqualTo("replayFloorScheduler");
    }
}
