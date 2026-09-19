package com.alibaba.qwen.code.runtimebroker;

import java.time.Duration;
import java.time.Instant;
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
import java.util.function.UnaryOperator;

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
    private final RuntimeBindingRepository bindingRepository;
    private final RuntimeSessionRepository runtimeSessionRepository;
    private final ToolExecutionRepository executionRepository;
    private final String brokerOwnerId;
    private final Duration operationLeaseDuration;
    private final Duration dispatchLeaseDuration;
    private final Duration idleTimeout;
    private final Duration healthFreshness;
    private final ScheduledExecutorService scheduler;
    private final AtomicBoolean closed = new AtomicBoolean();
    private final Object harnessLifecycleLock = new Object();
    private final ConcurrentMap<String, RuntimeBinding> bindings =
            new ConcurrentHashMap<>();
    private final ConcurrentMap<String, SessionBinding> sessions =
            new ConcurrentHashMap<>();
    private final ConcurrentMap<String, ExecutionRecord> executionsById =
            new ConcurrentHashMap<>();
    private final Set<String> retiredHarnessSessions =
            ConcurrentHashMap.newKeySet();

    public RuntimeBrokerService(HarnessSessionResolver sessionResolver,
            RuntimeProvisioner provisioner, RuntimeTransport transport) {
        this(sessionResolver, provisioner, transport,
                new InMemoryRuntimeBindingRepository(),
                new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(),
                UUID.randomUUID().toString(), Duration.ofSeconds(30),
                Duration.ofSeconds(30), Duration.ofMinutes(5),
                Duration.ofSeconds(30), daemonScheduler());
    }

    public RuntimeBrokerService(HarnessSessionResolver sessionResolver,
            RuntimeProvisioner provisioner, RuntimeTransport transport,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository runtimeSessionRepository,
            ToolExecutionRepository executionRepository,
            String brokerOwnerId) {
        this(sessionResolver, provisioner, transport, bindingRepository,
                runtimeSessionRepository, executionRepository, brokerOwnerId,
                Duration.ofSeconds(30), Duration.ofSeconds(30),
                Duration.ofMinutes(5), Duration.ofSeconds(30),
                daemonScheduler());
    }

    public RuntimeBrokerService(HarnessSessionResolver sessionResolver,
            RuntimeProvisioner provisioner, RuntimeTransport transport,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository runtimeSessionRepository,
            ToolExecutionRepository executionRepository,
            String brokerOwnerId, Duration operationLeaseDuration,
            Duration dispatchLeaseDuration, Duration idleTimeout,
            Duration healthFreshness) {
        this(sessionResolver, provisioner, transport, bindingRepository,
                runtimeSessionRepository, executionRepository, brokerOwnerId,
                operationLeaseDuration, dispatchLeaseDuration, idleTimeout,
                healthFreshness, daemonScheduler());
    }

    RuntimeBrokerService(HarnessSessionResolver sessionResolver,
            RuntimeProvisioner provisioner, RuntimeTransport transport,
            Duration idleTimeout, Duration healthFreshness,
            ScheduledExecutorService scheduler) {
        this(sessionResolver, provisioner, transport,
                new InMemoryRuntimeBindingRepository(),
                new InMemoryRuntimeSessionRepository(),
                new InMemoryToolExecutionRepository(),
                UUID.randomUUID().toString(), Duration.ofSeconds(30),
                Duration.ofSeconds(30), idleTimeout, healthFreshness,
                scheduler);
    }

    RuntimeBrokerService(HarnessSessionResolver sessionResolver,
            RuntimeProvisioner provisioner, RuntimeTransport transport,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository runtimeSessionRepository,
            ToolExecutionRepository executionRepository,
            String brokerOwnerId, Duration operationLeaseDuration,
            Duration dispatchLeaseDuration, Duration idleTimeout,
            Duration healthFreshness, ScheduledExecutorService scheduler) {
        this.sessionResolver = require(sessionResolver, "sessionResolver");
        this.provisioner = require(provisioner, "provisioner");
        this.transport = require(transport, "transport");
        this.bindingRepository = require(bindingRepository,
                "bindingRepository");
        this.runtimeSessionRepository = require(runtimeSessionRepository,
                "runtimeSessionRepository");
        this.executionRepository = require(executionRepository,
                "executionRepository");
        this.brokerOwnerId = BrokerValues.requireId(brokerOwnerId,
                "brokerOwnerId");
        this.operationLeaseDuration = requirePositive(operationLeaseDuration,
                "operationLeaseDuration");
        this.dispatchLeaseDuration = requirePositive(dispatchLeaseDuration,
                "dispatchLeaseDuration");
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
        ensureHarnessActive(harnessId);
        return resolveScope(harnessId).thenCompose(scope -> binding(
                request(scope, harnessId), harnessId)).thenCompose(binding ->
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
        ensureHarnessActive(harnessId);
        return resolveScope(harnessId).thenCompose(scope -> {
            ensureHarnessActive(harnessId);
            RuntimeSession runtimeSession = new RuntimeSession(harnessId,
                    runtimeId, turnKind, scope);
            return binding(request(scope, harnessId), harnessId)
                    .thenCompose(binding -> {
                        SessionBinding session = sessions.compute(runtimeId,
                                (ignored, existing) -> {
                                    if (existing != null) {
                                        existing.assertIdentity(harnessId,
                                                scope, turnKind);
                                        return existing;
                                    }
                                    return new SessionBinding(runtimeSession,
                                            binding);
                                });
                        return session.ready.thenApply(ignored -> null);
                    });
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
        ToolExecutionRecord candidate = ToolExecutionRecord.prepared(
                UUID.randomUUID().toString(), key,
                session.binding.bindingId, session.binding.generation(),
                BrokerValues.requireId(harnessSessionId, "harnessSessionId"),
                BrokerValues.requireId(runtimeSessionId, "runtimeSessionId"),
                BrokerValues.requireId(turnId, "turnId"),
                BrokerValues.requireId(toolCallId, "toolCallId"),
                BrokerValues.requireId(requestDigest, "requestDigest"),
                BrokerValues.immutableMap(reference));
        ToolExecutionRecord persisted = executionRepository.findOrCreate(
                candidate);
        if (!persisted.sameRequest(candidate)) {
            throw conflict("runtime_broker_execution_conflict",
                    "Execution idempotency key changed content.");
        }
        ExecutionRecord execution = executionsById.computeIfAbsent(
                persisted.getExecutionCallId(), ignored ->
                        new ExecutionRecord(persisted, session));
        execution.assertSession(session);
        execution.start(transport);
        return execution.snapshot();
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

    public Map<String, Object> resolveUnknownExecution(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId,
            UnknownExecutionResolution resolution) {
        ensureOpen();
        String harnessId = BrokerValues.requireId(harnessSessionId,
                "harnessSessionId");
        String runtimeId = BrokerValues.requireId(runtimeSessionId,
                "runtimeSessionId");
        String executionId = BrokerValues.requireId(executionCallId,
                "executionCallId");
        if (resolution == null) {
            throw invalid("runtime_broker_invalid_resolution",
                    "Unknown execution resolution is required.");
        }
        Map<String, Object> result = unknownResolutionResult(resolution);
        while (true) {
            ToolExecutionRecord current = executionRepository
                    .findByExecutionCallId(executionId);
            if (current == null
                    || !current.getHarnessSessionId().equals(harnessId)
                    || !current.getRuntimeSessionId().equals(runtimeId)) {
                throw notFound("runtime_broker_execution_not_found",
                        "Tool execution was not found.");
            }
            if (current.isSettled()) {
                if (result.equals(current.getResult())) {
                    return executionSnapshot(current);
                }
                throw conflict("runtime_broker_resolution_conflict",
                        "Tool execution already has another resolution.");
            }
            if (current.getState()
                    != ToolExecutionRecord.State.UNKNOWN) {
                throw conflict("runtime_broker_execution_not_unknown",
                        "Tool execution outcome is not unknown.");
            }
            ToolExecutionRecord updated = executionRepository.compareAndSet(
                    current, current.resolveUnknown(result, Instant.now()));
            if (updated != null) {
                return executionSnapshot(updated);
            }
        }
    }

    public CompletionStage<Boolean> release(String harnessSessionId,
            String runtimeSessionId) {
        SessionBinding session = requireSessionForRelease(harnessSessionId,
                runtimeSessionId);
        if (executionRepository.hasActiveByRuntimeSession(runtimeSessionId)) {
            throw conflict("runtime_broker_execution_active",
                    "Runtime Session still owns an active execution.");
        }
        return session.release(runtimeSessionId);
    }

    /** Drains the session-isolated Runtime owned by one Harness Session. */
    public CompletionStage<Void> drainHarness(String harnessSessionId) {
        ensureOpen();
        String harnessId = BrokerValues.requireId(harnessSessionId,
                "harnessSessionId");
        CompletableFuture<?>[] drains;
        synchronized (harnessLifecycleLock) {
            retiredHarnessSessions.add(harnessId);
            Map<String, RuntimeBinding> targeted = new LinkedHashMap<>();
            bindings.values().stream().filter(binding -> harnessId.equals(
                    binding.request.getIsolationKey())).forEach(binding ->
                            targeted.put(binding.bindingId, binding));
            for (RuntimeBindingRecord record : bindingRepository
                    .findActiveByIsolationKey(harnessId)) {
                RuntimeBinding binding = bindings.computeIfAbsent(
                        record.getBindingId(), ignored ->
                                new RuntimeBinding(record));
                binding.start();
                targeted.put(binding.bindingId, binding);
            }
            drains = targeted.values().stream()
                    .map(binding -> binding.requestDrain()
                            .toCompletableFuture())
                    .toArray(CompletableFuture[]::new);
        }
        return CompletableFuture.allOf(drains);
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
            RuntimeProvisionRequest request, String harnessSessionId) {
        if (closed.get()) {
            return failed(closed());
        }
        RuntimeBinding binding;
        synchronized (harnessLifecycleLock) {
            if (retiredHarnessSessions.contains(harnessSessionId)) {
                return failed(harnessRetired());
            }
            RuntimeBindingRecord record = bindingRepository.findOrCreate(
                    request);
            if (!record.getRequest().equals(request)) {
                return failed(conflict("runtime_broker_binding_conflict",
                        "Runtime binding identity changed."));
            }
            binding = bindings.computeIfAbsent(record.getBindingId(),
                    ignored -> new RuntimeBinding(record));
        }
        binding.start();
        Throwable failure = binding.provisioningFailure();
        if (failure != null) {
            return failed(failure);
        }
        CompletionStage<Void> unavailable = binding.whenUnavailable();
        if (unavailable == null) {
            return CompletableFuture.completedFuture(binding);
        }
        return unavailable.thenCompose(ignored -> binding(request,
                harnessSessionId));
    }

    private static RuntimeProvisionRequest request(RuntimeScope scope,
            String harnessSessionId) {
        return new RuntimeProvisionRequest(scope,
                "session".equals(scope.getIsolationClass())
                        ? harnessSessionId : null);
    }

    private void ensureHarnessActive(String harnessSessionId) {
        if (retiredHarnessSessions.contains(harnessSessionId)) {
            throw harnessRetired();
        }
    }

    private static RuntimeBrokerException harnessRetired() {
        return conflict("runtime_broker_session_closed",
                "Harness Session is closed.");
    }

    private SessionBinding requireSession(String harnessSessionId,
            String runtimeSessionId) {
        return requireSession(harnessSessionId, runtimeSessionId, false);
    }

    private SessionBinding requireSessionForRelease(String harnessSessionId,
            String runtimeSessionId) {
        return requireSession(harnessSessionId, runtimeSessionId, true);
    }

    private SessionBinding requireSession(String harnessSessionId,
            String runtimeSessionId, boolean allowReleasing) {
        String harnessId = BrokerValues.requireId(harnessSessionId,
                "harnessSessionId");
        String runtimeId = BrokerValues.requireId(runtimeSessionId,
                "runtimeSessionId");
        SessionBinding session = sessions.get(runtimeId);
        if (session == null) {
            RuntimeSessionRecord record = runtimeSessionRepository.findById(
                    runtimeId);
            if (record == null || !record.isActive()) {
                throw notFound("runtime_broker_session_not_found",
                        "Runtime Session was not acquired.");
            }
            RuntimeBindingRecord bindingRecord = bindingRepository.findById(
                    record.getBindingId());
            if (bindingRecord == null || !bindingRecord.isActive()
                    || bindingRecord.getGeneration()
                            != record.getRuntimeGeneration()) {
                throw unavailable("runtime_broker_binding_unavailable",
                        "Runtime Session binding is unavailable.");
            }
            RuntimeBinding runtimeBinding = bindings.computeIfAbsent(
                    bindingRecord.getBindingId(),
                    ignored -> new RuntimeBinding(bindingRecord));
            runtimeBinding.start();
            boolean resumeRelease = record.getState()
                    == RuntimeSessionRecord.State.RELEASING;
            if (resumeRelease && !allowReleasing) {
                throw conflict("runtime_broker_session_conflict",
                        "Runtime Session lifecycle changed.");
            }
            SessionBinding restored = new SessionBinding(record,
                    runtimeBinding, false, resumeRelease);
            SessionBinding existing = sessions.putIfAbsent(runtimeId,
                    restored);
            session = existing == null ? restored : existing;
        }
        session.assertHarness(harnessId);
        session.assertBindingAvailable();
        if (allowReleasing) {
            session.assertReleasable();
        } else {
            session.assertOperational();
        }
        return session;
    }

    private ExecutionRecord requireExecution(String harnessSessionId,
            String runtimeSessionId, String executionCallId) {
        String harnessId = BrokerValues.requireId(harnessSessionId,
                "harnessSessionId");
        String runtimeId = BrokerValues.requireId(runtimeSessionId,
                "runtimeSessionId");
        String executionId = BrokerValues.requireId(executionCallId,
                "executionCallId");
        ToolExecutionRecord record = executionRepository
                .findByExecutionCallId(executionId);
        if (record == null
                || !record.getHarnessSessionId().equals(harnessId)
                || !record.getRuntimeSessionId().equals(runtimeId)) {
            throw notFound("runtime_broker_execution_not_found",
                    "Tool execution was not found.");
        }
        if (record.getState() == ToolExecutionRecord.State.UNKNOWN) {
            throw executionUnknown();
        }
        SessionBinding session;
        try {
            session = requireSession(harnessId, runtimeId);
        } catch (RuntimeBrokerException error) {
            if (!record.isSettled() && makesOutcomeUnknown(error)) {
                ToolExecutionRecord unknown = markExecutionUnknown(
                        executionId);
                if (unknown != null && unknown.getState()
                        == ToolExecutionRecord.State.UNKNOWN) {
                    throw executionUnknown();
                }
            }
            throw error;
        }
        ExecutionRecord execution = executionsById.computeIfAbsent(
                executionId, ignored -> new ExecutionRecord(record, session));
        execution.assertSession(session);
        return execution;
    }

    private ToolExecutionRecord markExecutionUnknown(
            String executionCallId) {
        while (true) {
            ToolExecutionRecord current = executionRepository
                    .findByExecutionCallId(executionCallId);
            if (current == null || current.isSettled()
                    || current.getState()
                            == ToolExecutionRecord.State.UNKNOWN) {
                return current;
            }
            ToolExecutionRecord updated = executionRepository.compareAndSet(
                    current, current.withUnknown());
            if (updated != null) {
                return updated;
            }
        }
    }

    private boolean executionBindingAvailable(ToolExecutionRecord execution) {
        RuntimeBindingRecord binding = bindingRepository.findById(
                execution.getBindingId());
        return binding != null && binding.isActive()
                && binding.getGeneration()
                        == execution.getRuntimeGeneration();
    }

    private static boolean makesOutcomeUnknown(RuntimeBrokerException error) {
        return Set.of("runtime_broker_binding_unavailable",
                "runtime_broker_session_not_found",
                "runtime_broker_session_conflict").contains(error.getCode());
    }

    private static RuntimeBrokerException executionUnknown() {
        return unavailable("runtime_broker_execution_unknown",
                "Tool execution outcome is unknown.");
    }

    private void removeExecutions(String runtimeSessionId) {
        executionsById.entrySet().removeIf(entry ->
                entry.getValue().belongsTo(runtimeSessionId));
    }

    private static Map<String, Object> unknownResolutionResult(
            UnknownExecutionResolution resolution) {
        Map<String, Object> result = new LinkedHashMap<>();
        if (resolution
                == UnknownExecutionResolution.CONFIRMED_NOT_EXECUTED) {
            result.put("executionStatus", "not_started");
            result.put("resolution", "confirmed_not_executed");
        } else {
            result.put("executionStatus", "error");
            result.put("errorCode", "runtime_broker_execution_unknown");
            result.put("resolution", "accepted_unknown");
        }
        return Collections.unmodifiableMap(result);
    }

    private static Map<String, Object> executionSnapshot(
            ToolExecutionRecord record) {
        if (record == null) {
            throw notFound("runtime_broker_execution_not_found",
                    "Tool execution was not found.");
        }
        if (record.getState() == ToolExecutionRecord.State.UNKNOWN) {
            throw executionUnknown();
        }
        Map<String, Object> status = new LinkedHashMap<>();
        status.put("state", executionState(record.getState()));
        status.put("cancelRequested", record.isCancelRequested());
        status.put("lastSeq", record.getLastSequence());
        status.put("firstAvailableSeq", record.getLastSequence() + 1);
        status.put("progressGap", false);
        status.put("progress", Collections.emptyList());
        if (record.getResult() != null) {
            status.put("result", record.getResult());
        }
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("executionCallId", record.getExecutionCallId());
        response.put("status", Collections.unmodifiableMap(status));
        return Collections.unmodifiableMap(response);
    }

    private static String executionState(ToolExecutionRecord.State state) {
        switch (state) {
            case PREPARED:
                return "prepared";
            case DISPATCHING:
            case EXECUTING:
                return "executing";
            case CANCEL_REQUESTED:
                return "cancel_requested";
            case SETTLED:
                return "settled";
            case UNKNOWN:
                throw executionUnknown();
            default:
                throw new IllegalStateException("Unsupported execution state");
        }
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

    private final class RuntimeBinding {
        private final String bindingId;
        private final RuntimeProvisionRequest request;
        private final CompletableFuture<RuntimeLease> ready =
                new CompletableFuture<>();
        private final AtomicBoolean started = new AtomicBoolean();
        private final AtomicBoolean provisioning = new AtomicBoolean();
        private final AtomicBoolean draining = new AtomicBoolean();
        private long lastHealthNanos;
        private ScheduledFuture<?> idleTask;
        private ScheduledFuture<?> operationRenewal;
        private CompletableFuture<Void> drainFuture;
        private CompletableFuture<Void> unavailableFuture;
        private boolean drainPollScheduled;
        private boolean unavailablePollScheduled;
        private CompletableFuture<Boolean> healthCheck;
        private Throwable provisioningFailure;

        RuntimeBinding(RuntimeBindingRecord record) {
            bindingId = record.getBindingId();
            request = record.getRequest();
            if (record.getState() == RuntimeBindingRecord.State.READY) {
                ready.complete(record.getLease());
            } else if (record.getState()
                    == RuntimeBindingRecord.State.DRAINING) {
                ready.complete(record.getLease());
            }
        }

        long generation() {
            RuntimeBindingRecord current = record();
            if (current == null) {
                throw unavailable("runtime_broker_binding_lost",
                        "Runtime binding disappeared.");
            }
            return current.getGeneration();
        }

        void start() {
            if (!started.compareAndSet(false, true)) {
                return;
            }
            driveProvisioning();
        }

        private void driveProvisioning() {
            RuntimeBindingRecord current = record();
            if (current == null) {
                failProvisioning(unavailable(
                        "runtime_broker_provisioning_failed",
                        "Runtime binding disappeared."));
                return;
            }
            if (current.getState() == RuntimeBindingRecord.State.READY) {
                lastHealthNanos = System.nanoTime();
                ready.complete(current.getLease());
                long activeSessions = activeSessionCount(current);
                if (activeSessions == 0 && !current.isDrainRequested()) {
                    scheduleIdle();
                }
                if (current.isDrainRequested() && activeSessions == 0) {
                    beginDrain(false);
                } else if (current.isDrainRequested()) {
                    scheduleDrainPoll();
                }
                return;
            }
            if (current.getState() == RuntimeBindingRecord.State.DRAINING) {
                ready.complete(current.getLease());
                scheduleUnavailablePoll();
                return;
            }
            if (current.getState()
                    != RuntimeBindingRecord.State.PROVISIONING) {
                failProvisioning(unavailable(
                        "runtime_broker_provisioning_failed",
                        "Runtime binding is unavailable."));
                return;
            }
            RuntimeBindingRecord claimed = bindingRepository.claimOperation(
                    bindingId, brokerOwnerId, operationLeaseDuration);
            if (claimed == null
                    || !brokerOwnerId.equals(claimed.getOperationOwner())) {
                scheduleProvisioningPoll();
                return;
            }
            if (!provisioning.compareAndSet(false, true)) {
                return;
            }
            startOperationRenewal(claimed.getOperationGeneration());
            CompletionStage<RuntimeLease> provisioned;
            try {
                RuntimeProvisionSeed seed = claimed.getProvisionSeed();
                provisioned = seed == null
                        ? provisioner.provision(request)
                        : provisioner.provision(request, seed);
            } catch (RuntimeException exception) {
                failProvisioning(exception, claimed);
                return;
            }
            if (provisioned == null) {
                failProvisioning(unavailable(
                        "runtime_broker_provisioning_failed",
                        "Runtime provisioning returned no operation."),
                        claimed);
                return;
            }
            provisioned.whenComplete((lease, error) -> {
                if (error != null) {
                    failProvisioning(unwrap(error), claimed);
                    return;
                }
                if (lease == null) {
                    failProvisioning(unavailable(
                            "runtime_broker_provisioning_failed",
                            "Runtime provisioning returned no lease."),
                            claimed);
                    return;
                }
                RuntimeBindingRecord updated = updateRecord(record -> {
                    if (record.getState()
                            != RuntimeBindingRecord.State.PROVISIONING
                            || !brokerOwnerId.equals(
                                    record.getOperationOwner())
                            || record.getOperationGeneration()
                                    != claimed.getOperationGeneration()) {
                        return record;
                    }
                    return record.withState(RuntimeBindingRecord.State.READY,
                            lease, Instant.now()).withOperation(null, null,
                                    record.getOperationGeneration());
                });
                stopOperationRenewal();
                provisioning.set(false);
                if (updated.getState()
                        != RuntimeBindingRecord.State.READY) {
                    scheduleProvisioningPoll();
                    return;
                }
                lastHealthNanos = System.nanoTime();
                long activeSessions = activeSessionCount(updated);
                boolean drainNow = updated.isDrainRequested()
                        && activeSessions == 0;
                if (!drainNow && activeSessions == 0
                        && !updated.isDrainRequested()) {
                    scheduleIdle();
                }
                ready.complete(lease);
                if (drainNow) {
                    beginDrain(false);
                } else if (updated.isDrainRequested()) {
                    scheduleDrainPoll();
                }
            });
        }

        private void scheduleProvisioningPoll() {
            try {
                scheduler.schedule(this::driveProvisioning, 25,
                        TimeUnit.MILLISECONDS);
            } catch (RuntimeException error) {
                if (!closed.get()) {
                    failProvisioning(error);
                }
            }
        }

        synchronized CompletionStage<Void> whenUnavailable() {
            RuntimeBindingRecord current = record();
            if (current != null
                    && (current.getState()
                            == RuntimeBindingRecord.State.PROVISIONING
                            || current.getState()
                                    == RuntimeBindingRecord.State.READY)
                    && !current.isDrainRequested()) {
                return null;
            }
            if (current == null || !current.isActive()) {
                return CompletableFuture.completedFuture(null);
            }
            if (unavailableFuture == null) {
                unavailableFuture = new CompletableFuture<>();
            }
            scheduleUnavailablePoll();
            return unavailableFuture;
        }

        synchronized Throwable provisioningFailure() {
            return provisioningFailure;
        }

        synchronized boolean reserveSession() {
            RuntimeBindingRecord current = record();
            if (current == null
                    || current.isDrainRequested()
                    || (current.getState()
                            != RuntimeBindingRecord.State.PROVISIONING
                            && current.getState()
                                    != RuntimeBindingRecord.State.READY)) {
                return false;
            }
            cancelIdle();
            return true;
        }

        void releaseSession() {
            RuntimeBindingRecord current = record();
            if (current == null || activeSessionCount(current) != 0) {
                return;
            }
            if (current.isDrainRequested()) {
                beginDrain(false);
            } else if (current.getState()
                    == RuntimeBindingRecord.State.READY) {
                scheduleIdle();
            }
        }

        CompletionStage<Void> requestDrain() {
            CompletableFuture<Void> requested;
            RuntimeBindingRecord updated = updateRecord(record -> {
                if (record.getState()
                        == RuntimeBindingRecord.State.RELEASED) {
                    return record;
                }
                return record.withDrainRequested(true, Instant.now());
            });
            synchronized (this) {
                if (updated.getState()
                        == RuntimeBindingRecord.State.RELEASED) {
                    return CompletableFuture.completedFuture(null);
                }
                if (drainFuture == null) {
                    drainFuture = new CompletableFuture<>();
                }
                requested = drainFuture;
            }
            beginDrain(false);
            return requested;
        }

        CompletionStage<RuntimeLease> ensureHealthy(RuntimeLease lease) {
            CompletableFuture<Boolean> check;
            synchronized (this) {
                RuntimeBindingRecord current = record();
                if (current == null
                        || (current.getState()
                                != RuntimeBindingRecord.State.READY
                                && current.getState()
                                        != RuntimeBindingRecord.State.PROVISIONING)) {
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
                health = provisioner.health(request, lease);
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
                            && record() != null
                            && record().getState()
                                    == RuntimeBindingRecord.State.READY;
                    if (accepted) {
                        lastHealthNanos = System.nanoTime();
                        updateRecord(record -> record.withLastHealthAt(
                                Instant.now(), Instant.now()));
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
            failProvisioning(error, null);
        }

        private void failProvisioning(Throwable error,
                RuntimeBindingRecord claim) {
            stopOperationRenewal();
            provisioning.set(false);
            CompletableFuture<Void> requestedDrain;
            RuntimeBindingRecord updated = updateRecord(record -> {
                if (record.getState()
                        != RuntimeBindingRecord.State.PROVISIONING
                        || (claim != null
                                && (!brokerOwnerId.equals(
                                        record.getOperationOwner())
                                        || record.getOperationGeneration()
                                                != claim.getOperationGeneration()))) {
                    return record;
                }
                return record.withState(RuntimeBindingRecord.State.FAILED,
                        record.getLease(), Instant.now()).withOperation(null,
                                null, record.getOperationGeneration());
            });
            if (updated.getState()
                    == RuntimeBindingRecord.State.PROVISIONING) {
                scheduleProvisioningPoll();
                return;
            }
            synchronized (this) {
                provisioningFailure = error;
                requestedDrain = drainFuture;
                if (requestedDrain == null) {
                    drainFuture = CompletableFuture.completedFuture(null);
                }
            }
            if (updated.getState() == RuntimeBindingRecord.State.FAILED) {
                bindings.remove(bindingId, this);
                ready.completeExceptionally(error);
            } else if (updated.getState()
                    == RuntimeBindingRecord.State.READY) {
                ready.complete(updated.getLease());
            }
            if (requestedDrain != null) {
                requestedDrain.complete(null);
            }
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
            RuntimeBindingRecord requested = updateRecord(record ->
                    record.isDrainRequested() ? record
                            : record.withDrainRequested(true, Instant.now()));
            if (requested.getState() == RuntimeBindingRecord.State.RELEASED
                    || requested.getState()
                            == RuntimeBindingRecord.State.FAILED) {
                completeTerminalDrain(requested);
                return;
            }
            if (requested.getState()
                    == RuntimeBindingRecord.State.PROVISIONING) {
                return;
            }
            if (!failedState && activeSessionCount(requested) != 0) {
                scheduleDrainPoll();
                return;
            }
            RuntimeBindingRecord claimed = bindingRepository.claimOperation(
                    bindingId, brokerOwnerId, operationLeaseDuration);
            if (claimed == null
                    || !brokerOwnerId.equals(claimed.getOperationOwner())) {
                scheduleDrainPoll();
                return;
            }
            if (!this.draining.compareAndSet(false, true)) {
                return;
            }
            RuntimeBindingRecord updated;
            synchronized (this) {
                RuntimeBindingRecord current = record();
                if (current == null
                        || current.getState()
                                == RuntimeBindingRecord.State.FAILED
                        || current.getState()
                                == RuntimeBindingRecord.State.RELEASED
                        || (!failedState
                                && ((current.getState()
                                        != RuntimeBindingRecord.State.READY
                                        && current.getState()
                                                != RuntimeBindingRecord.State.DRAINING)
                                        || activeSessionCount(current) != 0))) {
                    this.draining.set(false);
                    return;
                }
                updated = updateRecord(record -> {
                    if (!brokerOwnerId.equals(record.getOperationOwner())
                            || record.getOperationGeneration()
                                    != claimed.getOperationGeneration()
                            || (record.getState()
                                    != RuntimeBindingRecord.State.READY
                                    && record.getState()
                                            != RuntimeBindingRecord.State.DRAINING)) {
                        return record;
                    }
                    return record.getState()
                            == RuntimeBindingRecord.State.DRAINING ? record
                                    : record.withState(
                                            RuntimeBindingRecord.State.DRAINING,
                                            record.getLease(), Instant.now());
                });
                if (updated.getState()
                        != RuntimeBindingRecord.State.DRAINING
                        || !brokerOwnerId.equals(
                                updated.getOperationOwner())
                        || updated.getOperationGeneration()
                                != claimed.getOperationGeneration()) {
                    this.draining.set(false);
                    scheduleDrainPoll();
                    return;
                }
                cancelIdle();
                if (drainFuture == null) {
                    drainFuture = new CompletableFuture<>();
                }
                draining = drainFuture;
            }
            startOperationRenewal(claimed.getOperationGeneration());
            ready.thenCompose(lease -> provisioner.drain(request, lease)
                    .thenCompose(ignored -> provisioner.release(request,
                            lease))).whenComplete((ignored, error) -> {
                                RuntimeBindingRecord terminal = updateRecord(
                                        record -> {
                                            if (record.getState()
                                                    != RuntimeBindingRecord.State.DRAINING
                                                    || !brokerOwnerId.equals(
                                                            record.getOperationOwner())
                                                    || record.getOperationGeneration()
                                                            != claimed.getOperationGeneration()) {
                                                return record;
                                            }
                                            return record.withState(
                                                    error == null
                                                            ? RuntimeBindingRecord.State.RELEASED
                                                            : RuntimeBindingRecord.State.FAILED,
                                                    record.getLease(),
                                                    Instant.now()).withOperation(
                                                            null, null,
                                                            record.getOperationGeneration());
                                        });
                                stopOperationRenewal();
                                this.draining.set(false);
                                if (terminal.getState()
                                                == RuntimeBindingRecord.State.RELEASED
                                        || terminal.getState()
                                                == RuntimeBindingRecord.State.FAILED) {
                                    bindings.remove(bindingId, this);
                                    completeUnavailable();
                                }
                                if (error == null && terminal.getState()
                                        == RuntimeBindingRecord.State.RELEASED) {
                                    draining.complete(null);
                                } else if (error != null
                                        && terminal.getState()
                                                == RuntimeBindingRecord.State.FAILED) {
                                    draining.completeExceptionally(
                                            unwrap(error));
                                } else {
                                    scheduleDrainPoll();
                                }
                            });
        }

        private synchronized void completeTerminalDrain(
                RuntimeBindingRecord terminal) {
            completeUnavailable();
            if (drainFuture == null) {
                return;
            }
            if (terminal.getState() == RuntimeBindingRecord.State.RELEASED) {
                drainFuture.complete(null);
            } else {
                drainFuture.completeExceptionally(unavailable(
                        "runtime_broker_drain_failed",
                        "Managed Runtime drain failed."));
            }
        }

        private synchronized void startOperationRenewal(long generation) {
            if (operationRenewal != null || closed.get()) {
                return;
            }
            long interval = Math.max(1,
                    operationLeaseDuration.toNanos() / 3);
            try {
                operationRenewal = scheduler.scheduleWithFixedDelay(() -> {
                    RuntimeBindingRecord renewed = bindingRepository
                            .renewOperation(bindingId, brokerOwnerId,
                                    generation, operationLeaseDuration);
                    if (renewed == null) {
                        stopOperationRenewal();
                    }
                }, interval, interval, TimeUnit.NANOSECONDS);
            } catch (RuntimeException error) {
                if (!closed.get()) {
                    throw error;
                }
            }
        }

        private synchronized void stopOperationRenewal() {
            if (operationRenewal != null) {
                operationRenewal.cancel(false);
                operationRenewal = null;
            }
        }

        private long activeSessionCount(RuntimeBindingRecord current) {
            return runtimeSessionRepository.countActiveByBinding(bindingId,
                    current.getGeneration());
        }

        private void scheduleDrainPoll() {
            synchronized (this) {
                if (drainPollScheduled || closed.get()) {
                    return;
                }
                drainPollScheduled = true;
            }
            try {
                scheduler.schedule(() -> {
                    synchronized (RuntimeBinding.this) {
                        drainPollScheduled = false;
                    }
                    beginDrain(false);
                }, 25, TimeUnit.MILLISECONDS);
            } catch (RuntimeException error) {
                synchronized (this) {
                    drainPollScheduled = false;
                }
                if (!closed.get()) {
                    throw error;
                }
            }
        }

        private void scheduleUnavailablePoll() {
            synchronized (this) {
                if (unavailablePollScheduled || closed.get()) {
                    return;
                }
                unavailablePollScheduled = true;
            }
            try {
                scheduler.schedule(() -> {
                    synchronized (RuntimeBinding.this) {
                        unavailablePollScheduled = false;
                    }
                    RuntimeBindingRecord current = record();
                    if (current == null || !current.isActive()) {
                        completeUnavailable();
                    } else {
                        scheduleUnavailablePoll();
                    }
                }, 25, TimeUnit.MILLISECONDS);
            } catch (RuntimeException error) {
                synchronized (this) {
                    unavailablePollScheduled = false;
                }
                if (!closed.get()) {
                    throw error;
                }
            }
        }

        private synchronized void completeUnavailable() {
            if (unavailableFuture != null) {
                unavailableFuture.complete(null);
            }
        }

        private RuntimeBindingRecord record() {
            return bindingRepository.findById(bindingId);
        }

        private RuntimeBindingRecord updateRecord(
                UnaryOperator<RuntimeBindingRecord> mutation) {
            while (true) {
                RuntimeBindingRecord current = record();
                if (current == null) {
                    throw unavailable("runtime_broker_binding_lost",
                            "Runtime binding disappeared.");
                }
                RuntimeBindingRecord replacement = mutation.apply(current);
                if (replacement == current) {
                    return current;
                }
                RuntimeBindingRecord updated = bindingRepository
                        .compareAndSet(current, replacement);
                if (updated != null) {
                    return updated;
                }
            }
        }
    }

    private final class SessionBinding {
        private final RuntimeSession session;
        private final RuntimeBinding binding;
        private final String runtimeSessionId;
        private final CompletableFuture<RuntimeLease> ready;
        private CompletableFuture<Boolean> release;

        SessionBinding(RuntimeSession session, RuntimeBinding binding) {
            this(new RuntimeSessionRecord(session, binding.bindingId,
                    binding.generation(),
                    RuntimeSessionRecord.State.ACQUIRING, 0, Instant.now()),
                    binding, true);
        }

        SessionBinding(RuntimeSessionRecord record, RuntimeBinding binding) {
            this(record, binding, false, false);
        }

        private SessionBinding(RuntimeSessionRecord candidate,
                RuntimeBinding binding, boolean create) {
            this(candidate, binding, create, false);
        }

        private SessionBinding(RuntimeSessionRecord candidate,
                RuntimeBinding binding, boolean create,
                boolean resumeRelease) {
            RuntimeSessionRecord record = create
                    ? runtimeSessionRepository.findOrCreate(candidate)
                    : candidate;
            boolean validState = resumeRelease
                    ? record.getState()
                            == RuntimeSessionRecord.State.RELEASING
                    : record.isAcquirable();
            if (!record.sameIdentity(candidate) || !validState
                    || !record.getBindingId().equals(binding.bindingId)
                    || record.getRuntimeGeneration()
                            != binding.generation()) {
                throw conflict("runtime_broker_session_conflict",
                        "Runtime Session identity changed.");
            }
            this.session = record.getSession();
            this.binding = binding;
            this.runtimeSessionId = record.getRuntimeSessionId();
            if (resumeRelease) {
                this.ready = binding.ready;
                return;
            }
            if (!binding.reserveSession()) {
                failAcquiring(record);
                binding.releaseSession();
                throw unavailable("runtime_broker_binding_unavailable",
                        "Runtime Session binding is unavailable.");
            }
            this.ready = binding.ready.thenCompose(lease ->
                    binding.ensureHealthy(lease)).thenCompose(lease ->
                            transport.acquire(lease, this.session)
                                    .thenApply(ignored -> lease))
                    .whenComplete((lease, error) -> {
                        if (error == null) {
                            transitionState(RuntimeSessionRecord.State.READY,
                                    RuntimeSessionRecord.State.ACQUIRING);
                        } else {
                            failAcquiring();
                            binding.releaseSession();
                        }
                    }).toCompletableFuture();
        }

        void assertIdentity(String harnessSessionId, RuntimeScope scope,
                String turnKind) {
            assertHarness(harnessSessionId);
            RuntimeSessionRecord current = runtimeSessionRepository.findById(
                    runtimeSessionId);
            if (current == null || !current.isAcquirable()) {
                throw conflict("runtime_broker_session_conflict",
                        "Runtime Session lifecycle changed.");
            }
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

        void assertBindingAvailable() {
            RuntimeBindingRecord current = bindingRepository.findById(
                    binding.bindingId);
            if (current == null || !current.isActive()
                    || current.getGeneration()
                            != binding.generation()) {
                throw unavailable("runtime_broker_binding_unavailable",
                        "Runtime Session binding is unavailable.");
            }
        }

        void assertOperational() {
            RuntimeSessionRecord current = runtimeSessionRepository.findById(
                    runtimeSessionId);
            if (current == null || !current.isAcquirable()) {
                throw conflict("runtime_broker_session_conflict",
                        "Runtime Session lifecycle changed.");
            }
        }

        void assertReleasable() {
            RuntimeSessionRecord current = runtimeSessionRepository.findById(
                    runtimeSessionId);
            if (current == null
                    || (current.getState()
                            != RuntimeSessionRecord.State.READY
                            && current.getState()
                                    != RuntimeSessionRecord.State.RELEASING)) {
                throw conflict("runtime_broker_session_conflict",
                        "Runtime Session lifecycle changed.");
            }
        }

        synchronized CompletionStage<Boolean> release(
                String runtimeSessionId) {
            if (release != null) {
                return release;
            }
            CompletableFuture<Boolean> requested = ready.thenCompose(lease -> {
                transitionState(RuntimeSessionRecord.State.RELEASING,
                        RuntimeSessionRecord.State.READY);
                return transport.release(lease, session);
            }).handle((released, error) -> {
                if (error != null) {
                    transitionState(RuntimeSessionRecord.State.READY,
                            RuntimeSessionRecord.State.RELEASING);
                    throw new CompletionException(unwrap(error));
                }
                if (Boolean.TRUE.equals(released)) {
                    transitionState(RuntimeSessionRecord.State.RELEASED,
                            RuntimeSessionRecord.State.RELEASING);
                    sessions.remove(runtimeSessionId, this);
                    removeExecutions(runtimeSessionId);
                    binding.releaseSession();
                    return true;
                }
                transitionState(RuntimeSessionRecord.State.READY,
                        RuntimeSessionRecord.State.RELEASING);
                return false;
            }).toCompletableFuture();
            release = requested;
            requested.whenComplete((ignored, error) -> {
                if (error != null) {
                    synchronized (SessionBinding.this) {
                        if (release == requested) {
                            release = null;
                        }
                    }
                }
            });
            return release;
        }

        private RuntimeSessionRecord transitionState(
                RuntimeSessionRecord.State state,
                RuntimeSessionRecord.State expectedState) {
            while (true) {
                RuntimeSessionRecord current = runtimeSessionRepository
                        .findById(runtimeSessionId);
                if (current == null) {
                    throw unavailable("runtime_broker_session_lost",
                            "Runtime Session disappeared.");
                }
                if (current.getState() == state) {
                    return current;
                }
                if (current.getState() != expectedState) {
                    throw conflict("runtime_broker_session_conflict",
                            "Runtime Session lifecycle changed.");
                }
                RuntimeSessionRecord updated = runtimeSessionRepository
                        .compareAndSet(current,
                                current.withState(state, Instant.now()));
                if (updated != null) {
                    return updated;
                }
            }
        }

        private void failAcquiring() {
            RuntimeSessionRecord current = runtimeSessionRepository.findById(
                    runtimeSessionId);
            if (current != null) {
                failAcquiring(current);
            }
        }

        private void failAcquiring(RuntimeSessionRecord candidate) {
            while (true) {
                RuntimeSessionRecord current = runtimeSessionRepository
                        .findById(candidate.getRuntimeSessionId());
                if (current == null || current.getState()
                        != RuntimeSessionRecord.State.ACQUIRING) {
                    return;
                }
                RuntimeSessionRecord updated = runtimeSessionRepository
                        .compareAndSet(current, current.withState(
                                RuntimeSessionRecord.State.FAILED,
                                Instant.now()));
                if (updated != null) {
                    return;
                }
            }
        }
    }

    private final class ExecutionRecord {
        private final String executionCallId;
        private final SessionBinding session;
        private final AtomicBoolean started = new AtomicBoolean();
        private CompletableFuture<Map<String, Object>> cancellation;
        private ScheduledFuture<?> dispatchRenewal;

        ExecutionRecord(ToolExecutionRecord record, SessionBinding session) {
            executionCallId = record.getExecutionCallId();
            this.session = session;
        }

        void start(RuntimeTransport transport) {
            if (!started.compareAndSet(false, true)) {
                return;
            }
            ToolExecutionRecord claimed = executionRepository.claimDispatch(
                    executionCallId, brokerOwnerId, dispatchLeaseDuration);
            if (claimed == null
                    || !brokerOwnerId.equals(claimed.getDispatchOwner())) {
                started.set(false);
                return;
            }
            startDispatchRenewal(claimed.getDispatchGeneration(), transport);
            session.ready.whenComplete((lease, error) -> {
                if (error != null) {
                    settleOwned(errorResult());
                    return;
                }
                reconcile(transport, lease);
            });
        }

        private void reconcile(RuntimeTransport transport,
                RuntimeLease lease) {
            ToolExecutionRecord current = record();
            if (current == null || current.isSettled()
                    || !ownsDispatch(current)) {
                started.set(false);
                stopDispatchRenewal();
                return;
            }
            if (!executionBindingAvailable(current)) {
                markExecutionUnknown(executionCallId);
                started.set(false);
                stopDispatchRenewal();
                return;
            }
            ToolExecutionRecord renewed = executionRepository.renewDispatch(
                    executionCallId, brokerOwnerId,
                    current.getDispatchGeneration(), dispatchLeaseDuration);
            if (renewed == null) {
                started.set(false);
                stopDispatchRenewal();
                return;
            }
            transport.status(lease, session.session, renewed.getReference(),
                    renewed.getLastSequence()).whenComplete((status, error) -> {
                        if (error != null) {
                            scheduleReconcile(transport, lease);
                            return;
                        }
                        try {
                            absorbStatus(status);
                            ToolExecutionRecord observed = record();
                            if (observed == null || observed.isSettled()
                                    || !ownsDispatch(observed)) {
                                return;
                            }
                            if (observed.getState()
                                    == ToolExecutionRecord.State.PREPARED) {
                                if (observed.isCancelRequested()) {
                                    settleOwned(cancelledResult());
                                } else {
                                    execute(transport, lease, observed);
                                }
                            } else {
                                scheduleReconcile(transport, lease);
                            }
                        } catch (RuntimeException invalidStatus) {
                            scheduleReconcile(transport, lease);
                        }
                    });
        }

        private void execute(RuntimeTransport transport, RuntimeLease lease,
                ToolExecutionRecord current) {
            ToolExecutionRecord executing = updateOwned(record ->
                    record.withState(ToolExecutionRecord.State.EXECUTING,
                            record.isCancelRequested()));
            if (executing == null || !ownsDispatch(executing)
                    || executing.isCancelRequested()) {
                if (executing != null && executing.isCancelRequested()) {
                    settleOwned(cancelledResult());
                }
                return;
            }
            transport.execute(lease, session.session, current.getReference())
                    .whenComplete((physicalResult, error) -> {
                        if (error != null) {
                            scheduleReconcile(transport, lease);
                            return;
                        }
                        try {
                            settleOwned(validateExecutionResult(
                                    physicalResult));
                        } catch (RuntimeException invalidResult) {
                            settleOwned(errorResult());
                        }
                    });
        }

        private void scheduleReconcile(RuntimeTransport transport,
                RuntimeLease lease) {
            try {
                scheduler.schedule(() -> reconcile(transport, lease), 25,
                        TimeUnit.MILLISECONDS);
            } catch (RuntimeException ignored) {
                if (!closed.get()) {
                    throw ignored;
                }
            }
        }

        synchronized CompletionStage<Map<String, Object>> cancel(
                RuntimeTransport transport) {
            ToolExecutionRecord requested = requestCancel();
            if (requested == null) {
                throw notFound("runtime_broker_execution_not_found",
                        "Tool execution was not found.");
            }
            if (requested.isSettled()) {
                return CompletableFuture.completedFuture(snapshot());
            }
            ToolExecutionRecord claimed = executionRepository.claimDispatch(
                    executionCallId, brokerOwnerId, dispatchLeaseDuration);
            if (claimed == null
                    || !brokerOwnerId.equals(claimed.getDispatchOwner())) {
                return CompletableFuture.completedFuture(snapshot());
            }
            startDispatchRenewal(claimed.getDispatchGeneration(), transport);
            return cancelOwned(transport, claimed);
        }

        void settleOwned(Map<String, Object> executionResult) {
            Map<String, Object> validated = validateExecutionResult(
                    executionResult);
            ToolExecutionRecord settled = updateOwned(record ->
                    record.isSettled() ? record
                    : record.withResult(validated, record.getLastSequence(),
                            Instant.now()));
            if (settled != null && settled.isSettled()) {
                stopDispatchRenewal();
            }
        }

        void absorbStatus(Map<String, Object> status) {
            ToolExecutionRecord current = record();
            if (current == null || current.isSettled()) {
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
            Map<String, Object> settledResult = nextResult;
            ToolExecutionRecord updated = updateOwned(record -> {
                if (record.isSettled()) {
                    return record;
                }
                boolean requested = record.isCancelRequested()
                        || Boolean.TRUE.equals(status.get("cancelRequested"));
                if (settledResult != null) {
                    return record.withResult(settledResult,
                            sequence(status, record.getLastSequence()),
                            Instant.now());
                }
                return record.withState(invocationState((String) runtimeState),
                        requested);
            });
            if (updated != null && updated.isSettled()) {
                stopDispatchRenewal();
            }
        }

        private synchronized CompletionStage<Map<String, Object>> cancelOwned(
                RuntimeTransport transport, ToolExecutionRecord claimed) {
            ToolExecutionRecord current = record();
            if (current != null && current.isCancelRequested()
                    && (current.getState()
                            == ToolExecutionRecord.State.PREPARED
                            || current.getState()
                                    == ToolExecutionRecord.State.DISPATCHING)) {
                settleOwned(cancelledResult());
                return CompletableFuture.completedFuture(snapshot());
            }
            if (cancellation == null) {
                cancellation = session.ready.thenCompose(lease ->
                        transport.cancel(lease, session.session,
                                claimed.getReference()).thenApply(status -> {
                                    if (status != null) {
                                        absorbStatus(status);
                                    }
                                    ToolExecutionRecord observed = record();
                                    if (observed != null
                                            && !observed.isSettled()) {
                                        scheduleReconcile(transport, lease);
                                    }
                                    return snapshot();
                                })).toCompletableFuture();
                CompletableFuture<Map<String, Object>> requested =
                        cancellation;
                requested.whenComplete((ignored, error) -> {
                    if (error != null) {
                        synchronized (ExecutionRecord.this) {
                            if (cancellation == requested) {
                                cancellation = null;
                            }
                        }
                    }
                });
            }
            return cancellation;
        }

        private synchronized void startDispatchRenewal(long generation,
                RuntimeTransport transport) {
            if (dispatchRenewal != null || closed.get()) {
                return;
            }
            long interval = Math.max(1,
                    dispatchLeaseDuration.toNanos() / 3);
            try {
                dispatchRenewal = scheduler.scheduleWithFixedDelay(() -> {
                    ToolExecutionRecord current = record();
                    if (current == null || current.isSettled()
                            || !ownsDispatch(current)
                            || current.getDispatchGeneration() != generation) {
                        started.set(false);
                        stopDispatchRenewal();
                        return;
                    }
                    ToolExecutionRecord renewed = executionRepository
                            .renewDispatch(executionCallId, brokerOwnerId,
                                    generation, dispatchLeaseDuration);
                    if (renewed == null) {
                        started.set(false);
                        stopDispatchRenewal();
                    } else if (renewed.isCancelRequested()) {
                        cancelOwned(transport, renewed);
                    }
                }, interval, interval, TimeUnit.NANOSECONDS);
            } catch (RuntimeException error) {
                started.set(false);
                if (!closed.get()) {
                    throw error;
                }
            }
        }

        private synchronized void stopDispatchRenewal() {
            if (dispatchRenewal != null) {
                dispatchRenewal.cancel(false);
                dispatchRenewal = null;
            }
        }

        Map<String, Object> snapshot() {
            return executionSnapshot(record());
        }

        boolean belongsTo(String runtimeSessionId) {
            ToolExecutionRecord current = record();
            return current != null && current.getRuntimeSessionId().equals(
                    runtimeSessionId);
        }

        void assertSession(SessionBinding candidate) {
            ToolExecutionRecord current = record();
            if (current == null || !current.getRuntimeSessionId().equals(
                    candidate.runtimeSessionId)
                    || !current.getHarnessSessionId().equals(
                            candidate.session.getHarnessSessionId())) {
                throw conflict("runtime_broker_execution_conflict",
                        "Tool execution belongs to another Runtime Session.");
            }
        }

        private ToolExecutionRecord requestCancel() {
            while (true) {
                ToolExecutionRecord current = record();
                if (current == null || current.isSettled()) {
                    return current;
                }
                ToolExecutionRecord updated = executionRepository
                        .compareAndSet(current, current.withState(
                                current.getState()
                                                == ToolExecutionRecord.State.EXECUTING
                                        || current.getState()
                                                == ToolExecutionRecord.State.CANCEL_REQUESTED
                                                        ? ToolExecutionRecord.State.CANCEL_REQUESTED
                                                        : current.getState(),
                                true));
                if (updated != null) {
                    return updated;
                }
            }
        }

        private ToolExecutionRecord updateOwned(
                UnaryOperator<ToolExecutionRecord> mutation) {
            while (true) {
                ToolExecutionRecord current = record();
                if (current == null || !ownsDispatch(current)) {
                    return current;
                }
                ToolExecutionRecord replacement = mutation.apply(current);
                if (replacement == current) {
                    return current;
                }
                ToolExecutionRecord updated = executionRepository
                        .compareAndSet(current, replacement);
                if (updated != null) {
                    return updated;
                }
            }
        }

        private boolean ownsDispatch(ToolExecutionRecord record) {
            return brokerOwnerId.equals(record.getDispatchOwner())
                    && record.getDispatchGeneration() > 0;
        }

        private ToolExecutionRecord record() {
            return executionRepository.findByExecutionCallId(executionCallId);
        }

        private ToolExecutionRecord.State invocationState(
                String state) {
            switch (state) {
                case "prepared":
                    return ToolExecutionRecord.State.PREPARED;
                case "executing":
                    return ToolExecutionRecord.State.EXECUTING;
                case "cancel_requested":
                    return ToolExecutionRecord.State.CANCEL_REQUESTED;
                default:
                    throw unavailable("runtime_broker_cancel_failed",
                            "Runtime cancellation returned an invalid status.");
            }
        }

        private long sequence(Map<String, Object> status,
                long fallback) {
            Object value = status.get("lastSeq");
            return value instanceof Number
                    ? Math.max(fallback, ((Number) value).longValue())
                    : fallback;
        }

        private Map<String, Object> validateExecutionResult(
                Map<String, Object> physicalResult) {
            if (physicalResult == null
                    || !EXECUTION_STATES.contains(
                            physicalResult.get("executionStatus"))) {
                throw unavailable("runtime_broker_execution_failed",
                        "Runtime returned an invalid execution result.");
            }
            return BrokerValues.immutableMap(physicalResult);
        }

        private Map<String, Object> errorResult() {
            Map<String, Object> error = new LinkedHashMap<>();
            error.put("message", "Managed Runtime execution failed.");
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("executionStatus", "error");
            result.put("error", Collections.unmodifiableMap(error));
            return Collections.unmodifiableMap(result);
        }

        private Map<String, Object> cancelledResult() {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("executionStatus", "cancelled");
            return Collections.unmodifiableMap(result);
        }
    }
}
