package com.alibaba.qwen.code.runtimebroker;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
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
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.locks.ReentrantLock;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;

/** Repository-backed orchestration for the private Managed Runtime contract. */
public final class RuntimeBrokerService implements AutoCloseable {
    // A cancellation answers with one of these states.
    private static final Set<String> RUNTIME_EXECUTION_STATES = Set.of(
            "prepared", "executing", "cancel_requested", "settled",
            "unknown");
    // A lookup answers with the same states as a cancellation.
    private static final Set<String> RUNTIME_STATUS_STATES = Set.of(
            "prepared", "executing", "cancel_requested", "settled",
            "unknown");
    // A lookup answer carries nothing but these fields.
    private static final Set<String> RUNTIME_STATUS_FIELDS = Set.of(
            "state", "result");
    // Only a failure that is evidence about identity may block the recovery of
    // a restored binding. Other non-retryable transport codes say nothing
    // about who is behind the endpoint - a throttle or an incompatible route
    // answers 429, 408 or 404, which the transport reports as a
    // non-retryable incompatibility - and blocking on those would wedge the
    // binding behind an operator until the transient condition is forgotten.
    private static final Set<String> IDENTITY_FAILURES = Set.of(
            "managed_runtime_identity_conflict",
            "managed_runtime_unauthorized");
    private static final int MAX_CAS_ATTEMPTS = 16;
    // A reclaim drains at most this many bounded 100-row passes per call;
    // a larger generation answers runtime_broker_runtime_lost and the next
    // reclaim resumes where this one stopped.
    private static final int MAX_RECOVERY_PASSES = 16;
    // An UNKNOWN record the Runtime just answered for is not asked again
    // inside this window; sequential observations share the one lookup.
    static final Duration UNKNOWN_LOOKUP_COOLDOWN =
            Duration.ofSeconds(1);
    /** Floor for {@code v3ResultWindow}: rejects a duration bound as milliseconds. */
    public static final Duration MIN_V3_RESULT_WINDOW = Duration.ofSeconds(1);
    private static final Duration DEFAULT_V3_RESULT_WINDOW =
            Duration.ofMinutes(30);

    private final HarnessSessionResolver sessionResolver;
    private final RuntimeProvisioner provisioner;
    private final RuntimeTransport transport;
    private final RuntimeBindingRepository bindingRepository;
    private final RuntimeSessionRepository sessionRepository;
    private final ToolExecutionRepository executionRepository;
    private final RuntimePublicationVerifier publicationVerifier;
    private final String brokerOwnerId;
    private final Duration operationLeaseDuration;
    private final Duration dispatchLeaseDuration;
    private final Duration v3ResultWindow;
    private final Clock clock;
    private final Supplier<String> executionIdSupplier;
    private final ScheduledExecutorService scheduler;
    private final ScheduledExecutorService renewalScheduler;
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
    private final ConcurrentMap<String,
            CompletableFuture<ExecutionReconciliation>> reconciliations =
                    new ConcurrentHashMap<>();
    private final ConcurrentMap<String, CooledObservation>
            unknownLookupCooldowns = new ConcurrentHashMap<>();

    public RuntimeBrokerService(HarnessSessionResolver sessionResolver,
            RuntimeProvisioner provisioner, RuntimeTransport transport,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository,
            String brokerOwnerId, Duration operationLeaseDuration,
            Duration dispatchLeaseDuration) {
        this(sessionResolver, provisioner, transport, bindingRepository,
                sessionRepository, executionRepository, brokerOwnerId,
                operationLeaseDuration, dispatchLeaseDuration, null,
                DEFAULT_V3_RESULT_WINDOW, Clock.systemUTC(),
                () -> UUID.randomUUID().toString(), newScheduler(),
                newRenewalScheduler());
    }

    public RuntimeBrokerService(HarnessSessionResolver sessionResolver,
            RuntimeProvisioner provisioner, RuntimeTransport transport,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository,
            String brokerOwnerId, Duration operationLeaseDuration,
            Duration dispatchLeaseDuration,
            RuntimePublicationVerifier publicationVerifier) {
        this(sessionResolver, provisioner, transport, bindingRepository,
                sessionRepository, executionRepository, brokerOwnerId,
                operationLeaseDuration, dispatchLeaseDuration, publicationVerifier,
                DEFAULT_V3_RESULT_WINDOW, Clock.systemUTC(),
                () -> UUID.randomUUID().toString(), newScheduler(),
                newRenewalScheduler());
    }

