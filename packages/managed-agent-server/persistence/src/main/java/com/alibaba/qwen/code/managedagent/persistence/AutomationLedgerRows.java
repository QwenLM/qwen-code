package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.repository.AutomationLedgerStore.OccurrenceRow;
import com.alibaba.qwen.code.managedagent.repository.AutomationLedgerStore.ScheduleRow;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import org.springframework.jdbc.core.RowMapper;

/** SQL fragments and row mappers for the automation ledger reads. */
final class AutomationLedgerRows {
    private AutomationLedgerRows() { }

    /** The holder's proof: the definition row under this owner and fence. */
    static final String HELD = " AND EXISTS (SELECT 1 FROM"
            + " ma_schedule s WHERE s.tenant_id = ?"
            + " AND s.schedule_id = ? AND s.lease_owner = ? AND s.fence = ?)";

    static final RowMapper<ScheduleRow> SCHEDULE = (result, row) ->
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
                    result.getObject("catch_up_limit", Long.class),
                    result.getBoolean("is_enabled"), result.getString("state"),
                    result.getString("blocked_reason"),
                    result.getLong("armed_at"),
                    result.getObject("watermark_slot", Long.class),
                    result.getString("lease_owner"),
                    result.getObject("lease_until", Long.class),
                    result.getLong("fence"), result.getLong("gmt_create"),
                    result.getLong("gmt_modified"), result.getString("gate"),
                    result.getString("gate_last_outcome"),
                    result.getObject("gate_last_at", Long.class),
                    result.getInt("gate_quiet_since_delivery"),
                    result.getInt("gate_failures"),
                    result.getString("gate_last_error"));

    static final RowMapper<OccurrenceRow> OCCURRENCE = (result, row) ->
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

    static final String OCCURRENCE_SELECT = "SELECT " + ManagedSchemaProjection.SCHEDULE_OCCURRENCE.columns("o") + " FROM"
            + " ma_schedule_occurrence o"
            + " WHERE o.tenant_id = ? AND o.schedule_id = ?";
}
