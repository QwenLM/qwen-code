package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.contracts.session.AgentStateStore;
import com.alibaba.qwen.code.managedagent.contracts.workspace.WorkspaceToolProfiles;
import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.managedagent.model.StoreModels.DispatchTarget;
import com.alibaba.qwen.code.managedagent.model.StoreModels.EventRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.HarnessEvent;
import com.alibaba.qwen.code.managedagent.model.StoreModels.ProjectedEvent;
import com.alibaba.qwen.code.managedagent.model.StoreModels.SessionRecord;
import com.alibaba.qwen.code.managedagent.model.StoreModels.TurnRecord;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.alibaba.qwen.code.runtimebroker.persistence.JdbcRuntimeBindingRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.jdbc.core.JdbcTemplate;

import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

final class AgentTurnExecution {
    private final AgentEventJournal eventJournal;
    private final AgentMessageProjection messageProjection;
    private final AgentSessionCommands sessionCommands;
    private final AgentStoreRows storeRows;
    private final JdbcTemplate jdbc;
    private final ObjectMapper objectMapper;
    private final Clock clock;

    AgentTurnExecution(AgentEventJournal eventJournal,
            AgentMessageProjection messageProjection,
            AgentSessionCommands sessionCommands,
            AgentStoreRows storeRows,
            JdbcTemplate jdbc,
            ObjectMapper objectMapper,
            Clock clock) {
        this.eventJournal = eventJournal;
        this.messageProjection = messageProjection;
        this.sessionCommands = sessionCommands;
        this.storeRows = storeRows;
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
        this.clock = clock;
    }

    List<DispatchTarget> findDispatchable(long now, int limit) {
        // Workflow/Runtime parks have separate settlement paths. A due
        // Harness park enters only the coordinator's read-only observation
        // branch; cancellation still uses the normal dispatch lane.
        return jdbc.query(
                "SELECT tenant_id, session_id, turn_id FROM ma_turn WHERE status IN ('ACCEPTED', 'RUNNING', 'CANCELLING') AND (dispatch_lease_until IS NULL OR dispatch_lease_until < ?) AND (retry_after IS NULL OR retry_after <= ?) AND (status = 'CANCELLING' OR error_code IS NULL OR error_code NOT IN ('" + AgentStateStore.WORKFLOW_RECOVERY_BLOCKED + "', '" + AgentStateStore.RUNTIME_RECOVERY_BLOCKED + "')) AND (status = 'CANCELLING' OR NOT EXISTS (SELECT 1 FROM ma_session_worktree w WHERE w.tenant_id = ma_turn.tenant_id AND w.session_id = ma_turn.session_id AND w.state <> 'READY')) AND EXISTS (SELECT 1 FROM ma_session private_scope WHERE private_scope.tenant_id = ma_turn.tenant_id AND private_scope.session_id = ma_turn.session_id AND private_scope.is_csi_guard = FALSE) ORDER BY gmt_modified ASC LIMIT ?",
                (result, row) -> new DispatchTarget(
                        result.getString("tenant_id"),
                        result.getString("session_id"),
                        result.getString("turn_id")), now, now, limit);
    }

    List<DispatchTarget> findRuntimeRecoveryParked(long now, int limit) {
        // D7-2: a Turn whose parked Runtime execution still cannot be proved
        // either way waits for its recheck, never for a dispatch. A cancel
        // is not scanned here: the normal sweep owns that lane.
        return jdbc.query(
                "SELECT tenant_id, session_id, turn_id FROM ma_turn WHERE status IN ('ACCEPTED', 'RUNNING') AND error_code = '"
                        + AgentStateStore.RUNTIME_RECOVERY_BLOCKED
                        + "' AND (dispatch_lease_until IS NULL OR dispatch_lease_until < ?) AND (retry_after IS NULL OR retry_after <= ?) AND EXISTS (SELECT 1 FROM ma_session private_scope WHERE private_scope.tenant_id = ma_turn.tenant_id AND private_scope.session_id = ma_turn.session_id AND private_scope.is_csi_guard = FALSE) ORDER BY retry_after ASC, gmt_modified ASC LIMIT ?",
                (result, row) -> new DispatchTarget(
                        result.getString("tenant_id"),
                        result.getString("session_id"),
                        result.getString("turn_id")), now, now, limit);
    }

    Optional<TurnRecord> claimTurn(String tenantId, String sessionId,
            String turnId, String owner, Duration leaseDuration) {
        storeRows.requireLegacyMutation(tenantId, sessionId);
        long now = clock.millis();
        int updated = jdbc.update("UPDATE ma_turn SET"
                        + " dispatch_owner = ?, dispatch_lease_until = ?,"
                        + " gmt_modified = ?, version = version + 1 WHERE"
                        + " tenant_id = ? AND session_id = ? AND turn_id = ?"
                        + " AND status IN ('ACCEPTED', 'RUNNING',"
                        + " 'CANCELLING') AND (dispatch_lease_until IS NULL"
                        + " OR dispatch_lease_until < ?) AND (retry_after IS"
                        + " NULL OR retry_after <= ?) AND (status = 'CANCELLING' OR NOT EXISTS"
                        + " (SELECT 1 FROM ma_session_worktree w WHERE w.tenant_id = ma_turn.tenant_id"
                        + " AND w.session_id = ma_turn.session_id AND w.state <> 'READY'))",
                owner, now + leaseDuration.toMillis(), now, tenantId,
                sessionId, turnId, now, now);
        return updated == 0 ? Optional.empty()
                : storeRows.findTurn(tenantId, sessionId, turnId);
    }

