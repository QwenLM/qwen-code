package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.BrokerValues;
import com.alibaba.qwen.code.runtimebroker.HarnessSessionResolver;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeStageStore;
import com.alibaba.qwen.code.runtimebroker.RuntimeStageStore.PullableRun;
import com.alibaba.qwen.code.runtimebroker.RuntimeStageStore.PullerClaim;
import com.alibaba.qwen.code.runtimebroker.RuntimeStageStore.StageBatchRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeStageStore.StageOutcome;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBindingRegistry.BindingContext;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBindingRegistry.SessionContext;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.conflict;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.immutableMap;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.mapFailure;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.requireOpen;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.safeStage;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.unavailable;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.unwrap;

/**
 * Coordinates Phase 3b durable session adoption, publisher detach, staged
 * delivery queries/acknowledgements, and per-binding single-puller background
 * observation staging.
 */
final class RuntimeObservationCoordinator {
    private static final int DEFAULT_MAX_ENTRIES = 64;

    private final HarnessSessionResolver sessionResolver;
    private final RuntimeBindingRegistry bindingRegistry;
    private final RuntimeBindingProvisioning bindingProvisioning;
    private final RuntimeBindingRepository bindingRepository;
    private final RuntimeSessionRepository sessionRepository;
    private final RuntimeProvisioner provisioner;
    private final RuntimeTransport transport;
    private final RuntimeExecutionRecovery executionRecovery;
    private final String brokerOwnerId;
    private final Clock clock;
    private final AtomicBoolean closed;
    private final ScheduledExecutorService pullerExecutor;
    private final Map<String, PullerClaim> activeClaims = new ConcurrentHashMap<>();
    private final Map<String, RunPullState> runStates = new ConcurrentHashMap<>();

    private volatile RuntimeStageStore stageStore = RuntimeStageStore.NOOP;
    private volatile Duration claimDuration = Duration.ofSeconds(30);
    private volatile Duration scanInterval = Duration.ofSeconds(1);
    private volatile int pullWaitMs = 2_000;
    private volatile long attachedCooldownMs = 1_500L;
    private ScheduledFuture<?> scanTask;

    RuntimeObservationCoordinator(
            HarnessSessionResolver sessionResolver,
            RuntimeBindingRegistry bindingRegistry,
            RuntimeBindingProvisioning bindingProvisioning,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            RuntimeProvisioner provisioner,
            RuntimeTransport transport,
            RuntimeExecutionRecovery executionRecovery,
            String brokerOwnerId,
            Clock clock,
            AtomicBoolean closed) {
        this.sessionResolver = sessionResolver;
        this.bindingRegistry = bindingRegistry;
        this.bindingProvisioning = bindingProvisioning;
        this.bindingRepository = bindingRepository;
        this.sessionRepository = sessionRepository;
        this.provisioner = provisioner;
        this.transport = transport;
        this.executionRecovery = executionRecovery;
        this.brokerOwnerId = brokerOwnerId;
        this.clock = clock;
        this.closed = closed;
        ScheduledThreadPoolExecutor executor = new ScheduledThreadPoolExecutor(
                1,
                runnable -> {
                    Thread thread = new Thread(runnable, "qwen-runtime-observation-puller");
                    thread.setDaemon(true);
                    return thread;
                });
        executor.setRemoveOnCancelPolicy(true);
        this.pullerExecutor = executor;
    }

    synchronized void configureStageStore(
            RuntimeStageStore store,
            Duration claimLease,
            Duration pollScanInterval,
            int longPollWaitMs,
            long attachedPauseMs) {
        this.stageStore = store == null ? RuntimeStageStore.NOOP : store;
        if (claimLease != null) {
            this.claimDuration = claimLease;
        }
        if (pollScanInterval != null) {
            this.scanInterval = pollScanInterval;
        }
        if (longPollWaitMs >= 0) {
            this.pullWaitMs = longPollWaitMs;
        }
        if (attachedPauseMs >= 0) {
            this.attachedCooldownMs = attachedPauseMs;
        }
        if (scanTask != null) {
            scanTask.cancel(false);
            scanTask = null;
        }
        if (this.stageStore != RuntimeStageStore.NOOP && !closed.get()) {
            long delayMs = Math.max(25L, this.scanInterval.toMillis());
            scanTask = pullerExecutor.scheduleWithFixedDelay(
                    this::safeScanAndDrive, delayMs, delayMs, TimeUnit.MILLISECONDS);
        }
    }

