/**
 * Copyright 2026 Alibaba Group
 * SPDX-License-Identifier: Apache-2.0
 */

package com.alibaba.qwen.code.managedagent;

import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/** Parks a task on a single-thread scheduler until the caller lets it go. */
final class SchedulerHold {
    private SchedulerHold() {
    }

    /**
     * Returns the latch that lets the parked task go, once that task has
     * taken the scheduler's only thread. Fails if it has not taken it
     * within {@code takeWithin}.
     */
    static CountDownLatch hold(Executor scheduler, Duration takeWithin) throws InterruptedException {
        CountDownLatch held = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        scheduler.execute(() -> {
            held.countDown();
            try {
                release.await();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        });
        boolean taken = false;
        try {
            taken = held.await(takeWithin.toMillis(), TimeUnit.MILLISECONDS);
        } finally {
            // A hold that never took is still queued: released here, it
            // returns as soon as it runs instead of parking the scheduler's
            // only thread with no caller left to let it go.
            if (!taken) {
                release.countDown();
            }
        }
        assertThat(taken)
                .as("the scheduler takes the hold")
                .isTrue();
        return release;
    }
}
