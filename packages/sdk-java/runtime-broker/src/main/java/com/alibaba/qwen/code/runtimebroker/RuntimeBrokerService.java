package com.alibaba.qwen.code.runtimebroker;

import java.time.Duration;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/** Runtime placement, Session binding, and execution-ledger authority. */
public final class RuntimeBrokerService implements AutoCloseable {
    private static final Set<String> CONTROL_OPERATIONS = Set.of(
            "bind-history", "checkpoint", "history", "manifest",
            "begin-turn", "prepare", "confirmation", "confirm",
            "preflight");
    private static final Set<String> EXECUTION_STATES = Set.of(
            "not_started", "success", "error", "cancelled");

    private final HarnessSessionResolver sessionResolver;
    private final RuntimeProvisioner provisioner;
    private final RuntimeTransport transport;
    private final Duration idleTimeout;
    private final Duration healthFreshness;
    private final ScheduledExecutorService scheduler;
    private final AtomicBoolean closed = new AtomicBoolean();
    private final ConcurrentMap<RuntimeProvisionRequest, RuntimeBinding>
            bindings = new ConcurrentHashMap<>();
    private final ConcurrentMap<String, SessionBinding> sessions =
            new ConcurrentHashMap<>();
    private final ConcurrentMap<String, ExecutionRecord> executionsById =
            new ConcurrentHashMap<>();
    private final ConcurrentMap<String, ExecutionRecord> executionsByKey =
            new ConcurrentHashMap<>();

    public RuntimeBrokerService(HarnessSessionResolver sessionResolver,
            RuntimeProvisioner provisioner, RuntimeTransport transport) {
        this(sessionResolver, provisioner, transport, Duration.ofMinutes(5),
                Duration.ofSeconds(30), daemonScheduler());
    }

    RuntimeBrokerService(HarnessSessionResolver sessionResolver,
            RuntimeProvisioner provisioner, RuntimeTransport transport,
            Duration idleTimeout, Duration healthFreshness,
            ScheduledExecutorService scheduler) {
        this.sessionResolver = require(sessionResolver, "sessionResolver");
        this.provisioner = require(provisioner, "provisioner");
        this.transport = require(transport, "transport");
        this.idleTimeout = requirePositive(idleTimeout, "idleTimeout");
        this.healthFreshness = requirePositive(healthFreshness,
                "healthFreshness");
        this.scheduler = require(scheduler, "scheduler");
    }

    /** Begins Runtime provisioning without blocking model inference. */
    public CompletionStage<Void> warm(String harnessSessionId) {
        ensureOpen();
        String harnessId = BrokerValues.requireId(harnessSessionId,
                "harnessSessionId");
        return resolveScope(harnessId).thenCompose(scope -> binding(
                request(scope, harnessId))).thenCompose(binding ->
                        binding.ready)
                .thenApply(ignored -> null);
    }

    /** Acquires one logical Runtime Session, waiting for the warm binding. */
    public CompletionStage<Void> acquire(String harnessSessionId,
            String runtimeSessionId, String turnKind) {
        ensureOpen();
        String harnessId = BrokerValues.requireId(harnessSessionId,
                "harnessSessionId");
        String runtimeId = BrokerValues.requireId(runtimeSessionId,
                "runtimeSessionId");
        return resolveScope(harnessId).thenCompose(scope -> {
            SessionBinding session = sessions.compute(runtimeId,
                    (ignored, existing) -> {
                        if (existing != null) {
                            existing.assertIdentity(harnessId, scope, turnKind);
                            return existing;
                        }
                        RuntimeSession runtimeSession = new RuntimeSession(
                                harnessId, runtimeId, turnKind, scope);
                        return new SessionBinding(runtimeSession,
                                request(scope, harnessId));
                    });
            return session.ready.thenApply(ignored -> null);
        });
    }