    void kick() {
        if (stageStore == RuntimeStageStore.NOOP || closed.get()) {
            return;
        }
        pullerExecutor.execute(() -> {
            for (RunPullState state : runStates.values()) {
                state.pauseUntilMs = 0L;
            }
            safeScanAndDrive();
        });
    }

    CompletionStage<Void> runScanOnce() {
        CompletableFuture<Void> done = new CompletableFuture<>();
        pullerExecutor.execute(() -> {
            try {
                for (RunPullState state : runStates.values()) {
                    state.pauseUntilMs = 0L;
                }
                scanAndDrive();
                done.complete(null);
            } catch (Throwable error) {
                done.completeExceptionally(error);
            }
        });
        return done;
    }

    CompletionStage<SessionContext> requireOrAdoptReadySession(
            String harnessSessionId, String runtimeSessionId) {
        String harnessId = BrokerValues.requireHarnessSessionId(harnessSessionId, "harnessSessionId");
        String runtimeId = BrokerValues.requireRuntimeSessionId(runtimeSessionId, "runtimeSessionId");
        if (bindingRegistry.session(runtimeId) != null) {
            return bindingRegistry.requireReadySession(harnessId, runtimeId);
        }
        return bindingRegistry.persistedSession(harnessId, runtimeId)
                .thenCompose(saved -> {
                    if (saved.getState() != RuntimeSessionRecord.State.READY) {
                        throw conflict("runtime_session_not_ready", "Runtime Session is not ready");
                    }
                    RuntimeBindingRecord binding = bindingRepository.findById(saved.getBindingId());
                    if (binding == null || binding.getGeneration() != saved.getRuntimeGeneration()
                            || (binding.getState() != RuntimeBindingRecord.State.READY
                                    && binding.getState() != RuntimeBindingRecord.State.DRAINING)) {
                        throw conflict("runtime_admission_closed", "Runtime generation is no longer live");
                    }
                    return ensureLiveBinding(binding).thenCompose(live -> adoptSession(saved, live));
                })
                .thenCompose(ignored -> bindingRegistry.requireReadySession(harnessId, runtimeId));
    }

    CompletionStage<Map<String, Object>> installPublisher(
            String harnessSessionId,
            String runtimeSessionId,
            Map<String, Object> publisher,
            Long writerGeneration) {
        requireOpen(closed);
        Map<String, Object> descriptor = immutableMap(publisher, "publisher");
        CompletionStage<SessionContext> sessionStage = writerGeneration != null
                ? requireOrAdoptReadySession(harnessSessionId, runtimeSessionId)
                : bindingRegistry.requireReadySession(harnessSessionId, runtimeSessionId);
        return sessionStage.thenCompose(context -> {
            context.lock();
            try {
                bindingRegistry.requireReadySessionRecord(context);
                context.beginControl();
            } finally {
                context.unlock();
            }
            return safeStage(() -> {
                bindingRegistry.requireUsableLease(context);
                return transport.installPublisher(
                        context.lease(), context.session(), descriptor, writerGeneration);
            }).thenApply(workerResponse -> {
                kick();
                Map<String, Object> response = new LinkedHashMap<>();
                response.put("installed", true);
                response.put("bindingGeneration", Long.toString(context.binding().getGeneration()));
                if (workerResponse != null && workerResponse.get("observation") != null) {
                    response.put("observation", workerResponse.get("observation"));
                }
                if (workerResponse != null && workerResponse.get("observedRuns") != null) {
                    response.put("observedRuns", workerResponse.get("observedRuns"));
                }
                return response;
            }).whenComplete((ignored, error) -> context.endControl());
        });
    }

