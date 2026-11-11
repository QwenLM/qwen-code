package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.HarnessOwnership;
import com.alibaba.qwen.code.runtimebroker.ResidentWorkspaceProfile;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeDrainReceipt;
import com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority;
import com.alibaba.qwen.code.runtimebroker.RuntimeObservation;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeRecoveryEvidence;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBindingRegistry.BindingContext;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBindingRegistry.SessionContext;

import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Function;

import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.conflict;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.failed;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.requireOpen;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.requireSameSession;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.safeStage;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.unavailable;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.unwrap;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.workerRefusedRelease;

/**
 * The drain/close cascade: harness drain, resident close, storage retirement,
 * and the stop-proof and receipt protocol that retires a binding's Sessions
 * and worker. Routine release never reaches this path.
 */
final class RuntimeDrainCoordinator {
    private final RuntimeBindingRegistry bindingRegistry;
    private final RuntimeBindingRepository bindingRepository;
    private final RuntimeSessionRepository sessionRepository;
    private final ToolExecutionRepository executionRepository;
    private final RuntimeProvisioner provisioner;
    private final RuntimeTransport transport;
    private final RuntimeBindingProvisioning bindingProvisioning;
    private final RuntimeExecutionRecovery executionRecovery;
    private final RuntimeExecutionDispatcher executionDispatcher;
    private final RuntimeSessionRelease sessionRelease;
    private final String brokerOwnerId;
    private final Duration operationLeaseDuration;
    private final Clock clock;
    private final AtomicBoolean closed;
    private final Function<RuntimeBindingRecord, BindingRenewal> renewals;

    RuntimeDrainCoordinator(RuntimeBindingRegistry bindingRegistry,
            RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository,
            RuntimeProvisioner provisioner,
            RuntimeTransport transport,
            RuntimeBindingProvisioning bindingProvisioning,
            RuntimeExecutionRecovery executionRecovery,
            RuntimeExecutionDispatcher executionDispatcher,
            RuntimeSessionRelease sessionRelease,
            String brokerOwnerId,
            Duration operationLeaseDuration,
            Clock clock,
            AtomicBoolean closed,
            Function<RuntimeBindingRecord, BindingRenewal> renewals) {
        this.bindingRegistry = bindingRegistry;
        this.bindingRepository = bindingRepository;
        this.sessionRepository = sessionRepository;
        this.executionRepository = executionRepository;
        this.provisioner = provisioner;
        this.transport = transport;
        this.bindingProvisioning = bindingProvisioning;
        this.executionRecovery = executionRecovery;
        this.executionDispatcher = executionDispatcher;
        this.sessionRelease = sessionRelease;
        this.brokerOwnerId = brokerOwnerId;
        this.operationLeaseDuration = operationLeaseDuration;
        this.clock = clock;
        this.closed = closed;
        this.renewals = renewals;
    }

    CompletionStage<Void> drainHarnessSession(String tenantId, String harnessSessionId) {
        requireOpen(closed);
        if (!bindingRepository.isHarnessDraining(tenantId, harnessSessionId)) {
            return failed(conflict("runtime_admission_closed", "A durable drain fence is required"));
        }
        return drainBindings(tenantId, harnessSessionId, null)
                .thenCompose(ignored -> settleHarnessSessions(tenantId, harnessSessionId, null, true, null));
    }

    CompletionStage<Void> closeResidentHarnessSession(RuntimeProvisionRequest request, String harnessSessionId) {
        requireOpen(closed);
        if (!ResidentWorkspaceProfile.selects(request)
                || !bindingRepository.isHarnessDraining(request.getScope().getTenantId(), harnessSessionId)) {
            return failed(conflict("runtime_admission_closed", "Resident close requires the original Session fence"));
        }
        var binding = bindingRepository.findActive(request);
        if (binding == null) {
            return CompletableFuture.completedFuture(null);
        }
        if (!request.equals(binding.getRequest()) || binding.getState() != RuntimeBindingRecord.State.READY
                || binding.isDrainRequested()) {
            return failed(conflict("workspace_close_identity_unverified", "Original resident binding is unavailable"));
        }
        return closeResidentSessions(binding, harnessSessionId, null);
    }

