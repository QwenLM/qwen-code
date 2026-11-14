package com.alibaba.qwen.code.runtimebroker;

import com.alibaba.qwen.code.runtimebroker.adapter.security.AesGcmSecretProtector;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerService;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.Timeout;

import java.lang.reflect.Proxy;
import java.net.URI;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import javax.sql.DataSource;

import static org.junit.jupiter.api.Assertions.assertTrue;

// Broker-side sibling of HarnessEventStreamPinningTest for
// https://github.com/QwenLM/qwen-code/issues/13333 : in the packaged
// stack the managed-agent server drives Broker operations from virtual
// threads (newVirtualThreadPerTaskExecutor), and when the provisioner
// completes synchronously the guarded repository calls run in that
// virtual thread's frame. If a guard is an intrinsic monitor and the
// repository call blocks — a JDBC row lock on a contended database — the
// carrier pins, and once callers parked inside guards reach the carrier
// count no virtual thread in the process runs again. The witness parks
// carriers+2 acquire calls inside sessionRepository.findById (inside the
// SessionContext guard), then proves an unrelated virtual-thread probe
// still completes — the same mechanism the SSE-reader witness pins in
// qwencode, asserted for the broker guards. The SQL gate blocks only
// non-locking ma_runtime_session reads (the findById path); everything
// else runs at local-database speed. The
// arrival latch is sized to the carrier count, not the caller count:
// under a pinning guard only one caller per carrier can ever arrive, so
// a caller-sized latch would burn the whole timeout before the probe
// assert below names the starvation.
class BrokerVirtualThreadPinningTest {
    private static final RuntimeScope SCOPE = new RuntimeScope("tenant",
            "workspace", "1", "/control", "digest", "session");
    private static final Instant START = Instant.parse(
            "2026-10-04T00:00:00Z");

    private LatchedCalls latch;
    private RuntimeBrokerService service;

    @AfterEach
    void tearDown() {
        if (latch != null) {
            latch.open();
        }
        if (service != null) {
            service.close();
        }
    }

    @Test
    @Timeout(120)
    void guardedBlockingRepositoryCallsMustNotStarveVirtualThreads()
            throws Exception {
        Clock clock = Clock.fixed(START, ZoneOffset.UTC);
        int carriers = CarrierCount.resolve();
        int callerCount = carriers + 2;
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:broker-pinning-" + UUID.randomUUID()
                + ";MODE=MySQL;DB_CLOSE_DELAY=-1;DATABASE_TO_LOWER=TRUE");
        com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchema.initialize(source);
        latch = new LatchedCalls(carriers);
        // JDBC admission requires the native session repository on the same
        // DataSource, so the latch gates the guarded findById SQL instead of
        // wrapping the repository.
        DataSource gated = gateSessionReads(source, latch);
        service = com.alibaba.qwen.code.runtimebroker.service.BrokerServiceTestAccess.create(
                ignored -> CompletableFuture.completedFuture(SCOPE),
                new InlineProvisioner(), new InlineTransport(),
                new JdbcRuntimeBindingRepository(gated,
                        new AesGcmSecretProtector("test", new byte[32]),
                        () -> "binding"),
                new JdbcRuntimeSessionRepository(gated),
                new JdbcToolExecutionRepository(gated),
                "broker-pinning", Duration.ofMinutes(1),
                Duration.ofSeconds(1), clock, () -> "execution");
        // One Session per caller, so each parks inside its own
        // SessionContext guard — sharing one Session would serialize the
        // callers at the same guard and only one would reach the block.
        for (int index = 0; index < callerCount; index++) {
            join(service.acquire("harness", "runtime-" + index,
                    "continuation"));
        }
        AtomicBoolean allOk = new AtomicBoolean(true);
        AtomicInteger probeProgress = new AtomicInteger();
        List<Thread> callers = new ArrayList<>();
        Throwable primary = null;
        latch.arm();
        try {
            for (int index = 0; index < callerCount; index++) {
                String runtimeId = "runtime-" + index;
                callers.add(Thread.ofVirtual().start(() -> {
                    try {
                        service.acquire("harness", runtimeId, "continuation")
                                .toCompletableFuture()
                                .get(60, TimeUnit.SECONDS);
                    } catch (RuntimeException | InterruptedException
                            | ExecutionException | TimeoutException error) {
                        allOk.set(false);
                        if (error instanceof InterruptedException) {
                            Thread.currentThread().interrupt();
                        }
                    }
                }));
            }
            // Every carrier must reach the latched repository call, parked
            // inside its SessionContext guard, before the probe starts;
            // that is exactly the state a pinning runtime wedges.
            latch.awaitArrived(60, TimeUnit.SECONDS);
            Thread.sleep(1000);
            Thread probe = Thread.ofVirtual().start(() -> {
                for (int tick = 0; tick < 400; tick++) {
                    probeProgress.incrementAndGet();
                }
            });
            probe.join(30_000);
            assertTrue(!probe.isAlive() && probeProgress.get() >= 400,
                    "virtual-thread probe starved by " + callerCount
                            + " callers parked inside broker guards on "
                            + carriers + " carriers (progress="
                            + probeProgress.get() + ") — a guard pinned"
                            + " its carrier");
        } catch (Throwable failure) {
            primary = failure;
            throw failure;
        } finally {
            latch.open();
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
        assertTrue(allOk.get(), "callers failed after the latch opened");
    }

