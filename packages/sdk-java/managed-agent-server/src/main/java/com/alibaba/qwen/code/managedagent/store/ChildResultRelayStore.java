package com.alibaba.qwen.code.managedagent.store;

import java.util.List;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * H4b: the JDBC side of the child result relay — its V51 ledger plus the
 * small reads the worker needs (pending child-agent rows over the
 * delivery-pending index, launch bodies and envelopes from the Session
 * resource store, the child turn line, and the terminal result content).
 * The ledger's classifications (`orphaned`, `unknown`) are terminal: they
 * never represent consumption and never authorize re-execution, surviving
 * worker restarts by construction.
 */
@Repository
public class ChildResultRelayStore {
    /** One child run the delivery-pending index surfaced. */
    public record PendingChild(String tenantId, String parentSessionId,
            String childRunId, long revision, String deliveryState,
            String recordResourceId) {
    }

    /** One relay ledger row. */
    public record RelayRow(String tenantId, String parentSessionId,
            String childRunId, String creationKey, String childSessionId,
            String state, String claimedBy, long claimedUntil, int attempts,
            long nextRetryAt, String lastError, long createdAt,
            long updatedAt) {
    }

    /** The child Session's latest Turn line, as the relay reads it. */
    public record TurnLine(String turnId, String status, Long completedAt,
            String errorCode) {
    }

    // delivery_state is null on the shell kind, so a child_run row with a
    // pending delivery is always a child_agent row; the ledger join
    // drops every row whose classification is terminal (delivered,
    // orphaned or given up), because the bounded discovery set is for
    // work still owed — accumulated terminal rows would otherwise starve
    // the fleet-wide scan behind an ORDER BY created_at LIMIT. A row not
    // owed yet either a retry backoff or a live lease lying ahead must
    // not squat a slot either — this set is created_at-ordered and
    // bounded fleet-wide. A record whose delivery already advanced (the
    // consumer raced ahead) owes its watching/delivering ledger the
    // terminal-mark step, so that arm surfaces too — the final classify
    // retires it next scan.
    private static final String PENDING_SQL =
            "SELECT r.tenant_id, r.session_id, r.record_id, r.revision,"
                    + " r.delivery_state, r.record_resource_id"
                    + " FROM qwen_managed_session_extension_record r"
                    + " LEFT JOIN qwen_managed_child_result_relay l"
                    + " ON l.parent_session_id = r.session_id"
                    + " AND l.child_run_id = r.record_id"
                    + " WHERE r.domain = 'child_run'"
                    + " AND ((r.delivery_state IN ('planned', 'accepting',"
                    + " 'unknown') AND (l.state IS NULL OR l.state NOT IN"
                    + " ('done', 'orphaned', 'unknown'))"
                    + " AND (l.next_retry_at IS NULL OR l.next_retry_at <= ?)"
                    + " AND (l.claimed_until IS NULL OR l.claimed_until <="
                    + " ?))"
                    + " OR (r.delivery_state IN ('accepted', 'consumed')"
                    + " AND l.state IN ('watching', 'delivering')))"
                    + " ORDER BY r.created_at, r.session_id, r.record_id"
                    + " LIMIT ?";

    private final JdbcTemplate jdbc;

