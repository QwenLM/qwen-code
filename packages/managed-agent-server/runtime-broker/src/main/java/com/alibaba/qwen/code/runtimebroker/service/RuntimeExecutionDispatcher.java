package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.HarnessOwnership;
import com.alibaba.qwen.code.runtimebroker.NativeCsiExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimePublicationGrant;
import com.alibaba.qwen.code.runtimebroker.RuntimePublicationVerifier;
import com.alibaba.qwen.code.runtimebroker.RuntimeScope;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeToolMeasurements;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRecord;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.VerifiedDispatchPayload;
import com.alibaba.qwen.code.runtimebroker.protocol.ProviderRuntimeProtocol;
import com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBindingRegistry.SessionContext;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.locks.ReentrantLock;

import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBindingRegistry.evidenceUnavailable;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.MAX_CAS_ATTEMPTS;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.conflict;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.failed;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.invalid;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.isDetachedCapture;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.isProtocolV3;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.isPublicationV3;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.isV3Family;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.renewalDelayMillis;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.safeStage;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.sshNoStartReceipt;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.unavailable;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.unwrap;

final class RuntimeExecutionDispatcher {
    private final RuntimeBindingRegistry bindingRegistry;
    private final RuntimeExecutionState executionState;
    private final RuntimeBindingRepository bindingRepository;
    private final RuntimeSessionRepository sessionRepository;
    private final ToolExecutionRepository executionRepository;
    private final RuntimeProvisioner provisioner;
    private final RuntimeTransport transport;
    private final RuntimePublicationVerifier publicationVerifier;
    private final String brokerOwnerId;
    private final Duration dispatchLeaseDuration;
    private final Duration v3ResultWindow;
    private final Clock clock;
    private final ScheduledExecutorService scheduler;
    private final ScheduledExecutorService renewalScheduler;
    private final AtomicBoolean closed;
    private final ConcurrentMap<String, CompletableFuture<Void>> dispatches =
            new ConcurrentHashMap<>();
    // The shared-dispatch waits own their PREPARED row: a close that discards
    // the queued tick must settle it, and the wait must end so the dispatch
    // map entry is removed.
    private final ConcurrentMap<String, Awaiting> awaiting =
            new ConcurrentHashMap<>();
    private record Awaiting(CompletableFuture<Void> queued,
            ToolExecutionRecord prepared) {
    }
    // Executions whose transport.execute call is in flight in this process,
    // as opposed to dispatches, which also covers a claim being fenced.
    private final Set<String> invocations = ConcurrentHashMap.newKeySet();
    // The external channel's horizon renewal is a guarded repository read plus
    // an attested HTTP exchange; it must not run on the tick thread that renews
    // every other claim. Virtual threads need no shutdown of their own.
    private final Thread.Builder.OfVirtual channelRenewals =
            Thread.ofVirtual().name("external-shell-renew-", 0);

    RuntimeExecutionDispatcher(RuntimeBindingRegistry bindingRegistry,
            RuntimeExecutionState executionState,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository,
            RuntimeProvisioner provisioner, RuntimeTransport transport,
            RuntimePublicationVerifier publicationVerifier,
            String brokerOwnerId, Duration dispatchLeaseDuration,
            Duration v3ResultWindow, Clock clock,
            ScheduledExecutorService scheduler,
            ScheduledExecutorService renewalScheduler, AtomicBoolean closed) {
        this.bindingRegistry = bindingRegistry;
        this.executionState = executionState;
        this.bindingRepository = bindingRepository;
        this.sessionRepository = sessionRepository;
        this.executionRepository = executionRepository;
        this.provisioner = provisioner;
        this.transport = transport;
        this.publicationVerifier = publicationVerifier;
        this.brokerOwnerId = brokerOwnerId;
        this.dispatchLeaseDuration = dispatchLeaseDuration;
        this.v3ResultWindow = v3ResultWindow;
        this.clock = clock;
        this.scheduler = scheduler;
        this.renewalScheduler = renewalScheduler;
        this.closed = closed;
    }

    boolean isInvoking(String executionCallId) {
        return invocations.contains(executionCallId);
    }