    public CompletionStage<Object> control(String harnessSessionId,
            String runtimeSessionId, Map<String, Object> operation) {
        SessionBinding session = requireSession(harnessSessionId,
                runtimeSessionId);
        Map<String, Object> immutable = BrokerValues.immutableMap(operation);
        Object kind = immutable.get("kind");
        if (!(kind instanceof String)
                || !CONTROL_OPERATIONS.contains(kind)) {
            throw invalid("runtime_broker_invalid_control",
                    "Runtime Broker control operation is unsupported.");
        }
        return session.ready.thenCompose(lease -> transport.control(lease,
                session.session, immutable));
    }

    public Map<String, Object> createExecution(String idempotencyKey,
            String harnessSessionId, String runtimeSessionId, String turnId,
            String toolCallId, String requestDigest,
            Map<String, Object> reference) {
        ensureOpen();
        SessionBinding session = requireSession(harnessSessionId,
                runtimeSessionId);
        String key = BrokerValues.requireId(idempotencyKey, "idempotencyKey");
        ExecutionIdentity identity = new ExecutionIdentity(
                BrokerValues.requireId(harnessSessionId, "harnessSessionId"),
                BrokerValues.requireId(runtimeSessionId, "runtimeSessionId"),
                BrokerValues.requireId(turnId, "turnId"),
                BrokerValues.requireId(toolCallId, "toolCallId"),
                BrokerValues.requireId(requestDigest, "requestDigest"),
                BrokerValues.immutableMap(reference));
        identity.assertReference();
        ExecutionRecord candidate = new ExecutionRecord(UUID.randomUUID()
                .toString(), key, identity, session);
        executionsById.put(candidate.executionCallId, candidate);
        ExecutionRecord execution = executionsByKey.putIfAbsent(key,
                candidate);
        if (execution != null) {
            executionsById.remove(candidate.executionCallId, candidate);
            execution.assertIdentity(identity);
            return execution.snapshot();
        }
        candidate.start(transport);
        return candidate.snapshot();
    }

    public Map<String, Object> getExecution(String harnessSessionId,
            String runtimeSessionId, String executionCallId,
            Long afterSequence) {
        if (afterSequence != null && afterSequence < 0) {
            throw invalid("runtime_broker_invalid_sequence",
                    "Execution sequence must be non-negative.");
        }
        return requireExecution(harnessSessionId, runtimeSessionId,
                executionCallId).snapshot();
    }

    public CompletionStage<Map<String, Object>> cancelExecution(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId) {
        ExecutionRecord execution = requireExecution(harnessSessionId,
                runtimeSessionId, executionCallId);
        return execution.cancel(transport);
    }

    public CompletionStage<Boolean> release(String harnessSessionId,
            String runtimeSessionId) {
        SessionBinding session = requireSession(harnessSessionId,
                runtimeSessionId);
        for (ExecutionRecord execution : executionsById.values()) {
            if (execution.belongsTo(runtimeSessionId)
                    && !execution.isSettled()) {
                throw conflict("runtime_broker_execution_active",
                        "Runtime Session still owns an active execution.");
            }
        }
        return session.release(runtimeSessionId);
    }

    private CompletionStage<RuntimeScope> resolveScope(
            String harnessSessionId) {
        CompletionStage<RuntimeScope> resolved;
        try {
            resolved = sessionResolver.resolve(harnessSessionId);
        } catch (RuntimeException exception) {
            return failed(exception);
        }
        if (resolved == null) {
            return failed(unavailable("runtime_broker_scope_unavailable",
                    "Harness Session scope is unavailable."));
        }
        return resolved.thenApply(scope -> {
            if (scope == null) {
                throw unavailable("runtime_broker_scope_unavailable",
                        "Harness Session scope is unavailable.");
            }
            return scope;
        });
    }

    private CompletionStage<RuntimeBinding> binding(
            RuntimeProvisionRequest request) {
        if (closed.get()) {
            return failed(closed());
        }
        RuntimeBinding binding = bindings.computeIfAbsent(request,
                RuntimeBinding::new);
        binding.start();
        Throwable failure = binding.provisioningFailure();
        if (failure != null) {
            return failed(failure);
        }
        CompletionStage<Void> unavailable = binding.whenUnavailable();
        if (unavailable == null) {
            return CompletableFuture.completedFuture(binding);
        }
        return unavailable.thenCompose(ignored -> binding(request));
    }