    private static void join(CompletionStage<?> stage) {
        stage.toCompletableFuture().join();
    }

    /**
     * Gates non-locking ma_runtime_session SELECTs — the findById path the
     * SessionContext guard takes — behind a latch while armed. Locking reads
     * (admission's FOR UPDATE) and every other table pass straight through.
     */
    private static DataSource gateSessionReads(DataSource delegate,
            LatchedCalls latch) {
        return (DataSource) Proxy.newProxyInstance(
                DataSource.class.getClassLoader(),
                new Class<?>[] {DataSource.class}, (proxy, method, args) -> {
            if (!method.getName().startsWith("getConnection")) {
                return method.invoke(delegate, args);
            }
            Connection connection = (Connection) method.invoke(delegate, args);
            return Proxy.newProxyInstance(Connection.class.getClassLoader(),
                    new Class<?>[] {Connection.class}, (cp, cm, ca) -> {
                if (cm.getName().equals("prepareStatement")
                        && ca[0] instanceof String sql
                        && sql.contains("ma_runtime_session")
                        && !sql.contains("FOR UPDATE")) {
                    PreparedStatement statement =
                            (PreparedStatement) cm.invoke(connection, ca);
                    return Proxy.newProxyInstance(
                            PreparedStatement.class.getClassLoader(),
                            new Class<?>[] {PreparedStatement.class},
                            (sp, sm, sa) -> {
                        if (sm.getName().equals("executeQuery")) {
                            latch.arriveAndPark();
                        }
                        return sm.invoke(statement, sa);
                    });
                }
                return cm.invoke(connection, ca);
            });
        });
    }

    /** Arrival latch sized to the carrier count; parks gated reads while armed. */
    private static final class LatchedCalls {
        private final AtomicBoolean armed = new AtomicBoolean();
        private final CountDownLatch arrived;
        private final CountDownLatch open = new CountDownLatch(1);
        private final AtomicInteger waiting = new AtomicInteger();

        LatchedCalls(int arrivals) {
            arrived = new CountDownLatch(arrivals);
        }

        void arm() {
            armed.set(true);
        }

        void open() {
            open.countDown();
        }

        void awaitArrived(long timeout, TimeUnit unit)
                throws InterruptedException {
            if (!arrived.await(timeout, unit)) {
                throw new IllegalStateException("callers never reached"
                        + " the latched repository call (waiting="
                        + waiting.get() + ")");
            }
        }

        void arriveAndPark() {
            if (!armed.get()) {
                return;
            }
            waiting.incrementAndGet();
            arrived.countDown();
            try {
                open.await();
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
            waiting.decrementAndGet();
        }
    }

    private static final class InlineProvisioner
            implements RuntimeProvisioner {
        private int calls;

        @Override
        public CompletionStage<RuntimeLease> provision(
                RuntimeProvisionRequest request) {
            int call = ++calls;
            RuntimeLease lease = new RuntimeLease("runtime-" + call,
                    URI.create("http://127.0.0.1:" + (4000 + call)),
                    "token-" + call, "lease-" + call, call);
            return CompletableFuture.completedFuture(lease);
        }
    }

    private static final class InlineTransport implements RuntimeTransport {
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
            return CompletableFuture.completedFuture(
                    Map.of("executionStatus", "success"));
        }

        @Override
        public CompletionStage<Map<String, Object>> cancel(
                RuntimeLease lease, RuntimeSession session,
                Map<String, Object> reference) {
            return CompletableFuture.completedFuture(
                Map.of("state", "cancel_requested"));
        }

        @Override
        public CompletionStage<Boolean> release(RuntimeLease lease,
                RuntimeSession session) {
            return CompletableFuture.completedFuture(true);
        }
    }
}
