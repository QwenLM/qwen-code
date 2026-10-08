package com.alibaba.qwen.code.managedagent.store;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Repository;

/**
 * H6b: the JDBC side of the automation runtime — the V53 ledgers (the
 * definition mirror with its lease and watermark, the occurrence decisions,
 * the public command replay) and the small reads the scanner and service
 * need from the Session store. No row here is a journal fact: the Session
 * journal's schedule and automation_run chains stay the authority, and the
 * mirror is refreshed from them whenever its recorded revision lags.
 *
 * <p>Every occurrence write names the lease its writer holds: the insert
 * selects its row from the definition row the holder leases, and each
 * settle is conditioned on that same holder and fence, so a scanner whose
 * lease expired under it cannot record or settle a decision.
 */
@Repository
public class AutomationLedgerStore {
    public static final String STATE_LIVE = "live";
    public static final String STATE_RETIRED = "retired";
    public static final String OUTCOME_FIRING = "firing";
    public static final String OUTCOME_FIRED = "fired";
    public static final String OUTCOME_SKIPPED = "skipped";
    public static final String OUTCOME_MISSED = "missed";
    /** A claim whose Harness answer stayed unobtainable past the bound. */
    public static final String OUTCOME_UNKNOWN = "unknown";

    /** The holder's proof: the definition row under this owner and fence. */
    private static final String HELD = " AND EXISTS (SELECT 1 FROM"
            + " qwen_managed_automation_schedule s WHERE s.tenant_id = ?"
            + " AND s.schedule_id = ? AND s.lease_owner = ? AND s.fence = ?)";

    /** One definition as the scanner reads it. */
    public record ScheduleRow(String tenantId, String scheduleId,
            String sessionId, String workspaceId, String actorId,
            long recordRevision, long definitionRevision,
            String definitionDigest, String goal, String cron, String timezone,
            String sessionMode, String overlap, String catchUp,
            Long catchUpLimit, boolean enabled, String state,
            String blockedReason, long armedAt, Long watermarkSlot,
            String leaseOwner, Long leaseUntil, long fence, long createdAt,
            long updatedAt) {
    }

    /** One occurrence decision. */
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

    /** An occurrence with the task state of its run, when one committed. */
    public record OccurrenceView(OccurrenceRow occurrence, String taskState) {
    }

