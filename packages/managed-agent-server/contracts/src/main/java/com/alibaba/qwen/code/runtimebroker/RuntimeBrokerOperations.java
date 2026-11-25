package com.alibaba.qwen.code.runtimebroker;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletionStage;

public interface RuntimeBrokerOperations {
    public RuntimeBindingRecord findLatestBindingByHarnessSession(
            String tenantId, String harnessSessionId);

    public RuntimeBindingRecord findLatestBindingByHarnessSessionAnyState(
            String tenantId, String harnessSessionId);

    public boolean supportsDrainedStop();

    public void requestHarnessDrain(String tenantId, String harnessSessionId);

    public CompletionStage<Void> drainHarnessSession(String tenantId, String harnessSessionId);

    public CompletionStage<Void> drainHarnessResources(String tenantId, String harnessSessionId,
            RuntimeLifecycleAuthority authority, boolean stoppedOnly);

    public CompletionStage<Void> prepareHarnessResources(String tenantId, String harnessSessionId,
            RuntimeLifecycleAuthority authority);

    public CompletionStage<Void> retireStorageBinding(String tenantId, String storageId,
            String operationId, String bindingId, long generation);

    public CompletionStage<RuntimeBindingRecord> warm(
            String harnessSessionId);

    public CompletionStage<RuntimeScope> capabilities(
            String harnessSessionId, RuntimeLifecycleAuthority authority);

    public default CompletionStage<HarnessSessionResolver.Capabilities> capabilitiesContext(
            String harnessSessionId, RuntimeLifecycleAuthority authority) {
        return capabilities(harnessSessionId, authority).thenApply(scope -> new HarnessSessionResolver.Capabilities(scope, null));
    }

    public CompletionStage<List<Map<String, Object>>> mcpDefinitions(String harnessSessionId, String runtimeSessionId);

    /**
     * Closes a parked owner's MCP connections and hands back its mount, without
     * a terminal release. Answers false when {@code parked} stops holding or
     * this process does not hold the live binding.
     */
    public default CompletionStage<Boolean> reclaimParkedMcp(String bindingId, long generation,
            String runtimeSessionId, java.util.function.BooleanSupplier parked) {
        return java.util.concurrent.CompletableFuture.completedFuture(false);
    }

    public CompletionStage<Map<String, Object>> extensionControl(String harnessSessionId, String expectedBindingId,
            Long expectedGeneration, Map<String, Object> operation);

    public CompletionStage<RuntimeBindingRecord> warm(String harnessSessionId, RuntimeLifecycleAuthority authority);

    public CompletionStage<RuntimeSessionRecord> acquire(String harnessSessionId, String runtimeSessionId,
            String turnKind, RuntimeLifecycleAuthority authority, String mountClaimId);

    public CompletionStage<RuntimeSessionRecord> acquireRecovery(String harnessSessionId, String runtimeSessionId,
            String bindingId, long generation, RuntimeLifecycleAuthority authority, String mountClaimId);

    public CompletionStage<RuntimeScope> authorizeLifecycle(String harnessSessionId, RuntimeLifecycleAuthority authority);

    public CompletionStage<Object> control(String harnessSessionId,
            String runtimeSessionId, Map<String, Object> operation, RuntimeLifecycleAuthority authority);

    public CompletionStage<ToolExecutionRecord> createExecution(
            String harnessSessionId, String runtimeSessionId,
            String idempotencyKey, Map<String, Object> reference);

    public CompletionStage<TerminalHoldAdmission> admitTerminalHold(
            String harnessSessionId, String terminalId);

    /** Discharges a terminal hold that this attach newly admitted and whose
     * worker attach never produced a PTY. Only the hold named by
     * {@code executionCallId} is settled, and only while it is still the active
     * prepared hold: a reconnect reuses a live PTY's hold, so a failed
     * reconnect must never discharge it, and a failed concurrent attach must
     * never discharge a successful one's hold. Returns null when the named hold
     * is not the active hold (already settled, replaced, or never created). */
    public CompletionStage<ToolExecutionRecord> abandonTerminalHold(
            String harnessSessionId, String terminalId, String executionCallId);

    /** Records that a reusing attach's worker terminal actually established a
     * PTY on the active hold. Only then does the hold protect a live PTY that
     * a failed concurrent attach must not discharge; a reuse whose worker
     * attach never produced a PTY leaves the hold dischargeable, so a double
     * attach that both fail cannot wedge the Session close. */
    public CompletionStage<Void> markTerminalPtyEstablished(
            String harnessSessionId, String terminalId);

    public CompletionStage<ToolExecutionRecord> prepareExecution(
            String harnessSessionId, String runtimeSessionId,
            String idempotencyKey, Map<String, Object> reference,
            String payloadDigest, String publicationId);

    public CompletionStage<ToolExecutionRecord> startExecution(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId, String payloadJson,
            String publicationId, String publicationToken);

    public CompletionStage<ToolExecutionRecord> startExecution(
            String harnessSessionId, String runtimeSessionId, String executionCallId);

    public CompletionStage<ToolExecutionRecord> getExecution(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId);

    public CompletionStage<List<String>> listActiveHoldRuntimeSessionIds(
            String harnessSessionId);

    public CompletionStage<Map<String, Object>> installPublisher(String harnessSessionId,
            String runtimeSessionId, Map<String, Object> publisher, Long writerGeneration);

    public default CompletionStage<Void> detachPublisher(
            String harnessSessionId,
            String runtimeSessionId,
            Long writerGeneration,
            Map<String, Long> appliedThrough) {
        return java.util.concurrent.CompletableFuture.failedFuture(new RuntimeBrokerException(501,
                "runtime_publisher_detach_unsupported",
                "Runtime Broker does not support Shell publisher detach.", false));
    }

    public default CompletionStage<List<Map<String, Object>>> listStagedDeliveries(
            String harnessSessionId, String writerId, long writerGeneration) {
        return java.util.concurrent.CompletableFuture.completedFuture(List.of());
    }

    public default CompletionStage<Void> acknowledgeStagedDeliveries(
            String harnessSessionId,
            String writerId,
            long writerGeneration,
            String executionCallId,
            long throughSeq) {
        return java.util.concurrent.CompletableFuture.completedFuture(null);
    }

    public CompletionStage<Map<String, Object>> acknowledgeExecution(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId, Map<String, Object> receipt);

    public CompletionStage<ToolExecutionRecord> cancelExecution(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId);

    public CompletionStage<ExecutionReconciliation> reconcileExecution(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId);

    public CompletionStage<ExecutionReconciliation> observeExecution(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId);

    public CompletionStage<Boolean> releaseOriginal(String harnessSessionId, String runtimeSessionId,
            String bindingId, long generation, RuntimeLifecycleAuthority authority, boolean drain);

    public CompletionStage<Boolean> release(String harnessSessionId,
            String runtimeSessionId, boolean drain, RuntimeLifecycleAuthority authority);

    public CompletionStage<Boolean> releaseMount(String harnessSessionId,
            String runtimeSessionId, String mountClaimId,
            RuntimeLifecycleAuthority authority);

    public CompletionStage<ToolExecutionRecord> observeBackgroundProcess(
            String harnessSessionId, String runtimeSessionId,
            String executionCallId);

    public CompletionStage<ToolExecutionRecord> stopBackgroundProcess(
            String tenantId, String harnessSessionId,
            String executionCallId);

    public CompletionStage<RuntimeBindingRecord> recoverBinding(String bindingId, long expectedGeneration);
}
