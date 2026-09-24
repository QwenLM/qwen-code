package com.alibaba.qwen.code.runtimebroker;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
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
    // Executions whose transport.execute call is in flight in this process,
    // as opposed to dispatches, which also covers a claim being fenced.
    private final Set<String> invocations = ConcurrentHashMap.newKeySet();

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
                        requireUsableLease(context);
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
                        // An UNKNOWN record may still have an invocation
                        // running in this process; it gets the physical
                        // cancel below but is never settled from here.
                        if (requested.isSettled()
                                || (requested.getState()
                                        == ToolExecutionRecord.State.UNKNOWN
                                        && !invocations.contains(
                                                executionId))) {
                            return CompletableFuture.completedFuture(
                                    requested);
                        }
                    }
                    if (requested.getState()
                            == ToolExecutionRecord.State.DISPATCHING) {
                        beginDispatch(context, requested);
                        ToolExecutionRecord latest = executionRepository
                                .findByExecutionCallId(executionId);
                        return CompletableFuture.completedFuture(
                                latest == null ? requested : latest);
                    }
                    if (requested.getState()
                                    == ToolExecutionRecord.State
                                            .CANCEL_REQUESTED
                            && !invocations.contains(executionId)) {
                        // Fence a lapsed claim nothing here is running. A
                        // claim the repository still holds live falls
                        // through to the physical cancel, as does an
                        // invocation still running in this process.
                        ToolExecutionRecord fenced;
                        try {
                            fenced = fenceLapsedClaim(requested);
                        } catch (RuntimeException exception) {
                            throw unavailable(
                                    "runtime_execution_cancel_failed",
                                    "Runtime execution cancellation failed",
                                    exception);
                        }
                        if (fenced == null || fenced.getState()
                                != ToolExecutionRecord.State
                                        .CANCEL_REQUESTED) {
                            return CompletableFuture.completedFuture(
                                    fenced == null ? requested : fenced);
                        }
                    }
                    if (requested.getState()
                                    != ToolExecutionRecord.State
                                            .CANCEL_REQUESTED
                            && requested.getState()
                                    != ToolExecutionRecord.State.UNKNOWN) {
                        return CompletableFuture.completedFuture(requested);
                    }
                    requireUsableLease(context);
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
        if (!provisioner.isUsable(context.lease())) {
            return releaseUnusableSession(context);
        }
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

    /**
     * A session whose worker is already dead cannot reach the transport.
     * Retire the binding and finish the release locally. An in-flight
     * execution still reports busy; an in-flight release is joined.
     */
    private CompletionStage<Boolean> releaseUnusableSession(
            SessionContext context) {
        invalidateBinding(context.binding());
        synchronized (context) {
            CompletableFuture<Boolean> inFlight = context.release();
            if (inFlight != null) {
                return inFlight;
            }
            if (context.hasActiveControl()
                    || executionRepository.hasActiveByRuntimeSession(
                            context.session().getRuntimeSessionId())) {
                throw conflict("runtime_session_busy",
                        "Runtime Session has an active operation");
            }
            RuntimeSessionRecord releasing =
                    transitionSessionToReleasing(context);
            if (releasing.getState()
                    != RuntimeSessionRecord.State.RELEASED) {
                finishSessionRelease(releasing);
            }
            sessions.remove(context.session().getRuntimeSessionId());
            return CompletableFuture.completedFuture(true);
        }
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
            LiveBinding live = liveBindings.get(record.getBindingId());
            if (live == null || live.generation() != record.getGeneration()
                    || record.getLease() == null
                    || !sameLease(live.lease(), record.getLease())) {
                if (!record.getRequest().requiresDurableIdentity()) {
                    return failed(unavailable(
                            "runtime_reconciliation_required",
                            "persisted Runtime readiness requires adoption "
                                    + "or reconciliation in this Broker "
                                    + "process"));
                }
                return reconcileBinding(record);
            }
            BindingContext context = new BindingContext(record,
                    live.lease());
            CompletableFuture<BindingContext> confirmed =
                    new CompletableFuture<>();
            safeStage(() -> provisioner.confirm(request, live.lease()))
                    .whenComplete((ignored, error) -> {
                        if (error == null) {
                            confirmed.complete(context);
                        } else {
                            invalidateBinding(record);
                            confirmed.completeExceptionally(unwrap(error));
                        }
                    });
            return confirmed;
        }
        if (record.getState() == RuntimeBindingRecord.State.LOST) {
            return reclaimLostBinding(record, request);
        }
        if (record.getState()
                == RuntimeBindingRecord.State.RECOVERY_BLOCKED) {
            return failed(conflict("runtime_broker_recovery_blocked",
                    "Managed Runtime recovery is blocked."));
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
            if (claimed.getState() == RuntimeBindingRecord.State.READY
                    && claimed.getRequest().requiresDurableIdentity()
                    && !isLiveBinding(claimed)) {
                return startReconciliation(claimed);
            }
            return claimed.getState() == RuntimeBindingRecord.State.READY
                    ? CompletableFuture.completedFuture(
                            requireLiveBinding(claimed))
                    : failed(unavailable("runtime_binding_unavailable",
                            "Runtime binding is not available"));
        }
        if (claimed.getRequest().requiresDurableIdentity()) {
            return provisionDurableBinding(claimed);
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
                        releaseQuietly(claimed.getRequest(), lease);
                        throw unavailable("runtime_provision_fenced",
                                "Runtime provisioning claim expired");
                    }
                    RuntimeBindingRecord ready =
                            bindingRepository.compareAndSet(currentClaim,
                                    currentClaim.withState(
                                            RuntimeBindingRecord.State.READY,
                                            lease, clock.instant()));
                    if (ready == null) {
                        releaseQuietly(claimed.getRequest(), lease);
                        throw unavailable("runtime_provision_fenced",
                                "Runtime provisioning claim expired");
                    }
                    liveBindings.put(ready.getBindingId(),
                            new LiveBinding(ready.getGeneration(), lease));
                    return new BindingContext(ready, lease);
                });
    }

    /**
     * Durable provisioning drives the resource with the persisted seed and
     * only marks the binding READY after the Broker itself attested the
     * Runtime identity. A non-retryable identity conflict blocks recovery
     * instead of failing the binding for a retry.
     */
    private CompletionStage<BindingContext> provisionDurableBinding(
            RuntimeBindingRecord claimed) {
        RuntimeProvisionRequest request = claimed.getRequest();
        RuntimeProvisionSeed seed = claimed.getProvisionSeed();
        if (seed == null) {
            blockRecovery(claimed);
            releaseOperationQuietly(claimed.getBindingId(),
                    claimed.getOperationGeneration());
            return failed(conflict("runtime_broker_recovery_blocked",
                    "Managed Runtime recovery is blocked."));
        }
        BindingRenewal renewal = new BindingRenewal(claimed);
        renewal.start();
        return mapFailure(safeStage(() -> provisioner.ensureResource(request,
                seed, claimed.getResourceHandle())), "runtime_provision_failed",
                "Runtime provisioning failed")
                .thenCompose(handle -> {
                    if (handle == null) {
                        throw unavailable("runtime_provision_failed",
                                "Runtime provisioning returned no resource "
                                        + "handle");
                    }
                    if (!request.getProvisionerKind().equals(
                            handle.getKind())) {
                        throw conflict("runtime_broker_resource_conflict",
                                "Managed Runtime resource identity "
                                        + "conflicts.");
                    }
                    return provisionAndAttest(request, seed)
                            .thenApply(lease -> new DurableProvision(lease,
                                    handle));
                })
                .handle((outcome, error) -> {
                    RuntimeBindingRecord currentClaim = renewal.stopAndGet();
                    try {
                        if (error != null) {
                            Throwable cause = unwrap(error);
                            if (currentClaim != null) {
                                if (cause instanceof RuntimeBrokerException
                                        brokerFailure
                                        && !brokerFailure.isRetryable()) {
                                    blockRecovery(currentClaim);
                                } else {
                                    failBinding(currentClaim);
                                }
                            }
                            if (cause instanceof RuntimeBrokerException) {
                                throw new CompletionException(cause);
                            }
                            throw unavailable("runtime_provision_failed",
                                    "Runtime provisioning failed", cause);
                        }
                        if (currentClaim == null) {
                            releaseQuietly(request, outcome.lease());
                            throw unavailable("runtime_provision_fenced",
                                    "Runtime provisioning claim expired");
                        }
                        Instant now = clock.instant();
                        RuntimeBindingRecord ready =
                                bindingRepository.compareAndSet(currentClaim,
                                        currentClaim.withAttestation(
                                                outcome.lease(),
                                                outcome.handle(),
                                                now, now));
                        if (ready == null) {
                            releaseQuietly(request, outcome.lease());
                            throw unavailable("runtime_provision_fenced",
                                    "Runtime provisioning claim expired");
                        }
                        liveBindings.put(ready.getBindingId(),
                                new LiveBinding(ready.getGeneration(),
                                        ready.getLease()));
                        return new BindingContext(ready, ready.getLease());
                    } finally {
                        releaseOperationQuietly(claimed.getBindingId(),
                                claimed.getOperationGeneration());
                    }
                });
    }

    private CompletionStage<RuntimeLease> provisionAndAttest(
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed) {
        return safeStage(() -> provisioner.provision(request, seed))
                .thenCompose(lease -> {
                    if (lease == null) {
                        throw unavailable("runtime_provision_failed",
                                "Runtime provisioning returned no lease");
                    }
                    return mapFailure(safeStage(() -> transport.attest(lease,
                            request, seed)), "runtime_provision_failed",
                            "Runtime attestation failed")
                            .thenApply(attestation -> {
                                if (!validAttestation(attestation, lease,
                                        seed, request)) {
                                    throw conflict(
                                            "runtime_broker_attestation_conflict",
                                            "Managed Runtime attestation "
                                                    + "conflicts.");
                                }
                                return lease;
                            })
                            .whenComplete((attestedLease, attestError) -> {
                                if (attestError != null) {
                                    releaseQuietly(request, attestedLease);
                                }
                            });
                });
    }

    /**
     * Adopts a persisted READY binding this process did not provision. The
     * physical resource is observed through the provisioner and re-attested
     * through the transport before any session may use it. UNKNOWN and
     * STARTING observations retry inside the operation deadline and never
     * create or replace the resource; NOT_FOUND loses the binding; an
     * identity conflict blocks recovery.
     */
    private CompletionStage<BindingContext> reconcileBinding(
            RuntimeBindingRecord record) {
        CompletableFuture<BindingContext> created = new CompletableFuture<>();
        CompletableFuture<BindingContext> existing =
                bindingOperations.putIfAbsent(record.getBindingId(),
                        created);
        if (existing != null) {
            return existing;
        }
        startReconciliation(record).whenComplete((context, error) -> {
            bindingOperations.remove(record.getBindingId(), created);
            if (error == null) {
                created.complete(context);
            } else {
                created.completeExceptionally(unwrap(error));
            }
        });
        return created;
    }

    private CompletionStage<BindingContext> startReconciliation(
            RuntimeBindingRecord record) {
        RuntimeBindingRecord claimed = bindingRepository.claimOperation(
                record.getBindingId(), brokerOwnerId,
                operationLeaseDuration);
        if (claimed == null) {
            return failed(unavailable("runtime_reconcile_in_progress",
                    "another Broker owns Runtime recovery"));
        }
        if (claimed.getState() != RuntimeBindingRecord.State.READY) {
            releaseOperationQuietly(claimed.getBindingId(),
                    claimed.getOperationGeneration());
            return failed(unavailable("runtime_binding_unavailable",
                    "Runtime binding is not available"));
        }
        if (claimed.getProvisionSeed() == null) {
            blockRecovery(claimed);
            releaseOperationQuietly(claimed.getBindingId(),
                    claimed.getOperationGeneration());
            return failed(conflict("runtime_broker_recovery_blocked",
                    "Managed Runtime recovery is blocked."));
        }
        String bindingId = claimed.getBindingId();
        long operationGeneration = claimed.getOperationGeneration();
        BindingRenewal renewal = new BindingRenewal(claimed);
        renewal.start();
        CompletableFuture<BindingContext> operation =
                new CompletableFuture<>();
        // The deadline fires independently of loop progress, so a parked
        // reconcile or attestation cannot hold the binding open forever.
        // Releasing the claim first fences any late write from this
        // operation.
        ScheduledFuture<?> deadlineTask;
        try {
            deadlineTask = scheduler.schedule(() -> {
                renewal.close();
                releaseOperationQuietly(bindingId, operationGeneration);
                operation.completeExceptionally(unavailable(
                        "runtime_broker_reconcile_timeout",
                        "Managed Runtime reconciliation timed out."));
            }, operationDeadlineNanos(), TimeUnit.NANOSECONDS);
        } catch (RuntimeException scheduleFailure) {
            renewal.stopAndGet();
            releaseOperationQuietly(bindingId, operationGeneration);
            return failed(scheduleFailure);
        }
        reconcileLoop(bindingId, operationGeneration, renewal,
                System.nanoTime() + operationDeadlineNanos(), 0)
                .whenComplete((context, error) -> {
                    deadlineTask.cancel(false);
                    renewal.stopAndGet();
                    releaseOperationQuietly(bindingId, operationGeneration);
                    if (error == null) {
                        operation.complete(context);
                    } else {
                        operation.completeExceptionally(unwrap(error));
                    }
                });
        return operation;
    }

    private CompletionStage<BindingContext> reconcileLoop(String bindingId,
            long operationGeneration, BindingRenewal renewal,
            long deadlineNanos, int attempt) {
        if (System.nanoTime() >= deadlineNanos) {
            return failed(unavailable("runtime_broker_reconcile_timeout",
                    "Managed Runtime reconciliation timed out."));
        }
        RuntimeBindingRecord current = bindingRepository.findById(bindingId);
        if (current == null || current.getOperationGeneration()
                != operationGeneration
                || !brokerOwnerId.equals(current.getOperationOwner())
                || current.getState() != RuntimeBindingRecord.State.READY) {
            return failed(unavailable("runtime_provision_fenced",
                    "Runtime recovery claim expired"));
        }
        RuntimeBindingRecord claimed = current;
        return safeStage(() -> provisioner.reconcile(claimed.getRequest(),
                claimed.getProvisionSeed(), claimed.getResourceHandle(),
                claimed.getLease()))
                .handle((observation, error) -> {
                    if (error != null) {
                        Throwable cause = unwrap(error);
                        if (cause instanceof RuntimeBrokerException
                                brokerFailure
                                && !brokerFailure.isRetryable()) {
                            return ReconcileStep.blocked(conflict(
                                    "runtime_broker_recovery_failed",
                                    "Managed Runtime reconciliation failed.",
                                    cause));
                        }
                        return ReconcileStep.retry();
                    }
                    if (observation == null) {
                        return ReconcileStep.retry();
                    }
                    switch (observation.getOutcome()) {
                        case READY:
                            return ReconcileStep.ready(observation);
                        case STARTING:
                        case UNKNOWN:
                            return ReconcileStep.retry();
                        case NOT_FOUND:
                            return ReconcileStep.lost();
                        case CONFLICT:
                            return ReconcileStep.blocked(conflict(
                                    "runtime_broker_resource_conflict",
                                    "Managed Runtime resource identity "
                                            + "conflicts."));
                        default:
                            return ReconcileStep.blocked(conflict(
                                    "runtime_broker_recovery_failed",
                                    "Managed Runtime reconciliation "
                                            + "returned an unknown outcome."));
                    }
                })
                .thenCompose(step -> {
                    switch (step.kind()) {
                        case RETRY: {
                            if (System.nanoTime() >= deadlineNanos) {
                                return failed(unavailable(
                                        "runtime_broker_reconcile_timeout",
                                        "Managed Runtime reconciliation "
                                                + "timed out."));
                            }
                            long delay = Math.min(2_000,
                                    50L << Math.min(attempt, 5));
                            CompletableFuture<BindingContext> next =
                                    new CompletableFuture<>();
                            try {
                                scheduler.schedule(() -> reconcileLoop(
                                        bindingId, operationGeneration,
                                        renewal, deadlineNanos, attempt + 1)
                                        .whenComplete((context, error) -> {
                                            if (error == null) {
                                                next.complete(context);
                                            } else {
                                                next.completeExceptionally(
                                                        unwrap(error));
                                            }
                                        }), delay, TimeUnit.MILLISECONDS);
                            } catch (RuntimeException scheduleFailure) {
                                return failed(scheduleFailure);
                            }
                            return next;
                        }
                        case LOST: {
                            RuntimeBindingRecord latest =
                                    bindingRepository.findById(bindingId);
                            if (latest == null || !ownsOperation(latest,
                                    operationGeneration)
                                    || latest.getState()
                                            != RuntimeBindingRecord.State
                                                    .READY) {
                                return failed(unavailable(
                                        "runtime_provision_fenced",
                                        "Runtime recovery claim expired"));
                            }
                            RuntimeBindingRecord lost =
                                    bindingRepository.compareAndSet(latest,
                                            latest.withState(
                                                    RuntimeBindingRecord
                                                            .State.LOST,
                                                    latest.getLease(),
                                                    clock.instant()));
                            if (lost == null) {
                                return failed(unavailable(
                                        "runtime_provision_fenced",
                                        "Runtime recovery claim expired"));
                            }
                            return reclaimLostBinding(lost,
                                    lost.getRequest());
                        }
                        case BLOCKED:
                            blockRecovery(bindingId, operationGeneration);
                            return failed(step.error());
                        default:
                            return adoptObservation(bindingId,
                                    operationGeneration, step.observation());
                    }
                });
    }

    private CompletionStage<BindingContext> adoptObservation(String bindingId,
            long operationGeneration, RuntimeObservation observation) {
        RuntimeBindingRecord current = bindingRepository.findById(bindingId);
        if (current == null || !ownsOperation(current, operationGeneration)
                || current.getState() != RuntimeBindingRecord.State.READY) {
            return failed(unavailable("runtime_provision_fenced",
                    "Runtime recovery claim expired"));
        }
        RuntimeProvisionRequest request = current.getRequest();
        RuntimeProvisionSeed seed = current.getProvisionSeed();
        RuntimeResourceHandle handle = observation.getHandle();
        if (handle != null && !request.getProvisionerKind().equals(
                handle.getKind())) {
            blockRecovery(bindingId, operationGeneration);
            return failed(conflict("runtime_broker_resource_conflict",
                    "Managed Runtime resource identity conflicts."));
        }
        if (!seed.getProvisionalRuntimeId().equals(
                observation.getRuntimeInstanceId())
                || !seed.getLeaseId().equals(observation.getLeaseId())
                || seed.getEpoch() != observation.getEpoch()) {
            blockRecovery(bindingId, operationGeneration);
            return failed(conflict("runtime_broker_runtime_identity_conflict",
                    "Managed Runtime identity conflicts."));
        }
        RuntimeLease lease = new RuntimeLease(
                observation.getRuntimeInstanceId(), observation.getEndpoint(),
                seed.getToken(), observation.getLeaseId(),
                observation.getEpoch());
        return mapFailure(safeStage(() -> transport.attest(lease, request,
                seed)), "runtime_broker_recovery_failed",
                "Managed Runtime attestation failed")
                .thenCompose(attestation -> {
                    if (!validAttestation(attestation, lease, seed,
                            request)) {
                        blockRecovery(bindingId, operationGeneration);
                        return failed(conflict(
                                "runtime_broker_attestation_conflict",
                                "Managed Runtime attestation conflicts."));
                    }
                    Instant now = clock.instant();
                    RuntimeBindingRecord latest =
                            bindingRepository.findById(bindingId);
                    if (latest == null
                            || !ownsOperation(latest, operationGeneration)
                            || latest.getState()
                                    != RuntimeBindingRecord.State.READY) {
                        return failed(unavailable("runtime_provision_fenced",
                                "Runtime recovery claim expired"));
                    }
                    RuntimeBindingRecord ready =
                            bindingRepository.compareAndSet(latest,
                                    latest.withAttestation(lease, handle,
                                            now, now));
                    if (ready == null) {
                        return failed(unavailable("runtime_provision_fenced",
                                "Runtime recovery claim expired"));
                    }
                    liveBindings.put(ready.getBindingId(),
                            new LiveBinding(ready.getGeneration(), lease));
                    return CompletableFuture.completedFuture(
                            new BindingContext(ready, lease));
                });
    }

    /**
     * A binding whose Runtime is proven gone is reclaimed only while nothing
     * references its generation, so an active Session keeps pointing at the
     * loss instead of silently moving to a replacement Runtime.
     */
    private CompletionStage<BindingContext> reclaimLostBinding(
            RuntimeBindingRecord record, RuntimeProvisionRequest request) {
        if (sessionRepository.countActiveByBinding(record.getBindingId(),
                record.getGeneration()) > 0
                || executionRepository.hasActiveByBinding(
                        record.getBindingId(), record.getGeneration())) {
            return failed(unavailable("runtime_broker_runtime_lost",
                    "Managed Runtime no longer exists."));
        }
        RuntimeBindingRecord claimed = bindingRepository.claimOperation(
                record.getBindingId(), brokerOwnerId,
                operationLeaseDuration);
        if (claimed == null) {
            return failed(unavailable("runtime_binding_unavailable",
                    "Runtime binding is not available"));
        }
        if (claimed.getState() != RuntimeBindingRecord.State.LOST) {
            return failed(unavailable("runtime_binding_unavailable",
                    "Runtime binding is not available"));
        }
        RuntimeBindingRecord released = bindingRepository.compareAndSet(
                claimed, claimed.withState(
                        RuntimeBindingRecord.State.RELEASED,
                        claimed.getLease(), clock.instant()));
        releaseOperationQuietly(claimed.getBindingId(),
                claimed.getOperationGeneration());
        if (released == null) {
            return failed(unavailable("runtime_binding_unavailable",
                    "Runtime binding is not available"));
        }
        return ensureBinding(request);
    }

    private void blockRecovery(RuntimeBindingRecord claimed) {
        bindingRepository.compareAndSet(claimed, claimed.withState(
                RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                claimed.getLease(), clock.instant()));
    }

    private void blockRecovery(String bindingId, long operationGeneration) {
        RuntimeBindingRecord latest = bindingRepository.findById(bindingId);
        if (latest != null && ownsOperation(latest, operationGeneration)
                && latest.getState() == RuntimeBindingRecord.State.READY) {
            blockRecovery(latest);
        }
    }

    private boolean ownsOperation(RuntimeBindingRecord record,
            long operationGeneration) {
        return brokerOwnerId.equals(record.getOperationOwner())
                && record.getOperationGeneration() == operationGeneration;
    }

    private long operationDeadlineNanos() {
        long leaseNanos = operationLeaseDuration.toNanos();
        return leaseNanos > Long.MAX_VALUE / 4
                ? Long.MAX_VALUE : leaseNanos * 4;
    }

    private static boolean validAttestation(RuntimeAttestation attestation,
            RuntimeLease lease, RuntimeProvisionSeed seed,
            RuntimeProvisionRequest request) {
        return attestation != null
                && lease.getRuntimeInstanceId().equals(
                        attestation.getRuntimeInstanceId())
                && seed.getGatewayIncarnation().equals(
                        attestation.getRuntimeIncarnation())
                && lease.getLeaseId().equals(attestation.getLeaseId())
                && lease.getEpoch() == attestation.getEpoch()
                && request.getScope().equals(attestation.getScope())
                && seed.getProvisionRequestId().equals(
                        attestation.getProvisionRequestId());
    }

    private record DurableProvision(RuntimeLease lease,
            RuntimeResourceHandle handle) {
    }

    private record ReconcileStep(Kind kind, RuntimeObservation observation,
            RuntimeBrokerException error) {
        private enum Kind {
            RETRY,
            LOST,
            BLOCKED,
            READY
        }

        static ReconcileStep retry() {
            return new ReconcileStep(Kind.RETRY, null, null);
        }

        static ReconcileStep lost() {
            return new ReconcileStep(Kind.LOST, null, null);
        }

        static ReconcileStep blocked(RuntimeBrokerException error) {
            return new ReconcileStep(Kind.BLOCKED, null, error);
        }

        static ReconcileStep ready(RuntimeObservation observation) {
            return new ReconcileStep(Kind.READY, observation, null);
        }
    }

    private boolean isLiveBinding(RuntimeBindingRecord record) {
        LiveBinding live = liveBindings.get(record.getBindingId());
        return live != null && live.generation() == record.getGeneration()
                && record.getLease() != null
                && sameLease(live.lease(), record.getLease());
    }

    private BindingContext requireLiveBinding(RuntimeBindingRecord record) {
        if (!isLiveBinding(record)) {
            throw unavailable("runtime_reconciliation_required",
                    "persisted Runtime readiness requires adoption or "
                            + "reconciliation in this Broker process");
        }
        return new BindingContext(record,
                liveBindings.get(record.getBindingId()).lease());
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
        if (!provisioner.isUsable(context.lease())) {
            invalidateBinding(context.binding());
            markUnknown(executing.getExecutionCallId(),
                    executing.getDispatchGeneration());
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
        invocations.add(executing.getExecutionCallId());
        return safeStage(() -> transport.execute(context.lease(),
                context.session(), executing.getReference()))
                .<Void>handle((result, error) -> {
                    // Stop counting as running before the outcome is
                    // written, so a cancel that reads that outcome does not
                    // treat this finished invocation as still running.
                    invocations.remove(executing.getExecutionCallId());
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
        fenceLapsedClaim(current);
    }

    /**
     * Once a claim has lapsed, no compare-and-set can settle the record or
     * mark it UNKNOWN; the takeover fence in {@code claimDispatch} can still
     * mark it UNKNOWN. {@code claimDispatch} judges the lease by the
     * repository's clock and never writes over a live claim, whoever holds
     * it. A DISPATCHING record is left alone, since claiming it would hold a
     * dispatch nothing here is running.
     */
    private ToolExecutionRecord fenceLapsedClaim(ToolExecutionRecord current) {
        if (current == null
                || (current.getState() != ToolExecutionRecord.State.EXECUTING
                        && current.getState()
                                != ToolExecutionRecord.State
                                        .CANCEL_REQUESTED)) {
            return current;
        }
        // Only this broker's own live claim comes back; a settled or fenced
        // record, or another broker's live claim, yields null and is read
        // again.
        ToolExecutionRecord claimed = executionRepository.claimDispatch(
                current.getExecutionCallId(), brokerOwnerId,
                dispatchLeaseDuration);
        return claimed != null ? claimed : executionRepository
                .findByExecutionCallId(current.getExecutionCallId());
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
        } catch (RuntimeBrokerException exception) {
            if (!"runtime_execution_state_conflict".equals(
                    exception.getCode())) {
                throw exception;
            }
            // The Runtime settled the call after this claim lapsed; fence it
            // for reconciliation instead of reporting a state conflict. The
            // conflict stands only while the repository still holds the
            // claim live; a record another writer settled is returned.
            ToolExecutionRecord latest = fenceLapsedClaim(
                    executionRepository.findByExecutionCallId(
                            requested.getExecutionCallId()));
            if (latest == null || (!latest.isSettled()
                    && latest.getState()
                            != ToolExecutionRecord.State.UNKNOWN)) {
                throw exception;
            }
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

    /**
     * Retires a binding whose lease just failed liveness or attestation so
     * the next caller mints a fresh generation instead of retrying a dead
     * record forever. The retired lease is released so its worker stops
     * listening.
     */
    private void invalidateBinding(RuntimeBindingRecord record) {
        liveBindings.remove(record.getBindingId());
        if (record.getLease() != null) {
            releaseQuietly(record.getRequest(), record.getLease());
        }
        RuntimeBindingRecord claimed = bindingRepository.claimOperation(
                record.getBindingId(), brokerOwnerId, operationLeaseDuration);
        if (claimed != null) {
            failBinding(claimed);
        }
    }

    private void requireUsableLease(SessionContext context) {
        if (!provisioner.isUsable(context.lease())) {
            invalidateBinding(context.binding());
            throw unavailable("runtime_provision_failed",
                    "Managed Runtime process is not alive.");
        }
    }

    private void releaseQuietly(RuntimeProvisionRequest request,
            RuntimeLease lease) {
        try {
            provisioner.release(request, lease).whenComplete(
                    (ignored, error) -> {
                        // Best-effort teardown for a lease nobody will hold.
                    });
        } catch (RuntimeException ignored) {
            // Best-effort teardown for a lease nobody will hold.
        }
    }

    private void releaseOperationQuietly(String bindingId,
            long operationGeneration) {
        try {
            bindingRepository.releaseOperation(bindingId, brokerOwnerId,
                    operationGeneration);
        } catch (RuntimeException ignored) {
            // The claim lapses on its own when the release cannot be written.
        }
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
        provisioner.close();
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

    private RuntimeProvisionRequest provisionRequest(
            RuntimeScope scope, String harnessSessionId) {
        return new RuntimeProvisionRequest(scope,
                "session".equals(scope.getIsolationClass())
                        ? harnessSessionId : null,
                provisioner.kind());
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
        // The repository judges the lease: claimDispatch leaves a live claim
        // alone and fences a lapsed EXECUTING or CANCEL_REQUESTED record.
        return !record.isSettled()
                && record.getState() != ToolExecutionRecord.State.UNKNOWN;
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