    /** A committed definition record whose mirror is missing or lags. */
    public record StaleMirror(String tenantId, String workspaceId,
            String sessionId, String scheduleId, long revision,
            String recordResourceId) {
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

    private static final RowMapper<ScheduleRow> SCHEDULE = (result, row) ->
            new ScheduleRow(result.getString("tenant_id"),
                    result.getString("schedule_id"),
                    result.getString("session_id"),
                    result.getString("workspace_id"),
                    result.getString("actor_id"),
                    result.getLong("record_revision"),
                    result.getLong("definition_revision"),
                    result.getString("definition_digest"),
                    result.getString("goal"), result.getString("cron"),
                    result.getString("timezone"),
                    result.getString("session_mode"),
                    result.getString("overlap"), result.getString("catch_up"),
                    (Long) result.getObject("catch_up_limit"),
                    result.getBoolean("enabled"), result.getString("state"),
                    result.getString("blocked_reason"),
                    result.getLong("armed_at"),
                    (Long) result.getObject("watermark_slot"),
                    result.getString("lease_owner"),
                    (Long) result.getObject("lease_until"),
                    result.getLong("fence"), result.getLong("created_at"),
                    result.getLong("updated_at"));

    private static final RowMapper<OccurrenceRow> OCCURRENCE = (result, row) ->
            new OccurrenceRow(result.getString("tenant_id"),
                    result.getString("schedule_id"),
                    result.getString("occurrence_key"),
                    result.getString("run_id"), result.getString("session_id"),
                    (Long) result.getObject("slot"),
                    result.getString("trigger_kind"),
                    result.getString("outcome"), result.getString("reason"),
                    result.getLong("definition_revision"),
                    result.getLong("fence"), result.getInt("attempts"),
                    result.getLong("next_retry_at"),
                    result.getString("last_error"),
                    result.getLong("created_at"), result.getLong("updated_at"));

    private static final RowMapper<OccurrenceView> OCCURRENCE_VIEW =
            (result, row) -> new OccurrenceView(OCCURRENCE.mapRow(result, row),
                    result.getString("task_state"));

    private static final String OCCURRENCE_WITH_RUN = "SELECT o.*,"
            + " r.task_state FROM qwen_managed_automation_occurrence o"
            + " LEFT JOIN qwen_managed_session_extension_record r"
            + " ON r.tenant_id = o.tenant_id AND r.session_id = o.session_id"
            + " AND r.domain = 'automation_run' AND r.record_id = o.run_id"
            + " WHERE o.tenant_id = ? AND o.schedule_id = ?";

    private final JdbcTemplate jdbc;

    public AutomationLedgerStore(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * The run identity of one occurrence of one definition — the derivation
     * {@code managed-automation-operations.ts} makes, so both sides name the
     * same record (design decision 2).
     */
    public static String automationRunId(String scheduleId,
            String occurrenceKey) {
        return "arun_" + sha256(scheduleId + '\0' + occurrenceKey);
    }

    public static String automationInputId(String runId) {
        return runId + ":input";
    }

    public static String sha256(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
    }

    // --- definition mirror ---

    public Optional<ScheduleRow> findSchedule(String tenantId,
            String scheduleId) {
        return jdbc.query("SELECT * FROM qwen_managed_automation_schedule"
                        + " WHERE tenant_id = ? AND schedule_id = ?", SCHEDULE,
                tenantId, scheduleId).stream().findFirst();
    }

    /**
     * Inserts or refreshes the mirror of a definition revision. The arming
     * instant moves when a definition turns enabled, so slots of a disabled
     * span never fire later; the lease and watermark are kept.
     */
    public ScheduleRow upsertSchedule(ScheduleRow next, long now) {
        Optional<ScheduleRow> existing = findSchedule(next.tenantId(),
                next.scheduleId());
        if (existing.isEmpty()) {
            jdbc.update("INSERT INTO qwen_managed_automation_schedule"
                            + " (tenant_id, schedule_id, session_id,"
                            + " workspace_id, actor_id, record_revision,"
                            + " definition_revision, definition_digest, goal,"
                            + " cron, timezone, session_mode, overlap, catch_up,"
                            + " catch_up_limit, enabled, state, blocked_reason,"
                            + " armed_at, watermark_slot, lease_owner,"
                            + " lease_until, fence, created_at, updated_at)"
                            + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,"
                            + " ?, ?, ?, NULL, ?, NULL, NULL, NULL, 0, ?, ?)",
                    next.tenantId(), next.scheduleId(), next.sessionId(),
                    next.workspaceId(), next.actorId(), next.recordRevision(),
                    next.definitionRevision(), next.definitionDigest(),
                    next.goal(), next.cron(), next.timezone(),
                    next.sessionMode(), next.overlap(), next.catchUp(),
                    next.catchUpLimit(), next.enabled(), next.state(), now,
                    now, now);
            return findSchedule(next.tenantId(), next.scheduleId())
                    .orElseThrow();
        }
        ScheduleRow current = existing.get();
        if (current.recordRevision() >= next.recordRevision()) {
            return current;
        }
        long armedAt = next.enabled() && !current.enabled() ? now
                : current.armedAt();
        jdbc.update("UPDATE qwen_managed_automation_schedule SET"
                        + " record_revision = ?, definition_revision = ?,"
                        + " definition_digest = ?, goal = ?, cron = ?,"
                        + " timezone = ?, session_mode = ?, overlap = ?,"
                        + " catch_up = ?, catch_up_limit = ?, enabled = ?,"
                        + " state = ?, blocked_reason = NULL, armed_at = ?,"
                        + " updated_at = ? WHERE tenant_id = ? AND schedule_id = ?"
                        + " AND record_revision < ?",
                next.recordRevision(), next.definitionRevision(),
                next.definitionDigest(), next.goal(), next.cron(),
                next.timezone(), next.sessionMode(), next.overlap(),
                next.catchUp(), next.catchUpLimit(), next.enabled(),
                next.state(), armedAt, now, next.tenantId(), next.scheduleId(),
                next.recordRevision());
        return findSchedule(next.tenantId(), next.scheduleId()).orElseThrow();
    }

    private static final String STALE_MIRRORS = "SELECT r.tenant_id,"
            + " r.workspace_id, r.session_id, r.record_id, r.revision,"
            + " r.record_resource_id FROM qwen_managed_session_extension_record r"
            + " LEFT JOIN qwen_managed_automation_schedule s"
            + " ON s.tenant_id = r.tenant_id AND s.schedule_id = r.record_id"
            + " WHERE r.domain = 'schedule'"
            + " AND (s.schedule_id IS NULL OR s.record_revision < r.revision)";

    private static final RowMapper<StaleMirror> STALE_MIRROR = (result, row) ->
            new StaleMirror(result.getString("tenant_id"),
                    result.getString("workspace_id"),
                    result.getString("session_id"),
                    result.getString("record_id"), result.getLong("revision"),
                    result.getString("record_resource_id"));

    /** Committed definition records the mirror is missing or lags behind. */
    public List<StaleMirror> findStaleMirrors(int limit) {
        return jdbc.query(STALE_MIRRORS + " ORDER BY r.created_at, r.record_id"
                + " LIMIT ?", STALE_MIRROR, limit);
    }

    /** One definition's committed record when the mirror lags behind it. */
    public Optional<StaleMirror> findStaleMirror(String tenantId,
            String scheduleId) {
        return jdbc.query(STALE_MIRRORS + " AND r.tenant_id = ?"
                        + " AND r.record_id = ?", STALE_MIRROR, tenantId,
                scheduleId).stream().findFirst();
    }

    /**
     * The tenant's definitions in Workspaces the actor may read, newest
     * first: the page is cut after the grant, so no cursor names a
     * definition the caller cannot see.
     */
    public SchedulePage listReadableSchedules(String tenantId, String actorId,
            ScheduleCursor cursor, int limit) {
        if (actorId == null || actorId.isEmpty()) {
            return new SchedulePage(List.of(), false);
        }
        byte[] actorKey;
        try {
            actorKey = ManagedWorkspaceRegistry.actorKey(tenantId, actorId);
        } catch (IllegalArgumentException error) {
            return new SchedulePage(List.of(), false);
        }
        String select = "SELECT s.* FROM qwen_managed_automation_schedule s"
                + " WHERE s.tenant_id = ? AND EXISTS (SELECT 1 FROM"
                + " managed_workspace_access a WHERE a.tenant_id = s.tenant_id"
                + " AND a.workspace_id = s.workspace_id"
                + " AND CAST(CONCAT(a.workspace_id, '!') AS BINARY(513))"
                + " = CAST(CONCAT(s.workspace_id, '!') AS BINARY(513))"
                + " AND a.actor_id = ? AND a.can_read = TRUE)";
        List<ScheduleRow> rows = cursor == null
                ? jdbc.query(select + " ORDER BY s.created_at DESC,"
                        + " s.schedule_id DESC LIMIT ?", SCHEDULE, tenantId,
                        actorKey, limit + 1)
                : jdbc.query(select + " AND (s.created_at < ?"
                        + " OR (s.created_at = ? AND s.schedule_id < ?))"
                        + " ORDER BY s.created_at DESC, s.schedule_id DESC"
                        + " LIMIT ?", SCHEDULE, tenantId, actorKey,
                        cursor.createdAt(), cursor.createdAt(),
                        cursor.scheduleId(), limit + 1);
        boolean hasMore = rows.size() > limit;
        return new SchedulePage(hasMore ? rows.subList(0, limit) : rows,
                hasMore);
    }

    public int countLive(String tenantId, String sessionId) {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " qwen_managed_automation_schedule WHERE tenant_id = ?"
                        + " AND session_id = ? AND state = ?", Integer.class,
                tenantId, sessionId, STATE_LIVE);
        return count == null ? 0 : count;
    }

    // --- lease, fence, watermark ---

    /** Live, enabled, unblocked definitions whose lease is free or expired. */
    public List<ScheduleRow> findArmed(long now, int limit) {
        return jdbc.query("SELECT * FROM qwen_managed_automation_schedule"
                        + " WHERE state = ? AND enabled = TRUE"
                        + " AND blocked_reason IS NULL"
                        + " AND (lease_until IS NULL OR lease_until < ?)"
                        + " ORDER BY updated_at, schedule_id LIMIT ?", SCHEDULE,
                STATE_LIVE, now, limit);
    }

    /**
     * Definitions in any state that hold a claim due for re-drive and whose
     * lease is free or expired: a disabled or retired definition's lost
     * answer is still obtained.
     */
    public List<ScheduleRow> findFiringSchedules(long now, int limit) {
        return jdbc.query("SELECT s.* FROM qwen_managed_automation_schedule s"
                        + " WHERE (s.lease_until IS NULL OR s.lease_until < ?)"
                        + " AND EXISTS (SELECT 1 FROM"
                        + " qwen_managed_automation_occurrence o"
                        + " WHERE o.tenant_id = s.tenant_id"
                        + " AND o.schedule_id = s.schedule_id"
                        + " AND o.outcome = ? AND o.next_retry_at <= ?)"
                        + " ORDER BY s.updated_at, s.schedule_id LIMIT ?",
                SCHEDULE, now, OUTCOME_FIRING, now, limit);
    }

    /**
     * Claims one definition for a scanner: the lease must be free or
     * expired, and the fence moves so a scanner that lost it can prove
     * nothing about the row any more. Answers the fence held, or -1.
     */
    public long claim(String tenantId, String scheduleId, String owner,
            long leaseUntil, long now) {
        int claimed = jdbc.update("UPDATE qwen_managed_automation_schedule"
                        + " SET lease_owner = ?, lease_until = ?,"
                        + " fence = fence + 1, updated_at = ?"
                        + " WHERE tenant_id = ? AND schedule_id = ?"
                        + " AND (lease_until IS NULL OR lease_until < ?)",
                owner, leaseUntil, now, tenantId, scheduleId, now);
        if (claimed != 1) {
            return -1;
        }
        return jdbc.query("SELECT fence FROM qwen_managed_automation_schedule"
                        + " WHERE tenant_id = ? AND schedule_id = ?"
                        + " AND lease_owner = ?",
                (result, row) -> result.getLong("fence"), tenantId, scheduleId,
                owner).stream().findFirst().orElse(-1L);
    }

    public void release(String tenantId, String scheduleId, String owner,
            long fence, long now) {
        jdbc.update("UPDATE qwen_managed_automation_schedule"
                        + " SET lease_owner = NULL, lease_until = NULL,"
                        + " updated_at = ? WHERE tenant_id = ? AND schedule_id = ?"
                        + " AND lease_owner = ? AND fence = ?",
                now, tenantId, scheduleId, owner, fence);
    }

    /** True when the fenced write landed; false when the lease was lost. */
    public boolean advanceWatermark(String tenantId, String scheduleId,
            String owner, long fence, long slot, long now) {
        return jdbc.update("UPDATE qwen_managed_automation_schedule"
                        + " SET watermark_slot = ?, updated_at = ?"
                        + " WHERE tenant_id = ? AND schedule_id = ?"
                        + " AND lease_owner = ? AND fence = ?"
                        + " AND (watermark_slot IS NULL OR watermark_slot < ?)",
                slot, now, tenantId, scheduleId, owner, fence, slot) == 1;
    }

    public void block(String tenantId, String scheduleId, String owner,
            long fence, String reason, long now) {
        jdbc.update("UPDATE qwen_managed_automation_schedule"
                        + " SET blocked_reason = ?, updated_at = ?"
                        + " WHERE tenant_id = ? AND schedule_id = ?"
                        + " AND lease_owner = ? AND fence = ?",
                reason.substring(0, Math.min(reason.length(), 1024)), now,
                tenantId, scheduleId, owner, fence);
    }

    public void retire(String tenantId, String scheduleId, long now) {
        jdbc.update("UPDATE qwen_managed_automation_schedule SET state = ?,"
                        + " enabled = FALSE, updated_at = ?"
                        + " WHERE tenant_id = ? AND schedule_id = ?",
                STATE_RETIRED, now, tenantId, scheduleId);
    }

    // --- occurrences ---

    /**
     * Records one occurrence decision under the writer's lease unless one
     * exists: the row is selected from the definition row the owner holds,
     * so a writer whose lease was lost inserts nothing, and the primary key
     * keeps the first decision of a slot. Answers the row now held — the
     * one written, or the earlier decision — or empty when the lease was
     * lost and no decision exists.
     */
    public Optional<OccurrenceRow> recordOccurrence(OccurrenceRow row,
            String owner) {
        jdbc.update("INSERT IGNORE INTO qwen_managed_automation_occurrence"
                        + " (tenant_id, schedule_id, occurrence_key, run_id,"
                        + " session_id, slot, trigger_kind, outcome, reason,"
                        + " definition_revision, fence, attempts,"
                        + " next_retry_at, last_error, created_at, updated_at)"
                        + " SELECT s.tenant_id, s.schedule_id, ?, ?, ?, ?, ?,"
                        + " ?, ?, ?, s.fence, 0, 0, NULL, ?, ?"
                        + " FROM qwen_managed_automation_schedule s"
                        + " WHERE s.tenant_id = ? AND s.schedule_id = ?"
                        + " AND s.lease_owner = ? AND s.fence = ?",
                row.occurrenceKey(), row.runId(), row.sessionId(), row.slot(),
                row.trigger(), row.outcome(), row.reason(),
                row.definitionRevision(), row.createdAt(), row.updatedAt(),
                row.tenantId(), row.scheduleId(), owner, row.fence());
        return findOccurrence(row.tenantId(), row.scheduleId(),
                row.occurrenceKey());
    }

    public Optional<OccurrenceRow> findOccurrence(String tenantId,
            String scheduleId, String occurrenceKey) {
        return jdbc.query("SELECT * FROM qwen_managed_automation_occurrence"
                        + " WHERE tenant_id = ? AND schedule_id = ?"
                        + " AND occurrence_key = ?", OCCURRENCE, tenantId,
                scheduleId, occurrenceKey).stream().findFirst();
    }

    /**
     * A firing row settles into its outcome once the Harness answered;
     * only the lease holder settles. True when the write landed.
     */
    public boolean settleOccurrence(String tenantId, String scheduleId,
            String occurrenceKey, String outcome, String reason, String owner,
            long fence, long now) {
        return jdbc.update("UPDATE qwen_managed_automation_occurrence o"
                        + " SET o.outcome = ?, o.reason = ?, o.updated_at = ?"
                        + " WHERE o.tenant_id = ? AND o.schedule_id = ?"
                        + " AND o.occurrence_key = ? AND o.outcome = ?" + HELD,
                outcome, reason, now, tenantId, scheduleId, occurrenceKey,
                OUTCOME_FIRING, tenantId, scheduleId, owner, fence) == 1;
    }

    /** A firing claim re-pinned to the definition revision now live. */
    public boolean repinOccurrence(String tenantId, String scheduleId,
            String occurrenceKey, long definitionRevision, String owner,
            long fence, long now) {
        return jdbc.update("UPDATE qwen_managed_automation_occurrence o"
                        + " SET o.definition_revision = ?, o.updated_at = ?"
                        + " WHERE o.tenant_id = ? AND o.schedule_id = ?"
                        + " AND o.occurrence_key = ? AND o.outcome = ?" + HELD,
                definitionRevision, now, tenantId, scheduleId, occurrenceKey,
                OUTCOME_FIRING, tenantId, scheduleId, owner, fence) == 1;
    }

    /** A firing claim whose answer was not obtained: re-driven later. */
    public boolean deferOccurrence(String tenantId, String scheduleId,
            String occurrenceKey, int attempts, long nextRetryAt,
            String lastError, String owner, long fence, long now) {
        String error = lastError == null ? null
                : lastError.substring(0, Math.min(lastError.length(), 1024));
        return jdbc.update("UPDATE qwen_managed_automation_occurrence o"
                        + " SET o.attempts = ?, o.next_retry_at = ?,"
                        + " o.last_error = ?, o.updated_at = ?"
                        + " WHERE o.tenant_id = ? AND o.schedule_id = ?"
                        + " AND o.occurrence_key = ? AND o.outcome = ?" + HELD,
                attempts, nextRetryAt, error, now, tenantId, scheduleId,
                occurrenceKey, OUTCOME_FIRING, tenantId, scheduleId, owner,
                fence) == 1;
    }

    /** The definition's claims due for re-drive at {@code now}. */
    public List<OccurrenceRow> findFiring(String tenantId, String scheduleId,
            long now) {
        return jdbc.query("SELECT * FROM qwen_managed_automation_occurrence"
                        + " WHERE tenant_id = ? AND schedule_id = ?"
                        + " AND outcome = ? AND next_retry_at <= ?"
                        + " ORDER BY created_at, occurrence_key", OCCURRENCE,
                tenantId, scheduleId, OUTCOME_FIRING, now);
    }

    /**
     * The definition's occurrences whose run is not terminal: firing rows,
     * and fired rows whose run record is still pending or running (a fired
     * row with no visible record counts, so a lag never admits an overlap).
     */
    public int countActive(String tenantId, String scheduleId) {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " qwen_managed_automation_occurrence o"
                        + " LEFT JOIN qwen_managed_session_extension_record r"
                        + " ON r.tenant_id = o.tenant_id"
                        + " AND r.session_id = o.session_id"
                        + " AND r.domain = 'automation_run'"
                        + " AND r.record_id = o.run_id"
                        + " WHERE o.tenant_id = ? AND o.schedule_id = ?"
                        + " AND (o.outcome = ? OR (o.outcome = ?"
                        + " AND (r.task_state IS NULL OR r.task_state NOT IN"
                        + " ('completed', 'failed', 'cancelled'))))",
                Integer.class, tenantId, scheduleId, OUTCOME_FIRING,
                OUTCOME_FIRED);
        return count == null ? 0 : count;
    }