    private CompletionStage<RuntimeAssignment> assign(
            RuntimeProvisionRequest request) {
        return binding(request).thenCompose(binding -> {
            if (!binding.reserveSession()) {
                return assign(request);
            }
            return binding.ready.thenCompose(lease ->
                    binding.ensureHealthy(lease)).thenApply(lease ->
                            new RuntimeAssignment(binding, lease))
                    .whenComplete((assignment, error) -> {
                        if (error != null) {
                            binding.releaseSession();
                        }
                    });
        });
    }

    private static RuntimeProvisionRequest request(RuntimeScope scope,
            String harnessSessionId) {
        return new RuntimeProvisionRequest(scope,
                "session".equals(scope.getIsolationClass())
                        ? harnessSessionId : null);
    }

    private SessionBinding requireSession(String harnessSessionId,
            String runtimeSessionId) {
        String harnessId = BrokerValues.requireId(harnessSessionId,
                "harnessSessionId");
        String runtimeId = BrokerValues.requireId(runtimeSessionId,
                "runtimeSessionId");
        SessionBinding session = sessions.get(runtimeId);
        if (session == null) {
            throw notFound("runtime_broker_session_not_found",
                    "Runtime Session was not acquired.");
        }
        session.assertHarness(harnessId);
        return session;
    }

    private ExecutionRecord requireExecution(String harnessSessionId,
            String runtimeSessionId, String executionCallId) {
        SessionBinding session = requireSession(harnessSessionId,
                runtimeSessionId);
        String executionId = BrokerValues.requireId(executionCallId,
                "executionCallId");
        ExecutionRecord execution = executionsById.get(executionId);
        if (execution == null || execution.session != session) {
            throw notFound("runtime_broker_execution_not_found",
                    "Tool execution was not found.");
        }
        return execution;
    }

    private void removeExecutions(String runtimeSessionId) {
        executionsById.entrySet().removeIf(entry -> {
            ExecutionRecord execution = entry.getValue();
            if (!execution.belongsTo(runtimeSessionId)) {
                return false;
            }
            executionsByKey.remove(execution.idempotencyKey, execution);
            return true;
        });
    }

    private static RuntimeBrokerException invalid(String code,
            String message) {
        return new RuntimeBrokerException(400, code, message, false);
    }

    private static RuntimeBrokerException notFound(String code,
            String message) {
        return new RuntimeBrokerException(404, code, message, false);
    }

    private static RuntimeBrokerException conflict(String code,
            String message) {
        return new RuntimeBrokerException(409, code, message, false);
    }

    private static RuntimeBrokerException unavailable(String code,
            String message) {
        return new RuntimeBrokerException(503, code, message, true);
    }

    private static <T> T require(T value, String name) {
        if (value == null) {
            throw new IllegalArgumentException(name + " is required");
        }
        return value;
    }

    private static Throwable unwrap(Throwable error) {
        Throwable current = error;
        while ((current instanceof CompletionException)
                && current.getCause() != null) {
            current = current.getCause();
        }
        return current;
    }

    private static <T> CompletionStage<T> failed(Throwable error) {
        CompletableFuture<T> failed = new CompletableFuture<>();
        failed.completeExceptionally(error);
        return failed;
    }

    private static Duration requirePositive(Duration value, String name) {
        if (value == null || value.isZero() || value.isNegative()) {
            throw new IllegalArgumentException(name + " must be positive");
        }
        return value;
    }