    CompletionStage<Void> detachPublisher(
            String harnessSessionId,
            String runtimeSessionId,
            Long writerGeneration,
            Map<String, Long> appliedThrough) {
        requireOpen(closed);
        if (writerGeneration != null && writerGeneration < 1) {
            throw new IllegalArgumentException("writerGeneration must be positive");
        }
        return requireOrAdoptReadySession(harnessSessionId, runtimeSessionId)
                .<Void>thenCompose(context -> {
                    if (writerGeneration != null && appliedThrough != null && !appliedThrough.isEmpty()) {
                        stageStore.acknowledgeOnDetach(
                                context.session().getScope().getTenantId(),
                                harnessSessionId,
                                writerGeneration,
                                appliedThrough);
                    }
                    bindingRegistry.requireUsableLease(context);
                    return mapFailure(
                            safeStage(() -> transport.detachPublisher(
                                    context.lease(), context.session(), writerGeneration)),
                            "runtime_publisher_detach_failed",
                            "Shell publisher detach failed");
                })
                .whenComplete((ignored, error) -> {
                    if (error == null) {
                        kick();
                    }
                });
    }

    CompletionStage<List<Map<String, Object>>> listStagedDeliveries(
            String harnessSessionId, String writerId, long writerGeneration) {
        requireOpen(closed);
        String sessionId = BrokerValues.requireHarnessSessionId(harnessSessionId, "harnessSessionId");
        String validWriter = BrokerValues.requireId(writerId, "writerId");
        if (writerGeneration < 1) {
            throw new IllegalArgumentException("writerGeneration must be positive");
        }
        return mapFailure(
                safeStage(() -> sessionResolver.resolveTenant(sessionId)),
                "runtime_scope_resolution_failed",
                "Runtime scope resolution failed")
                .thenApply(tenantId -> stageStore.listStagedDeliveries(
                        tenantId, sessionId, validWriter, writerGeneration));
    }

    CompletionStage<Void> acknowledgeStagedDeliveries(
            String harnessSessionId,
            String writerId,
            long writerGeneration,
            String executionCallId,
            long throughSeq) {
        requireOpen(closed);
        String sessionId = BrokerValues.requireHarnessSessionId(harnessSessionId, "harnessSessionId");
        String validWriter = BrokerValues.requireId(writerId, "writerId");
        String validCallId = BrokerValues.requireId(executionCallId, "executionCallId");
        if (writerGeneration < 1 || throughSeq < 0) {
            throw new IllegalArgumentException("writerGeneration and throughSeq must be valid");
        }
        return mapFailure(
                safeStage(() -> sessionResolver.resolveTenant(sessionId)),
                "runtime_scope_resolution_failed",
                "Runtime scope resolution failed")
                .thenAccept(tenantId -> {
                    stageStore.acknowledgeStagedDeliveries(
                            tenantId, sessionId, validWriter, writerGeneration, validCallId, throughSeq);
                    kick();
                });
    }

    void close() {
        if (scanTask != null) {
            scanTask.cancel(false);
        }
        for (PullerClaim claim : new ArrayList<>(activeClaims.values())) {
            try {
                stageStore.releaseBindingPuller(claim);
            } catch (RuntimeException ignored) {
                /* best-effort shutdown release */
            }
        }
        activeClaims.clear();
        runStates.clear();
        pullerExecutor.shutdownNow();
    }

    private CompletionStage<BindingContext> ensureLiveBinding(RuntimeBindingRecord binding) {
        BindingContext existing = bindingRegistry.matchingLiveBinding(binding);
        if (existing != null) {
            return CompletableFuture.completedFuture(existing);
        }
        if (binding.getRequest().requiresDurableIdentity()) {
            return bindingProvisioning.recoverBinding(binding.getBindingId(), binding.getGeneration(), true)
                    .thenApply(recovered -> {
                        BindingContext live = bindingRegistry.matchingLiveBinding(recovered);
                        if (live == null) {
                            throw unavailable(
                                    "runtime_reconciliation_required",
                                    "Recovered Runtime binding has no usable lease");
                        }
                        return live;
                    });
        }
        RuntimeLease lease = binding.getLease();
        if (lease != null && provisioner.isUsable(lease)) {
            bindingRegistry.registerBinding(binding, lease);
            return CompletableFuture.completedFuture(new BindingContext(binding, lease));
        }
        return CompletableFuture.failedFuture(unavailable(
                "runtime_reconciliation_required",
                "Runtime binding lease is unavailable in this Broker process"));
    }