    /**
     * The fired occurrences whose run keeps the overlap admission closed:
     * the same set {@link #countActive} counts behind {@code firing}
     * claims, named with their run ids so the scanner can ask the Harness
     * to reconcile the ones its wake turn died on (oldest first, bounded,
     * so one decision's reconcile fan-out stays small).
     */
    public List<OccurrenceView> findBlockingRuns(String tenantId,
            String scheduleId, int limit) {
        return jdbc.query(OCCURRENCE_WITH_RUN
                        + " AND o.outcome = ? AND (r.task_state IS NULL"
                        + " OR r.task_state NOT IN"
                        + " ('completed', 'failed', 'cancelled'))"
                        + " ORDER BY o.created_at, o.occurrence_key LIMIT ?",
                OCCURRENCE_VIEW, tenantId, scheduleId, OUTCOME_FIRED, limit);
    }

    /** Whether a public Turn of the Session has not ended yet. */
    public boolean hasOpenTurn(String tenantId, String sessionId) {
        return !jdbc.queryForList("SELECT 1 FROM managed_agent_turn"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND status IN ('ACCEPTED', 'RUNNING', 'CANCELLING')"
                        + " LIMIT 1", Integer.class, tenantId, sessionId)
                .isEmpty();
    }

    /** One occurrence with its run's task state, when one committed. */
    public Optional<OccurrenceView> findOccurrenceView(String tenantId,
            String scheduleId, String occurrenceKey) {
        return jdbc.query(OCCURRENCE_WITH_RUN + " AND o.occurrence_key = ?",
                OCCURRENCE_VIEW, tenantId, scheduleId, occurrenceKey).stream()
                .findFirst();
    }

