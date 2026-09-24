package com.alibaba.qwen.code.runtimebroker;

import java.time.Clock;
import java.time.Duration;
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
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;

/** Repository-backed orchestration for the private Managed Runtime contract. */
public final class RuntimeBrokerService implements AutoCloseable {
    private static final Set<String> CONTROL_OPERATIONS = Set.of(
            "bind-history", "checkpoint", "history", "manifest",
            "begin-turn", "prepare", "confirmation", "confirm",
            "preflight");
    private static final Set<String> RUNTIME_EXECUTION_STATES = Set.of(
            "prepared", "executing", "cancel_requested", "settled");
    private static final int MAX_CAS_ATTEMPTS = 16;

    private final HarnessSessionResolver sessionResolver;
    private final RuntimeProvisioner provisioner;
    private final RuntimeTransport transport;
    private final RuntimeBindingRepository bindingRepository;
    private final RuntimeSessionRepository sessionRepository;
    private final ToolExecutionRepository executionRepository;
    private final String brokerOwnerId;
    private final Duration operationLeaseDuration;
    private final Duration dispatchLeaseDuration;
    private final Clock clock;
    private final Supplier<String> executionIdSupplier;
    private final ScheduledExecutorService scheduler;
    private final AtomicBoolean closed = new AtomicBoolean();
    private final ConcurrentMap<String, LiveBinding> liveBindings =
            new ConcurrentHashMap<>();
    private final ConcurrentMap<String, CompletableFuture<BindingContext>>
            bindingOperations = new ConcurrentHashMap<>();
    private final ConcurrentMap<String, CompletableFuture<SessionContext>>
            sessions = new ConcurrentHashMap<>();
    private final ConcurrentMap<String, CompletableFuture<Void>> dispatches =
            new ConcurrentHashMap<>();

    public RuntimeBrokerService(HarnessSessionResolver sessionResolver,
            RuntimeProvisioner provisioner, RuntimeTransport transport,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository,
            String brokerOwnerId, Duration operationLeaseDuration,
            Duration dispatchLeaseDuration) {
        this(sessionResolver, provisioner, transport, bindingRepository,
                sessionRepository, executionRepository, brokerOwnerId,
                operationLeaseDuration, dispatchLeaseDuration,
                Clock.systemUTC(), () -> UUID.randomUUID().toString(),
                newScheduler());
    }

    RuntimeBrokerService(HarnessSessionResolver sessionResolver,
            RuntimeProvisioner provisioner, RuntimeTransport transport,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository,
            String brokerOwnerId, Duration operationLeaseDuration,
            Duration dispatchLeaseDuration, Clock clock,
            Supplier<String> executionIdSupplier) {
        this(sessionResolver, provisioner, transport, bindingRepository,
                sessionRepository, executionRepository, brokerOwnerId,
                operationLeaseDuration, dispatchLeaseDuration, clock,
                executionIdSupplier, newScheduler());
    }

    private RuntimeBrokerService(HarnessSessionResolver sessionResolver,
            RuntimeProvisioner provisioner, RuntimeTransport transport,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository,
            String brokerOwnerId, Duration operationLeaseDuration,
            Duration dispatchLeaseDuration, Clock clock,
            Supplier<String> executionIdSupplier,
            ScheduledExecutorService scheduler) {
        if (sessionResolver == null || provisioner == null
                || transport == null || bindingRepository == null
                || sessionRepository == null || executionRepository == null
                || clock == null || executionIdSupplier == null
                || scheduler == null) {
            throw new IllegalArgumentException(
                    "service dependencies are required");
        }
        this.brokerOwnerId = BrokerValues.requireId(brokerOwnerId,
                "brokerOwnerId");
        this.operationLeaseDuration = requireDuration(
                operationLeaseDuration, "operationLeaseDuration");
        this.dispatchLeaseDuration = requireDuration(
                dispatchLeaseDuration, "dispatchLeaseDuration");
        this.sessionResolver = sessionResolver;
        this.provisioner = provisioner;
        this.transport = transport;
        this.bindingRepository = bindingRepository;
        this.sessionRepository = sessionRepository;
        this.executionRepository = executionRepository;
        this.clock = clock;
        this.executionIdSupplier = executionIdSupplier;
        this.scheduler = scheduler;
    }

    public CompletionStage<RuntimeBindingRecord> warm(
            String harnessSessionId) {
        requireOpen();
        String harnessId = BrokerValues.requireId(harnessSessionId,
                "harnessSessionId");
        return resolveScope(harnessId)
                .thenCompose(scope -> ensureBinding(
                        provisionRequest(scope, harnessId)))
                .thenApply(BindingContext::record);
    }

    public CompletionStage<RuntimeSessionRecord> acquire(
            String harnessSessionId, String runtimeSessionId,
            String turnKind) {
        requireOpen();
        String harnessId = BrokerValues.requireId(harnessSessionId,
                "harnessSessionId");
        String runtimeId = BrokerValues.requireId(runtimeSessionId,
                "runtimeSessionId");
        return resolveScope(harnessId).thenCompose(scope -> {
            RuntimeSession session = new RuntimeSession(harnessId,
                    runtimeId, turnKind, scope);
            return acquireSession(session);
        });
    }