    boolean renewTurn(String tenantId, String sessionId,
            String turnId, String owner, Duration leaseDuration) {
        storeRows.requireLegacyMutation(tenantId, sessionId);
        long now = clock.millis();
        return jdbc.update("UPDATE ma_turn SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", dispatch_lease_until = ?, version = version + 1 WHERE tenant_id = ? AND session_id = ? AND turn_id = ? AND dispatch_owner = ? AND status IN ('ACCEPTED', 'RUNNING', 'CANCELLING') AND dispatch_lease_until >= ?",
                now + leaseDuration.toMillis(), tenantId, sessionId, turnId,
                owner, now) == 1;
    }

    void releaseTurnLease(String tenantId, String sessionId,
            String turnId, String owner) {
        storeRows.requireLegacyMutation(tenantId, sessionId);
        jdbc.update("UPDATE ma_turn SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", dispatch_owner = NULL,"
                        + " dispatch_lease_until = NULL, version = version +"
                        + " 1 WHERE tenant_id = ? AND session_id = ? AND"
                        + " turn_id = ? AND dispatch_owner = ? AND status IN"
                        + " ('ACCEPTED', 'RUNNING', 'CANCELLING')",
                tenantId, sessionId, turnId, owner);
    }

    boolean markTurnRecoveryBlocked(String tenantId,
            String sessionId, String turnId, String owner,
            String errorCode, String errorMessage) {
        storeRows.requireLegacyMutation(tenantId, sessionId);
        long now = clock.millis();
        Long retryAfter = AgentStateStore.HARNESS_RECOVERY_BLOCKED.equals(errorCode)
                ? now + 15_000L : null;
        // A sampled Harness block can lift. Retain the unsettled outcome
        // and back off its read-only recheck without consuming retry budget.
        return jdbc.update("UPDATE ma_turn SET error_code = ?,"
                        + " error_message = ?, retry_after = ?, dispatch_owner = NULL,"
                        + " dispatch_lease_until = NULL, gmt_modified = ?,"
                        + " version = version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ? AND"
                        + " dispatch_owner = ? AND dispatch_lease_until >= ?"
                        + " AND status IN ('ACCEPTED', 'RUNNING',"
                        + " 'CANCELLING') AND (? <> ? OR status <> 'CANCELLING')",
                errorCode, errorMessage, retryAfter, now, tenantId, sessionId, turnId,
                owner, now, errorCode, AgentStateStore.HARNESS_RECOVERY_BLOCKED) == 1;
    }

    boolean markTurnFailureRecovery(String tenantId, String sessionId,
            String turnId, String owner, String message) {
        var locked = storeRows.requireLegacySessionTurnForUpdate(tenantId, sessionId, turnId);
        TurnRecord turn = locked.turn();
        long now = clock.millis();
        String diagnostic = AgentStateStore.RUNTIME_RECOVERY_BLOCKED.equals(turn.errorCode())
                && turn.errorMessage() != null ? turn.errorMessage() : message;
        return jdbc.update("UPDATE ma_turn SET error_code = ?, error_message = ?,"
                        + " gmt_modified = ?, version = version + 1 WHERE tenant_id = ?"
                        + " AND session_id = ? AND turn_id = ? AND dispatch_owner = ?"
                        + " AND dispatch_lease_until >= ? AND is_submission_attempted = TRUE"
                        + " AND status IN ('ACCEPTED', 'RUNNING')",
                AgentStateStore.RUNTIME_RECOVERY_BLOCKED, diagnostic, now,
                tenantId, sessionId, turnId, owner, now) == 1;
    }

    boolean requestRecoveryRecheck(String tenantId, String sessionId,
            String turnId) {
        storeRows.requireLegacySessionForUpdate(tenantId, sessionId);
        long now = clock.millis();
        return jdbc.update("UPDATE ma_turn SET retry_after = ?, gmt_modified = ?,"
                        + " version = version + 1 WHERE tenant_id = ? AND session_id = ?"
                        + " AND turn_id = ? AND (retry_after IS NULL OR retry_after > ?)"
                        + " AND (status = 'CANCELLING' OR status IN ('ACCEPTED', 'RUNNING')"
                        + " AND error_code = ?)",
                now, now, tenantId, sessionId, turnId, now,
                AgentStateStore.RUNTIME_RECOVERY_BLOCKED) == 1
                || jdbc.queryForObject("SELECT COUNT(*) FROM ma_turn WHERE tenant_id = ?"
                        + " AND session_id = ? AND turn_id = ? AND (status = 'CANCELLING'"
                        + " OR status IN ('ACCEPTED', 'RUNNING') AND error_code = ?)",
                        Long.class, tenantId, sessionId, turnId,
                        AgentStateStore.RUNTIME_RECOVERY_BLOCKED) == 1;
    }

