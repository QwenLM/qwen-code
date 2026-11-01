package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.HarnessSessionResolver;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;

import java.time.Clock;
import java.time.Duration;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.locks.ReentrantLock;

import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.conflict;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.mapFailure;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.notFound;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.safeStage;

/** Process-local Binding and Session ownership; repositories remain authoritative. */
final class RuntimeBindingRegistry {
    private final ConcurrentMap<String, LiveBinding> liveBindings = new ConcurrentHashMap<>();
    private final ConcurrentMap<String, CompletableFuture<BindingContext>> bindingOperations = new ConcurrentHashMap<>();
    private final ConcurrentMap<String, CompletableFuture<SessionContext>> sessions = new ConcurrentHashMap<>();
    private final RuntimeBindingRepository bindingRepository;
    private final RuntimeProvisioner provisioner;
    private final RuntimeSessionRepository sessionRepository;
    private final HarnessSessionResolver sessionResolver;
    private final String brokerOwnerId;
    private final Duration operationLeaseDuration;
    private final Clock clock;

    RuntimeBindingRegistry(RuntimeBindingRepository bindingRepository,
            RuntimeProvisioner provisioner, RuntimeSessionRepository sessionRepository,
            HarnessSessionResolver sessionResolver, String brokerOwnerId,
            Duration operationLeaseDuration, Clock clock) {
        this.bindingRepository = bindingRepository;
        this.provisioner = provisioner;
        this.sessionRepository = sessionRepository;
        this.sessionResolver = sessionResolver;
        this.brokerOwnerId = brokerOwnerId;
        this.operationLeaseDuration = operationLeaseDuration;
        this.clock = clock;
    }

    CompletableFuture<BindingContext> bindingOperation(String bindingId) {
        return bindingOperations.get(bindingId);
    }

    CompletableFuture<BindingContext> reserveBinding(String bindingId,
            CompletableFuture<BindingContext> reservation) {
        return bindingOperations.putIfAbsent(bindingId, reservation);
    }

    void finishBindingOperation(String bindingId, CompletableFuture<BindingContext> reservation) {
        bindingOperations.remove(bindingId, reservation);
    }

    CompletableFuture<SessionContext> session(String runtimeSessionId) {
        return sessions.get(runtimeSessionId);
    }

    CompletableFuture<SessionContext> registerSession(String runtimeSessionId,
            CompletableFuture<SessionContext> context) {
        return sessions.putIfAbsent(runtimeSessionId, context);
    }

    void removeSession(String runtimeSessionId, CompletableFuture<SessionContext> context) {
        sessions.remove(runtimeSessionId, context);
    }

    void removeSession(String runtimeSessionId) {
        sessions.remove(runtimeSessionId);
    }

    void registerBinding(RuntimeBindingRecord record, RuntimeLease lease) {
        liveBindings.put(record.getBindingId(), new LiveBinding(record.getGeneration(), lease));
    }

    boolean hasBinding(String bindingId) {
        return liveBindings.containsKey(bindingId);
    }

    void forgetBinding(String bindingId) {
        liveBindings.remove(bindingId);
    }

    void cancelPendingOperations() {
        bindingOperations.values().forEach(future -> future.cancel(false));
        sessions.values().forEach(future -> future.cancel(false));
    }

    BindingContext matchingLiveBinding(RuntimeBindingRecord record) {
        LiveBinding live = liveBindings.get(record.getBindingId());
        return live != null && live.generation() == record.getGeneration()
                && record.getLease() != null
                && sameLease(live.lease(), record.getLease())
                        ? new BindingContext(record, live.lease()) : null;
    }

    boolean isLiveBinding(RuntimeBindingRecord record) {
        return matchingLiveBinding(record) != null;
    }

    BindingContext requireLiveBinding(RuntimeBindingRecord record) {
        BindingContext live = matchingLiveBinding(record);
        if (live == null) {
            throw unavailable("runtime_reconciliation_required",
                    "persisted Runtime readiness requires adoption or "
                            + "reconciliation in this Broker process");
        }
        return live;
    }