    public CompletionStage<Object> control(String harnessSessionId,
            String runtimeSessionId, Map<String, Object> operation) {
        requireOpen();
        Map<String, Object> immutable = immutableMap(operation,
                "operation");
        Object kind = immutable.get("kind");
        if (!(kind instanceof String)
                || !CONTROL_OPERATIONS.contains(kind)) {
            throw invalid("runtime_control_operation_invalid",
                    "unsupported Runtime control operation");
        }
        return requireReadySession(harnessSessionId, runtimeSessionId)
                .thenCompose(context -> {
                    synchronized (context) {
                        requireReadySessionRecord(context);
                        context.beginControl();
                    }
                    CompletionStage<Object> result;
                    try {
                        result = mapFailure(safeStage(() ->
                                transport.control(context.lease(),
                                        context.session(), immutable)),
                                "runtime_control_failed",
                                "Runtime control operation failed");
                    } catch (RuntimeException | Error failure) {
                        context.endControl();
                        throw failure;
                    }
                    return result.whenComplete((ignored, error) ->
                            context.endControl());
                });
    }

    public CompletionStage<ToolExecutionRecord> createExecution(
            String harnessSessionId, String runtimeSessionId,
            String idempotencyKey, Map<String, Object> reference) {
        requireOpen();
        String key = BrokerValues.requireId(idempotencyKey,
                "idempotencyKey");
        return requireReadySession(harnessSessionId, runtimeSessionId)
                .thenApply(context -> createExecution(context, key,
                        reference));
    }

    public CompletionStage<ToolExecutionRecord> getExecution(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId) {
        requireOpen();
        String executionId = BrokerValues.requireId(executionCallId,
                "executionCallId");
        return requireReadySession(harnessSessionId, runtimeSessionId)
                .thenApply(context -> requireExecution(context,
                        executionId));
    }

    public CompletionStage<ToolExecutionRecord> cancelExecution(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId) {
        requireOpen();
        String executionId = BrokerValues.requireId(executionCallId,
                "executionCallId");
        return requireReadySession(harnessSessionId, runtimeSessionId)
                .thenCompose(context -> {
                    ToolExecutionRecord requested;
                    synchronized (context) {
                        requireReadySessionRecord(context);
                        ToolExecutionRecord current = requireExecution(
                                context, executionId);
                        requested = requestCancel(current);
                        if (requested.isSettled()
                                || requested.getState()
                                        == ToolExecutionRecord.State.UNKNOWN) {
                            return CompletableFuture.completedFuture(
                                    requested);
                        }
                    }
                    if (requested.getState()
                                    == ToolExecutionRecord.State.DISPATCHING
                            || (requested.getState()
                                            == ToolExecutionRecord.State
                                                    .CANCEL_REQUESTED
                                    && !requested.hasLiveDispatchAt(
                                            clock.instant()))) {
                        beginDispatch(context, requested);
                        ToolExecutionRecord latest = executionRepository
                                .findByExecutionCallId(executionId);
                        return CompletableFuture.completedFuture(
                                latest == null ? requested : latest);
                    }
                    if (requested.getState()
                            != ToolExecutionRecord.State.CANCEL_REQUESTED) {
                        return CompletableFuture.completedFuture(requested);
                    }
                    return mapFailure(safeStage(() -> transport.cancel(
                            context.lease(), context.session(),
                            requested.getReference())),
                            "runtime_execution_cancel_failed",
                            "Runtime execution cancellation failed")
                            .thenApply(status -> {
                                absorbCancellationStatus(requested, status);
                                ToolExecutionRecord latest =
                                        executionRepository
                                                .findByExecutionCallId(
                                                        executionId);
                                return latest == null ? requested : latest;
                            });
                });
    }

    public CompletionStage<Boolean> release(String harnessSessionId,
            String runtimeSessionId) {
        requireOpen();
        String harnessId = BrokerValues.requireId(harnessSessionId,
                "harnessSessionId");
        String runtimeId = BrokerValues.requireId(runtimeSessionId,
                "runtimeSessionId");
        CompletableFuture<SessionContext> local = sessions.get(runtimeId);
        if (local == null) {
            return releasedSession(harnessId, runtimeId);
        }
        return local.thenCompose(context -> {
            if (!context.session().getHarnessSessionId().equals(harnessId)) {
                throw conflict("runtime_session_conflict",
                        "Runtime Session belongs to another Harness Session");
            }
            return releaseSession(context);
        });
    }

    private CompletionStage<Boolean> releasedSession(
            String harnessSessionId, String runtimeSessionId) {
        return resolveScope(harnessSessionId).thenApply(scope -> {
            RuntimeSessionRecord record = sessionRepository.findById(scope,
                    runtimeSessionId);
            if (record == null) {
                throw notFound("runtime_session_not_found",
                        "Runtime Session was not found");
            }
            if (!record.getSession().getHarnessSessionId().equals(
                    harnessSessionId)) {
                throw conflict("runtime_session_conflict",
                        "Runtime Session belongs to another Harness Session");
            }
            if (record.getState()
                    == RuntimeSessionRecord.State.RELEASED) {
                return true;
            }
            throw unavailable("runtime_reconciliation_required",
                    "Runtime Session is not active in this Broker process");
        });
    }