    boolean parkTurnForRuntimeRecovery(String tenantId,
            String sessionId, String turnId, String owner, String message,
            long retryAfter) {
        storeRows.requireLegacyMutation(tenantId, sessionId);
        long now = clock.millis();
        // D7-2: the park keeps the Turn active so its input stays unsettled.
        // Only a proven cancel may settle it; the recheck drives that cancel.
        return jdbc.update("UPDATE ma_turn SET error_code = ?,"
                        + " error_message = ?, retry_after = ?,"
                        + " dispatch_owner = NULL, dispatch_lease_until = NULL,"
                        + " gmt_modified = ?, version = version + 1 WHERE"
                        + " tenant_id = ? AND session_id = ? AND turn_id = ? AND"
                        + " dispatch_owner = ? AND dispatch_lease_until >= ? AND"
                        + " status IN ('ACCEPTED', 'RUNNING')",
                AgentStateStore.RUNTIME_RECOVERY_BLOCKED, message, retryAfter,
                now, tenantId, sessionId, turnId, owner, now) == 1;
    }

    void deferTurnRetry(String tenantId, String sessionId,
            String turnId, String owner, long retryAfter) {
        scheduleTurnRetry(tenantId, sessionId, turnId, owner, retryAfter,
                false);
    }

    void scheduleTurnRetry(String tenantId, String sessionId,
            String turnId, String owner, long retryAfter,
            boolean budgetExempt) {
        storeRows.requireLegacyMutation(tenantId, sessionId);
        jdbc.update("UPDATE ma_turn SET retry_count = retry_count"
                        + " + 1, consecutive_failures = consecutive_failures"
                        + " + 1, budget_exempt_failures ="
                        + " budget_exempt_failures + ?, retry_after = ?,"
                        + " dispatch_owner = NULL, dispatch_lease_until ="
                        + " NULL, gmt_modified = ?, version = version + 1 WHERE"
                        + " tenant_id = ? AND session_id = ? AND turn_id = ?"
                        + " AND dispatch_owner = ? AND status IN ('ACCEPTED',"
                        + " 'RUNNING', 'CANCELLING')",
                budgetExempt ? 1 : 0, retryAfter, clock.millis(), tenantId,
                sessionId, turnId, owner);
    }

    boolean bindHarness(String tenantId, String sessionId,
            String turnId, String owner, String harnessBootId) {
        var locked = storeRows.requireLegacySessionTurnForUpdate(tenantId, sessionId, turnId);
        SessionRecord session = locked.session();
        TurnRecord turn = locked.turn();
        long now = clock.millis();
        if (!owner.equals(turn.dispatchOwner())
                || turn.dispatchLeaseUntil() == null
                || turn.dispatchLeaseUntil() < now
                || !AgentStoreRows.ACTIVE_TURN_STATES.contains(turn.status())) {
            return false;
        }
        if (harnessBootId.equals(session.harnessBootId())) {
            return true;
        }
        if (session.harnessBootId() != null
                && (turn.submissionAttempted()
                        || turn.harnessEventEpoch() != null)) {
            return false;
        }
        jdbc.update("UPDATE ma_session SET harness_boot_id = ?,"
                        + " gmt_modified = ?, version = version + 1 WHERE"
                        + " tenant_id = ? AND session_id = ?",
                harnessBootId, now, tenantId, sessionId);
        return true;
    }

    boolean bindRecoveredHarness(String tenantId, String sessionId,
            String turnId, String owner, String expectedHarnessBootId,
            String harnessBootId) {
        var locked = storeRows.requireLegacySessionTurnForUpdate(tenantId, sessionId, turnId);
        SessionRecord session = locked.session();
        TurnRecord turn = locked.turn();
        long now = clock.millis();
        if (!owner.equals(turn.dispatchOwner())
                || turn.dispatchLeaseUntil() == null
                || turn.dispatchLeaseUntil() < now
                || !AgentStoreRows.ACTIVE_TURN_STATES.contains(turn.status())
                || !turn.submissionAttempted()
                || turn.harnessEventEpoch() == null) {
            return false;
        }
        if (harnessBootId.equals(session.harnessBootId())) {
            return true;
        }
        if (!Objects.equals(expectedHarnessBootId,
                session.harnessBootId())) {
            return false;
        }
        int updated = jdbc.update("UPDATE ma_session SET"
                        + " harness_boot_id = ?, gmt_modified = ?, version ="
                        + " version + 1 WHERE tenant_id = ? AND session_id"
                        + " = ? AND harness_boot_id = ?",
                harnessBootId, now, tenantId, sessionId,
                expectedHarnessBootId);
        return updated == 1;
    }

    void markSubmissionAttempted(String tenantId, String sessionId,
            String turnId, String owner) {
        storeRows.requireLegacyMutation(tenantId, sessionId);
        long now = clock.millis();
        int updated = jdbc.update("UPDATE ma_turn SET"
                        + " is_submission_attempted = TRUE, gmt_modified = ?,"
                        + " version = version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ? AND"
                        + " dispatch_owner = ? AND dispatch_lease_until"
                        + " >= ? AND harness_event_epoch IS NULL",
                now, tenantId, sessionId, turnId, owner, now);
        if (updated != 1) {
            throw new IllegalStateException("Turn dispatch lease was lost");
        }
    }