    private CompletionStage<Void> closeResidentSessions(RuntimeBindingRecord binding, String harnessSessionId, String cursor) {
        var batch = sessionRepository.findByBinding(binding.getBindingId(), binding.getGeneration(), cursor, 100);
        CompletionStage<Void> work = CompletableFuture.completedFuture(null);
        for (var record : batch) {
            if (record.isActive()) {
                if (!harnessSessionId.equals(record.getSession().getHarnessSessionId())) {
                    return failed(conflict("workspace_close_execution_unsettled", "Another resident Session remains active"));
                }
                work = work.thenCompose(ignored -> releaseSavedSession(binding, record, null));
            }
        }
        return work.thenCompose(ignored -> {
            if (batch.size() == 100) {
                return closeResidentSessions(binding, harnessSessionId, batch.getLast().getRuntimeSessionId());
            }
            var current = bindingRepository.findActive(binding.getRequest());
            if (current == null || !current.getBindingId().equals(binding.getBindingId())
                    || current.getGeneration() != binding.getGeneration() || current.getState() != RuntimeBindingRecord.State.READY
                    || current.isDrainRequested() || !current.hasSameLease(binding.getLease())
                    || !Objects.equals(current.getResourceHandle(), binding.getResourceHandle())
                    || sessionRepository.countActiveByBinding(binding.getBindingId(), binding.getGeneration()) != 0
                    || executionRepository.hasActiveByBinding(binding.getBindingId(), binding.getGeneration())) {
                return failed(conflict("workspace_close_execution_unsettled", "Original resident work remains unsettled"));
            }
            return CompletableFuture.completedFuture(null);
        });
    }

    CompletionStage<Void> drainHarnessResources(String tenantId, String harnessSessionId,
            RuntimeLifecycleAuthority authority, boolean stoppedOnly) {
        requireOpen(closed);
        if (!bindingRepository.isHarnessDraining(tenantId, harnessSessionId)) {
            return failed(conflict("runtime_admission_closed", "Resource drain requires DRAINING"));
        }
        // Per-Session evidence never needs a shared worker stopped, so stoppedOnly
        // applies to Session-isolated bindings alone.
        return drainResourceBindings(tenantId, harnessSessionId, authority, stoppedOnly, null)
                .thenCompose(ignored -> settleHarnessSessions(tenantId, harnessSessionId, authority, true, null));
    }

    CompletionStage<Void> prepareHarnessResources(String tenantId, String harnessSessionId,
            RuntimeLifecycleAuthority authority) {
        requireOpen(closed);
        if (!bindingRepository.isHarnessDraining(tenantId, harnessSessionId)) {
            return failed(conflict("runtime_admission_closed", "Resource drain requires DRAINING"));
        }
        return settleHarnessSessions(tenantId, harnessSessionId, authority, false, null);
    }

    /** Stops ordinary holds before MCP drains; shared workers remain owned by their other Sessions. */
    private CompletionStage<Void> settleHarnessSessions(String tenantId, String harnessSessionId,
            RuntimeLifecycleAuthority authority, boolean release, RuntimeSessionRecord after) {
        var batch = sessionRepository.findActiveByHarnessSession(tenantId, harnessSessionId, after, 100);
        CompletionStage<Void> work = CompletableFuture.completedFuture(null);
        for (var record : batch) {
            if (!tenantId.equals(record.getSession().getScope().getTenantId())
                    || !harnessSessionId.equals(record.getSession().getHarnessSessionId())) {
                return failed(conflict("workspace_close_identity_unverified", "Saved release scope differs"));
            }
            var binding = bindingRepository.findById(record.getBindingId());
            if (binding == null) {
                return failed(conflict("workspace_close_identity_unverified", "Saved release binding is missing"));
            }
            if (release && !HarnessOwnership.sharesRuntimeSessions(binding.getRequest())) {
                continue;
            }
            if (binding.getGeneration() != record.getRuntimeGeneration()
                    || binding.getState() != RuntimeBindingRecord.State.READY
                            && binding.getState() != RuntimeBindingRecord.State.DRAINING) {
                return failed(conflict("workspace_close_execution_unsettled", "Lost Runtime resources require recovery"));
            }
            work = work.thenCompose(ignored -> {
                if (authority != null) {
                    bindingRepository.requireHarnessCleanup(binding.getRequest(), record.getSession().getScope(),
                            harnessSessionId, authority);
                }
                return releaseSavedSession(binding, record, null, release);
            });
        }
        return work.thenCompose(ignored -> batch.size() < 100
                ? release ? requireSharedReleased(tenantId, harnessSessionId) : CompletableFuture.completedFuture(null)
                : settleHarnessSessions(tenantId, harnessSessionId, authority, release, batch.getLast()));
    }

