package com.alibaba.qwen.code.managedagent.store;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaProjection;
import org.apache.commons.lang3.StringUtils;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import java.util.List;

/**
 * H4d-b: the JDBC side of the session message relay — its V64 ledger plus
 * the reads its worker needs beyond the child result relay's: outbox
 * entries over the delivery-pending index, one record's committed delivery
 * state in either journal, and a child Session's recorded lineage. The
 * ledger's classifications (`orphaned`, `unknown`) are terminal: they never
 * represent delivery and never authorize a second one.
 */
@Repository
public class SessionMessageRelayStore {
    /** The failed steps after which the relay gives an entry up. */
    public static final int MAX_ATTEMPTS = 64;

    /** Over a ledger row `l` joined to its entry: the row still owes work —
     * none opened yet, or one neither classified nor past the attempt
     * bound. A sender that takes no further revision never lets the
     * give-up's own step land, so the bound is the only proof the entry
     * stops; the relay then owes it nothing but that give-up. The child
     * relay's hold on a child's own outbox and the send-order hold on a
     * younger message both end here. */
    public static final String LEDGER_OWES_WORK = "(l.delivery_id IS NULL"
            + " OR (l.transport_state NOT IN ('done', 'orphaned', 'unknown')"
            + " AND l.attempt_count < " + MAX_ATTEMPTS + "))";

    /** One outbox entry the delivery-pending index surfaced. H4e-b3 adds
     * the domain: command entries share every field and never collide
     * with message ids, which would duplicate across the ledger. */
    public record PendingMessage(String tenantId, String senderSessionId,
            String messageId, String domain, String deliveryState,
            String recordResourceId) {
    }

    /** One relay ledger row. */
    public record MessageRow(String tenantId, String senderSessionId,
            String messageId, String targetSessionId, String state,
            String claimedBy, long claimedUntil, int attempts,
            long nextRetryAt, String lastError, long claimGeneration) {
        public MessageRow(String tenantId, String senderSessionId, String messageId, String targetSessionId,
                String state, String claimedBy, long claimedUntil, int attempts, long nextRetryAt, String lastError) {
            this(tenantId, senderSessionId, messageId, targetSessionId, state, claimedBy, claimedUntil,
                    attempts, nextRetryAt, lastError, 0);
        }
    }

    /** A child Session's recorded lineage edge. */
    public record Lineage(String parentSessionId, String parentChildRunId) {
    }

    /** One outbox entry as committed now: its delivery and its body. */
    public record CurrentRecord(String deliveryState,
            String recordResourceId) {
    }

    /** The domains this ledger drives: H4d-b's channel and H4e-b3's. */
    private static final List<String> DOMAINS = List.of("session_message",
            "session_command");

    // The entries still owing a handover. Only outbox entries reach these
    // states (a receipt opens accepted; a command receipt opens consumed),
    // and a terminal ledger row means the relay already finished with the
    // entry. The query's domain binds one channel: session_message, or
    // H4e-b3's session_command, which discovery drives independently.
    private static final String HANDOVER_SQL =
            "SELECT r.tenant_id, r.session_id, r.record_id, r.domain, r.delivery_state,"
                    + " r.record_resource_id"
                    + " FROM ma_session_record r"
                    + " LEFT JOIN ma_delivery l"
                    + " ON l.delivery_kind = 'SESSION_MESSAGE' AND l.source_scope_key = r.session_scope_key"
                    + " AND l.tenant_id = r.tenant_id AND l.source_session_id = r.session_id"
                    + " AND l.delivery_id = r.record_id"
                    + " WHERE r.domain = ?"
                    + " AND r.delivery_state IN ('planned', 'accepting',"
                    + " 'unknown')"
                    + " AND (l.transport_state IS NULL OR l.transport_state NOT IN ('done',"
                    + " 'orphaned', 'unknown'))"
                    + " AND (l.available_at IS NULL OR l.available_at <= ?)"
                    + " AND (l.claim_until IS NULL OR l.claim_until <= ?"
                    + " OR l.claim_owner = ?)"
                    + " ORDER BY r.gmt_create, r.session_id, r.first_sequence,"
                    + " r.record_id LIMIT ?";