    public RuntimeBrokerService(HarnessSessionResolver sessionResolver,
            RuntimeProvisioner provisioner, RuntimeTransport transport,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository,
            String brokerOwnerId, Duration operationLeaseDuration,
            Duration dispatchLeaseDuration,
            RuntimePublicationVerifier publicationVerifier,
            Duration v3ResultWindow) {
        this(sessionResolver, provisioner, transport, bindingRepository,
                sessionRepository, executionRepository, brokerOwnerId,
                operationLeaseDuration, dispatchLeaseDuration, publicationVerifier,
                v3ResultWindow, Clock.systemUTC(),
                () -> UUID.randomUUID().toString(), newScheduler(),
                newRenewalScheduler());
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
                operationLeaseDuration, dispatchLeaseDuration, null,
                DEFAULT_V3_RESULT_WINDOW, clock, executionIdSupplier,
                newScheduler(), newRenewalScheduler());
    }

    private RuntimeBrokerService(HarnessSessionResolver sessionResolver,
            RuntimeProvisioner provisioner, RuntimeTransport transport,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository,
            String brokerOwnerId, Duration operationLeaseDuration,
            Duration dispatchLeaseDuration,
            RuntimePublicationVerifier publicationVerifier,
            Duration v3ResultWindow, Clock clock,
            Supplier<String> executionIdSupplier,
            ScheduledExecutorService scheduler,
            ScheduledExecutorService renewalScheduler) {
        if (sessionResolver == null || provisioner == null
                || transport == null || bindingRepository == null
                || sessionRepository == null || executionRepository == null
                || clock == null || executionIdSupplier == null
                || scheduler == null || renewalScheduler == null) {
            throw new IllegalArgumentException(
                    "service dependencies are required");
        }
        this.brokerOwnerId = BrokerValues.requireId(brokerOwnerId,
                "brokerOwnerId");
        this.operationLeaseDuration = requireDuration(
                operationLeaseDuration, "operationLeaseDuration");
        this.dispatchLeaseDuration = requireDuration(
                dispatchLeaseDuration, "dispatchLeaseDuration");
        this.v3ResultWindow = requireDuration(v3ResultWindow,
                "v3ResultWindow");
        if (this.v3ResultWindow.compareTo(MIN_V3_RESULT_WINDOW) < 0) {
            // A suffix-less duration config binds as milliseconds, so a
            // window meant as "30" minutes arrives as 30ms and would
            // silently degrade every v3 execution to UNKNOWN. Refuse values
            // below a floor no intended configuration lands under.
            throw new IllegalArgumentException(
                    "v3ResultWindow must be at least "
                            + MIN_V3_RESULT_WINDOW);
        }
        this.sessionResolver = sessionResolver;
        this.provisioner = provisioner;
        this.transport = transport;
        this.bindingRepository = bindingRepository;
        this.sessionRepository = sessionRepository;
        this.executionRepository = executionRepository;
        this.publicationVerifier = publicationVerifier;
        this.clock = clock;
        this.executionIdSupplier = executionIdSupplier;
        this.scheduler = scheduler;
        this.renewalScheduler = renewalScheduler;
    }

    public boolean supportsDrainedStop() {
        return provisioner.supportsDrainedStop();
    }

    public void requestHarnessDrain(String tenantId, String harnessSessionId) {
        requireOpen();
        bindingRepository.requestHarnessDrain(tenantId, harnessSessionId);
    }

    public CompletionStage<Void> drainHarnessSession(String tenantId, String harnessSessionId) {
        requireOpen();
        if (!bindingRepository.isHarnessDraining(tenantId, harnessSessionId)) {
            return failed(conflict("runtime_admission_closed", "A durable drain fence is required"));
        }
        return drainBindings(tenantId, harnessSessionId, null);
    }

    private CompletionStage<Void> drainBindings(String tenantId, String harnessSessionId, String cursor) {
        var batch = bindingRepository.findByHarnessSession(tenantId, harnessSessionId, cursor, 50);
        CompletionStage<Void> work = CompletableFuture.completedFuture(null);
        for (var binding : batch) {
            if (!tenantId.equals(binding.getRequest().getScope().getTenantId())
                    || !harnessSessionId.equals(binding.getRequest().getIsolationKey())) {
                return failed(conflict("workspace_close_identity_unverified", "Saved drain scope differs"));
            }
            work = work.thenCompose(ignored -> drainBinding(binding));
        }
        return work.thenCompose(ignored -> batch.size() < 50 ? CompletableFuture.completedFuture(null)
                : drainBindings(tenantId, harnessSessionId, batch.getLast().getBindingId()));
    }

    private CompletionStage<Void> drainBinding(RuntimeBindingRecord saved) {
        if (saved.getState() == RuntimeBindingRecord.State.RELEASED) {
            return CompletableFuture.completedFuture(null);
        }
        if (!saved.getRequest().isManagedContext() || !provisioner.supportsDrainedStop()
                || saved.getState() == RuntimeBindingRecord.State.OPERATOR_RECOVERY
                || saved.getState() == RuntimeBindingRecord.State.FAILED) {
            return failed(conflict("workspace_close_identity_unverified", "Original worker needs recovery"));
        }
        CompletableFuture<BindingContext> reservation = new CompletableFuture<>();
        if (bindingOperations.putIfAbsent(saved.getBindingId(), reservation) != null) {
            return failed(unavailable("runtime_close_claim_pending", "Original binding is still in use"));
        }
        return safeStage(() -> drainClaimedBinding(saved)).whenComplete((ignored, error) -> {
            bindingOperations.remove(saved.getBindingId(), reservation);
            reservation.completeExceptionally(unavailable("runtime_admission_closed", "Session is draining"));
        });
    }

    private CompletionStage<Void> drainClaimedBinding(RuntimeBindingRecord saved) {
        var claimed = bindingRepository.claimOperation(saved.getBindingId(), brokerOwnerId, operationLeaseDuration);
        if (claimed == null) {
            return failed(unavailable("runtime_close_claim_pending", "Original binding is still claimed"));
        }
        boolean lost = claimed.getState() == RuntimeBindingRecord.State.LOST;
        if (lost && (sessionRepository.countActiveByBinding(claimed.getBindingId(), claimed.getGeneration()) != 0
                || executionRepository.hasActiveByBinding(claimed.getBindingId(), claimed.getGeneration()))) {
            releaseOperationQuietly(claimed.getBindingId(), claimed.getOperationGeneration());
            return failed(conflict("workspace_close_execution_unsettled", "Lost Runtime resources require recovery"));
        }
        var draining = bindingRepository.compareAndSet(claimed, claimed.withDrainRequested(true, clock.instant())
                .withState(lost ? RuntimeBindingRecord.State.LOST : RuntimeBindingRecord.State.DRAINING,
                        claimed.getLease(), clock.instant()));
        if (draining == null) {
            releaseOperationQuietly(claimed.getBindingId(), claimed.getOperationGeneration());
            return failed(unavailable("runtime_close_claim_pending", "Drain claim changed"));
        }
        var renewal = new BindingRenewal(draining);
        renewal.start();
        CompletionStage<Void> result = safeStage(() ->
                // The sessions release — and their sweep of provably ended
                // background exits — run BEFORE the unsettled gate: a row the
                // sweep can prove never blocks the close on a stale active.
                drainSessions(draining, null).thenCompose(ignored -> {
                    if (sessionRepository.countActiveByBinding(draining.getBindingId(), draining.getGeneration()) != 0
                            || executionRepository.hasActiveByBinding(draining.getBindingId(), draining.getGeneration())) {
                        throw conflict("workspace_close_execution_unsettled", "Original resources are unsettled");
                    }
                    return draining.getDrainReceipt() == null ? provisioner.stopDrained(draining)
                            : CompletableFuture.completedFuture(draining.getDrainReceipt());
                }).thenAccept(receipt -> {
                    var current = renewal.stopAndGet();
                    if (current == null || bindingRepository.compareAndSet(current, current.withDrainReceipt(receipt)
                            .withState(RuntimeBindingRecord.State.RELEASED, current.getLease(), clock.instant())) == null) {
                        throw unavailable("runtime_close_claim_pending", "Drain completion was fenced");
                    }
                    liveBindings.remove(draining.getBindingId());
                }));
        return result.toCompletableFuture().orTimeout(operationDeadlineMillis(), TimeUnit.MILLISECONDS)
                .whenComplete((ignored, error) -> {
                    renewal.close();
                    releaseOperationQuietly(draining.getBindingId(), draining.getOperationGeneration());
                }).exceptionally(error -> {
                    throw mapStepTimeout(error);
                });
    }

    private CompletionStage<Void> drainSessions(RuntimeBindingRecord binding, String cursor) {
        var batch = sessionRepository.findByBinding(binding.getBindingId(), binding.getGeneration(), cursor, 100);
        CompletionStage<Void> work = CompletableFuture.completedFuture(null);
        for (var record : batch) {
            if (!record.isActive()) {
                continue;
            }
            work = work.thenCompose(ignored -> releaseSavedSession(binding, record));
        }
        return work.thenCompose(ignored -> batch.size() < 100 ? CompletableFuture.completedFuture(null)
                : drainSessions(binding, batch.getLast().getRuntimeSessionId()));
    }

    private CompletionStage<Void> releaseSavedSession(RuntimeBindingRecord binding, RuntimeSessionRecord record) {
        if (binding.getLease() == null || binding.getProvisionSeed() == null || binding.getResourceHandle() == null
                || !binding.getRequest().getIsolationKey()
                .equals(record.getSession().getHarnessSessionId())
                || !binding.getRequest().getScope().equals(record.getSession().getScope())) {
            return failed(conflict("workspace_close_identity_unverified", "Saved release identity is incomplete"));
        }
        CompletionStage<SessionContext> context = sessions.get(record.getRuntimeSessionId());
        if (context == null) {
            context = provisioner.reconcile(binding.getRequest(), binding.getProvisionSeed(),
                    binding.getResourceHandle(), binding.getLease()).thenApply(observation -> {
                        if (observation == null || observation.getOutcome() != RuntimeObservation.Outcome.READY
                                || !binding.getResourceHandle().equals(observation.getHandle())
                                || !binding.getLease().getRuntimeInstanceId().equals(observation.getRuntimeInstanceId())
                                || !binding.getLease().getLeaseId().equals(observation.getLeaseId())
                                || binding.getLease().getEpoch() != observation.getEpoch()
                                || !binding.getLease().getEndpoint().equals(observation.getEndpoint())) {
                            throw conflict("workspace_close_identity_unverified", "Original worker cannot be observed");
                        }
                        return new SessionContext(record.getSession(), binding, binding.getLease());
                    });
        }
        return context.thenCompose(original -> {
            if (!original.binding().getBindingId().equals(binding.getBindingId())
                    || original.binding().getGeneration() != binding.getGeneration()) {
                throw conflict("workspace_close_identity_unverified", "Release generation differs");
            }
            return releaseSession(original).thenAccept(released -> {
                if (!Boolean.TRUE.equals(released)) {
                    throw unavailable("runtime_session_release_failed", "Original Session has not released");
                }
            });
        }).exceptionallyCompose(error -> {
            Throwable cause = unwrap(error);
            if (cause instanceof RuntimeBrokerException failure && !failure.isRetryable()) {
                return failed(conflict("workspace_close_identity_unverified", "Original Session release cannot be confirmed", cause));
            }
            return failed(cause);
        });
    }

    public CompletionStage<RuntimeBindingRecord> warm(
            String harnessSessionId) {
        requireOpen();
        String harnessId = BrokerValues.requirePathSafe(
                BrokerValues.requireId(harnessSessionId, "harnessSessionId"),
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
        String harnessId = BrokerValues.requirePathSafe(
                BrokerValues.requireId(harnessSessionId, "harnessSessionId"),
                "harnessSessionId");
        String runtimeId = BrokerValues.requirePathSafe(
                BrokerValues.requireId(runtimeSessionId, "runtimeSessionId"),
                "runtimeSessionId");
        CompletableFuture<SessionContext> current = sessions.get(runtimeId);
        if (current != null) {
            return current.thenApply(context -> {
                context.lock();
                try {
                    requireSameSession(context.session(), new RuntimeSession(harnessId,
                            runtimeId, turnKind, context.session().getScope()));
                    return requireReadySessionRecord(context);
                } finally {
                    context.unlock();
                }
            });
        }
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
        if (!ManagedMcpProtocol.isOperation(immutable) && !ManagedHookProtocol.isOperation(immutable)) {
            ProviderRuntimeProtocol.control(immutable, harnessSessionId, runtimeSessionId);
        }
        return requireReadySession(harnessSessionId, runtimeSessionId)
                .thenCompose(context -> {
                    if (ManagedMcpProtocol.isOperation(immutable)) {
                        ManagedMcpProtocol.validateSession(context.session(), immutable);
                    }
                    if (ManagedHookProtocol.isOperation(immutable)) {
                        ManagedHookProtocol.validateSession(context.session(), immutable);
                    }
                    context.lock();
                    try {
                        requireReadySessionRecord(context);
                        context.beginControl();
                    } finally {
                        context.unlock();
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
        if (reference == null || reference.containsKey("dispatchMode")
                || reference.containsKey("payloadDigest")
                || reference.containsKey("publicationId")
                || reference.containsKey("runtimeProtocol")
                || reference.containsKey("inputDigest")
                || reference.containsKey("executionCallId")) {
            throw invalid("runtime_reference_invalid", "Execution reference contains reserved fields");
        }
        Map<String, Object> immutable;
        try {
            immutable = immutableMap(reference, "reference");
        } catch (RuntimeBrokerException invalidReference) {
            return CompletableFuture.failedFuture(invalidReference);
        }
        if (immutable.containsKey("invocationId") || immutable.containsKey("capabilityDigest")
                || immutable.containsKey("policyRevision")) {
            return CompletableFuture.failedFuture(invalid("runtime_reference_invalid",
                    "Prepared provider invocations require reserve and start"));
        }
        return createExecutionReceipt(harnessSessionId, runtimeSessionId, key, immutable, true);
    }

    public CompletionStage<ToolExecutionRecord> prepareExecution(
            String harnessSessionId, String runtimeSessionId,
            String idempotencyKey, Map<String, Object> reference) {
        return prepareExecution(harnessSessionId, runtimeSessionId,
                idempotencyKey, reference, null);
    }

    /** A v3 reservation keeps the raw payload digest distinct from canonical input. */
    public CompletionStage<ToolExecutionRecord> prepareExecution(
            String harnessSessionId, String runtimeSessionId,
            String idempotencyKey, Map<String, Object> reference,
            String payloadDigest) {
        return prepareExecution(harnessSessionId, runtimeSessionId,
                idempotencyKey, reference, payloadDigest, null);
    }

    public CompletionStage<ToolExecutionRecord> prepareExecution(
            String harnessSessionId, String runtimeSessionId,
            String idempotencyKey, Map<String, Object> reference,
            String payloadDigest, String publicationId) {
        requireOpen();
        String key = BrokerValues.requireId(idempotencyKey, "idempotencyKey");
        Map<String, Object> immutable = immutableMap(reference, "reference");
        if (ProviderRuntimeProtocol.isReference(immutable)) {
            ProviderRuntimeProtocol.reference(immutable, runtimeSessionId);
        } else {
            boolean v3 = Integer.valueOf(3).equals(immutable.get("runtimeProtocol"));
            if (v3 && payloadDigest != null) {
                throw invalid("runtime_reference_invalid", "Tool v3 publication modes conflict");
            }
            Set<String> fields = v3
                    ? Set.of("sessionId", "promptId", "callId", "argsDigest", "runtimeProtocol", "inputDigest")
                    : Set.of("sessionId", "promptId", "callId", "argsDigest");
            if (!immutable.keySet().equals(fields)
                    || !(immutable.get("argsDigest") instanceof String digest)
                    || !digest.matches("sha256:[0-9a-f]{64}")
                    || v3 && (!(immutable.get("inputDigest") instanceof String inputDigest)
                        || !inputDigest.matches("[0-9a-f]{64}"))) {
                throw invalid("runtime_reference_invalid", "Deferred execution reference is invalid");
            }
            Map<String, Object> deferred = new LinkedHashMap<>(immutable);
            if (payloadDigest == null) {
                deferred.put("dispatchMode", "deferred");
            } else {
                if (!payloadDigest.matches("sha256:[0-9a-f]{64}")
                        || publicationId == null
                        || !publicationId.matches("[a-z0-9_-]{1,128}")) {
                    throw invalid("runtime_reference_invalid", "Payload digest or publication ID is invalid");
                }
                deferred.put("dispatchMode", "deferred_v3");
                deferred.put("payloadDigest", payloadDigest);
                deferred.put("publicationId", publicationId);
            }
            try {
                immutable = Map.copyOf(deferred);
            } catch (NullPointerException nullValue) {
                // immutableMap admits null values; keep the rejection on the
                // stage channel as a 400 rather than a synchronous NPE.
                return CompletableFuture.failedFuture(invalid("runtime_reference_invalid",
                        "Deferred execution reference is invalid"));
            }
        }
        return createExecutionReceipt(harnessSessionId, runtimeSessionId, key, immutable, false);
    }

    public CompletionStage<ToolExecutionRecord> startExecution(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId, String payloadJson) {
        return startExecution(harnessSessionId, runtimeSessionId,
                executionCallId, payloadJson, null, null);
    }

    public CompletionStage<ToolExecutionRecord> startExecution(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId, String payloadJson,
            String publicationId, String publicationToken) {
        requireOpen();
        String executionId = BrokerValues.requireId(executionCallId, "executionCallId");
        CompletionStage<ToolExecutionRecord> started = requireReadySession(
                harnessSessionId, runtimeSessionId)
                .thenCompose(context -> {
                    context.lock();
                    try {
                        requireReadySessionRecord(context);
                        ToolExecutionRecord record = requireExecution(context, executionId);
                        boolean v3 = "deferred_v3".equals(record.getReference().get("dispatchMode"));
                        if (!"deferred".equals(record.getReference().get("dispatchMode")) && !v3) {
                            throw conflict("runtime_execution_conflict", "Execution was not reserved for deferred dispatch");
                        }
                        if (v3 && (publicationVerifier == null || publicationId == null
                                || publicationToken == null)) {
                            throw unavailable("runtime_execution_publication_required",
                                    "Tool v3 requires an installed publication before dispatch", null);
                        }
                        if (v3 && !publicationId.equals(record.getReference().get("publicationId"))) {
                            throw conflict("runtime_execution_conflict", "Original publication ID changed");
                        }
                        if (!v3 && (publicationId != null || publicationToken != null)) {
                            throw invalid("runtime_reference_invalid", "Tool v2 has no publication grant");
                        }
                        // The UTF-8 encoder would turn an unpaired surrogate into '?'.
                        if (payloadJson == null || !BrokerValues.isWellFormedJson(payloadJson)) {
                            throw invalid("runtime_payload_invalid", "Tool payload is invalid");
                        }
                        byte[] bytes = payloadJson.getBytes(StandardCharsets.UTF_8);
                        if (bytes.length > 256 * 1024) {
                            throw invalid("runtime_payload_invalid", "Tool payload exceeds 256 KiB");
                        }
                        String digest;
                        try {
                            digest = "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
                        } catch (NoSuchAlgorithmException exception) {
                            throw new IllegalStateException(exception);
                        }
                        if (!digest.equals(record.getRequestDigest())) {
                            throw conflict("runtime_idempotency_conflict", "Tool payload differs from its reserved digest");
                        }
                        Map<String, Object> payload = JsonCodec.parseObject(bytes, "tool payload");
                        // An escaped unpaired surrogate passes the text check above but
                        // would still reach the Worker, and run, as '?'.
                        if (!payload.keySet().equals(Set.of("toolName", "input"))
                                || !(payload.get("toolName") instanceof String toolName) || toolName.isEmpty()
                                || !(payload.get("input") instanceof Map)
                                || !BrokerValues.isWellFormedJson(payload)
                                || Integer.valueOf(3).equals(record.getReference().get("runtimeProtocol"))
                                    && !"run_shell_command".equals(toolName) && !"monitor".equals(toolName)) {
                            throw invalid("runtime_payload_invalid", "Tool payload is invalid");
                        }
                        if (v3) {
                            if (!"run_shell_command".equals(payload.get("toolName"))
                                    && !"monitor".equals(payload.get("toolName"))) {
                                throw invalid("runtime_payload_invalid", "Tool v3 requires Shell or Monitor");
                            }
                            RuntimePublicationGrant grant = publicationVerifier.verify(record,
                                    publicationId, publicationToken);
                            if (!shouldDriveDispatch(record)) {
                                return CompletableFuture.completedFuture(record);
                            }
                            requireUsableLease(context);
                            return mapFailure(safeStage(() -> transport.installPublication(
                                    context.lease(), context.session(), grant)),
                                    "runtime_publication_install_failed", "Publication installation failed")
                                    .thenApply(ignored -> {
                                        if (Boolean.TRUE.equals(((Map<?, ?>) payload.get("input")).get("is_background"))) {
                                            admitBackgroundProcess(context, record);
                                        }
                                        beginDispatch(context, record, payload, grant);
                                        ToolExecutionRecord latest = executionRepository.findByExecutionCallId(executionId);
                                        return latest == null ? record : latest;
                                    });
                        }
                        if (shouldDriveDispatch(record)) {
                            beginDispatch(context, record, payload);
                        }
                        ToolExecutionRecord latest = executionRepository.findByExecutionCallId(executionId);
                        return CompletableFuture.completedFuture(latest == null ? record : latest);
                    } finally {
                        context.unlock();
                    }
                });
        return unknownWhenAdmissionClosed(started, harnessSessionId,
                runtimeSessionId, executionId);
    }

    public CompletionStage<ToolExecutionRecord> startExecution(
            String harnessSessionId, String runtimeSessionId, String executionCallId) {
        requireOpen();
        String executionId = BrokerValues.requireId(executionCallId, "executionCallId");
        CompletionStage<ToolExecutionRecord> started = requireReadySession(
                harnessSessionId, runtimeSessionId)
                .thenApply(context -> {
                    context.lock();
                    try {
                        requireReadySessionRecord(context);
                        ToolExecutionRecord record = requireExecution(context, executionId);
                        if (!ProviderRuntimeProtocol.isReference(record.getReference())) {
                            throw invalid("runtime_payload_invalid", "Deferred execution requires payloadJson");
                        }
                        ProviderRuntimeProtocol.reference(record.getReference(), runtimeSessionId);
                        if (shouldDriveDispatch(record)) {
                            beginDispatch(context, record);
                        }
                        return requireExecution(context, executionId);
                    } finally {
                        context.unlock();
                    }
                });
        return unknownWhenAdmissionClosed(started, harnessSessionId,
                runtimeSessionId, executionId);
    }

    private CompletionStage<ToolExecutionRecord> createExecutionReceipt(
            String harnessSessionId, String runtimeSessionId, String key,
            Map<String, Object> reference, boolean dispatch) {
        return safeStage(() -> {
            ToolExecutionRecord receipt = executionRepository.findByIdempotencyKey(key);
            if (receipt != null && receipt.isTerminal()) {
                requireOwnedExecution(harnessSessionId, runtimeSessionId,
                        receipt.getExecutionCallId());
                if (!BrokerValues.sameJsonMap(receipt.getReference(),
                        immutableMap(reference, "reference"))) {
                    throw conflict("runtime_idempotency_conflict",
                            "idempotency key belongs to another request");
                }
                return CompletableFuture.completedFuture(receipt);
            }
            return requireReadySession(harnessSessionId, runtimeSessionId)
                    .thenApply(context -> createExecution(context, key, reference, dispatch));
        });
    }

    public CompletionStage<ToolExecutionRecord> getExecution(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId) {
        requireOpen();
        String executionId = BrokerValues.requireId(executionCallId,
                "executionCallId");
        return safeStage(() -> {
            ToolExecutionRecord saved = requireOwnedExecution(harnessSessionId,
                    runtimeSessionId, executionId);
            if (saved.isTerminal()) {
                return CompletableFuture.completedFuture(saved);
            }
            if ("deferred_v3".equals(saved.getReference().get("dispatchMode"))) {
                if (saved.getState() == ToolExecutionRecord.State.UNKNOWN
                        && publicationVerifier != null) {
                    Map<String, Object> durable = publicationVerifier.finished(saved);
                    if (durable != null) {
                        return CompletableFuture.completedFuture(absorbRuntimeStatus(saved,
                                Map.of("state", "settled", "result", durable), false).getRecord());
                    }
                }
            }
            return unknownWhenAdmissionClosed(
                    requireReadySession(harnessSessionId, runtimeSessionId)
                            .thenApply(context -> requireExecution(context,
                                    executionId)),
                    harnessSessionId, runtimeSessionId, executionId);
        });
    }

    public CompletionStage<Map<String, Object>> installPublisher(String harnessSessionId,
            String runtimeSessionId, Map<String, Object> publisher) {
        requireOpen();
        Map<String, Object> descriptor = immutableMap(publisher, "publisher");
        return requireReadySession(harnessSessionId, runtimeSessionId).thenCompose(context -> {
            context.lock();
            try {
                requireReadySessionRecord(context);
                context.beginControl();
            } finally {
                context.unlock();
            }
            return safeStage(() -> {
                requireUsableLease(context);
                return transport.installPublisher(context.lease(), context.session(), descriptor);
            }).thenApply(ignored -> Map.<String, Object>of("installed", true,
                    "bindingGeneration", Long.toString(context.binding().getGeneration())))
                    .whenComplete((ignored, error) -> context.endControl());
        });
    }

    private CompletionStage<Map<String, Object>> acknowledgeLocalExecution(String harnessSessionId,
            String runtimeSessionId, String executionCallId, Map<String, Object> receipt) {
        requireOpen();
        Map<String, Object> savedReceipt = immutableMap(receipt, "receipt");
        return requireReadySession(harnessSessionId, runtimeSessionId).thenCompose(context -> {
            ToolExecutionRecord record;
            context.lock();
            try {
                requireReadySessionRecord(context);
                record = requireExecution(context, executionCallId);
                if (!record.isSettled()
                        || !Integer.valueOf(3).equals(record.getReference().get("runtimeProtocol"))
                        || !record.getExecutionCallId().equals(savedReceipt.get("executionCallId"))) {
                    throw conflict("runtime_execution_conflict", "Only the original settled Tool v3 result can be acknowledged");
                }
                context.beginControl();
            } finally {
                context.unlock();
            }
            return safeStage(() -> {
                requireUsableLease(context);
                return transport.acknowledge(context.lease(), context.session(), record.getReference(), savedReceipt);
            }).thenApply(status -> {
                if (!"settled".equals(status.get("state"))) {
                    throw conflict("runtime_execution_conflict", "Runtime did not confirm the result acknowledgement");
                }
                return status;
            }).whenComplete((ignored, error) -> context.endControl());
        });
    }

    public CompletionStage<Map<String, Object>> acknowledgeExecution(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId, Map<String, Object> receipt) {
        requireOpen();
        String id = BrokerValues.requireId(executionCallId, "executionCallId");
        return requireReadySession(harnessSessionId, runtimeSessionId)
                .thenCompose(context -> {
                    ToolExecutionRecord execution = requireExecution(context, id);
                    if (!"deferred_v3".equals(execution.getReference().get("dispatchMode"))) {
                        return acknowledgeLocalExecution(harnessSessionId, runtimeSessionId, id, receipt);
                    }
                    context.lock();
                    try {
                        requireReadySessionRecord(context);
                        execution = requireExecution(context, id);
                        if (!execution.isSettled()
                                || !execution.getBindingId().equals(context.binding().getBindingId())
                                || execution.getRuntimeGeneration() != context.binding().getGeneration()
                                || publicationVerifier == null) {
                            throw conflict("runtime_execution_conflict", "Original Tool v3 execution is unavailable");
                        }
                        context.beginControl();
                    } finally {
                        context.unlock();
                    }
                    ToolExecutionRecord original = execution;
                    if (isDetachedCapture(original.getResult())) {
                        return mapFailure(safeStage(() -> {
                            // The detached family has no publication durable
                            // of its own: the settled handle envelope is
                            // canonical, and a matching blocked receipt
                            // acknowledges exactly it. The refuse-rides the
                            // stage so the control always ends with it.
                            if (receipt == null
                                    || !receipt.keySet().equals(Set.of("executionCallId",
                                            "manifest", "deliveryStatus", "historyRevision"))
                                    || !id.equals(receipt.get("executionCallId"))
                                    || receipt.get("manifest") != null
                                    || !"blocked".equals(receipt.get("deliveryStatus"))
                                    || receipt.get("historyRevision") != null) {
                                throw conflict("runtime_execution_conflict",
                                        "Session receipt conflicts with publication");
                            }
                            requireUsableLease(context);
                            return transport.acknowledgeV3(context.lease(),
                                    context.session(), original.getReference(),
                                    receipt);
                        }), "runtime_execution_ack_failed", "Tool v3 acknowledgement failed")
                            .whenComplete((ignored, error) -> context.endControl());
                    }
                    return mapFailure(safeStage(() -> {
                        Map<String, Object> saved = publicationVerifier.receipt(original);
                        if (saved == null || !sameReceipt(saved, receipt)) {
                            throw conflict("runtime_execution_conflict", "Session receipt conflicts with publication");
                        }
                        requireUsableLease(context);
                        return transport.acknowledgeV3(context.lease(), context.session(),
                                original.getReference(), saved);
                    }), "runtime_execution_ack_failed", "Tool v3 acknowledgement failed")
                            .whenComplete((ignored, error) -> context.endControl());
                });
    }

    private static boolean sameReceipt(Map<String, Object> expected,
            Map<String, Object> actual) {
        if (actual == null || !actual.keySet().equals(Set.of("executionCallId", "manifest",
                "deliveryStatus", "historyRevision"))
                || !java.util.Objects.equals(expected.get("executionCallId"), actual.get("executionCallId"))
                || !java.util.Objects.equals(expected.get("deliveryStatus"), actual.get("deliveryStatus"))) {
            return false;
        }
        Object leftRevision = expected.get("historyRevision");
        Object rightRevision = actual.get("historyRevision");
        if (leftRevision == null ? rightRevision != null
                : !(rightRevision instanceof Number number)
                        || ((Number) leftRevision).longValue() != number.longValue()) {
            return false;
        }
        Object left = expected.get("manifest");
        Object right = actual.get("manifest");
        if (left == null || right == null) {
            return left == right;
        }
        if (!(left instanceof Map<?, ?> saved) || !(right instanceof Map<?, ?> received)
                || !saved.keySet().equals(received.keySet())) {
            return false;
        }
        for (String field : List.of("resourceId", "kind", "digest")) {
            if (!java.util.Objects.equals(saved.get(field), received.get(field))) {
                return false;
            }
        }
        for (String field : List.of("schemaVersion", "byteLength")) {
            if (!(saved.get(field) instanceof Number a) || !(received.get(field) instanceof Number b)
                    || a.longValue() != b.longValue()) {
                return false;
            }
        }
        return true;
    }

    public CompletionStage<ToolExecutionRecord> cancelExecution(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId) {
        requireOpen();
        String executionId = BrokerValues.requireId(executionCallId,
                "executionCallId");
        return safeStage(() -> {
            OwnedExecution owned = requireOwnership(harnessSessionId,
                    runtimeSessionId, executionId);
            ToolExecutionRecord stored = owned.record();
            if (stored.isTerminal()) {
                if (!isPreparedProviderCancellation(stored)) {
                    return CompletableFuture.completedFuture(stored);
                }
                RuntimeBindingRecord binding = owned.binding();
                // Only a READY Session whose binding can still answer may hold
                // the worker's preparation; anywhere else the terminal receipt
                // stands alone, the same rule that lets Broker HTTP read
                // terminal receipts without a READY Session.
                if (owned.session().getState() != RuntimeSessionRecord.State.READY
                        || binding.getState() != RuntimeBindingRecord.State.READY
                                && binding.getState() != RuntimeBindingRecord.State.DRAINING) {
                    return CompletableFuture.completedFuture(stored);
                }
                // That worker may still hold the preparation, so the
                // cancellation is not acknowledged without its evidence. A
                // process without a live Session (a replaced Broker, or an
                // acquire still adopting) asks for adoption, as reconciliation
                // does; another Harness's Session under the same id stays a
                // conflict below.
                CompletableFuture<SessionContext> local = sessions.get(runtimeSessionId);
                if (local == null || !local.isDone() || local.isCompletedExceptionally()) {
                    throw unavailable("runtime_reconciliation_required",
                            "Runtime Session is not active in this Broker process; "
                                    + "acquire the Session again to confirm the cancellation");
                }
            }
            return unknownWhenAdmissionClosed(
                    requireReadySession(harnessSessionId, runtimeSessionId)
                    .thenCompose(context -> {
                        ToolExecutionRecord requested;
                        boolean publicationV3;
                        context.lock();
                        try {
                            requireReadySessionRecord(context);
                            ToolExecutionRecord current = requireExecution(
                                    context, executionId);
                            // A background process row never dispatches, so a
                            // cancel would settle it immediately — while its
                            // process provably runs. It settles only on the
                            // owner's stop evidence; stop goes through the
                            // maintenance route.
                            if ("background_v3_process".equals(
                                    current.getReference().get("dispatchMode"))) {
                                throw conflict("runtime_execution_conflict",
                                        "A background process settles only on stop evidence");
                            }
                            requested = requestCancel(current);
                            if (isPreparedProviderCancellation(requested)) {
                                context.beginControl();
                                return cancelPreparedProvider(context, requested);
                            }
                            publicationV3 = "deferred_v3".equals(
                                    requested.getReference().get("dispatchMode"));
                            // An UNKNOWN record may still have an invocation
                            // running in this process, or be one its original
                            // Runtime can still answer for; it gets the
                            // physical cancel below but is never settled from
                            // here.
                            if (requested.isTerminal()
                                    || (requested.getState()
                                            == ToolExecutionRecord.State.UNKNOWN
                                            && !invocations.contains(
                                                    executionId)
                                            && !publicationV3
                                            && !requested.observableAfterLoss())) {
                                return CompletableFuture.completedFuture(
                                        requested);
                            }
                        } finally {
                            context.unlock();
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
                        return mapFailure(safeStage(() ->
                                publicationV3
                                        ? transport.cancelV3(context.lease(), context.session(),
                                                requested.getReference()).thenApply(
                                                        RuntimeBrokerService::projectV3Status)
                                        : transport.cancel(context.lease(), context.session(),
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
                    }),
                    harnessSessionId, runtimeSessionId, executionId);
        });
    }

    private static boolean isPreparedProviderCancellation(ToolExecutionRecord record) {
        return record.isSettled() && record.isCancelRequested()
                && record.getDispatchGeneration() == 0
                && ProviderRuntimeProtocol.isReference(record.getReference());
    }

    private CompletionStage<ToolExecutionRecord> cancelPreparedProvider(
            SessionContext context, ToolExecutionRecord requested) {
        CompletableFuture<ToolExecutionRecord> result = new CompletableFuture<>();
        result.orTimeout(Math.max(1, operationLeaseDuration.toMillis()), TimeUnit.MILLISECONDS);
        observePreparedCancellation(context, requested, safeStage(() -> {
            requireUsableLease(context);
            return transport.cancel(context.lease(), context.session(), requested.getReference());
        }), result);
        return mapFailure(result, "runtime_execution_cancel_failed",
                "Runtime execution cancellation failed")
                .whenComplete((ignored, error) -> context.endControl());
    }

    private void observePreparedCancellation(SessionContext context, ToolExecutionRecord requested,
            CompletionStage<Map<String, Object>> observation, CompletableFuture<ToolExecutionRecord> completion) {
        observation.whenComplete((status, error) -> {
            if (completion.isDone()) {
                return;
            }
            if (error != null) {
                completion.completeExceptionally(error);
                return;
            }
            try {
                if (status != null && "settled".equals(status.get("state"))
                        && status.get("result") instanceof Map<?, ?> result
                        && ("cancelled".equals(result.get("executionStatus"))
                                || "not_started".equals(result.get("executionStatus")))) {
                    completion.complete(requested);
                } else if (status != null && ("prepared".equals(status.get("state"))
                        || "executing".equals(status.get("state"))
                        || "cancel_requested".equals(status.get("state")))) {
                    scheduler.schedule(() -> {
                        if (!completion.isDone()) {
                            observePreparedCancellation(context, requested, safeStage(() -> {
                                requireUsableLease(context);
                                return transport.status(context.lease(), context.session(),
                                        requested.getReference(), requested.getLastSequence());
                            }), completion);
                        }
                    }, 25, TimeUnit.MILLISECONDS);
                } else {
                    // unknown or an unexpected terminal answer can never
                    // become the confirmation, so a retry cannot converge;
                    // fail non-retryably rather than loop the same round
                    // trip. unknown never becomes not_started evidence.
                    Object state = status == null ? null : status.get("state");
                    throw new RuntimeBrokerException(409,
                            "runtime_execution_cancel_unconfirmed",
                            "unknown".equals(state)
                                    ? "Runtime no longer retains the prepared invocation"
                                    : "Runtime did not confirm prepared invocation cancellation",
                            false);
                }
            } catch (RuntimeException failure) {
                completion.completeExceptionally(failure);
            }
        });
    }

    /**
     * Asks the original Runtime once whether an {@code UNKNOWN} execution
     * settled, and settles the record only on that evidence. Any other
     * answer, and any failure, leaves it {@code UNKNOWN}. This never executes
     * or re-claims the dispatch, and it never retries: polling belongs to
     * the caller. A record that is not {@code UNKNOWN} is answered from the
     * repository before any Session or liveness check.
     */
    public CompletionStage<ExecutionReconciliation> reconcileExecution(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId) {
        requireOpen();
        String harnessId = BrokerValues.requireId(harnessSessionId,
                "harnessSessionId");
        String runtimeId = BrokerValues.requireId(runtimeSessionId,
                "runtimeSessionId");
        String executionId = BrokerValues.requireId(executionCallId,
                "executionCallId");
        return mapFailure(safeStage(() -> reconcile(harnessId, runtimeId,
                executionId)), "runtime_execution_reconcile_failed",
                "Runtime execution reconciliation failed");
    }

    /**
     * The HTTP face's automatic observation of an UNKNOWN execution: the
     * same evidence-only lookup as {@link #reconcileExecution}, except that
     * a lookup that just ran cools the execution for a short window, so
     * rapid polling shares the one answer instead of fanning every request
     * through to the worker (issue #13183 saw hundreds of status calls per
     * execution this way).
     */
    CompletionStage<ExecutionReconciliation> observeExecution(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId) {
        requireOpen();
        String harnessId = BrokerValues.requireId(harnessSessionId,
                "harnessSessionId");
        String runtimeId = BrokerValues.requireId(runtimeSessionId,
                "runtimeSessionId");
        String executionId = BrokerValues.requireId(executionCallId,
                "executionCallId");
        return mapFailure(safeStage(() -> reconcile(harnessId, runtimeId,
                executionId, true)), "runtime_execution_reconcile_failed",
                "Runtime execution reconciliation failed");
    }

    private CompletionStage<ExecutionReconciliation> reconcile(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId) {
        return reconcile(harnessSessionId, runtimeSessionId, executionCallId,
                false);
    }

    private CompletionStage<ExecutionReconciliation> reconcile(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId, boolean cooled) {
        ToolExecutionRecord unknown = requireOwnedExecution(harnessSessionId,
                runtimeSessionId, executionCallId);
        if (unknown.getState() != ToolExecutionRecord.State.UNKNOWN) {
            return CompletableFuture.completedFuture(notUnknown(unknown,
                    null));
        }
        if ("deferred_v3".equals(unknown.getReference().get("dispatchMode"))
                && publicationVerifier != null) {
            Map<String, Object> durable = publicationVerifier.finished(unknown);
            if (durable != null) {
                return CompletableFuture.completedFuture(absorbRuntimeStatus(unknown,
                        Map.of("state", "settled", "result", durable), false));
            }
        }
        CompletableFuture<SessionContext> local = sessions.get(
                runtimeSessionId);
        // Process-local Sessions are keyed by Runtime Session id alone, so a
        // Session another Harness holds under the same id is not a route.
        SessionContext context = local == null || !local.isDone()
                || local.isCompletedExceptionally() ? null : local.join();
        if (context == null || !context.session().getHarnessSessionId()
                .equals(harnessSessionId)) {
            // No attested route in this process yet: ask for adoption only
            // while the original generation could still answer.
            return persistedSession(harnessSessionId, runtimeSessionId)
                    .thenApply(ignored -> {
                        requireAnswerableBinding(unknown);
                        throw unavailable("runtime_reconciliation_required",
                                "Runtime Session is not active in this "
                                        + "Broker process; adopt its binding "
                                        + "and acquire the Session again");
                    });
        }
        return reconcileInContext(context, unknown, false, cooled);
    }

    private CompletionStage<ExecutionReconciliation> reconcileInContext(
            SessionContext context, ToolExecutionRecord unknown,
            boolean takeover) {
        return reconcileInContext(context, unknown, takeover, false);
    }

    private CompletionStage<ExecutionReconciliation> reconcileInContext(
            SessionContext context, ToolExecutionRecord unknown,
            boolean takeover, boolean cooled) {
        requireOpen();
        requireAnswerableBinding(unknown);
        context.lock();
        try {
            requireReadySessionRecord(context);
        } finally {
            context.unlock();
        }
        // Only the binding generation the execution was dispatched to,
        // reached through this process's attested lease, may answer.
        requireAnswerableBinding(unknown);
        // A Session keeps its binding generation for life, so a mismatch
        // means inconsistent records rather than something a retry fixes.
        if (!unknown.getBindingId().equals(context.binding().getBindingId())
                || unknown.getRuntimeGeneration()
                        != context.binding().getGeneration()) {
            throw conflict("runtime_execution_conflict",
                    "Runtime execution belongs to another Runtime "
                            + "generation");
        }
        if (!liveBindings.containsKey(context.binding().getBindingId())) {
            // Local invalidation revokes this route even if its persistent
            // fence failed. A new observation must establish recovery evidence.
            throw evidenceUnavailable();
        }
        if (!provisioner.isUsable(context.lease())) {
            // Same retirement as every other operation on a dead lease; the
            // original Runtime is gone, so no answer can come.
            invalidateBinding(context.binding());
            throw evidenceUnavailable();
        }
        // Adoption can re-register the binding at a different endpoint than
        // the one this Session was acquired with; that stale route must not be
        // used, so the lookup fails as runtime_reconciliation_required.
        requireLiveBinding(context.binding());
        return lookupOnce(context, unknown, takeover, cooled);
    }

    private CompletionStage<ExecutionReconciliation> lookupOnce(
            SessionContext context, ToolExecutionRecord unknown,
            boolean takeover, boolean cooled) {
        String executionId = unknown.getExecutionCallId();
        if (cooled) {
            CooledObservation cooledObservation =
                    unknownLookupCooldowns.get(executionId);
            if (cooledObservation != null
                    && clock.instant().isBefore(cooledObservation.deadline())) {
                ExecutionReconciliation cached =
                        cooledObservation.reconciliation();
                if (cached.getRecord().getState()
                        != ToolExecutionRecord.State.UNKNOWN) {
                    // The cached lookup settled or abandoned the record:
                    // replay it whole. Pairing its terminal answer with this
                    // caller's pre-settlement UNKNOWN snapshot would report
                    // a settled execution as unknown.
                    return CompletableFuture.completedFuture(cached);
                }
                // Both records are UNKNOWN here; serve the fresher of the
                // caller's snapshot and the lookup's own re-read (a cancel
                // can land between them), with the cached worker answer.
                ToolExecutionRecord freshest =
                        cached.getRecord().getVersion() > unknown.getVersion()
                                ? cached.getRecord() : unknown;
                return CompletableFuture.completedFuture(
                        new ExecutionReconciliation(freshest,
                                cached.getOutcome(),
                                cached.getRuntimeState()));
            }
        }
        CompletableFuture<ExecutionReconciliation> created =
                new CompletableFuture<>();
        CompletableFuture<ExecutionReconciliation> existing =
                reconciliations.putIfAbsent(executionId, created);
        if (existing != null) {
            return existing;
        }
        // Bridge into a future this service owns, so nothing the transport
        // returns or throws can leave the in-flight slot claimed, and bound
        // it so a hung transport call cannot hold the slot and every later
        // poll. Repository work afterwards relies on its own timeouts.
        CompletableFuture<Map<String, Object>> lookup =
                new CompletableFuture<>();
        try {
            CompletionStage<Map<String, Object>> query = safeStage(() ->
                    "deferred_v3".equals(unknown.getReference().get("dispatchMode"))
                            ? transport.statusV3(context.lease(), context.session(),
                                    unknown.getReference(), unknown.getLastSequence())
                                    .thenApply(RuntimeBrokerService::projectV3Status)
                            : transport.status(context.lease(), context.session(),
                                    unknown.getReference(), unknown.getLastSequence()));
            query
                    .whenComplete((status, error) -> {
                        if (error == null) {
                            lookup.complete(status);
                        } else {
                            lookup.completeExceptionally(error);
                        }
                    });
        } catch (RuntimeException | Error exception) {
            lookup.completeExceptionally(exception);
        }
        lookup.orTimeout(operationLeaseDuration.toMillis(),
                TimeUnit.MILLISECONDS);
        // Every caller, joined or not, maps failures in reconcileExecution.
        lookup.handle((status, error) -> {
            if (takeover) {
                requireOpen();
            }
            if (error != null) {
                if (takeover && !(unwrap(error) instanceof Error)) {
                    return new ExecutionReconciliation(unknown,
                            ExecutionReconciliation.Outcome.UNRESOLVED, null);
                }
                throw new CompletionException(unwrap(error));
            }
            try {
                return absorbRuntimeStatus(unknown, status, takeover);
            } catch (RuntimeBrokerException failure) {
                if (takeover && "runtime_execution_status_invalid".equals(failure.getCode())) {
                    return new ExecutionReconciliation(unknown,
                            ExecutionReconciliation.Outcome.UNRESOLVED, null);
                }
                throw failure;
            }
        })
                .whenComplete((reconciled, error) -> {
                    // An Error is not a lookup answer: both paths above
                    // refuse to downgrade one, so the cache must not either.
                    if (cooled && (error == null
                            || !(unwrap(error) instanceof Error))) {
                        // Stamp before dropping the in-flight slot, so no
                        // sequential observer can slip between them and fan
                        // through to the worker. A failed lookup cools as
                        // UNRESOLVED: the Runtime was just unreachable, and
                        // hammering it changes nothing.
                        stampUnknownLookupCooldown(executionId,
                                error == null ? reconciled
                                        : new ExecutionReconciliation(unknown,
                                                ExecutionReconciliation.Outcome
                                                        .UNRESOLVED, null));
                    }
                    reconciliations.remove(executionId, created);
                    if (error == null) {
                        created.complete(reconciled);
                    } else {
                        created.completeExceptionally(unwrap(error));
                    }
                });
        return created;
    }

    // A lookup that just ran is the freshest answer any sequential observer
    // can act on; without the cooldown every observation fans through to the
    // worker (issue #13183 saw hundreds of status calls per execution).
    private void stampUnknownLookupCooldown(String executionId,
            ExecutionReconciliation reconciliation) {
        Instant deadline = clock.instant().plus(UNKNOWN_LOOKUP_COOLDOWN);
        CooledObservation observation = new CooledObservation(reconciliation,
                deadline);
        unknownLookupCooldowns.put(executionId, observation);
        try {
            // The eviction consults the same clock as the deadline check, so
            // a service clock that moves differently from the scheduler's
            // wall time can never evict an entry its reads still consider
            // fresh.
            scheduler.schedule(() -> {
                if (!clock.instant().isBefore(observation.deadline())) {
                    unknownLookupCooldowns.remove(executionId, observation);
                }
            }, UNKNOWN_LOOKUP_COOLDOWN.toMillis(), TimeUnit.MILLISECONDS);
        } catch (RuntimeException ignored) {
            // A closing service keeps no cooldown state.
            unknownLookupCooldowns.remove(executionId, observation);
        }
    }

    private record CooledObservation(ExecutionReconciliation reconciliation,
            Instant deadline) {
    }

    private static Map<String, Object> projectV3Status(Map<String, Object> response) {
        Object state = response.get("state");
        if (!(state instanceof String name) || !RUNTIME_STATUS_STATES.contains(name)
                || "settled".equals(name) != (response.get("result") instanceof Map)) {
            throw conflict("runtime_execution_conflict", "Tool v3 returned an invalid status");
        }
        return "settled".equals(name)
                ? Map.of("state", name, "result", response.get("result"))
                : Map.of("state", name);
    }

    private CompletionStage<SessionContext> scanExecutions(SessionContext context,
            RuntimeSessionRecord session, String afterExecutionCallId) {
        requireOpen();
        List<ToolExecutionRecord> batch = executionRepository.findUnsettled(
                session, afterExecutionCallId, 100);
        CompletionStage<Void> scanned = CompletableFuture.completedFuture(null);
        for (ToolExecutionRecord candidate : batch) {
            // A timed-out lookup completes on the JVM's timeout thread;
            // the next repository read must not block that thread.
            scanned = scanned.thenComposeAsync(ignored -> {
                requireOpen();
                ToolExecutionRecord current = requireExecution(context, candidate.getExecutionCallId());
                return current.needsReconciliation()
                        ? reconcileInContext(context, current, true).thenApply(result -> null)
                        : CompletableFuture.completedFuture(null);
            });
        }
        // Yield between pages even when every status completes synchronously.
        return scanned.thenComposeAsync(ignored -> batch.size() < 100
                ? CompletableFuture.completedFuture(context)
                : scanExecutions(context, session,
                        batch.get(batch.size() - 1).getExecutionCallId()));
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
        return persistedSession(harnessSessionId, runtimeSessionId)
                .thenCompose(record -> {
                    if (record.getState()
                            == RuntimeSessionRecord.State.RELEASED) {
                        return CompletableFuture.completedFuture(true);
                    }
                    RuntimeBindingRecord binding = bindingRepository.findById(
                            record.getBindingId());
                    if ((record.getState() == RuntimeSessionRecord.State.ACQUIRING
                            || record.getState() == RuntimeSessionRecord.State.RELEASING)
                            && binding != null && binding.getGeneration() == record.getRuntimeGeneration()
                            && matchingLiveBinding(binding) != null) {
                        CompletableFuture<SessionContext> adopted = CompletableFuture.completedFuture(
                                new SessionContext(record.getSession(), binding, requireLiveBinding(binding).lease()));
                        boolean inserted = sessions.putIfAbsent(runtimeSessionId, adopted) == null;
                        return release(harnessSessionId, runtimeSessionId).whenComplete((released, error) -> {
                            if (inserted && (error != null || !Boolean.TRUE.equals(released))) {
                                sessions.remove(runtimeSessionId, adopted);
                            }
                        });
                    }
                    // A Broker that died mid-acquire or mid-release leaves the
                    // Session ACQUIRING or RELEASING; both pin a LOST
                    // generation, and neither can ever be confirmed by a
                    // Runtime that is proven gone.
                    if (record.isActive()
                            && binding != null
                            && binding.getState()
                                    == RuntimeBindingRecord.State.LOST
                            && binding.getGeneration()
                                    == record.getRuntimeGeneration()
                            && binding.hasStoppedWriters()
                            && !binding.getRequest().isManagedContext()
                            && !executionRepository.hasActiveByRuntimeSession(
                                    record.getBindingId(), record.getRuntimeGeneration(), runtimeSessionId)) {
                        RuntimeSessionRecord releasing = record;
                        if (releasing.getState()
                                != RuntimeSessionRecord.State.RELEASING) {
                            releasing = sessionRepository.compareAndSet(
                                    releasing, releasing.withState(
                                            RuntimeSessionRecord.State
                                                    .RELEASING,
                                            clock.instant()));
                        }
                        if (releasing != null) {
                            finishSessionRelease(releasing);
                            return CompletableFuture.completedFuture(true);
                        }
                    }
                    throw unavailable("runtime_reconciliation_required",
                            "Runtime Session is not active in this Broker "
                                    + "process");
                });
    }

    private CompletionStage<RuntimeSessionRecord> persistedSession(
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
            return record;
        });
    }

    private ToolExecutionRecord createExecution(SessionContext context,
            String idempotencyKey, Map<String, Object> reference, boolean dispatch) {
        ToolExecutionRecord record;
        context.lock();
        try {
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
                    referenceString(safeReference,
                            "deferred_v3".equals(safeReference.get("dispatchMode"))
                                    ? "payloadDigest" : "argsDigest"),
                    safeReference);
            // The JSON writer and the JDBC codec write an unpaired surrogate
            // as '?', so the Worker would run another tool name or input.
            if (!BrokerValues.isWellFormedJson(safeReference)) {
                throw invalid("runtime_reference_invalid",
                        "reference must be well-formed text");
            }
            try {
                record = bindingRepository.admitExecution(sessionRepository,
                        executionRepository, candidate);
            } catch (IllegalArgumentException exception) {
                throw conflict("runtime_execution_conflict",
                        "execution identity is already in use", exception);
            }
            if (!record.sameRequest(candidate)) {
                throw conflict("runtime_idempotency_conflict",
                        "idempotency key belongs to another request");
            }
        } finally {
            context.unlock();
        }
        if (dispatch && shouldDriveDispatch(record)) {
            beginDispatch(context, record);
        }
        ToolExecutionRecord current = executionRepository
                .findByExecutionCallId(record.getExecutionCallId());
        return current == null ? record : current;
    }

    // H3: the background process is its own ledger row, admitted at start,
    // carrying no model result and staying non-terminal until physical
    // proof — that is what `hasActiveBy*` counts while it lives.
    private void admitBackgroundProcess(SessionContext context,
            ToolExecutionRecord invocation) {
        context.lock();
        try {
            Map<String, Object> invocationReference = invocation.getReference();
            String callId = referenceString(invocationReference, "callId");
            Map<String, Object> reference = Map.of(
                    "dispatchMode", "background_v3_process",
                    "processOf", invocation.getExecutionCallId(),
                    "sessionId", referenceString(invocationReference, "sessionId"),
                    "promptId", referenceString(invocationReference, "promptId"),
                    "callId", callId,
                    "argsDigest", invocation.getRequestDigest());
            ToolExecutionRecord candidate = ToolExecutionRecord.prepared(
                    invocation.getExecutionCallId() + ":process",
                    invocation.getExecutionCallId() + ":process",
                    invocation.getBindingId(),
                    invocation.getRuntimeGeneration(),
                    invocation.getHarnessSessionId(),
                    invocation.getRuntimeSessionId(),
                    referenceString(invocationReference, "promptId"),
                    callId,
                    invocation.getRequestDigest(),
                    reference);
            try {
                bindingRepository.admitExecution(sessionRepository,
                        executionRepository, candidate);
            } catch (IllegalArgumentException exception) {
                throw conflict("runtime_execution_conflict",
                        "background process identity is already in use", exception);
            }
            context.backgroundProcesses().add(candidate.getExecutionCallId());
        } finally {
            context.unlock();
        }
    }

    /**
     * Asks the physical owner of a background process for status. An
     * exited answer settles the process row with that evidence; anything
     * else keeps the row active and its hold, exactly the wedge semantics
     * — a status that cannot be proven never becomes a claimed end.
     */
    public CompletionStage<ToolExecutionRecord> observeBackgroundProcess(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId) {
        requireOpen();
        String invocationId = BrokerValues.requireId(executionCallId,
                "executionCallId");
        return requireReadySession(harnessSessionId, runtimeSessionId)
                .thenCompose(context -> {
                    ToolExecutionRecord invocation = requireExecution(context, invocationId);
                    ToolExecutionRecord process = requireExecution(context, invocationId + ":process");
                    return observeProcessRow(context, invocation, process);
                });
    }

    private CompletionStage<ToolExecutionRecord> observeProcessRow(
            SessionContext context, ToolExecutionRecord invocation,
            ToolExecutionRecord process) {
        return controlProcessRow(context, invocation, process, "shell-status");
    }

    /**
     * One maintenance operation against a background process's physical
     * owner. An `exited` answer settles the row with that evidence —
     * terminal for both the status read and the stop the release asks
     * for, whose answer carries the same receipt view; anything else
     * keeps the row active and holding, exactly the wedge semantics.
     */
    private CompletionStage<ToolExecutionRecord> controlProcessRow(
            SessionContext context, ToolExecutionRecord invocation,
            ToolExecutionRecord process, String kind) {
        if (process.isTerminal()) {
            return CompletableFuture.completedFuture(process);
        }
        Map<String, Object> operation = new LinkedHashMap<>();
        operation.put("kind", kind);
        operation.put("sessionKey", Map.of(
                "tenantId", context.session().getScope().getTenantId(),
                "workspaceId", context.session().getScope().getWorkspaceId(),
                "sessionId", context.session().getHarnessSessionId()));
        operation.put("operationId", process.getExecutionCallId());
        operation.put("targetOperationId",
                referenceString(invocation.getReference(), "callId"));
        context.beginControl();
        return mapFailure(safeStage(() -> {
            requireUsableLease(context);
            return transport.control(context.lease(), context.session(),
                    operation);
        }), "runtime_shell_status_failed", "Shell status lookup failed")
            .thenApply(view -> {
                if (!(view instanceof Map<?, ?> answer)
                        || !"exited".equals(answer.get("state"))) {
                    return process;
                }
                settleBackgroundProcess(process, (Map<String, Object>) view);
                ToolExecutionRecord current = executionRepository
                        .findByExecutionCallId(process.getExecutionCallId());
                return current == null ? process : current;
            })
            .whenComplete((ignored, error) -> context.endControl());
    }

    /**
     * Before a release computes its busy check, every background process
     * row this Broker admitted for the Session asks its physical owner
     * once: a proven exit settles the row here, and anything else simply
     * keeps it — the busy answer then stands on what is actually still
     * running. A failed lookup moves on, because busy remains the accurate
     * answer for what could not be proven.
     */
    private CompletionStage<Void> settleUnprovenBackgroundRows(
            SessionContext context) {
        CompletionStage<Void> chain = CompletableFuture.completedFuture(null);
        List<String> processIds;
        List<ToolExecutionRecord> durable = durableBackgroundProcessRows(
                context);
        context.lock();
        try {
            for (ToolExecutionRecord row : durable) {
                context.backgroundProcesses().add(row.getExecutionCallId());
            }
            processIds = new ArrayList<>(context.backgroundProcesses());
        } finally {
            context.unlock();
        }
        for (String processId : processIds) {
            ToolExecutionRecord row = executionRepository
                    .findByExecutionCallId(processId);
            if (row == null || row.isTerminal()) {
                context.lock();
                try {
                    context.backgroundProcesses().remove(processId);
                } finally {
                    context.unlock();
                }
                continue;
            }
            ToolExecutionRecord invocation;
            try {
                invocation = requireExecution(context,
                        referenceString(row.getReference(), "processOf"));
            } catch (RuntimeException notOurs) {
                continue;
            }
            // Status first; a row the owner still counts running gets one
            // stop it must prove — an unproven stop keeps the hold, and
            // the busy answer behind it stays accurate.
            chain = chain.thenCompose(ignored -> observeProcessRow(
                    context, invocation, row)
                    .thenCompose(current -> current.isTerminal()
                            ? CompletableFuture.completedFuture(current)
                            : controlProcessRow(context, invocation, current,
                                    "shell-terminate"))
                    .thenCompose(current -> current.isTerminal()
                            ? CompletableFuture.completedFuture(current)
                            : observeProcessRow(context, invocation, current))
                    .thenApply(current -> {
                        if (current.isTerminal()) {
                            context.lock();
                            try {
                                context.backgroundProcesses().remove(processId);
                            } finally {
                                context.unlock();
                            }
                        }
                        return (Void) null;
                    })
                    .exceptionally(failure -> null));
        }
        return chain;
    }

    /**
     * The durable ledger knows every background process this Session was
     * ever admitted for; the in-memory index only knows the ones this
     * Broker process admitted itself. Without the backfill a fresh context
     * — every release path after a Broker restart — sweeps nothing, and
     * the non-terminal `:process` row answers busy forever. The scan stays
     * inside the repository's Session-and-generation fence, so a stale
     * cross-generation row never enters the sweep or the busy-check
     * exclusion set.
     */
    private List<ToolExecutionRecord> durableBackgroundProcessRows(
            SessionContext context) {
        RuntimeSessionRecord session = sessionRepository.findById(
                context.session().getScope(),
                context.session().getRuntimeSessionId());
        if (session == null) {
            return List.of();
        }
        List<ToolExecutionRecord> rows = new ArrayList<>();
        String after = null;
        for (;;) {
            List<ToolExecutionRecord> batch = executionRepository
                    .findBackgroundProcesses(session, after, 100);
            if (batch.isEmpty()) {
                return rows;
            }
            rows.addAll(batch);
            if (batch.size() < 100) {
                return rows;
            }
            after = batch.get(batch.size() - 1).getExecutionCallId();
        }
    }

    /**
     * The Runtime proved no process ever started: without this sibling
     * settle the `:process` row would count as alive forever, and no
     * shell release could ever pass busy again (round 6). Every arm that
     * settles the invocation with that proof — the dispatch poll, and the
     * reconcile resume — calls it, so no path back to SETTLED keeps the
     * sibling PREPARED.
     */
    private void settleUnstartedBackgroundSiblings(String executionCallId,
            Map<String, Object> result) {
        if (!"not_started".equals(result.get("executionStatus"))) {
            return;
        }
        ToolExecutionRecord process = executionRepository
                .findByExecutionCallId(executionCallId + ":process");
        if (process == null || process.isTerminal()) {
            return;
        }
        settleUnstartedBackgroundProcess(process, result);
    }

    private void settleUnstartedBackgroundProcess(ToolExecutionRecord process,
            Map<String, Object> result) {
        Map<String, Object> settled = new LinkedHashMap<>();
        settled.put("state", "not_started");
        settled.put("executionStatus", "not_started");
        settled.put("evidence", result.get("error"));
        for (int attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
            ToolExecutionRecord current = executionRepository
                    .findByExecutionCallId(process.getExecutionCallId());
            if (current == null || current.isTerminal()) {
                return;
            }
            if (executionRepository.settlePrepared(current, settled,
                    clock.instant()) != null) {
                return;
            }
        }
        throw conflict("runtime_execution_state_conflict",
                "Background process could not settle with its own generation");
    }

    private void settleBackgroundProcess(ToolExecutionRecord process,
            Map<String, Object> view) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("state", "exited");
        result.put("evidence", view.get("evidence"));
        Object exitCode = view.get("evidence") instanceof Map<?, ?> evidence
                ? evidence.get("exitCode") : null;
        result.put("executionStatus", Integer.valueOf(0).equals(exitCode)
                ? "success" : "error");
        for (int attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
            ToolExecutionRecord current = executionRepository
                    .findByExecutionCallId(process.getExecutionCallId());
            if (current == null || current.isTerminal()) {
                return;
            }
            if (executionRepository.settlePrepared(current, result,
                    clock.instant()) != null) {
                return;
            }
        }
        throw conflict("runtime_execution_state_conflict",
                "Background process could not settle with its own generation");
    }

    private CompletionStage<Boolean> releaseSession(
            SessionContext context) {
        RuntimeSessionRecord persisted = sessionRepository.findById(context.session().getScope(),
                context.session().getRuntimeSessionId());
        if (persisted != null && persisted.getState() == RuntimeSessionRecord.State.RELEASED) {
            sessions.remove(context.session().getRuntimeSessionId());
            return CompletableFuture.completedFuture(true);
        }
        RuntimeBindingRecord parent = bindingRepository.findById(context.binding().getBindingId());
        if (parent == null || parent.getGeneration() != context.binding().getGeneration()
                || parent.getState() != RuntimeBindingRecord.State.READY
                        && parent.getState() != RuntimeBindingRecord.State.DRAINING) {
            return failed(unavailable("runtime_reconciliation_required",
                    "Runtime release requires recovery of the original generation"));
        }
        if (!provisioner.isUsable(context.lease())) {
            if (parent.isDrainRequested()) {
                return failed(conflict("workspace_close_identity_unverified", "Original worker cannot release its Session"));
            }
            return releaseUnusableSession(context);
        }
        CompletableFuture<Boolean> attempt = new CompletableFuture<>();
        context.lock();
        try {
            if (context.releaseAttempt() != null) {
                return context.releaseAttempt();
            }
            context.releaseAttempt(attempt);
        } finally {
            context.unlock();
        }
        CompletionStage<Boolean> run = settleUnprovenBackgroundRows(context)
                .thenCompose(ignored -> releaseSessionAfterSweep(context));
        run.whenComplete((result, error) -> {
            if (error != null) {
                context.releaseAttempt(null);
                attempt.completeExceptionally(unwrap(error));
            } else {
                // A negative answer keeps the join but frees the latch, so
                // the next caller gets a fresh attempt, not this one.
                if (!Boolean.TRUE.equals(result)) {
                    context.releaseAttempt(null);
                }
                attempt.complete(result);
            }
        });
        return attempt;
    }

    private CompletionStage<Boolean> releaseSessionAfterSweep(
            SessionContext context) {
        boolean backgroundBusy;
        context.lock();
        try {
            if (context.release() != null) {
                return context.release();
            }
            if (context.hasActiveControl()
                    || executionRepository.hasActiveByRuntimeSession(
                            context.binding().getBindingId(), context.binding().getGeneration(),
                            context.session().getRuntimeSessionId(),
                            new java.util.HashSet<>(context.backgroundProcesses()))) {
                throw conflict("runtime_session_busy",
                        "Runtime Session has an active operation");
            }
            backgroundBusy = executionRepository.hasActiveByRuntimeSession(
                    context.binding().getBindingId(), context.binding().getGeneration(),
                    context.session().getRuntimeSessionId());
        } finally {
            context.unlock();
        }
        if (!backgroundBusy) {
            return completeSessionRelease(context);
        }
        // The sweep already issued each row's stop and settled every end
        // it could prove; what it could not prove keeps its hold — busy
        // is the accurate answer here, never a speculative teardown.
        return failed(conflict("runtime_session_busy",
                "Runtime Session has an active background process"));
    }

    private CompletionStage<Boolean> completeSessionRelease(
            SessionContext context) {
        CompletableFuture<Boolean> result;
        RuntimeSessionRecord releasing;
        context.lock();
        try {
            if (context.release() != null) {
                return context.release();
            }
            // Active executions are rejected inside the transition's own
            // transaction by beginSessionRelease; only the process-local
            // control check stays here.
            if (context.hasActiveControl()) {
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
        } finally {
            context.unlock();
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

    private CompletionStage<Boolean> releaseUnusableSession(SessionContext context) {
        invalidateBinding(context.binding());
        return failed(unavailable("runtime_reconciliation_required",
                "Runtime release requires durable proof that old writers stopped"));
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
            context.lock();
            try {
                requireSameSession(context.session(), session);
                return requireReadySessionRecord(context);
            } finally {
                context.unlock();
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
                stored = bindingRepository.admitSession(sessionRepository, candidate);
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
                return scanExecutions(context, stored, null);
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
                            Throwable cause = unwrap(error);
                            boolean invalidate = cause instanceof RuntimeBrokerException failure
                                    && IDENTITY_FAILURES.contains(failure.getCode());
                            if (!invalidate) {
                                try {
                                    invalidate = !provisioner.canRetryFailedConfirm(live.lease());
                                } catch (RuntimeException checkFailure) {
                                    cause.addSuppressed(checkFailure);
                                    invalidate = true;
                                }
                            }
                            try {
                                if (invalidate) {
                                    invalidateBinding(record);
                                }
                            } catch (RuntimeException invalidationFailure) {
                                cause.addSuppressed(invalidationFailure);
                            }
                            confirmed.completeExceptionally(cause);
                        }
                    });
            return confirmed;
        }
        if (record.getState() == RuntimeBindingRecord.State.LOST) {
            return reclaimLostBinding(record, request);
        }
        if (record.getState()
                == RuntimeBindingRecord.State.RECOVERY_BLOCKED) {
            if (provisioner.supportsStartupRecovery(record.getResourceHandle())) {
                return reconcileBinding(record);
            }
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
        if (seed == null || (request.isManagedContext()
                && claimed.getResourceHandle() != null
                && !provisioner.supportsStartupRecovery(claimed.getResourceHandle()))) {
            blockRecovery(claimed);
            releaseOperationQuietly(claimed.getBindingId(),
                    claimed.getOperationGeneration());
            return failed(conflict("runtime_broker_recovery_blocked",
                    "Managed Runtime recovery is blocked."));
        }
        RuntimeBindingRecord admitted;
        try {
            provisioner.reserveResource(claimed);
        } catch (RuntimeException failure) {
            boolean busy = failure instanceof RuntimeBrokerException brokerFailure && brokerFailure.isRetryable()
                    && ((request.isManagedContext() && brokerFailure.getStatusCode() == 409
                            && "workspace_csi_busy".equals(brokerFailure.getCode()))
                            || (!request.isManagedContext() && "kubernetes-scratch".equals(request.getProvisionerKind())
                                    && brokerFailure.getStatusCode() == 503
                                    && "runtime_kubernetes_capacity".equals(brokerFailure.getCode())));
            if (!busy) {
                blockRecoveryQuietly(claimed, failure);
            }
            releaseOperationQuietly(claimed.getBindingId(), claimed.getOperationGeneration());
            return failed(failure);
        }
        try {
            admitted = bindingRepository.renewOperation(claimed.getBindingId(), brokerOwnerId,
                    claimed.getOperationGeneration(), operationLeaseDuration);
        } catch (RuntimeException failure) {
            blockRecoveryQuietly(claimed, failure);
            releaseOperationQuietly(claimed.getBindingId(), claimed.getOperationGeneration());
            return failed(failure);
        }
        if (admitted == null) {
            releaseOperationQuietly(claimed.getBindingId(), claimed.getOperationGeneration());
            return failed(unavailable("runtime_provision_fenced", "Runtime provisioning claim expired"));
        }
        BindingRenewal renewal = new BindingRenewal(admitted);
        renewal.start();
        String bindingId = claimed.getBindingId();
        long operationGeneration = claimed.getOperationGeneration();
        CompletableFuture<BindingContext> operation =
                new CompletableFuture<>();
        // A non-retryable failure is answered as is. The failure handler
        // publishes it before it records the block, so a deadline that fires
        // after the failure keeps that answer.
        AtomicReference<RuntimeBrokerException> nonRetryable =
                new AtomicReference<>();
        // The deadline fires independently of provisioning progress, so a
        // parked ensureResource, provision or attestation call cannot hold
        // the binding open forever. Releasing the claim first fences any
        // late write from this operation.
        ScheduledFuture<?> deadlineTask;
        try {
            deadlineTask = scheduler.schedule(() -> {
                // Legacy startup keeps its timeout answer.
                RuntimeBrokerException failure = request.isManagedContext()
                        ? nonRetryable.get() : null;
                RuntimeBrokerException answer = failure != null ? failure
                        : unavailable("runtime_broker_provision_timeout",
                                "Managed Runtime provisioning timed out.");
                boolean blocked = false;
                try {
                    RuntimeBindingRecord timedOut = renewal.stopAndGet();
                    blocked = request.isManagedContext() && timedOut != null
                            && blockRecoveryQuietly(timedOut, answer);
                } finally {
                    releaseOperationQuietly(bindingId, operationGeneration);
                    // A retry cannot succeed once the binding is blocked.
                    operation.completeExceptionally(blocked && failure == null
                            ? conflict("runtime_broker_recovery_blocked",
                                    "Managed Runtime recovery is blocked.")
                            : answer);
                }
            }, operationDeadlineNanos(), TimeUnit.NANOSECONDS);
        } catch (RuntimeException scheduleFailure) {
            renewal.stopAndGet();
            releaseOperationQuietly(bindingId, operationGeneration);
            return failed(scheduleFailure);
        }
        mapFailure(safeStage(() -> provisioner.ensureResource(request,
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
                    if (!renewal.persistResourceHandle(handle)) {
                        throw unavailable("runtime_provision_fenced",
                                "Runtime provisioning claim expired");
                    }
                    return provisionAndAttest(request, seed)
                            .thenApply(lease -> new DurableProvision(lease,
                                    handle));
                })
                .handle((outcome, error) -> {
                    Throwable cause = unwrap(error);
                    // Published before taking the claim, which a renewal can
                    // hold across a database round trip.
                    if (cause instanceof RuntimeBrokerException failure
                            && !failure.isRetryable()) {
                        nonRetryable.set(failure);
                    }
                    RuntimeBindingRecord currentClaim = renewal.stopAndGet();
                    try {
                        if (error != null) {
                            boolean retryable = !(cause instanceof RuntimeBrokerException
                                    brokerFailure) || brokerFailure.isRetryable();
                            if (currentClaim != null) {
                                if (request.isManagedContext() || !retryable) {
                                    // A retry cannot succeed once the binding
                                    // is blocked, so say so.
                                    if (blockRecoveryQuietly(currentClaim, cause)
                                            && retryable) {
                                        throw conflict(
                                                "runtime_broker_recovery_blocked",
                                                "Managed Runtime recovery is blocked.",
                                                cause);
                                    }
                                } else if (currentClaim
                                        .getResourceHandle() == null) {
                                    blockRecoveryQuietly(currentClaim, cause);
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
                })
                .whenComplete((context, error) -> {
                    deadlineTask.cancel(false);
                    if (error == null) {
                        operation.complete(context);
                    } else {
                        operation.completeExceptionally(unwrap(error));
                    }
                });
        return operation;
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
                                    releaseQuietly(request, lease);
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
        safeStage(() -> startReconciliation(record)).whenComplete(
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

    private boolean canReconcile(RuntimeBindingRecord record) {
        return record.getState() == RuntimeBindingRecord.State.READY
                || ((record.getState() == RuntimeBindingRecord.State.PROVISIONING
                        || record.getState() == RuntimeBindingRecord.State.RECOVERY_BLOCKED)
                        && provisioner.supportsStartupRecovery(record.getResourceHandle()));
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
        if (!canReconcile(claimed)) {
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
        AtomicReference<ScheduledFuture<?>> deadlineTask =
                new AtomicReference<>();
        Runnable fence = () -> {
            renewal.close();
            releaseOperationQuietly(bindingId, operationGeneration);
            operation.completeExceptionally(reconcileTimeout());
        };
        // The reclaim keeps the claim alive with its own inline renewals,
        // so when the loop hands a lost binding over, the handoff gets a
        // fresh deadline window rather than the reconcile's remainder.
        Runnable rearmDeadline = () -> {
            ScheduledFuture<?> pending = deadlineTask.getAndSet(
                    scheduler.schedule(fence, operationDeadlineNanos(),
                            TimeUnit.NANOSECONDS));
            if (pending != null) {
                pending.cancel(false);
            }
        };
        try {
            deadlineTask.set(scheduler.schedule(fence,
                    operationDeadlineNanos(), TimeUnit.NANOSECONDS));
        } catch (RuntimeException scheduleFailure) {
            renewal.stopAndGet();
            releaseOperationQuietly(bindingId, operationGeneration);
            return failed(scheduleFailure);
        }
        reconcileLoop(bindingId, operationGeneration, renewal,
                System.nanoTime() + operationDeadlineNanos(), 0,
                rearmDeadline)
                .whenComplete((context, error) -> {
                    ScheduledFuture<?> pending = deadlineTask.getAndSet(null);
                    if (pending != null) {
                        pending.cancel(false);
                    }
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
            long deadlineNanos, int attempt, Runnable rearmDeadline) {
        if (System.nanoTime() >= deadlineNanos) {
            return failed(reconcileTimeout());
        }
        RuntimeBindingRecord current = bindingRepository.findById(bindingId);
        if (current == null || current.getOperationGeneration()
                != operationGeneration
                || !brokerOwnerId.equals(current.getOperationOwner())
                || !canReconcile(current)) {
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
                            return ReconcileStep.lost(observation);
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
                                return failed(reconcileTimeout());
                            }
                            long delay = Math.min(2_000,
                                    50L << Math.min(attempt, 6));
                            CompletableFuture<BindingContext> next =
                                    new CompletableFuture<>();
                            try {
                                scheduler.schedule(() -> reconcileLoop(
                                        bindingId, operationGeneration,
                                        renewal, deadlineNanos, attempt + 1,
                                        rearmDeadline)
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
                            // Stop the background ticks: the lease stays
                            // valid until its natural expiry and the reclaim
                            // path below renews it inline, so no renewal can
                            // invalidate the fresh CAS snapshots mid-write.
                            renewal.close();
                            // The reclaim may span several leases of its
                            // own; it gets a fresh deadline window instead
                            // of whatever the reconcile retries left over.
                            rearmDeadline.run();
                            RuntimeBindingRecord latest =
                                    bindingRepository.findById(bindingId);
                            if (latest == null || !ownsOperation(latest,
                                    operationGeneration)
                                    || !canReconcile(latest)) {
                                return failed(unavailable(
                                        "runtime_provision_fenced",
                                        "Runtime recovery claim expired"));
                            }
                            latest = renewRecoveryClaim(latest);
                            RuntimeBindingRecord lost =
                                    bindingRepository.compareAndSet(latest,
                                            latest.withRecoveryEvidence(
                                                    step.observation().getLossEvidence(),
                                                    step.observation().getStopEvidence(),
                                                    clock.instant()));
                            if (lost == null) {
                                return failed(unavailable(
                                        "runtime_provision_fenced",
                                        "Runtime recovery claim expired"));
                            }
                            return reclaimLostBindingNow(lost,
                                    lost.getRequest());
                        }
                        case BLOCKED:
                            blockRecovery(bindingId, operationGeneration);
                            return failed(step.error());
                        default:
                            // The loop's renewal owns claim liveness, so
                            // the transport's own timeout bounds attestation.
                            return adoptObservation(bindingId,
                                    operationGeneration, step.observation(), 0,
                                    renewal);
                    }
                });
    }

    private CompletionStage<BindingContext> adoptObservation(String bindingId,
            long operationGeneration, RuntimeObservation observation,
            long attestBoundMillis) {
        return adoptObservation(bindingId, operationGeneration, observation,
                attestBoundMillis, null);
    }

    private CompletionStage<BindingContext> adoptObservation(String bindingId,
            long operationGeneration, RuntimeObservation observation,
            long attestBoundMillis, BindingRenewal loopRenewal) {
        RuntimeBindingRecord current = bindingRepository.findById(bindingId);
        if (current == null || !ownsOperation(current, operationGeneration)
                || !canReconcile(current)) {
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
        CompletionStage<RuntimeAttestation> attesting =
                safeStage(() -> transport.attest(lease, request, seed));
        if (attestBoundMillis > 0) {
            // Only legs without a live renewal are bounded here; a caller
            // holding one (the reconcile loop) lets the transport's own
            // request timeout bound the call instead.
            attesting = attesting.toCompletableFuture().orTimeout(
                    attestBoundMillis, TimeUnit.MILLISECONDS)
                    .exceptionally(error -> {
                        throw mapStepTimeout(error);
                    });
        }
        return mapFailure(attesting, "runtime_broker_recovery_failed",
                "Managed Runtime attestation failed")
                .whenComplete((ignored, error) -> {
                    Throwable cause = unwrap(error);
                    if (cause instanceof RuntimeBrokerException failure
                            && IDENTITY_FAILURES.contains(failure.getCode())) {
                        blockRecovery(bindingId, operationGeneration);
                    }
                })
                .thenCompose(attestation -> {
                    if (!validAttestation(attestation, lease, seed,
                            request)) {
                        blockRecovery(bindingId, operationGeneration);
                        return failed(conflict(
                                "runtime_broker_attestation_conflict",
                                "Managed Runtime attestation conflicts."));
                    }
                    if (loopRenewal != null) {
                        // stop the loop's ticks (close() waits out one in
                        // flight) so the snapshot below CASes deterministically
                        loopRenewal.close();
                    }
                    Instant now = clock.instant();
                    RuntimeBindingRecord latest =
                            bindingRepository.findById(bindingId);
                    if (latest == null
                            || !ownsOperation(latest, operationGeneration)
                            || !canReconcile(latest)) {
                        return failed(unavailable("runtime_provision_fenced",
                                "Runtime recovery claim expired"));
                    }
                    latest = renewRecoveryClaim(latest);
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
     * Lost executions can be terminated by journal-loss evidence; releasing
     * their Sessions and placement additionally requires writer-stop proof.
     * Reclamation
     * is single-flighted with reconciliation on the same binding key; the
     * reconciliation loop calls the inner body directly because it already
     * holds that key.
     */
    private CompletionStage<BindingContext> reclaimLostBinding(
            RuntimeBindingRecord record, RuntimeProvisionRequest request) {
        CompletableFuture<BindingContext> created = new CompletableFuture<>();
        CompletableFuture<BindingContext> existing =
                bindingOperations.putIfAbsent(record.getBindingId(), created);
        if (existing != null) {
            return existing;
        }
        safeStage(() -> reclaimLostBindingNow(record, request)).whenComplete(
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

    private CompletionStage<BindingContext> reclaimLostBindingNow(
            RuntimeBindingRecord record, RuntimeProvisionRequest request) {
        RuntimeBindingRecord claimed = bindingRepository.claimOperation(
                record.getBindingId(), brokerOwnerId, operationLeaseDuration);
        if (claimed == null || claimed.getState() != RuntimeBindingRecord.State.LOST) {
            if (claimed != null) {
                releaseOperationQuietly(claimed.getBindingId(), claimed.getOperationGeneration());
            }
            return failed(unavailable("runtime_binding_unavailable", "Runtime binding is not available"));
        }
        return cleanupLost(claimed).whenComplete((ignored, error) -> releaseOperationQuietly(
                claimed.getBindingId(), claimed.getOperationGeneration())).thenCompose(recovered -> {
                    if (recovered.getState() != RuntimeBindingRecord.State.RELEASED) {
                        return failed(unavailable("runtime_broker_runtime_lost",
                                "Runtime is lost; recovery requires complete evidence and cleanup"));
                    }
                    liveBindings.remove(recovered.getBindingId());
                    return ensureBinding(request);
                });
    }

    private CompletionStage<RuntimeBindingRecord> cleanupLost(RuntimeBindingRecord claimed) {
        return safeStage(() -> {
            RuntimeBindingRecord recovered = recoverLostDrained(claimed,
                    false);
            if (recovered.getState() == RuntimeBindingRecord.State.RELEASED) {
                return CompletableFuture.completedFuture(recovered);
            }
            CompletionStage<RuntimeObservation> observation = recovered.hasStoppedWriters()
                    ? CompletableFuture.completedFuture(null)
                    : renewingStepOrNull(claimed, () -> {
                        // The claim may already be partly spent (e.g. the
                        // reconcile loop's last renewal tick), so stretch it
                        // before the provisioner call; a lapsed claim fails
                        // the renew below instead.
                        renewRecoveryClaim(claimed);
                        return provisioner.reconcile(recovered.getRequest(),
                                recovered.getProvisionSeed(), recovered.getResourceHandle(), recovered.getLease());
                    });
            return observation.thenCompose(observed -> {
                // Renew, never just re-read: the provisioner call above may
                // have run for most of the lease, and the guarded writes below
                // need the post-renewal snapshot to CAS deterministically.
                RuntimeBindingRecord latest = renewRecoveryClaim(claimed);
                if (observed != null && observed.getOutcome() == RuntimeObservation.Outcome.NOT_FOUND
                        && observed.getLossEvidence() != null) {
                    latest = bindingRepository.compareAndSet(latest, latest.withRecoveryEvidence(
                            observed.getLossEvidence(), observed.getStopEvidence(), clock.instant()));
                }
                if (latest == null) {
                    return failed(unavailable("runtime_provision_fenced", "Runtime recovery claim expired"));
                }
                RuntimeBindingRecord terminalized = recoverLostDrained(
                        claimed, false);
                if (terminalized.getState() == RuntimeBindingRecord.State.RELEASED
                        || !terminalized.hasStoppedWriters()
                        || executionRepository.hasActiveByBinding(terminalized.getBindingId(),
                                terminalized.getGeneration())) {
                    return CompletableFuture.completedFuture(terminalized);
                }
                // Renew between the transaction above and the destructive
                // step, and hand the provisioner the renewed record: its
                // version is what the stores match the cleanup against.
                RuntimeBindingRecord refreshed = renewRecoveryClaim(claimed);
                return renewingStep(claimed,
                        () -> provisioner.recoverResources(refreshed))
                        .thenApply(ignored -> recoverLostDrained(claimed,
                                true));
            });
        });
    }

    /**
     * Drives the bounded recovery passes until the LOST generation drains.
     * Each pass abandons at most 100 executions and releases at most 100
     * sessions in one transaction, so a single pass strands a larger
     * generation as still-LOST; the loop renews the claim between passes and
     * stops when nothing active remains or a pass could no longer make
     * progress, leaving the rest to the reclaim's next phase.
     */
    private RuntimeBindingRecord recoverLostDrained(
            RuntimeBindingRecord claimed, boolean finish) {
        // The measured baseline lets the stall check fire on the first pass;
        // the budget bounds the whole loop so a caller never waits out an
        // arbitrarily large drain — the next reclaim resumes where this one
        // stopped.
        long sessionsBefore = sessionRepository.countActiveByBinding(
                claimed.getBindingId(), claimed.getGeneration());
        RuntimeBindingRecord latest = claimed;
        for (int pass = 0; pass < MAX_RECOVERY_PASSES; pass++) {
            RuntimeBindingRecord renewed = renewRecoveryClaim(claimed);
            RuntimeBindingRecord next = finish
                    ? bindingRepository.finishLostRecovery(sessionRepository,
                            executionRepository, renewed)
                    : bindingRepository.recoverLost(sessionRepository,
                            executionRepository, renewed);
            if (next == null) {
                throw unavailable("runtime_provision_fenced",
                        "Runtime recovery claim expired");
            }
            latest = next;
            if (next.getState() != RuntimeBindingRecord.State.LOST) {
                return next;
            }
            if (next.getLossEvidence() == null) {
                // Without loss evidence a pass changes nothing at all; the
                // reclaim's observation phase gathers it next.
                return next;
            }
            long activeSessions = sessionRepository.countActiveByBinding(
                    next.getBindingId(), next.getGeneration());
            boolean executionsActive = executionRepository.hasActiveByBinding(
                    next.getBindingId(), next.getGeneration());
            if (activeSessions == 0 && !executionsActive) {
                return next;
            }
            // Abandoning executions is progress on its own; sessions only
            // drain once no active executions remain, so a stalled session
            // count ends the loop only when executions are already gone.
            if (!executionsActive && activeSessions >= sessionsBefore) {
                return next;
            }
            sessionsBefore = activeSessions;
        }
        return latest;
    }

    /**
     * Renews the caller's own recovery claim and returns the fresh record,
     * which the following guarded write must use as its expected snapshot.
     * Throws the fencing error when the claim genuinely expired or changed
     * hands.
     */
    private RuntimeBindingRecord renewRecoveryClaim(RuntimeBindingRecord claimed) {
        RuntimeBindingRecord renewed = bindingRepository.renewOperation(
                claimed.getBindingId(), brokerOwnerId,
                claimed.getOperationGeneration(), operationLeaseDuration);
        if (renewed == null) {
            throw unavailable("runtime_provision_fenced", "Runtime recovery claim expired");
        }
        return renewed;
    }

    /** The one identity for "the reconciliation ran out of time" — the fault-gate predicates key on it. */
    private static RuntimeBrokerException reconcileTimeout() {
        return unavailable("runtime_broker_reconcile_timeout",
                "Managed Runtime reconciliation timed out.");
    }

    /** Whether a step failure is the step bound cutting it short. */
    private static boolean isStepTimeout(Throwable error) {
        return unwrap(error) instanceof TimeoutException;
    }

    /**
     * Names a step the cleanup bound cut short, so callers see a named,
     * retryable reconcile timeout rather than a raw {@link TimeoutException};
     * any other failure passes through unchanged.
     */
    private RuntimeException mapStepTimeout(Throwable error) {
        if (isStepTimeout(error)) {
            return reconcileTimeout();
        }
        return error instanceof RuntimeException runtime
                ? runtime : new CompletionException(error);
    }

    /**
     * Runs one provisioner step under its own renewal, so the step may take
     * as long as the provisioner's declared waits — well past one lease —
     * without the claim lapsing. The bound is only the backstop for a
     * provisioner that never answers: half the operation deadline, which at
     * the production lease comfortably exceeds every shipped callee timeout.
     * The renewal stops when the step settles, so the inline renewal after
     * the step again sees no ticks and its fresh snapshot CASes
     * deterministically.
     */
    private <T> CompletionStage<T> renewingStep(RuntimeBindingRecord claimed,
            Supplier<CompletionStage<T>> step) {
        BindingRenewal renewal = new BindingRenewal(claimed);
        renewal.start();
        return safeStage(step).toCompletableFuture()
                .orTimeout(stepCallTimeoutMillis(), TimeUnit.MILLISECONDS)
                .whenComplete((value, error) -> renewal.close())
                .exceptionally(error -> {
                    throw mapStepTimeout(error);
                });
    }

    /**
     * The observation-leg variant: a step cut short by our own bound is not
     * "the provisioner observed nothing" and is named, but any other failure
     * still degrades to no observation, as before.
     */
    private <T> CompletionStage<T> renewingStepOrNull(
            RuntimeBindingRecord claimed, Supplier<CompletionStage<T>> step) {
        BindingRenewal renewal = new BindingRenewal(claimed);
        renewal.start();
        return safeStage(step).toCompletableFuture()
                .orTimeout(stepCallTimeoutMillis(), TimeUnit.MILLISECONDS)
                .whenComplete((value, error) -> renewal.close())
                .exceptionally(error -> {
                    if (isStepTimeout(error)) {
                        throw mapStepTimeout(error);
                    }
                    return null;
                });
    }

    /** Trusted maintenance of the saved generation; never resolves current authorization or provisions a replacement. */
    public CompletionStage<RuntimeBindingRecord> recoverBinding(String bindingId, long expectedGeneration) {
        requireOpen();
        RuntimeBindingRecord record = bindingRepository.findById(bindingId);
        if (record == null || record.getGeneration() != expectedGeneration
                || !provisioner.kind().equals(record.getRequest().getProvisionerKind())) {
            return failed(conflict("runtime_broker_recovery_blocked", "Saved Runtime recovery is unavailable"));
        }
        // Close owns retirement after journal settlement. Observing its retired
        // registration as journal loss would erase the clean-stop boundary.
        if (record.getState() != RuntimeBindingRecord.State.LOST
                && "session".equals(record.getRequest().getScope().getIsolationClass())
                && bindingRepository.isHarnessDraining(record.getRequest().getScope().getTenantId(),
                        record.getRequest().getIsolationKey())) {
            return CompletableFuture.completedFuture(record);
        }
        if (!provisioner.supportsStartupRecovery(record.getResourceHandle())) {
            return failed(conflict("runtime_broker_recovery_blocked", "Saved Runtime recovery is unavailable"));
        }
        if (!record.isActive()) {
            return CompletableFuture.completedFuture(record);
        }
        CompletableFuture<BindingContext> reservation = new CompletableFuture<>();
        AtomicReference<BindingContext> adopted = new AtomicReference<>();
        if (bindingOperations.putIfAbsent(bindingId, reservation) != null) {
            return failed(unavailable("runtime_reconcile_in_progress", "Runtime recovery is already in progress"));
        }
        RuntimeBindingRecord claimed;
        try {
            claimed = bindingRepository.claimOperation(bindingId, brokerOwnerId, operationLeaseDuration);
        } catch (RuntimeException error) {
            bindingOperations.remove(bindingId, reservation);
            reservation.completeExceptionally(error);
            return failed(error);
        }
        CompletionStage<RuntimeBindingRecord> operation = safeStage(() -> {
            if (claimed == null || claimed.getGeneration() != expectedGeneration) {
                return failed(unavailable("runtime_reconcile_in_progress", "Another Broker owns Runtime recovery"));
            }
            if (claimed.getState() != RuntimeBindingRecord.State.LOST
                    && "session".equals(claimed.getRequest().getScope().getIsolationClass())
                    && bindingRepository.isHarnessDraining(claimed.getRequest().getScope().getTenantId(),
                            claimed.getRequest().getIsolationKey())) {
                return CompletableFuture.completedFuture(claimed);
            }
            if (claimed.getState() == RuntimeBindingRecord.State.LOST) {
                return cleanupLost(claimed);
            }
            if (!canReconcile(claimed) && claimed.getState() != RuntimeBindingRecord.State.DRAINING) {
                return failed(conflict("runtime_broker_recovery_blocked", "Saved Runtime cannot be observed"));
            }
            return renewingStep(claimed, () -> provisioner.reconcile(claimed.getRequest(), claimed.getProvisionSeed(),
                    claimed.getResourceHandle(), claimed.getLease()))
                    .thenCompose(observed -> {
                        RuntimeBindingRecord current = renewRecoveryClaim(claimed);
                        if (observed == null) {
                            return CompletableFuture.completedFuture(current);
                        }
                        if (observed.getOutcome() == RuntimeObservation.Outcome.NOT_FOUND
                                && observed.getLossEvidence() != null) {
                            RuntimeBindingRecord lost = bindingRepository.compareAndSet(current,
                                    current.withRecoveryEvidence(observed.getLossEvidence(),
                                            observed.getStopEvidence(), clock.instant()));
                            return lost == null
                                    ? failed(unavailable("runtime_provision_fenced", "Runtime recovery claim expired"))
                                    : cleanupLost(lost);
                        }
                        if (observed.getOutcome() == RuntimeObservation.Outcome.READY
                                && current.getState() != RuntimeBindingRecord.State.DRAINING) {
                            return adoptObservation(bindingId, claimed.getOperationGeneration(), observed,
                                    cleanupStepTimeoutMillis())
                                    .thenApply(context -> {
                                        adopted.set(context);
                                        return context.record();
                                    });
                        }
                        if (observed.getOutcome() == RuntimeObservation.Outcome.CONFLICT) {
                            blockRecovery(current);
                        }
                        return CompletableFuture.completedFuture(bindingRepository.findById(bindingId));
                    });
        });
        // The inner steps are each bounded and the claim is renewed between
        // them, so the chain can legitimately span more than one lease; the
        // outer backstop uses the same 4x deadline as reconciliation instead
        // of cutting a healthy chain at exactly one lease.
        return operation.toCompletableFuture().orTimeout(operationDeadlineMillis(), TimeUnit.MILLISECONDS)
                .whenComplete((recovered, error) -> {
                    if (claimed != null) {
                        releaseOperationQuietly(bindingId, claimed.getOperationGeneration());
                    }
                    if (recovered != null && recovered.getState() == RuntimeBindingRecord.State.RELEASED) {
                        liveBindings.remove(bindingId);
                    }
                    bindingOperations.remove(bindingId, reservation);
                    BindingContext healthy = error == null ? adopted.get() : null;
                    if (healthy != null) {
                        reservation.complete(healthy);
                    } else {
                        reservation.completeExceptionally(unavailable("runtime_reconciliation_required",
                                "Maintenance observation completed; retry using current authorization"));
                    }
                });
    }

    private boolean blockRecovery(RuntimeBindingRecord claimed) {
        return bindingRepository.compareAndSet(claimed, claimed.withState(
                RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                claimed.getLease(), clock.instant())) != null;
    }

    /**
     * Blocks recovery and answers whether the binding is now blocked. The
     * deadline and the failure handler hold the same claim, so the one that
     * writes second finds the block already there. A write or read that
     * fails answers false, and the failure is kept on {@code cause}.
     */
    private boolean blockRecoveryQuietly(RuntimeBindingRecord claimed,
            Throwable cause) {
        try {
            if (blockRecovery(claimed)) {
                return true;
            }
            RuntimeBindingRecord latest = bindingRepository.findById(
                    claimed.getBindingId());
            return latest != null && latest.getState()
                    == RuntimeBindingRecord.State.RECOVERY_BLOCKED;
        } catch (RuntimeException failure) {
            cause.addSuppressed(failure);
            return false;
        }
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

    private long operationDeadlineMillis() {
        return Math.max(1, operationDeadlineNanos() / 1_000_000);
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
                && java.util.Objects.equals(request.getStorageId(),
                        attestation.getStorageId())
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

        static ReconcileStep lost(RuntimeObservation observation) {
            return new ReconcileStep(Kind.LOST, observation, null);
        }

        static ReconcileStep blocked(RuntimeBrokerException error) {
            return new ReconcileStep(Kind.BLOCKED, null, error);
        }

        static ReconcileStep ready(RuntimeObservation observation) {
            return new ReconcileStep(Kind.READY, observation, null);
        }
    }

    private LiveBinding matchingLiveBinding(RuntimeBindingRecord record) {
        LiveBinding live = liveBindings.get(record.getBindingId());
        return live != null && live.generation() == record.getGeneration()
                && record.getLease() != null
                && sameLease(live.lease(), record.getLease()) ? live : null;
    }

    private boolean isLiveBinding(RuntimeBindingRecord record) {
        return matchingLiveBinding(record) != null;
    }

    private BindingContext requireLiveBinding(RuntimeBindingRecord record) {
        LiveBinding live = matchingLiveBinding(record);
        if (live == null) {
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

    private void beginDispatch(SessionContext context,
            ToolExecutionRecord prepared) {
        beginDispatch(context, prepared, null);
    }

    private void beginDispatch(SessionContext context,
            ToolExecutionRecord prepared, Map<String, Object> payload) {
        beginDispatch(context, prepared, payload, null);
    }

    private void beginDispatch(SessionContext context,
            ToolExecutionRecord prepared, Map<String, Object> payload,
            RuntimePublicationGrant grant) {
        if (payload == null && ("deferred".equals(prepared.getReference().get("dispatchMode"))
                || "deferred_v3".equals(prepared.getReference().get("dispatchMode")))
                && !prepared.isCancelRequested()) {
            throw conflict("runtime_execution_conflict", "Deferred execution requires its original payload");
        }
        CompletableFuture<Void> created = new CompletableFuture<>();
        CompletableFuture<Void> existing = dispatches.putIfAbsent(
                prepared.getExecutionCallId(), created);
        if (existing != null) {
            return;
        }
        CompletionStage<Void> operation;
        try {
            operation = dispatch(context, prepared, payload, grant);
        } catch (RuntimeException | Error exception) {
            dispatches.remove(prepared.getExecutionCallId(), created);
            created.completeExceptionally(exception);
            if (exception instanceof RuntimeBrokerException refused) {
                throw refused;
            }
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
            ToolExecutionRecord prepared, Map<String, Object> payload,
            RuntimePublicationGrant grant) {
        ToolExecutionRecord claimed = executionRepository.claimDispatch(
                prepared.getExecutionCallId(), brokerOwnerId,
                dispatchLeaseDuration);
        if (claimed == null
                || claimed.getState()
                        != ToolExecutionRecord.State.DISPATCHING) {
            return CompletableFuture.completedFuture(null);
        }
        ToolExecutionRecord executing = enterExecuting(claimed);
        if (executing == null || executing.isTerminal()
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
        CompletionStage<Map<String, Object>> invocation = grant == null
                ? safeStage(() -> payload == null
                        ? transport.execute(context.lease(), context.session(), executing.getReference())
                        : transport.execute(context.lease(), context.session(), dispatchReference(executing), payload))
                : safeStage(() -> transport.executeV3(context.lease(), context.session(),
                        executing.getReference(), payload, capture(grant)))
                        .handle((answer, error) -> {
                            if (nonRetryableToolV3(error)) {
                                throw new CompletionException(unwrap(error));
                            }
                            if (error == null && answer != null
                                    && "settled".equals(answer.get("state"))
                                    && answer.get("result") instanceof Map<?, ?> result
                                    && "not_started".equals(result.get("executionStatus"))) {
                                @SuppressWarnings("unchecked")
                                Map<String, Object> notStarted = (Map<String, Object>) result;
                                return notStarted;
                            }
                            return null;
                        })
                        .thenCompose(notStarted -> notStarted != null
                                ? CompletableFuture.completedFuture(notStarted)
                                : awaitV3Result(context, executing,
                                        clock.instant().plus(v3ResultWindow)));
        return invocation
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
                        settleUnstartedBackgroundSiblings(
                                executing.getExecutionCallId(), result);
                    } catch (RuntimeException exception) {
                        markUnknown(executing.getExecutionCallId(),
                                executing.getDispatchGeneration());
                    }
                    return null;
                }).whenComplete((ignored, error) -> renewal.close());
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> capture(RuntimePublicationGrant grant) {
        Map<String, Object> binding = grant.binding();
        Map<String, Object> key = (Map<String, Object>) binding.get("sessionKey");
        return Map.of("tenantId", key.get("tenantId"), "sessionId", key.get("sessionId"),
                "turnId", binding.get("turnId"), "executionCallId", binding.get("executionCallId"),
                "bindingGeneration", binding.get("bindingGeneration"),
                "capturePolicy", "complete_required");
    }

    private CompletionStage<Map<String, Object>> awaitV3Result(SessionContext context,
            ToolExecutionRecord original, Instant deadline) {
        CompletableFuture<Map<String, Object>> result = new CompletableFuture<>();
        pollV3Result(context, original, deadline, result, 0);
        return result;
    }

    /**
     * The v3 result-poll backoff: 100ms doubling, capped at 2s. The cap
     * bounds the scheduled delay between rounds for one execution; rounds
     * for all executions share the single coordination thread, so pick-up
     * lateness under concurrency also carries that thread's queue wait.
     */
    static long v3PollDelayMillis(int attempt) {
        return Math.min(2_000, 100L << Math.min(attempt, 6));
    }

    private void pollV3Result(SessionContext context, ToolExecutionRecord original,
            Instant deadline, CompletableFuture<Map<String, Object>> answer,
            int attempt) {
        if (answer.isDone()) {
            return;
        }
        try {
            Map<String, Object> finished = publicationVerifier.finished(original);
            if (finished != null) {
                answer.complete(finished);
                return;
            }
            ToolExecutionRecord current = executionRepository.findByExecutionCallId(
                    original.getExecutionCallId());
            if (current == null || !ownsDispatch(current, original)
                    || !current.getBindingId().equals(context.binding().getBindingId())
                    || current.getRuntimeGeneration() != context.binding().getGeneration()
                    || !provisioner.isUsable(context.lease()) || !clock.instant().isBefore(deadline)) {
                throw evidenceUnavailable();
            }
            safeStage(() -> transport.statusV3(context.lease(), context.session(),
                    original.getReference(), 0)).whenComplete((status, error) -> {
                        if (answer.isDone()) {
                            return;
                        }
                        if (nonRetryableToolV3(error)) {
                            answer.completeExceptionally(unwrap(error));
                            return;
                        }
                        if (error == null && status != null && "settled".equals(status.get("state"))
                                && status.get("result") instanceof Map<?, ?> result
                                && "not_started".equals(result.get("executionStatus"))) {
                            @SuppressWarnings("unchecked")
                            Map<String, Object> saved = (Map<String, Object>) result;
                            answer.complete(saved);
                            return;
                        }
                        // A background Shell start settles its handle as the
                        // detached family: nothing is ever published for it,
                        // so the status answer is its only durable settle.
                        if (error == null && status != null && "settled".equals(status.get("state"))
                                && status.get("result") instanceof Map<?, ?> detached
                                && isDetachedCapture(detached)) {
                            @SuppressWarnings("unchecked")
                            Map<String, Object> saved = (Map<String, Object>) detached;
                            answer.complete(saved);
                            return;
                        }
                        if (error == null && status != null && "unknown".equals(status.get("state"))) {
                            answer.completeExceptionally(evidenceUnavailable());
                            return;
                        }
                        // Each round costs two repository reads and one worker
                        // call; back off instead of pinning them at 10/s for
                        // the whole window.
                        long delay = v3PollDelayMillis(attempt);
                        try {
                            scheduler.schedule(() -> pollV3Result(context,
                                    original, deadline, answer, attempt + 1),
                                    delay, TimeUnit.MILLISECONDS);
                        } catch (RuntimeException failure) {
                            answer.completeExceptionally(failure);
                        }
                    });
        } catch (RuntimeException failure) {
            answer.completeExceptionally(failure);
        }
    }

    private static boolean nonRetryableToolV3(Throwable error) {
        return error != null && unwrap(error) instanceof RuntimeBrokerException failure
                && !failure.isRetryable();
    }

    /** The detached capture family: success with a manifest-less capture. */
    private static boolean isDetachedCapture(Map<?, ?> result) {
        return result != null && "success".equals(result.get("executionStatus"))
                && result.get("capture") instanceof Map<?, ?> capture
                && "detached".equals(capture.get("captureStatus"))
                && capture.get("manifest") == null;
    }

    private static Map<String, Object> dispatchReference(ToolExecutionRecord record) {
        if (!Integer.valueOf(3).equals(record.getReference().get("runtimeProtocol"))) {
            return record.getReference();
        }
        Map<String, Object> reference = new LinkedHashMap<>(record.getReference());
        reference.put("executionCallId", record.getExecutionCallId());
        return Map.copyOf(reference);
    }

    private ToolExecutionRecord enterExecuting(
            ToolExecutionRecord claimed) {
        ToolExecutionRecord current = claimed;
        for (int attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
            if (current == null || current.isTerminal()
                    || current.getState()
                            == ToolExecutionRecord.State.UNKNOWN
                    || !ownsDispatch(current, claimed)) {
                return current;
            }
            if (current.getState() != ToolExecutionRecord.State.DISPATCHING) {
                return null;
            }
            ToolExecutionRecord replacement;
            if (current.isCancelRequested()) {
                replacement = current.withResult(
                        current.cancellationBeforeDispatch(),
                        current.getLastSequence(), clock.instant());
            } else {
                replacement = current.withState(
                        ToolExecutionRecord.State.EXECUTING, false);
            }
            ToolExecutionRecord updated = current.isCancelRequested()
                    ? executionRepository.compareAndSet(current, replacement, brokerOwnerId,
                            claimed.getDispatchGeneration())
                    : bindingRepository.authorizeDispatch(sessionRepository, executionRepository, current,
                            brokerOwnerId, claimed.getDispatchGeneration());
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
            if (current == null || current.isTerminal()
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
            if (current == null || current.isTerminal()
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
            if (current.isTerminal() || current.isCancelRequested()) {
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
            if (latest == null || (!latest.isTerminal()
                    && latest.getState()
                            != ToolExecutionRecord.State.UNKNOWN)) {
                throw exception;
            }
        }
    }

    private ToolExecutionRecord requireOwnedExecution(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId) {
        return requireOwnership(harnessSessionId, runtimeSessionId,
                executionCallId).record();
    }

    /**
     * A terminal record comes back with the saved binding and Session rows
     * that prove its ownership; any other record comes back without them.
     */
    private OwnedExecution requireOwnership(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId) {
        ToolExecutionRecord record = executionRepository
                .findByExecutionCallId(executionCallId);
        if (record == null) {
            throw notFound("runtime_execution_not_found",
                    "Runtime execution was not found");
        }
        if (!record.getHarnessSessionId().equals(harnessSessionId)
                || !record.getRuntimeSessionId().equals(runtimeSessionId)) {
            throw conflict("runtime_execution_conflict",
                    "Runtime execution belongs to another Session");
        }
        RuntimeBindingRecord binding = null;
        RuntimeSessionRecord session = null;
        if (record.isTerminal()) {
            binding = bindingRepository.findById(record.getBindingId());
            session = binding == null ? null : sessionRepository.findById(
                    binding.getRequest().getScope(), runtimeSessionId);
            if (binding == null || binding.getGeneration() != record.getRuntimeGeneration()
                    || session == null || !session.getBindingId().equals(record.getBindingId())
                    || session.getRuntimeGeneration() != record.getRuntimeGeneration()
                    || !session.getSession().getHarnessSessionId().equals(harnessSessionId)) {
                throw conflict("runtime_execution_conflict", "Saved execution ownership differs");
            }
        }
        return new OwnedExecution(record, binding, session);
    }

    /**
     * An execution whose outcome is already UNKNOWN keeps its own answer
     * when the generation that could tell more is no longer live: nothing
     * can change the record anymore, so a closed admission reads as the
     * record's UNKNOWN instead of replacing it. Any other failure, and any
     * record the caller does not own, keeps the original error.
     */
    private CompletionStage<ToolExecutionRecord> unknownWhenAdmissionClosed(
            CompletionStage<ToolExecutionRecord> stage,
            String harnessSessionId, String runtimeSessionId,
            String executionCallId) {
        return stage.handle((record, error) -> {
            if (error == null) {
                return record;
            }
            Throwable cause = unwrap(error);
            if (cause instanceof RuntimeBrokerException exception
                    && "runtime_admission_closed".equals(exception.getCode())) {
                ToolExecutionRecord stored = executionRepository
                        .findByExecutionCallId(executionCallId);
                if (stored != null
                        && stored.getState() == ToolExecutionRecord.State.UNKNOWN
                        && stored.getHarnessSessionId().equals(harnessSessionId)
                        && stored.getRuntimeSessionId().equals(runtimeSessionId)) {
                    return stored;
                }
            }
            throw new CompletionException(cause);
        });
    }

    /**
     * An execution permanently points at the binding generation it was
     * dispatched to. Once that generation is retired, replaced, or gone, no
     * Runtime can answer for it, so polling must stop rather than retry.
     */
    private void requireAnswerableBinding(ToolExecutionRecord record) {
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

    private static ExecutionReconciliation notUnknown(
            ToolExecutionRecord record, String runtimeState) {
        return new ExecutionReconciliation(record,
                record.getState() == ToolExecutionRecord.State.ABANDONED
                        ? ExecutionReconciliation.Outcome.ABANDONED
                        : record.isSettled() ? ExecutionReconciliation.Outcome.ALREADY_SETTLED
                                : ExecutionReconciliation.Outcome.IN_FLIGHT, runtimeState);
    }

    private ExecutionReconciliation absorbRuntimeStatus(
            ToolExecutionRecord unknown, Map<String, Object> status, boolean takeover) {
        if (status == null) {
            throw invalidStatus(null);
        }
        for (Object field : status.keySet()) {
            if (!(field instanceof String)
                    || !RUNTIME_STATUS_FIELDS.contains(field)) {
                throw invalidStatus(null);
            }
        }
        Object state = status.get("state");
        if (!(state instanceof String)
                || !RUNTIME_STATUS_STATES.contains(state)
                || "settled".equals(state)
                        != status.containsKey("result")) {
            throw invalidStatus(null);
        }
        String runtimeState = (String) state;
        if (!"settled".equals(runtimeState)) {
            ToolExecutionRecord latest = executionRepository
                    .findByExecutionCallId(unknown.getExecutionCallId());
            ToolExecutionRecord current = latest == null ? unknown : latest;
            return current.getState() == ToolExecutionRecord.State.UNKNOWN
                    ? new ExecutionReconciliation(current,
                            ExecutionReconciliation.Outcome.UNRESOLVED,
                            runtimeState)
                    : notUnknown(current, runtimeState);
        }
        Map<String, Object> result;
        try {
            result = immutableMap(status.get("result"), "status result");
            // Validate before writing, so an invalid result is reported as
            // the Runtime's fault rather than as a repository failure. A
            // not_started status is accepted only as the Runtime's own
            // terminal answer; the Broker never derives it.
            unknown.resolveUnsettled(result, clock.instant());
        } catch (IllegalArgumentException | RuntimeBrokerException exception) {
            throw invalidStatus(exception);
        }
        ToolExecutionRecord current = unknown;
        for (int attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
            if (current == null) {
                throw notFound("runtime_execution_not_found",
                        "Runtime execution was not found");
            }
            if (!current.needsReconciliation()
                    || !takeover && current.getState() != ToolExecutionRecord.State.UNKNOWN) {
                return notUnknown(current, runtimeState);
            }
            if (takeover) {
                requireOpen();
            }
            if (!current.sameIdentity(unknown)) {
                throw conflict("runtime_execution_conflict", "Execution identity changed while reconciling");
            }
            // A racing cancel advances the version; re-read and retry.
            ToolExecutionRecord resolved = takeover
                    ? executionRepository.resolveUnsettled(current, result, clock.instant())
                    : executionRepository.resolveUnknown(current, result, clock.instant());
            if (resolved != null) {
                settleUnstartedBackgroundSiblings(
                        unknown.getExecutionCallId(), result);
                return new ExecutionReconciliation(resolved,
                        ExecutionReconciliation.Outcome.RESOLVED,
                        runtimeState);
            }
            current = executionRepository.findByExecutionCallId(
                    unknown.getExecutionCallId());
        }
        // The record is still UNKNOWN, so the next poll can try again.
        throw unavailable("runtime_execution_reconcile_failed",
                "Runtime execution changed while reconciling");
    }

    private static RuntimeBrokerException invalidStatus(Throwable cause) {
        return new RuntimeBrokerException(502,
                "runtime_execution_status_invalid",
                "Runtime execution lookup returned an invalid status", false,
                cause);
    }

    private static RuntimeBrokerException evidenceUnavailable() {
        return new RuntimeBrokerException(409,
                "runtime_execution_evidence_unavailable",
                "The original Runtime generation cannot answer for this "
                        + "execution", false);
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
                // A row already persisted as RELEASING can predate the
                // guarded transition: an older peer's check-then-act let an
                // admission in and its worker release then failed. Admission
                // needs READY under the row lock, so nothing new can join
                // now, but completing this release would free a worker that
                // is still running a tool, so the retry is only idempotent
                // once nothing active is left.
                if (executionRepository.hasActiveByRuntimeSession(
                        current.getBindingId(),
                        current.getRuntimeGeneration(),
                        current.getRuntimeSessionId())) {
                    throw conflict("runtime_session_busy",
                            "Runtime Session has an active operation");
                }
                return current;
            }
            if (current.getState()
                    == RuntimeSessionRecord.State.RELEASED) {
                return current;
            }
            if (current.getState() != RuntimeSessionRecord.State.READY
                    && current.getState() != RuntimeSessionRecord.State.ACQUIRING) {
                throw conflict("runtime_session_not_ready",
                        "Runtime Session is not ready for release");
            }
            // The transition and the no-active-execution check commit in one
            // transaction under the Session row lock that admission also
            // takes, so a concurrent Broker process cannot admit into the
            // gap between the check and the CAS.
            RuntimeSessionRecord updated =
                    bindingRepository.beginSessionRelease(sessionRepository,
                            executionRepository, current);
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
            if (current.getState() == RuntimeSessionRecord.State.RELEASED) {
                return;
            }
            RuntimeSessionRecord updated = bindingRepository.completeSessionRelease(sessionRepository, current);
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

    private void invalidateBinding(RuntimeBindingRecord record) {
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
        reconciliations.values().forEach(future -> future.cancel(false));
        scheduler.shutdownNow();
        renewalScheduler.shutdownNow();
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
        try {
            return provisioner.createRequest(scope,
                    "session".equals(scope.getIsolationClass())
                            ? harnessSessionId : null);
        } catch (IllegalArgumentException exception) {
            // A managed-context provisioner refuses a scope it cannot place,
            // such as one without a storage ID, rather than fall back.
            throw new RuntimeBrokerException(400, "runtime_placement_invalid",
                    "Runtime placement is invalid", false, exception);
        }
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
            return BrokerValues.requireWellFormed(BrokerValues.requireId(
                    (String) value, "reference." + field),
                    "reference." + field);
        } catch (IllegalArgumentException exception) {
            throw invalid("runtime_reference_invalid",
                    "reference " + field + " is invalid");
        }
    }

    private boolean shouldDriveDispatch(ToolExecutionRecord record) {
        // The repository judges the lease: claimDispatch leaves a live claim
        // alone and fences a lapsed EXECUTING or CANCEL_REQUESTED record.
        return !record.isTerminal()
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
                    "qwen-runtime-broker-coordination");
            thread.setDaemon(true);
            return thread;
        });
    }

    // Renewals run their synchronous JDBC on their own pool, so a stalled
    // tick no longer occupies the coordination thread, and a second thread
    // absorbs one slow call. That is not isolation: the tick holds its
    // claim's monitor while parked, and the fence and settlement paths take
    // that monitor from coordination tasks, so a long stall can still block
    // coordination behind it (#13275).
    private static ScheduledExecutorService newRenewalScheduler() {
        ScheduledThreadPoolExecutor executor =
                new ScheduledThreadPoolExecutor(2,
                        runnable -> {
                            Thread thread = new Thread(runnable,
                                    "qwen-runtime-broker-lease-renewal");
                            thread.setDaemon(true);
                            return thread;
                        });
        executor.setRemoveOnCancelPolicy(true);
        return executor;
    }

    private long renewalDelayMillis(Duration duration) {
        return Math.max(1, duration.toMillis() / 3);
    }

    /**
     * The bound for a step that runs WITHOUT its own renewal (currently only
     * the maintenance path's attestation leg): it must stay one renewal tick
     * below the lease so the claim is still live at the guarded write that
     * follows. Steps with a renewal use {@link #stepCallTimeoutMillis()}.
     */
    private long cleanupStepTimeoutMillis() {
        return Math.max(1, operationLeaseDuration.toMillis()
                - renewalDelayMillis(operationLeaseDuration));
    }

    /**
     * The backstop for a step running under its own renewal: liveness is
     * covered by the renewal ticks, so this only bounds a provisioner that
     * never answers at all, and is sized to exceed the shipped callees'
     * declared waits at the production lease.
     */
    private long stepCallTimeoutMillis() {
        return Math.max(1, operationDeadlineMillis() / 2);
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

    private record OwnedExecution(ToolExecutionRecord record,
            RuntimeBindingRecord binding, RuntimeSessionRecord session) {
    }

    private static final class SessionContext {
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

    private final class BindingRenewal implements AutoCloseable {
        // A monitor here would pin a virtual-thread carrier whenever a
        // guarded repository call blocks on the database (JDK 21);
        // the lock parks without pinning instead.
        private final ReentrantLock monitor = new ReentrantLock();
        private final AtomicReference<RuntimeBindingRecord> current;
        private final AtomicBoolean valid = new AtomicBoolean(true);
        private final AtomicBoolean stopped = new AtomicBoolean();
        private ScheduledFuture<?> task;

        BindingRenewal(RuntimeBindingRecord claimed) {
            current = new AtomicReference<>(claimed);
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

        RuntimeBindingRecord stopAndGet() {
            monitor.lock();
            try {
                closeLocked();
                return !closed.get() && valid.get() ? current.get() : null;
            } finally {
                monitor.unlock();
            }
        }

        boolean persistResourceHandle(
                RuntimeResourceHandle handle) {
            monitor.lock();
            try {
                if (closed.get() || !valid.get()) {
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

    private final class DispatchRenewal implements AutoCloseable {
        // Same virtual-thread rule as BindingRenewal: guarded repository
        // calls must not pin the caller's carrier while they block.
        private final ReentrantLock monitor = new ReentrantLock();
        private final String executionCallId;
        private final long dispatchGeneration;
        private ScheduledFuture<?> task;

        DispatchRenewal(String executionCallId,
                long dispatchGeneration) {
            this.executionCallId = executionCallId;
            this.dispatchGeneration = dispatchGeneration;
        }

        void start() {
            monitor.lock();
            try {
                long delay = renewalDelayMillis(dispatchLeaseDuration);
                task = renewalScheduler.scheduleWithFixedDelay(this::renew,
                        delay, delay, TimeUnit.MILLISECONDS);
            } finally {
                monitor.unlock();
            }
        }

        private void renew() {
            monitor.lock();
            try {
                if (closed.get()) {
                    closeLocked();
                    return;
                }
                try {
                    ToolExecutionRecord renewed =
                            executionRepository.renewDispatch(
                                    executionCallId, brokerOwnerId,
                                    dispatchGeneration,
                                    dispatchLeaseDuration);
                    if (renewed == null) {
                        executionRepository.claimDispatch(executionCallId,
                                brokerOwnerId, dispatchLeaseDuration);
                        closeLocked();
                    }
                } catch (RuntimeException exception) {
                    // A transient repository failure does not prove claim loss.
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
            if (task != null) {
                task.cancel(false);
            }
        }
    }
}