    void cancelPendingOperations() {
        // A shared-dispatch wait owns its PREPARED row: close() rejects every
        // queued tick with shutdownNow(), so settle here before unblocking the
        // wait, or the row stays active and fences the binding's release.
        awaiting.values().forEach(wait -> {
            try {
                settleStrandedPrepared(wait.prepared(), "dispatch_failed",
                        "Shared Workspace dispatch failed before claim");
            } catch (RuntimeException | Error ignored) {
                // Close still has to unblock the caller's wait below.
            }
            wait.queued().completeExceptionally(unavailable(
                    "runtime_admission_closed", "Runtime broker is closing"));
        });
        dispatches.values().forEach(future -> future.cancel(false));
    }

    void beginDispatch(SessionContext context,
            ToolExecutionRecord prepared) {
        beginDispatch(context, prepared, null);
    }

    void beginDispatch(SessionContext context,
            ToolExecutionRecord prepared, Map<String, Object> payload) {
        beginDispatch(context, prepared, payload, null);
    }

    void beginDispatch(SessionContext context,
            ToolExecutionRecord prepared, Map<String, Object> payload,
            RuntimePublicationGrant grant) {
        beginDispatch(context, prepared, payload, grant, null);
    }

    void beginDispatch(SessionContext context,
            ToolExecutionRecord prepared, Map<String, Object> payload,
            RuntimePublicationGrant grant,
            VerifiedDispatchPayload verifiedPayload) {
        beginDispatch(context, prepared, payload, grant, verifiedPayload, null);
    }

