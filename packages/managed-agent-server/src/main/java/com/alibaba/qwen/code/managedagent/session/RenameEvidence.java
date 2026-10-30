package com.alibaba.qwen.code.managedagent.session;

import com.alibaba.qwen.code.managedagent.model.StoreModels.AcceptanceVerdict;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ParkedOperation;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract;
import org.springframework.stereotype.Component;

import java.util.Optional;

/**
 * D7-2: a Session title parks when its submitted delivery got no answer. The
 * Session journal decides it as it decides a Turn input: the Hosted
 * Harness's commit of that title revision completes it, and a journal that no
 * writer can extend any more without that commit fails it. Settling also
 * settles the title's command and, once committed, shows the title, so this
 * source owns its settle.
 */
@Component
public class RenameEvidence implements AcceptanceEvidence {
    private final AgentStateStore store;

    public RenameEvidence(AgentStateStore store) {
        this.store = store;
    }

    @Override
    public String kind() {
        return ManagedSchemaContract.OperationKind.RENAME.name();
    }

    @Override
    public Optional<AcceptanceVerdict> read(ParkedOperation parked) {
        return store.renameAcceptance(parked);
    }

    @Override
    public boolean settle(AgentStateStore store, ParkedOperation parked,
            AcceptanceVerdict verdict, long retryAt) {
        return store.settleParkedRename(parked, verdict, retryAt);
    }
}
