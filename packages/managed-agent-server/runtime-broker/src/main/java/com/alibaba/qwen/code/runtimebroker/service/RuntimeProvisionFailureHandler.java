package com.alibaba.qwen.code.runtimebroker.service;

import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeBindingRepository;
import com.alibaba.qwen.code.runtimebroker.RuntimeBrokerException;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisionRequest;
import com.alibaba.qwen.code.runtimebroker.RuntimeProvisioner;
import com.alibaba.qwen.code.runtimebroker.RuntimeResourceHandle;
import com.alibaba.qwen.code.runtimebroker.protocol.ExternalRuntimeKinds;

import java.time.Clock;
import java.util.Map;
import java.util.concurrent.CompletionException;
import java.util.concurrent.RejectedExecutionException;
import java.util.function.BiPredicate;

import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.conflict;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.unavailable;
import static com.alibaba.qwen.code.runtimebroker.service.RuntimeBrokerSupport.unwrap;

/** Preserves durable startup identity when classifying provisioning failures. */
final class RuntimeProvisionFailureHandler {
    private final RuntimeBindingRepository bindingRepository;
    private final RuntimeProvisioner provisioner;
    private final Clock clock;
    private final BiPredicate<RuntimeBindingRecord, Throwable> blockRecovery;

    RuntimeProvisionFailureHandler(RuntimeBindingRepository bindingRepository,
            RuntimeProvisioner provisioner, Clock clock,
            BiPredicate<RuntimeBindingRecord, Throwable> blockRecovery) {
        this.bindingRepository = bindingRepository;
        this.provisioner = provisioner;
        this.clock = clock;
        this.blockRecovery = blockRecovery;
    }

    /**
     * Retryable provider answers that keep an already-placed external worker
     * adoptable: capacity and unavailable/shutdown. Both external kinds share
     * them under scratch and under registered-storage (managed-context)
     * placement, so a transient provider answer never buries a recoverable
     * worker behind a permanent recovery block.
     */
    static boolean externalRetryable(RuntimeProvisionRequest request,
            RuntimeBrokerException failure) {
        return ExternalRuntimeKinds.isExternal(request.getProvisionerKind())
                && failure.getStatusCode() == 503
                && ("runtime_external_capacity".equals(failure.getCode())
                        || "runtime_external_unavailable".equals(failure.getCode()));
    }

    static boolean isLocalCapacityRefusal(RuntimeProvisionRequest request, Throwable error) {
        return "local-process".equals(request.getProvisionerKind())
                && unwrap(error) instanceof RuntimeBrokerException failure
                && failure.getStatusCode() == 503 && failure.isRetryable()
                && "runtime_local_capacity".equals(failure.getCode())
                && failure.getCause() instanceof RejectedExecutionException;
    }

    RuntimeException failure(RuntimeBindingRecord original,
            RuntimeBindingRecord current, Throwable cause, boolean localCapacityRefused) {
        boolean retryable = !(cause instanceof RuntimeBrokerException failure) || failure.isRetryable();
        // A retryable external-workspace failure keeps the binding recoverable
        // instead of blocking it: the provider may answer on retry.
        if (original.getRequest().isManagedContext()
                && RuntimeBrokerSupport.retryableExternalWorkspaceProvision(original.getRequest(), cause)) {
            return cause instanceof RuntimeBrokerException brokerFailure
                    ? new CompletionException(brokerFailure)
                    : unavailable("runtime_provision_failed", "Runtime provisioning failed", cause);
        }
        if (current != null) {
            if (localCapacityRefused && retainLocalCapacityRetry(original, current)) {
                return new CompletionException(cause);
            }
            if (current.getRequest().isManagedContext() || !retryable) {
                // A retry cannot succeed once the binding is blocked, so say so.
                if (blockRecovery.test(current, cause) && retryable) {
                    return conflict("runtime_broker_recovery_blocked",
                            "Managed Runtime recovery is blocked.", cause);
                }
            } else if (current.getResourceHandle() == null
                    // External ensureResource commits nothing before returning the handle.
                    && !ExternalRuntimeKinds.isExternal(current.getRequest().getProvisionerKind())) {
                blockRecovery.test(current, cause);
            }
        }
        return cause instanceof RuntimeBrokerException ? new CompletionException(cause)
                : unavailable("runtime_provision_failed", "Runtime provisioning failed", cause);
    }

    private boolean retainLocalCapacityRetry(RuntimeBindingRecord original, RuntimeBindingRecord current) {
        if (!current.getRequest().isManagedContext()
                || provisioner.supportsStartupRecovery(current.getResourceHandle())) {
            return true;
        }
        RuntimeResourceHandle placeholder = new RuntimeResourceHandle("local-process", 1,
                Map.of("provider", "local-process"));
        if (original.getResourceHandle() != null || current.getState() != RuntimeBindingRecord.State.PROVISIONING
                || current.getLease() != null || current.getAttestationGeneration() != 0) {
            return false;
        }
        if (current.getResourceHandle() == null) {
            return true;
        }
        if (!placeholder.equals(current.getResourceHandle())) {
            return false;
        }
        // No start occurred. Removing only this synthetic v1 placeholder lets
        // the same seed retry without authorizing recovery of a lost worker.
        if (bindingRepository.compareAndSet(current, current.withResourceHandle(null, clock.instant())) == null) {
            throw unavailable("runtime_provision_fenced", "Runtime provisioning claim expired");
        }
        return true;
    }
}
