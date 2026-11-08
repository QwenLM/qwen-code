package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeDrainReceipt;
import com.alibaba.qwen.code.runtimebroker.RuntimeLease;
import com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority;
import com.alibaba.qwen.code.runtimebroker.RuntimeObservation;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeRecoveryEvidence;
import com.alibaba.qwen.code.runtimebroker.RuntimeSession;
import com.alibaba.qwen.code.runtimebroker.RuntimeSessionRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeTransport;
import com.alibaba.qwen.code.runtimebroker.ToolExecutionRepository;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.conflict;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.failed;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.safeStage;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.unavailable;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.unwrap;

/**
 * The close cascade's drain-release arm, split out of RuntimeBrokerService:
 * drained Session release, retired-holder ownership clear, drained tool
 * acknowledgment and the acknowledged worker stop. Pure delegation — the
 * stages, receipts and refusal order are the ones the service ran inline.
 */
final class RuntimeDrainRelease {
    private final RuntimeBrokerService service;
    private final RuntimeSessionRepository sessionRepository;
    private final ToolExecutionRepository executionRepository;
    private final RuntimeTransport transport;
    private final RuntimeProvisioner provisioner;
    private final RuntimeExecutionDispatcher executionDispatcher;
    private final RuntimeBindingRepository bindingRepository;

    RuntimeDrainRelease(RuntimeBrokerService service, RuntimeSessionRepository sessionRepository,
            ToolExecutionRepository executionRepository, RuntimeTransport transport, RuntimeProvisioner provisioner,
            RuntimeExecutionDispatcher executionDispatcher, RuntimeBindingRepository bindingRepository) {
        this.service = service;
        this.sessionRepository = sessionRepository;
        this.executionRepository = executionRepository;
        this.transport = transport;
        this.provisioner = provisioner;
        this.executionDispatcher = executionDispatcher;
        this.bindingRepository = bindingRepository;
    }

    /**
     * Releases the drained Sessions, and escalates a worker that refuses to
     * release to the durable stop this drain arm already owns. Only the close
     * cascade reaches this path: a routine release never stops a worker.
     */
    CompletionStage<Void> releaseDrainedSessions(RuntimeBindingRecord binding,
            RuntimeBrokerService.BindingRenewal renewal, RuntimeLifecycleAuthority authority) {
        return drainSessions(binding, renewal, authority, null).exceptionallyCompose(error -> {
            if (!workerRefusedRelease(error) || !provisioner.supportsDrainedStop(binding)) {
                return CompletableFuture.<Void>failedFuture(error);
            }
            return safeStage(() -> {
                var current = renewal.requireDrainClaim();
                return current.getDrainReceipt() == null ? stopAcknowledgedRuntime(current, renewal, authority)
                        : CompletableFuture.completedFuture(current.getDrainReceipt());
            }).thenAccept(receipt -> renewal.persistDrainReceipt(receipt, authority))
                    .thenCompose(ignored -> drainSessions(binding, renewal, authority, null));
        });
    }

    private static boolean workerRefusedRelease(Throwable error) {
        Throwable cause = unwrap(error);
        return cause instanceof RuntimeBrokerException failure
                && ("managed_runtime_owner_hold_pending".equals(failure.getCode())
                        || "managed_runtime_release_timeout".equals(failure.getCode()));
    }

    /**
     * Clears durable Workspace ownership for Sessions this drain has retired.
     * Their worker is stopped and their rows are released, so no writer can
     * still hold the storage. Runs before the binding is marked RELEASED, so a
     * crash retries it; the exact-match clear cannot touch a newer holder.
     */
    CompletionStage<Void> releaseRetiredHolders(RuntimeBindingRecord binding, RuntimeBrokerService.BindingRenewal renewal,
            RuntimeLifecycleAuthority authority) {
        var current = renewal.requireDrainClaim();
        // Physical retirement is authorized only by the committed native receipt.
        if (!binding.getRequest().isManagedContext() || binding.getLease() == null
                || current.getDrainReceipt() == null) {
            return CompletableFuture.completedFuture(null);
        }
        return releaseRetiredHolders(current, renewal, authority, null);
    }