    // The entries handed over and waiting for their target to read them,
    // driven from the ledger's own (state, next_retry_at) index, so the
    // accepted entries that will never move again cost the scan nothing
    // and the waiting ones never crowd a new handover off the page. A row
    // still `relaying` over an accepted entry lost its advance after the
    // sender's step committed; it waits like a `delivered` one.
    private static final String AWAITING_SQL =
            "SELECT r.tenant_id, r.session_id, r.record_id, r.domain, r.delivery_state,"
                    + " r.record_resource_id"
                    + " FROM ma_delivery l"
                    + " JOIN ma_session_record r"
                    + " ON r.session_scope_key = l.source_scope_key AND r.tenant_id = l.tenant_id"
                    + " AND r.session_id = l.source_session_id"
                    + " AND r.domain = 'session_message'"
                    + " AND r.record_id = l.delivery_id"
                    + " WHERE l.delivery_kind = 'SESSION_MESSAGE' AND l.transport_state IN ('relaying', 'delivered')"
                    + " AND l.available_at <= ?"
                    + " AND (l.claim_until IS NULL OR l.claim_until <= ?"
                    + " OR l.claim_owner = ?)"
                    + " AND r.delivery_state = 'accepted'"
                    + " ORDER BY l.available_at, l.source_session_id,"
                    + " l.delivery_id LIMIT ?";

    private final JdbcTemplate jdbc;

