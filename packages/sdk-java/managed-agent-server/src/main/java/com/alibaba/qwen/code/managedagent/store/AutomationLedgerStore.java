package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.managedagent.api.ApiException;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptNamespace;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaContract.ReceiptScope;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import com.fasterxml.jackson.databind.JsonNode;
import org.apache.commons.codec.digest.DigestUtils;
import org.apache.commons.lang3.StringUtils;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

/**
 * H6b: the JDBC side of the automation runtime — the V57 ledgers (the definition mirror with its
 * lease and watermark, the occurrence decisions, the public command replay) and the small reads the
 * scanner and service need from the Session store. No row here is a journal fact: the Session
 * journal's schedule and automation_run chains stay the authority. Schedule definitions are
 * projected in the same transaction as their journal commit.
 *
 * <p>Every occurrence write names the lease its writer holds: the insert selects its row from the
 * definition row the holder leases, and each settle is conditioned on that same holder and fence,
 * so a scanner whose lease expired under it cannot record or settle a decision.
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
            + " ma_schedule s WHERE s.tenant_id = ?"
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
                    result.getObject("watermark_slot", Long.class),
                    result.getString("lease_owner"),
                    result.getObject("lease_until", Long.class),
                    result.getLong("fence"), result.getLong("gmt_create"),
                    result.getLong("gmt_modified"));

    private static final RowMapper<OccurrenceRow> OCCURRENCE = (result, row) ->
            new OccurrenceRow(result.getString("tenant_id"),
                    result.getString("schedule_id"),
                    result.getString("occurrence_key"),
                    result.getString("run_id"), result.getString("session_id"),
                    result.getObject("slot", Long.class),
                    result.getString("trigger_kind"),
                    result.getString("outcome"), result.getString("reason"),
                    result.getLong("definition_revision"),
                    result.getLong("fence"), result.getInt("attempts"),
                    result.getLong("next_retry_at"),
                    result.getString("last_error"),
                    result.getLong("gmt_create"), result.getLong("gmt_modified"));

    private static final String OCCURRENCE_SELECT = "SELECT " + ManagedSchemaProjection.SCHEDULE_OCCURRENCE.columns("o") + " FROM"
            + " ma_schedule_occurrence o"
            + " WHERE o.tenant_id = ? AND o.schedule_id = ?";

    /** The mirror's terminal task states, as the projection maps them. */
    private static final Set<String> TERMINAL_MIRROR_STATES = Set.of(
            "completed", "failed", "cancelled");

    private record RunIdentity(String sessionId, String runId) { }

    private record OccurrenceOutcome(String outcome, String sessionId,
            String runId) { }

    private static final String OCCURRENCE_OUTCOME_SELECT = "SELECT"
            + " o.outcome, o.session_id, o.run_id FROM"
            + " ma_schedule_occurrence o"
            + " WHERE o.tenant_id = ? AND o.schedule_id = ?"
            + " AND o.outcome IN (?, ?)";

    private final JdbcTemplate jdbc;
    private final TransactionTemplate commands;

    public AutomationLedgerStore(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
        this.commands =
                new TransactionTemplate(
                        new DataSourceTransactionManager(
                                Objects.requireNonNull(jdbc.getDataSource())));
        this.commands.setTimeout(10);
    }

    /**
     * The run identity of one occurrence of one definition — the derivation {@code
     * managed-automation-operations.ts} makes, so both sides name the same record (design decision
     * 2).
     */
    public static String automationRunId(String scheduleId,
            String occurrenceKey) {
        return "arun_" + sha256(scheduleId + '\0' + occurrenceKey);
    }

    public static String automationInputId(String runId) {
        return runId + ":input";
    }

    /**
     * Each run's mirror task_state by its exact projection PK, in one batch keyed to the pair every
     * index on the mirror table leads with.
     */
    private Map<String, String> readTaskStates(String tenantId,
            List<RunIdentity> identities) {
        if (identities.isEmpty()) {
            return Map.of();
        }
        StringBuilder sql = new StringBuilder(
                "SELECT session_scope_key, record_key, task_state FROM"
                        + " ma_session_record WHERE ");
        List<Object> args = new ArrayList<>(identities.size() * 2);
        Map<String, String> byRecordKey = new HashMap<>();
        Map<String, String> runByRecordKey = new HashMap<>();
        for (int index = 0; index < identities.size(); index += 1) {
            if (index > 0) {
                sql.append(" OR ");
            }
            sql.append("(session_scope_key = ? AND record_key = ?)");
            String recordKey = ManagedExtensionProjection.recordKey(
                    identities.get(index).sessionId(), "automation_run",
                    identities.get(index).runId());
            args.add(ManagedSessionStore.sessionScopeKey(tenantId,
                    identities.get(index).sessionId()));
            args.add(recordKey);
            runByRecordKey.put(recordKey, identities.get(index).runId());
        }
        for (String[] pair : jdbc.query(sql.toString(),
                (result, row) -> new String[] {
                        result.getString("record_key"),
                        result.getString("task_state") },
                args.toArray())) {
            byRecordKey.put(pair[0], pair[1]);
        }
        Map<String, String> byRunId = new HashMap<>();
        for (Map.Entry<String, String> entry : byRecordKey.entrySet()) {
            byRunId.put(runByRecordKey.get(entry.getKey()), entry.getValue());
        }
        return byRunId;
    }

    public static String sha256(String value) {
        return DigestUtils.sha256Hex(value.getBytes(StandardCharsets.UTF_8));
    }

    // --- definition mirror ---

    public Optional<ScheduleRow> findSchedule(String tenantId,
            String scheduleId) {
        return jdbc.query("SELECT " + ManagedSchemaProjection.SCHEDULE.columns() + " FROM ma_schedule"
                        + " WHERE tenant_id = ? AND schedule_id = ?", SCHEDULE,
                tenantId, scheduleId).stream().findFirst();
    }

    /** Called only by the authoritative record commit, within its SQL transaction. */
    public void projectSchedule(String tenantId, String workspaceId,
            String sessionId, long recordRevision, JsonNode record, long now) {
        if (!TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException(
                    "Schedule projection requires the journal transaction.");
        }
        String actorId = jdbc.query("SELECT creator_actor_key FROM ma_session"
                        + " WHERE tenant_id = ? AND session_id = ?",
                (result, row) -> {
                    byte[] actor = result.getBytes("creator_actor_key");
                    return actor == null ? "" : new String(actor, StandardCharsets.UTF_8);
                }, tenantId, sessionId).stream().findFirst().orElse("");
        JsonNode limit = record.required("catchUpLimit");
        ScheduleRow next =
                new ScheduleRow(
                        tenantId,
                        record.required("scheduleId").asText(),
                        sessionId,
                        workspaceId,
                        actorId,
                        recordRevision,
                        record.required("definitionRevision").asLong(),
                        record.required("definitionDigest").asText(),
                        record.required("goal").asText(),
                        record.required("cron").asText(),
                        record.required("timezone").asText(),
                        record.required("sessionMode").asText(),
                        record.required("overlap").asText(),
                        record.required("catchUp").asText(),
                        limit.isNull() ? null : limit.asLong(),
                        record.required("enabled").asBoolean(),
                        ManagedExtensionRecords.isTerminalRunState(
                                        record.required("run").required("state").asText())
                                ? STATE_RETIRED
                                : STATE_LIVE,
                        null,
                        now,
                        null,
                        null,
                        null,
                        0,
                        now,
                        now);
        Optional<ScheduleRow> existing = jdbc.query("SELECT " + ManagedSchemaProjection.SCHEDULE.columns() + " FROM ma_schedule WHERE tenant_id = ? AND schedule_id = ? FOR UPDATE", SCHEDULE,
                next.tenantId(), next.scheduleId()).stream().findFirst();
        if (existing.isEmpty()) {
            jdbc.update("INSERT INTO ma_schedule"
                            + " (tenant_id, schedule_id, session_id,"
                            + " workspace_id, actor_id, record_revision,"
                            + " definition_revision, definition_digest, goal,"
                            + " cron, timezone, session_mode, overlap, catch_up,"
                            + " catch_up_limit, enabled, state, blocked_reason,"
                            + " armed_at, watermark_slot, lease_owner,"
                            + " lease_until, fence, gmt_create, gmt_modified)"
                            + " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,"
                            + " ?, ?, ?, NULL, ?, NULL, NULL, NULL, 0, ?, ?)",
                    next.tenantId(), next.scheduleId(), next.sessionId(),
                    next.workspaceId(), next.actorId(), next.recordRevision(),
                    next.definitionRevision(), next.definitionDigest(),
                    next.goal(), next.cron(), next.timezone(),
                    next.sessionMode(), next.overlap(), next.catchUp(),
                    next.catchUpLimit(), next.enabled(), next.state(), now,
                    now, now);
            return;
        }
        ScheduleRow current = existing.get();
        if (!Objects.equals(current.sessionId(), sessionId)
                || !Objects.equals(current.workspaceId(), workspaceId)) {
            throw new ApiException(HttpStatus.CONFLICT,
                    ManagedExtensionRecordStore.ERROR_REJECTED,
                    "A schedule identity belongs to another Session.");
        }
        if (current.recordRevision() >= next.recordRevision()) {
            return;
        }
        long armedAt = next.enabled() && !current.enabled() ? now
                : current.armedAt();
        jdbc.update("UPDATE ma_schedule SET"
                        + " record_revision = ?, definition_revision = ?,"
                        + " definition_digest = ?, goal = ?, cron = ?,"
                        + " timezone = ?, session_mode = ?, overlap = ?,"
                        + " catch_up = ?, catch_up_limit = ?, enabled = ?,"
                        + " state = ?, blocked_reason = NULL, armed_at = ?,"
                        + " gmt_modified = ? WHERE tenant_id = ? AND schedule_id = ?"
                        + " AND record_revision < ?",
                next.recordRevision(), next.definitionRevision(),
                next.definitionDigest(), next.goal(), next.cron(),
                next.timezone(), next.sessionMode(), next.overlap(),
                next.catchUp(), next.catchUpLimit(), next.enabled(),
                next.state(), armedAt, now, next.tenantId(), next.scheduleId(),
                next.recordRevision());
    }

    /**
     * The tenant's definitions in Workspaces the actor may read, newest first: the page is cut
     * after the grant, so no cursor names a definition the caller cannot see.
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
        String select =
                "WITH RECURSIVE readable_workspace (tenant_identity, workspace_identity) AS ( SELECT CONCAT(w.tenant_id, '!'), CONCAT(w.workspace_id, '!') FROM ma_workspace w JOIN ma_workspace_access a ON a.tenant_id = w.tenant_id AND a.workspace_id = w.workspace_id WHERE w.tenant_id = ? AND w.workspace_kind = 'ROOT' AND a.actor_id = ? AND a.role IN ('READER', 'OPERATOR', 'OWNER') UNION ALL SELECT CONCAT(c.tenant_id, '!'), CONCAT(c.workspace_id, '!') FROM ma_workspace c JOIN readable_workspace p ON CONCAT(c.tenant_id, '!') = p.tenant_identity AND CONCAT(c.parent_workspace_id, '!') = p.workspace_identity WHERE c.tenant_id = ? AND c.workspace_kind = 'CHILD_GIT') SELECT " + ManagedSchemaProjection.SCHEDULE.columns("s") + " FROM ma_schedule s WHERE s.tenant_id = ? AND EXISTS (SELECT 1 FROM readable_workspace r WHERE r.tenant_identity = CONCAT(s.tenant_id, '!') AND r.workspace_identity = CONCAT(s.workspace_id, '!'))";
        List<ScheduleRow> rows = cursor == null
                ? jdbc.query(select + " ORDER BY s.gmt_create DESC,"
                        + " s.schedule_id DESC LIMIT ?", SCHEDULE, tenantId,
                        actorKey, tenantId, tenantId, limit + 1)
                : jdbc.query(select + " AND (s.gmt_create < ?"
                        + " OR (s.gmt_create = ? AND s.schedule_id < ?))"
                        + " ORDER BY s.gmt_create DESC, s.schedule_id DESC"
                        + " LIMIT ?", SCHEDULE, tenantId, actorKey, tenantId, tenantId,
                        cursor.createdAt(), cursor.createdAt(),
                        cursor.scheduleId(), limit + 1);
        boolean hasMore = rows.size() > limit;
        return new SchedulePage(hasMore ? rows.subList(0, limit) : rows,
                hasMore);
    }

    public int countLive(String tenantId, String sessionId) {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM"
                        + " ma_schedule WHERE tenant_id = ?"
                        + " AND session_id = ? AND state = ?", Integer.class,
                tenantId, sessionId, STATE_LIVE);
        return count == null ? 0 : count;
    }

    // --- lease, fence, watermark ---

    /** Live, enabled, unblocked definitions whose lease is free or expired. */
    public List<ScheduleRow> findArmed(long now, int limit) {
        return jdbc.query("SELECT " + ManagedSchemaProjection.SCHEDULE.columns() + " FROM ma_schedule"
                        + " WHERE state = ? AND enabled = TRUE"
                        + " AND blocked_reason IS NULL"
                        + " AND (lease_until IS NULL OR lease_until < ?)"
                        + " ORDER BY gmt_modified, schedule_id LIMIT ?", SCHEDULE,
                STATE_LIVE, now, limit);
    }

    /**
     * Definitions in any state that hold a claim due for re-drive and whose lease is free or
     * expired: a disabled or retired definition's lost answer is still obtained.
     */
    public List<ScheduleRow> findFiringSchedules(long now, int limit) {
        return jdbc.query("SELECT " + ManagedSchemaProjection.SCHEDULE.columns("s") + " FROM ma_schedule s"
                        + " WHERE (s.lease_until IS NULL OR s.lease_until < ?)"
                        + " AND EXISTS (SELECT 1 FROM"
                        + " ma_schedule_occurrence o"
                        + " WHERE o.tenant_id = s.tenant_id"
                        + " AND o.schedule_id = s.schedule_id"
                        + " AND o.outcome = ? AND o.next_retry_at <= ?)"
                        + " ORDER BY s.gmt_modified, s.schedule_id LIMIT ?",
                SCHEDULE, now, OUTCOME_FIRING, now, limit);
    }

    /**
     * Claims one definition for a scanner: the lease must be free or expired, and the fence moves
     * so a scanner that lost it can prove nothing about the row any more. Answers the fence held,
     * or -1.
     */
    public long claim(String tenantId, String scheduleId, String owner,
            long leaseUntil, long now) {
        int claimed = jdbc.update("UPDATE ma_schedule"
                        + " SET lease_owner = ?, lease_until = ?,"
                        + " fence = fence + 1, gmt_modified = ?"
                        + " WHERE tenant_id = ? AND schedule_id = ?"
                        + " AND (lease_until IS NULL OR lease_until < ?)",
                owner, leaseUntil, now, tenantId, scheduleId, now);
        if (claimed != 1) {
            return -1;
        }
        return jdbc.query("SELECT fence FROM ma_schedule"
                        + " WHERE tenant_id = ? AND schedule_id = ?"
                        + " AND lease_owner = ?",
                (result, row) -> result.getLong("fence"), tenantId, scheduleId,
                owner).stream().findFirst().orElse(-1L);
    }

    public void release(String tenantId, String scheduleId, String owner,
            long fence, long now) {
        jdbc.update("UPDATE ma_schedule"
                        + " SET lease_owner = NULL, lease_until = NULL,"
                        + " gmt_modified = ? WHERE tenant_id = ? AND schedule_id = ?"
                        + " AND lease_owner = ? AND fence = ?",
                now, tenantId, scheduleId, owner, fence);
    }

    /** True when the fenced write landed; false when the lease was lost. */
    public boolean advanceWatermark(String tenantId, String scheduleId,
            String owner, long fence, long slot, long now) {
        return jdbc.update("UPDATE ma_schedule"
                        + " SET watermark_slot = ?, gmt_modified = ?"
                        + " WHERE tenant_id = ? AND schedule_id = ?"
                        + " AND lease_owner = ? AND fence = ?"
                        + " AND (watermark_slot IS NULL OR watermark_slot < ?)",
                slot, now, tenantId, scheduleId, owner, fence, slot) == 1;
    }

    public void block(String tenantId, String scheduleId, String owner,
            long fence, String reason, long now) {
        jdbc.update("UPDATE ma_schedule"
                        + " SET blocked_reason = ?, gmt_modified = ?"
                        + " WHERE tenant_id = ? AND schedule_id = ?"
                        + " AND lease_owner = ? AND fence = ?",
                StringUtils.truncate(Objects.requireNonNull(reason), 1024), now,
                tenantId, scheduleId, owner, fence);
    }

    public void retire(String tenantId, String scheduleId, long now) {
        jdbc.update("UPDATE ma_schedule SET state = ?,"
                        + " gmt_modified = ?"
                        + " WHERE tenant_id = ? AND schedule_id = ?",
                STATE_RETIRED, now, tenantId, scheduleId);
    }

    // --- occurrences ---

    /**
     * Records one occurrence decision under the writer's lease unless one exists: the row is
     * selected from the definition row the owner holds, so a writer whose lease was lost inserts
     * nothing, and the primary key keeps the first decision of a slot. Answers the row now held —
     * the one written, or the earlier decision — or empty when the lease was lost and no decision
     * exists.
     */
    public Optional<OccurrenceRow> recordOccurrence(OccurrenceRow row,
            String owner) {
        jdbc.update("INSERT IGNORE INTO ma_schedule_occurrence"
                        + " (tenant_id, schedule_id, occurrence_key, run_id,"
                        + " session_id, slot, trigger_kind, outcome, reason,"
                        + " definition_revision, fence, attempts,"
                        + " next_retry_at, last_error, gmt_create, gmt_modified)"
                        + " SELECT s.tenant_id, s.schedule_id, ?, ?, ?, ?, ?,"
                        + " ?, ?, ?, s.fence, 0, 0, NULL, ?, ?"
                        + " FROM ma_schedule s"
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
        return jdbc.query("SELECT " + ManagedSchemaProjection.SCHEDULE_OCCURRENCE.columns() + " FROM ma_schedule_occurrence"
                        + " WHERE tenant_id = ? AND schedule_id = ?"
                        + " AND occurrence_key = ?", OCCURRENCE, tenantId,
                scheduleId, occurrenceKey).stream().findFirst();
    }

    /**
     * A firing row settles into its outcome once the Harness answered; only the lease holder
     * settles. True when the write landed.
     */
    public boolean settleOccurrence(String tenantId, String scheduleId,
            String occurrenceKey, String outcome, String reason, String owner,
            long fence, long now) {
        return jdbc.update("UPDATE ma_schedule_occurrence o"
                        + " SET o.outcome = ?, o.reason = ?, o.gmt_modified = ?"
                        + " WHERE o.tenant_id = ? AND o.schedule_id = ?"
                        + " AND o.occurrence_key = ? AND o.outcome = ?" + HELD,
                outcome, reason, now, tenantId, scheduleId, occurrenceKey,
                OUTCOME_FIRING, tenantId, scheduleId, owner, fence) == 1;
    }

    /** A firing claim re-pinned to the definition revision now live. */
    public boolean repinOccurrence(String tenantId, String scheduleId,
            String occurrenceKey, long definitionRevision, String owner,
            long fence, long now) {
        return jdbc.update("UPDATE ma_schedule_occurrence o"
                        + " SET o.definition_revision = ?, o.gmt_modified = ?"
                        + " WHERE o.tenant_id = ? AND o.schedule_id = ?"
                        + " AND o.occurrence_key = ? AND o.outcome = ?" + HELD,
                definitionRevision, now, tenantId, scheduleId, occurrenceKey,
                OUTCOME_FIRING, tenantId, scheduleId, owner, fence) == 1;
    }

    /** A firing claim whose answer was not obtained: re-driven later. */
    public boolean deferOccurrence(String tenantId, String scheduleId,
            String occurrenceKey, int attempts, long nextRetryAt,
            String lastError, String owner, long fence, long now) {
        String error = StringUtils.truncate(lastError, 1024);
        return jdbc.update("UPDATE ma_schedule_occurrence o"
                        + " SET o.attempts = ?, o.next_retry_at = ?,"
                        + " o.last_error = ?, o.gmt_modified = ?"
                        + " WHERE o.tenant_id = ? AND o.schedule_id = ?"
                        + " AND o.occurrence_key = ? AND o.outcome = ?" + HELD,
                attempts, nextRetryAt, error, now, tenantId, scheduleId,
                occurrenceKey, OUTCOME_FIRING, tenantId, scheduleId, owner,
                fence) == 1;
    }

    /** The definition's claims due for re-drive at {@code now}. */
    public List<OccurrenceRow> findFiring(String tenantId, String scheduleId,
            long now) {
        return jdbc.query("SELECT " + ManagedSchemaProjection.SCHEDULE_OCCURRENCE.columns() + " FROM ma_schedule_occurrence"
                        + " WHERE tenant_id = ? AND schedule_id = ?"
                        + " AND outcome = ? AND next_retry_at <= ?"
                        + " ORDER BY gmt_create, occurrence_key", OCCURRENCE,
                tenantId, scheduleId, OUTCOME_FIRING, now);
    }

    /**
     * The definition's occurrences whose run is not terminal: firing rows, and fired rows whose run
     * record is still pending or running (a fired row with no visible record counts, so a lag never
     * admits an overlap). The mirror fact arrives through exact point lookups of each run's
     * (session_scope_key, record_key): the extension-record table's own indexes all lead with that
     * pair, and a raw-column join rescans the whole journal mirror per call (Q3-45).
     */
    public int countActive(String tenantId, String scheduleId) {
        List<OccurrenceOutcome> outcomes = jdbc.query(
                OCCURRENCE_OUTCOME_SELECT,
                (result, row) -> new OccurrenceOutcome(
                        result.getString("outcome"),
                        result.getString("session_id"),
                        result.getString("run_id")),
                tenantId, scheduleId, OUTCOME_FIRING, OUTCOME_FIRED);
        int firing = 0;
        List<RunIdentity> identities = new ArrayList<>();
        for (OccurrenceOutcome outcome : outcomes) {
            if (OUTCOME_FIRING.equals(outcome.outcome())) {
                firing += 1;
            } else {
                identities.add(new RunIdentity(outcome.sessionId(),
                        outcome.runId()));
            }
        }
        Map<String, String> states = readTaskStates(tenantId, identities);
        int count = firing;
        for (RunIdentity identity : identities) {
            String state = states.get(identity.runId());
            if (state == null || !TERMINAL_MIRROR_STATES.contains(state)) {
                count += 1;
            }
        }
        return count;
    }

    /**
     * The fired occurrences whose run keeps the overlap admission closed: the same set {@link
     * #countActive} counts behind {@code firing} claims, named with their run ids so the scanner
     * can ask the Harness to reconcile the ones its wake turn died on (oldest first, bounded, so
     * one decision's reconcile fan-out stays small). The fired history walks oldest-first in pages,
     * each page's mirror states a batch of exact PK point lookups instead of one full-table rescan
     * (Q3-45).
     */
    public List<OccurrenceView> findBlockingRuns(String tenantId,
            String scheduleId, int limit) {
        List<OccurrenceView> blocking = new ArrayList<>();
        int offset = 0;
        while (blocking.size() < limit) {
            List<OccurrenceRow> page = jdbc.query(OCCURRENCE_SELECT
                            + " AND o.outcome = ?"
                            + " ORDER BY o.gmt_create, o.occurrence_key"
                            + " LIMIT ? OFFSET ?",
                    OCCURRENCE, tenantId, scheduleId, OUTCOME_FIRED, 256,
                    offset);
            if (page.isEmpty()) {
                return blocking;
            }
            Map<String, String> states = readTaskStates(tenantId,
                    page.stream()
                            .map(row -> new RunIdentity(row.sessionId(),
                                    row.runId()))
                            .toList());
            for (OccurrenceRow row : page) {
                String state = states.get(row.runId());
                if (state == null || !TERMINAL_MIRROR_STATES.contains(state)) {
                    blocking.add(new OccurrenceView(row, state));
                    if (blocking.size() == limit) {
                        return blocking;
                    }
                }
            }
            if (page.size() < 256) {
                return blocking;
            }
            offset += page.size();
        }
        return blocking;
    }

    /** Whether a public Turn of the Session has not ended yet. */
    public boolean hasOpenTurn(String tenantId, String sessionId) {
        return !jdbc.queryForList("SELECT 1 FROM ma_turn"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND status IN ('ACCEPTED', 'RUNNING', 'CANCELLING')"
                        + " LIMIT 1", Integer.class, tenantId, sessionId)
                .isEmpty();
    }

    /** One occurrence with its run's task state, when one committed. */
    public Optional<OccurrenceView> findOccurrenceView(String tenantId,
            String scheduleId, String occurrenceKey) {
        return jdbc.query(OCCURRENCE_SELECT + " AND o.occurrence_key = ?",
                OCCURRENCE, tenantId, scheduleId, occurrenceKey).stream()
                .findFirst()
                .map(row -> new OccurrenceView(row,
                        readTaskStates(tenantId,
                                List.of(new RunIdentity(row.sessionId(),
                                        row.runId())))
                                .get(row.runId())));
    }

    public OccurrencePage listOccurrences(String tenantId, String scheduleId,
            OccurrenceCursor cursor, int limit) {
        List<OccurrenceRow> rows = cursor == null
                ? jdbc.query(OCCURRENCE_SELECT + " ORDER BY o.gmt_create DESC,"
                        + " o.occurrence_key DESC LIMIT ?", OCCURRENCE,
                        tenantId, scheduleId, limit + 1)
                : jdbc.query(OCCURRENCE_SELECT + " AND (o.gmt_create < ? OR"
                        + " (o.gmt_create = ? AND o.occurrence_key < ?))"
                        + " ORDER BY o.gmt_create DESC, o.occurrence_key DESC"
                        + " LIMIT ?", OCCURRENCE, tenantId, scheduleId,
                        cursor.createdAt(), cursor.createdAt(),
                        cursor.occurrenceKey(), limit + 1);
        Map<String, String> states = readTaskStates(tenantId, rows.stream()
                .map(row -> new RunIdentity(row.sessionId(), row.runId()))
                .toList());
        List<OccurrenceView> views = rows.stream()
                .map(row -> new OccurrenceView(row, states.get(row.runId())))
                .toList();
        boolean hasMore = views.size() > limit;
        return new OccurrencePage(hasMore ? views.subList(0, limit) : views,
                hasMore);
    }

    // --- public command replay ---

    public Optional<CommandRow> findCommand(String tenantId,
            String idempotencyKey) {
        return jdbc
                .query(
                        "SELECT " + ManagedSchemaProjection.REQUEST_RECEIPT.columns() + " FROM ma_request_receipt WHERE receipt_key = ? AND namespace = 'AUTOMATION' AND tenant_id = ? AND idempotency_key = ?",
                        (result, row) ->
                                new CommandRow(
                                        result.getString("tenant_id"),
                                        result.getString("idempotency_key"),
                                        result.getString("actor_id"),
                                        result.getString("request_digest"),
                                        result.getString("schedule_id"),
                                        result.getString("result_json")),
                        receiptKey(tenantId, idempotencyKey),
                        tenantId,
                        idempotencyKey)
                .stream()
                .findFirst();
    }

    public void recordCommand(CommandRow command, long now) {
        insertCommand(command, now, command.resultJson());
    }

    /**
     * Claims (tenant, key) for one request before any side effect: the primary key arbitrates, so
     * only one concurrent or retried caller owns the identity; the row's empty result marks it
     * unanswered. A claim whose requester dies mid-flight stays durable, which is what lets a
     * different request under the same key conflict instead of repeating the side effect.
     */
    public boolean claimCommand(String sessionId, CommandRow command, long now) {
        return Boolean.TRUE.equals(
                commands.execute(
                        status -> {
                            ManagedLegacySessionGuard.requireLegacyMutation(
                                    jdbc, command.tenantId(), sessionId);
                            return insertCommand(command, now, "") == 1;
                        }));
    }

    /**
     * Fills in the answer of a claim, guarded both ways: only the row's own request writes its
     * answer, and only while it stays unanswered — a late re-driven mutation can neither steal
     * another request's row nor overwrite a completed result.
     */
    public boolean settleCommand(String tenantId, String idempotencyKey,
            String requestDigest, String actorId, String resultJson) {
        return jdbc.update(
                        "UPDATE ma_request_receipt SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", result_json = ?, state = 'COMPLETED' WHERE"
                            + " receipt_key = ? AND namespace = 'AUTOMATION' AND tenant_id = ? AND"
                            + " idempotency_key = ? AND request_digest = ? AND actor_id = ? AND"
                            + " result_json = ''",
                        resultJson,
                        receiptKey(tenantId, idempotencyKey),
                        tenantId,
                        idempotencyKey,
                        requestDigest,
                        actorId)
                > 0;
    }

    /**
     * Releases a claim whose operation the Harness definitively refused: a 4xx answer commits
     * nothing, so the key goes back to its owner rather than burning it — guarded the same way, so
     * only the claim's own unanswered row is ever removed.
     */
    public boolean releaseCommand(String tenantId, String idempotencyKey,
            String requestDigest, String actorId) {
        return jdbc.update(
                        "DELETE FROM ma_request_receipt WHERE receipt_key = ? AND namespace ="
                                + " 'AUTOMATION' AND tenant_id = ? AND idempotency_key = ? AND"
                                + " request_digest = ? AND actor_id = ? AND result_json = ''",
                        receiptKey(tenantId, idempotencyKey),
                        tenantId,
                        idempotencyKey,
                        requestDigest,
                        actorId)
                > 0;
    }

    private static String receiptKey(String tenantId, String idempotencyKey) {
        return ManagedSchemaKeys.receiptKey(ReceiptNamespace.AUTOMATION, tenantId,
                ReceiptScope.TENANT, tenantId, idempotencyKey);
    }

    private int insertCommand(CommandRow command, long now, String result) {
        return jdbc.update(
                "INSERT IGNORE INTO ma_request_receipt (receipt_key, namespace, tenant_key, tenant_id, scope_kind, scope_key, scope_id, idempotency_key, idempotency_digest, actor_id, request_digest, schedule_id, state, result_json, gmt_create, gmt_modified) VALUES (?, 'AUTOMATION', ?, ?, 'TENANT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                receiptKey(command.tenantId(), command.idempotencyKey()),
                ManagedSchemaKeys.key(command.tenantId()),
                command.tenantId(),
                ManagedSchemaKeys.key("TENANT", command.tenantId()),
                command.tenantId(),
                command.idempotencyKey(),
                ManagedSchemaKeys.key(command.idempotencyKey()),
                command.actorId(),
                command.requestDigest(),
                command.scheduleId(),
                result.isEmpty() ? "PENDING" : "COMPLETED",
                result,
                now,
                now);
    }

    // --- Session store reads ---

    public String sessionStatus(String tenantId, String sessionId) {
        return jdbc.query("SELECT status FROM ma_session"
                        + " WHERE tenant_id = ? AND session_id = ?",
                (result, row) -> result.getString("status"), tenantId,
                sessionId).stream().findFirst().orElse(null);
    }
}