    public OccurrencePage listOccurrences(String tenantId, String scheduleId,
            OccurrenceCursor cursor, int limit) {
        List<OccurrenceView> rows = cursor == null
                ? jdbc.query(OCCURRENCE_WITH_RUN + " ORDER BY o.created_at DESC,"
                        + " o.occurrence_key DESC LIMIT ?", OCCURRENCE_VIEW,
                        tenantId, scheduleId, limit + 1)
                : jdbc.query(OCCURRENCE_WITH_RUN + " AND (o.created_at < ? OR"
                        + " (o.created_at = ? AND o.occurrence_key < ?))"
                        + " ORDER BY o.created_at DESC, o.occurrence_key DESC"
                        + " LIMIT ?", OCCURRENCE_VIEW, tenantId, scheduleId,
                        cursor.createdAt(), cursor.createdAt(),
                        cursor.occurrenceKey(), limit + 1);
        boolean hasMore = rows.size() > limit;
        return new OccurrencePage(hasMore ? rows.subList(0, limit) : rows,
                hasMore);
    }

    // --- public command replay ---

    public Optional<CommandRow> findCommand(String tenantId,
            String idempotencyKey) {
        return jdbc.query("SELECT * FROM qwen_managed_automation_command"
                        + " WHERE tenant_id = ? AND idempotency_key = ?",
                (result, row) -> new CommandRow(result.getString("tenant_id"),
                        result.getString("idempotency_key"),
                        result.getString("actor_id"),
                        result.getString("request_digest"),
                        result.getString("schedule_id"),
                        result.getString("result_json")), tenantId,
                idempotencyKey).stream().findFirst();
    }