    private ToolExecutionRecord createExecution(SessionContext context,
            String idempotencyKey, Map<String, Object> reference) {
        ToolExecutionRecord record;
        synchronized (context) {
            requireReadySessionRecord(context);
            Map<String, Object> safeReference = immutableMap(reference,
                    "reference");
            String referenceSessionId = referenceString(safeReference,
                    "sessionId");
            if (!context.session().getRuntimeSessionId().equals(
                    referenceSessionId)) {
                throw invalid("runtime_reference_invalid",
                        "reference sessionId does not match the Runtime "
                                + "Session");
            }
            ToolExecutionRecord candidate = ToolExecutionRecord.prepared(
                    nextExecutionId(), idempotencyKey,
                    context.binding().getBindingId(),
                    context.binding().getGeneration(),
                    context.session().getHarnessSessionId(),
                    context.session().getRuntimeSessionId(),
                    referenceString(safeReference, "promptId"),
                    referenceString(safeReference, "callId"),
                    referenceString(safeReference, "argsDigest"),
                    safeReference);
            try {
                record = executionRepository.findOrCreate(candidate);
            } catch (IllegalArgumentException exception) {
                throw conflict("runtime_execution_conflict",
                        "execution identity is already in use", exception);
            }
            if (!record.sameRequest(candidate)) {
                throw conflict("runtime_idempotency_conflict",
                        "idempotency key belongs to another request");
            }
        }
        if (shouldDriveDispatch(record)) {
            beginDispatch(context, record);
        }
        ToolExecutionRecord current = executionRepository
                .findByExecutionCallId(record.getExecutionCallId());
        return current == null ? record : current;
    }

    private CompletionStage<Boolean> releaseSession(
            SessionContext context) {
        CompletableFuture<Boolean> result;
        RuntimeSessionRecord releasing;
        synchronized (context) {
            if (context.release() != null) {
                return context.release();
            }
            if (context.hasActiveControl()
                    || executionRepository.hasActiveByRuntimeSession(
                            context.session().getRuntimeSessionId())) {
                throw conflict("runtime_session_busy",
                        "Runtime Session has an active operation");
            }
            releasing = transitionSessionToReleasing(context);
            if (releasing.getState()
                    == RuntimeSessionRecord.State.RELEASED) {
                sessions.remove(context.session().getRuntimeSessionId());
                return CompletableFuture.completedFuture(true);
            }
            result = new CompletableFuture<>();
            context.release(result);
        }
        mapFailure(safeStage(() -> transport.release(context.lease(),
                context.session())), "runtime_session_release_failed",
                "Runtime Session release failed")
                .whenComplete((released, error) -> {
                    if (error != null) {
                        context.release(null);
                        result.completeExceptionally(unwrap(error));
                    } else if (!Boolean.TRUE.equals(released)) {
                        context.release(null);
                        result.complete(false);
                    } else {
                        try {
                            finishSessionRelease(releasing);
                            sessions.remove(context.session()
                                    .getRuntimeSessionId());
                            result.complete(true);
                        } catch (RuntimeException exception) {
                            context.release(null);
                            result.completeExceptionally(exception);
                        }
                    }
                });
        return result;
    }

    private CompletionStage<RuntimeSessionRecord> acquireSession(
            RuntimeSession session) {
        String runtimeSessionId = session.getRuntimeSessionId();
        CompletableFuture<SessionContext> created =
                new CompletableFuture<>();
        CompletableFuture<SessionContext> existing = sessions.putIfAbsent(
                runtimeSessionId, created);
        CompletableFuture<SessionContext> selected = existing == null
                ? created : existing;
        if (existing == null) {
            safeStage(() -> acquireNewSession(session)).whenComplete(
                    (context, error) -> {
                        if (error == null) {
                            created.complete(context);
                        } else {
                            sessions.remove(runtimeSessionId, created);
                            created.completeExceptionally(unwrap(error));
                        }
                    });
        }
        return selected.thenApply(context -> {
            synchronized (context) {
                requireSameSession(context.session(), session);
                return requireReadySessionRecord(context);
            }
        });
    }

    private CompletionStage<SessionContext> acquireNewSession(
            RuntimeSession session) {
        RuntimeProvisionRequest request = provisionRequest(
                session.getScope(), session.getHarnessSessionId());
        return ensureBinding(request).thenCompose(binding -> {
            RuntimeSessionRecord candidate = new RuntimeSessionRecord(
                    session, binding.record().getBindingId(),
                    binding.record().getGeneration(),
                    RuntimeSessionRecord.State.ACQUIRING, 0,
                    clock.instant());
            RuntimeSessionRecord stored;
            try {
                stored = sessionRepository.findOrCreate(candidate);
            } catch (IllegalArgumentException exception) {
                throw conflict("runtime_session_conflict",
                        "runtimeSessionId belongs to another Session",
                        exception);
            }
            if (!stored.sameIdentity(candidate)) {
                throw conflict("runtime_session_conflict",
                        "runtimeSessionId belongs to another Session");
            }
            SessionContext context = new SessionContext(session,
                    binding.record(), binding.lease());
            if (stored.getState() == RuntimeSessionRecord.State.READY) {
                return CompletableFuture.completedFuture(context);
            }
            if (stored.getState()
                    != RuntimeSessionRecord.State.ACQUIRING) {
                throw conflict("runtime_session_not_acquirable",
                        "Runtime Session is not acquirable");
            }
            RuntimeSessionRecord expected = stored;
            return mapFailure(safeStage(() -> transport.acquire(
                    binding.lease(), session)),
                    "runtime_session_acquire_failed",
                    "Runtime Session acquisition failed")
                    .handle((ignored, error) -> {
                        if (error != null) {
                            throw new CompletionException(unwrap(error));
                        }
                        RuntimeSessionRecord ready =
                                sessionRepository.compareAndSet(expected,
                                        expected.withState(
                                                RuntimeSessionRecord.State
                                                        .READY,
                                                clock.instant()));
                        if (ready == null) {
                            RuntimeSessionRecord current = sessionRepository
                                    .findById(session.getScope(),
                                            session.getRuntimeSessionId());
                            if (current == null
                                    || !current.sameIdentity(candidate)
                                    || current.getState()
                                            != RuntimeSessionRecord.State
                                                    .READY) {
                                throw conflict(
                                        "runtime_session_state_conflict",
                                        "Runtime Session changed while it "
                                                + "was being acquired");
                            }
                        }
                        return context;
                    });
        });
    }

