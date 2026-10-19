package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.persistence.ManagedSessionStoreModels.StoredResource;
import com.alibaba.qwen.code.managedagent.session.AgentStateStore;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.function.Function;

/**
 * FG12b (issue #14447): a test-only record store that rejects one named step
 * of the MCP state machine from inside the real commit transaction. It is
 * registered only by the gate's {@code @TestConfiguration}; no product code
 * carries a fault seam.
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
        return super.apply(tenantId, workspaceId, sessionId, firstSequence,
                eventCount, recordBytes, resources, committedAt);
    }

    @Override
    ApplyResult applyNative(String tenantId, String workspaceId,
            String sessionId, long firstSequence, int eventCount,
            byte[] recordBytes, Function<String, StoredResource> resources,
            long committedAt) {
        gate.inspect(recordBytes, resources);
        return super.applyNative(tenantId, workspaceId, sessionId,
                firstSequence, eventCount, recordBytes, resources,
                committedAt);
    }
}