    public void recordCommand(CommandRow command, long now) {
        jdbc.update("INSERT IGNORE INTO qwen_managed_automation_command"
                        + " (tenant_id, idempotency_key, actor_id,"
                        + " request_digest, schedule_id, result_json,"
                        + " created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                command.tenantId(), command.idempotencyKey(),
                command.actorId(), command.requestDigest(),
                command.scheduleId(), command.resultJson(), now);
    }

    /**
     * Claims (tenant, key) for one request before any side effect: the
     * primary key arbitrates, so only one concurrent or retried caller
     * owns the identity; the row's empty result marks it unanswered. A
     * claim whose requester dies mid-flight stays durable, which is what
     * lets a different request under the same key conflict instead of
     * repeating the side effect.
     */
    public boolean claimCommand(CommandRow command, long now) {
        return jdbc.update("INSERT IGNORE INTO qwen_managed_automation_command"
                + " (tenant_id, idempotency_key, actor_id, request_digest,"
                + " schedule_id, result_json, created_at)"
                + " VALUES (?, ?, ?, ?, ?, '', ?)", command.tenantId(),
                command.idempotencyKey(), command.actorId(),
                command.requestDigest(), command.scheduleId(), now) == 1;
    }

    /**
     * Fills in the answer of a claim, guarded both ways: only the row's
     * own request writes its answer, and only while it stays unanswered —
     * a late re-driven mutation can neither steal another request's row
     * nor overwrite a completed result.
     */
    public boolean settleCommand(String tenantId, String idempotencyKey,
            String requestDigest, String actorId, String resultJson) {
        return jdbc.update("UPDATE qwen_managed_automation_command"
                + " SET result_json = ?"
                + " WHERE tenant_id = ? AND idempotency_key = ?"
                + " AND request_digest = ? AND actor_id = ?"
                + " AND result_json = ''", resultJson, tenantId,
                idempotencyKey, requestDigest, actorId) > 0;
    }

