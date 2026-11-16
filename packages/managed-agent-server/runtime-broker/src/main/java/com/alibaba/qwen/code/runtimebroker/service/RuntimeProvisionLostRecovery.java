package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.CsiFilesRetirementProfile;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeObservation;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;
import com.alibaba.qwen.code.runtimebroker.service.RuntimeBindingRegistry.BindingContext;

import java.time.Clock;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.failed;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.safeStage;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.unavailable;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.unwrap;

/**
 * The lost-binding recovery arm of provisioning: the single-flighted
 * reclaim, the bounded drain passes and the recovery-claim renewal. Split
 * out of RuntimeBindingProvisioning verbatim; the claim fencing, pass budget
 * and refusal codes are the ones provisioning ran inline.
 */
final class RuntimeProvisionLostRecovery {
    private final RuntimeBindingProvisioning provisioning;
    private final RuntimeBindingRegistry bindingRegistry;
    private final RuntimeBindingRepository bindingRepository;
    private final RuntimeSessionRepository sessionRepository;
    private final ToolExecutionRepository executionRepository;
    private final RuntimeProvisioner provisioner;
    private final String brokerOwnerId;
    private final Duration operationLeaseDuration;
    private final Clock clock;

    RuntimeProvisionLostRecovery(RuntimeBindingProvisioning provisioning,
            RuntimeBindingRegistry bindingRegistry, RuntimeBindingRepository bindingRepository,
            RuntimeSessionRepository sessionRepository, ToolExecutionRepository executionRepository,
            RuntimeProvisioner provisioner, String brokerOwnerId, Duration operationLeaseDuration, Clock clock) {
        this.provisioning = provisioning;
        this.bindingRegistry = bindingRegistry;
        this.bindingRepository = bindingRepository;
        this.sessionRepository = sessionRepository;
        this.executionRepository = executionRepository;
        this.provisioner = provisioner;
        this.brokerOwnerId = brokerOwnerId;
        this.operationLeaseDuration = operationLeaseDuration;
        this.clock = clock;
    }

    // A reclaim drains at most this many bounded 100-row passes per call;
    // a larger generation answers runtime_broker_runtime_lost and the next
    // reclaim resumes where this one stopped.
    private static final int MAX_RECOVERY_PASSES = 16;

    /**
     * Lost executions can be terminated by journal-loss evidence; releasing
     * their Sessions and placement additionally requires writer-stop proof.
     * Reclamation
     * is single-flighted with reconciliation on the same binding key; the
     * reconciliation loop calls the inner body directly because it already
     * holds that key.
     */
    CompletionStage<BindingContext> reclaimLostBinding(
            RuntimeBindingRecord record, RuntimeProvisionRequest request) {
        CompletableFuture<BindingContext> created = new CompletableFuture<>();
        CompletableFuture<BindingContext> existing =
                bindingRegistry.reserveBinding(record.getBindingId(), created);
        if (existing != null) {
            return existing;
        }
        safeStage(() -> reclaimLostBindingNow(record, request)).whenComplete(
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

    CompletionStage<BindingContext> reclaimLostBindingNow(
            RuntimeBindingRecord record, RuntimeProvisionRequest request) {
        if (CsiFilesRetirementProfile.isProfile(record.getRequest().getScope())) {
            return failed(CsiFilesRetirementProfile.releaseUnavailable());
        }
        RuntimeBindingRecord claimed = bindingRepository.claimOperation(
                record.getBindingId(), brokerOwnerId, operationLeaseDuration);
        if (claimed == null || claimed.getState() != RuntimeBindingRecord.State.LOST) {
            if (claimed != null) {
                bindingRegistry.releaseOperationQuietly(claimed.getBindingId(), claimed.getOperationGeneration());
            }
            return failed(unavailable("runtime_binding_unavailable", "Runtime binding is not available"));
        }
        return cleanupLost(claimed).whenComplete((ignored, error) -> bindingRegistry.releaseOperationQuietly(
                claimed.getBindingId(), claimed.getOperationGeneration())).thenCompose(recovered -> {
                    if (recovered.getState() != RuntimeBindingRecord.State.RELEASED) {
                        return failed(unavailable("runtime_broker_runtime_lost",
                                "Runtime is lost; recovery requires complete evidence and cleanup"));
                    }
                    bindingRegistry.forgetBinding(recovered.getBindingId());
                    return provisioning.ensureBinding(request);
                });
    }

    CompletionStage<RuntimeBindingRecord> cleanupLost(RuntimeBindingRecord claimed) {
        if (CsiFilesRetirementProfile.isProfile(claimed.getRequest().getScope())) {
            return failed(CsiFilesRetirementProfile.releaseUnavailable());
        }
        return safeStage(() -> {
            RuntimeBindingRecord recovered = recoverLostDrained(claimed,
                    false);
            if (recovered.getState() == RuntimeBindingRecord.State.RELEASED) {
                return CompletableFuture.completedFuture(recovered);
            }
            CompletionStage<RuntimeObservation> observation = recovered.hasStoppedWriters()
                    ? CompletableFuture.completedFuture(null)
                    : provisioning.renewingStepOrNull(claimed, () -> {
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
                return provisioning.renewingStep(claimed,
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
    RuntimeBindingRecord recoverLostDrained(
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
    RuntimeBindingRecord renewRecoveryClaim(RuntimeBindingRecord claimed) {
        RuntimeBindingRecord renewed = bindingRepository.renewOperation(
                claimed.getBindingId(), brokerOwnerId,
                claimed.getOperationGeneration(), operationLeaseDuration);
        if (renewed == null) {
            throw unavailable("runtime_provision_fenced", "Runtime recovery claim expired");
        }
        return renewed;
    }
}
