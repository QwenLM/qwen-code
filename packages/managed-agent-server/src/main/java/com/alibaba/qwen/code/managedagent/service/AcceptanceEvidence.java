package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.StoreModels.AcceptanceVerdict;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.OperationRecord;

/**
 * D7-2: what one acceptance-unknown kind's own keyed evidence proves about a
 * parked operation's command. An implementation reads only durable evidence
 * of that operation (its task record, its Turn and the Session journal),
 * never a wire answer or a state bit observed now, and never acts on the
 * command.
 */
public interface AcceptanceEvidence {
    OperationKind kind();

    AcceptanceVerdict read(OperationRecord operation);
}
