package com.alibaba.qwen.code.managedagent.store;

import java.sql.Timestamp;
import java.time.Clock;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.OptionalLong;
import java.util.Set;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;

/**
 * The SQL side of the EventTransport consumers (design
 * 2026-10-04-managed-agent-event-transport, phase MQ2c). Every decision a
 * consumer takes is read here from SQL truth, never from the broker: an MQ
 * offset or a delivered envelope is never evidence of anything.
 *
 * <p>The wake watermark is a consumer-progress row (consumer
 * {@value #WAKE_CONSUMER}) whose covered sequence is the highest journal
 * sequence a wake activation was attempted for. It only dedups — a
 * redelivered or reordered wake at or below it is a no-op — and is never
 * recovery evidence: a wake whose attempt failed after the claim is
 * recovered by the SQL-side scans and the activated Session's own wake pump,
 * exactly as a missed notice is.
 */
public class TransportConsumerStore {
    public static final String WAKE_CONSUMER = "journal_wake";
    private static final int HELD_CHUNK = 200;

    private final JdbcTemplate jdbc;
    private final Clock clock;

    public TransportConsumerStore(JdbcTemplate jdbc, Clock clock) {
        this.jdbc = jdbc;
        this.clock = clock;
    }

    /**
     * What the activation fence reads for one Session: its public status,
     * its journal head (workspace, state, committed sequence) and whether a
     * writer holds the journal under a lease that has not expired by
     * database time. Empty when the Session or its journal does not exist.
     */
    public record WakeFence(String sessionStatus, String workspaceId,
            String headState, long committedSequence, boolean liveWriter) {
    }

    public Optional<WakeFence> wakeFence(String tenantId, String sessionId) {
        record Row(String status, String workspaceId, String state,
                long committedSequence, Timestamp leaseUntil) {
        }
        List<Row> rows = jdbc.query("SELECT s.status, h.workspace_id,"
                        + " h.state, h.committed_sequence,"
                        + " h.writer_lease_until FROM managed_agent_session s"
                        + " JOIN qwen_managed_session_journal_head h ON"
                        + " h.tenant_id = s.tenant_id AND h.session_id ="
                        + " s.session_id WHERE s.tenant_id = ? AND"
                        + " s.session_id = ?",
                (result, index) -> new Row(result.getString("status"),
                        result.getString("workspace_id"),
                        result.getString("state"),
                        result.getLong("committed_sequence"),
                        result.getTimestamp("writer_lease_until")),
                tenantId, sessionId);
        if (rows.isEmpty()) {
            return Optional.empty();
        }
        Row row = rows.getFirst();
        // Live exactly as hasLiveWriter decides it: an ACTIVE journal under a
        // lease unexpired by database time. Sealing keeps the lease column, and
        // a SEALED journal is re-acquirable at once, so it holds no writer.
        boolean live = "ACTIVE".equals(row.state())
                && row.leaseUntil() != null
                && row.leaseUntil().after(databaseNow());
        return Optional.of(new WakeFence(row.status(), row.workspaceId(),
                row.state(), row.committedSequence(), live));
    }

    /**
     * Those of a tenant's {@code sessionIds} whose journal {@code writerId}
     * holds: ACTIVE under a lease unexpired by database time.
     */
    public Set<String> heldBy(String writerId, String tenantId,
            List<String> sessionIds) {
        Timestamp now = databaseNow();
        Set<String> held = new HashSet<>();
        for (int from = 0; from < sessionIds.size(); from += HELD_CHUNK) {
            List<String> chunk = sessionIds.subList(from,
                    Math.min(sessionIds.size(), from + HELD_CHUNK));
            List<Object> args = new ArrayList<>();
            args.add(tenantId);
            args.add(writerId);
            args.addAll(chunk);
            jdbc.query("SELECT session_id, writer_lease_until FROM"
                            + " qwen_managed_session_journal_head WHERE"
                            + " tenant_id = ? AND state = 'ACTIVE' AND"
                            + " writer_id = ? AND session_id IN ("
                            + String.join(", ",
                                    Collections.nCopies(chunk.size(), "?"))
                            + ")",
                    (RowCallbackHandler) result -> {
                        Timestamp lease = result.getTimestamp(
                                "writer_lease_until");
                        if (lease != null && lease.after(now)) {
                            held.add(result.getString("session_id"));
                        }
                    }, args.toArray());
        }
        return held;
    }