    /**
     * G3: back out a submission mark whose attempt carries no event epoch, so a new Harness
     * generation may bind and re-submit. A null epoch only proves the admission REPLY never landed:
     * a settled old-generation admission replays idempotently on the journal's commandId when the
     * Turn re-submits, while one still unsettled answers the resubmit with the coded
     * duplicate-admission 409 — the caller adopts the attach's epoch and streams instead of
     * withdrawing again (R10-4). Refuses under the same lease guards as the mark.
     */
    boolean withdrawSubmissionAttempted(String tenantId,
            String sessionId, String turnId, String owner) {
        storeRows.requireLegacyMutation(tenantId, sessionId);
        long now = clock.millis();
        int updated = jdbc.update("UPDATE ma_turn SET"
                        + " is_submission_attempted = FALSE, gmt_modified = ?,"
                        + " version = version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ? AND"
                        + " dispatch_owner = ? AND dispatch_lease_until"
                        + " >= ? AND is_submission_attempted = TRUE AND"
                        + " harness_event_epoch IS NULL AND status IN"
                        + " ('ACCEPTED','RUNNING','CANCELLING')",
                now, tenantId, sessionId, turnId, owner, now);
        return updated == 1;
    }

    void recordAdmission(String tenantId, String sessionId,
            String turnId, String owner, String eventEpoch,
            long lastEventId) {
        // Lock the session row before the turn row: every writer must take
        // the two in this order or InnoDB deadlocks against the
        // session-first paths (e.g. insertCancelCommand).
        storeRows.requireLegacySessionForUpdate(tenantId, sessionId);
        long now = clock.millis();
        // The admission proves coordination made progress, so the retry
        // budget restarts: it counts consecutive failures without progress.
        // retry_count is not reset — it paces the backoff, which must keep
        // growing across a crash loop that keeps making progress (review
        // round 8, R8-3).
        int updated = jdbc.update("UPDATE ma_turn SET status ="
                        + " CASE WHEN status = 'CANCELLING' THEN status ELSE"
                        + " 'RUNNING' END, harness_event_epoch = ?,"
                        + " harness_last_event_id = ?, consecutive_failures = 0,"
                        + " budget_exempt_failures = 0,"
                        + " gmt_modified = ?,"
                        + " version = version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ? AND"
                        + " dispatch_owner = ? AND dispatch_lease_until"
                        + " >= ?",
                eventEpoch, lastEventId, now, tenantId, sessionId, turnId,
                owner, now);
        if (updated != 1) {
            throw new IllegalStateException("Turn dispatch lease was lost");
        }
        int sessionUpdated = jdbc.update("UPDATE ma_session SET harness_event_epoch ="
                        + " ?, harness_last_event_id = ?, gmt_modified = ?,"
                        + " version = version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ?",
                eventEpoch, lastEventId, now, tenantId, sessionId);
        if (sessionUpdated != 1) {
            throw new IllegalStateException("Session disappeared");
        }
        if (!eventJournal.hasEventType(tenantId, sessionId, turnId, "turn.started")) {
            eventJournal.appendEvent(tenantId, sessionId, turnId, "turn.started",
                    Map.of("turnId", turnId), false, null, now);
        }
        sessionCommands.settleTurnCommands(tenantId, sessionId, turnId, now);
    }

    void recordRecoveryAdmission(String tenantId, String sessionId,
            String turnId, String owner, String expectedTurnEventEpoch,
            String expectedSessionEventEpoch, String eventEpoch,
            long lastEventId) {
        var locked = storeRows.requireLegacySessionTurnForUpdate(tenantId, sessionId, turnId);
        SessionRecord session = locked.session();
        TurnRecord turn = locked.turn();
        long now = clock.millis();
        if (!owner.equals(turn.dispatchOwner())
                || turn.dispatchLeaseUntil() == null
                || turn.dispatchLeaseUntil() < now
                || !AgentStoreRows.ACTIVE_TURN_STATES.contains(turn.status())) {
            throw new IllegalStateException("Turn dispatch lease was lost");
        }
        if (eventEpoch.equals(turn.harnessEventEpoch())
                && turn.harnessLastEventId() != null
                && turn.harnessLastEventId() >= lastEventId) {
            return;
        }
        if (!turn.submissionAttempted()
                || !Objects.equals(expectedTurnEventEpoch,
                        turn.harnessEventEpoch())
                || !Objects.equals(expectedSessionEventEpoch,
                        session.harnessEventEpoch())) {
            throw new IllegalStateException(
                    "Hosted Harness recovery epoch changed");
        }
        // The recovery admission proves coordination made progress, so the
        // retry budget restarts: it counts consecutive failures without
        // progress. retry_count is not reset — it paces the backoff (review
        // round 8, R8-3).
        int updated = jdbc.update("UPDATE ma_turn SET status ="
                        + " CASE WHEN status = 'CANCELLING' THEN status ELSE"
                        + " 'RUNNING' END, harness_event_epoch = ?,"
                        + " harness_last_event_id = ?, consecutive_failures = 0,"
                        + " budget_exempt_failures = 0,"
                        + " gmt_modified = ?,"
                        + " version = version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ? AND"
                        + " dispatch_owner = ? AND dispatch_lease_until"
                        + " >= ? AND (harness_event_epoch = ? OR"
                        + " (harness_event_epoch IS NULL AND ? IS NULL))",
                eventEpoch, lastEventId, now, tenantId, sessionId, turnId,
                owner, now, expectedTurnEventEpoch, expectedTurnEventEpoch);
        if (updated != 1) {
            throw new IllegalStateException("Turn dispatch lease was lost");
        }
        int sessionUpdated = jdbc.update("UPDATE ma_session SET harness_event_epoch ="
                        + " ?, harness_last_event_id = ?, gmt_modified = ?,"
                        + " version = version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND (harness_event_epoch = ? OR"
                        + " (harness_event_epoch IS NULL AND ? IS NULL))",
                eventEpoch, lastEventId, now, tenantId, sessionId,
                expectedSessionEventEpoch, expectedSessionEventEpoch);
        if (sessionUpdated != 1) {
            throw new IllegalStateException(
                    "Hosted Harness recovery epoch changed");
        }
        sessionCommands.settleTurnCommands(tenantId, sessionId, turnId, now);
    }