    void beginDispatch(SessionContext context,
            ToolExecutionRecord prepared, Map<String, Object> payload,
            RuntimePublicationGrant grant,
            VerifiedDispatchPayload verifiedPayload, String externalChannelId) {
        if (com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.isExternalShellRequest(
                context.binding().getRequest())
                && (!isPublicationV3(prepared.getReference())
                        || prepared.getReference().containsKey("runtimeProtocol")
                        || !prepared.isCancelRequested() && (grant == null
                                || publicationVerifier == null
                                || publicationVerifier.externalShell() == null
                                || payload == null
                                || !"run_shell_command".equals(String.valueOf(payload.get("toolName")))
                                || !(payload.get("input") instanceof Map<?, ?> input)
                                || input.containsKey("is_background") || input.containsKey("is_monitor")))) {
            throw invalid("runtime_payload_invalid",
                    "External Shell requires a foreground Tool v3 Shell payload");
        }
        if (!com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.isExternalShellRequest(
                context.binding().getRequest())
                && com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.isExternalWorkspaceRequest(context.binding().getRequest())
                && (!"deferred".equals(prepared.getReference().get("dispatchMode"))
                        || prepared.getReference().containsKey("runtimeProtocol") || grant != null
                        || !prepared.isCancelRequested() && (payload == null
                                || !Set.of("read_file", "write_file", "edit", "glob")
                                        .contains(String.valueOf(payload.get("toolName")))))) {
            throw invalid("runtime_payload_invalid", "External Workspace requires a file Tool v2 payload");
        }
        if (CsiFilesRetirementProfile.isProfile(context.binding().getRequest().getScope())
                && (!(bindingRepository instanceof NativeCsiExecutionRepository)
                        || payload == null || !Set.of("read_file", "write_file", "edit").contains(String.valueOf(payload.get("toolName"))) || grant != null)) {
            throw new RuntimeBrokerException(501, "csi_file_dispatch_unavailable",
                    "Private CSI dispatch requires original JDBC authorization and a finite file payload.", false);
        }
        if (!prepared.isCancelRequested()) {
            bindingRepository.requireHarnessAdmission(context.binding().getRequest(), context.session().getScope(),
                    context.session().getHarnessSessionId(), null);
        }
        if (payload == null && ("deferred".equals(prepared.getReference().get("dispatchMode"))
                || isPublicationV3(prepared.getReference()))
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
            operation = dispatch(context, prepared, payload, grant, verifiedPayload, externalChannelId);
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
            RuntimePublicationGrant grant,
            VerifiedDispatchPayload verifiedPayload, String externalChannelId) {
        ToolExecutionRecord claimed = claimDispatchForPayload(
                context, prepared, verifiedPayload);
        if (claimed == null
                && com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile
                        .isExternalWorkspaceRequest(
                                context.binding().getRequest())
                && HarnessOwnership.sharesRuntimeSessions(
                        context.binding().getRequest())) {
            return awaitSharedDispatch(context, prepared, payload, grant,
                    verifiedPayload, externalChannelId);
        }
        return dispatchClaimed(context, claimed, payload, grant, externalChannelId);
    }

    private ToolExecutionRecord claimDispatchForPayload(
            SessionContext context, ToolExecutionRecord prepared,
            VerifiedDispatchPayload payload) {
        if (!com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile
                .isExternalWorkspaceRequest(
                        context.binding().getRequest())
                || !HarnessOwnership.sharesRuntimeSessions(
                        context.binding().getRequest())) {
            return executionRepository.claimDispatch(
                    prepared.getExecutionCallId(), brokerOwnerId,
                    dispatchLeaseDuration);
        }
        return executionRepository.claimValidatedDispatch(
                prepared.getExecutionCallId(), brokerOwnerId,
                dispatchLeaseDuration, payload);
    }

    private CompletionStage<Void> awaitSharedDispatch(
            SessionContext context, ToolExecutionRecord prepared,
            Map<String, Object> payload, RuntimePublicationGrant grant,
            VerifiedDispatchPayload verifiedPayload, String externalChannelId) {
        // Keep a single Future per waiting request; a long-lived UNKNOWN
        // occupant must not build a recursive chain. The wait is bounded like
        // the v3 result poll: backoff between attempts and a deadline, so an
        // occupant that never settles answers a conflict instead of retrying
        // forever on the shared coordination thread.
        CompletableFuture<Void> queued = new CompletableFuture<>();
        Awaiting wait = new Awaiting(queued, prepared);
        awaiting.put(prepared.getExecutionCallId(), wait);
        queued.whenComplete((ignored, error) ->
                awaiting.remove(prepared.getExecutionCallId(), wait));
        java.time.Instant deadline = clock.instant().plus(v3ResultWindow);
        java.util.concurrent.atomic.AtomicInteger attempt =
                new java.util.concurrent.atomic.AtomicInteger();
        Runnable tick = new Runnable() {
            @Override
            public void run() {
                if (queued.isDone()) {
                    return;
                }
                try {
                    com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport
                            .requireOpen(closed);
                    if (!clock.instant().isBefore(deadline)) {
                        // The slot never freed. The conflict below feeds a
                        // write-only future (dispatches is consumed solely by
                        // cancelPendingOperations), so it can never surface to
                        // the caller on its own. Settle the stranded PREPARED
                        // execution first, so the record the caller polls
                        // carries the refusal instead of hanging PREPARED with
                        // no dispatch owner.
                        settleStrandedPrepared(prepared, "dispatch_timeout",
                                "Shared Workspace dispatch slot did not free in time");
                        throw conflict("runtime_execution_conflict",
                                "Shared Workspace dispatch slot did not free in time");
                    }
                    ToolExecutionRecord waiting =
                            executionRepository.findByExecutionCallId(
                                    prepared.getExecutionCallId());
                    if (waiting == null || !waiting.sameIdentity(prepared)
                            || waiting.getState()
                                    != ToolExecutionRecord.State.PREPARED) {
                        queued.complete(null);
                        return;
                    }
                    ToolExecutionRecord next;
                    context.lock();
                    try {
                        bindingRegistry.requireReadySessionRecord(context);
                        bindingRepository.requireHarnessAdmission(
                                context.binding().getRequest(),
                                context.session().getScope(),
                                context.session().getHarnessSessionId(),
                                null);
                        next = claimDispatchForPayload(
                                context, prepared, verifiedPayload);
                    } finally {
                        context.unlock();
                    }
                    if (next == null) {
                        scheduler.schedule(this,
                                v3PollDelayMillis(attempt.getAndIncrement()),
                                TimeUnit.MILLISECONDS);
                    } else {
                        dispatchClaimed(
                                context, next, payload, grant, externalChannelId)
                                .whenComplete((ignored, error) -> {
                                    if (error == null) {
                                        queued.complete(null);
                                    } else {
                                        queued.completeExceptionally(
                                                unwrap(error));
                                    }
                                });
                    }
                } catch (RuntimeException | Error error) {
                    // Every exceptional exit feeds the same write-only future,
                    // so the stranded PREPARED row must settle here too or it
                    // hangs the caller's poll and fences the binding's release
                    // forever (the reconciler skips PREPARED rows).
                    try {
                        settleStrandedPrepared(prepared, "dispatch_failed",
                                "Shared Workspace dispatch failed before claim");
                    } catch (RuntimeException | Error settleFailure) {
                        error.addSuppressed(settleFailure);
                    }
                    queued.completeExceptionally(error);
                }
            }
        };
        try {
            scheduler.schedule(tick, 250, TimeUnit.MILLISECONDS);
        } catch (RuntimeException | Error rejected) {
            // The dispatch between the null claim and this first schedule can
            // race a closing broker: the scheduler is shut down, so the
            // PREPARED row would otherwise stay active with no owner and fence
            // the binding's release forever. Settle it before propagating,
            // exactly like the tick's own exceptional exit.
            awaiting.remove(prepared.getExecutionCallId(), wait);
            try {
                settleStrandedPrepared(prepared, "dispatch_failed",
                        "Shared Workspace dispatch failed before claim");
            } catch (RuntimeException | Error settleFailure) {
                rejected.addSuppressed(settleFailure);
            }
            throw rejected;
        }
        return queued;
    }

    private void settleStrandedPrepared(ToolExecutionRecord prepared,
            String errorType, String message) {
        ToolExecutionRecord stranded = executionRepository
                .findByExecutionCallId(prepared.getExecutionCallId());
        if (stranded != null && stranded.sameIdentity(prepared)
                && stranded.getState() == ToolExecutionRecord.State.PREPARED) {
            executionRepository.settlePrepared(stranded, Map.of(
                    "executionStatus", "not_started",
                    "responseParts", List.of(),
                    "error", Map.of("type", errorType, "message", message)),
                    clock.instant());
        }
    }

    private CompletionStage<Void> dispatchClaimed(
            SessionContext context, ToolExecutionRecord claimed,
            Map<String, Object> payload,
            RuntimePublicationGrant grant, String externalChannelId) {
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
            bindingRegistry.invalidateBinding(context.binding());
            executionState.markUnknown(executing);
            return CompletableFuture.completedFuture(null);
        }
        // A dispatch this process did not start (the recovery arm) arrives
        // without a channel. `begin` is idempotent per execution, so opening it
        // here gets the same channel the original dispatch used. It runs on the
        // invocation's own stage, never under the session lock, and it must
        // complete before the Shell starts: the worker prepares against a
        // channel that already exists.
        CompletionStage<String> channel = externalChannelId != null
                ? CompletableFuture.completedFuture(externalChannelId)
                : externalChannel(context, executing, grant);
        DispatchRenewal renewal = new DispatchRenewal(executing, context, grant, channel);
        try {
            renewal.start();
        } catch (RuntimeException | Error exception) {
            executionState.markUnknown(executing);
            throw exception;
        }
        invocations.add(executing.getExecutionCallId());
        CompletionStage<Map<String, Object>> invocation = channel.thenCompose(id ->
                invoke(context, executing, payload, grant));
        return invocation
                .thenCompose(result -> result == null
                        ? CompletableFuture.<Map<String, Object>>completedFuture(null)
                        : channel.thenCompose(id -> moveExternalShell(
                                context, executing, grant, id, result)))
                .<Void>handle((result, error) -> {
                    // Stop counting as running before the outcome is
                    // written, so a cancel that reads that outcome does not
                    // treat this finished invocation as still running.
                    invocations.remove(executing.getExecutionCallId());
                    if (error != null || result == null) {
                        executionState.markUnknown(executing);
                        return null;
                    }
                    try {
                        executionState.settleExecution(executing, result);
                        executionState.settleUnstartedBackgroundSiblings(
                                executing.getExecutionCallId(), result);
                    } catch (RuntimeException exception) {
                        executionState.markUnknown(executing);
                    }
                    return null;
                }).thenCompose(ignored -> {
                    if (!RuntimeProviderKinds.SSH_PROCESS.equals(context.binding().getRequest().getProvisionerKind())
                            && !WorkspaceExecutionProfile.isExternalWorkspaceRequest(context.binding().getRequest())
                            && !RuntimeToolMeasurements.selected(executing.getReference())) {
                        return CompletableFuture.completedFuture(null);
                    }
                    ToolExecutionRecord settled = executionRepository.findByExecutionCallId(executing.getExecutionCallId());
                    return settled != null && settled.sameIdentity(executing)
                            ? acknowledgePersistedTools(context.binding(), settled).exceptionally(error -> null)
                            : CompletableFuture.completedFuture(null);
                }).whenComplete((ignored, error) -> renewal.close());
    }