    /**
     * Releases a claim whose operation the Harness definitively refused:
     * a 4xx answer commits nothing, so the key goes back to its owner
     * rather than burning it — guarded the same way, so only the claim's
     * own unanswered row is ever removed.
     */
    public boolean releaseCommand(String tenantId, String idempotencyKey,
            String requestDigest, String actorId) {
        return jdbc.update("DELETE FROM qwen_managed_automation_command"
                + " WHERE tenant_id = ? AND idempotency_key = ?"
                + " AND request_digest = ? AND actor_id = ?"
                + " AND result_json = ''", tenantId, idempotencyKey,
                requestDigest, actorId) > 0;
    }

    // --- Session store reads ---

    public String sessionStatus(String tenantId, String sessionId) {
        return jdbc.query("SELECT status FROM managed_agent_session"
                        + " WHERE tenant_id = ? AND session_id = ?",
                (result, row) -> result.getString("status"), tenantId,
                sessionId).stream().findFirst().orElse(null);
    }

    /** One inline resource's bytes, or null when it is not inline-held. */
    public String readResource(String tenantId, String resourceId) {
        return jdbc.query("SELECT inline_bytes FROM qwen_managed_session_resource"
                        + " WHERE tenant_id = ? AND resource_id = ?"
                        + " AND storage_kind = 'MYSQL_INLINE'"
                        + " AND state = 'REFERENCED'",
                (result, row) -> new String(result.getBytes("inline_bytes"),
                        StandardCharsets.UTF_8), tenantId, resourceId)
                .stream().findFirst().orElse(null);
    }
}