    void retractContinuationOutput(String tenantId, String sessionId,
            String turnId, String owner, String harnessBootId,
            String eventEpoch) {
        var locked = storeRows.requireLegacySessionTurnForUpdate(tenantId, sessionId, turnId);
        TurnRecord turn = locked.turn();
        long now = clock.millis();
        if (!owner.equals(turn.dispatchOwner())
                || turn.dispatchLeaseUntil() == null
                || turn.dispatchLeaseUntil() < now
                || !AgentStoreRows.ACTIVE_TURN_STATES.contains(turn.status())) {
            throw new IllegalStateException("Turn dispatch lease was lost");
        }
        if (harnessBootId.isBlank() || eventEpoch.isBlank()) {
            throw new IllegalArgumentException(
                    "continuation owner is missing");
        }
        String sourcePrefix = harnessBootId + ":" + eventEpoch + ":";
        String reconciliationKey = "reconcile:" + sourcePrefix + turnId;
        if (eventJournal.hasSourceEvent(tenantId, sessionId, reconciliationKey)) {
            return;
        }
        jdbc.queryForObject("SELECT covered_sequence FROM"
                        + " ma_event_stream WHERE tenant_id"
                        + " = ? AND session_id = ? AND stream_kind = 'SESSION' AND stream_id = X''"
                        + " FOR UPDATE",
                Long.class, tenantId, sessionId);
        List<EventRecord> deltas =
                jdbc.query(
                        "SELECT " + ManagedSchemaProjection.PUBLIC_EVENT.columns() + " FROM ma_public_event WHERE stream_kind = 'SESSION' AND stream_id"
                            + " = X'' AND tenant_id = ? AND session_id = ? AND turn_id = ? AND"
                            + " event_type IN ('item.output_text.delta', 'item.reasoning.delta')"
                            + " ORDER BY sequence_id ASC",
                        eventJournal.eventMapper,
                        tenantId,
                        sessionId,
                        turnId);
        long firstRetracted = Long.MAX_VALUE;
        for (EventRecord event : deltas) {
            if (event.sourceKey() == null
                    || !event.sourceKey().startsWith(sourcePrefix)) {
                continue;
            }
            Map<String, Object> data = new LinkedHashMap<>(event.data());
            data.put("text", "");
            jdbc.update(
                    "UPDATE ma_public_event SET data_json = ? WHERE tenant_id = ? AND session_id ="
                        + " ? AND stream_kind = 'SESSION' AND stream_id = X'' AND sequence_id = ?",
                    storeRows.writeJson(data),
                    tenantId,
                    sessionId,
                    event.sequence());
            firstRetracted = Math.min(firstRetracted, event.sequence());
        }
        if (firstRetracted != Long.MAX_VALUE) {
            eventJournal.reassignIdentity(tenantId, sessionId, firstRetracted);
        }
        messageProjection.rebuildTurnText(tenantId, sessionId, turnId, now);
        eventJournal.appendEvent(tenantId, sessionId, turnId, "stream.reconciled", Map.of(),
                false, reconciliationKey, now);
    }

