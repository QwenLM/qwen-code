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
    /**
     * The latest environment event of each Session's latest Turn, in one
     * round trip.
     */
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

    /** The message projection coverage of each Session, in one read. */
    Map<String, Long> findMessageCoveredSequences(String tenantId,
            List<String> sessionIds);

    public ReplayWindow findReplayWindow(String tenantId, String sessionId);

    /** The Sessions whose message projection covers more than their replay floor. */
    List<ReplayFloorTarget> findReplayFloorTargets(int limit);

    /**
     * Raises the Session's replay floor only through readable message coverage.
     */
    public ReplayWindow advanceReplayFloor(String tenantId, String sessionId,
            long floorSequence);

    public List<MaterializationTarget> findMaterializationTargets(int limit);

    public MaterializationResult materializeNextBatch(String tenantId,
            String sessionId, int limit);

    /**
     * Rotates a stale materialization target behind the fresher ones by
     * touching only {@code gmt_modified} on its progress row — never
     * {@code covered_sequence}, which the gap guard must freeze on failure.
     */
    public void deferMaterializationTarget(String tenantId, String sessionId);

    public void appendPublicEventIfAbsent(String tenantId, String sessionId,
            String turnId, String type, Map<String, Object> data,
            boolean terminal, String sourceKey);

    /**
     * Appends a Session event unless one with the source key exists, when
     * the tenant's Session exists and is neither deleted nor being deleted.
     * The Session is locked before its status is read, so a deletion that
     * commits first is always seen.
     */
    public void appendLiveSessionEventIfAbsent(String tenantId, String sessionId,
            String type, Map<String, Object> data, String sourceKey);
}
