package com.alibaba.qwen.code.managedagent.contracts.session;

import com.alibaba.qwen.code.managedagent.model.StoreModels;
import com.alibaba.qwen.code.managedagent.model.StoreModels.EventPage;
import com.alibaba.qwen.code.managedagent.model.StoreModels.EventRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.MaterializationResult;
import com.alibaba.qwen.code.managedagent.model.StoreModels.MaterializationTarget;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ReplayFloorTarget;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ReplayWindow;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnSummary;

import java.util.List;
import java.util.Map;

/**
 * Event and message reads, replay-floor advancement, materialization and
 * idempotent event appends.
 */
public interface EventProjectionStore {
    public Map<String, EventRecord> findLatestEnvironmentEvents(String tenantId,
            Map<String, TurnSummary> latestTurns);

    public List<EventRecord> findEvents(String tenantId, String sessionId,
            long afterSequence, int limit);

    public List<EventRecord> findControlEvents(String tenantId, String sessionId,
            long throughSequence);

    public EventPage findTranscriptEvents(String tenantId, String sessionId,
            Long beforeSequence, int limit);

    StoreModels.MessagePage findMessagePage(String tenantId, String sessionId,
            String cursor, int limit, boolean backward);

    StoreModels.MessagePage findMessagePage(String tenantId, String sessionId,
            String cursor, int limit, boolean backward, long afterSequence);

    Map<String, Long> findMessageCoveredSequences(String tenantId,
            List<String> sessionIds);

    public ReplayWindow findReplayWindow(String tenantId, String sessionId);

    List<ReplayFloorTarget> findReplayFloorTargets(int limit);

    public ReplayWindow advanceReplayFloor(String tenantId, String sessionId,
            long floorSequence);

    public List<MaterializationTarget> findMaterializationTargets(int limit);

    public MaterializationResult materializeNextBatch(String tenantId,
            String sessionId, int limit);

    public void deferMaterializationTarget(String tenantId, String sessionId);

    public void appendPublicEventIfAbsent(String tenantId, String sessionId,
            String turnId, String type, Map<String, Object> data,
            boolean terminal, String sourceKey);

    public void appendLiveSessionEventIfAbsent(String tenantId, String sessionId,
            String type, Map<String, Object> data, String sourceKey);
}