    /**
     * In-band sibling of {@link #retractContinuationOutput} (#13319): a restarted model attempt on
     * the live Harness retracts the published prefix of the message it replaces. The range is keyed
     * by the journal sequence of the message's first delta, which the Harness reports as {@code
     * fromSourceId}; only deltas of the current in-flight message carry source ids at or after it,
     * so earlier committed rounds stay. The cursor advances past the retraction event in the same
     * transaction whether or not the retraction applied, so a crash cannot re-deliver it.
     */
    void retractHarnessTurnOutput(String tenantId, String sessionId,
            String turnId, String owner, String eventEpoch,
            long fromSourceId, long retractionSourceId, String sourceBootId,
            String sourceEventEpoch, Long throughSourceId) {
        storeRows.requireLegacyMutation(tenantId, sessionId);
        boolean bounded = throughSourceId != null;
        if (bounded && (sourceBootId == null || sourceEventEpoch == null
                || fromSourceId < 1 || throughSourceId < fromSourceId || throughSourceId >= retractionSourceId)) {
            throw new IllegalArgumentException("Invalid bounded Hosted retraction");
        }
        var locked = storeRows.requireSessionTurnForUpdate(tenantId, sessionId, turnId);
        SessionRecord session = locked.session();
        TurnRecord turn = locked.turn();
        long now = clock.millis();
        if (!owner.equals(turn.dispatchOwner())
                || turn.dispatchLeaseUntil() == null
                || turn.dispatchLeaseUntil() < now) {
            throw new IllegalStateException("Turn dispatch lease was lost");
        }
        if (!eventEpoch.equals(turn.harnessEventEpoch())) {
            throw new IllegalStateException(
                    "Hosted Harness event epoch changed");
        }
        String sourcePrefix = (bounded ? sourceBootId : session.harnessBootId()) + ":"
                + (bounded ? sourceEventEpoch : eventEpoch) + ":";
        String reconciliationKey = "reconcile:inband:" + sourcePrefix + turnId
                + ":" + fromSourceId + (bounded ? ":" + throughSourceId : "");
        if (!eventJournal.hasSourceEvent(tenantId, sessionId, reconciliationKey)) {
            jdbc.queryForObject(
                    "SELECT covered_sequence FROM ma_event_stream WHERE tenant_id = ? AND"
                        + " session_id = ? AND stream_kind = 'SESSION' AND stream_id = X'' FOR"
                        + " UPDATE",
                    Long.class,
                    tenantId,
                    sessionId);
            List<EventRecord> deltas =
                    jdbc.query(
                            "SELECT " + ManagedSchemaProjection.PUBLIC_EVENT.columns() + " FROM ma_public_event WHERE stream_kind = 'SESSION' AND"
                                + " stream_id = X'' AND tenant_id = ? AND session_id = ? AND"
                                + " turn_id = ? AND event_type IN ('item.output_text.delta',"
                                + " 'item.reasoning.delta') ORDER BY sequence_id ASC",
                            eventJournal.eventMapper,
                            tenantId,
                            sessionId,
                            turnId);
            long firstRetracted = Long.MAX_VALUE;
            for (EventRecord event : deltas) {
                if (event.sourceKey() == null
                        || (!bounded && !event.sourceKey().startsWith(sourcePrefix))
                        || sourceIdOf(event.sourceKey()) < fromSourceId
                        || (bounded && sourceIdOf(event.sourceKey()) > throughSourceId)) {
                    continue;
                }
                Map<String, Object> data = new LinkedHashMap<>(event.data());
                data.put("text", "");
                jdbc.update(
                        "UPDATE ma_public_event SET data_json = ? WHERE tenant_id = ? AND"
                            + " session_id = ? AND stream_kind = 'SESSION' AND stream_id = X'' AND"
                            + " sequence_id = ?",
                        storeRows.writeJson(data),
                        tenantId,
                        sessionId,
                        event.sequence());
                firstRetracted = Math.min(firstRetracted, event.sequence());
            }
            if (firstRetracted != Long.MAX_VALUE) {
                eventJournal.reassignIdentity(tenantId, sessionId, firstRetracted);
            }
            messageProjection.rebuildTurnText(tenantId, sessionId, turnId, now);
            eventJournal.appendEvent(
                    tenantId,
                    sessionId,
                    turnId,
                    "stream.reconciled",
                    Map.of(),
                    false,
                    reconciliationKey,
                    now);
        }
        int updated = updateHarnessCursor(tenantId, sessionId, turnId, owner,
                eventEpoch, retractionSourceId, now);
        if (updated != 1) {
            throw new IllegalStateException("Turn dispatch lease was lost");
        }
    }

    // A Harness source key ends in the journal sequence of its journal event;
    // the boot and epoch prefixes are colon-free by construction but the
    // suffix is what the range compares.
    static long sourceIdOf(String sourceKey) {
        try {
            return Long.parseLong(
                    sourceKey.substring(sourceKey.lastIndexOf(':') + 1));
        } catch (NumberFormatException error) {
            return -1;
        }
    }