    /**
     * Claims the wake at {@code sequence}: true exactly once per Session and
     * sequence above the watermark, so a redelivered, duplicated or older
     * wake is refused even when two nodes race on it.
     */
    public boolean claimWake(String tenantId, String sessionId,
            long sequence) {
        if (advanceWake(tenantId, sessionId, sequence)) {
            return true;
        }
        try {
            jdbc.update("INSERT INTO managed_agent_consumer_progress"
                            + " (tenant_id, session_id, consumer_name,"
                            + " covered_sequence, updated_at) VALUES"
                            + " (?, ?, ?, ?, ?)",
                    tenantId, sessionId, WAKE_CONSUMER, sequence,
                    clock.millis());
            return true;
        } catch (DuplicateKeyException exists) {
            // The row exists at or above the sequence, or a racing claim
            // inserted it first: only a strict advance wins.
            return advanceWake(tenantId, sessionId, sequence);
        }
    }

    private boolean advanceWake(String tenantId, String sessionId,
            long sequence) {
        return jdbc.update("UPDATE managed_agent_consumer_progress SET"
                        + " covered_sequence = ?, updated_at = ? WHERE"
                        + " tenant_id = ? AND session_id = ? AND"
                        + " consumer_name = ? AND covered_sequence < ?",
                sequence, clock.millis(), tenantId, sessionId, WAKE_CONSUMER,
                sequence) == 1;
    }

    /**
     * The public event sequence the message projection covers, or empty
     * when the Session has no projection progress.
     */
    public OptionalLong materializedThrough(String tenantId,
            String sessionId) {
        List<Long> covered = jdbc.query("SELECT covered_sequence FROM"
                        + " managed_agent_consumer_progress WHERE"
                        + " tenant_id = ? AND session_id = ? AND"
                        + " consumer_name = ?",
                (result, index) -> result.getLong(1), tenantId, sessionId,
                ManagedAgentStore.MESSAGE_PROJECTION);
        return covered.isEmpty() ? OptionalLong.empty()
                : OptionalLong.of(covered.getFirst());
    }

    /**
     * The workspace a Session's envelopes name: its binding, or for an
     * unbound Session the workspace its journal records carry (the session
     * store's configured workspace), so the Session's two streams name the
     * same workspace. Empty while it has neither — a journal may be created
     * after the Session's first public events. Both sources are written once
     * and never updated, so a caller may cache a found value.
     */
    public Optional<String> workspaceOf(String tenantId, String sessionId) {
        List<Optional<String>> workspace = jdbc.query("SELECT"
                        + " COALESCE(s.workspace_id, h.workspace_id) FROM"
                        + " managed_agent_session s LEFT JOIN"
                        + " qwen_managed_session_journal_head h ON"
                        + " h.tenant_id = s.tenant_id AND h.session_id ="
                        + " s.session_id WHERE s.tenant_id = ? AND"
                        + " s.session_id = ?",
                (result, index) -> Optional.ofNullable(result.getString(1)),
                tenantId, sessionId);
        return workspace.isEmpty() ? Optional.empty() : workspace.getFirst();
    }

    private Timestamp databaseNow() {
        Timestamp now = jdbc.queryForObject("SELECT CURRENT_TIMESTAMP(6)",
                Timestamp.class);
        if (now == null) {
            throw new IllegalStateException("Database time is unavailable");
        }
        return now;
    }
}
