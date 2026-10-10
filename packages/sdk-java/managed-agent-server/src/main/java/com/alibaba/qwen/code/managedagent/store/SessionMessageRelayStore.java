package com.alibaba.qwen.code.managedagent.store;

import java.util.List;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * H4d-b: the JDBC side of the session message relay — its V61 ledger plus
 * the reads its worker needs beyond the child result relay's: outbox
 * entries over the delivery-pending index, one record's committed delivery
 * state in either journal, and a child Session's recorded lineage. The
 * ledger's classifications (`orphaned`, `unknown`) are terminal: they never
 * represent delivery and never authorize a second one.
 */
@Repository
public class SessionMessageRelayStore {
    /** One outbox entry the delivery-pending index surfaced. */
    public record PendingMessage(String tenantId, String senderSessionId,
            String messageId, String deliveryState, String recordResourceId) {
    }

    /** One relay ledger row. */
    public record MessageRow(String tenantId, String senderSessionId,
            String messageId, String targetSessionId, String state,
            String claimedBy, long claimedUntil, int attempts,
            long nextRetryAt, String lastError) {
    }

    /** A child Session's recorded lineage edge. */
    public record Lineage(String parentSessionId, String parentChildRunId) {
    }

    // Outbound entries only: a receipt opens accepted and has no ledger row
    // (rows are keyed by the sender), so the accepted arm — the entries
    // waiting for their target to consume them — joins on a `delivered`
    // row, which only the relay's own handover can have written.
    private static final String PENDING_SQL =
            "SELECT r.tenant_id, r.session_id, r.record_id, r.delivery_state,"
                    + " r.record_resource_id"
                    + " FROM qwen_managed_session_extension_record r"
                    + " LEFT JOIN qwen_managed_session_message_relay l"
                    + " ON l.sender_session_id = r.session_id"
                    + " AND l.message_id = r.record_id"
                    + " WHERE r.domain = 'session_message'"
                    + " AND ((r.delivery_state IN ('planned', 'accepting',"
                    + " 'unknown') AND (l.state IS NULL OR l.state NOT IN"
                    + " ('done', 'orphaned', 'unknown')))"
                    + " OR (r.delivery_state = 'accepted'"
                    + " AND l.state = 'delivered'))"
                    + " AND (l.next_retry_at IS NULL OR l.next_retry_at <= ?)"
                    + " AND (l.claimed_until IS NULL OR l.claimed_until <= ?"
                    + " OR l.claimed_by = ?)"
                    + " ORDER BY r.created_at, r.session_id, r.record_id"
                    + " LIMIT ?";

    private final JdbcTemplate jdbc;