    private CompletionStage<SessionContext> adoptSession(
            RuntimeSessionRecord saved, BindingContext live) {
        CompletableFuture<SessionContext> adopted = new CompletableFuture<>();
        CompletableFuture<SessionContext> existing = bindingRegistry.registerSession(
                saved.getRuntimeSessionId(), adopted);
        if (existing != null) {
            return existing;
        }
        safeStage(() -> executionRecovery.scanExecutions(
                new SessionContext(saved.getSession(), live.record(), live.lease()), saved, null))
                .whenComplete((context, error) -> {
                    if (error == null) {
                        adopted.complete(context);
                    } else {
                        bindingRegistry.removeSession(saved.getRuntimeSessionId(), adopted);
                        adopted.completeExceptionally(unwrap(error));
                    }
                });
        return adopted;
    }

    private void safeScanAndDrive() {
        if (closed.get() || stageStore == RuntimeStageStore.NOOP) {
            return;
        }
        try {
            scanAndDrive();
        } catch (RuntimeException ignored) {
            /* transient repository/transport scan errors retry on next tick */
        }
    }

    private void scanAndDrive() {
        List<PullableRun> runs = stageStore.findPullableRuns();
        Map<String, List<PullableRun>> byBinding = new LinkedHashMap<>();
        Set<String> activeCallIds = new HashSet<>();
        for (PullableRun run : runs) {
            String key = bindingKey(run.bindingId(), run.runtimeGeneration());
            byBinding.computeIfAbsent(key, ignored -> new ArrayList<>()).add(run);
            activeCallIds.add(run.executionCallId());
        }

        for (String callId : new ArrayList<>(runStates.keySet())) {
            RunPullState state = runStates.get(callId);
            if (!activeCallIds.contains(callId) && state != null && !state.inFlight) {
                runStates.remove(callId);
            }
        }

        for (Map.Entry<String, PullerClaim> entry : new ArrayList<>(activeClaims.entrySet())) {
            String key = entry.getKey();
            PullerClaim claim = entry.getValue();
            if (!byBinding.containsKey(key) && !hasInFlightForBinding(key)) {
                activeClaims.remove(key, claim);
                stageStore.releaseBindingPuller(claim);
            }
        }

        long nowMs = clock.millis();
        for (Map.Entry<String, List<PullableRun>> group : byBinding.entrySet()) {
            String key = group.getKey();
            PullableRun sample = group.getValue().getFirst();
            // Usability is local to this replica: claim only a binding whose
            // lease it can use, or it locks out the replica that can.
            RuntimeBindingRecord binding = bindingRepository.findById(sample.bindingId());
            if (binding == null || binding.getGeneration() != sample.runtimeGeneration()
                    || binding.getState() != RuntimeBindingRecord.State.READY
                    || binding.getLease() == null
                    || !provisioner.isUsable(binding.getLease())) {
                continue;
            }
            PullerClaim claim = ensureBindingClaim(key, sample.bindingId(), sample.runtimeGeneration());
            if (claim == null) {
                continue;
            }
            for (PullableRun run : group.getValue()) {
                RunPullState state = runStates.computeIfAbsent(
                        run.executionCallId(),
                        id -> new RunPullState(key, stageStore.highestStagedSequence(id)));
                if (state.inFlight || nowMs < state.pauseUntilMs) {
                    continue;
                }
                if (stageStore.isSessionAtHardCap(run.tenantId(), run.harnessSessionId())) {
                    continue;
                }
                driveRun(claim, binding.getLease(), run, state);
            }
        }
    }

    private boolean hasInFlightForBinding(String key) {
        for (RunPullState state : runStates.values()) {
            if (key.equals(state.bindingKey) && state.inFlight) {
                return true;
            }
        }
        return false;
    }

    private PullerClaim ensureBindingClaim(String key, String bindingId, long generation) {
        PullerClaim current = activeClaims.get(key);
        Instant now = clock.instant();
        if (current != null) {
            Duration remaining = Duration.between(now, current.leaseUntil());
            if (remaining.compareTo(claimDuration.dividedBy(2)) > 0) {
                return current;
            }
            PullerClaim renewed = stageStore.renewBindingPuller(current, claimDuration);
            if (renewed != null) {
                activeClaims.put(key, renewed);
                return renewed;
            }
            activeClaims.remove(key, current);
        }
        PullerClaim claimed = stageStore.claimBindingPuller(
                bindingId, generation, brokerOwnerId, claimDuration);
        if (claimed != null) {
            activeClaims.put(key, claimed);
        }
        return claimed;
    }

