package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.session.AgentStateStore;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.util.function.Function;

/**
 * FG12b (issue #14447): a test-only record store that rejects one named step
 * of the MCP or Hook state machine from inside the real commit transaction. It
 * is registered only by the gate's {@code @TestConfiguration}; no product code
 * carries a fault seam.
 *
 * <p>FG13a adds the acknowledgement-loss mode: the commit goes through, and
 * the failure is reported from the transaction's after-commit callback. The
 * caller sees a lost acknowledgement over a durable record instead of a
 * rollback, which is what a store that committed and then lost its reply
 * looks like.
 */
public class FaultingExtensionRecordStore
        extends ManagedExtensionRecordStore {
    private final StoreFaultGate gate;

    public FaultingExtensionRecordStore(JdbcTemplate jdbc,
            AgentStateStore sessions, ManagedTaskEventStore taskEvents,
            StoreFaultGate gate) {
        super(jdbc, sessions, taskEvents);
        this.gate = gate;
    }

    @Override
    ApplyResult apply(String tenantId, String workspaceId, String sessionId,
            long firstSequence, int eventCount, byte[] recordBytes,
            Function<String, StoredResource> resources, long committedAt) {
        gate.inspect(recordBytes, resources);
        ApplyResult result = super.apply(tenantId, workspaceId, sessionId,
                firstSequence, eventCount, recordBytes, resources,
                committedAt);
        loseAckAfterCommit(recordBytes, resources);
        return result;
    }

    @Override
    ApplyResult applyNative(String tenantId, String workspaceId,
            String sessionId, long firstSequence, int eventCount,
            byte[] recordBytes, Function<String, StoredResource> resources,
            long committedAt) {
        gate.inspect(recordBytes, resources);
        ApplyResult result = super.applyNative(tenantId, workspaceId,
                sessionId, firstSequence, eventCount, recordBytes, resources,
                committedAt);
        loseAckAfterCommit(recordBytes, resources);
        return result;
    }

    /**
     * The row is only written here, inside the caller's transaction; reporting
     * the loss from this frame would roll the commit back. The callback runs
     * after the transaction manager commits, so the record stays durable.
     */
    private void loseAckAfterCommit(byte[] recordBytes,
            Function<String, StoredResource> resources) {
        if (!gate.ackArmed()) {
            return;
        }
        if (!TransactionSynchronizationManager.isSynchronizationActive()) {
            throw new IllegalStateException(
                    "Store ack loss needs an active transaction");
        }
        TransactionSynchronizationManager.registerSynchronization(
                new TransactionSynchronization() {
                    @Override
                    public void afterCommit() {
                        gate.afterApply(recordBytes, resources);
                    }
                });
    }
}