    CompletionStage<SessionContext> requireSession(
            String harnessSessionId, String runtimeSessionId) {
        String harnessId = BrokerValues.requireId(harnessSessionId,
                "harnessSessionId");
        String runtimeId = BrokerValues.requireId(runtimeSessionId,
                "runtimeSessionId");
        CompletableFuture<SessionContext> context = sessions.get(runtimeId);
        if (context == null) {
            return CompletableFuture.failedFuture(new RuntimeBrokerException(404,
                    "runtime_session_not_found",
                    "Runtime Session is not active in this Broker process", false));
        }
        return context.thenApply(value -> {
            if (!value.session().getHarnessSessionId().equals(harnessId)) {
                throw new RuntimeBrokerException(409, "runtime_session_conflict",
                        "Runtime Session belongs to another Harness Session", false);
            }
            return value;
        });
    }

    /**
     * An execution permanently points at the binding generation it was
     * dispatched to. Once that generation is retired, replaced, or gone, no
     * Runtime can answer for it, so polling must stop rather than retry.
     */
    void requireAnswerableBinding(ToolExecutionRecord record) {
        RuntimeBindingRecord binding = bindingRepository.findById(
                record.getBindingId());
        if (binding == null
                || binding.getGeneration() != record.getRuntimeGeneration()
                || (binding.getState() != RuntimeBindingRecord.State.READY
                        && binding.getState()
                                != RuntimeBindingRecord.State.DRAINING)) {
            throw evidenceUnavailable();
        }
    }

    void invalidateBinding(RuntimeBindingRecord record) {
        liveBindings.remove(record.getBindingId());
        RuntimeBindingRecord claimed = bindingRepository.claimOperation(
                record.getBindingId(), brokerOwnerId, operationLeaseDuration);
        if (claimed != null) {
            try {
                if (claimed.getState() == RuntimeBindingRecord.State.READY) {
                    bindingRepository.compareAndSet(claimed, claimed.withState(
                            RuntimeBindingRecord.State.LOST, claimed.getLease(), clock.instant()));
                }
            } finally {
                releaseOperationQuietly(claimed.getBindingId(), claimed.getOperationGeneration());
            }
        }
    }

    void requireUsableLease(SessionContext context) {
        if (!provisioner.isUsable(context.lease())) {
            invalidateBinding(context.binding());
            throw unavailable("runtime_provision_failed",
                    "Managed Runtime process is not alive.");
        }
    }

    void releaseOperationQuietly(String bindingId,
            long operationGeneration) {
        try {
            bindingRepository.releaseOperation(bindingId, brokerOwnerId,
                    operationGeneration);
        } catch (RuntimeException ignored) {
            // The claim lapses on its own when the release cannot be written.
        }
    }

    static boolean sameLease(RuntimeLease left,
            RuntimeLease right) {
        return left.getRuntimeInstanceId().equals(
                right.getRuntimeInstanceId())
                && left.getEndpoint().equals(right.getEndpoint())
                && left.getToken().equals(right.getToken())
                && left.getLeaseId().equals(right.getLeaseId())
                && left.getEpoch() == right.getEpoch();
    }

    static RuntimeBrokerException evidenceUnavailable() {
        return new RuntimeBrokerException(409,
                "runtime_execution_evidence_unavailable",
                "The original Runtime generation cannot answer for this "
                        + "execution", false);
    }

    private static RuntimeBrokerException unavailable(String code, String message) {
        return new RuntimeBrokerException(503, code, message, true);
    }

    private record LiveBinding(long generation, RuntimeLease lease) {
    }

    record BindingContext(RuntimeBindingRecord record,
            RuntimeLease lease) {
    }

    static final class SessionContext {
        // One guard for the state below and every context.lock() region at
        // the callers. Like them it must not pin a virtual-thread carrier
        // when a repository call inside the guard blocks (JDK 21).
        private final ReentrantLock guard = new ReentrantLock();
        private final RuntimeSession session;
        private final RuntimeBindingRecord binding;
        private final RuntimeLease lease;
        // The background process rows this Broker admitted for the Session,
        // until each settles — the release sweep asks exactly these owners.
        private final Set<String> backgroundProcesses = new LinkedHashSet<>();
        private int activeControls;
        private CompletableFuture<Boolean> release;
        // One release attempt at a time per context: the sweep's controls
        // belong to whoever holds this, so a concurrent caller joins it
        // instead of sweeping against it and reading its own attempts busy.
        private CompletableFuture<Boolean> releaseAttempt;
        // The latest acquire's mount claim: only that acquirer may hand the
        // mount back (#13800).
        private String mountClaim;

        SessionContext(RuntimeSession session, RuntimeBindingRecord binding,
                RuntimeLease lease) {
            this.session = session;
            this.binding = binding;
            this.lease = lease;
        }

