package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.AcceptanceVerdict;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;
import org.springframework.stereotype.Component;

/**
 * D7-2: a Turn input parks when its Turn failed after a submission no
 * Harness answered. The Session journal decides it: the prompt's
 * {@code submitInput} commit completes it, and a journal that no writer can
 * extend any more without that commit fails it with its Turn's code.
 */
@Component
public class TurnInputEvidence implements AcceptanceEvidence {
    private final AgentStateStore store;

    public TurnInputEvidence(AgentStateStore store) {
        this.store = store;
    }

    @Override
    public OperationKind kind() {
        return OperationKind.SUBMIT_INPUT;
    }

    @Override
    public AcceptanceVerdict read(OperationRecord operation) {
        return store.turnInputAcceptance(operation.tenantId(),
                operation.sessionId(), operation.operationId());
    }
}
