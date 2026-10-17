package com.alibaba.qwen.code.managedagent.service;

import com.alibaba.qwen.code.managedagent.store.AgentStateStore;
import com.alibaba.qwen.code.managedagent.store.StoreModels.AcceptanceVerdict;
import com.alibaba.qwen.code.managedagent.store.StoreModels.ParkedOperation;

import java.util.List;
import java.util.Optional;

/**
 * D7-2: what one acceptance-unknown kind's own keyed evidence proves about a
 * parked operation's command. An implementation reads only durable evidence
 * of that operation (its task record, its Turn and the Session journal, the
 * registration marker on its node), never a wire answer or a state bit
 * observed now, and never sends the command again.
 */
public interface AcceptanceEvidence {
    /** The {@code ma_operation.operation_kind} this source decides. */
    String kind();

    /**
     * The verdict for a parked operation, or empty when the row is no longer
     * parked.
     */
    Optional<AcceptanceVerdict> read(ParkedOperation parked);

    /**
     * Records the verdict, only while the row is still parked. A kind whose
     * settlement has effects of its own (completing a registration,
     * releasing what it reserved) overrides this.
     *
     * @return false when the row is no longer parked
     */
    default boolean settle(AgentStateStore store, ParkedOperation parked,
            AcceptanceVerdict verdict, long retryAt) {
        return store.settleParkedOperation(parked, verdict, retryAt);
    }

    /**
     * The parked rows of a kind that belongs to no Session, which the
     * Session-scoped scan never reads.
     */
    default List<ParkedOperation> parked(int limit) {
        return List.of();
    }
}
