package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.HarnessOwnership;
import com.alibaba.qwen.code.runtimebroker.RuntimeAttestation;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority;
import com.alibaba.qwen.code.runtimebroker.RuntimeObservation;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionSeed;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBindingRegistry.BindingContext;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerService.BindingRenewal;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;
import java.util.function.Supplier;

import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.conflict;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.failed;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.mapFailure;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.renewalDelayMillis;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.requireOpen;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.safeStage;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.unavailable;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.unwrap;

/**
 * Provisions, reconciles and recovers a Runtime binding on behalf of
 * {@link RuntimeBrokerService}: durable provisioning and attestation, the
 * bounded reconciliation loop, lost-binding cleanup, and the trusted
 * maintenance recovery path. Every step runs under this Broker's operation
 * claim, renewed by the service's {@code BindingRenewal}.
 */
final class RuntimeBindingProvisioning {
    private final RuntimeBindingRegistry bindingRegistry;
    private final RuntimeBindingRepository bindingRepository;
    private final RuntimeSessionRepository sessionRepository;
    private final ToolExecutionRepository executionRepository;
    private final RuntimeProvisioner provisioner;
    private final RuntimeTransport transport;
    private final String brokerOwnerId;
    private final Duration operationLeaseDuration;
    private final Clock clock;
    private final ScheduledExecutorService scheduler;
    private final AtomicBoolean closed;
    private final Function<RuntimeBindingRecord, BindingRenewal> renewals;
    private final RuntimeProvisionFailureHandler provisionFailureHandler;
    private final RuntimeProvisionLostRecovery lostRecovery;

    RuntimeBindingProvisioning(RuntimeBindingRegistry bindingRegistry,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository,
            RuntimeProvisioner provisioner,
            RuntimeTransport transport,
            String brokerOwnerId,
            Duration operationLeaseDuration,
            Clock clock,
            ScheduledExecutorService scheduler,
            AtomicBoolean closed,
            Function<RuntimeBindingRecord, BindingRenewal> renewals) {
        this.bindingRegistry = bindingRegistry;
        this.bindingRepository = bindingRepository;
        this.sessionRepository = sessionRepository;
        this.executionRepository = executionRepository;
        this.provisioner = provisioner;
        this.transport = transport;
        this.brokerOwnerId = brokerOwnerId;
        this.operationLeaseDuration = operationLeaseDuration;
        this.clock = clock;
        this.scheduler = scheduler;
        this.closed = closed;
        this.renewals = renewals;
        this.provisionFailureHandler = new RuntimeProvisionFailureHandler(bindingRepository, provisioner,
                clock, this::blockRecoveryQuietly);
        this.lostRecovery = new RuntimeProvisionLostRecovery(this, bindingRegistry, bindingRepository,
                sessionRepository, executionRepository, provisioner, brokerOwnerId, operationLeaseDuration, clock);
    }

    // Only a failure that is evidence about identity may block the recovery of
    // a restored binding. Other non-retryable transport codes say nothing
    // about who is behind the endpoint - a throttle or an incompatible route
    // answers 429, 408 or 404, which the transport reports as a
    // non-retryable incompatibility - and blocking on those would wedge the
    // binding behind an operator until the transient condition is forgotten.
    private static final Set<String> IDENTITY_FAILURES = Set.of(
            "managed_runtime_identity_conflict",
            "managed_runtime_unauthorized");

