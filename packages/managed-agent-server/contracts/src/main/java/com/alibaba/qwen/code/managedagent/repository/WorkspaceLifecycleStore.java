package com.alibaba.qwen.code.managedagent.repository;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;
import com.alibaba.qwen.code.runtimebroker.RuntimeLifecycleAuthority;
import com.fasterxml.jackson.databind.JsonNode;

public interface WorkspaceLifecycleStore {
    public JsonNode recoverEffects(OperationRecord operation);

    public void saveEffects(OperationRecord operation, JsonNode receipt);

    public void verifyCompletion(OperationRecord operation);

    public void requireSettledExecutions(OperationRecord operation);

    public void verifyOutputContents(OperationRecord operation);

    public void verifyResources(OperationRecord operation);

    public static RuntimeLifecycleAuthority authority(OperationRecord operation) {
        return new RuntimeLifecycleAuthority(operation.operationId(), operation.claimGeneration());
    }

    public static ManagedAgentException blocked(String code) {
        return new ManagedAgentException(409, code, "Workspace lifecycle recovery is blocked.");
    }
}
