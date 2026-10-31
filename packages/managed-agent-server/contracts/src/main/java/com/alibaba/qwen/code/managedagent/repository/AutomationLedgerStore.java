package com.alibaba.qwen.code.managedagent.repository;

import com.fasterxml.jackson.databind.JsonNode;
import org.apache.commons.codec.digest.DigestUtils;

import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Optional;

public interface AutomationLedgerStore {
    public static final String STATE_LIVE = "live";

    public static final String STATE_RETIRED = "retired";

    public static final String OUTCOME_FIRING = "firing";

    public static final String OUTCOME_FIRED = "fired";

    public static final String OUTCOME_SKIPPED = "skipped";

    public static final String OUTCOME_MISSED = "missed";

    public static final String OUTCOME_UNKNOWN = "unknown";

    public static final String GATE_DELIVERED = "delivered";

    public static final String GATE_QUIET = "quiet";

    public static final String GATE_FAILED = "failed";

    public static final String GATE_BLOCKED = "blocked";

    public static final String GATE_UNKNOWN = "unknown";

    public record ScheduleRow(String tenantId, String scheduleId,
            String sessionId, String workspaceId, String actorId,
            long recordRevision, long definitionRevision,
            String definitionDigest, String goal, String cron, String timezone,
            String sessionMode, String overlap, String catchUp,
            Long catchUpLimit, boolean enabled, String state,
            String blockedReason, long armedAt, Long watermarkSlot,
            String leaseOwner, Long leaseUntil, long fence, long createdAt,
            long updatedAt, String gate, String gateLastOutcome,
            Long gateLastAt, int gateQuietSinceDelivery, int gateFailures,
            String gateLastError) {
    }

    public record OccurrenceRow(String tenantId, String scheduleId,
            String occurrenceKey, String runId, String sessionId, Long slot,
            String trigger, String outcome, String reason,
            long definitionRevision, long fence, int attempts,
            long nextRetryAt, String lastError, long createdAt,
            long updatedAt) {
        /** A fresh decision of one occurrence of the definition as held. */
        public static OccurrenceRow decision(ScheduleRow definition,
                String occurrenceKey, Long slot, String trigger,
                String outcome, String reason, long fence, long now) {
            return new OccurrenceRow(definition.tenantId(),
                    definition.scheduleId(), occurrenceKey,
                    automationRunId(definition.scheduleId(), occurrenceKey),
                    definition.sessionId(), slot, trigger, outcome, reason,
                    definition.definitionRevision(), fence, 0, 0L, null, now,
                    now);
        }
    }

    public record OccurrenceView(OccurrenceRow occurrence, String taskState) {
    }

    public record CommandRow(String tenantId, String idempotencyKey,
            String actorId, String requestDigest, String scheduleId,
            String resultJson) {
    }

    public record ScheduleCursor(long createdAt, String scheduleId) {
    }

    public record SchedulePage(List<ScheduleRow> rows, boolean hasMore) {
    }

    public record OccurrenceCursor(long createdAt, String occurrenceKey) {
    }

    public record OccurrencePage(List<OccurrenceView> rows, boolean hasMore) {
    }

    public Optional<ScheduleRow> findSchedule(String tenantId,
            String scheduleId);

    public void projectSchedule(String tenantId, String workspaceId,
            String sessionId, long recordRevision, JsonNode record, long now);

    public boolean recordGateOutcome(ScheduleRow row, long definitionRevision,
            String owner, long fence, String outcome, String detail, long now);

    public SchedulePage listReadableSchedules(String tenantId, String actorId,
            ScheduleCursor cursor, int limit);

    public int countLive(String tenantId, String sessionId);

    public List<ScheduleRow> findArmed(long now, int limit);

    public List<ScheduleRow> findFiringSchedules(long now, int limit);

    public long claim(String tenantId, String scheduleId, String owner,
            long leaseUntil, long now);

    public void release(String tenantId, String scheduleId, String owner,
            long fence, long now);

    public boolean advanceWatermark(String tenantId, String scheduleId,
            String owner, long fence, long slot, long now);

    public void block(String tenantId, String scheduleId, String owner,
            long fence, String reason, long now);

    public void retire(String tenantId, String scheduleId, long now);

    public Optional<OccurrenceRow> recordOccurrence(OccurrenceRow row,
            String owner);

    public Optional<OccurrenceRow> findOccurrence(String tenantId,
            String scheduleId, String occurrenceKey);

    public boolean settleOccurrence(String tenantId, String scheduleId,
            String occurrenceKey, String outcome, String reason, String owner,
            long fence, long now);

    public boolean settleOccurrence(String tenantId, String scheduleId,
            String occurrenceKey, String outcome, String reason,
            String lastError, String owner, long fence, long now);

    public boolean repinOccurrence(String tenantId, String scheduleId,
            String occurrenceKey, long definitionRevision, String owner,
            long fence, long now);

    public boolean deferOccurrence(String tenantId, String scheduleId,
            String occurrenceKey, int attempts, long nextRetryAt,
            String lastError, String owner, long fence, long now);

    public List<OccurrenceRow> findFiring(String tenantId, String scheduleId,
            long now);

    public int countActive(String tenantId, String scheduleId);

    public List<OccurrenceView> findBlockingRuns(String tenantId,
            String scheduleId, int limit);

    public boolean hasOpenTurn(String tenantId, String sessionId);

    public Optional<OccurrenceView> findOccurrenceView(String tenantId,
            String scheduleId, String occurrenceKey);

    public OccurrencePage listOccurrences(String tenantId, String scheduleId,
            OccurrenceCursor cursor, int limit);

    public Optional<CommandRow> findCommand(String tenantId,
            String idempotencyKey);

    public void recordCommand(CommandRow command, long now);

    public boolean claimCommand(String sessionId, CommandRow command, long now);

    public boolean settleCommand(String tenantId, String idempotencyKey,
            String requestDigest, String actorId, String resultJson);

    public boolean releaseCommand(String tenantId, String idempotencyKey,
            String requestDigest, String actorId);

    public String sessionStatus(String tenantId, String sessionId);

    public static String automationRunId(String scheduleId,
            String occurrenceKey) {
        return "arun_" + sha256(scheduleId + '\0' + occurrenceKey);
    }

    public static String automationInputId(String runId) {
        return runId + ":input";
    }

    public static String sha256(String value) {
        return DigestUtils.sha256Hex(value.getBytes(StandardCharsets.UTF_8));
    }
}