    private CompletionStage<Void> requireSharedReleased(String tenantId, String harnessSessionId) {
        RuntimeSessionRecord after = null;
        List<RuntimeSessionRecord> batch;
        do {
            batch = sessionRepository.findActiveByHarnessSession(tenantId, harnessSessionId, after, 100);
            for (var record : batch) {
                var binding = bindingRepository.findById(record.getBindingId());
                if (binding == null || HarnessOwnership.sharesRuntimeSessions(binding.getRequest())) {
                    return failed(conflict("workspace_close_execution_unsettled", "Shared Runtime Sessions remain active"));
                }
            }
            after = batch.isEmpty() ? null : batch.getLast();
        } while (batch.size() == 100);
        return CompletableFuture.completedFuture(null);
    }

    private CompletionStage<Void> drainResourceBindings(String tenantId, String harnessSessionId,
            RuntimeLifecycleAuthority authority, boolean stoppedOnly, String cursor) {
        var batch = bindingRepository.findByHarnessSession(tenantId, harnessSessionId, cursor, 50);
        CompletionStage<Void> work = CompletableFuture.completedFuture(null);
        for (var binding : batch) {
            if (!tenantId.equals(binding.getRequest().getScope().getTenantId())
                    || !harnessSessionId.equals(binding.getRequest().getIsolationKey())) {
                return failed(conflict("workspace_close_identity_unverified", "Saved resource scope differs"));
            }
            if (CsiFilesRetirementProfile.isProfile(binding.getRequest().getScope())) {
                return failed(CsiFilesRetirementProfile.releaseUnavailable());
            }
            work = work.thenCompose(ignored -> {
                bindingRepository.requireHarnessCleanup(binding.getRequest().getScope(), harnessSessionId, authority);
                if (binding.getState() == RuntimeBindingRecord.State.RELEASED) {
                    if (binding.getDrainReceipt() == null || !binding.getDrainReceipt().matches(binding)) {
                        return failed(conflict("workspace_close_identity_unverified", "Original stop receipt is missing"));
                    }
                    return CompletableFuture.completedFuture(null);
                }
                if (stoppedOnly) {
                    if (binding.getLease() == null || binding.getProvisionSeed() == null || binding.getResourceHandle() == null) {
                        return failed(conflict("workspace_close_identity_unverified", "Original stop identity is incomplete"));
                    }
                    return provisioner.reconcile(binding.getRequest(), binding.getProvisionSeed(),
                            binding.getResourceHandle(), binding.getLease()).thenCompose(observation -> {
                                if (observation == null || observation.getOutcome() != RuntimeObservation.Outcome.NOT_FOUND
                                        || observation.getLossEvidence() == null || !observation.getLossEvidence().matches(
                                                binding.getProvisionSeed(), binding.getResourceHandle(), binding.getLease())) {
                                    return failed(conflict("workspace_close_identity_unverified", "Original worker stop is not proven"));
                                }
                                bindingRepository.requireHarnessCleanup(binding.getRequest().getScope(), harnessSessionId, authority);
                                return drainBinding(binding, observation.getLossEvidence(), authority);
                            });
                }
                return drainResourceSessions(binding, authority, null);
            });
        }
        return work.thenCompose(ignored -> batch.size() < 50 ? CompletableFuture.completedFuture(null)
                : drainResourceBindings(tenantId, harnessSessionId, authority, stoppedOnly, batch.getLast().getBindingId()));
    }