    CompletionStage<BindingContext> ensureBinding(
            RuntimeProvisionRequest request) {
        RuntimeBindingRecord record = bindingRepository.findOrCreate(request);
        if (request.getScope().getLifecycleAuthority() != null
                && (record.getState() == RuntimeBindingRecord.State.LOST
                        || record.getState() == RuntimeBindingRecord.State.DRAINING
                        || record.getState() == RuntimeBindingRecord.State.RELEASED)) {
            return failed(conflict("workspace_close_identity_unverified", "Original lifecycle Runtime is unavailable"));
        }
        if (record.getState() == RuntimeBindingRecord.State.READY) {
            CompletableFuture<BindingContext> finishing =
                    bindingRegistry.bindingOperation(record.getBindingId());
            if (finishing != null) {
                return finishing;
            }
            BindingContext live = bindingRegistry.matchingLiveBinding(record);
            if (live == null) {
                if (!record.getRequest().requiresDurableIdentity()) {
                    return failed(unavailable(
                            "runtime_reconciliation_required",
                            "persisted Runtime readiness requires adoption "
                                    + "or reconciliation in this Broker "
                                    + "process"));
                }
                return reconcileBinding(record);
            }
            BindingContext context = new BindingContext(record, live.lease());
            CompletableFuture<BindingContext> confirmed = new CompletableFuture<>();
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
                                    bindingRegistry.invalidateBinding(record);
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
            return lostRecovery.reclaimLostBinding(record, request);
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
        if (RuntimeBrokerSupport.shouldReconcileExternalWorkspace(request, record)) {
            return reconcileBinding(record);
        }
        CompletableFuture<BindingContext> created = new CompletableFuture<>();
        CompletableFuture<BindingContext> existing =
                bindingRegistry.reserveBinding(record.getBindingId(), created);
        if (existing != null) {
            return existing;
        }
        safeStage(() -> provisionBinding(record, request.getScope().getLifecycleAuthority())).whenComplete(
                (context, error) -> {
                    bindingRegistry.finishBindingOperation(record.getBindingId(), created);
                    if (error == null) {
                        created.complete(context);
                    } else {
                        created.completeExceptionally(unwrap(error));
                    }
                });
        return created;
    }

    private CompletionStage<BindingContext> provisionBinding(
            RuntimeBindingRecord record, RuntimeLifecycleAuthority authority) {
        RuntimeBindingRecord savedClaim = bindingRepository.claimOperation(
                record.getBindingId(), brokerOwnerId,
                operationLeaseDuration);
        if (savedClaim == null) {
            return failed(unavailable("runtime_provisioning_in_progress",
                    "another Broker owns Runtime provisioning"));
        }
        RuntimeBindingRecord claimed = savedClaim.withLifecycleAuthority(authority);
        if (claimed.getState()
                != RuntimeBindingRecord.State.PROVISIONING) {
            if (claimed.getState() == RuntimeBindingRecord.State.READY
                    && claimed.getRequest().requiresDurableIdentity()
                    && !bindingRegistry.isLiveBinding(claimed)) {
                return startReconciliation(claimed);
            }
            return claimed.getState() == RuntimeBindingRecord.State.READY
                    ? CompletableFuture.completedFuture(
                            bindingRegistry.requireLiveBinding(claimed))
                    : failed(unavailable("runtime_binding_unavailable",
                            "Runtime binding is not available"));
        }
        if (claimed.getRequest().requiresDurableIdentity()) {
            return provisionDurableBinding(claimed);
        }
        BindingRenewal renewal = renewals.apply(claimed);
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
                    bindingRegistry.registerBinding(ready, lease);
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
            bindingRegistry.releaseOperationQuietly(claimed.getBindingId(),
                    claimed.getOperationGeneration());
            return failed(conflict("runtime_broker_recovery_blocked",
                    "Managed Runtime recovery is blocked."));
        }
        RuntimeBindingRecord admitted;
        try {
            provisioner.reserveResource(claimed);
        } catch (RuntimeException failure) {
            // Pre-create admission has not committed a resource identity yet,
            // so any retryable failure leaves the binding PROVISIONING with its
            // original seed for a later Broker round. Once a handle exists,
            // only the capacity/busy answers are known to stay adoptable; the
            // external provisioner's retryable reserveResource outcomes are
            // exactly capacity and shutdown.
            boolean busy = failure instanceof RuntimeBrokerException brokerFailure && brokerFailure.isRetryable()
                    && (claimed.getResourceHandle() == null
                            || RuntimeProvisionFailureHandler.externalRetryable(request, brokerFailure)
                            || (request.isManagedContext() && brokerFailure.getStatusCode() == 409
                                    && "workspace_csi_busy".equals(brokerFailure.getCode()))
                            || (!request.isManagedContext()
                                    && "kubernetes-scratch".equals(request.getProvisionerKind())
                                    && brokerFailure.getStatusCode() == 503
                                    && "runtime_kubernetes_capacity".equals(brokerFailure.getCode())));
            if (!busy) {
                blockRecoveryQuietly(claimed, failure);
            }
            bindingRegistry.releaseOperationQuietly(claimed.getBindingId(), claimed.getOperationGeneration());
            return failed(failure);
        }
        try {
            admitted = bindingRepository.renewOperation(claimed.getBindingId(), brokerOwnerId,
                    claimed.getOperationGeneration(), operationLeaseDuration);
        } catch (RuntimeException failure) {
            blockRecoveryQuietly(claimed, failure);
            bindingRegistry.releaseOperationQuietly(claimed.getBindingId(), claimed.getOperationGeneration());
            return failed(failure);
        }
        if (admitted == null) {
            bindingRegistry.releaseOperationQuietly(claimed.getBindingId(), claimed.getOperationGeneration());
            return failed(unavailable("runtime_provision_fenced", "Runtime provisioning claim expired"));
        }
        BindingRenewal renewal = renewals.apply(admitted);
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
        AtomicBoolean localCapacityRefused = new AtomicBoolean();
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
                            && !RuntimeBrokerSupport.retryableExternalWorkspaceProvision(request, answer)
                            && blockRecoveryQuietly(timedOut, answer);
                } finally {
                    bindingRegistry.releaseOperationQuietly(bindingId, operationGeneration);
                    // A retry cannot succeed once the binding is blocked.
                    operation.completeExceptionally(blocked && failure == null
                            ? conflict("runtime_broker_recovery_blocked",
                                    "Managed Runtime recovery is blocked.")
                            : answer);
                }
            }, operationDeadlineNanos(), TimeUnit.NANOSECONDS);
        } catch (RuntimeException scheduleFailure) {
            renewal.stopAndGet();
            bindingRegistry.releaseOperationQuietly(bindingId, operationGeneration);
            return failed(scheduleFailure);
        }
        mapFailure(safeStage(() -> provisioner.ensureResource(request,
                seed, claimed.getResourceHandle())), "runtime_provision_failed",
                "Runtime provisioning failed")
                .whenComplete((handle, error) -> localCapacityRefused.set(
                        RuntimeProvisionFailureHandler.isLocalCapacityRefusal(request, error)))
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
                    return provisionAndAttest(request, seed, localCapacityRefused)
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
                            throw provisionFailureHandler.failure(claimed, currentClaim, cause, localCapacityRefused.get());
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
                        bindingRegistry.registerBinding(ready, ready.getLease());
                        return new BindingContext(ready, ready.getLease());
                    } finally {
                        bindingRegistry.releaseOperationQuietly(claimed.getBindingId(),
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
            RuntimeProvisionRequest request, RuntimeProvisionSeed seed, AtomicBoolean localCapacityRefused) {
        return safeStage(() -> provisioner.provision(request, seed))
                // Attestation errors after this stage are not pre-start admission evidence.
                .whenComplete((lease, error) -> localCapacityRefused.set(
                        RuntimeProvisionFailureHandler.isLocalCapacityRefusal(request, error)))
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
                bindingRegistry.reserveBinding(record.getBindingId(),
                        created);
        if (existing != null) {
            return existing;
        }
        safeStage(() -> startReconciliation(record)).whenComplete(
                (context, error) -> {
                    bindingRegistry.finishBindingOperation(record.getBindingId(), created);
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
            bindingRegistry.releaseOperationQuietly(claimed.getBindingId(),
                    claimed.getOperationGeneration());
            return failed(unavailable("runtime_binding_unavailable",
                    "Runtime binding is not available"));
        }
        if (claimed.getProvisionSeed() == null) {
            blockRecovery(claimed);
            bindingRegistry.releaseOperationQuietly(claimed.getBindingId(),
                    claimed.getOperationGeneration());
            return failed(conflict("runtime_broker_recovery_blocked",
                    "Managed Runtime recovery is blocked."));
        }
        String bindingId = claimed.getBindingId();
        long operationGeneration = claimed.getOperationGeneration();
        BindingRenewal renewal = renewals.apply(claimed);
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
            bindingRegistry.releaseOperationQuietly(bindingId, operationGeneration);
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
            bindingRegistry.releaseOperationQuietly(bindingId, operationGeneration);
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
                    bindingRegistry.releaseOperationQuietly(bindingId, operationGeneration);
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
                            latest = lostRecovery.renewRecoveryClaim(latest);
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
                            return lostRecovery.reclaimLostBindingNow(lost,
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
                    latest = lostRecovery.renewRecoveryClaim(latest);
                    RuntimeBindingRecord ready =
                            bindingRepository.compareAndSet(latest,
                                    latest.withAttestation(lease, handle,
                                            now, now));
                    if (ready == null) {
                        return failed(unavailable("runtime_provision_fenced",
                                "Runtime recovery claim expired"));
                    }
                    bindingRegistry.registerBinding(ready, lease);
                    return CompletableFuture.completedFuture(
                            new BindingContext(ready, lease));
                });
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
    RuntimeException mapStepTimeout(Throwable error) {
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
    <T> CompletionStage<T> renewingStep(RuntimeBindingRecord claimed,
            Supplier<CompletionStage<T>> step) {
        BindingRenewal renewal = renewals.apply(claimed);
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
    <T> CompletionStage<T> renewingStepOrNull(
            RuntimeBindingRecord claimed, Supplier<CompletionStage<T>> step) {
        BindingRenewal renewal = renewals.apply(claimed);
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

    /**
     * Close owns retirement after journal settlement. Observing its retired
     * registration as journal loss would erase the clean-stop boundary. One
     * Session's close never retires a shared binding; only storage retirement does.
     */
    private boolean retirementOwns(RuntimeBindingRecord binding) {
        RuntimeProvisionRequest request = binding.getRequest();
        String tenantId = request.getScope().getTenantId();
        if (HarnessOwnership.sharesRuntimeSessions(request)) {
            return request.getStorageId() != null
                    && bindingRepository.isStorageFenced(tenantId, request.getStorageId(), null);
        }
        return "session".equals(request.getScope().getIsolationClass())
                && (bindingRepository.isHarnessAdmissionClosed(tenantId, request.getIsolationKey())
                        || request.getStorageId() != null
                        && bindingRepository.isStorageFenced(tenantId, request.getStorageId(), null));
    }

    private boolean externalRecoveryEligible(RuntimeBindingRecord binding) {
        return binding != null
                && WorkspaceExecutionProfile.isExternalWorkspaceRequest(binding.getRequest())
                && "workspace".equals(
                        binding.getRequest().getScope().getIsolationClass())
                && (binding.getState() == RuntimeBindingRecord.State.READY
                        || binding.getState()
                                == RuntimeBindingRecord.State.RECOVERY_BLOCKED)
                && !binding.isDrainRequested() && binding.getLease() != null
                && binding.getProvisionSeed() != null
                && binding.getProvisionSeed().matches(binding.getLease())
                && !retirementOwns(binding)
                && !executionRepository.hasActiveByBinding(
                        binding.getBindingId(), binding.getGeneration());
    }

    CompletionStage<RuntimeBindingRecord> recoverBinding(String bindingId, long expectedGeneration, boolean lookupOnly) {
        return recoverBinding(bindingId, expectedGeneration, lookupOnly, null);
    }

    CompletionStage<RuntimeBindingRecord> recoverBinding(String bindingId, long expectedGeneration, boolean lookupOnly,
            Long expectedVersion) {
        requireOpen(closed);
        RuntimeBindingRecord record = bindingRepository.findById(bindingId);
        if (record == null || record.getGeneration() != expectedGeneration
                || !provisioner.supportsKind(record.getRequest().getProvisionerKind())) {
            return failed(conflict("runtime_broker_recovery_blocked", "Saved Runtime recovery is unavailable"));
        }
        if (expectedVersion != null
                && (record.getVersion() != expectedVersion
                        || !externalRecoveryEligible(record))) {
            return failed(conflict("runtime_broker_recovery_blocked",
                    "Recovery snapshot is stale or unsettled"));
        }
        if (!lookupOnly && record.getState() != RuntimeBindingRecord.State.LOST && retirementOwns(record)) {
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
        if (bindingRegistry.reserveBinding(bindingId, reservation) != null) {
            return failed(unavailable("runtime_reconcile_in_progress", "Runtime recovery is already in progress"));
        }
        RuntimeBindingRecord claimed;
        try {
            claimed = bindingRepository.claimOperation(bindingId, brokerOwnerId, operationLeaseDuration);
        } catch (RuntimeException error) {
            bindingRegistry.finishBindingOperation(bindingId, reservation);
            reservation.completeExceptionally(error);
            return failed(error);
        }
        CompletionStage<RuntimeBindingRecord> operation = safeStage(() -> {
            if (claimed == null || claimed.getGeneration() != expectedGeneration) {
                return failed(unavailable("runtime_reconcile_in_progress", "Another Broker owns Runtime recovery"));
            }
            // claimOperation 的原子版本递增必须紧接快照；恢复期间若有变更，
            // 不能把这个绑定重新放回 READY。
            if (expectedVersion != null
                    && (claimed.getVersion() != expectedVersion + 1
                            || !externalRecoveryEligible(claimed))) {
                return failed(conflict("runtime_broker_recovery_blocked",
                        "Recovery snapshot was fenced"));
            }
            if (expectedVersion != null) {
                // 与工具 admission 共用 binding 行 CAS。先关闭新写，
                // 再检查抢先进入的未决工具；失败时保持 BLOCKED。
                RuntimeBindingRecord fenced =
                        bindingRepository.compareAndSet(
                                claimed,
                                claimed.withState(
                                        RuntimeBindingRecord.State.RECOVERY_BLOCKED,
                                        claimed.getLease(),
                                        clock.instant()));
                if (fenced == null
                        || executionRepository.hasActiveByBinding(
                                fenced.getBindingId(),
                                fenced.getGeneration())) {
                    return failed(conflict("runtime_broker_recovery_blocked",
                            "Recovery admission is unsettled"));
                }
            }
            if (!lookupOnly && claimed.getState() != RuntimeBindingRecord.State.LOST && retirementOwns(claimed)) {
                return CompletableFuture.completedFuture(claimed);
            }
            if (claimed.getState() == RuntimeBindingRecord.State.LOST) {
                if (lookupOnly) {
                    return failed(conflict("workspace_close_identity_unverified", "Original Hook Runtime is lost"));
                }
                return lostRecovery.cleanupLost(claimed);
            }
            if (!canReconcile(claimed) && claimed.getState() != RuntimeBindingRecord.State.DRAINING) {
                return failed(conflict("runtime_broker_recovery_blocked", "Saved Runtime cannot be observed"));
            }
            return renewingStep(claimed, () -> provisioner.reconcile(claimed.getRequest(), claimed.getProvisionSeed(),
                    claimed.getResourceHandle(), claimed.getLease()))
                    .thenCompose(observed -> {
                        RuntimeBindingRecord current = lostRecovery.renewRecoveryClaim(claimed);
                        if (observed == null) {
                            return CompletableFuture.completedFuture(current);
                        }
                        if (lookupOnly && observed.getOutcome() != RuntimeObservation.Outcome.READY) {
                            return failed(conflict("workspace_close_identity_unverified", "Original Hook Runtime is unverified"));
                        }
                        if (observed.getOutcome() == RuntimeObservation.Outcome.NOT_FOUND
                                && observed.getLossEvidence() != null) {
                            RuntimeBindingRecord lost = bindingRepository.compareAndSet(current,
                                    current.withRecoveryEvidence(observed.getLossEvidence(),
                                            observed.getStopEvidence(), clock.instant()));
                            return lost == null
                                    ? failed(unavailable("runtime_provision_fenced", "Runtime recovery claim expired"))
                                    : lostRecovery.cleanupLost(lost);
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
                        bindingRegistry.releaseOperationQuietly(bindingId, claimed.getOperationGeneration());
                    }
                    if (recovered != null && recovered.getState() == RuntimeBindingRecord.State.RELEASED) {
                        bindingRegistry.forgetBinding(bindingId);
                    }
                    bindingRegistry.finishBindingOperation(bindingId, reservation);
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

    long operationDeadlineMillis() {
        return Math.max(1, operationDeadlineNanos() / 1_000_000);
    }

    static boolean validAttestation(RuntimeAttestation attestation,
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
                && Objects.equals(request.getStorageId(), attestation.getStorageId())
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

    private void failBinding(RuntimeBindingRecord claimed) {
        bindingRepository.compareAndSet(claimed, claimed.withState(
                RuntimeBindingRecord.State.FAILED, null, clock.instant()));
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
}
