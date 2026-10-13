package com.alibaba.qwen.code.managedagent.service;

import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.alibaba.qwen.code.managedagent.store.StoreModels.EventRecord;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ForkJoinPool;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

// Scale witness for JDK 21 virtual-thread carrier exhaustion in the
// hosted-SSE fan-out — the same pinning class as #13388, but not the
// wedge recorded at https://github.com/QwenLM/qwen-code/issues/13333,
// whose repro observes events by REST polling and never subscribes.
// Here every SSE
// subscriber parks in SessionEventHub.Subscription.await on a virtual
// thread (ManagedEventStreamService runs on the server's
// newVirtualThreadPerTaskExecutor). If SessionBuffer.await holds a
// monitor across Object.wait, each parked subscriber pins its carrier
// on JDK 21; the scheduler compensates only up to its maxPoolSize
// (256 by default), so 300 idle subscribers exhaust every carrier the
// pool may ever create and no other virtual thread in the process runs
// again. The witness parks 300 subscribers with the publish that would
// release them latched away, proves an unrelated virtual-thread probe
// still completes, and only then lets a few Turn batches publish and
// settle. A Condition await unmounts instead of pinning, so 300 parked
// subscribers hold no carriers at all. On JDK 24+ (JEP 491) monitors
// no longer pin, so the behavior-level assertion holds there
// regardless of the locking shape; the discriminative power lives on
// JDK 21.
class SessionEventHubPinningTest {
    // At or past the scheduler's maxPoolSize (256 by default): with a
    // pin-capable shape the parked subscribers hold every carrier the
    // pool may create, so the probe — one virtual thread beyond
    // SUBSCRIBERS — starves deterministically.
    private static final int SUBSCRIBERS = 300;
    private static final int ROUNDS = 3;
    // Never reached in a run: the publish latch, not the timeout, wakes
    // every waiter (pinned by publishWakesEveryParkedSubscriber in
    // SessionEventHubTest). Bounded well under the test timeout as a
    // last resort.
    private static final Duration AWAIT_TIMEOUT = Duration.ofMinutes(1);

    @Test
    @Timeout(120)
    void parkedSubscribersMustNotStarveOtherVirtualThreads()
            throws Exception {
        assumeTrue(Integer.getInteger("jdk.virtualThreadScheduler.maxPoolSize",
                        256) <= SUBSCRIBERS,
                "jdk.virtualThreadScheduler.maxPoolSize is above "
                        + SUBSCRIBERS
                        + "; a pin-capable shape would still have a"
                        + " carrier for the probe");
        SessionEventHub hub = new SessionEventHub();
        int carriers = Integer.getInteger("jdk.virtualThreadScheduler.parallelism",
                Runtime.getRuntime().availableProcessors());
        List<SessionEventHub.Subscription> subscriptions =
                new ArrayList<>();
        for (int index = 0; index < SUBSCRIBERS; index++) {
            subscriptions.add(hub.subscribe("tenant", "session"));
        }
        CountDownLatch arrived = new CountDownLatch(SUBSCRIBERS);
        CountDownLatch done = new CountDownLatch(SUBSCRIBERS);
        AtomicInteger failures = new AtomicInteger();
        AtomicInteger probeProgress = new AtomicInteger();
        List<Thread> waiters = new ArrayList<>();
        for (SessionEventHub.Subscription subscription : subscriptions) {
            waiters.add(Thread.ofVirtual().start(() -> {
                try {
                    arrived.countDown();
                    long sequence = 0;
                    while (sequence < ROUNDS) {
                        SessionEventHub.Delivery delivery = subscription
                                .await(sequence, AWAIT_TIMEOUT);
                        if (delivery.overflowed()) {
                            failures.incrementAndGet();
                            return;
                        }
                        // An empty delivery is a spurious wake or a
                        // timeout: await the same position again.
                        if (!delivery.events().isEmpty()) {
                            sequence = delivery.events()
                                    .get(delivery.events().size() - 1)
                                    .sequence();
                        }
                    }
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    failures.incrementAndGet();
                } finally {
                    done.countDown();
                }
            }));
        }
        boolean probeFinished = false;
        boolean turnsSettled = false;
        try {
            // Best effort: on a pinning runtime the tail of the waiter
            // queue only runs once the publishes below free carriers.
            arrived.await(30, TimeUnit.SECONDS);
            // Let every scheduled waiter reach the parked await(); on a
            // pinning runtime that is when each carrier is captured.
            Thread.sleep(2000);
            // A sleeping probe must be scheduled again and again, not
            // once: one leaked slot cannot carry it to 200 ticks.
            Thread probe = Thread.ofVirtual().start(() -> {
                for (int tick = 0; tick < 200; tick++) {
                    probeProgress.incrementAndGet();
                    try {
                        Thread.sleep(10);
                    } catch (InterruptedException interrupted) {
                        Thread.currentThread().interrupt();
                        return;
                    }
                }
            });
            probe.join(30_000);
            probeFinished = !probe.isAlive() && probeProgress.get() >= 200;
        } finally {
            // Open the publish latch: three Turn batches commit and every
            // subscriber must settle, on either locking shape.
            for (long sequence = 1; sequence <= ROUNDS; sequence++) {
                hub.publish(List.of(event(sequence)));
            }
            turnsSettled = done.await(60, TimeUnit.SECONDS);
            for (SessionEventHub.Subscription subscription
                    : subscriptions) {
                subscription.close();
            }
            for (Thread waiter : waiters) {
                waiter.join(10_000);
            }
        }
        assertTrue(turnsSettled, "subscribers failed to settle "
                + ROUNDS + " Turn batches within 60 s");
        assertTrue(failures.get() == 0,
                "subscribers saw overflow or interruption (failures="
                        + failures.get() + ")");
        assertTrue(probeFinished,
                "virtual-thread probe starved within 30 s of "
                        + SUBSCRIBERS + " subscribers parked in"
                        + " SessionEventHub.await on " + carriers
                        + " carriers (progress=" + probeProgress.get()
                        + ") — Object.wait pinned every carrier");
    }

    private static EventRecord event(long sequence) {
        return new EventRecord("tenant", "session", sequence,
                "event-" + sequence, "turn", "type", Map.of(), false,
                "source-" + sequence, 1);
    }
}
