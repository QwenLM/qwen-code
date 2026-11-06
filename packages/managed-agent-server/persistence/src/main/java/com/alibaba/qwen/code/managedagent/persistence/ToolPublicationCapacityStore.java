package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.managedagent.exception.ManagedAgentException;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaRows;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;

import java.util.Map;

/** Checks publication capacity inside the caller's Session-root transaction. */
final class ToolPublicationCapacityStore {
    private static final Logger LOG = LoggerFactory.getLogger(ToolPublicationStore.class);
    private final JdbcTemplate jdbc;
    private final ToolPublicationStore.Capacity capacity;

    ToolPublicationCapacityStore(JdbcTemplate jdbc, ToolPublicationStore.Capacity capacity) {
        this.jdbc = jdbc;
        this.capacity = capacity;
    }

    void requireCapacity(String tenantKey, String scope, long allocation, long now) {
        ManagedSessionStore.lockBounded(() -> jdbc.update("UPDATE ma_output_capture SET gmt_modified = " + ManagedSchemaTime.SQL_NOW + ", state = 'FENCED', expires_at = NULL,"
                + " capture_held_bytes = capture_used_bytes, producer_held_bytes ="
                + " producer_used_bytes, admission_held_bytes = CASE WHEN producer_phase IN"
                + " ('FINISHED', 'REFERENCED') THEN admission_held_bytes ELSE"
                + " admission_used_bytes END WHERE tenant_key = ? AND state = 'OPEN' AND"
                + " expires_at <= ?", ToolPublicationRetentionStore.boundedParameters(jdbc,
                        ManagedSessionStore.GUARD_ACQUIRE_TIMEOUT_SECONDS, tenantKey, now)));
        var totals = jdbc.query(
                "SELECT COALESCE(SUM(capture_held_bytes + producer_held_bytes +"
                + " admission_held_bytes), 0) AS reserved,"
                + " COALESCE(SUM(CASE WHEN state = 'OPEN' AND"
                + " producer_phase IN ('OPEN', 'FINISHING') THEN 1 ELSE 0"
                + " END), 0) AS captures FROM ma_output_capture WHERE"
                + " tenant_key = ? AND state <> 'NOT_STARTED'",
                (schemaRow, schemaIndex) -> ManagedSchemaRows.read(schemaRow), tenantKey).getFirst();
        long reserved = ((Number) totals.get("reserved")).longValue();
        long count = ((Number) totals.get("captures")).longValue();
        Long sessionReserved = jdbc.queryForObject("SELECT COALESCE(SUM(capture_held_bytes + producer_held_bytes"
                + " + admission_held_bytes), 0) FROM ma_output_capture"
                + " WHERE scope_key = ? AND state <> 'NOT_STARTED'", Long.class, scope);
        // A full tenant or Session is not a malformed request: it answers
        // its own code and names the limit that refused. Captures hold
        // more than they use until they finish, are fenced, expire or are
        // referenced; only used bytes wait for their Session to retire
        // and its output to be collected. A byte limit that used bytes
        // alone fill cannot clear while the batch waits, so it is a 409
        // whichever limit failed first; any other refusal is a 429.
        boolean tenantFull = reserved > capacity.tenantBytes() - allocation;
        boolean sessionFull = sessionReserved > capacity.sessionBytes() - allocation;
        if (tenantFull || sessionFull) {
            long tenantUsed = usedBytes("tenant_key", tenantKey);
            long sessionUsed = usedBytes("scope_key", scope);
            long admits = admits(scope, allocation);
            if (tenantUsed > capacity.tenantBytes() - allocation) {
                throw reservationRefused("tenant_bytes", true, tenantKey, scope, reserved, tenantUsed,
                        allocation, capacity.tenantBytes(), admits);
            }
            if (sessionUsed > capacity.sessionBytes() - allocation) {
                throw reservationRefused("session_bytes", true, tenantKey, scope, sessionReserved,
                        sessionUsed, allocation, capacity.sessionBytes(), admits);
            }
            throw tenantFull
                    ? reservationRefused("tenant_bytes", false, tenantKey, scope, reserved, tenantUsed,
                            allocation, capacity.tenantBytes(), admits)
                    : reservationRefused("session_bytes", false, tenantKey, scope, sessionReserved,
                            sessionUsed, allocation, capacity.sessionBytes(), admits);
        }
        if (count >= capacity.activeCaptures()) {
            throw reservationRefused("active_captures", false, tenantKey, scope, count, 0, 1,
                    capacity.activeCaptures(), admits(scope, allocation));
        }
    }

    // The Harness logs only the message, so it names the limit too. The
    // details also say how many reservations of this size the Session could
    // ever hold at once, so the Harness can tell a batch that never fits
    // (#14518).
    private static ManagedAgentException reservationRefused(String limit, boolean retained, String tenantKey,
            String scope, long held, long used, long requested, long allowed, long admits) {
        LOG.warn("Tool publication reservation refused limit={} retained={} tenant={} scope={} held={}"
                + " used={} requested={} allowed={} admits={}", limit, retained, tenantKey, scope, held, used,
                requested, allowed, admits);
        String message = "Tool publication reservation refused at the " + limit + " limit";
        Map<String, Object> details = Map.of("limit", limit, "admits", admits);
        return retained
                ? new ManagedAgentException(409,
                        "managed_tool_publication_retention_exhausted", message, details)
                : new ManagedAgentException(429,
                        "managed_tool_publication_capacity_exhausted", message, details);
    }

    // How many reservations of this size the Session could hold at once
    // under every limit. Its used bytes stay charged until its output is
    // collected after it retires, so they come off both byte limits. A
    // pending finish can still give its terminal back, an open capture
    // gives back what it holds beyond its used bytes, and other Sessions
    // retire, so none of those comes off.
    private long admits(String scope, long allocation) {
        long retained = jdbc.queryForObject("SELECT COALESCE(SUM(capture_used_bytes + producer_used_bytes"
                + " + admission_used_bytes), 0) FROM ma_output_capture WHERE scope_key = ?"
                + " AND state <> 'NOT_STARTED' AND producer_phase <> 'FINISHING'", Long.class, scope);
        long bytes = Math.min(capacity.tenantBytes(), capacity.sessionBytes()) - retained;
        return Math.min(capacity.activeCaptures(), Math.max(0, bytes) / allocation);
    }

    private long usedBytes(String column, String key) {
        return jdbc.queryForObject("SELECT COALESCE(SUM(capture_used_bytes + producer_used_bytes"
                + " + admission_used_bytes), 0) FROM ma_output_capture WHERE " + column + " = ?"
                + " AND state <> 'NOT_STARTED'", Long.class, key);
    }
}