    void recordHarnessEvents(String tenantId, String sessionId,
            String turnId, String owner, String eventEpoch,
            List<HarnessEvent> events) {
        storeRows.requireLegacyMutation(tenantId, sessionId);
        if (events.isEmpty()) {
            return;
        }
        var locked = storeRows.requireSessionTurnForUpdate(tenantId, sessionId, turnId);
        SessionRecord session = locked.session();
        TurnRecord turn = locked.turn();
        if (!owner.equals(turn.dispatchOwner())
                || turn.dispatchLeaseUntil() == null
                || turn.dispatchLeaseUntil() < clock.millis()) {
            throw new IllegalStateException("Turn dispatch lease was lost");
        }
        if (!eventEpoch.equals(turn.harnessEventEpoch())) {
            throw new IllegalStateException(
                    "Hosted Harness event epoch changed");
        }
        long lastSourceId = turn.harnessLastEventId() == null ? 0
                : turn.harnessLastEventId();
        List<HarnessEvent> accepted = new ArrayList<>();
        for (HarnessEvent event : events) {
            if (event.sourceId() > lastSourceId) {
                accepted.add(event);
                lastSourceId = event.sourceId();
            }
        }
        if (accepted.isEmpty()) {
            return;
        }
        long now = clock.millis();
        HarnessEvent terminal = null;
        for (int index = 0; index < accepted.size(); index++) {
            HarnessEvent event = accepted.get(index);
            if (event.projection() != null
                    && event.projection().terminal()) {
                if (terminal != null || index != accepted.size() - 1) {
                    throw new IllegalArgumentException(
                            "Terminal Harness event must end the batch");
                }
                terminal = event;
            }
        }
        int updated = terminal == null
                ? updateHarnessCursor(tenantId, sessionId, turnId, owner,
                        eventEpoch, lastSourceId, now)
                : completeHarnessTurn(tenantId, sessionId, turnId, owner,
                        eventEpoch, lastSourceId, terminal.projection(), now);
        if (updated != 1) {
            throw new IllegalStateException("Turn dispatch lease was lost");
        }
        List<HarnessEvent> projected = accepted.stream()
                .filter(event -> event.projection() != null).toList();
        List<EventRecord> committed = eventJournal.appendEvents(tenantId, sessionId,
                turnId, eventEpoch, lastSourceId, session.lastSequence(),
                projected, now);
        if (terminal != null) {
            sessionCommands.settleTurnCommands(tenantId, sessionId, turnId, now);
        }
        eventJournal.publishAfterCommit(committed);
    }

    int updateHarnessCursor(String tenantId, String sessionId,
            String turnId, String owner, String eventEpoch,
            long lastSourceId, long now) {
        // Journaling new events proves coordination made progress, so the
        // retry budget restarts: it counts consecutive failures without
        // progress. retry_count is not reset — it paces the backoff (review
        // round 8, R8-3).
        return jdbc.update("UPDATE ma_turn SET"
                        + " harness_event_epoch = ?,"
                        + " harness_last_event_id = ?, consecutive_failures = 0,"
                        + " budget_exempt_failures = 0,"
                        + " gmt_modified = ?,"
                        + " version = version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ? AND"
                        + " dispatch_owner = ? AND dispatch_lease_until"
                        + " >= ?",
                eventEpoch, lastSourceId, now, tenantId, sessionId, turnId,
                owner, now);
    }

    int completeHarnessTurn(String tenantId, String sessionId,
            String turnId, String owner, String eventEpoch,
            long lastSourceId, ProjectedEvent terminal, long now) {
        return jdbc.update("UPDATE ma_turn SET"
                        + " harness_event_epoch = ?,"
                        + " harness_last_event_id = ?, status = ?,"
                        + " error_code = ?, error_message = ?,"
                        + " completed_at = ?, gmt_modified = ?,"
                        + " dispatch_owner = NULL,"
                        + " dispatch_lease_until = NULL, version ="
                        + " version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ? AND"
                        + " dispatch_owner = ? AND dispatch_lease_until"
                        + " >= ?",
                eventEpoch, lastSourceId, terminal.terminalStatus(),
                terminal.errorCode(), terminal.errorMessage(), now, now,
                tenantId, sessionId, turnId, owner, now);
    }

    boolean cancelUnadmittedTurn(String tenantId, String sessionId,
            String turnId, String owner) {
        SessionRecord session = storeRows.requireLegacySessionForUpdate(tenantId, sessionId);
        TurnRecord turn = storeRows.requireTurn(tenantId, sessionId, turnId);
        if (!"CANCELLING".equals(turn.status())
                || !owner.equals(turn.dispatchOwner())
                || turn.harnessEventEpoch() != null
                || !turn.submissionAttempted()) {
            return false;
        }
        var heads = WorkspaceOperations.rows(jdbc,
                "SELECT tenant_id, session_id, state, writer_lease_until FROM"
                        + " ma_session_head WHERE tenant_key = ? AND harness_key = ?"
                        + " AND head_kind = 'MANAGED_SESSION' FOR UPDATE",
                JdbcRuntimeBindingRepository.harnessDrainKey(tenantId),
                JdbcRuntimeBindingRepository.harnessDrainKey(sessionId));
        long now = storeRows.lifecycleDatabaseTime();
        if (heads.size() != 1 || !tenantId.equals(heads.getFirst().get("tenant_id"))
                || !sessionId.equals(heads.getFirst().get("session_id"))
                || !("SEALED".equals(heads.getFirst().get("state"))
                        || "ACTIVE".equals(heads.getFirst().get("state"))
                                && heads.getFirst().get("writer_lease_until") instanceof Number until
                                && until.longValue() <= now)) {
            return false;
        }
        // The locked, fenced writer cannot admit a late HTTP request. Even an
        // idle journal may contain this prompt's completed admission: replay
        // its real result instead of replacing it with cancellation.
        java.util.Set<String> accepted;
        try {
            accepted = JdbcWorkspaceLifecycleStore.requireIdleJournal(jdbc, objectMapper,
                    tenantId, sessionId, false,
                    WorkspaceToolProfiles.lifecycleProtocol(session.toolProfile()) == 2);
        } catch (ManagedAgentException unverified) {
            return false;
        }
        if (accepted.contains(turn.promptId()) || !withdrawSubmissionAttempted(tenantId, sessionId, turnId, owner)) {
            return false;
        }
        cancelBeforeAdmission(tenantId, sessionId, turnId, owner);
        return "CANCELLED".equals(storeRows.requireTurn(tenantId, sessionId, turnId).status());
    }