    private CompletionStage<BindingContext> ensureBinding(
            RuntimeProvisionRequest request) {
        RuntimeBindingRecord record = bindingRepository.findOrCreate(request);
        if (record.getState() == RuntimeBindingRecord.State.READY) {
            CompletableFuture<BindingContext> finishing =
                    bindingOperations.get(record.getBindingId());
            if (finishing != null) {
                return finishing;
            }
            return CompletableFuture.completedFuture(
                    requireLiveBinding(record));
        }
        if (record.getState()
                != RuntimeBindingRecord.State.PROVISIONING) {
            return failed(unavailable("runtime_binding_unavailable",
                    "Runtime binding is not available"));
        }
        CompletableFuture<BindingContext> created =
                new CompletableFuture<>();
        CompletableFuture<BindingContext> existing =
                bindingOperations.putIfAbsent(record.getBindingId(),
                        created);
        if (existing != null) {
            return existing;
        }
        safeStage(() -> provisionBinding(record)).whenComplete(
                (context, error) -> {
                    bindingOperations.remove(record.getBindingId(), created);
                    if (error == null) {
                        created.complete(context);
                    } else {
                        created.completeExceptionally(unwrap(error));
                    }
                });
        return created;
    }

    private CompletionStage<BindingContext> provisionBinding(
            RuntimeBindingRecord record) {
        RuntimeBindingRecord claimed = bindingRepository.claimOperation(
                record.getBindingId(), brokerOwnerId,
                operationLeaseDuration);
        if (claimed == null) {
            return failed(unavailable("runtime_provisioning_in_progress",
                    "another Broker owns Runtime provisioning"));
        }
        if (claimed.getState()
                != RuntimeBindingRecord.State.PROVISIONING) {
            return claimed.getState() == RuntimeBindingRecord.State.READY
                    ? CompletableFuture.completedFuture(
                            requireLiveBinding(claimed))
                    : failed(unavailable("runtime_binding_unavailable",
                            "Runtime binding is not available"));
        }
        BindingRenewal renewal = new BindingRenewal(claimed);
        renewal.start();
        return safeStage(() -> provisioner.provision(claimed.getRequest()))
                .handle((lease, error) -> {
                    RuntimeBindingRecord currentClaim =
                            renewal.stopAndGet();
                    if (error != null || lease == null) {
                        if (currentClaim != null) {
                            failBinding(currentClaim);
                        }
                        Throwable cause = error == null
                                ? new IllegalStateException(
                                        "provisioner returned no lease")
                                : unwrap(error);
                        throw unavailable("runtime_provision_failed",
                                "Runtime provisioning failed", cause);
                    }
                    if (currentClaim == null) {
                        throw unavailable("runtime_provision_fenced",
                                "Runtime provisioning claim expired");
                    }
                    RuntimeBindingRecord ready =
                            bindingRepository.compareAndSet(currentClaim,
                                    currentClaim.withState(
                                            RuntimeBindingRecord.State.READY,
                                            lease, clock.instant()));
                    if (ready == null) {
                        throw unavailable("runtime_provision_fenced",
                                "Runtime provisioning claim expired");
                    }
                    liveBindings.put(ready.getBindingId(),
                            new LiveBinding(ready.getGeneration(), lease));
                    return new BindingContext(ready, lease);
                });
    }

    private BindingContext requireLiveBinding(RuntimeBindingRecord record) {
        LiveBinding live = liveBindings.get(record.getBindingId());
        if (live == null || live.generation() != record.getGeneration()
                || record.getLease() == null
                || !sameLease(live.lease(), record.getLease())) {
            throw unavailable("runtime_reconciliation_required",
                    "persisted Runtime readiness requires adoption or "
                            + "reconciliation in this Broker process");
        }
        return new BindingContext(record, live.lease());
    }

    private CompletionStage<SessionContext> requireReadySession(
            String harnessSessionId, String runtimeSessionId) {
        return requireSession(harnessSessionId, runtimeSessionId)
                .thenApply(value -> {
                    requireReadySessionRecord(value);
                    return value;
                });
    }

