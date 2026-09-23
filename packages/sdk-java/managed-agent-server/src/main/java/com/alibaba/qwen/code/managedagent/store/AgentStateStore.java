package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.store.StoreModels.Admission;
import com.alibaba.qwen.code.managedagent.store.StoreModels.CommandRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.DispatchTarget;
import com.alibaba.qwen.code.managedagent.store.StoreModels.EventPage;
import com.alibaba.qwen.code.managedagent.store.StoreModels.EventRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.HarnessEvent;
import com.alibaba.qwen.code.managedagent.store.StoreModels.MaterializationResult;
import com.alibaba.qwen.code.managedagent.store.StoreModels.MaterializationTarget;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionPage;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionMutationCommand;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SessionMutationKind;
import com.alibaba.qwen.code.managedagent.store.StoreModels.SnapshotRecord;
import com.alibaba.qwen.code.managedagent.store.StoreModels.TurnRecord;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Optional;

public interface AgentStateStore {
    Admission insertSessionCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String agentId,
            String title, List<Map<String, Object>> input,
            String payloadDigest);

    Admission insertTurnCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            List<Map<String, Object>> input, String payloadDigest);

    Admission insertCancelCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest, String sessionId,
            String turnId);

    SessionMutationCommand beginSessionMutation(String tenantId,
            String operation, String idempotencyKey, String requestDigest,
            String sessionId, SessionMutationKind kind);

    SessionRecord completeSessionMutation(String tenantId, String operation,
            String idempotencyKey, String sessionId,
            SessionMutationKind kind, String title, String harnessBootId);

    Admission replayCommand(String tenantId, String operation,
            String idempotencyKey, String requestDigest);

    Optional<CommandRecord> findCommand(String tenantId, String operation,
            String idempotencyKey);

    Optional<SessionRecord> findSessionById(String sessionId);

    SessionPage listSessions(String tenantId, Long beforeUpdatedAt,
            String beforeSessionId, int limit);

    Optional<TurnRecord> findTurn(String tenantId, String sessionId,
            String turnId);

    Optional<TurnRecord> findActiveTurn(String tenantId, String sessionId);

    Optional<TurnRecord> findLatestTurn(String tenantId, String sessionId);

    List<EventRecord> findEvents(String tenantId, String sessionId,
            long afterSequence, int limit);

    List<EventRecord> findControlEvents(String tenantId, String sessionId,
            long throughSequence);

    EventPage findTranscriptEvents(String tenantId, String sessionId,
            Long beforeSequence, int limit);

    Optional<SnapshotRecord> findSnapshot(String tenantId,
            String sessionId);

    List<MaterializationTarget> findMaterializationTargets(int limit);

    MaterializationResult materializeNextBatch(String tenantId,
            String sessionId, int limit);

    List<DispatchTarget> findDispatchable(long now, int limit);

    Optional<TurnRecord> claimTurn(String tenantId, String sessionId,
            String turnId, String owner, Duration leaseDuration);

    boolean renewTurn(String tenantId, String sessionId, String turnId,
            String owner, Duration leaseDuration);

    void releaseTurnLease(String tenantId, String sessionId, String turnId,
            String owner);

    boolean bindHarness(String tenantId, String sessionId, String turnId,
            String owner, String harnessBootId);

    boolean bindRecoveredHarness(String tenantId, String sessionId,
            String turnId, String owner, String expectedHarnessBootId,
            String harnessBootId);

    void markSubmissionAttempted(String tenantId, String sessionId,
            String turnId, String owner);

    void recordAdmission(String tenantId, String sessionId, String turnId,
            String owner, String eventEpoch, long lastEventId);

    void recordRecoveryAdmission(String tenantId, String sessionId,
            String turnId, String owner, String expectedEventEpoch,
            String eventEpoch, long lastEventId);

    void recordHarnessEvents(String tenantId, String sessionId,
            String turnId, String owner, String eventEpoch,
            List<HarnessEvent> events);

    void cancelBeforeAdmission(String tenantId, String sessionId,
            String turnId, String owner);

    void failTurn(String tenantId, String sessionId, String turnId,
            String owner, String code, String message);

    void appendPublicEventIfAbsent(String tenantId, String sessionId,
            String turnId, String type, Map<String, Object> data,
            boolean terminal, String sourceKey);

    SessionRecord requireSession(String tenantId, String sessionId);
}
