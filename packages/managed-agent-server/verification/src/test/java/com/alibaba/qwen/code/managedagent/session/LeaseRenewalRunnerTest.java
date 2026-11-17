package com.alibaba.qwen.code.managedagent.session;

import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class LeaseRenewalRunnerTest {
    @Test
    void dispatchOnceDeduplicatesInFlightKeyAndReleasesOnCompletionOrRejection()
            throws Exception {
        try (LeaseRenewalRunner runner = new LeaseRenewalRunner("owner-1", "test-renewal");
                ExecutorService executor = Executors.newSingleThreadExecutor()) {
            assertThat(runner.owner()).isEqualTo("owner-1");
            CountDownLatch entered = new CountDownLatch(1);
            CountDownLatch release = new CountDownLatch(1);
            AtomicInteger runs = new AtomicInteger();

            String key = LeaseRenewalRunner.scopedKey("t1", "s1", "op1");
            assertThat(runner.dispatchOnce(executor, key, () -> {
                runs.incrementAndGet();
                entered.countDown();
                try {
                    release.await(5, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            })).isTrue();
            assertThat(entered.await(5, TimeUnit.SECONDS)).isTrue();
            assertThat(runner.dispatchOnce(executor, key, runs::incrementAndGet)).isFalse();

            release.countDown();
            executor.submit(() -> {}).get(5, TimeUnit.SECONDS);
            assertThat(runs).hasValue(1);

            assertThat(runner.dispatchOnce(executor, key, runs::incrementAndGet)).isTrue();
            executor.submit(() -> {}).get(5, TimeUnit.SECONDS);
            assertThat(runs).hasValue(2);

            executor.shutdownNow();
            assertThatThrownBy(() -> runner.dispatchOnce(executor, key, runs::incrementAndGet))
                    .isInstanceOf(RejectedExecutionException.class);
            try (ExecutorService replacement = Executors.newSingleThreadExecutor()) {
                assertThat(runner.dispatchOnce(replacement, key, runs::incrementAndGet)).isTrue();
                replacement.submit(() -> {}).get(5, TimeUnit.SECONDS);
                assertThat(runs).hasValue(3);
            }
        }
    }

    @Test
    void startFixedDelayMarksLeaseLostOnFalseOrExceptionAndStopsOnClose() throws Exception {
        try (LeaseRenewalRunner runner = new LeaseRenewalRunner("test-renewal-delay")) {
            AtomicReference<String> threadName = new AtomicReference<>();
            CountDownLatch lost = new CountDownLatch(1);
            AtomicInteger ticks = new AtomicInteger();
            try (var handle = runner.startFixedDelay(10, () -> {
                threadName.set(Thread.currentThread().getName());
                if (ticks.incrementAndGet() == 1) {
                    return true;
                }
                lost.countDown();
                return false;
            }, error -> {})) {
                assertThat(lost.await(5, TimeUnit.SECONDS)).isTrue();
                long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2);
                while (handle.isLive() && System.nanoTime() < deadline) {
                    Thread.onSpinWait();
                }
                assertThat(handle.isLive()).isFalse();
                assertThat(threadName.get()).isEqualTo("test-renewal-delay");
            }

            CountDownLatch errored = new CountDownLatch(1);
            try (var handle = runner.startFixedDelay(10, () -> {
                throw new IllegalStateException("boom");
            }, error -> errored.countDown())) {
                assertThat(errored.await(5, TimeUnit.SECONDS)).isTrue();
                assertThat(handle.leaseLost().get()).isTrue();
            }
        }
    }

    @Test
    void startFixedRateRunsRenewedHookOnlyWhileLive() throws Exception {
        try (LeaseRenewalRunner runner = new LeaseRenewalRunner("test-renewal-rate")) {
            CountDownLatch hooked = new CountDownLatch(1);
            CountDownLatch lost = new CountDownLatch(1);
            AtomicInteger ticks = new AtomicInteger();
            AtomicInteger hooks = new AtomicInteger();
            try (var handle = runner.startFixedRate(10, () -> {
                int n = ticks.incrementAndGet();
                if (n == 1) {
                    return true;
                }
                lost.countDown();
                return false;
            }, () -> {
                hooks.incrementAndGet();
                hooked.countDown();
            }, error -> {})) {
                assertThat(hooked.await(5, TimeUnit.SECONDS)).isTrue();
                assertThat(lost.await(5, TimeUnit.SECONDS)).isTrue();
                Thread.sleep(40);
                assertThat(hooks).hasValue(1);
                assertThat(handle.isLive()).isFalse();
            }
        }
    }

    @Test
    void renewalPeriodMillisClampsToAtLeastOneMillisecond() {
        assertThat(LeaseRenewalRunner.renewalPeriodMillis(Duration.ofMillis(2))).isEqualTo(1L);
        assertThat(LeaseRenewalRunner.renewalPeriodMillis(Duration.ofSeconds(30)))
                .isEqualTo(10_000L);
        assertThat(LeaseRenewalRunner.renewalPeriodMillis(
                        Duration.ofSeconds(2), Duration.ofSeconds(30)))
                .isEqualTo(2_000L);
        assertThat(LeaseRenewalRunner.renewalPeriodMillis(
                        Duration.ofSeconds(20), Duration.ofSeconds(30)))
                .isEqualTo(10_000L);
    }
}
