package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.model.StoreModels.AcceptanceVerdict;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.model.StoreModels.OperationRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ParkedOperation;
import org.springframework.stereotype.Component;

import java.util.Optional;

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
    public String kind() {
        return OperationKind.SUBMIT_INPUT.name();
    }

    @Override
    public Optional<AcceptanceVerdict> read(ParkedOperation parked) {
        OperationRecord operation = store.findOperation(parked.tenantId(),
                parked.sessionId(), parked.operationId()).orElse(null);
        if (operation == null
                || !"RECOVERY_BLOCKED".equals(operation.state())) {
            return Optional.empty();
        }
        return Optional.of(store.turnInputAcceptance(parked.tenantId(),
                parked.sessionId(), parked.operationId()));
    }
}