    private CompletionStage<SessionContext> requireSession(
            String harnessSessionId, String runtimeSessionId) {
        String harnessId = BrokerValues.requireId(harnessSessionId,
                "harnessSessionId");
        String runtimeId = BrokerValues.requireId(runtimeSessionId,
                "runtimeSessionId");
        CompletableFuture<SessionContext> context = sessions.get(runtimeId);
        if (context == null) {
            return failed(notFound("runtime_session_not_found",
                    "Runtime Session is not active in this Broker process"));
        }
        return context.thenApply(value -> {
            if (!value.session().getHarnessSessionId().equals(harnessId)) {
                throw conflict("runtime_session_conflict",
                        "Runtime Session belongs to another Harness Session");
            }
            return value;
        });
    }

    private RuntimeSessionRecord requireReadySessionRecord(
            SessionContext context) {
        RuntimeSessionRecord record = sessionRepository.findById(
                context.session().getScope(),
                context.session().getRuntimeSessionId());
        if (record == null) {
            throw notFound("runtime_session_not_found",
                    "Runtime Session was not found");
        }
        if (record.getState() != RuntimeSessionRecord.State.READY) {
            throw conflict("runtime_session_not_ready",
                    "Runtime Session is not ready");
        }
        return record;
    }

    private void beginDispatch(SessionContext context,
            ToolExecutionRecord prepared) {
        CompletableFuture<Void> created = new CompletableFuture<>();
        CompletableFuture<Void> existing = dispatches.putIfAbsent(
                prepared.getExecutionCallId(), created);
        if (existing != null) {
            return;
        }
        CompletionStage<Void> operation;
        try {
            operation = dispatch(context, prepared);
        } catch (RuntimeException | Error exception) {
            dispatches.remove(prepared.getExecutionCallId(), created);
            created.completeExceptionally(exception);
            throw unavailable("runtime_execution_dispatch_failed",
                    "Runtime execution dispatch failed", exception);
        }
        operation.whenComplete((ignored, error) -> {
            dispatches.remove(prepared.getExecutionCallId(), created);
            if (error == null) {
                created.complete(null);
            } else {
                created.completeExceptionally(unwrap(error));
            }
        });
    }

    private CompletionStage<Void> dispatch(SessionContext context,
            ToolExecutionRecord prepared) {
        ToolExecutionRecord claimed = executionRepository.claimDispatch(
                prepared.getExecutionCallId(), brokerOwnerId,
                dispatchLeaseDuration);
        if (claimed == null
                || claimed.getState()
                        != ToolExecutionRecord.State.DISPATCHING) {
            return CompletableFuture.completedFuture(null);
        }
        ToolExecutionRecord executing = enterExecuting(claimed);
        if (executing == null || executing.isSettled()
                || executing.getState()
                        != ToolExecutionRecord.State.EXECUTING
                || !ownsDispatch(executing, claimed)) {
            return CompletableFuture.completedFuture(null);
        }
        DispatchRenewal renewal = new DispatchRenewal(
                executing.getExecutionCallId(),
                executing.getDispatchGeneration());
        try {
            renewal.start();
        } catch (RuntimeException | Error exception) {
            markUnknown(executing.getExecutionCallId(),
                    executing.getDispatchGeneration());
            throw exception;
        }
        return safeStage(() -> transport.execute(context.lease(),
                context.session(), executing.getReference()))
                .<Void>handle((result, error) -> {
                    if (error != null || result == null) {
                        markUnknown(executing.getExecutionCallId(),
                                executing.getDispatchGeneration());
                        return null;
                    }
                    try {
                        settleExecution(executing.getExecutionCallId(),
                                executing.getDispatchGeneration(), result);
                    } catch (RuntimeException exception) {
                        markUnknown(executing.getExecutionCallId(),
                                executing.getDispatchGeneration());
                    }
                    return null;
                }).whenComplete((ignored, error) -> renewal.close());
    }

    private ToolExecutionRecord enterExecuting(
            ToolExecutionRecord claimed) {
        ToolExecutionRecord current = claimed;
        for (int attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
            if (current == null || current.isSettled()
                    || current.getState()
                            == ToolExecutionRecord.State.UNKNOWN
                    || !ownsDispatch(current, claimed)) {
                return current;
            }
            ToolExecutionRecord replacement;
            if (current.isCancelRequested()) {
                replacement = current.withResult(
                        Map.of("executionStatus", "cancelled"),
                        current.getLastSequence(), clock.instant());
            } else {
                replacement = current.withState(
                        ToolExecutionRecord.State.EXECUTING, false);
            }
            ToolExecutionRecord updated = executionRepository.compareAndSet(
                    current, replacement, brokerOwnerId,
                    claimed.getDispatchGeneration());
            if (updated != null) {
                return updated;
            }
            current = executionRepository.findByExecutionCallId(
                    claimed.getExecutionCallId());
        }
        markUnknown(claimed.getExecutionCallId(),
                claimed.getDispatchGeneration());
        return null;
    }