    void cancelBeforeAdmission(String tenantId, String sessionId,
            String turnId, String owner) {
        // Session-row lock first; see recordAdmission.
        storeRows.requireLegacySessionForUpdate(tenantId, sessionId);
        TurnRecord turn = storeRows.requireTurn(tenantId, sessionId, turnId);
        if (!owner.equals(turn.dispatchOwner())
                || turn.harnessEventEpoch() != null
                || turn.submissionAttempted()) {
            return;
        }
        long now = clock.millis();
        int updated = jdbc.update("UPDATE ma_turn SET status ="
                        + " 'CANCELLED',"
                        + " completed_at = ?, gmt_modified = ?,"
                        + " dispatch_owner = NULL,"
                        + " dispatch_lease_until = NULL, version ="
                        + " version + 1 WHERE tenant_id = ? AND"
                        + " session_id = ? AND turn_id = ? AND"
                        + " dispatch_owner = ? AND dispatch_lease_until >= ?"
                        + " AND is_submission_attempted = FALSE",
                now, now, tenantId, sessionId, turnId, owner, now);
        if (updated != 1) {
            return;
        }
        eventJournal.appendEvent(tenantId, sessionId, turnId, "turn.cancelled",
                Map.of("turnId", turnId), true, null, now);
        sessionCommands.settleTurnCommands(tenantId, sessionId, turnId, now);
    }

    void failTurn(String tenantId, String sessionId, String turnId,
            String owner, String code, String message) {
        settleFailedTurn(tenantId, sessionId, turnId, owner, code, message, true);
    }

    void failWorktreeInitialTurns(String tenantId, String sessionId, String code) {
        storeRows.requireLegacySessionForUpdate(tenantId, sessionId);
        if (jdbc.queryForList("SELECT 1 FROM ma_session_worktree WHERE tenant_id = ? AND session_id = ?"
                + " AND state IN ('FAILED', 'BLOCKED') FOR UPDATE", Integer.class, tenantId, sessionId).isEmpty()) {
            return;
        }
        long now = clock.millis();
        String message = "The Session worktree could not be prepared.";
        List<String> turns = jdbc.queryForList("SELECT turn_id FROM ma_turn WHERE tenant_id = ? AND session_id = ?"
                + " AND status = 'ACCEPTED' AND is_submission_attempted = FALSE FOR UPDATE", String.class, tenantId, sessionId);
        for (String turnId : turns) {
            jdbc.update("UPDATE ma_turn SET status = 'FAILED', error_code = ?, error_message = ?, completed_at = ?,"
                    + " gmt_modified = ?, dispatch_owner = NULL, dispatch_lease_until = NULL, version = version + 1"
                    + " WHERE tenant_id = ? AND session_id = ? AND turn_id = ? AND status = 'ACCEPTED'"
                    + " AND is_submission_attempted = FALSE", code, message, now, now, tenantId, sessionId, turnId);
            eventJournal.appendEvent(tenantId, sessionId, turnId, "turn.failed", Map.of("code", code, "message", message), true, null, now);
            sessionCommands.settleTurnCommands(tenantId, sessionId, turnId, now);
        }
    }

    boolean failRecoveryBlockedTurn(String tenantId, String sessionId,
            String turnId, String owner, String message) {
        return settleFailedTurn(tenantId, sessionId, turnId, owner,
                "managed_runtime_recovery_blocked", message, false);
    }

    boolean settleFailedTurn(String tenantId, String sessionId, String turnId,
            String owner, String code, String message, boolean allowCancelling) {
        // Session-row lock first; see recordAdmission.
        storeRows.requireLegacySessionForUpdate(tenantId, sessionId);
        TurnRecord turn = storeRows.requireTurn(tenantId, sessionId, turnId);
        if (!owner.equals(turn.dispatchOwner())
                || !AgentStoreRows.ACTIVE_TURN_STATES.contains(turn.status())
                || !allowCancelling && "CANCELLING".equals(turn.status())) {
            return false;
        }
        long now = clock.millis();
        int updated = jdbc.update("UPDATE ma_turn SET status ="
                        + " 'FAILED',"
                        + " error_code = ?, error_message = ?, completed_at ="
                        + " ?, gmt_modified = ?, dispatch_owner = NULL,"
                        + " dispatch_lease_until = NULL, version = version +"
                        + " 1 WHERE tenant_id = ? AND session_id = ? AND"
                        + " turn_id = ? AND dispatch_owner = ? AND status IN"
                        + (allowCancelling ? " ('ACCEPTED', 'RUNNING', 'CANCELLING') AND"
                                : " ('ACCEPTED', 'RUNNING') AND")
                        + " dispatch_lease_until >= ?",
                code, message, now, now, tenantId, sessionId, turnId, owner,
                now);
        if (updated != 1) {
            return false;
        }
        eventJournal.appendEvent(tenantId, sessionId, turnId, "turn.failed",
                Map.of("code", code, "message", message), true, null, now);
        sessionCommands.settleTurnCommands(tenantId, sessionId, turnId, now);
        return true;
    }
}