    private CompletionStage<Void> releaseRetiredHolders(RuntimeBindingRecord binding, RuntimeBrokerService.BindingRenewal renewal,
            RuntimeLifecycleAuthority authority, String cursor) {
        var batch = sessionRepository.findByBinding(binding.getBindingId(), binding.getGeneration(), cursor, 100);
        CompletionStage<Void> work = CompletableFuture.completedFuture(null);
        for (var record : batch) {
            if (record.isActive()) {
                continue;
            }
            work = work.thenCompose(ignored -> safeStage(() -> {
                var current = renewal.requireDrainClaim();
                if (current.getDrainReceipt() == null || !current.getDrainReceipt().matches(current)) {
                    throw conflict("workspace_close_identity_unverified", "Original stop receipt differs");
                }
                var session = record.getSession();
                if (authority != null) {
                    session = new RuntimeSession(session.getHarnessSessionId(), session.getRuntimeSessionId(),
                            session.getTurnKind(), session.getScope().withLifecycleAuthority(authority));
                }
                return transport.releaseRetired(current.getLease(), session);
            }))
                    .thenAccept(retired -> {
                        if (!Boolean.TRUE.equals(retired)) {
                            throw unavailable("runtime_session_release_failed",
                                    "Retired Session still owns Workspace storage");
                        }
                    });
        }
        return work.thenCompose(ignored -> batch.size() < 100
                ? CompletableFuture.completedFuture(null)
                : releaseRetiredHolders(binding, renewal, authority, batch.getLast().getRuntimeSessionId()));
    }