    private CompletionStage<Void> drainResourceSessions(RuntimeBindingRecord binding,
            RuntimeLifecycleAuthority authority, String cursor) {
        var batch = sessionRepository.findByBinding(binding.getBindingId(), binding.getGeneration(), cursor, 100);
        CompletionStage<Void> work = CompletableFuture.completedFuture(null);
        for (var record : batch) {
            if (!record.isActive()) {
                continue;
            }
            work = work.thenCompose(ignored -> {
                bindingRepository.requireHarnessCleanup(binding.getRequest().getScope(), record.getSession().getHarnessSessionId(), authority);
                return releaseSavedSession(binding, record, null);
            });
        }
        return work.thenCompose(ignored -> batch.size() < 100 ? CompletableFuture.completedFuture(null)
                : drainResourceSessions(binding, authority, batch.getLast().getRuntimeSessionId()));
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

    CompletionStage<Void> retireStorageBinding(String tenantId, String storageId,
            String operationId, String bindingId, long generation) {
        requireOpen(closed);
        var saved = bindingRepository.findById(bindingId);
        if (!bindingRepository.isStorageFenced(tenantId, storageId, operationId) || saved == null
                || saved.getGeneration() != generation
                || !tenantId.equals(saved.getRequest().getScope().getTenantId())
                || !storageId.equals(saved.getRequest().getStorageId())) {
            return failed(conflict("migration_conflict", "Original storage retirement identity differs"));
        }
        if (saved.getState() == RuntimeBindingRecord.State.RELEASED) {
            if (saved.getDrainReceipt() == null && !saved.hasStoppedWriters()) {
                return failed(conflict("workspace_migration_stop_unverified", "Original worker stop is unproven"));
            }
            return CompletableFuture.completedFuture(null);
        }
        return drainBinding(saved);
    }

    private CompletionStage<Void> drainBinding(RuntimeBindingRecord saved) {
        return drainBinding(saved, null, null);
    }

    private CompletionStage<Void> drainBinding(RuntimeBindingRecord saved,
            RuntimeRecoveryEvidence absence, RuntimeLifecycleAuthority authority) {
        if (saved.getState() == RuntimeBindingRecord.State.RELEASED) {
            return saved.getDrainReceipt() != null || saved.hasStoppedWriters()
                    ? CompletableFuture.completedFuture(null)
                    : failed(conflict("workspace_close_identity_unverified", "Released binding has no original stop proof"));
        }
        if (HarnessOwnership.sharesRuntimeSessions(saved.getRequest()) && (absence != null || authority != null
                || saved.getRequest().getStorageId() == null
                || !bindingRepository.isStorageFenced(saved.getRequest().getScope().getTenantId(),
                        saved.getRequest().getStorageId(), null))) {
            return failed(conflict("workspace_close_identity_unverified", "A shared binding retires only with its storage"));
        }
        if (!saved.getRequest().isManagedContext() || !provisioner.supportsDrainedStop(saved)
                || saved.getState() == RuntimeBindingRecord.State.OPERATOR_RECOVERY
                || saved.getState() == RuntimeBindingRecord.State.FAILED) {
            return failed(conflict("workspace_close_identity_unverified", "Original worker needs recovery"));
        }
        CompletableFuture<BindingContext> reservation = new CompletableFuture<>();
        if (bindingRegistry.reserveBinding(saved.getBindingId(), reservation) != null) {
            return failed(unavailable("runtime_close_claim_pending", "Original binding is still in use"));
        }
        return safeStage(() -> drainClaimedBinding(saved, absence, authority)).whenComplete((ignored, error) -> {
            bindingRegistry.finishBindingOperation(saved.getBindingId(), reservation);
            reservation.completeExceptionally(unavailable("runtime_admission_closed", "Session is draining"));
        });
    }

    private CompletionStage<Void> drainClaimedBinding(RuntimeBindingRecord saved,
            RuntimeRecoveryEvidence absence, RuntimeLifecycleAuthority authority) {
        var claimed = bindingRepository.claimOperation(saved.getBindingId(), brokerOwnerId, operationLeaseDuration);
        if (claimed == null) {
            return failed(unavailable("runtime_close_claim_pending", "Original binding is still claimed"));
        }
        boolean lost = claimed.getState() == RuntimeBindingRecord.State.LOST;
        if (absence != null && !absence.matches(claimed.getProvisionSeed(), claimed.getResourceHandle(), claimed.getLease())) {
            bindingRegistry.releaseOperationQuietly(claimed.getBindingId(), claimed.getOperationGeneration());
            return failed(conflict("workspace_close_identity_unverified", "Original worker stop identity changed"));
        }
        if ((lost || absence != null) && (executionRepository.hasActiveByBinding(claimed.getBindingId(), claimed.getGeneration())
                || absence == null && sessionRepository.countActiveByBinding(claimed.getBindingId(), claimed.getGeneration()) != 0)) {
            bindingRegistry.releaseOperationQuietly(claimed.getBindingId(), claimed.getOperationGeneration());
            return failed(conflict("workspace_close_execution_unsettled", "Lost Runtime resources require recovery"));
        }
        var draining = bindingRepository.compareAndSet(claimed, claimed.withDrainRequested(true, clock.instant())
                .withState(lost ? RuntimeBindingRecord.State.LOST : RuntimeBindingRecord.State.DRAINING,
                        claimed.getLease(), clock.instant()));
        if (draining == null) {
            bindingRegistry.releaseOperationQuietly(claimed.getBindingId(), claimed.getOperationGeneration());
            return failed(unavailable("runtime_close_claim_pending", "Drain claim changed"));
        }
        var renewal = renewals.apply(draining);
        renewal.start();
        CompletionStage<Void> result = safeStage(() -> {
            CompletionStage<Void> stopped = CompletableFuture.completedFuture(null);
            if (absence != null) {
                bindingRepository.requireHarnessCleanup(draining.getRequest().getScope(), draining.getRequest().getIsolationKey(), authority);
                var receipt = draining.getDrainReceipt();
                stopped = (receipt == null ? provisioner.stopDrained(draining) : CompletableFuture.completedFuture(receipt))
                        .thenAccept(proof -> {
                            bindingRepository.requireHarnessCleanup(draining.getRequest().getScope(), draining.getRequest().getIsolationKey(), authority);
                            renewal.persistDrainReceipt(proof, authority);
                        });
            }
            return stopped.thenCompose(ignored ->
                // The sessions release — and their sweep of provably ended
                // background exits — run BEFORE the unsettled gate: a row the
                // sweep can prove never blocks the close on a stale active.
                releaseDrainedSessions(draining, renewal, authority)).thenCompose(ignored -> {
                    if (sessionRepository.countActiveByBinding(draining.getBindingId(), draining.getGeneration()) != 0
                            || executionRepository.hasActiveByBinding(draining.getBindingId(), draining.getGeneration())) {
                        throw conflict("workspace_close_execution_unsettled", "Original resources are unsettled");
                    }
                    var receipt = renewal.currentRecord().getDrainReceipt();
                    return receipt == null ? stopAcknowledgedRuntime(draining)
                            : CompletableFuture.completedFuture(receipt);
                }).thenCompose(receipt -> releaseRetiredHolders(draining, renewal)
                        .thenApply(ignored -> receipt)).thenAccept(receipt -> {
                            if (authority != null) {
                                bindingRepository.requireHarnessCleanup(draining.getRequest().getScope(), draining.getRequest().getIsolationKey(), authority);
                            }
                            var current = renewal.stopAndGet();
                            if (current != null && authority != null) {
                                current = current.withLifecycleAuthority(authority);
                            }
                            if (current == null || bindingRepository.compareAndSet(current, current.withDrainReceipt(receipt)
                                    .withState(RuntimeBindingRecord.State.RELEASED, current.getLease(), clock.instant())) == null) {
                                throw unavailable("runtime_close_claim_pending", "Drain completion was fenced");
                            }
                            bindingRegistry.forgetBinding(draining.getBindingId());
                        });
        });
        return result.toCompletableFuture().orTimeout(bindingProvisioning.operationDeadlineMillis(), TimeUnit.MILLISECONDS)
                .whenComplete((ignored, error) -> {
                    renewal.close();
                    bindingRegistry.releaseOperationQuietly(draining.getBindingId(), draining.getOperationGeneration());
                }).exceptionally(error -> {
                    throw bindingProvisioning.mapStepTimeout(error);
                });
    }

    /**
     * Releases the drained Sessions, and escalates a worker that refuses to
     * release to the durable stop this drain arm already owns. Only the close
     * cascade reaches this path: a routine release never stops a worker.
     */
    private CompletionStage<Void> releaseDrainedSessions(RuntimeBindingRecord binding,
            BindingRenewal renewal, RuntimeLifecycleAuthority authority) {
        return drainSessions(binding, renewal, authority, null).exceptionallyCompose(error -> {
            if (!workerRefusedRelease(error) || !provisioner.supportsDrainedStop(binding)) {
                return CompletableFuture.<Void>failedFuture(error);
            }
            return safeStage(() -> provisioner.stopDrained(binding))
                    .thenAccept(receipt -> renewal.persistDrainReceipt(receipt, authority))
                    .thenCompose(ignored -> drainSessions(binding, renewal, authority, null));
        });
    }

    /**
     * Clears durable Workspace ownership for Sessions this drain has retired.
     * Their worker is stopped and their rows are released, so no writer can
     * still hold the storage. Runs before the binding is marked RELEASED, so a
     * crash retries it; the exact-match clear cannot touch a newer holder.
     */
    private CompletionStage<Void> releaseRetiredHolders(RuntimeBindingRecord binding, BindingRenewal renewal) {
        var current = renewal.currentRecord();
        // Only a persisted receipt can prove the worker stopped. On the plain
        // close path every holder was cleared by the acknowledged release, so
        // there is nothing to scan and nothing to clear.
        if (!binding.getRequest().isManagedContext() || binding.getLease() == null
                || current == null || current.getDrainReceipt() == null) {
            return CompletableFuture.completedFuture(null);
        }
        return releaseRetiredHolders(binding, (String) null);
    }

    private CompletionStage<Void> releaseRetiredHolders(RuntimeBindingRecord binding, String cursor) {
        var batch = sessionRepository.findByBinding(binding.getBindingId(), binding.getGeneration(), cursor, 100);
        CompletionStage<Void> work = CompletableFuture.completedFuture(null);
        for (var record : batch) {
            if (record.isActive()) {
                continue;
            }
            work = work.thenCompose(ignored -> safeStage(() ->
                    transport.releaseRetired(binding.getLease(), record.getSession())))
                    .thenAccept(retired -> {
                        if (!Boolean.TRUE.equals(retired)) {
                            throw unavailable("runtime_session_release_failed",
                                    "Retired Session still owns Workspace storage");
                        }
                    });
        }
        return work.thenCompose(ignored -> batch.size() < 100
                ? CompletableFuture.completedFuture(null)
                : releaseRetiredHolders(binding, batch.getLast().getRuntimeSessionId()));
    }

    private CompletionStage<Void> drainSessions(RuntimeBindingRecord binding, BindingRenewal renewal,
            RuntimeLifecycleAuthority authority, String cursor) {
        var batch = sessionRepository.findByBinding(binding.getBindingId(), binding.getGeneration(), cursor, 100);
        CompletionStage<Void> work = CompletableFuture.completedFuture(null);
        for (var record : batch) {
            if (!record.isActive()) {
                continue;
            }
            work = work.thenCompose(ignored -> {
                if (authority != null) {
                    if (!renewal.releaseStoppedSession(record, authority)) {
                        return failed(conflict("workspace_close_identity_unverified", "Original stop receipt is missing"));
                    }
                    return CompletableFuture.completedFuture(null);
                }
                return releaseSavedSession(binding, record, renewal);
            });
        }
        return work.thenCompose(ignored -> batch.size() < 100 ? CompletableFuture.completedFuture(null)
                : drainSessions(binding, renewal, authority, batch.getLast().getRuntimeSessionId()));
    }

    private CompletionStage<Void> acknowledgeDrainedTools(RuntimeBindingRecord binding, String cursor) {
        if (!RuntimeProviderKinds.SSH_PROCESS.equals(binding.getRequest().getProvisionerKind()) || binding.getLease() == null) {
            return CompletableFuture.completedFuture(null);
        }
        var batch = executionRepository.findByBinding(binding.getBindingId(), binding.getGeneration(), cursor, 100);
        CompletionStage<Void> work = CompletableFuture.completedFuture(null);
        for (var execution : batch) {
            work = work.thenCompose(ignored -> executionDispatcher.acknowledgePersistedTools(binding, execution));
        }
        return work.thenCompose(ignored -> batch.size() < 100 ? CompletableFuture.completedFuture(null)
                : acknowledgeDrainedTools(binding, batch.getLast().getExecutionCallId()));
    }

    private CompletionStage<RuntimeDrainReceipt> stopAcknowledgedRuntime(RuntimeBindingRecord binding) {
        if (!RuntimeProviderKinds.SSH_PROCESS.equals(binding.getRequest().getProvisionerKind()) || binding.getLease() == null) {
            return acknowledgeDrainedTools(binding, null).thenCompose(ignored -> provisioner.stopDrained(binding));
        }
        return safeStage(() -> provisioner.reconcile(binding.getRequest(), binding.getProvisionSeed(),
                binding.getResourceHandle(), binding.getLease())).handle((observation, error) -> {
                    if (error != null) {
                        Throwable cause = unwrap(error);
                        if (cause instanceof RuntimeBrokerException failure && failure.getCode().contains("conflict")) {
                            return RuntimeBrokerSupport.<RuntimeDrainReceipt>failed(failure);
                        }
                        return safeStage(() -> provisioner.stopDrained(binding));
                    }
                    if (observation == null || observation.getOutcome() != RuntimeObservation.Outcome.READY) {
                        return safeStage(() -> provisioner.stopDrained(binding));
                    }
                    if (!observation.matchesRuntime(binding.getResourceHandle(), binding.getLease())) {
                        return RuntimeBrokerSupport.<RuntimeDrainReceipt>failed(conflict("workspace_close_identity_unverified",
                                "Original SSH worker identity changed"));
                    }
                    return acknowledgeDrainedTools(binding, null).thenCompose(ignored -> provisioner.stopDrained(binding));
                }).thenCompose(stage -> stage);
    }

    CompletionStage<Void> releaseSavedSession(RuntimeBindingRecord binding, RuntimeSessionRecord record,
            BindingRenewal renewal) {
        return releaseSavedSession(binding, record, renewal, true);
    }

    private CompletionStage<Void> releaseSavedSession(RuntimeBindingRecord binding, RuntimeSessionRecord record,
            BindingRenewal renewal, boolean release) {
        if (binding.getLease() == null || binding.getProvisionSeed() == null || binding.getResourceHandle() == null
                || !(ResidentWorkspaceProfile.selects(binding.getRequest())
                        || HarnessOwnership.sharesRuntimeSessions(binding.getRequest())
                        || record.getSession().getHarnessSessionId().equals(binding.getRequest().getIsolationKey()))
                || !binding.getRequest().getScope().equals(record.getSession().getScope())) {
            return failed(conflict("workspace_close_identity_unverified", "Saved release identity is incomplete"));
        }
        if (renewal != null && renewal.releaseStoppedSession(record)) {
            return CompletableFuture.completedFuture(null);
        }
        CompletionStage<SessionContext> context = bindingRegistry.session(record.getRuntimeSessionId());
        CompletionStage<Void> result;
        if (context == null) {
            result = provisioner.reconcile(binding.getRequest(), binding.getProvisionSeed(),
                    binding.getResourceHandle(), binding.getLease()).thenCompose(observation -> {
                        if (observation != null
                                && observation.getOutcome() == RuntimeObservation.Outcome.NOT_FOUND
                                && observation.getLossEvidence() != null
                                && observation.getLossEvidence().matches(binding.getProvisionSeed(),
                                        binding.getResourceHandle(), binding.getLease())) {
                            if (!release) {
                                return failed(conflict("workspace_close_identity_unverified", "Original worker cannot prepare its resources"));
                            }
                            // A lost shared worker settles through the loss path; one
                            // Session's close never retires the binding.
                            if (ResidentWorkspaceProfile.selects(binding.getRequest())
                                    || renewal == null && HarnessOwnership.sharesRuntimeSessions(binding.getRequest())) {
                                return failed(conflict("workspace_close_identity_unverified", "Original resident worker is unavailable"));
                            }
                            if (renewal == null) {
                                return drainBinding(binding);
                            }
                            if (executionRepository.hasActiveByBinding(binding.getBindingId(), binding.getGeneration())) {
                                throw conflict("workspace_close_execution_unsettled", "Original resources are unsettled");
                            }
                            // Absence cannot confirm a Session release. Persist the
                            // original worker's stop receipt before releasing its rows.
                            return provisioner.stopDrained(binding).thenAccept(receipt -> {
                                renewal.persistDrainReceipt(receipt);
                                renewal.releaseStoppedSession(record);
                            });
                        }
                        if (observation == null || observation.getOutcome() != RuntimeObservation.Outcome.READY
                                || !observation.matchesRuntime(binding.getResourceHandle(), binding.getLease())) {
                            throw conflict("workspace_close_identity_unverified", "Original worker cannot be observed");
                        }
                        var adopted = CompletableFuture.completedFuture(
                                new SessionContext(record.getSession(), binding, binding.getLease()));
                        var existing = bindingRegistry.registerSession(record.getRuntimeSessionId(), adopted);
                        return releaseOriginalSession(binding, record, existing == null ? adopted : existing, release)
                                .whenComplete((ignored, error) -> {
                                    if (existing == null && error != null) {
                                        bindingRegistry.removeSession(record.getRuntimeSessionId(), adopted);
                                    }
                                });
                    });
        } else {
            result = releaseOriginalSession(binding, record, context, release);
        }
        return result.exceptionallyCompose(error -> {
            Throwable cause = unwrap(error);
            if (cause instanceof RuntimeBrokerException failure && !failure.isRetryable()) {
                return failed(conflict("workspace_close_identity_unverified", "Original Session release cannot be confirmed", cause));
            }
            return failed(cause);
        });
    }

    private CompletionStage<Void> releaseOriginalSession(RuntimeBindingRecord binding, RuntimeSessionRecord record,
            CompletionStage<SessionContext> context, boolean release) {
        return context.thenCompose(original -> {
            requireSameSession(original.session(), record.getSession());
            if (!original.binding().getBindingId().equals(binding.getBindingId())
                    || original.binding().getGeneration() != binding.getGeneration()) {
                throw conflict("workspace_close_identity_unverified", "Release generation differs");
            }
            if (!release) {
                return executionRecovery.settleUnprovenBackgroundRows(original, true).thenRun(() -> {
                    original.lock();
                    try {
                        if (original.hasActiveControl() || executionRepository.hasActiveByRuntimeSession(
                                binding.getBindingId(), binding.getGeneration(), record.getRuntimeSessionId())) {
                            throw conflict("workspace_close_execution_unsettled", "Original background work is unsettled");
                        }
                    } finally {
                        original.unlock();
                    }
                });
            }
            // The close cascade's release is the drain arm: a live hold row
            // gets its stop here, where the caller's fence can wait for the
            // proof, never on a turn's routine release.
            return sessionRelease.releaseSession(original, true).thenAccept(released -> {
                if (!Boolean.TRUE.equals(released)) {
                    throw unavailable("runtime_session_release_failed", "Original Session has not released");
                }
            });
        });
    }
}