    private CompletionStage<Map<String, Object>> invoke(SessionContext context,
            ToolExecutionRecord executing, Map<String, Object> payload,
            RuntimePublicationGrant grant) {
        boolean externalShell = externalShellLane(context, executing);
        return RuntimeToolMeasurements.selected(executing.getReference())
                ? safeStage(() -> transport.executeV4(
                        context.lease(), context.session(),
                        dispatchReference(executing, context.binding().getRequest().getScope()),
                        payload, grant == null ? null : capture(grant)))
                        .thenCompose(answer -> {
                            if ("settled".equals(answer.get("state"))
                                    && answer.get("result") instanceof Map<?, ?> raw) {
                                @SuppressWarnings("unchecked")
                                Map<String, Object> result = (Map<String, Object>) raw;
                                return CompletableFuture.completedFuture(result);
                            }
                            return awaitV3Result(context, executing, clock.instant().plus(v3ResultWindow));
                        })
                : grant == null
                ? safeStage(() -> payload == null
                        ? transport.execute(context.lease(), context.session(), executing.getReference())
                        : transport.execute(context.lease(), context.session(),
                                dispatchReference(executing, context.binding().getRequest().getScope()), payload))
                : safeStage(() -> transport.executeV3(context.lease(), context.session(),
                        executing.getReference(), payload, capture(grant)))
                        .handle((answer, error) -> {
                            if (nonRetryableToolV3(error)) {
                                throw new CompletionException(unwrap(error));
                            }
                            if (error == null && answer != null
                                    && "settled".equals(answer.get("state"))
                                    && answer.get("result") instanceof Map<?, ?> result
                                    && (externalShell
                                            || "not_started".equals(result.get("executionStatus")))) {
                                @SuppressWarnings("unchecked")
                                Map<String, Object> settled = (Map<String, Object>) result;
                                return settled;
                            }
                            return null;
                        })
                        .thenCompose(notStarted -> notStarted != null
                                ? CompletableFuture.completedFuture(notStarted)
                                : awaitV3Result(context, executing,
                                        clock.instant().plus(v3ResultWindow)));
    }