    public ChildResultRelayStore(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public List<PendingChild> findPendingChildren(int limit) {
        return findPendingChildren(System.currentTimeMillis(), limit);
    }

    /** The owed-work page: not terminal, not parked ahead, not leased
     * ahead, plus the delivering arm whose consumer raced past it. */
    public List<PendingChild> findPendingChildren(long now, int limit) {
        return jdbc.query(PENDING_SQL, (result, row) -> new PendingChild(
                result.getString("tenant_id"), result.getString("session_id"),
                result.getString("record_id"), result.getLong("revision"),
                result.getString("delivery_state"),
                result.getString("record_resource_id")), now, now, limit);
    }

    /** One inline resource's bytes, or null when it is not inline-held. */
    public String readResource(String tenantId, String resourceId) {
        List<byte[]> rows = jdbc.query(
                "SELECT inline_bytes FROM qwen_managed_session_resource"
                        + " WHERE tenant_id = ? AND resource_id = ?"
                        + " AND storage_kind = 'MYSQL_INLINE'"
                        + " AND state = 'REFERENCED'",
                (result, row) -> result.getBytes("inline_bytes"), tenantId,
                resourceId);
        return rows.isEmpty() ? null
                : new String(rows.getFirst(),
                        java.nio.charset.StandardCharsets.UTF_8);
    }

    /** One non-terminal child run a closing Session still owns. */
    public record LiveScope(String childRunId, String recordResourceId) {
    }

    /**
     * The non-terminal child-agent runs of one Session, for the close
     * cascade: task projections say what is still alive; the bodies name
     * the child Sessions (null when creation never attached).
     */
    public List<LiveScope> findLiveScopes(String tenantId,
            String parentSessionId) {
        return jdbc.query(
                "SELECT record_id, record_resource_id"
                        + " FROM qwen_managed_session_extension_record"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND domain = 'child_run' AND delivery_state IS NOT NULL"
                        + " AND task_state NOT IN ('completed', 'failed',"
                        + " 'cancelled')"
                        + " ORDER BY created_at, record_id",
                (result, row) -> new LiveScope(
                        result.getString("record_id"),
                        result.getString("record_resource_id")),
                tenantId, parentSessionId);
    }

    /** Whether a Session currently holds the acceptance of one child run. */
    public boolean hasAcceptance(String tenantId, String sessionId,
            String childRunId) {
        return !jdbc.query(
                "SELECT record_key FROM qwen_managed_session_extension_record"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND domain = 'child_acceptance'"
                        + " AND record_id = ?",
                (result, row) -> result.getString("record_key"), tenantId,
                sessionId, childRunId).isEmpty();
    }

    public String sessionStatus(String tenantId, String sessionId) {
        List<String> rows = jdbc.query(
                "SELECT status FROM managed_agent_session"
                        + " WHERE tenant_id = ? AND session_id = ?",
                (result, row) -> result.getString("status"), tenantId,
                sessionId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /** The child Session's newest Turn, or null while none exists. */
    public TurnLine latestTurn(String tenantId, String sessionId) {
        List<TurnLine> rows = jdbc.query(
                "SELECT turn_id, status, completed_at, error_code"
                        + " FROM managed_agent_turn"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " ORDER BY created_at DESC, turn_id DESC LIMIT 1",
                (result, row) -> new TurnLine(result.getString("turn_id"),
                        result.getString("status"),
                        (Long) result.getObject("completed_at"),
                        result.getString("error_code")),
                tenantId, sessionId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /** The terminal result content: the completed Turn's newest assistant
     * message's joined text, or null while none exists. */
    public String terminalResultText(String tenantId, String sessionId,
            String turnId) {
        List<String> items = jdbc.query(
                "SELECT i.item_id FROM managed_agent_item i"
                        + " WHERE i.tenant_id = ? AND i.session_id = ?"
                        + " AND i.turn_id = ? AND i.item_type = 'message'"
                        + " AND i.item_role = 'assistant'"
                        + " ORDER BY i.last_sequence DESC, i.item_id DESC"
                        + " LIMIT 1",
                (result, row) -> result.getString("item_id"), tenantId,
                sessionId, turnId);
        if (items.isEmpty()) {
            return null;
        }
        List<String> parts = jdbc.query(
                "SELECT part_text FROM managed_agent_item_part"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND item_id = ? AND part_type = 'output_text'"
                        + " ORDER BY last_sequence, part_id",
                (result, row) -> result.getString("part_text"), tenantId,
                sessionId, items.getFirst());
        return parts.isEmpty() ? null : String.join("\n", parts);
    }

    /** Insert-or-claim: returns the row this worker now owns, or null when
     * another live claim holds it. The creation key dedupes racing scans. */
    public RelayRow claim(String tenantId, String parentSessionId,
            String childRunId, String creationKey, String owner,
            long leaseUntil, long now) {
        RelayRow existing = find(tenantId, parentSessionId, childRunId);
        if (existing == null) {
            jdbc.update("INSERT IGNORE INTO qwen_managed_child_result_relay"
                            + " (tenant_id, parent_session_id, child_run_id,"
                            + " creation_key, child_session_id, state,"
                            + " claimed_by, claimed_until, attempts,"
                            + " next_retry_at, created_at, updated_at)"
                            + " VALUES (?, ?, ?, ?, NULL, 'creating', ?, ?,"
                            + " 0, ?, ?, ?)",
                    tenantId, parentSessionId, childRunId, creationKey, owner,
                    leaseUntil, now, now, now);
            existing = find(tenantId, parentSessionId, childRunId);
        }
        if (existing == null) {
            return null;
        }
        if (owner.equals(existing.claimedBy())
                || existing.claimedUntil() < now) {
            int claimed = jdbc.update(
                    "UPDATE qwen_managed_child_result_relay SET claimed_by = ?,"
                            + " claimed_until = ?, updated_at = ?"
                            + " WHERE tenant_id = ? AND parent_session_id = ?"
                            + " AND child_run_id = ? AND (claimed_by = ? OR"
                            + " claimed_until < ?)",
                    owner, leaseUntil, now, tenantId, parentSessionId,
                    childRunId, existing.claimedBy(), now);
            if (claimed == 1) {
                return find(tenantId, parentSessionId, childRunId);
            }
        }
        return null;
    }

    public RelayRow find(String tenantId, String parentSessionId,
            String childRunId) {
        List<RelayRow> rows = jdbc.query(
                "SELECT * FROM qwen_managed_child_result_relay"
                        + " WHERE tenant_id = ? AND parent_session_id = ?"
                        + " AND child_run_id = ?",
                (result, row) -> new RelayRow(result.getString("tenant_id"),
                        result.getString("parent_session_id"),
                        result.getString("child_run_id"),
                        result.getString("creation_key"),
                        result.getString("child_session_id"),
                        result.getString("state"),
                        result.getString("claimed_by"),
                        result.getLong("claimed_until"),
                        result.getInt("attempts"),
                        result.getLong("next_retry_at"),
                        result.getString("last_error"),
                        result.getLong("created_at"),
                        result.getLong("updated_at")),
                tenantId, parentSessionId, childRunId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /**
     * The child Session the committed lineage names for one run, whatever
     * any ledger row remembers: createChildSession stamps the child's own
     * row before the relay records its answer, so a window where both the
     * parent body and the ledger lack the id still identifies the child
     * here — the disproving evidence for `not_started_proven`.
     */
    public String findLineageChild(String tenantId, String parentSessionId,
            String childRunId) {
        List<String> rows = jdbc.query("SELECT session_id FROM"
                        + " managed_agent_session WHERE tenant_id = ?"
                        + " AND parent_session_id = ?"
                        + " AND parent_child_run_id = ?",
                (result, row) -> result.getString("session_id"), tenantId,
                parentSessionId, childRunId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /** One held claim advances: state, optional child Session, and the
     * retry/backoff line, all flagged to the claiming worker. */
    public void advance(RelayRow row, String owner, String state,
            String childSessionId, long nextRetryAt, String lastError,
            long leaseUntil, long now) {
        jdbc.update("UPDATE qwen_managed_child_result_relay SET state = ?,"
                        + " child_session_id = ?, attempts = ?,"
                        + " next_retry_at = ?, last_error = ?,"
                        + " claimed_by = ?, claimed_until = ?, updated_at = ?"
                        + " WHERE tenant_id = ? AND parent_session_id = ?"
                        + " AND child_run_id = ? AND claimed_by = ?",
                state, childSessionId, Math.max(row.attempts(), 0),
                nextRetryAt, lastError, owner, leaseUntil, now,
                row.tenantId(), row.parentSessionId(), row.childRunId(),
                owner);
    }

    /** A still-running child is not a failed step: no attempt, just the
     * next look. */
    public void scheduleRetry(RelayRow row, String owner, long nextRetryAt,
            long leaseUntil, long now) {
        jdbc.update("UPDATE qwen_managed_child_result_relay SET"
                        + " next_retry_at = ?, claimed_until = ?,"
                        + " updated_at = ? WHERE tenant_id = ?"
                        + " AND parent_session_id = ? AND child_run_id = ?"
                        + " AND claimed_by = ?",
                nextRetryAt, leaseUntil, now, row.tenantId(),
                row.parentSessionId(), row.childRunId(), owner);
    }

    /** A failed step counts an attempt and reschedules with backoff. */
    public void defer(RelayRow row, String owner, long nextRetryAt,
            String lastError, long leaseUntil, long now) {
        jdbc.update("UPDATE qwen_managed_child_result_relay SET attempts = ?,"
                        + " next_retry_at = ?, last_error = ?,"
                        + " claimed_by = ?, claimed_until = ?, updated_at = ?"
                        + " WHERE tenant_id = ? AND parent_session_id = ?"
                        + " AND child_run_id = ? AND claimed_by = ?",
                row.attempts() + 1, nextRetryAt,
                lastError == null ? null
                        : lastError.substring(0,
                                Math.min(lastError.length(), 1024)),
                owner, leaseUntil, now, row.tenantId(), row.parentSessionId(),
                row.childRunId(), owner);
    }

    /** A Classification is terminal: no claim, no retry, no redelivery —
     * and only the claimant may write it. */
    public void classify(RelayRow row, String owner, String state,
            String lastError, long now) {
        jdbc.update("UPDATE qwen_managed_child_result_relay SET state = ?,"
                        + " claimed_by = NULL, claimed_until = NULL,"
                        + " last_error = ?, updated_at = ?"
                        + " WHERE tenant_id = ? AND parent_session_id = ?"
                        + " AND child_run_id = ? AND claimed_by = ?",
                state,
                lastError == null ? null
                        : lastError.substring(0,
                                Math.min(lastError.length(), 1024)),
                now, row.tenantId(), row.parentSessionId(), row.childRunId(),
                owner);
    }
}