    @SuppressWarnings("unchecked")
    private void driveRun(
            PullerClaim claim,
            RuntimeLease lease,
            PullableRun run,
            RunPullState state) {
        if (closed.get()) {
            return;
        }
        state.inFlight = true;
        long sentAck = state.pendingAck;
        safeStage(() -> transport.pullObservations(
                lease,
                run.executionCallId(),
                state.afterSeq,
                sentAck,
                pullWaitMs,
                DEFAULT_MAX_ENTRIES))
                .whenCompleteAsync((response, error) -> {
                    state.inFlight = false;
                    if (closed.get()) {
                        return;
                    }
                    if (error != null || response == null) {
                        state.pauseUntilMs = clock.millis() + attachedCooldownMs;
                        return;
                    }
                    if (sentAck > state.ackedOnWorker) {
                        state.ackedOnWorker = sentAck;
                    }
                    String status = String.valueOf(response.get("status"));
                    if ("attached".equals(status) || "missing".equals(status)) {
                        state.pauseUntilMs = clock.millis() + attachedCooldownMs;
                        return;
                    }
                    if ("superseded".equals(status)) {
                        return;
                    }
                    Object rawEntries = response.get("entries");
                    List<Map<String, Object>> entries = rawEntries instanceof List<?> list
                            ? (List<Map<String, Object>>) list : List.of();
                    boolean closedOnWorker = Boolean.TRUE.equals(response.get("closed"));
                    if (entries.isEmpty()) {
                        if (!closedOnWorker) {
                            PullerClaim refreshed = ensureBindingClaim(
                                    state.bindingKey, run.bindingId(), run.runtimeGeneration());
                            if (refreshed != null && !stageStore.isSessionAtHardCap(
                                    run.tenantId(), run.harnessSessionId())) {
                                driveRun(refreshed, lease, run, state);
                            }
                        } else {
                            state.pauseUntilMs = clock.millis() + attachedCooldownMs;
                        }
                        return;
                    }
                    PullerClaim active = ensureBindingClaim(
                            state.bindingKey, run.bindingId(), run.runtimeGeneration());
                    if (active == null) {
                        return;
                    }
                    StageOutcome outcome = stageStore.stageBatch(new StageBatchRequest(
                            active,
                            run.tenantId(),
                            run.workspaceId(),
                            run.harnessSessionId(),
                            run.executionCallId(),
                            entries));
                    if (!outcome.committed()) {
                        activeClaims.remove(state.bindingKey, active);
                        return;
                    }
                    if (outcome.stagedThrough() > state.afterSeq) {
                        state.afterSeq = outcome.stagedThrough();
                        state.pendingAck = outcome.stagedThrough();
                    }
                    if (outcome.terminalSettled() || closedOnWorker) {
                        long finalAck = state.pendingAck;
                        safeStage(() -> transport.pullObservations(
                                lease, run.executionCallId(), state.afterSeq, finalAck, 0, 1))
                                .whenCompleteAsync((ackRes, ackErr) -> {
                                    if (ackErr == null) {
                                        state.ackedOnWorker = finalAck;
                                    }
                                    runStates.remove(run.executionCallId(), state);
                                }, pullerExecutor);
                        return;
                    }
                    if (!outcome.hardCapReached()) {
                        driveRun(active, lease, run, state);
                    } else if (state.pendingAck > state.ackedOnWorker) {
                        long capAck = state.pendingAck;
                        safeStage(() -> transport.pullObservations(
                                lease, run.executionCallId(), state.afterSeq, capAck, 0, 1))
                                .whenCompleteAsync((ackRes, ackErr) -> {
                                    if (ackErr == null && capAck > state.ackedOnWorker) {
                                        state.ackedOnWorker = capAck;
                                    }
                                }, pullerExecutor);
                    }
                }, pullerExecutor);
    }

    private static String bindingKey(String bindingId, long generation) {
        return bindingId + "@" + generation;
    }

    private static final class RunPullState {
        private final String bindingKey;
        private long afterSeq;
        private long pendingAck;
        private long ackedOnWorker;
        private long pauseUntilMs;
        private boolean inFlight;

        private RunPullState(String bindingKey, long initialSeq) {
            this.bindingKey = bindingKey;
            this.afterSeq = initialSeq;
            this.pendingAck = initialSeq;
            this.ackedOnWorker = initialSeq;
        }
    }
}
