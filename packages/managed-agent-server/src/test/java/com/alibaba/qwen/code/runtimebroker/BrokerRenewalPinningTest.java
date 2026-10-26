package com.alibaba.qwen.code.runtimebroker;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.net.URI;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

// Witness for the BindingRenewal half of #13388: the packaged
// stack measured in #13365 pinned its carriers at
// BindingRenewal.persistResourceHandle, which holds the renewal guard
// across bindingRepository.compareAndSet (a row-locked UPDATE on MySQL).
// carriers+2 virtual threads each warm their own durable binding and park
// inside that guard at a latched resource-handle write; an unrelated
// virtual-thread probe must still run. Restoring the synchronized
// BindingRenewal turns this red; BrokerVirtualThreadPinningTest stays green.
// The arrival latch is sized to the carrier count, not the caller count:
// under a pinning guard only one caller per carrier can ever arrive, so a
// caller-sized latch would burn the whole timeout before the probe assert
// below names the starvation.
class BrokerRenewalPinningTest {
    private static final RuntimeResourceHandle HANDLE =
            new RuntimeResourceHandle("test-scheduler", 1,
                    Map.of("resourceId", "runtime-resource"));

    private final AtomicReference<Throwable> firstFailure =
            new AtomicReference<>();
    private LatchedBindingRepository bindings;
    private RuntimeBrokerService service;

    @AfterEach
    void tearDown() {
        if (bindings != null) {
            bindings.open();
        }
        if (service != null) {
            service.close();
        }
    }

    @Test
    @Timeout(120)
    void renewalGuardMustNotPinCarriersWhileTheHandleWriteBlocks()
            throws Exception {
        int carriers = CarrierCount.resolve();
        int callerCount = carriers + 2;
        bindings = new LatchedBindingRepository(
                new InMemoryRuntimeBindingRepository(), carriers,
                firstFailure);
        // One workspace per caller, so every warm() owns its own binding
        // and its own BindingRenewal guard.
        service = new RuntimeBrokerService(
                harnessId -> CompletableFuture.completedFuture(
                        new RuntimeScope("tenant", "workspace-" + harnessId,
                                "1", "/control", "digest", "session")),
                new DurableProvisioner(), new NoopTransport(), bindings,
                new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(), "broker-renewal",
                Duration.ofMinutes(1), Duration.ofMinutes(1));
        AtomicInteger probeProgress = new AtomicInteger();
        List<Thread> callers = new ArrayList<>();
        Throwable primary = null;
        try {
            for (int index = 0; index < callerCount; index++) {
                String harnessId = "harness-" + index;
                callers.add(Thread.ofVirtual().start(() -> {
                    try {
                        service.warm(harnessId).toCompletableFuture()
                                .get(60, TimeUnit.SECONDS);
                    } catch (Exception failure) {
                        // Only the guard's carrier behaviour is asserted.
                        firstFailure.compareAndSet(null, failure);
                    }
                }));
            }
            bindings.awaitArrived(60, TimeUnit.SECONDS);
            Thread.sleep(1000);
            Thread probe = Thread.ofVirtual().start(() -> {
                for (int tick = 0; tick < 400; tick++) {
                    probeProgress.incrementAndGet();
                }
            });
            probe.join(30_000);
            assertTrue(!probe.isAlive() && probeProgress.get() >= 400,
                    "virtual-thread probe starved by " + callerCount
                            + " warm() callers parked inside BindingRenewal"
                            + " guards on " + carriers + " carriers"
                            + " (progress=" + probeProgress.get()
                            + ") — a guard pinned its carrier");
        } catch (Throwable failure) {
            primary = failure;
            throw failure;
        } finally {
            bindings.open();
            // The latch is carrier-sized, so it opens without the last two
            // callers; a caller wedged before the guarded call fails no other
            // assertion. One shared budget keeps the method inside @Timeout,
            // and a pending failure keeps its own message: the wedged callers
            // ride along as a suppressed error instead of replacing it.
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
            int unsettled = 0;
            for (Thread caller : callers) {
                caller.join(Math.max(1L, TimeUnit.NANOSECONDS.toMillis(
                        deadline - System.nanoTime())));
                if (caller.isAlive()) {
                    unsettled++;
                }
            }
            if (unsettled > 0) {
                AssertionError wedged = new AssertionError(unsettled
                        + " caller(s) never finished after the latch opened");
                if (primary == null) {
                    throw wedged;
                }
                primary.addSuppressed(wedged);
            }
        }
    }

