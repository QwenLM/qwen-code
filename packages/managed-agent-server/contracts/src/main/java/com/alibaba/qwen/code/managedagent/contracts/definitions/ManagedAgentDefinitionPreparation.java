package com.alibaba.qwen.code.managedagent.contracts.definitions;

import com.alibaba.qwen.code.managedagent.model.ApiModels.AgentDefinition;

import java.time.Instant;

public interface ManagedAgentDefinitionPreparation {
    PrepareReceipt prepare(Command command);

    record Command(String tenantId, String actorId, String workspaceId,
            String executionScope, String operationKey,
            ManagedAgentDefinitionSource.Selection selection, Instant deadline) {
        public Command {
            SourceModelChecks.requireId("tenantId", tenantId);
            SourceModelChecks.requireId("actorId", actorId);
            SourceModelChecks.requireId("workspaceId", workspaceId);
            SourceModelChecks.requireId("executionScope", executionScope);
            SourceModelChecks.requireId("operationKey", operationKey);
            if (selection == null || deadline == null) {
                throw new IllegalArgumentException("Incomplete definition preparation command");
            }
        }
    }

    record OperationRef(String operationKey, boolean replayed) {
        public OperationRef {
            if (operationKey == null || operationKey.isBlank()) {
                throw new IllegalArgumentException("operationKey is required");
            }
        }
    }

    record PrepareReceipt(OperationRef operation, AgentDefinition definition) {
        public PrepareReceipt {
            if (operation == null || definition == null) {
                throw new IllegalArgumentException("PrepareReceipt is incomplete");
            }
        }
    }
}