    public SessionMessageRelayStore(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** The owed-work page for one worker: due, not terminal, and never
     * leased to another worker. Messages take their accepted reads from
     * the awaiting queue; commands never — their pass ends at answered. */
    public List<PendingMessage> findPendingMessages(String workerId, long now,
            int limit) {
        List<PendingMessage> page = new java.util.ArrayList<>(jdbc.query(
                HANDOVER_SQL, this::pending, "session_message", now, now,
                workerId, limit));
        page.addAll(jdbc.query(AWAITING_SQL, this::pending, now, now,
                workerId, limit));
        page.addAll(jdbc.query(HANDOVER_SQL, this::pending,
                "session_command", now, now, workerId, limit));
        return page;
    }

    private PendingMessage pending(java.sql.ResultSet result, int row)
            throws java.sql.SQLException {
        return new PendingMessage(result.getString("tenant_id"),
                result.getString("session_id"), result.getString("record_id"),
                result.getString("domain"),
                result.getString("delivery_state"),
                result.getString("record_resource_id"));
    }

    /** One outbox entry's delivery and body as committed now, for the
     * worker that claimed it: the page's own snapshot can be a revision
     * behind, and a body without the target it fixed reads wrong. */
    public CurrentRecord currentRecord(String tenantId, String sessionId,
            String domain, String messageId) {
        List<CurrentRecord> rows = jdbc.query(
                "SELECT delivery_state, record_resource_id FROM"
                        + " ma_session_record"
                        + " WHERE session_scope_key = ? AND tenant_id = ? AND session_id = ?"
                        + " AND domain = ? AND record_id = ?",
                (result, row) -> new CurrentRecord(
                        result.getString("delivery_state"),
                        result.getString("record_resource_id")),
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId), tenantId, sessionId, domain, messageId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /** One record's delivery state as committed now, in any journal. */
    public String deliveryState(String tenantId, String sessionId,
            String domain, String messageId) {
        List<String> rows = jdbc.query(
                "SELECT delivery_state FROM ma_session_record"
                        + " WHERE session_scope_key = ? AND tenant_id = ? AND session_id = ?"
                        + " AND domain = ? AND record_id = ?",
                (result, row) -> result.getString("delivery_state"),
                ManagedSessionStore.sessionScopeKey(tenantId, sessionId), tenantId, sessionId, domain, messageId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    /** The lineage a child Session was created with, or null for a root. */
    public Lineage lineage(String tenantId, String sessionId) {
        List<Lineage> rows = jdbc.query("SELECT parent_session_id,"
                        + " parent_child_run_id FROM ma_session"
                        + " WHERE tenant_id = ? AND session_id = ?"
                        + " AND parent_session_id IS NOT NULL",
                (result, row) -> new Lineage(
                        result.getString("parent_session_id"),
                        result.getString("parent_child_run_id")),
                tenantId, sessionId);
        return rows.isEmpty() ? null : rows.getFirst();
    }

    private static String deliveryKey(String tenant, String sender, String message) {
        return ManagedSchemaKeys.key("delivery", "SESSION_MESSAGE", ManagedSessionStore.sessionScopeKey(tenant, sender), message);
    }

    /** Whether an older command of the same sender is still unclassified:
     * one sender's commands pass strictly in order. Older is the sender's
     * own commit order — each outbound's first_sequence in its journal,
     * never its hashed id. The open window is the outbound's
     * planned/accepting span, on an unclassified row or before discovery
     * has opened one — a terminal record never blocks again, whatever row
     * state its last step left, and a terminal row never blocks again,
     * whatever the record says. */
    public boolean olderOpenCommand(String tenantId, String senderSessionId,
            String commandId) {
        return !jdbc.query("SELECT 1 FROM"
                        + " ma_session_record r"
                        + " JOIN ma_session_record c"
                        + " ON c.session_scope_key = r.session_scope_key AND c.tenant_id = r.tenant_id"
                        + " AND c.session_id = r.session_id"
                        + " AND c.domain = r.domain"
                        + " AND c.record_id = ?"
                        + " LEFT JOIN ma_delivery l"
                        + " ON l.delivery_kind = 'SESSION_MESSAGE' AND l.source_scope_key = r.session_scope_key AND l.tenant_id = r.tenant_id"
                        + " AND l.source_session_id = r.session_id"
                        + " AND l.delivery_id = r.record_id"
                        + " WHERE r.session_scope_key = ? AND r.tenant_id = ? AND r.session_id = ?"
                        + " AND r.domain = 'session_command'"
                        + " AND r.first_sequence < c.first_sequence"
                        + " AND r.delivery_state IN ('planned', 'accepting')"
                        + " AND (l.transport_state IS NULL"
                        + " OR l.transport_state NOT IN ('done', 'unknown', 'orphaned'))"
                        + " LIMIT 1",
                (result, row) -> result.getInt(1), commandId, ManagedSessionStore.sessionScopeKey(tenantId, senderSessionId), tenantId,
                senderSessionId).isEmpty();
    }

    /** The record resource ids of a sender's messages older than this one,
     * by its own commit order, that still owe their handover or receipt:
     * planned, accepting or unknown, on a ledger row still owing work
     * ({@link #LEDGER_OWES_WORK}). The relay keeps the ones to the same run
     * ahead of it. */
    public List<String> olderOwedMessages(String tenantId,
            String senderSessionId, String messageId) {
        return jdbc.query("SELECT r.record_resource_id FROM"
                        + " ma_session_record r"
                        + " JOIN ma_session_record c"
                        + " ON c.session_scope_key = r.session_scope_key AND c.tenant_id = r.tenant_id"
                        + " AND c.session_id = r.session_id"
                        + " AND c.domain = r.domain"
                        + " AND c.record_id = ?"
                        + " LEFT JOIN ma_delivery l"
                        + " ON l.delivery_kind = 'SESSION_MESSAGE' AND l.source_scope_key = r.session_scope_key AND l.tenant_id = r.tenant_id"
                        + " AND l.source_session_id = r.session_id"
                        + " AND l.delivery_id = r.record_id"
                        + " WHERE r.session_scope_key = ? AND r.tenant_id = ? AND r.session_id = ?"
                        + " AND r.domain = 'session_message'"
                        + " AND r.first_sequence < c.first_sequence"
                        + " AND r.delivery_state IN ('planned', 'accepting', 'unknown')"
                        + " AND " + LEDGER_OWES_WORK,
                (result, row) -> result.getString("record_resource_id"), messageId,
                ManagedSessionStore.sessionScopeKey(tenantId, senderSessionId), tenantId, senderSessionId);
    }

    /** Insert-or-claim: returns the row this worker now owns, or null when
     * another live claim holds it. */
    public MessageRow claim(String tenantId, String senderSessionId,
            String messageId, String owner, long leaseUntil, long now) {
        String scope = ManagedSessionStore.sessionScopeKey(tenantId, senderSessionId);
        String key = deliveryKey(tenantId, senderSessionId, messageId);
        jdbc.update("INSERT IGNORE INTO ma_delivery (delivery_key, delivery_kind, tenant_id, source_scope_key,"
                        + " source_session_id, delivery_id, payload_json, transport_state, reception_state,"
                        + " consumption_state, claim_owner, claim_until, available_at, gmt_create, gmt_modified)"
                        + " VALUES (?, 'SESSION_MESSAGE', ?, ?, ?, ?, '{\"version\":1}', 'relaying', 'pending',"
                        + " 'pending', ?, ?, ?, ?, ?)",
                key, tenantId, scope, senderSessionId, messageId, owner, leaseUntil, now, now, now);
        int claimed = jdbc.update("UPDATE ma_delivery SET claim_owner = ?, claim_until = ?,"
                        + " claim_generation = claim_generation + 1, gmt_modified = ? WHERE delivery_key = ?"
                        + " AND delivery_kind = 'SESSION_MESSAGE' AND (claim_owner = ? OR claim_until < ?)",
                owner, leaseUntil, now, key, owner, now);
        return claimed == 1 ? find(tenantId, senderSessionId, messageId) : null;
    }

    public MessageRow find(String tenantId, String senderSessionId, String messageId) {
        return jdbc.query("SELECT " + ManagedSchemaProjection.DELIVERY.columns() + " FROM ma_delivery WHERE delivery_key = ?"
                        + " AND delivery_kind = 'SESSION_MESSAGE' AND tenant_id = ? AND source_session_id = ?"
                        + " AND delivery_id = ?",
                (result, index) -> new MessageRow(result.getString("tenant_id"), result.getString("source_session_id"),
                        result.getString("delivery_id"), result.getString("target_session_id"),
                        result.getString("transport_state"), result.getString("claim_owner"),
                        result.getLong("claim_until"), result.getInt("attempt_count"), result.getLong("available_at"),
                        result.getString("last_error"), result.getLong("claim_generation")),
                deliveryKey(tenantId, senderSessionId, messageId), tenantId, senderSessionId, messageId)
                .stream().findFirst().orElse(null);
    }

    public void advance(MessageRow row, String owner, String state, String targetSessionId,
            long nextRetryAt, long leaseUntil, long now) {
        if (!List.of("relaying", "delivered").contains(state)) {
            throw new IllegalArgumentException("Unknown message delivery state " + state);
        }
        jdbc.update("UPDATE ma_delivery SET transport_state = ?, target_session_id = ?, attempt_count = ?,"
                        + " reception_state = CASE WHEN ? = 'delivered' THEN 'accepted' ELSE reception_state END,"
                        + " available_at = ?, claim_until = ?, gmt_modified = ? WHERE delivery_key = ?"
                        + " AND delivery_kind = 'SESSION_MESSAGE' AND claim_owner = ? AND claim_generation = ?"
                        + " AND claim_until > ?",
                state, targetSessionId, Math.max(row.attempts(), 0), state, nextRetryAt, leaseUntil, now,
                deliveryKey(row.tenantId(), row.senderSessionId(), row.messageId()), owner, row.claimGeneration(), now);
    }

    public void scheduleRetry(MessageRow row, String owner, long nextRetryAt, long leaseUntil, long now) {
        jdbc.update("UPDATE ma_delivery SET available_at = ?, claim_until = ?, gmt_modified = ?"
                        + " WHERE delivery_key = ? AND delivery_kind = 'SESSION_MESSAGE' AND claim_owner = ?"
                        + " AND claim_generation = ? AND claim_until > ?",
                nextRetryAt, leaseUntil, now, deliveryKey(row.tenantId(), row.senderSessionId(), row.messageId()),
                owner, row.claimGeneration(), now);
    }

    public void defer(MessageRow row, String owner, long nextRetryAt, String lastError, long leaseUntil, long now) {
        jdbc.update("UPDATE ma_delivery SET attempt_count = ?, available_at = ?, last_error = ?,"
                        + " claim_until = ?, gmt_modified = ? WHERE delivery_key = ? AND delivery_kind = 'SESSION_MESSAGE'"
                        + " AND claim_owner = ? AND claim_generation = ? AND claim_until > ?",
                row.attempts() + 1, nextRetryAt, StringUtils.truncate(lastError, 1024), leaseUntil, now,
                deliveryKey(row.tenantId(), row.senderSessionId(), row.messageId()), owner, row.claimGeneration(), now);
    }

    public void classify(MessageRow row, String owner, String state, String lastError, long now) {
        if (!List.of("done", "orphaned", "unknown").contains(state)) {
            throw new IllegalArgumentException("Unknown message delivery classification " + state);
        }
        jdbc.update("UPDATE ma_delivery SET transport_state = ?, claim_owner = NULL, claim_until = NULL,"
                        + " consumption_state = CASE WHEN ? = 'done' THEN 'consumed' ELSE consumption_state END,"
                        + " last_error = ?, gmt_modified = ? WHERE delivery_key = ? AND delivery_kind = 'SESSION_MESSAGE'"
                        + " AND claim_owner = ? AND claim_generation = ? AND claim_until > ?",
                state, state, StringUtils.truncate(lastError, 1024), now, deliveryKey(row.tenantId(), row.senderSessionId(), row.messageId()),
                owner, row.claimGeneration(), now);
    }
}