    private void settleExecution(String executionCallId,
            long dispatchGeneration, Map<String, Object> result) {
        ToolExecutionRecord current = executionRepository
                .findByExecutionCallId(executionCallId);
        for (int attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
            if (current == null || current.isSettled()
                    || current.getState()
                            == ToolExecutionRecord.State.UNKNOWN
                    || !ownsDispatch(current, dispatchGeneration)) {
                return;
            }
            ToolExecutionRecord replacement = current.withResult(result,
                    current.getLastSequence(), clock.instant());
            ToolExecutionRecord updated = executionRepository.compareAndSet(
                    current, replacement, brokerOwnerId,
                    dispatchGeneration);
            if (updated != null) {
                return;
            }
            current = executionRepository.findByExecutionCallId(
                    executionCallId);
        }
        throw conflict("runtime_execution_state_conflict",
                "Runtime execution changed while settling");
    }

    private void markUnknown(String executionCallId,
            long dispatchGeneration) {
        ToolExecutionRecord current = executionRepository
                .findByExecutionCallId(executionCallId);
        for (int attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
            if (current == null || current.isSettled()
                    || current.getState()
                            == ToolExecutionRecord.State.UNKNOWN
                    || !ownsDispatch(current, dispatchGeneration)) {
                return;
            }
            ToolExecutionRecord updated = executionRepository.compareAndSet(
                    current, current.withUnknown(), brokerOwnerId,
                    dispatchGeneration);
            if (updated != null) {
                return;
            }
            current = executionRepository.findByExecutionCallId(
                    executionCallId);
        }
    }

    private ToolExecutionRecord requestCancel(
            ToolExecutionRecord initial) {
        ToolExecutionRecord current = initial;
        for (int attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
            if (current.isSettled() || current.isCancelRequested()) {
                return current;
            }
            ToolExecutionRecord updated = executionRepository.requestCancel(
                    current.getExecutionCallId(), current.getVersion());
            if (updated != null) {
                return updated;
            }
            current = executionRepository.findByExecutionCallId(
                    current.getExecutionCallId());
            if (current == null) {
                throw notFound("runtime_execution_not_found",
                        "Runtime execution was not found");
            }
        }
        throw conflict("runtime_execution_state_conflict",
                "Runtime execution changed while requesting cancellation");
    }

    private void absorbCancellationStatus(ToolExecutionRecord requested,
            Map<String, Object> status) {
        Object state = status == null ? null : status.get("state");
        if (!(state instanceof String)
                || !RUNTIME_EXECUTION_STATES.contains(state)) {
            throw unavailable("runtime_execution_cancel_failed",
                    "Runtime cancellation returned an invalid status");
        }
        if (!"settled".equals(state)) {
            return;
        }
        Map<String, Object> result = runtimeMap(status.get("result"),
                "cancellation result");
        try {
            settleExecution(requested.getExecutionCallId(),
                    requested.getDispatchGeneration(), result);
        } catch (IllegalArgumentException exception) {
            throw unavailable("runtime_execution_cancel_failed",
                    "Runtime cancellation returned an invalid result",
                    exception);
        }
    }

    private ToolExecutionRecord requireExecution(SessionContext context,
            String executionCallId) {
        ToolExecutionRecord record = executionRepository
                .findByExecutionCallId(executionCallId);
        if (record == null) {
            throw notFound("runtime_execution_not_found",
                    "Runtime execution was not found");
        }
        if (!record.getHarnessSessionId().equals(
                context.session().getHarnessSessionId())
                || !record.getRuntimeSessionId().equals(
                        context.session().getRuntimeSessionId())
                || !record.getBindingId().equals(
                        context.binding().getBindingId())
                || record.getRuntimeGeneration()
                        != context.binding().getGeneration()) {
            throw conflict("runtime_execution_conflict",
                    "Runtime execution belongs to another Session or "
                            + "Runtime generation");
        }
        return record;
    }

    private RuntimeSessionRecord transitionSessionToReleasing(
            SessionContext context) {
        RuntimeSessionRecord current = sessionRepository.findById(
                context.session().getScope(),
                context.session().getRuntimeSessionId());
        if (current == null) {
            throw notFound("runtime_session_not_found",
                    "Runtime Session was not found");
        }
        for (int attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
            if (current.getState()
                    == RuntimeSessionRecord.State.RELEASING) {
                return current;
            }
            if (current.getState()
                    == RuntimeSessionRecord.State.RELEASED) {
                return current;
            }
            if (current.getState() != RuntimeSessionRecord.State.READY) {
                throw conflict("runtime_session_not_ready",
                        "Runtime Session is not ready for release");
            }
            RuntimeSessionRecord updated = sessionRepository.compareAndSet(
                    current, current.withState(
                            RuntimeSessionRecord.State.RELEASING,
                            clock.instant()));
            if (updated != null) {
                return updated;
            }
            current = sessionRepository.findById(
                    context.session().getScope(),
                    context.session().getRuntimeSessionId());
            if (current == null) {
                throw conflict("runtime_session_state_conflict",
                        "Runtime Session changed while releasing");
            }
        }
        throw conflict("runtime_session_state_conflict",
                "Runtime Session changed while releasing");
    }

    private void finishSessionRelease(RuntimeSessionRecord releasing) {
        RuntimeSessionRecord current = releasing;
        for (int attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
            RuntimeSessionRecord updated = sessionRepository.compareAndSet(
                    current, current.withState(
                            RuntimeSessionRecord.State.RELEASED,
                            clock.instant()));
            if (updated != null
                    || current.getState()
                            == RuntimeSessionRecord.State.RELEASED) {
                return;
            }
            current = sessionRepository.findById(
                    releasing.getSession().getScope(),
                    releasing.getRuntimeSessionId());
            if (current != null && current.getState()
                    == RuntimeSessionRecord.State.RELEASED) {
                return;
            }
            if (current == null || current.getState()
                            != RuntimeSessionRecord.State.RELEASING) {
                throw conflict("runtime_session_state_conflict",
                        "Runtime Session changed after release");
            }
        }
        throw conflict("runtime_session_state_conflict",
                "Runtime Session changed after release");
    }

