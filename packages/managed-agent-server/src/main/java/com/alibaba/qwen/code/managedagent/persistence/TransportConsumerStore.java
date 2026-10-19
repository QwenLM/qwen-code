package com.alibaba.qwen.code.managedagent.persistence;

import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaKeys;
import com.alibaba.qwen.code.runtimebroker.managedschema.ManagedSchemaTime;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowCallbackHandler;

import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Optional;
import java.util.OptionalLong;
import java.util.Set;

/**
 * The SQL side of the EventTransport consumers (design 2026-10-04-managed-agent-event-transport,
 * phase MQ2c). Every decision a consumer takes is read here from SQL truth, never from the broker:
 * an MQ offset or a delivered envelope is never evidence of anything.
 *
 * <p>The wake watermark is the SESSION stream's independent
 * wake_covered_sequence, the highest journal
 * sequence a wake activation was attempted for. It only dedups — a
 * redelivered or reordered wake at or below it is a no-op — and is never
 * recovery evidence: the independent SQL wake recovery scan finds committed
 * unconsumed inputs after writer loss even when a notice was already claimed.
 */
public class TransportConsumerStore {
    private static final int HELD_CHUNK = 200;

    private final JdbcTemplate jdbc;

    public TransportConsumerStore(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * What the activation fence reads for one Session: its public status, its journal head
     * (workspace, state, committed sequence) and whether a writer holds the journal under a lease
     * that has not expired by database time. Empty when the Session or its journal does not exist.
     */
    public record WakeFence(String sessionStatus, String workspaceId,
            String headState, long committedSequence, boolean liveWriter) {
    }

    public Optional<WakeFence> wakeFence(String tenantId, String sessionId) {
        record Row(String status, String workspaceId, String state,
                long committedSequence, Timestamp leaseUntil) {
        }
        List<Row> rows = jdbc.query(
                        "SELECT s.status, h.workspace_id, h.state, h.committed_sequence,"
                            + " h.writer_lease_until FROM ma_session s JOIN ma_session_head h ON"
                            + " h.tenant_key = ? AND h.harness_key = ? AND h.tenant_id ="
                            + " s.tenant_id AND h.session_id = s.session_id AND h.head_kind ="
                            + " 'MANAGED_SESSION' WHERE s.tenant_id = ? AND s.session_id = ? AND"
                            + " s.session_kind = 'PUBLIC' AND s.retired_at IS NULL",
                (result, index) -> new Row(result.getString("status"),
                        result.getString("workspace_id"),
                        result.getString("state"),
                        result.getLong("committed_sequence"),
                        ManagedSchemaTime.timestamp(result, "writer_lease_until")),
                ManagedSchemaKeys.key(tenantId), ManagedSchemaKeys.key(sessionId), tenantId, sessionId);
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
     * Those of a tenant's {@code sessionIds} whose journal {@code writerId} holds: ACTIVE under a
     * lease unexpired by database time.
     */
    public Set<String> heldBy(String writerId, String tenantId,
            List<String> sessionIds) {
        Timestamp now = databaseNow();
        Set<String> held = new HashSet<>();
        for (int from = 0; from < sessionIds.size(); from += HELD_CHUNK) {
            List<String> chunk = sessionIds.subList(from,
                    Math.min(sessionIds.size(), from + HELD_CHUNK));
            List<Object> args = new ArrayList<>();
            args.add(ManagedSchemaKeys.key(tenantId));
            args.add(tenantId);
            args.add(writerId);
            chunk.stream().map(ManagedSchemaKeys::key).forEach(args::add);
            args.addAll(chunk);
            jdbc.query(
                    "SELECT session_id, writer_lease_until FROM ma_session_head WHERE tenant_key ="
                            + " ? AND tenant_id = ? AND head_kind = 'MANAGED_SESSION' AND state ="
                            + " 'ACTIVE' AND writer_id = ? AND harness_key IN ("
                            + String.join(", ", Collections.nCopies(chunk.size(), "?"))
                            + ") AND session_id IN ("
                            + String.join(", ",
                                    Collections.nCopies(chunk.size(), "?"))
                            + ")",
                    (RowCallbackHandler) result -> {
                        Timestamp lease = ManagedSchemaTime.timestamp(result, "writer_lease_until");
                        if (lease != null && lease.after(now)) {
                            held.add(result.getString("session_id"));
                        }
                    }, args.toArray());
        }
        return held;
    }

    /**
     * Claims the wake at {@code sequence}: true exactly once per Session and sequence above the
     * watermark, so a redelivered, duplicated or older wake is refused even when two nodes race on
     * it.
     */
    public boolean claimWake(String tenantId, String sessionId,
            long sequence) {
        ManagedLegacySessionGuard.requireLegacyMutation(jdbc, tenantId, sessionId);
        return jdbc.update(
                        "UPDATE ma_event_stream SET wake_covered_sequence = ? WHERE tenant_id = ?"
                            + " AND session_id = ? AND stream_kind = 'SESSION' AND stream_id = X''"
                            + " AND (wake_covered_sequence IS NULL OR wake_covered_sequence < ?)",
                sequence, tenantId, sessionId, sequence) == 1;
    }

    /**
     * The public event sequence the message projection covers, or empty when the Session has no
     * projection progress.
     */
    public OptionalLong materializedThrough(String tenantId,
            String sessionId) {
        List<Long> covered = jdbc.query(
                        "SELECT e.covered_sequence FROM ma_event_stream e JOIN ma_session s ON"
                            + " s.tenant_id = e.tenant_id AND s.session_id = e.session_id WHERE"
                            + " e.tenant_id = ? AND e.session_id = ? AND e.stream_kind = 'SESSION'"
                            + " AND e.stream_id = X'' AND s.session_kind = 'PUBLIC' AND"
                            + " s.retired_at IS NULL",
                (result, index) -> result.getLong(1), tenantId, sessionId);
        return covered.isEmpty() ? OptionalLong.empty()
                : OptionalLong.of(covered.getFirst());
    }

    /**
     * The workspace a Session's envelopes name: its binding, or for an unbound Session the
     * workspace its journal records carry (the session store's configured workspace), so the
     * Session's two streams name the same workspace. Empty while it has neither — a journal may be
     * created after the Session's first public events. Both sources are written once and never
     * updated, so a caller may cache a found value.
     */
    public Optional<String> workspaceOf(String tenantId, String sessionId) {
        List<Optional<String>> workspace = jdbc.query(
                        "SELECT COALESCE(s.workspace_id, h.workspace_id) FROM ma_session s LEFT"
                            + " JOIN ma_session_head h ON h.tenant_key = ? AND h.harness_key = ?"
                            + " AND h.tenant_id = s.tenant_id AND h.session_id = s.session_id AND"
                            + " h.head_kind = 'MANAGED_SESSION' WHERE s.tenant_id = ? AND"
                            + " s.session_id = ? AND s.session_kind = 'PUBLIC' AND s.retired_at IS"
                            + " NULL",
                (result, index) -> Optional.ofNullable(result.getString(1)),
                ManagedSchemaKeys.key(tenantId), ManagedSchemaKeys.key(sessionId), tenantId, sessionId);
        return workspace.isEmpty() ? Optional.empty() : workspace.getFirst();
    }

    private Timestamp databaseNow() {
        Timestamp now = jdbc.queryForObject("SELECT " + ManagedSchemaTime.SQL_NOW + "",
                Timestamp.class);
        if (now == null) {
            throw new IllegalStateException("Database time is unavailable");
        }
        return now;
    }
}