        void lock() {
            guard.lock();
        }

        void unlock() {
            guard.unlock();
        }

        RuntimeSession session() {
            return session;
        }

        RuntimeBindingRecord binding() {
            return binding;
        }

        RuntimeLease lease() {
            return lease;
        }

        Set<String> backgroundProcesses() {
            lock();
            try {
                return backgroundProcesses;
            } finally {
                unlock();
            }
        }

        void beginControl() {
            lock();
            try {
                activeControls++;
            } finally {
                unlock();
            }
        }

        void endControl() {
            lock();
            try {
                activeControls--;
            } finally {
                unlock();
            }
        }

        String mountClaim() {
            lock();
            try {
                return mountClaim;
            } finally {
                unlock();
            }
        }

        void mountClaim(String next) {
            lock();
            try {
                mountClaim = next;
            } finally {
                unlock();
            }
        }

        boolean hasActiveControl() {
            lock();
            try {
                return activeControls > 0;
            } finally {
                unlock();
            }
        }

        CompletableFuture<Boolean> release() {
            lock();
            try {
                return release;
            } finally {
                unlock();
            }
        }

        void release(CompletableFuture<Boolean> next) {
            lock();
            try {
                release = next;
            } finally {
                unlock();
            }
        }

        CompletableFuture<Boolean> releaseAttempt() {
            lock();
            try {
                return releaseAttempt;
            } finally {
                unlock();
            }
        }

        void releaseAttempt(CompletableFuture<Boolean> next) {
            lock();
            try {
                releaseAttempt = next;
            } finally {
                unlock();
            }
        }
    }

    CompletionStage<SessionContext> requireReadySession(
            String harnessSessionId, String runtimeSessionId) {
        return requireSession(harnessSessionId, runtimeSessionId)
                .thenApply(value -> {
                    requireReadySessionRecord(value);
                    return value;
                });
    }

    RuntimeSessionRecord requireReadySessionRecord(
            SessionContext context) {
        RuntimeSessionRecord record = sessionRepository.findById(
                context.session().getScope(),
                context.session().getRuntimeSessionId());
        if (record == null) {
            throw notFound("runtime_session_not_found",
                    "Runtime Session was not found");
        }
        RuntimeBindingRecord parent = bindingRepository.findById(record.getBindingId());
        if (parent == null || parent.getGeneration() != record.getRuntimeGeneration()
                || parent.getState() != RuntimeBindingRecord.State.READY
                        && parent.getState() != RuntimeBindingRecord.State.DRAINING) {
            throw conflict("runtime_admission_closed", "Runtime generation is no longer live");
        }
        if (!record.getBindingId().equals(context.binding().getBindingId())
                || record.getRuntimeGeneration() != context.binding().getGeneration()
                || record.getState() != RuntimeSessionRecord.State.READY) {
            throw conflict("runtime_session_not_ready",
                    "Runtime Session is not ready");
        }
        return record;
    }

    CompletionStage<RuntimeSessionRecord> persistedSession(
            String harnessSessionId, String runtimeSessionId) {
        return mapFailure(safeStage(() -> sessionResolver.resolveTenant(harnessSessionId)),
                "runtime_scope_resolution_failed", "Runtime scope resolution failed").thenCompose(tenant -> {
                    RuntimeSessionRecord record = sessionRepository.findHistorical(tenant, harnessSessionId, runtimeSessionId);
                    if (record == null) {
                        throw notFound("runtime_session_not_found",
                                "Runtime Session was not found");
                    }
                    if (!record.getSession().getHarnessSessionId().equals(
                            harnessSessionId)) {
                        throw conflict("runtime_session_conflict",
                                "Runtime Session belongs to another Harness Session");
                    }
                    var parent = bindingRepository.findById(record.getBindingId());
                    if (parent == null || parent.getGeneration() != record.getRuntimeGeneration()
                            || !parent.getRequest().getScope().equals(record.getSession().getScope())) {
                        throw conflict("runtime_session_conflict", "Historical Runtime parent differs");
                    }
                    if (!parent.getRequest().isManagedContext()) {
                        return RuntimeBrokerSupport.resolveScope(sessionResolver, harnessSessionId, false, null).thenApply(scope -> {
                            if (!scope.equals(record.getSession().getScope())) {
                                throw notFound("runtime_session_not_found", "Runtime Session was not found");
                            }
                            return record;
                        });
                    }
                    return CompletableFuture.completedFuture(record);
                });
    }
}