    private CompletionStage<Void> drainSessions(RuntimeBindingRecord binding, RuntimeBrokerService.BindingRenewal renewal,
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
                return service.releaseSavedSession(binding, record, renewal);
            });
        }
        return work.thenCompose(ignored -> batch.size() < 100 ? CompletableFuture.completedFuture(null)
                : drainSessions(binding, renewal, authority, batch.getLast().getRuntimeSessionId()));
    }

    CompletionStage<Void> acknowledgeDrainedTools(RuntimeBindingRecord binding, String cursor) {
        return acknowledgeDrainedTools(binding, cursor, null, null);
    }

    private CompletionStage<Void> acknowledgeDrainedTools(RuntimeBindingRecord binding, String cursor,
            RuntimeBrokerService.BindingRenewal renewal, RuntimeLifecycleAuthority authority) {
        if ((!com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.SSH_PROCESS.equals(binding.getRequest().getProvisionerKind())
                && !com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.isExternalWorkspaceRequest(binding.getRequest()))
                || binding.getLease() == null) {
            return CompletableFuture.completedFuture(null);
        }
        if (binding.getLease() == null) {
            return com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.isExternalWorkspaceRequest(binding.getRequest())
                    ? failed(conflict("workspace_close_identity_unverified", "Original worker lease is missing"))
                    : CompletableFuture.completedFuture(null);
        }
        var batch = executionRepository.findByBinding(binding.getBindingId(), binding.getGeneration(), cursor, 100);
        CompletionStage<Void> work = CompletableFuture.completedFuture(null);
        for (var execution : batch) {
            work = work.thenCompose(ignored -> executionDispatcher.acknowledgePersistedTools(
                    renewal == null ? binding : drainClaimForIo(renewal, authority), execution));
        }
        return work.thenCompose(ignored -> batch.size() < 100 ? CompletableFuture.completedFuture(null)
                : acknowledgeDrainedTools(binding, batch.getLast().getExecutionCallId(), renewal, authority));
    }

    private RuntimeBindingRecord drainClaimForIo(RuntimeBrokerService.BindingRenewal renewal, RuntimeLifecycleAuthority authority) {
        var current = renewal.requireDrainClaim(authority != null);
        if (authority != null) {
            bindingRepository.requireHarnessCleanup(current.getRequest().getScope(), current.getRequest().getIsolationKey(), authority);
            current = current.withLifecycleAuthority(authority);
        }
        return current;
    }

    /**
     * A restart-fenced external-workspace binding may still own a live worker
     * with one stale Session row. The drain marks it drain-requested, stops
     * that worker for the persisted receipt and re-checks for unsettled rows
     * before RELEASED, so refusing here would only fence the storage holder
     * with no exit. Executions in flight still refuse: nothing can settle
     * them without their worker.
     */
    static boolean isLiveWorkerStopRecoverable(RuntimeBindingRecord claimed, boolean lost,
            RuntimeRecoveryEvidence absence, boolean activeExecutions) {
        return lost && absence == null && claimed.getDrainReceipt() == null && !activeExecutions
                && com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile
                        .isExternalWorkspaceRequest(claimed.getRequest());
    }

    /**
     * Verifies that a drain receipt matches the claimed binding's identity,
     * including the external-workspace seed/lease/handle chain.
     */
    static void verifyDrainReceiptIdentity(RuntimeBindingRecord expected, RuntimeDrainReceipt receipt) {
        if (receipt == null || !receipt.matches(expected)
                || expected.getDrainReceipt() != null && !expected.getDrainReceipt().equals(receipt)
                || com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE.equals(expected.getRequest().getProvisionerKind())
                        && (!com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.isExternalWorkspaceRequest(expected.getRequest())
                                || expected.getResourceHandle() == null || expected.getProvisionSeed() == null
                                || expected.getLease() == null || !expected.getProvisionSeed().matches(expected.getLease())
                                || !expected.getResourceHandle().equals(receipt.resourceHandle()))) {
            throw conflict("workspace_close_identity_unverified", "Original stop receipt differs");
        }
    }

    CompletionStage<RuntimeDrainReceipt> stopAcknowledgedRuntime(RuntimeBindingRecord binding,
            RuntimeBrokerService.BindingRenewal renewal, RuntimeLifecycleAuthority authority) {
        if (!com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.isExternalWorkspaceRequest(binding.getRequest())) {
            return stopAcknowledgedRuntime(binding);
        }
        var current = drainClaimForIo(renewal, authority);
        if (executionRepository.hasActiveByBinding(current.getBindingId(), current.getGeneration())) {
            return failed(conflict("workspace_close_execution_unsettled", "Original resources are unsettled"));
        }
        return acknowledgeDrainedTools(current, null, renewal, authority)
                .thenCompose(ignored -> provisioner.stopDrained(drainClaimForIo(renewal, authority)));
    }

    private CompletionStage<RuntimeDrainReceipt> stopAcknowledgedRuntime(RuntimeBindingRecord binding) {
        if (com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.EXTERNAL_WORKSPACE.equals(binding.getRequest().getProvisionerKind())
                && (!com.alibaba.qwen.code.runtimebroker.WorkspaceExecutionProfile.isExternalWorkspaceRequest(binding.getRequest())
                        || executionRepository.hasActiveByBinding(binding.getBindingId(), binding.getGeneration()))) {
            return failed(conflict("workspace_close_identity_unverified", "External file drain is not verified"));
        }
        if (!com.alibaba.qwen.code.runtimebroker.protocol.RuntimeProviderKinds.SSH_PROCESS.equals(binding.getRequest().getProvisionerKind()) || binding.getLease() == null) {
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
                    RuntimeLease lease = binding.getLease();
                    if (!binding.getResourceHandle().equals(observation.getHandle())
                            || !lease.getRuntimeInstanceId().equals(observation.getRuntimeInstanceId())
                            || !lease.getLeaseId().equals(observation.getLeaseId()) || lease.getEpoch() != observation.getEpoch()
                            || !lease.getEndpoint().equals(observation.getEndpoint())) {
                        return RuntimeBrokerSupport.<RuntimeDrainReceipt>failed(conflict("workspace_close_identity_unverified",
                                "Original SSH worker identity changed"));
                    }
                    return acknowledgeDrainedTools(binding, null).thenCompose(ignored -> provisioner.stopDrained(binding));
                }).thenCompose(stage -> stage);
    }
}
