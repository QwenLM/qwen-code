/**
 * Copyright 2026 Alibaba Group
 * SPDX-License-Identifier: Apache-2.0
 */

package com.alibaba.qwen.code.managedagent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

class SchedulerHoldTest {
    @Test
    @Timeout(15)
    void parksTheOnlyThreadUntilReleased() throws Exception {
        ExecutorService scheduler = Executors.newSingleThreadExecutor();
        try {
            CountDownLatch release = SchedulerHold.hold(scheduler, Duration.ofSeconds(5));
            CountDownLatch probe = new CountDownLatch(1);
            scheduler.execute(probe::countDown);
            assertThat(probe.await(200, TimeUnit.MILLISECONDS)).isFalse();
            release.countDown();
            assertThat(probe.await(5, TimeUnit.SECONDS)).isTrue();
        } finally {
            scheduler.shutdownNow();
        }
    }

    @Test
    @Timeout(15)
    void aHoldThatNeverTookLeavesTheThreadFree() throws Exception {
        ExecutorService scheduler = Executors.newSingleThreadExecutor();
        CountDownLatch busy = new CountDownLatch(1);
        try {
            scheduler.execute(() -> {
                try {
                    busy.await();
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            });
            assertThatThrownBy(() -> SchedulerHold.hold(scheduler, Duration.ofMillis(200)))
                    .isInstanceOf(AssertionError.class)
                    .hasMessageContaining("the scheduler takes the hold");
            // The refused hold runs once the busy task returns; it must not
            // park the thread with no caller left to let it go.
            busy.countDown();
            CountDownLatch probe = new CountDownLatch(1);
            scheduler.execute(probe::countDown);
            assertThat(probe.await(5, TimeUnit.SECONDS)).isTrue();
        } finally {
            busy.countDown();
            scheduler.shutdownNow();
        }
    }
}