    private static ScheduledExecutorService daemonScheduler() {
        return Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable,
                    "qwen-runtime-broker-idle");
            thread.setDaemon(true);
            return thread;
        });
    }

    private void ensureOpen() {
        if (closed.get()) {
            throw closed();
        }
    }

    private static RuntimeBrokerException closed() {
        return new RuntimeBrokerException(503, "runtime_broker_closed",
                "Runtime Broker is closed.", false);
    }

    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        scheduler.shutdownNow();
        provisioner.close();
        bindings.clear();
    }

    private enum BindingState {
        PROVISIONING,
        READY,
        DRAINING,
        FAILED,
        RELEASED
    }

    private final class RuntimeBinding {
        private final RuntimeProvisionRequest request;
        private final CompletableFuture<RuntimeLease> ready =
                new CompletableFuture<>();
        private final AtomicBoolean started = new AtomicBoolean();
        private BindingState state = BindingState.PROVISIONING;
        private int activeSessions;
        private long lastHealthNanos;
        private ScheduledFuture<?> idleTask;
        private CompletableFuture<Void> drainFuture;
        private CompletableFuture<Boolean> healthCheck;
        private Throwable provisioningFailure;

        RuntimeBinding(RuntimeProvisionRequest request) {
            this.request = request;
        }

        void start() {
            if (!started.compareAndSet(false, true)) {
                return;
            }
            CompletionStage<RuntimeLease> provisioned;
            try {
                provisioned = provisioner.provision(request);
            } catch (RuntimeException exception) {
                failProvisioning(exception);
                return;
            }
            if (provisioned == null) {
                failProvisioning(unavailable(
                        "runtime_broker_provisioning_failed",
                        "Runtime provisioning returned no operation."));
                return;
            }
            provisioned.whenComplete((lease, error) -> {
                if (error != null) {
                    failProvisioning(unwrap(error));
                    return;
                }
                if (lease == null) {
                    failProvisioning(unavailable(
                            "runtime_broker_provisioning_failed",
                            "Runtime provisioning returned no lease."));
                    return;
                }
                synchronized (this) {
                    if (state != BindingState.PROVISIONING) {
                        return;
                    }
                    state = BindingState.READY;
                    lastHealthNanos = System.nanoTime();
                    if (activeSessions == 0) {
                        scheduleIdle();
                    }
                }
                ready.complete(lease);
            });
        }

        synchronized CompletionStage<Void> whenUnavailable() {
            if (state == BindingState.PROVISIONING
                    || state == BindingState.READY) {
                return null;
            }
            return drainFuture == null
                    ? CompletableFuture.completedFuture(null) : drainFuture;
        }

        synchronized Throwable provisioningFailure() {
            return provisioningFailure;
        }

        synchronized boolean reserveSession() {
            if (state != BindingState.PROVISIONING
                    && state != BindingState.READY) {
                return false;
            }
            activeSessions++;
            cancelIdle();
            return true;
        }

        synchronized void releaseSession() {
            if (activeSessions == 0) {
                return;
            }
            activeSessions--;
            if (activeSessions == 0 && state == BindingState.READY) {
                scheduleIdle();
            }
        }

        CompletionStage<RuntimeLease> ensureHealthy(RuntimeLease lease) {
            CompletableFuture<Boolean> check;
            synchronized (this) {
                if (state != BindingState.READY
                        && state != BindingState.PROVISIONING) {
                    return failed(unavailable(
                            "runtime_broker_health_failed",
                            "Managed Runtime is unavailable."));
                }
                if (lastHealthNanos != 0
                        && System.nanoTime() - lastHealthNanos
                                < healthFreshness.toNanos()) {
                    return CompletableFuture.completedFuture(lease);
                }
                if (healthCheck != null) {
                    return checkedLease(lease, healthCheck);
                }
                healthCheck = new CompletableFuture<>();
                check = healthCheck;
            }
            CompletionStage<Boolean> health;
            try {
                health = provisioner.health(lease);
            } catch (RuntimeException exception) {
                check.completeExceptionally(exception);
                return checkedLease(lease, check);
            }
            if (health == null) {
                check.complete(false);
                return checkedLease(lease, check);
            }
            health.whenComplete((healthy, error) -> {
                if (error == null) {
                    check.complete(healthy);
                } else {
                    check.completeExceptionally(unwrap(error));
                }
            });
            return checkedLease(lease, check);
        }

        private CompletionStage<RuntimeLease> checkedLease(RuntimeLease lease,
                CompletableFuture<Boolean> check) {
            return check.handle((healthy, error) -> {
                boolean accepted;
                synchronized (this) {
                    if (healthCheck == check) {
                        healthCheck = null;
                    }
                    accepted = error == null && Boolean.TRUE.equals(healthy)
                            && state == BindingState.READY;
                    if (accepted) {
                        lastHealthNanos = System.nanoTime();
                    }
                }
                if (accepted) {
                    return lease;
                }
                throw new CompletionException(healthFailure(error == null
                        ? null : unwrap(error)));
            });
        }

        private RuntimeBrokerException healthFailure(Throwable cause) {
            RuntimeBrokerException failure = unavailable(
                    "runtime_broker_health_failed",
                    "Managed Runtime health check failed.");
            if (cause != null) {
                failure.initCause(cause);
            }
            beginDrain(true);
            return failure;
        }

        private void failProvisioning(Throwable error) {
            synchronized (this) {
                state = BindingState.FAILED;
                provisioningFailure = error;
                drainFuture = CompletableFuture.completedFuture(null);
            }
            bindings.remove(request, this);
            ready.completeExceptionally(error);
        }

        private synchronized void scheduleIdle() {
            cancelIdle();
            try {
                idleTask = scheduler.schedule(() -> beginDrain(false),
                        idleTimeout.toNanos(), TimeUnit.NANOSECONDS);
            } catch (RuntimeException ignored) {
                if (!closed.get()) {
                    throw ignored;
                }
            }
        }

        private synchronized void cancelIdle() {
            if (idleTask != null) {
                idleTask.cancel(false);
                idleTask = null;
            }
        }

        private void beginDrain(boolean failedState) {
            CompletableFuture<Void> draining;
            synchronized (this) {
                if (state == BindingState.DRAINING
                        || state == BindingState.FAILED
                        || state == BindingState.RELEASED
                        || (!failedState && (state != BindingState.READY
                                || activeSessions != 0))) {
                    return;
                }
                state = failedState ? BindingState.FAILED
                        : BindingState.DRAINING;
                cancelIdle();
                drainFuture = new CompletableFuture<>();
                draining = drainFuture;
            }
            ready.thenCompose(lease -> provisioner.drain(request, lease)
                    .thenCompose(ignored -> provisioner.release(request,
                            lease))).whenComplete((ignored, error) -> {
                                bindings.remove(request, this);
                                synchronized (this) {
                                    state = error == null
                                            ? BindingState.RELEASED
                                            : BindingState.FAILED;
                                }
                                if (error == null) {
                                    draining.complete(null);
                                } else {
                                    draining.completeExceptionally(
                                            unwrap(error));
                                }
                            });
        }
    }

    private static final class RuntimeAssignment {
        private final RuntimeBinding binding;
        private final RuntimeLease lease;

        RuntimeAssignment(RuntimeBinding binding, RuntimeLease lease) {
            this.binding = binding;
            this.lease = lease;
        }
    }

    private final class SessionBinding {
        private final RuntimeSession session;
        private final CompletableFuture<RuntimeAssignment> assignment;
        private final CompletableFuture<RuntimeLease> ready;
        private CompletableFuture<Boolean> release;

        SessionBinding(RuntimeSession session,
                RuntimeProvisionRequest request) {
            this.session = session;
            this.assignment = assign(request).toCompletableFuture();
            this.ready = assignment.thenCompose(value -> transport.acquire(
                    value.lease, session).thenApply(ignored -> value.lease))
                    .whenComplete((lease, error) -> {
                        if (error != null) {
                            assignment.thenAccept(value ->
                                    value.binding.releaseSession());
                        }
                    }).toCompletableFuture();
        }

        void assertIdentity(String harnessSessionId, RuntimeScope scope,
                String turnKind) {
            assertHarness(harnessSessionId);
            if (!session.getScope().equals(scope)
                    || !session.getTurnKind().equals(turnKind)) {
                throw conflict("runtime_broker_session_conflict",
                        "Runtime Session identity changed.");
            }
        }

        void assertHarness(String harnessSessionId) {
            if (!session.getHarnessSessionId().equals(harnessSessionId)) {
                throw conflict("runtime_broker_session_conflict",
                        "Runtime Session belongs to another Harness Session.");
            }
        }

        synchronized CompletionStage<Boolean> release(
                String runtimeSessionId) {
            if (release != null) {
                return release;
            }
            release = assignment.thenCompose(value -> ready.thenCompose(
                    lease -> transport.release(lease, session)).thenApply(
                            released -> {
                                if (Boolean.TRUE.equals(released)) {
                                    sessions.remove(runtimeSessionId, this);
                                    removeExecutions(runtimeSessionId);
                                    value.binding.releaseSession();
                                    return true;
                                }
                                return false;
                            })).toCompletableFuture();
            return release;
        }
    }

    private static final class ExecutionIdentity {
        private final String harnessSessionId;
        private final String runtimeSessionId;
        private final String turnId;
        private final String toolCallId;
        private final String requestDigest;
        private final Map<String, Object> reference;

        ExecutionIdentity(String harnessSessionId, String runtimeSessionId,
                String turnId, String toolCallId, String requestDigest,
                Map<String, Object> reference) {
            this.harnessSessionId = harnessSessionId;
            this.runtimeSessionId = runtimeSessionId;
            this.turnId = turnId;
            this.toolCallId = toolCallId;
            this.requestDigest = requestDigest;
            this.reference = reference;
        }

        void assertReference() {
            if (!runtimeSessionId.equals(reference.get("sessionId"))
                    || !turnId.equals(reference.get("promptId"))
                    || !toolCallId.equals(reference.get("callId"))
                    || !requestDigest.equals(reference.get("argsDigest"))) {
                throw conflict("runtime_broker_execution_conflict",
                        "Tool execution reference identity changed.");
            }
        }

        boolean sameAs(ExecutionIdentity other) {
            return harnessSessionId.equals(other.harnessSessionId)
                    && runtimeSessionId.equals(other.runtimeSessionId)
                    && turnId.equals(other.turnId)
                    && toolCallId.equals(other.toolCallId)
                    && requestDigest.equals(other.requestDigest)
                    && reference.equals(other.reference);
        }
    }

    private static final class ExecutionRecord {
        private final String executionCallId;
        private final String idempotencyKey;
        private final ExecutionIdentity identity;
        private final SessionBinding session;
        private String state = "prepared";
        private boolean cancelRequested;
        private boolean dispatched;
        private Map<String, Object> result;
        private CompletableFuture<Map<String, Object>> cancellation;

        ExecutionRecord(String executionCallId, String idempotencyKey,
                ExecutionIdentity identity, SessionBinding session) {
            this.executionCallId = executionCallId;
            this.idempotencyKey = idempotencyKey;
            this.identity = identity;
            this.session = session;
        }

        void start(RuntimeTransport transport) {
            session.ready.thenCompose(lease -> {
                synchronized (this) {
                    if (cancelRequested) {
                        settle(cancelledResult());
                        return CompletableFuture.completedFuture(result);
                    }
                    dispatched = true;
                    state = "executing";
                }
                return transport.execute(lease, session.session,
                        identity.reference);
            })
                    .whenComplete((physicalResult, error) -> {
                        if (error != null) {
                            settle(errorResult());
                        } else {
                            try {
                                settle(validateExecutionResult(physicalResult));
                            } catch (RuntimeException invalidResult) {
                                settle(errorResult());
                            }
                        }
                    });
        }

        synchronized CompletionStage<Map<String, Object>> cancel(
                RuntimeTransport transport) {
            if ("settled".equals(state)) {
                return CompletableFuture.completedFuture(snapshot());
            }
            cancelRequested = true;
            state = "cancel_requested";
            if (cancellation == null) {
                cancellation = session.ready.thenCompose(lease -> {
                    synchronized (this) {
                        if (!dispatched) {
                            settle(cancelledResult());
                            return CompletableFuture.completedFuture(null);
                        }
                    }
                    return transport.cancel(lease, session.session,
                            identity.reference);
                }).thenApply(status -> {
                    if (status == null) {
                        return snapshot();
                    }
                    absorbStatus(status);
                    return snapshot();
                }).toCompletableFuture();
            }
            return cancellation;
        }

        synchronized void settle(Map<String, Object> executionResult) {
            if ("settled".equals(state)) {
                return;
            }
            result = executionResult;
            state = "settled";
        }

        synchronized void absorbStatus(Map<String, Object> status) {
            if ("settled".equals(state)) {
                return;
            }
            if (status == null) {
                throw unavailable("runtime_broker_cancel_failed",
                        "Runtime cancellation returned no status.");
            }
            Object runtimeState = status.get("state");
            if (!(runtimeState instanceof String)
                    || !Set.of("prepared", "executing", "cancel_requested",
                            "settled").contains(runtimeState)) {
                throw unavailable("runtime_broker_cancel_failed",
                        "Runtime cancellation returned an invalid status.");
            }
            Map<String, Object> nextResult = null;
            if ("settled".equals(runtimeState)) {
                Object runtimeResult = status.get("result");
                if (!(runtimeResult instanceof Map)) {
                    throw unavailable("runtime_broker_cancel_failed",
                            "Runtime cancellation omitted its result.");
                }
                @SuppressWarnings("unchecked")
                Map<String, Object> cast = (Map<String, Object>) runtimeResult;
                nextResult = validateExecutionResult(cast);
            }
            state = (String) runtimeState;
            cancelRequested = cancelRequested || Boolean.TRUE.equals(
                    status.get("cancelRequested"));
            result = nextResult;
        }

        synchronized Map<String, Object> snapshot() {
            Map<String, Object> status = new LinkedHashMap<>();
            status.put("state", state);
            status.put("cancelRequested", cancelRequested);
            status.put("lastSeq", 0);
            status.put("firstAvailableSeq", 1);
            status.put("progressGap", false);
            status.put("progress", Collections.emptyList());
            if (result != null) {
                status.put("result", result);
            }
            Map<String, Object> response = new LinkedHashMap<>();
            response.put("executionCallId", executionCallId);
            response.put("status", Collections.unmodifiableMap(status));
            return Collections.unmodifiableMap(response);
        }

        synchronized boolean isSettled() {
            return "settled".equals(state);
        }

        boolean belongsTo(String runtimeSessionId) {
            return identity.runtimeSessionId.equals(runtimeSessionId);
        }

        void assertIdentity(ExecutionIdentity candidate) {
            if (!identity.sameAs(candidate)) {
                throw conflict("runtime_broker_execution_conflict",
                        "Execution idempotency key changed content.");
            }
        }

        private static Map<String, Object> validateExecutionResult(
                Map<String, Object> physicalResult) {
            if (physicalResult == null
                    || !EXECUTION_STATES.contains(
                            physicalResult.get("executionStatus"))) {
                throw unavailable("runtime_broker_execution_failed",
                        "Runtime returned an invalid execution result.");
            }
            return BrokerValues.immutableMap(physicalResult);
        }

        private static Map<String, Object> errorResult() {
            Map<String, Object> error = new LinkedHashMap<>();
            error.put("message", "Managed Runtime execution failed.");
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("executionStatus", "error");
            result.put("error", Collections.unmodifiableMap(error));
            return Collections.unmodifiableMap(result);
        }

        private static Map<String, Object> cancelledResult() {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("executionStatus", "cancelled");
            return Collections.unmodifiableMap(result);
        }
    }
}