    private void failBinding(RuntimeBindingRecord claimed) {
        bindingRepository.compareAndSet(claimed, claimed.withState(
                RuntimeBindingRecord.State.FAILED, null, clock.instant()));
    }

    @Override
    public void close() {
        if (!closed.compareAndSet(false, true)) {
            return;
        }
        bindingOperations.values().forEach(future -> future.cancel(false));
        sessions.values().forEach(future -> future.cancel(false));
        dispatches.values().forEach(future -> future.cancel(false));
        scheduler.shutdownNow();
    }

    private CompletionStage<RuntimeScope> resolveScope(
            String harnessSessionId) {
        return mapFailure(safeStage(
                () -> sessionResolver.resolve(harnessSessionId)),
                "runtime_scope_resolution_failed",
                "Runtime scope resolution failed").thenApply(scope -> {
                    if (scope == null) {
                        throw unavailable("runtime_scope_resolution_failed",
                                "Runtime scope resolver returned no scope");
                    }
                    return scope;
                });
    }

    private static RuntimeProvisionRequest provisionRequest(
            RuntimeScope scope, String harnessSessionId) {
        return new RuntimeProvisionRequest(scope,
                "session".equals(scope.getIsolationClass())
                        ? harnessSessionId : null);
    }

    private static void requireSameSession(RuntimeSession actual,
            RuntimeSession requested) {
        if (!actual.getHarnessSessionId().equals(
                requested.getHarnessSessionId())
                || !actual.getTurnKind().equals(requested.getTurnKind())
                || !actual.getScope().equals(requested.getScope())) {
            throw conflict("runtime_session_conflict",
                    "runtimeSessionId belongs to another Session identity");
        }
    }

    private String nextExecutionId() {
        return BrokerValues.requireId(executionIdSupplier.get(),
                "executionCallId");
    }

    private static String referenceString(Map<String, Object> reference,
            String field) {
        Object value = reference == null ? null : reference.get(field);
        if (!(value instanceof String)) {
            throw invalid("runtime_reference_invalid",
                    "reference " + field + " is required");
        }
        try {
            return BrokerValues.requireId((String) value,
                    "reference." + field);
        } catch (IllegalArgumentException exception) {
            throw invalid("runtime_reference_invalid",
                    "reference " + field + " is invalid");
        }
    }

    private boolean shouldDriveDispatch(ToolExecutionRecord record) {
        return !record.isSettled()
                && record.getState() != ToolExecutionRecord.State.UNKNOWN
                && (record.getState() == ToolExecutionRecord.State.PREPARED
                        || record.getState()
                                == ToolExecutionRecord.State.DISPATCHING
                        || !record.hasLiveDispatchAt(clock.instant()));
    }

    private static Map<String, Object> immutableMap(Object value,
            String name) {
        if (!(value instanceof Map<?, ?>)) {
            throw invalid("runtime_payload_invalid",
                    name + " must be an object");
        }
        @SuppressWarnings("unchecked")
        Map<String, ?> source = (Map<String, ?>) value;
        try {
            return BrokerValues.immutableMap(source);
        } catch (IllegalArgumentException exception) {
            throw invalid("runtime_payload_invalid",
                    name + " is invalid");
        }
    }

    private static Map<String, Object> runtimeMap(Object value,
            String name) {
        if (!(value instanceof Map<?, ?>)) {
            throw unavailable("runtime_execution_cancel_failed",
                    name + " must be an object");
        }
        @SuppressWarnings("unchecked")
        Map<String, ?> source = (Map<String, ?>) value;
        try {
            return BrokerValues.immutableMap(source);
        } catch (IllegalArgumentException exception) {
            throw unavailable("runtime_execution_cancel_failed",
                    name + " is invalid", exception);
        }
    }

    private static boolean ownsDispatch(ToolExecutionRecord current,
            ToolExecutionRecord claimed) {
        return claimed.getDispatchGeneration()
                        == current.getDispatchGeneration()
                && claimed.getDispatchOwner().equals(
                        current.getDispatchOwner());
    }

    private boolean ownsDispatch(ToolExecutionRecord current,
            long dispatchGeneration) {
        return dispatchGeneration == current.getDispatchGeneration()
                && brokerOwnerId.equals(current.getDispatchOwner());
    }

    private static boolean sameLease(RuntimeLease left,
            RuntimeLease right) {
        return left.getRuntimeInstanceId().equals(
                right.getRuntimeInstanceId())
                && left.getEndpoint().equals(right.getEndpoint())
                && left.getToken().equals(right.getToken())
                && left.getLeaseId().equals(right.getLeaseId())
                && left.getEpoch() == right.getEpoch();
    }

    private static Duration requireDuration(Duration duration,
            String name) {
        if (duration == null || duration.isZero() || duration.isNegative()) {
            throw new IllegalArgumentException(name + " must be positive");
        }
        return duration;
    }

