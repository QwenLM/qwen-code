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

    public CompletionStage<Void> closeResidentHarnessSession(RuntimeProvisionRequest request, String harnessSessionId);

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

    public CompletionStage<List<Map<String, Object>>> mcpDefinitions(String harnessSessionId, String runtimeSessionId);

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

    public CompletionStage<ToolExecutionRecord> prepareCsiExecution(String harnessSessionId, String runtimeSessionId,
            String idempotencyKey, Map<String, Object> reference, byte[] inputBytes, byte[] definitionBytes);

    public CompletionStage<Map<String, Object>> readCsiBatch(String harnessSessionId, String runtimeSessionId,
            String promptId, String batchId, Map<String, Object> recoveryOwner);

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
            String runtimeSessionId, Map<String, Object> publisher);

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
