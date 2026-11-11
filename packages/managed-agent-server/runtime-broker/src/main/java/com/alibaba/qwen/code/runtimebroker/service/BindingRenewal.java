package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeDrainReceipt;
import com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBindingRegistry.SessionContext;

import java.time.Clock;
import java.time.Duration;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.locks.ReentrantLock;

import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.conflict;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.renewalDelayMillis;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.unavailable;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.verifyDrainReceiptIdentity;

/**
 * Renews one binding operation claim while a provision or drain leg is in
 * flight, and settles stopped Sessions under the persisted drain receipt.
 */
final class BindingRenewal implements AutoCloseable {
    // A monitor here would pin a virtual-thread carrier whenever a
    // guarded repository call blocks on the database (JDK 21);
    // the lock parks without pinning instead.
    private final ReentrantLock monitor = new ReentrantLock();
    private final AtomicReference<RuntimeBindingRecord> current;
    private final AtomicBoolean valid = new AtomicBoolean(true);
    private final AtomicBoolean stopped = new AtomicBoolean();
    // A drain claimed from a LOST binding stays LOST until its stop proof
    // commits, so that state is this claim's legitimate resting point —
    // not a rival's. The stop proof, not a DRAINING transition, is what
    // licenses the close.
    private final boolean lostClaim;
    private final RuntimeBindingRepository bindingRepository;
    private final ToolExecutionRepository executionRepository;
    private final RuntimeBindingRegistry bindingRegistry;
    private final RuntimeSessionRelease sessionRelease;
    private final String brokerOwnerId;
    private final Duration operationLeaseDuration;
    private final Clock clock;
    private final AtomicBoolean closed;
    private final ScheduledExecutorService renewalScheduler;
    private ScheduledFuture<?> task;

    BindingRenewal(RuntimeBindingRecord claimed,
            RuntimeBindingRepository bindingRepository,
            ToolExecutionRepository executionRepository,
            RuntimeBindingRegistry bindingRegistry,
            RuntimeSessionRelease sessionRelease,
            String brokerOwnerId,
            Duration operationLeaseDuration,
            Clock clock,
            AtomicBoolean closed,
            ScheduledExecutorService renewalScheduler) {
        this.current = new AtomicReference<>(claimed);
        this.lostClaim = claimed.getState() == RuntimeBindingRecord.State.LOST;
        this.bindingRepository = bindingRepository;
        this.executionRepository = executionRepository;
        this.bindingRegistry = bindingRegistry;
        this.sessionRelease = sessionRelease;
        this.brokerOwnerId = brokerOwnerId;
        this.operationLeaseDuration = operationLeaseDuration;
        this.clock = clock;
        this.closed = closed;
        this.renewalScheduler = renewalScheduler;
    }

    void start() {
        monitor.lock();
        try {
            long delay = renewalDelayMillis(operationLeaseDuration);
            task = renewalScheduler.scheduleWithFixedDelay(this::renew,
                    delay, delay, TimeUnit.MILLISECONDS);
        } finally {
            monitor.unlock();
        }
    }

    /** The latest renewed claim, read without the monitor as the drain leg does. */
    RuntimeBindingRecord currentRecord() {
        return current.get();
    }

    RuntimeBindingRecord stopAndGet() {
        monitor.lock();
        try {
            closeLocked();
            return !closed.get() && valid.get() ? current.get() : null;
        } finally {
            monitor.unlock();
        }
    }

    void persistDrainReceipt(RuntimeDrainReceipt receipt) {
        persistDrainReceipt(receipt, null);
    }

    void persistDrainReceipt(RuntimeDrainReceipt receipt, RuntimeLifecycleAuthority authority) {
        monitor.lock();
        try {
            var expected = requireDrainClaim(authority != null);
            verifyDrainReceiptIdentity(expected, receipt);
            var replacement = expected.withDrainReceipt(receipt);
            if (authority != null) {
                replacement = replacement.withLifecycleAuthority(authority)
                        .withState(RuntimeBindingRecord.State.DRAINING, expected.getLease(), clock.instant());
            }
            var updated = bindingRepository.compareAndSet(expected, replacement);
            if (updated == null) {
                valid.set(false);
                closeLocked();
                throw unavailable("runtime_close_claim_pending", "Original stop receipt was fenced");
            }
            current.set(updated);
        } finally {
            monitor.unlock();
        }
    }