    /**
     * The external foreground-Shell lane, whose worker publishes nothing to the
     * control plane: the Broker moves its bytes itself. Every other v3
     * placement has its worker finish its own publication before it settles, so
     * only the durable envelope may answer there; this lane's worker settles on
     * its local capture, and the move below is what makes that result durable.
     */
    private static boolean externalShellLane(SessionContext context,
            ToolExecutionRecord execution) {
        return WorkspaceExecutionProfile.isExternalShellRequest(context.binding().getRequest())
                && isPublicationV3(execution.getReference());
    }

    /**
     * Re-opens the external worker's channel for a dispatch this process did
     * not start. {@code begin} is idempotent per execution, so the recovery arm
     * gets the channel the original dispatch opened.
     *
     * <p>Every other placement, and a cancel-requested record — which carries
     * no grant and can only settle as not-started — needs no channel at all.
     */
    private CompletionStage<String> externalChannel(SessionContext context,
            ToolExecutionRecord executing, RuntimePublicationGrant grant) {
        if (!WorkspaceExecutionProfile.isExternalShellRequest(context.binding().getRequest())
                || executing.isCancelRequested()) {
            return CompletableFuture.completedFuture(null);
        }
        var producer = publicationVerifier == null ? null : publicationVerifier.externalShell();
        if (producer == null || grant == null) {
            return CompletableFuture.failedFuture(invalid("runtime_payload_invalid",
                    "External Shell requires its original publication grant"));
        }
        return safeStage(() -> producer.begin(context.lease(), context.binding(), executing, grant));
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

    /**
     * Moves the external worker's capture into the original publication before
     * the execution settles: the producer lane requires a live, non-draining
     * binding and an unsettled execution, so a later attempt could never
     * publish these bytes. A refusal or a lost answer marks the execution
     * UNKNOWN and leaves the worker channel unacknowledged, which keeps the
     * close refusing instead of releasing storage whose bytes never arrived.
     */
    private CompletionStage<Map<String, Object>> moveExternalShell(SessionContext context,
            ToolExecutionRecord executing, RuntimePublicationGrant grant,
            String externalChannelId, Map<String, Object> result) {
        if (!WorkspaceExecutionProfile.isExternalShellRequest(context.binding().getRequest())) {
            return CompletableFuture.completedFuture(result);
        }
        var producer = publicationVerifier == null ? null : publicationVerifier.externalShell();
        boolean started = !"not_started".equals(result.get("executionStatus"));
        boolean captured = started
                && result.get("capture") instanceof Map<?, ?> capture
                && "complete".equals(capture.get("captureStatus"));
        if (!started) {
            // The process never ran, so no channel holds bytes. This is the one
            // started-less outcome the Harness can record as not-started.
            return CompletableFuture.completedFuture(result);
        }
        if (!captured) {
            // A started call with an incomplete capture cannot be published:
            // `finish` admits only a complete capture, so no retry ever moves
            // these bytes. Settling it would be worse than a refusal — the
            // worker's own drain proof would still report `capture_incomplete`
            // forever, while the settled row would let the close reach the stop
            // and then wedge with no exit. Keep the record recoverable instead.
            return CompletableFuture.failedFuture(conflict("workspace_close_identity_unverified",
                    "External Shell capture did not complete"));
        }
        Map<String, Object> alreadyPublished = publicationVerifier == null
                ? null : publicationVerifier.finished(executing);
        if (alreadyPublished != null) {
            // A recovered dispatch whose drain already finished but whose settle
            // did not land. Re-running the move would publish over a FINISHED
            // lane and refuse; the durable envelope is already the outcome.
            return CompletableFuture.completedFuture(alreadyPublished);
        }
        if (producer == null || grant == null || externalChannelId == null) {
            // A complete capture with no lane to move it must not settle: its
            // bytes would be unreachable and the close could never be proven.
            return CompletableFuture.failedFuture(conflict("workspace_close_identity_unverified",
                    "External Shell capture has no original publication channel"));
        }
        ToolExecutionRecord current = executionRepository.findByExecutionCallId(
                executing.getExecutionCallId());
        if (current == null || !ownsDispatch(current, executing)) {
            return CompletableFuture.completedFuture(null);
        }
        return safeStage(() -> producer.drain(context.lease(), context.binding(), current,
                grant, externalChannelId, result))
                .thenApply(ignored -> {
                    // The drain rebuilt the manifest over the bytes it moved and
                    // finished the publication with it, so that envelope — not
                    // the worker's, which names its own local manifest — is the
                    // result this execution owns. The Harness compares the
                    // settled result against `/finished` verbatim, and a later
                    // reconcile answers from the same durable envelope.
                    Map<String, Object> published = publicationVerifier.finished(current);
                    if (published == null) {
                        throw conflict("workspace_close_identity_unverified",
                                "External Shell drain did not finish its publication");
                    }
                    return published;
                });
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
            boolean measured =
                    RuntimeToolMeasurements.selected(
                            original.getReference());
            boolean externalShell = externalShellLane(context, original);
            Map<String, Object> finished =
                    publicationVerifier == null ? null : publicationVerifier.finished(original);
            if (finished != null && !measured) {
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
            safeStage(() -> measured
                    ? transport.statusV4(context.lease(), context.session(), original.getReference(), 0)
                    : transport.statusV3(context.lease(), context.session(), original.getReference(), 0))
                    .whenComplete((status, error) -> {
                        if (answer.isDone()) {
                            return;
                        }
                        if (nonRetryableToolV3(error)) {
                            answer.completeExceptionally(unwrap(error));
                            return;
                        }
                        // The external lane's worker settles on its own local
                        // capture and publishes nothing, so its status is the
                        // result the drain below moves. A foreground Shell may
                        // outlive the execute call's own request timeout, and
                        // this poll is then the only way its outcome arrives.
                        if ((measured || externalShell) && error == null && status != null
                                && "settled".equals(status.get("state"))
                                && status.get("result") instanceof Map<?, ?> raw) {
                            @SuppressWarnings("unchecked")
                            Map<String, Object> result = (Map<String, Object>) raw;
                            answer.complete(result);
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

    private static Map<String, Object> dispatchReference(ToolExecutionRecord record, RuntimeScope scope) {
        if (CsiFilesRetirementProfile.isProfile(scope)) {
            Map<String, Object> reference = new LinkedHashMap<>(record.getReference());
            reference.put("executionCallId", record.getExecutionCallId());
            return Map.copyOf(reference);
        }
        if (!isProtocolV3(record.getReference())) {
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
        executionState.markUnknown(claimed);
        return null;
    }

    CompletionStage<Void> acknowledgePersistedTools(RuntimeBindingRecord binding, ToolExecutionRecord execution) {
        boolean external = WorkspaceExecutionProfile.isExternalWorkspaceRequest(binding.getRequest());
        boolean externalShell = WorkspaceExecutionProfile.isExternalShellRequest(binding.getRequest());
        if (external && !externalShell && (!execution.isSettled() || execution.getResult() == null
                || execution.getResult().containsKey("capture")
                || !execution.getReference().keySet().equals(
                        Set.of("sessionId", "promptId", "callId", "argsDigest", "dispatchMode"))
                || !"deferred".equals(execution.getReference().get("dispatchMode")))) {
            return failed(conflict("workspace_close_identity_unverified", "External drain requires settled file Tool v2 results"));
        }
        if (externalShell && (!execution.isSettled() || execution.getResult() == null
                || !isPublicationV3(execution.getReference()))) {
            return failed(conflict("workspace_close_identity_unverified",
                    "External Shell drain requires a settled Tool v3 result"));
        }
        if ((!RuntimeProviderKinds.SSH_PROCESS.equals(binding.getRequest().getProvisionerKind())
                        && !RuntimeToolMeasurements.selected(execution.getReference()) && !external)
                || !execution.isSettled() || execution.getResult() == null
                || ProviderRuntimeProtocol.isReference(execution.getReference())) {
            return CompletableFuture.completedFuture(null);
        }
        Map<String, Object> noStart = sshNoStartReceipt(binding, execution);
        if (noStart == null && (execution.getResult().containsKey("capture")
                || isV3Family(execution.getReference()))) {
            return CompletableFuture.completedFuture(null);
        }
        RuntimeSessionRecord session = sessionRepository.findById(binding.getRequest().getScope(),
                execution.getRuntimeSessionId());
        if (binding.getLease() == null || session == null || !execution.belongsTo(session)
                || !binding.getBindingId().equals(execution.getBindingId())
                || binding.getGeneration() != execution.getRuntimeGeneration()
                || !binding.getRequest().getScope().equals(session.getSession().getScope())
                // Shared workspace bindings carry no session isolation key; ownership
                // there rests on belongsTo + bindingId + generation + scope above, the
                // same shape acquireRecovery uses (#16023 R1-25).
                || !com.alibaba.qwen.code.runtimebroker.HarnessOwnership.sharesRuntimeSessions(binding.getRequest())
                        && !execution.getHarnessSessionId().equals(binding.getRequest().getIsolationKey())) {
            return failed(conflict("workspace_close_identity_unverified", "Persisted Tool ownership conflicts"));
        }
        if (noStart != null) {
            CompletionStage<Map<String, Object>> acknowledgement = isPublicationV3(execution.getReference())
                    ? transport.acknowledgeV3(binding.getLease(), session.getSession(), execution.getReference(), noStart)
                    : transport.acknowledge(binding.getLease(), session.getSession(), execution.getReference(), noStart);
            return acknowledgement.thenAccept(answer -> {
                if (answer == null || !Set.of("settled", "unknown").contains(answer.get("state"))) {
                    throw conflict("runtime_execution_conflict", "Original Runtime did not confirm the no-start acknowledgement");
                }
            });
        }
        var original = session.getSession();
        var authority = binding.getRequest().getScope().getLifecycleAuthority();
        if (external && authority != null) {
            original = new RuntimeSession(original.getHarnessSessionId(), original.getRuntimeSessionId(),
                    original.getTurnKind(), original.getScope().withLifecycleAuthority(authority));
        }
        return RuntimeToolMeasurements.selected(
                        execution.getReference())
                ? transport.acknowledgeV4(
                        binding.getLease(),
                        original,
                        execution.getReference(),
                        execution.getResult(),
                        null)
                : transport.acknowledgeV2(binding.getLease(), original, execution.getReference());
    }

    private static boolean ownsDispatch(ToolExecutionRecord current,
            ToolExecutionRecord claimed) {
        return claimed.getDispatchGeneration()
                        == current.getDispatchGeneration()
                && claimed.getDispatchOwner().equals(
                        current.getDispatchOwner());
    }

    private final class DispatchRenewal implements AutoCloseable {
        // Same virtual-thread rule as BindingRenewal: guarded repository
        // calls must not pin the caller's carrier while they block.
        private final ReentrantLock monitor = new ReentrantLock();
        private final ToolExecutionRecord original;
        private final SessionContext context;
        private final RuntimePublicationGrant grant;
        private final CompletionStage<String> externalChannel;
        private ScheduledFuture<?> task;

        DispatchRenewal(ToolExecutionRecord original, SessionContext context,
                RuntimePublicationGrant grant, CompletionStage<String> externalChannel) {
            this.original = original;
            this.context = context;
            this.grant = grant;
            this.externalChannel = externalChannel;
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
                                    original.getExecutionCallId(), brokerOwnerId,
                                    original.getDispatchGeneration(), dispatchLeaseDuration);
                    if (renewed == null) {
                        executionRepository.claimDispatch(original.getExecutionCallId(),
                                brokerOwnerId, dispatchLeaseDuration);
                        closeLocked();
                    } else if (!renewed.sameIdentity(original) || !renewed.sameAuthorization(original)
                            || !ownsDispatch(renewed, original)) {
                        closeLocked();
                    } else {
                        renewExternalChannel();
                    }
                } catch (RuntimeException exception) {
                    if (exception instanceof RuntimeBrokerException failure && !failure.isRetryable()
                            && (failure.getCode().startsWith("csi_")
                                    || "runtime_admission_closed".equals(failure.getCode()))) {
                        closeLocked();
                    }
                    // A transient repository failure does not prove claim loss.
                }
            } finally {
                monitor.unlock();
            }
        }

        /**
         * The worker channel is bounded by the publication grant, whose horizon
         * is the writer lease the Harness keeps renewing. A foreground Shell may
         * outlive one lease, so each dispatch renewal pushes the grant's current
         * horizon there too; without it the capture would close mid-command and
         * the drain could never finish. A refusal is not claim loss: the drain
         * itself re-reads the channel and refuses honestly if it really closed.
         */
        private void renewExternalChannel() {
            if (closed.get() || grant == null || publicationVerifier == null
                    || !WorkspaceExecutionProfile.isExternalShellRequest(
                            context.binding().getRequest())) {
                return;
            }
            var producer = publicationVerifier.externalShell();
            if (producer == null) {
                return;
            }
            var pending = externalChannel.toCompletableFuture();
            String channelId = pending.isCompletedExceptionally() ? null : pending.getNow(null);
            if (channelId == null) {
                return;
            }
            // The grant recheck takes the publication row's FOR UPDATE and the
            // renewal itself is an attested HTTP exchange. The tick thread also
            // renews every other claim, so neither may run on it: hand the pair
            // to a virtual thread and let the next tick start on time.
            channelRenewals.start(() -> {
                try {
                    var current = publicationVerifier.verify(original,
                            grant.publicationId(), grant.token());
                    producer.renew(context.lease(), context.binding(), current, channelId)
                            .toCompletableFuture().join();
                } catch (RuntimeException unavailable) {
                    // The grant is fenced or the channel is gone. The drain
                    // observes the same refusal, so this must not settle or
                    // abandon anything here.
                }
            });
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
