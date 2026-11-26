package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.runtimebroker.BrokerValues;

import java.time.Duration;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/**
 * Shared in-process dispatch deduplication and daemon lease-renewal scheduler
 * for control-plane coordinators and workspace services.
 */
public final class LeaseRenewalRunner implements AutoCloseable {
    private final String owner;
    private final Set<String> active = ConcurrentHashMap.newKeySet();
    private final ScheduledExecutorService renewals;

    public LeaseRenewalRunner(String threadName) {
        this(UUID.randomUUID().toString(), threadName);
    }

    public LeaseRenewalRunner(String owner, String threadName) {
        // The owner lands in VARCHAR(128) claim/dispatch columns; refuse a
        // PAD SPACE fold of another holder's identity at the boundary.
        this.owner = BrokerValues
                .requireWorkerOwner(owner, "owner");
        Objects.requireNonNull(threadName, "threadName");
        this.renewals = Executors.newSingleThreadScheduledExecutor(task -> {
            Thread thread = new Thread(task, threadName);
            thread.setDaemon(true);
            return thread;
        });
    }

    public String owner() {
        return owner;
    }

    public static String scopedKey(String tenantId, String sessionId, String id) {
        return tenantId + "\n" + sessionId + "\n" + id;
    }

    /**
     * Submits {@code work} to {@code executor} if {@code key} is not already
     * active in this instance, always clearing the active guard once {@code work}
     * finishes or submission fails.
     */
    public boolean dispatchOnce(ExecutorService executor, String key, Runnable work) {
        if (!active.add(key)) {
            return false;
        }
        try {
            executor.execute(() -> {
                try {
                    work.run();
                } finally {
                    active.remove(key);
                }
            });
            return true;
        } catch (RuntimeException error) {
            active.remove(key);
            throw error;
        }
    }

    public static long renewalPeriodMillis(Duration leaseDuration) {
        return Math.max(1L, leaseDuration.toMillis() / 3L);
    }

    public static long renewalPeriodMillis(Duration renewInterval, Duration leaseDuration) {
        return Math.max(1L, Math.min(renewInterval.toMillis(), leaseDuration.toMillis() / 3L));
    }

    public RenewalHandle startFixedDelay(long periodMillis, BooleanSupplier renew,
            Consumer<RuntimeException> onError) throws RejectedExecutionException {
        AtomicBoolean leaseLost = new AtomicBoolean();
        ScheduledFuture<?> future = renewals.scheduleWithFixedDelay(() -> {
            try {
                if (!renew.getAsBoolean()) {
                    leaseLost.set(true);
                }
            } catch (RuntimeException error) {
                leaseLost.set(true);
                onError.accept(error);
            }
        }, periodMillis, periodMillis, TimeUnit.MILLISECONDS);
        return new RenewalHandle(leaseLost, future);
    }

    public RenewalHandle startFixedRate(long periodMillis, BooleanSupplier renew,
            Runnable onRenewed, Consumer<RuntimeException> onError)
            throws RejectedExecutionException {
        AtomicBoolean leaseLost = new AtomicBoolean();
        ScheduledFuture<?> future = renewals.scheduleAtFixedRate(() -> {
            try {
                if (!renew.getAsBoolean()) {
                    leaseLost.set(true);
                } else if (!leaseLost.get()) {
                    onRenewed.run();
                }
            } catch (RuntimeException error) {
                leaseLost.set(true);
                onError.accept(error);
            }
        }, periodMillis, periodMillis, TimeUnit.MILLISECONDS);
        return new RenewalHandle(leaseLost, future);
    }

    public ScheduledFuture<?> scheduleWithFixedDelay(Runnable command, long periodMillis)
            throws RejectedExecutionException {
        return renewals.scheduleWithFixedDelay(
                command, periodMillis, periodMillis, TimeUnit.MILLISECONDS);
    }

    @Override
    public void close() {
        renewals.shutdownNow();
    }

    public static final class RenewalHandle implements AutoCloseable {
        private final AtomicBoolean leaseLost;
        private final ScheduledFuture<?> future;

        RenewalHandle(AtomicBoolean leaseLost, ScheduledFuture<?> future) {
            this.leaseLost = leaseLost;
            this.future = future;
        }

        public AtomicBoolean leaseLost() {
            return leaseLost;
        }

        public boolean isLive() {
            return !leaseLost.get();
        }

        @Override
        public void close() {
            future.cancel(false);
        }
    }
}