    public SessionMessageRelayStore(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** The owed-work page for one worker: due, not terminal, and never
     * leased to another worker. */
    public List<PendingMessage> findPendingMessages(String workerId, long now,
            int limit) {
        return jdbc.query(PENDING_SQL, (result, row) -> new PendingMessage(
                result.getString("tenant_id"), result.getString("session_id"),
                result.getString("record_id"),
                result.getString("delivery_state"),
                result.getString("record_resource_id")), now, now, workerId,
                limit);
    }

    /** One record's delivery state as committed now, in any journal. */
    public String deliveryState(String tenantId, String sessionId,
            String messageId) {
        List<String> rows = jdbc.query(
                "SELECT delivery_state FROM qwen_managed_session_extension_record"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND domain = 'session_message' AND record_id = ?",
                (result, row) -> result.getString("delivery_state"),
                tenantId, sessionId, messageId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /** The lineage a child Session was created with, or null for a root. */
    public Lineage lineage(String tenantId, String sessionId) {
        List<Lineage> rows = jdbc.query("SELECT parent_session_id,"
                        + " parent_child_run_id FROM managed_agent_session"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND parent_session_id IS NOT NULL",
                (result, row) -> new Lineage(
                        result.getString("parent_session_id"),
                        result.getString("parent_child_run_id")),
                tenantId, sessionId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /** Insert-or-claim: returns the row this worker now owns, or null when
     * another live claim holds it. */
    public MessageRow claim(String tenantId, String senderSessionId,
            String messageId, String owner, long leaseUntil, long now) {
        MessageRow existing = find(tenantId, senderSessionId, messageId);
        if (existing == null) {
            jdbc.update("INSERT IGNORE INTO qwen_managed_session_message_relay"
                            + " (tenant_id, sender_session_id, message_id,"
                            + " target_session_id, state, claimed_by,"
                            + " claimed_until, attempts, next_retry_at,"
                            + " created_at, updated_at)"
                            + " VALUES (?, ?, ?, NULL, 'relaying', ?, ?, 0,"
                            + " ?, ?, ?)",
                    tenantId, senderSessionId, messageId, owner, leaseUntil,
                    now, now, now);
            existing = find(tenantId, senderSessionId, messageId);
        }
        if (existing == null) {
            return null;
        }
        if (owner.equals(existing.claimedBy())
                || existing.claimedUntil() < now) {
            int claimed = jdbc.update(
                    "UPDATE qwen_managed_session_message_relay SET"
                            + " claimed_by = ?, claimed_until = ?,"
                            + " updated_at = ? WHERE tenant_id = ?"
                            + " AND sender_session_id = ? AND message_id = ?"
                            + " AND (claimed_by = ? OR claimed_until < ?)",
                    owner, leaseUntil, now, tenantId, senderSessionId,
                    messageId, existing.claimedBy(), now);
            if (claimed == 1) {
                return find(tenantId, senderSessionId, messageId);
            }
        }
        return null;
    }

    public MessageRow find(String tenantId, String senderSessionId,
            String messageId) {
        List<MessageRow> rows = jdbc.query(
                "SELECT * FROM qwen_managed_session_message_relay"
                        + " WHERE tenant_id = ? AND sender_session_id = ?"
                        + " AND message_id = ?",
                (result, row) -> new MessageRow(result.getString("tenant_id"),
                        result.getString("sender_session_id"),
                        result.getString("message_id"),
                        result.getString("target_session_id"),
                        result.getString("state"),
                        result.getString("claimed_by"),
                        result.getLong("claimed_until"),
                        result.getInt("attempts"),
                        result.getLong("next_retry_at"),
                        result.getString("last_error")),
                tenantId, senderSessionId, messageId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /** One held claim advances its state and target, with a fresh
     * attempt line. */
    public void advance(MessageRow row, String owner, String state,
            String targetSessionId, long nextRetryAt, long leaseUntil,
            long now) {
        jdbc.update("UPDATE qwen_managed_session_message_relay SET state = ?,"
                        + " target_session_id = ?, attempts = 0,"
                        + " next_retry_at = ?, last_error = NULL,"
                        + " claimed_until = ?, updated_at = ?"
                        + " WHERE tenant_id = ? AND sender_session_id = ?"
                        + " AND message_id = ? AND claimed_by = ?",
                state, targetSessionId, nextRetryAt, leaseUntil, now,
                row.tenantId(), row.senderSessionId(), row.messageId(), owner);
    }

    /** A wait, not a failure: no attempt, just the next look. */
    public void scheduleRetry(MessageRow row, String owner, long nextRetryAt,
            long leaseUntil, long now) {
        jdbc.update("UPDATE qwen_managed_session_message_relay SET"
                        + " next_retry_at = ?, claimed_until = ?,"
                        + " updated_at = ? WHERE tenant_id = ?"
                        + " AND sender_session_id = ? AND message_id = ?"
                        + " AND claimed_by = ?",
                nextRetryAt, leaseUntil, now, row.tenantId(),
                row.senderSessionId(), row.messageId(), owner);
    }

    /** A failed step counts an attempt and reschedules with backoff. */
    public void defer(MessageRow row, String owner, long nextRetryAt,
            String lastError, long leaseUntil, long now) {
        jdbc.update("UPDATE qwen_managed_session_message_relay SET"
                        + " attempts = ?, next_retry_at = ?, last_error = ?,"
                        + " claimed_until = ?, updated_at = ?"
                        + " WHERE tenant_id = ? AND sender_session_id = ?"
                        + " AND message_id = ? AND claimed_by = ?",
                row.attempts() + 1, nextRetryAt, truncate(lastError),
                leaseUntil, now, row.tenantId(), row.senderSessionId(),
                row.messageId(), owner);
    }

    /** A classification is terminal, and only the claimant may write it. */
    public void classify(MessageRow row, String owner, String state,
            String lastError, long now) {
        jdbc.update("UPDATE qwen_managed_session_message_relay SET state = ?,"
                        + " claimed_by = NULL, claimed_until = NULL,"
                        + " last_error = ?, updated_at = ?"
                        + " WHERE tenant_id = ? AND sender_session_id = ?"
                        + " AND message_id = ? AND claimed_by = ?",
                state, truncate(lastError), now, row.tenantId(),
                row.senderSessionId(), row.messageId(), owner);
    }

    private static String truncate(String text) {
        return text == null ? null
                : text.substring(0, Math.min(text.length(), 1024));
    }
}