    private void requireOpen() {
        if (closed.get()) {
            throw new IllegalStateException("Runtime Broker is closed");
        }
    }

    private static ScheduledExecutorService newScheduler() {
        return Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread thread = new Thread(runnable,
                    "qwen-runtime-broker-lease-renewal");
            thread.setDaemon(true);
            return thread;
        });
    }

    private long renewalDelayMillis(Duration duration) {
        return Math.max(1, duration.toMillis() / 3);
    }

    private static <T> CompletionStage<T> safeStage(
            Supplier<CompletionStage<T>> supplier) {
        try {
            CompletionStage<T> stage = supplier.get();
            if (stage == null) {
                return failed(new IllegalStateException(
                        "operation returned no CompletionStage"));
            }
            return stage;
        } catch (RuntimeException | Error exception) {
            return failed(exception);
        }
    }

    private static <T> CompletionStage<T> mapFailure(
            CompletionStage<T> stage, String code, String message) {
        return stage.handle((value, error) -> {
            if (error == null) {
                return value;
            }
            Throwable cause = unwrap(error);
            if (cause instanceof RuntimeBrokerException) {
                throw new CompletionException(cause);
            }
            throw new CompletionException(
                    unavailable(code, message, cause));
        });
    }

    private static Throwable unwrap(Throwable error) {
        Throwable current = error;
        while ((current instanceof CompletionException)
                && current.getCause() != null) {
            current = current.getCause();
        }
        return current;
    }

    private static <T> CompletableFuture<T> failed(Throwable error) {
        return CompletableFuture.failedFuture(error);
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

    private static RuntimeBrokerException conflict(String code,
            String message, Throwable cause) {
        return new RuntimeBrokerException(409, code, message, false, cause);
    }

    private static RuntimeBrokerException unavailable(String code,
            String message) {
        return new RuntimeBrokerException(503, code, message, true);
    }

    private static RuntimeBrokerException unavailable(String code,
            String message, Throwable cause) {
        return new RuntimeBrokerException(503, code, message, true, cause);
    }

    private record LiveBinding(long generation, RuntimeLease lease) {
    }

    private record BindingContext(RuntimeBindingRecord record,
            RuntimeLease lease) {
    }

    private static final class SessionContext {
        private final RuntimeSession session;
        private final RuntimeBindingRecord binding;
        private final RuntimeLease lease;
        private int activeControls;
        private CompletableFuture<Boolean> release;

        SessionContext(RuntimeSession session, RuntimeBindingRecord binding,
                RuntimeLease lease) {
            this.session = session;
            this.binding = binding;
            this.lease = lease;
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

        synchronized void beginControl() {
            activeControls++;
        }

        synchronized void endControl() {
            activeControls--;
        }

        synchronized boolean hasActiveControl() {
            return activeControls > 0;
        }

        synchronized CompletableFuture<Boolean> release() {
            return release;
        }

        synchronized void release(CompletableFuture<Boolean> next) {
            release = next;
        }
    }

    private final class BindingRenewal implements AutoCloseable {
        private final AtomicReference<RuntimeBindingRecord> current;
        private final AtomicBoolean valid = new AtomicBoolean(true);
        private ScheduledFuture<?> task;

        BindingRenewal(RuntimeBindingRecord claimed) {
            current = new AtomicReference<>(claimed);
        }

        synchronized void start() {
            long delay = renewalDelayMillis(operationLeaseDuration);
            task = scheduler.scheduleWithFixedDelay(this::renew, delay,
                    delay, TimeUnit.MILLISECONDS);
        }

        synchronized RuntimeBindingRecord stopAndGet() {
            close();
            return !closed.get() && valid.get() ? current.get() : null;
        }

        private synchronized void renew() {
            if (closed.get()) {
                close();
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
                    close();
                } else {
                    current.set(renewed);
                }
            } catch (RuntimeException exception) {
                valid.set(false);
                close();
            }
        }

        @Override
        public synchronized void close() {
            if (task != null) {
                task.cancel(false);
            }
        }
    }

    private final class DispatchRenewal implements AutoCloseable {
        private final String executionCallId;
        private final long dispatchGeneration;
        private ScheduledFuture<?> task;

        DispatchRenewal(String executionCallId,
                long dispatchGeneration) {
            this.executionCallId = executionCallId;
            this.dispatchGeneration = dispatchGeneration;
        }

        synchronized void start() {
            long delay = renewalDelayMillis(dispatchLeaseDuration);
            task = scheduler.scheduleWithFixedDelay(this::renew, delay,
                    delay, TimeUnit.MILLISECONDS);
        }

        private synchronized void renew() {
            if (closed.get()) {
                close();
                return;
            }
            try {
                ToolExecutionRecord renewed =
                        executionRepository.renewDispatch(executionCallId,
                                brokerOwnerId, dispatchGeneration,
                                dispatchLeaseDuration);
                if (renewed == null) {
                    executionRepository.claimDispatch(executionCallId,
                            brokerOwnerId, dispatchLeaseDuration);
                    close();
                }
            } catch (RuntimeException exception) {
                // A transient repository failure does not prove claim loss.
            }
        }

        @Override
        public synchronized void close() {
            if (task != null) {
                task.cancel(false);
            }
        }
    }
}