    /** The first resource-handle write of each binding parks while armed. */
    private static final class LatchedBindingRepository
            extends DelegatingBindingRepository {
        private final CountDownLatch arrived;
        private final CountDownLatch open = new CountDownLatch(1);
        private final AtomicInteger waiting = new AtomicInteger();
        private final AtomicReference<Throwable> firstFailure;

        LatchedBindingRepository(RuntimeBindingRepository delegate,
                int arrivals, AtomicReference<Throwable> firstFailure) {
            super(delegate);
            arrived = new CountDownLatch(arrivals);
            this.firstFailure = firstFailure;
        }

        void open() {
            open.countDown();
        }

        void awaitArrived(long timeout, TimeUnit unit)
                throws InterruptedException {
            if (!arrived.await(timeout, unit)) {
                Throwable failure = firstFailure.get();
                throw new IllegalStateException("callers never reached the"
                        + " latched resource-handle write (waiting="
                        + waiting.get() + ")"
                        + (failure == null ? ""
                                : "; first caller failure: " + failure));
            }
        }

        @Override
        public RuntimeBindingRecord compareAndSet(
                RuntimeBindingRecord expected,
                RuntimeBindingRecord replacement) {
            if (expected.getResourceHandle() == null
                    && replacement.getResourceHandle() != null
                    && open.getCount() > 0) {
                waiting.incrementAndGet();
                arrived.countDown();
                try {
                    open.await();
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
                waiting.decrementAndGet();
            }
            return delegate.compareAndSet(expected, replacement);
        }
    }

    private static final class DurableProvisioner
            implements RuntimeProvisioner {
        @Override
        public String kind() {
            return "test-scheduler";
        }

        @Override
        public CompletionStage<RuntimeLease> provision(
                RuntimeProvisionRequest request) {
            throw new AssertionError("legacy provision must not be used");
        }

        @Override
        public CompletionStage<RuntimeResourceHandle> ensureResource(
                RuntimeProvisionRequest request, RuntimeProvisionSeed seed,
                RuntimeResourceHandle knownHandle) {
            return CompletableFuture.completedFuture(HANDLE);
        }

        @Override
        public CompletionStage<RuntimeLease> provision(
                RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
            return CompletableFuture.completedFuture(new RuntimeLease(
                    seed.getProvisionalRuntimeId(),
                    URI.create("http://127.0.0.1:4190"), seed.getToken(),
                    seed.getLeaseId(), seed.getEpoch()));
        }
    }

    private static final class NoopTransport implements RuntimeTransport {
        @Override
        public CompletionStage<Void> acquire(RuntimeLease lease,
                RuntimeSession session) {
            return CompletableFuture.completedFuture(null);
        }

        @Override
        public CompletionStage<Object> control(RuntimeLease lease,
                RuntimeSession session, Map<String, Object> operation) {
            return CompletableFuture.completedFuture("ok");
        }

        @Override
        public CompletionStage<Map<String, Object>> execute(
                RuntimeLease lease, RuntimeSession session,
                Map<String, Object> reference) {
            return CompletableFuture.completedFuture(Map.of());
        }

        @Override
        public CompletionStage<Map<String, Object>> cancel(
                RuntimeLease lease, RuntimeSession session,
                Map<String, Object> reference) {
            return CompletableFuture.completedFuture(Map.of());
        }

        @Override
        public CompletionStage<Boolean> release(RuntimeLease lease,
                RuntimeSession session) {
            return CompletableFuture.completedFuture(true);
        }
    }
}