    boolean releaseStoppedSession(RuntimeSessionRecord record) {
        return releaseStoppedSession(record, null);
    }

    boolean releaseStoppedSession(RuntimeSessionRecord record, RuntimeLifecycleAuthority authority) {
        monitor.lock();
        try {
            var binding = requireDrainClaim();
            var receipt = binding.getDrainReceipt();
            if (receipt == null) {
                return false;
            }
            if (!receipt.matches(binding) || !binding.getBindingId().equals(record.getBindingId())
                    || binding.getGeneration() != record.getRuntimeGeneration()) {
                throw conflict("workspace_close_identity_unverified", "Stopped Session identity differs");
            }
            if (executionRepository.hasActiveByBinding(binding.getBindingId(), binding.getGeneration())) {
                throw conflict("workspace_close_execution_unsettled", "Original resources are unsettled");
            }
            var authorized = authority == null ? binding : binding.withLifecycleAuthority(authority);
            sessionRelease.finishSessionRelease(sessionRelease.transitionSessionToReleasing(
                    new SessionContext(record.getSession(), authorized, binding.getLease())), authorized);
            bindingRegistry.removeSession(record.getRuntimeSessionId());
            return true;
        } finally {
            monitor.unlock();
        }
    }

    RuntimeBindingRecord requireDrainClaim() {
        return requireDrainClaim(false);
    }

    RuntimeBindingRecord requireDrainClaim(boolean stoppedRecovery) {
        var binding = current.get();
        if (closed.get() || stopped.get() || !valid.get()
                || !brokerOwnerId.equals(binding.getOperationOwner())
                || !binding.isDrainRequested()
                || !RuntimeBrokerSupport.isDrainClaimStateValid(binding, stoppedRecovery, lostClaim)
                || binding.getOperationLeaseUntil() == null
                || !binding.getOperationLeaseUntil().isAfter(clock.instant())) {
            throw unavailable("runtime_close_claim_pending", "Original drain claim expired");
        }
        return binding;
    }

    boolean persistResourceHandle(
            RuntimeResourceHandle handle) {
        monitor.lock();
        try {
            if (closed.get() || stopped.get() || !valid.get()) {
                return false;
            }
            RuntimeBindingRecord expected = current.get();
            RuntimeBindingRecord updated = bindingRepository.compareAndSet(
                    expected, expected.withResourceHandle(handle,
                            clock.instant()));
            if (updated == null) {
                valid.set(false);
                closeLocked();
                return false;
            }
            current.set(updated);
            return true;
        } finally {
            monitor.unlock();
        }
    }

    private void renew() {
        monitor.lock();
        try {
            // stopped is per-instance: cancel(false) cannot retract a
            // tick already waiting on this monitor, so once close() ran
            // the tick must return here rather than renew a claim its
            // owner has started renewing inline. The window is staged
            // and pinned for the provision-path shape, where
            // persistResourceHandle can hold this monitor while a tick
            // queues behind it
            // (DurableRuntimeRecoveryTest.stoppedFlagRetractsATickQueuedBehindClose);
            // the LOST-branch shape has no third monitor holder, so
            // there it remains a timing-only guarantee.
            if (stopped.get() || closed.get()) {
                closeLocked();
                return;
            }
            RuntimeBindingRecord expected = current.get();
            try {
                RuntimeBindingRecord renewed =
                        bindingRepository.renewOperation(
                                expected.getBindingId(), brokerOwnerId,
                                expected.getOperationGeneration(),
                                operationLeaseDuration);
                if (renewed == null) {
                    valid.set(false);
                    closeLocked();
                } else {
                    current.set(renewed);
                }
            } catch (RuntimeException exception) {
                valid.set(false);
                closeLocked();
            }
        } finally {
            monitor.unlock();
        }
    }

    @Override
    public void close() {
        monitor.lock();
        try {
            closeLocked();
        } finally {
            monitor.unlock();
        }
    }

    private void closeLocked() {
        stopped.set(true);
        if (task != null) {
            task.cancel(false);
        }
    }
}
